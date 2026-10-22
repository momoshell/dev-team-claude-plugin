# ADR-029: Headless observability and interjection — the pane-parity matrix for piped seats

**Status:** RATIFIED 2026-08-13 (all seven §8 questions answered; see §9) · **Source:** issue #85 (epic #80) · **Evidence:** `tasks/headless-worker/spike-findings.md` (HW-1, claude), `tasks/headless-worker/pi-spike-findings.md` (HW-1b, pi)

---

## 0. Status, scope, and the numbering choice

This record was ratified by the user on 2026-08-13; §9 carries the seven answers and what each one commissions. It continues the ADR sequence as ADR-029, puts the full record in `docs/`, and adds a one-line proposed-number pointer to the existing register at the legacy path `.claude/dev-team/memory/architecture-notes.md`. That tree is described as retired but is git-tracked and remains the active register: it contains ADR-024 through ADR-028, and shipped code still cites ADR numbers. The orchestrator is filing register cleanup separately; this ADR records the finding and does not fix the path.

The scope is headless, piped crew seats: observability, interjection, attention signals, and the constraints on escalation recovery. #80's daemon architecture and its invariant **`idle ≠ success`** are ratified input: liveness is a give-up signal, while the envelope and authoritative task records determine outcome. Nothing in this ADR makes screen state or process state authoritative. This ADR amends issue #85's own body on escalation recovery. It fixes constraints, not the transition mechanism: #125 owns the park/lease transition protocol, alongside #83, and its prior protocol analysis is preserved there.

## 1. Context — what the pipe takes away

A pane gives a human a place to watch and a place to type. A pipe gives neither. The shipped cmux surface today is the `crew-stage` pill, the plan viewer, warm-workspace-on-escalation, and `crew.mjs status`; the legacy runtime that carried the rest was deleted at `81dee7c`. It was retired, not imaginary. The old observe-mode affordance really shipped at `d3d7dee` before that retirement.

Observability is nevertheless optional by construction. The driver talks to the world through injected `io`; `emit`, `status`, `showDoc`, and `runClean` are optional members per the io contract comment before `driveTask` in `crew/drive.mjs`, with the `emit`, `stage`, plan-viewer and `runClean` sites inside `runTask` in `crew/drive.mjs` and covered by `fakeIo` in `crew/drive-fixtures.mjs`. A headless invocation can omit those sinks without making execution depend on a screen. The durable task directory, journal, envelopes, agent transcripts, and the selected ledger mirror therefore matter more than a pane's pixels.

The two spike documents establish different headless transports, not interactive-pane behavior. HW-1 captured `claude -p` (`headless-json`); HW-1b captured one-shot pi JSON children and pi `--mode rpc` (`headless-rpc`). Neither spike exercised an interactive pane. The matrix below consequently treats pane values conservatively rather than inheriting values from headless captures.

## 2. Decision 1 — observability: the pane-parity matrix

A human watches the run's existing durable record—journal, task-directory artifacts, envelopes, and the ledger's coarse lifecycle mirror—surfaced by the visualizer, plus a live daemon projection for latency. The screen is never the record. The visualizer may render richer views, but it must link back to authoritative files and must not turn screen text into an outcome.

| Affordance | cmux mode today (evidence) | Verdict | Headless replacement | Owner slice |
|---|---|---|---|---|
| Markdown plan viewer (the `showDoc` member of `seatIo` in `crew/seat-io.mjs`; the plan-viewer mount inside `runTask` in `crew/drive.mjs`) | Auto-mounted document surface; the plan is already a file | degraded | Keep `plan.md` as the file; the visualizer renders the task directory and `factoryctl attach` streams the run. Headless `io` may omit `showDoc?.()` | #83, #49 |
| `crew-stage` pill (the `status` member of `seatIo` in `crew/seat-io.mjs`; feed from the `stage` function inside `runTask` in `crew/drive.mjs`) | Best-effort `cmux set-status crew-stage <label>` | carried | Existing stage-label vocabulary flows through `io.emit({kind:'stage'})` into an `emitAdapter` phase transition plus `log` row. There are **16** forms, including `gate-baseline:green-bounce` | #83, #48, #49 |
| Attention moment - tier confirm (the D11 bullet of `cmux-design-record.md`) | Hand-typed orchestrator prose, never code | dropped (pre-headless) | Nothing replaces it; the tier is chosen at boot | - |
| Attention moment - plan approval | Hand-typed orchestrator prose, never code | dropped (pre-headless) | Nothing replaces this human prompt; the driver accepts or bounces the plan through the tech-lead plan check (the `check:r` stage) inside `runTask` in `crew/drive.mjs`. A future interactive mode is an open question | - |
| Attention moment — gate verdict (human-facing) | No per-gate verdict reaches a human today; enum names are not a crew write path | carried with a caveat | #130 mirrors gate verdicts to `gate_results`; attention fires only on gate exhaustion or triage escalation, not on ordinary red-then-green | #130 |
| Attention moment - insufficiency / escalation (`escalate`, inside `runTask` in `crew/drive.mjs`) | The one attention moment with a real driver transition | carried (degraded) | Emit the section 4 `attention` run event. It survives a subscriber gap through server-side unresolved-attention derivation; live delivery is sink-dependent, while the record is not | #83, #46 |
| Interjection observe-mode (`scripts/cmux/gate-mode.sh` and the observe-mode branch of `scripts/cmux/return-gate.sh`, both at `d3d7dee`) | Shipped observe mode changed the gate on human interjection; it was retired at `81dee7c` | dropped (retired at `81dee7c`) | Replace its intent with section 3's capability-gated interjection, honest per agent and per transport. Typing into a live pane breaks the echo-baseline contract of `sendLine` in `crew/driver.mjs` | #83 |
| Warm panes on escalation (the outcome-gated teardown in `runCmd` in `crew/crew.mjs`; the **Lifecycle** bullet of the Contracts section of `crew/README.md`) | Escalation leaves panes warm; done tears them down/archive | dropped | No panes are kept. Preserve the invariant as section 5: never discard the task directory, journal, envelopes, or resumable seat context a successor needs | #125 |
| Live pane scrollback / `read-screen` triage | Human glanceability from terminal pixels | degraded | Use the agent event stream, richer and machine-correlatable but not glanceable without a UI (section H6.1 of `spike-findings.md`, section A1 of `pi-spike-findings.md`), and link to raw artifacts. It is lossy across a client disconnect | #49 |
| Tri-state seat liveness + `crew status` (`waitForEnvelope` in `crew/seat-io.mjs` and `paneAlive` in `crew/seat-io.mjs`, and `statusCmd` in `crew/crew.mjs`) | Today's probe is `true` (alive), `false` (dead), or `null` (indeterminate); only `false` counts toward death and an envelope beats a dead pane (the envelope re-read before the seat-died throw inside `waitForEnvelope` in `crew/seat-io.mjs`) | carried | The daemon's `state(worker)` query returns #80's closed `working\|blocked\|done\|dead` enum and `factoryctl ls` surfaces it. A failed/unreachable query is client-side **unknown**, never `dead` | #83, #46 |
| Attention notification channel (`cmux notify`, allow-listed but never invoked by crew) | A possible cmux sink, not a crew record | dropped | An attached cmux-side client invokes `cmux notify` from §4; the sink is never the record | #83, #46 |
| Workspace as a place to stand (human `cd` into a warm checkout) | A human can re-enter a warm checkout/task workspace | carried | Checkout and task directory are transport-independent. Re-entering a parked run on the floor is the #125 lease transition | #125 |

The `crew-stage` labels are selected lifecycle facts: stage to phase transition plus `log`, assign to `agent_start`, envelope to `agent_end`, and decision/dissent to `decision` in `emitAdapter` in `crew/seat-io.mjs`. The ledger vocabulary is deliberately narrow; it has no blocked, terminal-result, died, or usage event, and `tool_call` is only `{tool, ok}` per `EVENT_TYPES` in `scripts/factory/ledger.mjs` and `PAYLOAD_KEYS` in `scripts/factory/ledger.mjs`.

**Rejected:** binding a cmux `agent-session` surface to a daemon-created session. That re-couples observation to a terminal manager, presumes a provider surface can attach to an externally-created session (never spiked), and cannot be authoritative because cmux has no per-surface process-exit event (section S2 of `tasks/cmux-mode/spike-findings.md`). Stderr tailing is also rejected: it is neither a durable record nor a safe interjection/attention protocol.

## 3. Decision 2 — interjection: per-agent, per-transport capability profiles

Interjection is asymmetric per agent. Claude cannot promise stdin mid-turn: text stdin is read to EOF before the turn starts (section H5.2 of `spike-findings.md`), while pi's `steer` is live-verified boundary delivery: it queues while a tool runs, leaves that tool undisturbed, and arrives before the next LLM call (section B6 of `pi-spike-findings.md`). It is also asymmetric per transport. The flat `capabilities` export of `crew/adapters/adapter-pi.mjs` at `42df8d2d` is history, commit `d57c4059` replaced it with `capabilitiesFor`, but its `seatCommand` in `crew/adapters/adapter-pi.mjs` launches interactive pi, not `--mode rpc`; the `--print`/`--no-session` comment inside `seatCommand` in `crew/adapters/adapter-pi.mjs` deliberately omits those flags to preserve pane persistence. A top-level `interjection: boundary` would describe a transport the adapter does not run. Capability is a property of the `(adapter, transport)` pair, not of the adapter.

The first table is the normative profile matrix. Every cell must be pinned exactly by test (§7); today none of these per-transport cells exists or is test-pinned. [deprecated 2026-08-21 — superseded by §10: the cells exist and are pinned] The evidence is headless evidence and is not silently transferred to a pane.

| Flag | Values | claude · pane | claude · headless-json | pi · pane | pi · headless-rpc | Evidence to cite |
|---|---|---|---|---|---|---|
| `interjection` | `none` \| `turn` \| `boundary` | `none` | `turn` | `none` | `boundary` | section H5.2, section H5.3, section H5.4 and section H2.1 of `spike-findings.md` vs section B6 of `pi-spike-findings.md` |
| `abort` | `none` \| `signal` \| `command` | `none` | `signal` | `none` | `command` | section H3.3 and section H3.4 of `spike-findings.md` vs section B7 of `pi-spike-findings.md` |
| `session_resume` | `true` \| `false` | `false` | `true` | `false` | `true` | section H2.1 of `spike-findings.md` vs sections A3 and B10 of `pi-spike-findings.md` |
| `durable_cursor` | `none` \| `entry_id` | `none` | `none` | `none` | `entry_id` | section H2.3 of `spike-findings.md` vs section B9 of `pi-spike-findings.md` |

The resolution API replaces the flat `capabilities` export:

```js
// returns one frozen, resolved profile
export function capabilitiesFor({ transport })
```

`transport` is a closed set: `'pane' | 'headless-json' | 'headless-rpc'`. The frozen result carries every key: transport-invariant `prompt_file`, `tool_deny`, `unattended`, and `effort`, plus transport-scoped `interjection`, `abort`, `session_resume`, and `durable_cursor`. Consumers read exactly one object and never merge profiles. An adapter that does not implement a requested transport throws while naming the adapter and transport; it never guesses a passthrough or silently defaults, following the refusal of an unknown provider in `modelString` in `crew/adapters/adapter-pi.mjs`.

Today the flat call of `assertCapabilities` in `crew/crew.mjs` in `resolveAdapters` in `crew/crew.mjs` passes a flat adapter-wide object with no transport input. That is current behavior, not the design. [deprecated 2026-08-21 - superseded by section 10: the resolver replaced the flat call] #83 must replace that call: resolve the seat's transport, then pass the resolved profile to `assertCapabilities` in `crew/crew.mjs`. #45 filters factory eligibility on the same resolved profile. A request for an unsupported adapter/transport fails at boot, just as `tool_deny` does today. Shipped profiles, and only shipped profiles, are claude to `pane`, `headless-json`; pi to `pane`, `headless-rpc`. Pi deliberately has no `headless-json` profile: one-shot `--mode json` is not a ratified crew transport (the Transport recommendation section of `pi-spike-findings.md`). #83 replaces the current pi-only deep equality (the test "the pi adapter declares honest, frozen capabilities") and claude frozenness-plus-`tool_deny` assertion (the test "every seat declares an agent; the claude adapter declares full, frozen capabilities") with exact assertions for every shipped profile.

The pane columns are conservative. Every capture in both spikes was headless; neither exercised an interactive pane. The pane transport owns neither a session nor a process handle. Crew retains a cmux `pane_id`/`surface_id` (`bootCmd` in `crew/crew.mjs`), never a PID; termination is `close-surface`, and cmux has no per-surface process-exit event (section S2 of `tasks/cmux-mode/spike-findings.md`). Thus `abort: none`: `signal` requires supervisor termination plus independent EOF/process evidence. `session_resume: false`: neither pane command supplies `--session-id` (the flat `capabilities` export at `42df8d2d`; the claude byte-identity pin is the test "adapter-claude.seatCommand is byte-identical to the pre-refactor paneCommand output"), and sending another assignment to a live TUI is not persisted-session resume. `interjection: none`: `sendLine()` throws rather than typing into a dirty echo baseline (`sendLine` in `crew/driver.mjs`), and no pane capture establishes mid-assignment behavior. A pane profile may declare `abort: signal` or `session_resume: true` only once that transport owns an explicit handle and the behavior is captured. Amendment note (2026-08-20, #149): the first half of this paragraph is falsified. `cmux top --processes --json --all` attributes pids to a surface and to their descendants - verified live 2026-08-20, `surface:27` returning pid 7433 plus the chain 32052 to 32061 to 32080 under one `cmux_surface_id` - so a pane seat's process tree IS resolvable from the `surface_id` the crew already retains, and both the sentence above and the section 6 row at line 123 are superseded on the no-handle point (that row is left as written, per the record's structure). `crew/driver.mjs`'s `surfaceProcessTree()` is that handle: read-only, performing exactly the three calls `cmux tree` to `cmux top` to `cmux tree`, because `top` prints per-invocation refs and the retained UUID is translated through `tree --id-format both`, whose mapping must be identical in both bracketing reads or the result is unknown. What it reports is a point-in-time attribution snapshot naming the surface's foreground process-group leader, with the attributed forest beside it. `abort: none` nevertheless stands for every pane profile, because this ADR conditions `abort: signal` on a handle AND captured behaviour: captured termination behaviour remains unproven, and capturing it means signalling a live seat - destructive, and a separate ratification. The unproven remainder is target selection and snapshot freshness (including PID reuse), signal delivery, EOF/process evidence, and settle behaviour under termination. Placement was chosen to keep this record true: `surfaceProcessTree()` is appended at end of file, so `sendLine` in `crew/driver.mjs` was verified unchanged by this change and the three citations of it in this ADR (lines 33, 68 and 124) were checked rather than left unexamined.

Normative meanings are closed:

- `interjection: none` means no supported message into a running assignment. `turn` means a subsequent invocation against the session after the current turn settles. `boundary` means queued mid-turn, delivered between tool calls before the next LLM call, without disturbing the in-flight tool. There is no reserved `steer` rung.
- `abort: none` means no supported interruption. `signal` means supervisor termination with independent EOF/process evidence and **no graceful-settle promise**: a terminal event may be present or absent, and EOF without terminal is incomplete (sections H3.3, H3.4 and H1.2 of `spike-findings.md`). `command` means an in-protocol abort followed by waiting for the agent's own verified settled condition; pi's condition is `agent_settled`, not `agent_end` (sections B7 and B8 of `pi-spike-findings.md`).
- `session_resume: true` means a later invocation/process continues the same persisted context (section H2.1 of `spike-findings.md`; section A3 of `pi-spike-findings.md`). It does not claim claude's forced-abort-then-resume composition, which is unverified (the Deferrals and open questions section of `spike-findings.md`); pi's post-SIGKILL recovery is captured (section B10 of `pi-spike-findings.md`).
- `durable_cursor: none` means no client-resumable observation cursor; a durable session file is not a cursor. `entry_id` means the agent's session-entry id survives client restart and rejects unknown ids explicitly (section B9 of `pi-spike-findings.md`). There is no speculative `seq` rung.

Claude's `turn` is therefore narrow: forced abort plus same-session resume was not verified as a combined operation (sections H3.3 and H3.4 and the Deferrals and open questions section of `spike-findings.md`). This amends the issue vocabulary by splitting `none` from `turn`, dropping `steer` as a declared rung, and using no duplicate `resume` flag. The driver must **never offer** an affordance a seat's **resolved profile** cannot honor. It refuses an above-level request with the reason and names the next-best offer. The ratified transport premise is a long-lived `--mode rpc` process, one process per worker session (the Transport recommendation section of `pi-spike-findings.md`). An interjection is guidance, not an outcome.

**Rejected:** the flat adapter-wide object, which would ship false `boundary` on an interactive pane; bounce-only/no mid-run interjection; one uniform interjection contract; and claude `--input-format stream-json` as a promised channel today. Claude accepted one stream-json user record but did not establish a multi-message or mid-turn protocol (sections H5.3 and H5.4 of `spike-findings.md`).

## 4. Decision 3 — attention signals

The durable record is the one that already exists; the daemon's normalized stream is a live projection, not a second record, and unresolved attention is derived server-side, never stream-only.

**Authoritative files.** The journal (the `stage` function inside `runTask` in `crew/drive.mjs`), task directory, `returns/task.json` (`runCmd` in `crew/crew.mjs`, commit `2fac235d` scoped it to `returns/<run_id>/task.json`), and each agent's session transcript remain authoritative. This ADR adds no new durable feed. ADR-024's one-mirror rule applies: the ledger holds selected lifecycle facts, not bytes. `emitAdapter` in `crew/seat-io.mjs` mirrors stage/phase plus log, agent start, envelope end, and decision/dissent in `runCmd` in `crew/crew.mjs`; its closed vocabulary has no blocked, terminal-result, died, or usage event and its `tool_call` payload is only `{tool, ok}` per `EVENT_TYPES` in `scripts/factory/ledger.mjs` and `PAYLOAD_KEYS` in `scripts/factory/ledger.mjs`. Files remain authoritative; the ledger is not a byte-for-byte replay store.

On reconnect, a client gets coarse lifecycle from the ledger mirror plus journal and links to raw artifacts. It does not receive replay of the disconnected live normalized worker stream. The projection is intentionally lossy across a disconnect. With cmux absent, the ledger and journal remain the record. The cmux hook feed is an optional pane-mode input bridge; the turn-end event is `agent.hook.Stop`, not `notification.requested` (section S6 of `tasks/cmux-mode/spike-findings.md`). The try/caught `emit` wrapper inside `runTask` in `crew/drive.mjs` keeps `io.emit?.()` optional, and ADR-026 makes instrumentation non-load-bearing.

The one canonical schema for both live and synthetic delivery is:

```text
attention{ moment, park_id, task, why, artifacts[] }
```

`moment` is a closed enum with two members: `escalation | gate`. Amendment note (2026-08-14, #130): answer 3 forbids pre-declaring members nothing emits; #130 now emits `gate`, so this extension is recorded here as a change. Amendment note (2026-08-14, #165): the prior deviation is retired for escalation attention - `crew.mjs`'s run lifecycle mints a park on an escalation outcome and the escalation attention event carries its real id, so #83/#46 may emit live attention with a real id. Gate-moment attention keeps `park_id: null`: it may fire before a run's terminal outcome, and minting there would strew parks across runs that never park. A mint failure is loud but non-fatal: escalation remains the outcome, and the warm workspace remains the recovery context. `park_id` remains present on every attention event either way, live or synthetic. #83's daemon derives an unresolved snapshot from park and envelope authority and emits it before each subscription's live tail. Resolved and abandoned parks are omitted. Thus an escalation raised while nobody was attached reaches the first client that attaches, preserving the no-subscriber delivery property measured by cmux (section S6 of `tasks/cmux-mode/spike-findings.md`) without promising exact live-stream replay.

Dedupe is per client, never global. Presentation and `cmux notify` deduplicate by stable `park_id`, with that client's acknowledgement persisted. A global already-notified bit would allow the first bot client to suppress the escalation for every later human client. `cmux notify` is invoked by an attached cmux-side client, never by the daemon: socket reach under `cmuxOnly` was verified only for a process inheriting cmux identity/env from a cmux-launched ancestor (sections S3 and S4 of `tasks/cmux-mode/spike-findings.md`). Sink failure is sink-local; because unresolved attention is derived per subscription, a missed notification delays sighting but does not lose the escalation.

The #83 mirroring delta is to record escalation as a `decision` row and close the run with the correct `SESSION_STATUSES` value. A new ledger event type is not recommended for a fact already representable in the selected vocabulary. The attention run event is not completion evidence, and an interjection is not an outcome.

**Rejected:** a second durable run feed with its own sequence/replay protocol; `cmux events` as the attention record (ids are boot-scoped and the log rotates at 16 MiB); `cmux notify` as the primary channel; a global already-notified flag; and stderr tailing. `cmux notify` is a sink, not the attention record.

## 5. Decision 4 — escalation recovery: the constraints

`driveTask` holds every piece of control state in local variables (the locals of `runTask` in `crew/drive.mjs`); `escalate` returns out of the call (`escalate`, inside `runTask` in `crew/drive.mjs`), and `runCmd` in `crew/crew.mjs` ends the emitter, writes `returns/task.json`, and returns. Escalation is therefore terminal for this driver invocation. This ADR amends issue #85 accordingly.

1. **Escalation is terminal for its driver invocation.** There is no suspended continuation and nothing to reacquire. A stage label cannot reconstruct round counters, consult budget, bounce briefs, or gate-repair state.
2. **Recovery is a new linked run**: a new run id, `resumes_park_id`, and the human's guidance as input. It may reuse parked seat sessions only when the resolved profile's `session_resume` permits it. A seat that cannot resume is cold-booted with journal, envelopes, and plan as context; parked state records which seats return warm and which cold. Its exact shape belongs to #125. Since pane profiles currently declare `session_resume: false`, pane recovery is cold-boot today.
3. **Sessions are exclusive and released before reuse.** Observed claude headless callers and pi one-shot JSON callers were not serialized (section H2.2 of `spike-findings.md`; section A3 of `pi-spike-findings.md`), with the claude finding scoped to this version and tested timing; pi same-session RPC concurrency is unknown (the Deferrals and open questions section of `pi-spike-findings.md`). No transport may rely on provider serialization. #125 must enforce exclusivity and release a session before another run resumes it.
4. **Transitions require a real lock with fencing.** An atomic rename is not a compare-and-swap. Rename is atomic as a write but does not verify the content inspected: two contenders can read epoch N, both replace with N+1, and both cross the safety boundary.

The transition mechanism—the park claim and state machine, park- and seat-level lock scopes, deterministic lease ordering, all-or-nothing acquisition with rollback, lock primitive, and its own recovery path—is deferred to **#125**, owned alongside #83 because the daemon must honor it. This is a distributed transaction with at least three crash windows: a claimed-but-not-enqueued phantom successor, a recovery lock that can wedge, and partial seat acquisition. Those are already #125 acceptance criteria; the analysis is preserved there, not discarded. A decision record that names an open mechanism is honest; one specifying an unimplementable protocol is not.

**Rejected:** true driver checkpoint/resume (persisting all `driveTask` locals and a program counter would turn `drive.mjs` into a checkpointed state machine and is outside #83, whose scope leaves it unchanged); transcripts-only handoff (transcript archaeology and abandonment of warm context); and keeping workers alive while parked. The last is declined as a resource/ownership policy, not because cost or impossibility was measured: an idle RPC holder could in principle remain the sole session holder, but a parked run has no useful work and would keep ownership live while a human, not the daemon, is the blocker.

## 6. Evidence gaps this ADR decides around

| Gap | Evidence | How this ADR decides around it |
|---|---|---|
| Pi exit status is unverified for the one-shot `--mode json` arms | sections A2, A3 and A4 of `pi-spike-findings.md`; the RPC arm records `first_exit code=null signal=SIGKILL`, `second_exit code=0` (section B10 of `pi-spike-findings.md`) | The RPC arm is not in this gap. A pi terminal is `agent_settled` plus the envelope. The one-shot JSON profile is not shipped |
| Claude forced-abort-then-resume is unverified as a combined operation | sections H3.3 and H3.4 and the Deferrals and open questions section of `spike-findings.md` | `interjection: turn` promises next-turn guidance only |
| Claude mid-turn stream-json injection is unverified | section H5.4 of `spike-findings.md` | It is out of every profile |
| Pane abort and resume are unmeasured and the transport owns no handle | No spike exercised a pane; no `--session-id` (the flat `capabilities` export at `42df8d2d`; the claude byte-identity pin is the test "adapter-claude.seatCommand is byte-identical to the pre-refactor paneCommand output"); crew retains a surface id, not a PID (`bootCmd` in `crew/crew.mjs`); cmux lacks per-surface process-exit (section S2 of `tasks/cmux-mode/spike-findings.md`) | Both pane profiles declare `abort: none`, `session_resume: false`. A pane may declare `signal`/`true` only after owning an explicit handle and capturing the behavior |
| Pane interjection is unmeasured | No capture establishes what mid-assignment `send` does; `sendLine` in `crew/driver.mjs` throws into a dirty box | Both pane profiles declare `interjection: none` |
| Pi retry behavior is unobserved | section B8 of `pi-spike-findings.md` | Wait for `agent_settled`; `willRetry` remains unmodelled |
| Session retention/GC is untested for both agents | section H2.4 of `spike-findings.md`, the Deferrals and open questions section of `pi-spike-findings.md` | Cold-boot fallback in constraint 2 is required |
| Concurrent RPC clients on one session were never tested | the Deferrals and open questions section of `pi-spike-findings.md` | Constraint 3 is our requirement, not a provider guarantee; it is why #125 exists |
| cmux cursor durability across restart is untested and ids are boot-scoped | the section 4.3 rank-1 row of the Superseded since ratification table in `docs/trd-cmux-execution-mode.md`, sections S2 and S6 of `tasks/cmux-mode/spike-findings.md` | cmux is a sink, never the record |
| Daemon socket reach under `cmuxOnly` is unproven for non-cmux-descended processes | sections S3 and S4 of `tasks/cmux-mode/spike-findings.md` | The notifier is an attached client |

## 7. Consequences and owner slices

This ADR changes no code.

| Consequence | Owner |
|---|---|
| Headless `io` and daemon: `attention` run event carrying `park_id`; server-side unresolved snapshot before each subscription's live tail; `decision`-row mirroring; `capabilitiesFor({transport})` in both adapters replacing the flat `assertCapabilities` call inside `resolveAdapters` in `crew/crew.mjs`; exact per-profile assertions in `crew/crew.test.mjs` replacing pi-only deep-equal and claude's partial check; stage emission; `state(worker)` | #83 |
| Park/lease transition mechanism behind §5, minting `park_id` before #83 emits live attention, and floor re-entry into a parked run | #125 |
| `attach` consumes attention; `send` carries the human answer; per-client `park_id` dedupe and persisted acknowledgement; existing `ls`/`attach`, with no new verbs | #46 |
| Board, swimlanes, event inspector, and plan render consume the same attention snapshot; cmux-notify bridge is an attached client and dedupes per client | #48/#49 |
| Factory eligibility filters on the resolved capability profile | #45 |
| Driver checkpoint/resume (§8 q6) stays unowned; per-gate result emission/mirroring (§8 q5) is owned and landed by #130 | #130 / Unowned |

The exact capability assertions are a consequence, not a suggestion: #83 must name every shipped `(adapter, transport, flag)` cell in `crew/crew.test.mjs`, for both adapters, and assert the frozen resolved object exactly. Today only pi's complete flat object is deep-equalled (the test "the pi adapter declares honest, frozen capabilities"), while claude checks frozenness and `tool_deny` (the test "every seat declares an agent; the claude adapter declares full, frozen capabilities"). [deprecated 2026-08-21 - superseded by section 10: every shipped profile is deep-equalled]

**`idle ≠ success`** (the Readiness section of `crew/README.md`). Nothing here makes screen or process state authoritative for outcome; envelopes and files remain authoritative.

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

## 10. Amendment record — 2026-08-21: the per-transport capability cell shipped

**Implemented by:** #131 · **Amends:** nothing this ADR decided. Decision 2 (§3)
and §7 are recorded as ratified; this note records that what §3 called absent is
now the shipped runtime, so a reader does not build it twice (#457).

`capabilitiesFor({ transport })` is exported by both adapters
(`capabilitiesFor` in `crew/adapters/adapter-claude.mjs` and
`crew/adapters/adapter-pi.mjs`), and `crew/crew.mjs` resolves the seat's
transport and passes the resolved profile — the flat adapter-wide `capabilities`
export §3 rejected no longer exists on either adapter. Every shipped cell is
pinned exactly: `crew/crew-adapters.test.mjs`'s test *"every shipped capability profile is
exact, complete, and frozen"* deep-equals all four profiles (claude → `pane`,
`headless-json`; pi → `pane`, `headless-rpc`), asserts each is frozen, and
asserts the flat export is `undefined` on both adapters; its neighbour
*"unshipped capability pairs and absent transports throw naming adapter and
transport"* pins the refusals. `reassign` was minted and captured as §9's item 7
required.

Citations here name files and symbols rather than lines: this lane measured
42–87% rot across four line-numbered citation populations, and zero rot in the
two documents that cite without line numbers (#457).

## 11. Citation note

Except where a citation names another commit, every citation in §§0–9 was read at `42df8d2d`, where this ADR was drafted. Each code citation names the top-level definition that holds the cited code at `7b3c6f90`, each spike-document citation names the section that held the cited lines, and a test named by its title is named as it stood at `42df8d2d`.
