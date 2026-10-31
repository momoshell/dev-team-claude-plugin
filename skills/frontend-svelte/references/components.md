# Component idioms

These are source exhibits, not Svelte API documentation; retrieve API facts through `references/routing.md`.

## Props and callbacks

Live prop exhibit: `visualizer/web/src/lib/TaskList.svelte` (`$props`).

TaskList uses a single destructuring line with defaults and an `onopen` callback; `visualizer/web/src/lib/LeanRunDetail.svelte` accepts `onback`. Prefer clear boundary defaults and callback names. `visualizer/web/src/lib/Dropdown.svelte` uses a multiline prop declaration and makes `value` bindable: use binding intentionally for shared writable state, not for every prop.

## State, events and effects

TaskList derives filtered and paged rows from local state and uses native buttons with `onclick`. It binds its filters to Dropdown and Pagination. Dropdown's effect registers document and window listeners and returns their cleanup; keep effects' cleanup boundaries explicit.

## Composition and styles

`visualizer/web/src/App.svelte` composes TaskList and LeanRunDetail; LeanRunDetail renders `visualizer/web/src/lib/LeanWaterfall.svelte`. Keep layout and styles local where practical. Reserve global selectors for cases where scoping cannot reach the intended descendant; LeanRunDetail uses `:global` for icon descendants. For markdown-rendered global descendants and snippets, no live exhibit; assess the need before introducing either. For role/lane colour composition, no live exhibit; see the design skill rather than assuming alias declarations establish a component pattern.
