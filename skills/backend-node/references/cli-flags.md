# Refuse flags a verb does not read

Give every CLI verb an explicit flag vocabulary and refuse everything outside it.
Exhibit: `crew/start.mjs` (its `main` parses `--checkout` and nothing else).

A misspelling or an extra argument must produce a usage refusal instead of a
default. Exhibit: `main` in `crew/start.mjs` owns the vocabulary, usage and
refusal text/status, and success status. It writes the usage line and returns
exit 2 for malformed arguments, and returns 0 after a successful start.
In `crew/start.test.mjs`, `main reports usage, refusals and success as exit codes`
asserts exit 2 for no argument and two briefs, and exit 1 for a refusal; despite
its title, it does not assert success or exact usage text.
`throwing injected loggers do not change start metadata or main status` asserts
that a valid `--checkout` start returns 0.

Pin the refusal direction and the accepted direction as separate observations,
and pin usage text beside status. The surviving
`main refuses --check as usage and starts nothing` test asserts exact usage text
and exit 2 for its `--check` shapes only.

Do not let an unknown option become an omitted bound or a null filter. The cost
of ignoring one flag is an apparently successful command that did something
other than what was asked.

An empty vocabulary means a verb accepts no flags; it is not an open parser.

An unknown flag (`--loop`) must refuse before it can acquire accidental meaning.
Owner: `main` in `crew/start.mjs`; no surviving test pins `--loop` or other
unknown flags beyond the `--check` shapes above, or duplicate accepted flags.

If a value is missing, report usage rather than reading the next option as data.
Status: `main` in `crew/start.mjs` refuses a missing `--checkout` value, but
no surviving test pins that edge independently of `--check`; other verbs are
unmeasured. See `evidence.md`.

If parsing is interrupted, do not resume with a default.
Status: this interrupted-parser edge is unbacked in this checkout; see
`evidence.md`.

Keep the usage line and the accepted vocabulary updated in one change.

Use this rule for each verb even when several verbs share a parser helper.
