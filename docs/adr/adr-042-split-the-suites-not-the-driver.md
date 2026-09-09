# ADR-042 — Split the test suites, not the driver

**Status:** ratified 2026-09-08 · **superseded in part 2026-09-09, see Amendments 3 and 4 — the park is LIFTED and the source order is aimed at the queue** · **Issue:** #1033 · **Owner:** operator

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

## Amendment 2 — 2026-09-09: the suite splits are PARKED, and one ground is refuted

**Owner's decision, 2026-09-09: park #1062, #1063 and #1064.** The decision NOT to split
`crew/drive.mjs` stands and is unchanged. What is withdrawn is the positive case for
splitting the three suites.

### The gate-cost ground was never measured, and it is false

This ADR reasoned from lines and cross-cluster edges. Neither is what a big suite costs.
Measured 2026-09-09 at `92c85d6`, `/usr/bin/time` on `node --test <file>`:

| suite | lines | runtime | tests | s/test |
|---|---|---|---|---|
| `test/factory-make-brief.test.mjs` | 3,126 | **32.7 s** | 150 | **0.218** |
| `test/factory-ledger.test.mjs` | 7,388 | 13.4 s | 342 | 0.039 |
| `crew/crew.test.mjs` | **7,721** | 9.5 s | 355 | 0.027 |
| `test/factory-dispatch-batch.test.mjs` | 6,146 | 6.9 s | 278 | 0.025 |

**Runtime does not track size.** The smallest of the four is the slowest, by 8x per test,
and it is a file this ADR does not target. `b562-fenceregister`'s acceptance gate cost
**33.5 s** and was essentially all `make-brief.test.mjs`; splitting the three suites named
here would have saved approximately none of it. Per-test cost, not file size, is the
lever — raised as its own issue.

### #1061 delivered the relief this ADR was deferring to

The original text says the whole ADR sits behind #1061 because sub-file scopes buy the
same contention relief without moving a line. **#1061 landed 2026-09-08** (#1076 wave 1,
#1077 wave 2): a fence entry may now name `path:START-END` in base-commit coordinates, so
two lanes hold disjoint spans of `crew/crew.test.mjs` today. The scheduling argument is
spent by its own terms.

### The migration risk grew while the ADR waited

Re-measured 2026-09-09 with the same `seams.mjs`:

| suite | ADR table | now |
|---|---|---|
| `test/factory-ledger.test.mjs` | 12 clusters, 9 edges | 14 clusters, **2** edges |
| `test/factory-dispatch-batch.test.mjs` | 101 clusters, 112 edges | **116 clusters, 122 edges** |
| `crew/crew.test.mjs` | 134 clusters, 177 edges | **137 clusters, 185 edges** |

`test/factory-ledger.test.mjs` also carries **342 tests against 20 symbols in 14
clusters**, which confirms Amendment 1's refusal to authorise #1062: a symbol-clustered
report cannot say where to cut a suite whose tests are mostly symbol-less.

### What still stands, and where the cost actually goes

#1033's premise is unrefuted: **size costs the builder turns**, and on b530 the
most-touched file was the TEST file. But the instrument aimed at that is #1069's skeleton
read, not a split — a builder handed a 700-line module still reads it, while a skeleton
read collapses a 7,700-line one. #1069 is unblocked as of #1077 and carries the
measurement (#1027 ask 5) that would justify either.

**Re-open the splits only on new evidence**, specifically: a measured builder-turn saving
attributable to suite size after #1055 and #1069 land, or a verb-level scan that makes
`test/factory-ledger.test.mjs` cuttable.

## Amendment 3 — 2026-09-09: the owner lifts the park; the splits proceed

**Owner's decision, 2026-09-09: split the files. Amendment 2's park of #1062,
#1063 and #1064 is WITHDRAWN**, and the decision recorded above not to split
`crew/drive.mjs` is **superseded** — see "the source files" below for the form
that takes.

This amendment does not claim new evidence for the splits. Amendment 2's
refutations stand on their own terms: gate cost does not track file size, and
`seams.mjs` measures how *cheap* a cut is, never how *right*. The owner's
standing direction recorded at ratification — *every large file should become
modules with proper boundaries* — is the basis, and it was always the senior
authority over a snapshot measurement. What follows is sequencing, not a case.

### Re-measured at `3faa3ff`, because the corpus moved

The ADR table above was taken at `d8a201b`. One day later:

| file | ADR table | at `3faa3ff` | test blocks | largest cluster |
|---|---|---|---|---|
| `crew/crew.test.mjs` | 134 clusters, 177 edges | **138 clusters, 185 edges** | 358 | 82 (23%) |
| `test/factory-dispatch-batch.test.mjs` | 101 clusters, 112 edges | **118 clusters, 123 edges** | 290 | 65 (22%) |
| `test/factory-ledger.test.mjs` | 12 clusters, 9 edges | **14 clusters, 2 edges** | 342 | **319 (93%)** |
| `crew/drive.mjs` | 30 clusters, 9,634 edges | **32 clusters, 9,641 edges** | — | — |

`crew/drive.mjs` also went from 7,522 to **8,257** lines in that day. **A
`seams.mjs` row has roughly a one-day shelf life at this repo's rate**, so every
split lane below re-runs the report against its own base commit and cuts on
*that*, never on a number quoted from this document.

### The suites: two go now, one is blocked by its instrument

1. **`test/factory-dispatch-batch.test.mjs`** (#1063) — FIRST, as the exhibit.
   118 clusters, 123 edges, no cluster over 22% of the file.
2. **`crew/crew.test.mjs`** (#1064) — 138 clusters, 185 edges, largest 23%.

**`test/factory-ledger.test.mjs` (#1062) still cannot be cut on this report, and
that is an instrument limit rather than a preference.** 319 of its 342 test
blocks fall in ONE symbol-less cluster; cutting on clusters yields thirteen
1-to-9-test files beside a ~7,000-line remainder, which is not a split. Amendment
1 refused it on exactly this ground and the re-measurement confirms it unchanged.
**The precondition is a verb-level scan** — group each test by which ledger verb
or `WRITERS` entry it drives — filed as its own instrument lane. #1062 is
unparked but stays blocked on that scan, and is not dispatched against a report
its own instrument cannot satisfy.

**Both suite lanes run in a quiet window, one at a time.** These files sit in
nearly every crew-adjacent fence: at the time of writing, `crew/crew.test.mjs`
is reached by both live lanes and the other two by `b575-scopetypo`. A split
lane must not race a lane that reaches the file it is dividing.

The proof obligation from the original text is unchanged and is the thing that
makes a split safe: **every test name and every assertion is preserved
byte-for-byte, and the lane's own gate is that the union of the new files runs
the same test count with the same pass/fail as the file it replaced.** A split
that renames or rewrites a test is refused — that is a different change wearing
this one's clothes.

### The source files: boundaries are created, then the file is divided

The measurement that produced "do not split `crew/drive.mjs`" is not withdrawn —
32 clusters at 9,641 cross-cluster edges is one module with a wide interface, and
a *mechanical* division along those clusters would cut live coupling and leave
layers that forward arguments. That failure mode is why this ADR said no, and
lifting the park does not make it stop being true.

**So the source files are split in two acts, not one.** For each candidate, a
lane first *creates* the narrow interface — designs it, moves the decisions
behind it, proves the seam with the suite green — and only then is the file
divided along the seam it now has. The design is authored in the lane's plan
phase and judged by the reviewer; it does not need a separate ADR round per
file, and this amendment is the authority that would otherwise be sought.

Order, by edges per cluster ascending — cheapest real seam first:

| file | lines | clusters | edges | notes |
|---|---|---|---|---|
| `scripts/factory/dispatch-batch.mjs` | 3,739 | 7 | 762 | not on the floor, no pins |
| `crew/seat-io.mjs` | 3,814 | 29 | 873 | not on the floor |
| `scripts/factory/ledger.mjs` | 7,698 | 24 | 902 | 6 pins, 16 tests reaching |
| `crew/crew.mjs` | 3,240 | 16 | 2,751 | boot surface |
| `crew/drive.mjs` | 8,257 | 32 | **9,641** | **LAST**: 28 pins across 6 manifests, 12 reaching tests, protected floor |

`crew/drive.mjs` goes last and not first, despite being the file the queue is
behind. Its `runTask` spans `:2944-6928` — 3,985 lines under ONE top-level
declaration — so it is the hardest interface to design, and it is the only
candidate whose migration runs as a judge lane against the file it is migrating.
The four files above it are where the technique is proven at lower cost.

### What is still true and should not be forgotten

- **A split does not relieve the eight-issue `crew/drive.mjs` queue by itself**;
  #1061 measured that those issues converge on `runTask` regardless of file
  boundaries. Relief comes from the interfaces, not from the division.
- **Nothing here predicts a builder-turn saving.** #1059's holdout is still
  unbuilt, so the benefit remains unmeasured in both directions. The basis for
  this amendment is the owner's design standard, and it should be cited as that
  rather than as a measured payoff.

## Amendment 4 — 2026-09-09: the source order is aimed at the queue, not at the cheapest seam

**Owner's decision 2026-09-09.** Amendment 3 ordered the source files by edges per
cluster ascending — cheapest real seam first. That order de-risks the technique
correctly and **delivers the throughput payoff last**, because the four files
ahead of `crew/drive.mjs` are not where the queue jams. This amendment keeps one
cheap exhibit and then aims at the queue.

### Measured: which files actually gate the open board

Over the **54 open non-meta issues** at `da33ea5` — every open issue except the
split issues, the fence-scope issue, the size census, the epics and the durable
audit indexes, which name files as subject matter without needing to write them:

| file | open issues gated |
|---|---|
| **`crew/drive.mjs`** | **19** |
| `crew/crew.mjs` | 9 |
| `scripts/factory/dispatch-batch.mjs` | 5 |
| `crew/seat-io.mjs` | 5 |
| `scripts/factory/ledger.mjs` | 4 |
| `crew/crew.test.mjs` | 3 |
| `test/factory-dispatch-batch.test.mjs` | ≤2 |

**`crew/drive.mjs` gates 35% of the open board by itself.** The two suites this
ADR splits gate five issues between them.

### Consequence 1 — the suite splits are not a throughput measure, and must not be sold as one

They remain worth doing, for reasons this ADR already records: a smaller file for
the builder to read, smaller briefs, fewer reach-exhibit collisions. **They are
not a parallelism unlock.** #1061's span fences already let two lanes hold
disjoint spans of `crew/crew.test.mjs` today, so part of even those three issues
is relief already delivered. Anyone citing the suite splits as the fix for batch
size is citing the wrong thing.

### Consequence 2 — the unlock is act 1, and it arrives before any file is divided

The 19 issues converge on `runTask` (`crew/drive.mjs:2944-6928`, 3,985 lines under
ONE top-level declaration), which is why one span per file means one lane. **Once
those decisions live behind narrow interfaces, span fences begin to work on the
file** and several lanes can hold disjoint pieces of it — *before* the file is
ever divided.

So the throughput payoff is the deliverable of **act 1**, not act 2. A `drive.mjs`
act-1 lane that creates and proves the interfaces, and divides nothing, has
already bought the unlock. Act 2 may follow at leisure.

### The revised source order

1. **`scripts/factory/dispatch-batch.mjs` act 1 — the technique exhibit.** 7
   clusters, 762 edges, not on the floor, 3 tests reaching. The smallest and
   lowest-risk place to establish what an act-1 lane produces: the interface
   designed in the plan phase, the decisions moved behind it, the suite green,
   and the file still one file.
2. **`crew/drive.mjs` act 1 — the unlock.** Straight here once the method is
   proven. It stays the hardest interface to design and is still the only
   candidate on the protected floor, so it still runs as a judge lane; what
   changes is that it no longer waits behind three files that gate nothing.
3. **`crew/seat-io.mjs`, `scripts/factory/ledger.mjs`, `crew/crew.mjs` — after.**
   They gate 18 issues between them and are worth doing; they are not worth doing
   first.
4. **Act 2 (the division) for any file — last, and only on evidence.** Once act 1
   has landed on a file, re-measure before dividing it: `seams.mjs` against the
   post-interface file is a different report from the one that motivated the work.

Amendment 3's two-act rule is unchanged and is what makes this safe: a mechanical
division along 9,641 cross-cluster edges would still produce layers that forward
arguments. Nothing here authorises skipping act 1.

### Blind spot

**The issue-to-file mapping is a static scan of issue bodies**, so it counts a
file an issue merely *cites* the same as one it must write, and it misses a file
an issue needs but never names. It is a ranking, not a fence plan; the five and
nineteen are the same instrument, so the comparison holds even where the absolute
counts do not. The suite-split relief figure (three issues) is the one most
likely to be understated, since a suite is often unnamed in a body that will
still need it.

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
