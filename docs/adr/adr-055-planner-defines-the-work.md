# ADR-055 — The planner defines the work, code checks red and green, the reviewer judges

**Status:** *proposed* 2026-11-02, operator direction ("planner model should define the work, and brief should take
whats in github task or issue, clean it up and prepare for work nothing more") · **Owner:** operator ·
**Relates to:** ADR-052 (P1 brief, P3 acceptance gate, §6 the loop), ADR-053 (rejected here), ADR-054 (amended
here), ADR-038 (superseded here), ADR-030 (superseded here), ADR-051 (finish shape), ADR-048 and ADR-049 (superseded
here)

Today the brief author writes acceptance ids, the planner copies them, writes a gate script with one check per id and
predicts one kill-mutation per id, and code proves each check red, green and killed. This record moves the definition
of the work to the planner, keeps one mechanical proof in code, puts judgment in the reviewer, and removes the gate,
the mutations and six unused arms.

## Why (measured 2026-11-01 and 2026-11-02)

- **The brief decides the test volume without reading the code.** In all 22 corpus lanes (`bench/corpus`) the
  planner's acceptance ids equal the brief's, because `crew/loop.mjs` stops a lane whose planner ids differ. The 79
  brief ids average 3.6 a lane. A keyword pass (not hand-sorted, classes overlap) puts about 12 of them on doc wording
  and about 6 on behaviour the change does not touch ("still exits nonzero").
- **Tests outweigh the change.** On 18 corpus lanes, one builder run each with today's loop, builders added 804 test
  lines and 392 source lines: about one test per id, 15 lines and 4 to 5 asserts each
  (`~/crew-bench/buildfirst-2026-11-02`). The planner's `gate.mjs` (47 to 259 lines a lane) checks the same ids again.
- **The mutation proof costs more than it finds.** Over 95 archived lanes (`~/crew-bench/loop-logic-audit-2026-11-01.md`),
  34 of 653 mutation rows were `bind-fail` (the planner's predicted text did not match the build) and 15 survived; 8 of
  95 lanes stopped on `mutation-unmeasured` or `mutations-survived`. None of the 10 known defects in
  `~/crew-bench/defects-2026-11-01` was caught by a gate or a mutation: all 10 merged.
- **The gate is where plans fail.** Strict blind review failed 100 of 126 first plans across five batches, and most
  findings were holes in the gate (`~/crew-bench/planner-arms-2026-11-01`, `plan-review-vs-outcome-2026-11-01.md`).
- **Builder-written tests with builder-declared mutations did not help** (ADR-053's bench, rep 1 of 3, stopped for
  time): 18 lanes, one run per arm. Total lines rose from 1196 to 1307, test lines from 804 to 934, and blind diff pass
  fell from 12 of 18 to 10 of 18. ADR-053's own rule (blind pass not worse, lines fall) failed.
- **Judge lanes promise a review they never get.** `crew/agents/tech-lead.md` seats the tech-lead on judge lanes only,
  but `crew/loop.mjs` has no tech-lead turn. Six archived judge lanes have zero tech-lead returns.
- **The reference that works this way.** Kiro's one public spec (`kirodotdev/Kiro`,
  `.kiro/specs/github-issue-automation/`) writes 41 EARS criteria, 22 correctness properties that each list the criteria
  they validate, and tasks that each cite their requirements. Its 23 test tasks are optional and none was done; its
  `package.json` has no property-test library. The plan carried the tests and the code never got them.

## Decision

### 1. The brief carries the issue

A brief has `source`, `closes`, `out_of_scope`, `suite`, the cleaned ask, context pointers, and one dispatch choice:
`mechanical: true` only when the issue alone shows no behaviour to judge (a version bump, a typo, a rename, a doc
line). It has no acceptance ids and no `## Acceptance` section, and nobody writes tests in it.

Amended 2026-11-03, operator decision ("yes, proceed"): the body has `## Context` pointers and, for an operator
request, `## The ask` quoting the operator's words or approved proposal verbatim, `#N` included; `closes` remains the
only issue binding. An issue brief has no ask; `crew start` quotes
the issue body as the ask in the run brief. The planner names brief text taken as a constraint and why it binds; the
reviewer flags criteria based only on brief text that is not the source's words or an operator decision.

### 2. The planner defines the work

`plan.md` takes Kiro's shape, trimmed:

- **Criteria:** numbered, one line each, `WHEN <trigger> THE <code unit> SHALL <observable result>`, written after the
  planner has read the code, each naming the file or function it applies to.
- **Properties:** each states what must hold, lists the criteria it validates, and names one test (file and title). One
  test per property, not per criterion.
- **Not machine-checked:** criteria no test can check, listed as such.
- **Tasks:** an ordered checklist, at most two levels, each citing its criteria and the test that proves it, or
  "not machine-checked" when its criteria have no test.

The planner envelope keeps `subject`, `plan_path` and `files_in_scope`, adds an optional `judge` (a one-line reason)
and a required `tests` (each a file and a test title, one per property, in the plan's order; an empty list says every
criterion is not machine-checked), and drops `acceptance`, `gate_path`, `gate_cmd` and `mutations`. Code reads
`tests`, never `plan.md`: on 2026-11-02 b1486's review found two ways a parse of the plan's Markdown read Properties
as empty (a table, then a fenced example before the real section), each a false `proof: none`. The reviewer judges
that `tests` and the plan's Properties agree.

### 3. The builder builds and reports

The builder makes the change first, then writes the tests the plan names, and only those:

- Tests cover behaviour the change adds or alters. Never behaviour it leaves alone (the suite covers that), doc or
  prose wording (the reviewer reads it), or what a linter or a type already guarantees.
- One small test per property: the smallest case that fails on the old source. Several cases of one property are rows
  of one table-driven test. Extend an existing test file and reuse its fixtures and helpers; add no helper or fixture
  for a single test.
- A test the plan does not name needs a reason in `notes`; the reviewer flags one without.

Its envelope adds `tests` (each a file and a test title) and `notes`: the paths it did not test, the existing guards it
relied on, the checks it ran, and what it verified as against what it assumed. The reviewer cannot see the builder's
session; the notes are how it learns where to look. The PR body states the source and test lines the change adds.

### 4. Code keeps one proof

For each test the builder names, code runs it on the old source and on the build and reads per-test `node --test`
results:

- red on the old source, from a failure in the test's own body (an import error, a failing hook, a skip, a cancel or a
  missing result is unproven);
- green on the build.

A builder that names no test while the planner's `tests` names one, or a named test that is unproven, sends the lane back to the
builder within its rounds. When the planner's `tests` is empty, no test is required, the PR states
`proof: none, no criterion is machine-checked`, and the reviewer judges each criterion. A mechanical lane has no plan and
no review: when its builder names no test, the PR states `proof: none, mechanical lane, not reviewed`, and the operator
reviews the diff before merging.
The proof runs again after a rebase that moves the head. The PR body states the result, or `proof: unmeasured` when it
did not run. This shows a test depends on the change. It is not a kill proof, and the PR does not call it one. Other
test runners refuse with a stated reason until each is added.

### 5. The reviewer judges, at the end

After PR-Agent and qodo-skills (ideas only):

- **Requirements:** the reviewer restates the brief's ask as requirements and marks each `met`, `unmet` or
  `human-verify` with evidence. A `pass` carries no `unmet`.
- **Findings:** a `must-fix` carries a `trigger`, the concrete state that breaks it; any finding may carry `start_line`,
  `end_line` and `uncertain` (what was not verified). Findings are ranked, at most five per round, the rest counted.
  The reviewer reports only what it can explain with a concrete scenario, and does not flag style, docstrings, type
  hints or "verify" requests.
- **Failure modes:** up to three, each with what breaks, where, the trigger, whether a test detects it, and whether
  this change covers it.
- **Coverage:** the review states what it read; a partial review is incomplete, never a pass.
- **Rounds:** from round 2 the reviewer receives earlier findings with their ids and closes or carries each one.

A second-pass scorer that grades and drops findings is deferred until it is measured on the known-defect lanes.

### 6. The loops

ADR-054's three loops stand, with section 4 above as their proof:

```
mechanical:  brief -> rebase -> build -> prove -> suite -> PR
build:       brief -> plan -> rebase -> build -> prove -> (suite || review) -> PR
judge:       brief -> plan -> rebase -> build -> prove -> suite -> review -> second review -> PR
```

The judge loop's second review is the tech-lead's. It drops ADR-038's mutation on the changed surface.

### 7. Choosing the loop

1. At dispatch: `mechanical` only when the issue shows it and names none of the protected paths below, otherwise
   `build`.
2. After planning: the planner may raise the lane to `judge` with its `judge` reason.
3. After the build: code raises the lane to `judge` when `files_in_scope` or the diff touches `crew/loop.mjs`, the
   proof module, `crew/protocols.mjs`, `crew/acp/grants.mjs`, `hooks/`, `crew/agents/`, `.github/workflows/` or
   `docs/adr/`.

Code raises a lane and never lowers one. A build lane raised after its build continues on the judge loop from the
proof. A mechanical lane has no plan, so when it is raised, its builder returns `insufficient`, or the lead bounces its builder to the planner, it restarts from
planning: as `judge` when raised, as `build` otherwise, and its first build is discarded.

### 8. What is removed

- **The acceptance plumbing:** the brief field and section, the brief and planner id equality, the PR body's
  acceptance block.
- **The planner gate:** `runGate`, the baseline check and its stops, the gate runs after the build and the rebase,
  `gate_path`, `gate_cmd`, `crew/guidelines/gate-kit.mjs` and `vitest-gates.md`.
- **The mutation proof:** `proveMutations` and its helpers in `crew/checks.mjs`, `crew/tree-fingerprint.mjs`, the
  mutation schemas, re-aim turns and `bind-fail` handling, and the stop reasons that serve only these.
- **In finish (ADR-051):** gate repair and mutation re-aim. Finish itself stays, and it still reads archived journals
  that carry the old stages and keys.
- **Six arms, operator decision 2026-11-02:** codemode (no gain; planner usable plans 11 of 14 against 13 of 14, three
  scripts reported success over a failed call), the stepped shape (33 of 36 lanes had one step), builderloop (no
  intervention measured), lab (planner declined it twice; reviewer catches 3 of 6, the same as without it), reminders
  (misfired its fff rule in 4 of 6 runs) and edit assist (never switched on). The advisor on the builder and memory on
  the planner stay.

The audit behind this list, with file and line ranges, is `~/crew-bench/loop-drop-inventory-2026-11-02.md`: about 690
source lines and 1,700 test lines.

### 9. The honesty rule

`CLAUDE.md` changes "a guard is vacuous unless proven by mutation" to: a test proves a change only when it is red on the
old source and green on the build; that is not a kill proof, and a PR never calls it one. A seat may still mutate code by
hand to test its own tests; nothing requires it.

### 10. What each seat is given

The charter carries what a seat always does; it is always delivered. A skill carries knowledge a lane needs only for
some files; `skills/skill-map.json` grants it by path. Skills are small and whole: the loop strips a `#section` and
delivers the whole skill (`hooks/skill-gate.mjs`), and only the builder and reviewer receive map grants
(`crew/lean.mjs`), so the planner gets no skill today.

| Seat | Charter | Skills, by path |
|---|---|---|
| planner | the plan shape of §2; properties only for changed behaviour | none |
| builder | §3: change first, the plan's tests only, `tests` and `notes` | `test-economy` on test files; `code-less` on source; `backend-node`, `frontend-svelte`, `ui-design`, `ux`, `prose-plain` as today |
| reviewer, tech-lead | §5 | `pr-review`; `test-strength` on test files; `code-less`; the domain skills as today |

- **`test-economy`** (new, about 40 lines): §3's test rules, the smallest failing case, table-driven cases, fixture
  reuse, and the `node --test` notes the builder needs.
- **`test-strength`** (new, about 30 lines): whether a test is vacuous, red for the right reason, and would fail on a
  broken implementation.
- **`qa-test-writing`** leaves seat delivery. Its gate and mutation material (`references/gates.md`, the gates section
  of `references/dev-team-evidence.md`) goes with §8; the rest stays for people writing tests by hand.
- **`code-less`** is rebased on ponytail v5 (`DietrichGebert/ponytail`, MIT, `skills/ponytail/SKILL.md`). Ours derives
  from an older version and differs where the cost shows: its "trace the code end to end first, never the reading"
  line matches the 11-01 measurement of one more read, 2.5 more calls and 62k more median tokens a builder run, with
  diffs of the same size (828 lines added with it, 847 without, over 14 lanes). v5 reads "the code it touches" and
  lists where the change must reach; keeps the codebase's structure (b1381's builder wrapped and re-indented 40
  lines); names what is never cut (trust-boundary validation, data-loss handling, security, accessibility); asks for
  one small test only for new non-trivial logic; and ends with what was skipped and the risk, which is §3's `notes`.
  The rebase drops the kill-mutation line, uses v5's `shortcut:` marker in place of `// lean:` (12 in the repo, none in
  14 builder diffs), and takes examples from code §8 keeps.
- **`pr-review`** takes `ponytail-review`'s order (correct, safe, holds under load, tested, fast, lean), its "no case,
  no finding" rule and "one good test, not coverage", beside §5.

### 11. Order of work

| Wave | Lane | Tier | Change |
|---|---|---|---|
| 1 | proof | judge | `crew/proof.mjs` (moved from `bench/replay-builder.mjs`, without the mutant leg), the builder `tests` field, §8's gate and mutation removal, the bench, `CLAUDE.md`'s honesty rule. Acceptance ids stay until wave 2 |
| 1 | seat knowledge | build | §10's skills and the §3 charter rules; `skill-map.json` cleaned of grants no seat receives |
| 1 | arms | judge | §8's six arms |
| 1 | corpus | build | four to six feature-sized lanes in `bench/corpus`, so a replay can show what `code-less` claims (every lane there now is a small fix) |
| 2 | planner | judge | §1, §2 and §7: the brief without acceptance, the plan shape, the `judge` raise and the path raise; §12's code parts |
| 3 | reviewer | judge | §5, `notes` in the reviewer prompt, the tech-lead second review on judge lanes, map grants for the tech-lead |
| 4 | loops | judge | ADR-054's three loop shapes |

Wave 1 lanes run side by side; worktrees isolate them and the rebase resolves overlap. The proof lane's brief is the
last that carries acceptance ids.

### 12. When a lane stops for the operator

Added 2026-11-02 after the first two wave-1 judge lanes. b1481 and b1483 both stopped `round-bound` after three
builder turns and two lead bounces, with no question for the operator. b1481's builder returned `escalate` three times
for unfinished work: 43, 38 and 29 tool calls, each turn ended by the model, 2.8M tokens for a 7-file diff. b1483's
builder returned `insufficient` twice because `files_in_scope` left out a test the deletion broke, and the lead told it
to extend the plan's scope, which the builder may not edit. Earlier tallies agree: 38 of 71 finished lanes escalated by
2026-10-02 and all 38 merged after hand work; 13 of 19 escalations on 2026-10-03 were loop defects.

A lane stops for the operator only when it needs a decision or something only the operator can give:

1. The ask cannot be done as written: a brief premise is false on main, or the ask contradicts the code or itself.
2. The fix needs a decision outside the brief: changing `out_of_scope`, breaking a public contract, dropping data, or
   a security trade-off.
3. The lane needs something only the operator has: credentials, an account, or a provider authentication failure
   (401 or 403).
4. On a judge lane, the builder and reviewer still dispute a must-fix after the tech-lead's second review.
5. No progress: the same failure returns twice with the same evidence. Code detects this and stops; no seat decides it.

Everything else goes to the seat that can fix it:

| Situation | Goes to |
|---|---|
| Unfinished work, a large change | the builder keeps working; it is never a reason to return |
| A file the change reaches is missing from `files_in_scope` | the builder edits it and names it (ADR-045) |
| A gap in the plan | the planner, which revises the plan |
| A test or the suite breaks after the change, a reviewer must-fix, a rebase conflict | the builder |
| A provider 429, 529 or 5xx | the bounded retry |
| An envelope that fails the schema | the repair turn |
| A protected path | the `judge` raise of §7 |

Code holds the rule:

- An `escalate` from any seat carries `details.question`, the decision it needs from the operator. An `escalate`
  without one is a bounce to the same seat.
- Amended 2026-11-03, operator direction: on build and judge, a builder `insufficient` goes to the lead with its
  envelope. The lead routes it to `builder` (unfinished work, same plan), `planner` (a real gap) or `escalate`
  (a §12 case only). A mechanical lane keeps the §7 restart. Lanes b1493, b1502 and b1504 stopped `round-bound`
  after builder `insufficient` returns.
- Amended 2026-11-03 (b1500, b1509): lead consults have separate full bounds for build, review and moved-head
  recheck. On standard build and judge lanes, the first reviewer turn forced only by a moved-head rebase spends no
  round; on judge the tech-lead turn is free too. Finish recheck reviews still spend a round under the finish review cap.
- The lead's last consult is marked last. A spent lead bound stops for the operator as `lead-escalated`, with a
  question drawn from the held envelope and the lead's decision, never a bare `round-bound`. `no-progress` still
  stops in code.
- A lead bounce names its target, `builder` or `planner`. A bounce to a spent planner is the planner's round.
- An `accept` with nothing to accept is a bounce to the held seat.
- A return written before a turn error is read and validated in full. An absent or invalid return gets one rerun; a provider failure keeps its bounded retry instead.

The charter lines (the builder's statuses and `files_in_scope`, the lead's escalation list) apply at once. The code parts
land with the wave-2 planner lane.

## Measurement before ratifying

*Revised 2026-11-02, operator decision: the builder, the planner and the loops are measured on live lanes, not
replayed.*

A replay re-runs one seat on one archived prompt. It cannot re-run a loop, and the builder and planner prompts this
record changes have no archived counterpart: every corpus brief carries acceptance ids and every corpus plan a gate.
So only the reviewer is replayed. The builder, the planner and the loops are measured on the first 10 lanes started
after the wave-4 loops lane merges, from their lane journals and merged diffs. A tier with fewer than 10 lanes by then
reports the lanes it has, with that denominator.

- **Reviewer (replay):** the 10 known-defect lanes of `~/crew-bench/defects-2026-11-01`, three runs each, with each
  archived reviewer prompt rewritten to §5's charter, an empty builder report (the corpus builders predate `tests` and
  `notes`) and the new return shape. Report `changes-needed` verdicts with a finding naming a defect file, against the
  old prompt's 9 of 30 at high effort and 14 of 30 at xhigh (the judge tier).
  **Measured 2026-11-03** (`~/crew-bench/reviewer-contract-2026-11-02`, 60 runs, none errored after 25 runs lost to a
  network outage were rerun): high caught 14 of 30 (old 9 of 30), xhigh 12 of 30 (old 14 of 30). Every return met
  §5's shape (0 of 60 defects under the strict validator). Tokens rose: high 13.6M against 9.4M (+44%), xhigh 20.2M
  against 12.9M (+57%). No cell caught b1402, b1416 or b1441, old or new. At N = 30 neither difference is significant.
  Decided 2026-11-03: judge lanes run the reviewer at high; the tech-lead's second review stays at xhigh.
- **Builder (first 10 lanes):** test lines as a share of code lines added (the 18 corpus lanes: 804 of 1196, 67%), tests
  named per lane, tests red on the old source and green on the build out of tests named, and builder tokens. Lanes
  differ in size from the corpus, so the share is compared, not raw lines. The §3 rules stay if the share falls. The
  `code-less` arms comparison (today's, the v5-based, none) is not run; v5 replaces today's skill as §10 states.
- **Planner (first 10 lanes):** tests named per lane, plans the reviewer or lead sent back to the planner, and builder
  `insufficient` returns. The blind plan pass against the 11-01 control (11 of 42) is dropped: that review scored the
  gate, which §8 removes.
- **Loops (replaces ADR-054 §3):** per tier, total wall time, rounds, suite-repair turns, lead consults, operator
  stops and defects found after merge (a later fix commit on main whose blame lands on the lane's lines). The build
  loop is not adopted on the ADR-053 replay, since ADR-053 is rejected.

Passive data from the wave lanes, which ran while the contract changed and so do not count toward the 10: b1485 to
b1489 (PRs 2127 and 2129 to 2132) added 782 test and 490 source lines, a test share of 61%.

## What this does not decide

- Provider fallback and the reviewer's model and effort.
- Whether the advisor and memory arms stay after their next measurement.
- How the review is posted on GitHub.

If ratified, this record rejects ADR-053; supersedes ADR-030, ADR-038, ADR-048, ADR-049 and the acceptance parts of
ADR-052 (P1's acceptance field, P3 and §6's proof); and amends ADR-054 §2 (the proof), §3 (the measurement) and §4
(choosing the tier) and ADR-051 (gate repair and re-aim).
