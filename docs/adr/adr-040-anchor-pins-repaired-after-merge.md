# ADR-040 — Anchor pins are repaired after the merge, not inside the lane

**Status:** ratified 2026-09-04 · **Issue:** #882 · **Owner:** operator

## Decision

Anchor-pin repair moves to a post-merge `--repair-all` pass on `main`. Pinning
manifests and citation carriers leave lane fences: a lane may change the code it
owns without conscripting every manifest and document that mentions that code.
A shift is still detected and reported everywhere it was before; only WHERE it
is repaired moves. The operator runs the repair after the wave merges, on `main`,
where the merged tree is the tree the line numbers describe.

## Grounds, measured

Issue #882 measured **29 pins across all six manifests**. The transitive
conscription is concrete: six manifests pin `crew.mjs`, `seat-io.mjs`,
`daemon.mjs`, `arms.mjs`, `ledger.mjs`, `make-brief.mjs`, `dispatch-batch.mjs`,
`drive.test.mjs`. A line edit in one of those files therefore recruits manifests
and the prose carriers of their keys, even when the lane changes no production
module.

| observation | measurement |
|---|---|
| pin corpus | 29 pins across six manifests |
| concurrent work | eleven issues landed with never more than two lanes running at once on 2026-09-02/03 |
| pre-merge repair | every shifted key required the lane to fence its manifest and its carriers |

The fence itself is an exhibit of the cost this decision removes: this lane's own fence grew from 16 files to 22 across four manifests and six documents and still missed skills/crew-recovery/references/closeout.md. The operator authored
16 paths; the dispatcher's own anchor-pin and citation-carrier warnings grew it
to 22, and the one it still missed was a live operator procedure that
contradicted this decision. That miss cost a full plan escalation (b410). A lane
that changes NO production module paid all of it.

## Alternatives — costed and deferred, not rejected

**Direction 2 — one generated pin index.** Generate one index instead of keeping
six independent manifests. This rewrites every manifest's format plus every test
that reads them — `crew/drive.test.mjs`, `crew/daemon.test.mjs`,
`test/factory-ledger.test.mjs`, `test/factory-dispatch-batch.test.mjs` and five
exhibits suites. The required fence is essentially the whole repository.

**Direction 3 — pin by content, not by line.** Replace line keys with content
identities. It has the same migration surface: every manifest format and every
reader above must change, along with the five exhibits suites. It removes line
drift but does not make that migration dispatchable while the current fence
mutex is in force.

**Direction 1 — repair after merge** makes both alternatives CHEAP later. Once
manifests are out of fences, the lane that reformats them is no longer exclusive.
That sequencing is the ground for choosing direction 1 first: the measured
concurrency cost is removed without pretending either deeper format change is
free.

## Accepted cost — superseded by Amendment 1

In the window **between the merge and the post-merge repair**, `main`'s manifest
keys and prose citations carry stale line numbers: a reader who follows one
lands on the wrong line. Nothing goes RED — on `main` the lane fence is empty,
so every shift is a warning — which also means the repair is not forced by CI.
An operator who skips the pass leaves the drift standing until the next one.
That is the price of the concurrency, and it is accepted because the alternative
was serialising unrelated lanes behind a transitive documentation fence.

## Amendment 1 (2026-09-19) — an owed-here shift is fatal on the default branch

The Accepted cost above is superseded in one clause. **"Nothing goes RED" was
already false when this ADR was ratified, and it is no longer the rule.**

An out-of-fence shift is **fatal** when the lane fence is MEASURED and EMPTY —
which is the default branch, where `laneFence` finds no changed paths, so there
is no lane to defer the repair to. Everywhere else it stays a warning: inside a
lane, whose fence is non-empty; and on an UNMEASURED fence, which is a stated
blind spot rather than a clear.

**Grounds, measured 2026-09-19.** Three call sites already applied this rule by
hand and were never reconciled with the Accepted cost —
`crew/drive-docs.test.mjs:574`, `skills/crew-dispatch/exhibits.test.mjs:99` and
`crew/drive-review.test.mjs:3919`. The contradiction was not theoretical: on
2026-09-19 `main` was RED on `crew/drive-review.test.mjs` `b600 N1` with six
shifted pins in `skills/pr-review/anchors.json`. Before that, 13 pins across
`skills/crew-recovery` and `skills/backend-node` were stale on `main` while
`npm test` reported 5746 pass / 0 fail — the largest, `crew/drive.mjs:8101`, by
453 lines. The warning printed to stderr inside a green suite, where nobody
reads it, and the operator pass the Accepted cost relies on was simply not run.

`assertAnchorsPinned` now consults `shiftsAreOwedHere` on the measured branch,
so the rule that governed 3 manifests governs 7 — adding `skills/crew-recovery`,
`skills/devops`, `skills/backend-node` and `skills/lean-build`.

**What does NOT change.** The concurrency argument is untouched: a lane still
never repairs a pinning manifest outside its own fence, and `--repair-all` on
`main` after the wave remains the sanctioned fix. Only the claim that CI does
not force it moves. The cost that replaces it is honest and smaller: the repair
is now owed at a named moment — the first suite run on `main` after a merge —
instead of being owed to nobody in particular.

**Blind spot, stated.** An explicit `fence` array passed by a caller is a
DECLARATION, not a git measurement, so an explicit `[]` keeps the warning. A
caller that declares an empty surface is not thereby standing on `main`, and no
check here can tell the difference.

## What does not move

- Rot and ambiguity stay fatal in each skill's own `exhibits.test.mjs`.
- The manifest/prose bijection stays fatal; a citation without its manifest key
  is still a failure.
- Plain `--repair` in a lane keeps working unchanged for an owned manifest.
- The b384 fail-closed behaviour survives for a lane that has changed the
  manifest itself: a shift in a manifest that lane owns is still fatal until
  repaired.
- The shift scan still reports external drift, and `--repair-all` rewrites a
  pinned document and its manifest key together on the merged tree.

## Residual

Ownership is **MEASURED, not declared**. No suite can see a lane's DECLARED
`files_in_scope`, so "this lane owns the manifest" is operationalized as "this
lane has CHANGED the manifest". A lane that declares a manifest it never touches
is now warned where it was once failed; that divergence IS the obligation this
decision removes. A lane that changes the manifest still owns its consistency
obligation and still receives the hard in-fence result.

The funded `skills/crew-recovery/references/closeout.md` procedure is not a
residual: this lane fences it and rewrites its contradictory in-lane instruction
under this decision. The post-merge command remains an operator action, so the
residual is operational discipline after merge, not a hidden scope requirement
inside a lane.
