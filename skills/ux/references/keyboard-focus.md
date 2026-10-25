# Keyboard operability and visible focus

- **Rule K1.** Prefer native controls; any custom behavior must be keyboard-operable. Sources: vercel-web-interface-guidelines.md — Accessibility / “Interactive elements need keyboard handlers”; ui-ux-pro-max-ux-guidelines.csv — row 41. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:50` with the native-button attachment at `visualizer/web/src/lib/Dropdown.svelte:83`.
- **Rule K2.** Every interactive control carries a visible focus treatment using `:focus-visible`. Sources: vercel-web-interface-guidelines.md — Focus States / “Use :focus-visible over :focus”; ui-ux-pro-max-ux-guidelines.csv — row 28. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:101`.

## Measured operability register

Literal census over the 34 `.svelte` files directly under the visualizer lib directory:

| signal | occurrences | files |
|---|---|---|
| legacy `on:keydown` attributes | 0 | 0 |
| modern `onkeydown=` attributes | 3 | 2 |
| `:focus-visible` selectors | 4 | 3 |
| plain `:focus` selectors | 3 | 1 |
| `tabindex` attributes | 1 | 1 |
| `aria-` attributes | 129 | 29 |
| `role=` attributes | 27 | 12 |

The remaining modern handlers live at `visualizer/web/src/lib/RosterPanel.svelte:426` and `visualizer/web/src/lib/RosterPanel.svelte:684`; the plain-`:focus` treatment and the single `tabindex` live at `visualizer/web/src/lib/RosterPanel.svelte:718` (the other two plain-`:focus` selectors sit on line 711) and `visualizer/web/src/lib/RosterPanel.svelte:684`. Focus-dependent chart labels and the other component focus treatment are at `visualizer/web/src/lib/OperationsOverview.svelte:158` and `visualizer/web/src/lib/PhaseGantt.svelte:258`.

**Stated gap:** modern handlers cover 2/34 components and visible focus covers 3/34 components; that narrow coverage is recorded as-is, not as proof that all 34 components need handlers.

The shared theme sheet supplies focus outlines for native controls across the application. This component-only census does not measure that global coverage.
