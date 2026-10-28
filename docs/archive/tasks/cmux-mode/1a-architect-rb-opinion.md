# Architect second opinion — R-B (grant tokens vs rule strings)

## Verdict: endorse Option B — with four riders

Strongest argument FOR B (not the one the package leads with): **reversibility asymmetry under E-1a** — adding a grant token is additive and cheap; removing rule-string `allow` from a shipped roster is a breaking, migration-bearing change to config living in user/project repos. A is a one-way door, B is not.

Strongest argument AGAINST B: it moves the only remaining channel for a bespoke `Bash(...)` grant from a human-authored file (roster) into an **agent-authored** one (the lead's handover spec `validation_commands`). That's a trust-boundary relocation, not neutral — F-9's metachar refusal + `Bash(<c> *)` wrapping bounds the shape, and the lead is inside the trust boundary anyway, but say it out loud in the ADR.

## Q1 — Phase 5 (codex/opencode/pi adapters): tokens are MORE right, decisively

`Edit(//abs/path/**)` is claude-CLI grammar. Under A, a codex adapter would have to parse claude rule strings back into intent to derive its own writable-roots/sandbox config — recovering intent from an expression is strictly harder and lossier than expanding intent into an expression. Tokens make the roster an agent-neutral capability declaration; each adapter owns expansion. "Each adapter needs its own expansion table" is the intrinsic cost of a second CLI, in its cheap form.

**Rider 1 — rename tokens capability-shaped, not tool-shaped:** `returns_write`, `signals_append`, `worktree_write`, `spec_validation_commands`. (`signals_append` encodes the JSONL append-only intent a coarser sandbox can honor.) Enum values are the expensive thing to change later — name them once, now.

**Rider 2 — site expansion as an adapter responsibility with `agent` as an explicit input.** Freeze the layering in ADR-013 and require 1b to expose a named, separately-testable `expandGrants(agent, tokens, ctx) -> string[]` with `agent` a parameter, not an assumption. Otherwise Phase 5's first job is a dispatcher refactor.

## Q2 — Hazards the package underweights

**(a)** The record's `profile.allow` bakes claude grammar into a frozen boundary contract. Acceptable (record carries `agent`, so it's a discriminated field) but must be STATED in the schema description ("grammar is agent-specific; for agent:'claude' it is claude permission-rule syntax"). Cost of the Phase-5 fix: a schema_version bump then; cheap to signpost now.

**(b)** `spec_validation_commands` does not cover development-time commands (npm ci, cargo build, go generate, make deps) — collides with U-6 (fresh worktree, no node_modules). The natural 1b-under-pressure fix would be "add a token" or an escape hatch. **Pre-commit the resolution now: dependency preparation is a dispatcher-side action (parent runs install in the worktree before spawn), never a worker grant.** Put it in ADR-013 as a named consequence.

**(c)** Enum-addition friction is higher than stated: E-1c readers refuse a higher schema_version, and §7.5 snapshots the reader per task. For a closed INPUT vocabulary the bump is redundant belt — an unknown token already fails validation fail-closed with a better error. **Recommended E-1 carve-out:** additions to input-vocabulary enums (`allow` tokens, `tools`) do not bump; additions to interpreted-outcome enums (`outcome`, `level`, `escalate_to`, where an old reader silently mis-branches) do. Materially reduces B's stated cost without weakening anything.

**(d)** A downstream repo with a legitimately bespoke grant: real but small once (b) is dispatcher-side; the residual is codegen/formatters — legitimately new capabilities deserving a named token and review, which is what B is for.

## Q3 — The third option (`extra_allow` escape hatch)

- In rule-string form: **reject** — one `extra_allow: ["Bash(cmux kill *)"]` and hard rules 4/5/6 are back to test-defended config, plus the roster reacquires claude grammar in a field codex must parse.
- In structured non-syntax form (`validation_command_prefixes: ["cargo test"]`, pattern-restricted, builder-expanded): plausible, NOT the reintroduction the package calls it (breadth risk, not shape risk) — but **still decline for 1a**: under E-1a an additive optional field is free to add later on evidence, whereas tokens-vs-rule-strings is not free to revisit. Freeze the expensive decision, defer the cheap one. **Record the deferral in ADR-013 as the pre-approved shape** so the future answer is a designed field, not an improvised extra_allow.

## Summary of riders (all cheap, all inside 1a)

1. Rename tokens capability-neutral: `returns_write`, `signals_append`, `worktree_write`, `spec_validation_commands`.
2. ADR-013 states the layering: tokens are agent-neutral capability; expansion is adapter-owned; 1b exposes `expandGrants(agent, tokens, ctx)`.
3. dispatch-record schema description states `profile.allow` grammar is agent-specific, discriminated by `agent`.
4. ADR-013 names two consequences: (i) U-6 resolves dispatcher-side, never by widening the grant enum; (ii) the pre-approved future escape hatch is a prefix-list field, deferred not forbidden.

Optional but recommended: the E-1 input-vocabulary vs interpreted-outcome enum carve-out (Q2c).
