# Architecture Package — Deterministic Backbone / Phase-Chain Runner

**Author:** architecture-lead · **Date:** 2026-08-03 · **Repo:** `/Users/x/Development/dev-team-claude-plugin` @ `0e21025` (v0.1.48)
**Status:** draft, pending `dev-team:plan-reviewer` + user approval
**Inputs:** `tasks/deterministic-backbone/{repo-internals,cmux-design-record,sssf-mechanisms}.md`; project memory (`conventions.md`, `architecture-notes.md`, `backend-notes.md`, `qa-notes.md`); direct reads listed inline.

---

## 0. Problem / goal

Today mechanical sequencing across the task lifecycle is carried by the orchestrator's prose loop: it classifies the tier, dispatches scouts, dispatches leads, transcribes and lints specs, dispatches coders, counts amend cycles, picks a review bundle, re-runs validation, aggregates verdicts, and ships. Every one of those steps costs a model turn in the one context that is never discarded (`orchestration.md:66`). The failure modes are the ones sssf names: a step silently skipped, a "green" light that went stale after a revision, a claim (`changes[]`) nobody checked against the diff, an approval that contradicts its own evidence.

**Goal:** move the mechanical spine into deterministic Node code that runs as *segments joined by task id*, with the orchestrator as the judgment node between segments — keeping tier calls, spec/package content approval, escalation wording, acceptance, user conversation and memory writes exclusively in the model, and adding mechanical *refutation* of judgment envelopes (never mechanical resolution).

**Non-goals (explicit):** the herder (deferred until epic #15 completes, per user ratification); the sssf visualizer; an Agent-tool backend for the chain; replacing `team-build.workflow.mjs`; per-phase commits; auto-rollback of agent writes.

---

## 1. Artifact decision

| Artifact | Needed? | Why |
|---|---|---|
| **TRD/RFC** | **Yes** (§2–§9) | The hard part is architecture: position among three existing substrates, envelope/gate authority, state location, and the resumability constraint that D4 imposes. |
| **ADRs 014–019** | **Yes** (§11) | Six durable decisions that will be revisited (position, retry ownership, envelope authority, chain state, phase-vs-acceptance, write boundaries). Numbering continues the epic's committed ADR-013 (`architecture-notes.md:18`). |
| **Execution plan** | **Yes** (§12) | Buildable; needs one-PR slicing, Phase A/B split, dependency graph. |
| **PRD-lite** | **No** | The product behavior is already specified by `orchestration.md`, `references/tier3-planning.md`, `references/qa-gate.md` and the ratified mission statement. Personas and success criteria are not ambiguous; the *mechanism* is. Writing a PRD-lite here would be ceremony. |

---

## 2. Ground truth and binding constraints

Verified by direct read this session unless marked otherwise.

**Stack (user-ratified, non-negotiable):** Node ESM `.mjs`, zero dependencies, `contract.mjs`-style validation (no ajv — `conventions.md:24`), flat schemas inside the 15-keyword BUDGET, atomic writes (`conventions.md:28`), CLI-as-library, header comment blocks, named exported constants for every refusal message (`qa-notes.md:12`).

**Node 20 floor.** `.github/workflows/test.yml` pins `setup-node 20`; `scripts/cmux/ladder.mjs:2` restates it. `node:sqlite` is a Node 22.5+ builtin — **unavailable**. The ledger must be file-based.

**Substrate facts that shape the design:**

1. **`await --all` is foreground and chunked, and the orchestrator loops** (D4, ratified deviation; `orchestration.md:42`; `references/cmux-dispatch.md:17-23`). Background Bash ends the turn and nothing resumes the model. Pane timeouts are 1800–3600s (`roster.default.json:39,101,111`). **Therefore a chain segment cannot be one long-blocking subprocess** — it must be a resumable step machine with the same chunked rhythm. This is the single most load-bearing constraint in the package.
2. **`await.lock` refuses a concurrent await, exit 2, naming the holder PID** (v2.1 §D). A chain that shells `await` in parallel with the orchestrator's own loop deadlocks by design.
3. **`completed ⟺ isFresh ∧ validateReturn().ok`** and completion is re-derived from the ladder on *every* wake (ADR-003; `ladder.mjs:39,134-162`). Nothing a worker writes moves it.
4. **`OUTCOMES` is a frozen 8-value enum**; adding a value bumps `dispatch-record.schema.json` (`conventions.md:29`). Gate results must not become outcomes.
5. **`phase --set gate` is never fired from code** (`references/cmux-dispatch.md:43`).
6. **Inertness guard** (`test/cmux-contract.test.mjs:604-631`): `GUARDED_COMMANDS = ['next.md','onboard.md','pr-review.md','ship.md']` must contain no `/cmux/i` or `/roster/i`, closed `deepEqual` manifest; `team-build.workflow.mjs` and `hooks/hooks.json` likewise. **Any chain wiring in `next.md`/`ship.md` must be substrate-neutral in wording.**
7. **`orchestration.md` is 67 lines against a test-enforced ceiling of 69** (`test/orchestration.test.mjs:9-13`). The epic's "≤8 added lines, 4 used" budget implies 4 more, but **the test currently grants only 2**. Raising the constant is a deliberate edit.
8. **Exactly one `references/cmux-*.md`** (`test/orchestration.test.mjs:31-34`) — a *filename glob*, so `references/chain.md` does not trip it; but epic binding constraint (2) says "mechanics in ONE reference," which is a scope question, not a test.
9. **`scripts/spec-lint.mjs` has no exports** — module-level `const {root,input} = parseArgs(...)` at `:202`, `process.exit` at `:212`, `failures`/`warnings` as module-scope arrays at `:33-34`. It is **not** CLI-as-library and cannot be imported. Its required-field list is a literal duplicate of the schema (`:18-21`). It hard-FAILs any not-yet-existing `dir/name.ext` in `discovery_context` (`:147-152`) and mis-parses hyphenated absolute paths and double-extension filenames (`backend-notes.md:17,22`). **Mechanizing spec-lint as a gate is blocked on those two defects** — an automated gate would bounce nearly every valid spec.
10. **`gate-mode.sh:47-51`**: the *second* `UserPromptSubmit` per dispatch flips the return gate to `observe`, **sticky, permanently**. A code-driven correction sent into a live pane therefore disables the worker-side shape gate for the rest of that dispatch.
11. **No session id is captured anywhere.** `adapter-claude.mjs:271` derives a `session_resume` *capability* boolean from `--help` text; nothing records a session id. `claude -p --resume` is **not** an available correction channel for pane dispatches without new work.
12. **Leads return markdown, not JSON specs.** `roster.default.json:112,122,132` — `required_sections: ["Handover Spec", …]`. `handover-spec.schema.json` is machine-validated **nowhere** (repo-internals §3). The `spec/<slice>.json` file that `dispatch --spec` consumes (`resolve.mjs:140-143`) is therefore already produced by orchestrator transcription today.
13. **`statusCmd` overwrites `status.json` wholesale on every call** (`dispatch.mjs:1364-1365`) — it is a derived, disposable projection, not a state store.
14. **`taskPaths` already provides `logsDir`, `statusPath`, `lockPath`, `worktreesIndexPath`** (`resolve.mjs:104-110`) and there is **no `task.json`** in code — that name exists only in the design record.
15. **`dispatch.mjs`'s `invokedDirectly` guard uses `resolvePath` on both sides** (`dispatch.mjs:1546`), not `realpathSync` — the exact silent-no-op trap `backend-notes.md:21` documents. Harmless in the plugin root; **fatal for any test fixture that copies or symlinks `dispatch.mjs` under macOS `TMPDIR`**.
16. **`return-lint.mjs`'s `extractSection` and its fenced-block scanner are private** (`return-lint.mjs:165`, not exported) — a parent-side consumer must either export them or duplicate them (duplication breaks single authority).
17. **Judgment roles run `isolation: "primary"`** (`roster.default.json:88,97,107,…`) and coders run `worktree`. A coder's worktree is a worktree of *this* repo, so `.claude/dev-team/memory/**` exists inside it and `worktree_write` grants `Edit(//worktree/**)`. **The memory single-writer rule is currently enforced by instruction only, with no mechanical check.**

**Epic invariants that hold unchanged:** brain unchanged (three narrow exceptions only); ≤8 added `orchestration.md` lines; cost discipline + D15 byte-stable prefixes; every new script gets `test/<name>.test.mjs` with no model/network/GUI; version bump every commit; cmux prerequisite with no silent Agent-tool fallback.

---

## 3. Position — the sharpest question (Q1)

### 3.1 The unclaimed slot, restated precisely

`dispatch.mjs` sequences *within* a dispatch. The orchestrator sequences *between* dispatches. `team-build.workflow.mjs:258-293` sequences *waves* on a different substrate. Nothing owns **cross-phase sequencing joined by task id** — the collision analysis (§4.6) is right.

But the slot has a shape imposed by constraint §2.1: **whatever fills it must be resumable, not blocking.** That single fact eliminates the naive reading of every option.

### 3.2 Options

**Option A — chain-segment CLI driving `dispatch.mjs` in cmux mode.**
A new `scripts/chain/chain.mjs` owning a per-task phase chain; each invocation advances the chain as far as mechanically possible and returns one JSON object; the orchestrator loops on it exactly as it loops on `await --all` today. Agent-tool path explicitly out of scope.
*Optimizes:* the mission's stated destination; segment join falls out of on-disk state; the orchestrator's loop rhythm is unchanged (same tool, same shape, one fewer decision per iteration).
*Sacrifices:* a third substrate; a second place where "what comes next" is written down (drift risk against `orchestration.md`); requires the orchestrator to learn one new CLI.

**Option B — absorb/supersede `team-build.workflow.mjs`.**
Re-express workflow mode as chains; the workflow script becomes a thin caller or is retired.
*Optimizes:* one sequencing engine instead of two; kills the known gap that "the workflow can't run spec-lint mid-script" (`commands/team.md:12`).
*Sacrifices:* requires a §13-style ratified deviation from **ADR-007** ("Workflow mode stays on the Workflow tool's `agent()` dispatch") *and* from the shipped 1d carve-out line, *and* it trips `test/cmux-contract.test.mjs:622` (workflow file must contain no `cmux`). Worse: the workflow's distinguishing capability is that it runs with **no cmux prerequisite** — absorbing it into a cmux-dependent chain deletes the only substrate that works when `execution_mode: agent-tool`. That is a capability regression dressed as consolidation.

**Option C — thin "gate executor."**
Mechanize only spec-lint, envelope/content gates and retry bookkeeping; the orchestrator keeps every sequencing decision.
*Optimizes:* minimum blast radius; zero ADR conflict; every piece is useful standalone; testable in isolation.
*Sacrifices:* does not deliver the mission (turn count barely moves — the orchestrator still narrates every step); it is a *component*, not a position.

### 3.3 Recommendation — **A, with C as its kernel, built in that order**

C is not an alternative to A; it is A's inner layer. The gate library and evidence layer are exactly what A's step machine calls. Building C first makes every Phase-A slice independently valuable even if A is never approved, and it defers the sequencing claim until the gates that make sequencing safe already exist.

**The runner is a resumable step machine, not a script.** `chain step` advances maximally, then returns one of:

- `{"status":"still-running", …}` → re-invoke (dispatches outstanding; identical to `await --all`'s rhythm),
- `{"status":"halt","halt":{"kind":…}}` → an orchestrator judgment turn is required,
- `{"status":"segment-complete"| "run-complete"}`.

Every invocation re-derives state from `chain.json` + the dispatch records + the filesystem. That is ADR-003's "a wake is never itself evidence" generalized one level up, and it is simultaneously sssf's `session.ensure(cfg, adw_id)` segment join (invariant 11) — **the same mechanism satisfies both**.

**Coexistence with `team-build.workflow.mjs`:** none required — the chain never touches it, never mentions it, and the guard at `test/cmux-contract.test.mjs:622` keeps passing untouched. **No ADR-007 deviation is needed.** Convergence is deferred with a named trigger: *when and only when the chain grows an Agent-tool backend, `team-build.workflow.mjs` becomes a thin caller and can be retired.* Until then two engines exist because they serve two `execution_mode` values, which is a reason, not an accident.

**Interaction with `dispatch.mjs`: spawn, never import**, behind a `DISPATCH_BIN` env seam.
*Why spawn:* `dispatch.mjs`'s header contract — "the ONLY file in the repo that spawns processes, touches git, or measures wall-clock time" (`dispatch.mjs:3-5`) — is a strong invariant; importing its command functions puts git and `spawnSync` inside the chain process and voids it. Its interface is already machine-shaped: one JSON object on stdout, humans on stderr, exit 0/1/2 (`dispatch.mjs:19-21`). And spawning yields the fake-binary test seam the repo already standardized on (`conventions.md:27`).
*Cost:* ~50ms per call, and the `invokedDirectly` realpath trap (§2.15) must be fixed before any fixture invokes a copied/symlinked `dispatch.mjs`.

**Interaction with `ladder.mjs`: consume, never re-implement.** The chain never decides completion; it reads `dispatch.mjs`'s JSON (which is `ladder.classify`/`reconcile` output) and treats `completed`/`outcome` as given.

**Await-lock discipline:** the chain is the *only* await caller while a chain is active. `chain step` acquires the chain lock first, then shells `await --all`. If `await.lock` is already held by an orchestrator loop, `chain step` refuses exit 2 with a named constant naming the holder PID — never waits, never forces.

---

## 4. Retry ownership (Q2)

### 4.1 The three existing bounds — unchanged, all three

| Loop | Owner | Bound | Where |
|---|---|---|---|
| amend → rebuild on `insufficient` | orchestrator (brain) | ≤2 then escalate | `orchestration.md:53` |
| Stop-hook block | `return-gate.sh` (worker) | ≤2, hard ceiling 3, then writes the blocked return itself | shipped #4 |
| re-dispatch on timeout/attention | orchestrator via triage | new `dispatch_id` each time, `attempt` ≤99 | `references/cmux-dispatch.md:31-35` |

### 4.2 Answer

**The chain owns zero retry counters. It may *count* an existing bound; it may never *choose* the bound, *resolve* the retry, or *author* the escalation.** That is the composable line, and it is stated as a proposed convention because it is the boundary a future implementer will be tempted to cross.

Concretely: on a coder's `insufficient`, the chain increments `counters.amend_cycles[slice_id]` in `chain.json`, and halts with `kind: "amend"`. The orchestrator authors the amendment (judgment: *what* was missing) and calls `chain resolve`. At cycle 3 the chain halts with `kind: "escalation"` instead and refuses to dispatch — the bound is the brain's 2, mechanically enforced rather than mentally tracked. The escalation *text* (spec + both returns + a concrete question) remains the orchestrator's.

### 4.3 Is correction-not-respawn a brain change?

Split three ways:

- **Shape correction — already shipped, adopt verbatim.** `return-gate.sh` blocking the Stop and re-prompting in-session, ≤2, then writing a `blocked` envelope, **is** sssf invariant 4 for malformed output. Nothing to build.
- **Content-gate correction — an implementation of the existing loop, not a new one.** A parent-side gate refutation routes into the *existing* amend/re-dispatch loops with the gate report supplied as evidence. No fourth counter.
- **In-session correction via `cmux send` — rejected for now, with a named cost.** `gate-mode.sh:47-51` makes the second `UserPromptSubmit` flip the return gate to `observe` permanently. A code-driven correction therefore *disables the shape gate to fix a content problem* — trading a strong guarantee for a token saving. And `claude -p --resume` is unavailable (§2.11). **Decision: content-gate failure produces a new attempt (`attempt+1`, worktree reused) carrying the GateReport in the kickoff, not an in-session nudge.** Revisit trigger: a measured comparison showing respawn cost materially exceeds correction cost (an S15b-style measurement), plus a mechanism that preserves gate enforcement across an interjection.

---

## 5. Envelope & gate strategy (Q3)

### 5.1 Single authority — adopted as-is

`return-envelope.schema.json` + `ladder.validateReturn` (`ladder.mjs:134-162`) remain **the** validator over `returns/`. The chain writes no envelope, defines no second envelope type, and never validates a return itself. Two validators over the same tree would break the single-authority property (collision §4.4) — this design has exactly one.

### 5.2 Where the new gates live: a *separate post-completion layer*, not a step-2 extension

**Not step 2.** Widening step-2 body validation would change what `completed` means, and `completed ⟺ isFresh ∧ validateReturn().ok` is ADR-003's load-bearing invariant. It would also force gate outcomes into the frozen 8-value `OUTCOMES` enum (`dispatch.mjs:102-114`), a schema-version event for a parent-internal concern.

**A dispatch that produces a schema-valid return *completed*. Whether the work is *acceptable* is a different question.** That is sssf invariant 2 (phase status ≠ run acceptance) and it maps onto our existing split perfectly:

```
ladder.mjs              → completed / outcome     (phase status; frozen; unchanged)
scripts/chain/gates.mjs → GateReport              (acceptance input; new; parent-side)
chain.json              → accepted / accept_reason (run acceptance; orchestrator-decided)
```

**`GateReport` shape** (sssf invariant 5, adopted verbatim):

```json
{ "checks": [ { "item": "diff_matches_claims", "ok": true,
                "note": "3/3 claimed paths present in git diff --name-only (be-01 worktree, base 4f2a1c9)" } ],
  "hard_fail": false, "violations": [] }
```

`note` carries **evidence on pass**, not just a reason on fail. This is the highest-value single port in the whole package: it converts "the gate ran" into "here is what the gate saw", which is exactly what makes a later review of a chain run auditable.

**Check library (Phase B):** `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`, `verdict_consistent`, `spec_lint`, `scope_compliance`, `green_suite_fresh`, `tests_pass(cmd)` factory.

### 5.3 `verdict_consistent` vs D17 §R

D17 §R says verdict validation is "presence/parseability/enum only, never quality." That rule governs **the lint's treatment of the verdict block** — and it stays exactly as shipped (`return-lint.mjs:214-257`).

`verdict_consistent` is a **different class**: *consistency refutation*. It never reads the diff, never re-judges a severity, never overrides a verdict. It asks only whether the envelope contradicts itself:

- `verdict: "pass"` while `findings[]` contains `severity: "critical"`,
- `verdict: "changes-needed"` with an empty `findings[]` (a rejection that names no problem).

**And it needs no new branch:** a refuted verdict is mapped onto `inconclusive`, which D17 already defines as "re-run scoped to diff, never assume pass." Zero brain change, zero new enum value, zero new branch in `qa-gate.md`. This is the cleanest available framing and I recommend it strongly over any attempt to widen D17.

**Panel majority and enum branching stay where they are** — already mechanical, already owned by the existing ladder. The chain *reads* the aggregate, it does not re-decide it.

### 5.4 Deferred: worker-side content gates

Landing the content gates inside `return-lint.mjs` would give in-session correction with the existing ≤2 bound and no new counter — attractive on paper. **Rejected for Phase A/B** because it costs four contract-freeze events: widening the per-dispatch snapshot's closed inventory (PRE-1C-VERIFY), a `return-contract.markdown.md` prompt-byte edit that invalidates every judgment role's cached prefix (`backend-notes.md:24`), a second copy of gate logic inside the **worker-writable tree** (the exact shape of the trust-M1 finding at `architecture-notes.md:27`), and an adversarial-panel review round. Parent-side-only buys 90% of the value at 10% of the risk. Deferred with the revisit trigger in §4.3.

---

## 6. Write-boundary enforcement (Q4)

### 6.1 Verdict: **complementary**, and it closes a live gap

The three existing layers each see something different:

| Layer | Sees | Blind to |
|---|---|---|
| profile grants (ADR-012 primary) | writes outside the grant | anything inside the grant |
| postcondition `clean`/`changes_expected` | a dirty *primary* checkout | everything inside the worktree |
| scope compliance vs `files_in_scope` (`qa-gate.md:13`) | out-of-scope edits | nothing mechanical enforces it — it is an orchestrator Bash step, post-hoc, no protected-path notion |

**The live gap (§2.17):** a coder's worktree is a worktree of this repo, so `.claude/dev-team/memory/**` is inside its `Edit(//worktree/**)` grant, and `changes_expected` does not refuse it. The memory single-writer invariant — a *brain* invariant — has no mechanical backstop. sssf's real incident (a builder running `git checkout adws/` and discarding the quality check that was about to judge it — sssf-mechanisms §6) is the same class.

### 6.2 Design: enforce-after-the-fact, **refuse and report, no auto-rollback**

- **Baseline:** captured once per slice at the first dispatch (`git rev-parse HEAD` + `git status --porcelain -z` fingerprint + untracked list) into `chain.json.baseline`, with a recorded `reason` (sssf invariant 12). One baseline covers all attempts — matching sssf's "one baseline covers all retries" and our attempt-reused worktrees.
- **Enforce:** compare change *sets*. **A reversion is a modification** — appeared / vanished / changed all count. This is the half a naive `git diff --name-only` check misses and the half that caught sssf's real incident.
- **Two severities:**
  - *Scope violation* (touched a file inside the worktree but outside `files_in_scope`) → `hard_fail: false`, routes to the existing `changes-needed` bounce per `qa-gate.md:13`. Correctable by re-prompting.
  - *Protected-path breach* → `hard_fail: true`, halt `kind:"escalation"`, chain refuses to advance. **Not correctable by re-prompting** (sssf: "breach ≠ gate violation"). Protected set: `.claude/dev-team/memory/**`, `scripts/chain/**`, `scripts/cmux/**`, `hooks/**`, `.claude/dev-team/config.md` — "an agent must not edit the thing that judges it."
- **No auto-rollback.** `conventions.md:23` permits automatic destructive recovery only on a proven agent-created worktree — which ours *is* (`worktrees.json`, `created_by_dispatcher`), so rollback is *permissible*. It is nonetheless rejected because it destroys the evidence the amend loop needs and because one false positive in a set-difference computation costs the user work. Deferred, gated on a demonstrated incident.
- **Glob semantics** ported verbatim from sssf: `*` stops at `/`, `**` crosses, trailing `/` = prefix. Whitelist, not blacklist (`conventions.md:26`).
- **Reuses D16/ADR-011's noise globs at the *read* points only** — never in the scope check itself. "A scope check that hides files is a scope check that lies" (#9). This is why Phase B depends on #9.

**Not a Phase-A seam and not Agent-tool-only** — it is a parent-side chain gate, substrate-independent by construction.

---

## 7. Chain state (Q5)

### 7.1 Decision: `<STATE_DIR>/chain.json` + `<STATE_DIR>/chain.jsonl`

`STATE_DIR = ~/.dev-team/state/<repo-slug>/<task-slug>/` — parent-side, **never `--add-dir`'d**.

**Why not TASK_DIR:** Rider C's disclosure argument generalizes exactly. Chain state names every sibling slice, the whole phase plan, every judgment recorded so far, and every gate report. Under `--add-dir` reads never prompt, so a worker would read the entire task shape. Dispatch records moved out of TASK_DIR for precisely this reason (`architecture-notes.md:10,25`).

**Why not `task.json`:** it does not exist in code — `taskPaths` (`resolve.mjs:90-112`) has no such entry; the name appears only in the design record. Creating it now would introduce a *second* task-level state file for no gain.

**Why not `status.json`:** `statusCmd` overwrites it wholesale on every call (`dispatch.mjs:1364-1365`). It is a derived, disposable projection; storing durable state there would break the one property that makes it safe.

### 7.2 `chain.json` (governed by a new `chain-state.schema.json`, flat, in-BUDGET)

```json
{ "schema_version": 1, "task_slug": "…", "repo_slug": "…", "tier": 3,
  "created_at": "…", "segment_table": "tier3.v1",
  "baseline": { "sha": "…", "reason": "branch point of dt/<task>/<slice> at first dispatch", "captured_at": "…" },
  "head": { "pid": 41221, "started_at": "…", "phase_seq": 7 },
  "phases": [ { "seq": 1, "segment": "plan", "name": "…", "description": "…",
                "status": "fail", "started_at": "…", "ended_at": null,
                "dispatch_ids": ["…"], "gate_report": {}, "halt": {}, "decision": {} } ],
  "counters": { "amend_cycles": { "be-01": 1 }, "package_rounds": 1 },
  "accepted": null, "accept_reason": null }
```

- `phases[].status` **defaults to `"fail"`** and is flipped only by a clean phase exit (sssf invariant 1). A killed step therefore leaves an honest trace with no special handling.
- `accepted` is `type: ["boolean","null"]` — the type-array form is already in use (`return-envelope.schema.json`'s `body`), so it is inside BUDGET.
- Writes: RMW under a `'wx'` lock file `{pid, started_at}` verified-before-unlink, corrupt lock treated as stale, stale threshold `2 ×` the step's max-block (`conventions.md:28`; mirrors `await.lock`). Persist via `writeFileSync(tmp)` + `rename` in the destination dir.
- New schema **must** be added to `test/schema.test.mjs`'s hardcoded list (`conventions.md:24`) — it is a list, not a glob.

### 7.3 Ledger: `chain.jsonl`, not `node:sqlite`

`node:sqlite` requires Node 22.5+; the floor is 20 (§2). JSONL is also the shipped precedent (`signal-record.schema.json`). sssf's WAL SQLite is explicitly observability-only, and the visualizer is skipped — so nothing is lost.

`{ts, seq, segment, event, detail}` with a frozen `event` enum, appended by a single writer holding the chain lock. **Hard rule: a ledger line is refused above 4096 bytes** (the POSIX `PIPE_BUF` atomicity bound on macOS/Linux) — `detail` is truncated with an explicit `"truncated": true` marker rather than silently splitting an append into a torn write.

---

## 8. Tier mapping and segment definitions (Q6)

### 8.1 Two hard boundaries the segment table must respect

1. **The chain cannot invoke the Agent tool.** `Explore` is a permanent carve-out (`references/cmux-dispatch.md:53`). Any segment containing an Agent-tool step must be *split at that boundary* — the orchestrator owns those steps entirely.
2. **The chain never fires `phase --set gate`** (`references/cmux-dispatch.md:43`). It halts; the orchestrator fires it. This is deliberate: the gate pill is the human-visible signal that judgment is happening.

### 8.2 Tier 1 — **no chain**

Direct handling; no workspace (D5). A delegated Tier-1 coder is a single dispatch, and one-dispatch chains cost more than they save. Explicitly out of scope.

### 8.3 Tier 2 — four segments

| Seq | Segment | Chain does | Halts with | Orchestrator supplies |
|---|---|---|---|---|
| 1 | `plan` | dispatch domain lead (pane) → await → ladder-completed → `required_sections` already checked by ladder | `spec_approval` | the semantic eyeball (`orchestration.md:52` layer 2) + the transcribed `spec/<slice>.json` |
| 2 | `spec_gate` | run `spec_lint` on `spec/<slice>.json`; on FAIL → halt `amend` with the FAIL lines verbatim | (none if PASS) | — |
| 3 | `build` | dispatch coder(s) (parallel, existing 4–6 cap) → await → gates: `artifacts_exist`, `files_non_empty`, `diff_matches_claims`, `scope_compliance`, `tests_pass(validation_commands)` | `gate_route` (pass) / `amend` (insufficient) / `escalation` (hard fail or bound exhausted) | amendment content; review-bundle choice |
| 4 | `review` | dispatch the orchestrator-chosen bundle → await → aggregate D17 enums + panel majority → `verdict_consistent` → re-run `tests_pass` if `revised` since last green | `acceptance` | accept / bounce, and the wording |

### 8.4 Tier 3 — discovery stays out; the chain enters at the package

| Seq | Segment | Notes |
|---|---|---|
| — | `discover` | **Orchestrator-only.** `Explore` is Agent-tool; the chain cannot dispatch it. The chain's contribution is nil. Honest limit, stated up front. |
| 1 | `package` | dispatch `architecture-lead` (pane, `timeout_s: 3600`) → ladder checks the three required sections → halt `package_approval` route |
| 2 | `package_review` | dispatch `plan-reviewer` → ladder checks `Must Fix`/`Should Fix`. **The chain cannot branch here** — D17 deliberately leaves plan-reviewer's verdict as prose to feed human approval. Chain increments `counters.package_rounds` and **reports** the count; it does not bound it (a new bound would be a brain change). Halt `package_approval`. |
| 3…n | `phase_execute` | one Tier-2-shaped sub-chain per approved phase, joined by task id + `phase_seq` |
| n+1 | `ship` | Phase B scope: `teardown` + `validate.full` + the `revised`/stale-green re-check. **Memory writes and the git/PR sequence stay orchestrator-owned** (sole writer; `commands/ship.md:16-22` is high-consequence and low-frequency). |

### 8.5 What the orchestrator receives between segments

**Envelope summaries and paths, never transcripts, never full bodies.** This is D4's "the orchestrator branches on enums, never prose" applied one level up:

```json
{ "status": "halt", "task": "…", "phase_seq": 3, "segment": "build",
  "halt": { "kind": "gate_route", "id": "h-7",
            "question": "review bundle for be-01 (14 files, 380 LOC, deep triggers: none)",
            "options": ["standard", "deep", "adversarial"] },
  "dispatches": [ { "dispatch_id": "…", "slice_id": "be-01", "role": "coder",
                    "outcome": "ok", "body_status": "done",
                    "render_path": "~/.dev-team/tasks/…/returns/be-01.1.md" } ],
  "gate_report": { "checks": [ ], "hard_fail": false } }
```

The `render_path` is already the doc tab (D7/ADR-004) — the human reads the pane, the orchestrator reads the enum, and neither pays for the other.

### 8.6 Frozen halt kinds (exactly seven)

`spec_approval` · `amend` · `gate_route` · `acceptance` · `package_approval` · `escalation` · `blocked`.

Frozen as an exported constant with a drift guard. **Cap the enum**: halt-kind proliferation is the failure mode that turns the orchestrator into a badly-designed RPC endpoint with worse ergonomics than the prose it replaced. The four D11 notify moments (tier confirm, plan approval, insufficiency escalation, gate verdict) map onto `package_approval`, `escalation`, `acceptance` — the mapping is a design check, not a coincidence.

### 8.7 `chain resolve` — mechanical refutation, never resolution

The judgment-ingress verb, and the concrete realization of the mission's "judgment envelopes may be mechanically gated but never resolved by code":

```
node scripts/chain/chain.mjs resolve --task <slug> --halt <id> --decision <decision.json> [--override "<reason>"]
```

`resolve` validates the decision against a frozen decision schema and **refuses** (exit 2, named constant) when the decision contradicts its own evidence — e.g. `{"decision":"accept"}` while `gate_report.hard_fail === true`, or `{"decision":"approve"}` for a `spec_approval` halt whose `spec_lint` check is `ok:false`. The orchestrator then either fixes the underlying problem or passes `--override "<reason>"`, which is **recorded in the ledger** and surfaced in the final report. The chain never fabricates a decision, never infers one from a gate, and never proceeds past a halt without one.

---

## 9. Module map, seams and test strategy

### 9.1 Modules — five, each with a `test/<name>.test.mjs` (epic constraint 4)

```
scripts/chain/
  chain.mjs        CLI + the step machine.  Verbs: plan · step · resolve · status · abort.
                   One JSON object to stdout, humans to stderr, exit 0/1/2 (dispatch.mjs's
                   convention, deliberately identical). CLI-as-library: exports pure
                   functions + an invokedDirectly guard that realpathSyncs BOTH sides.
  segments.mjs     FROZEN segment tables (tier2.v1, tier3.v1) as DATA + validateSegmentTable().
                   Also HALT_KINDS + the halt/decision schemas' constants.
  chain-state.mjs  chain.json lifecycle (read / openPhase / settlePhase / finish),
                   the chain lock, chain.jsonl append. Atomic writes only.
  gates.mjs        the check library; every check -> {item, ok, note}; GateReport aggregation;
                   hard_fail classification. Pure: takes evidence, returns a report.
  evidence.mjs     the ONE impure module: baseline capture, change-set diff, and the
                   known-commands runner (argv array never a shell string, timeout -> 124,
                   missing binary -> 127, collect ALL failures, 4000-char tail into
                   paths.logsDir which already exists at resolve.mjs:104).
```

Conventions carried: long load-bearing header block per module stating the contract *and why*; no semicolons, 2-space, single quotes, `node:`-prefixed imports; named exported constants for every refusal message with a source-text drift guard; zero dependencies.

**`gates.mjs` is imported only by the parent, from the plugin root** — never from a per-dispatch snapshot. This is the trust-M1 rule (`architecture-notes.md:27`): completion- and acceptance-decision inputs are read only from the parent's own code tree.

### 9.2 Seams

| Seam | Mechanism | Precedent |
|---|---|---|
| `dispatch.mjs` | spawn behind `DISPATCH_BIN`; `test/fixtures/fake-dispatch.mjs` logs one JSON line per invocation to `$FAKE_DISPATCH_LOG`, persists topology in `$FAKE_DISPATCH_STATE`, varies **only by env switches** | `conventions.md:27` (fake-cmux) |
| `spec-lint.mjs` | imported as a library after slice A1 (currently impossible — §2.9) | new |
| validation commands | `evidence.mjs` argv-array exec, never a shell string | sssf inv 7 + `CMD_RE` precedent |
| clock | injected `now` parameter into every pure function | `ladder.reconcile({…, now})` |

**The fake's answers to "what does `dispatch.mjs` actually print" are frozen live captures**, checked in beside the fixture — not a copy of the chain's own expectations. This is the single most important test rule in this package: `qa-notes.md:16` records 559 green tests containing a 100%-reproducible first-live-run failure caused by a fake mirroring the implementation's assumption.

### 9.3 Test strategy

- **Positives asserted first**, always (`qa-notes.md:9`). A chain that refuses everything passes a negatives-only suite.
- **`canAdvance` is conjunctive** (`gates pass ∧ no halt pending ∧ all dispatches resolved ∧ no lock contention`) — therefore `qa-notes.md:11` applies in full: one negative per term with the others held true, plus an **independence sweep** against a hand-written oracle sharing no code with the implementation, plus the two degenerates named in a comment block (permissive: `canAdvance ⟺ dispatches.length === 0`; reject-everything).
- **Mutation tests for the load-bearing prohibitions**, since "the chain never resolves a judgment" is vacuous unless proven by mutation (`conventions.md:32`): inject a decision-fabricating mutation into `resolve` and assert the suite fails; remove the `hard_fail` guard and assert the suite fails.
- **Real-FS collector seam test** for `chain.json`/ledger with `utimesSync` (`qa-notes.md:13`).
- **CLI tests**: `node --check` parse test first, then `spawnSync(process.execPath, …)` over an `mkdtemp` fixture.
- **Cross-file constant agreement by source-text extraction, never import** (`backend-notes.md:12`).
- **Budget:** ≤10s added wall-clock; **zero** cmux, claude, model, network or GUI. Suite is already ~771 tests / ~60s (`qa-notes.md:21`) — chain tests must not spawn process topologies the way the dispatch tests do.
- **Review route:** any slice touching `scripts/cmux/*.mjs` routes to the **3-reviewer adversarial panel**, not merely deep review, with `test-engineer` first and alone on the frozen tree (`qa-notes.md:17`). New-file-only chain slices route deep.

---

## 10. The 14 sssf invariants — verbatim / adapt / reject (Q8)

| # | Invariant | Verdict | Rationale / mapping |
|---|---|---|---|
| 1 | Success must be earned (records default `fail`) | **VERBATIM** | Already the repo's grain (`shouldArchive` fail-closed, omission-is-denial). `phases[].status` defaults `"fail"`; only a clean phase exit flips it. Makes a killed step honest for free. |
| 2 | Phase status ≠ run acceptance; one call settles status + banner + exit code | **VERBATIM, load-bearing** | Maps onto `completed` (ladder, frozen) vs `accepted` (chain). This is what keeps the frozen `OUTCOMES` enum from having to grow. `chain finish(accepted, reason)` settles `chain.json` + stdout JSON + exit code atomically. |
| 3 | Typed envelopes at every boundary; deterministic results adapted into the same envelope shape | **ADAPT** | Envelope = `return-envelope.schema.json`, single authority. **Reject the "code writes an envelope" half**: a synthetic envelope would have to forge `dispatch_id`/`attempt`/`role`, and identity agreement is the frozen four-tuple check (`ladder.checkIdentity`). Adopt the *intent* — one uniform report shape for code output — as `GateReport`. **Convention: deterministic results never wear an agent's envelope.** |
| 4 | Correction-not-respawn (≤2 corrections into the same session; model drift invalidates resume) | **ADAPT** | Shape correction already shipped (`return-gate.sh`). Content-gate correction = a new attempt carrying the GateReport, not an in-session nudge (§4.3: `gate-mode.sh:47-51` + no session ids). **No fourth counter.** |
| 5 | Gates verify claims and return evidence (`{item, ok, note}`; note = evidence on pass) | **VERBATIM** | The highest-value port. `gates.mjs` GateReport. |
| 6 | Write boundaries enforced after the fact; a reversion is a modification; breach ≠ gate violation; `protected_files` | **ADAPT** | Adopt snapshot/enforce/change-set semantics + protected paths + breach-is-not-correctable. **Reject auto-rollback** for now (`conventions.md:23` reasoning + evidence preservation). §6. |
| 7 | Known commands are code (argv list, `operator_env`, 124/127, collect-all, log to file + 4000-char tail, a failing block does not fail the phase) | **VERBATIM in substance** | argv-array-never-shell is already a repo rule (`buildArgv`, `CMD_RE`, `sendLine` refuses rather than escapes). `operator_env`'s PATH-stripping has no venv analog here, but the *bug class* does — see unknown U4. "A failing block does not fail the phase" is exactly invariant 2 restated for validation. |
| 8 | Audit-before-execute (rendered prompts saved before the agent runs; envelopes persisted per attempt incl. invalid ones with raw tail) | **VERBATIM, mostly already present** | `record.kickoff` + the static role-prompt file + `role_prompt_sha256` already satisfy it per dispatch. Extend one level up: the chain writes the phase record **before** dispatching. |
| 9 | Killability + honest traces (pid registered before any phase opens; signals converted so a killed run finalizes its trace) | **ADAPT** | Node cannot dispatch handlers while blocked in a sync call (`backend-notes.md:18`) — so do not rely on handlers. Instead: `head.{pid, started_at}` written before phase 1, `status` defaults `fail` (inv 1), and the next `step` reclaims a stale head exactly as `await.lock` does. A `SIGKILL` needs no special path. |
| 10 | Construction-time metadata lint (descriptions may not be empty or restate the name) | **VERBATIM, as a test** | The segment table is repo-authored data, so a `node --test` assertion is the right enforcement (no pydantic, no runtime validator). Cheap; "the description is the only intent the trace shows." |
| 11 | Segment join (`ensure(cfg, id)`; phase seq continues; agent sessions resume) | **ADAPT — this is the core** | Join key = `(repo_slug, task_slug)`; `phase_seq` monotone; every `step` re-derives from disk. **Reject the warm-session-resume half** (no session ids; §2.11). Warm context is carried instead by `context.md` (D18, written once, referenced by absolute path) and by the pane staying alive for judgment roles. |
| 12 | Pinned-baseline diff capture with a recorded `reason` | **VERBATIM** | `chain.json.baseline = {sha, reason, captured_at}`; per-slice, captured at first dispatch, covering all attempts (matches worktree attempt-reuse). |
| 13 | Per-phase commits in the author's words; a revision after the last green suite makes the green light stale | **SPLIT: reject the commits, adopt the staleness rule** | Per-phase commits fight the house style (one PR per issue; the fixed `feat:`→`chore:`→`chore:` sequence; version bump per commit — `conventions.md:11`). **But the staleness half is a real, currently-unguarded correctness gap**: nothing today stops an approval that follows a fix made after the last green run. Adopt as the `green_suite_fresh` gate + a `revised` flag, enforced mechanically — no doc change needed. |
| 14 | Fail-fast config validation before anything spawns | **VERBATIM** | Partly present (preflight, roster load, `readTaskRoster`). Extend: `chain plan` validates the entire segment table — every role resolves in the roster, every gate name resolves in the check library, every referenced path exists — before opening phase 1. Cheap, high value, catches a mis-typed segment table at authoring time. |

**Also noted:** everything sssf "deliberately lacks" (parallel fan-out, a task source, task-scoped worktrees, an escalation ladder, cross-run memory) we already have. We import invariants, not gaps.

---

## 11. ADRs (continuing the epic's numbering; last committed = ADR-013, `architecture-notes.md:18`)

> All six are **proposed** — they become ratified only on user approval, in the epic's own §13 style.

**ADR-014 — The phase-chain runner is a resumable step machine above the await loop; a third substrate, not a replacement.**
*Decision:* `scripts/chain/chain.mjs` owns cross-phase sequencing joined by task id. It advances maximally per invocation and returns one JSON object; the orchestrator loops on it with the same rhythm it uses for `await --all`. It drives `dispatch.mjs` by **spawn** behind a `DISPATCH_BIN` seam, consumes `ladder.mjs` output, and **never touches `team-build.workflow.mjs`** — no ADR-007 deviation. It cannot invoke the Agent tool, so `Explore` segments stay orchestrator-owned.
*Rationale:* D4's ratified foreground-chunked rule forbids a long-blocking segment; resumability also *is* sssf's segment join, so one mechanism serves both. Spawn preserves `dispatch.mjs`'s "only file that spawns/git/wall-clock" contract and yields the repo's standard fake-binary test seam.
*Consequences:* three substrates coexist; convergence deferred with the named trigger "when the chain gains an Agent-tool backend." Drift risk between `chain/segments.mjs` and `orchestration.md` is accepted and mitigated by a single sentence of precedence (§13).

**ADR-015 — The chain owns zero retry counters.**
*Decision:* it may *count* an existing bound and refuse to advance past it; it may never choose a bound, resolve a retry, or author an escalation. Correction-not-respawn for output *shape* is the already-shipped `return-gate.sh` loop. Content-gate failure produces a new attempt carrying the GateReport, never an in-session nudge.
*Rationale:* runner-owned counters were flagged HIGH collision; `gate-mode.sh:47-51` makes a code-driven nudge disable the shape gate permanently; no session id exists for `--resume`.

**ADR-016 — Envelope validation stays single-authority; content gates are a separate post-completion layer.**
*Decision:* `return-envelope.schema.json` + `ladder.validateReturn` remain the only validator over `returns/`. `gates.mjs` runs *after* the ladder reports `completed` and produces a `GateReport`, never an envelope and never an `OUTCOMES` value. `verdict_consistent` is a consistency-refutation class distinct from D17 §R's shape validation, and a refuted verdict maps onto D17's existing `inconclusive` branch.
*Rationale:* two validators over `returns/` breaks single authority; widening step 2 would redefine `completed` (ADR-003) and force the frozen outcome enum to grow.

**ADR-017 — Chain state lives parent-side at `<STATE_DIR>/chain.json`, with a JSONL ledger.**
*Decision:* `chain.json` (schema'd, flat, in-BUDGET, atomic RMW under a `'wx'` lock) + append-only `chain.jsonl` (single writer, lines refused above 4096 bytes). **Not** `node:sqlite` (Node 20 floor), **not** TASK_DIR (Rider C disclosure), **not** `status.json` (overwritten wholesale), **not** a new `task.json` (does not exist).

**ADR-018 — Phase status is not run acceptance.**
*Decision:* `completed`/`outcome` (ladder-derived, frozen) answers "did the dispatch finish"; `GateReport` answers "is the work sound"; `accepted` (orchestrator-decided, chain-recorded) answers "does this run pass." A red test suite is a *successful* validation phase and an *unaccepted* run. One `finish(accepted, reason)` settles state, stdout and exit code together.
*Rationale:* keeps the frozen outcome enum stable and prevents the sssf bug their own docstring records (three disagreeing notions of success).

**ADR-019 — Write boundaries are enforced after the fact, refuse-and-report, with a protected-path class.**
*Decision:* pinned baseline + change-set comparison (a reversion is a modification); scope violations bounce through the existing `changes-needed` path; protected-path breaches (`memory/**`, `scripts/chain/**`, `scripts/cmux/**`, `hooks/**`, `config.md`) hard-fail and escalate, uncorrectable by re-prompting. **No auto-rollback**; deferred, gated on a demonstrated incident.
*Rationale:* closes the live gap that a coder's worktree contains `.claude/dev-team/memory/**` inside its own grant, with no mechanical check on the single-writer invariant.

---

## 12. Execution plan

**Format follows the epic's house style: bolded opening dependency line · Files · Scope · Design · Tests · Acceptance with negatives.** Every issue restates in full the invariants it must not violate, each with its why; every "never X" carries an em-dashed consequence clause. Standing acceptance line on all slices: *`node --test` green with no cmux, no claude, no model, no network, no GUI.* Every commit bumps `.claude-plugin/plugin.json` and ends `; bump 0.1.NN`.

### Phase A — inside epic #15 (invariant-compatible, useful standalone)

Phase A is deliberately **two slices**. Several candidates named in the brief turned out to be already shipped or better placed in Phase B; that triage is in §12.3.

---

**A1 — `spec-lint` becomes a library with machine-readable output and correct path parsing**

> **Depends on: nothing. Parallel with #7 / #8 / #9 — touches no cmux surface. Commit: `feat: spec-lint — schema-driven fields, --json output, CLI-as-library, path-regex fixes; bump 0.1.NN`. Review lane: deep (contract-adjacent: it becomes the mechanical half of the lead→coder contract).**

**Files**
- `scripts/spec-lint.mjs` (modified) — export `lintSpec(spec, root) -> {failures[], warnings[], ok}`; `main(argv)`; `invokedDirectly` guard that `realpathSync`es **both** sides; `--json` flag emitting one JSON object.
- `test/spec-lint.test.mjs` (modified) — library-mode tests + a symlink-invocation regression test.

**Scope**
1. Move module-level side effects (`:202-212`) into `main(argv)`; move `failures`/`warnings` (`:33-34`) into `lintSpec`'s closure so two calls in one process cannot cross-contaminate.
2. Replace the duplicated `REQUIRED_FIELDS` literal (`:18-21`) with `required` read from `handover-spec.schema.json` — the first time that schema becomes machine-load-bearing.
3. Fix the two false-positive classes (`backend-notes.md:17,22`): hyphenated absolute path components; double-extension filenames (`x.test.mjs`, `y.schema.json`); and the `path:line)` form.
4. Downgrade the "file doesn't exist yet" hard-FAIL in `discovery_context` (`:147-152`) to a WARN when the parent directory exists — matching the existing `files_in_scope` treatment.
5. Add `--json`: `{ok, failures:[{check, detail}], warnings:[…]}` — the shape `gates.mjs` will consume.

**Design** — the `invokedDirectly` guard must `realpathSync` both sides or it silently no-ops under a symlinked path component (macOS `TMPDIR` is `/var → /private/var`) — a plain unit run cannot see it, so the regression test must *invoke through a symlink* (`backend-notes.md:21`).

**Tests** · library call returns zero failures on the golden spec (positive first) · exactly-one-failure `deepEqual` per single-mutation negative · hyphenated-absolute-path spec passes (currently FAILs) · `test/foo.test.mjs` in `files_in_scope` passes (currently FAILs) · `x.schema.json` cited in `discovery_context` passes · a truly-missing path still FAILs (the fix must not become permissive) · `--json` output shape · exit codes 0/1/2 preserved · symlink invocation runs `main` (revert-to-literal-compare must fail this test) · a drift guard asserting `REQUIRED_FIELDS` is *not* re-typed as a literal anywhere in the file.

**Acceptance** · Two calls to `lintSpec` in one process produce independent results — **negative: a mutation restoring module-scope arrays fails the suite.** · The permissive degenerate (`lintSpec` returning `ok:true` always) fails at least three named tests. · Every previously-documented false positive has a passing test and every real failure still fails.

---

**A2 — `dispatch.mjs` refuses a coder dispatch whose `--spec` fails spec-lint**

> **Depends on: A1. Sequential after A1; parallel-safe with #8 / #9; light conflict with #7 (both edit `dispatch.mjs`) — land after #7 or coordinate. Commit: `feat: dispatch — refuse an executor dispatch on a spec-lint FAIL; realpath the invokedDirectly guard; bump 0.1.NN`. Review lane: adversarial 3-panel (`qa-notes.md:17` — `scripts/cmux/*.mjs` is contract-freeze-set).**

**Files** · `scripts/cmux/dispatch.mjs` (modified) — spec-lint gate in `dispatchCmd` + `realpathSync` in the `invokedDirectly` guard (`:1546`) · `test/cmux-dispatch.test.mjs` (modified).

**Scope** — before spawning an `executor`-profile role, `dispatchCmd` calls `lintSpec` on the resolved `--spec` path. FAIL ⇒ refuse, exit 1, one JSON object `{error:'spec_lint_failed', failures:[…]}`, the FAIL lines printed verbatim to stderr. Refusal message is a **named exported constant** with a source-text drift guard. Judgment/validator profiles are unaffected (they take no Handover Spec).

**Design (invariants restated)**
- **Spec ingress is unchanged by this slice** — `orchestration.md:52`'s two layers stay exactly as written; this makes layer 1 structurally unskippable instead of instruction-dependent. **A mechanical check that can be skipped is a check that will be skipped — this is why it moves to the substrate.**
- **Never widen the refusal to judgment roles** — leads receive no spec, so a spec-lint gate there would refuse every lead dispatch and hard-stop planning.
- **Never fall back to dispatching anyway on a lint crash** — an exception in the linter is an operational failure (exit 1), never a silent pass; a gate that fails open is not a gate.
- `realpathSync` on both sides of the `invokedDirectly` guard, or a fixture-copied `dispatch.mjs` silently no-ops and every chain test passes vacuously.

**Tests** · positive: a valid spec dispatches, exactly one `fake-cmux` invocation logged, argv asserted · negative: a FAIL spec produces **zero** cmux invocations and exit 1 (assert the empty invocation log *and* the positive above it) · refusal message asserted against the exported constant + drift guard · a judgment-role dispatch with no `--spec` still succeeds · symlink-invocation regression.

**Acceptance** · No path exists from a FAILing spec to a spawned executor pane. · The refusal names every FAIL line — **negative: a mutation emitting a generic message fails the suite.** · Removing the `realpathSync` change fails the symlink test.

### Phase B — new epic: "deterministic backbone"

> **Gating:** Phase B **does not wait for all of #15.** It waits for **#7** (ship teardown — the `ship` segment calls it), **#8** (D17 on — the chain's only mechanical verdict branch), and **#9** (noise globs — `diff_matches_claims` must not fight lockfiles, and the scope check must stay unfiltered). **#10 / #11 / #12 / #13 / #14 are not blockers.** Recommend filing Phase B as its own epic with a `Referenced by:` line to #15.

| Slice | Title | Depends on | Parallel? |
|---|---|---|---|
| **B1** | `gates.mjs` + `evidence.mjs` — check library, GateReport, baseline/change-set capture, known-commands runner | A1, #9 | ‖ with B2 |
| **B2** | `chain-state.mjs` + `chain-state.schema.json` — state, lock, JSONL ledger | — | ‖ with B1 |
| **B3** | `segments.mjs` — frozen tier2/tier3 tables, `HALT_KINDS`, decision schema, `validateSegmentTable` | B2 | after B2 |
| **B4** | `chain.mjs` — the step machine, `plan`/`step`/`status`/`abort`, `DISPATCH_BIN` seam, `fake-dispatch.mjs` fixture | A2, B1, B2, B3, #8 | after all |
| **B5** | `chain resolve` — decision ingress with contradiction refutation + `--override` ledger record | B4 | after B4 |
| **B6** | scope gate: protected paths + within-grant overreach + `green_suite_fresh`/`revised` | B1, B4 | ‖ with B5 |
| **B7** | Tier-3 segment table: package → package-review loop counting → per-phase sub-chains | B4, B5 | after B5 |
| **B8** | `ship` segment: teardown + `validate.full` (memory + git/PR stay orchestrator-owned) | B4, #7 | ‖ with B7 |
| **B9** | Wiring: `references/chain.md`, ≤2 `orchestration.md` lines, substrate-neutral wording in `next.md`/`ship.md` | B4…B8 | last |

**Slice sizing note for B4** — it is the largest and should be split at review if `Files` exceeds ~700 added lines; the natural cut is *step machine* vs *halt projection + fixture*.

**Slice B9 constraints, restated** · `next.md`/`ship.md` are in `GUARDED_COMMANDS` and **must not contain `/cmux/i` or `/roster/i`** — the chain is referred to by its substrate-neutral name only. · `orchestration.md` has **2 lines of test-granted headroom** (67/69), so mechanics go in `references/chain.md`. · `references/chain.md` does not trip the `cmux-*.md` glob but **does** need the ratification in §13.

### 12.3 Triage of the earlier Phase-A candidates

| Candidate | Verdict |
|---|---|
| tee-recovery for validation lanes | **Phase B (B1).** Needs `evidence.mjs`; no #15 issue owns it; `paths.logsDir` (`resolve.mjs:104`) is its natural home. |
| `verdict_consistent`-class gates | **Phase B (B1), parent-side.** It was only a Phase-A candidate under worker-side wiring, which §5.4 defers. |
| hook non-blocking contract + integrity hashing | **Already shipped at #4** — `return-gate.sh` fails open; `role_prompt_sha256` + closed-manifest walk are PRE-1C-VERIFY checks 2 and 3. **No slice needed.** |
| spec-lint gaining a schema-driven field check | **Phase A (A1 scope item 2).** |

---

## 13. Ratification required (deviations and judgment calls needing explicit user sign-off)

1. **`qa-gate.md:7` wording — deterministic validation.** The text says the *orchestrator* re-runs `validation_commands` "directly via Bash." A chain-run validation is still deterministic, still parent-side, still not a window — but it is not literally the orchestrator's Bash call. Proposed amendment: *"…runs deterministically in the parent process — your own Bash call, or the chain runner on your behalf — never as a window."* **This is a fourth narrow exception to "brain unchanged" and needs the epic's §13 treatment.** Without it, B4/B6 either violate the letter of Inv 1 or leave every validation re-run as an orchestrator turn (which materially weakens the turn-count case for the whole initiative).
2. **A second on-demand reference file (`references/chain.md`).** Epic binding constraint (2) says "mechanics in ONE reference." Argued deviation: that constraint scoped *cmux* mechanics; the chain is a distinct subsystem with a distinct trigger, and folding it into `cmux-dispatch.md` (91 → ~140 lines) makes every cmux triage read pay for chain protocol. **Alternative if refused:** fold in, and accept the read cost.
3. **`orchestration.md` ceiling.** The epic budget (≤8 added lines, 4 used) implies 4 remain, but `test/orchestration.test.mjs:12` hard-codes 69 against a 67-line file — **2 lines in practice.** If B9 needs 3–4, the test constant must be edited deliberately. Recommended target: **≤2 lines**, no ceiling change.
4. **Mechanically enforcing the ≤2 amend bound.** The chain would refuse to dispatch a third amend cycle. The bound is unchanged and the escalation content stays the orchestrator's — I argue this is *not* a brain change, but it operates directly on `orchestration.md:53`'s territory and should be confirmed rather than assumed.
5. **`dispatch.mjs` refusing on a spec-lint FAIL (A2).** Adds a refusal path to a contract-freeze-set file and makes a brain rule structurally enforced. Argued compatible with "spec ingress unchanged" (the rule is identical; only its skippability changes), but flagged.
6. **Explicitly NOT deviating from ADR-007.** Option B (absorbing `team-build.workflow.mjs`) is **rejected** and no deviation is requested. Recorded so the rejection is visible rather than silent.
7. **Not deviating from "gate never fired from code."** The chain halts and the orchestrator fires `phase --set gate`. Recorded for the same reason.

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Turn count goes up, not down** — if a step halts too often, the chain costs more turns than prose sequencing | High — it invalidates the whole thesis | A step must advance *maximally* (dispatch + await-to-resolution + gate) before halting; halt kinds capped at 7; **acceptance criterion: measured orchestrator turns for a representative Tier-2 task must not increase** |
| Two places record "what comes next" (`segments.mjs` vs `orchestration.md`) drift | Medium | One precedence sentence in `orchestration.md`: *when a chain is active, its halt JSON is the authority on the next step*; `orchestration.md`'s flow prose remains the agent-tool-mode description |
| `await.lock` contention between chain and orchestrator | Medium | The chain is the only await caller while active; contention ⇒ exit 2 with the holder PID, never a wait, never a force |
| Suite wall-clock (~60s already) grows past comfort | Medium | Hard ≤10s budget; `DISPATCH_BIN` fake means chain tests spawn no topologies |
| `chain.json` becomes a god-object as segments accrete | Medium | Segment tables are versioned data (`tier3.v1`); schema stays flat and in-BUDGET; a new field with a documented default does not bump `schema_version` |
| A fake-dispatch fixture that mirrors the chain's assumptions makes the whole gate tautological | High | Frozen live captures of real `dispatch.mjs` output, checked in beside the fixture (`qa-notes.md:16` — this failure has already happened once here) |
| Over-architecture: five modules and a state machine for a two-person workflow | Medium | Phase A ships two standalone-useful slices with zero chain dependency; if the position decision is reversed, A1/A2 remain net wins |

---

## 15. Open unknowns & assumptions

### Verified this session (with evidence)

| # | Claim | Evidence |
|---|---|---|
| V1 | `spec-lint.mjs` cannot be imported (module-level side effects, no exports) | `scripts/spec-lint.mjs:33-34, 202-212` |
| V2 | A second `UserPromptSubmit` per dispatch permanently disables the return gate | `scripts/cmux/gate-mode.sh:47-51` |
| V3 | No session id is captured anywhere; only a `session_resume` capability boolean | `scripts/cmux/adapter-claude.mjs:271` |
| V4 | `status.json` is overwritten wholesale by every `status` call | `scripts/cmux/dispatch.mjs:1364-1365` |
| V5 | No `task.json` exists in code; `taskPaths` provides `logsDir`/`statusPath`/`lockPath` | `scripts/cmux/resolve.mjs:90-112` |
| V6 | `next.md` and `ship.md` are guarded against `cmux`/`roster` by a closed `deepEqual` manifest | `test/cmux-contract.test.mjs:604-631` |
| V7 | `orchestration.md` is 67 lines against a hard-coded 69 ceiling | `test/orchestration.test.mjs:9-13` |
| V8 | The one-cmux-reference test is a **filename** glob, so `references/chain.md` does not trip it | `test/orchestration.test.mjs:31-34` |
| V9 | `dispatch.mjs`'s `invokedDirectly` uses `resolvePath`, not `realpathSync` | `scripts/cmux/dispatch.mjs:1546` |
| V10 | `return-lint.extractSection` and the fenced-block scanner are private | `scripts/cmux/return-lint.mjs:165` |
| V11 | Leads return markdown with a `Handover Spec` section; `handover-spec.schema.json` is validated nowhere | `roster.default.json:112,122,132` |
| V12 | A coder's worktree contains `.claude/dev-team/memory/**` inside its `worktree_write` grant | `roster.default.json:15,33` + worktree = checkout of this repo |
| V13 | `OUTCOME_MAPPING` is a single ordered table with a frozen enum | `scripts/cmux/dispatch.mjs:102-114` |
| V14 | CI pins Node 20 | `.github/workflows/test.yml`; `ladder.mjs:2` |

### Unverified assumptions the design rests on

| # | Assumption | Status | If wrong |
|---|---|---|---|
| **U1** | `node:sqlite` is unavailable on Node 20 (landed 22.5) | unverified (knowledge, not probed) | Nothing breaks — JSONL is independently justified. Low risk. |
| **U2** | A `chain step` subprocess completes within the harness's Bash tool timeout | **unverified — highest-impact unknown** | If `--max-block-s` × the await loop exceeds the tool timeout, `chain step` must chunk internally and return `still-running` more eagerly. **Needs a measurement before B4 is specified.** The one unknown that could change B4's interface. |
| **U3** | Appending a <4096-byte line with `appendFileSync` is atomic against a concurrent reader | unverified | Mitigated: single writer under the chain lock; the cap is belt-and-braces. |
| **U4** | A chain-run validation command sees the same `PATH`/toolchain as the same command run inside a pane | unverified | sssf invariant 7's `operator_env` bug class. A divergence makes chain-run validation disagree with the coder's self-report. **Scout before B1 ships `tests_pass`.** |
| **U5** | The orchestrator can be reliably instructed to call `chain step` in a loop rather than narrating | unverified — behavioral | If not, the chain is an expensive no-op. Mitigation: halt JSON designed to be *more* convenient than re-derivation; the turn-count acceptance criterion measures exactly this. |
| **U6** | `git status --porcelain -z` fingerprinting is fast enough per gate on a large repo | unverified | Cache per phase; baseline captured once per slice. Low risk. |
| **U7** | Phase B's dependency on #7/#8/#9 is complete | unverified (derived from digest, not from #10–#14 bodies) | A missed dependency reorders Phase B. **Cheap: read #11/#13 bodies before filing the Phase-B epic.** |
| **U8** | `plan-reviewer`'s prose verdict stays prose | verified as a decision, unverified as stable | If a later slice gives plan-reviewer a verdict block, B7's "chain cannot branch here" becomes obsolete. One-line check at #8 planning. |

### Needs a user decision (not scoutable)

- **D-a.** All seven items in §13 — especially §13.1 (the `qa-gate.md` amendment), a genuine fourth exception to "brain unchanged."
- **D-b.** Does Phase B interleave with #15 (start after #7/#8/#9) or wait for the full epic? Recommendation: **interleave.**
- **D-c.** Is a three-substrate steady state acceptable, or should the plan carry an explicit `team-build.workflow.mjs` deprecation milestone? Recommendation: **accept three**, with the named convergence trigger, because the workflow is the only substrate that survives `execution_mode: agent-tool`.

---

## 16. Acceptance criteria (initiative level)

1. **Turn count does not increase.** Orchestrator turns for a representative Tier-2 task, measured on a real run, are ≤ the pre-chain baseline. *(Requires the baseline measurement in §17.)*
2. **No path exists from a spec-lint FAIL to a spawned executor** — proven by a test asserting zero fake-cmux invocations, with a paired positive asserted first.
3. **The chain never resolves a judgment** — proven by mutation: injecting a decision-fabricating mutation into `resolve` fails the suite.
4. **`chain resolve` refuses a decision contradicting a hard-fail gate**, exit 2, message asserted against the exported constant; `--override` writes a ledger line carrying the reason.
5. **A killed `chain step` leaves the phase `status:"fail"`** and the next step reclaims the stale head — both asserted.
6. **Two concurrent `chain step` invocations:** the second refuses exit 2 naming the holder PID; a corrupt lock is treated as stale, never a wedge.
7. **`chain step` refuses when `await.lock` is held by another process** — asserted against the exported constant.
8. **Every gate check returns evidence on pass**, not just a reason on fail — asserted per check.
9. **A protected-path modification hard-fails and names every path**; a scope-only violation bounces without hard-failing. Both asserted; the permissive degenerate fails the suite.
10. **`node --test` green**, suite growth ≤10s, no cmux/claude/model/network/GUI.
11. **Every new schema is added to `test/schema.test.mjs`'s hardcoded list.**

---

## 17. Recommended team dispatch

**Research (before B-phase specs are finalized; A1/A2 need none):**
- **Scout 1 — `Explore` (sonnet): turn-count baseline + Bash-timeout envelope.** From a recent shipped transcript, count orchestrator turns for one Tier-2 task end-to-end, and determine the effective Bash tool timeout ceiling in this harness (**U2**). *Highest-value scout — U2 can change B4's interface.*
- **Scout 2 — `Explore` (sonnet): environment parity (U4).** Run one identical validation command in a cmux pane and from the orchestrator's Bash, diff `PATH`/`which node`/`npm bin`.
- **Not worth a scout:** U1, U3, U6. **U7** is a two-minute `gh issue view` by the orchestrator.

**Feasibility consults (brokered):**
- **`backend-lead`:** (a) spawn-vs-import for the `dispatch.mjs` seam; (b) reuse `record.mjs`'s `withRecordLock` or own lock for `chain-state.mjs`; (c) the 4096-byte JSONL cap; (d) `chain.json` schema in-BUDGET confirmation.
- **`qa-lead`:** (a) `fake-dispatch.mjs` fixture design + which outputs must be frozen live captures; (b) named degenerates for `canAdvance`; (c) the ≤10s suite budget; (d) review lane per slice.
- **`devops-lead`:** Node 20 floor confirmation, zero-dep preservation, CI wall-clock headroom.
- No `frontend-lead` — no frontend surface exists.

**Review gate:**
- **`dev-team:plan-reviewer` — mandatory.**
- **`dev-team:architect` — recommended second opinion** on §3 (position) and §5.2 (post-completion gate layer vs step-2 extension).

**Dispatch shape for the build (post-approval):**
- **A1 → A2 sequential**, single `backend-lead` spec each, one coder each.
- **B1 ‖ B2** parallel, then **B3 → B4 → (B5 ‖ B6) → (B7 ‖ B8) → B9**.
- Coders parallel only where files are disjoint; `isolation: "worktree"` throughout.
- **Parallel coders must not run the full suite mid-wave** (`qa-notes.md:15`).

---

## 18. Proposed memory deltas

*(The orchestrator commits; the lead only proposes.)*

### → `.claude/dev-team/memory/architecture-notes.md`
ADR-014 through ADR-019 as §11 above (status: proposed), plus: **Phase-B gating is #7 + #8 + #9, not the whole epic.**

### → `.claude/dev-team/memory/conventions.md`
- **Success must be earned:** any phase/step record defaults to a failed status; only a clean exit flips it.
- **A gate returns evidence, not a boolean:** every check yields `{item, ok, note}`; note = evidence on pass.
- **Deterministic results never wear an agent's envelope** — synthesizing one would forge the frozen identity four-tuple.
- **Deterministic code may count a judgment loop's bound and refuse to advance past it; it may never choose the bound, resolve the loop, or author the escalation.** Refutation with `--override "<reason>"` recorded in the ledger.
- **A revision made after the last green validation run makes that green light stale** — track `revised`, re-run before acceptance.
- **The `<TOOL>_BIN` fake-binary seam extends to first-party CLIs** (`DISPATCH_BIN`), with frozen live captures beside the fake.
- **A CLI spawned from a test fixture must `realpathSync` both sides of its `invokedDirectly` guard** — `resolvePath` comparison is silently a no-op under macOS `TMPDIR` symlinks.

---

## 19. Files referenced

**Digests:** `tasks/deterministic-backbone/{repo-internals,cmux-design-record,sssf-mechanisms}.md`
**Memory:** `.claude/dev-team/memory/{conventions,architecture-notes,backend-notes,qa-notes}.md`
**Read this session:** `orchestration.md` · `references/{tier3-planning,cmux-dispatch,qa-gate}.md` · `commands/{next,ship}.md` · `scripts/spec-lint.mjs` · `scripts/cmux/{dispatch.mjs,resolve.mjs,ladder.mjs,return-lint.mjs,adapter-claude.mjs,gate-mode.sh,roster.default.json}` · `team-build.workflow.mjs` · `test/{cmux-contract,orchestration}.test.mjs` · `.claude/dev-team/config.md`
**New files proposed:** `scripts/chain/{chain,segments,chain-state,gates,evidence}.mjs` · `scripts/chain/chain-state.schema.json` · `references/chain.md` · `test/{chain,chain-state,chain-gates,chain-segments,chain-evidence}.test.mjs` · `test/fixtures/fake-dispatch.mjs`
