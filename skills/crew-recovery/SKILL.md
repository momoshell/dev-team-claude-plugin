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
  reason and PR, all read from each lane journal (`crew/lanes.mjs`). It does not
  say whether a process is alive.
- `crew show <lane>` lists each seat and its recorded sessions;
  `crew show <lane> <role>` prints that seat's session as text and `--json`
  prints the recorded JSONL untouched (`crew/show.mjs`). Read-only.
- The lane journal is `~/.crew/dt-<lane>/<lane>/task/journal.jsonl`: one JSON row per
  event. The last rows say why the lane stopped. Never edit it by hand.

## Finish it

`crew finish <lane>` re-enters a stopped lane in its own worktree and rebases
onto the current base, then runs builder triage, proof of the builder's named
tests, review, suite, commit and rebase. A base conflict stops before any seat
with the build left uncommitted. A mechanical lane is finished on its brief; one
whose diff reaches a protected path stops `raise-needs-plan`, and you restart it
from its brief as a build lane.
Only the checked tree is committed; a rebase that moves the head repeats proof,
review and suite on the new base. It publishes nothing (`crew/finish.mjs`).
When that run is ready, decide once:

- `crew finish <lane> --accept [--notes <file>]` publishes the PR the run
  measured. Merging stays yours.
- `crew finish <lane> --return <file>` runs one more finish pass with the file
  as the builder's guidance; it counts against the three review rounds.
- `crew finish <lane> --abandon` ends the lane unpublished.

It refuses, writing nothing, when the worktree is gone, the lane never reached a
build, a run is still active, the lane is already published or committed, or
there is no schema-valid done or insufficient builder result (including absent or
defective returns). A decision is refused when the last run did
not end ready, the lane already has one, or (for `--accept`) the checkout is no
longer the head the run measured. Read the refusal; it names the cause.

## Close it out

For a stopped lane with no PR that the visualizer keeps showing, use
`crew closeout <lane> --discard`. It removes the worktree and branch and
archives the journal; it does not change the visualizer. It refuses lanes with
any recorded PR (use plain closeout after merge), finish records (use `crew finish`),
a run not proven stopped, or uncommitted worktree changes. The worktree removal
is never forced. Inspect the lane first: discard removes its worktree.

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
  recorded PR is merged with the lane branch tip as its head.

For a lane with a PR, never close out before the merge: the worktree is the only copy of the build.
