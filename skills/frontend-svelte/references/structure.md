# Visualizer structure

The app is a small Svelte shell over plain JavaScript shaping modules. These facts are measured on this checkout and recorded in `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md` §3–4.

## Shell and ownership

`visualizer/web/src/main.js` imports the token sheet and mounts `App` into `#app`. `App.svelte` owns hash route state, the `os`/`paper`/`ink` theme choice, filters, fleet/envelope fetch loops, and top-level view composition (`visualizer/web/src/App.svelte:1–130`). It passes shaped rows and callbacks into the components under `visualizer/web/src/lib/`; a child does not take over route or theme ownership.

main.js is the only importer of theme.css.

The stylesheet is loaded before the mount call in `visualizer/web/src/main.js:1–5`. `App.svelte:44–51` applies the selected `data-theme` after the component starts; a new component consumes aliases and does not import or re-select the sheet.

There are 20 `.svelte` components under `visualizer/web/src/lib/`. The shell composes them for fleet, operations, roster, run, and phase views. A panel's placement matters for spacing: `visualizer/web/src/App.svelte:143,151,180` mounts panels directly under `.page`, while `visualizer/web/src/lib/RunDetail.svelte:33` owns a grid gap for its children.

## Plain module split

Keep data acquisition, route parsing, drains, shaping, layout, and trace interpretation in the seven existing plain modules:

| Module | Local responsibility | Exhibit |
|---|---|---|
| `api.js` | one `request` wrapper plus endpoint thunks for sessions, events, returns, roster, and panels | `visualizer/web/src/lib/api.js:1–26` |
| `route.js` | parse and format hash views and subscribe to hash changes | `visualizer/web/src/lib/route.js:1–40` |
| `drain.js` | page event streams by cursor and coalesce a final drain behind an in-flight periodic drain | `visualizer/web/src/lib/drain.js:1–49` |
| `fleet.js` | derive status tones and shape run cells, absence marks, filters, and fleet metrics | `visualizer/web/src/lib/fleet.js:1–174` |
| `panels.js` | shape panel payloads, freshness, fleet metrics, and panel read loops | `visualizer/web/src/lib/panels.js:1–785` |
| `timeline.js` | turn timed phases and events into gantt lanes and blocks | `visualizer/web/src/lib/timeline.js:1–84` |
| `trace.js` | own `ROLE_ORDER`, lane rows, gate markers, markdown shaping, and phase panels | `visualizer/web/src/lib/trace.js:1–459` |

The data flow is server -> `api.js` -> a plain-module shaper (`fleet.js`, `panels.js`, `timeline.js`, or `trace.js`) -> a Svelte component. `visualizer/web/src/App.svelte:1–130` demonstrates the fetch-to-derived-view hop; `visualizer/web/src/lib/FleetTable.svelte:1–2` demonstrates the component boundary.

## Adding a feature

Put a new request thunk beside the existing wrapper in `api.js`, put deterministic transformation in the relevant plain module, and give a component only the shaped data and `on<verb>` callbacks. If the behaviour needs DOM rendering to be asserted, read `references/testing.md` first: this repo pins component source rather than mounting it.
