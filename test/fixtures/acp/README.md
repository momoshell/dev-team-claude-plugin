# ACP Wave 0 fixtures (#793)

**Status: #804 is PARKED — see "Why this is parked" below. These fixtures are
kept as the EVIDENCE for that decision, not as inputs to any shipped test.**

Recorded 2026-08-31 against live ACP servers. Every ACP test replays these;
no test spawns an adapter (TRD `docs/trd-acp-adoption.md` §8).

`fake-upstream.mjs` was moved to `test/fake-upstream.mjs`: it is
transport-neutral and is now cited by `crew/headless.mjs`, so it must not live
under a parked epic's fixtures.

## Why this is parked

`pi-acp` spawns `pi --mode rpc --no-themes` — it is a WRAPPER over the
transport `crew/headless-rpc.mjs` already speaks natively, and it does not
forward usage. A pi ACP seat therefore has no usage and no cost, where
`pi --mode json` reports both (see the head-to-head below). That kills the
epic's premise: Wave 5 cannot retire `headless-rpc`.

The Claude half is sound — `emitRawSDKMessages` restores every ledger fact —
so if pi-acp gains `usage_update`, reopen this for a Claude-plus-pi decision.
Until then the crew keeps both bespoke transports.

What was taken out of this work instead: the typed provider-failure taxonomy in
`crew/headless.mjs`, which reads `api_error_status` from our OWN stream and
needs no ACP.

## Adapter versions — the TRD names the wrong pi package

| | Claude | pi |
|---|---|---|
| package | `@agentclientprotocol/claude-agent-acp@0.70.0` | `pi-acp@0.0.33` |
| repo | — | github.com/svkozak/pi-acp (MIT) |
| runtime | Node ≥ 22 | `engines: { node: ">=20" }` |
| ACP SDK | vendored | `@agentclientprotocol/sdk ^0.26.0` |

TRD §3.4 names `@victor-software-house/pi-acp` (0.17.1). That package is
`engines: { bun: ">=1.3" }` with a `#!/usr/bin/env bun` bin; without bun its
`initialize` never answers (120 s timeout, stderr `env: bun: No such file or
directory`). `pi-acp@0.0.33` is what the ACP registry and Zed actually use
(`https://zed.dev/acp/agent/pi`), runs on node, and answered every scenario here.

Recorded with node v26.7.0 on darwin 25.5.0.

## Format

One JSON object per line:

```json
{"dir":"client->agent|agent->client|stderr|meta","ms":<since start>,"frame":<verbatim JSON-RPC frame>}
```

`dir` is required for replay: a fixture without direction cannot drive a client.
`stderr` rows carry `text`, not `frame`. The first `meta` row names the agent,
scenario, package, cwd and node version. Unparseable stdout is kept verbatim
with `note: "UNPARSEABLE"`.

Framing splits on LF by hand. Do not use `node:readline` — it mis-splits around
U+2028 (`crew/headless-rpc.mjs:55`).

## Fixtures

| file | what it pins |
|---|---|
| `claude-handshake.ndjson` | `initialize`; `authMethods: []`; capabilities incl. `fork`, `list`, `resume`, `promptQueueing` |
| `claude-turn.ndjson` | full turn after `session/set_mode acceptEdits`; file written; `stopReason: end_turn` |
| `claude-turn-default-denied.ndjson` | **default mode refuses the write with no permission request** — `nonExecutionKind: "permission-rule"`, `status: failed`, yet `stopReason: end_turn` |
| `claude-turn-settings-ignored.ndjson` | `.claude/settings.json` `permissions.defaultMode: acceptEdits` in cwd — **ignored**, same refusal |
| `claude-cancel.ndjson` | `session/cancel` mid-turn → `stopReason: cancelled` |
| `claude-permission-reject.ndjson` | `session/request_permission` answered `reject_once`; command does not run |
| `claude-permission-allow.ndjson` | same request answered `allow_once`; command runs |
| `pi-handshake.ndjson` | `initialize`; `pi_terminal_login` auth method; MCP `false` |
| `pi-turn.ndjson` | full turn, file written, **no permission exchange** |
| `pi-cancel.ndjson` | `session/cancel` mid-turn → `stopReason: cancelled` |
| `claude-refusal-ratelimit.ndjson` | upstream 429 → JSON-RPC error, `data.errorKind: "rate_limit"` |
| `claude-refusal-auth.ndjson` | upstream 401 → `data.errorKind: "authentication_failed"` |
| `claude-refusal-overloaded.ndjson` | upstream 529 → `data.errorKind: "server_error"` |
| `claude-turn-rawsdk.ndjson` | `emitRawSDKMessages` — the full SDK `result` with `total_cost_usd` and cache-split usage |

`record.mjs` / `drive.mjs` reproduce them:

```bash
node drive.mjs --agent claude|pi \
  --scenario handshake|turn|cancel|permission \
  [--mode acceptEdits|default|plan|dontAsk|bypassPermissions] \
  [--permission-choice reject|allow|allow_always] \
  [--cwd <scratch>] [--prompt <text>] --out <file>.ndjson
```

## Measured facts that contradict TRD §3.4

1. **`usage_update` is inverted.** Claude emits it 6× per turn as
   `{"used":24729,"size":1000000}`; pi emits **none**. §3.4 credits pi with it
   and marks Claude "to verify". The payload is context size only — **no cost
   field**, so #798's "usage_update prices the cell" needs a rate table.
2. **pi advertises no `fork` and no `resume`** — `sessionCapabilities` is
   `{list:{}, delete:{}}`. §3.4's `session/load`, `resumeSession` and
   `unstable_forkSession` belong to the *other* package.
3. **pi MCP is `{http:false, sse:false}`**, not "accepted, not wired".
4. **pi advertises a terminal auth method** (`pi_terminal_login`); Claude
   returns `authMethods: []`.
5. **`stopReason` is not an acceptance signal.** `claude-turn-default-denied`
   returns `end_turn` on a turn whose only tool call failed. A driver that
   reads `stopReason` alone records a refusal as success — §8's named
   kill-mutation, reproduced live.
6. **Permission mode is set over ACP, not by settings.** `session/set_mode` is
   the only lever that worked; project `permissions.defaultMode` was ignored.
   Modes advertised: `auto`, `default`, `acceptEdits`, `plan`, `dontAsk`,
   `bypassPermissions`.

## Refusal shape — there is no `<synthetic>` over ACP

Reproduced deterministically with `fake-upstream.mjs`, which stands in for the
provider so no real limit has to be hit:

```bash
node fake-upstream.mjs ratelimit|auth|overloaded    # prints PORT=…
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=sk-ant-fake \
  node drive.mjs --agent claude --scenario turn --prompt "Say hello." --out <file>
```

A provider failure does **not** arrive as a `<synthetic>` assistant message —
that is a CLI stream-json artefact and it appears nowhere in these fixtures.
Over ACP it arrives as a **JSON-RPC error response to `session/prompt`**:

```json
{"code":-32603,
 "message":"Internal error: API Error: Request rejected (429) · …",
 "data":{"errorKind":"rate_limit"}}
```

`data.errorKind` is machine-readable and is the cause the crew should journal:

| upstream | `errorKind` |
|---|---|
| 429 | `rate_limit` |
| 401 | `authentication_failed` |
| 529 | `server_error` |

The human text is *also* delivered as an `agent_message_chunk` before the error,
so a driver that reads only the last message chunk sees prose and no cause.
Read `data.errorKind`, not the text. This is strictly better than the CLI path:
#779's "group escalations by cause" gets a typed enum instead of string-matching
`<synthetic>`, and refusal is structurally distinguishable from transport
failure — the §8 kill-mutation "recording `refusal` as `transport`" becomes
mechanically checkable.

## Head-to-head against today's transports

Same probe, run through the transports the crew uses now.

**Claude — `headless-json` `result` frame:** `total_cost_usd` (0.0898625),
`usage` with `cache_creation_input_tokens` / `cache_read_input_tokens` /
`service_tier` / `ephemeral_1h` vs `5m` / `iterations[]`, plus `modelUsage`,
`permission_denials`, `stop_reason`, `terminal_reason`, `api_error_status`,
`num_turns`, `subagent_stats`, `duration_api_ms`, `ttft_ms`.

**pi — `--mode json` `turn_end.message.usage`:**
`{input:1085, output:10, cacheRead, cacheWrite, reasoning, totalTokens:1095,
cost:{input:0.000217, output:0.000012, total:0.000229}}`, and the message
carries `api`, `provider`, `model`, `stopReason`, `rawStopReason`, `responseId`.

**ACP's own `usage_update` is `{"used":24729,"size":1000000}`** — context size
only, no cost — and pi emits none at all. So on the plain ACP path both agents
lose the cost cell.

### The Claude half is recoverable; the pi half is not

Passing `_meta: {claudeCode: {emitRawSDKMessages: true}}` to `session/new`
delivers the raw SDK messages as `extNotification("_claude/sdkMessage", …)`.
The `result` message carries the **same key set as the CLI's stream-json
result** — `total_cost_usd`, `usage` with the cache split, `modelUsage`,
`permission_denials`, `terminal_reason`, `api_error_status`, `ttft_ms`
(`claude-turn-rawsdk.ndjson`, 19 SDK frames). Claude over ACP loses no ledger
fact, provided the session opts in.

pi-acp has no equivalent. A pi ACP seat has **no usage and no cost**, where
`--mode json` gives both today. That is a real regression and it is the open
question for #798, not a detail.

## Open gaps for ADR-036 (#792 is CLOSED and needs reopening)

- **effort** — the adapter reads `getSettings().effortLevel` with
  `settingSources: ["user","project","local"]`; not probed end to end. The CLI
  path passes `--effort` directly (`crew/adapters/adapter-claude.mjs:118`).
- **appended system prompt** — no SDK equivalent identified. The CLI path uses
  `--append-system-prompt-file` (`crew/adapters/adapter-claude.mjs:122`); pi's
  rpc path uses `--append-system-prompt` (`crew/headless-rpc.mjs:96`).
- **pi usage over ACP** — absent; see the head-to-head above. Blocks #798 for
  pi seats until pi-acp emits `usage_update`.
- **per-seat settings** — partly answered: permission mode does **not** come
  from settings (see fact 6); other seat settings unprobed.
- ~~**`<synthetic>` refusal shape**~~ — **RESOLVED, and it does not exist on this
  path.** See "Refusal shape" below.
- **pi permission gating** — pi never requests permission, so pi seats keep
  adapter-side tool exclusion (§3.4's conclusion holds, for the right package).
- **SDK major spread** — pi-acp on `@agentclientprotocol/sdk ^0.26.0` vs the
  Claude adapter's vendored 0.70.0.
