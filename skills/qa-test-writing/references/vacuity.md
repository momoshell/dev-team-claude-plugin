# Vacuity: checks that cannot fail

A vacuous check passes whether the behaviour it names is present or absent. It
is worse than no check because it is trusted. Assert against an authoritative
stream or mutable data, not merely the presence of a service, method, key or
symbol.

Neutralise the behaviour in a disposable scratch tree, confirm green before
mutating, run the named check and observe red, then restore and confirm green.
Pair the mutation with a direct probe showing the behaviour is really gone.
Independent repetitions strengthen a measurement. Select a scratch strategy
that reproduces the target baseline; remove any worktree properly. See the
[toolchain recipes](node-test.md).

Three common shapes:

1. The fixture cannot reach the subject. Change the fixture, not the assertion.
2. The expected value comes from the implementation. Use an independent literal,
   committed fixture or recorded capture instead.
3. The detector's key is the only guard. Pin the detector itself or replace the
   key with something drift cannot rename.

A check can discriminate for one field and be vacuous for another. If it cannot
be made to fail, delete it and say what it was supposed to stop, not to move a
number. Missing coverage is a different problem from an existing vacuous check.

[Evidence](dev-team-evidence.md#vacuity).
