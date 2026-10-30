# Task

---
source: operator request (lean lanes b1396 and b1401 stopped on planner mutations that never bound)
closes: null
tier: build
shape: standard
acceptance: [RA1, RA2, RA3, RA4, RA5]
out_of_scope: crew/checks.mjs, crew/finish.mjs, the finish shape's behaviour, and any change to how a survived mutation is handled
---
## The ask

A planner writes its mutation declarations before the code exists, so a `find` text often names code the builder
wrote differently, and the proof reports it `unmeasured` with reason `bind-fail` (the text occurs zero times or more
than once). Today that stops a standard lane as `mutation-unmeasured` even when the gate is green. It stopped
b1396 (one declaration) and b1401 (four), and each needed a hand-finish.

In the standard shape, when every row of the proof that did not kill is a `bind-fail`, give the builder exactly one
turn to re-aim those declarations, then run the gate and the proof again. The finish shape already lets a builder
return replacement declarations (`details.mutations`); reuse that field.

Invariants:
- Only a `bind-fail` earns the re-aim turn. A survived mutation, a timeout or any other unmeasured row stops the
  lane as today: re-aiming a mutation the gate did not catch would let the builder pick an easier target.
- In the re-aim turn a builder may replace only the declarations that failed to bind.
- One re-aim turn per lane. A proof that still has a `bind-fail` after it stops as `mutation-unmeasured`.
- The finish shape behaves exactly as today.

## Context

- `crew/loop.mjs`: builder replacements are read at lines 264-269; the proof and its stop are at 274-278 and refused
  outside the finish shape. The suite-repair path (around line 300-320) is the existing pattern for one extra builder
  turn with targeted feedback and a raised round bound.
- `crew/checks.mjs:286`: a declaration whose `find` occurs other than once becomes `outcome: 'unmeasured'`,
  `reason: 'bind-fail'`, with `occurrences`.
- `crew/agents/builder.md:26` describes `details.mutations` for finish runs only; it should also cover the re-aim turn.
- `crew/loop.test.mjs` `fakes()` and the finish tests at its end show how to drive a run and edit the builder's
  envelope.

## Acceptance

- (RA1) a standard run whose proof has a `bind-fail` row gives the builder one more turn whose feedback names that acceptance id.
- (RA2) a replacement declaration the builder returns in that turn is the declaration the next proof runs for that id.
- (RA3) a replacement in that turn for an id whose declaration bound stops the lane as `envelope-refused`.
- (RA4) a proof that still has a `bind-fail` after the re-aim turn stops the lane as `mutation-unmeasured`.
- (RA5) a proof with a survived row stops the lane as `mutations-survived` without another builder turn.
