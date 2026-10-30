# Task

---
source: operator decision 2026-10-26 (lean loop re-runs a red full suite once)
closes: null
tier: build
shape: standard
acceptance: [SR1, SR2]
out_of_scope: crew/drive.mjs, crew/crew.mjs, crew/lean.mjs, crew/acp/, the gate and mutation-proof stages, the old headless and pane paths
---
## The ask

In the lean loop, a red full suite stops the lane at once (`crew/loop.mjs`, the `suite` stage near line 221).
A flaky suite has cost hand-finishes. The operator decided: when the suite is red, run it exactly once more. Green
on the re-run lets the lane continue to commit, and the PR measurements record both runs, so the first red is
never hidden. Red on the re-run stops the lane with the same reason it uses today. An unmeasured suite
(`runner-threw`, a timeout) is not re-run; it stops as today.

The invariants: at most two suite runs per lane; a re-run never turns an unmeasured result into green; the PR
text names the first red run when the re-run passes.

## Context

- `crew/loop.mjs` `runLoop`: the `suite` stage, `callCheck`, `stop`, and the `measurements` lines that go into
  the PR text.
- `crew/checks.mjs` `runSuite`: the result shape (`status`, `reason`, `code`), read only.
- `crew/loop.test.mjs`: the loop tests with injected `runSuite`; the suite-red case there pins today's stop.

## Acceptance

- (SR1) a suite that is red then green on its one re-run reaches commit with both runs in the PR measurements
- (SR2) a suite that is red on both runs stops the lane with the first run's reason after exactly two runs
