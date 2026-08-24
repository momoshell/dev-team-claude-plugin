# Worktree lifecycle

Create a lane through Git's worktree registry, never by copying a directory.
Exhibit: `crew/arms.mjs:661`.

Refuse an existing target before asking Git to create it.
Exhibit: `crew/arms.mjs:650`.

The creation command is `git worktree add -b` with an explicit branch and path.
Exhibit: `crew/arms.mjs:661`.

A linked worktree's `.git` is a file, not a directory.
Exhibit: `scripts/pr-review-window.sh:61-62`.

A directory-only `.git` search therefore finds primary checkouts only.
Exhibit: `scripts/pr-review-window.sh:61-62`.

Probe linked status by comparing `--git-dir` with `--git-common-dir`.
Exhibit: `scripts/factory/ci-watch.mjs:240`.

Different values identify a linked checkout in the worker-path probe.
Exhibit: `scripts/factory/ci-watch.mjs:240`.

The common Git directory is shared by linked lanes.
Exhibit: `crew/seat-io.mjs:1934`.

Stash entries are consequently not isolated per worktree (#471).
Exhibit: `crew/seat-io.mjs:1934`.

Use `git worktree remove` for teardown so Git unregisters the worktree.
Exhibit: `skills/qa-test-writing/references/tooling.md:65-66`.

The sibling reference owns scratch-worktree mechanics; this file owns the
lifecycle consequences for a live lane.

Do not reproduce the node_modules symlink recipe here.
Exhibit/pointer: `skills/qa-test-writing/references/tooling.md:13-16` for that trap.

This skill adds only the removal and registration half of that shared concern.

A completed run may auto-teardown its workspace.
Exhibit: `crew/crew.mjs:1881`.

An escalated run retains its workspace as human-readable context.
Exhibit: `crew/crew.mjs:1881`.

An unknown Git probe is not permission to remove a checkout.
Status: this fail-closed removal rule is unbacked here; see `evidence.md`.

An interrupted `git worktree add` needs its partial result inspected before
another creation attempt.
Exhibit: `crew/arms.mjs:661`.

The cost of `rm -rf` alone is a leaked registration and later false occupancy.
Exhibit: `skills/qa-test-writing/references/tooling.md:65-66`.
