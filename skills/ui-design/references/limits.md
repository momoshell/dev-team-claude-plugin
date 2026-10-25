# Known limits

This reference preserves the limits measured from the raw block of `visualizer/web/src/lib/theme.css`; the ratios below are recorded measurements, not a repository-provided formula. The section 9 and section 10 absences are already restated in full below. They are constraints to expose, not defects this lane silently fixes.

## Contrast limit

The current palette uses distinct light and dark status values. The following ratios use the declared page ground in each theme, not a rendered-page measurement. Component backgrounds and translucent mixes require separate checks.

| Alias | Ink ground | Paper ground |
|---|---:|---:|
| `--status-escalated` | 7.65 | 5.28 |
| `--status-running` | 11.07 | 5.99 |
| `--status-ok` | 9.19 | 5.63 |
| `--status-fail` | 6.75 | 4.72 |

The escalation raw token is declared at `visualizer/web/src/lib/theme.css:28` and its paper literal at `visualizer/web/src/lib/theme.css:62`. The skipped status remains 5.27:1 on ink and 3.41:1 on paper; the paper value remains below 4.5:1. Primary text, muted text and accent on their matching ground are: `--ink-text` 17.15:1, `--paper-text` 17.06:1, `--ink-muted` 7.59:1, `--paper-muted` 5.50:1, `--spot-dark` 8.82:1, `--spot-light` 5.06:1.

The existing lane-block treatment at `visualizer/web/src/lib/PhaseGantt.svelte:257` still uses white text on the failed-status fill. Role/lane colors and dense run-detail charts have not had a complete rendered contrast audit in this change. Do not extend these page-ground results to every chart label.

## Hover contrast — per-rule register

Each of the 24 `:hover` rule blocks below is classified independently from source alone: one record per hover CSS block, not one verdict per component, so a mixed component keeps every computable rule. A value is `literal` when it contains a hex, a CSS named colour (including `white`/`black`), or `rgb(`/`rgba(`/`hsl(` — even beside `var()`; it is `token` when it contains `var()`/`color-mix()` and no literal; it is `none` when the rule declares no color-affecting declaration. Only source-declared foregrounds and each state's own background are resolved: the rest ratio is computed against the rest background, never the hover background, and when a hover rule declares no background its ground is the rest rule's background on the same element. A transparent, inherited, missing, or otherwise unresolvable ground is recorded as `Unmeasured — <closed reason>` rather than borrowed. Ratios are WCAG relative-luminance contrasts of the state foreground against the state ground, paper first then ink, shown as rest → hover. The RosterPanel `.scope button` rest rule declares `background:transparent`, so its rest ratio is unmeasured because the rest ground is transparent (see `RosterPanel.svelte:725`).

### `Dropdown.svelte` — 2 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `Dropdown.svelte` | `.dropdown-trigger:hover:not(:disabled),.dropdown-trigger[aria-expanded='true']` | `border-color: color-mix(in srgb,var(--accent) 62%,var(--line)); background: color-mix(in srgb,var(--accent) 6%,var(--bg))` | token | `var(--bg)` | `color-mix(in srgb,var(--accent) 6%,var(--bg))` | Unmeasured — hover background is a color-mix, not a flat token value |
| `Dropdown.svelte` | `.dropdown-menu button:hover,.dropdown-menu button.active` | `background: var(--accent-soft); color: var(--text)` | token | `transparent` | `var(--accent-soft)` | Unmeasured — rest ground is transparent |

### `EnvelopeInspector.svelte` — 1 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `EnvelopeInspector.svelte` | `.roles button:hover,.roles button.active` | `border-color: color-mix(in srgb,var(--role-color) 55%,var(--line)); background: color-mix(in srgb,var(--role-color) 8%,var(--panel))` | token | `var(--bg)` | `color-mix(in srgb,var(--role-color) 8%,var(--panel))` | Unmeasured — rest foreground is inherited, not source-declared |

### `EventStory.svelte` — 1 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `EventStory.svelte` | `.expand:hover` | `border-color: var(--accent); color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | paper 5.17 → 4.76; ink 6.20 → 7.20 |

### `EventStream.svelte` — 1 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `EventStream.svelte` | `.refresh:hover,.clear:hover` | `border-color: var(--accent); color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | paper 5.17 → 4.76; ink 6.20 → 7.20 |

### `OperationsOverview.svelte` — 1 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `OperationsOverview.svelte` | `.bars button:focus-visible .bar-value,.bars button:hover .bar-value` | `(none)` | none | `transparent` | `transparent` | Unmeasured — rule declares no color-affecting declaration |

### `PhaseGantt.svelte` — 6 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `PhaseGantt.svelte` | `.trace-guide > summary:hover,.trace-guide[open] > summary` | `background: color-mix(in srgb,var(--accent) 6%,transparent)` | token | `none declared` | `color-mix(in srgb,var(--accent) 6%,transparent)` | Unmeasured — no source-declared rest background |
| `PhaseGantt.svelte` | `.waterfall-row:hover,.waterfall-row.selected` | `background: var(--accent-soft)` | token | `transparent` | `var(--accent-soft)` | Unmeasured — rest ground is transparent |
| `PhaseGantt.svelte` | `.bounce-hotspot:hover > span,.bounce-hotspot:focus-visible > span` | `(none)` | none | `var(--panel)` | `var(--panel)` | Unmeasured — rule declares no color-affecting declaration |
| `PhaseGantt.svelte` | `.round-row:hover,.round-row.selected-step` | `background: color-mix(in srgb,var(--accent) 9%,var(--panel))` | token | `linear-gradient(90deg,color-mix(in srgb,var(--accent) 4%,var(--bg)),color-mix(in srgb,var(--bg) 28%,transparent))` | `color-mix(in srgb,var(--accent) 9%,var(--panel))` | Unmeasured — rest background is a color-mix, not a flat token value |
| `PhaseGantt.svelte` | `.factory-steps > summary:hover` | `background: var(--accent-soft)` | token | `none declared` | `var(--accent-soft)` | Unmeasured — no source-declared rest background |
| `PhaseGantt.svelte` | `.checkpoint:hover,.checkpoint.selected-step` | `background: color-mix(in srgb,var(--accent) 7%,transparent)` | token | `transparent` | `color-mix(in srgb,var(--accent) 7%,transparent)` | Unmeasured — rest ground is transparent |

### `PhasePanel.svelte` — 1 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `PhasePanel.svelte` | `.envelope-documents summary:hover` | `background: color-mix(in srgb,var(--document-role) 6%,transparent)` | token | `none declared` | `color-mix(in srgb,var(--document-role) 6%,transparent)` | Unmeasured — no source-declared rest background |

### `RosterPanel.svelte` — 6 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `RosterPanel.svelte` | `.seat.changeable:hover` | `border-color: var(--accent); background: var(--accent-soft)` | token | `none declared` | `var(--accent-soft)` | Unmeasured — no source-declared rest background |
| `RosterPanel.svelte` | `.source-setup a:hover` | `color: var(--accent)` | token | `none declared` | `none declared` | Unmeasured — no source-declared rest background |
| `RosterPanel.svelte` | `.directory-pager button:hover:not(:disabled)` | `background: var(--accent-soft); color: var(--accent)` | token | `transparent` | `var(--accent-soft)` | Unmeasured — rest ground is transparent |
| `RosterPanel.svelte` | `.scope button:hover` | `background: var(--panel-raised); color: var(--text)` | token | `transparent` | `var(--panel-raised)` | Unmeasured — rest ground is transparent |
| `RosterPanel.svelte` | `.model-palette article:hover` | `border-color: var(--accent-border)` | token | `var(--panel)` | `var(--panel)` | Unmeasured — rest foreground is inherited, not source-declared |

| `RosterPanel.svelte` | `.model-choice:hover .choose-model-cta` | `(none)` | none | `none declared` | `none declared` | Unmeasured — rule declares no color-affecting declaration |

### `TaskList.svelte` — 2 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `TaskList.svelte` | `tbody tr:hover` | `background: var(--accent-soft)` | token | `none declared` | `var(--accent-soft)` | Unmeasured — no source-declared rest background |
| `TaskList.svelte` | `tr:hover .open` | `border-color: var(--accent); color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | Unmeasured — rest foreground is inherited, not source-declared |

### `WorkflowGraph.svelte` — 1 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `WorkflowGraph.svelte` | `.stage-node:hover` | `border-color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | paper 5.17 → 5.17; ink 6.20 → 6.20 |

### `PromptsPage.svelte` — 2 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `PromptsPage.svelte` | `button:hover:not(:disabled)` | `border-color: var(--accent); background: var(--accent-surface)` | token | `var(--panel)` | `var(--accent-surface)` | Unmeasured — hover ground token --accent-surface has no source-declared value |
| `PromptsPage.svelte` | `button.primary:hover:not(:disabled)` | `background: var(--accent-solid)` | token | `var(--accent-solid)` | `var(--accent-solid)` | Unmeasured — rest ground token --accent-solid has no source-declared value |

24 rules in 11/38 components. Three rules carry measured rest → hover ratios; the rest stop at a closed reason instead of borrowing a ground.

## Vacuous theme-sheet coverage

Known limit: the visualizer shape suite checks role/lane name presence over theme.css and inspects no value, so deleting --status-escalated leaves the suite green.

The suite check over `test/visualizer-shape.test.mjs` covers role declarations and lane-to-role names only. It does not inspect the alias values, declaration count, status aliases, ordering, theme switching, or contrast. A consumer pin in `test/visualizer-panels.test.mjs` makes one FleetTable rule exact, but it does not prove that the token exists or that every component uses a token.

## What resists mechanical enforcement

Register section 9 names the conventions that cannot honestly be made into current grep rules without a new decision or input:

- the spacing scale (C5), because fourteen sub-1rem values exist and no preferred scale exists;
- the type ramp, because nine ad-hoc sizes are not tokenised, even though the two weights and `.micro` usage are checkable;
- corner radius (D10), because component values have not all been normalized;
- the pill radius idiom (D3), a 3-3 tie with no governing principle;
- panel-spacing ownership (D2), which depends on where a component is mounted;
- tone completeness (D6), which needs the shaper's scattered tone vocabulary as an input.

The register section 8 floor does cover role/lane mapping, two exact FleetTable strings, PhaseGantt layout locals, no `export let`/`$:` in Svelte files, and selected source pins. It does not cover a general colour-token rule.

## What the recon could not establish

Register section 10 records four absences, and none should be upgraded to a fact:

1. No repo file establishes where the ratified role palette was ratified; the durable trace is the shape suite check and the lane alias block at `visualizer/web/src/lib/theme.css:133` through `visualizer/web/src/lib/theme.css:140`.
2. No commit body explains why the role colours were chosen.
3. No rendered-page observation was available; L10, L11, D2 consequences, and visual appearance are source-derived, while the ratios above are arithmetic.
4. The recon did not trace whether the live ledger can carry `scout` or `advisor` in `agent_sessions.role`, and did not establish whether a skipped phase with no lane occurs.

The palette update improves status text on the page grounds; skipped-status text on light surfaces and the limits of theme-sheet tests remain. Record the evidence boundary when extending the work.
