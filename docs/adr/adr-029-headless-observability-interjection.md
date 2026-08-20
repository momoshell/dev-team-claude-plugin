# ADR-029: Headless observability and interjection — the pane-parity matrix for piped seats

**Status:** RATIFIED 2026-08-13 (all seven §8 questions answered; see §9) · **Source:** issue #85 (epic #80) · **Evidence:** `tasks/headless-worker/spike-findings.md` (HW-1, claude), `tasks/headless-worker/pi-spike-findings.md` (HW-1b, pi)

---

## 0. Status, scope, and the numbering choice

This record was ratified by the user on 2026-08-13; §9 carries the seven answers and what each one commissions. It continues the ADR sequence as ADR-029, puts the full record in `docs/`, and adds a one-line proposed-number pointer to the existing register at the legacy path `.claude/dev-team/memory/architecture-notes.md`. That tree is described as retired but is git-tracked and remains the active register: it contains ADR-024 through ADR-028, and shipped code still cites ADR numbers. The orchestrator is filing register cleanup separately; this ADR records the finding and does not fix the path.

The scope is headless, piped crew seats: observability, interjection, attention signals, and the constraints on escalation recovery. #80's daemon architecture and its invariant **`idle ≠ success`** are ratified input: liveness is a give-up signal, while the envelope and authoritative task records determine outcome. Nothing in this ADR makes screen state or process state authoritative. This ADR amends issue #85's own body on escalation recovery. It fixes constraints, not the transition mechanism: #125 owns the park/lease transition protocol, alongside #83, and its prior protocol analysis is preserved there.

## 1. Context — what the pipe takes away

A pane gives a human a place to watch and a place to type. A pipe gives neither. The shipped cmux surface today is the `crew-stage` pill, the plan viewer, warm-workspace-on-escalation, and `crew.mjs status`; the legacy runtime that carried the rest was deleted at `81dee7c`. It was retired, not imaginary. The old observe-mode affordance really shipped at `d3d7dee` before that retirement.

Observability is nevertheless optional by construction. The driver talks to the world through injected `io`; `emit`, `status`, `showDoc`, and `runClean` are optional members (`crew/drive.mjs:119-131, 144, 150, 339, 481`; `crew/drive.test.mjs:20-58`). A headless invocation can omit those sinks without making execution depend on a screen. The durable task directory, journal, envelopes, agent transcripts, and the selected ledger mirror therefore matter more than a pane's pixels.

The two spike documents establish different headless transports, not interactive-pane behavior. HW-1 captured `claude -p` (`headless-json`); HW-1b captured one-shot pi JSON children and pi `--mode rpc` (`headless-rpc`). Neither spike exercised an interactive pane. The matrix below consequently treats pane values conservatively rather than inheriting values from headless captures.

## 2. Decision 1 — observability: the pane-parity matrix

A human watches the run's existing durable record—journal, task-directory artifacts, envelopes, and the ledger's coarse lifecycle mirror—surfaced by the visualizer, plus a live daemon projection for latency. The screen is never the record. The visualizer may render richer views, but it must link back to authoritative files and must not turn screen text into an outcome.

| Affordance | cmux mode today (evidence) | Verdict | Headless replacement | Owner slice |
|---|---|---|---|---|
| Markdown plan viewer (`crew/crew.mjs:537-554`, `crew/drive.mjs:333-339`) | Auto-mounted document surface; the plan is already a file | degraded | Keep `plan.md` as the file; the visualizer renders the task directory and `factoryctl attach` streams the run. Headless `io` may omit `showDoc?.()` | #83, #49 |
| `crew-stage` pill (`crew/crew.mjs:526-530`, feed `crew/drive.mjs:146-150`) | Best-effort `cmux set-status crew-stage <label>` | carried | Existing stage-label vocabulary flows through `io.emit({kind:'stage'})` into an `emitAdapter` phase transition plus `log` row. There are **16** forms, including `gate-baseline:green-bounce` | #83, #48, #49 |
| Attention moment — tier confirm (`cmux-design-record.md:58`) | Hand-typed orchestrator prose, never code | dropped (pre-headless) | Nothing replaces it; the tier is chosen at boot | — |
| Attention moment — plan approval | Hand-typed orchestrator prose, never code | dropped (pre-headless) | Nothing replaces this human prompt; the driver accepts or bounces the plan through the tech-lead check (`crew/drive.mjs:305-331`). A future interactive mode is an open question | — |
| Attention moment — gate verdict (human-facing) | No per-gate verdict reaches a human today; enum names are not a crew write path | carried with a caveat | #130 mirrors gate verdicts to `gate_results`; attention fires only on gate exhaustion or triage escalation, not on ordinary red-then-green | #130 |
| Attention moment — insufficiency / escalation (`crew/drive.mjs:270-278`) | The one attention moment with a real driver transition | carried (degraded) | Emit the §4 `attention` run event. It survives a subscriber gap through server-side unresolved-attention derivation; live delivery is sink-dependent, while the record is not | #83, #46 |
| Interjection observe-mode (`d3d7dee:scripts/cmux/gate-mode.sh:2-10,47-51`, `d3d7dee:scripts/cmux/return-gate.sh:195-201`) | Shipped observe mode changed the gate on human interjection; it was retired at `81dee7c` | dropped (retired at `81dee7c`) | Replace its intent with §3's capability-gated interjection, honest per agent and per transport. Typing into a live pane breaks `sendLine()`'s echo-baseline contract (`crew/driver.mjs:147-202`) | #83 |
| Warm panes on escalation (`crew/crew.mjs:623-635`, `crew/README.md:168-170`) | Escalation leaves panes warm; done tears them down/archive | dropped | No panes are kept. Preserve the invariant as §5: never discard the task directory, journal, envelopes, or resumable seat context a successor needs | #125 |
| Live pane scrollback / `read-screen` triage | Human glanceability from terminal pixels | degraded | Use the agent event stream, richer and machine-correlatable but not glanceable without a UI (`spike-findings.md:243-253`, `pi-spike-findings.md:7-28`), and link to raw artifacts. It is lossy across a client disconnect | #49 |
| Tri-state seat liveness + `crew status` (`crew/crew.mjs:399-431, 761-774`) | Today's probe is `true` (alive), `false` (dead), or `null` (indeterminate); only `false` counts toward death and an envelope beats a dead pane (`crew/crew.mjs:414-415`) | carried | The daemon's `state(worker)` query returns #80's closed `working\|blocked\|done\|dead` enum and `factoryctl ls` surfaces it. A failed/unreachable query is client-side **unknown**, never `dead` | #83, #46 |
| Attention notification channel (`cmux notify`, allow-listed but never invoked by crew) | A possible cmux sink, not a crew record | dropped | An attached cmux-side client invokes `cmux notify` from §4; the sink is never the record | #83, #46 |
| Workspace as a place to stand (human `cd` into a warm checkout) | A human can re-enter a warm checkout/task workspace | carried | Checkout and task directory are transport-independent. Re-entering a parked run on the floor is the #125 lease transition | #125 |

The `crew-stage` labels are selected lifecycle facts: stage → phase transition plus `log`, assign → `agent_start`, envelope → `agent_end`, and decision/dissent → `decision` (`crew/crew.mjs:362-384`). The ledger vocabulary is deliberately narrow; it has no blocked, terminal-result, died, or usage event, and `tool_call` is only `{tool, ok}` (`scripts/factory/ledger.mjs:80-104`).

**Rejected:** binding a cmux `agent-session` surface to a daemon-created session. That re-couples observation to a terminal manager, presumes a provider surface can attach to an externally-created session (never spiked), and cannot be authoritative because cmux has no per-surface process-exit event (`tasks/cmux-mode/spike-findings.md:31`). Stderr tailing is also rejected: it is neither a durable record nor a safe interjection/attention protocol.

## 3. Decision 2 — interjection: per-agent, per-transport capability profiles

Interjection is asymmetric per agent. Claude cannot promise stdin mid-turn: text stdin is read to EOF before the turn starts (`spike-findings.md:215-225`), while pi's `steer` is live-verified boundary delivery: it queues while a tool runs, leaves that tool undisturbed, and arrives before the next LLM call (`pi-spike-findings.md:109-125`). It is also asymmetric per transport. `adapter-pi.mjs:11-31` exports one static object, but its `seatCommand` (`:74-113`) launches interactive pi, not `--mode rpc`; `:85-88` deliberately omits `--print`/`--no-session` to preserve pane persistence. A top-level `interjection: boundary` would describe a transport the adapter does not run. Capability is a property of the `(adapter, transport)` pair, not of the adapter.

The first table is the normative profile matrix. Every cell must be pinned exactly by test (§7); today none of these per-transport cells exists or is test-pinned. The evidence is headless evidence and is not silently transferred to a pane.

| Flag | Values | claude · pane | claude · headless-json | pi · pane | pi · headless-rpc | Evidence to cite |
|---|---|---|---|---|---|---|
| `interjection` | `none` \| `turn` \| `boundary` | `none` | `turn` | `none` | `boundary` | `spike-findings.md:215-225`, `:228-239`, `:52-63` vs `pi-spike-findings.md:109-125` |
| `abort` | `none` \| `signal` \| `command` | `none` | `signal` | `none` | `command` | `spike-findings.md:124-131`, `:133-140` vs `pi-spike-findings.md:127-144` |
| `session_resume` | `true` \| `false` | `false` | `true` | `false` | `true` | `spike-findings.md:52-63` vs `pi-spike-findings.md:44-66`, `:167-181` |
| `durable_cursor` | `none` \| `entry_id` | `none` | `none` | `none` | `entry_id` | `spike-findings.md:79-88` vs `pi-spike-findings.md:152-165` |

The resolution API replaces the flat `capabilities` export:

```js
// returns one frozen, resolved profile
export function capabilitiesFor({ transport })
```

`transport` is a closed set: `'pane' | 'headless-json' | 'headless-rpc'`. The frozen result carries every key: transport-invariant `prompt_file`, `tool_deny`, `unattended`, and `effort`, plus transport-scoped `interjection`, `abort`, `session_resume`, and `durable_cursor`. Consumers read exactly one object and never merge profiles. An adapter that does not implement a requested transport throws while naming the adapter and transport; it never guesses a passthrough or silently defaults, following `adapter-pi.mjs:38-42`'s refusal of an unknown provider.

Today `crew/crew.mjs:186` calls `assertCapabilities(role, name, adapter.capabilities)` with a flat adapter-wide object and no transport input. That is current behavior, not the design. #83 must replace that call: resolve the seat's transport, then pass the resolved profile to `assertCapabilities` (`crew/crew.mjs:100-104`). #45 filters factory eligibility on the same resolved profile. A request for an unsupported adapter/transport fails at boot, just as `tool_deny` does today. Shipped profiles, and only shipped profiles, are claude → `pane`, `headless-json`; pi → `pane`, `headless-rpc`. Pi deliberately has no `headless-json` profile: one-shot `--mode json` is not a ratified crew transport (`pi-spike-findings.md:183-185`). #83 replaces the current pi-only deep equality (`crew/crew.test.mjs:133-138`) and claude frozenness-plus-`tool_deny` assertion (`:105-109`) with exact assertions for every shipped profile.

The pane columns are conservative. Every capture in both spikes was headless; neither exercised an interactive pane. The pane transport owns neither a session nor a process handle. Crew retains a cmux `pane_id`/`surface_id` (`crew/crew.mjs:301, 309`), never a PID; termination is `close-surface`, and cmux has no per-surface process-exit event (`tasks/cmux-mode/spike-findings.md:31`). Thus `abort: none`: `signal` requires supervisor termination plus independent EOF/process evidence. `session_resume: false`: neither pane command supplies `--session-id` (`adapter-pi.mjs:24`; the claude byte-identity pin is `crew/crew.test.mjs:101`), and sending another assignment to a live TUI is not persisted-session resume. `interjection: none`: `sendLine()` throws rather than typing into a dirty echo baseline (`crew/driver.mjs:147-202`), and no pane capture establishes mid-assignment behavior. A pane profile may declare `abort: signal` or `session_resume: true` only once that transport owns an explicit handle and the behavior is captured. Amendment note (2026-08-20, #149): the first half of this paragraph is falsified. `cmux top --processes --json --all` attributes pids to a surface and to their descendants — verified live 2026-08-20, `surface:27` returning pid 7433 plus the chain 32052 → 32061 → 32080 under one `cmux_surface_id` — so a pane seat's process tree IS resolvable from the `surface_id` the crew already retains, and both the sentence above and the §6 row at line 123 are superseded on the no-handle point (that row is left as written, per the record's structure). `crew/driver.mjs`'s `surfaceProcessTree()` is that handle: read-only, performing exactly the three calls `cmux tree` → `cmux top` → `cmux tree`, because `top` prints per-invocation refs and the retained UUID is translated through `tree --id-format both`, whose mapping must be identical in both bracketing reads or the result is unknown. What it reports is a point-in-time attribution snapshot naming the surface's foreground process-group leader, with the attributed forest beside it. `abort: none` nevertheless stands for every pane profile, because this ADR conditions `abort: signal` on a handle AND captured behaviour: captured termination behaviour remains unproven, and capturing it means signalling a live seat — destructive, and a separate ratification. The unproven remainder is target selection and snapshot freshness (including PID reuse), signal delivery, EOF/process evidence, and settle behaviour under termination. Placement was chosen to keep this record true: `surfaceProcessTree()` is appended at end of file, so `sendLine()`'s cited range `crew/driver.mjs:147-202` was verified unchanged by this change and the three citations of it in this ADR (lines 33, 68 and 124) were checked rather than left unexamined.

Normative meanings are closed:

- `interjection: none` means no supported message into a running assignment. `turn` means a subsequent invocation against the session after the current turn settles. `boundary` means queued mid-turn, delivered between tool calls before the next LLM call, without disturbing the in-flight tool. There is no reserved `steer` rung.
- `abort: none` means no supported interruption. `signal` means supervisor termination with independent EOF/process evidence and **no graceful-settle promise**: a terminal event may be present or absent, and EOF without terminal is incomplete (`spike-findings.md:124-140`, `:23-35`). `command` means an in-protocol abort followed by waiting for the agent's own verified settled condition; pi's condition is `agent_settled`, not `agent_end` (`pi-spike-findings.md:127-144`, `:146-150`).
- `session_resume: true` means a later invocation/process continues the same persisted context (`spike-findings.md:52-63`; `pi-spike-findings.md:44-66`). It does not claim claude's forced-abort-then-resume composition, which is unverified (`spike-findings.md:287`); pi's post-SIGKILL recovery is captured (`pi-spike-findings.md:167-181`).
- `durable_cursor: none` means no client-resumable observation cursor; a durable session file is not a cursor. `entry_id` means the agent's session-entry id survives client restart and rejects unknown ids explicitly (`pi-spike-findings.md:152-165`). There is no speculative `seq` rung.

Claude's `turn` is therefore narrow: forced abort plus same-session resume was not verified as a combined operation (`spike-findings.md:124-140, 287`). This amends the issue vocabulary by splitting `none` from `turn`, dropping `steer` as a declared rung, and using no duplicate `resume` flag. The driver must **never offer** an affordance a seat's **resolved profile** cannot honor. It refuses an above-level request with the reason and names the next-best offer. The ratified transport premise is a long-lived `--mode rpc` process, one process per worker session (`pi-spike-findings.md:183-185`). An interjection is guidance, not an outcome.

**Rejected:** the flat adapter-wide object, which would ship false `boundary` on an interactive pane; bounce-only/no mid-run interjection; one uniform interjection contract; and claude `--input-format stream-json` as a promised channel today. Claude accepted one stream-json user record but did not establish a multi-message or mid-turn protocol (`spike-findings.md:228-239`).

## 4. Decision 3 — attention signals

The durable record is the one that already exists; the daemon's normalized stream is a live projection, not a second record, and unresolved attention is derived server-side, never stream-only.

**Authoritative files.** The journal (`crew/drive.mjs:146-150`), task directory, `returns/task.json` (`crew/crew.mjs:621`), and each agent's session transcript remain authoritative. This ADR adds no new durable feed. ADR-024's one-mirror rule applies: the ledger holds selected lifecycle facts, not bytes. `emitAdapter` mirrors stage/phase plus log, agent start, envelope end, and decision/dissent (`crew/crew.mjs:362-384`); its closed vocabulary has no blocked, terminal-result, died, or usage event and its `tool_call` payload is only `{tool, ok}` (`scripts/factory/ledger.mjs:80-104`). Files remain authoritative; the ledger is not a byte-for-byte replay store.

On reconnect, a client gets coarse lifecycle from the ledger mirror plus journal and links to raw artifacts. It does not receive replay of the disconnected live normalized worker stream. The projection is intentionally lossy across a disconnect. With cmux absent, the ledger and journal remain the record. The cmux hook feed is an optional pane-mode input bridge; the turn-end event is `agent.hook.Stop`, not `notification.requested` (`tasks/cmux-mode/spike-findings.md:81-82`). `io.emit?.()` is optional and try/caught (`crew/drive.mjs:144`), and ADR-026 makes instrumentation non-load-bearing.

The one canonical schema for both live and synthetic delivery is:

```text
attention{ moment, park_id, task, why, artifacts[] }
```

`moment` is a closed enum with two members: `escalation | gate`. Amendment note (2026-08-14, #130): answer 3 forbids pre-declaring members nothing emits; #130 now emits `gate`, so this extension is recorded here as a change. Amendment note (2026-08-14, #165): the prior deviation is retired for escalation attention — `crew.mjs`'s run lifecycle mints a park on an escalation outcome and the escalation attention event carries its real id, so #83/#46 may emit live attention with a real id. Gate-moment attention keeps `park_id: null`: it may fire before a run's terminal outcome, and minting there would strew parks across runs that never park. A mint failure is loud but non-fatal: escalation remains the outcome, and the warm workspace remains the recovery context. `park_id` remains present on every attention event either way, live or synthetic. #83's daemon derives an unresolved snapshot from park and envelope authority and emits it before each subscription's live tail. Resolved and abandoned parks are omitted. Thus an escalation raised while nobody was attached reaches the first client that attaches, preserving the no-subscriber delivery property measured by cmux (`tasks/cmux-mode/spike-findings.md:83`) without promising exact live-stream replay.

Dedupe is per client, never global. Presentation and `cmux notify` deduplicate by stable `park_id`, with that client's acknowledgement persisted. A global already-notified bit would allow the first bot client to suppress the escalation for every later human client. `cmux notify` is invoked by an attached cmux-side client, never by the daemon: socket reach under `cmuxOnly` was verified only for a process inheriting cmux identity/env from a cmux-launched ancestor (`tasks/cmux-mode/spike-findings.md:43-60`). Sink failure is sink-local; because unresolved attention is derived per subscription, a missed notification delays sighting but does not lose the escalation.

The #83 mirroring delta is to record escalation as a `decision` row and close the run with the correct `SESSION_STATUSES` value. A new ledger event type is not recommended for a fact already representable in the selected vocabulary. The attention run event is not completion evidence, and an interjection is not an outcome.

**Rejected:** a second durable run feed with its own sequence/replay protocol; `cmux events` as the attention record (ids are boot-scoped and the log rotates at 16 MiB); `cmux notify` as the primary channel; a global already-notified flag; and stderr tailing. `cmux notify` is a sink, not the attention record.

## 5. Decision 4 — escalation recovery: the constraints

`driveTask` holds every piece of control state in local variables (`crew/drive.mjs:133-140, 280-285, 355-400`); `escalate()` returns out of the call (`:270-278`), and `runCmd` ends the emitter, writes `returns/task.json`, and returns (`crew/crew.mjs:619-638`). Escalation is therefore terminal for this driver invocation. This ADR amends issue #85 accordingly.

1. **Escalation is terminal for its driver invocation.** There is no suspended continuation and nothing to reacquire. A stage label cannot reconstruct round counters, consult budget, bounce briefs, or gate-repair state.
2. **Recovery is a new linked run**: a new run id, `resumes_park_id`, and the human's guidance as input. It may reuse parked seat sessions only when the resolved profile's `session_resume` permits it. A seat that cannot resume is cold-booted with journal, envelopes, and plan as context; parked state records which seats return warm and which cold. Its exact shape belongs to #125. Since pane profiles currently declare `session_resume: false`, pane recovery is cold-boot today.
3. **Sessions are exclusive and released before reuse.** Observed claude headless callers and pi one-shot JSON callers were not serialized (`spike-findings.md:65-77`; `pi-spike-findings.md:44-66`), with the claude finding scoped to this version and tested timing; pi same-session RPC concurrency is unknown (`pi-spike-findings.md:209`). No transport may rely on provider serialization. #125 must enforce exclusivity and release a session before another run resumes it.
4. **Transitions require a real lock with fencing.** An atomic rename is not a compare-and-swap. Rename is atomic as a write but does not verify the content inspected: two contenders can read epoch N, both replace with N+1, and both cross the safety boundary.

The transition mechanism—the park claim and state machine, park- and seat-level lock scopes, deterministic lease ordering, all-or-nothing acquisition with rollback, lock primitive, and its own recovery path—is deferred to **#125**, owned alongside #83 because the daemon must honor it. This is a distributed transaction with at least three crash windows: a claimed-but-not-enqueued phantom successor, a recovery lock that can wedge, and partial seat acquisition. Those are already #125 acceptance criteria; the analysis is preserved there, not discarded. A decision record that names an open mechanism is honest; one specifying an unimplementable protocol is not.

**Rejected:** true driver checkpoint/resume (persisting all `driveTask` locals and a program counter would turn `drive.mjs` into a checkpointed state machine and is outside #83, whose scope leaves it unchanged); transcripts-only handoff (transcript archaeology and abandonment of warm context); and keeping workers alive while parked. The last is declined as a resource/ownership policy, not because cost or impossibility was measured: an idle RPC holder could in principle remain the sole session holder, but a parked run has no useful work and would keep ownership live while a human, not the daemon, is the blocker.

## 6. Evidence gaps this ADR decides around

| Gap | Evidence | How this ADR decides around it |
|---|---|---|
| Pi exit status is unverified for the one-shot `--mode json` arms | `pi-spike-findings.md:30-42`, `:61`, `:68-79`; the RPC arm records `first_exit code=null signal=SIGKILL`, `second_exit code=0` (`:167-181`) | The RPC arm is not in this gap. A pi terminal is `agent_settled` plus the envelope. The one-shot JSON profile is not shipped |
| Claude forced-abort-then-resume is unverified as a combined operation | `spike-findings.md:124-140`, `:287` | `interjection: turn` promises next-turn guidance only |
| Claude mid-turn stream-json injection is unverified | `spike-findings.md:238-239` | It is out of every profile |
| Pane abort and resume are unmeasured and the transport owns no handle | No spike exercised a pane; no `--session-id` (`adapter-pi.mjs:24`, `crew/crew.test.mjs:101`); crew retains a surface id, not a PID (`crew/crew.mjs:301, 309`); cmux lacks per-surface process-exit (`tasks/cmux-mode/spike-findings.md:31`) | Both pane profiles declare `abort: none`, `session_resume: false`. A pane may declare `signal`/`true` only after owning an explicit handle and capturing the behavior |
| Pane interjection is unmeasured | No capture establishes what mid-assignment `send` does; `sendLine()` throws into a dirty box (`crew/driver.mjs:147-202`) | Both pane profiles declare `interjection: none` |
| Pi retry behavior is unobserved | `pi-spike-findings.md:146-150` | Wait for `agent_settled`; `willRetry` remains unmodelled |
| Session retention/GC is untested for both agents | `spike-findings.md:90-91`, `pi-spike-findings.md:202-210` | Cold-boot fallback in constraint 2 is required |
| Concurrent RPC clients on one session were never tested | `pi-spike-findings.md:209` | Constraint 3 is our requirement, not a provider guarantee; it is why #125 exists |
| cmux cursor durability across restart is untested and ids are boot-scoped | `docs/trd-cmux-execution-mode.md:719`, `tasks/cmux-mode/spike-findings.md:30,84` | cmux is a sink, never the record |
| Daemon socket reach under `cmuxOnly` is unproven for non-cmux-descended processes | `tasks/cmux-mode/spike-findings.md:43-60` | The notifier is an attached client |

## 7. Consequences and owner slices

This ADR changes no code.

| Consequence | Owner |
|---|---|
| Headless `io` and daemon: `attention` run event carrying `park_id`; server-side unresolved snapshot before each subscription's live tail; `decision`-row mirroring; `capabilitiesFor({transport})` in both adapters replacing the flat `crew/crew.mjs:186` call; exact per-profile assertions in `crew/crew.test.mjs` replacing pi-only deep-equal and claude's partial check; stage emission; `state(worker)` | #83 |
| Park/lease transition mechanism behind §5, minting `park_id` before #83 emits live attention, and floor re-entry into a parked run | #125 |
| `attach` consumes attention; `send` carries the human answer; per-client `park_id` dedupe and persisted acknowledgement; existing `ls`/`attach`, with no new verbs | #46 |
| Board, swimlanes, event inspector, and plan render consume the same attention snapshot; cmux-notify bridge is an attached client and dedupes per client | #48/#49 |
| Factory eligibility filters on the resolved capability profile | #45 |
| Driver checkpoint/resume (§8 q6) stays unowned; per-gate result emission/mirroring (§8 q5) is owned and landed by #130 | #130 / Unowned |

The exact capability assertions are a consequence, not a suggestion: #83 must name every shipped `(adapter, transport, flag)` cell in `crew/crew.test.mjs`, for both adapters, and assert the frozen resolved object exactly. Today only pi's complete flat object is deep-equalled (`crew/crew.test.mjs:133-138`), while claude checks frozenness and `tool_deny` (`:105-109`).

**`idle ≠ success`** (`crew/README.md:143-144`). Nothing here makes screen or process state authoritative for outcome; envelopes and files remain authoritative.

## 8. Open questions for ratification

1. Yes/no/amend: ratify the numbering choice—ADR-029 in `docs/` plus a register pointer—and the register finding recorded in §0.
2. Yes/no/amend: ratify pi `--mode rpc`, one process per worker session, as the premise of `headless-rpc`, and ship no pi `headless-json` profile.
3. Yes/no/amend: keep `moment` as a one-member enum (`escalation`), or pre-declare tier-confirm, plan-approval, and gate-verdict for a future interactive mode?
4. Yes/no/amend: should a human answer to a parked run be a structured record, or may it ride `send`'s message? This ADR requires only that it identify the park; #125 owns the shape.
5. Yes/no/amend: upgrade gate-result observability by emitting and mirroring per-gate results via `recordGateResult`, with attention firing only on gate exhaustion/triage escalation? This requires a `drive.mjs` change and an owner other than #83-the-transport.
6. Yes/no/amend: should driver checkpoint/resume be commissioned? §5 rejects it and issue #85 is amended accordingly.
7. Yes/no/amend: should “send another assignment to a still-live pane seat” be minted as its own capability? §3 declines to overload `session_resume`; if pane transport should advertise it, it needs a name and definition.

## 9. Ratification — 2026-08-13

All seven §8 questions answered by the user. The answers below are the decision; where one commissions work, the owner is named.

1. **Numbering — ratified as posed.** ADR-029 in `docs/`, with the pointer in the legacy register. The register's *location* is not settled here: issue #128 owns whether `.claude/dev-team/` remains the ADR home. Ratifying the number does not ratify the path.
2. **pi `--mode rpc`, one process per worker session — ratified**, and pi ships **no** `headless-json` profile. Declaring a profile the adapter does not run is the same species of fiction as the flat adapter-wide object this ADR removed (§3).
3. **`moment` stays a one-member enum (`escalation`) — ratified.** Pre-declaring members nothing emits is how this document's own first draft produced a false claim: a reader saw `gate_pass` in the ledger's `EVENT_TYPES` and inferred a write path that has no caller. A closed enum is cheap to extend when a second moment exists and is emitted. *(Superseded in part, 2026-08-14, #130: that condition is now met — `gate` is emitted, so §4's enum reads `escalation | gate`. The ratified principle stands unchanged; only the member count moved. The answer's text is preserved as the record of what was decided on the day.)*
4. **A human answer to a parked run is a structured record — ratified.** It carries a stable `decision_id`; it does not ride free text. #125's first crash window is precisely that *idempotent input is not idempotent execution*, and a retry can only be recognised as a retry if the answer is identifiable. #125 owns the record's shape; this ADR fixes that it is structured and park-identifying.
5. **Gate-result observability — landed by #130.** Today no per-gate verdict reaches a human at all: the gate result is journalled and pilled, never mirrored, so it does not survive the workspace. The driver emits per-gate results, `emitAdapter` maps them through `recordGateResult`, and an attention moment fires only on gate exhaustion or triage escalation — not on ordinary red-then-green. This requires a `drive.mjs` change and therefore an owner **other than #83-the-transport**; filed as **#130**. Rationale of record: on 2026-08-13 a task's gate was green while review found three must-fixes, and the crew cannot currently measure how often that happens.
6. **Driver checkpoint/resume — NOT commissioned; §5's rejection ratified.** Persisting every `driveTask` local plus a program counter would turn the driver into a checkpointed state machine and contradicts #83's scope of leaving `drive.mjs` unchanged. Linked runs deliver the outcome a human cares about.
7. **`reassign` is minted as its own capability — ratified.** The runtime already sends a still-live pane seat repeated assignments — every bounce brief is one — while the pane profile declares `interjection: none`, `session_resume: false`, `abort: none`. Nothing in the matrix names that ability, so the table implies something false about the transport the crew uses daily. The distinction is closed: **`interjection` acts on a seat mid-turn; `reassign` gives a new assignment to a seat that has settled.** Per-transport values are NOT set here: pane is established by the driver's own bounce path (`crew/drive.mjs` build/review bounces, exercised continuously), and the headless values require capture like every other cell in §3 — the implementing slice pins them with evidence, and an uncaptured cell stays `false`. Owner: **#131**, paired with the slice that lands `capabilitiesFor({transport})`.

Nothing else in this record changes. Questions 5 and 7 create work; 1–4 and 6 are confirmations of what is written above.
