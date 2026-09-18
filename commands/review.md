---
description: Review a pull request through the measured PR-review lane.
argument-hint: <positive decimal integer> [--request-changes] [--no-post] [--panel] [--panel-distinct-agents]
---

Use `/review` when you need the existing PR-review workflow to inspect a pull request.

Load the `pr-review` skill (`skills/pr-review/SKILL.md`) and follow it for the review above. This command only names the procedure and passes the argument through.

Usage:
- Literal: `npm run crew:review -- --pr <positive decimal integer> [--request-changes] [--no-post] [--panel] [--panel-distinct-agents]`
- Executable: `npm run crew:review -- --pr $ARGUMENTS`

The lane never posts APPROVE; it posts only COMMENT or REQUEST_CHANGES when posting is enabled. `--no-post` renders without touching GitHub for publication.

## Panel mode

`--panel` boots reviewer, tech-lead and lead under `review_panel` and posts the fused findings with each finding's `raised_by` and `panel_disposition`. Dismissed findings are shown with the adjudicator's reason, never omitted. The idempotency digest covers the panel provenance, so a provenance-only change moves the marker.

`--panel-distinct-agents` refuses `panel-same-agent` when reviewer and tech-lead resolve to the same agent; without the flag both resolved agents are recorded on the seats.

## Refusals

- `malformed-pr` — the arguments do not name a positive decimal PR, or carry an unknown option, a duplicate, or an option missing its value.
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
