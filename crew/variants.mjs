// The closed variant declarations live in this import-free leaf: it owns the
// data describing which run shapes exist and what each one declares. Executor
// validators stay in drive.mjs because they encode what that driver can run,
// rather than knowledge the daemon needs. Consumers are drive.mjs and daemon.mjs.
// Keep this file import-free because daemon.test.mjs allowlists it as a LEAF.
const NO_OFF_CRITICAL_PATH_STAGES = Object.freeze([])

export const VARIANTS = Object.freeze({
  full: Object.freeze({
    execution: 'reviewed',
    required_seats: 'tier', // the tier seats this shape; it has no single seat
    stages: Object.freeze(['plan', 'check', 'build', 'scope-gate', 'lane', 'gate',
      'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review',
      'commit', 'document', 'rebase', 'suite', 'publish', 'converge']),
    off_critical_path_stages: NO_OFF_CRITICAL_PATH_STAGES,
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
    off_critical_path_stages: NO_OFF_CRITICAL_PATH_STAGES,
    writes: 'none',
    accepted_by: 'envelope shape',
    envelope_fields: Object.freeze([
      Object.freeze({
        name: 'findings', kind: 'records',
        item_fields: Object.freeze(['summary', 'evidence']),
        optional_item_fields: Object.freeze(['program', 'output']),
      }),
    ]),
    assignment: 'Read-only recon. Answer the brief from the code and the checkout, write your notes into the task dir, and change nothing. `program` is a command or script you actually ran, and it always travels with the `output` it produced. If you ran nothing, omit both.',
  }),
  review_only: Object.freeze({
    execution: 'envelope',
    required_seats: Object.freeze(['reviewer']),
    stages: Object.freeze(['review_only', 'scope-gate', 'envelope-accept']),
    off_critical_path_stages: NO_OFF_CRITICAL_PATH_STAGES,
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
      Object.freeze({ name: 'reviewed_files', kind: 'paths', allow_empty: true }),
      Object.freeze({
        name: 'unreviewable_files', kind: 'records', allow_empty: true,
        item_fields: Object.freeze(['path', 'reason']),
        item_values: Object.freeze({
          reason: Object.freeze(['binary', 'generated', 'too-large', 'out-of-context']),
        }),
      }),
    ]),
    assignment: 'Review the returned base/head identity and the declared change set as a read-only code review. This assignment supersedes the ordinary reviewer deliverable: do not create, edit, delete, checkout, or commit anything in the checkout. Read-only validation is permitted. Return the complete structured envelope with non-empty base and head, outcome findings or no-findings, reviewed_files as an array of paths, and unreviewable_files as records with path and reason; every unreviewable reason must be binary, generated, too-large, or out-of-context, every listed path must belong to the base/head change set, and reviewed_files and unreviewable_files must be disjoint. Return findings records containing id, severity, location, summary, evidence, and disposition; findings must be empty exactly when outcome is no-findings and non-empty when outcome is findings.',
  }),
  review_panel: Object.freeze({
    execution: 'envelope',
    required_seats: Object.freeze(['reviewer', 'tech-lead', 'lead']),
    stages: Object.freeze(['review_panel', 'scope-gate', 'envelope-accept']),
    off_critical_path_stages: NO_OFF_CRITICAL_PATH_STAGES,
    writes: 'none',
    accepted_by: 'structured three-seat panel envelope plus zero-write proof; no commit',
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
      Object.freeze({ name: 'reviewed_files', kind: 'paths', allow_empty: true }),
      Object.freeze({
        name: 'unreviewable_files', kind: 'records', allow_empty: true,
        item_fields: Object.freeze(['path', 'reason']),
        item_values: Object.freeze({
          reason: Object.freeze(['binary', 'generated', 'too-large', 'out-of-context']),
        }),
      }),
      Object.freeze({ name: 'panel', kind: 'object' }),
    ]),
    assignment: 'Run a read-only three-seat review panel. Reviewer and tech-lead must independently return the complete review-only contract: non-empty base/head, outcome findings or no-findings, findings records with id, severity, location, summary, evidence, and disposition, reviewed_files paths, and unreviewable_files path/reason records; their coverage lists must be disjoint and inside the immutable base/head change set. Lead must return base/head, adjudications with each collision-safe divergent id exactly once, disposition uphold or dismiss, a non-empty reason, and its own reviewed_files and unreviewable_files coverage. The driver fuses matching findings, preserves origin fields and dismissed provenance, and accepts only a read-only result; do not create, edit, delete, checkout, or commit anything in the checkout. Read-only validation is permitted.',
  }),
  repair: Object.freeze({
    execution: 'reviewed',
    required_seats: 'tier',
    // No plan, no check: a bounded triage opens the run. No gate*, no converge:
    // this shape declares gate source 'none', and undeclaredStage is what makes
    // that mechanical rather than a promise.
    stages: Object.freeze(['repair', 'build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'rebase', 'suite', 'publish']),
    off_critical_path_stages: NO_OFF_CRITICAL_PATH_STAGES,
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
      'commit', 'document', 'rebase', 'suite', 'publish', 'converge']),
    off_critical_path_stages: NO_OFF_CRITICAL_PATH_STAGES,
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: Object.freeze([]),
    assignment: null,
    sources: Object.freeze({ scope: 'brief', lane: 'ctx', gate: 'brief' }),
  }),
  verify_only: Object.freeze({
    execution: 'envelope',
    required_seats: Object.freeze(['reviewer']),
    stages: Object.freeze(['verify_only', 'scope-gate', 'envelope-accept']),
    off_critical_path_stages: NO_OFF_CRITICAL_PATH_STAGES,
    writes: 'none',
    accepted_by: 'complete structured verification report plus zero-write proof; no commit, regardless of product verdict',
    strict_identity: true,
    report_values: true,
    envelope_fields: Object.freeze([
      Object.freeze({ name: 'verification_targets', kind: 'records', item_fields: Object.freeze(['id', 'target']) }),
      Object.freeze({ name: 'environment_assumptions', kind: 'records', item_fields: Object.freeze(['name', 'assumption']) }),
      Object.freeze({ name: 'product_verdict', kind: 'text', values: Object.freeze(['passing', 'failing']) }),
      Object.freeze({
        name: 'check_matrix', kind: 'records', allow_empty: true,
        item_fields: Object.freeze(['id', 'status', 'command', 'result', 'evidence']),
        item_values: Object.freeze({ status: Object.freeze(['passed', 'failed', 'blocked', 'not run']) }),
        covers: Object.freeze({ field: 'verification_targets', key: 'id' }),
      }),
      Object.freeze({ name: 'environment', kind: 'records', item_fields: Object.freeze(['name', 'observed']) }),
      Object.freeze({ name: 'environmental_blockers', kind: 'records', allow_empty: true, item_fields: Object.freeze(['target', 'reason']) }),
    ]),
    assignment: 'Read-only verification. Return a complete structured verification report with details.verification_targets as non-empty records with id,target; details.environment_assumptions as non-empty records with name,assumption; details.product_verdict as passing or failing; details.check_matrix as records with id,status,command,result,evidence and one row for each verification target; details.environment as non-empty records with name,observed; and details.environmental_blockers as records with target,reason. Ephemeral build/test artifacts may exist only while checks run and must be removed before return; the final checkout must be clean. No tester role is introduced.',
  }),
})
export const VARIANT_NAMES = Object.freeze(Object.keys(VARIANTS))
export const DEFAULT_VARIANT = 'full'
