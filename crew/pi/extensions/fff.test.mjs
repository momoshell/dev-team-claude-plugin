import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync as fsExists, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createReadGate } from './readgate.ts'
import {
  bootCmd, effectiveDeny, FFF_SEARCH_WITHHOLDINGS, FFF_SEARCH_WITHHOLDING_LIMITS,
  mcpConfigDocument, normalizeFffSearchWithholdingLimit, persistedAdapters, resolveAdapters, searchRecord, SEAT_DEFAULTS, slug,
} from '../../crew.mjs'
import { seatCommand as piSeatCommand } from '../../adapters/adapter-pi.mjs'
import {
  acpLaunch as claudeAcpLaunch, FFF_HOOK_PATH, PANE_USAGE_SETTINGS, capabilitiesFor as claudeCapabilitiesFor,
  fffHookDecision, headlessCommand as claudeHeadlessCommand, seatCommand as claudeSeatCommand,
  writeSeatSkills,
} from '../../adapters/adapter-claude.mjs'
import { headlessIo } from '../../headless.mjs'
import { ROOT, scratchDir } from '../../../test/helpers.mjs'
import { assertAnchorsPinned } from '../../../skills/qa-test-writing/anchor-pin.mjs'

// Hermetic against the operator's router switch. The adapters default `env` to
// process.env, so a call that omits `env` resolves CREW_ROUTER_ATTEMPT_URL from the
// ambient environment — and before this line the suite went red whenever an operator
// exported it, which is exactly the configuration the router exists to serve (#1497).
// Every router test here passes the switch explicitly through `env`, so none relies on
// the ambient value. MUTATION: delete this line and run with the switch exported.
delete process.env.CREW_ROUTER_ATTEMPT_URL

const LEDGER_SANDBOX = join(tmpdir(), `fff-ledger-${process.pid}`)
const LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
const LEDGER_DB_PREVIOUS = process.env.DEVTEAM_LEDGER_DB
mkdirSync(LEDGER_SANDBOX, { recursive: true })
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX
process.env.DEVTEAM_LEDGER_DB = join(LEDGER_SANDBOX, 'ledger.db')
after(() => {
  if (LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX_PREVIOUS
  if (LEDGER_DB_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DB
  else process.env.DEVTEAM_LEDGER_DB = LEDGER_DB_PREVIOUS
  rmSync(LEDGER_SANDBOX, { recursive: true, force: true })
})

const FFF_BIN = '/opt/homebrew/bin/fff-mcp'
const present = (path) => path === FFF_BIN || fsExists(path)
const absent = (path) => path !== FFF_BIN && fsExists(path)

function piEntry(exists = present) {
  return resolveAdapters(['builder'], { 'agent-builder': 'pi' }, null, { exists }).then((resolved) => resolved.builder)
}

function claudeEntry(exists = present) {
  return resolveAdapters(['builder'], {}, null, { exists }).then((resolved) => resolved.builder)
}

function ungrantedBuilderRegister() {
  const register = JSON.parse(readFileSync(new URL('../../capabilities.json', import.meta.url), 'utf8'))
  delete register.roles.builder.by_agent.claude
  register.roles.builder.by_agent.pi.mcp_servers = []
  return register
}

function piCommand(entry, search = entry.search, role = 'builder') {
  return piSeatCommand({
    role, model: 'openai-codex/gpt-5.6', promptFile: '/tmp/role-' + role + '.md',
    tools: SEAT_DEFAULTS[role].tools, deny: effectiveDeny(role, search), taskDir: '/tmp/crew-task',
    bootBrief: 'boot', grants: entry.grants,
  })
}

// Mirrors boot (crew/crew.mjs writeClaudeSkills): a claude seat holding skill grants
// refuses to build its command until those skills are materialised under its task dir, so
// a granted entry gets a scratch task dir with the skills written first. An ungranted entry
// keeps the fixed path, which keeps the byte-for-byte comparison against it meaningful.
function claudeTaskDir(entry, role = 'builder') {
  if ((entry.grants?.skills?.length ?? 0) === 0) return '/tmp/crew-task'
  const taskDir = scratchDir('fff-claude-task-')
  writeSeatSkills({ taskDir, role, grants: entry.grants })
  return taskDir
}

function claudeCommand(entry, search = entry.search, role = 'builder') {
  return claudeSeatCommand({
    role, model: 'sonnet', promptFile: '/tmp/role-' + role + '.md',
    tools: SEAT_DEFAULTS[role].tools, deny: effectiveDeny(role, search), taskDir: claudeTaskDir(entry, role),
    bootBrief: 'boot', grants: entry.grants, configDir: entry.configDir,
  })
}

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

async function bootRecord({ agent = null, available = true, register = null } = {}) {
  const home = scratchDir('fff-record-home-')
  const checkout = scratchDir('fff-record-checkout-')
  const previousHome = process.env.HOME
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousWrite = process.stdout.write
  process.env.HOME = home
  process.env.PI_CODING_AGENT_DIR = ''
  process.stdout.write = () => true
  const exists = (path) => path === FFF_BIN ? available : fsExists(path)
  const args = {
    task: 'fff-record', checkout, roles: 'builder', 'headless-all': true,
    'claude-bin': process.execPath,
    ...(agent ? { 'agent-builder': agent } : {}),
  }
  try {
    await bootCmd(args, {
      existsSync: exists, awaitSeatsReady: async () => {},
      ...(register ? { register } : {}),
    })
    const repo = slug(basename(checkout))
    const dir = join(home, '.crew', repo, 'fff-record')
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)).find((row) => row.event === 'boot')
    return { crew, journal }
  } finally {
    process.stdout.write = previousWrite
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(home, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
}

// MUTATION M4: restore a crew.mjs key in crew-recovery/anchors.json to its pre-insertion line.
test('M4 crew-recovery crew.mjs pins stay current after fff resolver changes', () => {
  const skillDir = join(ROOT, 'skills/crew-recovery')
  assertAnchorsPinned({
    root: ROOT, skillDir, manifestPath: join(skillDir, 'anchors.json'), minAnchors: 3,
    fence: ['crew/crew.mjs', 'skills/crew-recovery/anchors.json'],
  })
})

test('fff-A1-extension', async () => {
  const entry = await piEntry()
  const command = piCommand(entry)
  assert.match(command, /mcp__fff__find_files,mcp__fff__grep,mcp__fff__multi_grep/)
  assert.match(command, /-e 'builtin:mcp'/)
  assert.equal(command.includes('--exclude-tools "find,grep"'), true)
})

test('fff-A1-deny', async () => {
  const entry = await piEntry()
  const command = piCommand(entry)
  assert.match(command, /--exclude-tools "find,grep"/)
  assert.equal(effectiveDeny('builder', entry.search).endsWith(',Glob,Grep'), true)
})

test('fff-B1-mcp', async () => {
  const entry = await claudeEntry()
  assert.deepEqual(entry.grants.mcp_servers, [{ name: 'fff', command: { bin: FFF_BIN, args: [] }, url: null }])
  assert.deepEqual(mcpConfigDocument(entry.grants, 'pi'), {
    mcpServers: { fff: { command: FFF_BIN, args: [], exposure: 'direct' } },
  })
})

test('fff-B1-deny', async () => {
  const entry = await claudeEntry()
  const command = claudeCommand(entry)
  assert.match(command, /--disallowedTools "Task,Agent,Workflow,Glob,Grep"/)
  assert.doesNotMatch(command, /mcp__\*/)
})

test('fff-C1', async () => {
  const register = ungrantedBuilderRegister()
  const entry = (await resolveAdapters(['builder'], {}, null, { register, exists: present })).builder
  assert.deepEqual(entry.search, { tools: ['Glob', 'Grep'], fff: 'ungranted' })
  assert.deepEqual(entry.grants.mcp_servers, [])
  const beforeFff = claudeSeatCommand({
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md',
    tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny, taskDir: '/tmp/crew-task',
    bootBrief: 'boot', grants: entry.grants, configDir: entry.configDir,
  })
  assert.equal(claudeCommand(entry), beforeFff)
})

test('fff-D1-search', async () => {
  const entry = await piEntry(absent)
  assert.deepEqual(entry.search, { tools: ['grep', 'find'], fff: 'withheld', reason: 'binary-absent' })
  assert.equal(entry.grants.mcp_servers.some((server) => server.name === 'fff'), false)
  const command = piCommand(entry)
  assert.match(command, /--tools "read,bash,edit,write,grep,find,ls,retrieve,submit_envelope,codemode"/)
  assert.doesNotMatch(command, /mcp__fff__(grep|find_files|multi_grep)/)
  assert.doesNotMatch(command, /--exclude-tools "find,grep"/)
})

test('fff-D1-record', async () => {
  const { crew, journal } = await bootRecord({ agent: 'pi', available: false })
  const member = crew.members.builder
  const expected = { tools: ['grep', 'find'], fff: 'withheld', reason: 'binary-absent' }
  assert.deepEqual(member.search, expected)
  assert.deepEqual(journal.search.builder, expected)
  assert.equal(member.grant_snapshot.grants.extensions.some((path) => path.endsWith('/crew/pi/extensions/fff.ts')), false)
  assert.equal(member.tools, SEAT_DEFAULTS.builder.tools)
})

test('A1 granted seat record names withholding and its measured limit', async () => {
  const pi = await bootRecord({ agent: 'pi', available: true })
  const claude = await bootRecord({ available: true })
  const piExpected = {
    tools: ['mcp__fff__grep', 'mcp__fff__find_files', 'mcp__fff__multi_grep'], fff: 'granted',
    withholding: 'direct-and-listed-wrappers-refused', limit: 'arbitrary-shell-indirection-not-refused',
  }
  const claudeExpected = {
    tools: ['mcp__fff__grep', 'mcp__fff__find_files', 'mcp__fff__multi_grep'], fff: 'granted',
    withholding: 'direct-and-listed-wrappers-refused', limit: 'arbitrary-shell-indirection-not-refused',
  }
  assert.deepEqual(pi.crew.members.builder.search, piExpected)
  assert.deepEqual(pi.journal.search.builder, piExpected)
  assert.deepEqual(claude.crew.members.builder.search, claudeExpected)
  assert.deepEqual(claude.journal.search.builder, claudeExpected)
})

test('B1 search withholding limit is a closed value', () => {
  assert.deepEqual(FFF_SEARCH_WITHHOLDINGS, ['direct-and-listed-wrappers-refused', 'builtin-search-withheld'])
  assert.deepEqual(FFF_SEARCH_WITHHOLDING_LIMITS, ['arbitrary-shell-indirection-not-refused'])
  assert.equal(Object.isFrozen(FFF_SEARCH_WITHHOLDINGS), true)
  assert.equal(Object.isFrozen(FFF_SEARCH_WITHHOLDING_LIMITS), true)
  assert.equal(normalizeFffSearchWithholdingLimit('arbitrary-shell-indirection-not-refused'), 'arbitrary-shell-indirection-not-refused')
  assert.throws(
    () => normalizeFffSearchWithholdingLimit('indirect-shell-parser-refused'),
    TypeError,
  )
})

test('C1 ungranted seat search record remains byte-identical', async () => {
  const { crew, journal } = await bootRecord({ register: ungrantedBuilderRegister() })
  const expected = { tools: ['Glob', 'Grep'], fff: 'ungranted' }
  assert.deepEqual(crew.members.builder.search, expected)
  assert.deepEqual(journal.search.builder, expected)
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

test('A1 granted claude Bash search is refused with the fff replacement', async () => {
  const entry = await claudeEntry()
  const environment = paneFffEnvironment(claudeCommand(entry))
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

test('B1 ungranted claude Bash search remains untouched', async () => {
  const register = ungrantedBuilderRegister()
  const entry = (await resolveAdapters(['builder'], {}, null, { register, exists: present })).builder
  const taskDir = '/tmp/crew-task'
  const base = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md',
    tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny, taskDir, bootBrief: 'boot',
    prompt: 'go', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bin: '/usr/local/bin/claude',
    grants: entry.grants, configDir: entry.configDir,
  }
  const pane = claudeSeatCommand(base)
  const headless = claudeHeadlessCommand(base)
  assert.deepEqual(paneFffEnvironment(pane), { CREW_FFF: '0', CREW_FFF_NODE: '', CREW_FFF_HOOK: '' })
  assert.deepEqual(headless.env, {
    DEVTEAM_WORKER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir,
    CREW_FFF: '0', CREW_FFF_NODE: '', CREW_FFF_HOOK: '',
  })
  assert.deepEqual(headless.args.slice(headless.args.indexOf('--settings') - 2, headless.args.indexOf('--allowedTools')), ['--setting-sources', 'project', '--settings', PANE_USAGE_SETTINGS, '--tools', SEAT_DEFAULTS.builder.tools])

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

test('fff-G1-pi-record', async () => {
  const { crew, journal } = await bootRecord({ agent: 'pi', available: true })
  const member = crew.members.builder
  assert.deepEqual(member.search, {
    tools: ['mcp__fff__grep', 'mcp__fff__find_files', 'mcp__fff__multi_grep'], fff: 'granted',
    withholding: 'direct-and-listed-wrappers-refused', limit: 'arbitrary-shell-indirection-not-refused',
  })
  assert.deepEqual(journal.search.builder, member.search)
  assert.deepEqual(member.grant_snapshot.grants.mcp_servers, [{ name: 'fff', command: { bin: FFF_BIN, args: [] }, url: null }])
})

test('fff-G1-claude-record', async () => {
  const { crew, journal } = await bootRecord({ available: true })
  const member = crew.members.builder
  assert.deepEqual(member.search, {
    tools: ['mcp__fff__grep', 'mcp__fff__find_files', 'mcp__fff__multi_grep'], fff: 'granted',
    withholding: 'direct-and-listed-wrappers-refused', limit: 'arbitrary-shell-indirection-not-refused',
  })
  assert.deepEqual(journal.search.builder, member.search)
  assert.deepEqual(member.mcp_servers, [{ name: 'fff', command: { bin: FFF_BIN, args: [] }, url: null }])
})

test('fff-H1-headless-grant', async () => {
  const entry = await claudeEntry()
  const dir = scratchDir('fff-headless-')
  const taskDir = join(dir, 'task')
  const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  writeSeatSkills({ taskDir, role: 'builder', grants: entry.grants })
  const crew = {
    roles: ['builder'], checkout: dir,
    members: {
      builder: {
        model: 'sonnet', transport: 'headless-json', agent: 'claude',
        deny: effectiveDeny('builder', entry.search), search: entry.search,
        grant_snapshot: { schema_version: 1, role: 'builder', agent: 'claude', grants: entry.grants },
      },
    },
  }
  const calls = []
  const adapters = persistedAdapters(crew)
  const adapter = {
    headlessCommand(spec) {
      calls.push(spec)
      return claudeHeadlessCommand(spec)
    },
  }
  try {
    const io = headlessIo({
      crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir,
      adapters: { builder: { adapter, grants: adapters.builder.grants } }, bin: '/repo/claude',
      deps: { spawn: () => ({ pid: 321, unref() {} }), uuid: () => 'h1', log() {} },
    })
    const run = io.assign({ role: 'builder', briefFile: join(taskDir, 'brief.md') })
    assert.deepEqual(calls[0].grants.mcp_servers, entry.grants.mcp_servers)
    const command = JSON.parse(readFileSync(join(taskDir, 'headless', run.id, 'cmd.json'), 'utf8'))
    assert.doesNotMatch(command.args.join(' '), /mcp__\*/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('FA1 non-builder pi seats compose the native fff tools with builtins excluded', async () => {
  // MUTATION: restore role === 'builder' && in resolveFffSearch's declared and every non-builder pi command loses its mcp__fff__ tools.
  for (const role of ['planner', 'reviewer', 'tech-lead', 'lead']) {
    const entry = (await resolveAdapters([role], { ['agent-' + role]: 'pi' }, null, { exists: present }))[role]
    const command = piCommand(entry, entry.search, role)
    const tools = command.match(/--tools "([^"]*)"/)[1].split(',')
    const excluded = command.match(/--exclude-tools "([^"]*)"/)[1].split(',')
    for (const tool of ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']) assert.ok(tools.includes(tool), role + ' ' + tool)
    assert.ok(excluded.includes('find'), role)
    assert.ok(excluded.includes('grep'), role)
  }
})

test('FA1-lab the pi planner keeps the lab tool beside the fff tools', async () => {
  // MUTATION: drop the planner pi lab server object from the register and the planner pi command loses mcp__lab__lab beside mcp__fff__grep.
  const entry = (await resolveAdapters(['planner'], { 'agent-planner': 'pi' }, null, { exists: present })).planner
  const tools = piCommand(entry, entry.search, 'planner').match(/--tools "([^"]*)"/)[1].split(',')
  assert.ok(tools.includes('mcp__lab__lab'))
  assert.ok(tools.includes('mcp__fff__grep'))
})

test('FA2 non-builder claude seats allow the fff tools, deny Glob/Grep and set CREW_FFF=1', async () => {
  // MUTATION: narrow resolveFffSearch's declared to ['pi'] and every claude seat loses CREW_FFF=1, the Glob/Grep deny and the ACP mcp__fff__ tools.
  for (const role of ['planner', 'reviewer', 'tech-lead', 'lead']) {
    const entry = (await resolveAdapters([role], { ['agent-' + role]: 'claude' }, null, { exists: present }))[role]
    const pane = claudeCommand(entry, entry.search, role)
    assert.equal(paneFffEnvironment(pane).CREW_FFF, '1', role)
    const denied = pane.match(/--disallowedTools "([^"]*)"/)[1].split(',')
    assert.ok(denied.includes('Glob'), role)
    assert.ok(denied.includes('Grep'), role)
    assert.equal(denied.some((name) => name.startsWith('mcp__')), false, role)
    const launched = claudeAcpLaunch({
      role, bin: '/usr/local/bin/claude-agent-acp', claudeBin: process.execPath, cwd: '/tmp',
      tools: SEAT_DEFAULTS[role].tools, deny: effectiveDeny(role, entry.search),
      promptFile: '/tmp/role-' + role + '.md', taskDir: claudeTaskDir(entry, role),
      grants: entry.grants, configDir: entry.configDir,
    })
    const options = launched.sessionParams._meta.claudeCode.options
    for (const tool of ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']) assert.ok(options.allowedTools.includes(tool), role + ' ' + tool)
    assert.ok(options.disallowedTools.includes('Glob'), role)
    assert.ok(options.disallowedTools.includes('Grep'), role)
  }
})

test('FA3 an absent fff-mcp withholds fff on every role in both adapters', async () => {
  // MUTATION: drop the negation in copyFffGrant's filter and an absent binary no longer strips the fff server, so commands still carry mcp__fff__.
  for (const role of ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']) {
    const pi = (await resolveAdapters([role], { ['agent-' + role]: 'pi' }, null, { exists: absent }))[role]
    assert.deepEqual(pi.search, { tools: ['grep', 'find'], fff: 'withheld', reason: 'binary-absent' })
    assert.equal(pi.grants.mcp_servers.some((server) => server?.name === 'fff'), false, role)
    assert.doesNotMatch(piCommand(pi, pi.search, role), /mcp__fff__/)
    const claude = (await resolveAdapters([role], { ['agent-' + role]: 'claude' }, null, { exists: absent }))[role]
    assert.deepEqual(claude.search, { tools: ['Glob', 'Grep'], fff: 'withheld', reason: 'binary-absent' })
    assert.equal(claude.grants.mcp_servers.some((server) => server?.name === 'fff'), false, role)
    assert.equal(paneFffEnvironment(claudeCommand(claude, claude.search, role)).CREW_FFF, '0', role)
    const launched = claudeAcpLaunch({
      role, bin: '/usr/local/bin/claude-agent-acp', claudeBin: process.execPath, cwd: '/tmp',
      tools: SEAT_DEFAULTS[role].tools, deny: effectiveDeny(role, claude.search),
      promptFile: '/tmp/role-' + role + '.md', taskDir: claudeTaskDir(claude, role),
      grants: claude.grants, configDir: claude.configDir,
    })
    assert.equal(launched.sessionParams._meta.claudeCode.options.allowedTools.some((tool) => tool.startsWith('mcp__fff__')), false, role)
  }
})

test('FA4 granted pi seats without readgate record builtin-search-withheld', async () => {
  // MUTATION: swap the new value for FFF_SEARCH_WITHHOLDINGS[0] and granted pi seats without readgate claim a bash refusal they do not have.
  for (const role of ['reviewer', 'lead']) {
    const entry = (await resolveAdapters([role], { ['agent-' + role]: 'pi' }, null, { exists: present }))[role]
    assert.equal(entry.search.fff, 'granted', role)
    assert.equal(entry.search.withholding, 'builtin-search-withheld', role)
  }
  for (const role of ['builder', 'planner', 'tech-lead']) {
    const entry = (await resolveAdapters([role], { ['agent-' + role]: 'pi' }, null, { exists: present }))[role]
    assert.equal(entry.search.withholding, 'direct-and-listed-wrappers-refused', role)
  }
  for (const role of ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']) {
    const entry = (await resolveAdapters([role], { ['agent-' + role]: 'claude' }, null, { exists: present }))[role]
    assert.equal(entry.search.withholding, 'direct-and-listed-wrappers-refused', role)
  }
})

test('FA4-grants the withholding follows the resolved grants, not the role name', async () => {
  // MUTATION: swap the grants test for the role-name test and the value no longer follows the resolved grants.
  const register = JSON.parse(readFileSync(new URL('../../capabilities.json', import.meta.url), 'utf8'))
  register.roles.reviewer.by_agent.pi.extensions.push('crew/pi/extensions/readgate.ts')
  register.roles.builder.by_agent.pi.extensions = register.roles.builder.by_agent.pi.extensions.filter((path) => path !== 'crew/pi/extensions/readgate.ts')
  const reviewer = (await resolveAdapters(['reviewer'], { 'agent-reviewer': 'pi' }, null, { register, exists: present })).reviewer
  assert.equal(reviewer.search.withholding, 'direct-and-listed-wrappers-refused')
  const builder = (await resolveAdapters(['builder'], { 'agent-builder': 'pi' }, null, { register, exists: present })).builder
  assert.equal(builder.search.withholding, 'builtin-search-withheld')
})

test('FA5 the withholding enum is closed and searchRecord refuses outside values', () => {
  // MUTATION: disable the enum guard with if (false) and searchRecord stops throwing on a withholding outside the closed enum.
  assert.deepEqual(FFF_SEARCH_WITHHOLDINGS, ['direct-and-listed-wrappers-refused', 'builtin-search-withheld'])
  assert.equal(Object.isFrozen(FFF_SEARCH_WITHHOLDINGS), true)
  assert.throws(() => searchRecord(['grep'], 'granted', { withholding: 'bash-search-refused' }), TypeError)
})

