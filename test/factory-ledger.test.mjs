// test/factory-ledger.test.mjs — the node:sqlite-dependent half of the
// factory ledger suite. Self-skips every test below NODE_FLOOR (this is the
// one file in the split that is ALLOWED to contain skips — see
// test/factory-ledger-floor.test.mjs for the zero-condition-excluded half).
// Covers: schema exactness, pragma readback, migration idempotence/upgrade,
// JSONL->db replay equality, the polling query + its index, dual-write
// failure isolation, field-hygiene redaction, the kill refusal gates, the
// finalizer's runtime behavior, and the FTS5 capability probe.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { ROOT } from './helpers.mjs'
// Inlined from the retired legacy runtime's contract (scripts/cmux/contract.mjs):
// the completion-nonce prefix the ledger's sweep guard checks against.
const NONCE_PREFIX = 'devteam-done-'
import {
  openLedger, replayJsonl, TABLES, MIGRATIONS, applyMigrations, NODE_FLOOR,
  TERM_TO_KILL_MS, WRITERS, LedgerUsageError,
} from '../scripts/factory/ledger.mjs'

const SCRIPT = join(ROOT, 'scripts', 'factory', 'ledger.mjs')
// AC-13 (both test files never reference the CLI-only default-db-path
// resolver by name) is asserted from test/factory-ledger-floor.test.mjs,
// which scans this file's source text too.

const require = createRequire(import.meta.url)

function sqliteAvailable() {
  try {
    require('node:sqlite')
    return true
  } catch {
    return false
  }
}
const SQLITE_OK = sqliteAvailable()
const SKIP = SQLITE_OK ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`

const fixture = mkdtempSync(join(tmpdir(), 'factory-ledger-'))
after(() => rmSync(fixture, { recursive: true, force: true }))

// Safety-net process cleanup: every long-lived child spawned by the
// kill/finalizer tests is tracked here so a failing assertion mid-test
// cannot leak it — swept unconditionally in the top-level after() hook.
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

let n = 0
function nextDir() {
  n += 1
  const dir = join(fixture, `l${n}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_LEDGER_DB: join(nextDir(), 'ledger.db'), ...env },
  })
}

function openTestLedger(extra = {}) {
  const dir = nextDir()
  return openLedger({ dbPath: join(dir, 'ledger.db'), stderr: { write: () => {} }, ...extra })
}

// ---------------------------------------------------------------------------
// AC-1: schema exactness
// ---------------------------------------------------------------------------

test('AC-1: every table\'s live PRAGMA table_info columns deepEqual the TABLES-declared column list, in order', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'x', repo_slug: 'r', task_slug: 't' })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(ledger._dbPath)
  for (const [table, def] of Object.entries(TABLES)) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
    assert.deepEqual(cols, def.columns.map((c) => c.name), `table ${table} column mismatch`)
  }
  db.close()
})

// ---------------------------------------------------------------------------
// M1: dumpTable('sessions') must not silently return [] (regression: the
// naturalKey fallback used a hardcoded 'id' column that sessions does not
// have — its primary key is adw_id — so the ORDER BY threw and the bare
// catch swallowed it into an empty array).
// ---------------------------------------------------------------------------

test("M1: dumpTable('sessions') returns the seeded row (not silently vacuous)", { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'sess-1', repo_slug: 'r', task_slug: 't' })
  const rows = ledger.dumpTable('sessions')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].adw_id, 'sess-1')
  // A real query failure here must be COUNTED, not swallowed as a fake
  // "table has zero rows" result.
  assert.deepEqual(ledger.dumpTable('sessions'), rows)
})

// ---------------------------------------------------------------------------
// M2: startPhase must not trust a stale, connection-global lastInsertRowid
// when its INSERT OR IGNORE is actually ignored (a natural-key collision).
// ---------------------------------------------------------------------------

test('M2: an explicit (adw_id, seq) collision on startPhase returns the ORIGINAL phase id and leaves exactly one row', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const firstId = ledger.startPhase({ adw_id: 'coll-1', seq: 1, name: 'first' })
  assert.ok(Number.isInteger(firstId))
  // Insert into a DIFFERENT table in between, so a stale connection-global
  // lastInsertRowid (if wrongly trusted) would visibly point at the wrong
  // row/table rather than coincidentally matching by luck.
  ledger.startProcess({ adw_id: 'coll-1', dispatch_id: 'd', pid: 12345, command: 'noop' })
  const secondId = ledger.startPhase({ adw_id: 'coll-1', seq: 1, name: 'second-should-be-ignored' })
  assert.equal(secondId, firstId, 'a duplicate (adw_id, seq) must return the ORIGINAL phase id, not a foreign rowid')
  const rows = ledger.dumpTable('phases').filter((p) => p.adw_id === 'coll-1')
  assert.equal(rows.length, 1, 'INSERT OR IGNORE must leave exactly one row on a natural-key collision')
  assert.equal(rows[0].name, 'first', 'the original row must survive untouched (never re-written by the ignored insert)')
})

// ---------------------------------------------------------------------------
// AC-3: pragmas read back from the live connection
// ---------------------------------------------------------------------------

test('AC-3: journal_mode/synchronous/busy_timeout read back from the live connection', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'x', repo_slug: 'r', task_slug: 't' })
  // Read pragmas from the LEDGER'S OWN live connection: synchronous and
  // busy_timeout are per-connection settings (unlike journal_mode, which
  // persists in the file header) and would silently reset to SQLite
  // defaults on a second, freshly-opened connection to the same file.
  const p = ledger._pragmas()
  assert.equal(p.journal_mode, 'wal')
  assert.equal(p.synchronous, 1)
  assert.equal(p.busy_timeout, 5000)
})

// ---------------------------------------------------------------------------
// AC-4: additive, idempotent migrations
// ---------------------------------------------------------------------------

test('AC-4: running the full migration list twice is a no-op', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'mig.db')
  const db = new DatabaseSync(dbPath)
  applyMigrations(db)
  const before = {}
  for (const table of Object.keys(TABLES)) {
    before[table] = db.prepare(`PRAGMA table_info(${table})`).all()
  }
  assert.doesNotThrow(() => applyMigrations(db))
  for (const table of Object.keys(TABLES)) {
    assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all(), before[table])
  }
  db.close()
})

test('AC-4: a db created by an earlier migration prefix opens cleanly under the full list and ends with the full column set', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'mig-prefix.db')
  const db = new DatabaseSync(dbPath)
  const k = Math.max(1, Math.floor(MIGRATIONS.length / 2))
  applyMigrations(db, MIGRATIONS.slice(0, k))
  assert.doesNotThrow(() => applyMigrations(db, MIGRATIONS))
  for (const [table, def] of Object.entries(TABLES)) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
    assert.deepEqual(cols, def.columns.map((c) => c.name), `table ${table} not fully upgraded`)
  }
  db.close()
})

// ---------------------------------------------------------------------------
// AC-5: reconstructability via replayJsonl
// ---------------------------------------------------------------------------

function exerciseEveryWriter(ledger, adwId) {
  ledger.startSession({ adw_id: adwId, repo_slug: 'repo', task_slug: 'task' })
  const phaseId = ledger.startPhase({ adw_id: adwId, name: 'plan' })
  ledger.recordEvent({
    adw_id: adwId, type: 'phase_start', phase_id: phaseId, payload: { name: 'plan' },
  })
  ledger.recordEnvelope({
    adw_id: adwId, dispatch_id: 'd1', slice_id: 's1', attempt: 1, role: 'executor',
    produced_at: Date.now(), schema_version: 1, envelope_path: '/tmp/e.json',
    body_kind: 'done', valid: true, violation_names: [],
  })
  ledger.recordGateResult({
    adw_id: adwId, phase_id: phaseId, gate_name: 'g1', attempt: 1, ok: true,
    checks: [{ item: 'a', ok: true, note: '' }], violations: [],
  })
  ledger.startProcess({ adw_id: adwId, dispatch_id: 'd1', pid: 4242, command: 'node x.mjs' })
  ledger.heartbeat({ adw_id: adwId, target: 'process', pid: 4242, started_at: ledger.dumpTable('processes')[0].started_at })
  ledger.endProcess({
    adw_id: adwId, pid: 4242, started_at: ledger.dumpTable('processes')[0].started_at,
    exit_code: 0, exit_signal: null, state: 'exited',
  })
  ledger.startAgentSession({
    adw_id: adwId, dispatch_id: 'd1', role: 'executor', model: 'sonnet',
    claude_session_id: 'cs1', transcript_path: '/tmp/t.jsonl',
  })
  ledger.heartbeat({ adw_id: adwId, target: 'agent_session', claude_session_id: 'cs1' })
  ledger.endAgentSession({
    adw_id: adwId, claude_session_id: 'cs1', context_tokens: 100, context_window: 200000,
    raw_read_tokens: 50, raw_written_tokens: 60, billed_input_tokens: 50,
    billed_output_tokens: 60, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0,
  })
  ledger.recordSourceError({
    adw_id: adwId, source_path: '/tmp/bad.json', source_kind: 'return-envelope',
    byte_size: 12, violation_names: ['body.role:enum'], reason: 'RecordInvalidError',
  })
  ledger.recordEvent({ adw_id: adwId, type: 'decision', payload: { decided: 'x', why: 'y', alternatives: [] } })
  ledger.endPhase({ adw_id: adwId, seq: 1, status: 'ok' })
  ledger.endSession({ adw_id: adwId, status: 'ok', billed_cost_usd: 1.23 })
}

test('AC-5: replaying the JSONL through the public write API into a fresh db reproduces the original dump row for row', { skip: SKIP }, () => {
  const dir1 = nextDir()
  const ledger1 = openLedger({ dbPath: join(dir1, 'ledger.db'), stderr: { write: () => {} } })
  exerciseEveryWriter(ledger1, 'run-1')
  const original = {}
  for (const table of Object.keys(TABLES)) {
    original[table] = ledger1.dumpTable(table)
  }

  const dir2 = nextDir()
  const ledger2 = openLedger({ dbPath: join(dir2, 'ledger.db'), stderr: { write: () => {} } })
  const { applied, skipped } = replayJsonl(ledger1._jsonlPath, ledger2)
  assert.ok(applied > 0)
  assert.equal(skipped, 0)

  const replayed = {}
  for (const table of Object.keys(TABLES)) {
    replayed[table] = ledger2.dumpTable(table)
  }
  assert.deepEqual(replayed, original)

  // Replaying the same JSONL again into the already-populated db is a no-op.
  replayJsonl(ledger1._jsonlPath, ledger2)
  const replayedAgain = {}
  for (const table of Object.keys(TABLES)) {
    replayedAgain[table] = ledger2.dumpTable(table)
  }
  assert.deepEqual(replayedAgain, replayed)
})

// ---------------------------------------------------------------------------
// AC-6: polling query + index
// ---------------------------------------------------------------------------

test('AC-6: listEvents serves ordered, limited, afterRowid-exclusive pages, and its query plan names the events index', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  for (let i = 0; i < 5; i++) {
    ledger.recordEvent({ adw_id: 'tail-1', type: 'log', payload: { level: 'info', message: `m${i}` } })
  }
  ledger.recordEvent({ adw_id: 'other', type: 'log', payload: { level: 'info', message: 'x' } })

  const page1 = ledger.listEvents({ adw_id: 'tail-1', afterRowid: 0, limit: 2 })
  assert.equal(page1.length, 2)
  assert.equal(page1[0].seq, 1)
  assert.equal(page1[1].seq, 2)

  const page2 = ledger.listEvents({ adw_id: 'tail-1', afterRowid: page1[1].id, limit: 10 })
  assert.equal(page2.length, 3)
  assert.equal(page2[0].seq, 3)
  assert.ok(page2.every((r) => r.adw_id === 'tail-1'))

  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(ledger._dbPath)
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE adw_id = ? AND id > ? ORDER BY id LIMIT ?').all('tail-1', 0, 10)
  const detail = plan.map((r) => r.detail).join(' | ')
  assert.match(detail, /events_adw_id_idx/)
  db.close()
})

// ---------------------------------------------------------------------------
// AC-7: JSONL precedes db; a db failure never propagates
// ---------------------------------------------------------------------------

test('AC-7: a write after close() does not throw, still lands its JSONL line, and pins the first mirror error code', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'closer', repo_slug: 'r', task_slug: 't' })
  ledger.close()

  assert.doesNotThrow(() => ledger.endSession({ adw_id: 'closer', status: 'ok' }))
  const jsonlLines = readFileSync(ledger._jsonlPath, 'utf8').split('\n').filter(Boolean)
  assert.ok(jsonlLines.length >= 2)
  for (const line of jsonlLines) assert.doesNotThrow(() => JSON.parse(line))

  const s1 = ledger.stats()
  assert.equal(s1.mirror_errors, 1)
  assert.ok(s1.mirror_first_code)

  assert.doesNotThrow(() => ledger.recordEvent({ adw_id: 'closer', type: 'log', payload: { level: 'info', message: 'x' } }))
  const s2 = ledger.stats()
  assert.equal(s2.mirror_errors, 2)
  assert.equal(s2.mirror_first_code, s1.mirror_first_code)
})

// ---------------------------------------------------------------------------
// AC-9: field-hygiene mutation test
// ---------------------------------------------------------------------------

const MARKER_ADW = 'devteam-done-marker-should-never-persist-anywhere'

function seedAllWritersWithMarker(ledger) {
  const ctx = 'marker-run'
  ledger.startSession({ adw_id: ctx, repo_slug: 'r', task_slug: 't', DEVTEAM_SECRET: MARKER_ADW })
  const phaseId = ledger.startPhase({ adw_id: ctx, name: MARKER_ADW })
  ledger.recordEvent({ adw_id: ctx, type: 'phase_start', phase_id: phaseId, payload: { name: MARKER_ADW } })
  ledger.recordEnvelope({
    adw_id: ctx, dispatch_id: 'd', slice_id: 's', attempt: 1, role: 'executor',
    produced_at: Date.now(), schema_version: 1, envelope_path: MARKER_ADW,
    body_kind: 'done', valid: false, violation_names: [`${MARKER_ADW}:enum`],
  })
  ledger.recordGateResult({
    adw_id: ctx, phase_id: phaseId, gate_name: 'g', attempt: 1, ok: false,
    checks: [{ item: MARKER_ADW, ok: false, note: MARKER_ADW }], violations: [MARKER_ADW],
  })
  ledger.startProcess({ adw_id: ctx, dispatch_id: 'd', pid: 555, command: MARKER_ADW })
  const started = ledger.dumpTable('processes').find((p) => p.pid === 555).started_at
  ledger.heartbeat({ adw_id: ctx, target: 'process', pid: 555, started_at: started })
  ledger.endProcess({ adw_id: ctx, pid: 555, started_at: started, exit_code: 1, exit_signal: MARKER_ADW, state: 'exited' })
  ledger.startAgentSession({
    adw_id: ctx, dispatch_id: 'd', role: 'executor', model: MARKER_ADW,
    claude_session_id: 'cs-marker', transcript_path: MARKER_ADW,
  })
  ledger.heartbeat({ adw_id: ctx, target: 'agent_session', claude_session_id: 'cs-marker' })
  ledger.endAgentSession({
    adw_id: ctx, claude_session_id: 'cs-marker', context_tokens: 1, context_window: 2,
    raw_read_tokens: 1, raw_written_tokens: 1, billed_input_tokens: 1, billed_output_tokens: 1,
    billed_cache_write_tokens: 1, billed_cache_read_tokens: 1,
  })
  ledger.recordSourceError({
    adw_id: ctx, source_path: MARKER_ADW, source_kind: 'return-envelope', byte_size: 1,
    violation_names: [], reason: 'SyntaxError',
  })
  ledger.endPhase({ adw_id: ctx, seq: 1, status: 'ok' })
  ledger.endSession({ adw_id: ctx, status: 'ok' })
}

test('AC-9: a nonce-prefix-bearing marker planted across every public writer never survives in any table column, the JSONL bytes, or stderr', { skip: SKIP }, () => {
  const stderrLines = []
  const ledger = openTestLedger({ stderr: { write: (s) => stderrLines.push(s) } })
  seedAllWritersWithMarker(ledger)

  for (const table of Object.keys(TABLES)) {
    const rows = ledger.dumpTable(table)
    const dump = JSON.stringify(rows)
    assert.ok(!dump.includes(MARKER_ADW), `marker leaked into table ${table}: ${dump}`)
  }

  const jsonlBytes = readFileSync(ledger._jsonlPath, 'utf8')
  assert.ok(!jsonlBytes.includes(MARKER_ADW), 'marker leaked into the JSONL raw record')

  assert.ok(!stderrLines.join('').includes(MARKER_ADW), 'marker leaked into the injected stderr sink')

  // S5 fix: point the out-of-process CLI at THIS test's actual seeded db
  // path (not a fresh empty directory) — otherwise `sessions` always
  // reports zero rows and the assertion below can never fail.
  const res = run(['sessions'], { DEVTEAM_LEDGER_DB: ledger._dbPath })
  assert.equal(res.status, 0)
  assert.ok(!(res.stdout || '').includes(MARKER_ADW), 'marker leaked into a real out-of-process CLI stdout run')
  assert.ok(!(res.stderr || '').includes(MARKER_ADW), 'marker leaked into a real out-of-process CLI stderr run')
})

// --- AC-9a/AC-9b: the two redaction guards, tested INDEPENDENTLY ----------
//
// The comprehensive test above only exercises the nonce-prefix-substring
// guard (every marker it plants reaches redact() as a plain string value
// under a normal key — e.g. `command`, `model` — never as a DEVTEAM_*-shaped
// KEY, because every writer's own closed field list means an arbitrary
// extra input key like `DEVTEAM_SECRET` on `startSession` never reaches
// redact() at all). That made the DEVTEAM_-key guard untested: deleting it
// left the comprehensive test green. These two tests isolate each guard.

const MARKER_PLAIN = 'plain-marker-no-nonce-prefix-should-never-persist'
const MARKER_NONCE_ONLY = `${NONCE_PREFIX}nonce-only-marker-should-never-persist`

test('AC-9a: a DEVTEAM_*-shaped key nested inside an allowlisted payload VALUE is dropped (stats().redacted_values grows)', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const before = ledger.stats().redacted_values
  // 'message' is an allowlisted key for the 'log' event type; its VALUE is
  // caller-shaped (any JSON), so a nested object under it is a legitimate
  // place for a DEVTEAM_*-shaped key to actually reach redact() (unlike a
  // writer's own fixed top-level input fields, which never do).
  ledger.recordEvent({
    adw_id: 'm9a', type: 'log',
    payload: { level: 'info', message: { DEVTEAM_SECRET: MARKER_PLAIN, safe: 'kept' } },
  })
  const after = ledger.stats().redacted_values
  assert.ok(after > before, 'stats().redacted_values did not grow for a DEVTEAM_*-shaped key')
  const row = ledger.dumpTable('events').find((r) => r.adw_id === 'm9a')
  const payload = JSON.parse(row.payload_json)
  assert.ok(!JSON.stringify(payload).includes(MARKER_PLAIN), 'DEVTEAM_-keyed marker leaked into the events table')
  assert.equal(payload.message.safe, 'kept', 'the sibling non-DEVTEAM key must survive redaction')
  const jsonlBytes = readFileSync(ledger._jsonlPath, 'utf8')
  assert.ok(!jsonlBytes.includes(MARKER_PLAIN), 'DEVTEAM_-keyed marker leaked into the JSONL raw record')
})

test('AC-9b: a nonce-prefix-bearing value under an ordinary (non-DEVTEAM) key is dropped (stats().redacted_values grows)', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const before = ledger.stats().redacted_values
  ledger.recordEvent({
    adw_id: 'm9b', type: 'log',
    payload: { level: 'info', message: MARKER_NONCE_ONLY },
  })
  const after = ledger.stats().redacted_values
  assert.ok(after > before, 'stats().redacted_values did not grow for a nonce-bearing value')
  const dump = JSON.stringify(ledger.dumpTable('events'))
  assert.ok(!dump.includes(MARKER_NONCE_ONLY), 'nonce-bearing marker leaked into the events table')
  const jsonlBytes = readFileSync(ledger._jsonlPath, 'utf8')
  assert.ok(!jsonlBytes.includes(MARKER_NONCE_ONLY), 'nonce-bearing marker leaked into the JSONL raw record')
})

// --- S3: a marker-bearing INVALID value must never reach a refusal message
test('S3: a marker-bearing invalid value never reaches the refusal message at any of the four validator/reader sites', { skip: SKIP }, () => {
  const ledger = openTestLedger()

  // requireEnum (endSession's status)
  assert.throws(
    () => ledger.endSession({ adw_id: 'x', status: MARKER_NONCE_ONLY }),
    (err) => !String(err.message).includes(MARKER_NONCE_ONLY),
  )

  // isoMs (a marker-bearing non-ISO string passed as a timestamp)
  assert.throws(
    () => ledger.startSession({
      adw_id: 'y', repo_slug: 'r', task_slug: 't', started_at: MARKER_NONCE_ONLY,
    }),
    (err) => !String(err.message).includes(MARKER_NONCE_ONLY),
  )

  // dumpTable (unknown table name)
  assert.throws(
    () => ledger.dumpTable(MARKER_NONCE_ONLY),
    (err) => !String(err.message).includes(MARKER_NONCE_ONLY),
  )

  // replayJsonl (unknown JSONL `kind`)
  const dir = nextDir()
  const jsonlPath = join(dir, 'bad.jsonl')
  writeFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: MARKER_NONCE_ONLY, at: new Date().toISOString(), args: {} })}\n`)
  assert.throws(
    () => replayJsonl(jsonlPath, ledger),
    (err) => !String(err.message).includes(MARKER_NONCE_ONLY),
  )
})

// ---------------------------------------------------------------------------
// AC-10: kill helper refusal gates
// ---------------------------------------------------------------------------

test('kill refuses when required flags are missing', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'a'])
  assert.equal(res.status, 2)
})

test('kill refuses for pid <= 1', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'a', '--pid', '1', '--yes'])
  assert.equal(res.status, 2)
})

// Despite the name of the gate ("pid matches this process or its parent"),
// passing THIS test's own pid as --pid only ever exercises the ppid half:
// the kill CLI runs as a freshly spawned subprocess, so its own
// process.pid is a value this test cannot know before spawning it — the
// `pidNum === process.pid` disjunct is therefore untestable out-of-process
// by construction. See the dedicated S8 test below for the same coverage,
// named accurately.
test('kill refuses when --pid equals the CLI subprocess\'s parent pid', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'a', '--pid', String(process.pid), '--yes'])
  assert.equal(res.status, 2)
})

test('kill refuses when no processes row matches (adw_id, pid)', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'no-such-adw', '--pid', '999999', '--yes'])
  assert.equal(res.status, 2)
})

// S8(b): a live pid whose recorded `command` deliberately does not match
// the process's real, live command must refuse and send no signal.
test('S8: kill refuses when the recorded command does not match the live process (no signal sent)', { skip: SKIP, timeout: 10000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  ledger.startProcess({
    adw_id: 'mismatch-1', dispatch_id: 'd', pid: child.pid, command: 'totally-not-the-real-command --deliberately-wrong',
  })
  ledger.close()

  const res = run(['kill', '--adw-id', 'mismatch-1', '--pid', String(child.pid), '--yes'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /command does not match/)
  // No signal was sent — the child must still be alive.
  let alive = true
  try {
    process.kill(child.pid, 0)
  } catch {
    alive = false
  }
  assert.ok(alive, 'the mismatched-command gate must refuse before sending any signal')
})

test('TERM_TO_KILL_MS is exported and equals 5000', { skip: SKIP }, () => {
  assert.equal(TERM_TO_KILL_MS, 5000)
})

test('kill happy path terminates a test-spawned child whose recorded command matches the live ps output', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const psRes = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' })
  const command = (psRes.stdout || '').trim()
  ledger.startProcess({ adw_id: 'kill-me', dispatch_id: 'd', pid: child.pid, command })
  ledger.close()

  const exited = new Promise((resolve) => child.on('exit', resolve))
  // spawn, not spawnSync: the kill CLI blocks its OWN process for up to
  // TERM_TO_KILL_MS waiting for the target to die (Atomics.wait, per the
  // module's kill-gate design). A spawnSync here would block THIS test
  // runner's event loop too — and since this test runner is `child`'s real
  // parent, that would prevent it from ever reaping `child`'s exit, which
  // leaves a zombie that a signal-0 liveness probe still reports as
  // "alive" for as long as the reap is stalled, racing the CLI's own wait.
  const killProc = trackChild(spawn(process.execPath, [SCRIPT, 'kill', '--adw-id', 'kill-me', '--pid', String(child.pid), '--yes'], {
    env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath },
  }))
  let stdout = ''
  killProc.stdout.on('data', (d) => { stdout += d })
  const [status] = await Promise.all([
    new Promise((resolve) => killProc.on('exit', resolve)),
    exited,
  ])
  assert.equal(status, 0)
  assert.match(stdout, /"result":"terminated"/)
})

// S8: exercises the SIGTERM-exhausted -> re-check -> SIGKILL escalation
// path against a target that deliberately traps and ignores SIGTERM.
// DEVTEAM_LEDGER_TERM_TO_KILL_MS (a CLI-only TEST SEAM, see its definition
// in ledger.mjs) shortens the wait from 5s to 200ms so this stays fast.
test('kill escalates to SIGKILL when the target traps and ignores SIGTERM', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const child = trackChild(spawn(process.execPath, [
    '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const psRes = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' })
  const command = (psRes.stdout || '').trim()
  ledger.startProcess({ adw_id: 'kill-trap', dispatch_id: 'd', pid: child.pid, command })
  ledger.close()

  const exited = new Promise((resolve) => child.on('exit', resolve))
  const killProc = trackChild(spawn(process.execPath, [SCRIPT, 'kill', '--adw-id', 'kill-trap', '--pid', String(child.pid), '--yes'], {
    env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath, DEVTEAM_LEDGER_TERM_TO_KILL_MS: '200' },
  }))
  let stdout = ''
  killProc.stdout.on('data', (d) => { stdout += d })
  const [status] = await Promise.all([
    new Promise((resolve) => killProc.on('exit', resolve)),
    exited,
  ])
  assert.equal(status, 0)
  assert.match(stdout, /"result":"killed"/)
})

// ---------------------------------------------------------------------------
// AC-11 (runtime half): finalizer idempotence + signal landing
// ---------------------------------------------------------------------------

test('installFinalizer is idempotent: a second call installs nothing and returns the same handle', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const before = process.listenerCount('SIGTERM')
  const h1 = ledger.installFinalizer({ adw_id: 'fin-1' })
  const afterFirst = process.listenerCount('SIGTERM')
  const h2 = ledger.installFinalizer({ adw_id: 'fin-1' })
  const afterSecond = process.listenerCount('SIGTERM')
  assert.equal(afterFirst - before, 1)
  assert.equal(afterSecond, afterFirst)
  assert.equal(h1, h2)
  h1.uninstall()
  assert.equal(process.listenerCount('SIGTERM'), before)
})

test('AC-11: on SIGTERM the finalizer lands the session as fail, closes running processes rows, and does not swallow the signal', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const program = `
    const { openLedger, isoMs } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
    const ledger = openLedger({ dbPath: ${JSON.stringify(dbPath)} });
    ledger.startSession({ adw_id: 'sig-1', repo_slug: 'r', task_slug: 't' });
    ledger.startProcess({ adw_id: 'sig-1', dispatch_id: 'd', pid: process.pid, command: 'child' });
    ledger.installFinalizer({ adw_id: 'sig-1' });
    setInterval(() => {}, 1000);
  `
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const exitInfo = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const { code, signal } = await exitInfo
  assert.ok(signal === 'SIGTERM' || code === 143, `expected the child to terminate on SIGTERM, got code=${code} signal=${signal}`)

  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const session = ledger.getSession('sig-1')
  assert.equal(session.status, 'fail')
  const runningProcs = ledger.dumpTable('processes').filter((p) => p.adw_id === 'sig-1' && p.state === 'running')
  assert.equal(runningProcs.length, 0)
})

// Cheap add: pins endSession's COALESCE behavior directly, independent of
// the finalizer's own read-first guard above — reverting the COALESCE(?,
// column) SQL back to a bare `?` must make this go red on its own.
test('endSession COALESCE: a later endSession({status}) call with no spend figures leaves previously-recorded spend intact', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'coalesce-1', repo_slug: 'r', task_slug: 't' })
  ledger.endSession({ adw_id: 'coalesce-1', status: 'ok', billed_input_tokens: 42, billed_cost_usd: 1.5 })
  ledger.endSession({ adw_id: 'coalesce-1', status: 'fail' })
  const session = ledger.getSession('coalesce-1')
  assert.equal(session.status, 'fail')
  assert.equal(session.billed_input_tokens, 42, 'a bare status-only endSession must not null out previously-recorded spend')
  assert.equal(session.billed_cost_usd, 1.5, 'a bare status-only endSession must not null out previously-recorded spend')
})

// S6: a signal arriving AFTER the run's own clean endSession(ok, spend)
// must be a no-op over the finalizer — not overwrite status to 'fail' nor
// NULL out the already-recorded spend figures via an unconditional UPDATE.
test('S6: the finalizer never overwrites an already-completed session or clobbers its recorded spend', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const program = `
    const { openLedger } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
    const ledger = openLedger({ dbPath: ${JSON.stringify(dbPath)} });
    ledger.startSession({ adw_id: 'sig-2', repo_slug: 'r', task_slug: 't' });
    ledger.endSession({ adw_id: 'sig-2', status: 'ok', billed_input_tokens: 111, billed_cost_usd: 4.56 });
    ledger.installFinalizer({ adw_id: 'sig-2' });
    setInterval(() => {}, 1000);
  `
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const exitInfo = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  await exitInfo

  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const session = ledger.getSession('sig-2')
  assert.equal(session.status, 'ok', 'the finalizer must not overwrite an already-ok session as fail')
  assert.equal(session.billed_input_tokens, 111, 'the finalizer must not clobber already-recorded spend')
  assert.equal(session.billed_cost_usd, 4.56, 'the finalizer must not clobber already-recorded spend')
})

// ---------------------------------------------------------------------------
// AC-14: FTS5 capability probe (printed only, never asserted about its value)
// ---------------------------------------------------------------------------

test('AC-14: the FTS5 probe returns a shaped capability readout', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const probe = ledger._probeFts5()
  assert.equal(typeof probe.available, 'boolean')
  const doctorRes = run(['doctor'])
  const payload = JSON.parse(doctorRes.stdout)
  assert.equal(typeof payload.fts5.available, 'boolean')
})

// ---------------------------------------------------------------------------
// S11(c): concurrent first-open race (one retry on a locked open, never
// permanently degrading a handle purely for losing a benign race)
// ---------------------------------------------------------------------------

test('S11(c): two processes racing to open + migrate the same fresh db both complete their write without throwing or crashing', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  function raceProgram(adwId) {
    return `
      const { openLedger } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
      const ledger = openLedger({ dbPath: ${JSON.stringify(dbPath)} });
      ledger.startSession({ adw_id: ${JSON.stringify(adwId)}, repo_slug: 'r', task_slug: 't' });
    `
  }
  const run1 = spawn(process.execPath, ['--input-type=module', '-e', raceProgram('race-a')], { stdio: 'ignore' })
  const run2 = spawn(process.execPath, ['--input-type=module', '-e', raceProgram('race-b')], { stdio: 'ignore' })
  trackChild(run1)
  trackChild(run2)
  const [exit1, exit2] = await Promise.all([
    new Promise((resolve) => run1.on('exit', (code) => resolve(code))),
    new Promise((resolve) => run2.on('exit', (code) => resolve(code))),
  ])
  // Deliberately NOT asserting on degraded state (that would be flaky —
  // whether either side actually observes the lock race depends on OS
  // scheduling). What must ALWAYS hold: neither child crashed, and the
  // shared JSONL raw record — the authority — has both lines intact.
  assert.equal(exit1, 0, 'first racing child crashed')
  assert.equal(exit2, 0, 'second racing child crashed')
  const jsonlLines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
  const adwIds = jsonlLines.map((l) => JSON.parse(l).args.adw_id)
  assert.ok(adwIds.includes('race-a'), 'race-a JSONL line missing')
  assert.ok(adwIds.includes('race-b'), 'race-b JSONL line missing')
})

// ---------------------------------------------------------------------------
// S12: cheap missing negative tests
// ---------------------------------------------------------------------------

test('S12: replayJsonl throws LedgerUsageError on an unknown kind', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dir = nextDir()
  const jsonlPath = join(dir, 'bad-kind.jsonl')
  writeFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: 'notAWriter', at: new Date().toISOString(), args: {} })}\n`)
  assert.throws(() => replayJsonl(jsonlPath, ledger), LedgerUsageError)
})

test('S12: replayJsonl counts a corrupted/truncated line as skipped without crashing', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dir = nextDir()
  const jsonlPath = join(dir, 'corrupt.jsonl')
  const goodLine = JSON.stringify({
    v: 1, kind: 'startSession', at: new Date().toISOString(),
    args: { adw_id: 'ok-1', repo_slug: 'r', task_slug: 't' },
  })
  writeFileSync(jsonlPath, `${goodLine}\n{not valid json truncated\n`)
  const { applied, skipped } = replayJsonl(jsonlPath, ledger)
  assert.equal(applied, 1)
  assert.equal(skipped, 1)
})

test('S12: a writer THROWS when the JSONL append fails (jsonlPath points at an existing directory)', { skip: SKIP }, () => {
  const dir = nextDir()
  const jsonlAsDir = join(dir, 'ledger.jsonl')
  mkdirSync(jsonlAsDir, { recursive: true })
  const ledger = openLedger({ dbPath: join(dir, 'ledger.db'), jsonlPath: jsonlAsDir, stderr: { write: () => {} } })
  assert.throws(() => ledger.startSession({ adw_id: 'x', repo_slug: 'r', task_slug: 't' }))
})

test('S12: an unrecognized payload key on a log event is dropped from payload_json AND counted in stats().dropped_payload_keys', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const before = ledger.stats().dropped_payload_keys
  ledger.recordEvent({
    adw_id: 'drop-1', type: 'log', payload: { level: 'info', message: 'hi', secret: 'nope' },
  })
  const after = ledger.stats().dropped_payload_keys
  assert.ok(after > before, 'dropped_payload_keys did not grow for an unrecognized payload key')
  const row = ledger.dumpTable('events').find((r) => r.adw_id === 'drop-1')
  const payload = JSON.parse(row.payload_json)
  assert.ok(!('secret' in payload), 'the unrecognized key must be absent from the stored payload_json')
})

// ---------------------------------------------------------------------------
// AC-18: the four read-only npm-recipe CLI verbs
// ---------------------------------------------------------------------------

test('phases/tail/procs refuse (exit 2) without an adw_id', { skip: SKIP }, () => {
  for (const verb of ['phases', 'tail', 'procs']) {
    const res = run([verb])
    assert.equal(res.status, 2, `${verb} did not refuse without an adw_id`)
  }
})

test('sessions/phases/tail/procs each emit parseable JSON on stdout against a seeded temp db', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  exerciseEveryWriter(ledger, 'cli-1')
  ledger.close()

  const env = { DEVTEAM_LEDGER_DB: dbPath }
  const sessionsRes = spawnSync(process.execPath, [SCRIPT, 'sessions'], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(sessionsRes.status, 0)
  assert.doesNotThrow(() => JSON.parse(sessionsRes.stdout))

  const phasesRes = spawnSync(process.execPath, [SCRIPT, 'phases', 'cli-1'], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(phasesRes.status, 0)
  assert.doesNotThrow(() => JSON.parse(phasesRes.stdout))

  const tailRes = spawnSync(process.execPath, [SCRIPT, 'tail', 'cli-1'], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(tailRes.status, 0)
  assert.doesNotThrow(() => JSON.parse(tailRes.stdout))

  const procsRes = spawnSync(process.execPath, [SCRIPT, 'procs', 'cli-1'], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(procsRes.status, 0)
  assert.doesNotThrow(() => JSON.parse(procsRes.stdout))
})

test('none of the four read verbs is present in WRITERS (they never reach a write path)', { skip: SKIP }, () => {
  for (const verb of ['sessions', 'phases', 'tail', 'procs']) {
    assert.ok(!WRITERS.includes(verb))
  }
})
