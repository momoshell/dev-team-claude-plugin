# Motion and reduced motion

**Rule M1:** Honor `prefers-reduced-motion` for animation and transitions. Sources: vercel-web-interface-guidelines.md — Animation / “Honor `prefers-reduced-motion`”; ui-ux-pro-max-ux-guidelines.csv — row 9.

Live reduced-motion handling: `visualizer/web/src/lib/theme.css` uses `@media (prefers-reduced-motion:reduce)` to disable animations and transitions and set `scroll-behavior:auto` for all elements and their pseudo-elements.

The global override sets animation and transition to none with `!important`, including `::before` and `::after`; automatic scroll behavior is also important. Independently, `visualizer/web/src/App.svelte` chooses auto rather than smooth scrolling in `focusActivity` when the preference matches. These are source observations, not rendered browser evidence. Keep new motion compatible with this preference.
