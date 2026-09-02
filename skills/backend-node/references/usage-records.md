# Complete-or-absent usage records

Own the producer side of the usage contract in the extension.
Exhibit: `crew/pi/extensions/subagent.ts:471`.

Return the billed record only when measurement occurred.
Exhibit: `crew/pi/extensions/subagent.ts:471`.

Return `null` from the internal getter when nothing was measured.
Exhibit: `crew/pi/extensions/subagent.ts:471`.

The consumer dereferences nested cost fields unconditionally, so partial output
is unsafe.
Exhibit: `crew/pi/extensions/subagent.ts:473`.

Read `skills/qa-test-writing/references/absence.md` for the shared absent-versus-zero rule; this file covers the producer seam.
Exhibit: `skills/qa-test-writing/references/absence.md:3`.

The public result includes a complete `usage` object after a measured run.
Exhibit: `crew/pi/extensions/subagent.test.mjs:474`.

An unmeasured result omits the `usage` key rather than setting it to zero.
Exhibit: `crew/pi/extensions/subagent.test.mjs:486`.

Pin key absence with `Object.hasOwn`, not only with a null value assertion.
Exhibit: `crew/pi/extensions/subagent.test.mjs:486`.

The result constructor documents “Complete or absent” at its decision point.
Exhibit: `crew/pi/extensions/subagent.ts:653`.

Do not fill unknown token fields with zero; zero is a measurement.
Exhibit: `crew/pi/extensions/subagent.test.mjs:486`.

Do not return a record missing only one nested cost field.
Exhibit: `crew/pi/extensions/subagent.ts:473` and `:525`.

An empty transcript should follow the absent path, not a fabricated billing row.
Exhibit: `crew/pi/extensions/subagent.ts:471` and `crew/pi/extensions/subagent.test.mjs:486`.

An interrupted child should not leave a partial usage object behind.
Status: this interrupted-child edge is unbacked in this checkout; see
`evidence.md`.

A failed parse is not evidence of zero spend; preserve the refusal or absence.
Status: this failed-parse edge is unbacked in this checkout; see `evidence.md`.

Keep the getter, constructor, and test in one producer-side review trail.
Exhibit: `crew/pi/extensions/subagent.ts:471`, `:525`, and `crew/pi/extensions/subagent.test.mjs:486`.

The consumer must be able to dereference every field whenever the key exists.
Exhibit: `crew/pi/extensions/subagent.ts:473`.

The cost of a partial record is a TypeError or poisoned aggregate downstream.
Exhibit: `crew/pi/extensions/subagent.ts:473`.

The cost of a fabricated zero is a false accounting claim that looks complete.
Exhibit: `crew/pi/extensions/subagent.test.mjs:486`.

If the pi consumer contract changes, re-measure before widening this producer.
Exhibit: `crew/pi/extensions/subagent.ts:473` and `:525`.
