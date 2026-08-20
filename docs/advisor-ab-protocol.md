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
- `test/factory-ledger.test.mjs`

## Arms

- **Arm A — advisor off.** This is the default-off arm: it has no advisor
  manifest and zero advisor notes.
- **Arm B — advisor granted.** The adapter-unsupported and dead-endpoint boot
  refusals from slice A already supply the advisor's provably-applied
  guarantee. This protocol consumes that guarantee and re-implements none of
  its boot checks.

## The four measurements

1. **rounds per run.** Query one run with
   `node scripts/factory/ledger.mjs task <adw_id>`. In its `phases[]`, count
   names matching `build:r<n>`; the run's rounds are the highest `n`.
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

This protocol neither runs the experiment nor takes the ratification decision.
It adds no ledger table: the crew journal already carries every advisor note
with its epoch and tier.
