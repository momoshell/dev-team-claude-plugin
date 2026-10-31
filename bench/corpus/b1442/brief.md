# Task

---
source: operator request (b1440 hand finish, 2026-10-30)
closes: null
tier: build
shape: standard
acceptance: [FI1, FI2]
out_of_scope: the loop's lead decisions, the finish decisions (accept, return, abandon) and the gate itself
---
## The ask

Lane b1440 stopped `lead-escalated`. Its builder had made the whole change but returned `insufficient`,
because the planner's gate threw before exercising any check. A finish run is the path that may repair a
lane's gate, yet `crew finish` refused with `finish-no-build`: it counts only a builder envelope with
status `done`. So the lane had to be finished by hand. Invariant: finish re-enters a stopped lane whose
last builder returned a schema-valid `insufficient` envelope and left an uncommitted build. A lane with no
schema-valid builder envelope is still refused.

## Context

- `crew/finish.mjs`: the `finish-no-build` refusal and its header comment.
- `skills/crew-recovery/SKILL.md` "Finish it": the refusal list it states.
- `crew/finish.test.mjs`: the refusal tests.

## Acceptance

- (FI1) `crew finish` on a stopped lane whose builder envelope is schema-valid `insufficient` does not refuse with `finish-no-build`
- (FI2) `crew finish` on a stopped lane whose only builder envelope has defects still refuses with `finish-no-build`
