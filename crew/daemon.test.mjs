import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import readline from 'node:readline'
import { Readable } from 'node:stream'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  daemon, deriveState, normalizeEvent, runChild, RUN_STATES, EVENT_KINDS,
} from './daemon.mjs'
import { splitFrames } from './headless-rpc.mjs'

function fixture({ roles = ['planner', 'builder', 'reviewer'], transport = 'headless-json' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'daemon80-'))
  const root = join(dir, 'daemon')
  const crewDir = join(dir, 'crew')
  const taskDir = join(crewDir, 'task')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(returnsDir, { recursive: true })
  const members = Object.fromEntries(roles.map((role) => [role, { model: 'x', transport }]))
  const taskReturn = join(returnsDir, 'task.json')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ task: 'daemon80', checkout: dir, roles, members, task_return: taskReturn }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  const alive = new Set([700, 900])
  const forks = []
  let clock = 1
  const deps = {
    pid: 700,
    now: () => clock++,
    uuid: (() => { let n = 0; return () => `run-${++n}` })(),
    fork(...args) { forks.push(args); return { pid: 900, on() {}, kill() {}, unref() {}, disconnect() {} } },
    kill(pid, signal) {
      if (signal === 0 && !alive.has(pid)) { const err = Error('gone'); err.code = 'ESRCH'; throw err }
      return true
    },
    setInterval: () => null,
    clearInterval: () => {},
  }
  const d = daemon({ root, deps })
  return {
    dir, root, crewDir, taskDir, returnsDir, taskReturn, d, deps, forks, alive,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function each(fn, options) {
  const f = fixture(options)
  try { return await fn(f) } finally { await f.d.stop(); f.cleanup() }
}

function request(socketPath, requestLine, expected = 1) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    const timer = setTimeout(() => { socket.destroy(); resolve(frames) }, 500)
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(frames) }
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest
      frames.push(...split.lines)
      if (frames.length >= expected) finish()
    })
    socket.on('connect', () => socket.write(requestLine))
  })
}

function jsonFrame(frame) { return JSON.parse(frame) }
function appendJournal(f, row) { writeFileSync(join(f.crewDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`, { flag: 'a' }) }

// 1. The byte splitter, rather than readline, owns LF framing.
test('splitStream keeps U+2028 inside one JSON record', async () => {
  await each(async ({ d }) => {
    await d.start()
    const payload = `${JSON.stringify({ id: 'u', cmd: 'ping', params: { note: 'a\u2028b' } })}\n`
    const rl = readline.createInterface({ input: Readable.from([Buffer.from(payload)]) })
    let readlineCount = 0
    for await (const _line of rl) readlineCount += 1
    assert.equal(readlineCount, 2)
    const frames = await request(d.socketPath, payload)
    assert.equal(frames.length, 1)
    assert.equal(jsonFrame(frames[0]).ok, true)
  })
})

// 2. Rest is carried as bytes across chunks, including a split UTF-8 scalar.
test('socket framing reassembles three chunks and a split multibyte character', async () => {
  await each(async ({ d }) => {
    await d.start()
    const payload = Buffer.from(`${JSON.stringify({ id: 'split', cmd: 'ping', params: { note: 'x☃y' } })}\n`)
    const socket = net.connect(d.socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    socket.on('data', (chunk) => { const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest; frames.push(...split.lines) })
    await new Promise((resolve) => socket.on('connect', resolve))
    const snow = Buffer.from('☃')
    const at = payload.indexOf(snow)
    socket.write(payload.subarray(0, at + 1))
    socket.write(payload.subarray(at + 1, at + 2))
    socket.write(payload.subarray(at + 2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    socket.destroy()
    assert.equal(frames.length, 1)
    assert.equal(jsonFrame(frames[0]).id, 'split')
  })
})

// 3. A live pidfile is a legible double-start refusal.
test('double start names the live pid and socket', async () => {
  await each(async ({ d, root, deps }) => {
    await d.start()
    const second = daemon({ root, deps })
    await assert.rejects(() => second.start(), (err) => err.message.includes('700') && err.message.includes(d.socketPath))
  })
})

// 4. ESRCH is the only dead answer.
test('stale ESRCH pidfile does not block start', async () => {
  await each(async ({ d, root, deps, alive }) => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'daemon.json'), JSON.stringify({ pid: 999, socket: join(root, 'daemon.sock') }))
    alive.delete(999)
    await d.start()
    assert.equal(existsSync(join(root, 'daemon.json')), true)
  })
})

// 5. stop removes both lifecycle markers and permits a fresh bind.
test('stop unlinks socket and pidfile and permits a subsequent start', async () => {
  const f = fixture()
  try {
    await f.d.start(); const socket = f.d.socketPath
    await f.d.stop()
    assert.equal(existsSync(socket), false); assert.equal(existsSync(join(f.root, 'daemon.json')), false)
    const second = daemon({ root: f.root, deps: f.deps })
    await second.start(); await second.stop()
  } finally { f.cleanup() }
})

// 6. Unknown verbs are explicit errors, never success-shaped responses.
test('unknown command carries command-named error and no result', async () => {
  await each(async ({ d }) => {
    await d.start()
    const frame = jsonFrame((await request(d.socketPath, '{"id":"x","cmd":"wat"}\n'))[0])
    assert.equal(frame.ok, false); assert.equal(frame.error.code, 'unknown-command'); assert.equal(frame.error.command, 'wat'); assert.equal('result' in frame, false)
  })
})

// 7. Every malformed request gets a parse response.
test('malformed requests are table-driven parse errors', async () => {
  await each(async ({ d }) => {
    await d.start()
    for (const line of ['{bad\n', '[1]\n', '{"id":"x"}\n', '{"id":7,"cmd":"ping"}\n']) {
      const frame = jsonFrame((await request(d.socketPath, line))[0])
      assert.equal(frame.ok, false); assert.equal(frame.error.code, 'parse'); assert.equal('result' in frame, false)
    }
  })
})

// 8. State is a closed, terminal-first query.
test('deriveState truth table is closed and terminal-first', () => {
  assert.deepEqual(RUN_STATES, ['working', 'blocked', 'done', 'dead'])
  assert.deepEqual([
    deriveState({ terminal: false, alive: true, blocked: false }),
    deriveState({ terminal: false, alive: true, blocked: true }),
    deriveState({ terminal: false, alive: false, blocked: false }),
    deriveState({ terminal: true, alive: false, blocked: false }),
    deriveState({ terminal: true, alive: true, blocked: true }),
    deriveState({ terminal: false, alive: null, blocked: false }),
  ], ['working', 'blocked', 'dead', 'done', 'done', 'working'])
})

// 9. The projection vocabulary is table-driven and drops unknown rows.
test('normalizeEvent maps the closed event table', () => {
  assert.deepEqual(EVENT_KINDS, ['started', 'tool-call', 'blocked', 'terminal-result', 'died', 'usage'])
  assert.deepEqual(normalizeEvent('daemon', { event: 'fork', run_id: 'r', pid: 1 }), { kind: 'started', scope: 'run', run_id: 'r', pid: 1 })
  assert.deepEqual(normalizeEvent('journal', { event: 'headless-spawn', role: 'builder', id: 'd1', pid: 2 }), { kind: 'started', scope: 'worker', role: 'builder', worker_id: 'd1', pid: 2 })
  assert.deepEqual(normalizeEvent('journal', { no_lead_escalation: 'mechanical' }), { kind: 'blocked', why: 'mechanical' })
  assert.deepEqual(normalizeEvent('journal', { headless_outcome: 'ok', role: 'builder', exit_code: 0, terminal_reason: 'done' }), { kind: 'terminal-result', role: 'builder', outcome: 'ok', exit_code: 0, terminal_reason: 'done' })
  assert.deepEqual(normalizeEvent('stream', { type: 'assistant', role: 'builder', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), { kind: 'tool-call', role: 'builder', tool: 'Bash' })
  assert.deepEqual(normalizeEvent('stream', { type: 'usage', role: 'builder', usage: { input_tokens: 2, output_tokens: 3 } }), { kind: 'usage', role: 'builder', input_tokens: 2, output_tokens: 3 })
  assert.deepEqual(normalizeEvent('stream', { type: 'result', role: 'builder', terminal_reason: 'done' }), { kind: 'terminal-result', role: 'builder', terminal_reason: 'done' })
  assert.equal(normalizeEvent('journal', { irrelevant: true }), null)
})

// 10. Files, not the child IPC, drive the live feed and envelope outcome.
test('enqueue forks once and projects journal, stream, and envelope evidence', async () => {
  await each(async (f) => {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir, task: 'daemon80', brief_file: join(f.dir, 'brief.md'), checkout: f.dir })
    f.d.poll()
    appendJournal(f, { event: 'headless-spawn', role: 'builder', id: 'd1', pid: 901, dir: join(f.taskDir, 'headless', 'd1') })
    mkdirSync(join(f.taskDir, 'headless', 'd1'), { recursive: true })
    writeFileSync(join(f.taskDir, 'headless', 'd1', 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })}\n${JSON.stringify({ type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } })}\n`)
    f.d.poll()
    assert.equal(f.forks.length, 1)
    assert.ok(f.d.feed(run, 0).some((event) => event.kind === 'started'))
    assert.ok(f.d.feed(run, 0).some((event) => event.kind === 'tool-call'))
    assert.ok(f.d.feed(run, 0).some((event) => event.kind === 'usage'))
    const envelope = { status: 'done', summary: 'ok' }
    writeFileSync(f.taskReturn, JSON.stringify(envelope)); f.d.poll()
    assert.equal(f.d.state({ run }).state, 'done')
    assert.equal(f.d.result({ run }).outcome, 'done')
  })
})

// Worker state is terminal only after both stream and exit evidence arrive.
test('worker state stays working until terminal result and exit marker', async () => {
  await each(async (f) => {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir });
    const dir = join(f.taskDir, 'headless', 'd1'); mkdirSync(dir, { recursive: true })
    appendJournal(f, { event: 'headless-spawn', role: 'builder', id: 'd1', pid: 901, dir })
    writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })}\n`)
    f.d.poll(); assert.equal(f.d.state({ run, worker: 'd1' }).state, 'working')
    writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'result', terminal_reason: 'done' })}\n`, { flag: 'a' }); writeFileSync(join(dir, 'exit'), '0')
    f.d.poll(); assert.equal(f.d.state({ run, worker: 'd1' }).state, 'done')
  })
})

// 11. A settled escalation is still state=done, not success.
test('idle is not success: escalation envelope still yields done only', async () => {
  await each(async (f) => {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); f.d.poll()
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'escalation' })); f.d.poll()
    const answer = f.d.state({ run })
    assert.equal(answer.state, 'done'); assert.deepEqual(Object.keys(answer), ['state'])
    assert.equal(f.d.result({ run }).outcome, 'escalation')
  })
})

// 12. Subscribers are disposable views over the in-memory projection.
test('subscriber disconnect does not mutate registry and tail replays', async () => {
  await each(async (f) => {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); f.d.poll()
    const registry = join(f.root, 'runs.jsonl'); const before = readFileSync(registry, 'utf8')
    const socket = net.connect(f.d.socketPath); await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'tail-a', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 20)); socket.destroy(); await new Promise((resolve) => setTimeout(resolve, 20))
    f.d.poll(); assert.equal(readFileSync(registry, 'utf8'), before); assert.equal(f.d.state({ run }).state, 'working')
    const feed = f.d.feed(run, 0); assert.ok(feed.length >= 1)
    const frames = await request(f.d.socketPath, `${JSON.stringify({ id: 'tail-b', cmd: 'tail', params: { run, since: 0 } })}\n`, feed.length)
    const replay = frames.map(jsonFrame).filter((frame) => frame.event).map((frame) => frame.event.kind)
    assert.deepEqual(replay, feed.map((event) => event.kind))
  })
})

// 13. Adoption tails an existing run and never forks.
test('restart adopts a live child without forking', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); f.d.poll(); await f.d.stop()
    const count = f.forks.length; const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(f.forks.length, count); assert.equal(next.state({ run }).state, 'working'); assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"adopted"/)
    await next.stop()
  } finally { f.cleanup() }
})

// 14. A dead child with no envelope is honestly orphaned.
test('restart orphans a dead child with no envelope', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); await f.d.stop(); f.alive.delete(900)
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'dead'); assert.deepEqual(next.result({ run }), { outcome: null, envelope: null, source: null, reason: 'orphaned-on-restart' }); assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"orphaned"/)
    await next.stop()
  } finally { f.cleanup() }
})

// 15. The durable envelope wins even when the driver pid is gone.
test('restart settles a dead child from its envelope', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); await f.d.stop(); f.alive.delete(900)
    const envelope = { status: 'done', summary: 'survived' }; writeFileSync(f.taskReturn, JSON.stringify(envelope))
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'done'); assert.equal(next.result({ run }).outcome, 'done'); await next.stop()
  } finally { f.cleanup() }
})

// 16. A crew directory is a single active session key.
test('enqueue twice for one crew is run-active and forks once', async () => {
  await each(async (f) => {
    await f.d.start(); await f.d.enqueue({ crew_dir: f.crewDir })
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => err.code === 'run-active')
    assert.equal(f.forks.length, 1)
  })
})

// 17/18. The runner has no pane fallback and removes lead from ctx roles.
test('runChild refuses pane seats and omits lead from the mechanical ctx', () => {
  const pane = fixture({ roles: ['builder'], transport: 'pane' })
  try {
    assert.throws(() => runChild({ crew_dir: pane.crewDir, task: 'x' }, { driveTask: () => ({ status: 'done' }), realIo: () => ({}) }), /pane.*builder/)
  } finally { pane.cleanup() }
  const lead = fixture({ roles: ['lead', 'planner', 'builder', 'reviewer'] })
  try {
    let seen
    runChild({ crew_dir: lead.crewDir, task: 'x' }, { driveTask: (ctx) => { seen = ctx; return { status: 'done' } }, realIo: () => ({}) })
    assert.ok(seen); assert.equal(seen.roles.includes('lead'), false)
  } finally { lead.cleanup() }
})

// ChildProcess errors are asynchronous and must remain inside the daemon.
test('asynchronous child spawn errors orphan only their run', async () => {
  await each(async (f) => {
    let onError
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'error') onError = fn }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start(); const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir });
    assert.equal(typeof onError, 'function'); onError(Error('EAGAIN'))
    assert.equal(f.d.state({ run }).state, 'dead'); assert.equal(f.d.result({ run }).reason.startsWith('child-spawn-error'), true)
    assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"orphaned"/)
  })
})

test('a fork with no pid is orphaned rather than adopted forever', async () => {
  const f = fixture()
  try {
    f.deps.fork = () => ({ on() {}, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start(); const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir }); await f.d.stop()
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'dead'); assert.equal(next.result({ run }).reason, 'orphaned-on-restart'); await next.stop()
  } finally { f.cleanup() }
})

test('runChild gives a task_return override precedence over crew.json', () => {
  const f = fixture(); const override = join(f.returnsDir, 'override.json')
  try {
    runChild({ crew_dir: f.crewDir, task_return: override, task: 'x' }, { driveTask: () => ({ status: 'done' }), realIo: () => ({}) })
    assert.equal(JSON.parse(readFileSync(override, 'utf8')).status, 'done'); assert.equal(existsSync(f.taskReturn), false)
  } finally { f.cleanup() }
})

test('production child preflight writes an escalation envelope for pane seats', () => {
  const f = fixture({ roles: ['builder'], transport: 'pane' })
  try {
    const result = runChild({ crew_dir: f.crewDir, task: 'x' })
    assert.equal(result.status, 'escalation'); assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'escalation')
  } finally { f.cleanup() }
})

test('headless-rpc workers are discovered from their role directories', async () => {
  await each(async (f) => {
    const rpc = fixture({ roles: ['builder'], transport: 'headless-rpc' })
    try {
      await rpc.d.start(); const { run_id: run } = rpc.d.enqueue({ crew_dir: rpc.crewDir });
      const dir = join(rpc.taskDir, 'headless-rpc', 'builder'); mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })}\n`)
      rpc.d.poll(); assert.ok(rpc.d.feed(run, 0).some((event) => event.kind === 'tool-call' && event.role === 'builder'))
    } finally { await rpc.d.stop(); rpc.cleanup() }
  })
})

// All protocol verbs beyond ping/tail are exercised through the real socket.
test('socket dispatch covers enqueue, list, state, result, untail, and stop', async () => {
  const f = fixture()
  try {
    await f.d.start()
    const enqueue = jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 'e', cmd: 'enqueue', params: { crew_dir: f.crewDir } })}\n`))[0])
    const run = enqueue.result.run_id
    assert.equal(jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 'l', cmd: 'list' })}\n`))[0]).ok, true)
    assert.equal(jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 's', cmd: 'state', params: { run } })}\n`))[0]).result.state, 'working')
    assert.equal(jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 'r', cmd: 'result', params: { run } })}\n`))[0]).result.outcome, null)
    assert.equal(jsonFrame((await request(f.d.socketPath, '{"id":"u","cmd":"untail"}\n'))[0]).result.removed, false)
    assert.equal(jsonFrame((await request(f.d.socketPath, '{"id":"x","cmd":"stop"}\n'))[0]).result.stopped, true)
  } finally { await f.d.stop(); f.cleanup() }
})

// 19. The real net server is the protocol implementation, not just a fake.
test('real unix socket answers ping and unknown command', async () => {
  await each(async ({ d }) => {
    await d.start()
    const frames = await request(d.socketPath, '{"id":"p","cmd":"ping"}\n')
    assert.equal(jsonFrame(frames[0]).ok, true)
    const unknown = jsonFrame((await request(d.socketPath, '{"id":"u","cmd":"nope"}\n'))[0])
    assert.equal(unknown.ok, false); assert.equal(unknown.error.command, 'nope')
  })
})
