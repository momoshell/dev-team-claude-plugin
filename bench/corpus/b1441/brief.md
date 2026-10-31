# Task

---
source: operator request (10-30 follow-up to PRs 2068 and 2071)
closes: null
tier: build
shape: standard
acceptance: [PK1, PK2, PK3]
out_of_scope: the retry bounds and waits, claude provider kinds, the ACP server and client
---
## The ask

A pi seat's provider failure is never retried. The pi ACP server answers every errored run with
`errorKind: 'pi-agent-error'`, and `acpProviderFailureKind` maps only the claude kinds, so `runSeat`
gets kind null and throws on the first 429 or overload. Since PRs 2068 and 2071 the refusal carries
pi's `errorMessage`. Measured 2026-10-30 across `~/.pi/agent/sessions`, the commonest pi error messages
are `Codex error: Our servers are currently overloaded. Please try again later.` (47),
`WebSocket error` (16), and `Codex error: The usage limit has been reached` (5). Invariant: a pi refusal whose
message is a recognised provider failure gets the same kind, and so the same retry, as the equivalent
claude kind. Unrecognised text stays unclassified and is not retried, as today.

## Context

- `crew/acp/provider.mjs` `acpProviderFailureKind` and `PROVIDER_FAILURE_KINDS`.
- `crew/lean.mjs` `runSeat`: classifies `turn.refusal` and calls `providerRetryDecision`.
- `crew/acp-client.mjs`: the refusal shape, now with `errorMessage`.
- The tests next to `provider.mjs` and `lean.mjs` that pin the claude kinds.

## Acceptance

- (PK1) a pi refusal whose `errorMessage` is the Codex overloaded text is classified `server_error`
- (PK2) a pi refusal whose `errorMessage` is the Codex usage-limit text is classified `rate_limit`
- (PK3) a pi refusal whose `errorMessage` is unrecognised text is classified null
