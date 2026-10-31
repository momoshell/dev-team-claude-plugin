# State, role, and lane colour

Derive status in the data layer, then map the returned tone to semantic aliases. `visualizer/web/src/lib/TaskList.svelte` calls `statusFor`, which delegates to `deriveDisplayStatus` in `visualizer/web/src/lib/fleet.js`; TaskList renders the tone as a class and its `.status.*` rules map tones to aliases. Check that every emitted tone has an intentional presentation and fallback; do not rely on colour alone.

Use `--bg` for a recessed surface inside a panel and `--panel` for the panel itself. The `.track` and `.waterfall` rules in `visualizer/web/src/lib/LeanWaterfall.svelte` exhibit that pairing. Do not use the separator token as a surface.

`visualizer/web/src/lib/theme.css` declares role and lane aliases, but there is no live exhibit of component role/lane indirection. For new identity colours define how unknown roles and overflow lanes fall back; do not infer a consumer from the declarations. Distinguish unmeasured values from zero: TaskList's shipped count uses a dash and reason title when it is not measured.
