import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readOnlyHookDecision } from './claude-readonly.mjs'

const hookPath = new URL('./claude-readonly.mjs', import.meta.url).pathname
const payload = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
const on = { CREW_READ_ONLY: '1' }

test('allowed commands and disabled seats produce no decision', () => {
  assert.equal(readOnlyHookDecision(payload('git status && git diff'), on), undefined)
  assert.equal(readOnlyHookDecision(payload('git push'), { CREW_READ_ONLY: '0' }), undefined)
  assert.equal(readOnlyHookDecision({ tool_name: 'Read', tool_input: {} }, on), undefined)
})

test('a refused command is denied with the first offending segment', () => {
  const out = readOnlyHookDecision(payload('git status && git reset --hard && rm -rf x'), on).hookSpecificOutput
  assert.equal(out.permissionDecision, 'deny')
  assert.ok(out.permissionDecisionReason.includes('git reset --hard'))
  assert.ok(!out.permissionDecisionReason.includes('rm -rf x'))
})

test('malformed input fails closed', () => {
  for (const bad of ['not json', '[]', { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 4 } }, { tool_input: {} }])
    assert.equal(readOnlyHookDecision(bad, on).hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(bad))
})

test('the settings hook runs the script through the launch env', () => {
  const settings = JSON.parse(readFileSync(new URL('./claude-usage.settings.json', import.meta.url), 'utf8'))
  const hook = settings.hooks.PreToolUse.filter((e) => e.matcher === 'Bash').flatMap((e) => e.hooks).find((h) => h.command.includes('CREW_READ_ONLY_HOOK'))
  const run = (flag, command) => spawnSync('/bin/sh', ['-c', hook.command], {
    input: JSON.stringify(payload(command)), encoding: 'utf8',
    env: { ...process.env, CREW_READ_ONLY: flag, CREW_READ_ONLY_NODE: process.execPath, CREW_READ_ONLY_HOOK: hookPath },
  })
  assert.equal(run('1', 'git status && git push').status, 0)
  assert.ok(JSON.parse(run('1', 'git status && git push').stdout).hookSpecificOutput.permissionDecisionReason.includes('git push'))
  assert.equal(run('1', 'git status && git diff').stdout, '')
  assert.equal(run('0', 'git push').stdout, '')
})
