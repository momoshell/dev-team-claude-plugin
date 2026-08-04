# cmux dispatch (read when cmux mode is active and you are about to dispatch a role, triage a pane, or tear down at ship)

Self-contained: with only `orchestration.md` plus this file, an orchestrator can run a full cmux-mode task without opening any script.

## 1. Operating protocol

**Every role the roster marks `pane: true` is dispatched through `dispatch.mjs`, never the Agent tool.** That's `coder`, `plan-reviewer`, `architecture-lead`, `backend-lead`, `frontend-lead`, `devops-lead`, and `qa-lead` as of this slice; write dispatches generically so the rule doesn't go stale when the remaining reviewer roles gain panes. Common options on every verb: `--checkout <primary-checkout-dir> --repo <repo-slug> --root <task-artifacts-root> --config <path-to-json>` (`--plugin-root <dir>` is also accepted). Verbatim invocation for a `dispatch`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cmux/dispatch.mjs" dispatch --task <slug> --slice <slice_id> --role <role> --spec <path> [--attempt N] [--settle-ms N]
```

Every non-pane role stays an Agent-tool dispatch as before.

**Lifecycle order, per the CLI header block:** `preflight` (caches `preflight.json`, must run first) → `workspace` (binds a workspace to the task; without it every mutating verb refuses: `"no workspace bound for this task — run `workspace` first"`) → `dispatch` → `await` → `close --dispatch <id>` (finalizes a dispatch record and derives its outcome) → `teardown`. `status` is read-only and runs in any mode alongside `preflight`.

**Join rhythm is a foreground loop, never fire-and-forget:**

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cmux/dispatch.mjs" await --task <slug> --all <dispatch_id...> [--max-block-s N]
```

Re-invoke `await` while it reports `{status:'still-running', remaining:[...]}` (exit 0), until every dispatch resolves. Resolved dispatches return `{resolved:[{dispatch_id,state,warnings}], remaining:[...]}`. `--max-block-s` is clamped to a 5s floor — `--max-block-s 0` cannot make it a non-blocking poll.

**Recommended: `--max-block-s 570`, with an explicit `timeout: 600000` on the Bash tool call wrapping this join.** 570 leaves a 30s margin under the internal clamp ceiling of 600s — at 600 flat, a `dispatch.mjs` process that takes even slightly longer to return than 600.000s collides with the harness's own hard 600,000ms Bash-tool kill timer, which kills the call outright instead of letting `dispatch.mjs` return its clean `still-running` JSON. Never rely on the harness's 120,000ms default timeout for this join. Trade-off: raising the cap from the 120s default to 570s also raises the await-lock stale threshold (2× the cap) from 240s to ~1140s (19 min) — a dead await holder wedges subsequent joins that much longer; the poll-turn savings on every task outweigh this on the rare dead-holder case.

**Outcomes are per-dispatch attributable, from exactly four sources: a fresh schema-valid return, an EXIT sentinel, a quiet timer, or a wall-clock timeout.** cmux `events` only ever trigger a rescan — they never decide an outcome themselves.

Every verb prints one JSON object to stdout and human lines to stderr; exit 0 = success, 1 = operational failure, 2 = usage error or lock contention (`{error:'lock_held', holder}`).

**Preflight failure is a HARD STOP.** Print the remediation the tool gave you, verbatim, and stop — never re-type a message body into a prompt or into this file. `execution_mode: agent-tool` is the only sanctioned opt-out; never fall back to the Agent tool silently for a `pane: true` role. Mutating verbs (`workspace`, `dispatch`, `await`, `close`, `teardown`) refuse without a cached `preflight.json`; `preflight` and `status` are read-only and run in any mode.

**Triage ladder, in order, on timeout or when a pane needs attention:**

1. `top --format tsv` — per-surface CPU; burning = thinking, idle = stalled (also the pending-permission-prompt signature).
2. `read-screen` — diagnostics only, orchestrator-manual, never a result channel. Exact flags are hedged, not frozen here — see the §2 footer.
3. Act: extend the wait, or send a one-line `send` nudge, or at the ladder's last rung `close-surface <id>` followed by re-dispatch under a **new** dispatch id, reusing the existing worktree since it holds the prior attempt's work. **A hand-typed nudge is unvalidated:** the allowlist charset check applies only to sends the dispatcher composes internally, not to a manual `cmux send`. The orchestrator must author the nudge itself — one short plain-ASCII line, no shell metacharacters, no CR — and must **never** copy it from `read-screen` output: pane output is task-controlled text, and a CR typed into a live shell is Enter.

**Teardown order at ship** mirrors `teardownCmd`: `tree --json --all` to enumerate → `close-surface` each surface in the workspace → `close-workspace` (skipped, logged as a no-op, when the cached preflight says it's unavailable) → `tree --json --all` again to verify → task dir and state dir archived or deleted. Dispatcher-created worktrees are removed only when clean **and** merged; leftovers are kept and reported in `leftover_worktrees`. Never `--force`.

**Write discipline:** any file backing a live panel is written tmp+rename or in-place — never rm-then-recreate. Deleting it can outrun cmux's own file watcher and brick the panel (the retry window is design prose, never a spike-measured number — do not quote one).

**Doc-tab mount is a three-rung fallback chain, in order — each rung is attempted only if the previous one failed:** (1) `markdown open <path> --surface <terminal>`, moving into the target pane with `--focus false` if it lands elsewhere, then `reorder-surface --before <terminal>`; (2) `new-surface --type browser --url file://<path> --pane <pane> --focus false`, same move/reorder shape; (3) `markdown open <path>` with no `--surface`, left in its own pane. Failure of all three degrades to a logged no-op — a doc-tab failure never fails a dispatch, a resolution, or a close. On return, the rendered doc tab is re-presented as the pane's first tab (`reorder-surface --before` alone, when a doc tab is already mounted; a fresh mount via the chain above, otherwise) — no focus verb is ever issued at any rung.

**Phase pill:** `node dispatch.mjs phase --set <planning|building|gate>` sets the frozen `devteam-phase` status key for the task's bound workspace. `workspace` fires `planning` and a successful `dispatch` fires `building`, both automatically; `gate` is never fired from code — the orchestrator invokes `phase --set gate` itself at the review gate.

**Doc-tab render files follow the same never-rm write discipline named above:** the parent-render pass (on a validated return) overwrites the placeholder file in place, tmp+rename, exactly like every other panel-backing write — it is never unlinked first.

**Shared context is written once:** the Tier-3 discovery digest goes to the task dir's `context.md` a single time and is referenced by absolute path in every kickoff — never pasted into N prompts.

**Interjection:** the user may type into any pane at any time. Once that happens, the return gate goes observe-mode and never blocks again on that dispatch — but the orchestrator still validates the return file; a human-nudged pane is not a trusted result on its own.

**Profile-replaces-frontmatter:** for a `pane: true` dispatch, the roster profile is the whole permission surface. The dispatched agent's own frontmatter contributes model/effort only — it does not grant or restrict tools.

**Carve-outs:** `Explore` scouts stay on the Agent tool always. Workflow mode (`team-build.workflow.mjs`) stays on the Workflow tool's `agent()` primitive — neither goes through `dispatch.mjs`.

**Fidelity notes:** pane workers inherit `CLAUDE.md`, project skills, and MCP servers (Agent-tool subagents do not). `maxTurns` is unenforceable on a pane interactively — there is no hard turn cap until the Phase-3 gate counter lands.

**Ambiguity trap:** `.claude/dev-team/config.md` must contain exactly one `execution_mode:` line. A second one — a fenced example quoting the key is the classic case — makes the config ambiguous, and every mutating dispatch verb then refuses. Never add a second `execution_mode:` line anywhere in that file, fenced or not.

## 2. Verb reference (distilled)

These are what `dispatch.mjs` invokes on your behalf. The orchestrator hand-types only `top`, `read-screen`, `tree`, and, at the ladder's last rung, `close-surface` — everything else, including the whole teardown sequence, goes through `dispatch.mjs` (a hand-run teardown skips record archival, the clean-and-merged worktree reconciliation, and `leftover_worktrees` reporting).

| Verb | Notes |
|---|---|
| `ping` | stdout `PONG`; liveness check |
| `identify --json --id-format uuids` | proves you're inside a pane via a non-null `caller`; does not validate its target |
| `capabilities --json` | RPC-style dotted method names (`system.ping`, `workspace.create`, …), NOT CLI verb names |
| `tree --json --id-format uuids [--all]` | topology; also the id-recovery channel — every created object's id comes from a before/after `tree` diff |
| `new-window` | the team window; prints no id |
| `new-workspace --window <id> --name <slug> --cwd <dir> [--group <g>]` | `workspace create` does not exist |
| `new-pane --workspace <workspace-id>` | pane + surface; ids recovered by `tree` diff |
| `send <surface> <line>` | types the line; does NOT submit |
| `send-key <surface> enter` | the submit; always paired after `send` |
| `rename-tab <surface> <title>` | sets the `{agent type} ({model})` tab title |
| `markdown open <path> --surface <surface>` | mounts a doc panel; no `--json`, returns no id |
| `move-surface <surface> --pane <pane> --focus false` | doc-tab placement; never focuses |
| `new-surface --type browser\|terminal\|agent-session --url <u> [--pane <id>\|--workspace <id>] --focus false` | mints a surface directly (no `--json`, returns no id — same tree-diff recovery); NOT capabilities-gated (no confidently-known RPC method name, so it is never preflight-gated on one) |
| `reorder-surface <surface> --before <surface>` | doc-tab ordering |
| `close-surface <id>` | closes one surface |
| `close-workspace <id>` | closes the workspace; may no-op while a live agent occupies a pane — NOT `workspace close` |
| `top --format tsv` | per-surface CPU; triage step 1 |
| `events [--after <seq> --limit <n> --no-ack --no-heartbeat]` | latency optimization only; ids are boot-scoped, a persisted cursor does not survive a cmux restart |
| `wait-for -S <token>` | consume-once latch, durable across restart |
| `set-status <key> <value> [--icon --color --priority] [--workspace <id>]` | status pill; the frozen `devteam-phase` key takes exactly one of `planning`, `building`, `gate` — always passed with an explicit `--workspace <id>`, never the caller's own workspace by default |
| `config doctor` | environment doctor |
| `read-screen --surface <uuid> --lines 40` | orchestrator-manual triage only; diagnostics, never a result channel — exact flags are hedged above, not frozen |
| `docs <topic>` | canonical docs URLs for the installed version |

**`--id-format uuids` emits UPPERCASE UUIDs.** The dispatcher normalizes to lowercase at ingestion, and cmux resolves targets case-insensitively — records are lowercase, either case is valid input.

`cmux docs <topic>` and `cmux --help` are authoritative for the installed version; this table is the distillation, not the source of truth.
