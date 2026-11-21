# ADR-054 — Each tier runs its own loop, and every stage earns its place

**Status:** *proposed* 2026-11-01, operator direction ("each lane type should have its loop"); §2–§4 amended by ADR-055; checkout suite coordination amendment 2026-11-18 (#2457), amended 2026-11-21 for suite slots (#2534); §2 pending build-suite cancellation amendment 2026-11-18 (#2459); §1 host-sleep re-run amendment 2026-11-19 (#2493); §1 fast-check amendment 2026-11-20 (#2509); §1 environment-signature re-run amendment 2026-11-20 (#2520) · **Owner:** operator ·
**Relates to:** ADR-052 (§6 the loop), ADR-053 (build first, prove after), ADR-038 (the judge floor forces proof),
ADR-051 (finish shape)

Today every lane runs the same loop whatever its tier; the tier only changes which models sit in the seats and their
effort. This record gives each tier its own loop and states the rule a stage must meet to be in one.

## Why (measured 2026-11-01)

An audit of 95 archived lean lanes (`~/crew-bench/loop-logic-audit-2026-11-01.md`; timings over the 44 lanes since
10-30 that carry timestamps) found stages that cost turns without changing outcomes:

- **The suite runs after review.** 36 of 116 suite runs were red, and each of 13 suite-repair turns then repeated the
  gate, the proof and the review.
- **The suite re-run after a red** left 16 of 17 lanes red: it changed no outcome.
- **The lead on the normal path.** 35 consults: 23 bounces, 8 escalations, 1 accept, 3 refused. It escalated 3 of 3
  builder escalations unchanged. After a builder `insufficient`, the next builder envelope was `done` in 2 of 14.
- **The rebase comes last.** In 12 of 69 lanes it moved HEAD, and the PR's measurement lines describe the tree before it.
- **Passing reviews drop their findings.** 22 of 87 passes carried findings (15 `should-fix`) that reached neither the
  builder nor the PR.
- **Planning is the largest share of wall time:** 185 of 471 stage minutes over the 44 timed lanes, against 131 for
  build and 111 for review. The blind score of a first plan does not sort lanes by outcome
  (`~/crew-bench/plan-review-vs-outcome-2026-11-01.md`).
- **Reviewers miss real bugs.** On 10 lanes whose built change carried a defect a later lane fixed
  (`~/crew-bench/defects-2026-11-01`), a `changes` verdict with a finding that names a defect file came back in 9 of
  30 live-reviewer runs and 14 of 30 at xhigh. That is an upper bound on catches, not a count of them: some of those
  findings name the defect's file but a different bug (b1433 at xhigh, run 2). On three lanes (b1402, b1441, b1452) no run of any reviewer,
  `sol-review` included, returned `changes` with a finding naming a defect file.

The tier mix is lopsided: of 97 archived lanes, 90 ran `build`, 6 `judge` and 1 `mechanical`. The build loop below
rests on that evidence; the mechanical and judge loops are design until their own lanes are measured.

## Decision

### 1. The rule

A stage is in a tier's loop only if it makes the change, proves something mechanically, or has a measured catch rate
worth its cost on that tier. A stage that fails the rule leaves the loop. No loop promises the best result; each keeps
every guarantee the loop can prove.

A fix turn is not a retry. After any fix turn the loop runs the proof, the suite and every review of that loop again on
the changed tree, within the role's round bound; a lane never publishes a tree that has not passed all of its tier's
checks.

A red suite or proof runs once more on the unchanged tree if the red attempt recorded a numeric
`sleep_credited_s` greater than zero. Absent, zero or `null` credit and suite-lock wait credit do not qualify.
The journal records both attempts. A green re-run takes the normal green path; a second red stops the lane
with `red-after-sleep-rerun`, even if that attempt also recorded sleep.

#### Amendment 2026-11-20: re-run a suite red on a declared environment signature (#2520)

On 2026-11-20, the-power lane `power-1910` waited 554 seconds for the suite lock.
Two `power-api` router tests then failed after 69 seconds with
`Database(PoolTimedOut)`, and the loop spent a suite-repair builder turn.
Lane `power-2086` recorded the same failure after 61 seconds.

Build, judge, mechanical and finish runs can opt in with `environmentSignatures`
in `.crew/project.json`. Onboarding validates and keeps the list of non-blank
strings without hashing it. Start snapshots it for the lane and its finish
passes. An absent or empty list changes nothing.

A red suite with `exit-nonzero` gets one re-run on the unchanged tree if either
captured stream contains a literal signature. Host sleep takes precedence; the
rules never stack, and proof is unchanged. The journal records both attempts
and the triggering signature on the second check row. A green re-run continues
and the PR reports the re-run and its cause. If the second result is also an
`exit-nonzero` red and matches any declared signature, stop with
`red-after-environment-rerun`. Otherwise the second result follows its ordinary
path.

#### Amendment 2026-11-20: run cheap checks before proof (#2509)

Measured on 2026-11-20 across 57 the-power lanes started since 2026-11-18:
29 of 102 suite runs were red, with a median red run of 589 seconds. Of those
29 red runs, 15 failed on subsecond source scanners (13 `power-acceptance`,
2 `power-spawn`). Red suites triggered 27 of 75 repeat builder turns. In
`power-1907`, test 22 of 1,515 failed in 0.5 seconds; the lane learned of the
failure 14 minutes later and repeated proof, review and suite. Run the cheap
checks earlier so a failure need not wait for the suite.

Build, judge, mechanical and finish runs can opt in with `fastChecks` in
`.crew/project.json`. The loop runs the commands in order after a builder turn,
the worktree path and symlink check, and any first-round base refresh. This
precedes proof, including lanes that require no proof tests, and does not run on
publishing-only checks or unchanged-tree proof re-runs. An absent or empty
list leaves the loop unchanged. Commands split on whitespace without a
shell, receive `CREW_LANE` and run in the lane worktree without the suite lock.
`fastChecksTimeoutMs` sets the deadline per command, 120 seconds by default.
Onboarding validates and keeps both settings without hashing them; start
snapshots them for the lane and its finish passes. `builderChecks` remain
instructions for the builder, not commands the loop runs.

Each attempt journals the command, status, reason and elapsed seconds as a
`fast-check` check row. A green list continues to proof. The first nonzero exit
skips remaining commands, proof, review and suite on that tree. It returns one
must-fix item with bounded output and spends rounds like red proof. A timeout
or unavailable measurement skips any remaining commands and continues to
proof without a repair finding. Fast checks can return work early, not pass a
lane; the suite stays the gate.

### 2. The loops

Every loop rebases onto `main` before the build, runs the ADR-053 proof (each acceptance id red on base, green on the
build, red under its kill-mutation), runs the suite (subject to §1's re-run exceptions), and puts a passing review's
`should-fix` findings into the PR body.

```
mechanical:  brief -> rebase -> build -> prove -> suite -> PR
build:       brief -> plan -> rebase -> build -> prove -> (suite || review) -> PR
judge:       brief -> plan -> rebase -> build -> prove -> suite -> review -> second review -> PR

repairable red check after applying §1's re-run rules -> one builder fix turn with every red result -> back to prove (bounded by rounds)
```

- **Mechanical** is for changes with no behaviour to judge: a rename, docs, a version bump, or a config value no code reads. A config value the loop or a seat reads
(a seat's `effort`, for example) changes behaviour and is not mechanical. The brief is
  the plan. The proof and the suite are the check; there is no review. A seat's `insufficient` or `escalate` stops the
  lane for the operator.
- **Build** runs the suite and the review side by side and hands the builder both results in one turn. A plan gap
  (a builder `insufficient` that names one) goes back to the planner once. A seat's own `escalate` goes to the operator
  without a lead round.
- **Judge** keeps the stages sequential so each sees a green predecessor, adds ADR-038's mutation on the changed
  behaviour, and adds a second review by the tech-lead seat, a different model family from the reviewer. Escalations go
  to the lead, then the tech-lead.

#### Amendment 2026-11-18: cancel a discarded build suite (#2459)

In a non-finish build round, after all reviews return and the valid verdict is
`changes-needed`, cancel a suite that is still running. Before the next permitted
builder turn, prove the POSIX process group absent (only `ESRCH` counts) and its
pipes closed, using the runner's TERM/KILL cleanup. If that proof fails, retain
the ordinary wait/completion/deadline path; an unproven cancellation cannot
release a builder. Seat bounds and reserve reviews do not change.

A completed suite keeps its result, red or green. A passing review still waits
for the suite. A successful cancellation journals `status: 'cancelled'`, elapsed
`seconds` and available output, never a green or red result. The builder receives
the review findings without a fabricated suite-repair finding. Publication must
cite a later green suite, never the cancelled run.

Measured in the-power lanes since 2026-11-12, read 2026-11-18: 12 build rounds had
`changes-needed` beside a suite; they spent 140 suite minutes, including 91 minutes
after review ended. Of those 12 suites, 8 were green and 4 red. Cancelling can
defer red-suite diagnostics by one round; how many of those 4 red results added
information beyond review was not measured. Judge, mechanical and finish runs,
proof and setup commands are unchanged by this cancellation rule. The re-run
exceptions in §1 use the same cancellation signal for both suite attempts.

Clarification 2026-11-18 (prose-drift audit, #2467): Pending includes suites
queued for the checkout lock, not only running suites. `crew/loop.mjs` supplies
the abort signal; `acquireSuiteLock` in `crew/suite-lock.mjs` returns cancelled
before publishing ownership. `crew/checks.mjs` reports proven cleanup without
launching a suite process when cancelled before launch, so no process teardown
is needed. Running suites still require the proven group and pipe cleanup above.

### 3. Measurement before each loop is adopted

*Replaced 2026-11-02 by ADR-055's "Measurement before ratifying": every loop is measured on its first 10 lanes, and
the ADR-053 replay below no longer decides the build loop. The original text follows.*

- **Build** first, on the ADR-053 replay of the 14 code corpus lanes with two arms: today's loop and the build loop
  above, both with a planner (operator decision 2026-11-01: the build tier keeps its plan). The build loop is adopted if
  it is not worse on blind diff pass and on known-defect findings.
- **Mechanical** and **judge** after their first 10 lanes each, compared on rounds, wall time, suite repairs and defects
  found after merge against the build tier.
- **Every loop** reports per lane: total wall time, rounds, suite-repair turns, lead consults, and whether the PR's
  measurement lines describe the merged tree.

### 4. Choosing the tier

The brief's `tier` chooses the loop, and the `lane-brief` skill states when each applies. A change that touches the
loop's own enforcement or a decision record stays `judge` (ADR-052). A `mechanical` brief must name no behaviour change;
a lane that turns out to change behaviour is a wrong tier, and the operator restarts it as `build`.

## What this does not decide

- **The shapes.** `stepped` and `finish` keep their current paths; this record only changes `standard`.
- **Provider fallback.** A provider usage limit stopped every pi seat on 11-01; failing over to a declared fallback is a
  separate decision.
- **The reviewer's model and effort,** and which skills each seat holds.

If ratified, this supersedes ADR-052 §6 for the `standard` shape.

## Amendment 2026-11-18: checkout suite coordination (#2457)

Optional boolean `suiteLock: true` in `.crew/project.json` queues the checkout's
project suites across lane processes and worktrees, with ownership in the
shared Git common directory. Separate checkouts remain independent. Absent or
false leaves suites unlocked; invalid values are refused. Start captures the
setting for the lane and its finish passes, including publishing-rebase suite
rechecks. Adding or removing it needs no re-onboarding and does not retrofit
already-started lanes.

Acquisition waits at most two hours, outside `suiteTimeoutMs`. The suite journal
result records measured `suite_lock_wait_s`. Exhaustion stops unmeasured with
`suite-lock-timeout` and `suite_lock_holder` diagnostics; I/O or resolution
failure stops `suite-lock-unavailable`. Ownership is reclaimed only on proven
death, never by age. Unreadable or uncertain holders stay unknown and
unreclaimed. A surviving suite process group prevents reclamation even after
its launcher dies. Proof, worktree setup, onboarding and builder checks remain
unlocked; lane concurrency does not change. Each suite attempt uses the same lock
setting. Sleep credited while waiting for the lock does not trigger §1's host-sleep re-run.

Suite, proof (base/build, setup and listing) and `worktreeSetup` commands receive
`CREW_LANE`, the lane name, overriding any inherited value only in the child
environment. Scripts can name per-lane databases, ports or containers instead
of queueing. Onboarding has no lane name. Neither queueing nor service naming
selects affected packages; the project script owns that choice.

Two measured the-power suites ended 26 seconds apart with Postgres connection
errors on 2026-11-17. Overlap was measured, but it was not proven to be the
outage's cause. This amendment makes no claim that queueing alone would have
prevented it.

## Amendment 2026-11-21: project suite slots (#2534)

This extends the [checkout suite coordination amendment](#amendment-2026-11-18-checkout-suite-coordination-2457).
Optional `suiteSlots` in `.crew/project.json` is an integer from 1 to 8 and
defaults to 1. Onboarding validates and retains it without hashing it. It has
no effect when the lock is off and is not a personal settings key. Start
snapshots the count for the lane, its planning resumes and its finish passes,
including publishing-rebase rechecks. A valid count edit affects only new lanes
and does not make finish acceptance stale.

With the lock on, a lane takes any free slot up to its count, without waiter
ordering. Slot 1 keeps the original `crew-suite-lock/` directory and epoch
format; slots 2 through 8 use numbered subdirectories. Older runners use only
slot 1 and still exclude new runners there. The largest participating count
bounds the number of locked suites running at once.

All slots share one two-hour sleep-credited acquisition budget, outside the
suite budget. The suite check result adds `suite_lock_slot` on acquisition or
`suite_lock_holders` on `suite-lock-timeout`, with the last observation for each
eligible slot. `suite_lock_holder` remains the slot 1 diagnostic. Recovery clears
all slots: ensure no suite in any worktree is running or waiting before removing
`<git-common-dir>/crew-suite-lock/`.
