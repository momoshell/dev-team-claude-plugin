# Tier and the protected floor

The protected-path floor is evaluated from the planner's declared
`files_in_scope` at `plan-accept`, not at boot and not from whatever the diff
happens to contain. A protected hit is therefore a seating requirement, not a
post-hoc review label.

## Prompt-surface rigorous review

The prompt-surface rule is distinct from the protected floor. The exported
`PROMPT_SURFACE` contract classifies path writes under `crew/roles/` and
`crew/guidelines/` as prompt changes and names the compiler-owned template
blocks `ACCEPTANCE_GATE_BLOCK`, `HOSTILE_ENV_BLOCK`, `CONVENTIONS_BLOCK`, and
`MUTATION_CONTRACT_BLOCK`. A prompt-surface hit forces rigorous review (the
implementation tier is `judge`); an explicit lower lane tier refuses with the
distinct `prompt-surface-conflict` reason rather than the protected
`tier-floor-conflict` reason.

The per-lane dispatch line reports `prompt=change` or `prompt=code-only`
between `forced=` and `proposed=`. The refusal carries this limitation:
`BLIND SPOT: path matching cannot see a prompt embedded as a template string in a compiler; the named templateBlocks require human recognition.`
A lane fence cannot identify which string inside a mixed compiler file changed.

Rigorous prompt review deliberately pays ADR-038's measured **64–66 minutes versus about 13 minutes for standard planning**; the cost is the control, not hidden overhead. This is a planning-cost measurement; it is
not a measurement of whether the prompt worked.

## Pane seating

The pane transport refusal is quoted from the runtime, verbatim:

> `a pane seat bakes model and effort into its launch command at boot (paneCommand in crew/crew.mjs); its reassign: true capability means give a settled seat NEW WORK, never change its cell`

The refusal names **`paneCommand`** by symbol, not by line. It used to carry a
line number for `crew/crew.mjs`, which drifted by roughly 1,400 lines and was
documented here as stale rather than corrected — an unpinned file-and-line
citation is in no manifest key, so
`--repair-all` refuses it ("manifest has no entry") and it rots in an
operator-facing message. A symbol does not drift. A pane cannot change cells
mid-run, so a protected-path hit on a pane lane must boot with `--tier judge`,
not ask sensitivity-floor to reseat it later.

There is one important short-circuit. When the live cell already equals
`roster.tiers.judge.reviewer`, `sameFloorCell` returns
`{applied: true, already: true}`. That is why booting a pane lane with
`--tier judge` works: the desired cell is baked at boot and the floor later
observes it. A mid-run upgrade still cannot change the cell.

## What the floor does

At `plan-accept`, `protectedHits(scopeFiles, …)` checks the planner's declared
scope. The evaluated floor is the **union** from `resolveProtectedPaths`:
the authored constant plus the ratified profile's additions — 14 against 12
here, with **`package-lock.json`** the only addition the constant does not
reach. The check runs over the lane's entire write surface, not only the one
file an operator remembers. b80-handle booted build tier after checking a
single unprotected file and escalated at plan-accept; b75-diag booted judge
deliberately and cost nothing.

A non-`applied` floor outcome escalates as `escalate:sensitivity-floor`; neither
a clean boot nor a diff that happens not to touch the path substitutes for the
plan-accept check.

`proposalTierAfterRaise` moves one band only along
`mechanical → build → judge`. Therefore `make-brief` prints `build` for a
one-file protected hit even though a pane lane needs `--tier judge` at boot;
the printed proposal is a proposal and must be overridden on that pane lane.
Do not turn a proposal into a mid-run reseat. A lane's `tier` is the
operator's decision; the compiler's proposal advises and never raises it; only
the protected floor constrains it.

If the protected hit is separable from the ordinary work, split the lane rather
than paying the protected floor for every file. #507 / b153-lab measured the
alternative: a 1208-line plan and 32 gate checks went through the tech-lead
loop for one `by_agent` grant line, and run 1 spent 68 minutes producing zero
lines of code. That cost is the reason the split-the-lane rule is operational,
not stylistic. Over 20 runs, judge tier spent **94%** of its wall clock
planning against build tier's 33%, so judge is worth it when planning IS the
deliverable and inflates plan share otherwise.

`judge` no longer implies the plan-check loop. Under ADR-038 the tech-lead is
seated but idle unless the planner declares `needs_adversary` in its envelope, or
the accepted plan's gate cannot prove mutation coverage of a protected file it
touches (which fails closed). ADR-038 Amendment 1 withdrew the third trigger, so
**there is no flag that forces the adversary round**. An operator who wants it
asks the way every other envelope field is steered — put it in the task brief's
`done_means`, e.g. *"return `needs_adversary: true`; this plan needs an
adversarial round because …"*. Every planner assignment brief, initial and
revision, already carries the field's contract, and the journal records which
trigger fired, or `none`, once per lane.

Finally, do not undo the boot decision with an override: `--model-reviewer` or
`--effort-reviewer` on a judge-tier pane lane changes the cell that
`resolveTier` sees and re-breaks `sameFloorCell`. Leave the judge-tier pane's
roster cell intact.
