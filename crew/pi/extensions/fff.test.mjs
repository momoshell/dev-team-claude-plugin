import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync as fsExists, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createReadGate } from './readgate.ts'
import {
  FFF_HOOK_PATH, CLAUDE_SEAT_SETTINGS, fffHookDecision,
  acpLaunch as claudeAcpLaunch,
} from '../../adapters/adapter-claude.mjs'
import * as claude from '../../adapters/adapter-claude.mjs'
import { scratchDir } from '../../../test/helpers.mjs'

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

// MUTATION: restore the fff binary comparison in hasFffGrant.
test('claude acpLaunch arms fff tools and CREW_FFF for an fff grant at any binary path', () => {
  const grants = fffGrant()
  grants.mcp_servers[0].command.bin = '/usr/local/bin/fff-mcp'
  const launch = claudeAcpLaunch({ bin: '/abs/acp', claudeBin: '/abs/claude', cwd: '/tmp', role: 'builder', model: 'sonnet', promptFile: '/tmp/p', taskDir: '/tmp/task', grants })
  assert.equal(launch.env.CREW_FFF, '1')
  assert.equal(launch.env.CREW_FFF_NODE, process.execPath)
  assert.equal(launch.env.CREW_FFF_HOOK, FFF_HOOK_PATH)
  for (const tool of ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']) assert.ok(launch.sessionParams._meta.claudeCode.options.allowedTools.includes(tool))
})

// MUTATION: re-export claude modelString.
test('the claude adapter exports no modelString', () => {
  assert.equal(Object.hasOwn(claude, 'modelString'), false)
})

// MUTATION: restore assertNoLocalProvider(configDir).
test('claude acpLaunch ignores configDir instead of refusing it', () => {
  const spec = { bin: '/abs/acp', claudeBin: '/abs/claude', cwd: '/tmp', role: 'builder', model: 'sonnet', promptFile: '/tmp/p', taskDir: '/tmp/task', grants: NO_GRANT }
  let launch
  assert.doesNotThrow(() => { launch = claudeAcpLaunch({ ...spec, configDir: '/legacy' }) })
  assert.deepEqual(launch, claudeAcpLaunch(spec))
})

test('fff-E1-refuse', () => {
  const gate = createReadGate({ env: { CREW_FFF: '1' }, hasUnquotedPipe: () => false })
  for (const [program, recommendation] of [['grep', 'mcp__fff__grep'], ['rg', 'mcp__fff__grep'], ['find', 'mcp__fff__find_files'], ['fd', 'mcp__fff__find_files']]) {
    const result = gate.onToolCall({ toolName: 'bash', input: { command: `${program} needle` } }, { cwd: '/tmp' })
    assert.equal(result?.block, true, program)
    assert.match(result?.reason || '', new RegExp(recommendation), program)
  }
})

test('fff-E1-admit', () => {
  const gate = createReadGate({ env: {}, hasUnquotedPipe: () => false })
  for (const program of ['grep', 'rg', 'find', 'fd']) {
    assert.equal(gate.onToolCall({ toolName: 'bash', input: { command: `${program} needle` } }, { cwd: '/tmp' }), undefined, program)
  }
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

test('B1 ungranted claude Bash search remains untouched', () => {
  const taskDir = '/tmp/crew-task'
  const base = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md',
    tools: BUILDER_TOOLS, deny: BUILDER_DENY, taskDir,
    bin: '/abs/claude-agent-acp', claudeBin: '/abs/claude', cwd: '/tmp',
    grants: NO_GRANT,
  }
  const launch = claudeAcpLaunch(base)
  const { CREW_FFF, CREW_FFF_NODE, CREW_FFF_HOOK } = launch.env
  const fffEnv = { CREW_FFF, CREW_FFF_NODE, CREW_FFF_HOOK }
  assert.deepEqual(fffEnv, { CREW_FFF: '0', CREW_FFF_NODE: '', CREW_FFF_HOOK: '' })
  assert.equal(launch.sessionParams._meta.claudeCode.options.settings, CLAUDE_SEAT_SETTINGS)

  const root = scratchDir('fff-hostile-hook-')
  const marker = join(root, 'hostile-ran')
  const hostileNode = join(root, 'hostile-node')
  const hostileHook = join(root, 'hostile-hook')
  writeFileSync(hostileNode, `#!/bin/sh\nprintf ran > '${marker}'\n`)
  writeFileSync(hostileHook, `#!/bin/sh\nprintf ran > '${marker}'\n`)
  chmodSync(hostileNode, 0o755)
  chmodSync(hostileHook, 0o755)
  const hostile = { CREW_FFF: '1', CREW_FFF_NODE: hostileNode, CREW_FFF_HOOK: hostileHook }
  try {
    for (const environment of [fffEnv]) {
      const result = runHook(hookCommand(), { ...hostile, ...environment }, { tool_name: 'Bash', tool_input: { command: 'rg needle' } })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
      assert.equal(fsExists(marker), false)
    }
    assert.equal(fffHookDecision({}, { env: { ...hostile, CREW_FFF: '0' } }), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D1 direct and listed-wrapper search refusals remain enforced', () => {
  const cases = [
    ['git grep needle', 'mcp__fff__grep', 'mcp__fff__grep'],
    ['xargs grep needle', 'mcp__fff__grep', 'mcp__fff__grep'],
    ['env rg needle', 'mcp__fff__grep', 'mcp__fff__grep'],
    ['command find .', 'mcp__fff__find_files', 'mcp__fff__find_files'],
    ['cd src && rg needle', 'mcp__fff__grep', 'mcp__fff__grep'],
  ]
  const pi = createReadGate({ env: { CREW_FFF: '1' }, hasUnquotedPipe: () => false })
  for (const [command, piReplacement, claudeReplacement] of cases) {
    const result = pi.onToolCall({ toolName: 'bash', input: { command } }, { cwd: '/tmp' })
    assert.equal(result?.block, true, command)
    assert.match(result.reason, new RegExp(piReplacement), command)
    const decision = fffHookDecision({ tool_name: 'Bash', tool_input: { command } }, { env: { CREW_FFF: '1' } })
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny', command)
    assert.match(decision?.hookSpecificOutput?.permissionDecisionReason || '', new RegExp(claudeReplacement), command)
  }

  const root = scratchDir('fff-ungranted-shell-read-')
  const large = join(root, 'large.txt')
  writeFileSync(large, 'large\n'.repeat(351))
  try {
    const ungranted = createReadGate({ env: { CREW_FFF: '0' }, cwd: root, hasUnquotedPipe: () => false })
    const result = ungranted.onToolCall({ toolName: 'bash', input: { command: `cat '${large}'` } }, { cwd: root })
    assert.equal(result?.block, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

test('RV1-1 quoted and escaped direct fff searches remain withheld', () => {
  const cases = [
    ["'grep' needle", 'mcp__fff__grep', 'mcp__fff__grep'],
    ['"rg" needle', 'mcp__fff__grep', 'mcp__fff__grep'],
    [String.raw`g\rep needle`, 'mcp__fff__grep', 'mcp__fff__grep'],
    [String.raw`\grep needle`, 'mcp__fff__grep', 'mcp__fff__grep'],
    ["gr'ep' needle", 'mcp__fff__grep', 'mcp__fff__grep'],
    ['"find" .', 'mcp__fff__find_files', 'mcp__fff__find_files'],
    ["'fd' x", 'mcp__fff__find_files', 'mcp__fff__find_files'],
  ]
  const pi = createReadGate({ env: { CREW_FFF: '1' }, hasUnquotedPipe: () => false })
  for (const [command, piReplacement, claudeReplacement] of cases) {
    const result = pi.onToolCall({ toolName: 'bash', input: { command } }, { cwd: '/tmp' })
    assert.equal(result?.block, true, command)
    assert.match(result?.reason || '', new RegExp(piReplacement), command)
    const decision = fffHookDecision({ tool_name: 'Bash', tool_input: { command } }, { env: { CREW_FFF: '1' } })
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny', command)
    assert.match(decision?.hookSpecificOutput?.permissionDecisionReason || '', new RegExp(claudeReplacement), command)
  }
})
