# Tier and the protected floor

The protected-path floor is evaluated from the planner's declared
`files_in_scope` at `plan-accept`, not at boot and not from whatever the diff
happens to contain. A protected hit is therefore a seating requirement, not a
post-hoc review label.

## Pane seating

The pane transport refusal is quoted from the runtime, verbatim:

> `a pane seat bakes model and effort into its launch command at boot (crew/crew.mjs:265); its reassign: true capability means give a settled seat NEW WORK, never change its cell`

The `crew/crew.mjs:265` inside that sentence is a stale in-string anchor. The
live bake is `paneCommand` at `crew/crew.mjs:1315-1329`. A pane cannot change
cells mid-run, so a protected-path hit on a pane lane must boot with
`--tier judge`, not ask sensitivity-floor to reseat it later.

There is one important short-circuit. When the live cell already equals
`roster.tiers.judge.reviewer`, `sameFloorCell` returns
`{applied: true, already: true}`. That is why booting a pane lane with
`--tier judge` works: the desired cell is baked at boot and the floor later
observes it. A mid-run upgrade still cannot change the cell.

## What the floor does

At `plan-accept`, `protectedHits(scopeFiles, …)` checks the planner's declared
scope. A non-`applied` floor outcome escalates as
`escalate:sensitivity-floor`; neither a clean boot nor a diff that happens not
to touch the path substitutes for the plan-accept check.

`proposalTierAfterRaise` moves one band only along
`mechanical → build → judge`. Therefore `make-brief` prints `build` for a
one-file protected hit even though a pane lane needs `--tier judge` at boot;
the printed proposal is a proposal and must be overridden on that pane lane.
Do not turn a proposal into a mid-run reseat.

If the protected hit is separable from the ordinary work, split the lane rather
than paying the protected floor for every file. #507 / b153-lab measured the
alternative: a 1208-line plan and 32 gate checks went through the tech-lead
loop for one `by_agent` grant line, and run 1 spent 68 minutes producing zero
lines of code. That cost is the reason the split-the-lane rule is operational,
not stylistic.

Finally, do not undo the boot decision with an override: `--model-reviewer` or
`--effort-reviewer` on a judge-tier pane lane changes the cell that
`resolveTier` sees and re-breaks `sameFloorCell`. Leave the judge-tier pane's
roster cell intact.
