---
description: Ship the current work — run the QA gate, then branch, commit, push, and open a PR
---

Ship the work currently in progress. `$ARGUMENTS` may give a PR title / issue ref. **Refuse to ship if the gate doesn't pass.**

1. **Scope the change.** `git status` + `git diff --stat` (and the diff) to see what changed. If nothing changed, say so and stop. Read `.claude/dev-team/config.md` for `validate` commands and `review_defaults`.

2. **Run the QA gate** (the `dev-team:qa-lead` ladder), spec-anchored if a spec/acceptance exists:
   - Run `config.validate` (typecheck / test / lint / build) — these must pass.
   - Review the diff at the right tier (standard → deep per the deep-trigger ladder + `config.review_defaults`); add `dev-team:build-validator` / `dev-team:test-engineer` as warranted.
   - On any **must-fix** finding or failing command → **stop and report**. Do not ship.

3. **Branch, commit, PR** (only after green):
   - **Never commit to the default branch.** If on `main` / `master` / `develop`, create a feature branch first (`git switch -c <type>/<slug>`).
   - Stage + commit with a clear message (what + why).
   - `git push -u origin HEAD`.
   - `gh pr create` — title from `$ARGUMENTS` or derived; body summarizing the change, validation results, reviewer notes / follow-ups; link the task (`Closes #N`) if known.

4. **Commit reconciled memory deltas** the leads/reviewers proposed (you are the sole writer).

5. **Report** the branch, the PR URL, and the gate verdict.

**Confirm before pushing / opening the PR** unless activation mode is `auto`.

**Input:** $ARGUMENTS
