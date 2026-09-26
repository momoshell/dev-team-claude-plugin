# Refuse flags a verb does not read

Give every CLI verb an explicit entry in `VERB_FLAGS`.
Exhibit: `scripts/factory/ledger.mjs:7743`.

Use `refuseUnknownFlags` as the one vocabulary check.
Exhibit: `scripts/factory/ledger.mjs:7778`.

A misspelling must produce a usage refusal instead of a default.
Exhibit: `scripts/factory/ledger.mjs:7786` and `test/factory-ledger-cli.test.mjs:289`.

The measured failure was `run-set --since X --untill Y` returning an unbounded
window at exit 0 (#443).
Exhibit: `scripts/factory/ledger.mjs:7786`.

Pin the refusal direction in the ledger test.
Exhibit: `test/factory-ledger-cli.test.mjs:287`.

Pin the inverse direction so accepted window flags still work.
Exhibit: `test/factory-ledger-cli.test.mjs:294`.

Pin the process-level status as `exit 2` for the emit CLI.
Exhibit: `test/factory-emit.test.mjs:1713`.

The same refusal shape is mirrored in `scripts/factory/emit.mjs:1561`.
Exhibit: `scripts/factory/emit.mjs:1561`.

Do not let an unknown option become an omitted bound or a null filter.
Exhibit: `scripts/factory/ledger.mjs:7786` and `test/factory-ledger-cli.test.mjs:287`.

An empty vocabulary means a verb accepts no flags; it is not an open parser.
Exhibit: `scripts/factory/ledger.mjs:7743`.

An unknown verb must refuse before a flag can acquire accidental meaning.
Exhibit: `scripts/factory/ledger.mjs:9264`.

If parsing is interrupted, do not resume with the default window.
Status: this interrupted-parser edge is unbacked in this checkout; see
`evidence.md`.

If a value is missing, report usage rather than reading the next option as data.
Status: this missing-value edge is unbacked in this checkout; see `evidence.md`.

Test a typo, a valid option, and the exit status as three distinct observations.
Exhibit: `test/factory-ledger-cli.test.mjs:287`, `test/factory-ledger-cli.test.mjs:294`, and `test/factory-emit.test.mjs:1713`.

The test expectation must come from the CLI contract, not from parsed output.
Exhibit: `test/factory-ledger-cli.test.mjs:287` and `test/factory-ledger-cli.test.mjs:294`.

A green happy-path test alone cannot catch the one-letter window regression.
Exhibit: `test/factory-ledger-cli.test.mjs:287`.

Keep the exhibit and the accepted vocabulary updated in one change.
Exhibit: `scripts/factory/ledger.mjs:7743` and `:3383`.

The cost of ignoring one flag was an apparently successful, unbounded report.
Exhibit: `scripts/factory/ledger.mjs:7786`.

Use this rule for each verb even when several verbs share a parser helper.
Exhibit: `scripts/factory/ledger.mjs:7743`.
