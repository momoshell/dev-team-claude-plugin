import { accessSync, constants, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rosterSeating } from './roster.mjs'

export const CATALOG_URL = 'https://models.dev/api.json'

const DIFF_FIELDS = ['cost_in_per_mtok', 'cost_out_per_mtok', 'context']

function describeShape(value, record = false) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array of ${value.length} entries`
  if (typeof value === 'string') return 'a string'
  if (typeof value === 'number') return 'a number'
  if (typeof value === 'boolean') return 'a boolean'
  if (typeof value === 'object') {
    if (record) {
      const missing = DIFF_FIELDS.filter((field) => !Number.isFinite(value[field]))
      if (missing.length) return `an object with no numeric ${missing.join(', ')}`
    }
    return 'an object'
  }
  return `a ${typeof value}`
}

const MODEL_EXPECTATION = 'a record with numeric cost_in_per_mtok, cost_out_per_mtok and context'

export function readRosterModels(roster, rosterPath) {
  const models = roster?.models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error(`roster-refresh: refusing to diff ${rosterPath} — expected "models" to be an object mapping "provider/id" to ${MODEL_EXPECTATION}; found ${describeShape(models)}`)
  }

  const before = {}
  for (const [key, model] of Object.entries(models)) {
    if (model === null || typeof model !== 'object' || Array.isArray(model) || DIFF_FIELDS.some((field) => !Number.isFinite(model[field]))) {
      throw new Error(`roster-refresh: refusing to diff ${rosterPath} — models[${JSON.stringify(key)}] must be ${MODEL_EXPECTATION}; found ${describeShape(model, true)}`)
    }
    before[key] = {
      cost_in_per_mtok: model.cost_in_per_mtok,
      cost_out_per_mtok: model.cost_out_per_mtok,
      context: model.context,
    }
  }
  return before
}

export function normalizeCatalog(catalog, providers) {
  const wanted = providers ? new Set(providers) : null
  const out = {}
  for (const [providerId, provider] of Object.entries(catalog || {})) {
    if (wanted && !wanted.has(providerId)) continue
    for (const [modelId, model] of Object.entries(provider?.models || {})) {
      const costIn = model?.cost?.input
      const costOut = model?.cost?.output
      const context = model?.limit?.context
      if (!Number.isFinite(costIn) || !Number.isFinite(costOut) || !Number.isFinite(context)) continue
      out[`${providerId}/${modelId}`] = {
        cost_in_per_mtok: costIn,
        cost_out_per_mtok: costOut,
        context,
      }
    }
  }
  return out
}

export function diffModels(before, after) {
  const beforeKeys = Object.keys(before || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const afterKeys = Object.keys(after || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const added = []
  const removed = []
  const changed = []

  for (const key of afterKeys) {
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      const m = after[key]
      added.push({ key, cost_in_per_mtok: m.cost_in_per_mtok, cost_out_per_mtok: m.cost_out_per_mtok, context: m.context })
    }
  }

  for (const key of beforeKeys) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      const m = before[key]
      removed.push({ key, cost_in_per_mtok: m.cost_in_per_mtok, cost_out_per_mtok: m.cost_out_per_mtok, context: m.context })
    }
  }

  for (const key of beforeKeys) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) continue
    const b = before[key]
    const a = after[key]
    const fields = []
    for (const field of DIFF_FIELDS) {
      if (b[field] !== a[field]) fields.push({ field, from: b[field], to: a[field] })
    }
    if (fields.length) changed.push({ key, fields })
  }

  return { added, removed, changed }
}

function listSection(title, entries, formatEntry) {
  const lines = [`## ${title} (${entries.length})`]
  for (const entry of entries) lines.push(`- ${formatEntry(entry)}`)
  return lines.join('\n')
}

const formatModel = (m) => `${m.key}: cost_in=${m.cost_in_per_mtok} cost_out=${m.cost_out_per_mtok} context=${m.context}`
const formatChanged = (c) => `${c.key}: ${c.fields.map((f) => `${f.field} ${f.from}->${f.to}`).join(', ')}`
const formatUnverifiable = (m) => `${m.key}: no catalog entry; roster values unverified (cost_in=${m.cost_in_per_mtok} cost_out=${m.cost_out_per_mtok} context=${m.context})`

export function renderReport(diff, { generatedAt, rosterUpdatedAt, seatedCount } = {}) {
  const header = [
    '# roster-refresh report',
    `generated_at: ${generatedAt}`,
    `roster_updated_at: ${rosterUpdatedAt}`,
  ].join('\n')

  const hasChanges = diff.added.length || diff.removed.length || diff.changed.length
  const hasSeatedCount = seatedCount !== undefined
  const confirmedCount = hasSeatedCount ? seatedCount - diff.removed.length : undefined
  const confirmedSection = hasSeatedCount
    ? `## Seated models confirmed by the catalog (${confirmedCount} of ${seatedCount})`
    : null
  const removedSection = hasSeatedCount
    ? listSection('Seated models the catalog cannot confirm — unverifiable', diff.removed, formatUnverifiable)
    : listSection('Disappeared', diff.removed, formatModel)

  if (!hasChanges) {
    const confirmation = confirmedSection ? `\n\n${confirmedSection}` : ''
    return `${header}\n\nNo changes vs crew/roster.json.${confirmation}`
  }

  const body = [
    listSection('New models', diff.added, formatModel),
    listSection('Changed', diff.changed, formatChanged),
    confirmedSection,
    removedSection,
  ].filter(Boolean).join('\n\n')

  return `${header}\n\n${body}`
}

// ---- successors: bump every model the factory uses to the newest version in its family ----
//
// A family is recognised only by an explicit, closed set of id shapes. Anything else — a
// local model, a tier suffix on a named model (gpt-6-sol-pro), a dated
// snapshot — has NO family and is never bumped: a wrong guess would silently reseat the
// factory onto a different model. A bare name token IS a family, whatever it names
// (gpt-5-mini -> gpt-5.4-mini, gpt-5.3-codex -> a newer gpt-*-codex).
export const FAMILY_SHAPES = Object.freeze([
  // gpt-<version>-<name>: gpt-5.6-sol, gpt-6-sol. One name token only, so gpt-6-sol-pro is not a sol.
  { pattern: /^gpt-(\d+)(?:\.(\d+))?-([a-z]+)$/, family: (m) => `gpt-*-${m[3]}` },
  // claude-<name>-<major>[-<minor>]: claude-opus-5, claude-opus-5-5. The minor is one or two
  // digits, never a date: claude-opus-4-20250514 is a dated snapshot, and reading 20250514 as a
  // minor version would make it beat every real release. A three-group snapshot never matches.
  { pattern: /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/, family: (m) => `claude-${m[1]}`, version: (m) => [Number(m[2]), Number(m[3] ?? 0)] },
  // muse-spark-<major>.<minor>[-<tier>]: the tier is part of the family, so a contributor stays one.
  { pattern: /^muse-spark-(\d+)\.(\d+)(-[a-z]+)?$/, family: (m) => `muse-spark-*${m[3] ?? ''}`, version: (m) => [Number(m[1]), Number(m[2])] },
])

export function modelFamily(id) {
  for (const shape of FAMILY_SHAPES) {
    const m = shape.pattern.exec(id)
    if (!m) continue
    const version = shape.version ? shape.version(m) : [Number(m[1]), Number(m[2] ?? 0)]
    return { family: shape.family(m), version }
  }
  return null
}

function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

// The newest same-provider, same-family id in the catalog, or null with a closed reason.
export function successorOf(key, catalogKeys, unreleased = new Set()) {
  const slash = key.indexOf('/')
  const provider = key.slice(0, slash)
  const id = key.slice(slash + 1)
  const own = modelFamily(id)
  if (!own) return { key, successor: null, reason: 'family-unrecognised' }
  // A model the catalog does not list is UNCONFIRMED: absence is not a version, so no judgment
  // about it — including that something newer replaces it — is made.
  if (!catalogKeys.includes(key)) return { key, successor: null, reason: 'not-in-catalog' }
  let best = null
  let flagged = false
  for (const candidate of catalogKeys) {
    if (!candidate.startsWith(`${provider}/`)) continue
    const theirs = modelFamily(candidate.slice(provider.length + 1))
    if (!theirs || theirs.family !== own.family) continue
    if (!newer(theirs.version, own.version)) continue
    // A catalog entry flagged alpha, beta or deprecated is never a successor: reseating onto it is a
    // decision about an unreleased or retiring model, not a version bump.
    if (unreleased.has(candidate)) { flagged = true; continue }
    if (!best || newer(theirs.version, best.version)) best = { key: candidate, version: theirs.version }
  }
  if (best) return { key, successor: best.key, reason: null }
  return { key, successor: null, reason: flagged ? 'newer-only-unreleased' : 'already-newest' }
}

// Every seat (and fallback) as provider/id.
export function seatedModelKeys(roster) {
  const keys = new Set()
  // Through the roster's own seating reader, so a v2 roster (seated under `assurances`) is
  // enumerated exactly as the runtime reads it — a v1-only walk silently left v2 seats behind.
  for (const seats of Object.values(rosterSeating(roster) || {})) {
    for (const seat of Object.values(seats || {})) {
      const all = [seat, ...(Array.isArray(seat?.fallback) ? seat.fallback : [])]
      for (const s of all) if (s?.provider && s?.id) keys.add(`${s.provider}/${s.id}`)
    }
  }
  return [...keys].sort()
}

// Every model the roster USES: the catalog keys, plus each seat.
export function usedModelKeys(roster) {
  return [...new Set([...Object.keys(roster?.models || {}), ...seatedModelKeys(roster)])].sort()
}

export function planBump(roster, rawCatalog) {
  const catalogKeys = []
  const unreleased = new Set()
  for (const [providerId, provider] of Object.entries(rawCatalog || {})) {
    for (const [modelId, m] of Object.entries(provider?.models || {})) {
      catalogKeys.push(`${providerId}/${modelId}`)
      // models.dev flags alpha, beta and deprecated; only an entry with NO status is released.
      if (m?.status != null) unreleased.add(`${providerId}/${modelId}`)
    }
  }
  const bumps = []
  const skipped = []
  const seated = new Set(seatedModelKeys(roster))
  for (const key of usedModelKeys(roster)) {
    const r = successorOf(key, catalogKeys, unreleased)
    // A predecessor an earlier apply kept as a PRICE row (unseated, tagged override-only) stays:
    // the ledger prices its history from it. It is never a pending bump, whatever newer
    // successor the catalog lists since.
    if (r.successor && !seated.has(key) && (roster?.models?.[key]?.tags || []).includes('override-only')) skipped.push({ key, reason: 'retained-price-row' })
    else if (r.successor) bumps.push({ from: key, to: r.successor })
    else skipped.push({ key, reason: r.reason })
  }
  return { bumps, skipped }
}

// A roster catalog entry for `key`, built only from what the catalog publishes. A cache rate the
// catalog does not publish is OMITTED and said so — never written as a zero.
export function catalogEntry(key, rawCatalog, { tags = [], today }) {
  const [providerId, ...rest] = key.split('/')
  const m = rawCatalog?.[providerId]?.models?.[rest.join('/')]
  const cost = m?.cost || {}
  if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output) || !Number.isFinite(m?.limit?.context)) {
    throw new Error(`roster-refresh: refusing to write ${key} — the catalog publishes no input/output price or context for it`)
  }
  // roster.schema.json bounds: every price a number >= 0, context an integer >= 1. loadRoster does
  // not check model fields, so an out-of-bounds catalog value would otherwise be written as-is.
  const outOfBounds = Object.entries({ input: cost.input, output: cost.output, cache_read: cost.cache_read, cache_write: cost.cache_write })
    .filter(([, v]) => v != null && !(Number.isFinite(v) && v >= 0)).map(([k]) => k)
  if (!Number.isInteger(m.limit.context) || m.limit.context < 1) outOfBounds.push('context')
  if (outOfBounds.length) throw new Error(`roster-refresh: refusing to write ${key} — the catalog's ${outOfBounds.join(', ')} is outside roster.schema.json's bounds`)
  const entry = { cost_in_per_mtok: cost.input, cost_out_per_mtok: cost.output }
  const hasRead = Number.isFinite(cost.cache_read)
  const hasWrite = Number.isFinite(cost.cache_write)
  // models.dev's anthropic cacheWrite is the 5-minute rate (1.25x input). The roster prices that
  // column at the ratified 1h rate, 2.00x input (CELL_PRICE_UNITS), so a published anthropic write
  // is converted, never copied; an unpublished one stays omitted.
  const hourWrite = providerId === 'anthropic' && hasWrite
  if (hasRead) entry.cost_cache_read_per_mtok = cost.cache_read
  if (hasWrite) entry.cost_cache_write_per_mtok = hourWrite ? cost.input * 2 : cost.cache_write
  const sentences = [hasRead && hasWrite
    ? 'models.dev published cache read and cache write rates for this model.'
    : `models.dev publishes no ${[!hasRead && 'cache read', !hasWrite && 'cache write'].filter(Boolean).join(' or ')} rate for this model; it is omitted, not zero.`]
  if (hourWrite) sentences.push(`Its cache write of ${cost.cache_write} is the 5-minute rate; this entry prices writes at the ratified 1h-TTL rate, 2.00x cost_in_per_mtok, derived from the multiplier rather than read from a published per-model figure.`)
  const tier = Array.isArray(cost.tiers) ? cost.tiers.find((t) => Number.isFinite(t?.tier?.size)) : null
  if (tier) sentences.push(`models.dev also declares a second price tier above ${tier.tier.size} tokens that this single-rate entry cannot represent; usage above it is underpriced here.`)
  entry.cache_rate_source = sentences.join(' ')
  entry.context = m.limit.context
  entry.tags = tags
  entry.source = 'models.dev'
  entry.last_verified = today
  return entry
}

// The ratified per-vendor cache multipliers the shipped price check holds every row to. A new row
// whose published rate departs from them is REPORTED, never silently normalised: a published
// figure may be right (Opus 5.5 reads at 0.05x), and deciding that is a ratification, not a bump.
export const RATIFIED_CACHE_MULTIPLIERS = Object.freeze({
  anthropic: Object.freeze({ read: 0.10, write: 2.00 }),
  openai: Object.freeze({ read: 0.10, write: 0 }),
})
export function rateDepartures(key, entry) {
  const ratified = RATIFIED_CACHE_MULTIPLIERS[key.slice(0, key.indexOf('/'))]
  if (!ratified || !Number.isFinite(entry?.cost_in_per_mtok)) return []
  const out = []
  for (const [column, field] of [['read', 'cost_cache_read_per_mtok'], ['write', 'cost_cache_write_per_mtok']]) {
    if (!Number.isFinite(entry[field])) continue
    const expected = entry.cost_in_per_mtok * ratified[column]
    if (Math.abs(entry[field] - expected) > 1e-12) out.push(`${key}: cache ${column} ${entry[field]} per Mtok, not the ratified ${ratified[column].toFixed(2)}x (${expected})`)
  }
  return out
}

// Rewrite by FULL key only. A `provider/id` string is replaced when it is exactly an old key; an
// object carrying both `provider` and `id` (a seat, a fallback, a routing candidate) has its id
// replaced through ITS OWN provider. A bare id string is never mapped on its own: two providers
// can share a bare id with different successors, and a global bare map would cross-wire them.
// Prose that merely MENTIONS an old id is left alone on purpose — a ladder's membership_basis
// cites measured scores for the model that was measured.
export function replaceIds(value, keyMap) {
  if (Array.isArray(value)) return value.map((v) => replaceIds(v, keyMap))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = replaceIds(v, keyMap)
    if (typeof value.provider === 'string' && typeof value.id === 'string') {
      const to = keyMap[`${value.provider}/${value.id}`]
      if (to) out.id = to.slice(to.indexOf('/') + 1)
    }
    return out
  }
  return value
}

// Ladder members are the one place a model is referenced by a bare `provider/id` string, so
// they are rewritten explicitly — and nowhere else is a string touched. A band that already
// holds the successor keeps ONE copy; a successor already seated in a DIFFERENT band is a
// placement decision this tool will not make, so it refuses rather than write a ladder that
// names one model twice.
export function bumpLadder(ladder, keyMap) {
  const bands = (ladder?.bands || []).map((band) => {
    if (!Array.isArray(band?.members)) return band
    const members = []
    for (const m of band.members) {
      const next = keyMap[m] ?? m
      if (!members.includes(next)) members.push(next)
    }
    return { ...replaceIds(band, keyMap), members }
  })
  const seen = new Map()
  bands.forEach((band, i) => (band.members || []).forEach((m) => {
    if (seen.has(m) && seen.get(m) !== i) {
      throw new Error(`roster-refresh: refusing to apply — ${m} would sit in ladder bands ${seen.get(m)} and ${i}; which band a successor belongs to is a placement decision, not a version bump`)
    }
    seen.set(m, i)
  }))
  return { ...ladder, bands }
}

export function applyBump({ roster, ladder, routing, workflows = {} }, plan, rawCatalog, { today }) {
  const keyMap = Object.fromEntries(plan.bumps.map((b) => [b.from, b.to]))
  const nextRoster = replaceIds(roster, keyMap)
  // A bump that lands a fallback on its own primary seats one model twice: a placement decision.
  for (const [tier, seats] of Object.entries(rosterSeating(nextRoster) || {})) {
    for (const [role, seat] of Object.entries(seats || {})) {
      const chain = [seat, ...(Array.isArray(seat?.fallback) ? seat.fallback : [])].map((c) => `${c?.provider}/${c?.id}`)
      const twice = chain.find((k, i) => chain.indexOf(k) !== i)
      if (twice) throw new Error(`roster-refresh: refusing to apply — ${tier}.${role} would name ${twice} twice across its primary and fallbacks; which fallback it needs is a placement decision, not a version bump`)
    }
  }
  // Every successor key gets ONE fresh catalog entry, carrying the union of the tags of the
  // entries it replaces. A successor the roster already held is refreshed too: iteration order
  // must never let a stale retained entry win over the price just read from the catalog.
  const tagsFor = {}
  for (const [key, entry] of Object.entries(roster.models || {})) {
    const target = keyMap[key] ?? (Object.values(keyMap).includes(key) ? key : null)
    if (target) tagsFor[target] = [...new Set([...(tagsFor[target] || []), ...(entry.tags || [])])]
  }
  // A replaced model's entry STAYS as an unseated price row: the ledger prices its recorded
  // history from this catalog, and dropping it would turn that history unpriced. It is tagged
  // override-only, the tag nextModelRung's failure-upgrade walk skips, so no reseat can land on
  // it; no seat names it and the ladder no longer admits it. Order is kept: each successor sits
  // right after the row it replaces, so the diff is the change and nothing else.
  const successors = new Set(Object.values(keyMap))
  const models = {}
  const place = (to) => { if (!Object.hasOwn(models, to)) models[to] = catalogEntry(to, rawCatalog, { tags: tagsFor[to] || [], today }) }
  for (const [key, entry] of Object.entries(roster.models || {})) {
    if (successors.has(key)) { place(key); continue }
    if (keyMap[key]) {
      models[key] = { ...entry, tags: [...new Set([...(entry.tags || []), 'override-only'])] }
      place(keyMap[key])
      continue
    }
    models[key] = entry
  }
  for (const to of successors) place(to)
  nextRoster.models = models
  nextRoster.updated_at = today
  // A document the bump names nothing in is returned as it was: no new date, no rewrite.
  const dated = (before, after) => (before && JSON.stringify(after) !== JSON.stringify(before) && Object.hasOwn(after, 'updated_at') ? { ...after, updated_at: today } : after)
  return {
    roster: nextRoster,
    ladder: ladder ? dated(ladder, bumpLadder(ladder, keyMap)) : ladder,
    routing: routing ? dated(routing, replaceIds(routing, keyMap)) : routing,
    workflows: Object.fromEntries(Object.entries(workflows).map(([name, doc]) => [name, replaceIds(doc, keyMap)])),
  }
}

// All-or-nothing: every file is checked writable and staged to a temp sibling BEFORE any target
// changes. If staging fails nothing is touched; if a rename fails part-way, every target already
// replaced is restored from the original text read at the start. A failed apply must never leave
// the roster, the ladder and the routing policy naming different models.
export function commitWrites(writes, fsx) {
  // A backup left by an earlier failed rollback may be the ONLY original of its file. Starting again
  // would overwrite it, so recovery comes first.
  const leftover = writes.map((w) => `${w.path}.roster-refresh.bak`).filter((bak) => fsx.existsSync(bak))
  if (leftover.length) throw new Error(`roster-refresh: --apply refused to start — ${leftover.join(', ')} holds an original an earlier apply left behind (a failed rollback, or a backup it could not remove); compare it with its file, restore it by hand if it differs, and delete the .bak before re-running`)
  const staged = []
  const backedUp = []
  try {
    for (const w of writes) fsx.accessSync(w.path, fsx.constants.W_OK)
    for (const w of writes) { const tmp = `${w.path}.roster-refresh.tmp`; fsx.writeFileSync(tmp, w.next); staged.push({ ...w, tmp }) }
    // The repo's own loaders read every staged file before any target changes: an output the
    // runtime would reject is never written, and --apply never reports a success it did not have.
    for (const st of staged) st.validate?.(st.tmp)
    // Originals go to disk BEFORE any rename, so recovery never depends on a restore succeeding.
    for (const st of staged) { st.bak = `${st.path}.roster-refresh.bak`; fsx.writeFileSync(st.bak, st.original); backedUp.push(st) }
  } catch (err) {
    for (const st of staged) { try { fsx.unlinkSync(st.tmp) } catch {} }
    for (const st of backedUp) { try { fsx.unlinkSync(st.bak) } catch {} }
    throw new Error(`roster-refresh: --apply aborted before changing any file — ${err.message}`)
  }
  const done = []
  try {
    for (const st of staged) { fsx.renameSync(st.tmp, st.path); done.push(st) }
  } catch (err) {
    const unrestored = []
    for (const st of done) { try { fsx.writeFileSync(st.path, st.original) } catch { unrestored.push(st) } }
    for (const st of staged) { try { fsx.unlinkSync(st.tmp) } catch {} }
    for (const st of staged) if (!unrestored.includes(st)) { try { fsx.unlinkSync(st.bak) } catch {} }
    if (unrestored.length) {
      throw new Error(`roster-refresh: --apply failed part-way and could NOT restore ${unrestored.map((st) => st.path).join(', ')}; the original of each is preserved at <file>.roster-refresh.bak — the configuration is MIXED until they are restored — ${err.message}`)
    }
    throw new Error(`roster-refresh: --apply failed part-way and restored all ${done.length} file(s) it had replaced — ${err.message}`)
  }
  const kept = []
  for (const st of staged) { try { fsx.unlinkSync(st.bak) } catch { kept.push(st.bak) } }
  if (kept.length) throw new Error(`roster-refresh: --apply succeeded, but could not remove ${kept.join(', ')}; delete it before the next run, which refuses while it exists`)
}

// Old ids still named in PROSE after an apply — reported for a human, never rewritten.
export function proseMentions(doc, bumps) {
  const hits = []
  const walk = (v, path) => {
    if (typeof v === 'string') {
      for (const { from } of bumps) {
        const bare = from.slice(from.indexOf('/') + 1)
        // Bounded on both sides, so a successor that merely EXTENDS the old id (claude-opus-5-5
        // contains claude-opus-5) is not mistaken for a mention of it.
        const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // Exact values are reported too: after an apply every reference field has moved, so an old
        // id left ANYWHERE — a basis that is exactly an id, a bare id with no provider — is stale.
        if (new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(v)) hits.push({ path, id: bare })
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  }
  walk(doc, '')
  return hits
}

// Dated benches whose production is a replaced model. Advisory only: an apply has already
// succeeded when this runs, so nothing here may fail it, and a directory it cannot read is named
// (unmeasured), never skipped in silence.
export function replacedBenches(benchRoot, from, fsx = { existsSync, readdirSync, readFileSync }) {
  const benches = []
  const unscanned = []
  const list = (path) => { try { return fsx.readdirSync(path) } catch (err) { unscanned.push(`${path} (${err.code || err.message})`); return [] } }
  if (!fsx.existsSync(benchRoot)) return { benches, unscanned }
  for (const day of list(benchRoot)) {
    const bench = join(benchRoot, day, 'bench')
    if (!fsx.existsSync(bench)) continue
    for (const role of list(bench)) {
      const path = join(bench, role, 'candidates.json')
      try { if (from.has(JSON.parse(fsx.readFileSync(path, 'utf8')).production)) benches.push(path) } catch {}
    }
  }
  return { benches, unscanned }
}

const USAGE = 'usage: node crew/roster-refresh.mjs [--roster <path>] [--catalog <path>] [--out <path>] [--apply]'

if (import.meta.main) {
  if (process.argv.includes('--help')) {
    console.log(USAGE)
    process.exit(0)
  }

  const rosterIdx = process.argv.indexOf('--roster')
  // A --roster with no value (an unset "$ROSTER", a trailing flag) must never fall back to the
  // shipped roster: under --apply that would rewrite this checkout's own configuration.
  if (rosterIdx !== -1 && !process.argv[rosterIdx + 1]) {
    console.error(`roster-refresh: --roster was given no path; refusing rather than falling back to the shipped roster\n${USAGE}`)
    process.exit(1)
  }
  const rosterPath = rosterIdx !== -1 ? process.argv[rosterIdx + 1] : new URL('./roster.json', import.meta.url)
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'))

  let before
  try {
    before = readRosterModels(roster, rosterPath)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  const catalogIdx = process.argv.indexOf('--catalog')
  const catalogPath = catalogIdx !== -1 && process.argv[catalogIdx + 1] ? process.argv[catalogIdx + 1] : null
  let catalog
  if (catalogPath) {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  } else {
    try {
      const res = await fetch(CATALOG_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      catalog = await res.json()
    } catch (err) {
      console.error(`roster-refresh: could not fetch ${CATALOG_URL} — ${err.message}`)
      process.exit(1)
    }
  }

  const providers = new Set()
  for (const seats of Object.values(roster.tiers || {})) {
    for (const seat of Object.values(seats || {})) {
      if (seat) providers.add(seat.provider)
    }
  }

  const after = normalizeCatalog(catalog, providers)
  const diff = diffModels(before, after)
  const report = renderReport(diff, {
    generatedAt: new Date().toISOString(),
    rosterUpdatedAt: roster.updated_at,
    seatedCount: Object.keys(before).length,
  })

  console.log(report)

  const outIdx = process.argv.indexOf('--out')
  if (outIdx !== -1 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], report)
  }

  // --apply: move every model the factory uses to the newest version of its family, in the
  // roster, the model ladder and the routing policy. Without it, print the plan and change nothing.
  const plan = planBump(roster, catalog)
  const planLines = [
    `\n## Version bumps (${plan.bumps.length})`,
    ...plan.bumps.map((b) => `- ${b.from} -> ${b.to}`),
    `\n## Not bumped (${plan.skipped.length})`,
    ...plan.skipped.map((s) => `- ${s.key}: ${s.reason}`),
  ]
  console.log(planLines.join('\n'))
  if (process.argv.includes('--apply') && plan.bumps.length) {
    const dir = dirname(fileURLToPath(typeof rosterPath === 'string' ? pathToFileURL(resolve(rosterPath)) : rosterPath))
    const read = (name) => { const path = join(dir, name); return { path, doc: JSON.parse(readFileSync(path, 'utf8')) } }
    const today = new Date().toISOString().slice(0, 10)
    const rosterFile = typeof rosterPath === 'string' ? rosterPath : fileURLToPath(rosterPath)
    // Each file keeps its own ending: a trailing newline only where the original had one.
    const json = (doc, original) => `${JSON.stringify(doc, null, 2)}${original.endsWith('\n') ? '\n' : ''}`
    let next
    try {
      const ladder = read('model-ladder.json')
      const routing = read('routing-policy.json')
      // Workflow maps pin seats too (crew/workflows/*.json); a bump that left them behind would
      // make `crew boot --workflow <name>` refuse the old model the ladder no longer lists.
      const workflowDir = join(dir, 'workflows')
      const workflows = existsSync(workflowDir)
        ? readdirSync(workflowDir).filter((n) => n.endsWith('.json') && !n.endsWith('.schema.json')).map((n) => read(join('workflows', n)))
        : []
      next = applyBump({ roster, ladder: ladder.doc, routing: routing.doc, workflows: Object.fromEntries(workflows.map((w) => [w.path, w.doc])) }, plan, catalog, { today })
      const { loadLadder, loadRoutingPolicy } = await import('./crew.mjs')
      const { loadRoster } = await import('./roster.mjs')
      const { validateWorkflow } = await import('./workflows.mjs')
      const { loadCapabilities } = await import('./capabilities.mjs')
      const file = (path, doc, validate) => { const original = readFileSync(path, 'utf8'); return { path, original, next: json(doc, original), validate } }
      // A file whose content the bump does not change is not rewritten (its formatting and hash
      // stay exactly as they were).
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      const writes = [file(rosterFile, next.roster, (tmp) => loadRoster(tmp))]
      if (!same(next.ladder, ladder.doc)) writes.push(file(ladder.path, next.ladder, (tmp) => loadLadder({ path: tmp })))
      if (!same(next.routing, routing.doc)) writes.push(file(routing.path, next.routing, (tmp) => loadRoutingPolicy({ path: tmp })))
      // Validated as the shipped D1 check does (build tier, all four workflow roles) against the
      // STAGED ladder, so a workflow the new ladder refuses is never written.
      for (const w of workflows) {
        if (JSON.stringify(next.workflows[w.path]) === JSON.stringify(w.doc)) continue
        writes.push(file(w.path, next.workflows[w.path], (tmp) => validateWorkflow(JSON.parse(readFileSync(tmp, 'utf8')), {
          register: loadCapabilities(), ladder: loadLadder({ path: writes.some((x) => x.path === ladder.path) ? `${ladder.path}.roster-refresh.tmp` : ladder.path }), tier: 'build', roles: ['lead', 'planner', 'builder', 'reviewer'], path: tmp,
        })))
      }
      commitWrites(writes, { accessSync, constants, existsSync, writeFileSync, renameSync, unlinkSync })
      console.log(`\napplied ${plan.bumps.length} bump(s) to ${writes.map((w) => w.path).join(', ')}`)
    } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
    const prose = [
      ...proseMentions(next.ladder, plan.bumps).map((h) => `model-ladder.json${h.path}`),
      ...proseMentions(next.routing, plan.bumps).map((h) => `routing-policy.json${h.path}`),
      ...Object.entries(next.workflows).flatMap(([path, doc]) => proseMentions(doc, plan.bumps).map((h) => `${path}${h.path}`)),
    ]
    if (prose.length) console.log(`still naming an old id, NOT rewritten (prose records what was measured; anything else is a reference the tool could not bump):\n${[...new Set(prose)].map((p) => `- ${p}`).join('\n')}`)
    // Everything below is for a human: the tool changes none of it.
    const departures = [...new Set(plan.bumps.map((b) => b.to))].flatMap((to) => rateDepartures(to, next.roster.models[to]))
    if (departures.length) console.log(`published cache rates that depart from the vendor's ratified multiplier — written as published; ratify each or correct it:\n${departures.map((d) => `- ${d}`).join('\n')}`)
    const benchRoot = join(dir, '..', 'docs', 'audits')
    const from = new Set(plan.bumps.map((b) => b.from))
    const { benches, unscanned } = replacedBenches(benchRoot, from)
    if (unscanned.length) console.log(`bench directories that could not be scanned for a replaced production (unmeasured, not clear):\n${unscanned.map((u) => `- ${u}`).join('\n')}`)
    if (benches.length) console.log(`dated benches whose production is a replaced model — model-eval refuses them (production-absent) until they are re-declared, and they are dated records:\n${benches.map((b) => `- ${b}`).join('\n')}`)
    console.log('next: run npm test. The ratified-rates check pins every catalog key, so each new row is ratified there by hand. Move tests that pin which models are SEATED; a format, price-history or dated-record check that fails is a finding, not a test to update.')
  }

  process.exit(0)
}
