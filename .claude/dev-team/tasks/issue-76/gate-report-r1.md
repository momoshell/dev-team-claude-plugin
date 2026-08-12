# QA gate — be-76-01 — round 1

**Scope compliance:** clean. `git diff --name-only HEAD` shows `scripts/cmux/dispatch.mjs`, `test/cmux-dispatch.test.mjs` (both `files_in_scope`), plus `.claude/dev-team/config.md` — that third file is the orchestrator's own pre-dispatch prerequisite edit (removing the tracked `execution_mode: cmux` line), not a coder touch; see resolution below.

**Inline validation re-verify (orchestrator, independent of coder self-report):**
- `node --test test/cmux-dispatch.test.mjs` — 392/392 pass
- `node --test test/cmux-preflight.test.mjs test/cmux-contract.test.mjs` — 187/187 pass

**Mechanical tier floor:** noise-filtered diff = 3 files changed, 323 insertions(+), 18 deletions(-) = 341 changed lines → floors at Deep review (>100 line threshold). Consistent with the spec's own semantic Deep trigger (authorization-gate input-set change).

**Reviewer bundle:** `dev-team:code-reviewer-deep` + `dev-team:test-engineer`, parallel, both opus/sonnet per role default.

## Consolidated findings

`consolidated 10 findings from 2 members (2 of 2 supplied structured findings) -> 9 (0 merged, 1 escalated-not-dropped, 0 re-categorized); 1 critical escalated to user, 0 critical dropped`

1. **CRITICAL (escalated to user, not dropped, not bounced to coder)** — `.claude/dev-team/config.md:3`, code-reviewer-deep: flagged the removed `execution_mode: cmux` line as an out-of-scope, unauthorized revert of commit `98e461e` that leaves every mutating verb refusing. **Resolution:** this is the orchestrator's own deliberate, user-approved prerequisite step (stated to the user before dispatch: "remove the config.md line and dispatch be-76-01" → user: "Yes, go ahead"), and it is exactly the spec's `discovery_context` premise ("PREREQUISITE ALREADY DONE BY THE ORCHESTRATOR... this is expected and correct, do not add one back") — not a coder scope violation, and not accidental: removing this line from the tracked checkout is issue #76's entire point. Per `references/qa-gate.md` a critical may never be silently dropped even when a drop condition is met, so this is escalated to the user rather than resolved unilaterally, alongside the orchestrator's completion of the follow-through the user already approved: `~/.claude/dev-team/config.md` created with `execution_mode: cmux`, live-verified to resolve `{mode:'cmux', source:'home'}` via `resolveExecutionMode`.

2. **Should-fix, corroborated by both reviewers independently** (code-reviewer-deep `test/cmux-dispatch.test.mjs:2838` + test-engineer `:2810`, empirically mutation-proven by test-engineer) — `resolveExecutionMode`'s `source: 'project'` diagnostic value is never directly asserted; a mutation swapping it for `'home'` passes all tests. `MODE_SOURCES` drift guard doesn't constrain the producer (bare string literals, not sourced from the frozen enum).

3. **Should-fix, corroborated by both reviewers independently** (code-reviewer-deep `:2820` + test-engineer `:2778`) — the D2 non-layering test calls `readCmuxEnvFile`/`readEnvFileKeys`/`readCmuxPreviewUrl` directly with hardcoded project-only text; it never exercises a real call site with a home file present, so it wouldn't catch a future call-site regression that started layering these keys.

4. **Should-fix** (test-engineer, empirically mutation-proven) — `test/cmux-dispatch.test.mjs:36`'s `HOME` pin has no test that actually depends on its effect; deleting it leaves all 15 `be-76` tests green (helpers derive their path from live `process.env.HOME` regardless of whether it's pinned). Its only real value — never touching a real developer's `~/.claude/dev-team/config.md`/`roster.json` during test runs — is unenforced by any assertion.

5. **Suggestion** — stale comment above `assertExecutionModeCmux` (`dispatch.mjs:864`) still describes the old single-`configText` parameter.
6. **Suggestion** — uncapped raw config-line text reaches the "unknown execution_mode value" error message (`dispatch.mjs:192`), now reachable from two files instead of one; sanitize-and-cap convention says cap it (~80 chars).
7. **Suggestion** — unused imports `EXECUTION_MODE_ALIASES`/`DEFAULT_EXECUTION_MODE` in the test file (`:43`).
8. **Suggestion** — the pinned `HOME` tmp dir isn't registered in the file's `after()` cleanup registry (TDZ blocks it at that position; move the registry earlier).

**Checked and clean (both reviewers):** the 6 core acceptance-criteria scenarios (positive/precedence/short-circuit/per-file-ambiguity/fence-blindness/default), frozen-export integrity, `readExecutionMode` byte-identical behavior, `mode_source` never reaching `preflight.json` on disk, no injection surface beyond the stated volume concern (#6), no TOCTOU, out-of-scope files (`cmuxctl.mjs`/`contract.mjs`/`resolve.mjs`/schemas) untouched.

## Disposition

Findings 2–4 (should-fix) + 5–8 (suggestions, cheap, batched in) bounced to the coder for a round-2 fix pass. Finding 1 (critical) escalated to the user in the same turn; already substantively resolved by the orchestrator's own follow-through (home config created and live-verified) pending user confirmation.

## Round 2 — fix pass on should-fix + suggestions

All 3 should-fix findings (both corroborated by 2 independent reviewers) + 4 suggestions fixed: `MODE_SOURCES`-sourced diagnostic (not bare literals) + direct `source:'project'` assertion; D2 non-layering test rewritten to exercise real call sites (`workspaceCmd`/`dispatchCmd`) instead of hardcoded-text pure-function calls; `HOME` pin given a `REAL_HOME`/`os.homedir()` canary; stale comment, 80-char cap on the unknown-value error message, unused imports, `after()` cleanup registration for the HOME tmp dir. Scoped re-review (`code-reviewer-deep`): **pass**, 3 suggestion-level residuals, none blocking — one of which (finding 4: `main()` now resolves `execution_mode` for every verb, not just mutating ones) the orchestrator independently confirmed was a real regression via direct code diff against `HEAD`, not merely a residual note.

## Round 3 — fix for the read-only-verb regression

Gated `main()`'s resolve+assert on `MUTATING_VERBS.has(verb)`, restoring the pre-task laziness for `status`/`preflight` (stronger than pre-#76, in fact — the parse is never entered at all now, vs. eagerly parsed-then-discarded before). Coder independently found and fixed a second instance of the same bug class: `preflightCmd`'s own diagnostic `resolveExecutionMode` call also threw on an ambiguous config even after the `main()` fix — degraded to fail-soft (`{mode: null, source: 'unresolved'}`) instead. Added 2 regression tests (ambiguous project config, ambiguous home config) proving both fixes. Scoped re-review: **pass**, should-fix (silent catch, no diagnostic log) + suggestion (`'unresolved'` outside the frozen `MODE_SOURCES` enum, unpinned by a test) — both closed directly by the orchestrator (named `MODE_SOURCE_UNRESOLVED` constant + `log()` call in the catch + 2 new assertions pinning the degrade shape), not bounced to a 4th coder round.

## Final state

`node --test test/cmux-dispatch.test.mjs test/cmux-preflight.test.mjs test/cmux-contract.test.mjs` — 584/584 pass, independently re-verified by the orchestrator after every round including the final direct edits.

**be-76-01 is gate-clean.** Outstanding: the round-1 critical (`.claude/dev-team/config.md`) escalated to the user — orchestrator's read is it's resolved as designed (home config created, live-verified); awaiting explicit user confirmation before folding into the ship summary.
