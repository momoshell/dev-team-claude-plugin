# Task: Adversarial defect hunt on data integrity: make the ledger, its JSONL authority, and its readers disagree, lose, or invent facts. Attack shapes, all against throwaway DEVTEAM_LEDGER_DIR databases: replay the same JSONL twice and diff row counts (idempotency claim); write JSONL lines the mirror cannot represent (unknown enum member, null in a NOT NULL seam, a 5MB payload) and check the db and the JSONL still agree on what happened; open the db mid-write from a second process (WAL) and read every query the visualizer uses — the audit found two endpoints answering different failure counts for one cell, reproduce it and find the divergence point; run every migration against a db created at each earlier schema version including one with rows that violate a later constraint; force the degraded path mid-session (delete the db under an open handle, revoke write permission) and check no JSONL line is lost and degraded surfaces true everywhere it should; two emitters writing one session concurrently; heartbeat updates racing finalization; usageWindow around DST and around the epoch edges its Date math assumes.
## The ask
Adversarial defect hunt on data integrity: make the ledger, its JSONL authority, and its readers disagree, lose, or invent facts. Attack shapes, all against throwaway DEVTEAM_LEDGER_DIR databases: replay the same JSONL twice and diff row counts (idempotency claim); write JSONL lines the mirror cannot represent (unknown enum member, null in a NOT NULL seam, a 5MB payload) and check the db and the JSONL still agree on what happened; open the db mid-write from a second process (WAL) and read every query the visualizer uses — the audit found two endpoints answering different failure counts for one cell, reproduce it and find the divergence point; run every migration against a db created at each earlier schema version including one with rows that violate a later constraint; force the degraded path mid-session (delete the db under an open handle, revoke write permission) and check no JSONL line is lost and degraded surfaces true everywhere it should; two emitters writing one session concurrently; heartbeat updates racing finalization; usageWindow around DST and around the epoch edges its Date math assumes.
## Proposed tier
PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms
or overrides this at boot; the compiler never decides the tier.
proposed tier: judge
because:
- protected paths in force: 14 · ratified profile field protected_paths_candidates (3 entries) added to the authored floor · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
- scope breadth: 6 source files named by where (≥5 → judge)
- tripwire tests pinning that scope: 40
- protected-path hits: none
proposed shape: mechanical
because (risk signals):
- risk signal · protected-path hits: none — shape mechanical
proposed strength: frontier
because (complexity signals):
- complexity signal · scope breadth: 6 source file(s) named by where
- complexity signal · tripwire tests pinning that scope: 40
- complexity signal · directory where: none
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
verified · file · scripts/factory/transcript.mjs
verified · file · visualizer/server/ledger-feed.mjs
verified · file · visualizer/server/shape.mjs
verified · file · crew/daemon.mjs
## Done means
Every defect carries: (1) a REPRODUCTION — a self-contained program or command sequence, written into the task dir, that demonstrates the misbehaviour against a scratch copy of the repo (git archive HEAD into a temp dir, or a throwaway DEVTEAM_LEDGER_DIR / state dir), never against the checkout — the driver mechanically refuses a scout that changes a file; (2) observed versus expected, with the exact output pasted; (3) a severity call: corrupts-state / wrong-answer / hangs-or-leaks / refuses-wrongly / cosmetic; (4) the guard that SHOULD have caught it (a test, a refusal, a schema) and why it did not. A suspicion you could not reproduce goes in a separate SUSPICIONS section with what you tried — it is not a finding. Negative results are first-class: list every attack you ran that the code survived, so the next hunt does not re-run it. Findings ranked by severity. State which files you read in full.
## Tripwires
candidates: crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/converge.test.mjs, crew/crew.test.mjs, crew/daemon.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/seat-io-runclean.test.mjs, scripts/factory/emit.mjs, scripts/factory/ledger.mjs, scripts/factory/transcript.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit-floor.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs
tripwire tests:
- crew/adapter-pi.test.mjs · ROLE_ORDER
- crew/arms.test.mjs · crew.json, ledger.db, openLedger
- crew/breaker.test.mjs · 24.0.0, NODE_FLOOR, boot-refusal, ledger.db, openLedger, seat-not-ready
- crew/converge.test.mjs · plan:r1
- crew/crew.test.mjs · EVENT_TYPES, NODE_FLOOR, PAYLOAD_KEYS, ROLE_ORDER, USAGE_ABSENT_CAUSES, _resetNoticeGuardsForTest, boot-refusal, child.mjs, crew.json, crew/daemon.mjs, daemon.mjs, emit.mjs, failure-upgrade, ledger.db, openLedger, openRun, paneSeat, plan:r1, recordCellFailure, run.json, scripts/factory/emit.mjs, seat-died
- crew/daemon.test.mjs · ./escalation-policy.mjs, ./headless-rpc.mjs, ./slug.mjs, ./variants.mjs, 24.0.0, DAEMON_COMMANDS, DEFAULT_BUDGET_WINDOW_MS, DEFAULT_CONCURRENCY, EVENT_KINDS, LEDGER_NODE_FLOOR, NODE_FLOOR, PANE_TRANSPORT, RUN_STATES, child.mjs, crew.json, crew/daemon.mjs, daemon.mjs, deriveState, emit.mjs, escalation-policy.mjs, headless-rpc.mjs, invalid-spec, ledger.db, ledger.jsonl, node:module, node:net, normalizeEvent, not-capable, openLedger, openRun, plan:r1, run.json, scopeEntryDefects, scripts/factory/emit.mjs, slug.mjs, terminal-result, tool-call, usageWindow, variants.mjs
- crew/drive.test.mjs · ./escalation-policy.mjs, ./variants.mjs, agent-change, child.mjs, crew.json, crew/daemon.mjs, daemon.mjs, escalation-policy.mjs, failure-upgrade, ledger.db, no-envelope, no-tier, plan:r1, sensitivity-floor, unusable-envelope, variants.mjs
- crew/escalation-policy.test.mjs · ./escalation-policy.mjs, child.mjs, crew/daemon.mjs, daemon.mjs, escalation-policy.mjs, usageWindow
- crew/factoryctl.test.mjs · crew.json, daemon.mjs, invalid-spec, terminal-result
- crew/harvest.test.mjs · crew.json
- crew/headless-rpc.test.mjs · ./headless-rpc.mjs, headless-rpc.mjs, no-envelope
- crew/headless.test.mjs · no-envelope
- crew/io-contract.test.mjs · ./headless-rpc.mjs, agent-change, crew.json, headless-rpc.mjs, no-envelope, no-tier, seat-died, sensitivity-floor, unusable-envelope
- crew/pi/extensions/lab.test.mjs · node:net
- crew/pi/extensions/subagent.test.mjs · ./headless-rpc.mjs, headless-rpc.mjs
- crew/reclaim-descendants.test.mjs · child.mjs, ledger.db, openLedger
- crew/reclaim.test.mjs · node:crypto
- crew/seat-io-runclean.test.mjs · no-envelope, recordCellFailure, seat-died, unusable-envelope
- skills/crew-dispatch/cli-contract.test.mjs · variants.mjs
- skills/devops/exhibits.test.mjs · DAEMON_COMMANDS, crew/daemon.mjs, daemon.mjs
- test/factory-ci-repair.test.mjs · ./ledger.mjs, NODE_FLOOR, crew.json, emit.mjs, ledger.db, node:module, openLedger
- test/factory-ci-watch.test.mjs · ./ledger.mjs, NODE_FLOOR, emit.mjs, ledger.db, node:module, openLedger, recordCiCycle, scripts/factory/emit.mjs
- test/factory-crew-watch.test.mjs · crew.json, node:crypto, plan:r1
- test/factory-emit-floor.test.mjs · emit.mjs, ledger.db, ledger.jsonl, openLedger, openRun, scripts/factory/emit.mjs
- test/factory-emit.test.mjs · 24.0.0, NODE_FLOOR, PAYLOAD_KEYS, _resetNoticeGuardsForTest, boot-refusal, emit.mjs, ledger.db, ledger.jsonl, node:module, openLedger, openRun, recordCellFailure, run.json, run.lock, scripts/factory/emit.mjs
- test/factory-env.test.mjs · NODE_FLOOR, child.mjs, crew/daemon.mjs, daemon.mjs, defaultDbPath, emit.mjs, openLedger, openRun, run-set, scripts/factory/emit.mjs
- test/factory-intake.test.mjs · ./ledger.mjs, INTAKE_DISPATCH_OUTCOMES, INTAKE_DISPATCH_VERDICTS, INTAKE_OUTCOMES, INTAKE_REFUSALS, LedgerUsageError, PREMISE_VERDICTS, brief-uncompilable, crew.json, daemon.mjs, intake-block-malformed, intake-block-missing, ledger.db, not-first-in-order, openLedger, priority-unknown, rate-limit-floor, repeat-escalation, run.json, stop-switch, tier-judge, window-cap
- test/factory-lane-watch.test.mjs · crew.json, plan:r1
- test/factory-ledger-floor.test.mjs · EVENT_TYPES, LedgerUsageError, NODE_FLOOR, WRITERS, isLockedError, ledger.db, ledger.jsonl, openLedger
- test/factory-ledger.test.mjs · ADVISOR_AB_INCOMPLETE_REASONS, CELL_FAILURE_ATTRIBUTIONS, CELL_FAILURE_KINDS, CELL_PRICE_UNITS, CELL_RATE_FLOOR, DRIFT_REMEDY, GATE_DISCRIMINATION_VERDICTS, INTAKE_DISPATCH_OUTCOMES, LedgerUsageError, MIGRATIONS, MODIFIER_ATTEMPT_OUTCOMES, MODIFIER_KINDS, NODE_FLOOR, REQUEST_MAX_CHARS, RETIRED_TABLES, REVIEW_VERDICTS, RUN_VARIANTS, RUN_VARIANT_MARKERS, SEAT_TEARDOWN_OUTCOMES, SESSION_STATUSES, STAGE_MARKER_CHUNK, TABLES, TERM_TO_KILL_MS, UPDATE_ONLY_WRITERS, USAGE_ABSENT_CAUSES, WRITERS, WRITER_MIRROR_TABLES, _resetNoticeGuardsForTest, applyMigrations, boot-refusal, budget-ceiling, child.mjs, crew.json, emit.mjs, failure-upgrade, isoMs, ledger.db, ledger.jsonl, mkdirpBounded, node:module, not-first-in-order, openLedger, openRun, parseProposalBrief, plan:r1, recordCellFailure, recordCiCycle, recordCiDispatch, replayJsonl, run-set, scripts/factory/emit.mjs, seat-died, sensitivity-floor, usageAbsentCause, variantFromFirstMessage, vendor-diversity
- test/factory-make-brief.test.mjs · PROPOSAL_BLOCK, PROPOSAL_KEYS, child.mjs, emit.mjs, node:crypto, scripts/factory/emit.mjs
- test/factory-transcript.test.mjs · KNOWN_TOOL_NAMES, isoMs, message.id, readToolCalls, readUsage, resolveTranscript, scripts/factory/transcript.mjs, transcript.mjs, triage.mjs
- test/fixtures.mjs · slug.mjs
- test/fixtures.test.mjs · slug.mjs
- test/visualizer-panels.test.mjs · ROLE_ORDER, boot-refusal, brief-uncompilable, intake-block-malformed, intake-block-missing, ledger-feed.mjs, not-first-in-order, priority-unknown, rate-limit-floor, shape.mjs, stop-switch, tier-judge, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs, window-cap
- test/visualizer-returns.test.mjs · node:crypto, run.json
- test/visualizer-roster-edit.test.mjs · ROLE_ORDER
- test/visualizer-server.test.mjs · NODE_FLOOR, WRITERS, boot-refusal, createLedgerFeed, intake-block-missing, ledger-feed.mjs, ledger.db, no-envelope, node:crypto, node:module, node:net, openLedger, recordCellFailure, replayJsonl, run-set, run.json, seat-died, shape.mjs, shapeIntake, stop-switch, tier-judge, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs
- test/visualizer-shape.test.mjs · INTAKE_REFUSALS, INTAKE_REFUSAL_REASONS, INTAKE_WINDOW_MS, NODE_FLOOR, ROLE_ORDER, RUN_SET_WINDOW_MS, boot-refusal, brief-uncompilable, defaultCellWindow, defaultIntakeWindow, defaultRunSetWindow, foldAgents, intake-block-malformed, intake-block-missing, laneFor, ledger-feed.mjs, ledger.db, matchesFilters, no-envelope, node:module, not-first-in-order, openLedger, priority-unknown, rate-limit-floor, repeat-escalation, run-set, shape.mjs, shapeCellHealth, shapeGateChecks, shapeIntake, shapeRun, shapeRunSet, stop-switch, tier-judge, triage.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs, window-cap, withCells
- test/visualizer-teardown.test.mjs · NODE_FLOOR, SEAT_TEARDOWN_OUTCOMES, createLedgerFeed, defaultTeardownWindow, ledger-feed.mjs, ledger.db, node:module, openLedger, shape.mjs, shapeSeatTeardowns, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs
broad keys (not used as tripwires):
- crew.mjs · 57 hits
- daemon · 48 hits
- ledger.mjs · 53 hits
- main · 160 hits
- node:fs · 89 hits
- node:os · 54 hits
- node:path · 87 hits
- node:url · 40 hits
- protected-path · 31 hits
- scripts/factory/ledger.mjs · 46 hits
- tech-lead · 31 hits
declare every hit: grep -rn "./escalation-policy.mjs\|./headless-rpc.mjs\|./ledger.mjs\|./shape.mjs\|./slug.mjs\|./triage.mjs\|./variants.mjs\|24.0.0\|ACCEPT_DECISION_OUTCOMES\|ADVISOR_AB_DISPATCH_FLOOR\|ADVISOR_AB_INCOMPLETE_REASONS\|ADVISOR_AB_VERDICTS\|CELL_FAILURE_ATTRIBUTIONS\|CELL_FAILURE_KINDS\|CELL_HEALTH_WINDOW_MS\|CELL_PRICE_UNITS\|CELL_RATE_FLOOR\|CI_CLASSIFICATIONS\|CI_DECISIONS\|CI_DISPATCH_OUTCOMES\|DAEMON_COMMANDS\|DEFAULT_BUDGET_WINDOW_MS\|DEFAULT_CONCURRENCY\|DRIFT_REMEDY\|EVENT_KINDS\|EVENT_TYPES\|EmitUsageError\|GATE_DISCRIMINATION_VERDICTS\|INTAKE_BRAKE_OUTCOMES\|INTAKE_BRAKE_TRANSITIONS\|INTAKE_DISPATCH_OUTCOMES\|INTAKE_DISPATCH_VERDICTS\|INTAKE_OUTCOMES\|INTAKE_REFUSALS\|INTAKE_REFUSAL_GROUPS\|INTAKE_REFUSAL_REASONS\|INTAKE_WINDOW_MS\|KNOWN_TOOL_NAMES\|LEDGER_NODE_FLOOR\|LEDGER_VERSION\|LedgerUsageError\|MIGRATIONS\|MODIFIER_ATTEMPT_OUTCOMES\|MODIFIER_KINDS\|NODE_FLOOR\|PANE_TRANSPORT\|PAYLOAD_KEYS\|PHASE_STATUSES\|PREMISE_VERDICTS\|PROCESS_STATES\|PROPOSAL_BLOCK\|PROPOSAL_KEYS\|REQUEST_MAX_CHARS\|REQUEST_SOURCES\|RETIRED_TABLES\|REVIEW_VERDICTS\|ROLE_ORDER\|RUN_SET_WINDOW_MS\|RUN_STATES\|RUN_VARIANTS\|RUN_VARIANT_MARKERS\|SEAT_TEARDOWN_OUTCOMES\|SEAT_TEARDOWN_WINDOW_MS\|SESSION_STATUSES\|SETTLED_FEED_RETENTION\|STAGE_MARKER_CHUNK\|TABLES\|TERM_TO_KILL_MS\|UPDATE_ONLY_WRITERS\|USAGE_ABSENT_CAUSES\|WRITERS\|WRITER_MIRROR_TABLES\|_resetNoticeGuardsForTest\|advisorAbNotes\|advisorAbReadout\|agent-change\|applyMigrations\|boot-refusal\|brief-uncompilable\|budget-ceiling\|child.mjs\|createLedgerFeed\|crew.json\|crew.mjs\|crew/daemon.mjs\|daemon\|daemon.mjs\|defaultCellWindow\|defaultDbPath\|defaultIntakeWindow\|defaultRunSetWindow\|defaultTeardownWindow\|deriveState\|emit.mjs\|escalation-policy.mjs\|failure-upgrade\|foldAgents\|headless-rpc.mjs\|intake-block-malformed\|intake-block-missing\|invalid-spec\|isLockedError\|isObject\|isoMs\|laneFor\|ledger-feed.mjs\|ledger.db\|ledger.jsonl\|ledger.mjs\|main\|matchesFilters\|message.id\|mkdirpBounded\|no-envelope\|no-tier\|node:crypto\|node:fs\|node:module\|node:net\|node:os\|node:path\|node:url\|normalizeEvent\|not-capable\|not-first-in-order\|not-in-window\|openLedger\|openRun\|paneSeat\|parseProposalBrief\|pendingFor\|plan:r1\|priority-unknown\|protected-path\|rate-limit-floor\|readToolCalls\|readUsage\|recordCellFailure\|recordCiCycle\|recordCiDispatch\|repeat-escalation\|replayJsonl\|resolveTranscript\|run-set\|run.json\|run.lock\|scopeEntryDefects\|scripts/factory/emit.mjs\|scripts/factory/ledger.mjs\|scripts/factory/transcript.mjs\|seat-died\|seat-not-ready\|sensitivity-floor\|shape.mjs\|shapeCellAttribution\|shapeCellHealth\|shapeGateChecks\|shapeIntake\|shapeRun\|shapeRunSet\|shapeSeatTeardowns\|slug.mjs\|stop-switch\|tech-lead\|terminal-result\|tier-judge\|tool-call\|transcript.mjs\|triage.mjs\|unusable-envelope\|usageAbsentCause\|usageWindow\|variantFromFirstMessage\|variants.mjs\|vendor-diversity\|visualizer/server/ledger-feed.mjs\|visualizer/server/shape.mjs\|window-cap\|withCells" crew/ test/ scripts/ docs/
## Coupled sources
coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.
- crew/breaker.mjs · NODE_FLOOR, openLedger · no fence in play
- crew/capabilities.mjs · crew/daemon.mjs, daemon.mjs · no fence in play
- crew/child.mjs · crew/daemon.mjs, daemon.mjs, emit.mjs, isObject, openRun, paneSeat, scripts/factory/emit.mjs · no fence in play
- crew/crew.mjs · CELL_RATE_FLOOR, USAGE_ABSENT_CAUSES, crew/daemon.mjs, daemon.mjs, emit.mjs, openLedger, openRun, paneSeat, recordCellFailure, scripts/factory/emit.mjs · no fence in play
- crew/factoryctl.mjs · crew/daemon.mjs, daemon.mjs · no fence in play
- crew/slug.mjs · daemon.mjs · no fence in play
- crew/variants.mjs · daemon.mjs · no fence in play
- scripts/factory/ci-repair.mjs · emit.mjs, openLedger, recordCiDispatch · no fence in play
- scripts/factory/ci-watch.mjs · CI_CLASSIFICATIONS, CI_DECISIONS, emit.mjs, recordCiCycle · no fence in play
- scripts/factory/intake.mjs · INTAKE_OUTCOMES, INTAKE_REFUSALS, emit.mjs, openLedger, scripts/factory/emit.mjs · no fence in play
- scripts/factory/make-brief.mjs · PROPOSAL_BLOCK, PROPOSAL_KEYS, emit.mjs, scripts/factory/emit.mjs · no fence in play
- visualizer/server/feed.mjs · createLedgerFeed, ledger-feed.mjs · no fence in play
- visualizer/server/server.mjs · RUN_SET_WINDOW_MS, defaultCellWindow, defaultIntakeWindow, defaultRunSetWindow, defaultTeardownWindow, openLedger, shape.mjs, shapeCellAttribution, shapeCellHealth, shapeIntake, shapeRun, shapeRunSet, shapeSeatTeardowns · no fence in play
- visualizer/web/src/lib/panels.js · shape.mjs · no fence in play
## Baseline
lane: npm test · pass 2171 · fail 0 · status: green
lane basis: ratified profile field test_command · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed
## Out of scope
No edits to the checkout. No speculation presented as findings. No re-litigating the 2026-08-23 audit registers (consistency/duplication/prose) — this hunt is behaviour only. Do not fix anything. Never touch ~/.dev-team/factory/ledger.db or ledger.jsonl — the real ledger is read-only evidence; every attack runs on a throwaway.
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
narrow: node --test crew/adapter-pi.test.mjs crew/arms.test.mjs crew/breaker.test.mjs crew/converge.test.mjs crew/crew.test.mjs crew/daemon.test.mjs crew/drive.test.mjs crew/escalation-policy.test.mjs crew/factoryctl.test.mjs crew/harvest.test.mjs crew/headless-rpc.test.mjs crew/headless.test.mjs crew/io-contract.test.mjs crew/pi/extensions/lab.test.mjs crew/pi/extensions/subagent.test.mjs crew/reclaim-descendants.test.mjs crew/reclaim.test.mjs crew/seat-io-runclean.test.mjs skills/crew-dispatch/cli-contract.test.mjs skills/devops/exhibits.test.mjs test/factory-ci-repair.test.mjs test/factory-ci-watch.test.mjs test/factory-crew-watch.test.mjs test/factory-emit-floor.test.mjs test/factory-emit.test.mjs test/factory-env.test.mjs test/factory-intake.test.mjs test/factory-lane-watch.test.mjs test/factory-ledger-floor.test.mjs test/factory-ledger.test.mjs test/factory-make-brief.test.mjs test/factory-transcript.test.mjs test/fixtures.mjs test/fixtures.test.mjs test/visualizer-panels.test.mjs test/visualizer-returns.test.mjs test/visualizer-roster-edit.test.mjs test/visualizer-server.test.mjs test/visualizer-shape.test.mjs test/visualizer-teardown.test.mjs
full: npm test · measured baseline pass 2171, fail 0
## Conventions
files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): crew/daemon.mjs, scripts/factory/emit.mjs, scripts/factory/ledger.mjs, scripts/factory/transcript.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs
read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/converge.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/harvest.test.mjs, crew/headless-rpc.test.mjs, crew/headless.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/reclaim.test.mjs, crew/seat-io-runclean.test.mjs, skills/crew-dispatch/cli-contract.test.mjs, skills/devops/exhibits.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-crew-watch.test.mjs, test/factory-emit-floor.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-lane-watch.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-transcript.test.mjs, test/fixtures.mjs, test/fixtures.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
conventions of record (basis: ratified profile field conventions · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json): .claude/, README.md, docs/adr/, docs/conventions.md
grep -rn "./escalation-policy.mjs\|./headless-rpc.mjs\|./ledger.mjs\|./shape.mjs\|./slug.mjs\|./triage.mjs\|./variants.mjs\|24.0.0\|ACCEPT_DECISION_OUTCOMES\|ADVISOR_AB_DISPATCH_FLOOR\|ADVISOR_AB_INCOMPLETE_REASONS\|ADVISOR_AB_VERDICTS\|CELL_FAILURE_ATTRIBUTIONS\|CELL_FAILURE_KINDS\|CELL_HEALTH_WINDOW_MS\|CELL_PRICE_UNITS\|CELL_RATE_FLOOR\|CI_CLASSIFICATIONS\|CI_DECISIONS\|CI_DISPATCH_OUTCOMES\|DAEMON_COMMANDS\|DEFAULT_BUDGET_WINDOW_MS\|DEFAULT_CONCURRENCY\|DRIFT_REMEDY\|EVENT_KINDS\|EVENT_TYPES\|EmitUsageError\|GATE_DISCRIMINATION_VERDICTS\|INTAKE_BRAKE_OUTCOMES\|INTAKE_BRAKE_TRANSITIONS\|INTAKE_DISPATCH_OUTCOMES\|INTAKE_DISPATCH_VERDICTS\|INTAKE_OUTCOMES\|INTAKE_REFUSALS\|INTAKE_REFUSAL_GROUPS\|INTAKE_REFUSAL_REASONS\|INTAKE_WINDOW_MS\|KNOWN_TOOL_NAMES\|LEDGER_NODE_FLOOR\|LEDGER_VERSION\|LedgerUsageError\|MIGRATIONS\|MODIFIER_ATTEMPT_OUTCOMES\|MODIFIER_KINDS\|NODE_FLOOR\|PANE_TRANSPORT\|PAYLOAD_KEYS\|PHASE_STATUSES\|PREMISE_VERDICTS\|PROCESS_STATES\|PROPOSAL_BLOCK\|PROPOSAL_KEYS\|REQUEST_MAX_CHARS\|REQUEST_SOURCES\|RETIRED_TABLES\|REVIEW_VERDICTS\|ROLE_ORDER\|RUN_SET_WINDOW_MS\|RUN_STATES\|RUN_VARIANTS\|RUN_VARIANT_MARKERS\|SEAT_TEARDOWN_OUTCOMES\|SEAT_TEARDOWN_WINDOW_MS\|SESSION_STATUSES\|SETTLED_FEED_RETENTION\|STAGE_MARKER_CHUNK\|TABLES\|TERM_TO_KILL_MS\|UPDATE_ONLY_WRITERS\|USAGE_ABSENT_CAUSES\|WRITERS\|WRITER_MIRROR_TABLES\|_resetNoticeGuardsForTest\|advisorAbNotes\|advisorAbReadout\|agent-change\|applyMigrations\|boot-refusal\|brief-uncompilable\|budget-ceiling\|child.mjs\|createLedgerFeed\|crew.json\|crew.mjs\|crew/daemon.mjs\|daemon\|daemon.mjs\|defaultCellWindow\|defaultDbPath\|defaultIntakeWindow\|defaultRunSetWindow\|defaultTeardownWindow\|deriveState\|emit.mjs\|escalation-policy.mjs\|failure-upgrade\|foldAgents\|headless-rpc.mjs\|intake-block-malformed\|intake-block-missing\|invalid-spec\|isLockedError\|isObject\|isoMs\|laneFor\|ledger-feed.mjs\|ledger.db\|ledger.jsonl\|ledger.mjs\|main\|matchesFilters\|message.id\|mkdirpBounded\|no-envelope\|no-tier\|node:crypto\|node:fs\|node:module\|node:net\|node:os\|node:path\|node:url\|normalizeEvent\|not-capable\|not-first-in-order\|not-in-window\|openLedger\|openRun\|paneSeat\|parseProposalBrief\|pendingFor\|plan:r1\|priority-unknown\|protected-path\|rate-limit-floor\|readToolCalls\|readUsage\|recordCellFailure\|recordCiCycle\|recordCiDispatch\|repeat-escalation\|replayJsonl\|resolveTranscript\|run-set\|run.json\|run.lock\|scopeEntryDefects\|scripts/factory/emit.mjs\|scripts/factory/ledger.mjs\|scripts/factory/transcript.mjs\|seat-died\|seat-not-ready\|sensitivity-floor\|shape.mjs\|shapeCellAttribution\|shapeCellHealth\|shapeGateChecks\|shapeIntake\|shapeRun\|shapeRunSet\|shapeSeatTeardowns\|slug.mjs\|stop-switch\|tech-lead\|terminal-result\|tier-judge\|tool-call\|transcript.mjs\|triage.mjs\|unusable-envelope\|usageAbsentCause\|usageWindow\|variantFromFirstMessage\|variants.mjs\|vendor-diversity\|visualizer/server/ledger-feed.mjs\|visualizer/server/shape.mjs\|window-cap\|withCells" crew/ test/ scripts/ docs/
- The factory scripts carry a Node ≥24 floor; follow the existing
  `scripts/factory/*` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No `Co-Authored-By` trailers.
- If interrupted, write your ReturnEnvelope first on resume — `status:
  insufficient` if incomplete. A silent seat is indistinguishable from a dead
  one.
