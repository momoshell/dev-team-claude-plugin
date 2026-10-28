# Motion and reduced motion

- **Rule M1.** Animations honor `prefers-reduced-motion` through the CSS media query. Sources: vercel-web-interface-guidelines.md — Animation / “Honor `prefers-reduced-motion`”; ui-ux-pro-max-ux-guidelines.csv — row 9. **Exhibit:** `visualizer/web/src/lib/PhaseDots.svelte:8`.

Measured: 1 `animation:` declaration in 1 of 27 components — the pulse at `visualizer/web/src/lib/PhaseDots.svelte:8`. `prefers-reduced-motion` occurs 0 times in 0 of 27 components.

**Stated gap:** the component-only census contains 0 reduced-motion queries and cannot alone establish application coverage. The shared query now covers the 1/27 animated components.

The component-only census excludes the shared theme sheet, which now disables animations and transitions for reduced motion, and the App shell, which uses immediate scrolling for that preference.
