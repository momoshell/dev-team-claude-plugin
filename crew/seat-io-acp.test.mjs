import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync as fsExistsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { acpIo, ACP_CENSUS_TURNS_ABSENT } from './acp-io.mjs'
import { acpLaunch as piAcpLaunch, capabilitiesFor as piCapabilitiesFor } from './adapters/adapter-pi.mjs'
import { ACP_BINARY, acpLaunch as claudeAcpLaunch, capabilitiesFor as claudeCapabilitiesFor } from './adapters/adapter-claude.mjs'
import { cellFailureKind, ACP_TRANSPORT, DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT, seatIo } from './seat-io.mjs'

function fixture(options = {}) {
  const root = scratchDir('acp-io-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const briefFile = join(root, 'brief.md'); writeFileSync(briefFile, 'brief body')
  const calls = []; const logs = []; const heartbeats = []; let sinks; let launch; let onPermission
  const pollResults = [...(options.pollResults ?? (Object.hasOwn(options, 'turn') ? [options.turn] : []))]
  let promptSeq = 16; let pending = false; let cancelledTurn = null; let cancelPollsRemaining = 0
  const fake = {
    sessionId: 'session-test',
    start() { calls.push('start') }, initialize() { calls.push('initialize') }, newSession(params) { calls.push(['newSession', params]) }, setMode(mode) { calls.push(['setMode', mode]) },
    beginPrompt(blocks) { calls.push(['beginPrompt', blocks]); if (options.guardPending && pending) throw new Error('overlapping prompt'); pending = true; return ++promptSeq },
    pollPrompt() { calls.push('pollPrompt'); if (options.pollError) throw options.pollError; if (cancelledTurn && cancelPollsRemaining > 0) { cancelPollsRemaining -= 1; return null }; const turn = pollResults.length ? pollResults.shift() : cancelledTurn; if (turn) { pending = false; cancelledTurn = null }; return turn || null },
    cancelPrompt(id) { calls.push(['cancelPrompt', id]); if (!options.cancelNoReply) { cancelledTurn = options.cancelTurn || { stopReason: 'cancelled', usage: null }; cancelPollsRemaining = options.cancelPollsRemaining || 0 } },
    resumeSession() { calls.push('resumeSession') }, cancel() { calls.push('cancel') },
    close() { calls.push('close'); return { outcome: 'proven', reason: 'fixture' } },
  }
  const io = acpIo({ crew: options.crew || { members: { builder: { model: 'test' } } }, paths, taskDir: paths.taskDir, checkout: root, adapters: options.adapters || {}, bin: '/bin/pi',
    deps: { clientFactory(opts) { sinks = opts.sinks; launch = opts.launch; onPermission = opts.onPermission; return fake }, permissionLead: options.permissionLead, permissionTimeoutMs: options.permissionTimeoutMs, log: options.log || ((row) => logs.push(row)), emit: (row) => heartbeats.push(row),
      existsSync: options.existsSync || ((path) => path === '/bin/pi' || fsExistsSync(path)), readFileSync: options.readFileSync, now: options.now || (() => 100), monotonic: options.monotonic, sleep: options.sleep || (() => {}), closeSettleMs: options.closeSettleMs, cancelSettleMs: options.cancelSettleMs } })
  return { root, paths, briefFile, io, calls, logs, heartbeats, queueTurn: (turn) => pollResults.push(turn), get launch() { return launch }, get onPermission() { return onPermission }, update: (kind, payload) => (typeof kind === 'string' ? sinks[kind](payload) : sinks.agent_message_chunk(kind)) }
}
function assign(f, extra = {}) { return f.io.assign({ role: 'builder', briefFile: f.briefFile, ...extra }) }
function cleanup(f) { rmSync(f.root, { recursive: true, force: true }) }

// MUTATION EA8: omit the off switch from the concrete ACP builder launch.
test('EA8 ACP builder launch receives edit assist off', () => {
  const f = fixture({ crew: { edit_assist: 'off', members: { builder: { agent: 'pi', model: 'test' } } } })
  try {
    assign(f)
    assert.equal(f.launch.env.CREW_EDIT_ASSIST, 'off')
  } finally { cleanup(f) }
})

test('A1 sleepdeadline', () => {
  let wall = 0, mono = 0, polls = 0, assignment
  const f = fixture({ now: () => wall, monotonic: () => mono, sleep: (ms) => {
    polls++
    if (polls === 3) { wall += 1200000; mono += 5000 } else { wall += ms; mono += ms }
    if (polls === 5) writeFileSync(assignment.returnPath, JSON.stringify({ assignment_id: assignment.id, role: 'builder', status: 'done' }))
  } })
  try {
    assignment = assign(f)
    wall = 0; mono = 0; polls = 0
    assert.equal(f.io.wait(assignment.returnPath, 900).status, 'done')
  } finally { cleanup(f) }
})

// MUTATION SC3: unwrap ACP emit and lose the operational channel.
test('SC3', () => {
  let wall = 0, mono = 0, polls = 0, assignment
  const f = fixture({ now: () => wall, monotonic: () => mono, sleep: (ms) => {
    polls++
    if (polls === 3) { wall += 1200000; mono += 5000 } else { wall += ms; mono += ms }
    if (polls === 5) writeFileSync(assignment.returnPath, JSON.stringify({ assignment_id: assignment.id, role: 'builder', status: 'done' }))
  } })
  try {
    assignment = assign(f)
    wall = 0; mono = 0; polls = 0
    assert.equal(f.io.wait(assignment.returnPath, 900).status, 'done')
    const rows = f.logs.filter((row) => row.event === 'host_suspended')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].channel, 'operational')
    assert.deepEqual({ role: rows[0].role, transport: rows[0].transport, slept_ms: rows[0].slept_ms }, { role: 'builder', transport: 'acp', slept_ms: 1195000 })
  } finally { cleanup(f) }
})

test('A1', () => {
  const f = fixture({ guardPending: true }); try {
    assign(f); assign(f, { id: 'next' })
    assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'cancelPrompt').length, 1)
    assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'beginPrompt').length, 2)
  } finally { cleanup(f) }
})
test('A2', () => {
  const late = { stopReason: 'end_turn', usage: null }
  const f = fixture({ guardPending: true, cancelTurn: late, cancelPollsRemaining: 1 }); try {
    assign(f); assign(f, { id: 'next' })
    assert.equal(f.logs.find((row) => row.acp_turn)?.acp_turn.stopReason, 'end_turn')
    assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'beginPrompt').length, 2)
  } finally { cleanup(f) }
})
test('A3', () => {
  const f = fixture({ cancelNoReply: true, guardPending: true, cancelSettleMs: 50 }); try {
    assign(f); assert.throws(() => assign(f, { id: 'next' }), (error) => error.stage === 'acp-session-busy')
    assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'beginPrompt').length, 1)
  } finally { cleanup(f) }
})
test('A4', () => {
  const f = fixture({ cancelNoReply: true, cancelSettleMs: 0 }); try {
    const prior = assign(f); assert.throws(() => assign(f, { id: 'next' }), (error) => error.stage === 'acp-session-busy')
    assert.deepEqual(f.logs.filter((row) => row.acp_turn_refused).map((row) => row.acp_turn_refused), [{ role: 'builder', reason: 'acp-session-busy', prior_assignment_id: prior.id, assignment_id: 'next' }])
  } finally { cleanup(f) }
})
test('A5', () => {
  const late = { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0 } }
  const f = fixture({ cancelNoReply: true, cancelSettleMs: 0 }); try {
    const prior = assign(f); assert.throws(() => assign(f, { id: 'next' }), (error) => error.stage === 'acp-session-busy')
    assert.equal(f.logs.filter((row) => row.acp_turn?.assignment_id === prior.id).length, 0, 'a busy refusal leaves the prior open')
    f.queueTurn(late)
    assign(f, { id: 'next' })
    assert.deepEqual(f.logs.filter((row) => row.acp_turn?.assignment_id === prior.id).map((row) => [row.acp_turn.stopReason, row.acp_turn.stop_reason_absent]), [['end_turn', null]])
    assert.equal(f.logs.filter((row) => row.seat_turn_census?.dispatch_id === prior.id).length, 1)
    assert.equal(f.heartbeats.filter((row) => row.kind === 'usage' && row.id === prior.id).length, 1)
  } finally { cleanup(f) }
})
test('A5 a prior still unanswered at close is recorded unread exactly once', () => {
  const f = fixture({ cancelNoReply: true, cancelSettleMs: 0, closeSettleMs: 0 }); try {
    const prior = assign(f); assert.throws(() => assign(f, { id: 'next' }), (error) => error.stage === 'acp-session-busy')
    f.io.close()
    assert.equal(f.logs.filter((row) => row.acp_turn?.assignment_id === prior.id && row.acp_turn.stop_reason_absent === 'response-unread').length, 1)
    assert.equal(f.logs.filter((row) => row.seat_turn_census?.dispatch_id === prior.id).length, 1)
  } finally { cleanup(f) }
})
test('A6', () => {
  let time = 0
  const f = fixture({ cancelNoReply: true, closeSettleMs: 50, cancelSettleMs: 100, now: () => time, sleep: (ms) => { time += ms } }); try {
    assign(f); assert.throws(() => assign(f, { id: 'next' }), (error) => error.stage === 'acp-session-busy')
    assert.equal(time, 150)
  } finally { cleanup(f) }
})
test('A7', () => {
  const f = fixture({ cancelNoReply: false, adapters: { builder: { acpLaunch: () => ({ bin: '/bin/pi', args: [], env: {} }), capabilitiesFor: () => ({ session_resume: true }) } } }); try {
    const prior = assign(f); assign(f, { reask: { id: 'next', returnPath: join(f.paths.returnsDir, 'next.json') } })
    const cancelAt = f.calls.findIndex((call) => Array.isArray(call) && call[0] === 'cancelPrompt')
    const resumeAt = f.calls.indexOf('resumeSession')
    const beginAt = f.calls.findIndex((call, index) => index > cancelAt && Array.isArray(call) && call[0] === 'beginPrompt')
    assert.ok(cancelAt >= 0 && cancelAt < resumeAt && resumeAt < beginAt)
    assert.equal(f.logs.filter((row) => row.acp_turn?.assignment_id === prior.id).length, 1)
  } finally { cleanup(f) }
})

test('A1 skill-read ACP row is explicitly unmeasured', () => {
  const f = fixture(); try {
    const out = assign(f)
    f.io.teardown()
    const census = f.logs.find((entry) => entry.seat_turn_census)?.seat_turn_census
    assert.equal(census.dispatch_id, out.id)
    assert.equal(census.transport, 'acp')
    assert.equal(census.skill_reads, null)
  } finally { cleanup(f) }
})

test('CC1', () => {
  const f = fixture(); try {
    const out = assign(f); f.io.teardown()
    const rows = f.logs.filter((entry) => entry.seat_turn_census)
    assert.equal(rows.length, 1)
    assert.ok(f.logs.indexOf(rows[0]) > f.logs.findIndex((entry) => entry.acp_turn))
    assert.deepEqual(rows[0].seat_turn_census, { role: 'builder', dispatch_id: out.id, transport: 'acp', model: 'test', session_id: 'session-test', turns: null, tool_calls: null, skill_reads: null, context_first_tokens: null, context_peak_tokens: null, context_mean_tokens: null, context_calls: null, context_absent_reason: 'aggregate-usage-only', absent_reason: ACP_CENSUS_TURNS_ABSENT })
  } finally { cleanup(f) }
})
test('C2', () => {
  const f = fixture(); try {
    assign(f); f.update('tool_call', { update: { sessionUpdate: 'tool_call', toolCallId: 'x' } }); f.io.teardown()
    assert.equal(f.logs.find((entry) => entry.seat_turn_census).seat_turn_census.turns, null)
  } finally { cleanup(f) }
})
test('C3', () => {
  const f = fixture(); try {
    assign(f)
    for (const id of ['x', 'x', 'y']) f.update('tool_call', { update: { sessionUpdate: 'tool_call', toolCallId: id } })
    f.io.teardown()
    assert.equal(f.logs.find((entry) => entry.seat_turn_census).seat_turn_census.tool_calls, 2)
  } finally { cleanup(f) }
})
test('C4', () => {
  const f = fixture({ log(row) { if (row.seat_turn_census) throw new Error('census unavailable') } }); try {
    const out = assign(f); writeFileSync(out.returnPath, JSON.stringify({ status: 'done', assignment_id: out.id }))
    assert.equal(f.io.wait(out.returnPath, 1).assignment_id, out.id)
  } finally { cleanup(f) }
})
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
test('ACP C1 close and replacement settle delayed billed turns', () => {
  const usage = { inputTokens: 1, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4 }
  const turn = { stopReason: 'end_turn', usage }
  const f = fixture({ pollResults: [null, turn], closeSettleMs: 25 }); try {
    assign(f); f.io.teardown()
    assert.equal(f.logs.find((row) => row.acp_turn)?.acp_turn.stopReason, 'end_turn')
    assert.deepEqual(f.heartbeats.filter((row) => row.kind === 'usage')[0].usage, { billed_input_tokens: 1, billed_output_tokens: 2, billed_cache_read_tokens: 3, billed_cache_write_tokens: 4 })
  } finally { cleanup(f) }
  const g = fixture({ pollResults: [null, turn], closeSettleMs: 25 }); try {
    const old = assign(g); assign(g, { id: 'next', returnPath: join(g.paths.returnsDir, 'next.builder.json') })
    assert.equal(g.logs.find((row) => row.acp_turn?.assignment_id === old.id).acp_turn.stopReason, 'end_turn')
  } finally { cleanup(g) }
})
test('ACP C2 closing polls are bounded and report unread usage', () => {
  let time = 0; let sleeps = 0
  const f = fixture({ now: () => time, sleep: (ms) => { sleeps++; time += ms } }); try {
    assign(f); f.io.teardown()
    const row = f.logs.find((entry) => entry.acp_turn).acp_turn
    assert.equal(row.stop_reason_absent, 'response-unread'); assert.equal(row.usage, null); assert.equal(row.usage_reason, 'usage-unavailable')
    assert.ok(time <= 3025); assert.ok(f.calls.filter((call) => call === 'pollPrompt').length <= 122); assert.ok(sleeps > 0)
  } finally { cleanup(f) }
  const frozen = fixture({ now: () => 100, sleep() {} }); try {
    assign(frozen); frozen.io.teardown()
    assert.ok(frozen.calls.filter((call) => call === 'pollPrompt').length <= 122)
  } finally { cleanup(frozen) }
})
test('ACP C3 abort cancels before its zero-window poll and does not sleep', () => {
  let sleeps = 0
  const f = fixture({ sleep: () => { sleeps++ }, pollResults: [null] }); try {
    assign(f); f.io.abort('builder')
    assert.ok(f.calls.indexOf('cancel') < f.calls.indexOf('pollPrompt')); assert.equal(sleeps, 0)
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
  const i = fixture({ pollResults: [null, null], cancelNoReply: true }); try {
    const old = assign(i); assert.throws(() => assign(i, { reask: { id: 'd2', returnPath: old.returnPath } }), (error) => error.stage === 'acp-session-busy')
    assert.equal(i.logs.filter((e) => e.acp_turn?.assignment_id === old.id).length, 0)
    i.io.close()
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
  const f = fixture({ pollResults: [null, null], cancelNoReply: true }); try {
    const old = assign(f); assert.throws(() => f.io.wait(old.returnPath, 0), (error) => error.stage === 'acp-no-envelope')
    assert.throws(() => assign(f, { id: 'd4', returnPath: join(f.paths.returnsDir, 'd4.builder.json') }), (error) => error.stage === 'acp-session-busy')
    assert.equal(f.logs.filter((row) => row.acp_turn?.assignment_id === old.id).length, 0)
    f.io.close()
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
test('Claude ACP nested adapter launches its own binary', () => {
  const f = fixture({ crew: { claude_bin: '/frozen/claude', members: { builder: { agent: 'claude', model: 'opus', tools: 'Read' } } }, adapters: { builder: { name: 'claude', adapter: { ACP_BINARY: '/bin/claude-agent-acp', capabilitiesFor() { return {} }, acpLaunch(spec) { return { bin: spec.bin, args: [], env: { CLAUDE_CODE_EXECUTABLE: spec.claudeBin } } } } } } })
  try {
    assign(f)
    assert.equal(f.launch.bin, '/bin/claude-agent-acp')
    assert.equal(f.launch.env.CLAUDE_CODE_EXECUTABLE, '/frozen/claude')
    assert.equal(f.calls.some((entry) => Array.isArray(entry) && entry[0] === 'newSession'), true)
  } finally { cleanup(f) }
})

test('R3 unregistered ACP agent refuses by name', () => {
  const f = fixture({ crew: { members: { builder: { agent: 'codex' } } }, adapters: { builder: { grants: {} } } })
  try { assert.throws(() => assign(f), (error) => error.stage === 'acp-launch-unsupported' && /codex/.test(error.message)) } finally { cleanup(f) }
})

test('ACP named unsupported adapter refuses without Pi fallback', () => {
  const f = fixture({ crew: { members: { builder: { agent: 'unsupported-agent' } } }, adapters: { builder: { name: 'unsupported-agent', adapter: { capabilitiesFor() { return {} } } } } })
  try { assert.throws(() => assign(f), (error) => error.stage === 'acp-launch-unsupported' && /unsupported-agent/.test(error.message)) } finally { cleanup(f) }
})

function wireFixture({ rejectMode = false } = {}) {
  const root = scratchDir('acp-wire-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const briefFile = join(root, 'brief.md'); writeFileSync(briefFile, 'wire brief')
  const stream = join(paths.taskDir, 'acp', 'reviewer', 'stream.jsonl')
  const records = readFileSync(new URL('../test/fixtures/acp/claude-turn.ndjson', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
  const responseFor = (method) => {
    const req = records.find((row) => row.dir === 'client->agent' && row.frame?.method === method)?.frame
    return records.find((row) => row.dir === 'agent->client' && row.frame?.id === req?.id && !row.frame?.method)?.frame
  }
  const sent = []; const logs = []; const heartbeats = []
  const clientDeps = {
    pid: 901, spawn() { return { pid: 902, unref() {} } }, openSync: () => 7, closeSync() {},
    existsSync: (path) => path.endsWith('cmd.fifo') || fsExistsSync(path),
    kill() { writeFileSync(join(paths.taskDir, 'acp', 'reviewer', 'exit'), '0') },
    now: (() => { let n = 0; return () => ++n })(), sleep() {},
    writeSync(_fd, text) {
      const frame = JSON.parse(text); sent.push(frame)
      if (!frame.method || !Object.hasOwn(frame, 'id')) return
      const answer = rejectMode && frame.method === 'session/set_mode'
        ? { jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'unsupported mode' } }
        : { ...responseFor(frame.method), id: frame.id }
      appendFileSync(stream, `${JSON.stringify(answer)}\n`)
    },
  }
  const io = acpIo({ crew: { claude_bin: '/frozen/claude', members: { reviewer: { agent: 'claude', model: 'claude-test', tools: 'Read,Write', deny: 'Edit,NotebookEdit', effort: 'high' } } }, paths, taskDir: paths.taskDir, checkout: root,
    adapters: { reviewer: { name: 'claude', adapter: { ACP_BINARY, capabilitiesFor: claudeCapabilitiesFor, acpLaunch: claudeAcpLaunch } } },
    deps: { env: { PATH: '/fake-bin' }, existsSync: (path) => path === '/fake-bin/claude-agent-acp' || fsExistsSync(path), clientDeps, sleep() {}, log: (row) => logs.push(row), emit: (row) => heartbeats.push(row) } })
  return { root, paths, briefFile, io, sent, logs, heartbeats, close() { io.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('Claude ACP session options and mode reach the wire', () => {
  const f = wireFixture()
  try {
    const out = f.io.assign({ role: 'reviewer', briefFile: f.briefFile })
    const methods = f.sent.map((frame) => frame.method)
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/set_mode', 'session/prompt'])
    const params = f.sent.find((frame) => frame.method === 'session/new').params
    assert.deepEqual(params._meta.claudeCode.options.additionalDirectories, [f.paths.taskDir, f.paths.returnsDir])
    assert.deepEqual(params._meta.claudeCode.options.allowedTools, ['Read', 'Write'])
    assert.deepEqual(params._meta.claudeCode.options.disallowedTools, ['Edit', 'NotebookEdit', 'mcp__*'])
    assert.equal(f.sent.find((frame) => frame.method === 'session/set_mode').params.modeId, 'acceptEdits')
    writeFileSync(out.returnPath, JSON.stringify({ assignment_id: out.id, role: 'reviewer', status: 'done', summary: 'wire envelope', artifacts: [], details: {} }))
    assert.equal(f.io.wait(out.returnPath, 1).assignment_id, out.id)
    assert.equal(f.logs.find((row) => row.acp_turn)?.acp_turn.stopReason, 'end_turn')
    assert.deepEqual(f.heartbeats.find((row) => row.kind === 'usage')?.usage, { billed_input_tokens: 4, billed_output_tokens: 138, billed_cache_read_tokens: 41166, billed_cache_write_tokens: 9001 })
    assert.equal(f.io.close()[0].transport, 'acp')
  } finally { f.close() }
})

test('Claude ACP rejected mode stops before prompt', () => {
  const denied = wireFixture({ rejectMode: true })
  try {
    assert.throws(() => denied.io.assign({ role: 'reviewer', briefFile: denied.briefFile }), (error) => error.reason === 'acp-protocol-mismatch')
    assert.equal(denied.sent.some((frame) => frame.method === 'session/prompt'), false)
  } finally { denied.close() }
})

test('ACP Pi and flat adapters preserve session behavior', () => {
  for (const adapter of [piAcpLaunch ? { name: 'pi', adapter: { acpLaunch: piAcpLaunch, capabilitiesFor: piCapabilitiesFor } } : {}, { acpLaunch: () => ({ bin: '/bin/flat', args: [], env: {} }) }]) {
    const f = fixture({ adapters: { builder: adapter } })
    try { assign(f); assert.deepEqual(f.calls.find((entry) => Array.isArray(entry) && entry[0] === 'newSession')[1], { cwd: f.root, mcpServers: [] }); assert.equal(f.calls.some((entry) => Array.isArray(entry) && entry[0] === 'setMode'), false) } finally { cleanup(f) }
  }
})

test('Claude ACP PATH absence refuses by name', () => {
  const f = fixture({ crew: { claude_bin: '/frozen/claude', members: { builder: { agent: 'claude' } } }, adapters: { builder: { name: 'claude', adapter: { ACP_BINARY, capabilitiesFor: claudeCapabilitiesFor, acpLaunch: claudeAcpLaunch } } }, existsSync: () => false })
  try { assert.throws(() => assign(f), (error) => error.stage === 'acp-bin-unresolved' && error.message.includes('claude-agent-acp')) } finally { cleanup(f) }
})

test('Claude ACP outside write rejects without a lead', () => {
  const f = fixture({ crew: { claude_bin: '/frozen/claude', members: { builder: { agent: 'claude', model: 'opus' } } }, adapters: { builder: { name: 'claude', adapter: { ACP_BINARY: '/bin/claude-agent-acp', capabilitiesFor: claudeCapabilitiesFor, acpLaunch: claudeAcpLaunch } } } })
  try {
    assign(f)
    const options = [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }, { optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
    assert.equal(f.onPermission({ toolCall: { kind: 'edit', title: 'Write /elsewhere' }, options }), 'reject')
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

test('ADR047 R3 the ACP launch spells the consult with the adapter', () => {
  let spec
  const grants = { tools: [], extensions: [], agents: [], skills: [], advisor: true }
  const spy = { grants, configDir: '/cfg', acpLaunch(s) { spec = s; return { bin: '/bin/node', args: [], env: {}, policy: { autoDeny: [], autoApprove: [], escalate: [] } } } }
  const advisor = { granted: ['builder'], endpoint: '', model: 'openai/gpt-6-sol', consult_model: 'openai-codex/gpt-6-sol', models: { 'openai/gpt-6-sol': { tag: 1 } }, model_only: true }
  const crew = { members: { builder: { model: 'test', effort: 'high' } }, advisor }
  const f = fixture({ adapters: { builder: spy }, crew }); try {
    assign(f)
    assert.deepEqual(spec.advisorCell, { endpoint: '', model: 'openai-codex/gpt-6-sol', models: { 'openai-codex/gpt-6-sol': { tag: 1 } } })
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
    assert.deepEqual(spec.grants, advisorGrants)
    assert.equal(spec.grants.advisor, true)
    assert.ok(spec.grants.extensions.includes('crew/pi/extensions/submit.ts'), 'the ACP seat lost its envelope-submission grant')
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

test('K18 ACP IO passes the per-seat taskDir into adapter launch', () => {
  // MUTATION: remove taskDir from acpIo's launchFn input.
  let spec
  const spy = { grants: { extensions: ['builtin:codemode'] }, configDir: '/cfg', acpLaunch(value) { spec = value; return { bin: '/bin/node', args: [], env: {}, policy: { autoDeny: [], autoApprove: [], escalate: [] } } } }
  const f = fixture({ adapters: { builder: spy } })
  try { assign(f); assert.equal(spec.taskDir, f.paths.taskDir) } finally { cleanup(f) }
})

test('ACP lead permission wiring is role-scoped and supplies the configured timeout', () => {
  const options = [{ optionId: 'a', kind: 'allow_once', name: 'Allow' }, { optionId: 'r', kind: 'reject_once', name: 'Reject' }]
  const asked = []
  const f = fixture({ permissionTimeoutMs: 1234, permissionLead: (payload) => { asked.push(payload); return { decision: 'a' } } })
  try {
    assign(f)
    assert.equal(f.launch.env.CREW_ACP_PERMISSION_TIMEOUT_MS, '1234')
    assert.equal(f.onPermission({ toolCall: { title: 'write', kind: 'edit' }, options }), 'a')
    assert.equal(asked.length, 0)
    assert.equal(f.logs.find((row) => row.acp_permission_policy?.title === 'write').acp_permission_policy.policy, 'roster')
  } finally { cleanup(f) }
  const noLead = fixture()
  try { assign(noLead); assert.equal(Object.hasOwn(noLead.launch.env, 'CREW_ACP_PERMISSION_TIMEOUT_MS'), false) } finally { cleanup(noLead) }
  const gatedPolicy = { autoDeny: [], autoApprove: [], escalate: ['write'] }
  const adapters = { builder: { acpLaunch: () => ({ bin: '/bin/node', args: [], env: {}, policy: gatedPolicy }) } }
  const escalatedCalls = []
  const escalated = fixture({ adapters, permissionTimeoutMs: 1234, permissionLead: (payload) => { escalatedCalls.push(payload); return { decision: 'a' } } })
  try {
    assign(escalated)
    assert.equal(escalated.onPermission({ toolCall: { title: 'write', kind: 'edit' }, options }), 'a')
    assert.equal(escalatedCalls.length, 1)
    assert.equal(escalatedCalls[0].role, 'builder')
  } finally { cleanup(escalated) }
  const leadCrew = { members: { lead: { model: 'test' } } }
  const lead = fixture({ crew: leadCrew, permissionTimeoutMs: 1234, permissionLead: () => ({ decision: 'a' }) })
  try { lead.io.assign({ role: 'lead', briefFile: lead.briefFile }); assert.equal(lead.onPermission({ toolCall: { title: 'write', kind: 'edit' }, options }), 'r') } finally { cleanup(lead) }
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

test('seatIo permission lead setter updates lazy transport deps and clears on null', () => {
  const f = fixture(); try {
    let factoryDeps
    const crew = { claude_bin: '/bin/true', members: { builder: { transport: 'acp' } } }
    const routed = seatIo(crew, f.paths, f.root, null, {}, {}, {
      acpIo: (args) => { factoryDeps = args.deps; return { assign: () => ({ id: 'd1', returnPath: join(f.paths.returnsDir, 'x.json') }) } },
      logLine() {}, now: () => 100,
    })
    const consult = () => ({ decision: 'a' })
    routed.setPermissionLead(consult, { timeoutMs: 987 })
    routed.assign({ role: 'builder', briefFile: f.briefFile })
    assert.equal(factoryDeps.permissionLead, consult)
    assert.equal(factoryDeps.permissionTimeoutMs, 987)
    routed.setPermissionLead(null)
    assert.equal(factoryDeps.permissionLead, null)
    assert.equal(factoryDeps.permissionTimeoutMs, undefined)
  } finally { cleanup(f) }
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

import { acpProviderFailureKind, PROVIDER_RESET_ABSENT, PARK_BEAT_EVENT, PARK_BEAT_SOURCE } from './headless.mjs'

const AR_CAPTURE_USAGE = '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"b7b4cf9e-5ed2-4cde-8bb3-fe0220dd3331","update":{"sessionUpdate":"usage_update","used":92883,"size":1000000,"_meta":{"_claude/rateLimit":{"status":"rejected","resetsAt":1791236400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1791236400},"seven_day":{"utilization":0.69,"resetsAt":1791590400}}},"_claude/model":"claude-opus-5-5"}}}}'
const AR_CAPTURE_REFUSAL = '{"jsonrpc":"2.0","id":5,"error":{"code":-32603,"message":"Internal error: You\'ve hit your session limit · resets 11:40pm (Europe/Belgrade)","data":{"errorKind":"rate_limit"}}}'
const AR_RESET_AT = 1791236400000
function arReadDisk(paths) { return JSON.parse(readFileSync(join(paths.dir, 'crew.json'), 'utf8')) }
function arHarness({ updates = true, errorKind = 'rate_limit', integrated = false } = {}) {
  const root = scratchDir('acp-provider-ar-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const briefFile = join(root, 'brief.md'); writeFileSync(briefFile, 'Recorded provider refusal replay.')
  const crew = { claude_bin: '/bin/true', members: { reviewer: { agent: 'pi', model: 'test', transport: 'acp' } } }
  writeFileSync(join(root, 'crew.json'), JSON.stringify(crew))
  const logs = [], prompts = [], parks = []
  let clock = AR_RESET_AT - 10000, sinks, count = 0, refused = false, workStarted = null, activeId = integrated ? 'd1' : 'd2'
  const rejectionPrompt = integrated ? 2 : 1
  const pathFor = (id) => join(paths.returnsDir, id + '.reviewer.json')
  const envelope = (id) => ({ assignment_id: id, role: 'reviewer', status: 'done', summary: 'replayed', artifacts: [], details: {} })
  const writeEnvelope = (id) => writeFileSync(pathFor(id), JSON.stringify(envelope(id)))
  function advance(ms) {
    try { const park = arReadDisk(paths).park; if (park) parks.push(structuredClone(park)) } catch {}
    clock += ms
    if (workStarted !== null && clock - workStarted >= 500) { writeEnvelope(activeId); workStarted = null }
  }
  const fake = {
    sessionId: 'b7b4cf9e-5ed2-4cde-8bb3-fe0220dd3331',
    start() {}, initialize() {}, newSession() {}, setMode() {}, resumeSession() {},
    beginPrompt(blocks) {
      count++; prompts.push(structuredClone(blocks))
      if (integrated && count === 1) writeEnvelope('d1')
      if (count > rejectionPrompt) workStarted = clock
      return count
    },
    pollPrompt() {
      if (integrated && count === 1) return { stopReason: 'end_turn', usage: null, refusal: null }
      if (count === rejectionPrompt && !refused) {
        refused = true
        const update = JSON.parse(AR_CAPTURE_USAGE)
        if (updates) sinks.usage_update({ sessionId: update.params.sessionId, kind: 'usage_update', update: update.params.update, at: clock })
        const frame = JSON.parse(AR_CAPTURE_REFUSAL)
        frame.error.data.errorKind = errorKind
        const refusal = { code: frame.error.code ?? null, message: frame.error.message ?? null, errorKind: frame.error?.data?.errorKind ?? null }
        return { stopReason: null, usage: null, refusal }
      }
      return null
    },
    cancelPrompt() {}, cancel() {}, close() { return { outcome: 'proven', reason: 'fake' } },
  }
  const deps = { now: () => clock, monotonic: () => clock, sleep: advance, delay: advance, log: (row) => logs.push(row),
    clientFactory(opts) { sinks = opts.sinks; return fake } }
  const directArgs = { crew, paths, taskDir: paths.taskDir, checkout: root, bin: '/bin/true', deps }
  const io = integrated
    ? seatIo(crew, paths, root, null, {}, {}, { now: () => clock, sleep: advance, resolveWorkerBin: () => '/bin/true',
        logLine(_path, row) { logs.push(row) }, acpIo: (args) => acpIo({ ...args, bin: '/bin/true', deps: { ...args.deps, ...deps } }) })
    : acpIo(directArgs)
  if (integrated) {
    const first = io.assign({ role: 'reviewer', briefFile, id: 'd1', returnPath: pathFor('d1') })
    io.wait(first.returnPath, 1)
    activeId = 'd2'
  }
  const assignment = io.assign({ role: 'reviewer', briefFile, id: 'd2', returnPath: pathFor('d2') })
  function observe() {
    try { return { envelope: io.wait(assignment.returnPath, 1), error: null } }
    catch (error) { return { envelope: null, error } }
  }
  function sendUsage(updateObj) { sinks.usage_update({ sessionId: 'b7b4cf9e-5ed2-4cde-8bb3-fe0220dd3331', kind: 'usage_update', update: updateObj, at: clock }) }
  return { io, root, paths, briefFile, logs, prompts, parks, assignment, observe, envelope, pathFor, writeEnvelope, sendUsage, readDisk: () => arReadDisk(paths),
    cleanup() { rmSync(root, { recursive: true, force: true }) } }
}
function arWithHarness(options, fn) { const f = arHarness(options); try { return fn(f) } finally { f.cleanup() } }
function arErrorView(error) { return error ? { stage: error.stage ?? null, message: error.message, providerFailure: error.providerFailure ?? null, providerRetry: error.providerRetry ?? null } : null }

// MUTATION AR1: classify the measured rate_limit as null rather than rate_limit.
test('AR1', () => {
  const table = [
    ['rate_limit', 'rate_limit'], ['overloaded', 'server_error'], ['server_error', 'server_error'],
    ['authentication_failed', 'authentication_failed'], ['oauth_org_not_allowed', 'authentication_failed'], ['verification_required', 'authentication_failed'],
    ...['no_result', 'unknown', 'billing_error', 'account_on_hold', 'cloud_credential_error', 'invalid_request', 'model_not_found', 'max_output_tokens', 'incomplete_tool_call', 'worker_shutdown', 'transport_lost', 'not-a-kind', null, undefined].map((x) => [x, null]),
  ]
  const observed = table.map(([input]) => [input, acpProviderFailureKind?.(input) ?? null])
  assert.deepEqual(observed, table)
})

// MUTATION AR2: drop the measured reset instant when recording usage_update.
test('AR2', () => {
  arWithHarness({}, (f) => {
    const out = f.observe()
    assert.deepEqual(out.envelope ?? arErrorView(out.error), f.envelope('d2'))
    const row = f.logs.find((x) => x.event === 'provider-retry')
    assert.deepEqual(row && { kind: row.kind, status: row.status, waited_on: row.waited_on, reset_at: row.reset_at },
      { kind: 'rate_limit', status: null, waited_on: 'reset-time', reset_at: AR_RESET_AT })
    assert.equal(f.prompts.length, 2)
    for (const blocks of f.prompts) {
      assert.match(blocks[0].text, /ASSIGNMENT d2/)
      assert.ok(blocks[0].text.includes(f.assignment.returnPath), 're-prompt preserves returnPath')
    }
    assert.equal(f.logs.filter((x) => x.event === 'provider-retry-resumed').length, 1)
  })
  arWithHarness({ errorKind: 'overloaded' }, (f) => {
    const out = f.observe()
    assert.deepEqual(out.envelope ?? arErrorView(out.error), f.envelope('d2'))
    const row = f.logs.find((x) => x.event === 'provider-retry')
    assert.equal(row?.kind, 'server_error')
    assert.equal(row?.waited_on, 'backoff-ladder')
    assert.equal(f.logs.filter((x) => x.event === 'provider-retry-resumed').length, 1)
  })
})

// MUTATION AR3: remove the providerFailure annotation from the thrown error.
test('AR3', () => {
  arWithHarness({ updates: false, errorKind: 'authentication_failed' }, (f) => {
    const { error } = f.observe()
    assert.deepEqual(error?.providerFailure ?? null, { kind: 'authentication_failed', status: null })
    assert.equal(error?.providerRetry?.attempts ?? null, 0)
    assert.match(error.message, /\[provider authentication_failed status null: 0 of 3 retry attempts spent over 0ms/)
    assert.equal(f.logs.filter((x) => x.event === 'provider-retry-declined').length, 1)
    assert.equal(f.prompts.length, 1)
  })
})

// MUTATION AR4: report NO_RESET_FIELD instead of NO_FRAME for an assignment without usage_update.
test('AR4', () => {
  arWithHarness({ updates: false }, (f) => {
    const { error } = f.observe()
    assert.ok(typeof error?.providerRetry?.declined === 'string' && error.providerRetry.declined.includes(PROVIDER_RESET_ABSENT.NO_FRAME),
      JSON.stringify(arErrorView(error)))
    assert.equal(f.parks.length, 0)
    assert.equal(f.logs.filter((x) => x.event === 'provider-retry').length, 0)
  })
  arWithHarness({ updates: false }, (f) => {
    f.sendUsage({ sessionUpdate: 'usage_update', _meta: { '_claude/rateLimit': { status: 'allowed', resetsAt: 1791236400 } } })
    const { error } = f.observe()
    assert.ok(String(error?.providerRetry?.declined ?? '').includes(PROVIDER_RESET_ABSENT.NO_FRAME), JSON.stringify(arErrorView(error)))
    assert.equal(f.logs.filter((x) => x.event === 'provider-retry').length, 0)
  })
  arWithHarness({ updates: false }, (f) => {
    f.sendUsage({ sessionUpdate: 'usage_update', _meta: { '_claude/rateLimit': { status: 'rejected', resetsAt: 1791236400 } } })
    f.sendUsage({ sessionUpdate: 'usage_update', _meta: { '_claude/rateLimit': { status: 'rejected', resetsAt: 'tomorrow' } } })
    const { error } = f.observe()
    assert.ok(String(error?.providerRetry?.declined ?? '').includes(PROVIDER_RESET_ABSENT.NO_RESET_FIELD), JSON.stringify(arErrorView(error)))
    assert.equal(f.logs.filter((x) => x.event === 'provider-retry').length, 0)
  })
  const sf = (() => {
    const root = scratchDir('acp-provider-ar-stale-');
    const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') };
    mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir);
    const briefFile = join(root, 'brief.md'); writeFileSync(briefFile, 'Recorded provider refusal replay.');
    const crew = { claude_bin: '/bin/true', members: { reviewer: { agent: 'pi', model: 'test', transport: 'acp' } } };
    writeFileSync(join(root, 'crew.json'), JSON.stringify(crew));
    const logs = [];
    let clock = AR_RESET_AT - 10000, sinks, count = 0, refused = false;
    const pathFor = (id) => join(paths.returnsDir, id + '.reviewer.json');
    const fake = {
      sessionId: 'stale-test',
      start() {}, initialize() {}, newSession() {}, setMode() {}, resumeSession() {},
      beginPrompt(blocks) { count++; return count },
      pollPrompt() {
        if (count === 1) return { stopReason: 'end_turn', usage: null, refusal: null };
        if (count === 2 && !refused) {
          refused = true;
          return { stopReason: null, usage: null, refusal: { code: -32603, message: 'stale-limit', errorKind: 'rate_limit' } };
        }
        return null;
      },
      cancelPrompt() {}, cancel() {}, close() { return { outcome: 'proven', reason: 'fake' } },
    };
    const io = acpIo({ crew, paths, taskDir: paths.taskDir, checkout: root, bin: '/bin/true', deps: { now: () => clock, monotonic: () => clock, sleep: (ms) => { clock += ms }, delay: (ms) => { clock += ms }, log: (row) => logs.push(row), clientFactory(opts) { sinks = opts.sinks; return fake } } });
    return { io, root, paths, briefFile, logs, pathFor, sendValid() { sinks.usage_update({ sessionId: 'stale-test', kind: 'usage_update', update: { sessionUpdate: 'usage_update', _meta: { '_claude/rateLimit': { status: 'rejected', resetsAt: 1791236400 } } }, at: clock }) }, cleanup() { rmSync(root, { recursive: true, force: true }) } };
  })();
  try {
    const d1 = sf.io.assign({ role: 'reviewer', briefFile: sf.briefFile, id: 'd1', returnPath: sf.pathFor('d1') });
    sf.sendValid();
    writeFileSync(sf.pathFor('d1'), JSON.stringify({ assignment_id: 'd1', role: 'reviewer', status: 'done', summary: 'replayed', artifacts: [], details: {} }));
    assert.equal(sf.io.wait(d1.returnPath, 1).assignment_id, 'd1');
    const d2 = sf.io.assign({ role: 'reviewer', briefFile: sf.briefFile, id: 'd2', returnPath: sf.pathFor('d2') });
    let error = null;
    try { sf.io.wait(d2.returnPath, 1) } catch (e) { error = e }
    assert.ok(String(error && error.providerRetry && error.providerRetry.declined || '').includes(PROVIDER_RESET_ABSENT.NO_FRAME), JSON.stringify(arErrorView(error)));
  } finally { sf.cleanup() }
});

// MUTATION AR5: make ACP's shared-factory reassign callback throw instead of re-prompting d2.
test('AR5', () => {
  arWithHarness({ integrated: true }, (f) => {
    const out = f.observe()
    assert.deepEqual(out.envelope ?? arErrorView(out.error), f.envelope('d2'))
    assert.equal(f.prompts.length, 3)
    assert.equal(f.logs.filter((x) => x.event === 'provider-retry-resumed').length, 1)
  })
})

// MUTATION AR6: persist null instead of the live park object in writePark.
test('AR6', () => {
  arWithHarness({}, (f) => {
    f.observe()
    const beats = f.logs.filter((x) => x.event === PARK_BEAT_EVENT)
    assert.ok(beats.length > 0, JSON.stringify({ beats: beats.length, parks: f.parks.length }))
    assert.ok(beats.every((x) => x.source === PARK_BEAT_SOURCE && x.role === 'reviewer'))
    assert.ok(f.parks.some((x) => x.assignment_id === 'd2' && x.role === 'reviewer'), JSON.stringify(f.parks.slice(0, 2)))
    assert.equal(f.readDisk().park, null)
  })
  const f = arHarness({})
  try {
    const origSleep = f.io ? null : null
    void origSleep
    f.observe()
    const beats = f.logs.filter((x) => x.event === PARK_BEAT_EVENT)
    assert.ok(beats.length > 0)
    assert.ok(beats.every((x) => x.source === PARK_BEAT_SOURCE))
  } finally { f.cleanup() }
})
