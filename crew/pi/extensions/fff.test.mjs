import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { createReadGate } from './readgate.ts'
import {
  FFF_HOOK_PATH, CLAUDE_SEAT_SETTINGS, fffHookDecision,
  acpLaunch as claudeAcpLaunch,
} from '../../adapters/adapter-claude.mjs'

const FFF_BIN = '/opt/homebrew/bin/fff-mcp'

// Explicit builder seat fixtures: the register resolver that used to supply these is gone.
const BUILDER_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash'
const BUILDER_DENY = 'Task,Agent,Workflow'
const NO_GRANT = { tools: [], extensions: [], agents: [], skills: [], advisor: false, mcp_servers: [] }

function hookCommand() {
  const settings = JSON.parse(readFileSync(CLAUDE_SEAT_SETTINGS, 'utf8'))
  return settings.hooks.PreToolUse[0].hooks[0].command
}

function runHook(command, env, payload) {
  return spawnSync('sh', ['-c', command], {
    input: `${JSON.stringify(payload)}\n`, encoding: 'utf8', env: { ...process.env, ...env },
  })
}

function fffGrant() {
  return {
    tools: [], extensions: [], agents: [], skills: [], advisor: false,
    mcp_servers: [{ name: 'fff', command: { bin: FFF_BIN, args: [] }, url: null }],
  }
}

// MUTATION: restore assertNoLocalProvider(configDir).
test('claude acpLaunch ignores configDir instead of refusing it', () => {
  const spec = { bin: '/abs/acp', claudeBin: '/abs/claude', cwd: '/tmp', role: 'builder', model: 'sonnet', promptFile: '/tmp/p', taskDir: '/tmp/task', grants: NO_GRANT }
  let launch
  assert.doesNotThrow(() => { launch = claudeAcpLaunch({ ...spec, configDir: '/legacy' }) })
  assert.deepEqual(launch, claudeAcpLaunch(spec))
})

test('A1 granted claude Bash search is refused with the fff replacement', () => {
  const { env } = claudeAcpLaunch({
    bin: '/abs/claude-agent-acp', claudeBin: '/abs/claude', cwd: '/tmp',
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md',
    tools: BUILDER_TOOLS, deny: `${BUILDER_DENY},Glob,Grep`, taskDir: '/tmp/crew-task',
    grants: fffGrant(),
  })
  const { CREW_FFF, CREW_FFF_NODE, CREW_FFF_HOOK } = env
  const environment = { CREW_FFF, CREW_FFF_NODE, CREW_FFF_HOOK }
  assert.equal(environment.CREW_FFF, '1')
  assert.equal(environment.CREW_FFF_NODE, process.execPath)
  assert.equal(environment.CREW_FFF_HOOK, FFF_HOOK_PATH)
  const result = runHook(hookCommand(), environment, {
    session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: '/tmp', permission_mode: 'default',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg needle' },
    tool_use_id: 'toolu_fff_a1', transcript_path: '/tmp/transcript.jsonl',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Refusing rg: use mcp__fff__grep instead.',
    },
  })
})

test('cd-prefixed grep, find and fd searches are refused by pi readgate and the claude hook alike', () => {
  const pi = createReadGate({ env: { CREW_FFF: '1' }, hasUnquotedPipe: () => false })
  for (const [command, replacement] of [
    ['cd src && grep -rn foo .', 'mcp__fff__grep'],
    ['cd src && find . -name x', 'mcp__fff__find_files'],
    ['cd src && fd x', 'mcp__fff__find_files'],
    ['cd /tmp/wt && grep -rn "needle" crew/', 'mcp__fff__grep'],
  ]) {
    const result = pi.onToolCall({ toolName: 'bash', input: { command } }, { cwd: '/tmp' })
    assert.equal(result?.block, true, command)
    assert.match(result.reason, new RegExp(replacement))
    const decision = fffHookDecision({ tool_name: 'Bash', tool_input: { command } }, { env: { CREW_FFF: '1' } })
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny', command)
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, new RegExp(replacement))
  }
  const command = 'cd src && grep foo && echo done'
  assert.equal(pi.onToolCall({ toolName: 'bash', input: { command } }, { cwd: '/tmp' }), undefined)
  assert.equal(fffHookDecision({ tool_name: 'Bash', tool_input: { command } }, { env: { CREW_FFF: '1' } }), undefined)
})
