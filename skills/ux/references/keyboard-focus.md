# Keyboard operability and visible focus

- **Rule K1.** Prefer native controls; any custom behavior must be keyboard-operable. Sources: vercel-web-interface-guidelines.md — Accessibility / “Interactive elements need keyboard handlers”; ui-ux-pro-max-ux-guidelines.csv — row 41. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:50` with the native-button attachment at `visualizer/web/src/lib/Dropdown.svelte:83`.
- **Rule K2.** Every interactive control carries a visible focus treatment using `:focus-visible`. Sources: vercel-web-interface-guidelines.md — Focus States / “Use :focus-visible over :focus”; ui-ux-pro-max-ux-guidelines.csv — row 28. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:101`.

## Measured operability register

Literal census over the 39 `.svelte` files directly under the visualizer lib directory:

| signal | occurrences | files |
|---|---|---|
| legacy `on:keydown` attributes | 0 | 0 |
| modern `onkeydown=` attributes | 1 | 1 |
| `:focus-visible` selectors | 32 | 9 |
| plain `:focus` selectors | 5 | 2 |
| `tabindex` attributes | 22 | 11 |
| `aria-` attributes | 241 | 34 |
| `role=` attributes | 91 | 19 |

Roster editing uses a native modal dialog, opened by `visualizer/web/src/lib/RosterPanel.svelte:243` and labelled at `visualizer/web/src/lib/RosterPanel.svelte:737`. The browser supplies Escape, focus containment and an inert background; the action restores trigger focus. The remaining explicit key handler belongs to Dropdown. Focus-dependent chart labels and component focus treatment remain at `visualizer/web/src/lib/OperationsOverview.svelte:158` and `visualizer/web/src/lib/PhaseGantt.svelte:261`.

**Stated gap:** modern handlers cover 1/39 components and visible focus covers 8/39 components; that narrow coverage is recorded as-is, not as proof that all 39 components need handlers.

The shared theme sheet supplies focus outlines for native controls across the application. This component-only census does not measure that global coverage.
