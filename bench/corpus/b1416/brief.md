# Task
<!-- crew:bound-issue #2037 -->

---
source: issue 2037
closes: 2037
tier: build
shape: standard
acceptance: [RB1, RB2, RB3]
out_of_scope: crew/finish.mjs's decision rules, crew/checks.mjs's runners, the visualizer, skills and docs
---
## The ask

The lean loop runs the gate, mutation proof and suite on the lane's commit, then fetches and rebases onto the base and
publishes the rebased head (`crew/loop.mjs`: suite around line 363, fetch and rebase around line 427). A
conflict-free rebase can still change behaviour, so the published tree may be one no check ran on. Make the published
head a tree the gate and suite last passed on: when the rebase moves the branch, rerun the gate and the suite on the
rebased tree before publishing (and before writing `finish-ready` in a finish run). A rebase that moves nothing needs
no rerun.

Invariants:
- A red gate or suite after the rebase stops the lane with that stage's reason; nothing is published.
- A rebase that leaves the head unchanged costs no extra suite run.

## Context

- `crew/loop.mjs`: the stages after review (suite, commit, fetch, rebase, finish report, publish).
- `crew/checks.mjs` `rebaseBranch` (returns the new head) and `runSuite`, `runGate`.
- `crew/loop.test.mjs` `fakes()` and the existing rebase and publish tests.

## Acceptance

- (RB1) a run whose rebase moves the head runs the suite again on the rebased head before it publishes.
- (RB2) a run whose suite is red after a rebase that moved the head stops without publishing.
- (RB3) a run whose rebase leaves the head unchanged runs the suite once.
