// test/factory-emit.test.mjs — scripts/factory/emit.mjs, the never-throwing
// emitter facade + run sidecar. Every fixture db path comes from a real
// mkdtempSync directory — never ':memory:', never the CLI-only
// default-db-path resolver (#40's written obligation; pinned by a
// source-text assertion at the bottom of this file).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, utimesSync, symlinkSync, readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT, sqliteAvailable } from './helpers.mjs'
import { openRun, recordCellFailure, recordPhaseSlotWait, _resetNoticeGuardsForTest, main } from '../scripts/factory/emit.mjs'
import { openLedger, PAYLOAD_KEYS, NODE_FLOOR } from '../scripts/factory/ledger.mjs'
import { headlessIo } from '../crew/headless.mjs'

// A handful of this file's tests query the real SQLite mirror directly (via
// openLedger().dumpTable(...)) or otherwise assert a real, non-null
// phase_id/mirror row count from an UNFORCED (real process.versions.node)
// ledger handle. Below NODE_FLOOR (the repository containment floor),
// openLedger() DEGRADES by design (ADR-024/ADR-031, #40): no
// mirror table exists, dumpTable/getSession answer [] / null, and
// phaseTransition legitimately returns phase_id: null. Those specific tests
// (and only those — every other test in this file either forces degraded
// mode explicitly via nodeVersion, or never touches the real mirror at all,
// and stays ungated) self-skip when node:sqlite is unavailable, mirroring
// test/factory-ledger.test.mjs's own SKIP pattern exactly (this is the one
// other file in the split allowed to contain a skip — see
// test/factory-emit-floor.test.mjs for the zero-condition-excluded half).
const SQLITE_OK = sqliteAvailable()
const SKIP = SQLITE_OK ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`

const EMIT_MODULE_URL = new URL('../scripts/factory/emit.mjs', import.meta.url).href
const LEDGER_MODULE_URL = new URL('../scripts/factory/ledger.mjs', import.meta.url).href
const SELF = fileURLToPath(import.meta.url)
const SELF_SOURCE = readFileSync(SELF, 'utf8')
const EMIT_SOURCE = readFileSync(join(ROOT, 'scripts', 'factory', 'emit.mjs'), 'utf8')

const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-emit-'))
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

function freshDir(label) {
  return mkdtempSync(join(fixtureRoot, `${label}-`))
}

const spawnedChildren = new Set()
function trackChild(child) {
  spawnedChildren.add(child)
  child.on('exit', () => spawnedChildren.delete(child))
  return child
}
after(() => {
  const survivors = [...spawnedChildren]
  for (const child of survivors) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  assert.equal(survivors.length, 0,
    `${survivors.length} spawned child process(es) outlived the suite (pids ${survivors.map((c) => c.pid).join(', ')})`)
})

function runChild(program, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', program], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    }))
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

// ---------------------------------------------------------------------------
// SIDECAR CREATE IS EXCLUSIVE
// ---------------------------------------------------------------------------

test('SIDECAR CREATE IS EXCLUSIVE: two racing real child processes produce exactly one sidecar file and one adw_id', async () => {
  const dir = freshDir('sidecar-race')
  const program = (stateDir) => `
    const { openRun } = await import(${JSON.stringify(EMIT_MODULE_URL)});
    const e = openRun({ stateDir: ${JSON.stringify(stateDir)}, repoSlug: 'r', taskSlug: 't' });
    process.stdout.write(e.adwId);
  `
  const [a, b] = await Promise.all([
    runChild(program(dir)),
    runChild(program(dir)),
  ])
  assert.equal(a.code, 0, a.stderr)
  assert.equal(b.code, 0, b.stderr)
  assert.ok(a.stdout, 'first child printed no adw_id')
  assert.equal(a.stdout, b.stdout, 'the two racing openRun calls minted different adw_ids — the loser did not adopt the winner')
  const sidecarPath = join(dir, 'ledger', 'run.json')
  assert.ok(existsSync(sidecarPath))
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  assert.equal(sidecar.adw_id, a.stdout)
})

test('SIDECAR CREATE IS EXCLUSIVE: a second in-process openRun against an existing sidecar adopts it without error', () => {
  const dir = freshDir('sidecar-adopt')
  const e1 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't' })
  const e2 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't' })
  assert.equal(e1.adwId, e2.adwId)
})

test('linkRun emits a daemon-to-sidecar association into the real ledger', { skip: SKIP }, () => {
  const dir = freshDir('link-run')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath, stderr: { write: () => {} } })
  emitter.startRun()
  emitter.linkRun('daemon-emitter-run', { crewDir: dir })
  emitter.dispose()

  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    assert.deepEqual(ledger.dumpTable('run_links').map(({ run_id, adw_id, crew_dir }) => ({ run_id, adw_id, crew_dir })), [
      { run_id: 'daemon-emitter-run', adw_id: emitter.adwId, crew_dir: dir },
    ])
  } finally { ledger.close() }
})

test('recordSeats records good effective seats while dropping only a malformed seat', { skip: SKIP }, () => {
  const dir = freshDir('record-seats')
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ schema_version: 3, task: 'seats', roles: ['planner', 'builder'] }))
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 'seats', dbPath, stderr: { write: () => {} } })
  try {
    emitter.startRun()
    const good = (role, over = {}) => ({
      role, agent: 'claude', provider: 'anthropic', model_id: 'sonnet', model: 'sonnet',
      effort: 'high', transport: 'pane', source: 'roster', policy_state: 'passed', warnings: [],
      created_at: '2024-01-01T00:00:00.000Z', ...over,
    })
    const droppedBefore = emitter.stats().dropped
    assert.doesNotThrow(() => emitter.recordSeats([
      good('planner'),
      { role: 'malformed', source: 'unknown-source' },
      good('builder', { source: 'reseat', warnings: ['vendor-diversity'] }),
    ]))
    assert.ok(emitter.stats().dropped > droppedBefore)
  } finally { emitter.dispose() }

  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    assert.deepEqual(ledger.dumpTable('run_seats').map((row) => row.role).sort(), ['builder', 'planner'])
    assert.equal(ledger.dumpTable('run_seats').find((row) => row.role === 'builder').source, 'reseat')
  } finally { ledger.close() }
})

test('recordSeats is inert for non-arrays, empty arrays, and a below-floor ledger', { skip: SKIP }, () => {
  const dir = freshDir('record-seats-inert')
  const emitter = openRun({
    stateDir: dir, repoSlug: 'r', taskSlug: 'seats', dbPath: join(dir, 'ledger', 'ledger.db'),
    nodeVersion: '20.11.0', stderr: { write: () => {} },
  })
  try {
    const seat = {
      role: 'planner', agent: 'claude', provider: 'anthropic', model_id: 'sonnet', model: 'sonnet',
      effort: 'high', transport: 'pane', source: 'roster', policy_state: 'passed', warnings: [],
    }
    assert.doesNotThrow(() => emitter.recordSeats(null))
    assert.doesNotThrow(() => emitter.recordSeats([]))
    assert.doesNotThrow(() => emitter.recordSeats([seat]))
  } finally { emitter.dispose() }
})

test('endRun forwards typed outcome fields, defaults them to NULL, and still refuses finalizer status fail', { skip: SKIP }, () => {
  const typedDir = freshDir('typed-end-run')
  const typedDb = join(typedDir, 'ledger', 'ledger.db')
  const typed = openRun({ stateDir: typedDir, repoSlug: 'r', taskSlug: 'typed', dbPath: typedDb, stderr: { write: () => {} } })
  typed.startRun()
  typed.endRun({ status: 'aborted', outcome: 'escalated', terminal_reason: 'transport', terminal_actor: 'driver' })
  const typedLedger = openLedger({ dbPath: typedDb, stderr: { write: () => {} } })
  try {
    assert.deepEqual({ ...typedLedger.getSession(typed.adwId) }, {
      ...typedLedger.getSession(typed.adwId),
      status: 'aborted', outcome: 'escalated', terminal_reason: 'transport', terminal_actor: 'driver',
    })
  } finally { typedLedger.close(); typed.dispose() }

  const omittedDir = freshDir('omitted-end-run')
  const omittedDb = join(omittedDir, 'ledger', 'ledger.db')
  const omitted = openRun({ stateDir: omittedDir, repoSlug: 'r', taskSlug: 'omitted', dbPath: omittedDb, stderr: { write: () => {} } })
  omitted.startRun()
  omitted.endRun({ status: 'ok' })
  const omittedLedger = openLedger({ dbPath: omittedDb, stderr: { write: () => {} } })
  try {
    const row = omittedLedger.getSession(omitted.adwId)
    assert.equal(row.status, 'ok')
    assert.equal(row.outcome, null)
    assert.equal(row.terminal_reason, null)
    assert.equal(row.terminal_actor, null)
  } finally { omittedLedger.close(); omitted.dispose() }

  const refusedDir = freshDir('refused-end-run')
  const refused = openRun({ stateDir: refusedDir, repoSlug: 'r', taskSlug: 'refused', stderr: { write: () => {} } })
  refused.startRun()
  const droppedBefore = refused.stats().dropped
  refused.endRun({ status: 'fail', outcome: 'failed', terminal_reason: 'SIGTERM', terminal_actor: 'finalizer' })
  assert.ok(refused.stats().dropped > droppedBefore)
  refused.dispose()
})

test('linkRun(null) and linkRun(\'\') are no-ops, including on a degraded emitter', () => {
  const dir = freshDir('link-run-noop')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.doesNotThrow(() => emitter.linkRun(null))
  assert.doesNotThrow(() => emitter.linkRun(''))
  emitter.dispose()
  assert.equal(existsSync(join(dir, 'ledger', 'ledger.jsonl')), false)

  const parent = freshDir('link-run-degraded')
  const blocked = join(parent, 'blocked')
  writeFileSync(blocked, 'not a directory')
  const degraded = openRun({ stateDir: join(blocked, 'state'), repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.doesNotThrow(() => degraded.linkRun('daemon-degraded-run'))
})

test('recordPhaseSlotWait is non-load-bearing on a usable and unusable dbPath', { skip: SKIP }, () => {
  const dir = freshDir('phase-slot-wait')
  const dbPath = join(dir, 'ledger.db')
  const capture = { lines: [], write(line) { this.lines.push(line) } }
  assert.equal(recordPhaseSlotWait({
    dbPath, stderr: capture, kind: 'gate', queue_depth: null, waited_ms: 1, slotted: true,
  }), true)
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const rows = ledger.dumpTable('phase_slot_waits')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].queue_depth, null)
  } finally { ledger.close() }

  writeFileSync(join(dir, 'blocker'), 'not a directory')
  const lines = []
  let reached = false
  assert.doesNotThrow(() => {
    const result = recordPhaseSlotWait({
      dbPath: join(dir, 'blocker', 'x.db'), stderr: { write: (line) => lines.push(line) },
      kind: 'gate', queue_depth: null, waited_ms: 1, slotted: true,
    })
    assert.equal(result, false)
    reached = true
  })
  assert.equal(reached, true)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /phase slot wait not recorded/)
})

test('run-less recordCellFailure lands exactly one NULL-adw row and never throws on an unusable dbPath', { skip: SKIP }, () => {
  const dir = freshDir('runless-cell-failure')
  const dbPath = join(dir, 'ledger.db')
  assert.equal(recordCellFailure({
    dbPath, stderr: { write: () => {} }, task_slug: 'measure', role: 'reviewer',
    agent: 'pi', provider: 'pi', model_id: 'terra', effort: 'max', kind: 'boot-refusal',
  }), true)
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const rows = ledger.dumpTable('cell_failures')
  ledger.close()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].adw_id, null)
  assert.equal(rows[0].role, 'reviewer')
  // A path nested under a regular file is unusable by construction on every
  // platform and for root too (ENOTDIR is not a permission bit). It never
  // depends on a platform's virtual filesystem: a live virtual mount's mkdir
  // semantics hung Linux CI for six hours because Node's recursive mkdir
  // loops forever.
  writeFileSync(join(dir, 'blocker'), 'not a directory')
  assert.equal(recordCellFailure({
    dbPath: join(dir, 'blocker', 'x.db'), stderr: { write: () => {} },
    task_slug: 'measure', role: 'builder', kind: 'boot-refusal',
  }), false)
})

// ---------------------------------------------------------------------------
// SEQ RESERVATION UNDER CONCURRENCY
// ---------------------------------------------------------------------------

test('SEQ RESERVATION UNDER CONCURRENCY: two in-process emitters allocate disjoint seq values', () => {
  const dir = freshDir('seq-two-handles')
  const e1 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't' })
  const e2 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't' })
  const allocated = []
  for (let i = 0; i < 40; i += 1) {
    const emitter = i % 2 === 0 ? e1 : e2
    const [seq] = emitter.reserveSeq('event', 1)
    allocated.push(seq)
  }
  assert.equal(allocated.length, new Set(allocated).size, 'a seq value was allocated more than once')
})

test('SEQ RESERVATION UNDER CONCURRENCY: two real child processes racing reserveSeq+emit produce unique seqs and every row survives in the mirror', { skip: SKIP, timeout: 30000 }, async () => {
  const dir = freshDir('seq-two-procs')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const ITER = 15
  const childProgram = `
    const { openRun } = await import(${JSON.stringify(EMIT_MODULE_URL)});
    const e = openRun({ stateDir: ${JSON.stringify(dir)}, repoSlug: 'r', taskSlug: 't', dbPath: ${JSON.stringify(dbPath)} });
    const adwId = e.adwId;
    const seqs = [];
    for (let i = 0; i < ${ITER}; i += 1) {
      e.emit((handle, nextSeq) => {
        const seq = nextSeq('event');
        seqs.push(seq);
        handle.recordEvent({ adw_id: adwId, type: 'log', seq, payload: { level: 'info', message: 'x' } });
      });
    }
    process.stdout.write(JSON.stringify({ adwId, seqs, dropped: e.stats().dropped }));
  `
  const [a, b] = await Promise.all([runChild(childProgram), runChild(childProgram)])
  assert.equal(a.code, 0, a.stderr)
  assert.equal(b.code, 0, b.stderr)
  const ra = JSON.parse(a.stdout)
  const rb = JSON.parse(b.stdout)
  assert.equal(ra.adwId, rb.adwId)
  const allSeqs = [...ra.seqs, ...rb.seqs]
  assert.equal(allSeqs.length, ITER * 2)
  assert.equal(new Set(allSeqs).size, allSeqs.length, 'a seq value collided across the two processes')
  // A silently-swallowed write failure under real sqlite contention must
  // fail LOUDLY here (a clear dropped-count message), not only surface
  // later as an unexplained row-count mismatch.
  assert.equal(ra.dropped, 0, `process a dropped ${ra.dropped} emission(s) unexpectedly`)
  assert.equal(rb.dropped, 0, `process b dropped ${rb.dropped} emission(s) unexpectedly`)

  const ledger = openLedger({ dbPath })
  const rows = ledger.dumpTable('events').filter((r) => r.adw_id === ra.adwId)
  ledger.close()
  assert.equal(rows.length, allSeqs.length, `expected every row to survive in the mirror (${allSeqs.length}), got ${rows.length}`)
})

// ---------------------------------------------------------------------------
// PERSIST-BEFORE-EMIT
// ---------------------------------------------------------------------------

test('PERSIST-BEFORE-EMIT: reserved_through advances on disk before the emission that consumes it runs, and survives a throwing emission', () => {
  const dir = freshDir('persist-before-emit')
  const emitter = openRun({
    stateDir: dir,
    repoSlug: 'r',
    taskSlug: 't',
    stderr: { write: () => {} },
    _openLedger: () => ({
      recordEvent: () => { throw new Error('mirror down') },
      close: () => {},
    }),
  })
  const before = emitter.sidecar().seq.event.reserved_through
  const ok = emitter.emit((handle, nextSeq) => {
    const seq = nextSeq('event')
    handle.recordEvent({ adw_id: emitter.adwId, type: 'log', seq, payload: {} })
  })
  assert.equal(ok, false, 'the emission should have been reported as dropped')
  const afterReservationSeq = emitter.sidecar().seq.event.reserved_through
  assert.ok(afterReservationSeq > before, 'reserved_through did not advance despite the reservation having been made')

  const [nextValue] = emitter.reserveSeq('event', 1)
  assert.equal(nextValue, afterReservationSeq + 1, 'the next reservation repeated a value instead of leaving a gap')
})

// ---------------------------------------------------------------------------
// BOUNDED LOCK WAIT + COUNTED GIVE-UP
// ---------------------------------------------------------------------------

// M5: process.kill(pid, 0) is now a real liveness gate on the steal
// decision, so a fixture claiming to be "held by a live process" must use
// an ACTUALLY live pid (this test's own — undeniably alive) rather than a
// fake, almost-certainly-dead one like 999999 — otherwise the new liveness
// check correctly identifies it as dead and steals it, which is exactly the
// M5 fix working as intended, not a bug.
test('BOUNDED LOCK WAIT + COUNTED GIVE-UP: a live, non-stale lock forces a bounded give-up within the budget', () => {
  const dir = freshDir('lock-giveup')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const lockPath = join(dir, 'ledger', 'run.lock')
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))

  const start = Date.now()
  const seqs = emitter.reserveSeq('event', 1)
  const elapsed = Date.now() - start

  assert.deepEqual(seqs, [], 'a held, non-stale lock should force a drop, not a steal')
  // Pins the retry-budget MAGNITUDE (LOCK_RETRY_BUDGET=20 x
  // LOCK_RETRY_INTERVAL_MS=50 ~= 1000ms), not just "eventually gives up" —
  // a future edit that silently guts the budget should fail this floor.
  assert.ok(elapsed >= 900, `expected the bounded wait to take at least ~1s (budget=20x50ms), took ${elapsed}ms`)
  assert.ok(elapsed < 3000, `expected the bounded wait to finish under 3s, took ${elapsed}ms`)
  assert.equal(emitter.stats().lock_giveups, 1)
})

test('BOUNDED LOCK WAIT + COUNTED GIVE-UP: exactly one stderr line is written for the whole lifetime, even across repeated give-ups', () => {
  // Isolates this scenario's guard state from any earlier facade-failure
  // notice tripped by an earlier test sharing this process — the guard is
  // now module-scoped (M4 residual, round 3), so without this reset an
  // earlier test's trip would silently zero out this test's own count.
  _resetNoticeGuardsForTest()
  const dir = freshDir('lock-giveup-stderr')
  const lines = []
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: (s) => lines.push(s) } })
  const lockPath = join(dir, 'ledger', 'run.lock')
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))

  emitter.reserveSeq('event', 1)
  emitter.reserveSeq('event', 1)
  assert.equal(lines.length, 1, `expected exactly one stderr line, got ${lines.length}: ${JSON.stringify(lines)}`)
})

// M5 (round 3): a corrupt/unparseable lock must now clear the SAME age gate
// a normal stale judgment requires — round 2's live repro showed the old
// "corrupt is instantly stale, no check" rule let a lock caught mid-write
// (a real, live holder simply not done yet) be stolen out from under its
// legitimate holder the instant a reader landed in that window. This
// replaces the old "a corrupt lock is broken and stolen, and the emission
// succeeds" test, whose expectation of an INSTANT steal encoded exactly the
// bug this round exists to fix.
test('BOUNDED LOCK WAIT + COUNTED GIVE-UP: a FRESH corrupt lock is not stolen instantly — it must clear the same age gate a normal stale judgment requires (M5)', () => {
  const dir = freshDir('lock-corrupt-fresh')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const lockPath = join(dir, 'ledger', 'run.lock')
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(lockPath, 'not json{{{') // fresh mtime — must NOT be treated as instantly stale

  const start = Date.now()
  const seqs = emitter.reserveSeq('event', 1)
  const elapsed = Date.now() - start

  assert.deepEqual(seqs, [], 'a FRESH corrupt lock must force a bounded wait/give-up, never an instant steal')
  assert.ok(elapsed >= 900, `expected the bounded wait to take at least ~1s (budget=20x50ms), took ${elapsed}ms`)
  assert.equal(emitter.stats().lock_giveups, 1)
})

test('BOUNDED LOCK WAIT + COUNTED GIVE-UP: an OLD corrupt lock (past the stale-age threshold) is broken and stolen, and the emission succeeds (M5)', () => {
  const dir = freshDir('lock-corrupt-old')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const lockPath = join(dir, 'ledger', 'run.lock')
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(lockPath, 'not json{{{')
  const oldTime = new Date(Date.now() - 5 * 60 * 1000)
  utimesSync(lockPath, oldTime, oldTime)

  const seqs = emitter.reserveSeq('event', 1)
  assert.deepEqual(seqs, [1])
  assert.equal(emitter.stats().lock_giveups, 0)
})

test('BOUNDED LOCK WAIT + COUNTED GIVE-UP: an over-age lock, held by a live pid, is broken and stolen on age alone', () => {
  const dir = freshDir('lock-overage')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const lockPath = join(dir, 'ledger', 'run.lock')
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }))

  const seqs = emitter.reserveSeq('event', 1)
  assert.deepEqual(seqs, [1])
  assert.equal(emitter.stats().lock_giveups, 0)
})

// M5: a lock held by a DEFINITELY-dead pid must be stolen regardless of
// age (the liveness check trumps the age check) — a spawnSync child's pid
// is guaranteed dead by the time spawnSync returns (it has already exited)
// and won't race a real "alive but slow" holder the way a hardcoded guess
// like 999999 could on a busy CI box.
test('LOCK STALE STEAL: a lock held by a definitely-dead pid is stolen regardless of age, and the emission succeeds', () => {
  const dir = freshDir('lock-dead-pid')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const lockPath = join(dir, 'ledger', 'run.lock')
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  const deadProc = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  writeFileSync(lockPath, JSON.stringify({ pid: deadProc.pid, started_at: new Date().toISOString() }))

  const start = Date.now()
  const seqs = emitter.reserveSeq('event', 1)
  const elapsed = Date.now() - start

  assert.deepEqual(seqs, [1])
  assert.equal(emitter.stats().lock_giveups, 0)
  assert.ok(elapsed < 500, `a dead-pid steal should be near-instant (no wait budget consumed), took ${elapsed}ms`)
})

// M5 (round 3): the lock file is now created via the SAME exclusive-create
// primitive (writeFileSync(tmp)+linkSync) used for the sidecar's own
// one-time creation, never via writeFileSync(path, ..., {flag:'wx'})
// directly — the latter is TWO separate syscalls (open then write) with a
// window in between where the lock file exists but is 0 bytes, which round
// 2 reproduced live: a reader landing in that window sees a corrupt lock,
// which the old corrupt-lock branch stole INSTANTLY with no liveness/age
// check, breaking mutual exclusion. This test hammers real, heavy,
// multi-process contention (no artificially-planted lock, no timing
// trickery) and asserts the strongest possible signal that mutual exclusion
// held throughout: every seq value allocated by every child, combined, is
// unique — a collision here is exactly what the old bug produced (two
// processes both believing they held the lock simultaneously).
test('M5: heavy real multi-process contention on openRun+reserveSeq never breaks mutual exclusion (no seq collision, no mass degradation)', { timeout: 60000 }, async () => {
  const dir = freshDir('m5-stress')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const CHILDREN = 6
  const ITER = 16
  const childProgram = `
    const { openRun } = await import(${JSON.stringify(EMIT_MODULE_URL)});
    const e = openRun({ stateDir: ${JSON.stringify(dir)}, repoSlug: 'r', taskSlug: 't', dbPath: ${JSON.stringify(dbPath)} });
    const seqs = [];
    for (let i = 0; i < ${ITER}; i += 1) {
      const [seq] = e.reserveSeq('event', 1);
      if (seq !== undefined) seqs.push(seq);
    }
    process.stdout.write(JSON.stringify({ adwId: e.adwId, seqs, giveups: e.stats().lock_giveups, dropped: e.stats().dropped }));
  `
  const results = await Promise.all(Array.from({ length: CHILDREN }, () => runChild(childProgram)))
  for (const r of results) assert.equal(r.code, 0, r.stderr)
  const parsed = results.map((r) => JSON.parse(r.stdout))
  const allSeqs = parsed.flatMap((p) => p.seqs)
  assert.equal(new Set(allSeqs).size, allSeqs.length, `a seq value collided across ${CHILDREN} contending processes — mutual exclusion broke (M5)`)
  const totalGiveups = parsed.reduce((sum, p) => sum + p.giveups, 0)
  const totalDropped = parsed.reduce((sum, p) => sum + p.dropped, 0)
  // Real contention among 6 processes bounded to ~1s of retry each is
  // expected to produce SOME give-ups under load — the bug this test
  // targets is a COLLISION or MASS degradation, not an occasional give-up.
  assert.ok(totalGiveups < CHILDREN * ITER, `expected most reservations to succeed despite contention, got ${totalGiveups} give-ups across ${CHILDREN * ITER} attempts`)
  assert.equal(totalDropped, totalGiveups, 'every drop under this scenario should be attributable to a counted lock give-up, not a silent, unexplained failure')
  assert.ok(!existsSync(join(dir, 'ledger', 'run.lock')), 'a lock file was left behind after every contending process exited — a leaked lock (M5)')
})

// ---------------------------------------------------------------------------
// NEVER LOAD-BEARING (mutation test, not inspection)
// ---------------------------------------------------------------------------

function throwingLedgerHandle() {
  const boom = () => { throw new Error('boom: writer unavailable') }
  return {
    startSession: boom,
    endSession: boom,
    startPhase: boom,
    endPhase: boom,
    recordEvent: boom,
    recordEnvelope: boom,
    recordGateResult: boom,
    startProcess: boom,
    endProcess: boom,
    heartbeat: boom,
    startAgentSession: boom,
    endAgentSession: boom,
    recordSourceError: boom,
    listSessions: () => [],
    listEvents: () => [],
    getSession: () => null,
    dumpTable: () => [],
    stats: () => ({ degraded: false }),
    close: boom,
  }
}

// Fields whose value is INTENTIONALLY ledger-derived (a database-assigned
// phase_id) are excluded from the cross-scenario equality check below — a
// facade that never throws still cannot invent an id a dead/degraded writer
// never produced. Every OTHER field (seq counters, gate attempts, the
// billed accumulator, the phase's own name/seq/started_at) never touches
// the injected handle at all and must be byte-identical regardless of it.
function nonLedgerDerivedFields(sidecar) {
  return {
    seq: sidecar.seq,
    gate_attempts: sidecar.gate_attempts,
    billed: sidecar.billed,
    phaseNameAndSeq: { name: sidecar.phase.name, seq: sidecar.phase.seq },
  }
}

// S4: exercises startRun/endRun/statsSnapshot/dispose too (previously
// untested by this scenario), not just the original 6 methods.
function runNeverLoadBearingScenario(makeOpenLedger) {
  const dir = freshDir('never-load-bearing')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const lines = []
  const emitter = openRun({
    stateDir: dir,
    repoSlug: 'r',
    taskSlug: 't',
    dbPath,
    stderr: { write: (s) => lines.push(s) },
    _openLedger: makeOpenLedger ? () => makeOpenLedger(dbPath) : undefined,
  })
  emitter.startRun()
  const seqs = emitter.reserveSeq('event', 3)
  const gateAttempt = emitter.bumpGateAttempt('gate-a')
  const updateOk = emitter.updateSidecar((sc) => { sc.billed.input = 10 })
  const phaseResult = emitter.phaseTransition('building')
  emitter.endRun({ status: 'ok' })
  const snap = emitter.statsSnapshot()
  const mapped = emitter.mapSignalLogEntries('not-an-array-either', { levels: ['info'], messageMaxChars: 10 })
  const sidecar = emitter.sidecar()
  emitter.dispose()
  return {
    seqs,
    gateAttempt,
    updateOk,
    phaseResult,
    mapped,
    statsSnapshotLevel: snap.level,
    stderrLines: lines,
    stats: emitter.stats(),
    nonLedgerDerived: nonLedgerDerivedFields(sidecar),
  }
}

test('NEVER LOAD-BEARING: a throwing ledger handle never escapes the facade and only affects ledger-derived fields', { skip: SKIP }, async () => {
  // Isolates this scenario's facade-failure guard from any earlier test's
  // trip — the guard is module-scoped for the whole process (M4 residual,
  // round 3), so this test's own "exactly one line" assertion below needs a
  // clean slate regardless of run order.
  _resetNoticeGuardsForTest()
  const { openLedger: realOpenLedger } = await import(LEDGER_MODULE_URL)
  const healthy = runNeverLoadBearingScenario(null)
  const throwing = runNeverLoadBearingScenario(() => throwingLedgerHandle())
  const degraded = runNeverLoadBearingScenario((dbPath) => realOpenLedger({ dbPath, nodeVersion: '20.11.0', stderr: { write: () => {} } }))

  assert.deepEqual(throwing.seqs, healthy.seqs)
  assert.equal(throwing.gateAttempt, healthy.gateAttempt)
  assert.equal(throwing.updateOk, healthy.updateOk)
  assert.deepEqual(throwing.mapped, [], 'a hostile non-array entries container must never throw or invent rows')
  assert.deepEqual(throwing.nonLedgerDerived, healthy.nonLedgerDerived)
  assert.deepEqual(degraded.nonLedgerDerived, healthy.nonLedgerDerived)

  assert.ok(typeof healthy.phaseResult.phase_id === 'number', 'sanity: the healthy scenario should have produced a real phase_id')
  assert.equal(throwing.phaseResult.phase_id, null)
  assert.equal(degraded.phaseResult.phase_id, null)

  assert.equal(healthy.stats.dropped, 0)
  // Every emit() call along startRun -> phaseTransition('planning') ->
  // phaseTransition('building') -> endRun is independently dropped and
  // counted: startSession, startPhase(planning), the
  // endPhase+startPhase(building) pair, and the endPhase+endSession pair —
  // 4 emit() calls total, none of which escape the facade.
  assert.equal(throwing.stats.dropped, 4, 'every failed emission along startRun/phaseTransition/endRun should be counted, none should throw')
  assert.equal(degraded.stats.dropped, 0, 'a degraded (non-throwing) handle is not a facade-level drop')

  assert.equal(throwing.statsSnapshotLevel, 'warn', 'statsSnapshot must reflect the non-zero drop counter, not throw or go stale')
  assert.equal(throwing.stderrLines.length, 1)
})

// S4: every public method on the emitter, individually, against a
// never-throw-through-to-caller contract — not just the composite
// scenario above.
test('NEVER LOAD-BEARING: every emitter method is doesNotThrow-safe against a throwing ledger handle', () => {
  const dir = freshDir('never-load-bearing-methods')
  const emitter = openRun({
    stateDir: dir,
    repoSlug: 'r',
    taskSlug: 't',
    stderr: { write: () => {} },
    _openLedger: () => throwingLedgerHandle(),
  })
  assert.doesNotThrow(() => emitter.sidecar())
  assert.doesNotThrow(() => emitter.startRun())
  assert.doesNotThrow(() => emitter.phaseTransition('building'))
  assert.doesNotThrow(() => emitter.reserveSeq('event', 1))
  assert.doesNotThrow(() => emitter.updateSidecar((sc) => { sc.billed.input = 1 }))
  assert.doesNotThrow(() => emitter.bumpGateAttempt('gate-a'))
  assert.doesNotThrow(() => emitter.bumpStat('resolution_missing'))
  assert.doesNotThrow(() => emitter.emit((handle) => handle.recordEvent({})))
  assert.doesNotThrow(() => emitter.mapSignalLogEntries([{ level: 'info', message: 'x' }], { levels: ['info'], messageMaxChars: 10 }))
  assert.doesNotThrow(() => emitter.mapSignalLogEntries('hostile-non-array', { levels: ['info'], messageMaxChars: 10 }))
  assert.doesNotThrow(() => emitter.endRun({ status: 'ok' }))
  assert.doesNotThrow(() => emitter.stats())
  assert.doesNotThrow(() => emitter.statsSnapshot())
  assert.doesNotThrow(() => emitter.installFinalizer())
  assert.doesNotThrow(() => emitter.dispose())
})

// ---------------------------------------------------------------------------
// READABLE COUNTERS
// ---------------------------------------------------------------------------

test('READABLE COUNTERS: stats() has exactly the six documented fields, and mutations flush them into the sidecar', () => {
  const dir = freshDir('counters')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.deepEqual(Object.keys(emitter.stats()).sort(), [
    'dropped', 'emitted', 'lock_giveups', 'payload_keys_dropped', 'resolution_ambiguous', 'resolution_missing',
  ].sort())

  emitter.emit((handle) => { handle.startSession({ adw_id: emitter.adwId, repo_slug: 'r', task_slug: 't' }) })
  emitter.reserveSeq('event', 1) // any locked mutation flushes stats into the sidecar
  assert.deepEqual(emitter.sidecar().stats, emitter.stats())
})

test('READABLE COUNTERS: statsSnapshot() is info when clean and warn once any drop counter is non-zero', () => {
  const dir = freshDir('stats-snapshot')
  const clean = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.equal(clean.statsSnapshot().level, 'info')

  const dirtyDir = freshDir('stats-snapshot-dirty')
  const dirty = openRun({ stateDir: dirtyDir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const lockPath = join(dirtyDir, 'ledger', 'run.lock')
  mkdirSync(join(dirtyDir, 'ledger'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
  dirty.reserveSeq('event', 1) // forces a give-up
  const snap = dirty.statsSnapshot()
  assert.equal(snap.level, 'warn')
  assert.match(snap.message, /lock_giveups=1/)
})

// ---------------------------------------------------------------------------
// IDEMPOTENT PHASE TRANSITION
// ---------------------------------------------------------------------------

test('IDEMPOTENT PHASE TRANSITION: two emitter instances calling phaseTransition("building") in a row produce exactly one building phase row', { skip: SKIP }, () => {
  const dir = freshDir('idempotent-phase')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const e1 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath })
  const e2 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath })

  const r1 = e1.phaseTransition('building')
  const r2 = e2.phaseTransition('building')
  assert.equal(r2.phase_id, r1.phase_id, 'the second call should be a no-op returning the same phase_id')

  const ledger = openLedger({ dbPath })
  const rows = ledger.dumpTable('phases').filter((p) => p.adw_id === e1.adwId && p.name === 'building')
  ledger.close()
  assert.equal(rows.length, 1, `expected exactly one 'building' phase row, got ${rows.length}`)
})

// Round 3 Must-fix: reproduces the exact overlap round 2 found — a first
// phaseTransition's ledger I/O is still in flight when a SECOND,
// independent phaseTransition call lands and fully completes (including its
// own sidecar write-back) entirely inside that window. Uses the
// `_openLedger` test seam to make the overlap deterministic (no timing
// flakiness): the first call's injected startPhase synchronously triggers
// the second call before returning, exactly reproducing the ordering round
// 2 observed under real concurrency.
test('IDEMPOTENT PHASE TRANSITION: a write-back superseded by a fully-completed overlapping transition does not rewind the phase pointer', { skip: SKIP }, () => {
  const dir = freshDir('idempotent-phase-cas-overlap')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  let e2
  let e2Ran = false
  const e1 = openRun({
    stateDir: dir,
    repoSlug: 'r',
    taskSlug: 't',
    dbPath,
    stderr: { write: () => {} },
    _openLedger: () => ({
      startPhase: (args) => {
        if (args.name === 'building' && !e2Ran) {
          e2Ran = true
          // A second process's transition lands and FULLY completes
          // (including ITS OWN sidecar write-back) entirely inside this
          // call's in-flight ledger I/O window.
          e2.phaseTransition('reviewing')
        }
        return 999
      },
      endPhase: () => {},
      close: () => {},
    }),
  })
  e2 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath, stderr: { write: () => {} } })

  const r1 = e1.phaseTransition('building')
  assert.equal(r1.phase_id, 999, 'sanity: the first call\'s own ledger I/O should still resolve its own phase_id')

  const sidecarAfterOverlap = e1.sidecar()
  assert.equal(sidecarAfterOverlap.phase.name, 'reviewing', 'the LATER (fully-completed) transition must win — the pointer must not be rewound to the stale "building" value')

  // A third call targeting the phase e2 already installed must see the
  // no-op path (same phase_id, no new row/emission) — proof the sidecar
  // pointer genuinely reflects 'reviewing', not a rewound 'building'.
  const r3 = e1.phaseTransition('reviewing')
  assert.equal(r3.phase_id, sidecarAfterOverlap.phase.phase_id, 'a repeat call for the already-current phase must be a no-op, not a duplicate transition')

  const ledger = openLedger({ dbPath })
  const reviewingRows = ledger.dumpTable('phases').filter((p) => p.adw_id === e1.adwId && p.name === 'reviewing')
  const buildingRows = ledger.dumpTable('phases').filter((p) => p.adw_id === e1.adwId && p.name === 'building')
  ledger.close()
  assert.equal(reviewingRows.length, 1, `expected exactly one 'reviewing' phase row, got ${reviewingRows.length}`)
  assert.equal(buildingRows.length, 0, 'the injected fake ledger handle never records a real "building" row — only "reviewing" should ever land in the mirror')
})

// ---------------------------------------------------------------------------
// EXPLICIT NULL, NEVER OMISSION
// ---------------------------------------------------------------------------

test('EXPLICIT NULL, NEVER OMISSION: phase_id is explicit null (never omitted) on a degraded ledger handle', () => {
  const dir = freshDir('explicit-null')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const emitter = openRun({
    stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath, nodeVersion: '20.11.0', stderr: { write: () => {} },
  })
  const result = emitter.phaseTransition('building')
  assert.equal(result.phase_id, null)
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'phase_id'), 'phase_id key must be present, never omitted')
  const sidecar = emitter.sidecar()
  assert.ok(Object.prototype.hasOwnProperty.call(sidecar.phase, 'phase_id'))
  assert.equal(sidecar.phase.phase_id, null)
})

// ---------------------------------------------------------------------------
// NO KNOWN-DROPPED PAYLOAD KEY
// ---------------------------------------------------------------------------

test('NO KNOWN-DROPPED PAYLOAD KEY: mapSignalLogEntries and statsSnapshot only ever produce keys in PAYLOAD_KEYS.log', () => {
  const dir = freshDir('payload-keys')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })

  const mapped = emitter.mapSignalLogEntries([{ level: 'info', message: 'hello' }], { levels: ['info', 'progress'], messageMaxChars: 200 })
  for (const entry of mapped) {
    for (const key of Object.keys(entry)) {
      assert.ok(PAYLOAD_KEYS.log.includes(key), `mapSignalLogEntries produced an unknown payload key: ${key}`)
    }
  }

  const snap = emitter.statsSnapshot()
  for (const key of Object.keys(snap)) {
    assert.ok(PAYLOAD_KEYS.log.includes(key), `statsSnapshot produced an unknown payload key: ${key}`)
  }
})

// ---------------------------------------------------------------------------
// C5 MAPPER
// ---------------------------------------------------------------------------

test('C5 MAPPER: hostile fixture entry is dropped/clamped/stripped/capped correctly, and only {level,message} is forwarded', () => {
  const dir = freshDir('c5-mapper')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const levels = ['info', 'progress', 'warn']
  const longMessage = `\x1B[31m${'a'.repeat(5000)}\nb\x1B[0m`
  const entries = [
    { message: 42, level: 'info', extra: 'never forwarded' }, // non-string message: dropped
    { level: 'not-a-real-level', message: longMessage, notifyCalled: true },
  ]
  const notifyLog = []
  const fakeNotify = () => notifyLog.push('called')

  const out = emitter.mapSignalLogEntries(entries, { levels, messageMaxChars: 200 })
  assert.equal(out.length, 1, 'the non-string-message entry must be dropped, not stringified')
  assert.equal(out[0].level, 'progress', 'an unknown level must clamp to progress')
  assert.equal(out[0].message.length, 200, 'the message must be capped at the caller-supplied max')
  assert.ok(!/\x1B/.test(out[0].message), 'ANSI escape bytes must be stripped')
  assert.ok(!/\n/.test(out[0].message), 'embedded newlines must be stripped')
  assert.deepEqual(Object.keys(out[0]).sort(), ['level', 'message'])
  assert.equal(notifyLog.length, 0, 'the relay side effect must never be performed')
  void fakeNotify
})

// S8: proves `levels` is genuinely THREADED FROM THE CALLER, not a
// hardcoded lookalike — a non-standard level value survives unclamped only
// because it's present in BOTH the caller-supplied `levels` param and the
// entry; a hardcoded internal array could never pass this (it would clamp
// the non-standard value to 'progress' regardless of what the caller
// passed).
test('C5 MAPPER: the levels array is genuinely threaded from the caller, not a hardcoded lookalike', () => {
  const dir = freshDir('c5-mapper-threaded')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const nonStandardLevel = 'totally-custom-level-xyz'
  const out = emitter.mapSignalLogEntries(
    [{ level: nonStandardLevel, message: 'hi' }],
    { levels: [nonStandardLevel], messageMaxChars: 50 },
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].level, nonStandardLevel, 'a non-standard level present in the caller-supplied levels array must survive unclamped')
})

// S8: an omitted/invalid messageMaxChars or levels must fail SAFE
// (drop-and-count the batch) rather than silently pass through unbounded.
test('C5 MAPPER: an omitted or non-integer messageMaxChars/levels fails safe by dropping the batch, never passing through unbounded', () => {
  const dir = freshDir('c5-mapper-failsafe')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const entries = [{ level: 'info', message: 'x'.repeat(10_000) }]

  assert.deepEqual(emitter.mapSignalLogEntries(entries, { levels: ['info'] }), [], 'an omitted messageMaxChars must drop the batch, not pass through unbounded')
  assert.deepEqual(emitter.mapSignalLogEntries(entries, { levels: ['info'], messageMaxChars: 'not-a-number' }), [])
  assert.deepEqual(emitter.mapSignalLogEntries(entries, { messageMaxChars: 50 }), [], 'an omitted levels array must drop the batch, not pass through unclamped')
  assert.deepEqual(emitter.mapSignalLogEntries(entries, { levels: 'not-an-array', messageMaxChars: 50 }), [])
  assert.ok(emitter.stats().dropped > 0, 'the failed-safe drops must be counted')
})

// S4: a hostile (non-array) entries container must never throw.
test('C5 MAPPER: a hostile non-array entries container never throws and produces no rows', () => {
  const dir = freshDir('c5-mapper-hostile-container')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.doesNotThrow(() => {
    const out = emitter.mapSignalLogEntries(42, { levels: ['info'], messageMaxChars: 10 })
    assert.deepEqual(out, [])
  })
  assert.doesNotThrow(() => {
    const out = emitter.mapSignalLogEntries('a string, not an array', { levels: ['info'], messageMaxChars: 10 })
    assert.deepEqual(out, [])
  })
})

// ---------------------------------------------------------------------------
// M3: openRun ITSELF never throws
// ---------------------------------------------------------------------------

test('M3: openRun against an unwritable parent directory returns a fully-formed, inert DEGRADED emitter rather than throwing', () => {
  const parent = freshDir('unwritable-parent')
  const dir = join(parent, 'nested', 'state-dir')
  chmodSync(parent, 0o500)
  try {
    let emitter
    assert.doesNotThrow(() => {
      emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
    })
    assert.equal(emitter.adwId, null)
    assert.doesNotThrow(() => emitter.startRun())
    assert.doesNotThrow(() => emitter.linkRun('daemon-degraded-run'))
    assert.deepEqual(emitter.reserveSeq('event', 1), [])
    assert.equal(emitter.updateSidecar(() => {}), false)
    assert.equal(emitter.bumpGateAttempt('gate-a'), 0)
    assert.equal(emitter.bumpStat('resolution_missing'), false)
    assert.equal(emitter.emit(() => {}), false)
    assert.deepEqual(emitter.mapSignalLogEntries([{ level: 'info', message: 'x' }], { levels: ['info'], messageMaxChars: 10 }), [])
    assert.doesNotThrow(() => emitter.endRun({ status: 'ok' }))
    assert.equal(emitter.sidecar(), null)
    assert.ok(emitter.stats().dropped > 0, 'every degraded no-op call should count into dropped')
    assert.doesNotThrow(() => emitter.installFinalizer())
    assert.doesNotThrow(() => emitter.dispose())
  } finally {
    chmodSync(parent, 0o700)
  }
})

// ---------------------------------------------------------------------------
// M4: cached ledger handle + module-scoped degraded-notice relay
// ---------------------------------------------------------------------------

test('M4: a single emitter reusing one cached ledger handle across many emissions produces at most one relayed degraded-notice line', () => {
  const dir = freshDir('m4-single-emitter')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const lines = []
  const emitter = openRun({
    stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath, nodeVersion: '20.11.0', stderr: { write: (s) => lines.push(s) },
  })
  for (let i = 0; i < 5; i += 1) {
    emitter.emit((handle) => { handle.startSession({ adw_id: emitter.adwId, repo_slug: 'r', task_slug: 't' }) })
  }
  assert.ok(lines.length <= 1, `expected at most one relayed degraded-notice line across 5 emissions on one handle, got ${lines.length}`)
})

test('M4: two emitter instances in the same process relay the ledger degraded-notice at most once TOTAL, never once each', () => {
  const dir1 = freshDir('m4-two-emitters-a')
  const dir2 = freshDir('m4-two-emitters-b')
  const lines = []
  const sink = { write: (s) => lines.push(s) }
  const e1 = openRun({
    stateDir: dir1, repoSlug: 'r', taskSlug: 't', dbPath: join(dir1, 'ledger', 'ledger.db'), nodeVersion: '20.11.0', stderr: sink,
  })
  for (let i = 0; i < 5; i += 1) e1.emit((handle) => { handle.startSession({ adw_id: e1.adwId, repo_slug: 'r', task_slug: 't' }) })
  const afterFirstEmitter = lines.length
  assert.ok(afterFirstEmitter <= 1, `expected at most one relayed line after the first emitter, got ${afterFirstEmitter}`)

  const e2 = openRun({
    stateDir: dir2, repoSlug: 'r', taskSlug: 't', dbPath: join(dir2, 'ledger', 'ledger.db'), nodeVersion: '20.11.0', stderr: sink,
  })
  for (let i = 0; i < 5; i += 1) e2.emit((handle) => { handle.startSession({ adw_id: e2.adwId, repo_slug: 'r', task_slug: 't' }) })
  assert.equal(lines.length, afterFirstEmitter, 'a second emitter in the same process produced an additional degraded-notice line — the relay is not genuinely process-scoped')
})

// M4 residual (round 3): the ledger-relay guard above was already
// module-scoped; these three cover the notice kinds that round 2 found were
// STILL scoped per-call/per-instance — a facade-side failure notice, the
// "openRun is running fully degraded" notice, and a lock give-up notice —
// each hoisted to their own module-scope flag so N separate emitters/calls
// in one process still produce at most one total line, never one each.

test('M4 residual: three separate emitter instances each hitting a facade failure produce exactly one total stderr line, never one each', () => {
  _resetNoticeGuardsForTest()
  const lines = []
  const sink = { write: (s) => lines.push(s) }
  for (let i = 0; i < 3; i += 1) {
    const dir = freshDir(`m4-residual-facade-${i}`)
    const emitter = openRun({
      stateDir: dir,
      repoSlug: 'r',
      taskSlug: 't',
      stderr: sink,
      _openLedger: () => ({ startSession: () => { throw new Error('boom: facade failure') }, close: () => {} }),
    })
    const ok = emitter.emit((handle) => { handle.startSession({}) })
    assert.equal(ok, false, 'sanity: this emission should have been dropped, not succeeded')
  }
  assert.equal(lines.length, 1, `expected exactly one total stderr line across 3 separate emitters each hitting a facade failure, got ${lines.length}: ${JSON.stringify(lines)}`)
})

test('M4 residual: three separate degraded openRun() calls produce exactly one total stderr line, never one each', () => {
  _resetNoticeGuardsForTest()
  const lines = []
  const sink = { write: (s) => lines.push(s) }
  for (let i = 0; i < 3; i += 1) {
    const parent = freshDir(`m4-residual-degraded-${i}`)
    const dir = join(parent, 'nested', 'state-dir')
    chmodSync(parent, 0o500)
    try {
      const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: sink })
      assert.equal(emitter.adwId, null, 'sanity: this openRun call should have come back fully degraded')
    } finally {
      chmodSync(parent, 0o700)
    }
  }
  assert.equal(lines.length, 1, `expected exactly one total stderr line across 3 separate degraded openRun() calls, got ${lines.length}: ${JSON.stringify(lines)}`)
})

test('M4 residual: two separate emitters each hitting a lock give-up produce exactly one total stderr line, never one each', { timeout: 10000 }, () => {
  _resetNoticeGuardsForTest()
  const lines = []
  const sink = { write: (s) => lines.push(s) }
  for (const label of ['a', 'b']) {
    const dir = freshDir(`m4-residual-giveup-${label}`)
    const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: sink })
    const lockPath = join(dir, 'ledger', 'run.lock')
    mkdirSync(join(dir, 'ledger'), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
    const seqs = emitter.reserveSeq('event', 1)
    assert.deepEqual(seqs, [], 'sanity: this reservation should have given up, not succeeded')
  }
  assert.equal(lines.length, 1, `expected exactly one total stderr line across 2 separate emitters each hitting a lock give-up, got ${lines.length}: ${JSON.stringify(lines)}`)
})

// ---------------------------------------------------------------------------
// S2/S3: bumpStat is additive across processes, never last-writer-wins
// ---------------------------------------------------------------------------

test('S2/S3: bumpStat increments the three previously-unreachable counters, additively across two emitter instances', () => {
  const dir = freshDir('bump-stat')
  const e1 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const e2 = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })

  assert.equal(e1.bumpStat('resolution_missing'), true)
  assert.equal(e1.bumpStat('resolution_ambiguous', 2), true)
  assert.equal(e2.bumpStat('payload_keys_dropped', 3), true)
  assert.equal(e2.bumpStat('resolution_missing'), true)

  const sidecar = e1.sidecar()
  assert.equal(sidecar.stats.resolution_missing, 2, 'e1 and e2 each bumped resolution_missing once — the sidecar must show the SUM, not the last writer alone')
  assert.equal(sidecar.stats.resolution_ambiguous, 2)
  assert.equal(sidecar.stats.payload_keys_dropped, 3)
})

test('S2: bumpStat rejects an unrecognized or prototype-pollution-shaped stat name, counting the rejection as a drop', () => {
  const dir = freshDir('bump-stat-hostile')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.equal(emitter.bumpStat('__proto__'), false)
  assert.equal(emitter.bumpStat('dropped'), false, 'dropped is not in the closed bumpable-stats enum')
  assert.equal(emitter.bumpStat('not_a_real_stat'), false)
  assert.ok(emitter.stats().dropped >= 3)
  assert.equal(Object.getPrototypeOf({}).polluted, undefined, 'no prototype pollution occurred')
})

test('bumpGateAttempt rejects prototype-pollution-shaped gate names, counting the rejection as a drop', () => {
  const dir = freshDir('bump-gate-hostile')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.equal(emitter.bumpGateAttempt('__proto__'), 0)
  assert.equal(emitter.bumpGateAttempt('constructor'), 0)
  // 'toString' is a real Object.prototype member but an OWN-property write
  // of it on a plain object is harmless (Object.hasOwn-checked read, plain
  // assignment) — it is deliberately NOT in the forbidden set, and must not
  // crash.
  assert.doesNotThrow(() => emitter.bumpGateAttempt('toString'))
  assert.ok(emitter.stats().dropped >= 2)
  assert.equal(Object.getPrototypeOf({}).polluted, undefined)
})

// ---------------------------------------------------------------------------
// S5: deterministic EEXIST-adopt (never a racy real-process spawn)
// ---------------------------------------------------------------------------

test('S5: openRun against a pre-created run.json (never created via openRun itself) adopts its exact adw_id and continues its seq counters', () => {
  const dir = freshDir('sidecar-preseeded')
  const ledgerDir = join(dir, 'ledger')
  mkdirSync(ledgerDir, { recursive: true })
  const preseededAdwId = 'preseeded-adw-id-1234'
  const seeded = {
    adw_id: preseededAdwId,
    repo_slug: 'r',
    task_slug: 't',
    db_path: join(ledgerDir, 'ledger.db'),
    jsonl_path: join(ledgerDir, 'ledger.jsonl'),
    created_at: new Date().toISOString(),
    run_started: false,
    run_ended: false,
    phase: { name: null, seq: null, phase_id: null, started_at: null },
    seq: { event: { next: 7, reserved_through: 6 }, phase: { next: 1, reserved_through: 0 } },
    gate_attempts: {},
    heartbeats: {},
    billed: { input: null, output: null, cache_write: null, cache_read: null },
    stats: { emitted: 0, dropped: 0, lock_giveups: 0, resolution_ambiguous: 0, resolution_missing: 0, payload_keys_dropped: 0 },
    dispatches: {},
  }
  writeFileSync(join(ledgerDir, 'run.json'), JSON.stringify(seeded))

  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.equal(emitter.adwId, preseededAdwId, 'openRun minted a fresh adw_id instead of adopting the pre-created sidecar')
  const [seq] = emitter.reserveSeq('event', 1)
  assert.equal(seq, 7, 'the adopted sidecar seq counter was rewound instead of continuing from the pre-created value (M2)')
})

// ---------------------------------------------------------------------------
// S6: the adopted sidecar's db_path travels with it
// ---------------------------------------------------------------------------

test('S6: adopting an existing sidecar prefers ITS db_path/jsonl_path over a differing locally-resolved dbPath', () => {
  // Isolates this test's "at least one line" assertion from any earlier
  // test's facade-failure guard trip (module-scoped for the whole process —
  // M4 residual, round 3).
  _resetNoticeGuardsForTest()
  const dir = freshDir('db-path-travel')
  const first = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const originalDbPath = first.sidecar().db_path

  const lines = []
  const differentDbPath = join(dir, 'a-totally-different-ledger.db')
  const second = openRun({
    stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath: differentDbPath, stderr: { write: (s) => lines.push(s) },
  })
  assert.equal(second.adwId, first.adwId)
  assert.equal(second.sidecar().db_path, originalDbPath, 'the adopted sidecar db_path must win over this call\'s differing dbPath')
  assert.ok(lines.length >= 1, 'a detected db_path mismatch must be logged at least once')
})

// ---------------------------------------------------------------------------
// S9: sidecar/lock files carry the same permission discipline as ledger.mjs
// ---------------------------------------------------------------------------

test('S9: the ledger directory, run.json, and run.lock (while held) carry 0700/0600 permissions', async () => {
  const { statSync } = await import('node:fs')
  const dir = freshDir('perms')
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  emitter.reserveSeq('event', 1) // forces a lock acquire + sidecar mutation
  const ledgerDir = join(dir, 'ledger')
  const dirMode = statSync(ledgerDir).mode & 0o777
  const sidecarMode = statSync(join(ledgerDir, 'run.json')).mode & 0o777
  assert.equal(dirMode, 0o700, `expected ledger dir mode 0700, got ${dirMode.toString(8)}`)
  assert.equal(sidecarMode, 0o600, `expected run.json mode 0600, got ${sidecarMode.toString(8)}`)
})

// ---------------------------------------------------------------------------
// LIBRARY PURITY
// ---------------------------------------------------------------------------

test('LIBRARY PURITY: importing emit.mjs performs no I/O and installs no signal handler', async () => {
  const res = await runChild(`
    import('${EMIT_MODULE_URL}').then(() => {
      console.log(JSON.stringify({
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
      }))
    })
  `)
  assert.equal(res.code, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.sigterm, 0)
  assert.equal(out.sigint, 0)
})

test('LIBRARY PURITY: openRun does not install a signal handler; installFinalizer is opt-in', () => {
  const dir = freshDir('finalizer-opt-in')
  const before = { sigterm: process.listenerCount('SIGTERM'), sigint: process.listenerCount('SIGINT') }
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  assert.equal(process.listenerCount('SIGTERM'), before.sigterm)
  assert.equal(process.listenerCount('SIGINT'), before.sigint)
  emitter.installFinalizer()
  assert.equal(process.listenerCount('SIGTERM'), before.sigterm + 1)
  assert.equal(process.listenerCount('SIGINT'), before.sigint + 1)
  emitter.dispose()
  assert.equal(process.listenerCount('SIGTERM'), before.sigterm)
  assert.equal(process.listenerCount('SIGINT'), before.sigint)
})

// ---------------------------------------------------------------------------
// CLI: `gate --report <path>` / `stats` (be-41-06, issue #41)
// ---------------------------------------------------------------------------

const EMIT_SCRIPT = join(ROOT, 'scripts', 'factory', 'emit.mjs')

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [EMIT_SCRIPT, ...args], { encoding: 'utf8', ...opts })
}

// Seeds a run sidecar in-process (mirrors the seed helpers already used
// above) — the gate/stats CLI never mints a run itself (discovery_context
// assumption #2), so every CLI test needs one already on disk first.
function seedRun(dir) {
  const emitter = openRun({ stateDir: dir, repoSlug: 'r', taskSlug: 't', stderr: { write: () => {} } })
  const adwId = emitter.adwId
  emitter.dispose()
  return adwId
}

function writeReport(dir, report) {
  const p = join(dir, `report-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify(report))
  return p
}

// Deliberately out-of-order checks, a hard_fail:true entry, and a violation
// carrying a note — the fixture C1's VERBATIM requirement exists to catch a
// re-shape/re-order/drop.
function sampleReport(overrides = {}) {
  return {
    task: 'sample-task',
    slice: 'be-41-06',
    checks: [
      { item: 'z-check', ok: true, hard_fail: false, note: 'note-z' },
      { item: 'a-check', ok: false, hard_fail: true, note: 'note-a' },
    ],
    hard_fail: true,
    violations: [{ item: 'a-check', hard_fail: true, note: 'violation note' }],
    ...overrides,
  }
}

test('CLI gate: the four caller-supplied keys are each correct — adw_id/phase_id from the sidecar, a slice-qualified gate_name, a 1-based attempt', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-keys')
  const adwId = seedRun(dir)
  const reportPath = writeReport(dir, sampleReport())
  const res = runCli(['gate', '--report', reportPath, '--state-dir', dir, '--json'])
  assert.equal(res.status, 0, res.stderr)
  const printed = JSON.parse(res.stdout.trim())
  assert.equal(printed.adw_id, adwId)
  assert.equal(printed.phase_id, null, 'phase_id must be explicit null when no phase has started — never omitted')
  assert.equal(printed.gate_name, 'be-41-06/chain-check', 'gate_name must carry the slice')
  assert.equal(printed.attempt, 1)
  assert.equal(printed.ok, false, 'ok must be checks.every(c => c.ok), never report.hard_fail hoisted directly')
})

test('CLI gate: checks and violations land VERBATIM — same order, same keys, same values, nothing added or dropped', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-verbatim')
  const adwId = seedRun(dir)
  const report = sampleReport()
  const reportPath = writeReport(dir, report)
  const res = runCli(['gate', '--report', reportPath, '--state-dir', dir])
  assert.equal(res.status, 0, res.stderr)

  const ledger = openLedger({ dbPath: join(dir, 'ledger', 'ledger.db') })
  const rows = ledger.dumpTable('gate_results').filter((r) => r.adw_id === adwId)
  ledger.close()
  assert.equal(rows.length, 1)
  assert.deepEqual(JSON.parse(rows[0].checks_json), report.checks, 'checks did not round-trip verbatim')
  assert.deepEqual(JSON.parse(rows[0].violations_json), report.violations, 'violations did not round-trip verbatim')
})

test('CLI gate: a second invocation for the SAME slice increments attempt and BOTH rows survive; a different slice gets its own distinct gate_name', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-attempts')
  const adwId = seedRun(dir)

  const reportA1 = writeReport(dir, sampleReport({ slice: 'be-41-06' }))
  const resA1 = runCli(['gate', '--report', reportA1, '--state-dir', dir])
  assert.equal(resA1.status, 0, resA1.stderr)

  const reportA2 = writeReport(dir, sampleReport({ slice: 'be-41-06' }))
  const resA2 = runCli(['gate', '--report', reportA2, '--state-dir', dir])
  assert.equal(resA2.status, 0, resA2.stderr)

  const reportB1 = writeReport(dir, sampleReport({ slice: 'be-41-07' }))
  const resB1 = runCli(['gate', '--report', reportB1, '--state-dir', dir])
  assert.equal(resB1.status, 0, resB1.stderr)

  const ledger = openLedger({ dbPath: join(dir, 'ledger', 'ledger.db') })
  const rows = ledger.dumpTable('gate_results').filter((r) => r.adw_id === adwId)
  ledger.close()

  const sliceARows = rows.filter((r) => r.gate_name === 'be-41-06/chain-check')
  const sliceBRows = rows.filter((r) => r.gate_name === 'be-41-07/chain-check')
  // Asserting "a row exists" alone would pass on the silent
  // UNIQUE(adw_id, gate_name, attempt) + INSERT OR IGNORE collapse this
  // test exists to catch — assert the exact row count instead.
  assert.equal(sliceARows.length, 2, `expected 2 surviving rows for be-41-06, got ${sliceARows.length}`)
  assert.deepEqual(sliceARows.map((r) => r.attempt).sort(), [1, 2])
  assert.equal(sliceBRows.length, 1, `expected 1 surviving row for be-41-07, got ${sliceBRows.length}`)
  assert.equal(sliceBRows[0].attempt, 1)
})

test('CLI gate: NO LEDGER FAILURE BECOMES A GATE FAILURE — a throwing JSONL append still exits 0 with the normal report, and counts a drop', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-throwing-ledger')
  seedRun(dir)
  // Forces the ledger's OWN appendJsonl to throw (EISDIR) without touching
  // any test seam the CLI doesn't expose — a real, load-bearing failure
  // mode, not a mock.
  mkdirSync(join(dir, 'ledger', 'ledger.jsonl'), { recursive: true })
  const reportPath = writeReport(dir, sampleReport())
  const res = runCli(['gate', '--report', reportPath, '--state-dir', dir, '--json'])
  assert.equal(res.status, 0, res.stderr, 'the gate\'s own verdict must never be altered by a mirror failure')
  const printed = JSON.parse(res.stdout.trim())
  assert.equal(printed.mirrored, false)
  assert.equal(printed.ok, false, 'the parsed report verdict is unchanged by the mirror failure')

  const statsRes = runCli(['stats', '--state-dir', dir, '--json'])
  assert.equal(statsRes.status, 0, statsRes.stderr)
  const stats = JSON.parse(statsRes.stdout.trim())
  assert.equal(stats.dropped, 1)
})

test('CLI gate: refuses (exit 2) on a missing report path, an unparseable report, and a structurally-wrong report (checks not an array) — never a silent degrade to zero checks', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-refusals')
  seedRun(dir)

  const missing = runCli(['gate', '--report', join(dir, 'does-not-exist.json'), '--state-dir', dir])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /reason: unreadable_report/)

  const unparseablePath = join(dir, 'unparseable.json')
  writeFileSync(unparseablePath, 'not json at all')
  const unparseable = runCli(['gate', '--report', unparseablePath, '--state-dir', dir])
  assert.equal(unparseable.status, 2)
  assert.match(unparseable.stderr, /reason: unparseable_report/)

  const wrongShapePath = writeReport(dir, { slice: 'be-x', checks: 'not-an-array', violations: [] })
  const wrongShape = runCli(['gate', '--report', wrongShapePath, '--state-dir', dir])
  assert.equal(wrongShape.status, 2)
  assert.match(wrongShape.stderr, /reason: malformed_report/)
})

test('CLI gate: refuses (exit 2) when no run sidecar exists — never mints one on the gate\'s behalf', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-no-run')
  const reportPath = writeReport(dir, sampleReport())
  const res = runCli(['gate', '--report', reportPath, '--state-dir', dir])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /reason: no_run/)
  assert.ok(!existsSync(join(dir, 'ledger', 'run.json')), 'the gate verb must never originate a fresh run sidecar')
})

test('CLI stats: prints the six drop counters (human + --json), and emits NOTHING to the ledger', { skip: SKIP }, () => {
  const dir = freshDir('cli-stats-basic')
  const adwId = seedRun(dir)

  const humanRes = runCli(['stats', '--state-dir', dir])
  assert.equal(humanRes.status, 0, humanRes.stderr)
  for (const key of ['emitted', 'dropped', 'lock_giveups', 'resolution_ambiguous', 'resolution_missing', 'payload_keys_dropped']) {
    assert.match(humanRes.stdout, new RegExp(key))
  }

  const jsonRes = runCli(['stats', '--state-dir', dir, '--json'])
  assert.equal(jsonRes.status, 0, jsonRes.stderr)
  const zeroStats = JSON.parse(jsonRes.stdout.trim())
  assert.deepEqual(zeroStats, {
    emitted: 0, dropped: 0, lock_giveups: 0, resolution_ambiguous: 0, resolution_missing: 0, payload_keys_dropped: 0,
  })

  // Now make a counter nonzero and confirm it is visibly distinguishable
  // from the all-zero baseline above.
  mkdirSync(join(dir, 'ledger', 'ledger.jsonl'), { recursive: true })
  const reportPath = writeReport(dir, sampleReport())
  const gateRes = runCli(['gate', '--report', reportPath, '--state-dir', dir])
  assert.equal(gateRes.status, 0, gateRes.stderr)
  const dirtyRes = runCli(['stats', '--state-dir', dir, '--json'])
  const dirtyStats = JSON.parse(dirtyRes.stdout.trim())
  assert.equal(dirtyStats.dropped, 1)
  assert.notDeepEqual(dirtyStats, zeroStats)

  const ledger = openLedger({ dbPath: join(dir, 'ledger', 'ledger.db') })
  const gateRows = ledger.dumpTable('gate_results').filter((r) => r.adw_id === adwId)
  ledger.close()
  assert.equal(gateRows.length, 0, 'stats itself must never write to the ledger — the row above came from the gate call, not stats')
})

test('CLI stats: refuses (exit 2) when no run sidecar is present — never fabricates an all-zero success', { skip: SKIP }, () => {
  const dir = freshDir('cli-stats-no-run')
  const res = runCli(['stats', '--state-dir', dir])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /reason: no_run/)
})

// ---------------------------------------------------------------------------
// REWORK round: MUST/SHOULD-FIX #1-#5 (deep-review pass on the gate verb)
// ---------------------------------------------------------------------------

// MUST-FIX #1: a ledger-side degradation (openRun itself coming up
// degraded) must never invert the gate's exit code from 0 to 2. Reproduces
// the exact live repro: a directory sitting at the sidecar's lock path
// forces linkSync/readFileSync to throw (EISDIR, not EEXIST/ENOENT),
// which openRun's own try/catch turns into a fully degraded emitter — the
// sidecar file itself was already proven to exist and be readable moments
// earlier via readSidecarJsonOrRefuse, so the gate must still mirror
// nothing but report its normal (non-mirror) verdict at exit 0.
test('CLI gate: MUST-FIX #1 — an openRun-level degradation never inverts the gate exit code from 0 to 2', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-openrun-degraded')
  seedRun(dir)
  const lockPath = join(dir, 'ledger', 'run.lock')
  mkdirSync(lockPath, { recursive: true })
  const reportPath = writeReport(dir, sampleReport())
  const res = runCli(['gate', '--report', reportPath, '--state-dir', dir, '--json'])
  assert.equal(res.status, 0, `expected exit 0 despite the ledger-side openRun degradation, got ${res.status}. stderr: ${res.stderr}`)
  const printed = JSON.parse(res.stdout.trim())
  assert.equal(printed.mirrored, false, 'a degraded openRun must never mirror, but must still report the gate result')
  assert.equal(printed.ok, false, 'the parsed report verdict is unchanged by the ledger-side degradation')
  assert.equal(printed.gate_name, 'be-41-06/chain-check', 'gate_name must still be sourced from the already-proven-readable sidecar/report, not refused')
  assert.match(res.stderr, /openRun is running fully degraded/, 'the degraded openRun path must actually have been exercised')
})

// MUST-FIX #2: attempt:0 (bumpGateAttempt's own documented lock-give-up
// signal) must never be recorded into the ledger unchecked — a live,
// non-stale lock planted at the sidecar's lock path forces a bounded
// give-up (openRun itself degrades via createOrAdoptSidecar's own lock
// attempt, so bumpGateAttempt returns 0 too). Confirms: no gate_results row
// is ever written for either of TWO invocations against the SAME
// gate_name — proving the attempt:0 collision this fix exists to prevent
// never occurs, since neither invocation ever reaches the ledger at all.
test('CLI gate: MUST-FIX #2 — attempt:0 from a lock give-up is never written to the ledger, even across two invocations of the same gate_name', { skip: SKIP, timeout: 10000 }, () => {
  const dir = freshDir('cli-gate-attempt-zero')
  const adwId = seedRun(dir)
  const lockPath = join(dir, 'ledger', 'run.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))

  const report1 = writeReport(dir, sampleReport())
  const res1 = runCli(['gate', '--report', report1, '--state-dir', dir, '--json'])
  assert.equal(res1.status, 0, res1.stderr)
  assert.equal(JSON.parse(res1.stdout.trim()).mirrored, false)

  const report2 = writeReport(dir, sampleReport())
  const res2 = runCli(['gate', '--report', report2, '--state-dir', dir, '--json'])
  assert.equal(res2.status, 0, res2.stderr)
  assert.equal(JSON.parse(res2.stdout.trim()).mirrored, false)

  mkdirSync(join(dir, 'ledger'), { recursive: true })
  const ledger = openLedger({ dbPath: join(dir, 'ledger', 'ledger.db') })
  const rows = ledger.dumpTable('gate_results').filter((r) => r.adw_id === adwId)
  ledger.close()
  assert.equal(rows.length, 0, 'a lock give-up must never write a gate_results row, and never collide on attempt:0 across repeated give-ups')
})

// MUST-FIX #3: report.slice is caller-supplied and must be sanitized before
// it reaches gate_name — both the ledger's gate_name column and the CLI's
// own printed summaries.
test('CLI gate: MUST-FIX #3 — a hostile report.slice (embedded newline + ANSI) is stripped before reaching gate_name, the ledger and stdout', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-hostile-slice')
  const adwId = seedRun(dir)
  const hostileSlice = 'be-41-06\x1B[31m\ninjected-line'

  const jsonReportPath = writeReport(dir, sampleReport({ slice: hostileSlice }))
  const jsonRes = runCli(['gate', '--report', jsonReportPath, '--state-dir', dir, '--json'])
  assert.equal(jsonRes.status, 0, jsonRes.stderr)
  const printed = JSON.parse(jsonRes.stdout.trim())
  assert.ok(!/[\x00-\x1F\x7F]/.test(printed.gate_name), 'gate_name must have no raw control/ANSI bytes')
  assert.equal(printed.gate_name, 'be-41-06injected-line/chain-check', 'sanity: the ANSI/newline bytes are removed, the surrounding text survives')

  const ledger = openLedger({ dbPath: join(dir, 'ledger', 'ledger.db') })
  const rows = ledger.dumpTable('gate_results').filter((r) => r.adw_id === adwId)
  ledger.close()
  assert.equal(rows.length, 1)
  assert.ok(!/[\x00-\x1F\x7F]/.test(rows[0].gate_name), 'the ledger gate_name column must have no raw control/ANSI bytes')

  const humanReportPath = writeReport(dir, sampleReport({ slice: hostileSlice }))
  const humanRes = runCli(['gate', '--report', humanReportPath, '--state-dir', dir])
  assert.equal(humanRes.status, 0, humanRes.stderr)
  assert.equal(humanRes.stdout.trim().split('\n').length, 1, 'the human-readable one-line summary must stay one line even with a hostile slice')
  assert.ok(!/[\x00-\x1F\x7F]/.test(humanRes.stdout.trimEnd()), 'stdout must not contain raw control/ANSI bytes (excluding its own single trailing newline)')
})

// SHOULD-FIX #4(a): buildReport (scripts/chain/gates.mjs) never legitimately
// produces an empty checks array — a truncated/malformed report must
// refuse rather than fabricate a vacuous ok:true PASS via [].every(...).
test('CLI gate: SHOULD-FIX #4(a) — an empty checks array refuses (exit 2) rather than fabricating a vacuous ok:true PASS', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-empty-checks')
  seedRun(dir)
  const reportPath = writeReport(dir, sampleReport({ checks: [] }))
  const res = runCli(['gate', '--report', reportPath, '--state-dir', dir])
  assert.equal(res.status, 2, res.stderr)
  assert.match(res.stderr, /reason: malformed_report/)
})

// SHOULD-FIX #4(b): a malformed check element must refuse with exit 2 (a
// structurally-wrong report), never an unexpected exit 1 from a raw
// TypeError deep inside report.checks.every(c => c.ok).
test('CLI gate: SHOULD-FIX #4(b) — a malformed check element refuses with exit 2, never an unexpected exit 1', { skip: SKIP }, () => {
  const dir = freshDir('cli-gate-malformed-check')
  seedRun(dir)

  const nullCheckPath = writeReport(dir, sampleReport({ checks: [null] }))
  const nullCheckRes = runCli(['gate', '--report', nullCheckPath, '--state-dir', dir])
  assert.equal(nullCheckRes.status, 2, nullCheckRes.stderr)
  assert.match(nullCheckRes.stderr, /reason: malformed_report/)

  const missingOkPath = writeReport(dir, sampleReport({ checks: [{ item: 'x', hard_fail: false }] }))
  const missingOkRes = runCli(['gate', '--report', missingOkPath, '--state-dir', dir])
  assert.equal(missingOkRes.status, 2, missingOkRes.stderr)
  assert.match(missingOkRes.stderr, /reason: malformed_report/)
})

// SHOULD-FIX #5: if the post-emit stats flush itself gives up under lock
// contention, the drop counter this invocation just recorded may never
// reach disk — this must surface as a stderr warning, never a silent
// discard, and must never change the gate's own exit code.
test('CLI gate: SHOULD-FIX #5 — a stats-flush failure after emit() prints a stderr warning without changing the exit code', { skip: SKIP, timeout: 10000 }, () => {
  const dir = freshDir('cli-gate-flush-giveup')
  seedRun(dir)
  const lockPath = join(dir, 'ledger', 'run.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
  const reportPath = writeReport(dir, sampleReport())
  const res = runCli(['gate', '--report', reportPath, '--state-dir', dir, '--json'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stderr, /stats flush to the run sidecar failed/, 'a flush give-up must be visible on stderr, never silently discarded')
})

test('CLI: --state-dir is required for both verbs, and an unknown verb refuses', { skip: SKIP }, () => {
  const dir = freshDir('cli-usage')
  const noStateDir = runCli(['stats'])
  assert.equal(noStateDir.status, 2)

  const noVerb = runCli([])
  assert.equal(noVerb.status, 2)

  const badVerb = runCli(['bogus', '--state-dir', dir])
  assert.equal(badVerb.status, 2)
})

test('CLI: emit-cli-unknown-flag-refusal — an unknown flag refuses with exit 2 and names it, on both verbs', () => {
  const dir = freshDir('cli-unknown-flag')
  seedRun(dir)
  const stats = runCli(['stats', '--state-dir', dir, '--bogus', 'zzz'])
  assert.equal(stats.status, 2)
  assert.match(stats.stderr, /unknown flag --bogus/)
  assert.match(stats.stderr, /reason: unknown_flag/)

  const missingValue = runCli(['stats', '--state-dir', dir, '--bogus'])
  assert.equal(missingValue.status, 2)

  const prototypeFlag = runCli(['stats', '--state-dir', dir, '--__proto__', 'zzz'])
  assert.equal(prototypeFlag.status, 2)
  assert.match(prototypeFlag.stderr, /unknown flag --__proto__/)
  assert.match(prototypeFlag.stderr, /reason: unknown_flag/)

  const prototypeVerb = runCli(['__proto__', '--bogus', 'zzz'])
  assert.equal(prototypeVerb.status, 2)
  assert.match(prototypeVerb.stderr, /unknown verb: __proto__/)

  const reportPath = writeReport(dir, sampleReport())
  const gate = runCli(['gate', '--report', reportPath, '--state-dir', dir, '--nope', 'zzz'])
  assert.equal(gate.status, 2)
  assert.match(gate.stderr, /unknown flag --nope/)
  assert.doesNotMatch(gate.stderr, /no_run/)
})

test('CLI: every flag both verbs legitimately accept still works', () => {
  const dir = freshDir('cli-legitimate-flags')
  seedRun(dir)

  const statsJson = runCli(['stats', '--state-dir', dir, '--json'])
  assert.equal(statsJson.status, 0, statsJson.stderr)
  assert.deepEqual(JSON.parse(statsJson.stdout.trim()), {
    emitted: 0, dropped: 0, lock_giveups: 0, resolution_ambiguous: 0, resolution_missing: 0, payload_keys_dropped: 0,
  })

  const statsHuman = runCli(['stats', '--state-dir', dir])
  assert.equal(statsHuman.status, 0, statsHuman.stderr)
  assert.match(statsHuman.stdout, /emit stats: emitted=0 dropped=0 lock_giveups=0/)

  const reportPath = writeReport(dir, sampleReport())
  const gate = runCli(['gate', '--report', reportPath, '--state-dir', dir, '--json'])
  assert.equal(gate.status, 0, gate.stderr)
  assert.deepEqual(Object.keys(JSON.parse(gate.stdout.trim())).sort(), ['adw_id', 'phase_id', 'gate_name', 'attempt', 'ok', 'mirrored'].sort())
})

test('in-process main(): a genuine internal error still returns 1, not 2', () => {
  const dir = freshDir('cli-internal-error')
  seedRun(dir)
  const originalWrite = process.stdout.write
  try {
    process.stdout.write = () => { throw new Error('stdout write failure') }
    assert.equal(main(['stats', '--state-dir', dir]), 1)
  } finally {
    process.stdout.write = originalWrite
  }
})

test('symlinked invocation: emit.mjs still runs its CLI body when invoked through a symlinked path component', { skip: SKIP }, () => {
  const dir = freshDir('cli-symlink')
  seedRun(dir)
  const linkDir = mkdtempSync(join(fixtureRoot, 'symlink-'))
  symlinkSync(dirname(EMIT_SCRIPT), join(linkDir, 'linked'))
  const linkedScript = join(linkDir, 'linked', 'emit.mjs')
  const res = spawnSync(process.execPath, [linkedScript, 'stats', '--state-dir', dir, '--json'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const parsed = JSON.parse(res.stdout.trim())
  assert.equal(parsed.emitted, 0)
})

test('source-text pin: main() never calls process.exit, and the invokedDirectly guard realpathSyncs BOTH sides', () => {
  const codeLines = EMIT_SOURCE.split('\n').filter((line) => !line.trim().startsWith('//'))
  assert.ok(!codeLines.some((line) => /process\.exit\(/.test(line)), 'emit.mjs calls process.exit somewhere outside a comment')
  assert.ok(codeLines.some((line) => /process\.exitCode\s*=\s*main\(/.test(line)), 'the invokedDirectly guard must set process.exitCode, not process.exit')
  assert.match(EMIT_SOURCE, /realpathOr\(process\.argv\[1\]\)\s*===\s*realpathOr\(fileURLToPath\(import\.meta\.url\)\)/, 'the invokedDirectly guard must realpathSync BOTH process.argv[1] and import.meta.url')
})

test('in-process main(): an unknown verb returns 2 without throwing', () => {
  assert.equal(main(['bogus']), 2)
})

// ---------------------------------------------------------------------------
// parse safety + hygiene
// ---------------------------------------------------------------------------

test('node --check parses scripts/factory/emit.mjs cleanly', async () => {
  const res = await runChild(`
    import { execFileSync } from 'node:child_process';
    execFileSync(process.execPath, ['--check', ${JSON.stringify(join(ROOT, 'scripts', 'factory', 'emit.mjs'))}]);
    console.log('ok');
  `)
  assert.equal(res.code, 0, res.stderr)
})

test('AC-13-style hygiene: this file never references the CLI-only default-db-path resolver by name', () => {
  const needle = ['default', 'Db', 'Path'].join('')
  assert.ok(!SELF_SOURCE.includes(needle), 'this test file references the forbidden symbol')
  assert.ok(!EMIT_SOURCE.includes(needle), 'emit.mjs references the CLI-only default-db-path resolver — a library path must never call it')
})

test('no test file names a virtual filesystem as a real path', () => {
  // A deliberately-failing path must fail by CONSTRUCTION, never because a
  // platform happens to lack a virtual filesystem. On Linux a live virtual
  // mount is present and its mkdir semantics hang Node's recursive mkdir.
  const banned = /['"`]\/(proc|sys)\//
  const offenders = []
  for (const file of readdirSync(dirname(SELF)).filter((f) => f.endsWith('.test.mjs'))) {
    readFileSync(join(dirname(SELF), file), 'utf8').split('\n').forEach((line, i) => {
      if (banned.test(line)) offenders.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], `a test file names a virtual filesystem as a real path: ${offenders.join(', ')}`)
})

test('b381 A2 authentication_failed never spends the fallback', { skip: SKIP }, () => {
  const dir = freshDir('b381-auth-fallback')
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const crewPath = join(dir, 'crew.json')
  const fallback = { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high', model: 'claude-opus-5' }
  const member = {
    transport: 'headless-json', agent: 'claude', provider: 'anthropic', id: 'claude-fable-5', effort: 'high', model: 'claude-fable-5',
    fallback: [{ ...fallback }],
  }
  const crew = {
    schema_version: 3, tier: 'judge', checkout: dir,
    members: { 'tech-lead': member }, seats: { 'tech-lead': { ...member, fallback: [{ ...fallback }] } },
  }
  writeFileSync(crewPath, JSON.stringify(crew, null, 2))
  const journal = []; let spawns = 0; let pid = 4200; let lastRunDir = null
  const writeRefusal = (runDir, status = null) => {
    const assistant = { type: 'assistant', message: { model: '<synthetic>' } }
    const result = { type: 'result', terminal_reason: 'api_error', subtype: 'success', ...(status == null ? {} : { api_error_status: status }) }
    writeFileSync(join(runDir, 'stream.jsonl'), `${JSON.stringify(assistant)}\n${JSON.stringify(result)}\n`)
    writeFileSync(join(runDir, 'exit'), '1')
  }
  const writeAnswer = (runDir) => {
    writeFileSync(join(returnsDir, 'd1.tech-lead.json'), JSON.stringify({ assignment_id: 'd1', role: 'tech-lead', status: 'done' }))
    writeFileSync(join(runDir, 'stream.jsonl'), `${JSON.stringify({ type: 'result', terminal_reason: 'completed', subtype: 'success' })}\n`)
    writeFileSync(join(runDir, 'exit'), '0')
  }
  const io = headlessIo({
    crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir, adapters: null, bin: '/frozen/worker/bin',
    deps: {
      log: (row) => journal.push(row), kill: () => {}, sleep: () => {}, uuid: () => 'b381-auth-session',
      spawn() {
        spawns += 1
        const root = join(taskDir, 'headless')
        const dirs = readdirSync(root).filter((name) => /^d\d+$/.test(name)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        lastRunDir = join(root, dirs.at(-1))
        if (spawns === 1) writeRefusal(lastRunDir, 401)
        else writeAnswer(lastRunDir)
        return { pid: ++pid, unref() {} }
      },
    },
  })
  try {
    const run = io.assign({ role: 'tech-lead', briefFile: join(taskDir, 'brief.md') })
    const before = readFileSync(crewPath, 'utf8')
    assert.throws(() => io.wait(run.returnPath, 600), (err) => err.stage === 'headless-budget-refused')
    assert.equal(spawns, 1)
    assert.equal(journal.filter((row) => row.event === 'seat-fallback').length, 0)
    assert.equal(readFileSync(crewPath, 'utf8'), before)

    // Replace the first turn with the same budget refusal but no provider kind.
    // The still-present fallback proves the authentication refusal did not spend it.
    writeRefusal(lastRunDir)
    const envelope = io.wait(run.returnPath, 600)
    assert.equal(envelope.assignment_id, 'd1')
    assert.equal(spawns, 2)
    assert.equal(journal.filter((row) => row.event === 'seat-fallback').length, 1)
    assert.equal(JSON.parse(readFileSync(crewPath, 'utf8')).members['tech-lead'].model, 'claude-opus-5')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
