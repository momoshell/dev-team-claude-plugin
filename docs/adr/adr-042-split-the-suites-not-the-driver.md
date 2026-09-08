# ADR-042 — Split the test suites, not the driver

**Status:** ratified 2026-09-08 · **Issue:** #1033 · **Owner:** operator

## Decision

**`crew/drive.mjs` is not split.** The three largest test suites are, one lane
each: `crew/crew.test.mjs`, `test/factory-ledger.test.mjs` and
`test/factory-dispatch-batch.test.mjs`.

The question #1033 asked was whether file size is worth paying an ADR-sized
migration to reduce. Measured, the answer differs by two orders of magnitude
between the source files and the suites, and it does not favour the file
everybody assumed.

## Grounds, measured

`scripts/factory/seams.mjs` (#1037, merged as #1044) clusters a file's exported
symbols by which other tracked files import them, and reports cross-cluster
edges — high edges mean a split cuts through live coupling. Run at `d8a201b`
over **302 tracked files scanned** per row, `skipped: []` throughout:

| file | lines | kind | clusters | cross-cluster edges | edges/cluster | anchor pins | tests reaching | floor |
|---|---|---|---|---|---|---|---|---|
| `crew/drive.mjs` | 7,522 | source | 30 | **9,634** | **321.1** | 28 across 6 manifests | 12 | **yes** |
| `scripts/factory/ledger.mjs` | 7,160 | source | 24 | 783 | 32.6 | 6 | 16 | no |
| `crew/seat-io.mjs` | 3,815 | source | 29 | 873 | 30.1 | — | — | no |
| `scripts/factory/dispatch-batch.mjs` | 3,452 | source | 7 | 671 | 95.9 | — | — | no |
| `crew/crew.test.mjs` | 7,347 | test | 134 | **177** | **1.3** | 0 | 0 | no |
| `test/factory-dispatch-batch.test.mjs` | 5,418 | test | 101 | 112 | **1.1** | 0 | 0 | no |
| `test/factory-ledger.test.mjs` | 6,991 | test | 12 | **9** | **0.3** | 3 | 0 | no |

`crew/crew.test.mjs` is **175 lines smaller** than `crew/drive.mjs` and
**247× less coupled per cluster**. It carries **zero** anchor pins and **zero**
tests reaching it, and it is not on the protected floor. `drive.mjs` is the
opposite on every axis.

**The cost is real and it is the builder's.** #1027 measured b533's builder
fetching **4,730 distinct lines of `drive.mjs` against 148 its plan cited**, in
35 paged reads. Builder turns tracked primary-file size: 99, 151, 130 on the
big-file lanes against 40 on the smallest. But **on b530 the most-touched file
in the lane was the TEST file** (78 reads of
`test/factory-dispatch-batch.test.mjs` against 48 of the source), so framing
size as a source-file problem was wrong from the start.

## Why not `drive.mjs`

Splitting it cuts 9,634 cross-cluster edges, moves 28 pins across six
manifests, re-fences 12 reaching tests, and changes the protected-floor list —
and the floor is what forces `--tier judge`, so the migration would run as a
judge lane against the file it is migrating.

OpenHands' review guide, read alongside the measurement, says the same thing
from the other direction:

> Treat "deep module" as a design heuristic, not a line-count target. **Do not
> split a file merely because it is long**, and do not create layers that only
> rename or forward arguments.

30 clusters at 321 edges each is not a set of deep modules waiting to be
separated; it is one module with a wide interface. The honest reading of our
own instrument is that the seams are not there.

**What reduces the builder's cost on `drive.mjs` instead** is the turn-economy
set, which is already landing and does not touch its structure: #1036 (the
plan's cited ranges are the working set, merged), #1041 (a fenced test run costs
zero turns, merged), #1060 (the read gate, in flight), #1028 (a builder ceiling
from the post-fix distribution, unbuilt).

## Why the suites, and how

A suite has no importers beyond its own helpers. That is why its edge counts are
near zero and why the blast radius is small: **no production import changes, no
anchor manifest moves for two of the three, and no `allow_test_reach` decision
changes** — the split files inherit the reach of the file they came from.

One lane per suite, in a quiet window, because these files appear in nearly
every crew-adjacent fence and a split lane must not race one:

1. **`test/factory-dispatch-batch.test.mjs`** — 101 clusters, 112 edges, 0 pins.
   Do it FIRST as the exhibit.
2. **`crew/crew.test.mjs`** — 134 clusters, 177 edges, 0 pins.
3. **`test/factory-ledger.test.mjs`** — 12 clusters, 9 edges, 3 pins. LAST, and
   only after a verb-level scan: see the ordering amendment below.

Each split preserves every test name and every assertion byte-for-byte; the
lane's own proof is that the union of the new files runs the same test count
with the same pass/fail as the file it replaced. A split that renames or
rewrites a test is refused — that is a different change wearing this one's
clothes.

## Unblocking was evaluated separately, and it is not what a split buys

Ratification added this section, because "which split is cheap" and "what is
blocking us" are different questions and the first does not answer the second.

Measured across the **18 lanes dispatched on 2026-09-08** (r78–r86), the most
contended files are `crew/crew.mjs`, `crew/crew.test.mjs`,
`scripts/factory/dispatch-batch.mjs`, `test/factory-dispatch-batch.test.mjs`,
`scripts/factory/ledger.mjs` and `test/factory-ledger.test.mjs` — **four
distinct lanes each**. `crew/drive.mjs` was held by three. So the suite splits
above do relieve three of the six worst, which is real and is part of why they
are worth doing.

But `crew/drive.mjs` is where the **queue** is: **#1051, #1021, #1003, #931,
#905, #903, #879 and #877 — eight issues — all need that one file**, and one
lane may hold it. #1051 alone costs every judge lane ~27 minutes.

**A split is not the cheapest way to unblock that.** The mutex is a dispatcher
property: `scopeMatcher` (`crew/drive.mjs:2087-2090`) is `path === entry` or a
directory prefix, so a fence cannot say *"this lane owns `enforceTurnCeiling`"*.
**#1061** proposes sub-file scopes over the clusters `seams.mjs` already emits,
which would unlock much of that queue at no migration cost — the same move
ADR-040 made when it dissolved the anchor-manifest mutex by changing the rule
rather than the code. #1061 is sequenced **ahead** of any `drive.mjs` structural
work.

## The owner's standing direction, recorded

The owner's position at ratification: **every large file should become modules
with proper boundaries.** This ADR does not contradict that and must not be
cited as a permanent verdict on `crew/drive.mjs`.

What it says is narrower and worth keeping straight: **`crew/drive.mjs` has no
clean seams to find today.** 30 clusters at 321 cross-cluster edges each is one
module with a wide interface, so a *split* — moving existing code across new
file boundaries — would cut through live coupling and produce layers that
forward arguments, which is the failure OpenHands' guide names.

Giving it proper boundaries is therefore a **refactor, not a split**: the
boundaries have to be *created* — narrow interfaces designed, decisions moved
behind them — before any file division is safe. That is a larger act than this
ADR decides, it wants its own ADR, and it should follow #1061 rather than block
on it. Recorded here so a later reader does not mistake "not now" for "not
ever".

## Amendment 2026-09-08 — differentiated-first, not cheapest-first

**The original ordering was wrong and this corrects it.** It ranked the suites by
cross-cluster edge count, which measures how *safe* a split is — not whether the
cluster report can tell you *where to cut*. Those are different questions and the
first does not answer the second.

Measured on `test/factory-ledger.test.mjs`, the file this ADR originally named
first:

```
[13] blocks=319  symbols=[]                    <- 319 of the suite's 342 tests
[6]  blocks=9    symbols=[escalationCause]
[3]  blocks=3    symbols=[CELL_RATE_FLOOR]
[0,1,2,4,5,7,8,9,10,11,12]  blocks=1 each
```

**319 of 342 top-level tests fall into one symbol-less cluster.** Cutting on
clusters yields thirteen 1-to-9-test files plus a ~6,000-line remainder, which is
not a split. The file carries 2 `// ---` section comments for 342 tests, so there
is no fallback structure either. Its 9 edges still say a split would be *cheap*;
they say nothing about where the seams are, because these tests reach the ledger
through the same handful of writers rather than through distinct exports.

`test/factory-dispatch-batch.test.mjs` (101 clusters over 5,418 lines) and
`crew/crew.test.mjs` (134 over 7,347) have genuinely differentiated
distributions, so their reports *can* guide a cut. They go first.

**`test/factory-ledger.test.mjs` needs a different basis before it is dispatched
at all** — a scan that groups its tests by which ledger verb or `WRITERS` entry
each one drives, which `seams.mjs` does not do today. Until that exists, this ADR
does not authorise splitting it, and #1062 stays blocked rather than being
dispatched against an instruction its own instrument cannot satisfy.

**Priority: this whole ADR sits behind #1061.** The suite splits' main benefit is
fence-contention relief — measured, three of the six most contended files. #1061
(sub-file fences over the clusters `seams.mjs` already emits) delivers the same
relief without moving a line, and it also unblocks the eight-issue `crew/drive.mjs`
queue that no split touches. Do #1061 first; these are worth doing after, and are
not urgent.

## What this deliberately does not do

- It does not reduce `crew/drive.mjs`. That file stays 7,522 lines and stays on
  the floor. Its builder cost is attacked by the turn economy, and its
  concurrency cost by #1061, not by structure.
- It does not set a line-count target. No file is split because it crossed a
  threshold; the three named files are split because their measured seams are
  clean.
- It does not touch `scripts/factory/ledger.mjs` (7,160 lines, 32.6 edges per
  cluster, 16 tests reaching). It is the next candidate worth measuring again
  after the suites land, not a decision taken here.

## Blind spots stated

- **The seam report is a static import graph, and it says so in its own
  output**: `crew/crew.mjs` loads adapters by computed path, so a real edge can
  be invisible; an unused import is a phantom edge. Clean clusters mean a
  **cheap** split, never a **right** one.
- **The benefit to the builder is unmeasured.** Nothing here predicts a turn
  reduction from splitting a suite. #1059's holdout is the instrument that could
  test it and is not built; until then, the claim is only that the split is
  cheap, not that it pays.
- Whether three files or thirty is the right granularity per suite is not
  decided here. The lane proposes its own cut from the cluster report and the
  reviewer judges it.
