# ADR-044 — Declared topologies name hand-written executor paths; stage declarations are not programs

**Status:** ratified 2026-09-16 · **Issue:** #1298 (D8 of #1288)

## Context

The operator wants workflows whose steps can be rearranged, added, or removed and then run. Today a shape's `stages` array is a bound: `stageEnabled` in `crew/drive.mjs` asks membership and `undeclaredStage` in `crew/drive.mjs` prevents the hand-written driver from emitting an undeclared head. The driver, not the declaration, supplies sequencing. The executor named six implemented topologies at commit `c1f1992b` in a closed table, `EXECUTOR_TOPOLOGIES` in `crew/shape-validator.mjs`.

The partial reviewed table, `PARTIAL_REVIEWED` in `crew/drive.mjs`, is explicitly closed, consulted at fixed sites rather than a composition engine, and hand-wired. Envelope declarations likewise describe fixed orders: `EXECUTABLE_SHAPES` in `crew/variants.mjs` holds the canonical `full` and `scout` declarations and the `review_only` and `verify_only` sequences; one shared envelope branch inside `runTask` in `crew/drive.mjs`, the branch that tells the seat "What accepts this assignment is the SHAPE OF YOUR ENVELOPE", does not dispatch by shape name. It starts the named seat, then runs scope proof and envelope acceptance at the fixed `stage('scope-gate:r1')` and `stage('envelope-accept')` calls.

The mechanical tail is explicit control flow, not an interpreted list: inside `runTask` in `crew/drive.mjs`, `commit`, `document`, and `rebase` are emitted at the `stage('commit')`, `stage('document')` and `stage('rebase')` calls; warm suite, cold suite, and publish are emitted at the `stage('suite')`, `stage('suite:cold')` and `stage('publish')` calls. Their dependencies mean that the committed artifact, documentation, rebased proof, warm and cold verification, and publication cannot safely be treated as freely commutative stages.

A generic registry interpreter would have to encode those dependencies, bounce bounds, freshness rules, resume state, and side-effect refusals as a second control system. The abandoned deterministic-backbone design records spawn-state, orphan-child, lock-order, and duplicate-dispatch/crash-window failure modes (section 1b, "Spawn vs import", of `tasks/deterministic-backbone/architect-consult-v1.md`), while ADR-042 measured `crew/drive.mjs` as a deeply coupled module and recorded the cost of cutting its live coupling (the "Why not `drive.mjs`" section of `docs/adr/adr-042-split-the-suites-not-the-driver.md`).

## Decision

Keep `crew/drive.mjs` as the hand-written executor. Admit only a closed set of **named topologies**, each with an explicit executor branch (or a shared fixed branch for structurally identical envelope shapes), declared sources, seats, and a canonical stage order. A declaration selects and bounds an implemented topology; it never causes the driver to iterate or interpret `stages`.

No stage in the currently declared envelope sequences or mechanical tail is freely re-orderable. The envelope order remains `named seat → scope-gate → envelope-accept`; the mechanical order remains `commit → document → rebase → suite → suite:cold → publish`. A different order is admitted only as a new named topology after its preconditions, run path, postconditions, refusal behavior, and complete trace proof exist in code.

Unknown, missing, extra, or out-of-order declarations are refused before execution with the existing closed shape-validator codes, including `stage-reordered` for `full`. The validator at commit `c1f1992b` had a deliberate `full`-ordering hole in its otherwise explicit extras, missing-head, and reorder checks (the `topologyDefect` function of `crew/shape-validator.mjs` at commit `c1f1992b`); this decision requires closing that hole.

Every reachable successful order must have a mutation-backed test of its emitted stage trace. Normalize recorded labels to heads, remove universal terminal heads, retain repeated heads where they represent a real repeat, and assert that the emitted trace is the declared canonical order or an explicitly named, tested branch trace whose projection is monotone in that canonical order. Optional gate-repair, bounce, resume, converge, and other exceptional paths cannot be silently treated as arbitrary ordering. Every declaration permutation must be refused with `stage-reordered`; no test may substitute set membership for order.

## Rejected alternative

Reject an interpreter over an executable-stage registry of `{preconditions, run, postconditions}` units. It turns descriptive bounds into lifecycle authority and requires a second state machine to recreate invariants currently guaranteed by control-flow adjacency and dominance: scope proof after writes, gate and proof freshness before review and commit, documentation from a committed diff, post-rebase re-proof and recommit, warm and cold suites on the final commit, and publish only after both. It also expands the failure surface around retries, proof freshness, resume, commit identity, and publication without creating a user-visible topology that is safe to run.

## Consequences

- Adding a topology costs an enum/table entry, an explicit driver path, source and seat declarations, complete emitted-trace fixtures, and isolated mutations. This is intentional admission cost; configuration cannot synthesize a new stage order.
- The follow-up is one **L lane**, not an interpreter epic and not an XL refactor. The product change is narrow, but the proof matrix crosses protected executor paths and many branch traces.
- **Validator closure (small):** in `crew/shape-validator.mjs`, enforce canonical order for `full` exactly as for every other implemented topology; in `crew/drive.test.mjs`, require every swap and reversal to return `stage-reordered`.
- **Ordered trace proof (medium/large):** strengthen the existing executor-family matrix from membership to ordered traces, with coverage across envelope, `full`, `repair`, and `directed`, plus bounce, repair, resume, converge, and publish-disabled paths. Extend the existing split drive tests that own those reachable exceptional paths; test helpers may normalize trace heads.
- **Mutation proof (medium):** use one isolated order-edge mutation per independently claimed order edge or family. At minimum mutate envelope seat/scope/accept order, `full` core proof-before-review/commit order, document/rebase/suite order, suite/publish order, partial-topology opening heads, and resume/converge tails, then require the affected trace or refusal test to fail.
- The likely production surface is `crew/shape-validator.mjs`. Likely test surfaces are `crew/drive.test.mjs`, `crew/drive-publish.test.mjs`, and whichever existing split suites already own the reachable exceptional traces; discovery determines the final literal test list. This ADR creates no issue and authorizes no executor abstraction, registry runtime, or stage movement.
- Existing publication and rebased-proof policy remains controlling; ADR-044 narrows how an alternate lifecycle topology may be introduced.

## Reverses if

Reverse this decision only when at least two materially different, production-required topologies cannot be expressed without duplicating invariant logic **and** an executable-unit prototype demonstrates, with mutation-backed traces for every reachable order and crash/resume tests, that its composed pre/postconditions preserve scope, proof freshness, commit identity, cold verification, and publish-last behavior at least as strongly as the hand-written paths. Configuration flexibility or reduced line count alone is not sufficient.
