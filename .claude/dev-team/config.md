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

Single command, two usage modes — the full suite (~771 tests as of v0.1.48) runs in **~60 seconds** (`node --test`; the cmux dispatch/preflight tests spawn real fake-cmux process topologies, so the pre-cmux "<1s" figure is obsolete). The `fast` lane in practice is per-file filtering: `node --test test/<relevant files>` scoped to the spec's `files_in_scope` (seconds); reserve the bare `node --test` for ship. No typecheck or lint tooling exists in this repo (no `tsconfig.json`, no eslint config) — it's plain JS/Markdown.

## review_defaults

Deep review by default for:
- `handover-spec.schema.json`, `coder-return.schema.json` — the spec contract; a breaking change here silently breaks every lead/coder handoff.
- `orchestration.md`, `references/*.md` — the core behavior rules injected into every session via the `SessionStart` hook.
- `hooks/hooks.json` — session-start injection wiring.
- `scripts/trello.sh` — handles credentials (must never leak them to stdout/stderr/transcript).
- `scripts/cmux/*.schema.json`, `scripts/cmux/roster.default.json`, `scripts/cmux/contract.mjs` — the cmux execution-mode contract freeze (slice 1a); same blast-radius class as the root schemas, plus it encodes a permission/security boundary.
- `scripts/cmux/*.mjs` (`resolve.mjs`, `record.mjs`, `cmuxctl.mjs`, `ladder.mjs`, `dispatch.mjs`) — the 1b dispatcher runtime; every one encodes a permission, path, or completion-evidence boundary (adversarial 3-reviewer panel was required at 1b, not just deep review).
- `scripts/pr-review-window.sh` — spawns windows/processes and does worktree teardown.

## current_task

_(New epic #23 "deterministic backbone" filed 2026-08-04 — separate initiative from epic #15, composes with it (no ADR-007 deviation, no team-build.workflow.mjs edits). Fully planned: design record (v1 → plan-review → architect-consult → v2 → plan-review → v2.1 governing) posted as 8 comments on #23, matching #15's own convention; parked at `tasks/deterministic-backbone/*.md`. Pre-build consulted (2 scouts + backend/qa/devops leads) — findings folded directly into issue bodies for #24/#28, comments on #26/#28/#29. Two real defects caught and fixed pre-build: A0's `--max-block-s` recommendation corrected 600→570 (zero margin against the harness's exact 600,000ms Bash-tool ceiling); B1's baseline design corrected from sha-only to a content-hash fingerprint dict (sha-only couldn't detect a reverted or newly-untracked file — the exact case ADR-016 exists to catch).

**A0 (#24) shipped** 2026-08-04 — `references/cmux-dispatch.md` now recommends `--max-block-s 570` + explicit `timeout: 600000`, with the stale-threshold trade-off stated; pinned-substring + source-extracted tests added in `test/cmux-dispatch-doc.test.mjs`; `node --test` green (775/775); version bumped to 0.1.49. Direct Tier-1 edit, no lead/coder/QA-gate per orchestration.md.

Firm build queue, all sized/reviewed, dependencies stated in each issue: ~~**A0** (#24, doc-only, Tier-1-sized)~~ done → **A1** (#26) → **A2** (#27) ‖ **A3** (#25, needs #7) → **B1** (#28, adversarial panel — command-execution + security-control surface) → **Gate M1** (#29, blocking measurement, no PR — decides whether Phase B is ever filed). Phase B is deliberately NOT filed; contingent on M1's residual-headroom threshold (≥6 decision-class calls/task). Epic #15's #9 was re-scoped by superseding comment (its spec-lint deliverable, one `warn()`, moved into #26).

Start a fresh window with `/dev-team:next` to pick up A1 (#26) next. Epic #15's own sub-issues #7 ‖ #8 ‖ #9 remain independently ready to promote whenever picked up; A3 (#25) and B1 (#28) depend on #9/#7 respectively.)_

## notes

- Single-package repo, no monorepo layout.
- This repo **is** the dev-team plugin — `/dev-team:onboard`/`next`/`ship` here manage the plugin's own development, not a downstream consumer's.
- Convention (from git history, not written anywhere else): every functional commit bumps the `version` field in `.claude-plugin/plugin.json` (e.g. `0.1.43`) and the commit message ends with `; bump 0.<major>.<minor>`.
- No frontend surface currently exists in this repo.
- gh-dash PR-review keybinding (`ctrl+r`) is already wired in `~/.config/gh-dash/config.yml`, pointing directly at this repo's own `scripts/pr-review-window.sh` (not the plugin cache path — correct here since this repo *is* the source). `repoPaths` already covers `momoshell/*`. Skipped re-wiring per the "already references pr-review-window.sh" skip rule.
