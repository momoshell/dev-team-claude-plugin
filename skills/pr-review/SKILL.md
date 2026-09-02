---
name: pr-review
description: >-
  Governs reviewing a change for correctness, contract drift, vacuity and scope,
  the typed findings shape, and divergence. Load it when reviewing a pull
  request or change and deciding findings, grades, or reviewer posture.
---

# Pull-request review

This skill is **measured, not asserted**: every ordering rule cites its exhibit
from the b152 register, and rules without an exhibit are listed as such in
`references/evidence.md`. The plugin skill is the knowledge layer; the existing
`.agents/skills/review-procedure` skill is the procedure layer and remains the
place that runs the review flow.

## Routing

| Doing… | Read | Rule |
|---|---|---|
| Choosing what to attack and how to grade it | `references/rubric.md` | Four axes, ordered by measured yield |
| Recording a typed scout finding | `references/findings-shape.md` | Keep the scout contract pinned |
| Resolving two verdicts on one line | `references/divergence.md` | Treat disagreement as signal |
| Selecting reviewer posture by tier | `references/posture.md` | Scale the panel without pretending it runs |
| Sizing a claim or naming an evidence gap | `references/evidence.md` | Keep denominators and unbacked rules visible |

## Critical rules

- State a finding as *state → wrong observable* in one sentence, or grade it a
  consider; this is the measured distinction in F10 and F11.
- The gate is a floor and review is the filter, not a second opinion (F6, F19).
- **Two reviewers disagreeing on the same line is itself a finding**; record
  both positions and resolve it using `references/divergence.md`.
- Never report a rate without its denominator. A measured yield is a claim about
  the corpus and its denominator, not a free-floating percentage.
- The reviewer envelope's finding object is at `crew/roles/reviewer.md:41-48` and
  it is `{id, severity, disposition, patch, location, summary}` — not the
  four-field shape the sentence claims; `findings` is optional, at
  `crew/roles/reviewer.md:55`. `confidence` appears in reviewer.md only in the
  scout/recommendation shape.

## Rubric, ordered by measured yield

| # | area | exhibit | measured |
|---|---|---|---|
| 1 | a finding written as a counterexample | F10 · F11 | 74% must-fix (95 of 129) vs 20% (25 of 125) |
| 2 | indeterminate collapsed to definite | F9 | 60% must-fix (30 of 50) |
| 3 | lifecycle and clobber | F9 | 63% must-fix (20 of 32) |
| 4 | the degradation path | F9 | 77% must-fix (10 of 13) |
| 5 | hostile CLI/API input | F9 | 57% must-fix (12 of 21) |
| 6 | rendering joined by array position | F9 | 71% must-fix (10 of 14) |
| 7 | vacuous tests / surviving mutations | F13 | 24% must-fix (11 of 46) |
| 8 | plan conformance and out-of-plan edits | F12 | 0 must-fix in 5 out-of-plan |
| 9 | stale comments, docs, charters | F12 | 0 must-fix in 23 |
| 10 | carried-forward findings | F12 | 0 must-fix in 10 |

## Key references

- `references/rubric.md` — the four review axes and their grading rules.
- `references/findings-shape.md` — the scout findings contract and its pin.
- `references/divergence.md` — divergence-as-signal and the recording example.
- `references/posture.md` — tier-scaled reviewer posture and the parked panel.
- `references/evidence.md` — corpus denominators, limits, and rules with no exhibit.
