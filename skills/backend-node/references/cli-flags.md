# Refuse flags a verb does not read

Give every CLI verb an explicit flag vocabulary and refuse everything outside it.
Exhibit: `crew/start.mjs` (its `main` parses `--check`, `--checkout` and `--loop`
and nothing else).

A misspelling or an extra argument must produce a usage refusal instead of a
default. Exhibit: `crew/start.mjs` writes the usage line and returns exit 2;
`crew/start.test.mjs` pins that status for no argument, two briefs, a missing
`--checkout` value, and a missing, duplicate or unknown `--loop` value.

Pin the refusal direction and the accepted direction as separate observations:
the same test file also asserts that a valid `--check --loop lean` call exits 0.

Pin the usage text and the status together.
Exhibit: `crew/start.test.mjs` captures stderr from `main` and asserts the exact
usage line beside the exit code.

Do not let an unknown option become an omitted bound or a null filter. The cost
of ignoring one flag is an apparently successful command that did something
other than what was asked.

An empty vocabulary means a verb accepts no flags; it is not an open parser.

An unknown value for a closed flag (`--loop old`) must refuse before it can
acquire accidental meaning. Exhibit: `crew/start.test.mjs` (`(SW3)`).

If a value is missing, report usage rather than reading the next option as data.
Status: the missing-value edge is backed for `--checkout` and `--loop` only; any
other verb is unbacked, see `evidence.md`.

If parsing is interrupted, do not resume with a default.
Status: this interrupted-parser edge is unbacked in this checkout; see
`evidence.md`.

Keep the usage line and the accepted vocabulary updated in one change.

Use this rule for each verb even when several verbs share a parser helper.
