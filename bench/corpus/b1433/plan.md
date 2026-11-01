# Reusable seat benches

## Scope and source evidence
- Add only `bench/`; do not change crew/, scripts/, dependencies, visualizer, or old audit benches. Commit no measured runs.
- Read sources: ~/.crew/ab/{arms2,adv,lab}/replay.mjs and arms2/blind/{make-jobs.mjs,review-one.sh}, lab/blind/{make-jobs.mjs,review-one.sh}.
- Their callers are crew/acp/seat.mjs runAcpSeat and crew/checks.mjs runGate/proveMutations. P5's arm vocabulary is crew/protocols.mjs EXTENSIONS; armGrants alone is not a closed-name validator.

## SB1: freeze the six input sets
- For each full lane below, copy plan.md, gate.mjs, planner-1.json, lean.json byte-for-byte from `~/.crew-journal-archive/dt-<full>/<full>/task/`.
- Copy `~/.crew/briefs/started/<full>.md` as brief.md. Extract `.text` from the first JSONL line of the lexically first file in each source task's lean/planner and lean/builder directories; store exact text, without an added newline, in planner-prompt.txt and builder-prompt.txt. The first builder filename ends in builder.2.jsonl, not builder.1.
- Add manifest.json with `lane` (short id), `base` (exact short hash below), `originalTask` (lean.json.taskDir) and `originalTree` (lean.json.cwd). Preserve original absolute references in the corpus; rewrite only run-local copies. Source paths may also be recorded as provenance.

| short | full | base | acceptance |
| --- | --- | --- | --- |
| b1380 | b1380-lean-suite-rerun | 1d282ec7 | SR1 SR2 |
| b1381 | b1381-lean-provider-retry | 1d282ec7 | PR1 PR2 PR3 |
| b1402 | b1402-lean-reaim-unbound-mutations | 2966b484 | RA1 RA2 RA3 RA4 RA5 |
| b1408 | b1408-lean-reaim-per-build | fbc9ad2a | RB1 RB2 RB3 RB4 RB5 |
| b1416 | b1416-loop-checks-after-rebase | abe2d073 | RB1 RB2 RB3 |
| b1417 | b1417-lanes-show-finish-pr | abe2d073 | LP1 LP2 |

## Replays: SB2 and SB3 plus port invariants
- Implement replay-builder.mjs and replay-planner.mjs, sharing small helpers in replay-common.mjs. Import crew modules relative to this checkout, never an archived or operator-specific worktree. No new dependencies.
- CLI: `node bench/replay-{builder,planner}.mjs --lane b1380 --cell cell.json --arms fff,readgate --out /absolute/new-run`. A cell JSON names agent, model, effort, optional advisor (agent/model/effort), and optional wait_s; arms are explicit, including an empty list. Document supported combinations; let seat adapters refuse unsupported combinations rather than dropping arms. Do not hard-code chosen models into execution logic.
- Export import-safe `runBuilder(options, deps={})` and `runPlanner(options, deps={})`; options are `{lane,cell,arms,out}`, with cell already parsed. CLI calls these same functions. Each catches failures and writes out/result.json with a nonempty string `error`; CLI exits nonzero for failure. Empty session.jsonl and diff.patch should still exist for failed attempts when an output dir can safely be established.
- Each entry calls shared `validateArms(arms)` inside its error-recording boundary before setup/seat execution. Closed vocabulary: readgate, lab, builderloop, reminders, skeletonread, subagent, fff. Reject any unknown name (including mixed lists and prototype names) with `unknown arm: <name>`. Never filter unknown arms away.
- Test seams: `deps.prepareRun` overrides worktree/context preparation; `deps.runAcpSeat` overrides the seat call. Validation precedes both. A prepareRun that throws must produce result.json.error and must not call the seat. Importing modules must not execute CLI or load model clients unnecessarily.
- Prepare an isolated detached worktree at manifest.base under out/tree, a task dir and journal run-start under out, rewrite originalTask/originalTree references in copied inputs/prompts, and give the seat only these paths. Preserve pre-parity scope backfills for b1380/b1381 and gate_cmd backfill from arms2. Planner starts with a fresh task dir, not the recorded solution.
- Builder: replay its first prompt with named cell/advisor/arms; collect envelope, runGate, proveMutations after a green gate, touched *.test.mjs tests (include untracked files), diff including additions, timing/usage/errors and advisor journal rows. Planner: replay its first prompt, collect envelope, red baseline/failing ids, repo-write count and journal/usage. Do not build a planner's solution to prove its mutations; its bench measures the first planner turn.
- Always persist result.json, diff.patch and session.jsonl, including setup, seat, check, test and cleanup errors. Use try/finally to remove replay worktrees on every exit and record failed cleanup. Refuse unsafe/existing output destinations and destinations within corpus, checkout, or ~/.crew unless all writes are contained in the explicit output root. Keep seat runtime under out; no writes to operator configuration.

## SB4: blinded reviews
- Implement blind-review.mjs for `--kind diff|plan --out <reviews-dir> --key <separate-file> <run-dirs...>`, using Sol review (configurable reviewer executable for tests). Port both original review rubrics, shuffle jobs, generate collision-free random codes, and never expose cell/run identifiers or input paths to the reviewer.
- Export import-safe `prepareReviews({runs,kind,out,keyPath})`, returning an array of jobs with `code`. It stages coded contexts and diff or plan/gate artifacts under out, writes a JSON object mapping code -> absolute input run directory only to keyPath, and rejects a keyPath inside out (including symlink aliases). Use result.json.lane plus corpus manifests, not run-directory naming assumptions. This preparation performs no git or model calls.
- Keep the unique key destination statement `const keyFile = resolve(keyPath)` in blind-review.mjs; use keyFile for the actual write. Review output files, contexts, jobs and logs must contain no code-to-run key or source run identities. Scrub run task/tree paths in plans/gates/diffs; do not copy result.json/session metadata to review inputs.
- Execution consumes prepared jobs: create disposable worktrees under out, apply coded diffs or stage coded plan/gate files, invoke Sol with the proper base/context, capture coded review output and failures, and always clean up. Keep every review's error/result visible; never silently omit an input.

## Tests and gate contract
- Add bench/replay.test.mjs and bench/blind-review.test.mjs with node:test and temporary fixtures/injected boundaries; no models, network, global ~/.crew writes or real recorded results. Check corpus JSON/prompt completeness, both replay validators (unknown, mixed, prototype names, known and empty), CLI failure recording, prompt rewrites/backfills, success/check failures/cleanup, output confinement, coded diff and plan reviews, key separation and unsafe key aliases.
- Gate SB1 checks all eight files per lane, exact manifest bases and original paths, expected acceptance and prompt/envelope coherence. SB2/SB3 call the actual exported entry points with a throwing prepareRun spy and a seat spy, checking unknown arms are refused first and valid arms reach preparation; verify result.json errors. SB4 calls prepareReviews for diff and plan fixtures, verifies the separate key and scans review files for identity leaks; rejects an inside key.
- Preserve one unique literal `validateArms(arms)` in each replay entry file (not in comments). Mutations change it to validateArms([]), change b1380's manifest base from 1d282ec7 to 00000000, and redirect blind-review's keyFile into out/key.json. These are real behavioral defects, not test toggles.
- Validation lane: `node --test bench/replay.test.mjs bench/blind-review.test.mjs`. Gate command: `node /Users/momoshell/.crew/dt-b1433-seat-bench/b1433-seat-bench/task/gate.mjs` with checkout cwd. The outer loop runs baseline, build, mutation proof, suite and delivery; planner runs none of those stages.
