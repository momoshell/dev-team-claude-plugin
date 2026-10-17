# ADR-051 — Escalated lanes are finished by a `finish` shape: the builder codes, Sol reviews, the operator decides

**Status:** *ratified* 2026-10-16, operator decision (see "Operator direction" and "Decided questions") · **Owner:** operator ·
**Relates to:** ADR-034 (the driver publishes), ADR-044 (declared topologies name hand-written executor
paths), ADR-045 (scope is context), ADR-050 (seat skills by role pack)

An escalated lane whose build is sound is today finished by hand: an operator session forks a Claude agent
that diagnoses, fixes, rebases, runs both suites, drives Sol reviews and opens the PR. The procedure is
`skills/crew-recovery/references/hand-finish.md`. This record moves the coding into a builder seat, keeps
Sol as the reviewer, keeps every mechanical step in the driver, and ends the run at a decision the operator
session makes.

Every repository `file:line` below was read at `39f56478`.

## What a hand-finish costs today (measured 2026-10-16)

b1214-providerstall escalated when the driver crashed at `review:r1` (`acp-session-busy`). Its hand-finish
fork ran 63 minutes and 79 tool calls on Opus, about 281k subagent tokens, and drove six Sol passes. Of the
work it did:

- **mechanical, already automated elsewhere in the driver:** rebase onto `origin/main`, the warm and cold
  suites, the gate re-run, anchor pin repair, the PR body with denominators;
- **coding:** fixes for three rounds of Sol findings, a fixture reshape the PR hook required, and tests the
  planner's gate had left unchecked;
- **judgment:** whether the lane was finishable at all, and what to state as residual.

Fourteen `*-build.patch` files sit under `~/.crew/batch-2026-10-1*` (2026-10-10 to 2026-10-16). Not every
saved patch was a hand-finish (b1212's was a partial build re-dispatched by adoption), so the hand-finish count
for the period is unmeasured. Hand-finish fork token totals before b1214 were not recorded.

## Decision

### 1. A `finish` execution shape

`crew/variants.mjs` gains a `finish` shape, a hand-written executor path in the sense of ADR-044:

`finish-triage` → `build` → `lane` → `gate` → `review` → `commit` → `rebase` → `suite` → `suite:cold` →
`decision`

- It runs **in the escalated lane's own worktree, on its uncommitted build,** under the same crew dir. It
  does not cut a new worktree or re-plan.
- **`finish-triage`** gives the builder the escalation (from the lane's `task.json`, including a driver crash
  that wrote no `escalate:*` stage), the lane's own accepted plan and gate, and any open review findings. The
  builder writes the smallest fix, with the same contract as the `repair` shape's triage
  (`crew/variants.mjs:106`) but against the lane's build instead of CI output.
- **`gate`** re-runs the lane's already-proven gate. A gate check the finish run changes must be re-proven by
  mutation, as in any lane.
- **`review`** is Sol through the roster's reviewer seat, capped at three rounds; after the third, only a
  data-loss or false-clean finding blocks (the operator's review-pass rule of 2026-09-25).
- **`decision`** replaces `publish`. The run stops with the lane committed, rebased and suite-green, and
  writes a finish report (section 3). Nothing is pushed.

### 2. Seats

- **Builder: the roster's builder seat** (on today's roster, `meta/muse-spark-1.3-contributor` on pi). It owns
  every code change in the run, including test reshapes and anchor edits it cannot leave to `--repair-all`.
- **Reviewer: the roster's reviewer seat** (`openai/gpt-6.1-sol` on pi). It reviews the whole lane diff
  against `origin/main`, not only the finish delta, because the lane never reached `review:pass`.
- **No planner, lead or tech-lead.** A finish that needs a plan is a re-dispatch (section 4).

### 3. The operator session decides

The run ends at `decision` with a finish report in the crew dir: the original escalation; the builder's
changes; every Sol verdict with its findings and dispositions; gate, mutation and suite results with
denominators; and the residuals the builder or Sol named. It is one fused record, so the deciding session
reads it instead of reconstructing it from the journal.

The operator session then runs exactly one of:

- `crew finish --task <lane> --accept [--notes <file>]` — the driver publishes (ADR-034's publish stage),
  folding the operator's notes into the PR body under their own heading. The notes are where the session adds
  what it learned during the task: premise corrections, cross-lane context, residuals the seats could not see.
- `crew finish --task <lane> --return <file>` — one more `build`→`decision` pass with the operator's guidance
  as the triage input, counted against the review cap.
- `crew finish --task <lane> --abandon` — the run ends; the lane is re-dispatched or closed by hand.

A decision is a journal row (`finish-decision`) with the choice and the notes' digest.

### 4. When `finish` refuses

`crew finish` refuses before any seat starts, with a closed reason, when:

- the lane has no build (`finish-no-build`): it died at plan, so there is nothing to finish;
- the escalation is a premise or plan escalation (`finish-premise`): `hand-finish.md` routes these to
  re-dispatch, and that call stays with the operator;
- the worktree is gone or dirty in a way the lane did not cause (`finish-worktree`).

## Rejected

- **A Claude fork with a `/finish` command.** It keeps all of the work, including the mechanical steps, on
  Opus tokens. It stays the fallback until this shape ships.
- **A one-shot pi builder told to follow `hand-finish.md`.** The builder would redo rebase, suites and PR
  composition the driver already automates, and nothing structured would come back for the decision.
- **Driver auto-publish after review.** The operator wants a session that holds cross-lane knowledge to
  decide, and a finish is by definition a lane that already escaped the normal acceptance path once.

## Prerequisite

The b1214 crash itself: `acp-session-busy` at a lead consult crashed the driver and wrote no `escalate:*`
stage. It is fixed in its own lane (b1219-acpbusy), not by `finish`.

## Lanes

1. **The shape and its stages:** `finish` in `crew/variants.mjs`, the executor path, `finish-triage`, the
   reuse of the lane's gate, and the review cap.
2. **The decision surface:** the finish report, `crew finish --accept | --return | --abandon`, the
   `finish-decision` row, and notes folded into the PR body.
3. **Refusals:** the three closed reasons of section 4, with tests from archived escalated lanes.

## Operator direction (2026-10-16)

Option C of three: the builder seat is responsible for everything coding-related, Sol reviews it, and the
orchestrating session decides, fusing what the models and the operator learned through the task, then
completes it.

## Decided questions (2026-10-16, operator delegated the picks)

1. **`--accept` publishes only.** It opens the PR; merging stays the operator's, as for every lane.
2. **The review cap is three rounds,** matching the hand-finish rule it replaces; after the third, only a
   data-loss or false-clean finding blocks.
3. **This repository first.** Lanes from other repositories (the-power) follow in a later wave, once `finish`
   has finished lanes here; their reviewer seats and suites differ and are not measured under this shape.

## Amendment 1 (2026-10-17)

The shipped heads supersede section 1:

- scope-gate kept (reviewed loop emits it unconditionally; feeds review brief via S.scopeChanged)
- gate-baseline dropped (a dirty-tree baseline measures nothing)
- suite:cold folds into suite (its head does)
- decision replaces publish (nothing pushed; the operator decides)
