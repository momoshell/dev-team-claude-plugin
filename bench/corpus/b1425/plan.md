# Plan: scout rule and read-spread nudge (SN1–SN4)

## Ground truth inspected
- Charters have no scout rule today: `crew/agents/planner.md:1-36`, `crew/agents/reviewer.md:1-25`.
- The extension entry registers only the tool + one `tool_result` handler: `crew/pi/extensions/subagent.ts:973-981`; grant allowlist parsing already exists as `parseAgentAllowlist`/`AGENTS_ENV` in the same file, and `journalPathFrom`/`usageRow` show the journal seam.
- How an arm watches calls and messages the seat: `pi.sendMessage(message, {deliverAs:'steer'})` plus `pi.on('tool_call'|'tool_result', …)` in `crew/pi/extensions/advisor.ts:1444-1458`; `turn_start` registration pattern in `crew/pi/extensions/readgate.ts:838-845`.
- Existing factory contract pinned by tests (ungranted fake pi: exactly one tool, handlers `['tool_result']`): `crew/pi/extensions/subagent.test.mjs:194-206`.

## Minimal changes (only files in scope)

### 1. Charter rule — SN1, SN2
Add this exact sentence, verbatim, once to each of `crew/agents/planner.md` and `crew/agents/reviewer.md` (as its own short bullet/line, near the top of the body):

> Scout rule: when answering a question means reading many files or an area the brief's Context does not name, ask a `scout` that question instead of reading it all yourself, then read only what its findings cite.

No other charter edits; do not touch the scout definition/model, builder seat, advisor, or claude seats.

### 2. Nudge in `crew/pi/extensions/subagent.ts` — SN3, SN4
Keep erasable-syntax-only, zero-dep. Add exactly this public contract (names/values are gate-pinned):

```ts
export const SCOUT_NUDGE_READ_THRESHOLD = 8
export const SCOUT_NUDGE_MIN_DIRECTORIES = 3
export const SCOUT_NUDGE_MESSAGE_TYPE = 'crew-scout-nudge'
export const SCOUT_NUDGE_TEXT = 'You have made many read-type calls across several directories since your last write or scout call. Consider asking a scout that question instead, then read only what its findings cite.'
export function createScoutNudge(deps: any = {}): any
```

`createScoutNudge({ env = process.env, send, appendFile = appendFileSync, now = () => new Date().toISOString() })` returns `{ onToolCall, onTurnStart }` with this behaviour:

- State: `count`, `dirs` (Set of directory strings), and a boolean literally named `nudgedThisTurn`, initially `false`.
- `onToolCall(event)` always returns `undefined`, never blocks/changes a call, and never throws (wrap the body in try/catch returning `undefined`).
  - Read-type tools `read`, `grep`, `find`, `ls`: increment `count`; add the call's directory — `dirname(input.path)` for `read`, `input.path` (or `'.'` when absent) for `grep`/`find`/`ls`.
  - Reset tools `edit`, `write`, and `agent` (a write or a scout call): set `count = 0` and clear `dirs`. Do not reset `nudgedThisTurn` here.
  - Trigger, checked after counting a read-type call: when `count >= SCOUT_NUDGE_READ_THRESHOLD && dirs.size >= SCOUT_NUDGE_MIN_DIRECTORIES && !nudgedThisTurn`, do in this order: set the literal line `nudgedThisTurn = true`; call `send({ customType: SCOUT_NUDGE_MESSAGE_TYPE, content: SCOUT_NUDGE_TEXT, display: true }, { deliverAs: 'steer' })` inside try/catch; then write exactly one journal row — only when `env.CREW_TASK_DIR` is set — `appendFile(journalPathFrom(taskDir, env), JSON.stringify({ at: now(), scout_nudge: { reads: count, directories: dirs.size }, role: String(env.CREW_ROLE || 'unknown') }) + '\n')` inside its own try/catch, so a journal failure never throws into the seat and never suppresses/duplicates the send.
- `onTurnStart()` sets `nudgedThisTurn = false` (count/dirs persist) and returns `undefined`. This is what makes SN4 hold: a second threshold run in the same turn — even after an `agent`/`edit`/`write` reset — sends nothing and writes no second row; the next turn may nudge again.
- Wiring in the default export only (the tool that provides scouts is the home; no grant, no nudge): keep `pi.registerTool(createAgentTool())` and the `tool_result` handler unchanged; additionally, only when `parseAgentAllowlist(process.env[AGENTS_ENV]).length > 0` **and** `typeof pi.sendMessage === 'function'`, create the nudge with `send: (m, o) => pi.sendMessage(m, o)` and register `pi.on('tool_call', nudge.onToolCall)` and `pi.on('turn_start', nudge.onTurnStart)`. Ungranted seats (and the existing fake-pi test) therefore still see exactly `['tool_result']`.

### 3. Tests in `crew/pi/extensions/subagent.test.mjs`
Add tests proving, via `createScoutNudge` with injected `send`/`appendFile`/`now` and a scratch `CREW_TASK_DIR`:
- SN3: 7 reads across 3 dirs send nothing; the 8th sends exactly one `crew-scout-nudge` steer message matching /scout/, every handler call returns `undefined`, and exactly one `scout_nudge` journal row lands at `journalPathFrom(taskDir, env)`; reads confined to 1–2 directories past 8 send nothing.
- SN4: after the nudge, an `agent` call (and separately an `edit`/`write`) resets the count, a second 8-read/3-dir run in the same turn sends nothing and adds no row; after `onTurnStart()` a further run nudges a second time.
- Reset/no-throw: a throwing `appendFile` still yields the send and no throw; ungranted default export registers no `tool_call`/`turn_start` handlers, granted export (env `CREW_PI_AGENTS` set, fake pi with `sendMessage`) registers both.
Keep the existing ungranted factory test (`crew/pi/extensions/subagent.test.mjs:194-206`) semantics intact.

## Validation
- Gate: `node /Users/momoshell/.crew/dt-b1425-scout-rule-and-nudge/b1425-scout-rule-and-nudge/task/gate.mjs` (cwd = repo root) — red on the unchanged tree (all four ids), green after the build.
- Suite lane: `node --test crew/pi/extensions/subagent.test.mjs`
