---
description: Pick the next task from the configured source, plan it with the team, then stop for approval
---

Take the next task and **plan** it (don't execute yet). `$ARGUMENTS` may name a specific task (e.g. an issue number); if given, use that instead of auto-picking.

1. **Read config.** Read `<project-root>/.claude/dev-team/config.md`. If it's missing, tell the user to run `/dev-team:onboard` first, and stop.
   - **One task per window:** if this session already shipped (or substantially worked) a previous task, don't stack another onto the same transcript — tell the user to `/clear` and run `/dev-team:next` in the fresh window (config + memory carry everything; the accumulated transcript only adds re-read cost). Proceed anyway if they explicitly insist.
   - **Memory hygiene sweep (every run, not just the domain this task touches).** `orchestration.md`'s archive trigger only fires on a delta write, so a domain nobody's touched in a while never gets checked otherwise. `wc -l` every file in `<project-root>/.claude/dev-team/memory/` now — one cheap local command, not a subagent — and archive any live file over ~300 lines per the same rule (`deprecated` entries → `<file>.archive.md`; git-gated trim on the archive file itself if that crosses ~500). Silent when nothing trips the threshold — don't report a clean sweep, only an action taken.

2. **Select the task.**
   - If `$ARGUMENTS` names one → fetch its **full content** (`gh issue view $ARGUMENTS --repo <owner/repo> --json title,body,labels,comments`) and use it — an explicit ask bypasses the epic/status filters below; the user knows what they're pointing at.
   - **Epic/umbrella exclusion (every auto-pick, every source type).** Never auto-select an issue matching `config.task_source`'s confirmed epic pattern (default: title matches `^\s*\[?(epic|umbrella)\]?\s*:`, case-insensitive, or an `epic` label) — set at `/dev-team:onboard` time. These need decomposition into sub-tasks first; picking the umbrella itself as "the task" produces an unscoped, unshippable spec.
   - **GitHub issues source** → `gh issue list --repo <owner/repo> --label <ready-label> --state open --json number,title,labels --limit 100`, drop epic matches, take the lowest `number` (oldest). No `ready` label configured → same query without `--label`, still epic-filtered.
   - **GitHub Projects board source — run the stored query as a literal command, never improvise a substitute.** A plain `gh issue list` bypasses the board's `Status` field entirely and is exactly how an already-`In Progress` or already-`Done` issue gets picked by mistake.
     ```
     gh project item-list <project-number> --owner <owner> --format json --limit 500 \
       --query "status:<ready_status> is:issue is:open" \
     | jq -r --arg repo "<owner>/<repo>" '
         .items
         | map(select(.content.repository | endswith($repo)))
         | map(select((.title | test("^\\s*\\[?(epic|umbrella)\\]?\\s*:"; "i")) | not))
         | map(select(((.labels // []) | index("epic")) | not))
         | sort_by(.content.number)
         | (if length == 0 then "EMPTY" else "#\(.[0].content.number) \(.[0].title)" end)
       '
     ```
     Substitute `<project-number>`, `<owner>`, `<ready_status>`, and `<owner>/<repo>` from `config.task_source` — if the board scopes multiple repos, run once per configured repo and merge before picking oldest. `EMPTY` → report "no ready, non-epic items in *`<repo>`*" and stop. Once picked, fetch its full content with `gh issue view <number> --repo <owner/repo> --json title,body,labels,comments` (the project-item JSON itself is a summary, not the full issue body).
   - **Confirm the pick in one line** (`→ next: #550 — <title>; engage the team?`) and wait — unless activation mode is `auto`.
   - **Trello source** → `"${CLAUDE_PLUGIN_ROOT}/scripts/trello.sh" next-card <ready-list-id>` (top card = highest priority; never raw `curl`/`security` — the script keeps the token out of the transcript). `EMPTY` → report "no cards in *<ready list>*" and stop. Otherwise `trello.sh card <card-id>` for the full content (desc, checklists, comments), and record the pick as a `current_task:` line (card id + name + url) in `config.md` so `/dev-team:ship` can update the board later.

3. **Plan it through the team** (no edits, no coders yet):
   - **Resolve the task's source content up front.** Fold the fetched issue/card title, body/description, labels, checklists, and relevant comments into the shared digest handed to the leads — leads have no `gh`/`trello.sh` and their `WebFetch` can't read a private repo or board, so they must receive the resolved content, never a bare issue number/card id/URL.
   - Classify the tier (orchestration Tier rule).
   - Run **shared discovery once** across the involved domains (scout / `Explore` → one digest). For Tier 3, have `dev-team:architecture-lead` draft the artifact-routed architecture package — PRD-lite/TRD/ADR only as needed, plus execution plan (→ `dev-team:plan-reviewer`).
   - Have each relevant lead produce a **Handover Spec** from the shared digest — self-checked against `handover-spec.md`, `interface_contract` filled for shared shapes, `depends_on` set.
   - **Lint each spec before presenting it** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/spec-lint.mjs" --root <project-root> <spec.json>` (mechanical checks: paths exist, `file:line` refs resolve, commands are runnable). Exit 1 → bounce to the lead and re-lint before continuing (orchestration.md § Handover Spec).
   - Use `config.validate` for the specs' `validation_commands` and `config.review_defaults` to set review depth.

4. **Present the plan for approval** — the architecture package/specs + the dispatch shape (which coders, parallel vs sequenced) + the gate plan. **Stop here.** On approval, continue to coders → QA gate → commit reconciled memory deltas (or the user runs execution separately). Don't move from Tier-3 design into implementation without explicit approval, unless activation mode is `auto` and the request is not high-risk (orchestration.md § Tier-3 architecture package).

**Task:** $ARGUMENTS
