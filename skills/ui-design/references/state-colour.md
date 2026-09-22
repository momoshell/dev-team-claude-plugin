# State, role, and lane colour

This reference turns the measured R1-R5 decisions and the documented L1 inventory plus L2, L3, L6, L10, and L11 departures in this file into constraints for a new component. The system is strongest for chrome and weakest for state colour; copy the rule, not the majority habit.

## R1 - derive a tone, then map class to token

Keep status policy in the data layer. `visualizer/web/src/lib/fleet.js:518` (`deriveStatus`) returns `{ key, word, tone, where, why }` with tones including `serious`, `ok`, `fail`, `aborted`, `quiet`, and `busy`, where the `quiet` tone covers the queued and unknown cases. A component interpolates that tone into a class at `visualizer/web/src/lib/RunCard.svelte:53` and the equivalent row at `visualizer/web/src/lib/FleetTable.svelte:14`, while CSS maps class to an alias at `visualizer/web/src/lib/RunCard.svelte:65` through `visualizer/web/src/lib/RunCard.svelte:69` and at `visualizer/web/src/lib/FleetTable.svelte:37` through `visualizer/web/src/lib/FleetTable.svelte:41`.

A component never decides colour: render the tone returned by the shaper, and let CSS map class -> token. No component reads `run.status` to pick a colour. The tone vocabulary is pinned by the shaper tests in `test/visualizer-panels.test.mjs` and `test/visualizer-teardown.test.mjs`; no broad test proves every tone-to-token mapping.

## R2 - role colour is token indirection

Pass the role suffix through one custom-property indirection and let the stylesheet paint the alias. `visualizer/web/src/lib/RoleTag.svelte:4` sets `--role-color: var(--role-${role})`; `visualizer/web/src/lib/RoleTag.svelte:9` paints the swatch from that indirection. The role string must match a declared alias suffix exactly. Do not replace this with a raw half-palette or a guessed map.

## R3 - lane colour uses the same indirection

Use the lane index only through a lane alias. `visualizer/web/src/lib/PhaseDots.svelte:5` sets the lane indirection and `visualizer/web/src/lib/PhaseDots.svelte:8` paints it; `visualizer/web/src/lib/PhaseGantt.svelte:146` supplies the bar lane variable. Lanes 0-5 follow `ROLE_ORDER` from `visualizer/web/src/lib/trace.js:3`; `--lane-N` exists only for N in 0-7, from `visualizer/web/src/lib/theme.css:122` through `visualizer/web/src/lib/theme.css:129`.

## R4 - role/lane use is delegated, but the allowlist is finite

Keep role/lane naming out of ordinary panels and delegate to role or phase components. The current hand-maintained allowlist is `visualizer/web/src/App.svelte`, `visualizer/web/src/lib/FleetTable.svelte`, `visualizer/web/src/lib/RunCard.svelte`, `visualizer/web/src/lib/Filters.svelte`, plus `visualizer/web/src/lib/TeardownPanel.svelte` and `visualizer/web/src/lib/RosterPanel.svelte`. `RoleTag.svelte` is the positive case. `visualizer/web/src/lib/PhaseGantt.svelte:143` names the lane variable directly while simply not being on the list. Treat this as a legacy detector, not a principle that protects a component written tomorrow. The isolation list is pinned by the visualizer panel, teardown, and server suites; read those suites before adding a component to the list.

## R5 - choose a fallback deliberately

The lane fallback is the `?? 6` overflow index at `visualizer/web/src/lib/PhaseGantt.svelte:143` and `visualizer/web/src/lib/PhaseGantt.svelte:146`, which resolves to the neutral overflow alias; `visualizer/web/src/lib/PhaseDots.svelte:8` and `visualizer/web/src/lib/RoleTag.svelte:9` carry no fallback. An unknown role, missing link, or out-of-range lane therefore has different source-level policies. For a new component, state the fallback in the same rule and ensure an unresolved token cannot silently become an invisible mark.

## L1 - measured state-colour leak inventory

The measured leak is **22 hex literals in 4 of 33 components**. They are all state colours, so they remain theme-invariant. The complete inventory is:

| File and exhibit | Literals | Count |
|---|---|---:|
| `visualizer/web/src/lib/GateChips.svelte:13` | `#166534`, `#dcfce7`, `#991b1b`, `#fee2e2` | 4 |
| `visualizer/web/src/lib/AcceptPanel.svelte:23` | `#166534`, `#dcfce7`, `#991b1b`, `#fee2e2` | 4 |
| `visualizer/web/src/lib/PhasePanel.svelte:100` | `#166534`, `#dcfce7`, `#991b1b`, `#fee2e2`, `#92400e`, `#fef3c7` | 6 |
| `visualizer/web/src/lib/PhaseGantt.svelte:257` | `#071015`, `#fff`, `#611`, `#ffd6d6`, `#073e24`, `#c6f7d8`, `#614200`, `#ffe7a9` | 8 |
| **Total** | **22 hex** | **22** |

Six rows from the earlier inventory are gone upstream and are recorded here without line pins so no stale citation survives: the IntakePanel, CellHealthPanel, and RunSetPanel hex rows carry no hex literal in CSS anymore; the RunDetail and EnvelopeInspector `.error` rules are token-correct now; and the RosterEditor file was deleted, with RosterPanel carrying none of its behaviours. The chip pairs are an old state-colour policy, not a permission for a new component. The old `#123` / `#83` copy traps are gone as well: neither the EventStream nor the MetricsStrip source carries a hex literal in CSS anymore.

## Other measured departures that matter

- **L2 - escalation alias:** the rail paints only aliases at `visualizer/web/src/App.svelte:246` (`.rail-status.serious` reads `--status-escalated`); no `--serious` read remains in App.svelte. The token-correct exhibit is the notice rule at `visualizer/web/src/lib/RosterPanel.svelte:693`. Use the alias.
- **L3 - separator as surface:** the old RosterEditor `pre` coated in `background:var(--line)` is gone with the file and has no equivalent in RosterPanel. The recessed-surface rule is: use `var(--bg)` for a surface recessed inside a panel, exhibited at `visualizer/web/src/lib/IntakePanel.svelte:90` (`.loop-state`), `visualizer/web/src/lib/IntakePanel.svelte:91` (`.actor input`), `visualizer/web/src/lib/RosterPanel.svelte:708` (`.source-setup input`), and `visualizer/web/src/lib/RosterPanel.svelte:721` (`.pick-evidence pre`). Do not use a hairline token as a fill.
- **L6 - dead declaration:** `visualizer/web/src/lib/FleetTable.svelte:36` gives `.status-dot` `background:var(--neutral)`, then `visualizer/web/src/lib/FleetTable.svelte:42` replaces it with `background:currentColor`; remove neither rule by guessing which one was intended.
- **L10 - incomplete role vocabulary:** `scout` and `advisor` appear in the crew sources but have no `--role-*` token. `visualizer/web/src/lib/RoleTag.svelte:9` has no fallback, so the source has an unresolved-colour path. The gantt defaults unlinked blocks to lane 6 at `visualizer/web/src/lib/PhaseGantt.svelte:143`.
- **L11 - first-paint and UA limit:** `visualizer/web/index.html:2` has no `color-scheme` metadata, `theme.css` sets `color-scheme` only inside the theme blocks, and `visualizer/web/src/App.svelte:72` writes the theme after mount while `visualizer/web/src/App.svelte:73` deletes the attribute for the system choice. The register marks the scrollbar/control rendering and first-paint flash as source-derived browser consequences, not rendered measurements.

## Divergences: encode the boundary, not the majority

- **D4:** the old 3-vs-2 majority is gone: no hard-coded `#b42318` `.error` remains. The token-correct `var(--status-fail)` form appears in `visualizer/web/src/lib/RunDetail.svelte:294` (`.error-banner`), `visualizer/web/src/lib/EnvelopeInspector.svelte:85` (`.error`), and `visualizer/web/src/App.svelte:246` (`.rail-status.fail`), alongside the roster notice rule. Following a hard-coded majority would now be wrong twice over: the majority no longer exists, and the surviving rule is the alias.
- **D5:** `unproven` has four policies: an amber chip (`#92400e` on `#fef3c7`) at `visualizer/web/src/lib/PhasePanel.svelte:100`; muted text with a `color-mix` fill at `visualizer/web/src/lib/GateChips.svelte:13`; pale text `#ffe7a9` at `visualizer/web/src/lib/PhaseGantt.svelte:257`; and `var(--status-running)` at `visualizer/web/src/lib/TeardownPanel.svelte:63`. `proven` and `failed` likewise mix chip pairs, gantt colours, and status aliases. Choose one token policy for new state, do not infer it from the most common old rule.
- **D6:** `deriveStatus` emits `quiet` for queued and unknown at `visualizer/web/src/lib/fleet.js:533-535`, but only the attention rail defines those tones; the RunCard class map at `visualizer/web/src/lib/RunCard.svelte:66` through `visualizer/web/src/lib/RunCard.svelte:69` and the FleetTable class map at `visualizer/web/src/lib/FleetTable.svelte:37` through `visualizer/web/src/lib/FleetTable.svelte:41` omit `quiet`. Require every emitted tone to have a class rule in every consumer, or state the absence explicitly.
- **D10:** the old global `border-radius:0` reset is gone from `theme.css`; the surviving global reset is the box-sizing rule at `visualizer/web/src/lib/theme.css:141`, and `visualizer/web/src/App.svelte:233` restates it. Components reintroduce corners through the panel and status idioms. A new component follows the actual boundary rather than reading `theme.css` alone and concluding that every surface is square.

The register also records C9's honest blank as the state-safe alternative: unmeasured values render a muted em-dash or reasoned sentence with a `title`, often with a dashed underline; see `visualizer/web/src/lib/RunCard.svelte:53`, the `{@render mark(...)}` rows at `visualizer/web/src/lib/FleetTable.svelte:15-21` ending at `visualizer/web/src/lib/FleetTable.svelte:21`, and ADR-029 section 2 at `docs/adr/adr-029-headless-observability-interjection.md:23`. State colour must not turn absence into a measured-looking zero.
