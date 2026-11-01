# Vendor stream captures

A test for a reducer over a vendor's event stream uses a recorded capture, never
hand-built frames. A fixture encodes what you believe the format is, but that
belief is precisely what needs testing.

Run a real session through the path to pin. Inspect what the session preserves;
if raw frames are absent, capture them at the vendor transport boundary. Trim
whole lines, never fields, preserve provenance and commit the fixture beside the
test. Pin both the frames carrying the subject's own data and real frames that
must be excluded. Capture and prove each vendor adapter separately. Where
reducers share a rule, assert agreement behaviourally over one fixture table.

[Evidence](dev-team-evidence.md#captures); [mutation recipes](node-test.md).
