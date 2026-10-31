---
name: code-less
description: Use when a change could be smaller, before adding a helper, branch, flag or file. A ladder and worked examples for choosing the smallest complete change.
compatibility: Granted to lean builder and reviewer seats, whose charters instruct them to read it.
---

Reach for the codebase's accepted shapes before inventing one.

## The ladder (before any new code)

Lazy means efficient, not careless. Trace the code the task touches end to end
FIRST — the ladder shortens the solution, never the reading. Then stop at the
first rung that holds:

1. Does this need to exist at all? Speculative need: skip it, say so in one line.
2. Already in this codebase? Reuse the helper, util or pattern that lives here.
3. Stdlib does it? Use it.
4. An installed dependency does it? Use it. Never add one for a few lines.
5. Can it be one line? One line.
6. Only then: the minimum code that works.

Bug fix = root cause, not symptom: grep every caller, fix the shared function
once. No abstraction with one implementation, no config for a value that never
changes, no scaffolding for later. Deletion over addition; fewest files;
shortest working diff — once the problem is understood.

Code you move or merge keeps its error handling and validation.

## Examples

- Standard library: replace a shell-built `git add` command with `execFileSync('git', ['add', '--', ...toAdd])` (`crew/checks.mjs` runs commands as `spawn(command, args)`, never a shell string).
- Closed enum: replace an open stage string with `Object.freeze([...])` as `CHECK_REASONS` does (`crew/checks.mjs`).
- Existing helper: replace a reimplemented temporary-directory cleanup fixture with `scratchDir(...)` (`test/helpers.mjs`).
- Honest absence: replace an invented candidate count of zero with `usage: null` and no usage key (`crew/pi/extensions/subagent.ts`).

When two standard-library options are the same size, choose the edge-case-correct one.
A rate is never reported without its denominator; a guard is never claimed without its kill-mutation.

A deliberate ceiling is a comment line, not a silence: `// lean: global lock; per-account locks if throughput matters`. The marker is the whole comment line — never trailing on code or inside a multiline literal — and `;` separates ceiling from upgrade path, so a ceiling may contain commas. Nothing harvests these markers; the next reader and the reviewer are the audience, so state the upgrade path.

Lazy code without its check is unfinished: leave ONE runnable check per non-trivial change — the smallest thing that fails if the logic breaks. Trivial one-liners need none.

Derived from ponytail by Dietrich Gebert (MIT); adapted to this repo's seats, doctrine and marker name.
