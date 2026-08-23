# Task: Adversarial defect hunt on input boundaries: feed every parse edge hostile, malformed, and boundary input and catch a wrong acceptance, wrong refusal, crash, or hang. Surfaces and attack shapes: CLI flag parsing in crew.mjs and factoryctl.mjs (repeated flags, empty values, flag-like values after --, unicode, values with newlines, the historical port-coercion class where a string reaches a number seam); the envelope readers in headless.mjs, headless-rpc.mjs and seat-io.mjs (truncated JSON, duplicate keys, wrong types that pass a truthiness check, an envelope claiming a role it does not have, gigantic strings against every cap); the fence register and scope entries (paths with .., backslashes, trailing whitespace, a directory masquerading as a file, unicode homoglyphs, entries that differ only by trailing slash); the brief compiler validateRequest/validateAsk/verifyWhere (asks crafted to pass token rules while empty of content, where entries that are symlinks out of the checkout); lab.ts program input (programs at exactly each cap boundary, RPC frames fragmenting mid-multibyte-character, a frame flood at LAB_FRAME_QUEUE_MAX).
## The ask
Adversarial defect hunt on input boundaries: feed every parse edge hostile, malformed, and boundary input and catch a wrong acceptance, wrong refusal, crash, or hang. Surfaces and attack shapes: CLI flag parsing in crew.mjs and factoryctl.mjs (repeated flags, empty values, flag-like values after --, unicode, values with newlines, the historical port-coercion class where a string reaches a number seam); the envelope readers in headless.mjs, headless-rpc.mjs and seat-io.mjs (truncated JSON, duplicate keys, wrong types that pass a truthiness check, an envelope claiming a role it does not have, gigantic strings against every cap); the fence register and scope entries (paths with .., backslashes, trailing whitespace, a directory masquerading as a file, unicode homoglyphs, entries that differ only by trailing slash); the brief compiler validateRequest/validateAsk/verifyWhere (asks crafted to pass token rules while empty of content, where entries that are symlinks out of the checkout); lab.ts program input (programs at exactly each cap boundary, RPC frames fragmenting mid-multibyte-character, a frame flood at LAB_FRAME_QUEUE_MAX).
## Proposed tier
PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms
or overrides this at boot; the compiler never decides the tier.
proposed tier: judge
because:
- protected paths in force: 14 · ratified profile field protected_paths_candidates (3 entries) added to the authored floor · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
- scope breadth: 8 source files named by where (≥5 → judge)
- tripwire tests pinning that scope: 47
- protected path hit: crew/drive.mjs — tier judge unchanged (already highest)
proposed shape: build
because (risk signals):
- risk signal · protected path hit: crew/drive.mjs — shape build
proposed strength: frontier
because (complexity signals):
- complexity signal · scope breadth: 8 source file(s) named by where
- complexity signal · tripwire tests pinning that scope: 47
- complexity signal · directory where: none
- complexity judge → ratified ladder band frontier
```proposal
{
  "shape": "build",
  "strength": "frontier"
}
```
## Where
verified · file · crew/crew.mjs
verified · file · crew/factoryctl.mjs
verified · file · crew/headless.mjs
verified · file · crew/headless-rpc.mjs
verified · file · crew/seat-io.mjs
verified · file · crew/drive.mjs
verified · file · scripts/factory/make-brief.mjs
verified · file · crew/pi/extensions/lab.ts
## Done means
Every defect carries: (1) a REPRODUCTION — a self-contained program or command sequence, written into the task dir, that demonstrates the misbehaviour against a scratch copy of the repo (git archive HEAD into a temp dir, or a throwaway DEVTEAM_LEDGER_DIR / state dir), never against the checkout — the driver mechanically refuses a scout that changes a file; (2) observed versus expected, with the exact output pasted; (3) a severity call: corrupts-state / wrong-answer / hangs-or-leaks / refuses-wrongly / cosmetic; (4) the guard that SHOULD have caught it (a test, a refusal, a schema) and why it did not. A suspicion you could not reproduce goes in a separate SUSPICIONS section with what you tried — it is not a finding. Negative results are first-class: list every attack you ran that the code survived, so the next hunt does not re-run it. Findings ranked by severity. State which files you read in full.
## Tripwires
candidates: commands/commands.test.mjs, crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/capabilities.test.mjs, crew/converge.test.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.mjs, crew/headless-rpc.test.mjs, crew/headless.mjs, crew/headless.test.mjs, crew/host-load.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/lab.ts, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, crew/seat-io.mjs, scripts/factory/make-brief.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
tripwire tests:
- commands/commands.test.mjs · KNOWN_FLAGS, validation-lane
- crew/adapter-pi.test.mjs · ./adapters/adapter-pi.mjs, 127.0.0.1, ROLE_ORDER, SEAT_DEFAULTS, adapter-pi.mjs
- crew/arms.test.mjs · crew-dir, crew.json, write-failed
- crew/breaker.test.mjs · boot-refusal, breaker-open
- crew/capabilities.test.mjs · ./adapters/adapter-claude.mjs, ./adapters/adapter-pi.mjs, CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, adapter-claude.mjs, adapter-pi.mjs, assertGrantsBacked, capability-shortfall, crew/pi/extensions/lab.ts, effectiveCapabilities, endpoint-dead, err.reason, grant-contradicts-deny, grant-unsupported, grantsFor, lab.ts, loadCapabilities, local-endpoint-dead, local-settings-missing, validateCapabilities
- crew/converge.test.mjs · ./converge.mjs, converge.mjs, crew/drive.mjs, should-fix
- crew/crew.test.mjs · ./adapters/adapter-claude.mjs, ./adapters/adapter-pi.mjs, ./reclaim.mjs, 127.0.0.1, ADVISOR_BOOT_REFUSALS, ADVISOR_CONFIG_VERSION, BAND_FLOOR_REFUSALS, BOOT_DESCENDANT_REFUSALS, BOOT_ONLY_FLAGS, CAPABILITY_REFUSALS, DEFAULT_ROLES, DEFAULT_VARIANT, EMPTY_GRANTS, FANOUT_TOOLS, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, KNOWN_FLAGS, LADDER_PATH, LIMITS, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, MEMORY_ROLES, PANE_SETTLE_MS, PANE_SETTLE_POLLS, PROTECTED_PATHS, REQUIRED_FLAGS, ROLE_FLAG_PREFIXES, ROLE_ORDER, RUN_EXIT_CODES, RUN_EXIT_UNEXPECTED, SAFE_MODEL, SEAT_DEFAULTS, SHADOW_ABSENT, SHADOW_EXCLUSIONS, SHADOW_OUTCOMES, SUBSTRATE_MISSES_TO_DIE, UsageError, VALIDATION_LANE_REFUSAL, VARIANTS, VARIANT_NAMES, VARIANT_STAGE_PHASES, WAIT_POLL_MS, adapter-claude.mjs, adapter-pi.mjs, adapter-unsupported, advisorManifest, assertAdvisorManifest, assertBandFloors, assertCapabilities, assertCtxSources, assertDefBandFloors, assertFanoutCoherent, assertGrantsBacked, assertSeats, assertUsage, awaitSeatsReady, band-below-floor, band-unknown, bandForMember, bandForRaw, boot-descendant-sweep, boot-refusal, bootAllocation, bootCmd, breaker-open, brief-file, build-rounds, builder.md, capability-shortfall, cell-failure, cellFailureKind, classifyAdvisorCell, composeLayout, crew-dir, crew.json, crew/pi/extensions/lab.ts, deniedFanout, descendantRefusal, descendants-alive, descendants-evidence-mismatch, descendants-sweep-failed, descendants-unknown, descendants-unreclaimed, docOpenArgs, driveTask, effectiveTools, emitAdapter, endpoint-dead, envelope-accept, err.reason, escalationAttention, files-in-scope, floor-unratified, gate-repair, grant-contradicts-deny, grant-unsupported, grantedDefModels, grantsFor, headless-json, headless-rpc, invalid-budget, invalid-validation-lane, journal.jsonl, lab.ts, ladder-unreadable, lane-fence, lead.md, loadCapabilities, loadLadder, local-endpoint-dead, local-settings-missing, memory-backend, memory-budget-bytes, memory-dir, memoryConfig, model-ladder.json, no-candidate, not-consulted, paneAlive, paneProbe, paneTeardownRows, parkOnOutcome, parkSeats, phaseForStage, plan-rounds, planner.md, probe-alive, probe-dead, probe-repo.mjs, probe-unknown, probeLocalEndpoint, protected-paths, reclaim.mjs, reclaimDescendants, refuseBandFloor, refuseStaleDescendants, resolveAdapters, resolveFilesInScope, resolveLaneFence, resolveSeatModels, resolveTier, resolveValidationLane, resolveVariant, resolveWorkerBin, review-exhausted, review-rounds, review:pass, roster.json, runCmd, runExitCode, scope-gate, seat-died, seat-io.mjs, seat-teardown, seatBand, seatIo, seatLiveness, seatModelKey, seatReadySignal, seatTransport, shadowCandidates, shadowExclusion, shadowPick, shadowPickBoot, should-fix, stale-descendants, substrate-gone, task.json, teardownCmd, teardownCore, transport-error, transportFor, validateScopeEntries, validation-lane, vendor-collision, waitForEnvelope, your-role
- crew/daemon.test.mjs · ./escalation-policy.mjs, ./headless-rpc.mjs, ./variants.mjs, DEFAULT_TRANSPORT, PROTECTED_PATHS, VARIANTS, VARIANT_NAMES, brief-file, crew.json, daemon.sock, driveTask, emitAdapter, escalation-policy.mjs, exit-marker, headless-json, headless-rpc, headless-rpc.mjs, headlessRpcIo, journal.jsonl, lane-fence, node:net, probe-repo.mjs, probe-unknown, protected-paths, review.md, scope-gate, seat-io.mjs, seat-teardown, seatIo, settleSeatTeardown, slug.mjs, splitFrames, task.json, teardown-threw, teardown-transports, validateScopeEntries, variants.mjs
- crew/drive.test.mjs · ./escalation-policy.mjs, ./protected-paths.mjs, ./variants.mjs, CARVE_VERDICTS, CHECK_FAIL_PREFIX, DECISIONS, DEFAULT_VARIANT, DIRECTED_SEATS, DIRECTED_SOURCES, DIRECTED_STAGES, DIRECTED_STAGE_HEAD, ENVELOPE_FIELD_KINDS, ENVELOPE_REFUSAL_REASONS, EXECUTIONS, FAILURE_UPGRADE, FINDING_SEVERITIES, GATE_CUSTODIAN, GATE_REAP_CMD_EOF, GATE_REAP_SWEEP_MARKER, GATE_SUMMARY_PREFIX, GROWTH_DIVERGENCE_FACTOR, JUDGE_TIER, LIMITS, MAX_QUESTIONS, MODIFIER_OUTCOMES, MUTATIONS_MAX, MUTATION_OUTCOMES, PANEL_ADJUDICATORS, PANEL_PARTNERS, PARTIAL_REVIEWED, PERSPECTIVE_TARGETS, PROTECTED_PATHS, REFUSAL_REASONS, REFUTATION_EVIDENCE_MAX, RESIDUAL_TYPES, REVIEWED_CORE_STAGES, SECOND_OPINION, SENSITIVITY_FLOOR, SHAPE_SOURCES, TRIAGE_SOURCES, TRIAGE_STAGES, TRIAGE_STAGE_HEAD, UNIVERSAL_STAGE_HEADS, VARIANTS, VARIANT_NAMES, WAITS_S, WAIT_FLAGS, WAIT_REFUSALS, WAIT_ROLES, WAIT_SECONDS_MAX, WAIT_SECONDS_MIN, WRITE_SURFACES, acceptContractLines, acceptedViaLabel, agent-change, already-dead, answerBounceLines, applyPrescriptionLines, assertSeats, baselineGateDefect, brief-file, builder.md, cache:v2, cell-failure, checkFailureLine, composeCommitMessage, correctness-unverified, crew.json, crew/drive.mjs, crew/seat-io.mjs, driveTask, envelope-accept, envelopeDefect, envelopeFieldsPresent, err.reason, escalation-policy.mjs, field-item, field-kind, field-missing, gate-repair, gate-triage, gateReapCommand, gateReapFresh, gateReapOriginal, gateReapSweepCommand, gateReapVerdict, growthLines, growthRecord, headless-json, headless-rpc, journal.jsonl, laneFenceHits, lead.md, matchAnswers, model-ladder.json, no-envelope, no-tier, outOfScopeFiles, panel-a, panel-b, panel-divergence, panelSeats, parseDirectedBrief, parseGateSummary, parseQuestions, planner.md, probe-dead, protected-paths, protected-paths.mjs, protectedHits, questionConsultLines, reclaim.mjs, refuseWait, refuted-must-fix, resolveProtectedPaths, resolveWaits, review.md, review:pass, reviewFindings, reviewOutcome, reviewer.md, roster.json, runCmd, scope-gate, scopeMatcher, seat-io.mjs, seatIo, second-opinion, sensitivity-floor, shapeDefect, should-fix, sourcesDefect, stageEnabled, task.json, undeclaredStage, unusable-envelope, validateAcceptDecision, validateCarve, validateMutations, validateScopeEntries, variants.mjs, wait-builder, wait-lead, wait-planner, wait-reviewer, wait-tech-lead, waitsCtx, waitsRecord
- crew/driver.test.mjs · ./adapters/adapter-claude.mjs, ./adapters/adapter-pi.mjs, ./driver.mjs, adapter-claude.mjs, adapter-pi.mjs, driver.mjs, lead.md, planner.md, tech-lead.md
- crew/escalation-policy.test.mjs · ./escalation-policy.mjs, crew/drive.mjs, driveTask, escalation-policy.mjs, should-fix
- crew/factoryctl.test.mjs · attachVerb, crew-dir, crew.json, daemon.sock, factoryctl.mjs, files-in-scope, formatRows, headless-json, journal.jsonl, parseArgs, runVerb, stream-closed, task.json
- crew/harvest.test.mjs · crew.json
- crew/headless-rpc.test.mjs · ./headless-rpc.mjs, ./reclaim.mjs, PROMPT_REFUSAL_RETRIES, SETTLE_GATE_POLLS, carriesOwnSpend, cell-failure, emptyTurnEnvelope, exit-marker, foldRpcUsage, headless-rpc, headless-rpc.mjs, headlessRpcIo, invalid-pgid, isBusyRefusal, no-envelope, parse-error, probe-alive, probe-dead, probe-unknown, reclaim.mjs, rpc-no-envelope, rpc-parse-error, rpc-session-busy, rpc-spawn-failed, rpc-timeout, rpcCommand, seatCommandPath, splitFrames, steerFrame, teardownOutcome
- crew/headless.test.mjs · ./headless.mjs, classifyRun, foldUsage, headless-json, headless.mjs, headlessIo, no-envelope, recogniseProviderCondition
- crew/host-load.test.mjs · ./host-load.mjs, LOAD_ENV, assertHostQuiet, host-load.mjs, hostLoad, loadPolicy
- crew/io-contract.test.mjs · ./adapters/adapter-pi.mjs, ./driver.mjs, ./headless-rpc.mjs, ./headless.mjs, WAIT_POLL_MS, adapter-pi.mjs, agent-change, cell-failure, cellFailureKind, crew.json, driver.mjs, emitAdapter, headless-json, headless-rpc, headless-rpc.mjs, headless.mjs, headlessIo, headlessRpcIo, nextModelRung, nextRung, no-envelope, no-tier, parse-error, resolveSeatModels, resolveWorkerBin, roster.json, rpc-no-envelope, rpc-parse-error, rpc-session-busy, rpc-spawn-failed, rpc-timeout, seat-died, seat-io.mjs, seatIo, sensitivity-floor, transport-error, unusable-envelope
- crew/pi/extensions/advisor.test.mjs · 127.0.0.1, classifyAdvisorCell, endpoint-credentials, endpoint-not-local, endpoint-unset, role-unsupported
- crew/pi/extensions/lab.test.mjs · 127.0.0.1, crew/pi/extensions/lab.ts, grantsFor, journal.jsonl, lab.ts, loadCapabilities, node:net
- crew/pi/extensions/subagent.test.mjs · ./adapters/adapter-pi.mjs, ./headless-rpc.mjs, adapter-pi.mjs, assertGrantsBacked, carriesOwnSpend, crew/headless-rpc.mjs, effectiveCapabilities, foldRpcUsage, foldUsage, grantsFor, headless-rpc, headless-rpc.mjs, journal.jsonl, loadCapabilities
- crew/reclaim-descendants.test.mjs · DESCENDANT_DIR, DESCENDANT_MAX_ANCHORS, DESCENDANT_STORE_DIRS, already-dead, bootCmd, brief-file, descendantCapture, escapedDescendants, headless-json, headless-rpc, headlessIo, probe-dead, probe-unknown, psSnapshot, reclaimDescendants, runCmd, seat-io.mjs, seat-teardown, seatIo, settleSeatRoots, settleSeatTeardown, statIsZombie, teardownCore, verifyGroup
- crew/reclaim.test.mjs · ./reclaim.mjs, headless-rpc, node:crypto, reclaim.mjs, should-fix
- crew/roster-refresh.test.mjs · roster.json
- crew/seat-io-runclean.test.mjs · ./headless.mjs, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, PROVIDER_CONDITIONS, WAIT_POLL_MS, builder.md, cell-failure, cellFailureKind, crew/headless.mjs, crew/seat-io.mjs, emitAdapter, headless-json, headless-rpc, headless.mjs, headlessIo, headlessRpcIo, no-envelope, parse-error, probe-dead, probe-unknown, providerConditionDetail, readEnvelopeFile, reaskDecision, reclaimDescendants, recogniseProviderCondition, samplePaneScreen, seat-died, seat-io.mjs, seat-teardown, seatIo, settleSeatRoots, settleSeatTeardown, surface-open-not-closed-here, teardown-threw, teardown-transports, teardownCore, unusable-envelope, waitForEnvelope
- skills/crew-dispatch/cli-contract.test.mjs · BOOT_ONLY_FLAGS, KNOWN_FLAGS, ROLE_FLAG_PREFIXES, VARIANTS, VARIANT_NAMES, crew/seat-io.mjs, seat-io.mjs, validation-lane, variants.mjs
- skills/devops/exhibits.test.mjs · daemon.sock
- test/factory-ci-repair.test.mjs · BriefUsageError, UsageError, brief-file, crew-dir, crew.json, make-brief.mjs, task.json
- test/factory-ci-watch.test.mjs · ./probe-repo.mjs, probe-repo.mjs
- test/factory-crew-watch.test.mjs · UsageError, crew.json, doc-viewer, journal.jsonl, node:crypto, parseArgs, seat-teardown, task.json
- test/factory-emit.test.mjs · boot-refusal, cell-failure
- test/factory-env.test.mjs · bootCmd, cell-failure, runCmd, teardownCmd
- test/factory-intake.test.mjs · UsageError, crew.json, make-brief.mjs, task.json, write-failed
- test/factory-lane-watch.test.mjs · crew.json, hostLoad, journal.jsonl, task.json
- test/factory-ledger-floor.test.mjs · UsageError, err.reason
- test/factory-ledger.test.mjs · FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, UsageError, VARIANTS, VARIANT_NAMES, boot-refusal, brief-file, cell-failure, crew.json, crew/drive.mjs, crew/seat-io.mjs, emitAdapter, envelope-accept, exit-marker, headless-json, headless-rpc, journal.jsonl, make-brief.mjs, probe-alive, probe-unknown, review-exhausted, roster.json, scripts/factory/make-brief.mjs, seat-died, seat-io.mjs, seat-teardown, sensitivity-floor, task.json, transport-error
- test/factory-make-brief.test.mjs · ACCEPTANCE_GATE_BLOCK, BROAD_KEY_HIT_LIMIT, BriefUsageError, CHECK_FAIL_PREFIX, CONVENTIONS_BLOCK, DEFAULT_PROTECTED_PATHS, LADDER_BANDS, MUTATIONS_MAX, MUTATION_CONTRACT_BLOCK, PROPOSAL_BLOCK, PROPOSAL_KEYS, PROTECTED_PATHS, REFUSAL_REASONS, SLOT_MARKER, TIER_NAMES, UsageError, checkFailureLine, crew/drive.mjs, crossCheckCoupling, discoverTripwires, driveTask, extractKeys, extractSymbols, gatherFences, gatherProtectedPaths, make-brief.mjs, model-ladder.json, node:crypto, planner.md, probe-repo.mjs, profileField, proposeTier, protected-paths, protected-paths.mjs, protectedHits, readLadderBands, renderBrief, renderProposalBlock, renderProposedTier, resolveWriteSurface, scripts/factory/make-brief.mjs, validateAsk, validateScopeEntries, verifyWhere
- test/factory-probe-repo.test.mjs · crew/drive.mjs, err.reason, field-kind, probe-repo.mjs, protected-paths
- test/factory-reap-stale.test.mjs · DESCENDANT_DIR, UsageError, crew/seat-io.mjs, headless-json, invalid-pgid, parseArgs, probe-unknown, seat-io.mjs, verifyGroup
- test/factory-transcript.test.mjs · FANOUT_TOOLS, SEAT_DEFAULTS, deniedFanout
- test/fixtures.mjs · slug.mjs
- test/fixtures.test.mjs · slug.mjs
- test/visualizer-panels.test.mjs · ROLE_ORDER, boot-refusal, review-exhausted, roster.json
- test/visualizer-returns.test.mjs · node:crypto, task.json
- test/visualizer-roster-edit.test.mjs · DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, ROLE_ORDER, assertCapabilities, model-ladder.json, resolveTier, roster.json
- test/visualizer-server.test.mjs · 127.0.0.1, UsageError, boot-refusal, no-envelope, node:crypto, node:net, review-exhausted, roster.json, seat-died, task.json, write-failed
- test/visualizer-shape.test.mjs · 127.0.0.1, REFUSAL_REASONS, ROLE_ORDER, boot-refusal, crew/seat-io.mjs, emitAdapter, no-envelope, review-exhausted, reviewOutcome, seat-io.mjs
- test/visualizer-teardown.test.mjs · 127.0.0.1, probe-alive, probe-dead, probe-unknown, seat-teardown
broad keys (not used as tripwires):
- changes-needed · 36 hits
- connect · 47 hits
- crew.mjs · 57 hits
- crew/crew.mjs · 43 hits
- drive.mjs · 44 hits
- main · 160 hits
- must-fix · 35 hits
- node:fs · 89 hits
- node:os · 54 hits
- node:path · 87 hits
- node:url · 40 hits
- refuse · 137 hits
- slug · 87 hits
- tech-lead · 31 hits
declare every hit: grep -rn "../../crew/protected-paths.mjs\|./adapters/adapter-claude.mjs\|./adapters/adapter-pi.mjs\|./converge.mjs\|./driver.mjs\|./escalation-policy.mjs\|./headless-rpc.mjs\|./headless.mjs\|./host-load.mjs\|./probe-repo.mjs\|./protected-paths.mjs\|./reclaim.mjs\|./variants.mjs\|127.0.0.1\|ACCEPTANCE_GATE_BLOCK\|ADVISOR_BOOT_REFUSALS\|ADVISOR_CONFIG_VERSION\|BAND_FLOOR_REFUSALS\|BOOT_DESCENDANT_REFUSALS\|BOOT_ONLY_FLAGS\|BROAD_KEY_HIT_LIMIT\|BriefUsageError\|CAPABILITY_DELIVERY\|CAPABILITY_REFUSALS\|CARVE_VERDICTS\|CHECK_FAIL_PREFIX\|CONVENTIONS_BLOCK\|DECISIONS\|DEFAULT_PROTECTED_PATHS\|DEFAULT_ROLES\|DEFAULT_TIMEOUT_MS\|DEFAULT_TRANSPORT\|DEFAULT_VARIANT\|DESCENDANT_DIR\|DESCENDANT_MAX_ANCHORS\|DESCENDANT_PS_TIMEOUT_MS\|DESCENDANT_SETTLE_MS\|DESCENDANT_SETTLE_POLLS\|DESCENDANT_STORE_DIRS\|DIRECTED_BLOCK\|DIRECTED_KEYS\|DIRECTED_SEATS\|DIRECTED_SOURCES\|DIRECTED_STAGES\|DIRECTED_STAGE_HEAD\|EMPTY_GRANTS\|ENVELOPE_FIELD_KINDS\|ENVELOPE_REFUSAL_REASONS\|EXECUTIONS\|EXIT_MARKER_POLL_MS\|EXIT_MARKER_WINDOW_MS\|FAILURE_UPGRADE\|FANOUT_TOOLS\|FINDING_SEVERITIES\|GATE_CUSTODIAN\|GATE_REAP_CMD_EOF\|GATE_REAP_LAUNCH_EOF\|GATE_REAP_OUTCOMES\|GATE_REAP_SHELL\|GATE_REAP_SWEEP_MARKER\|GATE_SUMMARY_PREFIX\|GROWTH_DIVERGENCE_FACTOR\|HEADLESS_RPC_TRANSPORT\|HEADLESS_TRANSPORT\|HEADLESS_TRANSPORTS\|JUDGE_TIER\|KNOWN_FLAGS\|LADDER_BANDS\|LADDER_PATH\|LIMITS\|LIVENESS_MISSES_TO_DIE\|LIVENESS_PROBE_MS\|LOAD_ENV\|MAX_QUESTIONS\|MEMORY_ROLES\|MODIFIER_OUTCOMES\|MUTATIONS_MAX\|MUTATION_CONTRACT_BLOCK\|MUTATION_OUTCOMES\|PANEL_ADJUDICATORS\|PANEL_PARTNERS\|PANE_SAMPLE_LINES\|PANE_SAMPLE_TIMEOUT_MS\|PANE_SETTLE_MS\|PANE_SETTLE_POLLS\|PARTIAL_REVIEWED\|PERSPECTIVE_TARGETS\|PROMPT_REFUSAL_RETRIES\|PROPOSAL_BLOCK\|PROPOSAL_KEYS\|PROTECTED_PATHS\|PROVIDER_CONDITIONS\|READY_CHROME\|REASK_MAX\|REASK_TIMEOUT_S\|REFUSAL_REASONS\|REFUTATION_EVIDENCE_MAX\|REQUIRED_FLAGS\|RESEAT_LADDER\|RESEAT_REASONS\|RESIDUAL_TYPES\|REVIEWED_CORE_STAGES\|ROLE_FLAG_PREFIXES\|ROLE_ORDER\|RUN_EXIT_CODES\|RUN_EXIT_UNEXPECTED\|SAFE_MODEL\|SCOPE_DIR_MIN_SEGMENTS\|SEAT_COMMAND_FILE\|SEAT_DEFAULTS\|SECOND_OPINION\|SENSITIVITY_FLOOR\|SETTLE_GATE_POLLS\|SHADOW_ABSENT\|SHADOW_EXCLUSIONS\|SHADOW_OUTCOMES\|SHADOW_PICK_SCHEMA\|SHADOW_RATE_FLOOR\|SHAPE_SOURCES\|SLOT_MARKER\|SUBSTRATE_MISSES_TO_DIE\|TERM_REPEAT_MS\|TIER_NAMES\|TRIAGE_SOURCES\|TRIAGE_STAGES\|TRIAGE_STAGE_HEAD\|UNIVERSAL_STAGE_HEADS\|UsageError\|VALIDATION_LANE_REFUSAL\|VARIANTS\|VARIANT_NAMES\|VARIANT_STAGE_PHASES\|WAITS_S\|WAIT_FLAGS\|WAIT_POLL_MS\|WAIT_REFUSALS\|WAIT_ROLES\|WAIT_SECONDS_MAX\|WAIT_SECONDS_MIN\|WRITE_SURFACES\|acceptContractLines\|acceptedViaLabel\|adapter-claude.mjs\|adapter-pi.mjs\|adapter-unsupported\|advisor-manifest\|advisor-manifest-unavailable\|advisor-manifest.json\|advisor-preflight\|advisor-refusal\|advisorBootRecord\|advisorManifest\|agent-change\|agent-unresolved\|already-dead\|answerBounceLines\|applyPrescriptionLines\|assertAdvisorCellLive\|assertAdvisorManifest\|assertBandFloors\|assertCapabilities\|assertCtxSources\|assertDefBandFloors\|assertFanoutCoherent\|assertGrantsBacked\|assertHostQuiet\|assertSeats\|assertUsage\|attachVerb\|awaitSeatsReady\|band-below-floor\|band-unknown\|bandForMember\|bandForRaw\|baselineGateDefect\|boot-descendant-sweep\|boot-refusal\|bootAllocation\|bootCmd\|breaker-open\|brief-file\|build-exhausted\|build-fix\|build-rounds\|builder.md\|cache:v2\|capability-shortfall\|carriesOwnSpend\|cell-failure\|cellFailureKind\|changes-needed\|checkFailureLine\|classifyAdvisorCell\|classifyRun\|colorNeutralEnv\|composeCommitMessage\|composeLayout\|connect\|connection-closed\|converge.mjs\|correctness-unverified\|crew-dir\|crew.json\|crew.mjs\|crew/crew.mjs\|crew/drive.mjs\|crew/factoryctl.mjs\|crew/headless-rpc.mjs\|crew/headless.mjs\|crew/pi/extensions/lab.ts\|crew/seat-io.mjs\|crossCheckCoupling\|daemon-timeout\|daemon.sock\|deniedFanout\|descendant-reclaim-failed\|descendantCapture\|descendantRefusal\|descendants-alive\|descendants-evidence-mismatch\|descendants-sweep-failed\|descendants-unknown\|descendants-unreclaimed\|discoverTripwires\|doc-viewer\|docOpenArgs\|drive.mjs\|driveTask\|driver.mjs\|effectiveCapabilities\|effectiveTools\|emitAdapter\|emptyTurnEnvelope\|endpoint-credentials\|endpoint-dead\|endpoint-not-local\|endpoint-unset\|envelope-accept\|envelopeDefect\|envelopeFieldsPresent\|err.reason\|escalation-policy.mjs\|escalationAttention\|escapedDescendants\|exit-marker\|extractKeys\|extractSymbols\|factoryctl.mjs\|fallback-from-plan-summary\|field-item\|field-kind\|field-missing\|files-in-scope\|floor-unratified\|foldRpcUsage\|foldUsage\|formatRows\|gate-repair\|gate-repair-bounce.md\|gate-triage\|gateReapCommand\|gateReapFresh\|gateReapOriginal\|gateReapSweepCommand\|gateReapVerdict\|gatherBaseline\|gatherFences\|gatherProfile\|gatherProtectedPaths\|grant-contradicts-deny\|grant-unsupported\|grantedDefModels\|grantsFor\|growthLines\|growthRecord\|headless-json\|headless-rpc\|headless-rpc.mjs\|headless.mjs\|headlessIo\|headlessRpcIo\|host-load.mjs\|hostLoad\|invalid-budget\|invalid-pgid\|invalid-validation-lane\|isBusyRefusal\|journal.jsonl\|lab.ts\|ladder-unreadable\|lane-fence\|lane-fix\|laneFenceFor\|laneFenceHits\|lead.md\|loadCapabilities\|loadLadder\|loadPolicy\|local-endpoint-dead\|local-settings-missing\|lsVerb\|main\|make-brief.mjs\|matchAnswers\|memory-backend\|memory-budget-bytes\|memory-dir\|memoryConfig\|memoryExtracts\|model-ladder.json\|model-unsafe\|model-unset\|modelStringFor\|must-fix\|new-workspace\|nextModelRung\|nextRung\|no-candidate\|no-daemon\|no-envelope\|no-tier\|node:crypto\|node:fs\|node:net\|node:os\|node:path\|node:url\|normaliseScreenText\|not-consulted\|outOfScopeFiles\|paneAlive\|paneProbe\|paneSampleRow\|paneTeardownRows\|panel-a\|panel-adjudication\|panel-b\|panel-divergence\|panelSeats\|park-mint-failed\|parkOnOutcome\|parkSeats\|parse-error\|parseArgs\|parseDirectedBrief\|parseGateSummary\|parseQuestions\|phaseForStage\|plan-rounds\|planner.md\|pristine.ok\|probe-alive\|probe-dead\|probe-repo.mjs\|probe-unknown\|probeLocalEndpoint\|profileField\|proposeTier\|protected-paths\|protected-paths.mjs\|protectedHits\|providerConditionDetail\|psSnapshot\|questionConsultLines\|readEnvelopeFile\|readLadderBands\|reaskBrief\|reaskDecision\|reclaim.mjs\|reclaimDescendants\|recogniseProviderCondition\|refuse\|refuseBandFloor\|refuseStaleDescendants\|refuseWait\|refuted-must-fix\|remove-failed\|renderBrief\|renderProposalBlock\|renderProposedTier\|reservation-mismatch\|resolveAdapters\|resolveFilesInScope\|resolveLaneFence\|resolveProtectedPaths\|resolveSeatModels\|resolveTier\|resolveValidationLane\|resolveVariant\|resolveWaits\|resolveWorkerBin\|resolveWriteSurface\|review-exhausted\|review-fix\|review-rounds\|review.md\|review:pass\|reviewFindings\|reviewOutcome\|reviewer.md\|role-unsupported\|roster.json\|rpc-no-envelope\|rpc-parse-error\|rpc-session-busy\|rpc-session-not-in-flight\|rpc-spawn-failed\|rpc-timeout\|rpc-unresolvable-reservation\|rpcCommand\|runCmd\|runExitCode\|runVerb\|samplePaneScreen\|saveCrew\|scope-fix\|scope-gate\|scopeMatcher\|scripts/factory/make-brief.mjs\|seat-died\|seat-io.mjs\|seat-root-settle-failed\|seat-teardown\|seatBand\|seatCommandPath\|seatIo\|seatLiveness\|seatModelKey\|seatReadySignal\|seatShortfalls\|seatTransport\|second-opinion\|sendVerb\|sensitivity-floor\|settleSeatRoots\|settleSeatTeardown\|shadowCandidates\|shadowExclusion\|shadowPick\|shadowPickBoot\|shapeDefect\|should-fix\|signal-esrch\|slug\|slug.mjs\|socketPathFor\|sourcesDefect\|splitFrames\|stageEnabled\|stale-descendants\|statIsZombie\|steerFrame\|stream-closed\|substrate-gone\|surface-open-not-closed-here\|task.json\|teardown-threw\|teardown-transports\|teardownCmd\|teardownCore\|teardownOutcome\|tech-lead\|tech-lead.md\|timeout-s\|transport-error\|transport-unsupported\|transportFor\|tripwire-tests-absent\|undeclaredStage\|unusable-envelope\|validateAcceptDecision\|validateAsk\|validateCapabilities\|validateCarve\|validateMutations\|validateRequest\|validateScopeEntries\|validation-lane\|variants.mjs\|vendor-collision\|verifyGroup\|verifyWhere\|wait-builder\|wait-lead\|wait-planner\|wait-reviewer\|wait-tech-lead\|waitForEnvelope\|waitsCtx\|waitsRecord\|write-failed\|your-role" crew/ test/ scripts/ docs/
## Coupled sources
coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.
- crew/adapters/adapter-claude.mjs · SEAT_DEFAULTS · no fence in play
- crew/adapters/adapter-pi.mjs · FANOUT_TOOLS, assertAdvisorCellLive, assertFanoutCoherent, crew/headless-rpc.mjs, headless-rpc.mjs, rpcCommand · no fence in play
- crew/arms.mjs · factoryctl.mjs · no fence in play
- crew/capabilities.mjs · CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, assertGrantsBacked, effectiveCapabilities, grantsFor, loadCapabilities, validateCapabilities · no fence in play
- crew/child.mjs · LIMITS, VALIDATION_LANE_REFUSAL, VARIANTS, assertSeats, driveTask, resolveLaneFence, resolveValidationLane, seat-io.mjs, seatIo, settleSeatTeardown, validateScopeEntries · no fence in play
- crew/daemon.mjs · VARIANTS, VARIANT_NAMES, crew/headless-rpc.mjs, headless-rpc.mjs, seatCommandPath, splitFrames, steerFrame · no fence in play
- crew/escalation-policy.mjs · crew/drive.mjs · no fence in play
- crew/limits.mjs · LIMITS, crew/drive.mjs, memoryConfig · no fence in play
- crew/protected-paths.mjs · PROTECTED_PATHS, crew/drive.mjs, protectedHits, resolveProtectedPaths · no fence in play
- crew/variants.mjs · DEFAULT_VARIANT, VARIANTS, VARIANT_NAMES, undeclaredStage · no fence in play
- scripts/factory/ci-repair.mjs · BriefUsageError, REFUSAL_REASONS, UsageError, make-brief.mjs, renderBrief, validateRequest, verifyWhere · no fence in play
- scripts/factory/crew-watch.mjs · UsageError · no fence in play
- scripts/factory/emit.mjs · PROPOSAL_BLOCK, PROPOSAL_KEYS, UsageError, bootCmd, crew/drive.mjs, make-brief.mjs, parseDirectedBrief, renderProposalBlock, resolveAdapters, scripts/factory/make-brief.mjs · no fence in play
- scripts/factory/intake.mjs · BriefUsageError, UsageError, discoverTripwires, make-brief.mjs, proposeTier, renderBrief, resolveWriteSurface, validateRequest, verifyWhere · no fence in play
- scripts/factory/lane-watch.mjs · LIMITS, hostLoad, seat-io.mjs · no fence in play
- scripts/factory/ledger.mjs · DECISIONS, MODIFIER_OUTCOMES, UsageError, VARIANTS, VARIANT_NAMES, assertCapabilities, bootCmd, crew/drive.mjs, crew/seat-io.mjs, resolveTier, reviewOutcome, seat-io.mjs · no fence in play
- scripts/factory/probe-repo.mjs · crew/seat-io.mjs, gatherBaseline, gatherProtectedPaths, make-brief.mjs, seat-io.mjs · no fence in play
- scripts/factory/reap-stale.mjs · DESCENDANT_DIR, crew/seat-io.mjs, reclaimDescendants, seat-io.mjs · no fence in play
- scripts/factory/transcript.mjs · crew/drive.mjs · no fence in play
- visualizer/server/roster-edit.mjs · DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, SEAT_DEFAULTS, assertCapabilities, resolveTier · no fence in play
- visualizer/server/server.mjs · LADDER_PATH, make-brief.mjs · no fence in play
- visualizer/server/shape.mjs · ROLE_ORDER, crew/seat-io.mjs, seat-io.mjs · no fence in play
- visualizer/web/src/lib/trace.js · crew/seat-io.mjs, seat-io.mjs · no fence in play
## Baseline
lane: npm test · pass 2171 · fail 0 · status: green
lane basis: ratified profile field test_command · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed
## Out of scope
No edits to the checkout. No speculation presented as findings. No re-litigating the 2026-08-23 audit registers (consistency/duplication/prose) — this hunt is behaviour only. Do not fix anything. The HTTP surface is hunt h5's.
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
files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): crew/crew.mjs, crew/drive.mjs, crew/factoryctl.mjs, crew/headless-rpc.mjs, crew/headless.mjs, crew/pi/extensions/lab.ts, crew/seat-io.mjs, scripts/factory/make-brief.mjs
read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): commands/commands.test.mjs, crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/capabilities.test.mjs, crew/converge.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/host-load.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
conventions of record (basis: ratified profile field conventions · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json): .claude/, README.md, docs/adr/, docs/conventions.md
grep -rn "../../crew/protected-paths.mjs\|./adapters/adapter-claude.mjs\|./adapters/adapter-pi.mjs\|./converge.mjs\|./driver.mjs\|./escalation-policy.mjs\|./headless-rpc.mjs\|./headless.mjs\|./host-load.mjs\|./probe-repo.mjs\|./protected-paths.mjs\|./reclaim.mjs\|./variants.mjs\|127.0.0.1\|ACCEPTANCE_GATE_BLOCK\|ADVISOR_BOOT_REFUSALS\|ADVISOR_CONFIG_VERSION\|BAND_FLOOR_REFUSALS\|BOOT_DESCENDANT_REFUSALS\|BOOT_ONLY_FLAGS\|BROAD_KEY_HIT_LIMIT\|BriefUsageError\|CAPABILITY_DELIVERY\|CAPABILITY_REFUSALS\|CARVE_VERDICTS\|CHECK_FAIL_PREFIX\|CONVENTIONS_BLOCK\|DECISIONS\|DEFAULT_PROTECTED_PATHS\|DEFAULT_ROLES\|DEFAULT_TIMEOUT_MS\|DEFAULT_TRANSPORT\|DEFAULT_VARIANT\|DESCENDANT_DIR\|DESCENDANT_MAX_ANCHORS\|DESCENDANT_PS_TIMEOUT_MS\|DESCENDANT_SETTLE_MS\|DESCENDANT_SETTLE_POLLS\|DESCENDANT_STORE_DIRS\|DIRECTED_BLOCK\|DIRECTED_KEYS\|DIRECTED_SEATS\|DIRECTED_SOURCES\|DIRECTED_STAGES\|DIRECTED_STAGE_HEAD\|EMPTY_GRANTS\|ENVELOPE_FIELD_KINDS\|ENVELOPE_REFUSAL_REASONS\|EXECUTIONS\|EXIT_MARKER_POLL_MS\|EXIT_MARKER_WINDOW_MS\|FAILURE_UPGRADE\|FANOUT_TOOLS\|FINDING_SEVERITIES\|GATE_CUSTODIAN\|GATE_REAP_CMD_EOF\|GATE_REAP_LAUNCH_EOF\|GATE_REAP_OUTCOMES\|GATE_REAP_SHELL\|GATE_REAP_SWEEP_MARKER\|GATE_SUMMARY_PREFIX\|GROWTH_DIVERGENCE_FACTOR\|HEADLESS_RPC_TRANSPORT\|HEADLESS_TRANSPORT\|HEADLESS_TRANSPORTS\|JUDGE_TIER\|KNOWN_FLAGS\|LADDER_BANDS\|LADDER_PATH\|LIMITS\|LIVENESS_MISSES_TO_DIE\|LIVENESS_PROBE_MS\|LOAD_ENV\|MAX_QUESTIONS\|MEMORY_ROLES\|MODIFIER_OUTCOMES\|MUTATIONS_MAX\|MUTATION_CONTRACT_BLOCK\|MUTATION_OUTCOMES\|PANEL_ADJUDICATORS\|PANEL_PARTNERS\|PANE_SAMPLE_LINES\|PANE_SAMPLE_TIMEOUT_MS\|PANE_SETTLE_MS\|PANE_SETTLE_POLLS\|PARTIAL_REVIEWED\|PERSPECTIVE_TARGETS\|PROMPT_REFUSAL_RETRIES\|PROPOSAL_BLOCK\|PROPOSAL_KEYS\|PROTECTED_PATHS\|PROVIDER_CONDITIONS\|READY_CHROME\|REASK_MAX\|REASK_TIMEOUT_S\|REFUSAL_REASONS\|REFUTATION_EVIDENCE_MAX\|REQUIRED_FLAGS\|RESEAT_LADDER\|RESEAT_REASONS\|RESIDUAL_TYPES\|REVIEWED_CORE_STAGES\|ROLE_FLAG_PREFIXES\|ROLE_ORDER\|RUN_EXIT_CODES\|RUN_EXIT_UNEXPECTED\|SAFE_MODEL\|SCOPE_DIR_MIN_SEGMENTS\|SEAT_COMMAND_FILE\|SEAT_DEFAULTS\|SECOND_OPINION\|SENSITIVITY_FLOOR\|SETTLE_GATE_POLLS\|SHADOW_ABSENT\|SHADOW_EXCLUSIONS\|SHADOW_OUTCOMES\|SHADOW_PICK_SCHEMA\|SHADOW_RATE_FLOOR\|SHAPE_SOURCES\|SLOT_MARKER\|SUBSTRATE_MISSES_TO_DIE\|TERM_REPEAT_MS\|TIER_NAMES\|TRIAGE_SOURCES\|TRIAGE_STAGES\|TRIAGE_STAGE_HEAD\|UNIVERSAL_STAGE_HEADS\|UsageError\|VALIDATION_LANE_REFUSAL\|VARIANTS\|VARIANT_NAMES\|VARIANT_STAGE_PHASES\|WAITS_S\|WAIT_FLAGS\|WAIT_POLL_MS\|WAIT_REFUSALS\|WAIT_ROLES\|WAIT_SECONDS_MAX\|WAIT_SECONDS_MIN\|WRITE_SURFACES\|acceptContractLines\|acceptedViaLabel\|adapter-claude.mjs\|adapter-pi.mjs\|adapter-unsupported\|advisor-manifest\|advisor-manifest-unavailable\|advisor-manifest.json\|advisor-preflight\|advisor-refusal\|advisorBootRecord\|advisorManifest\|agent-change\|agent-unresolved\|already-dead\|answerBounceLines\|applyPrescriptionLines\|assertAdvisorCellLive\|assertAdvisorManifest\|assertBandFloors\|assertCapabilities\|assertCtxSources\|assertDefBandFloors\|assertFanoutCoherent\|assertGrantsBacked\|assertHostQuiet\|assertSeats\|assertUsage\|attachVerb\|awaitSeatsReady\|band-below-floor\|band-unknown\|bandForMember\|bandForRaw\|baselineGateDefect\|boot-descendant-sweep\|boot-refusal\|bootAllocation\|bootCmd\|breaker-open\|brief-file\|build-exhausted\|build-fix\|build-rounds\|builder.md\|cache:v2\|capability-shortfall\|carriesOwnSpend\|cell-failure\|cellFailureKind\|changes-needed\|checkFailureLine\|classifyAdvisorCell\|classifyRun\|colorNeutralEnv\|composeCommitMessage\|composeLayout\|connect\|connection-closed\|converge.mjs\|correctness-unverified\|crew-dir\|crew.json\|crew.mjs\|crew/crew.mjs\|crew/drive.mjs\|crew/factoryctl.mjs\|crew/headless-rpc.mjs\|crew/headless.mjs\|crew/pi/extensions/lab.ts\|crew/seat-io.mjs\|crossCheckCoupling\|daemon-timeout\|daemon.sock\|deniedFanout\|descendant-reclaim-failed\|descendantCapture\|descendantRefusal\|descendants-alive\|descendants-evidence-mismatch\|descendants-sweep-failed\|descendants-unknown\|descendants-unreclaimed\|discoverTripwires\|doc-viewer\|docOpenArgs\|drive.mjs\|driveTask\|driver.mjs\|effectiveCapabilities\|effectiveTools\|emitAdapter\|emptyTurnEnvelope\|endpoint-credentials\|endpoint-dead\|endpoint-not-local\|endpoint-unset\|envelope-accept\|envelopeDefect\|envelopeFieldsPresent\|err.reason\|escalation-policy.mjs\|escalationAttention\|escapedDescendants\|exit-marker\|extractKeys\|extractSymbols\|factoryctl.mjs\|fallback-from-plan-summary\|field-item\|field-kind\|field-missing\|files-in-scope\|floor-unratified\|foldRpcUsage\|foldUsage\|formatRows\|gate-repair\|gate-repair-bounce.md\|gate-triage\|gateReapCommand\|gateReapFresh\|gateReapOriginal\|gateReapSweepCommand\|gateReapVerdict\|gatherBaseline\|gatherFences\|gatherProfile\|gatherProtectedPaths\|grant-contradicts-deny\|grant-unsupported\|grantedDefModels\|grantsFor\|growthLines\|growthRecord\|headless-json\|headless-rpc\|headless-rpc.mjs\|headless.mjs\|headlessIo\|headlessRpcIo\|host-load.mjs\|hostLoad\|invalid-budget\|invalid-pgid\|invalid-validation-lane\|isBusyRefusal\|journal.jsonl\|lab.ts\|ladder-unreadable\|lane-fence\|lane-fix\|laneFenceFor\|laneFenceHits\|lead.md\|loadCapabilities\|loadLadder\|loadPolicy\|local-endpoint-dead\|local-settings-missing\|lsVerb\|main\|make-brief.mjs\|matchAnswers\|memory-backend\|memory-budget-bytes\|memory-dir\|memoryConfig\|memoryExtracts\|model-ladder.json\|model-unsafe\|model-unset\|modelStringFor\|must-fix\|new-workspace\|nextModelRung\|nextRung\|no-candidate\|no-daemon\|no-envelope\|no-tier\|node:crypto\|node:fs\|node:net\|node:os\|node:path\|node:url\|normaliseScreenText\|not-consulted\|outOfScopeFiles\|paneAlive\|paneProbe\|paneSampleRow\|paneTeardownRows\|panel-a\|panel-adjudication\|panel-b\|panel-divergence\|panelSeats\|park-mint-failed\|parkOnOutcome\|parkSeats\|parse-error\|parseArgs\|parseDirectedBrief\|parseGateSummary\|parseQuestions\|phaseForStage\|plan-rounds\|planner.md\|pristine.ok\|probe-alive\|probe-dead\|probe-repo.mjs\|probe-unknown\|probeLocalEndpoint\|profileField\|proposeTier\|protected-paths\|protected-paths.mjs\|protectedHits\|providerConditionDetail\|psSnapshot\|questionConsultLines\|readEnvelopeFile\|readLadderBands\|reaskBrief\|reaskDecision\|reclaim.mjs\|reclaimDescendants\|recogniseProviderCondition\|refuse\|refuseBandFloor\|refuseStaleDescendants\|refuseWait\|refuted-must-fix\|remove-failed\|renderBrief\|renderProposalBlock\|renderProposedTier\|reservation-mismatch\|resolveAdapters\|resolveFilesInScope\|resolveLaneFence\|resolveProtectedPaths\|resolveSeatModels\|resolveTier\|resolveValidationLane\|resolveVariant\|resolveWaits\|resolveWorkerBin\|resolveWriteSurface\|review-exhausted\|review-fix\|review-rounds\|review.md\|review:pass\|reviewFindings\|reviewOutcome\|reviewer.md\|role-unsupported\|roster.json\|rpc-no-envelope\|rpc-parse-error\|rpc-session-busy\|rpc-session-not-in-flight\|rpc-spawn-failed\|rpc-timeout\|rpc-unresolvable-reservation\|rpcCommand\|runCmd\|runExitCode\|runVerb\|samplePaneScreen\|saveCrew\|scope-fix\|scope-gate\|scopeMatcher\|scripts/factory/make-brief.mjs\|seat-died\|seat-io.mjs\|seat-root-settle-failed\|seat-teardown\|seatBand\|seatCommandPath\|seatIo\|seatLiveness\|seatModelKey\|seatReadySignal\|seatShortfalls\|seatTransport\|second-opinion\|sendVerb\|sensitivity-floor\|settleSeatRoots\|settleSeatTeardown\|shadowCandidates\|shadowExclusion\|shadowPick\|shadowPickBoot\|shapeDefect\|should-fix\|signal-esrch\|slug\|slug.mjs\|socketPathFor\|sourcesDefect\|splitFrames\|stageEnabled\|stale-descendants\|statIsZombie\|steerFrame\|stream-closed\|substrate-gone\|surface-open-not-closed-here\|task.json\|teardown-threw\|teardown-transports\|teardownCmd\|teardownCore\|teardownOutcome\|tech-lead\|tech-lead.md\|timeout-s\|transport-error\|transport-unsupported\|transportFor\|tripwire-tests-absent\|undeclaredStage\|unusable-envelope\|validateAcceptDecision\|validateAsk\|validateCapabilities\|validateCarve\|validateMutations\|validateRequest\|validateScopeEntries\|validation-lane\|variants.mjs\|vendor-collision\|verifyGroup\|verifyWhere\|wait-builder\|wait-lead\|wait-planner\|wait-reviewer\|wait-tech-lead\|waitForEnvelope\|waitsCtx\|waitsRecord\|write-failed\|your-role" crew/ test/ scripts/ docs/
- The factory scripts carry a Node ≥24 floor; follow the existing
  `scripts/factory/*` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No `Co-Authored-By` trailers.
- If interrupted, write your ReturnEnvelope first on resume — `status:
  insufficient` if incomplete. A silent seat is indistinguishable from a dead
  one.
