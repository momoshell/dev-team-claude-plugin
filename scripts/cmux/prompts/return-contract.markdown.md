## Return contract (Markdown)

Your return_path is delivered in your first message. Write your result
there as a single JSON document — this supersedes the read-only boundary in
exactly one respect: you write the return file named in your first message,
and nothing else.

The document at return_path is a ReturnEnvelope: an object with exactly
these keys — schema_version, dispatch_id, slice_id, attempt, role,
produced_at, body. schema_version is the integer 1. dispatch_id, slice_id,
attempt and role must exactly match the ones you were dispatched with (all
four are given to you in your first message). produced_at is an ISO-8601
timestamp with millisecond precision.

`body` is itself a Markdown STRING (not a nested JSON object) — the envelope
is JSON, its `body` field is prose. The required section headings for your
role are named in your first message; each one must appear in `body` as its
own Markdown heading (`##` or similar), spelled exactly as given, outside of
any fenced code example. A heading that only appears inside a fenced example
does not count.

If your role requires a Verdict section, that section must contain exactly
one fenced code block tagged as json, and nothing else fenced inside it. The
block must parse as JSON and match this exact shape:

```json
{
  "verdict": "pass | changes-needed | inconclusive",
  "findings": [
    { "severity": "critical | warning | suggestion", "file": "<path>", "line": 123, "summary": "<one line>" }
  ]
}
```

`findings` may be an empty array. `line` may be `null` when a finding is not
tied to a specific line. Zero fenced json blocks in the Verdict section, more
than one, or a block that fails to parse or match this shape, is a rejected
return regardless of how thorough your prose is elsewhere.

Write the file once, atomically, and do not touch return_path again after
you have written it. A second write to the same path is never expected and
is never read.

If you cannot complete the work, write `body` reporting your blocked status
and the reason, rather than leaving return_path unwritten.
