# Absence and null-with-reason

A null carrying a closed reason is rendered as one honest phrase, never as zero and never as an unexplained dash. Operational unavailability (a feed that failed) is not a null measurement (a value never recorded); do not conflate the two.

- **Rule A1.** Render a null carrying a closed reason as `Unmeasured — <reason>`; never render it as zero and never as a bare dash. Sources: vercel-web-interface-guidelines.md — Content Handling / “Handle empty states”; ui-ux-pro-max-ux-guidelines.csv — row 79. **Exhibit:** `visualizer/web/src/lib/agents.js:209`. Counted surface: the four spellings below span 30 of 38 components.

## Measured vocabulary register

Case-insensitive literal census over the 39 `.svelte` files directly under the visualizer lib directory:

| spelling | occurrences | files |
|---|---|---|
| `—` | 94 | 21 |
| `unavailable` | 90 | 26 |
| `unmeasured` | 14 | 7 |
| `not measured` | 23 | 8 |

`—` files: AcceptPanel.svelte, CellHealthPanel.svelte, EnvelopeInspector.svelte, EventStory.svelte, GateChips.svelte, IntakePanel.svelte, LeanRunDetail.svelte, MetricsStrip.svelte, OperationsOverview.svelte, PhaseDots.svelte, PhaseGantt.svelte, PhasePanel.svelte, PlanSteps.svelte, ReviewPanel.svelte, RosterPanel.svelte, RunCard.svelte, RunDetail.svelte, RunSetPanel.svelte, TaskList.svelte, TeardownPanel.svelte, Trajectory.svelte.

`unavailable` files: AcceptPanel.svelte, AgentsPage.svelte, AssurancePage.svelte, CellHealthPanel.svelte, EnvelopeInspector.svelte, EventStream.svelte, GateChips.svelte, IntakePanel.svelte, MetricsStrip.svelte, OperationsOverview.svelte, PhaseDots.svelte, PhaseGantt.svelte, PhasePanel.svelte, PlanSteps.svelte, PromptsPage.svelte, ReviewPanel.svelte, RosterPanel.svelte, RunDetail.svelte, RunSetPanel.svelte, SkillRules.svelte, SkillsPage.svelte, TaskList.svelte, TeardownPanel.svelte, Trajectory.svelte, WorkflowGraph.svelte, WorkflowsPage.svelte.

`unmeasured` files: CellHealthPanel.svelte, IntakePanel.svelte, OperationsOverview.svelte, RosterPanel.svelte, RunSetPanel.svelte, SkillDelivery.svelte, WorkflowGraph.svelte.

`not measured` files: FleetTable.svelte, LeanRunDetail.svelte, MetricsStrip.svelte, PhasePanel.svelte, RosterPanel.svelte, RunDetail.svelte, TaskList.svelte, TeardownPanel.svelte.

One exact line per spelling: `—` at `visualizer/web/src/lib/RunCard.svelte:54`; `unavailable` at `visualizer/web/src/lib/PhaseDots.svelte:6`; `unmeasured` at `visualizer/web/src/lib/OperationsOverview.svelte:64`; `not measured` at `visualizer/web/src/lib/RunDetail.svelte:322`. Supporting exhibits: a closed reason at `visualizer/web/src/lib/agents.js:209`, and the explicit null-not-zero statement at `visualizer/web/src/lib/RosterPanel.svelte:656`.

**Stated gap:** 4 spellings across 31/39 components share no single vocabulary; the canonical phrase `Unmeasured — <reason>` appears literally in 0/39 components; components using shared copy helpers are outside this literal census.

PlanSteps routes closed reasons through reason-copy.js plain sentences, with the slug kept in the title attribute.
