# ADR-043 — Worktrees are the isolation; a fence is never a lock

**Status:** ratified 2026-09-12 · **Issue:** #970 · **Owner:** operator

## Decision

**A fence is a lane's own write surface — the input to its scope gate and its
brief. It is not a lock on other lanes.** Two lanes may write the same file at
the same time from their own worktrees. Collision is resolved where git resolves
it: at the lane's `rebase` stage, and at merge.

The dispatcher therefore stops refusing on overlap. `sibling-leak`,
`cross-batch-collision`, `external-fence-stale` and `external-fence-abandoned`
are retired, together with the external-fence register entries and the live-claim
census that fed them. `lane_fence` is written empty, so the driver's sibling-deny
is vacuous without a driver change.

## Grounds, measured

- Over 262 lanes the collision half of the fence prevented **one** rebase conflict
  (b379, one hunk). In the same window at least four lanes died to fences that
  were too narrow and none to fences that were too wide (#970, 2026-09-06).
- The cross-batch refusal could never fire for a single-lane register:
  `claimFor` carries no files, and a live lane's surface is reconstructed only
  from *other* lanes' `lane_fence` entries. A probe on 2026-09-12 — a second
  single-lane register claiming the identical two files a live lane held —
  dispatched with `refusals=none`. The "factory mutex" on `crew/drive.mjs` was
  operator doctrine, not the dispatcher. Three lanes ran on that file the same
  hour once the doctrine was dropped.
- Git worktrees exist for exactly this: independent checkouts of one repository,
  each on its own branch. The runtime already cuts one per lane.

## What stays

- The **scope gate** — it adjudicates what a lane actually wrote against its own
  fence, on evidence. Unchanged.
- **Test-reach, anchor-pin and census admission** — they widen a lane's *own*
  fence so the tests that assert its change are inside it (#702). Unchanged.
- **`brief-too-large`, `coupled-source-unfenced`, `stale-read-ack`, `missing-path`**
  and every other refusal about the lane's own register. Unchanged.

## What this makes certain, and the remedy

- **#1021.** The later of two same-file lanes always rebases onto a moved base and
  publishes a proof measured before the rebase. This ADR turns that from a hazard
  into a certainty; #1021 is the next `crew/drive.mjs` lane.
- **Anchor manifests conflict at rebase** whenever two lanes shift pins in the same
  `anchors.json`. The lane escalates `rebase`; the operator runs
  `node skills/qa-test-writing/anchor-pin.mjs --repair-all` on main and republishes.
  Mechanical. The rate under this regime is unmeasured until the first three
  concurrent drive.mjs lanes land.

## Supersedes

ADR-041 (claims at plan-accept) is withdrawn as proposed: no claim is needed when
nothing is locked. ADR-040's remaining sibling rules are moot. The
"factory mutex" reasoning around `crew/drive.mjs` in ADR-042 Amendment 4 is
withdrawn; its file-size grounds stand.
