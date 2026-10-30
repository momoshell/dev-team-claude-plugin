# Plan: one measured-red suite re-run

## Minimal implementation
- Change only `crew/loop.mjs` and `crew/loop.test.mjs`. `runLoop` is called by `crew/lean.mjs`; no caller or `crew/checks.mjs` changes are needed. `runSuite` reports measured nonzero exits as red/exit-nonzero, and timeouts, signals and runner failures as unmeasured.
- Preserve the first `suite` result and append its existing `- Suite: ${suite.status}; exit ${suite.code}.` measurement before deciding whether to stop. Preserve the existing single-green path and body format.
- Add exactly one explicit retry branch, using the literal anchor `if (suite.status === 'red') {`. In that branch, bind the second checked result as `rerun`, using the same `stage('suite', ...)`, `callCheck('suite', ...)`, command validation, cwd, command, args and timeout precedence as the first call. Append a distinct `- Suite re-run: ${rerun.status}; exit ${rerun.code}.` measurement. Both measurements must reach the commit and PR body, in run order.
- If `rerun` is not green, stop with `stop(rerun.status === 'red' ? suite.reason : rerun.reason, rerun)`. Keep that exact conditional expression as the SR2 mutation anchor: a second red preserves the first reason; a second unmeasured result stops with its own reason. An initial non-red/non-green result stops immediately with its own reason. Do not loop or retry any other check/stage.
- Keep both suite invocations journaled through the existing seams. No changes to gate/mutation-proof stages, old runtimes, ACP, drive, crew or lean.

## Tests proving the change
- **SR1:** inject red then green (with a third red available to detect extra calls). Assert exactly two identical suite inputs, commit and publication occur only afterward, and the generated commit/PR measurements contain first red/nonzero and second green/zero in order. Keep green-first at one invocation with its existing body/stage assertions.
- **SR2:** inject two reds followed by green. Assert exactly two calls, stopped with the first reason, and no paths/commit/fetch/rebase/publish afterward. Include differing valid first/second reasons to detect accidentally returning the second reason.
- Cover initial unmeasured timeout, thrown runner and malformed green: one call, no commit. Cover red then timeout, thrown runner or malformed green: exactly two calls, unmeasured reason retained, no commit or third attempt.
- Update the existing red-suite stop/stage-journal test to expect two balanced suite stages, while preserving single-green stage order. Existing suite timeout override and body tests must remain valid; assert the override reaches both retry calls.
- Targeted validation for the builder: `node --test crew/loop.test.mjs`. The supplied standalone gate exercises production `runLoop` with entirely virtual dependencies. The loop owns baseline, post-build gate, mutation proof and full-suite execution; the planner has not run these stages.

## Kill-mutations (post-build anchors)
- **SR1**, `crew/loop.mjs`: replace `if (suite.status === 'red') {` with `if (false) {`. The red/green scenario must stop instead of committing.
- **SR2**, `crew/loop.mjs`: replace `rerun.status === 'red' ? suite.reason : rerun.reason` with `rerun.reason`. The distinct-reasons double-red scenario must return the wrong reason.

The literal anchors above are part of the implementation plan so the post-build declarations bind exactly once. The gate imports from its working directory, including mutation-proof copies, and writes no repository files.
