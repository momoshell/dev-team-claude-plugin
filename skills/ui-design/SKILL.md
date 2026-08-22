---
name: ui-design
description: >-
  Constrains new visualizer UI to the measured design boundary: theme-paired chrome,
  Tier-2 alias tokens, explicit status and identity colour routing, panel and spacing
  idioms, honest absence marks, and known contrast and enforcement limits. Load it
  before designing or reviewing a Svelte component, choosing a colour, adding a panel,
  or deciding how state, role, lane, and unmeasured values should appear. It records
  this checkout's evidence rather than inventing a generic design system.
---

This is the boundary an agent designs inside. The visualizer's system is real in exactly one dimension—surface and chrome—and absent in another—state colour. Treat the measured register at `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md` as evidence: extend the chrome discipline to a new component without pretending that the existing state-colour leaks are a design rule.

## Routing

| Doing… | Rule that governs it | Details |
|---|---|---|
| Choosing a raw or component-facing token | Use the two-tier vocabulary and measured cascade | `references/tokens.md` |
| Checking whether a component obeys the theme contract | Apply T1–T4 and distinguish enforced tests from stated rules | `references/contract.md` |
| Choosing status, role, lane, or absence colour | Route state through tones and aliases; inspect the leak inventory and divergences | `references/state-colour.md` |
| Assessing contrast or what this lane cannot establish | Preserve the measured limits and absences | `references/limits.md` |

## Critical rules

Every colour a component paints resolves to a Tier-2 alias token; a component never names a raw token, and never names a colour.

Both ramps are positionally parallel five-step scales: ground -> panel -> hairline -> text -> muted.

T1 (name only Tier-2 aliases) is obeyed 21/21; T2 (every painted colour comes from a token) is violated in 10 of 21 components, 34 times.

The leak boundary is exactly state-vs-chrome: 19 background:var(--panel) sites and 45 var(--line) sites, zero hard-coded surfaces or separators.

A component never decides colour: a shaper returns a tone and CSS maps class -> token; no component reads run.status to pick a colour.

Role and lane isolation is a hand-maintained six-filename allowlist and does not generalise to a component written tomorrow.

- Build content regions on the measured panel chassis: `background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem;`. The chassis appears in 12 components and its surface pairing appears at 19 panel-background sites and 45 separator sites (`visualizer/web/src/lib/theme.css` and the C1 inventory in the register).
- Use `var(--bg)` for a surface recessed inside a panel and `var(--panel)` for a raised surface. The four recessed sites are `visualizer/web/src/lib/IntakePanel.svelte:122` and `visualizer/web/src/lib/RosterPanel.svelte:187`; do not reverse the C2 roles.
- Divide sibling rows with `border-top:1px solid var(--line)`, not an empty gap. The register counts 52 one-pixel hairlines across the named panel rows; exhibit `visualizer/web/src/lib/RunCard.svelte:59` and `visualizer/web/src/lib/FleetTable.svelte:31`.
- Use `rem` for gaps, padding, and margins. Permit `1px` only for hairlines, `999px` for the measured pill idiom, `720px`/`640px`/`1200px` for measured layout bounds, and the `18px`/`5px` SVG user-unit exception at `visualizer/web/src/lib/PhaseGantt.svelte:59`; do not turn the exception into CSS spacing.
- Render unmeasured data as the honest-blank idiom: a muted em-dash or reasoned unavailable sentence, a `title` carrying why, and a dashed underline for inline marks. The source exhibits are `visualizer/web/src/lib/RunCard.svelte:53`, `visualizer/web/src/lib/FleetTable.svelte:15–21`, and `visualizer/web/src/lib/AcceptPanel.svelte:36`; the ratified boundary is ADR-029 §2 at `docs/adr/adr-029-headless-observability-interjection.md:23`.
- Keep `:global` for descendants produced by markdown rendering, which a component cannot scope. The measured uses are `.evidence :global(p)` at `visualizer/web/src/lib/AcceptPanel.svelte:36` and `visualizer/web/src/lib/PhasePanel.svelte:62`; the two App reset restatements at `visualizer/web/src/App.svelte:187–188` are a recorded divergence, not a license for global selectors.
- Keep theme selection in the existing owner: `visualizer/web/src/App.svelte:17–21,44–51,130` owns the `os`/`paper`/`ink` choice, while `visualizer/web/src/lib/theme.css:36,67,97–98` owns the cascade. A component consumes aliases and does not write `data-theme`.
- Keep role and lane selection in the R2/R3 indirection patterns at `visualizer/web/src/lib/RoleTag.svelte:4,9`, `visualizer/web/src/lib/PhaseDots.svelte:5,8`, and `visualizer/web/src/lib/PhaseGantt.svelte:48,59`; account for missing role suffixes and lanes beyond the declared range.

The measurements above are preserved, not re-derived, in `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md`; read the references before adding a rule that the suite does not enforce.

## Key references

- `references/tokens.md` — Tier 1 raw tokens, Tier 2 aliases, cascade, and legitimate locals
- `references/contract.md` — T1–T4, switch ownership, and the mechanical test floor
- `references/state-colour.md` — R1–R5, leak inventory, and divergences
- `references/limits.md` — contrast, vacuous coverage, and recon limits
