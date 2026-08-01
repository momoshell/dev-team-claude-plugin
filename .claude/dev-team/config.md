# Dev-team config — dev-team-claude-plugin

## task_source

```
type: github_project
project: 3
owner: momoshell
name: Agent Orchestration
repo: momoshell/dev-team-claude-plugin
ready_status: Ready
in_progress_status: In progress
done_status: Done
project_node_id: PVT_kwHOBZYqs84BfEhf
status_field_id: PVTSSF_lAHOBZYqs84BfEhfzhZaG9Q
status_options:
  Backlog: f75ad846
  Ready: 61e4505c
  In progress: 47fc9ee4
  In review: df73e18b
  Done: 98236657
epic_exclusion:
  label: epic
  title_pattern: '^\s*\[?(epic|umbrella)\]?\s*:'
```

Notes: project 3 is scoped exclusively to this repo (verified — no other repo's items appear in it). All 15 items currently sit at `Backlog`; nothing is `Ready` yet, so `/dev-team:next` will correctly find no candidate until items are promoted. Issue #15 ("Epic: cmux execution mode…") already carries the repo's own `epic` label (description: "Tracking issue — excluded from task selection") — the label convention predates this onboarding.

## validate

```
fast: node --test
full: node --test
```

Single lane — the entire suite (87 tests across `test/*.mjs`) runs in **under 1 second** (`node --test`, verified). No typecheck or lint tooling exists in this repo (no `tsconfig.json`, no eslint config) — it's plain JS/Markdown. `full` and `fast` are identical; there is no slow suite to keep out of the fast lane.

## review_defaults

Deep review by default for:
- `handover-spec.schema.json`, `coder-return.schema.json` — the spec contract; a breaking change here silently breaks every lead/coder handoff.
- `orchestration.md`, `references/*.md` — the core behavior rules injected into every session via the `SessionStart` hook.
- `hooks/hooks.json` — session-start injection wiring.
- `scripts/trello.sh` — handles credentials (must never leak them to stdout/stderr/transcript).
- `scripts/pr-review-window.sh` — spawns windows/processes and does worktree teardown.

## current_task

_(none — #1 Phase-0 spike completed & closed 2026-08-01; board item → Done. Next task selected via `/dev-team:next`.)_

## notes

- Single-package repo, no monorepo layout.
- This repo **is** the dev-team plugin — `/dev-team:onboard`/`next`/`ship` here manage the plugin's own development, not a downstream consumer's.
- Convention (from git history, not written anywhere else): every functional commit bumps the `version` field in `.claude-plugin/plugin.json` (e.g. `0.1.43`) and the commit message ends with `; bump 0.<major>.<minor>`.
- No frontend surface currently exists in this repo.
- gh-dash PR-review keybinding (`ctrl+r`) is already wired in `~/.config/gh-dash/config.yml`, pointing directly at this repo's own `scripts/pr-review-window.sh` (not the plugin cache path — correct here since this repo *is* the source). `repoPaths` already covers `momoshell/*`. Skipped re-wiring per the "already references pr-review-window.sh" skip rule.
