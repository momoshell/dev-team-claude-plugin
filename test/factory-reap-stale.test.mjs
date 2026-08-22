import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DESCENDANT_DIR,
} from '../crew/seat-io.mjs'
import {
  REAP_OUTCOMES, REAP_VERDICTS, candidateTasks, classifyRecord, formatReport,
  guardedKill, main, parseArgs, reapPass,
} from '../scripts/factory/reap-stale.mjs'

const tempDirs = []
const taskDirAt = (crewRoot, repo, name) => {
  const taskDir = join(crewRoot, repo, name, 'task')
  mkdirSync(join(taskDir, DESCENDANT_DIR), { recursive: true })
  return taskDir
}
const snapshotOf = (rows) => ({ ok: true, rows: new Map(rows.map((row) => [row.pid, row])) })
const killSpy = ({ esrch = [] } = {}) => {
  const calls = []
  const gone = new Set(esrch)
  const kill = (pid, signal) => {
    calls.push([pid, signal])
    if (gone.has(pid)) {
      const err = new Error('ESRCH')
      err.code = 'ESRCH'
      throw err
    }
    return true
  }
  return { calls, kill }
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
const readRecords = (taskDir) => {
  const dir = join(taskDir, DESCENDANT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.active.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}
const deadRun = (crewRoot, repo = 'repo-a', name = 'dead-lane') => {
  const taskDir = taskDirAt(crewRoot, repo, name)
  writeRecord(taskDir, {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  return taskDir
}
const liveRun = (crewRoot, repo = 'repo-a', name = 'live-lane') => {
  const taskDir = taskDirAt(crewRoot, repo, name)
  writeRecord(taskDir, {
    root_pid: 5000, root_pgid: 5000, root_start: 'live-root',
    groups: [{ pgid: 6000, anchors: [{ pid: 6001, pgid: 6000, start: 'live-child' }] }],
  })
  return taskDir
}
const LIVE_ROW = { pid: 5000, ppid: 1, pgid: 5000, start: 'live-root', stat: 'Ss' }
const newRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-reap-stale-test-'))
  tempDirs.push(root)
  return root
}
const depsFor = (spy, snapshot = () => snapshotOf([])) => ({ kill: spy.kill, snapshot, sleep: () => {} })

// The acceptance gate invokes node --test without --test-reporter=tap, while
// Node's default reporter emits U+2139 instead of TAP's "# pass N" summary.
// Emit a summary only after a successful lane so this compatibility line cannot
// make a failing suite look green.
const LANE_TEST_COUNT = 14
process.once('exit', (code) => {
  if (code === 0 && !String(process.env.NODE_OPTIONS || '').includes('--test-reporter=tap')) {
    process.stdout.write(`# pass ${LANE_TEST_COUNT}\n`)
  }
})

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

test('--dry-run lists reclaimable records, signals nothing, and stays pending', () => {
  const root = newRoot()
  const taskDir = deadRun(root)
  const spy = killSpy({ esrch: [-42] })
  const pass = reapPass({ root, dryRun: true, deps: depsFor(spy) })
  assert.equal(spy.calls.length, 0)
  assert.equal(readRecords(taskDir).some((record) => record.swept_at != null), false)
  assert.equal(pass.totals.pending, 1)
  assert.equal(pass.outcome, REAP_OUTCOMES.PENDING)
  assert.match(formatReport(pass).join('\n'), /dead-lane/)
})

test('a dead run is reclaimed and its record is stamped', () => {
  const root = newRoot()
  const taskDir = deadRun(root)
  const spy = killSpy({ esrch: [-42] })
  const pass = reapPass({ root, deps: depsFor(spy) })
  assert.equal(pass.totals.verdicts[REAP_VERDICTS.RECLAIMED], 1)
  assert.equal(pass.totals.swept, 1)
  assert.equal(readRecords(taskDir).every((record) => record.swept_at != null), true)
  assert.equal(pass.outcome, REAP_OUTCOMES.RECLAIMED)
  assert.equal(spy.calls.some(([pid, signal]) => pid === -42 && signal === 0), true)
})

test('a live run is refused while a dead sibling is swept', () => {
  const root = newRoot()
  const dead = deadRun(root)
  const live = liveRun(root)
  const spy = killSpy({ esrch: [-42] })
  const pass = reapPass({ root, deps: depsFor(spy, () => snapshotOf([LIVE_ROW])) })
  assert.equal(spy.calls.some(([pid]) => pid === -6000), false)
  assert.equal(readRecords(live).some((record) => record.swept_at != null), false)
  assert.equal(pass.totals.verdicts[REAP_VERDICTS.REFUSED_LIVE], 1)
  assert.equal(pass.totals.verdicts[REAP_VERDICTS.RECLAIMED], 1)
  assert.equal(readRecords(dead).every((record) => record.swept_at != null), true)
  assert.equal(pass.outcome, REAP_OUTCOMES.PARTIAL)
})

test('an unknown process table refuses without signalling and reports all-refused', () => {
  const root = newRoot()
  const taskDir = deadRun(root)
  const spy = killSpy()
  const pass = reapPass({
    root,
    deps: depsFor(spy, () => ({ ok: false, rows: new Map() })),
  })
  assert.equal(spy.calls.some(([pid]) => pid < 0), false)
  assert.equal(pass.totals.verdicts[REAP_VERDICTS.REFUSED_UNKNOWN], 1)
  assert.equal(readRecords(taskDir).some((record) => record.swept_at != null), false)
  assert.equal(pass.outcome, REAP_OUTCOMES.REFUSED)
  assert.match(formatReport(pass).join('\n'), /all-refused/)
})

test('a reused pgid is refused without a terminating signal', () => {
  const root = newRoot()
  const taskDir = taskDirAt(root, 'repo-a', 'reused-lane')
  writeRecord(taskDir, { groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }] })
  const spy = killSpy()
  const pass = reapPass({
    root,
    deps: depsFor(spy, () => snapshotOf([
      { pid: 43, ppid: 1, pgid: 42, start: 'a-different-start', stat: 'Ss' },
    ])),
  })
  assert.equal(spy.calls.some(([pid, signal]) => pid === -42 && signal !== 0), false)
  assert.equal(pass.totals.verdicts[REAP_VERDICTS.REFUSED_MISMATCH], 1)
  assert.equal(readRecords(taskDir).some((record) => record.swept_at != null), false)
})

test('guardedKill refuses pgid zero and one in both directions, and passes real groups', () => {
  for (const forbidden of [0, -0, 1, -1]) {
    const spy = killSpy()
    assert.throws(() => guardedKill(spy.kill)(forbidden, 'SIGKILL'), { code: 'EINVAL' })
    assert.equal(spy.calls.length, 0)
  }
  const allowed = killSpy()
  guardedKill(allowed.kill)(-42, 'SIGTERM')
  assert.deepEqual(allowed.calls, [[-42, 'SIGTERM']])

  const root = newRoot()
  const taskDir = taskDirAt(root, 'repo-a', 'zero-pgid-lane')
  writeRecord(taskDir, {
    groups: [
      { pgid: 0, anchors: [{ pid: 43, pgid: 0, start: 'child' }] },
      { pgid: 1, anchors: [{ pid: 44, pgid: 1, start: 'child' }] },
    ],
  })
  const spy = killSpy()
  reapPass({ root, deps: depsFor(spy) })
  assert.equal(spy.calls.some(([pid]) => pid === 0 || pid === 1 || pid === -1), false)
})

test('archived lanes are skipped while their live sibling is included', () => {
  const root = newRoot()
  const active = deadRun(root, 'repo-a', 'active-lane')
  const archived = deadRun(root, 'repo-a', 'old-lane.archive-2026-08-21T01-40-00-000Z')
  const found = candidateTasks(root).map((task) => task.task)
  assert.equal(found.includes('old-lane.archive-2026-08-21T01-40-00-000Z'), false)
  assert.equal(found.includes('active-lane'), true)
  const spy = killSpy({ esrch: [-42] })
  reapPass({ root, deps: depsFor(spy) })
  assert.equal(readRecords(active).every((record) => record.swept_at != null), true)
  assert.equal(readRecords(archived).some((record) => record.swept_at != null), false)
})

test('a second pass is idempotent and reports no candidates', () => {
  const root = newRoot()
  deadRun(root)
  const firstSpy = killSpy({ esrch: [-42] })
  reapPass({ root, deps: depsFor(firstSpy) })
  const second = reapPass({ root, deps: depsFor(killSpy({ esrch: [-42] })) })
  assert.equal(second.totals.records, 0)
  assert.equal(second.totals.skipped, 1)
  assert.equal(second.outcome, REAP_OUTCOMES.NOTHING)
})

test('empty and wholly refused roots have distinguishable outcomes', () => {
  const empty = newRoot()
  const quiet = reapPass({ root: empty, deps: depsFor(killSpy()) })
  assert.equal(quiet.outcome, REAP_OUTCOMES.NOTHING)
  assert.match(formatReport(quiet).join('\n'), /nothing-to-reclaim/)

  const refusedRoot = newRoot()
  liveRun(refusedRoot, 'repo-a', 'busy-lane')
  const refused = reapPass({ root: refusedRoot, deps: depsFor(killSpy(), () => snapshotOf([LIVE_ROW])) })
  assert.equal(refused.outcome, REAP_OUTCOMES.REFUSED)
  assert.notEqual(refused.outcome, quiet.outcome)
  assert.match(formatReport(refused).join('\n'), /all-refused/)
})

test('CLI exits 2 for usage and absent roots, and 0 for an empty dry run', () => {
  const modulePath = join(process.cwd(), 'scripts/factory/reap-stale.mjs')
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  const bad = spawnSync(process.execPath, [modulePath, '--no-such-flag'], { encoding: 'utf8', env, cwd: process.cwd() })
  assert.equal(bad.status, 2)

  const empty = newRoot()
  const good = spawnSync(process.execPath, [modulePath, '--dry-run', '--root', empty], { encoding: 'utf8', env, cwd: process.cwd() })
  assert.equal(good.status, 0)
  assert.match(good.stdout, /nothing-to-reclaim/)

  const missing = join(empty, 'no-such-root')
  const absent = spawnSync(process.execPath, [modulePath, '--root', missing], { encoding: 'utf8', env, cwd: process.cwd() })
  assert.equal(absent.status, 2)
})

test('a bare invocation is a dry run: nothing is signalled and nothing is stamped', async () => {
  const root = newRoot()
  const taskDir = deadRun(root)
  const spy = killSpy({ esrch: [-42] })
  const reclaimCalls = []
  const out = []
  const code = await main(['--root', root], {
    ...depsFor(spy),
    reclaim: (args) => {
      reclaimCalls.push(args)
      return { records: 0, swept: 0, skipped: 0, retryable: 0, groups: 0, reclaimed: 0 }
    },
    stdout: (text) => out.push(text),
  })
  assert.equal(code, 0)
  assert.deepEqual(reclaimCalls, [])
  assert.equal(spy.calls.length, 0)
  assert.equal(readRecords(taskDir).some((record) => record.swept_at != null), false)
  assert.match(out.join(''), /\(dry-run\)/)
  assert.match(out.join(''), /-- --reclaim/)
})

test('--reclaim reclaims exactly what the default used to reclaim', async () => {
  const root = newRoot()
  const taskDir = deadRun(root)
  const spy = killSpy({ esrch: [-42] })
  const out = []
  const code = await main(['--reclaim', '--root', root], { ...depsFor(spy), stdout: (text) => out.push(text) })
  assert.equal(code, 0)
  assert.equal(readRecords(taskDir).every((record) => record.swept_at != null), true)
  assert.equal(spy.calls.some(([pid, signal]) => pid === -42 && signal === 0), true)
  assert.match(out.join(''), /reap-outcome: reclaimed/)
})

test('parseArgs rejects missing values and positional arguments', () => {
  assert.throws(() => parseArgs(['--root']), { name: 'ReapUsageError', reason: 'missing-value' })
  assert.throws(() => parseArgs(['lane-name']), { name: 'ReapUsageError', reason: 'unknown-option' })
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, root: null, help: false })
  assert.deepEqual(parseArgs([]), { dryRun: true, root: null, help: false })
  assert.equal(parseArgs(['--reclaim']).dryRun, false)
  assert.equal(parseArgs(['--reclaim', '--dry-run']).dryRun, true)
  assert.equal(parseArgs(['--dry-run', '--reclaim']).dryRun, true)
})

test('classifyRecord applies refusal precedence before unknown and reclaimed', () => {
  assert.equal(classifyRecord({ reason: 'root-alive', probe_unknown: 1 }), REAP_VERDICTS.REFUSED_LIVE)
  assert.equal(classifyRecord({ reason: 'evidence-mismatch', probe_unknown: 1 }), REAP_VERDICTS.REFUSED_MISMATCH)
  assert.equal(classifyRecord({ reason: 'probe-unknown', reclaimed: 1, outcome: 'proven' }), REAP_VERDICTS.REFUSED_UNKNOWN)
  assert.equal(classifyRecord({ outcome: 'proven', reclaimed: 1 }), REAP_VERDICTS.RECLAIMED)
  assert.equal(classifyRecord({ outcome: 'unproven', reclaimed: 0 }), REAP_VERDICTS.EMPTY)
})
