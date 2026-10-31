# Task

---
source: operator request (memory arm check, 2026-10-31)
closes: null
tier: build
shape: standard
acceptance: [LM1, LM2, LM3]
out_of_scope: the memory backend and its verbs, memory proposals from seats, the store's content and the bench
---
## The ask

The lean runtime refuses a seat whose effective definition declares `memory: true` (`grant-unsupported`), so the
memory arm cannot be measured. The old runtime injected team memory for planner and lead seats:
`openMemory({ dir }).context({ task, role })`, rendered with `renderSection`. Invariant: a lean seat whose effective
definition declares `memory: true` boots with the rendered team-memory section in its assignment prompt. The section
comes from the lane checkout's `.claude/dev-team/memory`, or from `CREW_MEMORY_DIR` when that is set. When no
section can be rendered (no dir, no index, empty), the seat still boots without one, and the lane journal records
why. A seat that does not declare memory is unchanged.

## Context

- `crew/lean.mjs`: the `memory: true` refusal and where the seat prompt is built.
- `crew/memory.mjs`: `openMemory`, `renderSection`; `crew/memory-md.mjs` `context` returns `reason` when empty.
- `crew/start.test.mjs`: the two memory refusal tests from commit 7060ccca, which this change replaces.

## Acceptance

- (LM1) a lean planner declaring `memory: true` with a store holding `MEMORY.md` and one linked entry gets a prompt containing `## Team memory` and the entry text
- (LM2) a lean planner declaring `memory: true` with no store boots, its prompt has no team-memory section, and the lane journal records the empty reason
- (LM3) a lean planner not declaring memory gets no team-memory section even when a store exists
