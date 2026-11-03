import { assuranceMeta, executionMeta, taskProfileMeta } from './workflow-semantics.js'

const SILENT_AFTER_MS = 30_000
const TOKEN_FIELDS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textNumber(value) {
  return value.toLocaleString('en-US')
}

function measuredCell(value, text = String(value)) {
  return { value, text, dashed: false, title: null }
}

function absenceMark(reason) {
  return { value: null, text: reason || 'not measured', dashed: true, title: reason || null }
}

const CONFIGURATION_DIMENSIONS = Object.freeze([
  { key: 'task_profile', label: 'Profile', meta: taskProfileMeta },
  { key: 'execution_shape', label: 'Execution', meta: executionMeta },
  { key: 'assurance', label: 'Assurance', meta: assuranceMeta },
])

function recordedConfigurationValue(run = {}, dimension) {
  const value = run?.[dimension]
  return typeof value === 'string' && value.trim() ? value : null
}

function boardConfigurationValue(run, dimension) {
  if (run?.source === 'lean') {
    if (dimension === 'assurance') return run.tier ? assuranceMeta(run.tier).key : null
    if (dimension === 'execution_shape') return recordedConfigurationValue(run, 'shape')
  }
  return recordedConfigurationValue(run, dimension)
}

function configurationDimensionDescriptor(source, descriptor) {
  const values = [...new Set(source.map((run) => boardConfigurationValue(run, descriptor.key)).filter((value) => value !== null))].sort()
  if (values.length === 0) return []
  return [{ key: descriptor.key, label: descriptor.label, options: values.map((value) => ({ value, label: descriptor.meta(value).label })) }]
}

export function configurationDimensionCell(run = {}, dimension) {
  const descriptor = CONFIGURATION_DIMENSIONS.find((candidate) => candidate.key === dimension)
  const value = descriptor ? boardConfigurationValue(run, descriptor.key) : null
  if (value === null) return absenceMark('Not recorded')
  const meta = descriptor.meta(value)
  return { ...measuredCell(value, meta.label), key: value, summary: meta.summary ?? null }
}

// The task board lists the newest start first; a run with no parseable started_at keeps its feed order after the rest.
export function newestFirst(runs = []) {
  const started = (run) => { const ms = Date.parse(run?.started_at); return Number.isFinite(ms) ? ms : null }
  return (Array.isArray(runs) ? runs : []).map((run, index) => ({ run, index, ms: started(run) }))
    .sort((a, b) => (a.ms === null) - (b.ms === null) || (b.ms ?? 0) - (a.ms ?? 0) || a.index - b.index)
    .map(({ run }) => run)
}

export function configurationFilterView(runs = [], selections = {}) {
  const source = Array.isArray(runs) ? runs : []
  const dimensions = CONFIGURATION_DIMENSIONS.flatMap((descriptor) => configurationDimensionDescriptor(source, descriptor))
  const rows = source.filter((run) => CONFIGURATION_DIMENSIONS.every((descriptor) => {
    const selection = selections?.[descriptor.key]
    if (!selection || selection === 'all') return true
    const value = boardConfigurationValue(run, descriptor.key)
    if (value === null) return true
    return value === selection
  }))
  const count = source.length - rows.length
  const excluded = {
    count,
    line: count === 0 ? '' : `${count} measured row${count === 1 ? '' : 's'} excluded by configuration filters · not-recorded rows remain visible`,
  }
  return { dimensions, rows, excluded }
}

const TONES = { running: 'busy', reviewed: 'busy', done: 'ok', stopped: 'aborted' }
const KEYS = { running: 'running', reviewed: 'running', done: 'success', stopped: 'aborted' }

// A lean "running" is an open journal, not a measured live process.
export function leanStatus(run = {}) {
  const status = typeof run.status === 'string' ? run.status : 'unknown'
  const key = KEYS[status] ?? 'unknown'
  const open = status === 'running' || status === 'reviewed'
  const word = status === 'running' ? 'open · no terminal record' : status === 'unknown' ? 'status not recorded' : status === 'done' && run.hand_finished === true ? 'done · hand-finished' : status
  const why = typeof run.reason === 'string' && run.reason ? run.reason : null
  return { key, word, tone: TONES[status] ?? 'quiet', where: null, why, open }
}

const SHIP_STATUS_META = Object.freeze({
  merged: Object.freeze({ key:'merged', word:'shipped', tone:'ok' }),
  open: Object.freeze({ key:'open', word:'open', tone:'busy' }),
  'closed-unmerged': Object.freeze({ key:'closed-unmerged', word:'closed', tone:'fail' }),
  unpublished: Object.freeze({ key:'unpublished', word:'unpublished', tone:'quiet' }),
  'not-applicable': Object.freeze({ key:'not-applicable', word:'not applicable', tone:'quiet' }),
  unmeasured: Object.freeze({ key:'unmeasured', word:'not measured', tone:'quiet' }),
})

export function shipStatus(run = {}) {
  const ship = run?.ship
  const meta = SHIP_STATUS_META[ship?.state]
  const reason = typeof ship?.reason === 'string' && ship.reason.trim() ? ship.reason : null
  if (!meta || reason === null) return { key:'unmeasured', word:'not measured', tone:'quiet', reason:'ship state not measured' }
  return { ...meta, reason: ship.stale === true ? `${reason} (cached ship state is stale.)` : reason }
}

function driverObservation(run = {}) {
  const runtime = run?.runtime && typeof run.runtime === 'object' ? run.runtime : {}
  const state = ['alive', 'gone', 'unknown'].includes(runtime.driver_state) ? runtime.driver_state : 'unknown'
  const source = typeof runtime.source === 'string' && runtime.source.trim() ? runtime.source : null
  const reason_code = typeof runtime.reason_code === 'string' && runtime.reason_code.trim() ? runtime.reason_code : null
  return {
    state,
    source,
    reason_code,
    observed_at: runtime.observed_at ?? null,
    measured: source !== null,
    text: source === null ? 'not observed' : `${state} · ${source}`,
  }
}

// #953 · TL7 — ONE list of the status keys that mean an operator must look at this run. It
// was hard-coded in App.svelte:52 and TaskList.svelte:25,:57, which is exactly how a key
// minted in this module reaches neither. Those two consumers ask this predicate.
const ATTENTION_KEYS = Object.freeze(['escalated', 'fail', 'aborted', 'silent', 'unverified', 'gone', 'contradicted'])
export function needsAttention(statusKey) { return ATTENTION_KEYS.includes(statusKey) }

const ATTENTION_SEGMENT_LABELS = Object.freeze({
  escalated: 'escalated',
  fail: 'failed',
  aborted: 'aborted',
  silent: 'stale',
  unverified: 'unverified',
  gone: 'gone',
  contradicted: 'contradicted',
})

export function attentionBreakdown(rows = []) {
  const counts = new Map()
  let total = 0
  let unattributed = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row?.status?.key
    if (!needsAttention(key)) continue
    total += 1
    const label = ATTENTION_SEGMENT_LABELS[key]
    if (!label) { unattributed += 1; continue }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const segments = ATTENTION_KEYS.filter((key) => ATTENTION_SEGMENT_LABELS[key]).map((key) => ({ key, label: ATTENTION_SEGMENT_LABELS[key], count: counts.get(key) ?? 0 }))
  const parts = segments.filter((segment) => segment.count > 0).map((segment) => `${segment.count} ${segment.label}`)
  if (unattributed > 0) parts.push(`${unattributed} unattributed`)
  return { total, segments, unattributed, text: parts.join(' · ') }
}

function runActivityResult(key, values) {
  return { key, ...values, attention: needsAttention(key) }
}

export function runActivity(run = {}) {
  const open = run.running === true
  return runActivityResult(open ? 'journal-open' : 'settled', { live: false, heartbeat: heartbeatCell(run, 0), driver: driverObservation(run), word: open ? 'journal open · liveness not measured' : 'settled', tone: 'quiet', why: open ? (run.pending?.last_heartbeat_at ?? 'lean lanes record no heartbeat') : null })
}

export function fleetActivity(runs = [], now = Date.now()) {
  const summary = { live: 0, silent: 0, contradicted: 0, unverified: 0, gone: 0, open: 0 }
  for (const run of Array.isArray(runs) ? runs : []) {
    const activity = runActivity(run, now)
    if (activity.key === 'live') summary.live += 1
    if (activity.key === 'silent') summary.silent += 1
    // #953 · TL7 — counted ONCE, in its own bucket. Round 7 incremented `silent` too, and
    // every consumer that counts `silent` calls the row a stale heartbeat.
    if (activity.key === 'contradicted') summary.contradicted += 1
    if (activity.key === 'unverified') summary.unverified += 1
    if (activity.key === 'gone') summary.gone += 1
    if (run?.running) summary.open += 1
  }
  return summary
}

export function deriveDisplayStatus(run = {}) {
  return leanStatus(run)
}

function heartbeatCell(run = {}, now = Date.now()) {
  let age = finiteNumber(run?.heartbeat_age_ms)
  if (age == null && run?.last_heartbeat_at != null) {
    const timestamp = Date.parse(String(run.last_heartbeat_at))
    if (Number.isFinite(timestamp) && Number.isFinite(now)) age = now - timestamp
  }
  if (age == null) return absenceMark(run?.pending?.last_heartbeat_at)
  const seconds = Math.round(age / 1000)
  if (age <= SILENT_AFTER_MS) return { text: `${seconds}s ago`, stale: false, dashed: false, age_ms: age }
  return { text: `silent ${seconds}s`, stale: true, dashed: false, age_ms: age }
}

export function tokenCell(run = {}) {
  const metrics = run?.metrics ?? run ?? {}
  let total = null
  for (const field of TOKEN_FIELDS) {
    const value = metrics?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) total = (total ?? 0) + value
  }
  if (total == null) return absenceMark(run?.pending?.billed_input_tokens ?? run?.pending?.tokens ?? 'not measured')
  const input = finiteNumber(metrics?.billed_input_tokens)
  const output = finiteNumber(metrics?.billed_output_tokens)
  const cacheWrite = finiteNumber(metrics?.billed_cache_write_tokens)
  const cacheRead = finiteNumber(metrics?.billed_cache_read_tokens)
  const promptMeasured = [input, cacheWrite, cacheRead].every((value) => value != null)
  const promptTotal = promptMeasured ? input + cacheWrite + cacheRead : null
  const cacheRate = promptTotal > 0 ? cacheRead / promptTotal * 100 : null
  return {
    ...measuredCell(total, textNumber(total)),
    input,
    output,
    cacheWrite,
    cacheRead,
    promptTotal,
    cacheRate,
    cachePending: cacheRate == null ? (run?.pending?.billed_cache_read_tokens || 'prompt cache usage was not measured') : null,
  }
}

export function durationCell(run = {}) {
  const duration = finiteNumber(run?.duration_ms)
  if (duration == null) return absenceMark(run?.pending?.duration_ms)
  const seconds = Math.max(0, Math.round(duration / 1000))
  if (seconds < 60) return measuredCell(duration, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return measuredCell(duration, `${minutes}m ${seconds % 60}s`)
  return measuredCell(duration, `${Math.floor(minutes / 60)}h ${minutes % 60}m`)
}
