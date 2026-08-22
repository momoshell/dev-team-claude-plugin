const TOKEN_FIELDS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
const RUN_SET_STATUSES = ['running', 'ok', 'fail', 'aborted']
const FINDINGS_PENDING = 'findings unavailable — this review predates structured findings (#170)'
const UNPROVEN_TITLE = 'no evidence was obtainable — a direct DI caller without runClean, or a contained stash failure. Absence of evidence is not evidence of absence (ADR-030).'
const ACCEPTED_TITLE = 'typed accept held — residuals were accepted'
const REFUSED_TITLE = 'typed accept refused — loop failed closed to escalate'

// #442 residue: these three panels read once at mount, so what they show is a
// fact about their read, not about now. The reading is dated at the shaping hop
// from a clock the caller injects — never a live Date read in here, or no test
// could pin the boundary.
export const PANEL_REFRESH_MS = 3000
export const PANEL_STALE_AFTER_MS = 30000

export function panelAgeLabel(age_ms) {
  if (typeof age_ms !== 'number' || !Number.isFinite(age_ms) || age_ms < 0) return null
  if (age_ms < 60000) return `${Math.round(age_ms / 1000)}s`
  if (age_ms < 3600000) return `${Math.floor(age_ms / 60000)}m`
  return `${Math.floor(age_ms / 3600000)}h${Math.floor((age_ms % 3600000) / 60000)}m`
}

export function readFreshness(read_at = null, now = null, refresh_ms = null) {
  const refresh = typeof refresh_ms === 'number' && Number.isFinite(refresh_ms) && refresh_ms > 0 ? refresh_ms : null
  const refresh_label = refresh == null
    ? 'this panel does not re-read — reload to take a new reading'
    : `re-reads every ${panelAgeLabel(refresh)}`
  const dated = typeof read_at === 'number' && Number.isFinite(read_at) && typeof now === 'number' && Number.isFinite(now) && now >= read_at
  if (!dated) return { read_at: null, age_ms: null, stale: false, dated: false, label: 'read time unavailable — this reading cannot be dated', refresh_label }
  const age_ms = now - read_at
  const stale = age_ms > PANEL_STALE_AFTER_MS
  return {
    read_at,
    age_ms,
    stale,
    dated: true,
    label: stale
      ? `read ${panelAgeLabel(age_ms)} ago — older than the ${panelAgeLabel(PANEL_STALE_AFTER_MS)} staleness floor, so this may no longer be true`
      : `read ${panelAgeLabel(age_ms)} ago`,
    refresh_label,
  }
}

export function panelReadLoop(read, options = {}) {
  const refresh_ms = typeof options.refresh_ms === 'number' && Number.isFinite(options.refresh_ms) && options.refresh_ms > 0 ? options.refresh_ms : PANEL_REFRESH_MS
  const start = typeof options.setInterval === 'function' ? options.setInterval : setInterval
  const end = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval
  read()
  const timer = start(read, refresh_ms)
  return () => end(timer)
}

export function fleetTokens(runs = []) {
  const source = Array.isArray(runs) ? runs : []
  let total = null
  let measured = 0
  for (const run of source) {
    const metrics = run?.metrics ?? run ?? {}
    let runTotal = null
    for (const field of TOKEN_FIELDS) {
      const value = metrics?.[field]
      if (typeof value === 'number' && Number.isFinite(value)) runTotal = (runTotal ?? 0) + value
    }
    if (runTotal == null) continue
    total = (total ?? 0) + runTotal
    measured += 1
  }
  const pending = total == null ? (source[0]?.pending?.billed_input_tokens || 'predates this measurement') : null
  return { total, measured, runs: source.length, pending }
}

export function fleetCost() {
  return { usd: null, pending: 'money deferred — a subscription seat is not billed per token (#185)' }
}

const TERMINAL_STATUSES = ['ok', 'fail', 'aborted']
const DEGRADED_FEED_WHY = 'the sessions feed answered degraded — this window is unanswerable, never a measured zero'
const UNMEASURED_WINDOW_WHY = 'no run in this window carried a recorded outcome — an unmeasured window is never a zero'

// A degraded read answers rows it cannot vouch for, and sometimes answers none at
// all; either way the window is unanswerable. Mirrors shape.mjs's degradedAbsence.
function feedAbsence(options = {}) {
  if (options?.degraded === true) return { pending: DEGRADED_FEED_WHY }
  return null
}

function envelopeFor(envelopes, adwId) {
  if (envelopes instanceof Map) return envelopes.get(adwId) || null
  if (envelopes && typeof envelopes === 'object') return envelopes[adwId] || null
  return null
}

export function fleetPassRate(runs = [], options = {}) {
  const absence = feedAbsence(options)
  const rows = Array.isArray(runs) ? runs : []
  const measuredRows = absence ? [] : rows.filter((run) => TERMINAL_STATUSES.includes(run?.status))
  const measured = measuredRows.length
  if (measured === 0) return { percent: null, measured: 0, runs: rows.length, pending: absence?.pending ?? UNMEASURED_WINDOW_WHY }
  const passed = measuredRows.filter((run) => run?.status === 'ok').length
  return { percent: Math.round(passed / measured * 100), measured, runs: rows.length, pending: null }
}

export function fleetMedianDuration(runs = [], options = {}) {
  const absence = feedAbsence(options)
  const rows = Array.isArray(runs) ? runs : []
  const durations = absence
    ? []
    : rows
      .map((run) => run?.duration_ms)
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)
  const measured = durations.length
  if (measured === 0) return { ms: null, measured: 0, runs: rows.length, pending: absence?.pending ?? UNMEASURED_WINDOW_WHY }
  const middle = Math.floor(measured / 2)
  const ms = measured % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2
  return { ms, measured, runs: rows.length, pending: null }
}

export function fleetPhasesPerRun(runs = [], options = {}) {
  const absence = feedAbsence(options)
  const rows = Array.isArray(runs) ? runs : []
  const measuredRows = absence ? [] : rows.filter((run) => Array.isArray(run?.phases))
  const measured = measuredRows.length
  if (measured === 0) return { average: null, measured: 0, runs: rows.length, pending: absence?.pending ?? UNMEASURED_WINDOW_WHY }
  const total = measuredRows.reduce((sum, run) => sum + run.phases.length, 0)
  return { average: total / measured, measured, runs: rows.length, pending: null }
}

export function fleetEscalationRate(runs = [], options = {}) {
  const absence = feedAbsence(options)
  const rows = Array.isArray(runs) ? runs : []
  const measuredRows = absence ? [] : rows.filter((run) => TERMINAL_STATUSES.includes(run?.status))
  const measured = measuredRows.length
  if (measured === 0) return { percent: null, escalated: 0, measured: 0, runs: rows.length, pending: absence?.pending ?? UNMEASURED_WINDOW_WHY }
  const escalated = measuredRows.filter((run) => run?.status === 'fail' || run?.status === 'aborted' || run?.agents?.some((agent) => agent?.outcome === 'escalate') || envelopeFor(options?.envelopes, run?.adw_id)?.status === 'escalation').length
  return { percent: Math.round(escalated / measured * 100), escalated, measured, runs: rows.length, pending: null }
}

export function rosterPanel(payload = {}) {
  if (payload?.tiers == null) {
    return {
      tiers: [],
      models: [],
      updated_at: null,
      path: payload?.path ?? null,
      pending: payload?.error || 'roster unavailable — no reason was reported',
    }
  }

  const tiers = Array.isArray(payload.tiers) ? payload.tiers.map((tier) => ({
    ...tier,
    seats: Array.isArray(tier?.seats) ? tier.seats.map((seat) => {
      const model = seat?.model ?? null
      return { ...seat, model, model_pending: model ? null : 'not in the roster model catalog' }
    }) : [],
  })) : []
  return {
    tiers,
    models: Array.isArray(payload.models) ? payload.models : [],
    updated_at: payload.updated_at ?? null,
    path: payload.path ?? null,
    pending: null,
  }
}

export function rosterEditForm(payload = {}, selection = {}) {
  const unavailable = payload?.error || 'roster unavailable — no reason was reported'
  if (!Array.isArray(payload?.tiers) || payload.tiers.length === 0) {
    return { tiers: [], roles: [], cell: null, pending: unavailable }
  }
  const tiers = payload.tiers
    .map((tier) => tier?.tier)
    .filter((tier) => typeof tier === 'string' && tier.length > 0)
  if (!tiers.length) return { tiers: [], roles: [], cell: null, pending: unavailable }
  const selectedTier = tiers.includes(selection?.tier) ? selection.tier : tiers[0]
  const tier = payload.tiers.find((candidate) => candidate?.tier === selectedTier)
  const roles = []
  for (const seat of Array.isArray(tier?.seats) ? tier.seats : []) {
    if (typeof seat?.role === 'string' && !roles.includes(seat.role)) roles.push(seat.role)
  }
  for (const role of Array.isArray(tier?.unseated) ? tier.unseated : []) {
    if (typeof role === 'string' && !roles.includes(role)) roles.push(role)
  }
  if (!roles.length) return { tiers, roles: [], cell: null, pending: unavailable }
  const selectedRole = roles.includes(selection?.role) ? selection.role : roles[0]
  const seat = (Array.isArray(tier?.seats) ? tier.seats : []).find((candidate) => candidate?.role === selectedRole)
  const cell = seat ? {
    provider: seat.provider ?? '',
    id: seat.id ?? '',
    agent: seat.agent ?? '',
    effort: seat.effort ?? '',
  } : null
  return { tiers, roles, cell, pending: null }
}

export function rosterProposal(response = null) {
  const refusals = Array.isArray(response?.refusals) ? response.refusals : []
  if (response?.ok === true && typeof response.diff === 'string') return { diff: response.diff, refusals, pending: null }
  const pending = response?.error || (refusals.length ? 'roster edit refused' : 'roster proposal unavailable')
  return { diff: null, refusals, pending }
}

export function gateChips(run = {}) {
  const generations = Array.isArray(run.gate_generations)
    ? [...run.gate_generations].sort((a, b) => (a?.gate_generation ?? 0) - (b?.gate_generation ?? 0))
    : []
  if (!generations.length) return { chips: [], repaired: false, pending: run.pending?.gate_discrimination ?? 'predates this measurement' }
  const chips = generations.map((row) => {
    const verdict = row?.verdict
    const tone = verdict === 'proven' || verdict === 'failed' || verdict === 'unproven' ? verdict : 'unproven'
    const generation = row?.gate_generation ?? null
    const labelGeneration = generation ?? '—'
    const label = tone === 'proven'
      ? `gate proven to discriminate (gen ${labelGeneration})`
      : tone === 'failed'
        ? `gate did not discriminate (gen ${labelGeneration})`
        : `gate discrimination unproven (gen ${labelGeneration})`
    const title = tone === 'unproven'
      ? UNPROVEN_TITLE
      : tone === 'proven'
        ? 'gate evidence shows the check discriminated'
        : 'gate evidence shows the check did not discriminate'
    return {
      generation,
      verdict: tone,
      tone,
      label,
      title,
      checks: {
        total: row?.checks_total ?? null,
        failed: row?.checks_failed ?? null,
        errored: row?.checks_errored ?? null,
      },
    }
  })
  return { chips, repaired: chips.length > 1, pending: null }
}

export function reviewRows(run = {}) {
  const reviews = Array.isArray(run.reviews) ? run.reviews : []
  if (!reviews.length) return { rows: [], pending: run.pending?.reviews ?? 'predates this measurement' }
  const rows = reviews.map((row, index) => ({
    round: index + 1,
    role: row?.role ?? null,
    dispatch_id: row?.dispatch_id ?? null,
    verdict: row?.verdict ?? null,
    must_fix: row?.must_fix ?? null,
    should_fix: row?.should_fix ?? null,
    consider: row?.consider ?? null,
    created_at: row?.created_at ?? null,
  }))
  return { rows, pending: null }
}

export function acceptRows(run = {}) {
  const decisions = Array.isArray(run.accept_decisions) ? run.accept_decisions : []
  if (!decisions.length) return { rows: [], refused: 0, pending: run.pending?.accept_decisions ?? 'predates this measurement' }
  const rows = decisions.map((row, index) => {
    const held = row?.outcome === 'accepted'
    return {
      seq: index + 1,
      where_at: row?.where_at ?? null,
      outcome: row?.outcome ?? null,
      tone: held ? 'held' : 'refused',
      label: held ? 'accepted with residuals' : 'accept refused — failed closed to escalate',
      title: held ? ACCEPTED_TITLE : REFUSED_TITLE,
      findings_total: row?.findings_total ?? null,
      residual_count: row?.residual_count ?? null,
      refuted_count: row?.refuted_count ?? null,
      cosmetic_count: row?.cosmetic_count ?? null,
      unverified_count: row?.unverified_count ?? null,
      invalid_reasons: row?.invalid_reasons ?? null,
      created_at: row?.created_at ?? null,
    }
  })
  return { rows, refused: rows.filter((row) => row.tone === 'refused').length, pending: null }
}

const CELL_HEALTH_NOTE = 'this window is the board’s own; the boot breaker (#45) owns cell policy and its own window'

function cellDisplayPart(value) {
  return value == null ? '—' : String(value)
}

function panelNumber(value) {
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: 6 }) : null
}

export function cellHealthPanel(payload = {}, clock = {}) {
  const absent = payload?.absent ?? null
  const window = payload?.window
  const window_label = window && typeof window === 'object'
    ? `${window.label} · since ${window.since} · until ${window.until || 'now'}`
    : 'window unavailable'
  const view = {
    absent,
    freshness: readFreshness(clock?.read_at ?? null, clock?.now ?? null, clock?.refresh_ms ?? null),
    silent_unknown: payload?.silent_unknown ?? null,
    window_label,
    note: CELL_HEALTH_NOTE,
    rows: [],
  }

  view.rows = (Array.isArray(payload?.cells) ? payload.cells : []).map((row) => {
    const state = row?.state
    const tone = state === 'undetermined' ? 'undetermined' : state === 'silent' ? 'silent' : state === 'run-less-only' ? 'run-less' : 'recorded'
    const failures = row?.failures ?? null
    const run_less = row?.run_less ?? null
    const in_run = row?.in_run ?? null
    const label = state === 'undetermined'
      ? `health cannot be determined — ${row?.undetermined_why || 'the failure readout is unavailable'}`
      : state === 'silent'
        ? 'no failures recorded in this window'
        : state === 'run-less-only'
          ? `${failures} failure${failures === 1 ? '' : 's'}, all run-less — refused before any run existed`
          : `${in_run} in run · ${run_less} run-less`
    const roles = Array.isArray(row?.roles) ? row.roles : []
    const tiers = Array.isArray(row?.tiers) ? row.tiers : []
    const priceParts = []
    const inputPrice = panelNumber(row?.price?.cost_in_per_mtok)
    const outputPrice = panelNumber(row?.price?.cost_out_per_mtok)
    if (inputPrice != null) priceParts.push(`in $${inputPrice}/Mtok`)
    if (outputPrice != null) priceParts.push(`out $${outputPrice}/Mtok`)
    return {
      key: row?.key ?? null,
      title: `${cellDisplayPart(row?.provider)}/${cellDisplayPart(row?.model_id)} · ${cellDisplayPart(row?.agent)} · ${cellDisplayPart(row?.effort)}`,
      model_label: `${cellDisplayPart(row?.provider)}/${cellDisplayPart(row?.model_id)}`,
      price_label: priceParts.length ? priceParts.join(' · ') : null,
      price_pending: row?.price_pending ?? (row?.price == null ? 'not in the roster model catalog' : null),
      roles_label: roles.length ? roles.join(', ') : '—',
      tiers_label: tiers.length ? tiers.join(', ') : '—',
      state,
      tone,
      label,
      failures,
      run_less,
      in_run,
      kinds: (Array.isArray(row?.by_kind) ? row.by_kind : []).map((kind) => ({
        kind: kind?.kind ?? null,
        failures: kind?.failures ?? null,
        run_less: kind?.run_less ?? null,
        label: `${kind?.kind ?? '—'} ×${kind?.failures ?? '—'}`,
      })),
      first_at: row?.first_at ?? null,
      last_at: row?.last_at ?? null,
      seated: row?.seated ?? false,
    }
  })
  return view
}

const TEARDOWN_OUTCOMES = ['proven', 'failed', 'unproven']
const TEARDOWN_READONLY_NOTE = 'this view reads the ledger; teardown and reclamation belong to the crew runtime, and nothing here can kill, reclaim or boot anything'
const TEARDOWN_WINDOW_NOTE = 'runs are those started in this window; a teardown row for a run outside it is not shown here'

function teardownDisplayPart(value) {
  return value == null ? '—' : String(value)
}

function teardownDisplayCount(value) {
  return panelNumber(value) ?? '—'
}

function teardownForced(value) {
  return value === true || value === 1 || value === '1'
}

function teardownSeatTone(row) {
  const known = row?.known == null ? TEARDOWN_OUTCOMES.includes(row?.outcome) : row.known === true
  return known && TEARDOWN_OUTCOMES.includes(row?.outcome) ? row.outcome : 'unrecognised'
}

function teardownRunTone(state, seats) {
  if (state === 'undetermined') return 'undetermined'
  if (state === 'not-measured') return 'not-measured'
  if (seats.some((seat) => seat.tone === 'failed')) return 'leak'
  if (seats.some((seat) => seat.tone === 'unproven' || seat.tone === 'unrecognised')) return 'unproven'
  return 'proven'
}

export function teardownPanel(payload = {}, clock = {}) {
  const absent = payload?.absent ?? null
  const measured = payload?.measured === true
  const window = payload?.window
  const window_label = window && typeof window === 'object'
    ? `${window.label} · since ${window.since} · until ${window.until || 'now'}`
    : 'window unavailable'
  const headline = absent
    ? 'Seat teardown is unavailable'
    : measured
      ? 'Seat teardown recorded'
      : 'Seat teardown is not measured'
  const sourceTotals = payload?.totals ?? {}
  const totals_label = measured
    ? `proven ${teardownDisplayCount(sourceTotals.proven)} · failed ${teardownDisplayCount(sourceTotals.failed)} · unproven ${teardownDisplayCount(sourceTotals.unproven)}${Number(sourceTotals.unrecognised) > 0 ? ` · unrecognised ${teardownDisplayCount(sourceTotals.unrecognised)}` : ''}`
    : 'not measured'
  const rows = (Array.isArray(payload?.runs) ? payload.runs : []).map((run) => {
    const state = absent ? 'undetermined' : run?.state || (run?.measured === true ? 'measured' : 'not-measured')
    const seats = (state === 'undetermined'
      ? []
      : (Array.isArray(run?.seats) ? run.seats : [])).map((seat) => {
      const tone = teardownSeatTone(seat)
      const outcome = seat?.outcome ?? null
      return {
        role: seat?.role ?? null,
        outcome,
        known: seat?.known === true,
        tone,
        label: `${teardownDisplayPart(seat?.role)} · ${teardownDisplayPart(outcome)} · ${teardownDisplayPart(seat?.reason)}`,
        forced: teardownForced(seat?.forced),
        transport: seat?.transport ?? null,
        at: seat?.at ?? null,
      }
    })
    const tone = teardownRunTone(state, seats)
    const tally = run?.tally ?? {}
    const forced = seats.some((seat) => seat.forced)
    const why = run?.not_measured_why || (absent || 'the teardown readout is unavailable')
    const label = state === 'not-measured'
      ? `not measured — ${why}`
      : state === 'undetermined'
        ? `teardown unavailable — ${why}`
        : `${teardownDisplayCount(tally.seats)} seat${tally.seats === 1 ? '' : 's'} · proven ${teardownDisplayCount(tally.proven)} · failed ${teardownDisplayCount(tally.failed)} · unproven ${teardownDisplayCount(tally.unproven)}${forced ? ' · forced' : ''}`
    return {
      adw_id: run?.adw_id ?? null,
      run_label: `${teardownDisplayPart(run?.task_slug)} · ${teardownDisplayPart(run?.repo_slug)}`,
      task_slug: run?.task_slug ?? null,
      state,
      tone,
      label,
      seats,
      at: run?.started_at ?? null,
    }
  })
  const tone = absent
    ? 'undetermined'
    : !measured
      ? 'not-measured'
      : rows.some((row) => row.tone === 'leak')
        ? 'leak'
        : rows.some((row) => row.tone === 'unproven')
          ? 'unproven'
          : 'proven'
  return {
    absent,
    freshness: readFreshness(clock?.read_at ?? null, clock?.now ?? null, clock?.refresh_ms ?? null),
    measured,
    window_label,
    headline,
    tone,
    totals: payload?.totals ?? null,
    totals_label,
    note: payload?.note ?? TEARDOWN_READONLY_NOTE,
    window_note: payload?.window_note ?? TEARDOWN_WINDOW_NOTE,
    rows,
  }
}

function runSetDisplayPart(value) {
  return value == null ? '—' : String(value)
}

function runSetDurationLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${Math.round(value / 1000)}s`
}

function runSetAgentSessionsLabel(value) {
  if (value == null) return '—'
  return `${value} session${value === 1 ? '' : 's'}`
}

function runSetTone(status) {
  return RUN_SET_STATUSES.includes(status) ? status : 'running'
}

function runSetUsageLabel(usage) {
  return ['agent_sessions', ...TOKEN_FIELDS]
    .map((key) => `${key} ${runSetDisplayPart(usage?.[key])}`)
    .join(' · ')
}

function budgetPanelFields(budget = null) {
  const ceiling = panelNumber(budget?.ceiling_tokens)
  const declared = ceiling != null
  const pending = typeof budget?.pending === 'string' && budget.pending.length ? budget.pending : null
  if (!declared) {
    return {
      budget_label: 'budget ceiling not declared to this view — burn comparison unavailable',
      budget_note: null,
      budget_pending: pending || 'budget ceiling not declared to this view',
    }
  }
  const burn = panelNumber(budget?.burn_tokens)
  const headroom = panelNumber(budget?.headroom_tokens)
  const fraction = typeof budget?.fraction === 'number' && Number.isFinite(budget.fraction) ? panelNumber(budget.fraction * 100) : null
  if (budget?.comparable === true && burn != null && headroom != null && fraction != null) {
    return {
      budget_label: `budget: ${ceiling} token ceiling · ${burn} burned · ${headroom} headroom · ${fraction}%`,
      budget_note: budget?.provenance ?? null,
      budget_pending: null,
    }
  }
  return {
    budget_label: `budget: ${ceiling} token ceiling — comparison pending`,
    budget_note: budget?.provenance ?? null,
    budget_pending: pending || 'budget burn cannot be compared with this ceiling',
  }
}

export function runSetPanel(payload = {}, clock = {}) {
  const freshness = readFreshness(clock?.read_at ?? null, clock?.now ?? null, clock?.refresh_ms ?? null)
  const absent = payload?.absent ?? null
  const window = payload?.window
  const window_label = window && typeof window === 'object'
    ? `${window.label} · since ${window.since} · until ${window.until || 'now'}`
    : 'window unavailable'
  const budgetFields = budgetPanelFields(payload?.budget)
  const unmeasured = payload?.unmeasured ?? {}
  const unmeasuredNote = unmeasured?.per_run || 'per-run usage is unmeasured — no agent_sessions evidence can distinguish the possible causes'
  if (absent) return {
    absent,
    freshness,
    window_label,
    rows: [],
    empty: false,
    usage_label: 'unavailable',
    ...budgetFields,
    mean_label: 'mean tokens per measured run: unavailable — no measured runs',
    unmeasured_note: unmeasuredNote,
  }

  const runs = payload?.runs
  const empty = runs === 0
  const usage = payload?.usage ?? null
  const settled = payload?.settled ?? {}
  const coverage = payload?.coverage ?? null
  return {
    absent: null,
    freshness,
    window_label,
    empty,
    runs_label: runs == null ? '— runs' : `${runs} run${runs === 1 ? '' : 's'}`,
    settled_chips: RUN_SET_STATUSES.map((status) => ({ status, count: settled[status] ?? 0, tone: runSetTone(status) })),
    usage_label: empty
      ? 'no runs started in this window'
      : usage == null
        ? 'unmeasured — no billed totals for any run in this window'
        : runSetUsageLabel(usage),
    coverage_label: coverage == null ? null : `usage measured for ${coverage.measured} of ${coverage.total} runs`,
    usage_note: unmeasured?.usage ?? null,
    parked_note: unmeasured?.parked ?? null,
    ...budgetFields,
    mean_label: panelNumber(payload?.usage_mean_tokens_per_measured_run) == null
      ? 'mean tokens per measured run: unavailable — no measured runs'
      : `mean tokens per measured run: ${panelNumber(payload.usage_mean_tokens_per_measured_run)}`,
    unmeasured_note: unmeasuredNote,
    rows: (Array.isArray(payload?.rows) ? payload.rows : []).map((row) => {
      const measured = row?.usage_measured === true || row?.usage_state === 'measured'
      return {
        adw_id: row?.adw_id ?? null,
        title: `${runSetDisplayPart(row?.task_slug)} · ${runSetDisplayPart(row?.repo_slug)}`,
        status: row?.status ?? null,
        tone: runSetTone(row?.status),
        started_at: row?.started_at ?? null,
        ended_at: row?.ended_at ?? null,
        duration_label: runSetDurationLabel(row?.duration_ms),
        agent_sessions_label: runSetAgentSessionsLabel(row?.agent_sessions),
        usage_tone: measured ? 'measured' : 'unmeasured',
        usage_label: measured ? runSetUsageLabel(row) : 'N/A — unmeasured, not zero',
      }
    }),
  }
}

const INTAKE_PANEL_TONES = {
  unmeasured: 'unmeasured',
  'never-swept': 'stopped',
  'not-swept-in-window': 'stale',
  parked: 'parked',
  picking: 'working',
  'swept-idle': 'idle',
}
const INTAKE_PANEL_HEADLINES = {
  unmeasured: 'Intake loop is unmeasured',
  'never-swept': 'Intake loop has not run',
  'not-swept-in-window': 'Intake loop has not swept in this window',
  parked: 'Intake loop is parked',
  picking: 'Intake loop is picking work',
  'swept-idle': 'Intake loop swept and found nothing eligible',
}
const INTAKE_READONLY_NOTE = 'this view reads the ledger; the intake module owns every decision shown here'
const INTAKE_WINDOW_NOTE = 'the window is a view, not the whole history — it cannot say whether the loop swept outside the selected window'

function intakeCountLabel(count) {
  if (count == null) return '—'
  const number = typeof count === 'number' ? count : Number(count)
  if (!Number.isFinite(number)) return '—'
  if (number === 0) return 'not refused in this window'
  return `${number} refused`
}

function intakeBoardLabel(board) {
  if (board == null) return 'board —'
  if (typeof board === 'string') return board
  const owner = board?.owner ?? board?.board_owner ?? null
  const project = board?.project ?? board?.board_project ?? null
  if (owner == null && project == null) return 'board —'
  return `${owner ?? '—'}/${project ?? '—'}`
}

export function intakePanel(payload = {}) {
  const absent = payload?.absent ?? null
  const window = payload?.window
  const window_label = window && typeof window === 'object'
    ? `${window.label} · since ${window.since} · until ${window.until || 'now'}`
    : 'window unavailable'
  const state = payload?.loop?.state || (absent ? 'unmeasured' : 'unmeasured')
  const tone = INTAKE_PANEL_TONES[state] || 'unmeasured'
  const headline = INTAKE_PANEL_HEADLINES[state] || INTAKE_PANEL_HEADLINES.unmeasured
  const loop = payload?.loop ?? {}
  const displayCount = (value) => value == null ? '—' : String(value)
  const counts_label = `swept ${displayCount(loop.swept)} · picked ${displayCount(loop.picked)} · parked ${displayCount(loop.parked)} · none ${displayCount(loop.none)}`
  const last_sweep_label = loop.last_sweep_at == null ? 'last sweep: never recorded' : `last sweep: ${loop.last_sweep_at}`
  const groups = (Array.isArray(payload?.refusals?.groups) ? payload.refusals.groups : []).map((group) => {
    const rows = (Array.isArray(group?.reasons) ? group.reasons : []).map((row) => {
      const rowState = row?.state || (row?.count == null ? 'unmeasured' : row.count === 0 ? 'not-in-window' : 'refused')
      return {
        reason: row?.reason ?? null,
        label: row?.reason ?? 'unrecognised reason',
        count_label: intakeCountLabel(row?.count),
        tone: rowState === 'unmeasured' ? 'unmeasured' : rowState === 'not-in-window' ? 'quiet' : 'refused',
        state: rowState,
      }
    })
    const groupTone = rows.some((row) => row.state === 'refused')
      ? 'refused'
      : rows.some((row) => row.state === 'unmeasured') ? 'unmeasured' : 'quiet'
    return {
      group: group?.group ?? null,
      title: group?.title ?? null,
      asserts: group?.asserts ?? null,
      tone: groupTone,
      rows,
    }
  })
  const unrecognised_rows = (Array.isArray(payload?.refusals?.unrecognised) ? payload.refusals.unrecognised : []).map((row) => {
    const state = row?.count == null ? 'unmeasured' : row.count === 0 ? 'not-in-window' : 'refused'
    return {
      reason: row?.reason ?? null,
      label: row?.reason ?? 'unrecognised reason',
      count_label: intakeCountLabel(row?.count),
      tone: state === 'unmeasured' ? 'unmeasured' : state === 'not-in-window' ? 'quiet' : 'refused',
      state,
    }
  })
  const picks = (Array.isArray(payload?.picks) ? payload.picks : []).map((row) => {
    const issue = row?.issue ?? null
    const board = row?.board ?? null
    return {
      issue,
      board,
      at: row?.at ?? null,
      label: `${issue == null ? 'issue —' : `issue #${issue}`} · ${intakeBoardLabel(board)} · ${row?.at ?? 'time unavailable'}`,
    }
  })
  return {
    absent,
    window_label,
    state,
    tone,
    headline,
    why: loop.why || 'the intake loop has not reported why it is in this state',
    counts_label,
    last_sweep_label,
    picks,
    groups,
    unrecognised_rows,
    window_note: payload?.unmeasured?.window || INTAKE_WINDOW_NOTE,
    readonly_note: INTAKE_READONLY_NOTE,
  }
}

const INTAKE_CANDIDATE_UNMEASURED = 'this is what the loop last recorded per issue, not a live read of the board — an item the loop has not seen in this window does not appear here at all, and its absence is not eligibility'

export function intakeCandidateRows(payload = {}) {
  const candidates = payload?.candidates ?? {}
  const measured = candidates.measured === true
  const absent = measured ? null : (candidates.absent || 'intake candidate readout is unavailable')
  const note = candidates.unmeasured || INTAKE_CANDIDATE_UNMEASURED
  if (!measured) return { measured: false, absent, rows: [], note }
  const rows = (Array.isArray(candidates.items) ? candidates.items : []).map((item) => {
    const issue = item?.issue ?? null
    const verdict = item?.verdict ?? null
    const recognised = item?.reason == null || item?.reason_recognised === true
    const tone = !recognised ? 'unmeasured' : verdict === 'would-take' ? 'take' : verdict === 'would-refuse' ? 'refused' : 'unmeasured'
    const verdict_label = verdict === 'would-take' ? 'would take' : verdict === 'would-refuse' ? 'would refuse' : 'verdict unmeasured'
    const reason_label = item?.reason == null ? 'no refusal recorded' : String(item.reason)
    const at = item?.last_seen_at ?? null
    return {
      issue,
      label: `${issue == null ? 'issue —' : `issue #${issue}`} · board ${intakeBoardLabel(item?.board)}`,
      verdict,
      verdict_label,
      reason_label,
      tone,
      at_label: at == null ? 'last seen: time unavailable' : `last seen: ${at}`,
    }
  })
  return { measured: true, absent: null, rows, note }
}

const BRAKE_UNMEASURED_NOTE = 'the switch is read from the resolved checkout on every poll; it affects the next sweep, not a run already in flight'

export function brakePanel(payload = {}) {
  const checkout = payload?.checkout ?? 'checkout unavailable'
  const path = payload?.path ?? 'path unavailable'
  const path_label = `checkout: ${checkout} · path: ${path}`
  const validState = payload?.state === 'engaged' || payload?.state === 'clear'
  const measured = payload?.measured !== false
  const state = validState ? payload.state : null
  const actionable = measured && validState
  const action_label = state === 'engaged' ? 'Clear brake' : state === 'clear' ? 'Engage brake' : 'Action unavailable'
  if (payload?.ok === false) {
    const error = payload?.error || payload?.read_error || 'no failure reason was reported'
    const readState = state || 'unreadable'
    return {
      state,
      label: `the last transition FAILED: ${error}; the switch reads ${readState}`,
      tone: 'unmeasured',
      detail: error,
      path_label,
      actionable,
      action_label,
      note: BRAKE_UNMEASURED_NOTE,
    }
  }
  if (!measured || !validState) {
    const error = payload?.read_error || 'no read error was reported'
    return {
      state: null,
      label: `brake state unreadable — ${error}`,
      tone: 'unmeasured',
      detail: error,
      path_label,
      actionable: false,
      action_label,
      note: BRAKE_UNMEASURED_NOTE,
    }
  }
  const engaged = state === 'engaged'
  return {
    state,
    label: engaged ? 'brake engaged — the next sweep will park with `stop-switch`' : 'brake clear — intake sweeps normally',
    tone: engaged ? 'refused' : 'quiet',
    detail: payload?.read_error ?? null,
    path_label,
    actionable,
    action_label,
    note: BRAKE_UNMEASURED_NOTE,
  }
}

export function findingRows(returns = {}) {
  const envelopes = Array.isArray(returns?.envelopes) ? returns.envelopes : []
  const groups = []
  let measured = false
  for (const envelope of envelopes) {
    const findings = envelope?.details && Array.isArray(envelope.details.findings) ? envelope.details.findings : null
    if (findings == null) continue
    measured = true
    groups.push({
      role: envelope?.role ?? null,
      dispatch_seq: envelope?.dispatch_seq ?? null,
      findings: findings.map((finding) => ({
        id: finding?.id ?? null,
        severity: finding?.severity ?? null,
        location: finding?.location ?? null,
        summary: finding?.summary ?? null,
      })),
    })
  }
  return { groups, pending: measured ? null : FINDINGS_PENDING }
}
