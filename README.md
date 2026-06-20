# dev-team

A Claude Code plugin that turns one assistant into a small, disciplined engineering org: an **orchestrator** that talks to you and delegates planning to on-demand **domain leads**, hands execution to **execute-only coders**, and gates everything through a **3-tier review ladder** — bound together by a spec contract, single-writer memory, and a deterministic multi-agent workflow.

It's a star, not a chat room: leads never talk to each other. The orchestrator spawns each agent, collects its result, and is the single writer of team memory. Disabling the plugin reverts Claude to vanilla behavior.

---

## Install

```text
/plugin marketplace add momoshell/dev-team-claude-plugin
/plugin install dev-team@dev-team
```

Then enable it (persists in `enabledPlugins`):

```text
/plugin enable dev-team@dev-team
```

**Local development** (working from a checkout instead of GitHub):

```text
/plugin marketplace add /absolute/path/to/dev-team-plugin   # dir containing .claude-plugin/marketplace.json
/plugin install dev-team@dev-team
# or, no marketplace needed:  claude --plugin-dir /absolute/path/to/dev-team-plugin
```

Once enabled, a `SessionStart` hook loads the orchestration rules each session. No further setup.

---

## How it works

Two ways to run the team:

| Mode | When | Entry |
|------|------|-------|
| **Conversational** (semi-auto) | Day-to-day work; the orchestrator proposes the team for non-trivial requests | just talk, or `/dev-team:team` |
| **Workflow** (deterministic) | Large or repeatable batches you want fanned out and gated automatically | `/dev-team:team workflow <goal>` |

### Activation tiers (conversational)

- **Tier 1 — trivial** (one file, obvious fix): handled directly. No ceremony.
- **Tier 2 — single domain** (multi-file): the orchestrator proposes one line — *"This looks like Tier 2 (…). Engage the team, or handle directly?"* — then runs `lead → coder → QA gate`.
- **Tier 3 — cross-domain / new architecture / phased**: `architecture-lead` drafts a TRD → independent review → your approval → phased execution.

It never silently takes over; it proposes and waits.

---

## The team

13 agents, each scoped to one job:

| Group | Agents | Role |
|-------|--------|------|
| **Leads** (plan, read-only) | `architecture-lead`, `backend-lead`, `frontend-lead`, `devops-lead`, `qa-lead` | Read memory, scope context, emit **Handover Specs**, propose memory deltas. Never edit code. |
| **Executor** | `coder` | Implements one Handover Spec exactly, within scope. Never plans or explores. |
| **QA gate** | `code-reviewer`, `code-reviewer-deep`, `build-validator`, `test-engineer` | Review (standard/deep), independent type-check + build, test authoring. |
| **Architecture** | `architect`, `trd-reviewer`, `doc-writer` | Second-opinion design, independent TRD review, ADR/README authoring. |

Agents are referenced as `dev-team:<name>` (e.g. `dev-team:backend-lead`).

---

## Commands

```text
/dev-team:team                  Engage the team for the current request now
/dev-team:team <request>        Engage for a specific request
/dev-team:team off              Stay direct this session (don't propose the team)
/dev-team:team auto             Run qualifying work through the team without asking
/dev-team:team status           Show activation mode + available leads
/dev-team:team workflow <goal>  Run the deterministic pipeline (below)
```

---

## Workflow mode

`/dev-team:team workflow <goal>` runs the bundled `team-build.workflow.mjs` via the Workflow tool. Per task it does **lead → coder (or `test-engineer` for `qa`) → gate**, where the gate runs the right reviewer tier **and** `build-validator` in parallel.

**Args** passed to the workflow:

```jsonc
{
  "goal": "string",
  "projectMemory": "<absolute path to project memory dir>",   // optional
  "tasks": [
    { "id": "be-01", "domain": "backend",  "brief": "add /orders endpoint", "files": ["src/api/orders.ts"] },
    { "id": "fe-01", "domain": "frontend", "brief": "orders list UI", "depends_on": ["be-01"] }
  ]
}
```

- **Plan-domains:** `frontend` · `backend` · `devops` · `qa`. Anything else (e.g. `mobile`, or `architecture` which is interactive Tier-3) is **rejected, not laundered** — returned in `rejectedTasks`.
- **`depends_on`** (task ids) drives **dependency-wave** scheduling: independent tasks run concurrently within a wave; a dependent waits for its prerequisites and is **skipped if any prerequisite fails its gate**. Cycles and unknown deps are skipped with a reason.
- **Risk-keyed review:** auth / migration / secrets / infra / public-API / etc. (and the whole `devops` domain) escalate to `code-reviewer-deep`; everything else gets `code-reviewer`.
- **Self-healing:** one amend-retry per task on a coder `insufficient` return (conversational mode allows up to two).

---

## The Handover Spec (the contract)

Every task is one spec — the only thing a lead emits and a coder consumes. 11 fields:

`task_id` · `domain` · `goal` · `files_in_scope` · `constraints` · `acceptance_criteria` · `validation_commands` · `discovery_context` · `out_of_scope` · `depends_on` · `interface_contract`

The lead's `discovery_context` must be complete enough that the coder never explores outside `files_in_scope`. The coder returns a structured result:

```text
status: done | insufficient | blocked
reason: <one line>
missing_context: <required when insufficient>
changes: <required when done — each file + one-line summary>
validation: <required when done — commands run + pass/fail>
```

Canonical definitions live in [`handover-spec.md`](./handover-spec.md); machine schemas in [`handover-spec.schema.json`](./handover-spec.schema.json) and [`coder-return.schema.json`](./coder-return.schema.json).

---

## Review ladder

Owned by `qa-lead`, applied at every gate:

1. **Standard** — `code-reviewer` (risk 0–1).
2. **Deep** — `code-reviewer-deep` (any deep trigger, or risk ≥ 2).
3. **Adversarial panel** — 3 reviewers, distinct lenses (correctness / security / rollback), majority pass — on stacked risk (≥ 3, or multiple deep triggers).

**Deep triggers:** auth/authz, secrets, encryption, tokens, passwords, payments, PII; DB migrations / destructive ops; CI/CD, infra, prod; public API/contract changes; security fix / incident / hotfix.

---

## Memory (two tiers, single writer)

The orchestrator is the **sole writer**; leads only *propose* deltas.

- **Project memory** (most of it): `<project-root>/.claude/dev-team/memory/` — `conventions.md`, `{frontend,backend,devops,qa}-notes.md`, `architecture-notes.md`.
- **Global memory** (sparse, cross-project): `~/.claude/dev-team/memory/conventions.md` — durable preferences that hold across all your projects.
- **Precedence: code > project memory > global memory.** Memory is a cache; contradicted entries are marked `deprecated`, never deleted.

---

## Following progress

This plugin uses standard Claude Code surfaces — no custom UI:

- **Workflow mode:** `/workflows` — live tree of phases (Plan → Build → Gate) → per-agent labels (`plan:backend-be-01`, `gate:…`) → drill in for prompt/tools/result. Narrator lines report each wave's result.
- **Conversational mode:** the **subagent panel** below the prompt (and `/agents`) shows each active lead/coder; the orchestrator narrates one-liners (`→ backend-lead: planning be-01`, `✓ …`).
- **Optional:** set `subagentStatusLine` in your `settings.json` for a richer per-agent row (`▸ backend-lead · plan:be-01 · 1m · 12k tok`).

---

## Repository layout

```text
.claude-plugin/
  plugin.json            plugin manifest
  marketplace.json       local marketplace manifest
agents/                  the 13 agent definitions
commands/team.md         the /dev-team:team command
hooks/hooks.json         SessionStart → loads orchestration.md
orchestration.md         the orchestrator's operating rules (loaded each session)
handover-spec.md         canonical spec template + conventions
handover-spec.schema.json
coder-return.schema.json
team-build.workflow.mjs  the deterministic workflow
```

---

## Requirements

- **Claude Code** with plugin support.
- **Node.js** — used by the Workflow tool to run `team-build.workflow.mjs` (workflow mode only).
- **jq** — only if you opt into the optional `subagentStatusLine` script; not needed by the plugin itself.
