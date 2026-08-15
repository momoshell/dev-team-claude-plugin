import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldRpcUsage, headlessRpcIo, rpcCommand, seatCommandPath, splitFrames, steerFrame } from './headless-rpc.mjs'

function fixture(options = {}) {
  const dir = options.dir || mkdtempSync(join(tmpdir(), 'headless-rpc-'))
  const paths = { dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const writes = []; const commands = []; const specs = []; const signals = []
  const kill = (pid, signal) => {
    signals.push([pid, signal])
    if (options.kill) return options.kill(pid, signal)
    if (signal !== 0) writeFileSync(join(paths.taskDir, 'headless-rpc', 'builder', 'exit'), '0')
  }
  const deps = {
    pid: options.pid ?? 700, uuid: options.uuid || (() => 'session-1'),
    spawn: () => { commands.push({ kind: 'spawn' }); return { pid: options.spawnPid ?? 701, unref() {} } }, openSync: () => 10,
    writeSync: (_fd, line) => writes.push(JSON.parse(line)), closeSync: () => {}, kill,
    existsSync: (path) => existsSync(path) || String(path).endsWith('/cmd.fifo'),
    writeFileSync, readFileSync, mkdirSync, log: () => {}, sleep: options.sleep || (() => {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
  }
  const crew = options.crew || { checkout: dir, members: { builder: { model: 'model', transport: 'headless-rpc' } } }
  const adapter = { rpcCommand: (spec) => { specs.push(spec); return rpcCommand(spec) } }
  const io = headlessRpcIo({ crew, paths, taskDir: paths.taskDir, checkout: dir, adapters: { builder: adapter }, bin: '/bin/pi', deps })
  return { dir, paths, crew, io, writes, commands, specs, signals, cleanup: () => { if (!options.dir) rmSync(dir, { recursive: true, force: true }) } }
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

test('send command channel and steer frame are exported', () => {
  const f = fixture()
  try {
    assert.ok(seatCommandPath('/t', 'builder').endsWith(join('headless-rpc', 'builder', 'cmd.fifo')))
    assert.deepEqual(steerFrame('g'), { type: 'steer', message: 'g' })
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    writeFileSync(stream, `${JSON.stringify({ type: 'response', id: 'd1-steer-1', command: 'steer', success: true })}\n`)
    assert.doesNotThrow(() => f.io.steer('builder', 'guidance'))
    const frame = f.writes.find((value) => value.type === 'steer')
    assert.deepEqual(frame, { type: 'steer', message: 'guidance', id: 'd1-steer-1' })
    void run
  } finally { f.cleanup() }
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

test('retire: a settled seat is retired and the next assignment resumes the same session with the new cell', () => {
  const f = fixture()
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    settle(f, first)
    assert.equal(f.io.wait(first.returnPath, 1).status, 'done')
    f.crew.members.builder.model = 'new-model'
    f.crew.members.builder.effort = 'high'
    const retired = f.io.retire('builder')
    assert.equal(retired.retired, true)
    const second = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, 2)
    assert.equal(f.specs.at(-1).resume, true)
    assert.equal(f.specs.at(-1).sessionId, 'session-1')
    const args = JSON.parse(readFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'cmd.json'))).args.map(String)
    assert.ok(args.includes('--session'))
    assert.ok(args.includes('session-1'))
    assert.ok(args.includes('new-model'))
    assert.ok(args.includes('--thinking'))
    assert.ok(args.includes('high'))
    assert.equal(args.includes('--session-id'), false)
    void second
  } finally { f.cleanup() }
})

test('retire: an in-flight turn is refused and the worker is left alone', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const result = f.io.retire('builder')
    assert.deepEqual(result, {
      retired: false,
      reason: 'in-flight',
      why: 'rpc seat builder has an in-flight turn; retire it at a bounce boundary',
    })
    assert.equal(f.signals.length, 0)
    settle(f, run)
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
  } finally { f.cleanup() }
})

test('retire: the reservation is released, so a fresh supervisor is not refused as rpc-session-busy', () => {
  const f = fixture()
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    settle(f, first)
    f.io.wait(first.returnPath, 1)
    assert.equal(f.io.retire('builder').retired, true)
    const second = fixture({ dir: f.dir, pid: 800, spawnPid: 801 })
    try {
      assert.doesNotThrow(() => second.io.assign({ role: 'builder', briefFile: '/brief.md' }))
      assert.equal(second.specs.at(-1).resume, true)
      assert.equal(second.specs.at(-1).sessionId, 'session-1')
    } finally { second.cleanup() }
  } finally { f.cleanup() }
})

test('retire: retiring a seat this supervisor never started is a no-op', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.io.retire('builder'), {
      retired: false,
      reason: 'not-running',
      why: 'rpc seat builder is not running; the next assignment will spawn it',
    })
    assert.equal(f.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd1')
    assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, 1)
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

test('timeout drains usage written during abort or kill before emitting', () => {
  let clock = 0; let streamPath; let exitPath; let appended = false
  const seen = []; const f = fixture({
    now: () => clock,
    sleep: (ms) => { clock += ms },
    emit: (event) => seen.push(event),
    kill: (_pid, signal) => {
      if (signal === 'SIGTERM' && !appended) {
        appended = true
        writeFileSync(streamPath, `${JSON.stringify({ type: 'message_end', message: { usage: { input: 6, output: 7, cacheRead: 8, cacheWrite: 9 } } })}\n`)
        writeFileSync(exitPath, '137')
      }
    },
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    streamPath = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    exitPath = join(f.paths.taskDir, 'headless-rpc', 'builder', 'exit')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'rpc-timeout')
    assert.deepEqual(seen.map((event) => event.usage), [{
      billed_input_tokens: 6, billed_output_tokens: 7,
      billed_cache_write_tokens: 9, billed_cache_read_tokens: 8,
    }])
  } finally { f.cleanup() }
})

test('foldRpcUsage sums pi message_end deltas and excludes replay frames', () => {
  const captured = readFileSync(new URL('../tasks/headless-worker/captures/pi-a1-json-baseline.jsonl', import.meta.url), 'utf8')
  const frames = splitFrames(Buffer.from(captured)).lines.flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  assert.deepEqual(foldRpcUsage(frames), {
    billed_input_tokens: 2443, billed_output_tokens: 54,
    billed_cache_write_tokens: 0, billed_cache_read_tokens: 0,
  })
  assert.equal(foldRpcUsage([{ type: 'turn_end', message: { usage: { input: 1, output: 2 } } }]), null)
})

test('rpc usage accumulates across polls and emits null when unmeasured', () => {
  const seen = []; let streamPath; let returnPath; let appended = false
  const f = fixture({ emit: (event) => seen.push(event), sleep: () => {
    if (appended) return
    appended = true
    writeFileSync(streamPath, `${JSON.stringify({ type: 'message_end', message: { usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } })}\n${JSON.stringify({ type: 'agent_settled' })}\n`, { flag: 'a' })
    writeFileSync(returnPath, JSON.stringify({ assignment_id: 'd1', role: 'builder', status: 'done' }))
  } })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    streamPath = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'); returnPath = run.returnPath
    writeFileSync(streamPath, `${JSON.stringify({ type: 'message_end', message: { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } })}\n`)
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
    assert.deepEqual(seen.map((event) => event.usage), [{
      billed_input_tokens: 3, billed_output_tokens: 5,
      billed_cache_write_tokens: 9, billed_cache_read_tokens: 7,
    }])
  } finally { f.cleanup() }

  const emptySeen = []; const empty = fixture({ emit: (event) => emptySeen.push(event) })
  try {
    const run = empty.io.assign({ role: 'builder', briefFile: '/brief.md' })
    settle(empty, run, [{ type: 'agent_settled' }])
    assert.equal(empty.io.wait(run.returnPath, 1).status, 'done')
    assert.deepEqual(emptySeen.map((event) => event.usage), [null])
  } finally { empty.cleanup() }
})

test('rpc crashed and settled turns emit partial usage without changing stage or outcome', () => {
  const make = (emit, settled) => {
    const f = fixture({ emit })
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const frames = [{ type: 'message_end', message: { usage: { input: 7, output: 8 } } }]
    if (settled) frames.push({ type: 'agent_settled' })
    const seat = join(f.paths.taskDir, 'headless-rpc', 'builder')
    writeFileSync(join(seat, 'stream.jsonl'), `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
    return { f, run }
  }
  const seen = []; const crashed = make((event) => seen.push(event), false)
  try {
    writeFileSync(join(crashed.f.paths.taskDir, 'headless-rpc', 'builder', 'exit'), '137')
    assert.throws(() => crashed.f.io.wait(crashed.run.returnPath, 1), (err) => err.stage === 'rpc-aborted')
    assert.deepEqual(seen.at(-1).usage, { billed_input_tokens: 7, billed_output_tokens: 8, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 })
  } finally { crashed.f.cleanup() }
  const settled = make(() => { throw new Error('emitter down') }, true)
  try {
    assert.throws(() => settled.f.io.wait(settled.run.returnPath, 1), (err) => err.stage === 'rpc-no-envelope')
  } finally { settled.f.cleanup() }
})
