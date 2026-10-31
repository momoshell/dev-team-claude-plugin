# Task

---
source: operator request (Momo, 2026-10-31: prose audit — skills citing deleted code, and two upstream KiroCrew review rules)
closes: null
tier: build
shape: standard
acceptance: [SX1, SX2, SX3, SX4, SX5, SX6]
out_of_scope: skills/frontend-svelte, skills/ui-design, skills/ux, skills/code-less and skills/lane-brief (other lanes); crew/ code
---
## The ask

Three skills teach from deleted code, and the review rules have two upstream improvements worth taking.

- `skills/qa-test-writing` still frames work as "declaring tripwires" (ADR-052 removed tripwire lists from briefs
  and plans) and has a `directed` variant section where the orchestrator authors the gate (the planner authors
  it now). Its exhibits name deleted symbols: `guardedKill`, `MODIFIER_KINDS`, `openRun`, `foldRpcUsage`,
  `SHADOW_ABSENT`, `USAGE_ABSENT_CAUSES`, `CREW_BREAKER_THRESHOLD`, `KNOWN_FLAGS`, and its capture recipe
  describes the headless `stream.jsonl` layout. Keep the lessons; re-point exhibits to live code
  (`proveMutations`, `runGate`, `CHECK_REASONS` in `crew/checks.mjs`; `usage: null` in
  `crew/pi/extensions/subagent.ts`; lean session files `task/lean/<role>/<id>.jsonl`, see `crew/show.mjs`) or
  say "no live exhibit".
- `skills/backend-node/references/*.md` cite about 40 line numbers that have drifted. Cite path plus symbol or
  test name instead.
- `skills/pr-review/references/falsification.md` points to a recipe `sol-reviews-hand-written-diffs` that
  exists nowhere in the repo.
- From kirodotdev/KiroCrew `.github/review-prompts/` at 4a03632 (MIT/Apache attribution already in
  `THIRD-PARTY-NOTICES.md`): add an impact floor to `falsification.md` — a finding's outcome must reach a user,
  an operator, data or a security boundary; a preference, wording or style point is not a finding. And in its
  rulings section: a variant that a recorded ruling's rationale already covers is not reported. Keep this repo's
  must-fix / should-fix / consider scale; do not copy upstream's PASS/BLOCK collapse.

Invariant: every symbol or path these skills offer as an exhibit exists on main.

## Context

- `skills/qa-test-writing/SKILL.md` and `references/` (vacuity, captures, absence, affordances, gates, tripwires).
- `skills/backend-node/references/` (erasable-ts, evidence, usage-records, import-firewall).
- `test/` may pin some of this prose; keep pins passing or update them with the text.

## Acceptance

- (SX1) `skills/qa-test-writing` asks no seat to declare tripwires and describes no orchestrator-authored gate
- (SX2) no deleted symbol listed in the ask appears in `skills/qa-test-writing`
- (SX3) `skills/backend-node` cites no `path:line` location
- (SX4) `skills/pr-review` cites no recipe or file that does not exist in the repo
- (SX5) `falsification.md` states the impact floor for findings
- (SX6) `falsification.md` says a variant covered by a recorded ruling is not reported
