# Architecture Package v2 — cmux Execution Mode for the dev-team plugin

**Author:** architecture-lead · **Rev:** v2 (supersedes v1 of 2026-07-31) · **Date:** 2026-08-01
**Repo:** `/Users/x/Development/dev-team-claude-plugin` @ v0.1.43
**Authoritative input:** design ledger D1–D13 + Addendum **D14, D15**.
**Revision drivers:** plan-reviewer verdict *revise* (8 blocking, 6 should-fix, notes) and architect *concur-with-changes* on both mechanisms (re-ranked doorbell ladder, doc-tab amendments, 4 additional risks).

This is a complete, self-contained package. Sections neither review touched are carried forward as-is; §3 is compressed by reference to v1 where unchanged. (v1: architecture-package-cmux-mode.md in this directory; reviews: review-plan-reviewer.md, review-architect.md.)

---

## 0. Resolution index (for the re-review audit)

**Plan-reviewer blocking**

| # | Resolution | Section |
|---|---|---|
| PR-1 | Read-only roles get a **scoped return-write grant**: `dontAsk` + allow rule `Edit(//<abs task-dir>/returns/**)`, no blanket deny (deny-beats-allow would kill it); a **static per-profile substrate addendum** appended to the role body grants the return duty. `permission_mode: plan` dropped from the planner profile — docs confirm it prevents source edits. Spike S9 gates it; "0 modified role files" claim restated honestly. | §4.6, §5.3, §5.4, S9, R13 |
| PR-2 | `await --all <ids…> --max-block-s N` = **foreground chunked join**, returns on first resolution / attention / cap; orchestrator loops until all resolved. Turn-sequencing rule lands in the orchestration.md Flow bullet. Ledger deviation (D4 "background Bash") filed. | §4.3, §5.5, §5.8, §13, S17 |
| PR-3 | Worktree lifecycle becomes an explicit `dispatch.mjs` responsibility (`isolation` field, create-before-pane, absolute `cwd`, never `--force` removal), owned by slice 1b, with test + acceptance criterion. | §5.2, §5.3, §5.5, §7 Ph1 |
| PR-4 | Freshness rule: placeholder is **lint-invalid by construction**; a return counts only if `mtime > record.created_at`; re-dispatch always mints a new `dispatch_id` + attempt nonce (new return path). | §5.3, §5.5, §8 |
| PR-5 | Gate's exhausted branch **writes the blocked return itself, signals, exits 0**; plus rank-0 file watch + EXIT sentinel make "always unblocks" true without the socket. | §4.3, §5.6, §5.7 |
| PR-6 | Signal-before-wait race: `await` stats+lints before arming; events use a durable `--cursor-file`; latch semantics spiked (S5); attempt nonce prevents a stale latched token satisfying a fresh wait. | §4.3, §5.5, S5 |
| PR-7 | S8 audits the **installed** `claude` binary (flags + argv forms) and gates 1c; A1 downgraded to *doc-verified only*. Argv forms newly verified from docs (`--tools` comma, `--allowedTools` space). | §3.4, S8, §11 |
| PR-8 | R10 rewritten (Medium). S15a/S15b measure pane vs subagent **with cache accounting** (D15) against a stated ceiling; roster `pane:` flag is the lever if overhead is material. | R10, S15, §12 |

**Plan-reviewer should-fix / notes**

| # | Resolution | Section |
|---|---|---|
| SF-9 | orchestration.md delta scoped by roster `pane:` flag per role; Phase 1 ships `pane: true` for `coder` only. | §5.4, §5.8 |
| SF-10 | All four ledger deviations promoted to explicit ratification items (executor carve-out, Tier-1 coder routing, `cmux hooks setup` disposition, D12 orphan capabilities mapped/dropped). | §13, §14 |
| SF-11 | S14 captures the pane's actual injected context; the fidelity delta is stated in the TRD and feeds S15. | §5.6, S14, §11 |
| SF-12 | Slice 1c gets an **adversarial panel**, not just `code-reviewer-deep`. | §7 Ph1 |
| SF-13 | Separate `preflight.json`; three new §5.7 rows; Phase 1 ships manual `teardown`; §12 criteria 6/7 made testable; return-lint heading-match semantics defined; "Proposed memory deltas" required for lead roles. | §5.2, §5.7, §5.4, §7, §12 |
| SF-14 | Both new user decisions added (lead markdown-return contract; worker signal carve-out removal). | §14 |
| N-15 | schema-test work item dropped; `DEVTEAM_ROLE` → `DEVTEAM_WORKER=1` + systemMessage; worker plugin is a **static in-repo dir** owned by 1c; adapter/role paths resolved at dispatch time (re-dispatch re-resolves). | §5.1, §5.6, §8 |

**Architect amendments** — all adopted; three adopted with refinement, none rebutted.

| Ref | Disposition |
|---|---|
| Q1 re-ranked ladder (file-watch rank 0 co-primary, `notification.requested` rank 1, EXIT-trap rank 2, Stop-gate rank 3 bounded, self-signal dropped) | **Adopted in full** (§4.3, ADR-003). EXIT trap additionally writes a filesystem sentinel so rank 2 survives an unreachable socket (S4). |
| Q1-1…Q1-6 (never trust `stop_hook_active`; own counter; N=2 cap; observe-mode on interjection; never fail-open; `signal OR file` await; arm-before-kickoff) | **Adopted**; Q1-3 refined: observe mode is per-dispatch, sticky, and surfaced in `status` so the orchestrator knows enforcement is off. |
| Q1-7 (static worker plugin over generated `--settings`) | **Adopted, promoted to primary** — D15 makes it load-bearing, not just tidier (§5.6, S11/S12). |
| Q1-8 (new spikes) | Adopted as S5 (latch + namespace), S4 (hook-subprocess socket reach). |
| Q1-9 (`max_turns` via gate counter + `continue:false`) | **Adopted, deferred to Phase 3** — recovers R4 fidelity once the gate is stable; gate must still signal (trap doesn't cover it). |
| Q2-1…Q2-8 (UUID-only persistence, re-read before acting, open→move→reorder with `--focus false`, tmp+rename never rm, lint-invalid placeholder, focus-not-close default, teardown ordering, extended S2) | **Adopted in full** (§4.4, §5.2, §5.5, ADR-004). Q2-4 adopted as an ADR-004 wording fix: the doc tab is a *viewing* surface; approval happens in the orchestrator pane. |
| "Materially riskier" ×4 (R6 wrong; executor stall **High**; worktree × task-dir; `DEVTEAM_ROLE` too broad) | **All adopted** → R6 corrected, R11 (High) added with the `dontAsk` fix + S10, R12 added with the absolute-path rule, R14 added with `DEVTEAM_WORKER=1` + systemMessage. |

**Ledger addendum** — **[resolves D14]** §5.5 preflight, §5.8, §7 Ph3 onboard, R7, §12·4, ADR-008. **[resolves D15]** §5.9 (new), §5.3 argv composition, §5.5 wave launching, S15, ADR-009.

---

## 1. Problem & goal

*(unchanged from v1)*

The plugin's execution substrate today is the Agent tool: every lead, coder, reviewer and validator runs as a hidden subagent whose only observable trace is a panel row and a returned blob of text. The user cannot watch, interject, or triage; a stalled agent is indistinguishable from a slow one; and the substrate is welded to one vendor's CLI.

The goal is to swap the substrate — dev-team roles become **visible cmux panes launched by adapter scripts** — while the brain (tiers, Handover Specs, spec-lint, QA-gate ladder, memory protocol, ship semantics) is untouched.

The hard parts, restated after review: (a) an adapter contract that is multi-agent-ready without speculative generality; (b) **a completion path that cannot lie and cannot hang** — which review showed is not one mechanism but a ladder; (c) **a return channel for read-only roles**, which does not exist in a pane and was the single largest hole in v1; (d) landing this inside a plugin whose core prompt is a deliberately-lean 65 lines, at a cost that survives the July-2026 sub-limit discipline.

---

## 2. Artifact decision

| Artifact | Verdict | Why |
|---|---|---|
| **PRD-lite** | **No** | Product behavior fully specified by D1–D15 and user-confirmed. |
| **TRD/RFC** | **Yes** (§5) | The difficulty is implementation architecture: adapter contract, doorbell ladder, permission model, lifecycle, cache discipline. |
| **ADRs** | **Yes — 9** (§6) | v1's 7, of which ADR-003 is rewritten and ADR-004/005 amended, plus ADR-008 (cmux as hard prerequisite, D14) and ADR-009 (cache-stable pane prefixes, D15). |
| **Execution plan** | **Yes** (§7) | 5 phases + a blocking spike phase, with parallelizable slices. |

Persist the TRD as `docs/trd-cmux-execution-mode.md`; ADRs as entries in `.claude/dev-team/memory/architecture-notes.md`. **Prerequisite (unchanged): `/dev-team:onboard` must run on this repo before Phase 1's memory deltas can land** — `.claude/dev-team/` does not exist yet.

---

## 3. Ground truth & constraints

**v1 §3.1 (repo facts), §3.2 (cmux public docs vs vendored skills), §3.3 (vendored skills @ 0.64.17) stand unchanged** — no review disputed any of them; the cmux verb-surface gap remains R1. Only the deltas below are new or corrected.

### 3.4 New since v1 (fetched this session, `code.claude.com/docs`)

| # | Fact | Consequence |
|---|---|---|
| G1 | **`dontAsk` auto-denies any tool call not covered by an allow rule — it never prompts.** `acceptEdits` only auto-accepts edits + common fs commands (`mkdir/touch/mv/cp`); other Bash calls still prompt. | Kills the executor stall (R11). Every worker profile becomes `dontAsk` + explicit allow rules. |
| G2 | **`plan` mode: Claude reads files and runs read-only shell commands but doesn't edit files.** | v1's `planner` profile could never write a return file. Confirms PR-1; `plan` is dropped from all profiles. |
| G3 | **Deny beats allow** ("denylist takes precedence over allowlist"). | A scoped grant can only work with *no* blanket deny — allowlist + `dontAsk`, never denylist + carve-out. Independently kills the D9 self-signal carve-out. |
| G4 | **`Write(path/**)` rules are not matched by file permission checks — only `Edit(path)` rules are; "Edit rules cover all file-editing tools."** The CLI prints a startup warning for `Write(...)` path rules. | The return grant must be written `Edit(//<abs task-dir>/returns/**)`. S9 verifies it covers the Write *tool*. |
| G5 | Path anchors: `//abs` = filesystem root; `/p` = relative to the settings source; `p`/`./p` = relative to cwd. **CLI-flag rules anchor at the original cwd.** | With cwd = a worktree, only the `//abs` form is safe. Grounds R12's absolute-path rule. |
| G6 | Argv forms: `--tools` is **comma-separated** and restricts the built-in tool *universe*; `--allowedTools`/`--disallowedTools` are **space-separated permission rules**. | **Corrects a v1 bug:** v1 mapped frontmatter `tools` → `--allowedTools`. Frontmatter `tools` is a universe restriction → `--tools`. Mis-mapping would have left every read-only lead with a full tool universe. |
| G7 | `--add-dir` grants file access but **`.claude/` configuration is not discovered from those directories**. | Task-dir access without importing project config — used deliberately for D10. |
| G8 | Vendored skill: **"Claude Code emits notifications out of the box when launched inside cmux (no `cmux hooks` entry needed)"**; `notification.requested` fires once per completed turn; `surface_id` usually `null` for hook-emitted events, `workspace_id` always set; title/body redacted. | Rank-1 doorbell needs no `cmux hooks setup` for Claude, but is **workspace-scoped**: any event ⇒ re-scan *all* outstanding returns. |
| G9 | `--id-format uuids|both` is available on cmux JSON output. | Makes ADR-004's UUID-only persistence implementable. |
| G10 | `stop_hook_active` is undocumented in the Stop input and reported broken (anthropics/claude-code #54360, #55754 — 100+ iteration loop consuming a full session). | The gate owns its own counter file; `stop_hook_active` is an *extra* early exit only. R15. |

### 3.5 Binding constraints

1. **Brain unchanged** — no change to tier semantics, spec-lint, the QA-gate ladder, memory protocol, or ship flow. *(One narrow exception now surfaced for ratification: lead returns become file-backed markdown with required sections — §14·2.)*
2. **Lean core** — `orchestration.md` grows by ≤ 8 lines; all cmux mechanics live in **one** on-trigger reference (D13).
3. **Cost discipline** — spawn-on-demand only; no standing fleets; idle finished panes burn nothing; **plus D15: cache-friendly dispatch is a design requirement, measured, with a ceiling.**
4. **Every new script gets `test/<name>.test.mjs`** runnable with no model, no network, no GUI.
5. **Version bump every commit**; house commit style.
6. **cmux is an environment prerequisite, not a preference (D14)** — when `execution_mode: cmux`, preflight failure is a hard stop with remediation, never a silent substrate swap.

---

## 4. Options & recommendations

### 4.1 Dispatch logic — **unchanged: option B**, `scripts/cmux/dispatch.mjs` with verbs (determinism, testability against a fake `cmux`, tiny reference file). The plugin's existing split: mechanical work in a script, judgment in prose.

### 4.2 Pane creation — **unchanged: terminal surface + `exec <adapter> run <record>` baseline; `new-surface --type agent-session --provider claude` as a spike-gated upgrade (S21).** Flag control is existential; native resume is a nicety (recovery is file-based).

### 4.3 The completion path — **REVISED: a four-rank ladder, not one mechanism** [resolves PR-2, PR-5, PR-6; adopts architect Q1]

v1 ranked by elegance (Stop-hook gate primary). Review showed the primary could both hang (interactive TUI never exits) and burn a session (unbounded block loop, #55754). The corrected design separates two jobs v1 conflated:

> **Waking the orchestrator** (liveness — must have zero platform dependencies) is *not* **enforcing the return contract** (correctness — may depend on hooks).

| Rank | Mechanism | Depends on | Job |
|---|---|---|---|
| **0** | **Return-file watch inside `await`** — stat + `return-lint` every 3–5 s, freshness-checked | nothing but the filesystem | Co-primary. Dissolves R2: no hook, no socket, no event needed. |
| **1** | `cmux events --name notification.requested --cursor-file <task-dir>/events.cursor --reconnect`, workspace-scoped ⇒ **re-scan all outstanding returns** | cmux events + native Claude notifications (G8, S6) | Primary push — near-instant wake on any pane's turn end, adapter-agnostic. |
| **2** | Adapter `trap … EXIT` → **write `logs/<id>.exit` sentinel *and* `cmux wait-for -S <token>`** | filesystem (sentinel) / socket (token) | Liveness backstop for crash/kill. Sentinel first, so it survives S4 failing. |
| **3** | **Stop-hook return-gate**, bounded | worker-plugin hook delivery (S11) | *Contract enforcement only* — "you cannot end your turn without a valid return", ≤ 2 blocks, then writes the blocked return itself. Never the signal of record. |
| — | ~~Agent self-signal~~ | — | **Dropped.** Prompt-dependent; G3 (deny beats allow) makes D9's carve-out unreliable. |

`cmux wait-for` remains the fast path *inside* `await` (short repeated blocks), never the only path.

**Join semantics [resolves PR-2].** `dispatch.mjs await --all <ids…> --max-block-s N` runs a **foreground, bounded, chunked** loop and returns on the first of: a fresh valid return; a turn-end event with no valid return (`attention`); an EXIT sentinel; a per-dispatch timeout; or the block cap. Output names what resolved and what remains. The orchestrator re-invokes until everything is resolved — the Agent tool's blocking rhythm rebuilt out of bounded tool calls, with each chunk boundary a natural interjection point. Background Bash is *not* the primary path (ledger deviation §13·1).

**Race closure [resolves PR-4, PR-6].** `await` stats+lints before arming; the events cursor file persists across invocations; placeholders are lint-invalid by construction; a return counts only if `mtime > record.created_at`; re-dispatch mints a new `dispatch_id` **and** an attempt nonce in the token.

**Property this buys (v1's version was false):** *the orchestrator's join always terminates — by a fresh valid return, by an explicit blocked return (written by the agent, the gate, or the adapter), or by a timeout that names the pane, its log, and its screen tail.* No branch ends in silence.

### 4.4 The doc tab (D7) — **open-then-move confirmed, with four amendments** [adopts architect Q2]

Mechanism: `cmux markdown open <return-path> --surface <terminal-uuid> --json` → `move-surface --surface <md-uuid> --pane <pane-uuid> --focus false` → optional `reorder-surface --before <terminal-uuid>`. Architect strengthened the evidence (`markdown open --json` returns `{window_id, workspace_id, pane_id, surface_id, path}` — same namespace `move-surface` operates on); S18 stays blocking for Phase 2. Fallbacks unchanged: browser surface tab → split pane.

Amendments, all adopted:

1. **UUIDs only, never positional refs** — `--id-format uuids` everywhere; the record persists UUIDs. Positional refs (`surface:9`) live inside a single command invocation only. Without this, `close-surface` can close another dispatch's pane once numbering shifts — the concrete bug behind R6's correction.
2. **Re-read before acting** — `close-surface`/`move-surface`/`send`/`read-screen` re-resolve from `tree --json` immediately before use and no-op *loudly* if the UUID is gone.
3. **Don't close the terminal surface** (Phase-2 default) — focus/reorder the doc tab instead. A finished adapter shell costs nothing, the log stays for triage, and A5 (collapse-on-close) leaves the critical path. Collapse-on-close ships only if S19 passes (§13·2).
4. **Write discipline: overwrite in place or tmp+rename; never `rm`-then-recreate.** Delete-recreate later than cmux's ~500ms retry window bricks the panel permanently.

Plus: the placeholder is a **contract** — `# {icon} {role} — working…`, containing none of the required sections, lint-invalid by construction; and the doc tab is a **viewing** surface — approval happens in the orchestrator's pane.

### 4.5 Return format — **unchanged: option B**, `return.kind` per role (`json` for coders; `markdown` structurally linted for judgment roles).

### 4.6 **NEW — How a read-only role produces its return file** [resolves PR-1]

The hole: leads declare read-only tools and "never Edit/Write"; reviewers disallow Write. Under the Agent tool the return travels in the tool's return message — a channel that does not exist in a pane. Phase 2/3 were impossible as v1 was written.

| Option | Optimizes | Sacrifices |
|---|---|---|
| **A — scoped write grant.** `dontAsk` + `--tools …,Write` + allow rule `Edit(//<abs task-dir>/returns/**)`, **no blanket Edit/Write deny**; a static substrate addendum tells the role to write exactly that file. | Mechanism bounds the blast radius; one uniform rule; role files stay the single source. | Rests on G4 + G3 ordering — spiked (S9). |
| B — adapter captures the return from the transcript. | No permission change. | Parsing model prose into a contract = the screen-scraping ADR-002 forbids, one indirection removed. Rejected. |
| C — edit all 14 `agents/*.md` with a "write your return to `$DEVTEAM_RETURN_PATH`" clause. | Honest, no new mechanism. | 14 files of churn; still needs A's grant to actually write. Rejected as primary; C's *text* survives as A's addendum. |

**Recommendation: A, committed.** Concretely:

- **Profiles become allowlist-shaped, never denylist-shaped** (G3): `permission_mode: dontAsk` everywhere; tool universe set with `--tools`; everything a role may do is an explicit allow rule. `plan` mode is gone (G2).
- The grant is `Edit(//<abs task-dir>/returns/**)` — absolute `//` form because cwd may be a worktree (G5, R12).
- The role's duty to write it comes from a **static per-profile substrate addendum** the adapter concatenates onto the role body: `scripts/cmux/prompts/return-contract.{json,markdown}.md`. It names the conflict explicitly ("this supersedes the read-only boundary in exactly one respect: you write `$DEVTEAM_RETURN_PATH` and nothing else"), references the path **via env var** so the text is byte-identical across dispatches (D15), and lives under `scripts/`, **not** `agents/` (a file in `agents/` would be auto-discovered as a subagent).
- **The honest claim replacing v1's "agents/*.md unchanged: 0":** *no role prompt is copied or forked; all 14 files stay the single source of truth; the adapter appends one static, reviewable, per-profile addendum at launch.*
- **Scoped-write is spike-gated (S9)** with an on-no ladder (parallel `Write(...)` rule → relocate `returns/` outside the repo [D6 deviation, needs ratification] → accept unscoped Write for judgment roles, leaning on the gate's git scope check).

---

## 5. TRD — implementation architecture

### 5.1 Component map

**New files**

| Path | Kind | Responsibility |
|---|---|---|
| `scripts/cmux/dispatch.mjs` | node, zero-dep | `preflight`, `workspace`, `dispatch`, `await`, `close`, `status`, `teardown`, **worktree lifecycle** (PR-3). Never talks to a model. |
| `scripts/cmux/adapters/claude.sh` | bash | `capabilities` + `run <record.json>`. The only file that knows `claude` flag syntax. |
| `scripts/cmux/worker-plugin/` | plugin dir | **Static** worker plugin (`hooks/hooks.json` + `.claude-plugin/plugin.json`) loaded with `--plugin-dir`: `Stop` → `return-gate.sh`, `UserPromptSubmit` → `gate-mode.sh`. Reads `$DEVTEAM_*` from env — nothing generated per dispatch (N-15c, D15). |
| `scripts/cmux/return-gate.sh` | bash | Bounded contract enforcement: lint → signal, or block with the lint failure, or (on exhaustion) write the blocked return itself and allow the stop. |
| `scripts/cmux/gate-mode.sh` | bash | `UserPromptSubmit`: first prompt (kickoff) leaves `gate.mode=enforce`; any later prompt writes `observe` — sticky, per dispatch. |
| `scripts/cmux/return-lint.mjs` | node, zero-dep | JSON-schema check or heading check. Exit 0/1/2, mirroring `spec-lint.mjs`. |
| `scripts/cmux/prompts/return-contract.{json,markdown}.md` | markdown | Static substrate addenda (§4.6). |
| `roster.schema.json`, `roster.default.json`, `dispatch-record.schema.json` | schema + data | Roster shape, zero-config roster, **adapter interface contract**. |
| `references/cmux-dispatch.md` | markdown | Read at the dispatch trigger: (1) dispatch protocol & policy; (2) distilled verb reference + `cmux docs` fallback. **Exactly one new reference file.** |

**Modified files**

| Path | Change |
|---|---|
| `orchestration.md` | +4 lines (§5.8) |
| `hooks/hooks.json` | SessionStart self-suppression guard on `DEVTEAM_WORKER` + one-line `systemMessage` when suppressing (N-15b, R14) |
| `commands/team.md` | `roster` + `mode` verbs |
| `commands/ship.md` | teardown step between 5 and 6, ordering per §5.5 |
| `commands/onboard.md` | cmux **prerequisite check** with remediation (D14), roster seeding, `tasks/.gitignore`, `execution_mode` |
| `references/qa-gate.md` | `cmux diff` note + browser-verify evidence |
| `agents/*.md` | **unchanged** — see §4.6 for the honest form of this claim |

**Frontmatter → flag mapping (corrected, G6):** `model`→`--model`, `effort`→`--effort`, **`tools`→`--tools` (comma-separated universe)**, `disallowedTools`→`--disallowedTools` (space-separated rules), `permissionMode`→ overridden by the profile (always `dontAsk` for workers), `maxTurns`→ no interactive CLI equivalent (R4; recoverable via the gate counter in Phase 3). Workers never get the Task/Agent tool.

### 5.2 Data layout

```
<project-root>/.claude/dev-team/
├── config.md                       # + execution_mode: cmux|agent-tool, + keep_task_artifacts:
├── roster.json                     # COMMITTED (ADR-006)
├── memory/…                        # unchanged
└── tasks/                          # GITIGNORED via tasks/.gitignore ("*" + "!.gitignore")
    └── <task-slug>/
        ├── preflight.json          # CACHE of the session preflight  [SF-13]
        ├── status.json             # DERIVED, never hand-mutated, atomic tmp+rename
        ├── events.cursor           # cmux events cursor (durable across await invocations)
        ├── roster.snapshot.json
        ├── worktrees.json          # {path, branch, dispatch_id, created_at} — never force-removed  [PR-3]
        ├── specs/<task_id>.json
        ├── dispatch/<dispatch-id>.json          # immutable once written
        ├── returns/<dispatch-id>.{json,md}      # the return; md doubles as the doc tab
        ├── gate/<dispatch-id>.{attempts,mode}   # gate's own bound + enforce|observe  [Q1-1/3]
        └── logs/<dispatch-id>.{log,gate.log,exit}
```

**Concurrency rule (corrected, R6).** Filesystem side already safe (per-dispatch files, derived status.json). The unsafe shared namespace is **cmux's positional refs** — hence UUIDs persisted, positional refs never; re-read before acting.

**Worktree × task-dir rule (R12).** Task dir lives under the primary checkout; a coder's pane cwd may be a worktree. Every path in a dispatch record is **absolute**; `--add-dir <abs task-dir>` mandatory; permission rules use the `//abs` anchor (G5); preflight asserts the task dir is not inside any worktree it created. G7 relied on deliberately for D10.

### 5.3 Adapter interface contract

**CLI surface** (unchanged): `<adapter> capabilities` · `<adapter> run <record.json>`.

`capabilities` gains `"scoped_path_rules": true|false` and `"non_prompting_mode": "dontAsk"|null`; preflight refuses to dispatch a role whose roster entry needs an undeclared slot.

**Dispatch record** (v2 — key additions: `attempt`, allowlist-shaped `profile`, `addendum_path`, `isolation`+`worktree`, UUID `surface`, `gate`, nonce in token):

```json
{ "schema_version": 2,
  "dispatch_id": "be-02.1", "attempt": 1, "task_id": "add-priority-field", "role": "coder",
  "agent": "claude", "model": "sonnet", "effort": "medium",
  "profile": { "name": "executor", "permission_mode": "dontAsk",
               "tools": ["Read","Edit","Write","Glob","Grep","Bash"],
               "allow": ["Edit(//abs/worktree/**)", "Edit(//abs/task-dir/returns/**)",
                         "Bash(npm run typecheck *)", "Bash(npm test *)",
                         "Bash(git status *)", "Bash(git diff *)"],
               "deny":  ["Bash(cmux *)"],
               "disable_slash_commands": true },
  "role_prompt_path": "<plugin-root>/agents/coder.md",
  "addendum_path":    "<plugin-root>/scripts/cmux/prompts/return-contract.json.md",
  "spec_path":   "//abs/task-dir/specs/be-02.json",
  "return_path": "//abs/task-dir/returns/be-02.1.json",
  "return": { "kind": "json", "schema_path": "<plugin-root>/coder-return.schema.json" },
  "isolation": "worktree",
  "worktree": { "path": "//abs/worktrees/be-02", "branch": "dt/be-02", "created_by_dispatcher": true },
  "cwd": "//abs/worktrees/be-02",
  "env": { "DEVTEAM_WORKER": "1", "DEVTEAM_ROLE": "coder", "DEVTEAM_TASK_ID": "…",
           "DEVTEAM_DISPATCH_ID": "be-02.1", "DEVTEAM_SPEC_PATH": "…",
           "DEVTEAM_RETURN_PATH": "…", "DEVTEAM_GATE_DIR": "…", "DEVTEAM_SIGNAL_TOKEN": "…" },
  "signal_token": "dt-add-priority-field-be-02.1-a1",
  "kickoff": "single-line kickoff — points at $DEVTEAM_SPEC_PATH and $DEVTEAM_RETURN_PATH",
  "surface": { "workspace_id": "<uuid>", "pane_id": "<uuid>", "surface_id": "<uuid>" },
  "gate": { "max_blocks": 2, "mode": "enforce" },
  "timeout_s": 1800, "created_at": "2026-08-01T12:00:00Z" }
```

**Outputs and error behavior** (amended):

1. The return file at `return_path`, fresh (`mtime > created_at`) and valid per `return`.
2. **A sentinel `logs/<id>.exit` written from `trap … EXIT`, plus a best-effort `wait-for -S <token>`** — the sentinel cannot fail if the socket is unreachable from a subprocess (S4).
3. `logs/<dispatch-id>.log` (adapter stderr) and `logs/<dispatch-id>.gate.log` (gate's captured failures).
4. **The adapter never leaves the orchestrator without a return file** — CLI missing → `blocked`, exit 3; unreadable record/role file → `blocked`, exit 2; agent exited with no fresh valid return → `blocked` naming the log, exit 1. Markdown roles get a stub with the same status line. All writes tmp+rename. Non-zero exit holds the pane open (`hold()`).

**Composed argv (claude adapter, executor profile), D15-shaped:**

```
claude --model sonnet --effort medium --permission-mode dontAsk \
       --append-system-prompt-file <role body + static profile addendum, frontmatter stripped> \
       --tools Read,Edit,Write,Glob,Grep,Bash \
       --allowedTools "Edit(//abs/worktree/**)" "Edit(//abs/task-dir/returns/**)" \
                      "Bash(npm run typecheck *)" "Bash(npm test *)" \
       --disallowedTools "Bash(cmux *)" \
       --disable-slash-commands \
       --plugin-dir <plugin-root>/scripts/cmux/worker-plugin \
       --add-dir //abs/task-dir \
       "<kickoff>"
```

`--append-system-prompt-file` (append), not replace (S16 compares). **D15:** appended content is byte-stable per role+profile; every per-dispatch value reaches the session through env and the kickoff, never the system prefix.

### 5.4 Roster (D2), rewritten profiles

```json
{ "version": 2,
  "execution_mode": "cmux",
  "defaults": { "agent": "claude", "timeout_s": 1800, "icon": "robot", "max_gate_blocks": 2 },
  "profiles": {
    "planner":  { "permission_mode": "dontAsk",
                  "tools": ["Read","Glob","Grep","WebFetch","WebSearch","Write"],
                  "allow": ["Edit(${RETURNS_GLOB})"],
                  "deny":  ["Bash(cmux *)"], "disable_slash_commands": true },
    "executor": { "permission_mode": "dontAsk",
                  "tools": ["Read","Edit","Write","Glob","Grep","Bash"],
                  "allow": ["Edit(${CWD_GLOB})","Edit(${RETURNS_GLOB})",
                            "${SPEC_VALIDATION_COMMANDS}","Bash(git status *)","Bash(git diff *)"],
                  "deny":  ["Bash(cmux *)"], "disable_slash_commands": true },
    "reviewer": { "permission_mode": "dontAsk",
                  "tools": ["Read","Glob","Grep","Bash","Write"],
                  "allow": ["Edit(${RETURNS_GLOB})","Bash(git diff *)","Bash(git log *)","Bash(git status *)"],
                  "deny":  ["Bash(cmux *)"], "disable_slash_commands": true }
  },
  "roles": {
    "coder":             { "pane": true,  "agent": "claude", "model": "sonnet", "effort": "medium",
                           "profile": "executor",
                           "return": { "kind": "json", "schema": "coder-return.schema.json" },
                           "doc_tab": false, "timeout_s": 1800 },
    "backend-lead":      { "pane": false, "model": "opus", "effort": "high", "profile": "planner",
                           "return": { "kind": "markdown",
                                       "required_sections": ["Handover Spec", "Proposed memory deltas",
                                                             "Assumptions & unknowns"] },
                           "doc_tab": true, "timeout_s": 2400 },
    "code-reviewer":     { "pane": false, "model": "sonnet", "profile": "reviewer",
                           "return": { "kind": "markdown",
                                       "required_sections": ["Verdict","Must-fix","Notes"] },
                           "doc_tab": true }
  } }
```

- **`pane:` per role [SF-9]** — Phase 1 ships `coder: true` only; Phase 2 flips leads; Phase 3 flips reviewers/validators. Also the lever if S15 shows pane overhead is material for a role class (R10).
- `${RETURNS_GLOB}`/`${CWD_GLOB}` expand to `//abs` forms at dispatch time. `${SPEC_VALIDATION_COMMANDS}` expands the spec's `validation_commands` into `Bash(<cmd> *)` allow rules — the answer to "enumerate Bash rules exhaustively" (R11). S15 records whether per-dispatch allow-rule variance perturbs the cached prefix; if so, hoist to a static per-role set.
- **Resolution precedence** (unchanged): frontmatter → plugin default → global → project → session override.
- **Preflight validation** (unchanged) — plus: under D14 an invalid *roster file* is a hard stop.
- **Return-lint heading semantics [SF-13]:** a `required_sections` entry matches a markdown heading of level ≥ 2 whose text, case-folded, **starts with** the required string (so `"Handover Spec"` matches `### Handover Spec (one per coder task)`). `"Proposed memory deltas"` **is required** for lead roles (may say "none"). Linting stays weak: presence, not quality.

### 5.5 Dispatch lifecycle

**Preflight** — once per session, cached in `preflight.json`:

1. `cmux ping` · 2. `cmux identify --json --id-format uuids` (the ADR-005 security gate) · 3. `cmux capabilities --json` (R1) · 4. `cmux --version` · 5. `cmux config doctor` **on failure only** (diagnostics for remediation) · 6. adapter `capabilities` per distinct agent · 7. worktree/task-dir containment assertion (R12).

**Failure ⇒ hard stop with remediation [resolves D14].** No dispatch, no Agent-tool substitution:

| Failure | Message shape |
|---|---|
| binary missing | `cmux is required by execution_mode: cmux. Install: brew tap manaflow-ai/cmux && brew install --cask cmux — then start this session inside a cmux terminal.` |
| `ping` fails | `cmux is installed but not running. Start the cmux app and retry.` |
| `identify` fails | `This session is not running inside a cmux pane. Socket control mode is cmuxOnly by design (ADR-005) — open a cmux terminal in this project and start Claude Code there.` |
| verb missing | `Installed cmux <ver> does not expose <verb>. brew upgrade --cask cmux, or set execution_mode: agent-tool in .claude/dev-team/config.md to use the legacy substrate.` |
| adapter CLI missing | `Roster role <r> needs agent CLI '<cli>', not found on PATH.` |

Carve-outs unaffected: Tier-1 direct handling, `Explore` scouts, workflow mode (ADR-007).

**Workspace ensure** (D5) — first Tier-2/3 engagement: `workspace create --json --id-format uuids`; workspace-group; tier color; phase pill. Tier 1 never reaches this path (§14·4).

**Dispatch** (per role, non-blocking, **wave-scheduled** per D15):

1. Resolve roster; **create worktree if `isolation: "worktree"`** (branch `dt/<task_id>`, recorded in `worktrees.json`); compose the record (absolute paths, UUIDs); write `dispatch/<id>.json`.
2. **Write the placeholder return** (tmp+rename) — lint-invalid by construction; stamps the freshness baseline.
3. `cmux new-pane --workspace <ws-uuid> --type terminal --json --id-format uuids`.
4. Tab title `{icon} {role} · {model}` — same self-identifying string as today's panel prefix.
5. Kickoff: `cmux send --surface <uuid> "exec '<adapter>' run '<record>'\n"` — one line, no payload.
6. `doc_tab: true` → `markdown open … --json` → `move-surface … --focus false` → `reorder-surface --before <terminal-uuid>`.
7. Return `{dispatch_id, uuids, signal_token, timeout_s}`. **The orchestrator is never blocked by a dispatch.**

**Wave rule (D15b).** First pane of a role warms the prefix cache; same-role siblings launch after it begins its first turn (default 5s settle). Cross-role siblings still share the harness+CLAUDE.md prefix. Concurrency cap (~4–6) unchanged.

**Await / join** — `dispatch.mjs await --all <ids…> --max-block-s <N>`, foreground, per §4.3. Outcomes: **fresh valid return** → parsed return printed; orchestrator handles with today's logic. **Attention** (turn-end event or EXIT sentinel, no valid return) → report dispatch + lint failure + gate.mode. **Cap reached** → report remaining; orchestrator re-invokes (the normal long-run path). **Per-dispatch timeout** → triage ladder: `top --format tsv` → `read-screen` (diagnostics only; also the "pending permission prompt" signature, R11) → extend / nudge / `close-surface` + re-dispatch under a **new** id. User-needed → `notify` + `trigger-flash` + `list-notifications`.

**Close** — on valid return: **focus the doc tab; do not close the terminal surface**. Executor panes without a doc tab are closed. Every close re-resolves the UUID first, no-ops loudly if gone.

**Teardown** — at ship, after memory distillation [adopts Q2-7]: enumerate surfaces (`tree --json`) → `close-surface` each → `workspace close` (may no-op while a live agent occupies a pane) → verify with `tree --json` → **then** delete `tasks/<task-slug>/` → remove dispatcher-created worktrees **only if clean and merged, never `--force`**; leftovers kept and reported (pr-review-window.sh precedent). `keep_task_artifacts: true` archives instead.

### 5.6 Worker session shaping (D10) + gate discipline

**Neutralization [R14 fix].** Adapter exports **`DEVTEAM_WORKER=1`** before exec; the SessionStart guard exits early **and emits a one-line `systemMessage`** ("dev-team orchestration suppressed: DEVTEAM_WORKER=1") so an inherited env var is diagnosable. Belt-and-braces: `--disable-slash-commands`. Rejected as before: `--bare`/`--safe-mode` (kill CLAUDE.md, skills, and our worker plugin); `--setting-sources` (doesn't control plugins).

**Accepted fidelity delta [SF-11].** A pane worker inherits CLAUDE.md, project skills, other plugins' hooks, MCP servers — a subagent does not. S14 captures the actual injected context and feeds S15; documented in the reference file; trimming is the first lever if the cost ceiling is missed.

**Gate discipline [PR-5; Q1-1…4].** `return-gate.sh`:
- owns its own bound — `gate/<id>.attempts`, read-increment-write per fire; `stop_hook_active` only as an *additional* early exit (G10);
- caps blocks at **N=2** (roster-overridable, hard ceiling 3). On attempt N+1 it **writes the blocked return itself (tmp+rename), signals, exits 0**;
- **never fails open silently**: no `set -e`; every external call `|| true` with failures to `gate.log`; unconditional final `exit 0` (or deliberate `exit 2`);
- **degrades to observe-only after human interjection** (`gate-mode.sh` on UserPromptSubmit; sticky; surfaced in `status`);
- runs **outside** the tool-permission system — why the gate, not the agent, holds cmux access (state in ADR-003);
- Phase 3 (Q1-9): gate enforces roster `max_turns` — on exceed, `{"continue": false, "stopReason": …}` + blocked return + **still signals**.

### 5.7 Crash recovery (D11) — extended matrix

Invariant: **files are authoritative, panes are disposable.** `status --task <slug>` reconciles task dir + `tree --json` + roster snapshot.

| Situation | Reconciliation |
|---|---|
| Fresh valid return, surface gone | Completed; feed the return. |
| **Fresh valid return, surface still alive** *(new)* | Completed; close/focus per policy; do not re-arm. |
| Surface alive, no valid return | Running; re-arm `await` (rank 0 works even if the token died — S20). |
| Surface gone, no valid return, EXIT sentinel present | Crashed; read the log; offer re-dispatch under a **new** id. |
| Surface gone, no return, no sentinel | Orphaned; report with spec + log; re-dispatch never automatic (git shows partial edits). |
| **Socket unreachable mid-task** *(new)* | Rank 0 continues; `status` reports "cmux unreachable, N dispatches file-tracked"; topology ops no-op loudly. |
| **Return file read mid-write** *(new)* | Impossible by construction: all writers tmp+rename. |
| **Gate in observe mode** *(new)* | Reported by `status`; orchestrator validates the return itself. |
| Whole cmux restarted | Panes gone; files remain; re-dispatch orphans. Provider auto-resume (S21) a bonus, never a dependency. |
| Orchestrator `/clear`ed or lost | `status` + roster snapshot rebuild from disk. **Adapter/role paths re-resolved from the running plugin root at re-dispatch (N-15d).** |

### 5.8 orchestration.md deltas — exact text, +4 lines

§ Reference files: `- references/cmux-dispatch.md — cmux mode is active and you are about to dispatch a role, triage a pane, or tear down at ship.`

§ Roles, appended: `**In cmux mode** the roster (.claude/dev-team/roster.json) supplies each role's agent/model/profile and **overrides these pins for roles the roster marks pane: true**; Explore always stays an Agent-tool scout.`

§ Flow, new bullet: `**Execution substrate:** execution_mode in config.md (cmux | agent-tool). In cmux mode, dispatch every pane: true role via scripts/cmux/dispatch.mjs (read the reference first) — never the Agent tool for those roles — then **join with dispatch.mjs await --all, re-invoking until it reports every dispatch resolved**. Preflight failure is a **hard stop**: print the remediation it gives you and stop; never fall back silently.`

§ Progress signalling, appended: `In cmux mode the same {agent type} ({model}) string is the pane's **tab title** (the dispatcher sets it) — your one-liners are unchanged, and the pane, not the subagent panel, carries the live detail.`

### 5.9 **NEW — Cache discipline (D15)**

1. **Byte-stable system prefix per role**: static role body + static addendum; no ids/timestamps/paths in the system prompt or appended files; variance via env + kickoff only. This is why the worker plugin is **static** (Q1-7 load-bearing, not tidier).
2. **Wave launching** (§5.5).
3. **Measurement with a ceiling** — S15 records `cache_read_input_tokens` for subagent-vs-pane and wave-1-vs-wave-2; §12·9 evaluated with caching in effect.

Test: `test/claude-adapter.test.mjs` asserts two dry-run dispatches differing only in ids/paths produce **byte-identical** prompt-file content.

### 5.10 Gate and ship integration

Three gate invariants intact: inline deterministic validation; git-verified scope (in the coder's worktree when isolated — existing qa-gate rule); risk-sized review bundle. Additive: `cmux diff` (D11); browser-verify evidence (D8). Ship teardown after step 5 (post-PR, post-memory-reconcile). **`config.validate.full` still runs exactly once, at ship, inline.**

---

## 6. ADRs (proposed)

**ADR-001 — Custom cmux adapter, not `cmux claude-teams`.** *accepted.* (Unchanged from v1.)

**ADR-002 — Filesystem data plane; socket control plane only.** *accepted.* (Unchanged; also why §4.6-B was rejected.)

**ADR-003 — Completion is a four-rank ladder; the Stop hook enforces the contract but never owns the signal.** *accepted (ranks 1–3 spike-gated).* **Rewritten.** Rank 0 file watch co-primary; rank 1 `notification.requested` events (native for Claude inside cmux, workspace-scoped ⇒ rescan-all); rank 2 EXIT trap (sentinel + token); rank 3 bounded Stop-gate (≤2 blocks, own counter, observe-mode on interjection, never fail-open, writes the blocked return on exhaustion). Self-signal dropped. *Rationale:* unbounded block loop = financial failure (#55754); interactive TUI never exits; hooks run outside the tool-permission system. *Consequence:* S11/S12 off the critical path.

**ADR-004 — Role-station panes: the return file is the doc tab; UUIDs only; focus, don't close.** *accepted (pending S18).* **Amended.** Doc tab is a *viewing* surface; approval in the orchestrator pane. UUID-only persistence; re-read before acting. Phase-2 default: focus, not close (collapse = S19 polish). tmp+rename always; never rm-then-recreate. Placeholder lint-invalid by construction. Fallbacks: browser tab → split.

**ADR-005 — Security posture: default socket mode, orchestrator-inside-cmux, allowlist-shaped worker profiles, scoped return grant.** *accepted (S9/S10 gating).* **Amended.** `cmuxOnly` stays; `allowAll` banned; `cmux identify` preflight enforces. Worker profiles allowlist-shaped under `dontAsk` (deny beats allow; only non-prompting mode that can't stall). One grant: `Edit(//<task-dir>/returns/**)`. Workers denied `Bash(cmux *)`; no Task tool. Never `--dangerously-skip-permissions` / `bypassPermissions`. *Consequence (resolves the latent ADR-004/005 conflict):* the one file a read-only role may write is exactly the file ADR-004 renders.

**ADR-006 — roster.json committed; tasks/ gitignored via self-contained ignore file.** *accepted.* (Unchanged.)

**ADR-007 — Workflow mode stays on the Agent tool.** *accepted.* (Unchanged.)

**ADR-008 — cmux is an environment prerequisite, not a preference (D14).** *accepted.* **New.** `execution_mode: cmux` ⇒ preflight failure stops the task with precise remediation; no silent degradation. Two values: `cmux` / `agent-tool` (default for anyone without cmux — macOS-only app); onboard sets `cmux` on a working install. The plugin treats cmux like git. *Consequence:* onboard grows a prerequisite check; R7 closed.

**ADR-009 — Pane system prefixes are byte-stable per role (D15).** *accepted.* **New.** Static role file + addendum + worker plugin; per-dispatch variance via env + kickoff only; wave launching. *Consequence:* rejects per-dispatch generated `--settings`; adapter test asserts prompt-file byte-identity.

---

## 7. Execution plan

Review route: qa-lead sizes gates; `code-reviewer-deep` for `dispatch.mjs`; **adversarial panel for slice 1c** [SF-12]. plan-reviewer re-reviews this package before Phase 0.

### Phase 0 — Spike (orchestrator-run, user present) — BLOCKING

No production code. Findings → `tasks/cmux-mode/spike-findings.md`.

| # | Item | Gates | On "no" |
|---|---|---|---|
| S1 | Install; record version vs 0.64.17 | all | — |
| S2 | Verb-surface audit (capabilities/--help/cmux docs vs every design verb) | all | Missing verb ⇒ feature drops to fallback; `events` AND `wait-for` missing ⇒ escalate |
| S3 | Socket modes; orchestrator-inside-cmux reachability | Ph1 | Feeds D14 remediation; escalate |
| S4 | Hook subprocess socket reach under `cmuxOnly` | Ph1 | Gate/adapter signal by file sentinel only; rank 0 carries |
| S5 | `wait-for` latch semantics; token namespace; double-signal | Ph1 | Stat-before-arm + pre-armed waiter; nonce (already designed) |
| S6 | Native `notification.requested` per turn end without hooks setup; cursor durability | Ph1 | Rank 0 tightens to 2s; hooks setup = consented onboard step (§14·5) |
| S7 | `send` newline semantics; kickoff-as-launch-arg | Ph1 | `send-key enter` + settle |
| S8 | **Installed `claude` audit** (flags + argv forms) [PR-7] | Ph1c | Adapter capabilities reports; dispatch refuses (D14 stop) |
| S9 | **Scoped return grant**: `dontAsk` + `Edit(//…/returns/**)` — planner writes only its return? Edit rule covers Write tool? | Ph1c, **Ph2** | Ladder: parallel `Write(…)` rule → relocate returns/ outside repo (D6 deviation) → unscoped Write for judgment roles + git scope check |
| S10 | **Executor stall test** [R11]: `dontAsk` + enumerated Bash rules — non-allowed call returns tool error, not prompt? | Ph1 | Judgment roles lose Bash; stall-triage signature + auto-nudge; escalate before any bypass mode |
| S11 | Static worker plugin via `--plugin-dir`: Stop + UserPromptSubmit delivered? | Ph1c | Try S12; both fail ⇒ drop the gate — ranks 0–2 still work (enforcement + max_turns fidelity lost, documented) |
| S12 | `--settings` as hook source (opportunistic only) | — | Nothing; plugin-dir primary |
| S13 | `DEVTEAM_WORKER=1` suppression + systemMessage | Ph1 | `--disable-slash-commands` + worker line in addendum |
| S14 | Pane injected-context capture [SF-11] | Ph1 | Measurement — feeds S15 + documented delta |
| S15a | Crude cost probe (manual pane vs subagent, cache accounting) | Ph1 profile design | Trim worker context before building |
| S15b | **Full cost + cache measurement** with the real dispatcher; wave-1 vs wave-2 cache ratio; allow-rule variance effect | **Ph2 GO/NO-GO** | Roster `pane:` restriction; context trimming |
| S16 | append vs replace system-prompt fidelity | Ph1c | Replace + explicit harness preamble |
| S17 | Bash-tool block ceiling in the orchestrator session [PR-2] | Ph1 | `await` chunks at 90s |
| S18 | **Markdown as tab** (open→move; live-reload survives move; survives restart) | Ph2 | Browser tab → split (ledger order) |
| S19 | Pane collapse on terminal close | Ph2 *polish* | Default stands: focus, keep terminal |
| S20 | Token + moved-panel durability across cmux restart | Ph3 | Rank 0 is the recovery path; `status` re-arms |
| S21 | `new-surface --provider claude` flag forwarding; resume | Ph1 (§4.2) | Terminal+wrapper baseline (already default) |

**Acceptance:** every item yes/no with exact command + output; every "no" names its fallback. **Gate:** user reviews; contradictions with locked decisions return here.

### Phase 1 — Minimal end-to-end: a coder in a pane

| Slice | Files | Parallel? | Depends on |
|---|---|---|---|
| 1a — contracts | roster schema+default (`coder: pane true` only), dispatch-record schema v2, `test/roster.test.mjs` | first, alone | — |
| 1b — dispatcher | `dispatch.mjs` (preflight+D14 remediation, workspace, dispatch, **worktree lifecycle**, `await --all`, close, status, **manual teardown**), tests + `fake-cmux.mjs` | with 1c, 1d | 1a; S2–S7, S17, S21 |
| 1c — adapter, worker plugin, gate | `claude.sh`, `worker-plugin/**`, `return-gate.sh`, `gate-mode.sh`, `return-lint.mjs`, `prompts/return-contract.*.md`, 4 test files | with 1b, 1d | 1a; S8–S14, S16 · **adversarial panel** |
| 1d — wiring & docs | orchestration.md (+4), hooks.json guard, `references/cmux-dispatch.md`, team.md (`mode` verb) | with 1b, 1c | 1a |

**Acceptance:** tests green with zero live cmux; a real Tier-2 task coder-in-pane → fresh valid return → gate → ship; **preflight failure = exact remediation + zero dispatches** [D14]; killed pane resolves the join within one `await` cycle via the EXIT sentinel; **two overlapping specs in two worktrees without cross-contamination** [PR-3]; **six parallel coder panes with the orchestrator resuming on each return without user input** [PR-2].

### Phase 2 — Leads and the doc-tab UX
Judgment roles flip `pane: true`; markdown returns + heading lint; doc tab open→move→reorder; **focus-the-doc-tab** on return; identity + pills. **Depends on:** Phase 1; **S9**, **S18**, **S15b GO**. One coder.
**Acceptance:** Tier-3 task with live doc tab beside the lead, focused on return; fallback exercised once; a lead demonstrably cannot write anywhere but its return path.

### Phase 3 — Gate, ship, onboard integration
Reviewers/validators `pane: true`; `cmux diff`; ship teardown (§5.5 order); onboard prerequisite check + roster seeding + `tasks/.gitignore` + `execution_mode`; `team roster` verb; ADR-007 clause; gate `max_turns` (Q1-9); `list-notifications` + `--env-file` here or 4a.
**Parallel:** commands coder ‖ dispatcher teardown/status coder. **Depends on:** Phase 2; S20.
**Acceptance:** ship closes surfaces → workspace → verifies → deletes, only post-PR + post-memory-commit; `keep_task_artifacts` archives; unclean worktrees kept + reported; onboard on a fresh project produces a working roster **or** a precise install message; `status` classifies every §5.7 row after a forced crash.

### Phase 4 — UX polish (parallel tracks)
**4a** — notify/flash/jump-to-unread at the four user-blocking moments; set-status/progress/log; stall triage via top; workspace-groups + tier colors; `--env-file`.
**4b** — browser singleton (D8): beside the frontend coder in build; driven by-ref by the validator at gate; `state save/load`; browser-verify evidence.
Both depend on Phase 3. S19-gated: collapse-on-close.

### Phase 5 — Deferred
RECREATION-SPEC section; codex/opencode/pi adapters (**need `cmux hooks setup` — §14·5**); palette actions; status-board sidebar; SSH/VM.

---

## 8. Testing strategy

Seams: `CMUX_BIN` (→ `test/fixtures/fake-cmux.mjs`: JSON-line invocation log, canned **UUIDs**, scripted `wait-for`/`events` via env) · `CLAUDE_BIN` + `DEVTEAM_ADAPTER_DRY_RUN=1` (argv as JSON).

| Test file | Key asserts |
|---|---|
| `test/roster.test.mjs` | schema-valid default; role keys ↔ `agents/*.md`; shared model whitelist; profiles exist; **no profile uses `plan` or blanket Edit/Write deny alongside a scoped grant**; precedence; `pane:` defaults per phase |
| `test/cmux-dispatch.test.mjs` | **exact D14 remediation strings, zero dispatch**; command sequence from the fake log; **only UUIDs persisted**; worktree create/cwd/no-force-remove; freshness (stale + placeholder rejected); `await --all` first-resolution + remaining set; arm-before-kickoff; chunked join under cap; `status` over fixtures covering **every §5.7 row**; teardown ordering |
| `test/claude-adapter.test.mjs` | argv per profile (`--tools` comma, `--allowedTools` space, `dontAsk`, scoped Edit grant, cmux denied, plugin-dir present, **never `--dangerously-skip-permissions`/`bypassPermissions`** — negative test); frontmatter stripped; addendum appended; **prompt-file bytes identical across dispatches (ADR-009)**; missing CLI → blocked return + sentinel; EXIT trap sentinel exactly once |
| `test/return-lint.test.mjs` | JSON mode vs coder schema; markdown heading semantics (prefix, level ≥2, case-fold) incl. the real backend-lead heading; **default placeholder invalid in both modes**; exit codes |
| `test/return-gate.test.mjs` | valid → signal + exit 0; invalid → block with lint failure quoted; **counter bounds at N=2 independent of `stop_hook_active`**; exhaustion writes blocked return + signals + exit 0; observe mode never blocks; external-call failure still exits 0 with gate.log entry |
| `test/orchestration.test.mjs` *(new)* | **orchestration.md ≤ 69 lines** + the four delta strings; **exactly one `references/cmux-*.md`** [§12·10 testable] |
| `test/commands.test.mjs` (extend) | team verbs; ship teardown step position |

**The suite proves the plumbing, the spike proves the platform.**

---

## 9. Disposition of RECREATION-SPEC.md and team-build.workflow.mjs

*(unchanged from v1)* Workflow mode: documented carve-out (ADR-007). RECREATION-SPEC: one "Execution substrate" section via doc-writer at end of Phase 3.

---

## 10. Risks

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Verb-surface drift (public docs don't document the fleet verbs; vendored skills @ 0.64.17 vs uninstalled version) | **High** | S2 audit; capabilities preflight gate; missing verb ⇒ D14 stop with remediation |
| R2 | Hook delivery fails (S11/S12) | Low *(was Med)* | Off the critical path: ranks 0–2 carry liveness; cost = enforcement + max_turns fidelity |
| R3 | `--provider` can't forward flags (S21) | Med | Terminal+wrapper baseline; file-based recovery |
| R4 | `maxTurns` unenforceable interactively | Low | timeout_s + triage; **recovered Phase 3** via gate counter |
| R5 | Interjection races the gate | **Med** *(was Low)* | Sticky observe mode via UserPromptSubmit; bounded blocks; surfaced in `status` |
| R6 | **Positional-ref namespace is a mutable global counter** *(v1 "designed out" was wrong)* | **Med** | UUID-only persistence; re-read before acting; no-op loudly; test asserts no positional ref persisted |
| ~~R7~~ | ~~fallback policy~~ | — | **Closed by D14/ADR-008** |
| R8 | Ship delete destroys logs of a failed-but-shipped dispatch | Low | User decision §14·1 (recommend: always archive on any non-zero dispatch) |
| R9 | Reference sprawl | Low | ONE reference file; asserted by test |
| R10 | **Cost regression** (pane = full session: harness prompt, CLAUDE.md, skills, MCP; 4–6 panes multiply overhead; maxTurns unenforceable) *(v1 "same cost" was wrong)* | **Med** | D15/ADR-009 cache discipline; S14 context delta; **S15b GO/NO-GO with ceiling**; roster `pane:` restriction |
| R11 | **Executor pane stalls silently on a permission prompt** (turn never ends → no Stop → no signal) | **High** | All worker profiles `dontAsk` (auto-deny, never prompt) + enumerated Bash allow rules from `validation_commands`; S10 verifies; stall signature; bypass modes stay banned |
| R12 | Worktree × task-dir path resolution (rules anchor at cwd) | **Med** | Absolute paths everywhere; `//abs` anchors; `--add-dir` mandatory; preflight containment assertion |
| R13 | Read-only roles can't write returns (the v1 hole) | Med | §4.6 scoped grant; S9 gates Phase 2 with a 3-step on-no ladder; gate/adapter still produce a blocked return |
| R14 | `DEVTEAM_WORKER` env inheritance suppresses orchestration in user-opened tabs | Low (debug cost high) | Single marker + systemMessage on every suppression |
| R15 | **Unbounded Stop-hook block loop burns a session** (#54360, #55754) | **Med** | Gate-owned counter file; N=2 hard-capped 3; exhaustion writes blocked return + allows stop |
| R16 | Doc-tab panel bricked by delete-then-recreate | Low | tmp+rename everywhere; never rm; stated + enforced in all three writers |

---

## 11. Open unknowns & assumptions

| # | Assumption | Status |
|---|---|---|
| A1 | Claude CLI flags + argv forms per §5.3 | **Doc-verified only — S8 audits installed binary** |
| A2 | `dontAsk` auto-denies; `plan` blocks edits; deny beats allow; Edit rules cover all editing tools | Doc-verified (G1–G4); behavioral confirmation S9/S10 |
| A3 | Scoped `Edit(//…/returns/**)` lets the Write tool write exactly that path | **Unverified — S9; Phase 2 depends on it** |
| A4 | Stop + UserPromptSubmit delivered via `--plugin-dir` | **Unverified — S11**; failure costs enforcement only |
| A5 | Native `notification.requested` per turn end inside cmux | Vendored-skill-attested (G8) — **S6** |
| A6 | Moved markdown surface still live-reloads | **Unverified — S18** |
| A7 | ~~Pane collapse on terminal close~~ | **No longer load-bearing** (focus-not-close default; S19 polish) |
| A8 | `wait-for -S` latches; tokens don't collide; double-signal no-op | **Unverified — S5**; rank 0 + nonce make failure survivable |
| A9 | `DEVTEAM_WORKER` reaches pane session env | By construction, untested — S13 |
| A10 | `claude "<prompt>"` interactive submits | **Unverified — S7** |
| A11 | Design verbs exist at installed version | **Unverified — R1/S2** |
| A12 | Denying `Bash(cmux *)` breaks nothing | Verified by design (signal moved to gate/adapter, outside the permission system) |
| A13 | worktrunk worktrees as pane cwd | Low risk — Phase 1b acceptance |
| A14 | No version-stable adapter copy needed | **Verified** (architect concurs); re-dispatch re-resolves paths |
| A15 | Pane overhead acceptable under caching | **Unverified — S15a/b, hard ceiling, Phase-2 GO/NO-GO** |
| A16 | Allow-rule variance doesn't perturb the cached prefix | **Unverified — S15b**; on-no: hoist to static per-role set |

**By phase:** Ph1: S1–S8, S10, S11, S13, S14, S15a, S16, S17, S21 · Ph2: S9, S18, S15b · Ph3: S20 · polish: S12, S19.
**Beyond the spike:** per-surface "process exited" event (would retire the EXIT sentinel — check in S2)? Does `list-notifications` carry enough body to triage without `read-screen`?

---

## 12. Acceptance criteria (initiative-level)

1. Tier-2 task end-to-end, coder in a visible pane; fresh schema-valid return; gate + ship identical to today.
2. Tier-3 task with lead + reviewer panes and live doc tabs; package reviewed from the focused rendered document; **no judgment-role session can write any file other than its return path**.
3. `node --test` green with no cmux/model/network — full lifecycle, join loop, every §5.7 row against the fake.
4. **Preflight failure produces the exact remediation message and performs zero dispatches** [D14].
5. Killed pane resolves the join on the **next `await` cycle** (not at timeout_s) with a blocked return + readable log.
6. **Six parallel coder panes complete, orchestrator resuming on each return without user input** [PR-2].
7. **Two overlapping specs in two worktrees**, edits confined, git scope check passing in both [PR-3].
8. `status` reconstructs task state after orchestrator `/clear` and after a cmux restart.
9. **Cost ceiling [PR-8+D15]:** with caching, a pane dispatch's total input cost ≤ **2×** the same spec as a subagent, and a wave-2 same-role sibling shows **≥ 80%** of its system prefix served from cache. Measured by S15b; a miss triggers trimming or roster `pane:` restriction before Phase 2. |
10. **orchestration.md ≤ 8 added lines; exactly one new references/ file — asserted by test** [SF-13].
11. **Single-source role prompts — asserted by test** [SF-13].
12. Worker pane cannot execute any cmux verb; preflight refuses outside cmux; no code path enables `allowAll`/`bypassPermissions`/`--dangerously-skip-permissions` (negative tests).
13. Ship: close surfaces → workspace → verify → delete, only post-PR + post-memory-commit; archives per flag; unclean worktrees kept + reported.

---

## 13. Ledger deviations for ratification

| # | Locked text | Deviation | Why | Phase |
|---|---|---|---|---|
| 1 | **D4** — orchestrator wait-for "as background Bash" | `await --all` foreground, chunked, orchestrator loops | Background Bash ends the turn; nothing resumes the model (PR-2); chunk boundaries = interjection points | 1 |
| 2 | **D7** — "terminal closes on return → pane collapses to the doc" | Default = **focus the doc tab, keep the terminal**; collapse = S19-gated polish | Removes dependency on unverified collapse semantics; preserves the log; user-visible outcome identical | 2 |
| 3 | **D9** — executor denied cmux "EXCEPT wait-for -S" | Carve-out **removed entirely**; signalling moves to gate/adapter (outside the permission system) | Deny beats allow (G3) made it unreliable; self-signal doorbell dropped anyway | 1 |
| 4 | **D9** — read-only via "disallowedTools Edit,Write (or plan-mode)" | **Allowlist-shaped under `dontAsk`** + one scoped `Edit(//…/returns/**)` grant; no `plan` mode | `plan` blocks the return file (G2); a denylist forbids the one required write (G3) | 1–2 |
| 5 | **D5** — "Tier 1: no workspace, no panes" | A delegated Tier-1 coder runs as a **single pane in the orchestrator's existing workspace** (`tier1-<slug>` task dir; no new workspace) | Preserves D3 + D14 without reclassifying tiers; an Agent-tool carve-out would reintroduce the invisible substrate | 3 |
| 6 | **D6** — task dir under `.claude/dev-team/tasks/` | **Contingency only:** if S9 fails outright, `returns/` (or the task dir) relocates outside the repo | Lets a repo-wide Edit deny coexist with the return grant; no change if S9 passes | 2 |

---

## 14. User decisions needed

1. **R8 — failure archiving.** Always archive the task dir when any dispatch ended non-zero, overriding `keep_task_artifacts: false`? **Recommend: yes.**
2. **Lead return contract (SF-14a).** Leads emit a file-backed markdown return with required headings (`Handover Spec`, `Proposed memory deltas`, `Assumptions & unknowns`), structurally linted. Content unchanged; shape now mechanically checked. **Recommend: accept** (spec-lint philosophy at the other end of the pipe; lint = presence, never quality).
3. **Worker signal carve-out removal (SF-14b / §13·3).** **Recommend: accept** — unreliable and now unnecessary.
4. **Tier-1 delegated coder (§13·5).** Single pane in the orchestrator's workspace (recommended) vs Agent-tool carve-out vs no Tier-1 delegation in cmux mode. **Recommend: single pane.**
5. **`cmux hooks setup` disposition (SF-10c).** Plugin does **not** run it: Claude emits natively (G8); running global machine setup on the user's behalf is not the plugin's business. Becomes (a) a consented onboard step if S6 fails, (b) required for non-Claude adapters (Phase 5). **Recommend: accept.**
6. **Spike scheduling.** Phase 0 needs the user at a live GUI — scheduled session, not async. **Confirm the slot.**

**D12 capability disposition (SF-10d):** `config doctor` → Ph1 preflight (failure diagnostics) · `--env-file` → Ph4a (opt-in, never clobber a login) · `list-notifications` → Ph4a (triage) · `move-surface` → Ph2 (doc tab) · **`split-off`/topology repair → dropped**, superseded by UUID persistence + re-read + no-op-loudly.

---

## Recommended team dispatch

- **Research:** none before re-review. Phase 0: one `Explore` scout diffs `cmux --help` + `claude --help` against the design lists (S2+S8).
- **Feasibility consults:** devops-lead (bash/node split, EXIT-trap+sentinel, dispatcher-owned worktree lifecycle vs pr-review-window.sh precedent) · qa-lead (gate invariants under panes; fake-cmux coverage of §5.7; 1c panel sizing) · backend-lead (`await --all` under 6 concurrent dispatches — fairness, starvation, cursor consumption; record v2 adequacy for a codex adapter).
- **Review gate:** plan-reviewer (mandatory re-review of v2) + architect on two points only: (a) §4.6 scoped-write as primary given S9's ladder; (b) rank-0/rank-1 co-primary stability under 6 concurrent panes sharing one workspace-scoped event stream.

## Proposed memory deltas

**→ architecture-notes.md** — ADR-001…009 as in §6 (ADR-003 supersedes v1's "Stop hook primary"; ADR-005 supersedes D9's carve-out + plan-mode phrasing; ADR-008 supersedes v1's R7 auto-fallback; ADR-004/009 amended/new).

**→ conventions.md** — 12 conventions: dispatch only via dispatch.mjs; control vs data plane; adapter contract (capabilities + run, always a return file + one signal); CMUX_BIN/CLAUDE_BIN mockability seams; single-source role prompts (substrate addenda under scripts/, never forks); one reference file per subsystem; persist UUIDs never positional refs; UI-backing files use tmp+rename never delete-recreate; worker profiles allowlist-shaped under a non-prompting mode; hooks own their loop bounds (never rely on stop_hook_active); environment prerequisites fail loudly with remediation (D14); pane system prefixes byte-stable per role (D15).
