---
name: qa-test-writing
description: >-
  Use when writing or reviewing tests, authoring acceptance gates, scoping affected
  tests, or investigating a check that passes when it should fail. Writes and reviews tests in any repository.
---

# Test writing

Use measurement, not reasoning alone, to establish that a check discriminates.
A check nobody has seen fail is not trustworthy. See the [dev-team repository evidence](references/dev-team-evidence.md) for the defects behind these rules.

## Routing

- [Vacuity](references/vacuity.md): writing or reviewing any check.
- [Gates](references/gates.md): authoring an acceptance gate.
- [Captures](references/captures.md): testing vendor stream reducers.
- [Tripwires](references/tripwires.md): scoping affected behavioural and source-grep tests.
- [Tooling](references/tooling.md): scratch trees, suite output and timeouts.
- [Absence](references/absence.md): unmeasured values and zero.
- [Affordances](references/affordances.md): malformed or hostile input.
- [Citations](references/citations.md): citing a path or symbol.
- Toolchain recipes: [node:test](references/node-test.md), [cargo test](references/cargo-test.md), [vitest](references/vitest.md).

For a universal claim about a pure function, generate inputs from every production
of the relevant grammar. Seed the generator, print the failing input, and use an
independent oracle carried by the generator, not rediscovered from serialized
input. Keep an example test for the shape.

## Critical rules

- Never keep a check you have not watched fail. Name the mutation in a comment
  beside the check, run it, observe red, and restore.
- Never derive the expected value from the implementation. Use an independent
  literal, fixture, or capture.
- Never assert over input that cannot reach the subject. Change the fixture,
  not the assertion, when the input is unreachable.
- Never let a detector's key be the only guard against drift; pin the detector.
- An acceptance gate must be red at baseline with no errors, and each check's
  mutation must prove discrimination.
- Never hand-build vendor stream frames: use a recorded capture.
- Never report an unmeasured value as zero. Record absence and one closed reason
  where the contract provides one.
- Pin both directions when fixing an asymmetry. Where implementations share a
  rule, pin their agreement behaviourally against one fixture table.
- Make malformed input expressible before claiming its guard is tested.

If a check cannot discriminate, delete it and say what it was supposed to stop.
Fewer checks that provably fail beat broad coverage that cannot.
