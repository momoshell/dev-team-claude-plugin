# Plan: exact pi WebSocket transport classification

1. Change only `crew/acp/provider.mjs` and `crew/acp/provider.test.mjs`.
2. In `acpProviderFailureKind`'s existing `pi-agent-error` branch, classify exactly `WebSocket error` and whole-string `WebSocket idle timeout after <N>ms` (ASCII digits, one or more) as `PROVIDER_FAILURE_KINDS.SERVER_ERROR`. Guard timeout matching against non-string inputs; reject prefixes, suffixes, whitespace and final newlines.
3. Preserve the existing Codex matches, all other provider kinds, and null fallback. Do not change retry bounds/waits, ACP server/client, or `crew/lean.mjs`.
4. The direct caller already forwards `refusal.errorKind` and `refusal.errorMessage` to this classifier, then passes its result to `providerRetryDecision` (`crew/lean.mjs:165-180`); no caller edit is needed.
5. Remove `WebSocket error` from the existing test's unclassified-message fixtures. Keep its Codex and non-string regression assertions.
6. Add a top-level WS1 test: exact WebSocket error and idle timeouts (1, 300000, 600000) classify server_error and yield retry=true/action=backoff. Include exact-match near misses, malformed timeout numbers, newline suffixes, and non-pi kinds remaining null.
7. Add a top-level WS2 test: `Operation aborted`, `terminated`, and `WebSocket closed 1000` remain null and do not retry. Include `// MUTATION:` comments in the WS1/WS2 tests naming the corresponding kills below.

## Gate and mutation contract

- Gate imports the public module only from `process.cwd()` and checks the real two-argument classifier and retry decision; it prints one FAIL line per failing acceptance id.
- WS1 kill: in `crew/acp/provider.mjs`, replace the unique new `errorMessage === 'WebSocket error'` with `errorMessage === 'WebSocket error (disabled)'`. Keep that literal predicate in the implementation so the post-build mutation binds.
- WS2 kill: replace the unique existing `if (errorKind === 'pi-agent-error') {` with that same opening followed by `if (errorMessage === 'Operation aborted') return PROVIDER_FAILURE_KINDS.SERVER_ERROR`. This forces the intentional-stop fixture to retry.
- Acceptance ids are exactly WS1 and WS2. Idle-timeout and exactness cases supplement WS1; deliberate-stop cases supplement WS2.

## Validation delegated to the loop

- Lane: `node --test crew/acp/provider.test.mjs`.
- Gate: `node /Users/momoshell/.crew/dt-b1451-pi-websocket-error-retry/b1451-pi-websocket-error-retry/task/gate.mjs` (run with checkout cwd).
- Expected unchanged-tree result: WS1 fails because WebSocket transport errors currently return null; WS2 passes. Planner has not executed loop stages; the loop must verify baseline red, built green, and each mutation killed before the suite/commit/rebase/PR.
