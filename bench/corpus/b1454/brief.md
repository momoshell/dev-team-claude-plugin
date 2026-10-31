# Task

---
source: operator request (review of PR 2086, 2026-10-31)
closes: null
tier: build
shape: standard
acceptance: [WP1, WP2, WP3]
out_of_scope: the old-run views and their tests (a parallel lane deletes them), crew/, the journal format
---
## The ask

Three gaps in the lean waterfall that PR 2086 shipped, found by running it over a real journal (b1450, 15
stages over 664s).

A stage that has started and not ended yet is listed as "Not recorded — End time missing or invalid". On a
live lane that is the row an operator looks at most, and the end is not missing, it has not happened. Show it
as open. The lean view never claims liveness (`test/visualizer-lean-web.test.mjs` "lean status and activity
never claim liveness or merge"), so "open" must not say the stage or lane is running.

Sub-second stages (gate, paths, commit) lay out at width 0.000 and draw no bar. Durations print as raw
milliseconds ("165213 ms").

Invariant: no time is invented. A minimum bar width is a drawing floor, not a duration; the printed duration
stays the measured one.

## Context

- `visualizer/web/src/lib/timeline.js` `layoutTimeline`, the `run.source === 'lean'` branch: the
  `unrecorded` reasons and the `x`/`width` layout. `MIN_WIDTH` in the same file is the old layout's floor.
- `visualizer/server/lean-source.mjs` `summarize`: an open phase has `status: 'running'` and `ended_at: null`.
- `visualizer/web/src/lib/LeanWaterfall.svelte`: the rows and the absent list.
- `test/visualizer-lean-waterfall.test.mjs`: the WF1–WF3 pins. Keep them passing.

## Acceptance

- (WP1) a lean phase with a recorded start and no end yet is shown as open, not as a missing or invalid end
- (WP2) a recorded lean phase narrower than the minimum bar width is drawn at the minimum width
- (WP3) a lean stage duration is shown in seconds or minutes, not raw milliseconds
