import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import {
  ACP_CLIENT_CAPABILITIES, ACP_UPDATE_KINDS, acpClient,
} from './acp-client.mjs'
import { REGISTER_ROOT } from './capabilities.mjs'

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
  let cancelledBySink = false
  let corrupt = options.corruptAfterPrompt === true
  let promptMark = 0
  let api = null

  const emitRecordedRun = () => {
    while (cursor < records.length && records[cursor].dir !== 'client->agent') {
      const record = records[cursor++]
      if (record.dir !== 'agent->client' || !record.frame) continue
      const frame = JSON.parse(JSON.stringify(record.frame))
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
    if (options.cancelOnFirstUpdate === true && !cancelledBySink) {
      cancelledBySink = true
      api.cancel()
    }
  }
  const sinks = Object.fromEntries([...ACP_UPDATE_KINDS, 'unknown'].map((kind) => [kind, makeSink(kind)]))
  const firstCwd = recordedFrame(records, 'session/new')?.params?.cwd ?? root
  const firstMeta = recordedFrame(records, 'session/new')?.params?._meta ?? null
  const firstPrompt = recordedFrame(records, 'session/prompt')?.params?.prompt ?? []
  const mode = recordedFrame(records, 'session/set_mode')?.params?.modeId ?? null

  const deps = {
    pid: 900,
    spawn: () => ({ pid: 901, unref() {} }),
    openSync: () => 7,
    writeSync: (_fd, line) => receiveOutgoing(String(line)),
    closeSync: () => {},
    existsSync: (path) => existsSync(path) || String(path).endsWith('cmd.fifo'),
    kill: () => { writeFileSync(join(seatDir, 'exit'), '0') },
    now: () => { clock += 1000; return clock },
    sleep: () => {},
    log: (row) => journal.push(row),
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
  try { out.outcome = api.prompt(firstPrompt) } catch (err) { out.promptError = err }
  out.teardown = api.close()
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
    assert.throws(() => run.api.prompt([{ type: 'text', text: 'again' }]), (err) => err.reason === 'acp-session-cancelled')
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
      spawn: () => ({ pid: 901, unref() {} }),
      openSync: () => 7,
      writeSync: (_fd, line) => {
        const frame = JSON.parse(String(line))
        sent.push(frame)
        if (frame.method === 'initialize') freshInitializePending = true
      },
      closeSync: () => {},
      existsSync: (path) => existsSync(path) || String(path).endsWith('cmd.fifo'),
      kill: () => { writeFileSync(join(seatDir, 'exit'), '0') },
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

test('the client has only built-in or relative imports and the package has no runtime dependencies', () => {
  const packageJson = JSON.parse(readFileSync(join(REGISTER_ROOT, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false)
  const source = readFileSync(join(REGISTER_ROOT, 'crew', 'acp-client.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  assert.equal(specifiers.length > 0, true)
  assert.equal(specifiers.every((specifier) => specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')), true)
})
