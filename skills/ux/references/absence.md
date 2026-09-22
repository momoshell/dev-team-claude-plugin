# Absence and null-with-reason

A null carrying a closed reason is rendered as one honest phrase, never as zero and never as an unexplained dash. Operational unavailability (a feed that failed) is not a null measurement (a value never recorded); do not conflate the two.

- **Rule A1.** Render a null carrying a closed reason as `Unmeasured — <reason>`; never render it as zero and never as a bare dash. Sources: vercel-web-interface-guidelines.md — Content Handling / “Handle empty states”; ui-ux-pro-max-ux-guidelines.csv — row 79. **Exhibit:** `visualizer/web/src/lib/AgentsPage.svelte:85`. Counted surface: the four spellings below span 27 of 33 components.

## Measured vocabulary register

Case-insensitive literal census over the 33 `.svelte` files directly under the visualizer lib directory:

| spelling | occurrences | files |
|---|---|---|
| `—` | 132 | 23 |
| `unavailable` | 93 | 23 |
| `unmeasured` | 35 | 10 |
| `not measured` | 14 | 7 |

`—` files: AcceptPanel.svelte, AgentsPage.svelte, AssurancePage.svelte, CellHealthPanel.svelte, EnvelopeInspector.svelte, EventStory.svelte, GateChips.svelte, IntakePanel.svelte, MetricsStrip.svelte, OperationsOverview.svelte, PhaseDots.svelte, PhaseGantt.svelte, PhasePanel.svelte, PromptsPage.svelte, ReviewPanel.svelte, RosterPanel.svelte, RunCard.svelte, RunDetail.svelte, RunSetPanel.svelte, SkillsPage.svelte, TaskList.svelte, TeardownPanel.svelte, Trajectory.svelte.

`unavailable` files: AcceptPanel.svelte, AgentsPage.svelte, AssurancePage.svelte, CellHealthPanel.svelte, EnvelopeInspector.svelte, EventStream.svelte, GateChips.svelte, IntakePanel.svelte, MetricsStrip.svelte, OperationsOverview.svelte, PhaseDots.svelte, PhaseGantt.svelte, PhasePanel.svelte, PromptsPage.svelte, ReviewPanel.svelte, RosterPanel.svelte, RunDetail.svelte, RunSetPanel.svelte, TaskList.svelte, TeardownPanel.svelte, Trajectory.svelte, WorkflowGraph.svelte, WorkflowsPage.svelte.

`unmeasured` files: AgentsPage.svelte, AssurancePage.svelte, IntakePanel.svelte, MetricsStrip.svelte, PromptsPage.svelte, RosterPanel.svelte, RunSetPanel.svelte, SkillsPage.svelte, WorkflowGraph.svelte, WorkflowsPage.svelte.

`not measured` files: FleetTable.svelte, OperationsOverview.svelte, PhasePanel.svelte, RosterPanel.svelte, RunDetail.svelte, TaskList.svelte, TeardownPanel.svelte.

One exact line per spelling: `—` at `visualizer/web/src/lib/RunCard.svelte:54`; `unavailable` at `visualizer/web/src/lib/PhaseDots.svelte:6`; `unmeasured` at `visualizer/web/src/lib/AgentsPage.svelte:85`; `not measured` at `visualizer/web/src/lib/RunDetail.svelte:172`. Supporting exhibits: a closed reason at `visualizer/web/src/lib/PromptsPage.svelte:52`, and the explicit null-not-zero statement at `visualizer/web/src/lib/RosterPanel.svelte:585`.

**Stated gap:** 4 spellings across 27/33 components share no single vocabulary; the canonical phrase `Unmeasured — <reason>` appears in 3/33 components (AgentsPage.svelte, PromptsPage.svelte, SkillsPage.svelte).
