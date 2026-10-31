# Testing boundary

Keep deterministic shaping logic in plain modules under `visualizer/web/src/lib/*.js` and exercise it with `node:test`. The existing source-oriented tests can read a component as text, rather than proving browser rendering.

`test/visualizer-lean-web.test.mjs` tests fleet status functions and pins App's wiring to LeanRunDetail. Source pins can break on reformatting without a runtime change; use them for meaningful structural contracts, not as proof of rendered behaviour. Use the `qa-test-writing` skill to make checks non-vacuous and record a mutation they kill. A rendered-page claim requires separate browser evidence.
