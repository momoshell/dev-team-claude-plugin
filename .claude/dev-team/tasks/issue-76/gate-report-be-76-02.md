# QA gate — be-76-02 — round 1

**Scope compliance:** clean. `git diff --name-only HEAD -- README.md references/cmux-dispatch.md commands/team.md test/cmux-dispatch-doc.test.mjs test/commands.test.mjs` matches `files_in_scope` exactly; `commands/onboard.md` confirmed untouched per the spec's explicit decision.

**Inline validation re-verify:** `node --test test/cmux-dispatch-doc.test.mjs test/commands.test.mjs test/orchestration.test.mjs` — 77/77 pass.

**Reviewer:** `dev-team:code-reviewer` (standard depth, doc-truth lens — no auth/secrets/migration/infra surface).

## Finding

Reviewer returned `changes-needed` with one finding labelled `critical`: README's Execution mode paragraph claimed `status` (not just `preflight`) reports `execution_mode: null`/`mode_source: "unresolved"` on a parse failure — verified false by reading `statusCmd` directly (it never touches `execution_mode`/`mode_source` at all; only `preflightCmd` does). Re-categorization: this doesn't match any of `references/qa-gate.md`'s closed critical-issue-classes (auth bypass, cross-tenant access, RCE, injection, prod-secret exposure, destructive data loss, unsafe migration rollback, payment/PII leakage) — it's a doc-truth `should-fix` at most, not a gate-blocking critical. No drop/escalation was needed because the finding was accepted and fixed directly rather than dismissed — the "critical must escalate, never silently drop" rule governs dismissal, not acceptance-and-fix.

**Fix:** orchestrator corrected the README sentence directly (`README.md`, the Execution-mode paragraph) — `status` now correctly described as not touching `execution_mode` at all; `preflight` alone reports the diagnostic and its `unresolved` degrade. Re-verified: 77/77 still pass (README carries no test pins by design, per the spec's own constraint).

**be-76-02 is gate-clean.**
