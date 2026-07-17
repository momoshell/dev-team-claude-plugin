---
description: Work a GitHub PR like a teammate — review others' PRs with inline comments, or triage feedback + fix + respond on your own
---

Work a PR the way a good colleague would. `$ARGUMENTS` = PR number or URL (required), optionally followed by an explicit mode override (`review` / `respond`).

**Nothing is ever posted to GitHub without showing the user the exact drafted text first and getting a yes. Both modes. No exceptions — this is outward-facing writing under the user's name.**

1. **Resolve the PR and pick the mode.**
   - Parse repo + number from `$ARGUMENTS` (a bare number uses the current repo). `gh pr view <n> --repo <owner/repo> --json author,title,body,headRefOid,state,url,files`.
   - `gh api user --jq .login` → compare against the PR author: **someone else's PR → review mode; the user's own PR → respond mode.** An explicit override in `$ARGUMENTS` wins (e.g. re-reviewing your own PR before requesting review is legitimate).
   - Closed/merged PR → say so and confirm there's still a point before proceeding.

2. **Review mode — someone else's PR.**
   - **Gather like a human reviewer reads:** the PR title/body + linked issue (resolve it — orchestration.md § external content), `gh pr diff <n>`, and for any non-obvious hunk the surrounding file content from the head ref (`gh api repos/<o>/<r>/contents/<path>?ref=<headRefOid>` or a local checkout if the repo is the cwd). A diff hunk without its surroundings produces the classic bad review: confidently wrong about code that's fine three lines out of frame.
   - **Size the review with the team's own ladder** (orchestration.md § QA gate): classify the diff's risk — deep triggers (auth/authz, secrets, migrations, infra, public contracts, payments/PII) or `config.review_defaults` paths (if this repo is onboarded) → dispatch `dev-team:code-reviewer-deep`; stacked risk → the 3-lens adversarial panel; otherwise a single `dev-team:code-reviewer`. Hand reviewers the PR intent + full diff + the surrounding context you fetched — they have no `gh` and can't read a private repo.
   - **Verify before you draft — a wrong review comment costs the author real time and you real credibility.** For every finding: re-check the claim against the actual head-ref code (not just the reviewer's assertion), confirm the `path` + line exists on the diff's **RIGHT side** (you can only anchor inline comments to changed lines), and drop anything speculative that you can't ground in a concrete line. Fewer, correct comments beat coverage.
   - **Draft ONE review, not comment spam:** a short summary body (what the PR does well + overall verdict) plus the inline comments. Tone and shape of each comment:
     - Polite and inquisitive, like a peer thinking out loud — where it fits, open with "What do you think about…", "Would it be worth…", "Is it true that…", "Is it correct that…". A question invites the author in; a verdict shuts them out. Don't force it on every comment — a plain "This throws on empty input: …" is fine when the finding is factual.
     - **Precise explanation, concise fix, 2–4 sentences total.** Name the failing input/state, point at the line, suggest the fix in one clause or a short ```suggestion``` block. No essays.
     - Tag severity so the author can triage: `[blocking]` (must fix before merge), `[question]` (needs an answer, may be fine), `[nit]` (take it or leave it).
     - Skip anything a linter/formatter already enforces; collapse a repeated pattern into one comment ("same applies in X and Y") instead of N copies.
   - **Show the user the complete draft** — summary + every inline comment with its path:line — and wait for a yes (they may edit or drop comments).
   - **Post as a single review** via `gh api repos/<o>/<r>/pulls/<n>/reviews --input <payload.json>` with `{"commit_id": "<headRefOid>", "event": "COMMENT", "body": "<summary>", "comments": [{"path", "line", "side": "RIGHT", "body"}, …]}` (multi-line comments add `start_line`/`start_side`). One atomic review = one notification for the author, threads they can resolve. Don't submit `REQUEST_CHANGES`/`APPROVE` unless the user explicitly asks — verdict authority is theirs.

3. **Respond mode — the user's own PR.**
   - **Fetch the unresolved feedback:** GraphQL is the only API that knows thread resolution — `gh api graphql` on `pullRequest(number:) { reviewThreads(first:100) { nodes { isResolved path line comments(first:20) { nodes { id databaseId author{login} body } } } } }`, keep `isResolved: false` threads only; plus top-level review bodies from `gh pr view <n> --json reviews`. Skip bot/CI noise unless it flags something real.
   - **Triage every comment on evidence, not deference.** Read the actual code the comment points at. Verdict each: **valid** (the reviewer is right), **invalid** (they misread — you can show why), or **unclear** (genuinely ambiguous → needs a clarifying question, not a guess). A reviewer being confident doesn't make them correct; a fix applied to satisfy a wrong comment is a real bug added to please a ghost.
   - **Fix the valid ones** at the right weight (orchestration Tier rule): trivial → edit directly; substantial → spec → `dev-team:coder`, scoped validation from `config.validate.fast`. **One commit per logical fix** — its hash is about to be cited in a reply, so a grab-bag commit makes every reply point at noise. Capture each short hash.
   - **Draft the replies, one per thread:**
     - Fixed → `Good catch — fixed in <short-hash>. <One line: what changed.>`
     - Invalid → polite pushback with evidence, in the same inquisitive register: `I think this one's safe as-is — <file:line> guards the nil case before this call. What do you think?` Never "wontfix" energy.
     - Unclear → the clarifying question itself.
   - **Show the user everything before anything leaves the machine:** the triage table (comment → verdict → action), the fix commits, and every drafted reply verbatim. Wait for a yes; apply their edits.
   - **Then, in order:** push the fix commits (`git push` — the cited hashes must exist on the remote before a reply references them), then post each reply to its thread via `gh api repos/<o>/<r>/pulls/<n>/comments/<databaseId>/replies -f body=…`. Don't resolve threads — the reviewer resolves what satisfied them.

4. **Report.** Review mode: the review URL + finding count by severity. Respond mode: threads fixed / pushed back / asked, commits pushed. Either mode: anything you chose not to raise/answer and why, in one line.

**Input:** $ARGUMENTS
