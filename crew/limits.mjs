// crew/limits.mjs — the per-run limits flag and its validation. An import-free
// leaf on purpose: crew/crew.mjs (the attended entrypoint) and crew/child.mjs
// (the daemon-forked one) must validate identically, and child.mjs deliberately
// never imports crew.mjs. Same posture as crew/slug.mjs: one owner, not a copy
// per caller.
//
// The DEFAULTS live in crew/drive.mjs's LIMITS and are not touched here. This
// leaf only makes the plan-round budget REACHABLE per run, the way --tier is:
// an orchestrator decision made at dispatch, never one a crew grants itself.

export const LIMIT_REFUSALS = Object.freeze(['invalid-plan-rounds'])

// A ceiling, not a policy: it turns a typo (`--plan-rounds 60`) into a refusal
// instead of a run that cannot end. Raising the DEFAULT is out of scope.
export const PLAN_ROUNDS_MAX = 10

export function refuseLimit(reason, message) {
  if (!LIMIT_REFUSALS.includes(reason)) throw new Error(`unknown limit refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

// Absent (no flag) -> null, which is what keeps an unflagged run identical to
// today. Anything present must be a whole number in [1, PLAN_ROUNDS_MAX];
// anything else REFUSES with a closed-set reason. Deliberately not the
// memoryConfig fallback shape: a silently defaulted budget is exactly the
// ambiguity this lane exists to remove.
export function resolvePlanRounds(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const bad = () => refuseLimit(
    'invalid-plan-rounds',
    `--plan-rounds must be a whole number between 1 and ${PLAN_ROUNDS_MAX}, got ${JSON.stringify(raw)}`,
  )
  if (typeof raw !== 'number' && typeof raw !== 'string') throw bad()
  const text = typeof raw === 'number' ? String(raw) : raw.trim()
  if (!/^[0-9]+$/.test(text)) throw bad()
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > PLAN_ROUNDS_MAX) throw bad()
  return value
}

// The journal record. The EFFECTIVE budget is recorded on every run, flagged or
// not: an escalation at round N means something different against a budget of N
// than against a larger one, and a reader cannot tell the two apart from an
// absent line. `defaults` is drive.mjs's LIMITS, passed in to keep this leaf
// import-free.
export function limitsRecord(planRounds, defaults) {
  return planRounds === null
    ? { plan_rounds: defaults.plan_rounds, source: 'default' }
    : { plan_rounds: planRounds, source: 'flag' }
}
