# ADR-038 — The protected floor forces proof on the changed surface, not plan-time adversary rounds

**Status:** ratified 2026-09-01 · **Issue:** none yet (measured in-session, 2026-09-01) · **Owner:** operator

## Context

The protected floor (`crew/protected-paths.mjs`) forces `rigorous` assurance
(legacy `judge`) on any lane whose fence touches a protected file. Rigorous
assurance currently bundles two distinct controls:

1. the tech-lead **plan-check loop** — `plan:rN → check:rN` until acceptance
   or the round cap;
2. stricter post-change controls — the gate, scope gate and review.

Measured across the five lanes of 2026-08-31/09-01, the plan-check loop is
where the cost lives:

| lane | assurance | plan phases | total planning |
|---|---|---|---|
| b356-runseats | standard | 12.9m | **13m** |
| b358-planadopt | standard | 13.1m | **13m** |
| b355-rosterv2 | rigorous | 24.2 · 11.6 · 15.3 · 7.5 · 6.0 · 1.8 | **66m** |
| b354-slotdriver | rigorous | 31.3 · 18.0 · 14.2 → escalated at cap | **64m** |

The gap is the adversary loop existing at all, not a larger budget: the round
caps are identical across assurances (`plan=2 build=3 review=2`, measured in
all five journals).

The floor forced this loop on #824 — a mechanical change (wrap three call
sites in acquire/release, specified line-by-line in the issue) — because
`crew/drive.mjs` is protected. Nothing about the *change* needed an adversary;
the file's location decided it. Both #824 attempts then died in or around
plan phases: b354 at the round cap, b357's planner at its wait ceiling. #507
already states the narrower half of this observation ("split the lane instead
of dragging the whole surface through the floor") and was not applied.

The floor's question — *does this file need extra care?* — and the adversary
loop's question — *does this plan need to be argued?* — are different
questions with different evidence. At plan time the change does not exist, so
any pre-change criticality assessment, by model or by rule, is a prediction
from prose. The controls that see the real diff are the gate, the scope gate
and review. This repo's own doctrine says a guard is vacuous unless proven by
mutation; the corollary is that a *proven* guard is the strongest control we
have, and it is post-change.

## Decision

1. **The protected floor guarantees proof, not rounds.** A lane touching a
   protected file must land a gate that carries a kill-mutation covering the
   changed behaviour **in each protected file it touches**, and its review
   runs at rigorous strictness. A gate that cannot demonstrate this fails the
   lane at the gate, not at plan time.
2. **The plan-check loop gets its own trigger, decided where evidence
   lives.** The tech-lead adversary rounds run when any of:
   - the **planner declares** `needs_adversary` in its envelope — a closed
     enum field, set by the seat closest to the evidence, costing no extra
     turn;
   - the **gate cannot prove** the protected surface — the driver checks the
     accepted plan's gate for mutation coverage of the protected files and
     seats the adversary when coverage is absent. **Fails closed:** no
     coverage → adversary;
   - the **operator forces it** (`--tier judge` / rigorous, unchanged).
3. **On headless transport the tech-lead seat is declared but idle** until
   one of the triggers fires. Seats spawn per assignment, so an unconsulted
   adversary costs nothing; no boot-time decision is required.
4. **#507's split rule becomes a dispatcher warning.** When a lane's
   protected hits are separable from the rest of its surface, dispatch warns
   with the split it would make. It does not refuse; the operator decides.

## What this deliberately does not do

- It does not weaken what "protected" means. Every protected touch still
  lands only through a mutation-proven gate and rigorous review — controls
  that read the diff, where before it also bought plan rounds that read
  prose.
- It does not ask a model "is this change critical?" at dispatch. That is a
  prediction from a brief — the weakest input at the most expensive moment —
  and #679/ADR-034 says every step code can do, code does. The one
  model-shaped input retained (`needs_adversary`) is a declaration by a seat
  that has already read the code, inside an envelope it already writes.
- It does not touch the floor's membership, `resolveProtectedPaths`, or the
  refusal `tier-floor-conflict` for an operator request *below* the floor's
  post-change controls.

## Consequences

- A mechanical change to `crew/drive.mjs` with a complete spec plans once
  (~13m measured) instead of running the adversary loop (~65m measured), and
  the protected surface is guarded by a proven kill-mutation instead of an
  argument.
- The driver's gate-coverage check is new code in `crew/drive.mjs` and lands
  as its own lane **after b359-slotdriver frees that surface**. Until it
  lands, the floor keeps forcing rigorous exactly as today — this record
  changes nothing by itself.
- `needs_adversary` extends the planner envelope schema (closed enum,
  absent = false) and the acceptance path in `crew/drive.mjs`.
- The dispatcher's split warning extends `dispatch-batch.mjs` beside
  `anchor-pin-unfenced`, reporting rather than refusing, same as #635's
  precedent.
- The ledger gains nothing new: plan-phase durations are already measurable
  from stage rows (that measurement produced the table above), so the claim
  this ADR rests on stays checkable after the change.

## Rejected alternatives

- **Classify criticality from the brief (model or heuristic).** A prediction
  from prose about a diff that does not exist; unfalsifiable at decision
  time. `proposeShape` (`scripts/factory/make-brief.mjs:1229`) already shows
  the failure mode — it counts protected hits and restates the floor, adding
  no information about the change.
- **Raise the round caps or budgets instead.** Spends more on the same
  prediction; b354 shows a non-converging argument just uses whatever cap it
  is given.
- **Drop the floor to `standard` for named files.** Weakens the guarantee
  instead of relocating it; the floor's membership is right — `drive.mjs`
  genuinely is load-bearing.
