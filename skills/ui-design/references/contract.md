# Theming contract

The contract below is the checkable boundary recorded in `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md` §2 and §8. It describes the code that exists; it does not turn an unmeasured convention into a test.

## T1 — component names only Tier-2 aliases

A component may name only Tier-2 aliases: `--bg`, `--panel`, `--line`, `--muted`, `--accent`, `--neutral`, the `--status-*` aliases, `--status-escalated`, the six `--role-*` aliases, and `--lane-0` through `--lane-7`. It must not name a raw `--ink-*`, `--paper-*`, `--spot-*`, role `-dark`/`-light` half, `--serious`, or `-raw` status token. A `var(--…)` census over the 21 components obeys T1 at **21/21**, with the measured component-local layout and indirection exceptions in `references/tokens.md`. Exhibit: `visualizer/web/src/lib/theme.css:2–32, 36–127` and the register §2.

## T2 — painted colour comes from a token

Make every painted foreground, background, border, marker, and fill resolve to a token rather than a literal colour. The measured code violates this in **10 of 21 components, 34 times**, all in state-colour rules; the inventory is in `references/state-colour.md` L1. Exhibit: `visualizer/web/src/lib/GateChips.svelte:13`, `AcceptPanel.svelte:36`, `PhasePanel.svelte:62`, and the other L1 rows. The suite currently has no general hex ban and no general requirement that a colour declaration use `var()`.

## T3 — escalation goes through the alias

Use `--status-escalated` in a component; treat `--serious` as raw. T3 has one file-level violation that is immediately followed by the correct form: `visualizer/web/src/App.svelte:201–202` reads `--serious` for the rail, while `App.svelte:208` reads `--status-escalated` for `.chip.serious`. The same alias is used at `visualizer/web/src/lib/RosterPanel.svelte:187`. This is a naming boundary even though both names currently resolve identically.

## T4 — one owner writes the theme switch

Only `App.svelte:46–51` may write `document.documentElement.dataset.theme`; `theme.css` may declare the selectors but no other component may set the attribute. Exhibit: `visualizer/web/src/App.svelte:17–21, 44–51, 130` reads the persisted `os`/`paper`/`ink` value, writes `data-theme` for the two explicit themes, deletes it for `os`, and persists the choice. The repo-wide grep found only the theme selectors in `visualizer/web/src/lib/theme.css:36,67,98` and those two App writes.

## What the switch means

The three blocks are a cascade, not three independent palettes: bare `:root, :root[data-theme='paper']` at `visualizer/web/src/lib/theme.css:36` is the paper default; `:root[data-theme='ink']` at `:67` wins for explicit ink; and the guarded media block at `:97–98` supplies ink values only when the OS is dark and paper was not explicitly selected. A component consumes aliases and never performs this selection itself.

## What the suite enforces today

The mechanical floor is narrow and must be described honestly:

- `test/visualizer-shape.test.mjs:286–292` checks 12 role/lane name-presence regexes against `theme.css`: each role name exists and each lane index points at the expected role. It inspects no colour value or count.
- `test/visualizer-panels.test.mjs:627,629` pins two exact FleetTable CSS strings, including the stale and escalation status rules.
- `test/visualizer-panels.test.mjs:845–847` pins PhaseGantt's `--identity-column`, `--lane-gap`, and their `calc()` geometry.
- The role/lane isolation list is pinned by `test/visualizer-panels.test.mjs:660–665`, with `visualizer/web/src/lib/TeardownPanel.svelte` added by `test/visualizer-teardown.test.mjs:201` and `visualizer/web/src/lib/RosterPanel.svelte` added by `test/visualizer-server.test.mjs:1396`.
- The blanket Svelte shape rule at `test/visualizer-shape.test.mjs:750–751` bans `export let` and `$:` in every `.svelte` file; components use runes instead.

There is no suite rule banning a hex colour, requiring every painted colour to be a token, counting declarations in `theme.css`, checking theme values, checking `data-theme`, or checking `prefers-color-scheme`. A checker author must not mistake issue prose for a colour: `visualizer/web/src/lib/EventStream.svelte:29` contains `#123` in `(#123)`, and `visualizer/web/src/lib/MetricsStrip.svelte:19` contains `#83` in `(#83)`. Those are the measured grep traps; restrict a detector to CSS values.

The six-filename role/lane blocklist, the exact FleetTable rules, the PhaseGantt locals, and the runes-only rule are the floor inherited by a new component. They are not evidence that T2 is enforced; a skill remains the broader constraint.
