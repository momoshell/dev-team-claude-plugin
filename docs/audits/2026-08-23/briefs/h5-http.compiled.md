# Task: Adversarial defect hunt on the visualizer HTTP surface: run the real server on an ephemeral port against a throwaway ledger and attack every route. Attack shapes: parameter abuse on every query parameter (negative, NaN, 1e309, arrays via repeated params, since/until inversions, the historical --untill typo class where an unknown parameter silently widens the answer instead of refusing); path handling (traversal in any path-derived value, URL-encoded separators, the audit's resolve-versus-realpath symlink seam at the direct-invocation guard — demonstrate whether a symlinked cwd actually changes behaviour); protocol edges (HEAD and OPTIONS on every route, a body on a GET, oversized headers, connection dropped mid-response, two clients racing the once-fetch panels); response honesty (does any route answer 200 with a default where the honest answer is a refusal or an absence — the port-coercion lesson; does any error leak an absolute host path to the client); teardown (SIGTERM with in-flight requests — do sockets close, does the port free, do panel fetch loops in the web client survive a server bounce and re-report truthfully).
## The ask
Adversarial defect hunt on the visualizer HTTP surface: run the real server on an ephemeral port against a throwaway ledger and attack every route. Attack shapes: parameter abuse on every query parameter (negative, NaN, 1e309, arrays via repeated params, since/until inversions, the historical --untill typo class where an unknown parameter silently widens the answer instead of refusing); path handling (traversal in any path-derived value, URL-encoded separators, the audit's resolve-versus-realpath symlink seam at the direct-invocation guard — demonstrate whether a symlinked cwd actually changes behaviour); protocol edges (HEAD and OPTIONS on every route, a body on a GET, oversized headers, connection dropped mid-response, two clients racing the once-fetch panels); response honesty (does any route answer 200 with a default where the honest answer is a refusal or an absence — the port-coercion lesson; does any error leak an absolute host path to the client); teardown (SIGTERM with in-flight requests — do sockets close, does the port free, do panel fetch loops in the web client survive a server bounce and re-report truthfully).
## Proposed tier
PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms
or overrides this at boot; the compiler never decides the tier.
proposed tier: build
because:
- protected paths in force: 14 · ratified profile field protected_paths_candidates (3 entries) added to the authored floor · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
- scope breadth: 4 source files named by where (2-4 → build)
- tripwire tests pinning that scope: 27
- protected-path hits: none
proposed shape: mechanical
because (risk signals):
- risk signal · protected-path hits: none — shape mechanical
proposed strength: workhorse
because (complexity signals):
- complexity signal · scope breadth: 4 source file(s) named by where
- complexity signal · tripwire tests pinning that scope: 27
- complexity signal · directory where: none
- complexity build → ratified ladder band workhorse
```proposal
{
  "shape": "mechanical",
  "strength": "workhorse"
}
```
## Where
verified · file · visualizer/server/server.mjs
verified · file · visualizer/server/shape.mjs
verified · file · visualizer/server/ledger-feed.mjs
verified · file · visualizer/server/roster-source.mjs
## Done means
Every defect carries: (1) a REPRODUCTION — a self-contained program or command sequence, written into the task dir, that demonstrates the misbehaviour against a scratch copy of the repo (git archive HEAD into a temp dir, or a throwaway DEVTEAM_LEDGER_DIR / state dir), never against the checkout — the driver mechanically refuses a scout that changes a file; (2) observed versus expected, with the exact output pasted; (3) a severity call: corrupts-state / wrong-answer / hangs-or-leaks / refuses-wrongly / cosmetic; (4) the guard that SHOULD have caught it (a test, a refusal, a schema) and why it did not. A suspicion you could not reproduce goes in a separate SUSPICIONS section with what you tried — it is not a finding. Negative results are first-class: list every attack you ran that the code survived, so the next hunt does not re-run it. Findings ranked by severity. State which files you read in full.
## Tripwires
candidates: crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/reclaim-descendants.test.mjs, crew/roster-refresh.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-emit-floor.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-probe-repo.test.mjs, test/factory-transcript.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/roster-source.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs
tripwire tests:
- crew/adapter-pi.test.mjs · 127.0.0.1, ROLE_ORDER
- crew/arms.test.mjs · ledger.db
- crew/breaker.test.mjs · breaker.mjs, ledger.db
- crew/crew.test.mjs · 127.0.0.1, ROLE_ORDER, ledger.db, roster.json
- crew/daemon.test.mjs · ledger.db, node:module
- crew/drive.test.mjs · ledger.db, roster-ladder.mjs, roster.json
- crew/io-contract.test.mjs · roster.json
- crew/pi/extensions/advisor.test.mjs · 127.0.0.1
- crew/pi/extensions/lab.test.mjs · 127.0.0.1
- crew/reclaim-descendants.test.mjs · ledger.db
- crew/roster-refresh.test.mjs · roster.json
- test/factory-ci-repair.test.mjs · ledger.db, node:module
- test/factory-ci-watch.test.mjs · ledger.db, node:module
- test/factory-emit-floor.test.mjs · ledger.db
- test/factory-emit.test.mjs · ledger.db, node:module
- test/factory-env.test.mjs · parseCliArgs, server.mjs, startServer, visualizer/server/server.mjs
- test/factory-intake.test.mjs · brief-uncompilable, intake-block-malformed, intake-block-missing, ledger.db, not-first-in-order, priority-unknown, rate-limit-floor, repeat-escalation, stop-switch, tier-judge, window-cap
- test/factory-ledger-floor.test.mjs · ledger.db
- test/factory-ledger.test.mjs · SEAT_TEARDOWN_OUTCOMES, ledger.db, node:module, not-first-in-order, roster.json
- test/factory-probe-repo.test.mjs · breaker.mjs
- test/factory-transcript.test.mjs · triage.mjs
- test/visualizer-panels.test.mjs · ROLE_ORDER, brief-uncompilable, feed.mjs, intake-block-malformed, intake-block-missing, ledger-feed.mjs, not-first-in-order, priority-unknown, rate-limit-floor, roster.json, shape.mjs, stop-switch, tier-judge, visualizer/server/ledger-feed.mjs, visualizer/server/shape.mjs, window-cap
- test/visualizer-returns.test.mjs · returns-source.mjs
- test/visualizer-roster-edit.test.mjs · ROLE_ORDER, roster-edit.mjs, roster-ladder.mjs, roster.json
- test/visualizer-server.test.mjs · 127.0.0.1, STOP_SWITCH_PATH, ServerUsageError, content-type, createLedgerFeed, feed.mjs, intake-block-missing, ledger-feed.mjs, ledger.db, node:module, parseCliArgs, roster.json, server.mjs, shape.mjs, shapeIntake, startServer, stop-switch, tier-judge, visualizer/server/ledger-feed.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs
- test/visualizer-shape.test.mjs · 127.0.0.1, INTAKE_REFUSAL_REASONS, INTAKE_WINDOW_MS, ROLE_ORDER, RUN_SET_WINDOW_MS, brief-uncompilable, defaultCellWindow, defaultIntakeWindow, defaultRunSetWindow, feed.mjs, foldAgents, intake-block-malformed, intake-block-missing, laneFor, ledger-feed.mjs, ledger.db, matchesFilters, node:module, not-first-in-order, priority-unknown, rate-limit-floor, repeat-escalation, server.mjs, shape.mjs, shapeCellHealth, shapeGateChecks, shapeIntake, shapeRun, shapeRunSet, startServer, stop-switch, tier-judge, triage.mjs, visualizer/server/ledger-feed.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs, window-cap, withCells
- test/visualizer-teardown.test.mjs · 127.0.0.1, SEAT_TEARDOWN_OUTCOMES, createLedgerFeed, defaultTeardownWindow, feed.mjs, ledger-feed.mjs, ledger.db, node:module, server.mjs, shape.mjs, shapeSeatTeardowns, startServer, visualizer/server/ledger-feed.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs
broad keys (not used as tripwires):
- ledger.mjs · 53 hits
- node:fs · 89 hits
- node:os · 54 hits
- node:path · 87 hits
- node:url · 40 hits
- protected-path · 31 hits
- tech-lead · 31 hits
declare every hit: grep -rn "../../crew/breaker.mjs\|../../scripts/factory/ledger.mjs\|./feed.mjs\|./returns-source.mjs\|./roster-edit.mjs\|./roster-ladder.mjs\|./roster-source.mjs\|./shape.mjs\|./triage.mjs\|127.0.0.1\|CELL_HEALTH_WINDOW_MS\|INTAKE_REFUSAL_GROUPS\|INTAKE_REFUSAL_REASONS\|INTAKE_WINDOW_MS\|ROLE_ORDER\|RUN_SET_WINDOW_MS\|SEAT_TEARDOWN_OUTCOMES\|SEAT_TEARDOWN_WINDOW_MS\|STOP_SWITCH_PATH\|ServerUsageError\|breaker.mjs\|brief-uncompilable\|budgetCeiling\|content-length\|content-type\|createLedgerFeed\|createRosterSource\|defaultCellWindow\|defaultIntakeWindow\|defaultRunSetWindow\|defaultTeardownWindow\|feed.mjs\|foldAgents\|index.html\|intake-block-malformed\|intake-block-missing\|laneFor\|ledger-feed.mjs\|ledger.db\|ledger.mjs\|matchesFilters\|model-reference.json\|node:fs\|node:http\|node:module\|node:os\|node:path\|node:url\|not-first-in-order\|not-in-window\|parseCliArgs\|parsePort\|pendingFor\|portFromEnv\|priority-unknown\|protected-path\|rate-limit-floor\|repeat-escalation\|returns-source.mjs\|roster-edit.mjs\|roster-ladder.mjs\|roster-source.mjs\|roster.json\|server.mjs\|shape.mjs\|shapeCellAttribution\|shapeCellHealth\|shapeGateChecks\|shapeIntake\|shapeRun\|shapeRunSet\|shapeSeatTeardowns\|startServer\|stop-switch\|tech-lead\|tier-judge\|triage.mjs\|visualizer/server/ledger-feed.mjs\|visualizer/server/roster-source.mjs\|visualizer/server/server.mjs\|visualizer/server/shape.mjs\|window-cap\|withCells" crew/ test/ scripts/ docs/
## Coupled sources
coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.
- visualizer/server/feed.mjs · createLedgerFeed, ledger-feed.mjs · no fence in play
- visualizer/web/src/lib/panels.js · shape.mjs · no fence in play
- visualizer/web/src/lib/trace.js · server.mjs · no fence in play
## Baseline
lane: npm test · pass 2171 · fail 0 · status: green
lane basis: ratified profile field test_command · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed
## Out of scope
No edits to the checkout. No speculation presented as findings. No re-litigating the 2026-08-23 audit registers (consistency/duplication/prose) — this hunt is behaviour only. Do not fix anything. The Svelte web client is out except as an observer of server behaviour.
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
narrow: node --test crew/adapter-pi.test.mjs crew/arms.test.mjs crew/breaker.test.mjs crew/crew.test.mjs crew/daemon.test.mjs crew/drive.test.mjs crew/io-contract.test.mjs crew/pi/extensions/advisor.test.mjs crew/pi/extensions/lab.test.mjs crew/reclaim-descendants.test.mjs crew/roster-refresh.test.mjs test/factory-ci-repair.test.mjs test/factory-ci-watch.test.mjs test/factory-emit-floor.test.mjs test/factory-emit.test.mjs test/factory-env.test.mjs test/factory-intake.test.mjs test/factory-ledger-floor.test.mjs test/factory-ledger.test.mjs test/factory-probe-repo.test.mjs test/factory-transcript.test.mjs test/visualizer-panels.test.mjs test/visualizer-returns.test.mjs test/visualizer-roster-edit.test.mjs test/visualizer-server.test.mjs test/visualizer-shape.test.mjs test/visualizer-teardown.test.mjs
full: npm test · measured baseline pass 2171, fail 0
## Conventions
files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): visualizer/server/ledger-feed.mjs, visualizer/server/roster-source.mjs, visualizer/server/server.mjs, visualizer/server/shape.mjs
read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): crew/adapter-pi.test.mjs, crew/arms.test.mjs, crew/breaker.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/io-contract.test.mjs, crew/pi/extensions/advisor.test.mjs, crew/pi/extensions/lab.test.mjs, crew/reclaim-descendants.test.mjs, crew/roster-refresh.test.mjs, test/factory-ci-repair.test.mjs, test/factory-ci-watch.test.mjs, test/factory-emit-floor.test.mjs, test/factory-emit.test.mjs, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-ledger-floor.test.mjs, test/factory-ledger.test.mjs, test/factory-probe-repo.test.mjs, test/factory-transcript.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-returns.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs, test/visualizer-teardown.test.mjs
conventions of record (basis: ratified profile field conventions · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json): .claude/, README.md, docs/adr/, docs/conventions.md
grep -rn "../../crew/breaker.mjs\|../../scripts/factory/ledger.mjs\|./feed.mjs\|./returns-source.mjs\|./roster-edit.mjs\|./roster-ladder.mjs\|./roster-source.mjs\|./shape.mjs\|./triage.mjs\|127.0.0.1\|CELL_HEALTH_WINDOW_MS\|INTAKE_REFUSAL_GROUPS\|INTAKE_REFUSAL_REASONS\|INTAKE_WINDOW_MS\|ROLE_ORDER\|RUN_SET_WINDOW_MS\|SEAT_TEARDOWN_OUTCOMES\|SEAT_TEARDOWN_WINDOW_MS\|STOP_SWITCH_PATH\|ServerUsageError\|breaker.mjs\|brief-uncompilable\|budgetCeiling\|content-length\|content-type\|createLedgerFeed\|createRosterSource\|defaultCellWindow\|defaultIntakeWindow\|defaultRunSetWindow\|defaultTeardownWindow\|feed.mjs\|foldAgents\|index.html\|intake-block-malformed\|intake-block-missing\|laneFor\|ledger-feed.mjs\|ledger.db\|ledger.mjs\|matchesFilters\|model-reference.json\|node:fs\|node:http\|node:module\|node:os\|node:path\|node:url\|not-first-in-order\|not-in-window\|parseCliArgs\|parsePort\|pendingFor\|portFromEnv\|priority-unknown\|protected-path\|rate-limit-floor\|repeat-escalation\|returns-source.mjs\|roster-edit.mjs\|roster-ladder.mjs\|roster-source.mjs\|roster.json\|server.mjs\|shape.mjs\|shapeCellAttribution\|shapeCellHealth\|shapeGateChecks\|shapeIntake\|shapeRun\|shapeRunSet\|shapeSeatTeardowns\|startServer\|stop-switch\|tech-lead\|tier-judge\|triage.mjs\|visualizer/server/ledger-feed.mjs\|visualizer/server/roster-source.mjs\|visualizer/server/server.mjs\|visualizer/server/shape.mjs\|window-cap\|withCells" crew/ test/ scripts/ docs/
- The factory scripts carry a Node ≥24 floor; follow the existing
  `scripts/factory/*` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No `Co-Authored-By` trailers.
- If interrupted, write your ReturnEnvelope first on resume — `status:
  insufficient` if incomplete. A silent seat is indistinguishable from a dead
  one.
