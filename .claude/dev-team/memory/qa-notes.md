# QA notes — dev-team-claude-plugin

Domain-local notes for test strategy and quality gates. Format: **YYYY-MM-DD** — note. *Why:* reason. [deprecated — supersedes: <prior entry>]

## Entries

- **2026-08-01** — Full suite: `test/*.mjs` via `node --test`, 87 tests, runs in <1s. Coverage areas: `schema.test.mjs` (handover-spec/coder-return JSON schemas), `spec-lint.test.mjs` (spec-lint tool), `workflow.test.mjs` (team-build workflow dependency/routing logic), `trello.test.mjs` (credential handling, subcommand arity, no-leak guarantees), `task-cost.test.mjs`, `agents.test.mjs`, `commands.test.mjs`. *Why:* gives qa-lead a map of what's already covered vs. what a new task would need new tests for. Source: `test/` directory + timed run at onboarding.
- **2026-08-01** — Contract files (`handover-spec.schema.json`, `coder-return.schema.json`) are the highest-value place to add tests when they change — `schema.test.mjs` already asserts their shape. *Why:* these are the spec contract between leads and coders; a silent break there breaks every downstream handoff, not just one task.
