import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DESCENDANT_DIR,
} from '../crew/seat-io.mjs'
import {
  PANE_OUTCOMES, PANE_PROVENANCE_BLIND_SPOT, PANE_RECHECK_REFUSALS, PANE_SETTLE_MS,
  PANE_UNKNOWN_REASONS, PANE_VERDICTS, REAP_OUTCOMES, REAP_VERDICTS, candidateTasks, classifyRecord,
  formatPaneReport, formatReport, guardedKill, isLoginShell, main, paneShellFds,
  paneShellIdentity, paneShellSnapshot, panePass, parseArgs, reapPass,
} from '../scripts/factory/reap-stale.mjs'

const tempDirs = []
const taskDirAt = (crewRoot, repo, name) => {
  const taskDir = join(crewRoot, repo, name, 'task')
  mkdirSync(join(taskDir, DESCENDANT_DIR), { recursive: true })
  return taskDir
}
const snapshotOf = (rows) => ({ ok: true, rows: new Map(rows.map((row) => [row.pid, row])) })
// `esrch` refuses every signal for a pid — the process was already gone.
// `settles` is the production shape a reclaim actually meets: the SIGTERM is
// DELIVERED and it is the later signal-zero probe that reports ESRCH (#933
// TL9), so a fixture using it exercises the settle path rather than skipping it.
const killSpy = ({ esrch = [], settles = [] } = {}) => {
  const calls = []
  const gone = new Set(esrch)
  const settling = new Set(settles)
  const esrchError = () => {
    const err = new Error('ESRCH')
    err.code = 'ESRCH'
    return err
  }
  const kill = (pid, signal) => {
    calls.push([pid, signal])
    if (gone.has(pid)) throw esrchError()
    if (settling.has(pid) && signal !== 'SIGTERM') throw esrchError()
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
// Every descendant test injects an EMPTY pane table: the pane host sweep is a
// separate class and must not put this box's real login shells into a
// descendant assertion (#933).
const QUIET_PANE = () => ({ ok: true, rows: [] })
const depsFor = (spy, snapshot = () => snapshotOf([])) => ({ kill: spy.kill, snapshot, sleep: () => {}, paneSnapshot: QUIET_PANE })
const ARCHIVED_LANE = 'old-lane.archive-2026-08-21T01-40-00-000Z'
// Everything a sweep may legitimately write lives inside the descendant store
// (records and their lock files); the inventory outside it must not move.
const STORE_PREFIX = join('task', DESCENDANT_DIR)
const inventoryOf = (dir) => {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name)
      const rel = relative(dir, full)
      if (!rel.startsWith(STORE_PREFIX)) out.push(rel)
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}

// The acceptance gate invokes node --test without --test-reporter=tap, while
// Node's default reporter emits U+2139 instead of TAP's "# pass N" summary.
// Emit a summary only after a successful lane so this compatibility line cannot
// make a failing suite look green.
const LANE_TEST_COUNT = 33
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

test('an archived lane is enumerated, reaped, and reported archived rather than active', () => {
  const root = newRoot()
  const active = deadRun(root, 'repo-a', 'active-lane')
  const archived = deadRun(root, 'repo-a', ARCHIVED_LANE)
  const rows = candidateTasks(root)
  assert.equal(rows.some((task) => task.task === ARCHIVED_LANE && task.archived === true), true)
  assert.equal(rows.some((task) => task.task === 'active-lane' && task.archived === false), true)
  const spy = killSpy({ esrch: [-42] })
  const pass = reapPass({ root, deps: depsFor(spy) })
  // A process left behind by a lane stays reachable after that lane archives.
  assert.equal(readRecords(archived).every((record) => record.swept_at != null), true)
  assert.equal(readRecords(active).every((record) => record.swept_at != null), true)
  assert.equal(pass.totals.archived_tasks, 1)
  assert.equal(pass.totals.active_tasks, 1)
  assert.equal(pass.totals.verdicts[REAP_VERDICTS.RECLAIMED], 2)
  const report = formatReport(pass)
  assert.match(report.find((line) => line.includes(ARCHIVED_LANE)), /\[archived\]/)
  assert.doesNotMatch(report.find((line) => line.includes('active-lane')), /\[archived\]/)
  assert.match(report.join('\n'), /active 1, archived 1/)
})

test('an archived lane that cannot be proven dead records unproven and stays unstamped', () => {
  const root = newRoot()
  const archived = deadRun(root, 'repo-a', ARCHIVED_LANE)
  const spy = killSpy()
  const pass = reapPass({ root, deps: depsFor(spy, () => ({ ok: false, rows: new Map() })) })
  assert.equal(pass.tasks[0].outcomes.unproven, 1)
  assert.equal(pass.tasks[0].outcomes.proven, 0)
  assert.equal(pass.totals.outcomes.unproven, 1)
  assert.equal(pass.totals.verdicts[REAP_VERDICTS.REFUSED_UNKNOWN], 1)
  assert.equal(readRecords(archived).some((record) => record.swept_at != null), false)
  assert.equal(pass.outcome, REAP_OUTCOMES.REFUSED)
  assert.match(formatReport(pass).join('\n'), /unproven 1/)
})

test('a proven archived reclaim tallies proven, not unproven', () => {
  const root = newRoot()
  deadRun(root, 'repo-a', ARCHIVED_LANE)
  const pass = reapPass({ root, deps: depsFor(killSpy({ esrch: [-42] })) })
  assert.equal(pass.totals.outcomes.proven, 1)
  assert.equal(pass.totals.outcomes.unproven, 0)
})

test('reaping an archived lane writes only inside its descendant store', () => {
  const root = newRoot()
  const laneDir = join(root, 'repo-a', ARCHIVED_LANE)
  const taskDir = deadRun(root, 'repo-a', ARCHIVED_LANE)
  mkdirSync(join(laneDir, 'returns'), { recursive: true })
  writeFileSync(join(laneDir, 'returns', 'd1.planner.json'), '{"role":"planner"}')
  writeFileSync(join(taskDir, 'plan.md'), '# archived plan\n')
  const before = inventoryOf(laneDir)
  reapPass({ root, deps: depsFor(killSpy({ esrch: [-42] })) })
  // Non-vacuous: the pass must have reaped this lane, or an unchanged
  // inventory would only say nothing was looked at.
  assert.equal(readRecords(taskDir).every((record) => record.swept_at != null), true)
  assert.deepEqual(inventoryOf(laneDir), before)
  assert.equal(readFileSync(join(taskDir, 'plan.md'), 'utf8'), '# archived plan\n')
  assert.equal(readFileSync(join(laneDir, 'returns', 'd1.planner.json'), 'utf8'), '{"role":"planner"}')
})

test('a bare invocation over an archived lane lists it and signals nothing', async () => {
  const root = newRoot()
  const taskDir = deadRun(root, 'repo-a', ARCHIVED_LANE)
  const spy = killSpy({ esrch: [-42] })
  const out = []
  const code = await main(['--root', root], { ...depsFor(spy), stdout: (text) => out.push(text) })
  assert.equal(code, 0)
  assert.equal(spy.calls.length, 0)
  assert.equal(readRecords(taskDir).some((record) => record.swept_at != null), false)
  assert.match(out.join(''), /\[archived\] — pending 1/)
  assert.match(out.join(''), /\(dry-run\)/)
})

// MUTATION V3: replacing guardedKill(base) with base in reclaimDeps
// (scripts/factory/reap-stale.mjs) kills THIS test and no other. crew/seat-io.mjs's
// ownerLiveness guards only pid <= 0, so an owner pid of 1 reaches the injected
// kill unguarded; the pgid-0/1 groups the sibling test uses are refused earlier,
// by verifyGroup's invalid-pgid arm, which is why they left the seam untouched
// (#476 finding V3).
test('the pid guard is what stops the owner probe from signalling pid 1', () => {
  const root = newRoot()
  const taskDir = taskDirAt(root, 'repo-a', ARCHIVED_LANE)
  writeRecord(taskDir, {
    owner: { pid: 1, startedAt: Date.now() }, marker_owner_pid: 1,
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const spy = killSpy({ esrch: [-42] })
  reapPass({ root, deps: depsFor(spy) })
  // The seam is REACHED, so the absence below cannot mean "nothing ran".
  assert.equal(spy.calls.some(([pid]) => pid === -42), true)
  assert.equal(spy.calls.some(([pid]) => pid === 1 || pid === -1 || pid === 0), false)
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
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, reclaimPaneShells: false, root: null, help: false })
  assert.deepEqual(parseArgs([]), { dryRun: true, reclaimPaneShells: false, root: null, help: false })
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

// ---------------------------------------------------------------------------
// The pane host shell class (#933). Every fixture below is the shape actually
// measured on 2026-09-05: `-/opt/homebrew/bin/nu`, ppid=1, TT=??, and no fd
// 0/1/2 — only nushell's own fd 3/4 socketpair.
const PANE_ORPHAN = { pid: 75753, ppid: 1, tty: '??', command: '-/opt/homebrew/bin/nu' }
const PANE_TTY = { pid: 83020, ppid: 1, tty: 'ttys001', command: '-/opt/homebrew/bin/nu' }
const PANE_DAEMON = { pid: 25, ppid: 1, tty: '??', command: '/usr/libexec/logd' }
// Orphan-SHAPED but unmeasured: identical cheap columns, an fd probe that could
// not run. It exists to prove an unknown never reads as a clean sweep.
const PANE_UNMEASURED = { pid: 60999, ppid: 1, tty: '??', command: '-/bin/zsh' }
const PANE_START = 'Sat Aug 29 00:49:11 2026'
const PANE_DEAD_CWD = '/Users/nobody/Dev/dt-b304-coldverify'
const ORPHAN_FDS = { ok: true, reason: null, fds: [3, 4], cwd: PANE_DEAD_CWD }
const paneIdentity = (row, start = PANE_START, command = row.command) => ({ ok: true, reason: null, present: true, ppid: row.ppid, tty: row.tty, start, command })
const paneSequence = (values) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}
const paneDepsFor = (spy, rows, { probe, identity } = {}) => ({
  kill: spy.kill,
  sleep: () => {},
  paneSnapshot: () => (rows === null ? { ok: false, rows: [] } : { ok: true, rows }),
  fdProbe: probe || (() => ORPHAN_FDS),
  identityProbe: identity || (() => paneIdentity(PANE_ORPHAN)),
})
// Recorded from this box on 2026-09-06. A hand-built frame would pin a format
// the tool never emits.
const PS_CAPTURE = [
  '    1     0 ??       /sbin/launchd',
  '   25     1 ??       /usr/libexec/logd',
  '83020 83019 ttys001  -/opt/homebrew/bin/nu --execute use ghostty *',
  '',
].join('\n')
const PS_IDENTITY_CAPTURE = '77238 77237 ttys000  Wed Sep  2 14:40:27 2026     -/opt/homebrew/bin/nu\n'
const LSOF_CAPTURE = [
  'p75753', 'fcwd', 'tDIR', `n${PANE_DEAD_CWD}`, 'ftxt', 'tREG', 'n/opt/homebrew/bin/nu',
  'f3', 'tPIPE', 'n->0x9c0a1b2c', 'f4', 'tPIPE', 'n->0x9c0a1b30', '',
].join('\n')

test('a reparented pane login shell with no tty and no standard streams is a pane host candidate', () => {
  const spy = killSpy()
  const pane = panePass({ deps: paneDepsFor(spy, [PANE_DAEMON, PANE_ORPHAN]) })
  assert.equal(pane.totals.candidates, 1)
  assert.equal(pane.totals.orphan, 1)
  assert.equal(pane.rows[0].verdict, PANE_VERDICTS.ORPHAN)
  assert.equal(spy.calls.length, 0)
  assert.equal(pane.outcome, PANE_OUTCOMES.PENDING)
  const report = formatPaneReport(pane)
  assert.match(report.find((line) => line.includes(String(PANE_ORPHAN.pid))), /ppid 1 tty \?\? fds 3,4 cwd \S+ \(unlinked\)/)
  // A blind spot is stated, not omitted: this proves a login shell, not cmux.
  assert.ok(report.join('\n').includes(PANE_PROVENANCE_BLIND_SPOT))
})

test('TL11 fresh pane identity refuses an acquired controlling tty before reclaim', () => {
  const spy = killSpy()
  const pane = panePass({ reclaim: true, deps: paneDepsFor(spy, [PANE_TTY], { identity: () => paneIdentity(PANE_TTY) }) })
  assert.equal(pane.rows[0].verdict, PANE_VERDICTS.REFUSED_TTY)
  assert.equal(pane.rows[0].reason, 'controlling-tty')
  assert.equal(pane.totals.orphan, 0)
  assert.equal(spy.calls.length, 0)

  const freshSpy = killSpy()
  const probeOrder = []
  const acquiredTerminal = { ...PANE_ORPHAN, tty: 'ttys003' }
  const fresh = panePass({
    reclaim: true,
    deps: paneDepsFor(freshSpy, [PANE_ORPHAN], {
      probe: () => { probeOrder.push('fd'); return ORPHAN_FDS },
      identity: () => { probeOrder.push('identity'); return paneIdentity(acquiredTerminal) },
    }),
  })
  assert.deepEqual(probeOrder, ['fd', 'identity'])
  assert.equal(fresh.rows[0].verdict, PANE_VERDICTS.REFUSED_TTY)
  assert.equal(fresh.rows[0].ppid, acquiredTerminal.ppid)
  assert.equal(fresh.rows[0].tty, acquiredTerminal.tty)
  assert.equal(freshSpy.calls.length, 0)
  assert.match(formatPaneReport(fresh).join('\n'), /tty ttys003/)
})

test('a pane candidate whose descriptors cannot be read is unknown, not orphan and not clear', () => {
  const spy = killSpy()
  const probe = () => ({ ok: false, reason: PANE_UNKNOWN_REASONS.FD_PROBE, fds: [], cwd: null })
  const pane = panePass({ reclaim: true, deps: paneDepsFor(spy, [PANE_ORPHAN], { probe }) })
  assert.equal(pane.rows[0].verdict, PANE_VERDICTS.UNKNOWN)
  assert.equal(pane.rows[0].reason, PANE_UNKNOWN_REASONS.FD_PROBE)
  assert.deepEqual([pane.totals.orphan, pane.totals.clear, pane.totals.unknown], [0, 0, 1])
  assert.equal(spy.calls.length, 0)
})

test('an unreadable process table is a stated pane blind spot, never a clear', () => {
  const pane = panePass({ deps: paneDepsFor(killSpy(), null) })
  assert.equal(pane.ok, false)
  assert.equal(pane.reason, PANE_UNKNOWN_REASONS.TABLE)
  assert.equal(pane.outcome, PANE_OUTCOMES.UNMEASURED)
  assert.equal(pane.totals.orphan, 0)
  assert.match(formatPaneReport(pane).join('\n'), /UNMEASURED \[reason: process-table-unavailable\]/)
})

test('a pane host login shell is recognised by a leading dash on argv0, whatever the interpreter', () => {
  for (const command of ['-/opt/homebrew/bin/nu', '-zsh', '-bash', '-/bin/sh', '-/opt/weird/bin/xonsh']) {
    assert.equal(isLoginShell(command), true, command)
  }
  // A long option in argv0 is an option, not a login-shell mark. Without this
  // exclusion every `--color=auto` on the box becomes a candidate.
  for (const command of ['--color=auto', '--', '---x', '-', '', '/opt/homebrew/bin/nu', '/usr/libexec/logd']) {
    assert.equal(isLoginShell(command), false, command)
  }
})

test('a reused pid is refused before the signal: pane reclaim is bound to a process start', () => {
  const spy = killSpy()
  const identity = paneSequence([
    paneIdentity(PANE_ORPHAN, PANE_START),
    paneIdentity(PANE_ORPHAN, 'Sun Sep  6 09:20:57 2026'),
  ])
  const pane = panePass({ reclaim: true, deps: paneDepsFor(spy, [PANE_ORPHAN], { identity }) })
  assert.equal(spy.calls.length, 0)
  assert.equal(pane.rows[0].signalled, false)
  assert.equal(pane.rows[0].reason, PANE_RECHECK_REFUSALS.MISMATCH)
  assert.equal(pane.totals.refused_recheck, 1)

  // An identity the probe could not read is refused too, with its own reason —
  // and it carries a MATCHING start, so an implementation that ignores `ok`
  // would sail through it.
  const blind = killSpy()
  const unreadable = { ok: false, reason: PANE_UNKNOWN_REASONS.IDENTITY, present: true, ppid: 1, tty: '??', start: PANE_START, command: PANE_ORPHAN.command }
  const second = panePass({
    reclaim: true,
    deps: paneDepsFor(blind, [PANE_ORPHAN], { identity: paneSequence([paneIdentity(PANE_ORPHAN), unreadable]) }),
  })
  assert.equal(blind.calls.length, 0)
  assert.equal(second.rows[0].reason, PANE_RECHECK_REFUSALS.UNREADABLE)
})

test('a pane host shell that reacquired a terminal inside the window is no longer an orphan', () => {
  const spy = killSpy()
  const identity = paneSequence([
    paneIdentity(PANE_ORPHAN, PANE_START),
    { ok: true, reason: null, present: true, ppid: 1, tty: 'ttys009', start: PANE_START, command: PANE_ORPHAN.command },
  ])
  const pane = panePass({ reclaim: true, deps: paneDepsFor(spy, [PANE_ORPHAN], { identity }) })
  assert.equal(spy.calls.length, 0)
  assert.equal(pane.rows[0].reason, PANE_RECHECK_REFUSALS.CHANGED)
  assert.equal(pane.totals.refused_recheck, 1)
})

test('TL10 production paneSleep settles before signal-zero and both reclaim keys are required before a pane host shell is signalled', () => {
  assert.equal(parseArgs(['--reclaim']).reclaimPaneShells, false)
  assert.equal(parseArgs(['--reclaim-pane-shells']).reclaimPaneShells, false)
  assert.equal(parseArgs(['--reclaim-pane-shells']).dryRun, true)
  assert.equal(parseArgs(['--reclaim', '--reclaim-pane-shells']).reclaimPaneShells, true)
  assert.equal(parseArgs(['--reclaim', '--reclaim-pane-shells', '--dry-run']).reclaimPaneShells, false)
  assert.equal(parseArgs(['--dry-run', '--reclaim', '--reclaim-pane-shells']).reclaimPaneShells, false)
  const spy = killSpy({ settles: [PANE_ORPHAN.pid] })
  const pane = panePass({ reclaim: true, deps: paneDepsFor(spy, [PANE_TTY, PANE_ORPHAN], { identity: (pid) => paneIdentity(pid === PANE_TTY.pid ? PANE_TTY : PANE_ORPHAN) }) })
  assert.deepEqual(spy.calls, [[PANE_ORPHAN.pid, 'SIGTERM'], [PANE_ORPHAN.pid, 0]])
  assert.equal(pane.totals.signalled, 1)
  assert.equal(pane.totals.proven, 1)
  assert.equal(pane.outcome, PANE_OUTCOMES.RECLAIMED)

  const productionOrder = []
  const productionSpy = killSpy({ settles: [PANE_ORPHAN.pid] })
  const production = panePass({
    reclaim: true,
    deps: {
      kill: (pid, signal) => {
        productionOrder.push(['kill', signal])
        return productionSpy.kill(pid, signal)
      },
      paneSnapshot: () => ({ ok: true, rows: [PANE_ORPHAN] }),
      fdProbe: () => ORPHAN_FDS,
      identityProbe: () => paneIdentity(PANE_ORPHAN),
      paneSleep: (ms) => productionOrder.push(['paneSleep', ms]),
    },
  })
  assert.deepEqual(productionOrder, [
    ['kill', 'SIGTERM'],
    ['paneSleep', PANE_SETTLE_MS],
    ['kill', 0],
  ])
  assert.deepEqual(productionSpy.calls, [[PANE_ORPHAN.pid, 'SIGTERM'], [PANE_ORPHAN.pid, 0]])
  assert.equal(production.totals.proven, 1)

  // And the invariant holds where the SWEEP is, not only where the flags are
  // parsed: a direct caller naming both dryRun and the selector signals nothing.
  const dryRoot = newRoot()
  const dry = killSpy({ settles: [PANE_ORPHAN.pid] })
  const dryPass = reapPass({
    root: dryRoot,
    dryRun: true,
    reclaimPaneShells: true,
    deps: { ...paneDepsFor(dry, [PANE_ORPHAN]), snapshot: () => snapshotOf([]) },
  })
  assert.deepEqual(dry.calls, [])
  assert.equal(dryPass.dry_run, true)
  assert.equal(dryPass.pane.reclaim, false)
})

test('the pane subprocess parsers read recorded ps and lsof output', () => {
  const ps = paneShellSnapshot({ spawnSync: () => ({ status: 0, stdout: PS_CAPTURE, stderr: '', error: null }) })
  assert.equal(ps.ok, true)
  assert.deepEqual(ps.rows[2], { pid: 83020, ppid: 83019, tty: 'ttys001', command: '-/opt/homebrew/bin/nu --execute use ghostty *' })
  assert.equal(paneShellSnapshot({ spawnSync: () => ({ status: 1, stdout: '', stderr: '', error: null }) }).ok, false)

  // ONE ps answer must supply the whole identity, START and current command
  // together: a command taken from a second reading is a command belonging to
  // whatever holds that pid by then. The stub therefore THROWS on any second
  // call, and records what it was handed so the declared LC_ALL=C shape is
  // pinned too.
  const answer = (status, stdout) => ({ status, stdout, stderr: '', error: null })
  const oneAnswer = (stdout, status = 0) => {
    const seen = []
    return {
      seen,
      spawnSync: (_bin, argv, options) => {
        seen.push({ argv, options })
        if (seen.length > 1) throw new Error('paneShellIdentity took a second ps reading')
        return answer(status, stdout)
      },
    }
  }
  const single = oneAnswer(PS_IDENTITY_CAPTURE)
  const identity = paneShellIdentity(77238, { spawnSync: single.spawnSync })
  assert.deepEqual(identity, { ok: true, reason: null, present: true, ppid: 77237, tty: 'ttys000', start: 'Wed Sep  2 14:40:27 2026', command: '-/opt/homebrew/bin/nu' })
  assert.equal(single.seen.length, 1)
  assert.equal(single.seen[0].argv[1], 'pid=,ppid=,tty=,lstart=,command=')
  assert.equal(single.seen[0].options.env.LC_ALL, 'C')
  // ps exits with EXACTLY status 1 and an empty table for a pid that is simply
  // gone. That is a measured absence, not a failed probe.
  const gone = paneShellIdentity(60000, { spawnSync: oneAnswer('', 1).spawnSync })
  assert.deepEqual([gone.ok, gone.present], [true, false])
  // Every other pairing of status and output is a probe that did not answer.
  for (const [status, stdout] of [[0, ''], [2, ''], [1, 'ps: some other complaint\n']]) {
    const blind = paneShellIdentity(60000, { spawnSync: oneAnswer(stdout, status).spawnSync })
    assert.deepEqual([blind.ok, blind.present, blind.reason], [false, false, PANE_UNKNOWN_REASONS.IDENTITY], `status ${status} stdout ${JSON.stringify(stdout)}`)
  }
  // A row that describes another process, and a row missing the command
  // column, are both non-answers: the whole row validates or nothing does.
  for (const row of ['99999 77237 ttys000  Wed Sep  2 14:40:27 2026     -/opt/homebrew/bin/nu\n', '77238 77237 ttys000  Wed Sep  2 14:40:27 2026\n']) {
    const partialRow = paneShellIdentity(77238, { spawnSync: oneAnswer(row).spawnSync })
    assert.deepEqual([partialRow.ok, partialRow.reason], [false, PANE_UNKNOWN_REASONS.IDENTITY], row)
  }

  const fds = paneShellFds(75753, { spawnSync: () => ({ status: 0, stdout: LSOF_CAPTURE, stderr: '', error: null }) })
  assert.deepEqual(fds.fds, [3, 4])
  assert.equal(fds.cwd, PANE_DEAD_CWD)
  // A nonzero status is unmeasured even when stdout carries a partial table.
  const partial = paneShellFds(75753, { spawnSync: () => ({ status: 1, stdout: 'p1\nf3\ntPIPE\n', stderr: '', error: null }) })
  assert.deepEqual([partial.ok, partial.reason, partial.fds], [false, PANE_UNKNOWN_REASONS.FD_PROBE, []])
  const empty = paneShellFds(75753, { spawnSync: () => ({ status: 0, stdout: '', stderr: '', error: null }) })
  assert.deepEqual([empty.ok, empty.reason], [false, PANE_UNKNOWN_REASONS.FD_EMPTY])
})

test('the pane sweep leaves every descendant verdict of the same pass untouched', () => {
  const root = newRoot()
  deadRun(root)
  const base = {
    kill: killSpy({ esrch: [-42] }).kill,
    snapshot: () => snapshotOf([]),
    sleep: () => {},
    fdProbe: () => ORPHAN_FDS,
    identityProbe: () => paneIdentity(PANE_ORPHAN),
  }
  const quiet = reapPass({ root, dryRun: true, deps: { ...base, paneSnapshot: () => ({ ok: true, rows: [] }) } })
  const loud = reapPass({ root, dryRun: true, deps: { ...base, paneSnapshot: () => ({ ok: true, rows: [PANE_ORPHAN] }) } })
  assert.equal(loud.pane.totals.orphan, 1)
  assert.equal(quiet.pane.totals.orphan, 0)
  const descendantHalf = (pass) => JSON.stringify({ tasks: pass.tasks, totals: pass.totals, outcome: pass.outcome })
  assert.equal(descendantHalf(loud), descendantHalf(quiet))
  assert.match(formatReport(loud).join('\n'), /pane-outcome: pending-pane-orphans/)
})

test('a pane host shell recycled during the descriptor probe is refused: the identity is the last reading before the signal', () => {
  const spy = killSpy()
  let fdCalls = 0
  const pane = panePass({
    reclaim: true,
    deps: paneDepsFor(spy, [PANE_ORPHAN], {
      probe: () => { fdCalls += 1; return ORPHAN_FDS },
      // The pid is recycled DURING the recheck's descriptor probe: the identity
      // still reads the enumerated start until that second probe has run, so
      // only the probe-first order sees the change.
      identity: () => paneIdentity(PANE_ORPHAN, fdCalls >= 2 ? 'Sun Sep  6 09:20:57 2026' : PANE_START),
    }),
  })
  assert.ok(fdCalls >= 2, `expected the recheck to take its own descriptor reading, found ${fdCalls}`)
  assert.equal(spy.calls.length, 0)
  assert.equal(pane.rows[0].reason, PANE_RECHECK_REFUSALS.MISMATCH)
  assert.equal(pane.totals.refused_recheck, 1)
})

test("a pane host shell that exec'd another program is refused before the signal", () => {
  const spy = killSpy()
  const pane = panePass({
    reclaim: true,
    deps: paneDepsFor(spy, [PANE_ORPHAN], {
      // Same pid, same start — but it is running a different program now, so
      // the enumerated command proves nothing about what would be signalled.
      identity: paneSequence([
        paneIdentity(PANE_ORPHAN),
        paneIdentity(PANE_ORPHAN, PANE_START, '/usr/bin/rsync -a /vault /backup'),
      ]),
    }),
  })
  assert.equal(spy.calls.length, 0)
  assert.equal(pane.rows[0].reason, PANE_RECHECK_REFUSALS.EXECED)
  assert.equal(pane.totals.refused_recheck, 1)
})

test('an unknown pane candidate is never reported as a clean sweep or a completed reclaim', () => {
  const probe = (pid) => (pid === PANE_UNMEASURED.pid
    ? { ok: false, reason: PANE_UNKNOWN_REASONS.FD_PROBE, fds: [], cwd: null }
    : ORPHAN_FDS)
  const identity = (pid) => paneIdentity(pid === PANE_UNMEASURED.pid ? PANE_UNMEASURED : PANE_ORPHAN)
  const alone = panePass({ deps: paneDepsFor(killSpy(), [PANE_UNMEASURED], { probe, identity }) })
  assert.deepEqual([alone.totals.orphan, alone.totals.unknown], [0, 1])
  assert.equal(alone.outcome, PANE_OUTCOMES.UNMEASURED)
  const mixed = panePass({
    reclaim: true,
    deps: paneDepsFor(killSpy({ settles: [PANE_ORPHAN.pid] }), [PANE_UNMEASURED, PANE_ORPHAN], { probe, identity }),
  })
  assert.deepEqual([mixed.totals.proven, mixed.totals.unknown], [1, 1])
  assert.equal(mixed.outcome, PANE_OUTCOMES.PARTIAL)
  // Non-vacuous: the same pass WITHOUT the unmeasured row must reach RECLAIMED,
  // or PARTIAL above would only mean the reclaim never worked.
  const clean = panePass({
    reclaim: true,
    deps: paneDepsFor(killSpy({ settles: [PANE_ORPHAN.pid] }), [PANE_ORPHAN], { probe, identity }),
  })
  assert.equal(clean.outcome, PANE_OUTCOMES.RECLAIMED)
})

test('main threads both reclaim keys through to the pane sweep', async () => {
  const root = newRoot()
  const spy = killSpy({ settles: [PANE_ORPHAN.pid] })
  const out = []
  const deps = {
    ...paneDepsFor(spy, [PANE_ORPHAN]),
    snapshot: () => snapshotOf([]),
    stdout: (text) => out.push(text),
    stderr: () => {},
  }
  assert.equal(await main(['--reclaim', '--reclaim-pane-shells', '--root', root], deps), 0)
  assert.deepEqual(spy.calls, [[PANE_ORPHAN.pid, 'SIGTERM'], [PANE_ORPHAN.pid, 0]])
  assert.match(out.join(''), /pane-outcome: pane-orphans-reclaimed/)
  // The same invocation without the class selector still enumerates and
  // reports — and signals nothing.
  const quiet = killSpy({ settles: [PANE_ORPHAN.pid] })
  const quietOut = []
  assert.equal(await main(['--reclaim', '--root', root], { ...deps, kill: quiet.kill, stdout: (text) => quietOut.push(text) }), 0)
  assert.deepEqual(quiet.calls, [])
  assert.match(quietOut.join(''), /pane-outcome: pending-pane-orphans/)
})
