# Evidence register

This register separates local exhibits from operator measurements and negative
repository searches.

## Rules with no exhibit

### `--body-file` absolute-path and remote-list rules

The pre-skill whole-tree search for `body-file`, `body_file`, and `bodyFile`
found zero hits.

It also found no `gh pr create` or `gh issue create` implementation and no
remote-list verification path.

The absolute-path and remote-confirmation requirements are therefore operator-
session measurements, not local implementation exhibits.

The nearby `gh` calls are read-only queries or seam examples.
Exhibit: `scripts/factory/intake.mjs:533-535`.

The `gh issue list` procedure in `gh.md` is prescribed for a real remote check,
but this checkout does not measure it; local body-file existence is insufficient.

Keep the rule marked unbacked while retaining its operational cost: a compound
`cd` changed relative paths in two measured failures.

### `git push origin --delete` and open PRs

A whole-tree search found no branch-deletion implementation or note.

The adjacent `deleteBranchOnMerge` token is a probed repository setting only.
Exhibit: `scripts/factory/probe-repo.mjs:799`.

GitHub's behavior that deleting an open lane branch can close its PR is not
measured by a source or test in this checkout.

The related safeguards are also unbacked: preserving the open review, refusing
to trust a green local test or absent PR lookup, and handling an interrupted
network request without a deletion verdict.

The same search found no branch-publication implementation reachable from a
production entry point, so the worker-path refusal, the crew-root worker path,
the missing-checkout and unresolved-branch refusals, the gate's ordering ahead of
branch resolution, and the empty-branch-name rule in `lane-branches.md` are all
unbacked here too.

Ship the warning as unbacked, not as a local fact.

### Unknown linked-worktree probe and removal

A whole-tree search found no linked-worktree probe reachable from a production
entry point, so the probe rule in `worktrees.md` has no local exhibit.

No local removal implementation ties a failed probe to teardown either.

Keep the fail-closed removal rule in `worktrees.md` marked unbacked until a
measured fixture covers this probe outcome.

### Reclaim kill-error edge

No dedicated local mutation test isolates an interrupted or EPERM kill after a
reclaim decision is made.

The pid and pgid guard itself is backed by `scripts/factory/reap-stale.mjs:58-60`,
but the kill-error accounting rule remains unbacked.

Keep that edge marked unbacked in `processes.md` until a measured fixture pins it.

### launchd

A case-insensitive search for `launchd`, `launchctl`, `LaunchAgents`, and plist
names found no service definition here.

The only hit is an incidental ancestry line in a retired task note.
Exhibit: `tasks/cmux-mode/spike-findings.md:58`.

The daemon has no plist, label, or launchd-managed start recipe in this repo.

The negative fact belongs in `daemon.md`; it does not supply a launchd exhibit.

An absent search result is not proof about another machine's user services.

Keep host-specific launchd instructions outside this shipped skill unless a
repo-local artifact is added and measured.

Unknown, empty, or interrupted searches stay indeterminate until rerun.

This register records what was searched, what was found, and the boundary of
the claim.
