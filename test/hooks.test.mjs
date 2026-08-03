import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'

const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
const sessionStart = hooksJson.hooks.SessionStart
const orchestrationCommand = sessionStart[0].hooks[0].command
const clearCommand = sessionStart[1].hooks[0].command

test('hooks.json has the two expected SessionStart entries in order', () => {
  assert.equal(sessionStart.length, 2)
  assert.equal(sessionStart[0].matcher, undefined)
  assert.equal(sessionStart[1].matcher, 'clear')
})

test('the orchestration command starts with the DEVTEAM_WORKER guard', () => {
  assert.ok(
    orchestrationCommand.startsWith('if [ -n "${DEVTEAM_WORKER:-}" ]; then'),
    'command must lead with the DEVTEAM_WORKER guard'
  )
})

test('the guard emits the exact suppression systemMessage literal', () => {
  assert.ok(
    orchestrationCommand.includes(
      "printf '%s\\n' '{\"systemMessage\":\"dev-team orchestration suppressed: DEVTEAM_WORKER=1\"}'"
    ),
    'command must contain the exact systemMessage printf literal'
  )
})

test('the guard exits 0 before falling through to the jq check', () => {
  assert.ok(
    orchestrationCommand.includes('exit 0; fi; command -v jq'),
    'guard must exit 0 and then fall through to the existing jq-availability check'
  )
})

test('the jq-missing degradation message and exit code are preserved', () => {
  assert.ok(
    orchestrationCommand.includes(
      "dev-team: jq is required for the SessionStart hook (brew install jq / apt install jq) — orchestration.md was not loaded this session."
    ),
    'jq-missing message must be preserved verbatim'
  )
  assert.ok(
    orchestrationCommand.includes(">&2; exit 0; }"),
    'jq-missing path must still exit 0'
  )
})

test('the orchestration.md content is still loaded via --rawfile', () => {
  assert.ok(
    orchestrationCommand.includes('--rawfile content "${CLAUDE_PLUGIN_ROOT}/orchestration.md"'),
    'command must still load orchestration.md with --rawfile'
  )
})

test('the clear-matcher command is untouched and still writes the task-cost marker', () => {
  assert.ok(
    clearCommand.includes('$HOME/.claude/dev-team/task-cost'),
    'clear-matcher command must still write the task-cost marker'
  )
})

// Behavioral: actually run the command via sh, so a mutation that keeps the
// guarded substrings but reorders/breaks the control flow fails the tests.
function runOrchestrationCommand(envOverrides) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, ...envOverrides }
  return spawnSync('sh', ['-c', orchestrationCommand], { env, encoding: 'utf8' })
}

test('behavioral: DEVTEAM_WORKER=1 suppresses orchestration and prints only systemMessage', () => {
  const result = runOrchestrationCommand({ DEVTEAM_WORKER: '1' })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed, { systemMessage: 'dev-team orchestration suppressed: DEVTEAM_WORKER=1' })
  assert.ok(!('hookSpecificOutput' in parsed), 'suppressed output must not carry hookSpecificOutput')
})

test('behavioral: DEVTEAM_WORKER unset injects the full orchestration context', () => {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT }
  delete env.DEVTEAM_WORKER
  const result = spawnSync('sh', ['-c', orchestrationCommand], { env, encoding: 'utf8' })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Dev-Team Orchestration'))
})

test('behavioral: DEVTEAM_WORKER="" (empty) is not a worker marker and injects context', () => {
  const result = runOrchestrationCommand({ DEVTEAM_WORKER: '' })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Dev-Team Orchestration'))
})
