# ADR-034: The driver publishes — rebase, prove, push and open the PR are the run's last stages, not a human's

**Status:** RATIFIED 2026-08-29 (operator, on #679) · **Source:** issue #679 · **Evidence:** 15 lanes closed out by hand on 2026-08-29 (PRs #738–#761), each ~12 orchestrator steps; #758 (the batch closeout as code); the b321 plan checks (`~/.crew/dt-b321-driverpublish/*.archive-*/task/plan-check.md`)

## 0. The decision, in the operator's words

> I don't have anything against the driver creating and pushing PRs; make this
> step programmatic so we don't burn model tokens on those simple steps. This
> should be true for all steps that we have or that happen — programmatic as
> possible, repeatable and measurable.

Two rules follow, one specific and one general.

1. **The driver publishes.** A run that reaches a green cold verification
   pushes its lane branch and opens the pull request itself, as the last stage
   before teardown. No seat types it and no orchestrator types it.
2. **Every lifecycle step code can do, code does.** Judgment stays with seats
   (plan, adversarial check, review, the lead's decisions). Mechanics — rebase,
   proof, push, PR body, merge check, reaping — are code, emit one measurable
   record per step, and run identically every time. A step done by hand twice
   is the trigger to file the lane that removes it.

## 1. Context — what publication cost while it was a human step

Until this record, `crew/drive.mjs` ended a run at `commit` → `suite:cold` →
`done`, and publication was the closeout's job. Measured on 2026-08-29 across
fifteen lanes: each closeout was a hand sequence of quiet-tree check, preserve,
teardown, verify, rebase, gate, suite, cold-verify, push, a PR body written
from the run record by a model, a merge check, and a worktree reap — about
twelve orchestrator turns per lane, varying lane to lane, all model tokens.
The `skills/devops/references/lane-branches.md` rule *"never publish from a
worker path"* encoded the old posture; its own status line records that no
checkout implementation ever backed it.

The b321 plan checks found what a naive publish stage gets wrong, and this
record adopts those findings as constraints: a run must return the **post-**
rebase SHA, never the one it committed before rebasing; the suite and the cold
verification must run on the rebased commit, because that is what gets pushed;
the gate must enforce the fetch and the publication record with durations, not
merely perform them; and the teardown policy must not leak a non-publishing
shape (a scout) into publish-then-teardown.

## 2. Decision — the stage order and its refusals

After `commit`, the reviewed shapes run:

| stage | does | refuses |
|---|---|---|
| `rebase` | `git fetch origin main`, then `git rebase origin/main` in the lane checkout; records `rebased: false` when `main` did not move | a conflict → `escalate:rebase`, naming the files, tree restored by `git rebase --abort` |
| `suite`, `suite:cold` | on the **rebased** commit | as today |
| `publish` | `git push -u origin <branch>`; `gh pr create --base main --head <branch>` with a body composed **purely** from the run record (`composePrBody`, a pure function beside `composeCommitMessage`) | no `gh`, `gh auth status` non-zero, push rejected, a PR already open for the branch, or the branch is `main` → `escalate:publish` with the reason; the commit stays local and intact |
| `done` | records `details.pr = {url, number, head, base_sha}`, a `published` journal row with the durations of rebase, push and pr-create, and the ledger phase `publish`; tears down unless `--keep` | an escalation never tears down |

The PR body contains nothing the record does not: the `Refs` trailer, the stage
trace, round counts, gate summary and discrimination, the final review verdict
and residuals, suite counts, the cold-verify checkout, and one line per anomaly
row (`wait-extended`, `gate-repair`, a `bounce`, `tree-witness`).

Publication ends at an open PR. Merging, branch deletion, issue closing and
worktree reaping are the batch closeout's (#758), never the driver's.

## 3. What this supersedes, and what it leaves standing

- Supersedes `lane-branches.md`'s *"never publish from a worker path"* for the
  driver: the driver publishes from the lane worktree, after cold-verify, as
  the last step before teardown. The rule still holds for every seat.
- Supersedes the normal closeout order in `skills/crew-recovery/references/closeout.md`
  (*preserve → commit → prove → suite → push+PR → teardown*): commit, prove,
  rebase, push and PR are the driver's; the human sequence becomes
  *preserve → verify → merge-check → (after merge) reap*, and #758 makes those
  code too.
- Leaves standing: ADR-030's gate custody; the directed variant's
  outside-authored gate; the escalation policy; and the rule that an escalated
  lane keeps its workspace.

## 4. What stays a human step

Deciding to merge. Deciding to re-dispatch an escalated lane. Ratifying a
posture. Everything else in the lane lifecycle is expected to be, or become,
code.
