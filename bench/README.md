# Seat benches

Reusable replays for choosing seat models and arms. A replay reruns a recorded lean lane's first
builder or planner turn at the lane's base commit with a seat you name; a blind review then scores
the results without knowing which seat made which. Nothing here records results: output dirs are
yours, outside the repo. What past runs decided is under "Results so far" below.

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

To include team memory in a planner replay:

```
node bench/replay-planner.mjs --lane b1380 --cell cell.json --arms "" --out /abs/new/dir --memory /abs/store
```

The rendered section is appended to the recorded prompt; `result.json.memory` records the directory,
included and dropped entries, bytes and reason. Without `--memory` the prompt is unchanged. A store
that renders nothing is recorded as an error and no seat is called. This option is planner-only.

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

## Results so far

What the benches decided, so the next model choice starts from it. Raw runs live outside the repo
under `~/.crew/ab/` (`adv`, `arms`, `arms2`, `lab`); none of it is measured again here.

**Builder, 2026-10-30.** Six lanes × 3 per arm, one shuffled blind batch of 108 diff reviews. Every
arm had 18/18 green gates and 60/60 mutations killed, so the blind review is the only signal.

| Builder | Blind pass | Must-fix | Tokens | Median wall |
|---|---|---|---|---|
| sonnet, Claude Code | 11/18 | 7 | 3.24M | 59s |
| sonnet, pi bridge | 9/18 | 8 | 3.36M | 58s |
| sonnet, pi bridge + fff, readgate, skeletonread | 9/18 | 9 | 3.86M | 61s |
| terra, pi | 12/18 | 6 | 3.35M | 36s |
| terra, pi + fff, readgate, skeletonread | 12/18 | 6 | 2.48M | 39s |
| terra, pi + fff, readgate, skeletonread + sol advisor (medium) | 15/18 | 3 | 2.83M | 52s |

The last row is the seated builder (PR 2062). For the same model the adapter made no measurable
difference (Claude Code vs the pi bridge). The read arms cut terra's tokens by 26% but added 15% on
sonnet, so measure each arm per model. N is 18 per arm; differences of one or two passes are noise.

**Single arms on a pi terra builder** (18 each, blind): none 12/18, readgate 12/18, skeletonread
13/18, fff 13/18, builderloop 11/18. builderloop never fired: no edit failed in any run.

**Arms on a Claude builder.** It made 440 of 454 tool calls through Bash, so readgate, skeletonread
and builderloop had nothing to act on (0 interventions in 24 runs). fff 10/18 and fff + reminders
9/18 against none 11/17, tokens unchanged. reminders told seats without an fff grant to use fff
(4 of 6 runs); PR 2070 fixed that.

**Read arms on a Claude builder, 2026-10-30, after the Read-tool steer** (PR 2075; 6 lanes × 3, blind diff
review). none: 11/18 pass, 13 must-fix, 3.11M tokens, median wall 39s. readgate + skeletonread: 9/18 pass,
13 must-fix, 4.10M tokens (+32%), median wall 48s. The steer worked: 42 Bash reads were refused and the seat
made 117 Read calls. But neither arm then acted: 0 range refusals and 0 skeletons, because Claude reads each
file once and whole. On terra the same arms cut tokens by 26%. Keep them off Claude seats.

**How a Claude builder edits** (209 sessions from the benches above):

| Method | Edits | Failed |
|---|---|---|
| Bash python heredoc | 393 | 1 |
| Bash `sed -i` | 82 | 48 |
| Edit tool | 60 | 0 |
| Write tool | 18 | 0 |

Every failed `sed -i` was a GNU-style script under BSD sed. All 48 were chained after `cd T;`, and 46 reported
exit 0. builderloop now hints once on that failure (PR 2080); the hint itself is not yet benched.

**Planner memory, 2026-10-31** (pi sol high with `subagent`, 6 lanes × 3, `--memory` with a fresh 6-entry store
rendering 4,072 bytes, strict blind plan review). none: 4/18 pass, 17 must-fix, 5.07M tokens, median 153s.
memory: 6/18 pass, 11 must-fix, 6.12M tokens (+21%), median 168s. The planner followed the store: all 18
memory gates carried `// MUTATION:` comments, against 0 of 18 without it. Per run, cached prompt re-reads
grew by 56k tokens, uncached input by 1.5k and output by 1k, so the cost is the roughly 1k-token section
re-read on each of about 50 calls. It scales with store size. The planner seat declares `memory: true`.

**Advisor on a Claude sonnet builder** (6 lanes × 3): none 12/18, terra 10/18, sol 8/18, at +12% and
+27% tokens. In 33 of 36 advisor runs it said nothing, so the pass gap is noise. When made blocking
on medium findings (PR 2059), each of the 3 runs in 12 where it raised a real finding passed blind
review. Recall, not precision, is its limit.

**Planner, pi sol high** (18 each, strict blind plan review): plain 3/18 (12 must-fix, 4.90M tokens),
readgate 6/18 (11, 5.46M), fff 4/18 (10, 5.06M). The lab arm was granted and never called, at +31%
tokens. A sol advisor on the planner injected 0 notes in 21 consults (blind 4/18 vs 5/18), so it is off.
