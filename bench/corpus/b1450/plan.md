# Closed-pipe start logging

Subject: `fix(crew): keep start logging failures from changing exit status`

## Minimal implementation
1. Edit only `crew/start.mjs` and `crew/start.test.mjs`.
2. Make the default stdout logger best-effort: handle asynchronous stdout `error` events before writing, and catch synchronous write failures. Keep the error handler alive for delayed EPIPE after `main` resolves; install it idempotently, without repeated listeners or process exit/exitCode changes. Swallow output failures only, not validation, snapshot, git, or launch failures.
3. Guard calls through the injected logging seam as well, including a logger that throws `StartRefusal`. A printing failure must not escape `startLane`, or be misclassified as a pre-start refusal by `main`. Preserve log text, order, returned lane metadata, and existing effects.
4. Keep refusal handling in `main` intact. Retain its existing success `return 0` immediately before `catch (error)` and `return error.exitCode ?? 1` in the refusal branch: the gate's status mutations bind these unchanged anchors.
5. No edits to lane spawning, lean loop, CLI wrapper, other verbs, or enforcement files. No dependencies.

## Tests and acceptance
6. Add a top-level SE1 test in `crew/start.test.mjs`, with a `// MUTATION:` comment naming the successful-main-return status kill. Exercise public `main` in a child with the existing effects seam, but leave its logger at the real default. Record `spawnDetached` separately from stdout; do not launch a real lane or use git.
7. Parent closes the real stdout pipe immediately after seeing the first start line. Make the next worktree line larger than a pipe buffer (a fake long checkout path), so closure cannot lose a race to six tiny writes. Assert launch recorded, exit 0, no signal, and empty stderr. Bound child lifetime and clean resources; do not rely on shell pipeline status or sleep timing.
8. Add synchronous injected-logger coverage (ordinary Error/EIO and StartRefusal): successful launch, `main` returns 0, and `startLane` still returns its metadata. A try/catch alone cannot prove asynchronous EPIPE handling.
9. Add a top-level SE2 test with a `// MUTATION:` comment naming the refusal-return status kill: close stdout before invoking `main` with `--check --loop lean` and a malformed P1 brief (`tier: rigorous`). Assert a genuine validation diagnostic, nonzero normal exit, no stack trace, and no lane-launch marker. Do not merely check that a crashed child is nonzero.
10. Validation lane: `node --test crew/start.test.mjs`. The loop, not the planner, runs this suite and the gate at baseline, after build, and under each mutation.

## Gate and mutation contract
11. `gate.mjs` imports `crew/start.mjs` exclusively through each child's inherited `process.cwd()` and calls public `main` with all necessary fake effects. SE1 measures real pipe closure plus synchronous instrumentation errors; SE2 measures closed-stdout validation refusal independently.
12. SE1 kill: in `crew/start.mjs`, replace the unique literal `    return 0\n  } catch (error) {` with `    return 1\n  } catch (error) {`. This changes a started lane's status, which SE1 observes.
13. SE2 kill: in `crew/start.mjs`, replace `    return error.exitCode ?? 1` with `    return 0`. This hides the actual invalid-brief refusal, which SE2 observes.
14. Expected unchanged-tree result: FAIL SE1 because asynchronous EPIPE is unhandled (and synchronous logger errors escape or become refusals); SE2 already passes. No baseline/suite/build/mutation/commit/rebase/PR stages were run by this planner, as instructed.

## Direct inspection and builder arms
- Evidence: `crew/start.mjs:35-48` default logger; `crew/start.mjs:60-72` validation/check; `crew/start.mjs:118-125` launch then logging; `crew/start.mjs:129-152` status handling/entrypoint. `crew/start.test.mjs:35-61` effect seam and `crew/start.test.mjs:230-244` existing child-process check test.
- Caller evidence (scout located, planner read): `bin/crew.mjs:26-30` and `bin/crew.mjs:94-103` inherit stdout and propagate child status. No wrapper change is needed. `bin/crew.test.mjs:73-86` tests routing with fake entrypoints, not real logging.
- Scope/implementation citation: `/Users/momoshell/.crew/dt-b1450-start-log-never-throws/b1450-start-log-never-throws/task/plan.md:5-11`.
- Validation/gate citation: `/Users/momoshell/.crew/dt-b1450-start-log-never-throws/b1450-start-log-never-throws/task/plan.md:13-25`.
- files_in_scope: `["crew/start.mjs", "crew/start.test.mjs"]`
- validation_lane: `node --test crew/start.test.mjs`
- gate_cmd: `node /Users/momoshell/.crew/dt-b1450-start-log-never-throws/b1450-start-log-never-throws/task/gate.mjs`
