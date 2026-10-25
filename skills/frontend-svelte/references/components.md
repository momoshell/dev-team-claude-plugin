# Component idioms

These are measured conventions in `visualizer/web/src/` rather than general Svelte advice; reproduce the rune census with `grep` over that directory. Retrieve any API fact from the `svelte` MCP as required by `references/routing.md`.

## Props are one destructuring line

Declare props with one destructuring `$props()` line and put defaults there:

- `let { run, taskEnvelope = null, onopen = () => {} } = $props()` — `visualizer/web/src/lib/RunCard.svelte:8`.
- `let { rows = [], onopen = () => {} } = $props()` — `visualizer/web/src/lib/FleetTable.svelte:2`.
- `let { run, phase = null, returns = {}, events = [] } = $props()` — `visualizer/web/src/lib/PhasePanel.svelte:5`.

Keep callbacks as props named `on<verb>` (`onopen`, `onback`, `onphase`, `onselectphase`) rather than adding an event-dispatching seam. `visualizer/web/src/lib/PhaseGantt.svelte:8` uses `onselectphase`; `visualizer/web/src/App.svelte:189` passes `onback` to `RunDetail`. Defaults make the component's call shape visible at its boundary.

## Two-way state is explicit

`$bindable(` occurs 5 times in 3 files (measured over visualizer/web/src/**/*.svelte, 35 files); `visualizer/web/src/lib/Filters.svelte:4` exhibits the idiom: `filters` and `viewFilters` are bindable props, while `hiddenLine` is an ordinary defaulted prop. Use that exact local idiom when the parent and child intentionally share writable filter state; do not make every prop bindable.

## Snippets and rendering

The census found `{#snippet` 4 times in 3 files and `{@render` 21 times in 3 files (measured over visualizer/web/src/**/*.svelte, 35 files). `visualizer/web/src/lib/PhasePanel.svelte:49-72` defines the `countMark` snippet and renders it; `visualizer/web/src/lib/AcceptPanel.svelte:16` renders evidence blocks through `MarkdownView`. Keep a snippet's input shape local and render it at the call site rather than duplicating markdown markup.

## Events and bindings

Use native `onclick=` attributes: the census found 161 across 25 files and zero `on:click` uses (measured over visualizer/web/src/**/*.svelte, 35 files). Exhibits include `visualizer/web/src/App.svelte:165`, `visualizer/web/src/lib/RunCard.svelte:56`, and `visualizer/web/src/lib/EventStream.svelte:44`. Existing form bindings are `bind:value` and `bind:checked`, with the filter state declared at `visualizer/web/src/lib/Filters.svelte:4`; follow the existing spelling and route uncertain binding semantics to the MCP.

## Runes census and effects

The measured source (visualizer/web/src/**/*.svelte, 35 files) contains `$state(` 257 times in 26 files, `$derived` 177 times in 32 files, `$props()` 26 times in 26 files, `$effect` 23 times in 13 files, and `$bindable(` 5 times in 3 files, exhibited at `visualizer/web/src/lib/Filters.svelte:4`. The visualizer has no legacy `export let` or `$:`: `test/visualizer-shape.test.mjs:1018-1020` checks those strings across every `.svelte` file.

A correct effect has a dependency and a cleanup boundary. `visualizer/web/src/lib/RunCard.svelte:20-22` carries the `state_referenced_locally` comment: `previousRunning` is left undefined until the effect's first pass so a true running-to-finished transition can trigger the final drain. Treat that comment's shape—local previous value, guarded work, returned cleanup—as the repo's measured effect idiom, not as a generic API tutorial.

## Scoped styles

Component styles are scoped by default. Reserve `:global` for descendants produced by markdown rendering, where the compiler cannot see the generated elements: `.evidence :global(.markdown-document)` appears at `visualizer/web/src/lib/AcceptPanel.svelte:23` and `visualizer/web/src/lib/PhasePanel.svelte:99`. The scoped workspace layout in `visualizer/web/src/App.svelte:248` keeps shell positioning local; the single box-sizing reset lives in theme.css. The repo has zero `{@html}` uses in the measured component suite.

## Composition over cross-cutting colour

`visualizer/web/src/lib/RunCard.svelte:54-55` composes `PhaseDots`, `GateChips`, and `RoleTag`; `visualizer/web/src/lib/RoleTag.svelte:4` and `visualizer/web/src/lib/PhaseDots.svelte:5` own role/lane colour indirection. Keep a component's props and CSS local, and route token choice through the measured shapers and child components rather than reading data status directly.
