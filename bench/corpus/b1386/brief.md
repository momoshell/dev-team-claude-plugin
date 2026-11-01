# Task

---
source: operator request 2026-10-26 (claude seats run the same arms as pi seats, through Claude Code plugin hooks over ACP)
closes: null
tier: judge
shape: standard
acceptance: [CH1, CH2, CH3, CH4, CH5, CH6]
out_of_scope: crew/drive.mjs, crew/crew.mjs, the old headless and pane paths, the pi side of every arm (pi seats keep loading the .ts extensions as they do), codemode and subagent on claude seats, token budget and output caps (a later lane), crew/agents/*.md frontmatter values
---
## The ask

Today a claude seat refuses every pi arm (`seatGrants` in `crew/acp/seat.mjs` on the lean path, `assertSupportedGrants` in `crew/adapters/adapter-claude.mjs` on the old one). The
operator wants claude seats to run readgate, skeletonread, reminders, the advisor and edit assist (builderloop)
too. Two live probes on 2026-10-26 showed that Claude Code plugin hooks over claude-agent-acp 0.86.0 can carry
each one:

- PreToolUse deny with a `permissionDecisionReason`: the model reads the reason (readgate).
- PostToolUse `updatedToolOutput`: replaces a built-in tool's output. It must keep the tool's own output shape:
  clone `tool_response` and edit it (for Read, `file.content`, `file.numLines`, `file.totalLines`; for Bash,
  `stdout`). A plain string is dropped silently (skeletonread).
- PostToolUse and SessionStart `additionalContext`: the model reads it (advisor notes, reminders).
- A failed Edit (old_string not found) fires NO hook: Claude validates the input first. A PreToolUse hook on the
  next tool call can find the errored `tool_result` in `transcript_path` and add the hint as `additionalContext`.
  It arrives one call late (edit assist).
- Plugins are loaded through `_meta.claudeCode.options.plugins`, which `acpLaunch` already uses for skills.

Build one crew-owned plugin whose hooks run the existing arm logic from `crew/pi/extensions/*.ts`, so no arm's
rules are written twice. Each hook call is a fresh process, so any state an arm keeps between tool calls (the
advisor's repeat counts and cadence, for example) must live in a file under the lane task dir. On a claude seat,
lift the refusal for exactly the arms this lane carries; subagent and codemode keep refusing. Record the
decision as Amendment 2 to ADR-052: on claude seats the arms run as plugin hooks, and edit assist is one call
late.

Invariant: an arm that is not granted never runs, and a granted arm that fails never changes the turn (a hook
error is the same as no hook).

## Context

- `crew/pi/extensions/advisor.ts`, `readgate.ts`, `skeletonread.ts`, `reminders.ts`, `builderloop.ts`: the
  arms. Each attaches to pi through `pi.on(...)` handlers and returns or sends its effect.
- `crew/adapters/adapter-claude.mjs` `acpLaunch`, `assertSupportedGrants`, `skillsPluginDir`,
  `writeSeatSkills`: where the plugin is materialised and attached today.
- `crew/acp/seat.mjs` `runAcpSeat`, `seatGrants`, `contextArms` and `laneContext`: the claude branch that builds the launch, and the pre-boot check (PR 2007) that refuses a pi seat whose arms cannot read the lane context. Claude seats need the same check.
- `crew/pi/context-layout.mjs` (PR 2007): where an arm finds the lane journal, run-start and planner return; `CREW_CONTEXT_LAYOUT=lean` selects the lane layout. Hooks resolve context through it too.
- Recorded hook payloads from the live probe (keep them as test fixtures; do not hand-build frames):
  `/Users/momoshell/.crew/briefs/assets/b1386-hook-captures.jsonl` (one hook input per line: SessionStart,
  PreToolUse, PostToolUse for Bash and Read, Stop) and
  `/Users/momoshell/.crew/briefs/assets/b1386-transcript.jsonl` (the session transcript, including a failed
  Edit's errored `tool_result`). The probe hook that proved each output shape is
  `/Users/momoshell/.crew/briefs/assets/b1386-probe-hook.mjs`.
- `docs/adr/adr-052-agents-do-the-work.md` section 4 and Amendment 1; `docs/adr/README.md` register.
- `crew/crew-adapters.test.mjs` and `crew/acp/seat.test.mjs`: the tests that pin the claude launch.

## Acceptance

- (CH1) a claude seat granted readgate gets a PreToolUse deny with readgate's reason for a read readgate refuses
- (CH2) a claude seat granted skeletonread gets the skeleton in place of a large Read's output, in Read's own output shape
- (CH3) a claude seat granted an advisor gets the repeated-failure note after a repeated failing Bash call
- (CH4) a claude builder granted edit_assist gets the file-derived hint on the tool call after a failed Edit
- (CH5) a claude seat granted reminders gets the reminder text at session start
- (CH6) a claude seat granted subagent still refuses to launch
