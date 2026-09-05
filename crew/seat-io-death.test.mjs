import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scratchDir } from '../test/helpers.mjs'
import {
  DESCENDANT_DIR,
  HEADLESS_RPC_TRANSPORT,
  HEADLESS_TRANSPORT,
  REASK_TIMEOUT_S,
  SEAT_DIED_STAGE,
  WAIT_POLL_MS,
  ROOT_DEATH_GROWTH_WINDOW_MS,
  ROOT_DEATH_SUPPRESSED_EVENT,
  seatIo,
  seatRootDeath,
} from './seat-io.mjs'

const ROLE = 'builder'
const ROOT_PID = 999001
const ROOT_START = 'Sun Aug 30 22:16:18 2026'
const BUDGET_S = 900
const RETRY_WINDOW_MS = Math.min(BUDGET_S, REASK_TIMEOUT_S) * 1000

function recordPath(taskDir, transport, seatId) {
  const dirName = transport === HEADLESS_RPC_TRANSPORT ? 'headless-rpc' : 'headless'
  return join(taskDir, DESCENDANT_DIR, `.${dirName}__${seatId}__seat-1.active.json`)
}

function writeRecord(taskDir, { transport = HEADLESS_TRANSPORT, seatId = 'd1', ...patch } = {}) {
  mkdirSync(join(taskDir, DESCENDANT_DIR), { recursive: true })
  writeFileSync(recordPath(taskDir, transport, seatId), JSON.stringify({
    reservation_id: 'res-1', phase: 'running', transport, role: ROLE, seat_id: seatId,
    seat_reservation_id: 'seat-1', marker_owner_pid: process.pid, owner_liveness: 'alive',
    root_pid: ROOT_PID, root_pgid: ROOT_PID, root_start: ROOT_START,
    groups: [], captures: 3, missed_snapshots: 0, discovery_failures: 0,
    root_settled: null, swept_at: null, sweep_id: null,
    owner: { pid: process.pid, startedAt: 1 },
    ...patch,
  }))
}

function writeNamedRecord(taskDir, {
  transport = HEADLESS_TRANSPORT, seatId = 'd1', reservationId = 'res-1', seatReservationId = reservationId,
  rootPid = ROOT_PID, rootStart = ROOT_START, ...patch
} = {}) {
  const dirName = transport === HEADLESS_RPC_TRANSPORT ? 'headless-rpc' : 'headless'
  const key = `${dirName}__${seatId}__${seatReservationId}`
  mkdirSync(join(taskDir, DESCENDANT_DIR), { recursive: true })
  writeFileSync(join(taskDir, DESCENDANT_DIR, `.${key}.active.json`), JSON.stringify({
    reservation_id: reservationId, phase: 'running', transport, role: ROLE, seat_id: seatId,
    seat_reservation_id: seatReservationId, marker_owner_pid: process.pid, owner_liveness: 'alive',
    root_pid: rootPid, root_pgid: rootPid, root_start: rootStart,
    groups: [], captures: 3, missed_snapshots: 0, discovery_failures: 0,
    root_settled: null, swept_at: null, sweep_id: null,
    owner: { pid: process.pid, startedAt: 1 },
    ...patch,
  }))
}

function writeActiveMarker(taskDir, transport, { id = 'd1', reservationId = 'res-1' } = {}) {
  const dirName = transport === HEADLESS_RPC_TRANSPORT ? 'headless-rpc' : 'headless'
  mkdirSync(join(taskDir, dirName), { recursive: true })
  writeFileSync(join(taskDir, dirName, `.${ROLE}.active.json`), JSON.stringify({
    key: ROLE, id, role: ROLE, reservation_id: reservationId, phase: 'running',
  }))
}

function snapshotFor(kind) {
  if (typeof kind === 'function') return kind
  if (kind === 'unknown') return () => ({ ok: false, rows: new Map() })
  const rows = new Map()
  if (kind === 'alive') rows.set(ROOT_PID, { pid: ROOT_PID, ppid: 1, pgid: ROOT_PID, start: ROOT_START, stat: 'S' })
  if (kind === 'unidentified') rows.set(ROOT_PID, { pid: ROOT_PID, ppid: 1, pgid: ROOT_PID, start: 'Mon Jan 01 00:00:00 2001', stat: 'S' })
  return () => ({ ok: true, rows: new Map(rows) })
}

function runHeadless({
  transport = HEADLESS_TRANSPORT,
  ps = 'absent',
  record = true,
  recordSeatId = transport === HEADLESS_RPC_TRANSPORT ? ROLE : 'd1',
  dispatchId = transport === HEADLESS_RPC_TRANSPORT ? ROLE : 'd1',
  patch = {},
  timeoutS = BUDGET_S,
  corruptStore = false,
  captureThrows = false,
  growthThrows = false,
  growth = null,
  logThrowsOn = null,
} = {}) {
  const dir = scratchDir('seat-io-death-')
  const taskDir = join(dir, 'task')
  const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir)
  mkdirSync(returnsDir)
  if (record) writeRecord(taskDir, { transport, seatId: recordSeatId, ...patch })
  if (corruptStore) writeFileSync(join(taskDir, DESCENDANT_DIR), 'not a directory')

  let clock = 0
  let ticks = 0
  const rows = []
  const returnPath = join(returnsDir, `${dispatchId}.${ROLE}.json`)
  let snapshot = snapshotFor(ps)
  // #931: a root that is present while the seat writes and vanishes afterwards —
  // the real sequence, and the only one in which growth has a history to outrank
  // the absence with. A root absent from the FIRST poll has no growth history and
  // still dies immediately, which the third #931 test pins.
  if (typeof ps === 'object' && ps && ps.aliveForPolls != null) {
    let calls = 0
    const present = snapshotFor('alive')
    const gone = snapshotFor('absent')
    snapshot = (...args) => { calls += 1; return calls <= ps.aliveForPolls ? present(...args) : gone(...args) }
  }
  if (captureThrows) {
    mkdirSync(join(taskDir, 'headless'), { recursive: true })
    writeFileSync(join(taskDir, 'headless', '.capture.active.json'), JSON.stringify({ reservation_id: 'marker-1', pid: ROOT_PID, key: 'd1' }))
    const alive = new Map([[ROOT_PID, { pid: ROOT_PID, ppid: 1, pgid: ROOT_PID, start: ROOT_START, stat: 'S' }]])
    alive.has = () => { throw new Error('capture table interrupted') }
    const captureSnapshot = () => ({ ok: true, rows: alive })
    Object.assign(snapshot, { captureSnapshot })
  }

  const fakeTransport = ({ deps }) => ({
    assign: () => ({ id: dispatchId, returnPath }),
    wait: (path, seconds) => {
      const deadline = clock + seconds * 1000
      while (clock < deadline) {
        ticks += 1
        deps.sleep(WAIT_POLL_MS)
      }
      const error = new Error(`transport timeout: seat ${ROLE} produced no envelope at ${path}`)
      error.stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-timeout' : 'headless-timeout'
      error.role = ROLE
      throw error
    },
  })

  const deps = {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    logLine: (_path, row) => {
      if (logThrowsOn && row && row.event === logThrowsOn) throw new Error('journal write failed')
      rows.push(row)
    },
    snapshot: captureThrows ? snapshot.captureSnapshot : snapshot,
    kill: () => {},
    spawnSync: () => ({ status: 1, stdout: '' }),
    headlessIo: transport === HEADLESS_TRANSPORT ? fakeTransport : undefined,
    headlessRpcIo: transport === HEADLESS_RPC_TRANSPORT ? fakeTransport : undefined,
  }
  if (growthThrows || growth) {
    const names = growth?.dirs ? Object.keys(growth.dirs) : ['d1']
    for (const name of names) {
      const streamDir = transport === HEADLESS_RPC_TRANSPORT
        ? join(taskDir, 'headless-rpc', ROLE)
        : join(taskDir, 'headless', name)
      mkdirSync(streamDir, { recursive: true })
      writeFileSync(join(streamDir, 'stream.jsonl'), '{}\n')
    }
  }
  // #931: a transcript whose mtime advances on each probe, so the growth reading
  // and the absent-root reading disagree on the same tick.
  if (growth) {
    // Path-AWARE: each run directory advances independently, so a test can grow a
    // SIBLING seat's transcript while this seat's own stays frozen (#931 must-fix).
    const dirs = growth.dirs ?? { d1: { stopAfter: growth.stopAfter ?? Infinity } }
    const probes = new Map()
    const mtimes = new Map()
    deps.statSync = (path) => {
      const key = Object.keys(dirs).find((name) => String(path).includes(`/${name}/`)) ?? String(path)
      const spec = dirs[key]
      const n = (probes.get(key) ?? 0) + 1
      probes.set(key, n)
      let mtime = mtimes.get(key) ?? 1_000_000
      if (spec && n > 1 && n <= (spec.stopAfter ?? Infinity)) mtime += spec.perProbe ?? 1000
      mtimes.set(key, mtime)
      return { mtimeMs: mtime }
    }
  }

  const crew = {
    claude_bin: '/bin/true',
    members: { [ROLE]: { transport, agent: 'claude', model: 'test-model' } },
  }
  const io = seatIo(crew, { dir, taskDir, returnsDir }, dir, null, {}, {}, deps)
  if (growthThrows) {
    Object.defineProperty(deps, 'statSync', {
      configurable: true,
      get() { throw new Error('growth reading interrupted') },
    })
  }
  const assignment = io.assign({ role: ROLE, briefFile: join(taskDir, 'brief.md') })
  let error = null
  let envelope
  try { envelope = io.wait(assignment.returnPath, timeoutS) } catch (caught) { error = caught }
  return {
    error, envelope, ticks, elapsedMs: clock, budgetMs: timeoutS * 1000, rows,
    diedRow: rows.find((row) => row && row.seat_died != null) ?? null,
    taskDir, cleanup: () => {},
  }
}

function withRun(options, fn) {
  const run = runHeadless(options)
  try { return fn(run) } finally { run.cleanup() }
}

function runReplacementWait({ transport, current = 'alive', timeoutS = 15, firstWaitMs = 0 } = {}) {
  const dir = scratchDir(`seat-root-death-reask-${transport}-`)
  const taskDir = join(dir, 'task')
  const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const logicalId = 'd1'
  const currentRoot = 999202
  const previousRoot = 999201
  const rootFor = (physicalId) => physicalId === 'd2' ? currentRoot : previousRoot
  const startFor = (physicalId) => physicalId === 'd2' ? ROOT_START : 'Sun Aug 30 21:00:00 2026'
  const recordSeatId = (physicalId) => transport === HEADLESS_RPC_TRANSPORT ? ROLE : physicalId
  let physical = 0
  let clock = 0
  let waits = 0
  let polls = 0
  const snapshot = () => {
    const rows = new Map()
    const liveId = current === 'alive' ? 'd2' : 'd1'
    const pid = rootFor(liveId)
    rows.set(pid, { pid, ppid: 1, pgid: pid, start: startFor(liveId), stat: 'S' })
    return { ok: true, rows }
  }
  const fakeTransport = ({ deps }) => ({
    assign(spec) {
      physical += 1
      const physicalId = `d${physical}`
      const reservationId = `res-${physicalId}`
      writeNamedRecord(taskDir, {
        transport, seatId: recordSeatId(physicalId), reservationId: `desc-${physicalId}`,
        seatReservationId: reservationId, rootPid: rootFor(physicalId), rootStart: startFor(physicalId),
      })
      return {
        id: spec?.reask?.id || physicalId, physicalId, reservation_id: reservationId,
        returnPath: spec?.reask?.returnPath || join(returnsDir, `${logicalId}.${ROLE}.json`),
      }
    },
    wait: (_path, seconds) => {
      waits += 1
      if (waits === 1) {
        while (clock < firstWaitMs) deps.sleep(Math.min(WAIT_POLL_MS, firstWaitMs - clock))
        const error = new Error('unusable envelope from first physical run')
        error.stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-parse-error' : 'headless-parse-error'
        error.role = ROLE
        error.raw = '{broken}'
        throw error
      }
      const deadline = clock + seconds * 1000
      while (clock < deadline) {
        polls += 1
        deps.sleep(WAIT_POLL_MS)
      }
      const error = new Error(`transport timeout after ${seconds}s`)
      error.stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-timeout' : 'headless-timeout'
      error.role = ROLE
      throw error
    },
  })
  const rows = []
  const deps = {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    logLine: (_path, row) => rows.push(row),
    snapshot,
    kill: () => {},
    spawnSync: () => ({ status: 1, stdout: '' }),
    headlessIo: transport === HEADLESS_TRANSPORT ? fakeTransport : undefined,
    headlessRpcIo: transport === HEADLESS_RPC_TRANSPORT ? fakeTransport : undefined,
  }
  const crew = { claude_bin: '/bin/true', members: { [ROLE]: { transport, agent: 'claude', model: 'test-model' } } }
  const io = seatIo(crew, { dir, taskDir, returnsDir }, dir, null, {}, {}, deps)
  const assignment = io.assign({ role: ROLE, briefFile: join(taskDir, 'brief.md') })
  let error = null
  try { io.wait(assignment.returnPath, timeoutS) } catch (caught) { error = caught }
  return {
    error, polls, waits, elapsedMs: clock, budgetMs: timeoutS * 1000, rows,
    reaskPath: join(returnsDir, `${logicalId}.reask.${ROLE}.json`),
    diedRow: rows.find((row) => row && row.seat_died != null) ?? null,
  }
}

test('a dead worker root ends one poll for both headless transports and carries reclaim evidence', () => {
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    withRun({ transport, ps: 'absent' }, (run) => {
      assert.equal(run.ticks, 1)
      assert.equal(run.elapsedMs, 0)
      assert.equal(run.error?.stage, SEAT_DIED_STAGE)
      assert.equal(run.error?.role, ROLE)
      assert.equal(run.error?.reclaim?.root_pid, ROOT_PID)
      assert.equal(run.error?.reclaim?.root_pgid, ROOT_PID)
      assert.equal(run.error?.reclaim?.root_liveness, 'dead')
      assert.equal(run.error?.reclaim?.reason, 'probe-dead')
      assert.match(run.error?.message ?? '', /worker root 999001 \(pgid 999001\) is gone/)
    })
  }
})

test('a measured settle is death even when the current ps table is unavailable', () => {
  for (const rootSettled of ['already-dead', 'proven']) {
    withRun({ ps: 'unknown', patch: { root_settled: rootSettled } }, (run) => {
      assert.equal(run.error?.stage, SEAT_DIED_STAGE)
      assert.equal(run.error?.reclaim?.root_settled, rootSettled)
      assert.equal(run.error?.reclaim?.reason, 'probe-dead')
    })
  }
})

test('alive, unidentified, and unusable ps readings are absences that keep the transport outcome', () => {
  for (const ps of ['alive', 'unidentified', 'unknown']) {
    withRun({ ps }, (run) => {
      assert.equal(run.elapsedMs, run.budgetMs + RETRY_WINDOW_MS)
      assert.equal(run.ticks, (run.budgetMs + RETRY_WINDOW_MS) / WAIT_POLL_MS)
      assert.notEqual(run.error?.stage, SEAT_DIED_STAGE)
      assert.equal(run.diedRow, null)
    })
  }
})

test('a missing current record and a different dispatch record never kill this wait', () => {
  withRun({ record: false }, (run) => {
    assert.equal(run.elapsedMs, run.budgetMs + RETRY_WINDOW_MS)
    assert.notEqual(run.error?.stage, SEAT_DIED_STAGE)
    assert.equal(run.diedRow, null)
  })
  withRun({ recordSeatId: 'd1', dispatchId: 'd2' }, (run) => {
    assert.equal(run.elapsedMs, run.budgetMs + RETRY_WINDOW_MS)
    assert.notEqual(run.error?.stage, SEAT_DIED_STAGE)
    assert.equal(run.diedRow, null)
  })
})

test('a stale RPC reservation never kills its live replacement', () => {
  const dir = scratchDir('seat-root-death-rpc-stale-')
  const taskDir = join(dir, 'task')
  mkdirSync(taskDir)
  writeNamedRecord(taskDir, {
    transport: HEADLESS_RPC_TRANSPORT, seatId: ROLE, reservationId: 'desc-old', seatReservationId: 'res-old', rootPid: 999101,
    rootStart: 'Sun Aug 30 21:00:00 2026',
  })
  writeNamedRecord(taskDir, {
    transport: HEADLESS_RPC_TRANSPORT, seatId: ROLE, reservationId: 'desc-current', seatReservationId: 'res-current', rootPid: 999102,
    rootStart: ROOT_START,
  })
  writeActiveMarker(taskDir, HEADLESS_RPC_TRANSPORT, { id: 'd2', reservationId: 'res-current' })
  const rows = new Map([[999102, { pid: 999102, ppid: 1, pgid: 999102, start: ROOT_START, stat: 'S' }]])
  assert.equal(seatRootDeath({
    taskDir, transport: HEADLESS_RPC_TRANSPORT, role: ROLE, seatId: ROLE,
    snapshot: { ok: true, rows }, deps: { kill: () => {} },
  }), null)
  rows.clear()
  const death = seatRootDeath({
    taskDir, transport: HEADLESS_RPC_TRANSPORT, role: ROLE, seatId: ROLE,
    snapshot: { ok: true, rows }, deps: { kill: () => {} },
  })
  assert.equal(death?.root_pid, 999102)
  assert.equal(death?.reservation_id, 'desc-current')
})

test('replacement waits bind the current physical worker, not the logical assignment id', () => {
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const liveReplacement = runReplacementWait({ transport, current: 'alive' })
    assert.equal(liveReplacement.elapsedMs, liveReplacement.budgetMs)
    assert.equal(liveReplacement.polls, 3)
    assert.notEqual(liveReplacement.error?.stage, SEAT_DIED_STAGE)
    assert.equal(liveReplacement.diedRow, null)

    const deadReplacement = runReplacementWait({ transport, current: 'dead' })
    assert.equal(deadReplacement.elapsedMs, 0)
    assert.equal(deadReplacement.polls, 1)
    assert.equal(deadReplacement.error?.stage, SEAT_DIED_STAGE)
    assert.equal(deadReplacement.error?.reclaim?.root_pid, 999202)
    assert.equal(deadReplacement.error?.reclaim?.reservation_id, 'desc-d2')
    assert.ok(deadReplacement.diedRow, JSON.stringify(deadReplacement))
  }
})

test('a delayed first parse gives replacement death its own wait budget and path', () => {
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const run = runReplacementWait({ transport, current: 'dead', timeoutS: 900, firstWaitMs: 599_000 })
    assert.equal(run.elapsedMs, 599_000)
    assert.equal(run.error?.stage, SEAT_DIED_STAGE)
    assert.equal(run.error?.reclaim?.root_pid, 999202)
    assert.equal(run.diedRow?.waited_ms, 0)
    assert.equal(run.diedRow?.budget_ms, 600_000)
    assert.equal(run.diedRow?.wasted_ms, 600_000)
    assert.equal(run.diedRow?.returnPath, run.reaskPath)
    assert.match(run.error?.message ?? '', new RegExp(`no envelope arrived at ${run.reaskPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`))
  }
})

test('seatRootDeath is inert for pane, absent, corrupt, and missing-root records', () => {
  const dir = scratchDir('seat-root-death-')
  const taskDir = join(dir, 'task')
  mkdirSync(taskDir)
  assert.equal(seatRootDeath({ taskDir, transport: 'pane', snapshot: { ok: true, rows: new Map() } }), null)
  assert.equal(seatRootDeath({ taskDir: join(dir, 'missing'), transport: HEADLESS_TRANSPORT }), null)
  mkdirSync(join(taskDir, DESCENDANT_DIR), { recursive: true })
  writeFileSync(join(taskDir, DESCENDANT_DIR, '.headless__d1__bad.active.json'), '{')
  assert.doesNotThrow(() => seatRootDeath({ taskDir, transport: HEADLESS_TRANSPORT, snapshot: { ok: true, rows: new Map() } }))
  assert.equal(seatRootDeath({ taskDir, transport: HEADLESS_TRANSPORT, snapshot: { ok: true, rows: new Map() } }), null)
  writeRecord(taskDir, { root_pid: null })
  assert.equal(seatRootDeath({ taskDir, transport: HEADLESS_TRANSPORT, snapshot: { ok: true, rows: new Map() } }), null)
})

test('the seat_died row measures wait budget and leaves final turn usage unknown', () => {
  for (const [transport, reason] of [
    [HEADLESS_TRANSPORT, 'headless-run-not-recorded'],
    [HEADLESS_RPC_TRANSPORT, 'rpc-turn-not-finished'],
  ]) {
    withRun({ transport, ps: 'absent' }, (run) => {
      const row = run.diedRow
      assert.ok(row)
      assert.equal(row.waited_ms, run.elapsedMs)
      assert.equal(row.budget_ms, run.budgetMs)
      assert.equal(row.wasted_ms, row.budget_ms - row.waited_ms)
      assert.ok(row.wasted_ms > 0)
      assert.equal(row.final_turn_usage, null)
      assert.equal(row.final_turn_usage_reason, reason)
    })
  }
})

test('diagnostic failures remain load-bearing only for evidence, not for the requested delay', () => {
  withRun({ ps: 'alive', captureThrows: true }, (run) => {
    assert.equal(run.elapsedMs, run.budgetMs + RETRY_WINDOW_MS)
    assert.notEqual(run.error?.stage, SEAT_DIED_STAGE)
  })
  withRun({ ps: 'alive', growthThrows: true }, (run) => {
    assert.equal(run.elapsedMs, run.budgetMs + RETRY_WINDOW_MS)
    assert.notEqual(run.error?.stage, SEAT_DIED_STAGE)
  })
  withRun({ ps: 'absent', record: false, corruptStore: true }, (run) => {
    assert.equal(run.elapsedMs, run.budgetMs + RETRY_WINDOW_MS)
    assert.notEqual(run.error?.stage, SEAT_DIED_STAGE)
  })
})

test('the death path never needs worker binary resolution', () => {
  withRun({ ps: 'absent' }, (run) => {
    assert.equal(run.error?.stage, SEAT_DIED_STAGE)
    assert.equal(readFileSync(recordPath(run.taskDir, HEADLESS_TRANSPORT, 'd1'), 'utf8').includes('res-1'), true)
  })
})

// #931. Six lanes died on 2026-09-05 to a worker root that vanished from ps while
// its seat was still writing: `growth: true` was journaled 170ms before the root
// probed absent, four of them at the lead consult after `scope-gate:r1`, and in two
// of them a VALID ENVELOPE was already on disk when the driver reported that none
// had arrived. Both readings are taken on the same tick of the sleep hook; only the
// transcript observed the seat itself.
//
// `ps: 'absent'` alone ends the wait in one poll — the first test in this file pins
// that. These runs keep it absent and let the transcript advance.

// Mutation killed: dropping the growthOutranksRootDeath guard, so an absent root
// throws while the transcript is still advancing.
test('#931 a growing transcript outranks an absent worker root and the wait survives', () => {
  withRun({ ps: { aliveForPolls: 3 }, growth: { stopAfter: Infinity } }, (run) => {
    // The contrast is with the first test in this file: an absent root with no
    // growth ends the wait at ticks === 1, elapsedMs === 0. Here the wait runs its
    // whole budget instead, because the seat kept writing the entire time.
    assert.equal(run.elapsedMs, run.budgetMs)
    assert.ok(run.ticks > 1, 'the wait must not end on the first poll the way an unprotected absent root does')
    const suppressed = run.rows.filter((row) => row && row.event === ROOT_DEATH_SUPPRESSED_EVENT)
    assert.ok(suppressed.length > 0, 'the disagreement must be journaled, not silently swallowed')
    assert.equal(suppressed[0].reason, 'probe-dead')
    assert.equal(suppressed[0].window_ms, ROOT_DEATH_GROWTH_WINDOW_MS)
    assert.equal(suppressed[0].root_pid, ROOT_PID)
  })
})

// Mutation killed: widening the window to Infinity, which would make a genuinely
// dead seat wait out its whole budget. Growth stops, the window lapses, it dies.
test('#931 a seat whose transcript stops growing still dies once the window lapses', () => {
  withRun({ ps: { aliveForPolls: 3 }, growth: { stopAfter: 16 } }, (run) => {
    assert.equal(run.error?.stage, SEAT_DIED_STAGE)
    assert.equal(run.error?.reclaim?.root_pid, ROOT_PID)
    // The window is what makes this a DELAY and not an amnesty. Growth stops at
    // probe 4, so the death must fire about one window later and well inside the
    // budget — an unbounded window would suppress it until the wait timed out,
    // which is a seat nobody ever notices is dead.
    assert.ok(run.elapsedMs > 0, 'the seat should survive at least one poll before dying')
    // Pins the WINDOW, not merely "inside the budget": growth stops after probe 4,
    // so the death must land within one window plus a poll of that point. A window
    // widened past this fails here, which is what makes the M2 mutation die.
    // Pins the WINDOW, not merely "somewhere inside the budget": the death must
    // land within one window of the LAST suppression. A window widened past this
    // suppresses until the wait times out instead, which is the M2 mutation.
    const suppressed = run.rows.filter((row) => row && row.event === ROOT_DEATH_SUPPRESSED_EVENT)
    assert.ok(suppressed.length > 0, 'growth must have protected the seat before it stopped')
    const lastSuppressedAt = suppressed[suppressed.length - 1].probed_at_ms
    assert.ok(
      run.elapsedMs - lastSuppressedAt <= ROOT_DEATH_GROWTH_WINDOW_MS + WAIT_POLL_MS,
      `death must fire within one window of the last suppression, got ${run.elapsedMs - lastSuppressedAt}`,
    )
    assert.ok(run.elapsedMs < run.budgetMs, 'the death must land inside the budget, not as a timeout')
  })
})

// Mutation killed: treating a null grewAt as recent growth. A seat that never wrote
// anything measured NOTHING, and an absence outranks nothing.
test('#931 a seat that never wrote a transcript is unprotected and dies as before', () => {
  withRun({ ps: 'absent' }, (run) => {
    assert.equal(run.error?.stage, SEAT_DIED_STAGE)
    assert.equal(run.rows.filter((row) => row && row.event === ROOT_DEATH_SUPPRESSED_EVENT).length, 0)
  })
})

// #931 must-fix from sol's review. `headlessStreamPaths` enumerates EVERY
// `headless/d<N>` directory — correct for the lane heartbeat, catastrophic as
// authority over one seat's death: a sibling seat still writing would renew a
// dead seat's protection forever, turning the bounded window into an amnesty and
// hiding the death behind a timeout. The suppression reads only this seat's dir.
// Mutation killed: reading headlessStreamPaths instead of seatStreamPaths.
test('#931 a sibling seat\'s growth never protects this seat from its own root death', () => {
  withRun({
    ps: { aliveForPolls: 3 },
    // d1 is THIS seat and is frozen; d2 is a sibling writing throughout.
    growth: { dirs: { d1: { stopAfter: 0 }, d2: { stopAfter: Infinity } } },
  }, (run) => {
    assert.equal(run.error?.stage, SEAT_DIED_STAGE)
    assert.equal(run.error?.reclaim?.root_pid, ROOT_PID)
    assert.equal(run.rows.filter((row) => row && row.event === ROOT_DEATH_SUPPRESSED_EVENT).length, 0)
  })
})

// #931 must-fix from sol's review. Instrumentation is never load-bearing: a
// journal that cannot be written must not convert a suppressed death into a
// thrown one, which is a worse outcome than the defect being fixed.
// Mutation killed: removing the try/catch around the suppression row.
test('#931 a throwing journal does not turn a suppressed death into a thrown one', () => {
  const run = runHeadless({ ps: { aliveForPolls: 3 }, growth: { stopAfter: Infinity } })
  // Re-run with a logger that throws only for the suppression row.
  withRun({
    ps: { aliveForPolls: 3 },
    growth: { stopAfter: Infinity },
    logThrowsOn: ROOT_DEATH_SUPPRESSED_EVENT,
  }, (thrown) => {
    // The wait must be byte-for-byte the same length as with a working journal:
    // the suppression still happened, only its evidence was lost.
    assert.equal(thrown.elapsedMs, run.elapsedMs, 'a throwing journal must not change the wait')
    assert.equal(thrown.elapsedMs, run.budgetMs, 'and the seat must still survive its whole budget')
  })
})
