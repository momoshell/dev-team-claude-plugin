# Zero-dependency backend modules

Keep a backend module's external imports on the `node:` builtin boundary.
Exhibit: `crew/pi/extensions/subagent.test.mjs:171`.

The extension test reads one source file and collects its import specifiers.
Exhibit: `crew/pi/extensions/subagent.test.mjs:171`.

It then requires every collected specifier to start with `node:`.
Exhibit: `crew/pi/extensions/subagent.test.mjs:173`.

That assertion is per module, not a repo-wide import scan.
Exhibit: `crew/pi/extensions/subagent.test.mjs:171`.

A new module needs its own import check; another module's green check is not
coverage for it.
Exhibit: `crew/pi/extensions/subagent.test.mjs:171`.

Use a first-party exception only when the test enumerates each admitted path.
Exhibit: `test/factory-intake.test.mjs:1115`.

The factory intake test collects that module's static `from` specifiers.
Exhibit: `test/factory-intake.test.mjs:1114`.

An allowlist is a deliberate admission, not permission for arbitrary packages:
`scripts/factory/intake.mjs` admits exactly `'./ledger.mjs'` and
`'./make-brief.mjs'`, and the test names that pair in its own title.
Exhibit: `test/factory-intake.test.mjs:1109`.

Keep the list literal enough that a reviewer can compare it with the module.
Exhibit: `test/factory-intake.test.mjs:1115`.

Keep this boundary on runtime-file imports rather than package metadata.
Exhibit: `crew/pi/extensions/subagent.test.mjs:171`.

A missing import is an empty result, not proof that the scan ran correctly.
Exhibit: `crew/pi/extensions/subagent.test.mjs:171`.

A failed read or parse is recorded as an unbacked fail-closed edge here; see
`evidence.md` for the search result.

Unknown specifier forms require an explicit decision before they enter a list;
the specifier scan reads static `from` clauses only, so the dynamic form is
refused separately rather than silently unscanned.
Exhibit: `test/factory-intake.test.mjs:1112`.

The measured convention is cheap because the test imports the subject directly.
Exhibit: `crew/pi/extensions/subagent.test.mjs:171`.

The cost of skipping it is paid at process startup, when the backend loads.

When a first-party edge is allowed for a leaf exception, pin that target's own
leaf property too; intentional non-leaf helpers such as `crew/headless-rpc.mjs`
are outside this rule.
Exhibit: `crew/daemon.test.mjs:255`, `crew/daemon.test.mjs:257`, and
`crew/daemon.test.mjs:259`.

See `import-firewall.md` for that second boundary.
The source and its test are the maintenance surface for future dependency changes.
