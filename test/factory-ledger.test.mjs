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
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync,
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
  openLedger, mkdirpBounded, replayJsonl, TABLES, MIGRATIONS, applyMigrations, NODE_FLOOR,
  SESSION_STATUSES, TERM_TO_KILL_MS, WRITERS, LedgerUsageError,
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

test('mkdirpBounded creates a deep path, and refuses promptly under a regular file rather than looping', () => {
  const dir = nextDir()
  mkdirpBounded(join(dir, 'a', 'b', 'c'), 0o700)
  assert.ok(existsSync(join(dir, 'a', 'b', 'c')))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  assert.throws(() => mkdirpBounded(blocker, 0o700), (err) => err.code === 'EEXIST')
  assert.equal(readFileSync(blocker, 'utf8'), 'not a directory')
  assert.throws(() => mkdirpBounded(join(blocker, 'nested'), 0o700), (err) => err.code === 'ENOTDIR')
})

test('factory directory creation does not regress to recursive mkdirSync', () => {
  for (const relative of ['scripts/factory/ledger.mjs', 'scripts/factory/emit.mjs']) {
    const source = readFileSync(join(ROOT, relative), 'utf8')
    const recursiveMkdirLine = source.split('\n').find((line) => (
      /mkdirSync\s*\(/.test(line) && /recursive\s*:\s*true/.test(line)
    ))
    assert.equal(recursiveMkdirLine, undefined, `${relative} contains recursive mkdirSync`)
  }
})

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
    checks: [{ item: 'a', ok: true, note: '' }], violations: [], gate_generation: 1, pristine: false,
  })
  ledger.recordGateDiscrimination({
    adw_id: adwId, phase_id: phaseId, gate_generation: 1, verdict: 'proven',
    checks_total: 1, checks_failed: 0, checks_errored: 0, note: 'proof',
  })
  ledger.recordReviewOutcome({
    adw_id: adwId, phase_id: phaseId, dispatch_id: 'review-1', role: 'reviewer',
    verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0,
  })
  ledger.recordAcceptDecision({
    adw_id: adwId, phase_id: phaseId, where: 'review-exhausted', outcome: 'accepted',
    findings_total: 2, residual_count: 1, refuted_count: 1, cosmetic_count: 1,
    unverified_count: 0, invalid_reasons: null,
  })
  ledger.recordCellFailure({
    adw_id: adwId, task_slug: 'task', phase_id: phaseId, dispatch_id: 'd-failure', role: 'builder',
    agent: 'claude', provider: 'anthropic', model_id: 'claude-sonnet', model: 'sonnet', effort: 'high',
    transport: 'pane', kind: 'seat-died', stage: 'seat-died', detail: 'pane gone',
    created_at: '2024-01-01T00:00:00.000Z',
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

test('new outcome writers refuse out-of-enum verdicts without echoing the offending value', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const badGate = 'gate-verdict-secret'
  const badReview = 'review-verdict-secret'
  const badAccept = 'accept-outcome-secret'
  const badCell = 'cell-kind-secret'
  assert.throws(
    () => ledger.recordGateDiscrimination({ adw_id: 'enum-1', gate_generation: 1, verdict: badGate }),
    (err) => err instanceof LedgerUsageError && !err.message.includes(badGate),
  )
  assert.throws(
    () => ledger.recordReviewOutcome({ adw_id: 'enum-1', dispatch_id: 'd1', verdict: badReview }),
    (err) => err instanceof LedgerUsageError && !err.message.includes(badReview),
  )
  assert.throws(
    () => ledger.recordAcceptDecision({ adw_id: 'enum-1', outcome: badAccept }),
    (err) => err instanceof LedgerUsageError && !err.message.includes(badAccept),
  )
  assert.throws(
    () => ledger.recordCellFailure({ role: 'builder', kind: badCell }),
    (err) => err instanceof LedgerUsageError && !err.message.includes(badCell),
  )
})

test('cell_failures stores run-less and in-run rows with the complete cell shape', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordCellFailure({
    task_slug: 'measure', role: 'reviewer', agent: 'pi', provider: 'pi', model_id: 'terra',
    model: 'gpt', effort: 'max', transport: 'headless-rpc', kind: 'boot-refusal',
    stage: 'capability-refused', detail: 'before run', created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordCellFailure({
    adw_id: 'run-cell', task_slug: 'measure', phase_id: 4, dispatch_id: 'd1', role: 'reviewer',
    agent: 'pi', provider: 'pi', model_id: 'terra', model: 'gpt', effort: 'max', transport: 'headless-rpc',
    kind: 'seat-died', stage: 'seat-died', detail: 'mid-run', created_at: '2024-01-01T00:00:01.000Z',
  })
  const rows = ledger.dumpTable('cell_failures')
  assert.equal(rows.length, 2)
  const runless = rows.find((row) => row.kind === 'boot-refusal')
  assert.equal(runless.adw_id, null)
  assert.deepEqual({ role: runless.role, provider: runless.provider, model_id: runless.model_id, transport: runless.transport }, {
    role: 'reviewer', provider: 'pi', model_id: 'terra', transport: 'headless-rpc',
  })
  const inRun = rows.find((row) => row.kind === 'seat-died')
  assert.deepEqual({ adw_id: inRun.adw_id, phase_id: inRun.phase_id, dispatch_id: inRun.dispatch_id, detail: inRun.detail }, {
    adw_id: 'run-cell', phase_id: 4, dispatch_id: 'd1', detail: 'mid-run',
  })
})

test('cellFailures aggregates by cell and kind, counts run-less rows, and honors bounds', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const common = { task_slug: 'measure', role: 'builder', agent: 'claude', provider: 'anthropic', model_id: 'sonnet', effort: 'high' }
  ledger.recordCellFailure({ ...common, kind: 'boot-refusal', created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordCellFailure({ ...common, kind: 'boot-refusal', created_at: '2024-01-02T00:00:00.000Z' })
  ledger.recordCellFailure({ ...common, adw_id: 'run-1', kind: 'boot-refusal', created_at: '2024-01-03T00:00:00.000Z' })
  ledger.recordCellFailure({ ...common, adw_id: 'run-1', kind: 'timeout', created_at: '2024-01-04T00:00:00.000Z' })

  const all = ledger.cellFailures()
  const boots = all.find((row) => row.kind === 'boot-refusal')
  assert.equal(boots.failures, 3)
  assert.equal(boots.run_less, 2)
  assert.equal(boots.first_at, '2024-01-01T00:00:00.000Z')
  assert.equal(boots.last_at, '2024-01-03T00:00:00.000Z')

  const bounded = ledger.cellFailures({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-04T00:00:00.000Z' })
  assert.deepEqual(bounded.map(({ kind, failures, run_less }) => ({ kind, failures, run_less })), [
    { kind: 'boot-refusal', failures: 2, run_less: 1 },
  ])
})

test('cell-failures CLI prints rows and refuses an inverted optional window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordCellFailure({
    task_slug: 'cli-failures', role: 'builder', provider: 'anthropic', model_id: 'sonnet', agent: 'claude', effort: 'high',
    kind: 'boot-refusal', created_at: '2024-01-01T00:00:00.000Z',
  })
  const dbPath = ledger._dbPath
  ledger.close()

  const ok = run(['cell-failures'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(ok.status, 0, ok.stderr)
  const payload = JSON.parse(ok.stdout.trim())
  assert.deepEqual({ schema: payload.schema, since: payload.since, until: payload.until }, { schema: 1, since: null, until: null })
  assert.equal(payload.rows[0].kind, 'boot-refusal')
  assert.equal(payload.rows[0].run_less, 1)

  const inverted = run([
    'cell-failures', '--since', '2024-01-02T00:00:00Z', '--until', '2024-01-01T00:00:00Z',
  ], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(inverted.status, 2)
  assert.match(inverted.stderr, /cell-failures: --until must be later than --since/)
})

test('gateReviewGap counts only non-pristine green gate rows and must-fix reviews', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'gap-good', repo_slug: 'r', task_slug: 'good' })
  ledger.recordGateResult({ adw_id: 'gap-good', phase_id: null, gate_name: 'g', attempt: 1, ok: true, gate_generation: 1, pristine: false })
  ledger.recordReviewOutcome({ adw_id: 'gap-good', dispatch_id: 'review-1', verdict: 'changes-needed', must_fix: 2 })

  ledger.startSession({ adw_id: 'gap-pristine', repo_slug: 'r', task_slug: 'pristine' })
  ledger.recordGateResult({ adw_id: 'gap-pristine', phase_id: null, gate_name: 'g', attempt: 1, ok: true, gate_generation: 1, pristine: true })
  ledger.recordReviewOutcome({ adw_id: 'gap-pristine', dispatch_id: 'review-1', verdict: 'pass', must_fix: 0 })

  const rows = ledger.gateReviewGap()
  const good = rows.find((row) => row.adw_id === 'gap-good')
  const pristine = rows.find((row) => row.adw_id === 'gap-pristine')
  assert.deepEqual({ ...good }, { adw_id: 'gap-good', task_slug: 'good', green_gate_runs: 1, reviews: 1, max_must_fix: 2 })
  assert.deepEqual({ ...pristine }, { adw_id: 'gap-pristine', task_slug: 'pristine', green_gate_runs: 0, reviews: 1, max_must_fix: 0 })
})

test('eligibleTasks matches proof rows to the active gate generation', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'eligible-1', repo_slug: 'r', task_slug: 'eligible' })
  ledger.recordGateResult({ adw_id: 'eligible-1', phase_id: null, gate_name: 'g', attempt: 1, ok: true, gate_generation: 1, pristine: false })
  ledger.recordGateDiscrimination({ adw_id: 'eligible-1', gate_generation: 1, verdict: 'proven' })
  ledger.recordReviewOutcome({ adw_id: 'eligible-1', dispatch_id: 'review-1', verdict: 'pass', must_fix: 0 })
  ledger.recordGateResult({ adw_id: 'eligible-1', phase_id: null, gate_name: 'g', attempt: 2, ok: true, gate_generation: 2, pristine: false })

  let row = ledger.eligibleTasks().find((candidate) => candidate.adw_id === 'eligible-1')
  assert.deepEqual({ ...row }, { adw_id: 'eligible-1', task_slug: 'eligible', active_generation: 2, reviews: 1, proven_active: 0 })

  ledger.recordGateDiscrimination({ adw_id: 'eligible-1', gate_generation: 2, verdict: 'proven' })
  row = ledger.eligibleTasks().find((candidate) => candidate.adw_id === 'eligible-1')
  assert.deepEqual({ ...row }, { adw_id: 'eligible-1', task_slug: 'eligible', active_generation: 2, reviews: 1, proven_active: 1 })
})

// ---------------------------------------------------------------------------
// #59: one-run task readout
// ---------------------------------------------------------------------------

function seedTaskAgentSession(ledger, adwId, suffix, totals) {
  const claudeSessionId = `claude-${suffix}`
  ledger.startAgentSession({
    adw_id: adwId, dispatch_id: `dispatch-${suffix}`, role: 'builder', model: 'sonnet',
    claude_session_id: claudeSessionId, transcript_path: `/tmp/${claudeSessionId}.jsonl`,
  })
  ledger.endAgentSession({
    adw_id: adwId, claude_session_id: claudeSessionId,
    context_tokens: 100, context_window: 200000, raw_read_tokens: 80, raw_written_tokens: 40,
    billed_input_tokens: totals[0], billed_output_tokens: totals[1],
    billed_cache_write_tokens: totals[2], billed_cache_read_tokens: totals[3],
  })
}

test('taskReadout sums billed_* across a run\'s agent_sessions rows', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-usage', repo_slug: 'r', task_slug: 'usage' })
  seedTaskAgentSession(ledger, 'task-usage', 'one', [100, 10, 5, 7])
  seedTaskAgentSession(ledger, 'task-usage', 'two', [30, 4, 1, 3])

  const usage = ledger.taskReadout('task-usage').usage
  assert.deepEqual(usage, {
    agent_sessions: 2,
    billed_input_tokens: 130,
    billed_output_tokens: 14,
    billed_cache_write_tokens: 6,
    billed_cache_read_tokens: 10,
  })
  assert.notEqual(usage.billed_input_tokens, 100, 'usage must not be the maximum running total')
  assert.notEqual(usage.billed_input_tokens, 30, 'usage must not be the last running total')
})

test('taskReadout reports gate verdicts per generation with their discrimination', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-gates', repo_slug: 'r', task_slug: 'gates' })
  ledger.recordGateResult({ adw_id: 'task-gates', phase_id: null, gate_name: 'g', attempt: 1, ok: false, gate_generation: 1, pristine: false })
  ledger.recordGateResult({ adw_id: 'task-gates', phase_id: null, gate_name: 'g', attempt: 2, ok: true, gate_generation: 1, pristine: false })
  ledger.recordGateDiscrimination({ adw_id: 'task-gates', gate_generation: 1, verdict: 'proven', checks_total: 9, checks_failed: 3, checks_errored: 0 })
  ledger.recordGateResult({ adw_id: 'task-gates', phase_id: null, gate_name: 'g', attempt: 3, ok: true, gate_generation: 2, pristine: false })
  ledger.recordGateDiscrimination({ adw_id: 'task-gates', gate_generation: 2, verdict: 'unproven', checks_total: 9, checks_failed: 0, checks_errored: 0 })

  const generations = ledger.taskReadout('task-gates').gate_generations
  assert.equal(generations.length, 2)
  assert.deepEqual(generations.map(({ gate_generation, attempts, green }) => ({ gate_generation, attempts, green })), [
    { gate_generation: 1, attempts: 2, green: 1 },
    { gate_generation: 2, attempts: 1, green: 1 },
  ])
  assert.equal(generations[0].discrimination.verdict, 'proven')
  assert.equal(generations[1].discrimination.verdict, 'unproven')
})

test('taskReadout carries review outcomes with their must_fix counts', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-reviews', repo_slug: 'r', task_slug: 'reviews' })
  ledger.recordReviewOutcome({ adw_id: 'task-reviews', dispatch_id: 'review-1', role: 'reviewer', verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 3 })
  ledger.recordReviewOutcome({ adw_id: 'task-reviews', dispatch_id: 'review-2', role: 'qa', verdict: 'pass', must_fix: 0, should_fix: 0, consider: 1 })

  const rows = ledger.taskReadout('task-reviews').review_outcomes
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(({ dispatch_id, role, verdict, must_fix, should_fix, consider }) => ({ dispatch_id, role, verdict, must_fix, should_fix, consider })), [
    { dispatch_id: 'review-1', role: 'reviewer', verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 3 },
    { dispatch_id: 'review-2', role: 'qa', verdict: 'pass', must_fix: 0, should_fix: 0, consider: 1 },
  ])
})

test('taskReadout carries typed accept decisions and bounds invalid reasons', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-accepts', repo_slug: 'r', task_slug: 'accepts' })
  ledger.recordAcceptDecision({
    adw_id: 'task-accepts', phase_id: 3, where: 'review-exhausted', outcome: 'escalated',
    findings_total: 2, residual_count: 1, refuted_count: 1, cosmetic_count: 0,
    unverified_count: 1, invalid_reasons: 'x'.repeat(700), created_at: '2024-01-01T00:00:00.000Z',
  })
  const rows = ledger.taskReadout('task-accepts').accept_decisions
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0] }, {
    where_at: 'review-exhausted', outcome: 'escalated', findings_total: 2,
    residual_count: 1, refuted_count: 1, cosmetic_count: 0, unverified_count: 1,
    invalid_reasons: 'x'.repeat(500), created_at: '2024-01-01T00:00:00.000Z',
  })
})

test('a run with no usage, discrimination or findings reads as absent, not zero', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-bare', repo_slug: 'r', task_slug: 'bare' })
  ledger.endSession({ adw_id: 'task-bare', status: 'ok' })

  const readout = ledger.taskReadout('task-bare')
  assert.equal(readout.usage, null)
  assert.deepEqual(readout.gate_generations, [])
  assert.deepEqual(readout.review_outcomes, [])
  assert.deepEqual(readout.accept_decisions, [])
  assert.deepEqual(readout.absent, {
    usage: 'predates per-agent token measurement (#119) — not a measured zero',
    gate_discrimination: 'predates gate discrimination (#168)',
    review_outcomes: 'predates structured review outcomes (#169/#170)',
    accept_decisions: 'predates typed accept decisions (#170)',
    gate_results: 'predates gate verdict recording (#130)',
    phases: 'no phase rows recorded for this run',
  })
})

test('taskReadout resolves an unambiguous task_slug and refuses an ambiguous one', { skip: SKIP }, () => {
  const one = openTestLedger()
  one.startSession({ adw_id: 'slug-one', repo_slug: 'r', task_slug: 'remembered-slug' })
  const resolved = one.taskReadout('remembered-slug')
  assert.equal(resolved.adw_id, 'slug-one')
  assert.equal(resolved.resolved_by, 'task_slug')

  const many = openTestLedger()
  many.startSession({ adw_id: 'slug-dupe-a', repo_slug: 'r', task_slug: 'ambiguous-slug' })
  many.startSession({ adw_id: 'slug-dupe-b', repo_slug: 'r', task_slug: 'ambiguous-slug' })
  const ambiguous = many.taskReadout('ambiguous-slug')
  assert.equal(ambiguous.adw_id, null)
  assert.deepEqual(ambiguous.candidates, ['slug-dupe-a', 'slug-dupe-b'])
})

test('the task verb refuses an unknown adw_id through the usage path', { skip: SKIP }, () => {
  const res = run(['task', 'nope'])
  assert.equal(res.status, 2)
  assert.equal(res.stdout, '')
  assert.doesNotMatch(res.stderr, /unknown verb/)
})

test('the task verb refuses an ambiguous slug and names every candidate', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'cli-dupe-a', repo_slug: 'r', task_slug: 'cli-ambiguous' })
  ledger.startSession({ adw_id: 'cli-dupe-b', repo_slug: 'r', task_slug: 'cli-ambiguous' })
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['task', 'cli-ambiguous'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /cli-dupe-a/)
  assert.match(res.stderr, /cli-dupe-b/)
})

test('a degraded ledger answers task without throwing', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'corrupt.db')
  writeFileSync(dbPath, 'not a sqlite database\\n')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  let readout
  assert.doesNotThrow(() => { readout = ledger.taskReadout('degraded-run') })
  assert.equal(readout.degraded, true)
  assert.equal(readout.adw_id, null)

  const res = run(['task', 'degraded-run'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 2)
  assert.notEqual(res.status, 1)
})

test('taskReadout prints a schema-1 payload stating its question and definition', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'cli-readout', repo_slug: 'r', task_slug: 'readout' })
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['task', 'cli-readout'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.schema, 1)
  assert.match(payload.question, /what ran/i)
  assert.equal(typeof payload.definition, 'object')
  for (const key of ['adw_id', 'resolved_by', 'session', 'phases', 'gate_generations', 'review_outcomes', 'accept_decisions', 'usage', 'absent']) {
    assert.ok(key in payload, `payload is missing ${key}`)
  }
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
  ledger.recordAcceptDecision({
    adw_id: ctx, phase_id: phaseId, where: MARKER_ADW, outcome: 'escalated',
    findings_total: 1, residual_count: 0, refuted_count: 0, cosmetic_count: 0,
    unverified_count: 0, invalid_reasons: MARKER_ADW,
  })
  ledger.recordCellFailure({
    adw_id: ctx, task_slug: 't', role: 'builder', provider: 'anthropic', model_id: 'sonnet',
    kind: 'transport-error', detail: MARKER_ADW, created_at: '2024-01-01T00:00:00.000Z',
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

// ---------------------------------------------------------------------------
// #193: one-run-set readout
// ---------------------------------------------------------------------------

const RUNSET_SINCE = '2026-08-15T00:00:00.000Z'
const RUNSET_UNTIL = '2026-08-15T01:00:00.000Z'

function seedRun(ledger, adwId, startedAt, status = 'running') {
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: adwId, started_at: startedAt })
  if (status !== 'running') ledger.endSession({ adw_id: adwId, status })
}

test('runSet returns only the runs whose started_at falls in the window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'before', '2026-08-14T23:00:00.000Z')
  seedRun(ledger, 'at-since', RUNSET_SINCE)
  seedRun(ledger, 'at-until', RUNSET_UNTIL)
  seedRun(ledger, 'after', '2026-08-15T02:00:00.000Z')

  const openEnded = ledger.runSet({ since: RUNSET_SINCE })
  assert.deepEqual(openEnded.map((row) => row.adw_id), ['at-since', 'at-until', 'after'])

  const halfOpen = ledger.runSet({ since: RUNSET_SINCE, until: RUNSET_UNTIL })
  assert.deepEqual(halfOpen.map((row) => row.adw_id), ['at-since'])
  assert.ok(halfOpen.some((row) => row.adw_id === 'at-since'), 'the run exactly at since must be included')
  assert.ok(!halfOpen.some((row) => row.adw_id === 'at-until'), 'the run exactly at until must be excluded')
})

test('runSet sums billed_* across each run\'s agent_sessions rows', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'runset-usage', RUNSET_SINCE)
  seedTaskAgentSession(ledger, 'runset-usage', 'runset-one', [100, 10, 5, 7])
  seedTaskAgentSession(ledger, 'runset-usage', 'runset-two', [30, 4, 1, 3])

  const row = ledger.runSet({ since: RUNSET_SINCE })[0]
  assert.deepEqual({
    agent_sessions: row.agent_sessions,
    billed_input_tokens: row.billed_input_tokens,
    billed_output_tokens: row.billed_output_tokens,
    billed_cache_write_tokens: row.billed_cache_write_tokens,
    billed_cache_read_tokens: row.billed_cache_read_tokens,
  }, {
    agent_sessions: 2,
    billed_input_tokens: 130,
    billed_output_tokens: 14,
    billed_cache_write_tokens: 6,
    billed_cache_read_tokens: 10,
  })
  assert.notEqual(row.billed_input_tokens, 100, 'usage must not be the maximum running total')
  assert.notEqual(row.billed_input_tokens, 30, 'usage must not be the last running total')
})

test('run-set keeps unmeasured billing null and marks usage absent', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'runset-live', RUNSET_SINCE)
  ledger.startAgentSession({
    adw_id: 'runset-live', dispatch_id: 'open-dispatch', role: 'builder', model: 'sonnet',
    claude_session_id: 'open-claude', transcript_path: '/tmp/open-claude.jsonl',
  })
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0)
  const payload = JSON.parse(res.stdout)
  const billedKeys = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
  assert.equal(payload.rows[0].agent_sessions, 1)
  for (const key of billedKeys) {
    assert.equal(payload.rows[0][key], null)
    assert.equal(payload.usage[key], null)
  }
  assert.equal(payload.usage.agent_sessions, 1)
  assert.match(payload.absent.usage, /not a measured zero/)
})

test('run-set reconciles to the task readout for every run it covers', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const runs = [
    ['reconcile-a', '2026-08-15T00:10:00.000Z', [[100, 10, 5, 7], [30, 4, 1, 3]]],
    ['reconcile-b', '2026-08-15T00:20:00.000Z', [[200, 20, 6, 8]]],
    ['reconcile-c', '2026-08-15T00:30:00.000Z', [[50, 5, 2, 4], [25, 3, 1, 2]]],
  ]
  for (const [adwId, startedAt, sessions] of runs) {
    seedRun(ledger, adwId, startedAt)
    sessions.forEach((totals, index) => seedTaskAgentSession(ledger, adwId, `reconcile-${adwId}-${index}`, totals))
  }
  const dbPath = ledger._dbPath
  ledger.close()

  const runSetRes = run(['run-set', '--since', RUNSET_SINCE], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(runSetRes.status, 0)
  const payload = JSON.parse(runSetRes.stdout)
  const billedKeys = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
  const expectedUsage = { agent_sessions: 0 }
  for (const key of billedKeys) expectedUsage[key] = 0

  for (const row of payload.rows) {
    const taskRes = run(['task', row.adw_id], { DEVTEAM_LEDGER_DB: dbPath })
    assert.equal(taskRes.status, 0)
    const task = JSON.parse(taskRes.stdout)
    assert.ok(task.usage)
    assert.equal(row.agent_sessions, task.usage.agent_sessions)
    expectedUsage.agent_sessions += row.agent_sessions
    for (const key of billedKeys) {
      assert.equal(row[key], task.usage[key], `${row.adw_id} ${key} drifted from task readout`)
      expectedUsage[key] += row[key]
    }
  }
  assert.deepEqual(payload.usage, expectedUsage)
})

test('run-set prints a schema-1 payload stating its question, definition and window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'runset-schema', RUNSET_SINCE)
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', '2026-08-15T00:00:00Z', '--until', '2026-08-15T01:00:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.schema, 1)
  assert.equal(payload.since, RUNSET_SINCE)
  assert.equal(payload.until, RUNSET_UNTIL)
  assert.match(payload.question, /what ran/i)
  assert.equal(typeof payload.definition, 'object')
  for (const key of ['question', 'definition', 'since', 'until', 'runs', 'settled', 'usage', 'rows', 'absent']) {
    assert.ok(key in payload, `payload is missing ${key}`)
  }
})

test('run-set tallies the sessions status enum', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  SESSION_STATUSES.forEach((status, index) => {
    seedRun(ledger, `status-${status}`, `2026-08-15T00:0${index}:00.000Z`, status)
  })
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE, '--until', RUNSET_UNTIL], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.runs, 4)
  assert.deepEqual(payload.settled, { running: 1, ok: 1, fail: 1, aborted: 1 })
})

test('run-set marks parks absent rather than reporting zero', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'runset-park', RUNSET_SINCE)
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0)
  const payload = JSON.parse(res.stdout)
  assert.equal(typeof payload.absent.parked, 'string')
  assert.match(payload.absent.parked, /reclaim store/)
  const keys = []
  const collectKeys = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(collectKeys)
    for (const [key, child] of Object.entries(value)) {
      keys.push(key)
      collectKeys(child)
    }
  }
  collectKeys(payload)
  assert.ok(!keys.some((key) => /park.*(?:count|state)/i.test(key)), 'payload must not claim a park count or state')
})

test('run-set reports an empty window as a measured zero', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.runs, 0)
  assert.equal(payload.usage, null)
  assert.ok(!('runs' in payload.absent))
})

test('run-set refuses a missing, malformed or inverted window', { skip: SKIP }, () => {
  const cases = [
    { args: ['run-set'], pattern: /--since.*required/ },
    { args: ['run-set', '--since', 'notatimestamp'], pattern: /must be an ISO-8601 timestamp/ },
    { args: ['run-set', '--since', '2026-08-15T00:00:00Z', '--until', '2026-08-15T00:00:00Z'], pattern: /--until must be later/ },
    { args: ['run-set', '--since', '2026-08-15T00:00:00Z', '--until', '2026-08-14T00:00:00Z'], pattern: /--until must be later/ },
    { args: ['run-set', '--since', '2026-08-15T00:00:00Z', '--until'], pattern: /--until.*ISO-8601 timestamp/ },
    { args: ['run-set', 'unexpected', '--since', '2026-08-15T00:00:00Z'], pattern: /takes no positional/ },
  ]
  for (const { args, pattern } of cases) {
    const res = run(args)
    assert.equal(res.status, 2, `${args.join(' ')} did not refuse`)
    assert.match(res.stderr, pattern)
  }
})

test('run-set refuses a degraded mirror rather than printing an empty window', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'corrupt.db')
  writeFileSync(dbPath, 'not a sqlite database\n')

  const res = run(['run-set', '--since', RUNSET_SINCE], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /unanswerable/)
})
