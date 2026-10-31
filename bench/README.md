# Seat benches

Reusable replays for choosing seat models and arms. A replay reruns a recorded lean lane's first
builder or planner turn at the lane's base commit with a seat you name; a blind review then scores
the results without knowing which seat made which. Nothing here records results: output dirs are
yours, outside the repo. What past runs decided is under "Results so far" below.

- `corpus/<lane>/` — frozen inputs for seventeen lanes: fourteen code lanes (b1380, b1381,
  b1402, b1408, b1416, b1417, b1440, b1441, b1442, b1444, b1448, b1450, b1451, b1454),
  plus b1457, b1458 and b1459:
  `plan.md`, `gate.mjs`, `planner-1.json`, `lean.json`, `brief.md`, `planner-prompt.txt`,
  `builder-prompt.txt` (the first recorded prompts, verbatim) and `manifest.json`
  (`base` commit, and the `originalTask` / `originalTree` paths the prompts cite; the replays
  rewrite those to the run's own dirs). The replays only read it. The eight new code lanes
  (b1440–b1454 as listed above), the b1457 docs/manifests,
  b1458 visualizer skills, and b1459 skills exhibits lanes are frozen from their
  `~/.crew-journal-archive/dt-<lane>-*/<id>/task` archives. If a first planner prompt is
  unavailable, `plannerPromptMissing` in the manifest gives the reason; planner replay refuses
  before creating a worktree, while builder replay remains available. An absent prompt also refuses.
- `replay-builder.mjs`, `replay-planner.mjs`, `replay-common.mjs`, `blind-review.mjs`.
- `replay.test.mjs`, `blind-review.test.mjs` — `node --test bench/*.test.mjs`; no models or network.

## Cell and arms

A cell is a small JSON file naming the seat; arms are named on the command line. Nothing is
hard-coded in the scripts.

```json
{ "agent": "claude", "model": "anthropic/claude-sonnet-5-5", "effort": "high",
  "advisor": { "agent": "pi", "model": "openai/gpt-6.1-sol", "effort": "medium" },
  "wait_s": 3600, "settle_s": 120, "skills": ["code-less"] }
```

`agent`, `model`, `effort` are required; `advisor`, `wait_s` (seat timeout, default 3600) and
`settle_s` (seconds to wait after the seat for the advisor's last journal rows, default 120, only
with an advisor) are optional. Which agent/model/effort combinations work is up to
`crew/acp/seat.mjs`, which refuses the rest. Optional `skills` must be a list of nonempty,
non-whitespace strings. It is forwarded unchanged, including order and duplicates; an omitted or
empty list grants no skills. No live-seat defaults are added.

`--arms` is a comma list drawn from `readgate, lab, builderloop, reminders, skeletonread, subagent, fff`
(`crew/protocols.mjs` `EXTENSIONS`); `--arms ""` is no arms. An unknown name is refused, recorded
in `result.json`, before any worktree or seat exists.

## Reviewer replay

```
node bench/replay-reviewer.mjs --lane b1441 --cell cell.json --arms fff --out /abs/clean --variant clean
node bench/replay-reviewer.mjs --lane b1441 --cell cell.json --arms fff --out /abs/seeded --variant seeded --mutation PK1
```

The reviewer sees the archived first reviewer prompt and built change. The manifest pins the
successful rebase commit; its single parent becomes HEAD after a mixed reset, leaving the built
snapshot as tracked and untracked changes. The commit and its parent must be available locally
(full history may be needed). b1380 and b1444 have no archived reproducible built head; b1440
also lacks a reviewer prompt. These lanes are refused before creating a worktree.

A seeded run selects exactly one planner mutation by check ID. Its file must be a regular file
inside the worktree, with one literal match and no symlink traversal. Clean rejects a mutation.
The reviewer is not told which variant or mutation was selected. The replay does not run the
gate, suite or mutation proof. The worktree is removed after the seat, including on errors.
Output directories follow the same safety restrictions as the other replays.

`result.json` records the variant, full seeded declaration or null, first return status, verdict,
findings, usage and wall time. `seededFileCited` measures a must-fix finding naming the exact
seeded file, not the verdict. Unknown measurements are null with a reason in `unknown`; clean
runs use `not-seeded` for that field. Run `node --test bench/replay.test.mjs
bench/replay-reviewer.test.mjs` for local tests without models or network.

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

To replay with a different planner charter:

```
node bench/replay-planner.mjs --lane b1380 --cell cell.json --arms "" --out /abs/new/dir --charter crew/agents/planner.md
```

`--charter` replaces the recorded prompt before its first `Definition source:` line with the named
agent definition's body, without its frontmatter. The source line and suffix stay unchanged except
for the usual task and tree path rebasing. A missing source line or a definition refused by
`parseAgent` stops the replay before worktree or seat creation. Without the option, the recorded
prompt is used as before. `result.json.charter` records the supplied filename, or null.

To include team memory in a planner replay:

```
node bench/replay-planner.mjs --lane b1380 --cell cell.json --arms "" --out /abs/new/dir --memory /abs/store
```

The rendered section is appended to the prompt after any charter substitution; `result.json.memory` records the directory,
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
exit 0. builderloop now hints once on that failure (PR 2080).

**sed hint on a Claude sonnet builder, 2026-10-31** (builderloop off vs on, 6 lanes × 3, blind diff review).
none: 12/18 pass, 3.28M tokens, median 43s. builderloop: 11/18 pass, 3.51M tokens (+7%), median 45s. A
`sed -i` failed in 4 runs without the hint and 6 with it, and the hint reached all 6 (the arm's saved
`sedHinted` state; it arrives as added context, so the session transcript never shows it). After that first
failure neither arm failed `sed -i` again (0 of 1 later calls without the hint, 0 of 4 with it). With the hint,
4 of 6 runs switched to `sed -i ''`; without it, 1 of 4 did. The hint changes the edit method and prevents no
failure, because it can only follow the first one. Must-fix counts are not given: 7 of the 13 `changes`
reviews have no `Must-fix (N)` header.

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

**Skill grants and fff on the planner, 2026-10-31 and 11-01** (pi sol high with `subagent`, 14 code lanes × 3
per arm, strict blind plan review). The first batch ran on 6 lanes and the second on the 8 lanes added in PR
2097; the second put all three arms in one shuffled batch.

| Planner | 6 lanes | 8 new lanes | Pooled | Tokens, pooled |
|---|---|---|---|---|
| no skills | 3/18 | 5/24 | 8/42 | 10.45M |
| + `qa-test-writing` | 6/18 | 3/24 | 9/42 | 15.19M (+45%) |
| + fff | 6/18 | 3/24 | 9/42 | 11.38M (+9%) |

The granted planner read `qa-test-writing/SKILL.md` in 42 of 42 runs, so a grant is delivered and read; it
just did not move the score. The lane decides it: b1440 passed in 8 of 9 runs, and 7 of the 8 new lanes passed
in 3 of 63. The fff arm made 104 fff calls and no calls to the native grep tool, which the control used
instead; it still ran `rg` or `grep` through Bash 8 times. Neither is granted.

**`prose-plain` on a pi terra builder** (`code-less` alone vs `code-less` + `prose-plain`, sol advisor,
blind diff review). On the doc lanes b1457, b1458 and b1459 (3 each): 8/9 vs 9/9 pass, 5.36M vs 5.23M
tokens, and the skill was read in 9 of 9 runs. On the 8 new code lanes (3 each): 18/24 vs 18/24 pass, the same
lanes failing in both arms, 3.68M vs 3.40M tokens, and the skill was read in 3 of 24 runs. The builder seat
grants it since PR 2096. Must-fix counts are not given: the reviews state them in at least four formats.

**A planner charter paragraph, 2026-11-01** (pi sol high with `subagent`, 14 code lanes × 3 per arm, `--charter`,
one blind plan batch). Both arms used main's `crew/agents/planner.md`; the trial arm added one paragraph after
the gate rules telling the planner to try to break its own gate (test input edges, drive the caller the brief
names, cover retries and later turns, run the code its claims rest on, make sure a correct build can go green).

| Planner charter | First return `done` | Blind pass | Tokens | Median wall |
|---|---|---|---|---|
| main | 42/42 | 8/42 | 10.64M | 137s |
| main + the paragraph | 0/42 | 9/42 | 17.87M (+68%) | 210s |

Every trial planner's first, unvalidated return was `insufficient`: the paragraph asks it to run code, the
planner seat refuses Node commands, and it reported the verification it could not do. What a lane would then
do (repair turns, the lead) was not replayed. The blind review sees only `plan.md` and `gate.mjs`, never the
return status, so its 9/42 says nothing about usable returns; read a plan bench with its status counts. b1441,
b1442 and b1444 drew a must-fix in 3 of 3 runs in both arms. Not shipped. Return status in the benches above:
`qa-test-writing` 42/42 `done`, fff 40/42 (2 `insufficient` on 11-01).
