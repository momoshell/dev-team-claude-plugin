# Plan Review — Slice 1a contracts freeze (issue #2)

**VERDICT: REVISE** — the freeze is well-argued and mostly traceable, but it (a) leaves `build-validator` with no way to run a build, (b) closes the env set against two paths v2's worker-side hooks require, and (c) never publishes the complete field list that both coder slices and issues #3/#4 are supposed to build against.

**What holds up.** ~30 citations spot-checked. D-1/D-2/D-3 faithful to v2:169/v2:111/v2:174 and to ratified architecture-notes.md:8 (correctly listed as not-re-litigable, matching v2:399). D-6's `//`-is-rule-syntax-not-path-syntax correction is right. Section 1 rider B is correct and important. F-3's two-profile collapse is not an invention — v2:173-174 already defines exactly two role classes. Evidence upgrades (S25b :427, S25c :435) accurate.

## Must Fix

**1. [MUST-FIX] `build-validator` cannot run a build.** F-3 maps "all others → judgment", judgment's grant set is `returns_edit + signals_edit`. `build-validator`'s entire job is executing `node --test`, not in the built-in read-only Bash set. v2:174 enumerates judgment as "planner, reviewer, leads" — build-validator was never classified. Under R-B's closed enum, fixing later costs an enum value + schema_version bump, so decide in 1a. Self-contradiction: §3.4 routes this PR's own gate through dev-team:build-validator.

**2. [MUST-FIX] D-8's closed six-key env omits the paths v2's worker-side hooks need.** Drops `DEVTEAM_STATE_DIR` as "derivable," but the PostToolUse attestation hook writes `~/.dev-team/state/<task-slug>/<dispatch-id>.signal-log` (v2:225, v2:328) and hooks.json must be static (v2:420), so paths come from env. Deriving requires `task-slug`, produced by `slugify()` in JS (F-5), not POSIX sh. Contradicted by the same ruling's own justification for adding `DEVTEAM_DISPATCH_RECORD`. With additionalProperties:false + all-required, 1c cannot add a key without a schema change. Related: the gate-block counter is classified "parent-internal", but the Stop gate is a hook running in the worker's process tree — it crosses the trust boundary and belongs in the freeze per the package's own governing principle.

**3. [MUST-FIX] Section 2 is a delta table, not a field list — but the plan treats it as the complete interface contract.** §3.2/§3.5 assume an enumeration that does not exist, while Section 4 item 3 declares issue #2's inline JSON superseded. Fields no ruling touches have no authoritative source: `task_id`, `agent`, `model`, `effort`, `surface.*`, `created_at`, `timeout_s`, `spec_path`, `return.kind`/`schema_path`, whether the record's composed `profile` carries `tools`, and whether `disallowed_tools` is top-level or inside `profile`. Publish a full property/required/type table per schema before dispatching be-1a-A.

**4. [MUST-FIX] `signals_path` is missing from the record.** v2:419 makes the signals-file path a mandatory kickoff literal alongside the return path; D-4b grants Edit on it; 1b's relay loop reads it. D-6's enumeration of filesystem-path fields omits it.

**5. [MUST-FIX] `surface` collides with D-11's immutability redefinition.** `surface.{workspace_id,pane_id,surface_id}` only exist after `cmux new-pane`, while the record must already exist at pane creation (path handed to worker via DEVTEAM_DISPATCH_RECORD). That is a second, non-terminal mutation. Either define a permitted pre-terminal "surface bind" transition or move `surface` to parent-side state. 1b cannot write the record writer without this ruling.

**6. [MUST-FIX] D-7 publishes every dispatch's attention tokens into a worker-readable file; residual unlisted.** attn_parent/attn_upstream become required record fields; records live at `<TASK_DIR>/dispatch/`, TASK_DIR is --add-dir'd, reads never prompt. Any worker can read every sibling dispatch's attention tokens (also via `kickoff` field). v2:274 asserts "No worker learns anything about its siblings"; v2:276 rests forgery resistance on dispatch_id being a UUID. Both become false. Blast radius bounded (one wasted parent loop), but apply the package's own "don't imply unforgeability" correction to itself, state the residual, and consider siting records parent-side with only a projected subset under TASK_DIR.

**7. [MUST-FIX] `slice_id` is unconstrained yet flows into permission-rule strings and filesystem paths.** F-1 calls it a "human label"; D-4b expands it into `Edit(//<TASK_DIR>/returns/<slice_id>.<attempt>.json)`. A slice_id containing `)`, space, `*`, or `..` breaks the rule string or escapes the directory — the threat class F-5 was created to close. Freeze a slice_id pattern in 1a. Same class: F-9's refusal charset bans `; | & $ < > \`` and newline but not `(`, `)`, or quotes, any of which can terminate or blur a `Bash(...)` rule.

**8. [MUST-FIX] E-1(c) has no implementation owner and no test.** "A reader encountering a higher schema_version refuses" is load-bearing, but contract.mjs's stated surface doesn't include it and A1–A10 never exercise it. Add to `validate()` and A3, or drop the claim.

**9. [MUST-FIX] F-8 requires a keyword the R-A budget bans.** "Non-empty string" needs `minLength` or `pattern`; the frozen budget has neither minLength nor maxLength. Also D-11, E-3a, F-2 all use union `type` arrays while the budget never says whether `type` may be an array — the validator author needs that spelled out, and the spec tells them to throw on anything outside the budget.

## Should Fix

**10. [MUST-FIX-if-not-deferred] F-2 rules nothing for markdown returns.** 7 of 12 roles return markdown, but two-step validation is defined only against `record.return.schema_path`. Markdown validation runs off the roster's `required_sections`, never added to the record. Second-order: a returns/*.json envelope wrapping a markdown string is not renderable in a doc_tab panel (ADR-004/S18) — the human's actual viewport for lead returns. Rule both, or explicitly defer with a named owner.

**11. [NICE-TO-HAVE] v2 hard-rule line citations off by one** (inherited from digest B): rule 6 is v2:111 not 112; rule 4 is v2:109 not 110; "no cmux deny/exactly two allows" acceptance is v2:561 not 559; Stop gate rank-3 is v2:356 not 355. Matters because §3.5 instructs coders to paste citations.

**12. [NICE-TO-HAVE] E-4 overstates enforcement.** schema.test.mjs only checks its 7 COND_KEYS — `contains`, `patternProperties`, `dependentRequired`, `$defs` are banned but not in COND_KEYS. Add a budget assertion or restate precisely.

**13. [NICE-TO-HAVE] E-2's precedence level 1 is dead, not gutted.** If roster.default.json supplies model+effort for all 12 roles, frontmatter can never win — A7's five-layer test can't observe level 1 unless the default roster deliberately omits a field. Say which, or collapse to four levels.

**14. [NICE-TO-HAVE] Slice A has no executable acceptance.** "roster.default.json matches Section 2 exactly" unverifiable until B ships the validator. Either move roster.default.json to B or give A a minimal shape test.

**15. [NICE-TO-HAVE] `resolveRole` has no caller in 1a** — freeze the signature in Section 2, ship the implementation with its first consumer (cheaper split). slugify and shouldArchive are justified (F-5, v2:435).

**16. [NICE-TO-HAVE] A9 self-contradictory:** "all 87 pre-existing tests unchanged" vs the plan's own edit to agents.test.mjs:7. Reword to "test count unchanged, no behavioral change."

**17. [NICE-TO-HAVE] A6 hard-codes a Phase-1 value:** `pane === true ⟺ role === 'coder'` contradicts "Phase 2 flips leads … one-line roster edits, no code change". Use a named constant.

## Artifact fit / execution readiness notes

- ADR-013 should not be posted as "proposed" until the profile taxonomy (build-validator) and record-siting/disclosure question are resolved — both change the ADR's text.
- A10's deferral list is missing: D-9's role_prompt_sha256 cross-dispatch stability test, D-12's worktree≠primary and task_dir-outside-checkout relations, D-11's atomic tmp+rename write, F-7's flags const:true. Each asserted in Section 2 with no test in any slice.
- F-4 assigns `execution_mode` to "the slice that wires the switch" — no such slice is named; #3 and #4 are both spoken for.

## New assumptions to add to Section 5

- Stop gate + PostToolUse hooks must parse DEVTEAM_DISPATCH_RECORD JSON from static POSIX sh → implies a `jq` dependency (v2:581 assumes it). Add it — D-8's new env key exists solely to enable that read.
- Sibling-record readability under --add-dir (finding 6). Verifiable free at 1c alongside S25f.
- The claim that widening returns_edit to `returns/**` on S25f failure is "one line in the builder, no schema change" holds only if the return-file name stays `<slice_id>.<attempt>.json`; confirm ladder clause (v) matching does not depend on the narrow grant.

**REVISE** — required before dispatch: findings 1–9 resolved in the package text (10 either resolved or explicitly deferred with an owner), then re-post Section 2 with a complete per-schema property table.

---

# Re-review (same reviewer, revision v2) — 2026-08-01

**VERDICT: APPROVE** — conditional on four text corrections (N1–N4), authorized for direct orchestrator application; no further review round-trip. All 10 blocking findings verified resolved in the text (not just the disposition table); pattern audit clean (ABS/SLICE/STEM/CMD/RULE/RELGLOB all compile and encode their rulings).

New findings, all applied to the package as v2.1:
- **N1 (MUST-FIX):** kickoff literal list omitted `dispatch_id` — after the parent-side record move the worker had no reliable channel for the value ladder clause (v) requires; every dispatch would fail. Fixed: `dispatch_id` added to the kickoff literals; D-9's static addendum carries the envelope shape.
- **N2 (MUST-FIX):** `worktree.path` underivable for roles with `created_by_dispatcher: false` (reviewers/validator inspect another slice's worktree). Fixed: `worktree.source_slice_id` added (SLICE|null, null iff created_by_dispatcher).
- **N3 (MUST-FIX):** R-A lacked a keyword-applicability rule for union types — a naive validator would reject the record's own `create` state (`surface: null` vs required sub-properties). Fixed: applicability line added to R-A.
- **N4 (MUST-FIX):** finding 10b's "no grant covers the doc-tab .md" guarantee was void under U-1's `returns/**` fallback. Fixed: fallback relocates the parent-rendered file to `render/<stem>.md`; third condition added to U-12.
- **N5–N9 (NICE-TO-HAVE, all folded):** A3 gains Write-rule/single-slash/malformed-ATTN negative cases; A5 names both message bounds (2000 write-time vs 200 relay-truncation); F-9 gains an explicit fail-closed refusal path + project-level-roster note for postcondition_ignore; task_artifacts_root charset-constrained; A10 ledger gains three obligations (postcondition branch, validate.full resolution, .gate file creation) and U-4's cmux-UUID inspection marked as blocking 1b's first record write.

Execution-readiness note: the A10 ledger puts eleven items on 1b — materially bigger than v2:485 anticipated; the backend-lead consult should happen before #3 is scoped.
