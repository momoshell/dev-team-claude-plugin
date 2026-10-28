import { tokenCell } from './fleet.js'

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
  let promptTotal = 0
  let cacheRead = 0
  let cacheMeasured = 0
  for (const run of source) {
    const usage = tokenCell(run)
    if (usage.value == null) continue
    total = (total ?? 0) + usage.value
    measured += 1
    if (usage.promptTotal != null) {
      promptTotal += usage.promptTotal
      cacheRead += usage.cacheRead
      cacheMeasured += 1
    }
  }
  const pending = total == null ? (source[0]?.pending?.billed_input_tokens || 'predates this measurement') : null
  return {
    total,
    measured,
    runs: source.length,
    pending,
    cacheRate: promptTotal > 0 ? cacheRead / promptTotal * 100 : null,
    cacheMeasured,
    cachePending: cacheMeasured ? null : (source[0]?.pending?.billed_cache_read_tokens || 'prompt cache usage was not measured'),
  }
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
  const escalated = measuredRows.filter((run) => run?.agents?.some((agent) => agent?.outcome === 'escalate') || envelopeFor(options?.envelopes, run?.adw_id)?.status === 'escalation').length
  return { percent: Math.round(escalated / measured * 100), escalated, measured, runs: rows.length, pending: null }
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

