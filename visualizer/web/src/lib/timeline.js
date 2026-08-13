export const REQUEST_ZONE = 0.12
export const MIN_WIDTH = 0.02
export const QUEUED_WIDTH = 0.06

function time(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function layoutTimeline(run = {}, events = [], { now = Date.now() } = {}) {
  const phases = Array.isArray(run.phases) ? run.phases : []
  const timed = phases.filter((phase) => phase.started_at != null).sort((a, b) => (time(a.started_at) - time(b.started_at)) || ((a.seq ?? 0) - (b.seq ?? 0)))
  const queued = phases.filter((phase) => phase.started_at == null).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  if (!phases.length || !timed.length) {
    return { request: null, origin_at: null, span_ms: 1, blocks: [], queued: [], marks: [], lanes: [], lane_source: run.phase_lanes ?? null,
      unavailable: run.phase_lanes == null ? (run.pending?.phase_lanes ?? null) : null, min_width: MIN_WIDTH, queued_width: QUEUED_WIDTH }
  }
  const origin = Math.min(...timed.map((phase) => time(phase.started_at)).filter((v) => v != null))
  let finish = time(run.ended_at) ?? origin
  for (const phase of phases) {
    const ended = time(phase.ended_at)
    if (ended != null) finish = Math.max(finish, ended)
    if (phase.started_at != null && ended == null) finish = Math.max(finish, now)
  }
  const span = finish - origin
  const spanMs = span > 0 ? span : 1
  const requestStart = time(run.started_at)
  const request = requestStart != null && origin > requestStart ? { x: 0, width: REQUEST_ZONE, started_at: run.started_at, ended_at: timed[0].started_at, request: true } : null
  const lead = request ? REQUEST_ZONE : 0
  const queuedTotal = queued.length * QUEUED_WIDTH
  const content = Math.max(0, 1 - lead - queuedTotal)
  const occurrences = new Map()
  const attempts = new Map()
  for (const phase of [...phases].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    const ordinal = (occurrences.get(phase.name) || 0) + 1
    occurrences.set(phase.name, ordinal)
    attempts.set(phase, ordinal)
  }
  const eventCounts = new Map()
  for (const event of events) eventCounts.set(event.phase_id, (eventCounts.get(event.phase_id) || 0) + 1)
  let shift = 0, prevEnd = 0
  const raw = []
  for (const phase of timed) {
    const start = time(phase.started_at)
    const end = time(phase.ended_at) ?? now
    const s = (start - origin) / spanMs
    const w = Math.max(0, (end - start) / spanMs)
    const placed = Math.max(s + shift, prevEnd)
    let width = w
    const floor = (MIN_WIDTH + 1e-9) / Math.max(content - MIN_WIDTH * timed.length, 1e-9)
    if (width < floor) { shift += floor - width; width = floor }
    prevEnd = placed + width
    raw.push({ phase, s: placed, w: width, duration_ms: Math.max(0, end - start) })
  }
  const total = Math.max(1, prevEnd)
  const blocks = raw.map(({ phase, s, w, duration_ms }) => ({
    ...phase, phase_id: phase.id ?? null, duration_ms: phase.duration_ms ?? duration_ms, x: lead + (s / total) * content, width: (w / total) * content,
    queued: false, attempt: attempts.get(phase), attempts_total: occurrences.get(phase.name), event_count: eventCounts.get(phase.id) || 0,
  }))
  const queuedBlocks = queued.map((phase, index) => ({
    ...phase, phase_id: phase.id ?? null, x: 1 - queuedTotal + index * QUEUED_WIDTH, width: QUEUED_WIDTH, queued: true,
    attempt: attempts.get(phase), attempts_total: occurrences.get(phase.name), event_count: eventCounts.get(phase.id) || 0,
  }))
  const marks = []
  for (const event of events) {
    const started = time(event.started_at), ended = time(event.ended_at)
    if (started == null || ended == null) continue
    const s = (started - origin) / spanMs
    const w = Math.max(0, (ended - started) / spanMs)
    marks.push({ ...event, x: lead + Math.max(0, s) / total * content, width: w / total * content })
  }
  const laneRows = [], laneMap = new Map()
  for (const phase of phases) {
    const key = phase.lane ?? null
    if (!laneMap.has(key)) { const row = { lane: key, key: key === null ? 'unlinked' : `lane-${key}`, blocks: [] }; laneMap.set(key, row); laneRows.push(row) }
  }
  if (laneMap.has(null)) { const row = laneMap.get(null); laneRows.splice(laneRows.indexOf(row), 1); laneRows.push(row) }
  for (const block of [...blocks, ...queuedBlocks]) laneMap.get(block.lane ?? null)?.blocks.push(block)
  return { request, origin_at: timed[0].started_at, span_ms: spanMs, blocks, queued: queuedBlocks, marks, lanes: laneRows,
    lane_source: run.phase_lanes ?? null, unavailable: run.phase_lanes == null ? (run.pending?.phase_lanes ?? null) : null,
    min_width: MIN_WIDTH, queued_width: QUEUED_WIDTH }
}
