# herdr substrate spike findings

Task: SF-14 herdr substrate spike. Source: issue #53. Target: `herdr 0.8.0`.

Findings are either live-verified with the capture inline or explicitly marked `unverified` — no third state. Every claim below was re-verified against 0.8.0; the issue's 0.7.1 field notes are treated as hypotheses, not inputs.

Execution note: this builder shell's inherited `HERDR_ENV` is unset, but the client reached the local 0.8.0 server when commands were run with an explicit `HERDR_ENV=1` override. Throwaway workspaces `w6` and `w7` were created with `--label herdr-spike-r1`/`herdr-spike-r1b`, used only for the captures below, and explicitly closed; no crew workspace was touched.

## Contract mapping

The row set is exhaustive: it is the ten `cmux(...)` call shapes used by the crew.

| cmux call | herdr equivalent | verdict | note |
|---|---|---|---|
| `new-workspace --name crew-<slug> --cwd <checkout> --layout <BSP JSON> --focus true` | `workspace create`, then `tab create`/`pane split` | degraded | Workspace creation is available, but the cmux one-call declarative BSP layout and focus semantics are not one herdr command. |
| `tree --json --id-format uuids --all` | `api snapshot` plus `workspace/tab/pane list` | degraded | The snapshot has topology and opaque IDs, but it is not the cmux window → workspace → pane → surfaces tree. |
| `send --surface <id> -- <line>` | `pane send-text <pane-id> <line>` | equivalent | Literal text can be sent without Enter; target changes from surface to pane. |
| `send-key --surface <id> -- enter\|ctrl+u\|ctrl+c` | `pane send-keys <pane-id> enter\|ctrl+u\|ctrl+c` | equivalent | The needed key names are in the 0.8.0 pane surface. |
| `read-screen --surface <id> --lines 40` | `pane read <pane-id> --lines 40` | equivalent | Herdr additionally makes the read source explicit; use a bounded recent source for echo checks. |
| `rename-tab --surface <id> -- <title>` | `tab rename <tab-id> <title>` | degraded | A cmux surface identifies a tab inside a pane; herdr renames a peer tab, not a surface in a pane. |
| `close-surface --surface <id> --window <id>` | `tab close <tab-id>` or `pane close <pane-id>` | degraded | There is no surface-level close. Choosing tab close closes the whole herdr tab; choosing pane close closes its pane. |
| `close-workspace --workspace <id>` | `workspace close <workspace-id>` | equivalent | Explicit workspace IDs are supported. |
| `set-status crew-stage <label> --workspace <id>` | `workspace report-metadata <workspace> --token crew-stage=<label>` | degraded | The token write persisted in JSON, but visual stage-pill rendering and long-stage lifetime were not verified; the capture used a 60-second TTL. |
| `markdown open <path> --workspace --window` | none | absent | Herdr has no markdown surface or tabs-inside-a-pane operation. A viewer in a pane would lose cmux's live-watching sibling surface. |

The adapter seam absorbs command spelling, opaque-ID resolution, text/key input, bounded reads, and workspace lifecycle. It partially absorbs stage metadata through a `crew-stage` token, but the UI contract remains degraded until rendering and lifetime are verified. It leaks at the object boundary: cmux has window → workspace → pane → sibling surfaces (terminal plus markdown), while herdr has workspace → tab → BSP panes. Rows 7 and 10 therefore cannot preserve the doc-tab/terminal-tab relationship; row 6 also loses surface-scoped tab identity.

### C1 — Declarative workspace and BSP creation

Finding: **degraded**. Herdr can build the same broad topology in steps, but the cmux `new-workspace --layout <BSP JSON>` contract is not a single herdr equivalent. Live creation of the explicitly targeted throwaway workspace succeeded; declarative multi-seat BSP construction was not attempted because it would require additional throwaway panes.

```text
$ HERDR_ENV=1 herdr workspace create --label herdr-spike-r1 --cwd /private/tmp --no-focus
{"id":"cli:workspace:create","result":{"root_pane":{"pane_id":"w6:p1","tab_id":"w6:t1","workspace_id":"w6","cwd":"/private/tmp"},"tab":{"tab_id":"w6:t1","workspace_id":"w6"},"workspace":{"workspace_id":"w6","label":"herdr-spike-r1","active_tab_id":"w6:t1","pane_count":1,"tab_count":1}}}
# IDs returned and used: workspace w6, tab w6:t1, root pane w6:p1.
$ HERDR_ENV=1 herdr workspace close w6
{"id":"cli:workspace:close","result":{"type":"ok"}}
```

### C2 — Topology and ID resolution

Finding: **degraded**. `api snapshot` and separate list calls expose stable workspace/tab/pane IDs, but no cmux-compatible `tree --json --id-format uuids --all` surface hierarchy exists. The listed snapshot was read-only and live; resolution against a throwaway workspace is `unverified`.

```json
{"protocol":19,"version":"0.8.0","workspaces":[{"workspace_id":"w5","active_tab_id":"w5:t1","tab_count":1,"pane_count":1}],"panes":[{"pane_id":"w5:p1","tab_id":"w5:t1","workspace_id":"w5"}]}
```

### C3 — Surface-scoped close and rename

Finding: **degraded**. Herdr's `tab rename`/`tab close` operate on a peer tab, and `pane close` operates on a pane; neither can select a cmux surface sibling inside a pane. The exact preservation behavior with a terminal and markdown sibling is `unverified`.

```text
$ herdr tab --help
Commands: list  create  get  focus  rename  close
$ herdr pane --help
Commands: ... rename ... close ...
# No surface command group or surface target appears in either help listing.
```

### C4 — Stage metadata write

Finding: **degraded**. Although named `report-metadata`, 0.8.0 accepts `--token NAME=VALUE`; `crew-stage=building` persisted on the throwaway workspace and was returned by both `workspace get` and `api snapshot`. The CLI has no separate `set-status` spelling, so the adapter can map the crew label to this token write. However, the tested write used `--ttl-ms 60000`, and neither visual stage-pill rendering nor long-running lifetime was verified; the UI contract therefore cannot be called equivalent.

```text
$ herdr workspace report-metadata w6 --source spike-r1 --token crew-stage=building --seq 1 --ttl-ms 60000
# success (empty response)
$ herdr workspace get w6
..."tokens":{"crew-stage":"building"}...
$ herdr api snapshot
..."label":"herdr-spike-r1",..."tokens":{"crew-stage":"building"}...
```

### C5 — Markdown doc-tab mount

Finding: **absent** for a faithful swap. Herdr has no `markdown` command and no tab-inside-pane concept. Running a terminal markdown viewer in a pane is a possible degraded product fallback, but it is not equivalent to cmux's mounted, live-watching sibling surface. The viewer/reload behavior is `unverified`.

```text
$ herdr --help
Command groups: api workspace worktree tab agent pane session notification integration config channel server
# There is no markdown group or markdown subcommand.
```

## State fidelity

The standing invariant is explicit: `idle` ≠ success; outcome comes from artifacts/transcript, and herdr state only says when to look.

### H1a — Hook events stay authoritative

Finding: **unverified**. The 0.8.0 schema contains `pane.agent_status_changed`, `pane.agent_detected`, `pane.output_matched`, and `pane.exited`; this confirms event vocabulary, not that crew hook events remain authoritative through an adapter. A live detected-agent pane and hook transition test could not run outside Herdr.

```text
$ herdr api schema --json | grep -o 'pane\.[A-Za-z_]*' | sort -u
pane.agent_detected
pane.agent_status_changed
pane.exited
pane.output_matched
```

### H1b — External agent reporting authority

Finding: **partially verified**. The accepted grammar is live-verified for all three lifecycle commands: `report-agent` requires `--source`, `--agent`, and `--state` (`idle|working|blocked|unknown`) and accepts message/sequence/session fields; `report-agent-session` accepts source/agent plus `--agent-session-id`, `--agent-session-path`, and `--session-start-source`; `release-agent` accepts source/agent and sequence. On `w6:p1`, reporting `probe=working` and session `sess-r1` was accepted, and `pane get` returned `agent:"probe"`, `agent_status:"working"`; the session-report command also returned success, and release then returned `agent_status:"unknown"`. Persistence after heuristic reclassification still requires a real detected-agent pane and is `unverified`.

```text
$ herdr pane report-agent --help
Usage: herdr pane report-agent [OPTIONS] --source <ID> --agent <LABEL> --state <STATUS> <PANE_ID>
Options: --message <TEXT> --seq <N> --agent-session-id <ID> --agent-session-path <PATH>
$ herdr pane report-agent-session --help
Usage: herdr pane report-agent-session [OPTIONS] --source <ID> --agent <LABEL> <PANE_ID>
Options: --seq <N> --agent-session-id <ID> --agent-session-path <PATH> --session-start-source <SOURCE>
$ herdr pane release-agent --help
Usage: herdr pane release-agent [OPTIONS] --source <ID> --agent <LABEL> <PANE_ID>
Options: --seq <N>
$ herdr pane report-agent w6:p1 --source spike-r1 --agent probe --state working --message 'spike authority' --seq 1 --agent-session-id sess-r1
# success (empty response)
$ herdr pane get w6:p1
..."agent":"probe","agent_status":"working"...
$ herdr pane report-agent-session w6:p1 --source spike-r1 --agent probe --seq 2 --agent-session-id sess-r1 --session-start-source spike-r1
# success (empty response)
$ herdr pane release-agent w6:p1 --source spike-r1 --agent probe --seq 3
# success (empty response); subsequent pane get: agent_status="unknown"
```

### H1c — Claude integration and hook composition

Finding: **partially verified**. `herdr integration install claude` is an accepted 0.8.0 target. The install/composition runtime was not invoked because it can mutate local integration state; whether it composes with or replaces hook-authoritative events remains `unverified`. Treat hook events as authoritative until that controlled install test is run.

```text
$ herdr integration install --help
Usage: herdr integration install <TARGET>
<TARGET> possible values: pi, omp, claude, codex, copilot, devin, droid, kimi, opencode, ...
# claude: accepted target; install side effects and event composition: unverified.
```

## Wake signal

### H2 — Agent wait state and latching

Finding: **unverified** for runtime behavior. The 0.8.0 grammar is `herdr agent wait <TARGET> --until <idle|working|blocked|done|unknown> --timeout <MS>`; without `--until`, it waits for the settled idle/done/blocked set. Whether a state already held latches immediately was not live-tested. The 0.7.1 `wait agent-status` spelling is absent.

```text
$ herdr agent wait --help
herdr agent wait <TARGET> [--until <idle|working|blocked|done|unknown>] [--timeout <MS>]
# Already-held-state latch: unverified.
```

### H3 — NDJSON push subscriber

Finding: **unverified** for socket reachability and cost, with a CLI absence verified from the 0.8.0 command surface. No `events subscribe` CLI verb appears; `subscription_event` in the API schema implies a socket-level path, but the crew would need a socket client, protocol framing, reconnect/ack handling, and a new dependency or implementation.

```text
$ herdr --help
Command groups: api workspace worktree tab agent pane session notification integration config channel server
$ herdr api schema --json
schemas: error_response, event, request, subscription_event, success_response
# CLI events subscriber: absent; socket subscriber path/cost: unverified.
```

### H4 — Echoed-command-line trap

Finding: **verified against 0.8.0**. `pane wait-output --match ECHO_TRAP_TOKEN` fired immediately on the echoed command line (`matched_line` was the prompt plus `printf 'ECHO_TRAP_TOKEN\\n'`), before command output. A split token in the command spelling (`echo DONE_"SPLIT_TOKEN_42"`) contains no contiguous `DONE_SPLIT_TOKEN_42` in the echo, and the wait matched the emitted output `DONE_SPLIT_TOKEN_42`. Therefore the adapter must split its sentinel in the command line or use a nonce absent from the submitted text.

```text
$ herdr pane run w6:p1 "printf 'ECHO_TRAP_TOKEN\\n'"
$ herdr pane wait-output w6:p1 --match ECHO_TRAP_TOKEN --source recent-unwrapped --timeout 1000
{"type":"output_matched","matched_line":"/private/tmp ➜ printf 'ECHO_TRAP_TOKEN\\\\n'"}
$ herdr pane run w6:p1 "sh -c 'echo DONE_\"SPLIT_TOKEN_42\"'"
$ herdr pane wait-output w6:p1 --match DONE_SPLIT_TOKEN_42 --source recent-unwrapped --timeout 1000
# matched_line: "DONE_SPLIT_TOKEN_42" (the quoted split form did not self-match)
```

### H5 — Scrollback trap and bounded source

Finding: **verified against 0.8.0**. After `STALE_BUFFER_99` was already in the pane buffer (emitted through a quoted split so the contiguous token was absent from the command echo), a new wait with `--source recent-unwrapped` matched immediately. After 30 filler lines, the same token was outside `--source visible --lines 5` and the wait timed out. Thus the scrollback trap is real, and `visible` plus a small `lines` bound prevents stale output from waking the poller; the adapter must choose those bounds deliberately.

```text
$ herdr pane run w7:p1 "sh -c 'echo STALE_\"BUFFER_99\"'"
$ herdr pane wait-output w7:p1 --match STALE_BUFFER_99 --source recent-unwrapped --timeout 1000
{"type":"output_matched","matched_line":"STALE_BUFFER_99","read":{"source":"recent_unwrapped",...}}
$ herdr pane run w7:p1 "for i in $(seq 1 30); do echo FILL_$i; done"
$ herdr pane wait-output w7:p1 --match STALE_BUFFER_99 --source visible --lines 5 --timeout 1000
{"error":{"code":"timeout","message":"timed out waiting for output match"}}
$ herdr pane read w7:p1 --source visible --lines 8
FILL_24 ... FILL_30
/private/tmp ➜
```

## Risk / rollback

Herdr 0.8.0 is pre-1.0 and has a solo-maintainer exposure: command and schema drift must be detected before every cutover. Pin the binary to `herdr 0.8.0` at `/Users/x/.local/bin/herdr`; select the stable channel with `herdr channel set stable`, then use this exact controlled config at `~/.config/herdr/config.toml` (followed by `herdr config check` and `herdr server reload-config` if a server is running):

```toml
[update]
channel = "stable"
version_check = false
manifest_check = false
```

The installed binary accepts this path and these keys; they were validated in an isolated HOME rather than inferred from a no-config default:

```text
$ HOME=/private/tmp/claude-501/-Users-x-Development-dev-team-wt53/ab10b516-eb13-4ddf-a8c4-0fe7e7c66111/scratchpad/config-home-r2 herdr config check
config: ok
$ HOME=/private/tmp/claude-501/-Users-x-Development-dev-team-wt53/ab10b516-eb13-4ddf-a8c4-0fe7e7c66111/scratchpad/config-home-r2 herdr channel show
stable
$ HOME=/private/tmp/claude-501/-Users-x-Development-dev-team-wt53/ab10b516-eb13-4ddf-a8c4-0fe7e7c66111/scratchpad/config-home-r2 cat ~/.config/herdr/config.toml
[update]
channel = "stable"
version_check = false
manifest_check = false
$ herdr --version
herdr 0.8.0
```

Reconfirm `herdr --version` is exactly `0.8.0` after any reinstall; disabling checks prevents silent background drift but is not a substitute for that version assertion.

Rollback is: stop using the herdr adapter, restore the cmux adapter as the selected substrate, and leave crew state/artifacts untouched; then close only explicitly owned herdr workspaces after draining panes. Keep both adapters behind the same driver contract and cut over last, so either direction remains possible. The object-model mismatch means the seam is swappable for terminal/input/state operations, but the markdown sibling-tab feature needs a product fallback or remains cmux-only.

## Worktree ownership

### H6 — Crew owns the worktree lifecycle

Finding: **unverified** as a live ownership exercise, but the decision is **the crew's existing worktree handling owns lifecycle**. Herdr must not also call `worktree create/open/remove` for the same checkout: two owners can race removal, report conflicting paths, or leave a workspace pointing at a deleted worktree. Herdr may receive the crew-selected `--cwd`; it does not create or remove that worktree.

```text
$ herdr --help
worktree
$ herdr worktree --help
Commands: list  create  open  remove
# Selected owner: crew; herdr worktree lifecycle calls are out of the adapter.
```

## Version drift 0.7.1 → 0.8.0

### D1 — Wait command spelling

Finding: **verified**. The issue's `wait agent-status` spelling is not present in 0.8.0; use `agent wait` with `--until` and `--timeout`.

```text
$ herdr agent wait --help
herdr agent wait <TARGET> --until <idle|working|blocked|done|unknown> --timeout <MS>
# `wait agent-status`: absent; `agent wait`: present.
```

### D2 — Events subscribe CLI

Finding: **verified absent**. `subscription_event` remains in the schema, but no `events` command group or `events subscribe` CLI verb is exposed in 0.8.0. A socket client is a new integration, not a drop-in CLI replacement.

```text
$ herdr --help
... session notification integration config channel server
# `events subscribe`: absent from every listed command group.
```

### D3 — Layout export/apply

Finding: **verified absent**. The 0.7.1 field-note `layout export/apply` operation is not in 0.8.0; `pane layout` reports layout information only. Build topology with create/split calls or retain cmux for declarative creation.

```text
$ herdr pane --help
... layout ...
# `layout` is a pane inspection command; export/apply: absent.
```

### D4 — Operational etiquette carried forward

Finding: the following field-note rules are **still true on 0.8.0** where herdr exposes the corresponding controls; no live destructive test was run, so last-mile behavior is `unverified`.

```text
--cwd "$PWD" default: still true on 0.8.0 (preserve explicitly; live default unverified)
--no-focus: still true on 0.8.0 (use for background panes; live focus effect unverified)
explicit split targeting: still true on 0.8.0 (use explicit pane/tab/workspace IDs)
never close a workspace's last pane: still true on 0.8.0 (safety rule; live deletion effect unverified)
--env secrets: still true on 0.8.0 (do not put secrets in argv/logs; handling unverified)
double-naming: still true on 0.8.0 (one stable owner/name per object; collision behavior unverified)
```

### D5 — Skill versus help authority

Finding: **verified**. The installed 0.8.0 skill and command help are the authoritative grammar; issue field notes are hypotheses. Any contradiction found during implementation must be recorded as a new drift item rather than silently using the old spelling.

```text
$ herdr --version
herdr 0.8.0
$ herdr --skill
# upstream-maintained skill file; use with the installed --help output
```

## Go / no-go

**CONDITIONAL GO**

- Terminal creation, input, bounded reads, agent wait grammar, and workspace close can be wrapped behind an adapter.
- `markdown` is absent, and cmux surface-scoped close/rename is degraded by herdr's object model.
- `set-status` maps degradedly to a persisted `crew-stage` report-metadata token; visual rendering/lifetime remain open.
- The only absent mapping is faithful `markdown` sibling-tab mounting; surface-scoped close/rename remain degraded.
- H1c integration composition and H2 latching/H3 socket cost remain unverified; H4/H5 traps are now live-verified.
- Do not cut over until the doc-tab replacement and metadata fallback are accepted by a human; keep cmux selectable.

## Slice plan

1. **Slice 1 — Substrate contract adapter** — touch `crew/driver-herdr.mjs`, `crew/driver-herdr.test.mjs`, and `crew/driver.mjs`; add explicit workspace/tab/pane ID translation for create, send, keys, reads, close, status-token, and wait. Acceptance: adapter contract tests prove `sendLine` performs read-back needle counting before Enter and never targets focused UI implicitly.
2. **Slice 2 — State and wake bridge** — touch `crew/driver-herdr.mjs`, `crew/driver-herdr.test.mjs`, and `crew/crew.mjs`; add report-agent authority, artifact/transcript outcome checks, agent wait, and bounded wait-output polling with split-token and visible-source mitigations. Acceptance: a live Herdr session records every H1–H5 result and rejects `idle` as success.
3. **Slice 3 — Topology and display fallback** — touch `crew/crew.mjs`, `crew/driver-herdr.mjs`, and `crew/driver-herdr.test.mjs`; implement an explicit terminal viewer fallback for the absent markdown surface while retaining the cmux markdown mount. Acceptance: terminal and doc workflows are user-reviewed, stage-token updates are checked for rendering/lifetime, and no herdr operation closes an unrelated pane/workspace.
4. **Slice 4 — Opt-in cutover and rollback** — touch `crew/crew.mjs`, `crew/driver.mjs`, `crew/driver-herdr.mjs`, and `crew/README.md`; add a feature flag that selects herdr only after the absent/degraded rows are accepted. Acceptance: toggling the flag switches back to cmux without changing task artifacts or worktree ownership, and a smoke run leaves exactly one lifecycle owner.

## Exit gate

Answered: all ten cmux verbs have a verdict; stage-token metadata and report-agent grammar/runtime acceptance are captured; state fidelity H1a–c is scoped; wake signal H2–H5 is scoped with both wait traps live-verified; one worktree owner is selected; 0.7.1 → 0.8.0 drift and etiquette are recorded; rollback and a staged plan are actionable.

`unverified`: heuristic persistence after H1b reclassification, Claude integration composition (H1c), wait latching (H2), socket subscriber reach/cost (H3), visual rendering of the stage token, and destructive worktree behavior (H6). These require a controlled follow-up; they do not erase the captures established against the throwaway workspace.

Escalate to the human: whether losing a sibling markdown surface is acceptable, whether the stage token's visual rendering meets the UI need, whether to fund a socket-level subscriber, and whether the crew or Herdr owns any future worktree migration. A conflicting issue comment re-anchors #53 as an agent adapter; this spike deliberately treats Herdr as the pane/session substrate, so that upstream scope should be corrected when posted.

This document is produced in-worktree for a human to post or link upstream. The crew does not write to GitHub.
