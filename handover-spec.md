# Handover Spec — canonical template

The contract a **lead emits** and a **coder consumes**. Conversational mode uses this markdown; workflow mode uses `handover-spec.schema.json` (and `coder-return.schema.json` for the result) — same directory.

**Conventions:** array fields (`files_in_scope`, `constraints`, `acceptance_criteria`, `validation_commands`, `out_of_scope`, `depends_on`) use an empty list for "none"; string fields (`discovery_context`, `interface_contract`) use `none`. Workflow mode requires every field present (empty is fine). For security-sensitive work, state the required review depth (e.g. `code-reviewer-deep`) in `acceptance_criteria`.

## Fields

- **task_id** — stable id (e.g. `be-01`)
- **domain** — `frontend` | `backend` | `devops` | `qa`
- **goal** — one paragraph: what to achieve
- **files_in_scope** — explicit paths the coder may touch
- **constraints** — conventions/patterns to match (cite `conventions.md` entries)
- **acceptance_criteria** — how "done" is verified
- **validation_commands** — exact commands (type-check, lint, test, build)
- **discovery_context** — what the lead already found, so the coder never re-scouts
- **out_of_scope** — explicit don'ts
- **depends_on** — prerequisite task_ids (or —)
- **interface_contract** — shared shapes (API payloads, types, props) for cross-domain coherence (or —)

## Coder return

```
status: done | insufficient | blocked
reason: <one line>
missing_context: <what's needed, or —>
changes: <each file modified + one line; or —>
validation: <commands run + pass/fail>
```

## Fill-in template

```
task_id:
domain:
goal:
files_in_scope:
constraints:
acceptance_criteria:
validation_commands:
discovery_context:
out_of_scope:
depends_on:
interface_contract:
```
