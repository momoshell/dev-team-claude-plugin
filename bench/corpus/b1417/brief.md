# Task
<!-- crew:bound-issue #2038 -->

---
source: issue 2038
closes: 2038
tier: build
shape: standard
acceptance: [LP1, LP2]
out_of_scope: crew/finish.mjs and the journal rows it writes; crew/loop.mjs; the visualizer web app
---
## The ask

`crew finish --accept` appends a `pr` row and then a `finish-decision` row (`crew/finish.mjs` around line 231).
`visualizer/server/lean-source.mjs` reads a lane's state from its last row that is not a `stage-end` (around line 176),
which is then `finish-decision`, so the lane reads as running and its PR is hidden from `crew lanes` and the
visualizer. A lane whose journal has a `pr` row after its last `finish-ready` row is done, with that PR.

Invariant: a lane with a `finish-ready` row and no later decision still reads as waiting for the operator, as today.

## Context

- `visualizer/server/lean-source.mjs` (the state derivation) and `crew/lanes.mjs`, which reads it.
- `test/visualizer-lean.test.mjs` and `crew/lanes.test.mjs` build journals by hand.

## Acceptance

- (LP1) a lane whose journal ends with a `pr` row then a `finish-decision` row reads as done with that PR.
- (LP2) a lane whose journal ends with `finish-ready` reads as it does today.
