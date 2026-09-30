# Advisor A/B protocol

## Purpose

This document is the instrument, not the verdict. The ratify-or-delete decision
on the #294 advisor belongs to the human, and may be taken only from a COMPLETE
readout. A readout with `ratifiable: false` may not be used for ratification in
either direction: it does not prove that the advisor helped, and it does not
prove that the advisor failed. COMPLETE means exactly `ratifiable: true` with an
empty `incomplete` array.

## Implementation files

- `scripts/factory/ledger.mjs`
- `test/factory-ledger-advisor.test.mjs`

## Arms

- **Arm A — advisor off.** This is the default-off arm: it has no advisor
  manifest and zero advisor notes.
- **Arm B — advisor granted.** The adapter-unsupported and dead-endpoint boot
  refusals from slice A already supply the advisor's provably-applied
  guarantee. This protocol consumes that guarantee and re-implements none of
  its boot checks.

## Build-run arm readout

Run `node scripts/factory/ledger.mjs advisor-arms [--arms <arm,...>] [--json] [--since <iso>]` to compare recorded advisor arms. Record an operator window with `node scripts/factory/ledger.mjs advisor-arms --start-window [--note <text>]`; each call appends evidence with its own `window_id`, including calls at the same instant, and a JSONL replay never duplicates a recorded window. `--since` takes precedence over the latest recorded window. Otherwise the latest recorded window (greatest parsed start instant) is used; with neither, no time filter is applied. The JSON readout reports `window.started_at` and its `source` (`since`, `recorded`, or null), plus `excluded.before_window`. Sessions beginning before the selected instant are excluded before configuration attribution, for completed and in-flight runs alike. An older read-only ledger without `advisor_ab_windows` is treated as having no recorded window; no table is created during that read. Only build-tier runs with a recorded advisor
model and a recorded builder grant enter an arm. Runs without a recorded
configuration/model and runs with absent, malformed, or non-builder grants are
reported as exclusions; non-build tiers are excluded. Other rates are descriptive and withheld below the separate 12-finished-run arm floor. Rounds rates require 12 measured finished runs; `rounds_unmeasured_runs` counts unmeasured finished runs. `build_rounds_absent_reason` is `no-measured-rounds` at zero measured runs, `below-run-floor` below twelve, and `null` otherwise. In-flight runs are excluded from all rounds counters. With `--arms`, `next_arm`
recommends the listed arm with the fewest eligible runs (ties keep list order). Without `--arms`, the default order is `none`, `openai/gpt-6-luna`, `openai/gpt-5.6-terra`, `openai/gpt-6.1-sol`; dispatch uses this same order and completed-plus-in-flight counts. It rotates only settled build-tier lanes without a named advisor, and unreadable evidence leaves seats untouched. Eligible picks are serialized across dispatch processes by a capacity-one `advisor-rotation` lease. A JSON reservation records lane, arm, and reserved instant until a matching session (same `task_slug` and start instant at/after reservation) acknowledges it or it reaches the 60-second expiry. Damaged reservation evidence fails closed for operator repair; contention gives up after five seconds. A dispatch wave refused before boot retracts the reservations it made under the same lease; a lane whose boot fails after the wave compiled keeps its reservation until the expiry.
Lane spend is derived from per-model `agent_sessions` rows, not session cost
fields; every row in a finished run must have a session id, complete usage and
a uniquely priced model for that run to count. An arm may show a priced subtotal alongside
its priced/missing run denominators and the first missing cause. There is no
historical backfill; cellUsage dispatch joins intentionally continue summing
both fallback rows. Advisor spend covers only priced `advisor_usage` consults;
older and HTTP consults may be journal-only and are not measured as zero. See
the ledger's spend-coverage note for this limitation. This 12-run floor is distinct from
the 12 review-dispatch-per-arm ratification floor below.

## The four measurements

1. **rounds per run.** Read the run's `log` stage markers in `events`.
   Query one run at a time with `node scripts/factory/ledger.mjs tail <adw_id> --limit <n>`
   and choose a limit large enough to include its whole marker stream.
   A finished run is measured iff it has a terminal marker (`done` or a message
   starting `escalate:`) and its build markers are exactly r1..rN. Its count is N;
   no build marker with a terminal is a measured zero. Incomplete streams count
   in `rounds_unmeasured_runs`, not the rounds denominator. A dropped final `build:r<N>` before a recorded terminal marker is not detectable.
2. **bounce rate.** Use the same `task` readout's `review_outcomes[]`. The
   bounce rate is rows with `verdict === 'changes-needed'` divided by all
   rows.
3. **note-to-finding overlap.** Run
   `node scripts/factory/ledger.mjs advisor-ab --run-dir <dir> --run-started-at <iso|ms> --adjudications <path> <dispatch-id>…`.
   The overlap rate is `overlap_findings` over `findings_total`.
4. **tier-0 vs tier-1 note share.** Use the same `advisor-ab` readout's
   `notes.injected_by_tier`, `notes.tier0_share`, and `notes.tier1_share`.
   A `null` share means that there were no injected notes; it is never a
   measured zero share.

The finding key is `(run_started_at, dispatch_id, finding_id)`. The overlap
numerator is the number of distinct findings with at least one resolved,
injected advisor note. It cannot count a cited note twice as two findings.

## Getting the inputs

The exact review dispatch ids come from
`ledger task <adw_id>`'s `review_outcomes[].dispatch_id`. Pass those ids
explicitly to `advisor-ab`; never infer them by listing or searching the
returns directory. The epoch for arm B comes from
`<runDir>/task/advisor-manifest.json`'s `run_started_at`. Arm A has no manifest;
use `ledger task <adw_id>`'s `session.started_at` instead. The journal and
selected return envelopes are read by name for that one epoch and selection.

Note references are `n<k>`, the 1-based ordinal over this epoch's
`advisor_note` rows in `<runDir>/journal.jsonl`. The advisor does not mint a
note id, so the ordinal is the reproducible reference for a second reader.

## The adjudication file

The file is JSON with `schema: 1`, an optional `run_started_at` (when present it
must agree with the command-line epoch), and an `adjudications` array. Every
selected finding must appear exactly once. Each entry has a selected
`dispatch_id`, its `finding_id`, a verdict of `overlap`, `no-overlap`, or
`skipped`, and a `note_refs` array of `n<k>` strings. For example:

```json
{ "schema": 1, "run_started_at": 1755600000000,
  "adjudications": [
    { "dispatch_id": "d3", "finding_id": "RV1-1", "verdict": "overlap",   "note_refs": ["n2", "n5"] },
    { "dispatch_id": "d3", "finding_id": "RV1-2", "verdict": "no-overlap", "note_refs": [] },
    { "dispatch_id": "d7", "finding_id": "RV2-1", "verdict": "skipped",    "note_refs": [] } ] }
```

`n<k>` is the 1-based ordinal of an `advisor_note` row for this
`run_started_at` in `<runDir>/journal.jsonl`. Every finding in every selected
envelope must appear exactly once. `skipped` is an honest admission that the
human could not adjudicate the finding; it deliberately makes the readout
non-ratifiable.

## Sample-size floor

The floor is **12 review dispatches per arm** (in practice, at least 6 runs per
arm). With a dozen dispatches, an arm-to-arm difference in bounce rate under
roughly 20 points is indistinguishable from run-to-run noise, so this protocol
declines to ratify below the floor. This is a stated floor, not a power
calculation. A human compares it across the arm's readouts because one
`advisor-ab` readout covers one explicit selection; therefore the command
reports `dispatch_count`, `dispatch_floor`, and `at_floor` instead of enforcing
the floor.

## Non-ratifiable readouts

The reason vocabulary is the exported `ADVISOR_AB_INCOMPLETE_REASONS` list:

- `envelope-missing` — the selected return file was absent.
- `envelope-unreadable` — the selected return could not be parsed as an object.
- `envelope-role-mismatch` — a selected envelope named a role other than reviewer.
- `dispatch-id-mismatch` — an envelope's optional assignment id disagreed.
- `dispatch-not-attested` — the selected id lacked an epoch-bounded reviewer attestation.
- `findings-absent` — the envelope had no findings array.
- `finding-malformed` — a selected finding lacked a valid id or severity.
- `duplicate-key` — a repeated `(run_started_at, dispatch_id, finding_id)` was dropped.
- `unadjudicated-finding` — a distinct selected finding had no adjudication.
- `skipped-finding` — its adjudication honestly skipped the finding.
- `note-not-in-journal` — a cited note ordinal did not resolve in this epoch.
- `note-not-injected` — a cited note resolved but was suppressed or rejected.
- `adjudication-malformed` — an adjudication entry failed its schema or vocabulary checks.
- `adjudication-unknown-dispatch` — an entry named a dispatch not selected for this readout.
- `adjudication-unknown-finding` — an entry named no collected finding.
- `duplicate-adjudication` — a finding received more than one adjudication.
- `numerator-exceeds-denominator` — the defensive numerator bound was violated.

Any non-empty `incomplete` ends the measurement until the input is fixed and
the readout is re-run. `ratifiable: false` is an incomplete instrument state,
never an advisor verdict.

## Out of scope

This protocol neither runs the experiment nor takes the ratification decision. Reviewer `advisor-ab` continues to use the crew journal and adds no ledger table. The separate `advisor-arms --start-window` operator evidence is stored append-only in `advisor_ab_windows`.
