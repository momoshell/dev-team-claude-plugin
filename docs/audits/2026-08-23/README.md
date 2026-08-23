# Whole-repo inspection, 2026-08-23

Two passes over the repository on one day, by ten read-only crew scout lanes. Every
register here was written by a lane that changed zero files (the driver refuses a
scout run that touches the checkout). Nothing in this directory is instructions to
anyone — it is evidence, preserved so a finding can be re-derived rather than
re-discovered.

## Why it is committed

The registers and their reproduction programs previously lived only in
`~/.dev-team/factory/preserved/`, a machine-local directory nothing versions or
backs up, while the issues that cite them are public and permanent. A citation to
a path on one laptop is not a citation. This directory is the durable copy.

The reproduction programs matter as much as the prose: the project's own rule
(#498, #508) is that a measurement's program IS its evidence, so re-deriving a
finding should be "run the program again", not archaeology.

## Layout

    audit/   consistency, duplication, prose truth, test vacuity   (index: issue #534)
    hunt/    adversarial defect hunt, five surfaces                (index: issue #536)

### audit/ — four scouts, ~60 findings

| file | scope |
|---|---|
| `s1-register.md` | `crew/` runtime: duplicates, grammar drift, dead exports, oversize, re-derivation |
| `s2-register.md` | `scripts/factory/` + `visualizer/server/`, plus a section map of `ledger.mjs` and a split verdict |
| `s3b-register.md` | every file under `skills/` and `commands/`, each checkable claim marked true/stale/false |
| `register-charters.md`, `register-cross-cutting.md`, `register-crew-recovery-commands.md`, `register-devops-prreview.md` | `crew/roles/`, `crew/guidelines/`, `crew/pi/agents/` — from the lane that escalated rather than call a partial sweep done |
| `s4-register.md` | the test suite: duplicated helpers, vacuous tests (each proven by a kill-mutation), measured durations |

### hunt/ — five scouts, ~65 reproduced defects

| dir | surface |
|---|---|
| `h1/` | process lifecycle — kills, signals, orphans, teardown |
| `h2/` | input boundaries — flags, envelopes, fence registers, brief compiler |
| `h3/` | state machines — reachability, TOCTOU, the intake claim ladder |
| `h4/` | data integrity — JSONL/db divergence, migrations, degraded paths |
| `h5/` | the visualizer HTTP surface |

Each carries `findings.md` and a `repro/` directory. Every reproduction runs against
a scratch copy of the repository (`git archive HEAD`) or a throwaway ledger
directory, never against a working checkout; several take the scratch path in an
environment variable (`H1_SCRATCH_REPO`, `H3_REPO`) documented at the top of the
program. `h3/` has no `findings.md` — that lane's write-up was lost to the seat wait
budget, and each of its programs documents its own finding in full at the top.

## How to read a finding

Every finding states what was observed, what was expected, a severity from a closed
set, and — the part that makes it actionable — **the guard that should have caught
it and why it did not**. Where a hunt could not reproduce a suspicion it says so in
a separate section; those are not findings. Where an attack was survived it is
recorded as a negative result, so a later pass does not spend the same time twice.

## Status

Findings promoted to issues are tracked from #534 (audit) and #536 (hunt); the
correctness work is programmed in epic #546. A finding that is not yet an issue is
**not** rejected — the standing rule on both index issues is to re-read the relevant
register when compiling any batch that touches its surface.
