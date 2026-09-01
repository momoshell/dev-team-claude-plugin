import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { EVIDENCE_KINDS, LIVENESS, reclaimStore } from './reclaim.mjs'
import {
  carriesOwnSpend, emptyTurnEnvelope, foldRpcUsage, headlessRpcIo, isBusyRefusal, PROMPT_REFUSAL_RETRIES,
  rpcCommand, seatCommandPath, SETTLE_GATE_POLLS, splitFrames, steerFrame, teardownOutcome,
} from './headless-rpc.mjs'
import { cellFailureKind } from './seat-io.mjs'

// The b200-helperdedup envelope, byte-exact: 1921 bytes, schema-shaped, and
// unparseable on ONE literal newline inside the `summary` string value.
function b200Bytes(bytes = 1921) {
  const head = '{\n  "assignment_id": "d1",\n  "role": "builder",\n  "status": "done",\n  "summary": "deduplicated the helper\nand ran the lane green: '
  const tail = '",\n  "artifacts": ["/tmp/plan.md"],\n  "details": {}\n}\n'
  const raw = `${head}${'x'.repeat(bytes - Buffer.byteLength(head) - Buffer.byteLength(tail))}${tail}`
  assert.equal(Buffer.byteLength(raw), bytes)
  assert.throws(() => JSON.parse(raw), SyntaxError)
  return raw
}

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
    spawn: () => { commands.push({ kind: 'spawn' }); return { pid: Object.hasOwn(options, 'spawnPid') ? options.spawnPid : 701, unref() {} } }, openSync: options.openSync || (() => 10),
    writeSync: (_fd, line) => writes.push(JSON.parse(line)), closeSync: () => {}, kill,
    existsSync: options.existsSync || ((path) => existsSync(path) || String(path).endsWith('/cmd.fifo')),
    readdirSync: options.readdirSync || readdirSync,
    writeFileSync: options.writeFileSync || writeFileSync, readFileSync: options.readFileSync || readFileSync, mkdirSync, log: options.log || (() => {}), sleep: options.sleep || (() => {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
  }
  const crew = options.crew || { checkout: dir, members: { builder: { model: 'model', transport: 'headless-rpc' } } }
  const adapter = { rpcCommand: (spec) => { specs.push(spec); return rpcCommand(spec) } }
  const adapterEntry = options.adapterEntry || (options.grants ? { adapter, grants: options.grants } : adapter)
  const io = headlessRpcIo({ crew, paths, taskDir: paths.taskDir, checkout: dir, adapters: { builder: adapterEntry }, bin: '/bin/pi', deps })
  return { dir, paths, crew, io, writes, commands, specs, signals, cleanup: () => { if (!options.dir) rmSync(dir, { recursive: true, force: true }) } }
}

function settle(f, run, frames = [{ type: 'agent_settled' }]) {
  writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`)
  writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
}

function b360Frames() {
  const frames = [{ type: 'agent_start' }]
  for (let turn = 1; turn <= 13; turn += 1) {
    frames.push({ type: 'turn_start' })
    frames.push({ type: 'message_start' })
    const toolName = turn === 13 ? 'grep' : 'bash'
    frames.push({ type: 'tool_execution_start', toolCallId: `call_b360_${turn}`, toolName })
    frames.push({ type: 'tool_execution_end', toolCallId: `call_b360_${turn}`, toolName, isError: false })
    frames.push({ type: 'message_end', message: { role: 'assistant' } })
  }
  frames.push({ type: 'message_update' })
  return frames
}

const STDERR_MARKER = 'PI-DYING-BREATH-b369'
const STDERR_TEXT = `${'S'.repeat(5000)}\n${STDERR_MARKER}\n`

function contextRows(rows) {
  return rows.filter((row) => row && typeof row === 'object' && row.rpc_exit_context != null)
}

function runAbortContext({ probe = 'ESRCH', log } = {}) {
  let clock = 0
  let exitPath
  let firstSleep = true
  const rows = []
  const f = fixture({
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      if (firstSleep) {
        firstSleep = false
        writeFileSync(exitPath, '143')
      }
    },
    kill: (_pid, signal) => {
      if (signal === 0) {
        const err = new Error(`probe ${probe}`)
        err.code = probe
        throw err
      }
    },
    log: log || ((row) => rows.push(row)),
  })
  const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
  const seat = join(f.paths.taskDir, 'headless-rpc', 'builder')
  exitPath = join(seat, 'exit')
  writeFileSync(join(seat, 'stream.jsonl'), `${b360Frames().map((x) => JSON.stringify(x)).join('\n')}\n`)
  writeFileSync(join(seat, 'stderr.log'), STDERR_TEXT)
  let thrown = null
  try { f.io.wait(run.returnPath, 1000) } catch (err) { thrown = err }
  const logged = contextRows(rows)
  return { f, run, thrown, rows, row: logged.at(-1) || null }
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
  const common = { bin: '/bin/pi', model: 'openai-codex/x', effort: 'high', sessionDir: '/tmp/s', sessionId: 's1', resume: true, promptFile: '/tmp/p', deny: 'Edit', env: { X: '1' } }
  const c = rpcCommand(common)
  assert.deepEqual(c.args, [
    '--mode', 'rpc', '--model', 'openai-codex/x', '--thinking', 'high', '--session-dir', '/tmp/s', '--session', 's1',
    '--append-system-prompt', '/tmp/p', '--tools', 'read,bash,edit,write,grep,find,ls', '--exclude-tools', 'edit',
    '--no-context-files', '--no-extensions', '--no-skills',
  ])
  assert.deepEqual(c.env, { X: '1' })
  assert.equal(Object.hasOwn(c.env, 'CREW_PI_AGENTS'), false)

  const grants = {
    tools: ['Task', 'Task'], extensions: ['/ext-a', '/ext-a', '/ext-b'],
    agents: [{ name: 'scout', def: '/scout.json' }], skills: [],
  }
  const granted = rpcCommand({ ...common, grants })
  assert.deepEqual(granted.args, [
    '--mode', 'rpc', '--model', 'openai-codex/x', '--thinking', 'high', '--session-dir', '/tmp/s', '--session', 's1',
    '--append-system-prompt', '/tmp/p', '--tools', 'read,bash,edit,write,grep,find,ls,Task,agent', '--exclude-tools', 'edit',
    '--no-context-files', '--no-extensions', '-e', '/ext-a', '-e', '/ext-b', '--no-skills',
  ])
  assert.equal(granted.env.X, '1')
  assert.deepEqual(JSON.parse(granted.env.CREW_PI_AGENTS), [{ name: 'scout', def: '/scout.json' }])

  const bareGrants = { tools: [], extensions: [], agents: [], skills: [] }
  const bare = rpcCommand({ ...common, grants: bareGrants })
  const skilled = rpcCommand({ ...common, grants: { ...bareGrants, skills: ['/skill.md'] } })
  const skillAt = skilled.args.indexOf('--skill')
  assert.deepEqual(skilled.args.slice(skillAt, skillAt + 2), ['--skill', '/skill.md'])
  assert.equal(skilled.args.includes('--no-skills'), false)
  for (const command of [c, bare, granted, skilled]) {
    assert.equal(command.args.some((arg) => arg === '--provider' || String(arg).startsWith('--provider=')), false)
  }

  const wrapped = fixture({ grants })
  try {
    wrapped.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.deepEqual(wrapped.specs.at(-1).grants, grants)
    const wrappedCommand = JSON.parse(readFileSync(join(wrapped.paths.taskDir, 'headless-rpc', 'builder', 'cmd.json'), 'utf8'))
    assert.equal(wrappedCommand.args[wrappedCommand.args.indexOf('--tools') + 1].split(',').includes('agent'), true)
    assert.deepEqual(wrappedCommand.args.slice(wrappedCommand.args.indexOf('-e'), wrappedCommand.args.indexOf('-e') + 2), ['-e', '/ext-a'])
  } finally { wrapped.cleanup() }

  const bareFixture = fixture()
  try {
    bareFixture.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.equal(bareFixture.specs.at(-1).grants, undefined)
    const bareCommand = JSON.parse(readFileSync(join(bareFixture.paths.taskDir, 'headless-rpc', 'builder', 'cmd.json'), 'utf8'))
    assert.equal(bareCommand.args[bareCommand.args.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls')
    assert.equal(bareCommand.args.includes('-e'), false)
  } finally { bareFixture.cleanup() }
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

test('an aborted mid-turn journals the last frame, turn, tool, gap, and stderr tail', () => {
  const result = runAbortContext()
  try {
    assert.equal(result.thrown?.stage, 'rpc-aborted')
    const rows = contextRows(result.rows)
    assert.equal(rows.length, 1)
    const row = rows[0].rpc_exit_context
    assert.equal(row.outcome, 'aborted')
    assert.equal(row.exit_code, 143)
    assert.equal(row.last_frame, 'message_update')
    assert.equal(row.turn_index, 13)
    assert.equal(row.last_tool, 'grep')
    assert.equal(row.driver_signalled, false)
    assert.equal(row.exit_signo, 15)
    assert.equal(row.exit_signal, 'SIGTERM')
    assert.equal(row.group_before_signal, 'gone')
    assert.ok(Number.isFinite(row.last_frame_at))
    assert.ok(Number.isFinite(row.exit_seen_at))
    assert.ok(row.exit_gap_ms > 0)
    assert.equal(row.exit_gap_ms, row.exit_seen_at - row.last_frame_at)
    assert.ok(row.stderr_tail.includes(STDERR_MARKER))
    assert.equal(row.stderr_bytes, Buffer.byteLength(STDERR_TEXT))
  } finally { result.f.cleanup() }
})

test('the same signal code distinguishes driver retirement from external death', () => {
  const external = runAbortContext()
  try {
    assert.equal(external.row?.rpc_exit_context?.exit_code, 143)
    assert.equal(external.row?.rpc_exit_context?.attribution, 'external-signal')
    assert.equal(external.row?.rpc_exit_context?.driver_signalled, false)
  } finally { external.f.cleanup() }

  let clock = 0
  let exitPath
  const rows = []
  const retired = fixture({
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: (_pid, signal) => { if (signal !== 0) writeFileSync(exitPath, '143') },
    log: (row) => rows.push(row),
  })
  try {
    const run = retired.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seat = join(retired.paths.taskDir, 'headless-rpc', 'builder')
    exitPath = join(seat, 'exit')
    writeFileSync(join(seat, 'stream.jsonl'), `${b360Frames().map((x) => JSON.stringify(x)).join('\n')}\n`)
    writeFileSync(join(seat, 'stderr.log'), STDERR_TEXT)
    assert.throws(() => retired.io.wait(run.returnPath, 0), (err) => err.stage === 'rpc-timeout')
    const row = contextRows(rows).at(-1)?.rpc_exit_context
    assert.equal(row.exit_code, 143)
    assert.equal(row.attribution, 'driver-retired')
    assert.equal(row.driver_signalled, true)
    assert.equal(row.group_before_signal, 'alive')
  } finally { retired.cleanup() }
})

test('an unprobeable process group is recorded as unknown, not gone or alive', () => {
  const result = runAbortContext({ probe: 'EPERM' })
  try {
    assert.equal(result.thrown?.stage, 'rpc-aborted')
    assert.equal(result.row?.rpc_exit_context?.group_before_signal, 'unknown')
  } finally { result.f.cleanup() }
})

test('a clean settled envelope adds no rpc exit-context row', () => {
  const rows = []
  const f = fixture({ log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    settle(f, run, [{ type: 'agent_end' }, { type: 'agent_settled' }])
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'exit'), '0')
    const envelope = f.io.wait(run.returnPath, 1)
    assert.equal(envelope.status, 'done')
    assert.equal(contextRows(rows).length, 0)
  } finally { f.cleanup() }
})

test('a throwing exit-context journal remains non-load-bearing', () => {
  const seen = []
  const result = runAbortContext({ log: (row) => {
    if (row && row.rpc_exit_context != null) {
      seen.push(row)
      throw new Error('B369-INSTRUMENTATION-BOOM')
    }
  } })
  try {
    assert.equal(seen.length, 1)
    assert.equal(result.thrown?.stage, 'rpc-aborted')
    assert.equal(result.thrown?.message.includes('B369-INSTRUMENTATION-BOOM'), false)
  } finally { result.f.cleanup() }
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

test('a malformed session.json starts a fresh session rather than throwing', () => {
  const f = fixture()
  try {
    const seatDir = join(f.paths.taskDir, 'headless-rpc', 'builder')
    mkdirSync(seatDir, { recursive: true })
    writeFileSync(join(seatDir, 'session.json'), '{not json')
    assert.doesNotThrow(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }))
    assert.equal(f.specs.at(-1).resume, false)
    assert.equal(f.specs.at(-1).sessionId, 'session-1')
  } finally { f.cleanup() }
})

test('a supervisor session probe that throws starts a fresh session', () => {
  const f = fixture({ existsSync(path) {
    if (String(path).endsWith('/session.json')) throw Error('probe failed')
    return existsSync(path) || String(path).endsWith('/cmd.fifo')
  } })
  try {
    assert.doesNotThrow(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }))
    assert.equal(f.specs.at(-1).resume, false)
    assert.equal(f.specs.at(-1).sessionId, 'session-1')
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

test('nextAssignmentId ignores unsafe return filenames', () => {
  const f = fixture()
  try {
    for (const name of ['d3.builder.json', 'd9007199254740993.builder.json', 'd99999999999999999999.builder.json']) {
      writeFileSync(join(f.paths.returnsDir, name), '')
    }
    assert.equal(f.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd4')
  } finally { f.cleanup() }
})

test('nextAssignmentId ignores an unsafe saved session id', () => {
  const f = fixture()
  try {
    const seatDir = join(f.paths.taskDir, 'headless-rpc', 'builder')
    mkdirSync(seatDir, { recursive: true })
    writeFileSync(join(seatDir, 'session.json'), JSON.stringify({ lastAssignmentId: 'd9007199254740993' }))
    assert.equal(f.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd1')
  } finally { f.cleanup() }
})

test('nextAssignmentId ignores an unsafe live session id', () => {
  const f = fixture({ readdirSync: (path) => String(path).endsWith('/headless-rpc') ? [] : readdirSync(path) })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.equal(first.id, 'd1')
    settle(f, first)
    assert.equal(f.io.wait(first.returnPath, 1).status, 'done')
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'session.json'), JSON.stringify({ lastAssignmentId: 'd9007199254740993' }))
    assert.equal(f.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd2')
  } finally { f.cleanup() }
})

test('nextAssignmentId refuses an unsafe next id before spawning or unlinking', () => {
  const f = fixture()
  try {
    const seed = join(f.paths.returnsDir, 'd9007199254740991.builder.json')
    writeFileSync(seed, '')
    const before = readdirSync(f.paths.returnsDir).sort()
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }), (err) => err.stage === 'rpc-assignment-id-exhausted')
    assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, 0)
    assert.deepEqual(readdirSync(f.paths.returnsDir).sort(), before)
  } finally { f.cleanup() }
})

test('nextAssignmentId advances ordinary ids and starts at d1 when empty', () => {
  const seeded = fixture()
  const empty = fixture()
  try {
    writeFileSync(join(seeded.paths.returnsDir, 'd9.builder.json'), '')
    assert.equal(seeded.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd10')
    assert.equal(empty.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd1')
  } finally {
    seeded.cleanup()
    empty.cleanup()
  }
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

test('an rpc timeout permits a same-session re-ask with a fresh return path', () => {
  let clock = 0
  const f = fixture({ now: () => clock, sleep: (ms) => { clock += ms }, kill: () => {} })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => f.io.wait(first.returnPath, 0), (err) => err.stage === 'rpc-timeout')
    const retryPath = join(f.paths.returnsDir, `${first.id}.retry.builder.json`)
    const retry = f.io.assign({ role: 'builder', briefFile: '/retry.md', reask: { id: first.id, returnPath: retryPath } })
    assert.deepEqual(retry, { id: first.id, returnPath: retryPath })
    assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, 1)
    assert.match(f.writes.at(-1).message, new RegExp(retryPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')))
  } finally { f.cleanup() }
})

test('an rpc-aborted corpse respawns and resumes the session on its fresh return path', () => {
  const f = fixture({ now: () => 0, sleep: () => {}, kill: () => {} })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seatDir = join(f.paths.taskDir, 'headless-rpc', 'builder')
    writeFileSync(join(seatDir, 'stream.jsonl'), '{"type":"assistant"}\n')
    writeFileSync(join(seatDir, 'exit'), '1')
    assert.throws(() => f.io.wait(first.returnPath, 1), (err) => err.stage === 'rpc-aborted')
    const retryPath = join(f.paths.returnsDir, `${first.id}.retry.builder.json`)
    const retry = f.io.assign({ role: 'builder', briefFile: '/retry.md', reask: { id: first.id, returnPath: retryPath } })
    assert.deepEqual(retry, { id: first.id, returnPath: retryPath })
    assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, 2)
    assert.equal(f.specs.at(-1).resume, true)
    assert.equal(f.specs.at(-1).sessionId, 'session-1')
  } finally { f.cleanup() }
})

test('a 1921-byte envelope with a literal newline is UNREADABLE, not a settled no-envelope', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    settle(f, run)
    const bytes = b200Bytes()
    writeFileSync(run.returnPath, bytes)
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => {
      assert.equal(err.stage, 'rpc-parse-error')
      assert.equal(cellFailureKind(err), 'unusable-envelope')
      assert.equal(err.role, 'builder')
      assert.equal(err.raw, bytes)
      const lie = emptyTurnEnvelope({ id: run.id, role: 'builder', returnPath: run.returnPath }).summary
      assert.equal(err.message.includes(lie), false)
      return true
    })
    assert.equal(readFileSync(run.returnPath, 'utf8'), bytes)
  } finally { f.cleanup() }
})

test('a denied read stays a re-pollable absence', () => {
  let clock = 0
  const realRead = readFileSync
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  const f = fixture({
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: () => {},
    readFileSync: (path, ...args) => {
      if (String(path).includes('/returns/')) throw denied
      return realRead(path, ...args)
    },
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => f.io.wait(run.returnPath, 30), (err) => err.stage === 'rpc-timeout')
  } finally { f.cleanup() }
})

test('a parseable envelope is returned unchanged', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    settle(f, run)
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
  } finally { f.cleanup() }
})

test('a compaction between agent_end and agent_settled does not let the next assignment prompt early', () => {
  let streamPath
  let settled = false
  const f = fixture({ sleep: () => {
    if (settled) return
    settled = true
    writeFileSync(streamPath, `${JSON.stringify({ type: 'compaction_start' })}\n${JSON.stringify({ type: 'compaction_end' })}\n${JSON.stringify({ type: 'agent_settled' })}\n`, { flag: 'a' })
  } })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    streamPath = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    writeFileSync(streamPath, [
      { type: 'message_end' }, { type: 'turn_end' }, { type: 'agent_end' },
    ].map((frame) => JSON.stringify(frame)).join('\n') + '\n')
    writeFileSync(first.returnPath, JSON.stringify({ assignment_id: first.id, role: 'builder', status: 'done' }))
    assert.equal(f.io.wait(first.returnPath, 1).status, 'done')
    const second = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.equal(second.id, 'd2')
    assert.equal(settled, true)
    assert.equal(f.writes.filter((frame) => frame.type === 'prompt').length, 2)
  } finally { f.cleanup() }
})

test('the settle gate is bounded and prompts anyway when the seat never settles', () => {
  let sleeps = 0
  const f = fixture({ sleep: () => { sleeps += 1 } })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    writeFileSync(stream, [
      { type: 'message_end' }, { type: 'turn_end' }, { type: 'agent_end' },
    ].map((frame) => JSON.stringify(frame)).join('\n') + '\n')
    writeFileSync(first.returnPath, JSON.stringify({ assignment_id: first.id, role: 'builder', status: 'done' }))
    assert.equal(f.io.wait(first.returnPath, 1).status, 'done')
    assert.doesNotThrow(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }))
    assert.ok(sleeps <= SETTLE_GATE_POLLS)
  } finally { f.cleanup() }
})

test('a prompt refused while pi is compacting is waited out and re-sent', () => {
  let streamPath
  let run
  let sleeps = 0
  const f = fixture({ sleep: () => {
    sleeps += 1
    if (sleeps === 1) writeFileSync(streamPath, `${JSON.stringify({ type: 'agent_settled' })}\n`, { flag: 'a' })
    if (sleeps === 2) writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
  } })
  try {
    run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    streamPath = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    const promptId = f.writes.find((frame) => frame.type === 'prompt')?.id
    writeFileSync(streamPath, JSON.stringify({
      type: 'response', id: promptId, command: 'prompt', success: false,
      error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    }) + '\n')
    const env = f.io.wait(run.returnPath, 1)
    assert.equal(env.status, 'done')
    assert.equal(f.writes.filter((frame) => frame.type === 'prompt').length, 2)
    assert.equal(f.writes.at(-1).id, `${run.id}-p1`)
  } finally { f.cleanup() }
})

test('a prompt failure that is not a busy refusal still fails the turn', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const promptId = f.writes.find((frame) => frame.type === 'prompt')?.id
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), `${JSON.stringify({
      type: 'response', id: promptId, command: 'prompt', success: false, error: 'model not found',
    })}\n`)
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'rpc-command-error')
    assert.equal(f.writes.filter((frame) => frame.type === 'prompt').length, 1)
  } finally { f.cleanup() }
})

test("isBusyRefusal matches pi's refusal and nothing else", () => {
  for (const [frame, expected] of [
    [{ success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." }, true],
    [{ success: false, error: 'streamingBehavior is required while compacting' }, true],
    [{ success: true, error: 'Agent is already processing' }, false],
    [{ success: false, error: 'model not found' }, false],
  ]) assert.equal(isBusyRefusal(frame), expected)
  assert.equal(PROMPT_REFUSAL_RETRIES, 2)
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
        writeFileSync(streamPath, `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 6, output: 7, cacheRead: 8, cacheWrite: 9 } } })}\n`)
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
  assert.equal(foldRpcUsage([{ type: 'turn_end', message: { role: 'assistant', usage: { input: 1, output: 2 } } }]), null)
})

// pi emits a message_end for a nested TOOL RESULT carrying that tool's own usage
// (agent-loop.js createToolResultMessage/emitToolResultMessage), and the crew's
// subagent tool returns a non-null usage on exactly that path. Folding it would
// bill a seat twice for one nested call.
const NO_ROLE_USAGE_FRAME = { type: 'message_end', message: { usage: { input: 9, output: 9 } } }

test('foldRpcUsage bills the assistant turn and excludes a nested tool result', () => {
  const own = { type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 1, cacheRead: 2, cacheWrite: 3 } } }
  const nested = { type: 'message_end', message: { role: 'toolResult', toolName: 'agent', usage: { input: 5000, output: 4000, cacheRead: 3000, cacheWrite: 2000 } } }
  const billed = {
    billed_input_tokens: 10, billed_output_tokens: 1,
    billed_cache_write_tokens: 3, billed_cache_read_tokens: 2,
  }
  // Both directions: the nested frame is excluded AND the assistant frame is
  // still folded, so this cannot be satisfied by refusing everything.
  assert.deepEqual(foldRpcUsage([own, nested]), billed)
  assert.deepEqual(foldRpcUsage([own]), billed)
  assert.equal(foldRpcUsage([nested]), null)
})

test('foldRpcUsage refuses a message_end that states no role at all', () => {
  // DECIDED, not incidental: both of pi's emitters set a role, so a role-less
  // message_end is an unrecognised frame and must never inflate a billed total
  // that prices into cost_usd. This is also the rule subagent.ts already applied,
  // which makes the two reducers identical rather than merely compatible.
  assert.equal(foldRpcUsage([NO_ROLE_USAGE_FRAME]), null)
  assert.equal(carriesOwnSpend(NO_ROLE_USAGE_FRAME), false)
})

test('rpc usage accumulates across polls and emits null when unmeasured', () => {
  const seen = []; let streamPath; let returnPath; let appended = false
  const f = fixture({ emit: (event) => seen.push(event), sleep: () => {
    if (appended) return
    appended = true
    writeFileSync(streamPath, `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } })}\n${JSON.stringify({ type: 'agent_settled' })}\n`, { flag: 'a' })
    writeFileSync(returnPath, JSON.stringify({ assignment_id: 'd1', role: 'builder', status: 'done' }))
  } })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    streamPath = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'); returnPath = run.returnPath
    writeFileSync(streamPath, `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } })}\n`)
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

test('teardownOutcome maps only positive death evidence to proven', () => {
  assert.equal(teardownOutcome('dead'), 'proven')
  assert.equal(teardownOutcome('alive'), 'failed')
  for (const value of ['unknown', undefined, 'signalled']) assert.equal(teardownOutcome(value), 'unproven')
})

test('run-end teardown records unproven when a signal is not evidence of death', () => {
  let clock = 0
  const f = fixture({
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: (_pid, signal) => {
      if (signal === 0) { const err = new Error('probe unavailable'); err.code = 'EAGAIN'; throw err }
      return true
    },
  })
  try {
    f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'pgid'), '701')
    const rows = f.io.teardown()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'builder')
    assert.equal(rows[0].outcome, 'unproven')
    assert.equal(rows[0].reason, 'probe-unknown')
    assert.equal(rows[0].forced, true)
    assert.notEqual(rows[0].outcome, 'proven')
  } finally { f.cleanup() }
})

test('run-end teardown records failed for a measured live worker', () => {
  let clock = 0
  const f = fixture({
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: (_pid, signal) => {
      if (signal === 0) { const err = new Error('worker still alive'); err.code = 'EPERM'; throw err }
      return true
    },
  })
  try {
    f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'pgid'), '701')
    const rows = f.io.teardown()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'builder')
    assert.equal(rows[0].outcome, 'failed')
    assert.equal(rows[0].reason, 'probe-alive')
    assert.equal(rows[0].forced, true)
    assert.notEqual(rows[0].outcome, 'unproven')
  } finally { f.cleanup() }
})

test('rpc crashed and settled turns emit partial usage without changing stage or outcome', () => {
  const make = (emit, settled) => {
    const f = fixture({ emit })
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const frames = [{ type: 'message_end', message: { role: 'assistant', usage: { input: 7, output: 8 } } }]
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
  const settledSeen = []
  const settled = make((event) => settledSeen.push(event), true)
  try {
    const env = settled.f.io.wait(settled.run.returnPath, 1)
    assert.equal(env.status, 'insufficient')
    assert.equal(env.role, 'builder')
    assert.equal(env.assignment_id, settled.run.id)
    assert.ok(env.summary)
    assert.deepEqual(env.artifacts, [])
    assert.equal(env.details.degraded, 'rpc-no-envelope')
    assert.ok(settledSeen.some((event) => event.kind === 'cell-failure' && event.failure === 'no-envelope'))
    assert.equal(settled.f.io.assign({ role: 'builder', briefFile: '/brief.md' }).id, 'd2')
  } finally { settled.f.cleanup() }

  const throwing = make(() => { throw new Error('emitter down') }, true)
  try {
    const env = throwing.f.io.wait(throwing.run.returnPath, 1)
    assert.equal(env.status, 'insufficient')
  } finally { throwing.f.cleanup() }
})

test('teardown forces an in-flight turn but does not mark a settled seat forced', () => {
  const inFlight = fixture()
  try {
    inFlight.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const rows = inFlight.io.teardown()
    assert.equal(rows[0].forced, true)
  } finally { inFlight.cleanup() }

  const settled = fixture()
  try {
    const run = settled.io.assign({ role: 'builder', briefFile: '/brief.md' })
    settle(settled, run)
    assert.equal(settled.io.wait(run.returnPath, 1).status, 'done')
    const rows = settled.io.teardown()
    assert.equal(rows[0].forced, false)
  } finally { settled.cleanup() }
})

test('run-end teardown refuses invalid marker pgids on both teardown paths', () => {
  for (const leg of ['seat', 'marker-only']) {
    for (const badPid of [1, 0, -5, undefined]) {
      let clock = 0
      const f = fixture({
        spawnPid: badPid,
        now: () => clock,
        sleep: (ms) => { clock += ms },
        openSync: leg === 'marker-only' ? () => { throw new Error('fifo unavailable') } : undefined,
        kill: () => true,
      })
      try {
        if (leg === 'marker-only') {
          mkdirSync(join(f.paths.taskDir, 'headless-rpc', 'builder'), { recursive: true })
          writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'pgid'), '702')
        }
        try { f.io.assign({ role: 'builder', briefFile: '/brief.md' }) }
        catch (err) { if (leg !== 'marker-only') throw err }
        const rows = f.io.teardown()
        assert.equal(rows.length, 1, `${leg}/pid=${String(badPid)} row count`)
        assert.deepEqual(f.signals.filter(([, signal]) => signal !== 0), [], `${leg}/pid=${String(badPid)} signalled`)
        assert.equal(rows[0].reason, 'invalid-pgid', `${leg}/pid=${String(badPid)} reason`)
        assert.equal(rows[0].outcome, 'unproven', `${leg}/pid=${String(badPid)} outcome`)
        assert.equal(existsSync(join(f.paths.taskDir, 'headless-rpc', '.builder.active.json')), true,
          `${leg}/pid=${String(badPid)} reservation retained`)
      } finally { f.cleanup() }
    }
  }
})

test('run-end teardown does not prove a live group from stale pgid evidence', () => {
  let clock = 0
  const f = fixture({
    spawnPid: 701,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    openSync: () => { throw new Error('fifo unavailable') },
    kill: (pid, signal) => {
      if (pid === -702 && signal === 0) {
        const err = new Error('gone')
        err.code = 'ESRCH'
        throw err
      }
      return true
    },
  })
  try {
    mkdirSync(join(f.paths.taskDir, 'headless-rpc', 'builder'), { recursive: true })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'pgid'), '702')
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }), (err) => err.stage === 'rpc-spawn-failed')
    const rows = f.io.teardown()
    assert.ok(f.signals.some(([pid, signal]) => pid === -701 && signal === 'SIGTERM'))
    assert.equal(rows.some(({ reason }) => reason === 'probe-dead'), false)
    assert.notEqual(rows[0].outcome, 'proven')
    assert.equal(rows[0].reason, 'evidence-mismatch')
    assert.equal(existsSync(join(f.paths.taskDir, 'headless-rpc', '.builder.active.json')), true)
  } finally { f.cleanup() }
})

test('run-end teardown signals a marker-only worker left by FIFO acquisition failure', () => {
  let clock = 0
  const f = fixture({
    now: () => clock,
    sleep: (ms) => { clock += ms },
    openSync: () => { throw new Error('fifo unavailable') },
    kill: (_pid, signal) => {
      if (signal === 'SIGKILL') { const err = new Error('gone'); err.code = 'ESRCH'; throw err }
      return true
    },
  })
  try {
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }), (err) => err.stage === 'rpc-spawn-failed')
    const rows = f.io.teardown()
    assert.ok(f.signals.some(([pid, signal]) => pid === -701 && signal === 'SIGTERM'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'builder')
    assert.equal(rows[0].outcome, 'proven')
  } finally { f.cleanup() }
})

test('an adopted BUSY marker keeps its reservation handle for force retirement', () => {
  const first = fixture({ kill: () => {} })
  try {
    first.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const adopted = fixture({ dir: first.dir, pid: 800, spawnPid: 801 })
    try {
      adopted.io.assign({ role: 'builder', briefFile: '/brief.md' })
      const rows = adopted.io.teardown()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].outcome, 'proven')
      assert.equal(existsSync(join(adopted.paths.taskDir, 'headless-rpc', '.builder.active.json')), false)
    } finally { adopted.cleanup() }
  } finally { first.cleanup() }
})

test('unreadable reservation records become an explicit unproven teardown row', () => {
  const f = fixture()
  const markerPath = join(f.paths.taskDir, 'headless-rpc', '.builder.active.json')
  mkdirSync(join(f.paths.taskDir, 'headless-rpc'), { recursive: true })
  writeFileSync(markerPath, '{not-json')
  try {
    const rows = f.io.teardown()
    assert.deepEqual({ role: rows[0].role, outcome: rows[0].outcome, reason: rows[0].reason }, {
      role: 'builder', outcome: 'unproven', reason: 'unreadable-reservation',
    })
  } finally { f.cleanup() }
})

test('a role with no seat and no reservation produces no teardown row', () => {
  const f = fixture()
  try { assert.deepEqual(f.io.teardown(), []) } finally { f.cleanup() }
})

test('wait timeout retains an unproven reservation and clears one proved by the exit marker', () => {
  let clock = 0
  const retained = fixture({ now: () => clock, sleep: (ms) => { clock += ms }, kill: () => true })
  try {
    const run = retained.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => retained.io.wait(run.returnPath, 1), (err) => err.stage === 'rpc-timeout')
    assert.equal(existsSync(join(retained.paths.taskDir, 'headless-rpc', '.builder.active.json')), true)
  } finally { retained.cleanup() }

  const cleared = fixture()
  try {
    const run = cleared.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => cleared.io.wait(run.returnPath, 1), (err) => err.stage === 'rpc-timeout')
    assert.equal(existsSync(join(cleared.paths.taskDir, 'headless-rpc', '.builder.active.json')), false)
  } finally { cleared.cleanup() }
})

test('run-end teardown proves a worker that survives its first SIGTERM and the old 2s deadline dead', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'headless-rpc-settle-window-'))
  const paths = { dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const bin = join(dir, 'pi')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    'let terms = 0',
    'let firstTermAt = 0',
    "process.on('SIGTERM', () => {",
    '  terms += 1',
    '  if (!firstTermAt) firstTermAt = Date.now()',
    '  if (terms >= 2 && Date.now() - firstTermAt >= 2500) process.exit(0)',
    '})',
    'process.stdin.resume()',
    "process.stdout.write('{\"type\":\"ready\"}\\n')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
  const crew = { checkout: dir, members: { builder: { model: 'model', transport: 'headless-rpc' } } }
  const pgidPath = join(paths.taskDir, 'headless-rpc', 'builder', 'pgid')
  const streamPath = join(paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
  let rows = []
  try {
    const io = headlessRpcIo({ crew, paths, taskDir: paths.taskDir, checkout: dir, adapters: null, bin, deps: { log: () => {} } })
    io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (existsSync(streamPath) && readFileSync(streamPath, 'utf8').includes('ready')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(existsSync(streamPath) && readFileSync(streamPath, 'utf8').includes('ready'), true,
      'the fake worker must announce readiness before teardown')
    rows = io.teardown()
    assert.deepEqual(rows.map(({ outcome, reason }) => ({ outcome, reason })), [{ outcome: 'proven', reason: 'exit-marker' }])
  } finally {
    try {
      const pgid = Number(String(readFileSync(pgidPath, 'utf8')).trim())
      if (Number.isSafeInteger(pgid) && pgid > 1) process.kill(-pgid, 'SIGKILL')
    } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

// Added by the orchestrator at close-out (batch eighteen, #278). Every other
// teardown test injects `kill`, and crew/reclaim.test.mjs never spawns a
// process, so the outcome mapping was pinned entirely against a fake while the
// real wiring — reclaim's pgid probe issuing kill(-pgid, 0) and reading
// ESRCH/EPERM — was pinned nowhere. That is the two-suites-fabricating-each-
// other's-artifact gap: one test has to boot the real thing and ask the
// consumer's own predicate. This is that test.
//
// Kills two mutations: mapping ALIVE to a clean outcome, and treating a
// delivered signal as proof of death (the process is signalled and the probe
// must still say ALIVE until it has actually exited).
test('a real process resolves through the real pgid probe: alive is failed, exited is proven', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'headless-rpc-realproc-'))
  const store = reclaimStore({ dir, actor: 'teardown-proof' })
  // detached: true makes the child its own process-group leader, so the group
  // id is the child pid — the same shape a seat's recorded pgid marker has.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'],
    { detached: true, stdio: 'ignore' })
  const file = join(dir, 'pgid')
  writeFileSync(file, String(child.pid))
  const evidence = { kind: EVIDENCE_KINDS.PGID, file }
  try {
    assert.equal(store.probeEvidence(evidence), LIVENESS.ALIVE,
      'a running process group must probe ALIVE through the real kill(-pgid, 0)')
    assert.equal(teardownOutcome(store.probeEvidence(evidence)), 'failed',
      'a seat whose worker is measurably alive is a FAILED teardown, never a clean one')

    const exited = once(child, 'exit')
    process.kill(-child.pid, 'SIGKILL')
    await exited

    // Poll rather than assert once: the group is gone only after the child is
    // reaped, and that is not synchronous with the exit event. A bound, so a
    // group that never dies fails the test instead of hanging it.
    const deadline = Date.now() + 5000
    let liveness = store.probeEvidence(evidence)
    while (liveness !== LIVENESS.DEAD && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      liveness = store.probeEvidence(evidence)
    }
    assert.equal(liveness, LIVENESS.DEAD,
      'an exited process group must probe DEAD through the real ESRCH path')
    assert.equal(teardownOutcome(liveness), 'proven',
      'only measured death is a proven teardown')
  } finally {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

function rpcDurabilityDocument(model = 'model') {
  return { members: { builder: { model, transport: 'headless-rpc' } }, reseated: { role: 'builder' } }
}

test('T6 rpc transport persists session state without erasing a disk reseat', () => {
  const f = fixture()
  try {
    const disk = rpcDurabilityDocument('operator-reseated-model')
    writeFileSync(join(f.dir, 'crew.json'), JSON.stringify(disk, null, 2))
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const after = JSON.parse(readFileSync(join(f.dir, 'crew.json'), 'utf8'))
    assert.equal(after.members.builder.model, 'operator-reseated-model')
    assert.deepEqual(after.reseated, { role: 'builder' })
    assert.equal(after.members.builder.session_id, 'session-1')
    assert.equal(after.members.builder.started, true)
    void run
  } finally { f.cleanup() }
})

test('T7 rpc transport journals a failed crew.json persist', () => {
  const events = []
  const realWrite = writeFileSync
  const f = fixture({
    log: (event) => events.push(event),
    writeFileSync: (path, data, options) => {
      if (String(path).includes('crew.json.tmp.')) throw new Error('simulated crew.json write failure')
      return realWrite(path, data, options)
    },
  })
  try {
    writeFileSync(join(f.dir, 'crew.json'), JSON.stringify(rpcDurabilityDocument(), null, 2))
    assert.doesNotThrow(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }))
    const failures = events.filter((event) => event.event === 'crew-json-persist-failed')
    assert.ok(failures.length >= 1)
    assert.ok(failures.every((event) => event.role === 'builder' && event.reason === 'write-failed'))
  } finally { f.cleanup() }
})

function rpcReaskFixture() {
  const f = fixture()
  const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
  const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
  writeFileSync(stream, `${JSON.stringify({ type: 'agent_settled' })}\n`)
  const malformed = b200Bytes()
  writeFileSync(first.returnPath, malformed)
  let parseError = null
  try { f.io.wait(first.returnPath, 1) } catch (err) { parseError = err }
  const reaskPath = join(f.paths.returnsDir, `${first.id}.reask.builder.json`)
  const second = f.io.assign({ role: 'builder', briefFile: '/reask.md', reask: { id: first.id, returnPath: reaskPath } })
  return { f, first, second, reaskPath, stream, malformed, parseError }
}

test("a re-ask prompts the SAME live session with the caller's logical id and path", () => {
  const r = rpcReaskFixture()
  try {
    assert.equal(r.second.id, r.first.id)
    assert.equal(r.second.returnPath, r.reaskPath)
    const prompts = r.f.writes.filter((frame) => frame.type === 'prompt')
    assert.equal(prompts.length, 2)
    assert.match(prompts[1].message, /^ASSIGNMENT d1:/)
    assert.ok(prompts[1].message.includes(r.reaskPath))
    assert.equal(r.f.commands.filter((entry) => entry.kind === 'spawn').length, 1)
  } finally { r.f.cleanup() }
})

test("a re-ask's wire id is distinct and session metadata names the physical run", () => {
  const r = rpcReaskFixture()
  try {
    const prompts = r.f.writes.filter((frame) => frame.type === 'prompt')
    assert.notEqual(prompts[0].id, prompts[1].id)
    assert.equal(prompts[0].id, 'd1')
    assert.equal(prompts[1].id, 'd2')
    const saved = JSON.parse(readFileSync(join(r.f.paths.taskDir, 'headless-rpc', 'builder', 'session.json'), 'utf8'))
    assert.equal(saved.lastAssignmentId, 'd2')
  } finally { r.f.cleanup() }
})

test("a delayed failed response for the FIRST prompt id is ignored by the re-ask turn", () => {
  const r = rpcReaskFixture()
  try {
    const firstWireId = r.f.writes.filter((frame) => frame.type === 'prompt')[0].id
    writeFileSync(r.stream, `${JSON.stringify({ type: 'response', id: firstWireId, success: false, error: 'first prompt failed late' })}\n${JSON.stringify({ type: 'agent_settled' })}\n`, { flag: 'a' })
    const envelope = { assignment_id: r.first.id, role: 'builder', status: 'done' }
    writeFileSync(r.reaskPath, JSON.stringify(envelope))
    assert.deepEqual(r.f.io.wait(r.reaskPath, 1), envelope)
  } finally { r.f.cleanup() }
})

test("a busy retry mints its id off the PHYSICAL run", () => {
  const r = rpcReaskFixture()
  try {
    const secondPrompt = r.f.writes.filter((frame) => frame.type === 'prompt')[1]
    writeFileSync(r.stream, `${JSON.stringify({
      type: 'response', id: secondPrompt.id, command: 'prompt', success: false,
      error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    })}\n${JSON.stringify({ type: 'agent_settled' })}\n`, { flag: 'a' })
    const envelope = { assignment_id: r.first.id, role: 'builder', status: 'done' }
    writeFileSync(r.reaskPath, JSON.stringify(envelope))
    assert.deepEqual(r.f.io.wait(r.reaskPath, 1), envelope)
    const prompts = r.f.writes.filter((frame) => frame.type === 'prompt')
    assert.equal(prompts.at(-1).id, 'd2-p1')
    assert.notEqual(prompts.at(-1).id, 'd1-p1')
  } finally { r.f.cleanup() }
})

test("a re-ask never unlinks the seat's original return file", () => {
  const r = rpcReaskFixture()
  try {
    assert.equal(readFileSync(r.first.returnPath, 'utf8'), r.malformed)
  } finally { r.f.cleanup() }
})
