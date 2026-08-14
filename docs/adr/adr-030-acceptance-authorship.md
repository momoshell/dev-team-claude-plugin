# ADR-030: Acceptance authorship — the seat that plans may draft the gate, but only a proof may accept it

**Status:** PROPOSED 2026-08-14 (five questions answered; awaiting ratification) · **Source:** issue #166 (from #142) · **Evidence:** #142, PR #162 (#144), #153/PR #154, #130/PR #156, PR #163/#164

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
plan-check verdict. This is a proposed decision record, not a code change.

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
  increments whenever a planner-returned replacement is accepted on the repair
  path—even when the command string is identical. The repair brief explicitly
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
- **Routing:** a failed proof is a gate defect. The driver bounces the planner,
  consumes the existing single `gate_repairs` budget, and never bounces the
  builder for evidence about the gate. A second failed proof escalates. The
  repair consumes no builder round, as the current repair path does
  (`crew/drive.mjs:580-604`).
- **Cost and record:** there are at most two extra gate runs per task. Each is
  recorded on `details.gate` beside `reverified`, and the named journal,
  emitter, and ledger representations use the generation key. The gate is not
  rerun merely because a build round occurred.
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
  `crew/realio.mjs:91-108`). Decision 2 commissions #169 to add a durable
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

With no lead seated, the driver still records and routes the mechanical proof;
there is simply no lead consultation to convert a failed gate proof into a
free-text decision, so the existing escalation is used. With no tech-lead
seated, plan-check is absent, but the driver's gate generation and pristine
proof remain available for every production tier. Neither absence is described
as a missing `runClean` capability.

**Rejected:** proving discrimination by prose in the brief—the status quo
already demanded that and both vacuous gates cleared it; running the pristine
proof at every gate round—the property cannot change unless the gate generation
changes; bouncing the **builder** on a failed proof—the evidence is about the
gate, and #153's incident shows that misrouting a gate defect burns nine stages;
keying identity on the command string or its hash—identical commands are
explicitly permitted on repair (`crew/drive.mjs:583-588`); and mutation-testing
the gate now—stronger proof would require a harness that does not exist and
would spend build budget on that harness.

## 4. Decision 3 — growth as a plan-check input

The plan-check loop can currently see only its round budget, even though plan
and gate files are already on disk. The question is whether size should become
a verdict in its own right.

**Decision:** **yes, as evidence with a named trigger, never as an automatic
verdict.** For each plan-check round, the driver records
`{round, plan_bytes, gate_bytes, plan_delta, gate_delta}` and embeds the result
in the next plan-bounce brief and the tech-lead check brief. A round is labeled
`divergent` when it is round 2 or later and combined plan-plus-gate bytes are at
least **1.25×** the preceding round's combined bytes.

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

**Decision:** **yes.** Acceptance with residuals is a closed, code-validated
claim, but the canonical finding set must exist first. The reviewer contract
returns a findings array with a stable per-review ID and severity alongside the
existing counts. This is a runtime-wide contract migration: `SEAT_DEFAULTS`
gives every crew the shared `reviewer.md` (`crew/crew.mjs:69-74`), every crew
requires a reviewer because the driver assigns one unconditionally
(`crew/crew.mjs:427-429`), and the shared role contract, envelope validation,
fixtures, contract tests, and exhaustion path must move together in #170.

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
| No observations exist today | Neither a discrimination outcome nor a review outcome is durable today (`scripts/factory/ledger.mjs:187-200`, `crew/realio.mjs:91-108`) | The Decision 2 horizon has not started and cannot start until #168 and #169 land. The first denominator is then the next 20 eligible tasks, not ratification or historical anecdotes. |
| `runClean` stash isolation has not been tested against writes outside git's view | `crew/realio.mjs:252-268` stashes `--include-untracked`; no cited test covers ignored paths or `node_modules` | A DI test is commissioned; a direct caller omitting `runClean` records `discrimination: 'unproven'`. Production uses outer `realIo`. |
| Per-check and omitted-check adequacy are unmeasured | The commissioned proof is whole-gate only; G61 in #142 is an example of a check that could not fail, and omitted coverage has no check to flip | The ADR does not claim per-check discrimination. The #168/#169 horizon and `must_fix > 0` trigger are the re-entry condition for stronger work. |
| The `cosmetic` / `correctness-unverified` split has only one data point | #144/PR #162 supplies the residual-accepted incident; the reviewer currently records severity counts only (`crew/roles/reviewer.md:31-33`) | #170 first creates stable finding IDs and severity, then validates typed residuals and refutations. No correctness category is inferred from severity. |
| A direct DI caller may omit `runClean` | `runClean` is optional in the DI contract (`crew/drive.mjs:163-165`); production reaches it through `realIo` (`crew/crew.mjs:459`) | Such a run is explicitly `unproven` and proceeds because instrumentation is non-load-bearing under ADR-026. It does not count as an eligible durable proof observation. |

## 8. Consequences and owner slices

This ADR changes no code. #168, #169, and #170 were filed against this ADR and
must not be built ahead of ratification. Per-check discrimination is deliberately
absent from this table: its start condition, denominator, and trigger live in
Decision 2 and the evidence-gap table, but it is not commissioned now.

| Consequence | Owner |
|---|---|
| Driver-owned `gate_generation`; discrimination proof at the first green of each generation, bounded by `1 + gate_repairs`; full `baselineGateDefect` predicate on repair re-proof; planner-bounce routing; `discrimination` on `details.gate`; DI tests | #168 |
| Test pinning that a headless-transport seat still drives on the outer `realIo` and therefore has `runClean`; stash-isolation coverage for ignored paths and `node_modules` | #168 |
| Durable discrimination outcome keyed on `{run, gate_generation}`, and durable review outcome with normalized verdict and `must_fix` count, with named journal/emitter/ledger representation and DI tests | #169 |
| Structured reviewer findings with stable IDs and severity—a runtime-wide migration of `reviewer.md`, envelope validation, fixtures, contract tests, and the exhaustion path; severity-constrained typed residuals/refuted-with-evidence; invalid accept fails closed; durable residual/refuted record | #170 |
| Growth signal per plan-check round, `divergent` label in bounce and check briefs, explicit task-contained `details.gate_path`, and non-load-bearing measurement | #142 |
| Required `carve_verdict` enum on plan revisions, validated in a new branch before `check:r{n}`, with escalate-with-slices on `carve` | #142 |

The owner issues are real filed slices, not a new permission to implement before
ratification. #142 remains the owner of its growth and carve directions; #168,
#169, and #170 own the new proof, measurement, and residual contracts
respectively.

## 9. Open questions for ratification

1. **Yes/no/amend:** ratify Decision 1's answer that the planner may author
   `gate.mjs`, but authorship alone never accepts the gate.
2. **Yes/no/amend:** ratify Decision 2's driver-owned `gate_generation`, first
   green proof per generation, full `baselineGateDefect` predicate, planner-bounce
   routing, and the 20-task re-entry condition beginning only after #168 and
   #169 land.
3. **Yes/no/amend:** ratify Decision 3's 1.25× growth trigger as evidence only,
   including explicit `details.gate_path` and no automatic bounce or carve.
4. **Yes/no/amend:** ratify Decision 4's required `proceed|carve` planner enum,
   validated before `check:r{n}`, with a buildable first slice carried on
   escalation.
5. **Yes/no/amend:** ratify Decision 5's runtime-wide reviewer contract
   migration and severity-constrained residual/refuted validation owned by
   #170, including fail-closed invalid accepts.
6. **Yes/no/amend:** ratify the numbering choice that burns ADR-030 as this
   proposed standalone document and advances the register's next-free number
   to 031.
