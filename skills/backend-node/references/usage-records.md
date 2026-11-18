# Complete-or-absent usage records

Own the producer contract in `crew/pi/extensions/subagent.ts`:
`createStreamReducer` returns complete usage only when measured, otherwise its
internal getter returns `null`. The `execute` result constructor omits the public
`usage` key when unmeasured. A consumer dereferences nested cost fields, so a
partial record is unsafe. Do not fill unknown fields with zero: zero is a
measurement. See `skills/qa-test-writing/references/absence.md`.

In `crew/pi/extensions/subagent.test.mjs`, `every pre-spawn refusal is bounded, payload-free, spawns nothing and journals nothing`
and `the child is spawned under a deadline that escalates to SIGKILL` assert
public-key absence with `Object.hasOwn` on their selected refusal and timeout
paths. `the reducer folds what the rule claims` pins the reducer alone: `usage()` is
`null` for a frame the rule does not count as the child's own spend and a
complete record for one it does. No test pins the complete measured public
result or the journal nulls; the `execute` result construction and `usageRow`
in `crew/pi/extensions/subagent.ts` own those. An empty transcript
should follow the absent path, not fabricate billing. Keep the getter and
constructor together in review; `execute` and advisor.ts drive the reducer
directly. A partial record risks a TypeError or poisoned aggregate; a fabricated
zero makes a false accounting claim.

An interrupted child and a failed usage parse after work starts remain unbacked
in this checkout; see `evidence.md`. Neither should produce partial usage or be
interpreted as zero. Re-measure before changing the consumer contract.
