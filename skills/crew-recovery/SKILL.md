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

`crew finish <lane>` re-enters a stopped lane in its own worktree, on its
uncommitted build, and runs builder triage, gate, mutation proof, review, suite,
commit and rebase. It publishes nothing (`crew/finish.mjs`). When that run is
ready, decide once:

- `crew finish <lane> --accept [--notes <file>]` publishes the PR the run
  measured. Merging stays yours.
- `crew finish <lane> --return <file>` runs one more finish pass with the file
  as the builder's guidance; it counts against the three review rounds.
- `crew finish <lane> --abandon` ends the lane unpublished.

It refuses, writing nothing, when the worktree is gone, the lane never reached a
build, a run is still active, the lane is already published or committed, or
there is no accepted builder result. A decision is refused when the last run did
not end ready, the lane already has one, or (for `--accept`) the checkout is no
longer the head the run measured. Read the refusal; it names the cause.

## Close it out

- Finished by hand: open the PR yourself, then `crew record-pr <lane> --pr <url>`
  appends one operator-marked `pr` row so the lane stops reading as stopped. The
  lane must be quiet and record no PR yet (`crew/record-pr.mjs`).
- After the PR merges: `crew closeout <lane>` removes the worktree (never
  forced), deletes the lane branch and moves the lane directory to
  `~/.crew-journal-archive/` (`crew/closeout.mjs`). It refuses unless the
  recorded PR is merged with the lane branch tip as its head.

Never close out before the merge: the worktree is the only copy of the build.
