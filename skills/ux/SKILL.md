---
name: ux
description: >-
  Load before rendering a null, adding loading or empty states, a custom control,
  or motion to a visualizer component. Records live UX evidence and limits.
---

Measured boundary: 11 `.svelte` files under `visualizer/web/src`.

These rules guide new work; an exhibit demonstrates a local practice, not universal compliance.

## Routing

- Honest absence and reasons: `references/absence.md`.
- Loading, empty and error states: `references/states.md`.
- Keyboard operability and focus: `references/keyboard-focus.md`.
- Reduced motion: `references/motion.md`.
- Before finishing: `references/accessibility-checklist.md`.
- Source provenance: `references/sources.md`.

## Critical rules

- **A1:** Explain unmeasured values honestly, never as a measured zero or unexplained dash.
- **S1–S3:** Make loading explicit, empty states actionable, and errors visible, announced and recoverable.
- **K1–K2:** Prefer native controls; custom behaviour must be keyboard operable and interactive controls need visible focus.
- **M1:** Honor reduced motion. The shared theme provides a global override; inspect the motion reference for its scope and the separate scrolling behaviour.
