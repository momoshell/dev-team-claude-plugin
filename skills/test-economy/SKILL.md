---
name: test-economy
description: Use when building changes that touch test files and choosing or running the plan's tests.
---

# Test economy

Make the change first, then write only the tests the plan names. A test the plan
does not name needs a reason in `notes`.

Test behaviour the change adds or alters, not unchanged behaviour, prose,
wording, lint or facts a type guarantees. For each property, write one small
test: the smallest case that fails on the old source. Put several cases for
one property in one table-driven test. Extend an existing test file and reuse
its fixtures and helpers; do not add a helper or fixture for one test. Each named
test must compile against the old source and reach new behaviour through a surface
it already has, such as a route, a registered name or an existing public function.
Do not call a function the change adds or use a new test module under `src/` that
only the change declares.

## Node tests

Use `node:assert/strict` for assertions. Run a named test with
`node --test --test-name-pattern 'test title' path/to/file.test.mjs`.
Establish a red run on the old source and a green run after the change. Red
must come from the test's own assertion: an import error, failing hook, skip,
cancel or missing result leaves the test unproven.
