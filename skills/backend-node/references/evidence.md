# Evidence register

Every backed rule in this skill points to a resolving source or test anchor.

The register below records enforcement gaps rather than pretending they are
covered by the nearest passing check.

## Rules with no exhibit

### No repository-wide import scan

The zero-dependency assertion is per module, not a whole-repository sweep.
Exhibit for that limitation: `crew/pi/extensions/subagent.test.mjs:169`.

No checkout-wide import scan was found in the cited enforcement shape.

A new module therefore needs a test of its own; the existing assertion cannot
prove an unseen module stayed on `node:` imports.

This is an enforcement gap, not a claim that the module rule lacks evidence.

### TypeScript constructs outside the grep

The extension test searches `enum` and `namespace`.
Exhibit: `crew/pi/extensions/subagent.test.mjs:174` and `crew/pi/extensions/subagent.test.mjs:175`.

It does not grep `parameter properties`.

It does not grep decorators.

Those constructs are caught only when the module import executes.
Exhibit: `crew/pi/extensions/subagent.test.mjs:8`.

No separate repo test was found for either spelling.

Keep these absences visible until a measured check is added.

Do not upgrade the gap to “covered” because the TypeScript header names it.

A future checker must update this register and the erasable-syntax test together.

Unknown or interrupted loader results remain indeterminate until observed.

### Import-firewall interrupted reads

No dedicated local test distinguishes an interrupted daemon source read from an
empty import list while checking an allowlisted leaf.

The firewall test does pin the leaf's normal import-free state at
`crew/daemon.test.mjs:253`; the interrupted-read edge remains unbacked.

Keep that edge marked unbacked in `import-firewall.md` until a mutation pins it.

### Fail-closed import-scan errors

No dedicated source exhibit or mutation test covers a failed import-list read or
parse returning an empty result.

The synchronous import assertions throw through the test harness on a read
failure, but that behavior has not been measured as its own rule.

Keep the fail-closed instruction in `zero-dep.md` marked unbacked until a test
pins EPERM, unknown, interrupted, and empty import-scan outcomes.

### CLI parser interruption and missing values

No dedicated local test or source exhibit was found for an interrupted flag parse
or for a flag whose value is missing at the end of argv.

The refusal and accepted-window directions are measured in
`test/factory-ledger.test.mjs:2813` and `:2620`; these two edges remain separate.

Keep those two CLI edge rules in `cli-flags.md` marked unbacked until a test
pins interrupted parsing and missing-value behavior.

### TypeScript import interruption and empty source

No local mutation test isolates an interrupted TypeScript import or an empty
extension source from the ordinary loader failure.

The import at `crew/pi/extensions/subagent.test.mjs:8` catches syntax failures,
but it does not separately measure those two edge outcomes.

Keep those edge rules in `erasable-ts.md` marked unbacked until measured.

### Usage interruption and failed parse

No local mutation test separately measures an interrupted child or a malformed
usage parse after work has started.

The complete-or-absent getter and omitted-key assertion are backed at
`crew/pi/extensions/subagent.ts:394` and `crew/pi/extensions/subagent.test.mjs:468`.

Keep interrupted-child and failed-parse instructions in `usage-records.md`
marked unbacked until those paths receive a measured fixture.

The register is deliberately narrow: it does not erase the exhibits carried by
the six rule references.

Record a new search here when a proposed rule has no local exhibit.
