# HW-1 — headless stream-JSON worker contract: spike findings

Source issue: #81; epic: #80. Live run date: 2026-08-13. I ran the matrix below in a fresh git checkout at `/private/tmp/hw1-scratch-32725/work`, containing only `README.md`, `seed.txt`, and the generated `notes.txt`. The one rule for this record is: a claim is either backed by a raw capture or explicitly marked unverified. There were 20 live `claude` invocations (including local argument/input failures). `claude` is version `2.1.231 (Claude Code)`; the baseline arm used the cmux `claude` shim, and the parity arm invoked `/Users/x/.local/bin/claude` directly. The baseline used `--model haiku`, `--verbose`, `--output-format stream-json`, and explicit `dontAsk` permissions.

## H1 — Event vocabulary

### H1.1 — Baseline event inventory, usage, tool calls, and clean terminal
**Status:** verified
The baseline (`a-baseline.jsonl`) made Bash and Write calls. Its complete observed top-level event-type inventory is `system`, `assistant`, `rate_limit_event`, `user`, and `result`; each type is represented by a verbatim JSONL line below. `system` carries lifecycle/init/thinking data but no token usage object. `assistant` carries per-message `usage`; the terminal `result` carries aggregate `usage`. Tool name and arguments are in `assistant.message.content[]` entries of `type: "tool_use"`, under `name` and `input`; the matching result is a `user` line.

```text
command: claude -p 'Run `echo hw1-marker` with Bash, then Write `notes.txt` containing `ok`, then reply DONE.' --output-format stream-json --verbose --model haiku --session-id 22222222-2222-4222-8222-222222222222 --permission-mode dontAsk --allowedTools Bash,Write
raw capture: tasks/headless-worker/captures/a-baseline.jsonl
{"type":"system","subtype":"hook_started","hook_id":"3fed9a32-29c0-4de2-9b46-954380d94dcc","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"1ff47ed0-6f79-4758-a2e6-9bfaa2cafa26","session_id":"22222222-2222-4222-8222-222222222222"}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011Ce12fVPspu57ZtAXkmKLQ","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01DaWW7yDDQPmwPWrkzMv7MQ","name":"Bash","input":{"command":"echo hw1-marker","description":"Echo the marker string"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":7373,"cache_read_input_tokens":18101,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":7373},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"22222222-2222-4222-8222-222222222222","uuid":"11bfac44-e465-4a02-9a5a-3088df9b3e12","timestamp":"2026-08-13T16:02:49.069Z","request_id":"req_011Ce12fU7jEhej4YjA6XqXL"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1786641000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"uuid":"bb5f0557-b307-4005-8c6a-8d0b30c30f1a","session_id":"22222222-2222-4222-8222-222222222222"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01DaWW7yDDQPmwPWrkzMv7MQ","type":"tool_result","content":"hw1-marker","is_error":false}]},"parent_tool_use_id":null,"session_id":"22222222-2222-4222-8222-222222222222","uuid":"936e382a-f8f3-4fcc-a762-47f37431085a","timestamp":"2026-08-13T16:02:49.516Z","tool_use_result":{"stdout":"hw1-marker","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}
{"is_error":false,"duration_api_ms":4857,"num_turns":3,"stop_reason":"end_turn","session_id":"22222222-2222-4222-8222-222222222222","total_cost_usd":0.0212285,"usage":{"input_tokens":18,"cache_creation_input_tokens":7709,"cache_read_input_tokens":43575,"output_tokens":287,"output_tokens_details":{"thinking_tokens":130}},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":7709,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":8,"output_tokens":62,"cache_read_input_tokens":25474,"cache_creation_input_tokens":336,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":336},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":18,"outputTokens":287,"cacheReadInputTokens":43575,"cacheCreationInputTokens":7709,"webSearchRequests":0,"costUSD":0.0212285,"contextWindow":200000,"maxOutputTokens":32000,"webSearchRequests":0,"canonicalModel":"claude-haiku-4-5","provider":"firstParty"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":null,"result":"DONE","ttft_ms":2511,"ttft_stream_ms":1450,"time_to_request_ms":254,"type":"result","duration_ms":5488,"uuid":"1c41b016-2748-488b-a029-d935caf6dbab"}
```

**Finding:** token usage is present on assistant message events and the final result, not on the observed system/user/rate-limit lines. A clean run terminates with a parseable `type: "result"` line (`is_error:false`, `stop_reason:"end_turn"`, `terminal_reason:"completed"`).

### H1.2 — Mid-stream kill tail
**Status:** verified
A SIGKILL was sent after four seconds to a Bash `sleep 30` run. The final complete line was a thinking-token system event; there was no terminal result event and no partial JSON line in this particular capture.

```text
command: claude -p 'Use Bash to run sleep 30, then reply NEVER.' --output-format stream-json --verbose --model haiku --session-id 55555555-5555-4555-8555-555555555555 --permission-mode dontAsk --allowedTools Bash; kill -KILL <pid>
exit: 137
raw tail from tasks/headless-worker/captures/d-sigkill.jsonl:
{"type":"system","subtype":"thinking_tokens","estimated_tokens":127,"estimated_tokens_delta":29,"uuid":"73de9c66-8602-48f1-b79a-efd2a9592f65","session_id":"55555555-5555-4555-8555-555555555555"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":155,"estimated_tokens_delta":28,"uuid":"e0e56c68-2650-4600-b084-e3018eb48bc7","session_id":"55555555-5555-4555-8555-555555555555"}
```

**Finding:** consumers must tolerate EOF without a terminal result and treat the stream as incomplete; a kill need not produce a truncated JSONL line.

### H1.3 — Shim event addition
**Status:** verified
The shim arm emitted `SessionStart` hook_started/hook_response lines before `init`; the direct binary arm emitted `init` first and did not emit those startup hook lines. Both emitted assistant/result events and exited zero.

```text
shim capture: tasks/headless-worker/captures/a-baseline.jsonl
{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"22222222-2222-4222-8222-222222222222"}
direct capture: tasks/headless-worker/captures/h-direct.jsonl (the complete direct JSONL, including its `init` line, is retained there)
exit comparison: shim 0; direct 0.
```

**Finding:** the cmux `cmux-claude-wrapper`/`cmux-cli-shims` path injects hook wiring and changes the observed event stream. It did not change the clean exit code in this arm; a headless worker should choose and document one path rather than silently inheriting the shim.

## H2 — Session resume semantics

### H2.1 — Fresh session creation and same-ID resume
**Status:** verified
A fresh `--session-id` created a persisted conversation. A second invocation with `--resume` and the same ID answered `notes.txt` to “What file did you just write?”, demonstrating first-turn context.

```text
create command: claude -p 'Run ... then reply DONE.' --output-format stream-json --verbose --model haiku --session-id 22222222-2222-4222-8222-222222222222 ...
resume command: claude -p 'What file did you just write? Reply with its name only.' --output-format stream-json --verbose --model haiku --resume 22222222-2222-4222-8222-222222222222 ...
raw result from tasks/headless-worker/captures/b-resume.jsonl:
{"is_error":false,"duration_api_ms":1625,"num_turns":1,"stop_reason":"end_turn","session_id":"22222222-2222-4222-8222-222222222222","total_cost_usd":0.0177481,"terminal_reason":"completed","subtype":"success","result":"notes.txt","type":"result"}
```

**Finding:** resume reuses the session ID and context; the resumed stream did not repeat the baseline SessionStart hook events.

### H2.2 — Concurrent second invocation
**Status:** verified
A second `--resume` was started two seconds into a live Bash-sleep invocation against the same session ID. Both processes exited zero and both produced terminal result events; the second was not rejected or serialized behind the first.

```text
commands: live `claude -p 'Use Bash to run sleep 8, then reply SLOW-DONE.' ... --session-id 33333333-3333-4333-8333-333333333333`; concurrent `claude -p 'Reply SECOND.' ... --resume 33333333-3333-4333-8333-333333333333`
exits: live=0, second=0
raw results from tasks/headless-worker/captures/c-concurrent.jsonl:
{"is_error":false,"num_turns":1,"stop_reason":"end_turn","session_id":"33333333-3333-4333-8333-333333333333","result":"SECOND.","type":"result"}
{"is_error":false,"num_turns":2,"stop_reason":"end_turn","session_id":"33333333-3333-4333-8333-333333333333","result":"SLOW-DONE","type":"result"}
```

**Finding:** this version exposes no same-session lock/error in the tested timing; concurrent callers can fork turns against one persisted session, so #83 must serialize if ordering matters.

### H2.3 — On-disk state and lifecycle
**Status:** verified
The state location was found rather than inferred.

```text
command: find "$HOME/.claude" -type f -name '22222222-2222-4222-8222-222222222222.jsonl'
output: /Users/x/.claude/projects/-private-tmp-hw1-scratch-32725-work/22222222-2222-4222-8222-222222222222.jsonl
```

**Finding:** the JSONL session file is created by the first persisted invocation and grows with subsequent turns. Cleanup on process kill or an explicit retention/GC policy was not tested.

### H2.4 — Cleanup lifecycle
**Status:** unverified — the matrix did not wait for retention cleanup or delete a session and then inspect the on-disk project directory

## H3 — Exit-code contract

Observed table (the stream column means whether a final terminal `result` was present and the last JSONL line parsed):

| Scenario | Exit | Stream ending |
|---|---:|---|
| clean completion | 0 | well-formed, terminal result present |
| `--max-turns 1` exhaustion | 1 | well-formed, terminal result with `terminal_reason:"max_turns"` |
| SIGTERM | 143 | well-formed result, `aborted_streaming` |
| SIGKILL | 137 | truncated at event boundary; no terminal result |
| malformed prompt (no argv/stdin input) | 1 | no JSONL result; stderr error |
| permission denial (`--disallowedTools Bash`) | 0 | well-formed success result; requested tool unavailable and model declined |

### H3.1 — Clean completion
**Status:** verified

```text
command: baseline command in H1.1
raw terminal line: {"is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","subtype":"success","result":"DONE","type":"result"}
exit: 0
```

### H3.2 — `--max-turns` exhaustion
**Status:** verified

```text
command: claude -p 'Use Bash to run echo max-marker, then reply MAX-DONE.' --output-format stream-json --verbose --model haiku --max-turns 1 --permission-mode dontAsk --allowedTools Bash
raw terminal line from tasks/headless-worker/captures/e-max-turns.jsonl: {"is_error":true,"num_turns":2,"stop_reason":"tool_use","terminal_reason":"max_turns","subtype":"error_max_turns","errors":["Reached maximum number of turns (1)"],"type":"result"}
exit: 1
```

### H3.3 — SIGTERM
**Status:** verified

```text
command: run `claude -p 'Use Bash to run sleep 30, then reply NEVER.' ...` in background; `kill -TERM <pid>` after four seconds
exit: 143
raw terminal line from tasks/headless-worker/captures/d-sigterm.jsonl: {"is_error":true,"stop_reason":null,"terminal_reason":"aborted_streaming","subtype":"error_during_execution","type":"result"}
```

### H3.4 — SIGKILL
**Status:** verified

```text
command: same sleep command; `kill -KILL <pid>` after four seconds
exit: 137
raw final capture line from tasks/headless-worker/captures/d-sigkill.jsonl: {"type":"system","subtype":"thinking_tokens","estimated_tokens":155,"estimated_tokens_delta":28,"uuid":"e0e56c68-2650-4600-b084-e3018eb48bc7","session_id":"55555555-5555-4555-8555-555555555555"}
```

### H3.5 — Malformed prompt
**Status:** verified

```text
command: claude -p --output-format stream-json
exit: 1
stderr: Error: Input must be provided either through stdin or as a prompt argument when using --print
```

### H3.6 — Permission denial
**Status:** verified

```text
command: claude -p 'Use Bash to run echo denied-marker, then reply DONE.' --output-format stream-json --verbose --model haiku --session-id 66666666-6666-4666-8666-666666666666 --permission-mode dontAsk --disallowedTools Bash
exit: 0
raw terminal line from tasks/headless-worker/captures/e-permission-denial.jsonl: {"is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","subtype":"success","permission_denials":[],"type":"result"}
```

**Finding:** denial is a policy outcome, not necessarily a nonzero process exit; consumers must inspect tool/result events and not use exit code alone as the worker outcome.

## H4 — Permission surface

### H4.1 — CLI allow/deny lists and permission modes
**Status:** verified
`--allowedTools`, `--disallowedTools`, and `--permission-mode` are accepted. `dontAsk` with `--disallowedTools Bash` removed Bash from the available toolset and let the model complete with exit 0. Both `dontAsk` and `acceptEdits` completed simple headless turns.

```text
help capture: --allowedTools/--disallowedTools accept comma-separated names; --permission-mode choices include acceptEdits, auto, dontAsk, manual, plan
allowed command: ... --permission-mode dontAsk --allowedTools Bash,Write
denied command: ... --permission-mode dontAsk --disallowedTools Bash
mode captures: tasks/headless-worker/captures/g-accept-edits.jsonl and g-dontask.jsonl
```

**Finding:** the profile-derived CLI containment flags transfer to headless for the exercised tool-name arms. Path-scoped editing was not re-run here; the pane precedent S22a says to use precise `Edit(//absolute/**)` rules (not a `Write(...)` path rule).

### H4.2 — Minimal plugin Stop and UserPromptSubmit hooks
**Status:** verified
A scratch plugin containing `.claude-plugin/plugin.json` and `hooks/hooks.json` was passed with `--plugin-dir`. Its `UserPromptSubmit` and `Stop` commands appended markers, and `--include-hook-events` exposed hook lifecycle events in stream-json.

```text
command: claude -p 'Reply PLUGIN-OK.' --output-format stream-json --verbose --include-hook-events --model haiku --session-id 88888888-8888-4888-8888-888888888888 --plugin-dir /tmp/hw1-scratch-32725/plugin --permission-mode dontAsk
marker file output: user-prompt
stop
raw capture: tasks/headless-worker/captures/g-plugin.jsonl
raw lines: {"type":"system","subtype":"hook_started","hook_name":"Stop","hook_event":"Stop",...}
        {"type":"system","subtype":"hook_response","hook_name":"Stop","exit_code":0,"outcome":"success",...}
```

**Finding:** the tested plugin hook layer transfers to headless. This agrees with pane S22e's live plugin-hook result for PreToolUse/PostToolUse, while this spike specifically exercised Stop/UserPromptSubmit as required.

### H4.3 — ADR-005/012 transfer decision
**Status:** verified

```text
headless evidence: tasks/headless-worker/captures/g-plugin.jsonl shows plugin-dir Stop/UserPromptSubmit hooks; e-permission-denial.jsonl shows disallowed Bash; g-accept-edits.jsonl and g-dontask.jsonl show safe permission modes completing.
pane comparison: tasks/cmux-mode/spike-findings.md:S22a and S22e
```

**Finding:** ADR-005/012's primary CLI containment surface transfers with no observed headless delta for these arms. The observable delta is transport: hook events are only included when `--include-hook-events` is requested, and shim startup hooks add events before `init`; path/rule syntax still needs the S22a caveat.

## H5 — Stdin behaviour

### H5.1 — Prompt from stdin and closed stdin
**Status:** verified
With no argv prompt, `-p` read a text prompt from a pipe and completed. With stdin redirected from `/dev/null`, it exited 1 with the same missing-input error as an absent prompt.

```text
pipe command: printf 'Reply STDIN-OK.' | claude -p --output-format stream-json --verbose --model haiku --session-id 77777777-7777-4777-8777-777777777777
pipe exit: 0; raw result in tasks/headless-worker/captures/f-stdin-pipe.jsonl contains "result":"STDIN-OK..."
null command: claude -p --output-format stream-json --verbose --model haiku --session-id 77777777-7777-4777-8777-777777777778 </dev/null
null exit: 1; stderr: Error: Input must be provided either through stdin or as a prompt argument when using --print
```

### H5.2 — Held-open stdin and mid-run bytes
**Status:** verified
A pipe wrote `first prompt. `, held open for five seconds, then wrote `late bytes.`. Claude did not start a turn while the pipe was held open; it consumed both chunks after EOF as one text prompt.

```text
command: (sleep 2; printf 'first prompt. '; sleep 5; printf 'late bytes.') | claude -p --output-format stream-json --verbose --model haiku --session-id 77777777-7777-4777-8777-777777777780
raw capture: tasks/headless-worker/captures/f-stdin-held.jsonl
observed assistant capture text: "The user has written \"first prompt. late bytes.\""; terminal result was a normal end_turn result
```

**Finding:** bytes written to text stdin mid-run are not an interjection channel: stdin is read to EOF before the turn starts. Mid-run injection for #85 is not possible through `-p` text stdin.

### H5.3 — `--input-format stream-json`
**Status:** verified
The help advertises `--input-format stream-json` as realtime streaming input. A JSON user record was accepted and produced a normal stream-json response.

```text
command: printf '%s\\n' '{"type":"user","message":{"role":"user","content":"Reply STREAM-OK."}}' | claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --session-id 77777777-7777-4777-8777-777777777779
raw result from tasks/headless-worker/captures/f-input-stream.jsonl: {"is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"STREAM-OK.","type":"result"}
```

**Finding:** stream-json input is a separate candidate for future interjection design, but this run only established one accepted user record; it did not establish a safe multi-turn/mid-run injection protocol.

### H5.4 — Interjection protocol coverage
**Status:** unverified — the brief's live matrix established text-stdin EOF behavior and one stream-json record, but did not exercise a concurrent second stream-json user message during an active tool turn

## H6 — Introspection surface

### H6.1 — Event shape and correlation
**Status:** verified
Across the baseline event classes, `type` is the discriminator and `session_id` plus a per-event `uuid` were present. Assistant tool calls have a tool-use `id`; the corresponding user tool result carries `tool_use_id` with `tool_result` content and `tool_use_result` metadata. Assistant/result events expose usage; the final result exposes process/turn status and aggregate usage.

```text
verbatim correlation from tasks/headless-worker/captures/a-baseline.jsonl:
assistant content: {"type":"tool_use","id":"toolu_01DaWW7yDDQPmwPWrkzMv7MQ","name":"Bash","input":{"command":"echo hw1-marker","description":"Echo the marker string"}}
user content: {"tool_use_id":"toolu_01DaWW7yDDQPmwPWrkzMv7MQ","type":"tool_result","content":"hw1-marker","is_error":false}
```

**Finding:** a consumer can correlate tool calls to results by `assistant.message.content[].id` → `user.message.content[].tool_use_id`; it should not correlate by line order alone when concurrent calls are possible.

### H6.2 — What the stream does not expose
**Status:** verified
The captures expose model/tool messages, hook lifecycle events when requested, usage, and terminal status. They do not expose a pane's visual state, a user approval UI, or a reliable process-exit event for a SIGKILL; the kill capture ends without a result.

```text
raw introspection evidence: tasks/headless-worker/captures/d-sigkill.jsonl ends with {"type":"system","subtype":"thinking_tokens","estimated_tokens":155,"estimated_tokens_delta":28,...} and has no `type:"result"` line.
```

**Finding:** raw stream introspection is sufficient for protocol events but not a substitute for an external supervisor's PID/EOF/timeout state.

### H6.3 — Raw evidence inventory
**Status:** verified
The raw stdout files are checked in under `tasks/headless-worker/captures/`: `a-baseline.jsonl`, `b-resume.jsonl`, `c-concurrent.jsonl`, `d-sigterm.jsonl`, `d-sigkill.jsonl`, `e-max-turns.jsonl`, `e-permission-denial.jsonl`, `f-stdin-pipe.jsonl`, `f-stdin-held.jsonl`, `f-input-stream.jsonl`, `g-plugin.jsonl`, `g-accept-edits.jsonl`, `g-dontask.jsonl`, and `h-direct.jsonl`.

```text
command: find tasks/headless-worker/captures -type f -name '*.jsonl' -print
raw output: tasks/headless-worker/captures/a-baseline.jsonl ... tasks/headless-worker/captures/h-direct.jsonl
```

**Finding:** these captures are the fixture evidence and should be treated as sample streams, not as a promise that every optional hook event is present by default.

## Go / no-go — HW-3 transport

**Recommendation:** GO-WITH-CAVEATS
**Platform blockers:** none observed

The stream-json transport is viable for #83 if the worker uses a single documented binary path, treats missing terminal results as abnormal EOF, serializes session IDs, records exit code independently from the final result, and does not promise stdin interjection. The concurrent same-session arm and shim-injected hook events are the main implementation caveats.

## Deferrals and open questions

- `pi --mode json -p` and checked-in `test/` fixture streams are explicitly out of scope for issue #81 and were not run.
- Stream-json multi-message input during an active turn, including an interjection safety policy, remains open for #85.
- Session-file retention/cleanup and crash recovery were not measured.
- The exact worker choice between the cmux shim (hook injection) and `/Users/x/.local/bin/claude` (cleaner stream) should be frozen before HW-3.
- The gate is structural, not semantic: reviewers must spot-check the raw captures rather than treating the gate as proof that every live claim is true.
