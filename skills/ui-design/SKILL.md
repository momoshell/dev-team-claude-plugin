---
name: ui-design
description: >-
  Load before designing or reviewing visualizer UI, choosing colours, panels,
  state presentation, or theme tokens. Records live design evidence and limits.
---

Measured boundary: 11 `.svelte` files under `visualizer/web/src`.

Design against `visualizer/web/src/lib/theme.css` and the live component exhibits, not a historical inventory. Follow the broader rules below even where the checkout has no live exhibit or mechanical enforcement.

## Routing

- Token vocabulary and cascade: `references/tokens.md`.
- Theme ownership, tokens, and test limits: `references/contract.md`.
- Status and identity colour: `references/state-colour.md`.
- Contrast and other evidence limits: `references/limits.md`.
- Before finishing: `references/colour-checklist.md`.
- Source provenance: `references/sources.md`.

## Rules

Use component-facing semantic aliases rather than raw palette names or literal colours for new painted UI. Route status through a shaper and map its tone to aliases in CSS; make missing tones and fallbacks explicit. Do not claim the existing code universally enforces this rule.

Use panel and recessed surface tokens consistently: `visualizer/web/src/lib/LeanWaterfall.svelte` pairs its `.waterfall` panel with a `.track` recessed on `--bg`, and divides rows with `--line`. Preserve readable spacing and check contrast in both themes. Render missing measurements honestly rather than as a measured zero; `visualizer/web/src/lib/TaskList.svelte` marks an unmeasured shipped count with a dash and explanatory title.

Keep theme choice in `visualizer/web/src/App.svelte`. For role and lane component colour indirection there is no live exhibit; theme aliases alone do not establish a consumer pattern.
