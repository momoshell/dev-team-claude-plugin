# crew — the lean runtime

One brief in, one lane out. Agents do the work; code only starts it, checks it
and records it ([ADR-052](../docs/adr/adr-052-agents-do-the-work.md),
[`docs/plan-lean-runtime.md`](../docs/plan-lean-runtime.md)).

```
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

## The model

**Agents do the work; code keeps it correct.** A lane starts from one P1 brief
(`source`, `closes`, `tier`, `shape`, `acceptance` ids, `out_of_scope`; the
body is the ask). `crew/loop.mjs` runs it:

```
plan -> gate baseline (RED required) -> build -> gate (GREEN) -> mutation proof
     -> review -> full suite -> commit -> rebase -> PR
```

The lane name is the brief's file name. `crew start` runs the `standard` shape
only; `finish` (ADR-051) is the second entry path, started by `crew finish` from
an escalated lane. `stepped` (ADR-048) is retained schema and ADR vocabulary,
not executable: `crew start` refuses every new-lane shape except `standard`. Every loop is bounded, every envelope is
validated against a closed protocol (P2) and refused if it does not parse, and
the loop adds no other gate: no host-load gate, no dispatch-time baseline, no
measurement that holds work. Writing the record never throws into the caller.

Seat definitions are `crew/agents/<role>.md`; their frontmatter is the only
place a seat's model, agent (`claude` or `pi`), effort, skills, `requires`
and extensions are written, and the body is the charter. Tiers are
`mechanical`, `build` and `judge`; a tier entry overrides how a seat runs there
or unseats it. `crew/agents.mjs` resolves a tier and `crew/protocols.mjs` holds
the brief, envelope and agent-definition validators.

A tier override replaces only the fields it names and keeps a raw override model id exactly as written, with no namespace translation. A provider failure does not reseat the seat on another cell: the retry ladder in `crew/acp/provider.mjs` backs off and retries, and once the retry bound is exhausted the lane stops with the provider failure named.

## Runtime feature map
| Feature | Where it lives | ADR | Doc |
|---|---|---|---|
| Pi planner lab | `crew/mcp/lab-server.mjs` → `crew/pi/extensions/lab.ts` | - | - |
| Builderloop | `crew/pi/extensions/builderloop.ts` | - | - |
| Readgate | `crew/pi/extensions/readgate.ts` | - | - |
| FFF | `crew/adapters/adapter-pi.mjs` | - | - |
| Rule reminders (pi builder) | `crew/pi/extensions/reminders.ts` | - | - |
| Pi native codemode and MCP (a seat's `codemode: true` frontmatter arms builtin codemode; MCP follows the declared `extensions`; claude seats refuse `codemode: true` with `grant-unsupported`) | `crew/acp/seat.mjs` | - | [Conventions 2026-10-03](../docs/conventions.md) |
| Advisor | `crew/pi/extensions/advisor.ts` | ADR-047 ([decision](../docs/adr/adr-047-the-advisor-is-a-roster-seat.md)) | [The advisor is a roster seat](../docs/adr/adr-047-the-advisor-is-a-roster-seat.md) |
| Seat skills | `hooks/skill-gate.mjs` (skill-map selector, not a registered hook) | ADR-050 ([decision](../docs/adr/adr-050-seat-skills-are-granted-not-pasted.md)) | [Seat skills](../docs/adr/adr-050-seat-skills-are-granted-not-pasted.md) |
| Builder edit assist | `crew/pi/extensions/builderloop.ts`, `crew/acp/seat.mjs` | ADR-049 ([decision](../docs/adr/adr-049-builder-edit-assist.md)) | a seat's `edit_assist` frontmatter boolean turns the arm on or off; the old per-lane dispatch-batch rotation and `CREW_EDIT_ASSIST` activation belonged to the deleted driver and are history only: [Builder edit assist](../docs/adr/adr-049-builder-edit-assist.md) |
| Memory | `crew/memory.mjs` | - | - |
| Visualizer | `visualizer/web/src/lib/LeanRunDetail.svelte`, `visualizer/web/src/lib/LeanWaterfall.svelte` | - | [Visualizer](../visualizer/README.md) |
| ACP | `crew/acp-client.mjs` | ADR-036 ([decision](../docs/adr/adr-036-acp-seat-transport.md)) | [ACP decision](../docs/adr/adr-036-acp-seat-transport.md) |

The planner's pi seat receives native `mcp__lab__lab` (timeout 960 seconds); the retained `lab.ts` implements the tool. A seat that declares the `lab` extension refuses to boot with `extension-missing` if the server file is absent (`crew/acp/grants.mjs`).

**The seats** (ACP sessions, each played from its `crew/agents/<role>.md`):

| Seat | Job | Repo writes |
|---|---|---|
| `planner` | explores the code, writes the plan and the acceptance gate; envelope carries the plan and gate paths and the acceptance ids covered | none (task dir only) |
| `builder` | edits the repo, tests included; on a finish run may repair the gate and returns replacement mutations | the only seat that writes the repo |
| `reviewer` | verdict and typed findings; conformance to plan, then correctness | none |
| `lead` | answers an escalation with one closed decision | none |
| `tech-lead` | optional plan adversary, a different model or effort | none |

A seat loads its `requires` skills before its first write, or its envelope is
refused (`crew/skills-proof.mjs`). Scope is context, not enforcement
(ADR-045): a lane may write any file.

## Checks

`crew/checks.mjs` owns what code verifies:

- **Gate** — `task/gate.mjs` prints `FAIL <id>` per failing acceptance id. It
  must be red at baseline and green after the build.
- **Mutation proof** — each gate check has a `{check, file, find, replace}`
  declaration that turns exactly that check red; the loop applies it and
  restores the tree (`crew/tree-fingerprint.mjs`).
- **Suite** — the full suite runs with a timeout and a process-group kill.
- **Commit, rebase, PR** — only on green; the PR is opened, never merged.

## Contracts

Everything durable is a file; session chat is never the record.

- **P1 brief** and **P5 agent definition**: markdown with frontmatter.
- **P2 envelope**: one JSON object per seat turn at the path the loop issued,
  `{ role, id, status: done|insufficient|escalate, summary, details }`; the
  loop reads it back from that path and checks the id.
- **P3 gate**: `task/gate.mjs`, with one kill-mutation per check.
- **P4 journal and sessions**: one append-only JSONL per lane and one session
  file per seat turn holding its full ACP update stream, under
  `<task>/lean/<role>/`. `crew show` reads them; the visualizer reads them.

## Files

- `start.mjs` — `crew start`: checks the brief, creates the worktree, starts the detached run.
- `lean.mjs` — the detached entry; plays each seat turn over ACP and writes the session files.
- `loop.mjs` — the loop: bounded rounds, lead consults, the `finish` shape, journal rows.
- `checks.mjs` — gate, mutation proof, suite, commit, rebase, PR.
- `agents.mjs`, `protocols.mjs` — agent definitions, tiers, and the closed protocols.
- `acp/`, `acp-client.mjs`, `acp-permission.mjs` — the ACP seat transport, grants and permission handling.
- `skills-proof.mjs` — the required-skill proof.
- `show.mjs`, `lanes.mjs`, `finish.mjs`, `record-pr.mjs`, `closeout.mjs` — the other verbs.
- `reclaim.mjs` — token-fenced transition locks, the lease surface and parks, documented in
  `docs/park-lease-protocol.md`.
- `adapters/adapter-*.mjs` — per-agent launch shapes for `claude` and `pi`.
- `pi/extensions/` — the kept pi arms (readgate, builderloop, reminders, skeletonread, subagent, advisor, lab).
- `mcp/lab-server.mjs` — the planner's lab tool server.
- `memory.mjs` — lane memory.
- `agents/*.md` — delivered seat definitions and instructions.
- Tests sit beside the code as `*.test.mjs`.

## Posture

Seats run unattended, so the enforced tool boundary is each seat's grants, not
a prompt. Only the builder is granted repo writes; other seats write their
envelope and task-dir artifacts. Worktree isolation separates lanes, not seats
within a lane. The loop opens a PR after a green suite and never merges.
