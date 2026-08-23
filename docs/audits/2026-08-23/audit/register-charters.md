# Register: crew/roles/ charters (planner-authored section)

Checkout `/Users/x/Development/dt-s3-prose`, branch `audit-s3-prose`, HEAD `5a8d76a`.
All evidence below was re-derived on this checkout; no verdict is carried from prior belief.

## Files read in full

| file | lines |
|---|---|
| crew/roles/_shared.md | 66 |
| crew/roles/builder.md | 49 |
| crew/roles/lead.md | 113 |
| crew/roles/planner.md | 199 |
| crew/roles/reviewer.md | 75 |
| crew/roles/tech-lead.md | 45 |

Registers read in full for the comparison: `crew/roster.json`, `crew/capabilities.json`.
Code read for verification: `crew/drive.mjs` (3250 lines, targeted), `crew/crew.mjs`
(`SEAT_DEFAULTS`, `effectiveTools`, boot brief), `crew/capabilities.mjs`,
`crew/adapters/adapter-pi.mjs`, `crew/adapters/adapter-claude.mjs`,
`scripts/factory/make-brief.mjs`, `crew/drive.test.mjs`, `test/factory-make-brief.test.mjs`,
`test/factory-ledger-floor.test.mjs`, `crew/factoryctl.test.mjs`, `crew/crew.test.mjs`.

---

## Per-document register

### crew/roles/_shared.md — 9 checkable claims: 8 true, 0 stale, 1 stale-shape

**true**

| claim (file:line) | evidence |
|---|---|
| `:12` boot reply is exactly `ready: <your-role>` | `crew/crew.mjs:1550` boot brief: *"reply exactly ready: your-role, then wait"*; `crew/crew.mjs:1899` comments the literal |
| `:29` status enum `done \| insufficient \| blocked` | `crew/drive.mjs:1912` branches on `env.status !== 'done'`; `insufficient`/`blocked` handled at the bounce sites |
| `:45-46` questions shape `{"id","question"}` | `crew/drive.mjs:867-872` `details?.questions`; `crew/drive.mjs:1009-1012` reads `entry?.id` / `entry?.question` |
| `:48` "at most 10 questions per envelope" | `crew/drive.mjs:833` `export const MAX_QUESTIONS = 10`; enforced `:907-908` |
| `:51-52` "Malformed entries are dropped and reported" | `crew/drive.mjs:908` pushes to `rejected`; logged as `member_questions.rejected` at `:2234`, `:2961` |
| `:52-53` "Only the planner's and the builder's status returns consume this field today" | the only two consumers are `crew/drive.mjs:2233` (`role: 'planner'`) and `crew/drive.mjs:2960` (`role: 'builder'`) — exhaustive grep of `details?.questions` |
| `:60-61` artifacts are absolute paths, a file not listed does not exist to the crew | `crew/drive.mjs` reads `env.artifacts` only; nothing scans the task dir |
| `:63` "only the builder edits repo files" | `crew/crew.mjs:113-118` `SEAT_DEFAULTS`: builder alone carries `Edit` in `tools`; every other seat carries `Edit` in `deny`. Pinned by `crew/crew.test.mjs:217-220` |

**stale-shape (1)**

> `_shared.md:3-5` — "You are one **pane** of a small crew working ONE task in a cmux
> workspace. The orchestrator (a separate session) drives you by **typing assignments
> into this pane**."

Evidence: a seat is no longer necessarily a pane. `crew/headless.mjs` and
`crew/headless-rpc.mjs` run seats as headless workers —
`crew/headless-rpc.mjs:84` composes `--no-context-files --no-extensions --no-skills`
with no pane at all, and `crew/crew.mjs:125-128` comments that
*"crew/headless.mjs rebuilds a headless worker command from members.<role>.tools alone"*.
The assignment loop the paragraph describes is correct; the transport it asserts is one
of two. Consequence is low (a seat behaves identically either way), which is why this is
stale rather than false — but a seat reasoning about "the other panes" in a headless run
is reasoning about something that does not exist.

---

### crew/roles/builder.md — 11 checkable claims: 8 true, 3 stale

**true**

| claim (file:line) | evidence |
|---|---|
| `:18` "The orchestrator diffs your changes against the plan — out-of-plan edits bounce" | `crew/drive.mjs` scope gate; stage name `escalate:${where}` at `:1934`, `escalate:scope` asserted in `crew/drive.test.mjs:5758` |
| `:24` "Commit nothing … the orchestrator owns git" | no seat path commits; the driver commits after the scope gate + lane + suite |
| `:28` `details.files_changed` | read at `crew/drive.mjs:2064`, `:2074` (envelope journal) |
| `:29` `details.validation` | the lane itself is re-run by the driver; the field is recorded, not trusted |
| `:30` `details.commit_message` "the orchestrator uses it as the commit body" | `crew/drive.mjs:1429` `String(builderEnv?.details?.commit_message \|\| builderEnv?.summary \|\| '')` — used as the body, exactly as claimed |
| `:33` "the subject comes from the plan" | the planner's `commit_subject` (`crew/drive.mjs`, 7 sites) supplies the subject |
| `:38` `crew/guidelines/seat-pre-return-checklist.md` exists and defines B1–B3 | `crew/guidelines/seat-pre-return-checklist.md:24` (**B1**), `:34` (**B2**), `:42` (**B3**) — ids match the charter's citation exactly |
| `:45-48` the three families restated match B1–B3's own headings | B1 "every new error path answers EPERM, unknown, interrupted and empty"; B2 "nothing you record is stronger than what you measured"; B3 "the plan's lane ran green on the tree you are returning" — verbatim agreement |

**stale (3)** — all in one sentence, `builder.md:41-44`:

> "Measured over **164 archived lanes**, **43%** of first reviews bounce, and the two
> biggest classifiable must-fix families — unhandled edge paths (**19%**) and
> over-claimed verdicts (**13%**) — are both visible in your own diff."

Re-measured today against the ledger the factory actually writes
(`~/.dev-team/factory/ledger.db`, table `review_outcomes`, read-only):

```
sqlite3 -readonly ledger.db "select count(distinct adw_id) from review_outcomes;"          -> 204
sqlite3 -readonly ledger.db "with f as (select adw_id, verdict,
  row_number() over (partition by adw_id order by created_at, id) rn
  from review_outcomes) select verdict, count(*) from f where rn=1 group by 1;"
  -> changes-needed|73   pass|131
```

- **164 archived lanes → 204 today.** The population moved; the charter carries no
  as-of date, so a reader takes 164 as current.
- **43% → 35.8%** (73/204 first reviews bounce). Seven points off, in the direction that
  overstates the risk. The lesson survives; the number does not.
- **19% / 13% are not reproducible from the record at all.** `.schema` over the whole
  ledger has no table, column or index that classifies a finding into a family — the only
  `classification` column in the database is `ci_cycles.classification`, which classifies CI
  failures, not review findings. These two figures came from a manual read that the repo
  cannot re-derive, so they can be neither confirmed nor refreshed by anyone but their author.

Consequence: low for behaviour (B1/B2 are worth doing at any rate), but it is a
*measured-number* charter and three of its four numbers do not survive re-measurement.

---

### crew/roles/reviewer.md — 12 checkable claims: 10 true, 1 **false**, 1 gap

**FALSE (1)**

> `reviewer.md:30-31` — "Before writing findings, load the do-not-flag guidelines
> (`crew/guidelines/review-do-not-flag.md`, **via the `review-procedure` skill**)."

The named route does not exist at the reviewer seat, on either adapter:

- `crew/capabilities.json` → `roles.reviewer.skills: []`. No skill is granted.
- **pi seat:** `crew/adapters/adapter-pi.mjs:253` —
  `...(skills.length ? skills.flatMap((skill) => ['--skill', `"${skill}"`]) : ['--no-skills'])`.
  With no grant the reviewer boots `--no-skills`; `crew/adapters/adapter-pi.mjs:186-187`
  states the intent: *"--no-skills is the matching closed posture when no skill is granted."*
  Pinned by `crew/adapter-pi.test.mjs:170`.
- **claude seat** (the reviewer's default, `crew/crew.mjs:117` `agent: 'claude'`):
  granting one is not possible either — `crew/adapters/adapter-claude.mjs:66-68` *refuses to
  boot* when `grants.skills` is non-empty (`grant-unsupported`).
- The skill is not even under `skills/`: it lives at `.agents/skills/review-procedure/SKILL.md`.
- Epic #497's ratified boundary says this is deliberate: *"Seats keep booting `--no-skills`;
  discipline reaches seats through the brief."*

And the brief does not carry it either: `grep -n "guidelines\|do-not-flag" crew/drive.mjs`
returns **zero** hits, and the same grep over `scripts/factory/make-brief.mjs` returns zero.
So the guideline reaches the reviewer through **no** route the charter names.

What actually works, and what the charter should name instead: the file is plainly
readable (every seat has `Read`/`Bash`), and the skill ships a loader for exactly this —
`node .agents/skills/review-procedure/scripts/load-guidelines.mjs` prints the guidelines to
stdout, pinned green by `crew/drive.test.mjs:740-748`.

Consequence: a reviewer that follows the charter literally looks for a skill it cannot
invoke, and the most likely recovery is to skip the guidelines — which is precisely the
suppression the do-not-flag list exists to prevent.

**gap (1) — a granted capability the charter never mentions**

`crew/capabilities.json` → `roles.reviewer.tools: ["Task"]`, merged into the seat by
`crew/crew.mjs:127-129` `effectiveTools()`; asserted by `crew/crew.test.mjs:4226`
(`['planner','reviewer'].includes(role) ? ['Task'] : []`) and `:4240`
(`SEAT_DEFAULTS.reviewer.tools` does **not** carry `Task`, so the grant is the only source).
The reviewer charter never mentions subagents at all — where the planner charter spends a
whole section on them (`planner.md:10-17`). The register grants the reviewer fan-out; the
charter leaves it undiscovered.

**true**

| claim (file:line) | evidence |
|---|---|
| `:4` "You change NOTHING in the repo" | `crew/crew.mjs:117` `deny: 'Edit,NotebookEdit'`; `crew/crew.test.mjs:220` asserts `${role} must not write the repo` |
| `:20` severity set must-fix / should-fix / consider | `crew/drive.mjs:702` `FINDING_SEVERITIES = ['must-fix','should-fix','consider']`, whose comment cites `crew/roles/reviewer.md:19-21` — anchor resolves |
| `:26` verdict enum `pass \| changes-needed` | `crew/drive.mjs:692-697` `verdictOf` maps `'pass'`/`'approve'` → pass, `'changes-needed'`/`'revise'` → revise |
| `:37` `details.review_path` | 5 sites in `crew/drive.mjs` |
| `:38` `must_fix` / `should_fix` / `consider` counts | 13 / 8 / 10 sites in `crew/drive.mjs` |
| `:39-42` `details.findings` shape | parsed at `crew/drive.mjs:798-812`; brief restates it at `:2765`, `:2784` |
| `:49` "`findings` is optional: omit it and the run behaves exactly as before" | `crew/drive.mjs:803` `if (!Array.isArray(details?.findings)) return null` |
| `:57` gate-triage enum `{"defect": "build" \| "gate"}` | 62 `defect` sites in `crew/drive.mjs`; the two branches at `:2678` (gate → `gate-repair`) and the build-return path |
| `:58-59` "gate" grants the **lead** its one repair, `GATE_CUSTODIAN`, `crew/drive.mjs` | `crew/drive.mjs:308` `export const GATE_CUSTODIAN = 'lead'`; `:2678`, `:3043` assign it |
| `:71-72` `recommendation` is compared to the lead's decision | `crew/drive.mjs:1856` `options.includes(pEnv.details?.recommendation)` |

Note on the charter's own no-section rule: `crew/drive.test.mjs:623-624` pins that
reviewer.md must **not** carry a `## Do not flag` section and **must** cite the guidelines
path — so the pointer is test-enforced while the *route* in the same sentence is not.

---

### crew/roles/tech-lead.md — 8 checkable claims: 6 true, 1 **false**, 1 contradiction

**FALSE (1)**

> `tech-lead.md:28-29` — `"details": { "check_path": "<abs>", "verdict": "approve"|"revise",
> "answers": ["<one per consult question>"] }`, paired with `:18-19` "Answer the planner's
> consult_questions explicitly, each with a recommendation and the reasoning."

`details.answers` from a tech-lead envelope is read by nothing. The full consult path is
`crew/drive.mjs:2292-2307`: the driver assigns `'plan-check'`, then consumes exactly two
fields — `verdictOf(check)` (`:2307`) and `check.details?.check_path` (`:2219`, inside
`planRevisionBrief`). `matchAnswers` — the only consumer of an `answers` array in the
driver — is applied solely to the **lead's** consult envelope (`crew/drive.mjs:2241`,
`:2971`). An exhaustive grep for `details?.answers` in `crew/drive.mjs` returns one hit,
`:1019`, and that is a line of *instruction text in the lead's brief*, not a read.

Consequence, and it is real: a tech-lead that answers the planner's consult questions in
`details.answers` and not in `plan-check.md` has its answers silently dropped — the
plan-revision brief points the planner at the check **document** (`crew/drive.mjs:2214-2219`:
*"that document is the contracted source of exact corrections"*), so anything not written
into that file never reaches the planner.

**contradiction (1) — same field name, two incompatible shapes**

- `tech-lead.md:29` — `"answers": ["<one per consult question>"]` (array of strings)
- `lead.md:29` — `"answers": [{"id": "<question id>", "answer": "..."}]` (array of keyed objects)

The keyed-object shape is the one code implements (`crew/drive.mjs:921-960` `matchAnswers`,
which rejects anything whose `id`/`answer` are not both strings, `:1036-1037`). Two charters
in the same directory define one field name two ways, and only one shape is machine-readable.

**true**

| claim (file:line) | evidence |
|---|---|
| `:4` "You deliberately run as a different model/effort than the planner" | `crew/roster.json` `tiers.judge`: planner `anthropic/claude-opus-5 @high`, tech-lead `openai/gpt-5.6-sol @xhigh` — different provider, model and effort |
| `:21` verdict enum `approve \| revise` | `crew/drive.mjs:694-695`; the brief demands it at `crew/drive.mjs:2298` |
| `:22-24` "a revise names EXACTLY what must change … the driver hands your check document to the planner as the contracted source of exact corrections (`crew/drive.mjs:2217`)" | `crew/drive.mjs:2214-2217` is the comment block stating exactly that, and it cites back `crew/roles/tech-lead.md:22`; the code it heads is `planRevisionBrief` at `:2218-2226`. Mutually anchored, both anchors resolve |
| `:28` `details.check_path` | `crew/drive.mjs:2219` `check.details?.check_path \|\| art('plan-check.md')` |
| `:20` writes `plan-check.md` in the task dir | fallback path `art('plan-check.md')`, same line |
| the seat is judge-tier only | `crew/roster.json` — `tech-lead` appears under `tiers.judge` and nowhere else; `crew/drive.mjs:2292` `if (!ctx.roles.includes('tech-lead')) break` |

---

### crew/roles/lead.md — 15 checkable claims: 15 true

| claim (file:line) | evidence |
|---|---|
| `:5-7` the driver assigns planner/builder/reviewer, runs scope gate + lane + suite, commits on green | `crew/drive.mjs` main loop |
| `:26` `details.decision` | 50 sites in `crew/drive.mjs` |
| `:28` `guidance` REQUIRED on bounce | 9 sites; carried at `crew/drive.mjs:1919` |
| `:29` `answers: [{"id","answer"}]` | `crew/drive.mjs:921-960` `matchAnswers`; brief text `:1019` |
| `:30` `residuals: [{"id","type"}]` | 26 sites; `crew/drive.mjs:703` `RESIDUAL_TYPES = ['cosmetic','correctness-unverified']` |
| `:31` `refuted: [{"id","evidence"}]` | 26 sites |
| `:36-38` an unanswered id is delivered marked `UNANSWERED` | `crew/drive.mjs:1020` *"An id you leave out is carried to the member as UNANSWERED"*; rendered by `answerBounceLines` `:1024+` |
| `:41-42` "An answer outside the offered options is treated as escalate" | `crew/drive.mjs:1912-1913` — `!allowed.includes(d.decision)` → `{ decision: 'escalate', reason: 'lead returned …/… — treating as escalate' }` |
| `:44-46` `second-opinion` offered on the FIRST round only | `crew/drive.mjs:1911` `const allowed = round === 1 && targets.length > 0 ? [...options, SECOND_OPINION] : options`; `:302` `SECOND_OPINION = 'second-opinion'` |
| `:48` `details.from` must be a seated role | `crew/drive.mjs:1840` — escalates when *"second-opinion target … is not a seated judgment member"* |
| `:50` "Requesting it twice escalates" | `crew/drive.mjs:1868` — *"lead requested a second second-opinion — one hop is the bound"* |
| `:55-56` "The planner is never assigned again after its plan is accepted" | no `assignAndWait('planner', …)` exists past plan acceptance; gate work goes to `GATE_CUSTODIAN` (`:2678`, `:2696`, `:2724`, `:3043`) |
| `:63-67` `gate-fix` spends no budget; only `gate-repair` consumes the one-per-task `gate_repairs` | `crew/drive.mjs:29` `gate_repairs: 1, // the gate's author may repair it at most once per task`; the guard `:2638` `if (gateRepairs >= limits.gate_repairs)` sits only on the `gate-repair` path (`:2643`), while both `gate-fix` assignments (`:2696`, `:2724`) bypass it |
| `:70-71` "You have `Write` but not `Edit`" | `crew/crew.mjs:114` — `lead: { tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit,…' }`. **Evidence note:** the backing is `SEAT_DEFAULTS`, *not* `crew/capabilities.json` (`roles.lead` grants `tools: []`) — the register is additive over the seat default, so "the register grants the lead nothing" and "the lead has Write" are both true |
| `:75` gate must print `GATE-SUMMARY {"total","failed","errored":0}` | `crew/drive.mjs:325` `GATE_SUMMARY_PREFIX = 'GATE-SUMMARY'`; parsed `:590-592`; the no-summary refusal `:607` |

Also pinned: `crew/drive.test.mjs:626-630` asserts lead.md contains `residuals`, `refuted`,
both `RESIDUAL_TYPES` and `code-refused` — so this charter's enum vocabulary is tripwired.

---

### crew/roles/planner.md — 24 checkable claims: 20 true, 1 **false**, 1 **dead field**, 2 notes

**FALSE (1) — the citation does not support the claim**

> `planner.md:82-84` — "Twice — **#193 and #199** — a scope fixed without that grep sent the
> run to `escalate:scope`: the builder needed a test file the plan had never looked for, and
> the gate was right to refuse it."

Neither number is about scope. Verified with `gh`:

```
#193  CLOSED | SF-7b: batch/queue inside the daemon — autonomous factory as a mode, not a babysat loop
#199  CLOSED | a run's task envelope is per crew dir, so a crew dir cannot honestly be run twice
```

They are also not PR numbers — `gh pr view 193` and `gh pr view 199` both return
*"Could not resolve to a PullRequest with the number of 193/199"*.

The issue that actually records this, found by searching the tracker for the claim's own
subject, is **#222** — *"the planner charter says what files_in_scope is, never how to
discover it — twice now that cost a dispatch"* — i.e. the exact "twice" the sentence means.
The adjacent rule at `:74-75` ("the path key is the one that works on a file that exports
nothing") is **#232** — *"the planner's discovery rule can't find a test that pins a config
file — it only greps code-shaped keys."*

Consequence: this is the one paragraph in the charter that justifies an expensive
discipline by naming its cost. A planner that checks the citation finds a daemon-batching
epic, and the discipline reads as folklore. Both correct numbers exist and are closed.

**DEAD FIELD (1) — declared, read by nothing**

> `planner.md:56` — `"consult_wanted": true|false,`
> under the heading `:41` "**Envelope details fields (the driver BRANCHES on these)**" and
> `:43-44` "The rest are optional but **change what the driver does**".

`grep -rn "consult_wanted" . --exclude-dir=node_modules --exclude-dir=.git` returns **exactly
one line in the whole repository**: `crew/roles/planner.md:56` — the declaration itself.
Nothing reads it; no test names it; even the driver's own fixtures omit it
(`crew/drive.test.mjs:213`, `crew/daemon.test.mjs:1705` build planner envelopes with
`consult_questions` and `carve_verdict` but no `consult_wanted`).

What actually decides a consult is seating alone: `crew/drive.mjs:2292`
`if (!ctx.roles.includes('tech-lead')) break`.

Consequence: a planner that sets `consult_wanted: false` to decline an adversary gets one
anyway if a tech-lead is seated, and one that sets `true` gets none if no tech-lead is
seated. The field is inert under a heading that promises it is load-bearing.

**true**

| claim (file:line) | evidence |
|---|---|
| `:12-13` scouts via the `Task` tool | `crew/capabilities.json` `roles.planner.tools: ["Task"]`, merged by `crew/crew.mjs:127-129`; `crew/crew.test.mjs:4323` `resolved.planner.grants.tools == ['Task']`, `:4348` the composed command carries `Task` |
| `:48` `details.plan_path` | 8 sites in `crew/drive.mjs` |
| `:49-52` scope path rules (repo-relative literal, or trailing-slash prefix ≥2 segments; globs / `.` / `..` / absolute / top-level rejected) | 31 `files_in_scope` sites in `crew/drive.mjs`, 6 in `crew/crew.mjs` |
| `:53` `commit_subject`, and `:44-45` its fallback to a subject derived from the summary | 7 sites; `crew/drive.mjs:1429` shows the parallel body fallback |
| `:54` `issues` "emits a Refs: trailer" | 16 `issues` sites in `crew/drive.mjs` |
| `:55` `validation_lane` | `crew/drive.mjs:2365` `const lane = planEnv.details?.validation_lane \|\| ctx.lane` |
| `:57` `consult_questions` reaches the tech-lead | `crew/drive.mjs:2300` — serialised verbatim into the check brief |
| `:62-65` "the driver diffs the builder's changes against it with git and bounces anything outside; a missing or empty list escalates" | scope-gate stage; `escalate:${where}` `crew/drive.mjs:1934`, `escalate:scope` asserted `crew/drive.test.mjs:5758`, and `crew/drive.mjs:281` refuses an envelope shape that declares no `scope-gate` stage |
| `:76-78` `.github/workflows/test.yml` → `test/factory-ledger-floor.test.mjs` reads the workflow and asserts the Node floor | `test/factory-ledger-floor.test.mjs:196-197` — `readFileSync(join(ROOT, '.github/workflows/test.yml'))` then `matchAll(/node-version:\s*"?(\d+)/g)`; `NODE_FLOOR` asserted `:112`, `:145` |
| `:79-80` `crew/factoryctl.test.mjs` "settles a run by writing the well-known `returns/task.json`" | `crew/factoryctl.test.mjs:24` and `:418` `task_return: 'returns/task.json'`; joined at `:44` |
| `:86-88` `gate_path` must be inside the task dir; the driver measures bytes from it and never parses `gate_cmd` | `gate_path` 2 sites, `gate_cmd` 19 sites in `crew/drive.mjs` |
| `:90-96` `carve_verdict` enum `proceed \| carve`, carve escalates with slices | `crew/drive.mjs:2285-2288` — `if (carve.verdict === 'carve') return escalate('plan-carve', …)` carrying `slices` |
| `:109-111` gate must fail RED at baseline | `crew/drive.mjs:2696` gate-fix on a baseline-green gate; `:2698` escalates when it cannot be repaired |
| `:115` `GATE-SUMMARY {"total","failed","errored"}` | `crew/drive.mjs:325`, parsed `:590-592` |
| `:118-122` `errored: 0` required at baseline because a broken gate also exits non-zero | `crew/drive.mjs:607` — *"the gate printed no GATE-SUMMARY line, so the driver cannot tell a red gate from a broken one"*; the bounce brief `:2723` demands `"errored":0` |
| `:131-132` `npm run viz:serve` | `package.json:17` `"viz:serve": "node visualizer/server/server.mjs"` |
| `:135-138` one `gate-repair` per task, old gate preserved under `.r1` | `crew/drive.mjs:29` `gate_repairs: 1`; guard `:2638` |
| `:175` `MUTATIONS_MAX` (32) | `crew/drive.mjs:1305` `export const MUTATIONS_MAX = 32`; enforced `:1353`; pinned `crew/drive.test.mjs:3245` |
| `:173-174` `validateMutations` in `crew/drive.mjs` is the enforcement point | `crew/drive.mjs:1351` `export function validateMutations(...)`, called `:2395` |
| `:179-181` check token `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, gate prints `FAIL <check>` | `crew/drive.mjs:1317` `const CHECK_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/` — byte-identical; `:1313` `CHECK_FAIL_PREFIX = 'FAIL'` |
| `:193` the worked exemplar `standingBlocks().mutations` in `scripts/factory/make-brief.mjs` | `scripts/factory/make-brief.mjs:1422` — the literal exists, so the exemplar mutation is applicable today |
| `:194` "Every compiled brief repeats this contract under `## Per-check mutations`" | `scripts/factory/make-brief.mjs:1421-1422` |
| `:195` "Rationale: #330" | `#330 CLOSED — Gate discrimination is whole-gate only: vacuous individual checks pass the proof` — exactly on point |
| `:154` "the #294 advisor" | `#294 CLOSED — pi arc 4: two-tier advisor on the builder seat — mechanical predicates first…` — on point |
| `:156-157` the checklist defines P1–P3 | `crew/guidelines/seat-pre-return-checklist.md:51` (**P1**), `:59` (**P2**), `:66` (**P3**) — ids match exactly; pinned by `test/factory-make-brief.test.mjs:753-763` |

**notes (2) — true but weaker than the charter implies**

1. `planner.md:81-82` — "An adapter change pulls in the matching `crew/adapter-*.test.mjs`
   files, listed literally (scope takes no globs)." Only **one** such file exists —
   `crew/adapter-pi.test.mjs`. The adapters themselves live in `crew/adapters/`
   (`adapter-claude.mjs`, `adapter-pi.mjs`), and `adapter-claude.mjs` is covered from
   `crew/capabilities.test.mjs`, `crew/crew.test.mjs` and `crew/driver.test.mjs` — none of
   which match the plural pattern the charter tells a planner to look for. The instruction
   is not wrong; the pattern it names finds half the truth.

2. `planner.md:76-78` undersells its own rule. Applying the charter's grep to
   `.github/workflows/test.yml` today hits **five** test files, not one:
   `test/factory-ledger-floor.test.mjs:196`, `test/factory-ci-watch.test.mjs:82`,
   `test/factory-ci-repair.test.mjs:72`, and `test/factory-probe-repo.test.mjs` at `:165`,
   `:168`, `:649`, `:884`, `:1015`. The exemplar names one and a planner may read it as the
   whole answer.

3. `planner.md:12-17` states scouting unconditionally, with no named exception, but the
   capability is degradable: `crew/crew.test.mjs:4325` exercises
   `degraded.planner.grants.tools == []` — the `--allow-shortfall-planner subagents` path a
   pi planner needed before #403. A planner booted degraded has no `Task` tool and the
   charter's opening section describes a tool it does not hold.

---

## Contradictions

| # | A | B | the conflict |
|---|---|---|---|
| C1 | `tech-lead.md:29` — `"answers": ["<one per consult question>"]` | `lead.md:29` — `"answers": [{"id": "…", "answer": "…"}]` | one field name, two incompatible shapes in the same directory. Only the keyed-object shape is machine-read (`crew/drive.mjs:921-960`); the tech-lead's shape is read by nothing |
| C2 | `reviewer.md:30-31` — load the guidelines **via the `review-procedure` skill** | epic #497's ratified boundary — *"Seats keep booting `--no-skills`; discipline reaches seats through the brief"*, implemented at `crew/adapters/adapter-pi.mjs:253` and `crew/adapters/adapter-claude.mjs:66-68` | the charter routes through the one delivery channel the architecture closes for seats |
| C3 | `_shared.md:63` — "Repo writes are role-gated: only the builder edits repo files" | `lead.md:70-71` — "You have `Write`… rewrite the gate file whole" | resolved, not a live conflict: `lead.md:104` names the exception and pins it to the task dir. Recorded because the exception lives 34 lines away from the grant and only `_shared.md` is guaranteed read first |
| C4 | `planner.md:157` / `builder.md:39-40` — "This charter names that list and **does not restate it**" | `planner.md:161-166` / `builder.md:45-48` — then restate all three items, one line each | self-contradicting in the same paragraph. Harmless today because the restatements agree with `seat-pre-return-checklist.md:24/34/42/51/59/66` verbatim — which is exactly the condition that decays |

---

## Charter versus register

Registers: `crew/roster.json` (who is seated at each tier),
`crew/capabilities.json` (what each role is *granted* on top of its seat default),
`crew/crew.mjs:113-118` `SEAT_DEFAULTS` (the seat default itself).
The two registers are additive — `crew/crew.mjs:127-129` `effectiveTools()` unions them —
so "granted nothing" never means "has nothing".

| role | seat default (`SEAT_DEFAULTS`) | register grant (`capabilities.json`) | roster seating | charter claims | verdict |
|---|---|---|---|---|---|
| lead | `Read,Glob,Grep,Bash,Write`; deny `Edit,NotebookEdit,<fanout>` | `tools: []`, `advisor: false` | build + judge (`mechanical.lead: null`) | "`Write` but not `Edit`" (`:70-71`); never edits repo, never commits (`:102`) | **agrees.** Backed by the seat default, not the grant — a reader checking only `capabilities.json` would wrongly call this unbacked |
| planner | `Read,Glob,Grep,Bash,Write`; deny `Edit,NotebookEdit`; `requires: ['subagents']` | `tools: ["Task"]`, `requires: ["subagents"]`, `by_agent.pi` → extensions `subagent.ts`, `lab.ts` + agent `scout` | all three tiers | spawns scouts via `Task` (`:12`); never edits repo (`:6-7`) | **agrees**, with one gap: `:13` names `subagent_type "Explore"` / `"general-purpose"`, which are CLAUDE subagent types. A **pi** planner's granted agent is `scout` (`capabilities.json` → `by_agent.pi.agents[0].name`, def `crew/pi/agents/scout.json`). The charter is adapter-blind and names types a pi planner does not have |
| builder | `Read,Edit,Write,Glob,Grep,Bash`; deny `<fanout>` | `tools: []` | all three tiers | "the only role that edits repo files" (`:3`); no commits (`:24`) | **agrees.** `crew/crew.test.mjs:217-218` pins both halves — builder has `Edit`, builder must **not** have `Task` (*"builder must stay subagent-free (transcript reducer relies on it)"*), and the charter never claims fan-out |
| reviewer | `Read,Glob,Grep,Bash,Write`; deny `Edit,NotebookEdit` | **`tools: ["Task"]`**, `skills: []` | mechanical + build (pi/terra) + judge (claude/opus) | "You change NOTHING in the repo" (`:4`) | **under-claims.** The register grants `Task` (`crew/crew.test.mjs:4226`, `:4240`) and the charter never mentions it. Separately the charter claims a **skill** route the register explicitly does not grant (`skills: []`) — see the FALSE entry above |
| tech-lead | `Read,Glob,Grep,Bash,Write`; deny `Edit,NotebookEdit,<fanout>` | `tools: []` | **judge tier only** | "different model/effort than the planner" (`:4`); changes nothing (`:5`) | **agrees.** Judge tier: planner `claude-opus-5@high` vs tech-lead `gpt-5.6-sol@xhigh`. `planner.md:38` correctly conditions on "If a tech-lead pane exists" |

No charter claims a capability the registers withhold, with the single exception of the
reviewer's `review-procedure` skill. Two charters fail to mention what they are granted
(reviewer's `Task`; the planner's pi-side `scout` agent).

---

## Overlap — repeated prose that will drift

| # | duplicate | proposed single home |
|---|---|---|
| O1 | **`reviewer.md:64-75` and `tech-lead.md:34-45` are byte-identical** — the entire "Perspective assignments" block, 12 lines, verified by `diff` returning empty | `crew/roles/_shared.md`. It is already the mechanism for text every seat must follow, and a perspective assignment is driver-issued, not role-specific. Both charters keep a one-line pointer |
| O2 | `.agents/skills/review-procedure/SKILL.md:12-22` restates `reviewer.md:9-21` — read plan then diff then changed files in full; run the lane yourself, never trust a reported pass; conformance then correctness; `review.md` with verdict line, severity, `file:line`, failure scenario | `crew/roles/reviewer.md`. The skill already declares *"Procedure only… this skill loads it and never restates it"* about the guidelines — the same restraint should apply to the method. The skill keeps step 3 (the loader), which is the part the charter cannot supply |
| O3 | `planner.md:168-195` (the mutation contract) is duplicated by `MUTATION_CONTRACT_BLOCK` in `scripts/factory/make-brief.mjs`, stamped into every brief at `:1421-1422` — and **already drifting**: the charter writes "at most `MUTATIONS_MAX` (32) entries", the block writes "at most 32 entries in all (`MUTATIONS_MAX`)", and the two use different worked examples for the refused prose field (`"A1"` vs the same idea reworded) | `scripts/factory/make-brief.mjs` (`MUTATION_CONTRACT_BLOCK`), since it is compiled into every brief the planner reads anyway. `planner.md` keeps the pointer it already has at `:166` |
| O4 | The GATE-SUMMARY contract appears three times: `planner.md:112-123`, `lead.md:75`, and `ACCEPTANCE_GATE_BLOCK` in `scripts/factory/make-brief.mjs:148-149` | same as O3 — the brief block. The charters keep the one-line invariant; the reasoning lives once |
| O5 | `planner.md:152-166` and `builder.md:35-49` are the same "Before you return" section with the role's ids swapped, both restating items that `crew/guidelines/seat-pre-return-checklist.md` owns | `crew/guidelines/seat-pre-return-checklist.md` already is the single home. Both charters should stop at the pointer, which is what their own text claims they do (see C4) |

---

## Adjacent finding — outside `crew/roles/`, reported because agents act on it

The symbol `GATE_SUMMARY_PREFIX` is cited by file:line in two places and **both are stale**:

- `scripts/factory/make-brief.mjs:148-149` — "`GATE_SUMMARY_PREFIX`, `crew/drive.mjs:70`".
  This text is stamped into **every compiled brief** (it is the `## Acceptance gate`
  standing block, and it appears verbatim in this task's own brief).
- `crew/drive.mjs:1308` — "exactly as it already dictates `GATE_SUMMARY_PREFIX` (`:204`)".

The definition is at **`crew/drive.mjs:325`**. `crew/drive.mjs:70` is inside `resolveWait()`,
an unrelated flag parser. Two independently-authored anchors for the same symbol, both
wrong, is evidence that no check verifies file:line anchors anywhere in the repo — which is
the same class the planner charter's own P1 exists to prevent
(`crew/guidelines/seat-pre-return-checklist.md:51`).

`crew/roles/` is pinned by tests (`crew/drive.test.mjs:598-630`,
`test/factory-make-brief.test.mjs:753-763`, `crew/crew.test.mjs`,
`crew/driver.test.mjs`), so per the brief's Out-of-scope rule no charter change is proposed
here — the tests that would need to move are named instead.
