---
name: lean-build
description: Apply the implementation ladder with concrete replacement examples.
compatibility: Delivered only to pi builder and planner seats; claude seats receive nothing because adapter-claude refuses skill grants.
---

Trace the change's flow until you understand it; only then climb the ladder.
Apply the ladder before writing new code.
Every review tag requires a concrete replacement.
Review tags: `delete`, `stdlib`, `native`, `yagni`, and `shrink`.
- Standard library: replace a shell-built `git add` command with `execFileSync('git', ['add', '--', ...toAdd])` (crew/seat-io.mjs:3608).
- Closed enum: replace an open stage string with `Object.freeze(['plan', 'check', 'build', ...])` (crew/variants.mjs:12-13).
- Existing helper: replace a reimplemented temporary-directory cleanup fixture with `scratchDir(...)` (test/helpers.mjs:39-42).
- Honest absence: replace an invented candidate count of zero with `candidates: null` and a closed reason (crew/headless-rpc.mjs:129).
When two standard-library options are the same size, choose the edge-case-correct one.
Never simplify away: trust-boundary validation; data-loss error handling; security checks; anything the task explicitly requested; closed enums; honest absence with a reason; a denominator beside every rate.
