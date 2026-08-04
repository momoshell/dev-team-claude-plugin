# Plan re-review — architecture-package-v2 (deterministic backbone)

**Reviewer:** dev-team:plan-reviewer · **Date:** 2026-08-04 · **Verdict: revise**

> revise — v2 fixes all seven Must Fix items honestly and is a materially better package, but its headline change (the blocking measurement gate M) cannot run as specified: at gate M there is no chain to measure, the ledger rule discards the artifact B2 exists to produce, and the live teardown defect v2 discovered is parked inside the block that M can cancel.

## Must Fix (new, introduced by v2)

**N1. §A7.6 + §A7.7 — gate M measures a chain that does not exist at gate M.**
M's inputs are A0/B1/B2/Scout-1; its method compares "the prose path with A0 + the gates CLI" against "whatever chain shape is proposed" — but the step machine is B4a/B4b, contingent *behind* M. Three readings, all broken: (a) M measures gates-CLI vs prose — that measures B1, already unconditional, and cannot decide B3+; (b) M measures an unsliced prototype — the ≥15%-or-cancel threshold then binds a decision to throwaway code with no review lane, no tests; (c) M deferred until after B4 ships — then it is a retrospective, not a gate. Fix direction: either M's chain arm is an explicitly-scoped throwaway spike with a stated cost ceiling and a "deleted regardless of outcome" rule, or M splits into **M1** (gates-CLI vs prose, runnable today, decides whether B1's one-call collapse is real) and **M2** (post-B4a, decides B5+).

**N2. §A6.5 vs §A7.5 — the ledger-lifetime rule destroys the measurement instrument that justifies B2 being firm.**
§A7.5 justifies B2 as "the measurement instrument" for M; §A6.5 rules "an accepted run discards it" — and M's paired tasks are accepted runs, so their ledgers are deleted at teardown. Compounding: §A12 criterion 1 says the metric is counted from the session transcript (`tool_use` entries), not the ledger — and the ledger structurally cannot produce the metric (it records chain events only; zero visibility into the prose arm). B2's stated justification is false as well as self-cancelling. Fix direction: pick one — transcript-derived metric (then B2 is contingent with a different justification) or ledger-as-instrument (then the discard rule needs a measurement exemption). Both cannot stand.

**N3. §A6.2 + §A4.2 — no verb exists for the responses the design says the orchestrator will make.**
§A4.2's remedies for a `verdict_consistent` refutation: "re-dispatches, escalates the ladder, or overrides." Verb set is `plan`/`step`/`status`; `step --answer` refuses an `accept` against `hard_fail`; bare `step` re-presents the halt; `abort` is dropped. So re-dispatch and ladder escalation have no protocol expression — the only exits from a hard-failed `acceptance` halt are `--override` or hand-deleting `chain.json`. That converts every legitimate reviewer re-dispatch into a recorded override, poisoning the one audit signal `--override` exists to carry. Fix direction: extend the decision schema (`{"decision":"redispatch",...}` etc. via `step --answer`) — no new verb needed — or restore a bounded `abort`.

**N4. §A6.5 + §A7.7 — the live teardown defect is scheduled inside the block gate M can cancel.**
`dispatch.mjs:1398`'s hardcoded `{outcome:'ok'}` destroys refused-run artifacts **today, with no chain involved** — yet the fix is assigned to B8, inside contingent B3+, which M can cancel. Fix direction: split the `shouldArchive` fix out as a standalone Phase-A slice (needs #7 for teardown ordering, not the chain); only the `chain.json.accepted` read belongs in B8.

**N5. §A7.3 vs §A7.2 — A2's "schema-derived floor" requires checks A1 does not build.**
A2's refusing class is "missing required field, wrong type, empty required array" — but A1 item 3 only reads *field names* from the schema, and `spec-lint.mjs:75-79`'s `checkFields` is presence-only. Type and emptiness checks exist nowhere in A1's scope, so two of A2's three refusing checks are unbuilt and A2's acceptance criterion is unmeetable. Follow-on: doing it properly means `contract.mjs`'s `validate()` against `handover-spec.schema.json`, which would newly subject that schema to the 15-keyword BUDGET walk it is currently exempt from. Fix direction: add type/emptiness validation to A1's scope explicitly; state whether via `contract.validate` or hand-rolled; state whether the schema joins the BUDGET list.

**N6. §A7.2 item 4 — A1 removes `discovery_context` from the FAIL surface entirely, and neither the slice nor R3 says so.**
The three downgraded checks are **every** FAIL branch in `checkDiscoveryRefs` — after A1, `discovery_context` can emit warnings and nothing else, deleting the mechanical half of self-check item 2 on the most load-bearing spec field. Fix direction: state the consequence in A1 and R3; consider keeping one FAIL (cited path whose *parent directory* does not exist, mirroring `checkFilesInScope:98`'s asymmetry) so the check is softened, not neutered.

## Should Fix (new)

- **A1 item 5 — the hyphen root cause is half the bug.** Confirmed for the relative regex at `:137`; but the same citation also matches the **absolute** regex at `:142`, and `:144` resolves a filesystem-absolute path against the project root (`<root>/Users/x/…`, never exists). Masked by item 4's downgrade — so A1's test goes green for the wrong reason and the strike-rule may strike item 5 incorrectly. Fix `:142-145` to distinguish real-absolute from root-relative, or state that absolute citations are permanently warned.
- **A0's operational side effect unstated:** await-lock staleness = `capS × 2` (`dispatch.mjs:930,:948`); recommending 600s moves the stale threshold 240s → **1200s** — a dead await holder wedges joins for 20 minutes, and FM-4's `chain_lock_stale_s > await_lock_stale_s` floor is now >1200s. State in A0's Design.
- **Inline `--decision '<json>'` is a model-authored shell-quoting surface** — the hazard class the repo closed for nudges. Either charset discipline, or a fixed `--decision <enum> --reason <string>` form for the common case with `@<file>` for structured.
- **`finish`'s non-zero exit collides with the exit-code convention** (1 = operational failure). "Chain worked, answer was no" ≠ "chain broke." Carve a documented third code or exit 0 with the verdict in JSON.
- **FM-1 incomplete:** `:1511-1514` returns **1** with no `printResult` (non-`UsageError` `buildContext` throw). Sibling rule needed: "exit 1 + empty stdout ⇒ context construction failed," else the chain `JSON.parse('')`s a real failure.
- **The protected set ships twice** (B1's `scope_compliance` "incl. the two-entry protected set" vs contingent B6's "protected paths"). Pin the owner. If B1: ADR-016 is delivered unconditionally — say so. Also §A5.4's early-bounce depends on contingent `spec_gate`; if M fails, neither early bounce nor A2's floor covers protected paths.
- **The 15% threshold doesn't establish significance** (a measured 15% is equally inside the noise) and the per-slice denominator is gameable (per-task fixed calls amortize across more slices). Add slice count to pairing criteria or measure per-task with slice count reported. §A12 criterion 2 asserted-against-the-fake is a regression guard, not a measurement — label it so.
- **§0 overstates R1/R2's blast radius** — the gates CLI collapses five checks regardless; only `tests_pass` is blocked by R1/R2. Narrower honest statement still supports top billing.
- **§A7.8 makes D-d harder and v2 doesn't connect them** — `/dev-team:next` (where tasks begin) now says nothing about the chain; the bet rides on ≤2 always-loaded lines. Say so in D-d.
- **The B8 fix reverses §A3.1's subsystem direction** — `teardownCmd` reading `<STATE_DIR>/chain.json` couples cmux to chain-state's shape in a frozen file. Alternative preserving direction: `teardown --outcome <ok|refused>` passed by the chain (or by hand). One paragraph either way.
- **R4 names no file or text change** — under the stricter §A4 design the chain never writes the enum. Name the sentence added to `qa-gate.md`, or reclassify R4 as a recorded non-deviation beside R10/R11.
- **Halt-answer idempotency unstated** — re-running an identical `step --answer h-7` after a crash must be a no-op returning current state, not an error and not a re-application.

## Notes

**Disposition of my v1 findings:** MF1 resolved conditionally (absorb is the better cut, but rests on unverified #9 read-point contents — if #9's read points include `spec-lint.mjs`, that read point is absorbed too; U7 now load-bearing) · MF2 resolved, better than my fix direction · MF3 resolved (nit: R8 cites "ADR-014's" while §A6.3 cites "ADR-015's" — same rule, two numbers, one wrong) · MF4 resolved for R2, partially for R3 (see N6) · MF5 resolved, well-argued · MF6 resolved, stronger than either option I offered — §A4.2's never-rewrite rule is the best single idea added in v2 · MF7 resolved, and the §A15 convention delta is keeper. SF1–SF7 all resolved or acceptably handled (SF4 partially — see N1 and the threshold note).

**Invariant-triage overturns:** both adopted correctly; #6's asymmetry is now *earned* (two-entry glob-free set for hard_fail vs glob machinery only for warnings).

**Ratification list:** mostly right. **Missing: the `shouldArchive` change is a ship-flow behavior change** — binding constraint (1) names ship flow; add as an R-item. **Over-weighted: R4** (no text change identified). **Under-specified: R9** should be marked conditional on B3+ proceeding.

**Verified this session:** `AWAIT_CAP_*` + `AWAIT_LOCK_STALE_MULTIPLIER` at `dispatch.mjs:926-930` (module-private; A0 is doc-only) · `:1398` hardcoded `{outcome:'ok'}` · FM-1 asymmetry at `:1495-1506`/`:1528-1531` + uncovered exit-1 path at `:1511-1514` · `:1517` per-invocation re-read (FM-6 real) · `:1546` `resolvePath` (V9 now direct) · hyphen-lookbehind confirmed for `:137`, refuted as complete explanation (`:142-145` absolute-path resolution untouched) · `checkFields:75-79` presence-only (grounds N5) · `contract.mjs:21` OUTCOMES / `:31` PROTECTED_PATH_COMPONENTS.
**Not re-verified:** `dispatch.mjs:1364-1365`, `resolve.mjs:90-112`, `return-lint.mjs:99`, `team-build.workflow.mjs:229-230`, #7/#8/#9 bodies (U7 — open and now load-bearing for MF1).

**What v2 got right:** the three deletions (convergence trigger; the `inconclusive` identity claim; the false "panel majority is already mechanical"); A0 (the best thing in the package — found by decomposing the metric instead of defending the design); §A3.1's self-refutation admission.
