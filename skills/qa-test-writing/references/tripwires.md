# Tripwires and scope

Find tests that pin the write surface before editing. A change that alters a
detector owns whatever it newly flags. Run the widened detector before the build
and include newly flagged files in the plan. When code moves, include affected
source-grep tests as well as behavioural tests.

List files rather than bare directories unless the whole directory is meant.
Declare new files in the write surface and name related existing files. Changes
to enforcement may need a higher review tier; decide at planning time.

[Evidence](dev-team-evidence.md#tripwires); [mutation recipes](node-test.md).
