# Escalation stages

An escalation is a durable stage, not a verdict that the whole lane is dead.
The tokens below are the stages emitted by `crew/drive.mjs`; the
variant-named tokens come from the closed `VARIANTS` set. Match the exact token
in the journal before choosing a move, and preserve the state directory while
investigating.

| Stage | Meaning | Operator's first move |
|---|---|---|
| `escalate:census-exhibits` | A repo-wide census exhibit could not be cleared: a measured failure was unrepairable, repeated beyond its bounded repair, or the census could not be measured. Raised at the `gate-baseline` boundary before the builder is dispatched, or again after the commit. | Read the named file and both census records. A bounded repair that was already spent is terminal; an unmeasured result names the missing evidence and is never read as clean. A checkout that ships no `crew/census-exhibits.mjs` never reaches this stage: its census is recorded `census-instrument-absent` and skipped, so look for that row before suspecting a censusless lane of a silent pass. |
| `escalate:scope` | A protocol, zero-write, or other retained scope-boundary invariant failed; ordinary out-of-context edits are recorded context and do not escalate here. | Read the scope-gate row and its typed reason; distinguish a protocol/shape failure from an ordinary path that was merely outside recorded context. |
| `escalate:scope-request` | A seat's typed `scope_request` was malformed or lacked the required evidence/path shape. Valid requests, including held or already-recorded paths, are admitted as mutable context without minting budget. | Read the typed refusal reason and preserve the request evidence; do not reinterpret an ordinary context record as a write denial. |
| `escalate:plan` | No usable plan, scope, lane, or mutation declaration reached acceptance. | Read the planner return and the exact refusal; do not ask the builder to guess. |
| `escalate:plan-check` | The plan-check seat rejected or could not accept the plan. | Preserve the plan and check return, then identify the rejected contract. |
| `escalate:plan-chunks` | Chunk plan validation (`validateChunks`) refused a missing, malformed, empty stepped program or invalid ownership; chunk lanes may also refuse an unknown selection or `chunk-without-chunked` when a chunk is named without `--chunked`. | For stepped, fix the plan's chunk program and gate ownership. For chunked lanes, boot WITH `--chunked --chunk <id>` or fix the program, then re-run. |
| `escalate:plan-carve` | The planner said the surface is too large to build whole or returned an invalid carve. | Keep the slice record and ask the human which slice to dispatch. |
| `escalate:plan-scope-malformed` | The final plan round still declared `files_in_scope` entries outside the dispatched surface that are neither tracked paths, trailing-slash directory prefixes, nor paths the brief declares created; earlier rounds bounce to the planner, so this stage means no revision was left to bounce it to. | Read the escalation `why`, which names each malformed entry and a did-you-mean correction where one exists. Correct a mistyped entry to its tracked path; for a file the lane must create, declare it so the brief's `## Where` carries a `declared · created · <path>` line; then re-dispatch. Do not ask the builder to guess. |
| `escalate:sensitivity-floor` | A protected path was discovered and the required judge-tier floor could not be applied. | Stop before lane/review/commit and boot a judge-tier pane; the record names whether discovery occurred at plan acceptance or during build. |
| `escalate:triage` | Repair triage lacks inherited scope/lane or returned an unusable repair note. | Read the failing run's context and the triage envelope before changing files. |
| `escalate:triage-scope` | Repair triage returned an empty, malformed, or otherwise invalid context declaration. | Preserve the triage artifact and correct its literal context declaration. |
| `escalate:build` | Build rounds ended without an accepted builder result. | Read the final builder envelope and diff; do not infer a successful build from a live pane. |
| `escalate:lane` | The lane review or scope decision could not settle the required next move. | Inspect the lane evidence and the scope-gate journal row before reassigning. |
| `escalate:review` | Review did not converge to an accepted verdict. | Preserve findings and rebuttals, then let a human choose the next review move. |
| `escalate:refuted-must-fix` | A must-fix was refuted but the acceptance policy refused to settle it automatically. | Read both finding positions and the acceptance record; do not erase the finding. |
| `escalate:suite` | The full suite went red after an otherwise accepted build. Frozen inventory receives only its bounded data-only repair; identity, logic, unmeasured, and repeat cases remain terminal. A named failing test path is recorded as context for the already-budgeted builder repair. | Capture the colour-neutral suite output and return to the committed tree. |
| `escalate:gate` | The acceptance gate is red or its proof could not settle. | Save the gate output and inspect the named `FAIL <check>` line. |
| `escalate:anchor-absent` | A declared `details.mutations` anchor did not reach the built tree and no accepted builder correction resolved it. | A PLAN/BUILD disagreement, not a gate indictment: read the bind report's `absent` rows and the builder's `details.mutation_corrections`. The gate is not defective and its one repair is unspent. |
| `escalate:diff-mutation` | A surviving diff mutant was routed as an automatic escalation rather than as a typed reviewer finding. | A ROUTING defect, not a proof indictment: a survivor is evidence for a reviewer (#1029). Read the `diff_mutation_proof` journal row for generated/killed/survived/skipped with reasons, and confirm the declared-anchor proof is untouched. |
| `escalate:envelope` | A seat returned an envelope that does not match the selected shape. | Open that seat's return and compare its fields with the variant contract. |
| `escalate:full` | The `full` shape could not complete its reviewed lifecycle. | Preserve the plan, gate, and review records before considering a retry. |
| `escalate:scout` | The read-only scout envelope or scope check failed. | Read the scout return and confirm that it made no checkout writes. |
| `escalate:repair` | The bounded repair shape returned a failed or malformed seat outcome. | Preserve the inherited failure context and triage note; later literal context may be recorded when repair evidence requires it. |
| `escalate:directed` | The orchestrator-authored directed brief is not buildable as supplied. | Validate its one directed block, gate command, and write surface before editing. |
| `escalate:finish` | The `finish` shape could not complete its reviewed lifecycle. | Preserve the accepted plan, gate, and review records before considering a retry. |
| `escalate:finish-triage` | Finish triage lacks the escalated scope, lane, or gate to finish. | Read the escalated task return and the accepted plan before changing files. |
| `escalate:finish-gate` | The lane gate changed during a finish run. | Save the gate diff; mutation re-proof of a changed check is split 2. |
| `escalate:review_only` | The read-only `review_only` shape could not return a structured review. The driver reports this stage as `envelope`: `crew/drive.mjs` maps `review_only` onto `envelope` before escalating, so this row documents the variant, not a token you will read in a journal. | Read the review envelope and confirm the run made no checkout writes. "No findings" is a measured outcome, so an absent or empty envelope is the failure — never a clean review. |
| `escalate:review_panel` | The read-only three-seat `review_panel` shape failed closed when a required partner or adjudicator was absent or failed, identity or coverage was invalid, adjudications were not an exact closed one-to-one cover, or any checkout write was observed. | Preserve each seat's evidence and the shared changed-files denominator. Dismissed findings remain provenance in the panel record, not actionable findings; do not fall back to reviewer A. |
| `escalate:verify_only` | The read-only `verify_only` shape could not return a complete verification report. The driver reports malformed or missing envelopes as `envelope`, so this row documents the variant, not a token you will read in a journal. | Complete `failed`, `blocked`, and `not run` rows are measured outcomes, not failures of the report; absent or incomplete reports fail. Read the evidence and confirm the final checkout is clean. |
| `escalate:harden` | The post-review hardening round did not settle. | Read the hardening bounce and the builder's last envelope before re-dispatching. |
| `escalate:review-unresolved` | Review rounds ended with findings neither accepted nor refuted. | Preserve every finding and rebuttal; a human chooses the disposition. |
| `escalate:rebase` | The lane could not rebase onto its base branch. | Inspect the conflict in the worktree; never force-push a lane branch. |
| `escalate:cold-suite` | The cold verification suite went red after the warm suite passed. | Re-run the cold lane by hand and compare its environment with the warm one. |
| `escalate:publish` | Publishing the pull request was refused. | Read the refusal; the branch and commit are already durable. |
| `escalate:converge-pr` | The converge-on-PR path could not settle its gate or review. | Read `details.escalation.where` for the inner stage that produced it. |
| `escalate:driver` | The crash exit had no `err.stage` to name. | Read `details.escalation.why` and the journal tail; this is the unattributed path. |
| `escalate:reversion` | Builder edits reverted to the pre-build baseline; terminal — the workspace is preserved for human inspection. | Preserve the workspace and the named paths, then read the escalation `why`. |
| `escalate:plan-scope-request` | The `escalatePlanScopeRequest` producer in `crew/drive.mjs` for a plan scope request; it has no caller today, so this row documents the producer, not a token you will read in a journal. | Read the escalation `why` and the scope-request question before re-dispatching. |

The tables are pinned to the emitted sets by `skills/crew-recovery/exhibits.test.mjs`. Its driver scan collects `escalate('...')` literals and `escalate(<CONST>.<member>, …)` resolved through the exported frozen object of that name, AND `escalationResult({where:'...'})` literals, all in `crew/drive.mjs`. Its crash scan collects every quoted kebab literal on the right of a `.stage =` assignment or `stage:` property (so each ternary branch counts) and the first literal argument of `staged(` and `fail(`, across its listed transport files and every non-test `crew/acp-*.mjs` module, plus every quoted kebab literal right of `where:` in `crew/daemon.mjs`, `crew/child.mjs`, `crew/crew.mjs` (excluding `driver`). A new producer in those shapes fails that test; a template-built stage (the families below) or an identifier-valued producer does not.

## Crash stages

A crash exit carries `where: err?.stage || 'driver'` (`drive.mjs`), so every
transport stage below reaches an escalation record as a `where`. Every crash
exit is terminal: each records an `escalate:<where>` stage row and its
`stage_done`, best-effort (a throwing journal never blocks the envelope).

| Stage | Meaning | Operator's first move |
|---|---|---|
| `acp-bin-unresolved` | The ACP binary named by the seat's adapter was not found on the PATH the driver searched. | The error names the binary and the searched PATH. Install the binary or fix the PATH or adapter configuration, then retry. |
| `acp-launch-unsupported` | The adapter resolved for the role exposes no ACP launch function, so the seat cannot start over ACP. | Check the roster's adapter and agent for that role; give the seat an ACP-capable adapter or a different transport. |
| `acp-no-envelope` | An ACP turn ended without a valid envelope at the return path. | Read the transport outcome and the seat's stream before retrying; the record says whether any session update was ever seen. An `acp_parse_error` journal row for the same return path means a file was written but did not parse. |
| `acp-parse-error` | Stamped on the ACP reader's parse failure when a file at the return path is not a valid envelope. The reader catches it (`readEnvelope` in `crew/acp-io.mjs`), journals one `acp_parse_error` row carrying the parse `why`, and treats the file as no envelope, so the turn ends as `acp-no-envelope`: this row documents the stamp, not a `where` you will read today. | Preserve the return file and read the `acp_parse_error` journal row for that return path; it carries the parse failure. |
| `acp-session-busy` | The role's ACP session was still occupied: a retained client could not be reproven, or a prior prompt did not settle after cancellation. | Confirm the prior turn has settled before assigning again; inspect the session record for the unsettled prompt. |
| `acp-steer-unsupported` | An in-turn steer was attempted on an ACP seat; the ACP transport does not support interjection. | Do not steer an ACP seat. Wait for the turn to end, then assign the follow-up as a new turn. |
| `build` | A resumed stepped lane was handed a step checkpoint that fails the checkpoint validator; the message names the defect. | Read the checkpoint named in the run request against the defect, then dispatch fresh rather than resume. |
| `child-preflight` | The child run failed before it could name a stage (`err.stage || 'child-preflight'` in `crew/child.mjs`). | Preserve the journal and read the escalation `why` before reassigning. |
| `envelope-refusal` | A seat's envelope failed an anti-replay identity check and was refused. The summary carries the operands (which field, its expected value and the value found), so an ABSENT identity reads differently from a genuinely mismatched one. | Read the operands first. `found=undefined` means the seat never named that field, which is not a replay; a real value that differs is. Eight lanes were lost to this before the two were distinguishable (#1227), every one with its work complete on disk. |
| `headless-no-envelope` | A headless turn ended without a usable envelope. | Read the transport outcome and the seat's stream before deciding whether to retry. |
| `headless-parse-error` | The headless stream could not be parsed. | Preserve the malformed frame evidence and inspect the transport record. |
| `headless-provider-exhausted` | A provider backoff or park ladder ended without another attempt. The recorded outcome remains `budget-refused` (or `timeout` for a stream stall); the escalation cause is `infrastructure`. | Read the provider failure annotation and retry journal before retrying; this stage is not a seat-budget failure. |
| `headless-session-busy` | A headless session was still occupied by another turn. | Confirm the prior turn settled before assigning again. |
| `headless-unresolvable-reservation` | A headless reservation could not be resolved. | Read the reservation record and reconcile the owning process. |
| `lease-release-incomplete` | A lease could not be fully released. | Preserve the lease record and retry only after checking its owner. |
| `ledger-sidecar` | The ledger sidecar failed while a run was being recorded. | Treat the ledger as diagnostic and inspect the authoritative run files. |
| `pane-parse-error` | A pane response could not be parsed. | Read the raw pane evidence and verify the expected response shape. |
| `reclaim-clock-invalid` | Reclaim metadata carried an invalid clock value. | Preserve the record and inspect the clock source before reclaiming. |
| `reclaim-lock-unavailable` | The reclaim lock could not be acquired. | Check the lock record and holder liveness before retrying. |
| `resume` | The resume path's driver crashed while adopting the checkpoint (`where: 'resume'` in `crew/crew.mjs`). | Preserve the journal and read the escalation `why` and the resume checkpoint before retrying. |
| `rpc-assignment-id-exhausted` | The RPC transport exhausted assignment identifiers. | Preserve the RPC journal and restart only after checking in-flight work. |
| `rpc-command-error` | The RPC transport reported a command error. | Read the command response and transport journal before reassigning. |
| `rpc-no-envelope` | The RPC turn ended without an envelope. | Inspect the RPC stream and return path for the missing record. |
| `rpc-parse-error` | The RPC stream could not be parsed. | Preserve the malformed frame and inspect the transport boundary. |
| `rpc-prompt-undelivered` | The prompt for an RPC assignment was never acknowledged by the seat. | Read `rpc-prompt-delivery` in the journal for the recorded assignment id, then compare it with the seat's `session.json` before assuming the worker is dead. |
| `rpc-session-busy` | The RPC session was already handling another turn. | Confirm the in-flight assignment's terminal state before retrying. |
| `rpc-session-not-in-flight` | An RPC operation named no in-flight assignment. | Reconcile the assignment record with the transport's current state. |
| `rpc-spawn-failed` | The RPC worker could not be spawned. | Read the spawn refusal and verify the configured binary. |
| `rpc-stall` | A headless-rpc seat wrote no frame for at least the 900s stale threshold mid-turn, was aborted, and the bounded stall-resumes (2, same session, grace untouched) did not recover it. | Read the `rpc-stall` and `seat-stall-resume` journal rows for `silent_ms` and each attempt's outcome; inspect the seat's stream for the hung tool call before re-dispatching. |
| `rpc-timeout` | The RPC transport exceeded its wait budget. | Inspect the stream and journal before deciding whether the worker is live. |
| `rpc-unresolvable-reservation` | An RPC reservation could not be resolved. | Preserve the reservation evidence and reconcile its owner. |
| `seat-died` | A seat's measured process death interrupted its turn. | Read the seat record and reclaim evidence before retrying. |
| `seat-refused` | A seat refused the assignment or its envelope. | Read the refusal and the re-ask budget before assigning again. |
| `session-persist-failed` | A seat's first assignment could not record `started` in crew.json, so delivery was refused rather than let a restarted driver resume that session without renewal; the message names the crew.json failure reason. | Fix the crew.json read/write failure it names (permissions, lock, malformed file), then re-run the lane. |
| `slot-claim-unresolvable` | A seat could not resolve its claimed slot. | Inspect the slot claim and the current crew topology. |
| `signalled` | The daemon's child was signalled after start (`where: started ? 'signalled' : 'spawn-error'` in `crew/daemon.mjs`). | Read the daemon record's `why` and the child exit before retrying. |
| `spawn-error` | The daemon's child failed to spawn (`where: started ? 'signalled' : 'spawn-error'` in `crew/daemon.mjs`). | Read the spawn refusal and verify the configured binary before retrying. |
| `substrate-gone` | The seat substrate disappeared during the turn. | Re-derive liveness from the control plane before acting. |
| `variant` | The selected variant could not be resolved. | Read the variant refusal and verify the requested shape. |

The template families `headless-<outcome>` and `rpc-<outcome>` expand over
`classifyRun`'s seven outcomes (`ok`, `ok-degraded`, `budget-refused`,
`timeout`, `malformed`, `aborted`, `no-envelope`). `assignAndWait` sets
`err.stage` to the seat ROLE name, so a role can appear as a `where`.
