# Plan: rerun gate and suite after a head-moving rebase

## Goal
Make the published (or finish-ready) head a tree the gate and suite last passed on.
Only `crew/loop.mjs` changes behaviour; only `crew/loop.test.mjs` changes tests.
Do not edit `crew/checks.mjs`, `crew/finish.mjs`, the visualizer, skills or docs.

## Current flow (inspected)
- Pre-rebase suite, with its red-retry/repair logic: `crew/loop.mjs:363-398`.
- Commit, fetch, rebase: `crew/loop.mjs:418-428`. `rebaseBranch` already returns the
  new head (`rebased.head`); `commitChanges` already returns `committed.head`.
- Finish report + `finish-ready`, then publish, currently run unconditionally
  after the rebase: `crew/loop.mjs:430-445`.
- Test fakes: commit head is `'a'.repeat(40)`, default rebase head is
  `'b'.repeat(40)`: `crew/loop.test.mjs:65-74`.

## Minimal change: `crew/loop.mjs`
Insert exactly one block immediately after the rebase result is validated
(`crew/loop.mjs:427-428`) and before the `if (isFinish)` report block
(`crew/loop.mjs:430-438`) and publish (`crew/loop.mjs:439-445`). Use these
exact lines (the gate mutations bind to them):

```js
    if (rebased.head !== committed.head) {
      const postGate = await stage('gate', () => callCheck('gate', d.runGate, { cwd, gatePath, timeoutMs }, { command: true }))
      if (postGate.status !== 'green') return stop(postGate.reason, postGate)
      const postSuite = await stage('suite', () => callCheck('suite', d.runSuite, { cwd, command: spec.suite.command, args: spec.suite.args, timeoutMs: spec.suite.timeoutMs ?? timeoutMs }, { command: true }))
      if (postSuite.status !== 'green') return stop(postSuite.reason, postSuite)
    }
```

Notes:
- Gate first, then suite (same order and same `callCheck`/`stage` seams, suite
  args and timeout forwarding as `crew/loop.mjs:363-364`), so a red or
  unmeasured post-rebase check stops with that check's own reason via the
  existing `stop(...)`, before `finish-ready` is written/emitted and before
  `openPullRequest` is called. No new reason codes, no staging (the rebased
  tree is committed and clean), no body/measurement rewrite: `body` was built
  pre-commit and the green reruns keep its gate/suite lines true; the reruns
  are journaled by `stage`/`callCheck` like every other check.
- Unchanged head (`rebased.head === committed.head`): block skipped, zero
  extra gate/suite runs.
- Do not reuse the pre-rebase suite repair loop: a post-rebase red is not a
  builder-repair event; it stops the lane (RB2).

## Tests: `crew/loop.test.mjs`
1. In `fakes()` (`crew/loop.test.mjs:65-74`), change the default rebase head
   from `'b'.repeat(40)` to `'a'.repeat(40)` (same as the commit head) so the
   existing green-run, stage-order, journal and finish tests keep exercising
   the unchanged-head path; update the one finish assertion that expects
   `ready.head` `'b'.repeat(40)` (`crew/loop.test.mjs:1045-1048`) to
   `'a'.repeat(40)`. Existing tests that fail at/before rebase are unaffected.
2. RB1 test: `fakes({ rebase: { status: 'green', reason: null, head: 'b'.repeat(40) } })`
   (plus a finish-shape twin) — assert done, gate and suite each called twice,
   the second gate/suite occur after `rebase` and before `publish`
   (standard) / before the report write and `finish-ready` row (finish).
3. RB2 test: moved head with a sequenced suite answering green, then red
   (reuse the `sequenced` helper at `crew/loop.test.mjs:454-466`, extended as
   needed so post-rebase reds stay red) — assert `stopped('exit-nonzero')`,
   no `publish`, and in the finish shape no report write / no `finish-ready`.
   Add the gate twin: sequenced gate green then red after a moved rebase —
   assert `stopped('gate-failed')`, no publish.
4. RB3 test: unchanged head (default fakes) — assert done/published with the
   suite (and gate) called exactly once.
5. Name the new tests with `(RB1)`, `(RB2)`, `(RB3)` and a `// MUTATION:` line
   each, in the file's existing style. Watch existing assertions that count
   stages/checks/calls (e.g. `crew/loop.test.mjs:83-100`, `crew/loop.test.mjs:640-650`):
   they run on the now-unchanged default head, so they should not change.

## Validation
- Gate: `node /Users/momoshell/.crew/dt-b1416-loop-checks-after-rebase/b1416-loop-checks-after-rebase/task/gate.mjs` (red on the unchanged tree: RB1, RB2).
- Suite lane: `node --test crew/loop.test.mjs`.
