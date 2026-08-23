# h5-http — adversarial defect hunt on the visualizer HTTP surface

Read-only recon. The checkout was never written to (`git status --porcelain`
empty before and after). Everything below was measured against `git archive
HEAD` unpacked into a fresh `mkdtemp` directory, with a throwaway
`ledger.db` / triage sidecar / crew root / stop-switch checkout, on an
**ephemeral port (`--port 0`)** every time.

**One command reproduces every defect and every negative result:**

```
CHECKOUT=/Users/x/Development/dt-h5 node /Users/x/.crew/dt-h5/h5-http/task/repro/run-all.mjs
```

Captured output of that run: `repro/run-all.output.txt`. Sections are labelled
`D1`…`D12` and `DN` (negative results) and are cited per finding below.

## Files read in full

`visualizer/server/server.mjs` (439 lines) · `visualizer/server/ledger-feed.mjs`
(387) · `visualizer/server/shape.mjs` (1143) · `visualizer/server/roster-source.mjs`
(112) · `visualizer/server/returns-source.mjs` (82) · `visualizer/server/feed.mjs`
(10) · `visualizer/server/triage.mjs` (50) · `visualizer/web/src/lib/api.js` (24).

Read in part: `visualizer/web/src/lib/panels.js` (the read-loop and absence
helpers), `visualizer/web/src/lib/CellHealthPanel.svelte`,
`test/visualizer-server.test.mjs` (harness + fixture). **Not read:**
`roster-ladder.mjs`, `roster-edit.mjs` — reachable through `/api/roster/*` but
outside the four `where` files; their routes were attacked black-box and are
covered under negative results.

---

# Findings, ranked by severity

## F1 · hangs-or-leaks · one request kills the process

**`server.mjs:178` builds a URL outside the `try` that starts on `:179`.**

```js
const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)   // :178
try {                                                                              // :179
```

`new URL` throws on two attacker-chosen inputs, and the throw escapes the async
handler as an unhandled rejection, so Node exits 1.

**Reproduction:** `repro/run-all.mjs`, sections **D1** and **D2**.

**Observed** (D1) — the path `//` is a scheme-relative URL with an empty
authority, so it throws even with a perfectly valid `Host`:

```
  GET /        -> survived       client saw: HTTP/1.1 200 OK
  GET //       -> DIED exit 1    client saw: (nothing at all)
  GET ///      -> DIED exit 1    client saw: (nothing at all)
  GET //?x=1   -> DIED exit 1    client saw: (nothing at all)

  through an ordinary client: curl http://127.0.0.1:55213//  ->  curl: Command failed
  server: DIED exit 1
  port after the crash: free
  stderr:
    TypeError: Invalid URL
        at new URL (node:internal/url:840:25)
        at Server.<anonymous> (…/visualizer/server/server.mjs:178:17)
```

`fetch('http://127.0.0.1:<port>//')` reaches it too — the WHATWG parser keeps
`//` as the pathname — so a page in the operator's browser can kill the
visualizer with one line and no preflight.

**Observed** (D2) — nine ordinary-looking `Host` values do the same, and an
innocent in-flight client is dropped with it:

```
  Host: "]bad["          -> DIED exit 1    client saw: (nothing at all)
  Host: "a:b:c"          -> DIED exit 1
  Host: "%"              -> DIED exit 1
  Host: "ho st"          -> DIED exit 1
  Host: "[::1"           -> DIED exit 1
  Host: "@"              -> DIED exit 1
  Host: "x:99999999"     -> DIED exit 1
  Host: "a b"            -> DIED exit 1

  an in-flight client during the crash:
    DIED exit 1
    the innocent keep-alive client was dropped
    a later request: ECONNREFUSED
```

**Expected:** a 400 for a request whose target or `Host` cannot be parsed, and
the process still serving. The `|| 'localhost'` fallback on `:178` shows the
author anticipated a *missing* Host; an *invalid* one was not considered.

**Guard that should have caught it, and why it did not:** the handler's own
`try/catch` (`:179`–`:408`) is the designed guard and it maps any throw to a
500 — but the URL parse is one line above it. `test/visualizer-server.test.mjs`
drives the server exclusively through `fetch(base + path)`, which cannot emit
either input (undici normalises the target and writes its own `Host`), so no
test can reach the line. Nothing in the suite sends a raw request line.

---

## F2 · corrupts-state · any web page can engage the factory stop switch

`POST /api/intake/brake` (`server.mjs:295`–`:343`) writes `.factory/STOP` into
the configured checkout and records a ledger row. It checks no `Origin`, no
`Referer`, no `content-type` and no token — so it is reachable as a CORS
**simple request**, which needs no preflight.

**Reproduction:** `repro/run-all.mjs`, section **D7**.

**Observed:**

```
  GET /api/intake/brake -> clear
  POST with content-type: text/plain and Origin: https://evil.example
    -> HTTP 200 ok=true state=engaged recorded=true
  stop switch on disk: ENGAGED
     {"actor":"evil.example","at":"2026-08-23T10:18:29.527Z"}
  POST /api/triage from the same origin -> 200 {"schema":1,"adw_id":"csrf","reviewed_at":…}
```

**Expected:** a state-writing route on a loopback server should refuse a
cross-origin request — reject a non-`application/json` content-type (which
alone forces a preflight the browser will fail), and/or refuse a request whose
`Origin` is not the server's own.

**Severity call:** `corrupts-state`. The write is durable and consequential:
`.factory/STOP` is the intake loop's halt switch (`STOP_SWITCH_PATH`,
`server.mjs:18`), so a drive-by page parks the whole factory, attributed to an
actor string the attacker chose. `/api/triage` writes the triage sidecar the
same way.

**Honest limits:** the attacker must guess the port (the default 4488 is one
guess), and Chrome's Private Network Access gating may block a public page from
reaching 127.0.0.1 — that mitigation is the browser's, not the server's, and
does not apply to any local process. The reply is unreadable cross-origin, but
a `no-cors` POST never needs to read it.

**Guard that should have caught it:** none exists. The route's own validation
(`:300`–`:306`) checks the *shape* of the body, never the *origin* of the
request, and `test/visualizer-server.test.mjs` only ever posts
`content-type: application/json` from the same process.

---

## F3 · refuses-wrongly · the CLI is a silent no-op behind any symlinked path

`server.mjs:419`:

```js
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
```

`resolve()` normalises but never follows a symlink; the ESM loader **does**
realpath the module URL. When `argv[1]` contains a symlink the two disagree,
the whole `if (invokedDirectly)` block is skipped, and the process exits 0
having started no server and printed nothing — including for inputs it is
supposed to refuse.

**Reproduction:** `repro/run-all.mjs`, section **D3**.

**Observed:**

```
  A real absolute path  + valid flags -> RUNNING (a server started)
  B symlinked DIRECTORY + valid flags -> exit 0   stdout: (empty)  stderr: (empty)
  C symlinked FILE      + valid flags -> exit 0   stdout: (empty)  stderr: (empty)
  D real absolute path  + BAD flag    -> exit 2   stderr: viz-serve: unknown flag --untill …
  E symlinked DIRECTORY + BAD flag    -> exit 0   stderr: (empty)
  F symlinked FILE      + BAD flag    -> exit 0   stderr: (empty)
  G symlinked CWD, RELATIVE argv[1]   -> exit 2   stderr: viz-serve: unknown flag --untill …
  H real CWD,      RELATIVE argv[1]   -> exit 2   stderr: viz-serve: unknown flag --untill …
```

**Expected:** B/C behave as A, E/F behave as D. A caller that asks for a server
and gets exit 0 has been told it succeeded.

**The brief's question — does a symlinked cwd change behaviour? No.** G vs H is
the measurement: with a *relative* `argv[1]` (the `npm run viz:serve` shape,
`package.json:17`) a symlinked cwd changes nothing, because `process.cwd()` is
already the kernel's realpath, so both sides of the comparison realpath
identically. The seam opens only when the symlink is inside the `argv[1]`
**string**.

**This is not hypothetical.** On macOS `/tmp` → `/private/tmp` and
`os.tmpdir()` → `/var/folders/…` where `/var` → `/private/var`. My own harness
tripped over it on its first run — every `boot()` exited 0 silently until
`harness.mjs:27` was changed to `realpathSync(mkdtempSync(...))`. Any checkout
or worktree reached through a symlinked path has a dead `viz:serve`.

**Guard that should have caught it:** `test/visualizer-server.test.mjs:68`
builds `SERVER_SCRIPT` as `join(process.cwd(), 'visualizer', 'server',
'server.mjs')` and `test/factory-env.test.mjs` does the same, so every CLI test
runs down the one path where the comparison happens to hold. Comparing
`realpathSync(argv[1])` (or `process.argv[1] === fileURLToPath(import.meta.url)`
after realpathing both) is what the check means.

---

## F4 · wrong-answer · the window routes validate with `Date.parse` and query with a string compare

`/api/cell-health`, `/api/run-set`, `/api/intake`, `/api/seat-teardowns` and
`/api/cell-attribution` all admit `since`/`until` if `Date.parse` returns a
number (`server.mjs:212`–`:214`, `:225`–`:227`, `:258`–`:260`, `:272`–`:274`,
`:286`–`:288`), then pass the **raw string** into SQL that compares it to ISO
timestamps with `>=` (`ledger-feed.mjs:129`, `:148`, `:168`, `:187`, `:314`,
`:357`). `Date.parse` accepts far more than ISO-8601, and every non-ISO form
sorts *above* `2026-…` lexicographically, so it silently excludes everything.

**Reproduction:** `repro/run-all.mjs`, section **D4**.

**Observed** — three spellings of the same instant, one of them right:

```
  since="2020-01-01T00:00:00.000Z"      run-set: HTTP 200 runs=2 absent=null | cell-health: cells=7 recorded=1
  since="Jan 1 2020"                    run-set: HTTP 200 runs=0 absent=null | cell-health: cells=6 recorded=0
  since="Wed, 01 Jan 2020 00:00:00 GMT" run-set: HTTP 200 runs=0 absent=null | cell-health: cells=6 recorded=0
```

**Expected:** all three answer identically, or the two non-ISO forms are
refused with the 400 the route already owns (`'since and until must be ISO
timestamps'`) — the error message already claims ISO is the contract while the
check does not enforce it.

**Why this is the worst kind of wrong answer here:** `absent: null` with
`runs: 0` is this codebase's definition of a *measured zero*. `shape.mjs:637`
(`DEGRADED_ABSENT_WHY`), `:635` (`PER_RUN_UNMEASURED_NOTE`) and `:927`
(`CELL_ATTRIBUTION_CLEAN_WHY`) all exist to stop a silence being read as a
zero. Widening the window to 2020 makes the answer *smaller*, and the payload
asserts that smaller answer was measured.

**Guard that should have caught it:** `test/visualizer-shape.test.mjs` and
`test/visualizer-panels.test.mjs` exercise `shapeCellHealth`/`shapeRunSet` with
ISO fixtures only, and `test/visualizer-server.test.mjs` asserts the 400 for
`since=nonsense` — a string `Date.parse` also rejects. No test supplies an
input the validator accepts and the query then misreads.

---

## F5 · wrong-answer · `/api/sessions` validates nothing

`server.mjs:182` forwards `mode`, `status`, `since`, `until` straight to
`feed.listRuns` with no parse and no refusal, while its five sibling window
routes 400 on the same tokens.

**Reproduction:** `repro/run-all.mjs`, section **D4** (second half).

**Observed:**

```
  /api/sessions (none)                                                        HTTP 200 runs=2
  /api/sessions?since=-1                                                      HTTP 200 runs=2
  /api/sessions?since=1e309                                                   HTTP 200 runs=2
  /api/sessions?since=zzz                                                     HTTP 200 runs=0
  /api/sessions?since=2030-01-01T00:00:00.000Z&until=2020-01-01T00:00:00.000Z HTTP 200 runs=0
  the same since=1e309 on a sibling route:
  /api/cell-health?since=1e309                                                HTTP 400 "since and until must be ISO timestamps"
```

`since=-1` and `since=1e309` **widen to the full set** (every ISO string sorts
above `-1` and `1e309`); junk narrows to empty; an inverted window answers
empty instead of refusing. `matchesFilters` (`shape.mjs:321`–`:330`) is a
second, *different* interpretation of the same two parameters — `dateValue`
there ignores what it cannot parse, so the SQL string filter is the only one
that acts.

**Expected:** the same refusal table the sibling routes carry, including the
`until must be later than since` inversion check.

**Guard that should have caught it:** `test/visualizer-server.test.mjs`
exercises `/api/sessions` filters only with well-formed values.

---

## F6 · wrong-answer · no route refuses an unknown query parameter (the `--untill` class)

**Reproduction:** `repro/run-all.mjs`, section **D5**.

**Observed** — the same bound, spelled right and spelled wrong:

```
  intended /api/cell-health?until=2026-08-23T09:49:05.191Z
     -> HTTP 200 window.until="2026-08-23T09:49:05.191Z"
  typo     /api/cell-health?untill=2026-08-23T09:49:05.191Z
     -> HTTP 200 window.until=undefined   <-- the bound was silently dropped
```

…identically for `/api/run-set`, `/api/intake`, `/api/seat-teardowns`,
`/api/cell-attribution`, and:

```
  /api/events?limit=1  -> 1 events
  /api/events?limitt=1 -> 27 events   <-- the cap was silently dropped
```

**Expected:** a 400 naming the unknown parameter. This is the exact class
`parseCliArgs` was hardened against for the flag door — `CLI_FLAGS`
(`server.mjs:55`–`:65`) with the comment *"a misspelled flag is a usage
refusal (exit 2), not a silently ignored default (#443)"*. The query door never
got the same treatment, and it is the door a human actually types into.

**Guard that should have caught it:** `test/factory-env.test.mjs` and
`test/visualizer-server.test.mjs` pin the #443 refusal for `parseCliArgs`.
Nothing pins the equivalent for `url.searchParams`.

---

## F7 · wrong-answer · `/api/events` cannot tell "no events" from "the ledger is unopenable"

`ledger-feed.mjs:102` — `if (!handle) return { events: [], cursor: after }` —
carries neither `degraded` nor `absent`.

**Reproduction:** `repro/run-all.mjs`, section **D6**.

**Observed** — byte-identical bodies:

```
  healthy ledger, a run with no events after id 999999:
    {"schema":1,"events":[],"cursor":999999}
    control /api/sessions degraded: false
  UNOPENABLE ledger, the identical request:
    {"schema":1,"events":[],"cursor":999999}
    control /api/sessions degraded: true
    control /api/cell-health absent: "unable to open database file"
```

**Expected:** what every sibling does — `listRuns` returns `degraded: true`
(`:58`), the window routes return `absent: "unable to open database file"`.
`/api/events` is the one reader that answers a measured-looking empty page.

**Guard that should have caught it:** `test/visualizer-server.test.mjs` covers
the degraded ledger for `/api/sessions` and `/api/health`; no test asks
`/api/events` what it says when the database will not open.

---

## F8 · wrong-answer · `/api/returns` denies a directory that exists

`returns-source.mjs:36`–`:45`: when a candidate directory holds a
`ledger/run.json` whose `adw_id` does not match the query, `hasRun` becomes
true, which *disables* the unverified-fallback branch, and the route reports an
absence that is false.

**Reproduction:** `repro/run-all.mjs`, section **D11**.

**Observed:**

```
  adw_id="(omitted)"                        HTTP 200 error="no task directory for this run" dir=null envelopes=0
  adw_id="hunt-done-0000-0000-000000000001" HTTP 200 error=undefined dir=present envelopes=1
  adw_id="wrong-id"                         HTTP 200 error="no task directory for this run" dir=null envelopes=0
```

The directory, its `run.json` and its one envelope are all on disk in every
case. Note the asymmetry: a candidate with **no** `run.json` is returned with
`verified: false`, while a candidate with a *non-matching* `run.json` is
denied outright.

**Expected:** either the directory with `verified: false`, or an error that
states the true condition ("the task directory records a different run").
`server.mjs:200` defaults `adw_id` to `''`, so the omitted-parameter call is a
first-class request the API answers with a false statement.

**Guard that should have caught it:** `test/visualizer-returns.test.mjs`
covers the matching and the no-`run.json` paths; the mismatching-`run.json`
path is untested.

---

## F9 · refuses-wrongly · `POST /api/triage` 500s on a JSON `null` body

`server.mjs:401` reads `input.adw_id` with no null guard. Every sibling POST
route opens with `!input || typeof input !== 'object' || …` (`:300`, `:348`,
`:367`, `:382`); triage does not.

**Reproduction:** `repro/run-all.mjs`, section **D9**.

**Observed:**

```
  triage null   -> 500 {"schema":1,"error":"Cannot read properties of null (reading 'adw_id')"}
  triage []     -> 400 {"schema":1,"error":"adw_id and reviewed are required"}
  triage 5      -> 400 {"schema":1,"error":"adw_id and reviewed are required"}
  brake  null   -> 400 {…}
  propose null  -> 400 {…}
  stage  null   -> 400 {…}
  compose null  -> 400 {…}
```

**Expected:** `400 {"error":"adw_id and reviewed are required"}`, the same as
`[]` and `5`. A V8 property-access message on the wire is an internal detail.

**Guard that should have caught it:** `test/visualizer-server.test.mjs` posts
malformed triage bodies, but not the JSON literal `null`.

---

## F10 · refuses-wrongly · `/api/events` numeric bounds are half-checked

`integer()` (`server.mjs:92`–`:96`) accepts any digit string with no
safe-integer or upper bound. Two different failures follow.

**Reproduction:** `repro/run-all.mjs`, section **D9**.

**Observed:**

```
  /api/events?limit=99999999999999999999999 -> 500 {"schema":1,"error":"datatype mismatch"}
  /api/events?after=99999999999999999999999 -> 200 {"schema":1,"events":[],"cursor":1e+23}
  replaying the cursor it just handed back (after=1e+23) -> 400 {"schema":1,"error":"after, limit and phase_id must be integers"}
```

`Number("999…")` is `1e23`, a non-integral double; sqlite refuses to bind it to
`LIMIT` (raw driver text reaches the client as a 500), and accepts it for
`id > ?`. The paging contract then contradicts itself: the route hands back a
`cursor` that the same route refuses on the next request, so a client looping
on `cursor` stalls with a 400 it cannot fix.

**Expected:** a 400 from `integer()` for anything outside
`Number.isSafeInteger`, and a `cursor` the route will always accept. Note
`limit` also has no ceiling at all — `limit=9007199254740991` is admitted.

**Guard that should have caught it:** `test/visualizer-server.test.mjs` pins
the 400 for `limit=0`, `limit=-1` and non-numeric input; nothing pins the top
of the range, and nothing round-trips a returned `cursor`.

---

## F11 · hangs-or-leaks · SIGTERM never returns while a request is in flight

`server.mjs:410` — `const close = () => { server.close(() => feed.close()) }`.
`server.close()` stops accepting and lets existing requests finish; a client
that announces a body and does not send it holds the process open with no
timeout.

**Reproduction:** `repro/run-all.mjs`, section **D8**.

**Observed:**

```
  1. no connections                            exit 0/null after 2ms     port: free
  2. one IDLE keep-alive socket                exit 0/null after 3ms     port: free
  3. socket open, no bytes sent                exit 0/null after 3ms     port: free
  4. IN-FLIGHT request (dribbled POST body)    STILL RUNNING after 5000ms port: free
  …
  after 1st SIGTERM: alive
  after 2nd SIGTERM: exit null/SIGTERM
```

**Expected:** SIGTERM terminates. Idle keep-alive and half-open sockets are
handled correctly by Node — good — but one in-flight request is unbounded.

**Consequences, both measured above:** the listening port frees while the
process lives, so a restart rebinds happily *beside* an orphan that still holds
`ledger.db` and the triage sidecar (WAL) open. The second SIGTERM does kill it
— `process.once` removed the listener, restoring the default disposition — but
that path never runs `feed.close()`, so the databases are closed by process
death rather than by the shutdown handler that exists to close them.

**Guard that should have caught it:** `stopServer` in
`test/visualizer-server.test.mjs:82` and the same helper in
`test/visualizer-teardown.test.mjs:71` send SIGTERM and await exit with no
connection outstanding — scenario 1 above, the one case that always passes.

---

## F12 · wrong-answer · a symlink inside `web/dist` escapes the static fence

`server.mjs:159` guards with a lexical prefix test on `resolve()`d strings,
which never follows a symlink.

**Reproduction:** `repro/run-all.mjs`, section **D10**.

**Observed** (a `leak.txt` symlink and an `out/` symlinked directory planted in
the scratch `dist`):

```
  200  /                                  "<!doctype html><title>real index</title>"
  200  /assets/app.js                     "console.log(\"app\")"
  404  /%2e%2e%2f%2e%2e%2fetc%2fpasswd    "Not found"
  404  /..%2f..%2fetc%2fpasswd            "Not found"
  200  /leak.txt                          "TOP SECRET"
  200  /out/x.txt                         "OUTSIDE FILE"
```

**Expected:** 404 for anything whose realpath leaves `DIST`. Lexical and
URL-encoded traversal are correctly refused — that half of the guard works.

**Honest severity:** it takes a symlink inside the build output to exploit, so
this is a latent hole rather than a live leak; a `public/` asset that is a
symlink is the realistic route in. Filed as `wrong-answer` (the server serves
content it has declared out of scope), not as a live disclosure.

**Guard that should have caught it:** `test/visualizer-server.test.mjs` asserts
the traversal refusals against a built `dist`; no test plants a symlink.

---

## F13 · cosmetic · `HEAD` is 405 on every API route, and no 405 carries `Allow`

**Reproduction:** `repro/run-all.mjs`, section **D12**.

```
  /api/health      HEAD=405 Method Not Allowed | OPTIONS=405 | DELETE=405
  /api/sessions    HEAD=405 Method Not Allowed | OPTIONS=405 | DELETE=405
  /api/triage      HEAD=405 Method Not Allowed | OPTIONS=405 | DELETE=405
  /                HEAD=200 OK                 | OPTIONS=405 | DELETE=405
```

RFC 9110 requires HEAD wherever GET is implemented (the static route does it
right; every `/api/` route does not) and requires an `Allow` header on a 405 —
none is sent. Health-checkers and reverse proxies that probe with HEAD will
read a live board as broken. Cosmetic: nothing lies about the data.

---

# Observations (not defects — deliberate behaviour, recorded so the next hunt skips them)

- **Absolute host paths are returned to the client by design.** `/api/health`
  (`ledger_db`, `triage_db`), `/api/roster` (`path`), `/api/roster/ladder`
  (`path`, `reference_path`), `/api/returns` (`dir`, per-envelope `file`) and
  `/api/intake/brake` (`path`, `checkout`) all disclose them. These are the
  provenance the panels render; on a loopback board that is the intent, not a
  leak. The only *unintended* disclosures found are the raw driver/V8 strings
  in F9 and F10.
- **`--host 0.0.0.0` is accepted and binds the write endpoints to every
  interface** with no authentication. It is an explicit operator flag, so not a
  defect — but it turns F2 from a browser-only problem into a LAN one.
- **`--host bogus.invalid` exits 1 with a raw `node:events` stack.** The
  comment at `server.mjs:421`–`:425` anticipates exactly this (async listen
  failures keep exit 1); the operator sees an uncaught-exception dump rather
  than a message. Cosmetic.
- **`api.js:2`–`:5` awaits `response.json()` before checking `response.ok`**, so
  a non-JSON error body surfaces as a JSON parse error instead of the status.
  Reachable only via the static route's empty-bodied 405 (`server.mjs:406`),
  which the client never requests. Cosmetic; the web client is out of scope
  except as an observer.
- **Routing ignores the request-target's authority.** `GET //evil.com/api/sessions`
  resolves to pathname `/api/sessions` and is served as such. Harmless here (no
  host-based logic) but worth knowing when reading F1.
- **`/api/roster/ladder` reports `degraded: false` with an unopenable ledger** —
  that flag describes the *ladder file*, and each chip separately carries
  `measured_pending: "unmeasured here — unable to open database file"`. Honest;
  verified by inspecting the full payload.

# SUSPICIONS (could not reproduce — not findings)

- **`json()` after headers are sent → a second crash class.** If any handler
  could throw *after* `res.writeHead`, the `:408` catch would call `json()` on a
  sent response and throw `ERR_HTTP_HEADERS_SENT` out of the handler, the same
  escape as F1. Tried: circular/oversized payloads, `checks_json` garbage, a
  degraded feed mid-render. Every route serialises before writing
  (`json()` builds the body first, `server.mjs:88`), so I found no reachable
  path. Untested: a `BigInt` from `node:sqlite` for an out-of-double-range
  integer column, which `JSON.stringify` throws on — I could not get the ledger
  writers to store one.
- **`process.once('SIGTERM', close)` runs on every `startServer` call**
  (`server.mjs:411`), so an in-process harness that boots many servers
  accumulates listeners. I did not observe a `MaxListenersExceededWarning` in
  any run, and `once` removes each on fire; recorded only because the
  registration is per-call and unconditional.
- **A degraded feed's `_reason` latch** (`ledger-feed.mjs:53`, acknowledged by
  the comment at `server.mjs:233`–`:237`) should be able to make `/api/run-set`
  name a stale reason for a healthy read. I could not construct a transient
  fault that latches and then clears — the read-only handle either opens or
  does not.

# Negative results — attacks the code survived (do not re-run these)

From `repro/run-all.mjs` section **DN**, plus the batteries folded into D1–D12:

| attack | result |
| --- | --- |
| 20 connections reset mid-response | server healthy, 200 after |
| 10 POSTs aborted mid-body | server healthy, 200 after |
| 360 concurrent panel reads across all 9 GET panels (2-client race) | all 200 |
| 60 concurrent `POST /api/triage` writes to the sqlite sidecar | all 200, no lock error |
| 8 000-byte header | 200 |
| 20 000-byte header | 431 (Node's own limit) |
| 100 000-byte header | connection reset (Node's own limit) |
| a body on `GET /api/sessions`, `/api/health`, `/` | 200; a pipelined follow-up request is answered |
| `Host:` absent / empty | 200 (`|| 'localhost'` fallback works) |
| `' OR 1=1 --` in `status`, `mode`, `type`, `role`, `adw_id` | 200, 0 rows — every query is parameterised |
| `%00` in `mode`, `repo_slug`, static paths | refused or ignored, no crash |
| `/../../../etc/passwd`, `//etc/passwd`, `/....//....//`, `/assets/../` | 404 or SPA fallback; never escapes `DIST` |
| `%2e%2e%2f`, `..%2f`, `/%2e%2e/%2e%2e/` encoded traversal | 404 "Not found" |
| `/%c0%ae%c0%ae/` overlong-UTF-8 traversal | 400 "Bad request" |
| `repo_slug=..`, `%2e%2e`, `%2e%2e%2fetc` on `/api/returns` | "invalid repo_slug or task_slug" |
| `--port -1 / 1e309 / 99999 / 0x50 / +5` | exit 2 refusal (`parsePort`, #474) |
| `DEVTEAM_VIZ_PORT=-1 / 99999` | exit 2 refusal (`portFromEnv`, #474) |
| `DEVTEAM_VIZ_PORT=0` | binds ephemeral, as designed (#466) |
| unknown / short / positional CLI args, `--port` with no value, `--host ""` | exit 2 refusals (`parseCliArgs`, #443) |
| `--ledger-db <a directory>`, `--checkout /nonexistent` | server starts and degrades honestly |
| `limit=-1 / 0 / NaN / 1e3 / +5`, `phase_id=abc`, `after=-1` | 400 refusals |
| `since=` / `until=` empty, `since=NaN`, `since=1e309` on the five window routes | 400 refusals |
| `until` earlier than `since` on the five window routes | 400 `until must be later than since` |
| repeated query parameters (`?since=a&since=b`) | first value wins (WHATWG default); no crash, no widening |
| a degraded ledger on `/api/cell-health`, `/api/run-set`, `/api/intake`, `/api/seat-teardowns`, `/api/cell-attribution` | `absent` set, per-cell `state: undetermined`, counts `null` — honest, never a measured zero |
| `POST` `null` / `[]` / `5` / `""` / `{` / >4 KiB to `/api/intake/brake`, `/api/roster/propose`, `/api/roster/ladder/stage`, `/api/roster/ladder/compose` | 400 refusals (only `/api/triage` fails — F9) |
| SIGTERM with no connections / one idle keep-alive / a silent socket | clean exit in <5 ms, port freed |
| a web-client panel loop across a server bounce (`panels.js:43`–`:50`) | a plain `setInterval`; a rejected read sets `error` (rendered as the panel's `absent`) and leaves `read_at` alone, so the panel shows the failure, goes visibly stale, and recovers on the next tick — truthful. Verified by code, not by a browser. |

# Repro assets

| path | what it is |
| --- | --- |
| `repro/run-all.mjs` | every reproduction, D1–D12 plus negative results |
| `repro/harness.mjs` | `git archive HEAD` → temp dir, throwaway ledger, `boot()` on port 0 |
| `repro/run-all.output.txt` | captured output of the run quoted above |
