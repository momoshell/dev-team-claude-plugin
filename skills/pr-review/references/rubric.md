# Review rubric

## Correctness

Start with a counterexample. A must-fix finding should name a triggering state
and the wrong observable in one sentence: F10 measured **95 of 129**
counterexample-shaped findings as must-fix (**74% (95 of 129)**), versus **25 of
125** (**20% (25 of 125)**) when the state was not named. F11 gives the same
shape a length check: the must-fix median was **143 characters** (120 findings),
while the consider median was **273 characters** (83 findings). If the state and
observable cannot be stated, grade the point a consider rather than inflate it
with speculation.

Then attack the high-yield families in the register's order (F9):

- **Indeterminate as definite:** an unknown, denied, absent, or unmeasured state
  must not be read as a definite value — **60% must-fix (30 of 50)**.
- **Lifecycle and clobber:** inspect second runs, terminal envelopes, orphaned forks, and settled seats for overwrite or re-settlement — **63% must-fix (20 of 32)**.
- **Degraded path:** check what remains true when an optional facility fails and
  whether instrumentation became load-bearing — **77% must-fix (10 of 13)**.
- **Hostile CLI/API input:** exercise empty values, trailing flags, prototype keys, giant integers, userinfo, and prefix boundaries — **57% must-fix (12 of 21)**.
- **Render joins:** inspect joins by array position and duplicate-key handling —
  **71% must-fix (10 of 14)**.

The acceptance gate is green on **196 of 203** first build rounds (F19), yet a
reviewer finds a must-fix in **65 of 188** green-gate runs (F6): review is the
primary filter. Keep the baseline honest too: **140 of 269** reviews correctly
find nothing (F5), so a finding quota would optimise against the measurement.

## Contract drift

Look for two callers of one rule disagreeing, a document restating a contract it
does not read, and a literal key serving as the only guard. A worked instance is
this skill's own coupling to `crew/pi/agents/scout.json`; the reader-facing
restatement is `references/findings-shape.md`, and the pinning check keeps both
sides against an independent literal.

The register has no `contract-drift` category. Its nearest instrument is
`contract-literal`, with **4 must-fix of 7** (F9), which is too small to order
anything by. Treat contract drift as an axis, but do not turn that small sample
into a yield claim; it is listed among the rules with no exhibit in
`references/evidence.md`.

## Vacuity

Grade a vacuity finding **should-fix by default**. `false-green` is the largest
class the seat produces: **46 of 254 findings (18%, 46 of 254)** and **19 of 51
should-fixes**. Its must-fix share is **24% (11 of 46)**, below the **47% corpus
baseline (120 of 254)**; the narrower instrument that proves a mutation survives
gives **28% (7 of 25)** (F13). Escalate to must-fix only when the unprotected
behaviour is itself a boundary. This section grades a vacuity finding; it does
not prescribe how to write a non-vacuous test.

## Scope

Out-of-plan edits are findings (`crew/roles/reviewer.md:20`), but they have
never bounced a lane: **0 must-fix in 5** (F12). Plan divergence overall was
**25% (5 of 20)** (F10). Rank this axis last and write the finding without
making it a bounce by default. Doc or markdown locations were **0 must-fix in
16**, stale prose was **0 of 7**, and carried-forward findings were **0 of 10**
(F12).

A remedy needing a file outside `files_in_scope` can only produce a scope bounce,
so it is a consider; cite `crew/guidelines/review-do-not-flag.md` as the owner of
that judgment rather than restating its entries.
