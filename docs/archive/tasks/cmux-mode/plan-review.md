# Plan Review — cmux architecture amendment package

**VERDICT: REVISE** — the package's normative outputs (§5.3 argv, §7.2, §7.3, §8.2 Amendment 2, §13 criterion 8) now contradict the ratified mechanism and the recorded memory state; its own blocking criterion 3 (U2) is not just unanswered but in direct conflict with ADR-006; and the v3 argv block contains a literal shell-composition bug of exactly the class the package was written to eliminate.

The analysis in §3–§6 is strong and has been vindicated by evidence (the S9 false-negative diagnosis was proven correct by S22a; ADR-010's keystone S22e passed all three arms). The problem is not the reasoning — it's that the package cannot be posted to the epic #15 design record as written without creating a self-contradictory record. It needs a v2 pass, not a reviewer footnote.

> Orchestrator note (post-review): must-fix 1's verification half was already completed live before this review landed — the U2 probe (spike-findings.md, "U2 — RESOLVED BY LIVE TEST") confirmed G9 on-machine: a dontAsk worker with an exact-match `Edit(//abs/**)` allow rule is denied writing under `.claude/dev-team/tasks/`. The remaining half (ADR-006 amendment: relocate the task dir) is a contracts-slice design decision for the v2 pass.

---

## Must Fix

**1. U2 is a live conflict, not an open question — and it breaks the return-file contract for every dispatch.**
§5.3 (`TASK_DIR ... MUST NOT contain, or sit under, any protected directory name`) and §8.2 Amendment 1 disqualify `.claude`-rooted task dirs on G9. The TRD/ADR-006 location is `.claude/dev-team/tasks/<task-slug>/`. That is under `.claude`. If G9 holds, `Edit(//$TASK_DIR/returns/**)` grants nothing, the return file cannot be written, and ADR-003's rank-0 file watch has nothing to watch — on every dispatch, silently, with a "permission denied in dontAsk" message the worker will most likely narrate rather than escalate. The package raised U2 as a question about someone else's document and never checked it against the answer it already had in its own context digest.

Two things are needed, in order:
- **Verify G9 on-machine.** It is the only doc-only fact in §3 with a hard, non-negotiable design consequence and *no* spike item at all — and A15 explicitly says every doc-derived fact is build-specific until confirmed. One `dontAsk` launch with `--allowedTools "Edit(//<repo>/.claude/dev-team/tasks/x/returns/**)"` writing inside and outside settles it. Note G9's own `.claude/worktrees` carve-out proves the protection list has exceptions, so the outcome is not obvious. *(Orchestrator: done — confirmed, denial holds.)*
- **If G9 holds, ADR-006 must be amended** (relocate task dirs, or site only `returns/` + `signals/` outside `.claude/`), and that is a *contracts* change — it lands inside slice 1a, not after it. Worth noting: this repo's actual on-disk practice is a root-level `tasks/cmux-mode/`, not `.claude/dev-team/tasks/` — so the convention conflict predates the package.

**2. The §5.3 v3 shell block is broken as written.**

```sh
  $( [ -n "$CAP_SYSPROMPT_FILE" ] \
       && printf '%s %s' --append-system-prompt-file "$ROLE_PROMPT" \
       || printf '%s %s' --append-system-prompt "$(cat "$ROLE_PROMPT")" )
```

The outer `$( )` is unquoted, so its output is word-split and glob-expanded. In the fallback arm an entire prose role body collapses into N stray argv tokens (and any `*` in the body globs against cwd); in the primary arm any space in `$ROLE_PROMPT` splits the path. The package's stated purpose in §1 was that "the literal block cannot execute as written" — v3 reintroduces the same failure class. The fix direction is to state explicitly that **the argv is built as an array in the adapter and the doc block is illustrative only**, with the array-construction rule normative alongside hard rules 1–4. Add it as §5.3 hard rule 6 and as a §13 builder test.

**3. §5.3 still carries `--disallowedTools "Bash(cmux *)"`, which the user's directive removes.**
Per the directive and the live validation (spike-findings first addendum, Tests A/B), the merged argv is: **no cmux deny rule at all**, plus `"Bash(cmux notify *)"` and `"Bash(cmux wait-for -S *)"` in `--allowedTools`. The change-table row "No change to `--disallowedTools "Bash(cmux *)"` — the D9 amendment is satisfied **without** carving a hole here" is now false and must be replaced. S22f already ran the corrected shape end-to-end; the argv block should simply be brought in line with what was actually smoke-tested.

**4. The ratified mechanism reopens a containment hole the package's §7.3 closed by construction: token forgery.**
`Bash(cmux wait-for -S *)` wildcards the token. S24 proved the token namespace is **global across workspaces**. Therefore a worker can fire *any* token, including its own dispatch's **completion** token, or a sibling dispatch's. §7.3's hook design explicitly forbade this ("Identity ... comes from env, never from the file. A worker cannot address another dispatch's token"); the direct-Bash mechanism restores it, and neither the package nor the addenda notice. ADR-003's "attention wake is never completion evidence" amendment does *not* cover this — the worker isn't firing the attention token, it's firing the completion token.

Fix direction (orchestrator's call): make the completion token an unguessable per-dispatch nonce that never appears in the worker's env, kickoff, or role body, and require the parent to re-derive completion from the ladder on *every* wake regardless of which token released it. Add a §13 acceptance test: a dispatch that fires a plausible completion token without writing a return file must not be marked complete.

**5. Nothing validates or rate-limits the signal under the ratified mechanism, and two emitters may now fire at once.**
§7.3's contract (closed `level` enum, ≤200 chars, ≤5/dispatch, ≥30 s apart, shell-safe argv assembly) was enforced by the PostToolUse hook. With the worker issuing `cmux notify` directly, none of it is enforced: `level` becomes an unvalidated worker-authored field, notify text is unbounded worker-authored content going to the human's notification center, and there is no rate limit. Worse, if the hook is *also* retained as recorder/relay (S22e proved it works), every signal produces **two** notifications.

The merged design must pick one nudge emitter per role and say so:
- Bash roles: worker fires directly; the PostToolUse hook is **record-and-validate only**, never emits — and the schema/rate-limit becomes advisory (enforced at read time by the parent, not at write time).
- Bash-less judgment roles: hook is the sole emitter (§7.3 path, viable per S22e).

Otherwise say the hook is the only emitter for *all* roles — in which case the two `Bash(cmux …)` allows are dead grants and should be dropped.

**6. §13 acceptance criterion 8 is now false by design.**
"No worker profile can reach any cmux verb other than `wait-for -S` and `notify`, **and neither via a model-issued tool call**" — the ratified mechanism is *precisely* a model-issued tool call. Rewrite to the testable form: *no cmux verb other than these two is reachable, verified by attempting a third verb and asserting `is_error=true` in the transcript* (already demonstrated in Test A / S22f with `cmux ping`).

**7. §13 criterion 9's `git status --porcelain` post-condition will fire false positives and then hard-reset a worktree.**
Two defects. (a) Scope: the check is over the primary checkout, but if the task dir lives inside the primary checkout (it does, under either ADR-006 or root `tasks/`), then `returns/`, `signals/`, and `dispatch/*.json` are *legitimate* writes that appear in `git status --porcelain` on every single dispatch. The "outside `returns/`" carve-out is phrased relative to the task dir, not the repo. The remedy attached to a refusal is "hard worktree reset" — a destructive action on a guaranteed false positive. The check needs an explicit ignore set (task dir + `.gitignore` state) and the reset must be scoped to the worktree the worker actually owned, never to a checkout containing task artifacts. (b) Under-scoped to judgment roles: see must-fix 8.

**8. G13's subprocess gap is real but the package analyzed the wrong vector, and the post-condition doesn't cover it.**
Under the *old* broad-Bash model the escape was `node -e`. Under the ratified allow-only model, omission-denial kills `node -e` outright — but the executor profile still allows `Bash(npm run typecheck *)` and `Bash(npm test *)`, and those execute arbitrary repo-controlled scripts that can write anywhere. ADR-010's hook layer does **not** close this (hooks see tool calls, not what npm spawns), so the `git status` post-condition is the only control — and §8.2/§13.9 apply it only to *judgment-role* returns, i.e. to the roles that don't have `npm test`. Extend the post-condition to all roles (primary checkout must be clean for every dispatch; executors write in the worktree), or state the residual explicitly.

---

## Should Fix

**9. §3 citation audit — three doc-only facts with normative consequences and no spike coverage.** Per §13 criterion 1, this is the gap: **G9** (protected paths — see must-fix 1, now verified), **G11** (`--add-dir` loads `.claude/skills`/`agents` — drives the "task dir must contain no `.claude/` subdirectory" builder assertion), **G13** (rules don't reach subprocesses — the entire justification for ADR-010's layer D and for the §8.5 sandbox deferral). G11/G13 can be marked "doc-derived, unverified" rather than tested. Separately, the §3 table attributes everything to a blanket four-page doc list with no per-row citation — acceptable, but G5's exact read-only command membership is load-bearing (it's why "judgment roles keep Bash and rely on G5" is offered as a design option) and only `echo` is confirmed on-machine (S22e arm 2).

**10. `Glob(...)` in the §5.3 hard-rule-4 ban list is unsourced.** G1 names Write/NotebookEdit/MultiEdit; Glob appears only in the rule text and in §13 criterion 7. S22b tested `Write()` only. Either cite it or drop it — as written the builder will reject a rule form that may be legitimate.

**11. A12 is not fully verified as worded.** Test A confirmed `cmux notify` *executes* and emits a `notification.requested` socket event. "Reaches the human as a visible notification" is a GUI observation nobody made. For `blocked`/`question`, notify **is** the human channel, so this matters. One eyeball, zero cost. Also: `cmux notify *` wildcards notify's own flag surface — worth enumerating what those flags can do before granting the wildcard.

**12. A14 (prompt-dependence) got worse, not better, and nobody re-litigated it.** "Self-signal is prompt-dependent" was the architect-Q1 argument that killed D9's original carve-out. §7.3 sidestepped it by making a file write the trigger; the ratified mechanism restores full prompt-dependence. S22f is weak evidence (a haiku model explicitly instructed to run both verbs in a smoke test). This is acceptable — but the merged design must state that **the attention channel is best-effort and unreliable by construction; the file record and the completion ladder carry all guarantees**. ADR-003's amendment says attention ≠ completion; it does not say attention is not guaranteed to arrive.

**13. The §7.3 sequenced-token re-arm is not workable under the ratified mechanism — adopt the degraded form as the decision.** `devteam-<dispatch_id>-attn-<n>` where *n* is the signals-file line count now requires the *worker* to compute and format `n`. Latches persist (S5), so a worker firing `attn-7` while the parent awaits `attn-3` loses the live nudge entirely (recovered only at chunk timeout). The package's own fallback — fixed token, guaranteed live nudge for the first signal, everything else at next poll — should be promoted from fallback to the design. Also state where the token value reaches the worker: per ADR-009 it cannot be in the byte-stable role body, so it must ride the kickoff (or env, in which case the `Bash(cmux wait-for -S "$VAR")` matching form needs a test — G8 names variables as a documented fragility).

**14. ADR-010's framing needs re-scoping: feasibility strengthened, necessity weakened.** S22e proves hooks *can* be the guarantee (allow, deny-over-read-only-auto-allow, and PostToolUse all honored). But S22a + Test A prove the CLI layer *closes* — omission-denial is real containment and path scoping works. So "hooks are the guarantee, CLI flags are defense-in-depth" now mandates a hook process on every file-tool call (the §11 latency risk) to buy a guarantee whose only remaining justification, G13's subprocess gap, hooks don't close either. The coherent merged framing: **CLI permission rules are the primary enforcement layer; hooks enforce the invariants rules cannot express** — rule kinds the engine won't consult, signal recording/validation, the Stop gate, and relay for Bash-less roles. The subprocess gap stays open under both and is covered only by the `git status` post-condition. Recommend ADR-010 be re-titled and re-scoped rather than accepted as drafted; its memory note in `architecture-notes.md` is currently "proposed, blocked on S22e" — unblocked, but the decision itself changed.

**15. The judgment-role question resolves cleanly toward Bash-with-two-allows.** With omission-denial proven, a judgment role with `--tools "Read,Edit,Glob,Grep,Bash"` and exactly the two cmux allows gets: the built-in read-only set (`git log`, `git diff`, `grep` — genuinely useful for a reviewer) plus the signal path, and nothing else. That eliminates the hook-relay as a second enforcement path entirely and shrinks ADR-010's surface. The cost is that §5.3's variant note ("Bash dropped entirely") reverses. Your call, but the package's own reasoning in that note already points here, and it collapses two mechanisms into one.

**16. The user's "worker→orchestrator directly" ask was silently narrowed.** §7.3's `escalate_to` is "routing intent only — transport is always to the immediate dispatcher." The user's framing explicitly listed worker→orchestrator direct. Under the wildcard allow the worker *could* fire the orchestrator's token if given it. Either support it (two tokens in the kickoff) or flag the narrowing as a deviation — the package was scrupulous about flagging its §7.3 deviation and then didn't flag this one.

**17. Unowned work items with no phase, no owner, no acceptance criterion.**
- **U8** — "failure at task level" mechanical definition (§8.4). Not in the §10 phase table, not in §13. Now additionally depends on "a `blocked`-level signal that ends unresolved," a term defined only inside the demoted §7.3 contract and no longer validated by anything (must-fix 5).
- **U5** — ADR-010 numbering collision check against the epic's design record.
- **U3** — `Task` vs `Agent` rule-space naming. S22f passed with `--disallowedTools "Task"` present, which proves nothing about whether `--tools` omission alone closes subagent spawning. One cheap test; matters for both containment and cost.
- **`--disallowedTools "mcp__*"` effectiveness** — in the v3 argv and exercised in S22f, but S22f only asserted the turn completed, not that MCP tools were absent. Same for `--disable-slash-commands` actually disabling skills (S8 flagged the flag/description mismatch; the package resolved it on docs alone — and if it's wrong, G11's `.claude/skills` loading becomes live again).
- **Plugin-root resolution for the dispatcher.** §5.3 uses `$PLUGIN_ROOT/scripts/cmux/worker-plugin`, but `CLAUDE_PLUGIN_ROOT` is set for hook commands, not for arbitrary Bash-tool subprocesses. Today the orchestrator learns it only because `hooks/hooks.json` injects it into context. And per `conventions.md`, the marketplace cache path is **version-pinned** — a worker-plugin path baked into a persisted task artifact goes stale the moment the plugin version bumps mid-task. The package flags the `disableSideloadFlags` variant of this in §8.3 but not this one.

**18. Sections requiring rewrite before the package is posted to epic #15.** Listing them so nothing is missed: §4 findings 1/3/6 verdicts (all now resolved by S22g/S22a/S22e); §5.3 hard rule 5 and the capability-probe branch (keep as a fail-fast assertion, drop the dual-composition branch — the flag exists but is undocumented in `--help`, so it can vanish without notice); §5.3 change table rows for `--append-system-prompt-file` and `Bash(cmux *)`; §5.3 judgment-role variant (should-fix 15); **§7.2 in full** — its premise 1 is void, premise 2 (G8) now cuts the *opposite* way (allow-only fails closed), and only premise 3 survives; **§7.3** demoted to (a) the surviving `signals/` file contract and (b) the Bash-less-role relay; **§8.2 Amendment 2**, which currently reads "Workers remain denied `Bash(cmux *)` in full" and directly contradicts the ratified entry already recorded in `architecture-notes.md`; §10 phase table (slice 1a is **unblocked** — every named gate discharged); §11 risk rows 1–3 (discharged) plus the new risks from must-fix 4/5/7/8; §12 assumption table (A9/A10/A11 verified, A12 partial, U1 resolved, A15 upgradeable). The package's own memory-delta block also needs the same reconciliation before any of it is written.

---

## Artifact Fit

The artifact decision (§2) was right and remains right: ADR amendments + one new ADR + a TRD §5.3 patch + spike items, no PRD-lite, no second TRD. No ceremony added. The one adjustment: ADR-010 should be re-scoped (should-fix 14) rather than ratified as drafted, and ADR-006 now needs an amendment the package didn't anticipate (must-fix 1) — that's a fourth amended ADR, not a new document.

The recommended review route (`plan-reviewer` + `architect` second opinion) was correct at authoring time. Given that the mechanism it deviated on has since been decided by the user and validated live, the architect round-trip is now optional; a single reconciliation pass by architecture-lead against this review is the cheaper route.

## Execution Readiness

Slice 1a is genuinely unblocked on *platform* gates — S22a/b/c/e/f/g and S24 all passed with transcript or file evidence, which is unusually good discipline. It is **not** unblocked on *design* gates: must-fixes 1 (task-dir location), 4 (token identity), 5 (signal emitter and schema authority), and 7 (post-condition scope) are all contracts-slice decisions. Freezing 1a without them means freezing the return-path schema, the signal-record schema, and the argv builder's assertion set around unresolved questions.

Phase 1b's dispatcher inherits the re-arm design (should-fix 13) and the completion-token nonce (must-fix 4). Phase 1c is otherwise clear.

## Assumptions to Verify

- **G9** protected-path denial in `dontAsk` for a repo-relative `.claude/dev-team/…` path — one launch, blocking for 1a. *(Orchestrator: done — confirmed.)*
- **G11**, **G13** — doc-only, no test proposed; mark as unverified residuals rather than testing.
- **A12** human-visible notification — eyeball, free.
- **U3** `--tools` omission alone closes subagent spawning; **`mcp__*` deny** actually removes MCP tools; **`--disable-slash-commands`** actually disables skills — three assertions currently riding on S22f's "the turn completed."
- **A13/A14** (replace-vs-append quality; worker reliably issues the signal) — both still unverified inferences, both correctly deferred, but A14's status changed materially under the ratified mechanism and should be re-stated rather than carried forward unchanged.
