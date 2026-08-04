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

## Reviewer verdicts — branch on the parsed enum, never on prose

Every verdict-carrying role (build-validator, code-reviewer, code-reviewer-deep — the roles the roster marks verdict_block: true) returns its verdict as a fenced json block under a ## Verdict heading: {"verdict": "pass | changes-needed | inconclusive", "findings": [{"severity": "critical | warning | suggestion", "file": "<path>", "line": 123, "summary": "<one line>"}]}. scripts/cmux/return-lint.mjs enforces presence/parse/enum on every cmux return: a missing, duplicated, unparseable or off-schema block is a rejected return, however good the prose is. Read the parsed block and branch on it — the prose is evidence for you, never the decision.

Agent-tool mode has no envelope and no lint. There, a subagent reviewer leads with 'VERDICT: pass | changes-needed' (its own definition requires it). Read that first line as the enum by literal token match — anything absent, hedged, or spelled otherwise is inconclusive and takes the re-run path below. That token is the only prose the gate ever reads.

Severity -> the three bands (table): critical -> Must-fix -> Blocks (bounce to the coder, or escalate per the ladder; one anywhere in findings[] is enough, whatever the top-level verdict says); warning -> Should-fix -> does not block, route into the task summary, fix now if cheap else carry forward; suggestion -> Consider -> informational, pass with notes, never spawn a window to re-litigate one. A verdict:pass carrying a critical finding is a contradiction, not a pass — severity wins and the gate blocks.

inconclusive is never a pass, and neither is a missing verdict. Treat identically: verdict:inconclusive; no ## Verdict section; zero/several/unparseable/off-schema fenced blocks; an agent-tool reviewer with no verdict token. Re-run the same reviewer scoped to the diff — same role, same acceptance criteria, no widened brief. Bounded at 2 re-runs (the bound orchestration.md already puts on amend->rebuild cycles); then stop and escalate to the user with the diff and every return so far. Never advance the phase on an inconclusive, never substitute your own reading of the review body for the verdict it failed to emit. One check before re-running in cmux mode: {"verdict":"inconclusive","findings":[]} is also exactly what the dispatcher writes for a blocked dispatch (return-lint.mjs writeBlockedReturn), whose body opens 'status: blocked - <reason>'. Fix the reason the dispatch died before spending an identical re-run on it.

Adversarial panel: the majority is counted, not judged. Pass = a strict majority of members whose verdict field is literally 'pass' — 3 reviewers -> 2. An inconclusive member (still inconclusive after its bounded re-runs) counts as a non-pass, never an abstention that shrinks the denominator. A critical finding from any single member blocks regardless of the count.

Reviewers report coverage-first — you are the filter. They surface every finding, including uncertain and low-severity ones, tagged with severity + confidence. Only critical blocks. Don't ask for a narrower report; filter it here.

## The human patch view (cmux diff)

When you want eyes on the actual patch at the gate, open it: cmux diff [<patch-file>|-] [--source unstaged|staged|branch|last-turn] [--workspace <id>] [--surface <id>]. It is orchestrator-invoked from the interactive session — a human-facing surface, not a worker capability — so it needs no CMUX_ALLOWS entry (that constant stays the frozen two-element allow list in scripts/cmux/contract.mjs; widening it is a permission change, not a convenience). It is a viewer, not a verdict: it never substitutes for a reviewer's parsed block.
