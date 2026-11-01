# Task

---
source: operator request 2026-10-29 (the pre-return consult sees too little of the diff to review it)
closes: null
tier: build
shape: standard
acceptance: [PW1, PW2, PW3, PW4]
out_of_scope: the diff-growth and cadence consults' window; the advisor's model cells; the reply contract's keys; the visualizer
---
## The ask

The advisor's pre-return consult (PR 2053, fixed in PR 2055) reviews the builder's work before the return file is
written. It sees the same small window as the mid-build hints: at most `DELTA_ENTRIES` (12) entries of
`DELTA_ENTRY_CAP_BYTES` (512) each, about 12 lines per file, from `gitDiffLines`' `EXCERPT_LINES`. None of the must-fix
findings reviewers raised on the 2026-10-29 replays fits in that window, so the consult cannot find them.

Give the pre-return consult its own, larger view:
1. The whole working diff against HEAD, untracked files included, bounded by a byte budget of about 48 KB. Hunks
   stay grounded as `path:line:` entries so the reply's evidence can cite them, and removed lines stay grounded at
   their old path and line.
2. The brief's acceptance items, so the consult can check the change against what was asked.

When the diff is over the budget, the consult sees what fits and is told which files were left out. It is never
silently cut. The diff-growth and cadence consults keep today's small window.

Invariants:
- The reply contract and the journal rows do not change, except that the consult row records the window it was
  given (bytes, entries, and files left out).
- A pre-return consult still stays inside `TIER1_MAX_CONSULTS`, and a failed one still lets the return through.

## Context

- `crew/pi/extensions/advisor.ts`: `gitDiffLines`, `EXCERPT_LINES`, `DELTA_ENTRIES`, `DELTA_ENTRY_CAP_BYTES`,
  `entryFromText`, `appendDelta`, `preReturnVerdict`, `consult`, the prompt builders and `REPLY_CONTRACT`.
- The advisor reads its lane context through `loadContext` and the advisor manifest that `crew/acp/seat.mjs`
  `laneContext` writes; the brief text reaches `laneContext` as `briefText`.
- Tests to read first: `crew/pi/extensions/advisor.test.mjs` (the diff-growth and pre-return triggers).

## Acceptance

- (PW1) a pre-return consult's prompt carries a change on line 200 of a file
- (PW2) a pre-return consult's prompt carries the brief's acceptance items
- (PW3) a pre-return consult over the byte budget names the files it left out
- (PW4) a diff-growth consult's delta stays within the existing entry and byte caps
