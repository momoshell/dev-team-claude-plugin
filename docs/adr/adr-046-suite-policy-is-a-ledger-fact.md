# ADR-046: Suite policy is a ledger fact, so every suite-run decision is stamped, ingested and rated

**Status:** ratified 2026-09-25 (operator decision) · **Owner:** operator · **Issue:** #1527 ask 4

## Decision

**Each seat dispatch's suite-run policy outcome, and each suite-run refusal, becomes a timestamped ledger
fact in one additive table. The ledger can then state a refusal RATE per cell, with dispatches as the
denominator, instead of the journal holding it where no query reaches.**

1. **Stamp.** `suitePolicyRow` and `suiteRefusalRow` (`crew/headless.mjs`) write `at` (epoch ms, the journal's
   own clock) and `dispatch_id` on every row they emit. Nothing else about the rows changes.
2. **Ingest.** `seat-suite-policy` joins `JOURNAL_FACT_EVENTS` (`scripts/factory/ledger.mjs`), writing one additive
   table, `suite_decisions`:

   | column | meaning |
   |---|---|
   | `adw_id`, `dispatch_id`, `role`, `transport` | the dispatch |
   | `provider`, `model_id`, `agent`, `effort` | the seated cell, joined from `run_seats` at ingest; null with a reason if unjoinable |
   | `decision` | `refused`, when the row carries `refusal: suite-run-not-owned`, or `policy`, for a per-dispatch counter row |
   | `refusal_kind`, `reason`, `command_class` | refused rows only. `command_class` is the class, not the raw command: commands can carry paths and secrets |
   | `admitted`, `refused`, `unrecognised` | policy rows only; null means not measured, never 0 |
   | `at_ms`, `created_at` | when |

   Uniqueness is `(adw_id, dispatch_id, role, decision, at_ms)`, so re-ingesting a journal adds nothing
   (the `ingest-all` rule, #1531). Rows without `at`, which is every row written before this lands, stay in the
   journal and are counted by ingest as `unstamped`, never guessed into a window.
3. **Read.** `node scripts/factory/ledger.mjs suite-refusals --since <iso> [--until <iso>]` prints, per cell and
   role: dispatches (the denominator, from `run_seats`), refusals, rate, re-asks after a refusal, and how many of those
   re-asks recovered. Any cell with n < 12 is flagged `thin`, the `ledger cells` floor.

## Grounds, measured 2026-09-25 over 376 lane journals

- **443 `suite-run-not-owned` refusals in 229 of 376 lanes (61%)**: builder on rpc 282, reviewer on
  headless-json 129, lead on headless-json 29, others 3. The ledger holds **none** of them; 22 `events` rows only
  mention the phrase in a lead's `why` text.
- **3,346 `seat-suite-policy` rows, 0 of them timestamped**, so no ingest window can take them today.
- 442 refusal re-asks were applied, and 394 of their next envelopes were `done`. So a refusal usually costs a
  re-ask, not a lane. That cost, in turns and per cell, is exactly what nothing measures.
- The ledger's only suite column is `seat_turn_census.suite_runs` (2,751 rows): a count with no decision attached.

## Consequences

- The cell breaker (#1105 ask 1) gains the rate it has lacked since 2026-09-13: failures per attempt, per cell.
  **Whether** the breaker opens on this rate is **not** decided here (ADR-032 governs refusal vs reroute).
- Charter and brief tuning can be measured. #1522 fixed one prompt that told a seat to rerun; the next such
  prompt appears as a per-role rate step.
- The schema grows by one table, additive only. `replayJsonl`'s closed WRITERS set gains one writer.

## Rejected alternatives

- **Parse journals at query time.** Journals are the authority for a lane, but they churn, move to
  `.archive-` directories and are torn down. Every other cross-lane rate in this repo is a ledger read.
- **A counter column on `seat_turn_census`.** It already has `suite_runs`; a count cannot carry which command
  class was refused, so it cannot be tuned against.
- **Store the raw command.** Commands can embed paths, env and credentials. The class, which the suite
  policy already computes, is enough to act on.

## Not decided here

The breaker policy; any change to which commands the suite policy admits or refuses; backfilling unstamped
rows, which have no honest timestamp to give them.

## Amendment 1 (ratified 2026-09-26, operator decision)

Sol found two identity defects in the Decision as first written. **Both writers also stamp `run_id` and the seat's own cell (`provider`, `model_id`, `agent`, `effort`) on every row, and `suite_decisions` stores that cell as written; it is never re-joined from `run_seats`**, because `run_seats` is unique per lane and role, not per boot, so a lane that reboots with a different cell would have its later decisions filed under the first cell. **A decision's dispatch identity is `(adw_id, run_id, transport, dispatch_id, role)`**, because a same-checkout reboot keeps its `adw_id` and the pane and headless transports each issue their own `d1`. The uniqueness key becomes `(adw_id, run_id, transport, dispatch_id, role, decision, at_ms)`, and `suite-refusals` counts dispatches on the full identity. Rows written before the amendment carry no `run_id` or cell: they are ingested with both null and the reason `pre-amendment`, and counted, never guessed.
