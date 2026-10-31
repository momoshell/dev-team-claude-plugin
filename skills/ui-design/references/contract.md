# Theming contract

- **T1–T2:** For new UI, paint with semantic aliases, not raw palette names or literal colours. This is a design constraint, not a claim that all existing declarations obey it or that tests enforce it. `visualizer/web/src/lib/TaskList.svelte` maps `.status.*` to status aliases.
- **T3:** Use `--status-escalated` rather than the raw `--serious` value. TaskList's `.status.serious` is a live exhibit.
- **T4:** Keep theme selection in `visualizer/web/src/App.svelte`; its theme effect writes or deletes the root attribute. `visualizer/web/src/lib/theme.css` provides paper, ink and guarded system-dark selectors.

For numeric alignment, the shared theme `.mono` rule includes `font-variant-numeric:tabular-nums`; `visualizer/web/src/lib/LeanWaterfall.svelte` also uses tabular numerals for labels. Monospace alone does not establish tabular numerals.

Source tests such as `test/visualizer-lean-web.test.mjs` pin selected wiring and logic, not rendered theme values or a universal colour-token rule. Check the current tests before describing their coverage; a source assertion is not a browser contrast audit.
