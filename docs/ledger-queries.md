# Ledger queries

The factory ledger is the register for run facts. When a session asks what happened, use the query that answers that question; **prose that restates run facts is the thing being retired**.

## Question → command

| Question | Command |
| --- | --- |
| What happened in this run? | `node scripts/factory/ledger.mjs task <adw_id\|task_slug>` — prints the resolved run session, phase rows, gate generations (attempts, green and pristine-run counts, latest gate timestamp, and per-generation discrimination), structured review outcomes, token usage, and `absent` markers. The unit is one run; usage is token counts across its agent sessions. |
| Which runs exist? | `node scripts/factory/ledger.mjs sessions` — prints the session rows, one row per run, including task slug, status, timestamps, and the session-level token and cost columns. The unit is one run. |
| What phases did a run go through? | `node scripts/factory/ledger.mjs phases <adw_id>` — prints phase rows ordered by sequence, with the phase name, status, and start/end timestamps. The unit is one phase. |
| What events did a run emit? | `node scripts/factory/ledger.mjs tail <adw_id> [--after n] [--limit n]` — prints ordered event rows and their bounded payloads; `--after` is an exclusive event-row cursor and `--limit` is the page size. The unit is one event. |
| What processes did a run spawn? | `node scripts/factory/ledger.mjs procs <adw_id>` — prints process rows with dispatch, PID, command, state, exit data, and lifecycle timestamps. The unit is one process. |
| How often does a green gate precede must-fix review findings? | `node scripts/factory/ledger.mjs gate-review-gap` — prints the numerator, denominator, rate, and per-run gate/review aggregates. The units are runs, gate runs, reviews, and must-fix findings; green means a non-pristine `gate_results` row with `ok = 1`. |
| Which tasks are eligible? | `node scripts/factory/ledger.mjs eligible-tasks` — prints the horizon, eligible count, and per-run active gate generation, review count, and proven-active flag. The unit is one run/task. |

Replace each angle-bracket argument with the run's `adw_id` or remembered `task_slug`; the optional tail flags are literal command-line options.

## Honesty rules

Run facts are answered by the queries above. A memory entry or other prose that restates those facts is the thing being retired; durable conventions, user preferences, and decision rationale remain prose.

The register's honesty rule is that no rows for an older run answer **“not measured then,” not “nothing happened.”** The `task` readout says this explicitly through its `absent` markers: a null fact with a marker is not a measured zero. This distinction applies independently to phases, gate verdict recording, gate discrimination, structured review outcomes, and usage.

Usage is tokens only and is a **sum of running totals** across the run's `agent_sessions` rows. Each row stores that agent session's running total, not a delta, so the readout sums the rows. Money is deliberately out of scope (#119); the query surface reports no cost calculation.
