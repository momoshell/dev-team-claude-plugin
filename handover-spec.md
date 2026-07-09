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
- **discovery_context** — what the lead already found, so the coder never re-scouts. **Complete when it names:** every symbol/function the coder will call but not define + the file it lives in; the exact pattern to mirror — **paste the key excerpt (~5–10 lines) inline, plus its `file:line`** (a bare pointer costs the coder a Read and drifts when parallel edits shift lines; pointers alone are fine for everything *other* than the one pattern to mirror); any gotcha that would otherwise need a grep; the relevant existing conventions. If the coder would have to search beyond `files_in_scope` to proceed, it's incomplete.
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

## Self-check (before emitting)

A weak spec costs an amend→rebuild loop — verify each spec against this bar and fix gaps before handoff:

- [ ] `files_in_scope` are concrete paths — not globs or "the X module".
- [ ] `discovery_context` names every symbol the coder calls but doesn't define + its file, the pattern to mirror as an inline excerpt + `file:line`, and any gotcha — so the coder never searches beyond scope.
- [ ] `acceptance_criteria` are verifiable (a command or an observable result), not vibes.
- [ ] every `acceptance_criteria` entry is covered by a `validation_commands` entry or an explicitly named reviewer/manual check — a criterion nothing verifies is a vibe with punctuation.
- [ ] Risky paths name their required negative/security checks: authz/tenant boundaries, input validation/encoding, secret handling, rollback/idempotency, or public contract compatibility as applicable.
- [ ] `validation_commands` actually run in this project.
- [ ] `interface_contract` is filled if the task shares a shape with another task; the producing domain owns it.
- [ ] `depends_on` lists every prerequisite `task_id`.

## Worked example

```
task_id: be-01
domain: backend
goal: Add a priority (low|med|high, default med) field to items and expose it in the create + list endpoints.
files_in_scope: [src/api/items.ts]
constraints: [Match the existing handler style in items.ts; validate at the boundary with the zod schema in src/schemas.ts (conventions.md "validation-at-boundary").]
acceptance_criteria: [POST /items accepts priority and rejects values outside the enum with 400; GET /items returns priority; "npm test -- items" passes.]
validation_commands: [npm run typecheck, npm test -- items]
discovery_context: |
  Handlers live in src/api/items.ts (createItem ~L40, listItems ~L72). Pattern to mirror (src/api/items.ts:40):
    export const createItem = async (req: Request, res: Response) => {
      const parsed = ItemSchema.parse(req.body)
      const row = await db.insert('items', parsed)
      return res.json(row)
    }
  Validation uses zod schemas in src/schemas.ts (ItemSchema ~L12) — extend it, don't hand-roll. Rows persist via db.insert() from src/db.ts (schemaless JSON, no migration). Gotcha: listItems paginates via ?cursor — preserve it.
out_of_scope: [the frontend badge (fe-02), DB migrations]
depends_on: []
interface_contract: Item = { id: string, title: string, priority: 'low'|'med'|'high', done: boolean } — backend owns this; fe-02 consumes it.
```
