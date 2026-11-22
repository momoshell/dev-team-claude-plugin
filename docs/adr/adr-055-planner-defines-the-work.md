# ADR-055 — The planner defines the work, code checks red and green, the reviewer judges

**Status:** builder (§3) and planner (§2) parts ratified 2026-11-03 by operator decision on `~/.crew/reviews/adr-055-readout-2026-11-03.md`; §1, §7, §8 and §12 ratified 2026-11-04 by operator decision D14 in `~/.crew/reviews/codebase-2026-11-04.md`; §6 pre-check base refresh (#2403), first-round-only refresh (#2433) and concurrent judge reviews (#2425) ratified 2026-11-16 by operator decision; 2026-11-17 amendment (#2437) supersedes §§2–3 test selection and §10's logic mandate and extends §5 review with the no-test default; 2026-11-18 amendment (#2459) records §6 pending build-suite cancellation; clarifications 2026-11-17 (#2438, tests named in issues) and 2026-11-16 (#2419, retired brief suite and escalation/review counting) record the current rules; §6 round budgets stay proposed until about 10 lanes run on b1514's round budgets · **Owner:** operator ·
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

Amended by ADR-056: "or approved proposal" is withdrawn from the operator ask.

Clarification (2026-11-16, #2419): `suite` in the original field list above is
retired. `parseBrief` in `crew/protocols.mjs` refuses it; suite configuration
belongs in `.crew/project.json`, not brief frontmatter (ADR-057).

Amended 2026-11-03, operator decision: Context items are bare pointers; `out_of_scope` is optional, and absent means none.

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
mechanical:  brief -> rebase -> build -> refresh base -> prove -> suite -> PR
build:       brief -> plan -> rebase -> build -> refresh base -> prove -> (suite || review) -> PR
judge:       brief -> plan -> rebase -> build -> refresh base -> prove -> suite -> (review || second review) -> PR
```

The judge loop's second review is the tech-lead's. It drops ADR-038's mutation on the changed surface.

Amended 2026-11-18 (#2459): [ADR-054 §2's dated cancellation amendment](adr-054-each-tier-runs-its-own-loop.md)
lets a non-finish build round cancel a pending suite after all reviews return a
valid `changes-needed` verdict. The next builder waits for proven group and pipe
cleanup, falling back to ordinary waiting if proof fails. Completed suite results
and passing reviews are unchanged. Cancellation journals its own status and
seconds; only a later green suite can be cited by the PR. Red-suite diagnostics
may arrive one round later. Judge, mechanical and finish scheduling is unchanged.

Amended 2026-11-16, operator decision ("yes 1", #2425): whenever a judge round dispatches reviews,
start the reviewer and tech-lead independently on the same checked tree after a green suite. This includes
raised lanes and moved-head rechecks. Keep the journal stage `second-review`. Wait for all started checks;
publication requires a green suite and both seats' passes on that tree. A repair turn gets both seats'
available findings and omission notices in one feedback list. A red suite still repairs without dispatching
reviews. Each seat retains its own prior findings and independently reuses its latest pass on the unchanged
tree with `review-reused`, without spending a round. Changed trees rerun both seats. A halt from either seat
allows its sibling to finish and journals its return before the loop returns stopped. Existing seat bounds,
lead routing and free moved-head rechecks remain. Build, mechanical and finish scheduling does not change;
those runs have no tech-lead turn. This decision does not ratify the proposed round budgets.

Amended 2026-11-16, operator decision (#2403): **every suite run** refreshes the base after the accepted
builder or suite-repair turn and before proof, review or suite, in build, judge, mechanical and finish runs.
An unchanged base adds only fetch and base measurement. A moved base temporarily commits the measured lane
paths, rebases through the existing ignored/generated-file policy, then soft-resets onto the new base so the
build remains uncommitted and proof measures old source at that base. If Git drops the change as upstream,
the lane stops `nothing-to-commit`. Fetch failures retain the ref-lock retry policy and stop on terminal failure.

After a pre-check move, the next review is full and counted against normal review rounds, including a reserve
review or finish suite-repair review. Earlier findings remain; delta, reserve and publishing-recheck scopes do
not. The journal records old/new base and full-review intent. This grants no rounds and spends none of
`MAX_RECHECKS`. Initial finish, pre-check and publishing conflicts share the run's one builder conflict turn;
a spent or unresolved turn stops `rebase-conflict`. Failed moves restore uncommitted work only when cleanup
is proven. The post-suite publishing rebase and its three-recheck bound stay unchanged, covering base movement
while checks run. This decision does not ratify the proposed round budgets below.

Amended 2026-11-16, operator decision (#2433): narrow #2403's pre-check refresh to
**the first check round of each run**. A start run or finish pass fetches and
measures the base once at its first check opportunity, after the required-test-name
gate, whether or not that measurement moves the base. Later check rounds do not
fetch, measure or move it before proof, suite or review. Proof retries, review
findings, suite repairs, replanning, tier restarts and builder repairs after a
publishing recheck do not reopen this allowance. Builder and conflict turns are
not themselves check rounds. The rule covers build, judge, mechanical and finish;
a new finish pass starts a new invocation with its own first-round refresh.

The first-round move still leaves the build uncommitted; its next review stays
full and counted. The shared single builder conflict turn is unchanged. Later
checks use the held base at `HEAD`, not necessarily the latest remote tip.
Publishing still commits and rebases after checks pass; a moved head gets the
existing suite and uncounted recheck review within `MAX_RECHECKS`. Mechanical
publishing rechecks still run on the committed rebased head. This amendment does
not change publishing rechecks or ratify the proposed round budgets.

### 7. Choosing the loop

1. At dispatch: `mechanical` only when the issue shows it and names no protected paths (built-in or project),
   otherwise `build`.
2. After planning: the planner may raise the lane to `judge` with its `judge` reason.
3. Code raises the lane to `judge` if the accepted plan's `files_in_scope` or the build diff touches a protected path.
   The built-ins include `crew/loop.mjs`, `crew/checks.mjs`, `crew/finish.mjs`, `crew/lean.mjs`, the proof module,
   `crew/protocols.mjs`, `crew/acp/grants.mjs`, `hooks/`, `crew/agents/`, `.github/workflows/` and `docs/adr/`.
   Amended 2026-11-04, operator decision D3: the checker, finish and lean modules are protected too.

Amended 2026-11-21 (#2530), operator decision: `.crew/project.json` may add
`protectedPaths` to the built-in list. An entry is a literal repo-relative path:
a trailing `/` protects a directory tree, otherwise it matches one exact file.
No globs. An absent or empty list adds nothing. The list is not part of the
onboarding hash. Start snapshots it for the lane, including finish passes and
planning resumes. A lane that edits the list still uses its start snapshot.

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

Clarification 2026-11-18 (prose-drift audit, #2467): `definitionFor` in
`crew/lean.mjs` grants path-selected skills to builder, reviewer and tech-lead.
The planner receives no map grants. The original decision text above is retained.

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

- Amended 2026-11-04, operator direction (b1526, b1528, b1533, b1539): a rebase conflict before publishing, or a finish base conflict, gets one builder conflict turn per run. A resolved head takes the moved-head recheck; an unresolved turn is undone and stops `rebase-conflict`, as does a conflict after the turn is spent.
- An `escalate` from any seat carries `details.question`, the decision it needs from the operator. An `escalate`
  without one is a bounce to the same seat.

  Clarification (2026-11-16, #2419): The existing operator-selected exception in
  `crew/loop.mjs` limits questionless retry to builder escalations and done lead
  escalations, subject to the existing bounds and single-turn handling. Planner,
  reviewer and tech-lead `insufficient` or `escalate` returns stop `seat-escalated`,
  using a valid `details.question` or falling back to `summary`; no usable planner
  artifact or completed review is required. A non-done lead `decision: escalate`
  stops `lead-escalated` with the same fallback, without questionless retry.
  Valid non-done lead bounce and accept decisions retain their routing; non-done
  status alone does not force escalation. This records the shipped exception,
  not a new escalation policy. See `crew/README.md`.
- Amended 2026-11-03, operator direction: on build and judge, a builder `insufficient` goes to the lead with its
  envelope. The lead routes it to `builder` (unfinished work, same plan), `planner` (a real gap) or `escalate`
  (a §12 case only). A mechanical lane keeps the §7 restart. Lanes b1493, b1502 and b1504 stopped `round-bound`
  after builder `insufficient` returns.
- Amended 2026-11-12, operator decision (#2279): a builder `insufficient` without `details.gap` after a worktree change continues on the same plan without a lead consult or builder round. A named gap, unchanged or unmeasured worktree, or spent progress cap routes to the lead; held turns, single turns and non-finish mechanical lanes do not continue this way. A lead bounce to the builder after a changed builder turn refunds the lead round. Continuations and refunds share a per-lane cap of 6, after which consults spend the bound. In the replay, 1 of 15 terra returns named no gap. Reusing the live builder session is out of scope.
- Amended 2026-11-14 (#2375): a bounce to a builder held at its round bound refunds the lead round if its most recent completed turn changed the worktree, that turn has not already refunded a consult, and the held feedback carries no must-fix id from the same seat in the previous consult. The refund shares the cap of 6 with continuations. A planner bounce or an unchanged or unmeasured turn spends the bound. Four of 42 census stops escalated this way with an item no seat had been given a turn on.
- Amended 2026-11-03 (b1500, b1509): lead consults have separate full bounds for build, review and moved-head
  recheck. On standard build and judge lanes, the first reviewer turn forced only by a moved-head rebase spends no
  round; on judge the tech-lead turn is free too. Finish recheck reviews still spend a round under the finish review cap.

  Clarification (2026-11-16, #2419): ADR-051 Amendment 2 supersedes that last
  sentence. Post-suite moved-head finish recheck reviews are uncounted and run
  even at a spent cap; `counted: false` rows are excluded by `reviewCount` in
  `crew/finish.mjs`. This differs from a pre-check base move, which requires a
  full, counted review and can stop `round-bound` at a spent cap (§6's
  2026-11-16 amendment, #2403).
- Amended 2026-11-13, operator decision (#2359): build and judge recheck reviews cover unresolved earlier findings, lane code altered by the rebase or conflict turn, and where the base's new commits meet the lane's change. For reviewed commit R, new base O and rebased head H, compare `git diff R^ R` with `git diff O H` to see lane changes; `git diff R^ O` shows base changes. The loop checks that all three comparisons work; if the scope cannot be measured, the review is full and the journal records that fallback.
- Amended 2026-11-04, operator decision D4: a publishing rebase may trigger at most three moved-head rechecks;
  a fourth move stops as `recheck-bound` before uncommitting or publishing.
- The lead's last consult is marked last. A spent lead bound stops for the operator as `lead-escalated`, with a
  question drawn from the held envelope and the lead's decision, never a bare `round-bound`. `no-progress` still
  stops in code.
- A lead bounce names its target, `builder` or `planner`. A bounce to a spent planner is the planner's round.
- An `accept` with nothing to accept is a bounce to the held seat.
- A return written before a turn error is read and validated in full. An absent or invalid return gets one rerun; a provider failure keeps its bounded retry instead.
- Amended 2026-11-04, operator direction (use Muse Wonder as the planner): a Muse task-dir seat compares worktree fingerprints before and after a started turn. A changed fingerprint raises `acp-seat-wrote-repo`; an unreadable after-check raises `acp-seat-repo-unmeasured`. The return is deleted and, even if deletion fails, is not read or rerun. This check misses ignored files, writes outside the worktree and task dir (including the main repository's `.git`), edits restored before the after-check, index-only changes, and writes after an unproven teardown. Directories listed by git, including nested repositories and submodules, are compared by status only.

- Amended 2026-11-05, operator direction: a Muse seat that writes gets the lane task dir as an ACP additional directory, and its lean records are fingerprinted around each turn. A change raises `acp-seat-wrote-record`; an unreadable tree raises `acp-seat-record-unmeasured`. In both cases deletion of the return is attempted, and the return is not read or rerun even if deletion fails. The check misses records changed and restored before the after-check, and writes after an unproven teardown.

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
  Revised 2026-11-04 by operator decision: the tech-lead runs at high; since 2026-11-02 it returned 42 times over
  29 judge lanes, with 39 passed, 3 changes-needed with should-fix findings only, no must-fix findings, and 668k output
  tokens over 22 turns on 2026-11-04, the most of any seat.
- **Builder (first 10 lanes):** test lines as a share of code lines added (the 18 corpus lanes: 804 of 1196, 67%), tests
  named per lane, tests red on the old source and green on the build out of tests named, and builder tokens. Lanes
  differ in size from the corpus, so the share is compared, not raw lines. The §3 rules stay if the share falls. The
  `code-less` arms comparison (today's, the v5-based, none) is not run; v5 replaces today's skill as §10 states.
  **Measured 2026-11-03** (`~/.crew/reviews/adr-055-readout-2026-11-03.md`): test share was 1205 of 1754 lines,
  69% over 10 lanes, and 974 of 1505, 65% over 8 lanes with mechanical and deletion-dominant lanes removed,
  against the corpus 804 of 1196, 67% over 18 lanes. First proof was red on old and green on build for 45 of 46
  named tests over 9 lanes.
- **Planner (first 10 lanes):** tests named per lane, plans the reviewer or lead sent back to the planner, and builder
  `insufficient` returns. The blind plan pass against the 11-01 control (11 of 42) is dropped: that review scored the
  gate, which §8 removes.
  **Measured 2026-11-03** (`~/.crew/reviews/adr-055-readout-2026-11-03.md`): the median was 6 tests named over
  9 non-mechanical lanes; there were 3 plan re-runs and 3 builder `insufficient` returns in 2 of 10 lanes.
- **Loops (replaces ADR-054 §3):** per tier, total wall time, rounds, suite-repair turns, lead consults, operator
  stops and defects found after merge (a later fix commit on main whose blame lands on the lane's lines). The build
  loop is not adopted on the ADR-053 replay, since ADR-053 is rejected.
  **Not yet measured:** the first 10 lanes ran on a changing loop. Measurement waits on about 10 lanes run on
  b1514's round budgets.

Passive data from the wave lanes, which ran while the contract changed and so do not count toward the 10: b1485 to
b1489 (PRs 2127 and 2129 to 2132) added 782 test and 490 source lines, a test share of 61%.

## What this does not decide

- Provider fallback and the reviewer's model and effort.
- Whether the advisor and memory arms stay after their next measurement.
- How the review is posted on GitHub.

If ratified, this record rejects ADR-053; supersedes ADR-030, ADR-038, ADR-048, ADR-049 and the acceptance parts of
ADR-052 (P1's acceptance field, P3 and §6's proof); and amends ADR-054 §2 (the proof), §3 (the measurement) and §4
(choosing the tier) and ADR-051 (gate repair and re-aim).

## Amendment 2026-11-17: no test by default

Ratified by the operator in issue #2437. This supersedes the test-selection
instructions in §§2–3 and §10's non-trivial-logic test mandate, and extends §5's
review guidance. The original 2026-11-02 decision text above is retained.

A lane adds no test by default, in every checkout. Two exceptions:

1. A bug fix gets one regression test.
2. A change where a failure would lose data, cross a security boundary, or break
   a wire or file format another program reads gets one test when no existing
   test already covers that path.

When the brief's ask is itself to add or change tests, the ask governs. Where a
test is called for, add an assertion or table row to an existing test that already
drives the path before writing a new test. Repairing or removing an existing test
that the change breaks is maintenance, not an added test. This does not authorize
a test-deletion campaign.

The planner lists only changed behaviour selected for testing in Properties.
Each property names its exception (or explicit test ask), criteria and one test
by file and title. All other changed criteria go under Not machine-checked with
the reason that the rule calls for no test. A testable criterion alone does not
require a test. When Properties has none, return `tests: []`. A characterization
or test-hardening test is a suite regression lock only when the brief asks for
it or an exception applies; it stays outside Properties and proof `tests`.

The builder makes the change first and writes only plan-named tests. An
unplanned added test needs an applicable exception in `notes`. A mechanical
builder applies the same rule without a plan. The reviewer and, through its
charter, the tech-lead require removal as a `must-fix` of a new unplanned test
whose builder notes justify neither exception. Explicit test asks and necessary
existing-test maintenance are allowed. A missing-test finding requires an
applicable exception and no existing test covering the path.

This is one charter rule, not a per-project policy field. The proof, suite gate,
review and PR proof-line contracts do not change. An empty planner `tests` list
already permits a planned lane with no proof; this amendment changes when seats
choose tests, not what code checks.

### Reported baseline and follow-up

Issue #2437 reports these lane-journal counts since 2026-11-04, using the last
planner return of each lane. They were not re-measured for this amendment:

| Checkout | Lanes with a plan | Tests named | Median per lane | Plans naming none |
|---|---|---|---|---|
| the-power | 152 | 583 | 3 | 15 |
| this repository | 129 | 455 | 3 | 9 |

The issue also reports 6,383 Rust tests in the-power at stable `938e2bc6`, with a
covering set of 2,072 tests running every product region the full suite runs,
and 34,217 test-file lines against 23,719 other-code lines in this repository.
These are reported measurements, not measurements performed by this change.

After 20 planned lanes per checkout on the new charters, repeat the table's
counts from the last planner return of each lane: planned lanes, total named
tests, median named tests per lane and plans naming none. Target: a median of 0.
Also count bug-fix lanes whose defect was introduced by a lane with no test,
reporting that count against the number of bug-fix lanes inspected. The
follow-up has not run; no measurement tooling is added here.

### Clarification 2026-11-17: tests named in issues (#2438)

The explicit-test-ask override applies only when adding or changing tests is the
purpose of the lane. A test merely named or listed within a behaviour change in
the source or a referenced issue follows the same no-test rule and its exceptions.
Referenced issues remain context, not asks.

When the planner omits such a test under the rule, Not machine-checked names the
test and explains why the rule calls for no test. The reviewer and tech-lead do
not report that omission as an unmet requirement merely because an issue names
the test. Findings justified by the existing exceptions or an unmet ask for a
lane whose purpose is adding or changing tests still apply.

Issue #2438 identifies an interpretation risk, not a measured planner failure.
The exceptions, proof and suite contracts are unchanged.

## Amendment 2026-11-19: conflict turns on a moved base (#2498)

The operator supersedes the one-turn limit. Initial finish, pre-check and
publishing rebases share at most three builder conflict turns per run. The first
conflict gets a turn. A later conflict gets one only if its attempted base commit
differs from the previous turn's target. An unchanged or unmeasured target, a
conflict after the third turn, or an unresolved turn stops `rebase-conflict` with
the existing cleanup. The moved-head recheck and review and suite bounds are
unchanged.

## Amendment 2026-11-21: proof-only recheck after a disjoint publishing rebase (#2532)

The operator keeps the publishing rebase and narrows the earlier moved-head
recheck rule. A build or judge lane, including a planning resume, keeps the
rebased commit and repeats only proof when no builder
conflict turn ran, all three path lists are measured, the lane path set is
unchanged, and it shares no path with the base's changes. A rename counts
under both names. The loop proves every named test against the new base or
makes no proof call if there are no named tests. Before publishing, it checks
that the worktree is clean and `HEAD` is the rebased commit. It does not fetch
again, rerun the suite, or open another review round.

If a condition fails or proof is not green for every named test, the full
recheck still applies. The skip spends none of the three rechecks and grants
no rounds. Finish passes retain the full recheck without measuring scope.
Mechanical lanes still repeat proof and the suite on the committed rebased
head. The `recheck-scope` row and PR Verification name the checked commit,
both bases and the rebased commit; the suite and reviews did not check the
rebased head.

A base change can break a lane through another file, for example by changing a
function the lane calls. Proof may miss that break. Of the finished disjoint
rechecks measured on 2026-11-21, none of 15 in the-power found anything; the
one in devteam found a red test neither side touched. After 30 more publishing
rebases that move the head, count skips and full rechecks across checkouts.
For each skipped PR, note whether a later red suite on the base was traced to it.

## Amendment 2026-11-22: skip the suite after a lock-file-only publishing rebase (#2538)

The operator kept scoped review after a publishing rebase and approved skipping
its suite when the only paths shared with the base's changes are lock files.
This applies to build and judge lanes, including planning resumes, under the
same conflict, path measurement and path set conditions as the disjoint skip.
A shared path counts as a lock file when its last segment is exactly
`Cargo.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
`yarn.lock`, `bun.lock`, `bun.lockb`, `go.sum`, `poetry.lock`, `uv.lock`,
`Gemfile.lock` or `composer.lock`. This list is built in. Both names of a rename
still count.

The lock-file recheck spends one of the three publishing rechecks and keeps the
rebased commit. It repeats proof for any named tests against the new base, then
runs every configured fast check in order. With no fast checks, non-green
proof, or a red or unmeasured fast check, the loop takes the full recheck. A
worktree change visible to Git or a moved head during checks also takes the
full recheck. The loop does not discard check writes to make the shortcut pass.

If the checks pass, the reviewer (and the tech-lead on judge) performs a scoped
review without starting the suite or reusing an earlier pass. A request for
changes returns the lane to the uncommitted builder path on the new base, with
no suite skip on the next build. Publication after a pass still requires a clean
worktree at the measured rebased commit. The `recheck-scope` row keeps
`review: "scoped"` and adds `suite: "skipped"`, `reason: "lockfile-only"` and the
shared paths. It and PR Verification name the commit the suite ran on, both bases
and the rebased commit. The PR names the green fast checks and scoped review on
the rebased commit. The disjoint proof-only skip still takes precedence and
spends no recheck. Finish and mechanical lanes are unchanged.

A dependency bump can change lane behavior even when the fast checks pass.
The two lock-only rounds among 45 scoped rebase reviews measured on 2026-11-22
both passed review and neither found a defect. After 30 more publishing rebases
that move the head across checkouts, count lock-file rechecks, their review
verdicts and any later red suite on the base traced to one.
