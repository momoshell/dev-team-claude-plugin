# Task

---
source: operator request (lean plan item 3.5, the finish shape, first of two lanes)
closes: null
tier: build
shape: standard
acceptance: [FN1, FN2, FN3, FN4, FN5, FN6, FN7, FN8, FN9]
out_of_scope: crew/drive.mjs, crew/crew.mjs, crew/variants.mjs, docs/adr/, the stepped shape, and the operator decision verbs (--accept, --return, --abandon), which are the next lane
---
## The ask

Port ADR-051's `finish` shape to the lean loop, so a stopped lean lane is finished by its builder seat instead of by
hand. `crew finish <lane>` re-enters a stopped lean lane in its own worktree, on its uncommitted build, with its own
accepted plan and gate, and runs: builder triage → gate → mutation proof → review → suite → commit → rebase. It
stops there, committed and rebased, with nothing pushed; the operator's publish decision is the next lane.

Today two of three hand-finished lean lanes stopped on planner-side defects: mutations that could not kill
(b1396, `mutations-survived`) and a broken gate helper (b1397, `lead-refused`). The builder must be able to fix both.

Invariants:
- A finish run never re-plans and never re-runs the baseline.
- A gate check or mutation the finish run changes is proven by mutation before review, like any other.
- The standard shape behaves exactly as today.

## Context

- `docs/adr/adr-051-finish-shape.md`: the shape, seats (builder and reviewer only), three review rounds, and the
  refusals `finish-no-build`, `finish-premise`, `finish-worktree`.
- `crew/loop.mjs` `runLoop`: refuses any shape but `standard` at line 75; the build → gate → mutations → review → suite
  loop is lines 245-310; commit, fetch and rebase are 312-330.
- `crew/protocols.mjs:218-227`: the builder envelope carries only `summary`; the planner's `mutations` are the proof's
  declarations. A finish builder needs an optional field to replace the declaration for an acceptance id it re-aims.
- The stopped lane's state: `~/.crew/dt-<lane>/<lane>/task/journal.jsonl` (the last `verdict` row with
  `status: stopped`, its `reason` and `observation`; `verdict` rows with `reviewed` findings; `envelope` rows), the
  planner's return `planner-<n>.json`, `plan.md`, `gate.mjs`, `lean.json` (the run spec `crew/start.mjs` wrote).
  Archived examples: `~/.crew-journal-archive/dt-b1396-lean-closeout` and `dt-b1397-lean-lanes`.
- `crew/acp/seat.mjs:201-209`: a builder's context arms date the planner return against the journal's LAST
  `run-start` row, so a finish run that appends a new `run-start` makes the plan read as stale.
- `crew/start.mjs` (lean branch) for how a run is spawned detached; `bin/crew.mjs` `ENTRY` for verb routing, and its
  routing table in `bin/crew.test.mjs`.
- A new test file must be added to the D1 inventory in `test/factory-suite-cost.test.mjs`.

## Acceptance

- (FN1) a `finish` run issues no planner turn.
- (FN2) a `finish` run runs no baseline check.
- (FN3) the finish builder's first turn receives the lane's stop reason with its observation as feedback.
- (FN4) the finish builder's first turn receives the lane's last open review findings as feedback.
- (FN5) a replacement mutation the finish builder returns for an acceptance id is the declaration the proof runs for that id.
- (FN6) a green `finish` run ends after rebase with a journal row saying it is ready for the operator, and opens no PR.
- (FN7) `crew finish <lane>` refuses a lane whose journal has no accepted builder envelope, as `finish-no-build`.
- (FN8) `crew finish <lane>` refuses a lane that stopped in the plan or baseline stage, as `finish-premise`.
- (FN9) `crew finish <lane>` refuses a lane whose worktree is missing, as `finish-worktree`.
