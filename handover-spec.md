# Handover Spec — canonical template

The contract a **lead emits** and a **coder consumes**. Conversational mode uses this markdown; workflow mode uses `handover-spec.schema.json` (and `coder-return.schema.json` for the result) — same directory.

**Conventions:** array fields (`files_in_scope`, `constraints`, `acceptance_criteria`, `validation_commands`, `out_of_scope`, `depends_on`) use an empty list for "none"; string fields (`discovery_context`, `interface_contract`) use `none`. Workflow mode requires every field present (empty is fine). For security-sensitive work, state the required review depth (e.g. `code-reviewer-deep`) in `acceptance_criteria`. **Insufficiency cap:** conversational mode allows up to **2** amend→rebuild cycles then escalates to the user; workflow mode does **one** amend-retry.

## Fields

- **task_id** — stable id (e.g. `be-01`)
- **domain** — `frontend` | `backend` | `devops` | `qa`
- **goal** — one paragraph: what to achieve
- **files_in_scope** — explicit paths the coder may touch
- **constraints** — conventions/patterns to match (cite `conventions.md` entries)
- **acceptance_criteria** — how "done" is verified
- **validation_commands** — exact commands (type-check, lint, test, build)
- **discovery_context** — what the lead already found, so the coder never re-scouts. **Complete when it names:** every symbol/function the coder will call but not define + the file it lives in; the exact pattern to mirror (with a `file:line` example); any gotcha that would otherwise need a grep; the relevant existing conventions. If the coder would have to search beyond `files_in_scope` to proceed, it's incomplete.
- **out_of_scope** — explicit don'ts
- **depends_on** — prerequisite task_ids (or —)
- **interface_contract** — shared shapes (API payloads, types, props) for cross-domain coherence (or `none`). **Required (non-`none`) whenever this task shares a shape with another task in the batch.** The lead whose domain *produces* the shape is authoritative; the consuming task references it and must not redefine it.

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
