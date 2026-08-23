# s4-tests — test-suite inspection register

Read-only recon. Checkout `/Users/x/Development/dt-s4-tests` @ `5a8d76a`, node v26.5.1.
Zero files changed (`git status --porcelain` empty at start and at return).

Measured baseline, this run: `node --test --test-timeout=30000 --test-concurrency=1`
→ **2171 pass / 0 fail, 136,816 ms** wall. All durations below are `duration_ms`
from that single clean sequential run (no estimates). A second, per-file run was
taken but is **discarded as contaminated** — it ran concurrently with four recon
subagents and reported 228,753 ms of summed wall time against the same suite's
136,816 ms. Only the clean run is quoted.

---

## 0. Suite composition (facts the rest of the register rests on)

- 51 `*.test.mjs` files, 43,116 lines.
- `test/helpers.mjs` is **5 lines** and exports exactly one symbol, `ROOT`
  (`test/helpers.mjs:5`). `test/fixtures.mjs` is 33 lines and exports two,
  `assertSlugStable` and `testCheckout` (`test/fixtures.mjs:19,27`).
- Ten files import `ROOT`; **no** `crew/*.test.mjs`, `skills/**` or `commands/*`
  file does. One file (`crew/crew.test.mjs:36`) imports `testCheckout`.
  That is the entire current reach of the shared-helper layer.

### F0 — `test/fixtures.mjs` and `test/helpers.mjs` are executed as test files

`node --test` treats every file under a directory named `test/` as a test file.
Both helper modules are therefore *run*, contribute one "passing test" each, and
account for 2 of the 2171:

```
tap-seq.txt:12211  ok 44 - test/fixtures.mjs      duration_ms: 28.957
tap-seq.txt:12241  ok 46 - test/helpers.mjs       duration_ms: 28.680
```

Neither declares a test. The count is inflated by two and any future helper added
to `test/` inherits the same phantom pass. Evidence: those two names appear in the
run stream but in no per-file TAP output (attribution: 51/51 files matched,
2169 tests attributed, exactly these 2 unattributed).

---

## 1. Duplicated helpers — proposed home `test/helpers.mjs` / `test/fixtures.mjs`

Detected mechanically: every top-level `function` in all 51 files, body normalised
(comments stripped, whitespace collapsed) and SHA-1 grouped. Two groups follow:
byte-identical bodies in ≥2 files, and same-name-different-body (drifted copies).

### D1 — `sqliteAvailable()` · **8 copies across 8 files** · highest file-count win

Two normalised variants, same semantics. Both copies quoted:

`crew/daemon.test.mjs:47`
```js
function sqliteAvailable() {
  try {
    require('node:sqlite')
    return true
  } catch { return false }
}
```
`test/visualizer-server.test.mjs:16`
```js
function sqliteAvailable() { try { require('node:sqlite'); return true } catch { return false } }
```
Other six: `test/factory-ci-repair.test.mjs:21`, `test/factory-ci-watch.test.mjs:22`,
`test/factory-emit.test.mjs:34`, `test/factory-ledger.test.mjs:49`,
`test/visualizer-shape.test.mjs:16`, `test/visualizer-teardown.test.mjs:14`.
Six of the eight also re-derive the identical skip string
``` `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})` ```.
**Proposed home:** `test/fixtures.mjs`, exporting `SQLITE_SKIP` (the computed
skip reason) rather than the predicate — the predicate is never wanted alone.
**Files that shrink: 8.**

### D2 — `git()` / `gitResult()` · **7 `git` copies, 6 distinct bodies** · worst drift

`crew/arms.test.mjs:20`
```js
function git(repoDir, ...args) {
  return execFileSync('git', [
    '-c', 'user.email=crew@example.invalid',
    '-c', 'user.name=Crew Test',
    '-c', 'protocol.file.allow=always',
    '-C', repoDir, ...args,
  ], { encoding: 'utf8' }).trim()
}
```
`crew/harvest.test.mjs:15` — same body **without** the trailing `.trim()`
(callers compensate: `crew/harvest.test.mjs:52` writes `git(run,'rev-parse','HEAD').trim()`).
`crew/seat-io-runclean.test.mjs:24` — same, **missing** `protocol.file.allow=always`.
`test/factory-ci-repair.test.mjs:50` and `test/factory-ci-watch.test.mjs:40` — byte-identical
to each other, using `spawnSync` and returning the whole result.
`test/factory-probe-repo.test.mjs:60` — same shape, different identity
(`probe@example.invalid` / `Probe Test`).
`test/factory-make-brief.test.mjs:48` — takes `args` as an array, asserts `status === 0`,
and configures **no identity at all** (relies on the ambient git config).
`gitResult()` is byte-identical in `crew/arms.test.mjs:29` and `crew/harvest.test.mjs:24`.
**Proposed home:** `test/fixtures.mjs`, one `git(repoDir, ...args)` + `gitResult(...)`
pair with the identity and `protocol.file.allow` baked in.
**Files that shrink: 7.** This is the one duplicate where the copies have already
drifted into semantic differences, so it is ranked first for correctness, not size.

### D3 — `makeWorld()` / `withWorld()` git-world fixture · 4 + 3 copies

`withWorld` is byte-identical in `crew/arms.test.mjs:89` and `crew/harvest.test.mjs:68`:
```js
function withWorld(fn) {
  const world = makeWorld()
  try { return fn(world) } finally { world.done() }
}
```
`makeWorld` has 4 bodies (`crew/arms.test.mjs:38`, `crew/harvest.test.mjs:33`,
`test/factory-ci-repair.test.mjs:98`, `test/factory-ci-watch.test.mjs:49`); the arms and
harvest pair share the same skeleton — `mkdtempSync` → `git init -q -b main` → seed
file → commit → `rev-parse HEAD` → `worktree add` → `{ ref(), refs(), done() }`.
**Proposed home:** `test/fixtures.mjs` `gitWorld({ prefix })`, returning the
`ref/refs/commit/done` surface; arms and harvest keep only their domain extras.
**Files that shrink: 4.** See also §4-S1: this fixture is rebuilt 25× in
`crew/arms.test.mjs` and 15× in `crew/harvest.test.mjs`, so a shared home is also
where the caching would live.

### D4 — byte-identical bodies, one line of import instead

| helper | copies | locations |
|---|---|---|
| `seedLane` (23 lines) | 2 | `test/factory-crew-watch.test.mjs:43`, `test/factory-lane-watch.test.mjs:39` |
| `capabilityRegister` (13) | 2 | `crew/capabilities.test.mjs:13`, `crew/crew.test.mjs:4042` |
| `treeDigest` (13) | 2 | `test/visualizer-returns.test.mjs:9`, `test/visualizer-server.test.mjs:22` |
| `ciValue` (12) | 2 | `test/factory-ci-repair.test.mjs:69`, `test/factory-ci-watch.test.mjs:79` |
| `ratifiedCell` (9) | 2 | `test/factory-ci-repair.test.mjs:59`, `test/factory-ci-watch.test.mjs:69` |
| `capabilityFixtureRoot` (8) | 2 | `crew/capabilities.test.mjs:27`, `crew/crew.test.mjs:4056` |
| `trackChild` (5) | 3 | `test/factory-emit.test.mjs:59`, `test/factory-ledger-floor.test.mjs:45`, `test/factory-ledger.test.mjs:311` |
| `nextRoot` (6) | 2 | `test/factory-make-brief.test.mjs:34`, `test/factory-probe-repo.test.mjs:28` |
| `world` (5) | 2 | `test/factory-crew-watch.test.mjs:37`, `test/factory-lane-watch.test.mjs:33` |
| `json` (5) | 2 | `test/visualizer-server.test.mjs:35`, `test/visualizer-teardown.test.mjs:30` |
| `stopServer` (4) | 2 | `test/visualizer-server.test.mjs:82`, `test/visualizer-teardown.test.mjs:70` |
| `journalObjects` (3) | 2 | `test/factory-crew-watch.test.mjs:71`, `test/factory-lane-watch.test.mjs:85` |
| `freshDir` (3) | 2 | `test/factory-emit-floor.test.mjs:39`, `test/factory-emit.test.mjs:54` |
| `test` (skip wrapper, 7) | 2 | `test/factory-emit-floor.test.mjs:28`, `test/factory-ledger-floor.test.mjs:33` |

Two quoted in full as proof of byte-identity:

`test/visualizer-returns.test.mjs:9` and `test/visualizer-server.test.mjs:22`
```js
function treeDigest(root) {
  const hash = createHash('sha256')
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = statSync(path)
      hash.update(name)
      if (stat.isDirectory()) walk(path)
      else hash.update(readFileSync(path))
    }
  }
  walk(root)
  return hash.digest('hex')
}
```
`crew/capabilities.test.mjs:13` and `crew/crew.test.mjs:4042`
```js
function capabilityRegister(overrides = {}) {
  const grant = (extra = {}) => ({ tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], ...extra })
  const base = {
    schema_version: 1,
    updated_at: '2026-08-17',
    roles: {
      lead: grant(), planner: grant({ requires: ['subagents'] }), builder: grant(),
      reviewer: grant(), 'tech-lead': grant(),
    },
    local_providers: {},
  }
  return { ...base, ...overrides, roles: { ...base.roles, ...(overrides.roles || {}) } }
}
```
Note `updated_at: '2026-08-17'` — a dated literal duplicated in two files is
exactly the copy that goes stale in one of them.

### D5 — same purpose, drifted bodies (consolidate second, after D1–D4)

- `announce(child)` — `test/visualizer-server.test.mjs:40`, `test/visualizer-teardown.test.mjs:36`
- `startServer(...)` — `test/visualizer-server.test.mjs:72`, `test/visualizer-teardown.test.mjs:62`
  (teardown's is a 2-arg subset of server's 7-arg version; both spawn
  `visualizer/server/server.mjs --port 0`)
- `waitFor(check, timeout)` — `crew/daemon.test.mjs:180` (timeout 5000, interval 2)
  vs `crew/factoryctl.test.mjs:90` (timeout 1000, interval 10)
- `nextDir()` — `test/factory-ledger.test.mjs:323` vs `test/factory-transcript.test.mjs:29`
  (identical but for the `l${n}` / `t${n}` prefix)
- `protectedProfile()` — `crew/crew.test.mjs:550` vs `crew/daemon.test.mjs:129`
  (differ only in `repoKeyFor({checkout})` vs `probeRepo({checkout}).repo_key`)
- `mintCrew()` — `crew/daemon.test.mjs:139` vs `crew/factoryctl.test.mjs:19`
- `returnFor()` — `crew/daemon.test.mjs:125` vs `crew/factoryctl.test.mjs:104`
- `breakerRow`/`fakeBreakerLedger` — `crew/crew.test.mjs:597` vs `row`/`fakeLedger`
  at `crew/breaker.test.mjs:13` (identical literal field set, same two ISO timestamps)
- `writeDescendantRecord` — `crew/crew.test.mjs:580` vs `writeRecord` at
  `crew/reclaim-descendants.test.mjs:50` (same defaults: `root_pid: 999999`,
  `root_start: 'old-root'`, `captures: 3`, `seat_id: 'd1'`, …)
- `profileFixture`/`seam` — `test/factory-ci-repair.test.mjs:82,123` vs
  `test/factory-ci-watch.test.mjs:92,109`
- `put` — `test/factory-make-brief.test.mjs:41` vs `test/factory-probe-repo.test.mjs:35`
- `snapshot` — `test/factory-lane-watch.test.mjs:93` vs `test/factory-probe-repo.test.mjs:104`
- `fakeChild` — `crew/pi/extensions/lab.test.mjs:18` vs `crew/pi/extensions/subagent.test.mjs:47`

**Explicitly NOT a duplicate:** the nine `fixture()` functions
(`crew/daemon.test.mjs:72`, `crew/factoryctl.test.mjs:31`, `crew/headless-rpc.test.mjs:14`,
`crew/headless.test.mjs:22`, `crew/memory.test.mjs:10`,
`crew/pi/extensions/advisor.test.mjs:8`, `crew/reclaim.test.mjs:9`,
`test/factory-make-brief.test.mjs:54`, `test/visualizer-server.test.mjs:106`) share a
name and nothing else — nine distinct domain objects. A name collision, not code.

### D6 — repo-root derivation: 12 local copies under 6 names

`test/helpers.mjs` exists to own this and is imported by 10 `test/*` files only.
Re-derived locally at: `commands/commands.test.mjs:11` (`REPO`),
`crew/crew.test.mjs:61` (`CLI_REPO_ROOT`), `crew/daemon.test.mjs:38` (`HERE`),
`crew/drive.test.mjs:204` (`REPO_ROOT`), `crew/pi/extensions/lab.test.mjs:12` (`ROOT`),
`crew/pi/extensions/subagent.test.mjs:13` (`ROOT`),
`skills/backend-node/exhibits.test.mjs:7`, `skills/devops/exhibits.test.mjs:7` (`ROOT`),
`skills/crew-dispatch/cli-contract.test.mjs:14`, `skills/pr-review/findings-shape.test.mjs:11` (`REPO`),
`test/factory-transcript.test.mjs:16` (`ROOT`), `test/version-agreement.test.mjs:21` (`root`).
**Files that shrink: 12.** Cheapest change in the register.

---

## 2. Vacuous tests — every claim demonstrated with a kill-mutation

### V1 — `crew/drive.test.mjs:4791` · `every()` over an array that is empty

Title: *"the converge seam exposes only issue creation and draft PR creation"*.
```js
const { io } = convergeRun()
assert.ok(io.calls.gh.every((call) => ['createIssue', 'createDraftPr'].includes(call.method)))
```
`[].every(...)` is `true`. Nothing asserts the seam was called at all.
**Kill-mutation it fails to catch:** `crew/drive.mjs:1678`,
`if (typeof io.createDraftPr !== 'function' || typeof io.createIssue !== 'function') return null`
→ `if (true) return null`. `convergeSettle` never runs, `io.calls.gh` stays `[]`,
this test still passes. (The source-text ban loop at `crew/drive.test.mjs:4793-4796`
is the load-bearing half of this test and does survive.)
**Honest assertion:** add `assert.deepEqual(io.calls.gh.map(c => c.method).sort(), ['createDraftPr','createIssue'])`
— presence *and* exclusivity, not exclusivity alone.

### V2 — `crew/crew.test.mjs:3981` · non-negative invariant on a monotone counter

Title: *"a degraded emitter is inert for the adapter and drive"*.
```js
assert.ok(emitter.stats().dropped >= 0)
```
`dropped` initialises to `0` (`scripts/factory/emit.mjs:429`) and is only ever
`+= 1` / `+= delta` (`emit.mjs:469, 763, 840, 847`); there is no decrement path in
the module. The predicate is true for every reachable program state.
**Kill-mutation it fails to catch:** `scripts/factory/emit.mjs:469`,
`localStats.dropped += 1` → `localStats.dropped += 0`. Drops stop being counted
entirely; `0 >= 0` still passes.
**Honest assertion:** `assert.ok(emitter.stats().dropped > 0)` — the point of the
test is that a degraded emitter *swallowed* the adapter events it was handed.

### V3 — `crew/crew.test.mjs:3300` · identity round-trip of a default parameter

Title: *"loadLadder reads the ratified bands and tier floors through the runtime seam"*.
```js
const ladder = loadLadder()
assert.equal(ladder.path, LADDER_PATH)
```
`loadLadder({ path = LADDER_PATH, ... })` (`crew/crew.mjs:704`) returns that same
`path` untouched (`crew/crew.mjs:738`). The assertion compares `LADDER_PATH` with
itself through an identity function; it can only fail if the destructuring default
is deleted.
**Kill-mutation it fails to catch:** in `crew/crew.mjs:706` read from a different
file — `raw = JSON.parse(readFile(join(HERE, 'other-ladder.json'), 'utf8'))` —
while leaving line 738 returning `path`. `loadLadder` now reads the wrong artifact
and `ladder.path` still equals `LADDER_PATH`.
**Honest assertion:** drive it through the injected seam —
`loadLadder({ path: '/x.json', readFile: (p) => { seen = p; return … } })` and assert `seen === '/x.json'`.
(The two `deepEqual`s on the next lines are not vacuous; only this line is.)

### V4 — `crew/pi/extensions/lab.test.mjs:400` · three escape tests are vacuous on the supported floor

`assertEscapeRefused` short-circuits before the denial assertion:
```js
function assertEscapeRefused(result, assertDenial) {
  assert.equal(result.details.outcome, 'refused')
  if (result.details.refused === 'net-unenforceable') {
    assert.equal(result.details.audit.net_enforceable, false)
    return
  }
  assertDenial(result.details)
}
```
It gates the three escape tests at `lab.test.mjs:411, 422, 429`
(fs-write denial, child-process denial, network denial).
`net_enforceable` is `process.allowedNodeEnvironmentFlags.has('--allow-net')`
(`crew/pi/extensions/lab.ts:220, 369`) and the module's own comment
(`lab.ts:18-23`) records the measurement: **"node v24.15.0 reports the flag absent
… whereas node v26.5.1 reports it present"**. CI pins node 24
(`.github/workflows/test.yml:15`, `node-version: "24"`), and `package.json`
declares `"node": ">=24.0.0"`.
So on the runtime that actually gates merges, all three tests take the early
return and **never execute `assertDenial`** — `details.denial.permission ===
'FileSystemWrite'`, `=== 'ChildProcess'`, `denial.code === 'ERR_ACCESS_DENIED'`
are asserted nowhere. They pass here (node 26) and are vacuous on CI (node 24).
**Kill-mutation they fail to catch on CI:** delete the `FileSystemWrite`
classification arm of `classifyDenial` in `crew/pi/extensions/lab.ts:374+`. On node 26
`lab.test.mjs:411` reddens; on node 24 it stays green.
*Caveat, stated because it changes the remedy, not the finding:* the branch is
deliberate and documented — the lab genuinely cannot serve under an unenforceable
boundary. The defect is that the test suite reports "escape denied" as proven when
it proved only "refused for an unrelated reason". The honest shape is two tests:
one asserting the `net-unenforceable` refusal, one `skip`-ped when
`net_enforceable` is false so a skipped-on-CI escape check is *visible* as skipped
rather than counted as a pass.

### V5 — `crew/daemon.test.mjs:1463` · a conjunction pinned only at its two agreeing corners

Title: *"worker state stays working until terminal result and exit marker"*.
Production: `crew/daemon.mjs:873`, `const terminal = worker.terminal && exitSeen`.
The body tests exactly two states: neither present → `'working'`
(`daemon.test.mjs:1470`), both present → `'done'` (`:1472`). The two mixed corners
— terminal-without-exit, exit-without-terminal — are never exercised.
**Kill-mutation it fails to catch:** `crew/daemon.mjs:873`,
`worker.terminal && exitSeen` → `worker.terminal || exitSeen`.
`false||false === false` and `true||true === true`, so both asserted corners are
unchanged and the test passes with the conjunction it is named for destroyed.
**Honest assertion:** add the terminal-only case (write the `result` line, no
`exit` file) and assert the state is still `'working'`.

### V6 — `test/factory-ledger.test.mjs:2755` · title names three payload fields, body seeds two and checks one

Title: *"the intake-sweeps CLI prints dispatches beside sweeps and refusals"*.
Body calls `recordIntakeSweep` and `recordIntakeDispatch`, never
`recordIntakeRefusal`; asserts only on `payload.dispatches` and
`payload.dispatch_outcomes`. The CLI payload carries a distinct `refusal_rows`
field built from `ledger.intakeRefusals()` (`scripts/factory/ledger.mjs:4158,4184`)
that this test leaves unseeded and unread.
**Kill-mutation it fails to catch:** delete `refusal_rows` from the payload object
at `scripts/factory/ledger.mjs:4184`. Green.
**Honest assertion:** seed one refusal and assert it appears in `payload.refusal_rows`.

### Vacuity shapes actively hunted and NOT found (negative results, so the next pass does not redo them)

- **Assertion-swallowing `try/catch`: none.** All 11 `} catch {}` occurrences and
  every `assert`-inside-`try` pairing were enumerated mechanically; every hit is a
  `finally`-block cleanup (`try { ledger.close() } catch {}`,
  `try { process.kill(pid,'SIGKILL') } catch {}`) at
  `crew/headless-rpc.test.mjs:750,800`, `test/factory-crew-watch.test.mjs:404`,
  `test/factory-ledger.test.mjs:318`, `test/visualizer-teardown.test.mjs:95,123,178`.
  No assertion is swallowed anywhere in the suite.
- **Degraded-path-before-lazy-open in `test/factory-ledger.test.mjs`: none.**
  Every `.degraded` / `stats().degraded` read in that file follows a real open
  attempt; `dumpTable`, `taskReadout`, `jsonlDrift` and `pragmas` all route through
  `ensureDb()` (`scripts/factory/ledger.mjs:1304-1358`) before returning.
- The suite is unusually mutation-aware: `crew/breaker.test.mjs:261-402`,
  `test/visualizer-shape.test.mjs:24-31,560-591`, `crew/driver.test.mjs:566-672`
  carry explicit `// kills: <mutant>` comments, and `crew/reclaim.test.mjs:648`
  documents a test that *was* vacuous and was rewritten. Candidate vacuity claims
  in `skills/crew-dispatch/cli-contract.test.mjs:44-55` and
  `skills/devops/exhibits.test.mjs:15-23` were checked and ruled out
  (the first is a documented one-directional subset contract,
  `skills/crew-dispatch/references/flags.md:3`; the second pins
  `verbs.length === 9`, which a rename does redden).

---

## 3. Name-versus-assertion mismatches

### N1 — `crew/drive.test.mjs:5954`
Title: *"the panel is skipped without a tech-lead, **and the planner is never a
panel partner**"*. The first clause is checked dynamically
(`panel_skipped === 'seats'`, reviewer assigned exactly once). The second is
backed only by `assert.deepEqual(PANEL_PARTNERS, ['tech-lead'])` — a static
equality on a frozen constant. Nothing in this drive's `io.calls.assign` is
inspected for planner-as-partner. The title's second clause is a constant check
wearing a behavioural title.

### N2 — `crew/crew.test.mjs:4065`
Title: *"a charter requirement unmet by adapter and register refuses to boot
**from the closed reason set**"*. The body pins the literal
`err.reason === 'capability-shortfall'` plus `/planner/`, `/subagents/`, `/pi/`
message regexes. It never references `CAPABILITY_REFUSALS`. The neighbouring test
at `crew/crew.test.mjs:4230` does back the identical "closed reason set" claim
with `assert.deepEqual([...CAPABILITY_REFUSALS], [...])` — so the file shows what
the honest version looks like, eight lines away.

### N3 — `crew/crew.test.mjs:4141`
Title: *"resolveAdapters refuses a claude-seated local-provider cell **before any
seat spawns**"*. No spy, counter or ordering probe is injected; the body asserts
only `err.reason === 'grant-unsupported'` and three message regexes. The "before
any seat spawns" ordering claim is unmeasured. Same file, `crew/crew.test.mjs:4372`,
shows the honest shape for exactly this claim
(`assert.equal(cmux.calls.length, 0)`, `assert.equal(tree.calls.length, 0)`).

### N4 — `crew/daemon.test.mjs:1463` and `test/factory-ledger.test.mjs:2755`
Both are also name-versus-assertion failures; demonstrated as V5 and V6 above and
not repeated here.

### Scan note
A mechanical pass flagged 222 titles containing a discrimination word
(`never|only|no|not|neither|without|refus|absent|unchanged|both|exactly one|zero`)
whose bodies contain no negative-form assertion. That heuristic is far too loose
to publish as findings — most are honest tests whose negative is expressed as
`assert.deepEqual(x, [])` or an enum-membership check. It is recorded here only so
the next pass knows the cheap filter was run and does not mistake it for signal.
N1–N4 are the entries that survived reading.

---

## 4. Duration table — measured, single clean sequential run

Per-test `duration_ms` summed by file (attribution: each file was also run alone
with `--test-reporter=tap`, and the ordered test-name sequence was matched against
the clean run's stream; **51/51 files matched, 2169/2171 entries attributed**, the
2 unattributed being the phantom `test/fixtures.mjs` / `test/helpers.mjs` of §0).
Sum of all per-test durations 131,129 ms against a 136,816 ms harness total —
the ~5.7 s remainder is per-file process startup, not attributable to any test.

### Ten slowest files

| ms | tests | ms/test | file |
|---:|---:|---:|---|
| 45,482 | 88 | 517 | `test/factory-intake.test.mjs` |
| 16,112 | 71 | 227 | `test/factory-make-brief.test.mjs` |
| 14,613 | 65 | 225 | `test/factory-emit.test.mjs` |
| 11,089 | 40 | 277 | `test/factory-probe-repo.test.mjs` |
| 8,031 | 321 | 25 | `crew/drive.test.mjs` |
| 6,757 | 183 | 37 | `test/factory-ledger.test.mjs` |
| 6,243 | 41 | 152 | `crew/headless-rpc.test.mjs` |
| 4,122 | 54 | 76 | `crew/pi/extensions/lab.test.mjs` |
| 3,932 | 28 | 140 | `crew/arms.test.mjs` |
| 2,844 | 226 | 13 | `crew/crew.test.mjs` |

Four files — `factory-intake`, `factory-make-brief`, `factory-emit`,
`factory-probe-repo` — are **87.3 s of the 131.1 s of measured test time (67%)**
on 264 of 2171 tests (12%).

### Ten slowest tests

| ms | file :: test |
|---:|---|
| 4,252 | `test/factory-intake.test.mjs:458` :: judge-tier proposal refuses without selecting or dispatching |
| 4,070 | `crew/drive.test.mjs` :: a timed-out gate runner is bounded and the sweep reaps its leaked descendant |
| 3,561 | `test/factory-intake.test.mjs` :: intakeLoop delegates eligibility to intakeSweep and never reimplements it |
| 3,194 | `test/factory-probe-repo.test.mjs` :: self-hosting: the board is proposed from this repository or honestly refused |
| 3,012 | `crew/headless-rpc.test.mjs` :: wait timeout retains an unproven reservation and clears one proved by the exit marker |
| 3,000 | `crew/headless-rpc.test.mjs` :: run-end teardown proves a worker that survives its first SIGTERM and the old 2s deadline dead |
| 2,928 | `test/factory-intake.test.mjs` :: hand dispatch still boots after two escalations and digest rows pair by dispatch |
| 2,692 | `test/factory-intake.test.mjs` :: dispatch rows carry the body digest on claimed and settled steps, and changed bodies differ |
| 2,615 | `test/factory-intake.test.mjs` :: a changed body lifts the repeat escalation park, while metadata bumps do not |
| 2,601 | `test/factory-intake.test.mjs` :: an escalation followed by done leaves the issue pickable |

### S1 — what makes them slow

**`test/factory-intake.test.mjs` (45.5 s, 35% of the suite) — every sweep compiles a
real brief against the live repository.** `runSweep` passes `checkout: ROOT`:
```
test/factory-intake.test.mjs:233  function runSweep(nodes, options = {}) {
test/factory-intake.test.mjs:238    checkout: ROOT,
```
`ROOT` is the repo root (`test/factory-intake.test.mjs:12`, from `./helpers.mjs`).
Each sweep therefore drives `make-brief`'s `verifyWhere` + `discoverTripwires`
over the whole 43k-line checkout. The slowest test
(`test/factory-intake.test.mjs:458`, 4,252 ms) names `where: 'scripts/factory'` — a
*directory*, so tripwire discovery walks every file under it and greps the repo for
each. The `callerCheckout()` fixture is already memoised
(`test/factory-intake.test.mjs:57-72`), so the cost is not repo setup; it is
repeated whole-repo discovery. Remedy shape: a memoised synthetic checkout for the
sweeps that do not assert on real-repo content, keeping `checkout: ROOT` only for
the handful that genuinely pin self-hosting.

**`test/factory-make-brief.test.mjs` (16.1 s / 71).** `fixture()`
(`test/factory-make-brief.test.mjs:54`) builds a fresh directory and runs
`git init` + `add` + `commit` per test via `git()`
(`test/factory-make-brief.test.mjs:48`). Four tests additionally run real
whole-repo discovery against `ROOT` (`:1211, 1220, 1228, 1259`), and those are the
top of the file's own table — *"real crew-drive discovery retains crew-child as an
exported-symbol caller"* 1,258 ms, *"real ci-watch discovery names its non-test
callers"* 479 ms.

**`test/factory-emit.test.mjs` (14.6 s / 65).** Concentrated in the lock-contention
tests, which spend real wall time waiting out a bounded lock budget:
*"BOUNDED LOCK WAIT + COUNTED GIVE-UP …"* 2,457 ms, *"M4 residual: two separate
emitters each hitting a lock give-up …"* 2,520 ms, *"CLI gate: MUST-FIX #2 …"*
2,521 ms. This is a real, deliberate timing property; the cost is inherent unless
the budget is made injectable.

**`test/factory-probe-repo.test.mjs` (11.1 s / 40).** One test,
*"self-hosting: the board is proposed from this repository or honestly refused"*,
is 3,194 ms alone and probes the real repo; the rest spawn `git` per fixture
(`test/factory-probe-repo.test.mjs:60`).

**`crew/drive.test.mjs` (8.0 s / 321 = 25 ms/test).** Not a slow file — one slow
test. *"a timed-out gate runner is bounded and the sweep reaps its leaked
descendant"* is 4,070 ms, half the file, and is a real SIGTERM→SIGKILL escalation
against a real process group. Inherent.

**`crew/headless-rpc.test.mjs` (6.2 s / 41).** Two tests are 6,012 ms of the 6,243:
real detached children plus a real SIGTERM/SIGKILL deadline. Inherent; the other 39
tests total 231 ms.

**`crew/arms.test.mjs` (3.9 s / 28) and `crew/harvest.test.mjs` (2.0 s / 13).**
No single slow test — a flat ~140–155 ms/test tax. `makeWorld()` runs
`git init` + two commits + `worktree add` and is rebuilt per test:
25 `withWorld(` call sites in `crew/arms.test.mjs`, 15 in `crew/harvest.test.mjs`.
This is the cost D3 would let a shared fixture amortise.

---

## 5. Fixed-sleep sweep — per file, grep quoted

Grep run (`FORCE_COLOR=0`): `setTimeout` and `\bdelay(|\bsleep(|timers/promises`
across all 51 test files. 33 `setTimeout` hits and 5 `delay`/`sleep` hits total.
Carve-out applied per brief: a `setTimeout` used as the **poll cadence inside a
bounded `while (Date.now() < deadline)` loop** is fine and is not reported.

| file | verdict |
|---|---|
| `crew/daemon.test.mjs` | **CLEAN — sweep confirmed complete.** Three hits, all legitimate: `:163` a fallback deadline racing a real `'data'` handler; `:189` the cadence inside `waitFor()`, self-documented at `:175-179` (*"FIXED SLEEP: the poll cadence of this waiter itself, not a stand-in for a condition"*); `:3002` the cadence inside a bounded `while (Date.now() < deadline)` polling `process.kill(-pgid, 0)`, carrying the same comment at `:2999-3000`. No survivor. |
| `test/factory-ledger.test.mjs` | **3 FIXED SLEEPS.** `:1880`, `:1908`, `:1946`, each `await new Promise((resolve) => setTimeout(resolve, 200))` immediately after `spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])`. The 200 ms guesses *"the child has started"* before `ledger.startProcess(...)` (`:1881`) or a `spawnSync('ps', …)` read of its live command (`:1909`, `:1947`). Both conditions are directly pollable, and **both primitives are already in this file**: a bounded poll loop at `:2029`/`:2100` and a signal-0 liveness probe inside the very same S8 test at `:1892`. Neither is applied here. |
| `test/factory-crew-watch.test.mjs` | **1 FIXED SLEEP, the largest single one in the suite.** `:398` `await new Promise((resolve) => setTimeout(resolve, 1_500))` in *"follow has no process-spawning surface and no child after one tick"*, spawning `crew-watch.mjs --follow --interval 2` with `stdio: 'ignore'` and then reading `ps -o state=` and `pgrep -P`. The test is 1,521 ms — essentially all sleep. The awaited condition is "one tick has happened"; with `stdio: 'ignore'` there is nothing to observe, so the sleep is load-bearing *because* the fixture discards the child's output. Remedy: capture stdout and poll for the first tick line, then assert. |
| `test/factory-ledger-floor.test.mjs` | **1 FIXED SLEEP.** `:301` `setTimeout(resolve, 400)` after spawning a child that calls `installFinalizer`, before `child.kill('SIGTERM')`. The awaited condition — the finalizer's `startSession`/`startProcess` lines reaching `jsonlPath` — is a file the test reads 5 lines later (`:306`). Pollable. |
| `crew/factoryctl.test.mjs` | clean (`:94` is the cadence inside `waitFor`, `:90`). |
| `crew/headless-rpc.test.mjs` | clean (`:740`, `:792` are cadences inside bounded `while (Date.now() < deadline)` loops at `:738`, `:790`). |
| `crew/crew.test.mjs` | clean (`:1551` is a 15 s hang-guard `SIGKILL` timer, not a wait; the test waits on a real stdout marker). |
| `crew/reclaim-descendants.test.mjs` | clean (`:110` a 5 s hang-guard; `:685,699,706` are `await delay(50)` cadences inside bounded deadline loops; `:821` is `deps.sleep(0)` on an injected fake). |
| `crew/pi/extensions/lab.test.mjs`, `crew/pi/extensions/subagent.test.mjs` | clean — injected fake clocks (`lab.test.mjs:38-45` `timers()`), no real sleeps at all. |
| `crew/drive.test.mjs` | clean (`:2298`, `:2326` are `spawnSync('sleep',['0.05'])` cadences inside bounded pgid-liveness polls). |
| `crew/seat-io-runclean.test.mjs`, `crew/headless.test.mjs`, all `test/visualizer-*` | clean — fake clocks (`now: () => clock, sleep: (ms) => { clock += ms }`) or 10 s hang-guards on a real announce (`visualizer-server.test.mjs:43,57`, `visualizer-teardown.test.mjs:39`). |
| all other 38 files | no `setTimeout`/`delay`/`sleep` hits. |

**Total: 5 fixed sleeps, 2,900 ms of pure sleep, in 4 tests across 3 files.**

---

## 6. Real processes and real sockets — yes/no would a fake prove it

**Ephemeral-port check: PASS.** Every server bind in the suite uses port 0 and
reads the assigned port back — `--port 0` in `test/visualizer-server.test.mjs:73`
and `test/visualizer-teardown.test.mjs:63`, `server.listen(0, …)` in
`crew/pi/extensions/lab.test.mjs:430,495`. `crew/factoryctl.test.mjs` and
`crew/daemon.test.mjs` use unix-domain sockets under a temp dir, so ports do not
apply. **No fixed-port bind anywhere.**

### Would a fake prove the same property? — **NO** (real thing required)

| site | property that is unfakeable |
|---|---|
| `crew/daemon.test.mjs:160,534,1498,1858,1888,2056,2086,2727,2751` (`net.connect` to the daemon's real `net.createServer`, `crew/daemon.mjs:1277`) | wire-protocol framing: multi-chunk reassembly, split-UTF8-scalar handling, U+2028-safe JSON, double-bind pidfile refusal. A fake transport re-encodes the assumption under test. |
| `crew/daemon.test.mjs:2970-3020` | real PATH-resolved executable → real fork → `process.kill(-pgid, 0)` polled to `ESRCH`. POSIX process-group teardown. |
| `crew/drive.test.mjs:2278-2556` (b127 gate-reap suite: `/bin/sh`, `ps`, `kill`, `sleep`) | literal SIGTERM/SIGKILL delivery to a process group and survivor detection. |
| `crew/drive.test.mjs:152` (`spawnSync('git', …)`) | `crew/crew.mjs:1737` calls `execSync('git status --porcelain')` directly, *not* through the injectable `io` — the dirty-checkout guard is only reachable against a real tree. |
| `crew/drive.test.mjs:686-716, 745-750` | argv/exit-code/stdout of two standalone CLIs (`codemod.mjs`, `load-guidelines.mjs`). |
| `crew/crew.test.mjs:69` (`cliEntry`), `:1546` (`sigtermWhileBlocked`) | real CLI argv parsing + exit codes; OS **default** signal disposition, which by definition cannot be observed with a handler installed. A complementary in-process listener-count test already covers what *is* fakeable (`crew/crew.test.mjs:1596-1626`). |
| `crew/headless-rpc.test.mjs:710-803` | the file's own comment (`:755-765`) states it: every other test fakes `kill`, so this one exists to prove the fake and the real `kill(-pgid,0)`/`ESRCH`/`EPERM` wiring agree. Removing it would leave the fakes unaudited. |
| `crew/reclaim-descendants.test.mjs:297-319, 661-715` | real zombie states read by real `ps`; real detached-group escape. |
| `crew/pi/extensions/lab.test.mjs:411-519, 836-851` | whether node's actual `--permission` model enforces the boundary. (See V4 — on node 24 these prove less than their titles say, but the remedy is a visible skip, not a fake.) |
| `crew/factoryctl.test.mjs:277-288, 364-392` | real OS socket error codes (`ENOTSOCK`, `ECONNREFUSED`, `EPIPE`-on-write) being normalised. |
| `crew/arms.test.mjs`, `crew/harvest.test.mjs` (all `git`) | `refs/factory/*` ancestry, worktree branch names, non-fast-forward detection — git semantics; a mocked git asserts the assumption. |
| `crew/seat-io-runclean.test.mjs:350-367` | ANSI stripping of a *real* child's coloured output under `FORCE_COLOR`. |
| `test/factory-ledger.test.mjs:1880-2148` | SIGTERM→SIGKILL escalation timing; `ps` reading a real live command line for the recorded-vs-live gate; two real processes racing `openLedger` on one db path (an OS file-lock race). |
| `test/factory-ledger.test.mjs:331` (`run()`) and the `ledger.mjs` CLI spawns | exit-code semantics of the real process boundary. |
| `test/visualizer-server.test.mjs:146-212, 703-752, 1293-1308` | real CLI argv + exit codes; byte-for-byte on-disk digest after a real subprocess touched the tree; a genuine `EADDRINUSE` forced by a real competing bind. |

**No site was found where a fake would prove the same property.** The one
process-boundary cost that is *avoidable* is not a fake but a cache: the per-test
`git init` worlds of §4-S1 (`crew/arms.test.mjs`, `crew/harvest.test.mjs`,
`test/factory-make-brief.test.mjs`, `test/factory-probe-repo.test.mjs`).

---

## 7. Test-only exports in runtime modules

| export | module | non-test callers | verdict |
|---|---|---|---|
| `_resetNoticeGuardsForTest` | `scripts/factory/emit.mjs:1296` | **none** (grep across all `.mjs`/`.ts` excluding tests: only its own declaration and the comment at `:113`) | Test-only, and **honestly labelled** — the comment at `emit.mjs:109-116` states it exists "SOLELY so a test suite sharing one process across many otherwise-independent scenarios can isolate them — never called from any real call site." Used at `crew/crew.test.mjs:1366`, `test/factory-emit.test.mjs:295,509,864`, `test/factory-ledger.test.mjs:3152`. No action; this is the pattern done right. |
| `_dbPath` | `scripts/factory/ledger.mjs:3077` | **none** | Test-only with a **stale comment**. |
| `_jsonlPath` | `scripts/factory/ledger.mjs:3078` | **none** | Test-only with a **stale comment**. |
| `_probeFts5` | `scripts/factory/ledger.mjs:3079` | `ledger.mjs:4275` (doctor verb) | Genuinely shared. |
| `_pragmas` | `scripts/factory/ledger.mjs:3080` | `ledger.mjs:4274` (doctor verb) | Genuinely shared. |
| `_registry` | `scripts/factory/ledger.mjs:3084` | `ledger.mjs:3166,3176` (`installFinalizerImpl`) | Genuinely shared. |

**T1 — the comment at `scripts/factory/ledger.mjs:3076` is wrong for two of the
five members it covers.** It reads:

```js
    // internal, used by the doctor CLI verb and tests only:
    _dbPath: dbPath,
    _jsonlPath: jsonlPath,
    _probeFts5,
    _pragmas: pragmas,
```

The doctor verb uses `_pragmas` and `_probeFts5` (`ledger.mjs:4274-4275`) and
`jsonlDrift`. It does **not** use `_dbPath` or `_jsonlPath` — grep across every
non-test `.mjs`/`.ts` in the repo returns their declarations and nothing else.
Their only consumers are tests: `test/factory-ledger.test.mjs:371,599,610,826,894,983,1029`,
`test/factory-intake.test.mjs:920`, `test/visualizer-server.test.mjs:1054,1071`.
Not a defect in itself — a test needing the resolved db path is legitimate — but
the comment claims a production caller that does not exist, which is exactly the
claim that stops someone deleting them.

No other underscore-prefixed exports exist: `grep -rn "^export (function|const|class) _"`
across `crew/`, `scripts/`, `visualizer/` returns one hit, `emit.mjs:1296`.

---

## 2B. Vacuous tests — the `test/factory-*` files (folded in after §2)

### V7 — `test/factory-ci-repair.test.mjs:43-48` · a fabricated TAP pass line, printed whether the test passed or not

```js
after(() => {
  rmSync(fixture, { recursive: true, force: true })
  // Node 26's default test reporter is the spec reporter. Keep the required
  // acceptance titles visible as TAP-shaped lines for the repository gate.
  for (const [index, title] of REQUIRED_TITLES.entries()) process.stdout.write(`ok ${index + 1} - ${title}\n`)
})
```
The loop is unconditional. Every one of the eight `REQUIRED_TITLES`
(`test/factory-ci-repair.test.mjs:29-41`) is announced as `ok N - <title>` on
stdout even when that test just failed. The compat line in
`test/factory-reap-stale.test.mjs:106-110` shows the guarded form, in the same
suite:
```js
process.once('exit', (code) => {
  if (code === 0 && !String(process.env.NODE_OPTIONS || '').includes('--test-reporter=tap')) {
    process.stdout.write(`# pass ${LANE_TEST_COUNT}\n`)
  }
})
```
— gated on `code === 0` *and* suppressed under the TAP reporter. `ci-repair` has
neither guard.
**Kill-mutation it fails to catch:** `scripts/factory/ci-repair.mjs`,
`MAX_DISPATCHES = 1` → `MAX_DISPATCHES = 999`. The real assertion
`assert.equal(secondCrewCalls, 1)` reddens, and stdout *still* carries
`ok 2 - a second red parks and no third dispatch exists by any call sequence`.
Anything keying off those literal titles — which the comment says is the
purpose — reads a fabricated pass.
*Measured caveat, so the severity is not overstated:* under
`--test-reporter=tap` node prefixes the injected lines with `# `
(`tap-seq.txt:8391` → `# ok 6 - an inherited scope naming …`), so they are
comments there and this run's 2171 count is uncorrupted (my parse and node's own
`# tests 2171` agree exactly). Under the **spec reporter — the default, and what
`npm test` uses** — they are emitted raw. Ranked first in §9 for that reason.

### V8 — `test/factory-ci-watch.test.mjs:176-195` · a seam-coverage test that can only see calls that used the seam

```js
assert.ok(calls.length > 0)
assert.ok(calls.every((argv) => argv[0] === 'git' || argv[0] === shape.lane[0]))
```
`calls` is appended to only inside the injected `spawnSync` closure
(`test/factory-ci-watch.test.mjs:109-122`). A subprocess that bypasses the seam
is, by construction, invisible to the assertion that exists to forbid bypasses.
**Kill-mutation it fails to catch:** `scripts/factory/ci-watch.mjs:418`, in
`runLocalLane`, `d.spawnSync(selectedLane[0], …)` → `cpSpawnSync(selectedLane[0], …)`.
A real unrecorded subprocess is spawned; `calls` never sees it; `every()` still
passes.
**Honest assertion:** pin the expected call count
(`assert.equal(calls.length, N)`), or assert the source text of `ci-watch.mjs`
contains no direct `cpSpawnSync` call outside the seam — the shape the same file
already uses at `:198-206`.

### V9 — `test/factory-transcript.test.mjs:402-403` · two assertions scan directories production never receives

```js
assert.equal(scanForMarker(stateDir), false, 'no file under stateDir may carry the marker')
assert.equal(scanForMarker(taskDir),  false, 'no file under taskDir may carry the marker')
```
The only production calls in the test are `readUsage({ transcriptPath: path })`
and `readToolCalls({ transcriptPath: path })` (`~:380-381`); neither is ever
given `stateDir` or `taskDir`. `transcript.mjs` is separately proven write-free by
this file's own S3 test (`:644-667`).
**Kill-mutation:** none exists — no change to `transcript.mjs` can flip these two
lines. Deleting the real calls and hand-building marker-free `usage`/`toolCalls`
leaves them green. (The other two assertions in the same test are real.)
**Honest assertion:** drop them, or pass `stateDir`/`taskDir` to something that
could plausibly write there.

### V10 — `test/factory-ci-repair.test.mjs:355-369` · the `unreadable=false` branch cannot see its own check deleted

The mock is `{ stats: () => ({ degraded: true }), dumpTable: () => [], close(){} }`
and `stats()` is idempotent across both call sites
(`scripts/factory/ci-repair.mjs:437-443`).
**Kill-mutation it fails to catch:** `scripts/factory/ci-repair.mjs:438`,
`if (stats?.degraded === true) return { readable: false, priorDispatches: 0 }`
→ `if (false) …`. Execution falls through `dumpTable()` (returns `[]`, no throw)
to the second degraded re-check at `:441`, which the same mock still satisfies —
so `outcome === 'refused'` / `reason === 'bound-unverifiable'` still hold and the
deletion of the *first* check is invisible.
**Honest assertion:** make the two checks distinguishable — a mock whose `stats()`
returns `degraded: true` once and `false` after, so only the first check can
produce the refusal. (The sibling `unreadable=true` branch is sound; it uses a
throwing `dumpTable`.)

---

## 3B. Name-versus-assertion mismatches — the `test/factory-*` files

### N5 — `test/factory-env.test.mjs:553` · "every test file" scans two of four trees
Title: *"ledger sandbox tripwire — **every test file** is either not a writer or
sandboxed"*.
```js
for (const file of [...testFilesUnder('crew'), ...testFilesUnder('test')]) {
```
The repo also carries test files under `commands/` (`commands/commands.test.mjs`)
and `skills/**` (`skills/backend-node/exhibits.test.mjs`,
`skills/crew-dispatch/cli-contract.test.mjs`, `skills/devops/exhibits.test.mjs`,
`skills/pr-review/findings-shape.test.mjs`) — 5 of the 51 files are outside the
tripwire's reach. Inert today only because no ledger-importing module lives under
those trees. The companion test at `test/factory-env.test.mjs:528-551` ("every
production home default resolves to a registered door") has the identical gap.
This one is worth fixing rather than renaming: a tripwire whose title claims
totality is exactly the guard nobody re-checks.

### N6 — `test/factory-intake.test.mjs:1096`
Title: *"importing intake.mjs performs **no I/O** and node --check passes"*.
Asserts `check.status === 0` (`:1099`) and that a subprocess dynamic-import exits
0 (`:1103-1104`). Nothing observes I/O. A module-eval-time file read or network
call that *succeeded* would pass. What is verified: "imports without throwing,
and syntax-checks clean."

### N7 — `test/factory-transcript.test.mjs:275`
Title: *"a file deleted between the existence check and the stat (**TOCTOU**)
degrades to no-match, never throws"*. The test's own comment (`:276-285`) admits
no race is staged; it calls `resolveTranscript` twice against an id that never
existed — the same path as the "0 matches" test at `:201`. No
delete-between-check-and-stat is ever created.

### N8 — `test/factory-emit-floor.test.mjs:79-90`
Title: *"below-floor emitter never touches node:sqlite: **the mirror db file is
never created**"*. `dbPath` is computed and passed in, but no `existsSync(dbPath)`
check appears in the body — only `emitter.stats().dropped === 0`. A regression
that created a file at `dbPath` on the degraded path passes unchanged.

---

## 1B. Duplicated helpers — the `test/factory-*` files

Adds to §1 (and corroborates D4's `world`/`seedLane`/`journalObjects`/`freshDir`/
`ratifiedCell`/`ciValue`/`nextRoot`/`put` rows independently):

### D7 — `captureStreams()` · 5 independent implementations
`test/factory-intake.test.mjs:84-99` (quoted below), plus separate copies in
`test/factory-emit.test.mjs`, `test/factory-ledger.test.mjs` /
`test/factory-ledger-floor.test.mjs`, `test/factory-probe-repo.test.mjs`,
`test/factory-transcript.test.mjs`.
```js
function captureStreams(fn) {
  const stdout = []
  const stderr = []
  const realStdoutWrite = process.stdout.write
  const realStderrWrite = process.stderr.write
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true }
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true }
  let value
  try { value = fn() } finally {
    process.stdout.write = realStdoutWrite
    process.stderr.write = realStderrWrite
  }
  return { value, stdout: stdout.join(''), stderr: stderr.join('') }
}
```
Monkey-patching `process.stdout.write` five different ways, each with its own
restore path, is the shape where one copy forgets the `finally`.
**Proposed home:** `test/helpers.mjs`. **Files that shrink: 5.**

### D8 — the fixture-root-plus-cleanup idiom · 5 mechanisms for one intent
`test/factory-make-brief.test.mjs:28-31` (`after()` + `rmSync`),
`test/factory-transcript.test.mjs:25-26` (`process.on('exit')` + try/catch),
`test/factory-reap-stale.test.mjs:77-81` (`newRoot()` + tracked-array cleanup),
`test/factory-emit.test.mjs:54` / `test/factory-emit-floor.test.mjs:39`
(`freshDir()`), `test/factory-ledger.test.mjs:323` /
`test/factory-transcript.test.mjs:29` (`nextDir()`).
Identical intent, five different cleanup mechanisms — the inconsistency is itself
the signal. **Proposed home:** `test/fixtures.mjs`, alongside the existing
`testCheckout()`.

### D9 — the whole-file pairs
`test/factory-lane-watch.test.mjs:19-91` and
`test/factory-crew-watch.test.mjs:27-73` share `world()`, `seedLane()`,
`journalObjects()` **and** the `QUIET` fixture object byte-for-byte.
`test/factory-ci-repair.test.mjs:59-171` and
`test/factory-ci-watch.test.mjs:69-122` share `ratifiedCell()`, `ciValue()`,
`profileFixture()`, `seam()`. These two pairs are the highest-density duplication
in the suite: consolidating them alone removes ~200 duplicated lines.


---

## 8. Read coverage — what was read in full, what was sampled, and the rule

**Read in full (42 of 51 test files, 30,846 of 43,116 lines = 72%):**
`crew/drive.test.mjs`, `crew/crew.test.mjs`, `test/factory-ledger.test.mjs`,
`crew/daemon.test.mjs`, `test/visualizer-server.test.mjs`,
`test/visualizer-panels.test.mjs`, `test/visualizer-shape.test.mjs`,
`test/visualizer-roster-edit.test.mjs`, `test/visualizer-teardown.test.mjs`,
`test/visualizer-returns.test.mjs`, `crew/pi/extensions/lab.test.mjs`,
`crew/pi/extensions/subagent.test.mjs`, `crew/pi/extensions/advisor.test.mjs`,
`crew/seat-io-runclean.test.mjs`, `crew/reclaim-descendants.test.mjs`,
`crew/headless-rpc.test.mjs`, `crew/io-contract.test.mjs`, `crew/reclaim.test.mjs`,
`crew/driver.test.mjs`, `crew/arms.test.mjs`, `crew/factoryctl.test.mjs`,
`crew/roster-refresh.test.mjs`, `crew/breaker.test.mjs`, `crew/memory.test.mjs`,
`crew/headless.test.mjs`, `crew/harvest.test.mjs`, `crew/capabilities.test.mjs`,
`crew/adapter-pi.test.mjs`, `crew/converge.test.mjs`,
`crew/escalation-policy.test.mjs`, `crew/host-load.test.mjs`,
`commands/commands.test.mjs`, `skills/pr-review/findings-shape.test.mjs`,
`skills/crew-dispatch/cli-contract.test.mjs`, `skills/devops/exhibits.test.mjs`,
`skills/backend-node/exhibits.test.mjs`, `test/fixtures.test.mjs`,
plus `test/helpers.mjs` and `test/fixtures.mjs` themselves.

**Read in a second pass (14 files, 10,201 lines) — see the coverage correction below:**
`test/factory-intake.test.mjs` (2030), `test/factory-emit.test.mjs` (1516),
`test/factory-make-brief.test.mjs` (1390), `test/factory-probe-repo.test.mjs` (1095),
`test/factory-transcript.test.mjs` (714), `test/factory-env.test.mjs` (577),
`test/factory-ci-repair.test.mjs` (566), `test/factory-ci-watch.test.mjs` (507),
`test/factory-lane-watch.test.mjs` (424), `test/factory-crew-watch.test.mjs` (411),
`test/factory-reap-stale.test.mjs` (392), `test/factory-ledger-floor.test.mjs` (320),
`test/factory-emit-floor.test.mjs` (106), `test/version-agreement.test.mjs` (63).

**Sampling rule applied to those files:** every one was covered by the *mechanical*
passes in full — the duplicate-helper body hash (§1), the fixed-sleep grep (§5),
the real-process/socket grep (§6), the swallowed-assert scan (§2), the
title-promise heuristic (§3) and the duration attribution (§4) all ran over 51/51
files with no sampling. What was sampled is the **line-by-line vacuity read**: for
these files only the regions those mechanical passes flagged were read
(`runSweep`/`fixture`/`git`/`callerCheckout` in `factory-intake` and
`factory-make-brief`; the sleep sites and their surrounding tests in
`factory-crew-watch`, `factory-ledger-floor`; the helper blocks in the `ci-*` and
`emit*` pairs). **Coverage correction:** those 14 `test/factory-*` files were subsequently read
in full as well, together with `scripts/factory/intake.mjs`, `make-brief.mjs`,
`transcript.mjs`, `ci-repair.mjs`, `ci-watch.mjs`, `lane-watch.mjs`,
`crew-watch.mjs`, `reap-stale.mjs` and `test/fixtures.mjs`. Their findings are
§1B / §2B / §3B and the `factory-*` rows of §5. **All 51 test files are therefore
read in full; nothing in this register is sampled.** The only modules still read
selectively are three large production files — `scripts/factory/emit.mjs`,
`scripts/factory/probe-repo.mjs`, `scripts/factory/ledger.mjs` — where the rule
was: read the exact function a claim depends on, verify the claim against it, and
do not read the module end-to-end. Every §2/§2B kill-mutation names the production
line it mutates, and each was checked against that line.

Production modules were read selectively throughout — only the function
implicated by a specific claim (`crew/drive.mjs:1670-1685`, `crew/crew.mjs:700-740`,
`crew/daemon.mjs:865-885`, `scripts/factory/emit.mjs:429-469`,
`scripts/factory/ledger.mjs:3068-3090`, `crew/pi/extensions/lab.ts:16-32,215-225,350-375`) —
never end-to-end.

---

## 9. Ranked remediation order

1. **V7** `test/factory-ci-repair.test.mjs:43-48` — the `after()` hook writes
   `ok N - <title>` for eight titles unconditionally. A failing test still
   announces itself as passing on stdout under the default reporter. Fix first:
   it is the only finding here that can make a red suite read green.
2. **D2** `git()` — 7 copies, already drifted into 6 semantic variants (one silently
   omits `protocol.file.allow`, one omits the identity entirely). Correctness, not tidiness.
3. **V4** the three `lab.test.mjs` escape tests, vacuous on the CI runtime.
4. **V1, V2, V5, V6, V8, V9, V10** — four one-line assertion fixes, each with the honest
   assertion named above.
5. **S1** `test/factory-intake.test.mjs`'s `checkout: ROOT` — 35% of suite wall time.
6. **D1, D6, D7, D9** `sqliteAvailable` (8 files) and the repo-root derivation (12 files) —
   the two largest mechanical wins, zero risk.
7. **N5** — the `factory-env` tripwire that claims totality over 2 of 4 trees, then **N1–N3, N6–N8** — titles narrowed, or assertions widened to match them.
8. **F0** — stop `test/helpers.mjs` and `test/fixtures.mjs` counting as passing tests.
9. **D3/D4/D5/D8** — shared fixtures; D3 also unlocks the arms/harvest git-world cost.
10. **T1** — correct the stale comment at `scripts/factory/ledger.mjs:3076`.
11. **The 5 fixed sleeps** (§5) — 2.9 s, but the `factory-crew-watch` one is also
    the reason that test observes nothing.
