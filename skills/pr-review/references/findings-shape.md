The findings definition is the scout agent, `scout.json` under `crew/pi/agents/`, and the pin that holds
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

The scout agent definition (`scout.json` under `crew/pi/agents/`) is the definition and this file is its reader-facing
restatement. The pinning check compares both against a literal it holds itself,
so neither side can move to match the other without a deliberate edit to the
check. If the check goes red, read both sources, decide which side is right, and
change the check last.

The reviewer envelope's finding is a different object — `{id, severity,
location, summary, disposition, patch}` — declared in the reviewer definition
(`crew/agents/reviewer.md`) and enforced by `crew/protocols.mjs`. Never fill one shape with the other's keys. The scout
shape is for one narrow, cited answer; the reviewer shape is the optional finding
entry in a review envelope.

A complexity finding (over-building) has no field of its own: the reviewer finding is closed to the keys above. Open the `summary` with one tag, then name what to cut and its replacement: `delete` (dead code, unused flexibility), `stdlib` (a hand-rolled thing the standard library ships), `native` (a dependency for what the platform does), `yagni` (one implementation, one caller, config nobody sets) or `shrink` (same logic, fewer lines). Every such finding names a concrete replacement, never only a complaint. Scope is complexity only; correctness, security and performance go through the normal findings.
Close the summary of the review with the total removable code as `net: -N lines possible`.

The disposition set is exactly: `auto-fix` · `ask-user` · `no-op`

- `auto-fix` is mechanically safe and intent-neutral. A `patch` rides with
  `auto-fix` only and is forbidden on every other disposition.
- `ask-user` touches behaviour or scope. It is the lead's decision, not the
  builder's.
- `no-op` is informational: it changes nothing and demands nothing.

The `disposition` field is optional. A `pass` may
not carry a `must-fix`: the envelope validator refuses that shape.

A finding `id` must match `^[A-Za-z0-9_-]{1,64}$` so it is safe as a file name.
An id outside that set is refused rather than rewritten or truncated.

When filling this shape, `evidence` is a `file:line` that you actually read.
`verified` means you read that location this round. `assumed` means the claim was
inferred, and the finding must say what it was inferred from. `gaps` is where the
honest “could not establish” goes instead of an unmarked finding. Every finding
requires `claim`, `evidence`, and `confidence`; **`confidence` is not optional**.
The object must carry the literals **"verified" | "assumed"** and **No other keys are permitted** anywhere in it.
