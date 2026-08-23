# Lens E (planner's own) — the driver's own parse/format seams

Surfaces: `crew/drive.mjs` (gate-summary, review-findings, questions, accept
decision, commit message) and `crew/seat-io.mjs` (the shell/git seams that feed
them). Distinct from lens C, which took the scope/fence path matchers.

All repros live beside this file and run against the scratch copy at
`…/scratchpad/h2/repo` (`git archive HEAD`). Nothing here touched the checkout.

## E1 — `io.run()` has no `maxBuffer`: a lane over 1 MiB is killed, called red, and the failure text is replaced by the kill notice

- `crew/seat-io.mjs:1800` — `spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding:'utf8', timeout: 900_000, env })`. No `maxBuffer`, so Node's 1 MiB default applies to stdout+stderr combined.
- Repro: `lensE/probe2.mjs` (a command that exits 0), `lensE/probe4.mjs` (the full harm chain).

Observed (probe2 — child genuinely `exit 0`):

    res.status      = null
    res.signal      = "SIGTERM"
    res.error       = ENOBUFS
    io.run().ok     = false
    output bytes    = 1051693
    summary present = false

Expected: a command that exits 0 yields `ok: true`, and its output — including
its final `GATE-SUMMARY` / `# fail 0` line — survives.

Two distinct harms, both measured:

1. **A passing command is reported red.** Every summary convention this repo
   depends on (`GATE_SUMMARY_PREFIX`, `crew/drive.mjs:586`; the `# fail N` TAP
   line the brief mandates) is printed LAST, which is exactly the region
   `maxBuffer` discards.
2. **A genuinely red lane is bounced blind.** `crew/drive.mjs:3015` writes the
   builder's lane bounce as ``Failures:\n${laneRes.output.slice(-4000)}``. Under
   ENOBUFS the tail is padding plus the kill notice. probe4, whose command
   printed a real `not ok 1207 …` assertion last:

       io.run().ok            = false    (red — but for the WRONG reason)
       output bytes retained  = 1051743
       does the output carry the real failure?  false
       last 160 chars of what the builder is shown:
       "…passing chatter \n\n[spawn error: spawnSync /bin/sh ENOBUFS]\n[killed by SIGTERM — likely the 900s run timeout]"

   The builder is told the lane is red and shown nothing about why, on a round
   it can spend only once.

**Is 1 MiB reachable here?** Measured on this checkout, full suite, all green,
`NO_COLOR=1`, both reporters:

| lane as actually run | green bytes | % of 1 MiB | headroom |
|---|---|---|---|
| `npm test` (default/spec reporter) | **274,818** | 26% | 773,758 B |
| `node --test --test-reporter=tap` (the reporter the brief MANDATES for a gate) | **543,608** | 52% | 504,968 B |

Measured marginal cost of one failing test with a modest deep-equal diff
(`lensE/failcost/`, 12-row object):

| reporter | 10 failures | 50 failures | per failure |
|---|---|---|---|
| spec | 26,110 B | 130,771 B | ~2.6 KB |
| tap | 39,908 B | 199,815 B | ~4.0 KB |

So the ceiling is crossed at roughly **290 failing tests** on the plain `npm test`
lane and **126** on a TAP gate that shells to the suite. In a 2171-test suite
whose modules are heavily shared, a broken common helper reaches those counts
easily — and richer failures (longer diffs, stack traces, `console.log` left in)
push the per-failure cost well above this floor. The buffer therefore overflows
*precisely in the regime where the driver most needs the output*, and it fails
silently.

Honest limits of this measurement: I did not produce a real 126-failure run of
this suite, so the crossing point is arithmetic from two measured constants, not
an observed crossing. What IS observed end to end is the mechanism (probe2,
probe4): once the ceiling is crossed, a passing command reports red and the
failure text is gone.

**Blast radius: it is the only door.** Every command the driver runs goes
through this one call. `io.run(ctx.suite)` — the FULL suite, the largest output
of all — at `crew/drive.mjs:1691` and again at `:3226`; the validation lane at
`:3003`; and every gate invocation, because `runGate`'s default runner is
`io.run` (`crew/drive.mjs:1593`, `runner = io.run`) — baseline (`:2690`), each
round's gate (`:3030`), and each gate repair (`:3053`, `:3065`, `:3078`). There
is no second path with a different buffer.

Severity: **wrong-answer** (a green command reported red; a red one reported
without its reason).

**This is not a new hardening idea — it is a ratified requirement the driver
does not meet, with two compliant siblings in this same repo.**

The project's own architecture package names this exact failure mode:

- `tasks/deterministic-backbone/architecture-package-v2.md:139`, **FM-2**:
  "Set `maxBuffer` explicitly; check `res.error` (incl. `ENOBUFS`), `res.signal`,
  and `res.status === null` **before** attempting `JSON.parse`. A truncated JSON
  document must be an operational failure, never a silently-partial parse."
  Section head at `:135` reads "Five subprocess failure modes — **all adopted**".
- `tasks/deterministic-backbone/architect-consult-v1.md:21` says the same, and
  names the default: "default 1 MB; overflow truncates stdout,
  `res.error.code === 'ENOBUFS'`".

Two call sites comply. The closest is in this hunt's own `where` list:

    crew/pi/extensions/lab.ts:493-495
      const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: opTimeoutMs, maxBuffer: opMaxBuffer })
      if (run?.error?.code === 'ETIMEDOUT') throw refusalError('op-timeout', 'git operation timed out')
      if (run?.error?.code === 'ENOBUFS')   throw refusalError('op-oversize', 'git operation exceeded its output bound')

`crew/pi/extensions/advisor.ts:396` does likewise (`maxBuffer: DIFF_MAX_BUFFER_BYTES`)
and carries a dedicated recogniser, `gitOverflow` (`:385`).

So the bound, the refusal, and even the vocabulary that distinguishes the two
kill causes (`op-oversize` vs `op-timeout`) are already invented in this repo.
`crew/seat-io.mjs:1800` — the driver's single command chokepoint — has none of
them, and `:1805` asserts the cause lab.ts is careful to distinguish.

Missing guard, and the asymmetry is total. Across all of `crew/*.mjs` there is
not one reference to `ENOBUFS` or to `res.status === null`:

    $ grep -rn 'status === null|ENOBUFS|res\.error' crew --include=*.mjs
    crew/driver.mjs:31           if (!res.ok) throw ... res.error.message
    crew/seat-io.mjs:1804        if (res.error) output += `[spawn error: ...]`
    crew/seat-io.mjs:2139        if (!res.ok) throw new Error(res.error.message)
    crew/crew.mjs:1575           if (!res.ok) throw ... res.error.message
    crew/pi/extensions/lab.test.mjs:735   for (const code of ['ETIMEDOUT','ENOBUFS'])

The only hit that adjudicates ENOBUFS is a TEST — and it is lab.ts's test, which
pins exactly the behaviour the driver lacks:

    crew/pi/extensions/lab.test.mjs:734-743
      test('sync operation timeout and buffer errors are typed refusals', …)
        assert.equal(run.program.responses[0].refused, code === 'ETIMEDOUT' ? 'op-timeout' : 'op-oversize')

So this repo already knows the failure, already implements the fix, and already
tests it — for the sandboxed extension, and not for the driver that runs every
lane, gate and suite. `crew/seat-io-runclean.test.mjs` covers `runClean`'s stash
round-trip, not output volume; no test drives `run()` past 1 MiB. There is no
refusal for a truncated or killed child either — `res.error` is appended to
prose (`:1804`) and then only `res.status === 0` decides (`:1806`).

### E1a (rider) — the kill notice asserts the wrong cause
`crew/seat-io.mjs:1805` renders every `SIGTERM` as `— likely the 900s run
timeout`. ENOBUFS kills with SIGTERM too, so the single artefact a human or a
bounced builder reads to diagnose E1 states a cause that is not the cause. This
is the same distinction `crew/pi/extensions/lab.ts:494-495` draws correctly with
two separate refusals. Severity: **wrong-answer** (it is a positive false claim
in a diagnostic, not a missing one), and it is what would send a reader down the
wrong path for the whole of E1.

### E1b (rider) — the same default on two git seams
`crew/seat-io.mjs:1814` (`runClean`'s `git status --porcelain -uall`) and
`crew/seat-io.mjs:2098` (`changedFiles`'s `git status --porcelain -uall -z`) are
`execSync` with the same 1 MiB default. Both fail *closed* (execSync throws →
runCmd escalates), so this is **refuses-wrongly**, not silent corruption. Noted
for completeness; only E1 is silent.

## E2 — a builder's commit body forges git trailers the driver validates strictly on its own path

- `crew/drive.mjs:1424` `composeCommitMessage`. Its own `Refs:` trailer is built
  from `issues` under `/^\d+$/` (`:1431-1435`) — deliberately strict. The body at
  `:1429` is `String(builderEnv?.details?.commit_message || builderEnv?.summary || '').trim()`
  and reaches the commit verbatim; the subject at `:1425` IS newline-stripped, the
  body is not.
- `crew/seat-io.mjs:2117` commits it with `git commit -q -F -`, so every line of
  model-authored prose lands as a real commit-message line.
- Repro: `lensE/probe3.mjs`.

Observed (case B — plan declared only issue 7):

    feat: x

    did the thing

    Closes #526
    Refs: #999
    Co-Authored-By: Nobody <nobody@example.com>

    Refs: #7

Expected: the body cannot introduce trailers the driver refuses to write itself.
Two `Refs:` trailers, the forged one first, is on its face incoherent.

Consequence: `Closes #526` / `Fixes #N` in a commit body **auto-closes that
GitHub issue when the branch merges** — an unrelated issue, from a value nothing
validated. `Co-Authored-By:` is likewise forgeable, and this project's standing
convention is that no commit carries one (brief §Conventions).

Severity: **corrupts-state** (durable, outward-facing, and the state corrupted is
outside the repo).

Missing guard, and it is a pointed one. `crew/drive.test.mjs:1116-1124` is the
only coverage: it pins the happy path and, at `:1124`, that NO `Refs:` appears
when the plan declares no issues — i.e. it asserts precisely the property this
attack breaks, using a body (`'body'`) that happens not to contain one. And
`test/factory-make-brief.test.mjs:645` asserts only that the compiled brief
CONTAINS the string `Co-Authored-By` — the prose rule telling members not to
write one. So the no-trailer convention is enforced by asking politely in a
prompt and by no code at all. The asymmetry is the tell: the strict `/^\d+$/`
at `:1433` shows the author intended to control issue linkage, and the body
route walks around it.

### E2a (rider) — the body is uncapped
probe3 case E: a 5,000,000-byte `summary` produces a 5,000,003-byte commit
message. `-F -` means no E2BIG, so it simply commits. Severity: **cosmetic**.

## E3 — `reviewFindings` is uncapped where `parseQuestions` is capped, and both feed a brief

- `crew/drive.mjs:802` `reviewFindings` — no bound on `details.findings.length`.
- `crew/drive.mjs:833` `MAX_QUESTIONS = 10`, enforced at `:907`.
- `crew/drive.mjs:1218` `acceptContractLines` renders one line per finding into
  the lead's accept contract.
- Repro: `lensE/probe1.mjs`.

Observed:

    1 findings accepted of 5000: 5000
    1 acceptContractLines line count: 5003
    2 questions accepted of 5000: 10 10

Expected: one bound, or a stated reason why findings differ from questions. Both
are member-authored arrays rendered into a prompt; only one is bounded.

Severity: **hangs-or-leaks** (an unbounded member-controlled array becomes an
unbounded prompt, i.e. unbounded spend, on the accept path).

Missing guard: `crew/drive.test.mjs:487` onward pins `reviewFindings`'s
per-entry rejection (non-array input, missing id, bad severity, duplicate id)
but never a count.

## E4 — a finding `id` is unconstrained, so one finding forges extra lines in the lead's accept contract

- `crew/drive.mjs:824` stores `id: entry.id` raw once `entry.id.trim() !== ''`
  (`:810`); `crew/drive.mjs:1222` interpolates it into a `- …` line.
- Repro: `lensE/probe1.mjs`, cases 3 and 4.

Observed (one finding submitted, `id: "f1\n- f2 (must-fix) forged.mjs:1 forged"`):

    - f1
    - f2 (must-fix) forged.mjs:1 forged (consider) (location unspecified) — s

Two contract lines from one finding. `validateAcceptDecision` then demands every
listed id be named exactly once, so the lead answering what it was shown gets
`unknown id` for the forgery and the accept is refused.

The untrimmed variant is the same root cause and refuses just as hard —
`id: "  f1  "` renders indistinguishably from `f1`, and the lead's correct-looking
answer produces:

    [{"id":"f1","why":"unknown id"},{"id":"  f1  ","why":"omitted id"}]

Expected: an id is a stable token. The same file already knows this — `CHECK_LABEL`
(`crew/drive.mjs:1317`, `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`) constrains mutation check
labels for exactly this reason, with #330/#387 written up beside it. Finding ids
get no such rule.

Severity: **refuses-wrongly** (a well-behaved lead cannot satisfy a contract it
was shown), shading into wrong-answer (the lead adjudicates a finding nobody made).

Missing guard: `reviewFindings` trims `location` and `summary` (`:826-827`) but not
`id`, and validates severity against a closed set but id against nothing.

## E5 — `parseGateSummary` accepts an internally impossible summary

- `crew/drive.mjs:586`. Each of total/failed/errored must be a non-negative safe
  integer; no relation between them is checked.
- Repro: `lensE/probe1.mjs`, cases 5a-5k.

Observed: `GATE-SUMMARY {"total":1,"failed":99,"errored":0}` →
`{"total":1,"failed":99,"errored":0}`, accepted. `baselineGateDefect`
(`crew/drive.mjs:605`) then sees a summary, `errored === 0`, `failed > 0`, and
returns `null` — baseline accepted as legitimately red.

The sharper instance: `{"total":0,"failed":1,"errored":0}` is accepted the same
way — a gate declaring it ran **zero** checks passes the baseline-red test whose
entire purpose (#153) is to prove the checks RAN.

Expected: `failed + errored <= total`, and `total > 0`.

Severity: **wrong-answer**, low reachability (it needs a gate that miscounts, not
a hostile one) — but the mechanism's whole claim is that it can tell a red gate
from a broken one, and this is a broken gate it cannot tell.

Missing guard: `crew/drive.test.mjs` pins malformed-reads-as-absent and last-wins;
no case asserts a relation between the three numbers.

## Suspicions (not findings — could not reproduce harm)

- `logLine` (`crew/driver.mjs:224`) appends `${JSON.stringify(obj)}\n`. For an
  unserialisable top-level value `JSON.stringify` returns `undefined`, which the
  template renders as the literal line `undefined` — invalid JSONL. I could not
  find a caller that can pass such a value (every call site passes an object
  literal), so this is latent, not live.
- `envelopeDefect` (`crew/drive.mjs:641`) admits an artifact path that is a
  SYMLINK out of the task dir: the prefix and `.`/`..` segment checks both pass.
  Artifacts are reported, not read, so I could not carry it to a harm.
- `#0013` is accepted by the issue filter (`crew/drive.mjs:1433`) and rendered as
  `Refs: #0013`. GitHub resolves it to issue 13, so I could not make it wrong.
- `gateReapVerdict` (`crew/drive.mjs:577`) reads `survivors` as
  `String(parsed.survivors ?? '').split(/\s+/)`, so an ARRAY-valued survivors
  field collapses to one comma-joined pseudo-pid (`["11","12"]` -> `["11,12"]`)
  instead of two. The only writer is the code-owned shell launcher, which emits a
  space-separated string, so I could not reach it from any input this hunt
  controls. Latent, not live.

## Negative results (attacks this code survived — do not re-run)

- ANSI-wrapped `GATE-SUMMARY` line → `parseGateSummary` returns null, BUT the
  driver already neutralises colour at the spawn point: `colorNeutralEnv`
  (`crew/seat-io.mjs:1459`) deletes `FORCE_COLOR` and `CLICOLOR_FORCE` and sets
  `NO_COLOR=1`, and `io.run` uses it (`:1800`). #240 is closed at the right layer.
- `parseGateSummary`: prefix-extended (`GATE-SUMMARYX …`), trailing junk after the
  JSON, string-typed numbers, an array payload, and a malformed line after a good
  one all read as absent/skipped, never as a pass. Indentation is tolerated
  (correct). Duplicate JSON keys resolve last-wins consistently. `-0` normalises.
- `checkFailureLine` (`crew/drive.mjs:1318`) is genuinely exact-token: `FAIL cache`
  does NOT match `FAIL cache-v2: why`; em-dash and space delimiters are rejected;
  a bare label, a colon delimiter, an empty rest, leading/trailing whitespace and
  a tab all behave as documented; `xFAIL cache` and `echo FAIL cache` do not match.
  #330/#387 hold.
- `changedFiles` (`crew/seat-io.mjs:2098`) uses `-z -uall` and slices 3, so paths
  with spaces, quotes or non-ASCII are NOT mangled by `core.quotePath`, and
  rename/copy entries contribute BOTH sides. No defect.
- `commit` (`crew/seat-io.mjs:2116-2117`) uses argv-form `git add --` and
  `commit -F -`: a scope path beginning `-`, or containing a shell metacharacter,
  is data not syntax. No injection.
- Anti-replay on pane assignments: `assign` unlinks a pre-existing return path
  (`crew/seat-io.mjs:1726`) and `validEnvelope` (`:623`) refuses a mismatched
  `assignment_id`/`role`. A stale envelope from a crashed run is not accepted.
- `hasField` (`crew/drive.mjs:675`) uses `Object.prototype.hasOwnProperty.call`,
  so a `__proto__`/`constructor` key in an envelope does not fake a declared field.
  `JSON.parse` defines `__proto__` as an own property, so no pollution route.
- `envelopeDefect` (`crew/drive.mjs:634`): `status`/`summary`/`artifacts`/`details`
  type confusion all refuse — `details: []` and `details: null` are rejected as
  non-objects, `artifacts: "str"` rejected, a non-string artifact rejected, an
  artifact outside the task dir rejected, `.`/`..` segments rejected.
- Every consumer of `env.status` compares `!== 'done'` (`crew/drive.mjs:2048`,
  `:2124`, `:2231`, `:2958`, `:2774`, `:2794`, `:2832`, `:3037`), so `status: ""`,
  `status: 1`, `status: {}` all fail closed rather than passing a truthiness test.
- `parseQuestions`/`matchAnswers` (`crew/drive.mjs:870`, `:924`) are already
  hardened past this hunt's battery: `isPlainObject` rejects a null-prototype or
  exotic object, `safeArrayLength` refuses a poisoned `length`, every property read
  is in a try/catch, ids are trimmed and deduped, and the cap counts ACCEPTED
  entries. Nothing here misbehaved.
- `validateAcceptDecision` (`crew/drive.mjs:1127`) is total: array-typed inputs,
  null entries, non-object entries, unknown ids, duplicate ids, omitted ids, and
  `must-fix` typed `cosmetic` are all reported as errors rather than thrown, and
  refutation evidence is bounded at `REFUTATION_EVIDENCE_MAX` (500).
- `reviewFindings` rejects a non-array `findings`, an array-typed entry, an entry
  with a non-string or blank id, a severity outside the closed set, and duplicates.

- `gateReapCommand` (`crew/drive.mjs:363`) composes a bash heredoc around a
  planner-authored gate command, which is the obvious break-out target. It holds:
  every interpolated path goes through `shQuote`; a command carrying
  `__CREW_GATE_CMD_EOF__` on a line of its own is refused wrapping outright
  (`:368`) rather than corrupted; a line carrying the LAUNCH delimiter cannot
  close the CMD heredoc (only its own delimiter can); and a *substring*
  occurrence such as `x__CREW_GATE_CMD_EOF__` is neither a bash terminator nor a
  match for `gateReapOriginal`'s `\n<delim>\n` search (`:551`), so wrap and
  unwrap agree. No break-out found.
- `gateReapVerdict` (`crew/drive.mjs:563`) is total: a non-string, unparseable,
  non-object, or unknown-`outcome` report all read as `unproven`, never as a
  death claim, and `pgid`/`signals` are range-checked.

## Files read in full

`crew/drive.mjs` §§ 140-250, 320-330, 580-700, 795-960, 1085-1240, 1305-1440,
3010-3100, 3220-3235 (the parse/format seams; not the 3250-line whole).
`crew/seat-io.mjs` §§ 1450-1500, 1780-1920, 2090-2160.
`crew/driver.mjs` §§ 220-235.
Anchors in this document were each re-read with `sed -n` after writing.
