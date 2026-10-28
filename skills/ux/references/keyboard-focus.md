# Keyboard operability and visible focus

- **Rule K1.** Prefer native controls; any custom behavior must be keyboard-operable. Sources: vercel-web-interface-guidelines.md — Accessibility / “Interactive elements need keyboard handlers”; ui-ux-pro-max-ux-guidelines.csv — row 41. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:50` with the native-button attachment at `visualizer/web/src/lib/Dropdown.svelte:83`.
- **Rule K2.** Every interactive control carries a visible focus treatment using `:focus-visible`. Sources: vercel-web-interface-guidelines.md — Focus States / “Use :focus-visible over :focus”; ui-ux-pro-max-ux-guidelines.csv — row 28. **Exhibit:** `visualizer/web/src/lib/Dropdown.svelte:101`.

## Measured operability register

Literal census over the 39 `.svelte` files directly under the visualizer lib directory:

| signal | occurrences | files |
|---|---|---|
| legacy `on:keydown` attributes | 0 | 0 |
| modern `onkeydown=` attributes | 1 | 1 |
| `:focus-visible` selectors | 8 | 3 |
| plain `:focus` selectors | 0 | 0 |
| `tabindex` attributes | 10 | 5 |
| `aria-` attributes | 130 | 23 |
| `role=` attributes | 50 | 12 |

The only explicit key handler belongs to Dropdown. Component focus treatment remains at `visualizer/web/src/lib/PhaseGantt.svelte:261`.

**Stated gap:** modern handlers cover 1/27 components and visible focus covers 3/27 components; that narrow coverage is recorded as-is, not as proof that all 27 components need handlers.

The shared theme sheet supplies focus outlines for native controls across the application. This component-only census does not measure that global coverage.
