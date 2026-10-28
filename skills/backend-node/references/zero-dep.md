# Zero-dependency backend modules

Keep a backend module's external imports on the `node:` builtin boundary.
Exhibit: `crew/pi/extensions/subagent.test.mjs`.

The extension test reads one source file and collects its import specifiers.
It then requires every specifier to start with `node:`, except a named
first-party pair. Exhibit: `crew/pi/extensions/subagent.test.mjs`.

That assertion is per module, not a repo-wide import scan. A new module needs
its own import check; another module's green check is not coverage for it.

Use a first-party exception only when the test enumerates each admitted path.
Keep the list literal enough that a reviewer can compare it with the module.
Exhibit: `crew/pi/extensions/subagent.test.mjs` admits `../../adapters/adapter-pi.mjs`
and `../context-layout.mjs` by name.

Keep this boundary on runtime-file imports rather than package metadata.

A missing import is an empty result, not proof that the scan ran correctly; the
subagent test asserts the collected list is non-empty before it checks it.

A failed read or parse is recorded as an unbacked fail-closed edge here; see
`evidence.md`.

Unknown specifier forms require an explicit decision before they enter a list;
the specifier scan reads static `from` clauses only.

When a first-party edge is allowed, pin that target's own leaf property too. See
`import-firewall.md` for that second boundary.
