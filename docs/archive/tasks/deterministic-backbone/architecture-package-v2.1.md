# Architecture Package v2.1 — Deterministic Backbone / Phase-Chain Runner
## Final amendment over v2 (delta; where they differ, v2.1 governs)

**Author:** architecture-lead · **Date:** 2026-08-04 · **Repo:** `/Users/x/Development/dev-team-claude-plugin` @ `0e21025` (v0.1.48)
**Status:** final draft, pending approval · **Round:** last
**Precedence chain:** **v2.1 > v2 > v1.** All three stay parked. v2.1 restates only what changes.
**Inputs added:** `tasks/deterministic-backbone/plan-review-v2.md` (revise; all 7 original Must Fix confirmed resolved; 6 new defects N1–N6; 11 Should Fix) · orchestrator's direct read of **issue #9's body** (resolves U7).

---

## §0. U7 resolved — issue #9's actual contents

The orchestrator read #9's body from GitHub. Three corrections, one of which **invalidates a premise v2 asserted**:

1. **#9's spec-lint deliverable is exactly one new `warn()` call** — a `files_in_scope` entry matching a noise glob emits a WARN and exit 0, advisory, never a failure. The `warn()` helper already exists (`spec-lint.mjs:36`).
2. **#9's noise-filter read points do not touch `spec-lint.mjs` at all** — they are inline git pathspec exclusions documented in `references/qa-gate.md`. The reviewer's conditional on MF1 resolves to **no** — nothing further is absorbed.
3. **Premise correction:** v2 characterised #9 as a FAIL→WARN *softening* of existing checks. **That is wrong.** #9 adds a *new advisory warning*; it softens nothing. **Every FAIL→WARN downgrade in this initiative is A1's own**, which makes **R3 more important, not less**.

**Amended absorption scope:** A1 absorbs #9's single `warn()` plus its tests. The superseding comment on #9 **drops `scripts/spec-lint.mjs` and `test/spec-lint.test.mjs` from its Files list and changes nothing else**.

**U7 status: CLOSED for #9.** Still open and cheap: #11/#13 bodies before the contingent epic is filed (not load-bearing for any firm slice).

---

## §1. Disposition — every N-item and Should Fix

### New Must Fix (introduced by v2)

| # | Defect | Disposition | Where |
|---|---|---|---|
| **N1** | Gate M measures a chain that does not exist at gate M | **Adopted — M splits into M1 and M2** | §2 |
| **N2** | Ledger-lifetime rule destroys the instrument justifying B2 firm; metric is transcript-derived anyway | **Adopted — metric transcript-derived, full stop; B2 contingent with honest justification; "measurement instrument" claim withdrawn** | §3 |
| **N3** | No verb expresses re-dispatch/escalation; every exit becomes a recorded `--override` | **Adopted — decision schema gains `redispatch` and `escalate`; no new verb; refutation narrows** | §4 |
| **N4** | Live teardown defect parked inside the cancellable block | **Adopted — new Phase-A slice A3 via `--outcome` flag (also resolves SF-j)** | §5 |
| **N5** | A2's floor requires checks A1 does not build | **Adopted — `contract.validate()` against the schema; schema joins the BUDGET list; emptiness via `minItems: 1` (R5) with named fallback** | §6.1 |
| **N6** | A1 removes `discovery_context` from the FAIL surface entirely | **Adopted — one FAIL retained (parent-dir existence); R3 restated honestly** | §6.2 |

### Should Fix — all eleven adopted

| # | Item | Disposition |
|---|---|---|
| SF-a | Hyphen root cause is half the bug (`:142-145` absolute regex) | Item 5 splits into 5a/5b, each with a reproducing test asserting a *specific* outcome (§6.3) |
| SF-b | A0's stale-threshold side effect unstated | Stated in A0's Design; FM-4 floor re-derived (§7) |
| SF-c | Inline `--decision '<json>'` shell-quoting surface | Fixed `--decision <kind> --reason "<text>"` form; `@<file>` for structured; inline JSON dropped (§4.2) |
| SF-d | `finish` exit-code collision | Exit 0 with the verdict in JSON (§4.4) |
| SF-e | FM-1 incomplete (exit-1 empty-stdout path) | Sibling rule added; six-row classification (§8) |
| SF-f | Protected set ships twice; §A5.4 early bounce contingent | Owner is **B1**; ADR-016 delivered unconditionally; early bounce named contingent extra (§9) |
| SF-g | 15% establishes no significance; per-slice denominator gameable | Per-task metric with slice count as pairing criterion; M1 reframed as **necessary-condition bound**; crit. 2 relabelled regression guard (§2.3, §13) |
| SF-h | §0 overstates R1/R2 blast radius | Narrowed to `tests_pass` only, still top-billed (§11 preamble) |
| SF-i | §A7.8 makes D-d harder; unconnected | Connected in D-d (§12) |
| SF-j | B8 fix reverses subsystem direction | Resolved by A3's `--outcome` flag; `dispatch.mjs` never reads `chain.json` (§5) |
| SF-k | R4 names no text change | Reclassified as recorded non-deviation R13 (§11) |
| SF-l | Halt-answer idempotency unstated | Stated (§4.3) |

**Nits adopted:** the retry-bound citation is **ADR-014** throughout (v2 §A6.3 said ADR-015 — wrong). **R9/R10 marked conditional on B3+ proceeding.**

---

## §2. Gate M splits into M1 and M2 (N1)

### 2.1 M1 — runnable with no chain in existence

**Inputs:** A0 · A1/A2/A3 · **B1** (gates CLI, standalone) · Scout 1's U2 answer.

**Method:** two **paired** tasks run on the **prose path**, both with A0 landed — one *before* the gates CLI is used, one *after* — measured from session transcripts (`tool_use` entries; transcript-first protocol, `qa-notes.md:20`). Pairing: same tier, same domain, comparable diff size, **and comparable slice count**. Reported **per task**, slice count stated alongside.

**What M1 decides — not a significance test.** Two numbers: (1) *realised* — decision-class calls the gates CLI removed (a measurement of B1, informative); (2) **residual decision-class headroom** — decision-class calls per task remaining *after* the gates CLI. **The residual is an upper bound on anything a step machine could ever save** (it cannot touch poll turns; it cannot remove a decision the orchestrator must make).

> **M1's gate is a necessary-condition bound: if residual decision-class headroom < 6 calls/task, a step machine cannot reach the threshold, and B4a/B4b are never built.** No estimate of the step machine's efficiency is required — that is why it can run before the step machine exists.

**Threshold derivation, stated so it can be argued with:** the step machine's theoretical ceiling ≈ one saved call per phase boundary (~3/slice); a two-slice Tier-2 task has a ceiling near 6. A residual below that means the ceiling is below the cost of a third substrate. **Replaces v2's 15% figure, which established nothing.**

### 2.2 M2 — after B4a/B4b ship

Same pairing, same transcript metric, chain arm vs the M1 post-gates-CLI arm. **Decides B5+ on realised reduction, not projection.**

### 2.3 Both gates bind (restated D-e)

- **D-e(1):** residual headroom < 6 calls/task at M1 ⇒ **B4a/B4b are never built.** A0/A1/A2/A3/B1 stand as the delivered initiative.
- **D-e(2):** no realised reduction at M2 ⇒ **B5+ cancelled**; B4a/B4b kept (neutral) or reverted (negative), decided then.

---

## §3. B2 becomes contingent; the ledger is not the instrument (N2)

The "ledger is the measurement instrument" justification is **withdrawn** — the ledger records chain events only (zero visibility into the prose arm) and v2's own §A12 already specified a transcript metric, while §A6.5's discard rule deleted accepted runs' ledgers (M's paired tasks are accepted runs).

- **The metric is transcript-derived, full stop.** The ledger-lifetime rule stands unchanged (refused runs keep ledgers; accepted runs discard; archives carry them).
- **B2 moves to contingent**, built alongside B4a; its honest justification: chain state and its ledger serve the step machine and its audit trail. No consumer before B4a; no role in M1.
- **B1 is the only firm B slice.**

---

## §4. Decision protocol (N3 + SF-c/-d/-l)

### 4.1 Decision kinds — frozen enum, six values

| Kind | Valid on halts | Refutable? |
|---|---|---|
| `approve` | `spec_approval`, `package_approval` | Yes — against a failed schema-derived spec check |
| `amend` | `spec_approval`, `amend` | No |
| `route` | `gate_route` | No |
| `accept` | `acceptance` | **Yes — against `hard_fail: true`. The only refutable-against-hard-fail kind.** |
| `redispatch` | `acceptance`, `amend`, `escalation` | **No — always valid, recorded plainly, never an override** |
| `escalate` | any | **No — always valid, recorded plainly, never an override** |

> **Amended refutation rule:** `step --answer` refuses **only** `accept`-against-`hard_fail` and `approve`-against-a-failed-schema-check. `--override "<reason>"` retains its single meaning: *the orchestrator accepted work the gates refuted* — the one signal worth auditing.

### 4.2 Input form (SF-c)

Raw inline JSON is **dropped** (the shell-quoting hazard class the repo closed for nudges — `backend-notes.md:14`, refuse-rather-than-escape):

```
chain step --task <slug> --answer <halt-id> --decision <kind> [--reason "<text>"] [--override "<reason>"]
chain step --task <slug> --answer <halt-id> --decision @<file>
```

`--decision <kind>` parses only the six enum values. `--reason`/`--override` take one plain-ASCII line under allowlist discipline, **refusing rather than escaping** on any C0 char, CR, or shell metacharacter. `@<file>` for structured decisions — no quoting surface.

### 4.3 Idempotency (SF-l)

> Re-running an identical `step --answer <halt-id> --decision <kind>` against an already-answered halt is a **no-op returning current state, exit 0**. A *different* decision for an answered halt refuses, exit 2, naming the recorded decision.

### 4.4 Exit codes (SF-d)

| Code | Meaning |
|---|---|
| **0** | The chain worked. **Includes `accepted: false`** — `{"status":"run-complete","accepted":false,"accept_reason":"…"}` |
| 1 | Operational failure |
| 2 | Usage error, lock contention, or a refuted decision |

---

## §5. New Phase-A slice A3 — the teardown defect leaves the contingent block (N4 + SF-j)

**A3 — `teardown` gains an explicit `--outcome <ok|refused>` flag**

> **Depends on: #7 (both edit `teardownCmd`; land after #7 or coordinate). Independent of the chain, of gate M, of every B slice. Commit: `feat: dispatch — teardown --outcome gates archival on the caller's verdict, not a hardcoded ok; bump 0.1.NN`. Review lane: adversarial 3-panel.**

**Files** · `scripts/cmux/dispatch.mjs` · `references/cmux-dispatch.md` (teardown-order line) · `test/cmux-dispatch.test.mjs`.

**Scope** — `teardownCmd` accepts `--outcome <ok|refused>`, **default `ok`** (today's behaviour byte-for-byte), passing `{outcome: <flag>}` to `shouldArchive` in place of the hardcoded literal at `:1398`. The caller supplies the verdict: the orchestrator by hand at ship, or (contingently, B8-remnant) the chain from `chain.json.accepted`.

**Design (invariants restated)** · **`dispatch.mjs` never reads chain state** — the flag is the seam; a frozen cmux file coupled to a chain-owned JSON shape is a schema-freeze event waiting to happen. · **Default preserves today's behaviour.** · **`--outcome` is enum-closed** — unrecognised refuses exit 2, never coerced. · **Archival is the fail-safe direction** (`shouldArchive` is already fail-closed).

**Tests** · positive first: `--outcome ok` deletes exactly as today · `--outcome refused` archives task dir *and* state dir · **no flag ⇒ identical to today** · unrecognised value refuses exit 2 against the exported constant + drift guard · `--keep-artifacts` still forces archival.

**Acceptance** · A refused run's artifacts survive teardown — **negative: reverting to the hardcoded `{outcome:'ok'}` fails the suite.** · Absent the flag, unchanged. · Standing line.

**Ratification: R4 (ship-flow behaviour change).** **What remains in contingent B8:** only the chain-side caller passing `--outcome refused` when `chain.json.accepted !== true`.

---

## §6. A1 and A2 amended (N5, N6, SF-a)

### 6.1 A1 gains real schema validation (N5)

**Amended A1 item 3:** replace `checkFields` (presence-only, `:75-79`) with `contract.validate(HANDOVER_SPEC_SCHEMA, spec)`, mapping each `Violation {path, keyword, message}` to a FAIL line — delivering missing fields, wrong types, bad `domain` enum, non-string array items, `additionalProperties` violations.

**BUDGET walk — verified, passes.** `handover-spec.schema.json` uses nine keywords (`$schema`, `title`, `description`, `type`, `required`, `additionalProperties`, `properties`, `enum`, `items`) — all in the 15-keyword BUDGET. **It must be added to `test/schema.test.mjs`'s hardcoded list.**

**Emptiness does not come from the schema** (no `minItems` today). **Chosen: add `minItems: 1` to `files_in_scope` and `acceptance_criteria` only** — structural impossibility over lint rule (`conventions.md:26`); other arrays keep `[]` = none. **Ratification R5**; the file is deep-review-by-default. **Named fallback if R5 refused:** emptiness drops from A2's refusing class and becomes a warning — no slice blocked either way.

**A2's refusing class, amended:** exactly the violations `contract.validate()` returns. Everything else passes through as `warnings[]`.

### 6.2 A1 keeps one `discovery_context` FAIL (N6)

| Condition | After A1 |
|---|---|
| Cited path exists | pass |
| Missing, **parent directory exists** | **WARN** ("treated as a not-yet-created file") |
| Missing **and parent directory missing** | **FAIL** (retained) |
| `file:line` beyond current line count (`:118`) | **WARN** (staleness signal) |
| Bare mention of not-yet-existing file (`:147-152`) | governed by the parent-dir rule |

Symmetric with `checkFilesInScope:97-98`; keeps a real mechanical check (a citation into a nonexistent directory is a typo or hallucination, not a forward reference).

**R3 restated:** *"A1 reduces `discovery_context`'s FAIL surface to parent-directory existence; every other diagnostic on that field becomes a WARN. #9 softens nothing (§0) — every downgrade is A1's own. Fourth spec-lint exception."*

### 6.3 A1 item 5 splits (SF-a)

- **5a — relative regex (`:137`):** add `-` to the negative lookbehind. **Test asserts zero diagnostics of any severity** for a valid hyphenated absolute citation — not merely "no FAIL."
- **5b — absolute regex (`:142-145`):** resolve `resolve(root, path)` first; else try filesystem-absolute; report only if neither resolves. Real-absolute resolving **outside the root** ⇒ **WARN** (cross-repo citations legitimate, unverifiable), never FAIL. **Test: zero diagnostics in-root; exactly one WARN out-of-root.**

**Strike rule sharpened:** reproducing tests land first and **assert specific outcomes, not the absence of a FAIL** — else item 4's downgrades make them pass vacuously.

---

## §7. A0 — stale-threshold side effect stated (SF-b)

Added to A0's Design:

> **Recommending `--max-block-s 600` moves the await-lock stale threshold from 240 s to 1200 s** (`AWAIT_LOCK_STALE_MULTIPLIER = 2`, `dispatch.mjs:930`, applied at `:948`) — a dead await holder wedges every join for 20 minutes instead of 4. The trade is still strongly favourable (dead holders are rare; poll turns are every task) but it is a trade, not a free win.
>
> **FM-4 consequence:** `chain_lock_stale_s > await_lock_stale_s` now floors at **> 1200 s** under the recommendation; the chain lock's staleness must derive from the *effective* `--max-block-s`, never a hardcoded constant.

---

## §8. FM-1 complete — six-row classification (SF-e)

| Observation | Meaning | Chain response |
|---|---|---|
| exit 0 + parseable JSON | success | proceed |
| exit 2 + `{error:'lock_held', holder}` | contention | back off, report holder |
| **exit 2 + empty stdout** | the chain's own argv is wrong (`:1495-1506`, `:1528-1531`) | halt `blocked` naming argv; never retry |
| **exit 1 + empty stdout** | context construction failed (`:1511-1514`) | halt `blocked` naming context inputs; never retry, never parse |
| exit 1 + parseable JSON | operational failure with diagnosis | halt `blocked` carrying the JSON |
| any exit + unparseable non-empty stdout | truncation/corruption (FM-2: check `res.error`/`ENOBUFS`/`signal`/`status===null` first) | halt `blocked`; never partial-parse |

`fake-dispatch.mjs` must reproduce **all six rows** — the empty-stdout rows are exactly what a happy-path fake never produces (`qa-notes.md:16`).

---

## §9. Protected-set ownership pinned to B1 (SF-f)

> **B1 owns the protected set in `gates.mjs`'s `scope_compliance`. ADR-016 is delivered unconditionally** — independent of gate M, the step machine, and every contingent slice.

**Contingent extra, named:** §A5.4's early bounce (protected path in `files_in_scope` caught at `spec_gate`) depends on the contingent segment. If M1 cancels B3+, coverage is the gates CLI's after-the-fact check alone — an ergonomics reduction, not a coverage reduction. Contingent B6 is deleted from the sketch; only the early bounce remains a line item in the tier-3 re-plan. **A2's floor cannot cover protected paths** (a protected path in `files_in_scope` is schema-valid) — stated so nobody assumes it does.

---

## §10. Final slice table

```
A0 ─→ A1 ─→ A2          (spec ingress)
A3        (independent; needs #7)
         └─────────────→ B1 (gates CLI, FIRM)
                              │
                     ══ M1 ══ │  necessary-condition bound
                              │  residual < 6 calls/task ⇒ B4a/B4b never built
                              ↓
                  B2 ‖ B4a → B4b ─→ ══ M2 ══ ─→ B5+ (re-planned)
```

| Slice | Status | Depends on | Lane | One line |
|---|---|---|---|---|
| **A0** | **FIRM** | — | standard | `--max-block-s 600` recommendation + 1200 s stale-threshold statement |
| **A1** | **FIRM** | A0 (order); absorbs #9's one `warn()` | deep | spec-lint: CLI-as-library, `contract.validate()`, `--json`, softening w/ one FAIL retained, regex 5a+5b |
| **A2** | **FIRM** | A1 | adversarial | schema-derived refusal floor; heuristics → `warnings[]`; `realpathSync` fix |
| **A3** | **FIRM** | **#7** | adversarial | `teardown --outcome <ok\|refused>`, default `ok`; fixes the live archival defect |
| **B1** | **FIRM** | A1, #9 (re-scoped) | deep | gates CLI + evidence; **owns protected set; delivers ADR-016** |
| **M1** | **GATE** | A0–A3, B1, Scout 1 | — | residual headroom ≥ 6 calls/task, or B4a/B4b never built |
| B2 | contingent | M1 | deep | chain-state + schema; alongside B4a; justification is chain state, not measurement |
| B4a | contingent | M1, A2, B1, B2 | deep | step machine; owns `chain plan` validation |
| B4b | contingent | B4a | deep | halt projection, `step --answer` (6 kinds, refutation, idempotency), `finish`, fake w/ six FM-1 rows |
| M2 | GATE | B4a, B4b | — | realised reduction; gates B5+ |
| B5+ | re-plan | M2 | — | tier-3 table (U8 entry condition; `domain` enum lacks `architecture`), `spec_gate` + early bounce, `green_suite_fresh`, ship-segment caller, B9 wiring (`orchestration.md` + `team.md` only) |

**Epic action before A1:** superseding comment on **#9** — drop the two spec-lint files from its Files list; record the single `warn()` moved to A1; nothing else changes.

---

## §11. Final ratification list — thirteen items

**Preamble (SF-h):** R1/R2 block **`tests_pass` only** — the gates CLI collapses the other five checks regardless. What R1/R2 gate is the validation re-run: the most-repeated single check in the flow. Narrower than v2 claimed; still top-billed.

**Mapping from v2:** R1→R1 · R2→R2 · R3→R3 (restated) · R4→R13 (reclassified) · R5→R6 · R6→R7 · R7→R8 · R8→R9 (conditional) · R9→R10 (conditional) · R10→R11 · R11→R12 · new R4 (ship flow) · new R5 (schema minItems).

### Brain-file amendments
- **R1 — `references/qa-gate.md:7`:** "…runs deterministically in the parent process — your own Bash call, or the gates CLI on your behalf — never as a window." Fourth "brain unchanged" exception.
- **R2 — `orchestration.md:58`:** the same invariant in the injected brain file. R1 without R2 leaves the brain contradicting its reference.
- **R3 — A1's spec-lint semantics:** FAIL surface of `discovery_context` reduces to parent-dir existence; all downgrades are A1's own (#9 softens nothing). Fourth spec-lint exception.
- **R4 — `teardown --outcome` (ship flow; new).** Default preserves today's behaviour; archival policy at ship is ship flow and must be ratified as such.
- **R5 — `minItems: 1` on `files_in_scope` + `acceptance_criteria` (new).** Changes what a valid spec is; deep-review file. **If refused:** emptiness becomes a warning; no slice blocked.

### Structural
- **R6 — `orchestration.md` ceiling:** B9 targets ≤2 lines, no ceiling change.
- **R7 — second reference file (`references/chain.md`):** argued deviation from "mechanics in ONE reference" (that constraint scoped cmux mechanics). Fallback: fold in.
- **R8 — A2's floor inside `dispatch.mjs`:** contract-freeze-set file; weight reduced — the floor is exactly `contract.validate()` output, a class that cannot false-positive.

### New bounds — conditional on B3+ proceeding
- **R9 — `spec_gate` bounce bound** (2 then `escalation`). ADR-014's "count existing bounds only" does not authorize it. Moot if M1 cancels.
- **R10 — mechanical ≤2 amend enforcement.** Moot if M1 cancels.

### Recorded non-deviations
- **R11 — ADR-007 NOT deviated from.** · **R12 — "gate never fired from code" NOT deviated from.** · **R13 — `verdict_consistent` introduces no brain-file text change** (reclassified): the chain emits a gate check and halts; there is nothing to amend in `qa-gate.md`. Recorded so a future implementer does not "complete" the design by writing the branch.

---

## §12. Final decision list

- **D-a — the thirteen ratifications**, priority: R1+R2 (`tests_pass` dependency), R3 (sole author of the semantics change), R4 (ship flow), R5 (or fallback).
- **D-b — phase gating.** A0/A1/A2 need only re-scoped #9; A3 needs #7; B1 needs #9. **Recommendation: interleave with #15.**
- **D-c — three substrates, permanently** (deprecation path unbuildable). Confirming means `team-build.workflow.mjs` is maintained indefinitely as the agent-tool batch engine.
- **D-d — the central behavioral bet, with both halves stated:** the bet rides on ≤2 always-loaded `orchestration.md` lines + `commands/team.md`, because MF7 keeps `next.md`/`ship.md` substrate-agnostic — `/dev-team:next`, where every task begins, says nothing about either tool. **Partial mitigation:** the gates CLI wins even when invoked ad hoc (one call replaces five); a step machine used sometimes is pure overhead — a further argument for M1 gating B4a.
- **D-e — both gates bind:** (1) residual < 6 calls/task at M1 ⇒ B4a/B4b never built; A0–A3+B1 stand as the delivered initiative. (2) No realised reduction at M2 ⇒ B5+ cancelled; B4a/B4b kept (neutral) or reverted (negative).

---

## §13. Acceptance criteria (supersedes v2 §A12 items 1, 2, 8; adds 17–20)

1. **Metric:** decision-class tool calls **per task**, transcript-derived, slice count reported and used as a pairing criterion. **M1 = necessary-condition bound** (residual ≥ 6 calls/task else B4a/B4b never built); **M2 = realised reduction.** The 15% figure is withdrawn.
2. **Halt budget — regression guard, not a measurement:** clean Tier-2 slice emits ≤3 halts, asserted against the fake.
3. No path from a schema-invalid spec to a spawned executor — zero fake-cmux invocations, paired positive first.
4. No heuristic finding can prevent a dispatch — mutation negative.
5. The chain never resolves a judgment — mutation negative.
6. Refutation narrows to `accept`-vs-`hard_fail` and `approve`-vs-failed-schema-check; **`redispatch`/`escalate` always accepted, never recorded as overrides** — mutation negative.
7. The chain never rewrites a worker-authored `verdict` field — mutation negative.
8. **A3: refused teardown archives; unflagged teardown identical to today** — reverting the hardcoded literal fails the suite.
9. `dispatch_ids` never contains an id `listRecords` does not confirm — simulated crash produces zero second dispatches.
10. `chain_lock_stale_s > await_lock_stale_s`, derived from the effective `--max-block-s` (floor > 1200 s under A0).
11. All six FM-1 rows classified and reproduced by the fake, including both empty-stdout rows.
12. Killed step ⇒ phase `status:"fail"`; stale head reclaimed; concurrent steps refuse; corrupt lock is stale.
13. Every gate check returns evidence on pass.
14. Protected-path modification hard-fails from the gates CLI **with no chain present**; permissive degenerate fails the suite.
15. Every new schema — and `handover-spec.schema.json` — in `test/schema.test.mjs`'s list; BUDGET walk passes.
16. Standing line: `node --test` green, ≤10 s growth, no cmux/claude/model/network/GUI.
17. **`step --answer` idempotent** — identical re-answer is a no-op exit 0; different answer refuses exit 2 naming the recorded decision.
18. **`finish` exits 0 with `accepted: false` in JSON** — mutation negative.
19. **`--reason`/`--override` refuse rather than escape** on C0/CR/shell metacharacters.
20. **A1's regex tests assert specific outcomes** — zero diagnostics in-root absolute; exactly one WARN out-of-root; zero for hyphenated; each regex half fails its own test independently on revert.

---

## §14. Memory deltas — delta over v2 §A15

### → `architecture-notes.md`
- **AMEND ADR-014 entry:** delete "B2 is the measurement instrument"; retry-bound citation is ADR-014 throughout.
- **AMEND ADR-015 entry:** decision schema = six frozen kinds; refutation only `accept`-vs-`hard_fail` and `approve`-vs-failed-schema-check; `redispatch`/`escalate` always-valid, recorded plainly. *Why:* v2 left the two most likely responses with no protocol expression — every legitimate re-dispatch would have been recorded as an override, destroying the audit signal.
- **AMEND ADR-016 entry:** owner is B1's `scope_compliance`; ships unconditionally; `spec_gate` early bounce is a contingent ergonomic addition.
- **AMEND teardown entry:** fix is `teardown --outcome <ok|refused>` default `ok`, Phase-A slice A3, depends #7 — NOT a `chain.json` read. *Why:* subsystem direction is one-way; the flag is the seam; a live artifact-destroying defect must not sit behind a cancellable gate.
- **NEW — a measurement gate must be runnable before the thing it decides exists, or it is not a gate.** M1 (chain-free: residual decision-class headroom, an upper bound on any step machine's win; < 6 calls/task ⇒ never built) / M2 (realised reduction). A necessary-condition bound needs no significance test — the 15% threshold was withdrawn because two samples establish nothing, while "the ceiling is below the cost" is decidable from one number.
- **NEW — raising recommended `--max-block-s` to 600 raises the await-lock stale threshold 240 s → 1200 s** (`:930`, `:948`). A sibling lock outliving it must derive staleness from the effective cap, never a hardcoded constant.

### → `conventions.md`
- **NEW — a softened check must stay a check.** After downgrading three branches, `discovery_context` would have had no FAIL left — the individual downgrades were each defensible and their sum was not. Keep one structural FAIL; mirror an existing asymmetry (`checkFilesInScope:97-98`).
- **NEW — a test written against a check being simultaneously softened must assert the specific outcome, not the absence of a failure** — else the downgrade certifies a half-fix (the hyphen fix was real but partial; the absolute-path branch was untouched).
- **NEW — a CLI that answers a question must classify every way it can decline to answer.** `dispatch.mjs` has four silent-failure shapes; a caller handling only "non-zero ⇒ read JSON" will `JSON.parse('')` a real failure. Enumerate the rows; the fake reproduces all of them — the empty-stdout rows are what a happy-path fake never produces.
- **NEW — an answer protocol needs a verb for every answer the design predicts.** If prose says "re-dispatches, escalates, or overrides" and only override has a protocol expression, every re-dispatch is recorded as an override and the signal stops meaning anything. Enumerate the response set from the design's own remedy sentences before freezing the schema; answers are idempotent.

---

## §15. Evidence — v2.1 additions

**Now direct (reviewer, this round):** `AWAIT_CAP_*` + multiplier (`dispatch.mjs:926-930`) · `:1398` hardcoded `{outcome:'ok'}` · FM-1 rows incl. `:1511-1514` · `:1517` re-read · `:1546` `resolvePath` · hyphen-lookbehind confirmed for `:137`, refuted as complete (`:142-145` untouched) · `checkFields:75-79` presence-only · `contract.mjs:21`/`:31`.
**Verified this round (lead):** `checkFilesInScope:81-100` (the `:97-98` asymmetry N6 mirrors) · `handover-spec.schema.json` — nine keywords all in BUDGET, **no `minItems`** (hence R5 or fallback).
**Resolved:** U7 closed for #9. U4 gates B1's `tests_pass` only. U2 answered at M1, probed by A0. U8 = tier-3 re-plan entry condition.
**Still accepted from earlier reads:** `dispatch.mjs:1364-1365` · `resolve.mjs:90-112` · `return-lint.mjs:99` · `team-build.workflow.mjs:229-230` · #7/#11/#13 bodies.

---

## §16. Files

**Review chain:** `tasks/deterministic-backbone/{plan-review-v1,architect-consult-v1,plan-review-v2}.md`
**Package chain (v2.1 governs):** `tasks/deterministic-backbone/{architecture-package-v1,architecture-package-v2,architecture-package-v2.1}.md`
**Firm-slice targets:** `references/cmux-dispatch.md` (A0, A3) · `scripts/spec-lint.mjs` (A1) · `handover-spec.schema.json` (A1/R5) · `scripts/cmux/dispatch.mjs` (A2, A3) · `scripts/chain/{gates,evidence}.mjs` (B1) · `test/{spec-lint,cmux-dispatch,schema,chain-gates,chain-evidence}.test.mjs`
**Epic action before A1:** superseding comment on **#9** — drop the two spec-lint files from its Files list; record the single `warn()` moved to A1; nothing else changes.
