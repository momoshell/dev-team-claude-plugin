# Task: Adversarial defect hunt on the state machines: find unreachable states, absorbing states, and time-of-check races. Attack shapes: drive the stage ladder into every escalation path and check each is actually reachable and each records what it claims (the audit proved intake's protected-path refusal is unreachable — hunt for siblings: refusals whose guard condition can never be true, escalations that clobber an earlier reason); force converge/settle orderings that the code does not expect (a review verdict arriving after suite start, a lead accept racing a bounce); budget and wait windows (a seat finishing exactly at the deadline, a budget window of 0, a clock that jumps backwards mid-window); the intake claim ladder (claim verified then boot fails — is the stranded claim really visible and really not re-picked; two sweeps racing one Ready column); pane reseat and sensitivity-floor interactions (the floor firing on a seat that is mid-reseat); crew.json rehydration after each partial write the h1 hunt documents (coordinate via their task dir if their findings land first, else attack independently).
## The ask
Adversarial defect hunt on the state machines: find unreachable states, absorbing states, and time-of-check races. Attack shapes: drive the stage ladder into every escalation path and check each is actually reachable and each records what it claims (the audit proved intake's protected-path refusal is unreachable — hunt for siblings: refusals whose guard condition can never be true, escalations that clobber an earlier reason); force converge/settle orderings that the code does not expect (a review verdict arriving after suite start, a lead accept racing a bounce); budget and wait windows (a seat finishing exactly at the deadline, a budget window of 0, a clock that jumps backwards mid-window); the intake claim ladder (claim verified then boot fails — is the stranded claim really visible and really not re-picked; two sweeps racing one Ready column); pane reseat and sensitivity-floor interactions (the floor firing on a seat that is mid-reseat); crew.json rehydration after each partial write the h1 hunt documents (coordinate via their task dir if their findings land first, else attack independently).
## Proposed tier
PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms
or overrides this at boot; the compiler never decides the tier.
proposed tier: judge
because:
- protected paths in force: 14 · ratified profile field protected_paths_candidates (3 entries) added to the authored floor · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
- scope breadth: 6 source files named by where (≥5 → judge)
- tripwire tests pinning that scope: 47
- protected path hit: crew/drive.mjs, crew/escalation-policy.mjs — tier judge unchanged (already highest)
proposed shape: judge
because (risk signals):
- risk signal · 2 protected path hits: crew/drive.mjs, crew/escalation-policy.mjs — shape judge
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
verified · file · crew/drive.mjs
verified · file · crew/converge.mjs
verified · file · crew/escalation-policy.mjs
verified · file · crew/daemon.mjs
verified · file · scripts/factory/intake.mjs
verified · file · crew/crew.mjs
## Done means
Every defect carries: (1) a REPRODUCTION — a self-contained program or command sequence, written into the task dir, that demonstrates the misbehaviour against a scratch copy of the repo (git archive HEAD into a temp dir, or a throwaway DEVTEAM_LEDGER_DIR / state dir), never against the checkout — the driver mechanically refuses a scout that changes a file; (2) observed versus expected, with the exact output pasted; (3) a severity call: corrupts-state / wrong-answer / hangs-or-leaks / refuses-wrongly / cosmetic; (4) the guard that SHOULD have caught it (a test, a refusal, a schema) and why it did not. A suspicion you could not reproduce goes in a separate SUSPICIONS section with what you tried — it is not a finding. Negative results are first-class: list every attack you ran that the code survived, so the next hunt does not re-run it. Findings ranked by severity. State which files you read in full.
## Tripwires
candidates: commands/commands.test.mjs, crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/capabilities.test.mjs, crew/converge.mjs, crew/converge.test.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/daemon.mjs, crew/daemon.test.mjs, crew/drive.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/host-load.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, scripts/factory/intake.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
tripwire tests:
- commands/commands.test.mjs · KNOWN_FLAGS, validation-lane
- crew/adapter-pi.test.mjs · 127.0.0.1, ROLE_ORDER, SEAT_DEFAULTS
- crew/arms.test.mjs · crew.json, rev-parse, write-failed
- crew/breaker.test.mjs · 24.0.0, boot-refusal, breaker-open
- crew/capabilities.test.mjs · CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, assertGrantsBacked, capability-shortfall, effectiveCapabilities, endpoint-dead, err.reason, grant-contradicts-deny, grant-unsupported, grantsFor, loadCapabilities, local-endpoint-dead, local-settings-missing, validateCapabilities
- crew/converge.test.mjs · ./converge.mjs, GATE_OUTPUT_TAIL, GATE_RESIDUAL_ID, SEVERITY_RANK, converge.mjs, crew/converge.mjs, crew/drive.mjs, draftPrBody, draftPrTitle, followUpIssueBody, followUpIssueTitle, gate-red, gateSummaryLine, residualList, should-fix
- crew/crew.test.mjs · 127.0.0.1, ADVISOR_BOOT_REFUSALS, ADVISOR_CONFIG_VERSION, BAND_FLOOR_REFUSALS, BOOT_DESCENDANT_REFUSALS, BOOT_ONLY_FLAGS, CAPABILITY_REFUSALS, DEFAULT_ROLES, DEFAULT_VARIANT, EMPTY_GRANTS, FANOUT_TOOLS, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, KNOWN_FLAGS, LADDER_PATH, LIMITS, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, MEMORY_ROLES, PROTECTED_PATHS, REQUIRED_FLAGS, ROLE_FLAG_PREFIXES, ROLE_ORDER, RUN_EXIT_CODES, RUN_EXIT_UNEXPECTED, SAFE_MODEL, SEAT_DEFAULTS, SHADOW_ABSENT, SHADOW_EXCLUSIONS, SHADOW_OUTCOMES, UsageError, VALIDATION_LANE_REFUSAL, VARIANTS, VARIANT_NAMES, WAIT_POLL_MS, adapter-unsupported, advisorManifest, assertAdvisorManifest, assertBandFloors, assertCapabilities, assertCtxSources, assertDefBandFloors, assertFanoutCoherent, assertGrantsBacked, assertSeats, assertUsage, awaitSeatsReady, band-below-floor, band-unknown, bandForMember, bandForRaw, boot-descendant-sweep, boot-refusal, bootAllocation, bootCmd, breaker-open, brief-file, build-rounds, builder.md, capability-shortfall, child.mjs, classifyAdvisorCell, composeLayout, crew.json, crew/daemon.mjs, daemon.mjs, deniedFanout, descendantRefusal, descendants-alive, descendants-evidence-mismatch, descendants-sweep-failed, descendants-unknown, descendants-unreclaimed, docOpenArgs, driveTask, effectiveTools, emitAdapter, endpoint-dead, envelope-accept, err.reason, escalationAttention, floor-unratified, gate-repair, grant-contradicts-deny, grant-unsupported, grantedDefModels, grantsFor, headless-rpc, intake.mjs, invalid-budget, invalid-validation-lane, journal.jsonl, ladder-unreadable, lane-fence, lead.md, loadCapabilities, loadLadder, local-endpoint-dead, local-settings-missing, memory-backend, memory-budget-bytes, memory-dir, memoryConfig, missing-checkout, model-ladder.json, no-candidate, not-consulted, paneSeat, parkOnOutcome, parkSeats, phaseForStage, plan-rounds, planner.md, probeLocalEndpoint, protected-paths, refuseBandFloor, refuseStaleDescendants, resolveAdapters, resolveFilesInScope, resolveLaneFence, resolveSeatModels, resolveTier, resolveValidationLane, resolveVariant, resolveWorkerBin, review-exhausted, review-rounds, review:pass, roster.json, runCmd, runExitCode, scope-gate, scripts/factory/intake.mjs, seatBand, seatLiveness, seatModelKey, seatReadySignal, seatTransport, shadowCandidates, shadowExclusion, shadowPick, shadowPickBoot, should-fix, stale-descendants, task.json, teardownCmd, teardownCore, transportFor, validateScopeEntries, validation-lane, vendor-collision, waitForEnvelope, your-role
- crew/daemon.test.mjs · ./escalation-policy.mjs, ./headless-rpc.mjs, ./slug.mjs, ./variants.mjs, 24.0.0, DAEMON_COMMANDS, DEFAULT_BUDGET_WINDOW_MS, DEFAULT_CONCURRENCY, DEFAULT_TRANSPORT, EVENT_KINDS, LEDGER_NODE_FLOOR, PANE_TRANSPORT, PROTECTED_PATHS, RUN_STATES, VARIANTS, VARIANT_NAMES, brief-file, child.mjs, crew.json, crew/daemon.mjs, crew/escalation-policy.mjs, daemon.mjs, deriveState, driveTask, emitAdapter, escalation-policy.mjs, headless-rpc, headless-rpc.mjs, intake.mjs, invalid-spec, journal.jsonl, lane-fence, node:module, node:net, normalizeEvent, not-capable, protected-paths, review.md, scope-gate, scopeEntryDefects, scripts/factory/intake.mjs, slug.mjs, task.json, terminal-result, tool-call, usageWindow, validateScopeEntries, variants.mjs
- crew/drive.test.mjs · ./escalation-policy.mjs, ./protected-paths.mjs, ./variants.mjs, CARVE_VERDICTS, CHECK_FAIL_PREFIX, DECISIONS, DEFAULT_VARIANT, DIRECTED_SEATS, DIRECTED_SOURCES, DIRECTED_STAGES, DIRECTED_STAGE_HEAD, ENVELOPE_FIELD_KINDS, ENVELOPE_REFUSAL_REASONS, EXECUTIONS, FAILURE_UPGRADE, FINDING_SEVERITIES, GATE_CUSTODIAN, GATE_REAP_CMD_EOF, GATE_REAP_SWEEP_MARKER, GATE_SUMMARY_PREFIX, GROWTH_DIVERGENCE_FACTOR, JUDGE_TIER, LIMITS, MAX_QUESTIONS, MODIFIER_OUTCOMES, MUTATIONS_MAX, MUTATION_OUTCOMES, PANEL_ADJUDICATORS, PANEL_PARTNERS, PARTIAL_REVIEWED, PERSPECTIVE_TARGETS, PROTECTED_PATHS, REFUTATION_EVIDENCE_MAX, RESIDUAL_TYPES, REVIEWED_CORE_STAGES, SECOND_OPINION, SENSITIVITY_FLOOR, SHAPE_SOURCES, TRIAGE_SOURCES, TRIAGE_STAGES, TRIAGE_STAGE_HEAD, UNIVERSAL_STAGE_HEADS, VARIANTS, VARIANT_NAMES, WAITS_S, WAIT_FLAGS, WAIT_REFUSALS, WAIT_ROLES, WAIT_SECONDS_MAX, WAIT_SECONDS_MIN, WRITE_SURFACES, acceptContractLines, acceptedViaLabel, agent-change, already-dead, answerBounceLines, applyPrescriptionLines, assertSeats, baselineGateDefect, brief-file, builder.md, cache:v2, checkFailureLine, child.mjs, composeCommitMessage, correctness-unverified, crew.json, crew/daemon.mjs, crew/drive.mjs, crew/escalation-policy.mjs, daemon.mjs, driveTask, envelope-accept, envelopeDefect, envelopeFieldsPresent, err.reason, escalation-policy.mjs, field-item, field-kind, field-missing, gate-red, gate-repair, gate-triage, gateReapCommand, gateReapFresh, gateReapOriginal, gateReapSweepCommand, gateReapVerdict, grant-spent, growthLines, growthRecord, headless-rpc, intake.mjs, journal.jsonl, laneFenceHits, lead.md, matchAnswers, model-ladder.json, no-envelope, no-tier, outOfScopeFiles, panel-a, panel-b, panel-divergence, panelSeats, parseDirectedBrief, parseGateSummary, parseQuestions, planner.md, protected-paths, protected-paths.mjs, protectedHits, questionConsultLines, refuseWait, refuted-must-fix, regrantVerdict, resolveProtectedPaths, resolveWaits, review.md, review:pass, reviewFindings, reviewOutcome, reviewer.md, roster.json, runCmd, scope-gate, scopeMatcher, scripts/factory/intake.mjs, second-opinion, sensitivity-floor, shapeDefect, should-fix, sourcesDefect, stageEnabled, task.json, undeclaredStage, validateAcceptDecision, validateCarve, validateMutations, validateScopeEntries, variants.mjs, wait-builder, wait-lead, wait-planner, wait-reviewer, wait-tech-lead, waitsCtx, waitsRecord, where-review
- crew/driver.test.mjs · lead.md, planner.md, tech-lead.md
- crew/escalation-policy.test.mjs · ./escalation-policy.mjs, REGRANT_CONDITIONS, adjudicatePanel, child.mjs, continuationBrief, crew/daemon.mjs, crew/drive.mjs, daemon.mjs, driveTask, escalation-policy.mjs, fuseFindings, gate-proven, grant-spent, must-fix-converging, parseLocation, regrant-budget, regrantVerdict, should-fix, usageWindow, where-review
- crew/factoryctl.test.mjs · crew.json, daemon.mjs, invalid-spec, journal.jsonl, task.json, terminal-result
- crew/harvest.test.mjs · crew.json, rev-parse
- crew/headless-rpc.test.mjs · ./headless-rpc.mjs, headless-rpc, headless-rpc.mjs, no-envelope
- crew/headless.test.mjs · no-envelope
- crew/host-load.test.mjs · LOAD_ENV, assertHostQuiet, hostLoad, loadPolicy
- crew/io-contract.test.mjs · ./headless-rpc.mjs, WAIT_POLL_MS, agent-change, crew.json, emitAdapter, headless-rpc, headless-rpc.mjs, no-envelope, no-tier, resolveSeatModels, resolveWorkerBin, rev-parse, roster.json, sensitivity-floor
- crew/pi/extensions/advisor.test.mjs · 127.0.0.1, classifyAdvisorCell, endpoint-credentials, endpoint-not-local, endpoint-unset, role-unsupported
- crew/pi/extensions/lab.test.mjs · 127.0.0.1, grantsFor, journal.jsonl, loadCapabilities, node:net, rev-parse
- crew/pi/extensions/subagent.test.mjs · ./headless-rpc.mjs, assertGrantsBacked, effectiveCapabilities, grantsFor, headless-rpc, headless-rpc.mjs, journal.jsonl, loadCapabilities
- crew/reclaim-descendants.test.mjs · already-dead, bootCmd, brief-file, child.mjs, headless-rpc, runCmd, teardownCore
- crew/reclaim.test.mjs · headless-rpc, node:crypto, should-fix
- crew/roster-refresh.test.mjs · roster.json
- crew/seat-io-runclean.test.mjs · LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, WAIT_POLL_MS, builder.md, emitAdapter, headless-rpc, no-envelope, rev-parse, teardownCore, waitForEnvelope
- skills/crew-dispatch/cli-contract.test.mjs · BOOT_ONLY_FLAGS, KNOWN_FLAGS, ROLE_FLAG_PREFIXES, VARIANTS, VARIANT_NAMES, validation-lane, variants.mjs
- skills/devops/exhibits.test.mjs · DAEMON_COMMANDS, crew/daemon.mjs, daemon.mjs
- test/factory-ci-repair.test.mjs · UsageError, brief-file, crew.json, node:module, task.json
- test/factory-ci-watch.test.mjs · node:module
- test/factory-crew-watch.test.mjs · UsageError, crew.json, journal.jsonl, node:crypto, task.json
- test/factory-emit.test.mjs · 24.0.0, boot-refusal, node:module
- test/factory-env.test.mjs · bootCmd, child.mjs, crew/daemon.mjs, daemon.mjs, runCmd, teardownCmd
- test/factory-intake.test.mjs · ACTOR_CLAIM_MAX_CHARS, DEFAULT_INTAKE_CONFIG, MAX_SWEEP_TICKS, MIN_SWEEP_INTERVAL_MS, PREMISE_REFERENCE_CAP, REQUIRED_INTAKE_CONFIG_KEYS, SWEEP_USAGE, UsageError, board-fetch-failed, board-write-failed, board-write-unverified, bodyDigest, compileIntakeBrief, crew.json, daemon.mjs, dead-anchor, dispatchPicked, extractIntakeBlock, extractPremiseReferences, fetchBoard, intake.mjs, intakeConfigUsable, intakeLoop, intakeRun, intakeSweep, missing-checkout, missing-path, missing-verb, no-grep-hits, no-references, normalDeps, normaliseBoardPage, observeDispatches, orderCandidates, parseBoardArgument, rate-limit-floor, record-only, renderStartHeader, renderSweepReport, repeat-escalation, repeatEscalationDetail, scripts/factory/intake.mjs, sweepCommand, task.json, unknown-verb, verifyPremise, window-cap, write-failed
- test/factory-lane-watch.test.mjs · crew.json, hostLoad, journal.jsonl, task.json
- test/factory-ledger-floor.test.mjs · UsageError, err.reason
- test/factory-ledger.test.mjs · FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, UsageError, VARIANTS, VARIANT_NAMES, boot-refusal, brief-file, child.mjs, crew.json, crew/drive.mjs, emitAdapter, envelope-accept, headless-rpc, journal.jsonl, node:module, review-exhausted, roster.json, sensitivity-floor, task.json
- test/factory-make-brief.test.mjs · CHECK_FAIL_PREFIX, MUTATIONS_MAX, PROTECTED_PATHS, UsageError, checkFailureLine, child.mjs, crew/drive.mjs, driveTask, model-ladder.json, node:crypto, planner.md, protected-paths, protected-paths.mjs, protectedHits, validateScopeEntries
- test/factory-probe-repo.test.mjs · crew/drive.mjs, err.reason, field-kind, missing-checkout, protected-paths
- test/factory-reap-stale.test.mjs · UsageError
- test/factory-transcript.test.mjs · FANOUT_TOOLS, SEAT_DEFAULTS, deniedFanout
- test/fixtures.mjs · slug.mjs
- test/fixtures.test.mjs · slug.mjs
- test/visualizer-panels.test.mjs · ROLE_ORDER, boot-refusal, rate-limit-floor, review-exhausted, roster.json, window-cap
- test/visualizer-returns.test.mjs · node:crypto, task.json
- test/visualizer-roster-edit.test.mjs · DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, ROLE_ORDER, assertCapabilities, model-ladder.json, resolveTier, roster.json
- test/visualizer-server.test.mjs · 127.0.0.1, DEFAULT_INTAKE_CONFIG, UsageError, board-write-failed, boot-refusal, intake.mjs, intakeLoop, intakeRun, intakeSweep, no-envelope, node:crypto, node:module, node:net, review-exhausted, roster.json, scripts/factory/intake.mjs, task.json, write-failed
- test/visualizer-shape.test.mjs · 127.0.0.1, ROLE_ORDER, boot-refusal, emitAdapter, no-envelope, node:module, rate-limit-floor, repeat-escalation, review-exhausted, reviewOutcome, window-cap
- test/visualizer-teardown.test.mjs · 127.0.0.1, node:module
broad keys (not used as tripwires):
- changes-needed · 36 hits
- crew.mjs · 57 hits
- crew/crew.mjs · 43 hits
- daemon · 48 hits
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
declare every hit: grep -rn "./converge.mjs\|./escalation-policy.mjs\|./headless-rpc.mjs\|./protected-paths.mjs\|./slug.mjs\|./variants.mjs\|127.0.0.1\|24.0.0\|ACTOR_CLAIM_MAX_CHARS\|ADVISOR_BOOT_REFUSALS\|ADVISOR_CONFIG_VERSION\|BAND_FLOOR_REFUSALS\|BOOT_DESCENDANT_REFUSALS\|BOOT_ONLY_FLAGS\|CAPABILITY_DELIVERY\|CAPABILITY_REFUSALS\|CARVE_VERDICTS\|CHECK_FAIL_PREFIX\|DAEMON_COMMANDS\|DECISIONS\|DEFAULT_BUDGET_WINDOW_MS\|DEFAULT_CONCURRENCY\|DEFAULT_INTAKE_CONFIG\|DEFAULT_ROLES\|DEFAULT_TRANSPORT\|DEFAULT_VARIANT\|DIRECTED_BLOCK\|DIRECTED_KEYS\|DIRECTED_SEATS\|DIRECTED_SOURCES\|DIRECTED_STAGES\|DIRECTED_STAGE_HEAD\|EMPTY_GRANTS\|ENVELOPE_FIELD_KINDS\|ENVELOPE_REFUSAL_REASONS\|EVENT_KINDS\|EXECUTIONS\|FAILURE_UPGRADE\|FANOUT_TOOLS\|FINDING_SEVERITIES\|GATE_CUSTODIAN\|GATE_OUTPUT_TAIL\|GATE_REAP_CMD_EOF\|GATE_REAP_LAUNCH_EOF\|GATE_REAP_OUTCOMES\|GATE_REAP_SHELL\|GATE_REAP_SWEEP_MARKER\|GATE_RESIDUAL_ID\|GATE_SUMMARY_PREFIX\|GROWTH_DIVERGENCE_FACTOR\|HEADLESS_RPC_TRANSPORT\|HEADLESS_TRANSPORT\|HEADLESS_TRANSPORTS\|INTAKE_BLOCK_KEYS\|IntakeUsageError\|JUDGE_TIER\|KNOWN_FLAGS\|LADDER_PATH\|LEDGER_NODE_FLOOR\|LIMITS\|LIVENESS_MISSES_TO_DIE\|LIVENESS_PROBE_MS\|LOAD_ENV\|MAX_QUESTIONS\|MAX_SWEEP_TICKS\|MEMORY_ROLES\|MIN_SWEEP_INTERVAL_MS\|MODIFIER_OUTCOMES\|MUTATIONS_MAX\|MUTATION_OUTCOMES\|PANEL_ADJUDICATORS\|PANEL_PARTNERS\|PANE_TRANSPORT\|PARTIAL_REVIEWED\|PERSPECTIVE_TARGETS\|PREMISE_IDENTIFIER_CAP\|PREMISE_REFERENCE_CAP\|PROTECTED_PATHS\|READY_CHROME\|REFUTATION_EVIDENCE_MAX\|REGRANT_CONDITIONS\|REQUIRED_FLAGS\|REQUIRED_INTAKE_CONFIG_KEYS\|RESIDUAL_TYPES\|REVIEWED_CORE_STAGES\|ROLE_FLAG_PREFIXES\|ROLE_ORDER\|RUN_EXIT_CODES\|RUN_EXIT_UNEXPECTED\|RUN_STATES\|SAFE_MODEL\|SCOPE_DIR_MIN_SEGMENTS\|SEAT_DEFAULTS\|SECOND_OPINION\|SENSITIVITY_FLOOR\|SETTLED_FEED_RETENTION\|SEVERITY_RANK\|SHADOW_ABSENT\|SHADOW_EXCLUSIONS\|SHADOW_OUTCOMES\|SHADOW_PICK_SCHEMA\|SHADOW_RATE_FLOOR\|SHAPE_SOURCES\|SWEEP_USAGE\|TRIAGE_SOURCES\|TRIAGE_STAGES\|TRIAGE_STAGE_HEAD\|UNIVERSAL_STAGE_HEADS\|UsageError\|VALIDATION_LANE_REFUSAL\|VARIANTS\|VARIANT_NAMES\|WAITS_S\|WAIT_FLAGS\|WAIT_POLL_MS\|WAIT_REFUSALS\|WAIT_ROLES\|WAIT_SECONDS_MAX\|WAIT_SECONDS_MIN\|WRITE_SURFACES\|acceptContractLines\|acceptedViaLabel\|adapter-unsupported\|adjudicatePanel\|advisor-manifest\|advisor-manifest-unavailable\|advisor-manifest.json\|advisor-preflight\|advisor-refusal\|advisorBootRecord\|advisorManifest\|agent-change\|agent-unresolved\|already-dead\|answerBounceLines\|applyPrescriptionLines\|assertAdvisorCellLive\|assertAdvisorManifest\|assertBandFloors\|assertCapabilities\|assertCtxSources\|assertDefBandFloors\|assertFanoutCoherent\|assertGrantsBacked\|assertHostQuiet\|assertSeats\|assertUsage\|awaitSeatsReady\|band-below-floor\|band-unknown\|bandForMember\|bandForRaw\|baselineGateDefect\|board-fetch-failed\|board-write-failed\|board-write-unverified\|bodyDigest\|boot-descendant-sweep\|boot-refusal\|bootAllocation\|bootCmd\|breaker-open\|brief-file\|build-exhausted\|build-fix\|build-rounds\|builder.md\|cache:v2\|capability-shortfall\|changes-needed\|checkFailureLine\|child.mjs\|classifyAdvisorCell\|compileIntakeBrief\|composeCommitMessage\|composeLayout\|continuationBrief\|converge.mjs\|correctness-unverified\|crew.json\|crew.mjs\|crew/converge.mjs\|crew/crew.mjs\|crew/daemon.mjs\|crew/drive.mjs\|crew/escalation-policy.mjs\|daemon\|daemon.mjs\|dead-anchor\|deniedFanout\|deriveState\|descendant-reclaim-failed\|descendantRefusal\|descendants-alive\|descendants-evidence-mismatch\|descendants-sweep-failed\|descendants-unknown\|descendants-unreclaimed\|dispatchPicked\|docOpenArgs\|draftPrBody\|draftPrTitle\|drive.mjs\|driveTask\|effectiveCapabilities\|effectiveTools\|emitAdapter\|endpoint-credentials\|endpoint-dead\|endpoint-not-local\|endpoint-unset\|envelope-accept\|envelopeDefect\|envelopeFieldsPresent\|err.reason\|escalation-policy.mjs\|escalationAttention\|extractIntakeBlock\|extractPremiseReferences\|fallback-from-plan-summary\|fetchBoard\|field-item\|field-kind\|field-missing\|floor-unratified\|followUpIssueBody\|followUpIssueTitle\|fuseFindings\|gate-proven\|gate-red\|gate-repair\|gate-repair-bounce.md\|gate-triage\|gateReapCommand\|gateReapFresh\|gateReapOriginal\|gateReapSweepCommand\|gateReapVerdict\|gateSummaryLine\|grant-contradicts-deny\|grant-spent\|grant-unsupported\|grantedDefModels\|grantsFor\|grep-failed\|growthLines\|growthRecord\|headless-rpc\|headless-rpc.mjs\|hostLoad\|intake.mjs\|intakeConfigUsable\|intakeLoop\|intakeRun\|intakeSweep\|invalid-budget\|invalid-spec\|invalid-validation-lane\|isObject\|journal.jsonl\|ladder-unreadable\|lane-fence\|lane-fix\|laneFenceHits\|lead.md\|loadCapabilities\|loadLadder\|loadPolicy\|local-endpoint-dead\|local-settings-missing\|main\|matchAnswers\|memory-backend\|memory-budget-bytes\|memory-dir\|memoryConfig\|memoryExtracts\|missing-checkout\|missing-path\|missing-verb\|model-ladder.json\|model-unsafe\|model-unset\|must-fix\|must-fix-converging\|new-workspace\|no-candidate\|no-envelope\|no-grep-hits\|no-references\|no-tier\|node:crypto\|node:fs\|node:module\|node:net\|node:os\|node:path\|node:url\|normalDeps\|normaliseBoardPage\|normalizeEvent\|not-capable\|not-consulted\|observeDispatches\|orderCandidates\|outOfScopeFiles\|page-limit\|paneSeat\|panel-a\|panel-adjudication\|panel-b\|panel-divergence\|panelSeats\|park-mint-failed\|parkOnOutcome\|parkSeats\|parseBoardArgument\|parseDirectedBrief\|parseGateSummary\|parseLocation\|parseQuestions\|phaseForStage\|plan-rounds\|planner.md\|pristine.ok\|probe-failed\|probeLocalEndpoint\|protected-paths\|protected-paths.mjs\|protectedHits\|questionConsultLines\|rate-limit-floor\|record-only\|refuse\|refuseBandFloor\|refuseStaleDescendants\|refuseWait\|refuted-must-fix\|regrant-budget\|regrantVerdict\|remove-failed\|renderStartHeader\|renderSweepReport\|repeat-escalation\|repeatEscalationDetail\|residualList\|resolveAdapters\|resolveFilesInScope\|resolveLaneFence\|resolveProtectedPaths\|resolveSeatModels\|resolveTier\|resolveValidationLane\|resolveVariant\|resolveWaits\|resolveWorkerBin\|rev-parse\|review-exhausted\|review-fix\|review-rounds\|review.md\|review:pass\|reviewFindings\|reviewOutcome\|reviewer.md\|role-unsupported\|roster.json\|runCmd\|runExitCode\|scope-fix\|scope-gate\|scopeEntryDefects\|scopeMatcher\|scripts/factory/intake.mjs\|seat-root-settle-failed\|seatBand\|seatLiveness\|seatModelKey\|seatReadySignal\|seatShortfalls\|seatTransport\|second-opinion\|sensitivity-floor\|shadowCandidates\|shadowExclusion\|shadowPick\|shadowPickBoot\|shapeDefect\|should-fix\|slug\|slug.mjs\|sourcesDefect\|stageEnabled\|stale-descendants\|sweepCommand\|task.json\|teardownCmd\|teardownCore\|tech-lead\|tech-lead.md\|terminal-result\|timeout-s\|tool-call\|transport-unsupported\|transportFor\|tripwire-tests-absent\|undeclaredStage\|unknown-task\|unknown-time\|unknown-verb\|usageWindow\|validateAcceptDecision\|validateCapabilities\|validateCarve\|validateMutations\|validateScopeEntries\|validation-lane\|variants.mjs\|vendor-collision\|verifyPremise\|wait-builder\|wait-lead\|wait-planner\|wait-reviewer\|wait-tech-lead\|waitForEnvelope\|waitsCtx\|waitsRecord\|where-review\|window-cap\|write-failed\|your-role" crew/ test/ scripts/ docs/
## Coupled sources
coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.
- crew/adapters/adapter-claude.mjs · SEAT_DEFAULTS · no fence in play
- crew/adapters/adapter-pi.mjs · FANOUT_TOOLS, assertAdvisorCellLive, assertFanoutCoherent · no fence in play
- crew/capabilities.mjs · CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, assertGrantsBacked, crew/daemon.mjs, daemon.mjs, effectiveCapabilities, grantsFor, loadCapabilities, validateCapabilities · no fence in play
- crew/child.mjs · LIMITS, VALIDATION_LANE_REFUSAL, VARIANTS, assertSeats, crew/daemon.mjs, daemon.mjs, driveTask, isObject, paneSeat, resolveLaneFence, resolveValidationLane, validateScopeEntries · no fence in play
- crew/factoryctl.mjs · crew/daemon.mjs, daemon.mjs · no fence in play
- crew/limits.mjs · LIMITS, crew/drive.mjs, memoryConfig · no fence in play
- crew/protected-paths.mjs · PROTECTED_PATHS, crew/drive.mjs, crew/escalation-policy.mjs, escalation-policy.mjs, protectedHits, resolveProtectedPaths · no fence in play
- crew/seat-io.mjs · DEFAULT_TRANSPORT, HEADLESS_RPC_TRANSPORT, HEADLESS_TRANSPORT, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, MODIFIER_OUTCOMES, WAIT_POLL_MS, crew/drive.mjs, docOpenArgs, emitAdapter, hostLoad, loadPolicy, phaseForStage, resolveWorkerBin, runCmd, teardownCore, transportFor, waitForEnvelope · no fence in play
- crew/slug.mjs · daemon.mjs · no fence in play
- crew/variants.mjs · DEFAULT_VARIANT, VARIANTS, VARIANT_NAMES, daemon.mjs, undeclaredStage · no fence in play
- scripts/factory/ci-repair.mjs · UsageError · no fence in play
- scripts/factory/crew-watch.mjs · UsageError · no fence in play
- scripts/factory/emit.mjs · UsageError, bootCmd, crew/drive.mjs, parseDirectedBrief, resolveAdapters · no fence in play
- scripts/factory/lane-watch.mjs · LIMITS, hostLoad · no fence in play
- scripts/factory/ledger.mjs · DECISIONS, MODIFIER_OUTCOMES, UsageError, VARIANTS, VARIANT_NAMES, assertCapabilities, bootCmd, crew/daemon.mjs, crew/drive.mjs, daemon.mjs, resolveTier, reviewOutcome · no fence in play
- scripts/factory/make-brief.mjs · CHECK_FAIL_PREFIX, DIRECTED_KEYS, GATE_SUMMARY_PREFIX, MUTATIONS_MAX, PROTECTED_PATHS, checkFailureLine, crew/drive.mjs, protectedHits, resolveProtectedPaths, scopeMatcher, validateMutations, validateScopeEntries · no fence in play
- scripts/factory/transcript.mjs · crew/drive.mjs · no fence in play
- visualizer/server/ledger-feed.mjs · crew/daemon.mjs, daemon.mjs · no fence in play
- visualizer/server/roster-edit.mjs · DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_TRANSPORTS, SEAT_DEFAULTS, assertCapabilities, resolveTier · no fence in play
- visualizer/server/shape.mjs · ROLE_ORDER, crew/daemon.mjs, daemon.mjs · no fence in play
## Baseline
lane: npm test · pass 2171 · fail 0 · status: green
lane basis: ratified profile field test_command · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed
## Out of scope
No edits to the checkout. No speculation presented as findings. No re-litigating the 2026-08-23 audit registers (consistency/duplication/prose) — this hunt is behaviour only. Do not fix anything.
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
files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): crew/converge.mjs, crew/crew.mjs, crew/daemon.mjs, crew/drive.mjs, crew/escalation-policy.mjs, scripts/factory/intake.mjs
read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): commands/commands.test.mjs, crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/capabilities.test.mjs, crew/converge.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/host-load.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
conventions of record (basis: ratified profile field conventions · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json): .claude/, README.md, docs/adr/, docs/conventions.md
grep -rn "./converge.mjs\|./escalation-policy.mjs\|./headless-rpc.mjs\|./protected-paths.mjs\|./slug.mjs\|./variants.mjs\|127.0.0.1\|24.0.0\|ACTOR_CLAIM_MAX_CHARS\|ADVISOR_BOOT_REFUSALS\|ADVISOR_CONFIG_VERSION\|BAND_FLOOR_REFUSALS\|BOOT_DESCENDANT_REFUSALS\|BOOT_ONLY_FLAGS\|CAPABILITY_DELIVERY\|CAPABILITY_REFUSALS\|CARVE_VERDICTS\|CHECK_FAIL_PREFIX\|DAEMON_COMMANDS\|DECISIONS\|DEFAULT_BUDGET_WINDOW_MS\|DEFAULT_CONCURRENCY\|DEFAULT_INTAKE_CONFIG\|DEFAULT_ROLES\|DEFAULT_TRANSPORT\|DEFAULT_VARIANT\|DIRECTED_BLOCK\|DIRECTED_KEYS\|DIRECTED_SEATS\|DIRECTED_SOURCES\|DIRECTED_STAGES\|DIRECTED_STAGE_HEAD\|EMPTY_GRANTS\|ENVELOPE_FIELD_KINDS\|ENVELOPE_REFUSAL_REASONS\|EVENT_KINDS\|EXECUTIONS\|FAILURE_UPGRADE\|FANOUT_TOOLS\|FINDING_SEVERITIES\|GATE_CUSTODIAN\|GATE_OUTPUT_TAIL\|GATE_REAP_CMD_EOF\|GATE_REAP_LAUNCH_EOF\|GATE_REAP_OUTCOMES\|GATE_REAP_SHELL\|GATE_REAP_SWEEP_MARKER\|GATE_RESIDUAL_ID\|GATE_SUMMARY_PREFIX\|GROWTH_DIVERGENCE_FACTOR\|HEADLESS_RPC_TRANSPORT\|HEADLESS_TRANSPORT\|HEADLESS_TRANSPORTS\|INTAKE_BLOCK_KEYS\|IntakeUsageError\|JUDGE_TIER\|KNOWN_FLAGS\|LADDER_PATH\|LEDGER_NODE_FLOOR\|LIMITS\|LIVENESS_MISSES_TO_DIE\|LIVENESS_PROBE_MS\|LOAD_ENV\|MAX_QUESTIONS\|MAX_SWEEP_TICKS\|MEMORY_ROLES\|MIN_SWEEP_INTERVAL_MS\|MODIFIER_OUTCOMES\|MUTATIONS_MAX\|MUTATION_OUTCOMES\|PANEL_ADJUDICATORS\|PANEL_PARTNERS\|PANE_TRANSPORT\|PARTIAL_REVIEWED\|PERSPECTIVE_TARGETS\|PREMISE_IDENTIFIER_CAP\|PREMISE_REFERENCE_CAP\|PROTECTED_PATHS\|READY_CHROME\|REFUTATION_EVIDENCE_MAX\|REGRANT_CONDITIONS\|REQUIRED_FLAGS\|REQUIRED_INTAKE_CONFIG_KEYS\|RESIDUAL_TYPES\|REVIEWED_CORE_STAGES\|ROLE_FLAG_PREFIXES\|ROLE_ORDER\|RUN_EXIT_CODES\|RUN_EXIT_UNEXPECTED\|RUN_STATES\|SAFE_MODEL\|SCOPE_DIR_MIN_SEGMENTS\|SEAT_DEFAULTS\|SECOND_OPINION\|SENSITIVITY_FLOOR\|SETTLED_FEED_RETENTION\|SEVERITY_RANK\|SHADOW_ABSENT\|SHADOW_EXCLUSIONS\|SHADOW_OUTCOMES\|SHADOW_PICK_SCHEMA\|SHADOW_RATE_FLOOR\|SHAPE_SOURCES\|SWEEP_USAGE\|TRIAGE_SOURCES\|TRIAGE_STAGES\|TRIAGE_STAGE_HEAD\|UNIVERSAL_STAGE_HEADS\|UsageError\|VALIDATION_LANE_REFUSAL\|VARIANTS\|VARIANT_NAMES\|WAITS_S\|WAIT_FLAGS\|WAIT_POLL_MS\|WAIT_REFUSALS\|WAIT_ROLES\|WAIT_SECONDS_MAX\|WAIT_SECONDS_MIN\|WRITE_SURFACES\|acceptContractLines\|acceptedViaLabel\|adapter-unsupported\|adjudicatePanel\|advisor-manifest\|advisor-manifest-unavailable\|advisor-manifest.json\|advisor-preflight\|advisor-refusal\|advisorBootRecord\|advisorManifest\|agent-change\|agent-unresolved\|already-dead\|answerBounceLines\|applyPrescriptionLines\|assertAdvisorCellLive\|assertAdvisorManifest\|assertBandFloors\|assertCapabilities\|assertCtxSources\|assertDefBandFloors\|assertFanoutCoherent\|assertGrantsBacked\|assertHostQuiet\|assertSeats\|assertUsage\|awaitSeatsReady\|band-below-floor\|band-unknown\|bandForMember\|bandForRaw\|baselineGateDefect\|board-fetch-failed\|board-write-failed\|board-write-unverified\|bodyDigest\|boot-descendant-sweep\|boot-refusal\|bootAllocation\|bootCmd\|breaker-open\|brief-file\|build-exhausted\|build-fix\|build-rounds\|builder.md\|cache:v2\|capability-shortfall\|changes-needed\|checkFailureLine\|child.mjs\|classifyAdvisorCell\|compileIntakeBrief\|composeCommitMessage\|composeLayout\|continuationBrief\|converge.mjs\|correctness-unverified\|crew.json\|crew.mjs\|crew/converge.mjs\|crew/crew.mjs\|crew/daemon.mjs\|crew/drive.mjs\|crew/escalation-policy.mjs\|daemon\|daemon.mjs\|dead-anchor\|deniedFanout\|deriveState\|descendant-reclaim-failed\|descendantRefusal\|descendants-alive\|descendants-evidence-mismatch\|descendants-sweep-failed\|descendants-unknown\|descendants-unreclaimed\|dispatchPicked\|docOpenArgs\|draftPrBody\|draftPrTitle\|drive.mjs\|driveTask\|effectiveCapabilities\|effectiveTools\|emitAdapter\|endpoint-credentials\|endpoint-dead\|endpoint-not-local\|endpoint-unset\|envelope-accept\|envelopeDefect\|envelopeFieldsPresent\|err.reason\|escalation-policy.mjs\|escalationAttention\|extractIntakeBlock\|extractPremiseReferences\|fallback-from-plan-summary\|fetchBoard\|field-item\|field-kind\|field-missing\|floor-unratified\|followUpIssueBody\|followUpIssueTitle\|fuseFindings\|gate-proven\|gate-red\|gate-repair\|gate-repair-bounce.md\|gate-triage\|gateReapCommand\|gateReapFresh\|gateReapOriginal\|gateReapSweepCommand\|gateReapVerdict\|gateSummaryLine\|grant-contradicts-deny\|grant-spent\|grant-unsupported\|grantedDefModels\|grantsFor\|grep-failed\|growthLines\|growthRecord\|headless-rpc\|headless-rpc.mjs\|hostLoad\|intake.mjs\|intakeConfigUsable\|intakeLoop\|intakeRun\|intakeSweep\|invalid-budget\|invalid-spec\|invalid-validation-lane\|isObject\|journal.jsonl\|ladder-unreadable\|lane-fence\|lane-fix\|laneFenceHits\|lead.md\|loadCapabilities\|loadLadder\|loadPolicy\|local-endpoint-dead\|local-settings-missing\|main\|matchAnswers\|memory-backend\|memory-budget-bytes\|memory-dir\|memoryConfig\|memoryExtracts\|missing-checkout\|missing-path\|missing-verb\|model-ladder.json\|model-unsafe\|model-unset\|must-fix\|must-fix-converging\|new-workspace\|no-candidate\|no-envelope\|no-grep-hits\|no-references\|no-tier\|node:crypto\|node:fs\|node:module\|node:net\|node:os\|node:path\|node:url\|normalDeps\|normaliseBoardPage\|normalizeEvent\|not-capable\|not-consulted\|observeDispatches\|orderCandidates\|outOfScopeFiles\|page-limit\|paneSeat\|panel-a\|panel-adjudication\|panel-b\|panel-divergence\|panelSeats\|park-mint-failed\|parkOnOutcome\|parkSeats\|parseBoardArgument\|parseDirectedBrief\|parseGateSummary\|parseLocation\|parseQuestions\|phaseForStage\|plan-rounds\|planner.md\|pristine.ok\|probe-failed\|probeLocalEndpoint\|protected-paths\|protected-paths.mjs\|protectedHits\|questionConsultLines\|rate-limit-floor\|record-only\|refuse\|refuseBandFloor\|refuseStaleDescendants\|refuseWait\|refuted-must-fix\|regrant-budget\|regrantVerdict\|remove-failed\|renderStartHeader\|renderSweepReport\|repeat-escalation\|repeatEscalationDetail\|residualList\|resolveAdapters\|resolveFilesInScope\|resolveLaneFence\|resolveProtectedPaths\|resolveSeatModels\|resolveTier\|resolveValidationLane\|resolveVariant\|resolveWaits\|resolveWorkerBin\|rev-parse\|review-exhausted\|review-fix\|review-rounds\|review.md\|review:pass\|reviewFindings\|reviewOutcome\|reviewer.md\|role-unsupported\|roster.json\|runCmd\|runExitCode\|scope-fix\|scope-gate\|scopeEntryDefects\|scopeMatcher\|scripts/factory/intake.mjs\|seat-root-settle-failed\|seatBand\|seatLiveness\|seatModelKey\|seatReadySignal\|seatShortfalls\|seatTransport\|second-opinion\|sensitivity-floor\|shadowCandidates\|shadowExclusion\|shadowPick\|shadowPickBoot\|shapeDefect\|should-fix\|slug\|slug.mjs\|sourcesDefect\|stageEnabled\|stale-descendants\|sweepCommand\|task.json\|teardownCmd\|teardownCore\|tech-lead\|tech-lead.md\|terminal-result\|timeout-s\|tool-call\|transport-unsupported\|transportFor\|tripwire-tests-absent\|undeclaredStage\|unknown-task\|unknown-time\|unknown-verb\|usageWindow\|validateAcceptDecision\|validateCapabilities\|validateCarve\|validateMutations\|validateScopeEntries\|validation-lane\|variants.mjs\|vendor-collision\|verifyPremise\|wait-builder\|wait-lead\|wait-planner\|wait-reviewer\|wait-tech-lead\|waitForEnvelope\|waitsCtx\|waitsRecord\|where-review\|window-cap\|write-failed\|your-role" crew/ test/ scripts/ docs/
- The factory scripts carry a Node ≥24 floor; follow the existing
  `scripts/factory/*` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No `Co-Authored-By` trailers.
- If interrupted, write your ReturnEnvelope first on resume — `status:
  insufficient` if incomplete. A silent seat is indistinguishable from a dead
  one.
