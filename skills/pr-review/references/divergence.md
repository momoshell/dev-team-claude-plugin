Divergence is a signal, not a tie to be broken. When two reviewers land on the
same line with different verdicts, the disagreement is **itself** a finding.
First re-read the line. Then decide whether the reviewers are answering
different questions — conformance versus correctness, the two questions the
charter separates at `crew/roles/reviewer.md:18-24`. Record both positions even
when one eventually wins the re-read.

## Recording a divergence

Record a divergence as a finding whose evidence names both cited positions. The
confidence is `assumed` when the disagreement is inferred from two reports; it
becomes `verified` only after one side is re-read against the built tree.

```json
{
  "summary": "two reviewers disagree on crew/drive.mjs:2407",
  "findings": [
    {
      "claim": "reviewer A reads the scope diff as exhaustive; reviewer B cites a path the matcher lets through",
      "evidence": ["crew/drive.mjs:1704", "crew/drive.mjs:2407"],
      "confidence": "assumed"
    }
  ],
  "gaps": ["neither side re-ran the diff against the built tree"]
}
```

Nothing in the corpus records two reviewers on one line. Attribution is present
on **64 of 274** review rows and only from 2026-08-20 (F26); the only
re-adjudication record is `accept_decisions` with **8 rows** (F24). Therefore
this rule is design, not measurement, and it is listed as such in
`references/evidence.md`.
