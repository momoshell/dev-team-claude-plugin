# Absence and null-with-reason

A null carrying a closed reason is rendered as one honest phrase, never as zero and never as an unexplained dash. Operational unavailability (a feed that failed) is not a null measurement (a value never recorded); do not conflate the two.

- **Rule A1.** Render a null carrying a closed reason as `Unmeasured — <reason>`; never render it as zero and never as a bare dash. Sources: vercel-web-interface-guidelines.md — Content Handling / “Handle empty states”; ui-ux-pro-max-ux-guidelines.csv — row 79. **Exhibit:** `visualizer/web/src/lib/agents.js:209`. Counted surface: the four spellings below span 30 of 38 components.

## Measured vocabulary register

Case-insensitive literal census over the 39 `.svelte` files directly under the visualizer lib directory:

| spelling | occurrences | files |
|---|---|---|
| `—` | 61 | 15 |
| `unavailable` | 51 | 16 |
| `unmeasured` | 2 | 2 |
| `not measured` | 19 | 6 |

`—` files: AcceptPanel.svelte, EnvelopeInspector.svelte, EventStory.svelte, GateChips.svelte, LeanRunDetail.svelte, MetricsStrip.svelte, PhaseDots.svelte, PhaseGantt.svelte, PhasePanel.svelte, PlanSteps.svelte, ReviewPanel.svelte, RunCard.svelte, RunDetail.svelte, TaskList.svelte, Trajectory.svelte.

`unavailable` files: AcceptPanel.svelte, AgentsPage.svelte, EnvelopeInspector.svelte, EventStream.svelte, GateChips.svelte, MetricsStrip.svelte, PhaseDots.svelte, PhaseGantt.svelte, PhasePanel.svelte, PlanSteps.svelte, ReviewPanel.svelte, RunDetail.svelte, SkillRules.svelte, SkillsPage.svelte, TaskList.svelte, Trajectory.svelte.

`unmeasured` files: SkillDelivery.svelte, TaskList.svelte.

`not measured` files: FleetTable.svelte, LeanRunDetail.svelte, MetricsStrip.svelte, PhasePanel.svelte, RunDetail.svelte, TaskList.svelte.

One exact line per spelling: `—` at `visualizer/web/src/lib/RunCard.svelte:53`; `unavailable` at `visualizer/web/src/lib/PhaseDots.svelte:6`; `unmeasured` at `visualizer/web/src/lib/SkillDelivery.svelte:32`; `not measured` at `visualizer/web/src/lib/RunDetail.svelte:322`. Supporting exhibits: a closed reason at `visualizer/web/src/lib/agents.js:209`.

**Stated gap:** 4 spellings across 21/27 components share no single vocabulary; the canonical phrase `Unmeasured — <reason>` appears literally in 0/27 components; components using shared copy helpers are outside this literal census.

PlanSteps routes closed reasons through reason-copy.js plain sentences, with the slug kept in the title attribute.
