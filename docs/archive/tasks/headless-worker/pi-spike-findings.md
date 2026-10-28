# HW-1b — pi headless contract (--mode json / --mode rpc): spike findings

Source issue: #116; epic: #80. Live run date: 2026-08-13. Installed `pi --version` output was exactly `0.84.1`. Scratch checkout: `/private/tmp/pi116-scratch-OW2sEF/work`; session directory: `/private/tmp/pi116-scratch-OW2sEF/sessions`. Model for every arm: `openai-codex/gpt-5.6-luna`; thinking level: `low`. There were 12 live pi invocations, including the two RPC restart arms and signal arms. JSON baseline flags were `--mode json -p <prompt> --model openai-codex/gpt-5.6-luna --thinking low --session-dir "$SESS" --tools bash,read,write --no-context-files --no-extensions --no-skills` (with only the arm-specific session/deny options added). RPC runs used the same hermetic flags and a byte-level LF splitter. Governing rule: every claim below is live-verified with a capture inline, or explicitly unverified with its reason. There is no third state. This is a structural record; the checker cannot establish semantic support, so reviewers must spot-check raw lines.

## A — `--mode json`

### A1 — Event inventory, usage, tool calls
**Status:** verified
The baseline made two tool calls, `bash` and `write`, and completed with `A1-DONE`. The complete observed top-level inventory was `session`, `agent_start`, `turn_start`, `message_start`, `message_end`, `message_update`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `turn_end`, `agent_end`, and `agent_settled`. Assistant `message_end` lines carry usage; in this run `openai-codex` reported nonzero usage and cost (for example input 775/output 22/totalTokens 797 and cost total 0.0001814), while the initial assistant `message_start` usage object was zero. The terminal `agent_end` line includes `willRetry:false`; the final lifecycle signal is `agent_settled`.

```text
command: pi --mode json -p 'Use bash to run echo pi-a1-marker, then use write to create notes.txt containing pi-write-marker, then reply A1-DONE.' --model openai-codex/gpt-5.6-luna --thinking low --session-dir /private/tmp/pi116-scratch-OW2sEF/sessions --tools bash,read,write --no-context-files --no-extensions --no-skills
raw capture: tasks/headless-worker/captures/pi-a1-json-baseline.jsonl
{"type":"session","version":3,"id":"019ffc4d-e830-7fe3-982a-88c66dc190f9","timestamp":"2026-08-13T18:06:31.984Z","cwd":"/private/tmp/pi116-scratch-OW2sEF/work"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Use bash to run echo pi-a1-marker, then use write to create notes.txt containing pi-write-marker, then reply A1-DONE."}],"timestamp":1786644392013}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Use bash to run echo pi-a1-marker, then use write to create notes.txt containing pi-write-marker, then reply A1-DONE."}],"timestamp":1786644392013}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0}}
{"type":"tool_execution_start","toolCallId":"call_kSNDMbS4ccwQY5FUXZ7t8BE4|fc_0146775fcb5c3e39016a7e07a991a88191bbf8fb0b7c215f08","toolName":"bash","args":{"command":"echo pi-a1-marker"}}
{"type":"tool_execution_update","toolCallId":"call_kSNDMbS4ccwQY5FUXZ7t8BE4|fc_0146775fcb5c3e39016a7e07a991a88191bbf8fb0b7c215f08","toolName":"bash","args":{"command":"echo pi-a1-marker"},"partialResult":{"content":[]}}
{"type":"tool_execution_end","toolCallId":"call_kSNDMbS4ccwQY5FUXZ7t8BE4|fc_0146775fcb5c3e39016a7e07a991a88191bbf8fb0b7c215f08","toolName":"bash","result":{"content":[{"type":"text","text":"pi-a1-marker\n"}]},"isError":false}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_kSNDMbS4ccwQY5FUXZ7t8BE4|fc_0146775fcb5c3e39016a7e07a991a88191bbf8fb0b7c215f08","name":"bash","arguments":{"command":"echo pi-a1-marker"}}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.6-luna","usage":{"input":775,"output":22,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":797,"cost":{"input":0.000155,"output":0.000026399999999999998,"cacheRead":0,"cacheWrite":0,"total":0.0001814},"stopReason":"toolUse"}}
{"type":"agent_end","messages":[],"willRetry":false}
{"type":"agent_settled"}
```

**Finding:** consume tool lifecycle events and message usage, and wait for `agent_settled` rather than assuming `agent_end` alone means all cleanup is complete. For billing, this provider does report usage in-stream; the zero initial usage lines are not the aggregate.

### A2 — Terminal behavior and exit codes
**Status:** verified
A1 emitted parseable JSON ending in `agent_settled`. **Process exit status: unverified — this stdout-only capture contains no parent wait-status record, so an exit code is not auditable evidence here.** Both signal captures ended at a complete `tool_execution_update` JSON line while `bash sleep 25` was in flight; neither contained `agent_end` or `agent_settled`. There was no partial final JSON line in either file. **Signal exit statuses are likewise unverified — these captures contain no parent wait-status record.**

```text
clean: parent process exit status unverified; last line {"type":"agent_settled"}; parseable terminal lifecycle event present
SIGTERM command: pi --mode json ... -p 'Use bash to run sleep 25, then reply A2-TERM-DONE.'; kill -TERM <spawned-pid>
SIGTERM: raw capture: tasks/headless-worker/captures/pi-a2-sigterm.jsonl; last line is parseable tool_execution_update; no agent_end/agent_settled
SIGKILL command: pi --mode json ... -p 'Use bash to run sleep 25, then reply A2-KILL-DONE.'; kill -KILL <spawned-pid>
SIGKILL: raw capture: tasks/headless-worker/captures/pi-a2-sigkill.jsonl; last line is parseable tool_execution_update; no agent_end/agent_settled
```

**Finding:** treat EOF without `agent_settled` as an incomplete run. A SIGTERM does not produce a graceful JSON terminal event in this direct child test, and SIGKILL cannot be expected to flush one. The next capture revision should record the parent wait status alongside stdout.

### A3 — Session files and resume
**Status:** verified
`--session-dir` produced these files (verbatim `find` output):

```text
/private/tmp/pi116-scratch-OW2sEF/sessions/2026-08-13T18-06-31-984Z_019ffc4d-e830-7fe3-982a-88c66dc190f9.jsonl
/private/tmp/pi116-scratch-OW2sEF/sessions/2026-08-13T18-06-51-611Z_019ffc4e-34db-73ad-a21c-1222cdea6d60.jsonl
/private/tmp/pi116-scratch-OW2sEF/sessions/2026-08-13T18-06-56-633Z_019ffc4e-4879-7d2f-ae80-e525a0138bde.jsonl
/private/tmp/pi116-scratch-OW2sEF/sessions/2026-08-13T18-07-15-551Z_116a3000-0000-4000-8000-000000000003.jsonl
/private/tmp/pi116-scratch-OW2sEF/sessions/2026-08-13T18-07-30-121Z_116a3000-0000-4000-8000-000000000004.jsonl
```

```text
create command: pi --mode json ... --session-id 116a3000-0000-4000-8000-000000000003 -p 'Use write to create resume-note.txt containing RESUME-MARKER, then reply A3-CREATED.'
resume command: pi --mode json ... --session-id 116a3000-0000-4000-8000-000000000003 -p 'What file did you just write? Reply with its name only.'
raw capture: tasks/headless-worker/captures/pi-a3-resume.jsonl
observed resumed answer: {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"resume-note.txt"}]...}
concurrent command: two pi --mode json children used --session-id 116a3000-0000-4000-8000-000000000004; parent-observed exit statuses are unverified because this capture records stdout only
raw capture: tasks/headless-worker/captures/pi-a3-concurrent.jsonl
observed concurrent answers: A3-SECOND completed while the first child still had sleep 12 in flight; then A3-SLOW-DONE
```

**Finding:** `--session-id` is create-or-continue and carries context across invocations. The concurrent test did not reject or serialize: it forked independent turns against the same session id, so a daemon must serialize same-session dispatches if order matters.

### A4 — Tool denial parity
**Status:** verified
The same headless prompt with `--exclude-tools bash` emitted a settled JSON stream and the model replied that it could not run bash; no `tool_execution_start` for bash occurred and no `denied-marker` was emitted. **Process exit status is unverified — this capture records stdout only and has no parent wait-status record.** This is a soft model-visible refusal after a hard tool absence; its numeric process status was not measured.

```text
command: pi --mode json -p 'Use bash to run echo denied-marker, then reply A4-DONE.' --model openai-codex/gpt-5.6-luna --thinking low --session-dir /private/tmp/pi116-scratch-OW2sEF/sessions --tools bash,read,write --exclude-tools bash --no-context-files --no-extensions --no-skills
raw capture: tasks/headless-worker/captures/pi-a4-exclude-tools.jsonl
verbatim observed final text: "I can’t run bash here."
verbatim lifecycle: {"type":"agent_end",..."willRetry":false}
```

**Finding:** `crew/adapters/adapter-pi.mjs:47-50` maps `Bash→bash`; that is the right pi name for headless denial. `--exclude-tools bash` removes the tool from the active set, while the model's refusal is the observable policy outcome; the process exit status remains unverified without parent wait evidence.

## B — `--mode rpc`

### B5 — Protocol basics and the JSONL reader trap
**Status:** verified
The driver correlated `id` on responses, and malformed input produced a `parse` response while an unknown command produced a command-named error response. The driver itself is checked in as raw reproducibility evidence and uses a byte-level LF splitter, not Node `readline`.

```text
raw capture: tasks/headless-worker/captures/pi-b5-protocol.jsonl
>>> {"id":"state-1","type":"get_state"}
{"id":"state-1","type":"response","command":"get_state","success":true,...}
>>> {"id":"bad-1","type":"not-a-command"}
{"id":"bad-1","type":"response","command":"not-a-command","success":false,"error":"Unknown command: not-a-command"}
>>> {"id":"malformed"
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: Expected ',' or '}' after property value in JSON at position 17 (line 1 column 18)"}
```

The measured reader trap is in `tasks/headless-worker/captures/pi-b5-readline-trap.txt`:

```text
payload contains literal U+2028: true
readline record count: 3
readline records parseable: 1:yes | 2:yes | 3:yes
byte-level LF splitter record count: 2
byte-level records parseable: 1:yes | 2:yes
```

**Finding:** split byte input on LF only (optionally strip CR); Node `readline` incorrectly split the literal U+2028 JSON string into three records.

### B6 — `steer` mid-turn
**Status:** verified
The driver sent `steer` after `tool_execution_start` and before `tool_execution_end` for `bash sleep 25`. The in-flight tool was not disturbed: its `tool_execution_end` arrived normally after the steer. A `queue_update` showed the queued steering message; after tool completion the queue emptied, a new user message was delivered, and the final assistant text explicitly quoted what it saw. A prompt without `streamingBehavior` was rejected as documented.

```text
raw capture: tasks/headless-worker/captures/pi-b6-steer.jsonl
{"type":"tool_execution_start",...,"toolName":"bash","args":{"command":"sleep 25","timeout":35}}
>>> {"id":"steer-1","type":"steer","message":"Steer now: after the sleep, tell me exactly what steering message you saw, then reply B6-DONE."}
{"type":"queue_update","steering":["Steer now: after the sleep, tell me exactly what steering message you saw, then reply B6-DONE."],"followUp":[]}
{"id":"prompt-error-1","type":"response","command":"prompt","success":false,"error":"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."}
{"id":"steer-1","type":"response","command":"steer","success":true}
{"type":"tool_execution_end",...,"isError":false}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Steer now: after the sleep, tell me exactly what steering message you saw, then reply B6-DONE."}]...}
verbatim final text: Steering message seen: “Steer now: after the sleep, tell me exactly what steering message you saw, then reply B6-DONE.”\n\nB6-DONE
```

**Finding:** pi can promise boundary steering: queue while a tool runs, do not interrupt that tool, and deliver the steering message before the next LLM call after tool completion. The model actually sees the steering text. This is not an in-flight tool interruption.

### B7 — `abort` mid-turn
**Status:** verified
The driver sent `abort` during `bash sleep 25`. The response was success, the stream stayed valid through an error tool result and aborted assistant turn, and `get_state` immediately afterward reported `isStreaming:false`, `pendingMessageCount:0`. A fresh prompt on the same process then completed `B7-FRESH-DONE` normally.

```text
raw capture: tasks/headless-worker/captures/pi-b7-abort.jsonl
>>> {"id":"abort-1","type":"abort"}
{"type":"tool_execution_end",...,"result":{"content":[{"type":"text","text":"Command aborted"}]},"isError":true}
{"type":"agent_end",...,"willRetry":false}
{"type":"agent_settled"}
{"id":"abort-1","type":"response","command":"abort","success":true}
{"id":"state-after-abort","type":"response","command":"get_state","success":true,"data":{...,"isStreaming":false,...,"pendingMessageCount":0}}
>>> {"id":"fresh-1","type":"prompt","message":"Reply B7-FRESH-DONE."}
{"id":"fresh-1","type":"response","command":"prompt","success":true}
verbatim final text: B7-FRESH-DONE
```

**Finding:** abort is a usable capability for a long-lived RPC owner; wait for the settled lifecycle and verify state before accepting a new turn.

### B8 — `agent_end` vs `agent_settled`
**Status:** verified
The B6 and B7 transcripts both contain `agent_end` followed by `agent_settled` (`tasks/headless-worker/captures/pi-b6-steer.jsonl` and `tasks/headless-worker/captures/pi-b7-abort.jsonl`). In B6, the final assistant answer precedes `agent_end`; in B7, the abort response is emitted after `agent_settled`. No `willRetry:true` or retry event was observed in these captures.

**Finding:** a driver needing a fully settled turn must wait for `agent_settled`, not merely `agent_end`; `agent_end` is the conversation result boundary, while command response ordering can continue afterward. Retry behavior was not observed in these successful/no-retry arms and remains unverified for provider retry failures.

### B9 — `get_entries` + `since` durable cursor
**Status:** verified
The first RPC process returned entries and `leafId` `d5c69d5a`; the driver recorded that as the cursor, exited, and started a new process on the same session. The new process accepted `since:"d5c69d5a"` and returned an empty entries array with the same leafId. An unknown cursor returned `success:false` and `Entry not found` both before and after restart.

```text
raw capture: tasks/headless-worker/captures/pi-b9-cursor.jsonl
{"id":"entries-1","type":"response","command":"get_entries","success":true,"data":{"entries":[...],"leafId":"d5c69d5a"}}
### cursor=d5c69d5a
{"id":"bad-since-1","type":"response","command":"get_entries","success":false,"error":"Entry not found: does-not-exist-116"}
{"id":"entries-since-1","type":"response","command":"get_entries","success":true,"data":{"entries":[],"leafId":"d5c69d5a"}}
{"id":"bad-since-2","type":"response","command":"get_entries","success":false,"error":"Entry not found: does-not-exist-116"}
```

**Finding:** the entry-id cursor survives client restart because it is backed by the session file; it is a durable observation primitive, with unknown IDs reported as an explicit error.

### B10 — Crash/exit contract
**Status:** verified
The RPC child was SIGKILLed during `bash sleep 25`; its process record was `<<< first_exit code=null signal=SIGKILL`. The session file remained parseable: `wc -l` was 5 and its last line was a complete assistant tool-call message (shown below). A new RPC process opened that session and completed `B10-RESUMED-DONE`, exiting 0.

```text
raw capture: tasks/headless-worker/captures/pi-b10-crash.jsonl
### session_file=/private/tmp/pi116-scratch-OW2sEF/sessions/2026-08-13T18-11-19-662Z_116b1000-0000-4000-8000-000000000010.jsonl
### session_wc=5
### session_last={"type":"message","id":"3d39e8f8","parentId":"63539e06","timestamp":"2026-08-13T18:11:22.180Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_m1KqO2ci1KDeA0ZifNdjEeGx|fc_048039d44a750819016a7e08c9d15481919c5219b395ba52b8","name":"bash","arguments":{"command":"sleep 25","timeout":30}}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.6-luna","usage":{"input":760,"output":24,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":784,"cost":{"input":0.000152,"output":0.0000288,"cacheRead":0,"cacheWrite":0,"total":0.0001808}},"stopReason":"toolUse","timestamp":1786644679690,"responseId":"resp_048039d44a750819016a7e08c9d15481919c5219b395ba52b8","rawStopReason":"completed"}}
>>> {"id":"resume-1","type":"prompt","message":"The previous process was killed. Reply B10-RESUMED-DONE."}
verbatim final text: B10-RESUMED-DONE
<<< second_exit code=0 signal=none
```

**Finding:** SIGKILL leaves no RPC terminal event, but the durable session prefix is recoverable and a new process can resume. Recovery must account for an in-flight tool call not having a recorded tool result.

## Transport recommendation for #83

Choose a **long-lived `--mode rpc` process** held open by the daemon. The captures establish boundary `steer`, abort, and restart-surviving `get_entries` cursors, which one-shot JSON cannot provide during an active turn. The tradeoff is a larger process/crash blast radius and the need to recover a session after SIGKILL; B10 shows session-file recovery is possible, while A2 shows one-shot children have a simple lifecycle but lose mid-turn control. Evidence that would change this recommendation: a production-required guarantee that every dispatch is isolated from a crashed peer and that no mid-turn steer/abort/cursor observation is needed; or a future RPC regression that makes recovery/cursor durability fail.

## Adapter capability flags

| Flag | Live pi value | Evidence |
|---|---|---|
| `interjection` | `boundary` | `pi-b6-steer.jsonl` |
| `abort` | `true` | `pi-b7-abort.jsonl` |
| `resume` | `true` | `pi-a3-resume.jsonl`, `pi-b10-crash.jsonl` |
| `durable_cursor` | `true` | `pi-b9-cursor.jsonl` |

Today's adapter contract in `crew/adapters/adapter-pi.mjs:11-31` declares none of these flags; #85 is where the interjection column lands. This spike changes no adapter code.

## B11 (#148, 2026-08-14) — reassigning a SETTLED session

Added after #148 asked whether a pi RPC seat can take a bounce. Capture:
`captures/pi-b11-reassign.jsonl`; harness: `captures/pi-rpc-reassign.mjs`, kept
separate from `pi-rpc-driver.mjs` so this spike's checked-in evidence is not
altered.

The question is `drive.mjs`-shaped, not protocol-shaped. Every bounce path in
the loop — plan bounce, lane bounce, review bounce, gate repair — reassigns a
seat that has **already returned an envelope**. So "reassign" means: after
`agent_settled`, does a further assignment land and complete?

Three arms, one session (`b11-recall-148`), luna at `--thinking low`:

| Arm | What was sent | Result |
|---|---|---|
| A | after turn 1 settled, a second `prompt` on the **same process** | settled normally, replied `B11-SECOND-SAME-PROCESS-DONE` |
| B | first process `stdin.end()`, exit 0; **new process** with `--session`, then a `prompt` | settled normally, replied `B11-THIRD-NEW-PROCESS-DONE` |
| C | on that resumed process, "what marker did you reply with in your FIRST reply of this session?" | answered **`B11-FIRST-DONE`** — turn 1's marker, produced by a *different process* |

**Finding: a settled pi RPC session is reassignable, same-process and
cross-process, and history survives the process boundary.** Arm C is the
load-bearing one: delivery is not memory, and a bounce brief saying "revise
YOUR plan per this check" is worthless to a seat that cannot see the turn it is
being bounced on.

**Reporting caveat, recorded because it nearly misled this spike:** every
`agent_end` carries `messages` of length 2 (one user, one assistant) on all four
turns, including the recall turn. `agent_end.messages` is the **turn's**
messages, not the session context — reading it as context would have produced
the exact opposite conclusion. Arm C is what distinguishes them, and it is why
the arm exists: an observed success is not evidence about the mechanism behind
it (2026-08-07 conventions entry — capture the introspection surface separately
from the behaviour surface).

`adapter-pi.mjs`'s `headless-rpc` profile moves `reassign: false -> true` on
this capture. #131's `false` recorded the absence of a capture, not an observed
limitation.

**Not measured:** reassignment after an *aborted* rather than settled turn (b7
showed a fresh prompt works post-abort on the same process, but not
cross-process); reassignment after a crash mid-turn (b10 covers resume, not a
second assignment); concurrent clients on one session, which stays unmeasured
and is still why ADR-029 §5 constraint 3 is ours to enforce.

## #85 input — what interjection pi can promise

Pi can promise a **boundary steer**, not an interruption: send `steer` while a tool is running, the tool finishes undisturbed, then pi delivers the steer before the next LLM call. B6 shows the model actually saw the exact message. That is stronger than HW-1's claude result (`spike-findings.md` H5.2), where text stdin was read to EOF before the turn and kill+resume was the only correction path.

## Deferrals and open questions

- A2 did not measure a SIGTERM handler that gracefully flushes a terminal event; only direct child termination was measured.
- A3 did not measure session retention/garbage collection or a malformed/corrupt session file.
- B8 retry behavior remains unverified because no provider retry/failure occurred in these successful arms.
- B10 did not measure recovery when the process dies during a partially written JSON line or when the tool itself has externally visible side effects.
- No network disconnect, token expiry, model failover, compaction, or provider error was injected.
- The matrix did not measure concurrent RPC clients attached to one same session, only separate child processes in the JSON arm.
- The checker and captures establish structure and observations, not a guarantee that every prose claim is semantically supported; reviewer spot-check remains required.
