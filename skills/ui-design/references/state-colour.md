# State, role, and lane colour

This reference turns the measured R1–R5 decisions and L1–L12 departures in `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md` §§5–7 into constraints for a new component. The system is strongest for chrome and weakest for state colour; copy the rule, not the majority habit.

## R1 — derive a tone, then map class to token

Keep status policy in the data layer. `visualizer/web/src/lib/fleet.js:53–61` (`deriveStatus`) returns `{ key, word, tone, where, why }` with `tone ∈ { serious, ok, fail, quiet, busy }`. A component interpolates that tone into a class — `class={\`status ${status.tone}\`}` at `visualizer/web/src/lib/RunCard.svelte:52` and the equivalent row at `visualizer/web/src/lib/FleetTable.svelte:14` — while CSS maps class to an alias at `RunCard.svelte:65–68` and `FleetTable.svelte:37–40`.

A component never decides colour: render the tone returned by the shaper, and let CSS map class -> token. No component reads `run.status` to pick a colour. The tone vocabulary is pinned by shaper tests at `test/visualizer-panels.test.mjs:280–282,307–308,387,443–444,500,521–531,715` and `test/visualizer-teardown.test.mjs:119–120`; no broad test proves every tone-to-token mapping.

## R2 — role colour is token indirection

Pass the role suffix through one custom-property indirection and let the stylesheet paint the alias. `visualizer/web/src/lib/RoleTag.svelte:4` sets `--role-color: var(--role-${role})`; `RoleTag.svelte:9` paints `.swatch { background:var(--role-color) }`. The role string must match a declared alias suffix exactly. Do not replace this with a raw half-palette or a guessed map.

## R3 — lane colour uses the same indirection

Use the lane index only through a lane alias. `visualizer/web/src/lib/PhaseDots.svelte:5` sets `--lane-color: var(--lane-${phase.lane})` and `:8` paints it; `visualizer/web/src/lib/PhaseGantt.svelte:48` sets the lane variable and `:59` supplies `var(--lane-color, var(--lane-0))`. Lanes 0–5 follow `ROLE_ORDER` from `visualizer/web/src/lib/trace.js:3`; `--lane-N` exists only for N ∈ 0…7 in `visualizer/web/src/lib/theme.css:57–64`.

## R4 — role/lane use is delegated, but the allowlist is finite

Keep role/lane naming out of ordinary panels and delegate to role or phase components. The current hand-maintained six-filename allowlist is `visualizer/web/src/App.svelte`, `visualizer/web/src/lib/FleetTable.svelte`, `visualizer/web/src/lib/RunCard.svelte`, `visualizer/web/src/lib/Filters.svelte` (forbidden at `test/visualizer-panels.test.mjs:660–662`), plus `visualizer/web/src/lib/TeardownPanel.svelte` (added at `test/visualizer-teardown.test.mjs:201`) and `visualizer/web/src/lib/RosterPanel.svelte` (added at `test/visualizer-server.test.mjs:1396`). `RoleTag.svelte` is the positive case. `PhaseGantt.svelte:48` names `--lane-` directly while simply not being on the list. Treat this as a legacy detector, not a principle that protects a component written tomorrow.

## R5 — choose a fallback deliberately

`PhaseGantt.svelte:59` has a `var(--lane-color, var(--lane-0))` fallback; `PhaseDots.svelte:8` and `RoleTag.svelte:9` do not. An unknown role, missing link, or out-of-range lane therefore has different source-level policies. For a new component, state the fallback in the same rule and ensure an unresolved token cannot silently become an invisible mark.

## L1 — measured state-colour leak inventory

The measured leak is **34 colour literals in 10 of 21 components**: 33 hex literals plus one named `white`. They are all state colours, so they remain theme-invariant. The complete inventory is:

| File and exhibit | Literals | Count |
|---|---|---:|
| `visualizer/web/src/lib/GateChips.svelte:13` | `#166534`, `#dcfce7`, `#991b1b`, `#fee2e2` | 4 |
| `visualizer/web/src/lib/AcceptPanel.svelte:36` | `#166534`, `#dcfce7`, `#991b1b`, `#fee2e2` | 4 |
| `visualizer/web/src/lib/PhasePanel.svelte:62` | `#166534`, `#dcfce7`, `#991b1b`, `#fee2e2`, `#92400e`, `#fef3c7` | 6 |
| `visualizer/web/src/lib/PhaseGantt.svelte:59` | `#fff`, `#d8ffd9`, `#ffd1d1`, `#ffe4a3` | 4 |
| `visualizer/web/src/lib/IntakePanel.svelte:122` | `#9b1c1c` ×3, `#7a3e9d` ×3 | 6 |
| `visualizer/web/src/lib/CellHealthPanel.svelte:61` | `#7a3e9d`, `#9a6700`, `#176b3a` | 3 |
| `visualizer/web/src/lib/RunSetPanel.svelte:61` | `#176b3a`, `#9b1c1c`, `#7a3e9d` | 3 |
| `visualizer/web/src/lib/RunDetail.svelte:33` | `#b42318` | 1 |
| `visualizer/web/src/lib/EnvelopeInspector.svelte:48` | `#b42318`, `white` | 2 |
| `visualizer/web/src/lib/RosterEditor.svelte:71` | `#b42318` | 1 |
| **Total** | **33 hex + one named colour** | **34** |

The chip pairs are an old state-colour policy, not a permission for a new component. A naive hex sweep also sees copy, not colour: `visualizer/web/src/lib/EventStream.svelte:29` has `#123` in an issue reference and `visualizer/web/src/lib/MetricsStrip.svelte:19` has `#83`.

## Other measured departures that matter

- **L2 — raw escalation read:** `visualizer/web/src/App.svelte:201–202` uses `--serious` for the rail, then `:208` correctly uses `--status-escalated`; `visualizer/web/src/lib/RosterPanel.svelte:187` is also correct. Use the alias.
- **L3 — separator as surface:** `visualizer/web/src/lib/RosterEditor.svelte:71` paints `pre` with `background:var(--line)` even though the recessed surface is `--bg`. Do not use a hairline token as a fill.
- **L6 — dead declaration:** `visualizer/web/src/lib/FleetTable.svelte:36` gives `.status-dot` `background:var(--neutral)`, then `:42` replaces it with `background:currentColor`; remove neither rule by guessing which one was intended.
- **L10 — incomplete role vocabulary:** `scout` (32 uses) and `advisor` (3 uses) appear in `crew/*.mjs` but have no `--role-*` token; `visualizer/web/src/lib/PhaseGantt.svelte:40` also passes `'unlinked'`. `RoleTag.svelte:9` has no fallback, so the source has an unresolved-colour path.
- **L11 — first-paint and UA limit:** `visualizer/web/index.html:2` has no `color-scheme` metadata, `theme.css` sets no `color-scheme`, and `App.svelte:46–51` applies the chosen theme after mount. The register marks the scrollbar/control rendering and first-paint flash as source-derived browser consequences, not rendered measurements.

## Divergences: encode the boundary, not the majority

- **D4:** `.error` is hard-coded `#b42318` in `visualizer/web/src/lib/RunDetail.svelte:33`, `EnvelopeInspector.svelte:48`, and `RosterEditor.svelte:71` (3, majority), but token-correct `var(--status-fail)` appears in `App.svelte:200` and `RosterPanel.svelte:187` (2). Following the majority is explicitly wrong.
- **D5:** `unproven` has four policies: an amber chip (`#92400e` on `#fef3c7`) at `PhasePanel.svelte:62`; muted text with a `color-mix` fill at `GateChips.svelte:13`; pale text `#ffe4a3` at `PhaseGantt.svelte:59`; and `var(--status-running)` at `TeardownPanel.svelte:54`. `proven` and `failed` likewise mix chip pairs, gantt colours, and status aliases. Choose one token policy for new state, do not infer it from the most common old rule.
- **D6:** `deriveStatus` emits `quiet` for queued and unknown at `visualizer/web/src/lib/fleet.js:58,60`, but only `App.svelte:209` defines `.chip.quiet`; `RunCard.svelte:65–68` and `FleetTable.svelte:37–40` omit it. Require every emitted tone to have a class rule in every consumer, or state the absence explicitly.
- **D10:** `visualizer/web/src/lib/theme.css:129,131` globally resets `border-radius:0`, and `App.svelte:192` repeats the form reset, but 20 radius declarations in 11 components reintroduce corners: `.6rem` ×11, `1rem` ×3, `999px` ×3, plus the smaller block/marker and dot forms. A new component follows the actual boundary—panel and status idioms intentionally reintroduce shape—rather than reading `theme.css` alone and concluding that every surface is square.

The register also records C9's honest blank as the state-safe alternative: unmeasured values render a muted em-dash or reasoned sentence with a `title`, often with a dashed underline; see `visualizer/web/src/lib/RunCard.svelte:53`, `FleetTable.svelte:15–21`, and ADR-029 §2 at `docs/adr/adr-029-headless-observability-interjection.md:23`. State colour must not turn absence into a measured-looking zero.
