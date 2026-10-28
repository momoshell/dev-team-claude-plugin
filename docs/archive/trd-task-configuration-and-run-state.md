# Technical Requirements Document: Task Configuration and Run State

**Status:** Proposed for implementation

**Date:** 2026-08-30

**Scope:** Crew runtime, factory intake, ledger, visualizer, roster policy, and migration

**Replaces:** The overloaded use of `tier` as task shape, staffing, model strength, and display category

---

## 1. Executive decision

The factory must describe a run on independent axes:

1. **Task profile** — what outcome the user needs.
2. **Execution shape** — which deterministic workflow the driver will run.
3. **Assurance preset** — how much staffing and oversight the run receives.
4. **Seat allocation** — the actual agent, model, effort, and transport used by each role.
5. **Override record** — where the effective configuration differs from a recommendation or ratified default.

`mechanical`, `build`, and `judge` are not task profiles. They are the current
names of assurance/staffing presets. `full`, `scout`, `repair`, and `directed`
are execution shapes. Neither axis states whether the requested outcome is an
implementation, investigation, review, QA verification, or test-authoring
task.

This is an additive migration, not a factory rewrite. The deterministic driver,
gate mechanics, seat adapters, and append-only ledger discipline stay in place.
New declarations and recorded facts replace inference and overloaded labels at
their boundaries.

### 1.1 Required outcome

For every new run, an operator must be able to answer from the ledger alone:

- What was requested?
- Which workflow was selected, and why?
- How much assurance was requested and actually applied?
- Which seats and models actually ran?
- Which choices were defaults, recommendations, or explicit overrides?
- What evidence was required for acceptance?
- Is the run settled?
- If it is not settled, is the driver known alive, known gone, or unverified?
- If it settled, did it succeed, escalate, abort, or fail mechanically?

Historical rows remain historical. A value that was not recorded is displayed
as **Not recorded** and is never reconstructed from phase names, seat count,
task text, or a compiler proposal.

### 1.2 Why this work is needed

The current contracts split related facts across several places:

- `crew/variants.mjs` owns the closed execution shapes.
- `crew/roster.json` and `crew/crew.mjs#resolveTier` own staffing and models.
- `sessions.tier` records a tier only for tiered boots.
- `sessions.proposed_shape` and `sessions.proposed_strength` record compiler
  proposals, not the effective run configuration.
- The actual `variant` is written to the task journal but not the session row.
- Pane seats may have no `agent_sessions` row, so the visualizer cannot always
  reconstruct the effective model, effort, or transport.
- Escalation is preserved in the task envelope, while the session status maps
  every non-`done` terminal result to `aborted`.

The result is a UI that has been forced to infer concepts which the ledger did
not measure. The first UI migration already stops doing that; this TRD makes the
underlying data complete.

### 1.3 The current “1 open · 1 stale” case

On 2026-08-30 the visualizer showed **1 open · 1 stale**. Those two values are
not contradictory, but they are not sufficient to answer “is this task really
running?”

- **Open** currently means the session row still has `status=running` and no
  terminal timestamp.
- **Stale** currently means the most recent session/seat heartbeat is older
  than the UI threshold.
- A heartbeat is emitted only while the driver is inside a seat wait. The
  driver can be alive while it is in git, a gate, or the suite and emit no
  heartbeat.
- A missing or old heartbeat therefore cannot prove that the driver is dead.

The current card must be treated as **one unsettled ledger record whose runtime
state is unconfirmed**, not as proof of either active work or a dead task.

This TRD requires:

1. Separate settlement state from observed runtime state.
2. Use the documented two-period heartbeat bound (currently 60 seconds) only
   as “no recent seat-wait observation,” never as a death verdict.
3. Add a driver/process observation source that can report `alive`, `gone`, or
   `unknown` without guessing from a heartbeat.
4. Add an explicit reconciliation path which may settle a proven orphan.
5. Keep the visualizer read-only: it reports and links to remediation; it never
   silently repairs the ledger.
6. Replace ambiguous top-bar copy with, for example, **1 unsettled · runtime
   unconfirmed** until an authoritative observation exists.

---

## 2. Goals and non-goals

### 2.1 Goals

- Give task intent a closed, durable vocabulary.
- Preserve the existing deterministic execution variants and extend them only
  where review/verification workflows genuinely require a different topology.
- Rename tiers to assurance presets without weakening current staffing floors,
  protected-path rules, or reseat escalation.
- Make model guidance helpful for experiments and enforce policy only at a
  deliberate publish/boot boundary.
- Persist requested and effective configuration with provenance.
- Make terminal outcome and live runtime state independently legible.
- Let the visualizer compare runs by profile, execution, assurance, outcome,
  model, override use, and evidence quality.
- Maintain read compatibility with every existing ledger and roster.

### 2.2 Non-goals

- Replacing the driver, gate system, adapters, or ledger implementation.
- Inferring task profiles for historical runs.
- Converting Artificial Analysis scores into acceptance verdicts.
- Allowing the browser visualizer to mutate or settle a run.
- Making model recommendations a hidden hard block during local exploration.
- Treating an escalation as a failure. Escalation remains a deliberate handoff.

---

## 3. Canonical vocabulary

### 3.1 Task profiles

The initial closed set is:

| Key | User-facing name | Required outcome | Minimum evidence |
|---|---|---|---|
| `implementation` | Implementation | A requested behavior or product change | Scoped diff, validation, review, terminal result |
| `bug_fix` | Bug fix | A reproduced defect is removed without regression | Reproduction or cited failure, fix validation, regression evidence |
| `investigation` | Investigation | A read-only, cited answer to a bounded question | Findings with source evidence, explicit unknowns, zero source writes |
| `code_review` | Code review | Actionable findings against a declared change set | Base/head identity, structured findings, severity, citations, no source writes |
| `qa_verification` | QA verification | A declared behavior is independently checked | Environment, checks run, pass/fail/blocked result, captured evidence |
| `test_authoring` | Test authoring | Tests materially discriminate the intended behavior | New/changed tests, mutation or negative-control proof, suite result |

“Directed change” is not a profile. It is `implementation` or `bug_fix` using
the `directed` execution shape. “High quality” is not a profile. It is an
assurance choice.

Profiles own evidence requirements and user-facing language. They do not own
specific models.

### 3.2 Execution shapes

The current declarations remain authoritative:

| Key | Meaning | Status |
|---|---|---|
| `full` | Planned, gated, reviewed implementation loop | Existing |
| `directed` | Operator-authored plan/scope/gate; builder and reviewer execute it | Existing |
| `scout` | Read-only planner envelope | Existing |
| `repair` | Bounded repair inheriting a failing run’s scope and lane | Existing |
| `review_only` | Structured review of a declared base/head with no source writes | New |
| `verify_only` | Independent checks against declared behavior with no source writes | New |

The two new shapes are necessary because `scout` is a planner-only research
shape. Calling code review or QA “scout” would hide the seat, artifact, and
acceptance contracts those workflows need.

### 3.3 Profile-to-shape compatibility

| Profile | Recommended | Allowed alternatives |
|---|---|---|
| `implementation` | `full` | `directed` |
| `bug_fix` | `full` | `directed`, `repair` when a failing run supplies inherited scope |
| `investigation` | `scout` | None in v1 |
| `code_review` | `review_only` | None in v1 |
| `qa_verification` | `verify_only` | None in v1 |
| `test_authoring` | `full` | `directed` |

An incompatible combination refuses before state, panes, or worktrees are
created. The refusal names the selected values and the allowed combinations.

### 3.4 Assurance presets

The canonical public keys and legacy aliases are:

| Canonical | Legacy alias | Meaning | Current staffing retained |
|---|---|---|---|
| `quick` | `mechanical` | Lean oversight for routine, low-risk work | Planner, builder, reviewer; no lead |
| `standard` | `build` | Balanced oversight for normal change work | Lead, planner, builder, reviewer |
| `rigorous` | `judge` | Reinforced judgment for sensitive or high-risk work | Lead, planner, builder, reviewer, tech lead |

Assurance owns:

- required seats;
- minimum capability/model band floors;
- default effort per seat;
- vendor-diversity policy;
- reseat escalation order;
- protected-path minimums.

Assurance does not own task purpose or workflow topology.

The current ladder maps exactly to `quick → standard → rigorous`.
Protected-path work that currently forces `judge` instead forces `rigorous`.

### 3.5 Model fit and overrides

Capability bands (`frontier`, `workhorse`, `utility`, `basement`) remain
separate from assurance. External benchmark data is advisory evidence, not a
second roster authority.

Every effective seat records:

- role;
- adapter/agent;
- provider and model identifier;
- effort;
- transport;
- value source: `roster`, `profile_recommendation`, `operator_override`, or
  `reseat`;
- applicable warnings;
- whether the choice passed the boot policy.

Local roster drafts may use any syntactically valid model. Guidance appears as
recommendations and warnings. Preparing the standard repository patch and
booting a ratified run remain deliberate policy boundaries and may refuse an
invalid floor, capability, transport, or vendor-diversity combination.

---

## 4. Configuration resolution

### 4.1 Public request

New run entrypoints accept:

```text
--profile <task-profile>
--execution <execution-shape>
--assurance <assurance-preset>
--model-<role> <adapter model id>
--agent-<role> <adapter>
--effort-<role> <effort>
```

`factoryctl`, daemon enqueue records, batch intake, direct `crew.mjs` runs, and
any future launch UI use the same field names.

### 4.2 Compatibility flags

- `--variant` remains a deprecated alias for `--execution` for one full
  release window.
- `--tier mechanical|build|judge` remains a deprecated alias for
  `--assurance quick|standard|rigorous` for one full release window.
- Supplying both a canonical flag and its alias refuses, even if values agree.
- Deprecation is visible in CLI output and ledger provenance.
- The internal old keys remain readable indefinitely for historical data.

### 4.3 Defaults and provenance

New orchestrated intake must make `task_profile` explicit. Compatibility entry
points may temporarily record it as null with source `legacy_missing`; they must
not infer it from the brief.

Execution and assurance resolution is deterministic:

1. explicit canonical request;
2. explicit compatibility alias;
3. profile recommendation;
4. compatibility default (`full`, `standard`) during migration only.

The resolver returns requested, effective, and source values. The driver
receives only the effective values; the ledger receives all three.

### 4.4 Declaration owners

Create import-free declaration leaves following `crew/variants.mjs`:

- `crew/task-profiles.mjs` — closed profile vocabulary, evidence contract,
  recommended execution, and compatibility matrix;
- `crew/assurances.mjs` — canonical names, legacy aliases, order, and public
  descriptions;
- `crew/run-configuration.mjs` — pure resolution and conflict refusal.

Runtime policy continues to read seat allocation from the roster. Declaration
files must not import adapters, the ledger, filesystem state, or the UI.

### 4.5 Brief compiler proposal migration

The current compiler vocabulary has a second overload which must not survive
under new names:

- `proposed tier` recommends seating;
- `proposed shape` uses the same `mechanical|build|judge` values but actually
  describes a risk axis;
- `proposed strength` recommends a model capability band.

That compiler `shape` is not an execution shape and must never be copied into
`execution_shape`. The v2 proposal block becomes:

```json
{
  "recommended_assurance": "standard",
  "recommended_model_band": "workhorse",
  "minimum_assurance": null
}
```

Rules:

- task profile comes from explicit user/intake intent, never mechanical text
  classification;
- execution comes from an explicit request or the selected profile’s declared
  recommendation;
- risk signals may recommend assurance;
- protected-path and other ratified safety rules may set a minimum assurance;
- complexity signals may recommend a model band, not an assurance preset;
- the compiler never chooses an actual model or seat;
- the old proposal block remains readable during migration and records source
  `legacy_proposal` rather than masquerading as effective configuration.

Requested assurance below a recommendation is allowed with a visible warning.
Requested assurance below a ratified minimum refuses or is raised according to
the existing protected-floor policy, with requested and effective values both
recorded.

---

## 5. Ledger contract

### 5.1 Principles

- Additive migrations only.
- JSONL remains the replay authority; SQLite remains the query mirror.
- Requested and effective facts are recorded, not derived later.
- Existing `tier`, `proposed_shape`, and `proposed_strength` columns retain
  their historical meanings.
- Historical nulls are never backfilled by inference.

### 5.2 Run configuration table

Add one row per run:

```text
run_configurations
  adw_id TEXT PRIMARY KEY
  schema_version INTEGER
  task_profile TEXT
  task_profile_source TEXT
  requested_execution TEXT
  effective_execution TEXT
  execution_source TEXT
  requested_assurance TEXT
  effective_assurance TEXT
  assurance_source TEXT
  legacy_variant TEXT
  legacy_tier TEXT
  created_at TEXT
```

The session row remains the run identity and settlement authority. A separate
configuration table avoids changing the meaning of legacy columns and provides
a single versioned snapshot.

### 5.3 Effective seat table

Add one row per effective role allocation:

```text
run_seats
  adw_id TEXT
  role TEXT
  agent TEXT
  provider TEXT
  model_id TEXT
  model TEXT
  effort TEXT
  transport TEXT
  source TEXT
  policy_state TEXT
  warnings_json TEXT
  created_at TEXT
  UNIQUE(adw_id, role)
```

This table records pane and headless seats uniformly. `agent_sessions` remains
the usage/session table and is not stretched into a configuration authority.

### 5.4 Terminal outcome

Keep legacy `sessions.status` readable and add:

```text
sessions.outcome          TEXT NULL
sessions.terminal_reason  TEXT NULL
sessions.terminal_actor   TEXT NULL
```

The new outcome vocabulary is:

- `success` — accepted work completed;
- `escalated` — deliberately handed to a human with context preserved;
- `aborted` — intentionally stopped without acceptance;
- `failed` — runtime or ledger finalizer proved mechanical failure.

New writers set both the legacy status and the new outcome during migration.
For example, escalation continues to write legacy `status=aborted` for old
readers but records `outcome=escalated` for truthful new readers.

### 5.5 Runtime observation and reconciliation

Add append-only observations:

```text
run_observations
  id INTEGER PRIMARY KEY AUTOINCREMENT
  adw_id TEXT
  observed_at TEXT
  observer TEXT
  driver_state TEXT       # alive | gone | unknown
  source TEXT             # daemon | process_group | cmux | heartbeat
  reason_code TEXT
  detail TEXT
```

Derived UI state uses these independent dimensions:

| Dimension | Values | Authority |
|---|---|---|
| Settlement | `unsettled`, `settled` | Session terminal timestamp/outcome |
| Driver | `alive`, `gone`, `unknown` | Latest authoritative observation |
| Recent seat-wait observation | `fresh`, `overdue`, `unmeasured` | Heartbeat timestamp and documented cadence |
| Outcome | null or terminal outcome | Session outcome |

An explicit reconciliation command may settle a session only when:

1. it is still unsettled;
2. the driver/process identity is measured;
3. a current probe proves that identity is gone;
4. no terminal envelope already supplies a more specific outcome;
5. the reconciliation writes actor, reason, observation, and terminal event.

The visualizer can offer “Copy reconciliation command” or link to operator
guidance. It must not invoke reconciliation itself.

### 5.6 API shape

The run API adds:

```json
{
  "configuration": {
    "task_profile": { "requested": null, "effective": null, "source": "legacy_missing" },
    "execution": { "requested": "full", "effective": "full", "source": "explicit" },
    "assurance": { "requested": "standard", "effective": "standard", "source": "legacy_alias" }
  },
  "seats": [],
  "settlement": { "state": "unsettled", "outcome": null, "reason": null },
  "runtime": {
    "driver_state": "unknown",
    "observed_at": null,
    "heartbeat_state": "overdue",
    "last_heartbeat_at": "..."
  }
}
```

Absence reasons remain explicit. API schema version increments when these
fields ship; existing fields remain for one compatibility window.

---

## 6. Driver and profile behavior

### 6.1 Existing shapes

`full`, `directed`, `scout`, and `repair` retain their current stage lists and
acceptance contracts. The configuration resolver selects them; it does not
rewrite their behavior.

### 6.2 `review_only`

Required behavior:

- required seat: reviewer; rigorous assurance may add tech lead;
- requires declared base and head identities;
- no source writes;
- runs repository inspection and permitted validation;
- returns structured findings with severity, evidence, and disposition;
- records “no findings” as a measured outcome, not an empty/missing envelope;
- acceptance is envelope shape plus scope/write proof, not a commit.

### 6.3 `verify_only`

Required behavior:

- required seat: reviewer in v1; a future tester role requires a separate ADR;
- requires declared verification targets and environment assumptions;
- no source writes, while ephemeral build/test artifacts are governed by an
  explicit clean-tree contract;
- records every declared check as passed, failed, blocked, or not run;
- preserves command/result evidence and environmental blockers;
- acceptance is a complete verification report, not necessarily a passing
  product verdict.

### 6.4 Profile evidence gates

Profile evidence validation runs before terminal success:

- implementation: scoped changes + validation + review;
- bug fix: initial failure/citation + final pass + regression evidence;
- investigation: cited findings + zero-write proof;
- code review: declared diff identity + structured verdict;
- QA verification: complete check matrix + environment record;
- test authoring: discrimination proof + suite result.

An evidence defect escalates or refuses acceptance. It does not fabricate a
failed task result.

---

## 7. Roster and policy migration

### 7.1 Roster schema v2

Canonical persisted shape:

```json
{
  "schema_version": 2,
  "assurances": {
    "quick": {},
    "standard": {},
    "rigorous": {}
  },
  "models": {},
  "policy": {}
}
```

The loader accepts schema v1 `tiers` and normalizes it in memory. Repository
patch generation writes only schema v2 after the migration ships. The active
runtime roster changes in a dedicated commit so rollback remains obvious.

### 7.2 Policy language

Rename policy and reason codes where they describe assurance:

- tier floor → assurance floor;
- tier ladder → assurance ladder;
- `tier-judge` → `assurance-rigorous`;
- mechanical/build/judge UI labels → Quick/Standard/Rigorous.

Legacy reason codes remain readable and are mapped at presentation boundaries.
No existing historical event is rewritten.

### 7.3 Draft versus ratified configuration

The roster UI has two intentionally different modes:

- **Explore:** private browser draft, arbitrary syntactically valid model and
  effort, recommendations visible, no active factory change.
- **Publish:** check the draft against capability, price, transport, vendor,
  and assurance rules; then compose a repository patch. Creating a PR remains
  a separate user decision.

This distinction also applies to per-run overrides. The UI may let the operator
try a model, but boot records the warning and applies the explicitly selected
policy boundary.

---

## 8. Visualizer requirements

### 8.1 Task list

- Filter independently by profile, execution, assurance, settlement, outcome,
  and attention reason when those fields are measured.
- Never synthesize profile/execution filters from historical phase names.
- Show friendly assurance labels while retaining the stored legacy key in
  diagnostics.
- Distinguish escalation, abort, and mechanical failure.
- Display **unsettled** separately from **driver alive**.
- Replace “1 open · 1 stale” with language that states the evidence, such as
  “1 unsettled · runtime unconfirmed,” when driver state is unknown.

### 8.2 Task detail

- Keep the configuration strip already introduced by the UI migration.
- Show requested and effective values plus provenance when available.
- Show seat overrides and policy warnings next to the affected seat.
- Present a run-state card with settlement, driver observation, heartbeat
  caveat, latest phase/event, and operator remediation.
- Label historical fields **Not recorded**, not “None” or inferred defaults.

### 8.3 Waterfall and evidence

- Use the execution shape to explain the expected stage topology.
- Use the task profile to explain why each evidence block matters.
- Keep measured factory checkpoints correlated to their owning phase.
- Render review findings, verification checks, bug reproduction, and test
  discrimination as profile-specific summaries before raw payloads.
- A missing expected stage is a configuration/execution defect; an undeclared
  stage is never silently accepted into the trace.

### 8.4 Operations

- Aggregate throughput and outcomes by profile, execution, and assurance.
- Show escalation causes separately from failures.
- Show override use and recommendation warnings as operational evidence.
- Report unsettled sessions by driver state: alive, gone, unknown.
- Make “needs attention” counts derive from one shared classifier so summary,
  tabs, and cards cannot disagree.

### 8.5 New-run configuration UI

When the factory exposes a launch surface, use a four-step reviewable flow:

1. Choose task profile and see its required outcome/evidence.
2. Accept or change a compatible execution shape.
3. Choose assurance and see seats/oversight.
4. Review actual models, efforts, warnings, overrides, and the final command.

The UI submits explicit values. It never hides a classifier guess as a user
choice.

---

## 9. Implementation plan

### Phase 0 — UI semantic checkpoint

Already prepared in the working tree:

- assurance terminology across roster, task list, task details, and cell
  health;
- an honest task-profile/execution/assurance configuration strip;
- conditional filters which appear only when data exists;
- historical “Not recorded” behavior;
- shared UI semantics in `visualizer/web/src/lib/workflow-semantics.js`.

Acceptance: current build and visualizer tests pass, with no runtime behavior
change.

### Phase 1 — Declarations and resolver

1. Add the three import-free declaration modules.
2. Add closed-enum and compatibility tests.
3. Add the pure requested/effective/provenance resolver.
4. Pin profile-to-execution compatibility and alias conflict refusals.
5. Record an ADR for the five-axis separation.

Acceptance: every valid combination resolves deterministically; every invalid
combination refuses before filesystem or process effects.

### Phase 2 — Entry points and propagation

1. Add canonical flags to `factoryctl`, daemon run specs, batch intake, and
   direct crew entrypoints.
2. Preserve compatibility aliases and warnings.
3. Carry the resolved configuration through boot and run records.
4. Ensure boot and run cannot disagree about the resolved configuration.
5. Replace the compiler’s overloaded proposal fields with recommended
   assurance, recommended model band, and minimum assurance.
6. Dual-read the old proposal block without treating it as effective state.
7. Update command help, README examples, and dispatch skill references.

Acceptance: one fixture proves the same configuration at CLI parse, daemon
record, boot record, driver context, and emitted ledger event.

### Phase 3 — Ledger schema and writers

1. Add `run_configurations`, `run_seats`, and `run_observations`.
2. Add session outcome/reason/actor columns.
3. Add JSONL writers and replay handlers before mirror-only behavior.
4. Emit effective seats at boot for every transport.
5. Record actual execution and assurance rather than compiler proposals.
6. Add additive migration, replay, absence, and old-ledger tests.

Acceptance: a fresh run can be fully explained from ledger queries; an old run
remains readable with explicit absence.

### Phase 4 — Profile execution

1. Add `review_only` and `verify_only` declarations and driver branches.
2. Add profile evidence validators.
3. Add structured envelopes for review and verification.
4. Preserve zero-write and clean-tree guarantees.
5. Add non-vacuous mutation/negative-control tests for each profile.

Acceptance: all six profiles execute a compatible shape and cannot claim
success without their declared evidence.

### Phase 5 — Assurance and roster migration

1. Introduce roster schema v2 and v1 normalization.
2. Rename runtime policy vocabulary and public diagnostics.
3. Preserve current staffing, floors, protected paths, and reseat order.
4. Update the visualizer’s roster patch composer to write v2.
5. Remove compatibility writes only after one full release window.

Acceptance: v1 and v2 rosters resolve to byte-equivalent effective seats in
compatibility fixtures.

### Phase 6 — Liveness and the unsettled-record problem

1. Define authoritative driver identities for daemon, process-group, and cmux
   transports.
2. Emit observations from existing lane/process probes.
3. Add a bounded reconciliation command with dry-run and evidence output.
4. Record escalation distinctly from abort.
5. Update API shaping and UI copy for settlement versus driver state.
6. Add the current “1 open · 1 stale” shape as a regression fixture.

Acceptance: the UI can say “alive,” “gone,” or “unknown” with a cited source;
it never equates an old heartbeat with a dead driver, and reconciliation cannot
settle a live or unmeasured process.

### Phase 7 — Reporting and rollout

1. Add profile/execution/assurance dimensions to task and operations queries.
2. Add requested-versus-effective and override reporting.
3. Update `docs/ledger-queries.md` with canonical recipes.
4. Add schema/version telemetry and compatibility warnings.
5. Remove UI compatibility fields only after corpus coverage is measured.

Acceptance: summary counts reconcile with task filters and detail views over
the same fixture corpus.

---

## 10. File impact map

| Area | Primary files |
|---|---|
| Declarations | `crew/task-profiles.mjs`, `crew/assurances.mjs`, `crew/run-configuration.mjs`, `crew/variants.mjs` |
| Runtime resolution | `crew/crew.mjs`, `crew/drive.mjs`, `crew/daemon.mjs`, `crew/factoryctl.mjs` |
| Intake/compiler | `scripts/factory/make-brief.mjs`, `scripts/factory/dispatch-batch.mjs` |
| Ledger | `scripts/factory/ledger.mjs`, `scripts/factory/emit.mjs`, `docs/ledger-queries.md` |
| Liveness | `crew/seat-io.mjs`, `scripts/factory/lane-watch.mjs`, a dedicated reconciliation command |
| Roster | `crew/roster.json`, roster loader/editor/ladder modules and schemas |
| API shaping | `visualizer/server/shape.mjs`, visualizer feed/server routes |
| Visualizer | `TaskList.svelte`, `RunDetail.svelte`, `MetricsStrip.svelte`, `RosterPanel.svelte`, operations panels |
| Tests | crew, ledger, factory, visualizer shape/panel/server, roster-edit, and liveness fixtures |

---

## 11. Verification strategy

Every phase must include:

- pure closed-enum and resolver tests;
- CLI unknown/missing/conflicting flag tests;
- no-side-effect-before-refusal assertions;
- JSONL replay and additive SQLite migration tests;
- historical absence tests;
- cross-layer equality fixtures;
- visualizer source-shape and rendered-state tests;
- mutations proving each evidence gate is non-vacuous;
- liveness tests using real child processes where process identity matters;
- count reconciliation tests across summary, filter, and detail surfaces.

Release gates:

1. `npm test` passes.
2. `npm run viz:build` passes.
3. Old ledger and roster fixtures remain readable.
4. No new UI inference from phase names, seat count, or prose.
5. An escalation is not counted as a failure.
6. An old heartbeat is not called a dead task.
7. No visualizer route can reconcile or terminate a run.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| New vocabulary becomes another parallel source of truth | Import-free declarations and one resolver consumed by every entrypoint |
| Alias migration changes effective staffing | v1/v2 equivalence fixtures and dual-read, canonical-write rollout |
| Profile defaults silently override operator intent | Requested/effective/source fields and conflict refusals |
| Experimental models bypass production policy | Separate Explore and Publish/Boot boundaries; record policy state |
| Historical rows appear falsely complete | No backfill by inference; explicit absence reasons |
| Heartbeat age is mistaken for process death | Separate observations, documented cadence, authoritative process probe |
| Reconciliation destroys escalation context | Visualizer stays read-only; reconciler requires proven gone identity and records actor/reason |
| New review/QA shapes become aliases with no real contract | Dedicated seats, artifacts, acceptance rules, and mutation tests |

---

## 13. Decisions still requiring an ADR, not a user guess

The implementation may proceed with the recommendations above, but these
decisions must be recorded before their corresponding phase lands:

1. Canonical run-configuration separation and alias deprecation window.
2. Exact structured envelope schemas for `review_only` and `verify_only`.
3. Whether a dedicated tester role is warranted after `verify_only` is measured.
4. The authoritative process identity/probe per transport.
5. Reconciliation reason codes and operator authority.
6. The release at which schema v1 roster writes are removed.

None of these decisions blocks the already completed UI semantic checkpoint.

---

## 14. Definition of done

The rework is complete when a newly launched task can be followed end to end
without overloaded terminology or inference:

- the request records an explicit task profile;
- a compatible execution shape and assurance preset are resolved with
  provenance;
- effective seats and overrides are durable facts;
- profile-specific evidence governs acceptance;
- escalation, abort, and failure remain distinct;
- settlement and driver liveness remain distinct;
- the visualizer explains the same facts consistently on Tasks, task detail,
  Operations, and Roster;
- historical runs remain readable and visibly incomplete where appropriate;
- the “1 open · 1 stale” class is rendered as an unsettled record with an
  authoritative or explicitly unknown runtime state, never as a guessed live
  or dead task.
