const META_KEYS = new Set(['at', 'channel', 'index', 'line_number'])

export function toMs(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at
  if (typeof at === 'string') { const ms = Date.parse(at); return Number.isNaN(ms) ? null : ms }
  return null
}

export function eventName(row) {
  if (typeof row?.event === 'string' && row.event) return row.event
  for (const key of Object.keys(row || {})) if (!META_KEYS.has(key)) return key
  return 'row'
}

export function detailLine(row) {
  const rest = {}
  for (const [key, value] of Object.entries(row || {})) if (!META_KEYS.has(key)) rest[key] = value
  const text = JSON.stringify(rest)
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

// The four operational rows PR #665 added. They are MARKERS on a bar, never spans:
// a retry is work in progress, and drawing it as a gap reproduces exactly the
// misreading #659 and #669 exist to prevent.
export const SEAT_MARKER_EVENTS = new Set(['seat-retrying', 'seat-retry-cleared', 'seat-stale', 'seat-stale-cleared'])
// #682's two rows, and a DIFFERENT KIND of marker rather than two more retries: a
// retry is THIS seat waiting on its provider, while a substrate outage is the pane
// manager under every seat in the batch — #682 measured four drivers dying within
// 23 seconds of each other — so an operator who sees one lane has reason to suspect
// all of them. Each row is named exactly ONCE, here.
export const SUBSTRATE_DOWN = 'seat-substrate-down'
export const SUBSTRATE_RECOVERED = 'seat-substrate-recovered'
export const SUBSTRATE_MARKER_EVENTS = new Set([SUBSTRATE_DOWN, SUBSTRATE_RECOVERED])
export const MARKER_EVENTS = new Set([...SEAT_MARKER_EVENTS, ...SUBSTRATE_MARKER_EVENTS])
export const markerKind = (event) => (SUBSTRATE_MARKER_EVENTS.has(event) ? 'substrate' : 'seat')

// A down and its recovery are ONE episode, tracked by ROLE so the pair survives an
// assignment rolling over underneath it. An episode that never recovered gets NO
// outage_ms at all — the open-span honesty rule, applied to an outage. Called only
// on an OWNED marker: an anomaly is not an episode.
function episodeLink(marker, role, open) {
  if (marker.event === SUBSTRATE_DOWN && !open.has(role)) open.set(role, marker)
  if (marker.event === SUBSTRATE_RECOVERED) {
    const down = open.get(role) ?? null
    if (down) {
      open.delete(role)
      const outage_ms = marker.at_ms - down.at_ms
      down.outage_ms = outage_ms
      down.recovered_index = marker.index
      marker.outage_ms = outage_ms
      marker.down_index = down.index
      marker.down_at_ms = down.at_ms
    }
  }
  return marker
}

const durationOf = (span) => (span.ended_at == null ? {} : { duration_ms: span.ended_at - span.started_at })
const finish = (span) => ({ ...span, ...durationOf(span) })

export function buildTrajectory(rows = [], { operational_channel = null, reveal = false } = {}) {
  const isOperational = (row) => operational_channel != null && row.channel === operational_channel
  const dated = []
  let excluded_no_timestamp = 0
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const ms = toMs(row?.at)
    if (ms == null) { excluded_no_timestamp += 1; continue }
    dated.push({ index: i, at_ms: ms, at: row.at, channel: row.channel ?? null, event: eventName(row), detail: detailLine(row), row })
  }
  const ordered = dated
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => (a.entry.at_ms - b.entry.at_ms) || (a.position - b.position))
    .map(({ entry }) => entry)
  const hidden_operational = ordered.filter((row) => isOperational(row)).length
  const visible = reveal ? ordered : ordered.filter((row) => !isOperational(row))

  const spans = []
  const anomalies = []
  const openStages = []
  const openAssignments = new Map()
  const openByRole = new Map()
  const openOutages = new Map()
  for (const entry of ordered) {
    const row = entry.row
    if (MARKER_EVENTS.has(row.event)) {
      // The owner is the assignment OPEN for this role at this instant. `id` here is
      // the cell id and `assign` is the dispatch id: joining them finds nothing at
      // all, silently. This walks `ordered`, so a marker is found whether or not
      // the ledger reveals its operational row.
      const role = row.role ?? null
      const ownerStack = openByRole.get(role)
      const owner = ownerStack && ownerStack.length ? spans[ownerStack.at(-1)] : null
      const marker = { event: row.event, kind: markerKind(row.event), at_ms: entry.at_ms, index: entry.index, detail: entry.detail }
      if (owner) owner.markers = [...(owner.markers ?? []), episodeLink(marker, role, openOutages)]
      else anomalies.push({ kind: 'marker_unowned', label: row.event, role, expected: `an open assignment for role ${row.role ?? 'unknown'}`, index: entry.index, at_ms: entry.at_ms })
      continue
    }
    if (typeof row.stage === 'string') {
      const parent = openStages.length ? openStages[openStages.length - 1] : null
      const span = { family: 'stage', label: row.stage, id: null, role: null, status: null, started_at: entry.at_ms, started_index: entry.index, ended_at: null, ended_index: null, depth: openStages.length, parent }
      spans.push(span)
      openStages.push(spans.length - 1)
      continue
    }
    if (typeof row.stage_done === 'string') {
      // STRICT LIFO, because the producer is strict: crew/drive.mjs:1586 pops the
      // top and emits ITS label. Only the top may close, and a label that is not
      // the top's is an imbalance — never a licence to close a parent and orphan
      // its children.
      const top = openStages.at(-1) ?? null
      if (top === null || spans[top].label !== row.stage_done) {
        anomalies.push({ kind: 'stack_imbalance', label: row.stage_done, expected: top === null ? null : spans[top].label, index: entry.index, at_ms: entry.at_ms })
        continue
      }
      openStages.pop()
      spans[top].ended_at = entry.at_ms
      spans[top].ended_index = entry.index
      continue
    }
    if (typeof row.assign === 'string') {
      const key = `${row.assign} ${row.role ?? ''}`
      const span = { family: 'assignment', label: `${row.assign}:${row.role ?? 'unknown'}`, id: row.assign, role: row.role ?? null, status: null, started_at: entry.at_ms, started_index: entry.index, ended_at: null, ended_index: null, depth: 0, parent: null }
      spans.push(span)
      if (!openAssignments.has(key)) openAssignments.set(key, [])
      openAssignments.get(key).push(spans.length - 1)
      if (!openByRole.has(span.role)) openByRole.set(span.role, [])
      openByRole.get(span.role).push(spans.length - 1)
      continue
    }
    if (typeof row.envelope === 'string') {
      const key = `${row.envelope} ${row.role ?? ''}`
      const stack = openAssignments.get(key)
      if (!stack || !stack.length) continue
      const spanIndex = stack.pop()
      const span = spans[spanIndex]
      span.ended_at = entry.at_ms
      span.ended_index = entry.index
      span.status = row.status ?? null
      const byRole = openByRole.get(span.role)
      if (byRole) { const position = byRole.indexOf(spanIndex); if (position >= 0) byRole.splice(position, 1) }
    }
  }
  // A stage span with NO assignment span active across it is the DRIVER working.
  // Both "has the lane stalled?" readings (#670) were this, and both were wrong.
  // Overlap goes through spansActiveIn unchanged, so an open span stays open: it is
  // never given an end, never extended to now, never given a duration.
  const assignments = spans.filter((span) => span.family === 'assignment')
  for (const span of spans) {
    if (span.family !== 'stage') continue
    if (spansActiveIn(assignments, span.started_at, span.ended_at ?? Infinity).length) span.actor = 'seat'
    else span.actor = 'driver'
  }
  return {
    rows: visible,
    spans: spans.map(finish),
    anomalies,
    excluded_no_timestamp,
    hidden_operational,
  }
}

export function spansActiveIn(spans = [], from, to) {
  return spans.filter((span) => span.started_at <= to && (span.ended_at == null || span.ended_at >= from))
}

// The rows a span is MADE of. A span active in the dragged interval brings its own
// endpoints into the ledger even when neither endpoint falls inside the interval —
// which is the whole point of dragging over a moment nothing was logged at.
const endpoints = (span) => (span.ended_index == null ? [span.started_index] : [span.started_index, span.ended_index])

export function focusTrajectory(trajectory, from, to) {
  const spans = spansActiveIn(trajectory.spans, from, to)
  const keep = new Set()
  for (const row of trajectory.rows) if (row.at_ms >= from && row.at_ms <= to) keep.add(row.index)
  for (const span of spans) for (const index of endpoints(span)) keep.add(index)
  return { spans, rows: trajectory.rows.filter((row) => keep.has(row.index)) }
}

export function projectSpan(span, origin, total_ms) {
  const left = total_ms > 0 ? (span.started_at - origin) / total_ms : 0
  return span.ended_at == null ? { left, marker: true } : { left, width: total_ms > 0 ? (span.ended_at - span.started_at) / total_ms : 0 }
}

export function projectMarker(at_ms, origin, total_ms) {
  return { left: total_ms > 0 ? (at_ms - origin) / total_ms : 0 }
}
