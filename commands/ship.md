---
description: Ship the current work — run the QA gate, then branch, commit, push, and open a PR
---

Ship the work currently in progress. `$ARGUMENTS` may give a PR title / issue ref. **Refuse to ship if the gate doesn't pass.** Invoking this command is itself the go-ahead to push and open the PR once the gate is green — don't stop to ask again before step 4; the QA gate (must-fix findings, failing `validate` commands) is the actual checkpoint, not a second confirmation after it's already passed.

1. **Scope the change.** `git status` + `git diff --stat` (and the diff) to see what changed. If nothing changed, say so and stop. Read `.claude/dev-team/config.md` for `validate` commands and `review_defaults`.

2. **Run the QA gate** (the `dev-team:qa-lead` ladder), spec-anchored if a spec/acceptance exists:
   - Run **`config.validate.full`** (the complete suite — full tests + integration/e2e + build) — these must pass. **This is the single place the full slow suite runs** — coders and the mid-execution inline re-verify only ran the scoped `fast` lane, so ship is where the authoritative run happens, exactly once before the PR. (If `config.validate` isn't split into `fast`/`full` — an older config — run all of it; re-run `/dev-team:onboard` to add the split.)
   - Review the diff at the right tier (standard → deep per the deep-trigger ladder + `config.review_defaults`); add `dev-team:build-validator` / `dev-team:test-engineer` as warranted.
   - On any **must-fix** finding or failing command → **stop and report**. Do not ship.

3. **Reconcile memory deltas** the leads/reviewers proposed (you are the sole writer) — write them to the project memory files now, **before** committing. Apply the size triggers from `${CLAUDE_PLUGIN_ROOT}/references/memory.md` as part of this write: `wc -l` each touched live file (archive at ~300 lines) and each touched `*.archive.md` (git-gated trim at ~500 lines). This has to happen before step 4's commit — a memory delta that lands in git only stays permanently un-collectible, since the archive-GC rule requires at least one prior commit to trust a trim as recoverable.

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

6. **Log task cost** (best-effort, non-fatal):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/task-cost-log.mjs" --tier <1|2|3> --gate-depth <none|standard|deep|panel> --task <id>
   ```
   `tier`, `gate_depth` and `task` are **self-reported and unaudited** — this call records your own read of the session, it doesn't verify it against anything. This is non-fatal: an exit 2 here (e.g. `session_id_unavailable`) is reported in the final Report step and never un-ships the PR. If it exits 2 with `session_id_unavailable`, re-run once with an explicit session id: `--session-id $(printenv CLAUDE_CODE_SESSION_ID)`.

7. **Tear down the cmux session** (only when `execution_mode: cmux` is set in `.claude/dev-team/config.md`; **skip this step entirely** when `execution_mode` is `agent-tool` or absent). Runs after step 4's PR and step 3's memory commit, so the durable record is already in git before anything is deleted, and after step 5 so the board is already synced:
   - **Refusal clause:** if the `--task <slug>` used for this task's workspace/dispatch calls earlier in this run isn't known, **never guess a slug** — skip teardown and report that it was skipped.
   - Otherwise invoke the existing teardown verb:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/cmux/dispatch.mjs" teardown --task <task-slug> [--keep-artifacts]
     ```
     Pass `--keep-artifacts` iff config has `keep_task_artifacts: true`. For the full teardown order (surface/workspace close sequence, verification pass), see `references/cmux-dispatch.md` — don't restate the cmux verbs here.
   - **Archival:** regardless of `keep_task_artifacts`, a task with any non-zero/non-ok dispatch is always archived (never deleted) — its logs are the trail worth keeping. Archived tasks land at `<task-artifacts-root>/tasks/.archive/<task-slug>-<date>/` (default root `~/.dev-team`; never `.claude/...`).
   - **Worktrees:** removed only when clean **and** merged — never `--force`. Leftovers are kept and reported as `leftover_worktrees`.
   - Non-fatal: a teardown failure never un-ships the PR — report it and continue.

8. **Report** the branch, the PR URL, the gate verdict, any task-source update, the task-cost logging outcome (including any `session_id_unavailable` remediation taken), and (if teardown ran) its outcome including any `leftover_worktrees`. End the report by recommending **`/clear` before the next task** — the transcript's job is done (memory, config, and the board carry everything forward), and a fresh window keeps per-turn cost flat instead of compounding.

**Input:** $ARGUMENTS
