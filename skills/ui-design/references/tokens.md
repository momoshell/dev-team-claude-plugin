# Token vocabulary

`visualizer/web/src/lib/theme.css` defines raw ink and paper ramps, status and role values, and semantic aliases. For new component colours prefer the aliases (`--bg`, `--panel`, `--panel-raised`, `--text`, `--muted`, `--line`, `--accent`, and `--status-*`) rather than raw theme-specific values. The ramps also include raised surfaces, not just ground, panel, hairline, text and muted.

The paper root is the default; explicit ink and the guarded dark-system media query supply the dark values. `visualizer/web/src/App.svelte` owns the stored theme choice and writes or deletes `data-theme`. Components consume the resulting cascade.

The theme declares role and lane aliases, including neutral overflow lanes. There is no live exhibit of role/lane component indirection: a declaration alone does not prove a consumer. Choose and document a fallback before introducing one. Component-local geometry variables are appropriate when they clarify local layout; no live exhibit is claimed here.
