---
description: Review a pull request through the measured PR-review lane.
argument-hint: <positive decimal integer> [--request-changes] [--no-post] [--panel] [--panel-distinct-agents]
---

Use `/review` when you need the existing PR-review workflow to inspect a pull request.

Load the `pr-review` skill (`skills/pr-review/SKILL.md`) and follow it for the review above. This command only names the procedure and passes the argument through.

Usage:
- Literal: `npm run crew:review -- --pr <positive decimal integer> [--request-changes] [--no-post] [--panel] [--panel-distinct-agents]`
- Local: `npm run crew:review -- --local [--repo <path>] [--base <ref>] [--model-reviewer <provider/model>] [--artifact-dir <path>] [--no-post] [--panel] [--panel-distinct-agents]`
- Executable: `npm run crew:review -- --pr $ARGUMENTS`

The lane never posts APPROVE; it posts only COMMENT or REQUEST_CHANGES when posting is enabled. `--no-post` renders without touching GitHub for publication.

## Local mode

`--local` reviews the committed HEAD of a repository (cwd by default, or `--repo <path>`) instead of a pull request. `--base <ref>` pins the base ref; otherwise the first resolvable of `origin/HEAD`, `origin/main`, `main` is used. The worktree must be clean or the lane refuses `dirty-worktree` before creating anything. `--request-changes` is posting-only and is refused with `--local`; `--no-post` is harmless there. `--model-reviewer <provider/model>` overrides only the reviewer seat at boot. `--artifact-dir <path>` writes `<head>.md` (the rendered review body) before `<head>.json` (the twelve-key artifact: `repo`, `branch`, `head`, `base`, `merge_base`, `dirty`, `verdict`, `verdict_reason`, `model`, `rules_ref`, `rules_commit`, `created_at`), written atomically via tmp plus rename; a no-findings review maps to `pass`, findings to `changes`, and any failure after HEAD is measured maps to `unmeasured` with the closed refusal reason. Fields that were never measured stay `null`, never a guess: `base` is `null` when the base ref never resolved (as is `merge_base` when the merge-base never resolved), and `dirty` comes from the same Git status probe (`null` when that probe is itself unobservable).

## Panel mode

`--panel` boots reviewer, tech-lead and lead under `review_panel` and posts the fused findings with each finding's `raised_by` and `panel_disposition`. Dismissed findings are shown with the adjudicator's reason, never omitted. The idempotency digest covers the panel provenance, so a provenance-only change moves the marker.

`--panel-distinct-agents` refuses `panel-same-agent` when reviewer and tech-lead resolve to the same agent; without the flag both resolved agents are recorded on the seats.

## Refusals

- `malformed-pr` — the arguments do not name exactly one of a positive decimal PR or `--local`, or carry an unknown option, a duplicate, an option missing its value, a local-only option without `--local`, `--request-changes` with `--local`, or a blank `--model-reviewer` / `--artifact-dir` value.
- `unknown-pr` — GitHub cannot resolve the pull-request metadata. It is also the catch-all for an unexpected crash, so this refusal alone does not prove GitHub was at fault.
- `invalid-review-sha` — the PR head or computed review base is not a valid lowercase 40- or 64-character SHA.
- `worktree-add-failed` — the temporary review worktree cannot be created for the resolved PR head.
- `worktree-remove-failed` — cleanup cannot prove that the temporary worktree directory and Git registration are gone.
- `git-diff-failed` — Git cannot read the PR diff or list its changed files.
- `review-input-unreadable` — the review skill, rubric, or generated review brief cannot be read or written.
- `crew-failed` — the crew boot or review run does not complete successfully.
- `terminal-unreadable` — the crew run has no valid terminal result with a task-return pointer.
- `task-return-unreadable` — the task-return pointer cannot be read.
- `task-return-invalid` — the task return is not an accepted review envelope.
- `teardown-failed` — crew teardown does not complete successfully after the review.
- `head-moved` — the PR head SHA differs during the post safety re-check.
- `post-failed` — the post-stage re-check or review submission does not complete. It is also raised under `--no-post`, where nothing is sent to GitHub, so seeing it does not mean a post was attempted.
- `dirty-worktree` — the local worktree has uncommitted changes or untracked files, or Git status cannot prove it clean; refused before any worktree is created.
- `local-base-unresolved` — no local base ref resolves, or the merge-base cannot be computed for the local HEAD.
- `artifact-write-failed` — the review artifact directory, markdown, or atomic JSON write does not complete.
