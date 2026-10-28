---
name: devops
description: >-
  Load when working the git and GitHub side of a lean crew lane: lane worktrees, pushing
  the lane branch, opening and checking pull requests with gh, and updating the
  crew install with crew update.
---

# Devops

## Worktrees

- `crew start` creates the lane worktree `dt-<lane>` beside the checkout, on a
  new branch named for the lane (`crew/start.mjs`).
- `git worktree list` shows every worktree; a lane worktree with no lane in
  `crew lanes --all` is an orphan to look at, not to delete blindly.
- A merged lane's worktree is removed by `crew closeout <lane>`. By hand use
  `git worktree remove <path>`, never `--force`: git refuses a dirty worktree,
  and that refusal protects uncommitted work.

## Pull requests

- Push the lane branch: `git push -u origin <lane>`.
- Write the body to a file and open with an absolute path:
  `gh pr create --head <lane> --title <title> --body-file <absolute-path>`.
- Confirm with `gh pr view <number> --json state,headRefOid,mergeStateStatus` and
  `gh pr checks <number>`. The head must be the lane branch tip.
- Never merge for the operator. Report the state and stop.

## The crew install

- `crew where` prints the crew home, its branch and its commit.
- `crew update [--force]` fast-forwards the crew home to `origin/main` and
  rebuilds what changed (`bin/crew.mjs`). It refuses unless the home is on
  `stable` with no local changes, and refuses while processes run from the home
  unless `--force`; with `--force`, restart those processes afterwards.
