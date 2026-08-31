import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import {
  DRIVER_GONE_PERIODS,
  DRIVER_GONE,
  DRIVER_RUNNING,
  HEARTBEAT_PERIOD_MS,
  driverState,
} from '../scripts/factory/lane-watch.mjs'
import {
  emitAdapter,
  HEADLESS_RPC_TRANSPORT,
  HEADLESS_TRANSPORT,
  LIVENESS_PROBE_MS,
  seatIo,
  headlessStreamPaths,
} from './seat-io.mjs'

function scratch() {
  return scratchDir('seat-io-heartbeat-')
}

function setMtime(path, mtimeMs) {
  const seconds = mtimeMs / 1000
  utimesSync(path, seconds, seconds)
}

function streamFile(taskDir, runId, mtimeMs) {
  const dir = join(taskDir, 'headless', runId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'stream.jsonl')
  writeFileSync(path, '{"type":"assistant"}\n')
  setMtime(path, mtimeMs)
  return path
}

function emitterFor(beats) {
  const handle = {
    heartbeat: (row) => { beats.push(row); return row },
    recordEvent: () => ({}),
  }
  return {
    adwId: 'seat-io-heartbeat',
    emit: (fn) => fn(handle, () => 1),
    phaseTransition: () => ({ phase_id: null }),
  }
}

function headlessHarness({ role = 'builder', ticks = [], firstWaitThrows = false, transport = HEADLESS_TRANSPORT } = {}) {
  const taskDir = scratch()
  const returnsDir = join(taskDir, 'returns')
  mkdirSync(returnsDir, { recursive: true })
  const paths = { dir: taskDir, taskDir, returnsDir }
  const beats = []
  const envelope = { assignment_id: 'd1', role, status: 'done' }
  let waits = 0
  const transportFactory = ({ deps }) => ({
    assign(spec) {
      const id = spec.reask?.id || 'd1'
      const returnPath = spec.reask?.returnPath || join(returnsDir, `${id}.${role}.json`)
      return { id, returnPath }
    },
    wait() {
      waits += 1
      if (waits === 1 && firstWaitThrows) {
        const err = new Error('headless envelope is not parseable')
        err.stage = 'headless-parse-error'
        throw err
      }
      for (const tick of ticks) {
        tick()
        deps.sleep(1)
      }
      return envelope
    },
  })
  const crew = {
    claude_bin: '/nonexistent/claude',
    members: { [role]: { transport, agent: 'claude', model: 'test-model' } },
  }
  let clock = 1_600_000_000_000
  const io = seatIo(crew, paths, taskDir, emitterFor(beats), null, {}, {
    headlessIo: transport === HEADLESS_TRANSPORT ? transportFactory : undefined,
    headlessRpcIo: transport === HEADLESS_RPC_TRANSPORT ? transportFactory : undefined,
    resolveWorkerBin: () => '/nonexistent/claude',
    now: () => { clock += 1_000; return clock },
    sleep: () => {},
    logLine: () => {},
    sendLine: () => {},
  })
  return { io, taskDir, beats, envelope, role, waits: () => waits }
}

function runHeadless(h) {
  const assignment = h.io.assign({ role: h.role, briefFile: join(h.taskDir, 'brief.md') })
  return h.io.wait(assignment.returnPath, 30)
}

test('a headless seat whose stream mtime advances emits exactly one heartbeat carrying THAT mtime', () => {
  const base = 1_700_000_000_000
  const grown = base + 90_000
  let path = null
  const h = headlessHarness({
    ticks: [
      () => { path = streamFile(h.taskDir, 'd1', base) },
      () => setMtime(path, grown),
      () => {},
    ],
  })
  assert.deepEqual(runHeadless(h), h.envelope)
  assert.deepEqual(h.beats, [{ adw_id: 'seat-io-heartbeat', target: 'session', at: grown }])
})

test('a headless seat whose files never grow emits nothing, while a growing seat in the same run emits', () => {
  const base = 1_700_100_000_000
  const quiet = headlessHarness({ ticks: [() => streamFile(quiet.taskDir, 'd1', base), () => {}, () => {}] })
  const busyPath = { value: null }
  const busy = headlessHarness({
    ticks: [
      () => { busyPath.value = streamFile(busy.taskDir, 'd1', base) },
      () => setMtime(busyPath.value, base + 45_000),
    ],
  })
  assert.deepEqual(runHeadless(quiet), quiet.envelope)
  assert.deepEqual(runHeadless(busy), busy.envelope)
  assert.equal(quiet.beats.length, 0)
  assert.deepEqual(busy.beats, [{ adw_id: 'seat-io-heartbeat', target: 'session', at: base + 45_000 }])
})

test('a headless seat with no readable stream file emits nothing, raises no error, and still returns its envelope', () => {
  const h = headlessHarness({ ticks: [() => {}, () => {}, () => {}] })
  assert.deepEqual(runHeadless(h), h.envelope)
  assert.deepEqual(h.beats, [])
})

test("a pane seat's heartbeats are exactly its probes' own readings", () => {
  const taskDir = scratch()
  const returnsDir = join(taskDir, 'returns')
  mkdirSync(returnsDir, { recursive: true })
  const paths = { dir: taskDir, taskDir, returnsDir }
  const beats = []
  const readings = []
  const envelope = { assignment_id: 'd1', role: 'builder', status: 'done' }
  let clock = 1_700_200_000_000
  const now = () => { clock += 2_500; return clock }
  const emitter = emitterFor(beats)
  const io = seatIo({
    claude_bin: '/nonexistent/claude',
    members: { builder: { transport: 'pane', surface_id: 'surface-builder', agent: 'claude' } },
  }, paths, taskDir, emitter, null, {}, {
    now,
    sleep: () => {},
    logLine: () => {},
    sendLine: () => {},
    tree: () => ({ windows: [{}] }),
    locate: (_tree, id) => { readings.push(clock); return { id } },
    existsSync: (path) => String(path).endsWith('d1.builder.json') ? beats.length >= 2 : false,
    readFileSync: () => JSON.stringify(envelope),
    transcriptPaths: () => [],
    refusalFrames: () => [],
  })
  const assignment = io.assign({ role: 'builder', briefFile: join(taskDir, 'brief.md') })
  assert.deepEqual(io.wait(assignment.returnPath, 600), envelope)
  assert.ok(beats.length >= 1)
  assert.ok(beats.every((row) => readings.includes(row.at)), `${JSON.stringify({ beats, readings })}`)
  assert.equal(LIVENESS_PROBE_MS, 30_000)
})

test("the bounded re-ask's second wait carries the growth heartbeat", () => {
  const base = 1_700_300_000_000
  let path = null
  const h = headlessHarness({
    firstWaitThrows: true,
    ticks: [
      () => { path = streamFile(h.taskDir, 'd1', base) },
      () => setMtime(path, base + 60_000),
    ],
  })
  assert.deepEqual(runHeadless(h), h.envelope)
  assert.equal(h.waits(), 2)
  assert.deepEqual(h.beats, [{ adw_id: 'seat-io-heartbeat', target: 'session', at: base + 60_000 }])
})

test('emitAdapter drops a heartbeat with no probe timestamp and keeps one with a measured at', () => {
  const rows = []
  const emit = emitAdapter({
    adwId: 'heartbeat-adapter',
    emit: (fn) => fn({ heartbeat: (row) => { rows.push(row); return row } }, () => 1),
    phaseTransition: () => ({}),
  })
  emit({ kind: 'heartbeat', role: 'builder' })
  emit({ kind: 'heartbeat', at: null, role: 'builder' })
  emit({ kind: 'heartbeat', at: 'later', role: 'builder' })
  emit({ kind: 'heartbeat', at: Infinity, role: 'builder' })
  emit({ kind: 'heartbeat', at: 1_700_400_000_123, role: 'builder' })
  assert.deepEqual(rows, [{ adw_id: 'heartbeat-adapter', target: 'session', at: 1_700_400_000_123 }])
})

test('headlessStreamPaths reads headless-json run dirs and the headless-rpc seat dir, and [] when nothing is readable', () => {
  const taskDir = scratch()
  mkdirSync(join(taskDir, 'headless', 'd1'), { recursive: true })
  mkdirSync(join(taskDir, 'headless', 'd2'), { recursive: true })
  writeFileSync(join(taskDir, 'headless', 'd1', 'stream.jsonl'), '')
  writeFileSync(join(taskDir, 'headless', 'd1', 'stderr.log'), '')
  const json = headlessStreamPaths({ taskDir, role: 'builder', transport: HEADLESS_TRANSPORT })
  assert.deepEqual(json, [
    join(taskDir, 'headless', 'd1', 'stream.jsonl'),
    join(taskDir, 'headless', 'd1', 'stderr.log'),
    join(taskDir, 'headless', 'd2', 'stream.jsonl'),
    join(taskDir, 'headless', 'd2', 'stderr.log'),
  ])
  assert.deepEqual(headlessStreamPaths({ taskDir, role: 'builder', transport: HEADLESS_RPC_TRANSPORT }), [
    join(taskDir, 'headless-rpc', 'builder', 'stream.jsonl'),
    join(taskDir, 'headless-rpc', 'builder', 'stderr.log'),
  ])
  assert.deepEqual(headlessStreamPaths({ taskDir, role: 'builder', transport: 'pane' }), [])
  assert.deepEqual(headlessStreamPaths({ taskDir: join(taskDir, 'missing'), transport: HEADLESS_TRANSPORT }), [])
  assert.deepEqual(headlessStreamPaths({ taskDir, transport: HEADLESS_RPC_TRANSPORT }), [])
  assert.deepEqual(headlessStreamPaths({ taskDir, transport: HEADLESS_TRANSPORT, deps: {
    existsSync: () => true,
    readdirSync: () => { throw new Error('permission denied') },
  } }), [])
})

test('driverState reaches driver-gone for a stalled headless lane and stays running for a beating one', () => {
  const now = 1_700_500_000_000
  const lane = { name: 'headless-lane', task: 'headless-lane', settled: false, transport: HEADLESS_TRANSPORT }
  const journal = { lastStage: 'build:r1', stages: ['build:r1'], notes: [] }
  const staleAt = now - DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS - 1
  const stalled = driverState(lane, journal, {
    now,
    terminal: null,
    session: { ended_at: null, last_heartbeat_at: staleAt },
  })
  const beating = driverState(lane, journal, {
    now,
    terminal: null,
    session: { ended_at: null, last_heartbeat_at: now - 1_000 },
  })
  assert.deepEqual(stalled, {
    state: DRIVER_GONE,
    heartbeat_age_ms: DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS + 1,
    stale_after_ms: DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS,
    threshold_origin: 'default',
  })
  assert.deepEqual(beating, {
    state: DRIVER_RUNNING,
    heartbeat_age_ms: 1_000,
    stale_after_ms: DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS,
    threshold_origin: 'default',
  })
})
