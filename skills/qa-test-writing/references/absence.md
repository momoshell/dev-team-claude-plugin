# Absent is not zero

**Rule: a value nobody measured is recorded as absent, with the reason it is
absent. Never as a zero.**

A zero is a measurement — it says "we looked, and there was none." An absence
says "we did not look, or could not." Collapsing the two produces numbers that
are silently wrong in a direction nobody can detect downstream, because a zero
propagates through arithmetic without complaint.

## What this looks like in practice

The crew records absences as a reason string, not a sentinel number:

```js
export const SHADOW_ABSENT = Object.freeze({
  cost: USAGE_ABSENT_CAUSES.pane,   // reused, not restated — one owner per reason
  pass_rate: "no review by this cell was its run's first round — UNMEASURED,
              never a zero rate",
  breaker: "no breaker policy is configured (CREW_BREAKER_THRESHOLD unset) —
            candidate cell health is UNMEASURED, never healthy",
  reviews: "the ledger mirror is degraded or unreadable — first-round pass
            rates are UNMEASURED, never zero",
})
```

Note the shape: each reason states **what was looked for, why it is missing, and
what it must not be read as**. A reason that says only "not available" leaves the
next reader to guess.

Note also `cost`: the reason is **referenced from its owner**, not copied. Two
copies of one reason drift, and a drifted reason is a lie about a measurement —
the same coupling rule as `references/captures.md`.

## Complete-or-absent

A partial record is a special case of the same error. Where a payload has
several fields that only make sense together — the four token classes, a cost
breakdown — record **all of them or none**. A structure that is half-filled will
be consumed as though it were whole.

The pi usage record is complete-or-null for exactly this reason: a downstream
consumer does `totals.cost += usage.cost.total`, an unconditional dereference. A
partial usage object crashes it; a null is handled.

## Pinning it

Pin absence **in both directions**, or the distinction rots:

- an unmeasured value records `null` **and** its reason — pinned
- a genuinely measured zero records `0` and is **distinguishable** from the
  absence — pinned
- an emitter that never ran is an **absence**, never a failed write

The middle one is the one people skip. Without it, a later change can turn every
real zero into an absence and no test notices.

## Retired is not empty

A table with zero rows because it was retired is not the same as a table with
zero rows because nothing happened. This repo states retirement explicitly in
the doctor readout — *"A zero row count is retired, never nothing happened"* —
so an operator reading a count is told which kind of zero it is.

Same rule, one level up: when you report a count, say what kind of zero it is.
