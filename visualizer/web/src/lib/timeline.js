const MIN_WIDTH = 0.02

// Ordinal positions are drawing coordinates, never time measurements. Preserve
// journal order (including repeated stages) when old records have no intervals.
export function layoutStageOrder(run = {}) {
  const phases = Array.isArray(run.phases) ? run.phases : []
  return phases.map((phase, index) => ({
    ...phase, ordinal: index + 1, x: index / phases.length, width: 1 / phases.length,
    duration_ms: null,
  }))
}

function time(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatLeanDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${(ms % 60000) / 1000}s`
}

export function layoutTimeline(run = {}) {
  const phases = Array.isArray(run.phases) ? run.phases : []
  const intervals = [], unrecorded = []
  for (const phase of phases) {
    const start = time(phase.started_at), end = time(phase.ended_at)
    if (phase.status === 'running' && phase.ended_at == null && start != null) {
      intervals.push({ phase, start, end: null })
      continue
    }
    const reason = start == null ? 'Start time missing or invalid' : end == null ? 'End time missing or invalid' : end < start ? 'Interval ends before it starts' : null
    if (reason) unrecorded.push({ ...phase, x: null, width: null, duration_ms: null, reason })
    else intervals.push({ phase, start, end })
  }
  const origin = intervals.length ? Math.min(...intervals.map((entry) => entry.start)) : null
  const finish = intervals.length ? Math.max(...intervals.map((entry) => entry.end ?? entry.start)) : null
  const span = origin == null ? null : finish - origin
  const blocks = intervals.map(({ phase, start, end }) => {
    const turns = Array.isArray(phase.turns) && phase.role ? phase.turns.filter((turn) => turn.role === phase.role) : []
    const seat_ms = turns.length && turns.every((turn) => Number.isFinite(turn.seconds) && turn.seconds >= 0)
      ? turns.reduce((sum, turn) => sum + turn.seconds, 0) * 1000 : null
    return {
      ...phase, phase_id: phase.id ?? null, open: end == null, duration_ms: end == null ? null : end - start,
      seat_ms: end == null ? null : seat_ms, x: span ? (start - origin) / span : 0,
      width: end == null ? null : Math.max(MIN_WIDTH, span ? (end - start) / span : 0),
    }
  })
  return { origin_at: origin == null ? null : new Date(origin).toISOString(), span_ms: span, blocks, unrecorded }
}
