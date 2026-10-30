# Task

---
source: operator decisions 2026-10-26 (lean seats retry provider failures with a bound; every turn records its usage)
closes: null
tier: build
shape: standard
acceptance: [PR1, PR2, PR3]
out_of_scope: crew/drive.mjs, crew/crew.mjs, crew/acp-io.mjs, crew/headless.mjs behaviour, crew/acp/seat.mjs, the suite stage, the old headless and pane paths
---
## The ask

Two changes to the lean seat turn in `crew/lean.mjs` (`runSeat`).

1. Provider retry. Today a refused turn (`turn.refusal`) throws, the loop records `seat-unmeasured`, and the lane
   stops. The operator decided: a provider failure is not a lane failure. When the refusal's `errorKind` is a
   rate limit or a server error (`acpProviderFailureKind` in `crew/headless.mjs`), run the same turn again in a
   fresh ACP session after a wait, inside the old path's bounds (`PROVIDER_RETRY_MAX`,
   `PROVIDER_RETRY_TOTAL_WAIT_MS`; a stated reset from `acpTextReset` is honoured). Authentication failures and
   unclassified refusals stop at once as today. Each attempt gets its own session file, so no attempt overwrites
   another's record. Reuse the existing classifier and constants; do not copy them.
2. Usage on every turn. Today the `{type: 'turn', stopReason, usage, refusal}` row is written to the session file
   only for a refused or unmeasured turn; an accepted turn loses its usage. Write that row for every turn. The
   skill-proof intactness check must still hold (the row is written by the runtime, and the proof compares what
   was relayed with the file on disk).

The invariants: a retry never runs past either bound; an auth failure is never retried; every turn's session
file ends with exactly one turn row.

## Context

- `crew/lean.mjs` `runSeat`: the session file, `guardedAppend`, the refusal branch, the intact check.
- `crew/headless.mjs` `acpProviderFailureKind`, `acpTextReset`, `PROVIDER_RETRY_MAX`,
  `PROVIDER_RETRY_TOTAL_WAIT_MS`, and `crew/acp-io.mjs` near line 298 (how the old ACP path routes the same
  refusal; read only).
- `crew/acp-client.mjs` near line 275: where `refusal.errorKind` comes from (read only).
- `crew/loop.test.mjs` and `crew/start.test.mjs`: the tests that drive `lean.mjs` today.

## Acceptance

- (PR1) a rate-limited turn is retried in a fresh session and the lane continues when the retry answers
- (PR2) an authentication-failed turn stops the lane without a retry
- (PR3) an accepted turn's session file ends with a turn row carrying its usage
