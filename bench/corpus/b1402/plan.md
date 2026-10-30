# Plan: re-aim unbound mutations in standard lanes

## Goal
In the standard shape only, a mutation proof whose every non-killed row is `bind-fail`
earns the builder exactly one re-aim turn, then gate + proof run again. Finish shape,
survived/timeout/other unmeasured handling, `crew/checks.mjs` and `crew/finish.mjs` are
unchanged (brief out-of-scope).

## Minimal changes

### 1. `crew/loop.mjs` — one re-aim turn (current anchors: replacements `crew/loop.mjs:264-269`, proof stop `crew/loop.mjs:274-278`, suite-repair pattern `crew/loop.mjs:300-320`)
- Add lane state beside `repairing/repaired`: `let reaiming = false`, `let reaimUsed = false`,
  `let reaimIds = []`.
- Builder turn: use stage `reaiming ? 'mutation-reaim' : repairing ? 'suite-repair' : 'build'`
  and `singleTurn: repairing || reaiming`, mirroring the suite-repair single extra turn.
- Replacement handling (replaces the finish-only refusal at `crew/loop.mjs:264-269`): keep the
  exact application line `mutations = mutations.map((declaration) => replacements.find((replacement) => replacement.check === declaration.check) ?? declaration)`, preceded verbatim by:
  ```js
  const mayReaim = isFinish || reaiming
  const allowed = isFinish ? acceptance : reaimIds
  if (!mayReaim || replacements.some((r) => !allowed.includes(r.check))) return await stop('envelope-refused', { mutations: replacements })
  ```
  So: standard initial build still refuses `details.mutations`; finish still allows any
  acceptance id; a re-aim turn allows only ids in `reaimIds` — a replacement for a bound
  (killed) id stops `envelope-refused` (RA3). Clear `reaiming = false` immediately after this replacement block, never before it.
- Proof failure (replaces the unconditional stop at `crew/loop.mjs:274-278`): compute verbatim
  ```js
  const nonKilled = rows.filter((row) => row?.outcome !== 'killed')
  const bindFailRows = rows.filter((row) => row?.outcome === 'unmeasured' && row?.reason === 'bind-fail')
  const canReaim = !isFinish && !reaimUsed && rows.length === acceptance.length && nonKilled.length > 0 && bindFailRows.length === nonKilled.length
  ```
  If `!canReaim`, stop exactly as today (`proof.reason ?? 'mutation-unmeasured'`) — survived,
  timeout or any other row never earns a turn (RA5). If `canReaim`: set `reaimUsed = true`,
  `reaiming = true`, `reaimIds = bindFailRows.map((row) => row.check)`; raise the builder bound
  as the suite-repair path does (`seats.builder = { ...seats.builder, rounds: Math.max(seats.builder.rounds ?? DEFAULT_ROUNDS, rounds.builder + 1) }`);
  set feedback to one entry per failed id, `{ id: row.check, severity: 'must-fix', summary: 'Mutation <id> failed to bind (bind-fail); return details.mutations replacing only this declaration with a find text that occurs exactly once.', check: row.check, occurrences: row.occurrences ?? null }`
  (feedback names the acceptance id: RA1); then `continue` the inner loop so the next builder
  turn is the re-aim turn, followed by gate and proof again. The replacement the builder
  returns is therefore the declaration the next proof receives via the existing `mutations`
  variable (RA2). A second proof still containing a `bind-fail` has `reaimUsed === true`, so
  `canReaim` is false and it stops `mutation-unmeasured` — one turn per lane (RA4).
- Do not touch the review/suite-repair loops beyond the stage/singleTurn selection above;
  `repaired`/`repairing` semantics stay as-is.

### 2. `crew/agents/builder.md:26` — document the re-aim turn
Reword the `details.mutations` paragraph: on a finish run **or a standard mutation re-aim
turn** (feedback entries naming the bind-failed acceptance ids), details may also carry
`mutations`, replacing **only** the declarations named in that feedback; the loop re-proves
them. Finish wording/behaviour otherwise unchanged.

### 3. `crew/loop.test.mjs` — tests (drive via existing `fakes()` at `crew/loop.test.mjs:17-72` and finish-test style at `crew/loop.test.mjs:980-991`)
Add standard-shape tests, using a proof stub that returns a `bind-fail` row first and killed
rows on the second call (sequence via a closure over proof-call count), and `edit` to add
`details.mutations` only on the second builder request:
- RA1: first proof `{ status: 'unmeasured', reason: 'mutation-unmeasured', rows: [{ check: 'A1', outcome: 'unmeasured', reason: 'bind-fail', occurrences: 0 }] }`, second killed; assert run done, builder called twice, second builder request's feedback has an entry with `id: 'A1'`. Set builder bound 1 to prove the bound raise.
- RA2: re-aim builder returns a replacement for `A1`; assert `f.seen.mutations.mutations` on the second proof equals that replacement and run is done.
- RA3: two ids (`A1` bind-fail, `A2` killed, planner envelope extended like `crew/loop.test.mjs:865`); re-aim builder replaces `A2`; assert `stopped('envelope-refused')` and no second proof.
- RA4: proof returns the `bind-fail` row on both calls; assert `stopped('mutation-unmeasured')`, exactly 2 builder turns and 2 proof calls.
- RA5: proof `{ status: 'red', reason: 'mutations-survived', rows: [{ check: 'A1', outcome: 'survived', reason: 'gate-green' }, { check: 'A2', outcome: 'unmeasured', reason: 'bind-fail', occurrences: 0 }] }` (two-id planner); assert `stopped('mutations-survived')` with exactly 1 builder turn. Keep the existing standard-refusal and finish tests passing unchanged.

## Validation
- `node --test crew/loop.test.mjs`
- Gate: `node /Users/momoshell/.crew/dt-b1402-lean-reaim-unbound-mutations/b1402-lean-reaim-unbound-mutations/task/gate.mjs` (red on unchanged tree, green after build).
