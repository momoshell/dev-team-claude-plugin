// Snapshot of the profile evidence and variant stage lists the run views read, kept here so the visualizer
// bundle imports nothing from crew/. Values are copied from crew/task-profiles.mjs and crew/variants.mjs.
export const TASK_PROFILES = Object.freeze({
  implementation: { outcome: 'A requested behavior or product change', evidence: ['scoped_diff', 'validation', 'review', 'terminal_result'] },
  bug_fix: { outcome: 'A reproduced defect is removed without regression', evidence: ['reproduction_or_cited_failure', 'fix_validation', 'regression_evidence'] },
  investigation: { outcome: 'A read-only, cited answer to a bounded question', evidence: ['cited_findings', 'explicit_unknowns', 'zero_source_writes'] },
  code_review: { outcome: 'Actionable findings against a declared change set', evidence: ['base_head_identity', 'structured_findings', 'severity', 'citations', 'zero_source_writes'] },
  qa_verification: { outcome: 'A declared behavior is independently checked', evidence: ['environment', 'checks_run', 'check_result', 'captured_evidence'] },
  test_authoring: { outcome: 'Tests materially discriminate the intended behavior', evidence: ['changed_tests', 'mutation_or_negative_control', 'suite_result'] },
})

export const VARIANTS = Object.freeze({
  full: { stages: ['plan', 'check', 'build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review', 'commit', 'document', 'rebase', 'suite', 'publish', 'converge'] },
  scout: { stages: ['scout', 'scope-gate', 'envelope-accept'] },
  review_only: { stages: ['review_only', 'scope-gate', 'envelope-accept'] },
  review_panel: { stages: ['review_panel', 'scope-gate', 'envelope-accept'] },
  repair: { stages: ['repair', 'build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'rebase', 'suite', 'publish'] },
  directed: { stages: ['directed', 'build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-proof', 'review', 'commit', 'document', 'rebase', 'suite', 'publish', 'converge'] },
  finish: { stages: ['finish-triage', 'build', 'scope-gate', 'lane', 'gate', 'review', 'commit', 'rebase', 'suite', 'decision'] },
  verify_only: { stages: ['verify_only', 'scope-gate', 'envelope-accept'] },
  stepped: { stages: ['plan', 'check', 'build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review', 'commit', 'document', 'rebase', 'suite', 'publish', 'converge'] },
})
