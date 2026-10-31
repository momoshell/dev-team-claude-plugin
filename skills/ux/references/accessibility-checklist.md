# Accessibility checklist

Adapted from the better-accessibility skill in https://github.com/jakubkrehel/skills at revision 4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63 under its MIT licence (see THIRD-PARTY-NOTICES.md).

- Do not remove a focus outline without a visible replacement; `visualizer/web/src/lib/theme.css` supplies shared focus-visible rules.
- Prefer native buttons as in `visualizer/web/src/lib/TaskList.svelte`; if introducing a custom control, implement its keyboard interaction. TaskList's status group is not a tablist.
- Keep status and error messages visible and announced, and provide a recovery path. `visualizer/web/src/lib/SkillsPage.svelte` has a persistent status region and a retry alert.
- Match accessible names to visible labels; do not depend on a title tooltip as the only label, especially for disabled controls. Check `visualizer/web/src/lib/Pagination.svelte` when changing pagination.
- Do not hide a focusable subtree from accessibility APIs. Account for sticky navigation when moving focus. `visualizer/web/src/App.svelte` provides a skip link and focus target.
