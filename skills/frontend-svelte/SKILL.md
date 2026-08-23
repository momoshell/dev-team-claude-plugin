---
name: frontend-svelte
description: >-
  Constrains Svelte work to this repository's measured visualizer conventions while
  routing every Svelte API question to the svelte MCP. Load it before creating or
  editing a visualizer component, changing the app shell, adding a plain-module
  shaper, or deciding how a source-level test should pin Svelte code. It covers the
  component prop and rune idioms, module boundaries, theme ownership, and the fact
  that this checkout tests logic with node --test and components as source text.
---

This is a retrieval-first repo skill, not a Svelte API manual. A Svelte API fact is retrieved from the svelte MCP, never restated here. This skill owns only this repo's conventions: the visualizer's structure, its component idioms, and how its code is tested.

## Routing

| Question an agent has | Rule that governs it | Details |
|---|---|---|
| What Svelte API or syntax fact do I need? | Retrieve it from the MCP in the documented order | `references/routing.md` |
| How should this component declare props, callbacks, snippets, state, and styles? | Copy measured component idioms | `references/components.md` |
| Where should data, theme, routes, and shaping logic live? | Follow the app shell and eight-module split | `references/structure.md` |
| What can this repo test, and what must remain source text? | Keep assertions in plain modules and pin only structural source | `references/testing.md` |

## Operating rules

A Svelte API fact is retrieved from the svelte MCP, never restated here.

This skill owns only this repo's conventions: the visualizer's structure, its component idioms, and how its code is tested.

Before writing code, read the routing reference, ask the `svelte` MCP for any API fact you do not have in the current response, then read the repo reference that matches the question. Keep component props in one destructuring line, keep deterministic logic in `visualizer/web/src/lib/*.js`, and run `svelte-autofixer` over changed Svelte code before returning it.

The measured source can be checked with `grep` over `visualizer/web/src`; it describes this checkout and is not a substitute for current MCP documentation.

## Key references

- `references/routing.md` — MCP retrieval order and question routing
- `references/components.md` — props, runes, snippets, events, bindings, effects, and scoped styles
- `references/structure.md` — shell ownership and the eight plain modules
- `references/testing.md` — node tests, source pins, and the absent DOM harness
