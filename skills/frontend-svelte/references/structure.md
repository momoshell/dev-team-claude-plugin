# Visualizer structure

`visualizer/web/src/main.js` imports the theme and mounts `visualizer/web/src/App.svelte`. App owns hash navigation, theme selection and the session refresh loop; it composes TaskList, LeanRunDetail, AgentsPage, SkillsPage and Dropdown. TaskList binds Dropdown and Pagination; LeanRunDetail renders LeanWaterfall. Keep route and theme ownership in the shell.

## Plain modules

- `visualizer/web/src/lib/api.js` wraps requests and exposes endpoints.
- `visualizer/web/src/lib/route.js` parses and formats hash routes.
- `visualizer/web/src/lib/fleet.js` shapes run status and task-list data.
- `visualizer/web/src/lib/agents.js` shapes agent data.
- `visualizer/web/src/lib/timeline.js` lays out the intervals rendered by LeanWaterfall.
- `visualizer/web/src/lib/live.js` supplies the refresh loop and journal pulse.

Put deterministic transformations in the relevant plain module and pass shaped data and callbacks to components. Check the current imports before adding another responsibility. The stylesheet `visualizer/web/src/lib/theme.css` defines the shared theme; the App theme effect selects it.
