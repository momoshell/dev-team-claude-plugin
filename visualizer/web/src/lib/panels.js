const TOKEN_FIELDS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
const RUN_SET_STATUSES = ['running', 'ok', 'fail', 'aborted']
const FINDINGS_PENDING = 'findings unavailable — this review predates structured findings (#170)'
const UNPROVEN_TITLE = 'no evidence was obtainable — a direct DI caller without runClean, or a contained stash failure. Absence of evidence is not evidence of absence (ADR-030).'
const ACCEPTED_TITLE = 'typed accept held — residuals were accepted'
const REFUSED_TITLE = 'typed accept refused — loop failed closed to escalate'

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

export function cellHealthPanel(payload = {}) {
  const absent = payload?.absent ?? null
  const window = payload?.window
  const window_label = window && typeof window === 'object'
    ? `${window.label} · since ${window.since} · until ${window.until || 'now'}`
    : 'window unavailable'
  const view = {
    absent,
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

export function runSetPanel(payload = {}) {
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
