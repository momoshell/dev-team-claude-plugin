# Testing boundary

There is no DOM test harness in this repo: no vitest, no jsdom, no testing-library.

Logic lives in plain .js modules under visualizer/web/src/lib/ and is tested with node --test; a .svelte file can only be pinned as source text.

## Consequences for design

Put anything worth asserting in a deterministic `lib/*.js` shaper or reducer, where `node:test` can pass explicit data and assert the result. Do not move logic into markup merely to make a component look shorter: without a DOM harness, that logic can only be covered indirectly or pinned as source.

The package declares `svelte`, `vite`, and `@sveltejs/vite-plugin-svelte` as development dependencies and runs `node --test --test-timeout=30000` from `package.json`. The measured suite is source-oriented: 17 `readFileSync` sites read `.svelte` files under `test/visualizer-*.test.mjs`.

## Source pins are exact

A `.svelte` file can be pinned with `readFileSync` plus a regex or exact substring, not rendered output. The exact pins at `test/visualizer-panels.test.mjs:623,627,629,845–847` cover FleetTable's header and status rules and PhaseGantt's layout locals; `test/visualizer-shape.test.mjs:750–751` covers the runes-only source rule. Reformatting a pinned string can therefore break a test without changing runtime behaviour. Preserve the local source shape when a test is explicitly pinning it.

The `qa-test-writing` skill is the route for making a source check non-vacuous: prove the check can fail, keep expected values independent from implementation, and record the mutation it kills. Do not restate that skill's full test-writing method here; this reference only explains why a Svelte component is source text at test time.

## What belongs where

- Put status derivation, absence marks, lane layout, event drains, and panel shaping in `visualizer/web/src/lib/fleet.js`, `drain.js`, `timeline.js`, `panels.js`, or `trace.js`, then test them with `node --test`.
- Use a source pin only for a structural contract such as a prop line, a snippet, a class-to-token rule, a theme local, or the deliberate absence of legacy syntax.
- Treat a passing source regex as evidence of that exact source shape, not evidence that a browser rendered it correctly. A rendered-page claim needs a separate measured harness; this lane has none.
