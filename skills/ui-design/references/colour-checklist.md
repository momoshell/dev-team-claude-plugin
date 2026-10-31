# Colour checklist

Adapted from the better-colors skill in https://github.com/jakubkrehel/skills at revision 4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63 under its MIT licence (see THIRD-PARTY-NOTICES.md).

- Prefer semantic aliases over raw or literal colours in new component rules; check `visualizer/web/src/lib/theme.css` and `references/contract.md`.
- Check status tone mappings and fallbacks against `visualizer/web/src/lib/TaskList.svelte` and `references/state-colour.md`.
- Keep theme choice in `visualizer/web/src/App.svelte`, not each component.
- Check contrast on actual surfaces in both themes, including hover and transparent mixes; `visualizer/web/src/lib/Dropdown.svelte` is a mixed-surface example. See `references/limits.md`.
- Keep absence distinguishable from a measured zero; see the UX absence reference.
