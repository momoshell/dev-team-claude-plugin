# Lens C — the scope gate and the fence register

Scratch repo: `.../h2/repo` (md5-identical `crew/drive.mjs`). Scripts: `a1`..`a8` in this dir.
`timeout` is not on PATH on this box (`gtimeout` neither); every script is a pure-function
battery or a throwaway-git experiment and terminates in <2s. No agent sessions, no tmux.

## The rules, as read

`crew/drive.mjs:1246-1268` — an entry ending `/` is a DIRECTORY PREFIX; anything else is a
literal path matched exactly. Rejections: non-string/empty; `[*?[]{}]`; leading `/`; any
segment exactly `.` or `..`; a trailing-slash entry with `< SCOPE_DIR_MIN_SEGMENTS (2)`
non-empty segments.

`crew/drive.mjs:1388-1392 scopeMatcher` — `entry.endsWith('/') ? path.startsWith(entry) : path === entry`.
`crew/protected-paths.mjs:38-53 protectedHitsIn` — `entry===path || (path ends '/' && entry.startsWith(path)) || (entry ends '/' && path.startsWith(entry))`.
`crew/drive.mjs:1409-1420 laneFenceHits` — protectedHitsIn per lane record, deny-list.

Enforcement points: plan-time `validateScopeEntries` (:2352), `laneFenceHits(scopeFiles)` (:2358),
`protectedHits(scopeFiles)` → sensitivity floor (:2371); gate-time `laneFenceHits(changed)` (:2986)
and `outOfScopeFiles(changed, inScope)` (:2991); commit filter (:1735, :3234) and
`seat-io.mjs:2113-2115`.

## FINDINGS

### F1 — the lane fence register is never validated; one missing `/` turns the whole cross-lane fence into a no-op  [corrupts-state]
`crew/crew.mjs:391-405` (`resolveLaneFence`) → `scripts/factory/make-brief.mjs:805-858` (`gatherFences`)
→ `:902-913` (`laneFenceFor`). Consumed at `crew/drive.mjs:2358` and `:2986`.

`gatherFences` validates only that `files` entries are non-blank strings. `laneFenceFor` only
`normaliseRepoPath`s them (`\`→`/`, strips a leading `./`). Nothing ever runs the entries through
drive's `validateScopeEntries` or through make-brief's OWN `validateScopeEntries({checkout, files})`
(`make-brief.mjs:865-880`, reason `scope-directory-unslashed`) — that check is applied ONLY to the
booting lane's own surface at brief-compile time (`make-brief.mjs:1533`), never to the sibling
surfaces that become the runtime deny-list, and never at `crew.mjs boot` at all.

Repro: `node a3-fence-register.mjs`, `node a4-fence-e2e.mjs`.

a3 observed (every one is `boot=ACCEPT`, `denies=[]`):

```
CORRECT (trailing slash)   stored=["crew/drive.mjs","scripts/factory/"]  denies=["crew/drive.mjs","scripts/factory/intake.mjs"]
UNSLASHED DIR              stored=["crew","scripts/factory"]             denies=[]
DOT-SLASH whole repo       stored=["."]                                  denies=[]
ABSOLUTE path              stored=["/Users/.../crew/drive.mjs"]          denies=[]
GLOB                       stored=["scripts/factory/*.mjs"]              denies=[]
TRAVERSAL                  stored=["scripts/../crew/drive.mjs"]          denies=[]
TRAILING SPACE             stored=["crew/drive.mjs "]                    denies=[]
CASE VARIANT               stored=["Crew/Drive.mjs"]                     denies=[]
--- make-brief's OWN check, which is never applied here ---
["scripts/factory"]  REFUSED by make-brief: scope entry resolves to a directory and can only match
                     with a trailing slash: scripts/factory (write "scripts/factory/") [scope-directory-unslashed]
```

a4 observed (a full `driveTask`, mirroring `crew/drive.test.mjs:854`, changing ONLY the spelling):

```
### CONTROL  "scripts/factory/"
  driveTask status    : escalation
  escalation.where    : scope
  COMMITTED FILES     : []
### ATTACK   "scripts/factory"
  driveTask status    : done
  escalation.where    : null
  COMMITTED FILES     : [["scripts/factory/intake.mjs"]]
  lane/suite ran      : ["lane-cmd","suite-cmd"]
```

Expected: `crew.mjs boot --fences ... --lane ...` refuses the register (`scope-directory-unslashed`,
or drive's own defect list), OR `laneFenceHits` denies `scripts/factory/intake.mjs`. Fences are a
deny-list, so an unreadable entry must be a boot refusal, never silently empty.

Missing guard: `test/factory-make-brief.test.mjs:563` and `:594` pin the unslashed refusal only for
`lane: 'own'` — the sibling lane in the very same fixture (`lane: 'control'`) is unchecked.
`crew/crew.test.mjs:998` (`resolveLaneFence takes both flags or neither`) uses only plain file
entries (`x.mjs`, `y.mjs`, `z.mjs`). `crew/drive.test.mjs:825` (`laneFenceHits ...`) uses only the
correctly-slashed `'scripts/factory/'`. Nothing anywhere pins an unslashed/`.`/absolute/glob
register entry.

### F2 — an NFD-normalised path in files_in_scope passes the gate and can never satisfy it  [refuses-wrongly]
`crew/drive.mjs:1388-1392` (`scopeMatcher` compares raw strings, no `.normalize()`), consumed at `:2991`.

Repro: `node a6-fs-aliasing.mjs`. Observed (macOS, `core.precomposeunicode = true`):

```
=== UNICODE 2: the file is CREATED with an NFD name (what a builder does with the declared string) ===
  git prints                : ["docs/café.md"]
    bytes                   : 646f63732f636166c3a92e6d64 NFC? true NFD? false
  declared NFC             outOfScope=[]
  declared NFD             outOfScope=["docs/café.md"]
```

git always re-precomposes to NFC; the plan's NFD spelling passes `validateScopeEntries` (a1 row
`NFD-e-acute ... ACCEPT`) and then EVERY round reads the edit as out of scope — including a file the
builder created from the declared string itself. `crew/drive.mjs:2992-2998` bounces `scope-fix` each
round and finally escalates `out-of-scope edits persisted: docs/café.md` naming a path that is
byte-different but visually identical to the declared one. The same mismatch makes
`seat-io.mjs:2114-2115` drop the file from `present` and throw
`commit: nothing in scope actually changed` if it is the only one.

Expected: either normalise both sides (`String.prototype.normalize('NFC')`) before comparing, or
refuse a non-NFC scope entry at `validateScopeEntries` with a message that says so.

Missing guard: no test in `crew/drive.test.mjs`, `crew/crew.test.mjs`, `test/factory-make-brief.test.mjs`
or `test/factory-probe-repo.test.mjs` uses a non-ASCII FILENAME anywhere. Measured with
`LC_ALL=C grep -oE "'[^']*\.(mjs|md|json|yml)'" $f | LC_ALL=C grep -c '[^ -~]'` over the four files
-> 0, 0, 0, 1; the single hit (`test/factory-probe-repo.test.mjs:492`) is a `·` inside a message
string, not a path.

### F3 — the protected floor is case-sensitive on a case-insensitive filesystem  [wrong-answer]
`crew/protected-paths.mjs:38-53` / `crew/drive.mjs:1402-1404`, consumed at `crew/drive.mjs:2371-2379`.

Repro: `node a6-fs-aliasing.mjs`. Observed:

```
=== CASE: plan declares "crew/Drive.mjs"; builder writes via that exact path ===
  validateScopeEntries      : ACCEPT
  protectedHits([declared]) : []   <- crew/drive.mjs IS on the floor
  git changedFiles()        : ["crew/drive.mjs"]
  outOfScopeFiles           : ["crew/drive.mjs"]
  content of crew/drive.mjs : "builder edit\n"
```

The floor check at `:2371` runs BEFORE the builder is seated. With `protectedHits` empty, the
sensitivity-floor reseat never fires, the builder is seated under an ordinary reviewer with a write
surface that on APFS IS `crew/drive.mjs`, and it modifies the real protected file. Only the *scope*
gate at `:2991` catches it, and it escalates as `where: 'scope'` — so the durable record never says
"a protected path was touched under an under-graded reviewer", which is precisely the claim `#250`
put that check there to make. Fails closed for the write, fails open for the tier.

Expected: `protectedHitsIn` should compare case-insensitively (or `validateScopeEntries` should
refuse an entry whose on-disk resolution differs from its spelling) on a case-insensitive checkout.

Missing guard: `crew/drive.test.mjs:808` (`protectedHits matches the ratified protected paths in
both directions`) tests `crew/drive.mjs.bak` and `crew/roster.json.tmp` near-misses but no case
variant. Same for `crew/crew.test.mjs`.

### F4 — `parseDirectedBrief` silently takes the LAST of duplicate JSON keys  [wrong-answer]
`crew/drive.mjs:1290-1299`.

Repro: `node a5-directed-mutations.mjs`. Observed:

```
DUPLICATE gate_cmd key      ACCEPT {"gate_cmd":"rm -rf /","files_in_scope":["a/b.mjs"]}
DUPLICATE files_in_scope    ACCEPT {"gate_cmd":"g","files_in_scope":["crew/drive.mjs"]}
```

`JSON.parse` keeps the last occurrence; `Object.keys` then shows no extra key, so the closed-key-set
check at `:1293` passes. A human reading the brief top-down sees `files_in_scope: ["a/b.mjs"]`; the
driver builds against `["crew/drive.mjs"]`. This is exactly the ambiguity the module already refuses
one level up — `:1289` "the brief carries 2 ```directed blocks — exactly one of them is the plan".

Expected: refuse a block whose raw text declares a key twice (the same posture as the two-block
refusal), naming the duplicated key.

Missing guard: `crew/drive.test.mjs:32` imports `parseDirectedBrief`; its cases cover missing/extra
keys, two blocks and unclosed blocks — none covers a repeated key.

### F5 — whitespace-padded and whitespace-only scope entries validate, and the two entry points disagree  [refuses-wrongly]
`crew/drive.mjs:1250-1268` accepts them; `crew/crew.mjs:357` trims the CLI form and nothing else does.

Repro: `node a1-validate.mjs`, `node a7-residual.mjs`. Observed:

```
lead-space          " crew/drive.mjs"   ACCEPT
trail-space         "crew/drive.mjs "   ACCEPT
lead-tab            "\tcrew/drive.mjs"  ACCEPT
trailing-CR         "crew/drive.mjs\r"  ACCEPT      <- CRLF-authored JSON
trailing-NBSP       "crew/drive.mjs " ACCEPT
whitespace-only     "   "               ACCEPT
newline-only        "\n"                ACCEPT
double-slash        "a//b"              ACCEPT
backslash           "crew\\drive.mjs"   ACCEPT
protected-file-with-slash "crew/drive.mjs/" ACCEPT

  CLI  " a.mjs , b.mjs " -> ["a.mjs","b.mjs"]                       (trimmed)
  plan envelope [" a.mjs "] validateScopeEntries -> []              (ACCEPTED, untrimmed)
  scopeMatcher([" a.mjs "])("a.mjs") = false
```

Every one of these authorizes nothing — the run burns all its build rounds bouncing `scope-fix` and
escalates. `" crew/drive.mjs"` additionally slips the protected floor (a2 §1: `prot=---`). The
directed shape (`:1297`) and `validateCarve` (`:738`) inherit the same acceptance:
`scope whitespace-only  ACCEPT {"gate_cmd":"g","files_in_scope":["   "]}`.

Expected: reject an entry that is not equal to its own `.trim()`, and reject a whitespace-only entry
(as `resolveProtectedPaths` already does at `protected-paths.mjs:30` and make-brief does at `:869`).

Missing guard: `crew/drive.test.mjs:793` (`scope helpers match directory prefixes and validate only
supported entries`) enumerates `['crew/','tasks/','.','./','/','','crew/*.mjs','*','../x.mjs','/abs/x.mjs']`
— no whitespace case, no `//`, no `\`. `crew/crew.test.mjs:989` reuses `validateScopeEntries` as its
own oracle, so it can never notice.

### F6 — `SCOPE_DIR_MIN_SEGMENTS` is duplicated as a literal `2` and the agreement tripwire cannot see it move  [cosmetic / missing tripwire]
`crew/drive.mjs:1249` vs `crew/daemon.mjs:65` (`entry.split('/').filter(Boolean).length < 2`).
Pin: `crew/daemon.test.mjs:298-301`.

Repro: `node a8-constant-drift.mjs` (mutates a scratch COPY of drive.mjs, 2→3). Observed:

```
mutated drive SCOPE_DIR_MIN_SEGMENTS = 3
daemon.test.mjs:298 pin table detects the drift? NO  <<< silent divergence
  "a/b/"           drive=REJECT daemon=ACCEPT   <<< DIVERGED
  "crew/roles/"    drive=REJECT daemon=ACCEPT   <<< DIVERGED
  "docs/adr/"      drive=REJECT daemon=ACCEPT   <<< DIVERGED
```

The pin table `['crew/crew.mjs','tasks/x/captures/','lib/*.mjs','/abs/path.mjs','../up.mjs','crew/','',42,'a{b}.mjs']`
holds a 1-segment dir and a 3-segment dir but no 2-segment dir, so the boundary the constant names
is never exercised. Fix is either importing the constant into daemon.mjs or adding `'a/b/'` to the table.

### F7 — `outOfScopeFiles` fails OPEN on a non-array `changed`  [cosmetic / hardening]
`crew/drive.mjs:1397-1399`: `(Array.isArray(changed) ? changed : []).filter(...)`.

Repro: `node a7-residual.mjs`. Observed, with the EMPTY in-scope set (the `writes:'none'` shape at `:2040`):

```
  changed=null      -> []
  changed="a.mjs"   -> []
  changed=42        -> []
```

An `io.changedFiles()` that returns anything but an array reports zero out-of-scope files and the
gate passes vacuously. `laneFenceHits`'s identical coercion is correct (an absent deny-list means no
fence); this one inverts a security check's default. `crew/io-contract.test.mjs:15` pins that the
method exists, not what it returns. Suggest throwing instead.

### F8 — `--files-in-scope` splits on `,` and mangles a path containing a comma  [refuses-wrongly, minor]
`crew/crew.mjs:357`. Repro: `node a7-residual.mjs`.

```
  git prints            : ["a,b.mjs"]
  resolveFilesInScope   : ["a","b.mjs"]   <- ONE file became TWO entries
  validateScopeEntries  : []              <- both halves validate
  outOfScope            : ["a,b.mjs"]
```

Both halves are legal 1-segment literal entries, so nothing refuses; the real file is out of scope.

## SUSPICIONS (not reproduced as reachable defects)

- `laneFenceHits` THROWS `Cannot read properties of null (reading 'endsWith')` on a fence record
  whose `files` array holds a non-string (`drive.mjs:1413` → `protected-paths.mjs:46`, which coerces
  `entries` but not `paths`). Unreachable through `gatherFences` (rejects non-strings, `make-brief.mjs:824`)
  + `laneFenceFor` (`String()`-coerces, `:910`). Only a hand-written `crew.json` `lane_fence`
  (`crew/crew.mjs:1778`, `crew/child.mjs:283`, both only `Array.isArray`-checked) could reach it.
  Would be an uncaught mid-run throw, not a bypass.
- `validateScopeEntries('crew')` — a STRING, not an array — returns `[]` ("valid") because it
  iterates characters. Every call site (`drive.mjs:2349`, `:1296`, `:735`, `crew.mjs:379`,
  `child.mjs:46`, `daemon.mjs` `requestedScope`) guards `Array.isArray` first, so unreachable today.
  It is a latent trap for a new caller.
- Neither `files_in_scope` nor `mutations`-adjacent lists has any length cap (`a1`: 5000 entries → 0
  defects; `a5`: 5000 directed entries accepted). `MUTATIONS_MAX` bounds mutations only. No DoS
  demonstrated — the matcher is O(n·m) over small n in practice.
- `crew/pi/` vs `crew/pizza.mjs`: I could NOT make prefix-without-boundary matching happen. The
  mandatory trailing slash carries the boundary. Clean.

## NEGATIVE RESULTS (attacks the code correctly survived)

Traversal (`a1`):
- `a/../b`, `a/b/../../../etc/passwd`, `./a/b`, `a/./b`, `..`, `../x`, `a/..`,
  `crew/../crew/drive.mjs` (normalises INSIDE scope) — ALL rejected `no . or .. segments`.
- `a/.../b` accepted, but `...` is a literal directory name on POSIX; no escape.
- `tasks/x/captures/....//....//etc/passwd` accepted by `validateMutations` (`a5`) — again literal
  `....` segments; `${ctx.checkout}/${mutation.file}` (`drive.mjs:2515`) cannot leave the checkout.
- No call site URL-decodes or shell-interpolates a scope path; `seat-io.mjs:2116` uses argv-form
  `git add --`.

Separators (`a1`, `a2`):
- `/a/b`, `//a/b`, `//` — rejected `absolute path`.
- `a/` and `a//` — rejected `directory prefix is too broad` (min 2 segments).
- `crew/`, `docs/`, `tasks/` — rejected; a top-level directory can never be a scope entry.
- `a//b`, `crew//drive.mjs`, `crew\drive.mjs`, `crew/drive.mjs/`, `a/b//` validate but match nothing
  (folded into F5) — none of them MATCHES a real path, so none is a write bypass.
- `crew/drive.mjs/` (file entry, trailing slash) matches nothing AND misses the floor — but since it
  matches nothing, no write can land through it.

Prefix vs path-segment (`a2` §3): `crew/pi/` does NOT match `crew/pizza.mjs`; `a/b/` does not match
`a/bc/d`; `tasks/x/captures/` does not match `tasks/x/captures-extra/y`; `a/b/` does not match `a/b`.
The `startsWith` is safe because the trailing slash is mandatory and part of the prefix.

Protected/scope matcher agreement (`a2` §1-2): for EVERY spelling tested, `scopeMatcher` matching a
protected path implies `protectedHits` fires. Enumerated for the file `crew/drive.mjs` (15 spellings)
and the directory `docs/adr/` (11 spellings). `docs/adrx/` and `docs/ad/` correctly do not hit
`docs/adr/`. There is no string-level spelling that matches-but-evades. (The only evasions are
filesystem-level — F2, F3.)

Globs (`a1`): `a/*.mjs`, `a/?.mjs`, `a/[ab].mjs`, `a/{x,y}.mjs`, `a/**/b` all rejected loudly.
`a/b(c).mjs` correctly NOT treated as a glob.

Types (`a1`): `null`, `42`, `["a"]`, `{}`, `undefined`, `true`, `new String(...)` all rejected
`empty or non-string entry`. `''` rejected.

`resolveProtectedPaths` (`a2` §6): rejects a non-array (`'db/'`), a non-string element (`42`,
`['a']`) and a blank element (`'  '`); normalises `'./db\migrations\'` → `db/migrations/`; returns
the frozen floor for `null`/`undefined`; additions can only GROW the floor.

`laneFenceHits` shape robustness (`a2` §5): `undefined`, `null`, `[]`, `[{}]`, `[{lane}]`,
`[{lane, files:'crew/'}]`, `[{lane:1,...}]`, `'not-array'`, `[null]` all return `[]` — never inverts
into an allow-list.

`checkFailureLine` (`a5`) — 19/19 correct, exact-token confirmed:
`FAIL cache-v2` does NOT satisfy check `cache`; `FAIL cache:why` does NOT (colon must be followed by
whitespace or EOL); `FAIL cache:v2: why` does NOT; `FAIL cache.v2` does NOT; `FAIL cache why`,
`FAIL  cache`, `FAILcache`, `xFAIL cache`, `prefix FAIL cache`, `fail cache` all correctly false;
`FAIL cache`, `FAIL cache: why`, `FAIL cache:`, `  FAIL cache  `, and a match on the 2nd of two lines
all correctly true. The check label regex `^[A-Za-z0-9][A-Za-z0-9._-]*$` (`drive.mjs:1317`) makes a
regex metacharacter in a check unauthorable, and `checkFailureLine` never builds a RegExp from it.

`validateMutations` (`a5`) — rejected correctly: `exempt` alongside `file`/`find`/`replace`;
`exempt: false`; a blank exemption reason; empty/missing `find`; missing `replace`;
`find === replace`; a `file` out of `files_in_scope`; a `file` with `..`; a `file` with a trailing
slash; a `file` with a trailing space; an absolute `file`; a duplicate `check`; a `check` with a
space, a colon, a regex metacharacter, a leading underscore, or `__proto__`; a non-string or empty
`check`; a `null` or array entry; a non-array `entries`; `MUTATIONS_MAX + 1` entries (exactly
`MUTATIONS_MAX` accepted). A `file` under a directory-prefix scope entry correctly accepted.

`parseDirectedBrief` (`a5`) — rejected correctly: `null` and array blocks; no block; two blocks;
unclosed block; a 4-backtick closer; a blank `gate_cmd`; `files_in_scope` not an array; `..` and
top-level-dir scope entries; an empty or non-string brief. `__proto__` as a top-level key is caught
by the closed-key-set check (`JSON.parse` makes it an own key, unlike an object literal). CRLF
briefs, indented fences and a fence line with a trailing space all parse. `gate_cmd` is trimmed.

`validateCarve` (`a5`) — refuses a missing/`null`/unknown `carve_verdict` (silence is never
permission); refuses an empty or non-array `carve_slices`; reports slice-0's scope defect as
`defect`; drops later invalid slices without dropping slice 0. (It inherits F5's whitespace
acceptance.)

`seat-io.mjs` `changedFiles()` porcelain parsing (`a7`) — `git status --porcelain -uall -z` with
`slice(3)` correctly yields both sides of a rename (`ci2.yml` and `ci.yml`) and a filename with a
LEADING SPACE (`" leading.txt"`). `-z` means no quoting, so `core.quotePath` cannot corrupt it.

Case aliasing, the closed direction (`a6`, `a7`) — a case-variant DIRECTORY entry always fails the
scope gate, whether the directory already exists (`.github/Workflows/` → git prints
`.github/workflows/evil.yml` → out of scope) or not (`docs/Sub/` → git prints `docs/Sub/x.md`, so
`docs/sub/` is out of scope). No write ever lands through a case-variant scope entry.

`crew/daemon.mjs:53 scopeEntryDefects` is byte-identical logic to `validateScopeEntries` today and
`crew/daemon.test.mjs:298` pins the two against a shared table (F6 is only about the table's gap).

`--files-in-scope` shape (`crew/crew.test.mjs:954`) — a valueless flag, a non-string, and an
all-blank list are refused; `resolveFilesInScope` refuses every entry the gate rejects.

## FILES READ IN FULL
- `crew/protected-paths.mjs` (1-53)

## FILES READ IN THE RANGES SHOWN
- `crew/drive.mjs` — 700-760, 1240-1440, 2030-2200, 2330-2420, 2490-2580, 2960-3030, 3225-3250
- `crew/crew.mjs` — 340-440, 1380-1400, 2150-2180, plus greps
- `crew/child.mjs` — 40-60
- `crew/daemon.mjs` — 53-85
- `crew/seat-io.mjs` — 2080-2140
- `scripts/factory/make-brief.mjs` — 300-320, 790-940, 1520-1570
- `crew/drive.test.mjs` — 1-230, 790-920, 3232-3260
- `crew/crew.test.mjs` — 954-1020
- `crew/daemon.test.mjs` — 296-302
- `test/factory-make-brief.test.mjs` — 555-615
