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

2. **Determine the validation commands** the project actually uses — typecheck / test / lint / build — from the scripts you found.

3. **Decide the task source, then CONFIRM with the user before writing.** Choose the most likely of: GitHub issues · GitHub Projects board · a Trello board (URL in `$ARGUMENTS` or existing config) · an in-repo backlog file (`TASKS.md` / `BACKLOG.md` / roadmap) · none. Prefer whatever `gh` / the repo actually shows. State your pick **and the "next" selection rule** (e.g. "label `ready`, else oldest open") in one line, and wait for the user to confirm or correct.

   **Trello** (shortlink = the token after `/b/` in the board URL). All Trello access goes through `"${CLAUDE_PLUGIN_ROOT}/scripts/trello.sh"` — never raw `curl` or `security`, which would leak the token into the transcript.
   - Run `trello.sh check`. If it fails, walk the user through its printed setup steps in order (they run the `security` commands **in their own terminal**, not in-session); after the key is stored, print the `trello.sh auth-url` link for the one-click token, then re-run `check`.
   - `trello.sh lists <shortlink>` → guess the mapping by name: **ready** list (To Do / Ready / Backlog), **done** list (Done / Shipped), optional **doing** list. Ambiguous → ask via AskUserQuestion with the actual list names as options. Fold the mapping into the same one-line confirmation as the source pick — one gate, not two.
   - Selection rule is **top card of the ready list** (Trello list order = the user's drag-to-prioritize queue).
   - Store **list IDs + display names** (IDs are rename-proof) and the credential *resolution method* (e.g. `creds: keychain trello-api`) — never credential values.
   - Offer to add an allow rule for the resolved script path (e.g. `Bash(<plugin-root>/scripts/trello.sh:*)`) to the project's `.claude/settings.json` so daily `/dev-team:next` runs don't prompt.

4. **Seed project memory.** Create `<project-root>/.claude/dev-team/memory/` and, if missing, these files with a header + entry-format stub: `conventions.md`, `frontend-notes.md`, `backend-notes.md`, `devops-notes.md`, `qa-notes.md`, `architecture-notes.md`. Seed `conventions.md` from the existing convention docs — **summarize and cite the source file; don't copy wholesale**. (`<project-root>` = repo root; never add a second `dev-team/` segment.)

5. **Write `<project-root>/.claude/dev-team/config.md`** — keep it tight; it's read on every run:
   - `task_source:` — type + repo/board + the next-selection rule (Trello: board shortlink, ready/doing/done list IDs + names, creds resolution method).
   - `validate:` — the typecheck / test / lint / build commands.
   - `review_defaults:` — domains/paths that should default to deep review (e.g. contracts, auth, migrations, infra).
   - `notes:` — project-specific things worth always knowing (monorepo layout, gotchas).

6. **Summarize** what you did: config path, task source + rule, validation commands, and which memory files were created vs already present.

**Input (optional overrides):** $ARGUMENTS
