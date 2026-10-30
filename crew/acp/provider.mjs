// Provider failure kinds, ACP reset parsing and the provider retry decision.
// Pure and dependency-free: the lean path imports this without the old driver.

// WHICH provider condition ended the turn, as a closed enum rather than the one
// bit `budgetRefused` carries. The stream's terminal `result` frame already
// records `api_error_status` and the driver has been discarding it, so a rate
// limit, an expired key and a capacity outage have all been arriving as the
// same `budget-refused` row — three causes an operator has to act on
// differently, grouped as one (#779).
//
// Measured 2026-09-01 against a stand-in upstream (test/fake-upstream.mjs),
// which returns a chosen status so the mapping is evidence and not a guess:
//
//   429 -> {terminal_reason: "api_error", api_error_status: 429, is_error: true}
//   401 -> {terminal_reason: "api_error", api_error_status: 401, is_error: true}
//   529 -> {terminal_reason: "api_error", api_error_status: 529, is_error: true}
//
// All three ALSO carry `subtype: "success"`, which is why nothing here reads
// subtype: on a refused turn it says success while `is_error` says otherwise.
//
// The names are borrowed from the Agent Client Protocol's `data.errorKind`.
// Nothing here depends on that protocol — the status has always been in our own
// terminal frame — but a cause enum shared with the wider ecosystem costs
// nothing and keeps one taxonomy if the question is ever reopened.
export const PROVIDER_FAILURE_KINDS = Object.freeze({
  RATE_LIMIT: 'rate_limit',
  AUTHENTICATION_FAILED: 'authentication_failed',
  SERVER_ERROR: 'server_error',
  UNCLASSIFIED: 'provider-unclassified',
  STREAM_STALL: 'stream-stall',
})

export function acpProviderFailureKind(errorKind, errorMessage) {
  if (errorKind === 'pi-agent-error') {
    if (errorMessage === 'Codex error: Our servers are currently overloaded. Please try again later.') return PROVIDER_FAILURE_KINDS.SERVER_ERROR
    if (errorMessage === 'Codex error: The usage limit has been reached') return PROVIDER_FAILURE_KINDS.RATE_LIMIT
  }
  if (errorKind === 'rate_limit') return PROVIDER_FAILURE_KINDS.RATE_LIMIT
  if (errorKind === 'overloaded' || errorKind === 'server_error') return PROVIDER_FAILURE_KINDS.SERVER_ERROR
  if (errorKind === 'authentication_failed' || errorKind === 'oauth_org_not_allowed' || errorKind === 'verification_required') return PROVIDER_FAILURE_KINDS.AUTHENTICATION_FAILED
  return null
}

// --- provider retry: routing the kind the stream already carried ------------
// #887. Four lanes died on 2026-09-03 because a 529, a 429 and a 401 all
// collapse into one `budget-refused` and the driver escalates. b401 lost a
// plan, a build, a scope gate, a 17/17 mutation proof and a completed review to
// a 529 at review:r1, and its own stream shows the worker had ALREADY spent ten
// retries over 223s inside the turn. The kind was measured the whole time
// (crew/headless.mjs, providerFailureKind) and nothing routed on it. Route here.
//
// A retry that never gives up is worse than the escalation it replaces, so BOTH
// bounds are closed constants and BOTH are consumed: a park that fits the
// attempt count still runs out of total wait.
export const PROVIDER_RETRY_MAX = 3
// Five and a half hours: a POLICY bound this driver chose, not a fact about the
// provider. The provider's window is five hours (`rateLimitType: "five_hour"` in
// the recorded 2026-08-30 frame), so a stated reset can legitimately be up to
// nearly five hours out. This bound now COVERS that window, with half an hour of
// margin for a clock that disagrees.
//
// It was four hours, and four hours was measured to be wrong. On 2026-09-06 a
// 429 stated a reset 4h09m out and three lanes — b463-sessionbusy,
// b467-paneorphan, b468-optionalgrant — were declined nine minutes past the
// bound, each with `provider-retry-declined … attempts_spent: 0`. Declining a
// reset inside the provider's own window defeats the point of parking on a
// stated reset at all: the operator re-dispatches into the same limit and pays
// the plan rounds again. The refusal was honest and the number was simply too
// small.
//
// A reset further away than this is still refused with the instant NAMED, so the
// operator re-dispatches knowing exactly when.
//
// KNOWN TENSION, stated rather than hidden: a park this long is invisible to
// every liveness instrument (#948) — the driver sleeps emitting nothing, reads
// `stale` in crew-watch, and `dispatch-batch` refuses an unrelated batch against
// it as `external-fence-abandoned`. Raising this bound makes that worse in
// duration, not in kind. #948 is the fix; this constant is not.
export const PROVIDER_RETRY_TOTAL_WAIT_MS = (5 * 60 + 30) * 60 * 1000

// Minutes, not the worker's seconds: the one retry budget that already existed
// was at the wrong altitude. The ladder SATURATES on its last rung rather than
// running off the end, so the attempt bound above is the only thing that stops
// it.

export const PROVIDER_BACKOFF_LADDER_MS = Object.freeze([60_000, 300_000, 900_000])
// OUR slack past a stated reset, so a clock a few seconds fast does not retry
// into a window that is still closed. Ours and stated — never a provider fact.
export const PROVIDER_RESET_SETTLE_MS = 60_000

export function acpTextReset(text, at) {
  const absent_reason = PROVIDER_RESET_ABSENT.ACP_TEXT_UNPARSEABLE
  const no = () => ({ at_ms: null, absent_reason })
  if (typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return no()
  const match = /(?<![A-Za-z])resets\s+(1[0-2]|[1-9])(?::([0-5][0-9]))?(am|pm)\s+\(([^()]+)\)(?![A-Za-z0-9:])/i.exec(text)
  if (!match) return no()
  const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0)
  const minute = Number(match[2] ?? 0)
  let formatter
  try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: match[4], hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) } catch { return no() }
  // lean: 72-hour minute scan for rare ACP refusals; offset-based zone resolution if measured refusal volume makes this costly
  const first = Math.floor(at / 60000) * 60000 + 60000
  for (let i = 0; i < 72 * 60; i += 1) {
    const instant = first + i * 60000
    if (!Number.isFinite(new Date(instant).getTime())) return no()
    const parts = formatter.formatToParts(instant)
    const values = Object.fromEntries(parts.filter((part) => part.type === 'hour' || part.type === 'minute').map((part) => [part.type, Number(part.value)]))
    if (values.hour === hour && values.minute === minute) return { at_ms: instant, absent_reason: null }
  }
  return no()
}

// What the driver does about each kind, as DATA for the same reason
// SEAT_REFUSAL_ACTIONS (crew/headless.mjs) is data: a policy change is a data edit, not a new
// branch. `none` is TODAY'S behaviour, byte for byte — no row, no wait, no
// respawn — and it is what an UNCLASSIFIED failure and an unmeasured status
// both get, because a failure nobody diagnosed must not be retried as though it
// had been.
export const PROVIDER_RETRY_ACTIONS = Object.freeze({
  [PROVIDER_FAILURE_KINDS.SERVER_ERROR]: 'backoff',
  [PROVIDER_FAILURE_KINDS.RATE_LIMIT]: 'park',
  [PROVIDER_FAILURE_KINDS.AUTHENTICATION_FAILED]: 'refuse',
  [PROVIDER_FAILURE_KINDS.UNCLASSIFIED]: 'none',
  [PROVIDER_FAILURE_KINDS.STREAM_STALL]: 'backoff',
})

// A reset instant nobody stated is UNKNOWN with a closed reason, never a
// guessed delay and never a default. Prose because an operator reads it out of
// the journal.
export const PROVIDER_RESET_ABSENT = Object.freeze({
  NO_FRAME: 'the stream carries no rejected rate_limit_event frame, so the provider stated no reset time',
  NO_RESET_FIELD: 'the rejected rate_limit_event carries no reset time this driver can read as unix seconds',
  ACP_TEXT_UNPARSEABLE: 'ACP rate-limit text not parseable: no valid reset wall-clock time and IANA zone',
  BEYOND_BOUND: 'the stated reset is further out than the total wait this driver will spend',
})

// PURE, so the routing is unit-testable without a worker. Every refusal names
// the kind and what has already been spent; every retry names what it will wait
// on. Nothing here reads a clock of its own — `at` is the caller's.
export function providerRetryDecision({ kind = null, status = null, reset = null, attempts = 0, waitedMs = 0, at = 0 }) {
  const action = PROVIDER_RETRY_ACTIONS[kind] ?? 'none'
  const bound = { attempts: PROVIDER_RETRY_MAX, total_wait_ms: PROVIDER_RETRY_TOTAL_WAIT_MS }
  const no = (why, extra = {}) => ({ retry: false, action, wait_ms: null, waited_on: null, reset_at: null, attempts_spent: attempts, bound, why, ...extra })
  if (action === 'none') return no(`provider failure ${String(kind)} is not a kind this driver routes, so the run keeps the behaviour it has always had`)
  if (action === 'refuse') return no(`a ${kind} (status ${String(status)}) is a credential fault: a second ask cannot succeed and would spend the remaining budget against a wall`)
  if (attempts >= PROVIDER_RETRY_MAX) return no(`the provider retry bound of ${PROVIDER_RETRY_MAX} attempts is spent for ${kind} (status ${String(status)}); ${attempts} attempts were taken over ${waitedMs}ms`)
  if (action === 'park') {
    const resetAt = Number.isFinite(reset?.at_ms) ? reset.at_ms : null
    if (resetAt === null) return no(`a ${kind} (status ${String(status)}) stated no reset time this driver could read: ${reset?.absent_reason ?? PROVIDER_RESET_ABSENT.NO_FRAME}`)
    const waitMs = Math.max(0, resetAt + PROVIDER_RESET_SETTLE_MS - at)
    if (waitedMs + waitMs > PROVIDER_RETRY_TOTAL_WAIT_MS) return no(`${PROVIDER_RESET_ABSENT.BEYOND_BOUND}: ${kind} resets at ${new Date(resetAt).toISOString()}, ${waitMs}ms out against a ${PROVIDER_RETRY_TOTAL_WAIT_MS}ms bound`, { reset_at: resetAt })
    return { retry: true, action, wait_ms: waitMs, waited_on: 'reset-time', reset_at: resetAt, attempts_spent: attempts, bound, why: `${kind} (status ${String(status)}) stated a reset; attempt ${attempts + 1} of ${PROVIDER_RETRY_MAX} parks ${waitMs}ms` }
  }
  const waitMs = PROVIDER_BACKOFF_LADDER_MS[Math.min(attempts, PROVIDER_BACKOFF_LADDER_MS.length - 1)]
  if (waitedMs + waitMs > PROVIDER_RETRY_TOTAL_WAIT_MS) return no(`the total provider wait bound of ${PROVIDER_RETRY_TOTAL_WAIT_MS}ms is spent for ${kind} (status ${String(status)}); ${attempts} attempts were taken over ${waitedMs}ms`)
  return { retry: true, action, wait_ms: waitMs, waited_on: 'backoff-ladder', reset_at: null, attempts_spent: attempts, bound, why: `${kind} (status ${String(status)}) is transient; attempt ${attempts + 1} of ${PROVIDER_RETRY_MAX} backs off ${waitMs}ms` }
}
