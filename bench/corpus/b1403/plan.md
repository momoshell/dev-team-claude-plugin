# Plan — finish decision (FD1–FD9)

Subject: `fix(crew): publish measured lane results`

## Current seams (read directly)
- PR body/subject exist only locally at `crew/loop.mjs:357-377`; a finish run emits `finish-ready` with only `head`.
- Review verdicts are journalled at `crew/loop.mjs:319-330`; gate/proof/suite strings accumulate in `measurements` at `crew/loop.mjs:258-355`.
- `crew/finish.mjs:54-138` parses the lane, refuses, builds `finish`, claims `finish-<stopAt>.claim`, writes `finish.json`, spawns `crew/lean.mjs`; `main` at `crew/finish.mjs:140-152` takes only `<lane>`.
- Publish seam is `openPullRequest` in `crew/checks.mjs:578-638` (do not edit it); PR row shape read by closeout is the last `event:'pr'` row (`crew/closeout.mjs:38-49`, loop form at `crew/loop.mjs:383-386`).
- Review cap constant is `FINISH_REVIEW_ROUNDS = 3` at `crew/loop.mjs:24-26`, applied at `crew/loop.mjs:245-247`.

## Minimal changes

### 1. `crew/loop.mjs` — fused report + richer `finish-ready` (FD1, FD2, supports FD3/FD7)
- Add `writeFile` from `node:fs/promises` to default deps `crew/loop.mjs:93-99` and to the `seams` list; update the `fakes` harness in `crew/loop.test.mjs:22-76` to inject a capturing `writeFile` (virtual taskDir must never hit the real fs).
- Collect `finishReviews`: on every reviewed verdict push exactly `{ verdict: review.details.verdict, findings: review.details.findings }`.
- Validate optional finish fields: `fin.guidance` (string when present) and `fin.priorReviewRounds` (safe integer ≥ 0 when present); otherwise `invalid-input` before any effect.
- Effective reviewer rounds for a finish run: `FINISH_REVIEW_ROUNDS - (fin.priorReviewRounds ?? 0)` (may be 0 → the existing single-turn round-bound stop, never a lead bounce). This is how a `--return` pass counts against the cap and never grants rounds.
- First finish builder feedback becomes: `{id:'finish-stop', reason, observation}`, then, only when guidance is present, `{ id: 'finish-return', guidance: fin.guidance }`, then `...fin.findings`.
- On a green finish run only (after rebase, before returning done): write `join(spec.taskDir, 'finish-report.json')` with JSON `{schema:'finish-report/1', lane: spec.id, stop:{reason: fin.stop.reason, observation: fin.stop.observation}, subject, body, head: rebased.head, reviewRounds: rounds.reviewer, reviews: finishReviews, measurements, acceptance}`; a write failure stops the run (outer `runner-threw`) with no `finish-ready`.
- Extend the row to `emit('finish-ready', { status:'ready-for-operator', head: rebased.head, subject, body, reviewRounds: rounds.reviewer })`. Standard-shape behaviour is byte-identical.

### 2. `crew/finish.mjs` — decision verbs (FD3–FD9)
- Extend `defaultDeps` with `appendFileSync` (real fs) and `openPullRequest` imported from `./checks.mjs`; add `createHash` from `node:crypto`. Extract the existing lane/spec/journal/planner loading so `finishLane` and the new export share it; do not change `finishLane`'s existing refusals or claim.
- New pinned export: `export async function decideFinish({ lane, root, choice, file, deps = {} })`, `choice` ∈ `accept|return|abandon`.
  - Load spec + journal. Let `readyIdx` be the last index of an `event:'finish-ready'` row. Refuse `FinishRefusal('finish-not-ready', …)` when there is no such row, or any `verdict/stopped` or `stage-start` row after it (FD8).
  - Refuse `FinishRefusal('finish-decided', …)` when any `event:'finish-decision'` row exists after `readyIdx` (FD9). Both refusals happen before reading any file, publishing, appending or spawning.
  - When `file` is given, read it as utf8; `notesSha256 = createHash('sha256').update(text).digest('hex')`, else `notesSha256 = null`. Decision row appended (via `appendFileSync` to `journal.jsonl`) has exactly the four keys `{ event: 'finish-decision', lane, choice, notesSha256 }`.
  - `abandon`: append only the decision row; publish/spawn nothing; return `{lane, choice}` (FD6).
  - `accept`: compose `body = ready.body` verbatim, or `` `${ready.body}\n\n## Operator notes\n\n${notesText}` `` when notes are given (FD4). Call `d.openPullRequest({ cwd: spec.cwd, branch: spec.branch, base: spec.base, title: ready.subject, body, closes: spec.closes ?? [], refs: spec.refs ?? [] })` (FD3). On a non-green result or missing `pr`, throw `FinishRefusal('finish-publish', …)` and append nothing (retry stays possible). On green append, in order, `{ event: 'pr', lane, stage: 'publish', pr: published.pr }` then the decision row (FD5 — closeout's `lastPr` then reads it).
  - `return`: `file` is required. First append the decision row (so no second decision can race the pass), then build the same finish spec `finishLane` builds (planner subject/plan/gate/mutations, original stop, open findings, `turnOffset` = envelope-row count) plus `guidance: <file text>` and `priorReviewRounds: ready.reviewRounds ?? 0`. Claim `finish-<readyIdx>.claim` with flag `wx` (existing per-stop claim already exists), write `finish.json` as `{...spec, shape:'finish', finish}`, spawn detached exactly as `finishLane` does; a failed launch removes the new claim (FD7).
- `main` parses: `[lane]`, `[lane,'--accept']`, `[lane,'--accept','--notes',file]`, `[lane,'--return',file]`, `[lane,'--abandon']`; anything else prints `usage: crew finish <lane> [--accept [--notes <file>] | --return <file> | --abandon]` and returns 2. Refusals keep the `crew finish: <reason>: <message>` stderr form and return 1. No-flag behaviour is exactly today's.
- Update the header comment of `crew/finish.mjs:1-8` and the usage line in `bin/crew.mjs:8` to name the three verbs (routing in `bin/crew.mjs:33` already strips `finish`).

### 3. Tests proving it
- `crew/loop.test.mjs`: finish run with two reviews (changes-needed then pass) writes `finish-report.json` naming the stop reason and both verdicts/findings, with gate/mutation/suite measurements; `finish-ready` carries subject/body/reviewRounds; guidance reaches the first builder feedback after `finish-stop`; `priorReviewRounds: 2` allows exactly one more reviewer turn then `round-bound`; a report write failure emits no `finish-ready`; standard run unchanged.
- `crew/finish.test.mjs`: ready-lane fixture (journal ending in `finish-ready` with subject/body/reviewRounds, plus the finish run's `commit` row — note `finishLane`'s published/committed refusals must not block decisions). Cases: accept publishes with title = subject and verbatim body and appends `pr` + `finish-decision` (digest null); accept with notes puts the text under `## Operator notes` and digests it; abandon appends only `finish-decision` choice `abandon`; return spawns a run whose `finish.json` carries the guidance text and prior review rounds, and appends the decision; a lane with no/trailing-stopped `finish-ready` is `finish-not-ready` for all verbs; any second decision is `finish-decided` with no extra publish/spawn; usage errors return 2.
- `bin/crew.test.mjs`: no change needed beyond existing routing proof (verb already routes).

## Out of scope (per brief)
`crew/drive.mjs`, `crew/crew.mjs`, `crew/checks.mjs`, `docs/adr/`, standard-shape behaviour, finish stages before rebase. Merging stays the operator's; `--accept` only publishes.

## Validation
- Lane: `node --test crew/loop.test.mjs crew/finish.test.mjs bin/crew.test.mjs`
- Gate: `node /Users/momoshell/.crew/dt-b1403-lean-finish-decision/b1403-lean-finish-decision/task/gate.mjs` (run from the repo root; red on the unchanged tree).
