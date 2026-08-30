// The closed task-profile vocabulary lives in this import-free leaf (TRD §3.1
// and §3.3): it owns what a run is FOR, the evidence a profile requires, and
// which execution shapes that profile may run. It does not staff — required
// seats, model floors and effort stay in crew/roster.json — and it does not
// execute: crew/variants.mjs is the SOLE owner of the execution-shape catalog
// and this file keeps no second copy of it. The compatibility matrix below
// names review_only and verify_only because §3.3 needs them named; a shape
// crew/variants.mjs does not declare is reported by the resolver as
// declared-pending, derived from VARIANT_NAMES rather than asserted here.
// Consumers are crew/run-configuration.mjs and, from #780/#781, the entry points.
// Keep this file import-free because daemon.test.mjs allowlists it as a LEAF.

// The closed evidence vocabulary. Declared as a literal, not derived, so a
// profile cannot invent an evidence key by typing one.
export const EVIDENCE_KEYS = Object.freeze([
  'base_head_identity', 'captured_evidence', 'changed_tests', 'check_result', 'checks_run',
  'citations', 'cited_findings', 'environment', 'explicit_unknowns', 'fix_validation',
  'mutation_or_negative_control', 'regression_evidence', 'reproduction_or_cited_failure',
  'review', 'scoped_diff', 'severity', 'structured_findings', 'suite_result',
  'terminal_result', 'validation', 'zero_source_writes',
])

export const TASK_PROFILES = Object.freeze({
  implementation: Object.freeze({
    name: 'Implementation',
    outcome: 'A requested behavior or product change',
    evidence: Object.freeze(['scoped_diff', 'validation', 'review', 'terminal_result']),
    recommended_execution: 'full',
    allowed_executions: Object.freeze(['directed']),
    execution_conditions: Object.freeze({}),
  }),
  bug_fix: Object.freeze({
    name: 'Bug fix',
    outcome: 'A reproduced defect is removed without regression',
    evidence: Object.freeze(['reproduction_or_cited_failure', 'fix_validation', 'regression_evidence']),
    recommended_execution: 'full',
    allowed_executions: Object.freeze(['directed', 'repair']),
    execution_conditions: Object.freeze({ repair: 'a failing run supplies inherited scope' }),
  }),
  investigation: Object.freeze({
    name: 'Investigation',
    outcome: 'A read-only, cited answer to a bounded question',
    evidence: Object.freeze(['cited_findings', 'explicit_unknowns', 'zero_source_writes']),
    recommended_execution: 'scout',
    allowed_executions: Object.freeze([]),
    execution_conditions: Object.freeze({}),
  }),
  code_review: Object.freeze({
    name: 'Code review',
    outcome: 'Actionable findings against a declared change set',
    evidence: Object.freeze(['base_head_identity', 'structured_findings', 'severity', 'citations', 'zero_source_writes']),
    recommended_execution: 'review_only',
    allowed_executions: Object.freeze([]),
    execution_conditions: Object.freeze({}),
  }),
  qa_verification: Object.freeze({
    name: 'QA verification',
    outcome: 'A declared behavior is independently checked',
    evidence: Object.freeze(['environment', 'checks_run', 'check_result', 'captured_evidence']),
    recommended_execution: 'verify_only',
    allowed_executions: Object.freeze([]),
    execution_conditions: Object.freeze({}),
  }),
  test_authoring: Object.freeze({
    name: 'Test authoring',
    outcome: 'Tests materially discriminate the intended behavior',
    evidence: Object.freeze(['changed_tests', 'mutation_or_negative_control', 'suite_result']),
    recommended_execution: 'full',
    allowed_executions: Object.freeze(['directed']),
    execution_conditions: Object.freeze({}),
  }),
})
export const TASK_PROFILE_NAMES = Object.freeze(Object.keys(TASK_PROFILES))

// Recommended first, then the allowed alternatives, in declaration order. This
// is the row of the §3.3 table a refusal quotes back to the operator.
export function executionsFor(profile) {
  const declared = TASK_PROFILES[profile]
  if (!declared) return null
  return Object.freeze([declared.recommended_execution, ...declared.allowed_executions])
}
