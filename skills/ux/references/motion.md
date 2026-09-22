# Motion and reduced motion

- **Rule M1.** Animations honor `prefers-reduced-motion` through the CSS media query. Sources: vercel-web-interface-guidelines.md — Animation / “Honor `prefers-reduced-motion`”; ui-ux-pro-max-ux-guidelines.csv — row 9. **Exhibit:** `visualizer/web/src/lib/PhaseDots.svelte:8`.

Measured: 3 `animation:` declarations in 2 of 33 components — the pulse at `visualizer/web/src/lib/PhaseDots.svelte:8`, and two spinner declarations at `visualizer/web/src/lib/RosterPanel.svelte:692` and `visualizer/web/src/lib/RosterPanel.svelte:708`. `prefers-reduced-motion` occurs 0 times in 0 of 33 components.

**Stated gap:** 2/33 animated components ship with 0 reduced-motion queries; the M1 rule is violated until a query lands.
