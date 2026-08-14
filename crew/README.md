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

| tier | lead | planner | builder | reviewer | tech-lead |
|---|---|---|---|---|---|
| `mechanical` | — | claude/opus-5, medium | pi/luna, max | pi/terra, medium | — |
| `build` | claude/opus-5, medium | claude/opus-5, medium | pi/luna, max | pi/terra, high | — |
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

A `--model-<role>` flag on a `--tier` boot is a **raw passthrough that is
never namespace-translated**: `--model-builder gpt-5.6-luna` on a pi seat
stays a bare-id lookup, not `openai-codex/gpt-5.6-luna`, because an operator
typing a model id is speaking their own CLI's namespace. Where it is
recorded: `sources.<role>.model === 'override'` in the boot journal's
`allocation` map (including any declared capability shortfalls).

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
record and the stream remains transport only. No live attention is emitted
here; that belongs to #125.

Headless workers use a frozen binary, resolved in this order:
`--claude-bin <absolute path>`, `$CREW_CLAUDE_BIN`, then
`${HOME}/.local/bin/claude` when it exists; there is no bare-PATH fallback.
`headlessIo` treats the ReturnEnvelope as the record and classifies worker
runs as `ok`, `ok-degraded`, `aborted`, `no-envelope`, `malformed`, or
`timeout`; a perfect stream without an envelope is still `no-envelope`.

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
  survives (it IS the context the human needs).

## Files

- `crew.mjs` — CLI: boot / run / handoff (legacy agent-driven mode) / wait /
  status / teardown.
- `realio.mjs` — the io implementation: the injected-`deps` seam,
  `waitForEnvelope`, `emitAdapter`, and the cmux + git wiring.
- `drive.mjs` — the deterministic task loop (dependency-injected io; fully
  unit-tested without cmux). `io.emit(event)` is OPTIONAL: when `run` can open
  a factory ledger run, stage/assign/envelope/decision/dissent events are
  mirrored through `emitAdapter` in `realio.mjs`; `gate` events go to
  `gate_results`, and `attention` events go to warn-level `log` rows. Attention
  fires only on gate exhaustion or triage escalation and carries `park_id:
  null` pending #125. Instrumentation is never load-bearing — a missing,
  broken or unwritable ledger changes nothing about a run's outcome.
- `driver.mjs` — the cmux layer: verified-send (echo-exactly-once,
  ctrl+u-guarded retype), context-aware ops, `assignmentLine`.
- `reclaim.mjs` — append-only token-fenced transition locks, the serialized
  reservation engine, and the pluggable evidence-authority seam. Park and lease
  surfaces remain #125's to add on this engine. Serialization is guaranteed for
  normal operation and automatic ESRCH displacement; `overrideLock` is break
  glass and requires operator attestation of supervisor quiescence.
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
