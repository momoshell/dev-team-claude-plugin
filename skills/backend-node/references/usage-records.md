# Complete-or-absent usage records

Own the producer contract in `crew/pi/extensions/subagent.ts`:
`createStreamReducer` returns complete usage only when measured, otherwise its
internal getter returns `null`. The `execute` result constructor omits the public
`usage` key when unmeasured. A consumer dereferences nested cost fields, so a
partial record is unsafe. Do not fill unknown fields with zero: zero is a
measurement. See `skills/qa-test-writing/references/absence.md`.

The `usage is a complete pi Usage or absent, never partial` test in
`crew/pi/extensions/subagent.test.mjs` pins measured usage and omitted key
absence with `Object.hasOwn`. An empty transcript should follow the absent path,
not fabricate billing. Keep the getter, constructor and test together in review;
`foldUsage` and `foldPiUsage` use the reducer. A partial record risks a TypeError
or poisoned aggregate; a fabricated zero makes a false accounting claim.

An interrupted child and a failed usage parse after work starts remain unbacked
in this checkout; see `evidence.md`. Neither should produce partial usage or be
interpreted as zero. Re-measure before changing the consumer contract.
