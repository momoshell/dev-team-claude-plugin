# Plan appendix: every test file and what happens to it

Generated at `a73ab2ad` from the imports and source paths each `*.test.mjs` file names. A test is filed under the module
whose name it carries; 12 files whose subject the script could not settle were filed by reading them. Line counts are
`wc -l`. Total: 179,479 lines in 132 files. Companion to `docs/plan-lean-runtime.md`.

| Fate | Files | Lines |
|---|---|---|
| Delete at the switch | 72 | 133,240 |
| Delete with the pin machinery | 13 | 6,485 |
| Rewrite against the new modules | 3 | 3,787 |
| Keep | 25 | 15,771 |
| Keep until the arm is decided | 9 | 8,313 |
| Visualizer: keep, then re-point | 10 | 11,883 |

Of the 4,961 `test(` cases in the drive, crew, seat-io, headless, dispatch-batch and ledger suites, 222 name a kept
arm (advisor 122, stepped 42, finish 18, edit assist 17, memory 12, codemode 9, lab 2). Those behaviours are re-tested in the
new loop when the arm is ported; most of the advisor cases test rotation and its ledger rows, which do not carry over.

## Delete at the switch (72 files, 133,240 lines)

The module it tests is replaced by the new path. The file goes in the same PR that deletes its module.

| Lines | Test file | Tests |
|---|---|---|
| 14,214 | `crew/drive-build.test.mjs` | `crew/drive.mjs` |
| 8,260 | `test/factory-dispatch-batch.test.mjs` | `scripts/factory/dispatch-batch.mjs` |
| 8,015 | `crew/drive-review.test.mjs` | `crew/drive.mjs` |
| 6,270 | `crew/drive.test.mjs` | `crew/drive.mjs` |
| 5,713 | `crew/headless.test.mjs` | `crew/headless.mjs` |
| 5,558 | `crew/crew-cli.test.mjs` | `crew/crew.mjs` |
| 5,402 | `crew/seat-io-runclean.test.mjs` | `crew/seat-io.mjs` |
| 5,250 | `crew/headless-rpc.test.mjs` | `crew/headless-rpc.mjs` |
| 4,699 | `crew/drive-plan.test.mjs` | `crew/drive.mjs` |
| 4,681 | `test/factory-make-brief.test.mjs` | `scripts/factory/make-brief.mjs` |
| 4,366 | `crew/drive-publish.test.mjs` | `crew/drive.mjs` |
| 4,069 | `crew/daemon.test.mjs` | `crew/daemon.mjs` |
| 3,605 | `crew/crew-boot.test.mjs` | `crew/crew.mjs` |
| 3,304 | `test/factory-ledger-turns.test.mjs` | `scripts/factory/ledger.mjs` |
| 3,254 | `test/factory-ledger-core.test.mjs` | `scripts/factory/ledger.mjs` |
| 2,859 | `crew/crew.test.mjs` | `crew/crew.mjs` |
| 2,489 | `test/factory-dispatch-batch-fences.test.mjs` | `scripts/factory/dispatch-batch.mjs` |
| 2,452 | `crew/crew-adapters.test.mjs` | `crew/crew.mjs` |
| 2,430 | `test/factory-ledger-advisor.test.mjs` | `scripts/factory/ledger.mjs` |
| 2,369 | `crew/drive-docs.test.mjs` | `crew/drive.mjs` |
| 2,333 | `test/factory-probe-repo.test.mjs` | `scripts/factory/probe-repo.mjs` |
| 2,167 | `test/factory-intake.test.mjs` | `scripts/factory/intake.mjs` |
| 1,992 | `test/factory-ledger.test.mjs` | `scripts/factory/ledger.mjs` |
| 1,778 | `test/factory-model-eval.test.mjs` | `scripts/factory/model-eval.mjs` |
| 1,721 | `crew/capabilities.test.mjs` | `crew/capabilities.mjs` |
| 1,421 | `crew/factoryctl.test.mjs` | `crew/factoryctl.mjs` |
| 1,326 | `test/factory-pr-review.test.mjs` | `scripts/factory/pr-review.mjs` |
| 1,306 | `crew/driver.test.mjs` | `crew/driver.mjs` |
| 1,143 | `test/factory-ledger-cli.test.mjs` | `scripts/factory/ledger.mjs` |
| 1,118 | `test/factory-dispatch-batch-refusals.test.mjs` | `scripts/factory/dispatch-batch.mjs` |
| 1,002 | `crew/roster-refresh.test.mjs` | `crew/roster-refresh.mjs` |
| 995 | `test/factory-reap-stale.test.mjs` | `scripts/factory/reap-stale.mjs` |
| 983 | `crew/seat-io-death.test.mjs` | `crew/seat-io.mjs` |
| 950 | `test/factory-ledger-sandbox.test.mjs` | `scripts/factory/ledger.mjs` |
| 873 | `test/factory-crew-watch.test.mjs` | `scripts/factory/crew-watch.mjs` |
| 783 | `test/factory-transcript.test.mjs` | `scripts/factory/transcript.mjs` |
| 779 | `test/factory-lane-watch.test.mjs` | `scripts/factory/lane-watch.mjs` |
| 754 | `crew/crew-seatio.test.mjs` | `crew/crew.mjs` |
| 742 | `crew/batch.test.mjs` | `crew/batch.mjs` |
| 637 | `crew/arms.test.mjs` | `crew/arms.mjs` |
| 626 | `test/factory-model-reeval.test.mjs` |  |
| 587 | `crew/breaker.test.mjs` | `crew/breaker.mjs` |
| 582 | `test/factory-dispatch-batch-cli.test.mjs` | `scripts/factory/dispatch-batch.mjs` |
| 574 | `test/factory-mutant-census.test.mjs` |  |
| 548 | `test/factory-ledger-escalations.test.mjs` | `scripts/factory/ledger.mjs` |
| 479 | `test/factory-ledger-floor.test.mjs` | `scripts/factory/ledger.mjs` |
| 456 | `test/factory-agent-doctor.test.mjs` | `scripts/factory/agent-doctor.mjs` |
| 418 | `test/factory-seat-priors.test.mjs` | `scripts/factory/seat-priors.mjs` |
| 417 | `crew/crew-emit.test.mjs` | `crew/crew.mjs` |
| 375 | `test/factory-suite-cost.test.mjs` | `scripts/factory/suite-cost.mjs` |
| 359 | `test/factory-seams.test.mjs` | `scripts/factory/seams.mjs` |
| 336 | `test/factory-dispatch-batch-adoption.test.mjs` | `scripts/factory/dispatch-batch.mjs` |
| 324 | `crew/screener.test.mjs` | `crew/screener.mjs` |
| 301 | `crew/run-configuration.test.mjs` | `crew/run-configuration.mjs` |
| 298 | `crew/escalation-policy.test.mjs` | `crew/escalation-policy.mjs` |
| 283 | `test/factory-shape-scan.test.mjs` | `scripts/factory/shape-scan.mjs` |
| 273 | `test/factory-extract-suite-corpus.test.mjs` | `scripts/factory/extract-suite-corpus.mjs` |
| 272 | `crew/harvest.test.mjs` | `crew/harvest.mjs` |
| 256 | `crew/host-load.test.mjs` | `crew/host-load.mjs` |
| 250 | `crew/seat-io-heartbeat.test.mjs` | `crew/seat-io.mjs` |
| 194 | `crew/batch-report.test.mjs` | `crew/batch-report.mjs` |
| 189 | `crew/converge.test.mjs` | `crew/converge.mjs` |
| 157 | `test/factory-ledger-store.test.mjs` | `scripts/factory/ledger.mjs` |
| 123 | `crew/task-profiles.test.mjs` | `crew/task-profiles.mjs` |
| 96 | `test/factory-ledger-cells.test.mjs` | `scripts/factory/ledger.mjs` |
| 76 | `test/factory-skill-reads.test.mjs` |  |
| 73 | `test/factory-lean-debt.test.mjs` | `scripts/factory/lean-debt.mjs` |
| 61 | `crew/assurances.test.mjs` | `crew/assurances.mjs` |
| 55 | `test/factory-ledger-modifiers.test.mjs` | `scripts/factory/ledger.mjs` |
| 54 | `test/factory-absence.test.mjs` | `scripts/factory/absence.mjs` |
| 48 | `crew/fence-scope.test.mjs` | `crew/fence-scope.mjs` |
| 38 | `test/factory-ledger-sessions.test.mjs` | `scripts/factory/ledger.mjs` |

## Delete with the pin machinery (13 files, 6,485 lines)

Anchor, exhibit, census and tripwire suites. They pin prose and counts, not behaviour.

| Lines | Test file | Tests |
|---|---|---|
| 1,906 | `skills/qa-test-writing/anchor-pin.test.mjs` |  |
| 1,133 | `test/factory-env.test.mjs` |  |
| 885 | `skills/crew-dispatch/exhibits.test.mjs` |  |
| 643 | `skills/ui-design/exhibits.test.mjs` |  |
| 451 | `skills/ux/exhibits.test.mjs` |  |
| 446 | `test/vacuity.test.mjs` |  |
| 366 | `skills/crew-recovery/exhibits.test.mjs` |  |
| 302 | `skills/frontend-svelte/exhibits.test.mjs` |  |
| 113 | `skills/crew-dispatch/cli-contract.test.mjs` |  |
| 107 | `crew/gate-lint.test.mjs` | `crew/gate-lint.mjs` |
| 56 | `skills/devops/exhibits.test.mjs` |  |
| 53 | `skills/backend-node/exhibits.test.mjs` |  |
| 24 | `skills/code-less/exhibits.test.mjs` |  |

## Rewrite against the new modules (3 files, 3,787 lines)

They test behaviour the new path keeps (process-group reaping, the ACP seat path, the adapter I/O contract) through modules that go. The kept cases move to tests of the new modules.

| Lines | Test file | Tests |
|---|---|---|
| 1,743 | `crew/io-contract.test.mjs` |  |
| 1,112 | `crew/seat-io-acp.test.mjs` | `crew/seat-io.mjs` |
| 932 | `crew/reclaim-descendants.test.mjs` |  |

## Keep (25 files, 15,771 lines)

They test a module the new path keeps (slimmed), or a repo rule that stays.

| Lines | Test file | Tests |
|---|---|---|
| 3,557 | `test/factory-closeout.test.mjs` | `scripts/factory/closeout.mjs` |
| 2,140 | `test/factory-emit.test.mjs` | `scripts/factory/emit.mjs` |
| 2,093 | `test/factory-prove-mutations.test.mjs` | `scripts/factory/prove-mutations.mjs` |
| 1,333 | `crew/reclaim.test.mjs` | `crew/reclaim.mjs` |
| 1,096 | `crew/acp-client.test.mjs` | `crew/acp-client.mjs` |
| 1,024 | `crew/adapter-pi.test.mjs` | `crew/adapters/adapter-pi.mjs` |
| 689 | `crew/pi/extensions/acp-server.test.mjs` | `crew/pi/extensions/acp-server.ts` |
| 596 | `test/factory-kill-redundancy.test.mjs` | `scripts/factory/kill-redundancy.mjs` |
| 556 | `test/helpers.test.mjs` |  |
| 426 | `test/docs-decisions.test.mjs` |  |
| 270 | `crew/tree-fingerprint.test.mjs` | `crew/tree-fingerprint.mjs` |
| 256 | `skills/pr-review/findings-shape.test.mjs` |  |
| 206 | `crew/pi/extensions/submit.test.mjs` | `crew/pi/extensions/submit.ts` |
| 205 | `test/factory-prose-lint.test.mjs` | `scripts/factory/prose-lint.mjs` |
| 184 | `bin/crew.test.mjs` | `bin/crew.mjs` |
| 175 | `commands/commands.test.mjs` |  |
| 169 | `hooks/skill-gate.test.mjs` | `hooks/skill-gate.mjs` |
| 153 | `crew/json-leaf.test.mjs` | `crew/json-leaf.mjs` |
| 150 | `crew/guidelines/gate-kit.test.mjs` | `crew/guidelines/gate-kit.mjs` |
| 146 | `crew/acp-permission.test.mjs` | `crew/acp-permission.mjs` |
| 110 | `test/review-procedure-loader.test.mjs` |  |
| 107 | `test/factory-emit-floor.test.mjs` | `scripts/factory/emit.mjs` |
| 62 | `test/version-agreement.test.mjs` |  |
| 45 | `test/fixtures.test.mjs` |  |
| 23 | `crew/seat-runtime-tmpdir.test.mjs` |  |

## Keep until the arm is decided (9 files, 8,313 lines)

Kept arms, carried over unchanged.

| Lines | Test file | Tests |
|---|---|---|
| 2,248 | `crew/pi/extensions/lab.test.mjs` | `crew/pi/extensions/lab.ts` |
| 1,639 | `crew/pi/extensions/advisor.test.mjs` | `crew/pi/extensions/advisor.ts` |
| 1,196 | `crew/pi/extensions/readgate.test.mjs` | `crew/pi/extensions/readgate.ts` |
| 1,091 | `crew/pi/extensions/builderloop.test.mjs` | `crew/pi/extensions/builderloop.ts` |
| 829 | `crew/pi/extensions/subagent.test.mjs` | `crew/pi/extensions/subagent.ts` |
| 576 | `crew/pi/extensions/fff.test.mjs` |  |
| 419 | `crew/memory.test.mjs` | `crew/memory.mjs` |
| 220 | `crew/pi/extensions/skeletonread.test.mjs` | `crew/pi/extensions/skeletonread.ts` |
| 95 | `crew/pi/extensions/reminders.test.mjs` | `crew/pi/extensions/reminders.ts` |

## Visualizer: keep, then re-point (10 files, 11,883 lines)

Unchanged until the visualizer reads journals instead of the ledger and edits agent frontmatter instead of the roster.

| Lines | Test file | Tests |
|---|---|---|
| 4,478 | `test/visualizer-server.test.mjs` |  |
| 4,109 | `test/visualizer-panels.test.mjs` |  |
| 1,229 | `test/visualizer-shape.test.mjs` |  |
| 741 | `test/visualizer-roster-edit.test.mjs` |  |
| 668 | `test/visualizer-trajectory.test.mjs` |  |
| 205 | `test/visualizer-teardown.test.mjs` |  |
| 187 | `test/visualizer-model-catalog.test.mjs` |  |
| 120 | `test/visualizer-model-directory.test.mjs` |  |
| 119 | `test/visualizer-returns.test.mjs` |  |
| 27 | `test/visualizer-local-env.test.mjs` |  |
