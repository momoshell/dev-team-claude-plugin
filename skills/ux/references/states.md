# Loading, empty, and error states

## Adopted rules

- **Rule S1.** Loading is explicit and stable: a loading branch names what is loading and holds its place until data arrives. Sources: vercel-web-interface-guidelines.md — Typography / “Loading states end with `…`”; ui-ux-pro-max-ux-guidelines.csv — row 78. **Exhibit:** `visualizer/web/src/lib/SkillsPage.svelte:82`.
- **Rule S2.** Empty states explain the result and name a next action. Sources: vercel-web-interface-guidelines.md — Content Handling / “Handle empty states”; ui-ux-pro-max-ux-guidelines.csv — row 79. **Exhibit:** `visualizer/web/src/lib/TaskList.svelte:120`.
- **Rule S3.** Errors are visible and announced, and offer recovery. Sources: vercel-web-interface-guidelines.md — Content & Copy / “Error messages include fix/next step, not just problem”; ui-ux-pro-max-ux-guidelines.csv — row 44. **Exhibit:** `visualizer/web/src/lib/SkillsPage.svelte:22`.

## Measured branch census

A component counts as state-branched when its rendered markup before `<style>` contains a class token `empty`, or when an `{#if}` or `{:else if}` condition contains `loading`. By that predicate 10 of 27 components branch: AgentsPage.svelte, EnvelopeInspector.svelte, EventStream.svelte, LeanRunDetail.svelte, PhaseGantt.svelte, RunDetail.svelte, SkillDelivery.svelte, SkillsPage.svelte, TaskList.svelte, Trajectory.svelte.

**Stated gap:** 17/27 components show no loading or empty branch under this predicate.
