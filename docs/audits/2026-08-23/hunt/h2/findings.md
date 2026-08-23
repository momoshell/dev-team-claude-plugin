# h2-boundaries — adversarial defect hunt on input boundaries

Task: `h2-boundaries`. Assignment `d1` (scout — read-only recon).
Checkout at `5a8d76a059e3e78c103556b097901ee65fe61439`, verified clean before and
after (`git status --porcelain -uall` empty; the run changed zero files).

Every experiment ran against a scratch tree produced by `git archive HEAD`,
never against the checkout. `repro/setup.sh` rebuilds that tree and prints its
path; every repro under `repro/` takes it as `argv[2]` or `$H2_REPO`.

## How this was hunted

Five lenses, each given a disjoint surface so no two re-ran the same attack:

| lens | surface | notes |
|---|---|---|
| A | CLI flag parsing — `crew/crew.mjs`, `crew/factoryctl.mjs` | `notes/lensA.md` |
| B | envelope & frame readers — `crew/headless.mjs`, `crew/headless-rpc.mjs`, `crew/seat-io.mjs` | `notes/lensB.md` |
| C | scope gate & fence register — `crew/drive.mjs`, `crew/protected-paths.mjs` | `notes/lensC.md` |
| D | brief compiler & lab — `scripts/factory/make-brief.mjs`, `crew/pi/extensions/lab.ts` | `notes/lensD.md` |
| E | the driver's own parse/format seams — `crew/drive.mjs`, `crew/seat-io.mjs` | `notes/lensE.md` |

Findings below are ranked by severity across all five. Each lens's own notes
carry its full negative-result list; the consolidated negative results are at the
end of this document.

---

# FINDINGS

## Rank 1 — corrupts-state

### 1. The lane fence register is never path-validated: one missing `/` turns the whole cross-lane deny-list into a no-op
`crew/crew.mjs:391` (`resolveLaneFence`) → `scripts/factory/make-brief.mjs:805` (`gatherFences`) → `crew/drive.mjs:1408` (`laneFenceHits`) → `crew/protected-paths.mjs:38` (`protectedHitsIn`).
Repro: `repro/C-a3-fence-register.mjs`, `repro/C-a4-fence-e2e.mjs`.

`gatherFences` validates the register's *structure* — object shape, `lane` a
non-blank string, `files` an array of non-blank strings, no unknown keys — and
never its *path shape*. It does not call `validateScopeEntries`, and neither does
`crew.mjs boot`. Verified by reading `scripts/factory/make-brief.mjs:805-830`:
every check there is structural.

The matcher then requires a trailing slash to treat an entry as a directory —
`crew/protected-paths.mjs:45-47`, `path.endsWith('/') && entry.startsWith(path)`.
So a sibling lane declared as `"crew"` instead of `"crew/"` can only match by
exact string equality against a scope entry spelled `"crew"` — which
`validateScopeEntries` independently rejects as a bare top-level directory. The
entry is therefore **dead**: it denies nothing, silently.

Observed (`C-a3`) — every register below boots ACCEPT with an empty deny set:

    CORRECT (trailing slash)   stored=["crew/drive.mjs","scripts/factory/"]  denies=["crew/drive.mjs","scripts/factory/intake.mjs"]
    UNSLASHED DIR              stored=["crew","scripts/factory"]             denies=[]
    DOT-SLASH whole repo       stored=["."]                                  denies=[]
    ABSOLUTE path              stored=["/Users/.../crew/drive.mjs"]          denies=[]
    GLOB                       stored=["scripts/factory/*.mjs"]              denies=[]
    TRAVERSAL                  stored=["scripts/../crew/drive.mjs"]          denies=[]
    TRAILING SPACE             stored=["crew/drive.mjs "]                    denies=[]
    CASE VARIANT               stored=["Crew/Drive.mjs"]                     denies=[]

Observed (`C-a4`) — a real `driveTask`, mirroring the fixture at
`crew/drive.test.mjs:854`, changing **only** the fence spelling:

    ### CONTROL  "scripts/factory/"      ### ATTACK  "scripts/factory"
      status      : escalation             status      : done
      where       : scope                  where       : null
      COMMITTED   : []                     COMMITTED   : [["scripts/factory/intake.mjs"]]

Expected: boot refuses a register entry the matcher cannot read. A deny-list
entry that silently denies nothing is the one outcome a deny-list must never
produce.

Why it survived: `make-brief.mjs:1533` *does* run `validateScopeEntries` — but
only on the **booting lane's own** write surface, never on the sibling surfaces
that become the runtime deny-list. So an author gets a loud refusal for a typo in
their own lane and silence for the same typo in a sibling's. The tests inherit
the asymmetry exactly: `test/factory-make-brief.test.mjs:563` and `:594` pin the
unslashed refusal for `lane:'own'`, and the sibling `lane:'control'` in the same
fixture is never checked. `crew/drive.test.mjs:825` uses only the correctly
slashed `'scripts/factory/'`.

Severity: **corrupts-state**. This is a safety boundary that fails open.

### 2. A valueless `--suite` makes the full-suite check `/bin/sh -c true`: green, empty, and commit-on-green fires
`crew/crew.mjs:1798` (`suite: args.suite || 'node --test --test-timeout=30000'`) → `crew/drive.mjs:3226` (`io.run(ctx.suite)`) → `crew/seat-io.mjs:1800`.
Repro: `repro/A-11-suite-chain.mjs`.

    GOOD  --suite "npm test"       usage=ACCEPTED ctx.suite="npm test"  suite green? false
    BAD   --suite (last token)     usage=ACCEPTED ctx.suite=true        suite green? true
    BAD   --suite --keep           usage=ACCEPTED ctx.suite=true        suite green? true
    BAD   --suite $EMPTY unquoted  usage=ACCEPTED ctx.suite=true        suite green? true

    io.run(true)  -> {"ok":true,"output":""}   <-- node coerces the boolean; /bin/sh -c true exits 0
    io.run(false) -> {"ok":false,"output":""}

I re-derived both halves independently: `crew/crew.mjs:1798` applies no
validation to `args.suite`, and `spawnSync('/bin/sh', ['-c', true])` returns
`status 0`, empty stdout, no error.

Reachability is not hypothetical. The canonical dispatch line in
`skills/crew-dispatch/references/flags.md:42` — the documented one operators copy
— **ends** with `--suite "npm test"`. That is exactly the "missing value at end
of argv" shape; so is `--suite "$SUITE"` with `SUITE` unset and unquoted.

Expected: the posture the sibling flag on the same verb already takes.
`resolveValidationLane` (`crew/crew.mjs:418-439`) refuses `true`, `''` and
whitespace with a typed `[invalid-validation-lane]` refusal. `--suite` is the
other shell-command flag on that verb and validates nothing.

Missing guard: `crew/crew.test.mjs:1783-1792` iterates `REQUIRED_FLAGS` only.
`suite` is in `KNOWN_FLAGS.run` but not `REQUIRED_FLAGS.run`, so its valueless
form is never exercised.

Severity: **corrupts-state** — a commit lands and the record says "suite green"
for a suite that never ran.

### 3. A builder's commit body forges the git trailers the driver validates strictly on its own path
`crew/drive.mjs:1424` (`composeCommitMessage`) → `crew/seat-io.mjs:2117` (`git commit -q -F -`).
Repro: `repro/E-probe3.mjs`.

The driver's own `Refs:` trailer is built under `/^\d+$/` per issue
(`crew/drive.mjs:1433`) — deliberately strict. The subject is newline-stripped
(`:1425`). The body is not: `:1429` is
`String(builderEnv?.details?.commit_message || builderEnv?.summary || '').trim()`
and reaches the commit verbatim, one model-authored line at a time.

Observed (plan declared only issue 7):

    feat: x

    did the thing

    Closes #526
    Refs: #999
    Co-Authored-By: Nobody <nobody@example.com>

    Refs: #7

`Closes #N` / `Fixes #N` in a commit body **auto-closes that GitHub issue when
the branch merges** — an unrelated issue, from a value nothing validated. Two
`Refs:` trailers, the forged one first, is incoherent on its face.

Missing guard, and a pointed one. `crew/drive.test.mjs:1116-1124` is the only
coverage, and `:1124` asserts precisely the property this breaks — that no
`Refs:` appears when the plan declares no issues — using a body (`'body'`) that
happens not to contain one. `test/factory-make-brief.test.mjs:645` asserts only
that the compiled brief *contains the string* `Co-Authored-By` — i.e. the prose
rule telling members not to write one. The no-trailer convention is enforced by
asking politely in a prompt and by no code at all.

Severity: **corrupts-state** — durable, outward-facing, and the state corrupted
is outside the repo.

### 4. `nextAssignmentId` has no safe-integer floor: past 2^53 ids collide, and the collision deletes the previous turn's envelope
`crew/headless-rpc.mjs:268-281`; the unlink is `:450`. Repro: `repro/B-e8.mjs`.

    seed ["d9007199254740993.builder.json"]     {"first":"d9007199254740992","second":"d9007199254740992","collide":true}
    seed ["d99999999999999999999.builder.json"] {"first":"d100000000000000000000","second":"d100000000000000000000","collide":true}

Past 2^53, `max + 1 === max`, so consecutive turns share a `returnPath`, and
`assign` unlinks it as anti-replay — each new turn deletes the previous turn's
envelope. Self-perpetuating once it starts. `markerPgid` (`:669`) and
`evidencePgid` (`:673`) in the same file both use `Number.isSafeInteger`; this
one does not.

Severity: **corrupts-state**, narrow reachability (needs a malformed id already
on disk).

---

## Rank 2 — wrong-answer

### 5. `io.run()` sets no `maxBuffer`: any command over 1 MiB is SIGTERM'd, called red, and its failure text is replaced by the kill notice
`crew/seat-io.mjs:1800`. Repro: `repro/E-probe2.mjs` (mechanism), `repro/E-probe4.mjs` (harm chain), `repro/E-failcost/` (measurement).

Observed with a child that genuinely exits 0:

    res.status      = null
    res.signal      = "SIGTERM"
    res.error       = ENOBUFS
    io.run().ok     = false
    output bytes    = 1051693
    summary present = false

Two harms. First, a passing command reports red — and every summary convention
this repo depends on (`GATE_SUMMARY_PREFIX` at `crew/drive.mjs:586`; the `# fail
N` TAP line the brief mandates) is printed *last*, exactly the region `maxBuffer`
discards. Second, a genuinely red lane is bounced **blind**: `crew/drive.mjs:3015`
writes the builder's bounce as ``Failures:\n${laneRes.output.slice(-4000)}``, and
under ENOBUFS that tail is padding plus the kill notice. In `E-probe4`, whose
command printed a real `not ok 1207 …` assertion last:

    io.run().ok            = false    (red — but for the WRONG reason)
    does the output carry the real failure?  false
    last 160 chars shown to the builder:
    "…passing chatter \n\n[spawn error: spawnSync /bin/sh ENOBUFS]\n[killed by SIGTERM — likely the 900s run timeout]"

**It is the only door.** `io.run(ctx.suite)` at `crew/drive.mjs:1691` and `:3226`;
the lane at `:3003`; every gate, because `runGate`'s default runner is `io.run`
(`:1593`) — baseline `:2690`, each round `:3030`, each repair `:3053`, `:3065`,
`:3078`. No second path with a different buffer.

Measured headroom on this checkout, full suite, all green, `NO_COLOR=1`:

| lane as run | green bytes | % of 1 MiB |
|---|---|---|
| `npm test` (default/spec reporter) | 274,818 | 26% |
| `--test-reporter=tap` (mandated for a gate) | 543,608 | 52% |

Measured marginal cost per failing test (modest 12-row deep-equal diff): ~2.6 KB
spec, ~4.0 KB tap. The ceiling is therefore crossed at roughly **290** failing
tests on the plain lane and **126** on a TAP gate — counts a broken shared helper
reaches easily in a 2171-test suite. The buffer overflows precisely in the regime
where the driver most needs the output.

**This is not a new hardening idea. It is a ratified requirement the driver does
not meet, with two compliant siblings in this repo.**
`tasks/deterministic-backbone/architecture-package-v2.md:139` is **FM-2**: "Set
`maxBuffer` explicitly; check `res.error` (incl. `ENOBUFS`), `res.signal`, and
`res.status === null` **before** attempting `JSON.parse`." Its section head at
`:135` reads "Five subprocess failure modes — **all adopted**".
`tasks/deterministic-backbone/architect-consult-v1.md:21` names the default.
And `crew/pi/extensions/lab.ts:493-495` — a file in this hunt's own `where` list —
implements it, including the vocabulary that separates the two kill causes:

    const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: opTimeoutMs, maxBuffer: opMaxBuffer })
    if (run?.error?.code === 'ETIMEDOUT') throw refusalError('op-timeout',  'git operation timed out')
    if (run?.error?.code === 'ENOBUFS')   throw refusalError('op-oversize', 'git operation exceeded its output bound')

`crew/pi/extensions/advisor.ts:396` does likewise with a dedicated recogniser
`gitOverflow` (`:385`). Across all of `crew/*.mjs` there is not one reference to
`ENOBUFS` or `res.status === null`; the only hit anywhere is
`crew/pi/extensions/lab.test.mjs:734-743`, a test that pins exactly the behaviour
the driver lacks. The repo knows the failure, implements the fix, and tests it —
for the sandboxed extension, not for the driver that runs every lane, gate and
suite.

**Rider (same defect):** `crew/seat-io.mjs:1805` renders every `SIGTERM` as
`— likely the 900s run timeout`. ENOBUFS kills with SIGTERM too, so the one
artefact a human or a bounced builder reads to diagnose this asserts a cause that
is not the cause — the distinction `lab.ts:494-495` draws correctly.

Severity: **wrong-answer**.

### 6. One unparseable envelope, three different answers — and the RPC path fabricates a false one
`crew/seat-io.mjs:1327` (`readEnvelopeFile`) vs `crew/headless.mjs:154` and `crew/headless-rpc.mjs:166` (both `envelopeAt`); fabrication at `crew/headless-rpc.mjs:635` returning `emptyTurnEnvelope` (`:200`).
Repro: `repro/B-e10-side-by-side.mjs`, `repro/B-e3.mjs`, `repro/B-e4.mjs`.

The same 114 bytes on disk, same 600s budget, three transports:

    ### pane          {"kind":"unusable-envelope","message":"...the file EXISTED (114 bytes) and is not JSON..."}
    ### headless-json {"kind":"no-envelope","message":"headless no-envelope: seat builder produced no valid envelope at .../d1.builder.json"}
    ### headless-rpc  {"status":"insufficient","summary":"seat builder settled without writing an envelope to ...; the turn produced no usable return"}

Only the pane path implements the contract its own comment states at
`crew/seat-io.mjs:1332-1334` — an unparseable file is not an absent one. Both
other transports' `envelopeAt` do `catch { return null }`, which I verified by
reading both.

**6a (worst) — the RPC path fabricates.** `emptyTurnEnvelope`'s summary
positively asserts the seat wrote nothing, and that branch is reached whenever
`envelopeAt` returned null — which includes a file that exists and fails
`JSON.parse`. The fabrication satisfies both `validEnvelope` and
`envelopeDefect`, so the driver bounces or escalates a turn whose record is
sitting unread on disk. Usage still bills the turn.

**6b — headless-json says "produced no valid envelope" about a file that exists**,
and no re-ask is reachable: `cellFailureKind` yields `'no-envelope'`, and
`reaskDecision` (`crew/seat-io.mjs:1352`) refuses — *"failure kind no-envelope is
not an unparseable envelope"*. `err.raw` is never attached, so the escalation
cannot quote the bytes.

**6c — the budget burn is unfixed on headless-json**: worker not yet exited,
`virtual ms burned = 3610000`, 722 polls, then reported as `timeout` and routed
into `timeoutAttribution()`, where it is blamed on host load.

Missing guard: `crew/headless.test.mjs:111-125` varies stream and exit code and
**never writes a return file**. `crew/headless-rpc.test.mjs:525-556` covers only
an *absent* file. `crew/io-contract.test.mjs:379-395` maps
`headless-malformed`/`rpc-parse-error` → `unusable-envelope`, but neither stage
has a producer for a bad envelope *file*. The real guard,
`crew/seat-io-runclean.test.mjs:853-884`, hard-codes `transport: 'pane'`; no
sibling exists.

Scope note: I re-derived 6a's mechanism from the code (a malformed on-disk file
reaches the fabrication branch). Lens B additionally reports a *well-formed*
`status:"done"` envelope being overwritten in its `e4` harness; I did not
re-derive that variant myself.

### 7. `crew.mjs wait --timeout-s <non-numeric>` reports a finished run as still-running, exit 1
`crew/crew.mjs:2009-2011`. Repro: `repro/A-04-timeout-wrong-answer.mjs`.

With a settled `{"status":"done"}` envelope on disk:

    (absent, control)      exit=0  {"status":"done","summary":"the run finished green",...}
    --timeout-s 600        exit=0  {"status":"done","summary":"the run finished green",...}
    --timeout-s abc        exit=1  {"status":"still-running"}
    --timeout-s 8080abc    exit=1  {"status":"still-running"}
    --timeout-s -1         exit=1  {"status":"still-running"}
    --timeout-s 0          exit=1  {"status":"still-running"}

`Number('abc')` is `NaN`; `Date.now() < NaN` is false; the loop body — the only
thing that ever reads the envelope — never executes once. I verified the seam by
reading `:2009-2011`. The rest is unguarded too: bare `--timeout-s` →
`Number(true)` = 1s; `--timeout-s ""` → silently 3600s (only `''`/absent reach the
`|| 3600` fallback, since `'0'` is truthy); `0x10` → 16s; `Infinity` → unbounded.

Expected: the closed-set refusal both siblings already give.
`crew/limits.mjs:29-42` (`--plan-rounds`) and `crew/drive.mjs:74-85`
(`--wait-<role>`) each reject `8080abc`, `0x1f`, `1e3`, `Infinity`, `NaN`, `-1`,
`0`, `1.5` and bare-`true` with a typed `[invalid-*]`.

Missing guard: `grep -rn -- "--timeout-s"` across `crew/*.test.mjs`,
`skills/crew-dispatch/cli-contract.test.mjs`, `commands/` and `test/` returns
**zero** hits. The flag is documented at `crew/crew.mjs:29` and pinned by nothing.

### 8. A misspelled role flag is silently dropped on the `--roles` boot path, seating a different model than the operator selected
`crew/crew.mjs:2171` (prefix admits any suffix) and `:1189-1190` (only `allow-shortfall-` is validated), against `:576-583` (the tier path's loud throw). Repro: `repro/A-02-roleflags.mjs`.

    OK     assertUsage boot --model-buidler (typo role)   undefined
    THROW  resolveTier build --model-buidler              --model-buidler given but tier build seats no buidler
    OK     resolveAdapters(--model-buidler) roles=[lead]  ["lead"]
    OK     resolveAdapters(--agent-buidler) roles=[lead]  ["lead"]
    OK     resolveAdapters(--effort-buidler) roles=[lead] ["lead"]
    THROW  resolveAdapters(--allow-shortfall-buidler)     ...crew seats no buidler
    seatModel("builder", {"model-buidler":"opus"}) -> sonnet   (operator asked for opus)

The rule is already written in this file, at `crew/crew.mjs:576-577`: *"A flag
naming a role the tier does not seat is a loud throw — silently dropping operator
intent is the worse failure."* It is applied on the tier path and not on the
`--roles` path, and `:1189-1190` matches only `/^allow-shortfall-(.+)$/` — one of
the four `ROLE_FLAG_PREFIXES`.

Missing guard: `crew/crew.test.mjs:1773` deliberately pins
`assertUsage('boot', {task:'t','allow-shortfall-nosuchrole':'value'})` as *not*
throwing — the usage layer defers role-name validation on purpose — and the
downstream catch exists for exactly one prefix of four.

### 9. The protected floor is case-sensitive on a case-insensitive filesystem, so the judge tier never fires
`crew/protected-paths.mjs:38-53` / `crew/drive.mjs:1402`, consumed at `:2371`. Repro: `repro/C-a6-fs-aliasing.mjs`.

Plan declares `"crew/Drive.mjs"`:

    validateScopeEntries      : ACCEPT
    protectedHits([declared]) : []            <- crew/drive.mjs IS on the floor
    git changedFiles()        : ["crew/drive.mjs"]
    content of crew/drive.mjs : "builder edit\n"

The floor check runs before the builder is seated. With no hit, the judge-tier
reseat never fires and the builder is seated under an ordinary reviewer, with a
write surface that on APFS *is* the protected driver. Only the scope gate catches
the write, escalating `where:'scope'` — so the durable record never says a
protected path was touched. Fails **closed for the write, open for the tier**.

Missing guard: `crew/drive.test.mjs:808` tests `.bak`/`.tmp` near-misses, no case
variant.

### 10. `parseDirectedBrief` silently takes the LAST of duplicate JSON keys
`crew/drive.mjs:1290-1299`. Repro: `repro/C-a5-directed-mutations.mjs`.

    DUPLICATE gate_cmd key      ACCEPT {"gate_cmd":"rm -rf /","files_in_scope":["a/b.mjs"]}
    DUPLICATE files_in_scope    ACCEPT {"gate_cmd":"g","files_in_scope":["crew/drive.mjs"]}

`JSON.parse` keeps the last, so `Object.keys` shows no extra key and the
closed-key-set check at `:1293` passes. A human reads the first declaration
top-down; the driver builds against the last. This is the same ambiguity `:1289`
already refuses one level up ("exactly one of them is the plan").

### 11. `recogniseProviderCondition` matches bare three-digit numbers anywhere in worker stderr
`crew/headless.mjs:26-30`, `:39-44`. Repro: `repro/B-e5-shape-and-usage.mjs`.

    "Error: something failed\n    at /repo/crew/drive.mjs:401:12"  -> "auth"
    "gate summary: 429 checks passed"                              -> "rate-limit"
    "wrote 401 bytes to disk"                                      -> "auth"

The patterns are `\b401\b`, `\b403\b`, `\b429\b`, `\b529\b` over arbitrary text.
A stack frame on line 401 — the most common thing in a worker's stderr — records
an auth failure, and lands as `[provider:auth]` on the ledger `detail`.

Correction to lens B's framing, which I checked: the *"it never fabricates a
condition"* comment sits on `capturedCondition` (`crew/headless.mjs:46-49`, about
the file-absence path), not on `recogniseProviderCondition`. The over-broad match
is real regardless. Mitigating: nothing branches on the value today.

Missing guard: `crew/headless.test.mjs:127-141` asserts only true positives.
There is no negative table, so no test can go red.

### 12. `factoryctl` rejects no unknown flags: a typo'd `--files-in-scope`/`--lane`/`--variant` is dropped and the run is enqueued anyway
`crew/factoryctl.mjs:327-334` (validates only the verb), `:180-195`. Repro: `repro/A-10-factoryctl.mjs`.

Params actually sent to `enqueue`:

    control                    {..."variant":"directed","lane":"npm test","files_in_scope":["a.mjs"]}
    typo --files-in-scop       {..."variant":"directed","lane":"npm test"}   <-- scope GONE
    typo --lan                 {..."files_in_scope":["a.mjs"]}                <-- lane GONE
    typo --varient repair      {...}                                          <-- variant GONE
    crew.mjs spelling --validation-lane  {...}                                <-- lane GONE

`--validation-lane` is the sharpest: it is the *correct* spelling for `crew.mjs
run` and is silently ignored by `factoryctl run`, which wants `--lane`. Expected:
the twin of `crew/crew.mjs:2171-2176`, which refuses `--bogus-flag` with exit 2.
`crew/factoryctl.test.mjs` has 12 tests, none asserting unknown-flag rejection;
the module has no `KNOWN_FLAGS`/`assertUsage` equivalent at all.

### 13. `factoryctl send <run> <multi word message>` truncates to the first word
`crew/factoryctl.mjs:229-234`, `:241` — `message: args._[2]`, positionals past index 2 discarded. Repro: `repro/A-10-factoryctl.mjs`.

`send run-1 hello world` → `{"run":"run-1","message":"hello"}`. A message
starting with `--` is unsendable, and `--` is not an escape either:
`crew/factoryctl.mjs:19` turns it into the empty-named key and eats the next
positional as its value. `crew/factoryctl.test.mjs:506` pins only that a run id
and a message are required.

### 14. `parseGateSummary` accepts an internally impossible summary
`crew/drive.mjs:586`; consumed by `baselineGateDefect` at `:605`. Repro: `repro/E-probe1.mjs`.

Each of total/failed/errored must be a non-negative safe integer; no relation
between them is checked. `{"total":1,"failed":99,"errored":0}` is accepted. The
sharper instance is `{"total":0,"failed":1,"errored":0}` — a gate declaring it ran
**zero** checks passes the baseline-red test whose entire purpose (#153) is to
prove the checks ran. Expected: `failed + errored <= total`, and `total > 0`.
Low reachability (needs a miscounting gate, not a hostile one), but the
mechanism's whole claim is that it can tell a red gate from a broken one.

### 15. An empty exit marker parses as exit code 0
`crew/headless.mjs:146-152`, `crew/headless-rpc.mjs:158-164`. Repro: `repro/B-e8.mjs`.
`Number('')===0`, so a zero-byte marker reads as a clean exit; `'0x1f'`→31,
`'1e3'`→1000. Only `isFinite` is checked. Needs a failed `printf` or a full disk
— but the marker is the death proof.

---

## Rank 3 — hangs-or-leaks

### 16. A return file containing `null` is read as an absent file and burns the entire wait budget
`crew/seat-io.mjs:1341`. Repro: `repro/B-e6.mjs`.

    return file contains `null`   {"returned":null,"polls":720,"virtualMs":3600000}   <- entire 3600s budget
    return file contains `false`  {"returned":false,"polls":0}
    return file contains `123`    {"returned":123,"polls":0}

I verified the asymmetry by reading all three readers: both siblings guard
`value && typeof value === 'object'` (`crew/headless.mjs:158`,
`crew/headless-rpc.mjs:170`); `readEnvelopeFile` returns `JSON.parse(raw)`
unconditionally. The four bytes `null` parse cleanly, so no `pane-parse-error`
fires — the exact condition the comment at `:1332` says must never recur.
`crew/seat-io-runclean.test.mjs:816-851` has no non-object-JSON case.

### 17. headless-rpc re-reads the entire transcript on every poll and every assign
`crew/headless-rpc.mjs:264-267` (`fileSize` is a full read to get a size) and `:282-301`. Repro: `repro/B-e7-rpc-stream-reads.mjs`.

    pre-existing stream size: 20.0 MiB
    assign(d1): readFileSync calls = 18, bytes read = 40.0 MiB   (a stat() would have cost 0)
    one wait() iteration: readFileSync calls = 2, bytes read = 20.0 MiB

At `WAIT_POLL_MS=5000`, a 20-minute turn on that seat reads ≈4.8 GiB, worsening
as the transcript grows. The correct pattern is already in-tree:
`crew/daemon.mjs:598-613` `readFrom()` uses `open`/`fstat`/positional `readAt`.

### 18. No frame-size ceiling on the RPC frame reader
`crew/headless-rpc.mjs:282-301` vs `crew/daemon.mjs:140-155`. Two consumers of the
same `splitFrames`: the daemon throws `frame-too-large` past 1 MiB, headless-rpc
buffers without ceiling. Observed: assign after an 8 MiB unterminated frame.

### 19. `reviewFindings` is uncapped where `parseQuestions` is capped, and both render into a prompt
`crew/drive.mjs:802` (no bound) vs `:833` (`MAX_QUESTIONS = 10`, enforced `:907`); rendered at `:1218`. Repro: `repro/E-probe1.mjs`.

    1 findings accepted of 5000: 5000
    1 acceptContractLines line count: 5003
    2 questions accepted of 5000: 10 10

Both are member-authored arrays rendered into a brief; only one is bounded. An
unbounded member-controlled array becomes unbounded prompt spend on the accept
path. `crew/drive.test.mjs:487` onward pins per-entry rejection, never a count.

### 20. `--keep` is truthiness-only: `--keep false` keeps the workspace
`crew/crew.mjs:1886`. `--keep "false"`, `"0"`, `"no"` all suppress auto-teardown,
leaving a live cmux workspace and seats after a `done` run. Contrast
`--headless-all` (`crew/crew.mjs:487`), which refuses a value outright.

---

## Rank 4 — refuses-wrongly

### 21. An NFD path in `files_in_scope` validates but can never be satisfied
`crew/drive.mjs:1388-1392` (`scopeMatcher`, raw string compare, no `.normalize()`), consumed `:2991`. Repro: `repro/C-a6-fs-aliasing.mjs`.

    git prints    : ["docs/café.md"]  bytes=646f63732f636166c3a92e6d64  NFC? true NFD? false
    declared NFC  outOfScope=[]
    declared NFD  outOfScope=["docs/café.md"]

git (`core.precomposeunicode=true`) always emits NFC — including for a file the
builder just created from the declared NFD string. Every round bounces
`scope-fix`, then escalates `out-of-scope edits persisted: docs/café.md`, naming a
path visually identical to the declaration. `crew/seat-io.mjs:2114-2115` also
drops it, throwing `commit: nothing in scope actually changed` if it is the only
file. No test in the four suites uses a non-ASCII filename.

### 22. A review finding's `id` is unconstrained, so one finding forges extra lines in the lead's accept contract
`crew/drive.mjs:824` stores `id` raw; `:1222` interpolates it. Repro: `repro/E-probe1.mjs`.

One finding submitted with `id: "f1\n- f2 (must-fix) forged.mjs:1 forged"`:

    - f1
    - f2 (must-fix) forged.mjs:1 forged (consider) (location unspecified) — s

Two contract lines from one finding; `validateAcceptDecision` then demands every
listed id be named exactly once, so the lead answering what it was shown gets
`unknown id` for the forgery and the accept is refused. The untrimmed variant has
the same root cause: `id: "  f1  "` renders indistinguishably from `f1`, and a
correct-looking answer yields
`[{"id":"f1","why":"unknown id"},{"id":"  f1  ","why":"omitted id"}]`.

The same file already knows the answer: `CHECK_LABEL` (`crew/drive.mjs:1317`,
`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`) constrains mutation check labels for exactly
this reason, with #330/#387 written up beside it. Finding ids get no such rule,
and `reviewFindings` trims `location` and `summary` (`:826-827`) but not `id`.

### 23. A half-written envelope is indistinguishable from a permanently broken one
`crew/seat-io.mjs:1327-1349`. Repro: `repro/B-e9-writer-race.mjs`. No settle
window and no re-read: the first read landing mid-write is terminal. Cost is the
turn's one bounded re-ask plus a brief telling a blameless seat its envelope was
broken. V8 *does* separate the cases — `"Unterminated string in JSON at position
40"` vs `"Bad control character…"` — and the reader discards the distinction.

### 24. Whitespace-padded and whitespace-only scope entries validate but match nothing, and the two entry points disagree
`crew/drive.mjs:1250-1268` accepts; `crew/crew.mjs:357` trims the CLI form and
nothing else does. `" crew/drive.mjs"`, `"crew/drive.mjs "`, `"crew/drive.mjs\r"`
(CRLF-authored JSON), NBSP-suffixed, `"   "`, `"a//b"`, `"crew\drive.mjs"`,
`"crew/drive.mjs/"` all ACCEPT and match nothing. `" crew/drive.mjs"`
additionally slips the protected floor. Inherited by the directed shape (`:1297`)
and `validateCarve` (`:738`). `crew/crew.test.mjs:989` uses
`validateScopeEntries` as its own oracle, so it can never notice.

### 25. `--roles ""` silently seats the four-seat default crew
`crew/crew.mjs:1407-1408`. Repro: `repro/A-07-roles-empty-proof.mjs`, using
`--headless-rpc <role>` as the discriminator (it refuses only for an unseated
role):

    --roles lead   --headless-rpc reviewer  -> transport role reviewer given but crew seats no reviewer
    --roles ""     --headless-rpc reviewer  -> host load: ...          (reviewer IS seated)
    --roles ""     --headless-rpc tech-lead -> transport role tech-lead given but crew seats no tech-lead

So `--roles ""` seated lead+planner+builder+reviewer — four live model seats
nobody asked for. `--roles ","` *does* refuse. The empty string is the one
shell-expansion accident with no refusal, and `--files-in-scope ""` already takes
the opposite posture at `crew/crew.mjs:358` ("an empty scope is never a scope").

### 26. The same 1 MiB default on two git seams
`crew/seat-io.mjs:1814` (`runClean`'s `git status --porcelain -uall`) and `:2098`
(`changedFiles`) are `execSync` with the default `maxBuffer`. Both fail *closed*
(the throw becomes an escalation), so this is refuses-wrongly rather than silent
— noted because it is the same root cause as finding 5.

### 27. Usage errors that exit 1 with an internal TypeError instead of exit 2
`crew/crew.mjs:1407` (`--roles` bare), `:1421` (`--checkout` bare), `:2190`
(`COMMANDS[verb]` is a prototype-chain lookup on an object literal):

    verb=nosuchverb        exit=2 -> usage: crew.mjs <boot|run|handoff|wait|status|teardown> ...
    verb=toString          exit=1 -> error: known.includes is not a function
    boot --roles(bare)     exit=1 -> error: args.roles.split is not a function
    boot --checkout(bare)  exit=1 -> error: The "paths[0]" argument must be of type string. Received type boolean (true)

`--tier` bare gives `unknown tier "true"` — a refusal naming a tier the operator
never typed. `resolveVariant` (`crew/crew.mjs:337-341`) shows the intended shape
with an explicit `raw === true` branch.

### 28. `--files-in-scope` splits on `,`, so a real filename containing a comma cannot be scoped
`crew/crew.mjs:357`: `a,b.mjs` → `["a","b.mjs"]`, both halves validate, the real
file is out of scope.

---

## Rank 5 — cosmetic

29. **`SCOPE_DIR_MIN_SEGMENTS` duplicated as a literal `2`** — `crew/drive.mjs:1249` vs `crew/daemon.mjs:65`. The agreement tripwire `crew/daemon.test.mjs:298-301` holds a 1-segment and a 3-segment directory but no **2-segment** one — the exact boundary the constant names — so a 2→3 drift goes undetected (`repro/C-a8.mjs`).
30. **`outOfScopeFiles` fails OPEN on a non-array `changed`** — `crew/drive.mjs:1397`. With the empty in-scope set (`:2040`, the `writes:'none'` shape), `null`/`"a.mjs"`/`42` all yield `[]` and the gate passes vacuously. `laneFenceHits`'s identical coercion is *correct* (an absent deny-list denies nothing); this one inverts a check's default.
31. **The parse-error message reports JS chars and says "bytes"** — `crew/seat-io.mjs:1337`; an emoji envelope claims 201 bytes where the real UTF-8 length is 401. The number is quoted verbatim into the re-ask brief and the ledger detail.
32. **No reader verifies `role` or `assignment_id`** — the only verification is `validEnvelope` (`crew/drive.mjs:623-628`), two modules away, which catches a *mismatch* but tolerates *omission*. Recorded because finding 6a's fabricated envelope is the one thing that always satisfies it.
33. **The commit body is uncapped** — a 5,000,000-byte `summary` produces a 5,000,003-byte commit message (`repro/E-probe3.mjs` case E). `-F -` means no E2BIG; it simply commits.

---

# Cross-cutting patterns

Four findings are the same defect wearing different clothes, which is the most
useful thing this hunt produced:

**A numeric guard that a non-number walks straight through.** Finding 7
(`Date.now() < NaN` is false, so the loop never runs), finding 15
(`Number('')===0` is a clean exit), finding 4 (`max+1===max` past 2^53), finding
14 (three integers with no relation checked). In each case a *sibling in the same
file or module* does it correctly — `crew/limits.mjs:29-42`,
`crew/headless-rpc.mjs:669`/`:673`. The refusal vocabulary exists; it is the
application that is patchy.

**A validator applied to one side of a symmetric pair.** Finding 1
(`validateScopeEntries` on the booting lane's surface, not on siblings'), finding
3 (`/^\d+$/` on the driver's issues, nothing on the builder's body), finding 8
(`allow-shortfall-` validated, the other three role prefixes not), finding 19
(`MAX_QUESTIONS` on questions, no cap on findings), finding 22 (`CHECK_LABEL` on
mutation labels, nothing on finding ids). And in each case **the test pins the
validated side only**, which is why the suite is green at 2171/0.

**The same 1 MiB `spawnSync` default, adopted as FM-2 and implemented only in the
sandboxed extension.** Finding 5 and finding 26.

**Three transports, three answers to one question.** Finding 6 and finding 16 are
both "`crew/seat-io.mjs`'s reader and its two siblings disagree about what a
file's contents mean" — once where the pane path is right and the others wrong
(6), once the reverse (16).

---

# Consolidated negative results

Recorded so the next hunt does not re-run them. Per-lens detail is in `notes/`.

**Parser / CLI.** `--__proto__ x` is inert (the object-literal setter swallows
it); `--constructor x` becomes an own key and is refused as unknown; `---task v`,
`--task=alpha` and a bare `--` are all refused. Every `REQUIRED_FLAGS` entry
refuses `''`, `'   '` and bare-`true`. `--validation-lane` refuses `true`/`''`;
`--variant` refuses `true`, `''`, `'DEFAULT'`, `' default '`; `--wait-<role>` and
`--plan-rounds` refuse `8080abc`, `0x1f`, `1e3`, `Infinity`, `NaN`, `-1`, `0`,
`1.5` and bare-`true`; `--headless-all` accepts only `true`/`'true'`;
`--headless lead --headless-rpc lead` refuses as ambiguous. `--roles ","`,
`--roles LEAD`, `--tier BUILD`, `--tier " build "` all refuse.

**Injection.** `crew/slug.mjs:13-17` neutralises `../../etc/passwd`, absolute
paths, NUL, `\n`, ANSI and RTL, and refuses degenerate `.`/`...`.
`crew/seat-io.mjs:2116-2117` commits argv-form (`git add --`, `commit -F -`)
against only files `git status` itself reported, so no scope entry can inject
shell syntax or a leading-dash argv. `crew/seat-io.mjs:918-936` forces
`--claude-bin` absolute-and-existing. **`gateReapCommand`
(`crew/drive.mjs:363`) has no heredoc break-out**: every path is `shQuote`d, a
command carrying the delimiter on its own line is refused wrapping (`:368`) rather
than corrupted, the LAUNCH delimiter cannot close the CMD heredoc, and a
substring occurrence matches neither bash nor `gateReapOriginal`'s `\n<delim>\n`
search (`:551`).

**JSONL integrity.** `logLine` (`crew/driver.mjs:224-229`), `headless.mjs:231`
and `headless-rpc.mjs:249` all go through `JSON.stringify`, which escapes
`\n`/`\r`/NUL. Four logged objects containing forged record text produced exactly
four physical records, all parsing. **The ledger cannot be split by envelope
content.**

**Prototype pollution.** `JSON.parse` yields an *own* `__proto__` data property;
nothing does `Object.assign` on an envelope; the only envelope spread
(`crew/drive.mjs:2069`) is an array spread. `hasField` (`crew/drive.mjs:675`) uses
`Object.prototype.hasOwnProperty.call`. `Object.prototype` never polluted.

**Frame splitting.** A 4-byte emoji straddling a chunk boundary with the `rest`
carry both real callers use produces **no U+FFFD**, both frames intact. An
unterminated frame is returned as `rest` with no loss. CRLF stripped;
**U+2028/U+2029 keep one record as one record** — the readline trap the header
cites is genuinely avoided. Lone-surrogate bytes, BOM- and NUL-prefixed frames all
fail inertly. Non-string inputs do not throw.

**Envelope shapes.** `artifacts:"a.md"`, `artifacts:[null]`, `summary:0`,
`summary:"   "`, `details:null`, `details:[]`, `details:"x"` all refuse with the
right reason. Every consumer of `env.status` compares `!== 'done'`
(`crew/drive.mjs:2048`, `:2124`, `:2231`, `:2774`, `:2794`, `:2832`, `:2958`,
`:3037`), so `status: ""`, `1`, `{}` fail closed. Duplicate keys resolve last-wins
consistently, and no reader or validator scans the raw bytes with a first-match
regex, so none can disagree with the parsed object. 200,000-deep nesting parses
without stack overflow. Filesystem shapes — missing, zero-byte, a **directory** at
the path (EISDIR), a dangling symlink, mode-000 (EACCES) — are all caught; no
unhandled throw on any of the three readers.

**Wait bounds.** `waitForEnvelope` with `timeoutS` 60 → exactly 12 polls then
`null`; `0`/`-1`/`NaN`/`null`/`undefined` → 0 polls and an immediate `null`. Two
`alive:false` probes → `seat-died` after one final re-read, so a late envelope
still wins; `alive:null` forever never accumulates misses, so an indeterminate
probe never kills a seat. Anti-replay holds on every transport: pane `assign`
unlinks a pre-existing return path (`crew/seat-io.mjs:1726`) and both headless
transports unlink before spawning. **No reader ever rewrites the seat's file.**

**Scope matching.** Traversal is comprehensively rejected: `a/../b`,
`a/b/../../../etc/passwd`, `./a/b`, `a/./b`, `..`, `../x`, `a/..`, and even
`crew/../crew/drive.mjs` (which normalises *inside* scope). Absolute and
too-broad forms rejected. **Prefix-without-segment-boundary matching does not
exist** — the mandatory trailing slash carries the boundary: `crew/pi/` ✗
`crew/pizza.mjs`, `a/b/` ✗ `a/bc/d`, `a/b/` ✗ `a/b`. Globs (`*`, `?`, `[ab]`,
`{x,y}`, `**`) all rejected loudly. Types (`null`, `42`, `["a"]`, `{}`, `true`,
`new String(...)`, `''`) all rejected. For **every** spelling tested — 15 for a
file, 11 for a directory — `scopeMatcher` matching a protected path implies
`protectedHits` fires: there is **no string-level match-but-evade**, and the only
evasions found are filesystem-level (findings 9 and 21). A case-variant
*directory* entry always fails the scope gate. `changedFiles` (`crew/seat-io.mjs:2098`)
uses `-z -uall` + `slice(3)`, so `core.quotePath` cannot corrupt a non-ASCII or
space-bearing path, and both sides of a rename are reported.

**Gate mechanics.** `checkFailureLine` (`crew/drive.mjs:1318`) is genuinely
exact-token across 19 independent cases plus my own 10: `FAIL cache` does **not**
match `FAIL cache-v2: why`; em-dash and space delimiters are rejected; the bare
line, a colon delimiter, an empty rest, surrounding whitespace and a tab all
behave as documented; `xFAIL cache` and `echo FAIL cache` do not match. #330/#387
hold. `CHECK_LABEL` makes a regex metacharacter unauthorable and no RegExp is
built from a check name. `validateMutations` correctly rejects `exempt` combined
with `file`/`find`/`replace`, blank reasons, empty/missing/absent `find`,
`find===replace`, out-of-scope or `..`-bearing `file`, duplicate labels, labels
with a space/colon/regex-meta, and `MUTATIONS_MAX+1` (exactly 32 accepted).
`parseDirectedBrief` rejects null/array blocks, zero or two blocks, unclosed
fences, blank `gate_cmd`, non-array or `..`-bearing `files_in_scope`;
`__proto__` is caught by the closed-key check; CRLF and indented fences parse.
`validateCarve` refuses a missing, null or unknown verdict — **silence is never
permission** — and reports slice-0's defect while dropping later invalid slices.
`parseGateSummary` reads a prefix-extended line, trailing junk, string-typed
numbers, an array payload and a malformed-after-good line as ABSENT, never as a
pass. `gateReapVerdict` (`crew/drive.mjs:563`) is total: every malformed report
reads `unproven`, never a death claim.

**Colour.** `colorNeutralEnv` (`crew/seat-io.mjs:1459`) deletes `FORCE_COLOR` and
`CLICOLOR_FORCE` and sets `NO_COLOR=1`, and `io.run` uses it — #240 is closed at
the spawn point, so an ANSI-wrapped `GATE-SUMMARY` line cannot arise from the
driver's own children.

**`validateAcceptDecision`** (`crew/drive.mjs:1127`) is total: array inputs, null
and non-object entries, unknown/duplicate/omitted ids, and `must-fix` typed
`cosmetic` are all reported as errors rather than thrown; refutation evidence is
bounded at 500 chars. **`parseQuestions`/`matchAnswers`** (`:870`, `:924`) are
already hardened past this hunt's whole battery — `isPlainObject` rejects
null-prototype and exotic objects, `safeArrayLength` refuses a poisoned `length`,
every property read is in a try/catch, ids are trimmed and deduped, and the cap
counts *accepted* entries.

---

# Suspicions — not findings

Each of these is a mechanism I could see but could not carry to a demonstrated
harm. Listed with what was tried.

1. **`isBusyRefusal`** (`crew/headless-rpc.mjs:195-198`) needs a string-ish `error`; a structured `{error:{message:'already processing'}}` stringifies to `'[object Object]'` and no prompt retry fires. Could not establish pi's real error shape.
2. **`usageInt` has no ceiling** — two `1e308` frames sum to `Infinity` with `measured` true; `usageInt('500') === 0`, so string token counts bill zero. Needs an odd provider; no evidence either occurs.
3. **`slice(0,500)` on the ledger detail splits astral pairs** (verified as a primitive: trailing `d83d`, `isWellFormed()` false). No reachable lens-owned path found.
4. **`waitForEnvelope` with `timeoutS: Infinity` never terminates** (aborted at 2e6 iterations). Every caller traced validates the budget first (`crew/drive.mjs:60-83`).
5. **`envelopeDefect` never checks `env.status`** (`crew/drive.mjs:634-671`) despite being "deliberately stricter than validEnvelope" — `1`, `{}`, `["done"]` and *missing* all return `null`. Independently corroborated as non-exploitable: `validEnvelope` runs first on every path, and every consumer compares `!== 'done'`.
6. **`pending`** (`crew/headless-rpc.mjs:243`) is supervisor-wide and write-only; one seat's frame id can drop another's entry, with no observable effect. Dead state.
7. **No size cap on the stderr read behind `capturedCondition`** (`crew/headless.mjs:50-54`); degrades via the catch rather than crashing. Memory spike unmeasured.
8. **`laneFenceHits` throws on a fence record whose `files` holds a non-string** (`crew/drive.mjs:1413` → `crew/protected-paths.mjs:46` coerces `entries` but not `paths`). Blocked today by `gatherFences` and `laneFenceFor`'s `String()`; only a hand-written `crew.json` `lane_fence` could reach it.
9. **`validateScopeEntries('crew')` — a bare *string* — returns `[]`** by iterating characters. Every call site guards `Array.isArray` first; a latent trap for a new caller.
10. **No length cap on `files_in_scope`** (5000 entries → 0 defects, in both drive and the directed block). No DoS demonstrated.
11. **`--files-in-scope` entries survive embedded `\n` and NUL** — `validateScopeEntries` rejects only globs/absolute/`..`/broad dirs. The two consumers traced (`crew/seat-io.mjs:2109-2119` argv-form, and `logLine`) are clean; not every `laneFence`/`scopeMatcher`/brief-rendering consumer was traced.
12. **`factoryctl run --task ../../escape` and `--variant DIRECTED` forward verbatim** to the daemon's `enqueue`. `crew/slug.mjs` would neutralise the task, but I did not confirm the daemon calls it on that path.
13. **Repeated-flag last-wins is silent everywhere and pinned nowhere** — sharpest measured case: `factoryctl run --tier build --tier judge` → `"tier":"judge"`, the expensive tier. Defensible as a convention; not called a defect without a real dispatch script that duplicates a flag.
14. **`logLine`** (`crew/driver.mjs:224`) appends `${JSON.stringify(obj)}\n`; for an unserialisable top-level value that renders the literal line `undefined`, which is invalid JSONL. No caller can pass such a value today.
15. **`envelopeDefect` admits an artifact path that is a symlink out of the task dir** (`crew/drive.mjs:641`) — the prefix and `.`/`..` segment checks both pass. Artifacts are reported, not read.
16. **`gateReapVerdict` reads `survivors` as `String(...).split(/\s+/)`** (`crew/drive.mjs:577`), so an array-valued field collapses to one comma-joined pseudo-pid. The only writer is the code-owned launcher, which emits a space-separated string.

---

# Files read

**In full:** `crew/crew.mjs` (2206) · `crew/factoryctl.mjs` (376) ·
`crew/headless.mjs` (338) · `crew/headless-rpc.mjs` (755) ·
`crew/protected-paths.mjs` (53) · `crew/slug.mjs` · `crew/limits.mjs` ·
`crew/host-load.mjs`.

**In ranges** (no lens read all 3250 lines of `drive.mjs` or all 2156 of
`seat-io.mjs`): `crew/drive.mjs` §§1-140, 320-400, 540-760, 795-960, 1085-1440,
2030-2200, 2330-2420, 2490-2580, 2960-3100, 3220-3250 · `crew/seat-io.mjs`
§§918-936, 960-1010, 1260-1510, 1780-1920, 2080-2160 · `crew/driver.mjs`
§§218-240 · `crew/daemon.mjs` §§53-85, 120-180, 590-620, 700-740 ·
`crew/child.mjs` §§40-60 · `scripts/factory/make-brief.mjs` §§300-320, 790-940,
1520-1570 · `crew/pi/extensions/lab.ts` §§488-500 ·
`crew/pi/extensions/advisor.ts` §§385-400.

**Tripwire tests consulted:** `crew/crew.test.mjs` · `crew/drive.test.mjs` ·
`crew/daemon.test.mjs` · `crew/factoryctl.test.mjs` · `crew/headless.test.mjs` ·
`crew/headless-rpc.test.mjs` · `crew/io-contract.test.mjs` ·
`crew/seat-io-runclean.test.mjs` · `crew/pi/extensions/lab.test.mjs` ·
`test/factory-make-brief.test.mjs` · `test/factory-probe-repo.test.mjs` ·
`skills/crew-dispatch/cli-contract.test.mjs`.

**Docs:** `tasks/deterministic-backbone/architecture-package-v2.md` ·
`tasks/deterministic-backbone/architect-consult-v1.md` ·
`skills/crew-dispatch/references/flags.md`.
