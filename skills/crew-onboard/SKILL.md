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

The project wins over personal values. Use `agent`, `model`, `effort`, `advisor`
or per-name `tiers` entries only; tier entries can be null to unseat a role.
Start validates the files and records them for the lane. A later edit affects
only new lanes. See [ADR-060](../../docs/adr/adr-060-local-roster-overrides.md).

## Checking seat availability

`crew onboard --check` probes each distinct seat in the effective roster and
refuses to record onboarding if an agent refuses a cell. Run `crew onboard
--seats --checkout <dir>` after editing overrides to probe without calibrating
proof. Each cell is reported as available, unavailable with the refusal, or
unmeasured with a reason. `crew start` stays offline and does not probe seats.
The probe is implemented in `crew/seat-probe.mjs`.

## Onboarding a checkout for lean lanes

1. Pick the checkout's suite command, such as `npm test`, and run it on a clean
   tree. Commands are split on whitespace without a shell; quotes, backslashes,
   pipes and shell operators cannot be used as shell syntax.
2. Write a draft JSON file outside the checkout. Set `suite` to that command and
   `proof` to an array of runner entries. Node's built-in test runner is the
   default for JavaScript tests, so use `proof: []` if it covers all proof tests.
   Optionally set `suiteTimeoutMs` to a safe integer from 1 to `2**31-1` ms;
   if absent, the suite timeout is `SUITE_TIMEOUT_DEFAULT_MS` (`crew/onboard.mjs`).
   Optionally set top-level `proofTimeoutMs` to a safe integer from 1 to
   `2**31-1` ms for every proof run; if absent, it defaults to
   `PROOF_TIMEOUT_DEFAULT_MS` (`crew/proof.mjs`). It is not set per runner entry.
3. For each other runner, add `match` (a file glob), optional `setup`, `run`, and
   `calibrate`. The latter holds `file` (a literal relative path matched first
   by this entry), `text` (the throwaway test source), and distinct `pass` and
   `fail` test titles. The source must contain a passing test and a test that
   fails in its own body. The runner must write JUnit XML to `{report}`. Its
   command can use `{file}`, `{title}`, `{report}` and `{stem}` as substitutions.
   Setup and run commands are whitespace-split without a shell. For example:

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
5. Commit `.crew/project.json` on the local base branch selected by `origin/HEAD`
   before starting a lane. The checkout and base must have matching onboarding;
   proof reads runner entries from the lane's old-source worktree. Re-run
   onboarding after changing the suite or proof entries. Changing only
   `suiteTimeoutMs` or `proofTimeoutMs` in `.crew/project.json` does not require
   re-onboarding.
   Write a brief with
   `skills/lane-brief/SKILL.md`, then run `crew start <brief>` in the checkout.
   The start checks the base.

`crew` on `PATH` is a launcher you set up; installing the plugin does not add
one. Without it, run `node <dev-team clone>/bin/crew.mjs` with the same verbs.
