# Lens D — adversarial defect hunt: `scripts/factory/make-brief.mjs` + `crew/pi/extensions/lab.ts`

Date 2026-08-23. Node v26.5.1, darwin 25.5.0 (APFS, case-insensitive + normalisation-insensitive).
Real checkout `/Users/x/Development/dt-s2-factory` was READ-ONLY throughout; every experiment ran
against the scratch extraction at `…/scratchpad/h2/repo` (git-init'd inside the scratch copy) or
against fresh `mktemp -d` repos. No agent sessions, tmux panes, provider calls or fixed ports.

`./t <seconds> <cmd…>` in this directory is a `perl alarm` stand-in for GNU `timeout`
(not installed on this box). Every script below is re-runnable as `./t 60 node <script>`.

## Trust boundary that sets the severities

`scripts/factory/intake.mjs:967-1000` parses the `ask` / `where` / `done-means` / `out-of-scope`
block out of a **GitHub issue BODY** (`extractIntakeBlock(item.body)`), feeds it straight into
`validateRequest` → `verifyWhere` → `discoverTripwires` → `proposeTier`, and then
**auto-dispatches** a crew when the proposal is not judge-tier and shows no protected-path hit.
So `where` and `ask` are attacker-influenced strings on the intake path, not merely
lead-authored ones. `compileIntakeBrief` (intake.mjs:1179-1199) renders the brief with
`fences: null, lane: null`.

---

# FINDINGS

## F1 — `verifyWhere` follows a symlink out of the checkout (`make-brief.mjs:390-416`)
Severity: **corrupts-state** (reads and declares-writable a path outside the repository).
Repro: `a1-symlink-where.mjs`, `a1b-symlink-literal-leak.mjs`, `a8-cli-end-to-end.sh` §1.

`absoluteWhere` (`:386-388`) realpaths only the CHECKOUT and then lexically `resolve()`s the
entry; the containment test at `:398-401` is `relative(root, absolute)` on that lexical path.
`statSync` at `:404` FOLLOWS symlinks, and the entry itself is never realpathed. `crew/pi/
extensions/lab.ts:validateScratchPath` does exactly the missing check (`realpath` then
`containsScratch`), so the correct shape already exists in this codebase.

Observed (`a1-symlink-where.mjs`):

    refused   "../escape.txt" -> reason=missing-path
    refused   "/etc/passwd" -> reason=missing-path
    ACCEPTED  "lib/outside.mjs" -> [{"path":"lib/outside.mjs","kind":"file"}]
    ACCEPTED  "lib/passwd.mjs" -> [{"path":"lib/passwd.mjs","kind":"file"}]
    discovery keys from OUTSIDE file: ["apiToken","lib/outside.mjs","outside.mjs"]
    files_in_scope: ["lib/outside.mjs"]

`lib/outside.mjs` → `$TMPDIR/…/creds.mjs`; `lib/passwd.mjs` → `/etc/passwd`.
Content of the out-of-tree file reaches the rendered brief (`a1b`, and via the CLI in `a8` §1):

    declare every hit: grep -rn "ghp-9f2c1a-live-token\|lib/outside.mjs\|outside.mjs\|readToken" crew/ test/ scripts/ docs/
    files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): lib/outside.mjs

CLI exit code 0, brief written.

Expected: the same `missing-path` refusal `/etc/passwd` and `../escape.txt` get — a `where`
entry whose REALPATH leaves the checkout is outside the checkout.

Missing guard: `test/factory-make-brief.test.mjs` has no symlink case at all
(`grep -n symlink test/factory-make-brief.test.mjs` → nothing; the file's `verifyWhere` tests are
at :1190, :1192, :1211, :1220, :1228, :1259). `crew/pi/extensions/lab.test.mjs` DOES import
`symlinkSync` and pins `path-escapes-scratch`; the compiler has no equivalent.

## F2 — `verifyWhere` "verifies" a spelling the repo does not have (`make-brief.mjs:411-414`)
Severity: **wrong-answer** (a `files_in_scope` no scope gate can ever match — the #145 failure mode).
Repro: `a2-case-nfd.mjs`, `a10-negatives.mjs`, `a8-cli-end-to-end.sh` §2.

The comment at `:411-413` says "The return keeps the author's spelling for rendering", and `:414`
returns `{ path: entry }` verbatim. On APFS three different spellings all `stat()` successfully:
wrong case, NFD-for-NFC, and an un-normalised `..` segment. `crew/drive.mjs:1388 scopeMatcher`
compares byte-exact strings.

Observed (`a2-case-nfd.mjs`):

    git ls-files (ground truth): "lib/caf\303\251.mjs" | lib/widget.mjs
    wrong case : ACCEPTED "Lib/Widget.MJS"  files_in_scope=["Lib/Widget.MJS"]
                 scopeMatcher(files_in_scope)("lib/widget.mjs") = false  <- the path the lane actually changes
    NFD for NFC: ACCEPTED "lib/café.mjs"  files_in_scope=["lib/café.mjs"]
                 scopeMatcher(files_in_scope)("lib/café.mjs") = false  <- the path the lane actually changes

and (`a10-negatives.mjs`) the ASCII-only third way in, which needs no APFS at all:

    ACCEPTED dotdot inside        -> [{"path":"lib/../lib/widget.mjs","kind":"file"}]
    ACCEPTED dot (repo root)      -> [{"path":".","kind":"directory"}]

Expected: either refuse a spelling that is not the repo's own (`git ls-files` is already used by
`listDirectoryFiles`), or return the canonical repo-relative path. `expandFiles` already computes
`repoRelative(...)` for the discovery side — only the rendered/`files_in_scope` side keeps the raw
spelling, so the two halves of the same compile disagree.

Missing guard: nothing in `test/factory-make-brief.test.mjs` compares a verified `where` entry to
git's own spelling; every test feeds an already-canonical path.

## F3 — the protected-path floor is bypassed by re-spelling the path (`make-brief.mjs:1172-1176`)
Severity: **corrupts-state** (the ratified "protected floor ⇒ judge tier" rule silently does not fire,
and intake's `protected-path` auto-dispatch refusal at `intake.mjs:995` goes with it).
Repro: `a5-protected-bypass.mjs`, `a8-cli-end-to-end.sh` §2/§2b.

`signals.protectedHits` is a byte-exact `candidate === protectedPath` / `candidate.startsWith(dir)`
test against the author's spelling — the string F2 shows is unvalidated.

Observed (`a5-protected-bypass.mjs`):

    crew/drive.mjs             protectedHits=["crew/drive.mjs"]           tier=build       shape=build
    Crew/Drive.mjs             protectedHits=[]                           tier=mechanical  shape=mechanical
    CREW/DRIVE.MJS             protectedHits=[]                           tier=mechanical  shape=mechanical
    docs/adr/0001-shape.md     protectedHits=["docs/adr/0001-shape.md"]   tier=build       shape=build
    Docs/ADR/0001-shape.md     protectedHits=[]                           tier=mechanical  shape=mechanical
    crew/roster.json           protectedHits=["crew/roster.json"]         tier=build       shape=build
    Crew/Roster.JSON           protectedHits=[]                           tier=mechanical  shape=mechanical

End-to-end through the CLI (`a8` §2 vs §2b), same file, exit 0 both times:

    ### 2. where = a MIS-CASED protected path        ### 2b. control: the same file spelled correctly
    proposed tier: mechanical                        proposed tier: build
    - protected-path hits: none                      - protected path hit: crew/drive.mjs — raised mechanical → build
    proposed shape: mechanical                       proposed shape: build

Expected: `Crew/Drive.mjs` and `crew/drive.mjs` name the same protected file and must score the
same hit (or the spelling must be refused per F2).

Missing guard: `test/factory-make-brief.test.mjs` pins the protected-hit raise only for canonical
spellings. Nothing pins that a protected path cannot be re-spelled past the matcher. The runtime
gate in `crew/drive.mjs` compares git's own changed-file list and would still catch the write, but
the SHAPE decision (whether a judge seat is booted at all) is made here, before that.

## F4 — `lab.runSuite()` reports `suite-failed` for a green suite over ~3 test files (`lab.ts:619-626`, `:307-314`)
Severity: **wrong-answer** (the declared host-authority carve-out cannot report on this repo's own suite).
Repro: `b1-suite-output-cap.mjs`, `b1b-real-tap.mjs`, real TAP capture in `tap-one.txt`.

`appendSuite` (`:619-626`) re-bounds the WHOLE accumulator through `boundedTextInfo` (`:307-314`,
50 KiB / 2000 lines) on every line. A TAP run prints its `# pass` / `# fail` summary LAST, so once
the body exceeds the cap the summary is discarded, `parseTapSummary` returns nulls, and
`finishFromParent` refuses `suite-failed` — "the suite produced no parseable TAP summary".

Exact boundary, synthetic TAP (`b1-suite-output-cap.mjs`):

    tests=  968  tap=  51207B/  979L  runSuite frame -> {"paths":[],"pass":968,"fail":0,"exit_code":0,"host_authority":true,"truncated":true}
    tests=  970  tap=  51313B/  981L  runSuite frame -> {"id":2,"ok":false,"refused":"suite-failed","message":"suite-failed"}

Measured with REAL bytes from this checkout (`test/factory-make-brief.test.mjs` under
`node --test --test-reporter=tap` = 15 063 B / 438 lines / 71 tests, saved as `tap-one.txt`):

     1 test file(s) /   71 tests =   15017 B -> parseTapSummary = {"pass":71,"fail":0}
     3 test file(s) /  213 tests =   44898 B -> parseTapSummary = {"pass":213,"fail":0}
     4 test file(s) /  284 tests =   59837 B -> parseTapSummary = {"pass":null,"fail":null}  <== "suite-failed"
    40 test file(s) / 2840 tests =  597644 B -> parseTapSummary = {"pass":null,"fail":null}  <== "suite-failed"

This checkout ships 2162 tests across ~40 files, so a bare `lab.runSuite()` — the exact call a
scout makes to prove a mutation kills a check — can never succeed here.

Expected: parse the summary from the TAIL, or keep a summary window outside the display bound, or
at minimum refuse with `output-oversize` (a code that already exists) instead of `suite-failed`,
which reads as "your suite is broken".

Missing guard: `crew/pi/extensions/lab.test.mjs:745` ('a red suite is data while a suite without
TAP summary is suite-failed') pins the EMPTY-output case; no test drives a suite whose output
EXCEEDS `LAB_OUTPUT_CAP_BYTES`. `LAB_OUTPUT_CAP_BYTES` is pinned only as a constant (`:451`).

## F5 — 4 MiB of child stdout blocks the host event loop for ~67 s (`lab.ts:937-941`, `:619-626`)
Severity: **hangs-or-leaks**.
Repro: `b3-bytecap-and-burn.mjs` (B3b), `b2-collector-caps.mjs` (per-line cost).

`appendOutput` re-runs `boundedTextInfo` over the whole already-capped 50 KiB accumulator for EVERY
line (`Buffer.byteLength` + `Buffer.from` + `split('\n')`), and `LAB_FRAME_QUEUE_MAX` cannot bound
it because a non-JSON line calls `collector.served()` synchronously in `onLine` (`:1035`), so
`queued` never climbs. The only bound is `LAB_STREAM_CAP_BYTES` = 4 MiB = 2 097 152 two-byte lines.

Observed (`b2`, isolated cost; `b3` end-to-end):

      1000 lines (2000 B) ->    7 ms  (7 us/line)
     10000 lines (20000 B) ->  361 ms (36 us/line)
    100000 lines (200000 B) -> 3483 ms (35 us/line, accumulator pinned at the 51200 B cap)
    4 MiB of "x\n" from ONE lab child -> 66690 ms of blocking host CPU; outcome=refused refused=output-oversize

Expected: once `outputTruncated` is set, stop re-bounding — append is a no-op after the cap.
~67 s of synchronous CPU in the pi host process per lab run is a self-inflicted stall, and the
refusal only arrives after all of it is spent.

Missing guard: no test in `lab.test.mjs` measures the cost of the collector's consumers; the
collector's own caps are pinned (`:276`, `:288`, `:302`, `:311`) but the accumulators are not.

## F6 — the `scope-directory-unslashed` refusal is not applied on the `where` basis (`make-brief.mjs:1533`)
Severity: **wrong-answer** (the exact #145-attempt-3 failure it was written to prevent).
Repro: `a7-scope-directory-unslashed.mjs`, `a8-cli-end-to-end.sh` §3.

`validateScopeEntries` (`:865-880`, comment `:860-864`: "#145 attempt 3 died there with a gate-green
tree … this refuses at compile time") is invoked at `:1533` only when
`writeSurface.basis === 'fences'`. `compileIntakeBrief` (`intake.mjs:1179-1199`) passes
`fences: null, lane: null`, so the intake path — the auto-dispatching one — never calls it, and
neither does a hand `make-brief` run without `--fences`.

Observed (`a7`):

    verifyWhere        -> [{"path":"lib","kind":"directory"}]
    resolveWriteSurface -> ["lib"] basis = where
    scopeMatcher(files_in_scope)("lib/widget.mjs") = false   <- every file in the where is OUT of scope
    validateScopeEntries -> REFUSES: scope-directory-unslashed | brief: scope entry resolves to a directory and can only match with a trailing slash: lib (write "lib/")

CLI (`a8` §3), exit 0:

    files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): lib

Expected: `validateScopeEntries` runs on every write surface, whatever its basis.

Missing guard: `test/factory-make-brief.test.mjs:565-577` exercises `validateScopeEntries`
DIRECTLY only; no test asserts that `compile()`/`compileIntakeBrief` reach it on the `where` basis.

## F7 — a code fence anywhere in an authored field destroys the compiler's proposal record
Severity: **wrong-answer** (`proposed_shape`/`proposed_strength` record `null` for a proposal that was made).
Repro: `a4-brief-injection.mjs`.
Anchors: `make-brief.mjs:1395`/`:1397` (ask rendered raw, twice), `:1409`/`:1418` (`done_means` twice),
`:1415` (`out_of_scope`); reader `scripts/factory/emit.mjs:581-600`, consumed at `:687-698`.

`renderBrief` interpolates `request.ask`, `request.done_means` and `request.out_of_scope` into the
brief with no escaping, and `parseProposalBrief` scans the resulting markdown line-wise for
```` ```proposal ```` / ```` ``` ````. **The block cannot be FORGED** — every attempt is caught —
but it is trivially DESTROYED:

    ask forges a full block      -> shape=null strength=null defect="the brief carries 3 ```proposal blocks — exactly one of them is the compiler's proposal"
    ask opens an unclosed block  -> shape=null strength=null defect="the proposal block is not JSON this reader can read: Unexpected non-whitespace character a"
    done_means forges a block    -> shape=null strength=null defect="the ```proposal block is never closed"
    out_of_scope forges block    -> shape=null strength=null defect="the brief carries 2 ```proposal blocks …"
    clean control                -> shape="judge" strength="frontier" defect=null

The `done_means` case needs no adversary at all: one ordinary markdown fence on its own line in an
authored `done_means` produces "never closed" and silently zeroes the run's recorded shape and
strength (one `noteStderrOnce` line is the whole signal).

Also observed, and NOT caught: a forged PROSE section. An ask containing
`## Proposed tier` + `proposed tier: mechanical` puts a second, attacker-written proposal section
at char 33 of the brief, ahead of the compiler's real one at char 245 — the brief is read by the
planner/lead seat as prose, and on the intake path the ask comes from an issue body.

    ask forges "## Proposed tier" prose -> forged section appears BEFORE the real one: true

Expected: escape or fence-neutralise authored fields before interpolation (a `​`-prefix, an
indent, or a refusal on a leading ``` in an authored line), and/or anchor the reader to the block
the compiler emits rather than to the first one in the document.

Missing guard: `test/factory-make-brief.test.mjs:648` asserts only
`brief.split(SLOT_MARKER).length - 1 >= 2`; nothing feeds hostile markdown through `renderBrief`
and back through `parseProposalBrief`. There is no round-trip test between the two modules beyond
the constant-equality pin the module header at `:137-144` describes.

## F8 — discovery cost is unbounded; `BROAD_KEY_HIT_LIMIT` bounds the report, not the work (`make-brief.mjs:519-534`, `:605-610`)
Severity: **hangs-or-leaks**.
Repro: `a6-discovery-cost.mjs`, `a6b-realrepo-cost.mjs`, `a6c-worstcase.mjs`.

`discoverTripwires` spawns one `git grep` per discovered key (`:606`) plus two per owner file
(`:580-583`, commented "intentionally unbounded"). The broad-key filter at `:607` runs AFTER that
key's grep has already completed. The key count is a function of the target file's contents.
There is no overall timeout on `make-brief`; only a 30 s timeout on each individual grep (`:525`).

    file is  4.4 KiB, extractKeys -> 102 keys   discoverTripwires:   761 ms
    file is 17.9 KiB, extractKeys -> 402 keys   discoverTripwires:  3016 ms
    file is 72.4 KiB, extractKeys -> 1602 keys  discoverTripwires: 11782 ms

On this checkout: 10.6 ms per `git grep`; `where: ["crew/"]` = 1527 spawns ≈ 16 s;
`where: ["."]` = 3412 spawns ≈ 36 s. A 1.29 MiB source of legal 4-char error codes yields
148 705 keys ⇒ 26 minutes at the measured rate, 1239 hours at the per-grep timeout ceiling.
`where` is attacker-influenced on the intake path.

Expected: a bound on the number of keys (or on total discovery wall time), not only on the hits
reported per key.

Missing guard: nothing in `test/factory-make-brief.test.mjs` bounds discovery cost; the
`BROAD_KEY_HIT_LIMIT` export is pinned only as a value.

## F9 — the "declare every hit" command the brief hands the seat is shell/BRE-unsafe (`make-brief.mjs:1236-1239`)
Severity: **cosmetic** (a wrong instruction, not wrong state).
Repro: `a9-grep-line-metachars.mjs`.

`generatedGrep` concatenates keys into a double-quoted shell word joined with BRE `\|`. Exported
symbols legally contain `$` (`EXPORTED_DECLARATION` accepts `[A-Za-z_$][\w$]*`) and file keys
contain `.`:

    extractKeys: ["$HOME$secret","a.b.mjs","bad-input","lib/a.b.mjs","lib/x.mjs","widgetHelper"]
    declare every hit: grep -rn "$HOME$secret\|a.b.mjs\|bad-input\|lib/a.b.mjs\|lib/x.mjs\|widgetHelper" crew/ test/ scripts/ docs/

`$HOME` expands in the seat's shell; `.` is a BRE wildcard. Expected: single-quote the word and
escape BRE metacharacters (or emit `grep -F -e … -e …`).
Missing guard: no test asserts the generated command is runnable or correct.

## F10 — `askTokens` is ASCII-only, so a non-Latin ask is refused as contentless (`make-brief.mjs:334-336`)
Severity: **refuses-wrongly** (low: this repo is English-only today).
Repro: `a3-validate-ask.mjs`.

    refused   emoji only                   -> missing-line
    refused   CJK only                     -> missing-line
    ACCEPTED  a.b.c (3 one-char tokens)    len=11
    ACCEPTED  one word repeated 3x         len=11
    ACCEPTED  zero-width joined 3 letters  len=5
    ACCEPTED  10000 words                  len=58889

`/[a-z0-9]+/g` counts no CJK/Cyrillic/accented token, so a genuine ask is refused with
"ask must contain at least three alphanumeric tokens". The converse — `...a.b.c...` and
`the the the` passing — is documented behaviour (`:338-340`) and is NOT counted as a defect.
There is also no upper bound on ask length: a 58 KB ask is accepted and rendered into a markdown
`# Task:` heading.

## F11 (observation) — a frame-queue overflow is reported as `output-oversize` (`lab.ts:1054-1058`)
Severity: **cosmetic**. Repro: `b5-frames-timeouts.mjs` (b).
`LAB_REFUSALS` has no frame-queue code, so a seat that floods the RPC queue is told its OUTPUT was
oversize. Also, because the terminal `{done:true}` frame occupies a queue slot, the effective
admission is `LAB_FRAME_QUEUE_MAX − 1` operation frames:

      1023 unserved frames -> outcome=ok       refused=undefined       ops served=1 kills=[]
      1024 unserved frames -> outcome=refused  refused=output-oversize ops served=1 kills=["SIGTERM"]
      1025 unserved frames -> outcome=refused  refused=output-oversize ops served=0 kills=["SIGTERM"]
     20480 unserved frames -> outcome=refused  refused=output-oversize ops served=0 kills=["SIGTERM"]

The collector in isolation is exactly right (1024 queued OK, 1025 blows) — see NEGATIVE RESULTS.

---

# SUSPICIONS (not reproduced — do not treat as findings)

- **Hard link inside the lab scratch to a file outside it.** `validateScratchPath` realpaths, which
  cannot see through a hard link. Not reproduced: `git clone --local` produces hardlinks only under
  `.git/objects`, and I found no path by which a seat creates one in the worktree.
- **`suiteControl` being overwritten by a second concurrent `runSuite`.** `opChain` serialises ops
  and the tool declares `executionMode: 'sequential'`; I could not construct a concurrent pair.
- **A retained scratch (`answer.retained === true`, `lab.ts:717`) leaking across `execute` calls.**
  `execute` resets `scratchRetained = null` at `:773`, so a directory retained by run N is never
  removed by run N+1. It is journalled as `scratch_retained`, which reads as deliberate; I did not
  find a cleanup owner but also did not prove one is absent.
- **`grep`'s `truncated` flag counting non-hit lines.** `lab.ts:875` computes
  `lines.length > maxHits` over ALL git-grep output lines, including any that fail the
  `^(.*?):(\d+):(.*)$` parse (e.g. `Binary file X matches`). I could not get git to emit such a
  line for a text-only scratch clone.
- **`gatherBaseline` runs `/bin/sh -c <profile.test_command>` (`make-brief.mjs:779`).** Arbitrary
  command execution from a profile file, but profiles are ratified local config — I found no path
  by which an issue body reaches `test_command`, so this is noted, not claimed.

---

# NEGATIVE RESULTS — attacks the code survived

### make-brief.mjs
- `where: "../escape.txt"` → `missing-path`. (a1)
- `where: "../../../etc/passwd"` → `missing-path`. (a10)
- `where: "/etc/passwd"` (absolute) → `missing-path`. (a1, a10)
- `where: "/dev/zero"` (device file) → `missing-path`. (a10)
- `where:` dangling symlink → `missing-path` (statSync throws). (a10)
- `where:` FIFO → `missing-path` (neither file nor directory). (a10)
- `where: "lib/widget.mjs "` (trailing space) → `missing-path`. (a10)
- `where: " lib/widget.mjs"` (leading space) → `missing-path`. (a10)
- `where: "lib/*.mjs"` (glob, unexpanded) → `missing-path`. (a10)
- `where:` string containing a NUL byte → `missing-path`, no throw. (a10)
- `where: ""` → `missing-line`. (a10)
- `where:` nonexistent path → `missing-path`. (a10)
- `verifyWhere` against a non-repo → `not-a-git-repo` (already pinned at test:1190).
- `validateRequest`: missing field → `missing-line`; wrong type → `wrong-type`; unknown extra key
  (`issue: 42`) → `unknown-key`; empty `where` → `missing-line`; `ask` as a `String` object →
  `wrong-type`. (a3)
- JSON `__proto__` key in the request → `unknown-key`; `({}).polluted` stays `undefined`
  (JSON.parse does not set the prototype). (a3)
- `validateAsk`: blank → `blank-ask`; whitespace-only → `blank-ask`; newlines-only → `blank-ask`;
  punctuation-only → `missing-line`; 50 zero-width chars → `missing-line`; 50 combining marks →
  `missing-line`; one 100 000-char token → `missing-line`; exact heading restatement →
  `restating-ask`. (a3)
- Regex/shell metacharacters as discovered KEYS (`-e.js`, `--.js`, `$alias$`, `metaChar$Symbol`)
  survive `git grep -l -F -e <key>` — `-F` plus `-e` means no pattern injection and no
  option injection. (a10)
- `gatherFences`: unparseable JSON / extra top-level key / non-object lane / duplicate `reads.file`
  / a JSON `__proto__` key all → `bad-fences`. (a10)
- `gatherProtectedPaths`: unparseable JSON / extra top-level key / non-string entry → `bad-protected`. (a10)
- `renderProposalBlock` / `parseProposalBrief`: the machine-readable proposal block cannot be
  FORGED from any authored field — every injection attempt yields a named defect and
  `shape=null strength=null`, never an attacker's value. (a4; the DESTRUCTION half is F7.)
- `SLOT_MARKER` count stays 2 across every injection attempt tried. (a4)
- `discoverTripwires` cost is LINEAR in key count, not quadratic — no hang from a pathological
  file's SHAPE, only from its SIZE. (a6)

### lab.ts
- `LAB_PROGRAM_CAP_BYTES` = 65536: 65535 ok, 65536 ok, 65537 → `program-oversize`. Measured in
  BYTES not chars — a 21 846-char multibyte program (65 538 B) is correctly refused. (b4)
- `LAB_SUITE_PATHS_MAX` = 64: 63 ok, 64 ok, 65 → `op-args-invalid`. (b4)
- `LAB_GREP_HITS_MAX` = 500: 499→499 `truncated:false`, 500→500 `truncated:false`,
  501→500 `truncated:true`. (b4)
- `opts.maxHits`: 0, −1 and 1.5 → `op-args-invalid`; 1e9 correctly clamps to `LAB_GREP_HITS_MAX`;
  `maxHits = hits` gives `truncated:false`, `maxHits = hits−1` gives `truncated:true`. (b4)
- `LAB_STREAM_CAP_BYTES` = 4 MiB with newline-terminated data: cap−1 ok, cap ok, cap+1 overflows.
  (b3a — B2's first attempt was CONFOUNDED: a newline-free buffer trips the residual cap first,
  which is why B2 appeared to show an off-by-one. Re-derived.)
- `LAB_RESIDUAL_CAP_BYTES` = 1 MiB: a frame with NO terminator at exactly the cap is fine, cap+1
  overflows. Unterminated stdout is bounded at ~1.06 MiB held, never unbounded. (b2)
- `LAB_FRAME_QUEUE_MAX` = 1024 in the collector in isolation: 1023 queued ok, 1024 queued ok,
  1025 blows, `queuedFrames()` resets to 0, later pushes are dropped. (b2)
- Frame flood far past the max (20 480 frames): refuses cleanly with a SIGTERM in ~12 ms — no
  unbounded growth, no hang. (b5)
- A terminal RPC frame split mid-4-byte-emoji across two `stdout.emit('data')` writes decodes
  correctly: `result="💥ok"`, no U+FFFD. (b5; already pinned at `lab.test.mjs:288`.) The
  host→child direction uses the same `StringDecoder` construct in `runnerSource`.
- `boundLabText` truncating mid-multibyte drops the partial sequence rather than emitting U+FFFD
  (`StringDecoder.write` buffers it and `.end()` is never called). (b5, b1b)
- `childTimeoutMs` deadline fires: timer armed at the configured value, `SIGTERM` sent, settles
  `child-timeout`. (b5c)
- `opTimeoutMs` fires for real: a `spawnSync` that exceeds it returns `ETIMEDOUT` and the seat gets
  `{"ok":false,"refused":"op-timeout"}` after 203 ms. (b6a)
- `suiteTimeoutMs` fires: timer armed, `kill(-pid, 'SIGTERM')` sent to the process GROUP. (b6b)
- `child-unreaped` at `reapPollsMax` is already pinned (`lab.test.mjs:616-635`, `:891-899`).
- `validateScratchPath` correctly refuses option-shaped (`-x`), traversal (`..`, `.`),
  backslash/NUL/glob characters, and realpath escapes — it does the containment check
  `verifyWhere` is missing (F1).

---

# FILES READ IN FULL
- `/Users/x/Development/dt-s2-factory/scripts/factory/make-brief.mjs` (1583 lines)
- `/Users/x/Development/dt-s2-factory/crew/pi/extensions/lab.ts` (1147 lines)

# FILES READ IN PART (for guards / consumers / anchors)
- `scripts/factory/emit.mjs` — `parseProposalBrief` :560-612, `bootProposal` :676-698, :1038-1044
- `scripts/factory/intake.mjs` — sweep/dispatch :930-1000, `compileIntakeBrief` :1179-1206
- `crew/drive.mjs` — `scopeMatcher` :1388-1392, `parseDirectedBrief` :1276-1300, :1302-1321
- `crew/protected-paths.mjs` — via `resolveProtectedPaths()` output
- `test/factory-make-brief.test.mjs` — imports, :209-215, :560-580, :640-655, :1180-1370
- `crew/pi/extensions/lab.test.mjs` — helpers :1-120, :255-320, :380-460, :530-545, :610-700, :740-770, :860-900

# SCRIPT INDEX (all under this directory; run as `./t <secs> node <script>`)
    t                            bounded runner (perl alarm; no GNU timeout on this box)
    a1-symlink-where.mjs         F1  symlink escapes verifyWhere
    a1b-symlink-literal-leak.mjs F1  out-of-tree literal reaches the rendered brief
    a2-case-nfd.mjs              F2  wrong case / NFD verified, scopeMatcher cannot match
    a3-validate-ask.mjs          F10 + validateAsk/validateRequest negative sweep
    a4-brief-injection.mjs       F7  proposal block forging (fails) and destruction (works)
    a5-protected-bypass.mjs      F3  protected floor bypassed by re-spelling
    a6-discovery-cost.mjs        F8  discovery cost vs key count
    a6b-realrepo-cost.mjs        F8  per-grep cost + `where: ["crew/"]` projection on this checkout
    a6c-worstcase.mjs            F8  worst-case key density and `where: ["."]`
    a7-scope-directory-unslashed.mjs F6 the unapplied #145 refusal
    a8-cli-end-to-end.sh         F1/F3/F6 through the real make-brief CLI
    a9-grep-line-metachars.mjs   F9  generated grep line
    a10-negatives.mjs            negative sweep (paths, metachar keys, fences, protected)
    b1-suite-output-cap.mjs      F4  synthetic TAP, exact boundary
    b1b-real-tap.mjs             F4  real TAP bytes from this checkout
    tap-one.txt                  captured `node --test --test-reporter=tap` for one test file
    b2-collector-caps.mjs        collector caps + accumulator per-line cost
    b3-bytecap-and-burn.mjs      F5  end-to-end 67 s host CPU burn
    b3a-bytecap.mjs              corrected byte-cap boundary (B2 was confounded)
    b4-cap-boundaries.mjs        every LAB_* cap at cap-1 / cap / cap+1
    b5-frames-timeouts.mjs       F11 + split-emoji frame + child deadline
    b6-lab-timeouts.mjs          op timeout and suite timeout actually firing
    dbg.mjs                      scopeMatcher NFC/NFD sanity check
