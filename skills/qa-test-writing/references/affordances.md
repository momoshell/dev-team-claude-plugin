# Test affordances

If you cannot express the malformed input, you have not tested the guard. A
harness must produce the hostile or malformed value that reaches the guard.
Consider raw protocol input, independent concurrent writers, torn files,
argument matrices, and checks for asymmetric fixtures. Input-producing helpers
and planned checks are different things; identify which exists before relying
on it. See [vacuity](vacuity.md) for the detector side.

[Evidence](dev-team-evidence.md#affordances); [mutation recipes](node-test.md).
