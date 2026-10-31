# Pi provider-failure classification

## Evidence
- `crew/acp/provider.mjs:33-38`: classifier maps Claude kinds and otherwise returns null.
- `crew/lean.mjs:154-167`: runSeat passes only errorKind, then uses the existing retry decision and reset parser.
- `crew/acp-client.mjs:270-276` and `crew/acp-client.mjs:305-311`: refusals already preserve string errorMessage; no client/server edit needed.
- `crew/acp/provider.test.mjs:9-14`: existing Claude mappings and unknown kinds are pinned.
- `crew/start.test.mjs:652-704`: retryRun supplies refused turns, virtual time/sleep, and fresh-session assertions.

## Minimal implementation
1. In `crew/acp/provider.mjs`, extend `acpProviderFailureKind(errorKind, errorMessage)` with an optional second argument. Preserve all existing Claude mappings. Only for `errorKind === 'pi-agent-error'`, recognize the two measured full strings by exact equality:
   - `Codex error: Our servers are currently overloaded. Please try again later.` -> `PROVIDER_FAILURE_KINDS.SERVER_ERROR` (PK1).
   - `Codex error: The usage limit has been reached` -> `PROVIDER_FAILURE_KINDS.RATE_LIMIT` (PK2).
   Unknown, missing, or non-string messages return null (PK3). Do not classify WebSocket error, generic keywords, or messages on other unknown error kinds. Use the literal declaration `export function acpProviderFailureKind(errorKind, errorMessage) {` (the PK3 mutation anchor); omitted second arguments naturally remain undefined.
2. In `crew/lean.mjs`, pass `turn?.refusal?.errorMessage` as the classifier's second argument, alongside the existing errorKind. Leave retry bounds, sleeps, reset parsing, Claude kinds, and ACP server/client unchanged.

## Tests
3. Extend `crew/acp/provider.test.mjs`: PK1/PK2 exact pi messages, PK3 unknown text (including WebSocket error), absent/null/non-string messages, recognized text with an unrelated errorKind, and existing Claude calls with/without the extra message. Check policy parity: server_error backs off; usage-limit is park but still declines without a stated reset. Do not invent a rate-limit delay.
4. Extend `crew/start.test.mjs` using retryRun: pi overload retries in a fresh session with the existing backoff and then recovers; unknown pi text never sleeps/retries; the measured usage-limit text without reset also never sleeps/retries under unchanged policy. Existing Claude retry tests must remain green.

## Validation and scope
- Builder edit scope: `crew/acp/provider.mjs`, `crew/lean.mjs`, `crew/acp/provider.test.mjs`, `crew/start.test.mjs` only.
- Validation lane: `node --test crew/acp/provider.test.mjs crew/start.test.mjs`.
- Gate: `node /Users/momoshell/.crew/dt-b1441-pi-provider-failure-kind/b1441-pi-provider-failure-kind/task/gate.mjs` (run from checkout root).
- Gate imports the cwd classifier, checks all three acceptance ids, and verifies the live lean call forwards both refusal fields. Baseline must fail PK1 and PK2. Each declared mutation targets production text retained by this implementation; no test-source or fixture-derived expected values.
- Planner does not execute baseline/build/mutations/suite/commit/rebase/PR stages; the loop owns those.
