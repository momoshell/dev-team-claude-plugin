# Closeout

There are **two** closeouts and they order teardown OPPOSITELY. Decide which
one you are in before you run anything: one of them tears down last, the other
tears down first, and applying the wrong one puts a live seat inside your
commit.

## Which closeout is this?

One question decides it: **did the driver settle this lane's seats?**

| The lane… | Closeout | Teardown |
|---|---|---|
| reached `done` and its own driver archived the crew dir | **normal** | last |
| escalated, or its driver exited while its seats may still be running | **recovery** | first |

A run that reaches `done` tears itself down. The other half is policy in code
at `crew/crew.mjs:2231` — an escalated lane never auto-tears-down, because its
live workspace IS the escalation context the human needs. So an escalated
lane's seats are **live until proven otherwise**, and quiet panes are not
proof. Measured today on `b196-dispatchexec`: it escalated at `review:r3` and
its driver exited while TWO claude seats were still running.

If you arrived after the driver was gone, or you are adjudicating an
escalation by hand, you are in the recovery closeout.

## Preserve first

Both closeouts start here. Complete the quiet-tree precondition below before
inspecting, repairing, renaming, or making the preserve copy:

### Precondition: prove the tree QUIET first

Preserve-by-copy (#512) copies a **moving target** if a seat is still writing.
This was measured on `b254`: it escalated at 10:58, its builder wrote a test
file at 10:52 and its envelope at 11:03, and teardown reported
`seats:5 proven:0 unproven:5` — five closes logged, none proven, while the
orphaned builder kept mutating the checkout for about two hours. #574 records
that seats outlive the driver; this is the sharper form.

As a check, take **two reads** some seconds apart of BOTH the newest
**transcript** mtime and the **worktree**'s newest file mtime:

```sh
newest() { find "$1" -type f -exec stat -f '%m %N' {} + | sort -rn | head -1; }
newest <transcript-home>; newest <worktree>; sleep 10
newest <transcript-home>; newest <worktree>
```

Equal on both reads means the tree is quiet, and the copy is evidence.
Advancing on either read means a seat is still writing and the copy would be a
smear: tear down first (the recovery closeout), then read the tree after.
A missing transcript home is `unknown`, not quiet; cross-reference
[`references/liveness.md`](liveness.md).

```sh
cp -a <state-dir> <state-dir>.recovery-copy
```

Do not rename a live state directory as a shortcut for preserving it. Each
seat's launch command contains an **absolute** `task/role-<seat>.md` system
prompt path, written and read back at boot. The b150-permprobe lane proved the
failure mode: after a live rename, relaunch reported `Append system prompt file not found` on both panes. Preserve by COPY; rename only after teardown has
finished.

## Normal closeout — teardown last

The driver reached `done` and settled its own seats. The order is literally
**preserve → commit → prove → suite → push+PR → teardown**. Teardown is last,
and it happens in the same turn as the push and PR: nothing is still writing
to the tree, so the commit is safe and the live workspace stays readable until
the PR exists.

## Recovery closeout — teardown first

The driver is gone but the seats may not be. Invert the order to
**preserve → teardown → commit → prove → suite → push+PR**: preserve by copy
as always, then tear down FIRST and commit after.

Run the ordered recovery sequence below — quiet-tree check, preserve-by-copy,
teardown-with-proof, verify, then either the closeout half or the adopt-ready
stop — with the command below. It refuses by name at the first failed step and
NEVER dispatches: the decision to run the next lane stays with the operator.

```sh
node scripts/factory/closeout.mjs recover <lane>
```

Two reasons, both structural:

- The scope gate protects a fresh run's dirty checkout, and **nothing protects
  the tree DURING a recovery**. A seat that is still alive keeps working while
  you read, stage and commit.
- The gate **adjudicates paths and not content**, so it cannot see an
  unexpected edit to a file that is legitimately in scope. Inside the fence is
  not the same as correct.

The hazard is measured, not hypothetical. On `b175-paneusage` a seat was still
alive during a hand recovery, kept working, and applied one of its own gate
kill-mutations to the working tree; it merged correctly by ORDERING LUCK
alone, because the mutation landed after the operator's commit rather than
before it. On `b196-dispatchexec` the driver exited with two seats still
running, and the teardown that followed reported `seats 4 proven 4` — that
tally is the evidence, not the archive rename that came with it.

### Prove the seats dead, do not assume it

```sh
node crew/crew.mjs teardown --task <slug> --checkout <dir>
```

Read the exit status and the JSON, in that order:

- Teardown **exits non-zero when a seat was not proven dead**:
  `crew/crew.mjs:2761` compares `proven` and `recorded` against `seats` and
  sets `process.exitCode = 1`.
- **Exit 0 is not proof on its own.** That guard reads
  `if (seats && …)`, so a `seats: null` payload — teardown measured NO seats,
  which `crew/crew.mjs:2652` records deliberately as an ABSENCE rather than a
  false zero — short-circuits it and takes the success path. Measured today on
  `b201-anchorrepair`: `exit=0` with
  `{"archived":"…","seats":null}`, proving nothing. This is the recovery
  closeout's own path, because a lane whose driver is gone is the one most
  likely to yield no pane rows. Treat `seats: null` as UNPROVEN and fall back
  to `pgrep -f <slug>` before you commit. Tracked as #601.
- Its JSON carries `{archived, seats:{seats, proven, failed, …}}`. `proven`
  must equal `seats`; `failed` counts seats measured still alive. A clean
  archive rename alone is not evidence.

Two operator traps, both measured today, both of which produced a confident
wrong reading:

- **`--checkout` is required in practice and optional to the parser.**
  `REQUIRED_FLAGS.teardown` is `['task']` alone, while `pathsFor` keys the
  state directory on the checkout's BASENAME and defaults to `process.cwd()`.
  Run teardown from the wrong directory and it derives a state directory that
  was never yours and errors, while appearing to have run. Always pass
  `--checkout <dir>`.
- **A shell exit status read after a pipeline reports the LAST command's
  status.** Piping teardown into `tail` reports `tail`'s success for a
  teardown that failed. Do not pipe it; or read `${pipestatus[1]}` (zsh) /
  `${PIPESTATUS[0]}` (bash). See `references/instruments.md`.

Only once `proven` equals `seats` do you commit, prove the mutations, run the
suite, and push.

## Archive naming

Teardown archives by renaming the state directory to
`${paths.dir}.archive-${iso}`, and `archived` in its JSON identifies the
archive path.

Only `.archive-` is recognised by status, wait, and the stale reaper:
`ARCHIVE_RE = /\.archive-\d{4}-\d{2}-\d{2}T/`. A hand rename to
`.escalated-…` is invisible to all three, so it hides the lane rather than
recording recovery state. Never hand-rename a live state directory as a
substitute for the real teardown.

## Publishing, and what to check after teardown

The lane branch is not a publishing surface. The rule lives in
`references/lane-branches.md` of the devops skill; do not restate it here. This
file owns recovery for having broken it: `git fetch origin refs/pull/<N>/head:<branch>`,
re-push, then `gh pr reopen`. Closing or
reopening someone else's PR is outward-facing, so ask first.

**diff every PR**'s `--name-only` file list **against the lane**'s declared
fence before opening it. A file outside the fence means the base is wrong, not
that the lane misbehaved; a suppressed `git rebase` failure was caught exactly
this way, one step before reverting a sibling's merged work.

A lane that reaches `done` tears itself down; the mechanism and its exhibit are
in the devops worktrees reference. This file owns the escalated half, which
keeps its workspace on purpose.

**immediately after teardown**, verify what was actually published: the
**merged blob** on the remote and the worktree state. A live seat can dirty the
tree after a commit (b175's builder applied a gate mutation post-push, which
only surfaced when the worktree refused removal). In the normal closeout
teardown stays last and the verification follows it; in the recovery closeout
teardown came first, so the verification is against a tree nothing can still
be writing to.

An accept-with-residuals is a close-out task, not a result: read the reviewer's
last findings and the diff before trusting the branch. Archived crew journals
under `~/.crew` are evidence, not junk — do not prune them.

## Rebase first, then re-anchor

A `path:line` citation is a claim about **one specific tree**. Repairing anchors
before a rebase calibrates them against a tree that will never exist on `main`,
and the error is invisible locally: the exhibits tests pass in the worktree and
fail the moment the lane merges.

Measured on `b187-jsonleaf`: restoring with `git checkout main -- skills/` pulled
a sibling's merged re-anchoring (#586, calibrated to a `scripts/factory/ledger.mjs`
of **4608** lines) into a worktree still based on a tree where that file was
**4600** — the exact +8. Re-anchoring after the rebase moved **5** anchors
instead of 10, and a different file set. Restore from `HEAD`, never from `main`.

Under **ADR-040**, an external shifted manifest — one this lane does not change —
is REPORTED in-lane and repaired `after the wave merges, on main` by:

    node skills/qa-test-writing/anchor-pin.mjs --repair-all <dir>

A plain `--repair` remains an optional in-lane capability for a lane that actually
changes the manifest. It relocates a pin whose content moved, and refuses rot
(content nowhere) and ambiguity (content on two lines) rather than guessing
(#582, #747).

**Verify against the COMMITTED tree.** `git show HEAD:<anchors.json>` against
`git show HEAD:<file>` needs no scratch checkout and cannot be fooled by a
clean-looking working tree, which is exactly what masks this.

A cited-file edit can shift anchors while every other signal stays green: the
acceptance gate and the edited file's own tests do not read pins, so a skill's
own `exhibits.test.mjs` is where a shift surfaces. `b187` paid this four times
in one lane: the build, a new pin, a comment, a file-level rule.
`anchor-pin.mjs` both detects and repairs.
The repair covers every pinned directory, `crew/roles` among them — the tech-lead
charter cites `crew/drive.mjs` by line and `crew/roles/anchors.json` pins what
each of those lines must contain. For an owned manifest, the optional in-lane
capability is:

    node skills/qa-test-writing/anchor-pin.mjs --repair crew/roles

Until planner.md's and reviewer.md's own citations are pinned too, that command also
prints three `manifest has no entry` refusals and exits 1. Those name the deferred
pins, not rot; read the `repaired` lines, and treat any OTHER refusal as real.
