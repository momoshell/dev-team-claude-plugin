---
name: frontend-svelte
description: >-
  Load before creating or editing a visualizer component, changing the app shell,
  adding a plain-module shaper, or deciding how a source-level test should pin Svelte
  code. Routes Svelte API questions to the svelte MCP and records local conventions.
---

This is a retrieval-first repo skill, not a Svelte API manual. Retrieve Svelte API facts from the svelte MCP; the references describe this checkout's conventions.

Measured boundary: 12 `.svelte` files under `visualizer/web/src`.

## Routing

- API or syntax questions: `references/routing.md`.
- Props, state, events, effects and styles: `references/components.md`.
- Shell and module responsibilities: `references/structure.md`.
- Logic tests and source pins: `references/testing.md`.

Before writing code, read the routing reference and retrieve any needed API fact. Keep deterministic logic in `visualizer/web/src/lib/*.js`, and run `svelte-autofixer` over changed Svelte code before returning it. Props can be formatted on one line or several as clarity requires.
