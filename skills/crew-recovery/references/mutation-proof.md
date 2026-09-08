# Mutation proof

Before any `git checkout --`, follow the commit-first prerequisite in
[`skills/qa-test-writing/references/gates.md`](../../qa-test-writing/references/gates.md);
that file owns the rule. This reference keeps the operator sequence and the
proof's preservation contract.

## Preserve first

Before anything, preserve the uncommitted tree and untracked files:

```sh
git diff > <preserved>/tree.patch
cp -a <untracked-files> <preserved>/untracked/
```

Keep the state copy and worktree available until every mutation has a measured
outcome. A failed write, unreadable file, interrupted command, or empty output
is evidence to record, not a reason to restore from an assumed baseline.

## Read the declarations

The declarations for a hand proof come from
`returns/d1.planner.json` → `details.mutations`, never from `plan.md`. The
planner's return carries the machine-applied `{check, file, find, replace}`
records; plan prose explains intent but is not the source the driver applies.
For each record, copy the committed tree if an independent experiment is
needed, apply the literal replacement, and run only the named gate check.

A mutation kills its check only when the output matches the driver's
`checkFailureLine` rule: a bare `FAIL <check>` line or `FAIL <check>:` followed
by a delimiter-safe reason. A prefix is not enough—`FAIL cache-v2` must not
credit `cache`, and a longer label must not be mistaken for the named check.

## Detached scratch proof

Run each mutation in its own checkout made with **`git worktree add --detach`**,
not `git archive`: an archive extraction produces a tree that is not a git repo
and fails 33 tests on an unmutated checkout. The measurement and the full
comparison are owned by
[`references/vacuity.md`](../../qa-test-writing/references/vacuity.md). Confirm
the scratch tree green before mutating it. A mutation in a tree another process
is reading is #574 done to oneself; never quote a number obtained under that
race.

Do not use **`set -e`** in the proof loop: an unapplied mutation should report
and continue rather than abort mid-revert. Mutation-test every branch of a
multi-guard fix separately, and confirm with `git diff` that the mutation landed
where you think it did.

## What the driver does

`completeCheckProof` (`crew/drive.mjs:4285`) mutates the built tree **in place** and restores the exact bytes in a `finally`; that is why a hand proof needs its own detached checkout.

When inspecting gate or suite output, suppress the harness colour layer first;
any grep must be prefixed with `FORCE_COLOR=0`:

```sh
FORCE_COLOR=0 node <gate-command> | grep -E '^(ok|FAIL|GATE-SUMMARY)'
FORCE_COLOR=0 npm test | grep -E '^(pass|fail|GATE-SUMMARY)'
```

A survivor is not a pass: record whether the mutation was killed, survived,
unapplied, or interrupted, and never promote an unreadable or interrupted run
to a green proof.

## The executable form

`scripts/factory/prove-mutations.mjs` is this procedure as a program. Prefer it to
a hand loop — the loop above has been got wrong by hand, confidently:

```sh
node scripts/factory/prove-mutations.mjs --envelope <lane>/returns/d1.planner.json \
  --checkout <lane checkout> --gate 'node <lane>/task/gate.mjs'
```

It reads `details.mutations` in both the `check` and the `id` spelling, refuses
`declarations-invalid` before it runs anything when an entry cannot be read, refuses
`baseline-not-green` unless the unmutated scratch tree exits 0 AND prints a readable
summary of checks that actually ran, cuts one detached worktree per declaration,
restores the bytes in a `finally`, and refuses `tree-not-restored` when the byte
digest of the whole non-ignored checkout has moved. A red run is credited only when
the gate's own summary says checks adjudicated: a crash that prints `FAIL` is not a
kill. Each declaration reports
`killed (Nf/Ne)`, `SURVIVED`, or `BIND-FAIL(n)`; one unbound declaration never
ends the run. The summary states how many declarations were read and how many
bound, because a kill count without its denominator is not a proof. Exit 0 means
every declaration was killed or exempt, 1 that something survived, 2 a refusal.
