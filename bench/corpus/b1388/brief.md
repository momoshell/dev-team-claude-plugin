# Task

---
source: operator request 2026-10-26 (pi arms must work on lean seats; Sol found they read the old task layout)
closes: null
tier: build
shape: standard
acceptance: [AC1, AC2, AC3, AC4, AC5]
out_of_scope: crew/drive.mjs, crew/crew.mjs, the old headless and pane paths (the old layout must keep working unchanged), claude seats (a later lane), the arms' rules themselves (only where they find their context)
---
## The ask

PR 2003 (lane b1385) carries the definition's arms to lean ACP seats. It refuses four of them on a lean seat:
advisor, builderloop, skeletonread and edit_assist, which builderloop runs. They refuse because each extension
finds its context in the OLD runtime layout. The journal is at `dirname(CREW_TASK_DIR)/journal.jsonl`, the run
anchor is that journal's run-start row, and the planner's return is under `dirname(CREW_TASK_DIR)/returns/<run>/`.
A lean lane keeps its journal at `<task>/journal.jsonl` and its returns at `<task>/<role>-<turn>.json`, so on a lean
seat these arms load and find nothing. A Sol pass reproduced the builderloop and skeletonread readers returning
null, and the advisor reporting `scope_source: "absent"`.

Make these arms find their context on a lean lane, with one shared way to resolve the layout rather than a copy per
extension. Then lift the lean refusal for them in `crew/acp/seat.mjs`. The pieces:
- the planner return (files in scope, validation lane, citations), for advisor, builderloop and skeletonread;
- the run anchor. A per-seat stamp hides a planner return written before it; Sol reproduced this. The anchor must be
  the lane's start, not the seat's;
- the advisor manifest and its model cell, which lean does not write today;
- the subagent spawn counter (`dirname(CREW_TASK_DIR)/subagent-spawns.json`), which must stay inside the lane.

Invariant: on the old layout every arm behaves exactly as today; on a lean lane an arm either reads the lane's own
context or refuses to launch.

## Context

- `crew/pi/extensions/advisor.ts` `journalPathFrom`, `returnsDirFrom`, `manifestText`, `loadContext`,
  `plannerReturn`.
- `crew/pi/extensions/builderloop.ts` `loadPlannerContext`; `crew/pi/extensions/skeletonread.ts` near line 471;
  `crew/pi/extensions/subagent.ts` near line 532.
- `crew/crew.mjs` `advisorManifest` (read only): the manifest the old path writes.
- `crew/acp/seat.mjs` `seatGrants` and `LEGACY_CONTEXT_ARMS`, from PR 2003: the refusal to lift. This lane needs
  PR 2003 on main.
- `crew/loop.mjs` and `crew/lean.mjs`: where a lean lane writes its journal and returns.
- The tests that pin each reader: `crew/pi/extensions/*.test.mjs` for those four extensions and
  `crew/acp/seat.test.mjs`.

## Acceptance

- (AC1) on a lean lane, builderloop's planner context reads the validation lane from the lane's planner return
- (AC2) on a lean lane, the advisor's scope comes from the lane's planner return written before the seat started
- (AC3) on a lean lane, skeletonread's citations come from the lane's planner return
- (AC4) on a lean lane, the subagent spawn counter is written inside the lane task dir
- (AC5) a lean pi builder that declares advisor, edit_assist, builderloop and skeletonread launches with all four
