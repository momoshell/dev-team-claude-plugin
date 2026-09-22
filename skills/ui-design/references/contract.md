# Theming contract

The contract below is the checkable boundary recorded in `visualizer/web/src/lib/theme.css` and the visualizer suites (`test/visualizer-shape.test.mjs`, `test/visualizer-panels.test.mjs`, `test/visualizer-teardown.test.mjs`, `test/visualizer-server.test.mjs`). It describes the code that exists; it does not turn an unmeasured convention into a test.

## T1 - component names only Tier-2 aliases

A component may name only Tier-2 aliases: `--bg`, `--panel`, `--line`, `--muted`, `--accent`, `--neutral`, the `--status-*` aliases, `--status-escalated`, the six `--role-*` aliases, and `--lane-0` through `--lane-7`. It must not name a raw `--ink-*`, `--paper-*`, `--spot-*`, role `-dark`/`-light` half, `--serious`, or `-raw` status token. The raw block opens at `visualizer/web/src/lib/theme.css:2`, and `--serious` stays raw at `visualizer/web/src/lib/theme.css:28`. The old recorded App.svelte `--serious` exception is gone: the rail paints only aliases at `visualizer/web/src/App.svelte:246`, so the obedience count must be remeasured before anyone claims a number. Exhibit: the raw block and the measured suite pins below.

## T2 - painted colour comes from a token

Make every painted foreground, background, border, marker, and fill resolve to a token rather than a literal colour. The measured code violates this in **4 of 33 components, 22 times**, all in state-colour rules; the inventory is in `references/state-colour.md` L1. Exhibit: `visualizer/web/src/lib/GateChips.svelte:13`, `visualizer/web/src/lib/AcceptPanel.svelte:23`, `visualizer/web/src/lib/PhasePanel.svelte:100`, and the gantt row at `visualizer/web/src/lib/PhaseGantt.svelte:257`. The suite currently has no general hex ban and no general requirement that a colour declaration use `var()`.

## T3 - escalation goes through the alias

Use `--status-escalated` in a component; treat `--serious` as raw. Both escalation exhibits are now alias-correct: `visualizer/web/src/App.svelte:246` paints the rail tones from `--status-escalated`, and `visualizer/web/src/lib/RosterPanel.svelte:693` paints the notice from `--status-fail`. No `--serious` read remains in App.svelte. This is a naming boundary even though both names currently resolve identically.

## T4 - one owner writes the theme switch

Only `visualizer/web/src/App.svelte:72` may write `document.documentElement.dataset.theme`, with `visualizer/web/src/App.svelte:73` deleting it for the system choice; `theme.css` may declare the selectors but no other component may set the attribute. Exhibit: `visualizer/web/src/App.svelte:26` and `visualizer/web/src/App.svelte:27` read the persisted `os`/`paper`/`ink` value, `visualizer/web/src/App.svelte:74` persists the choice, and `visualizer/web/src/App.svelte:173` offers the selector. The repo-wide grep found only the theme selectors in `visualizer/web/src/lib/theme.css:44`, `visualizer/web/src/lib/theme.css:69`, and `visualizer/web/src/lib/theme.css:95` plus those App writes.

## What the switch means

The three blocks are a cascade, not three independent palettes: `:root[data-theme='paper']` at `visualizer/web/src/lib/theme.css:44` is the paper default; `:root[data-theme='ink']` at `visualizer/web/src/lib/theme.css:69` wins for explicit ink; and the guarded media block at `visualizer/web/src/lib/theme.css:94` with its inner selector at `visualizer/web/src/lib/theme.css:95` supplies ink values only when the OS is dark and paper was not explicitly selected. A component consumes aliases and never performs this selection itself.

## What the suite enforces today

The mechanical floor is narrow and must be described honestly:

- `test/visualizer-shape.test.mjs` checks role/lane name presence against `theme.css`: each role name exists and each lane index points at the expected role. It inspects no colour value or count.
- `test/visualizer-panels.test.mjs` pins two exact FleetTable CSS strings: the stale rule at `visualizer/web/src/lib/FleetTable.svelte:36` and its `currentColor` replacement at `visualizer/web/src/lib/FleetTable.svelte:42`, including the escalation status rule at `visualizer/web/src/lib/FleetTable.svelte:41`.
- `test/visualizer-panels.test.mjs` pins PhaseGantt's `--identity-column`, `--lane-gap`, and their `calc()` geometry at `visualizer/web/src/lib/PhaseGantt.svelte:254`.
- The role/lane isolation list names the panel suites, with `visualizer/web/src/lib/TeardownPanel.svelte` and `visualizer/web/src/lib/RosterPanel.svelte` covered by the teardown and server suites.
- The blanket Svelte shape rule bans `export let` and `$:` in every `.svelte` file; components use runes instead.

There is no suite rule banning a hex colour, requiring every painted colour to be a token, counting declarations in `theme.css`, checking theme values, checking `data-theme`, or checking `prefers-color-scheme`. A checker author must not mistake issue prose for a colour: the old EventStream `#123` and MetricsStrip `#83` copy traps are gone from the sources. Restrict a detector to CSS values.

The six-filename role/lane blocklist, the exact FleetTable rules, the PhaseGantt locals, and the runes-only rule are the floor inherited by a new component. They are not evidence that T2 is enforced; a skill remains the broader constraint.

## Tabular numerals — measured register

A component belongs in this census when its markup applies `mono` to runtime content or its local `.mono` rule declares `font-variant-numeric:tabular-nums`. Monospace alone (`font-family:var(--mono)` without the numeric declaration and without a `mono` class on runtime content) is not compliance. The global rule lives at `visualizer/web/src/lib/theme.css:165`; the only local tabular rule is at `visualizer/web/src/lib/RunCard.svelte:73`.

| Component | Verdict | Rule source |
|---|---|---|
| `AgentsPage.svelte` | compliant | global `.mono` at `visualizer/web/src/lib/theme.css:165` |
| `EventStory.svelte` | compliant | global `.mono` at `visualizer/web/src/lib/theme.css:165` |
| `FleetTable.svelte` | compliant | global `.mono` at `visualizer/web/src/lib/theme.css:165` |
| `RunCard.svelte` | compliant | local `.mono` at `visualizer/web/src/lib/RunCard.svelte:73` |
| `WorkflowsPage.svelte` | compliant | global `.mono` at `visualizer/web/src/lib/theme.css:165` |

`5/5 compliant, 0/5 non-compliant`.
