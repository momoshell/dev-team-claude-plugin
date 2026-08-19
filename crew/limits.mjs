// crew/limits.mjs — the per-run limits flag and its validation. An import-free
// leaf on purpose: crew/crew.mjs (the attended entrypoint) and crew/child.mjs
// (the daemon-forked one) must validate identically, and child.mjs deliberately
// never imports crew.mjs. Same posture as crew/slug.mjs: one owner, not a copy
// per caller.
//
// The DEFAULTS live in crew/drive.mjs's LIMITS and are not touched here. This
// leaf only makes the plan-round budget REACHABLE per run, the way --tier is:
// an orchestrator decision made at dispatch, never one a crew grants itself.

export const LIMIT_REFUSALS = Object.freeze(['invalid-plan-rounds', 'invalid-build-rounds', 'invalid-review-rounds'])

// A ceiling, not a policy: it turns a typo (`--plan-rounds 60`) into a refusal
// instead of a run that cannot end. Raising the DEFAULT is out of scope.
export const PLAN_ROUNDS_MAX = 10
export const BUILD_ROUNDS_MAX = 10
export const REVIEW_ROUNDS_MAX = 10

export function refuseLimit(reason, message) {
  if (!LIMIT_REFUSALS.includes(reason)) throw new Error(`unknown limit refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

// Absent (no flag) -> null, which is what keeps an unflagged run identical to
// today. Anything present must be a whole number in [1, max]; anything else
// REFUSES with a closed-set reason. Deliberately not the memoryConfig fallback
// shape: a silently defaulted budget is exactly the ambiguity this lane exists
// to remove.
function resolveRounds(raw, { flag, reason, max }) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const bad = () => refuseLimit(
    reason,
    `--${flag} must be a whole number between 1 and ${max}, got ${JSON.stringify(raw)}`,
  )
  if (typeof raw !== 'number' && typeof raw !== 'string') throw bad()
  const text = typeof raw === 'number' ? String(raw) : raw.trim()
  if (!/^[0-9]+$/.test(text)) throw bad()
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > max) throw bad()
  return value
}

export function resolvePlanRounds(raw) {
  return resolveRounds(raw, { flag: 'plan-rounds', reason: 'invalid-plan-rounds', max: PLAN_ROUNDS_MAX })
}

export function resolveBuildRounds(raw) {
  return resolveRounds(raw, { flag: 'build-rounds', reason: 'invalid-build-rounds', max: BUILD_ROUNDS_MAX })
}

export function resolveReviewRounds(raw) {
  return resolveRounds(raw, { flag: 'review-rounds', reason: 'invalid-review-rounds', max: REVIEW_ROUNDS_MAX })
}

// raw: { plan_rounds, build_rounds, review_rounds } — already read from argv or the
// child spec. Validation order is fixed (plan, build, review) so two bad flags
// always refuse on the same one.
export function resolveLimits(raw = {}) {
  return {
    plan_rounds: resolvePlanRounds(raw.plan_rounds),
    build_rounds: resolveBuildRounds(raw.build_rounds),
    review_rounds: resolveReviewRounds(raw.review_rounds),
  }
}

// The ctx overlay: only the keys actually flagged, or null when none were —
// an unflagged run must leave ctx without a `limits` key at all.
export function limitsCtx(resolved) {
  const out = {}
  for (const key of ['plan_rounds', 'build_rounds', 'review_rounds']) if (resolved[key] !== null) out[key] = resolved[key]
  return Object.keys(out).length === 0 ? null : out
}

// The journal record. The EFFECTIVE plan/build/review budget triple is recorded
// on every run, flagged or not: an escalation at round N means something
// different against a budget of N than against a larger one, and a reader
// cannot tell the two apart from an absent line. `defaults` is drive.mjs's
// LIMITS, passed in to keep this leaf import-free.
export function limitsRecord(resolved, defaults) {
  const keys = ['plan_rounds', 'build_rounds', 'review_rounds']
  const record = { source: {} }
  for (const key of keys) {
    record[key] = resolved[key] === null ? defaults[key] : resolved[key]
    record.source[key] = resolved[key] === null ? 'default' : 'flag'
  }
  return record
}
