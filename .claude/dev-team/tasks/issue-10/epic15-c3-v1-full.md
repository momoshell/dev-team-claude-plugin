# Architecture Package — cmux Execution Mode for the dev-team plugin

**Author:** architecture-lead · **Date:** 2026-07-31 · **Repo:** `/Users/x/Development/dev-team-claude-plugin` @ v0.1.43
**Authoritative input:** the 13 locked decisions (D1–D13) in the design ledger. Nothing below re-litigates them; three places where reality may push back are filed as risks with recommendations (R1, R7, R8).

---

## 1. Problem & goal

The plugin's execution substrate today is the Agent tool: every lead, coder, reviewer and validator runs as a hidden subagent whose only observable trace is a panel row and a returned blob of text. The user cannot watch, interject, or triage; a stalled agent is indistinguishable from a slow one; and the substrate is welded to one vendor's CLI.

The goal is to swap the substrate — dev-team roles become **visible cmux panes launched by adapter scripts** — while the brain (tiers, Handover Specs, spec-lint, QA-gate ladder, memory protocol, ship semantics) is untouched. Success looks like: the same `/dev-team:team` flow, the same specs, the same gate, but every agent is a terminal you can see, read, and type into, with the roster deciding which CLI and model each role uses.

The hard parts are three: (a) an adapter contract that is genuinely multi-agent-ready without speculative generality; (b) a **completion signal that cannot lie** — the ledger's socket-is-control/files-are-data split means the orchestrator must know when a pane's work is real and finished; (c) landing this inside a plugin whose core prompt is a deliberately-lean 65 lines.

---

## 2. Artifact decision

| Artifact | Verdict | Why |
|---|---|---|
| **PRD-lite** | **No** | Product behavior is fully specified by D1–D13 and confirmed by the user. Writing one would be transcription, not clarification. |
| **TRD/RFC** | **Yes** (§5, this document, persisted by `dev-team:doc-writer`) | The whole difficulty is implementation architecture: adapter contract, doorbell mechanism, lifecycle, config precedence, degradation. |
| **ADRs** | **Yes — 7** (§6) | Substrate choice, plane split, doorbell, doc-tab mechanism, security posture, artifact/gitignore convention, workflow-mode carve-out. All durable and all likely to be re-questioned in six months. |
| **Execution plan** | **Yes** (§7) | 5 phases, spike-first, with parallelizable slices. |

Persist the TRD as `docs/trd-cmux-execution-mode.md` (or the project's chosen docs path) and the ADRs as entries in `.claude/dev-team/memory/architecture-notes.md`. The `.claude/dev-team/` tree does not exist in this repo yet — **`/dev-team:onboard` must be run on this repo before Phase 1's memory deltas can land**; that is a prerequisite, not a phase.

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

### 3.4 Binding constraints

1. **Brain unchanged** — no change to tier semantics, spec-lint, the QA-gate ladder, memory protocol, or ship flow.
2. **Lean core** — `orchestration.md` grows by ≤ 8 lines; all cmux mechanics live in one on-trigger reference (D13's "ONE page").
3. **Cost discipline** — spawn-on-demand only; no standing fleets; idle finished panes must burn nothing.
4. **Every new script gets `test/<name>.test.mjs` runnable with no model, no network, and no GUI.**
5. **Version bump every commit**; commit style `feat:|fix:|refactor: <summary — em-dash detail>; bump 0.1.NN`.

---

## 4. Options & recommendations

Five real forks. D1–D13 settle the rest.

### 4.1 Dispatch logic: orchestrator-composed cmux commands vs. a dispatcher script

- **A — Prose protocol.** `references/cmux-dispatch.md` teaches the orchestrator the verb sequences; it composes `cmux` calls itself. Optimizes: zero new code, maximum flexibility. Sacrifices: determinism (ref capture, JSON threading, cleanup on every path), testability (nothing to unit-test), and token cost on every dispatch.
- **B — `scripts/cmux/dispatch.mjs` with verbs.** The orchestrator calls `dispatch.mjs dispatch --role coder --spec …`. Optimizes: determinism, testability against a fake `cmux`, a stable seam for adapters, tiny reference file. Sacrifices: a new ~400-line script to maintain; less improvisation when cmux behaves oddly.

**Recommendation: B.** This is precisely the split the plugin already makes — mechanical work goes in a script (`spec-lint.mjs`, `task-cost.mjs`), judgment stays in prose. Dispatch is mechanical and failure-prone; and B is the only option that satisfies constraint 4. The reference file then documents *verbs and policy*, not cmux syntax, which also serves D13.

### 4.2 Pane creation: provider agent-surface vs. terminal surface + wrapper

- **A — `cmux new-surface --type agent-session --provider claude`.** Optimizes: native session capture, `autoResumeAgentSessions`, crash-proof resume (D11). Sacrifices: unknown whether arbitrary `claude` flags (model, effort, system-prompt-file, permission profile) can be passed through — if they can't, the entire roster/profile mechanism dies with it.
- **B — `cmux new-pane --type terminal` + `send` a one-line `exec <adapter> run <record>`.** Optimizes: total control of argv; uses only verbs proven in the README's live-validated loop; identical in shape to `pr-review-window.sh`'s stage-1/stage-2 pattern. Sacrifices: cmux may not recognize the pane as an agent session, so native resume is lost.

**Recommendation: B as the baseline, A as a spike-gated upgrade.** Build the adapter so that pane creation is a single function with two implementations; the spike (S4) decides which one Phase 1 ships. Losing native resume costs little because this design's recovery story is *files are authoritative, panes are disposable* (§5.7) — resume is a nicety, flag control is existential. If S4 shows `--provider` forwards extra args (the `claude-teams` docs say that command forwards `--model sonnet`, which is suggestive but not the same verb), switch to A and gain resume for free.

### 4.3 The doorbell: who signals completion, and when

This is the design's crux. The ledger fixes *what* signals (`cmux wait-for -S <token>`) but not *who*.

- **A — The agent signals itself.** The role prompt tells it to run `cmux wait-for -S <token>` last; D9's permission carve-out allows exactly that one command. Optimizes: simplicity. Sacrifices: correctness — it depends on the model remembering, and on a "deny `Bash(cmux *)` except one" permission rule whose reliability is doubtful (deny rules take precedence over allow rules in Claude Code, so the carve-out may simply lose).
- **B — The adapter signals on process exit** (`trap … EXIT`). Optimizes: unconditional liveness — a crashed agent still rings the bell. Sacrifices: an *interactive* TUI doesn't exit when the work is done, so this alone would never fire during normal operation.
- **C — A `Stop` hook signals, gated on a valid return file.** A tiny script runs on every Stop: if the return file exists and passes `return-lint`, `cmux wait-for -S <token>` and exit 0; if not, emit `{"decision":"block","reason":"<the lint failure>"}` so the agent cannot end its turn without producing a contract-valid return. Optimizes: the return contract becomes *mechanically enforced* rather than prompt-enforced — the same philosophy as spec-lint, applied to the other end of the pipe; and the worker needs no `cmux` access at all, so `Bash(cmux *)` can be denied outright. Sacrifices: depends on hook delivery into a per-dispatch session (S10) and needs `stop_hook_active` bounding to avoid a block loop.

**Recommendation: C as the primary, B always on as the liveness backstop, A as the S10 fallback.** C+B together give the property that matters: **the orchestrator's `wait-for` always unblocks — either because the work is valid, or because the process died.** It can never hang on a silent agent. Double-signalling is harmless (the token fires once). Correctness never rests on the doorbell alone: **the doorbell is the event, the return file is the truth** — on unblock the orchestrator re-validates the file independently, and if it is absent it re-arms the wait a bounded number of times before triaging.

### 4.4 The doc tab (D7): how a document becomes a sibling tab

The ledger's mechanism 1 is unverified because `cmux markdown open` is documented only as a split. But the vendored skills give a two-step route the ledger did not consider:

```
cmux markdown open <return-path> --surface <role-surface> --json   → md surface_ref (as a split)
cmux move-surface --surface <md-ref> --pane <role-pane>            → the split becomes a TAB in the role's pane
```

with `panes-surfaces.md` explicitly promising that surface identity survives the move.

- **A — open-then-move (new).** Optimizes: delivers exactly the user's stated preference with two documented verbs. Sacrifices: unverified for *markdown* surfaces specifically; also requires the file to exist first (an absent file renders "file unavailable" and needs a close/reopen).
- **B — browser surface tab** rendering the doc. Officially supported as a tab, but needs a renderer and loses live-reload-for-free.
- **C — viewer as a split pane** beside the producer. Always works, but is the ledger's own last resort.

**Recommendation: A, with the mitigation that the dispatcher pre-creates the return file with a `# {role} — working…` placeholder before opening the panel** (which also makes the doc tab meaningful from second zero). Fall back B → C per the ledger's order on spike failure. One design consequence worth stating plainly: **for judgment roles the return file is markdown, and it is simultaneously the contract return, the live doc tab, and the approval surface.** One artifact, three jobs — that is what makes D7 cheap.

### 4.5 Return format: uniform JSON vs. per-role kind

- **A — JSON for every role.** Uniform validation. Sacrifices: forces leads to emit JSON, degrading exactly the rich markdown architecture packages the plugin's value rests on, and would be a *brain* change.
- **B — `return.kind` per role in the roster:** `json` (schema-validated: coder → `coder-return.schema.json`) or `markdown` (structurally linted: required section headings present, non-empty).

**Recommendation: B.** The coder's contract stays byte-identical to today, leads keep prose, and the markdown returns are the doc-tab artifacts from §4.4. Structural linting for markdown is deliberately weak — it checks that the sections a lead promised exist, not their quality; quality remains the orchestrator's and `plan-reviewer`'s job, exactly as today.

---

## 5. TRD — implementation architecture

### 5.1 Component map

**New files**

| Path | Kind | Responsibility |
|---|---|---|
| `scripts/cmux/dispatch.mjs` | node, zero-dep | Orchestrator-side lifecycle: `preflight`, `workspace`, `dispatch`, `await`, `close`, `status`, `teardown`. Never talks to a model. |
| `scripts/cmux/adapters/claude.sh` | bash | Agent adapter. `capabilities` (orchestrator side) and `run <record.json>` (inside the pane). The only file that knows `claude` flag syntax. |
| `scripts/cmux/return-gate.sh` | bash | Stop-hook: validate the return file → signal, or block the turn with the lint failure as `reason`. |
| `scripts/cmux/return-lint.mjs` | node, zero-dep | Validate a return file: JSON-schema check (`kind: json`) or required-headings check (`kind: markdown`). Exit 0/1/2, mirroring `spec-lint.mjs`. |
| `roster.schema.json` | JSON Schema | Roster shape. |
| `roster.default.json` | data | Ships in the plugin; the zero-config roster. |
| `dispatch-record.schema.json` | JSON Schema | **The adapter interface contract** (§5.3). |
| `references/cmux-dispatch.md` | markdown | Read at the dispatch trigger. Two sections: (1) dispatch protocol & policy; (2) D13's distilled verb reference + `cmux docs` fallback. |

**Modified files**

| Path | Change | Size |
|---|---|---|
| `orchestration.md` | 4 added lines (§5.8) | +4 |
| `hooks/hooks.json` | SessionStart self-suppression when `DEVTEAM_ROLE` is set | +1 guard clause |
| `commands/team.md` | `roster` and `mode` verbs (2 bullets) + frontmatter verb list | +2 |
| `commands/ship.md` | teardown step between 5 and 6 | +1 step |
| `commands/onboard.md` | cmux detection, roster seeding, `tasks/.gitignore` | +~6 lines in steps 4–5 |
| `references/qa-gate.md` | browser-verify evidence + `cmux diff` note | +2 |
| `agents/*.md` | **unchanged** | 0 |

That last row is the design's biggest economy: **`agents/*.md` remains the single source of truth for role prompts across both substrates.** The adapter strips the frontmatter and feeds the body via `--append-system-prompt-file`; the frontmatter fields map 1:1 onto CLI flags (`model`→`--model`, `effort`→`--effort`, `tools`→`--allowedTools`, `disallowedTools`→`--disallowedTools`, `permissionMode`→`--permission-mode`). The roster overrides `agent`/`model`/`profile` per D2. There is no second copy of any role prompt to drift.

### 5.2 Data layout

```
<project-root>/.claude/dev-team/
├── config.md                       # + execution_mode:, + keep_task_artifacts:
├── roster.json                     # COMMITTED (config-like, per ADR-006)
├── memory/…                        # unchanged
└── tasks/                          # GITIGNORED via tasks/.gitignore ("*" + "!.gitignore")
    └── <task-slug>/
        ├── status.json             # DERIVED, never hand-mutated
        ├── roster.snapshot.json    # the resolved roster at engage time
        ├── specs/<task_id>.json    # Handover Specs (already spec-lint's input shape)
        ├── dispatch/<dispatch-id>.json     # dispatch records (immutable once written)
        ├── returns/<dispatch-id>.{json,md} # the return; md doubles as the doc tab
        └── logs/<dispatch-id>.log          # adapter stderr for triage
```

**Concurrency rule:** with parallel coders, several dispatches write at once. Therefore nothing mutable is shared — `dispatch/` and `returns/` are per-dispatch files, and `status.json` is *derived* by `dispatch.mjs status` from the directory listing plus `cmux tree --json`, written atomically (tmp + rename) as a cache. No lockfile, no lost updates.

### 5.3 Adapter interface contract (the load-bearing seam)

An adapter is any executable satisfying this CLI + record contract. Adding `codex`/`opencode`/`pi` later means one new script and one roster line — no change to `dispatch.mjs`.

**CLI surface**

```
<adapter> capabilities                 # stdout: JSON descriptor; exit 0 usable, 3 CLI missing
<adapter> run <record.json>            # executes inside the pane; never returns until the agent exits
```

`capabilities` output:

```json
{ "adapter": "claude", "contract_version": 1, "cli": "claude", "cli_path": "/usr/local/bin/claude",
  "cli_version": "2.1.x",
  "supports": { "model": true, "effort": true, "system_prompt_file": true, "permission_mode": true,
                "tool_allow_deny": true, "session_resume": true, "headless": true,
                "slash_command_disable": true } }
```

`dispatch.mjs` calls `capabilities` at preflight and **refuses to dispatch a role whose roster entry needs a slot the adapter does not declare** — that is how a future half-featured adapter fails loudly at preflight instead of silently ignoring a permission profile.

**Dispatch record** (`dispatch-record.schema.json`) — the full input, on disk, one file, no hidden env coupling:

```json
{ "schema_version": 1,
  "dispatch_id": "be-02.1", "task_id": "add-priority-field", "role": "coder",
  "agent": "claude", "model": "sonnet", "effort": "medium",
  "profile": { "name": "executor", "permission_mode": "acceptEdits",
               "allowed_tools": ["Read","Edit","Write","Glob","Grep","Bash"],
               "disallowed_tools": ["Bash(cmux *)"], "disable_slash_commands": true },
  "role_prompt_path": "<plugin-root>/agents/coder.md",
  "spec_path":   "<task-dir>/specs/be-02.json",
  "return_path": "<task-dir>/returns/be-02.1.json",
  "return": { "kind": "json", "schema_path": "<plugin-root>/coder-return.schema.json" },
  "cwd": "<worktree-or-repo-root>",
  "env": { "DEVTEAM_ROLE": "coder", "DEVTEAM_TASK_ID": "add-priority-field",
           "DEVTEAM_DISPATCH_ID": "be-02.1", "DEVTEAM_SPEC_PATH": "…", "DEVTEAM_RETURN_PATH": "…" },
  "signal_token": "dt-add-priority-field-be-02.1",
  "kickoff": "single-line kickoff text — no newlines, points at $DEVTEAM_SPEC_PATH and $DEVTEAM_RETURN_PATH",
  "memory_paths": { "conventions": "…", "domain_notes": "…", "architecture": "…" },
  "surface": { "workspace_ref": "workspace:3", "pane_ref": "pane:5", "surface_ref": "surface:9" },
  "timeout_s": 1800, "created_at": "2026-07-31T12:00:00Z" }
```

**Outputs and error behavior** (all four are part of the contract):

1. The return file at `return_path`, written by the agent, valid per `return`.
2. Exactly one signal on `signal_token` — **emitted from a `trap … EXIT` in the adapter**, so a crashed, killed, or misbehaving agent still rings the doorbell.
3. `logs/<dispatch-id>.log` — adapter stderr, for stall triage.
4. Adapter exit code, and this rule: **the adapter never leaves the orchestrator without a return file.** On any failure it writes one itself before signalling —
   - CLI missing → `{status:"blocked", reason:"agent CLI 'claude' not found on PATH"}`, exit 3
   - unreadable record / role file → `{status:"blocked", reason:"…"}`, exit 2
   - agent exited with no valid return → `{status:"blocked", reason:"agent exited without a valid return (exit N); see logs/<id>.log"}`, exit 1

   For `kind: markdown` roles the failure return is a markdown stub carrying the same status line. On non-zero exit the adapter holds the pane open (`hold()`, per `pr-review-window.sh` house style) so the error stays readable.

**Composed argv (claude adapter, executor profile):**

```
claude --model sonnet --effort medium --permission-mode acceptEdits \
       --append-system-prompt-file <tmp role body, frontmatter stripped> \
       --allowedTools Read Edit Write Glob Grep Bash \
       --disallowedTools "Bash(cmux *)" \
       --disable-slash-commands \
       --settings <tmp settings with the Stop hook> \
       --add-dir <task-dir> \
       "<kickoff>"
```

`--append-system-prompt-file` (append), not `--system-prompt-file` (replace): the role body was authored to sit *on top of* Claude Code's default harness prompt, which is how it behaves as an Agent-tool subagent today. Replacing would silently change every role's behavior. S11 compares the two empirically; append is the default.

### 5.4 Roster (D2)

```json
{ "version": 1,
  "execution_mode": "auto",
  "defaults": { "agent": "claude", "timeout_s": 1800, "icon": "robot" },
  "profiles": {
    "planner":  { "permission_mode": "plan",        "disallowed_tools": ["Edit","Write","NotebookEdit","Bash"] },
    "executor": { "permission_mode": "acceptEdits", "disallowed_tools": ["Bash(cmux *)"], "disable_slash_commands": true },
    "reviewer": { "permission_mode": "dontAsk",     "disallowed_tools": ["Edit","Write","NotebookEdit","Bash(cmux *)"] }
  },
  "roles": {
    "coder":             { "agent": "claude", "model": "sonnet", "effort": "medium", "profile": "executor",
                           "return": { "kind": "json", "schema": "coder-return.schema.json" },
                           "doc_tab": false, "timeout_s": 1800 },
    "backend-lead":      { "agent": "claude", "model": "opus", "effort": "high", "profile": "planner",
                           "return": { "kind": "markdown",
                                       "required_sections": ["Handover Spec", "Assumptions & unknowns"] },
                           "doc_tab": true, "timeout_s": 2400 },
    "architecture-lead": { "…": "effort xhigh, markdown return, doc_tab true, timeout 3600" },
    "code-reviewer":     { "model": "sonnet", "profile": "reviewer", "return": { "kind": "markdown",
                           "required_sections": ["Verdict", "Must-fix", "Notes"] }, "doc_tab": true },
    "build-validator":   { "model": "haiku", "effort": "low", "profile": "reviewer" }
  } }
```

**Resolution precedence** (lowest → highest): `agents/<role>.md` frontmatter → plugin `roster.default.json` → `~/.claude/dev-team/roster.json` → `<project>/.claude/dev-team/roster.json` → session override from `/dev-team:team roster coder=claude:opus`. This mirrors the plugin's existing memory precedence (project over global) and satisfies D2's "roster overrides the pinned models for pane-executed roles" while leaving Agent-tool dispatches on their pins.

Validation at preflight: every `roles` key must correspond to an existing `agents/<role>.md`; every `model` must pass the same alias whitelist `test/agents.test.mjs` enforces; every `profile` must exist; every `agent` must resolve to a bundled adapter whose `capabilities` covers the entry's needs. Failures are reported per-role, and **an invalid role falls back to its frontmatter pins** rather than blocking the task.

### 5.5 Dispatch lifecycle

**Preflight** — once per session, cached in `status.json`:

1. `cmux ping` — app running.
2. `cmux identify --json` — captures the orchestrator's own window/workspace/surface refs **and proves the socket is reachable in default `cmuxOnly` mode**, which is exactly D9's hard precondition. This single call is the security gate: if it fails, the orchestrator is not inside a cmux pane, and the mode is unavailable.
3. `cmux capabilities --json` — assert every required socket method is present (the guard against version drift, R1).
4. `cmux --version` — recorded in `status.json` and in any bug report.
5. Adapter `capabilities` for every distinct `agent` in the roster.

Any failure ⇒ **mode unavailable**: the orchestrator announces one line (`cmux mode unavailable ({reason}) — running this task on Agent-tool dispatch`) and proceeds on the old substrate. See R7.

**Workspace ensure** (D5) — on the first Tier-2/3 engagement:
`cmux workspace create --name "<task-slug>" --json` → capture `workspace_ref` + initial `surface_ref`; place it in the project's workspace-group; set the tier color and the phase status pill. Tier 1 never reaches this code path.

**Dispatch** (per role, non-blocking):

1. Resolve the roster entry; compose the dispatch record; write `dispatch/<id>.json`.
2. Pre-create `returns/<id>.{json|md}` with a placeholder (so the doc tab never shows "file unavailable").
3. `cmux new-pane --workspace <ws> --type terminal --direction <dir> --json` → `pane_ref`, `surface_ref` (or the provider form if S4 passes).
4. Identity: tab title `{icon} {role} · {model}` — the same self-identifying string as today's `{agent type} ({model})` panel prefix, so the orchestration.md rule carries over verbatim.
5. Kickoff: `cmux send --surface <ref> "exec '<adapter>' run '<record>'\n"` — **one line, no payload**, honoring D4 and the newline gotcha.
6. Doc tab if `doc_tab: true`: `cmux markdown open <return-path> --surface <ref> --json` then `cmux move-surface --surface <md-ref> --pane <pane-ref>` (§4.4).
7. Return `{dispatch_id, refs, signal_token, timeout_s}` to the orchestrator and exit. **The orchestrator is never blocked by a dispatch.**

**Await** (per dispatch, run as background Bash so the session stays responsive):

`dispatch.mjs await --dispatch <id>` runs `cmux wait-for <token> --timeout <N>`, then:

- **Signalled** → `return-lint` the return file. Valid → print the parsed return to stdout; the orchestrator handles it with today's unchanged logic (insufficient → amend loop; done → QA gate). Invalid/absent → re-arm the wait, bounded at 3, then triage.
- **Timeout** → triage ladder, in order: `cmux top --format tsv` (burning CPU = thinking, idle = stalled) → `cmux read-screen --surface <ref> --lines 40` (**diagnostics only, never the result channel** — D4) → then one of: extend the wait, interject a one-line nudge via `send`, or `close-surface` + re-dispatch. If the choice needs the user: `cmux notify` + `trigger-flash` and ask.

**Close** — on a valid return: `close-surface` the *terminal* surface. For `doc_tab` roles the pane collapses to the rendered document, which is the approval surface (D7). For executors the pane disappears entirely.

**Teardown** — at ship, after memory distillation: `cmux workspace close --workspace <ws>`, then delete `tasks/<task-slug>/` unless `keep_task_artifacts: true`, in which case move it to `tasks/.archive/<task-slug>-<date>/`.

### 5.6 Plugin-injection neutralization (D10)

The pane's Claude session must not inherit the orchestrator rules, or every coder thinks it runs a team.

**Recommended mechanism — cooperative self-suppression.** The adapter exports `DEVTEAM_ROLE` before exec; `hooks/hooks.json`'s SessionStart command gains a leading guard: `[ -n "${DEVTEAM_ROLE:-}" ] && exit 0;`. One clause, fully under our control, no dependency on undocumented CLI behavior, and it degrades correctly for anyone who has the plugin installed but not this mode. Belt-and-braces for executor/reviewer profiles: `--disable-slash-commands` (a worker has no business invoking `/dev-team:*`).

Rejected alternatives: `--bare` and `--safe-mode` both work but are blunt — they also kill CLAUDE.md, project skills, and (fatally) our own Stop hook. `--setting-sources` does not control plugins.

### 5.7 Crash recovery (D11)

The invariant is **files are authoritative, panes are disposable**. Recovery is `dispatch.mjs status --task <slug>`, which reconciles three sources — the task directory, `cmux tree --json`, and the roster snapshot — into a report:

| Situation | Reconciliation |
|---|---|
| Return file valid, surface gone | Completed. Feed the return to the orchestrator. |
| Surface alive, no return | Running. Re-arm `await` (if the token did not survive, fall back to a bounded file poll — S12). |
| Surface gone, no return | Orphaned. Report to the user with the spec and the adapter log; offer re-dispatch (never automatic — a coder may have made partial edits, which git shows). |
| Whole cmux restarted | Panes are gone; specs and returns remain; re-dispatch what is orphaned. If provider surfaces shipped (§4.2 A), `autoResumeAgentSessions` may restore some sessions for free — treat as a bonus, never as a dependency. |
| Orchestrator window `/clear`ed or lost | `status --task <slug>` plus the roster snapshot rebuilds the entire picture from disk. |

### 5.8 orchestration.md deltas — exact text, +4 lines

§ Reference files, new bullet:
> `- references/cmux-dispatch.md` — **cmux mode is active and you are about to dispatch a role** (or tear the workspace down at ship).

§ Roles, appended to the pinned-models sentence:
> **In cmux mode** the roster (`.claude/dev-team/roster.json`) supplies each role's agent/model/profile and **overrides these pins**; `Explore` always stays an Agent-tool scout.

§ Flow, new bullet:
> - **Execution substrate:** `execution_mode` in `config.md` (`cmux` | `agent-tool` | `auto`, default `auto`). In cmux mode every dev-team role runs as a visible pane — dispatch via `scripts/cmux/dispatch.mjs` (read the reference first), never the Agent tool. Preflight failure ⇒ say so in one line and fall back to Agent-tool dispatch for the session.

§ Progress signalling, appended:
> In cmux mode the same `{agent type} ({model})` string is the pane's **tab title** (the dispatcher sets it) — your one-liners are unchanged, and the pane, not the subagent panel, carries the live detail.

Everything else — verbs, gotchas, triage ladder, teardown, the D13 verb page — lives in the one on-trigger reference.

### 5.9 Gate and ship integration

The QA gate's three invariants survive intact, deliberately:

1. **Deterministic validation still runs inline** — the orchestrator's own Bash, not a pane.
2. **Scope compliance is still verified by git**, not the coder's self-report.
3. **The review bundle is still sized to risk** — the ladder is unchanged; only the reviewers' substrate changes.

Additive only: `cmux diff` as the human's patch view at the gate (D11); browser-verify evidence (screenshot + console-errors-clean) appended to the gate report for frontend tasks (D8). `ship.md` gains one teardown step after step 5 — *after* the PR exists and *after* the step-3 memory reconcile, so the durable record is safely in git before anything is deleted (D6).

**`config.validate.full` still runs exactly once, at ship, inline.** No phase moves it.

---

## 6. ADRs (proposed)

**ADR-001 — Execution substrate: custom cmux adapter, not `cmux claude-teams`.**
*Status:* accepted · *Scope:* cross-cutting.
Drive cmux via its CLI/socket behind our own adapter layer. Option A (`cmux claude-teams`) rejected: tmux shim at `~/.cmuxterm/claude-teams-bin/tmux`, gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, Claude-only, partial tmux verb coverage — cannot carry a roster, a permission model, or a return contract. *Revisit if:* claude-teams leaves experimental **and** grows multi-CLI support.

**ADR-002 — Filesystem is the data plane; the cmux socket is control plane only.**
*Status:* accepted · *Scope:* cross-cutting.
Specs in as file paths on the launch line; returns as schema-validated files; `wait-for` = doorbell; `read-screen` = diagnostics only; `send` = single-line control text only. Forced by cmux's design (events redact bodies; no payload primitive; TUIs submit on every newline). *Consequence:* screen-scraping is structurally impossible.

**ADR-003 — Completion is signalled by a return-gate Stop hook, with an adapter EXIT-trap backstop.**
*Status:* accepted (mechanism pending S10) · *Scope:* cross-cutting.
Stop hook validates the return file → signals or blocks the turn with the lint failure as reason; adapter also signals from `trap … EXIT`. Wait always unblocks — by success or by death; workers can be denied `Bash(cmux *)` outright. *Fallback ladder if S10 fails:* `--plugin-dir` worker plugin → agent self-signal.

**ADR-004 — Role-station panes: the return file is the doc tab.**
*Status:* accepted (mechanism pending S2/S3) · *Scope:* cross-cutting.
Judgment roles return markdown, opened with `cmux markdown open` and relocated into the producer's pane with `move-surface`. Terminal closes → pane collapses to the rendered document = approval surface. One artifact = contract return + live progress view + approval target. *Fallbacks:* browser surface tab, then a split pane.

**ADR-005 — Security posture: default socket mode, orchestrator-inside-cmux, workers denied cmux.**
*Status:* accepted · *Scope:* cross-cutting.
`automation.socketControlMode` stays `cmuxOnly`; `allowAll` banned. Precondition enforced by mechanism: `cmux identify` preflight gate. Read-only roles enforced by launch profile. Workers denied `Bash(cmux *)` entirely. Never `--dangerously-skip-permissions`. `--env-file` opt-in per task; never clobber a working login.

**ADR-006 — `roster.json` is committed; `tasks/` is gitignored by a self-contained ignore file.**
*Status:* accepted · *Scope:* cross-cutting.
`roster.json` is team configuration like `config.md` → committed. `.claude/dev-team/tasks/` is ephemeral → ignored via `tasks/.gitignore` (`*` + `!.gitignore`), not the repo root `.gitignore` (the plugin commits the sibling `memory/` tree). Deleted at ship after memory distillation; `keep_task_artifacts: true` archives instead.

**ADR-007 — Workflow mode stays on the Agent tool.**
*Status:* accepted · *Scope:* `team-build.workflow.mjs`.
The Workflow tool's `agent()` primitive cannot be intercepted without rewriting the wave scheduler; workflow mode is the batch lane where visibility is not the point. "Never the Agent tool" is scoped to conversational dispatch. Carve-out stated in `references/cmux-dispatch.md` and `commands/team.md`.

---

## 7. Execution plan

Review route per phase: `dev-team:qa-lead` sizes the gate; standard `code-reviewer` for docs/config slices, **`code-reviewer-deep` for `dispatch.mjs`, the adapter, and the permission-profile work**. `dev-team:plan-reviewer` reviews this package before Phase 0.

### Phase 0 — Spike (orchestrator-run, user present) — BLOCKING

cmux is not installed and every item needs a live GUI app. **The orchestrator runs the spike interactively with the user**, recording findings in `tasks/cmux-mode/spike-findings.md`. No production code ships in this phase.

| # | Item | Gates |
|---|---|---|
| S1 | Install; record the actual version vs 0.64.17 | all |
| S2 | Markdown panel as a **tab**: does `markdown open` + `move-surface` produce a sibling tab that live-reloads? | Ph2 |
| S3 | Pane lifecycle: does the doc tab survive `close-surface` on the terminal; does the pane collapse to it? | Ph2 |
| S4 | `new-surface --type agent-session --provider claude`: does it forward `--model`/`--append-system-prompt-file`/permission flags? Resume behavior? | Ph1 (§4.2 fork) |
| S5 | D10 neutralization: confirm `DEVTEAM_ROLE` reaches the pane's session env and the SessionStart guard suppresses the injection | Ph1 |
| S6 | `send` newline semantics against the Claude Code TUI; kickoff-via-launch-arg in interactive mode | Ph1 |
| S7 | `wait-for` blocking + background-Bash end to end; double-signal is a no-op; events cursor-file durability | Ph1 |
| S8 | Socket modes: real mode names, whether `password` exists, inside-cmux orchestrator reaches socket in default mode | Ph1 |
| S9 | Permission-rule behavior: does `--disallowedTools "Bash(cmux *)"` beat an `--allowedTools` carve-out? | Ph1 |
| S10 | Does `--settings <file>` deliver a `Stop` hook to the session? If no, test `--plugin-dir` with a generated worker plugin | Ph1 (ADR-003) |
| S11 | `--append-system-prompt-file` vs `--system-prompt-file` fidelity for a role body authored as a subagent prompt | Ph1 |
| S12 | `wait-for` token durability across a cmux restart | Ph3 |
| S13 | Verb-surface audit: `cmux capabilities --json` + `cmux --help` for every verb this design uses, at the installed version | all |

**Acceptance:** every item answered yes/no with the exact command and output pasted into the findings file; every "no" paired with which fallback it activates. **Gate:** user reviews findings; any finding contradicting a locked decision returns to the architecture lead for amendment before Phase 1.

### Phase 1 — Minimal end-to-end: a coder in a pane

The smallest complete proof: a real Tier-2 task where the lead is still an Agent-tool subagent and the **coder runs in a visible pane**, returns a schema-valid JSON, and passes the unchanged QA gate.

| Slice | Files in scope | Parallel? | Depends on |
|---|---|---|---|
| **1a — contracts** | `roster.schema.json`, `roster.default.json`, `dispatch-record.schema.json`, `test/roster.test.mjs` | starts first, alone | — |
| **1b — dispatcher** | `scripts/cmux/dispatch.mjs`, `test/cmux-dispatch.test.mjs`, `test/fixtures/fake-cmux.mjs` | parallel with 1c, 1d | 1a (schemas frozen); S4, S7, S8 |
| **1c — adapter + gate** | `scripts/cmux/adapters/claude.sh`, `scripts/cmux/return-gate.sh`, `scripts/cmux/return-lint.mjs`, `test/return-lint.test.mjs`, `test/claude-adapter.test.mjs`, `test/return-gate.test.mjs` | parallel with 1b, 1d | 1a; S5, S6, S9, S10, S11 |
| **1d — wiring & docs** | `orchestration.md`, `hooks/hooks.json`, `references/cmux-dispatch.md`, `commands/team.md` (mode verb) | parallel with 1b, 1c | 1a |

1b and 1c are separate coders in **worktrunk worktrees** (`isolation: "worktree"`) because both consume the dispatch-record contract; the contract is frozen by 1a first, and its `interface_contract` field is the record schema in §5.3 verbatim.

**Acceptance:** `node --test` green with zero live cmux (`CMUX_BIN` pointed at the fake); a real Tier-2 task completes coder-in-pane → valid return → gate → ship; preflight failure demonstrably falls back to Agent-tool; a killed pane still unblocks the orchestrator within `timeout_s` with a `blocked` return.

### Phase 2 — Leads and the doc-tab UX

Judgment roles in panes; markdown returns; doc tab via open-then-move; collapse-to-document approval surface; tab identity and status pills.
**Files:** `roster.default.json`, `scripts/cmux/dispatch.mjs` (doc-tab + markdown return path), `scripts/cmux/return-lint.mjs` (markdown mode), `references/cmux-dispatch.md`.
**Depends on:** Phase 1; S2, S3. One coder (one code path).
**Acceptance:** a Tier-3 task where the architecture package is drafted live into a doc tab beside the lead's terminal, and the pane collapses to the rendered package on return. Fallback path exercised at least once by forcing the failure.

### Phase 3 — Gate, ship, onboard integration

Reviewers/validators in panes; `cmux diff` at the gate; ship teardown; onboard seeding (cmux detection, `roster.json`, `tasks/.gitignore`, `execution_mode`); `team roster` verb; ADR-007's carve-out clause.
**Files:** `commands/ship.md`, `commands/onboard.md`, `commands/team.md`, `references/qa-gate.md`, `scripts/cmux/dispatch.mjs` (`teardown`, `status`), `test/commands.test.mjs`.
**Parallel:** ship+onboard+team (one coder) ‖ dispatcher teardown/status (second coder). **Depends on:** Phase 2; S12.
**Acceptance:** ship closes the workspace and removes the task dir after the PR exists and after the memory commit; `keep_task_artifacts: true` archives; onboard on a fresh project produces a working roster; `status` correctly classifies completed/running/orphaned after a forced crash.

### Phase 4 — UX polish (two independent tracks)

- **4a — signalling & triage:** `notify` + `trigger-flash` + `jump-to-unread` at the four user-blocking moments; `set-status`/`set-progress`/`log`; automated stall triage via `top`; workspace-group per project and tier colors.
- **4b — browser singleton (D8):** one browser surface per workspace, beside the frontend coder during build, driven by-ref by the validator at the gate; `browser state save/load`; browser-verify evidence in the gate report.

Parallel with each other; both depend on Phase 3.

### Phase 5 — Deferred, tracked, not built now

`RECREATION-SPEC.md` cmux-mode section; adapters for codex/opencode/pi; custom palette actions; status-board sidebar; SSH/VM remote executors.

---

## 8. Testing strategy

Every new script gets `test/<name>.test.mjs`, `node:test` + `assert/strict`, zero deps, no model, no network, **no GUI**.

**The mockability seam is a single environment variable: `CMUX_BIN`** (default `cmux`), honored by `dispatch.mjs`, `adapters/claude.sh`, and `return-gate.sh`. Tests point it at `test/fixtures/fake-cmux.mjs`, which appends every invocation to `$FAKE_CMUX_LOG` as one JSON line and answers `--json` verbs with canned refs; `$FAKE_CMUX_WAIT_RESULT` scripts wait-for outcomes. `CLAUDE_BIN` + `DEVTEAM_ADAPTER_DRY_RUN=1` makes the adapter print its composed argv as JSON and exit.

| Test file | Asserts |
|---|---|
| `test/roster.test.mjs` | default roster validates against schema; every role key has an `agents/<role>.md`; models pass the alias whitelist (share the constant with `agents.test.mjs`); profiles exist; precedence resolution |
| `test/cmux-dispatch.test.mjs` | preflight failure paths (exit codes + reasons); exact cmux command sequence from the fake's log; dispatch record schema-valid; await success/invalid-re-arm/timeout-triage; teardown; `status` reconciliation over fixture task dirs |
| `test/claude-adapter.test.mjs` | dry-run argv per profile — flags present, `Bash(cmux *)` denied, no `--dangerously-skip-permissions` ever (explicit negative test); frontmatter stripped; missing-CLI writes `blocked` return + signals; EXIT trap signals exactly once |
| `test/return-lint.test.mjs` | JSON mode against `coder-return.schema.json`; markdown mode (missing section, empty, valid); exit codes 0/1/2 |
| `test/return-gate.test.mjs` | valid return → signal + exit 0; invalid → `{"decision":"block","reason":…}` with lint failure quoted; `stop_hook_active: true` bounds the loop |
| `test/commands.test.mjs` (extend) | new `team.md` verbs present; ship's teardown step positioned after the task-source step |

Scoping note: `test/schema.test.mjs`'s no-conditional-keywords rule exists for structured-output schemas only — it must scope to `handover-spec.schema.json` + `coder-return.schema.json`, not glob every schema (roster/dispatch-record schemas may use conditionals).

What tests cannot cover is exactly the spike list — the suite proves the plumbing, the spike proves the platform.

---

## 9. Disposition of RECREATION-SPEC.md and team-build.workflow.mjs

**`team-build.workflow.mjs` — out of scope, documented carve-out (ADR-007).** Cost of the carve-out: one clause in `references/cmux-dispatch.md` and one in `commands/team.md`. Left undocumented it would read as a bug.

**`RECREATION-SPEC.md` — follow-up at end of Phase 3** via `dev-team:doc-writer`: one section "Execution substrate: Agent-tool vs. pane adapters," framed as an optional layer so the spec stays harness-agnostic.

---

## 10. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | **Verb-surface drift** — public docs don't document `new-surface`/`wait-for`/`read-screen`/`close-surface`/`new-pane`; design rests on vendored skills @ 0.64.17 vs an uninstalled version | **High** | S13 audits every verb pre-Phase-1; `capabilities --json` hard preflight gate; missing verb ⇒ mode unavailable, not task failure |
| R2 | Hook delivery (S10) fails → ADR-003 primary broken | Medium | Ordered fallback ladder: `--plugin-dir` worker plugin → agent self-signal → bounded file poll. EXIT-trap keeps liveness regardless |
| R3 | `--provider` can't forward flags (S4) → native resume lost | Medium | Terminal+wrapper is the baseline; provider is an upgrade path. Recovery is file-based by design |
| R4 | `maxTurns` unenforceable in interactive panes (print-mode-only flag) | Low | Accept; `timeout_s` + stall triage covers runaways; document the fidelity gap |
| R5 | Human interjection races the return gate | Low | Gate is idempotent; a second Stop re-runs it; return file still validates |
| R6 | Parallel dispatches corrupt shared state | Low | Designed out: per-dispatch files; `status.json` derived + atomic |
| **R7** | **D3 conflict** — "never the Agent tool," but preflight can fail | Medium | Read D3 as scoped to "while cmux mode is active"; loud one-line fallback; `execution_mode: cmux` = strict-refuse for guarantee-wanting users. **Needs user decision** |
| **R8** | **D6 conflict** — deleting task dir at ship destroys adapter logs of a failed-but-shipped dispatch | Low | Recommend: teardown always archives when any dispatch ended non-zero, regardless of flag. **Needs user decision** |
| R9 | Reference-file sprawl re-bloats the core | Low | ONE `references/cmux-dispatch.md`; reviewers reject a second |
| R10 | Cost regression from visible panes | Low | Panes cost the same tokens as subagents; no "boot the team" verb exists at all |

---

## 11. Open unknowns & assumptions

### Assumptions

| # | Assumption | Status |
|---|---|---|
| A1 | Claude Code exposes `--model`, `--effort`, `--append-system-prompt-file`, `--allowedTools`/`--disallowedTools`, `--permission-mode`, `--settings`, `--plugin-dir`, `--disable-slash-commands` | **Verified** (CLI reference, fetched this session) |
| A2 | `Stop` hooks receive `stop_hook_active`, can return `{"decision":"block"}` | **Verified** (hooks docs) |
| A3 | Hooks delivered via `--settings` are honored | **Unverified — S10 decides; ADR-003 fallback ladder exists for this** |
| A4 | `move-surface` relocates a markdown surface into a pane as a tab, still live-reloading | **Unverified — S2** |
| A5 | A pane collapses to its remaining tab when the terminal surface closes | **Unverified — S3** (Phase 2's approval UX depends on it) |
| A6 | Double-fired `wait-for -S` is harmless | **Unverified — S7**; if not, trap checks a sentinel file first |
| A7 | `DEVTEAM_ROLE` reaches the pane session's env where the SessionStart hook sees it | Verified by construction, **untested — S5** |
| A8 | `claude "<prompt>"` interactive submits without separate Enter | **Unverified — S6**; fallback: `send-key enter` after settle delay |
| A9 | The §5.5 cmux verbs exist at the installed version | **Unverified — R1/S13** |
| A10 | Denying `Bash(cmux *)` breaks nothing roles need | Verified by design (no role prompt references cmux; signal moved to hook) |
| A11 | worktrunk worktrees work as pane `cwd` | Unverified, low risk (pr-review-window.sh does this with Ghostty) |
| A12 | No version-stable adapter copy needed (unlike pr-review-window.sh) | Verified by reasoning — adapter paths written into each dispatch record by the running plugin version. Reviewers: confirm rather than reflexively copy the `~/.claude/dev-team/bin/` pattern |

### Unknowns per phase
Before Phase 1: S1, S4–S11, S13. Before Phase 2: S2, S3. Before Phase 3: S12.
Open beyond spike: does cmux expose a per-surface "process exited" event (would make the EXIT-trap backstop redundant — check during S13)?

### User decisions needed

1. **R7 — degradation policy:** fall back to Agent-tool with one-line announcement (recommended, `auto` default) vs strict-refuse (`execution_mode: cmux`)?
2. **R8 — failure archiving:** always archive the task dir when any dispatch ended non-zero, overriding `keep_task_artifacts: false`? (Recommended: yes.)
3. **Doc-tab scope Phase 2:** persistent architecture-package viewer survives orchestrator `/clear` (file-backed — it will); needs explicit close at teardown — confirm.
4. **Spike timing:** Phase 0 needs the user present at a live GUI — scheduled session, not async.

---

## 12. Acceptance criteria (initiative-level)

1. A Tier-2 task runs end-to-end with the coder in a visible pane; return schema-valid; QA gate and ship behave identically to today.
2. A Tier-3 task runs with lead and reviewer panes, each carrying a live doc tab; package approved from the collapsed rendered document.
3. `node --test` passes with no cmux, no model, no network — including full dispatch lifecycle against the fake.
4. Killing a pane mid-task unblocks the orchestrator within `timeout_s` with a `blocked` return and a readable log.
5. `dispatch.mjs status` reconstructs task state after orchestrator `/clear` and after a cmux restart.
6. `orchestration.md` grew ≤ 8 lines; exactly one new file under `references/`.
7. No role prompt duplicated: `agents/*.md` single source; roster names only roles that exist as files.
8. A worker pane cannot execute any cmux verb; preflight refuses outside cmux; no code path enables `allowAll` or `--dangerously-skip-permissions`.
9. Ship deletes the task dir only after the PR exists and the memory commit landed; `keep_task_artifacts` archives.

---

## Recommended team dispatch

**Research:** none before plan review. During Phase 0: one `Explore` scout to diff `cmux --help` against §5.5's verb list once installed (S13).

**Feasibility consults (broker before approval):** devops-lead (bash-vs-node adapter split, test seams, trap design), qa-lead (gate invariants under panes, fake-cmux sufficiency, deep-review classes), backend-lead (lock-free scheme under 6 parallel coders, dispatch-record adequacy for a codex adapter).

**Review gate:** `dev-team:plan-reviewer` (mandatory, independent) **plus `dev-team:architect`** for a second opinion on §4.3 (doorbell) and §4.4 (open-then-move) — the two places where a clean-looking design rests on unverified platform behavior.

## Proposed memory deltas

(ADR-001…007 → `architecture-notes.md`; conventions re: dispatch-only-via-dispatch.mjs, adapter contract, CMUX_BIN mockability, single-source role prompts, one-reference-file budget, read-screen-diagnostics-only → `conventions.md`. Full text retained by the orchestrator for the end-of-task memory commit. NOTE: `.claude/dev-team/` does not exist in this repo yet — `/dev-team:onboard` must run before these can land.)
