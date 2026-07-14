---
description: One-time per-project setup for the dev-team — detect stack + task source, seed memory, write config
---

Set up (or refresh) the dev-team for **this project**. This is the foundation that `/dev-team:next` and the leads rely on. You are the sole memory writer — do this yourself, work sequentially, and don't commit unless asked.

1. **Gather signals** (use your own tools):
   - `git remote get-url origin` + current branch.
   - Stack & scripts — read `package.json` / `go.mod` / `Cargo.toml` / `pyproject.toml` / `requirements.txt`.
   - Existing convention docs — `CONTEXT.md`, `AGENTS.md`, `CLAUDE.md`, `docs/architecture.md`, `CONTRIBUTING.md`.
   - Task surfaces — `gh issue list --limit 5` and `gh project list` (skip silently if `gh` is unavailable).
   - Any existing `.claude/dev-team/config.md`.

2. **Determine the validation commands** the project actually uses — typecheck / test / lint / build — from the scripts you found. **Split them into a fast lane and a full lane**, because a full test suite that runs for tens of minutes must not run on every coder self-check:
   - `fast:` — the checks safe to run often during iteration: typecheck, lint, and the *quickest* test command that still gives real signal (a smoke/unit-only/no-DB run — e.g. `make smoke`, `npm test -- --changed`, `pytest -m "not integration"`). If the project truly only has one test command and it's slow, say so — `fast` can omit tests and carry just typecheck+lint.
   - `full:` — the authoritative suite that must pass before a PR: the complete test run + integration/e2e + build. This runs **once, at `/dev-team:ship`** — never per-coder. Note explicitly which commands here are slow (the ones you're keeping out of the fast lane).
   Many projects already declare both (a `smoke`/`ci-*-fast` script alongside a full `test`) — map to those rather than inventing commands.

3. **Decide the task source, then CONFIRM with the user before writing.** Choose the most likely of: GitHub issues · GitHub Projects board · a Trello board (URL in `$ARGUMENTS` or existing config) · an in-repo backlog file (`TASKS.md` / `BACKLOG.md` / roadmap) · none. Prefer whatever `gh` / the repo actually shows. State your pick **and the "next" selection rule** (e.g. "label `ready`, else oldest open") in one line, and wait for the user to confirm or correct.

   **Epic/umbrella exclusion — applies to every GitHub source (issues list or Projects board), confirm once here.** Default pattern: never auto-pick an issue whose title matches `^\s*\[?(epic|umbrella)\]?\s*:` (case-insensitive, e.g. `Epic: ...`, `[Umbrella] ...`) or that carries an `epic` label — these need decomposition into sub-tasks, not direct execution as one task. Sample a few real issues (`gh issue list --limit 20 --json title,labels`) to check whether the project's actual convention differs (a milestone-based grouping, a different label name) and confirm the pattern with the user in the same one-line gate as the source pick. Store the confirmed pattern/label in `config.md`.

   **GitHub Projects board** (org or user Projects v2 — not the legacy repo "Projects" tab). `gh project list --owner <org-or-@me>` to find the project number. **Read the board before assuming its shape:**
   - `gh project item-list <number> --owner <org> --format json --limit 500` — inspect the `status` field's actual values (e.g. `Todo`/`In Progress`/`Done`) and every distinct `content.repository` present. **An org-level board routinely spans multiple repos** — never assume it's scoped to just the repo you're onboarding.
   - Confirm with the user: the status value that means "ready to pick" (e.g. `Todo`), the value that means "work has started" (e.g. `In Progress`), the value that means "shipped" (e.g. `Done`), and — if the board spans multiple repos — which repo(s) this task source should draw from. Fold into the same one-line confirmation as the source pick and the epic pattern above.
   - **Resolve and store the identifiers `next.md`/`ship.md` need to move items automatically** — without this, ready items sit stale at their starting status forever, which is worse than not tracking status at all. `gh project view <number> --owner <owner> --format json` → `.id` is the project node id. `gh project field-list <number> --owner <owner> --format json` → find the entry named for the status field (usually `Status`); its `.id` is the field id, and each entry in `.options` has the `.id` needed for that status value.
   - Store in config.md's `task_source:` block: `project: <number>, owner: <org-or-user>, ready_status: <value>, in_progress_status: <value>, done_status: <value>, repo(s): <owner/repo, ...>, project_node_id: <id>, status_field_id: <id>, status_options: { <ready-value>: <id>, <in-progress-value>: <id>, <done-value>: <id> }` plus the confirmed epic/umbrella exclusion pattern. **Do not store a next-rule that `next.md` can't execute as a literal command** — the selection procedure lives in `next.md` and reads this config; there's no ad hoc room for "figure out a reasonable query" at pick time, which is exactly how a wrong-status or wrong-repo issue gets picked by mistake.

   **Trello** (shortlink = the token after `/b/` in the board URL). All Trello access goes through `"${CLAUDE_PLUGIN_ROOT}/scripts/trello.sh"` — never raw `curl` or `security`, which would leak the token into the transcript.
   - Run `trello.sh check`. If it fails, walk the user through its printed setup steps in order (they run the `security` commands **in their own terminal**, not in-session); after the key is stored, print the `trello.sh auth-url` link for the one-click token, then re-run `check`.
   - `trello.sh lists <shortlink>` → guess the mapping by name: **ready** list (To Do / Ready / Backlog), **done** list (Done / Shipped), optional **doing** list. Ambiguous → ask via AskUserQuestion with the actual list names as options. Fold the mapping into the same one-line confirmation as the source pick — one gate, not two.
   - Selection rule is **top card of the ready list** (Trello list order = the user's drag-to-prioritize queue).
   - Store **list IDs + display names** (IDs are rename-proof) and the credential *resolution method* (e.g. `creds: keychain trello-api`) — never credential values.
   - Offer to add an allow rule for the resolved script path (e.g. `Bash(<plugin-root>/scripts/trello.sh:*)`) to the project's `.claude/settings.json` so daily `/dev-team:next` runs don't prompt.

4. **Seed project memory.** Create `<project-root>/.claude/dev-team/memory/` and, if missing, these files with a header + entry-format stub: `conventions.md`, `frontend-notes.md`, `backend-notes.md`, `devops-notes.md`, `qa-notes.md`, `architecture-notes.md`. Seed `conventions.md` from the existing convention docs — **summarize and cite the source file; don't copy wholesale**. (`<project-root>` = repo root; never add a second `dev-team/` segment.)
   - **On a refresh (files already exist), backfill the size check.** `orchestration.md` § Memory's archive trigger only fires right after a lead-delta write — a file that grew before that rule existed (or hasn't had a delta written to it in a while) never gets checked on its own. `wc -l` every existing live file now; over ~300 lines, archive its `deprecated` entries into `<file>.archive.md` per the same rule. This is the only way to clean up pre-existing bloat — re-running `/dev-team:onboard` in each project is the trigger.

5. **Write `<project-root>/.claude/dev-team/config.md`** — keep it tight; it's read on every run:
   - `task_source:` — type + repo/board + the next-selection rule (Trello: board shortlink, ready/doing/done list IDs + names, creds resolution method; GitHub Projects board: project number, owner, `ready_status`/`in_progress_status`/`done_status` values, scoped repo(s), `project_node_id`, `status_field_id`, `status_options`) + the confirmed epic/umbrella exclusion pattern.
   - `validate:` — the typecheck / test / lint / build commands, **split into `validate.fast` (iteration lane — typecheck+lint+smoke/quick tests, run often) and `validate.full` (the authoritative pre-PR suite — full tests + integration + build, run once at ship)**, per step 2. Mark the slow commands. If a project genuinely has only one lane, set `fast` and `full` to the same value and note it.
   - `review_defaults:` — domains/paths that should default to deep review (e.g. contracts, auth, migrations, infra).
   - `notes:` — project-specific things worth always knowing (monorepo layout, gotchas).

6. **Summarize** what you did: config path, task source + rule, validation commands, and which memory files were created vs already present.

**Input (optional overrides):** $ARGUMENTS
