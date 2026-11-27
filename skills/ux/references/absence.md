# Absence and null-with-reason

**Rule A1:** Explain a null carrying a closed reason honestly; never render it as a measured zero or unexplained dash. Prefer a reasoned phrase such as `Unmeasured — <reason>`. Sources: vercel-web-interface-guidelines.md — Content Handling / “Handle empty states”; ui-ux-pro-max-ux-guidelines.csv — row 79.

When tokens are unmeasured, the Usage cell in `visualizer/web/src/lib/TaskList.svelte` shows a dash with the reason ("not measured" if none is recorded) in small text below it and in that text's `title` attribute; `visualizer/web/src/lib/LeanWaterfall.svelte` lists unrecorded boundaries with their reasons. These are not identical vocabulary: ensure the reason is available to the user rather than treating a title-only mark as the ideal for every context. A failed feed is operational unavailability, not an unrecorded measurement.
