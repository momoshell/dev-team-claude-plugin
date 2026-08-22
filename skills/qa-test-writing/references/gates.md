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
