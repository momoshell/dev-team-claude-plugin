---
description: Review a pull request or the local branch against the pr-review rubric.
argument-hint: <pull request number> | --local [--base <ref>]
---

Use `/review 123` to review a pull request, or `/review --local` to review the current branch against its base.

Load the `pr-review` skill (`skills/pr-review/SKILL.md`) and follow the review procedure in `.agents/skills/review-procedure/SKILL.md` for the review named by $ARGUMENTS. This command only names the procedure and passes the argument through.

What is under review:
- A pull request: `gh pr diff <number>`, with every file read at the PR head (`gh pr view <number> --json headRefOid,baseRefOid`, then `git fetch origin pull/<number>/head <base>`, which also works for a fork, and `git show <head>:<path>`; a file the PR deletes is read at its base, `git show <base>:<path>`), never from the local checkout.
- `--local`: the base is `--base <ref>`, else the first of `origin/main` and `main` that resolves; if none resolves, stop and ask for `--base`. Find the merge base with `git merge-base <base> HEAD`; if it prints no commit, stop and say the base is unrelated. Review `git diff <merge base>`, which includes staged and unstaged edits, and every untracked file `git status --short --untracked-files=all` lists. Say in the report which of these were present.

Read each changed file in full, not only its hunks. Report the findings in the conversation. Post to GitHub only when the operator asks, and never post an approval.
