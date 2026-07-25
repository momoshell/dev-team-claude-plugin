# Tier-3 planning (read when a task classifies Tier 3)

Cross-domain / multi-phase / new-architecture work. The flow: shared discovery → architecture package → plan review → user approval → leads finalize specs → phased execution.

## Shared discovery (gather once, then leads plan from it)

For cross-domain / Tier-3 work (≥ 2 leads), gather context **once** and share it — don't let each lead re-scan the same code. Dispatch scout(s) (`Explore` — Bash + read tools) to map the relevant code across **all** involved domains and return a structured **context digest**: key files, patterns/conventions, contracts/shapes, gotchas, and any runtime facts. Hand the *same* digest to every lead; they **plan from it** and Read/Grep only to fill a **specific** gap it doesn't cover — never re-scan broadly. One thorough sweep → nothing missed, *and* N leads don't each pay to re-read the same files. (Single-domain Tier 2: the one lead scopes its own targeted context; no sharing needed.)

**Reuse before re-scan (any tier):** hand the lead any relevant context you already have — from classification, a runtime scout, or earlier turns — so it doesn't re-discover what's known. The dedicated shared sweep above is only worth its overhead at ≥ 2 leads.

**Scout scaling:** Tier 3 = 2–6 parallel scouts, distinct lenses, locate-first, ≤ 2 rounds.

## Tier-3 architecture package

Architecture work is not "always write a TRD." The architecture lead chooses the smallest useful package:

- **PRD-lite** when product/user behavior, workflow, actors, or success criteria are ambiguous.
- **TRD/RFC** when implementation architecture, contracts, migration, sequencing, or trade-offs are the hard part.
- **ADR** when a durable technical decision should be remembered, superseded, or revisited later.
- **Execution plan** for every buildable Tier-3 request: phases, domain task slices, dependencies, interface contracts, acceptance criteria, validation strategy, and QA route.

The package goes to `dev-team:plan-reviewer` (+ `dev-team:architect` when the design has meaningful alternatives) before approval.

Before asking for user approval, present the architecture package plus the dispatch shape: which Handover Specs will be produced, which coders can run in parallel, which tasks are dependent, and which gate tier applies. Do not move from Tier-3 design into implementation without explicit approval unless the user has enabled `auto` and the request is not high-risk.

## Brokered consults

Leads can't talk to each other. **Default:** for cross-domain tasks, assemble *both* domains' context and consult the leads together — avoid live round-trips. **Exception (true blocker):** re-spawn lead A with `{A's prior spec draft + the original question + B's answer}`.

## Cross-domain dispatch (before spawning parallel coders)

Verify every `depends_on` id resolves to an emitted spec; ensure any shared shape is **identical** in the `interface_contract` of the producer and consumer specs (the consumer references the producer's — it doesn't restate it); dispatch dependents only after prerequisites land. Disjoint files + no `depends_on` → parallel (`isolation: "worktree"` on overlap); otherwise serialize by dependency.

## Session effort

Orchestrator effort is the *session* setting (`/config`), not per-agent frontmatter. Default **high** (covers Tier 1/2). Raise the session to **xhigh** when the *orchestration itself* is the hard part — planning/reviewing a Tier-3 architecture package, scheduling many `depends_on` coders into dependency waves, or reconciling conflicting memory deltas. Match the session to the highest tier you expect; switching effort mid-session busts the prompt cache, so pick per-session rather than toggling.
