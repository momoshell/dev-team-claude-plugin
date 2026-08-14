# Park and lease protocol

This document describes the lease surface and the park **forward path** shipped in
`crew/reclaim.mjs`. A park is durable intent; a lease is the per-seat reservation
that protects the intent while its successor is launched.

## Records and layout

The store creates these sibling directories:

```
<dir>/parks/<park_id>.json
<dir>/leases/<leaseKey>.json
<dir>/locks/...
```

A park record has exactly these twelve top-level keys:

```js
{
  park_id, run_id, state, launch_state,
  seats: [{ role, sessionId, warm }],
  leases: [{ reservation_id, role, sessionId }],
  decision: { decision_id, actor, at, answer } | null,
  spec: null | {
    run_id, resumes_park_id,
    decision: { decision_id, actor, answer }
  },
  linked_at, reason, parked_at, updated_at
}
```

A lease record has exactly these eight keys:

```js
{
  reservation_id, key, phase, role, sessionId, spec,
  owner: { pid, startedAt }, at
}
```

`spec` is normalized strictly: its five scalar leaves are non-blank strings and
there are no extra keys. Lease files are written by the shared fenced
`reservationEngine`; `evidence` is derived from `spec` and is intentionally not
serialized in a lease record.

## Lease verdicts and successor evidence

The inherited reservation engine evaluates a lease in this order:

| Order | Evidence or condition | Verdict |
| --- | --- | --- |
| 1 | no record and the path is readable | `free` |
| 2 | present but unparseable | `unresolvable` — **no override can reach it in this slice** (see Overrides) |
| 3 | successor evidence is **ALIVE** | `busy` |
| 4 | owner PID is **ALIVE** | `busy` |
| 5 | only now, bad `reservation_id` or phase | `unresolvable` |
| 6 | successor evidence is **DEAD** | `reclaimable` |
| 7 | otherwise | `unresolvable` |

The successor mapping is deliberately terminal-only. `active` is ALIVE;
`resumed` and `abandoned` are DEAD; `absent`, `mismatch`, and `unknown` are
UNKNOWN. In particular, a lease whose successor is `absent` is UNKNOWN and
fails closed; only `resumed`/`abandoned` make a seat reclaimable. An absent
window is also “launched but not yet visible”. Treating it as dead would let a
different park steal the seat and enqueue a **different** spec, which D10's
idempotency cannot deduplicate. This preserves session exclusivity.

## Answer and claim CAS

`recordAnswer` writes one human decision and never replaces it. An exact retry
returns the existing record byte-for-byte; any differing answer, actor, or
`decision_id` is `answer-conflict`.

`claim` is a compare-and-swap from `parked/null` to `claimed/pending`. It reads
the persisted decision, creates one normalized frozen successor spec, acquires
the canonical seat set, persists the claimed row before enqueue, and passes that
same frozen spec to `enqueue`. A claimed row with the same decision and
successor is an exact replay; a different successor is `successor-conflict` and
a different decision is `decision-mismatch`. Thus there is one stable human
decision, one successor, forever. When the authority already says `active`, the
forward path links the park and transfers every lease; other authority answers
leave the row `claimed/pending`.

The injected `enqueue` has a D10 precondition: it must be idempotent by
normalized spec. The module's obligation is to pass the identical frozen spec
every time a launch is requested, so an idempotent callee can deduplicate a
relaunch. A falsy or throwing enqueue is recorded as `enqueue-unresolved`; the
park remains retryable for recovery.

## Lock ordering

A caller holds **at most one park lock at a time**, and only then acquires seat
locks in canonical order. It never acquires a park lock while holding a seat
lock, and it never holds two park locks. Release follows the reverse order of
the supplied canonical set. This ordering is shared by claim, transfer, and
settlement.

## Overrides

`overrideLock` is the shipped append-only `overrides.jsonl` ledger. Each lock
override records the lock name and fence, an identity (token or digest), the
actor and reason, and the attestation `{ quiesced: true, method }`. The
attestation is required; this is not an identity-keyed sidecar file.

**There is no lease break-glass in this slice, and rows 2 and 7 above have no
escape hatch.** `verdictOf` consults `overrideMatches` for lease records, but
the only public way to write a reservation override is `store.override`, which
is bound to the *marker* engine — its `pathFor` is `<dir>/.<key>.active.json`,
so for a lease key it finds no marker and throws `reservation override identity
mismatch`. The consequence is stated plainly because it is operationally real:
a lease whose owner is dead and whose successor is `absent`/`mismatch`/`unknown`
— the fail-closed case this design deliberately creates — stays `unresolvable`
with no operator recourse, and the seat is wedged. The same holds for a lease
file that will not parse. Slice 2b owns the fix, alongside the reconciler that
is the other half of the recovery story.

## What this slice does not do

A park's **forward** path is complete; its **crash recovery is not**. The
`reconcileParks` operation and the `PARK_STATES × LAUNCH_STATES` table belong to
**slice 2b**, which owns the reconciler.

If `enqueue` fails or the process dies between the `claimed/pending` write and
the successor becoming visible, the park stays `claimed/pending` and **only
slice 2b's reconciler can move it**. A replayed `claim` returns
`{ok:true, replayed:true}` and deliberately does not re-enqueue (D2).

Nothing consumes this module yet, so this gap is a stated debt, not a live
hazard. The first consumer and the crash-recovery reconciler are intentionally
left to slice 2b.
