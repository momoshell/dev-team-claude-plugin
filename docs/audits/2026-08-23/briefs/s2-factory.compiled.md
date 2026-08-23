# Task: Horizontal inspection of the factory scripts and the visualizer server: read them as one system and report where they are inconsistent with themselves, where they duplicate each other or the crew runtime, and what can be simplified without changing behaviour. scripts/factory/ledger.mjs is 4,322 lines and is the largest file in the repository — say what it contains by section with line ranges, which sections are independent enough to be their own module behind the same exports, and which queries re-implement each other. For emit.mjs, intake.mjs, make-brief.mjs, probe-repo.mjs, ci-watch.mjs, ci-repair.mjs and visualizer/server/*.mjs: duplicated helpers (path normalisation, JSON-line parsing, absence grammar, time formatting), refusal shapes that differ for the same situation, exported symbols with no importer outside their own test, enums declared twice, and any place the visualizer re-derives what the ledger already answers with a query. Every finding names file:line on both sides.
## The ask
Horizontal inspection of the factory scripts and the visualizer server: read them as one system and report where they are inconsistent with themselves, where they duplicate each other or the crew runtime, and what can be simplified without changing behaviour. scripts/factory/ledger.mjs is 4,322 lines and is the largest file in the repository — say what it contains by section with line ranges, which sections are independent enough to be their own module behind the same exports, and which queries re-implement each other. For emit.mjs, intake.mjs, make-brief.mjs, probe-repo.mjs, ci-watch.mjs, ci-repair.mjs and visualizer/server/*.mjs: duplicated helpers (path normalisation, JSON-line parsing, absence grammar, time formatting), refusal shapes that differ for the same situation, exported symbols with no importer outside their own test, enums declared twice, and any place the visualizer re-derives what the ledger already answers with a query. Every finding names file:line on both sides.
## Proposed tier
PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms
or overrides this at boot; the compiler never decides the tier.
proposed tier: judge
because:
- protected paths in force: 14 · ratified profile field protected_paths_candidates (3 entries) added to the authored floor · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
- scope breadth: 16 source files named by where (≥5 → judge)
- tripwire tests pinning that scope: 39
- protected-path hits: none
proposed shape: mechanical
because (risk signals):
- risk signal · protected-path hits: none — shape mechanical
proposed strength: frontier
because (complexity signals):
- complexity signal · scope breadth: 16 source file(s) named by where
- complexity signal · tripwire tests pinning that scope: 39
- complexity signal · directory where: visualizer/server/
- complexity judge → ratified ladder band frontier
```proposal
{
  "shape": "mechanical",
  "strength": "frontier"
}
```
## Where
verified · file · scripts/factory/ledger.mjs
verified · file · scripts/factory/emit.mjs
verified · file · scripts/factory/intake.mjs
verified · file · scripts/factory/make-brief.mjs
verified · file · scripts/factory/probe-repo.mjs
verified · file · scripts/factory/ci-watch.mjs
verified · file · scripts/factory/ci-repair.mjs
verified · directory · visualizer/server/
## Done means
A ranked findings register with the same shape as the runtime scout's: two-or-more locations per finding, category, one-sentence simplification, the pinning test or its absence, cost in files. Plus one section specific to ledger.mjs: a table of its sections (name, line range, what it owns, which exports leave it, which other sections it depends on) and a recommended split into no more than four modules that keeps every current export name reachable from scripts/factory/ledger.mjs so no importer changes — or the evidence that a split is not worth it. Every dead-export claim carries its grep. Ranked by behaviour risk then lines removed. The register says which files were read in full and which were sampled.
## Tripwires
candidates: crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/converge.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, scripts/factory/ci-repair.mjs, scripts/factory/ci-watch.mjs, scripts/factory/emit.mjs, scripts/factory/intake.mjs, scripts/factory/ledger.mjs, scripts/factory/make-brief.mjs, scripts/factory/probe-repo.mjs, skills/crew-dispatch/cli-contract.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit-floor.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-transcript.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs, visualizer/server/feed.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/returns-source.mjs, visualizer/server/roster-edit.mjs, visualizer/server/roster-ladder.mjs, visualizer/server/roster-source.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs, visualizer/server/triage.mjs
tripwire tests:
- crew/adapter-pi.test.mjs · 127.0.0.1, ROLE_ORDER
- crew/arms.test.mjs · STATUSES, crew-dir-missing, crew.json, ledger.db, openLedger, rev-parse
- crew/breaker.test.mjs · 24.0.0, NODE_FLOOR, boot-refusal, breaker.mjs, ledger.db, not-applicable, openLedger, seat-not-ready
- crew/converge.test.mjs · plan:r1
- crew/crew.test.mjs · 127.0.0.1, EVENT_TYPES, LADDER_PATH, NODE_FLOOR, PAYLOAD_KEYS, ROLE_ORDER, USAGE_ABSENT_CAUSES, _resetNoticeGuardsForTest, boot-refusal, checkoutProtectedPaths, crew.json, emit.mjs, failure-upgrade, intake.mjs, ledger.db, missing-checkout, model-ladder.json, openLedger, openRun, plan:r1, probe-repo.mjs, probeRepo, recordCellFailure, roster.json, run.json, scripts/factory/emit.mjs, scripts/factory/intake.mjs, scripts/factory/probe-repo.mjs, seat-died, task.json, validateScopeEntries
- crew/daemon.test.mjs · 24.0.0, NODE_FLOOR, crew.json, emit.mjs, intake.mjs, ledger.db, ledger.jsonl, node:module, node:sqlite, openLedger, openRun, plan:r1, probe-repo.mjs, repoKeyFor, run.json, scripts/factory/emit.mjs, scripts/factory/intake.mjs, scripts/factory/probe-repo.mjs, task.json, validateScopeEntries
- crew/drive.test.mjs · FIELD_KINDS, REFUSAL_REASONS, agent-change, crew.json, crew/roster.json, failure-upgrade, intake.mjs, ledger.db, model-ladder.json, no-envelope, no-tier, plan:r1, protected-paths.mjs, roster-ladder.mjs, roster.json, roster.schema.json, scripts/factory/intake.mjs, sensitivity-floor, task.json, unusable-envelope, validateScopeEntries
- crew/escalation-policy.test.mjs · node:sqlite
- crew/factoryctl.test.mjs · crew.json, task.json
- crew/harvest.test.mjs · STATUSES, branch-unresolved, checkout-missing, crew.json, rev-parse, symbolic-ref
- crew/headless-rpc.test.mjs · no-envelope
- crew/headless.test.mjs · no-envelope
- crew/io-contract.test.mjs · agent-change, crew.json, no-envelope, no-tier, rev-parse, roster.json, seat-died, sensitivity-floor, unusable-envelope
- crew/pi/extensions/advisor.test.mjs · 127.0.0.1
- crew/pi/extensions/lab.test.mjs · 127.0.0.1, rev-parse, symbolic-ref
- crew/reclaim-descendants.test.mjs · ledger.db, openLedger
- crew/reclaim.test.mjs · node:crypto
- crew/roster-refresh.test.mjs · crew/roster.json, roster.json, roster.schema.json
- crew/seat-io-runclean.test.mjs · no-envelope, recordCellFailure, rev-parse, seat-died, unusable-envelope
- skills/crew-dispatch/cli-contract.test.mjs · ../../crew/crew.mjs
- test/factory-ci-repair.test.mjs · ./ci-watch.mjs, ./emit.mjs, ./ledger.mjs, ./make-brief.mjs, BriefUsageError, NODE_FLOOR, UNKNOWN_REASONS, bound-reached, bound-unverifiable, brief-refused, check-log, ci-failures-unparseable, ci-repair.mjs, ci-watch.mjs, ciRepairRun, compileRepairBrief, crew-dir-missing, crew.json, dispatchAllowed, dispatchRepair, emit.mjs, inheritScope, ledger.db, local-failures-disjoint, local-lane-unrunnable, make-brief.mjs, node:module, node:sqlite, openLedger, platform-divergent, profile-missing, profile-unratified, scope-forbidden, scope-uninheritable, scripts/factory/ci-repair.mjs, scripts/factory/ci-watch.mjs, task.json, worker-path
- test/factory-ci-watch.test.mjs · ./emit.mjs, ./ledger.mjs, ./probe-repo.mjs, NODE_FLOOR, PROFILE_REFUSALS, check-log, check-log-tail-200, ci-failures-unparseable, ci-no-checks, ci-watch.mjs, ciShape, ciWatchRun, classifyRed, conclusion-not-adjudicable, decisionFor, emit.mjs, extractFailure, fetchCheckLog, fetchCheckRuns, isWorkerPath, ledger.db, local-failures-disjoint, local-lane-green, local-lane-reproduced, local-lane-unrunnable, node:module, node:sqlite, openLedger, platform-divergent, probe-repo.mjs, probeRepo, profile-field-unknown, profile-missing, profile-unratified, profile-unreadable, pushBranch, recordCiCycle, runLocalLane, scripts/factory/ci-watch.mjs, scripts/factory/emit.mjs, scripts/factory/probe-repo.mjs, worker-path
- test/factory-crew-watch.test.mjs · crew.json, node:crypto, plan:r1, task.json
- test/factory-emit-floor.test.mjs · emit.mjs, ledger.db, ledger.jsonl, node:sqlite, openLedger, openRun, scripts/factory/emit.mjs
- test/factory-emit.test.mjs · 24.0.0, NODE_FLOOR, PAYLOAD_KEYS, _resetNoticeGuardsForTest, boot-refusal, emit.mjs, ledger.db, ledger.jsonl, node:module, node:sqlite, openLedger, openRun, recordCellFailure, run.json, run.lock, scripts/factory/emit.mjs
- test/factory-env.test.mjs · NODE_FLOOR, defaultDbPath, emit.mjs, openLedger, openRun, parseCliArgs, run-set, scripts/factory/emit.mjs, server.mjs, startServer, visualizer/server/server.mjs
- test/factory-intake.test.mjs · ./ledger.mjs, ./make-brief.mjs, ACTOR_CLAIM_MAX_CHARS, DEFAULT_INTAKE_CONFIG, DISPATCH_OUTCOMES, INTAKE_DISPATCH_OUTCOMES, INTAKE_DISPATCH_VERDICTS, INTAKE_OUTCOMES, INTAKE_REFUSALS, LedgerUsageError, MAX_SWEEP_TICKS, MIN_SWEEP_INTERVAL_MS, PREMISE_REFERENCE_CAP, PREMISE_VERDICTS, REQUIRED_INTAKE_CONFIG_KEYS, SWEEP_USAGE, board-fetch-failed, board-write-failed, board-write-unverified, bodyDigest, brief-uncompilable, compileIntakeBrief, crew.json, dead-anchor, dispatchPicked, extractIntakeBlock, extractPremiseReferences, fetchBoard, intake-block-malformed, intake-block-missing, intake.mjs, intakeConfigUsable, intakeLoop, intakeRun, intakeSweep, ledger.db, make-brief.mjs, missing-checkout, missing-path, missing-verb, no-grep-hits, no-references, normalDeps, normaliseBoardPage, not-first-in-order, observeDispatches, openLedger, orderCandidates, parseBoardArgument, priority-unknown, rate-limit-floor, record-only, renderStartHeader, renderSweepReport, repeat-escalation, repeatEscalationDetail, run.json, scripts/factory/intake.mjs, stop-switch, sweepCommand, task.json, tier-judge, unknown-verb, verifyPremise, window-cap
- test/factory-lane-watch.test.mjs · crew.json, plan:r1, task.json
- test/factory-ledger-floor.test.mjs · EVENT_TYPES, LedgerUsageError, NODE_FLOOR, WRITERS, isLockedError, ledger.db, ledger.jsonl, node:sqlite, openLedger
- test/factory-ledger.test.mjs · ADVISOR_AB_INCOMPLETE_REASONS, CELL_FAILURE_ATTRIBUTIONS, CELL_FAILURE_KINDS, CELL_PRICE_UNITS, CELL_RATE_FLOOR, DISPATCH_OUTCOMES, DRIFT_REMEDY, GATE_DISCRIMINATION_VERDICTS, INTAKE_DISPATCH_OUTCOMES, LedgerUsageError, MIGRATIONS, MODIFIER_ATTEMPT_OUTCOMES, MODIFIER_KINDS, NODE_FLOOR, REQUEST_MAX_CHARS, RETIRED_TABLES, REVIEW_VERDICTS, RUN_VARIANTS, RUN_VARIANT_MARKERS, SEAT_TEARDOWN_OUTCOMES, SESSION_STATUSES, STAGE_MARKER_CHUNK, STATUSES, TABLES, TERM_TO_KILL_MS, UPDATE_ONLY_WRITERS, USAGE_ABSENT_CAUSES, WRITERS, WRITER_MIRROR_TABLES, _resetNoticeGuardsForTest, applyMigrations, boot-refusal, budget-ceiling, check-log, crew.json, emit.mjs, failure-upgrade, isoMs, ledger.db, ledger.jsonl, local-failures-disjoint, local-lane-reproduced, make-brief.mjs, mkdirpBounded, node:module, node:sqlite, not-first-in-order, openLedger, openRun, parseProposalBrief, plan:r1, platform-divergent, recordCellFailure, recordCiCycle, recordCiDispatch, replayJsonl, roster.json, run-set, scripts/factory/emit.mjs, scripts/factory/make-brief.mjs, seat-died, sensitivity-floor, task.json, usageAbsentCause, variantFromFirstMessage, vendor-diversity
- test/factory-make-brief.test.mjs · ACCEPTANCE_GATE_BLOCK, BROAD_KEY_HIT_LIMIT, BriefUsageError, CONVENTIONS_BLOCK, DEFAULT_PROTECTED_PATHS, LADDER_BANDS, MUTATION_CONTRACT_BLOCK, PROPOSAL_BLOCK, PROPOSAL_KEYS, REFUSAL_REASONS, SLOT_MARKER, TIER_NAMES, ci-repair.mjs, ci-watch.mjs, ciWatchRun, crossCheckCoupling, defaultProfilePath, discoverTripwires, emit.mjs, extractKeys, extractSymbols, gatherFences, gatherProtectedPaths, make-brief.mjs, model-ladder.json, node:crypto, probe-repo.mjs, probeRepo, profile-ratification-invalid, profile-unratified, profile-unreadable, profileField, proposeTier, protected-paths.mjs, readLadder, readLadderBands, renderBrief, renderProposalBlock, renderProposedTier, resolveWriteSurface, scripts/factory/ci-repair.mjs, scripts/factory/ci-watch.mjs, scripts/factory/emit.mjs, scripts/factory/make-brief.mjs, scripts/factory/probe-repo.mjs, validateAsk, validateScopeEntries, verifyWhere
- test/factory-probe-repo.test.mjs · FIELD_KINDS, FIELD_KIND_NAMES, INTAKE_BOARD_FIELD, INTAKE_BOARD_REFUSALS, INTAKE_COLUMN_ROLES, LOAD_BEARING, PROFILE_VERSION, PROTECTED_PATH_PATTERNS, ProfileRefusal, UNKNOWN_REASONS, assertRunnable, breaker.mjs, checkoutIntakeBoard, checkoutProtectedPaths, defaultProfilePath, fieldKind, isRatifiable, missing-checkout, probe-repo.mjs, probeRepo, profile-field-unknown, profile-ratification-invalid, profile-unratified, profile-unreadable, profileBody, profileDigest, profileIntakeBoard, profileProtectedPaths, readProfile, requireField, scripts/factory/probe-repo.mjs, symbolic-ref, writeProfile
- test/factory-transcript.test.mjs · isoMs, triage.mjs
- test/visualizer-panels.test.mjs · ROLE_ORDER, boot-refusal, brief-uncompilable, crew/roster.json, feed.mjs, intake-block-malformed, intake-block-missing, ledger-feed.mjs, not-first-in-order, priority-unknown, rate-limit-floor, roster.json, shape.mjs, stop-switch, tier-judge, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs, window-cap
- test/visualizer-returns.test.mjs · createReturnsSource, node:crypto, returns-source.mjs, run.json, task.json, visualizer/server/returns-source.mjs
- test/visualizer-roster-edit.test.mjs · ROLE_ORDER, capabilityRefusals, composeMoves, crew/roster.json, ladderView, loadSeatSchema, model-ladder.json, proposeEdit, readLadder, readReference, roster-edit.mjs, roster-ladder.mjs, roster.json, roster.schema.json, stageMoves, visualizer/server/roster-edit.mjs, visualizer/server/roster-ladder.mjs
- test/visualizer-server.test.mjs · 127.0.0.1, DEFAULT_INTAKE_CONFIG, NODE_FLOOR, STOP_SWITCH_PATH, ServerUsageError, WRITERS, board-write-failed, boot-refusal, content-type, createLedgerFeed, crew/roster.json, feed.mjs, intake-block-missing, intake.mjs, intakeLoop, intakeRun, intakeSweep, ledger-feed.mjs, ledger.db, no-envelope, node:crypto, node:module, node:sqlite, openLedger, parseCliArgs, recordCellFailure, replayJsonl, roster.json, run-set, run.json, scripts/factory/intake.mjs, seat-died, server.mjs, shape.mjs, shapeIntake, startServer, stop-switch, task.json, tier-judge, visualizer.db, visualizer/server/ledger-feed.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs
- test/visualizer-shape.test.mjs · 127.0.0.1, INTAKE_REFUSALS, INTAKE_REFUSAL_REASONS, INTAKE_WINDOW_MS, NODE_FLOOR, REFUSAL_REASONS, ROLE_ORDER, RUN_SET_WINDOW_MS, boot-refusal, brief-uncompilable, defaultCellWindow, defaultIntakeWindow, defaultRunSetWindow, feed.mjs, foldAgents, intake-block-malformed, intake-block-missing, laneFor, ledger-feed.mjs, ledger.db, matchesFilters, no-envelope, node:module, node:sqlite, not-first-in-order, openLedger, priority-unknown, rate-limit-floor, repeat-escalation, run-set, server.mjs, shape.mjs, shapeCellHealth, shapeGateChecks, shapeIntake, shapeRun, shapeRunSet, startServer, stop-switch, tier-judge, triage.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs, visualizer/server/triage.mjs, window-cap, withCells
- test/visualizer-teardown.test.mjs · 127.0.0.1, NODE_FLOOR, SEAT_TEARDOWN_OUTCOMES, createLedgerFeed, defaultTeardownWindow, feed.mjs, ledger-feed.mjs, ledger.db, node:module, node:sqlite, openLedger, server.mjs, shape.mjs, shapeSeatTeardowns, startServer, visualizer.db, visualizer/server/ledger-feed.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs
broad keys (not used as tripwires):
- crew.mjs · 57 hits
- ledger.mjs · 53 hits
- main · 160 hits
- must-fix · 35 hits
- node:fs · 89 hits
- node:os · 54 hits
- node:path · 87 hits
- node:url · 40 hits
- protected-path · 31 hits
- runner · 35 hits
- scripts/factory/ledger.mjs · 46 hits
- tech-lead · 31 hits
declare every hit: grep -rn "../../crew/breaker.mjs\|../../crew/crew.mjs\|../../crew/protected-paths.mjs\|../../scripts/factory/ledger.mjs\|./ci-watch.mjs\|./emit.mjs\|./feed.mjs\|./ledger-feed.mjs\|./ledger.mjs\|./make-brief.mjs\|./probe-repo.mjs\|./returns-source.mjs\|./roster-edit.mjs\|./roster-ladder.mjs\|./roster-source.mjs\|./shape.mjs\|./triage.mjs\|127.0.0.1\|24.0.0\|ACCEPTANCE_GATE_BLOCK\|ACCEPT_DECISION_OUTCOMES\|ACTOR_CLAIM_MAX_CHARS\|ADAPTERS_DIR\|ADVISOR_AB_DISPATCH_FLOOR\|ADVISOR_AB_INCOMPLETE_REASONS\|ADVISOR_AB_VERDICTS\|BROAD_KEY_HIT_LIMIT\|BriefUsageError\|CELL_FAILURE_ATTRIBUTIONS\|CELL_FAILURE_KINDS\|CELL_HEALTH_WINDOW_MS\|CELL_PRICE_UNITS\|CELL_RATE_FLOOR\|CI_CLASSIFICATIONS\|CI_DECISIONS\|CI_DISPATCH_OUTCOMES\|CONVENTIONS_BLOCK\|DEFAULT_INTAKE_CONFIG\|DEFAULT_PROTECTED_PATHS\|DISPATCH_OUTCOMES\|DRIFT_REMEDY\|EVENT_TYPES\|EmitUsageError\|FIELD_KINDS\|FIELD_KIND_NAMES\|FORBIDDEN_SCOPE_PREFIXES\|GATE_DISCRIMINATION_VERDICTS\|INTAKE_BLOCK_KEYS\|INTAKE_BOARD_FIELD\|INTAKE_BOARD_REFUSALS\|INTAKE_BRAKE_OUTCOMES\|INTAKE_BRAKE_TRANSITIONS\|INTAKE_COLUMN_ROLES\|INTAKE_DISPATCH_OUTCOMES\|INTAKE_DISPATCH_VERDICTS\|INTAKE_OUTCOMES\|INTAKE_REFUSALS\|INTAKE_REFUSAL_GROUPS\|INTAKE_REFUSAL_REASONS\|INTAKE_WINDOW_MS\|IntakeUsageError\|LADDER_BANDS\|LADDER_CHECKS\|LADDER_PATH\|LEDGER_VERSION\|LOAD_BEARING\|LedgerUsageError\|MAX_CYCLES\|MAX_DISPATCHES\|MAX_SWEEP_TICKS\|MIGRATIONS\|MIN_SWEEP_INTERVAL_MS\|MODIFIER_ATTEMPT_OUTCOMES\|MODIFIER_KINDS\|MUTATION_CONTRACT_BLOCK\|NODE_FLOOR\|PAYLOAD_KEYS\|PHASE_STATUSES\|PREMISE_IDENTIFIER_CAP\|PREMISE_REFERENCE_CAP\|PREMISE_VERDICTS\|PROCESS_STATES\|PROFILE_REFUSALS\|PROFILE_VERSION\|PROPOSAL_BLOCK\|PROPOSAL_KEYS\|PROTECTED_PATHS_FIELD\|PROTECTED_PATH_PATTERNS\|PUSH_REFUSALS\|ProbeUsageError\|ProfileRefusal\|REFERENCE_ENV\|REFUSAL_REASONS\|REQUEST_MAX_CHARS\|REQUEST_SOURCES\|REQUIRED_INTAKE_CONFIG_KEYS\|RETIRED_TABLES\|REVIEW_VERDICTS\|ROLE_ORDER\|RUN_SET_WINDOW_MS\|RUN_VARIANTS\|RUN_VARIANT_MARKERS\|SCHEMA_PATH\|SEAT_TEARDOWN_OUTCOMES\|SEAT_TEARDOWN_WINDOW_MS\|SESSION_STATUSES\|SLOT_MARKER\|STAGE_MARKER_CHUNK\|STATUSES\|STOP_SWITCH_PATH\|SWEEP_USAGE\|ServerUsageError\|TABLES\|TERM_TO_KILL_MS\|TIER_NAMES\|UNKNOWN_REASONS\|UPDATE_ONLY_WRITERS\|USAGE_ABSENT_CAUSES\|WRITERS\|WRITER_MIRROR_TABLES\|_resetNoticeGuardsForTest\|advisorAbNotes\|advisorAbReadout\|agent-change\|applyMigrations\|assertRunnable\|board-fetch-failed\|board-write-failed\|board-write-unverified\|bodyDigest\|boot-refusal\|bound-reached\|bound-unverifiable\|branch-unresolved\|breaker.mjs\|brief-refused\|brief-uncompilable\|budget-ceiling\|budgetCeiling\|capabilityRefusals\|check-log\|check-log-tail-200\|checkout-missing\|checkoutIntakeBoard\|checkoutProtectedPaths\|ci-failures-unparseable\|ci-no-checks\|ci-repair.mjs\|ci-shape-unusable\|ci-watch.mjs\|ciRepairRun\|ciShape\|ciWatchRun\|classifyRed\|compileIntakeBrief\|compileRepairBrief\|composeMoves\|conclusion-not-adjudicable\|content-length\|content-type\|createFeed\|createLedgerFeed\|createReturnsSource\|createRosterSource\|createTriage\|crew-dir-missing\|crew.json\|crew.mjs\|crew/roster.json\|crossCheckCoupling\|cycle-bound-reached\|dead-anchor\|decisionFor\|defaultCellWindow\|defaultDbPath\|defaultIntakeWindow\|defaultProfilePath\|defaultRunSetWindow\|defaultTeardownWindow\|discoverTripwires\|dispatchAllowed\|dispatchPicked\|dispatchRepair\|emit.mjs\|extractFailure\|extractIntakeBlock\|extractKeys\|extractPremiseReferences\|extractSymbols\|failure-upgrade\|feed.mjs\|fetchBoard\|fetchCheckLog\|fetchCheckRuns\|fieldKind\|foldAgents\|gatherBaseline\|gatherFences\|gatherProfile\|gatherProtectedPaths\|grep-failed\|index.html\|inheritScope\|intake-block-malformed\|intake-block-missing\|intake.mjs\|intakeConfigUsable\|intakeLoop\|intakeRun\|intakeSweep\|isLockedError\|isRatifiable\|isWorkerPath\|isoMs\|ladderView\|laneFenceFor\|laneFor\|ledger-feed.mjs\|ledger.db\|ledger.jsonl\|ledger.mjs\|loadSeatSchema\|local-failures-disjoint\|local-lane-green\|local-lane-reproduced\|local-lane-unrunnable\|main\|make-brief.mjs\|matchesFilters\|missing-checkout\|missing-path\|missing-verb\|mkdirpBounded\|model-ladder.json\|model-reference.json\|must-fix\|no-envelope\|no-grep-hits\|no-references\|no-tier\|node:crypto\|node:fs\|node:http\|node:module\|node:os\|node:path\|node:sqlite\|node:url\|normalDeps\|normaliseBoardPage\|not-applicable\|not-first-in-order\|not-in-window\|observeDispatches\|openLedger\|openRun\|orderCandidates\|page-limit\|parkRecord\|parseBoardArgument\|parseCliArgs\|parsePort\|parseProposalBrief\|pendingFor\|plan:r1\|platform-divergent\|portFromEnv\|priority-unknown\|probe-failed\|probe-repo.mjs\|probeRepo\|profile-field-unknown\|profile-missing\|profile-ratification-invalid\|profile-unratified\|profile-unreadable\|profileBody\|profileDigest\|profileField\|profileIntakeBoard\|profileProtectedPaths\|proposeEdit\|proposeTier\|protected-path\|protected-paths.mjs\|push-failed\|pushBranch\|rate-limit-floor\|readLadder\|readLadderBands\|readProfile\|readReference\|record-only\|recordCellFailure\|recordCiCycle\|recordCiDispatch\|renderBrief\|renderProposalBlock\|renderProposedTier\|renderStartHeader\|renderSweepReport\|repairRequest\|repeat-escalation\|repeatEscalationDetail\|replayJsonl\|repo-key-unresolved\|repoKeyFor\|requireField\|resolveProfilePath\|resolveWriteSurface\|returns-source.mjs\|rev-parse\|roster-edit.mjs\|roster-ladder.mjs\|roster-source.mjs\|roster.json\|roster.schema.json\|run-set\|run.json\|run.lock\|runLocalLane\|runner\|scope-forbidden\|scope-uninheritable\|scripts/factory/ci-repair.mjs\|scripts/factory/ci-watch.mjs\|scripts/factory/emit.mjs\|scripts/factory/intake.mjs\|scripts/factory/ledger.mjs\|scripts/factory/make-brief.mjs\|scripts/factory/probe-repo.mjs\|seat-died\|seat-not-ready\|sensitivity-floor\|server.mjs\|shape.mjs\|shapeCellAttribution\|shapeCellHealth\|shapeGateChecks\|shapeIntake\|shapeRun\|shapeRunSet\|shapeSeatTeardowns\|stageMoves\|startServer\|stop-switch\|sweepCommand\|symbolic-ref\|task.json\|tech-lead\|test-command-unusable\|tier-judge\|triage.mjs\|unifiedDiff\|unknown-task\|unknown-time\|unknown-verb\|unusable-envelope\|usageAbsentCause\|validateAsk\|validateCell\|validateRequest\|validateScopeEntries\|variantFromFirstMessage\|vendor-diversity\|verifyPremise\|verifyWhere\|visualizer.db\|visualizer/server/feed.mjs\|visualizer/server/ledger-feed.mjs\|visualizer/server/returns-source.mjs\|visualizer/server/roster-edit.mjs\|visualizer/server/roster-ladder.mjs\|visualizer/server/roster-source.mjs\|visualizer/server/server.mjs\|visualizer/server/shape.mjs\|visualizer/server/triage.mjs\|watch-empty\|watch-unadjudicable\|window-cap\|withCells\|worker-path\|writeProfile" crew/ test/ scripts/ docs/
## Coupled sources
coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.
- crew/breaker.mjs · NODE_FLOOR, openLedger · no fence in play
- crew/capabilities.mjs · SCHEMA_PATH, roster-edit.mjs · no fence in play
- crew/child.mjs · checkoutProtectedPaths, emit.mjs, openRun, probe-repo.mjs, scripts/factory/emit.mjs, scripts/factory/probe-repo.mjs · no fence in play
- crew/crew.mjs · CELL_RATE_FLOOR, LADDER_PATH, PROFILE_REFUSALS, USAGE_ABSENT_CAUSES, checkoutProtectedPaths, ci-repair.mjs, ci-watch.mjs, emit.mjs, gatherFences, laneFenceFor, make-brief.mjs, openLedger, openRun, probe-repo.mjs, recordCellFailure, roster-ladder.mjs, scripts/factory/ci-repair.mjs, scripts/factory/ci-watch.mjs, scripts/factory/emit.mjs, scripts/factory/make-brief.mjs, scripts/factory/probe-repo.mjs, validateScopeEntries, visualizer/server/roster-ladder.mjs · no fence in play
- crew/daemon.mjs · NODE_FLOOR · no fence in play
- crew/headless.mjs · make-brief.mjs, probe-repo.mjs, scripts/factory/make-brief.mjs, scripts/factory/probe-repo.mjs · no fence in play
- crew/protected-paths.mjs · probe-repo.mjs, scripts/factory/probe-repo.mjs · no fence in play
- scripts/factory/transcript.mjs · isoMs · no fence in play
- visualizer/web/src/lib/panels.js · shape.mjs · no fence in play
- visualizer/web/src/lib/trace.js · server.mjs · no fence in play
## Baseline
lane: npm test · pass 2171 · fail 0 · status: green
lane basis: ratified profile field test_command · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed
## Out of scope
No edits. No behaviour, schema, migration, enum or CLI changes. No proposal that adds a dependency. Tests are another scout's surface. The ledger's JSONL authority and migration chain are out of bounds for restructuring proposals — only read paths and query helpers.
## Fences
no fence register supplied (`--fences` not given)
## What the crew decides
UNFILLED SLOT
## Acceptance
A ranked findings register with the same shape as the runtime scout's: two-or-more locations per finding, category, one-sentence simplification, the pinning test or its absence, cost in files. Plus one section specific to ledger.mjs: a table of its sections (name, line range, what it owns, which exports leave it, which other sections it depends on) and a recommended split into no more than four modules that keeps every current export name reachable from scripts/factory/ledger.mjs so no importer changes — or the evidence that a split is not worth it. Every dead-export claim carries its grep. Ranked by behaviour risk then lines removed. The register says which files were read in full and which were sampled. · Full suite green. · UNFILLED SLOT
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
narrow: node --test crew/adapter-pi.test.mjs crew/arms.test.mjs crew/breaker.test.mjs crew/converge.test.mjs crew/crew.test.mjs crew/daemon.test.mjs crew/drive.test.mjs crew/escalation-policy.test.mjs crew/factoryctl.test.mjs crew/harvest.test.mjs crew/headless-rpc.test.mjs crew/headless.test.mjs crew/io-contract.test.mjs crew/pi/extensions/advisor.test.mjs crew/pi/extensions/lab.test.mjs crew/reclaim-descendants.test.mjs crew/reclaim.test.mjs crew/roster-refresh.test.mjs crew/seat-io-runclean.test.mjs skills/crew-dispatch/cli-contract.test.mjs test/factory-ci-repair.test.mjs test/factory-ci-watch.test.mjs test/factory-crew-watch.test.mjs test/factory-emit-floor.test.mjs test/factory-emit.test.mjs test/factory-env.test.mjs test/factory-intake.test.mjs test/factory-lane-watch.test.mjs test/factory-ledger-floor.test.mjs test/factory-ledger.test.mjs test/factory-make-brief.test.mjs test/factory-probe-repo.test.mjs test/factory-transcript.test.mjs test/visualizer-panels.test.mjs test/visualizer-returns.test.mjs test/visualizer-roster-edit.test.mjs test/visualizer-server.test.mjs test/visualizer-shape.test.mjs test/visualizer-teardown.test.mjs
full: npm test · measured baseline pass 2171, fail 0
## Conventions
files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): scripts/factory/ci-repair.mjs, scripts/factory/ci-watch.mjs, scripts/factory/emit.mjs, scripts/factory/intake.mjs, scripts/factory/ledger.mjs, scripts/factory/make-brief.mjs, scripts/factory/probe-repo.mjs, visualizer/server/
read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/converge.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, skills/crew-dispatch/cli-contract.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit-floor.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-probe-repo.test.mjs, test/factory-transcript.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs, visualizer/server/feed.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/returns-source.mjs, visualizer/server/roster-edit.mjs, visualizer/server/roster-ladder.mjs, visualizer/server/roster-source.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs, visualizer/server/triage.mjs
conventions of record (basis: ratified profile field conventions · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json): .claude/, README.md, docs/adr/, docs/conventions.md
grep -rn "../../crew/breaker.mjs\|../../crew/crew.mjs\|../../crew/protected-paths.mjs\|../../scripts/factory/ledger.mjs\|./ci-watch.mjs\|./emit.mjs\|./feed.mjs\|./ledger-feed.mjs\|./ledger.mjs\|./make-brief.mjs\|./probe-repo.mjs\|./returns-source.mjs\|./roster-edit.mjs\|./roster-ladder.mjs\|./roster-source.mjs\|./shape.mjs\|./triage.mjs\|127.0.0.1\|24.0.0\|ACCEPTANCE_GATE_BLOCK\|ACCEPT_DECISION_OUTCOMES\|ACTOR_CLAIM_MAX_CHARS\|ADAPTERS_DIR\|ADVISOR_AB_DISPATCH_FLOOR\|ADVISOR_AB_INCOMPLETE_REASONS\|ADVISOR_AB_VERDICTS\|BROAD_KEY_HIT_LIMIT\|BriefUsageError\|CELL_FAILURE_ATTRIBUTIONS\|CELL_FAILURE_KINDS\|CELL_HEALTH_WINDOW_MS\|CELL_PRICE_UNITS\|CELL_RATE_FLOOR\|CI_CLASSIFICATIONS\|CI_DECISIONS\|CI_DISPATCH_OUTCOMES\|CONVENTIONS_BLOCK\|DEFAULT_INTAKE_CONFIG\|DEFAULT_PROTECTED_PATHS\|DISPATCH_OUTCOMES\|DRIFT_REMEDY\|EVENT_TYPES\|EmitUsageError\|FIELD_KINDS\|FIELD_KIND_NAMES\|FORBIDDEN_SCOPE_PREFIXES\|GATE_DISCRIMINATION_VERDICTS\|INTAKE_BLOCK_KEYS\|INTAKE_BOARD_FIELD\|INTAKE_BOARD_REFUSALS\|INTAKE_BRAKE_OUTCOMES\|INTAKE_BRAKE_TRANSITIONS\|INTAKE_COLUMN_ROLES\|INTAKE_DISPATCH_OUTCOMES\|INTAKE_DISPATCH_VERDICTS\|INTAKE_OUTCOMES\|INTAKE_REFUSALS\|INTAKE_REFUSAL_GROUPS\|INTAKE_REFUSAL_REASONS\|INTAKE_WINDOW_MS\|IntakeUsageError\|LADDER_BANDS\|LADDER_CHECKS\|LADDER_PATH\|LEDGER_VERSION\|LOAD_BEARING\|LedgerUsageError\|MAX_CYCLES\|MAX_DISPATCHES\|MAX_SWEEP_TICKS\|MIGRATIONS\|MIN_SWEEP_INTERVAL_MS\|MODIFIER_ATTEMPT_OUTCOMES\|MODIFIER_KINDS\|MUTATION_CONTRACT_BLOCK\|NODE_FLOOR\|PAYLOAD_KEYS\|PHASE_STATUSES\|PREMISE_IDENTIFIER_CAP\|PREMISE_REFERENCE_CAP\|PREMISE_VERDICTS\|PROCESS_STATES\|PROFILE_REFUSALS\|PROFILE_VERSION\|PROPOSAL_BLOCK\|PROPOSAL_KEYS\|PROTECTED_PATHS_FIELD\|PROTECTED_PATH_PATTERNS\|PUSH_REFUSALS\|ProbeUsageError\|ProfileRefusal\|REFERENCE_ENV\|REFUSAL_REASONS\|REQUEST_MAX_CHARS\|REQUEST_SOURCES\|REQUIRED_INTAKE_CONFIG_KEYS\|RETIRED_TABLES\|REVIEW_VERDICTS\|ROLE_ORDER\|RUN_SET_WINDOW_MS\|RUN_VARIANTS\|RUN_VARIANT_MARKERS\|SCHEMA_PATH\|SEAT_TEARDOWN_OUTCOMES\|SEAT_TEARDOWN_WINDOW_MS\|SESSION_STATUSES\|SLOT_MARKER\|STAGE_MARKER_CHUNK\|STATUSES\|STOP_SWITCH_PATH\|SWEEP_USAGE\|ServerUsageError\|TABLES\|TERM_TO_KILL_MS\|TIER_NAMES\|UNKNOWN_REASONS\|UPDATE_ONLY_WRITERS\|USAGE_ABSENT_CAUSES\|WRITERS\|WRITER_MIRROR_TABLES\|_resetNoticeGuardsForTest\|advisorAbNotes\|advisorAbReadout\|agent-change\|applyMigrations\|assertRunnable\|board-fetch-failed\|board-write-failed\|board-write-unverified\|bodyDigest\|boot-refusal\|bound-reached\|bound-unverifiable\|branch-unresolved\|breaker.mjs\|brief-refused\|brief-uncompilable\|budget-ceiling\|budgetCeiling\|capabilityRefusals\|check-log\|check-log-tail-200\|checkout-missing\|checkoutIntakeBoard\|checkoutProtectedPaths\|ci-failures-unparseable\|ci-no-checks\|ci-repair.mjs\|ci-shape-unusable\|ci-watch.mjs\|ciRepairRun\|ciShape\|ciWatchRun\|classifyRed\|compileIntakeBrief\|compileRepairBrief\|composeMoves\|conclusion-not-adjudicable\|content-length\|content-type\|createFeed\|createLedgerFeed\|createReturnsSource\|createRosterSource\|createTriage\|crew-dir-missing\|crew.json\|crew.mjs\|crew/roster.json\|crossCheckCoupling\|cycle-bound-reached\|dead-anchor\|decisionFor\|defaultCellWindow\|defaultDbPath\|defaultIntakeWindow\|defaultProfilePath\|defaultRunSetWindow\|defaultTeardownWindow\|discoverTripwires\|dispatchAllowed\|dispatchPicked\|dispatchRepair\|emit.mjs\|extractFailure\|extractIntakeBlock\|extractKeys\|extractPremiseReferences\|extractSymbols\|failure-upgrade\|feed.mjs\|fetchBoard\|fetchCheckLog\|fetchCheckRuns\|fieldKind\|foldAgents\|gatherBaseline\|gatherFences\|gatherProfile\|gatherProtectedPaths\|grep-failed\|index.html\|inheritScope\|intake-block-malformed\|intake-block-missing\|intake.mjs\|intakeConfigUsable\|intakeLoop\|intakeRun\|intakeSweep\|isLockedError\|isRatifiable\|isWorkerPath\|isoMs\|ladderView\|laneFenceFor\|laneFor\|ledger-feed.mjs\|ledger.db\|ledger.jsonl\|ledger.mjs\|loadSeatSchema\|local-failures-disjoint\|local-lane-green\|local-lane-reproduced\|local-lane-unrunnable\|main\|make-brief.mjs\|matchesFilters\|missing-checkout\|missing-path\|missing-verb\|mkdirpBounded\|model-ladder.json\|model-reference.json\|must-fix\|no-envelope\|no-grep-hits\|no-references\|no-tier\|node:crypto\|node:fs\|node:http\|node:module\|node:os\|node:path\|node:sqlite\|node:url\|normalDeps\|normaliseBoardPage\|not-applicable\|not-first-in-order\|not-in-window\|observeDispatches\|openLedger\|openRun\|orderCandidates\|page-limit\|parkRecord\|parseBoardArgument\|parseCliArgs\|parsePort\|parseProposalBrief\|pendingFor\|plan:r1\|platform-divergent\|portFromEnv\|priority-unknown\|probe-failed\|probe-repo.mjs\|probeRepo\|profile-field-unknown\|profile-missing\|profile-ratification-invalid\|profile-unratified\|profile-unreadable\|profileBody\|profileDigest\|profileField\|profileIntakeBoard\|profileProtectedPaths\|proposeEdit\|proposeTier\|protected-path\|protected-paths.mjs\|push-failed\|pushBranch\|rate-limit-floor\|readLadder\|readLadderBands\|readProfile\|readReference\|record-only\|recordCellFailure\|recordCiCycle\|recordCiDispatch\|renderBrief\|renderProposalBlock\|renderProposedTier\|renderStartHeader\|renderSweepReport\|repairRequest\|repeat-escalation\|repeatEscalationDetail\|replayJsonl\|repo-key-unresolved\|repoKeyFor\|requireField\|resolveProfilePath\|resolveWriteSurface\|returns-source.mjs\|rev-parse\|roster-edit.mjs\|roster-ladder.mjs\|roster-source.mjs\|roster.json\|roster.schema.json\|run-set\|run.json\|run.lock\|runLocalLane\|runner\|scope-forbidden\|scope-uninheritable\|scripts/factory/ci-repair.mjs\|scripts/factory/ci-watch.mjs\|scripts/factory/emit.mjs\|scripts/factory/intake.mjs\|scripts/factory/ledger.mjs\|scripts/factory/make-brief.mjs\|scripts/factory/probe-repo.mjs\|seat-died\|seat-not-ready\|sensitivity-floor\|server.mjs\|shape.mjs\|shapeCellAttribution\|shapeCellHealth\|shapeGateChecks\|shapeIntake\|shapeRun\|shapeRunSet\|shapeSeatTeardowns\|stageMoves\|startServer\|stop-switch\|sweepCommand\|symbolic-ref\|task.json\|tech-lead\|test-command-unusable\|tier-judge\|triage.mjs\|unifiedDiff\|unknown-task\|unknown-time\|unknown-verb\|unusable-envelope\|usageAbsentCause\|validateAsk\|validateCell\|validateRequest\|validateScopeEntries\|variantFromFirstMessage\|vendor-diversity\|verifyPremise\|verifyWhere\|visualizer.db\|visualizer/server/feed.mjs\|visualizer/server/ledger-feed.mjs\|visualizer/server/returns-source.mjs\|visualizer/server/roster-edit.mjs\|visualizer/server/roster-ladder.mjs\|visualizer/server/roster-source.mjs\|visualizer/server/server.mjs\|visualizer/server/shape.mjs\|visualizer/server/triage.mjs\|watch-empty\|watch-unadjudicable\|window-cap\|withCells\|worker-path\|writeProfile" crew/ test/ scripts/ docs/
- The factory scripts carry a Node ≥24 floor; follow the existing
  `scripts/factory/*` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No `Co-Authored-By` trailers.
- If interrupted, write your ReturnEnvelope first on resume — `status:
  insufficient` if incomplete. A silent seat is indistinguishable from a dead
  one.
