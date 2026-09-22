# Visualizer structure

The app is a small Svelte shell over plain JavaScript shaping modules. These facts are measured on this checkout; the per-module `lib/*.js:1–N` exhibits are carried in the table below.

## Shell and ownership

`visualizer/web/src/main.js` imports the token sheet and mounts `App` into `#app`. `App.svelte` owns hash route state (`visualizer/web/src/App.svelte:25`), the `os`/`paper`/`ink` theme choice (`visualizer/web/src/App.svelte:72`), and the fleet/envelope fetch loop (`visualizer/web/src/App.svelte:117`), and composes the top-level views (`visualizer/web/src/App.svelte:186`, `visualizer/web/src/App.svelte:228`). It passes shaped rows and callbacks into the components under `visualizer/web/src/lib/`; a child does not take over route or theme ownership.

main.js is the only importer of theme.css.

The stylesheet is loaded before the mount call in `visualizer/web/src/main.js:1-5`. `visualizer/web/src/App.svelte:72` applies the selected `data-theme` after the component starts; a new component consumes aliases and does not import or re-select the sheet.

There are 33 `.svelte` components under `visualizer/web/src/lib/` (tracked files: `git ls-files 'visualizer/web/src/lib/*.svelte'`). The shell composes them for fleet, operations, roster, run, and phase views. A panel's placement matters for spacing: `visualizer/web/src/App.svelte:186`, `visualizer/web/src/App.svelte:228` mounts panels directly under `.page`, while `visualizer/web/src/lib/RunDetail.svelte:286` owns a grid gap for its children.

## Plain module split

Keep data acquisition, route parsing, drains, shaping, envelope diffing, layout, and trace interpretation in the eight existing plain modules:

| Module | Local responsibility | Exhibit |
|---|---|---|
| `api.js` | one `request` wrapper plus endpoint thunks for sessions, events, returns, roster, and panels | `visualizer/web/src/lib/api.js:1-26` |
| `envelope-diff.js` | compare two envelopes field-by-field over `['status','summary','artifacts','details']` | `visualizer/web/src/lib/envelope-diff.js:1-42` |
| `route.js` | parse and format hash views and subscribe to hash changes | `visualizer/web/src/lib/route.js:1-39` |
| `drain.js` | page event streams by cursor and coalesce a final drain behind an in-flight periodic drain | `visualizer/web/src/lib/drain.js:1-48` |
| `fleet.js` | derive status tones and shape run cells, absence marks, filters, and fleet metrics | `visualizer/web/src/lib/fleet.js:1-174` |
| `panels.js` | shape panel payloads, freshness, fleet metrics, and panel read loops | `visualizer/web/src/lib/panels.js:1-785` |
| `timeline.js` | turn timed phases and events into gantt lanes and blocks | `visualizer/web/src/lib/timeline.js:1-83` |
| `trace.js` | own `ROLE_ORDER`, lane rows, gate markers, markdown shaping, and phase panels | `visualizer/web/src/lib/trace.js:1-459` |

The data flow is server -> `api.js` -> a plain-module shaper (`fleet.js`, `panels.js`, `timeline.js`, or `trace.js`) -> a Svelte component. `visualizer/web/src/App.svelte:29-117` demonstrates the fetch-to-derived-view hop; `visualizer/web/src/lib/FleetTable.svelte:2` demonstrates the component boundary.

## Adding a feature

Put a new request thunk beside the existing wrapper in `api.js`, put deterministic transformation in the relevant plain module, and give a component only the shaped data and `on<verb>` callbacks. If the behaviour needs DOM rendering to be asserted, read `references/testing.md` first: this repo pins component source rather than mounting it.
