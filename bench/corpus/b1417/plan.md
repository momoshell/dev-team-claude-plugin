# Plan: lanes show finish PR

## Goal
A lane accepted via `crew finish --accept` reads `done` with its PR in
`crew lanes` and the visualizer; a lane merely `finish-ready` still reads as today.

## Minimal change
- Edit only the state derivation in `visualizer/server/lean-source.mjs:148-192`
  (`summarize`). No edits to `crew/finish.mjs`, `crew/loop.mjs`, `crew/lanes.mjs`,
  or the visualizer web app.
- In `summarize`, before deriving status from `last`
  (`visualizer/server/lean-source.mjs:176-190`):
  1. Find the last `finish-ready` row index and the last `pr` row after it whose
     `pr` is an object (the row `crew/finish.mjs` appends on accept, just before
     its `finish-decision` row: `crew/finish.mjs:231-232`).
  2. If that `pr` row is followed only by `stage-end` and/or `finish-decision`
     rows, use that `pr` row as the effective `last`.
  3. Route it through the existing `last.event === 'pr'` branch unchanged
     (`visualizer/server/lean-source.mjs:184-188`), so `status='done'`,
     `running=false`, `pr`, `hand_finished`, and `pr_actor` keep their current
     derivation (finish's `pr` row has no `actor`, so `loop`/`false`).
- Preserve the generic fallthrough (`visualizer/server/lean-source.mjs:189-191`)
  untouched: with no qualifying later `pr`, a trailing `finish-ready` still gives
  `status='running'`, `running=true`, `pr=null`.
- `crew/lanes.mjs` needs no change: it already surfaces `status` and `pr.url`
  from this source (`crew/lanes.mjs:14-25`).

## Tests that prove it
- `test/visualizer-lean.test.mjs`: add a hand-built lane ending
  `finish-ready`, `pr` (`{number,url}`), `finish-decision {choice:'accept'}`;
  assert `status='done'`, `running=false`, `pr` deep-equals that PR. Add a second
  lane ending in `finish-ready`; assert it still reads `status='running'`,
  `running=true`, `pr=null`. (LP1, LP2)
- `crew/lanes.test.mjs`: add the same two journals through `main --json`; assert
  the accepted lane's row is `done` with the PR URL and the ready lane's row is
  `running` with `pr=null`, proving `crew lanes` shows both. (LP1, LP2)

## Validation
- `node --test test/visualizer-lean.test.mjs crew/lanes.test.mjs`
