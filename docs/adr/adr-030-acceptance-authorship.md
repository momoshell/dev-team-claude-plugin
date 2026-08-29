# ADR-030: Acceptance authorship — the seat that plans may draft the gate, but only a proof may accept it

**Status:** RATIFIED 2026-08-14 · **Amended:** 2026-08-19 (§10 — gate custody, #334/PR #348); 2026-08-20 (§11 — module rename, #327); 2026-08-20 (§10 anchors re-derived, #406) · **Source:** issue #166 (from #142) · **Evidence:** #142, PR #162 (#144), #153/PR #154, #130/PR #156, PR #163/#164

Ratified with three amendments to the proposal, each recorded inline at the
decision it changes and summarised in §9: Decision 2 adopts in **two stages**
(the stash-isolation test lands before a failed proof can block); Decision 3's
trigger measures **cumulative growth from round 1** with absolute sizes and the
`files_in_scope` count as the evidence, rather than 1.25× round-over-round; and
Decision 5 **splits into two phases**, of which only phase 1 — structured
findings with stable IDs and severity — is commissioned now. Decisions 1, 4 and
the numbering choice are ratified as proposed.

## 0. Scope and what this ADR does not reopen

The gate-first workflow, a RED-at-baseline gate, and the requirement for a
parseable `GATE-SUMMARY` with `errored: 0` are ratified input from #153/PR #154.
This record layers acceptance authorship and evidence on top of those rules; it
does not reopen them. A non-zero gate exit is still required for a red baseline,
and an absent or malformed summary is not evidence that checks ran.

The changes commissioned by this ADR stay dependency-injected and bounded.
They add no new unbounded loop: proof runs are bounded by the existing
`gate_repairs` limit, and plan-check remains bounded by `LIMITS` (`crew/drive.mjs:17-25`).
The implementation must degrade sanely when no lead or no tech-lead is seated.
In particular, a missing lead must continue to escalate rather than invent an
answer, and a missing tech-lead must not make the driver manufacture a
plan-check verdict. This is a decision record, not a code change.

## 1. Context — the acceptance signal is graded by the seat it grades

Issue #142 diagnosed a loop with no fixed point: the planner authored both the
plan and the gate, and each new gate check became fresh surface for the next
check to falsify. The measured artifacts were **73,308 bytes** for `plan.md`
and **102,241 bytes** for `gate.mjs`, for a build of about **500 lines**. The
trace was `plan:r1 | check:r1 | plan:r2 | check:r2 | plan:r3 | check:r3 |
escalate:plan-check`: three planning rounds, including one extra round, and
zero build rounds. Four of six round-three findings were gate defects, not plan
defects. One concrete example was G61, which claimed that P2 enqueued nothing
while calling `acquireLeases`, a function that takes no enqueue parameter, so
the assertion could not fail (#142; `crew/drive.mjs:367-420`).

The same failure appeared in the acceptance artifact. On 2026-08-14 a
34-check gate returned byte-identical per-check output with and without the
work under test: zero discrimination. Another run produced seven reviewer
findings, four with runnable reproductions, while the gate was 50/50 green;
the HIGH finding concerned orphan temporary lease files that could make a park
unsettleable forever. The hand-run repair proof did discriminate—49/50 with the
work versus 4/50 without it, with `errored: 0` in both runs, followed by 50/50
after the commit—but the driver did not perform that proof (PR #163/#164; #166).

Review provides the other failure mode. In #144/PR #162 the reviewer returned
`changes-needed`, review rounds exhausted, and the lead accepted with residuals.
That call was reasonable on what the lead could see, but the residual turned
out to be two stranded tiers: `mechanical` and `build`, including the default
working tier, were unbootable because the implementation and roster
contradicted each other. A human later booted all three tiers and fixed the
issue (PR #162).

The shape of the problem, in #166's own words, is that the acceptance signal
was authored or arbitrated by the same seat whose work it graded, while nothing
measured whether the signal could discriminate. The phrase “a check that
cannot fail hides in the crowd” belongs to #166, not #153; #153's related
observation was that an un-runnable check is invisible at a red baseline. This
ADR therefore separates authorship from proof, makes growth and carving
explicit plan-check inputs, and makes residual acceptance a typed claim.

## 2. Decision 1 — who authors `gate.mjs`

The question is whether moving gate authorship to a reviewer or tech-lead is
the right answer to the self-grading signal, or whether the artifact needs a
stronger acceptance boundary.

**Decision:** choose **(d)**. The planner keeps authorship of `gate.mjs`, but the
gate is not accepted until a mechanical proof demonstrates that it can
discriminate, as specified in Decision 2. Authorship is not treated as moot:
it remains a useful risk signal and a tier can take authorship away, while a
proof can run wherever the driver runs.

The measured failure was not demonstrable author bias. A biased author and a
careless author can produce the same artifact. The missing property was a test
of the artifact: whether the gate's result changes between the tree containing
the work and the pristine tree. That property is testable without first
identifying who wrote the gate. The whole-gate proof closes the byte-identical,
whole-gate vacuity seen in #166, but it does not prove that each individual
check can fail. G61 remains a residual risk, as does omitted coverage: no check
can flip for behavior that the gate never wrote. Those risks are carried by
Decision 2's re-entry condition rather than hidden by the authorship answer.
The no-fixed-point outcome in #142 is addressed by Decisions 3 and 4: plan-check
must converge before any gate runs (`crew/drive.mjs:367-420`, compared with the
first gate read at `:452` and per-round run at `:571-573`), so a proof cannot
repair a run that spent zero build rounds in an unconverged plan loop.

This decision does not depend on a lead. If no lead is seated,
`consultLead` already returns `escalate` with zero assignments
(`crew/drive.mjs:240-244`); planner authorship and the driver's mechanical proof
remain facts, while a human decision still escalates. If no tech-lead is seated,
the plan-check block is skipped (`crew/drive.mjs:383`), but the planner still
produces the gate and the driver can run the proof. No tier substitutes a lead
or tech-lead merely to change who owns this artifact.
This paragraph is about authorship only: since #334/PR #348 the *repair* of an
accepted gate depends on a seated lead (§10), and a crew without one escalates
rather than assigning any other seat.

**Rejected:** (a) **status quo**—two vacuous gates appeared in one day, and #142
already measured a no-fixed-point loop; (b) **reviewer authors the gate from the
accepted plan**—that would serialize plan to gate before any build, require a
new pre-build assignment, a charter change, and a repair owner, while buying no
guarantee that the reviewer's gate discriminates; the property would still need
mechanical proof; (c) **tech-lead authors it**—only the `judge` tier seats a
tech-lead (`crew/roster.json:52-83`), so the gate author would disappear for two
of three tiers, and the driver already skips the entire plan-check block when
that seat is empty (`crew/drive.mjs:383`).

## 3. Decision 2 — the driver proves discrimination mechanically

A pristine re-proof already exists on the repair path, but it is reachable only
after reviewer triage and currently accepts any non-zero pristine exit. The
question is whether that machinery should become the normal acceptance proof,
and what observation would justify stronger per-check work.

**Decision:** **yes**. The driver promotes a bounded, whole-gate pristine proof
and uses one predicate everywhere.

- **Gate generation is driver-owned.** `driveTask` keeps a `gate_generation`
  counter. Generation 1 is the planner's original `gate_cmd`; the counter
  increments whenever a **custodian**-returned replacement is accepted on the
  repair path (`GATE_CUSTODIAN`, §10)—even when the command string is identical. The repair brief explicitly
  permits returning an identical command, and editing `gate.mjs` in place leaves
  `node …/gate.mjs` byte-identical (`crew/drive.mjs:583-588`). Command text or a
  hash is therefore not identity. `details.gate`, the journal line, the emitter
  payload, and #169's ledger rows and queries all key on `{run, gate_generation}`.
  This is the driver's identity, not a fact inferred by a caller.
- **Proof invariant:** run the pristine proof at the first green of each gate
  generation. It is bounded by `1 + gate_repairs`, hence at most two pristine
  runs under today's frozen `LIMITS` (`crew/drive.mjs:17-25`;
  `crew/drive.test.mjs:1142-1147`). It is never rerun for every build round.
- **One predicate everywhere:** the pristine command must exit non-zero, emit a
  parseable `GATE-SUMMARY`, have `errored === 0`, and have `failed >= 1`. This is
  `baselineGateDefect` (`crew/drive.mjs:76-82`) reused for the repair re-proof.
  A missing summary, a crash, or an errored check is not discrimination. This
  corrects the current `gate-reverify` path, which trusts only `pristine.ok`
  (`crew/drive.mjs:595-603`).
- **Routing:** a failed proof is a gate defect.
  The driver bounces the **gate custodian** — `GATE_CUSTODIAN = 'lead'`
  (`crew/drive.mjs:218`) — consumes the existing single `gate_repairs` budget,
  and never bounces the builder for evidence about the gate. A second failed
  proof escalates. The repair consumes no builder round, as the repair path
  does (`crew/drive.mjs:2085-2142`). A crew booted without that custodian
  assigns nobody: `noGateCustodian()` escalates with the site's own diagnosis
  attached (`crew/drive.mjs:1246-1253`). *(Routing amended 2026-08-19 — §10;
  the three invariants in this bullet are unchanged.)*
- **Cost and record:** there are at most two extra gate runs per task. Each is
  recorded on `details.gate` beside `reverified`, and the named journal,
  emitter, and ledger representations use the generation key. The gate is not
  rerun merely because a build round occurred.
- **Staged adoption — the proof does not block until its own machinery is
  tested** *(amended at ratification, 2026-08-14)*. This decision promotes
  `runClean` from a rare repair-path operation to a normal-path one on every
  task, and `runClean` is `git stash push --include-untracked` followed by
  `git stash pop`. `crew/realio.mjs` already carries an error string for the
  case where the pop fails and leaves the checkout half-restored **with the
  builder's work in the stash** — a failure mode that is survivable when it can
  only occur after a gate repair, and unacceptable as a per-task risk. The
  stash-isolation coverage this decision commissions in #168 (ignored paths,
  `node_modules`, and the outer-`realIo` pin) therefore lands FIRST. Until it is
  green, a failed or unavailable pristine proof records
  `discrimination: 'unproven'` and does not bounce; once it is green, a failed
  proof is a gate defect on the routing above. A stash or pop failure always
  records `unproven` and never fails the run, in either stage — the proof is
  evidence about the gate, and it may not become a new way to lose a build.
  This preserves the decision's own asymmetry: absence of evidence is not
  evidence of absence, and only the latter blocks.
- **Interaction with #153:** `errored: 0` makes a red pristine run mean that
  every check ran and adjudicated, rather than that the gate crashed. #153
  enforced this at baseline and deliberately left post-build runs unchanged;
  this decision closes that gap (`#153/PR #154`, `crew/drive.mjs:76-82`).
- **Availability is not tier degradation.** Production always drives on the
  outer `realIo`: `crew/crew.mjs:459` passes it to `driveTask`, transports are
  used only inside assignment/wait, and `runClean` is on the outer object
  (`crew/realio.mjs:178-207,252-268`). A headless-transport seat therefore still
  has `runClean`. The `unproven` fallback is only for a direct or custom DI
  caller that omits the optional member; that run records
  `discrimination: 'unproven'` and proceeds. Production has no such caller.
  A DI test must pin the outer-`realIo` behavior.
- **The measurement must be built before it can be read.** #130 makes gate
  verdicts durable but has no discrimination outcome and no durable review
  verdict or must-fix count (`scripts/factory/ledger.mjs:187-200`,
  `crew/realio.mjs:91-108`). [deprecated 2026-08-21 — superseded by §12: both outcomes are durable] Decision 2 commissions #169 to add a durable
  discrimination outcome keyed by `{run, gate_generation}` and a durable review
  outcome carrying at least a normalized verdict and `must_fix` count. Each has
  a named journal line, emitter call, ledger column, and DI tests.
- **Re-entry for stronger proof has a start condition and a recordable trigger.**
  The observation horizon starts only after both #168 and #169 have landed, not
  at ratification. Until then there are zero observations. The denominator is
  the next **20 eligible production tasks** after that point. A task counts only
  when it carries both a durable `proven` outcome for its active gate generation
  and a durable review outcome. An instrumentation drop or degradation under
  ADR-026 does not count toward the 20.
- The trigger is the first eligible task whose review returns `must_fix > 0`
  after that task's gate has passed its proof. `must_fix` is used exactly: the
  reviewer records severity counts and has no correctness/category field
  (`crew/roles/reviewer.md:31-33`), while a must-fix already is the runtime's
  “not safe to accept” class (`crew/roles/reviewer.md:25-28`). This ADR does
  not commission a correctness field; a future slice that wants one must add
  and own it rather than infer it from a count.
- The future design must not require every check to flip. An invariant check can
  legitimately hold on both trees, and omitted coverage has no check to flip at
  all. Whole-gate proof is the commissioned floor; per-check discrimination is
  deliberately a re-entry question, not an unbounded mutation-testing project
  now.

With no lead seated, the driver still records the mechanical proof, but the
repair it would route needs the gate custodian: `noGateCustodian()` turns that
site into an escalation carrying the site's own diagnosis, and
no other seat is substituted (`crew/drive.mjs:1246-1253`; amended 2026-08-19 —
§10). With no tech-lead seated, plan-check is absent, but the driver's gate
generation and pristine proof remain available for every production tier.
Neither absence is described as a missing `runClean` capability.

**Rejected:** proving discrimination by prose in the brief—the status quo
already demanded that and both vacuous gates cleared it; running the pristine
proof at every gate round—the property cannot change unless the gate generation
changes; bouncing the **builder** on a failed proof—the evidence is about the
gate, and #153's incident shows that misrouting a gate defect burns nine stages;
keying identity on the command string or its hash—identical commands are
explicitly permitted on repair (`crew/drive.mjs:583-588`); and mutation-testing
the gate now—stronger proof would require a harness that does not exist and
would spend build budget on that harness. [deprecated 2026-08-21 — superseded by §12: the mutation harness shipped in #420]

## 4. Decision 3 — growth as a plan-check input

The plan-check loop can currently see only its round budget, even though plan
and gate files are already on disk. The question is whether size should become
a verdict in its own right.

**Decision:** **yes, as evidence with a named trigger, never as an automatic
verdict.** For each plan-check round, the driver records
`{round, plan_bytes, gate_bytes, plan_delta, gate_delta, files_in_scope_count}`
and embeds the result in the next plan-bounce brief and the tech-lead check
brief. A round is labeled `divergent` when it is round 2 or later and combined
plan-plus-gate bytes are at least **2× the ROUND-1 combined bytes** — cumulative
growth from the plan's own starting point, not growth against the immediately
preceding round.

*Amended at ratification (2026-08-14).* The proposal measured round-over-round
growth at 1.25×. That fires on a plan legitimately deepening — a round 2 that
adds the section its own check demanded trips it — and a label that fires on
healthy rounds is one the seats learn to ignore, which is worse than no label.
What failed in #142 was not any single round's delta: it was **175KB of plan
plus gate describing a ~500-line build**. The signal is artifact size relative
to the work, so the trigger measures cumulative divergence from where the plan
started, and the evidence carries the **absolute** plan and gate bytes beside
the plan's declared `files_in_scope` count — a reader comparing 175KB against
four in-scope files needs no ratio at all. This amends the threshold's
denominator, not the evidence-only character of the signal; the rejected
alternatives below stand unchanged.

Plan bytes come from `details.plan_path` (`crew/drive.mjs:422`). Gate bytes
come from a new explicit `details.gate_path`, which is task-directory-contained
and validated when supplied; when absent or unmeasurable, the measurement is
reported as `null`. The driver does not parse `gate_cmd`: it is a command, and
shell quoting, wrappers, environment prefixes, and multiple path arguments make
path extraction ambiguous and untestable. Because plan-check runs entirely
before any build (`crew/drive.mjs:367-420`, before `:571`), “no build in sight”
is the ambient condition, not a `build_rounds_used` field. This is
instrumentation, never load-bearing under ADR-026: a failed measurement changes
neither an outcome nor the escalation route.

Growth is evidence handed to the seats that can reason about scope. It is not a
proxy for correctness, and the threshold does not automatically bounce or carve
a plan. Direction 1 of #142 says, verbatim, “**Size/growth as a first-class
plan-check input.** Plan and gate bytes per round are already on disk. A
monotonic-growth signal with no build in sight is a scope verdict the code
could compute and hand the lead as *evidence*, rather than the lead inferring it
from having read three plans.” The measured 73,308-byte plan, 102,241-byte gate,
and approximately 500-line build are the motivating numbers (#142).

If no tech-lead is seated, the plan-check block does not run at all
(`crew/drive.mjs:383`), so no `divergent` check verdict is manufactured. The
signal may still be present in the journal and emission for an escalation
payload, where nobody consumes it at that tier. If no lead is seated, the
signal remains evidence and a lead consultation follows the existing
zero-assignment escalation path. No tier gets an automatic carve merely because
it lacks a judgment seat.

**Rejected:** an automatic bounce or auto-carve at a byte threshold—bytes are a
proxy and a genuinely large but complete task would be refused, while #142
explicitly declined to choose that verdict; LOC or token counts—LOC is not the
on-disk fact and token counts depend on a tokenizer; and holding the signal
until a human asks—this is the existing failure, in which the lead inferred
growth only after reading three plans and the driver recorded nothing.

## 5. Decision 4 — a carve verdict the planner returns

A scope escape hatch currently exists only as prose. The question is whether a
planner must make a closed choice when revision has not converged.

**Decision:** **yes: require a closed enum, do not merely offer it.** From any
plan revision (round 2 or later), the planner envelope must carry
`details.carve_verdict` equal to exactly `"proceed"` or `"carve"`. A `"carve"`
answer must also carry `carve_slices: [{summary, files_in_scope}]`, and the
first slice must be buildable alone. The choice belongs to the seat that wrote
the plan; it is not a fourth lead decision.

The driver needs a new per-round branch immediately after each planner envelope
and before `check:r{n}`. On revision rounds it validates the enum. `carve`
validates the slice list, then escalates carrying those slices as the human
handoff. A missing or out-of-enum value is an invalid decision and escalates;
the driver must not silently treat it as `proceed`. The existing
`crew/drive.mjs:430-442` block is post-loop scope/lane validation after a plan
has already been accepted, not this per-round branch, and must not be cited as
an implementation of this route. Direction 4 of #142 states: “**A carve verdict
the planner can return.** ... An offer in prose is weaker than an enum.” This
makes the escape hatch reachable without letting the driver invent issue scope.

The escalation handoff exists at every tier. With no tech-lead, there is no
`check:r{n}`, but a plan **revision** is still reachable through the round-1
status bounce (`crew/drive.mjs:367-383`): the planner can return
`status: insufficient`, the lead can bounce it, and round 2 assigns
`plan-revision` even without a tech-lead. The carve branch therefore applies at
`build`, which has a seated lead but no tech-lead (`crew/roster.json:26-51`). At
`mechanical`, the missing lead makes `consultLead` escalate on that same bounce
(`crew/drive.mjs:240-244`), so round 2 is never reached and the rule is vacuous
there. A planner-provided slice can be carried as context rather than accepted
as an automatic split. This is deliberate degradation, not a tier-specific
alternate schema.

**Rejected:** adding a fourth member to `DECISIONS` (`crew/drive.mjs:34`)—that
enum is the lead's answer surface, consumed through `askLead` subsets
(`crew/drive.mjs:329-332`), while carve knowledge belongs to the plan author;
letting the driver split the task itself—the driver has no authority over issue
scope and would mint work nobody owns; and keeping `status: insufficient` as
the only route—that is a whole-envelope failure mode, forcing a planner whose
plan is correct but too large to misreport in order to request a carve, which
is why the prose escape hatch was never taken (#142).

## 6. Decision 5 — accept-with-residuals must classify its residuals

At exhaustion a lead can currently surface an `accepted_via` string, but the
reviewer returns counts rather than finding identities. The question is whether
acceptance with residuals can be refused mechanically without pretending that
free text is a finding ledger.

**Decision:** **yes — in two phases, and only phase 1 is commissioned now**
*(amended at ratification, 2026-08-14)*. Acceptance with residuals is a closed,
code-validated claim, but the canonical finding set must exist first, and the
enforcement half rests on a single incident.

- **Phase 1 — commissioned (#170).** The reviewer contract returns a findings
  array with a stable per-review ID and severity alongside the existing counts.
  This is a runtime-wide contract migration: `SEAT_DEFAULTS` gives every crew
  the shared `reviewer.md` (`crew/crew.mjs:69-74`), every crew requires a
  reviewer because the driver assigns one unconditionally
  (`crew/crew.mjs:427-429`), and the shared role contract, envelope validation,
  fixtures and contract tests move together. Phase 1 is **pure addition**: no
  acceptance path changes, nothing fails closed, and #169's "was the gate green
  while review found a must-fix" query needs exactly this data regardless of
  what phase 2 concludes.
- **Phase 2 — specified here, NOT commissioned.** Typed residuals, the
  severity constraint, and the fail-closed invalid accept described below.
  Start condition: phase 1 shipped **and** at least 20 tasks of finding data
  exist, **or** a second residual-accepted correctness incident occurs —
  whichever comes first. The trigger is recordable from the phase-1 data; it is
  not a matter of anyone's recollection.

Rationale for the split: the mechanism is sound and lifted from a reference
implementation where it is proven, but the *evidence* is one incident (#144),
which §7 already concedes. The migration is the largest change this ADR
commissions, and building the enforcement before its own shape can be observed
is the mistake this document exists to name. Sequencing also unblocks #169,
which would otherwise wait behind a contract migration it does not need.
Everything below specifies phase 2 and is ratified as the design to build when
its start condition is met — not as work to start now.

At exhaustion (`crew/drive.mjs:628-646,661-679`), every unresolved finding from
the last review must appear exactly once across one of these two arrays:

- `residuals: [{id, type}]`, where `type` is exactly
  `"cosmetic"` or `"correctness-unverified"`; or
- `refuted: [{id, evidence}]`, where `evidence` is non-empty.

Severity constrains the lead's type claim. A **must-fix** may appear only as a
`correctness-unverified` residual—which escalates—or in `refuted` with
non-empty evidence. Marking a must-fix `cosmetic` is invalid. `cosmetic` remains
available for should-fix and consider findings. Any correctness-unverified
residual escalates.

An unknown, duplicate, or omitted ID, an invalid type, empty evidence, or
missing details makes the decision invalid. An invalid `accept` fails closed to
`escalate`; `askLead` already coerces out-of-subset answers to escalation
(`crew/drive.mjs:329-332`). Silence is not converted into a synthetic residual:
manufacturing a finding would corrupt the record. The residual/refuted result
gets its own named journal line and ledger row, owned by #170. If it shares a
ledger primitive with #169's measurement rows, that is a dependency, not a
transfer of ownership.

This turns the lead charter's existing prose—“Accept is for should-fix-later,
never for must-fix-now” (`crew/roles/lead.md:43-45`)—into a mechanical boundary.
It also preserves the lesson of #144/PR #162: the reviewer was right, and the
lead's call was reasonable on what it could see, but the residual was an
unnoticed runtime compatibility defect rather than a documentation fix.

With no lead seated, `consultLead` already returns `escalate` with zero assigns
(`crew/drive.mjs:240-244`), so there is no accept path to constrain in the
`mechanical` tier. With no tech-lead, plan-check is independently skipped; if a
lead is available at review exhaustion, this validation still applies. No
special tier branch weakens the severity rule.

**Rejected:** free-text residuals—the status quo's `accepted_via` is prose and
carries no finding list, so downstream code cannot act on it; letting the lead
type any finding `cosmetic`—that would permit a must-fix downgrade with no
evidence, contrary to both charters and the source question; treating a missing
residual list as `correctness-unverified`—silence is not evidence about a
finding, so invalid input must fail closed instead; a numeric severity threshold
instead of a two-value type—severity is the reviewer's word about the finding,
while type is the lead's claim about the risk of not fixing it; and removing
`accept` at exhaustion—rounds are exhausted by definition, so that would be a
`LIMITS` budget change, not an authorship decision.

## 7. Evidence gaps this ADR decides around

| Gap | Evidence | How this ADR decides around it |
|---|---|---|
| No observations exist today | Neither a discrimination outcome nor a review outcome is durable today (`scripts/factory/ledger.mjs:187-200`, `crew/realio.mjs:91-108`) [deprecated 2026-08-21 — superseded by §12: both outcomes accrue] | The Decision 2 horizon has not started and cannot start until #168 and #169 land. The first denominator is then the next 20 eligible tasks, not ratification or historical anecdotes. |
| `runClean` stash isolation has not been tested against writes outside git's view | `crew/realio.mjs:252-268` stashes `--include-untracked`; no cited test covers ignored paths or `node_modules` | A DI test is commissioned; a direct caller omitting `runClean` records `discrimination: 'unproven'`. Production uses outer `realIo`. |
| Per-check and omitted-check adequacy are unmeasured | The commissioned proof is whole-gate only; G61 in #142 is an example of a check that could not fail, and omitted coverage has no check to flip | The ADR does not claim per-check discrimination. The #168/#169 horizon and `must_fix > 0` trigger are the re-entry condition for stronger work. |
| The `cosmetic` / `correctness-unverified` split has only one data point | #144/PR #162 supplies the residual-accepted incident; the reviewer currently records severity counts only (`crew/roles/reviewer.md:31-33`) | #170 first creates stable finding IDs and severity, then validates typed residuals and refutations. No correctness category is inferred from severity. |
| A direct DI caller may omit `runClean` | `runClean` is optional in the DI contract (`crew/drive.mjs:163-165`); production reaches it through `realIo` (`crew/crew.mjs:459`) | Such a run is explicitly `unproven` and proceeds because instrumentation is non-load-bearing under ADR-026. It does not count as an eligible durable proof observation. |

## 8. Consequences and owner slices

This ADR changes no code. #168, #169 and #170 were filed against it and are now
unblocked, in the staged order the amendments set: #168's stash-isolation
coverage before its proof can block, #170 phase 1 (structured findings) before
any typed-residual enforcement, and #169 free to proceed as soon as phase 1
lands. Per-check discrimination is deliberately
absent from this table: its start condition, denominator, and trigger live in
Decision 2 and the evidence-gap table, but it is not commissioned now. [deprecated 2026-08-21 — superseded by §12: per-check discrimination shipped in #420]

| Consequence | Owner |
|---|---|
| Driver-owned `gate_generation`; discrimination proof at the first green of each generation, bounded by `1 + gate_repairs`; full `baselineGateDefect` predicate on repair re-proof; gate-defect bounce routing (to the gate custodian since #334/PR #348 — §10); `discrimination` on `details.gate`; DI tests | #168 |
| Test pinning that a headless-transport seat still drives on the outer `realIo` and therefore has `runClean`; stash-isolation coverage for ignored paths and `node_modules` | #168 |
| Durable discrimination outcome keyed on `{run, gate_generation}`, and durable review outcome with normalized verdict and `must_fix` count, with named journal/emitter/ledger representation and DI tests | #169 |
| Structured reviewer findings with stable IDs and severity—a runtime-wide migration of `reviewer.md`, envelope validation, fixtures, contract tests, and the exhaustion path; severity-constrained typed residuals/refuted-with-evidence; invalid accept fails closed; durable residual/refuted record | #170 |
| Growth signal per plan-check round, `divergent` label in bounce and check briefs, explicit task-contained `details.gate_path`, and non-load-bearing measurement | #142 |
| Required `carve_verdict` enum on plan revisions, validated in a new branch before `check:r{n}`, with escalate-with-slices on `carve` | #142 |

The owner issues are real filed slices, not a new permission to implement before
ratification. #142 remains the owner of its growth and carve directions; #168,
#169, and #170 own the new proof, measurement, and residual contracts
respectively.

## 9. Ratification record — 2026-08-14

All six questions were answered by the user. Three were ratified as proposed;
three were amended, and each amendment is written into the decision it changes
rather than left as a note here.

1. **Decision 1 — ratified as proposed.** The planner may author `gate.mjs`;
   authorship alone never accepts it. The reasoning that carried it: a biased
   author and a careless author produce the same artifact, so the missing
   property was a test of the artifact, not a change of author.
2. **Decision 2 — ratified, AMENDED to adopt in two stages.** The proof is
   correct and is the answer to the day's vacuous gates, but it promotes
   `runClean` — `git stash push`/`pop` — from a rare repair-path operation to a
   per-task one, and a failed pop leaves the checkout half-restored with the
   builder's work in the stash. The stash-isolation coverage commissioned in
   #168 lands first; until it is green a failed or unavailable proof records
   `discrimination: 'unproven'` and does not bounce. A stash or pop failure
   records `unproven` in either stage and never fails a run.
3. **Decision 3 — ratified, AMENDED trigger.** Evidence-only stands. The
   threshold moves from 1.25× round-over-round to **2× the round-1 combined
   bytes**, and the evidence carries absolute plan and gate sizes beside the
   declared `files_in_scope` count. Round-over-round growth fires on a plan
   legitimately deepening, and a label that fires on healthy rounds is one the
   seats learn to ignore; what failed in #142 was 175KB describing a ~500-line
   build, which is a cumulative ratio, not a per-round one.
4. **Decision 4 — ratified as proposed.** The `proceed|carve` enum is required,
   not offered. The prose escape hatch was offered twice and taken zero times —
   once declined in writing by a planner's own D1.
5. **Decision 5 — ratified, AMENDED into two phases.** Only **phase 1** is
   commissioned: structured findings with stable IDs and severity, which is
   pure addition and which #169 needs regardless. Phase 2 — typed residuals,
   the severity constraint, fail-closed invalid accepts — is ratified as the
   design to build when its start condition is met: phase 1 shipped and 20
   tasks of finding data, or a second residual-accepted correctness incident,
   whichever comes first. The mechanism is proven elsewhere; the evidence here
   is one incident, as §7 concedes, and building enforcement before its shape
   can be observed is the mistake this document exists to name.
6. **Numbering — ratified as proposed.** This document is ADR-030; the
   register's next free number is 031.

The amendments changed thresholds and sequencing, not a single decision's
direction. Nothing in §§2–6 was reversed.

## 10. Amendment record — 2026-08-19: gate custody is the lead's

**Ratified:** user-directed, 2026-08-19 · **Implemented by:** #334, merged as
PR #348 · **Amends:** Decision 2's Routing and gate-generation bullets and its
no-lead paragraph (§3), Decision 1's no-lead paragraph (§2), and §8's #168
consequence row. Decisions 1 and 3–5 are not reopened.

Decision 2's former repair routing is what this amendment retires. #334 moved
all four post-acceptance gate sites — a failed discrimination proof
(`crew/drive.mjs:2214`), a vacuous green baseline (`:2265`), a gate that did not
RUN (`:2286`), and the reviewer-triaged mid-run gate defect (`:2604`) — to
`GATE_CUSTODIAN` (`crew/drive.mjs:218`), each guarded by `noGateCustodian()` so
a crew booted without that seat escalates with the site's own diagnosis attached
rather than assigning anybody (`crew/drive.mjs:1246-1253`). The assignment and
confinement expressions are pinned at `crew/drive.test.mjs:5145-5168` — exactly
two `planner` assignments remain in the driver, and neither is a gate site — and
the lead-less diagnostic escalations at `crew/drive.test.mjs:5170-5216`.

*(Anchors re-derived 2026-08-20 at commit `0999743` — #406. Every line number in
this section, and this amendment's `GATE_CUSTODIAN` and `noGateCustodian()`
references in Decision 2 (§3), was re-read on that checkout: the numbers
ratified on 2026-08-19 had drifted and resolved to unrelated modifier, mutation
and review code. The amendment's routing, substance and verdict are unchanged.
Not re-anchored here: Decision 2's `crew/drive.mjs:2085-2142` reference to the
builder-round-consuming repair path, which has drifted too but whose referent
cannot be re-derived from the sentence, and the ratification-era citations
elsewhere in this document, which this note neither re-anchors nor audits.)*

**Why — the domain argument recorded in #334.** Every seat cares about its own
domain, and the planner is not invoked once its plan is done. Once a plan is
accepted the gate stops being the planner's draft and becomes the crew's
acceptance criteria, and custody of acceptance criteria is judgment work.

**The measurement, from 164 archived lanes.** All 12 post-plan planner
activations were gate work, and the lead is the most idle seat in the roster
(90 turns, ~1.9 hours total) while `planner@plan` costs 34.4 hours.

**The authorship-bias objection is answered mechanically, not by trust.** Every
repaired gate is still re-proven by code — red at baseline and
discrimination-proven — so a bad repair cannot bless itself.

## 11. Amendment record — 2026-08-20: `crew/realio.mjs` is now `crew/seat-io.mjs`

**Implemented by:** #327 · **Amends:** nothing this ADR decided. Every citation
above is left exactly as ratified; this note is the map from the old name to the
new one, so a reader following a §3, §7 or §8 reference lands in the right file.

| Ratified name | Name from 2026-08-20 |
| --- | --- |
| `crew/realio.mjs` | `crew/seat-io.mjs` |
| `crew/realio-runclean.test.mjs` | `crew/seat-io-runclean.test.mjs` |
| the exported `realIo` | the exported `seatIo` |

#327 is a PURE RENAME: no decision, threshold, routing or line of behaviour in
§§0–10 changes, and the line numbers those sections cite inside the module are
unmoved. `realio` named the module after what it is NOT — the real io as opposed
to the injected test fakes — while every major export is a seat operation.

## 12. Amendment record — 2026-08-21: the durable outcomes and the mutation harness exist

**Implemented by:** #169 (durable outcomes) and #420 (per-check mutations) ·
**Amends:** nothing this ADR decided. Decision 2 (§3), §7 and §8 are recorded as
ratified; this note records that the three absences they assert have since been
filled, so a lane reading them does not build what is already there (#457).

**The two durable outcomes exist.** `gate_discriminations` and `review_outcomes`
are declared in the ledger schema (`scripts/factory/ledger.mjs`), written in
production by `recordGateDiscrimination` and `recordReviewOutcome` in
`crew/seat-io.mjs`, and read back by `taskReadout` and `eligibleTasks` in that
same ledger module. Both carried rows when this note was written — measured
2026-08-21 against the local ledger, 186 discrimination rows and 238 review
rows; that count is a machine-local observation, not a property of the repo. The
Decision 2 horizon therefore has a start, and `review_outcomes` is the
instrument #376's reviewer-tier experiment reads.

**The mutation harness exists and can stop a run.** #420 made per-check
mutations a declared, machine-applied contract. `validateMutations` and
`MUTATIONS_MAX` in `crew/drive.mjs` validate the planner's `details.mutations`,
and the driver then takes each entry down exactly one of four paths. An
exemption entry carries no find/replace and is recorded `exempt` without a
write. A non-exempt declaration whose file is missing from the built tree is recorded
`unapplied`, also without a write, and that is now the only meaning `unapplied`
carries.
A declaration whose file exists but whose anchor cannot be safely applied is recorded
`anchor-absent` when the find text is nowhere in the file under either attempt,
or `anchor-ambiguous` when the whitespace-normalized find matches more than one
span, or `anchor-unsafe` when the resolved span crosses a line carrying a `//`
comment inside the span, so a verbatim replacement would land in that comment;
none of the three writes (#742).
Only an applicable non-exempt declaration is written into the BUILT CHECKOUT
itself, re-run against the gate, and restored to its exact original bytes in a
`finally`, its outcome then `killed` or `survived` (`MUTATION_OUTCOMES`).
`survived` is the only outcome that indicts the gate; `unapplied`,
`anchor-absent`, `anchor-ambiguous`, and `anchor-unsafe` instead say the plan
predicted source the builder did not write. A `survived`, `unapplied`,
`anchor-absent`, `anchor-ambiguous`, or `anchor-unsafe` proof failure is routed by
`settleFailedProof` to the one gate repair a task is allowed, and stops the run with
an escalation when the restore was unsafe, when that repair is spent or has no
custodian, or when the repair itself does not resolve it. Per-check discrimination
is therefore commissioned and shipped, not deferred — §8's "not commissioned now"
and §3's rejection of "a harness that does not exist" are both retired by it.

What is NOT amended: the decisions themselves, the 20-task denominator, the
`must_fix > 0` trigger, and every other citation in §§0–11.

Citations here name files and symbols rather than lines: this lane measured
42–87% rot across four line-numbered citation populations, and zero rot in the
two documents that cite without line numbers (#457).
