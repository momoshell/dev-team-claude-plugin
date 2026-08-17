# Park and lease protocol

This document describes the lease surface, the park forward path, and park
reconciliation shipped in `crew/reclaim.mjs`. A park is durable intent; a lease
is the per-seat reservation that protects the intent while its successor is
launched.

## Implementation files

- `crew/reclaim.mjs`

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
| 2 | present but unparseable | `unresolvable` unless an attested lease override matches |
| 3 | successor evidence is **ALIVE** | `busy` |
| 4 | owner PID is **ALIVE** | `busy` |
| 5 | only now, bad `reservation_id` or phase | `unresolvable` unless an attested lease override matches |
| 6 | successor evidence is **DEAD** | `reclaimable` |
| 7 | otherwise | `unresolvable` unless an attested lease override matches |

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
decision for a live claim. When the authority already says `active`, the forward
path links the park and transfers every lease; other authority answers leave the
row `claimed/pending`.

The injected `enqueue` has a D10 precondition: it must be idempotent by
normalized spec. The module passes an identical frozen spec every time a launch
is requested, so an idempotent callee can deduplicate a relaunch. A falsy or
throwing enqueue is recorded as `enqueue-unresolved`; the park remains retryable
for recovery (a reconciliation enqueue throw is never rolled back).

## Lock ordering

A caller holds **at most one park lock at a time**, and only then acquires seat
locks in canonical order. It never acquires a park lock while holding a seat
lock, and it never holds two park locks. Release follows the reverse order of the
supplied canonical set. This ordering is shared by claim, transfer, settlement,
and reconciliation.

## Overrides

`overrideLock` is the append-only `overrides.jsonl` ledger for transition locks.
Each lock override records the lock name and fence, an identity (token or
digest), the actor and reason, and the attestation
`{ quiesced: true, method }`. The attestation is required; this is not an
identity-keyed sidecar file.

`overrideLease(role, sessionId, input)` is the corresponding lease break-glass.
It requires non-blank role, session, actor, and reason plus an attestation with
`quiesced: true` and a non-blank method. The operator identifies the bytes that
are being overridden either with the parsed record's `reservation_id` or with a
SHA-256 `digest` of the raw lease bytes. The lease path must exist and the
identity must match its bytes at append time; an absent record is already
`free`, not overridable. The append-only record contains `at`, actor, reason,
`kind: 'lease'`, the lease key, identity, and attestation, and is written before
the next verdict observes it.

Lease overrides use a disjoint `kind: 'lease'` namespace and require the
attestation at verdict time; a marker `kind: 'reservation'` record cannot unlock
a lease. They are evidence, never holders: ALIVE successor evidence and a live
owner still outrank an override. A digest override also goes inert as soon as
the file bytes change, so it cannot destroy a replacement record. The override
reaches the two fail-closed wedge rows: row 2 (unparseable) and row 7 (the
fall-through `unresolvable` verdict). Once a lease is `reclaimable`, normal
clear-and-reacquire recovery applies.

## Reconciliation

`reconcileParks({ order, enqueue, successorState })` sweeps parks under one park
lock per row and returns exactly six sorted arrays: `linked`, `relaunched`,
`restored`, `settled`, `unresolvable`, and `waiting`. Invalid arguments touch
nothing. A corrupt park file contributes its filename stem to `unresolvable`;
a bad row never gets repaired, and a throwing row cannot stop the sweep.

The row invariant pins the exact twelve keys and valid state/launch pairs. In
particular, `parked` means `launch_state === null`, `spec === null`, and
`leases === []`; `claimed` means `pending` or `enqueued` with a decision and
spec; and `resumed`/`abandoned` means `launch_state === null` and no handles.
Thus `claimed/null`, `parked/pending`, and every other invalid pair are malformed,
not recovery cells. The spec's `resumes_park_id` and decision must agree with the
row. Terminal rows also require no corrupt lease and no on-disk lease carrying
the park's spec.

Authority is the successor probe, never the row's own phase:

| Row | Authority | Action | Bucket |
| --- | --- | --- | --- |
| `parked/null` | — | human blocker; do nothing | `waiting` |
| `claimed/pending` | `active` | verify, link, and transfer every lease | `linked` or `unresolvable` |
| `claimed/enqueued` | `active` | re-verify and complete transfer | `linked` or `unresolvable` |
| `claimed/{pending,enqueued}` | `resumed`/`abandoned` | release the checked set and settle | `settled` or `unresolvable` |
| `claimed/pending` | `absent` | D11 adopt-or-replace relaunch | `relaunched`, `restored`, or `unresolvable` |
| `claimed/enqueued` | `absent` | phantom checked rollback | `restored` or `unresolvable` |
| `claimed/*` | `unknown`/`mismatch` | leave untouched | `unresolvable` |
| `resumed/null` | — | require terminal validity | `settled` or `unresolvable` |
| `abandoned/null` | — | require terminal validity | `settled` or `unresolvable` |
| every other pair or malformed row | — | fail closed; never repair | `unresolvable` |

D11 processes seats in the requested order. A valid on-disk lease whose spec
matches is adopted at its existing reservation id and its owner is renewed to
the live supervisor. Otherwise the record is cleared only when it carries the
park's persisted id, or after a `reclaimable` verdict (including a digest
break-glass), and a fresh lease is reserved. Each resolved id is persisted under
the park fence before the next seat. The final set is strictly verified before
enqueue; a truthy enqueue leaves `claimed/pending` and reports `relaunched`.
A falsy enqueue uses the checked rollback; a throwing enqueue may have landed,
so it leaves the row and reservations in place and reports `unresolvable`.

Rollback releases only reservations proven by `planRelease`, in reverse order.
Foreign valid leases are left untouched. The row is restored to `parked/null`
with `spec: null` only after every reservation is gone and no same-spec or
corrupt residue remains; the human `decision` is retained. Otherwise it keeps
its claimed row and handles so a retry can finish the release. Every park is
processed independently under its own lock and the sweep always continues.
