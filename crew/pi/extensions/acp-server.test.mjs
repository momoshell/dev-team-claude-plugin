import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'
import { scratchDir } from '../../../test/helpers.mjs'
import { ACP_PROTOCOL_VERSION, ACP_STOP_REASONS, ACP_UPDATE_KINDS, acpClient } from '../../acp-client.mjs'
import acpServer, { PERMISSION_OPTIONS, stopReasonFor, usageFrom } from './acp-server.ts'

// Every server test drives the REAL extension the way pi does: each handler is
// called (event, ctx), ctx only as the second argument, and the client side is
// a real unix socket speaking the frames crew/acp-client.mjs writes. The bridge
// tests spawn the real bridge against a fake pi executable. No real pi, no
// network.

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'acp-server.ts')
const BRIDGE = join(HERE, '..', 'acp-bridge.mjs')
const SESSION = 'pi-session-under-test'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
// A bounded wait whose timer is cleared, so a won race never holds the file open.
function within(value, ms, fallback) {
  let timer
  const late = new Promise((done) => { timer = setTimeout(() => done(fallback), ms) })
  return Promise.race([Promise.resolve(value), late]).finally(() => clearTimeout(timer))
}
const settle = (value, ms = 1000) => within(value, ms, 'still-pending')

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
  let flushId = 0
  const flush = async () => {
    const reply = await request(`flush-${++flushId}`, 'crew/flush', {})
    assert.equal(reply.error?.code, -32601)
  }
  const answer = (req, optionId) => send({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'selected', optionId } } })
  const permissionRequests = () => frames.filter((f) => f.method === 'session/request_permission')
  const close = () => { try { client?.destroy() } catch {} emit('session_shutdown', { reason: 'quit' }) }
  return { ctx, emit, frames, send, wait, request, flush, answer, permissionRequests, prompts, open, close, socketPath, get client() { return client } }
}

async function withSession(options = {}) {
  const h = await harness(options)
  const created = await h.request(1, 'session/new', { cwd: '/', mcpServers: [] })
  assert.equal(created.result?.sessionId, SESSION)
  return h
}

const bashCall = (toolCallId, command = 'echo hi') => ({ toolCallId, toolName: 'bash', input: { command } })

test('running pi accounting resets per prompt without changing final agent_end usage', async () => {
  const h = await withSession()
  try {
    h.emit('message_end', { message: { role: 'assistant', usage: { input: 999 } } })
    for (const id of [5, 6]) {
      h.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'work' }] } })
      await h.flush()
      const message = { role: 'assistant', usage: { input: 2 } }
      h.emit('message_end', { message })
      h.emit('agent_end', { messages: [message] })
      h.emit('agent_before_settle', { outcome: 'completed' })
      h.emit('agent_settled')
      const done = await h.wait((f) => f.id === id, 'settled response')
      assert.deepEqual(done.result.usage, { inputTokens: 2 })
    }
    assert.deepEqual(h.frames.filter((f) => f.params?.update?.sessionUpdate === 'usage_update').map((f) => f.params.update.usage), [{ inputTokens: 2 }, { inputTokens: 2 }])
  } finally { h.close() }
})

test('a cancel that lands during pi prompt preflight still stops the run and blocks its tools', async () => {
  const h = await withSession()
  try {
    h.ctx.idle = true
    h.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'x' }] } })
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION } })
    await h.flush()
    assert.equal(h.frames.some((f) => f.id === 5), false, 'preflight cancellation remains unanswered without agent_settled')
    h.ctx.idle = false
    h.emit('agent_start')
    assert.equal(h.ctx.aborts, 2, 'the run that starts after the cancel is aborted on start')
    assert.deepEqual(await settle(h.emit('tool_call', bashCall('call-late'))), { block: true, reason: 'ACP prompt cancelled' })
    assert.deepEqual(await settle(h.emit('tool_call', { toolCallId: 'call-read', toolName: 'read', input: {} })), { block: true, reason: 'ACP prompt cancelled' })
    assert.equal(h.permissionRequests().length, 0)
    const busy = await h.request(6, 'session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'y' }] })
    assert.equal(busy.error.code, -32000)
    h.emit('agent_before_settle', { outcome: 'aborted' })
    h.emit('agent_settled')
    const done = await h.wait((f) => f.id === 5, 'cancelled prompt response')
    assert.equal(done.result.stopReason, 'cancelled')
    await h.flush()
    assert.equal(h.frames.filter((f) => f.id === 5).length, 1)
    h.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'z' }] } })
    for (let i = 0; i < 100 && h.prompts.length < 2; i += 1) await sleep(5)
    assert.equal(h.prompts.length, 2, 'once the cancelled run settles the session takes a prompt again')
  } finally { h.close() }
})

// Record any launch, and the descendant when testing process-group cleanup.
function fakePi(dir) {
  const path = join(dir, 'fake-pi.mjs')
  writeFileSync(path, `#!${process.execPath}
import { writeFileSync } from 'node:fs'
const record = (extra = {}) => writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify(extra))
record()
if (process.env.FAKE_PI_MODE === 'fork-exit') {
  const { spawn } = await import('node:child_process')
  const left = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  record({ descendant: left.pid })
  process.exit(7)
}
`)
  chmodSync(path, 0o755)
  return path
}

function runBridge(env) {
  const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  const run = { child, stderr: '' }
  child.stdout.resume()
  child.stderr.on('data', (d) => { run.stderr += d })
  run.exited = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })))
  return run
}

const readRecord = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const killRecorded = (path) => { const rec = readRecord(path); if (rec?.pid) { try { process.kill(rec.pid, 'SIGKILL') } catch {} } }

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
    assert.equal(reply.error.data.errorMessage, 'provider down')

    const run = async (id, batches) => {
      const count = h.prompts.length
      h.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'x' }] } })
      for (let i = 0; i < 100 && h.prompts.length === count; i += 1) await sleep(5)
      assert.equal(h.prompts.length, count + 1)
      for (const messages of batches) h.emit('agent_end', { messages })
      h.emit('agent_before_settle', { outcome: 'error' })
      h.emit('agent_settled')
      const response = await h.wait((f) => f.id === id, 'errored prompt response')
      assert.equal(response.result, undefined)
      assert.equal(response.error.code, -32603)
      assert.equal(response.error.data.errorKind, 'pi-agent-error')
      return response.error.data
    }
    const assistant = (fields = {}) => ({ role: 'assistant', stopReason: 'error', ...fields })
    assert.equal((await run(8, [
      [assistant({ errorMessage: 'older event' })],
      [assistant({ errorMessage: 'older assistant' }), assistant({ errorMessage: 'last detail' }), { role: 'toolResult', errorMessage: 'ignored' }],
    ])).errorMessage, 'last detail')
    assert.equal((await run(9, [[assistant({ errorMessage: '' })]])).errorMessage, '')
    const missing = await run(10, [
      [assistant({ errorMessage: 'older event' })],
      [assistant({ errorMessage: 'older assistant' }), assistant(), { role: 'user', errorMessage: 'ignored' }],
    ])
    assert.equal(Object.hasOwn(missing, 'errorMessage'), false)
    assert.equal(Object.hasOwn(await run(11, [[assistant()]]), 'errorMessage'), false)
  } finally { h.close() }
})

// MUTATION: dropping rawOutput loses the tool result while status alone remains green.
test('session/update carries text and thinking deltas and tool input/result under toolCallId, only ACP_UPDATE_KINDS', async () => {
  const h = await withSession()
  try {
    h.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'x' }] } })
    for (let i = 0; i < 100 && !h.prompts.length; i += 1) await sleep(5)
    h.emit('message_update', { message: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } })
    h.emit('message_update', { message: {}, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"com' } })
    h.emit('tool_execution_start', { toolCallId: 'call-u1', toolName: 'write', args: { path: 'a' } })
    h.emit('tool_execution_end', { toolCallId: 'call-u1', toolName: 'write', result: { content: [{ type: 'text', text: 'recorded output' }], details: { bytes: 42 } }, isError: false })
    h.emit('message_update', { message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'done' } })
    h.emit('agent_before_settle', { outcome: 'completed' })
    h.emit('agent_settled')
    await h.wait((f) => f.id === 5, 'prompt response')
    const updates = h.frames.filter((f) => f.method === 'session/update').map((f) => f.params.update)
    assert.deepEqual(updates, [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'tool_call', toolCallId: 'call-u1', title: 'write', kind: 'edit', status: 'in_progress', rawInput: { path: 'a' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-u1', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'recorded output' }], details: { bytes: 42 } } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    ])
    for (const u of updates) assert.ok(ACP_UPDATE_KINDS.includes(u.sessionUpdate))
    assert.ok(h.frames.filter((f) => f.method === 'session/update').every((f) => f.params.sessionId === SESSION))
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

test('end to end: acp-client drives the bridge and the real extension through gated turns', () => {
  const dir = scratchDir('acp-e2e-')
  const recordPath = join(dir, 'record.json')
  const seatRoot = join(dir, 'acp')
  mkdirSync(seatRoot, { recursive: true })
  // Leave FIFO startup on real time; compress protocol waits only after start
  // so suite load cannot shrink the 10s startup budget to 500ms.
  let origin = null
  const chunks = []
  const asked = []
  const api = acpClient({
    launch: { bin: process.execPath, args: [BRIDGE], env: { CREW_PI_BIN: piHost(dir), FAKE_PI_RECORD: recordPath, HOME: dir } },
    dir: seatRoot, cwd: dir, role: 'builder',
    sinks: { agent_message_chunk: ({ update }) => chunks.push(update.content.text) },
    onPermission: ({ toolCall, options }) => { asked.push({ toolCallId: toolCall.toolCallId, kinds: options.map((o) => o.kind) }); return asked.length === 1 ? 'reject_once' : 'allow_once' },
    deps: { now: () => origin === null ? Date.now() : origin + (Date.now() - origin) * 20, seatCommandRoot: join(dir, 'seat-runtime') },
  })
  try {
    api.start()
    origin = Date.now()
    assert.equal(api.initialize().protocolVersion, ACP_PROTOCOL_VERSION)
    assert.equal(api.newSession(), 'host-session')
    const prompt = (text) => {
      const id = api.beginPrompt([{ type: 'text', text }])
      const deadline = Date.now() + 30000
      let result = null
      while (!result && Date.now() < deadline) {
        result = api.pollPrompt(id)
        if (!result) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
      assert.ok(result, `prompt ${text} timed out`)
      return result
    }
    const first = prompt('run it')
    assert.deepEqual(first, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 3 }, refusal: null })
    const second = prompt('again')
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

test('a read-only Pi seat blocks a refused command with a reason naming its first non-read-only segment, before any ACP request', async () => {
  const h = await withSession({ env: { CREW_READ_ONLY: '1' } })
  try {
    const result = await h.emit('tool_call', bashCall('ro-1', 'git status && git reset --hard && rm -rf never'))
    assert.equal(result.block, true)
    assert.ok(result.reason.includes('git reset --hard'), result.reason)
    assert.ok(!result.reason.includes('rm -rf never'), result.reason)
    assert.equal(h.permissionRequests().length, 0)
    const safe = h.emit('tool_call', bashCall('ro-2', 'git status && git diff'))
    const req = await h.wait((f) => f.method === 'session/request_permission', 'permission request')
    h.answer(req, 'reject_once')
    assert.equal((await safe).reason, 'ACP permission rejected')
  } finally { h.close() }
})

test('a repo-writing Pi seat blocks a signal to a process it did not start with the reason, before any ACP request (#2379)', async () => {
  const h = await withSession({ env: { CREW_READ_ONLY: '0', CREW_SEAT_PID: String(process.pid) } })
  try {
    for (const command of ['pkill -f nextest', 'kill 1']) {
      const result = await Promise.race([
        h.emit('tool_call', bashCall(command, command)),
        h.wait((f) => f.method === 'session/request_permission', 'permission request', 100).then(() => 'requested', () => 'timed out'),
      ])
      assert.deepEqual(result, { block: true, reason: 'refused: this command may signal a process your own commands did not start, or the gate could not check who started it. Stop only processes your own commands started, by a pid you can read.' })
      assert.equal(h.permissionRequests().length, 0)
    }
  } finally { h.close() }
})
