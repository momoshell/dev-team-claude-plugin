# crew — a team runtime for cmux

One task, one workspace, one whole team booted in a single declarative call —
driven by deterministic code, with agents kept for judgment.

```
node crew/crew.mjs boot --task my-task --roles lead,planner,builder,reviewer
node crew/crew.mjs boot --task my-task --tier <mechanical|build|judge>
node crew/crew.mjs run  --task my-task --brief-file /abs/path/brief.md
# ... code drives the loop; watch the workspace, read the pill ...
node crew/crew.mjs status --task my-task          # liveness (true|false|null per seat)
node crew/crew.mjs teardown --task my-task        # manual close (run auto-tears-down on done)
```

`--tier` seats the crew from `crew/roster.json` — the crew RUNTIME's own
roster, not the target checkout's — instead of `--roles`; the two flags are
mutually exclusive (the tier defines the seating). Per-seat `--model-<role>`
/ `--agent-<role>` / `--effort-<role>` flags still override individual cells.

`--headless-all` boots an all-headless crew with no cmux workspace at all. Each
seat's adapter is asked through its own `capabilitiesFor`: claude resolves to
`headless-json`, while pi resolves to `headless-rpc`. The resulting
`crew.json` records `workspace_id: null` and `window_id: null`, and every seat
carries its resolved non-pane transport — the shape `crew/daemon.mjs` accepts
for a headless run. Explicit per-seat `--headless` / `--headless-rpc` flags
still win over the one-flag form.

| tier | lead | planner | builder | reviewer | tech-lead |
|---|---|---|---|---|---|
| `mechanical` | — | claude/opus-5, medium | pi/luna, max | pi/terra, medium | — |
| `build` | claude/opus-5, medium | claude/opus-5, medium | pi/luna, max | pi/terra, max | — |
| `judge` | claude/opus-5, high | claude/opus-5, high | pi/luna, max | claude/opus-5, high | pi/sol, xhigh |

Cells are `<agent>/<model>, <effort>`; `roster.json` is the source of truth
and this table is a convenience copy of it. Two ratified invariants the tiers
encode: the **planning floor** — the planner seat is opus-grade at *every*
tier, because the plan is the artifact every downstream stage inherits, so it
is never the place to save — and the **review-vendor rule** — luna builds at
every tier, and `judge` keeps opus on review so cross-vendor checking holds
where the stakes are highest, while `build`/`mechanical` accept the
same-vendor luna→terra pair with the opus lead as the backstop. A third:
**luna builds at `max` thinking at every tier** — the builder is the only seat
that writes source, its output is what every later stage grades, and the
ChatGPT-subscription routing makes the upgrade a latency cost rather than a
billed one. `mechanical` stays cheap through its lead-less seating and its
`medium` reviewer, not by thinking less about the code it writes.

The same subscription argument now carries `build`'s **reviewer at `max`**: the
reviewer is the last gate before commit, and on the same routing the upgrade
costs wall-clock rather than money. This one is an explicitly **recorded
experiment**, not a settled invariant — measured over 19 archived runs,
`pi/terra` at `high` already sent work back in 68% of them (against 66% for an
opus reviewer), so bounce rate cannot say whether more effort helps. The
keep-or-revert evidence is the durable review outcome — normalized verdict and
`must_fix` count — that #169 adds to the ledger. `judge` deliberately stays on
opus review: the review-vendor rule is about correlated blind spots, and effort
does not fix vendor correlation.

A `--model-<role>` flag on a `--tier` boot is a **raw passthrough that is
never namespace-translated**: `--model-builder gpt-5.6-luna` on a pi seat
stays a bare-id lookup, not `openai-codex/gpt-5.6-luna`, because an operator
typing a model id is speaking their own CLI's namespace. Where it is
recorded: `sources.<role>.model === 'override'` in the boot journal's
`allocation` map (including any declared capability shortfalls). A seat booted
with a raw `--model-<role>` records `provider: null` and `id: null`, because the
roster cell no longer describes it and a raw model string carries no derivable
provider — the boot record never guesses one.

## The model

**Code disposes, agents decide.** `drive.mjs` owns the mechanical loop:

```
plan -> (tech-lead check when seated) -> gate-baseline(RED required)
     -> build -> scope-gate(git) -> validation lane -> acceptance gate
     -> review -> full suite -> commit-on-green(plan subject + builder body)
```

Every loop is bounded (`LIMITS`), every verdict is a closed enum, every bounce
brief is code-composed with failures pasted verbatim, every stage transition
lands in `journal.jsonl` and on the workspace's live `crew-stage` pill.

**The seats** (per-pane Claude sessions, launched as the pane process by the
boot layout — nothing is ever typed into a spawning shell):

| Seat | Charter | Repo writes |
|---|---|---|
| `lead` | the judge: consulted by code only at genuine judgment points, answers with a closed-enum decision envelope | none |
| `planner` | domain lead + architect + scout-commander; envelope carries `files_in_scope`, `validation_lane`, optional `gate_cmd` | none (task dir only) |
| `builder` | the only repo-writing seat; tests are part of building | in-scope files only (git-gated); the only seat allowed `Edit` (tool-denied elsewhere) |
| `reviewer` | conformance to plan, then correctness; also gate-defect triage and perspective duty | none |
| `tech-lead` | optional plan adversary — deliberately a different model/effort | none |

Per-seat models are boot flags (`--model-planner opus --model-builder haiku ...`)
so the crew is sized per task: cheap seats for mechanical work, capable seats
where judgment lives.

## The judgment protocol

- Code consults the **lead** with a decision brief carrying a closed option
  set (`bounce`/`accept`/`escalate` subset). Out-of-set answers escalate;
  a consult limit caps a looping judge.
- **Compounding**: on a first round the lead may answer `second-opinion`
  naming another seat; code gathers that seat's view unseeded (the lead's
  leaning structurally never exists to leak), re-asks once, and records any
  divergence as `dissents` on the task envelope. One binding rule: lead
  `accept` over an advisor's independent `escalate` recommendation escalates
  — compounding may only strengthen outcomes toward safety.
- Escalation ladder: **code → lead → orchestrator/human**, each hop only
  when an enum says so. A lead-less crew (`mechanical` tier) has nobody at
  the middle rung: every consult that would have asked the lead escalates
  straight to the orchestrator instead.

## Adapters (hot seats)

A seat is a *hot seat*: any CLI agent can hold it, not just claude. The whole
contract is one file, `crew/adapters/adapter-<name>.mjs`, exporting:

- `capabilitiesFor({ transport })` — returns one frozen resolved profile with
  the five invariant keys, including `subagents`, plus transport-scoped
  capabilities. The closed
  transports are `pane`, `headless-json`, and `headless-rpc`; shipped pairs are
  claude × (`pane`, `headless-json`) and pi × (`pane`, `headless-rpc`). Pi has
  no `headless-json`; every unshipped pair throws rather than guessing.
- `seatCommand({ role, model, promptFile, tools, deny, taskDir, bootBrief,
  effort }) → string` — the pane's command line. crew composes the merged
  prompt file and hands it in; the adapter owns the invocation shape.
- `modelString({ provider, id }) → string` — translates a roster cell's
  `{provider, id}` into the agent's own model-string namespace. claude's ids
  need no prefix (the id IS the CLI's namespace); pi namespaces as
  `<pi-provider>/<id>`, with `openai → openai-codex` (that provider routes
  through the ChatGPT subscription OAuth) and an unmapped provider a loud
  throw rather than a guessed passthrough.

`--agent-<role> <name>` at boot picks the adapter, mirroring
`--model-<role>`; default is `claude`. An unknown name fails the boot loudly,
naming the missing adapter file — never a silent fallback.

Shipped adapters: `claude` (default) and `pi` — `--agent-reviewer pi
--model-reviewer google/gemini-3-pro` seats a reviewer on pi. pi's deny list
(`--exclude-tools`) matches pi-namespaced tool names, so a claude-shaped seat
deny list is translated before it reaches pi:

| seat | claude deny | pi `--exclude-tools` |
|---|---|---|
| lead / tech-lead | `Edit,NotebookEdit,Task,Agent` | `"edit"` |
| planner / reviewer | `Edit,NotebookEdit` | `"edit"` |
| builder | `Task,Agent` | *(flag omitted — empty translation)* |

A pi builder ends up with no `--exclude-tools` at all, because pi has no
subagent tool for `Task`/`Agent` to translate to — that seat's real boundary
is the git scope gate + commit-in-scope, the same posture `Write` already has
everywhere.

Capability declarations are enforced, not decorative: charters declare
`requires` when they depend on a capability. **The planner alone requires
`subagents`** — its charter is "domain lead + architect + scout-commander", and
fan-out discovery IS the third of those, so `--agent-planner pi` refuses before
a workspace exists rather than booting a planner that silently discovers
serially. The reviewer does **not** require it: its charter names no fan-out,
and the roster deliberately seats pi/terra on review at `build`/`mechanical`
under the review-vendor rule above — the same missing capability is correctly
fatal for one charter and irrelevant for another, which is why the requirement
lives on the charter and not on the adapter. A deliberate shortfall override
(`--allow-shortfall-<role> <cap>`) boots a refusing seat degraded and records
the waived capability in the boot journal's `allocation` map as `shortfall`.
Tool denial remains enforced for every seat, while
`prompt_file`, `unattended`, and `session_resume` are declared for the adapters
still to come.

## io contract

The driver consumes one synchronous io object: `assign({role, briefFile,
note}) -> {id, returnPath}`, `wait(returnPath, timeoutS) -> envelope|null`,
`writeFile`, `readFile`, `run`, optional `runClean`, `changedFiles`, `commit`,
optional `status`/`showDoc`, `log`, `now`, and optional `emit`. `assign` and
`wait` are per-seat; the remaining methods are checkout-global and shared by
all seats. The shipped transports are `pane` (cmux terminal),
`headless-json` (one-shot `claude -p --output-format stream-json` per
assignment), and `headless-rpc` (a long-lived `pi --mode rpc` process held open
across assignments). Pass `--headless builder,reviewer` or `--headless-rpc
builder` at boot to select it per role; mixed crews are supported. The RPC
capability surface is `steer`, `abort`, and `entries`; the envelope remains the
record and the stream remains transport only. No attention is emitted from the
transport layer: attention is a run-lifecycle event, minted and emitted where
the outcome is known (see Lifecycle below).

Headless workers use a frozen binary, resolved in this order:
`--claude-bin <absolute path>`, `$CREW_CLAUDE_BIN`, then
`${HOME}/.local/bin/claude` when it exists; there is no bare-PATH fallback.
`headlessIo` treats the ReturnEnvelope as the record and classifies worker
runs as `ok`, `ok-degraded`, `aborted`, `no-envelope`, `malformed`, or
`timeout`; a perfect stream without an envelope is still `no-envelope`.
When a headless turn settles it may emit a `usage` event with `{ id, role,
model, session_id, transcript_path, usage }`, where `usage` is either the four
`billed_*_tokens` fields or `null`. `emitAdapter` stores these measurements in
`agent_sessions`, not `sessions`: the former has per-agent identity, while the
latter is a per-run total (and also carries the out-of-scope money field).
Claude headless-json treats the terminal `result` usage as the cumulative
aggregate (assistant lines are repeated deltas) and otherwise dedupes repeated
message ids before summing; pi RPC sums `message_end` deltas only, excluding
replayed `turn_end` and `agent_end` usage.

## The daemon

`daemon.mjs` owns long-lived headless crew runs behind a Unix-socket JSONL protocol. Its socket and pidfile live at `<root>/daemon.sock` and `<root>/daemon.json` (the default root is `~/.crew/daemon`). The closed command set is `ping`, `enqueue`, `list`, `state`, `result`, `tail`, `untail`, `stop`, and `send`; `send` may refuse with `not-live` or `not-capable` (as well as the usual `not-found`/`invalid-params`).

`state()` is a query with the closed enum `working`, `blocked`, `done`, or `dead`; it carries no outcome. In particular, `idle` is not success: an escalation envelope is a settled `done` state, while its outcome is read separately through `result()` from the task envelope. The live feed is a normalized in-memory projection of the journal and worker streams, never a second record (ADR-029 §4); the envelope remains authoritative.

A daemon restart adopts an un-settled run when its driver is alive and resumes the file projection. If the driver is dead, it settles from a valid envelope or honestly marks the run orphaned. It never re-runs an orphan and never ties a run's lifetime to a subscriber or client connection. `enqueue` refuses a crew with any pane-transport seat up front (`invalid-spec`); `runChild` keeps the same guard for children launched by any other path.

## factoryctl

`factoryctl run --crew-dir <dir> --brief <file>` enqueues an already-booted crew directory; `factoryctl run --brief <file> --tier <tier> [--checkout <dir>] [--task <slug>]` asks the daemon to boot a headless crew for itself and enqueues it. `--crew-dir` and `--tier` are mutually exclusive; the tier boot runs as a child process (never an import), and a failed boot refuses without registering a run. The crew directory comes from what boot reports. `factoryctl ls [--root <dir>] [--json]` lists daemon runs. `factoryctl attach <run-id> [--root <dir>]` subscribes to the daemon's normalized feed, prints one JSON event per line, replays the retained window for a settled run and returns, unsubscribes on every exit path, and never claims an outcome. `factoryctl send <run-id> <message> [--role <role>]` delivers a boundary interjection to a steerable live seat. An `ok` response means the frame reached the seat's command channel and asserts nothing about the agent acting on it; a non-steerable transport is refused by name rather than queued. It is a stateless client that owns nothing and never starts a daemon. If none is listening, start one as described in [The daemon](#the-daemon), for example with `daemon({root}).start()`.

For `ls`, STATE comes from the daemon's `state()` projection (carried by `list()`) and OUTCOME comes only from `result()`; an unsettled run's outcome cell is empty because `idle` is not success.

## Readiness

Before `run` drives a seat, it waits for that seat to render as ready:
primarily its own `ready: <role>` reply to the boot brief, and — for panes
that have scrolled past that reply (a re-run against a long-lived workspace)
— agent TUI chrome as a documented, looser fallback (`seatReadySignal` in
`crew.mjs`). Agent-agnostic by construction: it recognizes claude's and pi's
chrome without either adapter knowing readiness detection exists.

**Liveness is three-state, deliberately.** `paneAlive()` returns `true`,
`false`, or `null` — `null` meaning *indeterminate* (the cmux tree could not
be read), never *dead*. `status` reports that value per seat, and the wait
loop counts only `false` toward its dead-seat verdict, so a cmux hiccup can
never kill a live run. Liveness is a give-up signal only: a quiet seat is not
a failed one, and outcome comes from the envelope file, always.

## Plan check: growth evidence and the carve verdict

During each plan-check round the driver records the plan and gate byte counts,
deltas, combined bytes, the round-1 combined baseline, the `files_in_scope`
count, a ratio, and a `divergent` label. A round is `divergent` only when its
combined bytes are at least 2x the round-1 combined bytes. The absolute
`plan_bytes` and `gate_bytes` sit beside `files_in_scope` so a large plan is
legible as evidence rather than being mistaken for a scope change.

`gate_path` must be an absolute path inside the task directory; paths outside it
are ignored, and the driver never parses `gate_cmd`. Growth is evidence in the
next check or plan-revision brief, never a verdict: missing or unreadable files
cannot fail a run. On every plan revision (round 2 and later), the planner must
return the closed `carve_verdict` enum, `proceed` or `carve`. A `carve` carries
its sanitized `carve_slices` to a human escalation (the first slice must be
buildable alone); missing or out-of-enum verdicts escalate rather than silently
proceeding.

## The acceptance gate (gate-first)

The planner may author an executable gate in the TASK DIR (immutable to the
builder by construction): a command exiting 0 iff what-was-asked is
what-got-built. Enforced mechanically: the gate must fail **RED at baseline**
(a green baseline = vacuous acceptance or already-done work → planner
bounced; twice → escalation). Failures feed back verbatim per build round;
repeated failures trigger reviewer triage (`build` vs `gate` defect), and a
gate defect grants the planner exactly one non-weakening repair whose re-run
consumes no builder round.

**Red must mean the gate RAN** (#153). A non-zero exit is also what a wholly
broken gate produces, so the gate prints a final
`GATE-SUMMARY {"total":n,"failed":n,"errored":n}` line and the driver requires
`errored: 0` at baseline — `errored` counting checks that threw before they
could adjudicate. A missing or malformed summary is itself a defective gate.
That bounce is pre-build hygiene and deliberately does **not** consume the
single gate repair; a second baseline that still cannot run escalates.
Measured on a live run: a gate with one un-runnable check printed 36 failures
across 22 checks at baseline and exited non-zero exactly like a healthy red
gate, so the defect stayed invisible for nine stages — surfacing only once the
implementation made the check reachable, with the one repair already spent
elsewhere. Post-build gate runs are unchanged: reviewer triage already
separates a build defect from a gate defect there.

The driver owns `gate_generation` (identity is the driver's, never the command string, which a repair may legitimately return unchanged). At the first green of each generation it runs the gate once on the pristine tree via the optional `io.runClean` and records `details.gate.discrimination` as `proven` / `failed` / `unproven` under the full `baselineGateDefect` predicate; a `failed` proof is a gate defect that bounces the planner against the single gate repair, a second failed proof escalates, the repaired gate's re-proof uses the same predicate rather than bare `pristine.ok`, `unproven` never blocks, and the task is bounded at `1 + gate_repairs` pristine runs.

## Contracts

Everything durable is a FILE; pane chat is never the record.

- **ReturnEnvelope** (every assignment): `{ assignment_id, role, status:
  done|insufficient|blocked, summary, artifacts[], details{...} }` written to
  the return path named in the assignment line.
- **Assignment line**: single line, safe charset, composed by
  `assignmentLine()` — content travels in brief files, the line only points.
- **Task envelope**: written by the driver to `task.json` — status, commit,
  stages, consults, dissents, gate record, escalation.
- **Lifecycle** (code as policy): `done` → archive the crew dir + close the
  workspace (`--keep` to inspect); `escalation` → the workspace always
  survives (it IS the context the human needs), and mints a `parked/null` park
  under `~/.crew/<repo>/<task>/reclaim/parks/` whose seats are the crew's;
  `done` mints nothing, and a mint failure is warned about without changing
  the outcome.

## Files

- `crew.mjs` — CLI: boot / run / handoff (legacy agent-driven mode) / wait /
  status / teardown.
- `daemon.mjs` — the long-lived headless-run daemon, Unix-socket protocol, restart adoption, and live file projection.
- `realio.mjs` — the io implementation: the injected-`deps` seam,
  `waitForEnvelope`, `emitAdapter`, and the cmux + git wiring.
- `drive.mjs` — the deterministic task loop (dependency-injected io; fully
  unit-tested without cmux). `io.emit(event)` is OPTIONAL: when `run` can open
  a factory ledger run, stage/assign/envelope/decision/dissent events are
  mirrored through `emitAdapter` in `realio.mjs`; `gate` events go to
  `gate_results`; `discrimination` events land in `gate_discriminations`, and
  review-carrying `envelope` events land in `review_outcomes`. The
  `ledger:gate-review-gap` and `ledger:eligible-tasks` recipes expose the two
  durable queries. `attention` events go to warn-level `log` rows. Attention
  fires only on gate exhaustion or triage escalation. Gate-moment attention
  carries `park_id: null`; the escalation moment is emitted by `crew.mjs`'s run
  lifecycle and carries a real minted `park_id`. Instrumentation is never
  load-bearing — a missing, broken or unwritable ledger changes nothing about
  a run's outcome.
- `driver.mjs` — the cmux layer: verified-send (echo-exactly-once,
  ctrl+u-guarded retype), context-aware ops, `assignmentLine`.
- `reclaim.mjs` — append-only token-fenced transition locks, the serialized
  reservation engine, the lease surface, and the park forward and reconciliation
  paths (`reconcileParks`). The park / lease protocol is documented in
  `docs/park-lease-protocol.md`; `overrideLock` and `overrideLease` are break
  glass operations requiring operator attestation of supervisor quiescence.
  Serialization is guaranteed for normal operation and automatic ESRCH
  displacement.
- `adapters/adapter-*.mjs` — the per-agent seam: capabilitiesFor + seatCommand
  (see "Adapters" above).
- `roles/*.md` — seat charters, appended as system prompts at boot.
- Tests: `drive.test.mjs` (the loop), `driver.test.mjs` (line composition),
  `reclaim.test.mjs` (reservation and transition-lock contracts),
  `io-contract.test.mjs` (the shared io contract, run against realIo, headlessIo, and headlessRpcIo).

State lives under `~/.crew/<repo>/<task>/` (crew.json, task dir, returns,
journal); archives keep the durable record after teardown.

## Posture

Seats run `--permission-mode bypassPermissions` (nobody is at their panes to
approve). The ENFORCED tool boundary is per-seat `--disallowedTools` — it
holds even under bypass, and it is what makes builder-only `Edit` and
builder-never-`Task` real (`--allowedTools` is only an auto-approve list;
under bypass it restricts nothing). `Write` stays available to every seat
(envelopes, task-dir artifacts), so the REPO boundary for non-builder seats
is the git scope gate + in-scope-only commit, not tool denial. Beyond that:
the feature-branch blast radius, `DEVTEAM_WORKER=1` anti-recursion, and the
operator's global deny rules. The driver never pushes; PR/push stays with
the human's orchestrator.
