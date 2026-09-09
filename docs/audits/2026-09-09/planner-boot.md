# Where the planner's fixed cost is NOT — #1079 ask 1

Measured 2026-09-09 at `8faa834` over **1,505 `seat_turn_census` rows** read from
every lane journal under `~/.crew`.

**Ask 1 was: attribute the planner's ~169 s pre-first-turn cost to its recorded
components. The answer is that the components cannot see it.** The instrument
built for this question measures a window covering **5.6%** of the cost, and
almost all of that window is itself unattributed.

## 1. The overhead reproduces, on a larger corpus

`model_time = span_ms - in_tool_ms` regressed on `turns`; the intercept is the
per-assignment fixed cost.

| role | n | **fixed overhead** | marginal | R² |
|---|---|---|---|---|
| **planner** | 427 | **181 s** | 12.8 s/turn | 0.62 |
| builder | 308 | 108 s | 12.4 s/turn | 0.82 |
| tech-lead | 272 | 92 s | 20.6 s/turn | 0.52 |
| reviewer | 178 | **27 s** | 11.8 s/turn | 0.82 |
| lead | 302 | 25 s | 8.3 s/turn | 0.66 |

#1079 reported 169 s over n=414; this is 181 s over n=427 on a corpus that has
grown since. **The finding is unchanged: the planner's fixed cost is ~7x the
reviewer's on the same transport**, and the reviewer is the control.

## 2. The pre-first-turn instrument covers 5.6% of it

`seat_turn_census` carries a pre-first-turn breakdown. Median per role, beside
the regression intercept:

| role | overhead (intercept) | median `pre_first_turn_span_ms` | **share of overhead covered** | median residual |
|---|---|---|---|---|
| planner | 181 s | 10.2 s | **5.6%** | 10.1 s |
| tech-lead | 92 s | 10.2 s | 11.1% | 10.1 s |
| builder | 108 s | 15.1 s | 14.0% | 15.1 s |
| reviewer | 27 s | *absent* | — | — |
| lead | 25 s | *absent* | — | — |

**94.4% of the planner's fixed cost happens outside the window this instrument
measures**, and of the 10.2 s it does measure, **10.1 s is residual** — the part
none of its own components explain.

## 3. The brief-read hypothesis is refuted as measurable

#1079 proposed, explicitly unproven, that the planner `cat`s a brief delivered by
path. Across **438 planner rows**:

| component | absent | recorded reason |
|---|---|---|
| `brief_read_ms` | **438 / 438** | `no-brief-tool-turns`, `no-first-non-brief-tool` |
| `envelope_poll_ms` | **438 / 438** | `envelope-write-time-unobservable` |
| `prompt_delivery_ms` | 431 / 438 | `clock-resolution` |
| `seat_boot_ms` | 422 / 438 | `seat-reused` |

**Every planner row reports `brief_read_ms` absent.** The hypothesis is not
disproven as a mechanism — it is unmeasurable with what is recorded, which is a
different and more useful statement. Nothing here supports acting on ask 2
(inline the brief); doing so would be changing a system on an unmeasured belief.

Note the reasons are honest and specific: `seat-reused` and `clock-resolution`
are real conditions, not missing instrumentation. The gap is that the *window*
is wrong, not that the fields are broken.

## 4. What this leaves

**The 181 s is real, reproducible, and unlocated.** It is not in the
pre-first-turn window. The reviewer's 27 s on the identical seat lifecycle and
envelope protocol is the floor to compare against, and the 154 s difference
between them is entirely outside anything currently recorded.

Ask 1 is answered — **unattributed, with the reason** — and asks 2 and 3 should
not proceed on this evidence. What would move it: an instrument covering the
whole assignment span rather than the pre-first-turn prefix, since the intercept
is a property of the span and the prefix is 5.6% of it.

## Blind spots

- `model_time = span_ms - in_tool_ms` attributes all non-tool time to the model.
  Transport waits, settle-gate polls and envelope waits are inside it and are not
  separated. R² of 0.62 for the planner means turns explain most but not all of
  the variance, so the intercept carries whatever else scales with assignments.
- Rows with `turns` null or `span_ms` absent are excluded, not zeroed: 427 of 438
  planner rows fitted.
- Reviewer and lead report no pre-first-turn fields at all, so their 27 s and 25 s
  are unattributed for a different reason — absence, not residual.
- **The ledger can drop records under concurrent writers (#1116).** These figures
  come from journals rather than the SQLite mirror, so that defect does not apply
  directly, but no audit has confirmed the journals are complete either.
