# Mutation proof

Per-check proof is a destructive-looking operation with a recoverable contract.
The b73-pane revert trap is the reason the first step is not optional: commit
the built tree **before** any `git checkout -- <file>`. On an escalated lane,
`HEAD` may still be the pre-lane commit, so a checkout before the commit wipes
the only built tree.

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

## What the driver does

`completeCheckProof` mutates the built tree **in place**, runs the gate, and
restores the exact original in a `finally`. That is why an uncommitted lane has
no safe revert: even though the driver restores its own edit, a manual
`git checkout --` restores `HEAD`, not the uncommitted build. Keep the commit,
its worktree, and the preserved state copy until every declaration has a
measured outcome.

When inspecting gate or suite output, suppress the harness colour layer first;
any grep must be prefixed with `FORCE_COLOR=0`:

```sh
FORCE_COLOR=0 node <gate-command> | grep -E '^(ok|FAIL|GATE-SUMMARY)'
FORCE_COLOR=0 npm test | grep -E '^(pass|fail|GATE-SUMMARY)'
```

A survivor is not a pass: record whether the mutation was killed, survived,
unapplied, or interrupted, and never promote an unreadable or interrupted run
to a green proof.
