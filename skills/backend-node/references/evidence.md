# Evidence register

Every backed rule in this skill points to a resolving source or test anchor.

The register below records enforcement gaps rather than pretending they are
covered by the nearest passing check.

## Rules with no exhibit

### No repository-wide import scan

The zero-dependency assertion is per module, not a whole-repository sweep.
Exhibit for that limitation: `crew/pi/extensions/subagent.test.mjs`.

No checkout-wide import scan was found in the cited enforcement shape.

A new module therefore needs a test of its own; the existing assertion cannot
prove an unseen module stayed on `node:` imports.

This is an enforcement gap, not a claim that the module rule lacks evidence.

### TypeScript constructs outside the grep

The extension test searches `enum` and `namespace`.
Exhibit: `crew/pi/extensions/subagent.test.mjs`.

It does not grep `parameter properties`.

It does not grep decorators.

Those constructs are caught only when the module import executes.
Exhibit: the module import in `crew/pi/extensions/subagent.test.mjs`.

No separate repo test was found for either spelling.

Keep these absences visible until a measured check is added.

Do not upgrade the gap to “covered” because the TypeScript header names it.

A future checker must update this register and the erasable-syntax test together.

Unknown or interrupted loader results remain indeterminate until observed.

### Import-firewall interrupted reads

No dedicated local test distinguishes an interrupted adapter source read from an
empty import list while checking an admitted leaf.

The subagent test does pin the adapter's normal node-only state in
`crew/pi/extensions/subagent.test.mjs`; the interrupted-read edge remains
unbacked.

Keep that edge marked unbacked in `import-firewall.md` until a mutation pins it.

### Fail-closed import-scan errors

No dedicated source exhibit or mutation test covers a failed import-list read or
parse returning an empty result.

The synchronous import assertions throw through the test harness on a read
failure, but that behavior has not been measured as its own rule.

Keep the fail-closed instruction in `zero-dep.md` marked unbacked until a test
pins EPERM, unknown, interrupted, and empty import-scan outcomes.

### CLI parser interruption and missing values

No dedicated local test was found for an interrupted flag parse, a missing
`--checkout` value, duplicate flags or unknown flags.
`main` in `crew/start.mjs` owns the vocabulary, usage and refusal text/status,
and success status. In `crew/start.test.mjs`, `main reports usage, refusals and success as exit codes`
asserts no-argument/two-brief usage statuses and a refusal, not success or exact
usage text. `throwing injected loggers do not change start metadata or main status`
asserts that a valid `--checkout` start returns 0. The `--check` refusal and exact
usage text are no longer pinned by a test.

Keep the other edge rules in `cli-flags.md` marked unbacked until a test pins them.

### TypeScript import interruption and empty source

No local mutation test isolates an interrupted TypeScript import or an empty
extension source from the ordinary loader failure.

The module import in `crew/pi/extensions/subagent.test.mjs` catches syntax failures,
but it does not separately measure those two edge outcomes.

Keep those edge rules in `erasable-ts.md` marked unbacked until measured.

### Usage interruption and failed parse

No local mutation test separately measures an interrupted child or a malformed
usage parse after work has started.

`createStreamReducer`, the `execute` result construction and `usageRow` in
`crew/pi/extensions/subagent.ts` own the complete-or-absent and journal-null
contract; no test pins that whole contract. In `crew/pi/extensions/subagent.test.mjs`,
`every pre-spawn refusal is bounded, payload-free, spawns nothing and journals nothing`
and `the child is spawned under a deadline that escalates to SIGKILL` assert
public-key absence only on their selected refusal and timeout paths. They do not
assert reducer usage or `usage: null` in a budget-refusal journal row.

Keep interrupted-child and failed-parse instructions in `usage-records.md`
marked unbacked until those paths receive a measured fixture.

The register is deliberately narrow: it does not erase the exhibits carried by
the rule references.

Record a new search here when a proposed rule has no local exhibit.
