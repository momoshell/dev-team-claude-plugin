# Lens B — envelope / frame readers (headless.mjs, headless-rpc.mjs, seat-io.mjs)

Scratch copy: `.../h2/repo` (verified `md5` identical to the real checkout for
`crew/headless.mjs`). Node v26.5.1. `timeout(1)` is absent on this mac; every
experiment runs under `./to <seconds> node <script>` (perl `alarm` wrapper).

Baseline: `node --test crew/headless.test.mjs crew/headless-rpc.test.mjs
crew/io-contract.test.mjs` = **124 pass / 0 fail**. Everything below is a gap in
what is pinned, not a regression.

---

## FINDINGS

### B1 — one unparseable envelope, three different answers; only the pane path is right
**Severity: wrong-answer (headless-rpc) / refuses-wrongly + budget-burn (headless-json)**
**Repro:** `e10-side-by-side.mjs`, `e3-headless-json-malformed.mjs`, `e3b-headless-json-budget-burn.mjs`, `e4-rpc-malformed.mjs`

`crew/seat-io.mjs:1320-1349` states the contract: *"An UNPARSEABLE return file is
not an ABSENT one... a file that IS there and cannot be parsed polls the full
budget on a condition that can never resolve (lane b52-heartbeat: 40 minutes lost
to one literal newline inside a summary string)"*. `readEnvelopeFile` implements
it — for `transport: 'pane'` only. `seatIo.wait` (`crew/seat-io.mjs:1739-1741`)
routes every other transport to `transport.wait()`, and both transports' own
readers swallow the parse error and return `null`:

* `crew/headless.mjs:154-160` `envelopeAt` — `catch { return null }`
* `crew/headless-rpc.mjs:166-172` `envelopeAt` — `catch { return null }`

Observed, same 114 bytes through the real `seatIo`, budget 600 s (`e10`):

```
SAME BYTES: "{\"assignment_id\":\"d1\",\"role\":\"builder\",\"status\":\"done\",\"summary\":\"finished\nthe build\",\"artifacts\":[],\"details\":{}}"

### pane            (pinned by seat-io-runclean.test.mjs:853)
  outcome            : {"stage":"pane-parse-error","kind":"unusable-envelope","message":"unusable envelope at .../returns/d1.builder.json: the file EXISTED (114 bytes) and is not JSON this driver can read: Bad control character in string literal in JSON at position 74 (line 1 column 75)"}
  cell-failure kind  : ["unusable-envelope"]

### headless-json   (unpinned)
  outcome            : {"stage":"headless-no-envelope","kind":"no-envelope","message":"headless no-envelope: seat builder produced no valid envelope at .../returns/d1.builder.json"}
  cell-failure kind  : ["no-envelope"]

### headless-rpc    (unpinned)
  outcome            : {"returned":{"assignment_id":"d1","role":"builder","status":"insufficient","summary":"seat builder settled without writing an envelope to .../returns/d1.builder.json; the turn produced no usable return","artifacts":[],"details":{"degraded":"rpc-no-envelope"}}}
  cell-failure kind  : ["no-envelope"]
```

Three separate defects fall out:

**B1a (worst) — headless-rpc FABRICATES a false envelope.** `crew/headless-rpc.mjs:627-636`
takes the `turn.state.settled && !env` branch and returns
`emptyTurnEnvelope` (`:200-207`), whose summary asserts *"settled without writing
an envelope ... the turn produced no usable return"*. In `e4` the seat had
written `status:"done"` with `details.pr:"#999"` and those bytes were still on
disk, untouched, when the fabricated `status:"insufficient"` was handed to the
driver. The fabrication passes `validEnvelope` (`crew/drive.mjs:623-628`) and
`envelopeDefect` (`e5`: `defect null`), so the driver bounces or escalates a
completed turn while the record of it sits unread. The usage event still bills
the turn (`billed_input_tokens: 100`).

**B1b — headless-json reports "produced no valid envelope" about a file that exists,
and no re-ask is possible.** `crew/headless.mjs:316` throws
`outcomeError(run, 'no-envelope')`; `cellFailureKind` (`crew/seat-io.mjs:977-988`)
maps `headless-no-envelope` → `'no-envelope'`; `reaskDecision`
(`crew/seat-io.mjs:1352`) then refuses:
`{"ask":false,"why":"failure kind no-envelope is not an unparseable envelope, so there is nothing a re-emit could fix"}`.
`err.raw` is never attached, so the escalation cannot quote the bytes either.

**B1c — the b52 budget burn is unfixed on headless-json.** `e3b`: identical
malformed file, worker not yet exited. Observed:
```
budget requested (s)  = 3600
virtual ms burned     = 3610000 (= 3610s)
poll iterations       = 722 @ WAIT_POLL_MS=5000
err.stage             = "headless-timeout"
cellFailureKind       = "timeout"
```
The full hour is spent on a condition that can never resolve, and the failure is
then attributed as a `timeout` — which routes into `timeoutAttribution()`
(`crew/seat-io.mjs:1549-1557`) and gets blamed on host load or the cell.

**Expected:** all three transports classify a present-but-unparseable return file
as `unusable-envelope` at the read boundary, carrying the parser position and the
raw bytes, exactly as the pane path does.

**Missing guard:**
* `crew/headless.test.mjs:111-125` — the only stage-discrimination table. It
  varies `stream.jsonl` and `exit` and **never writes a return file at all**;
  `headless-malformed` there means *the STREAM had no JSON*, not *the ENVELOPE is
  bad*.
* `crew/headless-rpc.test.mjs:~525-556` — the `status:'insufficient'` pin covers
  only an **absent** return file.
* `crew/io-contract.test.mjs:379-395` maps `headless-malformed` and
  `rpc-parse-error` onto `unusable-envelope`, but neither transport ever emits
  those stages for a bad envelope FILE (`rpc-parse-error` at
  `crew/headless-rpc.mjs:592-594` is pi failing to parse a COMMAND we sent it).
  The closed-kind table has an entry with no producer for the case that matters.
* `crew/seat-io-runclean.test.mjs:853-884` is the real guard — and its member is
  hard-coded `transport: 'pane'`, with `assert.ok(clock <= WAIT_POLL_MS)` as the
  fail-fast pin. No sibling test for the other two transports.

---

### B2 — `recogniseProviderCondition` fabricates provider conditions from ordinary numbers
**Severity: wrong-answer (fabricated ledger evidence)** · **Repro:** `e5-shape-and-usage.mjs`

`crew/headless.mjs:26-30` matches `\b401\b`, `\b403\b`, `\b429\b`, `\b529\b` against
the worker's whole stderr. The file header (`:46-49`) claims *"it never fabricates
a condition"*. Observed:

```
"Error: something failed\n    at /repo/crew/drive.mjs:401:12"   "auth"
"gate summary: 429 checks passed"                               "rate-limit"
"wrote 401 bytes to disk"                                       "auth"
"the file /tmp/x-403-y.log is gone"                             "auth"
"req took 429 ms"                                               "rate-limit"
```

A stack trace whose frame happens to be on line 401 or 403 — the single most
common thing in a worker's stderr — is recorded as an **auth failure**. The value
reaches `err.providerCondition` (`crew/headless.mjs:239-241`) →
`providerConditionDetail` (`crew/seat-io.mjs:1266-1272`) → the `[provider:auth]`
prefix on the cell-failure `detail` column in the ledger.

**Expected:** the bare-number alternatives require HTTP context (`status 401`,
`HTTP 429`, `"code": 529`), or are dropped in favour of the named
`*_error` / phrase forms that already carry the signal.

**Missing guard:** `crew/headless.test.mjs:127-141` only asserts the TRUE
positives (`529 ... overloaded_error`, `rate_limit_error`). There is no
negative-case table, so no test can go red on a false positive. Mitigating: the
header is right that nothing branches on the value — the damage is confined to
recorded evidence.

---

### B3 — headless-rpc re-reads the entire transcript on every poll and on every assign
**Severity: hangs-or-leaks** · **Repro:** `e7-rpc-stream-reads.mjs`

* `crew/headless-rpc.mjs:264-267` `fileSize()` does `byteLength(read(path))` — a
  full file read to obtain a size `fstat` gives for free.
* `crew/headless-rpc.mjs:282-301` `readFrames()` does `read(path)` on the WHOLE
  file every poll, then `subarray(seat.readOffset)`.

Observed against a 20 MiB seat transcript (a realistic long-lived RPC seat):
```
pre-existing stream size: 20.0 MiB
assign(d1): readFileSync calls = 18, bytes read = 40.0 MiB  (a stat() would have cost 0)
one wait() iteration: readFileSync calls = 2, bytes read = 20.0 MiB
```
`wait()` polls at `WAIT_POLL_MS = 5000`, so a 20-minute turn on that seat reads
~240 × 20 MiB ≈ **4.8 GiB**, and it worsens as the transcript grows — O(n²) in
transcript size, with a 20 MiB Buffer allocated and discarded every 5 seconds.

**Expected:** the correct pattern is already in this codebase —
`crew/daemon.mjs:598-613` `readFrom()` uses `open`/`fstat`/positional `readAt`
from the cursor offset. `fileSize` should be a `stat`.

**Missing guard:** no test in `crew/headless-rpc.test.mjs` measures read volume;
its fixtures use tiny streams, so the cost is invisible.

---

### B4 — no `MAX_FRAME_BYTES` equivalent on the RPC frame reader
**Severity: hangs-or-leaks** · **Repro:** `e7-rpc-stream-reads.mjs` (second half), `e1-splitframes.mjs` E1.7

`crew/daemon.mjs:140-155` caps both `rest` and any single line at
`MAX_FRAME_BYTES` (1 MiB) and throws `code: 'frame-too-large'`.
`crew/headless-rpc.mjs:282-301` — the other consumer of the same `splitFrames` —
has no cap at all. Observed:
```
assign after an 8 MiB un-terminated frame threw: null
```
`splitFrames` itself returns the whole thing as `rest` (`E1.7 rest MiB 5` for a
5 MiB input), and `seat.rest` is then carried across polls with no ceiling.

**Expected:** either the cap is a property of `splitFrames`' consumers uniformly,
or the asymmetry is stated. Right now one consumer refuses at 1 MiB and the other
silently buffers.

**Missing guard:** `crew/headless-rpc.test.mjs:44-51` pins `splitFrames` framing
and rest-carry but never a size bound; the 1 MiB rule is only tested in
`crew/daemon.test.mjs`.

---

### B5 — `readEnvelopeFile` treats a return file containing `null` as an ABSENT file
**Severity: hangs (full budget burn)** · **Repro:** `e6-newline-caps-hangs.mjs`, `e2-readenvelopefile.mjs`

`crew/seat-io.mjs:1341` returns `JSON.parse(raw)` unguarded. Both sibling readers
guard the result (`crew/headless.mjs:158`, `crew/headless-rpc.mjs:170`:
`value && typeof value === 'object'`); this one does not. Observed:

```
readEnvelopeFile("null")                     null
return file contains `null`   {"returned":null,"polls":720,"virtualMs":3600000}   <- entire 3600s budget
return file contains `false`  {"returned":false,"polls":0}
return file contains `123`    {"returned":123,"polls":0}
```

A file containing the four bytes `null` is *parseable*, so `readEnvelopeFile`
never raises `pane-parse-error`; it returns `null`, which `waitForEnvelope`
(`crew/seat-io.mjs:1389-1390`) reads as "nothing on disk yet" and polls the full
budget — the exact condition B1's contract comment says must never happen again.
`false`/`123`/`"done"`/`[]` go the other way and are returned to the driver as
"the envelope" (`crew/drive.mjs:1803` then refuses them, so no state corruption,
but the diagnosis says *no valid envelope* rather than *your file is not an
object*).

**Expected:** `if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))`
→ the same `pane-parse-error`, since a scalar at the return path is exactly as
unusable as a syntax error.

**Missing guard:** `crew/seat-io-runclean.test.mjs:816-851` covers a good object,
an `EACCES` read, and a control-character defect. No case where the JSON parses
to a non-object.

---

### B6 — a half-written envelope is indistinguishable from a permanently broken one
**Severity: refuses-wrongly (spurious cell failure + spurious re-ask)** · **Repro:** `e9-writer-race.mjs`

`crew/seat-io.mjs:1327-1349` has no settle window and no re-read: the first read
that lands mid-write is terminal. Observed, with a seat writing via plain
`open/write/write/close` (the shape any `Write` tool or `> file` produces):

```
read #1 (mid-write) : {"stage":"pane-parse-error","kind":"unusable-envelope","terminal":true,...}
read #2 (complete)  : {"parsed":{"assignment_id":"d1","role":"builder","status":"done",...}}
reask offered?      : {"ask":true,"why":"a live pane seat can re-emit its own envelope"}
```

The turn's one bounded re-ask is spent, a brief is written telling a blameless
seat *"your ReturnEnvelope could not be parsed"* (`reaskBrief`,
`crew/seat-io.mjs:1365-1383`), and one false `unusable-envelope` cell failure is
recorded. On headless-json / headless-rpc there is no re-ask at all, so the same
race is unrecoverable.

V8 *does* separate the two cases and the reader discards the distinction:
```
truncated mid-key   "Unterminated string in JSON at position 40"
truncated mid-value "Unterminated string in JSON at position 70"
zero bytes          "Unexpected end of JSON input"
raw newline (b52)   "Bad control character in string literal in JSON at position 13"
```

**Expected:** one immediate re-read (or a `mtime`-stable check) before declaring a
parse failure terminal — the cheapest possible fix, and the message already
carries the discriminator.

**Missing guard:** `crew/seat-io-runclean.test.mjs:833-851` asserts the message
carries `position \d+` but nothing asserts a writer race is survived.

---

### B7 — `nextAssignmentId` has no `Number.isSafeInteger` floor; ids collide and the collision DELETES the prior envelope
**Severity: corrupts-state (narrow reachability)** · **Repro:** `e8-ids-exit-fsshapes.mjs`

`crew/headless-rpc.mjs:268-281` derives the next id by `Number(...)` on filenames
and session records with no safe-integer guard — unlike every other numeric
guard in this file (`markerPgid:669-672`, `evidencePgid:673-680` both use
`Number.isSafeInteger`). Observed:

```
seed []                                        {"first":"d1","second":"d2","collide":false}
seed ["d9007199254740993.builder.json"]        {"first":"d9007199254740992","second":"d9007199254740992","collide":true}
seed ["d99999999999999999999.builder.json"]    {"first":"d100000000000000000000","second":"d100000000000000000000","collide":true}
```

Past 2^53, `max + 1 === max`, so every subsequent assignment resolves to the SAME
`returnPath` — and `assign` (`crew/headless-rpc.mjs:450`) does
`if (exists(returnPath)) unlink(returnPath)` as anti-replay, so each new turn
**deletes the previous turn's envelope**. The state is also self-perpetuating:
once one such id exists it reproduces itself forever.

**Expected:** `Number.isSafeInteger(n) && n >= 0` on every candidate, matching
`markerPgid`.

**Missing guard:** `crew/headless-rpc.test.mjs` pins id progression (`d1` → `d2`)
only over well-formed inputs.

---

### B8 — an empty or whitespace exit marker parses as exit code 0
**Severity: wrong-answer (low reachability)** · **Repro:** `e8-ids-exit-fsshapes.mjs`

`crew/headless.mjs:146-152` and `crew/headless-rpc.mjs:158-164`:
`Number(String(read(path,'utf8')).trim())` with only a `Number.isFinite` filter.

```
exit file ""       -> 0      exit file "0x1f"  -> 31
exit file "   "    -> 0      exit file "1e3"   -> 1000
exit file "\n"     -> 0      exit file " 137 " -> 137
```

`Number('') === 0`, so a zero-byte exit marker is read as a **clean exit**, which
`classifyRun` (`crew/headless.mjs:65`) turns into `'ok'`/`'no-envelope'` rather
than an unknown. The spawn shells write the marker atomically
(`printf '%s' $? >exit.tmp; mv`, `crew/headless.mjs:275`,
`crew/headless-rpc.mjs:377`), so this needs a 0-byte `exit.tmp` (a failed
`printf`, a full disk) or a foreign file — narrow, but the whole point of the
marker is that it is the death proof.

**Expected:** an empty/blank marker is `null` (unknown), not `0`; and
`Number.isInteger(n) && n >= 0 && n <= 255` rather than `isFinite`.

**Missing guard:** `crew/headless.test.mjs:111-125` writes only `'0'`, `'1'`,
`'137'`.

---

### B9 — the parse-error message reports JS chars but says "bytes"
**Severity: cosmetic** · **Repro:** `e6-newline-caps-hangs.mjs`

`crew/seat-io.mjs:1337`: `` the file EXISTED (${raw.length} bytes) ``. `raw` is a
JS string, so `.length` counts UTF-16 code units:

```
ascii: message claims  "101 bytes; real UTF-8 bytes = 101; JS .length = 101"
emoji: message claims  "201 bytes; real UTF-8 bytes = 401; JS .length = 201"
cjk:   message claims  "101 bytes; real UTF-8 bytes = 301; JS .length = 101"
```

This number is quoted verbatim into the re-ask brief a seat is asked to act on,
and into the ledger `detail`. Fix: `Buffer.byteLength(raw, 'utf8')`, or say
"characters".

---

### B10 — the three envelope readers verify neither `role` nor `assignment_id`
**Severity: refuses-wrongly / trust-boundary note** · **Repro:** `e8-ids-exit-fsshapes.mjs`

`readEnvelopeFile`, `headless.mjs:envelopeAt` and `headless-rpc.mjs:envelopeAt`
all return whatever parsed, including through a symlink pointing anywhere on
disk. Observed (headless-json, symlink at the return path):
```
headless-json accepted a symlink target  {"assignment_id":"SOMEONE-ELSE","role":"lead","status":"done","summary":"not this seats work",...}
  role in file vs role assigned          "lead vs builder"
  assignment_id in file vs assigned      "SOMEONE-ELSE vs d1"
```
The only verification anywhere is `validEnvelope` (`crew/drive.mjs:623-628`),
which does catch this **mismatch** — but tolerates **omission**
(`env.role === undefined || env.role === role`), so an envelope carrying neither
field is accepted for any assignment. Not exploitable beyond what the seat can
already do by writing the file directly; recorded because the readers' comments
imply a check that lives two modules away, and because B1a's fabricated envelope
is the one thing that always satisfies it.

---

## SUSPICIONS (not reproduced as defects)

1. **`isBusyRefusal` needs a string-ish `error`.** `crew/headless-rpc.mjs:195-198`
   does `String(frame.error ?? '')`. `{success:false, error:{message:'already
   processing'}}` → `'[object Object]'` → `false` → no prompt retry, and the turn
   dies as `rpc-command-error`. I could not establish pi's actual error shape, so
   this is a shape assumption, not a demonstrated bug. (`e5`)
2. **Usage overflow to `Infinity`.** `usageInt` (`crew/headless.mjs:77-79`,
   `crew/headless-rpc.mjs:92-94`) has no ceiling: two `1e308` frames sum to
   `Infinity` and `measured` stays true, so an `Infinity` billed-token count
   reaches the ledger's cost math. Also `usageInt('500') === 0` — a provider that
   emits token counts as strings silently bills zero. Needs a hostile/odd
   provider; I have no evidence either shape occurs. (`e5`)
3. **`slice(0, 500)` on the ledger detail can split an astral pair.** Verified as
   a primitive (`e6`: `last code unit "d83d"`, `isWellFormed() false`), but I
   could not build a reachable path where a lens-owned detail string exceeds 500
   chars with an emoji straddling index 500.
4. **`waitForEnvelope` with `timeoutS: Infinity` never terminates** (`e6`: aborted
   at 2e6 iterations). Every caller I traced validates the budget
   (`crew/drive.mjs:60-83`), so I could not reach it from a real path.
5. **`envelopeDefect` never checks `env.status`** — `status: 1`, `status: {}`,
   `status: ["done"]` and a missing status all return `null` (`e5`), despite
   `crew/drive.mjs:630-633` claiming it is *"Deliberately stricter than
   validEnvelope"*. It is stricter on `summary`/`artifacts`/`details` and
   strictly weaker on `status`. On the paths I traced, `validEnvelope` runs first
   (`crew/drive.mjs:1803`) and catches it, so I have no reachable failure.
6. **`pending` (`crew/headless-rpc.mjs:243`) is supervisor-wide, write-only.**
   `pending.set` in `send`, `pending.delete` in `fold`; nothing ever reads it, so
   one seat's frame id can silently drop another seat's entry with no observable
   effect. Dead state, not a defect — flagged in case it was meant to be load-bearing.
7. **No size cap on the stderr read behind `capturedCondition`**
   (`crew/headless.mjs:50-54`) — the whole file is read and then `.replace()`d
   into a second copy. Bounded in practice by `readFileSync` throwing on
   >512 MiB strings (caught → `null`), so it degrades rather than crashes; I did
   not measure the memory spike.

---

## NEGATIVE RESULTS — attacks the code survived

**`splitFrames` (`crew/headless-rpc.mjs:55-68`) — `e1-splitframes.mjs`**
- 4-byte emoji straddling a chunk boundary, fed with the `rest` carry the real
  callers use: **no U+FFFD**, both frames intact. The `rest`-as-Buffer design is
  correct, and both consumers (`readFrames:293`, `daemon.mjs:144`) concat the
  Buffer before decoding.
- Chunk split WITHOUT the rest carry does corrupt (`"��\"}"`) — but no
  caller does that; only reachable by misuse.
- Frame with no terminator: returned as `rest`, zero lines, no loss.
- Empty frames, whitespace-only frames: emitted; every consumer drops them with
  `if (!line.trim()) continue`.
- `CRLF` stripped correctly; `\r\r\n` leaves one `\r`, which `JSON.parse` accepts
  as trailing whitespace; a lone `\r` is correctly NOT a frame boundary.
- U+2028 / U+2029 inside a frame: **1 record stays 1 record** and both parse —
  the readline trap the header comment at `:53-54` cites is genuinely avoided.
- Lone surrogate bytes `ED A0 80`: decoded to three U+FFFD, frame then fails
  `JSON.parse` and is dropped inertly. No throw.
- Non-Buffer inputs (`null`, `undefined`, number, object) do not throw.
- BOM-prefixed frame: `line.trim()` strips U+FEFF so the frame is not skipped as
  empty, `JSON.parse` then throws, and the frame is dropped silently
  (`readFrames:298` catch). NUL-prefixed frame: same, silently dropped. Inert in
  both cases — no crash, no mis-parse.

**Newline / delimiter injection into `journal.jsonl` (attack #9) — `e6`**
- A journal value containing `\n{"at":3,"event":"FORGED"}` produces **4 physical
  records for 4 logged objects**, all 4 parse, and `splitFrames` agrees on 4.
  `logLine` (`crew/driver.mjs:224-229`) is `JSON.stringify` + `\n`, which escapes
  `\n`, `\r` and NUL. `crew/headless.mjs:231` and `crew/headless-rpc.mjs:249` use
  the same shape. `crew/daemon.mjs:709-720` reads it back through the same
  `splitFrames`. **The ledger cannot be split by envelope content.**
- U+2028/U+2029 survive as intra-record characters and do not split the file.

**Prototype pollution (attack #7)**
- `JSON.parse('{"__proto__":{"polluted":"yes"}}')` yields an OWN `__proto__` data
  property (`e2`: `J-proto` returned it verbatim). Grepped every consumer:
  nothing does `Object.assign` on an envelope, and the only envelope spread
  (`crew/drive.mjs:2069` `[journal, ...env.artifacts]`) is an array spread. Object
  spread uses `CreateDataProperty`, not `Set`, so it cannot pollute either.
  `Object.prototype.polluted` is never set.
- `constructor` key: parsed as an own property, never invoked.
- `foldUsage` keys its dedupe Map by `message.id`; `id: "__proto__"` is a normal
  Map key (`e5`: folded to 7 tokens, no pollution).
- `crew/seat-io-runclean.test.mjs:662,768` already pins `'__proto__'` as a
  non-condition in the sampled-condition path.

**JSON edge values — `e2`**
- 200 000-deep nested array: parses without stack overflow (V8's parser is
  iterative), and no reader walks it recursively.
- `9007199254740993` → silently `9007199254740992`; `1e400` → `Infinity`; `-0` →
  `0`. No throw in any reader. (Consequences tracked in B7 / suspicion 2.)
- BOM-prefixed envelope file: correctly a `pane-parse-error`, not silently
  accepted.
- NUL inside a JSON string: correctly a `pane-parse-error`.

**Filesystem shapes (attack #8) — `e2`, `e8`**
- Missing file → `null` (absence), no throw.
- Zero-byte file → `pane-parse-error` on the pane path (correct: it EXISTS).
- **A directory at the envelope path** → `readFileSync` throws `EISDIR`, caught,
  → `null`. **No unhandled throw** on any of the three readers. (It then polls
  the whole budget, which is the documented "a denied read is an absence"
  policy — deliberate, so not filed as a finding.)
- Dangling symlink → `existsSync` false → `null`, no throw.
- File with mode `000` → `EACCES` caught → `null`, no throw. Pinned by
  `crew/seat-io-runclean.test.mjs:825-831`.
- 20 MiB single-line envelope: parsed fine, no cap tripped, no crash.

**Duplicate keys (attack #2) — `e2`**
- `{"status":"done","status":"blocked"}` → `JSON.parse` keeps the LAST
  (`"blocked"`). I grepped every reader and every validator for a raw-text scan
  or a first-match regex over envelope bytes and found **none** — `err.raw`
  (`crew/seat-io.mjs:1339`) is retained only for the byte-equality check in the
  re-ask loop (`crew/seat-io.mjs:1655`), never re-scanned. **No validator can
  disagree with the parsed object.** Clean.

**Wrong types that pass truthiness (attack #3) — `e2`, `e5`**
- `artifacts: "a.md"` → refused (`Array.isArray` guard, `crew/drive.mjs:638`).
- `artifacts: [null]` → refused with the offending item quoted (`:640`).
- `summary: 0` and `summary: "   "` → refused (`:637`).
- `details: null`, `details: []`, `details: "x"` → all refused
  (`!env.details || typeof !== 'object' || Array.isArray`, `:644`). The
  array-vs-object distinction is made everywhere it matters, including
  `usageObject` (`crew/headless.mjs:81-83`, `crew/headless-rpc.mjs:96-98`) and
  `hasField` (`crew/drive.mjs:675-677`, which uses `hasOwnProperty`, so an
  inherited or `undefined` field is correctly absent).
- `status` wrong-type is caught by `validEnvelope` (`crew/drive.mjs:625`) on the
  path that matters. (`envelopeDefect`'s silence on it is suspicion 5.)
- `usage: [1,2]` → `foldUsage` returns `null`, not a bogus total.
- Negative token counts clamp to 0 (`Math.max(0, …)`).
- `carriesOwnSpend` correctly refuses `role: 'toolResult'` and a role-less
  `message_end` — the double-count guard documented at
  `crew/headless-rpc.mjs:100-120` holds.

**`waitForEnvelope` bounds (attack #10) — `e6`**
- `timeoutS` = 60 → exactly 12 polls of `WAIT_POLL_MS`, then `null`. Terminates.
- `timeoutS` = 0, −1, `NaN`, `null`, `undefined` → 0 polls, immediate `null`. No
  hang, no throw.
- `timeoutS` = `"60"` (string) → coerced correctly, 12 polls.
- Two consecutive `alive: false` probes → `seat-died` thrown at the right poll,
  after one final `readEnvelope()` re-check (`crew/seat-io.mjs:1405-1406`) so a
  late envelope still wins.
- `alive: null` forever → misses never accumulate, polls to the deadline, returns
  `null`. An indeterminate probe correctly never kills a seat.
- `readEnvelope` throwing propagates immediately rather than being swallowed —
  that is what makes the pane fast-fail work.

**Anti-replay**
- `crew/headless.mjs:269` and `crew/headless-rpc.mjs:450` both unlink a stale
  return file before spawning. Verified in `e3`/`e4`: a pre-existing file at the
  path is removed by `assign`.

**No reader ever rewrites the seat's file** — asserted in `e3`, `e4`, `e10`:
`bytes still on disk: true` in every case, including the fabricated-envelope
path. "Reading is not authoring" holds.

---

## FILES READ IN FULL
- `crew/headless.mjs` (338 lines) — all
- `crew/headless-rpc.mjs` (755 lines) — all
- `crew/seat-io.mjs` — `phaseForStage`/`cellFailureKind`/`emitAdapter` head
  (:960-1010), `providerConditionDetail` → `paneProbe` (:1260-1440), and
  `seatIo` (:1467-1800). Not read: the descendant-capture / reclaim /
  runClean halves (:53-960, :1800-2156), which own no envelope or frame reading.
- `crew/drive.mjs` :600-680 (`validEnvelope`, `envelopeDefect`, `hasField`) and
  :1790-1830 (`assignAndWait`)
- `crew/daemon.mjs` :120-180 (`splitStream`, `MAX_FRAME_BYTES`), :590-620
  (`readFrom`), :700-740 (`pollJournal`)
- `crew/driver.mjs` :218-240 (`logLine`)
- Tripwires grepped/read: `crew/headless.test.mjs` :41-46, :102-141, :194;
  `crew/headless-rpc.test.mjs` :44-62, :305, :336, :406, :525-560;
  `crew/io-contract.test.mjs` :375-400;
  `crew/seat-io-runclean.test.mjs` :540-560, :655-670, :740-780, :816-1010

## SCRIPTS (all re-runnable: `cd <lensB>; ./to 60 node <script>`)
| script | attack |
|---|---|
| `to` | bounded-exec wrapper (no coreutils `timeout` on this mac) |
| `e1-splitframes.mjs` | frame splitting: multibyte straddle, CRLF, empty, BOM/NUL, giant, surrogates |
| `e2-readenvelopefile.mjs` | truncation, dup keys, wrong types, JSON edge values, fs shapes, 20 MiB |
| `e3-headless-json-malformed.mjs` | B1b: malformed envelope + clean exit on headless-json |
| `e3b-headless-json-budget-burn.mjs` | B1c: malformed envelope, worker still live → full budget |
| `e4-rpc-malformed.mjs` | B1a: headless-rpc fabricates `status:"insufficient"` |
| `e5-shape-and-usage.mjs` | `envelopeDefect`, `foldUsage`/`foldRpcUsage`, `recogniseProviderCondition`, `classifyRun`, `isBusyRefusal` |
| `e6-newline-caps-hangs.mjs` | JSONL injection, char-vs-byte, `waitForEnvelope` bounds, the `null` file |
| `e7-rpc-stream-reads.mjs` | B3/B4: read volume per poll, un-terminated tail |
| `e8-ids-exit-fsshapes.mjs` | B7/B8/B10: id overflow, exit marker, directory + symlink at return path |
| `e9-writer-race.mjs` | B6: half-written vs broken |
| `e10-side-by-side.mjs` | B1: the same bytes through all three transports via real `seatIo` |
