---
name: qa-test-writing
description: >-
  Writes and reviews tests for this repo against rules it has already paid for:
  proving a check can fail (vacuity), naming the mutation each check kills,
  building acceptance gates that are red at baseline and provably
  discriminating, pinning vendor stream formats with recorded captures instead
  of hand-built frames, declaring tripwires when a change moves code or changes
  a detector, and recording an unmeasured value as absent rather than zero. Use
  when writing a new test, reviewing whether an existing test pins anything,
  authoring an acceptance gate, deciding what a lane's tripwire tests are,
  debugging a test that passes when it should not, or judging whether a suite's
  green means anything.
---

Every rule here was paid for by a defect that shipped. Each one names its
exhibit, so you can read what it cost before deciding to skip it.

The posture is **measurement-first**: this domain is *this repo*, not a moving
external API. Do not reason about whether a check discriminates — run the
mutation and watch it go red. A check nobody has seen fail is a check nobody
can trust.

## Routing

| Doing… | Rule that governs it | Details |
|---|---|---|
| Writing any new check | Prove it can fail before you keep it | `references/vacuity.md` |
| Reviewing an existing check | Neutralise the behaviour; if it stays green, it pins nothing | `references/vacuity.md` |
| Authoring an acceptance gate | Red at baseline, `errored: 0`, discrimination proved | `references/gates.md` |
| Testing a reducer over a vendor's stream | Recorded captures, never hand-built frames | `references/captures.md` |
| Deciding a lane's tripwires | A change that moves code or changes a detector owns what it newly flags | `references/tripwires.md` |
| Parsing a suite summary in a script | Strip ANSI; `FORCE_COLOR=0` | `references/tooling.md` |
| Asserting on a value nobody measured | Absent with a reason, never zero | `references/absence.md` |
| Writing a test for a malformed or hostile input | If you cannot express the malformed input, you have not tested the guard | `references/affordances.md` |
| Citing a file from prose or from a comment | Prose citations are pinned by content; comments name the symbol | `references/citations.md` |

Read the reference before writing the check. The rules below are the
irreducible ones; the references carry the exhibits and the failure modes.

## Critical rules

- **Never keep a check you have not watched fail.** Delete the behaviour it
  names, run it, see red, restore. A measured sweep of 12 checks in this repo
  found **9 that passed with the behaviour removed** — 75% vacuity, including
  the builder's `deny: NO_FANOUT` fan-out boundary and the `guardedKill` seam
  (#476). Both are real boundaries that could have been deleted with a green
  suite.

- **Never derive the expected value from the implementation.** A check that
  compares the implementation to itself cannot fail. Exhibit: a check compared
  `MODIFIER_KINDS` to `MODIFIER_KINDS`, and another looped over exactly the keys
  the implementation produced — both green after the behaviour was removed
  (#476 V7, V8). The expected value comes from somewhere the implementation
  cannot edit: a literal in the test, a fixture, a captured file.

- **Never assert over input that cannot reach the subject.** A stronger
  assertion over unreachable input is still vacuous. Exhibits: a sort was pinned
  by a fixture that **was already sorted**, and a kill-seam check returned before
  reaching the seam (#476 V9, V3). When a check is vacuous for this reason, the
  **fixture** is what changes, not the assertion.

- **Never let a detector's key be the only thing that catches drift.** A literal
  key like `openRun(` is blind to an alias, an indirect caller, a block comment,
  a JSDoc body, or a template literal — all four were measured (#476 V5, and the
  same tripwire was hit independently by three separate scouts). If a detector is
  the guard, something must pin the detector.

- **Always name, in a comment beside the check, the mutation it kills** — and
  demonstrate that mutation reddens. A named mutation that nobody ran is a
  claim, not a proof.

- **Never hand-build a vendor's stream frames in a test.** Use a recorded
  capture. Exhibit: this repo's RPC usage tests constructed `message_end` frames
  **with no `role` field at all** — a shape the vendor never emits — which left a
  live token over-count unpinned in either direction, in the one transport that
  calibrates every cost number (#493, fixed in PR #496). Hand-built fixtures
  encode what you *believe* the format is; that belief is the thing under test.

- **Never report a value nobody measured as a zero.** Absent is `null` plus the
  reason it is absent. A zero is a measurement. This distinction is load-bearing
  across the ledger and the seat picker, and it is pinned in both directions
  wherever it appears.

- **Always pin in both directions when you fix an asymmetry.** Fixing an
  over-count without pinning the under-count leaves the mirror defect live. The
  fix for #493 pins the nested frame excluded *and* the assistant frame still
  folded, so it cannot silently invert.

- **Where two implementations share a rule, pin the agreement behaviourally.**
  A comment stating the rule in a third place is not a coupling. Exhibit: the
  #493 fix asserts both reducers against **one fixture table** and requires
  identical results — make either side disagree and the suite goes red.

## When a check cannot be made to discriminate

Delete it, and say what it was supposed to stop. This repo's standing rule is
that **fewer checks which provably fail beat broad coverage that cannot**. A
suite whose green means nothing is worse than a smaller suite whose green means
something, because the first one is trusted.

## Key references

- `references/vacuity.md` — the three shapes of vacuity, with all nine exhibits
  and the mutation method (disposable archives, never the checkout)
- `references/gates.md` — acceptance gates: baseline-red, `errored: 0`,
  discrimination, and why the driver proves it rather than the brief
- `references/captures.md` — recording and using vendor stream captures
- `references/tripwires.md` — declaring scope tripwires; detectors and what they
  newly flag
- `references/tooling.md` — running the suite, ANSI, scratch archives, timeouts
- `references/absence.md` — absent vs zero, and pinning it
- `references/affordances.md` — expressing malformed and hostile inputs before testing their guards
- `references/citations.md` — content-pinned prose citations and symbol-named cross-file comments
