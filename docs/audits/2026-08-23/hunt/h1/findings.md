# h1-lifecycle — adversarial defect hunt on the process-lifecycle surface

Scout run. Read-only against the checkout; every reproduction runs against a scratch
`git archive HEAD` copy of the repo plus a scratch state dir. `git status --porcelain
-uall` is empty before and after.

- checkout: `/Users/x/Development/dt-s1-runtime` @ `5a8d76a`
- platform: Darwin 25.5.0, node v26.5.1
- scratch repo copy used by every repro: `git archive HEAD | tar -x -C $H1_SCRATCH_REPO`
- reproductions: `task/repro/*.mjs` (one per finding, plus `n-negatives.mjs`), each with
  its recorded run in the matching `*.out`. `task/repro/README.md` has the run commands.

**7 defects reproduced.** Ranked by the brief's severity order (corrupts-state,
wrong-answer, hangs-or-leaks, refuses-wrongly, cosmetic).

| id | severity | one line | repro |
|----|----------|----------|-------|
| F1 | corrupts-state | `crew.json` has three writers and two durability contracts: the non-atomic ones expose a zero-byte window to every reader, and a full-overwrite writer durably erases another writer's field | `r6` |
| F2 | wrong-answer | one unreadable read of the run envelope makes the daemon's `orphaned` verdict permanent and restart-proof — a `done` run is recorded as a dead one | `r4` |
| F3 | wrong-answer | teardown records a seat root it *did* kill as `unproven` / `root_liveness: unknown`, for every seat the supervisor spawned itself | `r7` |
| F4 | wrong-answer + refuses-wrongly | the daemon re-adopts a run by bare pid, so a recycled pid is adopted as "the child, still working": the crew dir stays wedged and the run's terminal record is fabricated | `r2` |
| F5 | hangs-or-leaks | a seat root whose first settle could not be measured is skipped by every later sweep — the live process is out of reach of the entire runtime | `r1` |
| F6 | hangs-or-leaks | `teardownCore`'s first statement can throw, before any process reclamation: live seats plus an unarchived state dir | `r3` |
| F7 | hangs-or-leaks | `enqueue` has no liveness guard, so an enqueue interleaved with the daemon's own shutdown forks a detached child nothing will ever supervise | `r5` |

F3 and F5 compound: F3 makes `unproven` the *normal* stamp on Darwin, and F5 makes any
`unproven` stamp terminal. Fixing either alone leaves the pair half-closed.

---

## F1 — `crew.json`: three writers, two durability contracts (corrupts-state)

**Repro** `repro/r6-crewjson-two-durability-contracts.mjs` — a real second process
writing `crew.json` in a loop while this process reads and parses it, for each of the
two write disciplines, followed by the lost-update case (which needs no race).

The writers:

| site | discipline |
|------|-----------|
| `crew/seat-io.mjs:909-916` `saveCrew` — `writeFileSync(tmp)` + `renameSync(tmp, p)` | **atomic** (used by `bootCmd` `crew/crew.mjs:1637`, `seatIo.reseat` `:2084`, `seatIo.showDoc` `:2145`) |
| `crew/headless.mjs:178` — `if (fsExistsSync(file)) writeFileSync(file, JSON.stringify(crew, null, 2))` | not atomic |
| `crew/headless-rpc.mjs:182` — the same line, a verbatim duplicate | not atomic |

The readers tolerate nothing: `crew/crew.mjs:315` `loadCrew` is a bare
`JSON.parse(readFileSync(...))` with no retry (callers: `runCmd` `:1724`, `statusCmd`
`:2042`, `teardownCmd` `:2094`), and `crew/daemon.mjs:1082` turns a parse failure into
`invalid-spec`. The non-atomic writers belong to exactly the transports the daemon runs
(pane transport is refused, `crew/daemon.mjs:1084`) and fire on every assignment that
mints a session id (`crew/headless.mjs:264`, `:303`, `crew/headless-rpc.mjs:398`).

**Observed vs expected**

```
crew.json size: 1191 bytes

plain writeFileSync (headless.mjs:178, headless-rpc.mjs:182)
  reads=60205 writes=52703 TORN READS=2019 (of which zero-byte: 2019)
  first torn read: Unexpected end of JSON input | bytes read: 0 | head: ""

tmp + renameSync (saveCrew, seat-io.mjs:914-915)
  reads=145555 writes=17680 TORN READS=0 (of which zero-byte: 0)

after the driver's reseat  : reviewer.model=claude-opus-5 reseated={"role":"reviewer","from":"claude-sonnet-5","to":"claude-opus-5"}
after the seat's persist   : reviewer.model=claude-sonnet-5 reseated=null builder.session_id="sess-abc"
```

Expected: one durability contract for one file. Observed: 3.4% of reads under a hot
plain writer see a **zero-byte** `crew.json` (`O_TRUNC` opens the window; the write is a
later syscall), against 0 of 145 555 for the atomic writer — and in part 2 the driver's
reseat is durably erased by a seat that had never read it, because every writer
overwrites the whole file from its own private in-memory copy and none re-reads under a
lock. `reseat`'s own save failure is swallowed with a bare `catch`
(`crew/seat-io.mjs:2084`), so the loss is silent from both ends.

**Guard that should have caught it** `crew/arms.test.mjs` pins `crew.json` and a
`write-failed` reason, and `crew/io-contract.test.mjs` pins the io seam — but every
crew.json test drives ONE writer at a time in ONE process, so neither the truncation
window nor the lost update is expressible in them. The repo already owns the fix twice
over: `saveCrew`'s tmp+rename, and the only truly locked read-modify-write in the tree,
`scripts/factory/emit.mjs:875-902` (`run.lock`).

---

## F2 — one torn envelope read is a permanent, restart-proof wrong verdict (wrong-answer)

**Repro** `repro/r4-torn-envelope-permanent-orphan.mjs` — the torn bytes are the literal
truncated prefix of the child's real `done` envelope, and the child's write is then
completed, exactly as `crew/child.mjs:157` (`write(taskReturn, ...)`, plain, `O_TRUNC`,
not atomic) does it.

`crew/daemon.mjs:306-312` `jsonAt` returns `null` for a parse failure — indistinguishable
from "no file". `pollRun` therefore reaches `else if (run.child_dead) orphanRun(run, ...)`
(`:857`); `orphanRun` sets the lifecycle and `pollRun`'s first line
(`:842 if (run.lifecycle === 'orphaned' || ... 'settled') return`) means the envelope is
never read again. `SETTLED_LIFECYCLES = ['settled', 'orphaned']` (`:499`) makes a restart
skip it too (`adoptOrOrphan` `:1201`).

**Observed vs expected**

```
tick 1 (envelope torn)   : state={"state":"dead"}  records=[enqueued, started, orphaned]
tick 1 result()          : {"outcome":null,"envelope":null,"source":null,"reason":"orphaned-on-restart"}
envelope on disk now     : status=done commit=abc1234
tick 2 (envelope valid)  : state={"state":"done"}  records=[enqueued, started, orphaned]
after restart            : state={"state":"done"}  records=[enqueued, started, orphaned]
```

Expected: an envelope that cannot be parsed is UNMEASURED, not absent — the next tick
re-reads it and the run settles. Observed: the registry — ADR-029's single run-state
record — holds `orphaned` and never `settled`, permanently and across a restart, for a
run whose own `done` envelope with a commit is on disk. `settle()` never runs, so the
feed is closed with `orphaned` (`endFeed`) and `regrantIfEligible` never evaluates: an
escalation envelope that qualified for an automatic continuation silently loses it. Note
also that `state` recovers to `done` while the durable record says `orphaned` — the two
surfaces disagree permanently.

**Guard that should have caught it** `crew/daemon.test.mjs` covers "a fork with no pid is
orphaned rather than adopted forever" and the settle paths, but every test writes a
*valid* envelope or *no* envelope; no test writes bytes that exist and do not parse. The
runtime knows the fix — `crew/daemon.mjs:874` says workers "publish their own
atomically-renamed exit marker" — but the one file carrying the run's outcome is written
in place and read with no tolerance.

---

## F3 — a proven kill recorded as `unproven` (wrong-answer)

**Repro** `repro/r7-proven-kill-recorded-unproven.mjs`, with an A/B control where the
only difference is who reaps the corpse.

Measured mechanism, printed by the repro itself: on Darwin, a process group whose only
member is an unreaped zombie answers `kill(-pgid, 0)` with **EPERM**, not ESRCH.
`groupProbe` maps EPERM to `{ state: ALIVE, permission: true }`
(`crew/seat-io.mjs:458`), and `settleSeatRoots` treats a permission answer as unmeasured:
`} else if (afterTerm.state === LIVENESS.UNKNOWN || afterTerm.permission) {`
(`:613`) → `root_settled: 'unproven'`, `reason: 'probe-unknown'` (`:614-615`). The
`rebound` step two branches below *does* know how to read a `Z` row as a death
(`:547`), but the EPERM poll short-circuits before it is ever reached.

This is the production shape, not a contrived one: the seat root is a direct child of the
process that later sweeps it (`crew/headless.mjs` spawns the worker; `crew/seat-io.mjs:1791`
sweeps from the same process), and the sweep's sleeps are blocking `Atomics.wait`
(`defaultBlockingSleep`, `crew/seat-io.mjs:53-56`), so the event loop cannot reap the corpse for the whole
synchronous teardown stack. The file states exactly this at `:58-60`, and
`markLocallySettledGroup` (`:79-101`) exists for it — but it is only reachable from
`rootBinding`'s `probe.permission` branch (`:539`), which this ladder never consults again
after the TERM poll.

**Observed vs expected**

```
measurement: our own child, running   : stat=Ss kill(-pgid,0)=ok (reads ALIVE)
measurement: our own child, killed    : stat=Z kill(-pgid,0)=EPERM  <-- EPERM, not ESRCH

ARM-A own-child: root pid=83570 ppid=82200 (ours=82200) pgid=83570
   summary      : {"records":1,"settled":0,...,"unproven":1}
   journal row  : {"root_settled":"unproven","root_liveness":"unknown","reason":"probe-unknown"}
   ps after     : stat=Z  (Z or gone == the sweep DID kill it)

ARM-B reparented: root pid=85344 ppid=1 (ours=82200) pgid=85344
   summary      : {"records":1,"settled":1,...,"unproven":0}
   journal row  : {"root_settled":"proven","root_liveness":"dead","reason":"probe-dead"}
   ps after     : stat=(gone)
```

Expected: both arms are the same kill of the same program, so both record `proven`.
Observed: the production shape records `unproven`/`unknown` for a process it demonstrably
killed. Every `seat-root-settle` row, every `descendant-reclaim` row that carries
`root_settled`, and the factory's whole proven/unproven reap accounting
(`scripts/factory/ledger.mjs:767`, `reap-stale`'s `REAP_ACCOUNTING`) is skewed for every
macOS run — and per F5 that stamp is also terminal.

**Guard that should have caught it** `crew/reclaim-descendants.test.mjs` has real spawned
processes (`realSeat`, `ROOT_SCRIPT`) — but its roots are **reparented grandchildren**
(the middle process exits), i.e. exactly ARM-B, the one arm that passes. `:384` and
`:386` assert `proven` on that shape. No test settles a root that is still the test
process's own direct child.

---

## F4 — the daemon adopts a recycled pid as its child (wrong-answer + refuses-wrongly)

**Repro** `repro/r2-daemon-adopts-reused-pid.mjs` — an unrelated live process stands in
for the recycled pid, which is the exact post-recycle state.

`crew/daemon.mjs:1004` records only `child_pid` — no start time, no pgid, no cmdline.
`adoptOrOrphan` then decides on `processAlive(kill, run.child_pid)` alone, and
`if (alive === true || alive === null)` adopts (`:1212-1216`). The daemon installs no
signal handlers at all (nothing in the file handles SIGTERM/SIGINT/exit), so an
un-cleanly killed daemon leaves detached children and a registry full of bare pids —
which is precisely when this path runs.

**Observed vs expected**

```
registry 'started' record  : {"child_pid":88803}   <- no start time, no pgid, no cmdline
that pid is really         : an unrelated node process this run never forked
after start(): lifecycle   : [{"run_id":"r-1","task":"h1-r2",...,"state":"working"}]
registry now contains      : enqueued, started, adopted
state({run:'r-1'})         : {"state":"working"}
enqueue of a NEW run       : {"message":"run r-1 is already active for /tmp/h1r2-qPZ1JF/crew"}
envelope the daemon wrote  : {"status":"escalation","summary":"Task h1-r2 needs a human: the child died (child-dead) before the run finished","escalation":{"where":"signalled","why":"child-dead"}}
```

Expected: a pid the daemon cannot identify as its child is orphaned on restart
(`orphaned-on-restart`, `crew/daemon.mjs:1220`) and the crew dir is freed. Observed: the
run is `adopted` and reported `working`; it holds a concurrency slot
(`isRunning` `:501` → `runningCount` `:1009`), keeps `checkoutBusy` true, and refuses any
new run for that crew dir *and* that tier for as long as the stranger lives; and when the
stranger exits, the daemon authors a "the child died" escalation about a child that never
existed. Same absence of identity in `reapLaunchedContinuation`
(`crew/daemon.mjs:746`), which sends `kill(-pgid, 'SIGTERM')` on a registry pid behind
nothing but a `pid > 1` guard.

**Guard that should have caught it** `crew/daemon.test.mjs:1510` ("restart adopts a live
child without forking") pins the adopt path, and `:2146` pins the no-pid path — neither
pins a live pid that is *not* the child, because the registry records nothing that could
tell them apart. The standard exists ten files away: a descendant record binds
`root_pid` + `root_pgid` + `root_start` and refuses a row whose start string disagrees
(`crew/seat-io.mjs:531`, `root-unidentified`) — see negative result N2, where that guard
holds.

---

## F5 — an `unproven` seat root is out of reach of every sweep (hangs-or-leaks)

**Repro** `repro/r1-unproven-root-never-retried.mjs` — a real detached process as the seat
root, a first sweep whose `ps` is unavailable, then the sweep whose job is to kill it, then
the standalone stale reaper's only tool.

`crew/seat-io.mjs:566` — `if (record.swept_at != null || record.root_settled != null)
continue` — skips on ANY stamp, including `unproven` (`:595`, `:606`, `:630`), and nothing
anywhere resets `root_settled` (verified: the only writes are the settle results
themselves and the `null` initialisation at `:394`). The run-end sweep stamps first
(`crew/seat-io.mjs:1791`, whose own comment relies on the later pass skipping stamped
records), then `teardownCore`'s settle (`crew/crew.mjs:2079`) skips it, and
`scripts/factory/reap-stale.mjs` only ever calls `reclaimDescendants` (`:11`, `:49`),
which refuses to touch a live root at all (`root-alive`, `crew/seat-io.mjs:729-730`).

**Observed vs expected**

```
root pid=13802 pgid=13802 start="Sun Aug 23 12:15:39 2026" alive=true
sweep1 summary   : {"records":1,...,"unproven":1}
sweep1 stamp     : root_settled="unproven"
sweep2 summary   : {"records":0,"settled":0,"already_dead":0,"unidentified":0,"failed":0,"unproven":0}
sweep2 journal   : ["seat-root-settle-sweep"]
sweep2 root alive: true
reap  outcome    : {"outcome":"unproven","reason":"root-alive","root_liveness":"alive","root_settled":"unproven"}
reap  summary    : {"swept":0,"retryable":1,"live":0,"reclaimed":0}
reap  root alive : true
```

Expected: sweep 2 measures the plainly live, plainly bound root (pid, pgid and start all
match) and settles it. Observed: sweep 2 looks at 0 records, the stale reaper reports
`retryable: 1` forever, and the agent process runs until the box reboots. The code's own
intent contradicts the behaviour: the `catch` at `:657` says "leave the record retryable
for a later teardown", but retryability depends on the *advance* failing — a successful
advance of `unproven` is what closes the door. Triggers for `unproven` include a `ps` that
exits non-zero, times out (`DESCENDANT_PS_TIMEOUT_MS` = 5 s, plausible on a loaded host
running several crews) or prints nothing — and, per F3, the ordinary EPERM path.

**Guard that should have caught it** `crew/reclaim-descendants.test.mjs:610` asserts the
`unproven` stamp is *written*, and `:854` asserts it for an unmeasured snapshot; no test
sweeps twice to assert the record is retried, and the one test that runs the sweep twice
(N3 below) uses an already-`proven` record where skipping is correct.

---

## F6 — `teardownCore` aborts before any process reclamation (hangs-or-leaks)

**Repro** `repro/r3-teardown-aborts-before-sweep.mjs`, with a control arm. No dependency
injection: it drives the REAL `closeSurface` through `CMUX_BIN`
(`crew/driver.mjs:11`) pointed at a stub that exits 1 — a missing, upgraded, hung or
erroring cmux.

Statement order in `crew/crew.mjs`:

```
2059  for (const m of Object.values(crew.members)) if (m.surface_id) closeSurfaceFn(m.surface_id)   <-- unguarded
2079  try { roots = settleRootsFn(...) } catch { ... }        <-- the kill
2081  try { descendants = reclaimFn(...) } catch { ... }      <-- the kill
2086  renameSyncFn(paths.dir, archived)                       <-- the archive
```

`closeSurface` (`crew/driver.mjs:211`) calls `tree()`, and `crew/driver.mjs:31` throws
whenever the cmux CLI answers non-zero, times out or prints unparseable JSON.
`teardownCmd` wraps the call in `try/finally` (`crew/crew.mjs:2108-2109`) with no `catch`, so
the throw leaves the verb.

**Observed vs expected**

```
mode=broken  cmux stub=exits 1 (unhealthy substrate)
seat root pid=91545 pgid=91545 alive=true
teardownCore threw : "tree failed: cmux: connection refused"
journal events     : []
state dir archived : NO — .../crew-state still in place
seat root alive    : true

mode=healthy  cmux stub=exits 0 (healthy)
teardownCore threw : no
journal events     : ["seat-teardown","seat-teardown-sweep","seat-root-settle","seat-root-settle-sweep","descendant-reclaim","descendant-reclaim-sweep"]
state dir archived : crew-state.archive-2026-08-23T10-08-53-090Z
seat root alive    : false
```

Expected: a pane substrate that cannot be reached is a teardown *diagnostic* — the seat
processes are still reclaimed and the dir is still archived. Observed: with identical
inputs, one unreachable cmux costs the entire reclamation and archive; the journal
records nothing at all, so the run leaves no trace of what was left running. Note the
inversion of the file's own priorities: the two steps that actually kill processes are
carefully wrapped in `catch`, while the cosmetic close that precedes them is not.

**Guard that should have caught it** `test/visualizer-teardown.test.mjs` and
`crew/reclaim-descendants.test.mjs` both exercise `teardownCore`, always with an
injected `closeSurface` (or a healthy one) that returns — never one that throws, though
`closeSurface` has a `throw` two frames down its only real call path.

---

## F7 — `enqueue` during shutdown forks an unsupervised child (hangs-or-leaks)

**Repro** `repro/r5-enqueue-while-dying.mjs`. The fork seam is injected with a stand-in
sleeper so the repro stays hermetic; what is under test is that a child IS forked and
left unsupervised.

`enqueue` (`crew/daemon.mjs:1065`) checks the spec, the budget, single-flight, the crew
file and the return paths — but never `started` or `server`; `pump()` → `startRun()` →
`fork(..., { detached: true })` (`:989`) proceeds regardless. The interleaving is
reachable: every request is dispatched on its own microtask
(`Promise.resolve().then(() => dispatch(...))`, `:1359`), and the `stop` command writes
its ok frame and then `await`s `stop()` (`:1339-1342`), which clears the interval and
destroys every connection *before* awaiting `closeServer` (`:1418-1435`) — an await, i.e.
a yield point another dispatch can run inside.

**Observed vs expected**

```
socket before          : true   pidfile: true
enqueue during stop()  : {"run_id":"r-1","crew_dir":"/tmp/h1r5-Hp54iI/crew","state":"working"}
records in runs.jsonl  : [enqueued, started]
children forked        : [89615]  alive=[true]
socket after           : false   pidfile: false
```

Expected: a daemon that is shutting down refuses the admission (the run stays queued for
the next daemon, or the caller is told the daemon is not running) — it does not fork.
Observed: the run is admitted and recorded `started`, a detached child is forked, and the
daemon exits with no socket, no pidfile and no poll loop behind it. The caller's socket
was destroyed before the reply, so nobody is told a run exists. The next daemon adopts it
by bare pid — see F4.

**Guard that should have caught it** `crew/daemon.test.mjs` exercises `enqueue` only on a
started daemon and `stop` only with no enqueue in flight; nothing pins "enqueue on a
daemon that is not running". `start()` has the guard `enqueue` lacks
(`if (started) throw runError('daemon-active', ...)`, `:1386`).

---

## Negative results — attacks the code SURVIVED

Run by `repro/n-negatives.mjs`; recorded so the next hunt does not repeat them.

- **N1 — socket disconnect delivered mid tail-replay.** A real unix-socket client asks
  `tail` on a run with a 4001-event backlog and is destroyed 2 ms into the replay. The
  daemon keeps serving (`ping` answers on a fresh connection) and the subscriber list is
  empty. Every write is guarded (`crew/daemon.mjs:1294-1297`, `notify` `:571-577`) and
  both `close` and `error` unsubscribe (`:1381-1382`). No unhandled EPIPE.
- **N2 — the descendant sweep pointed at a reused pid.** A record bound to a live
  process's real pid and pgid but a start string from another era: `settleSeatRoots`
  records `root-unidentified` and signals nothing; the innocent process survives. The
  `row.pgid === record.root_pgid && row.start === record.root_start` binding
  (`crew/seat-io.mjs:531`) is the guard F4's daemon path lacks.
- **N3 — the whole settle run twice for one seat.** The second `settleSeatRoots` skips the
  stamped record and the second `reclaimDescendants` signals nothing
  (`signalled=0`, `skipped=1`). Idempotent — no double-kill. (The *first* settle's
  `unproven` stamp on a successful kill is F3, and its terminality is F5.)
- **Stale socket and pidfile after an unclean daemon death** — read, not attacked
  further: `start()` unlinks a pidfile whose holder is dead (`:1391-1396`) and `bind()`
  live-probes an `EADDRINUSE` socket before unlinking and retrying (`:1274-1292`). No
  defect found by reading; not exercised with a real killed daemon (see below).
- **`reclaim.mjs` lock hygiene** — read, not attacked: `linkSync`-based exclusive create
  with a fenced epoch and a dead-owner steal (`crew/reclaim.mjs:240-282`). The one
  weakness is shared with F4 — `ownerState` (`:92-94`) is a bare `kill(pid, 0)`, so a
  recycled owner pid reads ALIVE and the acquire returns `contended` after
  `LOCK_ATTEMPTS × LOCK_INTERVAL_MS` (1 s) instead of stealing. I could not turn that into
  a reproduction (see SUSPICIONS).

## SUSPICIONS — not reproduced, do not treat as findings

- **Recycled lock-owner pid stalls a reclaim.** `crew/reclaim.mjs:92-94` has no reuse
  guard, so a recycled owner pid should make `acquire` return `contended` and
  `withLock` throw `reclaim-lock-unavailable` where a dead-owner steal was correct.
  Tried: constructing a lock record owned by a live unrelated pid and re-acquiring. I did
  not get past the fence/override plumbing in the time available, so the consequence
  (which caller escalates, and whether anything is lost) is unmeasured.
- **`markLocallySettledGroup` patches `process.kill` process-wide**
  (`crew/seat-io.mjs:83-101`) and restores it on a `setImmediate`. A teardown that ends in
  a synchronous `process.exit()` would never restore it, and any unrelated
  `kill(-pgid, 0)` in the same tick for a settled pgid gets a synthetic ESRCH. I could
  not find a live path that exits without returning to the event loop, so this is a
  reading, not a defect.
- **`run.feed` is unbounded for a non-settled run** (`appendEvent`
  `crew/daemon.mjs`, retention only via `SETTLED_FEED_RETENTION` = 50 after settle). A
  long run with a chatty journal grows daemon memory monotonically; 4001 events cost
  nothing measurable in N1, so I have no evidence this matters.

## Attack shapes from the brief that I did NOT run

Stated plainly so the next hunt knows what is still open, rather than implying coverage:

- Killing a seat child at each stage boundary (plan-accept, build round, gate, review,
  suite, commit) and diffing what the driver recorded against what happened. `driveTask`
  is pure over `io`, so this needs a driven fake io per boundary; not attempted.
- Killing the DRIVER mid-stage and re-running to find what double-applies. Not attempted.
- Killing the daemon between poll ticks with live children (I read the absence of signal
  handlers and reproduced the *consequence* of a bare-pid registry in F4, but did not
  SIGKILL a live daemon with live children).
- Making the *seat-teardown* settle path (as opposed to the root/descendant settle) fire
  twice for one seat and checking the ledger's `(adw_id, role)` `INSERT OR IGNORE`
  ownership convention holds.
- Filling the reclaim path with already-dead pids at volume (I used single dead and
  reused pids, not a store full of them).

## What I read

No file was read cover to cover. Ranges actually read, in the checkout:

- `crew/seat-io.mjs` — 20-840 (constants, the settled-group shim, `psSnapshot`,
  `escapedDescendants`, `verifyGroup`, the descendant engine and capture, the group
  probe/signal/poll helpers, `settleSeatRoots`, `reclaimDescendants`), 1175-1230
  (`settleSeatTeardown`), 1327-1466 (`readEnvelopeFile`, `reaskDecision`,
  `waitForEnvelope`, `paneProbe`, `colorNeutralEnv`), 1740-1900 (`seatIo.wait`,
  `reclaimDescendants`, `run`, `runClean`, `teardown`). Not read: 840-1175, 1230-1327,
  1466-1740, 1900-2156.
- `crew/daemon.mjs` — 294-500 (`processAlive`, `jsonAt`, the record helpers,
  `settleSignalled`, `orphanRun`), 730-760 (`reapLaunchedContinuation`), 835-900
  (`pollRun`, `poll`, `runState`, `result`), 960-1130 (`startRun`, `pump`,
  `assertBudget`, `enqueue`), 1195-1230 (`adoptOrOrphan`), 1325-1440 (`dispatch`,
  `request`, `start`, `stop`), plus `feed`/`appendEvent`/`notify`/`normalizeEvent`/
  `EVENT_KINDS`. Not read: 1-294, 500-730, 760-835, 1130-1195, 1230-1325.
- `crew/crew.mjs` — 2030-2140 (`statusCmd`, `teardownCore`, `teardownCmd`, `parseArgs`),
  plus `loadCrew` (312-316) and the import list.
- `crew/drive.mjs` — 1-1466 outline plus 1466-1900 read (`driveTask` through `askLead`).
  Not read: 1900-3250.
- `crew/driver.mjs` — 1-49 and 195-240 (`cmux`, `tree`, `closeSurface`, `logLine`).
- `crew/headless.mjs` — 165-185, 255-310. `crew/headless-rpc.mjs` — 175-186.
- `scripts/factory/reap-stale.mjs` — 1-120.
- `crew/reclaim-descendants.test.mjs` — 1-140 (the fixture shapes the repros reuse).

Three read-only scouts mapped, with file:line, the `crew.json`/sibling-file writer
inventory, the daemon's lifecycle machinery, and the reclaim/lock/teardown machinery;
every claim above was then verified against the checkout by hand or by a reproduction.
