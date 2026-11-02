---
name: test-strength
description: Use when reviewing tests for a changed behaviour and deciding whether they prove it.
---

# Test strength

Check whether the test is vacuous: would it pass with the behaviour absent?
An unreachable fixture, an expected value taken from the implementation, or a
detector's key as its only guard can make a test pass without proving the rule.
Trace the input to the subject and check the expected value is independent.

Check that red is for the right reason. The failure must come from the test's
own assertion, not an import error, failing hook or unrelated throw. A skip,
cancel or missing result proves nothing.

Name a plausible broken implementation and check that the assertion would
fail on it. Prefer one good test of the property to coverage for its own sake.
Report findings in the shape required by `pr-review`.
