import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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

const USAGE = 'usage: node crew/roster-refresh.mjs [--roster <path>] [--catalog <path>] [--out <path>]'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log(USAGE)
    process.exit(0)
  }

  const rosterIdx = process.argv.indexOf('--roster')
  const rosterPath = rosterIdx !== -1 && process.argv[rosterIdx + 1]
    ? process.argv[rosterIdx + 1]
    : new URL('./roster.json', import.meta.url)
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

  process.exit(0)
}
