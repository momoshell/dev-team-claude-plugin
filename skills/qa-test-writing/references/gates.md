# Acceptance gates

An acceptance gate is a program the planner authors per task, which the driver
executes. It is the task's definition of done, expressed as something that runs.

## The four properties

1. **RED at baseline.** The gate must fail on the tree before the work lands. A
   gate that is green at baseline accepts a tree that has not changed.

2. **`errored: 0` at baseline.** Red is not enough. A gate that *crashes* also
   reports failure, and a wholly broken gate — a syntax error, a bad import —
   passes a naive baseline-red check while testing nothing. This is #153: the
   baseline check proved the gate **exited**, not that it **ran**. The gate
   prints `GATE-SUMMARY {"total":n,"failed":n,"errored":n}` and `errored` must be
   `0` at baseline.

3. **Discrimination is proved by the driver, once per gate version** — not
   asserted in prose in the brief (#168). A gate that claims to discriminate and
   was never made to, is a claim.

4. **Every declared mutation kills its own check.** Name the mutation beside the
   check, and demonstrate it reddens.

## Mechanics that bite

- **Resolve the repo from `process.cwd()`.** A gate that hard-codes a path runs
  against the wrong tree in a worktree.

- **Never assert the checkout is clean.** The gate runs mid-work by design.

- **Strip ANSI before parsing.** If the gate shells out to the suite, the
  harness may export `FORCE_COLOR`, which beats `NO_COLOR`, and `node --test`'s
  summary becomes unparseable — a green gate reads as red (#240). See
  `references/tooling.md`.

- **Commit the built tree before reverting a mutation proof.** `git checkout --`
  after a manual mutation wipes an escalated lane's work. Commit first, then
  revert.

- **An absence check must distinguish "no match" from "the search broke."**
  `git grep` — like `grep`, and any tool that signals "no match" through exit
  status — exits 1 on zero matches, and `execFileSync`/`execSync` throw on a
  non-zero exit, so such a check
  **errors exactly when the criterion is satisfied**. A violating gate lets
  that throw escape and the builder's success arrives as a crash; a correct
  one catches, keeps exit 1 with empty stdout as the pass, and rethrows
  everything else —
  collapsing the two is worse than the original bug, because a broken search
  then reads as clean. `errored` and `failed` are different columns in
  `GATE-SUMMARY`:
  an errored check is not a failed check, and the driver refuses a baseline
  with either one non-zero (#581, PR #577).

An absence check MUST be demonstrated red by ADDING the thing it forbids, not merely observed red at baseline.
"red at baseline" is not evidence for an absence check when it can be red by ERRORING on the no-match status.

### The absence-check shape (copy this)

Call the shared helper `scripts/factory/absence.mjs` instead of hand-rolling `git grep`.

The gate lives outside the repo tree, so import the helper by absolute path; the gate lives in the task dir, not the repo tree, and the repo root comes from `process.cwd()`:

```js
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'

    // the gate lives in the task dir, not the repo tree, so the import is by path
    const REPO = process.cwd()
    const { absenceFailure } = await import(pathToFileURL(join(REPO, 'scripts/factory/absence.mjs')).href)
    const failure = absenceFailure({ needle: NEEDLE, paths: ['crew/', 'scripts/'], cwd: REPO })
    if (failure) return failure
```

Wrong — the throw lands precisely when the criterion is met:

    // WRONG: throws on zero matches, i.e. exactly when the check should pass.
    const hits = execFileSync('git', ['grep', '-c', '-F', '-e', NEEDLE, '--', ...PATHS],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (hits) return `expected no reference to ${NEEDLE}, found ${hits}`

Right — exit 1 with empty stdout is the pass; every other failure still throws:

    // RIGHT: 1 is "no match"; 128 (bad pathspec magic, not a repo) stays fatal.
    let hits
    try {
      hits = execFileSync('git', ['grep', '-c', '-F', '-e', NEEDLE, '--', ...PATHS],
        { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (err) {
      // no match: exit 1 with empty stdout is the PASS
      if (err?.status !== 1) throw err
      hits = String(err.stdout ?? '').trim()
    }
    if (hits) return `expected no reference to ${NEEDLE}, found ${hits}`

The shared helper applies this catch-and-rethrow shape for you; pair it with the positive control below.

Exit 1 does not prove the search looked where you meant. A pathspec naming a
directory that does not exist also exits 1 with empty stdout **and empty
stderr** — byte-identical to a genuine no-match (measured, git 2.55.0). Pair
the absence check with a positive control: the same search for a needle that
MUST match, failing loudly if it does not.

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
