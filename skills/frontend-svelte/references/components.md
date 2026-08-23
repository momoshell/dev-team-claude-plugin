# Component idioms

These are measured conventions in `visualizer/web/src/` rather than general Svelte advice; reproduce the rune census with `grep` over that directory. Retrieve any API fact from the `svelte` MCP as required by `references/routing.md`.

## Props are one destructuring line

Declare props with one destructuring `$props()` line and put defaults there:

- `let { run, taskEnvelope = null, onopen = () => {} } = $props()` — `visualizer/web/src/lib/RunCard.svelte:8`.
- `let { rows = [], onopen = () => {} } = $props()` — `visualizer/web/src/lib/FleetTable.svelte:2`.
- `let { run, phase = null, returns = {}, events = [] } = $props()` — `visualizer/web/src/lib/PhasePanel.svelte:3`.

Keep callbacks as props named `on<verb>` (`onopen`, `onback`, `onphase`, `onselectphase`) rather than adding an event-dispatching seam. `visualizer/web/src/lib/PhaseGantt.svelte:5` uses `onselectphase`; `visualizer/web/src/App.svelte:135` passes `onback` to `RunDetail`. Defaults make the component's call shape visible at its boundary.

## Two-way state is explicit

`visualizer/web/src/lib/Filters.svelte:2` is the one measured `$bindable(` use: `filters` and `viewFilters` are bindable props, while `hiddenLine` is an ordinary defaulted prop. Use that exact local idiom when the parent and child intentionally share writable filter state; do not make every prop bindable.

## Snippets and rendering

The census found `{#snippet` 9 times and `{@render` 27 times in 5 components. `visualizer/web/src/lib/PhasePanel.svelte:19–32` defines `runs` and `markdown` snippets and renders them; `visualizer/web/src/lib/AcceptPanel.svelte:10–23` does the same for evidence blocks. Keep a snippet's input shape local and render it at the call site rather than duplicating markdown markup.

## Events and bindings

Use native `onclick=` attributes: the census found 16 across 10 components and zero `on:click` uses. Exhibits include `visualizer/web/src/App.svelte:130`, `visualizer/web/src/lib/RunCard.svelte:52–56`, and `visualizer/web/src/lib/PhasePanel.svelte:53`. Existing form bindings are `bind:value` and `bind:checked`, with the filter state declared at `Filters.svelte:2`; follow the existing spelling and route uncertain binding semantics to the MCP.

## Runes census and effects

The measured source contains `$state(` 53 times in 12 files, `$derived` 40 times in 16 files, `$props()` 14 times in 14 files, `$effect` 15 times in 10 files, and `$bindable(` once in `Filters.svelte:2`. The visualizer has no legacy `export let` or `$:`: `test/visualizer-shape.test.mjs:750–751` checks those strings across every `.svelte` file.

A correct effect has a dependency and a cleanup boundary. `visualizer/web/src/lib/RunCard.svelte:18–20` carries the `state_referenced_locally` comment: `previousRunning` is left undefined until the effect's first pass so a true running-to-finished transition can trigger the final drain. Treat that comment's shape—local previous value, guarded work, returned cleanup—as the repo's measured effect idiom, not as a generic API tutorial.

## Scoped styles

Component styles are scoped by default. Reserve `:global` for descendants produced by markdown rendering, where the compiler cannot see the generated elements: `.evidence :global(p)` appears at `visualizer/web/src/lib/AcceptPanel.svelte:36` and `visualizer/web/src/lib/PhasePanel.svelte:62`. The `:global(*)` and `:global(body)` reset copies in `visualizer/web/src/App.svelte:187–188` are recorded duplication, not a pattern for ordinary component selectors. The repo has zero `{@html}` uses in the measured component suite.

## Composition over cross-cutting colour

`RunCard.svelte:53–54` composes `PhaseDots`, `GateChips`, and `RoleTag`; `RoleTag.svelte:4` and `PhaseDots.svelte:5` own role/lane colour indirection. Keep a component's props and CSS local, and route token choice through the measured shapers and child components rather than reading data status directly.
