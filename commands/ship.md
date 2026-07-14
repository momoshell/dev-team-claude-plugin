---
description: Ship the current work — run the QA gate, then branch, commit, push, and open a PR
---

Ship the work currently in progress. `$ARGUMENTS` may give a PR title / issue ref. **Refuse to ship if the gate doesn't pass.** Invoking this command is itself the go-ahead to push and open the PR once the gate is green — don't stop to ask again before step 4; the QA gate (must-fix findings, failing `validate` commands) is the actual checkpoint, not a second confirmation after it's already passed.

1. **Scope the change.** `git status` + `git diff --stat` (and the diff) to see what changed. If nothing changed, say so and stop. Read `.claude/dev-team/config.md` for `validate` commands and `review_defaults`.

2. **Run the QA gate** (the `dev-team:qa-lead` ladder), spec-anchored if a spec/acceptance exists:
   - Run `config.validate` (typecheck / test / lint / build) — these must pass.
   - Review the diff at the right tier (standard → deep per the deep-trigger ladder + `config.review_defaults`); add `dev-team:build-validator` / `dev-team:test-engineer` as warranted.
   - On any **must-fix** finding or failing command → **stop and report**. Do not ship.

3. **Reconcile memory deltas** the leads/reviewers proposed (you are the sole writer) — write them to the project memory files now, **before** committing. Apply `orchestration.md` § Memory's size triggers as part of this write: `wc -l` each touched live file (archive at ~300 lines) and each touched `*.archive.md` (git-gated trim at ~500 lines). This has to happen before step 4's commit — a memory delta that lands in git only stays permanently un-collectible, since the archive-GC rule requires at least one prior commit to trust a trim as recoverable.

4. **Branch, commit, PR** (only after green):
   - **Never commit to the default branch.** If on `main` / `master` / `develop`, create a feature branch first (`git switch -c <type>/<slug>`) — this carries any uncommitted work onto the new branch untouched, so it's safe even mid-change.
   - Stage + commit the code change with a clear message (what + why). Stage + commit the memory-dir changes from step 3 as their own small commit on the same branch (e.g. `chore: reconcile dev-team memory deltas`) — keep it separate from the code commit so `git log -- <memory-file>` stays a clean per-file history for the archive-GC check.
   - **Sync with upstream before pushing.** `git fetch origin`, then compare the feature branch's base against `origin/<default-branch>`. If the branch was just cut from a local `main` that was behind origin (or `origin/<default-branch>` has moved since), `git rebase origin/<default-branch>` now — before the first push, while the branch is still just your own local commits — so the PR opens against current upstream instead of a stale base. Resolve any conflicts; if a rebase looks nontrivial, stop and report instead of forcing it. Skip this on an already-existing feature branch that's been pushed before (rebasing published history needs the user's call, not an automatic one).
   - `git push -u origin HEAD`.
   - `gh pr create` — title from `$ARGUMENTS` or derived; body summarizing the change, validation results, reviewer notes / follow-ups; link the task (`Closes #N`) if known.

5. **Update the task source** (after the PR exists):
   - GitHub issues (no Projects board) → the `Closes #N` in the PR body already handles it.
   - GitHub Projects board (config has `project_node_id`/`status_field_id`/`status_options` and a `current_task:` line with the item node id from `next.md`) → move it to `done_status`, same call shape as the in-progress move `next.md` made:
     ```
     gh project item-edit --id <item-node-id> --project-id <project_node_id> --field-id <status_field_id> --single-select-option-id <status_options.done>
     ```
     `Closes #N` still closes the issue itself — this additionally syncs the board's `Status` field, which closing alone doesn't touch. Clear the `current_task:` line from `config.md` after. Non-fatal: if it fails, report it and continue — the PR is the source of truth.
   - Trello (config has a `current_task:` card) → `"${CLAUDE_PLUGIN_ROOT}/scripts/trello.sh" comment <card-id> "<PR URL>"` then `trello.sh move <card-id> <done-list-id>`, and clear the `current_task:` line from `config.md`. Non-fatal: if the board update fails, report it and continue — the PR is the source of truth.

6. **Report** the branch, the PR URL, the gate verdict, and any task-source update. End the report by recommending **`/clear` before the next task** — the transcript's job is done (memory, config, and the board carry everything forward), and a fresh window keeps per-turn cost flat instead of compounding.

**Input:** $ARGUMENTS
