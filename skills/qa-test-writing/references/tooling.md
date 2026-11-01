# Running and reading the suite

Use the target repository's documented runner and dependency state. Do not
symlink dependencies into a worktree without checking its ignore and cleanliness
rules. Report when a measurement depends on installed dependencies.

Strip ANSI before parsing suite output. If the environment forces colour, turn
it off where possible; an empty grep result may be decoration rather than
absence. Set appropriate per-test timeouts and use targeted tests when a full
suite would exceed the tool timeout.

Use a disposable scratch tree for mutations. Choose a strategy that reproduces
the target's requirements, including repository identity if needed. Confirm an
unmutated green baseline, restore exact saved contents, and remove any worktree
with its proper removal command because it shares the object store.

Read the actual return envelope, session records and journal when available,
not just a roll-up. Re-derive surprising measurements independently before
acting; check process counts, lazy resources, field names, sibling state and
relative working directories.

[Evidence](dev-team-evidence.md#tooling); [node:test](node-test.md),
[cargo test](cargo-test.md), [vitest](vitest.md).
