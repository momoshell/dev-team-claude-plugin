# Liveness and evidence

`crew.mjs status` answers **alive**, never busy. It reports the crew and
workspace from `seatLiveness`; `paneAlive` answers only whether cmux still
lists the surface. Neither instrument says that a seat is making progress.

Classify an **idle-alive** versus **busy-alive** seat from recent rows in
`journal.jsonl`, then corroborate a surprising result with the pane and the
seat's return. The journal's `at` field has two measured shapes: rows written
by `crew.mjs` carry an ISO string, while driver `io.log({at: io.now()})` rows
carry epoch milliseconds. A recency script that accepts only ISO silently
skips the driver rows that move during a build; parse both ISO and epoch.

The roll-up is also lossy. `returns/task.json`'s
`details.envelope.fields` records only **WHICH FIELDS** an envelope carried,
not the values or records inside those fields. To read scout findings or a
planner's mutation declaration, open the seat's own
`returns/d1.planner.json` (or the corresponding per-seat return), then inspect
`details.findings` or `details.mutations` there.

## Seat re-asks

`SEAT_RETRY_EVENTS` emits the two retry rows `seat-timeout-reask` and
`seat-abort-reask` (`seat-io.mjs`). `REASK_MAX = 1` is one shared grace per
assignment, spent by the timeout re-ask, the abort re-ask and the unusable-envelope
re-ask alike. The refusal says it verbatim: "the bound is 1 per assignment, shared across causes".

## Two instruments, one verdict

Use status for alive, the cmux surface for pane presence, and journal recency
for activity. If one instrument lies or a measurement is surprising, re-derive
it **a second way** before killing, reassigning, or tearing down a seat. An
unreadable journal, missing return, unknown timestamp, or interrupted probe is
unknown—not proof of idle, death, or failure. For the instrument cases behind
surprising readings, continue with [`references/instruments.md`](instruments.md).

## A lane grep cannot measure a pi seat

A `claude` seat carries its lane in argv; a `pi` seat is a bare `pi` with no lane in argv. A lane-grep therefore finds zero pi seats by construction, and those seats are the builder and the reviewer. On the measured 2026-08-26 incident, an operator read the empty grep as “the builder is gone” and reported a lost builder while it had been writing code for two hours.

Read the evidence in this order:

1. The seat's transcript home: `~/.claude/projects/<checkout with / as ->` for claude, or `~/.pi/agent/sessions/-<checkout with / as ->--` for pi. The newest `*.jsonl` mtime advances while the seat works.
2. The worktree's own newest file mtime.
3. `crew-watch <lane>`, which prints one `seat=… agent=… home=… transcript=…` line per seat across both homes (`scripts/factory/crew-watch.mjs:121`).

Both homes are keyed on the checkout, not the role, so a lane's two pi seats share one home and read the same age. A home with no readable transcript reads `unknown`, never dead.

## Transcript growth is the liveness signal

The reliable signals are ordered: **transcript mtime** first, then the pane's
**token counters compared across two readings**, then **the spinner, which is worthless**. In particular, a spinner and an elapsed timer are not evidence of life:
surface can remain present while a seat has stopped mid-turn. The threshold and
classifier are implemented at `crew/seat-io.mjs:103`; when a wait expires, the
driver names the state as `the seat is STALE:`, `the seat REFUSED:`, or `the seat
is WORKING:`. A `seat-stale` row in `journal.jsonl` is the in-flight warning
that arrives before the budget does. A stale reading names a state; it does not
kill a seat (#567 owns the action).

The historical Claude mid-turn sample is `n=124,783, recorded as a snapshot`; `docs/ledger-queries.md` line 183 records that qualifier rather than a reproducible constant. The reproducible pi validation is `n=52,833 with 37 gaps over 900s`, attributed to #590.

## Exception: a provider retry loop

A provider retry loop is the exception the transcript mtime cannot see: the pane is authoritative for the current retry banner, and `crew-watch` reports `status=retrying` rather than treating the frozen transcript as a stalled seat (#659). This does not repeal the ordering above for seat death; it names the one live provider state that has no transcript frame.

The fact leaves the pane only through the seat's `seat-retrying` / `seat-retry-cleared` journal rows, so a headless lane cannot show this state and keeps reading `active`.

A `seat-stale` condition is retired only by measured growth or a completing envelope; a budget that expired measured nothing.

The `recogniseProviderRetry` reader is implemented at `crew/seat-io.mjs:1686`.
