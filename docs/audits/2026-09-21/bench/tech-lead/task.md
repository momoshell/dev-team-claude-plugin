# Tech-lead adjudication work item

Work from the repository root and produce one machine-readable adjudication file. Do not edit tracked files, create commits, contact an endpoint, or run a model-evaluation bench.

## Material under adjudication

The proposal adds `lib/retry.mjs` with the numbered implementation below. Its contract states that attempt 0 waits `baseMs`, each later attempt waits double the previous attempt, and the attempt count is a nonnegative safe integer. Adjudicate each alleged finding against that contract alone.

1. `export async function retry(operation, { baseMs, attempts }) {`
2. `  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new RangeError('attempts must be a nonnegative safe integer');`
3. `  for (let attempt = 0; attempt <= attempts; attempt++) {`
4. `    const delay = baseMs * (2 ** (attempt - 1));`
5. `    await sleep(delay);`
6. `    try { return await operation(); } catch (error) { if (attempt === attempts) throw error; }`
7. `  }`
8. `}`

Two review findings are alleged against this implementation:

- T1 alleges that line 4 is off by one for zero-based attempts: at attempt 0 the exponent `attempt - 1` yields half of `baseMs` instead of `baseMs`, so the early waits do not match the contract.
- T2 alleges that fractional attempt counts must be accepted: it claims rejecting non-integer attempts is wrong, although the contract explicitly requires a nonnegative safe integer.

Uphold an allegation when the contract supports it; dismiss it when the contract contradicts it.

## Deliverable

Write only .bench-out/tech-lead-adjudication.json.

The file must be a closed JSON object with exactly the keys `schema`, `decision`, and `dispositions`. Its shape is described only by the field/type tables below; no example values are given, so fill every value from your own adjudication.

| field | type |
|---|---|
| schema | integer, always 1 |
| decision | string |
| dispositions | array of disposition objects |

decision: one of `approved` or `changes-required`

Each disposition object has exactly the keys `finding_id`, `disposition`, and `rationale`:

| field | type |
|---|---|
| finding_id | string; the alleged finding under adjudication (T1, then T2) |
| disposition | string; one of `uphold` or `dismiss` |
| rationale | string; one nonblank line grounding the call in the contract |

Cover every alleged finding exactly once. Use `changes-required` when any finding is upheld; use `approved` only when every finding is dismissed. The output file is the only authorized write; leave all source bytes unchanged.
