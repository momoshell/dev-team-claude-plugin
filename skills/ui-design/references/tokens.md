# Token vocabulary

This reference records the measured vocabulary in `visualizer/web/src/lib/theme.css`; it does not invent a palette. The canonical source is `visualizer/web/src/lib/theme.css`. A component-facing rule is useful only when it can be traced to that file and its lines.

## The census

`theme.css` declares 111 custom-property declarations and 73 unique names. The raw block at the top holds 37 declarations; the paper, ink, and media-dark blocks redeclare 19 alias names each; the lane block adds 8 lane aliases plus 6 role `-color` helpers and 3 scrollbar tokens. An earlier grep reported 113 because it counted `var()` references, and an earlier recompute reported 105 because it predates the upstream rewrite; both are superseded. Every raw hex value from the opening block is listed here, with its declaration anchor.

## Tier 1: raw tokens

Raw tokens are declared once and are theme-specific or literal implementation data. Components do not name them. Every raw hex value from the opening block is listed here, with its declaration anchor.

| Group | Raw token | Value | Exhibit |
|---|---|---|---|
| ink ground ramp | `--ink-ground` | `#090d12` | `visualizer/web/src/lib/theme.css:2` |
| ink panel ramp | `--ink-panel` | `#0f151d` | `visualizer/web/src/lib/theme.css:3` |
| ink raised ramp | `--ink-panel-raised` | `#151d27` | `visualizer/web/src/lib/theme.css:4` |
| ink hairline ramp | `--ink-hairline` | `#25303d` | `visualizer/web/src/lib/theme.css:5` |
| ink text ramp | `--ink-text` | `#f3f5f7` | `visualizer/web/src/lib/theme.css:6` |
| ink muted ramp | `--ink-muted` | `#8f9baa` | `visualizer/web/src/lib/theme.css:7` |
| paper ground ramp | `--paper-ground` | `#f3f1eb` | `visualizer/web/src/lib/theme.css:8` |
| paper panel ramp | `--paper-panel` | `#fffdf8` | `visualizer/web/src/lib/theme.css:9` |
| paper raised ramp | `--paper-panel-raised` | `#ffffff` | `visualizer/web/src/lib/theme.css:10` |
| paper hairline ramp | `--paper-hairline` | `#d9d5cc` | `visualizer/web/src/lib/theme.css:11` |
| paper text ramp | `--paper-text` | `#15181c` | `visualizer/web/src/lib/theme.css:12` |
| paper muted ramp | `--paper-muted` | `#626970` | `visualizer/web/src/lib/theme.css:13` |
| spot light | `--spot-light` | `#6750d8` | `visualizer/web/src/lib/theme.css:14` |
| spot dark | `--spot-dark` | `#a898ff` | `visualizer/web/src/lib/theme.css:15` |
| planner ink | `--role-planner-dark` | `#9c8cff` | `visualizer/web/src/lib/theme.css:16` |
| builder ink | `--role-builder-dark` | `#52ced8` | `visualizer/web/src/lib/theme.css:17` |
| reviewer ink | `--role-reviewer-dark` | `#6fdda0` | `visualizer/web/src/lib/theme.css:18` |
| tech-lead ink | `--role-tech-lead-dark` | `#f0b85c` | `visualizer/web/src/lib/theme.css:19` |
| lead ink | `--role-lead-dark` | `#ef7ca9` | `visualizer/web/src/lib/theme.css:20` |
| driver ink | `--role-driver-dark` | `#7da7ff` | `visualizer/web/src/lib/theme.css:21` |
| planner paper | `--role-planner-light` | `#6652db` | `visualizer/web/src/lib/theme.css:22` |
| builder paper | `--role-builder-light` | `#087f89` | `visualizer/web/src/lib/theme.css:23` |
| reviewer paper | `--role-reviewer-light` | `#198a54` | `visualizer/web/src/lib/theme.css:24` |
| tech-lead paper | `--role-tech-lead-light` | `#a16500` | `visualizer/web/src/lib/theme.css:25` |
| lead paper | `--role-lead-light` | `#b43f71` | `visualizer/web/src/lib/theme.css:26` |
| driver paper | `--role-driver-light` | `#315eae` | `visualizer/web/src/lib/theme.css:27` |
| escalation | `--serious` | `#ff806f` | `visualizer/web/src/lib/theme.css:28` |
| status ok | `--status-ok-raw` | `#4dcc87` | `visualizer/web/src/lib/theme.css:29` |
| status fail | `--status-fail-raw` | `#ff6b6b` | `visualizer/web/src/lib/theme.css:30` |
| status running | `--status-running-raw` | `#f2bf62` | `visualizer/web/src/lib/theme.css:31` |
| status skipped | `--status-skipped-raw` | `#7e8996` | `visualizer/web/src/lib/theme.css:32` |

The opening block carries no prose comment; the old operational-status note at the former line 27 is gone with the rewrite. Do not make a component read `--ink-*`, `--paper-*`, `--spot-*`, a role `-dark`/`-light` half, `--serious`, or a `-raw` status name.

## Tier 2: aliases

These are the component-facing names. The paper and ink columns identify the value reached after the three-block cascade; status and escalation deliberately resolve identically in both themes.

| Purpose | Tier-2 alias | Paper resolves to | Ink resolves to | Evidence |
|---|---|---|---|---|
| page ground | `--bg` | `--paper-ground` (`#f3f1eb`) | `--ink-ground` (`#090d12`) | `visualizer/web/src/lib/theme.css:48` |
| raised surface | `--panel` | `--paper-panel` (`#fffdf8`) | `--ink-panel` (`#0f151d`) | `visualizer/web/src/lib/theme.css:49` |
| separator | `--line` | `--paper-hairline` (`#d9d5cc`) | `--ink-hairline` (`#25303d`) | `visualizer/web/src/lib/theme.css:51` |
| secondary text | `--muted` | `--paper-muted` (`#626970`) | `--ink-muted` (`#8f9baa`) | `visualizer/web/src/lib/theme.css:52` |
| interactive accent | `--accent` | `--spot-light` (`#6750d8`) | `--spot-dark` (`#a898ff`) | `visualizer/web/src/lib/theme.css:53` |
| inert fill | `--neutral` | `--paper-muted` (`#626970`) | `--ink-muted` (`#8f9baa`) | `visualizer/web/src/lib/theme.css:55` |
| status success | `--status-ok` | `#16864f` | `--status-ok-raw` (`#4dcc87`) | `visualizer/web/src/lib/theme.css:56` |
| status failure | `--status-fail` | `#c83f49` | `--status-fail-raw` (`#ff6b6b`) | `visualizer/web/src/lib/theme.css:57` |
| status running | `--status-running` | `#a66900` | `--status-running-raw` (`#f2bf62`) | `visualizer/web/src/lib/theme.css:58` |
| status skipped | `--status-skipped` | `--status-skipped-raw` (`#7e8996`) | `--status-skipped-raw` (`#7e8996`) | `visualizer/web/src/lib/theme.css:32` |
| escalation | `--status-escalated` | `#d04f3a` | `--serious` (`#ff806f`) | `visualizer/web/src/lib/theme.css:60` |
| planner role | `--role-planner` | `--role-planner-light` (`#6652db`) | `--role-planner-dark` (`#9c8cff`) | `visualizer/web/src/lib/theme.css:61` |
| builder role | `--role-builder` | `--role-builder-light` (`#087f89`) | `--role-builder-dark` (`#52ced8`) | `visualizer/web/src/lib/theme.css:62` |
| reviewer role | `--role-reviewer` | `--role-reviewer-light` (`#198a54`) | `--role-reviewer-dark` (`#6fdda0`) | `visualizer/web/src/lib/theme.css:63` |
| tech-lead role | `--role-tech-lead` | `--role-tech-lead-light` (`#a16500`) | `--role-tech-lead-dark` (`#f0b85c`) | `visualizer/web/src/lib/theme.css:64` |
| lead role | `--role-lead` | `--role-lead-light` (`#b43f71`) | `--role-lead-dark` (`#ef7ca9`) | `visualizer/web/src/lib/theme.css:65` |
| driver role | `--role-driver` | `--role-driver-light` (`#315eae`) | `--role-driver-dark` (`#7da7ff`) | `visualizer/web/src/lib/theme.css:66` |
| lane 0 | `--lane-0` | `--role-planner` | `--role-planner` | `visualizer/web/src/lib/theme.css:122` |
| lane 1 | `--lane-1` | `--role-builder` | `--role-builder` | `visualizer/web/src/lib/theme.css:123` |
| lane 2 | `--lane-2` | `--role-reviewer` | `--role-reviewer` | `visualizer/web/src/lib/theme.css:124` |
| lane 3 | `--lane-3` | `--role-tech-lead` | `--role-tech-lead` | `visualizer/web/src/lib/theme.css:125` |
| lane 4 | `--lane-4` | `--role-lead` | `--role-lead` | `visualizer/web/src/lib/theme.css:126` |
| lane 5 | `--lane-5` | `--role-driver` | `--role-driver` | `visualizer/web/src/lib/theme.css:127` |
| lane 6 overflow | `--lane-6` | `--neutral` | `--neutral` | `visualizer/web/src/lib/theme.css:128` |
| lane 7 overflow | `--lane-7` | `--muted` | `--muted` | `visualizer/web/src/lib/theme.css:129` |

`--neutral` and `--muted` are the same colour in both themes, so `--lane-6` and `--lane-7` are indistinguishable (register section 1, L9). The lane vocabulary ends at N in 0-7; there is no `--lane-8`. `--status-skipped` is identical in paper and ink, which is why the contrast limit belongs in `references/limits.md` rather than being hidden by the alias table.

## Cascade and legitimate locals

The paper block selector is at `visualizer/web/src/lib/theme.css:44`; the ink block selector is at `visualizer/web/src/lib/theme.css:69`; the media-dark block opens at `visualizer/web/src/lib/theme.css:94` with its inner selector at `visualizer/web/src/lib/theme.css:95`. Bare `:root` is therefore the paper floor when there is no attribute and no dark-media match. The explicit ink selector wins, and the media block is guarded so an explicit paper choice survives a dark OS. `visualizer/web/src/App.svelte:26` and `visualizer/web/src/App.svelte:27` supply the stored choice, `visualizer/web/src/App.svelte:72` and `visualizer/web/src/App.svelte:73` write or delete `data-theme`, and `visualizer/web/src/App.svelte:173` offers the selector.

Permit two component-local custom-property patterns, and do not confuse either with a new colour tier:

1. Layout locals belong to the element that consumes geometry: `--identity-column:17rem` and `--lane-gap:.6rem` at `visualizer/web/src/lib/PhaseGantt.svelte:254`, with the `calc()` that consumes them pinned by the visualizer panel suite.
2. A token-indirection local may carry a runtime role or lane suffix: `visualizer/web/src/lib/RoleTag.svelte:4` sets `--role-color` from a role alias, `visualizer/web/src/lib/PhaseDots.svelte:5` sets `--lane-color`, and `visualizer/web/src/lib/PhaseGantt.svelte:146` supplies the lane indirection. The declaration still resolves to a Tier-2 alias; it does not license a literal colour.

The canonical measured source for this table is `visualizer/web/src/lib/theme.css`; values not present in that source do not belong in this reference.
