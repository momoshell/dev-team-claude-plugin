# ADR-048 — Ordered build steps: a plan's chunk program can run inside one lane, one builder assignment per step

**Status:** *proposed* 2026-09-27, operator decision pending · **Owner:** operator · **Relates to:** ADR-030 (gate-first
acceptance), ADR-035 (execution shape is its own axis), ADR-044 (a new executor path is hand-written and named)

The idea comes from Kiro's spec tasks. There, `tasks.md` is a checklist, each task cites the requirements it answers
(`_Requirements: x.y_`), tasks run one at a time with an in-progress/completed status, and dependencies form waves. The
question is whether a lane's build stage should work the same way: several ordered, smaller builder assignments, each
proven by the gate checks it owns, instead of one assignment carrying the whole plan.

Every `file:line` below was read at `46594dad`.

## What exists today

**The plan's order is prose that nothing reads.** `plan.md` has a **Sequencing** section, "what lands before what, if
anything" (`crew/roles/planner.md:30`). No code under `crew/` or `scripts/` reads it.

**At plan-accept the driver binds these fields and nothing else:** `files_in_scope` (`crew/drive.mjs:8396`),
`validation_lane` (`:8446`), `gate_path`/`gate_cmd` (`:8458-8459`) and `mutations` (`:8461`). It also runs the
acceptance coverage check against the brief (`:8485`). On a plan revision it reads `carve_verdict`/`carve_slices`
(`:1414-1427`). **On a `--chunked` lane only**, it reads `details.chunks` (`:8498-8519`).

**The builder gets the whole plan as one brief.** The first build brief is the plan itself
(`let suiteBuildBrief = planPath`, `crew/drive.mjs:9870`, carried into `buildBrief` at `:10152`). Each round is one
stage, `build:r<n>` (`:10452`), and one assignment,
`assignAndWait('builder', builderAssignmentBrief(buildBrief), buildNote)` (`:10454`). Every later round is a bounce
through the same loop: `build-fix` `:10541`, `lane-fix` `:10583`, `gate-fix` `:10731`, `scope-fix` `:10514`/`:10550`.
The builder charter says "You execute `plan.md` exactly" (`crew/roles/builder.md:3-4`).

**A program shape already exists: `details.chunks`.** It arrived with `c2301a07` (2026-09-19) and is not mentioned
in the planner charter. `validateChunks` (`crew/drive.mjs:2484-2553`) enforces all of the following:

- ids match `CHUNK_ID` and are unique;
- each chunk's `files_in_scope` is non-empty and inside the plan's scope;
- each chunk's `checks_owned` is non-empty and names declared gate labels;
- `depends_on` names earlier chunks only (`chunk-dep-forward`);
- **every provable check is owned by exactly one chunk** (`chunk-check-unowned`, `chunk-check-double-owned`);
- exemptions form a third bucket;
- the first chunk is buildable alone (`chunk-first-unbuildable`).

`chunkGateVerdict` (`:2600`) adjudicates the gate per owned check and *defers* reds owned by another chunk
(`chunkDeferredRows`, `:2589`).

**Today a chunk program runs across lanes, never inside one.** `dispatch-batch --from-plan` compiles a parent
planner envelope's `details.chunks` into one request per chunk (`scripts/factory/dispatch-batch.mjs:907-915`).
When a plan has no chunks, it derives them from `carve_slices`. Each request carries `adopt` of the parent,
`assurance: quick` and dependency lane names, and records the wave (`skills/crew-dispatch/references/batch.md:38-42`).
Each chunk lane boots with `--chunked --chunk <id>` (`crew/crew.mjs:4882-4885`; `dispatch-batch.mjs:3947`) and runs
a full lane of its own: build, review, suite and publish.

**`carve_slices` is a third, human-routed split.** A plan revision may answer `carve`, and a carve always escalates
to the human carrying the slices (`crew/roles/planner.md:99-105`).

**Traceability is already built at the check level.** A brief's `## Acceptance` ids use the same grammar as gate
check labels (`ACCEPTANCE_ITEM`, `crew/drive.mjs:2331-2337`). Plan-accept escalates when an id has no proving mutation
(`crew/drive.mjs:8484-8492`, `acceptanceCoverage` `:2370`). An exemption counts as waived, never as covered.

**The visualizer renders no plan content.** `visualizer/server/returns-source.mjs` reads `ledger/run.json` and
`returns/*.json` (`:47`, `:53-61`). No page renders `plan.md` or `details.chunks`. A journal reader exists
(`visualizer/server/journal-source.mjs`).

## Decision (proposed)

### 1. One program, two executors: steps are `details.chunks` run inside a lane

The brief this record was drafted from proposed a new `details.steps: [{id, files, check_ids, depends_on?}]`. That
shape is `details.chunks` with other names: `id`, `files_in_scope`, `checks_owned`, `depends_on`.

- **Recommended: reuse `details.chunks` and `validateChunks` unchanged.** The planner writes one program. Dispatch
  decides whether it runs as lanes (`--from-plan`, today) or as steps inside one lane (new). Where the as-asked rule
  said "every gate check covered by ≥1 step", keep the existing *exactly one owner*. That is what makes a red check
  attributable to one step, and a bounce to one assignment.
- **Rejected: a separate `details.steps` field.** Two validators for one shape drift apart. A planner whose program
  might run either way would author it twice.

### 2. The stepped executor

This is a new hand-written executor path, named by a declaration, per ADR-044. It is not an interpreter of the
program. On a lane dispatched stepped, after plan-accept and the gate baseline:

- **Order.** Steps run in declared order, which `chunk-dep-forward` already makes topological. **There are no
  parallel waves inside a lane:** one worktree has one builder. `depends_on` constrains order and resume. Parallel
  waves remain what chunks-as-lanes are for.
- **One builder assignment per step.** The stage is `build:<step>:r<n>`, so the ledger's `build:r<n>` round count
  (`docs/advisor-ab-protocol.md` §1) does not read step assignments as bounces. The step brief is the plan plus a
  header naming this step's id, files and owned checks, and the steps already done. The builder's charter changes from
  "execute `plan.md` exactly" to "execute this step of `plan.md` exactly".
- **Check after each step.** The gate runs, adjudicated per step:
  - this step's owned checks must pass;
  - **checks owned by steps already done must stay green** (a regression is this step's red, never a reopening of
    the earlier step);
  - reds owned by later steps are deferred, as `chunkGateVerdict` does today.
- **Bounce inside the step.** A red step bounces the builder with the failing labels, still inside the step. Bounces
  spend the lane's existing global builder budget (`builderRemaining`). No per-step budget is minted (open
  question 4).
- **Once all steps are done**, the unchanged pipeline runs once over the whole diff: validation lane, scope
  record, per-check mutation proof, review, full suite, cold suite and commit. Mutation proof stays once per lane.
  Running it per step would multiply gate runs, and gate cost is the lane's wall clock.
- **Journal.** Each step writes three rows: `step:start {step, round, files, owned}`, `step:done {step, round,
  passed}` and `step:red {step, round, failed, regressed}`. They are journal facts. Ingesting them into the ledger is a
  later, additive table, not part of the first lane.
- **Resume and adoption.** A resumed lane skips a step only when a `step:done` is journaled for it **and** its owned
  checks are green again on the resumed tree. It re-verifies and never trusts the journal alone. An adopted plan
  carries its chunk program unchanged.

### 3. Visualizer

Render the program from the accepted planner envelope's `details.chunks` (the envelope `returns-source.mjs` already
reads), joined with the `step:*` journal rows. Each step shows `pending`, `in progress`, `done` or `red`, with its
owned checks and their acceptance ids. A plan with no chunks renders as it does today.

### 4. Requirement traceability: no new field, one charter change

`checks_owned` names gate labels, and gate labels *are* acceptance ids (`crew/drive.mjs:2331-2337`). A step therefore
traces to the brief's `done_means` transitively, and plan-accept already refuses an uncovered id. So the only
change is to the charter. `crew/roles/planner.md` documents `details.chunks`, which it does not do today, and says
each chunk's `checks_owned` should name acceptance ids. A check that is not an acceptance id is recorded as `extra`
and is never refused.

## The turn-economy risk, stated

Stepped building means more and smaller builder assignments. The numbers that decide whether that pays:

- **Every extra assignment pays the builder's fixed overhead.** The 2026-09-09 census fit
  (`model_time = overhead + marginal × turns`, 1,388 assignments in 208 lanes) put the builder at **87 s overhead,
  12.3 s/turn marginal (n = 269, R² 0.90)**. The builder's overhead figure is in the operator's notes, not in a
  tracked document. The tracked record is `docs/decisions-needed.md:26-27`: builder marginal **12.0 s/turn on a first
  round and 15.3 s/turn on later rounds**, and the planner's **169 s fixed overhead × 414 assignments = 19.4 h, 13% of
  146.7 h** of seat wall clock. A k-step lane therefore starts about (k − 1) × 87 s behind before any saving, and the
  deciding lane re-measures that overhead from `seat_turn_census` rather than citing it.
- **The saving has to come from turns and bounces.** It needs a narrower working set per assignment (fewer reads per
  turn), reds localized to one step (fewer whole-plan bounces), and fewer assignments hitting the builder's
  per-assignment turn ceiling. None of these is measured. Whether a step assignment costs like a first round
  (12.0 s/turn) or like a later one (15.3 s/turn) is also unknown.
- **The planner pays nothing new per assignment.** Its 169 s overhead is per assignment, and a program adds no
  planner assignment. It adds authoring turns inside the one it has.
- **The gate runs k times instead of once per round.** On a lane whose gate is expensive this is the dominant term,
  and it is measurable per lane before dispatch.

## Measurement that decides the default

- **Opt-in only**, for the first **12 stepped lanes** (the repo's `CELL_RATE_FLOOR`, `scripts/factory/ledger.mjs:427`).
- **Assignment:** among plans that declare a chunk program, dispatch alternates stepped and single-brief. The planner
  writes the program either way, so the arms differ only in executor. Matching after the fact (same assurance preset,
  similar check and file counts, same builder cell) is the fallback. It is weaker, and the readout says so.
- **Per arm, with denominators:**
  - build assignments per lane;
  - bounces per lane (red rounds / lanes);
  - builder turns per lane (sum of the census);
  - escalations / lanes, broken out by stage;
  - lane wall clock from plan-accept to commit;
  - gate runs per lane.
  A lane missing a census row is `null` with its reason, never 0.
- **Ships by default only if**, at the floor, the stepped arm is no worse on escalations and wall clock and better on
  at least one of bounces or escalations. Otherwise it stays opt-in or is deleted. Below the floor the readout is
  `thin`, not a result.

## Relation to the other splits

| | granularity | who runs it | parallel? | review / suite / PR |
|---|---|---|---|---|
| `carve_slices` | inter-lane | escalates to the human | human decides | per lane |
| `details.chunks` via `--from-plan` | inter-lane | dispatch, one lane per chunk, `adopt` of the parent | yes, by dependency wave | per chunk lane |
| **steps (this ADR)** | **intra-lane** | the driver, one builder assignment per chunk | **no** | **once for the whole lane** |

## Migration

1. **This ADR.**
2. **Planner and validator lane.** `crew/roles/planner.md` documents `details.chunks` and the acceptance-id note
   (prompt surface, `crew/protected-paths.mjs:15`). The dispatch request gains the stepped switch. `validateChunks`
   is unchanged, apart from possibly refusing a one-step program on a stepped lane.
3. **Driver lane.** Build the step loop, the per-step adjudication with its regression rule, the `step:*` journal
   rows and step-granular resume in `crew/drive.mjs`. It is on the protected floor, so it runs rigorous with
   kill-mutations on the regression rule and on resume re-verification.
4. **Visualizer lane.** Render the program and step status.

## Out of scope

Parallel builders inside one lane. Per-step review or per-step mutation proof. A per-step builder budget. Changing
chunks-as-lanes or carve. Ledger ingestion of `step:*` rows. Making stepped the default.

## Open questions for the operator

1. **Field:** reuse `details.chunks` (recommended) or mint `details.steps`?
2. **Switch:** is stepped a dispatch-time choice, like `--chunked`, and a new execution shape in `crew/variants.mjs`
   (recommended)? Or is it a planner envelope field?
3. **Per-step check:** the gate's owned checks only (recommended), or the validation lane as well?
4. **Budget:** do bounces spend the lane's global builder budget (recommended), or does each step get its own cap?
5. **Measurement:** alternate stepped and single-brief on chunked plans (recommended), or match after the fact? Is
   N = 12 per arm right?

## Reverses if

At the floor, stepped lanes cost more wall clock with no fewer bounces or escalations than matched single-brief lanes.
Then the stepped executor is deleted, and `details.chunks` keeps its inter-lane use.
