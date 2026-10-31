# Loading, empty, and error states

- **S1:** Make loading explicit and stable. `visualizer/web/src/lib/SkillsPage.svelte` renders “Reading skills…” with a status role. Source: vercel-web-interface-guidelines.md — loading states; ui-ux-pro-max-ux-guidelines.csv — row 78.
- **S2:** Explain empty results and offer a next action. `visualizer/web/src/lib/TaskList.svelte` suggests another status, assurance preset or search term. Source: vercel-web-interface-guidelines.md — empty states; ui-ux-pro-max-ux-guidelines.csv — row 79.
- **S3:** Make errors visible, announced and recoverable. SkillsPage renders an alert with a retry button; `visualizer/web/src/lib/LeanRunDetail.svelte` reports session errors and offers refresh. Source: vercel-web-interface-guidelines.md — error messages; ui-ux-pro-max-ux-guidelines.csv — row 44.

These are local examples, not proof that all states are covered. Preserve existing data when a refresh fails where possible and distinguish an empty result from an unavailable feed.
