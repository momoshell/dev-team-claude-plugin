import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessRpcIo, rpcCommand, splitFrames } from './headless-rpc.mjs'

function fixture(options = {}) {
  const dir = options.dir || mkdtempSync(join(tmpdir(), 'headless-rpc-'))
  const paths = { dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const writes = []; const commands = []; const specs = []
  const deps = {
    pid: options.pid ?? 700, uuid: options.uuid || (() => 'session-1'),
    spawn: () => { commands.push({ kind: 'spawn' }); return { pid: options.spawnPid ?? 701, unref() {} } }, openSync: () => 10,
    writeSync: (_fd, line) => writes.push(JSON.parse(line)), closeSync: () => {},
    existsSync: (path) => existsSync(path) || String(path).endsWith('/cmd.fifo'),
    writeFileSync, readFileSync, mkdirSync, log: () => {}, sleep: options.sleep || (() => {}),
    ...(options.now ? { now: options.now } : {}), ...(options.kill ? { kill: options.kill } : {}),
  }
  const crew = options.crew || { checkout: dir, members: { builder: { model: 'model', transport: 'headless-rpc' } } }
  const adapter = { rpcCommand: (spec) => { specs.push(spec); return rpcCommand(spec) } }
  const io = headlessRpcIo({ crew, paths, taskDir: paths.taskDir, checkout: dir, adapters: { builder: adapter }, bin: '/bin/pi', deps })
  return { dir, paths, crew, io, writes, commands, specs, cleanup: () => { if (!options.dir) rmSync(dir, { recursive: true, force: true }) } }
}

function settle(f, run, frames = [{ type: 'agent_settled' }]) {
  writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`)
  writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
}

test('splitFrames preserves LF framing and chunk rest', () => {
  // readline sees three records for the U+2028 trap; byte-level LF sees two.
  const payload = Buffer.from('{"message":"a\u2028b"}\n{"message":"c"}\n')
  const first = splitFrames(payload.subarray(0, 12))
  const second = splitFrames(Buffer.concat([first.rest, payload.subarray(12)]))
  assert.equal(second.lines.length, 2)
  assert.deepEqual(second.lines.map(JSON.parse), [{ message: 'a\u2028b' }, { message: 'c' }])
  assert.equal(splitFrames(Buffer.from('{"x":1}\r\n')).lines[0], '{"x":1}')
})

test('rpcCommand composes a resumable pi invocation', () => {
  const c = rpcCommand({ bin: '/bin/pi', model: 'openai-codex/x', effort: 'high', sessionDir: '/tmp/s', sessionId: 's1', resume: true, promptFile: '/tmp/p', deny: 'Edit', env: { X: '1' } })
  assert.deepEqual(c.args, ['--mode', 'rpc', '--model', 'openai-codex/x', '--thinking', 'high', '--session-dir', '/tmp/s', '--session', 's1', '--append-system-prompt', '/tmp/p', '--exclude-tools', 'edit', '--no-context-files', '--no-extensions', '--no-skills'])
})

test('recorded B6 capture remains LF-framed and carries the boundary events', () => {
  const captured = readFileSync(new URL('../tasks/headless-worker/captures/pi-b6-steer.jsonl', import.meta.url), 'utf8')
  // The capture's >>> lines are driver writes; every remaining line is a recorded pi frame.
  const frames = splitFrames(Buffer.from(captured.split(String.fromCharCode(10)).filter((line) => line.startsWith('{')).join(String.fromCharCode(10)) + String.fromCharCode(10))).lines.map(JSON.parse)
  const names = frames.map((frame) => frame.type || frame.command)
  assert.ok(names.indexOf('tool_execution_start') < names.indexOf('tool_execution_end'))
  assert.ok(names.includes('queue_update'))
  assert.ok(frames.some((frame) => frame.type === 'response' && frame.command === 'steer' && frame.success === true))
})

test('interjection boundary: steer is sent as a boundary command', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    writeFileSync(stream, `${JSON.stringify({ type: 'tool_execution_start' })}\n`)
    // A response is enough to prove the command is correlated; the tool event remains in the stream.
    writeFileSync(stream, `${JSON.stringify({ type: 'tool_execution_start' })}\n${JSON.stringify({ type: 'response', id: 'd1-steer-1', command: 'steer', success: true })}\n`, { flag: 'w' })
    assert.doesNotThrow(() => f.io.steer('builder', 'guidance'))
    assert.deepEqual(f.writes.filter((x) => x.type === 'steer').map((x) => x.message), ['guidance'])
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }), (err) => err.stage === 'rpc-session-busy')
    void run
  } finally { f.cleanup() }
})

test('abort command: abort settles before a fresh assignment', () => {
  const f = fixture()
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    writeFileSync(stream, `${JSON.stringify({ type: 'response', id: 'd1-abort-1', command: 'abort', success: true })}\n${JSON.stringify({ type: 'agent_end' })}\n${JSON.stringify({ type: 'agent_settled' })}\n`)
    assert.doesNotThrow(() => f.io.abort('builder'))
    settle(f, first)
    assert.equal(f.io.wait(first.returnPath, 1).status, 'done')
    assert.equal(f.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd2')
  } finally { f.cleanup() }
})

test('session_resume: a second supervisor uses the persisted session', () => {
  const f = fixture()
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' }); settle(f, first); f.io.wait(first.returnPath, 1)
    // A clean worker exit leaves the reservation and session metadata behind;
    // the next supervisor must clear the completed marker, then use --session.
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'exit'), '0')
    const second = fixture({ dir: f.dir, pid: 800, spawnPid: 801 })
    try {
      second.io.assign({ role: 'builder', briefFile: '/brief.md' })
      assert.equal(second.specs.at(-1).resume, true)
      assert.equal(second.specs.at(-1).sessionId, 'session-1')
    } finally { second.cleanup() }
  } finally { f.cleanup() }
})

test('durable_cursor entry_id: entries persist, resume with since, and reject unknown cursors', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    writeFileSync(stream, `${JSON.stringify({ type: 'response', id: 'd1-get_entries-1', command: 'get_entries', success: true, data: { entries: [{ id: 'e1' }], leafId: 'leaf' } })}\n`)
    f.io.entries('builder')
    assert.equal(JSON.parse(readFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'session.json'))).cursor, 'e1')
    f.io.close('builder')
    const second = fixture({ dir: f.dir, pid: 800, spawnPid: 801 })
    try {
      second.io.assign({ role: 'builder', briefFile: '/brief.md' })
      writeFileSync(stream, `${JSON.stringify({ type: 'response', id: 'd2-get_entries-1', command: 'get_entries', success: true, data: { entries: [], leafId: 'e1' } })}\n`, { flag: 'a' })
      second.io.entries('builder')
      assert.deepEqual(second.writes.find((x) => x.type === 'get_entries').since, 'e1')
      writeFileSync(stream, `${JSON.stringify({ type: 'response', id: 'd2-get_entries-2', command: 'get_entries', success: false, error: 'Entry not found: gone' })}\n`, { flag: 'a' })
      assert.throws(() => second.io.entries('builder', { since: 'gone' }), (err) => err.stage === 'rpc-command-error')
    } finally { second.cleanup() }
    void run
  } finally { f.cleanup() }
})

test('reassign: same process and exited process resume with --session', () => {
  const f = fixture()
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' }); settle(f, first); f.io.wait(first.returnPath, 1)
    const second = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.equal(second.id, 'd2')
    settle(f, second); f.io.wait(second.returnPath, 1)
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'exit'), '0')
    const restarted = fixture({ dir: f.dir, pid: 800, spawnPid: 801 })
    try {
      const third = restarted.io.assign({ role: 'builder', briefFile: '/brief.md' })
      assert.equal(third.id, 'd3')
      assert.equal(restarted.specs.at(-1).resume, true)
      assert.equal(restarted.specs.at(-1).sessionId, 'session-1')
    } finally { restarted.cleanup() }
  } finally { f.cleanup() }
})

test('agent_end alone is not completion and times out', () => {
  let clock = 0
  const f = fixture({ now: () => clock, sleep: (ms) => { clock += ms }, kill: () => {} })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), '{"type":"agent_end"}\n')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'rpc-timeout')
  } finally { f.cleanup() }
})

test('response parse and command failures are staged distinctly', () => {
  for (const [frame, stage] of [
    [{ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' }, 'rpc-parse-error'],
    [{ type: 'response', id: 'd1', command: 'unknown', success: false, error: 'Unknown command' }, 'rpc-command-error'],
  ]) {
    const f = fixture()
    try {
      const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
      writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), `${JSON.stringify(frame)}\n`)
      assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === stage)
    } finally { f.cleanup() }
  }
})

test('exit classification is independent of stream state and envelope wins', () => {
  const malformed = fixture()
  try {
    const run = malformed.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seat = join(malformed.paths.taskDir, 'headless-rpc', 'builder')
    writeFileSync(join(seat, 'stream.jsonl'), 'not json\n'); writeFileSync(join(seat, 'exit'), '0')
    assert.throws(() => malformed.io.wait(run.returnPath, 1), (err) => err.stage === 'rpc-malformed')
  } finally { malformed.cleanup() }
  const degraded = fixture()
  try {
    const run = degraded.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seat = join(degraded.paths.taskDir, 'headless-rpc', 'builder')
    writeFileSync(join(seat, 'stream.jsonl'), '{"type":"agent_settled"}\n'); writeFileSync(join(seat, 'exit'), '9')
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, status: 'done' }))
    assert.equal(degraded.io.wait(run.returnPath, 1).status, 'done')
  } finally { degraded.cleanup() }
})

test('timeout aborts in protocol before escalating the process group', () => {
  let clock = 0; const signals = []
  const f = fixture({ now: () => clock, sleep: (ms) => { clock += ms }, kill: (pid, signal) => signals.push([pid, signal]) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'rpc-timeout')
    assert.ok(f.writes.some((x) => x.type === 'abort'))
    assert.ok(signals.some(([pid, signal]) => pid === -701 && signal === 'SIGTERM'))
    assert.ok(signals.some(([pid, signal]) => pid === -701 && signal === 'SIGKILL'))
  } finally { f.cleanup() }
})
