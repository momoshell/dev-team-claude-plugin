---
name: ux
description: >-
  Records the current visualizer's measured UX boundary: one honest
  null-with-reason phrase, explicit loading/empty/error states, native-first
  keyboard operability with visible focus, and reduced-motion handling for the
  counted animations. Load it before rendering a null, adding a loading or
  empty branch, adding a custom control, or adding motion to a Svelte
  component. It records this checkout's evidence rather than generic UX advice.
---

This is the measured UX boundary an agent works inside. The counts below describe the current checkout's 33 visualizer components, not a generic design system: extend the discipline to a new component without inventing rules the exhibits do not support.

## Routing

| Doing… | Rule that governs it | Details |
|---|---|---|
| Absence and null-with-reason | Render null as one honest phrase with its closed reason | `references/absence.md` |
| Showing loading, empty, or error | Keep loading explicit, empty states actionable, errors announced | `references/states.md` |
| Adding keyboard behavior or focus style | Stay native-first, operable, and visibly focused | `references/keyboard-focus.md` |
| Adding or keeping animation | Honor reduced motion for every animation | `references/motion.md` |

## Critical rules

- **A1.** A null carrying a closed reason renders as one honest phrase, never as zero and never as a bare dash.
- **S1–S3.** Loading is explicit and stable; empty states explain the result and name a next action; errors are visible, announced, and recoverable.
- **K1–K2.** Native controls first with keyboard-operable custom behavior; every interactive control shows a visible focus treatment.
- **M1.** Every animation honors reduced motion; the current animations do not yet, which the reference records as a counted gap.

The numbers in this skill re-derive from the component tree with plain text search; read the references before adding a rule the exhibit suite does not enforce.
