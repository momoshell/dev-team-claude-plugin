import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unifiedDiff, proposeEdit } from './roster-edit.mjs'
import { normalizeRoster, serializeRosterV1, serializeRosterV2 } from '../../crew/roster.mjs'
import { breakerPolicy, cellHealth } from '../../crew/breaker.mjs'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
export const LADDER_PATH = resolve(SERVER_DIR, '..', '..', 'crew', 'model-ladder.json')
export const REFERENCE_ENV = 'DEVTEAM_MODEL_REFERENCE'
export const LADDER_CHECKS = Object.freeze(['band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling'])
const DEFAULT_REFERENCE_PATH = resolve(dirname(LADDER_PATH), 'model-reference.json')
const REQUIRED_TIERS = ['mechanical', 'build', 'judge']

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function numberValue(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function pathValue(candidate, fallback) {
  return resolve(candidate || fallback)
}

function pathError(reason, path) {
  const text = String(reason || 'unknown read error')
  return text.endsWith(`, at ${path}`) ? text : `${text}, at ${path}`
}

function ladderFailure(path, reason) {
  return {
    path,
    degraded: true,
    error: pathError(reason, path),
    ratified_at: null,
    ratified_by: null,
    bands: null,
    tier_floors: null,
    cost_ceilings: null,
  }
}

function parseJson(path, label) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null }
  } catch (err) {
    const reason = err instanceof SyntaxError
      ? `invalid ${label} JSON: ${err.message}`
      : `unable to read ${label}: ${err.message || 'unknown read error'}`
    return { value: null, error: reason }
  }
}

export function readLadder({ ladderPath } = {}) {
  const path = pathValue(ladderPath, LADDER_PATH)
  const parsed = parseJson(path, 'model ladder')
  if (parsed.error) return ladderFailure(path, parsed.error)
  const source = parsed.value
  if (!record(source) || source.schema_version !== 1) return ladderFailure(path, 'model ladder must be a schema_version 1 object')
  if (typeof source.ratified_at !== 'string' || !source.ratified_at || typeof source.ratified_by !== 'string' || !source.ratified_by) {
    return ladderFailure(path, 'model ladder must name ratified_at and ratified_by')
  }
  if (!Array.isArray(source.bands) || !source.bands.length) return ladderFailure(path, 'model ladder must contain a non-empty bands array')
  if (!record(source.tier_floors) || !record(source.cost_ceilings)) return ladderFailure(path, 'model ladder must contain tier_floors and cost_ceilings objects')

  const members = new Set()
  const bandNamesSeen = new Set()
  const bands = []
  for (const entry of source.bands) {
    if (!record(entry) || typeof entry.band !== 'string' || !entry.band || !Number.isInteger(entry.rank) || !finite(entry.floor_reference_score) || !Array.isArray(entry.members) || !entry.members.every((member) => typeof member === 'string' && member)) {
      return ladderFailure(path, 'each model ladder band must name a band, rank, floor_reference_score and members array')
    }
    if (bandNamesSeen.has(entry.band)) return ladderFailure(path, `model ladder band ${entry.band} appears more than once`)
    bandNamesSeen.add(entry.band)
    for (const member of entry.members) {
      if (members.has(member)) return ladderFailure(path, `model ladder member ${member} appears in more than one band`)
      members.add(member)
    }
    bands.push({ band: entry.band, rank: entry.rank, floor_reference_score: entry.floor_reference_score, members: [...entry.members] })
  }
  bands.sort((left, right) => right.rank - left.rank || left.band.localeCompare(right.band))
  const bandNames = new Set(bands.map((band) => band.band))
  for (const tier of REQUIRED_TIERS) {
    if (typeof source.tier_floors[tier] !== 'string' || !bandNames.has(source.tier_floors[tier])) return ladderFailure(path, `tier_floors.${tier} must name a band`)
    if (!finite(source.cost_ceilings[tier]) || source.cost_ceilings[tier] < 0) return ladderFailure(path, `cost_ceilings.${tier} must be a non-negative number`)
  }

  return {
    path,
    degraded: false,
    error: null,
    ratified_at: source.ratified_at,
    ratified_by: source.ratified_by,
    bands,
    tier_floors: { ...source.tier_floors },
    cost_ceilings: { ...source.cost_ceilings },
  }
}

export function readReference({ referencePath } = {}) {
  const path = pathValue(referencePath, process.env[REFERENCE_ENV] || DEFAULT_REFERENCE_PATH)
  const parsed = parseJson(path, 'cached model reference')
  if (parsed.error) return { path, present: false, fetched_at: null, source: null, scores: null, error: pathError(parsed.error, path) }
  const source = parsed.value
  if (!record(source) || !record(source.models)) {
    return { path, present: false, fetched_at: null, source: null, scores: null, error: pathError('cached model reference must contain a models object', path) }
  }
  if (typeof source.fetched_at !== 'string' || typeof source.source !== 'string') {
    return { path, present: false, fetched_at: null, source: null, scores: null, error: pathError('cached model reference must contain fetched_at and source strings', path) }
  }
  const scores = {}
  for (const [key, value] of Object.entries(source.models)) {
    if (!record(value)) return { path, present: false, fetched_at: null, source: null, scores: null, error: pathError(`cached model reference entry ${key} must be an object`, path) }
    scores[key] = value.score
  }
  return { path, present: true, fetched_at: source.fetched_at, source: source.source, scores, error: null }
}

function splitKey(key) {
  const slash = String(key).indexOf('/')
  if (slash < 0) return { provider: String(key), id: null }
  return { provider: String(key).slice(0, slash), id: String(key).slice(slash + 1) }
}

function modelRows(models) {
  if (Array.isArray(models)) return models.filter((model) => record(model) && typeof model.key === 'string')
  if (!record(models)) return []
  return Object.entries(models).map(([key, value]) => ({ key, ...(record(value) ? value : {}) }))
}

function bandMap(bands) {
  const byMember = new Map()
  for (const band of Array.isArray(bands) ? bands : []) for (const key of band.members || []) byMember.set(key, band)
  return byMember
}

function referenceState(key, reference) {
  if (!reference?.present || !record(reference.scores)) {
    const path = reference?.path || '<unknown path>'
    return {
      value: null,
      pending: `no cached reference index at ${path} — the board never fetches and never invents a score`,
    }
  }
  if (!Object.prototype.hasOwnProperty.call(reference.scores, key)) {
    return {
      value: null,
      pending: `${key} is not in the cached reference index (fetched ${reference.fetched_at}) — unscored`,
    }
  }
  const value = reference.scores[key]
  if (!finite(value)) {
    return {
      value: null,
      pending: `${key} carries a non-numeric score in the cached reference index — unscored`,
    }
  }
  return { value, pending: null }
}

function proposedBand(score, bands) {
  if (!finite(score)) return null
  return [...(bands || [])].sort((left, right) => right.rank - left.rank).find((band) => score >= band.floor_reference_score)?.band || null
}

function measurementState(key, cells) {
  if (!cells || cells.absent != null || !Array.isArray(cells.rows)) {
    return {
      value: null,
      pending: `unmeasured here — ${cells?.absent || 'the cell failure readout is unavailable'}`,
    }
  }
  const rows = cells.rows.filter((row) => record(row) && String(row.provider) + '/' + String(row.model_id) === key)
  if (!rows.length) {
    return {
      value: { failures: 0, run_less: 0, in_run: 0, host_attributed: 0, counted: 0, cells: 0, kinds: {}, first_at: null, last_at: null },
      pending: null,
    }
  }
  let failures = 0
  let runLess = 0
  let hostAttributed = 0
  let firstAt = null
  let lastAt = null
  const cellKeys = new Set()
  const kinds = new Map()
  for (const row of rows) {
    const rowFailures = numberValue(row.failures)
    const rowRunLess = numberValue(row.run_less)
    failures += rowFailures
    runLess += rowRunLess
    hostAttributed += numberValue(row.host_attributed)
    cellKeys.add(`${row.agent ?? '<missing>'}\u001f${row.effort ?? '<missing>'}`)
    const kind = String(row.kind ?? '<unknown>')
    kinds.set(kind, (kinds.get(kind) || 0) + rowFailures)
    if (row.first_at != null && (firstAt == null || String(row.first_at) < String(firstAt))) firstAt = row.first_at
    if (row.last_at != null && (lastAt == null || String(row.last_at) > String(lastAt))) lastAt = row.last_at
  }
  return {
    value: {
      failures,
      run_less: runLess,
      in_run: failures - runLess,
      host_attributed: hostAttributed,
      counted: Math.max(0, failures - runLess - hostAttributed),
      cells: cellKeys.size,
      kinds: Object.fromEntries([...kinds.entries()].sort(([left], [right]) => left.localeCompare(right))),
      first_at: firstAt,
      last_at: lastAt,
    },
    pending: null,
  }
}

function seatedMap(roster) {
  const map = new Map()
  for (const tier of Array.isArray(roster?.tiers) ? roster.tiers : []) {
    for (const seat of Array.isArray(tier?.seats) ? tier.seats : []) {
      const key = seat.model_key || (seat.provider != null && seat.id != null ? `${seat.provider}/${seat.id}` : null)
      if (!key) continue
      const list = map.get(key) || []
      list.push({ tier: tier.tier, role: seat.role })
      map.set(key, list)
    }
  }
  return map
}

function railRows(roster, ladder) {
  const floors = ladder?.tier_floors || {}
  const ceilings = ladder?.cost_ceilings || {}
  const byBand = new Map((ladder?.bands || []).map((band) => [band.band, band]))
  return (Array.isArray(roster?.tiers) ? roster.tiers : []).map((tier) => {
    const floorBand = floors[tier.tier] ?? null
    const floor = byBand.get(floorBand)
    return {
      tier: tier.tier,
      floor_band: floorBand,
      floor_rank: floor?.rank ?? null,
      cost_ceiling_out_per_mtok: finite(ceilings[tier.tier]) ? ceilings[tier.tier] : null,
      seats: (tier.seats || []).map((seat) => ({
        role: seat.role,
        model_key: seat.model_key || (seat.provider != null && seat.id != null ? `${seat.provider}/${seat.id}` : null),
        cell: seat.provider == null && seat.id == null && seat.agent == null && seat.effort == null
          ? null
          : { provider: seat.provider, id: seat.id, agent: seat.agent, effort: seat.effort },
      })),
      unseated: [...(tier.unseated || [])],
    }
  })
}

export function ladderView({ roster, ladder, reference, cells } = {}) {
  const referenceRecord = reference || { path: null, fetched_at: null, source: null }
  const measuredWindow = cells?.measured_window
    ?? (cells && (cells.since !== undefined || cells.until !== undefined || cells.label !== undefined)
      ? { since: cells.since ?? null, until: cells.until ?? null, label: cells.label ?? null }
      : null)
  const base = {
    path: ladder?.path ?? LADDER_PATH,
    degraded: ladder?.degraded !== false,
    error: ladder?.error ?? null,
    ratified_at: ladder?.ratified_at ?? null,
    ratified_by: ladder?.ratified_by ?? null,
    reference_path: referenceRecord.path ?? null,
    reference_fetched_at: referenceRecord.fetched_at ?? null,
    reference_source: referenceRecord.source ?? null,
    measured_window: measuredWindow,
    bands: null,
    chips: null,
    rail: null,
  }
  if (base.degraded) {
    base.error = base.error || `model ladder is unavailable, at ${base.path}`
    return base
  }

  const bands = (ladder.bands || []).map((band) => ({
    band: band.band,
    rank: band.rank,
    floor_reference_score: band.floor_reference_score,
    members: [...band.members],
  }))
  const models = modelRows(roster?.models)
  const keys = new Set(models.map((model) => model.key))
  for (const band of bands) for (const key of band.members) keys.add(key)
  const catalog = new Map(models.map((model) => [model.key, model]))
  const byMember = bandMap(bands)
  const seated = seatedMap(roster)
  const chips = [...keys].map((key) => {
    const { provider, id } = splitKey(key)
    const model = catalog.get(key)
    const band = byMember.get(key) || null
    const score = referenceState(key, referenceRecord)
    const measured = measurementState(key, cells)
    const proposed = proposedBand(score.value, bands)
    const bandName = band?.band ?? null
    const drift = score.value == null || proposed === bandName
      ? null
      : {
          ratified: bandName,
          proposed,
          why: `reference score ${score.value} proposes "${proposed || 'none'}"; the ratified band "${bandName || 'none'}" stands until a human ratifies the change, at crew/model-ladder.json`,
        }
    const cost = model?.cost_out_per_mtok
    const costKnown = finite(cost)
    return {
      key,
      provider,
      id,
      band: bandName,
      band_pending: band ? null : `${key} is not a member of any ratified band at crew/model-ladder.json — unratified`,
      reference: score.value,
      reference_pending: score.pending,
      proposed_band: proposed,
      drift,
      drift_pending: score.value == null ? score.pending : null,
      measured: measured.value,
      measured_pending: measured.pending,
      cost_out_per_mtok: costKnown ? cost : null,
      cost_pending: costKnown ? null : `${key} has no finite cost_out_per_mtok in the roster model catalog — unpriced`,
      seated_at: seated.get(key) || [],
    }
  })

  return {
    ...base,
    bands,
    chips,
    rail: railRows(roster, ladder),
  }
}

// The REPOSITORY text: what a patch proposes to land in git. Always v2.
function repositoryRosterText (roster, sourceText) {
  const canonical = serializeRosterV2(roster)
  return sourceText.endsWith('\n') ? `${canonical}\n` : canonical
}

// The COMPATIBILITY text: what a LOCAL apply writes back over the active file.
// A v1 source is written back as canonical v1 and a v2 source as canonical v2,
// because the active file still has readers that cannot read v2 —
// visualizer/server/roster-source.mjs:58, crew/seat-io.mjs:3121,3155 and
// scripts/factory/dispatch-batch.mjs:1047, and the out-of-scope proof at
// test/visualizer-server.test.mjs:1920 reads `.tiers` straight back out.
function canonicalRosterText (roster, sourceText, version) {
  const canonical = version === 2 ? serializeRosterV2(roster) : serializeRosterV1(roster)
  return sourceText.endsWith('\n') ? `${canonical}\n` : canonical
}

function parseRosterText(rosterText) {
  if (typeof rosterText !== 'string') return { roster: null, canonical: false, version: null }
  try {
    const raw = JSON.parse(rosterText)
    const canonical = JSON.stringify(raw, null, 2) === (rosterText.endsWith('\n') ? rosterText.slice(0, -1) : rosterText)
    const roster = normalizeRoster(raw)
    return { roster, canonical, version: roster.schema_version }
  } catch {
    return { roster: null, canonical: false, version: null }
  }
}

function setMove(roster, move) {
  if (!record(roster) || !record(roster.tiers) || typeof move?.tier !== 'string' || typeof move?.role !== 'string') return
  if (!Object.prototype.hasOwnProperty.call(roster.tiers, move.tier)) return
  if (!record(roster.tiers[move.tier])) roster.tiers[move.tier] = {}
  roster.tiers[move.tier][move.role] = clone(move.cell)
}

function moveKey(move) {
  if (!record(move?.cell) || typeof move.cell.provider !== 'string' || typeof move.cell.id !== 'string') return null
  return `${move.cell.provider}/${move.cell.id}`
}

function check(checkName, ok, message) {
  return { check: checkName, ok: Boolean(ok), message: String(message || (ok ? `${checkName} passed` : `${checkName} failed`)) }
}

const LOCAL_POLICY_REFUSALS = new Set(['cross_vendor', 'judge_vendor_split'])

function localBlockingRefusals(refusals) {
  return (Array.isArray(refusals) ? refusals : []).filter((refusal) => !LOCAL_POLICY_REFUSALS.has(refusal?.code))
}

function affectedTiers(moves, roster) {
  return [...new Set((Array.isArray(moves) ? moves : [])
    .filter((move) => typeof move?.tier === 'string' && record(roster?.tiers) && Object.prototype.hasOwnProperty.call(roster.tiers, move.tier))
    .map((move) => move.tier))]
}

function modelMoves(moves) {
  return (Array.isArray(moves) ? moves : []).filter((move) => move?.cell !== null)
}

function bandFloorCheck(moves, ladder) {
  if (ladder?.degraded) return check('band_floor', false, ladder.error || 'model ladder is degraded and cannot validate band floors')
  if (!ladder || !Array.isArray(ladder.bands) || !record(ladder.tier_floors)) return check('band_floor', false, 'model ladder is unavailable and cannot validate band floors, at crew/model-ladder.json')
  const seatedMoves = modelMoves(moves)
  if (!seatedMoves.length) return check('band_floor', true, 'band floor is not applicable to cell:null moves; no model was changed')
  const bands = bandMap(ladder.bands)
  const byName = new Map(ladder.bands.map((band) => [band.band, band]))
  const failures = []
  for (const move of seatedMoves) {
    const key = moveKey(move)
    const floorName = ladder.tier_floors[move?.tier]
    const floor = byName.get(floorName)
    if (!floor) {
      failures.push(`no ratified floor band for tiers.${move?.tier}.${move?.role} at crew/model-ladder.json tier_floors.${move?.tier}`)
      continue
    }
    if (!key) {
      failures.push(`expected a model in a band at or above "${floorName}" (rank ${floor.rank}) for tiers.${move?.tier}.${move?.role}, found no model, at crew/model-ladder.json tier_floors.${move?.tier}`)
      continue
    }
    const found = bands.get(key)
    if (!found) {
      failures.push(`expected band at or above "${floorName}" (rank ${floor.rank}) for tiers.${move.tier}.${move.role}, found "none" (${key}), at crew/model-ladder.json bands[].members`)
      continue
    }
    if (found.rank < floor.rank) failures.push(`expected band at or above "${floorName}" (rank ${floor.rank}) for tiers.${move.tier}.${move.role}, found "${found.band}" (${key}), at crew/model-ladder.json tier_floors.${move.tier}`)
  }
  return failures.length
    ? check('band_floor', false, failures.join('; '))
    : check('band_floor', true, `all moved seats sit at or above their ratified tier floor in crew/model-ladder.json`)
}

function vendorDiversityCheck(moves, roster, proposalRefusals) {
  const refusals = proposalRefusals.filter((refusal) => refusal.code === 'cross_vendor' || refusal.code === 'judge_vendor_split')
  if (refusals.length) return check('vendor_diversity', false, refusals.map((refusal) => refusal.message).join('; '))
  const failures = []
  for (const tierName of affectedTiers(moves, roster)) {
    const tier = roster.tiers[tierName]
    const reviewer = tier?.reviewer
    const partnerRole = tier?.['tech-lead'] ? 'tech-lead' : (tier?.planner ? 'planner' : null)
    const partner = partnerRole ? tier[partnerRole] : null
    if (reviewer && partner && reviewer.provider === partner.provider) failures.push(`cross-vendor panel invariant failed for ${tierName}: reviewer and ${partnerRole} share provider "${reviewer.provider}"; see crew/roster-refresh.test.mjs:134-141 and #206's fused panel`)
    const judge = tierName === 'judge' ? tier : null
    if (judge?.['tech-lead'] && judge?.planner && judge['tech-lead'].provider === judge.planner.provider) failures.push(`judge tech-lead and planner must use different providers (both use "${judge['tech-lead'].provider}"); see crew/roster-refresh.test.mjs:130-132`)
  }
  if (failures.length) return check('vendor_diversity', false, failures.join('; '))
  const pairs = []
  for (const tierName of affectedTiers(moves, roster)) {
    const tier = roster.tiers[tierName]
    const partnerRole = tier?.['tech-lead'] ? 'tech-lead' : (tier?.planner ? 'planner' : null)
    if (tier?.reviewer && partnerRole && tier[partnerRole]) pairs.push(`${tierName} reviewer/${partnerRole} stayed cross-vendor`)
    if (tierName === 'judge' && tier?.['tech-lead'] && tier?.planner) pairs.push('judge tech-lead/planner stayed vendor-diverse')
  }
  return check('vendor_diversity', true, pairs.length ? pairs.join('; ') : 'reviewer/partner vendor diversity stayed valid for the staged seats')
}

function costCeilingCheck(moves, roster, ladder) {
  if (ladder?.degraded) return check('cost_ceiling', false, ladder.error || 'model ladder is degraded and cannot validate cost ceilings')
  if (!ladder || !record(ladder.cost_ceilings)) return check('cost_ceiling', false, 'model ladder is unavailable and cannot validate cost ceilings, at crew/model-ladder.json')
  const seatedMoves = modelMoves(moves)
  if (!seatedMoves.length) return check('cost_ceiling', true, 'cost ceiling is not applicable to cell:null moves; no model was changed')
  const catalog = record(roster?.models) ? roster.models : {}
  const failures = []
  for (const move of seatedMoves) {
    const key = moveKey(move)
    const ceiling = ladder.cost_ceilings[move?.tier]
    if (!finite(ceiling)) {
      failures.push(`no cost ceiling is ratified for tiers.${move?.tier}.${move?.role}, at crew/model-ladder.json cost_ceilings.${move?.tier}`)
      continue
    }
    if (!key) {
      failures.push(`expected cost_out_per_mtok at or below ${ceiling} for tiers.${move?.tier}.${move?.role}, found no model, at crew/model-ladder.json cost_ceilings.${move?.tier}`)
      continue
    }
    const cost = catalog[key]?.cost_out_per_mtok
    if (!finite(cost)) {
      failures.push(`expected a finite cost_out_per_mtok for tiers.${move.tier}.${move.role}, found none (${key}), at crew/model-ladder.json cost_ceilings.${move.tier}`)
      continue
    }
    if (cost > ceiling) failures.push(`expected cost_out_per_mtok at or below ${ceiling} for tiers.${move.tier}.${move.role}, found ${cost} (${key}), at crew/model-ladder.json cost_ceilings.${move.tier}`)
  }
  return failures.length
    ? check('cost_ceiling', false, failures.join('; '))
    : check('cost_ceiling', true, 'all moved seats stay at or below their ratified cost_out_per_mtok ceiling')
}

function cellLabel(cell) {
  if (!cell) return 'no model cell'
  return `${cell.provider ?? '<missing provider>'}/${cell.model_id ?? cell.id ?? '<missing id>'} · ${cell.agent ?? '<missing agent>'} · ${cell.effort ?? '<missing effort>'}`
}

async function breakerStateCheck({ moves, roster, breaker, readBreaker }) {
  const reader = readBreaker || cellHealth
  const tiers = affectedTiers(moves, roster)
  if (!tiers.length) return check('breaker_state', false, 'breaker state could not be evaluated because no known tier was moved')
  const records = []
  for (const tierName of tiers) {
    const seats = record(roster.tiers[tierName]) ? clone(roster.tiers[tierName]) : {}
    try {
      records.push({ tier: tierName, record: await reader({ policy: breaker?.policy ?? null, seats, dbPath: breaker?.dbPath }) })
    } catch (err) {
      return check('breaker_state', false, `breaker read failed for tiers.${tierName}: ${err?.message || String(err)}; see crew/breaker.mjs`)
    }
  }
  const configuredRecords = records.filter(({ record }) => record != null)
  if (!configuredRecords.length) return check('breaker_state', true, 'breaker not configured — CREW_BREAKER_THRESHOLD is unset, so there is no verdict to read')
  const failures = []
  for (const { tier, record: result } of configuredRecords) {
    const verdict = result?.verdict
    if (verdict === 'open' || verdict === 'unmeasurable') {
      const offending = result?.cells?.find((cell) => cell?.verdict === 'open') || result?.cells?.[0]
      const moved = moves.find((move) => move.tier === tier)
      const label = cellLabel(offending || moved?.cell)
      failures.push(`breaker verdict "${verdict}" for ${label} in tiers.${tier}; see crew/breaker.mjs assertCellsClosed${result?.why ? ` (${result.why})` : ''}`)
    } else if (!['closed', 'degraded', 'not-applicable'].includes(verdict)) {
      failures.push(`breaker verdict "${verdict ?? 'unknown'}" for tiers.${tier} cannot be accepted; see crew/breaker.mjs assertCellsClosed`)
    }
  }
  if (failures.length) return check('breaker_state', false, failures.join('; '))
  return check('breaker_state', true, configuredRecords.map(({ tier, record: result }) => `breaker verdict "${result.verdict}" for tiers.${tier}`).join('; '))
}

export async function stageMoves({ rosterText, rosterPath = 'crew/roster.json', readError = null, moves, ladder, breaker, readBreaker } = {}) {
  const requested = Array.isArray(moves) ? moves : []
  const parsed = parseRosterText(rosterText)
  const beforeTextCanonical = parsed.canonical
  const refusals = []
  let candidate = parsed.roster ? clone(parsed.roster) : null
  if (candidate) for (const move of requested) setMove(candidate, move)
  const afterText = candidate ? repositoryRosterText(candidate, rosterText) : null
  const localAfterText = candidate ? canonicalRosterText(candidate, rosterText, parsed.version) : null

  let evolvingText = rosterText
  for (const move of requested) {
    let result
    try {
      result = await proposeEdit({ rosterText: evolvingText, rosterPath, readError, tier: move?.tier, role: move?.role, cell: move?.cell })
    } catch (err) {
      result = { ok: false, refusals: [{ code: 'proposal_error', message: err?.message || String(err) }] }
    }
    if (!result.ok) {
      refusals.push(...(Array.isArray(result.refusals) ? result.refusals : [{ code: 'proposal_error', message: 'roster proposal was refused' }]))
      continue
    }
    if (parsed.roster) {
      const evolvingRoster = parseRosterText(evolvingText).roster
      setMove(evolvingRoster, move)
      evolvingText = canonicalRosterText(evolvingRoster, evolvingText, parsed.version)
    }
  }

  const checks = []
  checks.push(bandFloorCheck(requested, ladder))
  checks.push(vendorDiversityCheck(requested, candidate, refusals))
  const breakerConfig = breaker || { policy: breakerPolicy(), dbPath: undefined }
  checks.push(await breakerStateCheck({ moves: requested, roster: candidate, breaker: breakerConfig, readBreaker }))
  checks.push(costCeilingCheck(requested, parsed.roster, ladder))
  const ok = refusals.length === 0 && checks.every((entry) => entry.ok)
  const blockingRefusals = localBlockingRefusals(refusals)
  const localApplyAllowed = requested.length > 0 && parsed.roster != null && blockingRefusals.length === 0
  const candidateDiff = localApplyAllowed && afterText != null ? unifiedDiff(rosterText, afterText, { path: 'crew/roster.json' }) : null
  const localCandidateDiff = localApplyAllowed && localAfterText != null ? unifiedDiff(rosterText, localAfterText, { path: 'crew/roster.json' }) : null
  return {
    ok,
    checks,
    refusals,
    blocking_refusals: blockingRefusals,
    local_apply_allowed: localApplyAllowed,
    diff: ok ? candidateDiff : null,
    local_diff: localCandidateDiff,
    before_text_canonical: beforeTextCanonical,
  }
}

function branchSlug(moves, branchSeed) {
  const source = branchSeed != null && branchSeed !== ''
    ? String(branchSeed)
    : (Array.isArray(moves) ? moves : []).map((move) => `${move?.tier || 'tier'}-${move?.role || 'role'}-${moveKey(move) || 'unseat'}`).join('-')
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'moves'
  return `roster/ladder-${slug}`
}

function commitSubject(moves) {
  const targets = (Array.isArray(moves) ? moves : []).map((move) => `${move?.tier}.${move?.role} to ${moveKey(move) || 'unseated'}`)
  return `chore(roster): reseat ${targets.length > 1 ? targets.join(' and ') : (targets[0] || 'staged seats')}`
}

function resultingLineCount(rosterText, moves) {
  const parsed = parseRosterText(rosterText)
  if (!parsed.roster) return null
  for (const move of Array.isArray(moves) ? moves : []) setMove(parsed.roster, move)
  const text = repositoryRosterText(parsed.roster, rosterText)
  if (!text) return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

export async function composeMoves({ rosterText, rosterPath = 'crew/roster.json', readError = null, moves, ladder, breaker, readBreaker, branchSeed } = {}) {
  const result = await stageMoves({ rosterText, rosterPath, readError, moves, ladder, breaker, readBreaker })
  if (!result.ok) return {
    ok: false,
    checks: result.checks,
    refusals: result.refusals,
    patch: null,
    branch: null,
    commit_subject: null,
    roster_after_lines: null,
  }
  return {
    ok: true,
    checks: result.checks,
    refusals: result.refusals,
    patch: result.diff,
    branch: branchSlug(moves, branchSeed),
    commit_subject: commitSubject(moves),
    roster_after_lines: resultingLineCount(rosterText, moves),
  }
}

export async function applyMoves({ rosterText, rosterPath = 'crew/roster.json', readError = null, moves, ladder, breaker, readBreaker, writeRoster, allowWarnings = false } = {}) {
  const result = await stageMoves({ rosterText, rosterPath, readError, moves, ladder, breaker, readBreaker })
  if (!result.ok && (!allowWarnings || !result.local_apply_allowed)) return { ...result, applied:false, changed:false, requires_warning_override:Boolean(result.local_apply_allowed) }
  const parsed = parseRosterText(rosterText)
  if (!parsed.roster) return {
    ...result, ok:false, applied:false, changed:false,
    refusals:[...(result.refusals || []), { code:'roster_unreadable', message:readError || `unable to read roster at ${rosterPath}` }],
  }
  const candidate = clone(parsed.roster)
  for (const move of Array.isArray(moves) ? moves : []) setMove(candidate, move)
  const afterText = canonicalRosterText(candidate, rosterText, parsed.version)
  if (typeof writeRoster !== 'function') return {
    ...result, ok:false, applied:false, changed:false,
    refusals:[...(result.refusals || []), { code:'roster_write', message:`local roster writer unavailable for ${rosterPath}` }],
  }
  const write = await writeRoster({ path:rosterPath, beforeText:rosterText, afterText })
  if (!write?.ok) return {
    ...result, ok:false, applied:false, changed:false,
    refusals:[...(result.refusals || []), { code:write?.conflict ? 'roster_conflict' : 'roster_write', message:write?.error || `could not update ${rosterPath}` }],
  }
  return { ...result, ok:true, policy_ok:result.ok, applied:true, changed:write.changed === true, warnings_overridden:!result.ok }
}
