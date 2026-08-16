const TOKEN_FIELDS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
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
  if (absent) return view

  view.rows = (Array.isArray(payload?.cells) ? payload.cells : []).map((row) => {
    const state = row?.state
    const tone = state === 'silent' ? 'silent' : state === 'run-less-only' ? 'run-less' : 'recorded'
    const failures = row?.failures ?? null
    const run_less = row?.run_less ?? null
    const in_run = row?.in_run ?? null
    const label = state === 'silent'
      ? 'no failures recorded in this window'
      : state === 'run-less-only'
        ? `${failures} failure${failures === 1 ? '' : 's'}, all run-less — refused before any run existed`
        : `${in_run} in run · ${run_less} run-less`
    const roles = Array.isArray(row?.roles) ? row.roles : []
    const tiers = Array.isArray(row?.tiers) ? row.tiers : []
    return {
      key: row?.key ?? null,
      title: `${cellDisplayPart(row?.provider)}/${cellDisplayPart(row?.model_id)} · ${cellDisplayPart(row?.agent)} · ${cellDisplayPart(row?.effort)}`,
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
