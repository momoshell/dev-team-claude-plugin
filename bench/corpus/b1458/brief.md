# Task

---
source: operator request (Momo, 2026-10-31: prose audit — visualizer skills cite deleted components)
closes: null
tier: build
shape: standard
acceptance: [VS1, VS2, VS3]
out_of_scope: the visualizer code itself; other skills
---
## The ask

`skills/frontend-svelte`, `skills/ui-design` and `skills/ux` call themselves this checkout's measured
boundary, but most of their exhibits and counts come from components deleted on 2026-10-31 (RunDetail,
RunCard, FleetTable, PhaseGantt, PhasePanel, PlanSteps, EventStream, PhaseDots, RoleTag, GateChips,
AcceptPanel, Filters, MarkdownView, EnvelopeInspector and lib/trace.js, drain.js, envelope-diff.js and others).
`visualizer/web/src` now has 11 `.svelte` files (App plus 10 in lib), not 27 or 39.

Re-measure each rule against the live tree. Keep a rule whose live exhibit exists and re-point it (live
candidates: `LeanRunDetail.svelte`, `LeanWaterfall.svelte`, `TaskList.svelte`, `App.svelte`,
`AgentsPage.svelte`, `SkillsPage.svelte`, `SkillDelivery.svelte`, `Dropdown.svelte`, `Pagination.svelte`,
`theme.css`, `fleet.js`, `agents.js`). A rule with no live exhibit says so plainly ("no live exhibit") rather
than citing a deleted file; a finding about deleted code (the hex-leak inventory, PhaseDots motion) is removed.
Recount every census number you keep.

Invariant: these skills cite no file that does not exist and state no count main contradicts.

## Context

- `skills/ux/SKILL.md` says "39 visualizer components"; its references say 27. `skills/ux/references/motion.md`'s
  only animation exhibit is gone, and `theme.css` has the global `prefers-reduced-motion` rule.
- `skills/frontend-svelte/references/structure.md` lists deleted plain modules and old line ranges.
- `skills/ui-design/references/state-colour.md` is exhibited almost entirely on deleted components.
- Prefer citing a path and symbol over a line number (`skills/qa-test-writing/references/citations.md`).

## Acceptance

- (VS1) no file under `skills/frontend-svelte`, `skills/ui-design` or `skills/ux` cites a visualizer file that does not exist
- (VS2) every count of visualizer components those skills state equals the number of `.svelte` files under `visualizer/web/src`
- (VS3) the ux motion rule describes the reduced-motion handling in `theme.css` as the live state
