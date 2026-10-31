# Preserve ACP refusal errorMessage

## Minimal changes
- Edit only `crew/acp-client.mjs` and `crew/acp-client.test.mjs`.
- In both `prompt` and `pollPrompt`, extend the refusal literal with this conditional spread:
  `...(typeof frame.error?.data?.errorMessage === 'string' ? { errorMessage: frame.error.data.errorMessage } : {})`
- Keep code, message, errorKind, null stopReason/usage, and existing logging unchanged. Preserve strings verbatim, including empty strings; omit the property entirely for missing or non-string values.
- Keep that literal spread spelling in the built source: the declared kill mutations target it.
- No caller edits: `crew/acp/seat.mjs:420-428` returns the turn intact; `crew/lean.mjs:148-154` serializes its refusal intact. Both client branches already spread refusal into `acp_turn_refused` (`crew/acp-client.mjs:274-276,309-311`).

## Tests
- Extend the replay harness locally to inject error data into a recorded refusal response without changing recorded fixtures.
- Parameterize refusal regression tests across synchronous `prompt` and `beginPrompt`/`pollPrompt`.
- CE1: assert exact string preservation for a provider cause, an empty string, and a multiline Unicode string, in returned refusal and `acp_turn_refused` journal row (including JSON round-trip).
- CE2: assert `Object.hasOwn(..., 'errorMessage') === false` for absent data, missing property, and null/number/boolean/object values, on both returned refusal and journal row; also check after JSON round-trip.
- In both sets retain assertions for code/message/errorKind and null stopReason/usage.
- Validation lane: `node --test crew/acp-client.test.mjs`.

## Gate and mutations
- Run `node /Users/momoshell/.crew/dt-b1440-acp-client-error-message/b1440-acp-client-error-message/task/gate.mjs` from the checkout root. It imports only the checkout selected by `process.cwd()` and drives both real client prompt APIs with an in-memory wire transport.
- CE1 mutation changes the string type guard to a number guard; CE2 mutation adds an errorMessage key in the absent-value branch. Each is observable even if only one of the two identical snippets is replaced.
- Baseline must fail CE1; CE2 is an existing invariant and should already pass. The loop, not the planner, runs baseline/build/mutations/suite and delivery stages.
