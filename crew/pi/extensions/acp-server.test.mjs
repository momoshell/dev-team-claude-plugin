import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'
import { scratchDir } from '../../../test/helpers.mjs'
import { ACP_PROTOCOL_VERSION, ACP_STOP_REASONS, ACP_UPDATE_KINDS, acpClient } from '../../acp-client.mjs'
import acpServer, { PERMISSION_OPTIONS, gatedToolsFrom, stopReasonFor, usageFrom } from './acp-server.ts'

// Every server test drives the REAL extension the way pi does: each handler is
// called (event, ctx), ctx only as the second argument, and the client side is
// a real unix socket speaking the frames crew/acp-client.mjs writes. The bridge
// tests spawn the real bridge against a fake pi executable. No real pi, no
// network.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const SERVER = join(HERE, 'acp-server.ts')
const BRIDGE = join(HERE, '..', 'acp-bridge.mjs')
const FIXTURES = join(REPO, 'test', 'fixtures', 'acp')
const SESSION = 'pi-session-under-test'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
// A bounded wait whose timer is cleared, so a won race never holds the file open.
function within(value, ms, fallback) {
  let timer
  const late = new Promise((done) => { timer = setTimeout(() => done(fallback), ms) })
  return Promise.race([Promise.resolve(value), late]).finally(() => clearTimeout(timer))
}
const settle = (value, ms = 1000) => within(value, ms, 'still-pending')

function fixtureFrames(name, dir) {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((record) => record.dir === dir).map((record) => record.frame)
}

function withEnv(vars, fn) {
  const saved = {}
  for (const key of Object.keys(vars)) { saved[key] = process.env[key]; if (vars[key] === undefined) delete process.env[key]; else process.env[key] = vars[key] }
  try { return fn() } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

// A stub ExtensionAPI with pi's calling convention. `emit` returns what the
// last handler returned, unawaited, so a test can hold a pending tool_call.
function stubPi() {
  const handlers = new Map()
  const prompts = []
  const pi = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) },
    sendUserMessage(content) { prompts.push(content) },
  }
  return { pi, handlers, prompts }
}

async function harness({ env = {}, connect = true, sessionId = () => SESSION } = {}) {
  const dir = scratchDir('acp-srv-')
  const socketPath = join(dir, 'acp.sock')
  const ctx = { aborts: 0, idle: false, sessionManager: { getSessionId: sessionId }, abort() { ctx.aborts += 1 }, isIdle() { return ctx.idle } }
  const { pi, handlers, prompts } = stubPi()
  withEnv({ CREW_ACP_SOCKET: socketPath, CREW_ACP_GATED_TOOLS: undefined, CREW_ACP_PERMISSION_TIMEOUT_MS: undefined, ...env }, () => acpServer(pi))
  const emit = (name, fields = {}) => {
    let last
    for (const fn of handlers.get(name) || []) last = fn({ type: name, ...fields }, ctx)
    return last
  }
  emit('session_start', { reason: 'startup' })
  for (let i = 0; i < 400 && !existsSync(socketPath); i += 1) await sleep(5)
  const frames = []
  let client = null
  const open = async () => {
    const socket = net.createConnection(socketPath)
    await new Promise((done, fail) => { socket.once('connect', done); socket.once('error', fail) })
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1) }
    })
    return socket
  }
  if (connect) client = await open()
  const send = (frame) => client.write(`${JSON.stringify(frame)}\n`)
  const wait = async (pred, what, ms = 2000) => {
    for (let waited = 0; waited <= ms; waited += 5) { const hit = frames.find(pred); if (hit) return hit; await sleep(5) }
    throw new Error(`no ${what} within ${ms}ms`)
  }
  const request = async (id, method, params) => { send({ jsonrpc: '2.0', id, method, params }); return wait((f) => f.id === id && !f.method, `${method} response`) }
  const answer = (req, optionId) => send({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'selected', optionId } } })
  const permissionRequests = () => frames.filter((f) => f.method === 'session/request_permission')
  const close = () => { try { client?.destroy() } catch {} emit('session_shutdown', { reason: 'quit' }) }
  return { ctx, emit, frames, send, wait, request, answer, permissionRequests, prompts, open, close, socketPath, get client() { return client } }
}

async function withSession(options = {}) {
  const h = await harness(options)
  const created = await h.request(1, 'session/new', { cwd: '/', mcpServers: [] })
  assert.equal(created.result?.sessionId, SESSION)
  return h
}

const bashCall = (toolCallId, command = 'echo hi') => ({ toolCallId, toolName: 'bash', input: { command } })

test('P1', async () => {
  const h = await harness()
  try {
    const [init] = fixtureFrames('pi-handshake.ndjson', 'client->agent')
    assert.equal(init.method, 'initialize')
    h.send(init)
    const reply = await h.wait((f) => f.id === init.id, 'initialize response')
    assert.equal(reply.result.protocolVersion, ACP_PROTOCOL_VERSION)
    assert.deepEqual(reply.result.agentCapabilities, { loadSession: false })
    assert.equal(Object.hasOwn(reply.result.agentCapabilities, 'fs'), false)
    assert.equal(Object.hasOwn(reply.result.agentCapabilities, 'terminal'), false)
  } finally { h.close() }
})

test('P2', async () => {
  const h = await withSession()
  try {
    h.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'hello' }] } })
    for (let i = 0; i < 100 && !h.prompts.length; i += 1) await sleep(5)
    assert.deepEqual(h.prompts, [[{ type: 'text', text: 'hello' }]])
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0 } } }] })
    await sleep(100)
    assert.equal(h.frames.some((f) => f.id === 5), false, 'session/prompt must not resolve on agent_end')
    h.emit('agent_before_settle', { outcome: 'completed' })
    h.emit('agent_settled')
    const done = await h.wait((f) => f.id === 5, 'session/prompt response')
    assert.equal(done.result.stopReason, 'end_turn')
    assert.ok(ACP_STOP_REASONS.includes(done.result.stopReason))
    assert.deepEqual(done.result.usage, { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 1, totalTokens: 18 })
    await sleep(50)
    assert.equal(h.frames.filter((f) => f.id === 5).length, 1)
  } finally { h.close() }
})

test('P3', async () => {
  const h = await withSession()
  try {
    h.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'long' }] } })
    for (let i = 0; i < 100 && !h.prompts.length; i += 1) await sleep(5)
    // Exactly the frame crew/acp-client.mjs cancel() writes: a notification, no id.
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION } })
    const done = await h.wait((f) => f.id === 5, 'cancelled prompt response')
    assert.equal(h.ctx.aborts, 1, 'session/cancel must call ctx.abort once')
    assert.equal(done.result.stopReason, 'cancelled')
    h.emit('agent_before_settle', { outcome: 'aborted' })
    h.emit('agent_settled')
    await sleep(100)
    assert.equal(h.frames.filter((f) => f.id === 5).length, 1, 'the aborted run settling must not answer twice')
    assert.equal(h.frames.some((f) => f.error && f.id === null), false, 'the notification must not be answered as an invalid request')
  } finally { h.close() }
})

test('a cancel that lands during pi prompt preflight still stops the run and blocks its tools', async () => {
  const h = await withSession()
  try {
    h.ctx.idle = true
    h.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'x' }] } })
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION } })
    const done = await h.wait((f) => f.id === 5, 'cancelled prompt response')
    assert.equal(done.result.stopReason, 'cancelled')
    h.ctx.idle = false
    h.emit('agent_start')
    assert.equal(h.ctx.aborts, 2, 'the run that starts after the cancel is aborted on start')
    assert.deepEqual(await settle(h.emit('tool_call', bashCall('call-late'))), { block: true, reason: 'ACP prompt cancelled' })
    assert.deepEqual(await settle(h.emit('tool_call', { toolCallId: 'call-read', toolName: 'read', input: {} })), { block: true, reason: 'ACP prompt cancelled' })
    assert.equal(h.permissionRequests().length, 0)
    const busy = await h.request(6, 'session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'y' }] })
    assert.equal(busy.error.code, -32000)
    h.emit('agent_settled')
    await sleep(50)
    assert.equal(h.frames.filter((f) => f.id === 5).length, 1)
    h.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'z' }] } })
    for (let i = 0; i < 100 && h.prompts.length < 2; i += 1) await sleep(5)
    assert.equal(h.prompts.length, 2, 'once the cancelled run settles the session takes a prompt again')
  } finally { h.close() }
})

test('the default gate covers bash, edit, write and powershell, and a blank list is the default', async () => {
  assert.deepEqual([...gatedToolsFrom(undefined)].sort(), ['bash', 'edit', 'powershell', 'write'])
  assert.deepEqual([...gatedToolsFrom(' , ')].sort(), ['bash', 'edit', 'powershell', 'write'])
  assert.deepEqual([...gatedToolsFrom('bash')], ['bash'])
  const h = await withSession()
  try {
    const pending = h.emit('tool_call', { toolCallId: 'call-ps', toolName: 'powershell', input: { command: 'dir' } })
    const req = await h.wait((f) => f.method === 'session/request_permission', 'powershell permission request')
    assert.equal(req.params.toolCall.kind, 'execute')
    h.answer(req, 'reject_once')
    assert.equal((await settle(pending))?.block, true)
  } finally { h.close() }
})

test('P4', async () => {
  const h = await withSession()
  try {
    const pending = h.emit('tool_call', bashCall('call-p4-1'))
    const req = await h.wait((f) => f.method === 'session/request_permission', 'permission request')
    assert.equal(req.params.sessionId, SESSION)
    assert.equal(req.params.toolCall.toolCallId, 'call-p4-1')
    assert.equal(req.params.toolCall.kind, 'execute')
    assert.deepEqual(req.params.options.map((o) => o.kind), ['allow_once', 'allow_always', 'reject_once', 'reject_always'])
    assert.equal(await settle(pending, 100), 'still-pending', 'the gated call must wait for the answer')
    h.answer(req, 'reject_once')
    const result = await settle(pending)
    assert.equal(result?.block, true)
    assert.match(result.reason, /rejected/)
    // reject_once is not cached: the next call asks again.
    const again = h.emit('tool_call', bashCall('call-p4-2'))
    const second = await h.wait((f) => f.method === 'session/request_permission' && f.id !== req.id, 'second permission request')
    h.answer(second, 'allow_once')
    assert.equal(await settle(again), undefined)
    // An ungated tool never asks.
    assert.equal(await settle(h.emit('tool_call', { toolCallId: 'call-p4-3', toolName: 'read', input: { path: 'x' } })), undefined)
    assert.equal(h.permissionRequests().length, 2)
  } finally { h.close() }
})

test('P5', async () => {
  const h = await withSession({ env: { CREW_ACP_PERMISSION_TIMEOUT_MS: '1500' } })
  try {
    const first = h.emit('tool_call', bashCall('call-p5-1'))
    const req = await h.wait((f) => f.method === 'session/request_permission', 'permission request')
    h.answer(req, 'allow_always')
    assert.equal(await settle(first), undefined)
    const second = await settle(h.emit('tool_call', bashCall('call-p5-2')), 500)
    assert.equal(second, undefined, 'allow_always must let the next bash call run')
    assert.equal(h.permissionRequests().length, 1, 'allow_always must not ask a second time')
  } finally { h.close() }
})

test('P6', async () => {
  const h = await harness({ connect: false })
  try {
    const result = await settle(h.emit('tool_call', bashCall('call-p6')))
    assert.equal(result?.block, true, 'a gated call with no ACP client must be blocked')
    assert.equal(result.reason, 'ACP client unavailable')
  } finally { h.close() }
})

// The fake pi the bridge tests spawn. It records argv, env, the socket dir
// mode and every byte it reads on stdin, writes a marker to its own stdout,
// and in `serve` mode answers initialize on CREW_ACP_SOCKET.
function fakePi(dir) {
  const path = join(dir, 'fake-pi.mjs')
  writeFileSync(path, `#!${process.execPath}
import net from 'node:net'
import { statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const socketPath = process.env.CREW_ACP_SOCKET
let stdinBytes = 0
const record = (extra = {}) => writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({ argv: process.argv.slice(2), socketPath, dirMode: statSync(dirname(socketPath)).mode & 0o777, stdinBytes, pid: process.pid, ...extra }))
process.stdin.on('data', (d) => { stdinBytes += d.length })
process.stdout.write('FAKE-PI-STDOUT\\n')
record()
if (process.env.FAKE_PI_MODE === 'exit-early') process.exit(7)
if (process.env.FAKE_PI_MODE === 'exit-zero') process.exit(0)
if (process.env.FAKE_PI_MODE === 'fork-exit') {
  const { spawn } = await import('node:child_process')
  const left = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  record({ descendant: left.pid })
  process.exit(7)
}
process.on('SIGTERM', () => { record({ sigterm: true }); process.exit(5) })
net.createServer((sock) => {
  let buf = ''
  sock.on('data', (d) => {
    buf += d
    let at
    while ((at = buf.indexOf('\\n')) >= 0) {
      const frame = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1)
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, _meta: { from: 'fake-pi', method: frame.method } } }) + '\\n')
    }
  })
}).listen(socketPath)
setTimeout(() => process.exit(3), 30000).unref()
`)
  chmodSync(path, 0o755)
  return path
}

function runBridge(env, args = []) {
  const child = spawn(process.execPath, [BRIDGE, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  const run = { child, stdout: '', stderr: '' }
  child.stdout.on('data', (d) => { run.stdout += d })
  child.stderr.on('data', (d) => { run.stderr += d })
  run.exited = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })))
  return run
}

async function waitFor(pred, what, ms = 5000) {
  for (let waited = 0; waited <= ms; waited += 10) { if (pred()) return; await sleep(10) }
  throw new Error(`no ${what} within ${ms}ms`)
}

const readRecord = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const killRecorded = (path) => { const rec = readRecord(path); if (rec?.pid) { try { process.kill(rec.pid, 'SIGKILL') } catch {} } }

test('P7', async () => {
  const dir = scratchDir('acp-bridge-')
  const recordPath = join(dir, 'record.json')
  const run = runBridge({ CREW_PI_BIN: fakePi(dir), FAKE_PI_RECORD: recordPath, FAKE_PI_MODE: 'serve', HOME: dir }, ['--model', 'fake/model'])
  try {
    run.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`)
    await waitFor(() => run.stdout.includes('\n'), 'a frame on the bridge stdout')
    const reply = JSON.parse(run.stdout.split('\n')[0])
    assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, _meta: { from: 'fake-pi', method: 'initialize' } } })
    assert.equal(run.stdout.includes('FAKE-PI-STDOUT'), false, 'pi stdout must never reach the ACP stdout')
    const rec = readRecord(recordPath)
    assert.deepEqual(rec.argv, ['--mode', 'rpc', '--no-session', '-e', SERVER, '--model', 'fake/model'])
    assert.equal(rec.dirMode, 0o700)
    run.child.stdin.end()
    const exit = await run.exited
    const after = readRecord(recordPath)
    assert.equal(after.sigterm, true, 'stdin EOF must terminate pi')
    assert.equal(after.stdinBytes, 0, 'pi stdin is held open and never written')
    assert.equal(exit.code, 5, 'the bridge exits with pi status')
    assert.equal(existsSync(dirname(rec.socketPath)), false, 'the socket dir is removed')
    assert.match(run.stderr, /FAKE-PI-STDOUT/)
  } finally { run.child.kill('SIGKILL'); killRecorded(recordPath) }
})

test('P8', () => {
  const off = stubPi()
  withEnv({ CREW_ACP_SOCKET: undefined }, () => acpServer(off.pi))
  assert.deepEqual([...off.handlers.keys()], [], 'without CREW_ACP_SOCKET the extension registers nothing')
  // Non-vacuity: the same factory with the variable set does register.
  const on = stubPi()
  withEnv({ CREW_ACP_SOCKET: join(scratchDir('acp-p8-'), 's.sock') }, () => acpServer(on.pi))
  assert.ok(on.handlers.has('tool_call') && on.handlers.has('session_start'))
})

test('session/new answers the running session id with mcpServers unsupported, and refuses a second', async () => {
  const h = await harness()
  try {
    const first = await h.request(1, 'session/new', { cwd: '/', mcpServers: [{ name: 'x', command: 'y', args: [], env: [] }] })
    assert.deepEqual(first.result, { sessionId: SESSION, _meta: { mcpServers: { supported: false, requested: 1 } } })
    const second = await h.request(2, 'session/new', { cwd: '/', mcpServers: [] })
    assert.equal(second.result, undefined)
    assert.match(second.error.message, /session replacement unsupported/)
    const wrong = await h.request(3, 'session/prompt', { sessionId: 'another', prompt: [{ type: 'text', text: 'x' }] })
    assert.equal(wrong.error.code, -32602)
  } finally { h.close() }
  const broken = await harness({ sessionId: () => { throw new Error('boom') } })
  try {
    const reply = await broken.request(1, 'session/new', { cwd: '/', mcpServers: [] })
    assert.equal(reply.error.code, -32603, 'an exception inside a request answers Internal error, not Parse error')
  } finally { broken.close() }
})

test('the stop-reason map is closed over ACP_STOP_REASONS and an errored run answers a JSON-RPC error', async () => {
  assert.equal(stopReasonFor('completed', 'stop'), 'end_turn')
  assert.equal(stopReasonFor('completed', 'toolUse'), 'end_turn')
  assert.equal(stopReasonFor('completed', 'length'), 'max_tokens')
  assert.equal(stopReasonFor('aborted', 'aborted'), 'cancelled')
  assert.equal(stopReasonFor('error', 'error'), null)
  assert.equal(stopReasonFor(undefined), null)
  for (const reason of ['end_turn', 'max_tokens', 'cancelled']) assert.ok(ACP_STOP_REASONS.includes(reason))
  assert.equal(usageFrom([{ role: 'user' }, { role: 'assistant' }]), null, 'no measured usage is null, never zeros')
  const h = await withSession()
  try {
    h.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'x' }] } })
    for (let i = 0; i < 100 && !h.prompts.length; i += 1) await sleep(5)
    h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'provider down' }] })
    h.emit('agent_before_settle', { outcome: 'error' })
    h.emit('agent_settled')
    const reply = await h.wait((f) => f.id === 7, 'errored prompt response')
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.data.errorKind, 'pi-agent-error')
  } finally { h.close() }
})

test('session/update carries text and thinking deltas and tool start and end under toolCallId, only ACP_UPDATE_KINDS', async () => {
  const h = await withSession()
  try {
    h.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'x' }] } })
    for (let i = 0; i < 100 && !h.prompts.length; i += 1) await sleep(5)
    h.emit('message_update', { message: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } })
    h.emit('message_update', { message: {}, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"com' } })
    h.emit('tool_execution_start', { toolCallId: 'call-u1', toolName: 'write', args: { path: 'a' } })
    h.emit('tool_execution_end', { toolCallId: 'call-u1', toolName: 'write', result: {}, isError: false })
    h.emit('message_update', { message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'done' } })
    h.emit('agent_before_settle', { outcome: 'completed' })
    h.emit('agent_settled')
    await h.wait((f) => f.id === 5, 'prompt response')
    const updates = h.frames.filter((f) => f.method === 'session/update').map((f) => f.params.update)
    assert.deepEqual(updates, [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'tool_call', toolCallId: 'call-u1', title: 'write', kind: 'edit', status: 'in_progress', rawInput: { path: 'a' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-u1', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    ])
    for (const u of updates) assert.ok(ACP_UPDATE_KINDS.includes(u.sessionUpdate))
    assert.ok(h.frames.filter((f) => f.method === 'session/update').every((f) => f.params.sessionId === SESSION))
  } finally { h.close() }
})

test('permission: reject_always is cached per tool and allow_always does not cross tools', async () => {
  const h = await withSession({ env: { CREW_ACP_PERMISSION_TIMEOUT_MS: '1500' } })
  try {
    const first = h.emit('tool_call', bashCall('call-c1'))
    h.answer(await h.wait((f) => f.method === 'session/request_permission', 'bash request'), 'reject_always')
    assert.equal((await settle(first))?.block, true)
    assert.equal((await settle(h.emit('tool_call', bashCall('call-c2')), 500))?.block, true)
    assert.equal(h.permissionRequests().length, 1, 'reject_always must not ask again')
    const edit = h.emit('tool_call', { toolCallId: 'call-c3', toolName: 'edit', input: {} })
    const editReq = await h.wait((f) => f.method === 'session/request_permission' && f.params.toolCall.toolCallId === 'call-c3', 'edit request')
    assert.equal(editReq.params.toolCall.kind, 'edit')
    h.answer(editReq, 'allow_always')
    assert.equal(await settle(edit), undefined)
    const write = h.emit('tool_call', { toolCallId: 'call-c4', toolName: 'write', input: {} })
    const writeReq = await h.wait((f) => f.method === 'session/request_permission' && f.params.toolCall.toolCallId === 'call-c4', 'write request')
    h.answer(writeReq, 'allow_once')
    assert.equal(await settle(write), undefined)
  } finally { h.close() }
})

test('permission fails closed: timeout, cancelled, an unknown option, an error answer and a disconnect all block', async () => {
  const h = await withSession({ env: { CREW_ACP_PERMISSION_TIMEOUT_MS: '60' } })
  try {
    const timedOut = await settle(h.emit('tool_call', bashCall('call-t1')), 1500)
    assert.deepEqual(timedOut, { block: true, reason: 'ACP permission timed out' })
  } finally { h.close() }
  const g = await withSession({ env: { CREW_ACP_PERMISSION_TIMEOUT_MS: '5000' } })
  try {
    const answers = [
      { result: { outcome: { outcome: 'cancelled' } } },
      { result: { outcome: { outcome: 'selected', optionId: 'allow_everything' } } },
      { error: { code: -32601, message: 'no' } },
    ]
    for (const [index, body] of answers.entries()) {
      const pending = g.emit('tool_call', bashCall(`call-f${index}`))
      const req = await g.wait((f) => f.method === 'session/request_permission' && f.params.toolCall.toolCallId === `call-f${index}`, 'permission request')
      g.send({ jsonrpc: '2.0', id: req.id, ...body })
      assert.equal((await settle(pending))?.block, true, `answer ${JSON.stringify(body)} must block`)
    }
    const orphan = g.emit('tool_call', bashCall('call-gone'))
    await g.wait((f) => f.method === 'session/request_permission' && f.params.toolCall.toolCallId === 'call-gone', 'permission request')
    g.client.destroy()
    assert.deepEqual(await settle(orphan), { block: true, reason: 'ACP client disconnected' })
    assert.deepEqual(await settle(g.emit('tool_call', bashCall('call-after'))), { block: true, reason: 'ACP client unavailable' })
  } finally { g.close() }
  // A cached allow_always never outlives the client that gave it.
  const k = await withSession()
  try {
    const first = k.emit('tool_call', bashCall('call-k1'))
    k.answer(await k.wait((f) => f.method === 'session/request_permission', 'permission request'), 'allow_always')
    assert.equal(await settle(first), undefined)
    k.client.destroy()
    for (let i = 0; i < 100; i += 1) { if ((await settle(k.emit('tool_call', bashCall('probe')), 50))?.block) break; await sleep(5) }
    assert.deepEqual(await settle(k.emit('tool_call', bashCall('call-k2'))), { block: true, reason: 'ACP client unavailable' })
  } finally { k.close() }
})

test('framing: a parse error is answered, frames beyond the cap in one chunk are served, one client only, split UTF-8 survives', async () => {
  const h = await harness()
  try {
    h.client.write('{not json\n')
    const parse = await h.wait((f) => f.error?.code === -32700, 'parse error')
    assert.equal(parse.id, null)
    const pad = 'x'.repeat(200 * 1024)
    const chunk = Array.from({ length: 6 }, (_, i) => JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'initialize', params: { protocolVersion: 1, pad } })).join('\n') + '\n'
    assert.ok(Buffer.byteLength(chunk) > 1024 * 1024)
    h.client.write(chunk)
    for (let i = 0; i < 6; i += 1) await h.wait((f) => f.id === 100 + i, `initialize ${100 + i}`)
    const unknown = await h.request(9, 'session/load', {})
    assert.equal(unknown.error.code, -32601)
    const intruder = net.createConnection(h.socketPath)
    const closed = await within(new Promise((done) => { intruder.once('close', () => done(true)); intruder.once('error', () => done(true)) }), 1500, false)
    assert.equal(closed, true, 'a second client is refused')
    const still = await h.request(10, 'initialize', { protocolVersion: 1 })
    assert.equal(still.result.protocolVersion, 1)
  } finally { h.close() }
  // A UTF-8 character split across two socket chunks reaches pi whole.
  const u = await withSession()
  try {
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'A\u{1F603}B' }] } })}\n`, 'utf8')
    const cut = bytes.indexOf(Buffer.from('\u{1F603}', 'utf8')) + 2
    u.client.write(bytes.subarray(0, cut))
    await sleep(30)
    u.client.write(bytes.subarray(cut))
    for (let i = 0; i < 200 && !u.prompts.length; i += 1) await sleep(5)
    assert.deepEqual(u.prompts, [[{ type: 'text', text: 'A\u{1F603}B' }]])
  } finally { u.close() }
})

test('replay: the recorded pi-turn client frames get the response shapes the client reads', async () => {
  const h = await harness()
  try {
    const recorded = fixtureFrames('pi-turn.ndjson', 'client->agent')
    const responses = fixtureFrames('pi-turn.ndjson', 'agent->client').filter((f) => !f.method)
    for (const frame of recorded) {
      const sent = frame.method === 'session/prompt' ? { ...frame, params: { ...frame.params, sessionId: SESSION } } : frame
      h.send(sent)
      if (frame.method === 'session/prompt') {
        for (let i = 0; i < 100 && !h.prompts.length; i += 1) await sleep(5)
        h.emit('agent_before_settle', { outcome: 'completed' })
        h.emit('agent_settled')
      }
      const ours = await h.wait((f) => f.id === frame.id && !f.method, `${frame.method} response`)
      const theirs = responses.find((f) => f.id === frame.id)
      assert.equal(Boolean(ours.result), Boolean(theirs.result), frame.method)
      if (frame.method === 'initialize') assert.equal(ours.result.protocolVersion, theirs.result.protocolVersion)
      if (frame.method === 'session/new') assert.equal(typeof ours.result.sessionId, typeof theirs.result.sessionId)
      if (frame.method === 'session/prompt') assert.equal(ours.result.stopReason, theirs.result.stopReason)
    }
  } finally { h.close() }
})

test('bridge: a relative or missing CREW_PI_BIN is refused before anything is spawned', async () => {
  const dir = scratchDir('acp-bridge-')
  const recordPath = join(dir, 'record.json')
  fakePi(dir)
  for (const bin of ['fake-pi.mjs', join(dir, 'absent-pi')]) {
    const run = runBridge({ CREW_PI_BIN: bin, FAKE_PI_RECORD: recordPath, HOME: dir })
    run.child.stdin.end()
    const exit = await run.exited
    assert.equal(exit.code, 2, `CREW_PI_BIN=${bin}`)
    assert.match(run.stderr, /CREW_PI_BIN/)
    assert.equal(existsSync(recordPath), false, 'nothing was spawned')
  }
})

test('bridge: pi exiting before its socket appears returns its status, never 0, and removes the socket dir', async () => {
  const dir = scratchDir('acp-bridge-')
  const recordPath = join(dir, 'record.json')
  const run = runBridge({ CREW_PI_BIN: fakePi(dir), FAKE_PI_RECORD: recordPath, FAKE_PI_MODE: 'exit-early', HOME: dir })
  try {
    const exit = await within(run.exited, 10000, 'hung')
    assert.notEqual(exit, 'hung', 'the bridge must not wait on a close that already fired')
    assert.equal(exit.code, 7)
    const rec = readRecord(recordPath)
    assert.equal(existsSync(dirname(rec.socketPath)), false)
    assert.match(run.stderr, /exited before its ACP socket appeared/)
  } finally { run.child.kill('SIGKILL') }
  // pi exiting 0 without ever serving ACP is still a failed startup.
  const zero = runBridge({ CREW_PI_BIN: fakePi(dir), FAKE_PI_RECORD: recordPath, FAKE_PI_MODE: 'exit-zero', HOME: dir })
  try {
    const exit = await within(zero.exited, 10000, 'hung')
    assert.notEqual(exit, 'hung')
    assert.equal(exit.code, 1, 'a startup that never served ACP must not exit 0')
  } finally { zero.child.kill('SIGKILL') }
})

test('bridge: what pi forked before exiting is torn down with its process group', async () => {
  const dir = scratchDir('acp-bridge-')
  const recordPath = join(dir, 'record.json')
  const run = runBridge({ CREW_PI_BIN: fakePi(dir), FAKE_PI_RECORD: recordPath, FAKE_PI_MODE: 'fork-exit', HOME: dir })
  let descendant = null
  try {
    const exit = await within(run.exited, 10000, 'hung')
    assert.notEqual(exit, 'hung')
    assert.equal(exit.code, 7)
    descendant = readRecord(recordPath)?.descendant
    assert.ok(Number.isSafeInteger(descendant))
    let alive = true
    for (let i = 0; i < 200 && alive; i += 1) { try { process.kill(descendant, 0); await sleep(10) } catch { alive = false } }
    assert.equal(alive, false, 'the process pi forked must not outlive the bridge')
  } finally { run.child.kill('SIGKILL'); if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch {} } }
})

test('bridge: SIGTERM tears pi down and removes the socket dir', async () => {
  const dir = scratchDir('acp-bridge-')
  const recordPath = join(dir, 'record.json')
  const run = runBridge({ CREW_PI_BIN: fakePi(dir), FAKE_PI_RECORD: recordPath, FAKE_PI_MODE: 'serve', HOME: dir })
  try {
    run.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    await waitFor(() => run.stdout.includes('\n'), 'bridge connected')
    run.child.kill('SIGTERM')
    const exit = await within(run.exited, 10000, 'hung')
    assert.notEqual(exit, 'hung')
    const rec = readRecord(recordPath)
    assert.equal(rec.sigterm, true)
    assert.equal(exit.code, 5)
    assert.equal(existsSync(dirname(rec.socketPath)), false)
  } finally { run.child.kill('SIGKILL'); killRecorded(recordPath) }
})

// A fake pi that hosts the REAL extension behind a stub ExtensionAPI with pi's
// (event, ctx) convention; a prompt runs one gated bash call and reports
// whether it was blocked.
function piHost(dir) {
  const path = join(dir, 'pi-host.mjs')
  writeFileSync(path, `#!${process.execPath}
import { writeFileSync } from 'node:fs'
const { default: extension } = await import(${JSON.stringify(pathToFileURL(SERVER).href)})
const handlers = new Map()
const ctx = { sessionManager: { getSessionId: () => 'host-session' }, abort() {}, isIdle: () => true }
const emit = async (type, fields = {}) => { let last; for (const fn of handlers.get(type) || []) last = await fn({ type, ...fields }, ctx); return last }
const pi = {
  on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) },
  sendUserMessage() {
    setTimeout(async () => {
      const verdict = await emit('tool_call', { toolCallId: 'call-e2e', toolName: 'bash', input: { command: 'echo hi' } })
      if (!verdict?.block) { await emit('tool_execution_start', { toolCallId: 'call-e2e', toolName: 'bash', args: {} }); await emit('tool_execution_end', { toolCallId: 'call-e2e', toolName: 'bash', result: {}, isError: false }) }
      await emit('message_update', { message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: verdict?.block ? 'blocked' : 'ran' } })
      await emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } }] })
      await emit('agent_before_settle', { outcome: 'completed' })
      await emit('agent_settled')
    }, 0)
  },
}
extension(pi)
writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({ pid: process.pid }))
process.on('SIGTERM', async () => { await emit('session_shutdown', { reason: 'quit' }); process.exit(0) })
await emit('session_start', { reason: 'startup' })
setTimeout(() => process.exit(3), 60000).unref()
`)
  chmodSync(path, 0o755)
  return path
}

test('end to end: the unchanged acp-client drives the bridge and the real extension through gated turns', () => {
  const dir = scratchDir('acp-e2e-')
  const recordPath = join(dir, 'record.json')
  const seatRoot = join(dir, 'acp')
  mkdirSync(seatRoot, { recursive: true })
  // acp-client waits synchronously; a compressed clock bounds a broken run at
  // about 30s instead of the client's 600s request timeout.
  const origin = Date.now()
  const chunks = []
  const asked = []
  const api = acpClient({
    launch: { bin: process.execPath, args: [BRIDGE], env: { CREW_PI_BIN: piHost(dir), FAKE_PI_RECORD: recordPath, HOME: dir } },
    dir: seatRoot, cwd: dir, role: 'builder',
    sinks: { agent_message_chunk: ({ update }) => chunks.push(update.content.text) },
    onPermission: ({ toolCall, options }) => { asked.push({ toolCallId: toolCall.toolCallId, kinds: options.map((o) => o.kind) }); return asked.length === 1 ? 'reject_once' : 'allow_once' },
    deps: { now: () => origin + (Date.now() - origin) * 20 },
  })
  try {
    api.start()
    assert.equal(api.initialize().protocolVersion, ACP_PROTOCOL_VERSION)
    assert.equal(api.newSession(), 'host-session')
    const first = api.prompt([{ type: 'text', text: 'run it' }])
    assert.deepEqual(first, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 3 }, refusal: null })
    const second = api.prompt([{ type: 'text', text: 'again' }])
    assert.equal(second.stopReason, 'end_turn')
    assert.deepEqual(asked, [
      { toolCallId: 'call-e2e', kinds: PERMISSION_OPTIONS.map((o) => o.kind) },
      { toolCallId: 'call-e2e', kinds: PERMISSION_OPTIONS.map((o) => o.kind) },
    ])
    assert.deepEqual(chunks, ['blocked', 'ran'], 'reject_once blocked the first bash call, allow_once let the second run')
  } finally {
    api.close()
    killRecorded(recordPath)
  }
})
