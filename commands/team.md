---
description: Engage or configure the dev-team workflow (request / off / auto / status / workflow)
---

Interpret `$ARGUMENTS`:

- **a request, or empty** → engage the team for this request now, skipping the semi-auto suggestion. Classify it; for Tier 3, have `dev-team:architecture-lead` produce the artifact-routed architecture package (PRD-lite/TRD/ADR only as needed) and `dev-team:plan-reviewer` review it before approval; consult the relevant `dev-team:*-lead`(s) for Handover Spec(s) (format: `${CLAUDE_PLUGIN_ROOT}/handover-spec.md`), dispatch `dev-team:coder`(s), run the QA gate (`dev-team:qa-lead` + `dev-team:build-validator` + `dev-team:test-engineer`, spec-anchored), then commit reconciled memory deltas.
- **`off`** → for the rest of this session, stay direct: don't propose or engage the team unless `/dev-team:team` is invoked again.
- **`auto`** → for the rest of this session, run qualifying (Tier 2/3) work through the team automatically, without the semi-auto confirmation.
- **`status`** → report the current activation mode and the available leads.
- **`workflow <goal>`** → for large or repeatable jobs, run the deterministic pipeline via the Workflow tool with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/team-build.workflow.mjs`, passing `{ goal, projectMemory, tasks: [{ id?, domain, brief, files?: string[], depends_on?: string[] }] }` as `args`. Leads → executor (coder, or test-engineer for `qa`) → gate (review tier per the ladder + build-validator), with one amend-retry on `insufficient`. Plan-domains: **frontend/backend/devops/qa** — unroutable domains (e.g. `mobile`, or `architecture` = interactive Tier-3) are rejected, not laundered (returned in `rejectedTasks`). Set `depends_on` (task `id`s) for ordered work — the workflow runs tasks in dependency waves and skips a task if any dependency fails its gate.

**Input:** $ARGUMENTS
