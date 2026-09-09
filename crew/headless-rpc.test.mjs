import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, rmSync, constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { EVIDENCE_KINDS, LIVENESS, reclaimStore } from './reclaim.mjs'
import {
  carriesOwnSpend, closedReason, emptyTurnEnvelope, finaliseCensus, finalisePreFirstTurn, foldCensusFrame, foldRpcUsage, headlessRpcIo, isBriefReadToolCall, isBusyRefusal, newCensus, PRE_FIRST_TURN_ABSENT_REASONS, PRE_FIRST_TURN_TOLERANCE_MS, PROMPT_REFUSAL_RETRIES, RPC_PROMPT_DELIVERY_WINDOW_MS,
  rpcCensus, rpcCommand, rpcDeliveryCorpusReport, rpcStreamCensus, seatCommandPath, SETTLE_GATE_POLLS, splitFrames, steerFrame, teardownOutcome,
} from './headless-rpc.mjs'
import { seatCommand as piSeatCommand } from './adapters/adapter-pi.mjs'
import { assignmentLine } from './driver.mjs'
import { cellFailureKind } from './seat-io.mjs'
import { CENSUS_ABSENT_CAUSES, SEAT_SUITE_POLICY_EVENT, SUITE_RUN_REFUSAL, SUITE_RUN_UNRECOGNISED, WAIT_POLL_MS, claudeCensus } from './headless.mjs'
import { scratchDir } from '../test/helpers.mjs'

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
  const role = options.role || 'builder'
  const dir = options.dir || mkdtempSync(join(tmpdir(), 'headless-rpc-'))
  const paths = { dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const writes = []; const commands = []; const specs = []; const signals = []; let sleepCount = 0
  const kill = (pid, signal) => {
    signals.push([pid, signal])
    if (options.kill) return options.kill(pid, signal)
    if (signal !== 0) writeFileSync(join(paths.taskDir, 'headless-rpc', role, 'exit'), '0')
  }
  const appendStream = (text) => (options.writeFileSync || writeFileSync)(join(paths.taskDir, 'headless-rpc', role, 'stream.jsonl'), text, { flag: 'a' })
  const sleep = (ms) => {
    sleepCount += 1
    options.sleep?.(ms)
    options.onSleep?.({ ms, sleepCount, appendStream })
  }
  const deps = {
    pid: options.pid ?? 700, uuid: options.uuid || (() => 'session-1'),
    spawn: options.spawn || (() => { commands.push({ kind: 'spawn' }); return { pid: Object.hasOwn(options, 'spawnPid') ? options.spawnPid : 701, unref() {} } }), openSync: options.openSync || (() => 10),
    writeSync: options.writeSync || ((_fd, line) => { writes.push(JSON.parse(line)); return undefined }), closeSync: () => {}, kill,
    existsSync: options.existsSync || ((path) => existsSync(path) || String(path).endsWith('/cmd.fifo')),
    readdirSync: options.readdirSync || readdirSync,
    writeFileSync: options.writeFileSync || writeFileSync, readFileSync: options.readFileSync || readFileSync, mkdirSync, log: options.log || (() => {}), sleep,
    ...(options.now ? { now: options.now } : {}),
    ...(Object.hasOwn(options, 'promptDeliveryWindowMs') ? { promptDeliveryWindowMs: options.promptDeliveryWindowMs } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
    ...(options.telemetry ? { censusReducer: options.telemetry } : {}),
    ...(options.preFirstTurnFinalizer ? { preFirstTurnFinalizer: options.preFirstTurnFinalizer } : {}),
  }
  const crew = options.crew || { checkout: dir, members: { [role]: { model: 'model', transport: 'headless-rpc' } } }
  const adapter = { rpcCommand: (spec) => { specs.push(spec); return rpcCommand(spec) } }
  const adapterEntry = options.adapterEntry || (options.grants ? { adapter, grants: options.grants } : adapter)
  const io = headlessRpcIo({ crew, paths, taskDir: paths.taskDir, checkout: dir, adapters: { [role]: adapterEntry }, bin: '/bin/pi', turnCeilings: options.turnCeilings, deps })
  return {
    dir, paths, crew, io, writes, commands, specs, signals, role, sleepCount: () => sleepCount,
    writeStream: (text) => writeFileSync(join(paths.taskDir, 'headless-rpc', role, 'stream.jsonl'), text),
    cleanup: () => { if (!options.dir) rmSync(dir, { recursive: true, force: true }) },
  }
}

function settle(f, run, frames = [{ type: 'agent_settled' }]) {
  writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`)
  writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
}

function recordedRpcBoundaryCapture() {
  return readFileSync(new URL('../tasks/headless-worker/captures/pi-a1-json-baseline.jsonl', import.meta.url), 'utf8')
}

// Recorded at ~/.crew/dt-b535-workingset/b535-workingset/task/headless-rpc/builder/stream.jsonl line 4596, b535 builder stream, observed at 2c3a8ff.
// Line 4597's 6,608-byte `compaction_end` was omitted because its result summary is unrelated and no counted field was touched.
function recordedB535CompactionFrames() {
  return '{"type":"compaction_start","reason":"threshold"}\n'
}

function splitRecordedRpcCapture() {
  const capture = recordedRpcBoundaryCapture()
  const lines = capture.split('\n')
  const firstTurnEnd = lines.findIndex((line) => {
    try { return JSON.parse(line)?.type === 'turn_end' } catch { return false }
  })
  assert.ok(firstTurnEnd >= 0)
  const prefix = `${lines.slice(0, firstTurnEnd + 1).join('\n')}\n`
  const suffix = lines.slice(firstTurnEnd + 1).join('\n')
  assert.equal(prefix + suffix, capture)
  assert.equal(rpcCensus(prefix)[0]?.turns, 1)
  assert.equal(rpcCensus(capture)[0]?.turns, 2)
  return { capture, prefix, suffix }
}

function ordinaryRpcEnvelope(id, role = 'builder') {
  return { assignment_id: id, role, status: 'done', summary: 'recorded ordinary completion', artifacts: [], details: {} }
}

function assertUnsettledPriorFrameFailsDelivery(frame) {
  let clock = 0
  const rows = []
  const f = fixture({
    promptDeliveryWindowMs: 100,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: (_pid, signal) => { if (signal === 0) return },
    log: (row) => rows.push(row),
  })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seatDir = join(f.paths.taskDir, 'headless-rpc', 'builder')
    const stream = join(seatDir, 'stream.jsonl')
    writeFileSync(join(seatDir, 'pgid'), '701')
    writeFileSync(stream, JSON.stringify({ type: 'turn_start' }) + '\n')
    assert.throws(() => f.io.wait(first.returnPath, 0), (error) => error.stage === 'rpc-timeout')
    const second = f.io.assign({ role: 'builder', briefFile: '/brief-next.md' })
    const sentAt = clock
    assert.equal(second.id, 'd2')
    assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, 1)
    writeFileSync(stream, JSON.stringify(frame) + '\n', { flag: 'a' })
    assert.throws(() => f.io.wait(second.returnPath, 600), (error) => error.stage === 'rpc-prompt-undelivered')
    assert.equal(clock - sentAt, 100)
    assert.equal(JSON.parse(readFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'session.json'))).lastAssignmentId, first.id)
    assert.deepEqual(rows.find((row) => row.rpc_settle_gate)?.rpc_settle_gate, { role: 'builder', id: first.id, settled: false, polls: SETTLE_GATE_POLLS })
  } finally { f.cleanup() }
}

function corpusFixture() {
  const lanes = ['/corpus/ordinary', '/corpus/denied', '/corpus/absent']
  const row = (value) => JSON.stringify(value)
  const lane1 = [
    { at: 100, assign: 'd1', role: 'builder', channel: 'record' },
    { at: 101, event: 'assignment-delivery', assignment_id: 'd1', role: 'builder', transport: 'headless-rpc' },
    { at: 190, rpc_settle_gate: { role: 'builder', id: 'd1', settled: true, polls: 0 } },
    { at: 200, assign: 'd2', role: 'builder', channel: 'record' },
    { at: 201, event: 'assignment-delivery', assignment_id: 'd2', role: 'builder', transport: 'headless-rpc' },
    { at: 290, rpc_settle_gate: { role: 'builder', id: 'd2', settled: true, polls: 0 } },
    { at: 300, assign: 'd3', role: 'builder', channel: 'record' },
    { at: 301, event: 'assignment-delivery', assignment_id: 'd3', role: 'builder', transport: 'headless-rpc' },
    { at: 400, assign: 'd4', role: 'reviewer', channel: 'record' },
    { at: 401, event: 'assignment-delivery', assignment_id: 'd4', role: 'reviewer', transport: 'headless-rpc' },
    { at: 402, assign: 'operational-not-record', role: 'reviewer', channel: 'operational' },
  ]
  const journals = new Map([
    [lanes[0], `${lane1.map(row).join('\n')}\nmalformed {\n`],
  ])
  const stats = new Map([
    [join(lanes[0], 'task/headless-rpc/builder/cmd.json'), { mtimeMs: 110 }],
    [join(lanes[0], 'task/headless-rpc/reviewer/cmd.json'), { mtimeMs: 450 }],
  ])
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  const absent = Object.assign(new Error('missing journal'), { code: 'ENOENT' })
  return {
    lanes,
    deps: {
      readFileSync(path) {
        if (path === lanes[1] + '/journal.jsonl') throw denied
        if (path === lanes[2] + '/journal.jsonl') throw absent
        const lane = path.endsWith('/journal.jsonl') ? path.slice(0, -'/journal.jsonl'.length) : path
        if (!journals.has(lane)) throw absent
        return journals.get(lane)
      },
      statSync(path) {
        if (!stats.has(path)) throw Object.assign(new Error('missing cmd'), { code: 'ENOENT' })
        return stats.get(path)
      },
    },
  }
}

test('A1 corpus sweep reports candidates over total assignments', () => {
  const fixtureData = corpusFixture()
  const report = rpcDeliveryCorpusReport(fixtureData.lanes, fixtureData.deps)
  assert.equal(report.total_assignments, 4)
  assert.equal(report.rpc_assignments, 4)
  assert.equal(report.cmd_mtime_predates_assignment.assignments, 2)
  assert.equal(report.older_settle_gate_candidates.distinct_assignments, 2)
  assert.equal(report.either_candidate.distinct_assignments, 2)
  assert.equal(report.either_candidate.assignment_denominator, 4)
})

test('A2 corpus sweep reports candidates over total lanes and unreadable names', () => {
  const fixtureData = corpusFixture()
  const report = rpcDeliveryCorpusReport(fixtureData.lanes, fixtureData.deps)
  assert.equal(report.total_lanes, 3)
  assert.equal(report.either_candidate.lane_denominator, 3)
  assert.equal(report.either_candidate.lanes, 1)
  assert.deepEqual(report.unreadable.map((entry) => entry.lane), [fixtureData.lanes[1], fixtureData.lanes[2]])
})

test('B1 corpus sweep keeps unreadable lanes null with a closed reason', () => {
  const fixtureData = corpusFixture()
  const report = rpcDeliveryCorpusReport([fixtureData.lanes[1]], fixtureData.deps)
  assert.equal(report.total_lanes, 1)
  assert.equal(report.total_assignments, 0)
  assert.deepEqual(report.unreadable, [{ lane: fixtureData.lanes[1], candidates: null, reason: closedReason(Object.assign(new Error('permission denied'), { code: 'EACCES' })) }])
  assert.equal(report.either_candidate.distinct_assignments, 0)
})

const PRE_FIRST_TIMING_FIELDS = [
  'pre_first_turn_span_ms', 'seat_boot_ms', 'seat_boot_absent_reason',
  'prompt_delivery_ms', 'prompt_delivery_absent_reason', 'brief_read_turns',
  'brief_read_turns_absent_reason', 'brief_read_ms', 'brief_read_absent_reason',
  'envelope_poll_ms', 'envelope_poll_absent_reason', 'pre_first_turn_known_sum_ms',
  'pre_first_turn_residual_ms', 'pre_first_turn_tolerance_ms', 'pre_first_turn_reconciled',
]

function withoutPreFirstTiming(row) {
  const copy = { ...row }
  for (const key of PRE_FIRST_TIMING_FIELDS) delete copy[key]
  return copy
}

function lossyRpcTelemetry(census, frame, at) {
  if (frame?.type === 'turn_end') return census
  return foldCensusFrame(census, frame, at)
}

test('A1 recorded RPC compaction_start counts one and repeated recorded form counts two', () => {
  const recorded = recordedB535CompactionFrames()
  assert.equal(rpcCensus(recorded)[0]?.compactions, 1)
  const twoStarts = recordedRpcBoundaryCapture().replace(
    '{"type":"agent_settled"}\n',
    recorded +
      // the second occurrence is the recorded frame form repeated to pin counting, not a second observed event
      recorded +
      '{"type":"agent_settled"}\n',
  )
  const rows = []
  const f = fixture({ dir: scratchDir('rpc-compaction-a1-'), log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    f.writeStream(twoStarts)
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
    assert.equal(f.io.wait(run.returnPath, 60).status, 'done')
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.compactions, 2)
    assert.equal(census.compaction_frame, 'compaction_start')
  } finally { f.cleanup() }
})

test('B1 RPC distinguishes measured zero compactions from a stream with no frames', () => {
  const framedRows = []
  const framed = fixture({ dir: scratchDir('rpc-compaction-b1-framed-'), log: (row) => framedRows.push(row) })
  try {
    const run = framed.io.assign({ role: 'builder', briefFile: '/brief.md' })
    b416RpcStream(framed, 'builder', b416RpcFrames('echo no-compaction-start'))
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
    assert.equal(framed.io.wait(run.returnPath, 60).status, 'done')
    const census = framedRows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.compactions, 0)
    assert.equal(census.compaction_frame, 'compaction_start')
    assert.equal(census.compactions_absent_reason, null)
  } finally { framed.cleanup() }

  const emptyRows = []
  const empty = fixture({ dir: scratchDir('rpc-compaction-b1-empty-'), log: (row) => emptyRows.push(row) })
  try {
    const run = empty.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(empty.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), '')
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
    assert.equal(empty.io.wait(run.returnPath, 60).status, 'done')
    const census = emptyRows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.compactions, null)
    assert.equal(census.compaction_frame, 'compaction_start')
    assert.equal(census.compactions_absent_reason, CENSUS_ABSENT_CAUSES.no_frames)
    assert.notEqual(census.compactions, 0)
  } finally { empty.cleanup() }
})

test('C1 RPC unreadable stream leaves compactions null with stream absence', () => {
  const rows = []
  const f = fixture({
    dir: scratchDir('rpc-compaction-c1-'),
    readFileSync: (path, ...args) => {
      if (String(path).endsWith('/stream.jsonl')) throw Object.assign(new Error('stream denied'), { code: 'EPERM' })
      return readFileSync(path, ...args)
    },
    log: (row) => rows.push(row),
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), '')
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
    assert.equal(f.io.wait(run.returnPath, 60).status, 'done')
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.compactions, null)
    assert.equal(census.compaction_frame, 'compaction_start')
    assert.equal(census.compactions_absent_reason, CENSUS_ABSENT_CAUSES.stream_absent)
  } finally { f.cleanup() }
})

test('E1 RPC half compaction fields leave prior census fields byte-identical', () => {
  const rows = []
  const f = fixture({ dir: scratchDir('rpc-compaction-e1-'), now: () => 0, log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    b416RpcStream(f, 'builder', b416RpcFrames('echo e1'))
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
    assert.equal(f.io.wait(run.returnPath, 60).status, 'done')
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    for (const key of ['compactions', 'compaction_frame', 'compactions_absent_reason']) delete census[key]
    for (const key of PRE_FIRST_TIMING_FIELDS) delete census[key]
    assert.equal(JSON.stringify(census), JSON.stringify({
      role: 'builder',
      dispatch_id: 'd1',
      transport: 'headless-rpc',
      turns: 1,
      tool_calls: 1,
      distinct_files_read: 0,
      suite_runs: 0,
      re_reads: 0,
      by_class: { edit: 0, read: 0, test: 0, other: 1 },
      in_tool_ms: null,
      out_of_tool_ms: null,
      span_ms: 0,
      tool_spans_matched: 0,
      tool_spans_unmatched: 0,
      tool_spans_same_poll: 1,
      bash_reads_absent_reason: null,
      parked_frames: 0,
      parked_frames_reason: null,
      absent_reason: CENSUS_ABSENT_CAUSES.same_poll_boundary,
    }))
  } finally { f.cleanup() }
})

test('B2 RPC emits exactly one turn-ceiling outcome at its recorded boundary', () => {
  const { prefix, suffix } = splitRecordedRpcCapture()
  let clock = 0
  let appended = false
  const rows = []
  const f = fixture({
    turnCeilings: { builder: 1 }, now: () => clock, sleep: (ms) => { clock += ms },
    onSleep: ({ appendStream, sleepCount, ms }) => {
      if (sleepCount !== 1) return
      assert.equal(ms, WAIT_POLL_MS)
      appendStream(suffix)
      appended = true
    },
    kill: (_pid, signal) => {
      if (signal === 0) { const err = new Error('gone'); err.code = 'ESRCH'; throw err }
      writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'exit'), '143')
    },
    log: (row) => rows.push(row),
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), prefix)
    const envelope = f.io.wait(run.returnPath, 600)
    assert.equal(envelope.status, 'insufficient')
    assert.equal(envelope.details.turn_ceiling.turns, 2)
    assert.equal(appended, true)
    assert.equal(clock, WAIT_POLL_MS)
    assert.ok(clock < 600_000)
    assert.equal(f.writes.some((frame) => frame.type === 'abort'), true)
    assert.equal(rows.filter((row) => row.headless_outcome === 'turn-ceiling').length, 1)
    const outcome = rows.findIndex((row) => row.headless_outcome === 'turn-ceiling')
    const census = rows.findIndex((row) => row.seat_turn_census)
    assert.ok(outcome >= 0 && census > outcome)
  } finally { f.cleanup() }
})

test('C2 RPC recorded boundary and census disagreement is decided by the boundary', () => {
  const capture = recordedRpcBoundaryCapture()
  const rows = []
  const f = fixture({
    turnCeilings: { builder: 1 }, telemetry: lossyRpcTelemetry,
    log: (row) => rows.push(row),
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), capture)
    const ordinary = ordinaryRpcEnvelope(run.id)
    const ordinaryBytes = JSON.stringify(ordinary)
    writeFileSync(run.returnPath, ordinaryBytes)
    const envelope = f.io.wait(run.returnPath, 600)
    assert.equal(envelope.status, 'insufficient')
    assert.equal(envelope.details.turn_ceiling.turns, 2)
    assert.notEqual(JSON.stringify(envelope), ordinaryBytes)
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census?.turns, 0)
    assert.equal(rows.filter((row) => row.headless_outcome === 'turn-ceiling').length, 1)
    assert.equal(rows.filter((row) => row.seat_turn_census).length, 1)
  } finally { f.cleanup() }
})

test('D1 RPC at and under ceiling is byte-identical', () => {
  const capture = recordedRpcBoundaryCapture()
  assert.equal(rpcCensus(capture)[0]?.turns, 2)
  for (const budget of [2, 3]) {
    let baselineClock = 0
    let cappedClock = 0
    const baselineRows = []
    const cappedRows = []
    const baseline = fixture({ now: () => baselineClock, sleep: (ms) => { baselineClock += ms }, log: (row) => baselineRows.push(row) })
    const capped = fixture({ turnCeilings: { builder: budget }, now: () => cappedClock, sleep: (ms) => { cappedClock += ms }, log: (row) => cappedRows.push(row) })
    try {
      const baselineRun = baseline.io.assign({ role: 'builder', briefFile: '/brief.md' })
      const cappedRun = capped.io.assign({ role: 'builder', briefFile: '/brief.md' })
      baseline.writeStream(capture); capped.writeStream(capture)
      const baselineEnvelope = ordinaryRpcEnvelope(baselineRun.id)
      const cappedEnvelope = ordinaryRpcEnvelope(cappedRun.id)
      writeFileSync(baselineRun.returnPath, JSON.stringify(baselineEnvelope))
      writeFileSync(cappedRun.returnPath, JSON.stringify(cappedEnvelope))
      const baselineResult = baseline.io.wait(baselineRun.returnPath, 600)
      const cappedResult = capped.io.wait(cappedRun.returnPath, 600)
      assert.equal(JSON.stringify(cappedResult), JSON.stringify(baselineResult))
      const baselineOutcome = baselineRows.find((row) => row.rpc_outcome)?.rpc_outcome
      const cappedOutcome = cappedRows.find((row) => row.rpc_outcome)?.rpc_outcome
      assert.equal(cappedOutcome, baselineOutcome)
      assert.equal(capped.signals.length, 0)
      assert.equal(capped.writes.some((frame) => frame.type === 'abort'), false)
      assert.equal(cappedRows.some((row) => row.headless_outcome === 'turn-ceiling'), false)
      assert.equal(cappedRows.some((row) => row.seat_turn_ceiling), false)
    } finally { baseline.cleanup(); capped.cleanup() }
  }
})

test('E1 RPC without a configured ceiling is never pre-empted', () => {
  let clock = 0
  const rows = []
  const f = fixture({ now: () => clock, sleep: (ms) => { clock += ms }, log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const ordinary = ordinaryRpcEnvelope(run.id)
    const ordinaryBytes = JSON.stringify(ordinary)
    f.writeStream(recordedRpcBoundaryCapture())
    writeFileSync(run.returnPath, ordinaryBytes)
    const envelope = f.io.wait(run.returnPath, 600)
    assert.equal(JSON.stringify(envelope), ordinaryBytes)
    assert.equal(envelope.details.turn_ceiling, undefined)
    assert.equal(f.signals.length, 0)
    assert.equal(f.writes.some((frame) => frame.type === 'abort'), false)
    assert.equal(rows.some((row) => row.headless_outcome === 'turn-ceiling'), false)
    assert.equal(rows.some((row) => row.seat_turn_ceiling), false)
    assert.equal(rows.find((row) => row.rpc_outcome)?.rpc_outcome, 'ok')
  } finally { f.cleanup() }
})

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

// RV1-1 (found at review, closed by hand at closeout). Deriving the allowlist
// from the extension table dropped the old `fanout` branch, which keyed off
// grants.agents. A role granting agents WITHOUT the extension that registers the
// agent tool then booted with CREW_PI_AGENTS populated and no `agent` in --tools:
// fan-out silently dead, no refusal. MUTATION: delete the agents.length guard in
// piActivatedTools and both halves of this test go red.
test('RV1-1 an agents grant with no extension registering the agent tool refuses on both transports', () => {
  const unbacked = { tools: [], extensions: ['/repo/crew/pi/extensions/builderloop.ts'], agents: [{ name: 'scout', def: '/scout.json' }], skills: [] }
  const common = { bin: '/bin/pi', model: 'openai-codex/x', sessionDir: '/tmp/s', sessionId: 's1', promptFile: '/tmp/p', deny: '' }
  assert.throws(
    () => rpcCommand({ ...common, grants: unbacked }),
    (error) => error.reason === 'grant-unsupported' && error.diagnosis === 'agent-grant-unbacked' && error.message.includes('subagent.ts'),
  )
  assert.throws(
    () => piSeatCommand({
      role: 'planner', model: 'openai-codex/x', promptFile: '/tmp/p', tools: '', deny: '',
      taskDir: '/tmp/task', bootBrief: 'boot', grants: unbacked,
    }),
    (error) => error.reason === 'grant-unsupported' && error.diagnosis === 'agent-grant-unbacked',
  )
  // The same grant WITH the registering extension composes and activates the tool.
  const backed = { ...unbacked, extensions: [...unbacked.extensions, '/repo/crew/pi/extensions/subagent.ts'] }
  const ok = rpcCommand({ ...common, grants: backed })
  assert.equal(ok.args[ok.args.indexOf('--tools') + 1].split(',').includes('agent'), true)
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
    vendor_extensions: [{ package: '@crew-fixture/rpc', tools: [], entries: ['/ext-a', '/ext-b'] }],
    agents: [], skills: [],
  }
  const granted = rpcCommand({ ...common, grants })
  assert.deepEqual(granted.args, [
    '--mode', 'rpc', '--model', 'openai-codex/x', '--thinking', 'high', '--session-dir', '/tmp/s', '--session', 's1',
    '--append-system-prompt', '/tmp/p', '--tools', 'read,bash,edit,write,grep,find,ls,Task', '--exclude-tools', 'edit',
    '--no-context-files', '--no-extensions', '-e', '/ext-a', '-e', '/ext-b', '--no-skills',
  ])
  assert.equal(granted.env.X, '1')
  assert.equal(Object.hasOwn(granted.env, 'CREW_PI_AGENTS'), false)

  const subagentGrants = {
    tools: ['Task', 'Task'], extensions: ['/repo/crew/pi/extensions/subagent.ts'],
    agents: [{ name: 'scout', def: '/scout.json' }], skills: [],
  }
  const subagent = rpcCommand({ ...common, grants: subagentGrants })
  assert.deepEqual(subagent.args, [
    '--mode', 'rpc', '--model', 'openai-codex/x', '--thinking', 'high', '--session-dir', '/tmp/s', '--session', 's1',
    '--append-system-prompt', '/tmp/p', '--tools', 'read,bash,edit,write,grep,find,ls,Task,agent', '--exclude-tools', 'edit',
    '--no-context-files', '--no-extensions', '-e', '/repo/crew/pi/extensions/subagent.ts', '--no-skills',
  ])
  assert.deepEqual(JSON.parse(subagent.env.CREW_PI_AGENTS), [{ name: 'scout', def: '/scout.json' }])

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
    // no agents granted, so no agent tool — this pins absence for an UNGRANTED seat,
    // not the silent drop an unbacked grant used to produce (see the RV1-1 test below).
    assert.equal(wrappedCommand.args[wrappedCommand.args.indexOf('--tools') + 1].split(',').includes('agent'), false)
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

test('shared RPC activation adds shipped tools, preserves vendor tools, and refuses unknown extensions', () => {
  const base = {
    model: 'openai-codex/x', sessionDir: '/tmp/s', sessionId: 's', promptFile: '/tmp/p', deny: '',
  }
  const skeleton = rpcCommand({
    ...base,
    grants: { tools: [], extensions: ['/repo/crew/pi/extensions/skeletonread.ts'], agents: [], skills: [] },
  })
  assert.equal(skeleton.args[skeleton.args.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls,retrieve')

  const planner = rpcCommand({
    ...base,
    grants: {
      tools: ['Task'], extensions: ['/repo/crew/pi/extensions/subagent.ts', '/repo/crew/pi/extensions/lab.ts', '/repo/crew/pi/extensions/readgate.ts'],
      agents: [{ name: 'scout', def: '/scout.json' }], skills: [],
    },
  })
  assert.equal(planner.args[planner.args.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls,Task,agent,lab')

  const extension = '/vendor/pkg/index.ts'
  const vendor = rpcCommand({
    ...base,
    grants: {
      tools: ['vendor-tool'], extensions: [extension], agents: [], skills: [],
      vendor_extensions: [{ package: 'vendor', tools: ['vendor-tool'], entries: [extension] }],
    },
  })
  assert.equal(vendor.args[vendor.args.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls,vendor-tool')
  assert.throws(
    () => rpcCommand({ ...base, grants: { tools: [], extensions: ['/repo/crew/pi/extensions/unknown-registering-extension.ts'], agents: [], skills: [] } }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes('unknown-registering-extension'),
  )
})

test('A3 headless rpc assignment carries the brief body inline', () => {
  const f = fixture()
  const briefText = '# RPC inline brief\nKeep this exact body: café 🚀.\n'
  const briefFile = join(f.paths.taskDir, 'brief.md')
  writeFileSync(briefFile, briefText)
  try {
    const run = f.io.assign({ role: 'builder', briefFile })
    const prompt = f.writes.find((frame) => frame.type === 'prompt')?.message
    assert.ok(prompt.includes(briefText))
    assert.doesNotMatch(prompt, /read your brief at/)
    assert.equal(run.id, 'd1')
  } finally { f.cleanup() }
})

test('B3 headless rpc journals the measured delivery mode per assignment', () => {
  const logs = []
  const f = fixture({ log: (row) => logs.push(row) })
  const briefText = 'measured rpc brief — café 🚀\n'
  const briefFile = join(f.paths.taskDir, 'brief.md')
  writeFileSync(briefFile, briefText)
  try {
    const run = f.io.assign({ role: 'builder', briefFile })
    const rows = logs.filter((row) => row.event === 'assignment-delivery')
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], {
      at: rows[0].at,
      event: 'assignment-delivery',
      role: 'builder',
      assignment_id: run.id,
      transport: 'headless-rpc',
      mode: 'inline',
      brief_bytes: Buffer.byteLength(briefText, 'utf8'),
      brief_size_measured: true,
      brief_size_unmeasured_reason: null,
    })

    const failedLogs = []
    const failed = fixture({
      log: (row) => failedLogs.push(row),
      writeSync: () => { throw new Error('EPIPE') },
    })
    try {
      assert.throws(() => failed.io.assign({ role: 'builder', briefFile: '/brief.md' }), /EPIPE/)
      assert.equal(failedLogs.filter((row) => row.event === 'assignment-delivery').length, 0)
    } finally { failed.cleanup() }
  } finally { f.cleanup() }
})

test('C3 headless rpc records an unreadable brief as unmeasured path delivery', () => {
  const logs = []
  const f = fixture({ log: (row) => logs.push(row) })
  const briefFile = join(f.paths.taskDir, 'missing-brief.md')
  try {
    const run = f.io.assign({ role: 'builder', briefFile })
    const prompt = f.writes.find((frame) => frame.type === 'prompt')?.message
    assert.equal(prompt, assignmentLine({ id: run.id, role: 'builder', briefFile, returnPath: run.returnPath, taskDir: f.paths.taskDir }))
    const rows = logs.filter((row) => row.event === 'assignment-delivery')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].mode, 'path')
    assert.equal(rows[0].brief_bytes, null)
    assert.equal(rows[0].brief_size_measured, false)
    assert.equal(rows[0].brief_size_unmeasured_reason, 'brief-unreadable')
  } finally { f.cleanup() }
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

test('an rpc timeout reuses an alive seat but replaces a killed seat with no exit marker', () => {
  for (const { killGroup } of [{ killGroup: false }, { killGroup: true }]) {
    let clock = 0
    let groupAlive = true
    const f = fixture({
      now: () => clock,
      sleep: (ms) => { clock += ms },
      kill: (_pid, signal) => {
        if (signal === 0) {
          if (!groupAlive) {
            const error = new Error('group is gone')
            error.code = 'ESRCH'
            throw error
          }
          return
        }
        if (killGroup) groupAlive = false
      },
    })
    try {
      const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
      writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'pgid'), '701')
      assert.throws(() => f.io.wait(first.returnPath, 0), (err) => err.stage === 'rpc-timeout')
      const exitPath = join(f.paths.taskDir, 'headless-rpc', 'builder', 'exit')
      assert.equal(existsSync(exitPath), false)
      const retryPath = join(f.paths.returnsDir, `${first.id}.retry.builder.json`)
      const retry = f.io.assign({ role: 'builder', briefFile: '/retry.md', reask: { id: first.id, returnPath: retryPath } })
      assert.deepEqual(retry, { id: first.id, returnPath: retryPath })
      assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, killGroup ? 2 : 1)
      if (killGroup) {
        assert.equal(f.specs.at(-1).resume, true)
        assert.equal(f.specs.at(-1).sessionId, 'session-1')
      }
    } finally { f.cleanup() }
  }
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
    promptDeliveryWindowMs: 100,
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
    assert.throws(() => f.io.wait(run.returnPath, 30), (err) => err.stage === 'rpc-prompt-undelivered')
    assert.equal(clock, 100)
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
    assert.equal(saved.lastAssignmentId, 'd1')
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

test('b401 rpcCensus replays the recorded b376 builder stream to four dispatches and 230 turns', (t) => {
  const path = '/Users/momoshell/.crew/dt-b376-loopgates/b376-loopgates/task/headless-rpc/builder/stream.jsonl'
  if (!existsSync(path)) return t.skip('the recorded b376 capture is not on this host')
  const per = rpcCensus(readFileSync(path, 'utf8'))
  assert.equal(per.length, 4)
  assert.equal(per.reduce((total, census) => total + census.turns, 0), 230)
  assert.equal(per.reduce((total, census) => total + census.tool_calls, 0), 286)
  assert.equal(per.reduce((total, census) => total + census.suite_runs, 0), 47)
})

test('b401 rpcCensus replays the recorded b394 builder stream to edit 33 read 102 test 24', (t) => {
  const path = '/Users/momoshell/.crew/dt-b394-briefpack/b394-briefpack.archive-2026-09-03T10-26-17-352Z/task/headless-rpc/builder/stream.jsonl'
  if (!existsSync(path)) return t.skip('the recorded b394 capture is not on this host')
  const per = rpcCensus(readFileSync(path, 'utf8'))
  assert.deepEqual(per[0].by_class, { edit: 33, read: 102, test: 24, other: 54 })
})

test('b401 the live rpc census stamps the tool boundary from the wrapper clock', () => {
  const census = newCensus()
  foldCensusFrame(census, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.mjs' } }, 1000)
  foldCensusFrame(census, { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read' }, 1045)
  foldCensusFrame(census, { type: 'tool_execution_end', toolCallId: 'missing', toolName: 'read' }, 1100)
  const result = finaliseCensus(census)
  assert.equal(result.in_tool_ms.read, 45)
  assert.equal(result.tool_spans_matched, 1)
  assert.equal(result.tool_spans_unmatched, 1)
  assert.equal(result.in_tool_ms.edit, 0)
  assert.equal(result.distinct_files_read, 1)
})

test('RV1-1 RPC census counts distinct paths and re-reads', () => {
  const census = newCensus()
  const read = (id, path, at) => {
    foldCensusFrame(census, { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path } }, at)
    foldCensusFrame(census, { type: 'tool_execution_end', toolCallId: id, toolName: 'read' }, at + 1)
  }
  read('first', 'a.mjs', 1000)
  read('second', 'b.mjs', 1010)
  read('again', 'a.mjs', 1020)
  const result = finaliseCensus(census)
  assert.equal(result.distinct_files_read, 2)
  assert.equal(result.re_reads, 1)
})

test('G1 RPC census measures Bash readers, preserves structured counts, and journals the absence field', () => {
  const calls = [
    { name: 'bash', input: { command: 'cat rpc.md' }, id: 'g1' },
    { name: 'bash', input: { command: 'cat rpc.md' }, id: 'g2' },
    { name: 'bash', input: { command: 'cat "$FILE"' }, id: 'g3' },
    { name: 'read', input: { path: 'rpc.md' }, id: 'g4' },
  ]
  const rpc = newCensus()
  calls.forEach((call, index) => {
    foldCensusFrame(rpc, { type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.input }, 1000 + index * 10)
    foldCensusFrame(rpc, { type: 'tool_execution_end', toolCallId: call.id, toolName: call.name }, 1001 + index * 10)
  })
  const result = finaliseCensus(rpc)
  const json = claudeCensus(JSON.stringify({ type: 'assistant', message: { content: calls.map(({ name, input, id }) => ({ type: 'tool_use', name, input, id })) } }))
  for (const census of [result, json]) {
    assert.equal(census.distinct_files_read, 1)
    assert.equal(census.re_reads, 2)
    assert.equal(census.bash_reads_absent_reason, CENSUS_ABSENT_CAUSES.bash_reader_unparsed)
  }

  const rows = []
  const f = fixture({ log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    b416RpcStream(f, 'builder', [
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'journal-bash', toolName: 'bash', args: { command: 'cat "$FILE"' } },
      { type: 'tool_execution_end', toolCallId: 'journal-bash', toolName: 'bash' },
      { type: 'tool_execution_start', toolCallId: 'journal-read', toolName: 'read', args: { path: 'kept.md' } },
      { type: 'tool_execution_end', toolCallId: 'journal-read', toolName: 'read' },
      { type: 'turn_end' },
      { type: 'agent_settled' },
    ])
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'builder', status: 'done' }))
    assert.equal(f.io.wait(run.returnPath, 60).status, 'done')
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.distinct_files_read, 1)
    assert.equal(census.re_reads, 0)
    assert.equal(census.bash_reads_absent_reason, CENSUS_ABSENT_CAUSES.bash_reader_unparsed)
  } finally { f.cleanup() }
})

test('b401 a tool call observed in one poll reports an absent duration and never zero', () => {
  const start = (id) => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'node --test crew/headless.test.mjs' } })
  const end = (id) => ({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash' })
  const one = newCensus()
  foldCensusFrame(one, start('t1'), 1000)
  foldCensusFrame(one, end('t1'), 1000)
  const only = finaliseCensus(one)
  assert.equal(only.tool_spans_same_poll, 1)
  assert.equal(only.tool_spans_matched, 0)
  assert.equal(only.in_tool_ms, null)
  assert.equal(only.clock_absent, CENSUS_ABSENT_CAUSES.same_poll_boundary)
  const mixed = newCensus()
  foldCensusFrame(mixed, start('t1'), 1000)
  foldCensusFrame(mixed, end('t1'), 1000)
  foldCensusFrame(mixed, start('t2'), 2000)
  foldCensusFrame(mixed, end('t2'), 2500)
  const both = finaliseCensus(mixed)
  assert.equal(both.in_tool_ms.test, 500)
  assert.equal(both.tool_spans_same_poll, 1)
  assert.equal(both.clock_absent, null)
})

test('b401 an absent rpc stream is stream_absent and an empty one is no_frames', () => {
  const dir = scratchDir('rpc-census-')
  try {
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '\n\n')
    const missing = rpcStreamCensus(join(dir, 'never-written.jsonl'), readFileSync, existsSync)
    const blank = rpcStreamCensus(empty, readFileSync, existsSync)
    assert.equal(missing.absent_reason, CENSUS_ABSENT_CAUSES.stream_absent)
    assert.equal(blank.absent_reason, CENSUS_ABSENT_CAUSES.no_frames)
    assert.notEqual(missing.absent_reason, blank.absent_reason)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function preFirstFrames(briefFile) {
  return [
    { type: 'turn_start' },
    { type: 'tool_execution_start', toolCallId: 'pre-brief', toolName: 'read', args: { path: briefFile } },
    { type: 'tool_execution_end', toolCallId: 'pre-brief', toolName: 'read' },
    { type: 'turn_end' },
    { type: 'turn_start' },
    { type: 'tool_execution_start', toolCallId: 'pre-work', toolName: 'bash', args: { command: 'echo work' } },
    { type: 'tool_execution_end', toolCallId: 'pre-work', toolName: 'bash' },
    { type: 'turn_end' },
    { type: 'agent_settled' },
  ]
}

function manualPreFirstTiming(overrides = {}) {
  return {
    timing: {
      assignment_started_at: 0,
      seat_reused: false,
      seat_boot_started_at: 0,
      seat_boot_ready_at: 10,
      prompt_delivery_started_at: 20,
      prompt_delivery_sent_at: 40,
      brief_file: '/scratch/brief.md',
      current_pre_boundary_turn: null,
      brief_read_turns: 1,
      brief_read_ms: 30,
      first_non_brief_tool_seen: true,
      first_non_brief_tool_at: 100,
      ...overrides,
    },
  }
}

const CLOSED_PRE_FIRST_REASONS = new Set(Object.values(PRE_FIRST_TURN_ABSENT_REASONS))

test('A1 pre-first-turn census carries named component schema', () => {
  let clock = 0
  const rows = []
  const f = fixture({ dir: scratchDir('rpc-pre-first-a1-'), now: () => clock, log: (row) => rows.push(row) })
  const briefFile = join(f.dir, 'brief.md')
  writeFileSync(briefFile, Buffer.alloc(50 * 1024 + 1, 'b'))
  try {
    const first = f.io.assign({ role: 'builder', briefFile })
    clock = 100
    b416RpcStream(f, 'builder', preFirstFrames(briefFile))
    writeFileSync(first.returnPath, JSON.stringify(ordinaryRpcEnvelope(first.id)))
    assert.equal(f.io.wait(first.returnPath, 1).status, 'done')

    clock = 200
    const second = f.io.assign({ role: 'builder', briefFile })
    clock = 300
    b502AppendRpcStream(f, 'builder', preFirstFrames(briefFile))
    writeFileSync(second.returnPath, JSON.stringify(ordinaryRpcEnvelope(second.id)))
    assert.equal(f.io.wait(second.returnPath, 1).status, 'done')

    const censuses = rows.filter((row) => row.seat_turn_census).map((row) => row.seat_turn_census)
    assert.equal(censuses.length, 2, 'A1 denominator n=2 rows')
    for (const census of censuses) {
      for (const key of PRE_FIRST_TIMING_FIELDS) assert.equal(Object.hasOwn(census, key), true, key)
      assert.equal(typeof census.pre_first_turn_span_ms, 'number')
      assert.equal(typeof census.brief_read_turns, 'number')
      assert.equal(census.brief_read_turns, 1)
      assert.equal(census.envelope_poll_ms, null)
      assert.equal(census.envelope_poll_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.envelope_write_time_unobservable)
    }
    assert.equal(censuses[0].seat_boot_ms, null)
    assert.equal(censuses[1].seat_boot_ms, null)
    assert.equal(censuses[1].seat_boot_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.seat_reused)
    assert.equal(isBriefReadToolCall(preFirstFrames(briefFile)[1], briefFile), true)
  } finally { f.cleanup() }
})

test('RV1-1 cold RPC assignment measures wired boot and prompt timing', () => {
  let clock = 0
  const rows = []
  const f = fixture({
    dir: scratchDir('rpc-pre-first-rv1-1-'),
    now: () => { clock += 10; return clock },
    log: (row) => rows.push(row),
  })
  const briefFile = join(f.dir, 'brief.md')
  writeFileSync(briefFile, 'review guard\n')
  try {
    const run = f.io.assign({ role: 'builder', briefFile })
    b416RpcStream(f, 'builder', preFirstFrames(briefFile))
    writeFileSync(run.returnPath, JSON.stringify(ordinaryRpcEnvelope(run.id)))
    assert.equal(f.io.wait(run.returnPath, 60).status, 'done')

    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(f.commands.filter((command) => command.kind === 'spawn').length, 1)
    assert.equal(typeof census.seat_boot_ms, 'number')
    assert.ok(census.seat_boot_ms > 0)
    assert.equal(census.seat_boot_absent_reason, null)
    assert.equal(typeof census.prompt_delivery_ms, 'number')
    assert.ok(census.prompt_delivery_ms > 0)
    assert.equal(census.prompt_delivery_absent_reason, null)
  } finally { f.cleanup() }
})

test('B1 unbounded timing is null with closed reason and never zero', () => {
  let clock = 0
  const rows = []
  const f = fixture({ dir: scratchDir('rpc-pre-first-b1-'), now: () => clock, log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    clock = 5
    b416RpcStream(f, 'builder', preFirstFrames('/brief.md'))
    writeFileSync(run.returnPath, JSON.stringify(ordinaryRpcEnvelope(run.id)))
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.brief_read_turns, 1)
    for (const key of ['pre_first_turn_span_ms', 'seat_boot_ms', 'prompt_delivery_ms', 'brief_read_ms', 'envelope_poll_ms']) {
      assert.notEqual(census[key], 0, `${key} must not report zero`)
    }
  } finally { f.cleanup() }

  const same = finalisePreFirstTurn(manualPreFirstTiming({
    seat_boot_ready_at: 0, prompt_delivery_sent_at: 20, brief_read_ms: 0, first_non_brief_tool_at: 0,
  }))
  assert.equal(same.pre_first_turn_span_ms, null)
  assert.equal(same.seat_boot_ms, null)
  assert.equal(same.seat_boot_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.clock_resolution)
  assert.equal(same.brief_read_turns, 1)
  assert.equal(same.brief_read_ms, null)
  assert.equal(same.brief_read_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.clock_resolution)
  for (const key of ['pre_first_turn_span_ms', 'seat_boot_ms', 'prompt_delivery_ms', 'brief_read_ms', 'envelope_poll_ms']) assert.notEqual(same[key], 0)
  assert.equal(CLOSED_PRE_FIRST_REASONS.has(same.brief_read_absent_reason), true)

  const inline = finalisePreFirstTurn(manualPreFirstTiming({
    first_non_brief_tool_at: 100, brief_read_turns: 0, brief_read_ms: null,
  }))
  assert.equal(inline.brief_read_turns, null)
  assert.equal(inline.brief_read_turns_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.no_brief_tool_turns)
  assert.equal(inline.brief_read_ms, null)
  assert.equal(inline.brief_read_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.no_brief_tool_turns)
  assert.equal(CLOSED_PRE_FIRST_REASONS.has(inline.brief_read_turns_absent_reason), true)

  const noBoundary = finalisePreFirstTurn(manualPreFirstTiming({
    first_non_brief_tool_seen: false, first_non_brief_tool_at: null, brief_read_turns: 0, brief_read_ms: null,
  }))
  assert.equal(noBoundary.pre_first_turn_span_ms, null)
  assert.equal(noBoundary.brief_read_turns, null)
  assert.equal(noBoundary.brief_read_turns_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.no_first_non_brief_tool)
  assert.equal(CLOSED_PRE_FIRST_REASONS.has(noBoundary.brief_read_turns_absent_reason), true)
})

test('C1sum known components reconcile within named tolerance', () => {
  const census = finalisePreFirstTurn(manualPreFirstTiming())
  const measured = [census.seat_boot_ms, census.prompt_delivery_ms, census.brief_read_ms].filter((value) => value !== null)
  const independentlyKnown = measured.reduce((sum, value) => sum + value, 0)
  assert.equal(independentlyKnown, 60)
  assert.equal(census.pre_first_turn_known_sum_ms, independentlyKnown)
  assert.equal(census.pre_first_turn_known_sum_ms + census.pre_first_turn_residual_ms, census.pre_first_turn_span_ms)
  assert.equal(census.pre_first_turn_tolerance_ms, PRE_FIRST_TURN_TOLERANCE_MS)
  assert.equal(census.pre_first_turn_reconciled, Math.abs(census.pre_first_turn_residual_ms) <= PRE_FIRST_TURN_TOLERANCE_MS)
})

test('C1res reconciliation mismatch remains a named residual', () => {
  const census = finalisePreFirstTurn(manualPreFirstTiming({
    prompt_delivery_sent_at: 30, brief_read_ms: null,
  }))
  assert.equal(census.brief_read_ms, null)
  assert.equal(census.brief_read_absent_reason, PRE_FIRST_TURN_ABSENT_REASONS.clock_resolution)
  assert.equal(census.pre_first_turn_known_sum_ms, 20)
  assert.equal(census.pre_first_turn_residual_ms, 80)
  assert.notEqual(census.pre_first_turn_residual_ms, 0)
  assert.equal(census.pre_first_turn_known_sum_ms + census.pre_first_turn_residual_ms, census.pre_first_turn_span_ms)
})

test('D1 prior census fields stay byte-identical', () => {
  const rows = []
  const f = fixture({ dir: scratchDir('rpc-pre-first-d1-'), now: () => 0, log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    b416RpcStream(f, 'builder', b416RpcFrames('echo d1'))
    writeFileSync(run.returnPath, JSON.stringify(ordinaryRpcEnvelope(run.id)))
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(JSON.stringify(withoutPreFirstTiming(census)), JSON.stringify({
      role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: 1,
      compactions: 0, compaction_frame: 'compaction_start', compactions_absent_reason: null,
      tool_calls: 1, distinct_files_read: 0, suite_runs: 0, re_reads: 0,
      by_class: { edit: 0, read: 0, test: 0, other: 1 }, in_tool_ms: null,
      out_of_tool_ms: null, span_ms: 0, tool_spans_matched: 0, tool_spans_unmatched: 0,
      tool_spans_same_poll: 1, bash_reads_absent_reason: null,
      parked_frames: 0, parked_frames_reason: null,
      absent_reason: CENSUS_ABSENT_CAUSES.same_poll_boundary,
    }))
  } finally { f.cleanup() }
})

test('E1 absent or unreadable streams keep absent row and null timings', () => {
  const assertAbsent = (f, run, reason, expectedAbsentReason = CENSUS_ABSENT_CAUSES.no_frames) => {
    writeFileSync(run.returnPath, JSON.stringify(ordinaryRpcEnvelope(run.id)))
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
    const census = f.rows?.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census?.absent_reason, expectedAbsentReason)
    for (const key of PRE_FIRST_TIMING_FIELDS) {
      if (key.endsWith('absent_reason')) continue
      assert.equal(census?.[key], null, key)
    }
    for (const key of ['seat_boot_absent_reason', 'prompt_delivery_absent_reason', 'brief_read_turns_absent_reason', 'brief_read_absent_reason', 'envelope_poll_absent_reason']) {
      assert.equal(census?.[key], reason, key)
    }
  }

  const missingRows = []
  const missing = fixture({ dir: scratchDir('rpc-pre-first-e1-missing-'), log: (row) => missingRows.push(row) })
  missing.rows = missingRows
  try {
    const run = missing.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assertAbsent(missing, run, PRE_FIRST_TURN_ABSENT_REASONS.stream_absent)
  } finally { missing.cleanup() }

  const emptyRows = []
  const empty = fixture({ dir: scratchDir('rpc-pre-first-e1-empty-'), log: (row) => emptyRows.push(row) })
  empty.rows = emptyRows
  try {
    const run = empty.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(empty.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), '')
    assertAbsent(empty, run, PRE_FIRST_TURN_ABSENT_REASONS.no_frames)
  } finally { empty.cleanup() }

  const unreadRows = []
  const unread = fixture({
    dir: scratchDir('rpc-pre-first-e1-unreadable-'),
    readFileSync: (path, ...args) => {
      if (String(path).endsWith('/stream.jsonl')) throw Object.assign(new Error('stream denied'), { code: 'EPERM' })
      return readFileSync(path, ...args)
    },
    log: (row) => unreadRows.push(row),
  })
  unread.rows = unreadRows
  try {
    const run = unread.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(unread.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), '\n')
    assertAbsent(unread, run, PRE_FIRST_TURN_ABSENT_REASONS.stream_absent)
  } finally { unread.cleanup() }
})

test('G1 timing computation failures are non-load-bearing and reasoned', () => {
  const rows = []
  const f = fixture({
    dir: scratchDir('rpc-pre-first-g1-'),
    preFirstTurnFinalizer: () => { throw new Error('timing reducer failed') },
    log: (row) => rows.push(row),
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    b416RpcStream(f, 'builder', b416RpcFrames('echo g1'))
    const ordinary = ordinaryRpcEnvelope(run.id)
    const ordinaryBytes = JSON.stringify(ordinary)
    writeFileSync(run.returnPath, ordinaryBytes)
    const envelope = f.io.wait(run.returnPath, 1)
    assert.equal(JSON.stringify(envelope), ordinaryBytes)
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.turns, 1)
    assert.equal(census.tool_calls, 1)
    for (const key of ['pre_first_turn_span_ms', 'seat_boot_ms', 'prompt_delivery_ms', 'brief_read_turns', 'brief_read_ms', 'envelope_poll_ms', 'pre_first_turn_known_sum_ms', 'pre_first_turn_residual_ms', 'pre_first_turn_tolerance_ms', 'pre_first_turn_reconciled']) assert.equal(census[key], null, key)
    for (const key of ['seat_boot_absent_reason', 'prompt_delivery_absent_reason', 'brief_read_turns_absent_reason', 'brief_read_absent_reason', 'envelope_poll_absent_reason']) assert.equal(census[key], PRE_FIRST_TURN_ABSENT_REASONS.computation_failed, key)
  } finally { f.cleanup() }
})

test('H1 reconciliation tolerance is exported and reported', () => {
  assert.equal(PRE_FIRST_TURN_TOLERANCE_MS, WAIT_POLL_MS)
  assert.equal(Object.isFrozen(PRE_FIRST_TURN_ABSENT_REASONS), true)
  const source = readFileSync(new URL('./headless-rpc.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('pre_first_turn_tolerance_ms: PRE_FIRST_TURN_TOLERANCE_MS,'))
  assert.ok(source.includes('Math.abs(residualMs) <= PRE_FIRST_TURN_TOLERANCE_MS'))

  const pure = finalisePreFirstTurn(manualPreFirstTiming())
  assert.equal(pure.pre_first_turn_tolerance_ms, PRE_FIRST_TURN_TOLERANCE_MS)
  assert.equal(pure.pre_first_turn_reconciled, Math.abs(pure.pre_first_turn_residual_ms) <= PRE_FIRST_TURN_TOLERANCE_MS)

  let clock = 0
  const rows = []
  const f = fixture({ dir: scratchDir('rpc-pre-first-h1-'), now: () => clock, log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    clock = 100
    b416RpcStream(f, 'builder', b416RpcFrames('echo h1'))
    writeFileSync(run.returnPath, JSON.stringify(ordinaryRpcEnvelope(run.id)))
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
    const row = rows.find((entry) => entry.seat_turn_census)?.seat_turn_census
    assert.equal(row.pre_first_turn_tolerance_ms, PRE_FIRST_TURN_TOLERANCE_MS)
    assert.equal(row.pre_first_turn_reconciled, Math.abs(row.pre_first_turn_residual_ms) <= row.pre_first_turn_tolerance_ms)
  } finally { f.cleanup() }
})

function b416RpcFrames(command, { settled = true } = {}) {
  return [
    { type: 'turn_start' },
    { type: 'tool_execution_start', toolCallId: 'b416-bash', toolName: 'bash', args: { command } },
    { type: 'tool_execution_end', toolCallId: 'b416-bash', toolName: 'bash' },
    { type: 'turn_end' },
    ...(settled ? [{ type: 'agent_settled' }] : []),
  ]
}

function b416RpcStream(f, role, frames) {
  writeFileSync(join(f.paths.taskDir, 'headless-rpc', role, 'stream.jsonl'), `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
}

function b502AppendRpcStream(f, role, frames) {
  writeFileSync(join(f.paths.taskDir, 'headless-rpc', role, 'stream.jsonl'), `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`, { flag: 'a' })
}

function b502RpcFrames(command, id = 'b502-bash') {
  return [
    { type: 'turn_start' },
    { type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command } },
    { type: 'tool_execution_end', toolCallId: id, toolName: 'bash' },
    { type: 'turn_end' },
    { type: 'agent_settled' },
  ]
}

test('an own-task probe is admitted on headless rpc from the transports task dir', () => {
  const f = fixture({ role: 'reviewer' })
  try {
    const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b502/gate.mjs', fence: [] }
    const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
    b502AppendRpcStream(f, 'reviewer', b502RpcFrames(`node --test ${f.paths.taskDir}/probe.test.mjs`))
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'reviewer', status: 'done', summary: 'probe run', artifacts: [], details: {} }))
    assert.equal(f.io.wait(run.returnPath, 60).status, 'done')
  } finally { f.cleanup() }
})

test('two declared builder npm test calls across dispatches spend the allowance exactly once', () => {
  const f = fixture()
  try {
    const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b502/gate.mjs', fence: ['crew/'] }
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md', policy })
    b502AppendRpcStream(f, 'builder', b502RpcFrames('npm test', 'b502-npm-1'))
    writeFileSync(first.returnPath, JSON.stringify({ assignment_id: first.id, role: 'builder', status: 'done', summary: 'first', artifacts: [], details: {} }))
    assert.equal(f.io.wait(first.returnPath, 60).status, 'done')

    const second = f.io.assign({ role: 'builder', briefFile: '/brief-again.md', policy })
    b502AppendRpcStream(f, 'builder', b502RpcFrames('npm test', 'b502-npm-2'))
    writeFileSync(second.returnPath, JSON.stringify({ assignment_id: second.id, role: 'builder', status: 'done', summary: 'second', artifacts: [], details: {} }))
    const envelope = f.io.wait(second.returnPath, 60)
    assert.equal(envelope.status, 'insufficient')
    assert.equal(envelope.details.suite_refusal.command, 'npm test')
  } finally { f.cleanup() }
})

test('a refused suite run is still counted in the turn census on headless rpc', () => {
  const rows = []
  const f = fixture({ role: 'reviewer', log: (row) => rows.push(row) })
  try {
    const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b502/gate.mjs', fence: [] }
    const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
    b502AppendRpcStream(f, 'reviewer', b502RpcFrames('node --test /etc/evil.test.mjs', 'b502-census'))
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'reviewer', status: 'done', summary: 'probe run', artifacts: [], details: {} }))
    const envelope = f.io.wait(run.returnPath, 60)
    assert.equal(envelope.status, 'insufficient')
    const census = rows.find((row) => row.seat_turn_census)?.seat_turn_census
    assert.equal(census.suite_runs, 1)
    assert.equal(census.by_class.test, 1)
  } finally { f.cleanup() }
})

test('b416 K2/F6 RPC policy records one aggregate and one refusal detail before a reviewer done envelope', () => {
  const rows = []
  const f = fixture({ role: 'reviewer', log: (row) => rows.push(row) })
  try {
    const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b416/gate.mjs', fence: [] }
    const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
    b416RpcStream(f, 'reviewer', b416RpcFrames('node --test crew/headless-rpc.test.mjs'))
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'reviewer', status: 'done', summary: 'done', artifacts: [], details: {} }))
    const envelope = f.io.wait(run.returnPath, 60)
    assert.equal(envelope.status, 'insufficient')
    assert.equal(envelope.details.suite_refusal.command, 'node --test crew/headless-rpc.test.mjs')
    assert.equal(envelope.details.suite_refusal.gate_path, policy.gatePath)
    assert.equal(rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.suite_policy).length, 1)
    assert.equal(rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.refusal === SUITE_RUN_REFUSAL).length, 1)
    assert.equal(rows.filter((row) => row.seat_turn_census).length, 1)
    assert.equal(f.writes.some((frame) => frame.type === 'steer'), false)
  } finally { f.cleanup() }
})

test('b416 K2 RPC policy survives parse, zero-deadline opaque, and zero-deadline forbidden terminal boundaries', () => {
  const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b416/gate.mjs', fence: [] }
  {
    const rows = []; const f = fixture({ role: 'reviewer', log: (row) => rows.push(row) })
    try {
      const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
      b416RpcStream(f, 'reviewer', [
        { type: 'tool_execution_start', toolCallId: 'opaque-parse', toolName: 'bash', args: { command: 'bash tools/run-everything.sh' } },
        { type: 'response', command: 'parse', success: false, error: 'bad frame' },
      ])
      assert.throws(() => f.io.wait(run.returnPath, 60), (error) => error.stage === 'rpc-parse-error')
      const aggregate = rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.suite_policy)
      assert.equal(aggregate.length, 1)
      assert.equal(aggregate[0].suite_policy.unrecognised, 1)
      assert.equal(rows.some((row) => row.refusal === SUITE_RUN_REFUSAL), false)
    } finally { f.cleanup() }
  }
  {
    let clock = 0; const rows = []
    const f = fixture({ role: 'reviewer', now: () => clock, sleep: (ms) => { clock += ms }, log: (row) => rows.push(row) })
    try {
      const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
      b416RpcStream(f, 'reviewer', [{ type: 'tool_execution_start', toolCallId: 'opaque-timeout', toolName: 'bash', args: { command: 'bash tools/run-everything.sh' } }])
      assert.throws(() => f.io.wait(run.returnPath, 0), (error) => error.stage === 'rpc-timeout')
      assert.equal(rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.suite_policy).length, 1)
      assert.equal(rows.find((row) => row.event === SEAT_SUITE_POLICY_EVENT)?.suite_policy.unrecognised, 1)
    } finally { f.cleanup() }
  }
  {
    let clock = 0; const rows = []
    const f = fixture({ role: 'reviewer', now: () => clock, sleep: (ms) => { clock += ms }, log: (row) => rows.push(row) })
    try {
      const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
      b416RpcStream(f, 'reviewer', [{ type: 'tool_execution_start', toolCallId: 'forbidden-timeout', toolName: 'bash', args: { command: 'node --test crew/headless-rpc.test.mjs' } }])
      const envelope = f.io.wait(run.returnPath, 0)
      assert.equal(envelope.status, 'insufficient')
      assert.equal(rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.suite_policy).length, 1)
      assert.equal(rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.refusal === SUITE_RUN_REFUSAL).length, 1)
      assert.equal(f.writes.some((frame) => frame.type === 'steer'), false)
    } finally { f.cleanup() }
  }
})

test('RV1-3 malformed RPC frame types do not consume a later forbidden call', () => {
  const rows = []
  const f = fixture({ role: 'reviewer', log: (row) => rows.push(row) })
  try {
    const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b433/gate.mjs', fence: [] }
    const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
    const captured = readFileSync(new URL('../tasks/headless-worker/captures/pi-a1-json-baseline.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
    const settled = captured.findIndex((frame) => frame.type === 'agent_settled')
    captured.splice(settled, 0,
      { type: 'tool_execution_start', toolCallId: 'non-string-name', toolName: { toString: 'not-callable' }, args: null },
      { type: 'tool_execution_start', toolCallId: 'null-args', toolName: 'bash', args: null },
      { type: 'tool_execution_start', toolCallId: 'later-forbidden', toolName: 'bash', args: { command: 'node --test crew/headless-rpc.test.mjs' } },
    )
    b416RpcStream(f, 'reviewer', captured)
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'reviewer', status: 'done', artifacts: [], details: {} }))
    const envelope = f.io.wait(run.returnPath, 60)
    assert.equal(envelope.status, 'insufficient')
    assert.equal(envelope.details.suite_refusal.command, 'node --test crew/headless-rpc.test.mjs')
    const aggregate = rows.find((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.suite_policy)
    assert.equal(aggregate.suite_policy.refused_at_least, 1)
    assert.equal(aggregate.suite_policy.unrecognised, 1)
    assert.equal(rows.filter((row) => row.refusal === SUITE_RUN_REFUSAL).length, 1)
  } finally { f.cleanup() }
})

test('b416 C5/K2 opaque and non-shell RPC frames remain non-blocking but keep their measured policy counters', () => {
  const rows = []; const f = fixture({ role: 'reviewer', log: (row) => rows.push(row) })
  try {
    const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b416/gate.mjs', fence: [] }
    const run = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
    b416RpcStream(f, 'reviewer', [
      { type: 'tool_execution_start', toolCallId: 'write-no-command', toolName: 'write', args: { path: 'a.mjs', content: 'x' } },
      { type: 'tool_execution_start', toolCallId: 'opaque-done', toolName: 'bash', args: { command: 'bash tools/run-everything.sh' } },
      { type: 'agent_settled' },
    ])
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, role: 'reviewer', status: 'done', artifacts: [], details: {} }))
    assert.equal(f.io.wait(run.returnPath, 60).status, 'done')
    const aggregate = rows.find((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.suite_policy)
    assert.equal(aggregate.suite_policy.unrecognised, 1)
    assert.equal(aggregate.suite_policy.refused, null)
    assert.equal(rows.some((row) => row.suite_policy_absent === SUITE_RUN_UNRECOGNISED), true)
  } finally { f.cleanup() }
})

test('b416 F8 an RPC abort write fault returns the decided refusal, evicts the dead seat, and respawns it cleanly', () => {
  const rows = []; const wire = []; const probes = []; let clock = 0
  const f = fixture({
    role: 'reviewer', now: () => clock, sleep: (ms) => { clock += ms }, log: (row) => rows.push(row),
    writeSync: (_fd, line) => {
      const frame = JSON.parse(line)
      if (frame.type === 'abort') throw new Error('broken abort fifo')
      wire.push(frame)
    },
    kill: (_pid, signal) => {
      probes.push(signal)
      const error = new Error('worker gone'); error.code = 'ESRCH'; throw error
    },
  })
  try {
    const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b416/gate.mjs', fence: [] }
    const first = f.io.assign({ role: 'reviewer', briefFile: '/brief.md', policy })
    b416RpcStream(f, 'reviewer', [{ type: 'tool_execution_start', toolCallId: 'fault-refusal', toolName: 'bash', args: { command: 'node --test crew/headless-rpc.test.mjs' } }])
    const envelope = f.io.wait(first.returnPath, 60)
    assert.equal(envelope.status, 'insufficient')
    assert.equal(rows.filter((row) => row.event === 'rpc-enforcement-abort-failed').length, 1)
    assert.equal(rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.suite_policy).length, 1)
    assert.equal(rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT && row.refusal === SUITE_RUN_REFUSAL).length, 1)
    assert.equal(wire.some((frame) => frame.type === 'steer'), false)
    assert.ok(probes.includes('SIGKILL'))
    const second = f.io.assign({ role: 'reviewer', briefFile: '/brief-again.md', policy })
    assert.equal(second.id, 'd2')
    assert.equal(f.commands.filter((entry) => entry.kind === 'spawn').length, 2)
    assert.equal(wire.filter((frame) => frame.type === 'prompt').length, 2)
  } finally { f.cleanup() }
})

test('C1 unacknowledged RPC assignment fails at the delivery window', () => {
  const runCase = (priorTurn) => {
    let clock = 0
    const f = fixture({ promptDeliveryWindowMs: 100, now: () => clock, sleep: (ms) => { clock += ms } })
    try {
      let run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
      const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
      if (priorTurn) {
        writeFileSync(stream, JSON.stringify({ type: 'agent_settled' }) + '\n')
        writeFileSync(run.returnPath, JSON.stringify(ordinaryRpcEnvelope(run.id)))
        assert.equal(f.io.wait(run.returnPath, 60).status, 'done')
        run = f.io.assign({ role: 'builder', briefFile: '/brief-next.md' })
      } else {
        writeFileSync(stream, '')
      }
      assert.throws(() => f.io.wait(run.returnPath, 600), (error) => error.stage === 'rpc-prompt-undelivered')
      assert.equal(clock, 100)
    } finally { f.cleanup() }
  }
  runCase(false)
  runCase(true)
  assertUnsettledPriorFrameFailsDelivery({ type: 'turn_start' })
  assertUnsettledPriorFrameFailsDelivery({ type: 'agent_settled' })
})

test('parked unsettled RPC frames cannot acknowledge a successor', () => {
  assertUnsettledPriorFrameFailsDelivery({ type: 'turn_start' })
  assertUnsettledPriorFrameFailsDelivery({ type: 'agent_settled' })
  assertUnsettledPriorFrameFailsDelivery({ type: 'turn_end' })
})

// RV1-1 kill-mutation. turn_end brackets ONE provider turn, not the assignment, so
// a parked predecessor that is still WORKING emits it seconds after its own wait
// expired. Treating it as the parked turn's terminus releases the quarantine and
// every LATER frame the predecessor writes is then attributed to the successor.
//
// The delivery assertions above cannot see this — RV1-1 said so, and it was right:
// they write a single frame, so nothing follows the boundary to be misattributed.
// This case writes frames AFTER the turn_end and counts where they landed.
test('a parked predecessor that finishes a provider turn stays parked', () => {
  let clock = 0
  const rows = []
  const f = fixture({
    promptDeliveryWindowMs: 100_000,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: (_pid, signal) => { if (signal === 0) return },
    log: (row) => rows.push(row),
  })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seatDir = join(f.paths.taskDir, 'headless-rpc', 'builder')
    const stream = join(seatDir, 'stream.jsonl')
    writeFileSync(join(seatDir, 'pgid'), '701')
    writeFileSync(stream, JSON.stringify({ type: 'turn_start' }) + '\n')
    assert.throws(() => f.io.wait(first.returnPath, 0), (error) => error.stage === 'rpc-timeout')

    const second = f.io.assign({ role: 'builder', briefFile: '/brief-next.md' })
    assert.equal(second.id, 'd2')

    // The predecessor completes a provider turn and KEEPS GOING: four frames, all
    // of them still its own.
    const parked = [
      { type: 'turn_end' },
      { type: 'turn_start' },
      { type: 'tool_execution_start', tool: 'Bash' },
      { type: 'turn_end' },
    ]
    writeFileSync(stream, parked.map((frame) => JSON.stringify(frame)).join('\n') + '\n', { flag: 'a' })
    assert.throws(() => f.io.wait(second.returnPath, 1))

    const census = rows.map((row) => row.seat_turn_census).filter(Boolean).at(-1)
    assert.ok(census, 'a census row must be journalled')
    // All four stay parked. Restore turn_end as a terminus and the first frame
    // releases the quarantine, so only it is counted and the other three are
    // attributed to the successor instead — this equality is what fails.
    assert.equal(census.parked_frames, parked.length)
    // And the successor is not credited with the predecessor's work. It observed NO
    // frames of its own, so its census is null rather than zero — a null beats a
    // value nobody measured. Restore turn_end as a terminus and three of the four
    // frames are attributed here instead, and this reads 1.
    assert.equal(census.tool_calls, null)
    assert.equal(census.absent_reason, CENSUS_ABSENT_CAUSES.no_frames)
  } finally { f.cleanup() }
})

// RV2-1 + RV2-2 kill-mutation. While a prior turn is parked, pi answers the new
// prompt it is too busy to accept within milliseconds. That response carries the
// NEW prompt's own id, so it is the successor's frame and must reach the wait loop:
// swallowing it means isBusyRefusal is never consulted, PROMPT_REFUSAL_RETRIES
// never runs, and the turn dies as rpc-prompt-undelivered — a transport-error
// rather than a retryable kind — so the lane escalates where it used to recover.
test('a busy refusal for the successor survives a parked predecessor, and the parked frames are named', () => {
  let clock = 0
  const rows = []
  // The delivery window is deliberately GENEROUS here: RV2-1 is about the refusal
  // being CONSUMED, not about the window being short. pi answers within
  // milliseconds, well inside any real window, and a narrow one would fail the turn
  // in the wait loop's window check before the frame loop ever ran.
  let releasePrior = false
  let writeSuccessor = false
  let successor = null
  const f = fixture({
    promptDeliveryWindowMs: 100_000,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: (_pid, signal) => { if (signal === 0) return },
    onSleep: ({ appendStream }) => {
      if (releasePrior) {
        releasePrior = false
        appendStream(`${JSON.stringify({ type: 'agent_settled' })}\n`)
        writeSuccessor = true
      } else if (writeSuccessor && successor) {
        writeSuccessor = false
        writeFileSync(successor.returnPath, JSON.stringify(ordinaryRpcEnvelope(successor.id)))
      }
    },
    log: (row) => rows.push(row),
  })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seatDir = join(f.paths.taskDir, 'headless-rpc', 'builder')
    const stream = join(seatDir, 'stream.jsonl')
    writeFileSync(join(seatDir, 'pgid'), '701')
    writeFileSync(stream, JSON.stringify({ type: 'turn_start' }) + '\n')
    assert.throws(() => f.io.wait(first.returnPath, 0), (error) => error.stage === 'rpc-timeout')

    const second = f.io.assign({ role: 'builder', briefFile: '/brief-next.md' })
    successor = second
    assert.equal(second.id, 'd2')
    const promptsBefore = f.writes.filter((frame) => frame.type === 'prompt')
    const successorPrompt = promptsBefore[promptsBefore.length - 1]

    // The parked predecessor keeps working (turn_end), and pi refuses the
    // successor's prompt by its own id in the same poll.
    writeFileSync(stream, `${JSON.stringify({ type: 'turn_end' })}\n${JSON.stringify({
      type: 'response', id: successorPrompt.id, command: 'prompt', success: false,
      error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    })}\n`, { flag: 'a' })

    releasePrior = true
    const recovered = f.io.wait(second.returnPath, 600)
    assert.equal(recovered.status, 'done', 'busy refusal must recover the successor turn')

    // The refusal was CONSULTED: a retry prompt was minted rather than the turn
    // dying undelivered. This is the assertion the swallow mutation fails.
    const promptsAfter = f.writes.filter((frame) => frame.type === 'prompt')
    assert.ok(promptsAfter.length > promptsBefore.length, 'a busy refusal must mint a retry prompt')

    // RV2-2: the parked frames are excluded from the successor's attribution, and
    // the census NAMES them rather than reporting a smaller count as the whole.
    const census = rows.map((row) => row.seat_turn_census).filter(Boolean).at(-1)
    assert.ok(census, 'a census row must be journalled')
    assert.ok(census.parked_frames > 0, 'parked frames must be counted, not discarded')
    assert.equal(census.parked_frames_reason, 'prior-turn-unsettled')
  } finally { f.cleanup() }
})

test('D1 stale settle id cannot satisfy a newer RPC assignment', () => {
  let clock = 0; let appended = false
  const rows = []
  const f = fixture({
    promptDeliveryWindowMs: 100,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    onSleep: ({ ms, appendStream }) => {
      if (!appended && ms === WAIT_POLL_MS) {
        appended = true
        appendStream(JSON.stringify({ type: 'agent_settled' }) + '\n')
      }
    },
    log: (row) => rows.push(row),
  })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
    writeFileSync(stream, JSON.stringify({ type: 'agent_end' }) + '\n')
    writeFileSync(first.returnPath, JSON.stringify(ordinaryRpcEnvelope(first.id)))
    assert.equal(f.io.wait(first.returnPath, 60).status, 'done')
    const second = f.io.assign({ role: 'builder', briefFile: '/brief-next.md' })
    assert.throws(() => f.io.wait(second.returnPath, 600), (error) => error.stage === 'rpc-prompt-undelivered')
    assert.deepEqual(rows.find((row) => row.rpc_settle_gate)?.rpc_settle_gate, { role: 'builder', id: 'd1', settled: true, polls: 1 })
    assert.equal(JSON.parse(readFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'session.json'))).lastAssignmentId, 'd1')
  } finally { f.cleanup() }
})

test('F1 acknowledged growing RPC turn is never declared undelivered', () => {
  let clock = 0; let grew = false
  const rows = []
  const f = fixture({
    promptDeliveryWindowMs: 50,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    onSleep: ({ appendStream }) => {
      if (grew) return
      grew = true
      appendStream(JSON.stringify({ type: 'turn_start' }) + '\n')
    },
    kill: () => {},
    log: (row) => rows.push(row),
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => f.io.wait(run.returnPath, 0.1), (error) => error.stage === 'rpc-timeout')
    assert.equal(rows.filter((row) => row.event === 'rpc-prompt-delivery').length, 0)
    assert.ok(clock >= 100)
  } finally { f.cleanup() }
})

test('G1 fail-fast prompt delivery remedy is journalled with outcome', () => {
  let clock = 0
  const rows = []
  const f = fixture({ promptDeliveryWindowMs: 100, now: () => clock, sleep: (ms) => { clock += ms }, log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    writeFileSync(join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), '')
    assert.throws(() => f.io.wait(run.returnPath, 600), (error) => error.stage === 'rpc-prompt-undelivered')
    const deliveryRows = rows.filter((row) => row.event === 'rpc-prompt-delivery')
    assert.equal(deliveryRows.length, 1)
    assert.equal(deliveryRows[0].role, 'builder')
    assert.equal(deliveryRows[0].logical_id, run.id)
    assert.equal(deliveryRows[0].run_id, 'd1')
    assert.equal(deliveryRows[0].prior_assignment_id, null)
    assert.equal(deliveryRows[0].recorded_assignment_id, null)
    assert.equal(deliveryRows[0].outcome, 'failed-fast')
    assert.equal(deliveryRows[0].reason, 'prompt-unacknowledged')
    assert.equal(deliveryRows[0].window_ms, 100)
    assert.equal(deliveryRows[0].elapsed_ms, 100)
  } finally { f.cleanup() }
})

test('H1 ordinary RPC completion keeps its journal and envelope shape', () => {
  const rows = []
  const f = fixture({ log: (row) => rows.push(row) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const envelope = ordinaryRpcEnvelope(run.id)
    settle(f, run, [{ type: 'agent_settled' }])
    writeFileSync(run.returnPath, JSON.stringify(envelope))
    assert.deepEqual(f.io.wait(run.returnPath, 60), envelope)
    const assignment = rows.find((row) => row.event === 'assignment-delivery')
    assert.deepEqual({ ...assignment, at: null }, {
      at: null, event: 'assignment-delivery', role: 'builder', assignment_id: run.id,
      transport: 'headless-rpc', mode: 'path', brief_bytes: null,
      brief_size_measured: false, brief_size_unmeasured_reason: 'brief-unreadable',
    })
    const outcome = rows.find((row) => row.rpc_outcome)
    assert.deepEqual({ ...outcome, at: null }, { at: null, rpc_outcome: 'ok', role: 'builder', id: run.id, exit_code: null })
    assert.equal(rows.some((row) => row.event === 'rpc-prompt-delivery'), false)
  } finally { f.cleanup() }
})

test('RPC prompt FIFO accepts undefined legacy writers and requires full numeric writes', () => {
  const flags = []; const lengths = []
  const f = fixture({
    openSync: (_path, value) => { flags.push(value); return 10 },
    writeSync: (_fd, frame) => { assert.equal(Buffer.isBuffer(frame), true); lengths.push(frame.length); return frame.length },
  })
  try {
    f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.ok(flags.some((value) => value === (fsConstants.O_RDWR | fsConstants.O_NONBLOCK)))
    assert.equal(lengths.length, 1)
    assert.ok(lengths[0] > 0)
  } finally { f.cleanup() }
})

test('RPC prompt FIFO stalled, EAGAIN, and EPERM writes fail fast', () => {
  // A writer that transfers NOTHING is a stall and still fails by name inside the
  // delivery window. `() => 1` used to be listed here as a partial write; it is not a
  // stall — it is a writer making progress one byte at a time — and it is asserted
  // BELOW to succeed instead.
  for (const failure of [
    () => 0,
    () => { const error = new Error('would block'); error.code = 'EAGAIN'; throw error },
    () => { const error = new Error('permission denied'); error.code = 'EPERM'; throw error },
  ]) {
    const rows = []
    const f = fixture({ writeSync: failure, promptDeliveryWindowMs: 0, log: (row) => rows.push(row) })
    try {
      assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }), (error) => error.stage === 'rpc-prompt-undelivered')
      assert.equal(rows.filter((row) => row.event === 'rpc-prompt-delivery').length, 1)
    } finally { f.cleanup() }
  }
})

// The command FIFO is opened O_RDWR | O_NONBLOCK, so one writeSync transfers at most
// what fits in the pipe buffer — 8-64 KB — and a prompt is the whole assignment. A
// short write is therefore the NORMAL outcome for a large brief, not a fault.
// b576-suitesplit died at build:r1 with elapsed_ms 0 against a 39 KB brief because the
// first short count was treated as fatal.
test('a prompt larger than the pipe buffer is written across several writes', () => {
  const chunks = []
  let calls = 0
  const f = fixture({
    // Transfer at most 8 KB per call, the smallest buffer the kernel reports here.
    writeSync: (_fd, buffer, offset = 0, length = buffer.length) => {
      calls += 1
      const n = Math.min(length, 8192)
      chunks.push(buffer.subarray(offset, offset + n).toString('utf8'))
      return n
    },
    sleep: () => {},
  })
  try {
    // assign() composes the prompt itself; `note` is appended verbatim, so it is the
    // handle for making one as large as a real brief.
    const note = 'x'.repeat(40_000)
    const assigned = f.io.assign({ role: 'builder', briefFile: '/brief.md', note })
    assert.ok(assigned, 'a large prompt must be delivered, not refused')
    assert.ok(calls > 1, 'a 40 KB prompt must take more than one write')
    // Every byte arrives, in order, exactly once.
    const joined = chunks.join('')
    assert.ok(joined.includes(note), 'the whole prompt must reach the FIFO')
  } finally { f.cleanup() }
})

test('A1 EAGAIN retries before the shared prompt deadline', () => {
  let clock = 0
  let attempts = 0
  const rows = []
  const f = fixture({
    promptDeliveryWindowMs: 200,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    writeSync: () => {
      attempts += 1
      const error = new Error('would block')
      error.code = 'EAGAIN'
      throw error
    },
    log: (row) => rows.push(row),
  })
  try {
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }), (error) => error.stage === 'rpc-prompt-undelivered')
    assert.ok(attempts > 1, 'EAGAIN must retry before the deadline')
    assert.ok(f.sleepCount() > 0, 'EAGAIN retries must sleep')
    assert.equal(clock, 200, 'failure must stop at the configured deadline')
    assert.equal(rows.find((row) => row.event === 'rpc-prompt-delivery')?.reason, 'prompt-write-would-block')
  } finally { f.cleanup() }
})

test('B1 prompt write failures report measured elapsed', () => {
  const window = 200
  const stalledRows = []
  let stalledClock = 0
  const stalled = fixture({
    promptDeliveryWindowMs: window,
    now: () => stalledClock,
    sleep: (ms) => { stalledClock += ms },
    writeSync: () => {
      const error = new Error('would block')
      error.code = 'EAGAIN'
      throw error
    },
    log: (row) => stalledRows.push(row),
  })
  try {
    assert.throws(() => stalled.io.assign({ role: 'builder', briefFile: '/brief.md' }), (error) => error.stage === 'rpc-prompt-undelivered')
    const row = stalledRows.find((entry) => entry.event === 'rpc-prompt-delivery')
    assert.equal(row?.reason, 'prompt-write-would-block')
    assert.equal(row?.elapsed_ms, window)
  } finally { stalled.cleanup() }

  const immediateRows = []
  const immediate = fixture({
    promptDeliveryWindowMs: window,
    now: () => 0,
    writeSync: () => {
      const error = new Error('permission denied')
      error.code = 'EPERM'
      throw error
    },
    log: (row) => immediateRows.push(row),
  })
  try {
    assert.throws(() => immediate.io.assign({ role: 'builder', briefFile: '/brief.md' }), (error) => error.stage === 'rpc-prompt-undelivered')
    const row = immediateRows.find((entry) => entry.event === 'rpc-prompt-delivery')
    assert.equal(row?.reason, 'prompt-write-denied')
    assert.equal(row?.elapsed_ms, 0)
  } finally { immediate.cleanup() }
})

test('C1 prompt write and acknowledgement share one delivery window', () => {
  let clock = 0
  const window = 100
  const rows = []
  const f = fixture({
    promptDeliveryWindowMs: window,
    now: () => clock,
    writeSync: (_fd, buffer) => {
      clock += 80
      return buffer.length
    },
    sleep: (ms) => { clock += ms },
    log: (row) => rows.push(row),
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => f.io.wait(run.returnPath, 600), (error) => error.stage === 'rpc-prompt-undelivered')
    assert.equal(clock, window, 'write and acknowledgement must share one delivery deadline')
    assert.equal(rows.find((row) => row.event === 'rpc-prompt-delivery')?.elapsed_ms, window)
  } finally { f.cleanup() }
})

test('D1 busy-refusal recovery completes by outcome', () => {
  let clock = 0
  let releasePrior = false
  let writeSuccessor = false
  let successor = null
  const rows = []
  const f = fixture({
    promptDeliveryWindowMs: 100_000,
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: (_pid, signal) => { if (signal === 0) return },
    onSleep: ({ appendStream }) => {
      if (releasePrior) {
        releasePrior = false
        appendStream(`${JSON.stringify({ type: 'agent_settled' })}\n`)
        writeSuccessor = true
      } else if (writeSuccessor && successor) {
        writeSuccessor = false
        writeFileSync(successor.returnPath, JSON.stringify(ordinaryRpcEnvelope(successor.id)))
      }
    },
    log: (row) => rows.push(row),
  })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
    const seatDir = join(f.paths.taskDir, 'headless-rpc', 'builder')
    const stream = join(seatDir, 'stream.jsonl')
    writeFileSync(join(seatDir, 'pgid'), '701')
    writeFileSync(stream, JSON.stringify({ type: 'turn_start' }) + '\n')
    assert.throws(() => f.io.wait(first.returnPath, 0), (error) => error.stage === 'rpc-timeout')

    const second = f.io.assign({ role: 'builder', briefFile: '/brief-next.md' })
    successor = second
    assert.equal(second.id, 'd2')
    const promptsBefore = f.writes.filter((frame) => frame.type === 'prompt')
    const successorPrompt = promptsBefore[promptsBefore.length - 1]
    writeFileSync(stream, `${JSON.stringify({ type: 'turn_end' })}\n${JSON.stringify({
      type: 'response', id: successorPrompt.id, command: 'prompt', success: false,
      error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    })}\n`, { flag: 'a' })

    releasePrior = true
    assert.equal(f.io.wait(second.returnPath, 600).status, 'done', 'busy refusal must recover the successor turn')
    const promptsAfter = f.writes.filter((frame) => frame.type === 'prompt')
    assert.ok(promptsAfter.length > promptsBefore.length, 'a busy refusal must mint a retry prompt')
    const census = rows.map((row) => row.seat_turn_census).filter(Boolean).at(-1)
    assert.ok(census, 'a census row must be journalled')
    assert.ok(census.parked_frames > 0, 'parked frames must be counted, not discarded')
    assert.equal(census.parked_frames_reason, 'prior-turn-unsettled')
  } finally { f.cleanup() }
})

test('E1 unreadable corpus lanes are excluded from measured rates', () => {
  const fixtureData = corpusFixture()
  const report = rpcDeliveryCorpusReport(fixtureData.lanes, fixtureData.deps)
  assert.equal(report.total_lanes, 3)
  assert.equal(report.measured_lanes, 1)
  for (const block of [report.cmd_mtime_predates_assignment, report.older_settle_gate_candidates, report.either_candidate]) {
    assert.equal(block.measured_lane_denominator, 1)
    assert.equal(block.rate_percent_lanes, 100)
  }

  const unreadable = rpcDeliveryCorpusReport([fixtureData.lanes[1]], fixtureData.deps)
  assert.equal(unreadable.total_lanes, 1)
  assert.equal(unreadable.measured_lanes, 0)
  for (const block of [unreadable.cmd_mtime_predates_assignment, unreadable.older_settle_gate_candidates, unreadable.either_candidate]) {
    assert.equal(block.measured_lane_denominator, 0)
    assert.equal(block.rate_percent_lanes, null)
  }
  assert.deepEqual(unreadable.unreadable, [{ lane: fixtureData.lanes[1], candidates: null, reason: 'denied' }])
})

test('RV1-1 immediate EPERM writes zero elapsed on a frozen clock', () => {
  const rows = []
  const f = fixture({
    now: () => 0,
    writeSync: () => {
      const error = new Error('permission denied')
      error.code = 'EPERM'
      throw error
    },
    log: (row) => rows.push(row),
  })
  try {
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/brief.md' }), (error) => error.stage === 'rpc-prompt-undelivered')
    const row = rows.find((entry) => entry.event === 'rpc-prompt-delivery')
    assert.equal(row?.reason, 'prompt-write-denied')
    assert.equal(row?.elapsed_ms, 0)
  } finally { f.cleanup() }
})
