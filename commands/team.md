---
description: Engage or configure the dev-team workflow (request / off / auto / status / workflow)
---

Interpret `$ARGUMENTS`:

- **a request, or empty** → engage the team for this request now, skipping the semi-auto suggestion. Classify it; for Tier 3, have `dev-team:architecture-lead` produce the artifact-routed architecture package (PRD-lite/TRD/ADR only as needed) and `dev-team:plan-reviewer` review it before approval; consult the relevant `dev-team:*-lead`(s) for Handover Spec(s) (format: `${CLAUDE_PLUGIN_ROOT}/handover-spec.md`), lint each with `scripts/spec-lint.mjs` before dispatch, dispatch `dev-team:coder`(s), run the risk-sized QA gate per `${CLAUDE_PLUGIN_ROOT}/references/qa-gate.md` (`dev-team:qa-lead` plans it; the reviewer tier + `build-validator`/`test-engineer` are added only as the risk ladder warrants — not an unconditional bundle), then commit reconciled memory deltas.
- **`off`** → for the rest of this session, stay direct: don't propose or engage the team unless `/dev-team:team` is invoked again.
- **`auto`** → for the rest of this session, run qualifying (Tier 2/3) work through the team automatically, without the semi-auto confirmation.
- **`status`** → report the current activation mode and the available leads.
- **`workflow <goal>`** → for large or repeatable jobs, run the deterministic pipeline via the Workflow tool with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/team-build.workflow.mjs`, passing `{ goal, projectMemory, tasks: [{ id?, domain, brief, files?: string[], depends_on?: string[] }] }` as `args`. Leads → executor (coder, or test-engineer for `qa`) → gate (review tier per the ladder + build-validator), with one amend-retry on `insufficient`. Plan-domains: **frontend/backend/devops/qa** — unroutable domains (e.g. `mobile`, or `architecture` = interactive Tier-3) are rejected, not laundered (returned in `rejectedTasks`). Set `depends_on` (task `id`s) for ordered work — the workflow runs tasks in dependency waves and skips a task if any dependency fails its gate (cycles/unknown deps are skipped with a reason). Before planning a dependent task, the workflow auto-injects its finished prerequisites' `interface_contract` + changed files into the lead's prompt, so a dependent spec stays coherent with what upstream actually shipped without you brokering it by hand. Note the workflow can't run spec-lint mid-script — it relies on the schema's field-presence check + one amend-retry, and it auto-escalates every `devops` task to deep review.

**Input:** $ARGUMENTS
