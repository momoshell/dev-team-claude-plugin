# Accessibility checklist

Adapted from the "Before you finish" table of the better-accessibility skill in https://github.com/jakubkrehel/skills at revision 4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63 under its MIT licence (see THIRD-PARTY-NOTICES.md); every row was rewritten against this visualizer and rows with no matching construct were dropped with their measured reason below.

| Pattern | Here | Fix |
|---|---|---|
| Removing the focus outline without leaving a visible replacement | `visualizer/web/src/lib/theme.css` | Keep the replacement that already ships, the global focus-visible ring in `visualizer/web/src/lib/theme.css`, and never remove an outline without one — see keyboard-focus.md |
| Click handling on an element that is not a native button | `visualizer/web/src/lib/TaskList.svelte` | Use a native button so the control stays keyboard operable with a visible focus treatment — see keyboard-focus.md |
| Tablist semantics with no arrow-key handling | `visualizer/web/src/lib/AgentsPage.svelte` `visualizer/web/src/lib/TaskList.svelte` | Add arrow-key movement between tabs or drop the tab roles; the listbox in `visualizer/web/src/lib/Dropdown.svelte` already handles keys and is the pattern to follow — see keyboard-focus.md |
| Live region whose text mounts inside a conditional | `visualizer/web/src/lib/TaskList.svelte` `visualizer/web/src/lib/PlanSteps.svelte` | Keep status text in a persistent region and keep errors visible and announced — see states.md |
| Accessible name that omits the visible label | `visualizer/web/src/lib/Pagination.svelte` | Match the accessible name to the visible label and keep the visible focus treatment — see keyboard-focus.md |
| Hidden ancestor wrapped around a focusable control | `visualizer/web/src/App.svelte` `visualizer/web/src/lib/PhasePanel.svelte` | The hidden marks here are decorative spans beside text; never place a hidden ancestor over a focusable subtree — see keyboard-focus.md |
| Sticky header with no offset for anchored or focused targets | `visualizer/web/src/App.svelte` | Focused content can slide under the sticky topbar, so account for the offset when moving focus — see keyboard-focus.md |
| Tooltip as the only label on a control that can be disabled | `visualizer/web/src/lib/Pagination.svelte` `visualizer/web/src/lib/FleetTable.svelte` | Title tooltips are unavailable on several disabled controls and readers, so keep a visible or programmatically associated label — see keyboard-focus.md |

## Dropped rows

- Positive tabindex value — dropped: the tree carries only minus-one tabindex values for programmatic focus (the app shell and two headings) and no positive value; its former exhibit was the removed RosterPanel.
- Submit button disabled while the form is invalid — dropped: the pages that carried it (AssurancePage and WorkflowsPage) were removed and no remaining form disables its submit button while invalid.
- Drag interaction with no single-pointer alternative — dropped: the seat-assignment drag surface lived in the removed RosterPanel and no drag interaction remains.
- Assertive live region on success output — dropped: remeasured the component tree and no assertive live region exists; every live region is polite or carries a status role.
- Image without alternative text — dropped: the component tree renders no image element, so there is no image to label.
- Viewport rule disabling pinch zoom — dropped: the viewport in `visualizer/web/index.html` sets width and initial scale only, with no maximum-scale rule and no user-scalable rule.
