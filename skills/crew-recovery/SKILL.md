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
- For a red or unmeasured suite or proof, find its `check` row (`check: 'suite'`
  or `check: 'proof'`). Resolve `outputFile` against the directory containing
  `journal.jsonl`, then JSON-decode the file's `stdout` and `stderr` strings.
  They include captured lines before the journal's 4096-character tails; capture
  remains bounded by the runner's 64 MiB output limit per subprocess. Green checks
  write no output artifact, including a green proof with an expected red base run.
  A stream the runner did not return is `null` in the file. `outputFile: null`
  with `outputError: {code, message}` means no file exists, not that the streams
  were empty: code `output-uncaptured` means the runner returned no streams (it
  threw, for one), any other code means the write failed. The lane continues with
  the same check result.
  The row's `seconds` measures the runner, not the output write. Null seconds with
  `secondsReason: 'clock-unmeasured'` means unknown timing, not a zero-length run.
  After closeout, use the archived journal and resolve the filename beside it in
  the archived task directory; closeout keeps the output files with the journal.

A `proof-timeout` stop means every unproven named test timed out on the old
source or the build. No builder or lead turn follows. The verdict observation
names the tests, the side that timed out and the `proofTimeoutMs` used. The
usual recovery is to raise `proofTimeoutMs` in `.crew/project.json` and run
`crew finish <lane> --return <file>`.

A `seat-unmeasured` stop means the seat failed to produce a usable turn after
its existing single rerun. Inspect both sessions and their `seat-turn` rows
before choosing recovery. `sleep_credited_s` records seconds excluded from the
wait budget; absent or zero means no measured credit. Suite and proof credits
are in `check.result`. A null credit with
`sleep_credit_reason: 'clock-unavailable'` means sampling was unavailable and
the ordinary elapsed limit still applied. Samples are at most 25 ms apart;
a gap strictly greater than 5,000 ms credits the gap minus the scheduled
interval. Long event-loop stalls can look like suspension. On macOS, start and
finish hold a PID-bound `caffeinate -i` idle-sleep assertion when available,
not a display or lid-close assertion. Neither credit nor inhibition repairs a
provider connection lost during sleep. Limits and defaults are unchanged;
a genuine awake timeout or failed connection still needs the finish procedure
below, not a journal edit or an assumed automatic restart.

## Finish it

`crew finish <lane>` reports the stop or ready state without changing the lane.
`crew finish <lane> --return <file>` resumes a pre-build planning stop or starts
a finish pass on a finishable post-build stop, including an escalation or a
provably dead run. `<file>` is a notes file, not inline text.
Before any build, a planning stop resumes in the same lane, worktree and branch,
keeping seeded files and prior returns and sessions. If the current planner done
return was accepted and only the lead is unresolved, the lead sees the answer
first. Otherwise the planner reruns with the previous evidence. Both receive
labelled operator guidance and the stopped lead's question; a lead bounce can
revise the plan. Guidance stays in force for the whole run; a new `--return`
replaces it. Once planning succeeds, the lane uses fresh round budgets and runs
its normal tier checks. Build runs review and suite together; judge gets reviewer
and tech-lead review after a green suite. The lane opens and records the PR without `--accept`.
Merging stays with you. Another planning stop before any build can resume the
same way. Baseline-only stops still refuse.
After a build, use `--return` when the existing plan still fits. That finish pass
keeps the plan and recorded roster; it cannot return work to the planner.
If a post-build stop's lead names a plan gap or asks to reopen planning, end the lane with
`crew finish <lane> --abandon` and `crew closeout <lane> --discard`, then start
it again from its brief so the planner writes a new plan.
On an escalation, answer the operator question in the file. State the answer for
the whole class of defects it covers, not just the reported instance. The pass
re-enters the lane in its own worktree and rebases onto the current base,
then runs builder triage, refreshes the base, proves the builder's named
tests, reviews, runs the suite, commits and rebases. Each new finish pass gets one
pre-check refresh, on its first check round. Later proof retries, review fixes and suite
repairs neither fetch nor move the base before checks. If the base moves on that first
round, the loop temporarily snapshots the measured lane paths, rebases through the
ignored/generated-file rules and soft-resets onto the fresh base, leaving the build
uncommitted. Proof measures old source there. That move requires a full, counted review,
with earlier findings retained; the journal records the move and full scope.
It spends no publishing recheck and grants no rounds. Initial finish, pre-check and
publishing rebases share up to three builder conflict turns per run. After the first
turn, the attempted base must differ from the previous turn's base. A conflict that
gets no turn or remains unresolved stops `rebase-conflict`. Failed moves restore
uncommitted work only when cleanup is proven. A mechanical lane is finished on its brief; one
whose diff reaches a protected path stops `raise-needs-plan`, and you restart it
from its brief as a build lane.
Only the checked tree is committed; the post-suite rebase still repeats proof,
review and suite on the new base. It publishes nothing (`crew/finish.mjs`).
A red suite or proof with measured host sleep runs once more on the unchanged tree
(ADR-054 §1). A second red stops with `red-after-sleep-rerun`. Outside that exception,
the first red suite gives the builder its one repair turn immediately, even for a flaky
failure. The repair repeats proof and the suite, and repeats review unless the reviewer
already passed the same tree in this finish run. An unmeasured suite, or a red suite
after repair that does not qualify for a sleep re-run, stops the lane.
When that run is ready, decide once:

- `crew finish <lane> --accept [--notes <file>]` publishes the PR the run
  measured. Merging stays yours.
- `crew finish <lane> --return <file>` runs one more finish pass with the file
  as the builder's guidance. Reviews count against the three review rounds,
  except needed suite-repair and post-suite moved-head recheck reviews; those
  are uncounted and run even when the cap is spent. The reviewer reuses its latest
  pass on an identical tree in the same finish run instead of reviewing again.
  A first-round pre-check base move requires a full, counted review, so a spent
  cap stops it.
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
  operator-marked `pr` row so the lane lists as `done` with the PR URL.
  `record-pr` accepts a stopped or quiet `ready-for-operator` lane with no
  recorded PR. It does not check that the PR holds the build (`crew/record-pr.mjs`).
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
