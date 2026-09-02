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
| `escalate:anchor-absent` | A declared `details.mutations` anchor did not reach the built tree and no accepted builder correction resolved it. | A PLAN/BUILD disagreement, not a gate indictment: read the bind report's `absent` rows and the builder's `details.mutation_corrections`. The gate is not defective and its one repair is unspent. |
| `escalate:envelope` | A seat returned an envelope that does not match the selected shape. | Open that seat's return and compare its fields with the variant contract. |
| `escalate:full` | The `full` shape could not complete its reviewed lifecycle. | Preserve the plan, gate, and review records before considering a retry. |
| `escalate:scout` | The read-only scout envelope or scope check failed. | Read the scout return and confirm that it made no checkout writes. |
| `escalate:repair` | The bounded repair shape returned a failed or malformed seat outcome. | Preserve the inherited failure context and triage note; do not widen repair scope. |
| `escalate:directed` | The orchestrator-authored directed brief is not buildable as supplied. | Validate its one directed block, gate command, and write surface before editing. |
| `escalate:harden` | The post-review hardening round did not settle. | Read the hardening bounce and the builder's last envelope before re-dispatching. |
| `escalate:review-unresolved` | Review rounds ended with findings neither accepted nor refuted. | Preserve every finding and rebuttal; a human chooses the disposition. |
| `escalate:rebase` | The lane could not rebase onto its base branch. | Inspect the conflict in the worktree; never force-push a lane branch. |
| `escalate:cold-suite` | The cold verification suite went red after the warm suite passed. | Re-run the cold lane by hand and compare its environment with the warm one. |
| `escalate:publish` | Publishing the pull request was refused. | Read the refusal; the branch and commit are already durable. |
| `escalate:converge-pr` | The converge-on-PR path could not settle its gate or review. | Read `details.escalation.where` for the inner stage that produced it. |
| `escalate:plan-scope-widened` | The accepted plan's `files_in_scope` grew past the dispatched surface. | Compare the plan's scope with the dispatched fence; a wider plan is refused, not merged. |
| `escalate:driver` | The crash exit had no `err.stage` to name. | Read `details.escalation.why` and the journal tail; this is the unattributed path. |

The tables are pinned to the emitted sets by `skills/crew-recovery/exhibits.test.mjs`,
and a new producer fails that test.

## Crash stages

A crash exit carries `where: err?.stage || 'driver'` (`drive.mjs`), so every
transport stage below reaches an escalation record as a `where`. These are
`terminal: false` and do not record an `escalate:<where>` stage row.

| Stage | Meaning | Operator's first move |
|---|---|---|
| `headless-no-envelope` | A headless turn ended without a usable envelope. | Read the transport outcome and the seat's stream before deciding whether to retry. |
| `headless-parse-error` | The headless stream could not be parsed. | Preserve the malformed frame evidence and inspect the transport record. |
| `headless-session-busy` | A headless session was still occupied by another turn. | Confirm the prior turn settled before assigning again. |
| `headless-unresolvable-reservation` | A headless reservation could not be resolved. | Read the reservation record and reconcile the owning process. |
| `lease-release-incomplete` | A lease could not be fully released. | Preserve the lease record and retry only after checking its owner. |
| `ledger-sidecar` | The ledger sidecar failed while a run was being recorded. | Treat the ledger as diagnostic and inspect the authoritative run files. |
| `pane-parse-error` | A pane response could not be parsed. | Read the raw pane evidence and verify the expected response shape. |
| `reclaim-clock-invalid` | Reclaim metadata carried an invalid clock value. | Preserve the record and inspect the clock source before reclaiming. |
| `reclaim-lock-unavailable` | The reclaim lock could not be acquired. | Check the lock record and holder liveness before retrying. |
| `rpc-assignment-id-exhausted` | The RPC transport exhausted assignment identifiers. | Preserve the RPC journal and restart only after checking in-flight work. |
| `rpc-command-error` | The RPC transport reported a command error. | Read the command response and transport journal before reassigning. |
| `rpc-no-envelope` | The RPC turn ended without an envelope. | Inspect the RPC stream and return path for the missing record. |
| `rpc-parse-error` | The RPC stream could not be parsed. | Preserve the malformed frame and inspect the transport boundary. |
| `rpc-session-busy` | The RPC session was already handling another turn. | Confirm the in-flight assignment's terminal state before retrying. |
| `rpc-session-not-in-flight` | An RPC operation named no in-flight assignment. | Reconcile the assignment record with the transport's current state. |
| `rpc-spawn-failed` | The RPC worker could not be spawned. | Read the spawn refusal and verify the configured binary. |
| `rpc-timeout` | The RPC transport exceeded its wait budget. | Inspect the stream and journal before deciding whether the worker is live. |
| `rpc-unresolvable-reservation` | An RPC reservation could not be resolved. | Preserve the reservation evidence and reconcile its owner. |
| `seat-died` | A seat's measured process death interrupted its turn. | Read the seat record and reclaim evidence before retrying. |
| `seat-refused` | A seat refused the assignment or its envelope. | Read the refusal and the re-ask budget before assigning again. |
| `slot-claim-unresolvable` | A seat could not resolve its claimed slot. | Inspect the slot claim and the current crew topology. |
| `substrate-gone` | The seat substrate disappeared during the turn. | Re-derive liveness from the control plane before acting. |
| `variant` | The selected variant could not be resolved. | Read the variant refusal and verify the requested shape. |

The template families `headless-<outcome>` and `rpc-<outcome>` expand over
`classifyRun`'s seven outcomes (`ok`, `ok-degraded`, `budget-refused`,
`timeout`, `malformed`, `aborted`, `no-envelope`). `assignAndWait` sets
`err.stage` to the seat ROLE name, so a role can appear as a `where`.
