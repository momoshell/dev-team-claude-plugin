import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { scratchDir, trackProcessGroupFile } from '../test/helpers.mjs'
import {
  ACP_CLIENT_CAPABILITIES, ACP_UPDATE_KINDS, ACP_WRITE_DEADLINE_MS, acpClient, acpSeatPaths,
} from './acp-client.mjs'
import { seatCommandPath } from './acp/wire.mjs'

// MUTATION: re-add reprove.
test('acpClient exposes no prompt, resumeSession or reprove', () => {
  const root = scratchDir('acp-client-surface-')
  try {
    const client = acpClient({ launch: { bin: '/unused', args: [] }, dir: join(root, 'acp'), cwd: root, role: 'builder' })
    for (const name of ['prompt', 'resumeSession', 'reprove']) assert.equal(name in client, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a session/new logged-out refusal carries the recorded message for provider classification', () => {
  const message = 'log in to Muse before opening a session'
  for (const [data, expectedKind, expectedMessage] of [[undefined, null, message], [{ errorKind: 'verification_required', errorMessage: 'verify' }, 'verification_required', 'verify'], [{ errorKind: 'other', errorMessage: 42 }, 'other', message]]) {
    const root = scratchDir('acp-new-refusal-'), dir = join(root, 'acp'), commandRoot = join(root, 'commands')
    const paths = acpSeatPaths(dir, 'planner', commandRoot)
    let bytes = ''
    const client = acpClient({ launch: { bin: '/unused' }, dir, cwd: root, role: 'planner', deps: {
      seatCommandRoot: commandRoot, pid: 900,
      spawn: () => ({ pid: 901, unref() {} }), openSync: () => 7, closeSync() {},
      writeSync(_fd, buffer, offset, length) {
        const frame = JSON.parse(buffer.subarray(offset, offset + length).toString())
        bytes += JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message, ...(data ? { data } : {}) } }) + '\n'
        return length
      },
      existsSync: (path) => path === paths.stream || existsSync(path),
      readFileSync: (path, ...args) => path === paths.stream ? Buffer.from(bytes) : readFileSync(path, ...args),
      kill() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
    } })
    try {
      client.start()
      assert.throws(() => client.newSession(), { reason: 'acp-protocol-mismatch', message: `acp seat planner refused session/new: ${message} [acp-protocol-mismatch]`, method: 'session/new', errorKind: expectedKind, errorMessage: expectedMessage })
    } finally { client.close(); rmSync(root, { recursive: true, force: true }) }
  }
})

// MUTATION: disable the request exit-marker branch
test('requests fail promptly on seat exit but consume final responses', () => {
  for (const method of ['initialize', 'session/new', 'session/set_mode']) {
    for (const mode of ['lost', 'queued', 'race', 'alive']) {
      const root = scratchDir('acp-exit-'), dir = join(root, 'acp'), commandRoot = join(root, 'commands')
      const paths = acpSeatPaths(dir, 'reviewer', commandRoot)
      let bytes = '', clock = 0, exited = false, pending
      const answer = (frame) => { bytes += JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frame.method === 'initialize' ? { protocolVersion: 1 } : frame.method === 'session/new' ? { sessionId: 's' } : frame.method === 'session/prompt' ? { stopReason: 'end_turn' } : {} }) + '\n' }
      const client = acpClient({ launch: { bin: '/unused', args: [] }, dir, cwd: root, role: 'reviewer', deps: {
        seatCommandRoot: commandRoot, pid: 900,
        spawn() { writeFileSync(paths.pgid, '901'); return { pid: 901, unref() {} } },
        openSync: () => 7, closeSync() {},
        writeSync(_fd, buffer, offset = 0, length = buffer.length) {
          const frame = JSON.parse(Buffer.from(buffer).subarray(offset, offset + length).toString())
          if (frame.method !== method) answer(frame)
          else { pending = frame; if (mode === 'queued') { answer(frame); exited = true } else if (mode === 'race') exited = true }
          return length
        },
        readFileSync(path, ...args) { return path === paths.stream ? Buffer.from(bytes) : readFileSync(path, ...args) },
        existsSync(path) {
          if (path === paths.stream) return true
          if (path === paths.exit) { if (mode === 'race' && pending) { answer(pending); pending = null }; return exited }
          return existsSync(path) || path === paths.fifo
        },
        now: () => clock, sleep() { clock += 1000; if (mode === 'lost' && pending) exited = true },
        kill() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }, spawnSync: () => ({ status: 1, stdout: '' }),
      } })
      try {
        client.start()
        if (method !== 'initialize') client.initialize()
        if (!['initialize', 'session/new'].includes(method)) client.newSession()
        const at = clock
        const run = () => method === 'initialize' ? client.initialize() : method === 'session/new' ? client.newSession() : client.setMode('default')
        if (mode === 'lost') {
          assert.throws(run, (error) => error.reason === 'acp-seat-closed' && error.message.includes('reviewer') && error.message.includes(method))
          assert.ok(clock - at < 10000)
        } else if (mode === 'alive') assert.throws(run, { reason: 'acp-request-timeout' })
        else assert.doesNotThrow(run)
      } finally { client.close(); rmSync(root, { recursive: true, force: true }) }
    }
  }
})

// MUTATION: reset setupDeadline on every request().
test('S2-16 setup requests share one bounded budget', () => {
  for (const answerInitialize of [false, true]) {
    const root = scratchDir('acp-setup-budget-'), dir = join(root, 'acp')
    const paths = acpSeatPaths(dir, 'builder', join(root, 'commands'))
    let clock = 0, bytes = '', pending
    const client = acpClient({ launch: { bin: '/unused', args: [] }, dir, cwd: root, role: 'builder', deps: {
      seatCommandRoot: join(root, 'commands'), pid: 900,
      spawn: () => ({ pid: 901, unref() {} }), openSync: () => 7, closeSync() {},
      writeSync(_fd, buffer, offset, length) { pending = JSON.parse(buffer.subarray(offset, offset + length).toString()); return length },
      existsSync: (path) => path === paths.stream || existsSync(path),
      readFileSync: (path, ...args) => path === paths.stream ? Buffer.from(bytes) : readFileSync(path, ...args),
      now: () => clock,
      sleep() {
        clock += 1000
        if (answerInitialize && pending?.method === 'initialize' && clock >= 100000) {
          bytes += JSON.stringify({ jsonrpc: '2.0', id: pending.id, result: { protocolVersion: 1 } }) + '\n'
          pending = null
        }
      },
      kill() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
    } })
    try {
      client.start()
      const at = clock
      if (answerInitialize) client.initialize()
      assert.throws(() => answerInitialize ? client.newSession() : client.initialize(), { reason: 'acp-request-timeout' })
      assert.ok(clock - at <= 181000, `elapsed ${clock - at}`)
    } finally { client.close(); rmSync(root, { recursive: true, force: true }) }
  }
})

// MUTATION: let setup writes use only the independent write deadline.
test('S2-16 blocked setup writes respect the shared budget and preserve torn frames', () => {
  for (const [answerAt, reason, elapsed] of [[179000, 'acp-request-timeout', 180000], [100000, 'acp-prompt-write-timeout', 130000]]) {
    const root = scratchDir('acp-setup-write-'), dir = join(root, 'acp')
    const paths = acpSeatPaths(dir, 'builder', join(root, 'commands'))
    let clock = 0, bytes = '', pending, partial = false
    const client = acpClient({ launch: { bin: '/unused' }, dir, cwd: root, deps: {
      seatCommandRoot: join(root, 'commands'), pid: 900,
      spawn: () => ({ pid: 901, unref() {} }), openSync: () => 7, closeSync() {},
      writeSync(_fd, buffer, offset, length) {
        if (!pending) { pending = JSON.parse(buffer.subarray(offset, offset + length).toString()); return length }
        if (!partial) { partial = true; return 5 }
        throw Object.assign(new Error('blocked'), { code: 'EAGAIN' })
      },
      existsSync: (path) => path === paths.stream || existsSync(path),
      readFileSync: (path, ...args) => path === paths.stream ? Buffer.from(bytes) : readFileSync(path, ...args),
      now: () => clock,
      sleep(ms) {
        clock += ms
        if (pending?.method === 'initialize' && !bytes && clock >= answerAt) bytes = JSON.stringify({ jsonrpc: '2.0', id: pending.id, result: { protocolVersion: 1 } }) + '\n'
      },
      kill() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
    } })
    try {
      client.start()
      client.initialize()
      assert.throws(() => client.newSession({ _meta: { data: 'x'.repeat(100000) } }), { reason, bytesWritten: 5 })
      assert.equal(clock, elapsed)
      assert.throws(() => client.setMode('default'), { reason: 'acp-prompt-write-timeout', bytesWritten: 0 })
    } finally { client.close(); rmSync(root, { recursive: true, force: true }) }
  }
})

// MUTATION: restore the 20-iteration fifo loop.
test('S2-17 a fifo that appears after 500 ms still starts the seat', () => {
  const root = scratchDir('acp-slow-fifo-')
  let clock = 0
  const client = acpClient({ launch: { bin: '/unused', args: [] }, dir: join(root, 'acp'), cwd: root, role: 'builder', deps: {
    seatCommandRoot: join(root, 'commands'), pid: 900,
    spawn: () => ({ pid: 901, unref() {} }),
    openSync() { if (clock < 2000) throw Object.assign(new Error('not yet'), { code: 'ENOENT' }); return 7 },
    closeSync() {}, now: () => clock, sleep: (ms) => { clock += ms },
    kill() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
  } })
  try {
    let result
    assert.doesNotThrow(() => { result = client.start() })
    assert.deepEqual(result, { pid: 901 })
  } finally { client.close(); rmSync(root, { recursive: true, force: true }) }

  const lateRoot = scratchDir('acp-late-fifo-')
  let lateClock = 0
  const late = acpClient({ launch: { bin: '/unused', args: [] }, dir: join(lateRoot, 'acp'), cwd: lateRoot, role: 'builder', deps: {
    seatCommandRoot: join(lateRoot, 'commands'), pid: 900,
    spawn: () => ({ pid: 901, unref() {} }),
    openSync() { if (lateClock === 0) throw Object.assign(new Error('not yet'), { code: 'ENOENT' }); return 7 },
    now: () => lateClock, sleep: () => { lateClock += 11000 },
    kill() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
  } })
  try { assert.throws(() => late.start(), { reason: 'acp-spawn-failed' }) } finally { late.close(); rmSync(lateRoot, { recursive: true, force: true }) }
})

const REGISTER_ROOT = fileURLToPath(new URL('..', import.meta.url))

const FIXTURES = join(REGISTER_ROOT, 'test', 'fixtures', 'acp')
const CLAUDE_AGENT = ['@agentclientprotocol', ['claude', 'agent', 'acp'].join('-')].join('/')
const PI_AGENT = ['pi', 'acp'].join('-')
const OUTCOMES = [
  ['claude-handshake.ndjson', { initialize: CLAUDE_AGENT }],
  ['pi-handshake.ndjson', { initialize: PI_AGENT }],
  ['claude-turn.ndjson', { stopReason: 'end_turn' }],
  ['claude-turn-default-denied.ndjson', { stopReason: 'end_turn' }],
  ['claude-turn-settings-ignored.ndjson', { stopReason: 'end_turn' }],
  ['claude-turn-rawsdk.ndjson', { stopReason: 'end_turn' }],
  ['claude-permission-reject.ndjson', { stopReason: 'end_turn' }],
  ['claude-permission-allow.ndjson', { stopReason: 'end_turn', permission: 'allow' }],
  ['pi-turn.ndjson', { stopReason: 'end_turn' }],
  ['claude-cancel.ndjson', { stopReason: 'cancelled', cancel: true }],
  ['pi-cancel.ndjson', { stopReason: 'cancelled', cancel: true }],
  ['claude-refusal-ratelimit.ndjson', { errorKind: 'rate_limit' }],
  ['claude-refusal-auth.ndjson', { errorKind: 'authentication_failed' }],
  ['claude-refusal-overloaded.ndjson', { errorKind: 'server_error' }],
]

function recordsFor(name) {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line))
}

function frameEqual(left, right) {
  try { assert.deepEqual(left, right); return true } catch { return false }
}

function recordedFrame(records, method) {
  return records.filter((record) => record.dir === 'client->agent')
    .map((record) => record.frame).find((frame) => frame?.method === method) || null
}

function updateCounts(records) {
  const counts = {}
  for (const record of records) {
    if (record.dir !== 'agent->client' || record.frame?.method !== 'session/update') continue
    const kind = record.frame.params?.update?.sessionUpdate
    counts[kind] = (counts[kind] || 0) + 1
  }
  return counts
}

function replay(name, options = {}) {
  const records = recordsFor(name)
  const root = scratchDir('acp-client-')
  const acpRoot = join(root, 'acp')
  const seatDir = join(acpRoot, 'builder')
  mkdirSync(seatDir, { recursive: true })
  const streamPath = join(seatDir, 'stream.jsonl')
  writeFileSync(streamPath, '')

  const sent = []
  const journal = []
  const delivered = []
  const mismatches = []
  const responseIds = new Map()
  let cursor = 0
  let clock = 1000
  let groupGone = false
  let cancelledBySink = false
  let corrupt = options.corruptAfterPrompt === true
  let promptMark = 0
  let api = null

  const emitRecordedRun = () => {
    while (cursor < records.length && records[cursor].dir !== 'client->agent') {
      const record = records[cursor++]
      if (record.dir !== 'agent->client' || !record.frame) continue
      const frame = JSON.parse(JSON.stringify(record.frame))
      if (frame.error && Object.hasOwn(options, 'refusalData')) {
        if (options.refusalData === undefined) delete frame.error.data
        else frame.error.data = options.refusalData
      }
      if (Object.hasOwn(frame, 'id') && !frame.method && responseIds.has(frame.id)) frame.id = responseIds.get(frame.id)
      appendFileSync(streamPath, `${JSON.stringify(frame)}\n`)
    }
  }

  const emitCorruptRun = () => {
    while (cursor < records.length && records[cursor].dir !== 'client->agent') {
      const record = records[cursor++]
      if (record.dir !== 'agent->client' || record.frame?.method !== 'session/update') continue
      appendFileSync(streamPath, `${JSON.stringify(record.frame)}\n{"jsonrpc":"2.0","method":\n`)
      return
    }
    appendFileSync(streamPath, '{"jsonrpc":"2.0","method":\n')
  }

  const receiveOutgoing = (line) => {
    let frame
    try { frame = JSON.parse(line) } catch {
      mismatches.push(`unparseable outgoing frame ${line}`)
      return
    }
    sent.push(frame)
    while (cursor < records.length && records[cursor].dir !== 'client->agent' && records[cursor].dir !== 'agent->client') cursor += 1
    const expected = records[cursor]
    if (!expected || expected.dir !== 'client->agent') {
      mismatches.push(`unexpected outgoing frame ${frame.method || `response ${frame.id}`}`)
      return
    }
    cursor += 1
    const wanted = expected.frame
    if (frame.method || wanted.method) {
      if (frame.method !== wanted.method) mismatches.push(`expected ${wanted.method}, found ${frame.method}`)
      if (!frameEqual(frame.params ?? null, wanted.params ?? null)) {
        mismatches.push(`params differ for ${wanted.method}`)
      }
      if (Object.hasOwn(wanted, 'id') && Object.hasOwn(frame, 'id')) responseIds.set(wanted.id, frame.id)
    } else if (!frameEqual(frame.result ?? null, wanted.result ?? null)) {
      mismatches.push(`response differs for id ${wanted.id}`)
    }
    if (frame.method === 'session/prompt') promptMark = delivered.length
    if (frame.method === 'session/prompt' && corrupt) {
      corrupt = false
      emitCorruptRun()
      return
    }
    emitRecordedRun()
  }

  const makeSink = (kind) => (payload) => {
    delivered.push({ kind, payload })
    if ((options.cancelOnFirstUpdate === true || options.cancelOnFirstUpdate === 'prompt') && !cancelledBySink) {
      cancelledBySink = true
      if (options.cancelOnFirstUpdate === 'prompt') api.cancelPrompt(out.promptId)
      else api.cancel()
    }
  }
  const sinks = Object.fromEntries([...ACP_UPDATE_KINDS, 'unknown'].map((kind) => [kind, makeSink(kind)]))
  const firstCwd = recordedFrame(records, 'session/new')?.params?.cwd ?? root
  const firstMeta = recordedFrame(records, 'session/new')?.params?._meta ?? null
  const firstPrompt = recordedFrame(records, 'session/prompt')?.params?.prompt ?? []
  const mode = recordedFrame(records, 'session/set_mode')?.params?.modeId ?? null

  const deps = {
    pid: 900,
    spawn: () => { writeFileSync(join(seatDir, 'pgid'), '901'); return { pid: 901, unref() {} } },
    openSync: () => 7,
    writeSync: (_fd, line) => receiveOutgoing(String(line)),
    closeSync: () => {},
    existsSync: (path) => existsSync(path) || String(path).endsWith('cmd.fifo'),
    // The marker is only the leader's exit; the group is gone once a signal has landed.
    kill: (target, signal) => {
      if (target !== -901) return true
      if (signal === 0) {
        if (groupGone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
        return true
      }
      writeFileSync(join(seatDir, 'exit'), '0')
      groupGone = true
      return true
    },
    now: () => { clock += 1000; return clock },
    sleep: () => {},
    log: (row) => journal.push(row),
    seatCommandRoot: join(root, 'seat-runtime'),
  }

  api = acpClient({
    launch: { bin: '/bin/false', args: [], env: {} },
    dir: acpRoot,
    cwd: firstCwd,
    role: 'builder',
    sinks,
    onPermission: options.onPermission || null,
    deps,
  })

  const out = {
    records, sent, journal, delivered, mismatches, root, acpRoot, seatDir, api,
    get promptMark() { return promptMark },
  }
  api.start()
  try { out.markerAtStart = JSON.parse(readFileSync(join(acpRoot, '.builder.active.json'), 'utf8')) } catch { out.markerAtStart = null }
  out.initialize = api.initialize()
  if (options.stopAfter === 'initialize') {
    out.teardown = api.close()
    return out
  }
  out.sessionId = api.newSession({ cwd: firstCwd, mcpServers: [], _meta: firstMeta })
  if (mode) api.setMode(mode)
  try {
    out.promptId = api.beginPrompt(firstPrompt)
    out.outcome = api.pollPrompt(out.promptId)
    if (!options.nonblocking) for (let polls = 0; polls < 100 && !out.outcome; polls += 1) out.outcome = api.pollPrompt(out.promptId)
  } catch (err) { out.promptError = err }
  if (!options.keepOpen) out.teardown = api.close()
  return out
}

function forget(run) {
  rmSync(run.root, { recursive: true, force: true })
}

function runWithCleanup(name, options, check) {
  const run = replay(name, options)
  try { return check(run) } finally { forget(run) }
}

test('beginPrompt and pollPrompt match the recorded response without blocking', () => {
  runWithCleanup('pi-turn.ndjson', { nonblocking: true }, (run) => {
    assert.equal(Number.isSafeInteger(run.promptId), true)
    assert.equal(run.outcome.stopReason, 'end_turn')
    assert.deepEqual(run.outcome.refusal, null)
    assert.equal(run.mismatches.length, 0)
  })
})

test('recorded ACP fixtures replay to their hand-written outcomes', () => {
  for (const [name, expected] of OUTCOMES) {
    runWithCleanup(name, { cancelOnFirstUpdate: expected.cancel === true, onPermission: expected.permission ? () => expected.permission : null, stopAfter: expected.initialize ? 'initialize' : undefined }, (run) => {
      assert.deepEqual(run.mismatches, [], name)
      assert.equal(run.promptError, undefined, name)
      if (expected.initialize) {
        assert.equal(run.initialize?.agentInfo?.name, expected.initialize, name)
      } else if (expected.errorKind) {
        assert.equal(run.outcome?.stopReason, null, name)
        assert.equal(run.outcome?.refusal?.errorKind, expected.errorKind, name)
      } else {
        assert.equal(run.outcome?.stopReason, expected.stopReason, name)
      }
    })
  }
})

test('initialize advertises neither filesystem access nor a terminal', () => {
  assert.deepEqual(ACP_CLIENT_CAPABILITIES, {
    fs: { readTextFile: false, writeTextFile: false }, terminal: false,
  })
  runWithCleanup('claude-handshake.ndjson', { stopAfter: 'initialize' }, (run) => {
    const initialize = run.sent.find((frame) => frame.method === 'initialize')
    assert.deepEqual(initialize?.params?.clientCapabilities, ACP_CLIENT_CAPABILITIES)
  })
})

test('cancel is a notification and the recorded turn stops as cancelled', () => {
  runWithCleanup('claude-cancel.ndjson', { cancelOnFirstUpdate: true }, (run) => {
    const cancels = run.sent.filter((frame) => frame.method === 'session/cancel')
    assert.equal(cancels.length, 1)
    assert.equal(Object.hasOwn(cancels[0], 'id'), false)
    assert.equal(cancels[0].params.sessionId, run.sessionId)
    assert.equal(run.outcome.stopReason, 'cancelled')
  })
})

test('a cancelled session refuses another prompt without sending a frame', () => {
  const run = replay('pi-cancel.ndjson', { cancelOnFirstUpdate: true })
  try {
    const before = run.sent.length
    assert.throws(() => run.api.beginPrompt([{ type: 'text', text: 'again' }]), (err) => err.reason === 'acp-session-cancelled')
    assert.equal(run.sent.length, before)
  } finally { forget(run) }
})

test('B1 accepts a new prompt after prompt cancellation settles', () => {
  const run = replay('pi-cancel.ndjson', { nonblocking: true, cancelOnFirstUpdate: 'prompt', keepOpen: true })
  try {
    let cancelledTurn = null
    for (let polls = 0; polls < 10 && !cancelledTurn; polls += 1) cancelledTurn = run.api.pollPrompt(run.promptId)
    assert.equal(cancelledTurn?.stopReason, 'cancelled')
    run.api.beginPrompt([{ type: 'text', text: 'next' }])
    assert.ok(run.sent.some((frame) => frame.method === 'session/prompt' && frame.params.prompt[0].text === 'next'))
  } finally { run.api.close(); forget(run) }
})
test('B2 sends cancellation as an idless session notification', () => {
  const run = replay('pi-cancel.ndjson', { nonblocking: true, cancelOnFirstUpdate: 'prompt', keepOpen: true })
  try {
    const cancel = run.sent.find((frame) => frame.method === 'session/cancel')
    assert.deepEqual(cancel, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: run.sessionId } })
    assert.equal(Object.hasOwn(cancel, 'id'), false)
  } finally { run.api.close(); forget(run) }
})

test('a malformed frame refuses by name and delivers no part of its batch', () => {
  runWithCleanup('claude-turn.ndjson', { corruptAfterPrompt: true }, (run) => {
    assert.equal(run.promptError?.reason, 'acp-malformed-frame')
    assert.equal(run.promptError?.message.includes('acp-malformed-frame'), true)
    assert.equal(run.delivered.slice(run.promptMark).length, 0)
  })
})

test('recorded update kinds outside the frozen set reach unknown and the journal', () => {
  const names = ['claude-turn.ndjson', 'claude-permission-allow.ndjson', 'pi-turn.ndjson']
  const wanted = ['available_commands_update', 'config_option_update', 'session_info_update']
  for (const name of names) {
    runWithCleanup(name, { onPermission: name.includes('permission') ? () => 'allow' : null }, (run) => {
      const recorded = updateCounts(run.records)
      for (const kind of wanted) {
        const count = recorded[kind] || 0
        assert.equal(run.delivered.filter((item) => item.kind === 'unknown' && item.payload.kind === kind).length, count, `${name}:${kind}`)
        assert.equal(run.journal.filter((row) => row.acp_unknown_update?.sessionUpdate === kind).length, count, `${name}:${kind}:journal`)
      }
    })
  }
})

test('each recorded update reaches its matching sink exactly once', () => {
  for (const [name, expected] of OUTCOMES) {
    if (expected.initialize || expected.cancel) continue
    runWithCleanup(name, { onPermission: expected.permission ? () => expected.permission : null }, (run) => {
      const recorded = updateCounts(run.records)
      for (const kind of ACP_UPDATE_KINDS) {
        assert.equal(run.delivered.filter((item) => item.kind === kind).length, recorded[kind] || 0, `${name}:${kind}`)
      }
    })
  }
})

test('refusal responses retain their recorded error kinds and null stop reasons', () => {
  const cases = [
    ['claude-refusal-ratelimit.ndjson', 'rate_limit'],
    ['claude-refusal-auth.ndjson', 'authentication_failed'],
    ['claude-refusal-overloaded.ndjson', 'server_error'],
  ]
  for (const [name, errorKind] of cases) {
    runWithCleanup(name, {}, (run) => {
      assert.equal(run.outcome.stopReason, null, name)
      assert.equal(run.outcome.usage, null, name)
      assert.equal(run.outcome.refusal.errorKind, errorKind, name)
    })
  }
})

test('prompt refusals preserve only string error messages in outcomes and journal', () => {
  const cases = [
    { data: { errorKind: 'rate_limit', errorMessage: 'provider unavailable' }, message: 'provider unavailable' },
    { data: { errorKind: 'rate_limit', errorMessage: '' }, message: '' },
    { data: { errorKind: 'rate_limit', errorMessage: '原因\n💥' }, message: '原因\n💥' },
    { data: undefined },
    { data: { errorKind: 'rate_limit' } },
    ...[null, 42, false, {}].map((value) => ({ data: { errorKind: 'rate_limit', errorMessage: value } })),
  ]
  for (const nonblocking of [false, true]) {
    for (const example of cases) {
      runWithCleanup('claude-refusal-ratelimit.ndjson', { nonblocking, refusalData: example.data }, (run) => {
        assert.deepEqual(run.mismatches, [])
        assert.equal(run.promptError, undefined)
        assert.equal(run.outcome.stopReason, null)
        assert.equal(run.outcome.usage, null)
        const recordedError = run.records.find((record) => record.frame?.error)?.frame.error
        const journal = run.journal.filter((row) => row.acp_turn_refused)
        assert.equal(journal.length, 1)
        for (const refusal of [run.outcome.refusal, journal[0].acp_turn_refused]) {
          assert.equal(refusal.code, recordedError.code)
          assert.equal(refusal.message, recordedError.message)
          assert.equal(refusal.errorKind, example.data?.errorKind ?? null)
          for (const value of [refusal, JSON.parse(JSON.stringify(refusal))]) {
            assert.equal(Object.hasOwn(value, 'errorMessage'), Object.hasOwn(example, 'message'))
            if (Object.hasOwn(example, 'message')) assert.equal(value.errorMessage, example.message)
          }
        }
      })
    }
  }
})

test('permission id zero is answered with reject_once by policy and with the injected option', () => {
  runWithCleanup('claude-permission-reject.ndjson', {}, (run) => {
    const answer = run.sent.find((frame) => !frame.method && Object.hasOwn(frame, 'id'))
    assert.equal(answer?.id, 0)
    assert.equal(answer?.result?.outcome?.optionId, 'reject')
    assert.equal(run.journal.find((row) => row.acp_permission)?.acp_permission.policy, 'no-lead')
  })

  let seenOptions = null
  runWithCleanup('claude-permission-allow.ndjson', { onPermission: ({ options }) => { seenOptions = options; return 'allow' } }, (run) => {
    const answer = run.sent.find((frame) => !frame.method && Object.hasOwn(frame, 'id'))
    assert.equal(answer?.id, 0)
    assert.equal(answer?.result?.outcome?.optionId, 'allow')
    assert.equal(seenOptions?.some((option) => option.kind === 'allow_once'), true)
    assert.equal(run.journal.find((row) => row.acp_permission)?.acp_permission.policy, 'injected')
  })
})

test('an absent usage field remains null on the pi turn', () => {
  runWithCleanup('pi-turn.ndjson', {}, (run) => {
    assert.equal(Object.hasOwn(run.outcome, 'usage'), true)
    assert.equal(run.outcome.usage, null)
  })
})

test('start records a running pid and close proves teardown from exit evidence', () => {
  runWithCleanup('claude-handshake.ndjson', { stopAfter: 'initialize' }, (run) => {
    assert.equal(run.markerAtStart?.phase, 'running')
    assert.equal(run.markerAtStart?.pid, 901)
    assert.deepEqual(run.teardown, { outcome: 'proven', reason: 'exit-marker' })
  })
})

test('RV1-1 reused seat reads only records appended after its launch', () => {
  const root = scratchDir('acp-reuse-')
  const acpRoot = join(root, 'acp')
  const seatDir = join(acpRoot, 'builder')
  const streamPath = join(seatDir, 'stream.jsonl')
  mkdirSync(seatDir, { recursive: true })
  const staleUpdate = {
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 'old-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } } },
  }
  const staleResponse = { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentInfo: { name: 'old initialize' } } }
  writeFileSync(streamPath, `${JSON.stringify(staleUpdate)}\n${JSON.stringify(staleResponse)}\n`)

  const sent = []
  const delivered = []
  let clock = 0
  let freshInitializePending = false
  const api = acpClient({
    launch: { bin: '/bin/false', args: [], env: {} },
    dir: acpRoot,
    cwd: root,
    role: 'builder',
    sinks: { agent_message_chunk: (payload) => delivered.push(payload) },
    deps: {
      pid: 900,
      ...exitOnSignal(seatDir, 901),
      openSync: () => 7,
      writeSync: (_fd, line) => {
        const frame = JSON.parse(String(line))
        sent.push(frame)
        if (frame.method === 'initialize') freshInitializePending = true
      },
      closeSync: () => {},
      existsSync: (path) => existsSync(path) || String(path).endsWith('cmd.fifo'),
      seatCommandRoot: join(root, 'seat-runtime'),
      now: () => { clock += 1; return clock },
      sleep: () => {
        if (!freshInitializePending) return
        freshInitializePending = false
        const freshResponse = { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentInfo: { name: 'fresh initialize' } } }
        appendFileSync(streamPath, `${JSON.stringify(freshResponse)}\n`)
      },
    },
  })

  try {
    api.start()
    const initialized = api.initialize()
    assert.equal(initialized.agentInfo.name, 'fresh initialize')
    assert.deepEqual(delivered, [])
    assert.equal(sent.filter((frame) => frame.method === 'initialize').length, 1)
  } finally {
    api.close()
    rmSync(root, { recursive: true, force: true })
  }
})

const imports = /\b(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)['"]([^'"\n\r]*)['"]/g

function checkImports(source, file) {
  // Keep quoted strings intact when stripping comments (for example, URLs).
  source = source.replace(/(?:'[^'\\]*(?:\\[\s\S][^'\\]*)*'|"[^"\\]*(?:\\[\s\S][^"\\]*)*"|`[^`\\]*(?:\\[\s\S][^`\\]*)*`)|(\/\*[\s\S]*?\*\/|\/\/[^\n\r]*)/g, (text, comment) => comment ? ' ' : text)
  // Comments left in templates can hide an import in an interpolation; refuse them.
  assert.doesNotMatch(source, /\b(?:import|require|from)\s*(?:\/\*|\/\/)/, `${file}: comment-separated import in template`)
  // Require a complete literal argument, not a literal prefix of an expression.
  for (const match of source.matchAll(/\bimport\s*\(/g)) {
    assert.match(source.slice(match.index + match[0].length), /^\s*(['"])[^'"\n\r]+\1\s*\)/, `${file}: nonliteral dynamic import`)
  }
  for (const match of source.matchAll(imports)) {
    assert.match(match[1], /^(?:node:|\.\.?\/)/, `${file}: ${match[1]}`)
  }
}

test('matched literal imports are built-in or relative and the package has no runtime dependencies', () => {
  const packageJson = JSON.parse(readFileSync(join(REGISTER_ROOT, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false)
  for (const dir of ['crew', 'scripts']) {
    for (const entry of readdirSync(join(REGISTER_ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:mjs|ts)$/.test(entry.name) || /\.test\.(?:mjs|ts)$/.test(entry.name)) continue
      const file = join(entry.parentPath, entry.name)
      checkImports(readFileSync(file, 'utf8'), file)
    }
  }
})

test('import boundary rejects comment-separated package and nonliteral imports', () => {
  for (const source of [
    "const dep = await import /* reason */ ('some-package')",
    "import /* reason */ 'some-package'",
    "import'some-package'",
    "const dep = require ('some-package')",
    "import ''",
    "const dep = require('')",
    "const marker = 1; import 'some-package'",
    "if (true) {} export { value } from 'some-package'",
    "export { value } /* reason */ from 'some-package'",
    "export { value } from // reason\n 'some-package'",
    "const dep = await import /* reason */ (name)",
    'const label = `${await import /* reason */ ("some-package")}`',
    'const label = `${await import // reason\n ("some-package")}`',
  ]) assert.throws(() => checkImports(source, 'fixture.mjs'))
  for (const source of [
    "const dep = await import /* reason */ ('node:fs')",
    "import /* reason */ './local.mjs'",
    "const dep = require ('node:fs')",
    "export const marker = 'some-package'; const url = import.meta.url",
  ]) assert.doesNotThrow(() => checkImports(source, 'fixture.mjs'))
})

// MUTATION: unlink the legacy rpc/<role>/cmd.fifo in start().
test('start leaves a file at the legacy in-crew command path in place', () => {
  const root = scratchDir('acp-legacy-')
  const runtime = scratchDir('acp-runtime-')
  const acpRoot = join(root, 'acp')
  let groupGone = false
  let api
  try {
    mkdirSync(join(acpRoot, 'builder'), { recursive: true })
    writeFileSync(join(acpRoot, 'builder', 'stream.jsonl'), '')
    api = acpClient({
      launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder', sinks: {},
      deps: {
        pid: 900,
        spawn: () => { writeFileSync(join(acpRoot, 'builder', 'pgid'), '901'); return { pid: 901, unref() {} } },
        openSync: () => 7, writeSync: () => {}, closeSync: () => {},
        kill: (target, signal) => {
          if (target !== -901) return true
          if (signal === 0 && groupGone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
          if (signal !== 0) { writeFileSync(join(acpRoot, 'builder', 'exit'), '0'); groupGone = true }
          return true
        },
        now: () => Date.now(), sleep: () => {}, log: () => {}, seatCommandRoot: runtime,
      },
    })
    const stale = join(root, 'rpc', 'builder', 'cmd.fifo')
    mkdirSync(dirname(stale), { recursive: true })
    writeFileSync(stale, '')
    api.start()
    assert.equal(existsSync(stale), true)
  } finally {
    api?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(runtime, { recursive: true, force: true })
  }
})

test('E1 uses the shared seat command path and handles a dead group', () => {
  const root = scratchDir('acp-e1-parity-')
  const parityRuntime = scratchDir('acp-runtime-')
  try {
    const acpRoot = join(root, 'acp')
    assert.equal(acpSeatPaths(acpRoot, 'builder', parityRuntime).fifo, seatCommandPath(root, 'builder', parityRuntime))
    assert.equal(acpSeatPaths(acpRoot, 'builder', parityRuntime).fifo.startsWith(join(acpRoot, 'builder')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  let groupGone = false
  const deadRoot = scratchDir('acp-e1-dead-')
  const deadRuntime = scratchDir('acp-runtime-')
  try {
    const acpRoot = join(deadRoot, 'acp')
    mkdirSync(join(acpRoot, 'builder'), { recursive: true })
    writeFileSync(join(acpRoot, 'builder', 'stream.jsonl'), '')
    const fifo = acpSeatPaths(acpRoot, 'builder', deadRuntime).fifo
    const api = acpClient({
      launch: { bin: '/bin/false', args: [], env: {} },
      dir: acpRoot,
      cwd: deadRoot,
      role: 'builder',
      sinks: {},
      deps: {
        pid: 900,
        spawn: () => { writeFileSync(join(acpRoot, 'builder', 'pgid'), '901'); return { pid: 901, unref() {} } },
        openSync: () => 7,
        writeSync: () => {},
        closeSync: () => {},
        kill: (target, signal) => {
          if (target !== -901) return true
          if (signal === 0 && groupGone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
          if (signal !== 0) { writeFileSync(join(acpRoot, 'builder', 'exit'), '0'); groupGone = true }
          return true
        },
        now: () => Date.now(),
        sleep: () => {},
        log: () => {},
        seatCommandRoot: deadRuntime,
      },
    })
    api.start()
    assert.equal(existsSync(dirname(fifo)), true)
    writeFileSync(fifo, '')
    const result = api.close()
    assert.equal(result.outcome, 'proven')
    assert.equal(existsSync(fifo), false)
    assert.equal(existsSync(dirname(fifo)), false)
    assert.equal(existsSync(dirname(dirname(fifo))), false)
  } finally {
    rmSync(deadRoot, { recursive: true, force: true })
  }

  let clock = 0
  const heldRoot = scratchDir('acp-e1-held-')
  const heldRuntime = scratchDir('acp-runtime-')
  try {
    const acpRoot = join(heldRoot, 'acp')
    mkdirSync(join(acpRoot, 'builder'), { recursive: true })
    writeFileSync(join(acpRoot, 'builder', 'stream.jsonl'), '')
    const fifo = acpSeatPaths(acpRoot, 'builder', heldRuntime).fifo
    const api = acpClient({
      launch: { bin: '/bin/false', args: [], env: {} },
      dir: acpRoot,
      cwd: heldRoot,
      role: 'builder',
      sinks: {},
      deps: {
        pid: 900,
        spawn: () => ({ pid: 901, unref() {} }),
        openSync: () => 7,
        writeSync: () => {},
        closeSync: () => {},
        kill: () => true,
        spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
        now: () => clock++,
        sleep: () => {},
        log: () => {},
        seatCommandRoot: heldRuntime,
      },
    })
    api.start()
    assert.equal(existsSync(dirname(fifo)), true)
    writeFileSync(fifo, '')
    const result = api.close()
    assert.notEqual(result.outcome, 'proven')
    assert.equal(existsSync(fifo), true)
  } finally {
    rmSync(heldRoot, { recursive: true, force: true })
  }
})

// MUTATION RV1-1: deleting the rmdir binding leaves the empty runtime dirs after close.
test('RV1-1 runtime cleanup removes role and lane dirs only after proven ACP death', () => {
  {
    const root = scratchDir('acp-runtime-cleanup-')
    const acpRoot = join(root, 'acp')
    const runtimeRoot = join(root, 'seat-runtime')
    const paths = acpSeatPaths(acpRoot, 'builder', runtimeRoot)
    let clock = 0
    let groupGone = false
    const api = acpClient({
      launch: { bin: '/bin/false', args: [], env: {} },
      dir: acpRoot, cwd: root,
      deps: {
        pid: 900, spawn: () => { writeFileSync(paths.pgid, '901'); return { pid: 901, unref() {} } }, openSync: () => 7,
        writeSync: () => {}, closeSync: () => {}, kill: groupKill(() => groupGone),
        spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
        now: () => clock++, sleep: () => {}, seatCommandRoot: runtimeRoot,
      },
    })
    try {
      api.start()
      writeFileSync(paths.fifo, '')
      writeFileSync(paths.exit, '0'); groupGone = true
      const closed = api.close()
      assert.equal(closed.outcome, 'proven')
      for (const path of [paths.fifo, dirname(paths.fifo), dirname(dirname(paths.fifo))]) assert.equal(existsSync(path), false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('FO5 ACP production layout resolves under the runtime root outside the crew dir', () => {
  const crewRoot = scratchDir('acp-fo5-')
  const runtimeRoot = scratchDir('acp-fo5-runtime-')
  try {
    const fifo = acpSeatPaths(join(crewRoot, 'task', 'acp'), 'builder', runtimeRoot).fifo
    assert.equal(fifo, seatCommandPath(join(crewRoot, 'task'), 'builder', runtimeRoot))
    assert.equal(fifo.startsWith(runtimeRoot), true)
    assert.equal(fifo.startsWith(crewRoot), false)
  } finally {
    rmSync(crewRoot, { recursive: true, force: true })
  }
})

// Probe of the seat's group (-901, signal 0): live until the test says it is gone. Signals never end it.
function groupKill(gone) {
  return (target, signal) => {
    if (target === -901 && signal === 0 && gone()) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    return true
  }
}

// A seat whose leader already exited (marker written) while `group` says what the rest of its process group is doing.
function exitedLeader({ group = 'live', dies = null }) {
  const root = scratchDir('acp-liveness-')
  const acpRoot = join(root, 'acp')
  const runtimeRoot = join(root, 'seat-runtime')
  const paths = acpSeatPaths(acpRoot, 'builder', runtimeRoot)
  const signals = []
  let clock = 0
  let state = group
  const api = acpClient({
    launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root,
    deps: {
      pid: 900, spawn: () => { writeFileSync(paths.pgid, '901'); writeFileSync(paths.exit, '0'); return { pid: 901, unref() {} } },
      openSync: () => 7, writeSync: () => {}, closeSync: () => {}, seatCommandRoot: runtimeRoot,
      kill: (target, signal) => {
        if (target !== -901) return true
        if (signal !== 0) {
          signals.push(signal)
          if (signal === dies) state = 'gone'
          return true
        }
        if (state === 'gone') throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
        if (state === 'eperm' || state === 'eio') throw Object.assign(new Error(state), { code: state.toUpperCase() })
        return true
      },
      spawnSync: () => ({ status: 0, stdout: state === 'gone' ? '' : '901 Zs\n901 S\n' }),
      now: () => clock++, sleep: (ms) => { clock += ms }, log: () => {},
    },
  })
  api.start()
  writeFileSync(paths.fifo, '')
  return { api, paths, signals, root, end() { state = 'gone' }, cleanup() { rmSync(root, { recursive: true, force: true }) } }
}

test('RW2 a teardown signals what remains of the seat group after the leader exits, TERM then KILL', () => {
  for (const [dies, expected] of [['SIGTERM', ['SIGTERM']], ['SIGKILL', ['SIGTERM', 'SIGKILL']]]) {
    const run = exitedLeader({ dies })
    try {
      assert.equal(existsSync(run.paths.exit), true)
      assert.deepEqual(run.api.close(), { outcome: 'proven', reason: 'exit-marker' })
      assert.deepEqual(run.signals, expected)
    } finally { run.cleanup() }
  }
})

test('RW2 a seat whose group is already gone is proven without a signal', () => {
  const run = exitedLeader({ group: 'gone' })
  try {
    assert.deepEqual(run.api.close(), { outcome: 'proven', reason: 'exit-marker' })
    assert.deepEqual(run.signals, [])
  } finally { run.cleanup() }
})

test('RW3 the exit marker alone never proves a teardown: a live, EPERM or unknown group keeps its evidence', () => {
  for (const [group, outcome] of [['live', 'failed'], ['eperm', 'failed'], ['eio', 'unproven']]) {
    const run = exitedLeader({ group })
    try {
      const closed = run.api.close()
      assert.equal(closed.outcome, outcome, group)
      assert.deepEqual(run.signals, ['SIGTERM', 'SIGKILL'], group)
      for (const path of [run.paths.fifo, join(dirname(run.paths.dir), '.builder.active.json')]) assert.equal(existsSync(path), true, group)
      assert.deepEqual(run.api.close(), closed, 'a second close repeats the first')
    } finally { run.cleanup() }
  }
})

test('RW3 a zombie leader beside a live peer is not a dead group', () => {
  const run = exitedLeader({ group: 'eio' })
  try { assert.notEqual(run.api.close().outcome, 'proven') } finally { run.cleanup() }
})

// A seat that exits on the first signal: the leader's marker lands and the group probe then reports ESRCH.
function exitOnSignal(seatDir, pid) {
  let gone = false
  return {
    spawn: () => { writeFileSync(join(seatDir, 'pgid'), String(pid)); return { pid, unref() {} } },
    kill: (target, signal) => {
      if (target !== -pid) return true
      if (signal === 0) {
        if (gone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
        return true
      }
      writeFileSync(join(seatDir, 'exit'), '0')
      gone = true
      return true
    },
  }
}

function writeHarness(writeOverride, clock = () => Date.now(), sleep = () => {}) {
  const root = scratchDir('acp-write-')
  const acpRoot = join(root, 'acp')
  const seatDir = join(acpRoot, 'builder')
  mkdirSync(seatDir, { recursive: true })
  const stream = join(seatDir, 'stream.jsonl')
  writeFileSync(stream, '')
  let pending = Buffer.alloc(0)
  const received = []
  const journal = []
  const writeSync = (...args) => writeOverride(args, (buf) => {
    pending = Buffer.concat([pending, buf])
    if (!pending.includes(10)) return
    const frame = JSON.parse(pending.toString('utf8'))
    pending = Buffer.alloc(0)
    received.push(frame)
    const result = frame.method === 'initialize' ? { protocolVersion: 1 } : frame.method === 'session/new' ? { sessionId: 's' } : { stopReason: 'end_turn' }
    appendFileSync(stream, `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`)
  })
  const api = acpClient({ launch: { bin: '/bin/false' }, dir: acpRoot, cwd: root, deps: {
    pid: 99001, ...exitOnSignal(seatDir, 99002), openSync: () => 7,
    writeSync, closeSync: () => {}, existsSync: (p) => existsSync(p) || String(p).endsWith('cmd.fifo'),
    now: clock, sleep, log: (row) => journal.push(row),
    seatCommandRoot: join(root, 'seat-runtime'),
  } })
  api.start(); api.initialize(); api.newSession()
  return { api, root, received, journal, prompt(text) { return api.pollPrompt(api.beginPrompt([{ type: 'text', text }])) }, cleanup() { api.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('W1 short writes reassemble one complete 70KB prompt frame', () => {
  let chunks = 0
  const f = writeHarness(([fd, buffer, offset, length], receive) => {
    const count = Math.min(3072, length); chunks++
    receive(buffer.subarray(offset, offset + count)); return count
  })
  try {
    assert.equal(f.prompt('x'.repeat(70000)).stopReason, 'end_turn')
    const prompts = f.received.filter((frame) => frame.method === 'session/prompt')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].params.prompt[0].text.length, 70000)
    assert.ok(chunks > 20)
  } finally { f.cleanup() }
})

test('W2 retries EAGAIN and reports deadline plus partial bytes', () => {
  let calls = 0, time = 0
  const f = writeHarness(([fd, buffer, offset, length], receive) => {
    if (calls++ < 2) throw Object.assign(new Error('full'), { code: 'EAGAIN' })
    receive(buffer.subarray(offset, offset + length)); return length
  }, () => time, (ms) => { time += ms })
  try {
    assert.equal(f.prompt('retry').stopReason, 'end_turn')
    assert.equal(calls, 5) // two EAGAINs then the handshake, session/new, and prompt writes
  } finally { f.cleanup() }
  let blockedTime = 0
  const blocked = writeHarness(([fd, buffer], receive) => {
    if (String(buffer).includes('session/prompt')) throw Object.assign(new Error('full'), { code: 'EAGAIN' })
    receive(buffer); return buffer.length
  }, () => blockedTime, (ms) => { blockedTime += ms })
  try {
    assert.throws(() => blocked.prompt('blocked'), (error) => error.reason === 'acp-prompt-write-timeout' && error.bytesWritten === 0)
    assert.ok(blockedTime >= ACP_WRITE_DEADLINE_MS)
  } finally { blocked.cleanup() }
})

test('W3 real FIFO child delivers 70KB prompt and is always reaped', () => {
  const root = scratchDir('acp-real-fifo-')
  const acpRoot = join(root, 'acp')
  const agent = join(root, 'agent.mjs'), client = join(root, 'client.mjs')
  let out
  try {
    writeFileSync(agent, `import readline from 'node:readline'; import {appendFileSync} from 'node:fs'; const stream=${JSON.stringify(join(acpRoot, 'builder', 'stream.jsonl'))}; for await (const line of readline.createInterface({input:process.stdin})) { const f=JSON.parse(line); appendFileSync(stream, JSON.stringify({jsonrpc:'2.0',id:f.id,result:f.method==='initialize'?{protocolVersion:1}:f.method==='session/new'?{sessionId:'s'}:{stopReason:'end_turn'}})+'\\n') }`)
    writeFileSync(client, `import {acpClient} from ${JSON.stringify(pathToFileURL(join(REGISTER_ROOT, 'crew/acp-client.mjs')).href)}; let term=false,killed=false,skip=0; const c=acpClient({launch:{bin:process.execPath,args:[${JSON.stringify(agent)}]},dir:${JSON.stringify(acpRoot)},cwd:${JSON.stringify(root)},deps:{seatCommandRoot:${JSON.stringify(join(root, 'seat-runtime'))},kill:(p,s)=>{if(s==='SIGTERM')term=true;if(s==='SIGKILL')killed=true;return process.kill(p,s)},now:()=>Date.now()+skip,sleep:(ms)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);if(term&&!killed)skip+=5000}}});try{c.start();c.initialize();c.newSession();const id=c.beginPrompt([{type:'text',text:'x'.repeat(70000)}]);let r=null;const deadline=Date.now()+15000;while(!r&&Date.now()<deadline){r=c.pollPrompt(id);if(!r)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}if(r?.stopReason!=='end_turn')process.exitCode=2}catch(e){console.error(e);process.exitCode=3}finally{c.close()}`)
    trackProcessGroupFile(join(acpRoot, 'builder', 'pgid'))
    out = spawnSync(process.execPath, [client], { timeout: 20000, encoding: 'utf8' })
    assert.equal(out.status, 0, `real FIFO child status=${out.status} signal=${out.signal}; stderr=${out.stderr}`)
    assert.equal(out.stderr, '')
  } finally {
    const pgidFile = join(acpRoot, 'builder', 'pgid')
    if (existsSync(pgidFile)) { const pgid = Number(readFileSync(pgidFile, 'utf8')); if (pgid > 1) try { process.kill(-pgid, 'SIGKILL') } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
})

test('RV1-1 torn writes poison later frames and skip cancel writes', () => {
  let time = 0, calls = 0
  const f = writeHarness(([fd, buffer, offset], receive) => {
    if (!String(buffer).includes('session/prompt')) { receive(buffer); return buffer.length }
    calls++
    if (calls === 1) { receive(buffer.subarray(offset, offset + 4096)); return 4096 }
    throw Object.assign(new Error('full'), { code: 'EAGAIN' })
  }, () => time, (ms) => { time += ms })
  try {
    assert.throws(() => f.api.beginPrompt([{ type: 'text', text: 'x'.repeat(70000) }]), (error) => error.reason === 'acp-prompt-write-timeout' && error.bytesWritten === 4096)
    const callsAtTear = calls
    assert.throws(() => f.api.beginPrompt([{ type: 'text', text: 'later' }]), (error) => error.reason === 'acp-prompt-write-timeout' && error.bytesWritten === 0)
    f.api.cancel()
    assert.equal(calls, callsAtTear)
    assert.equal(f.journal.some((row) => row.acp_cancel_skipped?.reason === 'torn-frame' && row.acp_cancel_skipped.bytesWritten === 4096), true)
  } finally { f.cleanup() }
})

test('RV1-1 zero-byte timeout does not poison a subsequent complete frame', () => {
  let time = 0, blocked = true
  const f = writeHarness(([fd, buffer, offset = 0, length = buffer.length], receive) => {
    if (blocked && String(buffer).includes('session/prompt')) throw Object.assign(new Error('full'), { code: 'EAGAIN' })
    receive(buffer.subarray(offset, offset + length)); return length
  }, () => time, (ms) => { time += ms })
  try {
    assert.throws(() => f.api.beginPrompt([{ type: 'text', text: 'first' }]), (error) => error.reason === 'acp-prompt-write-timeout' && error.bytesWritten === 0)
    blocked = false
    const id = f.api.beginPrompt([{ type: 'text', text: 'second' }])
    assert.equal(f.api.pollPrompt(id).stopReason, 'end_turn')
    assert.equal(f.received.filter((frame) => frame.method === 'session/prompt').length, 1)
    assert.equal(f.received.find((frame) => frame.method === 'session/prompt').params.prompt[0].text, 'second')
  } finally { f.cleanup() }
})

test('RV1-2 retains EPIPE and the number of partial bytes written', () => {
  let promptCalls = 0
  const f = writeHarness(([fd, buffer, offset = 0], receive) => {
    if (!String(buffer).includes('session/prompt')) { receive(buffer); return buffer.length }
    if (promptCalls++ === 0) { receive(buffer.subarray(offset, offset + 31)); return 31 }
    throw Object.assign(new Error('pipe closed'), { code: 'EPIPE' })
  })
  try {
    assert.throws(() => f.api.beginPrompt([{ type: 'text', text: 'partial' }]), (error) => error.code === 'EPIPE' && error.bytesWritten === 31)
  } finally { f.cleanup() }
})

test('RV1-1 creates the seat command directory on startup', () => {
  const root = scratchDir('acp-rv1-1-')
  const rvRuntime = scratchDir('acp-runtime-')
  let clock = 0
  try {
    const acpRoot = join(root, 'acp')
    mkdirSync(join(acpRoot, 'builder'), { recursive: true })
    writeFileSync(join(acpRoot, 'builder', 'stream.jsonl'), '')
    const fifo = acpSeatPaths(acpRoot, 'builder', rvRuntime).fifo
    const api = acpClient({
      launch: { bin: '/bin/false', args: [], env: {} },
      dir: acpRoot,
      cwd: root,
      role: 'builder',
      sinks: {},
      deps: {
        pid: 900,
        spawn: () => ({ pid: 901, unref() {} }),
        openSync: () => 7,
        writeSync: () => {},
        closeSync: () => {},
        kill: () => true,
        spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
        now: () => clock++,
        sleep: () => {},
        log: () => {},
        seatCommandRoot: rvRuntime,
      },
    })
    api.start()
    assert.equal(existsSync(dirname(fifo)), true)
    api.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BZ1 — post-SIGKILL polling and the zombie census each prove death', () => {
  // MUTATION (i): revert `return probeBounded(ACP_KILL_PROOF_MS, pgid)` to the baseline single
  // store.probeEvidence return and the live-census half reddens — only polling can prove it.
  // MUTATION (ii): replace `if (groupAllZombie(pgid))` with `if (false)` and the all-zombie EPERM half
  // reddens — only the census can prove it.
  const scenario = (kill, spawnSync) => {
    const root = scratchDir('acp-bz1-')
    const bzRuntime = scratchDir('acp-runtime-')
    const acpRoot = join(root, 'acp')
    mkdirSync(join(acpRoot, 'builder'), { recursive: true })
    writeFileSync(join(acpRoot, 'builder', 'stream.jsonl'), '')
    writeFileSync(join(acpRoot, 'builder', 'pgid'), '901')
    let clock = 0
    const deps = {
      pid: 900,
      spawn: () => ({ pid: 901, unref() {} }),
      openSync: () => 7,
      writeSync: () => {},
      closeSync: () => {},
      kill,
      spawnSync,
      now: () => clock++,
      sleep: () => {},
      log: () => {},
      seatCommandRoot: bzRuntime,
    }
    const api = acpClient({ launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder', deps })
    api.start()
    writeFileSync(acpSeatPaths(acpRoot, 'builder', bzRuntime).fifo, '')
    const result = api.close()
    let secondError = null
    if (result.outcome === 'proven') {
      try {
        acpClient({ launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder', deps }).start()
      } catch (err) { secondError = err }
    }
    return { root, result, secondError }
  }
  let killed = false
  let probes = 0
  const killPoll = (pid, sig) => {
    if (sig === 'SIGKILL') { killed = true; return true }
    if (sig === 0) {
      if (killed && ++probes >= 3) { const err = new Error('no such process'); err.code = 'ESRCH'; throw err }
      return true
    }
    return true
  }
  const polling = scenario(killPoll, () => ({ status: 0, stdout: '901 S\n' }))
  try {
    assert.equal(polling.result.outcome, 'proven')
    assert.equal(polling.result.reason, 'probe')
    assert.equal(polling.secondError, null)
  } finally { rmSync(polling.root, { recursive: true, force: true }) }
  const killEperm = (pid, sig) => {
    if (sig === 0) { const err = new Error('operation not permitted'); err.code = 'EPERM'; throw err }
    return true
  }
  const zombie = scenario(killEperm, () => ({ status: 0, stdout: '901 Z\n' }))
  try {
    assert.equal(zombie.result.outcome, 'proven')
    assert.equal(zombie.result.reason, 'zombie-group')
    assert.equal(zombie.secondError, null)
  } finally { rmSync(zombie.root, { recursive: true, force: true }) }
})

test('BZ1 real-process witness — a TERM-ignoring sleep proves dead after SIGKILL', () => {
  let term = false, killed = false, skip = 0
  const root = scratchDir('acp-bz1-real-')
  try {
    const acpRoot = join(root, 'acp')
    const api = acpClient({
      launch: { bin: '/bin/sh', args: ['-c', "trap '' TERM; exec sleep 30"] },
      dir: acpRoot,
      cwd: root,
      role: 'builder',
      deps: {
        pid: process.pid, log: () => {}, seatCommandRoot: join(root, 'seat-runtime'),
        kill: (p, s) => { if (s === 'SIGTERM') term = true; if (s === 'SIGKILL') killed = true; return process.kill(p, s) },
        now: () => Date.now() + skip,
        sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); if (term && !killed) skip += 5000 },
      },
    })
    api.start()
    const result = api.close()
    assert.equal(killed, true)
    assert.equal(result.outcome, 'proven')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an unproven close keeps the reservation so a second start refuses busy', () => {
  // MUTATION: clear the reservation when the close is unproven, and the second start stops refusing busy.
  const root = scratchDir('acp-reprove-')
  const reproveRuntime = scratchDir('acp-runtime-')
  try {
    const acpRoot = join(root, 'acp')
    mkdirSync(join(acpRoot, 'builder'), { recursive: true })
    writeFileSync(join(acpRoot, 'builder', 'stream.jsonl'), '')
    writeFileSync(join(acpRoot, 'builder', 'pgid'), '901')
    let clock = 0
    const kill = (pid, sig) => {
      if (sig === 0) { const err = new Error('operation not permitted'); err.code = 'EPERM'; throw err }
      return true
    }
    const launch = { bin: '/bin/false', args: [], env: {} }
    const deps = {
      pid: 900,
      spawn: () => ({ pid: 901, unref() {} }),
      openSync: () => 7,
      writeSync: () => {},
      closeSync: () => {},
      kill,
      spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
      now: () => clock++,
      sleep: () => {},
      log: () => {},
      seatCommandRoot: reproveRuntime,
    }
    const first = acpClient({ launch, dir: acpRoot, cwd: root, role: 'builder', deps })
    first.start()
    const fifo = acpSeatPaths(acpRoot, 'builder', reproveRuntime).fifo
    writeFileSync(fifo, '')
    const closed = first.close()
    assert.notEqual(closed.outcome, 'proven')
    assert.equal(existsSync(fifo), true)
    let busy = null
    try { acpClient({ launch, dir: acpRoot, cwd: root, role: 'builder', deps }).start() } catch (err) { busy = err }
    assert.equal(busy?.reason, 'acp-session-busy')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
// MUTATION: clear the reservation unconditionally on a fifo miss.
test('S2-17 a fifo miss clears the reservation only after proven death', () => {
  for (const state of ['alive', 'dead', 'eperm', 'unknown']) {
    const root = scratchDir('acp-fifo-'), acpRoot = join(root, 'acp'), kills = []
    let clock = 0, terminated = false
    const baseDeps = {
      pid: 99001, seatCommandRoot: join(root, 'seat-runtime'),
      spawn: () => { writeFileSync(join(acpRoot, 'builder', 'pgid'), '99002'); return { pid: 99002, unref() {} } },
      closeSync() {}, now: () => clock, sleep: (ms) => { clock += ms },
      kill(target, signal) {
        kills.push([target, signal])
        if (signal === 'SIGTERM') terminated = true
        if (target === -99002 && signal === 0) {
          if (state === 'dead' && terminated) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
          if (state === 'eperm' || state === 'unknown') throw Object.assign(new Error('probe failed'), { code: state === 'eperm' ? 'EPERM' : 'EIO' })
        }
      },
      spawnSync: () => state === 'unknown' ? { status: 1, stdout: '' } : { status: 0, stdout: '99002 S\n' },
    }
    const options = { launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder' }
    try {
      const first = acpClient({ ...options, deps: { ...baseDeps, openSync: () => { throw Object.assign(new Error('no fifo'), { code: 'ENOENT' }) } } })
      let failure
      assert.throws(() => { try { first.start() } catch (error) { failure = error; throw error } }, { reason: 'acp-spawn-failed' })
      assert.ok(kills.some(([pid, signal]) => pid === -99002 && signal === 'SIGTERM'))
      const second = acpClient({ ...options, deps: { ...baseDeps, openSync: () => 7 } })
      if (state === 'dead') assert.deepEqual(second.start(), { pid: 99002 })
      else assert.throws(() => second.start(), { reason: 'acp-session-busy' })
      assert.equal(failure.teardown?.outcome, state === 'dead' ? 'proven' : state === 'unknown' ? 'unproven' : 'failed')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('AS ACP spawn withholds inherited pi seat keys unless the launch env grants them', () => {
  // MUTATION: replace piSeatSpawnEnv(process.env, launch?.env || {}) with the raw spread and the inherited keys return.
  const prior = {}
  for (const key of ['CREW_PI_AGENTS', 'CREW_ADVISOR_ENDPOINT', 'AS_SPAWN_SENTINEL']) prior[key] = process.env[key]
  process.env.CREW_PI_AGENTS = 'evil-agents'
  process.env.CREW_ADVISOR_ENDPOINT = 'evil-endpoint'
  process.env.AS_SPAWN_SENTINEL = 'keep-me'
  const startCapture = (launchEnv) => {
    const root = scratchDir('acp-spawn-env-')
    const acpRoot = join(root, 'acp')
    let captured = null, clock = 0
    const api = acpClient({
      launch: { bin: '/bin/false', args: [], env: launchEnv },
      dir: acpRoot,
      cwd: root,
      role: 'builder',
      deps: {
        pid: 900,
        spawn: (bin, args, options) => { captured = options; return { pid: 901, unref() {} } },
        openSync: () => 7,
        writeSync: () => {},
        closeSync: () => {},
        existsSync: (path) => existsSync(path) || String(path).endsWith('cmd.fifo'),
        kill: () => {},
        now: () => clock,
        sleep: (ms) => { clock += ms },
        spawnSync: () => ({ status: 0, stdout: '' }),
        log: () => {},
        seatCommandRoot: join(root, 'seat-runtime'),
      },
    })
    api.start()
    api.close()
    const env = captured.env
    rmSync(root, { recursive: true, force: true })
    return env
  }
  try {
    const ungranted = startCapture({})
    assert.equal(ungranted.CREW_PI_AGENTS, undefined)
    assert.equal(ungranted.CREW_ADVISOR_ENDPOINT, undefined)
    assert.equal(ungranted.AS_SPAWN_SENTINEL, 'keep-me')
    const granted = startCapture({ CREW_PI_AGENTS: 'grant-agents', CREW_ADVISOR: '1' })
    assert.equal(granted.CREW_PI_AGENTS, 'grant-agents')
    assert.equal(granted.CREW_ADVISOR, '1')
    assert.equal(granted.CREW_ADVISOR_ENDPOINT, undefined)
    assert.equal(granted.AS_SPAWN_SENTINEL, 'keep-me')
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('RR1 refused close leaves runtime dirs', () => {
  const root = scratchDir('acp-rr1-refused-')
  const acpRoot = join(root, 'acp')
  const runtimeRoot = join(root, 'seat-runtime')
  let clock = 0
  let groupGone = false
  const deps = {
    pid: 900, spawn: () => { writeFileSync(acpSeatPaths(acpRoot, 'builder', runtimeRoot).pgid, '901'); return { pid: 901, unref() {} } }, openSync: () => 7,
    writeSync: () => {}, closeSync: () => {}, kill: groupKill(() => groupGone),
    spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
    now: () => clock++, sleep: () => {}, log: () => {}, seatCommandRoot: runtimeRoot,
  }
  const first = acpClient({ launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder', deps })
  const second = acpClient({ launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder', deps: { ...deps, pid: 902 } })
  try {
    first.start()
    const paths = acpSeatPaths(acpRoot, 'builder', runtimeRoot)
    const roleDir = dirname(paths.fifo)
    const keyDir = dirname(roleDir)
    let busy = null
    try { second.start() } catch (err) { busy = err }
    assert.equal(busy?.reason, 'acp-session-busy')
    second.close()
    assert.equal(existsSync(roleDir), true)
    assert.equal(existsSync(keyDir), true)
    writeFileSync(paths.exit, '0')
    groupGone = true
    assert.equal(first.close().outcome, 'proven')
    assert.equal(existsSync(roleDir), false)
    assert.equal(existsSync(keyDir), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RR1 unproven owner close leaves runtime dirs', () => {
  const root = scratchDir('acp-rr1-unproven-')
  const acpRoot = join(root, 'acp')
  const runtimeRoot = join(root, 'seat-runtime')
  let clock = 0
  const deps = {
    pid: 900, spawn: () => ({ pid: 901, unref() {} }), openSync: () => 7,
    writeSync: () => {}, closeSync: () => {}, kill: () => true,
    spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
    now: () => clock++, sleep: () => {}, log: () => {}, seatCommandRoot: runtimeRoot,
  }
  const owner = acpClient({ launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder', deps })
  try {
    owner.start()
    const paths = acpSeatPaths(acpRoot, 'builder', runtimeRoot)
    const roleDir = dirname(paths.fifo)
    const keyDir = dirname(roleDir)
    const result = owner.close()
    assert.equal(result.outcome, 'unproven')
    assert.equal(existsSync(roleDir), true)
    assert.equal(existsSync(keyDir), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RI2 a deleted PGID marker does not stop teardown proving an already-dead owned group', () => {
  const root = scratchDir('acp-ri2-marker-')
  const acpRoot = join(root, 'acp')
  let clock = 0
  let gone = false
  const probes = []
  const deps = {
    pid: 900, spawn: () => ({ pid: 901, unref() {} }), openSync: () => 7,
    writeSync: () => {}, closeSync: () => {},
    kill: (target, signal) => {
      probes.push([target, signal])
      if (target === -901 && signal === 0 && gone) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    },
    spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
    now: () => clock, sleep: (ms) => { clock += ms }, log: () => {}, seatCommandRoot: join(root, 'seat-runtime'),
  }
  const client = acpClient({ launch: { bin: '/bin/false', args: [], env: {} }, dir: acpRoot, cwd: root, role: 'builder', deps })
  try {
    client.start()
    // The pgid file was never written (or was removed with the runtime); only the owned child pid can answer.
    gone = true
    const result = client.close()
    assert.equal(result.outcome, 'proven')
    assert.equal(clock, 0, 'marker loss adds no proof wait')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RI2 a missing PGID marker never proves a live or unprobeable owned group dead', () => {
  for (const code of [null, 'EPERM', 'EIO']) {
    const root = scratchDir('acp-ri2-live-')
    let clock = 0
    const deps = {
      pid: 900, spawn: () => ({ pid: 901, unref() {} }), openSync: () => 7,
      writeSync: () => {}, closeSync: () => {},
      kill: (_target, signal) => { if (signal === 0 && code) throw Object.assign(new Error(code), { code }); return true },
      spawnSync: () => ({ status: 0, stdout: '901 S\n' }),
      now: () => clock++, sleep: () => {}, log: () => {}, seatCommandRoot: join(root, 'seat-runtime'),
    }
    const client = acpClient({ launch: { bin: '/bin/false', args: [], env: {} }, dir: join(root, 'acp'), cwd: root, role: 'builder', deps })
    try {
      client.start()
      assert.notEqual(client.close().outcome, 'proven', `code ${code}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('LG2 default seat command root resolves the acp FIFO under TMPDIR crew-rpc', () => {
  const root = scratchDir('lg-acp-default-')
  const acpRoot = join(root, 'acp')
  const seatDir = join(acpRoot, 'builder')
  mkdirSync(seatDir, { recursive: true })
  writeFileSync(join(seatDir, 'stream.jsonl'), '')
  const opened = []
  const scratchTmp = scratchDir('lg-default-tmp-')
  const previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = scratchTmp
  try {
    const expectedFifo = seatCommandPath(root, 'builder', scratchTmp)
    const api = acpClient({
      launch: { bin: '/bin/false', args: [], env: {} },
      dir: acpRoot, cwd: root, role: 'builder',
      deps: {
        pid: 900,
        ...exitOnSignal(seatDir, 901),
        openSync: (path) => { opened.push(path); return 7 },
        writeSync: () => {},
        closeSync: () => {},
        now: () => 1000,
        sleep: () => {},
        log: () => {},
      },
    })
    assert.equal(api.start().pid, 901)
    assert.deepEqual(opened, [expectedFifo])
    assert.equal(expectedFifo.startsWith(join(scratchTmp, 'crew-rpc')), true)
    assert.equal(existsSync(join(acpRoot, 'builder', 'cmd.fifo')), false)
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    rmSync(scratchTmp, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(process.env.TMPDIR, previousTmpdir)
})
