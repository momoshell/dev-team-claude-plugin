# Seat benches

Reusable replays for choosing seat models and arms. A replay reruns a recorded lean lane's first
builder or planner turn at the lane's base commit with a seat you name; a blind review then scores
the results without knowing which seat made which. Nothing here records results: output dirs are
yours, outside the repo.

- `corpus/<lane>/` — frozen inputs for six lanes (b1380, b1381, b1402, b1408, b1416, b1417):
  `plan.md`, `gate.mjs`, `planner-1.json`, `lean.json`, `brief.md`, `planner-prompt.txt`,
  `builder-prompt.txt` (the first recorded prompts, verbatim) and `manifest.json`
  (`base` commit, and the `originalTask` / `originalTree` paths the prompts cite; the replays
  rewrite those to the run's own dirs). The replays only read it.
- `replay-builder.mjs`, `replay-planner.mjs`, `replay-common.mjs`, `blind-review.mjs`.
- `replay.test.mjs`, `blind-review.test.mjs` — `node --test bench/*.test.mjs`; no models or network.

## Cell and arms

A cell is a small JSON file naming the seat; arms are named on the command line. Nothing is
hard-coded in the scripts.

```json
{ "agent": "claude", "model": "anthropic/claude-sonnet-5-5", "effort": "high",
  "advisor": { "agent": "pi", "model": "openai/gpt-6.1-sol", "effort": "medium" },
  "wait_s": 3600, "settle_s": 120 }
```

`agent`, `model`, `effort` are required; `advisor`, `wait_s` (seat timeout, default 3600) and
`settle_s` (seconds to wait after the seat for the advisor's last journal rows, default 120, only
with an advisor) are optional. Which agent/model/effort combinations work is up to
`crew/acp/seat.mjs`, which refuses the rest.

`--arms` is a comma list drawn from `readgate, lab, builderloop, reminders, skeletonread, subagent, fff`
(`crew/protocols.mjs` `EXTENSIONS`); `--arms ""` is no arms. An unknown name is refused, recorded
in `result.json`, before any worktree or seat exists.

## Builder replay

```
node bench/replay-builder.mjs --lane b1380 --cell cell.json --arms fff --out /abs/new/dir
```

Makes a detached worktree at the lane's base under `<out>/tree`, gives the seat the recorded plan,
gate and planner return (with the scope and `gate_cmd` backfills the older lanes need), runs the
first builder prompt, then the gate, the mutation proof (only after a green gate) and the touched
`*.test.mjs` files. Writes `result.json`, `diff.patch` (including added files) and `session.jsonl`.
The worktree is removed on every exit.

Reading `result.json`: `error` is `null` for a clean run, otherwise a string naming each failed
stage (`seat:`, `gate:`, `mutations:`, `tests:`, `cleanup:`…). `gate.status` is the built tree's
gate; `mutations.killed` of `mutations.of` is the proof; `targeted.pass/fail` the touched tests;
`envelope` the builder's return; `usage`, `wallS`, `armRows` (journal row kinds) and `advisor`
(notes, usage, consults, `blocked` pre-return stops) say what the seat did; `changed` and `diff`
size the change. A red gate or a surviving mutation is a result, not an error; a gate or mutation proof
that comes back `unmeasured` (timeout, spawn or copy failure) is recorded in `error`, with its reason and diagnostics.

## Planner replay

```
node bench/replay-planner.mjs --lane b1380 --cell cell.json --arms subagent,fff --out /abs/new/dir
```

Same shape, for the first planner turn from a fresh task dir (the recorded plan is withheld). After
the turn it runs the planner's own gate once on the unchanged tree: `gate.baseline` should be `red`
and `gate.failing` should list every acceptance id (`envelope.acceptance`). `repo_writes` counts
files the planner wrote into the checkout (should be 0); `envelope.mutations` counts declared
mutations (not proved here); `kinds`, `scouts`, `lab_runs`, `advisor` summarize the journal.

## Blind review

```
node bench/blind-review.mjs --kind diff --out /abs/reviews --key /abs/elsewhere/key.json RUN_DIR...
node bench/blind-review.mjs --kind plan --out /abs/reviews --key /abs/elsewhere/key.json RUN_DIR...
node bench/blind-review.mjs --reveal --out /abs/reviews --key /abs/elsewhere/key.json
```

Run dirs are replay outputs (the lane comes from each `result.json`). `--kind diff` reviews each
`diff.patch` against the lane's plan; `--kind plan` reviews each planner run's `plan.md` and
`gate.mjs` against the brief. Jobs are shuffled and given random codes; the reviews dir holds only
coded contexts, patches/plans, `review-<code>.txt`, `result-<code>.json`, `jobs.json` and
`results.json`. The code → run key goes only to `--key`, which must be outside `--out`.
`--reveal` joins codes back to runs (lane, verdict, error). Each review runs in a disposable
worktree; every job gets a result row, failures included (`status: error`). Count must-fix findings
in each `review-<code>.txt` and the `REVIEW-VERDICT` line. Options: `--reviewer <exe>` (default
`$SOL_REVIEW` or `~/.crew/tools/sol-review`), `--concurrency <n>` (default 3), `--prepare-only`.

The reviewer runs with `HOME` set to `<out>/.reviewer-home`: your home entries (and `~/.crew`, bar
`reviews`) are linked in so tools and auth resolve (the `--key` file is left out, and a directory holding it is
staged with its other entries linked, so the reviewer cannot reach the key), but `sol-review`'s own artifact pair lands in
`<out>/.reviewer-home/.crew/reviews`, not in the real `~/.crew/reviews`. Both `--out` and `--key` must be
new paths outside the checkout, the corpus and `~/.crew`; a key path that already exists (a symlink
included) is refused and the key is created exclusively.

Scrubbing removes the run's task/tree/run paths from staged text. A diff whose own context lines
cite those paths will not apply after scrubbing and shows as an error row, not a silent skip.

## Safety

`--out` must be a new absolute path outside this checkout, the corpus and `~/.crew`. Replays write
only under it (seat runtime in `<out>/seat-runtime`). A cell file that is missing or malformed, a seat
turn that returns a refusal or no stop reason, a missing or malformed return envelope, a planner that wrote no plan.md or gate.mjs, and an unknown arm are all recorded in `result.json.error`
and exit nonzero.
