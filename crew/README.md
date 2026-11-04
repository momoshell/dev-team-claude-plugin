# crew — the lean runtime

One brief in, one lane out. Agents do the work; code only starts it, checks it
and records it ([ADR-052](../docs/adr/adr-052-agents-do-the-work.md),
[`docs/plan-lean-runtime.md`](../docs/plan-lean-runtime.md)).

```
crew onboard --check <draft.json> [--checkout <dir>] # calibrate the checkout
crew start <brief.md> [--check] [--checkout <dir>]   # worktree + journal + a detached lane
crew lanes [--all] [--json]                          # list lanes from their journals
crew show <lane> [<role>] [--json]                   # read a lane's recorded seat sessions
crew finish <lane>                                   # finish a stopped lane with its own builder seat
crew finish <lane> --accept [--notes <file>] | --return <file> | --abandon
crew record-pr <lane> --pr <url>                     # record the PR a stopped lane was hand-finished in
crew closeout <lane>                                 # remove a merged lane's worktree and branch, archive its directory
crew viz                                             # serve the visualizer from the crew home
crew where                                           # the crew home, its branch and its commit
crew update [--force]                                # fast-forward the crew home to origin/main and rebuild what changed
```

`crew` is `bin/crew.mjs`. The crew home is the checkout it lives in (symlinks
resolved), or `CREW_HOME` when set. State lives under `~/.crew/dt-<lane>/<lane>/`:
the brief, the task directory, the lane journal and every seat's session file.

`crew update` refuses unless the crew home is on branch `stable` with no tracked changes; `--force` only overrides the refusal when processes still run from the home.

## The model

**Agents do the work; code keeps it correct.** A lane starts from one P1 brief
(`source`, `closes`, `shape`, optional `out_of_scope`, `mechanical`, `suite`, `generated` and `regenerate`; absent `out_of_scope` means none. The
body has the quoted operator ask and bare Context pointers, or bare Context pointers alone for an issue; `crew start` quotes the issue body as the ask). `crew/loop.mjs` runs it:

```
build:      plan -> rebase -> build -> per-test proof -> (full suite || review) -> PR
judge:      plan -> rebase -> build -> per-test proof -> full suite -> review -> second review -> PR
mechanical: rebase -> build -> per-test proof -> full suite -> PR
```

A fix turn carries the red results back to the builder, then repeats proof, the suite and the tier's reviews. Build and judge do not automatically rerun a red suite on an unchanged tree. Before publishing, each lane commits and rebases. A publishing or finish base rebase conflict gets one builder conflict turn per run; an unresolved or spent turn stops `rebase-conflict`. Build, judge and finish commit only the tree their suite and reviews checked. If the head changes, they put the change on the new base tip and repeat every check, including reviews. If Git drops the commit as already upstream, they stop. Mechanical re-proves and re-tests a moved head.

A brief may choose `mechanical: true` for a change with no behaviour to judge. With no named test, its PR states `proof: none, mechanical lane, not reviewed`; the operator reviews the diff before merging. Protected paths restart it as judge, and builder insufficiency restarts it as build.

The lane name is the brief's file name. `crew start` runs the `standard` shape
only; `finish` (ADR-051) is the second entry path, started by `crew finish` from
an escalated lane. A claim whose run is provably gone is taken over. A committed
build with no remote branch is uncommitted and finished if HEAD is the commit or
its journal-recorded one-commit rebase. The latter is reset onto the rebase base;
the journal records `finish-uncommit`. `--return` refuses with `finish-rounds-spent`
once three review rounds are spent. On `--accept`, issue tokens in the measured
text and notes are rewritten; issue numbers appear only on trailer lines.
Every loop is bounded, every envelope is
validated against a closed protocol (P2) and refused if it does not parse, and
the loop adds no other gate: no host-load gate, no dispatch-time baseline, no
measurement that holds work. Journal writes do not throw into the caller. A failed session-file write fails the turn because skill proof reads that recording (`lean.mjs`, `guardedAppend`).

ADR-055 §12 routes an escalation without `details.question` back to the same seat. On build and judge, a builder's `insufficient` goes to the lead with its envelope; the lead routes it to the builder or planner, or escalates a §12 case. Mechanical insufficiency restarts as build. The lead's last consult is marked last; a spent lead bound stops for the operator with a question drawn from the held envelope and lead decision. Repeated failures with the same evidence stop as `no-progress` without a seat decision. On build and judge lanes the planner's P2 `details.tests` decides whether P3 proof is required; an empty list means no criterion is machine-checked. A mechanical builder may name no test.

Seat definitions are `crew/agents/<role>.md`; their frontmatter is the only
place a seat's model, agent (`claude` or `pi`), effort, skills, `requires`
and extensions are written, and the body is the charter. Tiers are
`mechanical`, `build` and `judge`; a tier entry overrides how a seat runs there
or unseats it. `crew/agents.mjs` resolves a tier and `crew/protocols.mjs` holds
the brief, envelope and agent-definition validators. ADR-055 §7 raises lanes to judge for the planner's reason or protected paths; it never lowers them.

A tier override replaces only the fields it names and keeps a raw override model id exactly as written, with no namespace translation. A provider failure does not reseat the seat on another cell: the retry ladder in `crew/acp/provider.mjs` backs off and retries, and once the retry bound is exhausted the lane stops with the provider failure named.

## Runtime feature map
| Feature | Where it lives | ADR | Doc |
|---|---|---|---|
| Readgate | `crew/pi/extensions/readgate.ts` | - | - |
| FFF | `crew/adapters/adapter-pi.mjs` | - | - |
| Advisor | `crew/pi/extensions/advisor.ts`, `crew/agents/builder.md` (advisor model) | [ADR-047](../docs/adr/adr-047-the-advisor-is-a-roster-seat.md) | - |
| Skeletonread | `crew/pi/extensions/skeletonread.ts` | - | - |
| Subagent | `crew/pi/extensions/subagent.ts` | - | - |
| Per-test proof | `crew/proof.mjs` | [ADR-055](../docs/adr/adr-055-planner-defines-the-work.md) | - |
| Seat skills | `hooks/skill-gate.mjs` (skill-map selector, not a registered hook) | ADR-050 ([decision](../docs/adr/adr-050-seat-skills-are-granted-not-pasted.md)) | [Seat skills](../docs/adr/adr-050-seat-skills-are-granted-not-pasted.md) |
| Memory | `crew/memory.mjs` | - | - |
| Visualizer | `visualizer/web/src/lib/LeanRunDetail.svelte`, `visualizer/web/src/lib/LeanWaterfall.svelte` | - | [Visualizer](../visualizer/README.md) |
| ACP | `crew/acp-client.mjs` | ADR-036 ([decision](../docs/adr/adr-036-acp-seat-transport.md)) | [ACP decision](../docs/adr/adr-036-acp-seat-transport.md) |

**The seats** (ACP sessions, each played from its `crew/agents/<role>.md`):

| Seat | Job | Repo writes |
|---|---|---|
| `planner` | explores the code and writes the plan: criteria, properties with tests, and tasks | none (task dir only) |
| `builder` | edits the repo and names tests to prove | the only seat that writes the repo |
| `reviewer` | verdict, requirements, ranked findings, failure modes and coverage | none |
| `lead` | answers an escalation with one closed decision | none |
| `tech-lead` | judge loop's automatic second review | none |

A seat loads its `requires` skills before its first write, or its envelope is
refused (`crew/skills-proof.mjs`). Scope is context, not enforcement
(ADR-045): a lane may write any file.

## Checks

`crew/proof.mjs` and `crew/checks.mjs` own what code verifies:

- **Proof** — each named test must fail in its own body on the old source and pass on the build. This is not a kill proof.
- **Suite** — the full suite runs with a timeout and a process-group kill.
- **Commit, rebase, PR** — only on green; the PR is opened, never merged.

## Contracts

Everything durable is a file; session chat is never the record.

- **P1 brief** and **P5 agent definition**: markdown with frontmatter.
- **P2 envelope**: one JSON object per seat turn at the path the loop issued,
  `{ role, id, status: done|insufficient|escalate, summary, details }`; the
  loop reads it back from that path and checks the id.
- **P3 gate**: retired by ADR-055; proof reads builder `details.tests`.
- **P4 journal and sessions**: one append-only JSONL per lane and one session
  file per seat turn holding its full ACP update stream, under
  `<task>/lean/<role>/`. `crew show` reads them; the visualizer reads them.

## Files

- `start.mjs` — `crew start`: checks the brief, creates the worktree, starts the detached run.
- `lean.mjs` — the detached entry; plays each seat turn over ACP and writes the session files.
- `loop.mjs` — the loop: bounded rounds, lead consults, the `finish` shape, journal rows.
- `proof.mjs` — per-test proof.
- `checks.mjs` — suite, commit, rebase, PR.
- `agents.mjs`, `protocols.mjs` — agent definitions, tiers, and the closed protocols.
- `acp/`, `acp-client.mjs`, `acp-permission.mjs` — the ACP seat transport, grants and permission handling.
- `skills-proof.mjs` — the required-skill proof.
- `show.mjs`, `lanes.mjs`, `finish.mjs`, `record-pr.mjs`, `closeout.mjs` — the other verbs.
- `reclaim.mjs` — token-fenced locks and the per-seat reservation markers the ACP client takes (`reserve`, `advance`, `clear`, `probeEvidence`).
- `adapters/adapter-*.mjs` — per-agent launch shapes for `claude` and `pi`.
- `pi/extensions/` — the kept pi arms (readgate, skeletonread, subagent, advisor).
- `memory.mjs` — lane memory.
- `agents/*.md` — delivered seat definitions and instructions.
- Tests sit beside the code as `*.test.mjs`.

## Posture

Seats run unattended, so the enforced tool boundary is each seat's grants, not
a prompt. Only the builder is granted repo writes; other seats write their
envelope and task-dir artifacts. Worktree isolation separates lanes, not seats
within a lane. The loop opens a PR after a green suite and never merges.

## Environment

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `CREW_READGATE_MAX_LINES` | `pi/extensions/readgate.ts`, `pi/extensions/skeletonread.ts` | 350 | Sets the whole-read line limit and skeletonread's source-line threshold; it does not limit skeleton output. |
| `CREW_READGATE_MAX_BYTES` | `pi/extensions/readgate.ts` | 24576 | Sets the read output byte cap and cat refusal threshold; directly handed files have an exception. |
| `CREW_ACP_PERMISSION_TIMEOUT_MS` | `pi/extensions/acp-server.ts` | 300000 | Sets the permission request timeout in milliseconds. |
| `CREW_ACP_BRIDGE_STARTUP_MS` | `pi/acp-bridge.mjs` | 120000 | Sets the ACP bridge startup timeout in milliseconds. |
| `CREW_MEMORY_DIR` | `lean.mjs` | `<checkout>/.claude/dev-team/memory` | Selects the memory directory loaded for a seat. |
