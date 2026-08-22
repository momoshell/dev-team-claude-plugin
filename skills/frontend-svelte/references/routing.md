# Retrieval routing

This is the routing rule for Svelte questions in this repo. The `svelte:svelte` MCP is the authority for Svelte API facts; this reference only says how to reach it and where repo evidence lives.

## Route by the question

| Question an agent has | Route | Details |
|---|---|---|
| What Svelte API or syntax fact do I need? | Retrieve, then edit | Use the `svelte` MCP `list-sections`, then `get-documentation` for the one needed section; use `svelte-autofixer` after writing. |
| How does a component declare props, callbacks, snippets, state, and styles here? | Read the measured component idioms | `references/components.md` |
| Where does data, routing, theme ownership, and the module split live? | Read the app structure | `references/structure.md` |
| What can a test assert without a DOM renderer? | Read the test boundary | `references/testing.md` |

## The retrieval order

1. List the available documentation sections with `list-sections`.
2. Fetch only the section needed for the question with `get-documentation`.
3. Write the code using that freshly retrieved fact and this repo's conventions.
4. Run `svelte-autofixer` over the code, then address its result before returning it.

A remembered Svelte API fact is re-fetched rather than trusted. This skill does not paraphrase or become a second Svelte reference: `svelte:svelte` MCP output owns API semantics, while the three repo references own local structure, idioms, and testing. `playground-link` may provide a reproducible experiment when documentation leaves a behaviour unclear. The `svelte:svelte-code-writer` skill and `svelte:svelte-file-editor` agent are optional routing targets for code-writing or file-editing work; they do not replace retrieval.

## Scope boundary

Route a question about `$props()`, `$state`, `$derived`, `$effect`, `$bindable`, `{#snippet}`, `{@render}`, `onclick`, `bind:`, `export let`, or `$:` to the MCP before making an API claim. Route a question about the visualizer's existing code to `references/components.md`, `references/structure.md`, or `references/testing.md`. Keep those two kinds of evidence separate: the MCP says what the API means, and the checkout says how this app uses it.
