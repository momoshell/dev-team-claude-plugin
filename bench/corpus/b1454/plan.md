# Lean waterfall polish

## Scope and evidence
- Edit only `visualizer/web/src/lib/timeline.js`, `visualizer/web/src/lib/LeanWaterfall.svelte`, and `test/visualizer-lean-waterfall.test.mjs`.
- `lean-source.mjs` already emits started-but-unended phases with `status: 'running'`, `ended_at: null`; no server or journal changes.
- `LeanRunDetail.svelte` mounts this component directly. Preserve that mount and the non-lean timeline branch; old-run views/tests and crew/ are out of scope.
- Existing WF2 fixtures without a recorded running status must remain unrecorded. Keep WF1–WF3 passing unchanged.
- No DOM harness exists: test deterministic JS behavior plus explicit Svelte source wiring, not claimed browser rendering.

## Minimal implementation
1. WP1: In the lean layout branch, collect a separate `open` array. Before missing-boundary classification, recognize exactly `phase.status === 'running' && phase.ended_at == null && start != null`.
   Return these entries with their phase evidence and `x: null`, `width: null`, `duration_ms: null`; exclude them from `blocks` and `unrecorded`. Always return `open` for lean layouts, including empty layouts.
   Do not use `now`, infer an end, measure elapsed time, or let open starts change the completed-interval origin/span. Invalid starts/ends and completed phases missing an end remain unrecorded.
   In LeanWaterfall add a list using `timeline.open as entry`, preserving name/role fallbacks and displaying the exact label `Open — no stage-end record`. Do not call it running/live/in flight or show an open duration/bar. Adjust introductory/empty copy to acknowledge open stages without claiming liveness.
2. WP2: Change only the lean completed-block width to `Math.max(MIN_WIDTH, span ? (end - start) / span : 0)`.
   Keep measured x, origin, span, and `duration_ms: end - start` unchanged. Include zero-duration and zero-span completed intervals. The floor is visual only; do not redistribute blocks or shift timestamps. Bars may overlap when floored.
3. WP3: Export a small pure `formatLeanDuration(ms)` from timeline.js and import it in LeanWaterfall. Reject nonnumeric, nonfinite or negative inputs with null.
   Use `const seconds = ms / 1000`; below 60 return seconds followed by `s`; otherwise return `Math.floor(seconds / 60)` minutes plus `(ms % 60000) / 1000` remaining seconds followed by `s` (e.g. `2m 45.213s`, without floating-point subtraction artifacts). Preserve measured fractional seconds, including `0.001s`, rather than rounding a short interval to zero or a floor-derived duration.
   Replace the raw-ms span with `{formatLeanDuration(block.duration_ms)}`. Keep unknown/open values unmeasured; no fallback to a liveness label.

## Tests and acceptance proof
- Add top-level `test('WP1', ...)`, `test('WP2', ...)`, `test('WP3', ...)` in the existing waterfall test, each with a `// MUTATION:` comment naming its declared kill below.
- WP1: Use source-shaped phases (running status, valid ISO start, null end), with a completed sibling and open-only run. Assert separate open classification, null geometry/duration, role/name preservation, exclusion from absent/complete rows, unchanged scale/input, and independence of injected now. Cover missing/invalid starts, invalid end strings, and terminal-status missing ends remaining absent. Pin the open list and its non-live label; retain absent-list wiring.
- WP2: Mix a long interval with 1ms, 123ms, zero-duration, and late short intervals; assert width at least 0.02, exact measured duration/x/origin/span and unchanged input. Check a lone zero-span interval and retain WF1's proportional widths for larger intervals. Pin the existing block.width-to-style wiring.
- WP3: Assert `0 -> 0s`, `1 -> 0.001s`, `123 -> 0.123s`, `1500 -> 1.5s`, `60000 -> 1m 0s`, `165213 -> 2m 45.213s`, and `664000 -> 11m 4s`. Assert null for null/undefined/NaN/Infinity/negative/string input. Pin the named import and formatter call and reject the old raw-ms span.
- Validation lane: `node --test test/visualizer-lean-waterfall.test.mjs test/visualizer-lean-web.test.mjs` (the latter protects the existing no-liveness contract; do not edit it).
- Gate: `node /Users/momoshell/.crew/dt-b1454-waterfall-polish/b1454-waterfall-polish/task/gate.mjs`, executed with the checkout under test as cwd. No dependencies or build artifacts required.
- The loop owns baseline/build/mutation/suite/commit/rebase/PR execution; this planner does not run those stages.

## Kill mutations (literal anchors must exist once after implementation)
- WP1, timeline.js: replace `phase.status === 'running' && phase.ended_at == null && start != null` with `false && phase.ended_at == null && start != null`; the source-shaped open fixture must become absent and fail WP1.
- WP2, timeline.js: replace `Math.max(MIN_WIDTH, span ? (end - start) / span : 0)` with `(span ? (end - start) / span : 0)`; the short and zero-duration fixtures must fail WP2.
- WP3, timeline.js: replace `const seconds = ms / 1000` with `const seconds = ms`; the duration examples must fail WP3.
