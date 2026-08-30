# Technical Requirements Document: Agent Client Protocol as the Seat Transport

**Status:** Proposed for implementation

**Date:** 2026-08-30

**Scope:** Crew seat transports, adapters, permission handling, liveness, provider fallback, ledger cost facts, and the review-quality controls that the same work unblocks

**Replaces:** Two bespoke headless transports — `headless-json` (Claude `-p --output-format stream-json`, parsed by `crew/headless.mjs`) and `headless-rpc` (`pi --mode rpc`, supervised by `crew/headless-rpc.mjs`) — with one protocol client. The pane transport is untouched.

---

## 1. Executive decision

Every headless seat speaks the **Agent Client Protocol** (ACP): JSON-RPC 2.0 over stdio, protocol version 1, maintained by Zed Industries, implemented by 51 agents including both agents this roster seats — Claude (via `@agentclientprotocol/claude-agent-acp`, which wraps the Claude Agent SDK) and Pi (via `@victor-software-house/pi-acp`, which embeds the pi SDK).

The crew today drives Claude and Pi through two different, hand-built mechanisms and infers turn state from the side effects of each. ACP gives the driver the facts it currently infers:

| Today the driver infers… | …from | ACP states it as |
|---|---|---|
| the turn ended | envelope file appeared; stream went idle; exit marker | `session/prompt` response with `stopReason` ∈ `end_turn` · `max_tokens` · `max_turn_requests` · `refusal` · `cancelled` |
| the seat is alive | pane probe (pane only); transcript mtime (#777) | `session/update` notifications arriving; `usage_update` per turn |
| a tool is being denied | `--exclude-tools` / `deny` list composed per adapter | `session/request_permission` with options `allow_once` · `allow_always` · `reject_once` · `reject_always`, answered by the driver |
| what the seat cost | stream `result.usage` (Claude) / rpc usage frames (Pi) | `usage_update` with `used`, `size`, optional `cost {amount, currency}` |
| the seat should stop | SIGTERM, re-delivered inside a 5 s window because the seat shell swallows it, then SIGKILL (`crew/headless-rpc.mjs:26-33`) | `session/cancel` → `stopReason: cancelled` |
| the API refused (session limit, quota) | a `"model":"<synthetic>"` assistant message in `stream.jsonl` (2026-08-30, b332/b333) | `stopReason: refusal`, or a typed session-failure extension |

**The envelope stays the record.** ADR-029's rule — the stream is transport and observability, never the record; the envelope is the record; idle ≠ success — is unchanged. ACP replaces how the driver *runs and observes* a seat, not how a seat *answers*. A seat still writes its envelope to `returnPath`; `validEnvelope` and the `assignment_id` anti-replay check (`crew/drive.mjs:624`) are untouched.

This is additive. `acp` is a fourth transport beside `pane`, `headless-json`, `headless-rpc`. The two bespoke transports are retired only after the ACP transport has driven real lanes and the measured comparison is recorded.

### 1.1 Required outcome

For every seat driven over ACP, the journal and ledger state, from protocol facts and not from inference:

- why the turn ended (`stopReason`), and whether that was the seat's decision or the client's
- every tool call the seat made, with `kind`, `status`, `locations`, and diffs where the agent supplied them
- every permission the driver answered, which option it chose, and under which policy
- tokens and cost per turn from `usage_update`
- when a provider refused, and whether a fallback seat took the assignment

---

## 2. Goals and non-goals

### Goals

1. One client, two agents. `crew/acp-client.mjs` drives any ACP server; the adapters shrink to *launch specs* (command, env, `session/new` params).
2. Delete the signal dance. Cancellation is `session/cancel`; the exit-marker window, TERM repeat, and FIFO retries in `headless-rpc.mjs` are not ported.
3. Permission as a decision, not a denylist. The roster's `deny` becomes a permission *policy* the driver applies to `session/request_permission`; anything the policy does not settle is a closed-enum decision the lead can take, recorded in the journal.
4. Liveness from the protocol. A headless seat's heartbeat comes from `session/update` arrival, carrying the notification's own timestamp — the same "measurement, never a wall clock" rule #777 enforces.
5. Provider fallback. A seat may declare an ordered fallback; a `refusal` or a typed API failure on a fresh turn re-asks the same assignment on the next entry and journals the switch.
6. Cost from `usage_update` into `cells.cost_usd`, priced by the roster as today.

### Non-goals

- Replacing the pane transport. ADR-033 stands: a seat inside a cmux workspace is a pane seat.
- Changing the envelope contract, the driver's stage loop, the gate, or the scope gate.
- Adopting acpx itself. acpx is a *client with a session store and a flow runtime*; the crew already has both (journal + ledger + `drive.mjs`). What is adopted is the protocol and, where useful, acpx's *design* — its `session/request_permission` escalation object is the shape the crew's decision envelope should take.
- Adopting ACP *draft* extensions (goal, session-failure, subagent) as load-bearing. They are read when present and never required.

---

## 3. Protocol facts this document relies on

Measured from agentclientprotocol.com and the two adapter repositories on 2026-08-30. Anything not listed here is not assumed.

### 3.1 Lifecycle

`initialize` (client sends `clientCapabilities`: `fs.readTextFile`, `fs.writeTextFile`, `terminal`; agent returns `protocolVersion`, `agentCapabilities.loadSession`, `promptCapabilities`, `mcpCapabilities`) → `session/new` (`cwd`, `mcpServers`) → `sessionId` → `session/prompt` (`sessionId`, `prompt: ContentBlock[]`) → stream of `session/update` → response `{ stopReason }`.

`session/load` replays the whole conversation as `session/update` (`user_message_chunk`, `agent_message_chunk`) before answering. `session/resume` reconnects without replay. `session/cancel` is a notification; the agent aborts and returns `cancelled`.

### 3.2 `session/update` kinds

`agent_message_chunk` · `agent_thought_chunk` · `plan` (entries with `content`, `priority`, `status`) · `tool_call` (`toolCallId`, `title`, `kind` ∈ read · edit · delete · move · search · execute · think · fetch · other, `status: pending`) · `tool_call_update` (`status` ∈ in_progress · completed · failed, optional `content` — text, `diff {path, oldText, newText}`, or `terminalId`, plus `locations`, `rawInput`, `rawOutput`) · `usage_update` (`used`, `size`, `cost`).

### 3.3 Permission

`session/request_permission` carries `sessionId`, the `toolCall`, and `options[]` each `{optionId, name, kind}` with `kind` ∈ `allow_once` · `allow_always` · `reject_once` · `reject_always`. The client answers `outcome: {selected, optionId}` or `outcome: cancelled`.

### 3.4 The two adapters

| | `@agentclientprotocol/claude-agent-acp` 0.70.0 | `@victor-software-house/pi-acp` |
|---|---|---|
| wraps | `@anthropic-ai/claude-agent-sdk` 0.3.238 — **not** the `claude` CLI | `@earendil-works/pi-coding-agent` SDK, one in-process `AgentSession` per ACP session |
| bin | `claude-agent-acp` | `pi-acp` |
| runtime | Node ≥ 22 | Node |
| permission requests | yes, with editable choices via extension | **no** — "pi does not request permission from ACP clients before tool execution" |
| session load/resume | via SDK | `session/list`, `session/load`, `resumeSession`; `unstable_forkSession` preview |
| usage | — (to verify) | `usage_update` after each turn with context size and cost |
| MCP | client MCP servers supported | **accepted, not wired** |
| model / thinking | via SDK options (to verify how effort maps) | `configOptions` `model`, `thought_level`; `session/set_config_option` |
| skills / extensions | slash commands; skill grants to verify | resource roots in `.pi-acp.yaml`; per-session manifest at `params._meta.piAcp.manifest` |

Two consequences drive the plan:

- **Pi's missing permission requests** mean the Pi builder and reviewer cannot be tool-gated through ACP today. The roster's `deny` for Pi seats must keep being enforced by the adapter's own tool list until pi-acp (or pi itself, per earendil-works/pi#4444) implements `session/request_permission`. This is a measured limitation, not a blocker: the crew already relies on `--exclude-tools` for Pi.
- **claude-agent-acp wraps the SDK, not the CLI.** Effort, `--append-system-prompt`, per-seat settings files, and the `<synthetic>` refusal shape are CLI behaviours; each needs an SDK equivalent found and pinned by test before the Claude ACP seat is trusted at judge tier.

---

## 4. Where ACP lands in the crew

### 4.1 The seam

```
drive.mjs ── assign(role, brief) ──► seat-io.mjs ── waitForEnvelope ──► returnPath
                                          │
                                          ├── pane          (cmux; unchanged)
                                          ├── headless-json (claude -p; retire after 6.3)
                                          ├── headless-rpc  (pi --mode rpc; retire after 6.3)
                                          └── acp           (NEW: crew/acp-client.mjs)
```

`crew/acp-client.mjs` owns: spawning the adapter, `initialize`, one `session/new` per seat (or `session/resume` on re-ask), `session/prompt` per assignment, the `session/update` fan-out to journal/ledger/heartbeat, `session/request_permission` dispatch to the policy, `session/cancel`, and process reaping through `crew/reclaim.mjs` exactly as `headless-rpc.mjs` does now.

Adapters (`crew/adapters/adapter-claude.mjs`, `adapter-pi.mjs`) gain an `acpLaunch(spec)` returning `{ bin, args, env, sessionParams }`. `capabilitiesFor({ transport: 'acp' })` returns a profile with `interjection: 'turn'`, `abort: 'cancel'`, `session_resume: true`, `durable_cursor: 'protocol'`, `reassign: false`.

### 4.2 JSON-RPC client: dependency decision

The plugin ships **zero runtime dependencies** (README, CLAUDE.md). `@agentclientprotocol/sdk` 1.3.0 would be the first. Two options, one to be settled by ADR-036:

- **A. Hand-roll.** NDJSON framing plus JSON-RPC 2.0 request/response/notification correlation is ~150 lines and has one fixture (recorded sessions). Types come from the published schema, pinned by test. Keeps the zero-dependency rule intact.
- **B. Depend on the SDK.** Gets schema types and `ClientSideConnection` for free; imports a Zod dependency; the rule gains its first exception.

Recommendation: **A**, because the protocol surface the crew uses is small and fixed, the zero-dependency rule has paid for itself in installability, and the SDK's client API is documented only by example. Revisit if the crew needs draft extensions or `fs`/`terminal` delegation.

### 4.3 Permission policy → decision envelope

```
roster seat.deny  ──►  policy { autoDeny: [tool kinds/names], autoApprove: [...], escalate: [...] }
request_permission(toolCall, options)
   ├─ policy settles it   → select the matching option; journal { kind:'permission', tool, option, policy:'roster' }
   └─ policy says escalate → closed-enum decision to the LEAD seat:
                              { question: 'permit', tool_call, options: [optionId…] }
                              lead answers by optionId; journal { policy:'lead' }
                              no lead in this tier → reject_once; journal { policy:'no-lead' }
```

This is the crew's existing "agent proposes, code disposes, judgment stays with seats" rule applied to tool permission. #529 (structured escalation carrying closed resolution options) is the same shape; ACP hands it to us wire-native.

### 4.4 Liveness and cost

- Each `session/update` arrival calls the same `onAlive(at)` #777 introduces for transcript growth, with `at` = the notification's receipt time stamped by the client — a measurement of the protocol, not a wall clock substituted later. #777's transcript path stays for `headless-json`/`headless-rpc` until they retire.
- `usage_update` writes the cell's tokens; pricing stays in `ledger.mjs` from `crew/roster.json` rates (PR 18ead22). Claude cost via ACP is **to verify** — if the adapter emits no `usage_update`, the cell is recorded `unpriced`, never zero.

### 4.5 Refusal and provider fallback

`stopReason: refusal` on a turn that produced no envelope, or a session-failure extension naming a quota/limit, is a **`budget`** cause in #779's vocabulary — recorded as such, never as `transport`.

A roster seat may declare `fallback: [{provider, id, agent}]`. On `budget`: cancel the session, journal `{ event:'seat-fallback', from, to, cause }`, boot the next entry over ACP, re-ask the same `assignment_id`. One fallback per assignment; a second refusal escalates with cause `budget`. This is the control that would have kept b332 and b333 alive on 2026-08-30.

---

## 5. Review-quality controls (ACP-independent, same programme)

Studied alongside: kunchenguid/no-mistakes (a Go push gate) and its author's 2026-08-30 note that adversarial review loops over-engineer and scope-creep — "usually caused by … sol" — fixed by (1) escalating scope expansion to a human more often and (2) auto-fixes preferring simplification over adding machinery. The crew's judge-tier tech-lead **is** `openai/gpt-5.6-sol` at `xhigh`; b330 escalated at the tech-lead round cap after three rounds on a plan that already existed. The same pathology, measured here.

None of these need ACP; they are listed because the transport work touches the same envelope and roster surfaces, and because the operator asked what else eliminates unwanted output.

| # | control | what changes | evidence it is needed |
|---|---|---|---|
| R1 | **Intent line** | `dispatch-batch` records `intent` (one sentence, from the request's `ask`) into the brief and journal; scope gate and reviewer compare the diff against it | no-mistakes `axi run --intent`; our scope gate adjudicates *paths*, not purpose (#770) |
| R2 | **Machinery budget** | plan check refuses a plan whose *new* exports/files/abstractions exceed the request's `creates` + a small allowance; the excess is an `ask-user` finding, never auto-accepted | plan_growth is measured but nothing acts on *added surface*; b330 |
| R3 | **Simplification-first repair** | the gate-repair and review-fix assignments carry a standing instruction: prefer deleting or narrowing over adding; a repair that adds a file or export must say why in the envelope | tweet claim (2); our repair briefs carry no such rule |
| R4 | **Finding disposition** | reviewer envelope finding gains `disposition` ∈ `auto-fix` · `ask-user` · `no-op`; the driver applies `auto-fix` mechanically (no seat), routes `ask-user` to the lead/operator | no-mistakes action enum; programmatic-over-model-tokens |
| R5 | **Tech-lead round cap by plan age** | an adopted plan (#763 `--adopt`) gets **one** tech-lead round, not the full cap | b330: three rounds, escalation, on an already-existing plan |
| R6 | **Reviewed-head rule** | any post-review automated repair publishes only if its parent is the reviewed sha; otherwise back through review | no-mistakes CI-repair proof; #758 closeout script will need it |
| R7 | **Claimed-vs-diff gate** | compare the builder envelope's claimed files/changes to `git diff --name-status`; mismatch is a must-fix | #772, already filed |
| R8 | **Pass-with-must-fix is a defect** | a reviewer `verdict: pass` carrying a `must-fix` finding is refused by shape, not accepted | #772 |
| R9 | **Seat-model round telemetry** | `ledger.mjs` recipe: tech-lead rounds, dissents, plan growth ratio **by seat model** | the tweet's claim about sol is measurable here today; nobody has run the query |

R7/R8 are #772 and need only a lane. R1–R5 are new and small. R9 is a query, not code.

---

## 6. Implementation plan

Waves have disjoint fences and may run concurrently. Nothing here may start before #788 Wave B lands, because #781 replaces the compiler proposal block and #780 the entry-point flags this work also touches — and **b334 (#777) is editing `crew/seat-io.mjs` now**; no ACP lane may hold that file until b334 lands.

### Wave 0 — decisions and measurement (no code)

- **ADR-036**: ACP as the headless seat transport; the envelope stays the record; dependency decision (§4.2); permission-as-decision (§4.3); retirement criterion for the two bespoke transports. Grep the register first — 035 is b332's.
- **R9 query** run once against the existing ledger and its result pasted into the ADR: tech-lead rounds and plan growth by model, 2026-08-29/30.
- **Spike (operator, not a lane):** boot one Claude and one Pi seat over their ACP adapters by hand against a scratch cwd; record the raw NDJSON of one full turn each into `test/fixtures/acp/`. These recordings are the fixtures every lane below proves against — no lane test speaks to a live agent.

### Wave 1 — the client and the transport (after Wave B)

| lane | tier | fence | done means |
|---|---|---|---|
| **acp-client** | build | `crew/acp-client.mjs` (new), `crew/acp-client.test.mjs` (new), `crew/capabilities.mjs`, `crew/capabilities.test.mjs` | drives the recorded fixtures end-to-end: initialize → new → prompt → updates → stopReason; `cancel` yields `cancelled`; a malformed frame refuses by name; `abort: 'cancel'` profile; **zero new dependencies** (source assertion) |
| **acp-adapters** | build | `crew/adapters/adapter-claude.mjs`, `adapter-pi.mjs`, their tests | `acpLaunch(spec)` for both; roster `deny` → policy; Pi's no-permission limitation recorded as `permission_requests: false` in its profile and the adapter keeps `--exclude-tools` semantics through pi-acp's manifest |

### Wave 2 — driving a seat (after Wave 1 and b334)

| lane | tier | fence | done means |
|---|---|---|---|
| **acp-seat** | judge (protected: `seat-io.mjs`) | `crew/seat-io.mjs`, `crew/seat-io-acp.test.mjs` (new), `crew/drive.mjs` **read only** | `waitForEnvelope` has an `acp` path: envelope arrival still ends the wait; `stopReason` is journaled beside it; a `refusal` with no envelope is `budget`; `onAlive` fires per `session/update`; the two existing paths are byte-identical (pinned) |
| **acp-permission** | build | `crew/acp-permission.mjs` (new) + test, `crew/roles/lead.md` | policy settles → journaled; escalate → lead decision envelope `{question:'permit'}`; no lead → `reject_once`; a mutation that auto-approves an unsettled request is killed |

### Wave 3 — facts into the ledger, fallback

| lane | tier | fence | done means |
|---|---|---|---|
| **acp-usage** | build | `scripts/factory/emit.mjs`, `scripts/factory/ledger.mjs`, their tests, `docs/ledger-queries.md` | `usage_update` → cell tokens; unpriced when absent, never zero; `tool_call` rows with `kind`/`status`/`locations` in a new `seat_tool_calls` table; permission rows; `stopReason` on the assignment |
| **seat-fallback** | build | `crew/roster.schema.json`, `crew/roster.json`, `crew/crew.mjs` (seat resolution), `crew/crew.test.mjs` | `fallback[]` validates; on `budget` the same `assignment_id` is re-asked once on the next entry and journaled; a second refusal escalates `budget`; the 2026-08-30 b332/b333 streams are the fixture |

### Wave 4 — review-quality controls

| lane | tier | fence | done means |
|---|---|---|---|
| **review-disposition** (R4, R8) | judge (reviewer charter) | `crew/roles/reviewer.md`, `crew/drive.mjs` (envelope shape), `crew/drive.test.mjs`, `skills/pr-review/references/findings-shape.md` | `disposition` on findings; `pass` + `must-fix` refused by shape; `auto-fix` applied by the driver with no seat |
| **scope-intent** (R1, R2, R3) | build | `scripts/factory/dispatch-batch.mjs`, `scripts/factory/make-brief.mjs`, `crew/roles/planner.md`, `crew/roles/builder.md`, tests | `intent` recorded and carried; machinery budget refuses over-creation as `ask-user`; repair briefs carry the simplification rule, pinned |
| **adopted-plan-rounds** (R5) | build | `crew/drive.mjs`, `crew/drive.test.mjs` | an `--adopt`ed plan gets one tech-lead round; fixture from b330 |
| **claimed-vs-diff** (R7) | build | per #772 | per #772 |

### Wave 5 — retire

Only after ≥10 lanes have run over `acp` across both agents with no transport-caused escalation: delete `headless.mjs`'s stream parser and `headless-rpc.mjs`'s supervisor, keep `reclaim.mjs`, update ADR-029/033 references. This wave is gated on the measurement, not the calendar.

---

## 7. File impact map

| file | Wave | change |
|---|---|---|
| `crew/acp-client.mjs` (new) | 1 | JSON-RPC/NDJSON client, session lifecycle, update fan-out |
| `crew/acp-permission.mjs` (new) | 2 | policy + lead escalation |
| `crew/adapters/adapter-claude.mjs`, `adapter-pi.mjs` | 1 | `acpLaunch`, `permission_requests` capability |
| `crew/capabilities.mjs` | 1 | `acp` transport profile |
| `crew/seat-io.mjs` | 2 | `acp` branch in both wait sites; `onAlive` per update |
| `crew/roles/lead.md`, `reviewer.md`, `planner.md`, `builder.md` | 2, 4 | permit decision; disposition; intent; simplification rule |
| `scripts/factory/emit.mjs`, `ledger.mjs` | 3 | usage, tool calls, permissions, stopReason |
| `crew/roster.schema.json`, `roster.json` | 3 | `fallback[]` |
| `scripts/factory/dispatch-batch.mjs`, `make-brief.mjs` | 4 | intent, machinery budget |
| `crew/drive.mjs` | 2 (read), 4 (write) | envelope shape, adopted-plan rounds |
| `test/fixtures/acp/*.ndjson` (new) | 0 | recorded sessions — the only agent the tests ever talk to |
| `docs/adr/adr-036-*.md`, `docs/adr/README.md` | 0 | the decision |

---

## 8. Verification strategy

- **Recorded sessions are the agent.** Every ACP test replays NDJSON captured in Wave 0. No test spawns `claude-agent-acp` or `pi-acp`; a lane whose test needs a live adapter has the wrong test.
- **Every gate check has a kill-mutation** (CLAUDE.md). Named mutations the plan requires: auto-approving an unsettled permission; recording `refusal` as `transport`; pricing an absent `usage_update` as zero; substituting `Date.now()` for a notification timestamp; accepting `pass` with a `must-fix`.
- **Byte-identical pins on the untouched paths.** The pane path and both bespoke headless paths are pinned by fixture before Wave 2 changes `seat-io.mjs`, exactly as #777 pins the pane path.
- **Release gates (§11 of the task-configuration TRD) apply unchanged**: `npm test`, `npm run viz:build`, old ledger fixtures readable, no UI inference from names, an escalation is not a failure, an old heartbeat is not a dead task.

---

## 9. Risks and mitigations

| risk | mitigation |
|---|---|
| `claude-agent-acp` wraps the SDK, so CLI-specific seat behaviour (effort flag, appended system prompt, per-seat settings, `<synthetic>` refusal shape) may not map | Wave 0 spike pins each mapping by recorded fixture before any lane; unmapped behaviour is a named gap in ADR-036, not a silent loss |
| pi-acp does not implement permission requests or MCP | Pi seats keep adapter-side tool exclusion; capability profile says so; Pi permission escalation is out of scope until upstream lands it |
| First runtime dependency if §4.2 chooses B | Recommendation is A; the ADR records whichever is chosen and why |
| Adapter churn (0.70.0; draft extensions) | Pin exact versions in the launch spec; read extensions, never require them; Wave 5 retirement waits for measured stability |
| Two transports in flight doubles the wait-site surface during Waves 2–5 | `seat-io.mjs` changes only in the judge-tier acp-seat lane; b334 lands first; byte-identical pins on the old paths |
| Fallback masks a systemic outage as a per-seat blip | one fallback per assignment; the switch is journaled with cause; the escalations query (#779) groups by cause so a wave of `budget` is visible |

---

## 10. Decisions still requiring an ADR, not a guess

| # | decision | recorded by |
|---|---|---|
| 1 | ACP as the headless transport; envelope remains the record | ADR-036 |
| 2 | Hand-rolled JSON-RPC vs `@agentclientprotocol/sdk` (zero-dependency rule) | ADR-036 |
| 3 | Permission requests are lead decisions; the no-lead default is `reject_once` | ADR-036 |
| 4 | Provider fallback is one-shot per assignment and journaled | ADR-036 §fallback, or its own if it lands first |
| 5 | Retirement criterion for `headless-json` / `headless-rpc` | ADR-036 |
| 6 | Whether R2's machinery budget is a refusal or an `ask-user` finding | Wave 4 lane, after R9's numbers |

---

## 11. Definition of done

- Both roster agents boot and complete a real lane over `acp`, headless, with `stopReason`, tool calls, permissions and usage in the ledger and no transcript scraping on that path.
- A seat that hits a provider limit is recorded `budget`, falls back once, and the lane finishes.
- The reviewer's `pass` cannot carry a `must-fix`; `auto-fix` findings are applied without a model seat.
- Tech-lead rounds and plan growth are reported by seat model, and the number for `gpt-5.6-sol` is in the ADR — whatever it turns out to be.
- `headless.mjs` and `headless-rpc.mjs` are deleted, or ADR-036 says exactly why they are not yet.
