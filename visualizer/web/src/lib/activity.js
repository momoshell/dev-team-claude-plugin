import { deriveDisplayStatus, needsAttention, tokenCell } from './fleet.js'

export const ACTIVITY_PERIODS = Object.freeze([
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: 'all', label: 'All history' },
])
export const OUTCOMES = Object.freeze([
  { key: 'success', label: 'Succeeded', tone: 'ok' },
  { key: 'escalated', label: 'Escalated', tone: 'serious' },
  { key: 'fail', label: 'Failed', tone: 'fail' },
  { key: 'aborted', label: 'Aborted', tone: 'aborted' },
  { key: 'open', label: 'Open', tone: 'busy' },
  { key: 'unknown', label: 'Unknown', tone: 'quiet' },
])
const terminal = new Set(['success', 'escalated', 'fail', 'aborted'])
const day = 86400000
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

// A start-time cohort, not a stream of completion events. All widgets consume
// these same rows; display outcomes use the same evidence as the task inbox.
export function activitySummary(runs = [], { period = '7', now = Date.now(), envelopes = new Map(), degraded = false } = {}) {
  const source = Array.isArray(runs) ? runs : []
  const dated = source.map(run => ({ run, at: Date.parse(run.started_at || '') }))
  const valid = dated.filter(row => Number.isFinite(row.at) && row.at <= now)
  const days = ['1', '7', '30'].includes(String(period)) ? Number(period) : 7
  const start = period === 'all' ? Math.min(now, ...valid.map(row => row.at)) : now - days * day
  const rows = dated.filter(row => period === 'all' || (Number.isFinite(row.at) && row.at >= start && row.at <= now)).map(({ run }) => run)
  const unavailable = degraded ? 'Activity could not be refreshed. Retry the feed before interpreting totals.' : null
  const counts = Object.fromEntries(OUTCOMES.map(item => [item.key, 0]))
  const interval = period === '1' ? 2 * 3600000 : Math.max(day, Math.ceil((now - start) / day / 30) * day)
  const bucketCount = Math.max(1, Math.ceil((now - start) / interval))
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    start: start + index * interval, end: Math.min(now, start + (index + 1) * interval), count: 0, rows: [],
  }))
  const durations = []
  const usage = { total: null, measured: 0, complete: 0, input: null, output: null, cacheWrite: null, cacheRead: null }
  const attention = []
  for (const run of rows) {
    const envelope = envelopes instanceof Map ? envelopes.get(run.adw_id) : envelopes?.[run.adw_id]
    const status = deriveDisplayStatus(run, envelope, now)
    const key = terminal.has(status.key) ? status.key : run.running ? 'open' : 'unknown'
    counts[key] += 1
    if (terminal.has(status.key) && finite(run.duration_ms)) durations.push(run.duration_ms)
    if (needsAttention(status.key) && !run.triage?.reviewed_at) attention.push({ run, status })
    const tokens = tokenCell(run)
    const fields = ['input', 'output', 'cacheWrite', 'cacheRead']
    const measured = fields.filter(field => finite(tokens[field]))
    if (measured.length) {
      usage.measured += 1
      if (measured.length === fields.length) usage.complete += 1
      for (const field of measured) {
        usage[field] = (usage[field] ?? 0) + tokens[field]
        usage.total = (usage.total ?? 0) + tokens[field]
      }
    }
    const at = Date.parse(run.started_at || '')
    if (Number.isFinite(at) && at >= start && at <= now) {
      const bucket = buckets[Math.min(bucketCount - 1, Math.floor((at - start) / interval))]
      bucket.count += 1
      bucket.rows.push(run)
    }
  }
  durations.sort((a, b) => a - b)
  const middle = Math.floor(durations.length / 2)
  const median = durations.length ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) : null
  const settled = [...terminal].reduce((sum, key) => sum + counts[key], 0)
  return {
    rows: degraded ? [] : rows, start, end: now, buckets: degraded ? [] : buckets,
    total: degraded ? null : rows.length,
    counts: degraded ? null : counts,
    settled: degraded ? null : settled,
    successRate: !degraded && settled ? Math.round(counts.success / settled * 100) : null,
    median: degraded ? null : median, durationMeasured: degraded ? null : durations.length,
    usage: degraded ? null : usage,
    attention: degraded ? [] : attention.sort((a, b) => (Date.parse(b.run.started_at) || 0) - (Date.parse(a.run.started_at) || 0)),
    undated: source.length - valid.length, unavailable,
  }
}
