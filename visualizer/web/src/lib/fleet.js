export const SILENT_AFTER_MS = 30_000
const TOKEN_FIELDS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
export const DEFAULT_FILTERS = Object.freeze({ hide_slugless: true, hide_archived: true })

export function createSemaphore(limit = 1) {
  const maximum = Number.isInteger(limit) && limit > 0 ? limit : 1
  let active = 0
  const waiters = []
  function acquire() {
    if (active < maximum) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  function release() {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }
  return {
    async run(task) {
      await acquire()
      try { return await task() } finally { release() }
    },
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textNumber(value) {
  return value.toLocaleString('en-US')
}

function measuredCell(value, text = String(value)) {
  return { value, text, dashed: false, title: null }
}

function envelopeFor(envelopes, adwId) {
  if (envelopes instanceof Map) return envelopes.get(adwId) || null
  if (envelopes && typeof envelopes === 'object') return envelopes[adwId] || null
  return null
}

export function absenceMark(reason) {
  return { value: null, text: reason || 'not measured', dashed: true, title: reason || null }
}

export function deriveStatus(run = {}, taskEnvelope = null) {
  const escalation = taskEnvelope?.details?.escalation
  if (taskEnvelope?.status === 'escalation') {
    return { key: 'escalated', word: 'escalated', tone: 'serious', where: escalation?.where, why: escalation?.why }
  }
  if (run?.status === 'ok') return { key: 'success', word: 'success', tone: 'ok', where: null, why: null }
  if (run?.status === 'fail') return { key: 'fail', word: 'failed', tone: 'fail', where: null, why: null }
  if (run?.status === 'aborted') return { key: 'aborted', word: 'aborted', tone: 'aborted', where: null, why: null }
  if (run?.running && !run?.phases?.length) return { key: 'queued', word: 'queued', tone: 'quiet', where: null, why: null }
  if (run?.running) return { key: 'running', word: 'running', tone: 'busy', where: null, why: null }
  return { key: 'unknown', word: 'status not recorded', tone: 'quiet', where: null, why: null }
}

function conciseAge(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function runActivity(run = {}, now = Date.now()) {
  if (!run?.running) return { key: 'settled', live: false, attention: false, heartbeat: heartbeatCell(run, now) }
  const heartbeat = heartbeatCell(run, now)
  if (heartbeat.dashed) {
    return {
      key: 'unverified', live: false, attention: true, heartbeat,
      word: 'running · heartbeat unavailable', tone: 'serious',
      why: 'The ledger says this session is running, but this feed does not provide a heartbeat, so live activity cannot be verified.',
    }
  }
  if (heartbeat.stale) {
    const quietFor = conciseAge(heartbeat.age_ms)
    return {
      key: 'silent', live: false, attention: true, heartbeat,
      word: `silent ${quietFor}`, tone: 'serious',
      why: `The session still says running, but its last heartbeat was ${quietFor} ago.`,
    }
  }
  return { key: 'live', live: true, attention: false, heartbeat, word: 'live', tone: 'busy', why: null }
}

export function fleetActivity(runs = [], now = Date.now()) {
  const summary = { live: 0, silent: 0, unverified: 0, open: 0 }
  for (const run of Array.isArray(runs) ? runs : []) {
    const activity = runActivity(run, now)
    if (activity.key === 'live') summary.live += 1
    if (activity.key === 'silent') summary.silent += 1
    if (activity.key === 'unverified') summary.unverified += 1
    if (run?.running) summary.open += 1
  }
  return summary
}

export function deriveDisplayStatus(run = {}, taskEnvelope = null, now = Date.now()) {
  const recorded = deriveStatus(run, taskEnvelope)
  if (!['running', 'queued'].includes(recorded.key)) return recorded
  const activity = runActivity(run, now)
  if (activity.key === 'silent' || activity.key === 'unverified') {
    return { key: activity.key, word: activity.word, tone: activity.tone, where: 'heartbeat', why: activity.why }
  }
  return recorded
}

export function heartbeatCell(run = {}, now = Date.now()) {
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
  if (total == null) return absenceMark(run?.pending?.billed_input_tokens)
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

export function costCell(run = {}) {
  const reason = run?.pending?.billed_cost_usd
  if (run?.transport === 'pane' || (typeof reason === 'string' && /subscription seat/i.test(reason))) {
    return absenceMark('not measured · pane')
  }
  return absenceMark(reason)
}

export function gateCell(run = {}) {
  const generations = Array.isArray(run?.gate_generations) ? run.gate_generations : []
  if (!generations.length) return absenceMark(run?.pending?.gate_discrimination)
  const newest = [...generations].sort((a, b) => (a?.gate_generation ?? 0) - (b?.gate_generation ?? 0)).at(-1)
  const verdict = ['proven', 'failed', 'unproven'].includes(newest?.verdict) ? newest.verdict : 'unproven'
  return { ...measuredCell(verdict, verdict), verdict, generation: newest?.gate_generation ?? null }
}

export function reviewCell(run = {}) {
  const reviews = Array.isArray(run?.reviews) ? run.reviews : []
  if (!reviews.length) return absenceMark(run?.pending?.reviews)
  const last = reviews.at(-1)
  const round = reviews.length
  const bounces = reviews.filter((review) => review?.verdict === 'changes-needed').length
  const verdict = last?.verdict ?? null
  const text = `${verdict ?? 'status not recorded'} · round ${round} · ${bounces} bounce${bounces === 1 ? '' : 's'}`
  return { ...measuredCell(verdict, text), verdict, round, bounces }
}

export function tierCell(run = {}) {
  if (run?.tier == null) return absenceMark(run?.pending?.tier)
  return measuredCell(run.tier, String(run.tier))
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

function visibleRows(runs, envelopes, now, filters) {
  return (Array.isArray(runs) ? runs : []).filter((run) => {
    if (filters.hide_slugless && !run?.goal) return false
    if (filters.hide_archived && run?.triage?.reviewed_at) return false
    return true
  }).map((run) => {
    const status = deriveStatus(run, envelopeFor(envelopes, run.adw_id))
    return {
      adw_id: run.adw_id,
      run_label: run.goal || run.adw_id || 'Untitled run',
      status,
      tier: tierCell(run),
      gate: gateCell(run),
      review: reviewCell(run),
      duration: durationCell(run),
      tokens: tokenCell(run),
      cost: costCell(run),
      heartbeat: heartbeatCell(run, now),
    }
  })
}

export function fleetView(runs, { envelopes = new Map(), now = Date.now(), filters } = {}) {
  const selected = { ...DEFAULT_FILTERS, ...(filters || {}) }
  const source = Array.isArray(runs) ? runs : []
  const rows = visibleRows(source, envelopes, now, selected)
  const hiddenCount = source.length - rows.length
  const hidden = {
    count: hiddenCount,
    line: hiddenCount === 0 ? '' : `${hiddenCount} row${hiddenCount === 1 ? '' : 's'} hidden by the default filter (slug-less or archived)`,
  }
  const escalated = rows.filter((row) => row.status.key === 'escalated')
    .map((row) => ({ ...row, why: row.status.why }))
  const silent = rows.filter((row) => row.status.key === 'running' && row.heartbeat.stale && row.status.key !== 'escalated')
    .map((row) => ({ ...row, why: row.heartbeat.text }))
  return { rows, rail: [...escalated, ...silent], hidden, shown: rows.length }
}

export function escalationProbeTargets(rows = []) {
  const targets = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const run = row?.run && typeof row.run === 'object' ? row.run : row
    const slug = run?.goal ?? run?.task_slug
    const status = typeof run?.status === 'object' ? run.status.key : run?.status
    if (!run?.repo_slug || !slug || status === 'ok' || status === 'success' || run?.adw_id == null || seen.has(run.adw_id)) continue
    seen.add(run.adw_id)
    targets.push(run.adw_id)
  }
  return targets
}
