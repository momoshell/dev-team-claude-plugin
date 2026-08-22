# Worktree hygiene

Give each lane a real checkout so its branch, dirty state, and scope are
independent. From a clean repository, create the lane worktree before boot:

```sh
git worktree add -b crew/<slug> ../<slug> main
cd ../<slug>
```

The runtime's scope gate treats `git status` as ground truth. Before
`crew.mjs run`, `git status --porcelain` must be empty; otherwise the refusal
is exactly:

> `checkout is dirty — commit or stash before a crew run:`

## The symlinked `node_modules` trap

`.gitignore` contains `node_modules/`, but that trailing-slash pattern ignores
a real directory and does **not** ignore a symlink. Measure both arms in a
scratch repository, not by assumption:

```sh
# symlink arm
ln -s /path/to/real/node_modules node_modules
git check-ignore node_modules; echo "check-ignore exit=$?"  # exit 1
git status --porcelain                                      # ?? node_modules

# real-directory arm (after removing the symlink)
rm node_modules
mkdir node_modules
git check-ignore node_modules; echo "check-ignore exit=$?"  # exit 0
git status --porcelain                                      # no node_modules row
```

A symlink therefore trips the dirty-checkout refusal before any seat is
assigned. If it gets as far as a scope check, `changedFiles()` reads
`git status --porcelain -uall -z`, so `node_modules` is an out-of-scope changed
file even when the target behind the link is ignored. Use a real ignored
directory or repair the checkout; never stash an accidental symlink as if it
were a clean dependency tree.

## Before the PR

Bring the lane branch up to date and replay the built commit before publishing:

```sh
git fetch origin main
git rebase origin/main
```

Run the lane's gate and suite again after the rebase, then push and open the PR.
Never delete the lane branch while its PR is open; the branch remains the
review and recovery handle until the PR is merged or explicitly closed.
