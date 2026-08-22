---
name: crew-recovery
description: >-
  Load when recovering, proving, closing, or diagnosing a crew lane: preserve
  its state, interpret liveness and escalation stages, run mutation proof,
  publish the PR, and tear down only after closeout.
---

# Crew recovery

Recovery is evidence-preserving closeout, not cleanup by instinct. Keep the
live state available until the built tree is committed, the gate mutations and
suite have been proved, and the PR is published.

## Routing

| Doing… | Read | Rule |
|---|---|---|
| Closing a converged or escalated lane | `references/closeout.md` | Preserve, commit, prove, publish, then teardown last. |
| Running per-check proof safely | `references/mutation-proof.md` | Read planner declarations and commit before any revert. |
| Deciding whether a seat is idle or busy | `references/liveness.md` | Combine status, pane liveness, and both journal timestamp shapes. |
| Interpreting an escalation | `references/escalations.md` | Match the exact emitted token, then take the first evidence-preserving move. |

## Critical rules

- Preserve a live state directory by copy before any recovery experiment; this is the preserve-by-copy rule (#512).
- Teardown is last and belongs in the same turn as the push and PR, never before closeout (b150-permprobe).
- Commit the built tree before a hand mutation proof or any `git checkout --` (b73-pane).
- `status` answers alive, not busy; derive idle-alive versus busy-alive from journal recency (#387).
- Read mutation declarations and scout findings from the per-seat return, not the roll-up field names (#330).
- An escalated run remains the operator's escalation context until its evidence is preserved and a human chooses the next move (#500).

## Key references

- [`references/closeout.md`](references/closeout.md) — closeout order, teardown output, and archive naming.
- [`references/mutation-proof.md`](references/mutation-proof.md) — commit-first per-check mutation proof.
- [`references/liveness.md`](references/liveness.md) — alive versus busy and envelope evidence.
- [`references/escalations.md`](references/escalations.md) — emitted escalation stages and first moves.
