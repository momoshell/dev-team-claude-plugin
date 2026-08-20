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
  readdirSync, statSync,
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
  openLedger, mkdirpBounded, replayJsonl, isoMs, TABLES, MIGRATIONS, applyMigrations, NODE_FLOOR,
  SESSION_STATUSES, TERM_TO_KILL_MS, WRITERS, LedgerUsageError,
  MODIFIER_KINDS, MODIFIER_ATTEMPT_OUTCOMES, INTAKE_DISPATCH_OUTCOMES,
  SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS,
  RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage,
  REQUEST_MAX_CHARS, ADVISOR_AB_INCOMPLETE_REASONS,
} from '../scripts/factory/ledger.mjs'
import { MODIFIER_OUTCOMES, VARIANT_NAMES } from '../crew/drive.mjs'
// openRun is the only production writer of sessions.tier and the compiler
// proposal columns: it reads the boot record/brief and forwards them. The
// forwarding is pinned here, next to the columns it writes, because
// test/factory-emit.test.mjs is not this lane's to edit.
import {
  _resetNoticeGuardsForTest, openRun, parseProposalBrief,
} from '../scripts/factory/emit.mjs'

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

// Boots a run the way crew/crew.mjs and crew/child.mjs do — stateDir is the
// crew dir, which is where crew.json lives — and returns its mirrored sessions
// row. `tier: null` writes a boot record with NO tier key at all, which is
// exactly what a --roles boot produces.
function bootTieredRun(tier) {
  const stateDir = mkdtempSync(join(tmpdir(), 'factory-ledger-boot-'))
  writeFileSync(join(stateDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'boot-tier', roles: ['lead', 'planner'], ...(tier === null ? {} : { tier }),
  }))
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  const emitter = openRun({ stateDir, repoSlug: 'r', taskSlug: 'boot-tier', dbPath })
  try {
    emitter.startRun()
    const ledger = openLedger({ dbPath })
    try {
      return ledger.getSession(emitter.adwId)
    } finally { ledger.close() }
  } finally {
    emitter.dispose()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

function bootBriefRun(brief, label = 'proposal', { includeBriefPath = true } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), `factory-ledger-${label}-`))
  writeFileSync(join(stateDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: label, roles: ['lead', 'planner'],
  }))
  const briefPath = join(stateDir, 'brief.md')
  if (brief !== null) writeFileSync(briefPath, brief)
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  const stderrLines = []
  const emitter = openRun({
    stateDir, repoSlug: 'r', taskSlug: label, dbPath,
    ...(includeBriefPath ? { briefPath } : {}),
    stderr: { write: (chunk) => stderrLines.push(chunk) },
  })
  try {
    emitter.startRun()
    const ledger = openLedger({ dbPath })
    try {
      return { row: ledger.getSession(emitter.adwId), stderr: stderrLines.join('') }
    } finally { ledger.close() }
  } finally {
    emitter.dispose()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

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
  for (const relative of ['scripts/factory/ledger.mjs', 'scripts/factory/emit.mjs', 'scripts/factory/make-brief.mjs']) {
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
  ledger.linkRun({ run_id: 'daemon-run-1', adw_id: adwId, crew_dir: '/tmp/crew' })
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
  ledger.recordCiCycle({
    adw_id: adwId, task_slug: 'task', repo_slug: 'repo', branch: 'main', head_sha: 'abc123',
    check_name: 'test (node 24)', cycle: 1, conclusion: 'failure', classification: 'reproduced',
    decision: 'repair', reason: 'local-lane-reproduced', excerpt: 'not ok 1 - failure',
    excerpt_source: 'check-log', local_lane: 'node --test', local_exit: 1,
    created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordCiDispatch({
    adw_id: adwId, task_slug: 'task', repo_slug: 'repo', branch: 'main', head_sha: 'abc123',
    check_name: 'test (node 24)', cycle: 1, variant: 'repair', outcome: 'done',
    commit: 'repair-commit', brief_path: '/tmp/repair.md', scope_source: 'files_committed',
    scope_count: 1, task_return: '/tmp/task.json', exit_code: 0,
    created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordIntakeSweep({
    board_owner: 'owner', board_project: 7, outcome: 'picked', reason: null,
    considered: 2, pages: 1, picked_issue: 42, rate_limit_remaining: 900,
    rate_limit_reset_at: '2024-01-01T01:00:00.000Z', created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordIntakeRefusal({
    board_owner: 'owner', board_project: 7, issue: 43, reason: 'not-first-in-order',
    detail: 'concurrency=1', priority: 'P1', issue_created_at: '2023-12-31T00:00:00.000Z',
    created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordSeatTeardown({
    adw_id: adwId, phase_id: phaseId, role: 'builder', transport: 'headless-rpc',
    session_id: 'session-1', pgid: 4242, reservation_id: 'reservation-1', outcome: 'proven',
    reason: 'exit-marker', forced: true, evidence_kind: 'pgid',
    created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordModifierAttempt({
    adw_id: adwId, task_slug: 'task', phase_id: phaseId, role: 'builder', modifier: 'failure-upgrade',
    bounce: 'lane', outcome: 'applied', rung: 'mechanical→build', transport: 'pane',
    from_provider: 'anthropic', from_model_id: 'claude-sonnet', from_model: 'sonnet', from_agent: 'claude', from_effort: 'high',
    to_provider: 'anthropic', to_model_id: 'claude-opus', to_model: 'opus', to_agent: 'claude', to_effort: 'max',
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

test('intake writers refuse out-of-enum values without echoing the offending value', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const badOutcome = 'intake-outcome-secret'
  const badReason = 'intake-reason-secret'
  assert.throws(
    () => ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 7, outcome: badOutcome, considered: 0, pages: 0 }),
    (err) => err instanceof LedgerUsageError && !err.message.includes(badOutcome),
  )
  assert.throws(
    () => ledger.recordIntakeRefusal({ board_owner: 'owner', board_project: 7, issue: 1, reason: badReason }),
    (err) => err instanceof LedgerUsageError && !err.message.includes(badReason),
  )
})

test('ci_dispatches refuses missing required fields and out-of-enum outcomes', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  assert.throws(
    () => ledger.recordCiDispatch({ branch: 'main', head_sha: 'h', check_name: 'c', cycle: 1, variant: 'repair' }),
    (err) => err instanceof LedgerUsageError && err.message.includes("missing required field 'outcome'"),
  )
  assert.throws(
    () => ledger.recordCiDispatch({ branch: 'main', head_sha: 'h', check_name: 'c', cycle: 1, variant: 'full', outcome: 'not-real' }),
    (err) => err instanceof LedgerUsageError && !err.message.includes('not-real'),
  )
  assert.throws(
    () => ledger.recordCiDispatch({ branch: 'main', head_sha: 'h', check_name: 'c', cycle: 1, variant: 'repair', outcome: 'refused' }),
    (err) => err instanceof LedgerUsageError && err.message.includes("outcome 'refused' requires a reason"),
  )
})

test('ciDispatches aggregates the dispatch outcome window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const base = { branch: 'main', head_sha: 'h', check_name: 'c', cycle: 1, variant: 'repair', outcome: 'done', created_at: '2024-01-01T00:00:00.000Z' }
  ledger.recordCiDispatch(base)
  ledger.recordCiDispatch({ ...base, branch: 'other', cycle: 2, created_at: '2024-01-01T00:00:01.000Z' })
  assert.deepEqual(ledger.ciDispatches({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-01T00:00:02.000Z' }).map((row) => ({ ...row })), [
    { variant: 'repair', outcome: 'done', cycle: 1, count: 1, first_at: '2024-01-01T00:00:00.000Z', last_at: '2024-01-01T00:00:00.000Z' },
    { variant: 'repair', outcome: 'done', cycle: 2, count: 1, first_at: '2024-01-01T00:00:01.000Z', last_at: '2024-01-01T00:00:01.000Z' },
  ])
})

test('ci_cycles refuses collapsed decisions and ignores a repeated identical cycle', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const base = {
    branch: 'main', head_sha: 'ci-head', check_name: 'test (node 24)', cycle: 1,
    conclusion: 'failure', reason: 'local-failures-disjoint', excerpt: null,
  }
  assert.throws(
    () => ledger.recordCiCycle({ ...base, classification: 'platform-divergent', decision: 'repair' }),
    (err) => err instanceof LedgerUsageError && err.message.includes("decision 'repair' requires classification 'reproduced'"),
  )
  assert.throws(
    () => ledger.recordCiCycle({ ...base, classification: 'unknown', decision: 'park', reason: null }),
    (err) => err instanceof LedgerUsageError && err.message.includes("classification 'unknown' requires a reason"),
  )
  const row = { ...base, classification: 'reproduced', decision: 'repair', reason: 'local-lane-reproduced' }
  ledger.recordCiCycle(row)
  ledger.recordCiCycle(row)
  assert.equal(ledger.dumpTable('ci_cycles').length, 1)
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

test('modifier attempt writer stores applied and refused rows with the complete cell shapes', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordModifierAttempt({
    adw_id: 'modifier-rows', task_slug: 'measure', phase_id: 2, role: 'builder', modifier: 'failure-upgrade',
    bounce: 'lane', outcome: 'applied', rung: 'mechanical→build', transport: 'pane',
    from_provider: 'anthropic', from_model_id: 'old-id', from_model: 'old-model', from_agent: 'claude', from_effort: 'high',
    to_provider: 'anthropic', to_model_id: 'new-id', to_model: 'new-model', to_agent: 'claude', to_effort: 'max',
    created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordModifierAttempt({
    adw_id: 'modifier-rows', task_slug: 'measure', phase_id: 2, role: 'builder', modifier: 'failure-upgrade',
    bounce: 'gate', outcome: 'exhausted', why: 'top rung', transport: 'pane',
    from_provider: 'anthropic', from_model_id: 'new-id', from_model: 'new-model', from_agent: 'claude', from_effort: 'max',
    created_at: '2024-01-01T00:00:01.000Z',
  })
  const rows = ledger.dumpTable('modifier_attempts')
  assert.equal(rows.length, 2)
  const applied = rows.find((row) => row.outcome === 'applied')
  assert.deepEqual({
    role: applied.role, modifier: applied.modifier, bounce: applied.bounce, rung: applied.rung,
    from_provider: applied.from_provider, from_model_id: applied.from_model_id, from_model: applied.from_model,
    from_agent: applied.from_agent, from_effort: applied.from_effort,
    to_provider: applied.to_provider, to_model_id: applied.to_model_id, to_model: applied.to_model,
    to_agent: applied.to_agent, to_effort: applied.to_effort,
  }, {
    role: 'builder', modifier: 'failure-upgrade', bounce: 'lane', rung: 'mechanical→build',
    from_provider: 'anthropic', from_model_id: 'old-id', from_model: 'old-model', from_agent: 'claude', from_effort: 'high',
    to_provider: 'anthropic', to_model_id: 'new-id', to_model: 'new-model', to_agent: 'claude', to_effort: 'max',
  })
  const refused = rows.find((row) => row.outcome === 'exhausted')
  assert.equal(refused.why, 'top rung')
  for (const key of ['to_provider', 'to_model_id', 'to_model', 'to_agent', 'to_effort']) assert.equal(refused[key], null)
})

test('modifier attempt writer refuses unknown enums and missing required fields without writing rows', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const base = { role: 'builder', modifier: 'failure-upgrade', outcome: 'transport' }
  for (const input of [
    { ...base, modifier: 'typo-modifier' },
    { ...base, outcome: 'typo-outcome' },
    { modifier: base.modifier, outcome: base.outcome },
    { role: base.role, outcome: base.outcome },
    { role: base.role, modifier: base.modifier },
  ]) {
    assert.throws(() => ledger.recordModifierAttempt(input), LedgerUsageError)
  }
  assert.deepEqual(ledger.dumpTable('modifier_attempts'), [])
})

test('modifierAttempts aggregates by outcome, role, transport, from cell, and honors bounds', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const common = {
    adw_id: 'modifier-aggregate', task_slug: 'measure', role: 'builder', modifier: 'failure-upgrade',
    transport: 'headless-rpc', from_provider: 'openai', from_model_id: 'luna', from_agent: 'pi', from_effort: 'max',
  }
  ledger.recordModifierAttempt({ ...common, bounce: 'lane', outcome: 'transport', created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordModifierAttempt({ ...common, bounce: 'gate', outcome: 'transport', created_at: '2024-01-02T00:00:00.000Z' })
  ledger.recordModifierAttempt({ ...common, bounce: 'review', outcome: 'applied', created_at: '2024-01-03T00:00:00.000Z', to_model_id: 'terra' })
  const rows = ledger.modifierAttempts()
  assert.deepEqual(rows.map(({ modifier, outcome, role, transport, from_provider, from_model_id, from_agent, from_effort, attempts, applied }) => ({ modifier, outcome, role, transport, from_provider, from_model_id, from_agent, from_effort, attempts, applied })), [
    { modifier: 'failure-upgrade', outcome: 'applied', role: 'builder', transport: 'headless-rpc', from_provider: 'openai', from_model_id: 'luna', from_agent: 'pi', from_effort: 'max', attempts: 1, applied: 1 },
    { modifier: 'failure-upgrade', outcome: 'transport', role: 'builder', transport: 'headless-rpc', from_provider: 'openai', from_model_id: 'luna', from_agent: 'pi', from_effort: 'max', attempts: 2, applied: 0 },
  ])
  const bounded = ledger.modifierAttempts({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' })
  assert.deepEqual(bounded.map(({ outcome, attempts, applied }) => ({ outcome, attempts, applied })), [
    { outcome: 'transport', attempts: 1, applied: 0 },
  ])
  assert.deepEqual(openTestLedger().modifierAttempts(), [])
})

test('modifier-attempts CLI prints the schema-1 readout and refuses bad arguments', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordModifierAttempt({
    adw_id: 'modifier-cli', role: 'builder', modifier: 'failure-upgrade', bounce: 'lane', outcome: 'transport',
    created_at: '2024-01-01T00:00:00.000Z',
  })
  const dbPath = ledger._dbPath
  ledger.close()
  const ok = run(['modifier-attempts'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(ok.status, 0, ok.stderr)
  const payload = JSON.parse(ok.stdout.trim())
  assert.deepEqual({ schema: payload.schema, since: payload.since, until: payload.until }, { schema: 1, since: null, until: null })
  assert.deepEqual(payload.modifiers, [...MODIFIER_KINDS])
  assert.deepEqual(payload.outcomes, [...MODIFIER_ATTEMPT_OUTCOMES])
  assert.equal(payload.rows[0].attempts, 1)
  const positional = run(['modifier-attempts', 'oops'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(positional.status, 2)
  assert.match(positional.stderr, /modifier-attempts: takes no positional arguments/)
  const inverted = run([
    'modifier-attempts', '--since', '2024-01-02T00:00:00Z', '--until', '2024-01-01T00:00:00Z',
  ], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(inverted.status, 2)
  assert.match(inverted.stderr, /modifier-attempts: --until must be later than --since/)
})

test('modifier attempt outcome register stays equal to the driver enum', () => {
  assert.deepEqual(MODIFIER_ATTEMPT_OUTCOMES, MODIFIER_OUTCOMES)
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

test('linkRun records one idempotent association and taskReadout resolves it by run_id', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'ledger-session-A'
  const runId = 'daemon-run-A'
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'linked-task' })
  ledger.linkRun({ run_id: runId, adw_id: adwId, crew_dir: '/tmp/crew' })
  ledger.linkRun({ run_id: runId, adw_id: adwId, crew_dir: '/tmp/crew' })

  const rows = ledger.dumpTable('run_links')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].run_id, runId)
  assert.equal(rows[0].adw_id, adwId)
  const readout = ledger.taskReadout(runId)
  assert.equal(readout.resolved_by, 'run_id')
  assert.equal(readout.adw_id, adwId)
  assert.deepEqual(readout.run_ids, [runId])
})

test('taskReadout precedence is adw_id, then run_id, then task_slug', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'session-run-A', repo_slug: 'r', task_slug: 'shared-selector' })
  ledger.startSession({ adw_id: 'session-slug-B', repo_slug: 'r', task_slug: 'shared-selector' })
  ledger.linkRun({ run_id: 'shared-selector', adw_id: 'session-run-A' })
  const byRun = ledger.taskReadout('shared-selector')
  assert.equal(byRun.resolved_by, 'run_id')
  assert.equal(byRun.adw_id, 'session-run-A')

  ledger.startSession({ adw_id: 'direct-selector', repo_slug: 'r', task_slug: 'direct-task' })
  ledger.linkRun({ run_id: 'direct-selector', adw_id: 'session-run-A' })
  const byAdw = ledger.taskReadout('direct-selector')
  assert.equal(byAdw.resolved_by, 'adw_id')
  assert.equal(byAdw.adw_id, 'direct-selector')
})

test('taskReadout exposes shared adopted sessions and refuses ambiguous or sessionless links', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'adopted-session-A'
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'adopted-task' })
  ledger.linkRun({ run_id: 'daemon-run-one', adw_id: adwId })
  ledger.linkRun({ run_id: 'daemon-run-two', adw_id: adwId })
  for (const runId of ['daemon-run-one', 'daemon-run-two']) {
    const readout = ledger.taskReadout(runId)
    assert.equal(readout.resolved_by, 'run_id')
    assert.equal(readout.adw_id, adwId)
    assert.deepEqual(readout.run_ids, ['daemon-run-one', 'daemon-run-two'])
    assert.match(readout.absent.run_scope, /adopted sidecar/)
  }

  ledger.startSession({ adw_id: 'ambiguous-session-A', repo_slug: 'r', task_slug: 'a' })
  ledger.startSession({ adw_id: 'ambiguous-session-B', repo_slug: 'r', task_slug: 'b' })
  ledger.linkRun({ run_id: 'ambiguous-daemon-run', adw_id: 'ambiguous-session-A' })
  ledger.linkRun({ run_id: 'ambiguous-daemon-run', adw_id: 'ambiguous-session-B' })
  const ambiguous = ledger.taskReadout('ambiguous-daemon-run')
  assert.equal(ambiguous.adw_id, null)
  assert.deepEqual(ambiguous.candidates, ['ambiguous-session-A', 'ambiguous-session-B'])
  assert.deepEqual(ambiguous.run_ids, [])

  ledger.linkRun({ run_id: 'sessionless-daemon-run', adw_id: 'never-started-session' })
  const sessionless = ledger.taskReadout('sessionless-daemon-run')
  assert.equal(sessionless.adw_id, null)
  assert.deepEqual(sessionless.candidates, [])
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
    request: 'this run predates request recording (#b19) / was not dispatched by the intake loop; the request was never measured, and NULL is never an empty ask',
    context_occupancy: 'no live transport records occupancy — pane seats land no agent_sessions row at all; headless-json/headless-rpc land rows with both columns NULL; context_window has no verified source (U-4); see docs/ledger-queries.md',
    usage: 'predates per-agent token measurement (#119) — not a measured zero',
    gate_discrimination: 'predates gate discrimination (#168)',
    review_outcomes: 'predates structured review outcomes (#169/#170)',
    accept_decisions: 'predates typed accept decisions (#170)',
    gate_results: 'predates gate verdict recording (#130)',
    phases: 'no phase rows recorded for this run',
    variant: "this run's first recorded event is not a shape marker — the run shape is unmeasured (#251), never a measured \"full\"",
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
  for (const key of ['adw_id', 'resolved_by', 'session', 'phases', 'gate_generations', 'review_outcomes', 'accept_decisions', 'usage', 'variant', 'absent']) {
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
  ledger.linkRun({ run_id: MARKER_ADW, adw_id: ctx, crew_dir: MARKER_ADW })
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
  ledger.recordCiCycle({
    adw_id: ctx, task_slug: 't', repo_slug: MARKER_ADW, branch: 'main', head_sha: 'marker-head',
    check_name: 'test (node 24)', cycle: 1, conclusion: 'failure', classification: 'unknown',
    decision: 'park', reason: MARKER_ADW, excerpt: MARKER_ADW, excerpt_source: 'check-log',
    local_lane: MARKER_ADW, local_exit: 1, created_at: '2024-01-01T00:00:02.000Z',
  })
  ledger.recordCiDispatch({
    adw_id: ctx, task_slug: 't', repo_slug: MARKER_ADW, branch: 'main', head_sha: 'marker-head',
    check_name: 'test (node 24)', cycle: 1, variant: 'repair', outcome: 'escalation', reason: MARKER_ADW,
    commit: MARKER_ADW, brief_path: MARKER_ADW, scope_source: MARKER_ADW, scope_count: 1,
    task_return: MARKER_ADW, park_path: MARKER_ADW, exit_code: 1, created_at: '2024-01-01T00:00:02.000Z',
  })
  ledger.recordModifierAttempt({
    adw_id: ctx, task_slug: 't', role: 'builder', modifier: 'failure-upgrade', bounce: 'lane', outcome: 'transport',
    why: MARKER_ADW, rung: MARKER_ADW, transport: 'headless-rpc',
    from_provider: 'anthropic', from_model_id: 'sonnet', from_model: MARKER_ADW, from_agent: 'claude', from_effort: 'high',
    created_at: '2024-01-01T00:00:01.000Z',
  })
  ledger.recordSeatTeardown({
    adw_id: ctx, role: 'builder', transport: 'headless-rpc', session_id: MARKER_ADW,
    pgid: 555, reservation_id: MARKER_ADW, outcome: 'unproven', reason: MARKER_ADW,
    forced: true, evidence_kind: 'pgid', created_at: '2024-01-01T00:00:01.000Z',
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

  const cycleLine = jsonlBytes.split('\n').find((line) => {
    try { return JSON.parse(line).kind === 'recordCiCycle' } catch { return false }
  })
  assert.ok(cycleLine, 'recordCiCycle JSONL line missing')
  const cycleJsonlPath = join(nextDir(), 'cycle-only.jsonl')
  writeFileSync(cycleJsonlPath, `${cycleLine}\n`)
  const replayed = openTestLedger()
  assert.doesNotThrow(() => replayJsonl(cycleJsonlPath, replayed))
  const replayedCycles = replayed.dumpTable('ci_cycles')
  assert.equal(replayedCycles.length, 1)
  assert.equal(replayedCycles[0].reason, 'redacted')
  replayed.close()

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

test('recordSessionRequest redaction is a replayable no-op with no request provenance', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({ adw_id: 'request-redacted', repo_slug: 'r', task_slug: 't' })
  const args = source.recordSessionRequest({
    adw_id: 'request-redacted', request: MARKER_NONCE_ONLY, source: 'dispatch',
  })
  assert.deepEqual(args, {
    adw_id: 'request-redacted', request: null, source: null, redacted: true,
  })
  assert.deepEqual({
    request: source.getSession('request-redacted').request,
    request_source: source.getSession('request-redacted').request_source,
  }, { request: null, request_source: null })
  const jsonlBytes = readFileSync(source._jsonlPath, 'utf8')
  assert.ok(!jsonlBytes.includes(MARKER_NONCE_ONLY), 'redacted request leaked into JSONL')

  const replayed = openTestLedger()
  assert.doesNotThrow(() => replayJsonl(source._jsonlPath, replayed))
  assert.deepEqual({
    request: replayed.getSession('request-redacted').request,
    request_source: replayed.getSession('request-redacted').request_source,
  }, { request: null, request_source: null })
  replayed.recordSessionRequest({
    adw_id: 'request-redacted', request: 'read safely from brief', source: 'brief-file',
  })
  assert.deepEqual({
    request: replayed.getSession('request-redacted').request,
    request_source: replayed.getSession('request-redacted').request_source,
  }, { request: 'read safely from brief', request_source: 'brief-file' })
})

test('recordSessionRequest redacted replay sanitizes a forged adw_id marker before JSONL append', { skip: SKIP }, () => {
  const forgedJsonl = join(nextDir(), 'forged-request.jsonl')
  writeFileSync(forgedJsonl, `${JSON.stringify({
    v: 1,
    kind: 'recordSessionRequest',
    at: new Date().toISOString(),
    args: { adw_id: MARKER_NONCE_ONLY, request: null, source: null, redacted: true },
  })}\n`)

  const replayed = openTestLedger()
  assert.deepEqual(replayJsonl(forgedJsonl, replayed), { applied: 1, skipped: 0 })
  const jsonlBytes = readFileSync(replayed._jsonlPath, 'utf8')
  assert.ok(!jsonlBytes.includes(MARKER_NONCE_ONLY), 'forged redacted adw_id leaked into replay JSONL')
  assert.match(jsonlBytes, /"adw_id":null/, 'replay must preserve the redacted no-op shape')
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
  const readyPath = join(dir, 'finalizer-installed')
  const program = `
    const { openLedger, isoMs } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
    const { writeFileSync, renameSync } = await import('node:fs');
    const ledger = openLedger({ dbPath: ${JSON.stringify(dbPath)} });
    ledger.startSession({ adw_id: 'sig-1', repo_slug: 'r', task_slug: 't' });
    ledger.startProcess({ adw_id: 'sig-1', dispatch_id: 'd', pid: process.pid, command: 'child' });
    ledger.installFinalizer({ adw_id: 'sig-1' });
    // Published only AFTER the handler is installed, and atomically, so the
    // reader can never observe a half-written marker as readiness.
    writeFileSync(${JSON.stringify(readyPath)} + '.tmp', 'ok');
    renameSync(${JSON.stringify(readyPath)} + '.tmp', ${JSON.stringify(readyPath)});
    setInterval(() => {}, 1000);
  `
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' }))
  // Gate on the FINALIZER being installed, not on the session row existing.
  //
  // The row is committed by startSession, two statements before
  // installFinalizer. Waiting on the row therefore only proves the child got
  // as far as startSession — so on a slow runner SIGTERM could still land in
  // the gap before the handler existed, the child would die on the DEFAULT
  // SIGTERM disposition (which still satisfies the `signal === 'SIGTERM'`
  // assertion below, so the failure surfaced two asserts later), and the
  // session would stay 'running'. That is the CI failure this closes:
  // 'running' !== 'fail'.
  //
  // An earlier fix replaced a fixed 400 ms sleep with a poll for the row; that
  // closed the case where NO row existed and getSession returned null, but it
  // moved the race one statement later rather than removing it. Gating on the
  // precondition the test actually needs — a handler that can answer the
  // signal — is what removes it. Verified by widening the
  // startSession→installFinalizer window, which reproduces the exact CI
  // failure before this change and cannot after it.
  //
  // ONE reader is opened and reused: reopening per poll starves the sibling
  // SIGTERM test of the database lock.
  {
    let committed = false
    try {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (existsSync(readyPath)) { committed = true; break }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally { /* the marker is a plain file; there is nothing to close */ }
    const probe = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      // The marker is written after startSession, so the row must be present
      // by now; assert it rather than assume it.
      committed = committed && (() => {
        try { return probe.getSession('sig-1') != null } catch { return false }
      })()
    } finally {
      try { probe.close?.() } catch { /* a probe that cannot close is not a test failure */ }
    }
    assert.equal(committed, true, 'the child must commit sig-1 before the finalizer is exercised')
  }
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
  // Wait for the child to have COMMITTED its work rather than sleeping a fixed
  // 400 ms and hoping. Under a loaded runner the child had not reached
  // startSession before the SIGTERM, so no row existed, getSession returned
  // null, and reading `.status` off it threw — a flake that surfaced only when
  // three PRs' CI ran concurrently, reproduced here by shortening the sleep.
  // ONE reader is opened and reused: reopening per poll starves the sibling
  // SIGTERM test of the database lock.
  {
    const probe = openLedger({ dbPath, stderr: { write: () => {} } })
    let committed = false
    try {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        try { committed = probe.getSession('sig-2')?.status === 'ok' } catch { committed = false }
        if (committed) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally {
      try { probe.close?.() } catch { /* a probe that cannot close is not a test failure */ }
    }
    assert.equal(committed, true, 'the child must commit sig-2 before the finalizer is exercised')
  }
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

test('run variant registers stay equal to the driver enum and marker values', { skip: SKIP }, () => {
  assert.deepEqual([...RUN_VARIANTS], [...VARIANT_NAMES])
  assert.deepEqual([...new Set(Object.values(RUN_VARIANT_MARKERS))].sort(), [...RUN_VARIANTS].sort())
})

test('taskReadout derives full and scout from their first stage markers', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'variant-task-full', RUNSET_SINCE)
  ledger.recordEvent({ adw_id: 'variant-task-full', type: 'log', payload: { level: 'info', message: 'plan:r1' } })
  ledger.recordEvent({ adw_id: 'variant-task-full', type: 'log', payload: { level: 'info', message: 'build:r1' } })
  seedRun(ledger, 'variant-task-scout', RUNSET_SINCE)
  ledger.recordEvent({ adw_id: 'variant-task-scout', type: 'log', payload: { level: 'info', message: 'scout:r1' } })
  ledger.recordEvent({ adw_id: 'variant-task-scout', type: 'log', payload: { level: 'info', message: 'envelope-accept' } })

  const full = ledger.taskReadout('variant-task-full')
  const scout = ledger.taskReadout('variant-task-scout')
  assert.equal(full.variant, 'full')
  assert.equal(scout.variant, 'scout')
  assert.equal('variant' in full.absent, false)
  assert.equal('variant' in scout.absent, false)
})

test('taskReadout uses only the first log row and marks absent shape evidence', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'variant-task-noisy', RUNSET_SINCE)
  ledger.recordEvent({ adw_id: 'variant-task-noisy', type: 'log', payload: { level: 'warn', message: 'attention:gate plan:r1 mentioned' } })
  ledger.recordEvent({ adw_id: 'variant-task-noisy', type: 'log', payload: { level: 'info', message: 'plan:r1' } })
  seedRun(ledger, 'variant-task-silent', RUNSET_SINCE)

  const noisy = ledger.taskReadout('variant-task-noisy')
  const silent = ledger.taskReadout('variant-task-silent')
  assert.equal(noisy.variant, null)
  assert.equal(typeof noisy.absent.variant, 'string')
  assert.equal(silent.variant, null)
  assert.equal(typeof silent.absent.variant, 'string')
})

test('variantFromFirstMessage recognizes only complete shape markers', { skip: SKIP }, () => {
  assert.equal(variantFromFirstMessage('plan:r1'), 'full')
  assert.equal(variantFromFirstMessage('scout:r1'), 'scout')
  assert.equal(variantFromFirstMessage('repair:r1'), 'repair')
  for (const value of ['plan', '', null, undefined, 42, 'attention:gate plan:r1']) {
    assert.equal(variantFromFirstMessage(value), null, JSON.stringify(value))
  }
})

test('runSet carries each run variant and marks an unmeasured row absent in the CLI', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'variant-set-full', RUNSET_SINCE)
  ledger.recordEvent({ adw_id: 'variant-set-full', type: 'log', payload: { level: 'info', message: 'plan:r1' } })
  seedRun(ledger, 'variant-set-scout', '2026-08-15T00:01:00.000Z')
  ledger.recordEvent({ adw_id: 'variant-set-scout', type: 'log', payload: { level: 'info', message: 'scout:r1' } })
  seedRun(ledger, 'variant-set-silent', '2026-08-15T00:02:00.000Z')
  const rows = ledger.runSet({ since: RUNSET_SINCE })
  assert.deepEqual(rows.map((row) => ({ adw_id: row.adw_id, variant: row.variant })), [
    { adw_id: 'variant-set-full', variant: 'full' },
    { adw_id: 'variant-set-scout', variant: 'scout' },
    { adw_id: 'variant-set-silent', variant: null },
  ])

  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['run-set', '--since', RUNSET_SINCE], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(typeof payload.absent.variant, 'string')
})

test('runSet derives variants in bounded chunks', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const total = STAGE_MARKER_CHUNK * 2 + 3
  for (let i = 0; i < total; i += 1) {
    const adwId = `variant-chunk-${String(i).padStart(4, '0')}`
    seedRun(ledger, adwId, RUNSET_SINCE)
    ledger.recordEvent({
      adw_id: adwId, type: 'log',
      payload: { level: 'info', message: i % 2 === 0 ? 'plan:r1' : 'scout:r1' },
    })
  }
  const rows = ledger.runSet({ since: RUNSET_SINCE })
  assert.equal(rows.length, total)
  for (const row of rows) {
    const index = Number(row.adw_id.slice('variant-chunk-'.length))
    assert.equal(row.variant, index % 2 === 0 ? 'full' : 'scout', row.adw_id)
  }
})

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

test('recordIntakeDispatch requires its fields, closed outcomes, and a PR number for promotion', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  assert.throws(
    () => ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 1 }),
    (err) => err instanceof LedgerUsageError && err.message.includes("missing required field 'outcome'"),
  )
  assert.throws(
    () => ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 1, outcome: 'not-real' }),
    (err) => err instanceof LedgerUsageError && !err.message.includes('not-real'),
  )
  assert.throws(
    () => ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 1, outcome: 'promoted' }),
    (err) => err instanceof LedgerUsageError && err.message.includes('requires pr_number'),
  )
})

test('a dispatch row round-trips through JSONL, sqlite, and replayJsonl', { skip: SKIP }, () => {
  const source = openTestLedger()
  const row = source.recordIntakeDispatch({
    board_owner: 'owner', board_project: 7, issue: 2, sweep_at: '2024-01-01T00:00:00.000Z',
    outcome: 'done', reason: null, tier: 'build', task_slug: 'intake-2', board_item_id: 'item-2',
    branch: 'work/2', brief_path: '/tmp/brief.md', crew_dir: '/tmp/crew',
    task_return: '/tmp/returns/task.json', exit_code: 0, board_from: 'Ready', board_to: 'In progress',
    created_at: '2024-01-01T00:00:01.000Z',
  })
  const raw = readFileSync(source._jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(raw.at(-1).kind, 'recordIntakeDispatch')
  const target = openTestLedger()
  const replayed = replayJsonl(source._jsonlPath, target)
  assert.deepEqual(replayed, { applied: 1, skipped: 0 })
  assert.deepEqual({ ...target.dumpTable('intake_dispatches')[0] }, { id: 1, ...row })
})

test('an older migration prefix upgrades additively and keeps existing intake sweeps', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'dispatch-prefix.db')
  const dispatchIndex = MIGRATIONS.findIndex((statement) => /intake_dispatches/i.test(statement))
  assert.ok(dispatchIndex > 0)
  const db = new DatabaseSync(dbPath)
  applyMigrations(db, MIGRATIONS.slice(0, dispatchIndex))
  db.prepare('INSERT INTO intake_sweeps (board_owner, board_project, outcome, considered, pages, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('owner', 7, 'none', 0, 1, '2024-01-01T00:00:00.000Z')
  db.close()
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  assert.equal(ledger.dumpTable('intake_sweeps').length, 1)
  assert.deepEqual(ledger.dumpTable('intake_dispatches'), [])
})

test('intakeDispatches groups outcome and reason within the requested window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 1, outcome: 'claimed', created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 2, outcome: 'claimed', created_at: '2024-01-01T00:00:01.000Z' })
  ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 3, outcome: 'refused', reason: 'boot-failed', created_at: '2024-01-01T00:00:02.000Z' })
  assert.deepEqual(ledger.intakeDispatches({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-01T00:00:02.000Z' }).map((row) => ({ ...row })), [
    { outcome: 'claimed', reason: null, count: 2, first_at: '2024-01-01T00:00:00.000Z', last_at: '2024-01-01T00:00:01.000Z' },
  ])
})

test('the intake-sweeps CLI prints dispatches beside sweeps and refusals', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 7, outcome: 'none', considered: 0, pages: 1, created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 4, outcome: 'claimed', created_at: '2024-01-01T00:00:01.000Z' })
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['intake-sweeps'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.ok(Array.isArray(payload.dispatches))
  assert.deepEqual(payload.dispatch_outcomes, [...INTAKE_DISPATCH_OUTCOMES])
  assert.equal(payload.dispatches[0].outcome, 'claimed')
})

test('seat teardown outcomes mirror gate discrimination and duplicate emissions are idempotent', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  assert.deepEqual(SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS)
  const row = {
    adw_id: 'seat-run', role: 'builder', transport: 'headless-rpc', session_id: 's1', pgid: 4242,
    reservation_id: 'r1', outcome: 'proven', reason: 'exit-marker', forced: true,
    evidence_kind: 'pgid', created_at: '2024-01-01T00:00:00.000Z',
  }
  ledger.recordSeatTeardown(row)
  ledger.recordSeatTeardown({ ...row, outcome: 'failed', reason: 'probe-alive', created_at: '2024-01-01T00:00:01.000Z' })
  const rows = ledger.dumpTable('seat_teardowns')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, 'proven')
  const bad = openTestLedger()
  assert.throws(
    () => bad.recordSeatTeardown({ adw_id: 'seat-bad', role: 'builder', outcome: 'retired' }),
    (err) => err instanceof LedgerUsageError && !err.message.includes('retired'),
  )
  assert.deepEqual(bad.dumpTable('seat_teardowns'), [])
  const below = openLedger({ dbPath: join(nextDir(), 'seat-floor.db'), nodeVersion: '20.11.0', stderr: { write: () => {} } })
  assert.doesNotThrow(() => below.recordSeatTeardown({ adw_id: 'seat-floor', outcome: 'unproven' }))
})

test('seatTeardowns aggregates outcome and reason within a window and the CLI reports its tally', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordSeatTeardown({ adw_id: 'seat-a', role: 'builder', outcome: 'proven', reason: 'exit-marker', created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordSeatTeardown({ adw_id: 'seat-b', role: 'builder', outcome: 'proven', reason: 'exit-marker', created_at: '2024-01-01T00:00:01.000Z' })
  ledger.recordSeatTeardown({ adw_id: 'seat-c', role: 'reviewer', outcome: 'unproven', reason: 'probe-unknown', created_at: '2024-01-01T00:00:02.000Z' })
  assert.deepEqual(ledger.seatTeardowns({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-01T00:00:02.000Z' }).map((row) => ({ ...row })), [
    { outcome: 'proven', reason: 'exit-marker', count: 2, first_at: '2024-01-01T00:00:00.000Z', last_at: '2024-01-01T00:00:01.000Z' },
  ])
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['seat-teardowns', '--since', '2024-01-01T00:00:00Z', '--until', '2024-01-01T00:00:03Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.deepEqual(payload.outcomes, [...SEAT_TEARDOWN_OUTCOMES])
  assert.equal(payload.measured, true)
  assert.equal(payload.torn_down, 3)
  assert.equal(payload.proven, 2)
  assert.equal(payload.leaked, 0)
  assert.equal(payload.unproven, 1)
})

test('seat-teardowns CLI marks an empty window as not measured', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['seat-teardowns', '--since', '2030-01-01T00:00:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.measured, false)
  assert.ok(payload.absent?.seat_teardowns)
  for (const key of ['torn_down', 'proven', 'leaked', 'unproven']) assert.equal(payload[key], null)
})

test('an older migration prefix upgrades additively with seat_teardowns', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'seat-prefix.db')
  const seatIndex = MIGRATIONS.findIndex((statement) => /seat_teardowns/i.test(statement))
  assert.ok(seatIndex > 0)
  const db = new DatabaseSync(dbPath)
  applyMigrations(db, MIGRATIONS.slice(0, seatIndex))
  db.close()
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  assert.deepEqual(ledger.dumpTable('seat_teardowns'), [])
  assert.deepEqual(ledger.dumpTable('seat_teardowns').map((row) => Object.keys(row)), [])
  ledger.recordSeatTeardown({ adw_id: 'seat-prefix', role: 'builder', outcome: 'proven' })
  assert.equal(ledger.dumpTable('seat_teardowns').length, 1)
})

// ---------------------------------------------------------------------------
// Shopfloor slice D: request provenance, honest absence, and retirement.
// ---------------------------------------------------------------------------

test('recordSessionRequest round-trips request and request_source on an existing session', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'request-roundtrip', repo_slug: 'r', task_slug: 't' })
  const args = ledger.recordSessionRequest({
    adw_id: 'request-roundtrip', request: '  Compile the dispatch headline  ', source: 'dispatch',
  })
  assert.deepEqual({ request: args.request, source: args.source }, {
    request: 'Compile the dispatch headline', source: 'dispatch',
  })
  const row = ledger.getSession('request-roundtrip')
  assert.deepEqual({ request: row.request, request_source: row.request_source }, {
    request: 'Compile the dispatch headline', request_source: 'dispatch',
  })
})

test('recordSessionRequest is first-write-wins for both text and source', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'request-first', repo_slug: 'r', task_slug: 't' })
  ledger.recordSessionRequest({ adw_id: 'request-first', request: 'first ask', source: 'dispatch' })
  ledger.recordSessionRequest({ adw_id: 'request-first', request: 'later backfill', source: 'brief-file' })
  assert.deepEqual({ request: ledger.getSession('request-first').request, request_source: ledger.getSession('request-first').request_source }, {
    request: 'first ask', request_source: 'dispatch',
  })
})

test('recordSessionRequest never inserts a sessions row for an unknown adw_id', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'request-known', repo_slug: 'r', task_slug: 't' })
  ledger.recordSessionRequest({ adw_id: 'request-unknown', request: 'not a run', source: 'dispatch' })
  assert.equal(ledger.dumpTable('sessions').length, 1)
  assert.equal(ledger.getSession('request-unknown'), null)
})

test('recordSessionRequest refuses blank/non-string requests and an unknown source enum', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'request-invalid', repo_slug: 'r', task_slug: 't' })
  for (const request of ['', '   ', null, 42]) {
    assert.throws(
      () => ledger.recordSessionRequest({ adw_id: 'request-invalid', request, source: 'dispatch' }),
      LedgerUsageError,
    )
  }
  assert.throws(
    () => ledger.recordSessionRequest({ adw_id: 'request-invalid', request: 'ask', source: 'operator' }),
    LedgerUsageError,
  )
  assert.equal(ledger.getSession('request-invalid').request, null)
})

test('recordSessionRequest clamps long text with a visible truncation marker', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'request-long', repo_slug: 'r', task_slug: 't' })
  const args = ledger.recordSessionRequest({
    adw_id: 'request-long', request: `  ${'x'.repeat(REQUEST_MAX_CHARS + 100)}  `, source: 'dispatch',
  })
  assert.equal(args.request.length, REQUEST_MAX_CHARS)
  assert.match(args.request, /…\[truncated\]$/)
  assert.equal(ledger.getSession('request-long').request, args.request)
})

test('taskReadout marks an unrecorded request absent and drops the marker after recording', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'request-readout', repo_slug: 'r', task_slug: 't' })
  const before = ledger.taskReadout('request-readout')
  assert.equal(before.session.request, null)
  assert.ok(before.absent.request)
  ledger.recordSessionRequest({ adw_id: 'request-readout', request: 'recorded ask', source: 'dispatch' })
  const after = ledger.taskReadout('request-readout')
  assert.equal(after.session.request, 'recorded ask')
  assert.equal(after.session.request_source, 'dispatch')
  assert.equal(after.absent.request, undefined)
})

test('taskReadout marks context occupancy absent when no agent row measures context_tokens', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'occupancy-absent', repo_slug: 'r', task_slug: 't' })
  ledger.startAgentSession({
    adw_id: 'occupancy-absent', dispatch_id: 'd1', role: 'builder', model: 'm',
    claude_session_id: 'cs1', transcript_path: '/tmp/t.jsonl',
  })
  const readout = ledger.taskReadout('occupancy-absent')
  assert.ok(readout.absent.context_occupancy)
})

test('a recordSessionRequest JSONL line replays through the closed writer set', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({ adw_id: 'request-replay', repo_slug: 'r', task_slug: 't' })
  source.recordSessionRequest({ adw_id: 'request-replay', request: 'replay this ask', source: 'dispatch' })
  const target = openTestLedger()
  assert.deepEqual(replayJsonl(source._jsonlPath, target), { applied: 2, skipped: 0 })
  assert.deepEqual({ request: target.getSession('request-replay').request, request_source: target.getSession('request-replay').request_source }, {
    request: 'replay this ask', request_source: 'dispatch',
  })
})

test('request CLI reads the ask section and refuses missing or blank briefs without writing', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'request-cli.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  ledger.startSession({ adw_id: 'request-cli', repo_slug: 'r', task_slug: 't' })
  ledger.close()
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, '# Task\n## The ask\n\nUse the compiled ask\n\n## Proposed tier\nbuild\n')
  const ok = run(['request', 'request-cli', '--from-brief', brief], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(ok.status, 0, ok.stderr)
  const after = openLedger({ dbPath, stderr: { write: () => {} } })
  assert.deepEqual({ request: after.getSession('request-cli').request, request_source: after.getSession('request-cli').request_source }, {
    request: 'Use the compiled ask', request_source: 'brief-file',
  })
  after.close()
  const beforeLines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length
  const cases = [
    ['missing', join(dir, 'missing.md')],
    ['no-heading', join(dir, 'no-heading.md')],
    ['blank', join(dir, 'blank.md')],
  ]
  writeFileSync(cases[1][1], '# no ask\n')
  writeFileSync(cases[2][1], '## The ask\n\n## Proposed tier\nbuild\n')
  for (const [, path] of cases) {
    const refused = run(['request', 'request-cli', '--from-brief', path], { DEVTEAM_LEDGER_DB: dbPath })
    assert.equal(refused.status, 2, path)
  }
  const finalLines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length
  assert.equal(finalLines, beforeLines)
})

test('doctor reports the retired envelopes reason beside an empty row count', { skip: SKIP }, () => {
  const dbPath = join(nextDir(), 'doctor-retired.db')
  const res = run(['doctor'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.row_counts.envelopes, 0)
  assert.ok(typeof payload.retired_tables.envelopes === 'string' && payload.retired_tables.envelopes.length >= 40)
})

test('recordEnvelope has no production caller; future wiring must update the retirement record', { skip: SKIP }, () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(mjs|js)$/.test(entry) || /\.test\.mjs$/.test(entry)) continue
      if (full.endsWith('scripts/factory/ledger.mjs')) continue
      if (/\brecordEnvelope\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(full)
    }
  }
  for (const root of ['crew', 'scripts', 'visualizer']) walk(join(ROOT, root))
  assert.deepEqual(offenders, [], 'update RETIRED_TABLES.envelopes and docs/ledger-queries.md when wiring recordEnvelope')
})

test('sessions ends with tier, proposed_shape, proposed_strength and starts each row with all three NULL', { skip: SKIP }, () => {
  assert.deepEqual(TABLES.sessions.columns.slice(-3).map(({ name }) => name), [
    'tier', 'proposed_shape', 'proposed_strength',
  ])
  assert.equal(TABLES.sessions.columns.at(-4).name, 'last_heartbeat_at')
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'heartbeat-null', repo_slug: 'r', task_slug: 't' })
  const row = ledger.getSession('heartbeat-null')
  assert.equal(row.last_heartbeat_at, null)
  assert.equal(row.tier, null)
  assert.equal(row.proposed_shape, null)
  assert.equal(row.proposed_strength, null)
})

test('openRun records the boot tier and brief proposals, while a blockless brief records null', { skip: SKIP }, () => {
  const booted = bootTieredRun('build')
  assert.equal(booted.tier, 'build')
  const untiered = bootTieredRun(null)
  assert.equal(untiered.tier, null)
  const carrying = bootBriefRun([
    '# Task: compiled',
    '## Proposed tier',
    'proposed shape: mechanical',
    'proposed strength: workhorse',
    '```proposal',
    '{',
    '  "shape": "mechanical",',
    '  "strength": "workhorse"',
    '}',
    '```',
    '## Where',
  ].join('\n'), 'proposal-record')
  assert.equal(carrying.row.proposed_shape, 'mechanical')
  assert.equal(carrying.row.proposed_strength, 'workhorse')
  assert.equal(carrying.stderr, '')
  const blockless = bootBriefRun('# Task: compiled\n## Proposed tier\nno proposal\n', 'proposal-absent')
  assert.equal(blockless.row.proposed_shape, null)
  assert.equal(blockless.row.proposed_strength, null)
})

test('proposal parser names malformed, duplicated and unknown blocks, and boot records null with one notice', { skip: SKIP }, () => {
  const fence = '```proposal'
  const cases = [
    ['malformed', [fence, '{ not json', '```'].join('\n'), /not JSON/],
    ['duplicated', [
      fence, '{"shape":"mechanical","strength":"workhorse"}', '```',
      fence, '{"shape":"mechanical","strength":"workhorse"}', '```',
    ].join('\n'), /duplicated|2 .*proposal/],
    ['unknown', [fence, '{"shape":"mechanical","strength":"workhorse","tier":"build"}', '```'].join('\n'), /tier/],
  ]
  for (const [label, brief, defect] of cases) {
    const parsed = parseProposalBrief(brief)
    assert.equal(parsed.absent, false)
    assert.match(parsed.defect, defect)
    assert.equal(parsed.shape, null)
    assert.equal(parsed.strength, null)
    _resetNoticeGuardsForTest()
    const booted = bootBriefRun(brief, `proposal-${label}`)
    assert.equal(booted.row.proposed_shape, null)
    assert.equal(booted.row.proposed_strength, null)
    assert.equal(booted.stderr.split('\n').filter(Boolean).length, 1)
    assert.match(booted.stderr, defect)
  }
})

test('a sessions table predating the proposal columns upgrades without backfilling any existing value', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'proposal-upgrade.db')
  const db = new DatabaseSync(dbPath)
  const older = TABLES.sessions.columns.filter(({ name }) => !['proposed_shape', 'proposed_strength'].includes(name))
  const names = older.map(({ name }) => name)
  try {
    db.exec(`CREATE TABLE sessions (${older.map(({ name, decl }) => `"${name}" ${decl}`).join(', ')})`)
    const values = names.map((name) => name === 'adw_id' ? 'historical-proposal' : name === 'tier' ? 'build' : null)
    db.prepare(`INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values)
    const before = db.prepare('SELECT * FROM sessions WHERE adw_id = ?').get('historical-proposal')
    applyMigrations(db)
    const after = db.prepare('SELECT * FROM sessions WHERE adw_id = ?').get('historical-proposal')
    for (const name of names) assert.deepEqual(after[name], before[name], `existing session column changed: ${name}`)
    assert.equal(after.proposed_shape, null)
    assert.equal(after.proposed_strength, null)
  } finally { db.close() }
})

test('startSession refuses blank or over-long proposal names and accepts explicit nulls', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  for (const [field, value] of [
    ['proposed_shape', '   '],
    ['proposed_strength', ''],
    ['proposed_shape', 'x'.repeat(65)],
    ['proposed_strength', 'x'.repeat(65)],
  ]) {
    assert.throws(
      () => ledger.startSession({
        adw_id: `proposal-invalid-${field}-${value.length}`,
        repo_slug: 'r', task_slug: 't', [field]: value,
      }),
      LedgerUsageError,
    )
  }
  const row = ledger.startSession({
    adw_id: 'proposal-null', repo_slug: 'r', task_slug: 't', proposed_shape: null, proposed_strength: null,
  })
  assert.equal(row.proposed_shape, null)
  assert.equal(row.proposed_strength, null)
})

test('proposal fields replay through JSONL into sessions', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({
    adw_id: 'proposal-replay', repo_slug: 'r', task_slug: 't',
    proposed_shape: 'mechanical', proposed_strength: 'workhorse',
  })
  const target = openTestLedger()
  assert.deepEqual(replayJsonl(source._jsonlPath, target), { applied: 1, skipped: 0 })
  const row = target.getSession('proposal-replay')
  assert.equal(row.proposed_shape, 'mechanical')
  assert.equal(row.proposed_strength, 'workhorse')
})

test('no non-test factory or crew module consumes the recorded proposal columns', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.mjs$/.test(entry) || /\.test\.mjs$/.test(entry)) continue
      if (full.endsWith('scripts/factory/ledger.mjs') || full.endsWith('scripts/factory/emit.mjs')) continue
      const source = readFileSync(full, 'utf8')
      if (/proposed_shape|proposed_strength/.test(source)) offenders.push(full)
    }
  }
  for (const root of ['crew', 'scripts/factory']) walk(join(ROOT, root))
  assert.deepEqual(offenders, [])
})

test('session heartbeat updates only last_heartbeat_at in place and overwrites it', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'heartbeat-update'
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 't' })
  const before = ledger.getSession(adwId)
  const firstAt = Date.parse('2026-01-02T03:04:05.006Z')
  ledger.heartbeat({ adw_id: adwId, target: 'session', at: firstAt })
  const afterFirst = ledger.getSession(adwId)
  assert.equal(afterFirst.last_heartbeat_at, isoMs(firstAt))
  for (const column of TABLES.sessions.columns.map(({ name }) => name).filter((name) => name !== 'last_heartbeat_at')) {
    assert.deepEqual(afterFirst[column], before[column], `session column changed: ${column}`)
  }
  const secondAt = Date.parse('2026-01-02T03:04:06.007Z')
  ledger.heartbeat({ adw_id: adwId, target: 'session', at: secondAt })
  const afterSecond = ledger.getSession(adwId)
  assert.equal(afterSecond.last_heartbeat_at, isoMs(secondAt))
  for (const column of TABLES.sessions.columns.map(({ name }) => name).filter((name) => name !== 'last_heartbeat_at')) {
    assert.deepEqual(afterSecond[column], before[column], `session column changed: ${column}`)
  }
})

test('session heartbeat requires adw_id and rejects an unknown target', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  assert.throws(() => ledger.heartbeat({ target: 'session' }), LedgerUsageError)
  assert.throws(() => ledger.heartbeat({ adw_id: 'heartbeat-invalid', target: 'unknown' }), LedgerUsageError)
})

test('a session heartbeat JSONL line replays into the sessions last_heartbeat_at column', { skip: SKIP }, () => {
  const source = openTestLedger()
  const adwId = 'heartbeat-replay'
  const at = Date.parse('2026-02-03T04:05:06.007Z')
  source.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 't' })
  source.heartbeat({ adw_id: adwId, target: 'session', at })
  const target = openTestLedger()
  assert.deepEqual(replayJsonl(source._jsonlPath, target), { applied: 2, skipped: 0 })
  assert.equal(target.getSession(adwId).last_heartbeat_at, isoMs(at))
})

// ---------------------------------------------------------------------------
// advisor A/B readout
// ---------------------------------------------------------------------------

const ADVISOR_AB_EPOCH = 1755600000000

function advisorAbFixture(spec = {}) {
  const dir = nextDir()
  const runDir = join(dir, 'run')
  const returns = join(runDir, 'returns')
  mkdirSync(returns, { recursive: true })
  const lines = []
  for (const [id, at] of Object.entries(spec.attest || {})) {
    lines.push(JSON.stringify({ at, envelope: id, role: 'reviewer', status: 'done' }))
  }
  for (const payload of spec.notes || []) {
    lines.push(JSON.stringify({ at: ADVISOR_AB_EPOCH + 5, advisor_note: payload, role: 'builder' }))
  }
  writeFileSync(join(runDir, 'journal.jsonl'), lines.length ? `${lines.join('\n')}\n` : '')
  for (const [id, envelope] of Object.entries(spec.envelopes || {})) {
    writeFileSync(join(returns, `${id}.reviewer.json`), typeof envelope === 'string' ? envelope : JSON.stringify(envelope))
  }
  const adjudicationsPath = join(dir, 'adjudications.json')
  writeFileSync(adjudicationsPath, JSON.stringify({
    schema: 1,
    run_started_at: spec.adjudicationsEpoch ?? ADVISOR_AB_EPOCH,
    adjudications: spec.adjudications || [],
  }))
  return { dir, runDir, adjudicationsPath }
}

function advisorAbEnvelope(id, findings = [], overrides = {}) {
  return {
    assignment_id: id,
    role: 'reviewer',
    status: 'done',
    summary: 'advisor A/B fixture',
    artifacts: [],
    details: { verdict: 'changes-needed', must_fix: findings.length, should_fix: 0, consider: 0, findings },
    ...overrides,
  }
}

function advisorAbFinding(id, overrides = {}) {
  return { id, severity: 'must-fix', location: 'a.mjs:1', summary: 'a concrete finding', ...overrides }
}

function runAdvisorAb(fixtureData, ids) {
  const result = run([
    'advisor-ab',
    '--run-dir', fixtureData.runDir,
    '--run-started-at', String(ADVISOR_AB_EPOCH),
    '--adjudications', fixtureData.adjudicationsPath,
    ...ids,
  ])
  let payload = null
  try { payload = JSON.parse(result.stdout.trim()) } catch { /* refusal has no JSON payload */ }
  return { ...result, payload }
}

const advisorReasons = (payload) => payload.incomplete.map(({ reason }) => reason)
const advisorNote = (overrides = {}) => ({
  run_started_at: ADVISOR_AB_EPOCH,
  tier: 0,
  trigger: 'predicate',
  kind: 'scope-breach',
  target: 'a.mjs',
  target_kind: 'file',
  role: 'builder',
  outcome: 'injected',
  ...overrides,
})

test('advisor-ab counts only the dispatch ids it was given, and a stale envelope from an earlier process is never counted', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10, d2: ADVISOR_AB_EPOCH - 900000 },
    notes: [advisorNote()],
    envelopes: {
      d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]),
      d2: advisorAbEnvelope('d2', [advisorAbFinding('F1'), advisorAbFinding('F2')]),
    },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] }],
  })
  const result = runAdvisorAb(fx, ['d1', 'd2'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.ratifiable, false)
  assert.ok(advisorReasons(result.payload).includes('dispatch-not-attested'))
  assert.equal(result.payload.findings_total, 1)
})

test('advisor-ab never lists the returns directory', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  for (const needle of ['readdir', 'opendir', 'globSync']) assert.equal(source.includes(needle), false, needle)
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10, d9: ADVISOR_AB_EPOCH + 30 },
    notes: [advisorNote()],
    envelopes: {
      d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]),
      d9: advisorAbEnvelope('d9', ['F2', 'F3', 'F4', 'F5', 'F6'].map(advisorAbFinding)),
    },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.findings_total, 1)
  assert.equal(result.payload.ratifiable, true)
})

test('advisor-ab keys findings by run_started_at, dispatch_id and finding_id', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10, d2: ADVISOR_AB_EPOCH + 20 },
    notes: [advisorNote()],
    envelopes: {
      d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]),
      d2: advisorAbEnvelope('d2', [advisorAbFinding('F1')]),
    },
    adjudications: [
      { dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] },
      { dispatch_id: 'd2', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] },
    ],
  })
  const result = runAdvisorAb(fx, ['d1', 'd2'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.findings_total, 2)
  assert.equal(new Set(result.payload.findings.map(({ key }) => key)).size, 2)
  assert.equal(advisorReasons(result.payload).includes('duplicate-key'), false)
})

test('the overlap numerator counts distinct findings and can never exceed its denominator', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote(), advisorNote({ target: 'b.mjs' })],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1', 'n2'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.overlap_findings, 1)
  assert.equal(result.payload.findings_total, 1)
  assert.equal(result.payload.overlap_rate, 1)
  assert.ok(result.payload.overlap_findings <= result.payload.findings_total)
})

test('a cited note absent from this epoch\'s journal makes the readout non-ratifiable', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n99'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.ratifiable, false)
  assert.ok(advisorReasons(result.payload).includes('note-not-in-journal'))
  assert.equal(result.payload.overlap_findings, 0)
})

test('a note from a different epoch does not resolve', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote({ run_started_at: ADVISOR_AB_EPOCH - 600000 }), advisorNote({ target: 'b.mjs' })],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n2'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(advisorReasons(result.payload).includes('note-not-in-journal'))
  assert.equal(result.payload.notes.total, 1)
})

test('a suppressed note is reported but never counted as delivered advice', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote({ outcome: 'suppressed' })],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(advisorReasons(result.payload).includes('note-not-injected'))
  assert.equal(result.payload.notes.total, 1)
  assert.equal(result.payload.overlap_findings, 0)
})

test('a skipped adjudication renders the readout incomplete', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'skipped', note_refs: [] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.skipped, 1)
  assert.ok(advisorReasons(result.payload).includes('skipped-finding'))
})

test('two malformed adjudications for different findings in one dispatch are distinguishable', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1'), advisorAbFinding('F2')]) },
    adjudications: [
      { dispatch_id: 'd1', finding_id: 'F1', verdict: 'not-a-verdict', note_refs: [] },
      { dispatch_id: 'd1', finding_id: 'F2', verdict: 'overlap', note_refs: ['bogus'] },
    ],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  const malformed = result.payload.incomplete.filter(({ reason }) => reason === 'adjudication-malformed')
  assert.equal(malformed.length, 2)
  const details = malformed.map(({ detail }) => detail)
  assert.deepEqual(details, ['dispatch d1 finding F1', 'dispatch d1 finding F2'])
  assert.equal(result.payload.ratifiable, false)
})

test('a malformed adjudication with no usable finding id still refuses, and says so', () => {
  const missingId = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', verdict: 'not-a-verdict', note_refs: [] }],
  })
  const missingIdResult = runAdvisorAb(missingId, ['d1'])
  assert.equal(missingIdResult.status, 0, missingIdResult.stderr)
  const missingIdMalformed = missingIdResult.payload.incomplete.filter(({ reason }) => reason === 'adjudication-malformed')
  assert.equal(missingIdMalformed.length, 1)
  assert.equal(missingIdMalformed[0].detail, 'dispatch d1 finding <none>')
  assert.equal(missingIdResult.payload.ratifiable, false)

  const unusableId = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 42, verdict: 'not-a-verdict', note_refs: [] }],
  })
  const unusableIdResult = runAdvisorAb(unusableId, ['d1'])
  assert.equal(unusableIdResult.status, 0, unusableIdResult.stderr)
  const unusableIdMalformed = unusableIdResult.payload.incomplete.filter(({ reason }) => reason === 'adjudication-malformed')
  assert.equal(unusableIdMalformed.length, 1)
  assert.equal(unusableIdMalformed[0].detail, 'dispatch d1 finding <none>')
  assert.equal(unusableIdResult.payload.ratifiable, false)
})

test('a richer malformed detail changes no other incomplete detail, reason or count', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10, d9: ADVISOR_AB_EPOCH + 20 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]) },
    adjudications: [
      { dispatch_id: 'd1', finding_id: 'F1', verdict: 'skipped', note_refs: [] },
      { dispatch_id: 'd9', finding_id: 'F9', verdict: 'no-overlap', note_refs: [] },
      null,
    ],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.payload.incomplete, [
    { reason: 'skipped-finding', detail: `${ADVISOR_AB_EPOCH}|d1|F1` },
    { reason: 'adjudication-unknown-dispatch', detail: 'dispatch d9' },
    { reason: 'adjudication-malformed', detail: 'adjudication entry' },
  ])
  assert.equal(result.payload.skipped, 1)
  assert.equal(result.payload.findings_total, 1)
  assert.equal(result.payload.overlap_findings, 0)
  assert.equal(result.payload.unadjudicated, 0)
  assert.deepEqual(result.payload.duplicate_keys, [])
  assert.deepEqual(result.payload.malformed, [])
})

test('an unadjudicated finding renders the readout incomplete', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1'), advisorAbFinding('F2')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.unadjudicated, 1)
  assert.ok(advisorReasons(result.payload).includes('unadjudicated-finding'))
})

test('a duplicate finding key renders the readout incomplete', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1'), advisorAbFinding('F1')]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(advisorReasons(result.payload).includes('duplicate-key'))
  assert.equal(result.payload.findings_total, 1)
})

test('a malformed selected finding renders the readout incomplete', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', [advisorAbFinding('F1'), { severity: 'must-fix', location: 'a.mjs:2' }]) },
    adjudications: [{ dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] }],
  })
  const result = runAdvisorAb(fx, ['d1'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(advisorReasons(result.payload).includes('finding-malformed'))
})

test('a complete readout is ratifiable and reports the tier shares', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10, d2: ADVISOR_AB_EPOCH + 20 },
    notes: [advisorNote(), advisorNote({ tier: 1, kind: 'tier1-finding' })],
    envelopes: {
      d1: advisorAbEnvelope('d1', [advisorAbFinding('F1')]),
      d2: advisorAbEnvelope('d2', [advisorAbFinding('F1')]),
    },
    adjudications: [
      { dispatch_id: 'd1', finding_id: 'F1', verdict: 'overlap', note_refs: ['n1'] },
      { dispatch_id: 'd2', finding_id: 'F1', verdict: 'no-overlap', note_refs: [] },
    ],
  })
  const result = runAdvisorAb(fx, ['d1', 'd2'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.payload.ratifiable, true)
  assert.deepEqual(result.payload.incomplete, [])
  assert.deepEqual(result.payload.notes.injected_by_tier, { tier0: 1, tier1: 1, other: 0 })
  assert.equal(result.payload.notes.tier0_share, 0.5)
  assert.equal(result.payload.notes.tier1_share, 0.5)
  assert.equal(result.payload.at_floor, false)
  assert.equal(result.payload.dispatch_floor, 12)
})

test('a missing, unreadable, mis-roled or mis-ided envelope each render the readout incomplete', () => {
  const cases = [
    ['envelope-missing', advisorAbFixture({ attest: { d1: ADVISOR_AB_EPOCH + 10 }, notes: [advisorNote()] })],
    ['envelope-unreadable', advisorAbFixture({ attest: { d1: ADVISOR_AB_EPOCH + 10 }, notes: [advisorNote()], envelopes: { d1: '{' } })],
    ['envelope-role-mismatch', advisorAbFixture({ attest: { d1: ADVISOR_AB_EPOCH + 10 }, notes: [advisorNote()], envelopes: { d1: advisorAbEnvelope('d1', [], { role: 'builder' }) } })],
    ['dispatch-id-mismatch', advisorAbFixture({ attest: { d1: ADVISOR_AB_EPOCH + 10 }, notes: [advisorNote()], envelopes: { d1: advisorAbEnvelope('other') } })],
  ]
  for (const [reason, fx] of cases) {
    const result = runAdvisorAb(fx, ['d1'])
    assert.equal(result.status, 0, `${reason}: ${result.stderr}`)
    assert.ok(advisorReasons(result.payload).includes(reason), `${reason}: ${JSON.stringify(result.payload)}`)
    assert.equal(result.payload.findings_total, 0)
  }
})

test('advisor-ab refuses rather than guessing: no dispatch ids, a bad epoch, a duplicate id, a mismatched adjudication epoch, a missing journal', () => {
  const base = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', []) },
    adjudications: [],
  })
  const noIds = run([
    'advisor-ab', '--run-dir', base.runDir, '--run-started-at', String(ADVISOR_AB_EPOCH), '--adjudications', base.adjudicationsPath,
  ])
  assert.equal(noIds.status, 2)
  assert.match(noIds.stderr, /requires at least one review-dispatch id/)
  const badEpoch = run([
    'advisor-ab', '--run-dir', base.runDir, '--run-started-at', 'not-an-epoch', '--adjudications', base.adjudicationsPath, 'd1',
  ])
  assert.equal(badEpoch.status, 2)
  assert.match(badEpoch.stderr, /--run-started-at/)
  const duplicate = run([
    'advisor-ab', '--run-dir', base.runDir, '--run-started-at', String(ADVISOR_AB_EPOCH), '--adjudications', base.adjudicationsPath, 'd1', 'd1',
  ])
  assert.equal(duplicate.status, 2)
  assert.match(duplicate.stderr, /appear only once/)
  const mismatched = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', []) },
    adjudicationsEpoch: ADVISOR_AB_EPOCH + 1,
  })
  const mismatch = runAdvisorAb(mismatched, ['d1'])
  assert.equal(mismatch.status, 2)
  assert.match(mismatch.stderr, /run_started_at disagrees/)
  rmSync(join(base.runDir, 'journal.jsonl'))
  const missingJournal = runAdvisorAb(base, ['d1'])
  assert.equal(missingJournal.status, 2)
  assert.match(missingJournal.stderr, /journal\.jsonl is missing or unreadable/)
})

test('advisor-ab needs no database', () => {
  const fx = advisorAbFixture({
    attest: { d1: ADVISOR_AB_EPOCH + 10 },
    notes: [advisorNote()],
    envelopes: { d1: advisorAbEnvelope('d1', []) },
  })
  const dbPath = join(fx.dir, 'never-created', 'ledger.db')
  const result = spawnSync(process.execPath, [
    SCRIPT, 'advisor-ab', '--run-dir', fx.runDir, '--run-started-at', String(ADVISOR_AB_EPOCH), '--adjudications', fx.adjudicationsPath, 'd1',
  ], { encoding: 'utf8', env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath } })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotThrow(() => JSON.parse(result.stdout))
  assert.equal(existsSync(dbPath), false)
})

test('ADVISOR_AB_INCOMPLETE_REASONS is the exact frozen vocabulary', () => {
  assert.deepEqual([...ADVISOR_AB_INCOMPLETE_REASONS], [
    'envelope-missing', 'envelope-unreadable', 'envelope-role-mismatch',
    'dispatch-id-mismatch', 'dispatch-not-attested', 'findings-absent',
    'finding-malformed', 'duplicate-key', 'unadjudicated-finding',
    'skipped-finding', 'note-not-in-journal', 'note-not-injected',
    'adjudication-malformed', 'adjudication-unknown-dispatch',
    'adjudication-unknown-finding', 'duplicate-adjudication',
    'numerator-exceeds-denominator',
  ])
  assert.equal(Object.isFrozen(ADVISOR_AB_INCOMPLETE_REASONS), true)
})
