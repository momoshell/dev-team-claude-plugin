# Task: Adversarial defect hunt on the process-lifecycle surface: make the crew runtime misbehave around death. Attack shapes to run, each against a scratch state dir with real spawned processes where needed: kill a seat child at every stage boundary (plan-accept, build round, gate, review, suite, commit) and check what the driver records versus what actually happened; kill the DRIVER mid-stage and re-run — what double-applies, what strands, what leaks; race two writers of crew.json (the audit found three writers with three durability contracts — write concurrently and diff the survivors for lost fields or torn JSON); interrupt teardown mid-sweep and count surviving processes and pgids; fill the reclaim path with already-dead pids and pids that were reused by unrelated processes; make settle paths fire twice for one seat. The daemon: kill it between poll ticks with live children; enqueue while it is dying; deliver a socket disconnect during a tail replay.
## The ask
Adversarial defect hunt on the process-lifecycle surface: make the crew runtime misbehave around death. Attack shapes to run, each against a scratch state dir with real spawned processes where needed: kill a seat child at every stage boundary (plan-accept, build round, gate, review, suite, commit) and check what the driver records versus what actually happened; kill the DRIVER mid-stage and re-run — what double-applies, what strands, what leaks; race two writers of crew.json (the audit found three writers with three durability contracts — write concurrently and diff the survivors for lost fields or torn JSON); interrupt teardown mid-sweep and count surviving processes and pgids; fill the reclaim path with already-dead pids and pids that were reused by unrelated processes; make settle paths fire twice for one seat. The daemon: kill it between poll ticks with live children; enqueue while it is dying; deliver a socket disconnect during a tail replay.
## Proposed tier
PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms
or overrides this at boot; the compiler never decides the tier.
proposed tier: judge
because:
- protected paths in force: 14 · ratified profile field protected_paths_candidates (3 entries) added to the authored floor · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
- scope breadth: 6 source files named by where (≥5 → judge)
- tripwire tests pinning that scope: 47
- protected path hit: crew/drive.mjs, crew/reclaim.mjs — tier judge unchanged (already highest)
proposed shape: judge
because (risk signals):
- risk signal · 2 protected path hits: crew/drive.mjs, crew/reclaim.mjs — shape judge
proposed strength: frontier
because (complexity signals):
- complexity signal · scope breadth: 6 source file(s) named by where
- complexity signal · tripwire tests pinning that scope: 47
- complexity signal · directory where: none
- complexity judge → ratified ladder band frontier
```proposal
{
  "shape": "judge",
  "strength": "frontier"
}
```
## Where
verified · file · crew/daemon.mjs
verified · file · crew/drive.mjs
verified · file · crew/seat-io.mjs
verified · file · crew/reclaim.mjs
verified · file · crew/child.mjs
verified · file · crew/crew.mjs
## Done means
Every defect carries: (1) a REPRODUCTION — a self-contained program or command sequence, written into the task dir, that demonstrates the misbehaviour against a scratch copy of the repo (git archive HEAD into a temp dir, or a throwaway DEVTEAM_LEDGER_DIR / state dir), never against the checkout — the driver mechanically refuses a scout that changes a file; (2) observed versus expected, with the exact output pasted; (3) a severity call: corrupts-state / wrong-answer / hangs-or-leaks / refuses-wrongly / cosmetic; (4) the guard that SHOULD have caught it (a test, a refusal, a schema) and why it did not. A suspicion you could not reproduce goes in a separate SUSPICIONS section with what you tried — it is not a finding. Negative results are first-class: list every attack you ran that the code survived, so the next hunt does not re-run it. Findings ranked by severity. State which files you read in full.
## Tripwires
candidates: commands/commands.test.mjs, crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/capabilities.test.mjs, crew/child.mjs, crew/converge.test.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/daemon.mjs, crew/daemon.test.mjs, crew/drive.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/host-load.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, crew/seat-io.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
tripwire tests:
- commands/commands.test.mjs · KNOWN_FLAGS, validation-lane
- crew/adapter-pi.test.mjs · ./adapters/adapter-pi.mjs, 127.0.0.1, ROLE_ORDER, SEAT_DEFAULTS, adapter-pi.mjs
- crew/arms.test.mjs · crew.json, write-failed
- crew/breaker.test.mjs · 24.0.0, boot-refusal, breaker-open
- crew/capabilities.test.mjs · ./adapters/adapter-claude.mjs, ./adapters/adapter-pi.mjs, CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, adapter-claude.mjs, adapter-pi.mjs, assertGrantsBacked, capability-shortfall, effectiveCapabilities, endpoint-dead, err.reason, grant-contradicts-deny, grant-unsupported, grantsFor, loadCapabilities, local-endpoint-dead, local-settings-missing, validateCapabilities
- crew/converge.test.mjs · ./converge.mjs, converge.mjs, crew/drive.mjs, should-fix
- crew/crew.test.mjs · ./adapters/adapter-claude.mjs, ./adapters/adapter-pi.mjs, ./reclaim.mjs, 127.0.0.1, ADVISOR_BOOT_REFUSALS, ADVISOR_CONFIG_VERSION, BAND_FLOOR_REFUSALS, BOOT_DESCENDANT_REFUSALS, BOOT_ONLY_FLAGS, CAPABILITY_REFUSALS, DEFAULT_ROLES, DEFAULT_VARIANT, EMPTY_GRANTS, FANOUT_TOOLS, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, KNOWN_FLAGS, LADDER_PATH, LIMITS, LIVENESS, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, MEMORY_ROLES, PANE_SETTLE_MS, PANE_SETTLE_POLLS, PHASES, PROTECTED_PATHS, REQUIRED_FLAGS, ROLE_FLAG_PREFIXES, ROLE_ORDER, RUN_EXIT_CODES, RUN_EXIT_UNEXPECTED, SAFE_MODEL, SEAT_DEFAULTS, SHADOW_ABSENT, SHADOW_EXCLUSIONS, SHADOW_OUTCOMES, SUBSTRATE_MISSES_TO_DIE, UsageError, VALIDATION_LANE_REFUSAL, VARIANTS, VARIANT_NAMES, VARIANT_STAGE_PHASES, WAIT_POLL_MS, adapter-claude.mjs, adapter-pi.mjs, adapter-unsupported, advisorManifest, assertAdvisorManifest, assertBandFloors, assertCapabilities, assertCtxSources, assertDefBandFloors, assertFanoutCoherent, assertGrantsBacked, assertSeats, assertUsage, awaitSeatsReady, band-below-floor, band-unknown, bandForMember, bandForRaw, boot-descendant-sweep, boot-refusal, bootAllocation, bootCmd, breaker-open, brief-file, build-rounds, builder.md, capability-shortfall, cellFailureKind, child.mjs, classifyAdvisorCell, composeLayout, crew.json, crew/child.mjs, crew/daemon.mjs, daemon.mjs, deniedFanout, descendantRefusal, descendants-alive, descendants-evidence-mismatch, descendants-sweep-failed, descendants-unknown, descendants-unreclaimed, docOpenArgs, driveTask, effectiveTools, emitAdapter, endpoint-dead, envelope-accept, err.reason, escalationAttention, floor-unratified, gate-repair, grant-contradicts-deny, grant-unsupported, grantedDefModels, grantsFor, headless-json, headless-rpc, invalid-budget, invalid-validation-lane, journal.jsonl, ladder-unreadable, lane-fence, lead.md, loadCapabilities, loadLadder, local-endpoint-dead, local-settings-missing, memory-backend, memory-budget-bytes, memory-dir, memoryConfig, model-ladder.json, no-candidate, not-consulted, paneAlive, paneProbe, paneSeat, paneTeardownRows, parkOnOutcome, parkSeats, phaseForStage, plan-rounds, planner.md, probe-alive, probe-dead, probe-unknown, probeLocalEndpoint, protected-paths, reclaim.mjs, reclaimDescendants, reclaimStore, refuseBandFloor, refuseStaleDescendants, resolveAdapters, resolveFilesInScope, resolveLaneFence, resolveSeatModels, resolveTier, resolveValidationLane, resolveVariant, resolveWorkerBin, review-exhausted, review-rounds, review:pass, roster.json, run.json, runChild, runCmd, runExitCode, scope-gate, seat-died, seat-io.mjs, seat-teardown, seatBand, seatIo, seatLiveness, seatModelKey, seatReadySignal, seatTransport, shadowCandidates, shadowExclusion, shadowPick, shadowPickBoot, should-fix, stale-descendants, substrate-gone, task.json, teardownCmd, teardownCore, transport-error, transportFor, validateScopeEntries, validation-lane, vendor-collision, waitForEnvelope, your-role
- crew/daemon.test.mjs · ./escalation-policy.mjs, ./headless-rpc.mjs, ./slug.mjs, ./variants.mjs, 24.0.0, DAEMON_COMMANDS, DEFAULT_BUDGET_WINDOW_MS, DEFAULT_CONCURRENCY, DEFAULT_TRANSPORT, EVENT_KINDS, LEDGER_NODE_FLOOR, PANE_TRANSPORT, PROTECTED_PATHS, RUN_STATES, VARIANTS, VARIANT_NAMES, brief-file, child.mjs, crew.json, crew/child.mjs, crew/daemon.mjs, daemon.mjs, deriveState, driveTask, emitAdapter, escalation-policy.mjs, headless-json, headless-rpc, headless-rpc.mjs, invalid-spec, journal.jsonl, lane-fence, node:module, node:net, normalizeEvent, not-capable, probe-unknown, protected-paths, review.md, run.json, runChild, scope-gate, scopeEntryDefects, seat-io.mjs, seat-teardown, seatIo, settleSeatTeardown, slug.mjs, task.json, teardown-threw, teardown-transports, terminal-result, tool-call, usageWindow, validateScopeEntries, variants.mjs
- crew/drive.test.mjs · ./escalation-policy.mjs, ./protected-paths.mjs, ./variants.mjs, CARVE_VERDICTS, CHECK_FAIL_PREFIX, DECISIONS, DEFAULT_VARIANT, DIRECTED_SEATS, DIRECTED_SOURCES, DIRECTED_STAGES, DIRECTED_STAGE_HEAD, ENVELOPE_FIELD_KINDS, ENVELOPE_REFUSAL_REASONS, EXECUTIONS, FAILURE_UPGRADE, FINDING_SEVERITIES, GATE_CUSTODIAN, GATE_REAP_CMD_EOF, GATE_REAP_SWEEP_MARKER, GATE_SUMMARY_PREFIX, GROWTH_DIVERGENCE_FACTOR, JUDGE_TIER, LIMITS, MAX_QUESTIONS, MODIFIER_OUTCOMES, MUTATIONS_MAX, MUTATION_OUTCOMES, PANEL_ADJUDICATORS, PANEL_PARTNERS, PARTIAL_REVIEWED, PERSPECTIVE_TARGETS, PROTECTED_PATHS, REFUTATION_EVIDENCE_MAX, RESIDUAL_TYPES, REVIEWED_CORE_STAGES, SECOND_OPINION, SENSITIVITY_FLOOR, SHAPE_SOURCES, TRIAGE_SOURCES, TRIAGE_STAGES, TRIAGE_STAGE_HEAD, UNIVERSAL_STAGE_HEADS, VARIANTS, VARIANT_NAMES, VERDICTS, WAITS_S, WAIT_FLAGS, WAIT_REFUSALS, WAIT_ROLES, WAIT_SECONDS_MAX, WAIT_SECONDS_MIN, WRITE_SURFACES, acceptContractLines, acceptedViaLabel, agent-change, already-dead, answerBounceLines, applyPrescriptionLines, assertSeats, baselineGateDefect, brief-file, builder.md, cache:v2, checkFailureLine, child.mjs, composeCommitMessage, correctness-unverified, crew.json, crew/daemon.mjs, crew/drive.mjs, crew/reclaim.mjs, crew/seat-io.mjs, daemon.mjs, driveTask, envelope-accept, envelopeDefect, envelopeFieldsPresent, err.reason, escalation-policy.mjs, field-item, field-kind, field-missing, gate-repair, gate-triage, gateReapCommand, gateReapFresh, gateReapOriginal, gateReapSweepCommand, gateReapVerdict, growthLines, growthRecord, headless-json, headless-rpc, journal.jsonl, laneFenceHits, lead.md, matchAnswers, model-ladder.json, no-envelope, no-tier, outOfScopeFiles, panel-a, panel-b, panel-divergence, panelSeats, parseDirectedBrief, parseGateSummary, parseQuestions, planner.md, probe-dead, protected-paths, protected-paths.mjs, protectedHits, questionConsultLines, reclaim.mjs, refuseWait, refuted-must-fix, resolveProtectedPaths, resolveWaits, review.md, review:pass, reviewFindings, reviewOutcome, reviewer.md, roster.json, runChild, runCmd, scope-gate, scopeMatcher, seat-io.mjs, seatIo, second-opinion, sensitivity-floor, shapeDefect, should-fix, sourcesDefect, stageEnabled, task.json, undeclaredStage, unusable-envelope, validateAcceptDecision, validateCarve, validateMutations, validateScopeEntries, variants.mjs, wait-builder, wait-lead, wait-planner, wait-reviewer, wait-tech-lead, waitsCtx, waitsRecord
- crew/driver.test.mjs · ./adapters/adapter-claude.mjs, ./adapters/adapter-pi.mjs, ./driver.mjs, adapter-claude.mjs, adapter-pi.mjs, driver.mjs, lead.md, planner.md, tech-lead.md
- crew/escalation-policy.test.mjs · ./escalation-policy.mjs, child.mjs, crew/child.mjs, crew/daemon.mjs, crew/drive.mjs, daemon.mjs, driveTask, escalation-policy.mjs, should-fix, usageWindow
- crew/factoryctl.test.mjs · crew.json, daemon.mjs, headless-json, invalid-spec, journal.jsonl, task.json, terminal-result
- crew/harvest.test.mjs · crew.json
- crew/headless-rpc.test.mjs · ./headless-rpc.mjs, ./reclaim.mjs, EVIDENCE_KINDS, LIVENESS, headless-rpc, headless-rpc.mjs, no-envelope, parse-error, probe-alive, probe-dead, probe-unknown, reclaim.mjs, reclaimStore
- crew/headless.test.mjs · ./headless.mjs, headless-json, headless.mjs, no-envelope
- crew/host-load.test.mjs · ./host-load.mjs, LOAD_ENV, assertHostQuiet, host-load.mjs, hostLoad, loadPolicy
- crew/io-contract.test.mjs · ./adapters/adapter-pi.mjs, ./driver.mjs, ./headless-rpc.mjs, ./headless.mjs, WAIT_POLL_MS, adapter-pi.mjs, agent-change, cellFailureKind, crew.json, driver.mjs, emitAdapter, headless-json, headless-rpc, headless-rpc.mjs, headless.mjs, nextModelRung, nextRung, no-envelope, no-tier, parse-error, resolveSeatModels, resolveWorkerBin, roster.json, seat-died, seat-io.mjs, seatIo, sensitivity-floor, transport-error, unusable-envelope
- crew/pi/extensions/advisor.test.mjs · 127.0.0.1, classifyAdvisorCell, endpoint-credentials, endpoint-not-local, endpoint-unset, role-unsupported
- crew/pi/extensions/lab.test.mjs · 127.0.0.1, grantsFor, journal.jsonl, loadCapabilities, node:net
- crew/pi/extensions/subagent.test.mjs · ./adapters/adapter-pi.mjs, ./headless-rpc.mjs, adapter-pi.mjs, assertGrantsBacked, effectiveCapabilities, grantsFor, headless-rpc, headless-rpc.mjs, journal.jsonl, loadCapabilities
- crew/reclaim-descendants.test.mjs · DESCENDANT_DIR, DESCENDANT_MAX_ANCHORS, DESCENDANT_STORE_DIRS, already-dead, bootCmd, brief-file, child.mjs, descendantCapture, escapedDescendants, headless-json, headless-rpc, probe-dead, probe-unknown, psSnapshot, reclaimDescendants, runCmd, seat-io.mjs, seat-teardown, seatIo, settleSeatRoots, settleSeatTeardown, statIsZombie, teardownCore, verifyGroup
- crew/reclaim.test.mjs · ./reclaim.mjs, CONFLICT_REASONS, EVIDENCE_KINDS, LAUNCH_STATES, LEASE_PHASES, LIVENESS, LOCK_ATTEMPTS, LOCK_INTERVAL_MS, PARK_STATES, PHASES, SUCCESSOR_STATES, VERDICTS, answer-conflict, decision-mismatch, enqueue-unresolved, headless-rpc, lease-lock, leaseKey, markerLockName, no-answer, node:crypto, overrides.jsonl, park-settled, parkLockName, reclaim-lock-unavailable, reclaim.mjs, reclaimStore, reservationEngine, seat-busy, should-fix, successor-conflict
- crew/roster-refresh.test.mjs · roster.json
- crew/seat-io-runclean.test.mjs · ./headless.mjs, LIVENESS, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, WAIT_POLL_MS, builder.md, cellFailureKind, crew/seat-io.mjs, emitAdapter, headless-json, headless-rpc, headless.mjs, no-envelope, parse-error, probe-dead, probe-unknown, providerConditionDetail, readEnvelopeFile, reaskDecision, reclaimDescendants, samplePaneScreen, seat-died, seat-io.mjs, seat-teardown, seatIo, settleSeatRoots, settleSeatTeardown, surface-open-not-closed-here, teardown-threw, teardown-transports, teardownCore, unusable-envelope, waitForEnvelope
- skills/crew-dispatch/cli-contract.test.mjs · BOOT_ONLY_FLAGS, KNOWN_FLAGS, ROLE_FLAG_PREFIXES, VARIANTS, VARIANT_NAMES, crew/seat-io.mjs, seat-io.mjs, validation-lane, variants.mjs
- skills/devops/exhibits.test.mjs · DAEMON_COMMANDS, crew/daemon.mjs, daemon.mjs
- test/factory-ci-repair.test.mjs · UsageError, brief-file, crew.json, node:module, task.json
- test/factory-ci-watch.test.mjs · node:module
- test/factory-crew-watch.test.mjs · UsageError, crew.json, doc-viewer, journal.jsonl, node:crypto, seat-teardown, task.json
- test/factory-emit.test.mjs · 24.0.0, boot-refusal, node:module, run.json, runChild
- test/factory-env.test.mjs · bootCmd, child.mjs, crew/child.mjs, crew/daemon.mjs, daemon.mjs, runChild, runCmd, teardownCmd
- test/factory-intake.test.mjs · UsageError, VERDICTS, crew.json, daemon.mjs, run.json, task.json, write-failed
- test/factory-lane-watch.test.mjs · crew.json, hostLoad, journal.jsonl, task.json
- test/factory-ledger-floor.test.mjs · UsageError, err.reason
- test/factory-ledger.test.mjs · FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, UsageError, VARIANTS, VARIANT_NAMES, VERDICTS, boot-refusal, brief-file, child.mjs, crew.json, crew/child.mjs, crew/drive.mjs, crew/seat-io.mjs, emitAdapter, envelope-accept, headless-json, headless-rpc, journal.jsonl, node:module, probe-alive, probe-unknown, review-exhausted, roster.json, seat-died, seat-io.mjs, seat-teardown, sensitivity-floor, task.json, transport-error
- test/factory-make-brief.test.mjs · CHECK_FAIL_PREFIX, MUTATIONS_MAX, PROTECTED_PATHS, UsageError, checkFailureLine, child.mjs, crew/child.mjs, crew/drive.mjs, driveTask, model-ladder.json, node:crypto, planner.md, protected-paths, protected-paths.mjs, protectedHits, validateScopeEntries
- test/factory-probe-repo.test.mjs · crew/drive.mjs, err.reason, field-kind, protected-paths
- test/factory-reap-stale.test.mjs · DESCENDANT_DIR, UsageError, VERDICTS, crew/seat-io.mjs, headless-json, probe-unknown, seat-io.mjs, verifyGroup
- test/factory-transcript.test.mjs · FANOUT_TOOLS, SEAT_DEFAULTS, deniedFanout
- test/fixtures.mjs · slug.mjs
- test/fixtures.test.mjs · slug.mjs
- test/visualizer-panels.test.mjs · ROLE_ORDER, boot-refusal, review-exhausted, roster.json
- test/visualizer-returns.test.mjs · node:crypto, run.json, task.json
- test/visualizer-roster-edit.test.mjs · DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, ROLE_ORDER, assertCapabilities, model-ladder.json, resolveTier, roster.json
- test/visualizer-server.test.mjs · 127.0.0.1, UsageError, boot-refusal, no-envelope, node:crypto, node:module, node:net, review-exhausted, roster.json, run.json, seat-died, task.json, write-failed
- test/visualizer-shape.test.mjs · 127.0.0.1, ROLE_ORDER, boot-refusal, crew/seat-io.mjs, emitAdapter, no-envelope, node:module, review-exhausted, reviewOutcome, seat-io.mjs
- test/visualizer-teardown.test.mjs · 127.0.0.1, node:module, probe-alive, probe-dead, probe-unknown, seat-teardown
broad keys (not used as tripwires):
- changes-needed · 36 hits
- crew.mjs · 57 hits
- crew/crew.mjs · 43 hits
- daemon · 48 hits
- drive.mjs · 44 hits
- must-fix · 35 hits
- node:fs · 89 hits
- node:os · 54 hits
- node:path · 87 hits
- node:url · 40 hits
- refuse · 137 hits
- slug · 87 hits
- tech-lead · 31 hits
declare every hit: grep -rn "./adapters/adapter-claude.mjs\|./adapters/adapter-pi.mjs\|./converge.mjs\|./driver.mjs\|./escalation-policy.mjs\|./headless-rpc.mjs\|./headless.mjs\|./host-load.mjs\|./protected-paths.mjs\|./reclaim.mjs\|./slug.mjs\|./variants.mjs\|127.0.0.1\|24.0.0\|ADVISOR_BOOT_REFUSALS\|ADVISOR_CONFIG_VERSION\|BAND_FLOOR_REFUSALS\|BOOT_DESCENDANT_REFUSALS\|BOOT_ONLY_FLAGS\|CAPABILITY_DELIVERY\|CAPABILITY_REFUSALS\|CARVE_VERDICTS\|CHECK_FAIL_PREFIX\|CONFLICT_REASONS\|DAEMON_COMMANDS\|DECISIONS\|DEFAULT_BUDGET_WINDOW_MS\|DEFAULT_CONCURRENCY\|DEFAULT_ROLES\|DEFAULT_TRANSPORT\|DEFAULT_VARIANT\|DESCENDANT_DIR\|DESCENDANT_MAX_ANCHORS\|DESCENDANT_PS_TIMEOUT_MS\|DESCENDANT_SETTLE_MS\|DESCENDANT_SETTLE_POLLS\|DESCENDANT_STORE_DIRS\|DIRECTED_BLOCK\|DIRECTED_KEYS\|DIRECTED_SEATS\|DIRECTED_SOURCES\|DIRECTED_STAGES\|DIRECTED_STAGE_HEAD\|EMPTY_GRANTS\|ENVELOPE_FIELD_KINDS\|ENVELOPE_REFUSAL_REASONS\|EVENT_KINDS\|EVIDENCE_KINDS\|EXECUTIONS\|FAILURE_UPGRADE\|FANOUT_TOOLS\|FINDING_SEVERITIES\|GATE_CUSTODIAN\|GATE_REAP_CMD_EOF\|GATE_REAP_LAUNCH_EOF\|GATE_REAP_OUTCOMES\|GATE_REAP_SHELL\|GATE_REAP_SWEEP_MARKER\|GATE_SUMMARY_PREFIX\|GROWTH_DIVERGENCE_FACTOR\|HEADLESS_RPC_TRANSPORT\|HEADLESS_TRANSPORT\|HEADLESS_TRANSPORTS\|JUDGE_TIER\|KNOWN_FLAGS\|LADDER_PATH\|LAUNCH_STATES\|LEASE_PHASES\|LEDGER_NODE_FLOOR\|LIMITS\|LIVENESS\|LIVENESS_MISSES_TO_DIE\|LIVENESS_PROBE_MS\|LOAD_ENV\|LOCK_ATTEMPTS\|LOCK_INTERVAL_MS\|MAX_QUESTIONS\|MEMORY_ROLES\|MODIFIER_OUTCOMES\|MUTATIONS_MAX\|MUTATION_OUTCOMES\|PANEL_ADJUDICATORS\|PANEL_PARTNERS\|PANE_SAMPLE_LINES\|PANE_SAMPLE_TIMEOUT_MS\|PANE_SETTLE_MS\|PANE_SETTLE_POLLS\|PANE_TRANSPORT\|PARK_STATES\|PARTIAL_REVIEWED\|PERSPECTIVE_TARGETS\|PHASES\|PROTECTED_PATHS\|READY_CHROME\|REASK_MAX\|REASK_TIMEOUT_S\|REFUTATION_EVIDENCE_MAX\|REQUIRED_FLAGS\|RESEAT_LADDER\|RESEAT_REASONS\|RESIDUAL_TYPES\|REVIEWED_CORE_STAGES\|ROLE_FLAG_PREFIXES\|ROLE_ORDER\|RUN_EXIT_CODES\|RUN_EXIT_UNEXPECTED\|RUN_STATES\|SAFE_MODEL\|SCOPE_DIR_MIN_SEGMENTS\|SEAT_DEFAULTS\|SECOND_OPINION\|SENSITIVITY_FLOOR\|SETTLED_FEED_RETENTION\|SHADOW_ABSENT\|SHADOW_EXCLUSIONS\|SHADOW_OUTCOMES\|SHADOW_PICK_SCHEMA\|SHADOW_RATE_FLOOR\|SHAPE_SOURCES\|SUBSTRATE_MISSES_TO_DIE\|SUCCESSOR_STATES\|TRIAGE_SOURCES\|TRIAGE_STAGES\|TRIAGE_STAGE_HEAD\|UNIVERSAL_STAGE_HEADS\|UsageError\|VALIDATION_LANE_REFUSAL\|VARIANTS\|VARIANT_NAMES\|VARIANT_STAGE_PHASES\|VERDICTS\|WAITS_S\|WAIT_FLAGS\|WAIT_POLL_MS\|WAIT_REFUSALS\|WAIT_ROLES\|WAIT_SECONDS_MAX\|WAIT_SECONDS_MIN\|WRITE_SURFACES\|acceptContractLines\|acceptedViaLabel\|adapter-claude.mjs\|adapter-pi.mjs\|adapter-unsupported\|advisor-manifest\|advisor-manifest-unavailable\|advisor-manifest.json\|advisor-preflight\|advisor-refusal\|advisorBootRecord\|advisorManifest\|agent-change\|agent-unresolved\|already-dead\|answer-conflict\|answerBounceLines\|applyPrescriptionLines\|assertAdvisorCellLive\|assertAdvisorManifest\|assertBandFloors\|assertCapabilities\|assertCtxSources\|assertDefBandFloors\|assertFanoutCoherent\|assertGrantsBacked\|assertHostQuiet\|assertSeats\|assertUsage\|awaitSeatsReady\|band-below-floor\|band-unknown\|bandForMember\|bandForRaw\|baselineGateDefect\|boot-descendant-sweep\|boot-refusal\|bootAllocation\|bootCmd\|breaker-open\|brief-file\|build-exhausted\|build-fix\|build-rounds\|builder.md\|cache:v2\|capability-shortfall\|cellFailureKind\|changes-needed\|checkFailureLine\|child.mjs\|classifyAdvisorCell\|colorNeutralEnv\|composeCommitMessage\|composeLayout\|converge.mjs\|correctness-unverified\|crew.json\|crew.mjs\|crew/child.mjs\|crew/crew.mjs\|crew/daemon.mjs\|crew/drive.mjs\|crew/reclaim.mjs\|crew/seat-io.mjs\|daemon\|daemon.mjs\|decision-mismatch\|deniedFanout\|deriveState\|descendant-reclaim-failed\|descendantCapture\|descendantRefusal\|descendants-alive\|descendants-evidence-mismatch\|descendants-sweep-failed\|descendants-unknown\|descendants-unreclaimed\|doc-viewer\|docOpenArgs\|drive.mjs\|driveTask\|driver.mjs\|effectiveCapabilities\|effectiveTools\|emitAdapter\|endpoint-credentials\|endpoint-dead\|endpoint-not-local\|endpoint-unset\|enqueue-unresolved\|envelope-accept\|envelopeDefect\|envelopeFieldsPresent\|err.reason\|escalation-policy.mjs\|escalationAttention\|escapedDescendants\|fallback-from-plan-summary\|field-item\|field-kind\|field-missing\|floor-unratified\|gate-repair\|gate-repair-bounce.md\|gate-triage\|gateReapCommand\|gateReapFresh\|gateReapOriginal\|gateReapSweepCommand\|gateReapVerdict\|grant-contradicts-deny\|grant-unsupported\|grantedDefModels\|grantsFor\|growthLines\|growthRecord\|headless-json\|headless-rpc\|headless-rpc.mjs\|headless.mjs\|host-load.mjs\|hostLoad\|invalid-budget\|invalid-spec\|invalid-validation-lane\|isObject\|journal.jsonl\|ladder-unreadable\|lane-fence\|lane-fix\|laneFenceHits\|lead.md\|lease-lock\|leaseKey\|loadCapabilities\|loadLadder\|loadPolicy\|local-endpoint-dead\|local-settings-missing\|markerLockName\|matchAnswers\|memory-backend\|memory-budget-bytes\|memory-dir\|memoryConfig\|memoryExtracts\|model-ladder.json\|model-unsafe\|model-unset\|modelStringFor\|must-fix\|new-workspace\|nextModelRung\|nextRung\|no-answer\|no-candidate\|no-envelope\|no-tier\|node:crypto\|node:fs\|node:module\|node:net\|node:os\|node:path\|node:url\|normaliseScreenText\|normalizeEvent\|not-capable\|not-consulted\|outOfScopeFiles\|overrides.jsonl\|paneAlive\|paneProbe\|paneSampleRow\|paneSeat\|paneTeardownRows\|panel-a\|panel-adjudication\|panel-b\|panel-divergence\|panelSeats\|park-mint-failed\|park-settled\|parkLockName\|parkOnOutcome\|parkSeats\|parse-error\|parseDirectedBrief\|parseGateSummary\|parseQuestions\|phaseForStage\|plan-rounds\|planner.md\|pristine.ok\|probe-alive\|probe-dead\|probe-unknown\|probeLocalEndpoint\|protected-paths\|protected-paths.mjs\|protectedHits\|providerConditionDetail\|psSnapshot\|questionConsultLines\|readEnvelopeFile\|reaskBrief\|reaskDecision\|reclaim-clock-invalid\|reclaim-lock-unavailable\|reclaim.mjs\|reclaimDescendants\|reclaimStore\|refuse\|refuseBandFloor\|refuseStaleDescendants\|refuseWait\|refuted-must-fix\|remove-failed\|reservationEngine\|resolveAdapters\|resolveFilesInScope\|resolveLaneFence\|resolveProtectedPaths\|resolveSeatModels\|resolveTier\|resolveValidationLane\|resolveVariant\|resolveWaits\|resolveWorkerBin\|review-exhausted\|review-fix\|review-rounds\|review.md\|review:pass\|reviewFindings\|reviewOutcome\|reviewer.md\|role-unsupported\|roster.json\|run.json\|runChild\|runCmd\|runExitCode\|samplePaneScreen\|saveCrew\|scope-fix\|scope-gate\|scopeEntryDefects\|scopeMatcher\|seat-busy\|seat-died\|seat-io.mjs\|seat-root-settle-failed\|seat-teardown\|seatBand\|seatIo\|seatLiveness\|seatModelKey\|seatReadySignal\|seatShortfalls\|seatTransport\|second-opinion\|sensitivity-floor\|settleSeatRoots\|settleSeatTeardown\|shadowCandidates\|shadowExclusion\|shadowPick\|shadowPickBoot\|shapeDefect\|should-fix\|slug\|slug.mjs\|sourcesDefect\|stageEnabled\|stale-descendants\|statIsZombie\|substrate-gone\|successor-conflict\|surface-open-not-closed-here\|task.json\|teardown-threw\|teardown-transports\|teardownCmd\|teardownCore\|tech-lead\|tech-lead.md\|terminal-result\|timeout-s\|tool-call\|transport-error\|transport-unsupported\|transportFor\|tripwire-tests-absent\|undeclaredStage\|unusable-envelope\|usageWindow\|validateAcceptDecision\|validateCapabilities\|validateCarve\|validateMutations\|validateScopeEntries\|validation-lane\|variants.mjs\|vendor-collision\|verifyGroup\|wait-builder\|wait-lead\|wait-planner\|wait-reviewer\|wait-tech-lead\|waitForEnvelope\|waitsCtx\|waitsRecord\|write-failed\|your-role" crew/ test/ scripts/ docs/
## Coupled sources
coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.
- crew/adapters/adapter-claude.mjs · SEAT_DEFAULTS · no fence in play
- crew/adapters/adapter-pi.mjs · FANOUT_TOOLS, assertAdvisorCellLive, assertFanoutCoherent · no fence in play
- crew/capabilities.mjs · CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, assertGrantsBacked, crew/daemon.mjs, daemon.mjs, effectiveCapabilities, grantsFor, loadCapabilities, validateCapabilities · no fence in play
- crew/escalation-policy.mjs · crew/drive.mjs · no fence in play
- crew/factoryctl.mjs · crew/daemon.mjs, daemon.mjs · no fence in play
- crew/headless-rpc.mjs · EVIDENCE_KINDS, LIVENESS, PHASES, VERDICTS, reclaim.mjs, reclaimStore · no fence in play
- crew/headless.mjs · EVIDENCE_KINDS, LIVENESS, PHASES, VERDICTS, reclaim.mjs, reclaimStore · no fence in play
- crew/limits.mjs · LIMITS, child.mjs, crew/child.mjs, crew/drive.mjs, memoryConfig · no fence in play
- crew/protected-paths.mjs · PROTECTED_PATHS, crew/drive.mjs, crew/reclaim.mjs, protectedHits, reclaim.mjs, resolveProtectedPaths · no fence in play
- crew/slug.mjs · daemon.mjs · no fence in play
- crew/variants.mjs · DEFAULT_VARIANT, VARIANTS, VARIANT_NAMES, daemon.mjs, undeclaredStage · no fence in play
- scripts/factory/ci-repair.mjs · UsageError · no fence in play
- scripts/factory/crew-watch.mjs · UsageError · no fence in play
- scripts/factory/emit.mjs · UsageError, bootCmd, child.mjs, crew/child.mjs, crew/drive.mjs, parseDirectedBrief, resolveAdapters · no fence in play
- scripts/factory/intake.mjs · UsageError · no fence in play
- scripts/factory/lane-watch.mjs · LIMITS, hostLoad, seat-io.mjs · no fence in play
- scripts/factory/ledger.mjs · DECISIONS, LIVENESS, MODIFIER_OUTCOMES, UsageError, VARIANTS, VARIANT_NAMES, VERDICTS, assertCapabilities, bootCmd, child.mjs, crew/child.mjs, crew/daemon.mjs, crew/drive.mjs, crew/reclaim.mjs, crew/seat-io.mjs, daemon.mjs, reclaim.mjs, resolveTier, reviewOutcome, seat-io.mjs · no fence in play
- scripts/factory/make-brief.mjs · CHECK_FAIL_PREFIX, DIRECTED_KEYS, GATE_SUMMARY_PREFIX, MUTATIONS_MAX, PROTECTED_PATHS, checkFailureLine, crew/drive.mjs, crew/seat-io.mjs, protectedHits, resolveProtectedPaths, scopeMatcher, seat-io.mjs, validateMutations, validateScopeEntries · no fence in play
- scripts/factory/probe-repo.mjs · crew/seat-io.mjs, seat-io.mjs · no fence in play
- scripts/factory/reap-stale.mjs · DESCENDANT_DIR, LIVENESS, VERDICTS, crew/reclaim.mjs, crew/seat-io.mjs, reclaim.mjs, reclaimDescendants, seat-io.mjs · no fence in play
- scripts/factory/transcript.mjs · crew/drive.mjs · no fence in play
- visualizer/server/ledger-feed.mjs · crew/daemon.mjs, daemon.mjs · no fence in play
- visualizer/server/roster-edit.mjs · DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, SEAT_DEFAULTS, assertCapabilities, resolveTier · no fence in play
- visualizer/server/shape.mjs · ROLE_ORDER, crew/daemon.mjs, crew/reclaim.mjs, crew/seat-io.mjs, daemon.mjs, reclaim.mjs, seat-io.mjs · no fence in play
- visualizer/web/src/lib/trace.js · crew/seat-io.mjs, seat-io.mjs · no fence in play
## Baseline
lane: npm test · pass 2171 · fail 0 · status: green
lane basis: ratified profile field test_command · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed
## Out of scope
No edits to the checkout. No speculation presented as findings. No re-litigating the 2026-08-23 audit registers (consistency/duplication/prose) — this hunt is behaviour only. Do not fix anything. Ledger content divergence is hunt h4's surface; note a lead and move on.
## Fences
no fence register supplied (`--fences` not given)
## What the crew decides
UNFILLED SLOT
## Acceptance
Every defect carries: (1) a REPRODUCTION — a self-contained program or command sequence, written into the task dir, that demonstrates the misbehaviour against a scratch copy of the repo (git archive HEAD into a temp dir, or a throwaway DEVTEAM_LEDGER_DIR / state dir), never against the checkout — the driver mechanically refuses a scout that changes a file; (2) observed versus expected, with the exact output pasted; (3) a severity call: corrupts-state / wrong-answer / hangs-or-leaks / refuses-wrongly / cosmetic; (4) the guard that SHOULD have caught it (a test, a refusal, a schema) and why it did not. A suspicion you could not reproduce goes in a separate SUSPICIONS section with what you tried — it is not a finding. Negative results are first-class: list every attack you ran that the code survived, so the next hunt does not re-run it. Findings ranked by severity. State which files you read in full. · Full suite green. · UNFILLED SLOT
## Acceptance gate
Planner authors it; **RED at baseline**, printing
`GATE-SUMMARY {"total":n,"failed":n,"errored":n}` (`GATE_SUMMARY_PREFIX`,
`crew/drive.mjs:70`) with `errored: 0` at baseline (#153). Prove the gate
discriminates (#168), resolve the repo from `process.cwd()`, name in a comment
the mutation each check kills, never assert the checkout is clean. If your
gate shells out to the suite, strip ANSI before parsing it (#240).
## Per-check mutations
A per-check mutation declaration is MACHINE-APPLIED: the driver find-and-replaces
on a scratch copy of the built tree, re-runs the gate, and requires that one check
to redden. A prose field (`"kills": "leaving the loop unconditional"`) cannot be
applied and is refused — `validateMutations` in `crew/drive.mjs` is the single
enforcement point. Each entry in `details.mutations` is EITHER a mutation OR an
exemption, never both, and at most 32 entries in all (`MUTATIONS_MAX`).

A mutation entry carries exactly:

    { "check": "C1", "file": "lib/widget.mjs", "find": "<literal text present in the file>", "replace": "<literal replacement>" }

- `check` — a stable token matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (letters,
  digits, dot, underscore, hyphen; starting with a letter or digit), unique across
  all entries. The gate MUST print `FAIL <check>` on that check's failing line
  (`CHECK_FAIL_PREFIX`), matched as an exact token — the label you declare and the
  label the gate prints are one string.
  Nothing may FOLLOW that label except a colon. `checkFailureLine`
  (`crew/drive.mjs`) is the matcher that decides, and it accepts the bare line or a
  single colon delimiter — nothing else. Literally:

      FAIL <check>                  ← accepted, the bare line
      FAIL <check>: <why>           ← accepted, the ONE delimiter is a colon
      FAIL <check> — <why>          ← REJECTED, an em dash is not a delimiter
      FAIL <check> <why>            ← REJECTED, a space is not a delimiter

  The reason, not merely the prohibition: a label may not be EXTENDED by what follows
  it. Were a space or a dash a legal delimiter, `FAIL cache` would match a
  `FAIL cache-v2` line and one check's red would be credited to another — the
  whole-gate false positive #330 exists to remove. Two planners in one day each wrote
  a human-readable separator instead, costing four gate generations across three lanes
  and escalating one lane whose code was correct (#387).
- `file` — required, repo-relative, a file and not a directory, and inside
  `files_in_scope`.
- `find` — required, non-empty LITERAL text that actually occurs in that file; not
  a regex, not a description.
- `replace` — required string, and must DIFFER from `find`; an identical pair
  mutates nothing.

An exemption entry carries exactly `{ "check": "<token>", "exempt": "<non-empty reason>" }`
and no `file`, `find` or `replace`.

The human sentence saying what a mutation kills belongs in a comment beside the
check in the gate file and in `plan.md`, never in the entry. Worked example — the
gate carries, above the check that prints `FAIL C1`:

    // MUTATION C1: neutralise the standing block in renderBrief's lines array and
    // no compiled brief carries the contract any more.

and the declaration is `{ "check": "C1", "file": "scripts/factory/make-brief.mjs", "find": "standingBlocks().mutations", "replace": "standingBlocks().nothing" }`.
Rationale: #330.

A gate that shells out to `node --test` MUST pass `--test-reporter=tap`. node
--test picks its reporter by context and the summary lines differ in their
leading character; measured on this checkout, same file and same environment,
the two shapes are LITERALLY:

    ℹ pass 7      ← default reporter, no --test-reporter flag
    ℹ fail 0
    # pass 7      ← --test-reporter=tap
    # fail 0

That leading character is `ℹ` (U+2139 INFORMATION SOURCE), not the ASCII
letter `i`, so a gate greping `^# fail (\d+)$` parses NOTHING under the
default reporter and reports no failures for a suite it never read. Pin the
reporter rather than widening the regex: the default is context-dependent and a
future Node release may change it again, so a tolerant regex accepting both
shapes still silently depends on the reporter for every shape it does not
anticipate. Match the LAST summary line, not the first — an earlier echoed
`# fail 0` otherwise satisfies the check while a later real nonzero summary
passes it.

Colour is the other half: `FORCE_COLOR` OVERRIDES `NO_COLOR`, so a
colour-neutral child must DELETE `FORCE_COLOR` (and `CLICOLOR_FORCE`) from its
environment rather than only setting `NO_COLOR=1`. Under `FORCE_COLOR=3
NO_COLOR=1` the measured line is `ESC[34mℹ pass 7ESC[39m` (ESC = 0x1b), so an
`^`-anchored grep matches nothing. Strip ANSI before parsing either shape
(#240). Rationale: #399.

A declared mutation must exercise the check's NARROWEST claimed property, not
merely redden the check. The per-check proof asks only "does this mutation redden
this check?"; it cannot ask "does this mutation exercise what this check
CLAIMS?", and on 2026-08-20 four checks certified `killed` were each weaker
than their own prose. Read your own mutation as an adversary: what is the cheapest
implementation that violates the sentence beside the check and still passes it?
Two measured counter-examples, both certified `killed`:

- A mutation landing IN A COMMENT. `C1` claimed "≥3 tests are named for the
  re-ask, one naming the bound"; its declared mutation rewrote a `re-ask`
  occurrence inside a COMMENT — text the check never reads — so it reddened
  nothing the check counts and the real mutation had to be found by hand.
  Mutate the text the check actually parses; if no such `find` exists, the
  check is reading something other than what its prose claims.
- A negative-claim fixture INDISTINGUISHABLE from what already exists. `G15`
  claimed "an unknown adapter's overlay cannot silently widen another
  adapter", and injected an overlay carrying an extension the target ALREADY
  had, then asserted only that a third adapter stayed empty. An implementation
  merging every overlay into the target passes it: the duplicate dedupes and
  the third adapter is untouched. State a negative claim positively — the
  injected fixture must be DISTINCTIVE, a value nothing else in the fixture
  carries so its arrival is unambiguous, and the protected side must be
  compared BEFORE-AND-AFTER, never merely observed to be empty.

A COMPOUND CLAIM needs one mutation per half. `G15` ("cannot widen" AND
"another adapter") and `L11` ("every anchor" AND "one a resolver reads") each
had a half no declared mutation probed: `L11`'s check added every discovered RANGE
citation to its own resolved set, while its mutation used the single-line form,
so the range hole was never touched. If the sentence beside your check has two
verbs, declare two entries or write a narrower sentence.
Rationale: #409.
## Validation lane
narrow: node --test commands/commands.test.mjs crew/adapter-pi.test.mjs crew/arms.test.mjs crew/breaker.test.mjs crew/capabilities.test.mjs crew/converge.test.mjs crew/crew.test.mjs crew/daemon.test.mjs crew/drive.test.mjs crew/driver.test.mjs crew/escalation-policy.test.mjs crew/factoryctl.test.mjs crew/harvest.test.mjs crew/headless-rpc.test.mjs crew/headless.test.mjs crew/host-load.test.mjs crew/io-contract.test.mjs crew/pi/extensions/advisor.test.mjs crew/pi/extensions/lab.test.mjs crew/pi/extensions/subagent.test.mjs crew/reclaim-descendants.test.mjs crew/reclaim.test.mjs crew/roster-refresh.test.mjs crew/seat-io-runclean.test.mjs skills/crew-dispatch/cli-contract.test.mjs skills/devops/exhibits.test.mjs test/factory-ci-repair.test.mjs test/factory-ci-watch.test.mjs test/factory-crew-watch.test.mjs test/factory-emit.test.mjs test/factory-env.test.mjs test/factory-intake.test.mjs test/factory-lane-watch.test.mjs test/factory-ledger-floor.test.mjs test/factory-ledger.test.mjs test/factory-make-brief.test.mjs test/factory-probe-repo.test.mjs test/factory-reap-stale.test.mjs test/factory-transcript.test.mjs test/fixtures.mjs test/fixtures.test.mjs test/visualizer-panels.test.mjs test/visualizer-returns.test.mjs test/visualizer-roster-edit.test.mjs test/visualizer-server.test.mjs test/visualizer-shape.test.mjs test/visualizer-teardown.test.mjs
full: npm test · measured baseline pass 2171, fail 0
## Conventions
files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): crew/child.mjs, crew/crew.mjs, crew/daemon.mjs, crew/drive.mjs, crew/reclaim.mjs, crew/seat-io.mjs
read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): commands/commands.test.mjs, crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/capabilities.test.mjs, crew/converge.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/host-load.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
conventions of record (basis: ratified profile field conventions · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json): .claude/, README.md, docs/adr/, docs/conventions.md
grep -rn "./adapters/adapter-claude.mjs\|./adapters/adapter-pi.mjs\|./converge.mjs\|./driver.mjs\|./escalation-policy.mjs\|./headless-rpc.mjs\|./headless.mjs\|./host-load.mjs\|./protected-paths.mjs\|./reclaim.mjs\|./slug.mjs\|./variants.mjs\|127.0.0.1\|24.0.0\|ADVISOR_BOOT_REFUSALS\|ADVISOR_CONFIG_VERSION\|BAND_FLOOR_REFUSALS\|BOOT_DESCENDANT_REFUSALS\|BOOT_ONLY_FLAGS\|CAPABILITY_DELIVERY\|CAPABILITY_REFUSALS\|CARVE_VERDICTS\|CHECK_FAIL_PREFIX\|CONFLICT_REASONS\|DAEMON_COMMANDS\|DECISIONS\|DEFAULT_BUDGET_WINDOW_MS\|DEFAULT_CONCURRENCY\|DEFAULT_ROLES\|DEFAULT_TRANSPORT\|DEFAULT_VARIANT\|DESCENDANT_DIR\|DESCENDANT_MAX_ANCHORS\|DESCENDANT_PS_TIMEOUT_MS\|DESCENDANT_SETTLE_MS\|DESCENDANT_SETTLE_POLLS\|DESCENDANT_STORE_DIRS\|DIRECTED_BLOCK\|DIRECTED_KEYS\|DIRECTED_SEATS\|DIRECTED_SOURCES\|DIRECTED_STAGES\|DIRECTED_STAGE_HEAD\|EMPTY_GRANTS\|ENVELOPE_FIELD_KINDS\|ENVELOPE_REFUSAL_REASONS\|EVENT_KINDS\|EVIDENCE_KINDS\|EXECUTIONS\|FAILURE_UPGRADE\|FANOUT_TOOLS\|FINDING_SEVERITIES\|GATE_CUSTODIAN\|GATE_REAP_CMD_EOF\|GATE_REAP_LAUNCH_EOF\|GATE_REAP_OUTCOMES\|GATE_REAP_SHELL\|GATE_REAP_SWEEP_MARKER\|GATE_SUMMARY_PREFIX\|GROWTH_DIVERGENCE_FACTOR\|HEADLESS_RPC_TRANSPORT\|HEADLESS_TRANSPORT\|HEADLESS_TRANSPORTS\|JUDGE_TIER\|KNOWN_FLAGS\|LADDER_PATH\|LAUNCH_STATES\|LEASE_PHASES\|LEDGER_NODE_FLOOR\|LIMITS\|LIVENESS\|LIVENESS_MISSES_TO_DIE\|LIVENESS_PROBE_MS\|LOAD_ENV\|LOCK_ATTEMPTS\|LOCK_INTERVAL_MS\|MAX_QUESTIONS\|MEMORY_ROLES\|MODIFIER_OUTCOMES\|MUTATIONS_MAX\|MUTATION_OUTCOMES\|PANEL_ADJUDICATORS\|PANEL_PARTNERS\|PANE_SAMPLE_LINES\|PANE_SAMPLE_TIMEOUT_MS\|PANE_SETTLE_MS\|PANE_SETTLE_POLLS\|PANE_TRANSPORT\|PARK_STATES\|PARTIAL_REVIEWED\|PERSPECTIVE_TARGETS\|PHASES\|PROTECTED_PATHS\|READY_CHROME\|REASK_MAX\|REASK_TIMEOUT_S\|REFUTATION_EVIDENCE_MAX\|REQUIRED_FLAGS\|RESEAT_LADDER\|RESEAT_REASONS\|RESIDUAL_TYPES\|REVIEWED_CORE_STAGES\|ROLE_FLAG_PREFIXES\|ROLE_ORDER\|RUN_EXIT_CODES\|RUN_EXIT_UNEXPECTED\|RUN_STATES\|SAFE_MODEL\|SCOPE_DIR_MIN_SEGMENTS\|SEAT_DEFAULTS\|SECOND_OPINION\|SENSITIVITY_FLOOR\|SETTLED_FEED_RETENTION\|SHADOW_ABSENT\|SHADOW_EXCLUSIONS\|SHADOW_OUTCOMES\|SHADOW_PICK_SCHEMA\|SHADOW_RATE_FLOOR\|SHAPE_SOURCES\|SUBSTRATE_MISSES_TO_DIE\|SUCCESSOR_STATES\|TRIAGE_SOURCES\|TRIAGE_STAGES\|TRIAGE_STAGE_HEAD\|UNIVERSAL_STAGE_HEADS\|UsageError\|VALIDATION_LANE_REFUSAL\|VARIANTS\|VARIANT_NAMES\|VARIANT_STAGE_PHASES\|VERDICTS\|WAITS_S\|WAIT_FLAGS\|WAIT_POLL_MS\|WAIT_REFUSALS\|WAIT_ROLES\|WAIT_SECONDS_MAX\|WAIT_SECONDS_MIN\|WRITE_SURFACES\|acceptContractLines\|acceptedViaLabel\|adapter-claude.mjs\|adapter-pi.mjs\|adapter-unsupported\|advisor-manifest\|advisor-manifest-unavailable\|advisor-manifest.json\|advisor-preflight\|advisor-refusal\|advisorBootRecord\|advisorManifest\|agent-change\|agent-unresolved\|already-dead\|answer-conflict\|answerBounceLines\|applyPrescriptionLines\|assertAdvisorCellLive\|assertAdvisorManifest\|assertBandFloors\|assertCapabilities\|assertCtxSources\|assertDefBandFloors\|assertFanoutCoherent\|assertGrantsBacked\|assertHostQuiet\|assertSeats\|assertUsage\|awaitSeatsReady\|band-below-floor\|band-unknown\|bandForMember\|bandForRaw\|baselineGateDefect\|boot-descendant-sweep\|boot-refusal\|bootAllocation\|bootCmd\|breaker-open\|brief-file\|build-exhausted\|build-fix\|build-rounds\|builder.md\|cache:v2\|capability-shortfall\|cellFailureKind\|changes-needed\|checkFailureLine\|child.mjs\|classifyAdvisorCell\|colorNeutralEnv\|composeCommitMessage\|composeLayout\|converge.mjs\|correctness-unverified\|crew.json\|crew.mjs\|crew/child.mjs\|crew/crew.mjs\|crew/daemon.mjs\|crew/drive.mjs\|crew/reclaim.mjs\|crew/seat-io.mjs\|daemon\|daemon.mjs\|decision-mismatch\|deniedFanout\|deriveState\|descendant-reclaim-failed\|descendantCapture\|descendantRefusal\|descendants-alive\|descendants-evidence-mismatch\|descendants-sweep-failed\|descendants-unknown\|descendants-unreclaimed\|doc-viewer\|docOpenArgs\|drive.mjs\|driveTask\|driver.mjs\|effectiveCapabilities\|effectiveTools\|emitAdapter\|endpoint-credentials\|endpoint-dead\|endpoint-not-local\|endpoint-unset\|enqueue-unresolved\|envelope-accept\|envelopeDefect\|envelopeFieldsPresent\|err.reason\|escalation-policy.mjs\|escalationAttention\|escapedDescendants\|fallback-from-plan-summary\|field-item\|field-kind\|field-missing\|floor-unratified\|gate-repair\|gate-repair-bounce.md\|gate-triage\|gateReapCommand\|gateReapFresh\|gateReapOriginal\|gateReapSweepCommand\|gateReapVerdict\|grant-contradicts-deny\|grant-unsupported\|grantedDefModels\|grantsFor\|growthLines\|growthRecord\|headless-json\|headless-rpc\|headless-rpc.mjs\|headless.mjs\|host-load.mjs\|hostLoad\|invalid-budget\|invalid-spec\|invalid-validation-lane\|isObject\|journal.jsonl\|ladder-unreadable\|lane-fence\|lane-fix\|laneFenceHits\|lead.md\|lease-lock\|leaseKey\|loadCapabilities\|loadLadder\|loadPolicy\|local-endpoint-dead\|local-settings-missing\|markerLockName\|matchAnswers\|memory-backend\|memory-budget-bytes\|memory-dir\|memoryConfig\|memoryExtracts\|model-ladder.json\|model-unsafe\|model-unset\|modelStringFor\|must-fix\|new-workspace\|nextModelRung\|nextRung\|no-answer\|no-candidate\|no-envelope\|no-tier\|node:crypto\|node:fs\|node:module\|node:net\|node:os\|node:path\|node:url\|normaliseScreenText\|normalizeEvent\|not-capable\|not-consulted\|outOfScopeFiles\|overrides.jsonl\|paneAlive\|paneProbe\|paneSampleRow\|paneSeat\|paneTeardownRows\|panel-a\|panel-adjudication\|panel-b\|panel-divergence\|panelSeats\|park-mint-failed\|park-settled\|parkLockName\|parkOnOutcome\|parkSeats\|parse-error\|parseDirectedBrief\|parseGateSummary\|parseQuestions\|phaseForStage\|plan-rounds\|planner.md\|pristine.ok\|probe-alive\|probe-dead\|probe-unknown\|probeLocalEndpoint\|protected-paths\|protected-paths.mjs\|protectedHits\|providerConditionDetail\|psSnapshot\|questionConsultLines\|readEnvelopeFile\|reaskBrief\|reaskDecision\|reclaim-clock-invalid\|reclaim-lock-unavailable\|reclaim.mjs\|reclaimDescendants\|reclaimStore\|refuse\|refuseBandFloor\|refuseStaleDescendants\|refuseWait\|refuted-must-fix\|remove-failed\|reservationEngine\|resolveAdapters\|resolveFilesInScope\|resolveLaneFence\|resolveProtectedPaths\|resolveSeatModels\|resolveTier\|resolveValidationLane\|resolveVariant\|resolveWaits\|resolveWorkerBin\|review-exhausted\|review-fix\|review-rounds\|review.md\|review:pass\|reviewFindings\|reviewOutcome\|reviewer.md\|role-unsupported\|roster.json\|run.json\|runChild\|runCmd\|runExitCode\|samplePaneScreen\|saveCrew\|scope-fix\|scope-gate\|scopeEntryDefects\|scopeMatcher\|seat-busy\|seat-died\|seat-io.mjs\|seat-root-settle-failed\|seat-teardown\|seatBand\|seatIo\|seatLiveness\|seatModelKey\|seatReadySignal\|seatShortfalls\|seatTransport\|second-opinion\|sensitivity-floor\|settleSeatRoots\|settleSeatTeardown\|shadowCandidates\|shadowExclusion\|shadowPick\|shadowPickBoot\|shapeDefect\|should-fix\|slug\|slug.mjs\|sourcesDefect\|stageEnabled\|stale-descendants\|statIsZombie\|substrate-gone\|successor-conflict\|surface-open-not-closed-here\|task.json\|teardown-threw\|teardown-transports\|teardownCmd\|teardownCore\|tech-lead\|tech-lead.md\|terminal-result\|timeout-s\|tool-call\|transport-error\|transport-unsupported\|transportFor\|tripwire-tests-absent\|undeclaredStage\|unusable-envelope\|usageWindow\|validateAcceptDecision\|validateCapabilities\|validateCarve\|validateMutations\|validateScopeEntries\|validation-lane\|variants.mjs\|vendor-collision\|verifyGroup\|wait-builder\|wait-lead\|wait-planner\|wait-reviewer\|wait-tech-lead\|waitForEnvelope\|waitsCtx\|waitsRecord\|write-failed\|your-role" crew/ test/ scripts/ docs/
- The factory scripts carry a Node ≥24 floor; follow the existing
  `scripts/factory/*` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No `Co-Authored-By` trailers.
- If interrupted, write your ReturnEnvelope first on resume — `status:
  insufficient` if incomplete. A silent seat is indistinguishable from a dead
  one.
