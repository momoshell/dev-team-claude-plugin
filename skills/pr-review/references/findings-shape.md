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

The reviewer envelope's finding is a different object —
`{id, severity, location, summary}` at `crew/roles/reviewer.md:37-42` and
optional at `crew/roles/reviewer.md:49`. Never fill one shape with the other's
keys. The scout shape is for one narrow, cited answer; the reviewer shape is the
optional finding entry in a review envelope.

When filling this shape, `evidence` is a `file:line` that you actually read.
`verified` means you read that location this round. `assumed` means the claim was
inferred, and the finding must say what it was inferred from. `gaps` is where the
honest “could not establish” goes instead of an unmarked finding. Every finding
requires `claim`, `evidence`, and `confidence`; **`confidence` is not optional**.
The object must carry the literals **"verified" | "assumed"** and **No other keys are permitted** anywhere in it.
