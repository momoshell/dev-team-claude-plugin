# Technical Reference Document: cmux Execution Mode for the dev-team plugin

**Status:** As-designed record, decided 2026-08-01 · **Source:** epic #15 comments 3, 6, 8, 9 · **Note:** Superseded in parts — see the Superseded table at the end.

> **Path note (#128, 2026-08-14):** the body below cites the ADR register at
> `.claude/dev-team/memory/architecture-notes.md`. The register now lives at
> [`docs/adr/README.md`](adr/README.md); the old path is left unedited in the
> body, per this repo's own rule that an as-designed record is banner-annotated
> rather than retro-edited.

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

The plugin's execution substrate today is the Agent tool: every lead, coder, reviewer and validator runs as a hidden subagent whose only observable trace is a panel row and a returned blob of text. The user cannot watch, interject, or triage; a stalled agent is indistinguishable from a slow one; and the substrate is welded to one vendor's CLI.

The goal is to swap the substrate — dev-team roles become **visible cmux panes launched by adapter scripts** — while the brain (tiers, Handover Specs, spec-lint, QA-gate ladder, memory protocol, ship semantics) is untouched.

The hard parts, restated after review: (a) an adapter contract that is multi-agent-ready without speculative generality; (b) **a completion path that cannot lie and cannot hang** — which review showed is not one mechanism but a ladder; (c) **a return channel for read-only roles**, which does not exist in a pane and was the single largest hole in v1; (d) landing this inside a plugin whose core prompt is a deliberately-lean 65 lines, at a cost that survives the July-2026 sub-limit discipline.

---

## 2. Artifact decision

| Artifact | Verdict | Why |
|---|---|---|
| **PRD-lite** | **No** | Product behavior fully specified by D1–D15 and user-confirmed. |
| **TRD/RFC** | **Yes** (§5) | The difficulty is implementation architecture: adapter contract, doorbell ladder, permission model, lifecycle, cache discipline. |
| **ADRs** | **Yes — 11** (§6) | v1's 7, of which ADR-003 is rewritten and ADR-004/005 amended, plus ADR-008 (cmux as hard prerequisite, D14), ADR-009 (cache-stable pane prefixes, D15), ADR-010 (structured verdicts, D17), and ADR-011 (shared noise filter, D16). |
| **Execution plan** | **Yes** (§7) | 5 phases + a blocking spike phase, with parallelizable slices. |

Persist the TRD as `docs/trd-cmux-execution-mode.md`; ADRs as entries in `.claude/dev-team/memory/architecture-notes.md`. **Prerequisite (unchanged): `/dev-team:onboard` must run on this repo before Phase 1's memory deltas can land** — `.claude/dev-team/` does not exist yet.

---

## 3. Ground truth & constraints

### 3.1 Verified from the repo (read this session)

| Fact | Location |
|---|---|
| Injection = `SessionStart` hook, pure shell + `jq`, rawfile-inlines `orchestration.md` into `additionalContext` | `hooks/hooks.json` |
| `orchestration.md` is 65 lines, 11 sections; references are read at their trigger, not preloaded | `orchestration.md` |
| Role definitions carry `model`, `effort`, `tools`/`disallowedTools`, `permissionMode` in frontmatter; body is the system prompt | `agents/coder.md` and 13 siblings |
| Coder return contract: `{status, reason, missing_context?, changes[]?, validation?}`, `additionalProperties: false` | `coder-return.schema.json` |
| Two-stage spawn pattern (`open` spawns the window and returns; `run` executes inside it), version-stable copy at `~/.claude/dev-team/bin/`, `trap cleanup EXIT` | `scripts/pr-review-window.sh` |
| Node scripts: zero-dep ESM, header comment with usage + exit codes, `--root` style args, exit 0/1/2 | `scripts/spec-lint.mjs` |
| Tests: `node --test`, zero deps, no network/model; workflow is tested by evaluating its source with injected globals + a mock agent | `test/helpers.mjs` |
| Model alias whitelist enforced in tests: `opus, sonnet, haiku, fable`, or a full `claude-*` id | `test/agents.test.mjs:7` |
| `ship.md` step 5 → step 6 is the natural teardown slot; memory reconcile already precedes the commit at step 3 | `commands/ship.md` |
| `onboard.md` step 5 writes `config.md`; step 4 seeds memory; step 3 already does the "copy launcher to a version-stable path" dance | `commands/onboard.md` |
| The repo has **no** `.claude/dev-team/` directory — project memory is an empty cache | Glob of repo root |

### 3.2 Verified from public docs (fetched this session)

**Claude Code CLI** (`https://code.claude.com/docs/en/cli-reference`) — every slot the adapter needs exists as a flag:

- `--model` (aliases `sonnet|opus|haiku|fable` or full id) · `--effort low|medium|high|xhigh|max|ultracode` — a **1:1 match** with the agent frontmatter fields.
- `--append-system-prompt-file <path>` (append to default) and `--system-prompt-file <path>` (replace) — the role-body slot.
- `--allowedTools` / `--disallowedTools` using permission-rule syntax (`Bash(git log *)`), `--tools` to restrict built-ins.
- `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions|manual`.
- `--settings <file-or-inline-json>` — "Overrides same keys in `settings.json` files for this session."
- `--plugin-dir <dir>` — load a plugin for this session (repeatable).
- `--disable-slash-commands`, `--bare` (skip auto-discovery of hooks/skills/plugins/CLAUDE.md), `--safe-mode` (all customizations off), `--setting-sources user,project,local`.
- `--session-id`, `--name`, `--resume`, `--fork-session`; `--add-dir`.
- **`--max-turns` and `--max-budget-usd` are print-mode only** — the `maxTurns` frontmatter field cannot be enforced in an interactive pane (fidelity gap, §10).

**Claude Code hooks** (`https://code.claude.com/docs/en/hooks`) — `Stop` fires when Claude finishes responding; input includes `stop_hook_active` and `last_assistant_message`; output supports `{"decision":"block","reason":"…"}` to prevent stopping and continue the conversation. Documented hook *sources* are settings files, managed policy, **plugin `hooks/hooks.json`**, and skill/agent frontmatter — the hooks page does **not** list `--settings` as a hook source even though the CLI page documents `--settings` as a general settings override. That gap is spike item S10.

**cmux** — the public docs are **thinner than the vendored skills**: `https://cmux.com/docs/api` documents workspaces, splits, send/send-key, notifications, sidebar metadata, `ping`/`capabilities`/`identify` — and explicitly **does not** document `new-surface`, `new-pane`, `wait-for`, `events`, `read-screen`, or `close-surface`. `https://cmux.com/docs/concepts` documents only *terminal* and *browser* panel types and says nothing about socket control modes. Those verbs are attested only by the vendored skills and the disler repo, validated against **0.64.17**. This is the single largest ground-truth risk in the design (R1).

`https://cmux.com/docs/agent-integrations/claude-code-teams` confirms Option A's rejection rationale on the record: it is a **tmux shim** at `~/.cmuxterm/claude-teams-bin/tmux` that makes Claude Code believe it is inside tmux, gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, Claude-only, translating a *subset* of tmux commands.

### 3.3 Verified from the vendored skills (0.64.17)

- Hierarchy: Window → Workspace → Pane → **Surface (a tab within a pane)** → Panel.
- `cmux markdown open <path>` opens as a **horizontal split to the right of the source surface**; the tab title is the filename; content live-reloads on disk change including atomic replace; **panels are restored across sessions** and re-read from disk.
- **`cmux move-surface --surface <ref> --pane <ref> --focus true`** exists, and — quoting `ai_docs/cmux-skills/cmux/references/panes-surfaces.md:37` — *"Surface identity is stable across move/reorder/split-off operations."* This is the finding that makes D7's preferred mechanism plausible (§4.4).
- `cmux wait-for X --timeout N` blocks; the worker signals with `cmux wait-for -S X`. Events are a **redacting doorbell** — `workspace_id`/`surface_id`/`notification_id` + content *lengths*, with title/body redacted.
- `send` types, does not submit; a trailing `\n` is treated as Enter; **there are no modifier chords** — you cannot Ctrl-C a pane, you `close-surface` it.
- Socket default mode is `cmuxOnly`: an agent driving cmux must itself run inside a cmux terminal. Real socket path `~/.local/state/cmux/cmux.sock`, overridable with `CMUX_SOCKET_PATH`.
- Gotcha the design must honor: **do not `--env-file` a placeholder `ANTHROPIC_API_KEY` over a working Claude login.**

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

1. **Brain unchanged** — no change to tier semantics, spec-lint, the QA-gate ladder, memory protocol, or ship flow. *(Three narrow exceptions, none touching tier semantics, the gate ladder, memory protocol, or ship flow: lead returns become file-backed markdown with required sections; reviewer Verdict sections gain a machine-readable block (D17); and spec-lint gains a WARNING on noise-glob matches in files_in_scope while the QA-gate bundle and cmux diff view are noise-filtered (D16). Lead returns file-backed markdown with required sections — §14·2. Reviewer Verdicts: machine-readable `{verdict, findings[]}` block, shape-validated only. And spec-lint warns on noise-glob matches in files_in_scope while the QA-gate bundle and cmux diff view are noise-filtered. The git scope-compliance check stays unfiltered.)*
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

**Rescan triggers [resolves NEW-2].** (in-process; never end the call; never cost an orchestrator turn): a `notification.requested` event for the workspace · the rank-0 poll tick · an EXIT sentinel appearing. Each trigger re-stats and re-lints every outstanding return and refreshes the per-dispatch quiet timer.

**Resolution reasons** (end `await --all`; each per-dispatch attributable):
1. **`completed:<id>`** — fresh valid return (mtime > record.created_at, lint 0; includes `blocked` returns from agent, gate, or adapter).
2. **`crashed:<id>`** — `logs/<id>.exit` sentinel present AND no fresh valid return.
3. **`attention:<id>`** — **quiet timer**: a workspace turn-end event was observed, this dispatch still has no fresh valid return `quiet_s` later (default 45s), AND `cmux top` shows that pane's process idle. Raised at most once per dispatch per attempt (latched in status.json) until re-armed.
4. **`timeout:<id>`** — now − record.created_at ≥ timeout_s.

**Non-resolution exit:** `still-running` at `--max-block-s`, listing remaining ids; the orchestrator re-invokes.

The `top` idle check is what *attributes* a workspace-scoped event to one pane — without it the outcome must not exist. If `top` is unavailable (S2), the quiet timer is **disabled**, attention comes only from reasons 2 and 4, and that degradation is loud in `status`.

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

### 4.5 Return format — **unchanged: option B**, `return.kind` per role (`json` for coders; `markdown` structurally linted for judgment roles). For reviewer roles with `verdict_block: true`, the markdown Verdict section carries a fenced `{verdict, findings[]}` block, shape-validated only.

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
| `scripts/noise-globs.json` | data file | Shared noise-glob definition (lockfiles, vendored, minified/generated, build output). Read by spec-lint; composed into git pathspec exclusions by gate prose (D16). |
| `roster.schema.json`, `roster.default.json`, `dispatch-record.schema.json` | schema + data | Roster shape, zero-config roster, **adapter interface contract**. |
| `references/cmux-dispatch.md` | markdown | Read at the dispatch trigger: (1) dispatch protocol & policy; (2) distilled verb reference + `cmux docs` fallback. **Exactly one new reference file.** |

**Modified files**

| Path | Change |
|---|---|
| `orchestration.md` | +4 lines (§5.8) |
| `hooks/hooks.json` | SessionStart self-suppression guard on `DEVTEAM_WORKER` + one-line `systemMessage` when suppressing (N-15b, R14) |
| `scripts/spec-lint.mjs` | `warn()` when a files_in_scope entry matches a noise glob (D16) |
| `handover-spec.md` | one guidance line: keep generated/vendored content out of discovery_context (D16) |
| `commands/team.md` | `roster` + `mode` verbs |
| `commands/ship.md` | teardown step between 5 and 6, ordering per §5.5 |
| `commands/onboard.md` | cmux **prerequisite check** with remediation (D14), roster seeding, `tasks/.gitignore`, `execution_mode` |
| `references/qa-gate.md` | `cmux diff` note + browser-verify evidence + D16 noise-filter rows + D17 verdict-enum line |
| `agents/*.md` | **unchanged** — see §4.6 for the honest form of this claim |

**Frontmatter → flag mapping (corrected, G6; B-1 for pane dispatches):** `model`→`--model`, `effort`→`--effort`, **`tools`→`--tools` (comma-separated universe)**, `disallowedTools`→`--disallowedTools` (space-separated rules), `permissionMode`→ overridden by the profile (always `dontAsk` for workers), `maxTurns`→ no interactive CLI equivalent (R4; recoverable via the gate counter in Phase 3). Workers never get the Task/Agent tool.

### 5.2 Data layout

```
<project-root>/.claude/dev-team/
├── config.md                       # + execution_mode: cmux|agent-tool, + keep_task_artifacts:, + noise_globs:
├── roster.json                     # COMMITTED (ADR-006)
├── memory/…                        # unchanged
└── tasks/                          # GITIGNORED via tasks/.gitignore ("*" + "!.gitignore")
    └── <task-slug>/
        ├── preflight.json          # CACHE of the session preflight  [SF-13]
        ├── status.json             # DERIVED, never hand-mutated, atomic tmp+rename
        ├── events.cursor           # cmux events cursor (durable across await invocations)
        ├── await.lock              # PID + started_at; stale = older than 2× max-block-s, breakable with a logged warning
        ├── roster.snapshot.json
        ├── worktrees.json          # {path, branch, dispatch_id, created_at, attempts} — never force-removed  [NEW-4, PR-3]
        ├── specs/<task_id>.json
        ├── dispatch/<dispatch-id>.json          # immutable once written
        ├── returns/<dispatch-id>.{json,md}      # the return; md doubles as the doc tab
        ├── gate/<dispatch-id>.{attempts,mode}   # gate's own bound + enforce|observe  [Q1-1/3]
        └── logs/<dispatch-id>.{log,gate.log,exit}
```

**Concurrency rule (corrected, R6; superseded once more by the v2.1 Final corrections).** Filesystem side already safe (per-dispatch files, derived status.json). The unsafe shared namespace is **cmux's positional refs** — hence UUIDs persisted, positional refs never; re-read before acting. **Single-writer await.lock** (PID + started_at; stale = older than 2× max-block-s, breakable with a logged warning). A second concurrent `await` **refuses and exits 2, naming the holder's PID** — stricter than the earlier rank-0-only-fallback draft (v2.1 §D), which the v2.1 Final corrections block explicitly overrides.

**Worktree × task-dir rule (R12; NEW-4).** Task dir lives under the primary checkout; a coder's pane cwd may be a worktree. Every path in a dispatch record is **absolute**; `--add-dir <abs task-dir>` mandatory; permission rules use the `//abs` anchor (G5); preflight asserts the task dir is not inside any worktree it created. G7 relied on deliberately for D10. **Worktree keyed to task_id**; worktrees.json records one entry with `attempts: [dispatch_ids]`; teardown's "only if clean and merged" evaluates once per worktree at ship; after a *crash* `status` must warn when offering re-dispatch ("worktree has uncommitted changes from attempt N").

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
  "kickoff": "absolute spec path, absolute return path, dispatch id — expanded literals in single-line kickoff",
  "surface": { "workspace_id": "<uuid>", "pane_id": "<uuid>", "surface_id": "<uuid>" },
  "gate": { "max_blocks": 2, "mode": "enforce" },
  "timeout_s": 1800, "created_at": "2026-08-01T12:00:00Z" }
```

**Kickoff form [resolves NEW-3].** The model receives expanded absolute literals in the kickoff (first user message): absolute spec path, absolute return path, dispatch id. The kickoff is per-dispatch by design and sits after the cached prefix — ADR-009 unaffected (it constrains the system prompt, not the first user message).

**Outputs and error behavior** (amended):

1. The return file at `return_path`, fresh (`mtime > created_at`) and valid per `return`.
2. **A sentinel `logs/<id>.exit` written from `trap … EXIT`, plus a best-effort `cmux wait-for -S <token>`** — the sentinel cannot fail if the socket is unreachable from a subprocess (S4).
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

### 5.4 Roster (D2), rewritten profiles [B-1]

**Frontmatter/profile precedence for `pane: true` dispatches.** The resolved profile's `tools` / `allow` / `deny` **replace the role's frontmatter `tools` and `disallowedTools` wholesale — never merge.** From frontmatter a pane dispatch takes **`model` and `effort` only**; `permissionMode` is always the profile's (`dontAsk`); `maxTurns` → roster `max_turns` (Phase 3). Rationale: frontmatter expresses the *Agent-tool* enforcement model (universe + blanket deny); the profile expresses the *pane* model (universe + allowlist under a non-prompting mode). Mixing them produces a session silently unable to return. `agents/*.md` remain unmodified and authoritative for Agent-tool dispatch.

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
                  "tools": ["Read","Glob","Grep","Bash","Write","WebFetch","WebSearch"],
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
                           "doc_tab": true, "timeout_s": 2400, "max_turns": null },
    "code-reviewer":     { "pane": false, "model": "sonnet", "profile": "reviewer",
                           "return": { "kind": "markdown",
                                       "required_sections": ["Verdict","Must-fix","Notes"],
                                       "verdict_block": true },
                           "doc_tab": true, "max_turns": null }
  } }
```

- **`pane:` per role [SF-9]** — Phase 1 ships `coder: true` only; Phase 2 flips leads; Phase 3 flips reviewers/validators. Also the lever if S15 shows pane overhead is material for a role class (R10).
- **`max_turns` reserved now [NEW-6, Q1-9]:** defaults + role schema accept optional `max_turns` (int ≥ 1). Unused until Phase 3 (gate counter enforces). Slice 1a freezes a schema that never changes in Phase 3.
- **`verdict_block` field [D17]:** true on gate-participating reviewer roles only: `code-reviewer`, `code-reviewer-deep`, `build-validator`. Field reserved in roster.schema.json v2 now. Scoping choice: `plan-reviewer`/`trd-reviewer` keep prose verdicts — their output feeds human approval, not a mechanical ladder.
- `${RETURNS_GLOB}`/`${CWD_GLOB}` expand to `//abs` forms at dispatch time. `${SPEC_VALIDATION_COMMANDS}` expands the spec's `validation_commands` into `Bash(<cmd> *)` allow rules — the answer to "enumerate Bash rules exhaustively" (R11). S15 records whether per-dispatch allow-rule variance perturbs the cached prefix; if so, hoist to a static per-role set.
- **Resolution precedence** (unchanged): frontmatter → plugin default → global → project → session override.
- **Preflight validation** (unchanged) — plus: under D14 an invalid *roster file* is a hard stop.
- **Return-lint heading semantics [SF-13]:** a `required_sections` entry matches a markdown heading of level ≥ 2 whose text, case-folded, **starts with** the required string (so `"Handover Spec"` matches `### Handover Spec (one per coder task)`). `"Proposed memory deltas"` **is required** for lead roles (may say "none"). For `verdict_block: true`, the markdown Verdict section carries a fenced ```json block with `{ "verdict": "pass | changes-needed | inconclusive", "findings": [ { "severity": "critical | warning | suggestion", "file": "<path>", "line": 123|null, "summary": "<one line>" } ] }`. Presence, parseability, enum membership only — never quality. Linting stays weak: presence, not quality.

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

**Cursor ownership [D judgment 3(b)].** Events child writes to a spool; `events.cursor` advances from the spool only when `await` exits through a resolution or the chunk cap. Crash/kill/lock-break leaves the cursor — replay-safe, since events only trigger idempotent rescans. On every exit path, kill the `cmux events --reconnect` child. **Timeout is wall-clock from `record.created_at`, evaluated on every rescan** — per-invocation measurement would be dead code under chunking. Between invocations no consumer is attached (gap-window fallback spiked at S6 extended).

**Close** — on valid return: **select the doc tab within its own pane with `cmux focus-panel --panel <md-surface-uuid>`** — changing the active surface inside that pane only. **Never** `focus-pane`, `select-workspace`, or any window/pane-level focus. If S18 shows `focus-panel` is pane-level in practice, degrade to **do nothing** — the doc tab is already the sibling tab, the user selects it. Don't close the terminal surface. Executor panes without a doc tab are closed. Every close re-resolves the UUID first, no-ops loudly if gone.

**Teardown** — at ship, after memory distillation [adopts Q2-7]: enumerate surfaces (`tree --json`) → `close-surface` each → `workspace close` (may no-op while a live agent occupies a pane) → verify with `tree --json` → **then** delete `tasks/<task-slug>/` → remove dispatcher-created worktrees **only if clean and merged, never `--force`**; leftovers kept and reported (pr-review-window.sh precedent). `keep_task_artifacts: true` archives instead.

### 5.6 Worker session shaping (D10) + gate discipline

**Neutralization [R14 fix; N-15b].** Adapter exports **`DEVTEAM_WORKER=1`** before exec; the SessionStart guard exits early **and emits a one-line `systemMessage`** ("dev-team orchestration suppressed: DEVTEAM_WORKER=1") so an inherited env var is diagnosable. Belt-and-braces: `--disable-slash-commands`. Rejected as before: `--bare`/`--safe-mode` (kill CLAUDE.md, skills, and our worker plugin); `--setting-sources` (doesn't control plugins).

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

§ Roles, appended: `**In cmux mode** the roster (.claude/dev-team/roster.json) supplies each role's agent/model/profile and **overrides these pins for roles the roster marks pane: true**; Explore always stays an Agent-tool scout. For `pane: true` dispatches, the profile's tools and rules REPLACE the frontmatter's — never merge — taking only model and effort from frontmatter.`

§ Flow, new bullet: `**Execution substrate:** execution_mode in config.md (cmux | agent-tool). In cmux mode, dispatch every pane: true role via scripts/cmux/dispatch.mjs (read the reference first) — never the Agent tool for those roles — then **join with dispatch.mjs await --all, re-invoking until it reports every dispatch resolved**. Preflight failure is a **hard stop**: print the remediation it gives you and stop; never fall back silently.`

§ Progress signalling, appended: `In cmux mode the same {agent type} ({model}) string is the pane's **tab title** (the dispatcher sets it) — your one-liners are unchanged, and the pane, not the subagent panel, carries the live detail.`

### 5.9 **NEW — Cache discipline (D15)**

1. **Byte-stable system prefix per role**: static role body + static addendum; no ids/timestamps/paths in the system prompt or appended files; variance via env + kickoff only. This is why the worker plugin is **static** (Q1-7 load-bearing, not tidier).
2. **Wave launching** (§5.5).
3. **Measurement with a ceiling** — S15 records `cache_read_input_tokens` for subagent-vs-pane and wave-1-vs-wave-2; §12·9 evaluated with caching in effect.

Test: `test/claude-adapter.test.mjs` asserts two dry-run dispatches differing only in ids/paths produce **byte-identical** prompt-file content, with **kickoff strings differing** and each containing its own absolute return path.

### 5.10 Gate and ship integration

Three gate invariants intact: inline deterministic validation; git-verified scope (in the coder's worktree when isolated — existing qa-gate rule); risk-sized review bundle. Additive: `cmux diff`; browser-verify evidence (D8). **Reviewer bundle and `cmux diff` view are noise-filtered (D16); the git scope-compliance check is explicitly unfiltered.** Ship teardown after step 5 (post-PR, post-memory-reconcile). **`config.validate.full` still runs exactly once, at ship, inline.**

---

## 6. ADRs (reference index)

See `.claude/dev-team/memory/architecture-notes.md` for full entries:

- **ADR-001** Custom cmux adapter; `cmux claude-teams` rejected
- **ADR-002** Filesystem = data plane; socket = control/signaling only
- **ADR-003** Completion = four-rank ladder; events trigger rescans only; agent self-signal dropped
- **ADR-004** Role-station panes: return file IS the doc tab; UUIDs only; focus-don't-close
- **ADR-005** Security: dontAsk profiles under allowlist, profile REPLACES frontmatter for pane dispatches
- **ADR-006** roster.json committed; tasks/ gitignored; additive optional fields don't bump version
- **ADR-007** Workflow mode stays on Workflow tool's agent() dispatch
- **ADR-008** cmux is an environment prerequisite; preflight failure = hard stop + remediation
- **ADR-009** Pane system prefixes byte-stable per role; per-dispatch payload in first user message
- **ADR-010** Machine-readable verdicts at both ends; reviewer blocks carry fenced `{verdict, findings[]}`, shape-validated
- **ADR-011** One shared noise-glob definition, applied at read points only

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
| S6 | Native `notification.requested` per turn end without hooks setup; cursor durability; gap-window fallback | Ph1 | Rank 0 tightens to 2s; hooks setup = consented onboard step (§14·5); If no event delivered on cursor re-attach, tighten accordingly |
| S7 | `send` newline semantics; kickoff-as-launch-arg | Ph1 | `send-key enter` + settle |
| S8 | **Installed `claude` audit** (flags + argv forms) [PR-7] | Ph1c | Adapter capabilities reports; dispatch refuses (D14 stop) |
| S9 | **Scoped return grant**: `dontAsk` + `Edit(//…/returns/**)` — planner writes only its return? Edit rule covers Write tool? | Ph1c, **Ph2** | Ladder: **rung 1** widen to `Edit(//abs/task-dir/**)` → **rung 2** settings source inside task dir → **rung 3** relocate returns/ outside repo (D6 deviation) → **rung 4 (terminal, user decision §14·7)** unscoped Write for judgment roles + post-return `git status --porcelain` detection. Take rung 4 only if rungs 1–3 fail |
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
| 1d — wiring & docs | orchestration.md (+4), hooks.json guard, `references/cmux-dispatch.md`, team.md (`mode` verb), noise-globs.json, spec-lint noise warn | with 1b, 1c | 1a |

**Acceptance:** tests green with zero live cmux; a real Tier-2 task coder-in-pane → fresh valid return → gate → ship; **preflight failure = exact remediation + zero dispatches** [D14]; killed pane resolves the join within one `await` cycle via the EXIT sentinel; **two overlapping specs in two worktrees without cross-contamination** [PR-3]; **six parallel coder panes with the orchestrator resuming on each return without user input** [PR-2].

### Phase 2 — Leads and the doc-tab UX
Judgment roles flip `pane: true`; markdown returns + heading lint + verdict-block linting; doc tab open→move→reorder; **focus the doc tab within its own pane** on return; identity + pills. **Depends on:** Phase 1; **S9**, **S18**, **S15b GO**. One coder.
**Acceptance:** Tier-3 task with live doc tab beside the lead, focused on return; fallback exercised once; a lead demonstrably cannot write anywhere but its return path; a gate run bounces on a critical-bearing verdict block and passes-with-notes on a suggestions-only block.

### Phase 3 — Gate, ship, onboard integration

Reviewers/validators `pane: true`; `cmux diff`; ship teardown (§5.5 order); onboard prerequisite check + roster seeding + `tasks/.gitignore` + `execution_mode` + noise-globs seed; `team roster` verb; ADR-007 clause; gate `max_turns` (Q1-9); `list-notifications` + `--env-file` here or 4a. Parallel: commands coder ‖ dispatcher teardown/status coder. **Depends on:** Phase 2; S20.
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
| `test/roster.test.mjs` | schema-valid default; role keys ↔ `agents/*.md`; shared model whitelist; profiles exist; **for every `pane: true` role: no bare Edit/Write/NotebookEdit deny token in `--disallowedTools`; `--tools` equals resolved profile exactly; no frontmatter deny strings reach argv; scoped grant present**; precedence; `pane:` defaults per phase; `max_turns` and `verdict_block` fields reserved |
| `test/cmux-dispatch.test.mjs` | **exact D14 remediation strings, zero dispatch**; command sequence from the fake log; **only UUIDs persisted**; worktree create/cwd/no-force-remove/reuse on re-dispatch; freshness (stale + placeholder rejected); `await --all` first-resolution + remaining set; arm-before-kickoff; chunked join under cap; `status` over fixtures covering **every §5.7 row**; teardown ordering; **await.lock single-writer + exit 2 refuse naming holder PID** |
| `test/claude-adapter.test.mjs` | argv per profile (`--tools` comma, `--allowedTools` space, `dontAsk`, scoped Edit grant, cmux denied, plugin-dir present, **never `--dangerously-skip-permissions`/`bypassPermissions`**); frontmatter stripped; addendum appended; **prompt-file bytes identical across dispatches (ADR-009); kickoff strings differ, each contains absolute return path**; missing CLI → blocked return + sentinel; EXIT trap sentinel exactly once |
| `test/return-lint.test.mjs` | JSON mode vs coder schema; markdown heading semantics (prefix, level ≥2, case-fold) incl. real backend-lead heading; **default placeholder invalid**; **for verdict_block roles: valid block passes, missing block fails, out-of-enum verdict/severity fails; for non-verdict_block roles unaffected**; exit codes |
| `test/return-gate.test.mjs` | valid → signal + exit 0; invalid → block with lint failure quoted; **counter bounds at N=2 independent of `stop_hook_active`**; exhaustion writes blocked return + signals + exit 0; observe mode never blocks; external-call failure still exits 0 with gate.log entry |
| `test/orchestration.test.mjs` *(new)* | **orchestration.md ≤ 69 lines** + the four delta strings; **exactly one `references/cmux-*.md`** [§12·10 testable] |
| `test/spec-lint.test.mjs` *(extend)* | noise match in files_in_scope → WARN + exit 0; non-noise → neither; per-project globs extend defaults; suppression asserted where it bites |
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
| R17 | **Filtered-away signal** — a reviewer passes a diff it never saw (D16) | **Med** | Filter only at read points; files_in_scope suppression; bundle header names filtered paths + count |

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
2. Tier-3 task with lead + reviewer panes and live doc tabs; package reviewed from the focused rendered document; **no judgment-role session can write any file other than its return path** (unless §14·7 rung 4 taken — then detected post-return).
3. `node --test` green with no cmux/model/network — full lifecycle, join loop, every §5.7 row against the fake.
4. **Preflight failure produces the exact remediation message and performs zero dispatches** [D14].
5. Killed pane resolves the join on the **next `await` cycle** (not at timeout_s) with a blocked return + readable log.
6. **Six parallel coder panes complete, orchestrator resuming on each return without user input** [PR-2]. Invocation count: ≤ (dispatches) + (elapsed ÷ max-block-s) + 2.
7. **Two overlapping specs in two worktrees**, edits confined, git scope check passing in both [PR-3].
8. `status` reconstructs task state after orchestrator `/clear` and after a cmux restart.
9. **Cost ceiling [PR-8+D15]:** with caching, a pane dispatch's total input cost ≤ **2×** the same spec as a subagent, and a wave-2 same-role sibling shows **≥ 80%** of its system prefix served from cache. Measured by S15b; a miss triggers trimming or roster `pane:` restriction before Phase 2.
10. **orchestration.md ≤ 8 added lines; exactly one new `references/cmux-*.md` exists** — asserted by test.
11. **Single-source role prompts** — asserted by test.
12. Worker pane cannot execute any cmux verb; preflight refuses outside cmux; no code path enables `allowAll`/`bypassPermissions`/`--dangerously-skip-permissions` (negative tests).
13. Ship: close surfaces → workspace → verify → delete, only post-PR + post-memory-commit; archives per flag; unclean worktrees kept + reported.
13a. **(D16) Lockfile-containing diff** → bundle excludes it + gate report names it as filtered; **dependency-bump task naming lockfile in files_in_scope** → bundle includes it; both cases: git scope check sees the unfiltered list.
13b. **(D17) A reviewer dispatch with missing/out-of-enum Verdict block fails return-lint** and is bounced before the gate branches; **a valid block drives the ladder by enum** (`critical` → bounce, `warning` → task summary, `suggestion` → pass-with-notes) **with no prose interpretation.**
14. **(D16) Noise-glob definition** applied at reviewer bundle, cmux diff view, handover guidance; never at git scope check; never to files_in_scope path; filtered bundle header names what was excluded.
15. **(D17) Verdicts** drive control flow via enum with no prose reading; prose quality is never linted; a gate run with a critical-bearing block bounces; a suggestions-only block passes-with-notes.

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
| 7 | **§14·8 — NEW** | Cost ceiling miss at Phase-2 GO/NO-GO: restrict role classes to Agent-tool via `pane: false` — explicit D3 deviation | User decision; per-role breakdown; leads stay pane, low-value roles only if miss > ~3× | Ph2 GO/NO-GO |

---

## 14. User decisions needed

1. **R8 — failure archiving.** Always archive the task dir when any dispatch ended non-zero, overriding `keep_task_artifacts: false`? **Recommend: yes.**
2. **Output-contract tightening (carries D17 now).** Lead returns: required sections. Reviewer Verdicts: machine-readable `{verdict, findings[]}` block, shape-validated only. **Recommend: accept.**
3. **Worker signal carve-out removal (§13·3).** **Recommend: accept** — unreliable and now unnecessary.
4. **Tier-1 delegated coder (§13·5).** Single pane in orchestrator's workspace (recommended) vs Agent-tool carve-out vs no Tier-1 delegation in cmux mode. **Recommend: single pane.**
5. **`cmux hooks setup` disposition (SF-10c).** Plugin does **not** run it: Claude emits natively (G8); running global machine setup on the user's behalf is not the plugin's business. Becomes (a) a consented onboard step if S6 fails, (b) required for non-Claude adapters (Phase 5). **Recommend: accept.**
6. **Spike scheduling.** Phase 0 needs the user at a live GUI — scheduled session, not async. **Confirm the slot.**
7. **NEW — S9 terminal rung (conditional; only if rungs 1–3 all fail).** Unscoped Write for judgment roles + post-return `git status --porcelain` detection. Voids §12·2 + Phase-2 clause; scope check doesn't cover leads/reviewers. **Recommend: stop and escalate.** If S9's rungs 1–3 all fail, the lead now recommends stopping and re-designing the judgment-role return channel rather than accepting unscoped Write + detection. Rationale: three independent scoping layers failing is a platform finding worth pausing on, not a licence to widen. (Unscoped-Write-with-detection remains the documented alternative should the user choose it.)
8. **NEW — Cost-ceiling miss (conditional; Phase-2 GO/NO-GO).** (a) accept measured cost, no deviation; or (b) restrict role classes to Agent-tool via `pane: false` — explicit D3 deviation (§13·7, ratification). **Recommend: per-role breakdown to the user; prior = (a) for leads** (few dispatches, high value, visibility is the initiative's core promise), **(b) only for high-fan-out low-value roles if the miss exceeds ~3×.** Never the measuring coder's call.

**D12 capability disposition (SF-10d):** `config doctor` → Ph1 preflight (failure diagnostics) · `--env-file` → Ph4a (opt-in, never clobber a login) · `list-notifications` → Ph4a (triage) · `move-surface` → Ph2 (doc tab) · **`split-off`/topology repair → dropped**, superseded by UUID persistence + re-read + no-op-loudly.

---

## Recommended team dispatch

- **Research:** none before re-review. Phase 0: one `Explore` scout diffs `cmux --help` + `claude --help` against the design lists (S2+S8).
- **Feasibility consults:** devops-lead (bash/node split, EXIT-trap+sentinel, dispatcher-owned worktree lifecycle vs pr-review-window.sh precedent) · qa-lead (gate invariants under panes; fake-cmux coverage of §5.7; 1c panel sizing) · backend-lead (`await --all` under 6 concurrent dispatches — fairness, starvation, cursor consumption; record v2 adequacy for a codex adapter).
- **Review gate:** plan-reviewer (mandatory re-review of v2) + architect on two points only: (a) §4.6 scoped-write as primary given S9's ladder; (b) rank-0/rank-1 co-primary stability under 6 concurrent panes sharing one workspace-scoped event stream.

## Proposed memory deltas

**→ architecture-notes.md** — ADR-001…011 as named in §6 (ADR-003 supersedes v1's "Stop hook primary"; ADR-005 supersedes D9's carve-out + plan-mode phrasing; ADR-008 supersedes v1's R7 auto-fallback; ADR-004/009/010/011 amended/new).

**→ conventions.md** — 15 conventions: (1) dispatch only via dispatch.mjs · (2) control vs data plane · (3) adapter contract (capabilities + run, always a return file + one signal) · (4) CMUX_BIN/CLAUDE_BIN mockability seams · (5) single-source role prompts (substrate addenda under scripts/, never forks) · (6) one reference file per subsystem · (7) persist UUIDs never positional refs · (8) UI-backing files tmp+rename never delete-recreate · (9) worker profiles allowlist-shaped under a non-prompting mode · (10) hooks own their loop bounds (never rely on stop_hook_active) · (11) environment prerequisites fail loudly with remediation (D14) · (12) pane system prefixes byte-stable per role (D15); per-dispatch payload via expanded literals in the first user message; env vars serve shell-side consumers only · (13) enforcement models don't merge — profile REPLACES frontmatter for pane dispatch · (14) a doorbell that can't name the sleeper only wakes; it never decides — events trigger rescans; resolutions are per-target attributable · (15) filters apply to what agents read, never to what checks verify.

---

## Superseded since ratification

| TRD passage | Superseded by | Recorded in architecture-notes.md |
|---|---|---|
| §5.2's task dir at `<project-root>/.claude/dev-team/tasks/` and the tasks/.gitignore step | ADR-006 Amendment 1: artifacts relocate to `~/.dev-team/tasks/<repo-slug>/<task-slug>/` with parent-side state at `~/.dev-team/state/<repo-slug>/<task-slug>/`, because .claude/** hard-denies dontAsk worker writes even with an exact-match allow rule; the .gitignore step is unreachable and was dropped. | 2026-08-01 (line 10), 2026-08-02 siting rule + Rider D (line 25), 2026-08-04 (line 37) |
| §5.3's signal_token in the record and in env | ADR-003 Amendment 1: an unguessable per-dispatch nonce delivered by a mode-0600 file the adapter reads and unlinks before spawn, never in env/argv/kickoff/record; completion is re-derived from the ladder on every wake. | 2026-08-01 (line 11), Rider E 2026-08-02 (line 28) |
| §4.3 rank-1's streaming `cmux events --reconnect` child + spool + cursor (and §D's cursor-ownership rules) | parent-side await is poll-first with one bounded `events --after <seq> --limit N --no-ack --no-heartbeat` catch-up per invocation; event ids are boot-scoped so a persisted cursor does not survive a restart. | 2026-08-02 (line 24) |
| §5.4's planner/executor/reviewer profiles with per-profile tools and deny keys | ADR-013: exactly three profiles (executor, validator, judgment) generated by one-profile-per-distinct-grant-token-set; allow lists are enum capability tokens, never rule strings; no deny key, no per-profile tools (hoisted to one top-level roster field); permission_mode enum-closed to dontAsk. | 2026-08-01 (line 18) |
| §B-1's 'reviewer web tools: KEEP' and per-role --tools variation | ADR-005 Amendment 1: --tools is identical across ALL worker roles (Read,Edit,Write,Glob,Grep,Bash) and profiles differ only in --allowedTools; the named accepted consequence is that judgment roles LOSE WebFetch/WebSearch in pane mode. This directly reverses §B-1's second-order decision — flag it as such. | 2026-08-01 (line 12), shipped at #6 (line 39) |
| §F NEW-4's worktree keyed to task_id | worktrees are keyed to slice_id and sited outside every checkout at `<task_artifacts_root>/worktrees/<repo-slug>/<task-slug>/<slice_id>`, branch dt/<task-slug>/<slice_id>, reused across attempts. | 2026-08-01 (line 20) |
| §E's 'max_turns reserved now, gate counter enforces in Phase 3' | ADR-017: cmux pane mode has no turn budget by mechanism; max_turns stays schema-present but inert by refusal and the --max-turns emission was deleted; the runaway bound is wall-clock timeout_s. | 2026-08-04 (line 42) |
| §5.3's return file as the raw return document and ADR-004's 'the return file IS the doc tab' | return files are ENVELOPES ({schema_version,dispatch_id,slice_id,attempt,role,produced_at,body}) validated in two steps, and the PARENT renders returns/<stem>.md after validation and mounts the doc tab on that render, covered by no worker grant. | 2026-08-01 (line 19), 2026-08-03 parent-render (line 35) |
| §4.3's rank-3 framing of hooks as the enforcement layer | ADR-012: CLI permission rules are the PRIMARY enforcement layer and hooks enforce only the invariants rules cannot express; no PreToolUse hook on file tools in the default profile. | 2026-08-01 (line 13) |
| §Q1, §G8, §4.3 rank-1, and §S6/A5's `notification.requested` turn-end passages (lines 38, 132, 162, 171, 523, 630) | Live-verified against cmux 0.64.22: the turn-end event is `agent.hook.Stop`, carrying a top-level UUID `surface_id` (duplicated at `payload.surface_id`); `notification.requested` is a narrower event reserved for explicit `cmux notify` calls, not a native per-turn-end signal. | 2026-08-05 be-11-01 (ADR-003 Amended-by) |
