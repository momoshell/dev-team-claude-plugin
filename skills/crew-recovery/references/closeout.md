# Closeout

The closeout order is literally **preserve → commit → prove → suite → push+PR → teardown**. Teardown is last, and it happens in the same turn as the push and PR; an escalated run never auto-tears-down because its live workspace is the escalation context.

## Preserve first

Copy the live state directory before inspecting, repairing, or renaming it:

```sh
cp -a <state-dir> <state-dir>.recovery-copy
```

Do not rename a live state directory as a shortcut for preserving it. Each
seat's launch command contains an **absolute** `task/role-<seat>.md` system
prompt path, written and read back at boot. The b150-permprobe lane proved the
failure mode: after a live rename, relaunch reported `Append system prompt file not found` on both panes. Preserve by COPY; rename only after teardown has
finished.

## Teardown last

Run the actual command only after the built tree is committed, mutation proof
and suite are green, and the PR is pushed/opened:

```sh
node crew/crew.mjs teardown --task <slug> --checkout <dir>
```

Teardown archives by renaming the state directory to
`${paths.dir}.archive-${iso}`. Its JSON output includes
`{archived, seats:{seats, proven, failed, …}}`: `archived` identifies the
archive path, while the seat counts say which processes were proven dead. The
command exits 1 when a seat was not proven dead; do not report a clean teardown
from the archive rename alone.

Only `.archive-` is recognised by status, wait, and the stale reaper:
`ARCHIVE_RE = /\.archive-\d{4}-\d{2}-\d{2}T/`. A hand rename to
`.escalated-…` is invisible to all three, so it hides the lane rather than
recording recovery state. Leave escalated work under its live name until the
operator is ready for the real teardown.

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
only surfaced when the worktree refused removal). Teardown stays last; the
verification follows it.

An accept-with-residuals is a close-out task, not a result: read the reviewer's
last findings and the diff before trusting the branch. Archived crew journals
under `~/.crew` are evidence, not junk — do not prune them.
