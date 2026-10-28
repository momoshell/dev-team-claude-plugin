# Closed enums are consulted data

Declare a finite vocabulary as data that callers actually consult.
Exhibit: `CHECK_REASONS` in `crew/checks.mjs`, frozen with `Object.freeze` at the
export boundary.

Production code reads the set when it validates a value.
Exhibit: `crew/loop.mjs` extends the check vocabulary into its own reason list.

Pin the expected members independently in the test.
Exhibit: `crew/checks.test.mjs` asserts the count and names tokens by literal.

Pin immutability independently with `Object.isFrozen`, and uniqueness with a
`Set` size check. Exhibit: `crew/checks.test.mjs`.

The paired assertions catch value drift and freeze drift. A mutation that
removes the freeze must make the test fail even when members are unchanged; a
mutation that adds a member must also make the literal expectation fail.

Pin that a downstream vocabulary stays a superset when it extends the set.
Exhibit: `crew/loop.test.mjs` asserts every `CHECK_REASONS` entry is in the
loop's reasons.

Do not infer closure from an uppercase name or an exported array alone.

Keep a refusal message derived from the same set, and send unknown values down
the existing refusal path rather than adding them silently.

Empty and null declarations are invalid data, not empty closed enums.

Read `docs/conventions.md` for the repo decision; this file owns the test shape
that keeps the decision observable.

Keep a rule's exhibit beside the declaration and beside its drift guard. The
cost of one missing half is a contract that appears closed while remaining
mutable.
