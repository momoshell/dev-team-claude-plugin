// test/factory-ledger-floor.test.mjs — the no-condition-excluded half of the
// factory ledger suite. Runs on every Node version (no node:sqlite is ever
// reached from this file): closed-enum refusals (validation runs before the
// floor branch, so these are identical above and below floor), the full
// floor behavior contract, and three source-text self-assertions over the
// module and this file itself.
import { test as nodeTest, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT } from './helpers.mjs'
import {
  openLedger, EVENT_TYPES, LedgerUsageError, WRITERS, NODE_FLOOR, isLockedError,
} from '../scripts/factory/ledger.mjs'

const SCRIPT = join(ROOT, 'scripts', 'factory', 'ledger.mjs')
const SELF = fileURLToPath(import.meta.url)
const LEDGER_SOURCE = readFileSync(SCRIPT, 'utf8')
const SELF_SOURCE = readFileSync(SELF, 'utf8')

const fixture = mkdtempSync(join(tmpdir(), 'factory-ledger-floor-'))
after(() => rmSync(fixture, { recursive: true, force: true }))

// Thin test() wrapper: a module-level counter proves this file's tests did
// not silently vanish (a file whose tests all disappeared would otherwise
// still pass green).
let registeredCount = 0
function test(name, optionsOrFn, maybeFn) {
  registeredCount += 1
  if (typeof optionsOrFn === 'function') {
    return nodeTest(name, optionsOrFn)
  }
  return nodeTest(name, optionsOrFn, maybeFn)
}

// Safety-net cleanup for the one test in this file that spawns a real
// child process — swept unconditionally so a failing assertion mid-test
// cannot leak it.
const spawnedChildren = new Set()
function trackChild(child) {
  spawnedChildren.add(child)
  child.on('exit', () => spawnedChildren.delete(child))
  return child
}
after(() => {
  for (const child of spawnedChildren) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
})

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_LEDGER_DB: join(fixture, 'ledger.db'), ...env },
  })
}

// A degraded (forced below-floor) handle never touches node:sqlite, keeping
// this whole file reachable-sqlite-free regardless of the runtime it's
// actually executed on.
function degradedHandle(extra = {}) {
  return openLedger({
    dbPath: join(fixture, `${Math.random().toString(36).slice(2)}.db`),
    nodeVersion: '20.11.0',
    stderr: { write: () => {} },
    ...extra,
  })
}

// --- AC-2: closed event enum -----------------------------------------------

test('EVENT_TYPES is the exact 11-value literal', () => {
  assert.deepEqual(EVENT_TYPES, [
    'phase_start', 'phase_end', 'agent_start', 'agent_end', 'tool_call',
    'handoff', 'gate_pass', 'gate_fail', 'decision', 'log', 'error',
  ])
})

test('recordEvent throws LedgerUsageError for an unknown type', () => {
  const ledger = degradedHandle()
  assert.throws(
    () => ledger.recordEvent({ adw_id: 'a1', type: 'not-a-real-type' }),
    LedgerUsageError,
  )
})

test('recordEvent throws LedgerUsageError SPECIFICALLY for type "heartbeat" — heartbeats are columns, never events', () => {
  const ledger = degradedHandle()
  assert.throws(
    () => ledger.recordEvent({ adw_id: 'a1', type: 'heartbeat' }),
    (err) => err instanceof LedgerUsageError && err.reason === 'heartbeat_is_not_an_event',
  )
})

// --- S11(c)'s classifier (cheap add): unit-tested directly ------------------

test('isLockedError recognizes both the SQLITE_BUSY code and a "database is locked" message', () => {
  assert.equal(isLockedError({ code: 'SQLITE_BUSY' }), true)
  assert.equal(isLockedError({ message: 'database is locked' }), true)
  assert.equal(isLockedError({ message: 'DATABASE IS LOCKED (case-insensitive)' }), true)
  assert.equal(isLockedError({ code: 'SQLITE_ERROR', message: 'no such table: x' }), false)
  assert.equal(isLockedError(null), false)
})

// --- AC-8: floor behavior ----------------------------------------------------

test('AC-8(a): CLI below floor exits 2 and names both NODE_FLOOR and the running version', () => {
  const res = run(['sessions'], { DEVTEAM_LEDGER_FAKE_NODE_VERSION: '20.11.0' })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /NODE_FLOOR/)
  assert.match(res.stderr, /20\.11\.0/)
})

test('AC-8(b): openLedger below floor returns a fully-shaped handle whose writers/readers all exist and never throw', () => {
  const ledger = degradedHandle()
  for (const w of WRITERS) {
    assert.equal(typeof ledger[w], 'function', `missing writer ${w}`)
  }
  for (const r of ['listSessions', 'listEvents', 'getSession', 'dumpTable']) {
    assert.equal(typeof ledger[r], 'function', `missing reader ${r}`)
  }
  assert.doesNotThrow(() => ledger.startSession({ adw_id: 'a2', repo_slug: 'r', task_slug: 't' }))
  assert.deepEqual(ledger.listSessions(), [])
  assert.equal(ledger.getSession('a2'), null)
  assert.deepEqual(ledger.dumpTable('sessions'), [])
  assert.deepEqual(ledger.listEvents({ adw_id: 'a2' }), [])
})

test('AC-8(c): handle.degraded is true below floor', () => {
  const ledger = degradedHandle()
  assert.equal(ledger.degraded, true)
})

// S9: pins the floor comparison's boundary as inclusive (versionAtLeast
// must use >=, not >) — a mutation flipping the comparison direction at
// the boundary previously survived because nothing asserted the exact-
// floor case's exit code.
test('S9: at exactly NODE_FLOOR the CLI is NOT below floor (exit 0, not 2)', () => {
  const res = run(['sessions'], { DEVTEAM_LEDGER_FAKE_NODE_VERSION: NODE_FLOOR })
  assert.equal(res.status, 0, `expected exit 0 at exactly NODE_FLOOR, got ${res.status}: ${res.stderr}`)
})

test('AC-8(c): the sessions verb surfaces degraded:true when reachable (an open-time failure on an at-or-above-floor runtime, not the below-floor early-exit path)', () => {
  // The below-floor early-exit path in main() refuses (exit 2) BEFORE ever
  // opening a ledger or reaching the `sessions` verb's JSON output — so
  // degraded:true can only be OBSERVED in that output via a DIFFERENT
  // degradation cause: an open-time failure on a runtime that is itself
  // at or above NODE_FLOOR. Simulate one by pointing DEVTEAM_LEDGER_DB at
  // a path whose parent component is a FILE, not a directory, so the
  // lazy open's mkdirSync throws (ENOTDIR) inside ensureDb's catch-all,
  // never touching the version-check branch at all.
  const blockingFile = join(fixture, 'blocking-file')
  writeFileSync(blockingFile, 'not a directory')
  const dbPath = join(blockingFile, 'sub', 'ledger.db')
  const res = run(['sessions'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, `expected the CLI to still succeed (degraded, not refused): ${res.stderr}`)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.degraded, true)
  assert.ok(payload.degraded_reason, 'degraded_reason must be surfaced once reachable')
})

test('AC-8(d): exactly one stderr line is written to the injected sink for the whole handle lifetime', () => {
  const lines = []
  const ledger = degradedHandle({ stderr: { write: (s) => lines.push(s) } })
  ledger.startSession({ adw_id: 'a3', repo_slug: 'r', task_slug: 't' })
  ledger.startSession({ adw_id: 'a4', repo_slug: 'r', task_slug: 't' })
  ledger.recordEvent({ adw_id: 'a3', seq: 1, type: 'log', payload: { level: 'info', message: 'x' } })
  ledger.listSessions()
  assert.equal(lines.length, 1, `expected exactly one stderr line, got ${lines.length}: ${JSON.stringify(lines)}`)
})

test('AC-8(e): JSONL is still written below floor and is parseable', () => {
  const dbPath = join(fixture, 'floor-jsonl.db')
  const ledger = openLedger({ dbPath, nodeVersion: '20.11.0', stderr: { write: () => {} } })
  ledger.startSession({ adw_id: 'a5', repo_slug: 'r', task_slug: 't' })
  const jsonlPath = join(fixture, 'ledger.jsonl')
  assert.ok(existsSync(jsonlPath))
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
  assert.ok(lines.length >= 1)
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line))
  }
})

test("AC-8(f): NODE_FLOOR's major equals the highest Node major in the CI matrix", () => {
  const workflowYml = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
  const m = workflowYml.match(/node-version:\s*\[([^\]]*)\]/)
  assert.ok(m, 'matrix node-version list not found')
  const majors = [...m[1].matchAll(/"(\d+)"/g)].map((x) => Number(x[1]))
  assert.ok(majors.length > 0)
  const floorMajor = Number(NODE_FLOOR.split('.')[0])
  assert.equal(floorMajor, Math.max(...majors))
})

// --- AC-12: never prune (source-text assertion, including comments) --------

test('AC-12: ledger.mjs contains no row-removal, table-removal or space-reclaiming SQL verb anywhere, including comments', () => {
  // Needles built from fragments so this scan is not itself a false trip
  // against its own listing of the words it's looking for.
  const needles = [
    ['DE', 'LETE', ' FROM'].join(''),
    ['DROP', ' TABLE'].join(''),
    ['VACU', 'UM'].join(''),
  ]
  for (const needle of needles) {
    assert.ok(
      !new RegExp(needle, 'i').test(LEDGER_SOURCE),
      `ledger.mjs unexpectedly contains the destructive-SQL needle: ${needle}`,
    )
  }
})

// --- AC-13: test hygiene (both test files never name the CLI-only default-db-path resolver) --

test('AC-13: neither test file references the CLI-only default-db-path resolver by name', () => {
  const needle = ['default', 'Db', 'Path'].join('')
  const otherSource = readFileSync(join(ROOT, 'test', 'factory-ledger.test.mjs'), 'utf8')
  assert.ok(!SELF_SOURCE.includes(needle), 'this file references the forbidden symbol')
  assert.ok(!otherSource.includes(needle), 'the sqlite test file references the forbidden symbol')
})

// --- self-referential no-exclusion-token assertion --------------------------

test('this file contains no node:test exclusion directive (self-assertion; word-boundary aware to tolerate "skipped" as a status value)', () => {
  const needle = ['s', 'k', 'i', 'p'].join('')
  const wordBoundary = new RegExp(`\\b${needle}\\b`, 'i')
  assert.ok(!wordBoundary.test(SELF_SOURCE), 'floor test file unexpectedly contains an exclusion token as a standalone word')
})

// --- parse + import-safety --------------------------------------------------

test('node --check parses scripts/factory/ledger.mjs cleanly', () => {
  const res = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
})

test('importing the module performs no I/O and installs no signal handler', () => {
  const before = {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
  }
  const res = spawnSync(process.execPath, ['-e', `
    import('${new URL('../scripts/factory/ledger.mjs', import.meta.url).href}').then(() => {
      console.log(JSON.stringify({
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
      }))
    })
  `, '--input-type=module'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.sigterm, 0)
  assert.equal(out.sigint, 0)
  void before
})

test('AC-11 (source-text half): no process.on("SIG…) call appears outside installFinalizer', () => {
  // S10: matches BOTH spellings a listener install could take — the
  // variable form this file's own code uses (`process.on(sig, fn)`) AND a
  // hardcoded string-literal form (`process.on('SIGTERM', ...)` /
  // `process.on("SIGTERM"`) that would otherwise slip past a
  // variable-only needle. Fragment-built so this test file itself never
  // spells out the literal call shape it is hunting for.
  const openCall = ['process', '\\.on\\('].join('')
  const sigCallRe = new RegExp(`${openCall}\\s*(sig\\b|['"]SIG)`, 'g')
  const bodyStart = LEDGER_SOURCE.indexOf('function installFinalizerImpl')
  const bodyEnd = LEDGER_SOURCE.indexOf('\n}\n', bodyStart)
  const outsideBody = LEDGER_SOURCE.slice(0, bodyStart) + LEDGER_SOURCE.slice(bodyEnd)
  assert.ok(bodyStart !== -1 && bodyEnd !== -1, 'could not locate installFinalizerImpl body bounds')
  assert.ok(!sigCallRe.test(outsideBody), 'a process.on(SIG…) call appears outside installFinalizerImpl')
})

// MUST-FIX (fix round 2): the finalizer must source truth from the
// IN-PROCESS REGISTRY, never the mirror (getSession/dumpTable return
// null/[] on a degraded handle even though the JSONL raw record is still
// being written). This handle is forced below floor via nodeVersion
// injection — it never touches node:sqlite, so it belongs in this
// zero-condition-excluded file, not the sqlite-dependent one.
test('below-floor (degraded) finalizer still records endSession(fail) and endProcess JSONL lines', { timeout: 15000 }, async () => {
  const dbPath = join(fixture, 'degraded-finalizer.db')
  const jsonlPath = join(fixture, 'degraded-finalizer.jsonl')
  const program = `
    const { openLedger } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
    const ledger = openLedger({
      dbPath: ${JSON.stringify(dbPath)}, jsonlPath: ${JSON.stringify(jsonlPath)}, nodeVersion: '20.11.0',
    });
    ledger.startSession({ adw_id: 'deg-1', repo_slug: 'r', task_slug: 't' });
    ledger.startProcess({ adw_id: 'deg-1', dispatch_id: 'd', pid: process.pid, command: 'child' });
    ledger.installFinalizer({ adw_id: 'deg-1' });
    setInterval(() => {}, 1000);
  `
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const exitInfo = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const { code, signal } = await exitInfo
  assert.ok(signal === 'SIGTERM' || code === 143, `expected the child to terminate on SIGTERM, got code=${code} signal=${signal}`)

  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const forThisRun = lines.filter((l) => l.args && l.args.adw_id === 'deg-1')
  const kinds = forThisRun.map((l) => l.kind)
  assert.ok(kinds.includes('startSession'), 'startSession JSONL line missing')
  assert.ok(kinds.includes('endSession'), 'endSession(fail) JSONL line missing on a degraded handle — the finalizer likely read the mirror instead of the registry')
  const endSessionLine = forThisRun.find((l) => l.kind === 'endSession')
  assert.equal(endSessionLine.args.status, 'fail')
  assert.ok(kinds.includes('startProcess'), 'startProcess JSONL line missing')
  assert.ok(kinds.includes('endProcess'), 'endProcess JSONL line missing on a degraded handle — the finalizer likely read the mirror instead of the registry')
})

after(() => {
  assert.ok(registeredCount >= 1, 'this floor test file registered zero tests')
})
