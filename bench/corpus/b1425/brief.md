# Task

---
source: operator request 2026-10-29 (scouts are granted but never used; activate them when the work is wide)
closes: null
tier: build
shape: standard
acceptance: [SN1, SN2, SN3, SN4]
out_of_scope: the scout definition and its model; the builder seat; the advisor; claude seats
---
## The ask

The planner and reviewer seats load `crew/pi/extensions/subagent.ts` (PR 2044), but no seat has called its
`agent` tool: across lanes b1421-b1424 the planners and reviewers spawned 0 scouts. Nothing in their charters says
when to use one. Make scouts get used when the work is wide, in two parts:

1. A charter rule. `crew/agents/planner.md` and `crew/agents/reviewer.md` gain one short rule: when answering a
   question means reading many files or an area the brief's Context does not name, ask a `scout` that question
   instead of reading it all yourself, then read only what its findings cite.
2. A nudge from what the seat actually does. While the `agent` tool is granted, the extension counts the seat's
   read-type tool calls (read, grep, find, ls) since its last write or scout call. When the count passes a
   threshold and the reads span several directories, it sends the seat one short message suggesting a scout.
   It nudges at most once per turn, writes one journal row when it does, and never blocks or changes a tool call.
   The tool that provides scouts is the natural home: no grant, no nudge.

Invariants: a seat without the `agent` tool never gets the nudge; writing the journal row never throws into the
seat; the nudge is advice and the seat may ignore it.

## Context

- `crew/pi/extensions/subagent.ts`: `createAgentTool`, the extension entry, `usageRow` and how it appends journal
  rows (`journalPathFrom`).
- `crew/pi/extensions/advisor.ts` and `crew/pi/extensions/reminders.ts`: how an arm watches tool calls and sends a
  message to the seat.
- `crew/agents/planner.md`, `crew/agents/reviewer.md`: the charters; `crew/acp/grants.mjs` `armGrants`.
- Tests to read first: `crew/pi/extensions/subagent.test.mjs`.

## Acceptance

- (SN1) the planner charter names the scout rule
- (SN2) the reviewer charter names the scout rule
- (SN3) a seat granted the agent tool receives one nudge after reads past the threshold across several directories
- (SN4) a second run of reads past the threshold in the same turn sends no second nudge
