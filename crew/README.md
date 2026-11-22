# crew — the lean runtime

One brief in, one lane out. Agents do the work; code only starts it, checks it
and records it ([ADR-052](../docs/adr/adr-052-agents-do-the-work.md)).
[`docs/plan-lean-runtime.md`](../docs/plan-lean-runtime.md) is the historical
plan, superseded by this README.

```
crew onboard (--check <draft.json> | --seats) [--checkout <dir>] # calibrate the checkout or probe its seats
crew start <brief.md> [--checkout <dir>]             # worktree + journal + a detached lane
crew lanes [--all] [--json]                          # list lanes from their journals
crew steps [--since <ISO date>] [--json]             # count lane steps and repeat builder triggers
crew show <lane> [<role>] [--json]                   # read a lane's recorded seat sessions
crew finish <lane>                                   # report a stopped or ready lane, read-only
crew finish <lane> --accept [--notes <file>] | --return <file> | --abandon
crew record-pr <lane> --pr <url>                     # record a hand-opened PR for a stopped or quiet ready-for-operator lane
crew closeout <lane>                                 # remove a merged lane's worktree and branch, archive its directory
crew closeout <lane> --discard                       # archive a stopped lane with no PR or a CLOSED PR
crew viz                                             # serve the visualizer from the crew home
crew where                                           # the crew home, its branch and its commit
crew update [--force]                                # fast-forward the crew home to origin/main and rebuild what changed
```

`crew` is `bin/crew.mjs`. The crew home is the checkout it lives in (symlinks
resolved), or `CREW_HOME` when set. State lives under `~/.crew/dt-<lane>/<lane>/`:
the brief, the task directory, the lane journal and every seat's session file.

`crew steps` uses the live and archived lanes found by `crew lanes --all`.
It includes lanes whose first journal row is at or after `--since` (for example,
`2026-11-20`), or within the last seven days by default. `--json` prints the same
report as one object. Unreadable journals and journals with no usable first-row
time are listed with a reason and excluded from the totals.

Each lane shows seat turns by role, suite runs and red suites, proof runs, and
hand decisions by choice. A minimal lane has one builder turn, one suite run,
no hand decision and no extra seat turns. Build and judge lanes allow at most
one planner turn and require one reviewer turn; judge also requires one tech-lead
turn. Mechanical lanes have no planner or reviewer turn. The per-lane flag does
not require a PR.

After the first builder turn, the report lists each repeat and its journaled
trigger: `suite-red`, `fast-check-red` (a measured red fast check),
`proof-unproven`, `rebase-conflict`, `review-changes`, `finish-triage`, `replan`
or `unclassified` when the journal does not establish one.
Totals show minimal lanes out of lanes with a PR, repeats by trigger out of
all builder turns, red suites out of suite runs, and the number of excluded lanes.
The command writes nothing and starts no child processes.

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
`crew/seat-reap.mjs`). Before removing a present worktree, both commands also
send SIGTERM to individual processes whose executable resolves inside it, then
SIGKILL to those still running after five seconds. They report the PID,
executable, and whether the process was proven stopped. They report but do not
signal processes whose only link is their working directory, and say when working
directories could not be checked. Unproven stops and unavailable checks do not
block removal. If the worktree is already absent, both process checks are skipped.

`crew update` refuses unless the crew home is on branch `stable` with no tracked changes; `--force` only overrides the refusal when processes still run from the home.

## The model

**Agents do the work; code keeps it correct.** A lane starts from one P1 brief
(`source`, `closes`, `shape`, optional `out_of_scope`, `mechanical`, `generated` and `regenerate`; absent `out_of_scope` means none. The
body has the quoted operator ask and bare Context pointers, or bare Context pointers alone for an issue; `crew start` quotes the issue body as the ask). `crew/loop.mjs` runs it:

```
build:      plan -> rebase -> build -> refresh base -> [fast checks] -> per-test proof -> (project suite || review) -> PR
judge:      plan -> rebase -> build -> refresh base -> [fast checks] -> per-test proof -> project suite -> (review || second review) -> PR
mechanical: rebase -> build -> refresh base -> [fast checks] -> per-test proof -> project suite -> PR
```

Authors write bare `issue N` pointers in `## Context`, not a `## Referenced issues` section. For both issue and operator-request briefs, `crew start` fetches each distinct Context issue other than the source and puts its title and whole quoted body in that section immediately after Context. Referenced issues are context, not asks; only `closes` binds an issue. An unreadable reference refuses start before worktree creation and names the issue. An empty or whitespace-only body appears as `empty body` with its title. `PR N` pointers are not fetched. Finish passes use the same enriched run brief.

On judge lanes, review rounds start the reviewer and tech-lead independently on the same checked tree after a green suite, including raised lanes and full moved-head rechecks. A lock-file recheck starts both seats after proof and fast checks instead. A proof-only publishing rebase starts neither seat. The tech-lead stage remains `second-review`. The loop waits for both returns before giving the builder both seats' findings and omission notices in one feedback list, or publishing after both pass. A halt from either seat drains and journals its sibling before the loop returns stopped. Seat bounds and counting do not change; moved-head recheck turns remain free. Build, mechanical and finish scheduling is unchanged, with no tech-lead turn.

On non-finish build lanes, once all reviews return a valid `changes-needed` verdict, the loop requests cancellation of a still-running suite. Before another builder turn, it proves the POSIX process group absent and its pipes closed; if cleanup cannot be proven, it keeps the ordinary wait/completion/deadline path. Completed suites, red or green, keep their results, and passing reviews still wait for the suite. A cancelled suite journals `status: 'cancelled'` with elapsed `seconds` and retained output, not green or red. It adds no suite-repair finding and cannot supply the PR's suite citation; publication still needs a later green suite. The cost is potentially learning of a red-suite failure one round later. This cancellation rule does not apply to judge, mechanical, finish, proof or setup runs. See the dated issue-2459 amendment in [ADR-054 §2](../docs/adr/adr-054-each-tier-runs-its-own-loop.md).

A fix turn carries the red results back to the builder, then repeats configured fast checks, proof, the suite and any needed reviews. In build, judge and finish runs, each review role reuses its own latest verdict and findings if it passed the same tree id earlier in that run. Reuse journals `review-reused` with the role, tree and `pass` verdict, without seating the role or spending a review round or reserve review. A changed tree, a pre-check base move or a latest verdict of `changes-needed` still requires review. Under [ADR-054 §1](../docs/adr/adr-054-each-tier-runs-its-own-loop.md), a red suite or proof with positive run sleep credit gets one unchanged-tree re-run. Both attempts are journaled. A second red stops with `red-after-sleep-rerun`.

Optional `environmentSignatures` in `.crew/project.json` lists non-blank strings such as `PoolTimedOut`. If a suite ends red with `exit-nonzero` and a literal signature occurs in stdout or stderr, the loop re-runs the suite once on the unchanged tree before spending a builder turn. Host sleep takes precedence and the two rules never stack. Another matching `exit-nonzero` red stops with `red-after-environment-rerun`; other second results follow their ordinary paths. The second check row names the triggering `environmentSignature`, and a green re-run is reported in the PR. This applies in every tier and finish, including publishing rechecks, not to proof. An absent or empty list changes nothing. `crew onboard` validates and keeps the list without hashing it. `crew start` snapshots it for the lane and its finish passes; edits do not affect lanes already started.

Only the first check round of each start run or finish pass fetches and measures the base before proof, the suite and review. An unchanged base adds only fetch and base measurement, and still consumes that run's refresh. Later proof retries, review fixes and suite repairs neither fetch nor move the base before checks, including repairs after a publishing recheck; they hold the base already checked out until publishing. A new finish pass gets its own first-round refresh. If the base moved, the loop temporarily commits the measured lane paths, rebases through the existing ignored/generated-file rules, then soft-resets onto the new base, leaving the build uncommitted. Proof's old source is that fresh base. The next review stays full and counted; earlier findings remain, but delta/reserve/recheck scopes do not. The `pre-check-base-move` journal row records old/new base and review intent. This move grants no rounds and spends none of `MAX_RECHECKS`. A dropped change stops `nothing-to-commit` before checks; a terminal fetch failure stops before snapshotting, with the existing ref-lock retries.

Before publishing, each lane still commits and rebases. Initial finish, pre-check and publishing rebases share up to three builder conflict turns per run. After the first turn, the attempted base must differ from the previous turn's base. A conflict that gets no turn or remains unresolved stops `rebase-conflict`. Failed moves restore uncommitted work only when cleanup is proven. If Git drops the commit as already upstream, the lane stops.

Build and judge lanes, including planning resumes, may publish a moved head without repeating the suite or reviews. The rebase must need no builder conflict turn, all three path lists must be measured, the lane must touch the same paths before and after the rebase, and the base's changes must share none of those paths. Both names of a rename count. The loop keeps the rebased commit, repeats proof against the new base if the lane named tests, and requires a clean worktree at that exact head before publishing. It does not fetch again or spend a recheck or review round. The `recheck-scope` row and PR Verification identify the commit the suite and reviews checked, both bases and the rebased commit.

If the rebase meets the same conditions but shares only lock files, build and judge can keep the rebased commit and skip only the suite. The loop repeats proof, requires every configured fast check to pass without changing the Git worktree or `HEAD`, and starts a new scoped review in each required seat. The `recheck-scope` row records `suite: "skipped"`, `reason: "lockfile-only"` and the shared paths. PR Verification names the commit the suite checked, both bases, the rebased commit, the lock files and the green fast checks. The final clean-worktree and exact-head check still applies. If review asks for changes, the loop soft-resets onto the new base and the builder's next change needs the suite again.

A lock-file recheck spends one of the three publishing rechecks. A lock-file candidate falls back to the full recheck if fast checks are absent, proof or a fast check is not green, or a check changes the Git worktree or head. Rebases that qualify for neither shortcut also take the full recheck. On that path each review seat can reuse only its latest pass on the same tree. Recheck reviews cover unresolved findings, lane code altered by the rebase or conflict turn, and where the base's changes meet the lane's diff. If the scope is unmeasured, the review is full and the journal says so. Finish passes always repeat checks on a moved head without measuring scope. Mechanical lanes still re-prove and rerun the suite on the committed rebased head. See [ADR-055](../docs/adr/adr-055-planner-defines-the-work.md#amendment-2026-11-22-skip-the-suite-after-a-lock-file-only-publishing-rebase-2538) for the built-in lock-file names.

Set `suiteLock` to `true` in `.crew/project.json` to queue project suites across lane processes and worktrees. For every lane started on this machine, set `{"suiteLock": true}` in `~/.crew/settings.json`. Either key being `true` enables the lock; a missing or `false` personal key leaves the project value in charge. The preference applies across repositories, but the lock lives in the Git common directory, so repositories with separate common directories do not queue each other.

Set `suiteSlots` only in `.crew/project.json`, to an integer from 1 to 8 (default 1). With the lock on, a suite takes any free slot up to its lane's count or waits without a guaranteed order. Without the lock, the count is still validated but has no effect. Slot 1 keeps the original directory and epoch records; older runners use only that slot. With different counts, the largest count among the locked lanes bounds concurrency.

`crew start` reads the personal file once and snapshots the effective lock and project count for the lane, including planning resumes, finish passes and publishing-rebase rechecks. Edits do not affect running lanes or require re-onboarding. A missing personal file is fine. If the file cannot otherwise be read, is not a JSON object, or has a non-boolean `suiteLock`, start names the file and key and refuses before creating a worktree. Other personal keys do not affect this check. Onboarding does not read the personal file. Proof, worktree setup, onboarding and builder checks are not locked, and lane concurrency is unchanged.

Acquisition waits at most two hours of awake time, separately from `suiteTimeoutMs`, which starts after acquisition. The suite's journal `check.result.suite_lock_wait_s` records total measured elapsed acquisition seconds, including suspension. `suite_lock_sleep_credited_s` records acquisition sleep credit separately from the suite subprocess's `sleep_credited_s`. Measured zero may be absent. If sampling is unavailable, acquisition credit is `null` with `suite_lock_sleep_credit_reason: 'clock-unavailable'`, and ordinary elapsed-time enforcement remains in effect. An acquired lock records `suite_lock_slot` (1-based). A bounded wait stops unmeasured with `suite-lock-timeout` and `suite_lock_holders`, the last observed holder or unknown state for each eligible slot. `suite_lock_holder` still reports slot 1 for lock failures, including `suite-lock-unavailable` on I/O or resolution failures. Holder details include lane, host, PID/start identity, process group and live/dead/unknown state when available. Only proven-dead ownership is reclaimed, never an old timestamp. An unreadable or uncertain owner stays unknown and is not reclaimed; a surviving suite process group also prevents reclamation after its launcher dies. To clear an unknown or wrongly live-judged holder, first ensure no suite in any worktree is running or waiting, then remove `<git-common-dir>/crew-suite-lock/` to clear all slots (resolve the common directory with `git rev-parse --git-common-dir`).

Suite, proof (base/build, setup and listing), `fastChecks` and `worktreeSetup` commands receive `CREW_LANE`, the lane name, overriding an inherited value only in the child environment. Project scripts can use it to name separate databases, ports or containers. This is independent of suite queueing and affected-package selection; onboarding has no lane name to supply.

Optional `builderChecks` in `.crew/project.json` is a list of non-empty, one-line commands. Its lines appear verbatim in a `## Project checks` section of build, suite-repair and finish builder prompts. Builders run them and report each result in `notes`. The loop never runs them or reads their results; no journal row or PR line reports them, and the suite stays the gate. Editing the list does not require re-onboarding.

Optional `fastChecks` in `.crew/project.json` lists nonblank, NUL-free commands for the loop to run. An absent or empty list does nothing. `crew onboard` validates and keeps the settings; `crew start` snapshots them for the lane and its finish passes. Editing them does not change the onboarding hash or affect lanes already started.

After a builder turn passes the worktree path and symlink check, and after the first-round base refresh, the loop runs the commands in order before proof, even on lanes that require no proof tests. It splits each command on whitespace without a shell and runs it in the lane worktree without the suite lock. The default deadline is 120 seconds per command. Set `fastChecksTimeoutMs` to a safe integer from 1 to `2**31-1` to override it in milliseconds. Publishing-only checks skip fast checks except on lock-file rechecks, which run them after proof. A lock-file recheck runs fast checks on the clean, committed rebased head, so a command that scopes itself to the change must run everything on a clean tree. Unchanged-tree proof re-runs do not repeat fast checks.

Each attempt writes a `check` journal row with `check: 'fast-check'`, the configured `command`, `result.status`, `result.reason` and elapsed `seconds`. After a builder turn, if all commands are green, the loop continues to proof. The first nonzero exit returns to the builder with one must-fix item naming the command and carrying bounded output, under the same round rules as a red proof. No remaining command, proof, review or suite runs on that tree. A timeout or a command that cannot be measured skips any remaining commands and continues to proof without a must-fix item. Fast checks do not replace the initial suite. See [ADR-054 §1](../docs/adr/adr-054-each-tier-runs-its-own-loop.md#1-the-rule) for the measurements behind the stage.

`DEFAULT_ROUNDS` in `crew/loop.mjs` bounds seat rounds. When the reviewer's last round returns `changes-needed` or a red suite, `reservePending` and `reserveSpent` grant a reserve re-review after repair; once spent, the loop stops at `round-bound` before another builder turn. `MAX_ENVELOPE_REPAIRS` in `crew/loop.mjs` permits one envelope repair turn.

A brief may choose `mechanical: true` for a change with no behaviour to judge. With no named test, its PR states `proof: none, mechanical lane, not reviewed`; the operator reviews the diff before merging. Protected paths restart it as judge, and builder insufficiency restarts it as build.

Optional `worktreeSetup` in `.crew/project.json` is a non-blank command split on whitespace without a shell, like a proof entry's `setup`. `crew start` runs it once in the new worktree before launching the lane, with a 10-minute timeout. Failure or timeout is printed and recorded in the journal as red or unmeasured but does not stop the lane. If git reports changed or untracked paths after setup, start names them and refuses to launch; ignored paths are allowed. The proof also runs it once in its detached base worktree, with the same timeout, before any entry runs; there a red setup makes the proof unmeasured with `setup-failed`. Changing or adding the command requires onboarding again.

Optional personal `~/.crew/settings.json` key `runEndCommand` names a non-blank,
NUL-free command. Project settings and lane specs cannot select it. The runtime
reads it when a run ends, splits it on whitespace without a shell, and appends
four separate arguments: lane name, ending, payload, and checkout path. It runs
once in that checkout. Endings and payloads are `stopped` with the stop reason,
`pr` with the opened PR URL, and `finish-ready` with literal `finish-ready`.
A finish-ready notification does not mean a PR opened; a later successful
`crew finish <lane> --accept` sends the `pr` notification after recording acceptance.
Reporting, return/abandon decisions and refused publication do not notify.

The command uses `runSuite` with a five-second awake-time budget and bounded
process-group cleanup (up to 150 ms TERM grace plus 1,000 ms reap wait). Output
is bounded and discarded, not printed or included in the lane result. A separate
`run-end-command` journal event records the ending, payload, configured command,
timestamp and execution status, reason, exit code, signal and timeout flag.
Settings, execution and notification-journal failures never change the lane's
result. Invalid or unreadable settings get a best-effort unmeasured event;
unknown measurements are null. An absent file or key does nothing and adds no
event. No notifier program is supplied. A run whose process dies cannot notify;
dead-run recovery does not send a notification retroactively.

The lane name is the brief's file name. `crew start` runs the `standard` shape
only; `finish` (ADR-051) is the second entry path. `crew finish <lane> --return <file>`
resumes a planning stop before any build, or starts a finish pass on a finishable
post-build stop, provably dead run or ready lane. `<file>` is a notes file, not
inline text; its guidance stands for the whole run and a new return replaces it.
A pre-build planning stop resumes in the same lane, branch and worktree, preserving
seeded files and previous returns and sessions. An accepted current planner done
return with an unresolved lead decision resumes at the lead; otherwise the planner
reruns with the previous evidence. Planner and lead receive labelled operator guidance
and the stopped lead's question. A lead bounce can revise the plan. Once the plan
is accepted, the lane runs its normal tier checks with fresh round budgets: build
runs review and suite together, and judge gets reviewer and tech-lead review
after a green suite.
The lane opens and records the PR without `--accept`. Merging stays with the
operator. Another planning stop before any build can resume the same way.
Baseline-only stops still refuse. Post-build passes stop at `finish-ready` for
`--accept` and cannot reopen planning: abandon, close out with `--discard` and
restart from the brief when the build needs a new plan (ADR-051).
A `--return` pass whose branch equals its base after the initial rebase still runs the build; a later pre-check move that drops the change, or the commit stage, can stop `nothing-to-commit`.
In a finish pass, the first repairable suite red after applying ADR-054 §1's re-run rules gives the builder its one repair turn. The repair repeats proof and the suite, and repeats review unless the reviewer already passed the same tree in this finish run. The finish report lists only reviews actually performed. After repair, the suite must pass, either on its first attempt or on a permitted re-run. An unmeasured suite stops without repair.
Bare `crew finish <lane>` reports without writing.
A claim whose run is provably gone is taken over. A committed
build with no remote branch is uncommitted and finished if HEAD is the commit or
its journal-recorded one-commit rebase. The latter is reset onto the rebase base;
the journal records `finish-uncommit`. `--return` refuses with `finish-rounds-spent`
once the review rounds in `FINISH_REVIEW_ROUNDS` in `crew/checks.mjs` are spent. When not eligible for reuse, the review after the one suite-repair turn is free; the repair does not fetch or move the base before checks. A first-round pre-check move still requires a full, counted review, so a spent cap stops it. A post-suite moved-head recheck review remains free and runs even when the cap is spent. On `--accept`, issue tokens in the measured
text and notes are rewritten; issue numbers appear only on trailer lines.

If every unproven named test timed out on the old source or the build, the proof is unmeasured. The lane stops `proof-timeout` without another builder or lead turn. The verdict observation shows each timed-out test, which side timed out, and the `proofTimeoutMs` used. The usual recovery is to raise `proofTimeoutMs` in `.crew/project.json` and run `crew finish <lane> --return <file>`. During build proof, if any unproven test has another reason, the proof stays red and builder feedback includes the timeout rows too.

A finish pass uses the larger of the lane's timeout and the timeout in the Git tree under check, including raises brought in by rebase. If worktree onboarding is unreadable or differs from what Git will include, the check keeps the lane budget and records the effective timeout and fallback reason.

`--accept` reads worktree onboarding only from a regular file. For a gated lane, its hash must match the calibrated rebase base recorded in the journal, or the start hash if the base file cannot be read. A hash or calibration mismatch refuses `onboarding-stale`; a suite mismatch or a lowered timeout also refuses and names the field. A raise matches when the measured commit carries the same value as the worktree. The measured commit must also carry at least the budgets recorded for the checks that qualified it, even if the worktree timeouts match the lane's. The decision row records the start and finish onboarding hashes, even when equal.

Every loop is bounded, every envelope is
validated against a closed protocol (P2) and refused if it does not parse, and
the loop adds no other gate: no host-load gate, no dispatch-time baseline, no
measurement that holds work. Journal writes do not throw into the caller. A failed session-file write fails the turn (`crew/lean.mjs`, `guardedAppend`). The operator decided on 2026-11-12 to keep it: a turn with no recording cannot be inspected with `crew show`.

ADR-055 §12 routes a builder escalation or a done lead escalation without `details.question` back to the same seat. As an operator-selected exception, planner, reviewer and tech-lead `insufficient` or `escalate` returns stop `seat-escalated` with a valid `details.question`, falling back to `summary`. No usable planner artifact or completed review is required. A non-done lead `decision: escalate` stops `lead-escalated` with the same fallback; valid bounce/accept decisions keep their routing. On build and judge and in finish runs, a builder's `insufficient` goes to the lead with its envelope unless it names no `details.gap` after a turn that changed the worktree, in which case it continues without a round up to the lane's progress cap. Finish suite-repair turns and all non-finish mechanical builder turns do not continue this way: a non-done finish suite-repair return stops, and non-finish mechanical insufficiency restarts as build. The lead routes other builder insufficient returns to the builder or planner where available, or escalates a §12 case. The lead's last consult in a phase is marked last; a phase reset or refunded bounce can reopen consults, and a spent lead bound stops for the operator with a question drawn from the held envelope and lead decision. A builder bounce after a changed builder turn refunds the lead round up to the shared cap of 6 continuations and refunds. For a builder held at its round bound, the last completed turn can refund once, unless the held feedback carries a must-fix id from the same seat in the previous consult. A planner bounce or an unchanged or unmeasured turn spends the bound; finish runs follow the same rule. Repeated failures with the same evidence stop as `no-progress` without a seat decision. On build and judge lanes the planner's P2 `details.tests` decides whether P3 proof is required; an empty list means no criterion is machine-checked. A mechanical builder may name no test.

Seat definitions are `crew/agents/<role>.md`; their frontmatter supplies the
default model, agent (`claude`, `pi` or `muse`), effort, skills, `requires`
and extensions, and the body is the charter. Tiers are
`mechanical`, `build` and `judge`; a tier entry overrides how a seat runs there
or unseats it. `crew/agents.mjs` resolves a tier and `crew/protocols.mjs` holds
the brief, envelope and agent-definition validators. ADR-055 §7 raises lanes to judge for the planner's reason or protected paths; it never lowers them.

Optional `protectedPaths` in `.crew/project.json` adds to the built-in protected paths. Use literal repo-relative entries, not globs. For example, `["migrations/", "config/billing.toml"]` protects the entire migrations directory and only the billing file under config. An absent or empty list adds nothing. `crew onboard` validates and keeps the list without hashing it. `crew start` snapshots it for the lane, including planning resumes and finish passes. Later edits affect only new lanes and do not require re-onboarding.

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

### Host sleep

On macOS, `crew start` and `crew finish` launch `caffeinate -i -w <run-pid>` after the detached run starts. This blocks idle sleep only, for that run's lifetime. It does not keep the display on or prevent lid-close sleep. Other platforms, or a missing `caffeinate`, start normally without an assertion.

Seat waits, suite-lock acquisition and all `runSuite` subprocesses (suites, proofs, fast checks, worktree setup, onboarding, and git/gh checks) sample a monotonic elapsed clock at intervals of at most 25 ms (shorter for the remaining budget). A gap strictly greater than 5,000 ms credits the gap minus the scheduled interval before testing expiry. Clocks that exclude suspension produce no suspended gap and need no credit. This is a heuristic: a sufficiently long event-loop stall can also earn credit. Seat setup deadlines and provider backoff budgets are unchanged, as are the values and defaults of `wait_s`, `suiteTimeoutMs` and `proofTimeoutMs`. Work that spends its budget awake still times out.

Credited seconds appear as `sleep_credited_s` on `seat-turn` rows and in suite, proof and fast-check `check.result` objects. Proof sums credit once across its subprocesses, including setup, probes and cleanup. Measured zero may be absent. If sampling is unavailable, `sleep_credited_s` is `null` with `sleep_credit_reason: 'clock-unavailable'`, and ordinary elapsed-time enforcement remains in effect. A proof containing any unavailable measurement reports an unknown total. Seat `seconds` remains wall duration, not the credited budget. Suite-lock acquisition has a separate two-hour awake budget: `suite_lock_wait_s` includes suspension, while `suite_lock_sleep_credited_s` reports its credit without adding it to subprocess credit. Acquisition uses the same zero/unavailable conventions, with `suite_lock_sleep_credit_reason: 'clock-unavailable'` when credit is `null`.

Sleep does not repair a lost provider connection: that turn fails normally and gets the existing single rerun. A genuine `seat-unmeasured` stop still needs inspection and recovery, not a larger limit.

After an `acp-seat-deadline` cut, the one rerun receives the original prompt plus a note with the previous attempt's limit: it was cut without a return, partial changes remain in the worktree, a long-running command may have been killed, and the seat must return before the limit. Other turn errors keep the original prompt unchanged. A second cut stops `seat-unmeasured`.

## Test selection

A lane adds no test by default, in every checkout. A bug fix gets one regression
test. A change where a failure would lose data, cross a security boundary, or
break a wire or file format another program reads gets one test when no existing
test already covers that path. The brief's ask governs test selection only when
adding or changing tests is the purpose of the lane. A test merely named or listed
within a behaviour change, including in a referenced issue, follows the same
no-test rule and its exceptions. Add an assertion or table row to an existing test
already driving the path before writing a new test. Repairing or removing an
existing test that the change breaks is maintenance, not an added test.

The planner lists only selected changed behaviour in Properties, with the
applicable exception or explicit test ask and the test's file and title. Other
changed criteria go under Not machine-checked because the rule calls for no test.
When omitting a test named in the source or a referenced issue under this rule,
the planner names the test there and explains why the rule calls for no test.
Properties with none means `tests: []`. Characterization and test-hardening suite
regression locks need an explicit ask or an applicable exception. The builder
writes only plan-named tests; a mechanical builder applies the rule without a
plan. Reviewers (including the tech-lead) require removal as a `must-fix` of a new
unplanned test whose builder notes justify neither exception, respecting explicit
test asks for test-purpose lanes and existing-test maintenance. An unmet ask for
such a lane remains an unmet requirement. A missing test is otherwise a finding
only when an exception applies and no existing test covers the path. Reviewers do
not report a test omitted under the rule as an unmet requirement merely because
the source or a referenced issue names it.

This is a charter rule, not a project setting or engine change. Proof, the suite
gate, review and the PR's proof lines stay unchanged. After 20 planned lanes per
checkout on the new charters, repeat the test counts from issue #2437, targeting
a median of 0 named tests per lane. Also count bug-fix lanes repairing defects
introduced by lanes with no test. The reported baseline and measurement recipe
are in [ADR-055's 2026-11-17 amendment](../docs/adr/adr-055-planner-defines-the-work.md#amendment-2026-11-17-no-test-by-default).
That follow-up has not run.

## Checks

`crew/proof.mjs` and `crew/checks.mjs` own what code verifies:

- **Proof** — each named test normally must fail in its own body on the old source and pass on the build. A runner's optional `manifest` file name lets a new package's own test prove on a green build alone when its manifest is absent from the old-source commit (`base-package-absent`); there is no red side. With `newTestFile: true`, a no-report old-source run can instead prove on a green build report if the test file is absent from the old-source commit (`base-test-absent`). Both exceptions are weaker evidence: a vacuous test can pass. Neither is a kill proof.
- **Suite** — the project-defined command runs with a timeout and a process-group kill. Commit measurements and PR or finish verification name the command; green does not imply full coverage.
- **Commit, rebase, PR** — only on green; the PR is opened, never merged.

### Suite Git state

On lane or finish suite invocations, the lane change is uncommitted
over the held base commit at `HEAD`, not necessarily the latest remote tip.
Only the first check round refreshes the base; later repairs keep it until
publishing. A new finish pass refreshes on its first check round again.
The same uncommitted state holds after first-round pre-check base moves and
full build, judge or finish publishing-rebase rechecks: the loop soft-resets to
the new base before checks. There are no lane commits above `HEAD` at those checks.
Proof-only and lock-file publishing rechecks on build or judge run no second suite when their checks pass.
The loop stages measured lane paths before the suite, but a project script
should discover staged and unstaged tracked changes against `HEAD` plus
nonignored untracked paths, using NUL-delimited Git output.

Exception: a mechanical lane's publishing-rebase recheck runs on the committed
rebased head, without a soft reset. A clean tree must therefore select the full
suite, as it must during onboarding or a hand run with no lane change. Do not
infer a base from a branch comparison or expect a base environment variable.
The project script owns affected-package selection, not the plugin. See the
[onboarding guide](../skills/crew-onboard/references/affected-suite.md) for
selection rules, full-run fallbacks and approval trials.

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
  Suite and proof `check` rows record elapsed `seconds` around the runner, excluding
  output-file writes. Unknown timing is `seconds: null` with
  `secondsReason: 'clock-unmeasured'`. Non-green checks save captured output as
  JSON `{stdout, stderr}` in the task directory; the row's `outputFile` names it
  relative to that directory. A stream the runner did not return is `null`, and a
  runner that returned neither (it threw, for one) writes no file: `outputFile: null`
  with `outputError.code: 'output-uncaptured'`. Decode both strings to read the full capture,
  including lines before the journal's unchanged 4096-character tails and byte
  counts. Capture is still bounded by the runner's existing 64 MiB output limit
  per subprocess. Green checks create no output artifact. A failed write does
  not stop the lane: `outputFile: null` and `outputError: {code, message}` mean
  unavailable output, not empty streams. Closeout archives these files with the
  task directory; resolve `outputFile` beside the archived `journal.jsonl` too.

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
- `show.mjs`, `lanes.mjs`, `steps.mjs`, `finish.mjs`, `record-pr.mjs`, `closeout.mjs`: the other verbs.
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
