# b152-reviewmine — findings register

Read-only recon over `~/.dev-team/factory/ledger.db`, `~/.dev-team/factory/ledger.jsonl`,
and the reviewer ReturnEnvelopes preserved under `~/.crew`. Nothing in the checkout was
changed; the ledger was opened `readOnly: true` throughout.

Every claim below is marked **verified** (I ran the query and the number is reproducible
from the scripts in `task/queries/`) or **assumed** (inference, with the reason it is safe).
Every rate carries its denominator. Where the data cannot answer, the finding is the gap.

---

## F0 · Method, and what "the data" turns out to be

**verified.** Four corpora, not one. They are not interchangeable and the brief's question
lands in different ones:

| corpus | size | what it holds | can it name a finding's *kind*? |
|---|---|---|---|
| `ledger.db` `review_outcomes` | 274 rows | verdict + three integer counts | **no** |
| `ledger.jsonl` `recordReviewOutcome` | 278 records | byte-identical field set to the db row | **no** |
| `~/.crew/**/returns/d*.reviewer.json` | 339 files | `details.findings[]` with `severity`, `location`, `summary` | **yes** — 254 findings |
| `~/.crew/**/task/review*.md` | 562 files | reviewer prose (not mined here) | yes, unstructured |

Queries: `task/queries/q.mjs` (read-only helper), `rounds.mjs`, `extract-findings.mjs`,
`classify.mjs`, `discriminators.mjs`, `recurrence.mjs`, `yield.mjs`, `gate-review-gap.mjs`,
`drift-review.mjs`, `nonconverge.mjs`, `laneoverlap.mjs`. Node 26.5.1, `node:sqlite` builtin, no `node_modules`.

**verified.** I did **not** invoke `scripts/factory/ledger.mjs` for any readout. Its
`openLedger()` opens read-write and may migrate; the brief forbids that. Where a built-in
verb answered a question (`gate-review-gap`), I re-implemented its exact SQL read-only —
see F6.

**verified.** `sessions` holds 20,800 rows but only **194** have any `review_outcomes` row
(191 distinct `task_slug`). The other ~20.6k are short-lived tool sessions (max 5 per
`repo_slug`, each opening one `planning` phase). Any denominator drawn from `sessions`
without that filter is meaningless.

---

## Part 1 — What reviews actually catch

### F1 · The verdict distribution is binary and lopsided
**verified.** `select verdict, count(*) from review_outcomes group by verdict`
- `pass` **177 / 274** (64.6%)
- `changes-needed` **97 / 274** (35.4%)

There is no third verdict, and no row is null.

### F2 · `must_fix` is not independent evidence — it is the verdict restated
**verified.** 0/274 null on `must_fix`, `should_fix`, `consider` (memory's "0% null" is
confirmed). But cross-tabulating verdict against `must_fix`:

| verdict | must_fix=0 | 1 | 2 | 3 | 5 |
|---|---|---|---|---|---|
| `pass` | 177 | 0 | 0 | 0 | 0 |
| `changes-needed` | **1** | 72 | 20 | 3 | 1 |

`must_fix ≥ 1 ⟺ changes-needed` holds on **273 of 274 rows** (99.6%). The single exception
is row id 250 (lane `0f8e8cf2…`, 2026-08-22T08:01:16Z, `must_fix=0, should_fix=1`) — a
reviewer who bounced on a should-fix, which the charter (`crew/roles/reviewer.md:27`)
permits but does not describe.

**Consequence for a rubric:** counting must-fixes tells you nothing the verdict did not.
The only extra information in the column is *magnitude* (72 bounces carry exactly 1
must-fix; only 4 carry ≥3) and the `should_fix`/`consider` tails on passing reviews:
22 should-fix and 64 considers were raised across the 177 `pass` rows.

### F3 · A review is a first-round pass about two times in three
**verified**, ledger (`rounds.mjs`), 194 lanes ordered by `created_at` within `adw_id`:
- first review **pass: 126 / 194 (64.9%)**; **changes-needed: 68 / 194 (35.1%)**
- round 2: n=65, pass 42, changes-needed 23
- round 3: n=14, pass 8, changes-needed 6
- round 4: n=1, pass 1

Of the **68** lanes that bounced at round 1, **42 (61.8%)** passed at round 2.

**verified**, disk corpus (227 lanes with a verdict-bearing envelope): first-round bounce
**86 / 227 = 37.9%** — 2.8 points higher than the ledger.

**verified** (`laneoverlap.mjs`), the reason: the disk is a **strict superset**. All 191
ledger slugs carrying a review appear on disk; **36 disk slugs have no ledger review row at
all** (`crew-hygiene`, `plan-viewer`, `alloc`, `realio`, `herdr-spike`, `pi-spike`,
`headless-spike`, `168-slice1-measure`, … full list in `laneoverlap.mjs` output). Spot-checked
mtimes put these at 2026-08-13/14, **before `review_outcomes`' first row at
2026-08-14T23:15:59Z** — they predate the table. So the ledger's 194-lane view is not a
sample of the disk's 227; it is the disk minus everything reviewed before the table existed,
minus `b126-driftcheck` (F27). Use the ledger for anything from 08-15 onward and the disk
when you want the whole history.

### F4 · `pass` is absorbing in the ledger, but not on disk
**verified.** Ledger trajectories per lane: `P`=126, `CP`=42, `CC`=9, `CCP`=8, `CCC`=5,
`C`=3, `CCCP`=1. **No ledger lane has a `pass` followed by anything.**
Disk trajectories include `PCC`=2, `PC`=1, `CPP`=1, `CPCC`=1, `CPC`=1 — 6 lanes.
**assumed** (safe): those are repair/re-runs reusing the same workspace directory, since the
disk key is `workspace::lane` and cannot separate two runs of one slug. Do not read the disk
trajectory as "review reopened a pass".

**verified.** 19 of 227 disk lanes (8.4%) never reached a `pass` verdict at all.

### F5 · Half of all reviews catch nothing
**verified** (`yield.mjs`), over the 269 envelopes that carry a `details.findings` array:
- **140 (52%) carry an empty array** — the review produced no finding of any severity. All
  140 are `pass`.
- findings-per-review: 0→140, 1→63, 2→31, 3→21, 4→9, 5→2, 6→2, 8→1
- mean **0.94 findings per review**

### F6 · The measured value of review over the gate: 65 of 188 runs
**verified.** Re-implementation of `gateReviewGap()` (`scripts/factory/ledger.mjs:2547`),
run read-only in `gate-review-gap.mjs`:

> Of **188** runs that had at least one green non-pristine `gate_results` row **and** at
> least one review, **65 (34.6%)** had a review round with `must_fix > 0`.

The acceptance gate went green and the reviewer still found a must-fix in **one run in
three**. This is the strongest single justification in the data for the review seat
existing, and it is the number a rubric should be optimised against.

---

## Part 2 — What the bounces consist of

### F7 · The ledger cannot answer this, and the JSONL is not richer
**verified.** A `recordReviewOutcome` JSONL record carries exactly
`{adw_id, phase_id, dispatch_id, role, verdict, must_fix, should_fix, consider, created_at}`
— the same fields as the db row, no finding text. **The JSONL is not a fallback here.**
Sampled directly from `ledger.jsonl`; three consecutive records confirm the shape.

**verified.** `review_outcomes.role` is `reviewer` on all 274 rows; `dispatch_id` is the
driver's dispatch label (`d3`×125, `d5`×47, `d4`×30, `d6`×21, … `d15`×1), 0 null.

**This is the register's central structural finding.** No query over `ledger.db` or
`ledger.jsonl` can say what a review found. Anything ordering a rubric by defect kind must
be built from the ReturnEnvelope corpus.

### F8 · The envelope corpus, and its 32-envelope hole
**verified** (`extract-findings.mjs`). 339 `d*.reviewer.json` files, 0 unparseable,
228 distinct lanes.

- **269 / 339 (79%)** carry a `details.findings` array → **254 findings** extracted.
- **70 / 339 (21%)** carry **no** findings array. Their verdicts: 32 `pass`, 32
  `changes-needed`, 6 null.
- **Of those 70, 32 declared `must_fix > 0`.** Their findings exist only as prose in
  `review.md` and are absent from every machine-readable corpus.

So the machine-readable finding corpus covers **92 of 124 (74%)** of the disk's
`changes-needed` envelopes. This is a direct consequence of `crew/roles/reviewer.md:49`:
"`findings` is optional: omit it and the run behaves exactly as before."

**verified.** Severity spellings are consistent: `must-fix` 120, `should-fix` 51,
`consider` 83 — no variants, no nulls. The six null-verdict envelopes are all `status:
done` at late dispatches (d4/d5/d7) — **assumed** (safe): perspective or gate-triage
assignments, which the charter defines with a different `details` shape.

### F9 · Category × severity (mechanical classifier, crude — read the caveat)
**verified** (`classify.mjs`): deterministic regex classifier, fixed priority order, one
primary label per finding. n=254.

| primary category | must-fix | should-fix | consider | n | must-fix share |
|---|---|---|---|---|---|
| `degraded-path` | 10 | 0 | 3 | 13 | **77%** |
| `render-join` | 10 | 1 | 3 | 14 | **71%** |
| `lifecycle-clobber` | 20 | 4 | 8 | 32 | **63%** |
| `indeterminate-as-definite` | 30 | 8 | 12 | 50 | **60%** |
| `input-boundary` | 12 | 4 | 5 | 21 | 57% |
| `contract-literal` | 4 | 0 | 3 | 7 | 57% |
| `false-green` | 11 | 19 | 16 | 46 | **24%** |
| `out-of-plan` | 0 | 1 | 4 | 5 | **0%** |
| `stale-prose` | 0 | 6 | 12 | 18 | **0%** |
| *unclassified* | 23 | 8 | 17 | 48 | 48% |

**Caveat, stated plainly:** 94 of 254 findings match more than one category and 48 match
none. The single label hides real overlap. Treat the *ordering* as evidence and the
*absolute counts* as approximate — except the two 0% rows, which are exact (no
`stale-prose` or `out-of-plan` finding in the corpus is a must-fix; see F12 for the
independently-derived version).

The 48 unclassified are dominated by plain correctness defects — a specific untaken branch
producing a wrong observable — which is a shape, not a domain, and is captured properly by
F10.

### F10 · The strongest discriminator found: a finding written as a counterexample
**verified** (`discriminators.mjs`). One regex over the finding summary: does it open by
naming a concrete triggering state (`A …`, `An …`, `With …`, `When …`, `After …`,
`Passing/Omitting/Adding/Deleting/Calling/Replacing …`)?

| | n | must-fix | share |
|---|---|---|---|
| opens naming a triggering state | 129 | 95 | **74%** |
| does not | 125 | 25 | **20%** |

A 3.7× separation, the largest of any single test I ran. Every other discriminator:

| discriminator | YES n | YES must-fix | NO n | NO must-fix |
|---|---|---|---|---|
| indeterminate collapsed to definite | 44 | 57% | 210 | 45% |
| location is a test or gate file | 53 | 36% | 201 | 50% |
| cites the reviewer's own measurement | 21 | 33% | 233 | 48% |
| proves a mutation survives (false green) | 25 | 28% | 229 | 49% |
| names a plan divergence | 20 | 25% | 234 | 49% |
| **location is a doc/markdown file** | 16 | **0%** | 238 | 50% |
| **summary is about a comment/prose claim** | 7 | **0%** | 247 | 49% |
| **carried forward from a prior round** | 10 | **0%** | 244 | 49% |

**Confound, named:** severity and wording come from the *same author in the same envelope*.
This measures how a reviewer writes a finding they have already decided is a must-fix, not
an independent test of whether the finding was real. It is still actionable as a rubric
rule — "if you cannot state it as *state → wrong observable*, it is not a must-fix" — but
it is a correlation inside one judgement, not a validation of that judgement. See F28.

### F11 · Must-fix findings are the *shortest* — verbosity is not the confound
**verified** (`yield.mjs`), median / mean summary length in characters:
- `must-fix` (n=120): **143 / 158**
- `should-fix` (n=51): 284 / 257
- `consider` (n=83): 273 / 273

The counterexample-opening result in F10 is not a proxy for length: must-fix findings are
*half* the length of considers. A real defect states itself in one short sentence; a
consider takes a paragraph of hedging. **This is directly usable as a rubric rule and
mechanically checkable.**

### F12 · Prose, conformance and carry-forward findings never bounce a lane
**verified.** Three disjoint instruments, all zero:
- location is a `.md`/README file: **0 must-fix in 16** (4 should-fix, 12 consider)
- summary is about a stale comment/prose claim: **0 must-fix in 7**
- explicitly carried forward from a prior round: **0 must-fix in 10**
- classifier `stale-prose` + `out-of-plan`: **0 must-fix in 23**
- `docs/` + `docs/adr/`: **0 must-fix in 8**

`crew/roles/reviewer.md:14` instructs the seat that "Out-of-plan edits are findings even
when harmless." The data does not contradict that — those findings *are* produced (5
out-of-plan, 18 stale-prose) — but **not one of them has ever bounced a lane.** A rubric
ordering by yield puts this class last, not first.

### F13 · The class reviewers produce most is not the class that bounces
**verified.** `false-green` is the **largest** primary category (46 of 254, 18%) and the
largest by a wide margin in `should-fix` (19 of 51 = 37%). Its must-fix share is **24%** —
below the 47% corpus baseline. The narrower instrument (a summary explicitly proving a
mutation survives) gives 7 must-fix in 25 = **28%**, again below baseline.

Reading the 46: the reviewer proves a test is vacuous or a plan-required test is absent, and
then grades it *should-fix* because the shipped behaviour is correct — only the protection
is missing. That is a defensible grade, and it means "would these tests fail if the change
were broken?" (`crew/roles/reviewer.md:16`) reliably produces findings but rarely produces
a bounce.

### F14 · Where findings land (top-of-path), n≥4 only
**verified** (`yield.mjs`):

| path | n | must-fix | share |
|---|---|---|---|
| `visualizer/server` | 7 | 6 | 86% |
| `scripts/factory` | 40 | 31 | **78%** |
| `visualizer/web` | 21 | 16 | 76% |
| `crew` | 147 | 58 | 39% |
| `test` | 17 | 6 | 35% |
| `docs` | 4 | 0 | 0% |
| `docs/adr` | 4 | 0 | 0% |

**Confound, named:** this is not a defect-density map. `crew/` is where most lanes work, so
it dominates the denominator and dilutes; `scripts/factory` and `visualizer/*` lanes are
fewer and were reviewed by seats attacking CLI arg-parsing and rendering, which is where the
must-fix-shaped defects live. Read the ordering, not the rates.

### F15 · Lanes that never converged
**verified** (`nonconverge.mjs`). 19 of 227 disk lanes never reached a `pass`. They carry
54 findings, **38 (70%) must-fix** versus the 47% corpus baseline. Category mix:
`indeterminate-as-definite` 14, `lifecycle-clobber` 10, `render-join` 8, unclassified 7,
`false-green` 6, `input-boundary` 3, `degraded-path` 2, `out-of-plan` 2, `stale-prose` 2.

**Confound, named, and it is severe:** 6 of the 19 (`headless-spike`, `pi-spike`,
`herdr-spike`, `charter`, `realio`, `headless-io`) look like exploratory or early-runtime
lanes rather than normal build lanes. With n=19 and a third of it possibly a different
population, treat this as *consistent with* F9's ordering, not as independent support.

### F16 · Finding recurrence across rounds is confounded and should not be used
**verified** (`recurrence.mjs`). Of 85 findings that had a later round in the same lane to
compare against, 66 (78%) had their *file* named again in the next round: must-fix 36/47
(77%), should-fix 14/21 (67%), consider 16/17 (94%).

**This measures nothing useful.** A lane's scope is fixed, so the same files are reviewed
every round by construction. File-level recurrence cannot distinguish "not fixed" from
"reviewed again". Finding *ids* are per-round (`RV1-x`, `RV3-x`) and are minted fresh, so
they cannot be joined either. The only reliable carry-forward signal is the reviewer's own
prose marker — F12: 10 findings, 0 must-fix.

---

## Part 3 — What a gate discrimination failure looks like

### F17 · It has happened once in 220 rows, and it was not a gate defect
**verified.** `gate_discriminations`: **219 `proven`, 1 `unproven`.** The one unproven row
(id 54, `9037c981…`, 2026-08-16T15:37:25Z) is:

```
verdict: unproven   checks_total: NULL   checks_failed: NULL   checks_errored: NULL
note: "runClean: git stash push failed, refusing to judge a gate against the wrong tree:
       error: Entry 'src/greet.mjs' not uptodate. Cannot merge.
       Cannot save the current worktree state"
```

An **infrastructure refusal**, not a gate that failed to discriminate — and it carries NULL
in all three check-count columns, so even that one row does not record the shape of a
failure. `note` is non-null on exactly 1 of 220 rows.

**The honest answer to the brief's question: there is no recorded instance of a gate
discrimination failure on the merits. The table cannot show you one.**

### F18 · The 33 gate regenerations are invisible to that table
**verified.** 33 lanes have a `gate_generation = 2` discrimination row. Of those, **29 had
a gen-1 verdict of `proven`** and **4 have no gen-1 row at all**. **Zero** had a gen-1
`unproven`. All 33 gen-2 rows are `proven`.

So the thing that actually caused a gate to be rebuilt is recorded somewhere else. It is in
`gate_results`: the 4 lanes with no gen-1 discrimination row (`772d16ee`, `eca6556d`,
`d3acbaba`, `762944c2`) are exactly among the lanes with a red `gate:r1`/`gate:r2`.

### F19 · The proof that *does* fire is the per-check mutation proof
**verified**, `gate_results` by `gate_name` family (1,879 rows, 210 lanes):

| gate_name family | n | ok=1 | ok=0 |
|---|---|---|---|
| `gate-baseline` | 210 | **1** | **209 (99.5% correctly red)** |
| `gate-baseline:recheck` | 2 | 0 | 2 |
| `gate-proof:1` (rollup) | 187 | 0 | 187 |
| `gate-proof:1:checks:m*` | **1,102** | **9** | 1,093 |
| `gate:r1` | 203 | 196 | **7** |
| `gate:r2` | 71 | 66 | 5 |
| `gate:r3` | 25 | 25 | 0 |
| `gate:r4` | 13 | 13 | 0 |

Two numbers matter for a rubric:

1. **1,102 declared per-check mutations were machine-applied across 84 lanes; 9 survived**
   (0.8%). `ok=1` on a mutation proof means the gate stayed green under the mutation — the
   check failed to kill it. Those 9 (in lanes `a0e35cf2`, `1ca1ba45`×2, `c4d852a3`×2,
   `81ca3b88`, `1e170414`, `a8060a98`, `5e40778e`) are the only recorded instances of a
   *check* proven inadequate. This is where gate discrimination actually gets tested.
2. **`gate:r1` is green 196/203 = 96.6%.** The post-build acceptance gate catches something
   in 3.4% of first build rounds. Compare F3: review bounces **35%** of first rounds, and
   F6: the gate is green while review finds a must-fix in **34.6%** of runs.

**The gate is a floor; review is the filter.** Any rubric that assumes the gate has already
caught the mechanical defects is assuming something the data does not support.

### F20 · `gate_results` records no failure *kind* either
**verified.** `violations_json` is the literal string `[]` on **all 1,879 rows** — no
exceptions. `checks_json` is only ever a one-element array of counts, e.g.
`[{"total":34,"failed":2,"errored":0}]` (three distinct string lengths across the whole
table: 36, 37, 38 bytes). **Which check failed is recorded nowhere.**

---

## Part 4 — Do `modifier_attempts` show a pattern in what gets retried?

### F21 · Yes: 187 attempts produced 3 actual cell changes
**verified.** `modifier` × `outcome`:

| modifier | outcome | n |
|---|---|---|
| `failure-upgrade` | `transport` (refused) | **155** |
| `sensitivity-floor` | `applied` | 25 |
| `failure-upgrade` | `applied` | 3 |
| `failure-upgrade` | `spent` | 3 |
| `sensitivity-floor` | `transport` | 1 |

- **155 of 161 `failure-upgrade` attempts (96.3%) were refused** for one reason, verbatim on
  all 155 rows: *"a pane seat bakes model and effort into its launch command at boot
  (crew/crew.mjs:265); its reassign: true capability means give a settled seat NEW WORK,
  never change its cell."*
- `transport` breakdown: `pane` 181 rows / 156 refused; `headless-rpc` 5 / 0;
  `headless-json` 1 / 0. **The refusal is entirely a pane-transport property.**
- The 3 `spent` rows are budget exhaustion.

**verified.** The 25 `sensitivity-floor` `applied` rows are **all** `rung: judge→judge` with
`from_model = to_model = claude-opus-5`. The modifier applied and changed nothing, because
the reviewer cell was already at the floor — 15 of them say so in `why`: *"protected paths:
crew/drive.mjs — the reviewer cell is already the judge tier cell."*

**Net: 3 real cell changes in 187 attempts (1.6%)** — one `build→judge` planner upgrade
(`b19-pi-light-charters`) and two `model:gpt-5.6-luna→gpt-5.6-terra` builder upgrades
(`b19-shopfloor-ledger`, `b19-shopfloor-skeleton`), all on 2026-08-17.

### F22 · What gets retried is planning, then review
**verified.** `bounce` distribution across 187 rows: `plan` 86, `review` 68,
`plan-accept` 26, `build` 3, `gate` 2, `scope` 1, `lane` 1.
By `role`: `planner` 86, `builder` 75, `reviewer` 26.
Attempts per lane: 1→38 lanes, 2→29, 3→13, 4→6, 5→2, 6→3 (91 lanes total).

**A rubric-relevant reading:** the crew retries the *plan* more often than the *build*
(86 vs 3), and the review bounce (68) is the second-largest trigger. Build failures almost
never reach a modifier.

---

## Part 5 — The remaining tables

### F23 · `seat_teardowns` has zero discriminating power
**verified.** 569 rows. `outcome` = `proven` on all 569. `reason` = `probe-dead` on all 569.
`forced` = 0 on all 569. `evidence_kind` = NULL on all 569. By role: planner 142, lead 141,
builder 126, reviewer 125, tech-lead 35.

`SEAT_TEARDOWN_OUTCOMES` enumerates more than one value; exactly one has ever been written.
The table records that teardown happened, never how it went. **Any rubric rule about seat
teardown must stay judgement — this column cannot check it.**

### F24 · `accept_decisions` (n=8) contains an exact counter-example to its own schema
**verified.** All 8 rows, every recorded column:

| id | outcome | where_at | findings_total | residual | refuted | cosmetic | unverified | invalid_reasons |
|---|---|---|---|---|---|---|---|---|
| 1 | accepted | review-exhausted | 2 | 0 | 2 | 0 | 0 | (empty) |
| 2 | accepted | review-exhausted | 2 | 1 | 1 | 1 | 0 | (empty) |
| 3 | accepted | review-exhausted | **1** | **0** | **1** | **0** | **0** | (empty) |
| 4 | accepted | build-exhausted | 2 | 0 | 2 | 0 | 0 | (empty) |
| 5 | accepted | review-exhausted | 2 | 0 | 2 | 0 | 0 | (empty) |
| 6 | accepted | review-exhausted | **1** | **0** | **1** | **0** | **0** | (empty) |
| 7 | **escalated** | review-exhausted | **1** | **0** | **1** | **0** | **0** | (empty) |
| 8 | **escalated** | review-exhausted | **1** | **0** | **1** | **0** | **0** | (empty) |

Rows 3, 6, 7, 8 are **identical on every recorded column** and split 2 `accepted` /
2 `escalated`. The accept/escalate outcome is provably **not** a function of what the table
records. n=8 is far too small for a rate, but this is a counter-example, not a statistic —
it needs no n.

Also: `invalid_reasons` is empty on all 8 rows, and these 8 rows adjudicate **12 findings
in total, 11 of them `refuted`** (accepted rows: 10 findings, 9 refuted, 1 residual,
1 cosmetic; escalated rows: 2 findings, 2 refuted). Against a corpus of 120 must-fix
findings, the refutation record covers a tiny slice of the review history.

### F25 · `cell_failures` attribution is 100% null
**verified.** 21 rows. `attribution` NULL on **21 / 21** — `CELL_FAILURE_ATTRIBUTIONS` has
never been written. `stage` is NULL on 14 of 21. Kinds: `timeout` 8, `unusable-envelope`
(pane-parse-error) 5, `boot-refusal` 2, `seat-died` 2, `seat-not-ready` 2, `no-envelope`
(rpc) 1, `transport-error` (rpc-command-error) 1.

By cell: builder/pi/gpt-5.6-luna 8, planner/claude/claude-opus-5 5, planner/(null) 2,
reviewer/pi/gpt-5.6-terra 2, builder/pi/gpt-5.6-terra 1, lead/claude/claude-opus-5 1,
planner/claude/opus 1, planner/pi/gpt-5.6-sol 1.

**No cell-quality conclusion is drawn here, and none can be.** n=21, attribution 0% filled,
and the per-cell exposure denominators are not in this table. The brief forbids the
inference and the data would not support it anyway.

---

## Part 6 — Confounds, drift, and what the data cannot answer

### F26 · Review attribution: 64 of 274 rows carry an agent, 34 carry a provider
**verified.** On `review_outcomes`: `agent` NULL on **210/274**, `effort` NULL on 210,
`transport` NULL on 210, `provider` and `model_id` NULL on **240/274**.

By day, the fix is visible and matches memory's 08-20 date:

| date | rows | with agent | with provider |
|---|---|---|---|
| 08-14 … 08-19 | 185 | **0** | **0** |
| 08-20 | 30 | 5 | 5 |
| 08-21 | 33 | 33 | 13 |
| 08-22 | 26 | 26 | 16 |

**Any per-cell claim about reviews is confined to 64 rows (agent) or 34 rows (provider), all
from 2026-08-20 onward.** That is a different and much smaller population than the 274 rows
every other finding in this register is drawn from. I make no per-cell claim.

### F27 · JSONL → DB drift, measured per table
**verified** (`drift-review.mjs` and a full JSONL kind census):

| table | JSONL records | DB rows | delta |
|---|---|---|---|
| `sessions` | 20,894 | 20,800 | **94** |
| `phases` | 22,116 | 22,022 | **94** |
| `gate_results` | 1,891 | 1,879 | **12** |
| `review_outcomes` | **278** | **274** | **4** |
| `gate_discriminations` | 223 | 220 | 3 |
| `modifier_attempts` | 187 | 187 | 0 |
| `seat_teardowns` | 569 | 569 | 0 |
| `cell_failures` | 21 | 21 | 0 |
| `accept_decisions` | 8 | 8 | 0 |
| `events` | 6,856 | 6,856 | 0 |
| `intake_brakes` | 5 | 5 | 0 |

Total 207 records present in the JSONL and absent from the db. (The doctor readout's "188
keys" is a different unit — keys, not rows — so these numbers are not comparable and I do
not claim they are.) 104,982 JSONL lines, **0 unparseable**.

The 4 drifted review rows, identified exactly:

```
2026-08-15T09:54:18.848Z  d3  pass            mf=0  slug=193-queue
2026-08-21T23:18:56.634Z  d3  changes-needed  mf=1  slug=b126-driftcheck
2026-08-21T23:24:47.430Z  d5  changes-needed  mf=1  slug=b126-driftcheck
2026-08-21T23:33:14.102Z  d9  pass            mf=0  slug=b126-driftcheck
```

`b126-driftcheck` is missing **entirely** from `review_outcomes` — all three of its review
rounds. So the ledger's 194-lane view is short by at least one whole lane, and the
`must_fix ≥ 1 ⟺ changes-needed` invariant (F2) holds in the drifted rows too. The net effect
on F1/F3 is under one percentage point, but the drift is not random per-row noise — it drops
whole lanes.

### F28 · The deepest confound: there is no independent ground truth for "a real defect"
**This one limits every correlational claim in Part 2 and must be stated first in any rubric
that cites this register.**

The brief asks which findings correlate with a lane *actually bouncing*. In this system, the
bounce **is** the reviewer's verdict, and the verdict is a deterministic function of the same
reviewer's own must-fix grade (F2, 273/274). So:

- "Which findings correlate with a bounce" collapses to "which findings did the reviewer
  grade must-fix" — a single author's judgement, not an outcome.
- Nothing downstream ever re-adjudicates that grade at scale. `accept_decisions` is the only
  re-adjudication record and it has **8 rows** (F24).
- There is no post-merge defect record, no revert record, no incident log in the ledger. A
  must-fix that was wrong and a must-fix that was right look identical.

F10, F11, F12 and F13 are therefore claims about **what a must-fix grade looks like**, not
about **what catches real defects**. They are still the best available basis for ordering a
rubric — a class that has never once earned a must-fix in 254 findings is a weak rubric
rule regardless of the confound — but a rubric author must not present them as validated
defect-catching rates.

### F29 · Questions the data cannot answer — these must stay judgement
Each of these was attempted and failed on evidence, not effort:

1. **Which finding *kinds* the gate catches.** `violations_json` is `[]` on all 1,879 rows
   and `checks_json` holds counts only (F20). Unanswerable.
2. **What a gate discrimination failure looks like.** One row in 220, and it is an infra
   refusal with NULL counts (F17). Unanswerable.
3. **Whether a must-fix was correct.** No independent adjudication beyond 8 rows (F24, F28).
   Unanswerable.
4. **Whether a bounce improved the built work.** 42/68 round-1 bounces passed at round 2
   (F3), but "passed" is the same author's later verdict. Recurrence is confounded by fixed
   lane scope (F16). Unanswerable.
5. **Anything per-cell about reviews.** 64/274 attribution, all post-08-20 (F26). Out of
   scope by the brief and unsupported by the data.
6. **What the 32 `changes-needed` envelopes without a findings array contained** (F8).
   Recoverable only by parsing 562 `review.md` files as prose — not attempted here, and the
   honest note is that any category count in Part 2 is a count over the 74% that opted in.
7. **Whether seat teardown ever went badly.** One value in every column of 569 rows (F23).
   Unanswerable.

---

## Part 7 — What the evidence implies for rubric ordering

Ranked by measured must-fix yield, each with its denominator. Ordering is evidence; the
absolute rates carry F28's confound.

| # | rubric area | evidence | n |
|---|---|---|---|
| 1 | **Demand a counterexample: state → wrong observable, in one short sentence.** A finding that cannot be written that way is a consider. | 74% must-fix vs 20% (F10); must-fix median 143 chars vs consider 273 (F11) | 254 |
| 2 | **An indeterminate state collapsed into a definite one** — EPERM/EINVAL/unknown probe read as dead, absent read as zero, unmeasured read as 0 tokens. | 60% must-fix, largest high-yield category | 50 |
| 3 | **Lifecycle and clobber** — a second run overwriting a terminal envelope, an orphaned fork, a settled seat re-settled. | 63% must-fix | 32 |
| 4 | **The degradation path** — what happens when the optional thing fails; optional instrumentation becoming load-bearing. | 77% must-fix (highest rate; small n) | 13 |
| 5 | **Hostile CLI/API input** — empty flag value, trailing flag, `__proto__`, Symbol, giant integer, URL userinfo, prefix slicing. | 57% must-fix | 21 |
| 6 | **Rendering that joins by array position** or drops rows on duplicate keys. | 71% must-fix (visualizer lanes) | 14 |
| 7 | **Vacuous tests / surviving mutations.** Keep the rule — it is the highest-*volume* class the seat produces and it is what protects future changes — but rank it as should-fix by default, which is where 37% of them already land. | 24–28% must-fix, below the 47% baseline | 46 |
| 8 | **Plan conformance and out-of-plan edits.** | 25% must-fix (20); out-of-plan specifically **0 of 5** | 25 |
| 9 | **Stale comments, docs, READMEs, charters.** Worth writing; never a bounce. | **0 must-fix in 23** (F12) | 23 |
| 10 | **Carried-forward findings.** By construction, nothing carried forward has ever been a must-fix — a must-fix is fixed or the lane does not proceed. | **0 must-fix in 10** | 10 |

Two framing facts a rubric author should carry into the text:

- **The gate does not pre-clear the mechanical defects.** `gate:r1` is green 96.6% of the
  time (F19) yet review finds a must-fix in 34.6% of green-gate runs (F6). The rubric is not
  a second opinion on the gate; it is the primary filter.
- **Half of reviews correctly find nothing** (F5, 140/269). A rubric that pressures the seat
  toward a minimum finding count would be optimising against the measured baseline.

---

## Corrections to standing memory

**verified.** Memory records that `review_outcomes`' `must_fix`/`should_fix`/`consider` are
"0% null and read by NOTHING". The first half is confirmed exactly (F2). **The second half
is false as of this commit.** Three live readers:

1. `crew/escalation-policy.mjs:180-181` — `regrantVerdict()` filters review rows on
   `Number.isInteger(row.must_fix)`, then requires the sequence of `must_fix` counts to be
   monotonically non-increasing with a last value ≤ 1 (`must-fix-converging`). **The count
   drives whether an escalated run is granted extra rounds.** Load-bearing.
2. `scripts/factory/ledger.mjs:2553, 3843` — `gateReviewGap()` / the `gate-review-gap` verb
   compute `MAX(must_fix)` per run; this is the ADR-030 gate-adequacy metric and is exactly
   the number reported in F6.
3. `visualizer/web/src/lib/ReviewPanel.svelte:13`, `trace.js:139`, `panels.js:246`,
   `visualizer/server/shape.mjs:249`, `ledger-feed.mjs:80` — the count is rendered per
   review round in the shopfloor UI, with a `null` treated as "predates this measurement".

The useful corrected form of the memory: *the counts are 0% null, are read by the regrant
policy, the gate-adequacy readout and the visualizer, and carry almost no information beyond
the verdict itself (F2) — the finding **kinds** are what nothing reads, because nothing
records them (F7).*
