# Import firewall and leaf exceptions

Treat the daemon import list as a narrow firewall, not as a dependency graph.
Exhibit: `crew/daemon.test.mjs:221`.

The test admits builtins and a small first-party set.
Exhibit: `crew/daemon.test.mjs:221`.

An admitted module must remain a leaf or the exception becomes transitive.
Exhibit: `crew/daemon.test.mjs:228`.

`crew/slug.mjs` must stay import-free.
Exhibit: `crew/daemon.test.mjs:228`.

`crew/escalation-policy.mjs` must stay import-free.
Exhibit: `crew/daemon.test.mjs:230`.

`crew/variants.mjs` must stay import-free.
Exhibit: `crew/daemon.test.mjs:232`.

These three checks are separate from the allowlist assertion.
Exhibit: `crew/daemon.test.mjs:221`.

The separation matters: the daemon can admit a leaf only while its leaf
property is still observed.
Exhibit: `crew/daemon.test.mjs:228`.

Do not replace the leaves with a barrel import or a convenience runner.
Exhibit: `crew/daemon.test.mjs:195`.

The firewall also counts dynamic imports and keeps one computed adapter load.
Exhibit: `crew/daemon.test.mjs:238`.

A new allowlisted module therefore needs two edits: the admission and its
import-free assertion.
Exhibit: `crew/daemon.test.mjs:221` and `:228`.

An unknown import is a refusal, not an invitation to broaden the list.
Exhibit: `crew/daemon.test.mjs:221`.

An interrupted source read cannot establish leaf status; keep that outcome
visible to the test harness instead of converting it into approval.
Status: this interrupted-read edge is unbacked in this checkout; see
`evidence.md`.

The test's own wording is the operational contract for future contributors.
Exhibit: `crew/daemon.test.mjs:228`.

Review the leaf and the caller together because either side can widen reach.
Exhibit: `crew/daemon.test.mjs:221`.

This rule protects daemon startup from accidental runner coupling.
Exhibit: `crew/daemon.test.mjs:195`.

The cost of skipping the leaf pin is paid by every daemon process that loads it.
Exhibit: `crew/daemon.test.mjs:228`.

When an exception is removed, remove its leaf assertion in the same measured
change and let the test show the boundary moved.
Exhibit: `crew/daemon.test.mjs:221` and `:228`.
