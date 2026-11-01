# Task

---
source: operator request 2026-10-30 (keep the seat benches in the repo for the next model choice)
closes: null
tier: build
shape: standard
acceptance: [SB1, SB2, SB3, SB4]
out_of_scope: crew/ runtime behaviour; the visualizer; docs/audits/2026-09-16/bench (the old runtime's bench, left as is); recording any results
---
## The ask

The 2026-10-29/30 seat benches (advisor, arms, planner) chose seat models and arms by replaying recorded lean
lanes and blind-reviewing the results. They live outside the repo, in `~/.crew/ab/`, and have already been lost
once (a reboot cleared `/private/tmp`). Move them into the repo as a reusable bench under `bench/`, so the next
model choice reruns them instead of rebuilding them.

1. `bench/corpus/<lane>/`: for each of the six replay lanes (b1380, b1381, b1402, b1408, b1416, b1417), the
   inputs a replay needs, copied from `~/.crew-journal-archive/dt-<lane>-*/<lane>-*/task/` and
   `~/.crew/briefs/started/<lane>.md`: `plan.md`, `gate.mjs`, `planner-1.json`, `lean.json`, the brief, the first
   planner prompt and the first builder prompt (the first line's `text` of the first file under `lean/planner/`
   and `lean/builder/`), and a `manifest.json` with the lane's base commit and the original task and tree paths
   that the prompts cite. Use the bases in `~/.crew/ab/arms2/replay.mjs` `BASES`.
2. `bench/replay-builder.mjs`: replays a lane's first builder turn at its base with a named seat cell and arm
   list, then runs the gate, the mutation proof and the touched tests, and writes `result.json`, `diff.patch` and
   `session.jsonl` into an output dir. Port it from `~/.crew/ab/arms2/replay.mjs` and `~/.crew/ab/adv/replay.mjs`
   (the advisor cell). It imports the crew modules from this checkout, not a hard-coded worktree, and reads the
   corpus from `bench/corpus/`.
3. `bench/replay-planner.mjs`: the same for a lane's first planner turn. Port it from `~/.crew/ab/lab/replay.mjs`.
4. `bench/blind-review.mjs` (or `.sh`): a shuffled, coded Sol review of a set of output dirs, for diffs and for
   plans. Port it from `~/.crew/ab/arms2/blind/review-one.sh`, `make-jobs.mjs` and `~/.crew/ab/lab/blind/`.
   The key from code to run is written apart from the review outputs.
5. `bench/README.md`: how to run each bench and how to read a result. Seats and arms are named on the command
   line or in a small cell file, not edited into the script.

Invariants:
- Nothing under `crew/` or `scripts/` changes, and no package dependency is added.
- The harnesses never write into the corpus, the checkout's own tree, or `~/.crew` outside the output dir they
  are given. Each replay worktree is removed when its run ends.
- A run that fails records its error in `result.json`. It is never silently dropped.

## Context

- `~/.crew/ab/arms2/replay.mjs`, `~/.crew/ab/adv/replay.mjs`, `~/.crew/ab/lab/replay.mjs`: the harnesses to port
  (read them; they are not in the repo).
- `~/.crew/ab/*/blind/`: the blind-review scripts.
- `crew/acp/seat.mjs` `runAcpSeat`, `crew/checks.mjs` `runGate` and `proveMutations`: what the harnesses call.

## Acceptance

- (SB1) the bench corpus carries every replay input for each of the six lanes
- (SB2) the builder replay refuses an arm name it does not know before starting a seat
- (SB3) the planner replay refuses an arm name it does not know before starting a seat
- (SB4) the blind review keeps its code-to-run key outside the review output files
