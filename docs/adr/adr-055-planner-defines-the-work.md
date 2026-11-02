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

### 2. The planner defines the work

`plan.md` takes Kiro's shape, trimmed:

- **Criteria:** numbered, one line each, `WHEN <trigger> THE <code unit> SHALL <observable result>`, written after the
  planner has read the code, each naming the file or function it applies to.
- **Properties:** each states what must hold, lists the criteria it validates, and names one test (file and title). One
  test per property, not per criterion.
- **Not machine-checked:** criteria no test can check, listed as such.
- **Tasks:** an ordered checklist, at most two levels, each citing its criteria and the test that proves it, or
  "not machine-checked" when its criteria have no test.

The planner envelope keeps `subject`, `plan_path` and `files_in_scope`, adds an optional `judge` (a one-line reason),
and drops `acceptance`, `gate_path`, `gate_cmd` and `mutations`.

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

A builder that names no test while the plan names one, or a named test that is unproven, sends the lane back to the
builder within its rounds. When the plan lists every criterion as not machine-checked, no test is named, the PR states
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
proof. A mechanical lane has no plan, so when it is raised, or its builder returns `insufficient`, it restarts from
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
| 2 | planner | judge | §1, §2 and §7: the brief without acceptance, the plan shape, the `judge` raise and the path raise |
| 3 | reviewer | judge | §5, `notes` in the reviewer prompt, the tech-lead second review on judge lanes, map grants for the tech-lead |
| 4 | loops | judge | ADR-054's three loop shapes |

Wave 1 lanes run side by side; worktrees isolate them and the rebase resolves overlap. The proof lane's brief is the
last that carries acceptance ids.

## Measurement before ratifying

- **Builder (wave 1, seat knowledge):** replay the builder on the 18 corpus lanes, one run per arm, with §3's charter
  and `test-economy` in every arm: today's `code-less`, the v5-based `code-less`, and none. One blind diff review.
  Report test and source lines (today 804 and 392), blind pass (today 12 of 18) and tokens (today a median of 261k).
  The rules stay if test lines fall and blind pass does not. The v5-based skill replaces today's if its tokens fall and
  blind pass and source lines are no worse; if it is no better than no skill, `code-less` leaves the builder and its
  structure and tie-break rules move into the charter. Repeat on the feature-sized lanes once they exist.
- **Planner (wave 2):** replay the planner on the 18 corpus lanes with the acceptance ids removed from their briefs.
  Report tests named per lane and blind plan pass against the 11-01 control (11 of 42).
- **Reviewer (wave 3):** replay the reviewer on the 10 known-defect lanes, three runs each. Report changes verdicts with
  a finding naming the defect file, against today's 9 of 30.

## What this does not decide

- Provider fallback and the reviewer's model and effort.
- Whether the advisor and memory arms stay after their next measurement.
- How the review is posted on GitHub.

If ratified, this record rejects ADR-053; supersedes ADR-030, ADR-038, ADR-048, ADR-049 and the acceptance parts of
ADR-052 (P1's acceptance field, P3 and §6's proof); and amends ADR-054 §2 (the proof), §3 (the measurement) and §4
(choosing the tier) and ADR-051 (gate repair and re-aim).
