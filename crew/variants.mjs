// The closed variant declarations live in this import-free leaf: it owns the
// data describing which run shapes exist and what each one declares. Executor
// validators stay in drive.mjs because they encode what that driver can run,
// rather than knowledge the daemon needs. Consumers are drive.mjs and daemon.mjs.
// Keep this file import-free because daemon.test.mjs allowlists it as a LEAF.
export const VARIANTS = Object.freeze({
  full: Object.freeze({
    execution: 'reviewed',
    required_seats: 'tier', // the tier seats this shape; it has no single seat
    stages: Object.freeze(['plan', 'check', 'build', 'scope-gate', 'lane', 'gate',
      'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review',
      'commit', 'rebase', 'suite', 'publish', 'converge']),
    writes: 'planned',
    // All THREE terminals, not just the first: :1876, :1860, :1905.
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: Object.freeze([]),
    assignment: null,
  }),
  scout: Object.freeze({
    execution: 'envelope',
    required_seats: Object.freeze(['planner']),
    stages: Object.freeze(['scout', 'scope-gate', 'envelope-accept']),
    writes: 'none',
    accepted_by: 'envelope shape',
    envelope_fields: Object.freeze([
      Object.freeze({ name: 'findings', kind: 'records', item_fields: Object.freeze(['summary', 'evidence']) }),
    ]),
    assignment: 'Read-only recon. Answer the brief from the code and the checkout, write your notes into the task dir, and change nothing.',
  }),
  review_only: Object.freeze({
    execution: 'envelope',
    required_seats: Object.freeze(['reviewer']),
    stages: Object.freeze(['review_only', 'scope-gate', 'envelope-accept']),
    writes: 'none',
    accepted_by: 'structured envelope plus zero-write proof; no commit',
    strict_identity: true,
    report_values: true,
    envelope_fields: Object.freeze([
      Object.freeze({ name: 'base', kind: 'text' }), Object.freeze({ name: 'head', kind: 'text' }),
      Object.freeze({ name: 'outcome', kind: 'text', values: Object.freeze(['findings', 'no-findings']) }),
      Object.freeze({
        name: 'findings', kind: 'records', allow_empty: true,
        item_fields: Object.freeze(['id', 'severity', 'location', 'summary', 'evidence', 'disposition']),
        item_values: Object.freeze({
          severity: Object.freeze(['must-fix', 'should-fix', 'consider']),
          disposition: Object.freeze(['auto-fix', 'ask-user', 'no-op']),
        }),
        item_patterns: Object.freeze({ id: '^[A-Za-z0-9_-]{1,64}$' }),
        cardinality: Object.freeze({ discriminator: 'outcome', empty: 'no-findings', nonempty: 'findings' }),
      }),
    ]),
    assignment: 'Review the returned base/head identity and the declared change set as a read-only code review. This assignment supersedes the ordinary reviewer deliverable: do not create, edit, delete, checkout, or commit anything in the checkout. Read-only validation is permitted. Return the complete structured envelope with non-empty base and head, outcome findings or no-findings, and findings records containing id, severity, location, summary, evidence, and disposition; findings must be empty exactly when outcome is no-findings and non-empty when outcome is findings.',
  }),
  repair: Object.freeze({
    execution: 'reviewed',
    required_seats: 'tier',
    // No plan, no check: a bounded triage opens the run. No gate*, no converge:
    // this shape declares gate source 'none', and undeclaredStage is what makes
    // that mechanical rather than a promise.
    stages: Object.freeze(['repair', 'build', 'scope-gate', 'lane', 'review', 'commit', 'rebase', 'suite', 'publish']),
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: Object.freeze([]),
    assignment: 'Bounded triage. Read the failure the task brief carries verbatim, then write the smallest fix the builder can execute inside the scope this run inherits. This is NOT a plan round: there is no revision, no plan-check, no second attempt, and no acceptance gate.',
    sources: Object.freeze({ scope: 'inherited', lane: 'ctx', gate: 'none' }),
  }),
  // The brief IS the plan (#251 follow-on): the ORCHESTRATOR authors the gate
  // and the write surface in the task brief, so this shape seats no planner and
  // runs no plan or check round. It declares no gate-repair/gate-reverify on
  // purpose: the gate's author is outside the crew, so a defective directed gate
  // ESCALATES rather than being repaired by a seat that never wrote it.
  directed: Object.freeze({
    execution: 'reviewed',
    required_seats: Object.freeze(['builder', 'reviewer']),   // ⚓ A1
    stages: Object.freeze(['directed', 'build', 'scope-gate',   // ⚓ A4 (the first three)
      'lane', 'gate', 'gate-baseline', 'gate-proof', 'review',
      'commit', 'rebase', 'suite', 'publish', 'converge']),
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: Object.freeze([]),
    assignment: null,
    sources: Object.freeze({ scope: 'brief', lane: 'ctx', gate: 'brief' }),
  }),
})
export const VARIANT_NAMES = Object.freeze(Object.keys(VARIANTS))
export const DEFAULT_VARIANT = 'full'
