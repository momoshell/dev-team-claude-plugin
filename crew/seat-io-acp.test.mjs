import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync as fsExistsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { acpIo } from './acp-io.mjs'
import { cellFailureKind, ACP_TRANSPORT, DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT, seatIo } from './seat-io.mjs'

function fixture(options = {}) {
  const root = scratchDir('acp-io-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const briefFile = join(root, 'brief.md'); writeFileSync(briefFile, 'brief body')
  const calls = []; const logs = []; const heartbeats = []; let sinks; let launch; let onPermission
  const pollResults = [...(options.pollResults ?? (Object.hasOwn(options, 'turn') ? [options.turn] : []))]
  const fake = {
    sessionId: 'session-test',
    start() { calls.push('start') }, initialize() { calls.push('initialize') }, newSession() { calls.push('newSession') },
    beginPrompt(blocks) { calls.push(['beginPrompt', blocks]); return 17 },
    pollPrompt() { calls.push('pollPrompt'); if (options.pollError) throw options.pollError; return pollResults.length ? pollResults.shift() : null },
    resumeSession() { calls.push('resumeSession') }, cancel() { calls.push('cancel') },
    close() { calls.push('close'); return { outcome: 'proven', reason: 'fixture' } },
  }
  const io = acpIo({ crew: options.crew || { members: { builder: { model: 'test' } } }, paths, taskDir: paths.taskDir, checkout: root, adapters: options.adapters || {}, bin: '/bin/pi',
    deps: { clientFactory(opts) { sinks = opts.sinks; launch = opts.launch; onPermission = opts.onPermission; return fake }, permissionLead: options.permissionLead, log: (row) => logs.push(row), emit: (row) => heartbeats.push(row),
      existsSync: options.existsSync || ((path) => path === '/bin/pi' || fsExistsSync(path)), readFileSync: options.readFileSync, now: options.now || (() => 100), sleep() {} } })
  return { root, paths, briefFile, io, calls, logs, heartbeats, get launch() { return launch }, get onPermission() { return onPermission }, update: (kind, payload) => (typeof kind === 'string' ? sinks[kind](payload) : sinks.agent_message_chunk(kind)) }
}
function assign(f, extra = {}) { return f.io.assign({ role: 'builder', briefFile: f.briefFile, ...extra }) }
function cleanup(f) { rmSync(f.root, { recursive: true, force: true }) }

test('T1', () => {
  const f = fixture(); try {
    assert.equal(ACP_TRANSPORT, 'acp')
    const calls = []
    const spy = { assign() { calls.push('assign'); return { id: 'd1', returnPath: join(f.paths.returnsDir, 'd1.builder.json') } }, wait(path) { calls.push('wait'); return { status: 'done', assignment_id: 'd1' } } }
    const crew = { claude_bin: '/bin/true', members: { builder: { transport: 'acp', model: 'test' } } }
    const routed = seatIo(crew, f.paths, f.root, null, {}, {}, { acpIo: () => spy, logLine() {}, now: () => 100 })
    const out = routed.assign({ role: 'builder', briefFile: f.briefFile })
    assert.deepEqual(routed.wait(out.returnPath, 1), { status: 'done', assignment_id: 'd1' })
    assert.deepEqual(calls, ['assign', 'wait'])
  } finally { cleanup(f) }
})
test('T2', () => {
  const f = fixture(); try {
    const out = assign(f); writeFileSync(out.returnPath, JSON.stringify({ status: 'done', assignment_id: out.id }))
    assert.equal(f.io.wait(out.returnPath, 1).assignment_id, out.id)
    assert.equal(f.calls.filter((call) => call === 'pollPrompt').length, 1)
  } finally { cleanup(f) }
})
test('ACP U1', () => {
  const f = fixture({ turn: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4 } } }); try {
    const out = assign(f); writeFileSync(out.returnPath, JSON.stringify({ status: 'done', assignment_id: out.id })); f.io.wait(out.returnPath, 1)
    assert.deepEqual(f.heartbeats.filter((e) => e.kind === 'usage')[0].usage, { billed_input_tokens: 1, billed_output_tokens: 2, billed_cache_read_tokens: 3, billed_cache_write_tokens: 4 })
  } finally { cleanup(f) }
})
test('ACP U2', () => {
  const f = fixture({ turn: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 3 } } }); try {
    const out = assign(f); writeFileSync(out.returnPath, JSON.stringify({ status: 'done', assignment_id: out.id })); f.io.wait(out.returnPath, 1)
    assert.equal(f.heartbeats.some((e) => e.kind === 'usage'), false); assert.equal(f.logs[0].acp_turn.usage_reason, 'usage-incomplete')
  } finally { cleanup(f) }
})
test('ACP U3', () => {
  const f = fixture({ turn: { stopReason: 'end_turn', usage: null } }); try {
    const out = assign(f); writeFileSync(out.returnPath, JSON.stringify({ status: 'done', assignment_id: out.id })); f.io.wait(out.returnPath, 1)
    assert.equal(f.heartbeats.some((e) => e.kind === 'usage'), false); assert.equal(f.logs[0].acp_turn.usage, null)
  } finally { cleanup(f) }
})
test('ACP S1', () => {
  const f = fixture({ turn: { stopReason: 'end_turn', usage: null } }); try {
    const out = assign(f); writeFileSync(out.returnPath, JSON.stringify({ status: 'done', assignment_id: out.id })); f.io.wait(out.returnPath, 1)
    assert.equal(f.logs.filter((e) => e.acp_turn).length, 1)
    assert.equal(f.logs.find((e) => e.acp_turn)?.acp_turn.stopReason, 'end_turn')
  } finally { cleanup(f) }
})
test('ACP S2', () => {
  const f = fixture({ pollResults: [null] }); try {
    assign(f); f.io.close(); assert.equal(f.logs.find((e) => e.acp_turn)?.acp_turn.stop_reason_absent, 'response-unread')
  } finally { cleanup(f) }
  for (const close of ['retire', 'abort', 'teardown']) {
    const g = fixture({ pollResults: [null] }); try { assign(g); g.io[close]('builder'); assert.equal(g.logs.find((e) => e.acp_turn)?.acp_turn.stop_reason_absent, 'response-unread') } finally { cleanup(g) }
  }
  const h = fixture({ turn: { stopReason: null, refusal: { message: 'refused' } } }); try { assign(h); h.io.retire('builder'); assert.equal(h.logs.find((e) => e.acp_turn)?.acp_turn.stop_reason_absent, 'refused') } finally { cleanup(h) }
  const i = fixture({ pollResults: [null, null] }); try {
    const old = assign(i); assign(i, { reask: { id: 'd2', returnPath: old.returnPath } })
    assert.equal(i.logs.filter((e) => e.acp_turn?.assignment_id === old.id).length, 1)
    assert.equal(i.logs.find((e) => e.acp_turn?.assignment_id === old.id).acp_turn.stop_reason_absent, 'response-unread')
  } finally { cleanup(i) }
})
test('ACP RV1-1 malformed frame errors remain the wait cause', () => {
  const cause = Object.assign(new Error('bad frame'), { stage: 'acp-malformed-frame' })
  const f = fixture({ pollError: cause, now: () => Date.now() }); try {
    const out = assign(f)
    assert.throws(() => f.io.wait(out.returnPath, 0.05), (error) => error.stage === 'acp-no-envelope' && error.cause === cause)
    assert.equal(f.calls.filter((call) => call === 'pollPrompt').length, 1)
  } finally { cleanup(f) }
})
test('ACP RV1-2 replacement closes and records the pending prior assignment', () => {
  const f = fixture({ pollResults: [null, null] }); try {
    const old = assign(f); assert.throws(() => f.io.wait(old.returnPath, 0), (error) => error.stage === 'acp-no-envelope')
    assign(f, { id: 'd4', returnPath: join(f.paths.returnsDir, 'd4.builder.json') })
    assert.equal(f.logs.filter((row) => row.acp_turn?.assignment_id === old.id).length, 1)
    assert.equal(f.logs.find((row) => row.acp_turn?.assignment_id === old.id).acp_turn.stop_reason_absent, 'response-unread')
  } finally { cleanup(f) }
})
test('ACP T1', () => {
  const f = fixture(); try {
    const out = assign(f); f.update('tool_call', { update: { sessionUpdate: 'tool_call', toolCallId: 't', kind: 'edit', title: 'x', status: 'running' } });
    f.update('tool_call_update', { update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' } })
    const rows = f.logs.filter((e) => e.acp_tool_call).map((e) => e.acp_tool_call); assert.equal(rows[1].kind, 'edit'); assert.equal(rows[1].assignment_id, out.id)
  } finally { cleanup(f) }
})
test('ACP P1', () => {
  const f = fixture(); try { assign(f); f.onPermission({ toolCall: { toolCallId: 't', title: 'x', kind: 'edit' }, options: [{ optionId: 'r', kind: 'reject_once' }] }); assert.equal(f.logs.find((e) => e.acp_permission_policy)?.acp_permission_policy.tool_call_id, 't') } finally { cleanup(f) }
})
test('T3', () => {
  const f = fixture({ turn: { stopReason: 'end_turn', refusal: null } }); try {
    const out = assign(f); assert.throws(() => f.io.wait(out.returnPath, 0), (e) => e.stage === 'acp-no-envelope')
  } finally { cleanup(f) }
})
test('T4', () => {
  const f = fixture({ turn: { stopReason: 'end_turn', refusal: null } }); try {
    const out = assign(f); assert.throws(() => f.io.wait(out.returnPath, 0), (e) => e.stage === 'acp-no-envelope')
    const turnRows = f.logs.filter((x) => x.acp_turn?.assignment_id === out.id)
    assert.equal(turnRows.length, 1)
    assert.equal(turnRows[0].acp_turn.stopReason, 'end_turn')
  } finally { cleanup(f) }
})
test('T5', () => {
  const f = fixture({ turn: { stopReason: null, refusal: { message: 'refused' } } }); try {
    const out = assign(f); assert.throws(() => f.io.wait(out.returnPath, 1), (e) => e.stage === 'acp-no-envelope' && cellFailureKind(e) === 'no-envelope' && /no valid envelope/.test(e.message))
  } finally { cleanup(f) }
})
test('T6', () => {
  const f = fixture({ turn: { stopReason: null, refusal: { message: 'refused' } } }); try {
    const out = assign(f); assert.throws(() => f.io.wait(out.returnPath, 1), (e) => e.graceSpent === false)
    const g = fixture({ turn: { stopReason: null, refusal: { message: 'refused' } } }); try {
      const next = assign(g); g.update('tool_call', { at: 55 }); assert.throws(() => g.io.wait(next.returnPath, 1), (e) => e.graceSpent === true)
    } finally { cleanup(g) }
  } finally { cleanup(f) }
})
test('T7', () => {
  const f = fixture(); try { assign(f); f.update({ at: 1234 }); assert.equal(f.heartbeats[0].at, 1234) } finally { cleanup(f) }
})
test('T8', () => {
  const f = fixture(); try { assign(f); f.io.abort('builder'); assert.equal(f.calls.includes('cancel'), true) } finally { cleanup(f) }
})
test('T9', () => {
  const f = fixture(); try {
    const old = assign(f); assign(f, { reask: { id: 'd2', returnPath: join(f.paths.returnsDir, 'd2.builder.json') } })
    assert.equal(f.calls.includes('resumeSession'), false)
    f.update('tool_call', { at: 77 })
    assert.equal(f.heartbeats.length, 1)
    assert.throws(() => f.io.wait(old.returnPath, 0), (error) => error.graceSpent === false)
  } finally { cleanup(f) }
})
test('T10', () => {
  const f = fixture({ turn: { stopReason: 'end_turn', refusal: null } }); try {
    const out = assign(f); writeFileSync(out.returnPath, JSON.stringify({ status: 'done', assignment_id: 'stale' }))
    assert.throws(() => f.io.wait(out.returnPath, 0), (e) => e.stage === 'acp-no-envelope')
  } finally { cleanup(f) }
})
test('ACP resolves pi through PATH and refuses an unresolved binary', () => {
  const f = fixture()
  try {
    const binDir = join(f.root, 'bin'); mkdirSync(binDir)
    const piFile = join(binDir, 'pi'); writeFileSync(piFile, '#!/bin/sh\\n'); chmodSync(piFile, 0o755)
    let resolved = null
    const fake = { start() {}, initialize() {}, newSession() {}, beginPrompt() { return 1 }, close() { return { outcome: 'proven' } } }
    const io = acpIo({ crew: { members: { builder: { model: 'test' } } }, paths: f.paths, taskDir: f.paths.taskDir, checkout: f.root, bin: 'pi',
      deps: { env: { PATH: binDir }, existsSync: fsExistsSync, clientFactory: ({ launch }) => { resolved = launch.env.CREW_PI_BIN; return fake } } })
    io.assign({ role: 'builder', briefFile: f.briefFile })
    assert.equal(resolved, piFile)
    assert.equal(resolved.startsWith(process.cwd()), false)
    const missing = acpIo({ crew: { members: { builder: { model: 'test' } } }, paths: f.paths, taskDir: f.paths.taskDir, checkout: f.root, bin: 'pi',
      deps: { env: { PATH: '' }, existsSync: () => false, clientFactory: () => fake } })
    assert.throws(() => missing.assign({ role: 'builder', briefFile: f.briefFile }), (error) => error.stage === 'acp-bin-unresolved')
  } finally { cleanup(f) }
})

test('T11', () => {
  const f = fixture(); try {
    const calls = { pane: [], json: [], rpc: [], acp: [] }
    let paneSent = false
    let panePath = null
    const transport = (key) => ({ assign() { calls[key].push('assign'); return { id: `d-${key}`, returnPath: join(f.paths.returnsDir, `${key}.builder.json`) } }, wait() { calls[key].push('wait'); return { status: 'done' } } })
    const crew = { claude_bin: '/bin/true', members: {
      pane: { transport: DEFAULT_TRANSPORT, surface_id: 'surface-pane' },
      json: { transport: HEADLESS_TRANSPORT }, rpc: { transport: HEADLESS_RPC_TRANSPORT }, acp: { transport: ACP_TRANSPORT },
    } }
    const io = seatIo(crew, f.paths, f.root, null, {}, {}, {
      tree: () => ({}), locate: () => true, sendLine: () => { calls.pane.push('assign'); paneSent = true }, assignmentLine: () => 'assignment',
      existsSync: (path) => { if (paneSent && path === panePath) calls.pane.push('wait'); return path === panePath },
      readFileSync: (path) => path === panePath ? JSON.stringify({ status: 'done', assignment_id: 'd1' }) : '',
      logLine() {}, now: () => 100,
      headlessIo: () => transport('json'), headlessRpcIo: () => transport('rpc'), acpIo: () => transport('acp'),
    })
    for (const [role, key] of [['pane', 'pane'], ['json', 'json'], ['rpc', 'rpc'], ['acp', 'acp']]) {
      const out = io.assign({ role, briefFile: f.briefFile })
      if (role === 'pane') panePath = out.returnPath
      io.wait(out.returnPath, 1)
      if (key === 'pane') assert.deepEqual(calls.pane, ['assign', 'wait'])
      else assert.deepEqual(calls[key], ['assign', 'wait'])
    }
    assert.deepEqual(calls.acp, ['assign', 'wait'])
    assert.equal(calls.rpc.length, 2)
  } finally { cleanup(f) }
})

test('T13 the ACP launch carries the role charter, grants, config dir and seat env', () => {
  let spec
  const grants = { tools: [], extensions: ['crew/pi/extensions/submit.ts'], agents: [], skills: [], advisor: false }
  const spy = { grants, configDir: '/cfg', acpLaunch(s) { spec = s; return { bin: '/bin/node', args: [], env: {}, policy: { autoDeny: [], autoApprove: [], escalate: [] } } } }
  const advisor = { granted: ['builder'], endpoint: 'http://127.0.0.1:9/advise', model: 'adv-1', model_only: false }
  const crew = { members: { builder: { model: 'test', effort: 'high' } }, advisor }
  const advisorGrants = { ...grants, advisor: true }
  const f = fixture({ adapters: { builder: { ...spy, grants: advisorGrants } }, crew }); try {
    assign(f)
    assert.equal(spec.promptFile, join(f.paths.taskDir, 'role-builder.md'))
    assert.equal(spec.effort, 'high')
    assert.deepEqual(spec.advisorCell, { endpoint: 'http://127.0.0.1:9/advise', model: 'adv-1', models: undefined })
    assert.equal(spec.grants, advisorGrants)
    assert.equal(spec.configDir, '/cfg')
    assert.equal(spec.role, 'builder')
    assert.deepEqual(spec.env, { DEVTEAM_WORKER: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.paths.taskDir })
  } finally { cleanup(f) }
  const real = fixture(); try {
    assign(real)
    const args = real.launch.args
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], join(real.paths.taskDir, 'role-builder.md'))
  } finally { cleanup(real) }
})

test('T14 an ACP permission request is settled by the launch policy, then the lead, else reject_once', () => {
  const options = [{ optionId: 'a', kind: 'allow_once', name: 'Allow' }, { optionId: 'r', kind: 'reject_once', name: 'Reject' }]
  const policy = { autoDeny: ['bash'], autoApprove: ['read'], escalate: ['write'] }
  const adapters = { builder: { acpLaunch: () => ({ bin: '/bin/node', args: [], env: {}, policy }) } }
  const bare = fixture({ adapters }); try {
    assign(bare)
    assert.equal(bare.onPermission({ toolCall: { title: 'bash', kind: 'execute' }, options }), 'r')
    assert.equal(bare.onPermission({ toolCall: { title: 'read', kind: 'read' }, options }), 'a')
    assert.equal(bare.onPermission({ toolCall: { title: 'write', kind: 'edit' }, options }), 'r')
    assert.equal(bare.logs.find((row) => row.acp_permission_policy?.title === 'write').acp_permission_policy.policy, 'no-lead')
  } finally { cleanup(bare) }
  const asked = []
  const led = fixture({ adapters, permissionLead: (payload) => { asked.push(payload); return { decision: 'a' } } }); try {
    assign(led)
    assert.equal(led.onPermission({ toolCall: { title: 'write', kind: 'edit' }, options }), 'a')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].question, 'permit')
    assert.deepEqual(asked[0].options, ['a', 'r'])
  } finally { cleanup(led) }
})

test('T15 an empty or relative PATH segment is skipped, never resolved against the cwd', () => {
  const f = fixture(); try {
    let resolved = null
    const fake = { start() {}, initialize() {}, newSession() {}, beginPrompt() { return 1 }, close() { return { outcome: 'proven' } } }
    const io = acpIo({ crew: { members: { builder: { model: 'test' } } }, paths: f.paths, taskDir: f.paths.taskDir, checkout: f.root, bin: 'pi',
      deps: { env: { PATH: `:bin${delimiter}/opt/acp` }, existsSync: (path) => path === 'pi' || path === join('bin', 'pi') || path === '/opt/acp/pi',
        clientFactory: ({ launch }) => { resolved = launch.env.CREW_PI_BIN; return fake } } })
    io.assign({ role: 'builder', briefFile: f.briefFile })
    assert.equal(resolved, '/opt/acp/pi')
  } finally { cleanup(f) }
})
