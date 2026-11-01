# Task

---
source: operator request (Momo, 2026-10-31: "can the viz show task execution waterfall?")
closes: null
tier: build
shape: standard
acceptance: [WF1, WF2, WF3]
out_of_scope: deleting the old-run views (RunDetail, RunCard and what only they import) — a later lane removes them; the journal format and crew/
---
## The ask

Lean lanes have no execution waterfall. The visualizer routes every lean run to `LeanRunDetail.svelte`, which
lists journal rows with no times, and the only waterfall (`PhaseGantt.svelte`, laid out by `timeline.js`
`layoutTimeline`) sits in `RunDetail.svelte`, which nothing imports any more. The data is already there:
`visualizer/server/lean-source.mjs` `summarize` builds `run.phases` from the journal's stage-start/stage-end
rows with `started_at`/`ended_at` taken from each row's `at`.

Show a waterfall of the lean run's stages in `LeanRunDetail`: one bar per phase, offset and width from its
recorded times, labelled with the seat that answered it. Reuse `layoutTimeline` (or the parts of `PhaseGantt`
that fit) rather than writing a second layout. Invariant: a time nobody recorded is shown absent with its
reason, never as a zero, never at the origin, never stretched to now.

## Context

- `visualizer/server/lean-source.mjs` `summarize`: the lean phases. A phase opened by a `check` or verdict row
  has `started_at: null`.
- `visualizer/web/src/lib/timeline.js` `layoutTimeline`: puts phases with no `started_at` in `queued`, which
  is the old driver's meaning, not "not recorded".
- `visualizer/web/src/lib/LeanRunDetail.svelte`, `lean.js`: the lean view. The header comment of `lean.js`
  ("date only their run-start") is out of date: every stage-start, stage-end and check row carries `at`.
- Journal rows with `event: 'envelope'` carry `stage` and `role`.
- `test/visualizer-lean-web.test.mjs`, `test/visualizer-lean.test.mjs`: how lean presentation is pinned
  (logic through `node --test`, components as source text). CI has no node_modules: the suite must not import
  svelte or any visualizer dependency.
- Load `frontend-svelte`, `ui-design` and `ux` before touching a component.

## Acceptance

- (WF1) the lean run detail renders an execution waterfall laid out from the run's phases
- (WF2) a lean phase with no recorded start is shown as not recorded with its reason, not as a queued or zero-width bar
- (WF3) a lean phase whose stage has a seat envelope row carries that seat's role
