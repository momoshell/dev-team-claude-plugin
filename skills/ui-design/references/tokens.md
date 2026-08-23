# Token vocabulary

This reference records the measured vocabulary in `visualizer/web/src/lib/theme.css`; it does not invent a palette. The canonical source is `visualizer/web/src/lib/theme.css`. A component-facing rule is useful only when it can be traced to that file and its lines.

## The census

`theme.css declares 105 custom-property declarations: 30 raw tokens plus 25 aliases repeated in three theme blocks, 55 unique names.` An earlier grep reported 113 because it counted `var()` references; the recomputed declaration count is 105. The 30 raw declarations are in the opening `:root` block at lines 2–32, including `--mono`; the 25 alias names are redeclared in the paper, ink, and media-dark blocks.

## Tier 1: raw tokens

Raw tokens are declared once and are theme-specific or literal implementation data. Components do not name them. Every raw hex value from the opening block is listed here, with its declaration anchor.

| Group | Raw token | Value | Exhibit |
|---|---|---|---|
| ink ground ramp | `--ink-ground` | `#17171a` | `visualizer/web/src/lib/theme.css:2` |
| ink panel ramp | `--ink-panel` | `#1e1e22` | `visualizer/web/src/lib/theme.css:3` |
| ink hairline ramp | `--ink-hairline` | `#26262b` | `visualizer/web/src/lib/theme.css:4` |
| ink text ramp | `--ink-text` | `#eae8ee` | `visualizer/web/src/lib/theme.css:5` |
| ink muted ramp | `--ink-muted` | `#9b99a3` | `visualizer/web/src/lib/theme.css:6` |
| paper ground ramp | `--paper-ground` | `#efece5` | `visualizer/web/src/lib/theme.css:7` |
| paper panel ramp | `--paper-panel` | `#e7e3da` | `visualizer/web/src/lib/theme.css:8` |
| paper hairline ramp | `--paper-hairline` | `#e2ded4` | `visualizer/web/src/lib/theme.css:9` |
| paper text ramp | `--paper-text` | `#15140f` | `visualizer/web/src/lib/theme.css:10` |
| paper muted ramp | `--paper-muted` | `#55534a` | `visualizer/web/src/lib/theme.css:11` |
| spot light | `--spot-light` | `#8839ef` | `visualizer/web/src/lib/theme.css:12` |
| spot dark | `--spot-dark` | `#cba6f7` | `visualizer/web/src/lib/theme.css:13` |
| planner ink | `--role-planner-dark` | `#3987e5` | `visualizer/web/src/lib/theme.css:14` |
| builder ink | `--role-builder-dark` | `#d95926` | `visualizer/web/src/lib/theme.css:15` |
| reviewer ink | `--role-reviewer-dark` | `#199e70` | `visualizer/web/src/lib/theme.css:16` |
| tech-lead ink | `--role-tech-lead-dark` | `#c98500` | `visualizer/web/src/lib/theme.css:17` |
| lead ink | `--role-lead-dark` | `#d55181` | `visualizer/web/src/lib/theme.css:18` |
| driver ink | `--role-driver-dark` | `#9085e9` | `visualizer/web/src/lib/theme.css:19` |
| planner paper | `--role-planner-light` | `#2a78d6` | `visualizer/web/src/lib/theme.css:20` |
| builder paper | `--role-builder-light` | `#eb6834` | `visualizer/web/src/lib/theme.css:21` |
| reviewer paper | `--role-reviewer-light` | `#1baf7a` | `visualizer/web/src/lib/theme.css:22` |
| tech-lead paper | `--role-tech-lead-light` | `#eda100` | `visualizer/web/src/lib/theme.css:23` |
| lead paper | `--role-lead-light` | `#e87ba4` | `visualizer/web/src/lib/theme.css:24` |
| driver paper | `--role-driver-light` | `#4a3aa7` | `visualizer/web/src/lib/theme.css:25` |
| escalation | `--serious` | `#ec835a` | `visualizer/web/src/lib/theme.css:26` |
| status ok | `--status-ok-raw` | `#2f9e62` | `visualizer/web/src/lib/theme.css:28` |
| status fail | `--status-fail-raw` | `#c94f58` | `visualizer/web/src/lib/theme.css:29` |
| status running | `--status-running-raw` | `#c38b18` | `visualizer/web/src/lib/theme.css:30` |
| status skipped | `--status-skipped-raw` | `#77747d` | `visualizer/web/src/lib/theme.css:31` |
| type | `--mono` | font stack, not a colour | `visualizer/web/src/lib/theme.css:32` |

The only prose in the sheet is the operational-status comment at `visualizer/web/src/lib/theme.css:27`. It separates the six ratified role colours from the four operational status steps. Do not make a component read `--ink-*`, `--paper-*`, `--spot-*`, a role `-dark`/`-light` half, `--serious`, or a `-raw` status name.

## Tier 2: aliases

These are the component-facing names. The paper and ink columns identify the value reached after the three-block cascade; status and escalation deliberately resolve identically in both themes.

| Purpose | Tier-2 alias | Paper resolves to | Ink resolves to | Evidence |
|---|---|---|---|---|
| page ground | `--bg` | `--paper-ground` (`#efece5`) | `--ink-ground` (`#17171a`) | `visualizer/web/src/lib/theme.css:40,71` |
| raised surface | `--panel` | `--paper-panel` (`#e7e3da`) | `--ink-panel` (`#1e1e22`) | `visualizer/web/src/lib/theme.css:41,72` |
| separator | `--line` | `--paper-hairline` (`#e2ded4`) | `--ink-hairline` (`#26262b`) | `visualizer/web/src/lib/theme.css:42,73` |
| secondary text | `--muted` | `--paper-muted` (`#55534a`) | `--ink-muted` (`#9b99a3`) | `visualizer/web/src/lib/theme.css:43,74` |
| interactive accent | `--accent` | `--spot-light` (`#8839ef`) | `--spot-dark` (`#cba6f7`) | `visualizer/web/src/lib/theme.css:44,75` |
| inert fill | `--neutral` | `--paper-muted` (`#55534a`) | `--ink-muted` (`#9b99a3`) | `visualizer/web/src/lib/theme.css:45,76` |
| status success | `--status-ok` | `--status-ok-raw` (`#2f9e62`) | `--status-ok-raw` (`#2f9e62`) | `visualizer/web/src/lib/theme.css:46,77` |
| status failure | `--status-fail` | `--status-fail-raw` (`#c94f58`) | `--status-fail-raw` (`#c94f58`) | `visualizer/web/src/lib/theme.css:47,78` |
| status running | `--status-running` | `--status-running-raw` (`#c38b18`) | `--status-running-raw` (`#c38b18`) | `visualizer/web/src/lib/theme.css:48,79` |
| status skipped | `--status-skipped` | `--status-skipped-raw` (`#77747d`) | `--status-skipped-raw` (`#77747d`) | `visualizer/web/src/lib/theme.css:49,80` |
| escalation | `--status-escalated` | `--serious` (`#ec835a`) | `--serious` (`#ec835a`) | `visualizer/web/src/lib/theme.css:50,81` |
| planner role | `--role-planner` | `--role-planner-light` (`#2a78d6`) | `--role-planner-dark` (`#3987e5`) | `visualizer/web/src/lib/theme.css:51,82` |
| builder role | `--role-builder` | `--role-builder-light` (`#eb6834`) | `--role-builder-dark` (`#d95926`) | `visualizer/web/src/lib/theme.css:52,83` |
| reviewer role | `--role-reviewer` | `--role-reviewer-light` (`#1baf7a`) | `--role-reviewer-dark` (`#199e70`) | `visualizer/web/src/lib/theme.css:53,84` |
| tech-lead role | `--role-tech-lead` | `--role-tech-lead-light` (`#eda100`) | `--role-tech-lead-dark` (`#c98500`) | `visualizer/web/src/lib/theme.css:54,85` |
| lead role | `--role-lead` | `--role-lead-light` (`#e87ba4`) | `--role-lead-dark` (`#d55181`) | `visualizer/web/src/lib/theme.css:55,86` |
| driver role | `--role-driver` | `--role-driver-light` (`#4a3aa7`) | `--role-driver-dark` (`#9085e9`) | `visualizer/web/src/lib/theme.css:56,87` |
| lane 0 | `--lane-0` | `--role-planner` | `--role-planner` | `visualizer/web/src/lib/theme.css:57,88` |
| lane 1 | `--lane-1` | `--role-builder` | `--role-builder` | `visualizer/web/src/lib/theme.css:58,89` |
| lane 2 | `--lane-2` | `--role-reviewer` | `--role-reviewer` | `visualizer/web/src/lib/theme.css:59,90` |
| lane 3 | `--lane-3` | `--role-tech-lead` | `--role-tech-lead` | `visualizer/web/src/lib/theme.css:60,91` |
| lane 4 | `--lane-4` | `--role-lead` | `--role-lead` | `visualizer/web/src/lib/theme.css:61,92` |
| lane 5 | `--lane-5` | `--role-driver` | `--role-driver` | `visualizer/web/src/lib/theme.css:62,93` |
| lane 6 overflow | `--lane-6` | `--neutral` | `--neutral` | `visualizer/web/src/lib/theme.css:63,94` |
| lane 7 overflow | `--lane-7` | `--muted` | `--muted` | `visualizer/web/src/lib/theme.css:64,95` |

`--neutral` and `--muted` are the same colour in both themes, so `--lane-6` and `--lane-7` are indistinguishable (register §1, L9). The lane vocabulary ends at N ∈ 0…7; there is no `--lane-8`. Status aliases and `--status-escalated` are also identical in paper and ink, which is why the contrast limit belongs in `references/limits.md` rather than being hidden by the alias table.

## Cascade and legitimate locals

The paper block is `:root, :root[data-theme='paper']` at `visualizer/web/src/lib/theme.css:36`; the ink block is at `:67`; the media-dark block starts at `:97–98`. Bare `:root` is therefore the paper floor when there is no attribute and no dark-media match. The explicit ink selector wins, and the media block is guarded so an explicit paper choice survives a dark OS. `App.svelte:17–21, 44–51, 130` supplies the `os`/`paper`/`ink` choice and writes or deletes `data-theme`.

Permit two component-local custom-property patterns, and do not confuse either with a new colour tier:

1. Layout locals belong to the element that consumes geometry: `--identity-column:15rem` and `--lane-gap:.6rem` at `visualizer/web/src/lib/PhaseGantt.svelte:59`, with the `calc()` that consumes them pinned by `test/visualizer-panels.test.mjs:845–847`.
2. A token-indirection local may carry a runtime role or lane suffix: `RoleTag.svelte:4` sets `--role-color` from a role alias, `PhaseDots.svelte:5` sets `--lane-color`, and `PhaseGantt.svelte:48` supplies the lane indirection. The declaration still resolves to a Tier-2 alias; it does not license a literal colour.

The canonical measured source for this table is `visualizer/web/src/lib/theme.css`; values not present in that source do not belong in this reference.
