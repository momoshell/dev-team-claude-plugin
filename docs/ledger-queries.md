# Ledger queries

The factory ledger is the register for run facts. When a session asks what happened, use the query that answers that question; **prose that restates run facts is the thing being retired**.

## Question → command

| Question | Command |
| --- | --- |
| What happened in this run? | `node scripts/factory/ledger.mjs task <adw_id\|task_slug>` — prints the resolved run session, including `sessions.request` and `request_source` — **NULL in every production row** today (454 real sessions, measured 2026-08-25, 0 with a request; 0 `recordSessionRequest` lines in 101,132 JSONL lines, measured 2026-08-21), because the only automatic caller writes under a `dbPath` production never supplies (`scripts/factory/intake.mjs:1306`, `:812`) — phase rows, gate generations (attempts, green and pristine-run counts, latest gate timestamp, and per-generation discrimination), structured review outcomes, typed accept decisions, token usage, and `absent` markers. The unit is one run; usage is token counts across its agent sessions. |
| Did a lead accept with residuals, and did the typed decision hold? | `node scripts/factory/ledger.mjs task <adw_id\|task_slug>` — prints the `accept_decisions` rows: where the accept was attempted, whether it was accepted or fell closed to escalate, the residual/refuted/cosmetic/unverified counts, and the reasons an invalid decision was refused. The unit is one accept attempt. |
| Which runs exist? | `node scripts/factory/ledger.mjs sessions` — prints the session rows, one row per run, including task slug, status, timestamps, `sessions.request` (**NULL in every production row** today — see the `request` verb below), `request_source`, and the session-level token and cost columns. The unit is one run. |
| Which task profile, execution shape, and assurance did a run use? | Query `run_configurations` by `adw_id`. One versioned row records requested/effective/source provenance for the three independent axes plus the compatibility `legacy_variant` and `legacy_tier`. No row means the run predates this measurement; never infer configuration from phases or seats. |
| Which agent, model, effort and transport actually sat in each role? | Query `run_seats` by `adw_id` — one row per effective role, with `source` naming where the value came from (`roster`, `profile_recommendation`, `operator_override`, `reseat`) and `policy_state` whether it passed the boot policy. No rows means the run predates effective-seat recording; never reconstruct seats from `agent_sessions`, which records only seats that produced a transcript. |
| What phases did a run go through? | `node scripts/factory/ledger.mjs phases <adw_id>` — prints phase rows ordered by sequence, with the phase name, status, and start/end timestamps. The unit is one phase. |
| What events did a run emit? | `node scripts/factory/ledger.mjs tail <adw_id> [--after n] [--limit n]` — prints ordered event rows and their bounded payloads; `--after` is an exclusive event-row cursor and `--limit` is the page size. The unit is one event. |
| What processes did a run spawn? | **Retired (#405)** — `node scripts/factory/ledger.mjs procs <adw_id>` still runs, but the `processes` table has no writer, so it returns `[]` for every run. The zero is **retired**, not *no processes spawned*; `ledger doctor` prints the reason in `retired_tables.processes`. |
| Does the mirror still agree with its JSONL authority? | `node scripts/factory/ledger.mjs doctor` — prints `jsonl_drift`: per writer, the DISTINCT unique keys its JSONL lines carry, the rows present in the mirrored table, and the drift. The unit is one writer. |
| How often does a green gate precede must-fix review findings? | `node scripts/factory/ledger.mjs gate-review-gap` — prints the numerator, denominator, rate, and per-run gate/review aggregates. The units are runs, gate runs, reviews, and must-fix findings; green means a non-pristine `gate_results` row with `ok = 1`. |
| Which tasks are eligible? | `node scripts/factory/ledger.mjs eligible-tasks` — prints the horizon, eligible count, and per-run active gate generation, review count, and proven-active flag. The unit is one run/task. |
| What did this run-set do and cost? | `node scripts/factory/ledger.mjs run-set --since <iso> [--until <iso>]` — prints the window, the run count, the per-status settled tally, the summed token usage, and one row per run with its status, timestamps and billed totals. A run-set is a **view**: the runs whose `started_at` falls in `[since, until)`, never a stored batch id. Parks are not measured here — they live in the per-crew-dir reclaim store, so the readout carries an `absent.parked` marker. The unit is one run-set; rows are runs. |
| Which cells are failing, and how? | `node scripts/factory/ledger.mjs cell-failures [--since <iso>] [--until <iso>]` — prints one row per cell (`provider`/`model_id`/`agent`/`effort`) and failure kind, with the failure count, first/last timestamps, and how many of them were **run-less**. The unit is one cell × failure kind. This is the *availability* axis — a cell that could not hold a seat, died mid-assignment, timed out, or returned an unusable envelope. It is **not** the quality axis: `review_outcomes` and `accept_decisions` answer whether a cell's work was good; a cell that bounces work is doing its job. |
| How often does a modifier fire, and how often does firing change anything? | `node scripts/factory/ledger.mjs modifier-attempts [--since <iso>] [--until <iso>]` — prints one row per modifier × outcome × role × transport × **from** cell (`provider`/`model_id`/`agent`/`effort`), with the attempt count, how many of them **applied**, and first/last timestamps. The unit is one attempt. A row with a NULL `to_*` cell is a measured **refusal**, not a gap: the attempt fired and resolved no new cell. This is the *instrumentation* axis — it decides nothing about whether a modifier should fire. |
| How often does CI catch what the local lane missed, and does one repair cycle fix it? | `node scripts/factory/ledger.mjs ci-cycles [--since <iso>] [--until <iso>]` — prints the watched/caught pair for the window and one row per check × classification × cycle, with the count and first/last timestamps. It also prints `dispatches` from `ci_dispatches`, one row per variant × outcome × cycle, plus the closed `dispatch_outcomes` list. The unit is one watched cycle: one check, on one head, on one cycle number; `ci_cycles` says what was decided and `ci_dispatches` says what the repair produced, joined by `(branch, head_sha, check_name, cycle)`. `watched` is every cycle recorded; `caught` is the cycles the local lane missed and CI reproduced. A `platform-divergent` row is CI catching something the local lane *cannot* run, not something it missed. A terminal park is the deterministic `<crew dir>/task/ci-park-cycle-<n>.json` artifact. This verb returns `measured: false` for every window that has ever existed because its writer is RETIRED, not merely unreached: the watcher that was its only caller measured zero rows for all time and was deleted 2026-08-26 by lane b264-ciretireb2 (#535), while the tables, their writers and this verb stay by decision U-4. |
| Why is the queue not moving — and what did the loop actually do? | `node scripts/factory/ledger.mjs intake-sweeps [--since <iso>] [--until <iso>]` — prints the swept/picked/parked tally for the window, one row per sweep outcome × reason, one row per refusal reason, and the `intake_dispatches` block. Sweeps and dispatches join on `(board_owner, board_project, sweep_at)`; the unit of a dispatch row is one recorded step. The unit is one sweep; refusal rows are candidates. This verb returns `measured: false` for every window that has ever existed because no production invocation reaches its writer: intake passes `dbPath: null` by design (`scripts/factory/intake.mjs:1744`). |
| Are we leaking workers? | `node scripts/factory/ledger.mjs seat-teardowns [--since <iso>] [--until <iso>]` — prints the window's torn-down/proven/leaked/unproven tally and one row per outcome × reason with first/last timestamps. The unit is one piped seat at one run's end. |
| How many lanes did the factory lose to itself, and to what? | `node scripts/factory/ledger.mjs escalations --since <iso> [--until <iso>]` — prints one row per cause × actor with the count and first/last timestamps. The unit is one escalated run, counted at sessions.ended_at. A count of zero is measured whenever runs ended in the window; `runs_ended` is its denominator, and the `absent` marker means no run ended there. |
| Which provider failures were recorded, and over how many runs? | `node scripts/factory/ledger.mjs journal-facts [--since <iso>] [--until <iso>]` — prints `provider_failures` by closed kind beside `runs_seen`, the distinct-run denominator. The unit is one recorded provider refusal; an absent family is unmeasured, never a measured zero. |
| Which plan-scope decisions were recorded, and over how many rounds? | `node scripts/factory/ledger.mjs journal-facts [--since <iso>] [--until <iso>]` — prints `plan_scope` by verdict beside `rounds_seen`, the distinct run/round denominator. The unit is one recorded plan-scope observation; an absent family is unmeasured, never a measured zero. |
| How often did a lost seat get re-asked? | `node scripts/factory/ledger.mjs journal-facts [--since <iso>] [--until <iso>]` — prints `seat_reasks` by event beside `reasks_seen`, the recorded re-ask denominator. The unit is one lost-seat re-ask; an absent family is unmeasured, never a measured zero. |
| How often was a malformed accept corrected? | `node scripts/factory/ledger.mjs journal-facts [--since <iso>] [--until <iso>]` — prints `accept_reasks` and its error count beside `accepts_seen`, the recorded correction denominator. The unit is one accept correction; an absent family is unmeasured, never a measured zero. |
| Which RPC exit contexts were recorded? | `node scripts/factory/ledger.mjs journal-facts [--since <iso>] [--until <iso>]` — prints `rpc_exits` by outcome beside `exits_seen`, the recorded exit-context denominator. The unit is one RPC exit context; an absent family is unmeasured, never a measured zero. |
| Which adopted plans were recorded? | `node scripts/factory/ledger.mjs journal-facts [--since <iso>] [--until <iso>]` — prints `plan_adoptions`, including file and finding totals, beside `adoptions_seen`, the recorded-adoption denominator. The unit is one adopted plan; an absent family is unmeasured, never a measured zero. |
| Which external fence lanes were registered? | `node scripts/factory/ledger.mjs journal-facts [--since <iso>] [--until <iso>]` — prints `external_fences`, including file/read totals, beside `lanes_seen`, the distinct-lane denominator. The unit is one dispatch-register lane entry; an absent family is unmeasured, never a measured zero. |
| Can a hand-driven run get its compiled request? | **Supported, hand-driven (#456)** — `node scripts/factory/ledger.mjs request <adw_id> --from-brief <path>` reads the first non-blank paragraph under `## The ask` and records it with `request_source: 'brief-file'`; missing, absent, or blank sections refuse rather than guessing. It is **not retired**: it is the only writer that reaches a production ledger today, because the intake dispatcher's call records under `withLedger`, a no-op without a `dbPath` (`scripts/factory/intake.mjs:812`). |

Replace `<adw_id>` or `<task_slug>` placeholders with the run's identifier, and replace `<iso>` placeholders with an ISO-8601 timestamp such as `2026-08-15T00:00:00Z`; the optional tail flags are literal command-line options.

## Honesty rules

Run facts are answered by the queries above. A memory entry or other prose that restates those facts is the thing being retired; durable conventions, user preferences, and decision rationale remain prose.

`sessions` carries fixture rows under six slugs — `x`, `daemon80`, `unfenced-child`, `fence-scope`, `fence-plan`, and `daemon-null-lane` — alongside the real rows. I measured **454 real sessions** on 2026-08-25: **355 ok, 86 aborted, and 13 running**. Any rate computed over raw `sessions` is wrong by roughly **45x**; copy this exclusion into every such query: `task_slug not in ('x','daemon80','unfenced-child','fence-scope','fence-plan','daemon-null-lane')`.

The register's honesty rule is that no rows for an older run answer **“not measured then,” not “nothing happened.”** The `task` readout says this explicitly through its `absent` markers: a null fact with a marker is not a measured zero. This distinction applies independently to phases, gate verdict recording, gate discrimination, structured review outcomes, typed accept decisions, and usage. A `cell_failures` row with `adw_id` NULL is a boot-time refusal, recorded run-lessly on purpose — `bootCmd` never opens a run. A run with no `modifier_attempts` rows means the modifier was **not measured** then — never that nothing fired; runs that predate this table have no rows by construction.

`journal-facts` applies the same rule independently to `provider_failures`, `plan_scope`, `seat_reasks`, `accept_reasks`, `rpc_exits`, `plan_adoptions`, and `external_fences`: each family carries its named denominator (`runs_seen`, `rounds_seen`, `reasks_seen`, `accepts_seen`, `exits_seen`, `adoptions_seen`, or `lanes_seen`), and no rows in the requested window yield null counts plus `absent: 'no rows in this window — not measured, never a measured zero'`. A family with rows is measured even when one of its by-value counts is zero; ingest is additive and never infers older facts.

`jsonl_drift` compares distinct unique keys, because a repeat key is an upsert, not drift, between the JSONL authority and its mirrored table. An absent or unreadable authority, an unparsable line, or a line whose kind is outside `WRITERS` is unmeasured (`measured: false`) with a named reason and a null `drift_total`, never zero drift; `replayJsonl` is the remedy, and `doctor` repairs nothing. The measured cost was 28 MB / 101,501 lines compared in 160 ms on 2026-08-22, so the scan is unbounded and unsampled by decision; that measurement found 94 runs whose `sessions` and `phases` rows never reached the mirror.

A run with **no `seat_teardowns` rows was not measured** — never a measured zero and never a clean run: runs predating this table have no rows by construction, a crew with no piped seats records its sweep in the run's journal rather than here, and a headless-json seat is not covered at all. The readout says so in the payload itself: an empty window carries `measured: false`, an `absent` marker, and null tallies rather than zeros. `proven` is the only outcome that says a worker is gone, and it requires the wrapper's own exit marker, an `ESRCH` from the kill, or `probeEvidence(...) === LIVENESS.DEAD`; a signal we delivered is never evidence. `failed` is a measured live worker after teardown — an unreaped child of the run reads this way too, so `failed` over-reports a leak rather than under-reporting one. `unproven` carries its reason (an unreadable pgid, an unreadable reservation, a marker owned by another reservation, a probe that could not decide) and is never quietly counted as clean. `forced = 1` means run-end teardown killed a seat whose turn was still in flight — the guard was actually bypassed — because at run end nobody is left to steer it.

A NULL `sessions.request` means **not measured then**, never an empty ask. `request_source` says whether the text was measured at dispatch (`dispatch`) or read back from a brief file (`brief-file`). An intake-dispatched run carries the request only from the settle step onward because the crew mints the session mid-run and the dispatcher cannot reach it earlier. A hand-driven run with no brief file stays absent. The stored text is the compiled **ask** line, clamped at `REQUEST_MAX_CHARS` with a visible truncation marker; the `task` readout carries `absent.request` while it is NULL.

`run_configurations` is the configuration authority for newly booted runs. It records the resolved task profile, requested/effective execution, requested/effective assurance, their resolution sources, and the legacy aliases used during migration. `sessions.tier`, `sessions.proposed_shape`, and `sessions.proposed_strength` keep their historical meanings. A historical run with no configuration row is unmeasured; the visualizer may translate a recorded legacy tier (`mechanical`, `build`, or `judge`) to its canonical assurance label, but it does not invent a task profile or execution shape.

A run with **no `run_seats` rows was not measured** — never a run with no seats. `run_seats` records one row for each effective role at boot because a pane seat may produce no `agent_sessions` row at all; that usage/session table is written only when a seat produces a transcript. Therefore seats are never reconstructed from `agent_sessions`, and an absent `run_seats` row is not an empty or zero-seat claim.

Usage is tokens only and is a **sum of running totals** across the run's `agent_sessions` rows. Each row stores that agent session's running total, not a delta, so the readout sums the rows. Money is deliberately out of scope (#119); the query surface reports no cost calculation. **OPEN CONTRADICTION (#626):** `ledger cells` computes and prints a per-cell `cost_usd` from `crew/roster.json` rates under `CELL_PRICE_UNITS` (`scripts/factory/ledger.mjs:321`); a run of `node scripts/factory/ledger.mjs cells --since 2026-08-13T00:00:00Z` measured `cost_usd: 29.193845` for one claude-opus-5 reviewer cell. The decision about which claim governs belongs to a human.

A `ci_cycles` classification of `unknown` is a **measured non-answer carrying its reason** — never a green, and never a repair; a branch with no `ci_cycles` rows was **not watched**, which is not the same as watched-and-green; and `excerpt_source: 'redacted'` means a captured excerpt was dropped by field hygiene, not that none was captured. A `repair` decision with no matching `ci_dispatches` row was **not measured**, never “not dispatched”: a refusal is itself recorded as `outcome: 'refused'` with its reason. A park is a terminal artifact at `<crew dir>/task/ci-park-cycle-<n>.json`, carrying the verbatim recorded log rather than a bare failure. The readout says so in the payload itself: a window with no `ci_cycles` rows carries `measured: false`, an `absent.ci_cycles` marker, and null `watched`/`caught` tallies rather than zeros, while a watched window that reproduced nothing still reports a real measured `caught: 0`.

A sweep with **no** refusal rows means nothing was refused *that sweep*, never that the board was empty; `outcome: 'none'` is a measured “nothing was eligible” and is **not** a park; a `parked` sweep always carries its named reason, and `rate-limit-floor` means the board was read **partially** — the pick is unknown, not absent; a branch of the board with no sweep rows was **not swept**, which is not the same as swept-and-empty. The readout says so in the payload itself: a window with no sweep rows carries `measured: false`, an `absent.intake_sweeps` marker, and null `swept`/`picked`/`parked` tallies rather than zeros, while a swept window that picked nothing still reports a real measured `picked: 0`.

A `claimed` row with no settled row is a **stranded** dispatch — the run may or may not have started, and the issue is deliberately left out of `Ready` so it is never re-dispatched; a `refused` row means nothing executed; `unreadable` is never a `done`; and a `promoted` row is the only evidence that a PR was seen — the loop never merges, approves or closes anything.

The ledger declares **30 tables** plus SQLite's own `sqlite_sequence`. `run_configurations` and `run_seats` are populated only for runs booted after canonical configuration and effective-seat recording shipped; older runs deliberately have no row. The seven journal-fact tables — `provider_failures`, `plan_scope_changes`, `seat_reasks`, `accept_reasks`, `rpc_exit_contexts`, `plan_adoptions`, and `external_fences` — are populated only for records ingested after this lane; older journal and dispatch-register rows are never backfilled. `envelopes` and `processes` are retired by declaration. The empty CI/intake tables remain unreached writers, not measured zeros.

## Typed run outcomes

`sessions.outcome` records the typed terminal result (`success`, `escalated`, `aborted`, or `failed`); `sessions.terminal_reason` records the measured cause or signal name; and `sessions.terminal_actor` records the actor that ended the run. NULL in any of these columns means the fact was not measured, never a measured zero, and no historical row is backfilled by inference. `sessions.status` keeps its old meaning and enum (`running`, `ok`, `fail`, or `aborted`), so an escalation remains legacy `aborted` while its typed outcome is `escalated`. The `task` readout carries `absent.outcome` for a row without a typed outcome.

The closed escalation-cause vocabulary is `transport`, `budget`, `plan-build-disagreement`, `brief-contradiction`, `gate-defect`, `review-unresolved`, `infrastructure`, `seat-lost`, `seat-timeout`, `seat-aborted`, `plan-rounds-exhausted`, `envelope-unusable`, `envelope-absent`, `build-rounds-exhausted`, with `unclassified` for a `{where, why}` pair no rule classifies. The three seat-failure causes are separate on purpose, because they imply different operator actions: a timeout is the driver's own wait ceiling (raise a budget), a lost seat is a worker the driver found dead by probe (investigate a kill), and an aborted seat is a worker that exited mid-stream (retry a transient). envelope-absent is a seat that settled and wrote nothing, while envelope-unusable is output the driver cannot read as an envelope; both classify identically on the pane and headless transports. build-rounds-exhausted is the build loop's round cap, the twin of plan-rounds-exhausted.

## Retired tables

`envelopes` is retired: it never held a row in any production ledger. Its only writer was the legacy `scripts/cmux/dispatch.mjs closeCmd`, deleted with the legacy runtime in 0.2.0 (`81dee7c`). `crew/seat-io.mjs` mirrors envelope facts into `events` / `review_outcomes` instead, while the visualizer reads envelope details from `returns/` archive files. `recordEnvelope` and the table stay declared because the schema fence is additive-only and `replayJsonl` depends on the closed `WRITERS` set. A zero row count is **retired**, not *nothing happened*; `ledger doctor` reports the reason beside `row_counts.envelopes` in `retired_tables`.

`processes` is retired: it has never held a row in any production ledger (454 real sessions, 0 process rows, measured 2026-08-25). `startProcess` has no caller outside `scripts/factory/ledger.mjs` itself and its own tests — nothing in `crew/`, `scripts/` or `visualizer/` records a spawned process — so `ledger procs <adw_id>` returns `[]` for every run. The table, `startProcess` and `endProcess` stay declared because the schema fence is additive-only and `replayJsonl` depends on the closed `WRITERS` set. A zero row count is **retired**, not *nothing happened*; `ledger doctor` reports the reason beside `row_counts.processes` in `retired_tables`. Wiring a writer is a separate decision that must first name whose pid a row represents.

## Context occupancy

| transport | `context_tokens` | `context_window` | why |
| --- | --- | --- | --- |
| `pane` (default, tmux/cmux) | NULL | NULL | a claude pane seat DOES land an `agent_sessions` row: `emitPaneUsage` (`crew/seat-io.mjs:2824`) emits a `usage` frame from the shipped claude reader (`SHIPPED_PANE_USAGE`, `crew/seat-io.mjs:1053`); measured **2 rows across the all-pane b213/b214 lanes on 2026-08-25**; pi/codex pane seats land none because there is no shipped usage reader, but their cost is not unmeasured — the pi transcripts price every message themselves, see recipe K; `context_tokens`/`context_window` remain NULL because the writer hardcodes both (`crew/seat-io.mjs:1412`); `foldUsage` (`crew/headless.mjs:286`) and `foldRpcUsage` (`crew/headless-rpc.mjs:154`) fold billed totals only |
| `headless-json` | NULL | NULL | the row is written, but the writer hardcodes both columns to null (`context_tokens: null, context_window: null`, `crew/seat-io.mjs:1412`), so the stored value is null whatever the fold produced; `foldUsage` (`crew/headless.mjs:286`) maps only `billed_*` and carries no context snapshot to store |
| `headless-rpc` | NULL | NULL | the same writer and the same two hardcoded nulls (`crew/seat-io.mjs:1412`); `foldRpcUsage` (`crew/headless-rpc.mjs:154`) sums `message_end` deltas into `billed_*` only and keeps no last-message snapshot |

The same retired pane explanation remains in `visualizer/server/shape.mjs:12`, `scripts/factory/ledger.mjs:3823`, and `visualizer/web/src/lib/trace.js:6`; those files are outside this lane's fence and this is a follow-up. `scripts/factory/transcript.mjs:206-263` is the reducer that could supply `context_tokens`; production `readUsage` callers are at `scripts/factory/transcript.mjs:277` and `:298` — and `context_window` is NULL by decision **U-4** because there is no verified source and a model→window table is drift-prone. No live transport populates either today — a meter reading of 0% occupancy would be a guess, so the `task` readout carries `absent.context_occupancy`. Populating either column is therefore two changes, not one: a fold that produces a context snapshot, and a writer that stops hardcoding null (`crew/seat-io.mjs:1412`). Whether it should be populated at all is not decided here (adjacent to #404).

**Scope plumbing landed:** the four boot entrypoints now declare `ctx.files_in_scope`: `crew/crew.mjs` from `--files-in-scope` or the failing run's envelope, `crew/child.mjs` and `crew/daemon.mjs` from the run spec, and `crew/factoryctl.mjs` from `--files-in-scope`. An entry the scope gate cannot honor is refused at the boot end with that entry named, and a shape that inherits scope is refused rather than run with an empty one. An `escalation` outcome now means a repair reached a seat and failed, or a boot-end refusal was recorded with its reason — it is no longer the missing plumbing. Rows recorded before this commit are not backfilled; their `where`/`why` remain in `ci_dispatches` and the park artifact.

## Questions the ledger verbs cannot answer

The verbs above answer questions about **runs**. A question about **seat behaviour over time** — how long a seat goes between frames, and whether that differs by how the run ended — is not in the ledger at all: the frames live in the adapter transcript homes, one JSONL file per session. Until now those questions were answered by hand-written throwaway node scripts. DuckDB answers them as one query, and can `ATTACH` the ledger `READ_ONLY` in the same session so a question spanning transcripts and run outcomes is a join rather than a script.

**duckdb is operator tooling: never in package.json, never imported by any .mjs, never run by a seat or gate.** It owns no data and writes no row anywhere; a `READ_ONLY` attach does, however, create the `-wal` and `-shm` sidecars beside a quiet database (recipe D). Installed out of band (`/opt/homebrew/bin/duckdb`, v1.5.5 when these recipes were run, 2026-08-24); the repo's zero-runtime-dependency and dependency-free-suite properties are unaffected because nothing in the repo reaches for it.

| Question | Command |
| --- | --- |
| How long does a seat go between frames, and does 900s still sit above healthy mid-turn work? | `duckdb` — recipe A below, the unified frame view over both adapter homes. Prints one row per adapter × gap bucket with n, p50, p90, p99, p99.9 and the count over 900s. The unit is one inter-frame gap. |
| Does that gap distribution differ by the run's terminal status? | `duckdb` — recipe B below, the same view joined to the `ATTACH`ed ledger's `sessions` rows. Prints one row per terminal status. The unit is one inter-frame gap, attributed to the settled run whose window contains it. |
| Does the reader survive a transcript whose final line is still being written, and does it say what it skipped? | `duckdb` — recipe C below. Prints lines read, lines skipped as torn, and frames usable. The unit is one JSONL line. |
| Is the ATTACHed ledger safe to read while a crew is writing it? | `duckdb` — recipe D below, run against a WAL fixture with the writer connection held open. Prints the reader's view during an uncommitted transaction, during a held write lock, after rollback, and before/after a quiet `READ_ONLY` attach's sidecars. The unit is one read. |
| Which runs escalated, where, and why? | `duckdb` — recipe E below. `returns/task.json` carries `details.escalation` as `{where, why}` while the ledger carries only the escalation phase. The unit is one run attempt. |
| Is an escalation a mechanism failure or a reasoned dead end? | `duckdb` — recipe F below, recipe E plus a stated `why`-prose classifier. The unit is one escalation; the mechanism share is a floor, never exact. |
| Does lane size predict plan rounds or escalation? | `duckdb` — recipe G below, joining planner mutation/scope records to `returns/task.json`. The unit is one lane. |
| What did each seat of a pane-run lane cost? | `duckdb` — recipe H below, over `pane-usage` records priced from `crew/roster.json`. The unit is one seat session; pi/codex pane seats emit no pane-usage record, so this is the **claude** half of a pane lane rather than a lane total — the pi half prices itself, see recipe K. |
| What did each headless seat cost, per lane? | `sqlite3` — recipe I below, `agent_sessions.billed_*` joined to the roster rates. The unit is one seat session; each row is a running total, not a delta. |
| Which ledger tables does production actually write? | `sqlite3` — recipe J below. The unit is one table; fixture rows in `sessions` are excluded from its real-session count. |
| What did a pane-seated pi seat cost, per lane and per seat session? | `duckdb` — recipe K below, over the per-message `usage.cost` the pi transcripts already carry. The unit is one lane, and one pi seat session. |

### The unified frame view

The two adapter homes carry the same events in different shapes, and a question about seat behaviour has to span both — `~/.pi/agent/sessions/<dir>/*.jsonl` holds the **builder** and **reviewer** seats, `~/.claude/projects/<dir>/*.jsonl` holds the **lead**, **planner** and **tech-lead** seats. `frames` is a `VIEW`, not a materialised table, with columns `(adapter, file, lane, ts, role, stop_reason, owes)`. `filename=true` supplies `file`; `adapter` comes from the adapter home in the path and `lane` is `dt-<lane>` from that path, so both are available without being carried in the frame. `ts` is the timestamp cast to `TIMESTAMPTZ`.

Pi supplies `role` from `message.role` and `stop_reason` from `message.stopReason`. On the claude side, `role` maps from `type`, while `stop_reason` maps from `message.stop_reason` on an assistant frame and from `message.content[0].type` on a user frame. That is why the two adapters normalise into one view without misreporting either shape.

A frame is normalised to one derived column, `owes` — what the transcript owed next when that frame landed:

| adapter | owes-tool | owes-model |
| --- | --- | --- |
| pi | `message.role = 'assistant'` and `message.stopReason = 'toolUse'` | `message.role = 'toolResult'` |
| claude | `type = 'assistant'` and `message.stop_reason = 'tool_use'` | `type = 'user'` and `message.content[0].type = 'tool_result'` |

The claude rule is **derived from the frame sequence, not assumed to mirror pi**, and the two shapes are not parallel. A claude assistant turn is split across one frame per content block, every block-frame carrying the same `message.id` and the same `stop_reason`, so `tool_use` appears on text, thinking and tool_use frames alike; a tool result comes back as a `user` frame whose content is a list of `tool_result` blocks, not as a role of its own. The claude home also interleaves frames pi has no analogue for — `attachment`, `system`, `queue-operation`, `pr-link`, `file-history-delta` — and some frames (`ai-title`, `atis-latch`) carry **no timestamp at all**, so a gap query must filter on `timestamp IS NOT NULL` before it orders anything.

A gap is measured between consecutive frames of the same file. A gap whose **previous** frame owes something is **mid-turn** — a frame was due. Every other gap is **idle**, a human between turns; idle gaps run an order of magnitude longer and mixing the two is the mistake that makes a naive all-gaps distribution useless.

### Recipe A — the #590 gap distribution, both adapters

Re-derives the distribution that `TRANSCRIPT_STALE_MS` (`crew/seat-io.mjs:87`) rests on. The window is pinned at `2026-08-24T15:00:00Z` — the corpus grows continuously, and pinning is what makes the recorded output below reproducible and what lets the pi half be checked against the #590 numbers measured by hand.

```sh
duckdb <<'SQL'
-- Recipe A — inter-frame gap distribution, both adapter homes, one shape.
-- `frames` is a VIEW, not a materialised table: it is the single normalisation
-- both adapters are read through, and every later recipe selects from it.
-- Window pinned so the recorded output stays reproducible.
CREATE OR REPLACE VIEW frames AS
SELECT adapter, filename AS file,
       regexp_extract(filename, 'dt-([A-Za-z0-9._-]+?)-*/', 1) AS lane,
       CAST(timestamp AS TIMESTAMPTZ) AS ts,
       role, stop_reason,
       CASE WHEN adapter='pi'     AND role='assistant' AND stop_reason='toolUse'  THEN 'owes-tool'
            WHEN adapter='pi'     AND role='toolResult'                           THEN 'owes-model'
            WHEN adapter='claude' AND role='assistant' AND stop_reason='tool_use' THEN 'owes-tool'
            WHEN adapter='claude' AND role='user'      AND stop_reason='tool_result' THEN 'owes-model'
            ELSE 'other' END AS owes
FROM (
  SELECT 'pi' AS adapter, filename, timestamp,
         json_extract_string(message,'$.role') AS role,
         json_extract_string(message,'$.stopReason') AS stop_reason
  FROM read_json_auto('~/.pi/agent/sessions/*/*.jsonl', filename=true, union_by_name=true,
                      ignore_errors=true, columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'})
  WHERE timestamp IS NOT NULL
  UNION ALL
  SELECT 'claude', filename, timestamp,
         type,
         CASE WHEN type='assistant' THEN json_extract_string(message,'$.stop_reason')
              WHEN type='user'      THEN json_extract_string(message,'$.content[0].type') END
  FROM read_json_auto('~/.claude/projects/*/*.jsonl', filename=true, union_by_name=true,
                      ignore_errors=true, columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'})
  WHERE timestamp IS NOT NULL
);

SELECT adapter, count(DISTINCT file) AS files FROM frames
WHERE ts < TIMESTAMPTZ '2026-08-24T15:00:00Z' GROUP BY 1 ORDER BY 1;

WITH gaps AS (
  SELECT *, epoch(ts) - epoch(lag(ts) OVER w) AS gap_s, lag(owes) OVER w AS powes
  FROM frames WINDOW w AS (PARTITION BY file ORDER BY ts, owes))
SELECT adapter,
       CASE WHEN powes IN ('owes-tool','owes-model') THEN 'mid-turn' ELSE 'idle' END AS bucket,
       count(*) AS n,
       round(quantile_disc(gap_s,0.5)::DOUBLE,2)   AS p50,
       round(quantile_disc(gap_s,0.9)::DOUBLE,1)   AS p90,
       round(quantile_disc(gap_s,0.99)::DOUBLE,1)  AS p99,
       round(quantile_disc(gap_s,0.999)::DOUBLE,1) AS p999,
       sum(CASE WHEN gap_s > 900 THEN 1 ELSE 0 END) AS over_900s
FROM gaps WHERE gap_s IS NOT NULL AND ts < TIMESTAMPTZ '2026-08-24T15:00:00Z'
GROUP BY 1,2 ORDER BY 1,2;
SQL
```

Recorded output, run 2026-08-24 on duckdb v1.5.5:

```text
┌─────────┬───────┐
│ adapter │ files │
│ varchar │ int64 │
├─────────┼───────┤
│ claude  │  1047 │
│ pi      │   880 │
└─────────┴───────┘
┌─────────┬──────────┬────────┬────────┬────────┬────────┬─────────┬───────────┐
│ adapter │  bucket  │   n    │  p50   │  p90   │  p99   │  p999   │ over_900s │
│ varchar │ varchar  │ int64  │ double │ double │ double │ double  │  int128   │
├─────────┼──────────┼────────┼────────┼────────┼────────┼─────────┼───────────┤
│ claude  │ idle     │  86393 │    2.4 │   19.7 │  543.6 │  8085.8 │       609 │
│ claude  │ mid-turn │ 124783 │    0.1 │    5.1 │   70.4 │   386.5 │        49 │
│ pi      │ idle     │   5858 │   2.15 │  422.0 │ 1960.7 │ 13694.1 │       259 │
│ pi      │ mid-turn │  52833 │   0.05 │   15.9 │   80.7 │   525.7 │        37 │
└─────────┴──────────┴────────┴────────┴────────┴────────┴─────────┴───────────┘
```

Re-run command: `bash /Users/x/.crew/dt-b229-ledgerwal/b229-ledgerwal/task/reference-recipe-a.sh` (the Recipe A `duckdb <<'SQL'` block above), measured 2026-08-25 on DuckDB v1.5.5. The pi half is byte-identical on re-run: `pi|880` and `pi|mid-turn|52833|0.05|15.9|80.7|525.7|37`. The claude half is not: files moved **1047→1046**, mid-turn n **124783→124676**, mid-turn p99 **70.4→70.5**, and idle n **86393→86325**. The reason is unresolved: the pin freezes the pi corpus, but claude transcript files under `~/.claude/projects/` are removed or rewritten behind it. The pi reproduction is the view's proof; the claude figures are a **snapshot, not a reproducible constant**.

**The pi half reproduces the hand-measured #590 distribution exactly** — 880 files, mid-turn n=52833, p50 0.05s, p90 15.9s, p99 80.7s, p99.9 525.7s, 37 gaps over 900s, and idle p90 422.0s. That is the proof the view is right; the claude half is then read on the same terms.

**verdict against #597:** claude mid-turn p99.9 does not exceed 900s. Measured over 1047 claude transcript files, claude mid-turn gaps are n=124783, p50 0.1s, p90 5.1s, p99 70.4s, p99.9 386.5s, with 49 gaps over 900s — 0.039% of mid-turn gaps, against pi's 0.070%. The 900s threshold was sampled from the pi home only and applied to every role by `waitForEnvelope`; measured, that extrapolation holds. The claude seats are, if anything, further inside it. No change to `TRANSCRIPT_STALE_MS` follows from this and none is made here (#590).

### Recipe B — the same gaps, split by terminal status

What the hand-written path cannot do at all: attribute each gap to the run it happened in and split by how that run ended. The join key is the lane in the transcript path against `sessions.task_slug`, bounded by the session's own window. Only **settled** sessions are joined (`ended_at IS NOT NULL`) — a `running` row has no terminal status yet, and its status will change under the query. Each `duckdb` invocation is its own session, so Recipe B repeats the same `frames` view definition by necessity.

```sh
duckdb <<SQL
-- Recipe B — the same gaps, split by the run's TERMINAL status, by joining the
-- ledger. ATTACH takes a literal path and does NOT expand ~, so \$HOME is
-- expanded by the shell here; read_json_auto below does expand ~.
INSTALL sqlite; LOAD sqlite;
ATTACH '$HOME/.dev-team/factory/ledger.db' AS L (TYPE sqlite, READ_ONLY);

CREATE OR REPLACE VIEW frames AS
SELECT adapter, filename AS file,
       regexp_extract(filename, 'dt-([A-Za-z0-9._-]+?)-*/', 1) AS lane,
       CAST(timestamp AS TIMESTAMPTZ) AS ts,
       role, stop_reason,
       CASE WHEN adapter='pi'     AND role='assistant' AND stop_reason='toolUse'  THEN 'owes-tool'
            WHEN adapter='pi'     AND role='toolResult'                           THEN 'owes-model'
            WHEN adapter='claude' AND role='assistant' AND stop_reason='tool_use' THEN 'owes-tool'
            WHEN adapter='claude' AND role='user'      AND stop_reason='tool_result' THEN 'owes-model'
            ELSE 'other' END AS owes
FROM (
  SELECT 'pi' AS adapter, filename, timestamp,
         json_extract_string(message,'$.role') AS role,
         json_extract_string(message,'$.stopReason') AS stop_reason
  FROM read_json_auto('~/.pi/agent/sessions/*/*.jsonl', filename=true, union_by_name=true,
                      ignore_errors=true, columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'})
  WHERE timestamp IS NOT NULL
  UNION ALL
  SELECT 'claude', filename, timestamp,
         type,
         CASE WHEN type='assistant' THEN json_extract_string(message,'$.stop_reason')
              WHEN type='user'      THEN json_extract_string(message,'$.content[0].type') END
  FROM read_json_auto('~/.claude/projects/*/*.jsonl', filename=true, union_by_name=true,
                      ignore_errors=true, columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'})
  WHERE timestamp IS NOT NULL
);

CREATE OR REPLACE TABLE gaps AS
SELECT *, epoch(ts) - epoch(lag(ts) OVER w) AS gap_s, lag(owes) OVER w AS powes
FROM frames WINDOW w AS (PARTITION BY file ORDER BY ts, owes);

SELECT s.status AS terminal_status, count(*) AS n,
       round(quantile_disc(g.gap_s,0.5)::DOUBLE,2)   AS p50,
       round(quantile_disc(g.gap_s,0.9)::DOUBLE,1)   AS p90,
       round(quantile_disc(g.gap_s,0.999)::DOUBLE,1) AS p999,
       sum(CASE WHEN g.gap_s > 900 THEN 1 ELSE 0 END) AS over_900s
FROM gaps g
JOIN L.sessions s
  ON s.task_slug = g.lane
 AND s.task_slug not in ('x','daemon80','unfenced-child','fence-scope','fence-plan','daemon-null-lane')
 AND s.ended_at IS NOT NULL
 AND CAST(s.ended_at AS TIMESTAMPTZ) < TIMESTAMPTZ '2026-08-24T15:00:00Z'
 AND g.ts >= CAST(s.started_at AS TIMESTAMPTZ)
 AND g.ts <  CAST(s.ended_at   AS TIMESTAMPTZ)
WHERE g.gap_s IS NOT NULL AND g.powes IN ('owes-tool','owes-model')
GROUP BY 1 ORDER BY n DESC;
SQL
```

Recorded output, run 2026-08-25T17:38:34Z (with the fixture-slug exclusion):

```text
┌─────────────────┬───────┬────────┬────────┬────────┬───────────┐
│ terminal_status │   n   │  p50   │  p90   │  p999  │ over_900s │
│     varchar     │ int64 │ double │ double │ double │  int128   │
├─────────────────┼───────┼────────┼────────┼────────┼───────────┤
│ ok              │ 39616 │   0.05 │    8.7 │  160.1 │         1 │
│ aborted         │ 17345 │   0.05 │    9.0 │  216.5 │         0 │
└─────────────────┴───────┴────────┴────────┴────────┴───────────┘
```

The unit is one gap **per settled session whose window contains it**: a gap in a lane that ran more than once inside overlapping windows is counted against each, and a gap in a transcript whose path carries no `dt-<lane>` segment is not counted at all. This readout is therefore about the joined subset, never the whole corpus.

### Recipe C — a transcript being written has a torn final line

A live transcript's last line is often half-written. Without `ignore_errors=true` the whole query dies on it (`Invalid Input Error: Malformed JSON in file ... unexpected end of data`); with it, the torn line parses to an **all-NULL row** and vanishes silently, which is worse. Count it instead: a torn line is NULL in every projected column, while a legitimately timestamp-less frame still carries its `type`.

```sh
# Recipe C — does the reader tolerate a transcript whose final line is still
# being written, and does it say what it skipped? Demonstrated on a fixture.
d=$(mktemp -d)
printf '%s\n' \
  '{"type":"message","timestamp":"2026-08-24T10:00:00.000Z","message":{"role":"user"}}' \
  '{"type":"message","timestamp":"2026-08-24T10:00:05.000Z","message":{"role":"assistant","stopReason":"toolUse"}}' \
  > "$d/live.jsonl"
printf '%s' '{"type":"message","timestamp":"2026-08-24T10:0' >> "$d/live.jsonl"
duckdb -c "
SELECT count(*) AS lines_read,
       count(*) FILTER (WHERE timestamp IS NULL AND type IS NULL AND message IS NULL) AS lines_skipped_torn,
       count(*) FILTER (WHERE timestamp IS NOT NULL) AS frames_usable
FROM read_json_auto('$d/*.jsonl', filename=true, union_by_name=true, ignore_errors=true,
                    columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'});
"
rm -rf "$d"
```

```text
┌────────────┬────────────────────┬───────────────┐
│ lines_read │ lines_skipped_torn │ frames_usable │
│   int64    │       int64        │     int64     │
├────────────┼────────────────────┼───────────────┤
│          3 │                  1 │             2 │
└────────────┴────────────────────┴───────────────┘
```

**torn final line, measured:** 1 of 3 lines skipped on the fixture above, and 0 skipped across the live corpus — 0 of 61433 pi lines and 0 of 284656 claude lines on 2026-08-24. A recipe that does not carry this counter is not tolerating a torn line, it is hiding one.

### Recipe D — reading the ledger while a crew is writing it

The ledger is in WAL mode and a live lane holds it open. A reader that sees a torn or stale snapshot would be worse than no reader, so this is measured rather than assumed.

```sh
# Recipe D — is the ATTACHed sqlite reader safe while a crew is WRITING the
# ledger? Demonstrated on a fixture in WAL mode with the writer connection open,
# through an uncommitted transaction and a held write lock. Never the real ledger.
d=$(mktemp -d)
cat > "$d/probe.mjs" <<'EOF'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const p = join(dir, 't.db')
const read = () => {
  try {
    return execFileSync('duckdb', ['-noheader', '-list', '-c',
      `INSTALL sqlite; LOAD sqlite; ATTACH '${p}' AS L (TYPE sqlite, READ_ONLY);` +
      ` SELECT count(*), coalesce(string_agg(v, ',' ORDER BY id), '-') FROM L.t;`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) { return 'ERROR: ' + String(e.stderr || e.message).trim().split('\n')[0] }
}
const sidecars = () => ['-shm', '-wal'].filter(s => existsSync(p + s)).map(s => 't.db' + s).join(', ') || 'none'

const db = new DatabaseSync(p)
db.exec('PRAGMA journal_mode=WAL')
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
db.exec("INSERT INTO t(v) VALUES ('A'),('B')")
console.log('writer open, 2 rows committed to WAL :', read())
db.exec('BEGIN')
db.exec("INSERT INTO t(v) VALUES ('DIRTY-C')")
console.log('writer mid-transaction, UNCOMMITTED  :', read())
db.exec('COMMIT')
console.log('committed to WAL, NOT checkpointed   :', read())
db.exec('BEGIN IMMEDIATE')
db.exec("INSERT INTO t(v) VALUES ('DIRTY-D')")
console.log('writer holding the WRITE LOCK        :', read())
db.exec('ROLLBACK')
console.log('after the writer ROLLBACK            :', read())
db.close()
console.log('writer closed, WAL checkpointed      :', read())

// the same reader against a QUIET database whose sidecars are absent
for (const s of ['-wal', '-shm']) if (existsSync(p + s)) rmSync(p + s)
console.log('quiet db, sidecars before READ_ONLY  :', sidecars())
read()
console.log('quiet db, sidecars after  READ_ONLY  :', sidecars())
EOF
node "$d/probe.mjs" "$d"
rm -rf "$d"
```

```text
writer open, 2 rows committed to WAL : 2|A,B
writer mid-transaction, UNCOMMITTED  : 2|A,B
committed to WAL, NOT checkpointed   : 3|A,B,DIRTY-C
writer holding the WRITE LOCK        : 3|A,B,DIRTY-C
after the writer ROLLBACK            : 3|A,B,DIRTY-C
writer closed, WAL checkpointed      : 3|A,B,DIRTY-C
quiet db, sidecars before READ_ONLY  : none
quiet db, sidecars after  READ_ONLY  : t.db-shm, t.db-wal
```

**WAL hazard, measured:** the ATTACHed sqlite reader sees committed-but-uncheckpointed WAL rows while the writer still holds the connection open — the third row, committed after the first read, is visible on the second read, and the post-close read agrees. The uncommitted row is **invisible**: the reader never sees a dirty or torn row, so a number read from a live ledger is a consistent snapshot as of the last commit. A held write lock does not lock the reader out — there is no `SQLITE_BUSY` and no retry loop needed.

Therefore a recipe may be run while a batch is live. The operator must still discount rows for `running` sessions: they are incomplete, and their terminal status can change under the query (Recipe B joins only `ended_at IS NOT NULL` for exactly this reason). A rate computed mid-batch is a floor over settled runs, not a final number. The attach is not filesystem-inert: it creates `-wal` and `-shm` beside a quiet database. That is harmless for a live ledger that already has those sidecars, but it is not nothing, which is why the claim above was corrected. Every recipe still attaches `READ_ONLY`; this measurement says nothing about a write.

**What remains unmeasured (#7):** this measures one writer and one reader on one machine. It does not measure a reader on another host over a network filesystem, where SQLite's WAL shared-memory index does not work at all; a writer killed mid-commit; or a writer implementation other than `node:sqlite` `DatabaseSync`, the same library the ledger uses.

### Recipe E — every escalation, where and why

`returns/task.json` is the record: `details.escalation` is a `{where, why}` struct and `details.stages[]` ends in `escalate:<where>`. The ledger now knows the typed cause and actor through `sessions.terminal_reason` / `sessions.terminal_actor`; this duckdb recipe remains the `why`-text record.

```sh
duckdb -csv -c "
select regexp_extract(filename,'\\.crew/([^/]+)/([^/]+)/returns',2) as lane,
       details.escalation.\"where\" as where_at,
       substr(details.escalation.why, 1, 160) as why
from read_json_auto('~/.crew/*/*/returns/task.json',
                    filename=true, union_by_name=true, ignore_errors=true)
where details.escalation is not null
order by lane;"

sqlite3 ledger.db "
select s.status, sum(e.n is not null) as with_escalation_phase, count(*) as total
from sessions s
left join (select adw_id, count(*) n from phases where name='escalation' group by 1) e
  using(adw_id)
where s.task_slug not in ('x','daemon80','unfenced-child','fence-scope','fence-plan','daemon-null-lane')
group by 1;"
```

Recorded output, run 2026-08-25T14:54:25Z on duckdb v1.5.5 (the first query returned 77 rows; condensed by `where`):

```text
77 escalation rows from 77 return files:
plan-check 12 · build 9 · scout 7 · plan 6 · driver 5 · gate 5 · builder 4
plan-carve 4 · planner 4 · review 4 · scope 4 · refuted-must-fix 3 · seat-refused 2
suite 2 · lead 1 · pane-parse-error 1 · rpc-command-error 1 · rpc-no-envelope 1
sensitivity-floor 1 · triage 1

Ledger side, real sessions only:
aborted|75|86
ok|0|355
running|0|13
```

The raw first query carries each `why`; the summary is only a compact reading of what it returned.

### Recipe F — mechanism or thinking?

This classifier reads escalation prose, so the mechanism share it reports is a **floor**, never exact.

```sh
duckdb -csv -c "
with t as (
  select details.escalation.\"where\" as w, details.escalation.why as why
  from read_json_auto('~/.crew/*/*/returns/task.json',
                      filename=true, union_by_name=true, ignore_errors=true)
  where details.escalation is not null),
c as (
  select *, case when regexp_matches(why,
      'no valid envelope|substrate gone|seat refused|^rpc |unusable envelope|Cannot read properties|not verified exactly once|settled with|the pane manager stopped answering|provider says')
    then 'mechanism' else 'thinking' end as klass
  from t)
select klass, w, count(*) n from c group by 1,2 order by klass, n desc;"
```

Recorded output, run 2026-08-25T14:54:32Z:

```text
mechanism 26 · thinking 51
mechanism: scout 6 · driver 5 · planner 4 · builder 4 · seat-refused 2
           build 1 · rpc-command-error 1 · pane-parse-error 1 · rpc-no-envelope 1 · lead 1
thinking: plan-check 12 · build 8 · plan 6 · gate 5 · plan-carve 4 · scope 4 · review 4
          refuted-must-fix 3 · suite 2 · triage 1 · sensitivity-floor 1 · scout 1
```

### Recipe G — does lane size predict rounds?

`details.mutations` is JSON, so use `json_array_length`, not `len`; `details.growth[1].files_in_scope_count` is the measured lane size.

```sh
duckdb -csv <<'SQL'
set lambda_syntax='ENABLE_SINGLE_ARROW';
with p as (
  select regexp_extract(filename,'\\.crew/([^/]+)/([^/]+)/returns',2) as lane,
         regexp_extract(filename,'returns/d([0-9]+)\\.',1)::int as seq,
         json_array_length(details.mutations) as muts        -- NOT len(): JSON byte length
  from read_json_auto('~/.crew/*/*/returns/*.planner.json',
                      filename=true, union_by_name=true, ignore_errors=true)
  where details.mutations is not null),
first as (select lane, min(seq) s from p group by 1),
pm as (select p.lane, p.muts from p join first on first.lane=p.lane and first.s=p.seq),
t as (
  select regexp_extract(filename,'\\.crew/([^/]+)/([^/]+)/returns',2) as lane,
         details.stages as st, details.growth as g, details.escalation as e
  from read_json_auto('~/.crew/*/*/returns/task.json',
                      filename=true, union_by_name=true, ignore_errors=true)),
m as (select pm.lane, pm.muts, t.g[1].files_in_scope_count as fis,
             len(list_filter(t.st, x -> starts_with(x,'plan:r'))) as pr,
             t.e is not null as esc
      from pm join t using(lane))
select case when fis<=4 then 'a: 1-4 files' when fis<=8 then 'b: 5-8' else 'c: 9+' end as bucket,
       count(*) lanes, round(avg(pr),2) avg_plan_rounds,
       round(100.0*sum(pr>=2)/count(*),1) pct_multiround,
       round(100.0*sum(esc::int)/count(*),1) pct_escalated
from m where fis is not null group by 1 order by 1;
SQL
```

Recorded output, run 2026-08-25T14:55:14Z:

```text
1-4 files: 108 lanes | 1.24 rounds | 13.9% multi-round | 13.0% escalated
5-8 files:  34 lanes | 1.62        | 38.2%             | 20.6%
9+ files:    9 lanes | 2.11        | 66.7%             | 44.4%

Mutation buckets, same CTE re-run:
<=5 mutations: 12 lanes | 1.25 | 16.7% |  0.0%
6-12:           96 lanes | 1.27 | 15.6% | 16.7%
13-20:          47 lanes | 1.52 | 25.5% | 38.3%
21+:             7 lanes | 1.86 | 71.4% | 14.3%

r(mutations, plan_rounds)=0.208  r(files_in_scope, plan_rounds)=0.257
r(mutations, escalated)  =0.222  r(files_in_scope, escalated)  =0.144
```

### Recipe H — what a pane lane's seats cost

Prices are dumped from `crew/roster.json` into `prices.json` with fields `price_key`, `ci`, `co`, `ccr`, and `ccw` before this query. The `DISTINCT` boot projection prevents repeated boot snapshots from multiplying a seat.

```sh
duckdb -csv <<'SQL'
with raw as (
  select regexp_extract(filename,'\\.crew/([^/]+)/([^/]+)/journal',2) as lane,
         try_cast(line as json) as j
  from read_csv('~/.crew/*/*/journal.jsonl', columns={'line':'VARCHAR'},
                delim=E'\x07', quote=E'\x01', escape=E'\x01',
                header=false, filename=true, ignore_errors=true)),
u as (select lane, json_extract_string(j,'$.role') as seat_role,
       json_extract(j,'$.parent.billed_input_tokens')::bigint bi,
       json_extract(j,'$.parent.billed_output_tokens')::bigint bo,
       json_extract(j,'$.parent.billed_cache_write_tokens')::bigint bcw,
       json_extract(j,'$.parent.billed_cache_read_tokens')::bigint bcr,
       json_extract_string(j,'$.measured') meas
      from raw where json_extract_string(j,'$.event')='pane-usage'),
b as (select lane, j from raw where json_extract_string(j,'$.event')='boot'),
bk as (select distinct lane, j, unnest(json_keys(j,'$.seats')) as k from b),
sm as (select distinct lane, k as r,
         json_extract_string(j,'$.seats.'||k||'.provider')||'/'||json_extract_string(j,'$.seats.'||k||'.id') as pk
       from bk),
p as (select * from read_json_auto('prices.json'))
select u.seat_role, count(*) n, count(distinct u.lane) lanes,
       round(sum((bi/1e6)*p.ci+(bo/1e6)*p.co+(bcr/1e6)*p.ccr+(bcw/1e6)*p.ccw),2) usd,
       round(avg((bi/1e6)*p.ci+(bo/1e6)*p.co+(bcr/1e6)*p.ccr+(bcw/1e6)*p.ccw),2) avg_usd
from u left join sm on sm.lane=u.lane and sm.r=u.seat_role
       left join p on p.price_key=sm.pk
group by 1 order by usd desc;
SQL
```

Recorded output, run 2026-08-25T14:58:20Z:

```text
86 seat records over 39 lanes; 80 priced; measured: true on 86/86
planner  | 55 | 39 | 431.76 | 8.81
reviewer | 12 |  8 |  43.54 | 3.63
lead     | 19 | 12 |  17.79 | 0.94
                         493.10 total (unrounded)
```

No `builder` row exists because only the claude agent ships a pane-usage reader (`SHIPPED_PANE_USAGE`, `crew/seat-io.mjs:1053`). A pi/codex pane builder is absent from *this* table, not unmeasured: its cost is recorded per message in its own transcript, see recipe K. Read this table as the **claude** half of a pane lane and recipe K as the pi half.

### Recipe I — headless per-seat token totals

```sh
sqlite3 -header -column ledger.db "
select a.role, a.model, count(*) n,
       sum(a.billed_input_tokens)  in_tok,  sum(a.billed_output_tokens)      out_tok,
       sum(a.billed_cache_read_tokens) cache_r, sum(a.billed_cache_write_tokens) cache_w
from agent_sessions a group by 1,2 order by n desc;"
```

Recorded output, run 2026-08-25T14:56:05Z (127 rows; all four billed columns were non-NULL in 127/127, and `context_tokens`/`context_window` were NULL in 127/127):

```text
planner    claude-opus-5               52      5308   2273504  335126109   8742529
builder    openai-codex/gpt-5.6-luna   24   5335916    494321   66615296         0
lead       claude-opus-5               18       508     91128   10247571    927068
reviewer   openai-codex/gpt-5.6-terra 18   1797111    120364   20869120         0
reviewer   claude-opus-5                7       534    243573   28944066   1050737
planner    opus                         6       908    357100   58297736   1147474
tech-lead  openai-codex/gpt-5.6-sol     2    656941     72271   14846464         0
```

Price these four token totals with the same four roster rates as recipe H. Each `agent_sessions` row is a running total, not a delta; `context_tokens`/`context_window` remain NULL by U-4.

### Recipe J — which tables production actually writes

```sh
ledger="$HOME/.dev-team/factory/ledger.db"
sqlite3 "$ledger" "select name from sqlite_master where type='table' and name<>'sqlite_sequence' order by 1;" \
| while read t; do
  if [ "$t" = sessions ]; then
    count=$(sqlite3 "$ledger" "select printf('%d real / %d total', sum(task_slug not in ('x','daemon80','unfenced-child','fence-scope','fence-plan','daemon-null-lane')), count(*)) from sessions where task_slug is not null;")
  else
    count=$(sqlite3 "$ledger" "select count(*) from \"$t\";")
  fi
  printf '%-22s %s\n' "$t" "$count"
done
```

Recorded output, run 2026-08-25T14:56:16Z:

```text
accept_decisions       9
agent_sessions         127
cell_failures          36
ci_cycles              0
ci_dispatches          0
envelopes              0
events                 8723
gate_discriminations   282
gate_results           2935
intake_brakes          5
intake_dispatches      0
intake_refusals        0
intake_sweeps          0
modifier_attempts      254
phases                 22451
processes              0
review_outcomes        347
run_links              3129
seat_reclaims          47
seat_teardowns         859
sessions               454 real / 20890 total
```

The seven empty tables are the two declared retired tables plus the five unreached writers named above; the `sessions` total carries fixtures, so its real count is the excluded 454.

### Recipe K — what a pane-seated pi seat cost, from its own transcript

pi prices itself, claude gives tokens only, and the ledger covers headless seats only. This retires `b219-ledgeranswers` finding 12, which measured `agent_sessions` and concluded a pane-seated pi/codex seat is invisible, so a per-lane cost total can only be a floor. That is true of the **ledger** and false of the **data** — every pi assistant frame carries `message.usage.cost`, already cache-split, so the pi half needs no rate table at all. It is per-lane because the transcript directory IS the lane (`~/.pi/agent/sessions/--<checkout-path-with-dashes>--/`). The window is pinned so the recorded output stays reproducible as the corpus grows; the lane filter (`%-dt-%`, `%-dev-team-wt%`) is the two crew checkout namings; and a `cell` of NULL is a costed frame whose `message` carries no `provider`/`model`, never a free one.

The command below was copied out and run unedited; these are my numbers (the brief's slice was narrower; the corpus grows).

```sh
duckdb -box <<'SQL'
create or replace view pi_cost as
select regexp_extract(filename,'sessions/--([^/]*)--/',1)                     as lane,
       regexp_extract(filename,'/([^/]*)\.jsonl$',1)                          as session,
       json_extract_string(message,'$.provider')||'/'||json_extract_string(message,'$.model') as cell,
       try_cast(json_extract_string(message,'$.usage.cost.total') as double)  as usd,
       try_cast(json_extract_string(message,'$.usage.totalTokens') as bigint) as tok
from read_json_auto('~/.pi/agent/sessions/*/*.jsonl', filename=true, union_by_name=true, ignore_errors=true)
where json_extract_string(message,'$.usage.cost.total') is not null
  and cast(timestamp as timestamptz) < '2026-08-26T00:00:00Z'
  and (regexp_extract(filename,'sessions/--([^/]*)--/',1) like '%-dt-%'
    or regexp_extract(filename,'sessions/--([^/]*)--/',1) like '%-dev-team-wt%');
.print 'corpus (unit: the whole pinned window)'
select count(distinct lane) lanes, count(distinct session) sessions, count(*) costed_msgs, round(sum(usd),2) usd from pi_cost;
.print 'per-lane (unit: one lane)'
select lane, count(distinct session) sessions, count(*) msgs, round(sum(usd),2) usd from pi_cost group by 1 order by usd desc limit 10;
.print 'per-seat-session (unit: one pi seat session)'
select lane, session, cell, count(*) msgs, sum(tok) tok, round(sum(usd),2) usd from pi_cost group by 1,2,3 order by usd desc limit 10;
SQL
```

Recorded output, run 2026-08-26T10:03:04Z:

```text
corpus (unit: the whole pinned window)
┌───────┬──────────┬─────────────┬────────┐
│ lanes │ sessions │ costed_msgs │  usd   │
├───────┼──────────┼─────────────┼────────┤
│ 282   │ 605      │ 19457       │ 536.16 │
└───────┴──────────┴─────────────┴────────┘
per-lane (unit: one lane)
┌────────────────────────────────────────────┬──────────┬──────┬───────┐
│                    lane                    │ sessions │ msgs │  usd  │
├────────────────────────────────────────────┼──────────┼──────┼───────┤
│ Users-x-Development-dt-b65-advisor         │ 2        │ 120  │ 15.55 │
│ Users-x-Development-dev-team-wt125         │ 7        │ 279  │ 13.33 │
│ Users-x-Development-dt-b106-config         │ 1        │ 50   │ 11.93 │
│ Users-x-Development-dev-team-wt85          │ 2        │ 94   │ 11.11 │
│ Users-x-Development-dt-b126-driftcheck     │ 2        │ 204  │ 10.83 │
│ Users-x-Development-dt-b31-reaper-headless │ 2        │ 74   │ 9.58  │
│ Users-x-Development-dt-b153-lab            │ 4        │ 324  │ 9.52  │
│ Users-x-Development-dt-b122-falseabsence   │ 2        │ 101  │ 9.2   │
│ Users-x-Development-dt-b108-viz            │ 1        │ 42   │ 8.5   │
│ Users-x-Development-dt-b131-vacuity        │ 1        │ 46   │ 8.07  │
└────────────────────────────────────────────┴──────────┴──────┴───────┘
per-seat-session (unit: one pi seat session)
┌────────────────────────────────────────────┬───────────────────────────────────────────────────────────────┬──────────────────────────┬──────┬──────────┬───────┐
│                    lane                    │                            session                            │           cell           │ msgs │   tok    │  usd  │
├────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────────────────────┼──────┼──────────┼───────┤
│ Users-x-Development-dt-b65-advisor         │ 2026-08-20T10-22-05-617Z_01a01eb1-3731-7746-a328-e6820a7e7a30 │ openai-codex/gpt-5.6-sol │ 119  │ 19211892 │ 15.55 │
│ Users-x-Development-dev-team-wt85          │ 2026-08-13T18-38-30-841Z_019ffc6b-2fb9-7bbb-97a0-e5503dcddafe │ openai-codex/gpt-5.6-sol │ 67   │ 10845793 │ 11.03 │
│ Users-x-Development-dt-b126-driftcheck     │ 2026-08-21T22-11-54-277Z_01a02661-6d25-7c9a-a595-12604f023295 │ openai-codex/gpt-5.6-sol │ 64   │ 10824806 │ 10.13 │
│ Users-x-Development-dt-b31-reaper-headless │ 2026-08-18T20-09-00-474Z_01a0167d-d53a-7cc2-8d62-449d9be0bd9c │ openai-codex/gpt-5.6-sol │ 73   │ 10743091 │ 9.58  │
│ Users-x-Development-dt-b122-falseabsence   │ 2026-08-21T21-19-20-226Z_01a02631-4ca2-7ecf-ad2a-ad3b7270a0cb │ openai-codex/gpt-5.6-sol │ 85   │ 11542035 │ 9.15  │
│ Users-x-Development-dt-b106-config         │ 2026-08-21T14-40-55-090Z_01a024c4-8932-7cc7-bc96-49fbbedefad3 │ NULL                     │ 8    │ 6091449  │ 8.35  │
│ Users-x-Development-dev-team-wt125         │ 2026-08-13T22-13-25-450Z_019ffd2f-f14a-7f94-aeff-67e5446303a1 │ openai-codex/gpt-5.6-sol │ 44   │ 5886451  │ 8.19  │
│ Users-x-Development-dt-b30-reaper          │ 2026-08-18T15-07-39-989Z_01a01569-f255-7d74-b1a2-be725cb966db │ openai-codex/gpt-5.6-sol │ 63   │ 8194003 │ 7.39  │
│ Users-x-Development-dt-b153-lab            │ 2026-08-22T18-47-20-819Z_01a02acc-81f3-7b1e-9a67-ddb3c609dab7 │ openai-codex/gpt-5.6-sol │ 64   │ 8683545 │ 7.25  │
│ Users-x-Development-dt-b191-knowledge      │ 2026-08-24T13-21-36-264Z_01a033ef-0008-7e9c-8c61-26ea94ab14d6 │ openai-codex/gpt-5.6-sol │ 47   │ 8108396 │ 7.07  │
└────────────────────────────────────────────┴───────────────────────────────────────────────────────────────┴──────────────────────────┴──────┴──────────┴───────┘
```

**The claude half is deliberately `left unpriced` here.** A claude transcript frame carries token counts and no cost field, so pricing it needs a rate source and a decision about which rates are authoritative — and `ledger cells` already computes `cost_usd` from `crew/roster.json` rates under `CELL_PRICE_UNITS` (`scripts/factory/ledger.mjs:321`), the OPEN CONTRADICTION (#626) recorded above. Recipe H prices claude pane seats from that same roster. Until #626 is decided, this recipe prices only the half that prices itself rather than adding a second authority.

### Recipe L — which runs were reseated or operator-overridden?

This recipe groups effective seats by their recorded provenance so an operator can find runs with a `reseat` or `operator_override`. It counts **recorded seats only**: a run with no `run_seats` rows is unmeasured, and an older run's absent rows cannot be reconstructed from `agent_sessions`.

```sh
sqlite3 "$LEDGER_DB" <<'SQL'
SELECT source, adw_id, COUNT(*) AS recorded_seats
FROM run_seats
WHERE source IN ('reseat', 'operator_override')
GROUP BY source, adw_id
ORDER BY source, adw_id;
SQL
```

### Mechanics that bite

- **Timestamps are UTC; render them local.** The journal and every transcript frame carry `...Z`. `CAST(ts AS TIMESTAMP)` yields a **naive UTC** value that DuckDB prints unchanged, so an operator two hours ahead reads a healthy lane as two hours stale. `CAST(ts AS TIMESTAMPTZ)` converts to the session's timezone and prints the offset. Every recipe here uses `TIMESTAMPTZ`.
- **`ORDER BY` inside the window must be total.** Frames share a millisecond routinely — a claude assistant turn emits one frame per content block at the same timestamp — and `lag()` over a tied ordering picks a different predecessor per run. Measured: the same recipe B returned p90 8.4, 8.5 and 8.4 on three consecutive runs before `owes` was added as a tiebreak, and has been byte-identical since.
- **`ATTACH` does not expand `~`; `read_json_auto` does.** `ATTACH` takes a string literal and no variable, so the recipes let the shell expand `$HOME` from an unquoted heredoc. `$.role` and friends survive that expansion because `$.` is not a shell variable.
- **`role` is a reserved word.** `... AS role` parses; a bare trailing alias `... role` does not.
- **JSON lengths are not array lengths.** On a JSON-typed column, `len()` returns the JSON byte length; bucket arrays with `json_array_length` instead.
- **Journals must be read as raw text before unioning.** `read_json_auto` cannot union journals because the boot record has a different nesting shape; use `read_csv` with `delim=E'\x07'`, `quote=E'\x01'`, and `escape=E'\x01'`, then `try_cast(line as json)`.
- **`ignore_errors=true` is mandatory on a live corpus** — see recipe C — and it is the reason the skipped-line counter is mandatory too.

## Heartbeat cadence

`sessions.last_heartbeat_at` and `agent_sessions.last_heartbeat_at` are written
in place by `heartbeat()` (`scripts/factory/ledger.mjs:2886`), and the
ledger owns no timer for them (ADR-024: "the ledger owns no timer — #41 drives
the rate"). The rate has ONE owner: `LIVENESS_PROBE_MS` in `crew/seat-io.mjs`,
today **30_000 ms (30 s)** — the wait loop's probe cadence
(`crew/seat-io.mjs:1825`), stamped only from a probe that came back alive
(`crew/seat-io.mjs:1423`). So an operator can bound a death from the ledger
alone: a run whose `ended_at` is NULL and whose `last_heartbeat_at` is older
than **two periods (60 s)** has not been observed alive since that stamp.

Three caveats, so the bound is read honestly. A beat is emitted only while the
driver is INSIDE a seat wait; a driver busy in git, the gate or the suite writes
none, so a stale stamp is evidence about the DRIVER's wait loop and not about
the process's whole life. A NULL `last_heartbeat_at` is **not measured**, never
a dead run — a headless lane that never entered a pane wait carries NULL by
construction. And `processes.last_heartbeat_at` is unreachable: that table is
retired and has never held a row (see **Retired tables** above).
