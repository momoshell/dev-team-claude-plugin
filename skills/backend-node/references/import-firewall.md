# First-party admissions and leaf pins

Treat an allowlist of first-party imports as a narrow firewall, not as a
dependency graph.

The subagent extension admits builtins and exactly two first-party paths.
Exhibit: `crew/pi/extensions/subagent.test.mjs`.

The admitted adapter is then read and its own imports are asserted to be
`node:`-only, so the admission cannot become a transitive escape hatch.
Exhibit: `crew/pi/extensions/subagent.test.mjs` (the adapter-imports assertion).

The adapter under test is `crew/adapters/adapter-pi.mjs`.

The admission and the leaf assertion are separate checks. A new admitted leaf
therefore needs two edits: the allowlist entry and its import-free assertion.

An unknown import is a refusal, not an invitation to broaden the list.

Do not replace the leaves with a barrel import or a convenience runner.

An interrupted source read cannot establish leaf status; keep that outcome
visible to the test harness instead of converting it into approval.
Status: this interrupted-read edge is unbacked in this checkout; see
`evidence.md`.

When an admission is removed, remove its leaf assertion in the same measured
change and let the test show the boundary moved.
