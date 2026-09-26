---
name: lean-build
description: This repo's worked examples for the ladder in crew/roles/_shared.md — the rungs that recur here, each with the replacement that was accepted.
compatibility: Delivered to pi seats via `--skill` and to claude seats via the seat's session plugin dir; the ladder still reaches every seat through `_shared.md`.
---

The ladder is in your shared charter; this skill does not restate it. These are its rungs as this codebase has already climbed them — reach for the accepted shape before inventing one.

- Standard library: replace a shell-built `git add` command with `execFileSync('git', ['add', '--', ...toAdd])` (crew/seat-io.mjs:3629).
- Closed enum: replace an open stage string with `Object.freeze(['plan', 'check', 'build', ...])` (crew/variants.mjs:12-13).
- Existing helper: replace a reimplemented temporary-directory cleanup fixture with `scratchDir(...)` (test/helpers.mjs:39-42).
- Honest absence: replace an invented candidate count of zero with `candidates: null` and a closed reason (crew/headless-rpc.mjs:133).

When two standard-library options are the same size, choose the edge-case-correct one.
A rate is never reported without its denominator; a guard is never claimed without its kill-mutation.

A deliberate ceiling is a comment line, not a silence: `// lean: global lock; per-account locks if throughput matters`. The marker is the whole comment line — never trailing on code, never inside a multiline literal (the scan is line-based) — and `;` separates ceiling from upgrade path, so a ceiling may contain commas. `node scripts/factory/lean-debt.mjs` harvests every marker into a ledger and flags one with no upgrade path `no-trigger`.

Lazy code without its check is unfinished: leave ONE runnable check per non-trivial change — the smallest thing that fails if the logic breaks. Trivial one-liners need none.

Derived from ponytail by Dietrich Gebert (MIT); adapted to this repo's seats, doctrine and marker name.
