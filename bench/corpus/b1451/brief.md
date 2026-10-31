# Task

---
source: operator request (Momo approved retrying pi WebSocket errors, 2026-10-31)
closes: null
tier: build
shape: standard
acceptance: [WS1, WS2]
out_of_scope: the retry bounds and waits, claude provider kinds, the ACP server and client
---
## The ask

PR 2072 made pi refusals with the Codex overloaded and usage-limit texts retryable. The second most common pi error
is still never retried. Measured 2026-10-30 over `~/.pi/agent/sessions`:
- `WebSocket error` (16)
- `terminated` (8)
- `Operation aborted` (5)
- `WebSocket closed 1000` (3)
- `WebSocket idle timeout after 300000ms` (2)
- `Codex SSE response headers timed out after 300000ms` (2)

The operator chose to retry the WebSocket transport failures. Invariant: a pi refusal whose `errorMessage` is
exactly `WebSocket error`, or `WebSocket idle timeout after <N>ms`, is classified `server_error`, so it gets the
bounded retry. Texts that can also mean a deliberate stop (`Operation aborted`, `terminated`, `WebSocket closed 1000`)
stay unclassified. Matching stays exact, as in PR 2072.

## Context

- `crew/acp/provider.mjs` `acpProviderFailureKind`: the two exact Codex texts from PR 2072.
- `crew/acp/provider.test.mjs`: the pi classification tests to extend.

## Acceptance

- (WS1) a pi refusal whose `errorMessage` is `WebSocket error` is classified `server_error`
- (WS2) a pi refusal whose `errorMessage` is `Operation aborted` is classified null
