# Task

---
source: operator request 2026-10-27 (lean lanes never appear in the visualizer)
closes: null
tier: build
shape: standard
acceptance: [LV1, LV2, LV3, LV4]
out_of_scope: crew/ (the lean loop and what it records), the ledger and its schema, the old-path run views, crew/drive.mjs, crew/crew.mjs
---
## The ask

The visualizer lists runs only from the ledger (`/api/sessions` → `listRuns` in
`visualizer/server/ledger-feed.mjs`). The lean loop (ADR-052) writes no ledger rows, so no lean lane has ever shown
up. Checked on 2026-10-27: `/api/sessions` returned none of the lean lanes b1379–b1390 or the running b1386.

A lean lane records everything on disk under `~/.crew/dt-<lane>/<lane>/`:
- `crew.json`;
- `task/lean.json`, the lane spec;
- `task/journal.jsonl`, with stage-start, check, stage-end, verdict and pr rows;
- `task/<role>-<turn>.json`, the returns;
- `task/lean/<role>/*.jsonl`, the seat sessions.

`crew show` (`crew/show.mjs` `showLane`) already reads the live copy of a lane and the archived copy in
`~/.crew-journal-archive`.

Make the visualizer list lean lanes beside ledger runs: running, stopped and finished. Show each lane's stages and
verdict from its journal and its seats' sessions by role. The visualizer only reads; it never writes into a lane.

Invariant: ledger runs are listed and shown exactly as today. A lean lane's value that its files do not carry is
shown as absent with a reason, never guessed.

## Context

- `visualizer/server/server.mjs`: the `/api/sessions`, `/api/journal` and `/api/returns` routes.
- `visualizer/server/ledger-feed.mjs` `listRuns`: the row shape the run list renders.
- `visualizer/server/journal-source.mjs` `readJournal`: today's journal reader. It expects the old layout, with
  `ledger/run.json` and the journal beside `task/`.
- `crew/show.mjs` `showLane`: how a lean lane's live and archived dirs and its sessions are found. Reuse its rules,
  but do not import across the zero-dependency boundary the wrong way (`visualizer/server` may import from `crew/`
  only as the existing sources already do).
- `visualizer/web/src/App.svelte` and `visualizer/web/src/lib/`: the run list and the run detail.
- Tests that pin today's behaviour: `test/visualizer-server.test.mjs`, `test/visualizer-trajectory.test.mjs`,
  `test/visualizer-returns.test.mjs`.

## Acceptance

- (LV1) `/api/sessions` lists a lean lane found under the crew root, with its lane name and its journal's latest stage
- (LV2) `/api/sessions` lists a lean lane whose journal ends in a verdict with that verdict's status and reason
- (LV3) the journal route serves a lean lane's rows from its `task/journal.jsonl`
- (LV4) a lean lane's seat sessions are served by role from its `task/lean/<role>/` recordings
