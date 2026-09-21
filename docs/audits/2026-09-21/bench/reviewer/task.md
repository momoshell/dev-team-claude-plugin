# Reviewer work item

Work from the repository root and produce one machine-readable review file. Do not edit tracked files, create commits, contact an endpoint, or run a model-evaluation bench.

## Proposed change under review

The proposal adds `lib/retry.mjs` with the numbered implementation below. Its contract states that attempt 0 waits `baseMs` and each later attempt waits double the previous attempt. Read the implementation against that contract and report every genuine defect as a finding.

1. `export async function retry(operation, { baseMs, attempts }) {`
2. `  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new RangeError('attempts must be a nonnegative safe integer');`
3. `  for (let attempt = 0; attempt <= attempts; attempt++) {`
4. `    const delay = baseMs * (2 ** (attempt - 1));`
5. `    await sleep(delay);`
6. `    try { return await operation(); } catch (error) { if (attempt === attempts) throw error; }`
7. `  }`
8. `}`

## Deliverable

Write only .bench-out/reviewer-review.json.

The file must be a closed JSON object with exactly the keys `schema`, `verdict`, and `findings`. Its shape is described only by the field/type tables below; no example values are given, so fill every value from your own review.

| field | type |
|---|---|
| schema | integer, always 1 |
| verdict | string |
| findings | array of finding objects |

verdict: one of `pass` or `request-changes`

Each finding object has exactly the keys `id`, `severity`, `path`, `line`, and `message`:

| field | type |
|---|---|
| id | string; number findings sequentially starting at R1 (R1, R2, and so on) |
| severity | string; one of `major` or `minor` |
| path | string; repository-relative file path |
| line | integer; one-based line number in the numbered implementation above |
| message | string; one nonblank line describing the defect |

Mark a contract violation `major` and a non-behavioral nit `minor`. Use `request-changes` with at least one finding when the implementation violates its contract; use `pass` with an empty findings array when it does not. The output file is the only authorized write; leave all source bytes unchanged.
