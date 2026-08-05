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
