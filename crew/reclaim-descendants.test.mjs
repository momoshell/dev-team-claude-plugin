import test, { after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'

import {
  DESCENDANT_DIR, DESCENDANT_MAX_ANCHORS, DESCENDANT_STORE_DIRS,
  escapedDescendants, psSnapshot, reclaimDescendants, seatIo, settleSeatRoots,
  settleSeatTeardown, statIsZombie, verifyGroup, descendantCapture,
} from './seat-io.mjs'
import { bootCmd, runCmd, teardownCore } from './crew.mjs'
import { openLedger } from '../scripts/factory/ledger.mjs'

const LEDGER_SANDBOX = mkdtempSync(join(tmpdir(), 'b136-ledger-sandbox-'))
const LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX // #477: module scope, before any test runs
after(() => {
  if (LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX_PREVIOUS
  rmSync(LEDGER_SANDBOX, { recursive: true, force: true })
})

const tempDirs = []
const task = () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-descendants-test-'))
  tempDirs.push(root)
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
  return taskDir
}
const snapshot = (rows) => ({ ok: true, rows: new Map(rows.map((row) => [row.pid, row])) })
const marker = (taskDir, reservationId, role = 'builder', seatId = 'd1', rootPid = process.pid, storeDirName = 'headless') => {
  const root = join(taskDir, storeDirName)
  const dir = join(root, seatId)
  mkdirSync(dir, { recursive: true })
  const value = {
    reservation_id: reservationId, key: role, phase: 'running',
    role, id: seatId, dir, pid: rootPid,
    owner: { pid: process.pid, startedAt: Date.now() },
  }
  writeFileSync(join(root, `.${role}.active.json`), JSON.stringify(value))
}
const records = (taskDir) => {
  const dir = join(taskDir, DESCENDANT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.active.json')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}
const writeRecord = (taskDir, overrides = {}) => {
  const dir = join(taskDir, DESCENDANT_DIR)
  mkdirSync(dir, { recursive: true })
  const key = overrides.key || `headless__d1__${overrides.seat_reservation_id || 'seat-1'}`
  const record = {
    reservation_id: overrides.reservation_id || `record-${key}`,
    key, phase: 'running', owner: { pid: process.pid, startedAt: Date.now() },
    transport: 'headless-json', role: 'builder', seat_id: 'd1', seat_reservation_id: 'seat-1',
    marker_owner_pid: process.pid, captures: 3, missed_snapshots: 0, discovery_failures: 0,
    root_pid: 999999, root_pgid: 999999, root_start: 'old-root', groups: [],
    root_settled: null, swept_at: null, sweep_id: null, ...overrides,
  }
  const path = join(dir, `.${key}.active.json`)
  writeFileSync(path, JSON.stringify(record))
  return { path, record }
}
const groupGone = (pgid) => {
  try { process.kill(-pgid, 0); return false } catch (err) { return err?.code === 'ESRCH' }
}
const killGroup = (pgid) => { try { process.kill(-pgid, 'SIGKILL') } catch {} }
// process.kill(pid, 0) still succeeds for a ZOMBIE, so it cannot answer "is this
// root really gone". ps can: an unreaped row is present with stat Z.
const rootAbsent = (pid) => {
  const ps = spawnSync('ps', ['-eo', 'pid='], { encoding: 'utf8' })
  if (ps.status !== 0) return false
  for (const line of String(ps.stdout || '').split(/\r?\n/)) {
    if (Number(line.trim()) === pid) return false
  }
  return true
}
// A detached child calls setsid() ITSELF after fork, so it is not yet observable
// as escaped at the instant spawn() hands back its pid. Measured on a Linux CI
// runner: the capture ran first and recorded nothing, so the reclaim had nothing
// to reclaim and the group stayed alive (ps said "Ssl", not a zombie). Wait for
// the row to exist in its own group under the root before capturing.
const escapedVisible = (seat) => {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
  for (const line of String(ps.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    if (Number(m[1]) !== seat.escapedPgid) continue
    return Number(m[3]) === seat.escapedPgid && Number(m[2]) === seat.rootPid
  }
  return false
}
const ROOT_SCRIPT = [
  "const { spawn } = require('node:child_process')",
  "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
  'c.unref()',
  "process.stdout.write(String(c.pid) + '\\n')",
  'setInterval(() => {}, 1000)',
].join('; ')
async function realSeat() {
  const child = spawn(process.execPath, ['-e', ROOT_SCRIPT], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let text = ''
  const escaped = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000)
    child.stdout.on('data', (chunk) => {
      text += String(chunk)
      if (text.includes('\n')) { clearTimeout(timer); resolve(Number(text.trim())) }
    })
    child.once('error', () => { clearTimeout(timer); resolve(null) })
  })
  return { rootPid: child.pid, escapedPgid: escaped, child }
}


afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

test('psSnapshot returns a measured process row with an opaque start string', () => {
  const snap = psSnapshot()
  assert.equal(snap.ok, true)
  const row = snap.rows.get(process.pid)
  assert.ok(row)
  assert.equal(typeof row.start, 'string')
  assert.ok(row.start.trim())
  assert.ok(Number.isSafeInteger(row.ppid))
  assert.ok(Number.isSafeInteger(row.pgid))
})

test('psSnapshot reads the ps state column and keeps lstart last', () => {
  const calls = []
  const stdout = [
    '    41       1      41 Zs   Tue Aug 19 10:04:47 2026',
    '    43      41      42 Ss   Tue Aug 19 10:04:48 2026',
    '',
  ].join('\n')
  const out = psSnapshot({
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options })
      return { status: 0, stdout }
    },
  })
  assert.equal(out.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'ps')
  assert.equal(calls[0].args[0], '-eo')
  assert.equal(calls[0].args[1], 'pid=,ppid=,pgid=,stat=,lstart=')
  assert.equal(out.rows.get(41).stat, 'Zs')
  assert.equal(out.rows.get(41).start, 'Tue Aug 19 10:04:47 2026')
  assert.deepEqual({ ppid: out.rows.get(43).ppid, pgid: out.rows.get(43).pgid, stat: out.rows.get(43).stat }, {
    ppid: 41, pgid: 42, stat: 'Ss',
  })
})

test('a ps that cannot print stat still yields a usable snapshot', () => {
  const formats = []
  const stdout = '    41       1      41 Tue Aug 19 10:04:47 2026\n'
  const out = psSnapshot({
    spawnSync: (_cmd, args) => {
      const format = String(args[1])
      formats.push(format)
      if (format.includes('stat=')) return { status: 1, stdout: '', stderr: 'ps: illegal argument' }
      return { status: 0, stdout }
    },
  })
  assert.deepEqual(formats, ['pid=,ppid=,pgid=,stat=,lstart=', 'pid=,ppid=,pgid=,lstart='])
  assert.equal(out.ok, true)
  assert.equal(out.rows.get(41).stat, null)
  assert.equal(statIsZombie(out.rows.get(41).stat), false)
})

test('a zombie root sweeps the escaped group instead of deferring as retryable', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 41, root_pgid: 41, root_start: 'root',
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  let groupAlive = true
  const calls = []
  const events = []
  const snapshotFor = () => snapshot([
    { pid: 41, ppid: 1, pgid: 41, start: 'root', stat: 'Zs' },
    ...(groupAlive ? [{ pid: 43, ppid: 41, pgid: 42, start: 'child', stat: 'Ss' }] : []),
  ])
  const kill = (pid, signal) => {
    calls.push([pid, signal])
    if (pid === -42 && signal === 'SIGTERM') { groupAlive = false; return true }
    if (pid === -42 && signal === 0 && !groupAlive) {
      const error = new Error('gone'); error.code = 'ESRCH'; throw error
    }
    return true
  }
  reclaimDescendants({ taskDir, log: (row) => events.push(row), emit: () => true, deps: { snapshot: snapshotFor, kill, sleep: () => {} } })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.notEqual(row.reason, 'root-alive')
  assert.equal(row.root_liveness, 'dead')
  assert.equal(row.signalled, 1)
  assert.ok(calls.some(([pid, signal]) => pid === -42 && signal === 'SIGTERM'))
})

test('a running root is still refused exactly as today', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 41, root_pgid: 41, root_start: 'root',
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const calls = []
  const events = []
  reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: {
      snapshot: () => snapshot([
        { pid: 41, ppid: 1, pgid: 41, start: 'root', stat: 'Ss' },
        { pid: 43, ppid: 41, pgid: 42, start: 'child', stat: 'Ss' },
      ]),
      kill: (pid, signal) => { calls.push([pid, signal]); return true }, sleep: () => {},
    },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.equal(row.reason, 'root-alive')
  assert.equal(row.signalled, 0)
  assert.equal(calls.some(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL'), false)
})

test('a zombie root settles its live group peers and only then reads already-dead', () => {
  const noPeers = task()
  writeRecord(noPeers, { root_pid: 41, root_pgid: 41, root_start: 'root' })
  const noPeerCalls = []
  const noPeerResult = settleSeatRoots({
    taskDir: noPeers, log: () => {},
    deps: {
      snapshot: () => snapshot([{ pid: 41, ppid: 1, pgid: 41, start: 'root', stat: 'Zs' }]),
      kill: (pid, signal) => { noPeerCalls.push([pid, signal]); return true }, sleep: () => {},
    },
  })
  assert.equal(noPeerResult.already_dead, 1)
  assert.equal(noPeerCalls.some(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL'), false)
  assert.equal(records(noPeers)[0].root_settled, 'already-dead')
  assert.equal(records(noPeers)[0].root_liveness, 'dead')

  const withPeer = task()
  writeRecord(withPeer, { root_pid: 41, root_pgid: 41, root_start: 'root' })
  let peerAlive = true
  const peerCalls = []
  const peerResult = settleSeatRoots({
    taskDir: withPeer, log: () => {},
    deps: {
      snapshot: () => snapshot([
        { pid: 41, ppid: 1, pgid: 41, start: 'root', stat: 'Zs' },
        ...(peerAlive ? [{ pid: 44, ppid: 1, pgid: 41, start: 'peer', stat: 'Ss' }] : []),
      ]),
      kill: (pid, signal) => {
        peerCalls.push([pid, signal])
        if (pid === -41 && signal === 'SIGTERM') peerAlive = false
        return true
      },
      sleep: () => {},
    },
  })
  assert.equal(peerResult.settled, 1)
  assert.ok(peerCalls.some(([pid, signal]) => pid === -41 && signal === 'SIGTERM'))
  assert.equal(records(withPeer)[0].root_settled, 'proven')
  assert.equal(records(withPeer)[0].root_liveness, 'dead')
})

test('a dead anchor binds the group but never proves it dead', () => {
  const candidate = { pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }
  const deps = { kill: () => {} }
  const dead = verifyGroup(candidate, snapshot([{ pid: 43, ppid: 1, pgid: 42, start: 'child', stat: 'Z' }]), deps)
  assert.deepEqual({ signalable: dead.signalable, liveness: dead.liveness }, { signalable: false, liveness: 'dead' })
  const mixed = verifyGroup(candidate, snapshot([
    { pid: 43, ppid: 1, pgid: 42, start: 'child', stat: 'Z' },
    { pid: 45, ppid: 1, pgid: 42, start: 'sibling', stat: 'Ss' },
  ]), deps)
  assert.deepEqual({ signalable: mixed.signalable, liveness: mixed.liveness }, { signalable: true, liveness: 'alive' })
  const live = verifyGroup(candidate, snapshot([{ pid: 43, ppid: 1, pgid: 42, start: 'child', stat: 'Ss' }]), deps)
  assert.deepEqual({ signalable: live.signalable, liveness: live.liveness }, { signalable: true, liveness: 'alive' })
  const mismatch = verifyGroup(candidate, snapshot([{ pid: 43, ppid: 1, pgid: 42, start: 'other', stat: 'Ss' }]), deps)
  assert.equal(mismatch.reason, 'evidence-mismatch')
})

test('escapedDescendants never captures an unreaped row as a live anchor', () => {
  const out = escapedDescendants(snapshot([
    { pid: 10, ppid: 1, pgid: 10, start: 'root', stat: 'Ss' },
    { pid: 11, ppid: 10, pgid: 11, start: 'zombie-escape', stat: 'Z' },
    { pid: 12, ppid: 10, pgid: 12, start: 'live-escape', stat: 'Ss' },
  ]), 10)
  assert.deepEqual(out, [{ pid: 12, pgid: 12, start: 'live-escape' }])
})

test('a real zombie is measured dead by both ps probes', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1)
    child.kill('SIGKILL')
    let row = null
    const deadline = Date.now() + 5000
    const wait = (ms) => {
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, ms)
    }
    while (Date.now() < deadline) {
      row = psSnapshot().rows.get(child.pid) || null
      if (row && statIsZombie(row.stat)) break
      wait(25)
    }
    assert.ok(row, `the killed child pid ${child.pid} disappeared before its zombie row was measured`)
    assert.equal(statIsZombie(row.stat), true, `measured stat=${JSON.stringify(row.stat)}`)
    assert.ok(psSnapshot().rows.has(child.pid), `the killed child pid ${child.pid} was not still listed by ps`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  }
})

test('a cross-uid EPERM under a dead root stays unproven and signals nothing', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 999999, root_pgid: 999999, root_start: 'gone',
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const calls = []
  const events = []
  const kill = (pid, signal) => {
    calls.push([pid, signal])
    if (pid < -1) { const error = new Error('permission'); error.code = 'EPERM'; throw error }
    return true
  }
  reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: { snapshot: () => snapshot([{ pid: 43, ppid: 1, pgid: 42, start: 'child', stat: 'Ss' }]), kill, sleep: () => {} },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.ok(calls.some(([pid, signal]) => pid === -42 && signal === 0))
  assert.equal(row.reclaimed, 0)
  assert.equal(row.signalled, 0)
  assert.ok(row.probe_unknown >= 1)
  assert.equal(row.outcome, 'unproven')
  assert.equal(row.reason, 'probe-unknown')
})

test('the run-end reclaim settles seat roots before it can stamp the record swept', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 41, root_pgid: 41, root_start: 'root',
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const events = []
  const calls = []
  let peerAlive = true
  let escapedAlive = true
  const snapshotFor = () => snapshot([
    { pid: 41, ppid: 1, pgid: 41, start: 'root', stat: 'Zs' },
    ...(peerAlive ? [{ pid: 44, ppid: 1, pgid: 41, start: 'peer', stat: 'Ss' }] : []),
    ...(escapedAlive ? [{ pid: 43, ppid: 41, pgid: 42, start: 'child', stat: 'Ss' }] : []),
  ])
  const kill = (pid, signal) => {
    calls.push([pid, signal])
    if (pid === -41 && signal === 'SIGTERM') peerAlive = false
    if (pid === -42 && signal === 'SIGTERM') escapedAlive = false
    if (signal === 0 && pid === -41 && !peerAlive) { const error = new Error('gone'); error.code = 'ESRCH'; throw error }
    if (signal === 0 && pid === -42 && !escapedAlive) { const error = new Error('gone'); error.code = 'ESRCH'; throw error }
    return true
  }
  const io = seatIo({}, { taskDir, dir: join(taskDir, '..') }, join(taskDir, '..'), null, {}, {}, {
    logLine: (_path, row) => events.push(row),
    snapshot: snapshotFor, kill, sleep: () => {},
  })
  io.reclaimDescendants()
  const settleAt = events.findIndex((row) => row?.event === 'seat-root-settle')
  const reclaimAt = events.findIndex((row) => row?.event === 'descendant-reclaim')
  assert.ok(settleAt >= 0)
  assert.ok(reclaimAt >= 0)
  assert.ok(settleAt < reclaimAt)
  const rootTerm = calls.findIndex(([pid, signal]) => pid === -41 && signal === 'SIGTERM')
  const escapedProbe = calls.findIndex(([pid]) => pid === -42)
  assert.ok(rootTerm >= 0)
  assert.ok(escapedProbe < 0 || rootTerm < escapedProbe)
  assert.equal(events[settleAt].root_settled, 'proven')
  assert.equal(events[settleAt].root_liveness, 'dead')
  assert.equal(records(taskDir)[0].root_settled, 'proven')
})

test('escapedDescendants walks strict descendants and excludes the root group', () => {
  const snap = snapshot([
    { pid: 10, ppid: 1, pgid: 10, start: 'root' },
    { pid: 11, ppid: 10, pgid: 10, start: 'same' },
    { pid: 12, ppid: 11, pgid: 12, start: 'child' },
    { pid: 13, ppid: 12, pgid: 13, start: 'grandchild' },
  ])
  assert.deepEqual(escapedDescendants(snap, 10), [
    { pid: 12, pgid: 12, start: 'child' },
    { pid: 13, pgid: 13, start: 'grandchild' },
  ])
  assert.deepEqual(escapedDescendants({ ok: false, rows: new Map() }, 10), [])
})

test('verifyGroup requires the candidate pgid and start-time identity', () => {
  const snap = snapshot([{ pid: 22, ppid: 1, pgid: 22, start: 'opaque-start' }])
  const good = verifyGroup({ pgid: 22, anchors: [{ pid: 22, pgid: 22, start: 'opaque-start' }] }, snap, { kill: () => {} })
  assert.equal(good.signalable, true)
  const stale = verifyGroup({ pgid: 22, anchors: [{ pid: 22, pgid: 22, start: 'old' }] }, snap, { kill: () => {} })
  assert.deepEqual({ signalable: stale.signalable, liveness: stale.liveness, reason: stale.reason }, {
    signalable: false, liveness: 'alive', reason: 'evidence-mismatch',
  })
})

test('capture persists one record per seat incarnation and bounds anchors', () => {
  const taskDir = task()
  marker(taskDir, 'incarnation-a')
  let round = 0
  const capture = descendantCapture({
    taskDir, log: () => {},
    deps: { snapshot: () => {
      round += 1
      return snapshot([
        { pid: process.pid, ppid: 1, pgid: process.pid, start: 'root' },
        { pid: 5000 + round, ppid: process.pid, pgid: 9000, start: `anchor-${round}` },
      ])
    } },
  })
  for (let i = 0; i < DESCENDANT_MAX_ANCHORS + 4; i += 1) capture.round()
  marker(taskDir, 'incarnation-b')
  capture.round(true)
  const found = records(taskDir)
  assert.equal(found.length, 2)
  assert.equal(found.filter((record) => record.seat_reservation_id === 'incarnation-a')[0].groups[0].anchors.length, DESCENDANT_MAX_ANCHORS)
  assert.ok(found.some((record) => record.seat_reservation_id === 'incarnation-b'))
})

test('failed snapshots increment durable per-incarnation coverage counters', () => {
  const taskDir = task()
  marker(taskDir, 'res-1')
  const rows = [
    { pid: process.pid, ppid: 1, pgid: process.pid, start: 'root' },
    { pid: 6001, ppid: process.pid, pgid: 6001, start: 'child' },
  ]
  descendantCapture({ taskDir, log: () => {}, deps: { snapshot: () => snapshot(rows) } }).round(true)
  descendantCapture({ taskDir, log: () => {}, deps: { snapshot: () => ({ ok: false, rows: new Map() }) } }).round()
  assert.equal(records(taskDir)[0].missed_snapshots, 1)
  assert.equal(records(taskDir)[0].captures, 1)
})

test('no descendant store is created by root settlement or a zero sweep', () => {
  const taskDir = join(task(), 'absent')
  const journal = []
  const emitted = []
  const roots = settleSeatRoots({ taskDir, log: (row) => journal.push(row) })
  const sweep = reclaimDescendants({ taskDir, log: (row) => journal.push(row), emit: (event) => { emitted.push(event); return true } })
  assert.equal(roots.records, 0)
  assert.equal(sweep.records, 0)
  assert.equal(emitted.length, 0)
  assert.equal(existsSync(join(taskDir, DESCENDANT_DIR)), false)
  assert.equal(journal.find((row) => row.event === 'descendant-reclaim-sweep').records, 0)
})

test('a dead-root zero-candidate record is journalled and stamped terminal', () => {
  const taskDir = task()
  const dir = join(taskDir, DESCENDANT_DIR)
  mkdirSync(dir, { recursive: true })
  const record = {
    reservation_id: 'record-1', key: 'headless__d1__seat-1', phase: 'running',
    owner: { pid: process.pid, startedAt: Date.now() }, transport: 'headless-json',
    role: 'builder', seat_id: 'd1', seat_reservation_id: 'seat-1', marker_owner_pid: process.pid,
    root_pid: 999999, root_pgid: 999999, root_start: 'old', groups: [], captures: 2,
    missed_snapshots: 0, discovery_failures: 0, root_settled: null, swept_at: null,
  }
  const path = join(dir, '.headless__d1__seat-1.active.json')
  writeFileSync(path, JSON.stringify(record))
  const events = []
  const summary = reclaimDescendants({ taskDir, log: (row) => events.push(row), emit: () => true, deps: { snapshot: () => snapshot([]) } })
  assert.equal(summary.recorded, 1)
  assert.equal(events.filter((row) => row.event === 'descendant-reclaim').length, 1)
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).swept_at)
})

test('settleSeatTeardown keeps the slice-1 plain-io shape', () => {
  const summary = settleSeatTeardown({
    teardown: () => [{ role: 'builder', outcome: 'proven', reason: 'probe-dead' }],
    log: () => {}, emit: () => true,
  })
  assert.deepEqual(Object.keys(summary).sort(), ['failed', 'proven', 'record_failed', 'recorded', 'rows', 'seats', 'unproven'])
})

test('transport roots are explicit and distinct from the descendant store', () => {
  assert.equal(DESCENDANT_STORE_DIRS['headless-json'], 'headless')
  assert.equal(DESCENDANT_STORE_DIRS['headless-rpc'], 'headless-rpc')
  assert.equal(DESCENDANT_DIR, 'descendants')
})

test('fresh reauthorization refuses a changed identity before SIGTERM', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 9999, root_pgid: 9999, root_start: 'gone',
    groups: [{ pgid: 31, anchors: [{ pid: 32, pgid: 31, start: 'old' }] }],
  })
  let snapshots = 0
  const calls = []
  const events = []
  reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: {
      snapshot: () => {
        snapshots += 1
        return snapshots === 1
          ? snapshot([])
          : snapshot([{ pid: 32, ppid: 1, pgid: 31, start: 'new' }])
      },
      kill: (pid, signal) => { calls.push([pid, signal]); return true },
      sleep: () => {},
    },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.ok(row)
  assert.equal(row.identity_refused, 1)
  assert.equal(row.signalled, 0)
  assert.equal(calls.some(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL'), false)
  assert.ok(snapshots >= 2)
})

test('a signal race accounts ESRCH, EPERM and opaque errno and continues', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 9999, root_pgid: 9999, root_start: 'gone',
    groups: [1, 2, 3].map((n) => ({ pgid: 9000 + n, anchors: [{ pid: 8000 + n, pgid: 9000 + n, start: `a-${n}` }] })),
  })
  const codes = { 9001: 'ESRCH', 9002: 'EPERM', 9003: 'EINVAL' }
  const kill = (pid, signal) => {
    const code = codes[Math.abs(pid)]
    if (code === 'EPERM' && signal === 0) return true
    const error = new Error(code || 'ESRCH'); error.code = code || 'ESRCH'; throw error
  }
  const events = []
  const summary = reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: { snapshot: () => snapshot([1, 2, 3].map((n) => ({ pid: 8000 + n, ppid: 1, pgid: 9000 + n, start: `a-${n}` }))), kill, sleep: () => {} },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.ok(row)
  assert.equal(row.captured, 3)
  assert.equal(row.reclaimed, 1)
  assert.equal(row.probe_unknown, 2)
  assert.equal(summary.records, 1)
})

test('root-alive sweeps do not signal captured groups', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 41, root_pgid: 41, root_start: 'root',
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const calls = []
  const events = []
  reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: { snapshot: () => snapshot([
      { pid: 41, ppid: 1, pgid: 41, start: 'root' },
      { pid: 43, ppid: 41, pgid: 42, start: 'child' },
    ]), kill: (pid, signal) => { calls.push([pid, signal]); return true } },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.equal(row.reason, 'root-alive')
  assert.equal(row.signalled, 0)
  assert.equal(calls.some(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL'), false)
})

test('cross-uid EPERM root probes stay alive and cannot authorize group signals', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 101, root_pgid: 101, root_start: 'root',
    groups: [{ pgid: 102, anchors: [{ pid: 103, pgid: 102, start: 'child' }] }],
  })
  const calls = []
  const error = () => { const value = new Error('permission'); value.code = 'EPERM'; throw value }
  const events = []
  reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: { snapshot: () => snapshot([
      { pid: 101, ppid: 1, pgid: 101, start: 'root' },
      { pid: 103, ppid: 101, pgid: 102, start: 'child' },
    ]), kill: (pid, signal) => { calls.push([pid, signal]); if (pid < -1) error(); return true }, sleep: () => {} },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.equal(row.reason, 'root-alive')
  assert.equal(row.signalled, 0)
  assert.equal(calls.some(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL'), false)
})

test('opaque root final probes remain unproven rather than failed', () => {
  const taskDir = task()
  writeRecord(taskDir, { root_pid: 71, root_pgid: 71, root_start: 'root', groups: [] })
  let probes = 0
  const snapshotFor = () => snapshot([{ pid: 71, ppid: 1, pgid: 71, start: 'root' }])
  const kill = (pid, signal) => {
    if (signal === 0) {
      probes += 1
      if (probes <= 7) return true
      const error = new Error('EINVAL'); error.code = 'EINVAL'; throw error
    }
    return true
  }
  const result = settleSeatRoots({ taskDir, log: () => {}, deps: { snapshot: snapshotFor, kill, sleep: () => {} } })
  assert.equal(result.failed, 0)
  assert.equal(result.unproven, 1)
  assert.equal(records(taskDir)[0].root_settled, 'unproven')
  assert.equal(records(taskDir)[0].root_liveness, 'unknown')
})

test('teardown root settlement and descendant sweep happen before archive', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 51, root_pgid: 51, root_start: 'root',
    groups: [{ pgid: 52, anchors: [{ pid: 53, pgid: 52, start: 'child' }] }],
  })
  let rootAlive = true
  let childAlive = true
  const snapshotFor = () => snapshot([
    ...(rootAlive ? [{ pid: 51, ppid: 1, pgid: 51, start: 'root' }] : []),
    ...(childAlive ? [{ pid: 53, ppid: 51, pgid: 52, start: 'child' }] : []),
  ])
  const kill = (pid, signal) => {
    if (pid === -51 && signal === 'SIGTERM') { rootAlive = false; return true }
    if (pid === -52 && signal === 'SIGTERM') { childAlive = false; return true }
    if (signal === 0 && (pid === -51 ? rootAlive : pid === -52 ? childAlive : true)) return true
    const error = new Error('ESRCH'); error.code = 'ESRCH'; throw error
  }
  let archivedState = null
  const io = { log: () => {}, emit: () => true }
  const result = teardownCore({ dir: task(), taskDir }, { members: {}, workspace_id: null }, {
    io,
    paneRowsFn: () => [],
    settleSeatRoots: ({ taskDir: dir, log }) => settleSeatRoots({ taskDir: dir, log, deps: { snapshot: snapshotFor, kill, sleep: () => {} } }),
    reclaimDescendants: ({ taskDir: dir, log, emit }) => reclaimDescendants({ taskDir: dir, log, emit, deps: { snapshot: snapshotFor, kill, sleep: () => {} } }),
    renameSync: () => { archivedState = { rootAlive, childAlive } },
  })
  assert.deepEqual(archivedState, { rootAlive: false, childAlive: false })
  assert.ok(result.roots)
  assert.ok(result.descendants)
})

test('root identity mismatch is recorded and never signalled', () => {
  const taskDir = task()
  writeRecord(taskDir, { root_pid: 61, root_pgid: 61, root_start: 'old' })
  const calls = []
  settleSeatRoots({
    taskDir, log: () => {},
    deps: {
      snapshot: () => snapshot([{ pid: 61, ppid: 1, pgid: 61, start: 'new' }]),
      kill: (pid, signal) => { calls.push([pid, signal]); return true },
    },
  })
  assert.equal(calls.some(([pid]) => pid < -1), false)
  assert.equal(records(taskDir)[0].root_settled, 'root-unidentified')
})

test('both run outcomes reclaim a real escaped group through the settle path', async () => {
  const previousHome = process.env.HOME
  const previousDb = process.env.DEVTEAM_LEDGER_DB
  const previousExit = process.exitCode
  const seats = []
  try {
    for (const status of ['done', 'escalation']) {
      const home = mkdtempSync(join(tmpdir(), `crew-run-${status}-`))
      tempDirs.push(home)
      const checkout = join(home, 'checkout')
      mkdirSync(checkout, { recursive: true })
      assert.equal(spawnSync('git', ['init', '-q'], { cwd: checkout }).status, 0)
      const brief = join(home, 'brief.md')
      writeFileSync(brief, '# brief\n')
      process.env.HOME = home
      process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
      const taskName = `descendant-${status}`
      await bootCmd({ task: taskName, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath }, {
        cmux: () => ({ ok: true }), tree: () => ({ windows: [] }), renameTab: () => ({ ok: true }),
      })
      const taskDir = join(home, '.crew', 'checkout', taskName, 'task')
      const seat = await realSeat(); seats.push(seat)
      marker(taskDir, `seat-${status}`, 'builder', 'd1', seat.rootPid)
      const visibleBy = Date.now() + 10000
      while (!escapedVisible(seat) && Date.now() < visibleBy) await delay(50)
      assert.equal(escapedVisible(seat), true, 'the escaped child never became observable in its own group')
      descendantCapture({ taskDir, log: () => {} }).round(true)
      // Without this the reclaim assertion below is vacuous: an empty capture
      // leaves nothing to reclaim, which is exactly how this test failed on Linux.
      assert.ok(records(taskDir).length > 0, 'the capture recorded no escaped descendant')
      killGroup(seat.rootPid)
      // Measured on Linux: SIGKILL only signals. runCmd below is synchronous, so
      // without turning the event loop libuv never reaps the child, ps still shows
      // it ("Zs"), psSnapshot reports root_liveness "alive", and the reclaim defers
      // as retryable with reason "root-alive" — leaving the escaped group up. Wait
      // for the actual reap so the root is genuinely absent before the settle path.
      if (seat.child.exitCode === null && seat.child.signalCode === null) await once(seat.child, 'exit')
      const rootGoneBy = Date.now() + 10000
      while (!rootAbsent(seat.rootPid) && Date.now() < rootGoneBy) await delay(50)
      assert.equal(rootAbsent(seat.rootPid), true, 'the seat root was still listed by ps, so the reclaim will refuse it as root-alive')
      const result = status === 'done'
        ? { status: 'done', summary: '', artifacts: [], details: { commit: null } }
        : { status: 'escalation', summary: 'needs review', artifacts: [], details: { commit: null } }
      runCmd({ task: taskName, checkout, 'brief-file': brief, keep: true }, { drive: () => result })
      const deadline = Date.now() + 30000 // generous: a contended CI runner reclaims far slower than a dev box; the assertion below is unchanged
      while (!groupGone(seat.escapedPgid) && Date.now() < deadline) await delay(50)
      assert.equal(groupGone(seat.escapedPgid), true)
    }
  } finally {
    for (const seat of seats) { killGroup(seat.rootPid); killGroup(seat.escapedPgid) }
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    if (previousDb === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previousDb
    process.exitCode = previousExit
  }
})

test('detailed reclaim rows precede failed receipts and remain retryable', () => {
  for (const emit of [() => false, () => { throw new Error('ledger unavailable') }]) {
    const taskDir = task()
    const written = writeRecord(taskDir, { root_pid: 999999, root_pgid: 999999, root_start: 'gone', captures: 4 })
    const journal = []
    const summary = reclaimDescendants({ taskDir, log: (row) => journal.push(row), emit, deps: { snapshot: () => snapshot([]) } })
    assert.equal(summary.record_failed, 1)
    assert.equal(summary.recorded, 0)
    assert.ok(journal.find((row) => row.event === 'descendant-reclaim'))
    assert.equal(JSON.parse(readFileSync(written.path, 'utf8')).swept_at, null)
  }
})

test('identity-refused groups are unproven and never counted live', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 999999, root_pgid: 999999, root_start: 'gone',
    groups: [{ pgid: 71, anchors: [{ pid: 72, pgid: 71, start: 'stale' }] }],
  })
  const events = []
  reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: { snapshot: () => snapshot([{ pid: 72, ppid: 1, pgid: 71, start: 'new' }]), kill: () => true },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.equal(row.identity_refused, 1)
  assert.equal(row.signalled, 0)
  assert.equal(row.live, 0)
  assert.equal(row.outcome, 'unproven')
})

test('opaque final probes are probe_unknown rather than measured live', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 999999, root_pgid: 999999, root_start: 'gone',
    groups: [{ pgid: 81, anchors: [{ pid: 82, pgid: 81, start: 'same' }] }],
  })
  let probes = 0
  const kill = (pid, signal) => {
    if (signal === 0) {
      probes += 1
      if (probes <= 7) return true
      const error = new Error('EINVAL'); error.code = 'EINVAL'; throw error
    }
    return true
  }
  const events = []
  reclaimDescendants({ taskDir, log: (row) => events.push(row), emit: () => true, deps: {
    snapshot: () => snapshot([{ pid: 82, ppid: 1, pgid: 81, start: 'same' }]), kill, sleep: () => {},
  } })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.equal(row.probe_unknown, 1)
  assert.equal(row.live, 0)
  assert.equal(row.outcome, 'unproven')
})

test('terminal and retryable sweeps are stamped according to measured outcome', () => {
  const terminal = task()
  const terminalRecord = writeRecord(terminal, { root_pid: 999999, root_pgid: 999999, root_start: 'gone', groups: [] })
  reclaimDescendants({ taskDir: terminal, log: () => {}, emit: () => true, deps: { snapshot: () => snapshot([]) } })
  assert.ok(JSON.parse(readFileSync(terminalRecord.path, 'utf8')).swept_at)
  const retry = task()
  const retryRecord = writeRecord(retry, {
    root_pid: 999999, root_pgid: 999999, root_start: 'gone',
    groups: [{ pgid: 91, anchors: [{ pid: 92, pgid: 91, start: 'old' }] }],
  })
  const first = []
  reclaimDescendants({ taskDir: retry, log: (row) => first.push(row), emit: () => true, deps: { snapshot: () => snapshot([{ pid: 92, ppid: 1, pgid: 91, start: 'new' }]), kill: () => true } })
  assert.equal(JSON.parse(readFileSync(retryRecord.path, 'utf8')).swept_at, null)
  reclaimDescendants({ taskDir: retry, log: (row) => first.push(row), emit: () => true, deps: { snapshot: () => snapshot([{ pid: 92, ppid: 1, pgid: 91, start: 'new' }]), kill: () => true } })
  assert.equal(new Set(first.filter((row) => row.event === 'descendant-reclaim').map((row) => row.sweep_id)).size, 2)
})

test('recordSeatReclaim enforces identity and outcome vocabulary without echoing values', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-ledger-reclaim-')); tempDirs.push(root)
  const ledger = openLedger({ dbPath: join(root, 'ledger.db'), nodeVersion: '20.11.0', stderr: { write: () => {} } })
  const base = { adw_id: 'run', transport: 'headless-json', seat_id: 'd1', reservation_id: 'res', sweep_id: 'sweep', outcome: 'proven', coverage_outcome: 'unproven' }
  assert.throws(() => ledger.recordSeatReclaim({ ...base, transport: '   ' }), (error) => !String(error.message).includes('   '))
  assert.throws(() => ledger.recordSeatReclaim({ ...base, outcome: 'other' }), (error) => !String(error.message).includes('other'))
  assert.throws(() => ledger.recordSeatReclaim({ ...base, coverage_outcome: 'proven' }))
  assert.deepEqual(Object.keys(ledger.recordSeatReclaim(base)), [
    'adw_id', 'phase_id', 'transport', 'seat_id', 'reservation_id', 'sweep_id', 'role',
    'owner_pid', 'owner_liveness', 'root_pid', 'root_pgid', 'root_start', 'root_liveness',
    'root_settled', 'captures', 'missed_snapshots', 'discovery_failures', 'captured', 'signalled',
    'reclaimed', 'live', 'identity_refused', 'probe_unknown', 'outcome', 'reason',
    'coverage_outcome', 'coverage_reason', 'created_at',
  ])
})

test('seatIo transport sleep captures and still serves the requested delay', () => {
  const root = task()
  const paths = { dir: root, taskDir: root, returnsDir: join(root, 'returns') }
  mkdirSync(paths.returnsDir, { recursive: true })
  marker(root, 'sleep-res')
  let received = null
  // The injected headlessIo means nothing is spawned, but seatIo still resolves a
  // worker binary first — so name one explicitly instead of falling through to the
  // host's ~/.local/bin/claude, which does not exist on a CI runner.
  const io = seatIo({ members: { builder: { transport: 'headless-json', model: 'x' } } }, paths, root, null, null, { 'claude-bin': process.execPath }, {
    headlessIo: (args) => { received = args; return { assign: () => ({ id: 'd1', returnPath: join(root, 'returns', 'd1.json') }) } },
    sleep: () => {},
  })
  io.assign({ role: 'builder', briefFile: join(root, 'brief.md') })
  assert.equal(typeof received.deps.sleep, 'function')
  received.deps.sleep(0)
  assert.equal(records(root).length, 1)
})

test('slice-1 settle vocabulary and both entrypoint calls remain source-visible', () => {
  const seatIoSrc = readFileSync(new URL('./seat-io.mjs', import.meta.url), 'utf8')
  const crew = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  const child = readFileSync(new URL('./child.mjs', import.meta.url), 'utf8')
  assert.equal(seatIoSrc.split('seat-teardown-sweep').length - 1, 1)
  assert.equal(crew.split('settleSeatTeardown(io)').length - 1, 1)
  assert.equal(child.split('settleSeatTeardown(io)').length - 1, 1)
})

// ---------------------------------------------------------------------------
// The three round-3 must-fixes (RV3-1/2/3). Each of these reddens when its fix
// is neutralised; all three are the same law — the sweep may not record proven
// or failed for a process group it never measured.
// ---------------------------------------------------------------------------

test('an unmeasured root table settles unproven, and only a present mismatching row is root-unidentified', () => {
  const unmeasured = task()
  writeRecord(unmeasured, { root_pid: 61, root_pgid: 61, root_start: 'root', groups: [] })
  const signals = []
  const result = settleSeatRoots({
    taskDir: unmeasured,
    log: () => {},
    deps: {
      snapshot: () => ({ ok: false, rows: new Map() }),
      kill: (pid, signal) => { signals.push([pid, signal]); return true },
      sleep: () => {},
    },
  })
  assert.deepEqual([result.unproven, result.unidentified, signals.length], [1, 0, 0])
  assert.equal(records(unmeasured)[0].root_settled, 'unproven')
  assert.equal(records(unmeasured)[0].root_liveness, 'unknown')

  // A row that IS in the table and contradicts the capture is a MEASURED
  // identity mismatch, and stays root-unidentified.
  const reused = task()
  writeRecord(reused, { root_pid: 62, root_pgid: 62, root_start: 'root', groups: [] })
  const mismatch = settleSeatRoots({
    taskDir: reused,
    log: () => {},
    deps: {
      snapshot: () => snapshot([{ pid: 62, ppid: 1, pgid: 4242, start: 'someone-else' }]),
      kill: () => true,
      sleep: () => {},
    },
  })
  assert.deepEqual([mismatch.unidentified, mismatch.unproven], [1, 0])
  assert.equal(records(reused)[0].root_settled, 'root-unidentified')
})

test('an unmeasured post-SIGTERM probe never escalates to SIGKILL nor proves a reclaim', () => {
  for (const code of ['EPERM', 'EINVAL']) {
    const taskDir = task()
    writeRecord(taskDir, {
      root_pid: 999999, root_pgid: 999999, root_start: 'gone',
      groups: [{ pgid: 63, anchors: [{ pid: 64, pgid: 63, start: 'child' }] }],
    })
    const calls = []
    const kill = (pid, signal) => {
      calls.push([pid, signal])
      const termed = calls.some(([, value]) => value === 'SIGTERM')
      if (signal === 0) {
        if (!termed) return true                                   // authorized alive before the signal
        const error = new Error(code); error.code = code; throw error   // and unmeasurable after it
      }
      if (signal === 'SIGTERM') return true
      // The SIGKILL that must not happen: its ESRCH would forge a proven reclaim.
      const error = new Error('ESRCH'); error.code = 'ESRCH'; throw error
    }
    const events = []
    reclaimDescendants({
      taskDir, log: (row) => events.push(row), emit: () => true,
      deps: { snapshot: () => snapshot([{ pid: 64, ppid: 1, pgid: 63, start: 'child' }]), kill, sleep: () => {} },
    })
    const row = events.find((item) => item.event === 'descendant-reclaim')
    assert.equal(calls.some(([, signal]) => signal === 'SIGKILL'), false, `${code}: escalated to SIGKILL`)
    assert.deepEqual([row.probe_unknown, row.reclaimed, row.live, row.signalled], [1, 0, 0, 1], code)
    assert.equal(row.outcome, 'unproven', code)
    assert.equal(row.reason, 'probe-unknown', code)
  }
})

test('a final EPERM group probe is probe_unknown and unproven, never measured live', () => {
  const taskDir = task()
  writeRecord(taskDir, {
    root_pid: 999999, root_pgid: 999999, root_start: 'gone',
    groups: [{ pgid: 65, anchors: [{ pid: 66, pgid: 65, start: 'child' }] }],
  })
  const calls = []
  const kill = (pid, signal) => {
    calls.push([pid, signal])
    // Measured alive until the SIGKILL lands; from then on no probe can answer.
    if (signal === 0 && calls.some(([, value]) => value === 'SIGKILL')) {
      const error = new Error('EPERM'); error.code = 'EPERM'; throw error
    }
    return true
  }
  const events = []
  reclaimDescendants({
    taskDir, log: (row) => events.push(row), emit: () => true,
    deps: { snapshot: () => snapshot([{ pid: 66, ppid: 1, pgid: 65, start: 'child' }]), kill, sleep: () => {} },
  })
  const row = events.find((item) => item.event === 'descendant-reclaim')
  assert.equal(calls.some(([, signal]) => signal === 'SIGKILL'), true)
  assert.deepEqual([row.probe_unknown, row.live, row.reclaimed], [1, 0, 0])
  assert.equal(row.outcome, 'unproven')
  assert.equal(row.reason, 'probe-unknown')
})
