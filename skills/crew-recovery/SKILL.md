---
name: crew-recovery
description: >-
  Load when a lean crew lane has stopped and you must read it, finish it, or
  close it out: crew show, crew lanes, the lane journal, crew finish with
  --accept, --return or --abandon, crew record-pr and crew closeout.
---

# Crew recovery

A stopped lane keeps its worktree, branch and journal until you close it out.
Read first, decide second, remove last.

## Read a stopped lane

- `crew lanes [--all] [--json]` lists lanes with status, latest stage, stop
  reason and PR, read from each lane journal (`crew/lanes.mjs`). A run its
  recorded pid proves dead lists as `stopped` with reason `run-died` (`deadRun`
  in `crew/run-pid.mjs`). It never reports a process as alive. `crew lanes`
  signals no process; `crew closeout`, and `crew finish --return` or
  `--abandon` of a dead run, stop proven seat groups.
- `crew show <lane>` lists each seat and its recorded sessions;
  `crew show <lane> <role>` prints that seat's session as text and `--json`
  prints the recorded JSONL untouched (`crew/show.mjs`). Read-only.
- The lane journal is `~/.crew/dt-<lane>/<lane>/task/journal.jsonl`: one JSON row per
  event. The last rows say why the lane stopped. Never edit it by hand.

## Finish it

`crew finish <lane>` reports the stop or ready state without changing the lane.
`crew finish <lane> --return <file>` starts a finish pass on any finishable stop,
including an escalation or a provably dead run, with the file as builder guidance.
Use `--return` when the existing plan still fits the build. A finish pass keeps
the plan and recorded roster; it cannot return work to the planner (ADR-051).
If the stop's lead names a plan gap or asks to reopen planning, end the lane with
`crew finish <lane> --abandon` and `crew closeout <lane> --discard`, then start
it again from its brief so the planner writes a new plan.
On an escalation, the file answers the operator question. The pass re-enters the
lane in its own worktree and rebases onto the current base,
then runs builder triage, proof of the builder's named
tests, review, suite, commit and rebase. A base conflict gets one builder conflict
turn; an unresolved or spent turn stops with the build uncommitted. A mechanical lane is finished on its brief; one
whose diff reaches a protected path stops `raise-needs-plan`, and you restart it
from its brief as a build lane.
Only the checked tree is committed; a rebase that moves the head repeats proof,
review and suite on the new base. It publishes nothing (`crew/finish.mjs`).
When that run is ready, decide once:

- `crew finish <lane> --accept [--notes <file>]` publishes the PR the run
  measured. Merging stays yours.
- `crew finish <lane> --return <file>` runs one more finish pass with the file
  as the builder's guidance; it counts against the three review rounds.
- `crew finish <lane> --abandon` ends the lane unpublished. It also decides a
  stopped lane, once per stop.

It refuses, writing nothing, for a cause in `FINISH_REASONS` in
`crew/finish.mjs`; read the refusal, it names the cause. A committed, unpublished
build at HEAD on the lane branch is uncommitted before launch when its remote
branch is absent. A provably dead open run is a new stop.

## Close it out

For a stopped lane with no PR or a PR GitHub reports CLOSED, use
`crew closeout <lane> --discard`. It also archives a lane ended with
`crew finish <lane> --abandon` or accepted before its PR closed. A lane without
a journal can be discarded if its run is not live. It removes the worktree and
local branch and archives the lane; it leaves the remote branch and visualizer
unchanged. It refuses an OPEN or MERGED PR (use plain closeout after merge or
discard after close), other finish records, a run not proven stopped, uncommitted
changes, or a tip on neither a remote-tracking ref nor the base. Removal is never
forced. An absent worktree is skipped on retry and its branch is not checked.
Inspect the lane first: discard removes its worktree.

Closeout and discard stop proven seat groups and report unproven ones
(`reapLaneSeats` in `crew/seat-reap.mjs`).

- Finished by hand: in the lane worktree, commit every change the build made
  (`git status --short` shows nothing left), fetch, and rebase onto the base the
  lane recorded as `origin/<base>` (`base` in `task/lean.json`; a local `<base>` does not move on fetch). Then, on
  that rebased tree, run the builder's named tests against old source and build, run the suite,
  and push only if both pass.
  Then open the PR and run `crew record-pr <lane> --pr <url>`, which appends one
  operator-marked `pr` row so the lane stops reading as stopped. `record-pr`
  checks only that the lane is quiet and records no PR yet, not that the PR holds
  the build (`crew/record-pr.mjs`).
- After the PR merges: `crew closeout <lane>` removes the worktree (never
  forced), deletes the lane branch and moves the lane directory to
  `~/.crew-journal-archive/` (`crew/closeout.mjs`). It refuses unless the
  recorded PR is merged. With the worktree present, it checks its origin and
  requires the branch tip to match the PR head. With the worktree absent, it
  looks for a sibling checkout of the PR repository: if the branch is present,
  its tip must match the PR head before deletion; if the branch is gone, it
  archives the lane. If no checkout of the PR repository is found, it refuses.
  A previously archived lane name moves to `dt-<lane>.archive-<n>`, using the smallest free
  `n` from 2 and keeping the earlier archive.

Before discarding a closed PR, check whether the worktree is the only copy of the build.
