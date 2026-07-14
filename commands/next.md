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
         | (if length == 0 then "EMPTY" else "\(.[0].id)\t#\(.[0].content.number)\t\(.[0].title)" end)
       '
     ```
     Substitute `<project-number>`, `<owner>`, `<ready_status>`, and `<owner>/<repo>` from `config.task_source` — if the board scopes multiple repos, run once per configured repo and merge before picking oldest. `EMPTY` → report "no ready, non-epic items in *`<repo>`*" and stop. Output is tab-separated `<item-node-id>\t#<number>\t<title>` — the first field (`PVTI_...`) is the *project item's* node id, distinct from the issue number; keep it, it's needed in step 4 to move the item's `Status` and in `ship.md` to move it again on completion. Once picked, fetch its full content with `gh issue view <number> --repo <owner/repo> --json title,body,labels,comments` (the project-item JSON itself is a summary, not the full issue body). Record `current_task: #<number> (item: <item-node-id>)` in `config.md`, mirroring the Trello pattern below, so `ship.md` doesn't need to re-look-up the item id.
   - **Confirm the pick in one line** (`→ next: #550 — <title>; engage the team?`) — but first check for an epic-momentum note (GitHub sources only, skip for Trello). The pick above is pure "lowest ready number" — it has no notion of "this issue continues an epic already in flight," so an old unrelated backlog item can beat a sub-issue of a hot epic (this is exactly what happened picking an old standalone issue over a live epic's next sub-issue). List open epics: `gh issue list --repo <owner>/<repo> --state open --json number,title | jq -r '.[] | select(.title | test("^\\s*\\[?(epic|umbrella)\\]?\\s*:"; "i")) | .number'`. For each, check its sub-issues: `gh api graphql -f query='{ repository(owner: "<owner>", name: "<repo>") { issue(number: <epic-number>) { subIssues(first: 50) { nodes { number state } } } } }'` — an empty/missing `subIssues` field means this repo doesn't use GitHub's native sub-issue feature; skip silently, don't fall back to scanning issue bodies for `#<n>` references. If any `OPEN` sub-issue number sits in the same ready pool as the pick but isn't the pick itself, fold it into the confirmation line, e.g. `→ next: #736 — <title>; note: epic #1044 also has ready sub-issue(s) #1054, #1055 — say the word to switch; engage the team?`. This only ever adds a note — it never reorders the pick automatically. Then wait, unless activation mode is `auto`.
   - **Trello source** → `"${CLAUDE_PLUGIN_ROOT}/scripts/trello.sh" next-card <ready-list-id>` (top card = highest priority; never raw `curl`/`security` — the script keeps the token out of the transcript). `EMPTY` → report "no cards in *<ready list>*" and stop. Otherwise `trello.sh card <card-id>` for the full content (desc, checklists, comments), and record the pick as a `current_task:` line (card id + name + url) in `config.md` so `/dev-team:ship` can update the board later.

3. **Plan it through the team** (no edits, no coders yet):
   - **Resolve the task's source content up front.** Fold the fetched issue/card title, body/description, labels, checklists, and relevant comments into the shared digest handed to the leads — leads have no `gh`/`trello.sh` and their `WebFetch` can't read a private repo or board, so they must receive the resolved content, never a bare issue number/card id/URL.
   - Classify the tier (orchestration Tier rule).
   - Run **shared discovery once** across the involved domains (scout / `Explore` → one digest). For Tier 3, have `dev-team:architecture-lead` draft the artifact-routed architecture package — PRD-lite/TRD/ADR only as needed, plus execution plan (→ `dev-team:plan-reviewer`).
   - Have each relevant lead produce a **Handover Spec** from the shared digest — self-checked against `handover-spec.md`, `interface_contract` filled for shared shapes, `depends_on` set.
   - **Lint each spec before presenting it** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/spec-lint.mjs" --root <project-root> <spec.json>` (mechanical checks: paths exist, `file:line` refs resolve, commands are runnable). Exit 1 → bounce to the lead and re-lint before continuing (orchestration.md § Handover Spec).
   - Set each spec's `validation_commands` to the **narrowest command that actually covers `files_in_scope`** — a filtered/targeted test run (e.g. `pytest tests/foo -k thing`, `npm test -- items`) plus typecheck+lint, drawn from `config.validate.fast`, **never `config.validate.full`**. The coder and the orchestrator's inline re-verify both run these per dispatch, so a full slow suite here fans a tens-of-minutes run across every coder. The full suite is not skipped — it runs once at `/dev-team:ship` (`config.validate.full`); the spec lane is only the fast self-check that catches breakage before a bounce. Use `config.review_defaults` to set review depth.

4. **Present the plan for approval** — the architecture package/specs + the dispatch shape (which coders, parallel vs sequenced) + the gate plan. **Stop here.** On approval, continue to coders → QA gate → commit reconciled memory deltas (or the user runs execution separately). Don't move from Tier-3 design into implementation without explicit approval, unless activation mode is `auto` and the request is not high-risk (orchestration.md § Tier-3 architecture package).
   - **Move the task source forward (GitHub Projects board only), right when coders start — not at the confirmation in step 2.** A ready item sitting untouched at its ready status while work is actually underway is exactly the staleness this exists to prevent. Using the item node id captured in step 2 and the `project_node_id` / `status_field_id` / `status_options.<in_progress>` stored in `config.md`:
     ```
     gh project item-edit --id <item-node-id> --project-id <project_node_id> --field-id <status_field_id> --single-select-option-id <status_options.in_progress>
     ```
     Non-fatal — a renamed field or deleted option shouldn't block the actual coding work; report the failure and continue.

**Task:** $ARGUMENTS
