import { assuranceMeta, executionMeta, taskProfileMeta } from './workflow-semantics.js'

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
function newestFirst(runs = []) {
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

const STATUS = Object.freeze({
  running: { key: 'running', tone: 'busy' }, reviewed: { key: 'running', tone: 'busy' },
  done: { key: 'success', tone: 'ok' }, stopped: { key: 'aborted', tone: 'aborted' },
  'ready-for-operator': { key: 'ready', tone: 'serious', word: 'ready for operator' },
  returned: { key: 'returned', tone: 'serious', word: 'returned · no new run' },
  escalated: { key: 'escalated', tone: 'serious' }, abandoned: { key: 'abandoned', tone: 'serious' },
})

// A lean "running" is an open journal, not a measured live process.
export function leanStatus(run = {}) {
  const status = typeof run.status === 'string' ? run.status : 'unknown'
  const meta = Object.hasOwn(STATUS, status) ? STATUS[status] : null
  const key = meta?.key ?? 'unknown'
  const open = status === 'running' || status === 'reviewed'
  const word = status === 'running' ? 'open · no terminal record' : status === 'unknown' ? 'status not recorded' : status === 'done' && run.hand_finished === true ? 'done · hand-finished' : meta?.word ?? status
  const why = typeof run.reason === 'string' && run.reason ? run.reason : null
  return { key, word, tone: meta?.tone ?? 'quiet', where: null, why, open }
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

const ATTENTION_SEGMENT_LABELS = Object.freeze({
  ready: 'ready for operator', returned: 'returned', escalated: 'escalated', aborted: 'stopped', abandoned: 'abandoned',
})
const ATTENTION_KEYS = Object.keys(ATTENTION_SEGMENT_LABELS)
export function needsAttention(key) { return ATTENTION_KEYS.includes(key) }

export function attentionBreakdown(rows = []) {
  const counts = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row?.status?.key
    if (needsAttention(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const segments = ATTENTION_KEYS.map((key) => ({ key, label: ATTENTION_SEGMENT_LABELS[key], count: counts.get(key) ?? 0 }))
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  const text = segments.filter((segment) => segment.count > 0).map((segment) => `${segment.count} ${segment.label}`).join(' · ')
  return { total, segments, text }
}

export function taskBoard(runs = [], { state = 'all', query = '', showArchived = false } = {}) {
  const visible = newestFirst(runs).filter((run) => showArchived || run.archived !== true)
  const predicates = {
    all: () => true,
    open: (run) => run.running === true,
    finished: (run) => run.running !== true && leanStatus(run).key !== 'unknown',
    attention: (run) => needsAttention(leanStatus(run).key),
  }
  const counts = Object.fromEntries(Object.entries(predicates).map(([key, predicate]) => [key, visible.filter(predicate).length]))
  const needle = query.trim().toLowerCase()
  const rows = visible.filter(predicates[state] ?? predicates.all).filter((run) =>
    !needle || [run.goal, run.repo_slug, run.adw_id, run.status, run.tier, run.shape, run.latest_stage].some((value) => String(value ?? '').toLowerCase().includes(needle)))
  return { counts, rows }
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
