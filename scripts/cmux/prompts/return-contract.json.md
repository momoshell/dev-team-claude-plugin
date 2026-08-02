## Return contract (JSON)

Your return_path is delivered in your first message. Write your result there
as a single JSON document — this supersedes the read-only boundary in
exactly one respect: you write the return file named in your first message,
and nothing else.

The document at return_path is a ReturnEnvelope: an object with exactly
these keys — schema_version, dispatch_id, slice_id, attempt, role,
produced_at, body. schema_version is the integer 1. dispatch_id, slice_id,
attempt and role must exactly match the ones you were dispatched with (all
four are given to you in your first message). produced_at is an ISO-8601
timestamp with millisecond precision.

`body` is an object — never an array, never a bare string — and its shape is
the structured result your role is asked to produce, described in your role
instructions and in your first message.

Write the file once, atomically, and do not touch return_path again after
you have written it. A second write to the same path is never expected and
is never read.

If you cannot complete the work, write `body` reporting your blocked status
and the reason, rather than leaving return_path unwritten.
