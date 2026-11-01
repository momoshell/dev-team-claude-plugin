# ADR-053 — Build first, prove after: the builder writes the acceptance tests and the loop proves them

**Status:** *proposed* 2026-11-01, operator direction · **Owner:** operator ·
**Relates to:** ADR-052 (P3 acceptance gate, §6 the loop), ADR-038 (judge floor forces proof), ADR-051 (finish shape)

Today every acceptance id is checked twice. The planner writes `task/gate.mjs` before any code exists, from a seat
that cannot run Node, and the builder then writes repository tests for the same ids. This record moves the proof
into the tests the builder commits, and moves the proof step after the build: the loop shows each new test fails
on the unchanged source, passes on the build, and fails under its kill-mutation.

## Why (measured 2026-11-01)

- **Two artifacts for one fact.** Over 14 corpus lanes (`bench/corpus`, builder replays in
  `~/crew-bench/codemode-2026-11-01`), each lane's gate is 47 to 259 lines, and the builder adds repository tests for the
  same ids: 34 new top-level tests for 42 acceptance ids (2 to 5 per lane), exactly one per id in 6 of the 14 lanes. Of the 790 lines the live builder added, 567 (72%) are test lines;
  the median source change is about 6 lines. The gate lives in the task dir and is never committed, so the
  repository test is the only lasting record of the proof.
- **The gate is written blind.** Planner seats may run only read-only commands, so the planner authors the gate
  without running it. Strict blind review of first plans fails most of them: 160 of 210 runs across 14 lanes in the
  11-01 planner batch (`~/crew-bench/planner-arms-2026-11-01`; 49 passed, 1 had no plan to review), and the recurring findings are gate holes that a run would expose (one sample of an input space,
  checking a helper instead of the path the brief names, single-step fixtures that miss later turns, a gate that
  fails a correct build). Four planner changes tried on 10-31 and 11-01 (a `qa-test-writing` grant, fff, a charter
  paragraph, the lab with a self-proof instruction) moved none of this beyond noise; the lab self-proof cost 2.9x
  tokens and scored worse (5/42 against 14/42).
- **Mutations are declared blind too.** The planner predicts post-build `find` text before the build exists. An
  audit of 95 archived lean lanes (`~/crew-bench/loop-logic-audit-2026-11-01.md`) counts 49 of 653 mutation rows not
  killed (34 `bind-fail`, 14 survived) and 8 of 95 lanes stopped on a proof defect, not a code defect. When the
  builder re-aimed the mutations it had built against, the next proof was clean in 10 of 10 cases.
- **The proof is not on what ships.** The kill-mutation proof runs against `gate.mjs`, which is never committed, while
  the PR body reports "Mutations N/N killed". The repository tests that ship get no kill-proof. The baseline only
  needs one red id: 31 of 90 baselines were red on a strict subset of the acceptance ids.
- **The duplication is instructed.** The `lane-brief` skill makes each acceptance item "checkable by a top-level
  `test(...)`", the planner's team memory (`mutations-must-bind`) asks for a top-level repository test per acceptance
  outcome with a `// MUTATION:` comment, and the planner charter asks for the gate as well.

## Decision

### 1. The order

```
plan -> build -> prove (red on base, green, kill-mutations) -> review -> suite -> commit -> PR
```

The reviewer reviews the code and its tests together, with the proof rows in hand.

### 2. Roles

- **Planner.** Returns the plan, the acceptance ids, `files_in_scope` and the test command. No gate and no mutations.
- **Builder.** Writes the change and one repository test per acceptance id. A test is bound to its id by name: the
  test's name starts with `(<id>) ` (the shape the briefs already use for acceptance items). The builder also declares one
  kill-mutation per id (`{check, file, find, replace}` against the source it built), since it holds the code the
  `find` text must match. The builder may run the tests it wrote.
- **Loop.** For every acceptance id, mechanically:
  1. **Red on base:** apply only the builder's test-file changes onto the pre-build source and run the bound test.
     It must fail. A test that passes without the change proves nothing.
  2. **Green:** the bound test passes on the build.
  3. **Kill-mutation:** with the id's mutation applied to the build, the bound test fails.
  Each step reads the runner's per-test results, never only its exit code: the bound test must be observed
  running and observed failing (or passing). Only a failure raised by the test's own body counts as red. A test
  file that fails to import, a bound test that is skipped, cancelled or never runs, a failing hook (`before`,
  `beforeEach`, `after`, `afterEach`; node reports these as `hookFailed`), or a runner that reports no result for it
  is not red; it is unproven. The guard that rejects hook and import failures needs its own kill-mutation. Measured 11-01: an empty `(A1)` test in
  a file that cannot import on base gave base red, build green and mutation red by exit code alone, and a `beforeEach`
  that fails on base and under mutation made node report the empty `(A1)` test itself as failed in both.
  An id with no bound test, a bound test that did not run, a test that is green on base, or a surviving mutation
  stops the lane with that reason, as an unproven gate does today.

### 3. The finish shape

Today a finish run starts at build and skips the baseline (`crew/loop.mjs`). Under this record a lane can stop after
the builder returns and before the proof, so finish must run red-on-base too, unless the journal already holds a red
proof for the same bound test content. Without it, a test that already passes on base would clear finish's green and
mutation checks. Mutation re-aim keeps its current behaviour against the new proof.

### 4. Protocol change

P3 changes from "`task/gate.mjs` prints `FAIL <id>`" to "acceptance tests: committed repository tests bound to ids by
name, red on base, green after, one kill-mutation each". The planner envelope drops `gate_path`, `gate_cmd` and `mutations`; the builder envelope carries `mutations`, one per
id. Every id must be red on base, not at least one as the baseline check accepts today. The
test command is the brief's `suite` runner narrowed to the bound tests.

## What this does not decide

- **Runners other than `node --test`.** Narrowing to one named test differs per runner (`--test-name-pattern`,
  `cargo test <name>`, `vitest -t`). The first build supports `node --test`; other runners refuse with a stated reason
  until each is added.
- **Confirmation bias.** A test written after the code can be shaped to the code. Red-on-base and the kill-mutation
  are the guards, and the reviewer sees both; whether they are enough is what the measurement below checks.
- **Test economy.** How many and how small the tests should be is skill guidance (`qa-test-writing`, `code-less`)
  and brief guidance (fewer, coarser acceptance ids), decided separately.

## Measurement before ratifying

Replay the 14 code lanes both ways, 3 runs per arm, one blind diff review: today's flow against a planner without a
gate and a builder that writes the bound tests, proved as in §2. Report source lines, test lines, blind pass, the
proof outcome per id, and catches on the known-defect lanes (`bench/corpus` manifests with `knownDefect`). Ratify
only if blind pass is not worse and the lines added fall. If ratified, this supersedes ADR-052 §3 P3 and §6.
