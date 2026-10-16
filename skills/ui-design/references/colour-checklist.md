# Colour checklist

Adapted from the "Before you finish" table of the better-colors skill in https://github.com/jakubkrehel/skills at revision 4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63 under its MIT licence (see THIRD-PARTY-NOTICES.md); every row was rewritten against this visualizer and rows with no matching construct were dropped with their measured reason below.

| Pattern | Here | Fix |
|---|---|---|
| Hex literal painted in a component where an alias token exists | `visualizer/web/src/lib/AcceptPanel.svelte` `visualizer/web/src/lib/GateChips.svelte` `visualizer/web/src/lib/PhasePanel.svelte` | Route the fill through a Tier-2 alias and keep the leak inventory honest — see state-colour.md |
| A lone non-hex notation in an established hex codebase | `visualizer/web/src/lib/theme.css` | The established notation is hex; keep any new value in hex unless a migration is in scope — see tokens.md |
| Raw Tier-1 token named directly in a component | `visualizer/web/src/lib/theme.css` `visualizer/web/src/lib/FleetTable.svelte` | Remeasured and no component names a raw token today; keep it that way and let components name Tier-2 aliases only — see contract.md |
| Semantic token name that carries a hue instead of a role | `visualizer/web/src/lib/theme.css` | Aliases here are role-named around status and seat roles; keep new names role-shaped — see tokens.md |
| Separator token used as a text colour or text token used as a fill | `visualizer/web/src/lib/OperationsOverview.svelte` `visualizer/web/src/lib/IntakePanel.svelte` | Keep separator tokens on separators and text tokens on text, and check new pairings against the measured cascade — see contract.md |
| Status tone too close in hue to the brand accent | `visualizer/web/src/lib/theme.css` | Verify the accent-to-status hue separation before adding a status tone — see limits.md |
| Dark theme built by reversing the light ramp | `visualizer/web/src/lib/theme.css` | Both ramps are positionally parallel scales rather than reversals; keep new pairs positional — see tokens.md |
| Colour scheme living under both a system query and a manual switch | `visualizer/web/src/lib/theme.css` `visualizer/web/src/App.svelte` | Only the theme file may pair the system query with the manual choice, and the app shell owns that choice; a component never decides colour — see contract.md |
| Contrast repair that shifts hue instead of lightness | `visualizer/web/src/lib/PhaseGantt.svelte` `visualizer/web/src/lib/theme.css` | Repair contrast by moving lightness first and recheck both themes — see limits.md |
| Text painted over a transparent or mixed fill | `visualizer/web/src/lib/PhaseGantt.svelte` `visualizer/web/src/lib/RosterPanel.svelte` | Mixed and transparent grounds defeat flat contrast checks, so keep text on flat alias grounds where feasible — see limits.md |
| Light text on a saturated status fill | `visualizer/web/src/lib/PhaseGantt.svelte` | Recheck the pairing on both themes before reusing a filled status bar — see limits.md |

## Dropped rows

- Paired brand and brand-text tokens — dropped: the codebase defines no color-primary pair; the single brand token is the accent alias in `visualizer/web/src/lib/theme.css`.
- Hue ramp differing only in lightness — dropped: no hsl colour function appears anywhere in the component tree or the theme file.
- Light-end stepping of a perceptual ramp — dropped: no OKLCH ramp exists; the theme file carries parallel hex ramps only.
- One chroma value copied across hues — dropped: no OKLCH or chroma-stepped ramps exist to copy a chroma across.
- Contrast preference override — dropped: no prefers-contrast query exists in the component tree or the theme file.
- Chroma beyond the portable gamut — dropped: no oklch values and no wide-gamut media query exist in the tree.
