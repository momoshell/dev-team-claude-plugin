---
name: crew-onboard
description: >-
  Load when installing this plugin somewhere new or calibrating a checkout for
  lean crew lanes.
---

# Onboarding a checkout

The knowledge skills work in any repo once the plugin is installed. Lean lanes
also require a calibrated git checkout.

`commands/onboard.md` names this skill; the procedure lives here.

## Installing

```
/plugin marketplace add momoshell/dev-team-claude-plugin
/plugin install dev-team@dev-team
```

For runtime requirements, see the [README Install section](../../README.md#install).
If you only want the skills, stop here.

## Choosing seat models

Put a partial role map in `~/.crew/agents.json` for personal defaults or
`<checkout>/.crew/agents.json` for a project. For example:

```json
{ "planner": { "model": "anthropic/my-model" } }
```

The project wins over personal values. Use `agent`, `model`, `effort`, `advisor`,
`wait_s` or per-name `tiers` entries only; tier entries can be null to unseat a role.
Like `effort`, `wait_s` can be set on a role or tier, with the tier taking precedence.
A named tier entry replaces its lower-layer run fields rather than deep-merging
those fields; the definition's non-run fields remain.

`wait_s` is a positive safe integer in seconds. Unset, it uses the seat definition's
limit or 2400 seconds. Start validates the files and freezes effective run fields
for every tier, including fallback wait limits, for the lane and its finish passes.
Later override or plugin-default edits affect only new lanes.

After an `acp-seat-deadline` cut, the one rerun gets the original prompt plus a note:
the previous attempt was cut after its effective limit without a return, partial
changes remain in the worktree, a long-running command may have been killed, and
the seat must return before the limit. Other turn errors keep the prompt unchanged;
a second cut stops `seat-unmeasured`.
See [ADR-060](../../docs/adr/adr-060-local-roster-overrides.md).

## Checking seat availability

`crew onboard --check` probes each distinct seat in the effective roster and
refuses to record onboarding if an agent refuses a cell. Run `crew onboard
--seats --checkout <dir>` after editing overrides to probe without calibrating
proof. Each cell is reported as available, unavailable with the refusal, or
unmeasured with a reason. `crew start` fetches `origin/<base>` and refuses if
the fetch fails; it does not probe seats. The probe is implemented in
`crew/seat-probe.mjs`.

## Onboarding a checkout for lean lanes

1. Pick the checkout's full suite command, such as `npm test`, and time it on a
   clean tree. If that measured cost is slow enough to matter and CI runs the
   full suite on every PR, propose a project-owned affected-only lane suite
   using [the affected-suite guide](references/affected-suite.md). Without that
   CI, keep the lane suite full. Get operator approval before onboarding the
   chosen command. Commands are split on whitespace without a shell; quotes,
   backslashes, pipes and shell operators cannot be used as shell syntax.
2. Write a draft JSON file outside the checkout. Set `suite` to that command and
   `proof` to an array of runner entries. Node's built-in test runner is the
   default for JavaScript tests, so use `proof: []` if it covers all proof tests.
   Optionally set `suiteTimeoutMs` to a safe integer from 1 to `2**31-1` ms;
   if absent, the suite timeout is `SUITE_TIMEOUT_DEFAULT_MS` (`crew/onboard.mjs`).
   Optionally set boolean `suiteLock: true` to queue project suites across this
   checkout's lane processes and worktrees using its shared Git common directory.
   Absent or false leaves the lock off unless the personal `suiteLock` is true.
   Non-boolean lock values are refused. Optionally set the project-only
   `suiteSlots` to an integer from 1 to 8 (default 1). It is
   validated even with the lock off, where it has no effect. A locked lane
   takes any free slot up to its count. Slot 1 keeps the old directory and
   records, so older runners still share it and cannot take higher slots.
   The lock covers only project suites, not proof, worktree setup, onboarding
   or builder checks. Lane concurrency does not change. Acquisition has a
   separate two-hour awake-time bound; `suiteTimeoutMs` starts after acquisition.
   The journal result's `suite_lock_wait_s` records total measured elapsed
   acquisition seconds, including suspension. `suite_lock_sleep_credited_s`
   records acquisition sleep credit separately from subprocess `sleep_credited_s`.
   Measured zero may be absent. If sampling is unavailable, acquisition credit
   is `null` with `suite_lock_sleep_credit_reason: 'clock-unavailable'`, and
   ordinary elapsed-time enforcement remains in effect. `suite_lock_slot` names
   the acquired slot. Bounded waiting stops unmeasured with `suite-lock-timeout`
   and `suite_lock_holders`, an observation for each eligible slot.
   `suite_lock_holder` still reports slot 1 on lock failures. Lock I/O or
   resolution failures stop with `suite-lock-unavailable`.
   Only proven-dead ownership is reclaimed, never by age; uncertain/unreadable
   holders stay unknown, and a surviving suite group prevents reclamation.
   To clear an unknown or wrongly live-judged holder, ensure no suite in any
   worktree is running or waiting, then remove `<git-common-dir>/crew-suite-lock/`
   to clear all slots. Resolve the common directory with `git rev-parse --git-common-dir`.
   Start snapshots the effective lock and project count for planning resumes,
   finish passes and publishing-rebase rechecks. Edits do not affect running
   lanes or require re-onboarding.
   Suite, proof (both sides, setup and listing), `fastChecks` and `worktreeSetup` commands
   receive `CREW_LANE`, the lane name, overriding an inherited value only in
   the child environment. A script can name per-lane services instead of
   queueing. This is separate from affected-package selection. Onboarding
   has no lane name to supply.
   Optionally set `environmentSignatures` to a list of non-blank strings such as
   `PoolTimedOut`. The loop matches each string verbatim as a literal substring
   in either stdout or stderr of an `exit-nonzero` red suite. A match allows one
   unchanged-tree re-run unless the host-sleep rule takes precedence. Pick a
   string that only an environment failure prints: a code failure that prints
   a declared signature on both attempts stops the lane and never reaches the
   builder. Omit the
   list or use `[]` to leave suite behavior unchanged. Onboarding validates and
   keeps the list without hashing it. Start snapshots it for the lane and its
   finish passes.
   Optionally set `protectedPaths` to add to the built-in paths that require
   judge review. Use literal repo-relative entries, not globs. For example,
   `["migrations/", "config/billing.toml"]` protects the entire migrations
   directory and only the billing file under config.
   An absent or empty list adds nothing. Onboarding validates and keeps the
   list without hashing it. Start snapshots it for the lane and its finish
   passes and planning resumes.
   Optionally set top-level `proofTimeoutMs` to a safe integer from 1 to
   `2**31-1` ms for every proof run; if absent, it defaults to
   `PROOF_TIMEOUT_DEFAULT_MS` (`crew/proof.mjs`). It is not set per runner entry.
   Optionally set `worktreeSetup` to a non-blank command, split on whitespace
   without a shell like proof `setup`. `crew start` runs it once in the new
   worktree before launch, with a 10-minute timeout. Failure or timeout is
   printed and journaled but does not stop the lane. Changed or untracked paths
   reported by git cause start to refuse; ignored paths are allowed. The proof
   also runs it once in its base worktree before any entry; a red setup there
   makes the proof unmeasured with `setup-failed`.
   Optionally set `builderChecks` to a list of non-empty, one-line commands,
   such as a lint or one package's tests. The builder runs them before returning
   and reports each result in `notes`; the loop does not run them or read results.
   Use `fastChecks` instead for cheap checks the loop should run itself. Set it
   to a list of nonblank, NUL-free commands; omit it or use an empty list to
   skip the stage. Onboarding validates and keeps the fields. Start snapshots
   them for the lane and its finish passes. The loop runs the commands in order
   in the lane worktree after a builder turn, the path and symlink check, and
   any first-round base refresh, before per-test proof. This includes lanes
   that require no proof tests. Of the publishing rechecks, only lock-file
   rechecks run fast checks, after proof. A lock-file recheck runs fast checks on
   the clean, committed rebased head, so a command that scopes itself to the
   change must run everything on a clean tree. Unchanged-tree proof re-runs do not
   repeat fast checks. Commands split on whitespace without a shell and do not take
   the suite lock. Each gets 120 seconds by default. Set `fastChecksTimeoutMs`
   to a safe integer from 1 to `2**31-1` to override the deadline in milliseconds.
   Each attempt writes a `fast-check` check row with the command, status, reason
   and elapsed seconds. After a builder turn, a green list continues to proof.
   A nonzero exit skips the rest of the list, proof, review and suite on that tree, and returns the
   command and bounded output to the builder as one must-fix item, spending
   rounds like a red proof. A timeout or other unmeasured command skips the
   rest of the list but continues to proof. Fast checks do not replace the
   initial suite. A lock-file recheck can skip the second suite only if all
   commands pass without changing the Git worktree or `HEAD`. See
   [ADR-054 §1](../../docs/adr/adr-054-each-tier-runs-its-own-loop.md#1-the-rule)
   for the measured cost of finding cheap failures in the suite.
3. For each other runner, add `match` (a file glob), optional `setup`, `run`, and
   `calibrate`. The latter holds `file` (a literal relative path matched first
   by this entry), `text` (the throwaway test source), and distinct `pass` and
   `fail` test titles. The source must contain a passing test and a test that
   fails in its own body. The runner must write JUnit XML to `{report}`. Its
   command can use `{file}`, `{title}`, `{report}` and `{stem}` as substitutions.
   Optionally set `manifest` to a bare file name such as `Cargo.toml`. If the
   nearest manifest above a test in the build is absent from the old-source
   commit, the new package's own test is proven by a green build report alone
   (`base-package-absent`), without a red side. Optionally set `newTestFile: true`
   to let a test file absent from the old-source commit prove on a green build
   report when the old-source run writes no report (`base-test-absent`). Both
   exceptions are weaker evidence: a vacuous test can pass. Setup and run
   commands are whitespace-split without a shell. For example:

   ```json
   {
     "suite": "npm test",
     "proof": [{
       "match": "probe/**",
       "run": "node --test --test-reporter=junit --test-reporter-destination={report} {file}",
       "calibrate": {
         "file": "probe/calibrate.mjs",
         "text": "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('passes', () => {})\ntest('fails', () => assert.fail())\n",
         "pass": "passes",
         "fail": "fails"
       }
     }]
   }
   ```

4. Run `crew onboard --check <draft.json> --checkout <dir>`. It runs each probe
   in a scratch worktree and writes `.crew/project.json` only when the passing
   title reads green and the failing title reads red by JUnit `<failure>`.
   Correct any reported failure and retry. No probe is left in the checkout.
5. Commit `.crew/project.json` on the base branch named by `origin/HEAD` and push
   it before starting a lane. `crew start` reads onboarding from the fetched
   `origin/<base>`, so a local commit is not enough. The checkout and base must
   have matching onboarding; proof reads runner entries from the lane's
   old-source worktree. Re-run
   onboarding after changing the suite, proof entries or `worktreeSetup`. Changing only
   `suiteLock`, `suiteSlots`, `suiteTimeoutMs`, `proofTimeoutMs`, `builderChecks`,
   `fastChecks`, `fastChecksTimeoutMs`, `environmentSignatures` or `protectedPaths`
   in `.crew/project.json` does not require re-onboarding.
   Write a brief with
   `skills/lane-brief/SKILL.md`, then run `crew start <brief>` in the checkout.
   The start checks the base.

`crew` on `PATH` is a launcher you set up; installing the plugin does not add
one. Without it, run `node <dev-team clone>/bin/crew.mjs` with the same verbs.
