# Vacuity: checks that cannot fail

A vacuous check passes whether the behaviour it names is present or absent. It
is worse than no check, because it is trusted.

Measured in this repo by the `b131-vacuity` scout (2026-08-22, issue #476):
**12 candidates examined, 9 vacuous, 3 proven-discriminating — 75%**, with the
neutralisation recorded for every one. The ratio is quoted with its denominator
on purpose; "several tests are weak" is not a finding.

## The method: mutation, not reading

You cannot see vacuity by reading. Neutralise the behaviour and re-run.

Do it in a **disposable scratch tree, never the working checkout**:

```bash
git worktree add --detach /tmp/vac HEAD          # see the warning below
cd /tmp/vac
FORCE_COLOR=0 node --test <the affected test file>   # confirm GREEN first
# ...apply the mutation...
FORCE_COLOR=0 node --test <the affected test file>   # did it go red?
cd - && git worktree remove /tmp/vac              # it is a real worktree: remove it
```

**Use a detached worktree, not `git archive`.** Measured over seven scratch
strategies (`b150-permprobe`, 2026-08-22): `git archive HEAD | tar -x` produces
a tree that is **not a git repo**, so repo identity resolves to the scratch
directory's name and the profile tests fail — **2051 pass / 33 fail** on an
unmutated tree. Every other strategy leaves at least one failure too. Only
`git worktree add --detach` reproduces the real baseline, **2084/0**, and it is
also the fastest to create (52 ms, 7.11 MiB). A detached worktree shares the
object store and **must be removed**, unlike an archive you can `rm -rf`.

Confirm green **before** mutating. A scratch that was already red proves
nothing, and this is the step people skip — it is also what catches a bad
scratch strategy before it wastes an afternoon.

Two independent scratches beat one: the b131 sweep ran every candidate twice,
which is what makes its ratio quotable rather than anecdotal.

Pair the neutralisation with a **direct probe** showing the behaviour really is
gone. A mutation you believe worked, but did not, reads exactly like a
discriminating check.

## The three shapes

### 1. The fixture cannot reach the subject

The assertion is fine; the input never exercises the code.

- **V9** — a check pinned a sort, over a fixture that **was already sorted**.
  Removing the sort left it green.
- **V3** — a stale-reaping check never reached the `guardedKill` seam, because
  the integration fixture returned first. The kill seam could be bypassed with a
  green suite. `guardedKill` exists because a bare-PID kill reparents a process
  group instead of killing it — a real boundary, unpinned.

**The fix changes the FIXTURE, not the assertion.** Strengthening an assertion
over input that never arrives produces a more confident vacuous check.

### 2. The expected value comes from the implementation

The check compares the implementation to itself.

- **V7** — a mirror check compared `MODIFIER_KINDS` to `MODIFIER_KINDS`.
  Removing a member changed both sides.
- **V8** — a loop iterated exactly the keys the implementation produced, then
  asserted each was produced.

**The fix takes the expected value from somewhere the implementation cannot
edit**: a literal written out in the test, a committed fixture, a recorded
capture.

### 3. The detector's key is the only guard

A drift guard that greps for a literal is blind to every spelling that is not
that literal.

- **V5** — the ledger-sandbox tripwire keys on the literal `openRun(`. Measured
  blind to: an alias, an indirect caller, a block comment, a JSDoc body, a
  template literal, and an assignment pointing *at* the real ledger. Defeated in
  the sweep by aliasing.

V5 was hit independently by **three scouts on disjoint briefs in one batch**
(`b130-postmerge`, `b131-vacuity`, `b132-contention`). Convergence from
independent angles is a strong signal; treat it as one.

**The fix pins the detector itself**, or replaces the key with something drift
cannot rename.

This repository's own documentation had the same shape: the anchor pin was the
only guard on 220 prose citations, and it read existence and range, never
content. `anchor-pin.mjs` is the fix; see `references/citations.md` for the
citation rule it enforces.

## The three verified negatives

Recorded so no later sweep re-spends them — these **do** discriminate:

- the billed-money null assertion (`shape.mjs:220` null→zero reddens)
- the transcript drift guard **for the `tools` literal itself** (adding `Agent`
  reddens)
- the direct `guardedKill` helper assertion (`reap-stale.mjs:58` → `false`
  reddens)

Note V4/N2 as a pair: that guard genuinely pins `tools` and does **not** pin
`deny` at all. A check can discriminate for one field and be vacuous for the
field beside it. Establish which field you are pinning.

## What to do with a vacuous check

Either make it redden when the behaviour is removed, or **delete it and say what
it was supposed to stop**. Do not delete checks to move a number.

The two from the sweep that were more than test debt — the builder's
`deny: NO_FANOUT` boundary and the `guardedKill` seam — are the argument for
this whole file: both are security-shaped boundaries that could have been
deleted with a fully green suite.

## Not in scope of a vacuity pass

"There is no test for X" is a coverage gap, not vacuity. A vacuity pass is only
about checks that **cannot fail**. Keep them separate; they have different fixes
and different urgency.
