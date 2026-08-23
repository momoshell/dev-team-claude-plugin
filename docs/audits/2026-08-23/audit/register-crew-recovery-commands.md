# Register — `skills/crew-recovery/` + `commands/`

Audit scope: read-only. Checkout `/Users/x/Development/dt-s3-prose`, branch `audit-s3-prose`, HEAD `5a8d76a`. Zero repo writes.

## Files read in full

| File | Lines |
|---|---|
| `skills/crew-recovery/SKILL.md` | 38 |
| `skills/crew-recovery/references/closeout.md` | 39 |
| `skills/crew-recovery/references/escalations.md` | 32 |
| `skills/crew-recovery/references/liveness.md` | 27 |
| `skills/crew-recovery/references/mutation-proof.md` | 42 |
| `commands/close-out.md` | 10 |
| `commands/dispatch.md` | 10 |
| `commands/status.md` | 13 |
| `commands/commands.test.mjs` | 132 |
| **Total** | **343** |

Corroborating sources read: `crew/drive.mjs`, `crew/crew.mjs`, `crew/seat-io.mjs`, `crew/variants.mjs`, `crew/escalation-policy.mjs`, `crew/adapters/adapter-claude.mjs`, `crew/adapters/adapter-pi.mjs`, `crew/headless-rpc.mjs`, `crew/roles/planner.md`, `crew/roles/builder.md`, `crew/README.md`, `scripts/factory/reap-stale.mjs`, `package.json`, `crew/drive.test.mjs`, `crew/crew.test.mjs`, plus `gh issue view` for #330 / #387 / #497 / #500 / #512 and `gh pr view 519`.

---

## Per-document register

### `skills/crew-recovery/SKILL.md`

**Checkable claims: 14 — true 8, stale 3, false 3.**

#### FALSE

**1.** SKILL.md:29 —

> `- `status` answers alive, not busy; derive idle-alive versus busy-alive from journal recency (#387).`

The behavioural half is true (see liveness.md register). The **citation is false**. `gh issue view 387` → *"the mutation contract states the FAIL label but not its SEPARATOR, and that has now cost three gate generations in two batches"* (CLOSED). That is the `FAIL <check>` delimiter issue, corroborated in-tree at `crew/drive.mjs:1331` (`// The DIAGNOSIS of a rejected FAIL line, never the RULE (#387)`). #387 has nothing to do with liveness. An agent chasing the citation for liveness evidence lands on the mutation-proof issue. The real liveness evidence is #511 / PR #519 (`git log f410c89`, `fix(crew): fail waiting seats on substrate death, distinctly from seat death`).

**2.** SKILL.md:30 —

> `- Read mutation declarations and scout findings from the per-seat return, not the roll-up field names (#330).`

Behaviour true; **citation false**. `gh issue view 330` → *"Gate discrimination is whole-gate only: vacuous individual checks pass the proof"* (CLOSED). Corroborated at `crew/drive.mjs:1312` and `crew/drive.mjs:2491` (`// Per-CHECK discrimination (#330)`). #330 is the per-check mutation-proof issue, not the roll-up/per-seat-return distinction.

**3.** SKILL.md:19 (routing table) —

> `| Closing a converged or escalated lane | `references/closeout.md` | Preserve, commit, prove, publish, then teardown last. |`

Instructing teardown as the terminal step for an **escalated** lane contradicts the code and the skill's own rules. `crew/crew.mjs:1885`: `if (result.status === 'done' && !args.keep) { … teardownCore … }` — an escalation is never torn down by the runtime, and `crew/crew.mjs:1879-1881` states the policy: `// escalation -> NEVER teardown: the workspace IS the escalation context`. `references/closeout.md:38-39` says the opposite of the routing row: *"Leave escalated work under its live name until the operator is ready for the real teardown."* An agent that follows the routing row tears down a lane a human has not adjudicated. (Also logged under Internal contradictions.)

#### STALE

**4.** SKILL.md:31 —

> `- An escalated run remains the operator's escalation context until its evidence is preserved and a human chooses the next move (#500).`

Behaviour true (`crew/crew.mjs:1879-1885`). The citation is stale-by-kind: `gh issue view 500` → *"skills/crew-dispatch + crew-recovery — the dispatch recipe and recovery playbook move from session memory into the plugin"* (CLOSED). That is the **authoring** issue for this very skill, not a measured incident. It is used as provenance where the file's other citations are evidence. `skills/crew-dispatch/SKILL.md:33` cites #500 the same generic way for an unrelated rule ("Rebase the lane onto `main`"), which is what makes the pattern visible.

**5.** SKILL.md:28 —

> `- Commit the built tree before a hand mutation proof or any `git checkout --` (b73-pane).`

The rule is true (see mutation-proof.md register). The lane citation is stale/mismatched: `b73-pane` is a real branch — `git log --all` → `39ca23c Merge pull request #388 from momoshell/b73-pane`, subject `feat(crew): sample pane seats for provider conditions on the liveness probe cadence`. That PR shipped pane liveness sampling, not anything about a revert trap. The revert-trap incident is not recorded anywhere in this checkout; nothing in-repo ties it to b73-pane.

**6.** SKILL.md:6 + :13 —

> `publish the PR, and tear down only after closeout.` / `suite have been proved, and the PR is published.`

Stale as a routing promise. The description enumerates PR publication as an in-skill intent, but **no `references/` file in `crew-recovery/` carries any PR procedure**: `grep -rn "PR\b|pull request" skills/crew-recovery/` returns only the four prose mentions (SKILL.md:6, :13, :27; closeout.md:3, :22) and zero mechanics. The real procedure is devops-owned — `--body-file` appears only at `skills/devops/SKILL.md:31` and `skills/devops/references/gh.md:3,17`, and `commands/commands.test.mjs:33` pins `--body-file` as skill-owned content whose home is `devops/references/gh.md` (test `the procedure tokens are content the skills actually own`, line 110). The routing table (SKILL.md:17-22) has no PR row.

#### TRUE (compact)

- SKILL.md:26 `Preserve a live state directory by copy … (#512)` — `gh issue view 512` = *"archive-on-escalation breaks cmux session restore: renamed task dir invalidates every seat's prompt-file path"*; its body option 1 is literally *"**Archive by copy, not rename**"*. Apt citation.
- SKILL.md:27 `Teardown is last and belongs in the same turn as the push and PR, never before closeout (b150-permprobe)` — lane real: `gh pr view 519` body, *"Lane `b150-permprobe`, 2026-08-22"*; issue #512 body opens *"Measured today (2026-08-22) on `b150-permprobe` (#506)"*.
- SKILL.md:20 route → `references/mutation-proof.md`, rule "Read planner declarations and commit before any revert" — file exists, matches `crew/drive.mjs:2503-2564`.
- SKILL.md:21 route → `references/liveness.md` — file exists, content verified below.
- SKILL.md:22 route → `references/escalations.md`, "Match the exact emitted token" — file exists; token set verified below (with defects).
- SKILL.md:19 route target `references/closeout.md` exists.
- SKILL.md:35-38 four `Key references` links all resolve: `closeout.md`, `mutation-proof.md`, `liveness.md`, `escalations.md` all present in `skills/crew-recovery/references/`.
- SKILL.md:2 `name: crew-recovery` matches the directory — pinned by `commands/commands.test.mjs:95`.

---

### `skills/crew-recovery/references/closeout.md`

**Checkable claims: 13 — true 9, stale 3, false 1.**

#### FALSE

**1.** closeout.md:35-37 —

> `Only `.archive-` is recognised by status, wait, and the stale reaper:`
> ``ARCHIVE_RE = /\.archive-\d{4}-\d{2}-\d{2}T/`.`

The regex literal is verbatim correct — `scripts/factory/reap-stale.mjs:15`: `export const ARCHIVE_RE = /\.archive-\d{4}-\d{2}-\d{2}T/`. But it is **the stale reaper's regex only**. `status` and `wait` use a bare prefix match with no date shape at all — `crew/crew.mjs:1990-1994`:

```js
function archivedReturn(paths) {
  const base = `${paths.dir.split('/').pop()}.archive-`
  const archives = readdirSync(parent).filter((n) => n.startsWith(base)).sort()
```

consumed by `status` at `crew/crew.mjs:2039` and by `wait` at `crew/crew.mjs:2012`. Consequence for an agent: a hand-made `…​.archive-manual` **is** picked up by `status`/`wait` (prefix matches) but **is not** picked up by the reaper (`isArchived`, reap-stale.mjs:68, needs the `\d{4}-\d{2}-\d{2}T` shape) — the exact opposite of the "one rule, three consumers" the sentence asserts. The document's operative conclusion (`.escalated-…` is invisible to all three) survives; the stated mechanism does not.

#### STALE

**2.** closeout.md:32-33 —

> `The command exits 1 when a seat was not proven dead; do not report a clean teardown`
> `from the archive rename alone.`

Under-states the condition. `crew/crew.mjs:2042`:

```js
if (seats && (seats.proven !== seats.seats || seats.recorded !== seats.seats)) process.exitCode = 1
```

plus `crew/crew.mjs:2044`: `if (d && (d.incomplete > 0 || d.record_failed > 0)) process.exitCode = 1`. So exit 1 also fires when every seat **was** proven dead but a ledger row failed to record, or when descendant reclaim was incomplete. An agent reading exit 1 as "a seat is alive" mis-diagnoses two of the four causes. The source comment at `crew/crew.mjs:2038-2041` names both non-proven outcomes explicitly (`failed` measured-alive and `unproven` unknown), which the doc collapses into one.

**3.** closeout.md:28-29 —

> `Teardown archives by renaming the state directory to`
> ``${paths.dir}.archive-${iso}`.`

Imprecise as written. `crew/crew.mjs:2085`:

```js
const archived = `${paths.dir}.archive-${new Date().toISOString().replace(/[:.]/g, '-')}`
```

The ISO string is **delimiter-sanitised** (`:` and `.` → `-`) before it becomes a path. An operator who reconstructs the name from a raw `${iso}` gets `…archive-2026-08-23T10:30:00.000Z`, which never exists on disk. The `T`-bearing prefix survives, which is why `ARCHIVE_RE` still matches.

**4.** closeout.md:9-11 (the preserve-by-copy recipe) —

```sh
cp -a <state-dir> <state-dir>.recovery-copy
```

Stale against the reaper it shares a parent directory with. `scripts/factory/reap-stale.mjs:94-112` (`candidateTasks`) enumerates **every** directory under `~/.crew/<repo>/`, archived or not, and admits any that has `task/.descendants` — which a `cp -a` copy does, holding duplicate `.active.json` records naming the original lane's live PIDs. The reaper refuses a live root (`classifyRecord`, reap-stale.mjs:139: `if (row.reason === 'root-alive' || row.live > 0) return REAP_VERDICTS.REFUSED_LIVE`), so the copy is not fatal today — but the doc gives no warning, names no exclusion, and `.recovery-copy` appears nowhere in the code (`grep -rn "recovery-copy" .` → only closeout.md:10). The suffix is a convention this document invented and nothing else honours.

#### TRUE (compact)

- closeout.md:3 `an escalated run never auto-tears-down because its live workspace is the escalation context` — `crew/crew.mjs:1885` `if (result.status === 'done' && !args.keep)`; policy comment `crew/crew.mjs:1879-1881`.
- closeout.md:13-16 `Each seat's launch command contains an **absolute** `task/role-<seat>.md` system prompt path, written and read back at boot` — `crew/crew.mjs:1308` `const merged = join(taskDir, \`role-${role}.md\`)` (write) and `crew/crew.mjs:1317` (read back in `paneCommand`); byte-pinned command at `crew/crew.test.mjs:261` carries `--append-system-prompt-file "/tmp/crew-task/role-builder.md"`. `paths.taskDir = join(dir, 'task')` at `crew/crew.mjs:286`.
- closeout.md:16 error string `Append system prompt file not found` — verbatim in the body of issue #512 (`gh issue view 512`, block quoting `cmux restore claude 230f1ea6-…` → `Error: Append system prompt file not found: /Users/x/.crew/dt-b150-permprobe/b150-permprobe/task/role-planner.md`). Not present in this repo's source; external-CLI string, correctly quoted.
- closeout.md:16 `after a live rename, relaunch reported … on both panes` — issue #512 body: *"Both panes came back as bare shells."*
- closeout.md:25 `node crew/crew.mjs teardown --task <slug> --checkout <dir>` — `crew/crew.mjs` `KNOWN_FLAGS.teardown = ['task','checkout']` and `REQUIRED_FLAGS.teardown = ['task']`; flag strings, arity and subcommand all correct.
- closeout.md:29-31 `Its JSON output includes {archived, seats:{seats, proven, failed, …}}` — `crew/crew.mjs:2035-2036`: `const tally = seats ? { seats: seats.seats, proven: seats.proven, failed: seats.failed, unproven: …, recorded: …, record_failed: … } : null` then `process.stdout.write(JSON.stringify({ archived, seats: tally }))`.
- closeout.md:29-31 `archived identifies the archive path` — `crew/crew.mjs:2085-2086`.
- closeout.md:37-38 `A hand rename to `.escalated-…` is invisible to all three` — `.escalated-` fails both `startsWith('<dir>.archive-')` (crew.mjs:1992) and `ARCHIVE_RE` (reap-stale.mjs:15). Issue #512's body records exactly this rename: `…/b150-permprobe.escalated-2026-08-22/`.
- closeout.md:3 closeout order `preserve → commit → prove → suite → push+PR → teardown` — prose ordering, no code counterpart; consistent with `crew/drive.mjs:3226-3236` (suite before commit) and `crew/crew.mjs:1885` (teardown after outcome). Not contradicted.

---

### `skills/crew-recovery/references/escalations.md`

**Checkable claims: 21 (18 table rows + 3 framing claims) — true 15, stale 1, false 5.**

Ground truth, extracted mechanically from `crew/drive.mjs` (regex over `escalate(` call sites, resolving `escalate(variant, …)` against `crew/variants.mjs`), token constructed at `crew/drive.mjs:1934` `stage(\`escalate:${where}\`)`:

```
converge-pr 1754,1763   build 2967,3221        envelope 2055        gate 1650
lane 3010               plan 2240,2338,2350,2354,2366,2397,2402
plan-carve 2284,2286    plan-check 2314        refuted-must-fix 3132,3195
review 3115,3136,3178,3199,3215                scope 2042,2360,2988,2993
sensitivity-floor 2375  suite 3228             triage 2086,2090,2094,2125,2129,2133,2138,2141
triage-scope 2148,2152,2156                    <variant> 2047,2049 (envelope exec) · 2187,2191 (directed)
```

17 emittable tokens. The document lists 18, of which 2 are unreachable and 1 real token is absent.

#### FALSE

**1.** escalations.md:25 —

> `| `escalate:full` | The `full` shape could not complete its reviewed lifecycle. | Preserve the plan, gate, and review records before considering a retry. |`

**This token is never emitted.** The only `escalate(variant, …)` sites are `crew/drive.mjs:2047,2049` — inside `driveEnvelopeShape` (`crew/drive.mjs:1994`), gated at `crew/drive.mjs:2078` by `if (shape.execution === 'envelope')`, and `scout` is the only `VARIANTS` entry with `execution: 'envelope'` (`crew/variants.mjs:20`) — and `crew/drive.mjs:2187,2191` inside `driveDirectedRound` (`crew/drive.mjs:2181`), reached only when `variant === DIRECTED_STAGE_HEAD` (`crew/drive.mjs:2334`). `full` reaches neither. A `full` run escalates under its **stage** token (`plan`, `build`, `lane`, `review`, `gate`, `suite`, `scope`, …). An agent grepping a journal for `escalate:full` finds nothing and concludes the run never escalated.

**2.** escalations.md:27 —

> `| `escalate:repair` | The bounded repair shape returned a failed or malformed seat outcome. | Preserve the inherited failure context and triage note; do not widen repair scope. |`

Same defect. `repair` has `execution: 'reviewed'` (`crew/variants.mjs:32`) so it never enters `driveEnvelopeShape`, and `DIRECTED_STAGE_HEAD !== 'repair'`, so it never enters `driveDirectedRound`. A repair shape's failures emit `escalate:triage` and `escalate:triage-scope` — pinned in the suite at `crew/drive.test.mjs:5001` (`assert.deepEqual(result.details.stages, ['escalate:triage'])`) and `crew/drive.test.mjs:5396` (`for (const label of ['repair:r1', 'escalate:triage', 'done']) …`).

**3.** escalations.md:30-32 —

> `The list is intentionally tied to the source's emitted set. A new driver stage`
> `requires a deliberate documentation and test change; an invented token is not`
> `a useful recovery instruction.`

False on both halves. `escalate:converge-pr` is emitted at `crew/drive.mjs:1754` and `crew/drive.mjs:1763` (multi-line calls, which is why a single-line grep misses them):

```js
return escalate(
  'converge-pr',
  `the work is committed at ${S.commit} but the draft PR could not be opened: ${detail}`,
```

It is reachable: `convergeSettle` (`crew/drive.mjs:1677`) is called at `crew/drive.mjs:3087, 3113, 3134, 3176, 3197`, and its return propagates (`crew/drive.mjs:3087-3088`: `const settled = convergeSettle(…); if (settled) return settled`). This is the token an operator meets when the work **is committed** but the draft PR failed — the highest-stakes recovery state in the file, and it is absent from the table. There is also **no test** pinning it: `grep -rn "converge-pr" crew/` returns only `crew/drive.mjs:1755` and `:1764`, so "requires a deliberate documentation and test change" is not enforced by anything.

**4.** escalations.md:19 —

> `| `escalate:lane` | The lane review or scope decision could not settle the required next move. | Inspect the lane evidence and sibling-fence journal event before reassigning. |`

Both halves wrong. `escalate('lane', …)` has exactly one site, `crew/drive.mjs:3010`, in the **validation-lane** round:

```js
stage(`lane:r${round}`)
const laneRes = io.run(lane)
if (!laneRes.ok) {
  if (finalRound()) {
    const c = consultLead(`The validation lane is still red after ${round} rounds. Bounce once more with guidance, or escalate?`, …)
    if (c.decision !== 'bounce') return escalate('lane', c.reason)
```

"Lane" here is the validation command (`npm test …`), not a crew lane, not a review, not a scope decision. And there is **no sibling-fence journal event to inspect**: a sibling-fence breach emits `escalate:scope`, not `escalate:lane` (`crew/drive.mjs:2360` plan-time, `crew/drive.mjs:2988` build-time, both via `laneFenceHits`/`fenceBreachList`, drive.mjs:1409/1422), and the only `lane-fence` journal event is the **boot register** at `crew/crew.mjs:1780`, written once before any work. An agent following this row hunts a fence event that does not exist while the red test output sits unread.

**5.** escalations.md:26 —

> `| `escalate:scout` | The read-only scout envelope or scope check failed. | Read the scout return and confirm that it made no checkout writes. |`

The named causes emit **other** tokens. In `driveEnvelopeShape` the scope check comes first and emits `escalate:scope` (`crew/drive.mjs:2042`), and an envelope-shape defect emits `escalate:envelope` (`crew/drive.mjs:2055`). `escalate:scout` is emitted only at `crew/drive.mjs:2047` (`seatFailure` — the seat threw or timed out) and `crew/drive.mjs:2049` (`env.status !== 'done'`). Both branches are pinned in the suite: `crew/drive.test.mjs:5758` `assert.equal(result.details.stages.at(-1), 'escalate:scope')` for the wrote-files case, and `crew/drive.test.mjs:5766` `assert.deepEqual(deadResult.details.stages, ['scout:r1', 'scope-gate:r1', 'escalate:scout'])` for the dead-seat case. Correct meaning: *the scout seat failed or returned a non-`done` status.*

#### STALE

**6.** escalations.md:28 —

> `| `escalate:directed` | The orchestrator-authored directed brief is not buildable as supplied. | Validate its one directed block, gate command, and write surface before editing. |`

Covers `crew/drive.mjs:2187` (`parseDirectedBrief` defect) but misses the second emitter, `crew/drive.mjs:2191`:

```js
return { stop: escalate(variant, `a ${variant} run takes its validation lane from the dispatch (--validation-lane) and ctx carries none`) }
```

That is a **dispatch-flag** omission (`--validation-lane` was never passed to `crew.mjs run`), not a brief defect. The stated first move validates the brief and finds nothing wrong.

#### TRUE (compact)

- escalations.md:4 `the four variant-named tokens come from the closed `VARIANTS` set` — `crew/variants.mjs:6` `export const VARIANTS = Object.freeze({ full, scout, repair, directed })`; exactly four keys. (True as stated; only two are reachable — see FALSE 1-2.)
- escalations.md:11 `escalate:scope` — `crew/drive.mjs:2042` (envelope zero-write), `:2360` (plan crosses a sibling fence), `:2988` (build crosses a sibling fence), `:2993` (out-of-scope edits persisted). "declared surface **or** a sibling fence" is exactly right.
- escalations.md:11 first move `git status --porcelain -uall` — the driver's own predicate, `crew/seat-io.mjs:2098`: `execSync('git status --porcelain -uall -z', …)` in `changedFiles()`. Same flags (`-z` is machine framing).
- escalations.md:11 `files_in_scope` — `crew/drive.mjs:2348` `planEnv.details?.files_in_scope`.
- escalations.md:12 `escalate:plan` — 7 sites: lead escalate `:2240`, rounds exhausted `:2338`, no `files_in_scope` `:2350`, bad scope entries `:2354`, no lane `:2366`, bad mutations `:2397`, mutations without a gate `:2402`. "plan, scope, lane, or mutation declaration" enumerates all four.
- escalations.md:13 `escalate:plan-check` — `crew/drive.mjs:2314` `if (c.decision === 'escalate') return escalate('plan-check', c.reason)`, after `assignAndWait('tech-lead', checkBrief, 'plan-check')` at `:2305`.
- escalations.md:14 `escalate:plan-carve` — `crew/drive.mjs:2284` (invalid carve: `if (!carve.verdict)`) and `:2286` (`carve.verdict === 'carve'` → "too large to build whole"). Both halves of the row's meaning are separate real sites.
- escalations.md:14 first move "Keep the slice record" — `crew/drive.mjs:2288` passes `{ carve: { verdict: 'carve', slices: carve.slices, defect } }` into the escalation details.
- escalations.md:15 `escalate:sensitivity-floor` — `crew/drive.mjs:2375`, guarded by `protectedHits(scopeFiles, ctx.protectedPaths)` at `:2371`; message names "could not seat the judge tier's reviewer cell". First move ("boot a judge-tier pane") matches `JUDGE_TIER = 'judge'` at `crew/drive.mjs:129`.
- escalations.md:16 `escalate:triage` — 8 sites `crew/drive.mjs:2086-2141`; `:2086` is literally "inherits the failing run's files_in_scope and ctx carries none", `:2094` the missing `--lane`, `:2129/:2133/:2138` the unusable repair note.
- escalations.md:17 `escalate:triage-scope` — `crew/drive.mjs:2148` (removed scope), `:2156` ("asked to widen the inherited scope"). "remove or widen" is exact.
- escalations.md:18 `escalate:build` — `crew/drive.mjs:2967` (lead escalate at build) and `:3221` (`no accepted build within ${limits.build_rounds + extraRounds} rounds`).
- escalations.md:20 `escalate:review` — `crew/drive.mjs:3115, 3136, 3178, 3199, 3215`; all five are non-converged verdicts / rejected accept-with-residuals.
- escalations.md:21 `escalate:refuted-must-fix` — `crew/drive.mjs:3132` and `:3195`, both `if (settledAccept.refusedMustFix)`; `settleAccept` (`crew/drive.mjs:1948-1970`) computes `refuted_must_fix` and records `accept_decision`.
- escalations.md:22 `escalate:suite` — `crew/drive.mjs:3228` `escalate('suite', \`full suite red after acceptance — this needs eyes:…\`)`. "after an otherwise accepted build" is exact. First move "colour-neutral suite output" corroborated by `colorNeutralEnv` (`crew/seat-io.mjs:1460`).
- escalations.md:23 `escalate:gate` — `crew/drive.mjs:1650` `const gateEscalate = (why, extra) => { gateAttention(…); return escalate('gate', why, extra) }`, 8 call sites `:1671-2731`. First move "inspect the named `FAIL <check>` line" matches `checkFailureLine` (`crew/drive.mjs:1318`).
- escalations.md:24 `escalate:envelope` — `crew/drive.mjs:2055`, message `the ${variant} envelope is not the shape that accepts it [${defect.reason}]`; reasons are the closed `ENVELOPE_REFUSAL_REASONS` set at `crew/drive.mjs:145-147`.

---

### `skills/crew-recovery/references/liveness.md`

**Checkable claims: 9 — true 8, stale 1, false 0.** The strongest file in the family.

#### STALE

**1.** liveness.md:3-4 —

> ``crew.mjs status` answers **alive**, never busy. It reports the crew and`
> `workspace from `seatLiveness`;`

Only the third field comes from `seatLiveness`. `crew/crew.mjs:2044-2045`:

```js
const alive = seatLiveness(crew)
process.stdout.write(`${JSON.stringify({ task: crew.task, workspace_id: crew.workspace_id, alive })}\n`)
```

`task` and `workspace_id` are read off `crew.json` via `loadCrew` (`crew/crew.mjs:2042`); `seatLiveness` (`crew/crew.mjs:2028-2032`) returns only `{ [role]: true|false|null|'headless' }`. The doc also omits the `'headless'` value, which `seatLiveness` returns for any seat with no `surface_id` — an agent expecting a boolean reads a string. Undocumented too: `status` on an archived crew returns a completely different object, `{task, archived: true, task_return}` (`crew/crew.mjs:2039-2040`).

#### TRUE (compact)

- liveness.md:4-5 ``paneAlive` answers only whether cmux still lists the surface` — `crew/seat-io.mjs:1446-1448`: `paneAlive` → `paneProbe(surfaceId, deps).alive`; `paneProbe` (`crew/seat-io.mjs:1436`) is `{ alive: !!locate(t, surfaceId), substrate: 'ok' }` over `tree()`. Literally "does the window tree list it".
- liveness.md:5 `Neither instrument says that a seat is making progress` — true; neither reads the journal or the return.
- liveness.md:9-12 the two `at` shapes — **verified and load-bearing.** Both writers append to the *same file*: `crew/crew.mjs:1642, 1983, 2104` use `at: new Date().toISOString()`; the driver's rows use `io.log({at: io.now()})` and `io.now()` is epoch ms (`crew/seat-io.mjs:1487` `const now = deps.now || (() => Date.now())`, exposed at `crew/seat-io.mjs:2152` `now() { return now() }`). One journal, not two: `crew/crew.mjs:1740` `const journal = join(paths.dir, 'journal.jsonl')` is handed to the driver as `ctx.journal` at `crew/crew.mjs:1794`, and `crew/drive.mjs:1446` confirms `// journal: <real journal.jsonl path (lives in the CREW dir)>`.
- liveness.md:11-12 `A recency script that accepts only ISO silently skips the driver rows that move during a build` — follows directly: every `stage()` row is a driver row (`crew/drive.mjs:1573` `io.log({ at: io.now(), stage: label })`), so ISO-only parsing drops exactly the rows that indicate progress.
- liveness.md:14-16 ``returns/task.json`'s `details.envelope.fields` records only **WHICH FIELDS** an envelope carried` — `crew/drive.mjs:2074` `envelope: { seat, fields: observedFields, files_changed: 0 }` where `observedFields = envelopeFieldsPresent(env, shape)`, and `envelopeFieldsPresent` (`crew/drive.mjs`, definition) is `(shape?.envelope_fields || []).map((field) => field?.name).filter((name) => hasField(details, name))` — names only, values discarded.
- liveness.md:17-19 `open the seat's own `returns/d1.planner.json`` — path shape verified at `crew/seat-io.mjs:1721-1723`: `seq += 1; id = \`d${seq}\`; const returnPath = join(paths.returnsDir, \`${id}.${role}.json\`)`. `seq` starts at 0 (`crew/seat-io.mjs:1498`), so the first planner dispatch is exactly `d1.planner.json`.
- liveness.md:19 `details.findings` — `crew/variants.mjs:26`, scout's `envelope_fields` is `[{ name: 'findings', kind: 'records', item_fields: ['summary','evidence'] }]`.
- liveness.md:19 `details.mutations` — `crew/drive.mjs:2392` `const declared = planEnv.details?.mutations`.
- liveness.md:23-27 `re-derive it **a second way**` / `unknown—not proof of idle, death, or failure` — matches the code's own tri-state discipline: `paneAlive` returns `null` for indeterminate (`crew/seat-io.mjs:1446` comment `// true | false | null (indeterminate)`), and the reclaim path counts `unproven` separately from `failed` (`scripts/factory/reap-stale.mjs:74` `REAP_ACCOUNTING = ['proven','failed','unproven']`, with `// (#473)` — *"a process that could not be PROVEN dead is reported unproven, never assumed dead"*).

---

### `skills/crew-recovery/references/mutation-proof.md`

**Checkable claims: 12 — true 8, stale 2, false 2.**

#### FALSE

**1.** mutation-proof.md:37 —

> `FORCE_COLOR=0 npm test | grep -E '^(pass|fail|GATE-SUMMARY)'`

**Measured on this checkout: this command prints nothing.** `package.json:8` → `"test": "node --test --test-timeout=30000"`. Node's summary lines carry a leading `ℹ ` glyph, so the `^` anchor never matches:

```
$ FORCE_COLOR=0 node --test --test-timeout=30000 commands/commands.test.mjs | grep -E '^(pass|fail|GATE-SUMMARY)'
(no output, exit 1)

$ FORCE_COLOR=0 node --test --test-timeout=30000 commands/commands.test.mjs | grep -E '(pass|fail) [0-9]+'
ℹ pass 8
ℹ fail 0
```

`FORCE_COLOR=0` is necessary but **not sufficient** — the doc treats it as sufficient and keeps the anchor that breaks it. `crew/seat-io.mjs:1450-1452` documents the very glyph (`// reads "\x1b[34mℹ pass 965\x1b[39m"`). The repo's own correct rule is one skill over, `skills/qa-test-writing/references/tooling.md:29`: *"Prefix suite greps with `FORCE_COLOR=0`, **or** drop the `^` anchor."* An agent following mutation-proof.md reads an empty grep as "no result" — the exact mis-read `skills/qa-test-writing/references/tooling.md:30-31` warns about. `GATE-SUMMARY` is also not a suite line at all; it is a gate line (`crew/drive.mjs:325 GATE_SUMMARY_PREFIX`).

**2.** mutation-proof.md:36 —

> `FORCE_COLOR=0 node <gate-command> | grep -E '^(ok|FAIL|GATE-SUMMARY)'`

`node` is prefixed onto something that already carries it. A gate command **is** the whole invocation: `crew/roles/planner.md:105-107` — *"return it as details.gate_cmd: a single command (e.g. `node <taskDir>/gate.mjs`)"* — and the driver runs the string as-is (`crew/drive.mjs:1650` region, `runGate(name, gateCmd)`). Substituting the declared `gate_cmd` yields `node node /…/gate.mjs`, which fails to resolve. Separately, `ok` is not part of any gate output contract: the contract is `FAIL <check>` (`crew/roles/planner.md:180`, `crew/drive.mjs:1318`) and `GATE-SUMMARY {…}` (`crew/roles/planner.md:115`, `crew/drive.mjs:325`) — nothing requires an `ok` line.

#### STALE

**3.** mutation-proof.md:40-42 —

> `A survivor is not a pass: record whether the mutation was killed, survived,`
> `unapplied, or interrupted, …`

Three of four names are the code's; the enumeration is incomplete and mixes two levels. Per-mutation `outcome` values in `crew/drive.mjs:2503-2551` are **`exempt`** (`:2512`), `unapplied` (`:2523`), and `survived`/`killed` (`:2549`). `exempt` is missing from the doc and is a real declared outcome (`validateMutations` accepts `{check, exempt}` entries — `crew/drive.mjs`, `an exemption declares no mutation`). "Interrupted" is not an outcome at all; interruption is recorded one level up as the run **verdict** `unproven` — `crew/drive.mjs:2561`: `checkProofVerdict = survivor ? 'failed' : checkProofNote ? 'unproven' : 'proven'`.

**4.** mutation-proof.md:32-33 —

> `When inspecting gate or suite output, suppress the harness colour layer first;`
> `any grep must be prefixed with `FORCE_COLOR=0`:`

Stale as a universal ("any grep must"). It is true for a **hand-run** command, but not for driver-spawned ones: `crew/seat-io.mjs:1460-1466` (`colorNeutralEnv`) already deletes `FORCE_COLOR` and `CLICOLOR_FORCE` and sets `NO_COLOR=1` in every child env the driver spawns, *"so every gate ever authored is covered and no gate bytes change"* (`crew/seat-io.mjs:1447-1457`, `#240`). The rule's scope — the operator's own shell, not the crew's — is never stated.

#### TRUE (compact)

- mutation-proof.md:4-7 `commit the built tree **before** any `git checkout -- <file>`` … `on an escalated lane, `HEAD` may still be the pre-lane commit` — `crew/drive.mjs:3230-3235`: `stage('commit')` runs only after suite-green, so an escalated run reaches no `io.commit` and `HEAD` is untouched. The rule follows from the code.
- mutation-proof.md:10-12 declarations come from `returns/d1.planner.json` → `details.mutations`, never `plan.md` — `crew/drive.mjs:2392` `const declared = planEnv.details?.mutations`; `plan.md` is only `planEnv.details?.plan_path` (`crew/drive.mjs:2340`) and is never parsed for mutations.
- mutation-proof.md:13 `machine-applied `{check, file, find, replace}` records` — `validateMutations` (`crew/drive.mjs`) requires non-empty `check` matching `CHECK_LABEL`, non-empty `file` inside `files_in_scope`, non-empty literal `find`, string `replace`, and refuses `find === replace`.
- mutation-proof.md:14 `plan prose explains intent but is not the source the driver applies` — corroborated by `crew/guidelines/seat-pre-return-checklist.md:77` and `crew/roles/planner.md:162-166` ("refused if it is prose").
- mutation-proof.md:18-19 `A mutation kills its check only when the output matches the driver's `checkFailureLine` rule: a bare `FAIL <check>` line or `FAIL <check>:` followed by a delimiter-safe reason` — verbatim the implementation, `crew/drive.mjs:1318-1329`: `if (line === want) return true` / `if (!line.startsWith(\`${want}:\`)) return false` / `return rest.length === 0 || /^\s/.test(rest)`. Consumed at `crew/drive.mjs:2540`.
- mutation-proof.md:20-21 ``FAIL cache-v2` must not credit `cache`` — holds under `checkFailureLine`: `want = 'FAIL cache'`, the line is neither equal to it nor starts with `'FAIL cache:'`, so it returns false. Rationale pinned at `crew/drive.mjs:1332-1334` (`#330`, `#387`).
- mutation-proof.md:21 `a longer label must not be mistaken for the named check` — `CHECK_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/` (`crew/drive.mjs:1317`) plus the colon-only delimiter rule.
- mutation-proof.md:24-26 ``completeCheckProof` mutates the built tree **in place**, runs the gate, and restores the exact original in a `finally`` — `crew/drive.mjs:2503` `const completeCheckProof = (label) => {`, and `:2530-2534`:
  ```js
  io.writeFile(abs, original.replaceAll(mutation.find, mutation.replace))
  res = runGate(mutationLabel(label, index), gateCmd)
  } finally { io.writeFile(abs, original) }
  ```
- mutation-proof.md:26-28 `a manual `git checkout --` restores `HEAD`, not the uncommitted build` — true by git semantics; the driver's own restore is byte-checked at `crew/drive.mjs:2570-2577` (`dirtyAfterFailure`, one whole-string compare).

---

### `commands/dispatch.md`

**Checkable claims: 5 — true 5.**

- `argument-hint: <issue-number-or-request>` present and `$ARGUMENTS` in the body — pinned by `commands/commands.test.mjs:66-72`.
- Names the `crew-dispatch` skill — pinned by `commands/commands.test.mjs:82-87` (`DISPATCHES_TO['dispatch.md'] = ['crew-dispatch']`).
- `skills/crew-dispatch/SKILL.md` exists and declares `name: crew-dispatch` (`skills/crew-dispatch/SKILL.md:2`) — pinned by `commands/commands.test.mjs:89-98`.
- Body restates no `PROCEDURE_TOKENS` — pinned by `commands/commands.test.mjs:100-108`; verified by reading (10 lines, no flags).
- Frontmatter `description` present — pinned by `commands/commands.test.mjs:58-64`.

### `commands/close-out.md`

**Checkable claims: 5 — true 5.** Same five, against `crew-recovery`: `DISPATCHES_TO['close-out.md'] = ['crew-recovery']` (`commands/commands.test.mjs:17`), `skills/crew-recovery/SKILL.md:2` declares `name: crew-recovery`, `argument-hint: <lane-name>` + `$ARGUMENTS` present.

### `commands/status.md`

**Checkable claims: 7 — true 5, stale 0, false 2.**

#### FALSE

**1.** status.md:2 (frontmatter `description`) —

> `description: Report factory and crew state read-only — worktrees, lanes, PRs, orphans, and the suite baseline.`

**"the suite baseline" is owned by neither named skill.** `grep -rn "baseline" skills/devops/ skills/crew-recovery/` returns zero hits. The suite baseline is `skills/qa-test-writing/` territory — `skills/qa-test-writing/references/tooling.md:46` (*"Only a detached worktree reproduces the real baseline"*, with the measured `2084/0` at `references/vacuity.md:31`) and `skills/qa-test-writing/SKILL.md:33`. `commands/status.md` never names `qa-test-writing`, so the command promises a report no routed skill can produce; `commands/commands.test.mjs` does not catch this because it only asserts that named skills exist (`:89-98`), never that described capabilities are covered.

**2.** status.md:8-10 —

> `Load the `devops` skill (`skills/devops/SKILL.md`) for worktrees, pull requests`
> `and orphans, and the `crew-recovery` skill (`skills/crew-recovery/SKILL.md`) for`
> `lane state.`

Routing a **read-only** command into `crew-recovery` mis-routes: the skill's stated purpose is mutating closeout. `skills/crew-recovery/SKILL.md:11-13` — *"Recovery is evidence-preserving closeout… Keep the live state available until the built tree is **committed**, the gate mutations and suite have been **proved**, and the PR is **published**."* Four of its six critical rules (`:26, :27, :28, :31`) instruct writes (copy, teardown, commit, `git checkout --`), and three of its four routing rows lead to write procedures (`:19` teardown, `:20` mutation proof, `:22` escalation moves). Only `references/liveness.md` — one of four files, 27 of 140 reference lines — is read-only. `commands/commands.test.mjs:124-131` polices the *command's own* text for mutating tokens but never checks the skill it loads, so `status.md` passes the test while handing the agent a mutation playbook.

#### TRUE (compact)

- No `argument-hint`, no `$ARGUMENTS`/`$1`/`$2` — pinned by `commands/commands.test.mjs:74-80`.
- Body says `read-only` — pinned by `commands/commands.test.mjs:131`.
- Command text carries no whole-word `teardown|push|commit|boot|kill|delete` — pinned by `commands/commands.test.mjs:124-130`.
- Names both `devops` and `crew-recovery` — pinned by `commands/commands.test.mjs:18, 82-87`; both `SKILL.md` files exist and declare matching `name:` (`skills/devops/SKILL.md:2`, `skills/crew-recovery/SKILL.md:2`).
- "worktrees, PRs, orphans" → devops routes exist: `skills/devops/SKILL.md:20` (`references/worktrees.md`), `:21-22` (`references/gh.md`, `references/lane-branches.md`), `:23` (`references/processes.md`). All five reference files present.

---

## Command description vs skill behaviour

| Command | Description (verbatim) | Routes to | Verdict |
|---|---|---|---|
| `commands/dispatch.md` | `Dispatch a crew lane for an issue or a request.` | `crew-dispatch` — `skills/crew-dispatch/SKILL.md:3-6`: *"Load when dispatching a crew lane: choosing a variant, preparing its worktree, compiling and verifying fences, selecting tier, or writing boot and run flags that must execute against the current CLI."* | **MATCH.** The skill's five routing rows (`SKILL.md:19-23`) are all dispatch mechanics; the command narrows to the trigger and passes `$ARGUMENTS`. "for an issue or a request" is covered by `references/variants.md` trigger selection. |
| `commands/close-out.md` | `Close out a crew lane by name.` | `crew-recovery` — `skills/crew-recovery/SKILL.md:4-6`: *"Load when recovering, proving, closing, or diagnosing a crew lane: preserve its state, interpret liveness and escalation stages, run mutation proof, publish the PR, and tear down only after closeout."* | **MATCH, with one gap.** "closing" is explicitly in the skill's trigger surface. Gap: the skill promises *"publish the PR"* but carries no PR procedure (`grep -rn "PR\b\|pull request" skills/crew-recovery/` → 5 prose mentions, 0 mechanics; `--body-file` lives only in `skills/devops/references/gh.md:3,17`). `close-out.md` names no second skill, so following it to completion is impossible without a route the skill does not provide. |
| `commands/status.md` | `Report factory and crew state read-only — worktrees, lanes, PRs, orphans, and the suite baseline.` | `devops` (`skills/devops/SKILL.md:3-10`) **and** `crew-recovery` (`skills/crew-recovery/SKILL.md:4-6`) | **MISMATCH ×2.** (a) *"the suite baseline"* is in neither skill — zero `baseline` hits in `skills/devops/` or `skills/crew-recovery/`; it lives in `skills/qa-test-writing/references/tooling.md:46` and `references/vacuity.md:31`, a skill this command never names. (b) The command declares *"This command authorizes no change of any kind"* (`status.md:12`) while loading a skill whose own opening is *"Recovery is evidence-preserving **closeout**"* (`crew-recovery/SKILL.md:11`) and whose critical rules instruct copy, commit, `git checkout --` and teardown (`:26-31`). `devops` is a clean match for worktrees/PRs/orphans (`SKILL.md:20-23`); `crew-recovery` should be narrowed to `references/liveness.md`, the only read-only file in it. |

---

## Format compliance — `skills/crew-recovery/SKILL.md` (epic #497 rules)

Epic #497 confirmed OPEN: `gh issue view 497` → *"Epic: plugin skills & agent surface — ship the operating knowledge as skills/, commands/, and charter quality"*.

| Rule | Verdict | Line | Evidence |
|---|---|---|---|
| **R1** Description = trigger surface | **FAIL** | `:3-6` | Over-claims one intent and under-claims another. It advertises *"publish the PR"* (`:6`) with no PR content anywhere under `skills/crew-recovery/` (`--body-file` is `devops`-owned, `skills/devops/references/gh.md:3`). It omits the intents the file actually serves: reading a journal's timestamp shapes, reading a per-seat return, and — the highest-value one — deciding whether an exit-1 teardown means a live seat. Nothing in the description says "read a run's results", so the skill will not load for that intent. |
| **R2** Routing table up front | **PASS** | `:15-22` | Table is the first section after the intro, three columns (`Doing… / Read / Rule`), and all four `references/<file>.md` targets resolve: `closeout.md`, `mutation-proof.md`, `liveness.md`, `escalations.md`. One structural gap, not a rule violation: there is no row for the `publish the PR` intent the description promises. |
| **R3** Imperatives carrying the reason AND a named exception | **FAIL** | `:26-31` | Six rules, **zero named exceptions**, and only issue/lane citations where reasons belong. `:26` *"Preserve a live state directory by copy before any recovery experiment; this is the preserve-by-copy rule (#512)"* — names itself instead of giving a reason. `:28` *"Commit the built tree before a hand mutation proof or any `git checkout --` (b73-pane)"* — no reason, no exception. The ratified shape is in this repo twice over: `skills/devops/SKILL.md:29-34` where every rule ends `Cost: <reason>`, and `crew/roles/builder.md:21` *"…make them green BEFORE returning. **The exception:** a lane you cannot run at all is `insufficient` naming why"* and `:24` *"Commit nothing — **because** the driver commits only after the scope gate…"* (shipped by PR #517, `docs(crew): trigger-shaped charter openings, rules with reasons and named exceptions`). `crew-recovery` follows neither. |
| **R4** Progressive disclosure | **PASS** | whole file | SKILL.md is 38 lines against 140 lines of references (39/32/27/42). No reference content is duplicated up into SKILL.md; the routing table points rather than restates. Comfortably the smallest surface in the family. |
| **R5** Posture declared | **FAIL** | `:11-13` | Never names retrieval-first vs measurement-first. `:11` *"Recovery is evidence-preserving closeout, not cleanup by instinct"* gestures at a posture but does not declare one, and the file is in fact **both**: `references/escalations.md` is pure retrieval (match the emitted token in a table) while `references/liveness.md:23-25` is emphatically measurement-first (*"re-derive it **a second way** before killing, reassigning, or tearing down a seat"*). An agent cannot tell from SKILL.md which mode it is in. Contrast `skills/crew-dispatch/SKILL.md:11-13`, which at least states its stance ("measured failure modes that make a parsed brief or a green-looking dispatch insufficient evidence"). |
| **R6** Boundary declared (optional orchestrator procedure, not seat behaviour; seats boot `--no-skills`) | **FAIL** | absent | The boundary is stated **nowhere** in the file — no line says this is an orchestrator-session procedure. The omission is load-bearing here because the premise is itself only half true on this checkout: `--no-skills` is emitted by the **pi** adapter (`crew/adapters/adapter-pi.mjs:253`: `...(skills.length ? skills.flatMap(…) : ['--no-skills'])`) and the headless-RPC transport (`crew/headless-rpc.mjs:84`), but **not** by the claude adapter — the byte-identity-pinned pane command at `crew/crew.test.mjs:261` carries no such flag, and `crew/adapters/adapter-claude.mjs:66-68` only *refuses* skill grants (`refusing to boot a silently weaker seat [grant-unsupported]`) rather than disabling skills. A claude pane seat therefore boots with skills reachable, and this file — whose rules instruct commits, teardowns and `git checkout --` — never says it is not for them. |

**Score: 2 pass / 4 fail.**

---

## Internal contradictions

**1. Teardown of an escalated lane — instructed and forbidden.**

> `skills/crew-recovery/SKILL.md:19` — `| Closing a converged or escalated lane | `references/closeout.md` | Preserve, commit, prove, publish, then **teardown last**. |`

> `skills/crew-recovery/references/closeout.md:38-39` — *"**Leave escalated work under its live name until the operator is ready for the real teardown.**"*

Same situation (an escalated lane), opposite terminal step. `SKILL.md:31` sides with `closeout.md` (*"until its evidence is preserved and **a human chooses the next move**"*), and so does the code (`crew/crew.mjs:1885` `if (result.status === 'done' && !args.keep)`; policy comment `:1879-1881` `escalation -> NEVER teardown`). The routing table is the single dissenting line, and it is the line an agent reads first.

**2. `FORCE_COLOR=0` sufficient vs. insufficient.**

> `skills/crew-recovery/references/mutation-proof.md:33` — *"any grep must be prefixed with `FORCE_COLOR=0`:"* followed by `:37` `FORCE_COLOR=0 npm test | grep -E '^(pass|fail|GATE-SUMMARY)'`

> `skills/qa-test-writing/references/tooling.md:29` — *"Prefix suite greps with `FORCE_COLOR=0`, **or** drop the `^` anchor."*

Two skills, one situation (parsing `npm test` output), incompatible advice. Measured above: the `crew-recovery` form prints nothing on this checkout. `tooling.md:30-31` then names the failure the other file walks into — *"An empty grep result on a pipe is **suspect decoration** until proven otherwise."*

**3. Where the journal lives.**

> `skills/crew-recovery/references/liveness.md:7-9` — *"Classify an **idle-alive** versus **busy-alive** seat from recent rows in `journal.jsonl`"* (no path; its dual-shape claim is only coherent if there is **one** journal).

> `skills/qa-test-writing/references/tooling.md:81-82` — *"The journal is `journal.jsonl` **in the task dir**; the boot journal is one level up, beside `crew.json`."*

The code has one journal and it is not in the task dir: `crew/crew.mjs:1518, 1642, 1740, 1983, 2104` all write `join(paths.dir, 'journal.jsonl')`, where `paths.taskDir = join(dir, 'task')` (`crew/crew.mjs:286`), and that same path is handed to the driver as `ctx.journal` (`crew/crew.mjs:1794`), confirmed by `crew/drive.mjs:1446` (`// journal: <real journal.jsonl path (lives in the CREW dir)>`). An agent following `tooling.md` looks in `task/`, finds nothing, and cannot perform `liveness.md`'s procedure at all. (`crew/drive.mjs:1482` `ctx.journal || art('journal.jsonl')` is a test-only fallback that never fires in a real run.)

**4. `status` is read-only vs. `crew-recovery` is closeout.** Covered in the description table: `commands/status.md:12` (*"This command authorizes no change of any kind"*) against `skills/crew-recovery/SKILL.md:11-13` and `:26-31`.

---

## Overlap

| Duplicated content | Copies | Proposed single home |
|---|---|---|
| The `returns/task.json` roll-up records only *which fields*; scout findings live in `returns/d1.planner.json` | `skills/crew-recovery/references/liveness.md:14-19` and `skills/qa-test-writing/references/tooling.md:76-80` (*"A driver run's roll-up is `returns/task.json`, but it records only **which fields** a seat envelope carried"* / *"**Scout findings live in `returns/d1.planner.json`**, not `task.json`"*) | **`crew-recovery/references/liveness.md`** — it is the run-forensics file, and it is the more precise of the two (it names `details.envelope.fields`, `details.findings`, `details.mutations`). `tooling.md` should link, not restate. |
| "Re-derive a surprising measurement a second way" | `skills/crew-recovery/references/liveness.md:21-27` (*"If one instrument lies or a measurement is surprising, re-derive it **a second way**"*) and `skills/qa-test-writing/references/tooling.md:84-90` (*"If a number surprises you, get it a second way before acting on it"*, with the five measured failures) | **`skills/qa-test-writing/references/tooling.md`** — it carries the measured incident list. `liveness.md` keeps only the seat-specific application (status vs pane vs journal). |
| The `FORCE_COLOR` / ANSI rule | `skills/crew-recovery/references/mutation-proof.md:32-38`, `skills/qa-test-writing/references/tooling.md:25-31`, `skills/qa-test-writing/references/gates.md:33`, `skills/qa-test-writing/references/vacuity.md:20-22`, `skills/qa-test-writing/SKILL.md:33` | **`skills/qa-test-writing/references/tooling.md:25-31`** — the only copy that states the rule correctly (`FORCE_COLOR=0` **or** drop the anchor) and cites #240. The `mutation-proof.md` copy is a wrong fork and should be deleted in favour of a pointer. |
| The `FAIL <check>` label/delimiter contract | `skills/crew-recovery/references/mutation-proof.md:18-21`, `crew/roles/planner.md:180`, `crew/guidelines/seat-pre-return-checklist.md:77`, `crew/drive.mjs:1314-1338` (comment) | **`crew/drive.mjs:1314-1338`** is the executable definition; the charter (`crew/roles/planner.md:180`) is the seat-facing copy. `mutation-proof.md` is the operator-facing third copy and is the one that will drift — it already omits the `checkLabelMisdelimited` diagnosis (`crew/drive.mjs:1331-1348`) that tells a reader *why* a printed label was rejected, which is precisely what a hand proof needs. |
| Teardown / archive lifecycle | `skills/crew-recovery/references/closeout.md:21-39`, `crew/README.md:301-306` (*"`done` → archive the crew dir + close the workspace (`--keep` to inspect); `escalation` → the workspace always survives"*), `skills/devops/SKILL.md:29` | **`crew-recovery/references/closeout.md`** for the operator procedure. Two facts should migrate *into* it from `crew/README.md:301-306`, because they change what an operator does and appear in neither: **`--keep`** (a `done` run left live on purpose is not an escalation) and the **park mint** — an escalation *"mints a `parked/null` park under `~/.crew/<repo>/<task>/reclaim/parks/`"* (`crew/crew.mjs:1375` `mintPark({ run_id, seats, reason })`; failure logged as `park-mint-failed`, `crew/crew.mjs:1859`). `crew-recovery` never mentions parks, so its closeout leaves an artifact the operator does not know exists. |

---

## What `commands.test.mjs` pins

Measured green on this checkout: `FORCE_COLOR=0 node --test --test-timeout=30000 commands/commands.test.mjs` → `pass 8 / fail 0`.

**Pinned (a false claim would break the suite):**

| Claim | Test | Line |
|---|---|---|
| All three command files exist and open with a frontmatter block | `parts()` | `:42-46` |
| Every command declares a `description` and a non-empty body | `every command carries the frontmatter Claude Code reads` | `:58-64` |
| `dispatch.md` and `close-out.md` declare an `argument-hint` and contain `$ARGUMENTS` | `argument-taking commands declare a hint and pass the argument through` | `:66-72` |
| `status.md` declares no `argument-hint` and references no `$ARGUMENTS`/`$1`/`$2` | `the status command takes no argument` | `:74-80` |
| `dispatch.md` names `crew-dispatch`; `close-out.md` names `crew-recovery`; `status.md` names both `devops` and `crew-recovery` | `each command names the skill it dispatches to` + `DISPATCHES_TO` | `:15-19, 82-87` |
| Every skill a command names has a `SKILL.md` whose frontmatter `name:` equals that directory | `every skill a command names exists and declares that name` | `:89-98` |
| No command body or frontmatter contains `--fences`, `--tier`, `--validation-lane`, `KNOWN_FLAGS`, `crew.mjs teardown`, `cp -a`, `.archive-`, `git worktree remove`, `--body-file` | `no command body restates procedure content the skills own` | `:24-34, 100-108` |
| Each of those nine tokens really is skill-owned (anti-vacuity) | `the procedure tokens are content the skills actually own` | `:110-122` — verified by hand: `KNOWN_FLAGS`→`crew-dispatch/SKILL.md:20`; `--fences`→`crew-dispatch/SKILL.md:28`; `--tier`→`crew-dispatch/SKILL.md:29`; `--validation-lane`→`crew-dispatch/references/flags.md:31`; `crew.mjs teardown`→`crew-recovery/references/closeout.md:25`; `cp -a`→`closeout.md:10`; `.archive-`→`closeout.md:29`; `git worktree remove`→`devops/SKILL.md:29`; `--body-file`→`devops/SKILL.md:31` |
| `status.md` contains no whole-word `teardown`, `push`, `commit`, `boot`, `kill`, `delete`, and does say `read-only` | `the status command authorizes no mutation` | `:36-38, 124-132` |

**NOT pinned — pure prose, and where the register's findings sit:**

- **Every claim in `skills/crew-recovery/**`.** The corpus at `:110-122` is read only to prove nine substrings *exist somewhere*; nothing checks a single file:line, flag, enum member, escalation token, or measured number. All 3 false + 2 stale claims in `escalations.md` and both false commands in `mutation-proof.md` pass this suite untouched.
- **Whether a command's `description` matches what its skill does.** The test asserts the named skill *exists*, never that it covers the described intent — which is why `status.md`'s *"the suite baseline"* (owned by `qa-test-writing`, a skill it never names) is invisible here.
- **Whether the loaded skill is itself read-only.** `MUTATING_TOKENS` (`:38`) scans `status.md`'s own 13 lines only. `crew-recovery/SKILL.md:26-31` instructs copy/commit/checkout/teardown and is never examined, so the read-only command loads a mutation playbook with the suite green.
- **The completeness of `escalations.md` against `crew/drive.mjs`.** Nothing greps the driver's `escalate(` sites. `escalate:converge-pr` (`crew/drive.mjs:1754, 1763`) is undocumented *and* untested — `grep -rn "converge-pr" crew/` returns only those two source lines — so `escalations.md:30-31`'s *"A new driver stage requires a deliberate documentation and test change"* is enforced by nothing.
- **Format compliance R1-R6.** No test reads any `SKILL.md` beyond its `name:` field (`:94-95`).
- **Whether reference links resolve.** `commands.test.mjs:115` hard-codes four reference paths for the anti-vacuity corpus; the `Key references` links in `crew-recovery/SKILL.md:35-38` are unchecked (they do resolve — verified by hand).
- **Whether shell snippets run.** `mutation-proof.md:36-37` are code fences no test executes.
