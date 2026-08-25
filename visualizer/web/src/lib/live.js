// The trajectory view's live seam. The component owns DOM geometry and nothing
// else; every decision about WHEN to read, what a read carries forward, and how
// fresh the reading is lives here, where a test can drive it.
import { buildTrajectory, focusTrajectory, projectSpan } from './spans.js'
import { PANEL_REFRESH_MS, readFreshness } from './panels.js'

export const EMPTY_JOURNAL = { rows: [], channels: { record: null, operational: null }, skipped_malformed: 0, skipped_line_numbers: [], dir: null, degraded: false, error: undefined }

export function createPulse() {
  const listeners = new Set()
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    pulse() { for (const listener of [...listeners]) listener() },
    get size() { return listeners.size },
  }
}

// One clock for the whole page: App's existing anyRunning timer publishes here.
// A second poll loop over the same server is a defect, not a feature (#630).
export const journalPulse = createPulse()

export function initialJournalState() {
  return { payload: EMPTY_JOURNAL, reads: 0, read_at: null, error: '', stale: false, selected: null, range: null, reveal: false }
}

// A pulse reads only while the lane is running. The mount read is not a pulse, so
// a finished or archived run reads exactly once.
export function shouldRead({ running } = {}) {
  return running === true
}

export function applyRead(state, result, at) {
  // A failed read changes NOTHING the operator is looking at — not the rows, not
  // the last-read time, not the selection. It only says so. Spread rather than
  // re-list the carried fields, so the explicit carry-forward below is the single
  // place those names appear.
  if (!result || result.ok !== true) {
    return { ...state, error: (result && result.error) || 'journal request failed', stale: true }
  }
  return {
    payload: result.payload,
    reads: state.reads + 1,
    read_at: at,
    error: '',
    stale: false,
    // The operator's frame of reference is CARRIED across a read, never rebuilt.
    selected: state.selected,
    range: state.range,
    reveal: state.reveal,
  }
}

export function select(state, index) { return { ...state, selected: index } }
export function setRange(state, next) { return { ...state, range: next } }
export function setReveal(state, next) { return { ...state, reveal: next === true } }
export function clearFocus(state) { return { ...state, range: null, selected: null } }

export function journalFreshness(state, now, refresh_ms = null) {
  const base = readFreshness(state.read_at, now, refresh_ms)
  const stale = state.stale || (refresh_ms != null && base.stale)
  const label = state.error ? `stale — the last refresh failed (${state.error}); ${base.label}` : base.label
  return { ...base, stale, label }
}

export function trajectoryView(state, { now = null, refresh_ms = null } = {}) {
  const trajectory = buildTrajectory(state.payload.rows, { operational_channel: state.payload.channels?.operational ?? null, reveal: state.reveal })
  const starts = trajectory.spans.map((span) => span.started_at)
  const rowTimes = trajectory.rows.map((row) => row.at_ms)
  const origin = starts.length ? Math.min(...starts) : (rowTimes.length ? Math.min(...rowTimes) : 0)
  // The right edge MOVES: a lane that keeps running adds rows without closing a
  // span, so the axis reads the rows too, not the span ends alone.
  const end = Math.max(origin, ...trajectory.spans.map((span) => span.ended_at ?? span.started_at), ...rowTimes)
  const total = Math.max(1, end - origin)
  const focus = state.range ? focusTrajectory(trajectory, state.range.from, state.range.to) : null
  const spans = (focus ? focus.spans : trajectory.spans).map((span) => {
    const box = projectSpan(span, origin, total)
    return { ...span, box, took: box.marker ? 'in flight' : `${Math.round(span.duration_ms / 1000)}s` }
  })
  return {
    spans,
    rows: focus ? focus.rows : trajectory.rows,
    all_rows: trajectory.rows,
    origin,
    total,
    focused: focus !== null,
    anomalies: trajectory.anomalies,
    hidden_operational: trajectory.hidden_operational,
    excluded_no_timestamp: trajectory.excluded_no_timestamp,
    degraded: state.payload.degraded === true || Boolean(state.payload.error),
    payload_error: state.payload.error,
    skipped_malformed: state.payload.skipped_malformed ?? 0,
    skipped_line_numbers: state.payload.skipped_line_numbers ?? [],
    freshness: journalFreshness(state, now, refresh_ms),
  }
}
