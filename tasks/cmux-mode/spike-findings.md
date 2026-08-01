# cmux mode — Phase 0 spike findings

Source: issue #1. Orchestrator-run, user present. No production code ships from this session.
Design record: comments on epic #15.

Format per item: **yes/no**, exact command, output, activated fallback (if no).

---

## S1 — Install & version

**Gates:** everything. **On-no:** blocking — stop.

- Command: `cmux --version`
- Output: `cmux 0.64.20 (100) [14e3400b9]`
- Finding: **Installed, yes.** Version drift: design verbs were validated on `0.64.17`; installed is `0.64.20`. Not a blocking "no" by itself — treated as a live re-validation input for every later verb-surface item (S2 etc.), not an assumption carried from 0.64.17.

---

## S2 — Verb-surface audit

**Gates:** all. **On-no:** a missing verb drops its feature to the designed fallback; `events` AND `wait-for` both missing → escalate; `top` missing → quiet timer disabled.

- Commands: `cmux capabilities --json`, `cmux --help`, `cmux docs api` (+ fetched `docs/cli-contract.md`, `docs/events.md` from the manaflow-ai/cmux repo for the full event catalog).
- **Result: every verb the design uses is present at 0.64.20.** Mapping (CLI verb → confirmed):
  - `workspace create/close` → `new-workspace`, `close-workspace` ✓
  - `new-pane` ✓ · `new-surface` (supports `--type terminal|browser|agent-session`, `--provider codex|claude|opencode`) ✓
  - `send` ✓ · `send-key` ✓ · `read-screen` ✓ · `close-surface` ✓
  - `wait-for` ✓ (tmux-compat section, supports `-S`/`--signal`, `--timeout`)
  - `events` ✓ (`--after`/`--after-seq`, `--cursor-file`, `--name`, `--category`, `--reconnect`, `--limit`, `--no-ack`, `--no-heartbeat`; backed by `events.stream` v2 socket method; also durably appended to `~/.cmuxterm/events.jsonl`, capped 4096 in-memory replay events / 16 MiB rotated log)
  - `markdown open` ✓ · `move-surface` ✓ · `reorder-surface` ✓
  - `focus-panel` ✓ — **note:** distinct from `focus-pane` (panes vs. panels are different concepts in this CLI; design references should double check which one is meant per call site)
  - `tree` ✓ · `top` ✓ (`--sort cpu|mem|proc`, `--format tree|tsv` — quiet timer dependency is satisfiable)
  - `identify` ✓ · `ping` ✓ · `notify` ✓ · `trigger-flash` ✓ · `list-notifications` ✓ · `diff` ✓ · `rename-tab` ✓ · `workspace-action` ✓ · `set-status` ✓ · `set-progress` ✓ · `log` ✓
  - `--id-format uuids` ✓ (global flag, confirmed in help header: "pass `--id-format uuids` or `--id-format both`")
- **Per-surface "process exited" event: does NOT exist.** The full event catalog (`events.md`) has `surface.created/selected/focused/closed/moved/reordered/action/input_sent/key_sent` and `pane.created/closed/focused/resized/resize_requested/swapped/broken/joined` — all UI-lifecycle events (surface/pane closed as a *UI element*), none of them signal "the underlying shell/agent process exited." **Finding: the EXIT sentinel is NOT retired by this version's event surface** — `surface.closed`/`pane.closed` fire on UI close, not process termination, so a process that dies while its surface stays open (or vice versa) would not be distinguishable via events alone.
- No finding here contradicts a locked design decision — full verb parity holds despite the 0.64.17→0.64.20 drift, and the sentinel-file design (not the events channel) was already the documented liveness mechanism per decisions on epic #15.

---

## S3 — Socket modes

**Gates:** Phase 1. Feeds remediation text in #3. **On-no (unreachable from inside):** escalate — `allowAll` stays banned.

- Command: `cmux capabilities --json` → `"access_mode": "cmuxOnly"`. Schema fetched: `curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json`, field `automation.socketControlMode`.
- **Real mode names (enum):** `off`, `cmuxOnly` (default), `automation`, `password`, `allowAll`, `openAccess`, `fullOpenAccess`, `notifications`, `full`.
- **A `password` mode does exist** — paired `socketPassword` setting ("Password for password-mode socket access").
- **Does an inside-cmux orchestrator reach the socket in default mode? Yes, confirmed live.** This very orchestrator session is itself a cmux-launched Claude pane (see S4 below — `ps` ancestry traces straight to `/Applications/cmux.app/Contents/MacOS/cmux`), and every `cmux <verb>` call made throughout this session succeeded under `access_mode: cmuxOnly` — no elevated mode, no `allowAll`, needed.
- No contradiction: `allowAll` was never invoked or needed; the design's ban on it stands unaffected.

---

## S4 — Hook-subprocess socket reach

**Gates:** Phase 1. **On-no:** gate/adapter signal falls back to file sentinel only.

- Command: traced process ancestry with `ps -o pid,ppid,command` from the current Bash-tool shell, then ran `cmux ping` from that same shell.
- Ancestry chain observed: `zsh (bash tool shell, pid 60237)` → `claude (pid 34820, launched with --session-id + --settings containing full hook wiring)` → `zsh` → `login` → `/Applications/cmux.app/Contents/MacOS/cmux` (pid 8615) → `launchd`.
- Output: `cmux ping` → `PONG`.
- **Finding: yes — a subprocess several generations removed from the cmux-launched pane process (a `Bash`-tool shell, itself a grandchild-equivalent of the pane's `claude` process) reaches the socket successfully under default `cmuxOnly` mode.** This has in fact been true for *every* command run in this entire spike session — each `cmux` invocation went through a freshly spawned shell subprocess. Strongly suggests **env-based** reach rather than strict direct-parent ancestry (the CMUX_* env vars, e.g. `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID`, are inherited by every descendant shell regardless of generation depth) — consistent with cmuxOnly checking for inherited cmux identity/env rather than a 1-hop parent check.
- No contradiction with locked decisions; the sentinel-file sub-design remains valid as a fallback either way (it doesn't depend on this answer).

---

## S5 — wait-for semantics

**Gates:** Phase 1. **On-no:** stat-before-arm + detached pre-armed waiter; attempt-nonce tokens (already in #3's design).

- **Latch test** — signal fired *before* the waiter arms: `cmux wait-for -S spike-test-a` (exit 0) then `cmux wait-for spike-test-a --timeout 5` → returned in **0.018s**, not the 5s timeout. **Latches: yes.**
- **Normal-order test** — waiter armed first (backgrounded, `--timeout 8`), signal fired ~1s later: waiter released immediately on signal, well under the timeout. Confirms the non-latched path also works as expected.
- **Double-signal test** — same name signalled twice in a row: both calls exited 0, no error; a subsequent waiter still returned immediately (still latched, not un-latched or double-consumed). **Double signal is a safe no-op — does not error, does not break the latch.**
- **Token namespace scope** — `wait-for`'s CLI usage (`cmux --help`, `cli-contract.md`) has **no `--workspace`/`--window` scoping flag**, unlike nearly every other verb in this CLI. Combined with tmux's own `wait-for` precedent (server-global channel namespace, not per-session), this is strong (not directly two-workspace-tested) evidence the **token namespace is global**, not partitioned per sibling workspace — i.e., two unrelated dispatches choosing the same signal name would collide. Design should treat names as needing caller-side uniqueness (e.g. task-id-prefixed).
- No finding contradicts a locked decision — the described fallback (stat-before-arm, nonce tokens) was already the documented mitigation for exactly the collision risk this confirms.

---

## S6 — Native turn-end events + cursor replay

**Gates:** Phase 1 (measurement). **On-no (native emission):** `cmux hooks setup` becomes a consented onboard step. **On-no (no-consumer replay):** demoted to a latency optimization, rank-0 poll tightens 3–5s → 2s.

- **Key structural finding first:** Claude Code is **not** in cmux's generic `hooks setup <agent>` list (fetched `docs/agent-hooks.md` — supported names: codex, grok, opencode, pi, omp, campfire, amp, cursor, gemini, kimi, kiro, rovodev, copilot, codebuddy, factory, qoder — no `claude`). Per that doc: *"Claude Code is handled by the cmux Claude wrapper when Claude Code integration is enabled in Settings."* Confirmed live: this very orchestrator session's own `claude` process (`ps` dump, S4) was launched with an inline `--settings` JSON already wiring `SessionStart`/`Stop`/`SubagentStop`/`SessionEnd`/`Notification`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PermissionRequest` hooks, each shelling out to `cmux hooks claude <event>` (and `cmux hooks feed --source claude` for Stop/SubagentStop). **This exactly matches locked decision (5) on the exit gate — "required later for non-Claude adapters" already anticipated that Claude doesn't need the `hooks setup` step.** No escalation needed; confirms rather than contradicts.
- **Does a Stop-equivalent fire once per completed turn, with which ids populated?** Grepped this session's own `~/.cmuxterm/events.jsonl` (`session_id: claude-d77ec084-076a-4005-a6a8-3263f9154351`) for `hook_event_name:"Stop"`: found paired `agent.hook.Stop` (received→completed) **and** `feed.item.received`/`feed.item.completed` events per turn end — i.e. one Stop hook firing produces both bridges (matches the dual `cmux hooks claude stop` + `cmux hooks feed --source claude` wiring). Populated ids: `session_id`, `workspace_id`, `cwd`, `occurred_at`, `seq`; `tool_name` is `null` for Stop (expected — it's not a tool event). **Event name is `agent.hook.Stop`, not literally `notification.requested`** (`notification.requested` is reserved for explicit "create a notification" socket calls per `events.md` — a different, narrower event than turn-end).
- **Cursor durability / no-consumer replay — directly tested, not inferred:** captured the current `seq` (816) into a cursor file with **no `cmux events` subscriber running**, triggered a couple of ordinary tool calls (which independently fire `PreToolUse` hooks), then reconnected with `cmux events --cursor-file <file> --limit 3`. Result: ack showed `"replay_count": 12, "resume": {"after_seq":816, "gap": false, "latest_seq":828, "next_seq":829}` and the 3 events streamed were exactly the ones generated while unattached. **Confirmed: yes — events fired with no consumer attached ARE delivered on next attach via `--cursor-file`.** This is the strong path — no demotion to latency-optimization-only needed.
- **Not tested this session (destructive):** durability of the cursor/events log across a **full cmux app quit + relaunch** — that would kill this very orchestrator pane (it's a cmux-launched surface). Deferred to S20, which covers exactly this and needs explicit user coordination before running (see S20 below).
- No contradiction with locked decisions on this item; strengthens confidence in decision (5).

---

## S7 — Kickoff mechanics

**Gates:** Phase 1. **On-no:** `send-key enter` after a settle delay.

- Opened a real test pane (`cmux new-pane --type terminal --focus false` → `surface:2 pane:2 workspace:1`, visible in your cmux window) and drove it directly.
- `cmux send --surface surface:2 "echo hello-from-send-test"` → `read-screen` showed the text sitting on the prompt line, **not executed** (no output line appeared).
- `cmux send-key --surface surface:2 enter` → `read-screen` now shows `hello-from-send-test` printed and a fresh prompt.
- **Finding: `send` does NOT auto-submit — no trailing newline/Enter is sent.** A following `send-key enter` is required. This is the "on-no" fallback and it's exactly what's needed here (not a bug — this is just how the transport behaves, confirmed rather than assumed).
- **Claude-TUI auto-submit — now directly tested (real API spend, with your go-ahead):** `cmux send --surface <s> 'claude "reply with exactly the word: PONG-TEST"'` + `send-key enter` (submitting the *outer shell* command, per the transport finding above) → the launched `claude` process **did auto-submit the prompt with zero further input**: screen showed the prompt echoed, a real response (`PONG-TEST`), and cost ticked to $0.22/3%. **Finding: yes — `claude "<prompt>"` auto-submits in interactive mode when it's the plain/simple argv form.**
- **Important caveat discovered while confirming this — `read-screen` can lag behind real completion.** A near-identical run showed a frozen `✻ Sautéed for 3s` spinner in `read-screen` for 10+ seconds after the turn had actually already completed (confirmed via `~/.cmuxterm/events.jsonl` showing `Stop` fired ~4s in). **Screen-scraping is not a reliable completion signal on its own** — this is exactly why the design treats hook/event signals as authoritative and screen-reads as supplementary. Noted as a design-reinforcing finding, not a contradiction.
- **A second, more significant discovery — reproducible silent stall on `--add-dir`.** Testing the combination `claude --permission-mode dontAsk --add-dir /tmp/cmux-spike-scope "reply with exactly the word: ADDDIR-TEST"`: the process launched (`SessionStart` fired) but **never reached `UserPromptSubmit`** even after 15+ seconds, 0.6% idle CPU, no visible dialog/error on-screen, and a follow-up `send-key enter` didn't unstick it. Bisected by removing just `--add-dir` (keeping `--permission-mode dontAsk` and the same prompt): **completed normally in ~5s** (`SessionStart` → `UserPromptSubmit` → `Stop`, confirmed via events log). **Finding: `--add-dir <path-outside-the-repo>` combined with an argv prompt reproducibly causes the prompt to never submit, silently, with zero on-screen indication.** This directly matters for dispatch, since worker panes plausibly need `--add-dir` to grant access to a task directory living outside the primary checkout (`//abs/task-dir`). **Escalating to architecture-lead before Phase 1** — this is a real, reproduced silent-stall risk at *kickoff* time, a sibling case to S10's mid-conversation stall concern, not the same mechanism (not a permission-prompt stall — happens before the prompt is even accepted).

---

## S8 — Installed `claude` audit

**Gates:** #4. **On-no:** adapter `capabilities` reports the missing slot; dispatch refuses that role with a hard stop + remediation.

- Commands: `claude --version` → `2.1.220 (Claude Code)`; `claude --help` (full flag dump).
- `--tools <tools...>` ✓ — confirmed comma-separated form: *"Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read")."*
- `--allowedTools`/`--disallowedTools` ✓ exist (also as `--allowed-tools`/`--disallowed-tools`) — **but accept comma OR space separated**, not strictly space-separated as assumed (e.g. `"Bash(git *) Edit"`). Not a break (space still works), just a broader accepted form than documented in the design.
- **`--append-system-prompt-file` / `--system-prompt-file`: DO NOT EXIST.** Only inline-string forms are present: `--system-prompt <prompt>` and `--append-system-prompt <prompt>`. There is no file-path variant of either. **This contradicts the design's assumption of a `--append-system-prompt-file` flag** (used directly by S8's own dependents and centrally by S16). Per S8's own on-no clause, this is exactly the "missing slot" case: the composed argv must instead read the role-body file into memory and pass its contents as the inline `--append-system-prompt "$(cat file)"` string (or via `--settings`'s equivalent field, not yet located) — **flagging for architecture-lead review before Phase 1**, since #4's dispatch argv composition and S16 both assumed a file-path flag that isn't there.
- `--permission-mode <mode>` ✓ — choices include `dontAsk` exactly as assumed (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`).
- `--plugin-dir <path>` ✓ — repeatable, directory or `.zip`, session-scoped only.
- `--add-dir <directories...>` ✓.
- `--disable-slash-commands` ✓ — exists, though its own help text describes it as "Disable all skills" (naming mismatch between flag and description worth double-checking against actual behavior in S13, not just the flag's presence).
- `--effort <level>` ✓ — `low, medium, high, xhigh, max`, matches exactly.
- Also present but outside this item's scope: `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions` exist (confirms bypass modes are technically available in this CLI — consistent with the design's explicit ban on ever using them, S10).
- **Escalation flag:** the missing `--append-system-prompt-file` finding contradicts a design assumption feeding both #4 and S16 — recorded here, routed to architecture-lead before Phase 1 per the recording rule.

---

## S9 — Scoped return grant / S10 — Executor stall test (combined — same test series)

**S9 gates:** #4 (profiles' shape; Phase 2 inherits). **On-no ladder by failure layer:** (1) rule-kind → widen `Edit(...)` to cover Write · (2) anchor → per-task `--settings` file · (3) scoping unavailable → relocate `returns/` outside repo (needs ratification) · (4) terminal → STOP AND ESCALATE.
**S10 gates:** Phase 1 — High-severity silent-stall risk. **On-no:** judgment roles lose Bash entirely; executors get stall-triage + auto-nudge; escalate before any bypass mode (all banned).

**First, a load-bearing discovery that affects both items and was not anticipated by the design: a CLI argv-composition bug that silently swallows the prompt.**

- Bisected across 5 live `claude` launches (events-log-verified, not screen-scraping — see the `read-screen`-lag caveat under S7): `claude --permission-mode dontAsk "<prompt>"` (no other flags) submits fine. Adding **either** `--add-dir <path>` **or** `--allowedTools "<rule>"` before the bare prompt positional argument causes the session to start (`SessionStart` fires) but the prompt is **never submitted** (`UserPromptSubmit` never fires) — silently, no error, no dialog, `read-screen` just shows an empty, idle prompt box indefinitely.
- Root cause, confirmed by fix: `--add-dir <directories...>` and `--allowedTools <tools...>` are **variadic** options (note the `...`). Commander.js-style variadic parsing greedily consumes the following bare positional argument (the prompt) into the flag's own array instead of treating it as `prompt`. **Fix: insert a bare `--` before the prompt** — `claude --permission-mode dontAsk --add-dir /path -- "<prompt>"` submitted normally (`SessionStart` → `UserPromptSubmit` → `Stop` in ~5s, confirmed via events). Retested and reproduced identically for both flags, both with short and long prompts (4 independent reproductions, 1 independent fix confirmation).
- **This is a real, load-bearing bug the design's dispatch-argv composition (#4) must account for — flagging for architecture-lead before Phase 1.** Any composed argv using `--add-dir` and/or `--allowedTools`/`--disallowedTools` (i.e. almost every real dispatch) **must** insert `--` before the prompt positional, or the worker pane will silently sit idle forever with zero signal that anything is wrong — a worse failure mode than S10's own anticipated "stall," because even the file-sentinel/event-based liveness signals never even start (no `UserPromptSubmit`, so nothing downstream ever fires either).

**S9 — scoped Write grant, tested with the `--` fix applied:**

- `claude --permission-mode dontAsk --allowedTools "Write(/abs/path/.spike-scope-test/returns/**)" -- "<prompt: write to that exact path, then reply DONE>"` → **Write was denied** (`"Permission to use Write has been denied because Claude Code is running in don't ask mode"`), even though the path matched the allow pattern exactly (tested both a relative and an absolute-path pattern — same denial both times).
- In the same run, an **un-listed Bash command ran successfully** (not denied, not prompted) — Bash wasn't in `--allowedTools` at all.
- Isolated further: `--allowedTools "Write"` (bare tool name, **no** path pattern) → **Write succeeded**, file written correctly.
- **Finding: the parenthetical path-scoping syntax `Write(pattern)` is not honored for the Write tool via `--allowedTools` on this installed version — only the bare tool name works, and that grants unscoped Write access, not path-limited access.** This is failure layer (1)/(3) from S9's own ladder ("rule-kind" / "scoping unavailable") — **confirmed independently for Write** (the design's own example was `Edit(...)`, not directly tested here; worth a quick follow-up check since Edit's pattern support may differ from Write's).
- **Not yet tested:** whether the same path-pattern scoping works via a `--settings` JSON permissions block instead of the `--allowedTools` CLI flag (the design's own layer-2 fallback, "per-task settings file") — this is the next thing to verify before concluding scoping is unavailable outright via every mechanism, not just this one flag.
- **Escalating to architecture-lead before Phase 1:** the core security assumption ("planner-profile session can write only its return file, denied not prompted elsewhere") is **not achieved by the mechanism assumed** — needs either the `--settings`-file path-scoping to work (untested), or the design to accept a coarser unscoped-Write-plus-`git status --porcelain`-detection fallback (already the documented alternative for a terminal S9 failure).

**S10 — Bash stall vs. tool-error, tested in the same runs:**

- The un-listed Bash command in the S9 test above **ran to completion silently** — it was neither denied-with-a-tool-error nor did it raise an interactive permission prompt; it simply executed. **This means `--allowedTools` in `dontAsk` mode did not act as a strict allowlist for Bash at all in this test** (Bash wasn't in the list, yet ran) — a different, arguably more concerning shape than the item anticipated (it worried about a stall; what actually happened here is the opposite failure — an *unlisted* tool running when it should have been denied).
- This strongly suggests **`dontAsk` mode's actual per-tool default differs by tool**: Write/Edit appear denied-by-default unless explicitly allowed (matching S9's finding), while Bash may default to allowed-unless-explicitly-*disallowed* — i.e. `--allowedTools` might function as an *additive allow-list only for tools that default-deny*, not a universal allowlist that implicitly denies everything else. **This needs a dedicated follow-up test with `--disallowedTools "Bash"` explicitly set, to see whether an explicit deny (rather than just omission from allow) produces the hoped-for "tool error, turn proceeds" behavior** — not yet run, flagging as the next concrete step rather than guessing further.
- **Escalating to architecture-lead alongside S9:** the assumed dontAsk semantics (allowedTools as a closed allowlist, everything else denied) do not match observed behavior for Bash. The design's "High-severity silent-stall risk" framing may need to become a "high-severity silent-non-denial risk" framing instead, pending the `--disallowedTools` follow-up.

**Follow-up run — `--disallowedTools "Bash"` (explicit deny, not just omission from an allow-list):**

- `claude --permission-mode dontAsk --disallowedTools "Bash" -- "Attempt to run the bash command: echo forbidden-test using the Bash tool. Then reply with exactly the single word: DONE."` → completed cleanly to `DONE` in ~17s, **no visible Bash attempt, no error block, no stall.**
- Events log for this run (filtered by the launched process's pid) shows **no `PreToolUse` for `Bash` at all** — the model's only tool interaction was a `ToolSearch` call (it looked for a deferred tool and, finding Bash unavailable, gave up and answered directly) — then `Stop`. **Confirmed: an explicit `--disallowedTools` entry removes the tool from the model's available set entirely; it's never attempted, never errors, never prompts, and the turn proceeds normally.** This is the cleanest possible outcome — better than "tool error, turn continues," because there's no error path to reach at all.
- **Conclusion for S9+S10 together:** the safe, confirmed-working mechanism is **`--disallowedTools`** as an explicit blocklist (clean, no-stall, no-silent-execution). **`--allowedTools` should not be relied on as an implicit "everything else is denied" allowlist** — at minimum Bash, and by extension possibly other tools, fall through to their own tool-level default rather than being blocked by omission. Recommend the design pair every dispatch's tool restriction with **both**: a narrow `--allowedTools` for what's needed, **and** an explicit `--disallowedTools` for everything sensitive that must not run (don't rely on omission alone) — and separately resolve S9's still-open path-scoping question (`--settings`-based rules, untested) before Phase 1.

---

## S12 — `--settings` as hook source

**Gates:** none (opportunistic). **On-no:** nothing — the static plugin (or, per S6, the Claude wrapper) is primary.

- Already directly confirmed as a side effect of S4/S6, not opportunistically guessed: this very orchestrator session's own `claude` process (`ps` ancestry dump) was launched with an inline `--settings {...}` JSON blob containing a full `hooks` object (`SessionStart`, `Stop`, `SubagentStop`, `SessionEnd`, `Notification`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`), and those hooks are live-firing right now (S6's `agent.hook.*` event trail).
- **Finding: yes — `--settings` is not just an opportunistic hook source, it is cmux's actual primary mechanism for Claude Code specifically** (the wrapper injects hooks via `--settings`, not via a `--plugin-dir`-based static plugin — see S6/S11). This slightly upgrades the item's own framing ("opportunistic only... docs list plugin dirs... but not `--settings`") — for Claude, `--settings` *is* the documented, working, primary path today, live-verified rather than opportunistically discovered.
- No contradiction; refines S11's on-no fallback ordering (see S11 below).

---

## S11 — Worker plugin hook delivery

**Gates:** #4. **On-no:** try S12 (already yes); if both fail, drop the return-gate.

- Checked this session's own exact launch argv (`CMUX_AGENT_LAUNCH_ARGV_B64` decoded, cross-checked against `ps -p 34820 -o command=`): `claude --session-id <uuid> --settings {...hooks...}` — **no `--plugin-dir` was used to launch this pane.** The dev-team plugin's own hook (the `SessionStart` injection of `orchestration.md` that governs this whole conversation) is delivered through the user's normal marketplace/`enabledPlugins` install path, not a per-dispatch `--plugin-dir`.
- **Not yet directly tested:** whether a plugin loaded specifically via the **`--plugin-dir`** CLI flag (the design's "static worker plugin" mechanism, distinct from a marketplace-installed plugin) has its `Stop`/`UserPromptSubmit` hooks actually fire in a dispatched pane. This needs an actual `claude --plugin-dir <test-plugin>` launch to observe — real API spend (a minimal one, but real). Held for the same go/no-go as S7's remainder.
- **Already de-risked by S12:** since `--settings`-injected hooks are confirmed live and working (this whole session is proof), the on-no fallback ("try S12") is **already satisfied** regardless of how `--plugin-dir` itself behaves — worst case, the worker plugin's hook logic can be expressed as `--settings` hook commands instead of a plugin-dir hooks.json. This substantially de-risks the item even before the direct test runs.
- **Directly tested (real API spend) — yes, it works.** Built a minimal test plugin at `/tmp/spike-test-plugin/` (`.claude-plugin/plugin.json` + `hooks/hooks.json` wiring `SessionStart` → an `additionalContext` + `systemMessage`, `Stop` → append to a log file, `UserPromptSubmit` → append to a log file). Launched `claude --plugin-dir /tmp/spike-test-plugin --permission-mode dontAsk -- "Reply with exactly the word: PLUGINTEST-DONE"`.
  - On-screen: `⎿ SessionStart:startup says: SPIKE-PLUGIN-SESSIONSTART-FIRED` — the systemMessage rendered visibly.
  - `/tmp/spike-plugin-ups.log` → `SPIKE-PLUGIN-UPS-FIRED` (UserPromptSubmit fired).
  - `/tmp/spike-plugin-stop.log` → `SPIKE-PLUGIN-STOP-FIRED` (Stop fired).
  - **Finding: yes — a static worker plugin loaded via `--plugin-dir` has its `Stop` and `UserPromptSubmit` hooks (and `SessionStart`) delivered and executed in the dispatched pane, exactly as it would in a normal terminal session.** No escalation needed — the primary mechanism works, independent of the S12 fallback.

---

## S13 — Injection suppression

**Gates:** Phase 1. **On-no:** `--disable-slash-commands` + an explicit worker line in the substrate addendum.

- **Does `DEVTEAM_WORKER=1` reach the pane session env? Yes, directly tested.** `cmux new-workspace --name spike-env-test --env DEVTEAM_WORKER=1` → spawned a terminal in that workspace → `echo $DEVTEAM_WORKER` printed `1`. Confirmed mechanism: `cmux new-workspace --env KEY=VALUE` (or `--env-file`), documented in `cli-contract.md` under "Workspace environment variables" — every shell spawned in that workspace inherits it, which would include a `claude` process launched there.
- **Does a SessionStart guard suppress orchestration injection? Not testable as "does an existing guard work" — it doesn't exist yet.** Checked this repo's actual `hooks/hooks.json` directly: it has no `DEVTEAM_WORKER` check at all today — it unconditionally injects `orchestration.md` on every `SessionStart`. This is exactly the still-open work tracked by issue #5 ("orchestration.md delta, hooks guard, cmux-dispatch reference"), not a behavior to test against cmux. The env-var propagation finding above confirms the *building block* the guard would need is available; the guard itself is a build task, not a spike finding.
- **Is the one-line systemMessage visible? Yes, directly confirmed** (same test as S11): a `SessionStart` hook's `systemMessage` field rendered on-screen as `⎿ SessionStart:startup says: <message>` in the pane's TUI, exactly like a normal terminal session.
- No contradiction with a locked decision; confirms the env-propagation and systemMessage-visibility building blocks are both available for whoever implements issue #5's guard.

---

## S14 — Pane injected-context capture

**Gates:** Phase 1 (measurement — feeds S15 and the documented fidelity delta).

- Directly observed via the S11/S13 test plugin run and this whole spike session itself (this orchestrator session **is** a cmux-launched pane): a cmux-launched `claude` pane receives the **full normal session context**, not a reduced subagent-style context — confirmed present in this session and the test pane: `SessionStart` hook injection (both the dev-team plugin's `orchestration.md` in this session, and the test plugin's `additionalContext`/`systemMessage` in the S11 test), full hook lifecycle (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`), MCP server awareness (`⚠ 1 MCP server needs authentication · run /mcp` banner appeared in every launched pane, meaning MCP config is loaded same as an interactive session), and this repo's own project `CLAUDE.md`-equivalent tooling (plugin skills, slash commands) — none of that is stripped.
- **Comparison to today's Agent-tool subagent:** a subagent (e.g. `dev-team:coder`) gets a scoped tool allowlist and a role-specific prompt but does **not** get the user's installed plugins, hooks, or MCP servers at all — it's a clean-room context. A cmux pane, by contrast, **is a full Claude Code session** with everything the user's own environment provides (all installed/enabled plugins' hooks, MCP servers, skills), **unless** explicitly stripped via `--plugin-dir` isolation, `--strict-mcp-config`, `--setting-sources`, or `--bare`/`--safe-mode`.
- **Fidelity delta, stated plainly:** a cmux-dispatched pane is higher-fidelity but also higher-surface-area than a subagent — it inherits the *entire* ambient plugin/MCP/hook environment by default, which is a feature (S16/S15 both build on this closer-to-real-session fidelity) but also a containment concern: a worker pane launched without explicit isolation flags will run with the orchestrating user's full plugin set active, including this very dev-team plugin's own orchestration injection (relevant back to S13 — the guard is what's supposed to prevent a worker pane from re-triggering full orchestrator behavior on itself).
- No contradiction with a locked decision; this measurement is exactly what #4's profile design needs to decide which isolation flags (`--plugin-dir`-only vs full ambient environment) each dispatched role should use.

---

## S16 — Append vs replace fidelity

**Gates:** #4. **On-no:** replace + an explicit harness preamble. (Note: as found in S8, there is no `--append-system-prompt-file`/`--system-prompt-file` — both forms here are the inline-string variants, `--system-prompt`/`--append-system-prompt`.)

- **Replace test:** `claude --system-prompt "You are a pirate captain. Respond only in pirate speak, one short sentence." -- "What are you and what tools do you have access to?"` → response: *"Arrr, I be Claude Code, cap'n o' a dev-team crew, armed wi' tools fer readin' an' writin' files, runnin' shell commands, spawnin' agent mateys..."* — **the persona instruction took effect (pirate speak), but the underlying session identity ("Claude Code", "dev-team crew") still leaked through**, even though `--system-prompt` is documented as a full replace of the default system prompt.
- **Append test:** `claude --append-system-prompt "Also respond only in pirate speak, one short sentence, in addition to anything else." -- "What are you and what tools do you have access to?"` → response was a **normal, detailed, non-pirate** answer ("I'm Claude Code, Anthropic's CLI coding agent... dev-team orchestrator...", full tool breakdown) — **the appended instruction was effectively ignored.**
- **Root cause (consistent with S13/S14's finding):** this repo's dev-team plugin is globally enabled and its `SessionStart` hook unconditionally injects `orchestration.md` as `additionalContext` — a mechanism **separate from and additive to** whatever `--system-prompt`/`--append-system-prompt` set. Hook-injected context survives a full system-prompt *replace*; a plain instruction *appended* to the system prompt was outweighed by that same large injected context block competing for behavioral priority.
- **Finding: neither flag alone gives a role body clean, guaranteed isolation from ambient hook-injected context.** `--system-prompt` (replace) is the closer of the two to what a role body wants (it did shift tone), but a real worker-role body still needs the S13 guard (suppressing the orchestration injection itself via `DEVTEAM_WORKER`) to avoid identity/context bleed-through — the choice between replace/append doesn't substitute for that guard.
- **Escalating alongside S13:** #4's role-body composition should assume **replace** (`--system-prompt`, not `--append-system-prompt`) as the base, but explicitly still depends on the S13 SessionStart guard actually being built — without it, neither flag fully isolates a role body.

---

## S17 — Bash block ceiling

**Gates:** Phase 1 (determines #3's `await` chunk size). **On-no/low:** `await` chunks at 90s and the orchestrator loops.

- Source: the orchestrator's own Bash tool definition (available in this session's tool schema, not something to probe blindly): *"You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms."*
- **Finding: ceiling is 600,000 ms (10 minutes) per single Bash call, with a 120,000 ms (2 minute) default when no explicit timeout is passed.** This is materially higher than the 90s chunking the on-no fallback assumed — #3's dispatcher can safely `await` in chunks up to 10 minutes (or default to 2 minutes without specifying), not 90 seconds, before needing to loop.
- Not a contradiction of a locked decision — it's a more generous ceiling than the fallback assumed, so the fallback's 90s chunk size is conservative-safe but could be widened as a follow-up tuning, not a blocker.

---

## S18 — Markdown as sibling tab

**Gates:** #6. **On-no:** browser surface tab → split pane, in that order.

- `echo "..." > /tmp/cmux-spike-test.md && cmux markdown open /tmp/cmux-spike-test.md --focus false` → opened in its **own new pane** (`surface:3`/`pane:3`), not automatically as a sibling tab.
- `cmux move-surface --surface surface:3 --pane pane:2 --focus false` (pane:2 = an existing test terminal pane, `surface:2`) → `cmux list-pane-surfaces --pane pane:2` showed **both surfaces as sibling tabs of the same pane** (`surface:2` terminal, `surface:3` markdown). **Confirmed: yes, `markdown open` + `move-surface` renders it as a sibling tab.**
- **Displayed-surface test (the item's sharpest sub-question):** explicitly focused the terminal tab first (`cmux focus-panel --panel surface:2` — note: `focus-panel`'s `--panel` target is actually a **surface** ref; it's documented as "a compatibility alias over surface focus," not a pane operation despite the name), confirmed `surface:2` was `[selected]` and `surface:3` was not. Then ran **`cmux reorder-surface --surface surface:3 --before surface:2`** with no separate focus call. Result: `surface:3` became `[selected]` immediately. **Finding: `reorder-surface --before` alone DOES make the doc tab the displayed surface — a separate `focus-panel` call is not needed.** Clean, direct answer, not inferred.
- **Not tested (would require an actual app restart):** does the panel survive a mid-task cmux restart — deferred to S20 (destructive, needs coordination).
- **Live-reload across the move:** appended a line to the underlying file after the move; no error/detach observed on the surface, consistent with reload surviving, but I have no non-visual way to confirm the *rendered* markdown content actually refreshed (this is a GUI-visible detail) — flagging for you to eyeball in the cmux window if you want a stronger confirmation than "no crash."
- No contradiction with a locked decision; strengthens confidence — reorder-surface's side effect on display is a genuinely new, useful finding (not something the design could have assumed without testing).

---

## S19 — Collapse on close

**Gates:** Phase-2 polish only. **On-no:** default stands — doc tab first, keep the terminal.

- With `pane:2` holding two sibling surfaces (`surface:2` terminal, `surface:3` markdown, from S18), ran `cmux close-surface --surface surface:2`.
- `cmux tree --all` afterward: `pane:2` **still exists**, now containing only `surface:3` (markdown), selected and active — the pane collapsed to its one remaining tab rather than closing itself.
- **Finding: yes — closing one of several sibling surfaces collapses the pane to its remaining tab(s); the pane itself only closes when its last surface closes.** Directly confirmed, not inferred.
- Minor oddity, not a real finding: `close-surface`'s own `OK` response line referenced a `surface:4` id that never appears in the subsequent tree — likely an internal id-counter artifact of the close response, not a hidden surface; noted for completeness, doesn't affect the conclusion.
- No contradiction with a locked decision.

---

## S21 — Provider surfaces

**Gates:** #3's pane-creation choice. **On-no:** terminal-surface + adapter wrapper stays the baseline (already the default); native resume is forgone — recovery is file-based by design.

- `cmux new-surface --type agent-session --provider claude --focus false` → created `surface:43`, kind **`agentSession`** (confirmed via `cmux tree --all`: `surface surface:43 [agentSession] "Claude Code · React"`) — this is a **structurally different surface kind from a plain `terminal`**, with what its own title implies is a React-rendered UI, not a raw PTY.
- `cmux read-screen --surface surface:43` → **`Error: invalid_params: Surface is not a terminal`.** The design's core dispatch primitives (`send`, `send-key`, `read-screen`) are terminal-only and **do not work against an `agentSession` surface at all.**
- `new-surface`'s own flag surface (`cmux --help`) has **no `--model`, no system-prompt flag, no permission-mode flag** — only `--type`, `--pane`, `--workspace`, `--window`, `--url`, `--provider`, `--renderer`, `--focus`. There is no argv passthrough to forward `--model`/system-prompt/permission flags into an `agent-session` surface at all, so the question of *whether* it forwards them is moot — **the mechanism to pass them doesn't exist on this verb.**
- Resume behavior: not tested (moot given the above — there's no argv-level control surface to resume into in the first place via this path).
- **Finding: `new-surface --provider claude` is a dead end for this design's dispatch mechanism** — it creates a UI-native, non-terminal, non-scriptable surface with no flag passthrough. **This directly confirms (does not contradict) the on-no fallback already locked in**: terminal-surface + adapter wrapper (i.e., exactly the approach used in every other test this session — `new-pane`/`new-surface --type terminal` running the `claude` CLI as an ordinary subprocess) is correct and necessary, not just a fallback of last resort.

---

## S15a — Crude cost probe

**Gates:** profile design in #4. **On-no (overhead looks material):** trim worker context (`--setting-sources`, MCP off) before building. **(S15b — full measurement — explicitly deferred to the Phase-2 GO/NO-GO, not this session.)**

Same tiny fixed spec ("How many lines are in package.json? Reply with just the number.") run two ways:

- **Manual pane** (`claude --print --output-format json --permission-mode dontAsk "<spec>"`, i.e. the same CLI mechanism #4's dispatch would use): `usage: {input_tokens:4, cache_creation_input_tokens:9073, cache_read_input_tokens:40433, output_tokens:120}` → **~49,630 total tokens**, `total_cost_usd: $0.228`, `duration_ms: 11049`.
- **Subagent** (Agent tool, `general-purpose`, identical spec): **`subagent_tokens: 23817`** total (not broken into input/cache/output — the Agent tool doesn't expose that split), `duration_ms: 3413`.
- **Finding: the manual pane cost ~2.1× the subagent's total tokens and took ~3.2× longer for an identical trivial spec.** This sits **right at the edge of the design's own stated ceiling ("≤2× subagent cost")** on the very first, cheapest possible probe — before any of the additional overhead a real dispatch adds (a role-specific system prompt, `--plugin-dir`/`--settings` hook wiring, a larger allowed-tools list, actual task content). **Flagging as a real risk signal for the Phase-2 GO/NO-GO (S15b), not a pass/fail here** — this crude number alone doesn't confirm the ceiling will be breached under real conditions, but it leaves very little headroom, and the direction (pane costs more, not less) is unambiguous.
- Caveat on rigor: only one trial each (not repeated for variance), and the two harnesses report cost differently (CLI gives full input/cache/output breakdown + `total_cost_usd`; Agent tool gives one aggregate number) — a like-for-like breakdown is part of what S15b needs to do properly with the real dispatcher.

---

## S20 — Restart durability

**Gates:** #8. **On-no:** the rank-0 file watch is the recovery path; `status` re-arms.

**Deferred — not run this session, by explicit user decision.** This item requires a full `cmux` app quit + relaunch, which would kill this very orchestrator session (it's itself a cmux-launched pane — confirmed repeatedly throughout this spike, e.g. S3/S4). You chose to defer this rather than end the session mid-spike. To complete it: quit and relaunch cmux, then re-open this task directory and this findings file to run a `wait-for` token durability check and confirm whether a moved panel (from S18) persists across the restart.

- The design's own on-no fallback ("the rank-0 file watch is the recovery path") is **independent of this item's outcome either way** — it's already the documented recovery mechanism regardless of whether `wait-for` tokens or moved panels happen to survive a restart, so this gap does not block Phase 1 planning; it only needs to be closed before depending on any *in-memory* durability assumption.
- No finding recorded (untested) — carried forward as an open item for the next session or a dedicated restart-coordination pass.

---

## Exit gate

**Findings file:** 20 of 21 items answered (yes/no + command + output + activated fallback where relevant). S20 deferred — needs a coordinated cmux restart, tracked as an open follow-up, not blocking.

**Findings escalated to architecture-lead before Phase 1** (per the recording rule — these either contradict a design assumption or need a decision before #3/#4 are built):

1. **S7 — silent-stall bug in argv composition.** Any composed `claude` launch using a variadic flag (`--add-dir`, `--allowedTools`, `--disallowedTools`) before the prompt positional silently never submits unless a bare `--` separator is inserted first. Must be baked into #4's argv builder as a hard rule, not an afterthought.
2. **S8 — no `--append-system-prompt-file`/`--system-prompt-file` flag exists.** Only inline-string `--system-prompt`/`--append-system-prompt`. #4's argv composition must read role-body files into memory and pass contents inline (`--system-prompt "$(cat file)"`), not assume a file-path flag.
3. **S9 — path-scoped `Write(pattern)` rules via `--allowedTools` are not honored** (tested both relative and absolute patterns; only a bare unscoped `Write` works). The "planner can write only its return file" security goal is **not achieved by this mechanism as tested**. Untested fallback: the same path-scoping via a `--settings` JSON permissions block (design's own layer-2 option) — needs a follow-up test before concluding scoping is unavailable outright.
4. **S10 — `--allowedTools` is not a closed allowlist.** A tool omitted from `--allowedTools` (Bash, in the test) still ran, unprompted, undenied. Only an explicit `--disallowedTools` entry reliably blocks a tool (cleanly — the model never attempts it, no stall, no silent execution). Recommend the design always pair a narrow `--allowedTools` with an explicit `--disallowedTools` for everything sensitive, rather than relying on omission.
5. **S13/S16 — the SessionStart orchestration-injection guard is a hard dependency, not a nice-to-have.** This repo's `hooks/hooks.json` has no `DEVTEAM_WORKER` guard today (tracked separately as issue #5). Confirmed the env-var building block works (`cmux new-workspace --env DEVTEAM_WORKER=1` propagates correctly) and that hook-injected context survives *both* `--system-prompt` (replace) and `--append-system-prompt` (append was effectively ignored under context pressure) — so neither flag substitutes for the guard. `--system-prompt` (replace) should be the default choice for role bodies, but Phase 1 depends on issue #5 actually landing the guard.

**Findings that confirm rather than contradict a locked decision** (recorded for completeness, no escalation needed): S3 (socket reach), S4 (env-based grandchild reach), S5 (wait-for latch/global-namespace), S6 (native hook emission + no-consumer replay both work — directly confirms decision (5)'s "required later for non-Claude adapters" framing), S11 (`--plugin-dir` hooks fire correctly), S12 (`--settings` is the *primary*, not just opportunistic, mechanism), S17 (10-minute Bash ceiling, more generous than assumed), S18/S19 (markdown sibling-tab + collapse-on-close both work as designed, with one new usable detail: `reorder-surface` alone changes the displayed tab), S21 (native `agent-session` surfaces are confirmed unusable for this design — validates the terminal-surface fallback as the necessary path, not a fallback of last resort).

**S2 note carried forward (not an escalation, a standing constraint):** no per-surface "process exited" event exists in this cmux version — the file-sentinel design remains necessary, not optional, regardless of events-channel improvements.

**Six standing decisions (from the issue body) — status after this session:**

1. Always archive the task dir when any dispatch failed, even with `keep_task_artifacts: false` — unaffected by this session's findings; still to be ratified by you.
2. Output-contract tightening (lead required-sections + reviewer verdict blocks) — unaffected; still to be ratified by you.
3. Workers get zero cmux access (signalling lives in the gate/adapter) — unaffected; still to be ratified by you.
4. Delegated Tier-1 edits run as a single pane in the orchestrator's existing workspace — unaffected; still to be ratified by you.
5. The plugin never runs `cmux hooks setup` itself (consented onboard step only if S6 fails; required later for non-Claude adapters) — **S6 did not fail** (native hooks + replay both confirmed working), so per this decision's own framing, Claude needs no onboard step; still needed for other adapters when they're built. Ratified by this session's evidence.
6. This spike session itself — the session ran; findings recorded; one item (S20) deferred with your explicit sign-off.

**No finding contradicts a locked design decision outright** — the five escalation items above are gaps/refinements the design needs to account for before Phase 1, not reversals of decisions already made.
