// Pure run shaping helpers. This module deliberately has no filesystem or database dependencies.
const lanes = new Map()
const PALETTE_SIZE = 8

export function laneFor(role) {
  const key = String(role || 'unknown')
  if (!lanes.has(key)) {
    let n = 0
    for (const ch of key) n = (n * 31 + ch.codePointAt(0)) >>> 0
    lanes.set(key, n % PALETTE_SIZE)
  }
  return lanes.get(key)
}

function payload(event) {
  try { return event.payload_json ? JSON.parse(event.payload_json) : {} } catch { return {} }
}

export function foldAgents(events = []) {
  const agents = new Map()
  for (const event of events) {
    const p = payload(event)
    if (!p.dispatch_id) continue
    const current = agents.get(p.dispatch_id) || {
      dispatch_id: p.dispatch_id, role: p.role || 'unknown', lane: laneFor(p.role),
      outcome: null, started_at: event.started_at || null, ended_at: null,
    }
    if (event.type === 'agent_start') {
      current.role = p.role || current.role
      current.lane = laneFor(current.role)
      current.started_at = event.started_at || current.started_at
    } else if (event.type === 'agent_end') {
      current.role = p.role || current.role
      current.lane = laneFor(current.role)
      current.outcome = p.outcome ?? null
      current.ended_at = event.ended_at || event.started_at || null
    }
    agents.set(p.dispatch_id, current)
  }
  return [...agents.values()]
}

function pendingFor(field, probe, value) {
  if (value !== null && value !== undefined) return null
  if (field === 'phase_lanes') return 'phase association absent from the record — crew agent events carry no phase_id'
  const missing = probe?.missing || []
  if (missing.includes(field)) return 'predates this measurement'
  if (field === 'read_tokens' || field === 'written_tokens') return 'awaiting the metering daemon (#83)'
  return 'not measured yet'
}

function dateValue(v) {
  if (v == null) return null
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}

export function shapeRun(session, phases = [], agentEvents = [], triageRow = null, probe = {}, now = Date.now()) {
  const ended = session.ended_at ?? null
  const start = dateValue(session.started_at)
  const finish = dateValue(ended)
  const duration = start == null ? null : (finish ?? now) - start
  const mode = Object.prototype.hasOwnProperty.call(session, 'mode') ? session.mode : null
  const engineer = Object.prototype.hasOwnProperty.call(session, 'engineer') ? session.engineer : null
  const metrics = {
    billed_cost_usd: session.billed_cost_usd ?? null,
    billed_input_tokens: session.billed_input_tokens ?? null,
    billed_output_tokens: session.billed_output_tokens ?? null,
    read_tokens: null,
    written_tokens: null,
  }
  const pending = {}
  for (const field of ['mode', 'engineer', 'billed_cost_usd', 'billed_input_tokens', 'billed_output_tokens']) {
    const value = field === 'mode' ? mode : field === 'engineer' ? engineer : metrics[field]
    const reason = pendingFor(field, probe, value)
    if (reason) pending[field] = reason
  }
  pending.read_tokens = pendingFor('read_tokens', probe, metrics.read_tokens)
  pending.written_tokens = pendingFor('written_tokens', probe, metrics.written_tokens)
  const phaseLanes = new Map()
  for (const event of agentEvents) {
    if (event.phase_id == null) continue
    const p = payload(event)
    if (p.role) phaseLanes.set(event.phase_id, laneFor(p.role))
  }
  const phaseCards = phases.map((phase) => {
    const ps = dateValue(phase.started_at)
    const pe = dateValue(phase.ended_at)
    return { seq: phase.seq, name: phase.name, status: phase.status, lane: phaseLanes.get(phase.id) ?? null,
      started_at: phase.started_at ?? null, ended_at: phase.ended_at ?? null,
      duration_ms: ps == null ? null : (pe ?? now) - ps }
  })
  const phaseLaneSource = phaseCards.some((phase) => phase.lane != null) ? 'agent' : null
  const phaseLanePending = pendingFor('phase_lanes', probe, phaseLaneSource)
  return {
    adw_id: session.adw_id,
    goal: session.task_slug ?? null,
    repo_slug: session.repo_slug ?? null,
    mode,
    engineer,
    status: session.status ?? null,
    running: session.status === 'running',
    started_at: session.started_at ?? null,
    ended_at: ended,
    duration_ms: duration,
    phases: phaseCards,
    phase_lanes: phaseLaneSource,
    agents: foldAgents(agentEvents),
    metrics,
    triage: { reviewed_at: triageRow?.reviewed_at ?? null },
    pending: { ...pending, ...(phaseLanePending ? { phase_lanes: phaseLanePending } : {}) },
  }
}

export function matchesFilters(run, filters = {}) {
  if (filters.mode && run.mode !== filters.mode) return false
  if (filters.status && run.status !== filters.status) return false
  const started = dateValue(run.started_at)
  const since = dateValue(filters.since)
  const until = dateValue(filters.until)
  if (since != null && (started == null || started < since)) return false
  if (until != null && (started == null || started >= until)) return false
  return true
}

export { pendingFor }
