import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync as fsExists, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createReadGate } from './readgate.ts'
import {
  FFF_HOOK_PATH, PANE_USAGE_SETTINGS, capabilitiesFor as claudeCapabilitiesFor, fffHookDecision,
  headlessCommand as claudeHeadlessCommand, seatCommand as claudeSeatCommand,
} from '../../adapters/adapter-claude.mjs'
import { scratchDir } from '../../../test/helpers.mjs'

// Hermetic against the operator's router switch. The adapters default `env` to
// process.env, so a call that omits `env` resolves CREW_ROUTER_ATTEMPT_URL from the
// ambient environment — and before this line the suite went red whenever an operator
// exported it, which is exactly the configuration the router exists to serve (#1497).
// Every router test here passes the switch explicitly through `env`, so none relies on
// the ambient value. MUTATION: delete this line and run with the switch exported.
delete process.env.CREW_ROUTER_ATTEMPT_URL

const FFF_BIN = '/opt/homebrew/bin/fff-mcp'

// Explicit builder seat fixtures: the register resolver that used to supply these is gone.
const BUILDER_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash'
const BUILDER_DENY = 'Task,Agent,Workflow'
const NO_GRANT = { tools: [], extensions: [], agents: [], skills: [], advisor: false, mcp_servers: [] }

function paneFffEnvironment(command) {
  const read = (name) => command.match(new RegExp(`${name}="([^"]*)"`))?.[1]
  return { CREW_FFF: command.match(/\bCREW_FFF=([^\s]+)/)?.[1], CREW_FFF_NODE: read('CREW_FFF_NODE'), CREW_FFF_HOOK: read('CREW_FFF_HOOK') }
}

function hookCommand() {
  const settings = JSON.parse(readFileSync(PANE_USAGE_SETTINGS, 'utf8'))
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
  const command = claudeSeatCommand({
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md',
    tools: BUILDER_TOOLS, deny: `${BUILDER_DENY},Glob,Grep`, taskDir: '/tmp/crew-task',
    bootBrief: 'boot', grants: fffGrant(),
  })
  const environment = paneFffEnvironment(command)
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
    tools: BUILDER_TOOLS, deny: BUILDER_DENY, taskDir, bootBrief: 'boot',
    prompt: 'go', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bin: '/usr/local/bin/claude',
    grants: NO_GRANT,
  }
  const pane = claudeSeatCommand(base)
  const headless = claudeHeadlessCommand(base)
  assert.deepEqual(paneFffEnvironment(pane), { CREW_FFF: '0', CREW_FFF_NODE: '', CREW_FFF_HOOK: '' })
  assert.deepEqual(headless.env, {
    DEVTEAM_WORKER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir,
    CREW_FFF: '0', CREW_FFF_NODE: '', CREW_FFF_HOOK: '',
  })
  assert.deepEqual(headless.args.slice(headless.args.indexOf('--settings') - 2, headless.args.indexOf('--allowedTools')), ['--setting-sources', 'project', '--settings', PANE_USAGE_SETTINGS, '--tools', BUILDER_TOOLS])

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
    for (const environment of [paneFffEnvironment(pane), headless.env]) {
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

test('D1 claude fff grant refuses boot when its hook is absent', () => {
  const grants = fffGrant()
  const valid = JSON.parse(readFileSync(PANE_USAGE_SETTINGS, 'utf8'))
  const drifted = structuredClone(valid)
  drifted.hooks.PreToolUse[0].hooks[0].command += ' '
  const cases = [
    ['hook-less', { settings: { hooks: {} } }],
    ['empty', { settings: '' }],
    ['malformed', { settings: '{' }],
    ['unreadable', { readSettings: () => { throw new Error('EPERM') } }],
    ['command-drifted', { settings: drifted }],
  ]
  for (const [label, injected] of cases) {
    assert.throws(
      () => claudeCapabilitiesFor({ transport: 'pane', grants, ...injected }),
      (error) => error.reason === 'grant-unsupported', label,
    )
  }
  assert.doesNotThrow(() => claudeCapabilitiesFor({ transport: 'pane', grants, settings: valid }))
  let reads = 0
  assert.doesNotThrow(() => claudeCapabilitiesFor({
    transport: 'pane', grants: { tools: [], extensions: [], agents: [], skills: [], advisor: false, mcp_servers: [] },
    readSettings: () => { reads += 1; throw new Error('must not read') },
  }))
  assert.equal(reads, 0)
})
