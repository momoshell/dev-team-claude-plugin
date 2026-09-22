# Known limits

This reference preserves the limits measured from the raw block of `visualizer/web/src/lib/theme.css`; the ratios below are recorded measurements, not a repository-provided formula. The section 9 and section 10 absences are already restated in full below. They are constraints to expose, not defects this lane silently fixes.

## Contrast limit

Known limit: status colour is theme-invariant, so all four status steps and --serious fall below 4.5:1 on the paper ground.

The eight measured ratios below are computed from the declared literals, not from a rendered page:

| Alias | Ink ground | Paper ground | What the table says |
|---|---|---:|---|
| `--status-escalated` / `--serious` | **6.78** | **2.24** | theme-invariant escalation |
| `--status-running` | **5.99** | **2.53** | theme-invariant running |
| `--status-ok` | **5.27** | **2.88** | theme-invariant success |
| `--status-fail` | **4.04** | **3.75** | theme-invariant failure |

The escalation raw token is declared at `visualizer/web/src/lib/theme.css:28` and its paper literal at `visualizer/web/src/lib/theme.css:60`. `--status-skipped` is also below 4.5:1 on both measured grounds (3.90 on ink and 3.89 on paper in register section 6), which is why the limit says all four status steps. By contrast, every theme-paired token clears 4.5:1 on its own ground: `--ink-text` is 14.72, `--paper-text` 15.63, `--ink-muted` 6.37, `--paper-muted` 6.54, `--spot-dark` 8.81, and `--spot-light` 4.59 in the declared-pair calculation.

A second contrast limit belongs to lane blocks: `visualizer/web/src/lib/PhaseGantt.svelte:257` uses `.bar.failed` with `color:#fff`. The six paper role combinations range from 2.17 to 8.56 and the six ink combinations from 3.07 to 3.94; only **1 of 12 lane/ground combinations clears 4.5:1**. The `#fff` value is cited from the measured register, not introduced as a new palette value.

Neither the status contrast problem nor the lane-block contrast problem is fixed by this lane. A new component must use the aliases and surface the limitation rather than claim that a theme switch makes a status colour safe.

## Hover contrast — per-rule register

Each of the 25 `:hover` rule blocks below is classified independently from source alone: one record per hover CSS block, not one verdict per component, so a mixed component keeps every computable rule. A value is `literal` when it contains a hex, a CSS named colour (including `white`/`black`), or `rgb(`/`rgba(`/`hsl(` — even beside `var()`; it is `token` when it contains `var()`/`color-mix()` and no literal; it is `none` when the rule declares no color-affecting declaration. Only source-declared foregrounds and each state's own background are resolved: the rest ratio is computed against the rest background, never the hover background, and when a hover rule declares no background its ground is the rest rule's background on the same element. A transparent, inherited, missing, or otherwise unresolvable ground is recorded as `Unmeasured — <closed reason>` rather than borrowed. Ratios are WCAG relative-luminance contrasts of the state foreground against the state ground, paper first then ink, shown as rest → hover. The RosterPanel `.scope button` rest rule declares `background:transparent`, so its rest ratio is unmeasured because the rest ground is transparent (see `RosterPanel.svelte:712`).

### `Dropdown.svelte` — 2 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `Dropdown.svelte` | `.dropdown-trigger:hover:not(:disabled),.dropdown-trigger[aria-expanded='true']` | `border-color: color-mix(in srgb,var(--accent) 62%,var(--line)); background: color-mix(in srgb,var(--accent) 6%,var(--bg))` | token | `var(--bg)` | `color-mix(in srgb,var(--accent) 6%,var(--bg))` | Unmeasured — foreground token --text has no source-declared value |
| `Dropdown.svelte` | `.dropdown-menu button:hover,.dropdown-menu button.active` | `background: var(--accent-soft); color: var(--text)` | token | `transparent` | `var(--accent-soft)` | Unmeasured — rest ground is transparent |

### `EnvelopeInspector.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `EnvelopeInspector.svelte` | `.roles button:hover,.roles button.active` | `border-color: color-mix(in srgb,var(--role-color) 55%,var(--line)); background: color-mix(in srgb,var(--role-color) 8%,var(--panel))` | token | `var(--bg)` | `color-mix(in srgb,var(--role-color) 8%,var(--panel))` | Unmeasured — rest foreground is inherited, not source-declared |

### `EventStory.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `EventStory.svelte` | `.expand:hover` | `border-color: var(--accent); color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | paper 5.56 → 5.65; ink 6.01 → 6.95 |

### `EventStream.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `EventStream.svelte` | `.refresh:hover,.clear:hover` | `border-color: var(--accent); color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | paper 5.56 → 5.65; ink 6.01 → 6.95 |

### `MetricsStrip.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `MetricsStrip.svelte` | `.metric-card:hover` | `border-color: color-mix(in srgb,var(--accent) 45%,var(--line)); background: color-mix(in srgb,var(--accent) 4%,var(--panel))` | token | `color-mix(in srgb,var(--panel) 91%,transparent)` | `color-mix(in srgb,var(--accent) 4%,var(--panel))` | Unmeasured — rest background is a color-mix, not a flat token value |

### `PhaseGantt.svelte` — 6 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `PhaseGantt.svelte` | `.trace-guide > summary:hover,.trace-guide[open] > summary` | `background: color-mix(in srgb,var(--accent) 6%,transparent)` | token | `none declared` | `color-mix(in srgb,var(--accent) 6%,transparent)` | Unmeasured — no source-declared rest background |
| `PhaseGantt.svelte` | `.waterfall-row:hover,.waterfall-row.selected` | `background: var(--accent-soft)` | token | `transparent` | `var(--accent-soft)` | Unmeasured — rest ground is transparent |
| `PhaseGantt.svelte` | `.bounce-hotspot:hover > span,.bounce-hotspot:focus-visible > span` | `(none)` | none | `var(--panel)` | `var(--panel)` | Unmeasured — rule declares no color-affecting declaration |
| `PhaseGantt.svelte` | `.round-row:hover,.round-row.selected-step` | `background: color-mix(in srgb,var(--accent) 9%,var(--panel))` | token | `linear-gradient(90deg,color-mix(in srgb,var(--accent) 4%,var(--bg)),color-mix(in srgb,var(--bg) 28%,transparent))` | `color-mix(in srgb,var(--accent) 9%,var(--panel))` | Unmeasured — rest background is a color-mix, not a flat token value |
| `PhaseGantt.svelte` | `.factory-steps > summary:hover` | `background: var(--accent-soft)` | token | `none declared` | `var(--accent-soft)` | Unmeasured — no source-declared rest background |
| `PhaseGantt.svelte` | `.checkpoint:hover,.checkpoint.selected-step` | `background: color-mix(in srgb,var(--accent) 7%,transparent)` | token | `transparent` | `color-mix(in srgb,var(--accent) 7%,transparent)` | Unmeasured — rest ground is transparent |

### `PhasePanel.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `PhasePanel.svelte` | `.envelope-documents summary:hover` | `background: color-mix(in srgb,var(--document-role) 6%,transparent)` | token | `none declared` | `color-mix(in srgb,var(--document-role) 6%,transparent)` | Unmeasured — no source-declared rest background |

### `RosterPanel.svelte` — 7 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `RosterPanel.svelte` | `.seat.changeable:hover` | `border-color: var(--accent); background: var(--accent-soft)` | token | `none declared` | `var(--accent-soft)` | Unmeasured — no source-declared rest background |
| `RosterPanel.svelte` | `.source-setup a:hover` | `color: var(--accent)` | token | `none declared` | `none declared` | Unmeasured — no source-declared rest background |
| `RosterPanel.svelte` | `.directory-list article:hover` | `background: color-mix(in srgb,var(--accent) 3%,var(--panel))` | token | `none declared` | `color-mix(in srgb,var(--accent) 3%,var(--panel))` | Unmeasured — no source-declared rest background |
| `RosterPanel.svelte` | `.directory-pager button:hover:not(:disabled)` | `background: var(--accent-soft); color: var(--accent)` | token | `transparent` | `var(--accent-soft)` | Unmeasured — rest ground is transparent |
| `RosterPanel.svelte` | `.scope button:hover` | `background: var(--panel-raised); color: var(--text)` | token | `transparent` | `var(--panel-raised)` | Unmeasured — rest ground is transparent |
| `RosterPanel.svelte` | `.model-palette article:hover` | `border-color: color-mix(in srgb,var(--accent) 55%,var(--line))` | token | `var(--panel-raised)` | `var(--panel-raised)` | Unmeasured — rest foreground is inherited, not source-declared |
| `RosterPanel.svelte` | `.remove-model:hover` | `color: var(--status-fail)` | token | `transparent` | `transparent` | Unmeasured — rest ground is transparent |

### `RunDetail.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `RunDetail.svelte` | `.crew-seat > summary:hover` | `background: color-mix(in srgb,var(--accent) 5%,transparent)` | token | `none declared` | `color-mix(in srgb,var(--accent) 5%,transparent)` | Unmeasured — no source-declared rest background |

### `TaskList.svelte` — 2 rules

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `TaskList.svelte` | `tbody tr:hover` | `background: var(--accent-soft)` | token | `none declared` | `var(--accent-soft)` | Unmeasured — no source-declared rest background |
| `TaskList.svelte` | `tr:hover .open` | `border-color: var(--accent); color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | Unmeasured — rest foreground is inherited, not source-declared |

### `Trajectory.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `Trajectory.svelte` | `.activity > button:hover` | `background: color-mix(in srgb,var(--activity-color) 5%,transparent)` | token | `transparent` | `color-mix(in srgb,var(--activity-color) 5%,transparent)` | Unmeasured — rest ground is transparent |

### `WorkflowGraph.svelte` — 1 rule

| File | Selector | Hover declarations | Verdict | Rest ground | Hover ground | Contrast (paper / ink) |
|---|---|---|---|---|---|---|
| `WorkflowGraph.svelte` | `.stage-node:hover` | `border-color: var(--accent)` | token | `var(--panel-raised)` | `var(--panel-raised)` | paper 5.56 → 5.56; ink 6.01 → 6.01 |

25 rules in 12/33 components. Three rules carry measured rest → hover ratios; the rest stop at a closed reason instead of borrowing a ground.

## Vacuous theme-sheet coverage

Known limit: the visualizer shape suite checks role/lane name presence over theme.css and inspects no value, so deleting --status-escalated leaves the suite green.

The suite check over `test/visualizer-shape.test.mjs` covers role declarations and lane-to-role names only. It does not inspect the alias values, declaration count, status aliases, ordering, theme switching, or contrast. A consumer pin in `test/visualizer-panels.test.mjs` makes one FleetTable rule exact, but it does not prove that the token exists or that every component uses a token.

## What resists mechanical enforcement

Register section 9 names the conventions that cannot honestly be made into current grep rules without a new decision or input:

- the spacing scale (C5), because fourteen sub-1rem values exist and no preferred scale exists;
- the type ramp, because nine ad-hoc sizes are not tokenised, even though the two weights and `.micro` usage are checkable;
- corner radius (D10), until the global reset versus component practice is resolved;
- the pill radius idiom (D3), a 3-3 tie with no governing principle;
- panel-spacing ownership (D2), which depends on where a component is mounted;
- tone completeness (D6), which needs the shaper's scattered tone vocabulary as an input.

The register section 8 floor does cover role/lane mapping, two exact FleetTable strings, PhaseGantt layout locals, no `export let`/`$:` in Svelte files, and selected source pins. It does not cover a general colour-token rule.

## What the recon could not establish

Register section 10 records four absences, and none should be upgraded to a fact:

1. No repo file establishes where the ratified role palette was ratified; the durable trace is the shape suite check and the lane alias block at `visualizer/web/src/lib/theme.css:122` through `visualizer/web/src/lib/theme.css:129`.
2. No commit body explains why the role colours were chosen.
3. No rendered-page observation was available; L10, L11, D2 consequences, and visual appearance are source-derived, while the ratios above are arithmetic.
4. The recon did not trace whether the live ledger can carry `scout` or `advisor` in `agent_sessions.role`, and did not establish whether a skipped phase with no lane occurs.

Neither limit - the paper-ground contrast finding nor the vacuous theme.css test - is fixed by this lane. Record the evidence boundary when a future change proposes to fix either one.
