# Plan — per-build mutation re-aim, lean `phase_id`, missing agent `value`

## Decisions (apply exactly; gate encodes these)

- Re-aim eligibility is per builder turn, not per run: a non-re-aim builder turn (initial,
  review-fix, suite-repair, finish) earns one re-aim if its proof's every non-killed row is
  `bind-fail`; a re-aim turn never earns another.
- Lean `/api/events` **refuses** `phase_id` (400 with reason): lean journal rows carry no
  `phase_id` (`visualizer/server/lean-source.mjs:113-135` rows carry `event/stage/at`), so no
  honest filter exists. Never return unfiltered rows for a filtered request.
- Agents-editor route **refuses a request with no own `value` field** (400); only explicit
  `value: null` clears a tier override.

## Minimal changes

1. `crew/loop.mjs:288-334` — re-aim per build:
   - Delete `let reaimUsed = false` (line 293).
   - At the top of the inner builder loop, before the `stage(...)` dispatch, add exactly:
     `const wasReaimTurn = reaiming`
   - Change the eligibility line to exactly:
     `const canReaim = !wasReaimTurn && rows.length === acceptance.length && nonKilled.length > 0 && bindFailRows.length === nonKilled.length`
   - Delete `reaimUsed = true`; keep `reaiming = true`, `reaimIds`, the builder-rounds
     increment, and the bind-fail feedback unchanged (replacement restriction to `reaimIds`
     at `crew/loop.mjs:300-307` is untouched, so a re-aim still replaces only failed ids, and
     this holds for both `standard` and `finish` shapes since the block is shared).

2. `visualizer/server/server.mjs:763-782` (`/api/events` lean branch) — insert as the first
   statement inside `if (adwId.startsWith('lean:')) {`, exactly:
   `if (phase_id !== undefined) return json(res, 400, { schema, error: 'phase_id is not supported for lean lanes: lean journal rows carry no phase_id' })`

3. `visualizer/server/server.mjs:1169-1184` (`/api/roster/agent/propose`) — insert before
   `const value = input.value ?? null`, exactly:
   `if (!Object.hasOwn(input, 'value')) return json(res, 400, { schema, error: 'value is required: only an explicit null clears a tier override' })`
   Keep `input.value ?? null` after it, so explicit `null` still reaches
   `proposeAgentEdit` (`visualizer/server/agents-edit.mjs:16-31`) as a clear and a string as a set.
   Do not change `agents-edit.mjs`: it already refuses a non-string/non-null value.

## Tests that prove it (add to existing files only)

- `crew/loop.test.mjs:1097-1226` (beside RA1–RA5/LF1): RB1 — proof sequence
  bind-fail, killed, bind-fail, killed with `review: 1`; assert `done`, 4 builder turns
  (build, re-aim, review-fix build, re-aim). RB3 — bind-fail, bind-fail, killed; assert stop
  and no two consecutive `mutation-reaim` stage-starts in the journal. Existing RA4 test is
  the RB2 proof (bind-fail after re-aim stops `mutation-unmeasured`, 2 builders) — keep it.
- `test/visualizer-lean.test.mjs:205-232` (beside VJ4): RB4 — lane with rows in two stages;
  `GET /api/events?adw_id=lean:<lane>&phase_id=1` returns 400 naming `phase_id` and no
  events; the same request without `phase_id` still returns the rows.
- `test/visualizer-server.test.mjs:4490-4524` (agent proposals): RB5 —
  POST `{role:'planner', tier:'judge', field:'effort'}` (no `value`) returns 400; POST with
  explicit `value: null` still returns 200/`ok:true`.

## Out of scope

No edits to `crew/finish.mjs`, `crew/checks.mjs`, `crew/drive.mjs`, `crew/crew.mjs`,
`docs/adr/`, `visualizer/server/agents-edit.mjs`, or the roster editor; no change to how a
survived/timed-out mutation is handled.

Validation lane: `node --test crew/loop.test.mjs test/visualizer-lean.test.mjs test/visualizer-server.test.mjs test/visualizer-agents-edit.test.mjs`
