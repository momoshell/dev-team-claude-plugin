# ADR-052 — Agents do the work; code keeps it correct

**Status:** *ratified* 2026-10-24, operator decision (D1-D9 in `docs/plan-lean-runtime.md`) · **Owner:** operator ·
**Relates to:** ADR-029 (headless observability), ADR-035 (run configuration axes), ADR-036 (ACP seat transport),
ADR-044 (declared topologies), ADR-045 (scope is context), ADR-047 (advisor seat), ADR-048 (ordered build steps),
ADR-049 (edit assist), ADR-050 (seat skills), ADR-051 (finish shape), epic #1964 (roster swap as one edit)

The operator's direction, 2026-10-24: "the brief should be made from the source starting it, for example
github issues, or user commands, and then briefed for the seat lane, where ultimately the planner picks it
up ... Mechanical code for our plugin should be here only to provide support for the harness proper
functioning ... We should remove as much code as we can, have the code act as the support for agents, and
define protocols we use, and agent front matter we need."

This record sets the boundary between code and agents, names the protocols that cross it, and sets a size
budget. The work plan that carries it out is `docs/plan-lean-runtime.md`.

Repository figures below were measured at `416ddb2a`; the test figures at `a73ab2ad`.

## Why (measured 2026-10-24)

**Time before a planner sees the task.**

| Lane | Request to brief | Brief to boot | Notes |
|---|---|---|---|
| the-power t60l | 4 min (14:50 to 14:54) | 8 min (14:54 to 15:02) | 6.5 min of it between the ready script and run start, cause unmeasured |
| the-power t113g | 10 min (15:12 to 15:22) | 1 min | `make-brief` ran a baseline suite in a child process |
| the-power t56c2 | 14 min (15:10 to 15:24) | | `make-brief` still in its baseline child at 22 min elapsed |
| b1354 (this repo) | 11 min: baseline 5 min 21 s, compile 5 min | 21 min at the host-load gate, then killed | gate threshold 0.5 per core; load 15 to 30 on 16 cores, held by the-power lanes |

b1354 also cost about 30 minutes of operator-session premise work and one refused dispatch before any of
this (advisor rotation, fixed in PR #1967). Its second dispatch, with the load gate off, took 22 minutes
from start to a running seat.

**The compiled brief duplicates the planner.** b1354's compiled brief is 32,410 bytes: symbol index,
tripwires, coupled files, conventions and a proposal. The planner's own assignment is about 1.5 KB that
points at it (`brief_bytes` 1575 and 1569 in the t60l and t113g journals), and within its first minute the
planner reads source itself (`read_gate_refusal` rows at 13:24:03Z in t113g). The compile pays a full suite
run to precompute exploration the planner repeats.

**Size.** `crew/` holds 51,287 source lines and `scripts/factory/` 41,034 (92,321 together). Tests are
179,479 lines in 132 files. `crew/drive.mjs` alone is 17,902 lines (1.08 MB) and `scripts/factory/ledger.mjs`
10,572. Nine `skills/*/anchors.json` manifests and their exhibit suites pin line numbers in prose. PR #1967,
merged the same day, was the mechanical layer repairing itself: a roster edit had blocked every build-tier
dispatch.

## Decision

### 1. The boundary

Code does only these things:

1. Start a step with the right agent definition, in a worktree.
2. Deliver the brief to that agent.
3. Validate what comes back against a protocol, and refuse what does not parse.
4. Run the correctness checks: the acceptance gate is red at baseline and green after the build, each gate
   check has a mutation that kills it, the full suite is green, and commit and PR happen only on green.
5. Prove that the skills an agent definition requires were loaded before its first write.
6. Keep the record: one journal per lane and every seat's full session, so any session can be inspected
   afterwards. Writing the record never throws into the caller.

Code adds no other gate before or during a lane: no host-load gate, no dispatch-time baseline, no premise or
warning pass, no measurement that can hold or refuse work.

Everything else is agent work, carried by a skill: turning a source into a brief, exploring the code,
choosing files, writing the plan and the gate, triage, recovery, analysis of the journal.

### 2. Source, brief, planner

A lane starts from a source: a GitHub issue or an operator command. The operator session, or a brief-writer
subagent with the `lane-brief` skill, writes one short brief (protocol P1) and starts the lane with it. The
planner reads the brief and explores the code. There is no brief compile and no precomputed symbol,
tripwire, coupled-file or convention file.

### 3. Protocols (closed list)

| Id | Protocol | Shape |
|---|---|---|
| P1 | Lane brief | Markdown with frontmatter: `source`, `closes`, `tier`, `shape`, `acceptance` ids, `out_of_scope`; body is the ask and the context pointers |
| P2 | Seat envelope | JSON per role: `role`, `id`, `status` (`done`, `insufficient`, `escalate`), `summary`, role `details` (plan: plan and gate paths, acceptance ids covered; build: summary; review: verdict and typed findings; lead: one closed decision) |
| P3 | Acceptance gate | `task/gate.mjs` prints `FAIL <id>` per failing check; red at baseline, green after; one kill-mutation per check |
| P4 | Journal and sessions | One append-only JSONL per lane (stage start and end, envelope, verdict, check result, commit, PR) and one JSONL per seat session holding its full ACP update stream |
| P5 | Agent definition | `crew/agents/<role>.md` frontmatter, below |

`shape` is `standard`, `stepped` (ADR-048) or `finish` (ADR-051). Adding a protocol, or a field that code
reads, needs an amendment to this record.

### 4. Agent definitions replace the roster and the grant tables

Each seat is one file, `crew/agents/<role>.md` (Amendment 1). Its frontmatter is the only place a seat's model and powers are
written; its body is the charter.

```yaml
---
name: planner
description: Plans one lane from its brief and writes the acceptance gate.
role: planner
writes: task-dir
envelope: plan
agent: pi
model: openai/gpt-6.1-sol
effort: high
fallback: []
skills: [plan, qa-test-writing]
requires: [qa-test-writing]
tools: [read, grep, bash]
extensions: [readgate, lab]
advisor: null
edit_assist: false
codemode: false
memory: false
rounds: 2
wait_s: 1800
tiers: {"mechanical": {"effort": "medium"}, "judge": {"effort": "xhigh"}}
---
```

Each field is one line. Objects and object lists are JSON (Amendment 1). `role` is one of lead, planner,
builder, reviewer, tech-lead; `writes` is none, task-dir or repo; `envelope` names the P2 role schema; `agent`
is claude or pi. A `fallback` entry stays on the seat's agent. A seat loads its `requires` skills before its
first write, or its envelope is refused. `extensions` draws from the kept arms: readgate, lab, builderloop,
reminders, skeletonread, subagent, fff. `advisor` is null or `{"agent", "model", "effort"}` (ADR-047), and
`edit_assist` is ADR-049. `tiers` keys are the three tiers; a null value unseats the role at that tier, and an
object overrides how the seat runs there.

This replaces `crew/roster.json`, the grant policy in `crew/capabilities.json`, `skills/skill-map.json`,
`crew/workflows.mjs`, and most of `crew/variants.mjs`, `crew/assurances.mjs`, `crew/task-profiles.mjs` and
`crew/run-configuration.mjs`. A roster swap becomes an edit to frontmatter, validated by the boot checks in
`crew/roster-validate.mjs` (PR #1968). Epic #1964 is subsumed.

The arms in the frontmatter (advisor, edit assist, codemode, lab, readgate, memory, and the stepped and
finish shapes) are carried over as they are. Whether each stays is decided in a later phase, not here.

### 5. Transport and inspection

ACP is the one seat transport on the new path, as ADR-036 already decided: `claude-agent-acp` for claude
seats and `crew/pi/acp-bridge.mjs` for pi seats. Its client is 1,071 lines against 4,961 for the two bespoke
transports it replaces (`headless.mjs` for claude, `headless-rpc.mjs` for pi). cmux panes and the headless
daemon (`daemon.mjs`, `factoryctl.mjs`, `child.mjs`) are not carried over. A lane runs as one detached
`crew` process. Inspection reads the journal and the seat session files (P4), through `crew show` and the
visualizer.

### 6. The loop

```
plan -> gate baseline (red) -> build -> gate (green) -> review -> suite -> commit -> PR
```

Rounds are bounded per role by frontmatter. The lead is consulted when a seat returns `escalate` or a bound
is reached, and answers with one closed decision. A protected-floor touch raises the tier to `judge`, which
adds review rigour and a mutation on the changed behaviour (ADR-038 stays). The `stepped` shape runs the
build in ordered steps; the `finish` shape starts at build from an existing branch.

### 7. Migration

The new path is built beside the current runtime, not inside it. Lanes run on it while the old path keeps
working. The operator switches the default when satisfied; then the old modules are deleted with their
tests in the same PR. All of this work happens in this repository; no other project is touched.

### 8. Size budget

The core, `crew/` plus `scripts/factory/` without the kept arms, is budgeted at 10,000 lines, from 92,321. A
new module names the protocol or the check in section 1 it serves, or it does not land. The kept arms are
counted separately until each is decided.

## What stays

The honesty doctrine as it applies to what is recorded: unknown is `null` with one closed reason, a rate
carries its denominator, a gate check without a kill-mutation is not evidence, writing the record never
throws. The protected floor. Worktree isolation (ADR-043). Scope as context (ADR-045). The three tiers.

## What this does not decide

Whether each arm stays: advisor, edit assist, codemode, lab, readgate, builderloop, reminders, skeletonread,
subagent, memory, the stepped shape and the finish shape. Those are decided in a later phase. Moving any
other project to the new path is out of scope.

## Amendment 1 (2026-10-24): seat files live in `crew/agents/`

Seat definitions move from the repository-root `agents/` folder to `crew/agents/<role>.md`. Claude Code
loads a plugin's root `agents/` folder as subagents of the operator's own session, so seat files there would
offer planner, builder and the rest as operator subagents with models Claude Code cannot run. The root
folder keeps operator-side agents such as `agents/brief-writer.md`.

Each frontmatter field is one line, with JSON for objects and object lists, and carries no trailing comment.
Section 4's example is written in that form, so the P5 parser reads it as it stands.
Nothing else in section 4 changes.

## Amendment 2 (2026-10-26): claude seats run the arms as plugin hooks

A claude seat used to refuse every pi arm, because the arms are `crew/pi/extensions/*.ts` and attach to pi's
events. Two live probes on 2026-10-26, over `claude-agent-acp` 0.86.0, showed that Claude Code plugin hooks
carry the arms the operator wants on a claude seat. On a claude ACP seat, readgate, skeletonread, reminders,
builderloop (with edit assist) and the advisor now run as the hooks of one crew-owned plugin, listed in the
launch's `_meta.claudeCode.options.plugins` beside any skills plugin. The hooks run the same factories pi loads
and write no arm's rules a second time; the plugin only translates Claude's hook payloads into the events the
factories read and their results back into hook output.

| Arm | Hook | Effect |
|---|---|---|
| readgate | PreToolUse | `permissionDecision: deny` with readgate's own reason |
| skeletonread | PostToolUse | `updatedToolOutput`: the tool's own `tool_response`, cloned, with `file.content`, `file.numLines` and `file.totalLines` (Read) or `stdout` (Bash) replaced; a plain string is dropped by Claude |
| advisor | PostToolUse, PostToolUseFailure | `additionalContext`: the tier-0 note |
| reminders | SessionStart, PostToolUse | `additionalContext`: the role's table at session start; a rule's reminder after its tool |
| edit assist (builderloop) | PreToolUse | `additionalContext`: the file-derived hint, **one tool call late** |

Three things follow from Claude's hooks, and are the price of the decision.

- **Edit assist arrives one call late.** Claude validates an Edit's input before any hook fires, so a failed
  Edit (old_string not found) has no hook. The next PreToolUse hook reads the session's `transcript_path`, finds
  the errored `tool_result` it has not yet hinted, pairs it with its `tool_use` input, and hands builderloop's
  existing failed-edit path the result in the shape that path reads. The hint is added once per failed tool call.
- **A hook is a fresh process.** What an arm keeps between tool calls (readgate's delivered ranges, the advisor's
  repeat counts and cadence, builderloop's corpus and rerun guard, the reminders already fired) is exported by the
  factory and stored in a file under the lane's task dir, one per seat session and run, written atomically under a
  lock. Pi never calls the export or import; its closure is unchanged.
- **The tier-1 judgment is not run.** The advisor's model consult outlives a hook, so a claude seat gets the tier-0
  predicates (scope breach, tripwire touch, repeated failure, growth divergence) and not the judgment channel.
  builderloop's fenced lane run after a successful edit is not carried either: it would hold a hook for up to
  thirty seconds, and the seat has Bash. Its rerun refusal, its test-output filter and edit assist are.

Grants stay explicit. The arms a seat carries are written into the plugin's `config.json` at launch; an arm not
in it is never imported, and an ambient `CREW_ADVISOR` or `CREW_EDIT_ASSIST` grants nothing. A hook that fails,
or whose stored state is not its own, prints nothing and exits 0: a granted arm that breaks never changes the
turn. A claude seat with a context arm gets the same lane-context check before boot as a pi seat (PR 2007).

Unchanged: pi seats load the `.ts` extensions as they do; **subagent and codemode still refuse on a claude seat**
(`grant-unsupported`, before any client exists); the old headless and pane transports still refuse every
extension grant; the old ACP transport (`crew/acp-io.mjs`) neither materialises the plugin nor reads the advisor
or `edit_assist`, because `adapter-claude`'s `acpLaunch` takes the arms path only when the lean seat opts in
(`armHooks`); `crew/agents/*.md` frontmatter values do not change. Token budget and output caps are a later
lane.
