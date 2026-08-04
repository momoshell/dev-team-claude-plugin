# Architecture Package v2 — Deterministic Backbone / Phase-Chain Runner
## Amendment over v1 (supersede-by-amendment; v1 stays parked)

**Author:** architecture-lead · **Date:** 2026-08-04 · **Repo:** `/Users/x/Development/dev-team-claude-plugin` @ `0e21025` (v0.1.48)
**Status:** draft v2, pending re-review + user approval
**Precedence:** this document governs wherever it differs from v1 (`tasks/deterministic-backbone/architecture-package-v1.md`). v1 remains readable for the sections v2 does not touch (§2 ground truth, §9.3 test strategy, §16 acceptance criteria as amended in §A12 below). Section numbers below are v2's own; `v1 §N` refers back.
**Inputs added since v1:** `tasks/deterministic-backbone/plan-review-v1.md` (verdict **revise**; 7 Must Fix, 7 Should Fix, invariant-triage overturns) · `tasks/deterministic-backbone/architect-consult-v1.md` (agree-with-modification on position; disagree on the `inconclusive` mapping).

---

## §0. What changed, and the one thing to read first

**Read this first, because the initiative's thesis rests on it:** the turn-count case for the runner depends on a **brain-file amendment that is not yet ratified** — `orchestration.md:58` and `references/qa-gate.md:7` both state that the orchestrator re-runs `validation_commands` *itself, via Bash*. If that amendment is refused, every validation re-run stays an orchestrator turn and the runner's decision-turn savings shrink to roughly the spec-lint and aggregation calls alone. This was buried at v1 §13.1; the architect is right that it belongs at the top. It is **R1** in §A8.

**The three structural changes v2 makes:**

1. **The measurement moves before the architecture.** v1 sequenced *design → build → measure*. The architect's turn decomposition (poll turns vs decision turns) shows v1's Option A may be turn-*negative* as specified, and that a one-line documentation change (`--max-block-s 600`) plausibly beats the entire runner. v2 sequences **A0 → gates-as-CLI → measure → step machine**, with the measurement as a **blocking gate**, and freezes no segment DSL before it.
2. **The runner shrinks.** Six ADRs → three. Five modules → four (segment table folds into `chain.mjs`). Five verbs → three (`resolve` merges into `step --answer`; `abort` dropped). Nine Phase-B slices → two firm + a contingent re-plan.
3. **Three honest deletions.** The `team-build.workflow.mjs` convergence trigger (unbuildable by construction). The `verdict_consistent → inconclusive` identity claim (a brain widening dressed as a no-op). The claim that panel majority is "already mechanical" (**it does not exist anywhere in `scripts/`**).

---

## §A1. Disposition table — every review finding

**Adopted = v2 implements the fix direction. Adopted-with-variation = v2 fixes the problem by a different route, justified inline. Contested = v2 keeps v1's position with a counter-argument.**

### Plan review — Must Fix

| # | Finding | Disposition | Where |
|---|---|---|---|
| MF1 | A1 and epic #9 both rewrite `spec-lint.mjs`, scheduled parallel | **Adopted-with-variation** — A1 **absorbs** #9's spec-lint deliverable; #9 is re-scoped by superseding comment to noise-globs + read points + unfiltered scope check | §A7.2 |
| MF2 | A2 hard-refuses on a PATH check before U4 is scouted | **Adopted** — A2's refusal narrows to **schema-derived checks only**; every heuristic check (paths, `file:line`, binary-on-PATH) becomes a non-blocking warning. U4 dissolves as an A2 blocker | §A7.3 |
| MF3 | `checkFileLineRef` line-drift FAILs stale specs; `spec_gate` amend loop is unbounded | **Adopted, both halves** — A1 downgrades line-drift to WARN; `spec_gate` gains an explicit bounce bound (**new bound ⇒ ratification R8**) | §A7.2, §A6.3, §A8 |
| MF4 | `orchestration.md:58` and A1's spec-lint semantics change are missing from the ratification list | **Adopted** — now **R2** and **R3** | §A8 |
| MF5 | B8's `ship` segment runs `validate.full` inside a `chain step`, violating §2.1; U2 mis-scoped | **Adopted** — ship segment covers **teardown only**; `validate.full` stays orchestrator-owned, with the cost stated | §A6.5, §A7.6 |
| MF6 | `verdict_consistent → inconclusive` is a semantic widening claimed as zero-change, with a mis-fitting remedy | **Adopted, superseded by a stricter design** — the chain **halts on first occurrence and never re-runs, never re-routes, never rewrites the verdict**. Widening is **R4** | §A4 |
| MF7 | "Substrate-neutral wording" in `next.md`/`ship.md` is defeat-by-synonym | **Adopted** — B9 wires **only** `orchestration.md` + `commands/team.md`; guarded commands get nothing | §A7.7 |

### Plan review — Should Fix

| # | Finding | Disposition | Where |
|---|---|---|---|
| SF1 | ADR-019 duplicates `contract.mjs:31 PROTECTED_PATH_COMPONENTS` | **Adopted** — layering stated; chain set narrowed to two entries | §A5 |
| SF2 | `--json` output channel unspecified | **Adopted** — JSON→stdout, human→stderr, matching `dispatch.mjs:19-21` | §A7.2 |
| SF3 | The spec-lint gate exists in two places | **Adopted** — two distinct jobs named: A2 = unskippable **floor**, `spec_gate` = full lint, **advisory-but-halting** | §A7.3 |
| SF4 | Turn-count acceptance criterion not measurable as written | **Adopted** — metric, paired tasks and tolerance defined | §A12 |
| SF5 | U5 understated | **Adopted** — promoted to decision **D-d** | §A9 |
| SF6 | `green_suite_fresh`'s `revised` flag has no write points | **Adopted** — three write points named; one is unobservable and is stated as a residual | §A6.4 |
| SF7 | U8 must be resolved before B7 is *specified* | **Adopted** — folded into the contingent re-plan's entry conditions | §A7.8 |

### Architect consult

| # | Item | Disposition | Where |
|---|---|---|---|
| 1a-i | Merge `resolve` into `step --answer` | **Adopted** | §A6.2 |
| 1a-ii | Cap halts per segment (≤3 on a clean Tier-2 slice) | **Adopted** as an acceptance criterion | §A12 |
| 1a-iii | `--max-block-s 600` as slice **A0**, landing first | **Adopted** | §A7.1 |
| 1a-iv | Scout 1/U2 as a hard gate; sequence A0 → C → measure → A | **Adopted**; B3+ becomes a contingent re-plan | §A7, §A13 |
| 1b-i | Spawn rationale self-refutes; restate honestly | **Adopted** | §A3.1 |
| 1b-ii | Five subprocess failure modes (incl. the severe crash window) | **Adopted, all five** | §A3.2 |
| 1c | Delete the convergence trigger; three substrates permanently | **Adopted** | §A2.3 |
| 2a-i | Teardown archives on a hardcoded `{outcome:'ok'}` and deletes the audit trail | **Adopted** — B8 fixes it; ledger lifetime decided explicitly | §A6.5 |
| 2a-ii | `status.json` vs `chain.json` doctrine line | **Adopted** verbatim | §A6.1 |
| 2b | `inconclusive` disagreement (record vs route, no auto-re-run, calibration split) | **Adopted in full** | §A4 |
| 2c | **Panel majority does not exist in `scripts/`** — factual error in v1 §5.3 | **Adopted** — corrected, and the chain is barred from writing an aggregator | §A4.4 |
| O-1 | Protected-path set is self-defeating in this repo | **Adopted** — narrowed to memory + config | §A5 |
| O-2 | A2 carries most Phase-A risk for least value | **Adopted via narrowing**, not via a default-off flag — justified | §A7.3 |
| O-3 | §13.1 is load-bearing and under-argued; surface at the top | **Adopted** | §0 |
| O-4 | PIPE_BUF rationale is wrong | **Adopted** — deleted; truncation kept as readability-only | §A6.1 |
| O-5 | U2 named highest-impact then ignored | **Adopted** — blocking gate | §A7 |
| OE-1 | `segments.mjs` + frozen DSL + `validateSegmentTable` is premature | **Adopted** — folded into `chain.mjs` as a plain exported array | §A6.2 |
| OE-2 | Six ADRs → three | **Adopted** | §A10 |
| OE-3 | Drop `chain abort` | **Adopted** | §A6.2 |
| OE-4 | B1+B2 firm; re-plan B3–B9 after measurement | **Adopted** | §A7 |

**Nothing is contested.** Both reviews found real defects; two of them (the teardown evidence-destruction bug and the non-existent panel aggregator) were live errors in v1, not matters of taste.

---

## §A2. Position — amended (supersedes v1 §3)

### A2.1 The turn decomposition, and what it does to the recommendation

The architect's decomposition is correct and v1 did not have it:

- **Poll turns** — re-invoking a blocking join. `AWAIT_CAP_DEFAULT_S = 120` (`dispatch.mjs:927`), pane `timeout_s` 1800–3600 (`roster.default.json:39,101,111`) ⇒ a 25-minute lead is ≈12 poll turns; three roles per slice makes polls the dominant class.
- **Decision turns** — ≈5–6 per slice.

**The runner does not reduce poll turns.** `chain step` returns `still-running` and the orchestrator re-invokes, exactly as `await --all` does today. Its entire win lives in the decision class — and the gate library (v1's "Option C kernel") already captures most of that, because one `gates check` call collapses spec-lint + validation + scope + aggregation into a single tool call regardless of whether a step machine exists.

**Therefore v2 changes the recommendation's *shape*, not its destination:**

> **The gate library is the deliverable. The step machine is a hypothesis that must earn its slices with a measurement.**

v1 said "A, with C as its kernel, built in that order." v2 says the same words with a hard gate between them, and it stops pretending the ordering was merely convenient.

### A2.2 The cheaper win v1 missed — slice A0

`AWAIT_CAP_MAX_S = 600` (`dispatch.mjs:929`) exists; `references/cmux-dispatch.md:20-23` documents `--max-block-s` but **recommends no value**, so every orchestrator gets the 120s default. Raising the recommended value to 600 cuts poll turns ≈5× for **one documentation line**, with no code change, no schema event, and no new surface — larger than the runner's entire projected win.

Both constants are module-private (`const`, not exported at `:927`/`:929`), so A0 touches documentation only; the flag it recommends is already parsed and already clamped.

**A0 lands first, before anything else in this initiative**, and it is also the cheapest available probe of U2 (does a 600s Bash call survive the harness's tool timeout?). If A0 fails in practice, the step machine's `still-running` contract is in the same trouble, and we learn it for the price of one line.

### A2.3 Three substrates, permanently — the convergence trigger is deleted

v1 §3.3 promised: *"when and only when the chain gains an Agent-tool backend, `team-build.workflow.mjs` becomes a thin caller and can be retired."*

**This is unbuildable by construction and is hereby deleted.** v1 §8.1 itself states the chain cannot invoke the Agent tool — only a model turn can. An "Agent-tool backend for `chain.mjs`" is not deferred work; it is a category error. The only surviving reading (the chain halts once per Agent-tool dispatch and the orchestrator makes the call) is strictly worse than prose, and it would still not make the workflow a thin caller — the workflow's value is precisely the *zero-orchestrator-turn unattended batch*, which a halt-per-dispatch design destroys.

**Honest steady state:**

| Substrate | Serves | Never |
|---|---|---|
| `dispatch.mjs` | pane-dispatched roles in cmux mode | agent-tool mode; Explore |
| `team-build.workflow.mjs` | zero-turn unattended batches on the Workflow tool's `agent()` | cmux (`test/cmux-contract.test.mjs:622` enforces it) |
| `chain.mjs` (proposed) | cross-phase sequencing + gates, cmux mode only | Agent-tool dispatches of any kind |

Three substrates, three jobs, no convergence. The concrete harm of keeping the fiction is exactly what the architect names: a future implementer builds a transport indirection into the segment table for a backend that cannot exist — which is also why §A6.2 folds the segment table into `chain.mjs` as a plain array.

**Consequence for D-c:** this is no longer an open user choice framed as "accept three or schedule a deprecation." It is a statement of fact for the user to confirm.

---

## §A3. The `dispatch.mjs` subprocess contract — amended (supersedes v1 §3.3, §9.2)

### A3.1 Rationale, restated honestly

v1 argued spawn preserves `dispatch.mjs:3-5` ("the ONLY file in the repo that spawns processes, touches git, or measures wall-clock time"). **That argument self-refutes** — v1 §9.1's `evidence.mjs` does all three. The correct statement:

> *Within the cmux subsystem*, `dispatch.mjs` remains the sole spawner, git-toucher and clock-reader. The chain is a **separate subsystem** with its own single impure module (`evidence.mjs`), and it crosses into the cmux subsystem only through `dispatch.mjs`'s CLI.

The three real reasons for spawn: **process isolation** (a chain crash cannot corrupt in-flight record state), **the `DISPATCH_BIN` fake seam** (the repo's established testing idiom, `conventions.md:27`), and **version-skew tolerance** (a JSON CLI contract survives internal refactors that an import would not).

### A3.2 Five subprocess failure modes — all adopted

**FM-1 — exit 2 does not always print JSON.** `dispatch.mjs:1495-1506` and `:1528-1531` return 2 with **no `printResult`** (unknown verb, `parseArgs` throw, `UsageError`), while lock contention *does* print `{error:'lock_held', holder}`. The chain must distinguish: exit 2 + parseable `lock_held` ⇒ back off; **exit 2 + empty stdout ⇒ the chain's own argv is wrong** ⇒ halt `blocked` naming the argv, never retry. `fake-dispatch.mjs` must reproduce this asymmetry or the distinction is untested.

**FM-2 — `spawnSync` buffering and abnormal exits.** Set `maxBuffer` explicitly; check `res.error` (incl. `ENOBUFS`), `res.signal`, and `res.status === null` **before** attempting `JSON.parse`. A truncated JSON document must be an operational failure, never a silently-partial parse.

**FM-3 — orphaned await child wedging `await.lock`.** A `SIGKILL` of `chain step` while it is blocked in `spawnSync('dispatch await …')` leaves the child alive holding `await.lock`; the next step then refuses, naming a PID that is the chain's own orphan. Mitigations: record the spawned dispatcher PID in `chain.json.head.child_pid`; pass explicit `timeout` + `killSignal` to `spawnSync`; on reclaiming a stale chain lock, check whether the recorded child PID is still alive and report it in the halt rather than presenting it as third-party contention.

**FM-4 — lock-staleness ordering must not invert.** Asserted invariant with a test: **`chain_lock_stale_s > await_lock_stale_s`**. `await.lock` is stale at `2 × capS` (`dispatch.mjs:930,948`); if the chain lock expires first, a second step can steal the chain lock while the first step's await child still holds the await lock — producing exactly the wedge the locks exist to prevent.

**FM-5 (severe) — the crash window between spawn and persistence.** Killed between `spawnSync`'s return and the `chain.json` rename ⇒ a pane exists, the chain has no record of it, the next step re-dispatches the slice ⇒ **duplicate pane, second `dispatch_id`, two workers in one worktree.** v1's invariant-8 port ("write the phase record before dispatching") is phase-granularity and does not cover this.

> **Invariant (new, load-bearing): `listRecords(paths.dispatchDir)` is the sole authority on what was dispatched. `chain.json.phases[].dispatch_ids` is a cache and must never contain an id `listRecords` does not confirm. Reconciliation *adopts* an unknown record for the current slice rather than dispatching again — a chain that re-dispatches because its own cache is behind has spawned a pane it cannot join, and will do so on every subsequent step.**

This mirrors the ladder's own governing rule (completion is re-derived from evidence on every wake, never from a remembered fact) and is the same failure family as `architecture-notes.md:35`'s "a structural check whose already-done state is unobservable will be re-done."

**FM-6 (minor, adopted) — `execution_mode` re-read on every spawn.** `assertExecutionModeCmux` (`dispatch.mjs:1517`) re-reads `config.md` per invocation, so a mid-run edit flips chain-driven dispatches to refusal mid-chain. **Snapshot `execution_mode` into `chain.json` at `chain plan`; on any subsequent step, a changed value halts `blocked` with the two values named — fail closed, never adapt silently.**

---

## §A4. `verdict_consistent` — amended (supersedes v1 §5.3 and ADR-016's mapping clause)

### A4.1 v1's error

v1 claimed a self-contradictory verdict "maps onto D17's existing `inconclusive` branch — zero brain change, zero new enum value, zero new branch." Both reviewers refuted this, and they are right on the same ground: **both existing definitions of `inconclusive` are about *absence*** (`references/qa-gate.md:33` "no verdict"; D17 "missing/unparseable"), and a third producer already exists in code (`return-lint.mjs:99` `VERDICT_STUB_OBJECT`). Adding "present, parseable, enum-valid, but self-contradictory" is a **fourth producer widening a defined term in a brain file**. The plan review adds the operational half: the prescribed remedy (re-run scoped to diff) is wrong for `pass ∧ ∃critical`, because the critical finding is *already* a block per `qa-gate.md:29`, and re-running the same reviewer likely reproduces the contradiction at the cost of a window.

### A4.2 The amended design — strictly more conservative than either offered fix

The plan review offered "accept as a fourth exception and write the branch" or "route to `changes-needed`." The architect offered "halt on first occurrence, never auto-re-run." **v2 adopts the architect's option**, which is stricter than both and dissolves the loop-bound problem entirely:

1. **The chain never rewrites the reviewer's envelope.** `verdict_consistent` emits a gate check and nothing else:
   ```json
   { "item": "verdict_consistent", "ok": false,
     "note": "verdict=pass with 2 critical findings — F1 (auth bypass, src/a.js:44), F2 (…)" }
   ```
   The worker-authored `verdict` field is left byte-untouched. This is the package's own convention "deterministic results never wear an agent's envelope" applied to itself — v1's "maps onto inconclusive" phrasing was one sloppy sentence away from an implementer overwriting a worker-authored envelope.
2. **Record and route are separated.** The *record* is a failed check with evidence. The *route* is: **halt `acceptance` on first occurrence.** The chain never auto-re-runs a reviewer, never re-dispatches, never re-routes to `changes-needed`. The orchestrator then re-dispatches, escalates the ladder, or overrides with a recorded reason.
3. **Zero new counters, ADR-015 intact.** The architect's decisive point: a mechanized "refuted ⇒ re-run" has **no existing bound to count** (`≤2` is coder-`insufficient`; re-dispatch has only `attempt ≤ 99`), so the chain would be forbidden by its own charter from stopping a loop it started. Halting on first occurrence removes the loop rather than bounding it.

### A4.3 Calibration split — ship one, hold the other

| Variant | Ships as | Why |
|---|---|---|
| `verdict: "pass"` ∧ ∃ `severity: "critical"` | **hard refutation** — halt `acceptance`, `hard_fail: true` | Unambiguous self-contradiction; `qa-gate.md:29`'s always-block classes make a `critical` finding a block by definition |
| `verdict: "changes-needed"` ∧ `findings.length === 0` | **evidence-only, non-routing** (recorded in the GateReport, does not halt) | Only Must-fix blocks (`qa-gate.md:35`) and reviewers legitimately put blocking reasoning in the `Must-fix` *prose section* rather than the findings array — this variant will false-positive against real returns until measured |

Promoting the second variant to routing requires observed data, and is a separate decision.

### A4.4 Factual correction: panel majority does not exist

v1 §5.3 asserted "panel majority and enum branching stay where they are — already mechanical, already owned by the existing ladder." **This is false.** `ladder.mjs` validates a single envelope; there is no aggregation anywhere in `scripts/`. Panel majority today is orchestrator prose plus an independent copy in `team-build.workflow.mjs:229-230` (`passCount >= 2`), which is a different substrate the chain never touches.

**Amended:** panel aggregation is a dependency being **acquired from #8**, not a mechanism being read. And the hard rule, so the dependency cannot quietly become the chain's problem:

> **If #8 ships D17 without an aggregator, the chain does not write one.** It halts `acceptance` listing each reviewer's `verdict` enum and finding counts, and the orchestrator aggregates. A chain that computes a panel verdict *is* deciding a verdict, which its charter forbids.

---

## §A5. Protected paths — amended (supersedes v1 §6.2, ADR-019's set)

### A5.1 v1's set was self-defeating **in this repo**

v1 protected `.claude/dev-team/memory/**`, `scripts/chain/**`, `scripts/cmux/**`, `hooks/**`, `config.md`. But this repo *is* the plugin: #7, #8, #9 and A2 all dispatch coders **against `scripts/cmux/*.mjs`**. B6 as written would hard-fail and escalate on the plugin's own development — a gate that fires on the majority of legitimate work is a gate that gets disabled.

### A5.2 Amended set — two entries

```
.claude/dev-team/memory/**
.claude/dev-team/config.md
```

Everything else is the **ordinary scope check** (touched-vs-`files_in_scope`), which bounces as `changes-needed` and is correctable by re-prompting.

### A5.3 Layering against `contract.mjs:31` — one authority per question

`contract.mjs:31` exports `PROTECTED_PATH_COMPONENTS = ['.claude','.git','.vscode','.idea','.husky','.devcontainer']`. Two protected lists would be the same single-authority failure this package refuses for envelopes. The layering, stated once:

| Layer | Question it answers | Authority |
|---|---|---|
| `PROTECTED_PATH_COMPONENTS` (`contract.mjs:31`) | *Where may the dispatcher site an agent-writable directory?* | Frozen; **unchanged**; a siting rule, evaluated at path-derivation time |
| chain protected set (two entries) | *Which paths, if modified inside a granted worktree, are a breach rather than a scope violation?* | New; parent-side; evaluated after the fact |

They are not the same list and must not be unified: the first is about *destinations the dispatcher chooses*, the second about *files an agent touched*. The chain set is a strict subset of `.claude/**` and therefore never contradicts the frozen constant — it is a finer-grained question asked at a different time. **Stated in `references/chain.md` and in the ADR, so the next reader does not "reconcile" them into one.**

### A5.4 A protected path in `files_in_scope` is a **spec error**, not a runtime breach

Caught at `spec_gate`, before any dispatch, as a named spec-lint-class failure. This is the whole-design improvement in the architect's suggestion: it converts a scary late escalation into a cheap early bounce, and it means the runtime breach check only ever fires on something the spec never authorized.

### A5.5 The plan review's #6 qualification — answered by the narrowing, not by assertion

The plan review qualified invariant 6: *if the set-difference computation is untrustworthy enough to forbid rollback, a `hard_fail` escalation on the same computation deserves the same skepticism.* That is fair against v1's set. It is answered by A5.2: `hard_fail` now fires only on a **two-entry, exact-prefix, glob-free** path set where the computation is trivially auditable by eye, while everything requiring the general glob machinery (`*` stops at `/`, `**` crosses, trailing `/` = prefix) can only produce an ordinary, correctable scope warning. The asymmetry is now justified by a difference in computational surface, not asserted.

---

## §A6. Runner shape — amended (supersedes v1 §7, §8.6, §8.7, §9.1)

### A6.1 State, ledger and the doctrine line

Unchanged from v1 §7: `<STATE_DIR>/chain.json` + `<STATE_DIR>/chain.jsonl`, parent-side, atomic RMW under a `'wx'` lock, JSONL not `node:sqlite` (Node 20 floor).

**Amended — the 4096-byte cap's rationale is deleted.** PIPE_BUF governs pipes, not `appendFileSync` to a regular file; `O_APPEND` offset atomicity holds regardless of size; and single-writer-under-lock is already mandated. **Truncation is retained purely for readability** (a ledger line should be greppable), with an explicit `"truncated": true` marker. v1's phrasing taught 4096 as a correctness boundary — it is not, and leaving it would have someone later "fix" a harmless long line as a data-integrity bug.

**Amended — new cache rule** (FM-5): `chain.json.phases[].dispatch_ids` is a **cache over `listRecords`**, never an authority.

**Doctrine line, verbatim into `references/chain.md`:**

> *`status.json` answers "did the dispatches finish." `chain.json` answers "was the work accepted." Never read one for the other.*

### A6.2 Modules and verbs — consolidated

**Four modules** (v1 had five):

```
scripts/chain/
  chain.mjs        CLI + step machine + the tier-2 segment table as a plain exported array
                   + halt projection. Verbs: plan · step · status.
  chain-state.mjs  chain.json lifecycle, chain lock, chain.jsonl append. Atomic writes only.
  gates.mjs        the check library; every check -> {item, ok, note}; GateReport aggregation;
                   hard_fail classification. Pure. Also ships its OWN CLI (see B1).
  evidence.mjs     the one impure module: baseline capture, change-set diff, known-commands
                   runner (argv array, timeout->124, missing binary->127, collect-all,
                   4000-char tail into paths.logsDir).
```

`segments.mjs`, its frozen DSL, `validateSegmentTable()` and the construction-time description lint are **deleted from the plan**. Two tables authored by one repo do not need a validated data format, and B3 would have frozen that format before its only consumer existed. The tier-2 table is a plain exported array in `chain.mjs`; the description-non-restating check survives as a plain `node --test` assertion over that array (sssf invariant 10 kept, its ceremony dropped). **Extract a module when the tier-3 table forces a genuinely second shape** — not before.

**Three verbs** (v1 had five):

```
node scripts/chain/chain.mjs plan   --task <slug> --tier <2|3>
node scripts/chain/chain.mjs step   --task <slug> [--max-block-s N]
                                    [--answer <halt-id> --decision '<inline-json>' | @<file>]
                                    [--override "<reason>"]
node scripts/chain/chain.mjs status --task <slug>
```

- **`resolve` merges into `step --answer`** (architect 1a-i). v1's protocol cost a Write + a Bash per halt, then a further `step` — 8–12 tool calls where prose spends ~4, on the exact axis the initiative claims to improve. The refutation logic is kept **exactly** (it is the best idea in the package): `step --answer` validates the decision against a frozen decision schema and **refuses, exit 2, named constant**, when the decision contradicts its own evidence — an `accept` against `hard_fail: true`, an `approve` against a failed schema-derived spec check. `--override "<reason>"` is the escape hatch and writes a ledger line. `@<file>` remains for decisions too large for a command line.
- **`abort` is dropped.** Nothing it does is not covered by a halt plus deleting `chain.json`.
- **`finish` is not a verb.** It is the internal transition performed by the `step` that answers the terminal `acceptance` halt: it settles `chain.json.accepted` + `accept_reason`, writes the final ledger line, and returns `run-complete` with a non-zero exit when `accepted === false`. This closes the plan review's "nobody owns `chain finish`" gap by removing the thing that needed an owner. **Owner: B4b.**
- **`chain plan` owns fail-fast validation** (sssf invariant 14): every role in the table resolves in the roster, every gate name resolves in `gates.mjs`, every referenced path exists, `execution_mode` is snapshotted. **Owner: B4a.** (The plan review asked which of B3/B4 owned this; B3 no longer exists.)

### A6.3 `spec_gate` — bounded, and the bound is a ratification item

**MF3.** `spec-lint.mjs:118` FAILs a cited `file:line` whose line number now exceeds the file's length. In Tier-3 per-phase sub-chains, specs are transcribed at plan time and dispatched phases later, after earlier phases changed those files — so a spec that linted clean at transcription hard-FAILs at dispatch, through no fault of anyone.

Two fixes, both adopted:

1. **A1 downgrades line-drift to WARN** (§A7.2). A stale line number is a staleness signal, not a defect.
2. **`spec_gate` gains an explicit bound:**
   > A `spec_gate` FAIL halts `spec_approval` carrying the FAIL lines verbatim. The chain increments `counters.spec_gate_bounces[slice_id]`. **At 2, the halt becomes `escalation` and the chain refuses to re-dispatch that slice.**

**This is a new bound with no existing brain counterpart** — `orchestration.md:53`'s ≤2 governs coder `insufficient`, a different loop — so ADR-015's "count existing bounds only" does not cover it. It is **ratification R8**. Filed openly rather than smuggled in as an implementation detail, because an unbounded halt→re-transcribe→halt cycle is precisely the turn-burner that would falsify the whole thesis.

### A6.4 `revised` / `green_suite_fresh` — write points named (SF6)

The gate is meaningless unless every mutation path sets the flag. Three write points:

1. **Coder in-worktree edit after a green run** — detected, not self-reported: the change-set fingerprint (`evidence.mjs` baseline machinery) is re-taken at gate time and compared to the fingerprint captured at the last green validation. A difference sets `revised`.
2. **A new attempt on the same slice** — `attempt` increments ⇒ `revised` set unconditionally.
3. **Orchestrator out-of-band fix** — the same fingerprint comparison catches it, *provided the fix lands in the slice's worktree*.

**Named residual:** an orchestrator fix made in the **primary checkout** while the slice's evidence lives in a worktree is not observed by (3). Stated, not papered over; the mitigation is the ordinary one — the ship-time full-suite run is the backstop, and it stays orchestrator-owned (§A6.5).

### A6.5 Ship, teardown, acceptance and the ledger's lifetime

**MF5 — `validate.full` stays orchestrator-owned.** The `ship` segment covers **teardown only**.

*The alternative was designed and rejected, per directive:* giving the step machine a `still-running` state for **local** commands requires either (a) a background child plus a poll file — which re-imports the "background Bash ends the turn" hazard D4 exists to avoid, and adds a second liveness ladder with its own staleness rules, orphan handling and crash semantics; or (b) chunked execution of an opaque user-supplied command, which is impossible in general — you cannot resume `npm test` halfway. **Cost of not doing it:** ship-time validation remains exactly one orchestrator Bash call, as today. That is one call per *task*, not per phase — the cheapest thing in the whole flow to leave alone, and the worst possible place to spend a new interface.

**Architect 2a — the teardown bug (a live defect in shipped code, not merely in v1).**

`dispatch.mjs:1398`:
```js
const archive = Boolean(args['keep-artifacts']) || shouldArchive({ outcome: 'ok' }, records)
```
The `task` argument is **hardcoded `{outcome:'ok'}`**. So a run where every dispatch completed `ok` but the chain refused acceptance — hard-fail gate, protected-path breach, unresolved halt — has its task dir **and** state dir **deleted rather than archived**, taking `chain.json`, `chain.jsonl` and every GateReport with it. **The audit trail is garbage-collected precisely in the case it exists for.**

**Fix, owned by B8, with a named dependency on #7:** `teardownCmd` reads `chain.json.accepted` and passes `{outcome: accepted === true ? 'ok' : 'refused'}`; an absent `chain.json` preserves today's behavior exactly (so non-chain tasks are untouched). Negative test: a refused chain archives; an accepted chain does not.

**The permanence of `outcome: "ok"` in dispatch records while the chain refused the run is correct and is not a bug** — a dispatch record is a fact about a process; acceptance is a judgment about work (ADR-018→now ADR-015). The only consumer conflating them is teardown, and this fixes that one consumer.

**Ledger lifetime — decided explicitly** (the architect asked; v1 did not say):

> `chain.jsonl` lives in STATE_DIR and **does not outlive teardown by default**. It is copied into the archive whenever the task archives — which, after the fix above, is exactly when `accepted !== true` (or `--keep-artifacts`). **A refused run keeps its full ledger; an accepted run discards it.**

Justification: an accepted run's ledger has no downstream consumer — the PR, the memory deltas and the task source carry everything forward (`commands/ship.md:32`). A refused run's ledger is the entire point of having one. This also keeps `~/.dev-team/archive/` from accumulating a JSONL file per successful task forever.

---

## §A7. Execution plan — restructured

**Sequencing (architect 1a-iv, adopted):**

```
A0 (doc, 1 line)  →  A1  →  A2  →  B1 (gates CLI)  ‖  B2 (state+ledger)
                                          ↓
                            ══ MEASUREMENT GATE (M) ══   ← blocking
                                          ↓
                        B3+ : re-planned with the measurement in hand
```

Nothing past M is specified in v2 beyond a sketch. v1 froze nine slices and a dependency lattice for an unmeasured thesis; that was the single largest piece of over-engineering in it.

### A7.1 A0 — recommend `--max-block-s 600`

> **Depends on: nothing. Lands first, before every other slice in this initiative. Parallel-safe with all of #7/#8/#9. Commit: `docs: cmux-dispatch — recommend --max-block-s 600 on the await join; bump 0.1.NN`. Review lane: standard (documentation, no code path).**

**Files** · `references/cmux-dispatch.md` (modified, ~1 line) · `test/orchestration.test.mjs` or a new pinned-substring assertion (modified).

**Scope** — `references/cmux-dispatch.md:20-23` documents the `await --all` join and mentions `--max-block-s` without recommending a value, so every orchestrator inherits `AWAIT_CAP_DEFAULT_S = 120` (`dispatch.mjs:927`). Add the recommended value `600` (the clamp ceiling, `AWAIT_CAP_MAX_S`, `dispatch.mjs:929`) with the one-sentence reason.

**Design (invariants restated)** · **The floor and ceiling are unchanged** — `--max-block-s` is already parsed and already clamped to `[5, 600]`; A0 changes no constant and no code path, so a wrong recommendation is a documentation edit away from reverting, not a schema event. · **Never recommend a value above the clamp** — a documented value the tool silently lowers is a documented lie.

**Tests** · a pinned-substring assertion that the reference recommends `600` (so a later edit that drops it fails loudly) · assert the recommended value equals the source-extracted `AWAIT_CAP_MAX_S` literal from `dispatch.mjs` (source-text extraction, never import — `backend-notes.md:12`), so the doc cannot drift past the clamp.

**Acceptance** · The reference recommends an explicit `--max-block-s` value. · **Negative:** changing `AWAIT_CAP_MAX_S` in `dispatch.mjs` without updating the reference fails the suite. · Standing line: `node --test` green, no cmux/model/network.

**Also the cheapest probe of U2** — if a 600s foreground join does not survive the harness's Bash tool timeout in practice, we learn the step machine's `still-running` contract is in trouble for the price of one line. Feed the observation into M.

### A7.2 A1 — `spec-lint` becomes a library, **absorbing #9's spec-lint deliverable**

> **Depends on: A0 (ordering only). ABSORBS epic issue #9's spec-lint deliverable — #9 must be re-scoped by superseding comment before A1 is filed. Parallel with #7 / #8; NOT parallel with #9. Commit: `feat: spec-lint — schema-driven fields, --json, CLI-as-library, WARN-not-FAIL softening; bump 0.1.NN`. Review lane: deep.**

**MF1 — why absorb rather than depend.** #9's scope includes *"spec-lint WARN never FAIL"*; A1 scope item 4 is *the same edit on the same lines*, and A1 additionally restructures the whole file. A **dependency** still leaves two PRs editing one file with one intent, and the likely outcome is #9's WARN-downgrade landing on the pre-refactor structure and being lost or re-implemented. **Absorbing the one deliverable, not the whole issue**, is the right cut: #9's other deliverables (`scripts/noise-globs.json` as data; two inline read points; the unfiltered-scope-check invariant) belong nowhere near a spec-lint refactor, and B1's `diff_matches_claims` still needs them.

**Required epic action, before A1 is filed:** post a superseding comment on **#9** re-scoping it to noise-globs data + read points + *"the scope check stays unfiltered — a scope check that hides files is a scope check that lies,"* and recording that the spec-lint WARN deliverable moved to A1. Superseding by comment, never body edits (house style §5).

**Files** · `scripts/spec-lint.mjs` (modified) · `test/spec-lint.test.mjs` (modified).

**Scope**
1. Move module-level side effects (`:202-212`) into `main(argv)`; move `failures`/`warnings` (`:33-34`) into `lintSpec`'s closure so two calls in one process cannot cross-contaminate. Export `lintSpec(spec, root) -> {ok, failures[], warnings[]}` and `main(argv)`.
2. **Add** an `invokedDirectly` guard that `realpathSync`es both sides. *(Correction from the plan review: spec-lint has **no** such guard today — A1 adds one, it does not fix one.)*
3. Read required field names from `handover-spec.schema.json`'s `required` instead of the literal at `:18-21`. *(The plan review verified the two lists are byte-identical, so this is a true no-behavior-change refactor — state that in the PR so a reviewer does not hunt for a behavior delta.)*
4. **Softening (absorbed from #9) — three FAIL→WARN downgrades:** line-drift (`:118`, MF3); bare-mention of a not-yet-existing file (`:147-152`); cited-but-missing file inside `discovery_context` (`:113`).
5. **Path-regex fix with a now-identified root cause:** the negative lookbehind `(?<![\w@:./])` at `:137` and `:147` **omits `-`**, so inside `/Users/x/Development/dev-team-claude-plugin/tasks/…` the relative-reference regex re-matches from just after a hyphen, yielding `team-claude-plugin/tasks/…` and FAILing it as missing. Add `-` to the lookbehind class in both regexes.
6. `--json`: **JSON object to stdout, human FAIL/WARN lines to stderr**, matching `dispatch.mjs:19-21` (SF2). Shape: `{ok, failures:[{check, detail}], warnings:[{check, detail}]}` — the shape `gates.mjs` and A2 consume.

**Design (invariants restated)** · **A claimed defect that does not reproduce is dropped, not "fixed."** The double-extension defect (`backend-notes.md:22`) rests on a memory note, and a reading of `:137`'s regex suggests greedy `[\w.-]+` may already handle `foo.test.mjs` correctly. **Every scope item in 4–5 must land its failing test first; any item whose test passes against `HEAD` is struck from the slice and the memory note is corrected** — shipping a "fix" for a non-defect is how a linter acquires an unexplained special case. · **The `invokedDirectly` guard must `realpathSync` both sides** or it silently no-ops under a symlinked path component (macOS `TMPDIR` = `/var → /private/var`) — invisible to a plain unit run, so the regression test must invoke *through a symlink* (`backend-notes.md:21`). · **Softening must never become permissiveness** — each downgraded check still *reports*; a truly-missing `files_in_scope` path still FAILs.

**Tests** · golden spec returns zero failures (positive first, `qa-notes.md:9`) · exactly-one-failure `deepEqual` per single-mutation negative · **each of items 4–5 lands its reproducing test before the fix** · hyphenated-absolute-path spec passes · a truly-missing path still FAILs · line-drift produces a WARN and exit 0 · `--json` puts JSON on stdout and nothing on stdout but JSON · two `lintSpec` calls in one process are independent · symlink invocation runs `main` · drift guard: `REQUIRED_FIELDS` is not re-typed as a literal anywhere in the file.

**Acceptance** · Every previously-documented false positive that reproduces has a passing test; every one that does not reproduce is struck with the memory note corrected in the same PR. · Softened checks report and do not fail — **negative: a mutation making them silent fails the suite.** · The permissive degenerate (`lintSpec` always `ok:true`) fails ≥3 named tests. · Standing line.

### A7.3 A2 — `dispatch.mjs` enforces a **schema-derived floor**, not the full lint

> **Depends on: A1. Sequential after A1; parallel-safe with #8/#9; light conflict with #7 (both edit `dispatch.mjs`) — land after #7 or coordinate. Commit: `feat: dispatch — refuse an executor dispatch on a schema-derived spec violation; realpath the invokedDirectly guard; bump 0.1.NN`. Review lane: adversarial 3-panel (`qa-notes.md:17`).**

**MF2 + architect O-2 — the refusal narrows.** v1 put the *whole* linter in the hard path of every executor dispatch: a heuristic path-parsing checker, in a contract-freeze-set file, with no override, whose `checkValidationCommands` (`:198`) fails on the **parent's** `PATH` — so a project whose validation tool lives in the pane's shell profile but not the orchestrator's Bash `PATH` would become structurally unspawnable. Amended:

| Check class | In `dispatchCmd` | Rationale |
|---|---|---|
| **Schema-derived** — missing required field, wrong type, empty required array (all derived from `handover-spec.schema.json` via A1 item 3) | **refuses**, exit 1 | Structurally cannot false-positive: the spec either has the field or does not |
| **Heuristic** — path existence, `file:line` resolution, binary-on-`PATH` | **passes through as `warnings[]` in the dispatch JSON** | Every one is environment- or timing-dependent; none can safely block |

This dissolves MF2 entirely (the PATH check can no longer refuse) and removes A2's dependency on U4.

**Why narrowing beats the `--require-spec-lint` default-off flag** (the architect offered both; the directive prefers narrowing; I agree): a default-off gate is a gate nobody runs — the same family as `architecture-notes.md:35`'s "a structural check whose already-done state is unobservable will be re-done," except worse, because the flag's off-state is *observable and comfortable*. It also preserves the full false-positive surface for whoever eventually flips it, in a contract-freeze-set file, at a moment when nobody is thinking about spec-lint. Narrowing **removes the risk class**; the flag **defers it and adds a second configuration axis**.

**SF3 — the two spec-lint call sites, distinguished:**

| Site | Job | Skippable? |
|---|---|---|
| `dispatchCmd` (A2) | **Floor** — schema-derived only | No, by construction |
| `spec_gate` segment (post-M) | **Full lint**, incl. heuristics; a FAIL halts `spec_approval` with the lines verbatim | Yes — the orchestrator resolves or overrides |

Different checks, different consequences, both stated in `references/chain.md`. They are not redundant and neither is dropped.

**Files** · `scripts/cmux/dispatch.mjs` (modified) · `test/cmux-dispatch.test.mjs` (modified).

**Scope** — before spawning an `executor`-profile role, `dispatchCmd` calls A1's `lintSpec` on the resolved `--spec`, partitions the result, refuses on any schema-derived failure (exit 1, one JSON object `{error:'spec_schema_invalid', failures:[…]}`, human lines to stderr), and attaches heuristic findings as `warnings[]` on the success JSON. Refusal message is a **named exported constant** with a source-text drift guard. Also: `realpathSync` both sides of the `invokedDirectly` guard (`:1546`).

**Design (invariants restated)** · **Never widen the refusal to judgment or validator roles** — leads receive no Handover Spec, so a spec gate there would refuse every lead dispatch and hard-stop planning. · **Never fall back to dispatching anyway on a linter exception** — an exception is an operational failure (exit 1), never a silent pass; a gate that fails open is not a gate. · **Never let a heuristic check refuse** — a path-parsing heuristic in the hard path of every dispatch, in a frozen file, with no override, is a foot-gun with a one-PR fuse. · `realpathSync` both sides, or a fixture-copied `dispatch.mjs` silently no-ops and every downstream chain test passes vacuously (`backend-notes.md:21`).

**Tests** · positive first: a valid spec dispatches, exactly one `fake-cmux` invocation logged, argv asserted · a spec missing `acceptance_criteria` produces **zero** cmux invocations and exit 1 (assert the empty log *and* the positive above it — `qa-notes.md:12`) · **a spec whose `validation_commands` name a binary absent from the parent PATH still dispatches**, with the finding present in `warnings[]` (the MF2 regression) · a spec citing a stale `file:line` still dispatches with a warning · judgment-role dispatch with no `--spec` unaffected · refusal message asserted against the exported constant + drift guard · symlink-invocation regression.

**Acceptance** · No path exists from a schema-invalid spec to a spawned executor pane. · **No heuristic finding can prevent a dispatch — negative: a mutation promoting a heuristic to the refusal set fails the suite.** · Removing the `realpathSync` change fails the symlink test. · Standing line.

### A7.4 B1 — `gates.mjs` + `evidence.mjs`, shipped as a **standalone CLI**

> **Depends on: A1, re-scoped #9. Parallel with B2. Commit: `feat: gates — evidence-returning check library + gates CLI; bump 0.1.NN`. Review lane: deep (new files, no frozen surface).**

This is the "Option C kernel," and per §A2.1 it is **the deliverable**, not a stepping stone. It ships with its own CLI so the orchestrator can use it with **zero chain**:

```
node scripts/chain/gates.mjs check --task <slug> --slice <slice_id> [--checks a,b,c]
```

One JSON object out (`{checks:[{item,ok,note}], hard_fail, violations[]}`), human lines to stderr. This collapses spec-lint + validation + scope compliance + claim-checking into **one tool call** where prose spends several — capturing the decision-turn win the architect identified, independent of whether the step machine is ever built.

**Checks shipping in B1:** `artifacts_exist` · `files_non_empty` · `json_parses` · `diff_matches_claims` · `scope_compliance` (incl. the two-entry protected set per §A5) · `spec_lint` (full, via A1's library) · `tests_pass(cmd)` · `verdict_consistent` (calibrated per §A4.3).

`evidence.mjs` carries: pinned baseline `{sha, reason, captured_at}` per slice; change-set comparison where **a reversion is a modification**; and the known-commands runner (argv array never a shell string, timeout ⇒ 124, missing binary ⇒ 127, **collect all failures in one pass**, 4000-char tail into `paths.logsDir` — which already exists at `resolve.mjs:104`).

**Invariant restated:** *a failing validation block does not fail the phase* — the runner did its job, the code failed; the result is evidence for the repair loop, not a runner error (sssf invariant 7 + ADR-015).

### A7.5 B2 — `chain-state.mjs` + `chain-state.schema.json`

> **Depends on: nothing. Parallel with B1. Commit: `feat: chain-state — chain.json lifecycle, lock, JSONL ledger; bump 0.1.NN`. Review lane: deep.**

**Why this is firm rather than contingent:** the ledger is the **measurement instrument**. Gate M needs per-slice tool-call and halt counts recorded somewhere durable and machine-readable; hand-counting from a transcript is exactly the un-reproducible method SF4 objects to. B2 pays for itself at M even if the step machine is never built.

New schema **must** be added to `test/schema.test.mjs`'s hardcoded list — it is a list, not a glob, and an unlisted schema is checked by nothing (`conventions.md:24`).

### A7.6 ══ Gate M — the measurement (blocking) ══

**Nothing past this point is specified. Gate M must pass before B3+ is planned.**

**Inputs:** A0 shipped · B1 shipped (gates CLI usable standalone) · B2 shipped (ledger as instrument) · Scout 1's U2 answer.

**Method (SF4 — v1's criterion was unmeasurable):**
- **Metric:** *tool calls per completed slice*, counted from the session transcript (`tool_use` entries), **not** turns — a halt→answer→step triple is three tool calls where prose spends ~two, and turns hide that.
- **Design:** two **paired** tasks of comparable shape — one run on the prose path with A0 + the gates CLI, one on whatever chain shape is proposed. Same tier, same domain, comparable diff size.
- **Tolerance:** the chain path must be **≥15% fewer tool calls per completed slice**, or B3+ does not proceed. A margin below 15% is inside the noise of two single-task samples and cannot justify a third substrate.
- **Poll-turn control:** because A0 lands first, both arms already have the 5× poll reduction, so the measurement isolates the decision class — the only class the runner can affect.

**Also gated here:** U2's hard answer (does a 600s foreground join survive the harness's Bash tool timeout?), since a negative answer invalidates the `still-running` contract that B3+ would rest on.

**Consequence of failure, stated so the gate is real:** if M fails, **B3+ is cancelled**, A0/A1/A2/B1/B2 stand as the initiative's delivered value (a materially better spec ingress and a one-call evidence-returning gate), and the ADRs are recorded as decided-and-not-built. This is decision **D-e** in §A9 — a blocking gate whose failure has no defined consequence is not a gate.

### A7.7 B3+ — contingent sketch only

Re-planned **with the measurement in hand**. Indicative shape, deliberately unfrozen:

| Sketch | Notes |
|---|---|
| **B4a** step machine — `plan`/`step`/`status`, `chain.json` transitions, the §A3.2 subprocess contract, `execution_mode` snapshot, tier-2 table as a plain array in `chain.mjs` | Owns `chain plan` fail-fast validation |
| **B4b** halt projection + `step --answer` refutation + `finish` transition + `test/fixtures/fake-dispatch.mjs` with **frozen live captures** | The plan review is right that B4 was not one PR; the fixture alone is a slice's worth. Owns `finish` |
| **B6** scope gate + protected paths + `green_suite_fresh`/`revised` | Depends on B1 |
| **B7** tier-3 table | **Entry condition (SF7): U8 resolved first** — if plan-reviewer gains a verdict block at #8, B7's design is structurally different. Also: `handover-spec.schema.json`'s `domain` enum has **no `architecture` value** (plan review), which B7 must confront before it lints anything architecture-shaped |
| **B8** ship segment: **teardown only**, incl. the `chain.json.accepted → shouldArchive` fix and the ledger-archival rule (§A6.5). Depends on **#7** | `validate.full` stays orchestrator-owned |
| **B9** wiring — **`orchestration.md` + `commands/team.md` only** | §A7.8 |

### A7.8 B9 — wiring, corrected (MF7)

v1 proposed "substrate-neutral wording" in `next.md`/`ship.md`. **The plan review is right that this is defeat-by-synonym:** the guard's stated purpose (`test/cmux-contract.test.mjs:595-601`) is that every command other than `team.md` stays **substrate-agnostic**, and the chain requires cmux preflight with no Agent-tool backend (§A2.3, permanently). A renamed invocation passes the regex while making `/dev-team:next` substrate-dependent — and a user on `execution_mode: agent-tool` would then run a command that drives a runner which cannot start.

**Amended: B9 wires only the two exempt surfaces** — `orchestration.md` (≤2 lines, within the test-granted headroom at 67/69) and `commands/team.md`. `next.md`, `ship.md`, `onboard.md`, `pr-review.md` receive **nothing**; the closed `GUARDED_COMMANDS` manifest is untouched and the `/dev-team:next` path stays substrate-agnostic.

**Consequence, accepted:** the chain is reachable only through `team.md`'s mode verb and `orchestration.md`'s flow rules — a slightly less discoverable entry point, in exchange for an invariant that stays true rather than merely passing.

**Open question deferred to the re-plan:** whether chain mechanics live in a second on-demand reference (`references/chain.md`, ratification **R6**) or fold into `references/cmux-dispatch.md` (91 → ~140 lines).

---

## §A8. Ratification required — renumbered, eleven items

**Brain-file amendments (the load-bearing ones):**

- **R1 — `references/qa-gate.md:7`.** *"you (the orchestrator) re-run them directly via Bash"* → *"…runs deterministically in the parent process — your own Bash call, or the chain runner on your behalf — never as a window."* A fourth narrow exception to "brain unchanged." **The initiative's turn-count thesis depends on this** (§0).
- **R2 — `orchestration.md:58` (new, MF4).** The *same* invariant is stated in the injected brain file itself, as one of "three invariants regardless of tier." v1 flagged only the reference file. R1 without R2 leaves the brain file contradicting the reference it points at.
- **R3 — A1's spec-lint semantics (new, MF4).** Binding constraint (1) names **spec-lint** explicitly among the unchangeable brain surfaces, and one exception already exists *because* changing spec-lint's FAIL/WARN classification needed one (D16). A1 downgrades three FAILs to WARNs and changes which paths parse. That is a fourth spec-lint exception and must be ratified as one, not slipped in as a bug fix.
- **R4 — `verdict_consistent` widens `inconclusive`'s producer set (new, MF6 / architect 2b-i).** Both existing definitions are about *absence*; a third producer exists at `return-lint.mjs:99`. Even under §A4's stricter design (the chain never writes the enum), the *concept* of a present-but-self-contradictory verdict is new to the brain vocabulary. The "zero brain change" claim in v1 is withdrawn.

**Structural:**

- **R5 — `orchestration.md` line ceiling.** File at 67, test-enforced ceiling 69; the epic's ≤8-line budget implies 71. **B9 targets ≤2 lines and no ceiling change**; if the re-plan needs more, editing the constant is a deliberate act requiring this ratification.
- **R6 — a second on-demand reference (`references/chain.md`).** Epic binding constraint (2) says "mechanics in ONE reference." Argued deviation: that constraint scoped *cmux* mechanics; the chain is a distinct subsystem with a distinct trigger. Alternative if refused: fold in and accept the read cost.
- **R7 — A2's schema-derived floor inside `dispatch.mjs`.** Adds a refusal path to a contract-freeze-set file. *Argument materially weakened in v2's favor by the narrowing:* the floor changes nothing about **what spec-lint means** — it makes a structurally-safe subset unskippable. Still flagged, at reduced weight.

**New bounds:**

- **R8 — the `spec_gate` bounce bound (new, MF3).** Two bounces then `escalation`. No existing brain bound covers spec-gate bounces. A genuinely new bound; ADR-014's "count existing bounds only" does not authorize it.
- **R9 — mechanically enforcing the ≤2 amend bound.** The bound is unchanged and the escalation content stays the orchestrator's; argued not a brain change, but it operates directly on `orchestration.md:53`'s territory and should be confirmed rather than assumed.

**Recorded non-deviations (kept — a rejection that is not written down gets re-proposed):**

- **R10 — ADR-007 is NOT deviated from.** Option B (absorbing `team-build.workflow.mjs`) rejected; no deviation requested.
- **R11 — "gate never fired from code" is NOT deviated from.** The chain halts; the orchestrator fires `phase --set gate`.

---

## §A9. Decisions required of the user

- **D-a — the eleven ratifications in §A8**, especially **R1+R2** (§0: the thesis depends on them) and **R3** (a fourth spec-lint exception).
- **D-b — Phase gating.** Interleave with #15 (A0/A1/A2 need only a re-scoped #9; B1 needs #9; B8 needs #7; the tier-3 sketch needs #8), or wait for the full epic? **Recommendation: interleave.**
- **D-c — three substrates, permanently.** No longer a choice between "accept three" and "schedule a deprecation" — the deprecation path is unbuildable (§A2.3). This is a fact to confirm, and confirming it means accepting that `team-build.workflow.mjs` is maintained indefinitely as the agent-tool-mode batch engine.
- **D-d — the central behavioral bet (promoted from U5, SF5).** The initiative assumes the orchestrator will *call `chain step` in a loop* rather than narrate around it — carried by ≤2 lines of `orchestration.md` headroom, with no mechanical enforcement and no way to measure compliance except by observing runs. If the orchestrator narrates *and* calls, the chain is pure overhead. **The user should decide whether that bet is acceptable before B3+ is planned**, since gate M measures the bet's payoff only under the assumption that it is taken.
- **D-e — does gate M bind?** If the measurement shows <15% improvement, is **B3+ cancelled** (§A7.6)? A blocking gate whose failure has no consequence is theatre. Recommendation: yes, it binds, and A0/A1/A2/B1/B2 stand on their own merits.

---

## §A10. ADRs — consolidated to three (supersedes v1 §11's six)

v1 proposed ADR-014…019. The architect is right that 015 and 019 are consequences of 014/016 and that 017 is an implementation detail. Three carry the same durable content. **Numbering continues the epic's committed ADR-013** (`architecture-notes.md:18`).

**ADR-014 — Position and state: the phase-chain runner is a resumable step machine above the await loop; a third substrate, permanently; its state is parent-side and its dispatch cache is never an authority.**
Absorbs v1's ADR-014 + ADR-015 + ADR-017.
*Decision:* the runner advances maximally per invocation and returns one JSON object; it drives `dispatch.mjs` by **spawn** behind a `DISPATCH_BIN` seam (process isolation, fake seam, version-skew tolerance — **not** the self-refuting "sole spawner" argument); it consumes `ladder.mjs` output; it **never touches `team-build.workflow.mjs`** (no ADR-007 deviation) and **there is no convergence path** — three substrates serve three different things, permanently. It **cannot invoke the Agent tool**, so `Explore` and discovery stay orchestrator-owned. **It owns zero retry counters**: it may count an existing bound and refuse to advance past it; it may never choose a bound, resolve a retry, or author an escalation (the one new bound, `spec_gate`, is ratified separately as R8). Correction-not-respawn for output *shape* is the already-shipped `return-gate.sh` loop; **content-gate failure produces a full respawn, not a correction** (triage overturn, §A11). State lives at `<STATE_DIR>/chain.json` + `chain.jsonl` (JSONL, not `node:sqlite` — Node 20 floor), never TASK_DIR (Rider C disclosure), never `status.json` (overwritten wholesale, `dispatch.mjs:1364-1365`), never a new `task.json` (does not exist, `resolve.mjs:90-112`). **`listRecords` is the sole authority on what was dispatched; `chain.json.phases[].dispatch_ids` is a cache that must never contain an unconfirmed id.** `execution_mode` is snapshotted at `chain plan` and a change fails closed.
*Why:* D4's foreground-chunked rule forbids a long-blocking segment, and resumability *is* sssf's segment join, so one mechanism serves both; the cache rule closes a duplicate-pane crash window that phase-granularity records cannot see; the retry line is the boundary between a driving suite and a decision-maker.

**ADR-015 — Envelope and gate authority: one validator over `returns/`; gates are a separate post-completion layer producing evidence; phase status is not run acceptance.**
Absorbs v1's ADR-016 + ADR-018.
*Decision:* `return-envelope.schema.json` + `ladder.validateReturn` remain the **only** validator over `returns/`. `gates.mjs` runs *after* the ladder reports `completed` and yields a `GateReport` of `{item, ok, note}` with **evidence on pass**, never an envelope and never an `OUTCOMES` value (`contract.mjs:21` — the frozen enum; the mapping table is at `dispatch.mjs:102-114`). `completed`/`outcome` answers "did the dispatch finish"; the GateReport answers "is the work sound"; `chain.json.accepted` answers "does this run pass"; **the only consumer that ever conflated them is `teardownCmd`, and B8 fixes it.** `verdict_consistent` is a **consistency-refutation** check that **halts on first occurrence and never auto-re-runs, never re-routes, and never rewrites a worker-authored `verdict` field**; `pass ∧ ∃critical` ships as a hard refutation, `changes-needed ∧ empty findings` ships as evidence-only. **Panel majority does not exist in `scripts/` today**; it is a dependency being acquired from #8, and if #8 ships D17 without an aggregator the chain does not write one.
*Why:* two validators over `returns/` breaks single authority; widening step 2 would redefine `completed` (ADR-003), force the frozen outcome enum to grow, and ship gate logic into the worker-writable snapshot (`return-lint.mjs` is a thin CLI that runs *inside* it — the trust-M1 shape at `architecture-notes.md:27`); halting rather than re-running keeps ADR-014's zero-counter rule intact without a new bound.

**ADR-016 — Write boundaries: enforced after the fact, refuse-and-report, with a two-entry protected set layered under the frozen siting constant.**
Replaces v1's ADR-019.
*Decision:* pinned per-slice baseline `{sha, reason, captured_at}` captured at first dispatch and covering all attempts; change-set comparison in which **a reversion counts as a modification**; scope violations bounce through the existing `changes-needed` path. **Protected set = `.claude/dev-team/memory/**` + `.claude/dev-team/config.md`, and nothing else** — `scripts/**` and `hooks/**` are this repo's *product* and protecting them would escalate on the plugin's own development. A protected path appearing in `files_in_scope` is a **spec error caught at `spec_gate`**, never a runtime breach. **Layering, stated once and never unified:** `contract.mjs:31 PROTECTED_PATH_COMPONENTS` answers *where the dispatcher may site an agent-writable directory* (frozen, unchanged, path-derivation time); the chain set answers *which touched files are a breach rather than a scope violation* (new, parent-side, after the fact). **No auto-rollback** (`conventions.md:23`; and it destroys the evidence the amend loop needs).
*Why:* closes a live gap — a coder's worktree contains `.claude/dev-team/memory/**` inside its own `Edit(//worktree/**)` grant and `changes_expected` does not refuse it, so the memory single-writer rule currently has no mechanical backstop. The narrow set also answers the plan review's skepticism qualification: `hard_fail` fires only on a two-entry, exact-prefix, glob-free set whose computation is auditable by eye.

---

## §A11. sssf invariant triage — overturns and qualifications (amends v1 §10)

Both overturns from the plan review are adopted. All other v1 verdicts stand.

| # | Invariant | v1 | **v2** | Reason |
|---|---|---|---|---|
| **4** | Correction-not-respawn | ADAPT | **SPLIT: VERBATIM for shape / REJECT for content** | **Overturned.** For output *shape*, `return-gate.sh`'s in-session ≤2 loop is a verbatim implementation, already shipped. For *content* gates, what v2 actually ships is a **full pane respawn** (`attempt+1`, worktree reused, GateReport in the kickoff). Calling that "ADAPT" hid a real recurring cost — a fresh pane, a fresh context, full prefix re-read per content-gate failure. Naming it REJECT makes the cost visible and makes the deferred in-session alternative (blocked by `gate-mode.sh:47-51`'s sticky observe and the absence of any captured session id) a legible future trade rather than a phantom already-claimed win. |
| **6** | Write boundaries enforced after the fact | ADAPT | **ADAPT, qualified** | **Qualification adopted:** v1 forbade rollback on the grounds that the set-difference computation is not trustworthy enough for a destructive action, while letting the *same* computation trigger a hard-fail escalation. v2 earns the asymmetry rather than asserting it: after §A5's narrowing, `hard_fail` fires only on a two-entry, exact-prefix, glob-free set; every judgment requiring the general glob machinery degrades to a correctable scope warning. Rollback stays rejected. |

Unchanged and explicitly re-affirmed by both reviewers as good calls: **#3** ("deterministic results never wear an agent's envelope") — which §A4.2 now applies to `verdict_consistent` itself — and **#13**'s split (reject per-phase commits, adopt the stale-green rule).

---

## §A12. Acceptance criteria — amended (supersedes v1 §16)

**Initiative-level (M-gated):**

1. **Tool calls per completed slice** (SF4): measured from session transcripts across **two paired tasks**, chain path vs prose path, both with A0 landed. **Threshold: ≥15% reduction**, else B3+ is cancelled (D-e).
2. **Halt budget (architect 1a-ii):** a **clean Tier-2 slice** — no amend cycle, no `spec_gate` bounce — emits **≤3 halts** (`spec_approval`, `gate_route`, `acceptance`). Asserted in tests against the fake, and observed at M.

**Slice-level (unchanged from v1 except where noted):**

3. No path exists from a **schema-invalid** spec to a spawned executor — zero fake-cmux invocations, paired positive first.
4. **No heuristic spec-lint finding can prevent a dispatch** *(new, MF2)* — negative: a mutation promoting a heuristic to the refusal set fails the suite.
5. The chain **never resolves a judgment** — proven by mutation: a decision-fabricating mutation in `step --answer` fails the suite.
6. `step --answer` refuses a decision contradicting a `hard_fail` gate, exit 2, message asserted against the exported constant; `--override` writes a ledger line carrying the reason.
7. **The chain never rewrites a worker-authored `verdict` field** *(new, §A4.2)* — negative: a mutation writing `inconclusive` into the envelope fails the suite.
8. **A refused chain archives; an accepted chain does not** *(new, §A6.5)* — both asserted, plus absent-`chain.json` preserving today's behavior.
9. **`chain.json.phases[].dispatch_ids` never contains an id `listRecords` does not confirm** *(new, FM-5)* — negative: a simulated crash between spawn and persistence produces **zero** second dispatches; the reconciler adopts the orphan record.
10. **`chain_lock_stale_s > await_lock_stale_s`** *(new, FM-4)* — asserted as an equation, with a test that fails if the ordering inverts.
11. **Exit 2 with empty stdout is classified as the chain's own argv bug, not as lock contention** *(new, FM-1)* — the fake reproduces the asymmetry.
12. A killed `chain step` leaves the phase `status:"fail"` and the next step reclaims the stale head; two concurrent steps ⇒ the second refuses exit 2 naming the holder; a corrupt lock is stale, never a wedge.
13. Every gate check returns **evidence on pass**, not just a reason on fail — asserted per check.
14. A protected-path modification hard-fails and names every path; a scope-only violation warns without hard-failing; **a protected path in `files_in_scope` fails at `spec_gate`, before any dispatch**.
15. Every new schema is in `test/schema.test.mjs`'s hardcoded list — asserted by that file's own completeness check.
16. Standing line: `node --test` green, suite growth ≤10s, **no cmux, no claude, no model, no network, no GUI.**

---

## §A13. Evidence table — v1's V-list with review annotations

| # | Claim | Status |
|---|---|---|
| V1 | `spec-lint.mjs` cannot be imported | **Confirmed by plan review**, plus: **spec-lint has no `invokedDirectly` guard at all today** — A1 *adds* one |
| V2 | Second `UserPromptSubmit` permanently disables the return gate (`gate-mode.sh:47-51`) | **Confirmed by plan review** |
| V6 | Guarded-commands manifest (`test/cmux-contract.test.mjs:604-631`) | **Confirmed** — and see MF7: passing the regex ≠ satisfying the invariant |
| V7 | `orchestration.md` 67 lines vs ceiling 69 | **Confirmed**; "2 lines in practice" affirmed |
| V8 | The one-cmux-reference test is a filename glob | **Confirmed** |
| V13 | Outcome mapping at `dispatch.mjs:102-114` | **Confirmed, with citation correction: the frozen enum itself lives at `contract.mjs:21`** |
| V3, V4, V5, V9, V10, V11, V12, V14 | (session-id absence; status.json overwrite; no task.json; resolvePath guard; private extractSection; leads return markdown; memory-inside-worktree grant; Node 20 floor) | **Not re-verified by the plan review; each stands on a v1 direct read** |
| — | `handover-spec.schema.json` `required` byte-identical to `REQUIRED_FIELDS` | **New, from plan review** |
| — | `handover-spec.schema.json` `domain` enum has no `architecture` value | **New, from plan review** — B7 must confront |
| — | `AWAIT_CAP_DEFAULT_S = 120` / `AWAIT_CAP_MAX_S = 600`, both module-private | **New, verified this session** — A0 is documentation-only |
| — | `dispatch.mjs:1398` archives on a hardcoded `{outcome:'ok'}` | **New, from architect** — a live defect in shipped code |
| — | **No panel-majority aggregation exists in `scripts/`** | **New, from architect** — v1 §5.3 was factually wrong |
| — | Hyphenated-path root cause: `-` absent from the negative lookbehind at `spec-lint.mjs:137`/`:147` | **New, derived this session** — a one-character fix with a reproducing test |
| — | `spec-lint.mjs:118`/`:147-152`/`:113`/`:198` — the four checks A1 softens or A2 declines to enforce | **Verified this session** |
| — | The double-extension defect (`backend-notes.md:22`) | **Unverified and doubted** — A1's tests decide; a non-reproducing item is struck and the memory note corrected |
| — | #7/#8/#9 gating claims (U7) | **Open** — a two-minute `gh issue view` before the Phase-B epic is filed |

**Unknowns, amended:** U2 is now a **blocking gate** (M). **U4 no longer gates A2** (the narrowing removed the PATH refusal) but still gates B1's `tests_pass`. U5 is promoted to decision **D-d**. U8 becomes an entry condition on the tier-3 re-plan. U1/U3/U6 unchanged and low-risk; U3's mitigation is now the *only* justification for truncation.

---

## §A14. Recommended team dispatch — amended

**Research (Scout 1 is now blocking):**

- **Scout 1 — `Explore` (sonnet), BLOCKING GATE M.** (a) Establish the tool-calls-per-completed-slice baseline from a recent shipped transcript (`tool_use` entries, transcript-first protocol per `qa-notes.md:20`). (b) Determine the harness's effective Bash tool-timeout ceiling (**U2**), which A0 also probes cheaply.
- **Scout 2 — `Explore` (sonnet), before B1's `tests_pass`.** Environment parity (**U4**): one identical validation command in a cmux pane vs the orchestrator's Bash; diff `PATH` / `which node` / package-manager bin resolution. *No longer gates A2.*
- **Orchestrator, not a scout:** U7 (`gh issue view` #11/#13 before filing the Phase-B epic) and U8 (does #8 give plan-reviewer a verdict block?).

**Feasibility consults (brokered — assemble both domains' context, consult together):**

- **`backend-lead`:** the five subprocess failure modes in §A3.2 — is FM-5's "listRecords is the sole authority" reconciler sound, and where exactly does the adoption happen? Does `chain-state.mjs` reuse `record.mjs`'s `withRecordLock` or own its lock, and how is FM-4's staleness ordering asserted? Does `chain.json` stay inside BUDGET with `type: ["boolean","null"]`?
- **`qa-lead`:** `fake-dispatch.mjs` design and **which real `dispatch.mjs` outputs must be frozen live captures** — specifically FM-1's exit-2 asymmetry; the named degenerates for `canAdvance`'s conjunctive predicate; the ≤10s suite budget; the measurement method for gate M (is transcript `tool_use` counting reproducible enough to bind a decision?).
- **`devops-lead`:** Node 20 floor, zero-dependency preservation, CI wall-clock headroom.
- **No `frontend-lead`** — no frontend surface exists here (`config.md:58`).

**Review gate:** `dev-team:plan-reviewer` re-review of **v2** (mandatory; author ≠ reviewer). A second `dev-team:architect` pass is **not** recommended — the architect's material objections are all adopted, and the remaining open items are measurements and user decisions, not design alternatives.

**Build dispatch shape (post-approval):** A0 (Tier-1-sized, orchestrator direct) → A1 → A2, sequential, one `backend-lead` spec + one coder each. Then **B1 ‖ B2** (disjoint files, no `depends_on`). Then gate **M**. Parallel coders never run the full suite mid-wave (`qa-notes.md:15`); mutation-testing runs alone (`qa-notes.md:14`); slices touching `scripts/cmux/*.mjs` take the adversarial 3-panel with `test-engineer` first and alone on the frozen tree (`qa-notes.md:17`).

---

## §A15. Proposed memory deltas — amended (supersedes v1 §18)

*(The orchestrator commits; I only propose. Only deltas that changed from v1 are restated; v1's unchanged conventions entries stand as proposed there, with the two corrections noted.)*

### → `.claude/dev-team/memory/architecture-notes.md`

- **2026-08-04** — **ADR-014 (proposed): the phase-chain runner is a resumable step machine above the await loop; three substrates, permanently; dispatch records are the sole authority on what was dispatched.** Advances maximally per invocation, one JSON object out; drives `dispatch.mjs` by spawn behind `DISPATCH_BIN` (process isolation + fake seam + version-skew tolerance — *not* a "sole spawner" invariant, which self-refutes given `evidence.mjs`); cannot invoke the Agent tool; **never touches `team-build.workflow.mjs` and has no convergence path** — an Agent-tool backend for a script is unbuildable by construction. **Owns zero retry counters.** State at `<STATE_DIR>/chain.json` + `chain.jsonl`. **`listRecords` is the sole authority; `chain.json.phases[].dispatch_ids` is a cache that must never contain an unconfirmed id.** `execution_mode` snapshotted at `chain plan`; changes fail closed. Status: proposed. Supersedes v1's ADR-014/015/017 and its convergence trigger.
- **2026-08-04** — **ADR-015 (proposed): one validator over `returns/`; gates are a separate post-completion evidence layer; phase status is not run acceptance.** `gates.mjs` runs after `completed`, yields `{item, ok, note}` with evidence on pass, never an envelope, never an `OUTCOMES` value (frozen enum at `contract.mjs:21`). **`verdict_consistent` halts on first occurrence, never auto-re-runs, never re-routes, never rewrites a worker-authored `verdict` field**; `pass ∧ ∃critical` ships hard, `changes-needed ∧ empty findings` ships evidence-only. **Panel-majority aggregation does not exist in `scripts/` today** — acquired from #8; if #8 ships D17 without one, the chain does not write it. Status: proposed. Supersedes v1's ADR-016/018 and its `inconclusive`-mapping claim.
- **2026-08-04** — **ADR-016 (proposed): write boundaries enforced after the fact; protected set is two entries, layered under the frozen siting constant.** Protected set = `.claude/dev-team/memory/**` + `.claude/dev-team/config.md` **only** — `scripts/**` and `hooks/**` are this repo's product. A protected path in `files_in_scope` is a spec error at `spec_gate`. **Layering (never unify):** `contract.mjs:31` answers *where the dispatcher may site*; the chain set answers *which touched files are a breach*. No auto-rollback. Status: proposed. Supersedes v1's ADR-019.
- **2026-08-04** — **`teardownCmd` archives on a hardcoded `{outcome:'ok'}` (`dispatch.mjs:1398`) — a live defect; fix owned by B8, dependency on #7.** A refused-acceptance run has its task dir *and* state dir deleted rather than archived, destroying the audit trail exactly when it matters. Fix: read `chain.json.accepted`, pass `{outcome: accepted === true ? 'ok' : 'refused'}`; absent `chain.json` preserves today's behavior. **Ledger lifetime:** `chain.jsonl` rides into the archive whenever the task archives; a refused run keeps its ledger, an accepted run discards it.
- **2026-08-04** — **`--max-block-s` defaults to 120s (`dispatch.mjs:927`) with a 600s clamp ceiling (`:929`), and the reference recommends no value — every orchestrator pays ~5× the poll turns it needs.** Both constants module-private; the fix is one documentation line. *Why:* orchestrator turns decompose into poll turns (dominant) and decision turns; a chain runner cannot reduce poll turns at all — any turn-count claim must state which class it addresses.
- **2026-08-04** — **Deterministic-backbone gating: the step machine is a measured hypothesis, not an approved build.** A0 → A1/A2 → B1 ‖ B2 → **blocking gate M** (tool-calls-per-completed-slice, two paired tasks; **≥15% or B3+ is cancelled**) → re-plan. *Why:* v1 froze nine slices and a segment DSL for an unmeasured thesis; the gate library captures most of the decision-turn win with no sequencing claim.

### → `.claude/dev-team/memory/conventions.md`

*(v1's proposed entries stand, with two corrections and two additions.)*

- **CORRECTION to v1's JSONL entry:** drop the PIPE_BUF/4096-byte correctness rationale — PIPE_BUF governs pipes, not `appendFileSync` to a regular file. Keep truncation as a readability rule only.
- **CORRECTION to v1's `realpathSync` entry:** applies to `dispatch.mjs:1546` (has a `resolvePath` guard) and `spec-lint.mjs` (has **no guard at all** — A1 adds one). Both need a symlink-invocation regression test.
- **2026-08-04 (new)** — **A blocking gate whose failure has no defined consequence is not a gate.** Any plan declaring a measurement/spike/scout "blocking" must state, in the same sentence, what is cancelled or re-scoped if it fails. *Why:* v1 named U2 its highest-impact unknown and then scheduled the dependent slices anyway; the fix was a named consequence (B3+ cancelled below 15%).
- **2026-08-04 (new)** — **A guard that a synonym defeats is not a guard: check the invariant, not the regex.** `test/cmux-contract.test.mjs` greps `/cmux/i`+`/roster/i`; its stated purpose is that guarded commands stay **substrate-agnostic**. Wiring a guarded command to a cmux-requiring runner under a neutral name passes the test and breaks the invariant. Wire only the exempt surfaces, or re-argue the guard's rationale first. *Why:* caught in plan review of the deterministic-backbone package, where "substrate-neutral wording" was proposed as compliance.

---

## §A16. Files referenced (absolute paths)

**v2 inputs:** `tasks/deterministic-backbone/plan-review-v1.md` · `tasks/deterministic-backbone/architect-consult-v1.md`
**Superseded predecessor (stays parked):** `tasks/deterministic-backbone/architecture-package-v1.md`
**Digests:** `tasks/deterministic-backbone/{repo-internals,cmux-design-record,sssf-mechanisms}.md`
**Verified this session (v2-specific):** `scripts/cmux/dispatch.mjs` (`:927`, `:929`, `:930`, `:939-958`, `:1398`, `:1495-1506`, `:1517`, `:1528-1531`, `:1546`) · `scripts/cmux/contract.mjs` (`:21`, `:31`) · `scripts/spec-lint.mjs` (`:105-152`, `:198`)
**Slice targets:** `references/cmux-dispatch.md` (A0) · `scripts/spec-lint.mjs` (A1) · `scripts/cmux/dispatch.mjs` (A2, B8) · `scripts/chain/{chain,chain-state,gates,evidence}.mjs` + `chain-state.schema.json` (B1/B2/B4) · `test/{spec-lint,cmux-dispatch,chain,chain-state,chain-gates,chain-evidence}.test.mjs` · `test/fixtures/fake-dispatch.mjs`
**Epic action required before A1:** superseding comment on issue **#9** (re-scope: spec-lint deliverable moves to A1; noise-globs + read points + unfiltered scope check remain).
