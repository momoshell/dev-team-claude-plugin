# Architecture Package v2.1 — amendment to v2 (FINAL, consolidated)

**Author:** architecture-lead · **Date:** 2026-08-01 · **Status:** deltas only — append to v2; v2 sections not named here stand unchanged. Supersedes the interim v2.1 draft (kept as …-interim-draft.md; where the two differ, THIS file governs).
**Drivers:** plan-reviewer re-review *approve-with-conditions* (NEW-1…6, judgments 3(a)/3(b), cursor ownership, adoption gaps, D16 placement) + ledger addendum **D16** and **D17**.

---

## A. Amendment index

| Item | Kind | Lands in |
|---|---|---|
| NEW-1 profile-replaces-frontmatter | blocking | §5.1, §5.4, §8 |
| NEW-2 attribution of "attention" | blocking | §4.3, §5.5, §12·6 |
| NEW-3 kickoff carries literals | blocking | §5.3, §5.9, §8 |
| S9 on-no ladder rebuilt (judgment 3a) | condition | §7 Phase 0 S9, §11, §14 |
| Cursor ownership + timeout coherence (judgment 3b) | condition | §5.2, §5.5, §7 S6 |
| Adoption gaps: `max_turns` reserved · Close-step focus verb | condition | §5.4, §5.5 |
| NEW-4 worktree reuse on re-dispatch | should-fix | §5.5, §5.7 |
| NEW-5 ceiling-miss escalation | should-fix | §14 |
| NEW-6 roster field reservation | note | §5.4, §7 1a |
| **D16** shared noise filter | ledger | §3.5, §5.1, §5.2, §5.10, §7 Ph3, §8, §10 (R17), §12 |
| **D17** structured reviewer verdicts | ledger | §3.5, §4.5, §5.1, §5.4, §8, §14·2 |

---

## B. Blocking conditions

### B-1 · Profile flags REPLACE frontmatter flags for `pane: true` dispatches [resolves NEW-1]

code-reviewer.md, code-reviewer-deep.md, build-validator.md declare `disallowedTools: Edit, Write, NotebookEdit`; v2 §5.1's mapping would have composed *blanket deny + scoped allow* — the configuration §4.6 proves cannot work under G3. The four lead roles' `tools:` universe (no Write) would remove the Write tool the grant depends on.

**§5.1 mapping — replacement rule:**
> **Frontmatter/profile precedence for `pane: true` dispatches.** The resolved profile's `tools` / `allow` / `deny` **replace the role's frontmatter `tools` and `disallowedTools` wholesale — never merge.** From frontmatter a pane dispatch takes **`model` and `effort` only**; `permissionMode` is always the profile's (`dontAsk`); `maxTurns` → roster `max_turns` (Phase 3). Rationale: frontmatter expresses the *Agent-tool* enforcement model (universe + blanket deny); the profile expresses the *pane* model (universe + allowlist under a non-prompting mode). Mixing them produces a session silently unable to return. `agents/*.md` remain unmodified and authoritative for Agent-tool dispatch.

**§8 — `test/claude-adapter.test.mjs` extended:** for every `pane: true` role: no bare Edit/Write/NotebookEdit deny token in `--disallowedTools`; `--tools` equals the resolved profile's universe exactly; no string from frontmatter `disallowedTools` reaches the argv; the scoped `Edit(//…/returns/**)` grant is present. (The roster test only sees profiles; the assertion must be against composed argv, per role.)

**Second-order decision — reviewer web tools: KEEP.** Reviewers today have web access, and the repo convention is verify-against-current-docs; dropping them is a silent quality regression for zero security gain (the profile prevents writes/topology, not reading public docs). Injection hygiene stays in D16's deferred follow-ups. `build-validator` inherits harmlessly; if S15b shows tool-definition size matters, a narrower `validator` profile is a cheap roster-only follow-up.

**§5.4 `reviewer` profile:**
```json
"reviewer": { "permission_mode": "dontAsk",
              "tools": ["Read","Glob","Grep","Bash","Write","WebFetch","WebSearch"],
              "allow": ["Edit(${RETURNS_GLOB})","Bash(git diff *)","Bash(git log *)","Bash(git status *)"],
              "deny":  ["Bash(cmux *)"], "disable_slash_commands": true }
```

### B-2 · An event may trigger a rescan; it may never BE a resolution [resolves NEW-2]

**§4.3 / §5.5 — replacement outcome model:**
> **Rescan triggers** (in-process; never end the call; never cost an orchestrator turn): a `notification.requested` event for the workspace · the rank-0 poll tick · an EXIT sentinel appearing. Each trigger re-stats and re-lints every outstanding return and refreshes the per-dispatch quiet timer.
>
> **Resolution reasons** (end `await --all`; each per-dispatch attributable):
> 1. **`completed:<id>`** — fresh valid return (mtime > record.created_at, lint 0; includes `blocked` returns from agent, gate, or adapter).
> 2. **`crashed:<id>`** — `logs/<id>.exit` sentinel present AND no fresh valid return.
> 3. **`attention:<id>`** — **quiet timer**: a workspace turn-end event was observed, this dispatch still has no fresh valid return `quiet_s` later (default 45s), AND `cmux top` shows that pane's process idle. Raised at most once per dispatch per attempt (latched in status.json) until re-armed.
> 4. **`timeout:<id>`** — now − record.created_at ≥ timeout_s.
>
> **Non-resolution exit:** `still-running` at `--max-block-s`, listing remaining ids; the orchestrator re-invokes.

The `top` idle check is what *attributes* a workspace-scoped event to one pane — without it the outcome must not exist. If `top` is unavailable (S2), the quiet timer is **disabled**, attention comes only from reasons 2 and 4, and that degradation is loud in `status`.

**§12·6 arithmetic:** six panes ⇒ one orchestrator turn per resolution (6) + one per chunk cap, **zero** per turn-end event. Criterion 6 gains: *"…and `await --all` invocation count for the run is ≤ (dispatches) + (elapsed ÷ max-block-s) + 2."*

### B-3 · The kickoff carries expanded absolute literals [resolves NEW-3]

**§5.3 addition:**
> **Two audiences, two forms.** `env.DEVTEAM_*` is for shell-side consumers (adapter, return-gate.sh, gate-mode.sh), which expand it. **The model receives expanded absolute literals in the kickoff** (first user message): absolute spec path, absolute return path, dispatch id. The kickoff is per-dispatch by design and sits after the cached prefix — ADR-009 unaffected (it constrains the system prefix, not the first user message). The addendum's `$DEVTEAM_RETURN_PATH` tokens are documentation naming the value the kickoff delivers.

**§8 counterpart:** the two dispatches asserting byte-identical prompt files must assert **kickoff strings differ** and each contains its own absolute return path — otherwise byte-identity could be satisfied by an adapter that never tells the agent where to write.

---

## C. Judgment-3(a) rebuild — S9 on-no ladder by failure layer

(v2's "parallel `Write(...)` rule" rung deleted — G4: unmatched + startup warning. Relocation is NOT rung 1: under `dontAsk` an external dir still needs its own Edit rule.)

| Rung | Failure layer | Fix |
|---|---|---|
| 1 | **Rule kind** — `Edit(…)` doesn't cover the Write tool at the returns path | Widen one notch: `Edit(//abs/task-dir/**)`. Cost: judgment role may write anywhere in its task dir — bounded, auditable, no repo access. |
| 2 | **Anchor** — CLI-flag rules anchor at original cwd (G5) | Re-express as a **settings source inside the task dir**: `--settings //abs/task-dir/worker-settings.json` with settings-relative `/p` rules (`Edit(/returns/**)`) — a `--settings` file anchors at its own directory. Per-**task**, hooks-free; ADR-009 prohibits per-**dispatch** generation, so it stands; S15b re-checks prefix stability. |
| 3 | **Scoping unavailable** | Relocate `returns/` (or task dir) outside the repo so a repo-wide Edit deny can coexist. Filed §13·6, ratification required. |
| 4 | **Terminal** | **Unscoped Write for judgment roles — user decision §14·7, never silent.** Voids §12·2 + Phase-2 acceptance clause; git scope check does NOT transfer (leads/reviewers: no spec, no files_in_scope, no worktree, primary checkout). Substitute = detect-after-the-fact: `git status --porcelain` over the primary checkout before accepting any judgment-role return; refuse a return whose dispatch dirtied the tree. |

**§11 fix:** S9 gates **Phase 1c** (profile shape); by-phase line moves S9 to "Before Phase 1"; S-table cell = Ph1c.

---

## D. Judgment-3(b) — cursor ownership, single-writer, timeout coherence

**§5.2:** add `await.lock` (PID + started_at; stale = older than 2× max-block-s, breakable with a logged warning).

**§5.5 await rules:**
1. **Single writer.** `await` takes await.lock before attaching an events consumer; a second concurrent `await` runs **rank-0-only** (file watch, no events, no cursor writes) rather than failing.
2. **Cursor advances only on clean exit.** Events child writes to a spool; `events.cursor` advances from the spool only when `await` exits through a resolution or the chunk cap. Crash/kill/lock-break leaves the cursor — replay-safe, since events only trigger idempotent rescans (B-2).
3. **Kill the child at the cap.** `trap` kills the `cmux events --reconnect` child on every exit path.
4. **Gap-window fallback.** Between invocations no consumer is attached. **S6 extended:** does an event fired with no consumer attached get delivered on next attach from the cursor? **If no:** rank-0 tightens 3–5s → **2s** and events are demoted to an in-invocation latency optimization. The tightening is bound to this specific S6 answer.

**§5.5 timeout line:** `timeout_s` is wall-clock from `record.created_at`, evaluated on every rescan — per-invocation measurement would be dead code under chunking.

---

## E. Adoption gaps

**`max_turns` reserved now [Q1-9/NEW-6].** §5.4 defaults gain `"max_turns": null`; role schema accepts optional `max_turns` (int ≥ 1). Unused until Phase 3 (gate counter enforces). Slice 1a freezes a schema that never changes in Phase 3.

**Roster-schema evolution: reserve now.** Reserved in roster.schema.json v2 at 1a: `max_turns` (defaults + role) and `verdict_block` (role, D17). `noise_globs` is NOT a roster field (config.md + scripts/noise-globs.json). Standing rule in the schema description: *additive optional fields don't bump `version`; removals/semantic changes bump it and dispatch.mjs migrates on read.*

**Close-step focus verb [Q2-3].** §5.5 Close:
> Select the doc tab **within its own pane** — `cmux focus-panel --panel <md-surface-uuid>` — changing the active surface inside that pane only. **Never** `focus-pane`, `select-workspace`, or any window/pane-level focus from a background dispatch (six panes ⇒ view-yanking on every return). Layout commands are focus-neutral by default; pass `--focus false` wherever supported. If S18 shows `focus-panel` is pane-level in practice, degrade to **do nothing** — the doc tab is already the sibling tab, the user selects it — never to a coarser focus verb.

---

## F. Should-fixes

**NEW-4 · Re-dispatch REUSES the worktree.** Attempt 2 is almost always an amend cycle; today's amend loop hands the coder back its prior work — a fresh worktree would silently discard partially-correct edits. Worktree keyed to **task_id**; worktrees.json records one entry with `attempts: [dispatch_ids]`; teardown's "only if clean and merged" evaluates once per worktree at ship; after a *crash* `status` must warn when offering re-dispatch ("worktree has uncommitted changes from attempt N"). Return files unaffected — new dispatch_id ⇒ new return path; PR-4 freshness untouched.

**NEW-5 · Ceiling-miss escalation → §14·8.** "Restrict leads out of panes" is a D3 deviation; cannot be a coder's judgment call at Phase-2 GO/NO-GO.

---

## G. D16 fold-in — shared noise filter

**§3.5·1 exception parenthetical (carries all three output-contract/read-scope items):**
> *(Three narrow exceptions, none touching tier semantics, the gate ladder, memory protocol, or ship flow: lead returns become file-backed markdown with required sections; reviewer Verdict sections gain a machine-readable block (D17); and spec-lint gains a WARNING on noise-glob matches in files_in_scope while the QA-gate bundle and cmux diff view are noise-filtered (D16). The git scope-compliance check stays unfiltered.)*

**§5.1 modified-files — four added rows:**
| Path | Change |
|---|---|
| `scripts/noise-globs.json` | new data file — single shared definition (lockfiles, vendored, minified/generated, build output). Read by spec-lint; composed into git pathspec exclusions by gate prose. |
| `scripts/spec-lint.mjs` | `warn()` when a files_in_scope entry matches a noise glob (helper exists at :36; warnings keep exit 0). |
| `handover-spec.md` | one guidance line: keep generated/vendored content out of discovery_context; name a noise path in files_in_scope only when changing it is the point. Keeps agents/*.md unchanged. |
| `references/qa-gate.md` | bundle + cmux diff exclude noise-glob paths (pathspec from noise-globs.json); git scope check explicitly unfiltered; plus the D17 line (§H). |

**§5.2:** config.md gains `noise_globs:` (per-project override; onboard seeds the key).

**§5.10:**
> Reviewer bundle + `cmux diff` view are **noise-filtered**; the git scope-compliance check is **explicitly unfiltered** — noise there is classified and labelled, never dropped.
> **Suppression rule (overrides both):** a noise-matching path in the spec's `files_in_scope` was intentional and is **never filtered anywhere** — a dependency-bump task's only meaningful diff IS the lockfile.

**§7 Phase 3 — slice 3c (one coder):** `scripts/noise-globs.json`, `scripts/spec-lint.mjs`, `handover-spec.md`, `references/qa-gate.md`, `test/spec-lint.test.mjs`. Parallel with 3a/3b; no file overlap.

**§8 — test/spec-lint.test.mjs:** noise match in files_in_scope → WARN + exit 0 (never FAIL); non-noise → neither; per-project globs extend defaults; suppression asserted where it bites (warned-about path is NOT excluded from the bundle pathspec).

**§10 — R17 · Medium:** filtered-away signal — a reviewer passes a diff it never saw. Mitigations: filter only at the two READ points; files_in_scope suppression; **bundle header names filtered paths + count** so the omission is always visible in the gate report.

**§12 — criterion 13a:** lockfile-containing diff → bundle excludes it + gate report names it as filtered; dependency-bump task naming the lockfile in files_in_scope → bundle **includes** it; both cases: git scope check sees the unfiltered list.

**§12·10 reconciled:** "orchestration.md grew ≤ 8 lines and exactly one new `references/cmux-*.md` exists" — matching the test. D16/D17 add no reference file.

---

## H. D17 fold-in — structured reviewer verdicts

**§4.5/§5.1 return-lint responsibility:**
> …for `kind: markdown`, required-headings check **plus, when the role sets `verdict_block: true`, a fenced machine-readable verdict block inside the Verdict section** — present, parses as JSON, `verdict` present, every `findings[].severity` ∈ critical|warning|suggestion. **Finding quality is never linted.**

**§5.4 roster:**
```json
"code-reviewer": { "pane": false, "model": "sonnet", "profile": "reviewer",
                   "return": { "kind": "markdown",
                               "required_sections": ["Verdict","Must-fix","Notes"],
                               "verdict_block": true },
                   "doc_tab": true }
```
Block shape (documented in references/qa-gate.md + the reviewer substrate addendum — static text, ADR-009 holds):
```json
{ "verdict": "approve|revise|block",
  "findings": [ { "severity": "critical|warning|suggestion",
                  "file": "src/x.ts", "line": 42, "summary": "…" } ] }
```

**§5.1 qa-gate.md row, one added line:** the gate branches on the severity enum (any `critical` → bounce/escalate per the existing ladder; only `suggestion`s → pass with notes), never on prose interpretation. The ladder is unchanged — this replaces prose-reading with enum-reading, the same move as the coder's `{status}`.

**§8 — test/return-lint.test.mjs:** valid block in valid markdown passes; verdict_block role with headings but no block fails; unparseable block fails; out-of-enum severity fails; verdict_block:false role with no block still passes; block presence doesn't affect heading matching.

**Brain-adjacency:** judgment, ladder, thresholds untouched; only the verdict's *shape* is mechanized. Folded into the same §3.5·1 clause and §14·2 decision as the lead-return contract.

---

## I. §14 user decisions — updated

1. **R8 failure archiving** — recommend **yes**.
2. **Output-contract tightening (carries D17 now).** Lead returns: required sections. Reviewer Verdicts: machine-readable `{verdict, findings[]}` block, shape-validated only. **Recommend: accept.**
3. **Worker signal carve-out removal** — recommend accept.
4. **Tier-1 delegated coder** — single pane in orchestrator's workspace.
5. **`cmux hooks setup`** — not now; documented for non-Claude adapters.
6. **Spike scheduling** — confirm the slot.
7. **NEW — S9 terminal rung (conditional; only if rungs 1–3 all fail).** Unscoped Write for judgment roles + post-return `git status --porcelain` detection. Voids §12·2 + Phase-2 clause; scope check doesn't cover leads/reviewers. **Recommend: decide only if reached — prefer rung 3 (relocate returns/, §13·6) over rung 4;** take rung 4 only if scoping is broken outright, consciously trading prevented for detected.
8. **NEW — Cost-ceiling miss (conditional; Phase-2 GO/NO-GO).** (a) accept measured cost, no deviation; or (b) restrict role classes to Agent-tool via `pane: false` — explicit D3 deviation (§13·7, ratification). **Recommend: per-role breakdown to the user; prior = (a) for leads** (few dispatches, high value, visibility is the initiative's core promise), **(b) only for high-fan-out low-value roles if the miss exceeds ~3×.** Never the measuring coder's call.

---

## J. Acceptance-criteria changes (§12)

- **6** + invocation-count clause (B-2).
- **10** reworded to "exactly one new `references/cmux-*.md`".
- **13a** new (D16, both halves).
- **13b** new (D17): a reviewer dispatch with a missing/out-of-enum Verdict block fails return-lint and is bounced before the gate branches; a valid block drives the ladder by enum with no prose interpretation.
- 1–5, 7–9, 11–13 unchanged. Criterion 2 + the Phase-2 clause are explicitly voided if §14·7 is taken — recorded there, not weakened here.

---

## K. Memory-delta adjustments

**architecture-notes.md:**
- **ADR-003 +**: events trigger rescans only; a resolution must be per-dispatch attributable (fresh valid return, EXIT sentinel, or quiet-timer with an idle check). A workspace-scoped doorbell can wake a join but never close one.
- **ADR-005 +**: for pane dispatches the profile's tool universe and rules REPLACE the role frontmatter's; merging an Agent-tool denylist with a pane allowlist produces a session that cannot return.
- **ADR-009 +**: the cached-prefix constraint binds the system prompt and appended files only; per-dispatch literals belong in the kickoff — where the model must receive its absolute paths.
- **ADR-010 — new (D17). Machine-readable verdicts at both ends of the pipe.** Reviewer returns stay markdown for the human surface but carry a fenced `{verdict, findings[]}` block, shape-validated only; the gate branches on the severity enum, never prose. Consequence: reviewer prose quality remains entirely un-linted and the orchestrator's judgment.
- **ADR-011 — new (D16). One shared noise-glob definition, applied at read points only.** noise-globs.json + config.md override; applied at reviewer bundle, cmux diff view, handover guidance (spec-lint warns); never at the git scope check; never to a files_in_scope path. Consequence (R17): the bundle header names what was filtered — a reviewer passing a diff it never saw is the failure mode.

**conventions.md — additions 13–15:**
13. **Enforcement models don't merge.** A role on a different substrate gets its permission expression *replaced*, not combined — a denylist authored for one substrate plus an allowlist authored for another yields a configuration that silently cannot do its job.
14. **A doorbell that cannot name the sleeper only wakes; it never decides.** Workspace/fleet-scoped events trigger rescans; resolutions require per-target attribution.
15. **Filters apply to what an agent reads, never to what a check verifies.** Filtering is a read-side convenience; verification paths always see the unfiltered truth, and filtered content is named, not hidden.

Convention 12 amended: "…and the per-dispatch payload travels as expanded literals in the first user message; env vars are for shell-side consumers, which the model is not."

**Unchanged:** conventions 1–12, ADRs 001/002/004/006/007/008 as recorded in v2.

---

# §R. D17 rider (FINAL — from the lead's authoritative last emission; where §H above and §R differ, §R governs)

**R1 — §5.4 roster.** `verdict_block: true` on gate-participating reviewer roles only: `code-reviewer`, `code-reviewer-deep`, `build-validator`. Field reserved in roster.schema.json v2 now. Scoping choice, stated for pushback: `plan-reviewer`/`trd-reviewer` keep prose verdicts — their output feeds human approval, not a mechanical ladder; flipping them later is a one-line roster change.

**R2 — return-lint.** With `verdict_block: true`, markdown mode additionally requires exactly one fenced ```json block inside the section matching `Verdict`, parsing to:
`{ "verdict": "pass | changes-needed | inconclusive", "findings": [ { "severity": "critical | warning | suggestion", "file": "<path>", "line": 123|null, "summary": "<one line>" } ] }`
Unknown keys ignored (forward-compatible). Presence, parseability, enum membership only — never quality. **The verdict enum is the repo's EXISTING vocabulary** — references/qa-gate.md:33 already fixes pass/changes-needed and defines missing-verdict as inconclusive → re-run scoped to the diff. Severity mapping stated in qa-gate.md: critical ↔ Must-fix (blocks) · warning ↔ Should-fix · suggestion ↔ Consider.

**R3 — gate branching.** Any `critical` → bounce/escalate per the existing ladder; `warning`s → task summary; only `suggestion`s → pass with notes; missing/unparseable block → `inconclusive` → re-run scoped to the diff (today's rule, now mechanical). Adversarial panel: `pass = majority` computed over members' `verdict` values. Prose remains for the human and the doc tab; control flow reads the block.

**R4 — tests + criterion 15.** return-lint rows: valid block passes · missing block fails for verdict_block roles · out-of-enum severity fails · out-of-enum verdict fails · valid block in otherwise-valid markdown passes · verdict_block:false roles unaffected. §12 criterion 15: a gate run bounces on a critical-bearing block and passes-with-notes on a suggestions-only block, without the orchestrator reading the prose.

**R5 — folded into §3.5·1's single exception parenthetical and §14·2** ("Output-contract tightenings" — lead sections + reviewer verdict block, recommend accept).

**R6 — memory.** ADR-002 consequence line: "Structured returns are the data plane's contract in both directions — the orchestrator branches on enums (status, verdict, severity), never on prose." New convention: "Any verdict that drives control flow is structured data with a fixed enum, validated mechanically; quality judgments stay agent-side and are never linted."

# Final corrections from the authoritative emission (supersede §I above where they differ)

1. **§14·7 recommendation CHANGED: "stop and escalate."** If S9's rungs 1–3 all fail, the lead now recommends stopping and re-designing the judgment-role return channel rather than accepting unscoped Write + detection. Rationale: three independent scoping layers failing is a platform finding worth pausing on, not a licence to widen. (Unscoped-Write-with-detection remains the documented alternative should the user choose it.)
2. **D2 focus fallback:** if S2/S18 show `focus-panel` steals pane focus, drop the focus call entirely — `reorder-surface --before` already puts the doc tab first; never degrade to a coarser focus verb.
3. **await.lock contention (C1):** a second concurrent `await` refuses and exits 2 naming the holder's PID (stricter than the earlier rank-0-only fallback; either is safe, the lead's final text governs).
4. **Acceptance criteria: new 14 (D16) and new 15 (D17)**; §12·6 restated measurably; §12·10 reworded; no renumbering of 1–13.
