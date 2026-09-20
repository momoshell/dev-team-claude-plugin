# Component idioms

These are measured conventions in `visualizer/web/src/` rather than general Svelte advice; reproduce the rune census with `grep` over that directory. Retrieve any API fact from the `svelte` MCP as required by `references/routing.md`.

## Props are one destructuring line

Declare props with one destructuring `$props()` line and put defaults there:

- `let { run, taskEnvelope = null, onopen = () => {} } = $props()` — `visualizer/web/src/lib/RunCard.svelte:8`.
- `let { rows = [], onopen = () => {} } = $props()` — `visualizer/web/src/lib/FleetTable.svelte:2`.
- `let { run, phase = null, returns = {}, events = [] } = $props()` — `visualizer/web/src/lib/PhasePanel.svelte:5`.

Keep callbacks as props named `on<verb>` (`onopen`, `onback`, `onphase`, `onselectphase`) rather than adding an event-dispatching seam. `visualizer/web/src/lib/PhaseGantt.svelte:8` uses `onselectphase`; `visualizer/web/src/App.svelte:179` passes `onback` to `RunDetail`. Defaults make the component's call shape visible at its boundary.

## Two-way state is explicit

`$bindable(` occurs 5 times in 3 files (measured over visualizer/web/src/**/*.svelte, 34 files); `visualizer/web/src/lib/Filters.svelte:4` exhibits the idiom: `filters` and `viewFilters` are bindable props, while `hiddenLine` is an ordinary defaulted prop. Use that exact local idiom when the parent and child intentionally share writable filter state; do not make every prop bindable.

## Snippets and rendering

The census found `{#snippet` 3 times in 3 files and `{@render` 19 times in 3 files (measured over visualizer/web/src/**/*.svelte, 34 files). `visualizer/web/src/lib/PhasePanel.svelte:54-83` defines the `countMark` snippet and renders it; `visualizer/web/src/lib/AcceptPanel.svelte:16` renders evidence blocks through `MarkdownView`. Keep a snippet's input shape local and render it at the call site rather than duplicating markdown markup.

## Events and bindings

Use native `onclick=` attributes: the census found 70 across 19 files and zero `on:click` uses (measured over visualizer/web/src/**/*.svelte, 34 files). Exhibits include `visualizer/web/src/App.svelte:161`, `visualizer/web/src/lib/RunCard.svelte:56`, and `visualizer/web/src/lib/EventStream.svelte:44`. Existing form bindings are `bind:value` and `bind:checked`, with the filter state declared at `visualizer/web/src/lib/Filters.svelte:4`; follow the existing spelling and route uncertain binding semantics to the MCP.

## Runes census and effects

The measured source (visualizer/web/src/**/*.svelte, 34 files) contains `$state(` 142 times in 22 files, `$derived` 171 times in 29 files, `$props()` 25 times in 25 files, `$effect` 31 times in 19 files, and `$bindable(` 5 times in 3 files, exhibited at `visualizer/web/src/lib/Filters.svelte:4`. The visualizer has no legacy `export let` or `$:`: `test/visualizer-shape.test.mjs:973-975` checks those strings across every `.svelte` file.

A correct effect has a dependency and a cleanup boundary. `visualizer/web/src/lib/RunCard.svelte:20-22` carries the `state_referenced_locally` comment: `previousRunning` is left undefined until the effect's first pass so a true running-to-finished transition can trigger the final drain. Treat that comment's shape—local previous value, guarded work, returned cleanup—as the repo's measured effect idiom, not as a generic API tutorial.

## Scoped styles

Component styles are scoped by default. Reserve `:global` for descendants produced by markdown rendering, where the compiler cannot see the generated elements: `.evidence :global(.markdown-document)` appears at `visualizer/web/src/lib/AcceptPanel.svelte:23` and `visualizer/web/src/lib/PhasePanel.svelte:100`. The `:global(*)` reset copy in `visualizer/web/src/App.svelte:233` is recorded duplication, not a pattern for ordinary component selectors. The repo has zero `{@html}` uses in the measured component suite.

## Composition over cross-cutting colour

`visualizer/web/src/lib/RunCard.svelte:54-55` composes `PhaseDots`, `GateChips`, and `RoleTag`; `visualizer/web/src/lib/RoleTag.svelte:4` and `visualizer/web/src/lib/PhaseDots.svelte:5` own role/lane colour indirection. Keep a component's props and CSS local, and route token choice through the measured shapers and child components rather than reading data status directly.
