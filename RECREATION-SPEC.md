# dev-team — Recreation Specification

> A harness-agnostic blueprint for rebuilding the `dev-team` multi-agent system on a
> different agent platform (here: a custom "Pi" agent setup). It describes the
> **concepts, mechanisms, and invariants** first — then pins them to concrete artifacts
> (agent roster, schemas, algorithms) so the design can be reproduced as faithfully as the
> target harness allows.
>
> Read it in two passes. **Pass 1 (Parts 1–3)** gives you the mental model and the exact
> capabilities your harness must expose. **Pass 2 (Parts 4–13)** is the detailed spec of
> each mechanism. Part 14 is a build checklist.

---

## Part 1 — The core idea

`dev-team` turns **one assistant into a small, disciplined engineering organization**. Instead
of a single model that plans, codes, and reviews in one undifferentiated stream, the work is
split across **specialized roles with hard boundaries**, coordinated by a single conductor.

Three principles define it:

1. **Star topology, not a chat room.** There is exactly one **orchestrator**. It is the only
   role that talks to the user. It spawns every other agent, collects each result, and decides
   what happens next. **Sub-agents never talk to each other** — all coordination flows through
   the orchestrator. This keeps reasoning auditable and prevents the combinatorial chaos of
   peer-to-peer agent messaging.

2. **Plan / execute / verify are different roles with different powers.**
   - **Leads** *plan* — they are read-only. They cannot edit files. They produce a written
     contract (the *Handover Spec*) and stop.
   - **Coders** *execute* — they implement exactly one Handover Spec, within a fixed file
     scope. They are "hands, not brain": they do not plan, design, or explore.
   - **Reviewers / validators** *verify* — read-only, they check the result against the spec's
     acceptance criteria.

   Separating these is the whole point: the planner can't cut corners under implementation
   pressure, the implementer can't redesign mid-task, and the reviewer is structurally
   independent of both.

3. **Spend is driven by window *count*, not depth.** Every sub-agent is its own context window
   with its own token cost. So the system economizes on *how many* windows open for trivial
   work — and deliberately refuses to economize on the windows that prevent expensive failures
   (architecture, deep review). "Cheap where it's safe, strong where it compounds." (See Part 12.)

A fourth, operational principle: **memory has a single writer.** Leads *propose* changes to
team memory; only the orchestrator commits them, strictly sequentially. This avoids file
corruption from parallel writes and keeps one coherent source of truth.

---

## Part 2 — Required harness primitives (the porting layer)

To recreate this faithfully, your target harness ("Pi") must provide the capabilities below.
Where a capability is missing, the listed **fallback** tells you what degrades. This is the
most important section for porting — everything else is built on these.

| # | Capability | What dev-team uses it for | If missing (fallback) |
|---|-----------|---------------------------|------------------------|
| P1 | **Spawn a sub-agent in a fresh, isolated context window** with its own system prompt, tool set, and model | The entire role model — every lead/coder/reviewer is a spawned agent | Hard requirement. Without isolated sub-contexts there is no team; you'd collapse to a single-context role-play (far weaker). |
| P2 | **Per-agent system prompt** that is *static* (byte-stable across spawns) | Each agent's role definition; enables prompt-cache reuse | Works without caching, just more expensive. Keep prompts static anyway (Part 13). |
| P3 | **Per-agent tool restriction** (allow/deny specific tools) | Enforces read-only leads, scoped coders, no-edit reviewers | Critical for the safety model. Without it, "read-only" is advisory; simulate by prompt instruction + post-hoc checks. |
| P4 | **Per-agent model selection** (e.g. a strong model for leads, a cheap one for validators) | Cost/quality tiering (Part 12) | Use one model everywhere; cost rises, behavior is otherwise intact. |
| P5 | **Pass a per-spawn "user turn" / prompt** carrying the task payload | Delivers the variable content (spec, paths, digest) *without* mutating the static system prompt | Required to honor the cache invariant; otherwise fold payload into the prompt and accept the cache loss. |
| P6 | **Structured output** — force an agent to return JSON validated against a schema | Handover Spec + coder return + review verdicts in the deterministic workflow | Parse free-text returns with a tolerant parser; add a retry on malformed output. |
| P7 | **Session-start context injection** — load a fixed block of "operating rules" into the orchestrator at the start of every session | Loads `orchestration.md` so the conductor knows the protocol | Paste the rules into the orchestrator's system prompt / project instructions. |
| P8 | **A deterministic orchestration runtime** — run a script that spawns agents, awaits results, branches, loops, and fans out in parallel | "Workflow mode": batch jobs with dependency-wave scheduling | Drive the same logic from the orchestrator's own reasoning loop (slower, less repeatable, but works). |
| P9 | **Parallel sub-agent execution** with a concurrency cap | Run independent coders/reviewers at once | Serialize; correctness unchanged, latency rises. |
| P10 | **Filesystem read/write + shell** available to *some* agents | Coders edit code; orchestrator runs validation; memory files persist | Required for a coding agent at all. |
| P11 | **Isolated working copies** (e.g. git worktrees) for agents that mutate files in parallel | Prevent two coders clobbering each other on overlapping files | Serialize overlapping coders instead. |
| P12 | **Slash-command / macro entry points** | `/team`, `/next`, `/ship`, `/onboard` UX | Plain natural-language triggers the orchestrator recognizes. |

**Minimum viable port:** P1, P2, P3, P5, P10 give you the conversational team. Add P6 + P8 + P9
for the deterministic workflow. P4/P11/P12 are optimizations.

---

## Part 3 — The org chart (roles at a glance)

```
                        ┌──────────────────────────┐
              user ◄───►│      ORCHESTRATOR        │  (the only user-facing role;
                        │  - classifies the task   │   sole writer of memory;
                        │  - spawns every agent    │   runs deterministic validation inline)
                        │  - commits memory        │
                        └────────────┬─────────────┘
            plan            │         │          │           verify
   ┌────────────────────────┘         │          └────────────────────────┐
   ▼                                  ▼                                    ▼
┌─────────────┐  Handover Spec   ┌─────────┐   diff + criteria      ┌──────────────┐
│   LEADS     │ ───────────────► │ CODER   │ ─────────────────────► │  QA GATE     │
│ (read-only) │                  │(execute)│                        │ (read-only)  │
│ frontend    │                  └─────────┘                        │ code-reviewer│
│ backend     │   ▲                                                 │  (+deep)     │
│ devops      │   │ propose memory deltas                           │ build-valid. │
│ qa          │   │                                                 │ test-engineer│
│ architecture│   └─────────────────────────────────────────────►  └──────────────┘
└─────────────┘                                            (architecture team:
                                                            architect, plan-reviewer,
                                                            doc-writer, + Explore scout)
```

**Roster** (recreate each as one spawnable agent; model/effort are the dev-team tuning — map to
your harness's equivalents):

| Agent | Group | Model | Effort | Tools (capability) | Writes? | Role |
|-------|-------|-------|--------|--------------------|---------|------|
| *(orchestrator)* | conductor | strong | high/xhigh | all | memory only | Talks to user, classifies, spawns, commits memory, runs validation inline |
| `architecture-lead` | lead | strong | xhigh | read+search, no shell | no | Tier-3 design packages (PRD-lite/TRD/ADR), execution plans, conventions |
| `backend-lead` | lead | strong | high | read+search, no shell | no | Plans APIs/DB/auth/server → Handover Specs |
| `frontend-lead` | lead | strong | high | read+search, no shell | no | Plans UI/components/design-system → Handover Specs |
| `devops-lead` | lead | strong | high | read+search, no shell | no | Plans CI/CD/infra/deploy → Handover Specs |
| `qa-lead` | lead | strong | high | read+search, no shell | no | Test strategy, acceptance criteria, **decides review depth**, runs the gate |
| `coder` | executor | mid | medium | read/edit/write/shell | **code** | Implements ONE Handover Spec, within scope only |
| `test-engineer` | executor/QA | mid | medium | all | **tests** | Writes/expands tests; also the executor for `qa`-domain tasks |
| `code-reviewer` | QA | mid | medium | read+shell, no edit | no | Standard post-implementation review |
| `code-reviewer-deep` | QA | strong | high | read+shell, no edit | no | Deep review for high-risk changes (escalation only) |
| `build-validator` | QA | cheap | low | read+shell, no edit | no | Independent type-check/build; reports, never fixes |
| `architect` | architecture | strong | high | read+search, no shell | no | Second-opinion design advisor (trade-offs) |
| `plan-reviewer` | architecture | strong | high | read+search | no | Independent review of Tier-3 plans (author ≠ reviewer) |
| `doc-writer` | architecture | cheap | low | read + edit markdown only | **docs** | Formal PRD/TRD/ADR/README markdown |
| `Explore` *(host built-in)* | scout | — | — | read + shell | no | Broad codebase/runtime discovery sweeps |

`trd-reviewer` exists as a legacy TRD-only variant of `plan-reviewer`; new builds only need
`plan-reviewer`.

> **Why leads have no shell:** leads do *static* discovery (read code). Anything *runtime*
> (running commands, live data, real output shapes) is delegated to a scout (`Explore`, which
> has shell) and the verified facts are fed into the spec. A lead must **never guess a runtime
> shape** — that's the most common source of a bad spec. **This covers GitHub issue/PR bodies
> and any private-repo or authenticated content:** a lead's `WebFetch`/`WebSearch` reach public
> docs only (no `gh`, no auth token), so the orchestrator (or a scout) resolves the issue via
> `gh` and passes the content into the lead's prompt + `discovery_context` — a lead is never
> handed a bare issue URL/number and must flag **insufficient** if issue context is missing
> rather than fetching or guessing.

---

## Part 4 — Activation & tiering

The orchestrator classifies every non-trivial request into a tier. **The trigger for higher
tiers is cross-domain *coordination*, not size.**

| Tier | Definition | Handling |
|------|-----------|----------|
| **Tier 1 — trivial** | Single file, obvious fix, no design choice | Orchestrator **edits directly**, runs validation inline, done. *No spec, no coder, no gate* — a one-liner doesn't earn a window. (Delegate to a coder only if bulky-but-mechanical.) |
| **Tier 2 — single domain** | Multi-file work within one domain | `domain lead → Handover Spec → coder(s) → QA gate → commit memory → summarize` |
| **Tier 3 — cross-domain / new architecture / phased** | Touches ≥ 2 domains, OR introduces a new pattern/architecture, OR needs phasing | `shared discovery → architecture-lead drafts package + execution plan → plan-reviewer (+architect if real alternatives) → user approval → domain leads finalize specs → phased execution (per phase: coder → QA) → commit → summarize` |

**Behavior contract:** for Tier 2/3 the orchestrator **proposes in one line and waits** — it
never silently takes over:
> `This looks like Tier {N} ({reason}). Engage the team (lead → coder → QA), or handle directly?`

Activation modes (recreate as commands or NL toggles): **force** the team now · **off** (stay
direct this session) · **auto** (run qualifying work without asking) · **status** · **workflow
\<goal\>** (deterministic mode).

---

## Part 5 — The Handover Spec (the central contract)

The Handover Spec is the **only artifact a lead emits and the only thing a coder consumes**. Get
this right and most of the system follows. It is a single object with **11 fields**:

| Field | Type | Meaning |
|-------|------|---------|
| `task_id` | string | Stable id, e.g. `be-01` |
| `domain` | enum | `frontend` \| `backend` \| `devops` \| `qa` |
| `goal` | string | One paragraph: what to achieve |
| `files_in_scope` | string[] | **Concrete paths** the coder may touch (never globs or "the X module") |
| `constraints` | string[] | Conventions/patterns to match (cite memory entries) |
| `acceptance_criteria` | string[] | How "done" is verified — a command or observable result, not vibes |
| `validation_commands` | string[] | Exact commands (type-check, lint, test, build) that run in *this* project |
| `discovery_context` | string | Everything the lead already found, so the coder **never re-scouts** (see completeness bar below) |
| `out_of_scope` | string[] | Explicit don'ts |
| `depends_on` | string[] | Prerequisite `task_id`s |
| `interface_contract` | string | Shared shapes (payloads, types, props) for cross-domain coherence; `none` if unshared |

**Empty-value convention:** array fields use `[]` for "none"; string fields use `none`.

**The `discovery_context` completeness bar** (this is what makes a coder able to work blind to
the rest of the repo). It is complete only when it names:
- every symbol/function the coder will *call but not define*, and the file it lives in;
- the exact pattern to mirror, with a `file:line` example;
- any gotcha that would otherwise require a search;
- the relevant existing conventions.
> If the coder would have to search beyond `files_in_scope` to proceed, the spec is incomplete.

**The coder's structured return** (the other half of the contract):

| Field | When | Meaning |
|-------|------|---------|
| `status` | always | `done` \| `insufficient` \| `blocked` |
| `reason` | always | One line |
| `missing_context` | required when `insufficient` | Exactly what's needed (file, contract, decision) |
| `changes` | required when `done` | Each file modified + a one-line summary |
| `validation` | required when `done` | Commands run + pass/fail |

JSON schemas for both objects appear in **Appendix A**. Note the schemas are deliberately
**flat** — no conditional keywords (`if`/`then`/`allOf`/`anyOf`) — because structured-output
tools often reject them. Conditional requirements (e.g. "`missing_context` required when
`insufficient`") are enforced by the prompt and the runtime, not the schema.

### Spec quality control — two mechanisms

1. **Spec-lint before dispatch (free, no window).** Before spawning a coder, the orchestrator
   eyeballs the spec: paths concrete? `discovery_context` names every external symbol + a
   `file:line` to mirror + gotchas? `validation_commands` real? `interface_contract` filled if a
   shape is shared? A gap caught here is free; the same gap caught by the coder costs a full
   amend→rebuild cycle (a wasted window).

2. **Insufficiency loop (bounded).** On a coder `insufficient` return, send its `missing_context`
   back to the originating lead to **amend** the spec (keeping `task_id`/`files_in_scope`
   stable), then re-spawn the coder. **Cap: at most 2 amend→rebuild cycles in conversational
   mode** (workflow mode does **one**). If still insufficient, **stop and escalate to the user**
   with the spec + both `missing_context` returns + a concrete question.

---

## Part 6 — Execution flow per tier

**Tier 1:** orchestrator edits → runs validation inline → done.

**Tier 2:**
```
domain lead  →  Handover Spec  →  [spec-lint]  →  coder(s)  →  QA gate  →  commit memory deltas  →  summarize
                                                  (parallel if disjoint; worktree on overlap)
```

**Tier 3:**
```
shared discovery (scouts, one digest)
  → architecture-lead: artifact-routed package (PRD-lite/TRD/ADR as needed) + execution plan
  → plan-reviewer (+ architect when meaningful design alternatives exist)
  → USER APPROVAL  ← hard stop; never enter implementation without it (unless auto + low-risk)
  → domain leads finalize Handover Specs (from the shared digest)
  → phased execution:  for each phase →  coder(s)  →  QA gate
  → commit ADRs/conventions  → summarize
```

**Tier-3 architecture package is not "always write a TRD."** The architecture-lead picks the
*smallest useful* package:
- **PRD-lite** — product/user behavior, actors, or success criteria are ambiguous.
- **TRD/RFC** — implementation architecture, contracts, migration, or sequencing is the hard part.
- **ADR** — a durable decision worth remembering/superseding later.
- **Execution plan** — *always*, for any buildable Tier-3 request: phases, task slices,
  dependencies, interface contracts, acceptance criteria, validation strategy, gate route.

Before asking for approval, the orchestrator presents the package **plus the dispatch shape**:
which specs will be produced, which coders run in parallel, which are dependent, which gate tier
applies.

---

## Part 7 — The QA review ladder

Owned by `qa-lead`, applied at **every** gate. Two independent dials: review **depth** (the
ladder) and bundle **size** (how many windows) — both scale with risk.

**Deterministic validation runs inline, not as a window.** Type-check/lint/build/test are
deterministic, so the orchestrator re-runs the spec's `validation_commands` directly (shell) to
confirm the coder's self-report. A subagent (`build-validator`) is reserved for validation that
needs an isolated environment, or for workflow mode (where the script can't run shell itself).

**Risk model:**
- **Deep triggers** (any one ⇒ deep review): auth/authz · secrets/encryption/tokens/sessions ·
  payments/PII · DB migrations/destructive ops · CI/CD/infra/prod · public API/contract changes ·
  security fix/incident/hotfix.
- **Risk factors** (+1 each): multi-module change · untested touched behavior · unclear rollback ·
  complex control flow · cross-domain new feature.

**The ladder (depth):**
| Tier | When | Reviewers |
|------|------|-----------|
| **Standard** | risk 0–1, no deep trigger | a single `code-reviewer` (mid model) |
| **Deep** | any deep trigger, or risk ≥ 2 | `code-reviewer-deep` (strong model) |
| **Adversarial panel** | stacked risk (≥ 3, or ≥ 2 deep triggers) | **3** reviewers (odd → clean majority), distinct lenses: **correctness / security / rollback**; pass = majority |

**The bundle (size):**
- Risk 0–1: single reviewer; validation inline. Add `test-engineer` **only** when the change
  adds/alters behavior not already covered (or acceptance criteria demand tests) — skip it for
  refactors/config/docs.
- Deep / stacked: add `test-engineer` for negative + security coverage, run in parallel.

**Verdict discipline:** every reviewer **leads with a one-line verdict** (`pass` /
`changes-needed`) so it survives a long or truncated review. No verdict ⇒ treat as inconclusive
and re-run scoped to the diff — never assume pass.

**Always-blocking issue classes** (block shipping whenever plausible): auth bypass · cross-tenant
data access · privilege escalation · RCE · injection with a reachable source→sink path · prod
secret exposure · destructive data loss · unsafe migration rollback · payment/PII leakage.

**Each phase ends with this quality pass before the next begins.**

---

## Part 8 — Memory architecture

Team memory is a **lean cache** of durable truth — read by leads on every spawn, written only by
the orchestrator.

**Two tiers:**
- **Project memory** (most of it): `<project-root>/.claude/dev-team/memory/`
  - `conventions.md` — shared cross-cutting truth
  - `{frontend,backend,devops,qa}-notes.md` — domain-local
  - `architecture-notes.md` — the ADR log
- **Global memory** (sparse, cross-project): `~/.claude/dev-team/memory/conventions.md` —
  durable preferences that hold across all projects.

**Precedence: `code > project memory > global memory`.** A project convention overrides a global
one; code overrides both. Contradicted entries are marked `deprecated` (with `supersedes`) —
**never deleted**.

**Single-writer discipline:**
- Leads only **propose** deltas in their output (structured: decision / date / scope / status /
  supersedes / rationale). The orchestrator reconciles and commits.
- **Never issue parallel writes to memory** — one file at a time, read-modify-write, to avoid
  corruption.
- **Reconcile rule:** on conflicting deltas, the domain that owns the file/decision wins; for
  cross-cutting `conventions.md`, the architecture-lead's proposal wins, else surface to the user.
- **Bootstrap:** if the memory dir doesn't exist, create it + the files on the first commit. A
  missing file is an empty cache, not an error.
- **Keep it lean:** prune and deprecate aggressively. Stale bulk is a recurring per-spawn cost
  (every lead re-reads it).

> Porting note: the path layout is a convention, not magic. Any per-project + per-user pair of
> markdown caches with the precedence rule above reproduces the behavior.

---

## Part 9 — Shared discovery & brokered consults

**Shared discovery (gather once, then leads plan from it).** For cross-domain / Tier-3 work
(≥ 2 leads), the orchestrator dispatches scout(s) (`Explore`) to map the relevant code across
**all** involved domains *once* and return a structured **context digest**: key files,
patterns/conventions, contracts/shapes, gotchas, runtime facts. The *same* digest goes to every
lead; they **plan from it** and read only to fill a *specific* gap. One sweep → nothing missed,
*and* N leads don't each re-read the same files. (Single-domain Tier 2: the one lead scopes its
own context; no sharing needed.)

**Reuse before re-scan (any tier):** hand a lead any context you already have (from
classification, a runtime scout, earlier turns) so it doesn't re-discover known facts.

**Brokered consults (leads can't talk to each other).**
- **Default:** for a cross-domain question, assemble *both* domains' context and consult the
  leads together — avoid live round-trips.
- **Exception (true blocker):** re-spawn lead A with `{A's prior spec draft + the original
  question + B's answer}`.

---

## Part 10 — Cross-domain dispatch & parallelism

Before spawning parallel coders, the orchestrator:
1. Verifies every `depends_on` id resolves to an emitted spec.
2. Ensures any shared shape is **identical** in the `interface_contract` of producer and consumer
   specs (the consumer *references* the producer's; it does not restate it). The producing domain
   owns the shape.
3. Dispatches dependents only after prerequisites land.

**Parallelism rule:** disjoint files + no `depends_on` ⇒ run in parallel (use isolated working
copies / worktrees if files could overlap). Otherwise serialize by dependency. Concurrency cap ≈
4–6 coders; beyond that, switch to workflow mode.

---

## Part 11 — The deterministic workflow (batch mode)

For large/repeatable jobs, dev-team runs a **deterministic orchestration script** rather than
free-form orchestrator reasoning. This needs harness primitives P6 (structured output), P8
(orchestration runtime), P9 (parallelism). The reference implementation is
`team-build.workflow.mjs`; the algorithm:

**Input** (`args`):
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
(`id` defaults to `t<index>`. Tolerate `args` arriving as a JSON *string* — parse both.)

**Per task — a three-stage chain:**
```
Stage 1  Plan   → spawn the domain lead → structured Handover Spec (schema-validated)
Stage 2  Build  → spawn executor (coder, or test-engineer for `qa`) → structured return
                  if status == insufficient: ONE amend-retry
                    (re-spawn lead with the gap → amended spec → re-spawn executor)
Stage 3  Gate   → review (tier auto-selected, below) + build-validator, IN PARALLEL
```

**Domain routing:** plan-domains are **frontend / backend / devops / qa** only. Any other domain
(e.g. `mobile`, or `architecture` which is interactive Tier-3) is **rejected, not laundered** into
a fallback lead — returned in `rejectedTasks` with a reason. `qa` tasks are executed by
`test-engineer`; everything else by `coder`.

**Review-tier auto-selection** (mirrors Part 7): regex the spec's goal/contract/constraints/
acceptance for deep-trigger keyword groups and risk factors; the whole `devops` domain forces the
`infra` trigger. `≥ 2 triggers or riskScore ≥ 3` → adversarial panel (3 deep reviewers, 3 lenses,
majority pass); `≥ 1 trigger or riskScore ≥ 2` → deep; else standard.

**build-validator is advisory:** a *real reported failure* blocks the gate; a dead/no-verdict run
does **not** block (the coder already ran validation and the reviewer checked criteria). It also
treats "project has no build/type-check step" as a pass, not a failure.

**Dependency-wave scheduler** (the heart of batch ordering):
```
finished = {}                 # id -> result
remaining = all routable tasks
while remaining:
    ready = tasks whose every dependency is already finished
    if ready is empty:        # nothing can advance → a cycle
        mark all remaining as skipped ("dependency cycle / unresolvable"); break
    run all `ready` tasks CONCURRENTLY (a barrier between waves)
        - but skip a task if any dependency FAILED its gate, or is unknown
    move ready → finished
```
- Independent tasks run concurrently within a wave.
- A dependent waits for its prerequisite wave and is **skipped if any prerequisite fails its
  gate** (with a recorded reason). Cycles and unknown deps are skipped, not crashed.
- Dependents carry upstream `interface_contract`s into their planning prompt, so specs stay
  coherent across the dependency edge.

**Output:** `{ goal, total, routable, rejected, passed, results[], rejectedTasks[] }` where each
result has `{ id, domain, status, pass, review_tier, changes, findings }`.

> The conversational mode (Part 6) does the *same* lead→build→gate logic, but driven by the
> orchestrator's reasoning instead of a script — and it can do the richer semantic spec-lint and
> up to 2 amend cycles, which the script can't.

---

## Part 12 — Cost model & the governing principle

Every sub-agent is a separate context window with its own cost. So **spend is driven by the
*count* of windows and the cost of the *cheap* ones — never the depth of the hard ones.**

**Cut windows on trivial/low-risk work:**
- Tier-1 runs direct (no window).
- Deterministic validation runs inline (orchestrator shell), not as a subagent.
- The low-risk QA gate is a *single* mid-model reviewer.
- The standard reviewer runs at medium effort on a cheaper model.

**Keep strong models + high effort on the windows that prevent expensive failures:**
- `architecture-lead` (wrong architecture is the costliest mistake),
- the domain leads (a bad spec causes amend→rebuild loops),
- `code-reviewer-deep` and the adversarial panel (a missed security issue).

**Effort tiering** (map to your harness): orchestrator high/xhigh · architecture-lead xhigh ·
leads high · coder medium · standard reviewer medium · deep reviewer + panel high · build-validator
low. **Model tiering:** standard reviewer & coder on a mid model; deep reviewer + panel & all
leads/architecture on a strong model; build-validator & doc-writer on a cheap model.

**Orchestrator effort is the *session* setting, not per-agent config** — the conductor is the main
loop, not a spawned agent, so its effort is whatever the session is set to. Default **high**; raise
to **xhigh** only when the coordination itself is hard (designing/reviewing a Tier-3 architecture
package, scheduling a many-`depends_on` dependency graph, reconciling conflicting memory deltas).
Don't toggle mid-session — switching effort invalidates the prompt cache.

> **Concrete lineup (Claude Code, as of July 2026) — for reference; keep the design on generic
> tiers:** *strong* = Claude Opus 4.8, *mid* = Claude Sonnet 5 (the `sonnet` alias — a free upgrade
> from Sonnet 4.6, and cheaper under introductory pricing through Aug 31 2026), *cheap* = Claude
> Haiku 4.5. Bind agents to **aliases** (`opus`/`sonnet`/`haiku`), never pinned IDs, so each tier
> auto-tracks the latest model (see Invariant "no pinned versions"). **Fable 5 and Mythos 5 are
> deliberately unused:** Fable 5 (the frontier tier) is ~2× Opus's price and works against the
> cost principle, and is gated by a 30-day-data-retention requirement (unavailable under ZDR);
> Mythos 5 is access-gated to Project Glasswing (invite-only). Neither beats Opus-on-the-hard-parts
> for this workload. **Caveat:** the `effort` knob is unsupported on Haiku 4.5 — the cheap tier's
> low-reasoning profile comes from the model choice, not an effort setting.

> The savings come from *fewer and cheaper* windows, **not** a weaker brain on the hard parts.

---

## Part 13 — Invariants you must preserve

1. **Static agent system prompts (prompt-cache invariant).** Each agent's system prompt is a
   cache prefix reused across many spawns — *only while it stays byte-stable*. **Never interpolate
   per-task content** (paths, the Handover Spec, the memory dir, a discovery digest, the goal)
   **into an agent's system prompt.** All variable content goes in the **spawn prompt** (the user
   turn), exactly as the workflow's `planPrompt`/`buildPrompt`/`gatePrompt` do. Baking task content
   into a system prompt silently busts the cache on *every* spawn — the dominant per-window cost.

2. **The orchestrator is the only user-facing role and the only memory writer.** No sub-agent
   addresses the user; no sub-agent writes memory.

3. **Leads never edit; coders never plan; reviewers never edit.** Enforce by tool restriction
   (P3), not just by instruction.

4. **No silent takeover.** Tier 2/3 is *proposed* and waits for the user (unless `auto`).

5. **No guessed runtime shapes in a spec.** Runtime facts come from a scout with shell, verified,
   into `discovery_context`.

6. **Schemas stay flat** (no conditional JSON-Schema keywords) — enforce status-conditional
   requirements in the prompt/runtime.

7. **Bounded self-healing.** Conversational mode ≤ 2 amend→rebuild cycles then escalate; workflow
   mode does exactly one amend-retry.

---

## Part 14 — Build checklist (recommended order)

1. **Author `orchestration.md`-equivalent** — the orchestrator's operating rules (Parts 1, 3–10,
   12–13 condensed). Wire it to load at session start (P7).
2. **Define the agent roster** (Part 3) — one static system prompt per agent, with tool
   restrictions (P3) and model/effort tiers (P4). Use the dev-team `agents/*.md` as source text;
   keep every prompt free of `${...}` interpolation (Invariant 1).
3. **Lock the Handover Spec + coder-return contracts** (Part 5 + Appendix A). These are the spine.
4. **Implement Tier 1 + Tier 2 conversational flow** (Parts 4, 6) with spec-lint + the
   insufficiency loop. This alone is a usable team.
5. **Add the QA review ladder** (Part 7) — risk scoring, deep triggers, bundle sizing, inline
   validation.
6. **Add memory** (Part 8) — two tiers, precedence, single-writer reconcile, bootstrap.
7. **Add Tier 3** (Part 6) — shared discovery, architecture package, plan-reviewer, approval gate.
8. **Add workflow mode** (Part 11) — if your harness has P6/P8/P9. Port the wave scheduler and
   review-routing regexes verbatim; they're harness-independent logic.
9. **Add the UX commands** (Part 12 of the original: `/team`, `/next`, `/ship`, `/onboard`) as
   macros or NL triggers (P12).
10. **Verify the invariants** (Part 13) hold — especially static prompts and tool-enforced
    read-only roles.

---

## Appendix A — Canonical schemas

**Handover Spec** (lead → coder):
```json
{
  "type": "object",
  "required": ["task_id","domain","goal","files_in_scope","constraints","acceptance_criteria",
               "validation_commands","discovery_context","out_of_scope","depends_on","interface_contract"],
  "additionalProperties": false,
  "properties": {
    "task_id": { "type": "string" },
    "domain": { "type": "string", "enum": ["frontend","backend","devops","qa"] },
    "goal": { "type": "string" },
    "files_in_scope": { "type": "array", "items": { "type": "string" } },
    "constraints": { "type": "array", "items": { "type": "string" } },
    "acceptance_criteria": { "type": "array", "items": { "type": "string" } },
    "validation_commands": { "type": "array", "items": { "type": "string" } },
    "discovery_context": { "type": "string" },
    "out_of_scope": { "type": "array", "items": { "type": "string" } },
    "depends_on": { "type": "array", "items": { "type": "string" } },
    "interface_contract": { "type": "string" }
  }
}
```

**Coder return** (coder → orchestrator). Kept flat; status-conditional requirements
(`missing_context` when `insufficient`; `changes`+`validation` when `done`) enforced by prompt:
```json
{
  "type": "object",
  "required": ["status","reason"],
  "additionalProperties": false,
  "properties": {
    "status": { "type": "string", "enum": ["done","insufficient","blocked"] },
    "reason": { "type": "string" },
    "missing_context": { "type": "string" },
    "changes": { "type": "array", "items": { "type": "string" } },
    "validation": { "type": "string" }
  }
}
```

**Review verdict** and **build-check** (workflow gate):
```json
{ "type":"object", "required":["pass"], "additionalProperties":false,
  "properties": { "pass": {"type":"boolean"}, "findings": {"type":"array","items":{"type":"string"}} } }

{ "type":"object", "required":["pass","summary"], "additionalProperties":false,
  "properties": { "pass": {"type":"boolean"}, "summary": {"type":"string"} } }
```

---

## Appendix B — Worked Handover Spec (the bar to hit)

```
task_id: be-01
domain: backend
goal: Add a priority (low|med|high, default med) field to items and expose it in the create + list endpoints.
files_in_scope: [src/api/items.ts]
constraints: [Match the existing handler style in items.ts; validate at the boundary with the zod schema in src/schemas.ts (conventions.md "validation-at-boundary").]
acceptance_criteria: [POST /items accepts priority and rejects values outside the enum with 400; GET /items returns priority; "npm test -- items" passes.]
validation_commands: [npm run typecheck, npm test -- items]
discovery_context: Handlers live in src/api/items.ts (createItem ~L40, listItems ~L72), pattern (req,res)=>{} returning res.json(). Validation uses zod schemas in src/schemas.ts (ItemSchema ~L12) — extend it, don't hand-roll. Rows persist via db.insert() from src/db.ts (schemaless JSON, no migration). Gotcha: listItems paginates via ?cursor — preserve it.
out_of_scope: [the frontend badge (fe-02), DB migrations]
depends_on: []
interface_contract: Item = { id: string, title: string, priority: 'low'|'med'|'high', done: boolean } — backend owns this; fe-02 consumes it.
```

Note how `discovery_context` names every external symbol (`createItem`, `listItems`, `ItemSchema`,
`db.insert`), the file each lives in, a `file:line` pattern to mirror, and the pagination gotcha —
so the coder never has to search outside `src/api/items.ts`. That is the standard.

---

## Appendix C — Source-of-truth file map (in the original plugin)

If you have access to the original repo, these are the authoritative files behind each section:

| Concern | File |
|---------|------|
| Orchestrator operating rules | `orchestration.md` |
| Handover Spec canonical template + completeness checklist | `handover-spec.md` |
| Machine schemas | `handover-spec.schema.json`, `coder-return.schema.json` |
| Deterministic workflow (wave scheduler, review routing) | `team-build.workflow.mjs` |
| Agent definitions (static system prompts) | `agents/*.md` |
| Session-start rule injection | `hooks/hooks.json` |
| UX commands | `commands/{team,next,ship,onboard}.md` |
| Plugin/marketplace manifests | `.claude-plugin/{plugin,marketplace}.json` |
| Overview | `README.md` |
