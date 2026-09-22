# Keyboard operability and visible focus

- **Rule K1.** Prefer native controls; any custom behavior must be keyboard-operable. Sources: vercel-web-interface-guidelines.md — Accessibility / “Interactive elements need keyboard handlers”; ui-ux-pro-max-ux-guidelines.csv — row 41. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:50` with the native-button attachment at `visualizer/web/src/lib/Dropdown.svelte:83`.
- **Rule K2.** Every interactive control carries a visible focus treatment using `:focus-visible`. Sources: vercel-web-interface-guidelines.md — Focus States / “Use :focus-visible over :focus”; ui-ux-pro-max-ux-guidelines.csv — row 28. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:101`.

## Measured operability register

Literal census over the 33 `.svelte` files directly under the visualizer lib directory:

| signal | occurrences | files |
|---|---|---|
| legacy `on:keydown` attributes | 0 | 0 |
| modern `onkeydown=` attributes | 3 | 2 |
| `:focus-visible` selectors | 4 | 3 |
| plain `:focus` selectors | 3 | 1 |
| `tabindex` attributes | 1 | 1 |
| `aria-` attributes | 124 | 28 |
| `role=` attributes | 20 | 9 |

The remaining modern handlers live at `visualizer/web/src/lib/RosterPanel.svelte:414` and `visualizer/web/src/lib/RosterPanel.svelte:675`; the plain-`:focus` treatment and the single `tabindex` live at `visualizer/web/src/lib/RosterPanel.svelte:708` (the other two plain-`:focus` selectors sit on line 711) and `visualizer/web/src/lib/RosterPanel.svelte:675`. The other `:focus-visible` treatments are at `visualizer/web/src/lib/MetricsStrip.svelte:51` and `visualizer/web/src/lib/PhaseGantt.svelte:258`.

**Stated gap:** modern handlers cover 2/33 components and visible focus covers 3/33 components; that narrow coverage is recorded as-is, not as proof that all 33 components need handlers.
