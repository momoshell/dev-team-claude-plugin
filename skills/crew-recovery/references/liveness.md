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

## Two instruments, one verdict

Use status for alive, the cmux surface for pane presence, and journal recency
for activity. If one instrument lies or a measurement is surprising, re-derive
it **a second way** before killing, reassigning, or tearing down a seat. An
unreadable journal, missing return, unknown timestamp, or interrupted probe is
unknown—not proof of idle, death, or failure. For the instrument cases behind
surprising readings, continue with [`references/instruments.md`](instruments.md).
