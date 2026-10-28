# Acceptance gates

An acceptance gate is a program the planner authors per task, which the loop
runs (`runGate` in `crew/checks.mjs`). It is the task's definition of done, expressed as something that runs.

## The four properties

1. **RED at baseline.** The gate must fail on the tree before the work lands. A
   gate that is green at baseline accepts a tree that has not changed.

2. **`errored: 0` at baseline.** Red is not enough. A gate that *crashes* also
   reports failure, and a wholly broken gate — a syntax error, a bad import —
   passes a naive baseline-red check while testing nothing. This is #153: the
   baseline check proved the gate **exited**, not that it **ran**. The gate
   prints `GATE-SUMMARY {"total":n,"failed":n,"errored":n}` and `errored` must be
   `0` at baseline.

3. **Discrimination is proved by the loop, once per gate version** — not
   asserted in prose in the brief (#168). A gate that claims to discriminate and
   was never made to, is a claim.

4. **Every declared mutation kills its own check.** Declare `{check, file, find,
   replace}` for each acceptance id; `proveMutations` in `crew/checks.mjs` applies
   it in a scratch copy and requires that check to go red. The `find` must occur
   exactly once in the file.

A failing check must print `FAIL <label>` ending the line, or `FAIL <label>: <why>`. Nothing else matches. The strict separator prevents a shorter check label from falsely matching a longer prefix label.

## Mechanics that bite

- **Resolve the repo from `process.cwd()`.** A gate that hard-codes a path runs
  against the wrong tree in a worktree.

- **Never assert the checkout is clean.** The gate runs mid-work by design.

- **Require no bespoke environment.** Every check must pass with no bespoke environment, because that is how `npm test` and CI run it.

- **Strip ANSI before parsing.** If the gate shells out to the suite, the
  harness may export `FORCE_COLOR`, which beats `NO_COLOR`, and `node --test`'s
  summary becomes unparseable — a green gate reads as red (#240). See
  `references/tooling.md`.

- **Commit the built tree before reverting a mutation proof.** `git checkout --`
  after a manual mutation wipes an escalated lane's work. Commit first, then
  revert.

- **The gate runs in a git-free tree.** `proveMutations` in `crew/checks.mjs`
  copies the tree for every mutation, and for its green preflight, without the
  top-level `.git`. A gate that shells out to `git` (`git grep`, `git ls-files`,
  `git diff`) exits with "not a git repository" there and cannot complete the
  proof, even when it works at baseline and after the build. Inspect the
  filesystem rooted at `process.cwd()` instead.

- **An absence check must distinguish "no match" from "the search broke."**
  Read each file with `readFileSync` and test it with `includes`. A path that
  is missing throws `ENOENT`, which is the search breaking: let it propagate
  rather than reading it as clean. A tool that signals "no match" through exit
  status (`grep`) makes the check error exactly when the criterion is
  satisfied, because `execFileSync` throws on a non-zero exit. `errored` and
  `failed` are different columns in `GATE-SUMMARY`: an errored check is not a
  failed check, and the loop refuses a baseline with either one non-zero
  (#581, PR #577).

An absence check MUST be demonstrated red by ADDING the thing it forbids, not merely observed red at baseline.
"red at baseline" is not evidence for an absence check when it can be red by ERRORING instead of failing.

### The absence-check shape (copy this)

Copy this self-contained shape; it imports only node built-ins, needs no git
metadata, and runs in the scratch copy the loop proves mutations in:

```js
    import { readFileSync } from 'node:fs'
    import { join } from 'node:path'
    const REPO = process.cwd()
    // PATHS are repo-relative files. A missing file throws ENOENT: the search broke, not "clean".
    const hits = PATHS.filter((path) => readFileSync(join(REPO, path), 'utf8').includes(NEEDLE))
    if (hits.length) return `expected no reference to ${NEEDLE}, found in ${hits.join(', ')}`
```

To cover a directory, list it with `readdirSync(dir, { recursive: true })` and
keep the files you mean to read. Do not walk `node_modules` or `.git`.

Wrong — shells out to git, which the proof copy does not have:

    // WRONG: throws "not a git repository" inside proveMutations' scratch copy.
    execFileSync('git', ['grep', '-c', '-F', '-e', NEEDLE, '--', ...PATHS], { cwd: REPO })

Pair the absence check with a positive control: the same read for a needle
that MUST be present in a file that must exist, failing loudly if it is not.
An empty `PATHS`, or a path list that names the wrong files, is otherwise
byte-identical to a genuine absence.

## The proof loop

```
baseline  → gate runs, exits non-zero, GATE-SUMMARY errored: 0
mutate    → the behaviour the check names is neutralised
re-run    → the specific check reddens (not merely "the suite is red")
restore   → the tree is back
```

"The suite went red" is not a discrimination proof if you cannot say *which*
check reddened and that it was the one naming that mutation.

## Where the gate's author is outside the crew

In the `directed` variant the orchestrator authors the gate, so a defective gate
**escalates** rather than being repaired by a seat that never wrote it. That is
deliberate: a seat repairing someone else's acceptance criteria is a seat
editing the definition of done.
