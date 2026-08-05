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

_(none — #10 shipped 2026-08-05 as PR #35 (board item moved to Done); `/clear` and run `/dev-team:next` to pick up A2 (#27) or A3 (#25) next.)_

**#10 summary:** explicitly requested (not auto-picked; bypassed the Ready-pool epic/status filters). Tier 2, single domain (architecture/docs memory) — 4 deliverables split into 4 disjoint-file Handover Specs (no `depends_on`, safe to parallelize) after `architecture-lead` flagged that one combined spec risked exceeding `doc-writer`'s 15-turn/haiku/low-effort budget against ~95KB of source reads plus a 60-80KB TRD write. All 4 `doc-writer` coders dispatched in parallel, one PR: `docs/trd-cmux-execution-mode.md` (new, 725 lines, as-designed TRD assembled from epic #15 v2 + v2.1 with a 9-row "Superseded since ratification" table), `RECREATION-SPEC.md` (+Part 15, execution substrate, framed optional/harness-agnostic), `architecture-notes.md` (+11 ADRs, ADR-001…011, append-only, fixed numbering against the 012-017 already in use), `conventions.md` (+15 conventions + 1 process-lesson entry, append-only). QA gate: `code-reviewer` standard depth, source-fidelity lens (not deep — no code/schema/permission surface touched) — 1 must-fix (TRD's await.lock contention section still carried the v2.1-§D pre-correction "rank-0-only fallback" text in two places instead of the governing v2.1 Final-corrections "refuse + exit 2 + name holder's PID" rule; fixed directly, 2-line edit). 871/871 full suite green, version 0.1.58, branch `docs/cmux-phase3-trd-adrs`.

**Source-fidelity precedent worth flagging:** this is the first task where 4 parallel low-effort coders assembled a single design record from ~95KB of layered/amended source material (v1 → v2 → v2.1, with a "Final corrections" block overriding earlier same-document sections) — and it worked cleanly except for one spot where a later correction two files deep wasn't propagated. See `conventions.md`'s 2026-08-05 entry for the generalized lesson (as-designed record + supersession table, never a retro-edited doc).

**A1 (#26) summary:** `scripts/spec-lint.mjs` rewritten as a library — `lintSpec(spec, root) -> {ok, failures[], warnings[]}` and `main(argv) -> exitCode`, real JSON-schema validation replacing presence-only checks, `--json` output, `discovery_context` FAIL/WARN softening retaining exactly one FAIL condition, three independent path-regex fixes (hyphenated-path lookbehind, absolute-path resolution, bare-mention backtracking on double-extension filenames), and issue #9's noise-glob WARN absorbed. `handover-spec.schema.json` gained `minItems: 1` on `files_in_scope`/`acceptance_criteria`. QA gate: `test-engineer` mutation pass (sequenced alone) found 2 real coverage gaps + 1 by inspection, closed with 3 added tests; `code-reviewer-deep` found 1 Must-fix (reproduced: `process.exit()` truncates `--json` stdout at the 64KB pipe buffer under a piped consumer — fixed via `process.exitCode`) + 4 Should-fix + 1 Consider, all fixed; re-review `pass`. 178/178 targeted tests, 871/871 full suite green, version 0.1.57, branch `feat/spec-lint-library-a1`, PR #34.

**Corrected during planning, worth flagging:** a claimed "double-extension filename" spec-lint false positive (recorded in `backend-notes.md` since 2026-08-03) was mis-attributed to simple greedy-match failure and initially declared non-reproducing by static analysis. A live mechanical repro (running spec-lint against its own planning spec) proved it does reproduce, via a third, independent regex mechanism (bare-mention backtracking into an earlier dot) — corrected in the same PR, memory note fixed. See `qa-notes.md` 2026-08-05 for the generalized lesson (live reproduction required before striking a claimed defect).

**#8 summary (reduced scope):** (A) outcome-classifier fix — a gate-composed blocked markdown return was silently recorded `outcome: 'ok'` since #6 for all 6 already-pane-dispatched markdown roles; fixed via `BLOCKED_MARKDOWN_PREFIX` keying, never the verdict enum. (C) `max_turns` gate enforcement descoped to a loud refusal — investigation found the worker plugin's two hooks (`Stop`/`UserPromptSubmit`) have no point where `{"continue":false}` can interrupt a running loop; `--max-turns` CLI emission deleted (was already unreachable), `dispatchCmd`/`buildRecord` now throw before any side effect if `max_turns` ever resolves non-null. Recorded as **ADR-017** (not 014/015/016 — all three already claimed by the separate deterministic-backbone epic, #23). (D) `references/qa-gate.md` rewritten: gate branches on the parsed `{verdict,findings}` enum, never prose. Full 3-reviewer adversarial panel run once, revised after a bounce, re-reviewed clean (`code-reviewer-deep`, pass). 811/811 suite green, version 0.1.55, branch `feat/cmux-3b-gate-hardening`, PR #32. Planning specs archived at `.claude/dev-team/tasks/issue-8/*.spec.json`.

**Deliberately NOT shipped — reverted same-day:** (B) the reviewer/validator pane flip (`code-reviewer`/`code-reviewer-deep`/`build-validator` → `pane: true`). The QA panel found two real, independently-confirmed defects: reviewers dispatched onto a coder's slice reuse its *dirty* worktree, and the shared `clean` postcondition then demotes a good review verdict to `refused_postcondition`; separately, the `extractSection` first-match-wins shadowing guard was only closed on the authoring side (`agents/*.md`), never on a worker's actual return body. Both need real design, not a patch — see `architecture-notes.md` 2026-08-04 for the full writeup. **Follow-up task: re-design the pane flip's postcondition (dispatch-time-baseline delta, not absolute worktree state) + the runtime shadowing guard, then re-attempt the flip** — pick this up explicitly (it is not sub-issue #9, which is D16's noise filter; file a new sub-issue under epic #15 or fold into #8's remaining scope, next `/dev-team:next`'s call).

_(New epic #23 "deterministic backbone" filed 2026-08-04 — separate initiative from epic #15, composes with it (no ADR-007 deviation, no team-build.workflow.mjs edits). Fully planned: design record (v1 → plan-review → architect-consult → v2 → plan-review → v2.1 governing) posted as 8 comments on #23, matching #15's own convention; parked at `tasks/deterministic-backbone/*.md`. Pre-build consulted (2 scouts + backend/qa/devops leads) — findings folded directly into issue bodies for #24/#28, comments on #26/#28/#29. Two real defects caught and fixed pre-build: A0's `--max-block-s` recommendation corrected 600→570 (zero margin against the harness's exact 600,000ms Bash-tool ceiling); B1's baseline design corrected from sha-only to a content-hash fingerprint dict (sha-only couldn't detect a reverted or newly-untracked file — the exact case ADR-016 exists to catch).

**A0 (#24) shipped** 2026-08-04 — `references/cmux-dispatch.md` now recommends `--max-block-s 570` + explicit `timeout: 600000`, with the stale-threshold trade-off stated; pinned-substring + source-extracted tests added in `test/cmux-dispatch-doc.test.mjs`; `node --test` green (775/775); version bumped to 0.1.49. Direct Tier-1 edit, no lead/coder/QA-gate per orchestration.md.

Firm build queue, all sized/reviewed, dependencies stated in each issue: ~~**A0** (#24, doc-only, Tier-1-sized)~~ done → ~~**A1** (#26)~~ done → **A2** (#27) ‖ **A3** (#25, needs #7) → **B1** (#28, adversarial panel — command-execution + security-control surface) → **Gate M1** (#29, blocking measurement, no PR — decides whether Phase B is ever filed). Phase B is deliberately NOT filed; contingent on M1's residual-headroom threshold (≥6 decision-class calls/task). Epic #15's #9 was re-scoped by superseding comment (its spec-lint deliverable, one `warn()`, shipped as part of #26).

Start a fresh window with `/dev-team:next` to pick up A2 (#27) next (A3 (#25) is also ready and independent — either order works, `next.md`'s epic-momentum note will flag both). Epic #15's **#7 shipped 2026-08-04 as PR #31** (doc-wiring: ship.md teardown, onboard.md cmux prerequisite, team.md roster verb — deep review pass, 786/786 suite green); its sibling sub-issue #8 remains independently ready to promote whenever picked up (#9 shipped 2026-08-05 as PR #33). **A3 (#25) — its `#7` dependency is satisfied** (PR #31 merged via `Closes #7`); B1 (#28) still depends on #9 (shipped, so B1 is unblocked on that front too — check #28's issue body for any other stated dependency before picking it up next).)_

## notes

- Single-package repo, no monorepo layout.
- This repo **is** the dev-team plugin — `/dev-team:onboard`/`next`/`ship` here manage the plugin's own development, not a downstream consumer's.
- Convention (from git history, not written anywhere else): every functional commit bumps the `version` field in `.claude-plugin/plugin.json` (e.g. `0.1.43`) and the commit message ends with `; bump 0.<major>.<minor>`.
- No frontend surface currently exists in this repo.
- gh-dash PR-review keybinding (`ctrl+r`) is already wired in `~/.config/gh-dash/config.yml`, pointing directly at this repo's own `scripts/pr-review-window.sh` (not the plugin cache path — correct here since this repo *is* the source). `repoPaths` already covers `momoshell/*`. Skipped re-wiring per the "already references pr-review-window.sh" skip rule.
