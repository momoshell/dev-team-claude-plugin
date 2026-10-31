# Task

---
source: operator request (follow-up to PR 2068)
closes: null
tier: build
shape: standard
acceptance: [CE1, CE2]
out_of_scope: the ACP server, provider-failure classification and rate-limit reset parsing
---
## The ask

PR 2068 makes the pi ACP server put pi's `errorMessage` in a refused prompt's `error.data`. The client drops
it: a refused `session/prompt` keeps only `code`, `message` and `data.errorKind`, so the cause pi gave still
never reaches the lane journal or the seat session file. Invariant: a refusal carries `data.errorMessage`
when the server sent a string there, and has no such key when it did not.

## Context

- `crew/acp-client.mjs`: both `refusal` objects built from `frame.error` (the `session/prompt` paths) and the `acp_turn_refused` log row.
- `crew/lean.mjs` `runSeat`: writes `turn.refusal` into the seat session file.
- `crew/acp-client.test.mjs`: the refusal tests to extend.

## Acceptance

- (CE1) a refused prompt whose error data has an `errorMessage` string returns a refusal carrying that string
- (CE2) a refused prompt whose error data has no `errorMessage` returns a refusal with no `errorMessage` key
