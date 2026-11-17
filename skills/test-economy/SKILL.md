---
name: test-economy
description: Use when building changes that touch test files and choosing or running the plan's tests.
---

# Test economy

A lane adds no test by default, in every checkout. Two exceptions:

- A bug fix gets one regression test.
- A change where a failure would lose data, cross a security boundary, or break a
  wire or file format another program reads gets one test when no existing test
  already covers that path.

When the brief's ask is itself to add or change tests, the ask governs. Repairing
or removing an existing test that the change breaks is maintenance, not an added
test. A mechanical builder applies this rule without a plan.

Make the change first, then write only the tests the plan names. An unplanned
added test needs an applicable exception in `notes`. Where a test is called for,
add an assertion or table row to an existing test that already drives the path
before writing a new test, unless the plan names a new test or file. Reuse
existing fixtures and helpers; do not add a helper or fixture for one test.

Test behaviour the change adds or alters, not unchanged behaviour, prose,
wording, lint or facts a type guarantees. Use the smallest case that fails on the
old source, table-driven for several cases. Each named test must compile against
the old source and reach new behaviour through a surface it already has, such as
a route, a registered name or an existing public function.
Do not call a function the change adds or use a new test module under `src/` that
only the change declares. A named test's title must be the name the proof runner
reports. For an in-source Rust test, use the full module path, such as
`registry::wiring_tests::X`; the short title `X` matches nothing.

## Node tests

Use `node:assert/strict` for assertions. Run a named test with
`node --test --test-name-pattern 'test title' path/to/file.test.mjs`.
Establish a red run on the old source and a green run after the change. Red
must come from the test's own assertion: an import error, failing hook, skip,
cancel or missing result leaves the test unproven.
