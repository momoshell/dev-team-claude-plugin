# Absent is not zero

A zero is a measurement; absence means no measurement was obtained. Never
fabricate zero for an unknown value. An unmeasured value is `null` with one
closed reason (CLAUDE.md, honesty doctrine). Where a contract has no reason
field yet, as the subagent usage below, say so; do not treat that as the rule.

## Live usage contract

In `crew/pi/extensions/subagent.ts`, `createStreamReducer` exposes complete
usage or null when unmeasured. Internal details may contain `usage: null`;
the public result omits the `usage` key when unmeasured. The pre-spawn budget
refusal writes a journal row with `usage: null` via `usageRow`. It is not a
measured zero. See `crew/pi/extensions/subagent.test.mjs`, especially `usage is
a complete pi Usage or absent, never partial` and `the journal records exactly
one row per spawn`.

## Complete-or-absent and pinning

Partial token or cost records can be mistaken for complete ones. Pin both an
unmeasured absence and a genuinely measured zero, so neither can be silently
converted into the other. When a reason exists, explain what was missing and
why; an emitter that never ran is an absence, not a failed write. Distinguish
retired counts from genuinely empty ones when reporting them; the old doctor
example is historical, with no live exhibit.
