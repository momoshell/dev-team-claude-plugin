# Import firewall and leaf exceptions

Treat the daemon import list as a narrow firewall, not as a dependency graph.
Exhibit: `crew/daemon.test.mjs:238`.

The test admits builtins and a small first-party set.
Exhibit: `crew/daemon.test.mjs:238`.

The daemon's leaf exceptions—`crew/slug.mjs`, `crew/escalation-policy.mjs`, and
`crew/variants.mjs`—must remain import-free; admitted non-leaf helpers such as
`crew/headless-rpc.mjs` are outside this rule.
Exhibit: `crew/daemon.test.mjs:246`, `crew/daemon.test.mjs:248`, and
`crew/daemon.test.mjs:250`.

`crew/slug.mjs` must stay import-free.
Exhibit: `crew/daemon.test.mjs:246`.

`crew/escalation-policy.mjs` must stay import-free.
Exhibit: `crew/daemon.test.mjs:248`.

`crew/variants.mjs` must stay import-free.
Exhibit: `crew/daemon.test.mjs:250`.

These three checks are separate from the allowlist assertion.
Exhibit: `crew/daemon.test.mjs:238`.

The separation matters: the daemon can admit a leaf only while its leaf
property is still observed.
Exhibit: `crew/daemon.test.mjs:246`.

Do not replace the leaves with a barrel import or a convenience runner.
Exhibit: `crew/daemon.test.mjs:213`.

The firewall also counts dynamic imports and keeps one computed adapter load.
Exhibit: `crew/daemon.test.mjs:256`.

A new allowlisted leaf exception therefore needs two edits: the admission and
its import-free assertion.
Exhibit: `crew/daemon.test.mjs:238`, `crew/daemon.test.mjs:246`,
`crew/daemon.test.mjs:248`, and `crew/daemon.test.mjs:250`.

An unknown import is a refusal, not an invitation to broaden the list.
Exhibit: `crew/daemon.test.mjs:238`.

An interrupted source read cannot establish leaf status; keep that outcome
visible to the test harness instead of converting it into approval.
Status: this interrupted-read edge is unbacked in this checkout; see
`evidence.md`.

The test's own wording is the operational contract for future contributors.
Exhibit: `crew/daemon.test.mjs:246`.

Review the leaf and the caller together because either side can widen reach.
Exhibit: `crew/daemon.test.mjs:238`.

This rule protects daemon startup from accidental runner coupling.
Exhibit: `crew/daemon.test.mjs:213`.

The cost of skipping the leaf pin is paid by every daemon process that loads it.
Exhibit: `crew/daemon.test.mjs:246`.

When a leaf exception is removed, remove its leaf assertion in the same measured
change and let the test show the boundary moved.
Exhibit: `crew/daemon.test.mjs:246`, `crew/daemon.test.mjs:248`, and
`crew/daemon.test.mjs:250`.
