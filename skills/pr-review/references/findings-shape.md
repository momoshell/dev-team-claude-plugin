The findings definition is `crew/pi/agents/scout.json`, and the pin that holds
this document to that definition is `skills/pr-review/findings-shape.test.mjs`.
The shape below restates the definition for readers; its enum bar is deliberate
and means this illustrative block is not valid JSON.

```json
{
  "summary": "<one sentence answering the question>",
  "findings": [
    {
      "claim": "<one specific fact>",
      "evidence": ["<file:line>", "..."],
      "confidence": "verified" | "assumed"
    }
  ],
  "gaps": ["<anything you could not establish>"]
}
```

`crew/pi/agents/scout.json` is the definition and this file is its reader-facing
restatement. The pinning check compares both against a literal it holds itself,
so neither side can move to match the other without a deliberate edit to the
check. If the check goes red, read both sources, decide which side is right, and
change the check last.

The reviewer envelope's finding is a different object — `{id, severity,
location, summary, disposition, patch}` — declared in the reviewer's `## Envelope
details fields` section. Never fill one shape with the other's keys. The scout
shape is for one narrow, cited answer; the reviewer shape is the optional finding
entry in a review envelope.

The disposition set is exactly: `auto-fix` · `ask-user` · `no-op`

- `auto-fix` is mechanically safe and intent-neutral. A `patch` rides with
  `auto-fix` only; the driver applies that unified diff with no seat, and refuses
  it when its whole write surface is unreadable or outside `files_in_scope`.
- `ask-user` touches behaviour or scope. It goes to the lead as a closed decision
  on either verdict; unresolved findings escalate as `review-unresolved`.
- `no-op` is informational: it changes nothing and demands nothing.

The `disposition` field is optional in this release and required from the next;
until then a finding without it is handled exactly as it is today. A `pass` may
not carry a `must-fix`: the driver refuses that envelope by shape and re-asks it.
Only an accepted finding can authorize a mechanical apply; malformed entries are
dropped and their patch bytes never execute.

A finding `id` must match `^[A-Za-z0-9_-]{1,64}$` because the driver turns it into
a patch artifact filename. An id outside that set is refused rather than
rewritten or truncated.

When filling this shape, `evidence` is a `file:line` that you actually read.
`verified` means you read that location this round. `assumed` means the claim was
inferred, and the finding must say what it was inferred from. `gaps` is where the
honest “could not establish” goes instead of an unmarked finding. Every finding
requires `claim`, `evidence`, and `confidence`; **`confidence` is not optional**.
The object must carry the literals **"verified" | "assumed"** and **No other keys are permitted** anywhere in it.
