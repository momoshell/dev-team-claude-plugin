# Plan — lean `finish` run (FN1–FN9)

Subject: `feat(crew): finish stopped lean lanes in-loop`

## Design (minimal, standard shape untouched)

Port ADR-051's finish shape to the lean loop only. Out of scope stays out:
`crew/drive.mjs`, `crew/crew.mjs`, `crew/variants.mjs`, `docs/adr/`, the stepped
shape, and the operator decision verbs (`--accept/--return/--abandon`).

### 1. `crew/loop.mjs` — a `finish` branch inside `runLoop`

Today `runLoop` refuses any shape but `standard` (`crew/loop.mjs:74-76`), requires
planner+builder+reviewer seats, emits one `run-start` (`crew/loop.mjs:231-232`),
then plan (`crew/loop.mjs:234-242`), baseline (`crew/loop.mjs:244-247`), the
build→gate→mutations→review→suite loop (`crew/loop.mjs:250-310`) and
commit→fetch→rebase→publish (`crew/loop.mjs:312-336`). Change only:

- Accept `standard` and `finish`: `const isFinish = spec.shape === 'finish'`, and
  refuse anything else as today. For `finish`, validate `spec.finish`:
  `{ planPath, gatePath, subject }` nonempty strings, `mutations` a list,
  `stop: { reason, observation }` with nonempty `reason`, `findings` a list,
  and `turnOffset` a non-negative safe integer; unsound → `invalid-input`.
  Required seats for `finish` are builder and reviewer only (no planner seat).
- Keep these anchor expressions verbatim (the gate's mutations target them):
  - `const planned = isFinish ? null : await stage('plan', () => seatTurn('planner'))`
  - `const baseline = isFinish ? null : await stage('baseline', () => callCheck('baseline', d.checkBaseline, { cwd, gatePath, timeoutMs }))`
  Guard the existing planner-acceptance and baseline-acceptance blocks with
  `if (!isFinish)`. Acceptance for the run is `spec.acceptance` (the planner
  envelope is checked against it in standard, the finish spec carries it as-is).
- Do **not** emit `run-start` on a finish run (emit it only when `!isFinish`).
  The original row stays the anchor the builder's context arms date the planner
  return against (`crew/acp/seat.mjs:185-215`); a second `run-start` would make
  the accepted plan read as stale. No change to `crew/acp/seat.mjs`.
- Initialise `turn` from `spec.finish.turnOffset ?? 0` on finish (0 on standard),
  so finish seat ids/session files (`crew/lean.mjs:135-145`, written `wx`) never
  collide with the stopped lane's turns. `finish.mjs` derives it (see §3).
- Finish initial state, before the build loop: `planPath`/`gatePath` from
  `spec.finish`, `subject` from `spec.finish.subject`, `mutations` a copy of
  `spec.finish.mutations`, reviewer rounds raised to three:
  `seats.reviewer = { ...seats.reviewer, rounds: Math.max(seats.reviewer.rounds ?? DEFAULT_ROUNDS, 3) }`.
- First builder feedback on finish (this exact construction):
  `feedback = [{ id: 'finish-stop', reason: spec.finish.stop.reason, observation: spec.finish.stop.observation }, ...spec.finish.findings]`.
  Later review/suite feedback replaces it exactly as in standard.
- Builder replacement mutations: after a non-halt builder turn in the build loop
  and before the gate stage, if `built.envelope.details.mutations` is present,
  refuse `envelope-refused` when any `check` is outside `acceptance`, else apply
  exactly:
  `mutations = mutations.map((declaration) => built.envelope.details.mutations.find((replacement) => replacement.check === declaration.check) ?? declaration)`
  so the mutation proof that follows runs the replacement declarations.
- After a green rebase on finish, publish nothing: emit
  `await emit('finish-ready', { status: 'ready-for-operator', head: rebased.head })`
  and `return { status: 'done', reason: null, pr: null }`. Standard still
  publishes and returns the PR exactly as today.

### 2. `crew/protocols.mjs` — builder may return replacement mutations

The builder envelope today carries only `summary` (`crew/protocols.mjs:213-224`).
Add `mutations` to `OPTIONAL_DETAIL_KEYS.builder` and validate it in
`validateEnvelope` with the existing `mutationDefects(v, undefined)` helper
(structure, nonempty `find`, differing `replace`, no repeated `check`); membership
in the lane's acceptance is the loop's check (§1), since the schema does not know
it. Also show the optional field in the builder example envelope in
`crew/lean.mjs:16-31` and note it in `crew/agents/builder.md` (details keys line),
so a real finish builder knows it may re-aim a mutation — this is how the b1396
`mutations-survived` and b1397 gate-defect lanes become builder-fixable. A gate
file the builder edits is just repo code; the loop's gate→proof order (§1)
re-proves it before review, unchanged.

### 3. `crew/finish.mjs` (new) — `crew finish <lane>`

Mirror `crew/record-pr.mjs`/`crew/closeout.mjs` conventions. Export
`FinishRefusal` (an `Error` subclass carrying `.reason`), `finishLane({ lane, root, deps })`,
and `main(argv, deps)` (`crew finish <lane>`; usage → 2, refusal → 1 with
`crew finish: <reason>: <message>` on stderr, success → 0). `finishLane`:

1. Resolve the lane under `root` (default `~/.crew`): lane dir
   `<root>/dt-<lane>/<lane>`, read `task/lean.json` (the stopped spec) and
   `task/journal.jsonl`. Unresolvable lane/journal → throw a `FinishRefusal`
   (any closed reason; not acceptance-tested).
2. Refusals, in this order, each `throw new FinishRefusal('<code>', '<message>')`
   with the code appearing once, in that call:
   - worktree: `spec.cwd` is not an existing directory → `'finish-worktree'`;
   - premise: the last `verdict` row with `status: 'stopped'` has
     `stage` `plan` or `baseline` → `'finish-premise'`;
   - no-build: no journal `envelope` row with `role: 'builder'`, empty
     `defects`, and `parsed.status === 'done'` → `'finish-no-build'`.
3. Otherwise build the finish spec: read the highest-numbered
   `planner-<n>.json` in the task dir, require a defect-free `done` planner
   envelope (`validateEnvelope`), and take `planPath`, `gatePath`, `subject`,
   `mutations` from its details. From the journal take the last stopped
   verdict's `{ reason, observation }` as `stop`; take `findings` from the last
   `verdict` row with `status: 'reviewed'` only when its `verdict` is
   `changes-needed` (else `[]`); set `turnOffset` to the count of `envelope`
   rows in the journal.
4. Write `{ ...spec, shape: 'finish', finish: { planPath, gatePath, subject, mutations, stop, findings, turnOffset } }`
   to `task/finish.json` (never rewrite `lean.json`) and spawn detached exactly
   like the lean branch of `crew/start.mjs:145-176`:
   `spawnDetached(process.execPath, [<repo>/crew/lean.mjs, specPath], { cwd: spec.cwd, log, env })`
   with the log under `<root>/briefs/started/<lane>.run.log` and
   `SLOT_ENV.capacity = '0'` in env. Return `{ lane, worktree: spec.cwd, specPath, pid }`.
   All effects (`readFileSync`, `existsSync`, `statSync`, `mkdirSync`,
   `writeFileSync`, `spawnDetached`, `log`, crew root) cross injectable `deps`
   seams defaulting to the real ones, as in `crew/start.mjs`.

### 4. Routing + inventory

- `bin/crew.mjs`: add `finish: 'crew/finish.mjs'` to `ENTRY` (`bin/crew.mjs:24`)
  and a header line for `crew finish <lane>`. Extend the routing table test in
  `bin/crew.test.mjs` (fake home gains `crew/finish.mjs`).
- New test file `crew/finish.test.mjs`; add `'crew/finish.test.mjs'` to the D1
  expected-unmeasured list in `test/factory-suite-cost.test.mjs:118-175`
  (sorted position).

## Tests that prove it

New `crew/finish.test.mjs` (fake deps, no real seats/git/gh), plus extensions to
`crew/loop.test.mjs`, `crew/protocols.test.mjs`, `bin/crew.test.mjs`:

- FN1/FN2: a finish `runLoop` with no planner seat seated completes; no planner
  request is issued and `checkBaseline` is never called.
- FN3/FN4: the first builder request's `feedback` is
  `[{ id: 'finish-stop', reason, observation }, ...findings]` from the spec.
- FN5: a builder envelope returning replacement `mutations` makes
  `proveMutations` receive the replacements; an out-of-acceptance `check` stops
  `envelope-refused`; `validateEnvelope` accepts a sound optional builder
  `mutations` and refuses a malformed one.
- FN6: a green finish run calls commit→fetch→rebase, never `openPullRequest`,
  returns `{ status: 'done', reason: null, pr: null }`, and journals a
  `finish-ready` row with `status: 'ready-for-operator'` after rebase.
- FN7/FN8/FN9: `finishLane` fixtures (temp crew root, journal, `lean.json`,
  planner return, `crew.json`) refuse with `.reason` `finish-no-build`,
  `finish-premise` (stopped at `plan`, and at `baseline`), `finish-worktree`;
  a valid fixture writes `task/finish.json` with shape `finish` and the stop
  reason/findings/turn offset, and spawns `crew/lean.mjs` detached in the
  lane's own worktree. A second `run-start` is never appended by a finish
  `runLoop` (journal rows asserted).
- Regression: the existing standard-shape `crew/loop.test.mjs` expectations
  (stage order, baseline, publish) pass unmodified.

Validation lane: `node --test crew/finish.test.mjs crew/loop.test.mjs crew/protocols.test.mjs bin/crew.test.mjs`

## Files in scope

`crew/loop.mjs`, `crew/protocols.mjs`, `crew/finish.mjs`, `crew/finish.test.mjs`,
`crew/lean.mjs`, `crew/agents/builder.md`, `crew/loop.test.mjs`,
`crew/protocols.test.mjs`, `bin/crew.mjs`, `bin/crew.test.mjs`,
`test/factory-suite-cost.test.mjs`.
