# crew — the lean runtime

One brief in, one lane out. Agents do the work; code only starts it, checks it
and records it ([ADR-052](../docs/adr/adr-052-agents-do-the-work.md)).
[`docs/plan-lean-runtime.md`](../docs/plan-lean-runtime.md) is the historical
plan, superseded by this README.

```
crew onboard (--check <draft.json> | --seats) [--checkout <dir>] # calibrate the checkout or probe its seats
crew start <brief.md> [--checkout <dir>]             # worktree + journal + a detached lane
crew lanes [--all] [--json]                          # list lanes from their journals
crew show <lane> [<role>] [--json]                   # read a lane's recorded seat sessions
crew finish <lane>                                   # report a stopped or ready lane, read-only
crew finish <lane> --accept [--notes <file>] | --return <file> | --abandon
crew record-pr <lane> --pr <url>                     # record the PR a stopped lane was hand-finished in
crew closeout <lane>                                 # remove a merged lane's worktree and branch, archive its directory
crew closeout <lane> --discard                       # archive a stopped lane with no PR or a CLOSED PR
crew viz                                             # serve the visualizer from the crew home
crew where                                           # the crew home, its branch and its commit
crew update [--force]                                # fast-forward the crew home to origin/main and rebuild what changed
```

`crew` is `bin/crew.mjs`. The crew home is the checkout it lives in (symlinks
resolved), or `CREW_HOME` when set. State lives under `~/.crew/dt-<lane>/<lane>/`:
the brief, the task directory, the lane journal and every seat's session file.

`crew closeout <lane> --discard` archives a stopped lane with no PR or a PR
GitHub reports CLOSED, clearing it from the default visualizer list. It also
archives a lane ended with `crew finish <lane> --abandon` or accepted before its
PR closed. A lane without a journal can be discarded if its run is not live. It
refuses OPEN or MERGED PRs (use plain closeout after merge or discard after close),
other finish records, runs not proven stopped, dirty worktrees, and tips on neither
a remote-tracking ref nor the base. An absent worktree is skipped on retry; its
branch is not checked. It
removes the worktree without force before deleting only the local branch and
archiving the journal; the remote branch and visualizer are unchanged. Closeout
and discard stop proven seat groups and report unproven ones (`reapLaneSeats` in
`crew/seat-reap.mjs`).

`crew update` refuses unless the crew home is on branch `stable` with no tracked changes; `--force` only overrides the refusal when processes still run from the home.

## The model

**Agents do the work; code keeps it correct.** A lane starts from one P1 brief
(`source`, `closes`, `shape`, optional `out_of_scope`, `mechanical`, `generated` and `regenerate`; absent `out_of_scope` means none. The
body has the quoted operator ask and bare Context pointers, or bare Context pointers alone for an issue; `crew start` quotes the issue body as the ask). `crew/loop.mjs` runs it:

```
build:      plan -> rebase -> build -> refresh base -> per-test proof -> (full suite || review) -> PR
judge:      plan -> rebase -> build -> refresh base -> per-test proof -> full suite -> review -> second review -> PR
mechanical: rebase -> build -> refresh base -> per-test proof -> full suite -> PR
```

A fix turn carries the red results back to the builder, then repeats proof, the suite and any needed reviews. In build, judge and finish runs, each review role reuses its own latest verdict and findings if it passed the same tree id earlier in that run. Reuse journals `review-reused` with the role, tree and `pass` verdict, without seating the role or spending a review round or reserve review. A changed tree or a latest verdict of `changes-needed` still requires review. Proof and the suite repeat as before. Build and judge do not automatically rerun a red suite on an unchanged tree.

After every accepted builder or repair turn, including finish runs, the loop fetches before checks. An unchanged base adds only fetch and base measurement. If the base moved, the loop temporarily commits the measured lane paths, rebases through the existing ignored/generated-file rules, then soft-resets onto the new base, leaving the build uncommitted. Proof's old source is that fresh base. The next review is full and counted, including reserve and finish repair reviews; earlier findings remain, but delta/reserve/recheck scopes do not. The `pre-check-base-move` journal row records old/new base and review intent. This move grants no rounds and spends none of `MAX_RECHECKS`. A dropped change stops `nothing-to-commit` before checks; a terminal fetch failure stops before snapshotting, with the existing ref-lock retries.

Before publishing, each lane still commits and rebases. Initial finish, pre-check and publishing rebases share one builder conflict turn per run; an unresolved or spent turn stops `rebase-conflict`. Failed moves restore uncommitted work only when cleanup is proven. Build, judge and finish commit only the tree their suite and reviews checked. If the head changes, they put the change on the new base tip and repeat the checks, reusing each role's latest pass only if the tree id is unchanged. On build and judge lanes, the recheck review covers unresolved earlier findings, lane code altered by the rebase or conflict turn, and where the base's new commits meet the lane's change. The loop checks that the three commit comparisons work; if it cannot measure the scope, the recheck is a full review and the journal says so. If Git drops the commit as already upstream, they stop. Mechanical re-proves and re-tests a moved head.

Optional `builderChecks` in `.crew/project.json` is a list of non-empty, one-line commands. Its lines appear verbatim in a `## Project checks` section of build, suite-repair and finish builder prompts. Builders run them and report each result in `notes`. The loop never runs them or reads their results; no journal row or PR line reports them, and the suite stays the gate. Editing the list does not require re-onboarding.

`DEFAULT_ROUNDS` in `crew/loop.mjs` bounds seat rounds. When the reviewer's last round returns `changes-needed` or a red suite, `reservePending` and `reserveSpent` grant a reserve re-review after repair; once spent, the loop stops at `round-bound` before another builder turn. `MAX_ENVELOPE_REPAIRS` in `crew/loop.mjs` permits one envelope repair turn.

A brief may choose `mechanical: true` for a change with no behaviour to judge. With no named test, its PR states `proof: none, mechanical lane, not reviewed`; the operator reviews the diff before merging. Protected paths restart it as judge, and builder insufficiency restarts it as build.

Optional `worktreeSetup` in `.crew/project.json` is a non-blank command split on whitespace without a shell, like a proof entry's `setup`. `crew start` runs it once in the new worktree before launching the lane, with a 10-minute timeout. Failure or timeout is printed and recorded in the journal as red or unmeasured but does not stop the lane. If git reports changed or untracked paths after setup, start names them and refuses to launch; ignored paths are allowed. Changing or adding the command requires onboarding again.

The lane name is the brief's file name. `crew start` runs the `standard` shape
only; `finish` (ADR-051) is the second entry path. `crew finish <lane> --return <file>`
starts a finish pass on any finishable stop, including an escalation or a
provably dead run, or another pass on a ready lane. `<file>` is a notes file, not inline text;
its guidance stands for the whole pass and a new return replaces it.
A pre-build planning stop resumes in the same lane, branch and worktree, preserving
seeded files and previous returns and sessions. An accepted current planner done
return with an unresolved lead decision resumes at the lead; otherwise the planner
reruns with the previous evidence. Planner and lead receive labelled operator guidance
and the stopped lead's question. A lead bounce can revise the plan. An accepted plan
then enters the finish build/check path, ending at `finish-ready`, not publication;
use `--accept` to publish. A judge lane resumed by `--return` from a plan stop gets
reviewer review but no tech-lead second review. To get that second review, abandon
and restart the lane. Baseline-only stops still refuse. Post-build finish passes
cannot reopen planning: abandon, close out with `--discard` and restart from the brief
when the build needs a new plan (ADR-051).
A `--return` pass whose branch equals its base after the initial rebase still runs the build; a later pre-check move that drops the change, or the commit stage, can stop `nothing-to-commit`.
In a finish pass, the first red suite gives the builder its one repair turn immediately, even for a flaky failure. There is no unchanged-tree retry. The repair repeats proof and the suite, and repeats review unless the reviewer already passed the same tree in this finish run. The finish report lists only reviews actually performed. A red suite after repair, or a suite that is neither green nor red, stops the lane.
Bare `crew finish <lane>` reports without writing.
A claim whose run is provably gone is taken over. A committed
build with no remote branch is uncommitted and finished if HEAD is the commit or
its journal-recorded one-commit rebase. The latter is reset onto the rebase base;
the journal records `finish-uncommit`. `--return` refuses with `finish-rounds-spent`
once the review rounds in `FINISH_REVIEW_ROUNDS` in `crew/checks.mjs` are spent. When not eligible for reuse, the review after the one suite-repair turn is free only if its pre-check fetch finds the base unchanged. A pre-check move makes it full and counted, so a spent cap stops it. A post-suite moved-head recheck review remains free and runs even when the cap is spent. On `--accept`, issue tokens in the measured
text and notes are rewritten; issue numbers appear only on trailer lines.
A gated lane can accept a calibrated `.crew/project.json` if its hash matches the calibrated journal-recorded rebase base and its suite and timeouts match the lane's. If the base file cannot be read, accept requires the worktree hash to match the start hash. A hash or calibration mismatch refuses `onboarding-stale`; a suite or timeout mismatch also refuses and names the field. The decision row records the start and finish onboarding hashes, even when equal.
Every loop is bounded, every envelope is
validated against a closed protocol (P2) and refused if it does not parse, and
the loop adds no other gate: no host-load gate, no dispatch-time baseline, no
measurement that holds work. Journal writes do not throw into the caller. A failed session-file write fails the turn (`crew/lean.mjs`, `guardedAppend`). The operator decided on 2026-11-12 to keep it: a turn with no recording cannot be inspected with `crew show`.

ADR-055 §12 routes a builder escalation or a done lead escalation without `details.question` back to the same seat. As an operator-selected exception, planner, reviewer and tech-lead `insufficient` or `escalate` returns stop `seat-escalated` with a valid `details.question`, falling back to `summary`. No usable planner artifact or completed review is required. A non-done lead `decision: escalate` stops `lead-escalated` with the same fallback; valid bounce/accept decisions keep their routing. On build and judge and in finish runs, a builder's `insufficient` goes to the lead with its envelope unless it names no `details.gap` after a turn that changed the worktree, in which case it continues without a round up to the lane's progress cap. Finish and mechanical suite-repair turns do not continue this way: a non-done finish suite-repair return stops, and non-finish mechanical insufficiency restarts as build. The lead routes other builder insufficient returns to the builder or planner where available, or escalates a §12 case. The lead's last consult in a phase is marked last; a phase reset or refunded bounce can reopen consults, and a spent lead bound stops for the operator with a question drawn from the held envelope and lead decision. A builder bounce after a changed builder turn refunds the lead round up to the shared cap of 6 continuations and refunds. For a builder held at its round bound, the last completed turn can refund once, unless the held feedback carries a must-fix id from the same seat in the previous consult. A planner bounce or an unchanged or unmeasured turn spends the bound; finish runs follow the same rule. Repeated failures with the same evidence stop as `no-progress` without a seat decision. On build and judge lanes the planner's P2 `details.tests` decides whether P3 proof is required; an empty list means no criterion is machine-checked. A mechanical builder may name no test.

Seat definitions are `crew/agents/<role>.md`; their frontmatter supplies the
default model, agent (`claude`, `pi` or `muse`), effort, skills, `requires`
and extensions, and the body is the charter. Tiers are
`mechanical`, `build` and `judge`; a tier entry overrides how a seat runs there
or unseats it. `crew/agents.mjs` resolves a tier and `crew/protocols.mjs` holds
the brief, envelope and agent-definition validators. ADR-055 §7 raises lanes to judge for the planner's reason or protected paths; it never lowers them.

Local roster files layer project `<checkout>/.crew/agents.json` over personal `~/.crew/agents.json` over the committed defaults. They may change only `agent`, `model`, `effort`, `advisor`, `wait_s` and `tiers`; the charter and other fields stay with the plugin. Start validates the layers and records the effective run fields for every tier, even without override files. Later plugin or override changes do not reseat that lane, including finish passes. Like `effort`, `wait_s` can be set on a role or tier; tier values win over role values. A named tier entry replaces that tier's lower-layer run fields rather than deep-merging them, while retaining the definition's non-run fields. The journal records file hashes and effective cells. See [ADR-060](../docs/adr/adr-060-local-roster-overrides.md).

A frontmatter tier override replaces only the fields it names and keeps a raw override model id exactly as written, with no namespace translation. A provider failure does not reseat the seat on another cell: the retry ladder in `crew/acp/provider.mjs` backs off and retries, and once the retry bound is exhausted the lane stops with the provider failure named.

## Runtime feature map
| Feature | Where it lives | ADR | Doc |
|---|---|---|---|
| Readgate | `crew/pi/extensions/readgate.ts` | - | - |
| FFF | `crew/adapters/adapter-pi.mjs` | - | - |
| Advisor | `crew/pi/extensions/advisor.ts`, `crew/agents/builder.md` (advisor model) | [ADR-047](../docs/adr/adr-047-the-advisor-is-a-roster-seat.md) | - |
| Skeletonread | `crew/pi/extensions/skeletonread.ts` | - | - |
| Subagent | `crew/pi/extensions/subagent.ts`; Claude native scout: `crew/adapters/claude-scout.json`, hook in `crew/adapters/adapter-claude.mjs` | - | - |
| Per-test proof | `crew/proof.mjs` | [ADR-055](../docs/adr/adr-055-planner-defines-the-work.md) | - |
| Seat skills | `hooks/skill-gate.mjs` (skill-map selector, not a registered hook) | ADR-050 ([decision](../docs/adr/adr-050-seat-skills-are-granted-not-pasted.md)) | [Seat skills](../docs/adr/adr-050-seat-skills-are-granted-not-pasted.md) |
| Memory | `crew/memory.mjs` | - | - |
| Visualizer | `visualizer/web/src/lib/LeanRunDetail.svelte`, `visualizer/web/src/lib/LeanWaterfall.svelte` | - | [Visualizer](../visualizer/README.md) |
| ACP | `crew/acp-client.mjs` | ADR-036 ([decision](../docs/adr/adr-036-acp-seat-transport.md)) | [ACP decision](../docs/adr/adr-036-acp-seat-transport.md) |

**The seats** (ACP sessions, each played from its `crew/agents/<role>.md`):

| Seat | Job | Repo writes |
|---|---|---|
| `planner` | explores the code and writes the plan: criteria, properties with tests, and tasks | none (task dir only) |
| `builder` | edits the repo and names tests to prove | the only seat that writes the repo |
| `reviewer` | verdict, requirements, ranked findings, failure modes and coverage | none |
| `lead` | answers an escalation with one closed decision | none |
| `tech-lead` | judge loop's automatic second review | none |

`requires` is validated and carried in the definition, but no check reads it since the required-skill proof was removed (#2323). Scope is context, not enforcement
(ADR-045): a lane may write any file.

A seat's `wait_s` must be a positive safe integer in seconds. When no override sets it, the seat definition supplies it, or it defaults to 2400 seconds. Start freezes the effective limit for each tier, including this fallback, for the lane and its finish passes. The timer in `crew/acp/seat.mjs` starts after ACP setup; setup has its own budget, `ACP_SETUP_TIMEOUT_MS` plus `ACP_FIFO_WAIT_MS` in `crew/acp-client.mjs`, as a fixed cost on top of `wait_s`.

After an `acp-seat-deadline` cut, the one rerun receives the original prompt plus a note with the previous attempt's limit: it was cut without a return, partial changes remain in the worktree, a long-running command may have been killed, and the seat must return before the limit. Other turn errors keep the original prompt unchanged. A second cut stops `seat-unmeasured`.

## Checks

`crew/proof.mjs` and `crew/checks.mjs` own what code verifies:

- **Proof** — each named test normally must fail in its own body on the old source and pass on the build. A runner's optional `manifest` file name lets a new package's own test prove on a green build alone when its manifest is absent from the old-source commit (`base-package-absent`); there is no red side. With `newTestFile: true`, a no-report old-source run can instead prove on a green build report if the test file is absent from the old-source commit (`base-test-absent`). Both exceptions are weaker evidence: a vacuous test can pass. Neither is a kill proof.
- **Suite** — the full suite runs with a timeout and a process-group kill.
- **Commit, rebase, PR** — only on green; the PR is opened, never merged.

## Contracts

Everything durable is a file; session chat is never the record.

- **P1 brief** and **P5 agent definition**: markdown with frontmatter.
- **P2 envelope**: one JSON object per seat turn at the path the loop issued,
  `{ role, id, status: done|insufficient|escalate, summary, details }`; the
  loop reads it back from that path and checks the id. For planner, reviewer,
  tech-lead and lead `insufficient`/`escalate` returns, unknown, empty or invalid
  detail fields are dropped; valid nonempty allowed fields survive. A valid
  question survives, otherwise the summary carries it. The lead still needs a
  valid `details.decision`. Root fields and the details object remain validated;
  done and builder returns remain strict. Each journal `envelope` row names
  dropped keys in `dropped` (empty when none), including repair attempts, and
  preserves the raw return in `parsed`. Routing uses the sanitized envelope.
- **P3 gate**: retired by ADR-055; proof reads builder `details.tests`.
- **P4 journal and sessions**: one append-only JSONL per lane and one session
  file per seat turn holding its full ACP update stream, under
  `<task>/lean/<role>/`. Each `seat-turn` journal row carries `role`, `id`,
  `agent`, `model`, `effort`, `seconds`, `tool_calls`, `stop_reason`, `status`,
  `usage`, `worktree_changed` and `unmeasured`; each null field has one reason
  in `unmeasured`: `not-reported`, `turn-failed`, `usage-unavailable`,
  `no-return`, `clock-unmeasured`, `not-repo-seat` or `worktree-unmeasured`.
  `tool_calls` counts the distinct `toolCallId`s of the `tool_call` updates relayed into the turn's session file (`crew/lean.mjs`); it is null when a session-file write failed.
  An interrupted or refused prompt with running measurements but no final usage
  also carries `usage_partial`: `{ kind: 'tokens', ...reportedTokenFields }`
  for token snapshots (pi), or `{ kind: 'context', used, cost? }` for context
  snapshots (Claude). Token fields use the same ACP names as `usage`; context
  `cost`, when reported, is `{ amount, currency }`. The last snapshot replaces
  earlier ones; context size is not token spend. `usage` stays null with its
  existing unmeasured reason. Normal completion and turns with no running
  measurement omit `usage_partial`; unknown is not zero. Snapshots do not carry
  into another prompt or attempt. `crew show` and visualizer token totals still
  read only `usage`, never `usage_partial`.

## Files

- `start.mjs` — `crew start`: checks the brief, creates the worktree, starts the detached run.
- `lean.mjs` — the detached entry; plays each seat turn over ACP and writes the session files.
- `lean-source.mjs`: read-only view of live and archived lanes.
- `lean-journal-order.mjs`: journal row ordering and superseded returns.
- `run-pid.mjs`: run PID records and liveness probes.
- `lane-core.mjs`: shared lane validation and repository state helpers.
- `loop.mjs` — the loop: bounded rounds, lead consults, the `finish` shape, journal rows.
- `proof.mjs` — per-test proof.
- `checks.mjs` — suite, commit, rebase, PR.
- `agents.mjs`, `protocols.mjs` — agent definitions, tiers, and the closed protocols.
- `acp/`, `acp-client.mjs`, `acp-permission.mjs`, `acp-signal.mjs` — the ACP seat transport, grants and permission handling.
- `show.mjs`, `lanes.mjs`, `finish.mjs`, `record-pr.mjs`, `closeout.mjs` — the other verbs.
- `reclaim.mjs` — token-fenced locks and the per-seat reservation markers the ACP client takes (`reserve`, `advance`, `clear`, `probeEvidence`).
- `adapters/adapter-*.mjs` — per-agent launch shapes for `claude`, `pi` and `muse`.
- `pi/extensions/` — the kept pi arms (readgate, skeletonread, subagent, advisor).
- `memory.mjs` — lane memory.
- `agents/*.md` — delivered seat definitions and instructions.
- Tests sit beside the code as `*.test.mjs`.

## Posture

Seats run unattended, so the enforced tool boundary is each seat's grants, not
a prompt. Only the builder is granted repo writes; other seats write their
envelope and task-dir artifacts. Worktree isolation separates lanes, not seats
within a lane. The loop opens a PR after a green suite and never merges.

A repo seat may signal only processes descended from its own agent. The gate
checks ancestry with `ps` at call time and refuses when `ps` cannot tell. It
reads shell command text only: `node -e`, `python -c` and other interpreters,
a script file the seat writes and then runs, and aliases or functions defined
in an earlier call can still signal any process. It guards against a seat
stopping another lane's process by mistake; it does not contain a seat that
means to.

## Environment

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `CREW_READGATE_MAX_LINES` | `pi/extensions/readgate.ts`, `pi/extensions/skeletonread.ts` | 350 | Sets the whole-read line limit and skeletonread's source-line threshold; it does not limit skeleton output. |
| `CREW_READGATE_MAX_BYTES` | `pi/extensions/readgate.ts` | 24576 | Sets the read output byte cap and cat refusal threshold; directly handed files have an exception. |
| `CREW_ACP_PERMISSION_TIMEOUT_MS` | `pi/extensions/acp-server.ts` | 300000 | Sets the permission request timeout in milliseconds. |
| `CREW_ACP_BRIDGE_STARTUP_MS` | `pi/acp-bridge.mjs` | 120000 | Sets the ACP bridge startup timeout in milliseconds. |
| `CREW_MEMORY_DIR` | `lean.mjs` | `<checkout>/.claude/dev-team/memory` | Selects the memory directory loaded for a seat. |
