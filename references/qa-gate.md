# QA gate (read when a coder returns and you run the gate)

Spec-anchored: reviewers get the spec's `acceptance_criteria` + the diff and verify the contract. Each phase ends with this quality pass before the next.

## Deterministic validation runs inline, not as a window

The coder already ran the spec's `validation_commands` and reported `validation:` — you (the orchestrator) re-run them directly via Bash to confirm independently. Type-check, lint, build, and test execution are deterministic, so an orchestrator Bash call is cheaper than a subagent and just as independent of the coder's self-report. **These are the scoped `fast` lane, never the full suite** — the spec's `validation_commands` are scoped to `files_in_scope` (drawn from `config.validate.fast`), so both the coder's self-check and this inline re-verify stay in the seconds range even when the project's full suite runs for tens of minutes. **The full `config.validate.full` suite runs exactly once — at `/dev-team:ship`, not in this flow** — so a slow suite isn't paid per coder or twice per task; iteration gets fast/scoped signal + reviewers, and ship is the authoritative full-suite backstop before the PR.

**Don't spawn `dev-team:build-validator` for routine validation** — reserve it for validation that needs an isolated environment, or workflow mode (where the script can't run Bash itself, so it dispatches build-validator instead). There, "advisory" means *only when it returns no verdict* (a dead run doesn't block, since the coder already ran `validation_commands` and the reviewer checked the criteria) — a build-validator that *does* return and reports failure blocks the gate like any other check.

## Scope compliance is verified by git, not the coder's self-report

After a coder returns, diff the actually-touched files against the spec: `git status --porcelain` (or `git diff --name-only` since the pre-dispatch state; in the coder's worktree if isolated). Any touched file outside `files_in_scope` → treat as `changes-needed` and bounce to the coder to revert the out-of-scope edits (or, if the extra file was genuinely required, route back to the lead to amend the spec) — don't wait for a reviewer to maybe notice.

## Size the gate to risk — don't spawn a window that won't change the verdict

The review *depth* follows the ladder below; the *bundle* (how many windows) scales with risk:

- **Risk 0–1, no deep trigger:** a **single** `dev-team:code-reviewer`. Validation is inline (above). **Spawn `dev-team:test-engineer` only when the change adds or alters behavior not already covered** (or the spec's `acceptance_criteria` demand tests) — skip it for refactors, config, and docs where existing tests hold.
- **Deep trigger / risk ≥ 2:** `dev-team:code-reviewer-deep` **+** `dev-team:test-engineer` (negative + security coverage), in parallel.
- **Stacked risk (≥ 3 / multiple deep triggers):** the adversarial panel (below) + `dev-team:test-engineer`.

**Model scales with risk:** standard `dev-team:code-reviewer` on **sonnet**, `dev-team:code-reviewer-deep` + the adversarial panel on **opus**, `dev-team:build-validator` on **haiku**. Reserve opus reviewer windows for genuine risk — the standard sonnet reviewer covers risk 0–1.

## Review ladder (owned by `dev-team:qa-lead`)

- **Standard** `dev-team:code-reviewer` (risk 0–1) → **Deep** `dev-team:code-reviewer-deep` (any trigger / risk ≥ 2) → **Adversarial panel** on stacked risk (≥ 3 or multiple deep triggers): **3 reviewers** (odd, for a clean majority) with distinct lenses — correctness / security / rollback; pass = majority.
- **Deep triggers:** auth/authz, secrets, encryption, tokens, passwords, payments, PII; DB migrations / destructive ops; CI/CD, infra, prod access; public API/contract; security fix / incident / hotfix; **domain = devops** (workflow mode auto-escalates every devops task). Risk +1 each: multi-module, untested touched behavior, unclear rollback, complex control flow, cross-domain new feature.
- **Critical issue classes always block shipping when plausible:** auth bypass, cross-tenant data access, privilege escalation, remote code execution, injection with a reachable source→sink path, prod secret exposure, destructive data loss, unsafe migration rollback, or payment/PII leakage.

## Reviewer verdicts

**Reviewers lead with a one-line verdict (`pass` / `changes-needed`) so it survives a long or truncated review** — if a reviewer returns no verdict, treat it as inconclusive and re-run (scoped to the diff), don't assume pass.
