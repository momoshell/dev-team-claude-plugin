// Pure run shaping helpers. This module deliberately has no filesystem or database dependencies.
const lanes = new Map()
const PALETTE_SIZE = 8
export const ROLE_ORDER = Object.freeze(['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver'])
export const CELL_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const EFFORT_PENDING = 'not recorded per run — agent_sessions carries model but no effort column (scripts/factory/ledger.mjs:406-426); effort is recorded only on cell_failures and modifier_attempts rows (crew/seat-io.mjs:264-265, 285-288)'
const CONTEXT_PENDING = 'no live transport records occupancy — pane seats land no agent_sessions row at all; headless-json/headless-rpc land rows with both columns NULL; context_window has no verified source (U-4); see docs/ledger-queries.md'
const MODEL_PENDING = 'not measured — no agent_sessions row for this dispatch (a pane seat lands none by design, crew/seat-io.mjs:399-410)'
const MODEL_ROLE_PENDING = "not measured — this run records an agent_sessions row for this dispatch id but none for this seat's role: the dispatch id was reused across assignments and that cell is the other row's (#461)"
export const RUN_SET_WINDOW_MS = 24 * 60 * 60 * 1000
export const INTAKE_WINDOW_MS = 24 * 60 * 60 * 1000
export const SEAT_TEARDOWN_WINDOW_MS = 24 * 60 * 60 * 1000
// Keep this dependency-free copy lockstep with scripts/factory/ledger.mjs:134;
// the shaper must not import the ledger module just to render its vocabulary.
export const SEAT_TEARDOWN_OUTCOMES = Object.freeze(['proven', 'failed', 'unproven'])
export const INTAKE_REFUSAL_REASONS = Object.freeze([
  'stop-switch', 'window-cap', 'rate-limit-floor',
  'priority-unknown', 'intake-block-missing', 'intake-block-malformed',
  'brief-uncompilable', 'protected-path', 'tier-judge', 'not-first-in-order',
  'repeat-escalation',
])
export const INTAKE_REFUSAL_GROUPS = Object.freeze([
  Object.freeze({
    group: 'authoring',
    title: 'an issue needs a human to author or fix it',
    asserts: 'a human editing the issue unblocks this',
    reasons: Object.freeze(['intake-block-missing', 'intake-block-malformed', 'brief-uncompilable', 'priority-unknown', 'repeat-escalation']),
  }),
  Object.freeze({
    group: 'guardrail',
    title: 'the loop refused on purpose; lifting it is a human decision',
    asserts: 'nothing is broken — something is being protected, and a stop-switch park means a human halted it deliberately',
    reasons: Object.freeze(['stop-switch', 'window-cap', 'rate-limit-floor', 'protected-path', 'tier-judge']),
  }),
  Object.freeze({
    group: 'ordering',
    title: 'nothing is wrong; this candidate was simply not first',
    asserts: 'no action',
    reasons: Object.freeze(['not-first-in-order']),
  }),
])

export function laneFor(role) {
  const key = String(role || 'unknown')
  const ordered = ROLE_ORDER.indexOf(key)
  if (ordered >= 0) return ordered
  if (!lanes.has(key)) {
    let n = 0
    for (const ch of key) n = (n * 31 + ch.codePointAt(0)) >>> 0
    lanes.set(key, 6 + (n % (PALETTE_SIZE - ROLE_ORDER.length)))
  }
  return lanes.get(key)
}

function payload(event) {
  try { return event.payload_json ? JSON.parse(event.payload_json) : {} } catch { return {} }
}

// A dispatch id is not an assignment's identity: the runtime reuses it across a
// resumed drive (#461), so b52-heartbeat's journal carries d1 twice (a re-asked
// planner) and d2 twice (a lead that took over a timed-out builder). Pair the
// events in id order instead — each agent_start OPENS a row; the next agent_end
// for that id closes the row it opened — and give every row its own `key` so two
// assignments sharing an id are two rows. A row keeps the role it was started
// with: nothing below writes `role` after the row is created.
export function foldAgents(events = []) {
  const rows = []
  const open = new Map()
  const occurrences = new Map()
  function openRow(id, event, p) {
    const n = (occurrences.get(id) ?? 0) + 1
    occurrences.set(id, n)
    const row = {
      key: `${id}#${n}`,
      dispatch_id: id, role: p.role || 'unknown', lane: laneFor(p.role),
      outcome: null, started_at: event.started_at || null, ended_at: null,
    }
    rows.push(row)
    return row
  }
  for (const event of events) {
    const p = payload(event)
    if (!p.dispatch_id) continue
    const id = p.dispatch_id
    if (event.type === 'agent_start') {
      open.set(id, openRow(id, event, p))
    } else if (event.type === 'agent_end') {
      const row = open.get(id) ?? openRow(id, event, p)
      open.delete(id)
      row.outcome = p.outcome ?? null
      row.ended_at = event.ended_at || event.started_at || null
    }
  }
  return rows
}

export function withCells(agents = [], agentSessions = []) {
  // A dispatch id can be shared by two assignments (#461), so a cell is
  // attributed by the seat's ROLE as well as its id: b52-heartbeat's d2 timed
  // out as a builder and was then taken over by a lead, and the builder's cell
  // is not the lead's. A session row recording no role still attributes to any
  // row for that id, which is what this shaper did before agent_sessions.role.
  const byDispatch = new Map()
  for (const row of Array.isArray(agentSessions) ? agentSessions : []) {
    if (row?.dispatch_id == null) continue
    const key = String(row.dispatch_id)
    let entry = byDispatch.get(key)
    if (!entry) { entry = { roles: new Map(), roleless: null }; byDispatch.set(key, entry) }
    const role = row.role == null || row.role === '' ? null : String(row.role)
    if (role == null) { if (entry.roleless == null) entry.roleless = row }
    else if (!entry.roles.has(role)) entry.roles.set(role, row)
  }
  return (Array.isArray(agents) ? agents : []).map((agent) => {
    const entry = byDispatch.get(String(agent?.dispatch_id))
    const session = entry ? (entry.roles.get(String(agent?.role)) ?? entry.roleless) : null
    const model = session?.model ?? null
    const modelPresent = model != null && (typeof model !== 'string' || model.length > 0)
    return {
      ...agent,
      model,
      model_pending: modelPresent ? null : (entry && entry.roles.size ? MODEL_ROLE_PENDING : MODEL_PENDING),
      effort: null,
      effort_pending: EFFORT_PENDING,
      context_tokens: null,
      context_window: null,
      context_pending: CONTEXT_PENDING,
    }
  })
}

function sumBilled(rows, column, fallback) {
  let total = null
  for (const row of rows) {
    const value = row?.[column]
    if (typeof value === 'number' && Number.isFinite(value)) total = (total ?? 0) + value
  }
  // One agent_sessions row per claude_session_id holds that seat's RUNNING
  // total, so summing rows is correct and does not double-count assignments.
  return total ?? (typeof fallback === 'number' ? fallback : null)
}

// Why a row can legitimately carry no tier: it was booted with --roles rather
// than --tier (crew/crew.mjs writes the key only for a tiered boot), or it
// predates the sessions.tier column and is never backfilled.
const TIER_UNMEASURED = "not measured — this run's session row records no tier: it was booted with explicit --roles rather than --tier, or it predates the sessions.tier column and is never backfilled; intake_dispatches records tier by issue, not by run"

function pendingFor(field, probe, value) {
  if (value !== null && value !== undefined) return null
  if (field === 'tier') return TIER_UNMEASURED
  if (field === 'last_heartbeat_at') return 'not measured here — agent_sessions.last_heartbeat_at is not selected by this feed (visualizer/server/ledger-feed.mjs:76)'
  if (field === 'phase_lanes') return "this run's agent events predate phase linkage (#123)"
  if (field === 'billed_cost_usd') return 'money deferred — a subscription seat is not billed per token (#185)'
  const missing = probe?.missing || []
  if (missing.includes(field)) return 'predates this measurement'
  if (field === 'read_tokens' || field === 'written_tokens') return 'awaiting the metering daemon (#83)'
  if (field === 'gate_discrimination' || field === 'gate_generations' || field === 'reviews') return 'predates this measurement'
  if (field.startsWith('billed_')) return 'predates this measurement'
  return 'not measured yet'
}

function normalizeGateCheck(item) {
  if (typeof item === 'string') return { label: item, note: null, ok: null }
  if (item && typeof item === 'object') {
    return {
      label: item.name ?? item.label ?? JSON.stringify(item),
      note: item.note ?? item.detail ?? null,
      ok: item.ok ?? null,
    }
  }
  return { label: String(item), note: null, ok: null }
}

export function shapeGateChecks(gateResults = []) {
  if (!Array.isArray(gateResults) || gateResults.length === 0) return null
  return gateResults.map((row) => {
    const raw = row?.checks_json
    let parsed
    let parseError = null
    try {
      if (typeof raw === 'string') parsed = JSON.parse(raw)
      else if (Array.isArray(raw)) parsed = raw
      else if (raw && typeof raw === 'object') parsed = raw
      else throw new Error('checks_json is absent')
    } catch (error) {
      parseError = error?.message || 'checks_json could not be parsed'
    }
    const base = {
      gate_generation: row?.gate_generation ?? null,
      gate_name: row?.gate_name ?? null,
      attempt: row?.attempt ?? null,
      phase_id: row?.phase_id ?? null,
      ok: row?.ok ?? null,
      pristine: row?.pristine ?? null,
      created_at: row?.created_at ?? null,
      checks: parseError ? [] : (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeGateCheck),
      checks_pending: parseError ? `checks_json could not be parsed — recorded raw checks retained (${parseError})` : null,
    }
    if (parseError) base.checks_raw = raw == null ? '' : String(raw)
    return base
  })
}

function dateValue(v) {
  if (v == null) return null
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}

export function shapeRun(session, phases = [], agentEvents = [], triageRow = null,
                         probe = {}, now = Date.now(), extras = {}) {
  const { agentSessions = [], gateDiscriminations = [], reviewOutcomes = [], acceptDecisions = [], gateResults = [] } = extras || {}
  const ended = session.ended_at ?? null
  const start = dateValue(session.started_at)
  const finish = dateValue(ended)
  const duration = start == null ? null : (finish ?? now) - start
  const mode = Object.prototype.hasOwnProperty.call(session, 'mode') ? session.mode : null
  const engineer = Object.prototype.hasOwnProperty.call(session, 'engineer') ? session.engineer : null
  const metrics = {
    billed_cost_usd: null,
    billed_input_tokens: sumBilled(agentSessions, 'billed_input_tokens', session.billed_input_tokens),
    billed_output_tokens: sumBilled(agentSessions, 'billed_output_tokens', session.billed_output_tokens),
    billed_cache_write_tokens: sumBilled(agentSessions, 'billed_cache_write_tokens', session.billed_cache_write_tokens),
    billed_cache_read_tokens: sumBilled(agentSessions, 'billed_cache_read_tokens', session.billed_cache_read_tokens),
    read_tokens: null,
    written_tokens: null,
  }
  let last_heartbeat_at = null
  for (const row of Array.isArray(agentSessions) ? agentSessions : []) {
    last_heartbeat_at = laterTimestamp(last_heartbeat_at, row?.last_heartbeat_at ?? null)
  }
  const heartbeatMs = dateValue(last_heartbeat_at)
  const heartbeat_age_ms = heartbeatMs == null || !Number.isFinite(now) ? null : now - heartbeatMs
  const tier = Object.prototype.hasOwnProperty.call(session, 'tier') ? (session.tier ?? null) : null
  const gateRows = [...gateDiscriminations].sort((a, b) => (a.gate_generation ?? 0) - (b.gate_generation ?? 0))
  const gateGenerations = gateRows.length ? gateRows.map((row) => ({
    gate_generation: row.gate_generation ?? null,
    verdict: row.verdict ?? null,
    checks_total: row.checks_total ?? null,
    checks_failed: row.checks_failed ?? null,
    checks_errored: row.checks_errored ?? null,
    note: row.note ?? null,
    created_at: row.created_at ?? null,
  })) : null
  const gateDiscrimination = gateGenerations ? (gateGenerations.at(-1).verdict ?? null) : null
  const gateChecks = shapeGateChecks(gateResults)
  const reviews = reviewOutcomes.length ? reviewOutcomes.map((row) => ({
    dispatch_id: row.dispatch_id ?? null, role: row.role ?? null, verdict: row.verdict ?? null,
    must_fix: row.must_fix ?? null, should_fix: row.should_fix ?? null,
    consider: row.consider ?? null, created_at: row.created_at ?? null,
  })) : null
  const accepts = acceptDecisions.length ? acceptDecisions.map((row) => ({
    where_at: row.where_at ?? null,
    outcome: row.outcome ?? null,
    findings_total: row.findings_total ?? null,
    residual_count: row.residual_count ?? null,
    refuted_count: row.refuted_count ?? null,
    cosmetic_count: row.cosmetic_count ?? null,
    unverified_count: row.unverified_count ?? null,
    // seat-io writes '' when there were no invalid residuals; an empty string
    // is not a diagnostic, so it degrades to null.
    invalid_reasons: row.invalid_reasons ? row.invalid_reasons : null,
    created_at: row.created_at ?? null,
  })) : null
  const pending = {}
  for (const field of ['mode', 'engineer', 'billed_cost_usd', 'billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens', 'tier', 'last_heartbeat_at']) {
    const value = field === 'mode' ? mode : field === 'engineer' ? engineer : field === 'tier' ? tier : field === 'last_heartbeat_at' ? last_heartbeat_at : metrics[field]
    const reason = pendingFor(field, probe, value)
    if (reason) pending[field] = reason
  }
  for (const field of ['gate_discrimination', 'gate_generations', 'gate_checks', 'reviews', 'accept_decisions']) {
    const value = field === 'gate_discrimination' ? gateDiscrimination : field === 'gate_generations' ? gateGenerations : field === 'gate_checks' ? gateChecks : field === 'reviews' ? reviews : accepts
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
    return { id: phase.id ?? null, seq: phase.seq, name: phase.name, status: phase.status, lane: phaseLanes.get(phase.id) ?? null,
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
    tier,
    last_heartbeat_at,
    heartbeat_age_ms,
    started_at: session.started_at ?? null,
    ended_at: ended,
    duration_ms: duration,
    phases: phaseCards,
    phase_lanes: phaseLaneSource,
    agents: withCells(foldAgents(agentEvents), agentSessions),
    metrics,
    gate_discrimination: gateDiscrimination,
    gate_generations: gateGenerations,
    gate_checks: gateChecks,
    reviews,
    accept_decisions: accepts,
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

function cellPart(value) {
  return value == null ? '—' : String(value)
}

function cellKey(provider, model_id, agent, effort) {
  return `${cellPart(provider)}/${cellPart(model_id)}·${cellPart(agent)}·${cellPart(effort)}`
}

function countValue(value) {
  const count = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(count) ? count : 0
}

function earlierTimestamp(current, candidate) {
  if (candidate == null) return current
  if (current == null) return candidate
  const currentMs = dateValue(current), candidateMs = dateValue(candidate)
  if (currentMs != null && candidateMs != null) return candidateMs < currentMs ? candidate : current
  return String(candidate) < String(current) ? candidate : current
}

function laterTimestamp(current, candidate) {
  if (candidate == null) return current
  if (current == null) return candidate
  const currentMs = dateValue(current), candidateMs = dateValue(candidate)
  if (currentMs != null && candidateMs != null) return candidateMs > currentMs ? candidate : current
  return String(candidate) > String(current) ? candidate : current
}

function strictlyLaterTimestamp(current, candidate) {
  if (current == null || candidate == null) return false
  const latest = laterTimestamp(current, candidate)
  if (String(latest) !== String(candidate) || String(current) === String(candidate)) return false
  const currentMs = dateValue(current), candidateMs = dateValue(candidate)
  return currentMs != null && candidateMs != null ? candidateMs > currentMs : String(candidate) > String(current)
}

function sortedValues(values) {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)))
}

export function defaultCellWindow(now = Date.now()) {
  return {
    since: new Date(now - CELL_HEALTH_WINDOW_MS).toISOString(),
    until: null,
    label: 'last 7 days',
  }
}

export function defaultRunSetWindow(now = Date.now()) {
  return {
    since: new Date(now - RUN_SET_WINDOW_MS).toISOString(),
    until: null,
    label: 'last 24 hours',
  }
}

export function defaultIntakeWindow(now = Date.now()) {
  return {
    since: new Date(now - INTAKE_WINDOW_MS).toISOString(),
    until: null,
    label: 'last 24 hours',
  }
}

function intakeNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function intakeWindowTimestamp(rows, key) {
  let value = null
  for (const row of rows) value = laterTimestamp(value, row?.[key] ?? null)
  return value
}

function intakeReasonRow(row) {
  return {
    count: intakeNumber(row?.count),
    first_at: row?.first_at ?? null,
    last_at: row?.last_at ?? null,
  }
}

const INTAKE_CANDIDATE_UNMEASURED = 'this is what the loop last recorded per issue, not a live read of the board — an item the loop has not seen in this window does not appear here at all, and its absence is not eligibility'

function candidateBoard(row) {
  if (row?.board_owner == null && row?.board_project == null) return null
  return { owner: row?.board_owner ?? null, project: row?.board_project ?? null }
}

function candidateSourceMap(rows, countKey) {
  const map = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const issue = row?.issue ?? row?.picked_issue ?? null
    if (issue == null) continue
    const key = String(issue)
    const current = map.get(key) || { issue, latest: null, count: 0 }
    current.count += intakeNumber(row?.[countKey] ?? row?.count ?? 1)
    const candidate = { ...row, issue, board: candidateBoard(row), created_at: row?.created_at ?? null }
    if (!current.latest || (current.latest.created_at == null && candidate.created_at != null) || strictlyLaterTimestamp(current.latest.created_at, candidate.created_at)) current.latest = candidate
    map.set(key, current)
  }
  return map
}

function candidateIssueCompare(a, b) {
  const an = Number(a?.issue), bn = Number(b?.issue)
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
  return String(a?.issue ?? '').localeCompare(String(b?.issue ?? ''), undefined, { numeric: true })
}

function shapeIntakeCandidates({ candidate_refusals, candidate_picks, candidates_absent, refusals_absent } = {}) {
  const refusalRowsMeasured = Array.isArray(candidate_refusals)
  const pickRowsMeasured = Array.isArray(candidate_picks)
  const suppliedAbsent = typeof candidates_absent === 'string' && candidates_absent.length > 0 ? candidates_absent : null
  const absent = suppliedAbsent || (!refusalRowsMeasured || !pickRowsMeasured
    ? (typeof refusals_absent === 'string' && refusals_absent.length > 0 ? refusals_absent : 'intake candidate readout is unavailable')
    : null)
  if (absent) return { measured: false, absent, items: [], unmeasured: INTAKE_CANDIDATE_UNMEASURED }

  const refusalsByIssue = candidateSourceMap(candidate_refusals, 'refusals')
  const picksByIssue = candidateSourceMap(candidate_picks, 'picks')
  const keys = new Set([...refusalsByIssue.keys(), ...picksByIssue.keys()])
  const items = [...keys].map((key) => {
    const refusal = refusalsByIssue.get(key)
    const pick = picksByIssue.get(key)
    const refusalRow = refusal?.latest ?? null
    const pickRow = pick?.latest ?? null
    const pickedAt = pickRow?.created_at ?? null
    const refusedAt = refusalRow?.created_at ?? null
    const take = pickRow != null && (refusalRow == null || strictlyLaterTimestamp(refusedAt, pickedAt))
    const latest = take ? pickRow : refusalRow ?? pickRow
    const reason = refusalRow?.reason ?? null
    return {
      issue: refusal?.issue ?? pick?.issue ?? null,
      board: latest?.board ?? refusalRow?.board ?? pickRow?.board ?? null,
      verdict: take ? 'would-take' : 'would-refuse',
      reason,
      reason_recognised: INTAKE_REFUSAL_REASONS.includes(reason),
      detail: refusalRow?.detail ?? null,
      priority: refusalRow?.priority ?? null,
      refused_at: refusedAt,
      picked_at: pickedAt,
      last_seen_at: laterTimestamp(refusedAt, pickedAt),
      refusals: refusal?.count ?? 0,
      picks: pick?.count ?? 0,
    }
  }).sort(candidateIssueCompare)
  return { measured: true, absent: null, items, unmeasured: INTAKE_CANDIDATE_UNMEASURED }
}

export function shapeIntake({ sweeps, refusals, refusals_absent, picks, ever, absent, since, until, label,
  candidate_refusals, candidate_picks, candidates_absent } = {}) {
  const window = { since: since ?? null, until: until ?? null, label: label ?? null }
  const suppliedAbsent = typeof absent === 'string' && absent.length > 0 ? absent : null
  const absentReason = suppliedAbsent || (sweeps == null ? 'intake_sweeps readout is unavailable' : null)
  const sourceSweeps = absentReason ? [] : (Array.isArray(sweeps) ? sweeps : [])
  const outcomes = sourceSweeps.map((row) => {
    const reason = row?.reason ?? null
    return {
      outcome: row?.outcome ?? null,
      reason,
      recognised: INTAKE_REFUSAL_REASONS.includes(reason),
      count: intakeNumber(row?.count),
      first_at: row?.first_at ?? null,
      last_at: row?.last_at ?? null,
    }
  })

  let swept = 0, picked = 0, parked = 0, none = 0
  for (const row of outcomes) {
    swept += row.count
    if (row.outcome === 'picked') picked += row.count
    else if (row.outcome === 'parked') parked += row.count
    else if (row.outcome === 'none') none += row.count
  }
  const lastSweepInWindow = absentReason ? null : intakeWindowTimestamp(sourceSweeps, 'last_at')
  const everCount = absentReason ? null : (ever && Number.isFinite(Number(ever.sweeps)) ? Number(ever.sweeps) : swept)
  const firstSweepAt = absentReason ? null : (ever?.first_at ?? intakeWindowTimestamp(sourceSweeps, 'first_at'))
  const lastSweepAt = absentReason ? null : (ever?.last_at ?? lastSweepInWindow)
  const measuredCounts = absentReason ? { swept: null, picked: null, parked: null, none: null } : { swept, picked, parked, none }
  const windowLabel = window.label || 'the selected window'
  const countSummary = `the loop swept ${swept} time${swept === 1 ? '' : 's'} in this window: ${picked} picked, ${parked} parked, ${none} found nothing eligible`
  let state = 'unmeasured'
  let why = 'the intake tables predate this ledger mirror — whether the loop is running is not measured here, which is not the same as a loop that is idle.'
  if (!absentReason) {
    if (everCount === 0) {
      state = 'never-swept'
      why = 'no sweep has ever been recorded — the loop has not run. This is not the same as a loop that swept and found nothing.'
    } else if (swept === 0) {
      state = 'not-swept-in-window'
      why = `the loop last swept at ${lastSweepAt || 'an unknown time'}, before this window (${windowLabel}) — nothing in this window is not nothing ever.`
    } else if (parked > 0) {
      state = 'parked'
      why = `${countSummary} — a park is holding the queue.`
    } else if (picked > 0) {
      state = 'picking'
      why = `${countSummary} — the loop is picking work.`
    } else {
      state = 'swept-idle'
      why = `${countSummary} — it is running; the queue is empty.`
    }
  }

  const refusalAbsent = absentReason || (typeof refusals_absent === 'string' && refusals_absent.length > 0 ? refusals_absent : (refusals == null ? 'intake_refusals readout is unavailable' : null))
  const refusalMeasured = refusalAbsent == null && Array.isArray(refusals)
  const knownRefusals = new Map()
  const unrecognised = []
  const addKnownRefusal = (reason, row, fromSweep = false) => {
    const current = knownRefusals.get(reason)
    if (!current) {
      knownRefusals.set(reason, { ...intakeReasonRow(row), from_sweep: fromSweep })
      return
    }
    current.count += intakeNumber(row?.count)
    current.first_at = earlierTimestamp(current.first_at, row?.first_at ?? null)
    current.last_at = laterTimestamp(current.last_at, row?.last_at ?? null)
    current.from_sweep ||= fromSweep
  }
  const addUnrecognised = (row) => {
    unrecognised.push({
      reason: row?.reason ?? null,
      count: intakeNumber(row?.count),
      first_at: row?.first_at ?? null,
      last_at: row?.last_at ?? null,
    })
  }
  // A parked sweep carries the loop's refusal reason even when no per-issue
  // intake_refusals row exists. Keep this source separate for unrecognised
  // values, while folding recognised reasons into their canonical group.
  if (!absentReason) {
    for (const row of sourceSweeps) {
      const reason = row?.reason ?? null
      if (reason == null) continue
      if (INTAKE_REFUSAL_REASONS.includes(reason)) addKnownRefusal(reason, row, true)
      else addUnrecognised(row)
    }
  }
  if (refusalMeasured) {
    for (const row of refusals) {
      const reason = row?.reason ?? null
      if (INTAKE_REFUSAL_REASONS.includes(reason)) addKnownRefusal(reason, row)
      else addUnrecognised(row)
    }
  }

  const groups = INTAKE_REFUSAL_GROUPS.map((group) => ({
    group: group.group,
    title: group.title,
    asserts: group.asserts,
    reasons: group.reasons.map((reason) => {
      const row = knownRefusals.get(reason)
      const sourceMeasured = refusalMeasured || row?.from_sweep === true
      const count = sourceMeasured ? (row?.count ?? 0) : null
      return {
        reason,
        count,
        state: sourceMeasured ? (count === 0 ? 'not-in-window' : 'refused') : 'unmeasured',
        first_at: sourceMeasured ? (row?.first_at ?? null) : null,
        last_at: sourceMeasured ? (row?.last_at ?? null) : null,
      }
    }),
  }))

  const shapedPicks = absentReason ? [] : (Array.isArray(picks) ? picks.map((row) => ({
    issue: row?.picked_issue ?? null,
    board: row?.board_owner == null && row?.board_project == null
      ? null
      : { owner: row?.board_owner ?? null, project: row?.board_project ?? null },
    at: row?.created_at ?? null,
  })) : [])
  const candidates = shapeIntakeCandidates({ candidate_refusals, candidate_picks, candidates_absent, refusals_absent })
  return {
    window,
    absent: absentReason,
    loop: {
      state,
      why,
      ...measuredCounts,
      first_sweep_at: firstSweepAt,
      last_sweep_at: lastSweepAt,
      last_sweep_in_window_at: lastSweepInWindow,
    },
    outcomes,
    picks: shapedPicks,
    refusals: {
      measured: refusalMeasured,
      absent: refusalAbsent,
      groups,
      unrecognised,
    },
    candidates,
    unmeasured: {
      window: 'the window is a view, not the whole history — it cannot say whether the loop swept outside the selected window',
    },
    readonly: true,
  }
}

const RUN_SET_STATUSES = ['running', 'ok', 'fail', 'aborted']
const RUN_SET_BILLED_KEYS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
const PARKED_NOTE = 'not measured here — a park is a per-crew-dir file in the reclaim store (crew/reclaim.mjs), which the ledger has no key to enumerate; this view reads the ledger only, so parks are unmeasured, never zero'
const PER_RUN_UNMEASURED_NOTE = 'no `agent_sessions` rows for this run: a pane-transport seat reports no usage by design (crew/daemon.mjs:81-83), and a pre-#119 or below-NODE_FLOOR headless run records none either; the ledger persists no per-run transport, so this view cannot tell them apart — unmeasured, never a measured zero.'
const BUDGET_PROVENANCE = 'the ceiling is declared to this view; the daemon holds its own ceiling in memory only (crew/daemon.mjs:301-328), so nothing pins these two values equal.'
const DEGRADED_ABSENT_WHY = 'the ledger read that answered this window was degraded — the window is unanswerable, never a measured zero: a degraded reader answers no rows whether or not any run exists'

// A degraded read answers an EMPTY row set, not a null one, so the absence has
// to be carried by the flag its source reports rather than by the rows. The
// flag must be read AFTER the query it reports on: the ledger's db open is
// lazy, so a handle asked for stats() before its first query answers
// `degraded: false` even for a database that cannot be opened.
function degradedAbsence(degraded, reason) {
  if (degraded !== true) return null
  const named = typeof reason === 'string' && reason.length > 0 ? reason : 'the source reported no reason'
  return `${DEGRADED_ABSENT_WHY} (${named})`
}

function finiteBudgetNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function budgetBlock({ ceiling = null, burn = null, since = null, until = null, absent = null } = {}) {
  const budget = {
    ceiling_tokens: null,
    window_ms: null,
    source: null,
    provenance: BUDGET_PROVENANCE,
    burn_tokens: null,
    agent_sessions: null,
    comparable: false,
    headroom_tokens: null,
    fraction: null,
    pending: null,
  }
  if (absent) {
    budget.pending = absent
    return budget
  }
  if (ceiling == null) {
    budget.pending = 'no budget ceiling is declared to this view'
    return budget
  }
  budget.source = ceiling?.source ?? null
  if (ceiling?.error) {
    budget.pending = `budget ceiling refused: ${ceiling.error}`
    return budget
  }
  const ceilingTokens = finiteBudgetNumber(ceiling?.max_tokens)
  const ceilingWindow = finiteBudgetNumber(ceiling?.window_ms)
  if (ceilingTokens == null || ceilingTokens < 1 || ceilingWindow == null || ceilingWindow < 1) {
    budget.pending = 'budget ceiling is malformed — comparison refused without a valid token ceiling and window'
    return budget
  }
  budget.ceiling_tokens = ceilingTokens
  budget.window_ms = ceilingWindow

  if (burn?.measured !== true) {
    budget.pending = burn?.absent || burn?.why || 'budget burn is unmeasured — comparison refused'
    return budget
  }
  const burnTokens = finiteBudgetNumber(burn?.total)
  const sessions = finiteBudgetNumber(burn?.sessions)
  if (burnTokens == null || sessions == null || burnTokens < 0 || sessions < 0) {
    budget.pending = burn?.absent || 'budget burn returned no measured token total or session count'
    return budget
  }
  budget.burn_tokens = burnTokens
  budget.agent_sessions = sessions

  const sinceMs = dateValue(since)
  const endMs = until == null ? Date.now() : dateValue(until)
  const queriedWindow = sinceMs == null || endMs == null ? null : endMs - sinceMs
  if (queriedWindow == null || Math.abs(queriedWindow - ceilingWindow) > 1000) {
    budget.pending = `budget windows differ — declared ${ceilingWindow}ms, queried ${queriedWindow == null ? 'unavailable' : `${queriedWindow}ms`}`
    return budget
  }
  budget.comparable = true
  budget.headroom_tokens = Math.max(0, ceilingTokens - burnTokens)
  budget.fraction = burnTokens / ceilingTokens
  return budget
}

export function shapeRunSet({ rows, absent, degraded = false, degraded_reason = null, since, until, label, ceiling = null, burn = null } = {}) {
  const window = { since: since ?? null, until: until ?? null, label: label ?? null }
  const suppliedAbsent = typeof absent === 'string' && absent.length > 0 ? absent : null
  const degradedAbsent = degradedAbsence(degraded, degraded_reason)
  const absentReason = suppliedAbsent || degradedAbsent
  const degradedState = {
    degraded: degraded === true,
    degraded_reason: degraded === true && typeof degraded_reason === 'string' && degraded_reason.length > 0 ? degraded_reason : null,
  }
  if (absentReason) {
    return {
      window,
      absent: absentReason,
      ...degradedState,
      runs: null,
      settled: null,
      usage: null,
      coverage: null,
      usage_mean_tokens_per_measured_run: null,
      budget: budgetBlock({ absent: absentReason }),
      unmeasured: { parked: PARKED_NOTE, per_run: PER_RUN_UNMEASURED_NOTE },
      rows: [],
    }
  }

  const source = Array.isArray(rows) ? rows : []
  const settled = Object.fromEntries(RUN_SET_STATUSES.map((status) => [status, 0]))
  const measuredRows = source.filter((row) => RUN_SET_BILLED_KEYS.some((key) => row?.[key] != null))
  for (const row of source) {
    if (Object.prototype.hasOwnProperty.call(settled, row?.status)) settled[row.status] += 1
  }

  let agentSessions = 0
  for (const row of source) {
    const value = finiteBudgetNumber(row?.agent_sessions)
    if (value != null) agentSessions += value
  }
  let usage = null
  if (agentSessions > 0) {
    usage = {
      agent_sessions: agentSessions,
    }
    for (const key of RUN_SET_BILLED_KEYS) {
      const values = measuredRows.map((row) => row?.[key]).filter((value) => value != null)
      usage[key] = values.length ? values.reduce((total, value) => total + Number(value), 0) : null
    }
  }

  let measuredTokenTotal = 0
  for (const row of measuredRows) {
    for (const key of RUN_SET_BILLED_KEYS) {
      const value = finiteBudgetNumber(row?.[key])
      if (value != null) measuredTokenTotal += value
    }
  }
  const usageMean = measuredRows.length ? measuredTokenTotal / measuredRows.length : null

  const unmeasured = { parked: PARKED_NOTE, per_run: PER_RUN_UNMEASURED_NOTE }
  const hasUnmeasuredUsage = source.length > 0 && (agentSessions === 0 || source.some((row) => RUN_SET_BILLED_KEYS.some((key) => row?.[key] == null)))
  if (hasUnmeasuredUsage) {
    unmeasured.usage = agentSessions === 0
      ? 'no agent_sessions rows for any run in this window — predates per-agent token measurement (#119), not a measured zero'
      : 'one or more agent_sessions rows for runs in this window have no billed token totals — unmeasured, not a measured zero'
  }

  const shapedRows = source.map((row) => {
    const started = dateValue(row?.started_at)
    const ended = dateValue(row?.ended_at)
    const usageMeasured = RUN_SET_BILLED_KEYS.some((key) => row?.[key] != null)
    return {
      adw_id: row?.adw_id ?? null,
      task_slug: row?.task_slug ?? null,
      repo_slug: row?.repo_slug ?? null,
      status: row?.status ?? null,
      started_at: row?.started_at ?? null,
      ended_at: row?.ended_at ?? null,
      duration_ms: started == null || ended == null ? null : ended - started,
      agent_sessions: row?.agent_sessions ?? null,
      billed_input_tokens: row?.billed_input_tokens ?? null,
      billed_output_tokens: row?.billed_output_tokens ?? null,
      billed_cache_write_tokens: row?.billed_cache_write_tokens ?? null,
      billed_cache_read_tokens: row?.billed_cache_read_tokens ?? null,
      usage_measured: usageMeasured,
      usage_state: usageMeasured ? 'measured' : 'unmeasured',
    }
  })

  return {
    window,
    absent: null,
    ...degradedState,
    runs: source.length,
    settled,
    usage,
    coverage: { measured: measuredRows.length, total: source.length },
    usage_mean_tokens_per_measured_run: usageMean,
    budget: budgetBlock({ ceiling, burn, since, until }),
    unmeasured,
    rows: shapedRows,
  }
}

export function defaultTeardownWindow(now = Date.now()) {
  return {
    since: new Date(now - SEAT_TEARDOWN_WINDOW_MS).toISOString(),
    until: null,
    label: 'last 24 hours',
  }
}

const NOT_MEASURED_WHY = 'no `seat_teardowns` rows for this run — not measured, never a measured zero and never a clean floor: a run predating the table, a crew with no piped seats, and a headless-json seat all record nothing here'
const NOT_MEASURED_WHY_FOR_CONSOLE = NOT_MEASURED_WHY.replace('never a clean floor', 'never a settled floor')
const TEARDOWN_READONLY_NOTE = 'this view reads the ledger; teardown and reclamation belong to the crew runtime, and nothing here can kill, reclaim or boot anything'
const TEARDOWN_WINDOW_NOTE = 'runs are those started in this window; a teardown row for a run outside it is not shown here'

function teardownForced(value) {
  return value === true || value === 1 || value === '1'
}

function teardownSeat(row = {}) {
  const outcome = row?.outcome ?? null
  return {
    role: row?.role ?? null,
    transport: row?.transport ?? null,
    outcome,
    known: SEAT_TEARDOWN_OUTCOMES.includes(outcome),
    reason: row?.reason ?? null,
    forced: teardownForced(row?.forced),
    evidence_kind: row?.evidence_kind ?? null,
    phase_id: row?.phase_id ?? null,
    at: row?.created_at ?? null,
  }
}

function teardownRoleRank(role) {
  const rank = ROLE_ORDER.indexOf(String(role ?? ''))
  return rank < 0 ? ROLE_ORDER.length : rank
}

function sortTeardownSeats(a, b) {
  const rank = teardownRoleRank(a?.role) - teardownRoleRank(b?.role)
  if (rank !== 0) return rank
  return String(a?.role ?? '').localeCompare(String(b?.role ?? ''))
}

function emptyTeardownTally() {
  return { seats: null, proven: null, failed: null, unproven: null, unrecognised: null }
}

function teardownTally(rows = []) {
  const tally = { seats: rows.length, proven: 0, failed: 0, unproven: 0, unrecognised: 0 }
  for (const row of rows) {
    if (SEAT_TEARDOWN_OUTCOMES.includes(row?.outcome)) tally[row.outcome] += 1
    else tally.unrecognised += 1
  }
  return tally
}

export function shapeSeatTeardowns({ runs, rows, absent, since, until, label } = {}) {
  const window = { since: since ?? null, until: until ?? null, label: label ?? null }
  const suppliedAbsent = typeof absent === 'string' && absent.length > 0 ? absent : null
  const absentReason = suppliedAbsent || (runs == null || rows == null ? 'seat teardown readout is unavailable' : null)
  const sourceRuns = Array.isArray(runs) ? runs : []
  const sourceRows = Array.isArray(rows) ? rows : []
  const rowsByRun = new Map()
  if (!absentReason) {
    for (const row of sourceRows) {
      if (row?.adw_id == null) continue
      const key = String(row.adw_id)
      const grouped = rowsByRun.get(key) || []
      grouped.push(row)
      rowsByRun.set(key, grouped)
    }
  }
  const measured = absentReason == null && sourceRows.length > 0
  const shapedRuns = sourceRuns.map((run) => {
    const runRows = absentReason ? [] : (rowsByRun.get(String(run?.adw_id)) || [])
    const runMeasured = absentReason == null && runRows.length > 0
    const tally = runMeasured ? teardownTally(runRows) : emptyTeardownTally()
    return {
      adw_id: run?.adw_id ?? null,
      task_slug: run?.task_slug ?? null,
      repo_slug: run?.repo_slug ?? null,
      run_status: run?.status ?? null,
      started_at: run?.started_at ?? null,
      ended_at: run?.ended_at ?? null,
      measured: runMeasured,
      state: absentReason ? 'undetermined' : runMeasured ? 'measured' : 'not-measured',
      not_measured_why: absentReason || (runMeasured ? null : NOT_MEASURED_WHY_FOR_CONSOLE),
      tally,
      seats: runMeasured ? runRows.map(teardownSeat).sort(sortTeardownSeats) : [],
    }
  })
  const totals = measured
    ? teardownTally(sourceRows)
    : emptyTeardownTally()
  if (measured) totals.runs = sourceRuns.length
  else totals.runs = null
  return {
    window,
    absent: absentReason,
    measured,
    outcomes: [...SEAT_TEARDOWN_OUTCOMES],
    note: TEARDOWN_READONLY_NOTE,
    window_note: TEARDOWN_WINDOW_NOTE,
    totals,
    runs: shapedRuns,
  }
}

export function shapeCellHealth({ rows, absent, roster, since, until, label } = {}) {
  const window = { since: since ?? null, until: until ?? null, label: label ?? null }
  const absentReason = typeof absent === 'string' && absent.length > 0 ? absent : null
  const cells = new Map()
  const ensureCell = ({ provider, model_id, agent, effort, seated = false } = {}) => {
    const key = cellKey(provider, model_id, agent, effort)
    let cell = cells.get(key)
    if (!cell) {
      cell = {
        key, provider, model_id, agent, effort,
        roles: new Set(), tiers: new Set(), seated,
        failures: 0, run_less: 0, first_at: null, last_at: null,
        by_kind: new Map(),
      }
      cells.set(key, cell)
    } else if (seated) {
      cell.seated = true
    }
    return cell
  }

  // An absent readout is not an empty measurement. The roster may still
  // enumerate seats, but their evidence remains undetermined.
  if (!absentReason) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const cell = ensureCell({
        provider: row?.provider ?? null,
        model_id: row?.model_id ?? null,
        agent: row?.agent ?? null,
        effort: row?.effort ?? null,
      })
      const failures = countValue(row?.failures)
      const run_less = countValue(row?.run_less)
      cell.failures += failures
      cell.run_less += run_less
      if (row?.role != null) cell.roles.add(row.role)
      cell.first_at = earlierTimestamp(cell.first_at, row?.first_at ?? null)
      cell.last_at = laterTimestamp(cell.last_at, row?.last_at ?? null)
      const kind = row?.kind ?? '—'
      const byKind = cell.by_kind.get(kind) || { kind, failures: 0, run_less: 0 }
      byKind.failures += failures
      byKind.run_less += run_less
      cell.by_kind.set(kind, byKind)
    }
  }

  let silent_unknown = absentReason
  const tiers = Array.isArray(roster?.tiers) ? roster.tiers : null
  if (!tiers) {
    silent_unknown = roster?.error || silent_unknown || 'the roster could not be read — cells with no failures cannot be enumerated'
  } else {
    for (const tier of tiers) {
      const tierName = tier?.tier ?? null
      for (const seat of Array.isArray(tier?.seats) ? tier.seats : []) {
        const cell = ensureCell({
          provider: seat?.provider ?? null,
          model_id: seat?.model_id ?? seat?.id ?? null,
          agent: seat?.agent ?? null,
          effort: seat?.effort ?? null,
          seated: true,
        })
        if (seat?.role != null) cell.roles.add(seat.role)
        if (tierName != null) cell.tiers.add(tierName)
      }
    }
  }

  const models = new Map()
  for (const model of Array.isArray(roster?.models) ? roster.models : []) {
    const key = model?.key ?? (model?.provider != null && model?.id != null ? `${model.provider}/${model.id}` : null)
    if (key != null) models.set(String(key), model)
  }
  const priceFor = (cell) => {
    const key = cell.provider == null || cell.model_id == null ? null : `${cell.provider}/${cell.model_id}`
    const model = key == null ? null : models.get(key)
    if (!model) return { price: null, price_pending: 'not in the roster model catalog' }
    return {
      price: {
        cost_in_per_mtok: model.cost_in_per_mtok ?? null,
        cost_out_per_mtok: model.cost_out_per_mtok ?? null,
        context: model.context ?? null,
        source: model.source ?? null,
        last_verified: model.last_verified ?? null,
      },
      price_pending: null,
    }
  }

  const shaped = [...cells.values()].map((cell) => {
    const undetermined = Boolean(absentReason)
    const failures = undetermined ? null : cell.failures
    const run_less = undetermined ? null : cell.run_less
    const state = undetermined
      ? 'undetermined'
      : failures === 0 ? 'silent' : (failures > 0 && run_less === failures ? 'run-less-only' : 'recorded')
    const by_kind = undetermined ? [] : [...cell.by_kind.values()]
      .sort((a, b) => b.failures - a.failures || String(a.kind).localeCompare(String(b.kind)))
      .map((kind) => ({ ...kind }))
    return {
      key: cell.key,
      provider: cell.provider,
      model_id: cell.model_id,
      agent: cell.agent,
      effort: cell.effort,
      roles: sortedValues(cell.roles),
      tiers: sortedValues(cell.tiers),
      seated: cell.seated,
      state,
      ...priceFor(cell),
      failures,
      run_less,
      in_run: undetermined ? null : failures - run_less,
      first_at: undetermined ? null : cell.first_at,
      last_at: undetermined ? null : cell.last_at,
      by_kind,
      ...(undetermined ? { undetermined_why: absentReason } : {}),
    }
  })
  shaped.sort((a, b) => {
    const aUndetermined = a.state === 'undetermined', bUndetermined = b.state === 'undetermined'
    if (aUndetermined !== bUndetermined) return aUndetermined ? 1 : -1
    const aSilent = a.state === 'silent', bSilent = b.state === 'silent'
    if (aSilent !== bSilent) return aSilent ? 1 : -1
    if (!aUndetermined && a.failures !== b.failures) return b.failures - a.failures
    return a.key.localeCompare(b.key)
  })
  return { window, absent: absentReason, silent_unknown, cells: shaped }
}

export { pendingFor }
