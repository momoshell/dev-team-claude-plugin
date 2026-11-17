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
   Absent or false disables it; other values are refused. It covers start,
   finish and publishing-rebase suite rechecks, not proof, worktree setup,
   onboarding or builder checks. Lane concurrency does not change. Acquisition
   has a separate two-hour bound; `suiteTimeoutMs` starts after acquisition.
   The journal result records `suite_lock_wait_s`; bounded waiting stops
   unmeasured with `suite-lock-timeout` and `suite_lock_holder` diagnostics.
   Lock I/O or resolution failures stop with `suite-lock-unavailable`.
   Only proven-dead ownership is reclaimed, never by age; uncertain/unreadable
   holders stay unknown, and a surviving suite group prevents reclamation.
   To clear an unknown or wrongly live-judged holder, ensure no suite of the
   checkout is running or waiting, then remove `<git-common-dir>/crew-suite-lock/`.
   Resolve the common directory with `git rev-parse --git-common-dir`.
   Start captures the setting for the lane and its finish passes; editing it
   does not retrofit running lanes or require re-onboarding.
   Suite, proof (both sides, setup and listing) and `worktreeSetup` commands
   receive `CREW_LANE`, the lane name, overriding an inherited value only in
   the child environment. A script can name per-lane services instead of
   queueing. This is separate from affected-package selection. Onboarding
   has no lane name to supply. No unchanged-tree red-suite retry is added.
   Optionally set top-level `proofTimeoutMs` to a safe integer from 1 to
   `2**31-1` ms for every proof run; if absent, it defaults to
   `PROOF_TIMEOUT_DEFAULT_MS` (`crew/proof.mjs`). It is not set per runner entry.
   Optionally set `worktreeSetup` to a non-blank command, split on whitespace
   without a shell like proof `setup`. `crew start` runs it once in the new
   worktree before launch, with a 10-minute timeout. Failure or timeout is
   printed and journaled but does not stop the lane. Changed or untracked paths
   reported by git cause start to refuse; ignored paths are allowed.
   Optionally set `builderChecks` to a list of non-empty, one-line commands,
   such as a lint or one package's tests. The builder runs them before returning
   and reports each result in `notes`; the loop does not run them or read results.
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
   `suiteLock`, `suiteTimeoutMs`, `proofTimeoutMs` or `builderChecks` in `.crew/project.json` does not require
   re-onboarding.
   Write a brief with
   `skills/lane-brief/SKILL.md`, then run `crew start <brief>` in the checkout.
   The start checks the base.

`crew` on `PATH` is a launcher you set up; installing the plugin does not add
one. Without it, run `node <dev-team clone>/bin/crew.mjs` with the same verbs.
