# Acceptance gates

The planner authors the acceptance gate for each task. It expresses the
acceptance criteria as runnable checks.

1. The gate must be red at baseline, with no errors: a crash is not a failed
   acceptance check. If the harness reports `errored: 0`, require it at baseline.
2. Prove discrimination for each gate version by mutation, not a claim in prose.
3. Every declared mutation must kill its own named check. Where the harness uses
   `{check, file, find, replace}`, require the find text to occur exactly once.
4. A failing check must print `FAIL <label>` at end of line or `FAIL <label>: <why>`;
   the separator prevents matching a longer label as a shorter one.

Resolve the target from the invocation working directory, not a hard-coded
checkout. Do not require a clean checkout or bespoke environment. Inspect the
filesystem without git metadata: proof copies may be git-free. Strip ANSI before
parsing suite output. Never restore a mutation by resetting unrelated work; use
a saved copy in an isolated tree.

For absence, distinguish no match from a broken search: missing files and read
errors must not pass as clean. Pair the absence check with a positive control
using the same read on a known present value, and demonstrate red by adding the
forbidden value. Empty or wrong path lists otherwise look like genuine absence.

The proof loop is baseline red without errors, build green, mutate, observe the
specific check red, restore and observe green. See the [Node recipe](node-test.md)
for filesystem mechanics and [evidence](dev-team-evidence.md#gates).
