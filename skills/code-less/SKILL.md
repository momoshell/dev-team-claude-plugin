---
name: code-less
description: Use when a change could be smaller, before adding a helper, branch, flag or file. A ladder and worked examples for choosing the smallest complete change.
compatibility: Granted to lean builder and reviewer seats, whose charters instruct them to read it.
---

Reach for the codebase's accepted shapes before inventing one.

## The ladder (before any new code)

Read the task and the code it touches. List where the change must reach: callers,
tests, fixtures, config and exports. Check what it could break for users, including
data destroyed or exposed. Then stop at the first rung that holds:

1. Does this need to exist at all? Speculative need: skip it, say so in one line.
2. Already in this codebase? Reuse the helper, util or pattern that lives here.
3. Stdlib does it? Use it.
4. An installed dependency does it? Use it. Never add one for a few lines.
5. Can it be one line? One line.
6. Only then: the minimum code that works.

Bug fix = root cause, not symptom: grep every caller, fix the shared function
once. No abstraction with one implementation, no config for a value that never
changes, no scaffolding for later. Deletion over addition; shortest working diff
once the problem is understood. Keep the codebase's structure and conventions;
do not re-wrap or re-indent lines you did not change.

Code you move or merge keeps its error handling and validation. Never cut
trust-boundary validation, data-loss handling, security or accessibility.

## Examples (from the dev-team repository)

- Standard library: use `execFileSync` with an argument array instead of building a shell command.
- Closed enum: replace an open stage string with `Object.freeze([...])` as `CHECK_REASONS` does (`crew/checks.mjs`).
- Existing helper: replace a reimplemented temporary-directory cleanup fixture with `scratchDir(...)` (`test/helpers.mjs`).
- Honest absence: replace an invented candidate count of zero with `usage: null` and no usage key (`crew/pi/extensions/subagent.ts`).

When two standard-library options are the same size, choose the edge-case-correct one.
A rate is never reported without its denominator.

A shortcut with a known limit gets a comment with the limit and upgrade path:
`// shortcut: global lock; per-account locks if throughput matters`.

New non-trivial logic needs one small test; trivial changes need none.
End with what was skipped or not checked and the risk.

Derived from ponytail v5 by Dietrich Gebert (MIT); adapted to this repo's seats.
