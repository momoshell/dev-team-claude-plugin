# ADR-054 — Each tier runs its own loop, and every stage earns its place

**Status:** *proposed* 2026-11-01, operator direction ("each lane type should have its loop") · **Owner:** operator ·
**Relates to:** ADR-052 (§6 the loop), ADR-053 (build first, prove after), ADR-038 (the judge floor forces proof),
ADR-051 (finish shape)

Today every lane runs the same loop whatever its tier; the tier only changes which models sit in the seats and their
effort. This record gives each tier its own loop and states the rule a stage must meet to be in one.

## Why (measured 2026-11-01)

An audit of 95 archived lean lanes (`~/crew-bench/loop-logic-audit-2026-11-01.md`; timings over the 44 lanes since
10-30 that carry timestamps) found stages that cost turns without changing outcomes:

- **The suite runs after review.** 36 of 116 suite runs were red, and each of 13 suite-repair turns then repeated the
  gate, the proof and the review.
- **The suite re-run after a red** left 16 of 17 lanes red: it changed no outcome.
- **The lead on the normal path.** 35 consults: 23 bounces, 8 escalations, 1 accept, 3 refused. It escalated 3 of 3
  builder escalations unchanged. After a builder `insufficient`, the next builder envelope was `done` in 2 of 14.
- **The rebase comes last.** In 12 of 69 lanes it moved HEAD, and the PR's measurement lines describe the tree before it.
- **Passing reviews drop their findings.** 22 of 87 passes carried findings (15 `should-fix`) that reached neither the
  builder nor the PR.
- **Planning is the largest share of wall time:** 185 of 471 stage minutes over the 44 timed lanes, against 131 for
  build and 111 for review. The blind score of a first plan does not sort lanes by outcome
  (`~/crew-bench/plan-review-vs-outcome-2026-11-01.md`).
- **Reviewers miss real bugs.** On 10 lanes whose built change carried a defect a later lane fixed, the live reviewer
  caught 9 of 30 runs and the same model at xhigh 14 of 30; four defects were caught by no GPT reviewer, `sol-review`
  included (`bench/README.md`).

The tier mix is lopsided: of 97 archived lanes, 90 ran `build`, 6 `judge` and 1 `mechanical`. The build loop below
rests on that evidence; the mechanical and judge loops are design until their own lanes are measured.

## Decision

### 1. The rule

A stage is in a tier's loop only if it makes the change, proves something mechanically, or has a measured catch rate
worth its cost on that tier. A stage that fails the rule leaves the loop. No loop promises the best result; each keeps
every guarantee the loop can prove.

### 2. The loops

Every loop rebases onto `main` before the build, runs the ADR-053 proof (each acceptance id red on base, green on the
build, red under its kill-mutation), runs the suite once with no automatic re-run, and puts a passing review's
`should-fix` findings into the PR body.

```
mechanical:  brief -> rebase -> build -> prove -> suite -> PR
build:       brief -> [plan] -> rebase -> build -> prove -> (suite || review) -> one fix turn if either is red -> PR
judge:       brief -> plan -> rebase -> build -> prove -> suite -> review -> second review -> one fix turn if any is red -> PR
```

- **Mechanical** is for changes with no behaviour to judge: a rename, a config value, docs, a version bump. The brief is
  the plan. The proof and the suite are the check; there is no review. A seat's `insufficient` or `escalate` stops the
  lane for the operator.
- **Build** runs the suite and the review side by side and hands the builder both results in one turn. A plan gap
  (a builder `insufficient` that names one) goes back to the planner once. A seat's own `escalate` goes to the operator
  without a lead round. Whether build keeps its planner is decided by measurement (§3); `[plan]` marks it as open.
- **Judge** keeps the stages sequential so each sees a green predecessor, adds ADR-038's mutation on the changed
  behaviour, and adds a second review by the tech-lead seat, a different model family from the reviewer. Escalations go
  to the lead, then the tech-lead.

### 3. Measurement before each loop is adopted

- **Build** first, on the ADR-053 replay of the 14 code corpus lanes with three arms: today's loop, build-first with a
  planner, and build-first with the builder working from the brief alone. The shortest arm that is not worse on blind
  diff pass and on known-defect catches becomes the build loop.
- **Mechanical** and **judge** after their first 10 lanes each, compared on rounds, wall time, suite repairs and defects
  found after merge against the build tier.
- **Every loop** reports per lane: total wall time, rounds, suite-repair turns, lead consults, and whether the PR's
  measurement lines describe the merged tree.

### 4. Choosing the tier

The brief's `tier` chooses the loop, and the `lane-brief` skill states when each applies. A change that touches the
loop's own enforcement or a decision record stays `judge` (ADR-052). A `mechanical` brief must name no behaviour change;
a lane that turns out to change behaviour is a wrong tier, and the operator restarts it as `build`.

## What this does not decide

- **The shapes.** `stepped` and `finish` keep their current paths; this record only changes `standard`.
- **Provider fallback.** A provider usage limit stopped every pi seat on 11-01; failing over to a declared fallback is a
  separate decision.
- **The reviewer's model and effort,** and which skills each seat holds.

If ratified, this supersedes ADR-052 §6 for the `standard` shape.
