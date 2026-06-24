---
description: Pick the next task from the configured source, plan it with the team, then stop for approval
---

Take the next task and **plan** it (don't execute yet). `$ARGUMENTS` may name a specific task (e.g. an issue number); if given, use that instead of auto-picking.

1. **Read config.** Read `<project-root>/.claude/dev-team/config.md`. If it's missing, tell the user to run `/dev-team:onboard` first, and stop.

2. **Select the task.**
   - If `$ARGUMENTS` names one → fetch it (e.g. `gh issue view $ARGUMENTS`) and use it.
   - Else → pick per `config.task_source`'s next-rule (e.g. `gh issue list --label ready` → oldest; or the next unchecked item in the backlog file). **Confirm the pick in one line** (`→ next: #550 — <title>; engage the team?`) and wait — unless activation mode is `auto`.

3. **Plan it through the team** (no edits, no coders yet):
   - Classify the tier (orchestration Tier rule).
   - Run **shared discovery once** across the involved domains (scout / `Explore` → one digest). For Tier 3, have `dev-team:architecture-lead` draft the TRD (→ `dev-team:trd-reviewer`).
   - Have each relevant lead produce a **Handover Spec** from the shared digest — self-checked against `handover-spec.md`, `interface_contract` filled for shared shapes, `depends_on` set.
   - Use `config.validate` for the specs' `validation_commands` and `config.review_defaults` to set review depth.

4. **Present the plan for approval** — the TRD/specs + the dispatch shape (which coders, parallel vs sequenced) + the gate plan. **Stop here.** On approval, continue to coders → QA gate → commit reconciled memory deltas (or the user runs execution separately). Never auto-execute Tier 3 without approval.

**Task:** $ARGUMENTS
