import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { VARIANTS } from '../../crew/variants.mjs'
import { unifiedDiff } from './roster-edit.mjs'

export const DEFAULT_RECENT_RUNS = 5
export const WORKFLOW_FEED_REASONS = Object.freeze(['feed-unmeasured', 'feed-unavailable'])
const SAFE_WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (value === undefined) return undefined
  return structuredClone(value)
}

function errorText(path, err, fallback = 'unknown read error') {
  const code = err?.code ? `${err.code}: ` : ''
  return `${code}${err?.message || fallback}, at ${path}`
}

function readJson(path, { label = 'JSON' } = {}) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { text: null, value: null, error: errorText(path, err), code: err?.code || 'unknown' }
  }
  if (text.trim() === '') return { text, value: null, error: `${label} file is empty, at ${path}`, code: 'EMPTY' }
  try {
    return { text, value: JSON.parse(text), error: null, code: null }
  } catch (err) {
    return { text, value: null, error: `malformed ${label}: ${err?.message || 'invalid JSON'}, at ${path}`, code: 'JSON' }
  }
}

function readRoster(path) {
  const result = readJson(path, { label: 'roster' })
  if (result.error) return { ...result, tiers: [], error: result.error }
  if (!record(result.value) || !record(result.value.tiers)) {
    return { ...result, tiers: [], error: `roster must contain a JSON object with a tiers object, at ${path}` }
  }
  const tiers = Object.entries(result.value.tiers).map(([tier, cells]) => ({
    tier,
    cells: record(cells) ? clone(cells) : null,
    measured: record(cells),
    error: record(cells) ? null : `tier ${tier} is not a JSON object, at ${path}`,
  }))
  return { ...result, tiers, error: null }
}

function normalizeSeat(role, value) {
  if (value === null) return null
  if (!record(value)) return null
  const output = {}
  for (const field of ['provider', 'id', 'agent', 'effort']) {
    if (Object.prototype.hasOwnProperty.call(value, field)) output[field] = clone(value[field])
  }
  for (const field of ['skills', 'extensions']) {
    if (Object.prototype.hasOwnProperty.call(value, field)) output[field] = clone(value[field])
  }
  if (Object.prototype.hasOwnProperty.call(value, 'model')) output.model = clone(value.model)
  else if (output.provider != null && output.id != null) output.model = `${output.provider}/${output.id}`
  if (Object.keys(output).length === 0) return { role }
  return output
}

function normalizeSeats(seats) {
  if (!record(seats)) return null
  return Object.fromEntries(Object.entries(seats).map(([role, value]) => [role, normalizeSeat(role, value)]))
}

function mapShape(value, shape, path) {
  if (!record(value)) return { value: null, error: `workflow map must be a JSON object, at ${path}` }
  if (value.shape !== undefined && value.shape !== shape) return { value: null, error: `workflow map shape must be ${shape}, at ${path}` }
  const seats = normalizeSeats(value.seats)
  if (!seats) return { value: null, error: `workflow map must contain a seats object, at ${path}` }
  return { value: { shape, seats }, error: null }
}

function readWorkflowMaps(directory, declarations) {
  const maps = new Map()
  const errors = new Map()
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT') return { maps, errors, absent: true, error: null }
    return { maps, errors, absent: false, error: errorText(directory, err, 'unable to read workflow maps') }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const shape = entry.name.slice(0, -'.json'.length)
    if (!Object.prototype.hasOwnProperty.call(declarations, shape)) continue
    const path = join(directory, entry.name)
    const result = readJson(path, { label: 'workflow map' })
    if (result.error) { errors.set(shape, result.error); continue }
    const materialized = mapShape(result.value, shape, path)
    if (materialized.error) errors.set(shape, materialized.error)
    else maps.set(shape, { ...materialized.value, path })
  }
  return { maps, errors, absent: false, error: null }
}

function rosterTierMap(tier) {
  if (!tier?.measured || !record(tier.cells)) return null
  return normalizeSeats(tier.cells)
}

function stageName(value) {
  if (!record(value)) return typeof value === 'string' ? value : null
  return value.name ?? value.stage ?? value.label ?? null
}

function stageOutcome(value) {
  if (!record(value)) return null
  return value.outcome ?? value.status ?? value.verdict ?? null
}

function runTimestamp(run) {
  const value = run?.started_at ?? run?.created_at ?? run?.ended_at ?? run?.at ?? null
  const parsed = value == null ? NaN : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function runShape(run) {
  return run?.execution_shape
    ?? run?.variant
    ?? run?.configuration?.execution?.effective
    ?? run?.configuration?.execution_shape
    ?? null
}

function shapeBootSeats(seats) {
  if (Array.isArray(seats)) return Object.fromEntries(seats.filter((seat) => record(seat) && typeof seat.role === 'string').map((seat) => [seat.role, clone(seat)]))
  if (record(seats)) return clone(seats)
  return null
}

function observedRun(run) {
  const phases = Array.isArray(run?.phases) ? run.phases : Array.isArray(run?.stages) ? run.stages : []
  const stages = phases.map((phase) => {
    const label = stageName(phase)
    return {
      label,
      stage: typeof label === 'string' ? label.split(':')[0] : null,
      duration_ms: phase?.duration_ms ?? null,
      outcome: stageOutcome(phase),
      started_at: phase?.started_at ?? null,
      ended_at: phase?.ended_at ?? null,
    }
  }).filter((stage) => typeof stage.label === 'string' && stage.label.length > 0)
  const labels = stages.map((stage) => stage.label)
  if (Array.isArray(run?.observed_labels)) labels.push(...run.observed_labels.filter((label) => typeof label === 'string'))
  if (Array.isArray(run?.journal_labels)) labels.push(...run.journal_labels.filter((label) => typeof label === 'string'))
  if (Array.isArray(run?.observed)) labels.push(...run.observed.map(stageName).filter((label) => typeof label === 'string'))
  if (Array.isArray(run?.journal)) labels.push(...run.journal.map(stageName).filter((label) => typeof label === 'string'))
  return {
    run_id: run?.adw_id ?? run?.run_id ?? null,
    shape: runShape(run),
    started_at: run?.started_at ?? null,
    ended_at: run?.ended_at ?? null,
    outcome: run?.settlement?.outcome ?? run?.outcome ?? run?.status ?? null,
    labels: [...new Set(labels)],
    stages,
    boot_seats: shapeBootSeats(run?.seats),
  }
}

function readObserved(feed, limit) {
  if (!feed || typeof feed.listRuns !== 'function') {
    return { measured: false, runs: [], recent: [], reason: 'feed-unavailable', error: 'workflow evidence is unavailable because the feed has no listRuns reader' }
  }
  let result
  try { result = feed.listRuns() } catch (err) {
    return { measured: false, runs: [], recent: [], reason: 'feed-unavailable', error: `workflow evidence read failed: ${err?.message || String(err)}` }
  }
  const rawRuns = Array.isArray(result?.runs) ? result.runs : null
  if (result?.degraded === true || typeof result?.absent === 'string' || rawRuns === null) {
    const reason = result?.absent || 'the ledger did not provide workflow runs'
    return { measured: false, runs: [], recent: [], reason: 'feed-unavailable', error: reason }
  }
  const observed = rawRuns.map(observedRun).sort((left, right) => runTimestamp(right) - runTimestamp(left))
  const recent = observed.slice(0, limit)
  if (observed.length === 0) return { measured: false, runs: [], recent, reason: 'feed-unmeasured', error: 'the ledger contains no workflow runs' }
  return { measured: true, runs: observed, recent, reason: null, error: null }
}

function firstBootSeats(observed) {
  return observed[0]?.boot_seats ?? null
}

function declarationRows(declarations) {
  return Object.entries(declarations).map(([shape, declaration]) => ({ shape, declaration: clone(declaration) }))
}

function proposalRefusal(code, message) {
  return { code, message }
}

function safeWorkflowPath(root, shape) {
  const relativePath = `crew/workflows/${shape}.json`
  const path = resolve(root, relativePath)
  if (path !== resolve(root) && !path.startsWith(`${resolve(root)}/`)) return null
  return { path, relativePath }
}

function readBefore(path) {
  try {
    const before = readFileSync(path, 'utf8')
    return before.trim() === '' ? { before, error: `workflow map file is empty, at ${path}` } : { before, error: null }
  } catch (err) {
    if (err?.code === 'ENOENT') return { before: '', error: null }
    return { before: null, error: errorText(path, err, 'unable to read workflow map') }
  }
}

function roleForStage(stage) {
  const table = {
    plan: 'planner', check: 'planner', scout: 'planner', repair: 'planner',
    build: 'builder', review: 'reviewer', review_only: 'reviewer', verify_only: 'reviewer',
  }
  return table[stage] || null
}

function canonicalWorkflowBefore(before, shape, fallbackSeats) {
  if (before.trim() !== '') {
    try {
      const parsed = JSON.parse(before)
      const mapped = mapShape(parsed, shape, 'workflow map')
      if (!mapped.error) return mapped.value
      return { error: mapped.error }
    } catch (err) {
      return { error: `malformed workflow map: ${err?.message || 'invalid JSON'}` }
    }
  }
  return { shape, seats: normalizeSeats(fallbackSeats) || {} }
}

export async function proposeWorkflowEdit({ root = process.cwd(), variants = VARIANTS, rosterPath, workflow, edit, tier: requestedTier } = {}) {
  const declarations = record(variants) ? variants : VARIANTS
  const shape = typeof workflow === 'string' ? workflow : workflow?.shape
  const refusals = []
  if (typeof shape !== 'string' || !Object.prototype.hasOwnProperty.call(declarations, shape) || !SAFE_WORKFLOW_NAME.test(shape)) {
    refusals.push(proposalRefusal('shape', 'workflow shape must be a declared safe name'))
  }
  const inputEdit = record(edit) ? edit : null
  if (!inputEdit) refusals.push(proposalRefusal('edit', 'workflow edit must be an object'))
  const declaration = shape && declarations[shape]
  const stage = inputEdit?.stage ?? null
  const stageHead = typeof stage === 'string' ? stage.split(':')[0] : stage
  if (stage !== null && (!Array.isArray(declaration?.stages) || !declaration.stages.includes(stageHead))) refusals.push(proposalRefusal('stage', `stage ${JSON.stringify(stage)} is not declared by ${shape}`))
  if (inputEdit && Object.prototype.hasOwnProperty.call(inputEdit, 'cell') && inputEdit.cell !== null && !record(inputEdit.cell)) refusals.push(proposalRefusal('cell', 'workflow cell must be an object or null'))
  const name = shape && SAFE_WORKFLOW_NAME.test(shape) ? safeWorkflowPath(root, shape) : null
  if (!name) refusals.push(proposalRefusal('path', 'workflow path is not safe'))
  if (refusals.length) return { ok: false, refusals, diff: null, workflow_path: name?.relativePath ?? null, before: null, after: null }

  const rosterFile = resolve(rosterPath ? (isAbsolute(rosterPath) ? rosterPath : join(root, rosterPath)) : join(root, 'crew', 'roster.json'))
  const roster = readRoster(rosterFile)
  const suppliedWorkflow = record(workflow) ? workflow : null
  const suppliedSeats = suppliedWorkflow && Object.prototype.hasOwnProperty.call(suppliedWorkflow, 'seats') ? suppliedWorkflow.seats : undefined
  if (roster.error && suppliedSeats === undefined) return { ok: false, refusals: [proposalRefusal('read-error', roster.error)], diff: null, workflow_path: name.relativePath, before: null, after: null }
  const tier = requestedTier === undefined ? roster.tiers[0] : roster.tiers.find((row) => row?.tier === requestedTier)
  if (!tier) return { ok: false, refusals: [proposalRefusal('tier', 'workflow tier must name an available roster tier')], diff: null, workflow_path: name.relativePath, before: null, after: null }
  if (!tier?.measured) return { ok: false, refusals: [proposalRefusal('tier-unmeasured', 'selected tier is unmeasured')], diff: null, workflow_path: name.relativePath, before: null, after: null }
  const beforeRead = readBefore(name.path)
  if (beforeRead.error) return { ok: false, refusals: [proposalRefusal('read-error', beforeRead.error)], diff: null, workflow_path: name.relativePath, before: null, after: null }
  const baseline = canonicalWorkflowBefore(beforeRead.before, shape, suppliedSeats === undefined ? tier.cells : suppliedSeats)
  if (baseline.error) return { ok: false, refusals: [proposalRefusal('workflow-map', baseline.error)], diff: null, workflow_path: name.relativePath, before: beforeRead.before, after: null }
  const seats = normalizeSeats(baseline.seats) || {}
  const role = inputEdit.role || (stageHead ? roleForStage(stageHead) : null)
  if (typeof role !== 'string' || !role) return { ok: false, refusals: [proposalRefusal('role', 'workflow seat edits require a role or seat-bearing stage')], diff: null, workflow_path: name.relativePath, before: beforeRead.before, after: null }
  if (!Object.prototype.hasOwnProperty.call(inputEdit, 'cell')) return { ok: false, refusals: [proposalRefusal('cell', 'workflow seat edits require a cell')], diff: null, workflow_path: name.relativePath, before: beforeRead.before, after: null }
  seats[role] = normalizeSeat(role, inputEdit.cell)
  const after = `${JSON.stringify({ shape, seats }, null, 2)}\n`
  const before = beforeRead.before
  const relativePath = name.relativePath
  const diff = unifiedDiff(before, after, { path: relativePath })
  return { ok: true, refusals: [], diff, workflow_path: relativePath, before, after }
}

export function createWorkflowsSource({ root = process.cwd(), feed = null, variants = VARIANTS, rosterPath, docsPath, defaultRecentRuns = DEFAULT_RECENT_RUNS } = {}) {
  const checkout = resolve(root)
  const declarations = record(variants) ? variants : VARIANTS
  const rosterFile = resolve(rosterPath ? (isAbsolute(rosterPath) ? rosterPath : join(checkout, rosterPath)) : join(checkout, 'crew', 'roster.json'))
  const mapsDirectory = join(checkout, 'crew', 'workflows')
  const docsFile = resolve(docsPath ? (isAbsolute(docsPath) ? docsPath : join(checkout, docsPath)) : join(checkout, 'visualizer', 'web', 'src', 'lib', 'stage-docs.json'))

  function readWorkflows(input = {}) {
    const recent = typeof input === 'number' ? input : input?.recent ?? input?.limit ?? defaultRecentRuns
    const parsedLimit = Number.isSafeInteger(Number(recent)) && Number(recent) >= 0 ? Number(recent) : defaultRecentRuns
    const roster = readRoster(rosterFile)
    const maps = readWorkflowMaps(mapsDirectory, declarations)
    const docs = readJson(docsFile, { label: 'stage documentation' })
    if (!docs.error && !record(docs.value)) docs.error = `stage documentation must be a JSON object, at ${docsFile}`
    const evidence = readObserved(feed, parsedLimit)
    const tiers = roster.tiers.map((tier) => ({ tier: tier.tier, measured: tier.measured, seats: tier.measured ? normalizeSeats(tier.cells) : null, error: tier.error }))
    const defaultTier = tiers[0]?.tier ?? null
    const rows = declarationRows(declarations).map(({ shape, declaration }) => {
      const mapError = maps.errors.get(shape) || maps.error || roster.error || null
      const explicit = maps.maps.get(shape) || null
      const defaultSeats = rosterTierMap(roster.tiers[0])
      const map = explicit ? { shape, seats: explicit.seats } : mapError || defaultSeats === null ? null : { shape, seats: defaultSeats }
      const source = explicit ? 'workflow-map' : 'roster-default'
      const shapeRuns = evidence.runs.filter((run) => run.shape === shape)
      const recentRuns = shapeRuns.slice(0, parsedLimit)
      return {
        shape,
        declaration,
        map,
        seats: map?.seats ?? null,
        source,
        tier: defaultTier,
        tier_maps: Object.fromEntries(tiers.map((tier) => [tier.tier, { shape, seats: tier.seats } ])),
        map_measured: Boolean(map && !mapError),
        map_status: map && !mapError ? 'measured' : 'unmeasured',
        map_error: mapError,
        map_evidence: { measured: Boolean(map && !mapError), error: mapError },
        observed_labels: [...new Set(shapeRuns.flatMap((run) => run.labels))],
        recent_runs: recentRuns,
        boot_seats: firstBootSeats(shapeRuns),
        evidence: {
          measured: evidence.measured && shapeRuns.length > 0,
          recent_runs: recentRuns,
          reason: !evidence.measured ? evidence.reason : shapeRuns.length === 0 ? 'no-runs-for-shape' : null,
          error: evidence.error,
        },
      }
    })
    const mapErrors = [...maps.errors.values()]
    const evidenceError = evidence.reason === 'feed-unavailable' ? evidence.error : null
    const degraded = Boolean(roster.error || maps.error || mapErrors.length || docs.error || evidenceError)
    const errors = [roster.error, maps.error, ...mapErrors, docs.error, evidenceError].filter(Boolean)
    return {
      degraded,
      error: errors[0] || null,
      roster: { path: rosterFile, measured: !roster.error, error: roster.error, tiers },
      docs: docs.error ? null : docs.value,
      docs_error: docs.error,
      declarations: rows.map(({ shape, declaration }) => ({ shape, declaration })),
      shapes: rows.map(({ shape, declaration }) => ({ shape, declaration })),
      workflows: rows,
      maps: Object.fromEntries(rows.map((row) => [row.shape, row.map])),
      evidence: {
        measured: evidence.measured,
        reason: evidence.reason,
        error: evidence.error,
        recent_runs: evidence.recent,
        runs: evidence.runs,
      },
      recent: parsedLimit,
    }
  }

  async function propose(input) {
    return proposeWorkflowEdit({ root: checkout, variants: declarations, rosterPath: rosterFile, ...(input || {}) })
  }

  return {
    readWorkflows,
    getWorkflows: readWorkflows,
    proposeWorkflow: propose,
    propose,
  }
}

export const proposeWorkflow = proposeWorkflowEdit
