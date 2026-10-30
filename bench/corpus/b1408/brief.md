# Task

---
source: operator request (lean lanes b1405 and b1407 stopped as mutation-unmeasured after a review fix moved a mutation target; two should-fix findings left on PRs 2026 and 2027)
closes: null
tier: build
shape: standard
acceptance: [RB1, RB2, RB3, RB4, RB5]
out_of_scope: crew/finish.mjs, crew/checks.mjs, crew/drive.mjs, crew/crew.mjs, docs/adr/, how a survived or timed-out mutation is handled, and the roster.json editor
---
## The ask

1. A run gets one mutation re-aim turn in total (`reaimUsed` in `crew/loop.mjs`, around line 293). A builder turn that
   fixes a review finding can move the text a declaration targets, so the next proof has a `bind-fail` row and the
   lane stops as `mutation-unmeasured`, though the gate is green. b1405 stopped this way twice and b1407 once; each
   needed a `crew finish` run. Give one re-aim turn after each builder turn instead of one per run.
2. `GET /api/events` for a lean lane (`adw_id=lean:<lane>`) accepts and validates `phase_id`
   (`visualizer/server/server.mjs` around line 763) but the lean branch ignores it and returns every journal row.
   Apply it, or refuse it for lean lanes with a reason; never return unfiltered rows for a filtered request.
3. The agents-editor route treats a request with no `value` as a clear of the tier override. Only an explicit
   `value: null` clears; a missing `value` is refused.

Invariants:
- Only a proof whose every non-killed row is a `bind-fail` earns a re-aim turn, in either shape.
- A re-aim turn never earns another re-aim turn: a `bind-fail` in the proof right after a re-aim stops the lane as
  `mutation-unmeasured`.
- A re-aim turn may replace only the declarations that failed to bind.

## Context

- `crew/loop.mjs`: the build loop and re-aim block (around lines 288-334); the suite-repair path beside it.
- `crew/loop.test.mjs`: the re-aim tests from PRs 2023 and 2025, and `fakes()` to drive builder, review and proof turns.
- `visualizer/server/server.mjs` `/api/events` (around line 760) and its lean branch; `visualizer/server/lean-source.mjs`.
- `visualizer/server/agents-edit.mjs` `proposeAgentEdit` and the server route that calls it; `test/visualizer-agents-edit.test.mjs`.

## Acceptance

- (RB1) a run whose proof after a review-fix build turn has only `bind-fail` rows gives the builder a re-aim turn, even when an earlier re-aim turn was used.
- (RB2) a proof with a `bind-fail` row directly after a re-aim turn stops the lane as `mutation-unmeasured`.
- (RB3) a run never takes two re-aim turns in a row.
- (RB4) `GET /api/events` for a lean lane with `phase_id` never returns a journal row outside that phase.
- (RB5) the agents-editor route refuses a tier-override request with no `value` field.
