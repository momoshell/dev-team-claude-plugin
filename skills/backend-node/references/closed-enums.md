# Closed enums are consulted data

Declare a finite vocabulary as data that callers actually consult.
Exhibit: `scripts/factory/ledger.mjs:466` (`CI_DECISIONS`).

`DECISIONS` is frozen with `Object.freeze` at the export boundary.
Exhibit: `crew/drive.mjs:523`.

Production code reads `CI_DECISIONS` when it validates a decision.
Exhibit: `scripts/factory/ledger.mjs:3847`.

`DECISIONS` is exported and frozen but read by no production code; only
`crew/drive-review.test.mjs:1572-1574` reads it, so it is not the exhibit for "callers
actually consult".

Keep the refusal message derived from the same set.
Exhibit: `crew/shape-validator.mjs:237`.

Pin the expected members independently in the test.
Exhibit: `crew/drive-review.test.mjs:1574`.

Pin immutability independently with `Object.isFrozen`.
Exhibit: `crew/drive-review.test.mjs:1573`.

The paired assertions catch value drift and freeze drift.
Exhibit: `crew/drive-review.test.mjs:1574`.

`PARK_STATES` supplies the same frozen-data pattern elsewhere.
Exhibit: `crew/reclaim.mjs:12`.

`REAP_ACCOUNTING` shows the pattern in a factory script.
Exhibit: `scripts/factory/reap-stale.mjs:82`.

Do not infer closure from an uppercase name or an exported array alone.
Exhibit: `crew/drive-review.test.mjs:1574`.

A mutation that removes the freeze must make the test fail even when members
are unchanged.
Exhibit: `crew/drive-review.test.mjs:1573`.

A mutation that adds a member must also make the literal expectation fail.
Exhibit: `crew/drive-review.test.mjs:1574`.

Read `docs/conventions.md:126` for the repo decision; this file owns the test
shape that keeps the decision observable.

Unknown values should take the existing refusal path rather than being silently
added to a vocabulary.
Exhibit: `crew/shape-validator.mjs:237`.

Empty and null declarations are invalid data, not empty closed enums.
Exhibit: `crew/shape-validator.mjs:226`.

Keep a rule's exhibit beside the declaration and beside its drift guard.
Exhibit: `crew/drive-review.test.mjs:1573` and `:4161`.

The cost of one missing half is a contract that appears closed while remaining
mutable.
Exhibit: `crew/drive-review.test.mjs:1574`.
