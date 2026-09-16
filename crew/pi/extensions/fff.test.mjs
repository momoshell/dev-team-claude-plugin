import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync as fsExists, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  FFF_MCP_BIN, FFF_TOOL_DEFINITIONS, FFF_TIMEOUT_MS, attachFff, createMcpCall,
} from './fff.ts'
import { createReadGate } from './readgate.ts'
import {
  bootCmd, effectiveDeny, mcpConfigDocument, persistedAdapters, resolveAdapters, SEAT_DEFAULTS, slug,
} from '../../crew.mjs'
import { seatCommand as piSeatCommand } from '../../adapters/adapter-pi.mjs'
import { headlessCommand as claudeHeadlessCommand, seatCommand as claudeSeatCommand } from '../../adapters/adapter-claude.mjs'
import { headlessIo } from '../../headless.mjs'
import { scratchDir } from '../../../test/helpers.mjs'

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

const present = (path) => path === FFF_MCP_BIN || fsExists(path)
const absent = (path) => path !== FFF_MCP_BIN && fsExists(path)

function piEntry(exists = present) {
  return resolveAdapters(['builder'], { 'agent-builder': 'pi' }, null, { exists }).then((resolved) => resolved.builder)
}

function claudeEntry(exists = present) {
  return resolveAdapters(['builder'], {}, null, { exists }).then((resolved) => resolved.builder)
}

function ungrantedBuilderRegister() {
  const register = JSON.parse(readFileSync(new URL('../../capabilities.json', import.meta.url), 'utf8'))
  delete register.roles.builder.by_agent.claude
  register.roles.builder.by_agent.pi.extensions = register.roles.builder.by_agent.pi.extensions
    .filter((extension) => !extension.endsWith('/crew/pi/extensions/fff.ts'))
  return register
}

function piCommand(entry, search = entry.search) {
  return piSeatCommand({
    role: 'builder', model: 'openai-codex/gpt-5.6', promptFile: '/tmp/role-builder.md',
    tools: SEAT_DEFAULTS.builder.tools, deny: effectiveDeny('builder', search), taskDir: '/tmp/crew-task',
    bootBrief: 'boot', grants: entry.grants,
  })
}

function claudeCommand(entry, search = entry.search) {
  return claudeSeatCommand({
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md',
    tools: SEAT_DEFAULTS.builder.tools, deny: effectiveDeny('builder', search), taskDir: '/tmp/crew-task',
    bootBrief: 'boot', grants: entry.grants, configDir: entry.configDir,
  })
}

class FakeChild extends EventEmitter {
  constructor(mode, onKill = () => {}, onRequest = () => {}) {
    super()
    this.mode = mode
    this.onKill = onKill
    this.onRequest = onRequest
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdin = { write: (chunk) => this.write(chunk), destroy() {} }
  }

  write(chunk) {
    const request = JSON.parse(String(chunk).trim())
    this.onRequest(request)
    if (request.id === 1) {
      const response = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`
      this.stdout.emit('data', Buffer.from(response.slice(0, 11)))
      this.stdout.emit('data', response.slice(11))
      return
    }
    if (request.id !== 2) return
    if (this.mode === 'malformed') {
      this.stdout.emit('data', 'not-json\n')
    } else if (this.mode === 'empty') {
      this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } })}\n`)
    } else if (this.mode === 'error') {
      this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'fake failure' } })}\n`)
    } else if (this.mode === 'close') {
      this.emit('close', 1, null)
    } else if (this.mode === 'success') {
      this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'found' }], structuredContent: { count: 1 } } })}\n`)
    }
  }

  kill() {
    this.onKill()
  }
}

async function bootRecord({ agent = null, available = true } = {}) {
  const home = scratchDir('fff-record-home-')
  const checkout = scratchDir('fff-record-checkout-')
  const previousHome = process.env.HOME
  const previousWrite = process.stdout.write
  process.env.HOME = home
  process.stdout.write = () => true
  const exists = (path) => path === FFF_MCP_BIN ? available : fsExists(path)
  const args = {
    task: 'fff-record', checkout, roles: 'builder', 'headless-all': true,
    'claude-bin': process.execPath,
    ...(agent ? { 'agent-builder': agent } : {}),
  }
  try {
    await bootCmd(args, { existsSync: exists, awaitSeatsReady: async () => {} })
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
    rmSync(home, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
}

test('fff-A1-extension', async () => {
  const entry = await piEntry()
  const command = piCommand(entry)
  assert.match(command, /-e ".*\/crew\/pi\/extensions\/fff\.ts"/)
  assert.match(command, /fff_grep,fff_find,fff_multi_grep/)
  assert.equal(command.includes('--exclude-tools "find,grep"'), true)
})

test('fff-A1-deny', async () => {
  const entry = await piEntry()
  const command = piCommand(entry)
  assert.match(command, /--exclude-tools "find,grep"/)
  assert.equal(effectiveDeny('builder', entry.search).endsWith(',Glob,Grep'), true)
})

test('fff-A1-registers-tools', (t) => {
  const previousFff = process.env.CREW_FFF
  t.after(() => {
    if (previousFff === undefined) delete process.env.CREW_FFF
    else process.env.CREW_FFF = previousFff
  })
  const registered = []
  const tools = attachFff({ registerTool: (tool) => registered.push(tool) }, { call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) })
  assert.deepEqual(registered.map((tool) => tool.name), ['fff_grep', 'fff_find', 'fff_multi_grep'])
  assert.deepEqual(tools.map((tool) => tool.name), FFF_TOOL_DEFINITIONS.map((tool) => tool.name))
})

test('fff-A1-forwards-tools', async () => {
  const methods = [
    ['fff_grep', 'grep'],
    ['fff_find', 'find_files'],
    ['fff_multi_grep', 'multi_grep'],
  ]
  for (const [toolName, method] of methods) {
    const requests = []
    const call = createMcpCall({
      spawn: () => new FakeChild('success', () => {}, (request) => requests.push(request)),
    })
    await call(toolName, { query: 'needle' }, { cwd: '/tmp' })
    assert.deepEqual(requests.map((request) => request.method), ['initialize', 'notifications/initialized', 'tools/call'])
    assert.equal(requests.at(-1).params.name, method)
  }
})

test('fff-B1-mcp', async () => {
  const entry = await claudeEntry()
  assert.deepEqual(entry.grants.mcp_servers, [{ name: 'fff', command: { bin: FFF_MCP_BIN, args: [] }, url: null }])
  assert.deepEqual(mcpConfigDocument(entry.grants), {
    mcpServers: { fff: { command: FFF_MCP_BIN, args: [] } },
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
  assert.equal(entry.grants.extensions.some((path) => path.endsWith('/crew/pi/extensions/fff.ts')), false)
  const command = piCommand(entry)
  assert.match(command, /--tools "read,bash,edit,write,grep,find,ls,retrieve"/)
  assert.doesNotMatch(command, /fff_(grep|find|multi_grep)/)
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

test('fff-E1-refuse', () => {
  const gate = createReadGate({ env: { CREW_FFF: '1' }, hasUnquotedPipe: () => false })
  for (const [program, recommendation] of [['grep', 'fff_grep'], ['rg', 'fff_grep'], ['find', 'fff_find'], ['fd', 'fff_find']]) {
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

test('fff-F1', async () => {
  let kills = 0
  const call = createMcpCall({
    timeoutMs: 20,
    spawn: () => new FakeChild('silent', () => { kills += 1 }),
  })
  const outer = new Promise((_, reject) => setTimeout(() => reject(new Error('outer bound exceeded')), 250))
  await assert.rejects(Promise.race([call('fff_grep', { query: 'needle' }, { cwd: '/tmp' }), outer]), /timed out/)
  assert.equal(kills, 1)
  assert.equal(FFF_TIMEOUT_MS > 0, true)
})

test('fff-G1-pi-record', async () => {
  const { crew, journal } = await bootRecord({ agent: 'pi', available: true })
  const member = crew.members.builder
  assert.deepEqual(member.search, { tools: ['fff_grep', 'fff_find', 'fff_multi_grep'], fff: 'granted' })
  assert.deepEqual(journal.search.builder, member.search)
  assert.deepEqual(member.grant_snapshot.grants.extensions.at(-1).split('/').slice(-3), ['pi', 'extensions', 'fff.ts'])
})

test('fff-G1-claude-record', async () => {
  const { crew, journal } = await bootRecord({ available: true })
  const member = crew.members.builder
  assert.deepEqual(member.search, { tools: ['mcp__fff__grep', 'mcp__fff__find_files', 'mcp__fff__multi_grep'], fff: 'granted' })
  assert.deepEqual(journal.search.builder, member.search)
  assert.deepEqual(member.mcp_servers, [{ name: 'fff', command: { bin: FFF_MCP_BIN, args: [] }, url: null }])
})

test('fff-H1-headless-grant', async () => {
  const entry = await claudeEntry()
  const dir = scratchDir('fff-headless-')
  const taskDir = join(dir, 'task')
  const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
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

test('fff transport handles chunking and bounded failure modes', async () => {
  const modes = ['malformed', 'empty', 'error', 'close']
  for (const mode of modes) {
    let kills = 0
    const call = createMcpCall({ timeoutMs: 40, spawn: () => new FakeChild(mode, () => { kills += 1 }) })
    await assert.rejects(call('fff_find', { query: '*.ts' }, { cwd: '/tmp' }), /fff-mcp/)
    assert.equal(kills, 1, mode)
  }
  let kills = 0
  const success = createMcpCall({ timeoutMs: 40, spawn: () => new FakeChild('success', () => { kills += 1 }) })
  assert.deepEqual(await success('fff_grep', { query: 'needle' }, { cwd: '/tmp' }), {
    content: [{ type: 'text', text: 'found' }], structuredContent: { count: 1 },
  })
  assert.equal(kills, 1)
})
