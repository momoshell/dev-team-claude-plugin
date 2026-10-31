# Task

---
source: operator request (2026-10-30 observation)
closes: null
tier: build
shape: standard
acceptance: [SE1, SE2]
out_of_scope: the lane spawn itself, the lean loop and the other crew verbs
---
## The ask

`node crew/start.mjs <brief> --loop lean | head -1` starts the lane and then crashes. Once `head` exits, the
remaining start lines hit a closed pipe, `process.stdout.write` emits `EPIPE`, and the unhandled `'error'` event kills
the process with a Node stack trace (observed 2026-10-30, at `crew/start.mjs` `log` via `startLane`). The lane is
already running, so the crash only misreports it. The doctrine says instrumentation never throws into its caller.
Invariant: once the lane has started, failing to print a start line never crashes `crew start` or changes its exit
status. A refusal before the start still exits nonzero, as today.

## Context

- `crew/start.mjs`: `log` in the default deps, `startLane`, and `main`.
- `crew/start.test.mjs`: the start tests and their deps seam.

## Acceptance

- (SE1) `crew start` whose stdout is a pipe closed by its reader after the first line exits 0 with the lane started and no stack trace on stderr
- (SE2) `crew start --check` on an invalid brief still exits nonzero when stdout is closed
