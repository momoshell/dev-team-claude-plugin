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

3. **Decide the task source, then CONFIRM with the user before writing.** Choose the most likely of: GitHub issues · GitHub Projects board · an in-repo backlog file (`TASKS.md` / `BACKLOG.md` / roadmap) · none. Prefer whatever `gh` / the repo actually shows. State your pick **and the "next" selection rule** (e.g. "label `ready`, else oldest open") in one line, and wait for the user to confirm or correct.

4. **Seed project memory.** Create `<project-root>/.claude/dev-team/memory/` and, if missing, these files with a header + entry-format stub: `conventions.md`, `frontend-notes.md`, `backend-notes.md`, `devops-notes.md`, `qa-notes.md`, `architecture-notes.md`. Seed `conventions.md` from the existing convention docs — **summarize and cite the source file; don't copy wholesale**. (`<project-root>` = repo root; never add a second `dev-team/` segment.)

5. **Write `<project-root>/.claude/dev-team/config.md`** — keep it tight; it's read on every run:
   - `task_source:` — type + repo/board + the next-selection rule.
   - `validate:` — the typecheck / test / lint / build commands.
   - `review_defaults:` — domains/paths that should default to deep review (e.g. contracts, auth, migrations, infra).
   - `notes:` — project-specific things worth always knowing (monorepo layout, gotchas).

6. **Summarize** what you did: config path, task source + rule, validation commands, and which memory files were created vs already present.

**Input (optional overrides):** $ARGUMENTS
