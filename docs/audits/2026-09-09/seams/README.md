# Seam clustering report — #1033 done-means (a)

Measured at `3faa3ff`, 2026-09-09, with `node scripts/factory/seams.mjs <file>`.

#1033 ask 1 asked for a clustering report **per named file, with line spans,
per-cluster imports and cross-cluster edges**, committed under `docs/`. The
numbers reached ADR-042 and the issue thread but the artifact was never
committed; this is it.

**Regenerate:** `node scripts/factory/seams.mjs <file>`. A row here has roughly
a one-day shelf life at this repo's rate of change — `crew/drive.mjs` gained 735
lines between ADR-042's measurement at `d8a201b` and this one. **A split lane
must re-run the report against its own base commit and cut on that**, never on a
number quoted from this file.

## Summary

| file | lines | kind | clusters | cross-cluster edges | edges/cluster | pins | manifests holding them | tests reaching | floor |
|---|---|---|---|---|---|---|---|---|---|
| `crew/drive.mjs` | 8,258 | source | 32 | 9,641 | 301.3 | 28 | 5 | 13 | **yes** |
| `scripts/factory/ledger.mjs` | 7,699 | source | 24 | 902 | 37.6 | 6 | 1 | 16 | no |
| `crew/seat-io.mjs` | 3,815 | source | 29 | 873 | 30.1 | 2 | 1 | 14 | no |
| `scripts/factory/dispatch-batch.mjs` | 3,740 | source | 7 | 762 | 108.9 | 9 | 1 | 3 | no |
| `crew/crew.test.mjs` | 7,768 | test | 138 | 185 | 1.3 | 0 | 0 | 0 | no |
| `test/factory-dispatch-batch.test.mjs` | 6,319 | test | 118 | 123 | 1.0 | 0 | 0 | 0 | no |
| `test/factory-ledger.test.mjs` | 7,389 | test | 14 | 2 | 0.1 | 3 | 1 | 0 | no |

For a **test** target the clusters hold test blocks, so the largest-cluster share
says whether the report can guide a cut at all. For a **source** target the
clusters hold exported symbols, and edges/cluster says what a cut would sever.

| test suite | test blocks | clusters | largest cluster | share | can the report say where to cut? |
|---|---|---|---|---|---|
| `crew/crew.test.mjs` | 358 | 138 | 82 | **23%** | yes |
| `test/factory-dispatch-batch.test.mjs` | 290 | 118 | 65 | **22%** | yes |
| `test/factory-ledger.test.mjs` | 342 | 14 | 319 | **93%** | **no** — one cluster dominates |

## `crew/drive.mjs`

8,258 lines · source · **32 clusters** · **9,641 cross-cluster edges** of 29,092 counted · 28 anchor pins across 5 manifests · 13 tests reaching · protected floor: **yes**

| cluster line spans | blocks | lines | symbols | importers |
|---|---|---|---|---|
| 1898-1898, 1894-1894, 1905-1921, 1807-1819 +193 more | 197 | 1756 | ACCEPT_REASKS, ACCEPT_REFUSALS, ADOPTED_PLAN_HEADING, CARVE_VERDICTS, CENSUS_ROW_ABSENT, CENSUS_TURNS_ABSENT +191 | crew/drive-fixtures.mjs |
| 1061-1065, 7474-7482, 2189-2193, 7514-7527 +40 more | 44 | 177 | ADVERSARY_TRIGGER, CURSOR_STAGES, DIFF_MUTATION_CAP_DEFAULT, DIFF_MUTATION_CAP_MAX, DIFF_MUTATION_CAP_MIN, GATE_REAP_LAUNCH_EOF +38 | — |
| 7008-7016, 950-956, 2058-2069, 2091-2133 | 4 | 71 | applyMutationAnchor, baselineGateDefect, checkFailureLine, validateMutations | crew/drive-fixtures.mjs, scripts/factory/prove-mutations.mjs |
| 1067-1070, 1066-1066, 1058-1058, 2214-2214 +4 more | 8 | 53 | ADVERSARY_REFUSAL, ADVERSARY_REFUSALS, ADVERSARY_TRIGGERS, fenceScopeOf, fenceScopesIntersect, parseUnifiedZeroHunks +2 | crew/drive.test.mjs |
| 7966-7966, 7932-7932, 7910-7910, 8049-8070 +3 more | 7 | 43 | CHECK_MATCHES, HARDENING_APPEAL_SHAPE, HARDENING_CLASSES, hardeningAppealLines, hardeningAppealRequest, hardeningClassOf +1 | crew/drive-build.test.mjs |
| 1988-2012 | 1 | 25 | parseDirectedBrief | crew/drive-fixtures.mjs, scripts/factory/dispatch-batch.mjs, test/factory-dispatch-batch.test.mjs, test/factory-make-brief.test.mjs |
| 342-342, 388-410 | 2 | 24 | CENSUS_ABSENT_REASONS, observeTurnCensus | crew/drive-fixtures.mjs, crew/drive-plan.test.mjs |
| 345-345, 453-453, 1630-1630, 1664-1664 +5 more | 9 | 24 | CENSUS_ELIGIBLE_OUTCOMES, CREATES_ABSENT, PLAN_BOUNCE_UNFUNDED_HEADING, PLAN_SEAT_REFUSED, planBounceUnfundedLines, planCapNote +3 | crew/drive-plan.test.mjs |
| 2451-2461, 2592-2602 | 2 | 22 | journalRowsSinceRunStart, parseSuiteCounts | crew/drive-fixtures.mjs, scripts/factory/closeout.mjs |
| 1941-1961 | 1 | 21 | validateScopeEntries | crew/child.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive-fixtures.mjs +1 |
| 136-136, 164-164, 99-99, 179-179 +3 more | 7 | 18 | NO_TURN_CEILING, WAIT_FLAGS, resolveTurnCeilings, resolveWaits, turnCeilingsRecord, waitsCtx +1 | crew/crew.mjs, crew/drive-fixtures.mjs |
| 7261-7265, 427-427, 630-630, 2036-2036 +3 more | 7 | 15 | FAILURE_UPGRADE, MODIFIER_OUTCOMES, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS, SENSITIVITY_FLOOR, SUITE_SLOT_PHASE_NAMES +1 | crew/drive-fixtures.mjs, test/factory-ledger.test.mjs |
| 2944-2957 | 1 | 14 | driveTask | crew/child.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive-fixtures.mjs |
| 931-944 | 1 | 14 | parseGateSummary | crew/drive-fixtures.mjs, crew/io-contract.test.mjs, scripts/factory/model-eval.mjs, scripts/factory/prove-mutations.mjs |
| 451-451, 1973-1983, 1967-1967, 1968-1968 | 4 | 14 | CREATES_MARK, DIRECTED_BLOCK, DIRECTED_KEYS, createsFromBrief | test/factory-make-brief.test.mjs |
| 27-35 | 1 | 9 | LIMITS | crew/child.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/drive-fixtures.mjs |
| 7329-7334 | 1 | 6 | PLAN_SCOPE | crew/drive-fixtures.mjs, skills/crew-recovery/exhibits.test.mjs |
| 2161-2165 | 1 | 5 | scopeMatcher | crew/drive-fixtures.mjs, scripts/factory/dispatch-batch.mjs, scripts/factory/prove-mutations.mjs |
| 173-173, 189-191 | 2 | 4 | turnCeilingArgs, turnCeilingsJournalPatch | crew/crew.mjs |
| 52-54 | 1 | 3 | WAITS_S | crew/crew.mjs, crew/drive-fixtures.mjs, scripts/factory/dispatch-batch.mjs, test/factory-dispatch-batch.test.mjs |
| 7556-7556, 7555-7555 | 2 | 2 | operationalRow, recordRow | crew/drive-fixtures.mjs, crew/seat-io.mjs |
| 7644-7644, 7664-7664 | 2 | 2 | FINDING_DISPOSITIONS, FINDING_ID_SHAPE | crew/drive-fixtures.mjs, skills/pr-review/findings-shape.test.mjs |
| 2053-2053, 2017-2017 | 2 | 2 | CHECK_FAIL_PREFIX, MUTATIONS_MAX | crew/drive-fixtures.mjs, test/factory-make-brief.test.mjs |
| 556-556 | 1 | 1 | VARIANTS | crew/child.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/drive-fixtures.mjs, scripts/factory/dispatch-batch.mjs |
| 556-556 | 1 | 1 | VARIANT_NAMES | crew/crew.mjs, crew/crew.test.mjs, crew/drive-fixtures.mjs, scripts/factory/dispatch-batch.mjs, test/factory-ledger.test.mjs |
| 556-556 | 1 | 1 | DEFAULT_VARIANT | crew/crew.mjs, crew/crew.test.mjs, crew/drive-fixtures.mjs |
| 138-138 | 1 | 1 | TURN_CEILING_FLAGS | crew/crew.mjs, crew/crew.test.mjs, scripts/factory/dispatch-batch.mjs |
| 2404-2404 | 1 | 1 | RUN_START_EVENT | crew/crew.mjs, crew/drive-fixtures.mjs, scripts/factory/closeout.mjs |
| 434-434 | 1 | 1 | PROTECTED_PATHS | crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive-fixtures.mjs |
| 7549-7549 | 1 | 1 | JOURNAL_CHANNEL_NAMES | crew/drive-fixtures.mjs, crew/seat-io-runclean.test.mjs |
| 670-670 | 1 | 1 | GATE_SUMMARY_PREFIX | crew/drive-fixtures.mjs, scripts/factory/model-eval.mjs |
| 7548-7548 | 1 | 1 | JOURNAL_CHANNELS | crew/drive-fixtures.mjs, test/visualizer-trajectory.test.mjs, visualizer/server/journal-source.mjs |

**Denominators:** 314 files scanned · 316 symbols clustered · 29,092 edges counted · skipped: []

## `scripts/factory/ledger.mjs`

7,699 lines · source · **24 clusters** · **902 cross-cluster edges** of 1,810 counted · 6 anchor pins across 1 manifests · 16 tests reaching · protected floor: no

| cluster line spans | blocks | lines | symbols | importers |
|---|---|---|---|---|
| 384-384, 370-370, 357-357, 6480-6522 +22 more | 26 | 950 | ACCEPT_DECISION_OUTCOMES, ADVISOR_AB_DISPATCH_FLOOR, ADVISOR_AB_VERDICTS, CI_CLASSIFICATIONS, CI_DECISIONS, CI_DISPATCH_OUTCOMES +20 | — |
| 358-366, 586-586, 583-585, 1498-1526 +39 more | 43 | 890 | ADVISOR_AB_INCOMPLETE_REASONS, AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS, CELL_FAILURE_ATTRIBUTIONS, CELL_FAILURE_KINDS, CELL_PRICE_UNITS +37 | test/factory-ledger.test.mjs |
| 1602-1634, 96-115, 136-136 | 3 | 54 | SESSION_STATUSES, isoMs, mkdirpBounded | scripts/factory/emit.mjs, test/factory-ledger.test.mjs |
| 5633-5684 | 1 | 52 | replayJsonl | test/factory-ledger.test.mjs, test/visualizer-server.test.mjs |
| 521-533 | 1 | 13 | PAYLOAD_KEYS | crew/crew.test.mjs, test/factory-emit.test.mjs |
| 2248-2254 | 1 | 7 | openLedger | crew/arms.test.mjs, crew/breaker.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/daemon.test.mjs +17 |
| 560-566 | 1 | 7 | USAGE_ABSENT_CAUSES | crew/crew.mjs, crew/crew.test.mjs, test/factory-ledger.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs +1 |
| 6173-6179 | 1 | 7 | defaultDbPath | scripts/factory/lane-watch.mjs, scripts/factory/model-eval.mjs |
| 1537-1543 | 1 | 7 | LedgerUsageError | test/factory-intake.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs |
| 589-595 | 1 | 7 | usageAbsentCause | test/factory-ledger.test.mjs, visualizer/server/shape.mjs |
| 424-429 | 1 | 6 | INTAKE_REFUSALS | scripts/factory/intake.mjs, test/factory-intake.test.mjs, test/visualizer-shape.test.mjs |
| 1366-1371 | 1 | 6 | WRITERS | test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/visualizer-server.test.mjs |
| 131-134 | 1 | 4 | EVENT_TYPES | crew/crew.test.mjs, test/factory-ledger-floor.test.mjs |
| 442-442, 449-451 | 2 | 4 | INTAKE_DISPATCH_VERDICTS, PREMISE_VERDICTS | test/factory-intake.test.mjs |
| 2032-2035 | 1 | 4 | isLockedError | test/factory-ledger-floor.test.mjs |
| 6161-6163 | 1 | 3 | homeDefaultDbPath | scripts/factory/emit.mjs |
| 372-374 | 1 | 3 | EVAL_ABSENT_REASONS | scripts/factory/model-eval.mjs, test/factory-ledger.test.mjs, test/factory-model-eval.test.mjs |
| 437-439 | 1 | 3 | INTAKE_DISPATCH_OUTCOMES | test/factory-intake.test.mjs, test/factory-ledger.test.mjs |
| 354-354, 171-171 | 2 | 2 | CELL_RATE_FLOOR, escalationCause | crew/crew.mjs, test/factory-ledger.test.mjs |
| 122-122 | 1 | 1 | NODE_FLOOR | crew/breaker.mjs, crew/breaker.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, test/factory-emit.test.mjs +6 |
| 5960-5960 | 1 | 1 | ingestJournal | scripts/factory/closeout.mjs, test/factory-ledger.test.mjs |
| 423-423 | 1 | 1 | INTAKE_OUTCOMES | scripts/factory/intake.mjs, test/factory-intake.test.mjs |
| 411-411 | 1 | 1 | PHASE_SLOT_WAIT_ABSENT | test/factory-ledger.test.mjs, test/visualizer-server.test.mjs, visualizer/server/ledger-feed.mjs |
| 322-322 | 1 | 1 | SEAT_TEARDOWN_OUTCOMES | test/factory-ledger.test.mjs, test/visualizer-teardown.test.mjs |

**Denominators:** 314 files scanned · 95 symbols clustered · 1,810 edges counted · skipped: []

## `crew/seat-io.mjs`

3,815 lines · source · **29 clusters** · **873 cross-cluster edges** of 1,337 counted · 2 anchor pins across 1 manifests · 14 tests reaching · protected floor: no

| cluster line spans | blocks | lines | symbols | importers |
|---|---|---|---|---|
| 1289-1470 | 1 | 182 | emitAdapter | crew/crew.mjs, crew/daemon.test.mjs, crew/io-contract.test.mjs, crew/seat-io-heartbeat.test.mjs, crew/seat-io-runclean.test.mjs +2 |
| 3764-3764, 3791-3791, 1998-1998, 1987-1987 +26 more | 30 | 81 | COLD_PATH_FALLBACK_ROOTS, COLD_PATH_MIN_SHARED, LIVENESS_MISSES_TO_DIE, REASK_SETTLE_POLLS, SEAT_RETRY_MAX, SILENCE_REASK_MS +24 | crew/seat-io-runclean.test.mjs |
| 1113-1142, 1100-1111, 88-88 | 3 | 43 | RUN_MAX_BUFFER_BYTES, nextModelRung, nextRung | crew/io-contract.test.mjs |
| 1988-1988, 1964-1970, 211-211, 212-212 +12 more | 16 | 39 | COLD_PATH_ATTEMPTS, DESCENDANT_PS_TIMEOUT_MS, DESCENDANT_SETTLE_MS, DESCENDANT_SETTLE_POLLS, REASK_MAX, REASK_SETTLE_MS +10 | — |
| 214-214, 322-346, 288-288, 231-233 +1 more | 5 | 31 | DESCENDANT_MAX_ANCHORS, escapedDescendants, psSnapshot, statIsZombie, verifyGroup | crew/reclaim-descendants.test.mjs |
| 1273-1287 | 1 | 15 | cellFailureKind | crew/crew.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/io-contract.test.mjs, crew/seat-io-runclean.test.mjs |
| 1540-1540, 1539-1539, 1941-1941, 110-110 +1 more | 5 | 5 | PANE_SETTLE_MS, PANE_SETTLE_POLLS, SUBSTRATE_MISSES_TO_DIE, VARIANT_STAGE_PHASES, paneProbe | crew/crew.test.mjs |
| 206-209, 488-488 | 2 | 5 | DESCENDANT_STORE_DIRS, descendantCapture | crew/reclaim-descendants.test.mjs, crew/seat-io-runclean.test.mjs |
| 175-178, 170-170 | 2 | 5 | SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS | crew/seat-io-runclean.test.mjs, test/factory-ledger.test.mjs |
| 80-80, 81-81, 862-862 | 3 | 3 | ROOT_DEATH_GROWTH_WINDOW_MS, ROOT_DEATH_SUPPRESSED_EVENT, seatRootDeath | crew/seat-io-death.test.mjs |
| 1951-1951, 1554-1554 | 2 | 2 | paneAlive, paneTeardownRows | crew/crew.mjs, crew/crew.test.mjs |
| 2093-2093 | 1 | 1 | seatIo | crew/child.mjs, crew/crew.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/headless.test.mjs +5 |
| 1477-1477 | 1 | 1 | settleSeatTeardown | crew/child.mjs, crew/crew.mjs, crew/daemon.test.mjs, crew/reclaim-descendants.test.mjs, crew/seat-io-runclean.test.mjs |
| 30-30 | 1 | 1 | DEFAULT_TRANSPORT | crew/crew.mjs, crew/crew.test.mjs, crew/daemon.test.mjs |
| 64-64 | 1 | 1 | HEADLESS_TRANSPORT | crew/crew.mjs, crew/headless.test.mjs, crew/seat-io-death.test.mjs, crew/seat-io-heartbeat.test.mjs, crew/seat-io-runclean.test.mjs |
| 925-925 | 1 | 1 | reclaimDescendants | crew/crew.mjs, crew/reclaim-descendants.test.mjs, scripts/factory/reap-stale.mjs |
| 742-742 | 1 | 1 | settleSeatRoots | crew/crew.mjs, crew/reclaim-descendants.test.mjs |
| 65-65 | 1 | 1 | HEADLESS_RPC_TRANSPORT | crew/crew.mjs, crew/seat-io-death.test.mjs, crew/seat-io-heartbeat.test.mjs, crew/seat-io-runclean.test.mjs |
| 1210-1210 | 1 | 1 | saveCrew | crew/crew.mjs, crew/seat-io-runclean.test.mjs |
| 1214-1214 | 1 | 1 | resolveWorkerBin | crew/crew.mjs |
| 3676-3676 | 1 | 1 | SEAT_REFUSAL_STAGE | crew/crew.test.mjs, crew/drive-fixtures.mjs, crew/seat-io-runclean.test.mjs, skills/crew-recovery/exhibits.test.mjs |
| 107-107 | 1 | 1 | SUBSTRATE_GRACE_MS | crew/crew.test.mjs, crew/seat-io-runclean.test.mjs |
| 66-66 | 1 | 1 | WAIT_POLL_MS | crew/io-contract.test.mjs, crew/seat-io-death.test.mjs, crew/seat-io-runclean.test.mjs |
| 210-210 | 1 | 1 | DESCENDANT_DIR | crew/reclaim-descendants.test.mjs, crew/seat-io-death.test.mjs, scripts/factory/reap-stale.mjs, test/factory-reap-stale.test.mjs |
| 3679-3679 | 1 | 1 | SEAT_DIED_STAGE | crew/seat-io-death.test.mjs, crew/seat-io-runclean.test.mjs, skills/crew-recovery/exhibits.test.mjs |
| 157-157 | 1 | 1 | REASK_TIMEOUT_S | crew/seat-io-death.test.mjs, crew/seat-io-runclean.test.mjs |
| 67-67 | 1 | 1 | LIVENESS_PROBE_MS | crew/seat-io-heartbeat.test.mjs, crew/seat-io-runclean.test.mjs, scripts/factory/lane-watch.mjs, test/factory-lane-watch.test.mjs |
| 1813-1813 | 1 | 1 | headlessStreamPaths | crew/seat-io-heartbeat.test.mjs |
| 71-71 | 1 | 1 | SEAT_LIVENESS_EVENT | crew/seat-io-runclean.test.mjs, scripts/factory/lane-watch.mjs |

**Denominators:** 314 files scanned · 88 symbols clustered · 1,337 edges counted · skipped: []

## `scripts/factory/dispatch-batch.mjs`

3,740 lines · source · **7 clusters** · **762 cross-cluster edges** of 6,331 counted · 9 anchor pins across 1 manifests · 3 tests reaching · protected floor: no

| cluster line spans | blocks | lines | symbols | importers |
|---|---|---|---|---|
| 200-200, 2808-2810, 107-107, 130-130 +102 more | 106 | 334 | ADOPT_EVENT, ANCHOR_BLIND_SPOT, ANCHOR_PIN_POST_MERGE, ANCHOR_PIN_WARNING_PREFIX, BAND_FLOOR_REASONS, BOOT_TRANSPORT +100 | test/factory-dispatch-batch.test.mjs |
| 221-227, 198-198, 197-197, 199-199 +28 more | 32 | 55 | ADOPT_FINDINGS_CLAUSE, ADOPT_OPTIONAL, ADOPT_REQUIRED, ADOPT_REVISE_MARKER, BASELINE_CACHE_DIRNAME, BOOT_ATTEMPTS +26 | — |
| 3651-3690 | 1 | 40 | parseCliArgs | skills/crew-dispatch/cli-contract.test.mjs, test/factory-dispatch-batch.test.mjs |
| 203-220 | 1 | 18 | ADOPT_BLOCK | crew/drive-fixtures.mjs, test/factory-dispatch-batch.test.mjs |
| 1181-1181, 2611-2611, 3122-3136 | 3 | 17 | collectAnchorPins, crewJsonPath, teardownVerdict | scripts/factory/closeout.mjs, test/factory-dispatch-batch.test.mjs |
| 290-290, 297-297 | 2 | 2 | DRY_RUN_BLIND_SPOT, TEST_REACH_BLIND_SPOT | skills/crew-dispatch/exhibits.test.mjs, test/factory-dispatch-batch.test.mjs |
| 190-190 | 1 | 1 | TEARDOWN_PROVEN | scripts/factory/closeout.mjs |

**Denominators:** 314 files scanned · 146 symbols clustered · 6,331 edges counted · skipped: []

## `crew/crew.test.mjs`

7,768 lines · test · **138 clusters** · **185 cross-cluster edges** of 266 counted · 0 anchor pins across 0 manifests · 0 tests reaching · protected floor: no

| cluster line spans | blocks | lines | symbols | importers |
|---|---|---|---|---|
| 371-382, 384-415, 716-722, 1524-1530 +78 more | 82 | 1192 | _(none — symbol-less)_ | — |
| 665-689, 1062-1088, 1090-1130, 1132-1159 +31 more | 35 | 821 | bootCmd | — |
| 1928-1962, 1964-1995, 2057-2090, 2092-2129 +11 more | 15 | 546 | bootCmd, runCmd | — |
| 6267-6297, 6300-6336, 6338-6371, 6373-6415 +2 more | 6 | 211 | emitAdapter | — |
| 5831-5847, 5849-5862, 5864-5884, 5886-5903 +8 more | 12 | 208 | waitForEnvelope | — |
| 769-776, 778-788, 790-794, 796-845 +4 more | 8 | 155 | resolveAdapters | — |
| 1532-1571, 5285-5316, 7715-7767 | 3 | 125 | awaitSeatsReady, bootCmd, runCmd, writeTerminalLine | — |
| 4615-4619, 4621-4637, 4639-4656, 4658-4667 +6 more | 10 | 122 | awaitSeatsReady | — |
| 7629-7713 | 1 | 85 | FLAG_VALUE_REFUSAL, PANE_TURN_CEILING_UNMEASURED, assertUsage, bootCmd, paneTurnCeilingRefusals, runCmd | — |
| 4934-4939, 4941-4944, 4961-4965, 4967-4976 +6 more | 10 | 77 | resolveTier | — |
| 509-547, 549-584 | 2 | 75 | ROLE_ORDER, SEAT_DEFAULTS, assertGrantsBacked, grantsFor, loadCapabilities | — |
| 5444-5454, 5456-5472, 5474-5492, 5494-5519 | 4 | 73 | resolveSeatModels, resolveTier | — |
| 4747-4779, 5318-5356 | 2 | 72 | awaitSeatsReady, bootCmd, runCmd | — |
| 6075-6086, 6088-6100, 6102-6119, 6121-6148 | 4 | 71 | LIVENESS_PROBE_MS, waitForEnvelope | — |
| 1814-1880 | 1 | 67 | RUN_START_EVENT, bootCmd, runCmd | — |
| 7265-7285, 7287-7304, 7306-7319, 7354-7366 | 4 | 66 | loadLadder, shadowPick | — |
| 4166-4185, 4399-4420, 4422-4439 | 3 | 60 | teardownCore | — |
| 1793-1812, 3420-3434, 3447-3467 | 3 | 56 | runCmd | — |
| 2820-2830, 2832-2876 | 2 | 56 | runOutcome | — |
| 6598-6653 | 1 | 56 | SUITE_OWNER_PATH, SUITE_REFUSAL, packageSuite | — |
| 6698-6724, 6948-6972 | 2 | 52 | CAPABILITY_REFUSALS, resolveAdapters | — |
| 231-238, 240-253, 255-272, 4846-4856 | 4 | 51 | parkOnOutcome | — |
| 1434-1464, 1466-1485 | 2 | 51 | resolveRunConfig | — |
| 488-507, 691-714, 859-865 | 3 | 51 | SEAT_DEFAULTS | — |
| 4517-4566 | 1 | 50 | teardownCmd | — |
| 4568-4613 | 1 | 46 | TEARDOWN_EXIT_SEATLESS, TEARDOWN_EXIT_UNPROVEN, teardownCmd | — |
| 7197-7215, 7217-7242 | 2 | 45 | advisorBootRecord, assertAdvisorCellLive | — |
| 6974-7015 | 1 | 42 | CAPABILITY_REFUSALS, EMPTY_GRANTS, FANOUT_TOOLS, SEAT_DEFAULTS, assertFanoutCoherent, deniedFanout +1 | — |
| 2878-2919 | 1 | 42 | installExitMarker, terminalLineSeen, writeTerminalLine | — |
| 1573-1579, 1581-1606, 1608-1615 | 3 | 41 | resolveFilesInScope | — |
| 4475-4515 | 1 | 41 | TEARDOWN_ABSENT_CAUSES, TEARDOWN_EXIT_SEATLESS, teardownCmd | — |
| 5715-5726, 5728-5740, 5742-5752, 5761-5764 | 4 | 40 | assertBandFloors | — |
| 1617-1656 | 1 | 40 | resolveLaneFence | — |
| 433-455, 457-470 | 2 | 37 | EMPTY_GRANTS, loadCapabilities | — |
| 2719-2753 | 1 | 35 | BOOLEAN_FLAGS, FLAG_VALUE_CONTRACT, FLAG_VALUE_REFUSAL, KNOWN_FLAGS, assertUsage, parseArgs | — |
| 343-357, 359-369, 6938-6946 | 3 | 35 | FANOUT_TOOLS, SEAT_DEFAULTS | — |
| 605-614, 6871-6895 | 2 | 35 | mcpConfigDocument | — |
| 1894-1926 | 1 | 33 | BATCH_DIR_EVENT, BATCH_DIR_NOT_BATCHED, bootCmd, runCmd | — |
| 3915-3947 | 1 | 33 | CHARTER_BASELINE_BYTES, CHARTER_CEILINGS, CHARTER_SOURCE_BUDGET, CHARTER_SOURCE_TOTAL_BUDGET, charterFileBytes, compiledCharterBytes | — |
| 5409-5428, 5430-5442 | 2 | 33 | resolveSeatModels | — |
| 5623-5629, 5631-5638, 5662-5671, 5673-5679 | 4 | 32 | assertBandFloors, loadLadder | — |
| 2686-2717 | 1 | 32 | BOOLEAN_FLAGS, BOOT_ONLY_FLAGS, KNOWN_FLAGS, REQUIRED_FLAGS, ROLE_FLAG_PREFIXES, UsageError +1 | — |
| 5590-5621 | 1 | 32 | loadLadder | — |
| 4007-4037 | 1 | 31 | CHARTER_CEILINGS, bootCmd | — |
| 5241-5270 | 1 | 30 | bootCmd, writeRosterSnapshot | — |
| 635-663 | 1 | 29 | awaitSeatsReady, bootCmd | — |
| 5034-5041, 5043-5048, 5050-5062 | 3 | 27 | normalizeRoster, resolveTier | — |
| 2768-2794 | 1 | 27 | TIMEOUT_S_DEFAULT, TIMEOUT_S_REFUSAL, resolveTimeoutS | — |
| 4057-4082 | 1 | 26 | MEMORY_ROLES, bootCmd | — |
| 6757-6782 | 1 | 26 | resolveAdapters, resolveSeatModels | — |
| 5521-5545 | 1 | 25 | grantedDefModels | — |
| 7172-7195 | 1 | 24 | ADVISOR_CONFIG_VERSION, advisorBootRecord, advisorEndpointOrigin, advisorJournalRecord | — |
| 3962-3985 | 1 | 24 | CHARTER_BUDGET_REFUSAL, CHARTER_CEILINGS, CHARTER_SOURCE_BUDGET, CHARTER_UNMEASURED_CAUSES, assertCharterBudgets, charterBudgetRefusals +3 | — |
| 5077-5099 | 1 | 23 | resolveTier, rosterSeating | — |
| 1658-1680 | 1 | 23 | resolveValidationLane | — |
| 6726-6748 | 1 | 23 | SEAT_DEFAULTS, resolveAdapters | — |
| 6232-6241, 6243-6253 | 2 | 21 | phaseForStage | — |
| 5358-5365, 7244-7256 | 2 | 21 | shadowCandidates | — |
| 4441-4461 | 1 | 21 | TEARDOWN_ABSENT_CAUSES, teardownCore | — |
| 309-314, 316-329 | 2 | 20 | DEFAULT_ROLES, composeLayout | — |
| 738-744, 746-752, 754-759 | 3 | 20 | seatTransport | — |
| 3987-4005 | 1 | 19 | CHARTER_CEILINGS, CHARTER_UNMEASURED_CAUSES, charterBytesRecord | — |
| 586-603 | 1 | 18 | EMPTY_GRANTS, mcpConfigDocument | — |
| 616-633 | 1 | 18 | EMPTY_GRANTS | — |
| 5153-5170 | 1 | 18 | loadRoster, resolveTier | — |
| 5134-5151 | 1 | 18 | normalizeRoster | — |
| 4323-4340 | 1 | 18 | RUN_START_EVENT, assignmentsFromJournal | — |
| 847-857, 1382-1387 | 2 | 17 | bootAllocation | — |
| 7321-7337 | 1 | 17 | loadLadder, resolveTier, shadowPick | — |
| 5367-5383 | 1 | 17 | normalizeRoster, resolveTier, serializeRosterV1, serializeRosterV2 | — |
| 7380-7396 | 1 | 17 | SHADOW_ABSENT, loadCapabilities, loadLadder, shadowPickBoot | — |
| 3402-3418 | 1 | 17 | VALIDATION_LANE_REFUSAL, runCmd | — |
| 6897-6912 | 1 | 16 | grantsFor | — |
| 214-229 | 1 | 16 | parkOnOutcome, parkSeats | — |
| 7442-7457 | 1 | 16 | readBranch | — |
| 6921-6936 | 1 | 16 | ROLE_ORDER, SEAT_DEFAULTS, loadCapabilities, resolveAdapters, resolveTier | — |
| 7471-7486 | 1 | 16 | RUN_START_EVENT, stagesFromJournal | — |
| 1487-1501 | 1 | 15 | aliasDeprecationLines, resolveRunConfig | — |
| 761-767, 4865-4872 | 2 | 15 | assertCapabilities | — |
| 5689-5703 | 1 | 15 | BAND_FLOOR_REFUSALS, assertBandFloors | — |
| 5560-5574 | 1 | 15 | BAND_FLOOR_REFUSALS, assertDefBandFloors, loadLadder | — |
| 7398-7412 | 1 | 15 | loadCapabilities, loadLadder, shadowPickBoot | — |
| 472-486 | 1 | 15 | SEAT_DEFAULTS, loadCapabilities | — |
| 5178-5191 | 1 | 14 | loadRosterSource | — |
| 7054-7067 | 1 | 14 | SEAT_DEFAULTS, grantsFor | — |
| 7339-7352 | 1 | 14 | SHADOW_ABSENT, loadLadder, shadowPick | — |
| 5648-5660 | 1 | 13 | assertBandFloors, bandForMember, bandForRaw, loadLadder, seatBand, seatModelKey | — |
| 5576-5588 | 1 | 13 | LADDER_PATH, loadLadder | — |
| 6150-6162 | 1 | 13 | LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, waitForEnvelope | — |
| 5201-5213 | 1 | 13 | rosterSnapshotReader | — |
| 7148-7159 | 1 | 12 | ADVISOR_BOOT_REFUSALS, ADVISOR_CONFIG_VERSION, SAFE_MODEL, advisorManifest, assertAdvisorManifest, classifyAdvisorCell | — |
| 5547-5558 | 1 | 12 | assertDefBandFloors, grantedDefModels, loadLadder | — |
| 6208-6212, 6214-6220 | 2 | 12 | assertSeats | — |
| 5272-5283 | 1 | 12 | BAND_FLOOR_REFUSALS, assertBandFloors, loadLadder | — |
| 3949-3960 | 1 | 12 | CHARTER_BASELINE_BYTES, CHARTER_CEILINGS, CHARTER_SOURCE_BUDGET, assertCharterBudgets, charterBudgetRefusals, charterFileBytes +2 | — |
| 5989-6000 | 1 | 12 | LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, WAIT_POLL_MS, waitForEnvelope | — |
| 4277-4288 | 1 | 12 | TEARDOWN_DRAIN_ERROR_MS, TEARDOWN_DRAIN_MS | — |
| 1882-1892 | 1 | 11 | BATCH_DIR_NOT_BATCHED, batchDirFromBrief | — |
| 302-307, 6222-6226 | 2 | 11 | composeLayout | — |
| 331-341 | 1 | 11 | DEFAULT_ROLES, SEAT_DEFAULTS | — |
| 7368-7378 | 1 | 11 | shadowPick | — |
| 4463-4473 | 1 | 11 | TEARDOWN_ABSENT_CAUSES, teardownAbsentCause | — |
| 7459-7469 | 1 | 11 | teardownDecision | — |
| 2633-2642 | 1 | 10 | assertUsage, resolveValidationLane | — |
| 7161-7170 | 1 | 10 | classifyAdvisorCell | — |
| 1371-1380 | 1 | 10 | descendantRefusal | — |
| 274-283 | 1 | 10 | escalationAttention | — |
| 203-212 | 1 | 10 | parkSeats | — |
| 1513-1522 | 1 | 10 | persistedRunConfig | — |
| 867-876 | 1 | 10 | resolveAdapters, resolveTier | — |
| 5123-5132 | 1 | 10 | ROSTER_REFUSALS, ROSTER_SCHEMA_VERSIONS, refuseRoster | — |
| 1423-1432 | 1 | 10 | RUN_CONFIG_DECLARATIONS | — |
| 7028-7037 | 1 | 10 | SEAT_DEFAULTS, effectiveTools, grantsFor, loadCapabilities | — |
| 4312-4321 | 1 | 10 | TEARDOWN_ABSENT_CAUSES | — |
| 3436-3445 | 1 | 10 | VALIDATION_LANE_REFUSAL, assertCtxSources | — |
| 5705-5713 | 1 | 9 | assertBandFloors, loadLadder, resolveTier, seatModelKey | — |
| 4978-4986 | 1 | 9 | FALLBACK_REFUSALS, refuseFallback | — |
| 1503-1511 | 1 | 9 | FLAG_VALUE_CONTRACT, assertUsage | — |
| 7432-7440 | 1 | 9 | readHead | — |
| 884-892 | 1 | 9 | resolveWorkerBin | — |
| 4781-4789 | 1 | 9 | seatLiveness | — |
| 5822-5829 | 1 | 8 | seatReadySignal | — |
| 5640-5646 | 1 | 7 | assertBandFloors, loadLadder, resolveTier | — |
| 724-730 | 1 | 7 | transportFor | — |
| 5193-5199 | 1 | 7 | writeRosterSnapshot | — |
| 3039-3044 | 1 | 6 | installRunFinalizers | — |
| 6914-6919 | 1 | 6 | probeLocalEndpoint | — |
| 2802-2807 | 1 | 6 | runExitCode | — |
| 7258-7263 | 1 | 6 | SHADOW_EXCLUSIONS, SHADOW_OUTCOMES, shadowExclusion | — |
| 732-736 | 1 | 5 | HEADLESS_TRANSPORTS, seatTransport | — |
| 3909-3913 | 1 | 5 | memoryConfig | — |
| 5172-5176 | 1 | 5 | rosterSourcePath | — |
| 2796-2800 | 1 | 5 | RUN_EXIT_CODES, RUN_EXIT_UNEXPECTED, runExitCode | — |
| 5215-5218 | 1 | 4 | assertUsage | — |
| 5766-5769 | 1 | 4 | BAND_FLOOR_REFUSALS, refuseBandFloor | — |
| 1366-1369 | 1 | 4 | BOOT_DESCENDANT_REFUSALS, refuseStaleDescendants | — |
| 4927-4930 | 1 | 4 | docOpenArgs | — |
| 6228-6230 | 1 | 3 | ROLE_ORDER, SEAT_DEFAULTS | — |

**Denominators:** 314 files scanned · 151 symbols clustered · 266 edges counted · skipped: []

## `test/factory-dispatch-batch.test.mjs`

6,319 lines · test · **118 clusters** · **123 cross-cluster edges** of 169 counted · 0 anchor pins across 0 manifests · 0 tests reaching · protected floor: no

| cluster line spans | blocks | lines | symbols | importers |
|---|---|---|---|---|
| 1171-1175, 1332-1344, 1346-1371, 2831-2856 +61 more | 65 | 1086 | _(none — symbol-less)_ | — |
| 461-490, 492-522, 552-559, 630-642 +25 more | 29 | 618 | checkFences | — |
| 1430-1443, 1512-1522, 3553-3580, 5336-5359 +9 more | 13 | 210 | BatchRefusal | — |
| 3741-3757, 3970-3982, 3984-3987, 4905-4925 +8 more | 12 | 146 | parseCliArgs | — |
| 4277-4308, 4310-4344, 4346-4379, 4577-4615 | 4 | 140 | compileLane | — |
| 4927-4942, 4944-4957, 4959-4971, 4973-4988 +4 more | 8 | 116 | resolveAdoptions | — |
| 4076-4089, 4091-4109, 4111-4127, 4129-4143 +1 more | 5 | 93 | dispatchBatch | — |
| 2911-2931, 2933-2999 | 2 | 88 | REQUEST_SUFFIX, dispatchBatch | — |
| 788-832, 1209-1249 | 2 | 86 | FENCE_REPORT_FILE, checkFences, dispatchBatch | — |
| 5068-5082, 5084-5109, 5111-5133, 5135-5153 | 4 | 83 | applyAdoption | — |
| 892-902, 904-915, 918-931, 958-984 +1 more | 5 | 73 | collectTestReach, testsOutsideFence | — |
| 2180-2192, 2194-2199, 2201-2209, 3811-3828 +3 more | 7 | 71 | readBatch | — |
| 4478-4501, 4503-4526, 4528-4549 | 3 | 70 | BatchRefusal, compileLane | — |
| 4008-4074 | 1 | 67 | EXTERNAL_FENCE_PREFIX, EXTERNAL_REGISTER_NAME, main | — |
| 834-866, 1106-1136 | 2 | 64 | FENCE_REPORT_FILE, checkFences, collectTestReach, testsOutsideFence | — |
| 986-1044 | 1 | 59 | TEST_REACH_OVERRIDE_PREFIX, collectTestReach, reachRefusalRows, testsOutsideFence | — |
| 2300-2321, 5361-5395 | 2 | 57 | BatchRefusal, dispatchBatch | — |
| 2211-2219, 3857-3864, 3884-3891, 5417-5425 +1 more | 5 | 51 | BatchRefusal, readBatch | — |
| 3278-3322 | 1 | 45 | TURN_CENSUS_FLAG, parseCliArgs | — |
| 868-890, 1084-1104 | 2 | 44 | FENCE_REPORT_FILE, checkFences | — |
| 5916-5941, 5943-5958 | 2 | 42 | BatchRefusal, seatFloorRefusal | — |
| 6041-6082 | 1 | 42 | teardownVerdict | — |
| 588-628 | 1 | 41 | EXTERNAL_FENCE_PREFIX, checkFences | — |
| 2762-2771, 2773-2782, 2810-2817, 2819-2829 | 4 | 39 | promptSurfaceVerdict, reconcileTier | — |
| 3212-3249 | 1 | 38 | formatTurnBudgetReport, readTurnCensus, turnBudgetReport | — |
| 1967-2001 | 1 | 35 | CROSS_BATCH_UNKNOWN_PREFIX, dispatchBatch | — |
| 709-741 | 1 | 33 | WARNING_ROWS_UNPERSISTED_PREFIX, checkFences | — |
| 1934-1965 | 1 | 32 | TEST_REACH_WARNING_PREFIX, checkFences | — |
| 376-388, 390-407 | 2 | 31 | readRegister | — |
| 1177-1207 | 1 | 31 | TEST_REACH_REFUSAL_BLIND_SPOT, TEST_REACH_REFUSAL_REMEDY, dispatchBatch | — |
| 2094-2103, 2105-2125 | 2 | 31 | TEST_REACH_ROW_LIMIT | — |
| 2437-2466 | 1 | 30 | ANCHOR_PIN_POST_MERGE, ANCHOR_PIN_WARNING_PREFIX, dispatchBatch | — |
| 2149-2178 | 1 | 30 | CITATION_CARRIER_ROW_LIMIT, FENCE_REPORT_FILE, TEST_REACH_ROW_LIMIT, checkFences | — |
| 2003-2032 | 1 | 30 | FENCE_REPORT_FILE, dispatchBatch | — |
| 1524-1553 | 1 | 30 | FENCE_REPORT_FILE, TEST_REACH_OVERRIDE_PREFIX | — |
| 1481-1510 | 1 | 30 | FENCE_REPORT_FILE, TEST_REACH_WARNING_PREFIX | — |
| 2712-2740 | 1 | 29 | checkArrival | — |
| 2881-2909 | 1 | 29 | COUPLED_SOURCE_UNFENCED, STALE_READ_ACK, readsFromRefusal | — |
| 1737-1765 | 1 | 29 | CROSS_BATCH_BLIND_SPOT, CROSS_BATCH_UNKNOWN_PREFIX, checkFences | — |
| 2221-2232, 2248-2259, 5461-5465 | 3 | 29 | planWaves | — |
| 5792-5819 | 1 | 28 | batchSeatsFrom, mergeSeats, seatChain, seatFlagArgs, seatFromSpec, seatSpec +1 | — |
| 1445-1472 | 1 | 28 | collectTestReach, reachRefusalRows, surfaceExportsOf | — |
| 5662-5679, 6138-6147 | 2 | 28 | DRY_RUN_BLIND_SPOT | — |
| 2278-2287, 2682-2698 | 2 | 27 | BatchRefusal, checkFences | — |
| 524-550 | 1 | 27 | checkFences, externalFenceLiveness | — |
| 6203-6213, 6217-6226, 6230-6235 | 3 | 27 | citationCarriers, citationCarriersOutsideFence, collectAnchorPins | — |
| 4191-4217 | 1 | 27 | PLANNER_SYMBOLS_ARM_EVENT, PLANNER_SYMBOLS_EXPERIMENT | — |
| 1046-1061, 1073-1082 | 2 | 26 | collectTestReach, reachRefusalRows, testsOutsideFence | — |
| 1588-1597, 5742-5757 | 2 | 26 | DISPATCH_ONLY_REQUEST_KEYS, TEST_REACH_OVERRIDE_KEY, readBatch | — |
| 4855-4879 | 1 | 25 | ADOPT_EVENT, LINEAGE_SOURCES, lineageBaseline | — |
| 4551-4575 | 1 | 25 | crewJsonPath | — |
| 561-575, 577-586 | 2 | 25 | crossBatchCollisions | — |
| 3251-3266, 3268-3276 | 2 | 25 | formatTurnBudgetReport, turnBudgetReport | — |
| 2643-2667 | 1 | 25 | ROLES_ANCHOR_COMPANIONS, ROLES_ANCHOR_MANIFEST, checkFences | — |
| 933-956 | 1 | 24 | BatchRefusal, TEST_REACH_OVERRIDE_KEY, isTestReachOverride, readBatch | — |
| 5703-5726 | 1 | 24 | crewJsonPath, laneOutcome | — |
| 429-452 | 1 | 24 | externalFenceLiveness | — |
| 4881-4903 | 1 | 23 | ADOPT_EVENT, applyAdoption, resolveAdoptions | — |
| 3759-3781 | 1 | 23 | BOOT_TRANSPORT, bootCommand, parseCliArgs, resolveRequestedTier | — |
| 1373-1395 | 1 | 23 | checkFences, crossBatchCollisions | — |
| 2596-2618 | 1 | 23 | checkMachineryBudget | — |
| 6279-6301 | 1 | 23 | CITATION_CARRIER_BLIND_SPOT, CITATION_CARRIER_POST_MERGE, CITATION_CARRIER_WARNING_PREFIX, checkFences | — |
| 352-374 | 1 | 23 | EXTERNAL_REGISTER_NAME, readRegister | — |
| 5438-5459 | 1 | 22 | BatchRefusal, checkFences, planWaves | — |
| 6239-6248, 6254-6265 | 2 | 22 | citationCarriers, collectAnchorPins | — |
| 1555-1575 | 1 | 21 | ANCHOR_BLIND_SPOT, CITATION_CARRIER_BLIND_SPOT, CROSS_BATCH_BLIND_SPOT, FENCE_REPORT_FILE, TEST_REACH_BLIND_SPOT, TEST_REACH_WARNING_PREFIX | — |
| 2127-2147 | 1 | 21 | FENCE_REPORT_FILE, TEST_REACH_ROW_LIMIT | — |
| 2620-2628, 2630-2641 | 2 | 21 | ROLES_ANCHOR_MANIFEST, collectAnchorPins | — |
| 3948-3968 | 1 | 21 | ROSTER_PATH | — |
| 4145-4164 | 1 | 20 | BatchRefusal, parsePlannerSymbolsHoldoutFraction, selectPlannerSymbolsArm | — |
| 2034-2053 | 1 | 20 | SYMBOL_FANOUT_LIMIT | — |
| 409-427 | 1 | 19 | externalCrewDir, externalFenceLiveness | — |
| 2742-2760 | 1 | 19 | reconcileTier, tierFloor | — |
| 1138-1155 | 1 | 18 | BatchRefusal, FENCE_REPORT_FILE, checkFences | — |
| 2234-2246, 5467-5471 | 2 | 18 | BatchRefusal, planWaves | — |
| 1411-1428 | 1 | 18 | BatchRefusal, REFUSAL_REASONS, TEST_REACH_REFUSAL_BLIND_SPOT, TEST_REACH_REFUSAL_REMEDY | — |
| 743-760 | 1 | 18 | FENCE_REPORT_FILE, WARNING_ROWS_UNPERSISTED_PREFIX, checkFences | — |
| 3989-4006 | 1 | 18 | main | — |
| 2323-2339 | 1 | 17 | checkFences, planWaves | — |
| 5190-5205 | 1 | 16 | ADOPT_BLOCK, BatchRefusal, applyAdoption, checkPlanScope | — |
| 5899-5914 | 1 | 16 | BatchRefusal, ROSTER_PATH, seatRolesUnseated | — |
| 5025-5040 | 1 | 16 | lineageLine, parseCliArgs, resolveAdoptions | — |
| 2794-2808 | 1 | 15 | reconcileTier | — |
| 1599-1613 | 1 | 15 | TEST_REACH_DEPTH, collectTestReach | — |
| 3196-3210 | 1 | 15 | TURN_CENSUS_FLAG | — |
| 2395-2408 | 1 | 14 | ANCHOR_PIN_POST_MERGE, checkFences | — |
| 3842-3855 | 1 | 14 | batchAliasWarnings | — |
| 2485-2497 | 1 | 13 | ANCHOR_PIN_WARNING_PREFIX, checkFences | — |
| 5728-5740 | 1 | 13 | baseContains | — |
| 1397-1409 | 1 | 13 | REFUSAL_REASONS, TEST_REACH_BLIND_SPOT, TEST_REACH_DEPTH | — |
| 2867-2879 | 1 | 13 | REFUSAL_REASONS | — |
| 2583-2594 | 1 | 12 | checkPlanScope | — |
| 2669-2680 | 1 | 12 | collectAnchorPins | — |
| 4836-4847 | 1 | 12 | parseCliArgs, resolveAdoptions | — |
| 1615-1626 | 1 | 12 | REFUSAL_REASONS, checkFences | — |
| 2425-2435 | 1 | 11 | ANCHOR_BLIND_SPOT, checkFences | — |
| 2700-2710 | 1 | 11 | checkArrival, crewJsonPath | — |
| 1157-1167 | 1 | 11 | collectTestReach, reachRefusalRows, surfaceExportsOf, testsOutsideFence | — |
| 1577-1586 | 1 | 10 | BatchRefusal, TEST_REACH_OVERRIDE_KEY, readBatch | — |
| 2261-2270 | 1 | 10 | planWorktrees | — |
| 2573-2581 | 1 | 9 | BatchRefusal, checkPlanScope | — |
| 2784-2792 | 1 | 9 | PROMPT_SURFACE | — |
| 3462-3469 | 1 | 8 | baselineCacheRoot, factoryStateRoot | — |
| 5408-5415 | 1 | 8 | checkDirectedBrief | — |
| 2858-2865 | 1 | 8 | PROMPT_SURFACE_BLIND_SPOT, reconcileTier | — |
| 3733-3739 | 1 | 7 | BOOT_TRANSPORT, ROSTER_PATH, bootCommand | — |
| 5523-5528 | 1 | 6 | BOOT_TRANSPORT | — |
| 454-459 | 1 | 6 | externalLaneReason | — |
| 1474-1479 | 1 | 6 | reachRefusalRows | — |
| 4849-4853 | 1 | 5 | adoptSourceDir | — |
| 6175-6179 | 1 | 5 | BAND_FLOOR_REASONS, SEAT_FIELDS | — |
| 5517-5521 | 1 | 5 | BOOT_TRANSPORT, PANE_TRANSPORT, resolveTransport | — |
| 4266-4270 | 1 | 5 | briefMeasure | — |
| 6270-6274 | 1 | 5 | CITATION_CARRIER_BLIND_SPOT | — |
| 5578-5581 | 1 | 4 | mergeCheckLine | — |
| 4711-4714 | 1 | 4 | MISCLASSIFIED_PREFIX | — |
| 4272-4275 | 1 | 4 | normalDeps | — |
| 3806-3809 | 1 | 4 | parseCliArgs, resolveRequestedExecution | — |

**Denominators:** 314 files scanned · 107 symbols clustered · 169 edges counted · skipped: []

## `test/factory-ledger.test.mjs`

7,389 lines · test · **14 clusters** · **2 cross-cluster edges** of 10 counted · 3 anchor pins across 1 manifests · 0 tests reaching · protected floor: no

| cluster line spans | blocks | lines | symbols | importers |
|---|---|---|---|---|
| 139-139, 160-160, 185-208, 210-237 +315 more | 319 | 853 | _(none — symbol-less)_ | — |
| 541-557, 559-565, 567-572, 574-577 +5 more | 9 | 87 | escalationCause | — |
| 474-539 | 1 | 66 | ESCALATION_CAUSES, escalationCause | — |
| 7028-7039, 7054-7070, 7072-7080 | 3 | 38 | CELL_RATE_FLOOR | — |
| 5454-5471 | 1 | 18 | ESCALATION_CAUSES | — |
| 7010-7026 | 1 | 17 | openLedger | — |
| 5947-5958 | 1 | 12 | ADVISOR_AB_INCOMPLETE_REASONS | — |
| 5960-5971 | 1 | 12 | TABLES, UPDATE_ONLY_WRITERS, WRITERS, WRITER_MIRROR_TABLES | — |
| 7095-7105 | 1 | 11 | CELL_RATE_FLOOR, TURN_TRANSPORTS | — |
| 385-394 | 1 | 10 | mkdirpBounded | — |
| 695-700 | 1 | 6 | isoMs | — |
| 1176-1180 | 1 | 5 | CELL_FAILURE_ATTRIBUTIONS, CELL_FAILURE_KINDS | — |
| 6716-6719 | 1 | 4 | MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS | — |
| 1498-1500 | 1 | 3 | MODIFIER_ATTEMPT_OUTCOMES | — |

**Denominators:** 314 files scanned · 17 symbols clustered · 10 edges counted · skipped: []

## Blind spots, from the instrument itself

- Static imports are a proxy: computed imports can be invisible, and unused imports can create phantom edges. Clean clusters measure split cost; they do not decide whether a split is right.
- Stage-head attribution is file-level static attribution, not a runtime claim.
- **Clean clusters measure how CHEAP a split is, never whether it is RIGHT.**
  Nothing in this report predicts a builder-turn saving; #1059's holdout is the
  instrument that could, and it is unbuilt.

