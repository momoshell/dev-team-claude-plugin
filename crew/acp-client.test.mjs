import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import {
  ACP_UPDATE_KINDS, acpClient, acpSeatPaths,
} from './acp-client.mjs'

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

test('a cancelled session refuses another prompt without sending a frame', () => {
  const run = replay('pi-cancel.ndjson', { cancelOnFirstUpdate: true })
  try {
    const before = run.sent.length
    assert.throws(() => run.api.beginPrompt([{ type: 'text', text: 'again' }]), (err) => err.reason === 'acp-session-cancelled')
    assert.equal(run.sent.length, before)
  } finally { forget(run) }
})

test('a malformed frame refuses by name and delivers no part of its batch', () => {
  runWithCleanup('claude-turn.ndjson', { corruptAfterPrompt: true }, (run) => {
    assert.equal(run.promptError?.reason, 'acp-malformed-frame')
    assert.equal(run.promptError?.message.includes('acp-malformed-frame'), true)
    assert.equal(run.delivered.slice(run.promptMark).length, 0)
  })
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
