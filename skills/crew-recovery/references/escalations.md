# Escalation stages

An escalation is a durable stage, not a verdict that the whole lane is dead.
The tokens below are the stages emitted by `crew/drive.mjs`; the four
variant-named tokens come from the closed `VARIANTS` set. Match the exact token
in the journal before choosing a move, and preserve the state directory while
investigating.

| Stage | Meaning | Operator's first move |
|---|---|---|
| `escalate:scope` | A changed path crossed the declared surface or a sibling fence. | Stop writes; compare `git status --porcelain -uall` with `files_in_scope` and the lane fence. |
| `escalate:plan` | No usable plan, scope, lane, or mutation declaration reached acceptance. | Read the planner return and the exact refusal; do not ask the builder to guess. |
| `escalate:plan-check` | The plan-check seat rejected or could not accept the plan. | Preserve the plan and check return, then identify the rejected contract. |
| `escalate:plan-carve` | The planner said the surface is too large to build whole or returned an invalid carve. | Keep the slice record and ask the human which slice to dispatch. |
| `escalate:sensitivity-floor` | A protected scope hit could not seat the required floor. | Stop at plan-accept and boot a judge-tier pane or split the protected surface. |
| `escalate:triage` | Repair triage lacks inherited scope/lane or returned an unusable repair note. | Read the failing run's context and the triage envelope before changing files. |
| `escalate:triage-scope` | Repair triage tried to remove or widen the inherited scope incorrectly. | Compare asked scope with inherited scope; preserve the triage artifact. |
| `escalate:build` | Build rounds ended without an accepted builder result. | Read the final builder envelope and diff; do not infer a successful build from a live pane. |
| `escalate:lane` | The lane review or scope decision could not settle the required next move. | Inspect the lane evidence and sibling-fence journal event before reassigning. |
| `escalate:review` | Review did not converge to an accepted verdict. | Preserve findings and rebuttals, then let a human choose the next review move. |
| `escalate:refuted-must-fix` | A must-fix was refuted but the acceptance policy refused to settle it automatically. | Read both finding positions and the acceptance record; do not erase the finding. |
| `escalate:suite` | The full suite went red after an otherwise accepted build. | Capture the colour-neutral suite output and return to the committed tree. |
| `escalate:gate` | The acceptance gate is red or its proof could not settle. | Save the gate output and inspect the named `FAIL <check>` line. |
| `escalate:envelope` | A seat returned an envelope that does not match the selected shape. | Open that seat's return and compare its fields with the variant contract. |
| `escalate:full` | The `full` shape could not complete its reviewed lifecycle. | Preserve the plan, gate, and review records before considering a retry. |
| `escalate:scout` | The read-only scout envelope or scope check failed. | Read the scout return and confirm that it made no checkout writes. |
| `escalate:repair` | The bounded repair shape returned a failed or malformed seat outcome. | Preserve the inherited failure context and triage note; do not widen repair scope. |
| `escalate:directed` | The orchestrator-authored directed brief is not buildable as supplied. | Validate its one directed block, gate command, and write surface before editing. |

The list is intentionally tied to the source's emitted set. A new driver stage
requires a deliberate documentation and test change; an invented token is not
a useful recovery instruction.
