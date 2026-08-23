# h4-data — adversarial defect hunt on data integrity

Scout run, read-only. The checkout at `5a8d76a` was not modified (`git status
--porcelain` empty before and after; full suite re-run green at **pass 2171,
fail 0**, matching the compiled baseline). Every attack ran against a
throwaway `mkdtemp` ledger directory or a `git archive HEAD` copy of the repo
at `/private/tmp/.../scratchpad/scratch`. `~/.dev-team/factory/ledger.{db,jsonl}`
was never opened.

Reproductions are self-contained programs in `repro/`. Each takes the scratch
repo path as its only argument:

```
node repro/<name>.mjs /private/tmp/claude-501/-Users-x-Development-dt-s4-tests/ea037e9d-0d0f-4b99-a95e-a7ba317d7a45/scratchpad/scratch
```

(any `git archive HEAD` copy works; they never write outside `mkdtemp`).

Severity vocabulary: `corrupts-state` / `wrong-answer` / `hangs-or-leaks` /
`refuses-wrongly` / `cosmetic`.

---

## Findings, ranked

### F1 — Two emitters on one run silently lose half the mirror, and `jsonlDrift()` reports zero drift · corrupts-state

**Repro:** `repro/a-two-emitters.mjs`

`nextSeq` (`scripts/factory/ledger.mjs:1380-1399`) seeds its allocator from
`SELECT MAX(seq) … WHERE adw_id = ?` **once per process** and then counts in
memory. Two processes that open the same ledger for the same `adw_id` before
either has inserted therefore both issue `seq` 1..N. The mirror inserts
`INSERT OR IGNORE INTO events` on `UNIQUE(adw_id, seq)`
(`scripts/factory/ledger.mjs:1631`, key from `TABLES.events.unique`), so the
loser's rows are dropped without error.

Observed (two child processes, 25 events each, one `adw_id`):

```
JSONL recordEvent lines    : 50  (expected 50)
events rows in mirror      : 25
distinct messages in JSONL : 50
distinct messages in db    : 25
messages LOST by the mirror: 25
  e.g. B:0, B:1, B:2, B:3, A:19, B:4
stats().mirror_errors      : 0
degraded                   : false
--- jsonlDrift() (the doctor readout) ---
measured    : true
lines       : 52
recordEvent : distinct_keys=25 rows_present=25 drift=0
drift_total : 0
remedy      : null
--- replayJsonl into a FRESH mirror (the documented remedy) ---
applied=52 skipped=0
events rows after rebuild  : 25  (JSONL carries 50)
```

Expected: either the mirror carries all 50 events, or *something* says it does
not.

Three separate signals are silent at once. `stats().mirror_errors` is 0
because `INSERT OR IGNORE` does not throw. `degraded` is false. And
`jsonlDrift()` — the one readout whose entire job is "did the mirror lose a
row?" — reports `drift_total: 0`, because it counts **distinct unique keys**
(`scripts/factory/ledger.mjs:2981` and `:3003-3011`) and the two emitters' lines collide on
exactly that key. The drift check is structurally blind to the only failure
mode that produces it.

The loss is **unrepairable**: the collision is baked into the authority, so
`replayJsonl` rebuilds to the same 25 rows. `ledger tail`, `/api/events`,
`foldAgents`/`withCells` and every timeline see half the run.

**Variant needing no concurrency at all** (`repro/a-two-emitters.mjs`, section A2):
one handle degraded (below `NODE_FLOOR`, or an open failure) mirrors nothing, so
the *next* healthy handle for the same run re-seeds `MAX(seq) = 0`:

```
JSONL events        : 10, seqs [1,2,3,4,5,1,2,3,4,5]
events rows         : 5
drift_total         : 0        (in the live mirror; 1 for the unmirrored startSession)
rebuilt from authority: 5 events out of 10
  kept: ["degraded-0","degraded-1","degraded-2","degraded-3","degraded-4"]
```

The live mirror holds `healthy-0..4`; replaying the same authority produces
`degraded-0..4`. The projection is **not a function of the authority** — two
rebuilds of one file disagree about which five of the ten events happened.

**The guard that should have caught it:** `test/factory-ledger.test.mjs:2136`
("S11(c): two processes racing to open + migrate the same fresh db"). It spawns
two racing children — but gives them **different** `adw_id`s (`race-a`,
`race-b`, `:2141-2148`), so no seq allocator ever collides, and it deliberately
asserts only that both JSONL lines survive (`:2158-2163`). The one concurrency
test in the suite tests the open race and not the write race.

---

### F2 — A run's second seat teardown and second review are dropped; a `failed` teardown is reported as a clean `proven` · corrupts-state

**Repro:** `repro/e-key-collapse.mjs`

`seat_teardowns` is `UNIQUE(adw_id, role)` and `review_outcomes` is
`UNIQUE(adw_id, dispatch_id)`; both mirrors `INSERT OR IGNORE`
(`scripts/factory/ledger.mjs:2084-2110`, `:1725-1750`). A run that seats one
role twice — a bounce, a re-ask, a lead taking over a timed-out builder — writes
two JSONL lines and gets one row, **first-write-wins**.

This is not speculative about the runtime: `visualizer/server/shape.mjs:59-63`
states it as fact — *"the runtime reuses [a dispatch id] across a resumed drive
(#461), so b52-heartbeat's journal carries d1 twice (a re-asked planner) and d2
twice (a lead that took over a timed-out builder)"* — and
`crew/seat-io.mjs:1021-1022` / `:1068-1076` pass exactly that reused
`event.id` as `dispatch_id`, and `event.role` as the teardown key.

Observed (one run; builder torn down twice, reviewer re-asked under one id):

```
=== seat_teardowns: UNIQUE(adw_id, role) ===
  JSONL lines            : 2
  outcomes in the JSONL  : ["proven","failed"]
  rows in the mirror     : [{"role":"builder","outcome":"proven","reason":"exited"}]
  ledger.seatTeardowns() : [{"outcome":"proven","reason":"exited","count":1,...}]
=== review_outcomes: UNIQUE(adw_id, dispatch_id) ===
  JSONL lines            : 2
  verdicts in the JSONL  : ["changes-needed","pass"]
  rows in the mirror     : [{"dispatch_id":"d3","verdict":"changes-needed","must_fix":4}]
=== the doctor readout ===
  measured=true drift_total=0 remedy=null
  recordReviewOutcome: distinct_keys=1 rows_present=1 drift=0
  recordSeatTeardown: distinct_keys=1 rows_present=1 drift=0
  stats(): {"degraded":false,"mirror_errors":0,...}
=== /api/seat-teardowns (what the operator sees) ===
  totals : {"seats":1,"proven":1,"failed":0,"unproven":0,"unrecognised":0,"runs":1}
  run r1 : [{"role":"builder",...,"outcome":"proven","reason":"exited",...}]
```

Expected: the second teardown is recorded, and `failed` — which
`scripts/factory/ledger.mjs:131-136` defines as *"a MEASURED live worker after
teardown"* and promises is *"never quietly counted as clean"* — reaches the
readout.

A leaked live worker is reported as `failed: 0, proven: 1`. That is the exact
outcome the vocabulary's own comment exists to prevent. On the review side the
mirror keeps whichever verdict landed first, which is what
`cellReviews`'s first-round pass rate (#376) and `eligible-tasks` count.
`drift_total` is 0 for both, for the same key-collapse reason as F1.

**The guard that should have caught it:** the schema pins the key
(`test/factory-ledger.test.mjs` holds `TABLES` and `WRITER_MIRROR_TABLES`
exact) but nothing asserts the key can represent a *second* attempt.
`test/visualizer-teardown.test.mjs:105-107` builds its fixture as exactly one
row per `(adw_id, role)` — planner/builder/reviewer, one each — so the collapse
is invisible to it. And `jsonlDrift` — the
runtime guard — cannot see it by construction.

---

### F3 — The documented rebuild doubles the append-only authority, and one bad line aborts it mid-file · corrupts-state

**Repro:** `repro/b-replay.mjs`

`scripts/factory/ledger.mjs:6-12` promises the db *"may be deleted at any time
and rebuilt in full via replayJsonl()"*. `replayJsonl`
(`scripts/factory/ledger.mjs:3113-3140`) dispatches `ledger[kind](args)` through
the **public writers**, and every public writer appends a JSONL line first
(`appendJsonl`, `:1360-1365`). Replaying a ledger's own authority into its own
handle therefore rewrites the authority.

```
=== B1: rebuild the mirror from its own authority ===
JSONL lines before rebuild      : 7
after 1 replay (applied 7)      : 14
after 2 replays (applied 14)    : 28
events rows                     : 5
drift_total                     : 0
```

Rows are idempotent; the *authority* is not. Each line's `at` is stamped with
`isoMs(now())` at replay time (`:1362`), so the "true, permanent record" now
carries a `startSession` line dated to the repair, and a naive line count of a
repaired ledger is 2ⁿ× the truth.

**B2 — one unrepresentable line kills the whole rebuild.** A malformed-JSON line
is tolerated and counted (`skipped`, `:3126-3131`), but a line whose `kind` is
outside `WRITERS`, or whose args fail a writer's own enum/shape check, **throws
out of the loop** with no resume point and no skip counter:

```
authority lines: 8 (4 good, 1 unrepresentable, 3 good)
replayJsonl threw   : LedgerUsageError: ledger: recordCellFailure: field 'kind'
                      must be one of boot-refusal|seat-not-ready|seat-died|timeout|...
sessions rows       : 1
events rows rebuilt : 3  (authority carries 6)
cell_failures rows  : 0
messages present    : ["before-0","before-1","before-2"]
```

Expected: the remedy either completes or leaves nothing. Observed: a
half-rebuilt mirror, silently missing everything after the offending byte, with
no signal distinguishing "rebuilt" from "rebuilt up to line 5". The mirror is
now *worse* than deleted, because `jsonlDrift` against its own (fresh) sink
still says `drift_total: 0`.

**Reachable without hand-editing** — see F4: the writers themselves accept a
timestamp their own replay refuses.

**The guard that should have caught it:** `test/factory-ledger.test.mjs:2171`
pins the throw on an unknown kind and `:2179` pins the skip on corrupt JSON —
both assert the *mechanism*, neither asserts what the caller is left holding.
Nothing tests replaying a ledger's own `jsonlPath`.

---

### F4 — An out-of-range epoch is accepted by every writer and makes that JSONL permanently un-replayable · corrupts-state

**Repro:** `repro/g-unrepresentable.mjs` (G1)

`isoMs` (`scripts/factory/ledger.mjs:955-984`) has asymmetric validation. The
number path only checks that the result ends in `.\d{3}Z`; the string
pass-through path requires `^\d{4}-\d{2}-\d{2}T…` . Any epoch-ms outside
year 1000–9999 passes the first and fails the second:

```
1790000000000000 -> +058692-11-03T14:13:20.000Z | round-trip: REPLAY THROWS
8640000000000000 -> +275760-09-13T00:00:00.000Z | round-trip: REPLAY THROWS
```

A caller handing a microsecond timestamp where the API wants epoch-ms — still
inside `Date`'s representable range, so nothing refuses — writes it to the
authority and poisons the rebuild path forever:

```
=== G1: an expanded-year timestamp poisons the rebuild path ===
  writer accepted           : +058612-12-26T23:34:09.000Z
  stored in cell_failures   : "+058612-12-26T23:34:09.000Z"
  replayJsonl               : Error: isoMs: string input must already be a
                              millisecond-ISO timestamp
  rows rebuilt              : sessions=1 cell_failures=0 events=0 (authority carries 1/1/1)
```

Expected: a value the writer accepts is a value the replayer accepts, or the
writer refuses it. Note also that the throw is a bare `Error`, not
`LedgerUsageError`, so `main()` maps it to exit **1** ("unexpected internal
error") rather than the exit 2 the refusal table reserves for this
(`scripts/factory/ledger.mjs:37-41`).

**The guard that should have caught it:** `test/factory-ledger.test.mjs`
exercises `isoMs` on valid ms-ISO strings and on `typeof` refusals; nothing
round-trips `isoMs(isoMs(x))` across the number→string boundary, which is the
one property replay depends on.

---

### F5 — `/api/cell-health` and `/api/cell-attribution` answer different failure counts for one cell over one window · wrong-answer

**Repro:** `repro/d-two-endpoints.mjs` (binds port 0)

Both endpoints use the same `defaultCellWindow()` (7 days), but window
different things. `cellFailures` filters `cell_failures.created_at`
(`visualizer/server/ledger-feed.mjs:129`). `cellAttribution` selects runs by
`sessions.started_at` (`:145-150`) and then pulls **all** their failure rows
unfiltered by `created_at` (`:155-164`); its "unattributable" bucket only
catches rows whose `adw_id` is NULL or **absent from `sessions`** (`:169`).

A row whose run started before the window but whose seat failed inside it
therefore lands in neither bucket — it is dropped, not counted as
unattributable.

```
window (both endpoints): since=2026-08-16T10:09:03.073Z label=last 7 days

/api/cell-health     — cell anthropic/opus-5·claude·high
  failures        : 2
  by_kind         : [{"kind":"seat-died","failures":2,"run_less":0}]

/api/cell-attribution — same window, same cell
  totals          : {"runs":1,"failures":1,"attributed":1,"unattributable":0}
  runs listed     : [{"adw_id":"inside","failures":1,"state":"recorded"}]
  unattributable  : 0
```

A third reader, `node scripts/factory/ledger.mjs cell-failures --since <same>`,
agrees with cell-health:

```json
{"provider":"anthropic","model_id":"opus-5","agent":"claude","effort":"high",
 "role":"builder","kind":"seat-died","failures":2,
 "first_at":"2026-08-21T10:09:18.198Z","last_at":"2026-08-22T10:09:18.198Z",
 "run_less":0,"host_attributed":0}
```

Expected: two readouts of one table over one window agree, or the disagreement
is stated where the smaller number is shown. `shapeCellAttribution` does carry
a `window_note` ("a failure recorded against a run outside it is not shown
here", `visualizer/server/shape.mjs:931`) — but `totals.failures` is presented
as the window total, the feed's own contract says an unplaceable row is *"never
dropped, never reassigned"* (`visualizer/server/ledger-feed.mjs:164`), and cell-health carries no counterpart note at all. A
straddling run is the ordinary case at any window boundary.

**The guard that should have caught it:** `test/visualizer-panels.test.mjs` and
`test/visualizer-shape.test.mjs` test each shaper against its own fixture.
Nothing cross-checks two endpoints reading one table against one dataset.

---

### F6 — A ledger holding rows that violate a UNIQUE index added later is permanently unopenable · corrupts-state

**Repro:** `repro/f-migrations.mjs` (F2)

The additive-only fence (`scripts/factory/ledger.mjs:126-127`, enforced at
`:897-902`) covers **columns**. `migrationsFor()` also generates
`CREATE UNIQUE INDEX IF NOT EXISTS` from `TABLES[t].unique` (`:864-867`), and
nothing makes those back-compatible with rows already on disk. Because
`applyMigrations` runs inside `ensureDb` on **every** open, one such db degrades
every handle forever:

```
  migrations withheld: 1 ("seat_teardowns_adw_id_role_uq")
  rows written under the old schema: 2
  writer threw            : no
  handle.degraded         : true
  stats().degraded_reason : ERR_SQLITE_ERROR
  stats().mirror_errors   : 0
  stderr                  : "ledger: degraded (UNIQUE constraint failed:
                             seat_teardowns.adw_id, seat_teardowns.role)
                             — mirror disabled, JSONL recording continues"
  JSONL lines             : 5
  sessions rows mirrored  : 0
  events rows mirrored    : 0
  jsonlDrift(): measured=false reason=the mirror could not be opened: ERR_SQLITE_ERROR
```

This one is **honestly signalled** — `degraded` true, a stderr line, and
`jsonlDrift` correctly refuses to call it zero drift — which is why it ranks
below F1/F2. It is still unrecoverable in place: the documented remedy
(`replayJsonl`) needs an open mirror, and the failing statement runs before any
writer does. `(adw_id, role)` was chosen for the index because F2 proves real
runs duplicate that key.

`repro/f-migrations.mjs` F1 is a **negative** result: every strict prefix of
`MIGRATIONS` upgrades cleanly under the full list, twice (AC-4 holds,
0 failures).

**The guard that should have caught it:** `test/factory-ledger.test.mjs`'s AC-4
tests run prefixes against an **empty** db. No test puts rows in the old-schema
db before upgrading it.

---

### F7 — The budget ceiling reads `measured: true, total: 0` from a missing mirror · wrong-answer / refuses-wrongly (fails open)

**Repro:** `repro/h-degraded.mjs` (H3)

`usageWindow` (`crew/daemon.mjs:260-289`) short-circuits:
`if (!fsExistsSync(dbPath)) return { measured: true, total: 0, sessions: 0 }`
(`:273`). Its own comment three lines above says *"a configured ceiling must
fail closed rather than remain zero forever"*.

```
=== H3: budget ceiling reads the mirror, not the authority ===
usageWindow with the mirror present : {"measured":true,"total":1000000,"sessions":1}
usageWindow with the mirror deleted : {"measured":true,"total":0,"sessions":0}
JSONL authority still records the spend: true
```

Expected: an absent mirror over a ledger dir that *does* hold an authority is
unmeasured (`measured: false`), which `crew/daemon.mjs:1057` already turns into
the `budget-unmeasurable` refusal. Observed: a *measured zero*, so
`daemon({budget})` admits runs without limit. Removing one file defeats the
cost ceiling — and the ledger's own header says that file "may be deleted at any
time". Everything the ceiling exists for (#39 cost discipline) is one `rm` away.

The same short-circuit cannot distinguish "fresh machine" from "mirror deleted /
mirror never written because the emitter was degraded", which is precisely the
distinction the surrounding comment claims to make.

**The guard that should have caught it:** the branch is *pinned as intended*.
`crew/daemon.test.mjs:1294` ("an absent ledger is measured only at the ledger
floor…") asserts `deepEqual(usage, { measured: true, total: 0, sessions: 0 })`
at `:1306`, and `:1316` names it "its at-floor absent-db fast path" with the
same assertion at `:1332`. The test encodes the behaviour rather than asking
what an absent db means when `ledger.jsonl` is sitting beside it holding the
spend — which is the case H3 constructs and the case the module header says to
expect ("it may be deleted at any time").

---

### F8 — A visualizer started before the first run answers empty for the rest of its life · wrong-answer

**Repro:** `repro/i-readers.mjs` (I1)

`createLedgerFeed.open()` latches: `if (db || degraded || closed) return db`
(`visualizer/server/ledger-feed.mjs:31`), and the catch sets `degraded = true`
permanently (`:37-40`). A read-only `DatabaseSync` cannot create a missing file,
so `npm run viz:serve` on a machine that has not run a crew yet degrades on its
first query and never reopens.

```
=== I1: `npm run viz:serve` started before the first crew run ===
  ledger.db exists at boot: false
  /api/sessions before any run: {"schema":1,"runs":[],"degraded":true,"probe":{...}}
  ledger.db exists now    : true
  /api/sessions after the run : {"schema":1,"runs":[],"degraded":true,"probe":{...}}
  /api/cell-health absent : "unable to open database file"
  /api/run-set degraded   : true reason="unable to open database file"
```

Expected: the board shows the run that just finished. Observed: every panel
stays empty until the process is restarted, with `probe.missing_tables` listing
every optional table as absent.

`repro/j-wal-and-doctor.mjs` (J1) shows the failure mode is *silent under
load*: hammering all six feed queries while a writer ran completed **76,020
reads with 0 errors** and `feed.health().degraded = true`, `probes: 0` — 76,020
answers of "nothing here" that never surfaced as a read failure.

`server.mjs:243-247` already knows the reason latches (#475) and works around
*that*; the connection latch underneath it is the larger half and is untreated.

**The guard that should have caught it:** `test/visualizer-server.test.mjs`
creates the ledger before starting the server in every case. No test starts the
server against a path that does not exist yet and then creates it.

---

### F9 — A live handle keeps answering from a deleted mirror · wrong-answer

**Repro:** `repro/h-degraded.mjs` (H1)

```
=== H1: db deleted under a live handle ===
JSONL lines (authority)     : 8   <- no line lost
handle.degraded             : false
stats().mirror_errors       : 0
stats().degraded_reason     : null
stderr diagnostic           : ""
this handle reads back      : 6 events (from the deleted inode)
jsonlDrift(): measured=true drift_total=0
next process sees           : 0 events, 0 sessions
next process jsonlDrift()   : measured=true drift_total=7 remedy=yes
```

The JSONL side is exactly right: not one line lost. But for the rest of the
process's life the handle answers reads from an unlinked inode, reports
`degraded: false`, and `jsonlDrift()` — the readout an operator would use to
*decide whether to rebuild* — says the mirror is clean while there is no mirror
on disk. The next process gets the right answer (`drift_total: 7`, remedy
named), so this is a live-handle-only lie, not a durable one; that plus the
POSIX-inherent nature of the unlink caps the severity.

---

### F10 — Free text with no bound in the durable record · hangs-or-leaks

**Repro:** `repro/g-unrepresentable.mjs` (G2)

```
=== G2: a 5 MB log message ===
  accepted, no refusal      : yes (19 ms)
  ledger.jsonl size         : 5243567 bytes
  payload_json stored       : 5242909 chars
```

Every other free-text field on these tables is bounded at the writer —
`note`/`detail`/`reason`/`why`/`coverage_reason` → 500, `stage` → 120,
`request` → 2000 (`normaliseRequestText`, `:942-953`) — but the `log.message`
payload key and `gate_results.checks`/`violations` are stored verbatim. One
seat that logs a large diff or a stack dump writes it, unbounded, into both the
permanent authority and the `events` table, and `/api/events` will serve it.
`crew/daemon.mjs` caps its own frames at 1 MiB (`MAX_FRAME_BYTES`); the ledger
has no counterpart.

---

### F11 — `adw_id: null` is accepted and creates unaddressable rows · wrong-answer

**Repro:** `repro/g-unrepresentable.mjs` (G3)

`requireFields` rejects only `undefined` — deliberately, because "null is a
legitimate explicit value for several required keys"
(`scripts/factory/ledger.mjs:1400-1403`). It is not legitimate for `adw_id`.
SQLite permits NULL in a `TEXT PRIMARY KEY`, and UNIQUE treats NULLs as
distinct:

```
=== G3: adw_id = null ===
  sessions rows             : [{"adw_id":null,"task_slug":"first"},
                               {"adw_id":null,"task_slug":"second"}]
  getSession(null)          : null
  taskReadout(null).adw_id  : null
  jsonlDrift drift_total    : 0
```

Two session rows exist that no reader can address by key, `listSessions()` and
`/api/sessions` render them, and the drift check calls it clean. `cell_failures`
legitimately carries a NULL `adw_id` (a boot refusal, `:1803`), so the fix is
per-writer, not global.

---

### F12 — A heartbeat lands after finalization, and no reader ever reads the column · cosmetic

**Repro:** `repro/i-readers.mjs` (I2)

```
  sessions.status            : ok
  sessions.ended_at          : 2026-08-23T10:14:37.888Z
  sessions.last_heartbeat_at : 2026-08-23T10:14:39.888Z   <- later than ended_at, no refusal
  /api/sessions last_heartbeat_at: null
  /api/sessions heartbeat_age_ms : null
  /api/sessions pending marker   : "not measured here — agent_sessions.last_heartbeat_at
                                    is not selected by this feed (…ledger-feed.mjs:76)"
```

`heartbeat({target:'session'})` UPDATEs unconditionally
(`scripts/factory/ledger.mjs:2281`), so a beat racing `endSession` leaves a
finished run with a liveness observation dated after its end — visible in
`ledger task <id>`. The reason this stays cosmetic is the second half: no reader
consumes it. `shapeRun` folds `last_heartbeat_at` only over `agentSessions`
rows (`visualizer/server/shape.mjs:228-231`) and the feed's `agent_sessions`
SELECT does not include the column (`visualizer/server/ledger-feed.mjs:77`), so
`sessions.last_heartbeat_at` — the #297 column whose stated purpose is that
*"the run row is the pane seat's only identity home"* (`ledger.mjs:2278-2282`) —
is written by the ledger and read by nothing. The absence is honestly marked,
which is why this is not ranked higher; it does mean the finalization race
cannot currently be observed by an operator through the board.

---

## SUSPICIONS (not reproduced — do not treat as findings)

1. **`cell_failures` UNIQUE(adw_id, dispatch_id, kind, created_at) omits
   `role`.** Two seats failing under one dispatch id with the same kind in the
   same millisecond would collapse the way F2 does. I could not construct a
   caller path where two roles share a dispatch id *and* a millisecond;
   `crew/seat-io.mjs` mints one id per assignment. Tried: reading `seat-io.mjs`
   and `crew.mjs` for id minting; no shared-id-per-role path found.
2. **`accept_decisions` UNIQUE(adw_id, where_at, created_at)** collapses two
   decisions at one `where` inside one millisecond. Writable by hand; I found no
   driver path that emits two accept decisions for one `where_at` at all, so I
   did not count it.
3. **WAL checkpoint on `close()` after the db file is unlinked** (F9) may write
   the whole WAL into the dead inode and could, on a filesystem that reuses the
   path, interact badly with a db recreated at the same path by another process.
   I did not manage to construct the interleaving; two processes with one
   deleting and one recreating always ended with the recreator's file intact.
4. **`STAGE_MARKER_CHUNK` / host-parameter limits.** `queryRows` swallows a
   too-many-parameters error into `[]` (`:2533-2542`), which `variantsFor`
   documents as the reason for chunking. `transportsFor` divides the chunk by
   `TRANSPORT_TABLES.length` and binds 5×40 = 200 — at the same bound, not
   under it. I could not make SQLite refuse 200 parameters on this build
   (`SQLITE_MAX_VARIABLE_NUMBER` is 32766 here), so this is a latent-on-another-build
   suspicion only.

---

## NEGATIVE RESULTS (attacks the code survived — do not re-run these)

- **Concurrent WAL readers during a live write.** `repro/j-wal-and-doctor.mjs`
  (J1): 76,020 read-only feed calls across `listRuns`, `listEvents`,
  `cellFailures`, `cellAttribution`, `seatTeardowns`, `budgetWindow` while a
  writer ran 1,200 writes — **0 read errors**, no torn reads, no lock failures.
  Final counts exact: 400/400/400 rows for 1,202 JSONL lines.
- **`replayJsonl` row idempotency.** Replaying the same authority 1× and 2×
  leaves the row counts identical (`repro/b-replay.mjs` B1). Only the JSONL side
  duplicates (F3).
- **Every strict prefix of `MIGRATIONS` upgrades cleanly** under the full list,
  applied twice, over an empty db — 0 failures across the prefixes probed
  (`repro/f-migrations.mjs` F1). AC-4 holds.
- **Revoking write permission mid-session** (`chmod 0500` on the dir + `0400`
  on the db) loses nothing and breaks nothing: the JSONL append and the WAL
  writes both go through already-open descriptors
  (`repro/h-degraded.mjs` H2 — `mirror_errors: 0`, all 6 events mirrored).
  Not a defect; recorded so it is not retried.
- **DST.** Every window boundary in scope is built with `toISOString()` /
  `isoMs()` and compared against UTC ms-ISO text — `defaultCellWindow`,
  `defaultRunSetWindow`, `defaultIntakeWindow`, `defaultTeardownWindow`
  (`shape.mjs:373-395`, `:818-824`), `crew/daemon.mjs:1048`. There is no
  local-time arithmetic anywhere in the six files in scope, so there is no DST
  seam to attack.
- **Epoch edges of the budget window.** `MAX_BUDGET_WINDOW_MS` (8.64e15) is
  validated at construction (`crew/daemon.mjs:355-358`) and
  `now() - window_ms` stays inside `Date`'s range for any real clock, so
  `new Date(...).toISOString()` at `:1048` cannot throw. `isoMs` handles epoch 0
  and negative epochs correctly (`1969-12-31T23:59:59.999Z` round-trips). Only
  the *year* edge is broken — that is F4.
- **Malformed JSON in the authority** is skipped and counted, not fatal
  (`repro/b-replay.mjs`); only unknown kinds and bad args are fatal (F3).
- **`INSERT OR IGNORE` on a genuine repeat** (the same writer called twice with
  identical args) is a correct no-op and `jsonlDrift` rightly reports 0 — the
  drift check's distinct-key design is right for *that* case. F1/F2 are the
  case it cannot express.

---

## Files read in full

- `scripts/factory/ledger.mjs` (4,322 lines)
- `visualizer/server/ledger-feed.mjs` (387)
- `visualizer/server/shape.mjs` (1,143) — read in full for the shapers and
  window helpers; the intake/roster shapers were read but are out of this
  hunt's scope
- `visualizer/server/server.mjs` (439)
- `visualizer/server/feed.mjs` (10)

Read in relevant part (not in full): `crew/daemon.mjs` (constants, `deriveState`,
`normalizeEvent`, `usageWindow`, budget admission, `scopeEntryDefects`),
`crew/seat-io.mjs` (the emitter fan-out, `:1000-1090`),
`scripts/factory/transcript.mjs`, `test/factory-ledger.test.mjs` (the
concurrency, replay and AC-4 sections), `test/visualizer-*.test.mjs` (fixture
shapes only).
