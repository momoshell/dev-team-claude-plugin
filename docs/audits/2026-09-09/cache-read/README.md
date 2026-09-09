# Cache-read census — what the read gate did, and what the builder did (#1103)

Measured 2026-09-09 at `19e2277` over `~/.dev-team/factory/ledger.db`,
table `agent_sessions`: **875 of 876 rows carry `billed_cache_read_tokens`**.
One row is null and is excluded — a null, never a zero.

Era split at `3783ded` (*feat(crew): gate oversized pi reads by target role*,
2026-09-08 12:50 CEST), the commit that gave `planner` and `tech-lead` the read
gate. `builder`, `reviewer` and `lead` did **not** receive it.

**Regenerate:** the queries in this report run against the shipped ledger with
`node --input-type=module` and `node:sqlite`, opening
`~/.dev-team/factory/ledger.db` read-only and grouping `agent_sessions` by
`role` and by `started_at` against the era boundary above. Medians, not means:
the means are outlier-dominated and disagree with the medians in sign for the
`builder`.

## 1. What moved

Median per session:

| role | n before | n after | cache_read before | cache_read after | change | gated? |
|---|---|---|---|---|---|---|
| `planner` | 250 | 24 | 4.80M | 1.44M | **−70%** | **yes** |
| `tech-lead` | 110 | 11 | 2.62M | 1.72M | **−34%** | **yes** |
| `reviewer` | 125 | 16 | 2.11M | 2.08M | −1% | no |
| `lead` | 157 | 17 | 0.56M | 0.50M | −11% | no |
| `builder` | 150 | 17 | 6.82M | **14.69M** | **+115%** | no |

`reviewer` and `lead` are a natural control and did not move.

## 2. The planner and tech-lead drop is NOT attributed to the read gate

The era boundary is a proxy for everything that landed near it, not for the gate
alone: **#1036** (cited ranges as the working set), **#1041** (fenced-lane run
folded into the edit result), **#1055/#1060** (the gate itself) and **#1069**
(skeleton read) all landed inside the same window. Nothing in this data can
separate them.

**The control group is suggestive and not dispositive.** `reviewer` and `lead`
did not move, which is what makes the gated pair's drop interesting — but
neither seat makes the bare whole-file reads the gate refuses, so they may be
insensitive to it for reasons unrelated to whether it works.

**Reported verdict: coincident, unattributed.** A −70% figure must not be quoted
as the read gate's saving. Separating them needs #1059's dispatch-time holdout,
which exists for exactly this and has not been run on this question.

## 3. The builder's +115% is partly turns; the rest is unattributed

**Turns rose.** From `seat_turn_census` rows in the lane journals under
`~/.crew` (n=237 before, n=58 after): builder turns per dispatch **35 → 48
(+37%)**, re-reads per dispatch **32 → 43 (+34%)**, distinct files read flat at
13 → 14.

**Per-turn context IS joinable, and this report's first draft was wrong to say
otherwise.** The join key is not in the ledger: `~/.crew/completions.jsonl` maps
each run to its crew dir, and that `run` **is** the `adw_id` on `agent_sessions`
(267 of 270 runs match). Joining `(adw_id, dispatch_id, role)` against the
`seat_turn_census` rows in each run's own journal yields **320 of 883 sessions**,
not the 3 the ledger table alone gives.

**Median cache-read per turn, before era** — the first per-turn token cost this
factory has measured:

| role | n | med turns | med cache_read | **med cache_read / turn** |
|---|---|---|---|---|
| `planner` | 69 | 29 | 3.089M | **0.119M** |
| `tech-lead` | 38 | 13 | 1.948M | **0.149M** |
| `builder` | 66 | 36.5 | 5.356M | **0.154M** |
| `reviewer` | 60 | 27.5 | 2.116M | **0.074M** |
| `lead` | 54 | 8.5 | 0.562M | **0.069M** |

**The after era is still unmeasured, but for a different and fixable reason.**
Every role lands at 4–8 joined rows, below `CELL_RATE_FLOOR` (12) — because
**119 of 269 runs no longer have a journal on disk**. A reaped lane's crew dir is
removed, and the census lives in that journal. So the question *"is the builder's
+115% more turns or longer context per turn?"* is answered for the before era and
not for the after one, and it becomes answerable simply by waiting: the floor is
reached once ~12 post-gate lanes have been reaped with journals retained, or
immediately if the census were mirrored into `seat_turn_census` for every session
rather than the 26 rows it holds today.

**One candidate cause is refuted.** Brief size was suspected — the operator grew
briefs to carry premise quotes on 09-09. Median compiled brief bytes per day
under `~/.crew/batch-*`:

| day | n | median | max |
|---|---|---|---|
| 2026-09-04 | 16 | 100,298 | 141,092 |
| 2026-09-06 | 31 | 71,530 | 134,233 |
| 2026-09-07 | 52 | 40,045 | 171,143 |
| 2026-09-08 | 33 | 40,835 | 50,694 |
| 2026-09-09 | 21 | **32,983** | 50,320 |

**Briefs shrank threefold over the week.** They are not the cause.

Candidates still open, none measured: #1069's skeleton read trading one whole-file
read for many `retrieve` calls; `crew/drive.mjs` growing 2,387 → 8,258 lines in
three weeks, so a builder that reads it re-reads more; and #1104 — the re-read
refusal has never fired, because `readgate.ts` refuses only a fully *contained*
range and a paged builder slides its window.

## 4. The cache is NOT being busted

Median per session, `cr/(cr+i)` is the share of prompt bytes served from cache:

| role | era | cache_read | input | cache_write | cache share | cache_write/cache_read |
|---|---|---|---|---|---|---|
| `planner` | before | 4.80M | 0.00M | 0.17M | 100.0% | 3.6% |
| `planner` | after | 1.44M | 0.17M | 0.00M | 89.4% | 0.0% |
| `tech-lead` | after | 1.72M | 0.16M | 0.00M | 91.7% | 0.0% |
| `builder` | before | 6.82M | 0.33M | 0.00M | **95.3%** | 0.0% |
| `builder` | after | 14.69M | 0.71M | 0.00M | **95.4%** | 0.0% |
| `reviewer` | after | 2.08M | 0.00M | 0.13M | 100.0% | 6.5% |
| `lead` | after | 0.50M | 0.00M | 0.07M | 100.0% | 13.0% |

**The builder's cache share is 95.3% → 95.4% — flat.** A rebuilt prompt would
show falling cache share and rising `cache_write`; neither happens. The rise is
**more tokens through a healthy cache**, not a cache that stopped working.

*Consequence:* there is no cache-alignment problem to solve here, and a
compression layer that rewrote the prompt would convert cheap cached reads into
full-price input tokens. The lever is reading less, not compressing what is read.

## 5. Blind spots

- **The after era is one day**, n=11–24 per role against 110–250 before. Every
  per-cell figure here is fragile and is reported with its n.
- **This is not a controlled experiment.** Section 2 states why.
- **Per-turn cost is joinable but the after era is under the floor** (section 3).
  The blocker is journal retention — 119 of 269 runs have no journal on disk —
  not an unjoinable schema. `seat_turn_census` holds 26 rows against 878
  sessions; mirroring it for every session would make the join direct and
  survive reaping.
- **`sessions` (298 rows) carries the same token columns and zero are
  populated**, so this analysis rests on `agent_sessions` alone; whether that
  undercounts anything is unknown.
- One `agent_sessions` row of 876 has a null `billed_cache_read_tokens` and is
  excluded.
