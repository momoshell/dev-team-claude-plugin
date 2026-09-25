import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync, readdirSync, statSync,
} from 'node:fs'

import { join } from 'node:path'

import { spawnSync, spawn } from 'node:child_process'

import { ROOT, scratchDir } from './helpers.mjs'

import {
  openLedger, replayJsonl, isoMs, TABLES, PATH_DEPENDENT_TABLES, MIGRATIONS, applyMigrations, DRIVER_GONE_THRESHOLD_MS, DRIVER_STATES, RUN_OBSERVATION_SOURCES, RUN_OBSERVATION_COLUMNS, RUN_OBSERVATION_WRITE_VERB, SESSION_STATUSES, SESSION_OUTCOMES, SEAT_VALUE_SOURCES, TERMINAL_ACTORS, ESCALATION_CAUSE_UNCLASSIFIED, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError, MODIFIER_KINDS, INTAKE_DISPATCH_OUTCOMES, SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, CELL_FAILURE_ATTRIBUTIONS, RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage, REQUEST_MAX_CHARS, USAGE_ABSENT_CAUSES, usageAbsentCause, AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS, CELL_RATE_FLOOR, SCREENER_PROPOSAL_OUTCOMES, CELL_PRICE_UNITS, REVIEW_VERDICTS, PHASE_SLOT_WAIT_KINDS, PHASE_SLOT_WAIT_DEPTH_ABSENT, PHASE_SLOT_WAIT_ABSENT, NARRATION_OUTCOMES, EVAL_ENVELOPE_STATUSES, EVAL_ABSENT_REASONS, EVAL_PAYLOAD_KEYS, SEAT_REASK_EVENTS, ingestJournal, ingestExternalFenceRegister, JOURNAL_FACT_KEYS, JOURNAL_FACT_EVENTS, PLANNER_SYMBOLS_ARMS, PLANNER_SYMBOLS_SAMPLE_FLOOR, bootstrapPercentile, chunkProgress, upsertChunkRun, CHUNK_PROGRESS_SQL,
} from '../scripts/factory/ledger.mjs'

import { FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, VARIANT_NAMES, SUITE_SLOT_PHASE_NAMES, anchorAbsentWhy, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS } from '../crew/drive.mjs'

import { emitAdapter, SEAT_DIED_STAGE, SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS } from '../crew/seat-io.mjs'

import { modelString as piModelString } from '../crew/adapters/adapter-pi.mjs'

import { _resetNoticeGuardsForTest, openRun, parseProposalBrief } from '../scripts/factory/emit.mjs'

import { loadDurableEscalationRecord, proposalFromResponse, proposalPrompt, triageEscalation } from '../scripts/factory/escalation-triage.mjs'

import { bootTieredRun } from './factory-ledger.test.mjs'

import { NONCE_PREFIX, SCRIPT, require, SQLITE_OK, SKIP, bootBriefRun, fixture, paneReviewRun, trackChild, nextDir, run, openTestLedger, openB499Ledger, seedCellUsage, makeUnenforcedSeatIndexDb, exerciseEveryWriter, seedTaskAgentSession, MARKER_ADW, seedAllWritersWithMarker, MARKER_PLAIN, MARKER_NONCE_ONLY, CALIBRATED_RENDEZVOUS_DELAY_MS, CALIBRATED_RENDEZVOUS_DELAYS_MS, resolveRendezvousDelayMs, runConcurrentEmitterTrial, RUNSET_SINCE, RUNSET_UNTIL, seedRun, seedConfigurationRun, seedConfigurationSeat, EXECUTION_AXIS_BOOT_CONFIGURATION, executionAxisState, writeExecutionAxisCrew, writeExecutionAxisJournal, executionAxisRuntime, executionAxisRow, readerFixture, ADVISOR_AB_EPOCH, advisorAbFixture, advisorAbEnvelope, advisorAbFinding, runAdvisorAb, advisorReasons, advisorNote, SANDBOX_LEDGER_URL, SANDBOX_DEFAULT_RESOLVER, runSandboxChild, B381_PROVIDER_FAILURE_LINE, B395_SLOT_WAIT_GATE_LINE, B395_SLOT_WAIT_WARM_LINE, B395_SLOT_WAIT_COLD_LINE, B395_OLD_CORPUS_LINES, B381_PLAN_SCOPE_LINE, B381_TIMEOUT_REASK_LINE, B381_RPC_EXIT_LINE, B381_PLAN_ADOPTION_LINE, B381_EXTERNAL_REGISTER, ingestJournalLine, journalFactsCli, measuredJournalFactsDb, assertMeasuredAndAbsent, writeTurnsCorpusJournal, turnsCorpusPayload, builderTurnRole, holdoutLedger, addHoldoutLane, holdoutRows, TRIAGE_MODEL, makeTriageFixture, triageLedger, triageResponse } from './factory-ledger.test.mjs'




test('R5 a seat-death-reask producer event ingests into seat_reasks', () => {
  assert.equal(SEAT_RETRY_EVENTS[SEAT_DIED_STAGE], 'seat-death-reask')
  assert.ok(SEAT_REASK_EVENTS.includes(SEAT_RETRY_EVENTS[SEAT_DIED_STAGE]))
  assert.equal(JOURNAL_FACT_EVENTS[SEAT_RETRY_EVENTS[SEAT_DIED_STAGE]], 'recordSeatReask')
  const adwId = 'r5-seat-death'
  const source = {
    at: '2026-09-08T00:00:00.000Z', event: SEAT_RETRY_EVENTS[SEAT_DIED_STAGE],
    role: 'reviewer', id: 'd5', cause: SEAT_DIED_STAGE, outcome: 'recovered',
    spent_ms: 10, ceiling_s: 30, from_run_id: 'run-old', to_run_id: 'run-new',
  }
  const { ledger, result, dbPath } = ingestJournalLine(JSON.stringify(source), adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('seat_reasks')[0] }, {
      adw_id: adwId, event: 'seat-death-reask', role: 'reviewer', dispatch_id: 'd5', cause: 'seat-died',
      outcome: 'recovered', spent_ms: 10, ceiling_s: 30, from_run_id: 'run-old', to_run_id: 'run-new',
      at_ms: Date.parse(source.at), created_at: isoMs(Date.parse(source.at)),
    })
  } finally { ledger.close() }
  assert.equal(journalFactsCli(dbPath).seat_reasks.count, 1)
})

test('path-dependent ledger table labels are frozen and cover their two tables', () => {
  assert.equal(Object.isFrozen(PATH_DEPENDENT_TABLES), true)
  assert.deepEqual(Object.keys(PATH_DEPENDENT_TABLES).sort(), ['run_links', 'run_observations'])
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
test('typed endSession fields round-trip, default to NULL, and validate their enums', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'typed-end', repo_slug: 'r', task_slug: 't' })
  ledger.endSession({
    adw_id: 'typed-end', status: 'aborted', outcome: 'escalated',
    terminal_reason: 'transport', terminal_actor: 'driver',
    ended_at: '2024-01-01T00:00:00.000Z',
  })
  const typed = ledger.getSession('typed-end')
  assert.equal(typed.status, 'aborted')
  assert.equal(typed.outcome, 'escalated')
  assert.equal(typed.terminal_reason, 'transport')
  assert.equal(typed.terminal_actor, 'driver')

  ledger.startSession({ adw_id: 'typed-null', repo_slug: 'r', task_slug: 't' })
  ledger.endSession({ adw_id: 'typed-null', status: 'ok', ended_at: '2024-01-01T00:00:00.000Z' })
  const omitted = ledger.getSession('typed-null')
  assert.equal(omitted.status, 'ok')
  assert.equal(omitted.outcome, null)
  assert.equal(omitted.terminal_reason, null)
  assert.equal(omitted.terminal_actor, null)

  assert.throws(
    () => ledger.endSession({ adw_id: 'typed-end', status: 'ok', outcome: 'not-an-outcome' }),
    (err) => err instanceof LedgerUsageError && /field 'outcome'/.test(err.message),
  )
  assert.throws(
    () => ledger.endSession({ adw_id: 'typed-end', status: 'ok', terminal_actor: 'not-an-actor' }),
    (err) => err instanceof LedgerUsageError && /field 'terminal_actor'/.test(err.message),
  )
  assert.deepEqual([...SESSION_OUTCOMES], ['success', 'escalated', 'aborted', 'failed'])
  assert.deepEqual([...TERMINAL_ACTORS], ['driver', 'lead', 'operator', 'finalizer'])
})
test('new escalation causes round-trip through sessions and escalations', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    const cases = [
      { cause: 'seat-timeout', actor: 'driver', ended_at: '2024-01-02T00:00:00.000Z' },
      { cause: 'seat-aborted', actor: 'driver', ended_at: '2024-01-02T00:00:01.000Z' },
      { cause: 'plan-rounds-exhausted', actor: 'lead', ended_at: '2024-01-02T00:00:02.000Z' },
    ]
    for (const { cause, actor, ended_at } of cases) {
      const adw_id = `new-cause-${cause}`
      ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id, started_at: '2024-01-01T00:00:00.000Z' })
      ledger.endSession({ adw_id, status: 'aborted', outcome: 'escalated', terminal_reason: cause, terminal_actor: actor, ended_at })
      const row = ledger.getSession(adw_id)
      assert.equal(row.terminal_reason, cause)
      assert.equal(row.terminal_actor, actor)
      const grouped = ledger.escalations({ since: '2024-01-01T00:00:00.000Z' })
      assert.ok(grouped.some((entry) => entry.cause === cause && entry.actor === actor && entry.count === 1))
    }
  } finally { ledger.close() }
})
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
test('T2: an out-of-range epoch is refused by isoMs and a writer', { skip: SKIP }, () => {
  assert.throws(() => isoMs(1790000000000000), LedgerUsageError)
  const ledger = openTestLedger()
  try {
    assert.throws(
      () => ledger.recordCellFailure({ adw_id: 'range', role: 'builder', kind: 'timeout', created_at: 1790000000000000 }),
      LedgerUsageError,
    )
  } finally { ledger.close() }
})
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
test('AC-4: an earlier cell_failures schema gains attribution without backfilling existing rows', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'mig-cell-prefix.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE cell_failures (
    id INTEGER PRIMARY KEY, adw_id TEXT, task_slug TEXT, phase_id INTEGER,
    dispatch_id TEXT, role TEXT, agent TEXT, provider TEXT, model_id TEXT,
    model TEXT, effort TEXT, transport TEXT, kind TEXT, stage TEXT,
    detail TEXT, created_at TEXT
  )`)
  db.prepare('INSERT INTO cell_failures (role, kind, created_at) VALUES (?, ?, ?)')
    .run('builder', 'timeout', '2024-01-01T00:00:00.000Z')
  applyMigrations(db)
  const columns = db.prepare('PRAGMA table_info(cell_failures)').all().map((row) => row.name)
  assert.ok(columns.includes('attribution'))
  assert.equal(db.prepare('SELECT attribution FROM cell_failures').get().attribution, null)
  db.close()
})
test('T12: rows predating a unique index remain readable and drift stays measurable', { skip: SKIP }, () => {
  const { dbPath, jsonlPath } = makeUnenforcedSeatIndexDb()
  const ledger = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  try {
    const drift = ledger.jsonlDrift()
    assert.equal(ledger.degraded, false)
    assert.equal(drift.measured, true)
    assert.equal(ledger.dumpTable('seat_teardowns').length, 2)
  } finally { ledger.close() }
})
test('T13: stats names a unique index skipped for pre-existing duplicate rows', { skip: SKIP }, () => {
  const { dbPath, jsonlPath } = makeUnenforcedSeatIndexDb()
  const ledger = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  try {
    const names = ledger.stats().unenforced_unique_indexes
    assert.ok(names.includes('seat_teardowns_adw_id_role_created_at_uq'))
  } finally { ledger.close() }
})
test('T14: every migration prefix upgrades to the complete current column set', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  for (let k = 0; k <= MIGRATIONS.length; k += 1) {
    const db = new DatabaseSync(join(nextDir(), `prefix-${k}.db`))
    try {
      assert.doesNotThrow(() => applyMigrations(db, MIGRATIONS.slice(0, k)))
      assert.doesNotThrow(() => applyMigrations(db, MIGRATIONS))
      for (const [table, def] of Object.entries(TABLES)) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
        assert.deepEqual(columns, def.columns.map(({ name }) => name), `prefix ${k} table ${table} columns`)
      }
    } finally { db.close() }
  }
})
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
test('run_seats records effective roles, preserves warnings, replays through JSONL, and ignores duplicate roles', { skip: SKIP }, () => {
  const source = openTestLedger()
  const target = openTestLedger()
  const seat = (role, over = {}) => ({
    adw_id: 'seat-roundtrip', role, agent: 'claude', provider: 'anthropic',
    model_id: 'claude-sonnet', model: 'sonnet', effort: 'high', transport: 'pane',
    source: 'roster', policy_state: 'passed', warnings: [],
    created_at: '2024-01-01T00:00:00.000Z', ...over,
  })
  try {
    source.recordRunSeat(seat('planner', { warnings: ['vendor-diversity'] }))
    source.recordRunSeat(seat('builder', {
      agent: 'codex', provider: 'openai', model_id: 'gpt-5', model: 'gpt5', effort: 'medium',
      transport: 'headless-rpc', source: 'operator_override', policy_state: 'warned', warnings: [],
    }))
    const result = replayJsonl(source._jsonlPath, target)
    assert.deepEqual(result, { applied: 2, skipped: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual(target.dumpTable('run_seats'), source.dumpTable('run_seats'))
    assert.equal(JSON.parse(target.dumpTable('run_seats').find((row) => row.role === 'planner').warnings_json)[0], 'vendor-diversity')
    target.recordRunSeat(seat('builder', { agent: 'second-should-be-ignored' }))
    assert.equal(target.dumpTable('run_seats').length, 2)
  } finally { source.close(); target.close() }
})
test('run_seats redacts marker warnings before serializing and replays surviving warnings', { skip: SKIP }, () => {
  const source = openTestLedger()
  const target = openTestLedger()
  const marker = `${NONCE_PREFIX}run-seat-warning`
  const seat = {
    adw_id: 'seat-redaction', role: 'planner', agent: 'claude', provider: 'anthropic',
    model_id: 'claude-sonnet', model: 'sonnet', effort: 'high', transport: 'pane',
    source: 'roster', policy_state: 'passed', warnings: ['keep-me', marker],
    created_at: '2024-01-01T00:00:00.000Z',
  }
  try {
    source.recordRunSeat(seat)
    const sourceRows = source.dumpTable('run_seats')
    assert.equal(sourceRows[0].warnings_json, '["keep-me"]')
    const jsonl = readFileSync(source._jsonlPath, 'utf8')
    assert.doesNotMatch(jsonl, new RegExp(marker))
    assert.deepEqual(replayJsonl(source._jsonlPath, target), {
      applied: 1, skipped: 0, failed: 0, complete: true, first_failure: null,
    })
    assert.deepEqual(target.dumpTable('run_seats'), sourceRows)
  } finally { source.close(); target.close() }
})
test('run_seats accepts only the four closed value sources and refuses unknown provenance without writing', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    assert.equal(Object.isFrozen(SEAT_VALUE_SOURCES), true)
    for (const source of SEAT_VALUE_SOURCES) {
      ledger.recordRunSeat({
        adw_id: 'seat-sources', role: `role-${source}`, agent: 'claude', provider: 'anthropic',
        model_id: 'model', model: 'model', effort: 'high', transport: 'pane', source,
        policy_state: 'passed', warnings: ['warning'], created_at: '2024-01-01T00:00:00.000Z',
      })
    }
    assert.equal(ledger.dumpTable('run_seats').length, 4)
    assert.deepEqual(JSON.parse(ledger.dumpTable('run_seats')[0].warnings_json), ['warning'])
    const bad = 'caller-controlled-seat-source'
    assert.throws(
      () => ledger.recordRunSeat({
        adw_id: 'seat-sources', role: 'bad', agent: 'claude', provider: 'anthropic',
        model_id: 'model', model: 'model', effort: 'high', transport: 'pane', source: bad,
        policy_state: 'passed', warnings: [],
      }),
      (err) => err instanceof LedgerUsageError
        && err.message.includes("field 'source'")
        && err.message.includes('roster|profile_recommendation|operator_override|reseat')
        && !err.message.includes(bad),
    )
    assert.equal(ledger.dumpTable('run_seats').length, 4)
  } finally { ledger.close() }
})
test('T6: replaying one authority twice leaves target row counts unchanged', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.recordSeatTeardown({ adw_id: 't6', role: 'builder', outcome: 'proven', reason: 'exited', created_at: '2024-01-01T00:00:00.000Z' })
  const target = openTestLedger()
  try {
    const first = replayJsonl(source._jsonlPath, target)
    const firstCount = target.dumpTable('seat_teardowns').length
    const second = replayJsonl(source._jsonlPath, target)
    assert.equal(first.complete, true)
    assert.equal(second.complete, true)
    assert.equal(target.dumpTable('seat_teardowns').length, firstCount)
  } finally {
    source.close()
    target.close()
  }
})
test('T7: opening a db retires the old seat teardown index before widening it', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dir = nextDir()
  const dbPath = join(dir, 'retired-index.db')
  const db = new DatabaseSync(dbPath)
  applyMigrations(db)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "seat_teardowns_adw_id_role_uq" ON "seat_teardowns" ("adw_id", "role")')
  db.close()

  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    ledger.recordSeatTeardown({ adw_id: 't7', role: 'builder', outcome: 'proven', created_at: '2024-01-01T00:00:00.000Z' })
    ledger.recordSeatTeardown({ adw_id: 't7', role: 'builder', outcome: 'failed', created_at: '2024-01-01T00:00:01.000Z' })
    assert.equal(ledger.dumpTable('seat_teardowns').length, 2)
  } finally { ledger.close() }
  const probe = new DatabaseSync(dbPath)
  try {
    const names = probe.prepare('PRAGMA index_list("seat_teardowns")').all().map((row) => row.name)
    assert.equal(names.includes('seat_teardowns_adw_id_role_uq'), false)
  } finally { probe.close() }
})
test('T8: replaying a ledger authority into itself preserves its bytes', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.startSession({ adw_id: 't8', repo_slug: 'r', task_slug: 't' })
    ledger.recordEvent({ adw_id: 't8', type: 'log', payload: { level: 'info', message: 'one' } })
    const before = readFileSync(ledger._jsonlPath, 'utf8')
    const result = replayJsonl(ledger._jsonlPath, ledger)
    assert.equal(result.complete, true)
    assert.equal(readFileSync(ledger._jsonlPath, 'utf8'), before)
    assert.equal(ledger.dumpTable('events').length, 1)
  } finally { ledger.close() }
})
test('recordEvent stamps agent boundaries, preserves explicit times, and keeps annotations timeless', { skip: SKIP }, () => {
  const fixedAt = 1700400000123
  const ledger = openTestLedger({ now: () => fixedAt })
  const explicitStart = '2024-01-01T00:00:01.000Z'
  const explicitEnd = '2024-01-01T00:00:02.000Z'
  try {
    ledger.recordEvent({ adw_id: 'event-times', type: 'agent_start', payload: { role: 'builder', dispatch_id: 'd1' } })
    ledger.recordEvent({ adw_id: 'event-times', type: 'agent_end', payload: { role: 'builder', outcome: 'done', dispatch_id: 'd1' } })
    ledger.recordEvent({
      adw_id: 'event-times', type: 'agent_start', started_at: explicitStart, ended_at: explicitEnd,
      payload: { role: 'planner', dispatch_id: 'd2' },
    })
    ledger.recordEvent({
      adw_id: 'event-times', type: 'agent_end', started_at: explicitStart, ended_at: explicitEnd,
      payload: { role: 'planner', outcome: 'done', dispatch_id: 'd2' },
    })
    ledger.recordEvent({ adw_id: 'event-times', type: 'log', payload: { level: 'info', message: 'annotation' } })
    ledger.recordEvent({ adw_id: 'event-times', type: 'decision', payload: { decided: 'accept', why: 'annotation' } })
    ledger.recordEvent({ adw_id: 'event-times', type: 'tool_call', payload: { tool: 'test', ok: true } })

    const rows = ledger.dumpTable('events')
    const row = (type, dispatch_id = null) => rows.find((candidate) => (
      candidate.type === type && (dispatch_id === null || JSON.parse(candidate.payload_json).dispatch_id === dispatch_id)
    ))
    assert.deepEqual(
      { started_at: row('agent_start', 'd1').started_at, ended_at: row('agent_start', 'd1').ended_at },
      { started_at: new Date(fixedAt).toISOString(), ended_at: null },
    )
    assert.deepEqual(
      { started_at: row('agent_end', 'd1').started_at, ended_at: row('agent_end', 'd1').ended_at },
      { started_at: null, ended_at: new Date(fixedAt).toISOString() },
    )
    assert.deepEqual(
      { started_at: row('agent_start', 'd2').started_at, ended_at: row('agent_start', 'd2').ended_at },
      { started_at: explicitStart, ended_at: explicitEnd },
    )
    assert.deepEqual(
      { started_at: row('agent_end', 'd2').started_at, ended_at: row('agent_end', 'd2').ended_at },
      { started_at: explicitStart, ended_at: explicitEnd },
    )
    assert.deepEqual({ started_at: row('log').started_at, ended_at: row('log').ended_at }, { started_at: null, ended_at: null })
    assert.deepEqual({ started_at: row('decision').started_at, ended_at: row('decision').ended_at }, { started_at: null, ended_at: null })
    assert.deepEqual(
      { started_at: row('tool_call').started_at, ended_at: row('tool_call').ended_at },
      { started_at: new Date(fixedAt).toISOString(), ended_at: new Date(fixedAt).toISOString() },
    )
  } finally { ledger.close() }
})

test('agent start and end stamps are ordered for one dispatch', { skip: SKIP }, () => {
  const ledger = openTestLedger({ now: () => 1700400000123 })
  try {
    ledger.recordEvent({ adw_id: 'event-order', type: 'agent_start', payload: { role: 'builder', dispatch_id: 'ordered' } })
    ledger.recordEvent({ adw_id: 'event-order', type: 'agent_end', payload: { role: 'builder', outcome: 'done', dispatch_id: 'ordered' } })
    const rows = ledger.dumpTable('events').map((row) => ({
      type: row.type, dispatch_id: JSON.parse(row.payload_json).dispatch_id, started_at: row.started_at, ended_at: row.ended_at,
    }))
    const start = rows.find((row) => row.type === 'agent_start' && row.dispatch_id === 'ordered')
    const end = rows.find((row) => row.type === 'agent_end' && row.dispatch_id === 'ordered')
    assert.ok(start && end)
    assert.ok(Date.parse(start.started_at) <= Date.parse(end.ended_at))
  } finally { ledger.close() }
})

test('T9: replay counts malformed and failing lines, then applies later good lines', { skip: SKIP }, () => {
  const jsonlPath = join(nextDir(), 'partial-authority.jsonl')
  const line = (kind, args) => JSON.stringify({ v: 1, kind, at: '2024-01-01T00:00:00.000Z', args })
  writeFileSync(jsonlPath, [
    line('startSession', { adw_id: 't9', repo_slug: 'r', task_slug: 't' }),
    line('recordEvent', { adw_id: 't9', type: 'log', payload: { level: 'info', message: 'before' } }),
    line('notAWriter', {}),
    line('recordEvent', { adw_id: 't9', type: 'log', payload: { level: 'info', message: 'between' } }),
    line('recordCellFailure', { adw_id: 't9', role: 'builder', kind: 'not-a-kind' }),
    line('recordEvent', { adw_id: 't9', type: 'log', payload: { level: 'info', message: 'after' } }),
    '{not valid json truncated',
  ].join('\n') + '\n')
  const ledger = openTestLedger()
  try {
    const result = replayJsonl(jsonlPath, ledger)
    assert.equal(result.applied, 4)
    assert.equal(result.failed, 2)
    assert.equal(result.skipped, 1)
    assert.equal(result.complete, false)
    assert.deepEqual(result.first_failure, {
      line: 3,
      reason: 'ledger: replayJsonl: line has an unknown kind — must be one of ' + WRITERS.join('|'),
    })
    const messages = ledger.dumpTable('events').map((row) => JSON.parse(row.payload_json).message).sort()
    assert.deepEqual(messages, ['after', 'before', 'between'])
  } finally { ledger.close() }
})
test('T10: a well-formed authority replays completely without throwing', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({ adw_id: 't10', repo_slug: 'r', task_slug: 't' })
  source.recordEvent({ adw_id: 't10', type: 'log', payload: { level: 'info', message: 'ok' } })
  const lineCount = readFileSync(source._jsonlPath, 'utf8').split('\n').filter(Boolean).length
  const target = openTestLedger()
  try {
    let result = null
    assert.doesNotThrow(() => { result = replayJsonl(source._jsonlPath, target) })
    assert.equal(result.applied, lineCount)
    assert.equal(result.complete, true)
  } finally {
    source.close()
    target.close()
  }
})
test('T11: replay failure reasons never echo a marker-bearing unknown kind', { skip: SKIP }, () => {
  const marker = `${NONCE_PREFIX}replay-kind-marker`
  const jsonlPath = join(nextDir(), 'marker-authority.jsonl')
  const raw = JSON.stringify({ v: 1, kind: marker, at: '2024-01-01T00:00:00.000Z', args: {} })
  writeFileSync(jsonlPath, `${raw}\n`)
  const ledger = openTestLedger()
  try {
    const result = replayJsonl(jsonlPath, ledger)
    assert.equal(result.failed, 1)
    assert.ok(result.first_failure)
    assert.doesNotMatch(result.first_failure.reason, new RegExp(marker))
  } finally { ledger.close() }
})
test('legacy endSession JSONL without outcome replays to three NULL typed fields', { skip: SKIP }, () => {
  const jsonlPath = join(nextDir(), 'legacy-outcome.jsonl')
  writeFileSync(jsonlPath, [
    { v: 1, kind: 'startSession', at: '2024-01-01T00:00:00.000Z', args: { adw_id: 'legacy-outcome', repo_slug: 'r', task_slug: 'legacy' } },
    { v: 1, kind: 'endSession', at: '2024-01-01T00:00:01.000Z', args: { adw_id: 'legacy-outcome', ended_at: '2024-01-01T00:00:01.000Z', status: 'ok' } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
  const ledger = openTestLedger()
  const result = replayJsonl(jsonlPath, ledger)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)
  assert.equal(result.complete, true)
  const row = ledger.getSession('legacy-outcome')
  assert.equal(row.status, 'ok')
  assert.equal(row.outcome, null)
  assert.equal(row.terminal_reason, null)
  assert.equal(row.terminal_actor, null)
})
test('new outcome writers refuse out-of-enum verdicts without echoing the offending value', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const badGate = 'gate-verdict-secret'
  const badReview = 'review-verdict-secret'
  const badAccept = 'accept-outcome-secret'
  const badCell = 'cell-kind-secret'
  const badAttribution = 'cell-attribution-secret'
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
  assert.throws(
    () => ledger.recordCellFailure({ role: 'builder', kind: 'timeout', attribution: badAttribution }),
    (err) => err instanceof LedgerUsageError
      && err.message.includes("field 'attribution'")
      && err.message.includes('cell|host')
      && !err.message.includes(badAttribution),
  )
  for (const attribution of CELL_FAILURE_ATTRIBUTIONS) {
    assert.doesNotThrow(() => ledger.recordCellFailure({
      role: 'builder', kind: 'timeout', attribution,
      created_at: `2024-01-01T00:00:0${attribution === 'cell' ? 1 : 2}.000Z`,
    }))
  }
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
test('eval_cells round-trip through JSONL and expose one bench-keyed reader', { skip: SKIP }, () => {
  const source = openTestLedger()
  const target = openTestLedger()
  const row = {
    bench: 'eval-roundtrip', adw_id: 'eval-adw', role: 'builder', provider: 'anthropic',
    model_id: 'claude-sonnet-5', agent: 'claude', effort: 'medium', production: 1,
    task_sha: 'task-sha', envelope_status: 'received', absent_reason: null,
    asserts_declared: 4, asserts_passed: 3, judge_findings: ['f1', 'f2'],
    billed_input_tokens: 100, billed_output_tokens: 200, billed_cache_read_tokens: 300,
    billed_cache_write_tokens: 400, duration_ms: 500, created_at: '2024-01-01T00:00:00.000Z',
  }
  try {
    source.recordEvalCell(row)
    assert.deepEqual(source.evalCells({ bench: row.bench }).map(({ id, ...cell }) => cell), [{
      ...row, judge_findings: '["f1","f2"]', error_text: null,
    }])
    const replay = replayJsonl(source._jsonlPath, target)
    assert.deepEqual(replay, { applied: 1, skipped: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual(target.dumpTable('eval_cells'), source.dumpTable('eval_cells'))
    assert.equal(WRITERS.filter((writer) => writer === 'recordEvalCell').length, 1)
    assert.equal(WRITER_MIRROR_TABLES.recordEvalCell, 'eval_cells')
  } finally {
    source.close()
    target.close()
  }
})
test('recordEvalCell refuses closed-enum drift and never records asserts for an absent envelope', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const base = {
    bench: 'eval-refusal', role: 'builder', provider: 'anthropic', model_id: 'claude-sonnet-5',
    agent: 'claude', effort: 'medium', envelope_status: 'received',
  }
  const badStatus = 'eval-status-secret'
  const badReason = 'eval-reason-secret'
  try {
    assert.throws(
      () => ledger.recordEvalCell({ ...base, envelope_status: badStatus }),
      (err) => err instanceof LedgerUsageError && !err.message.includes(badStatus),
    )
    assert.throws(
      () => ledger.recordEvalCell({ ...base, absent_reason: badReason }),
      (err) => err instanceof LedgerUsageError && !err.message.includes(badReason),
    )
    assert.throws(
      () => ledger.recordEvalCell({ ...base, envelope_status: 'absent', absent_reason: 'no-envelope', asserts_declared: 0, asserts_passed: 0 }),
      (err) => err instanceof LedgerUsageError && err.message.includes('absent envelope cannot carry measured asserts'),
    )
    assert.deepEqual(ledger.dumpTable('eval_cells'), [])
    assert.deepEqual([...EVAL_ENVELOPE_STATUSES], ['received', 'absent'])
    assert.deepEqual([...EVAL_ABSENT_REASONS], ['no-envelope', 'boot-failed', 'boot-unreadable', 'assignment-failed', 'wait-failed', 'wait-empty', 'seat-runner-failed', 'gate-not-run', 'judge-not-briefed', 'gate-failed', 'judge-failed'])
  } finally { ledger.close() }
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
test('durable log messages are bounded in the mirror and authority', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const marker = '…[truncated]'
  try {
    const messages = {
      huge: 'x'.repeat(5 * 1024 * 1024),
      short: 'short message',
      exact: 'e'.repeat(REQUEST_MAX_CHARS),
      over: 'o'.repeat(REQUEST_MAX_CHARS + 1),
    }
    ledger.startSession({ adw_id: 'f10-log', repo_slug: 'r', task_slug: 't' })
    for (const [level, message] of Object.entries(messages)) {
      ledger.recordEvent({ adw_id: 'f10-log', type: 'log', payload: { level, message } })
    }
    const mirror = Object.fromEntries(ledger.dumpTable('events').map((row) => {
      const payload = JSON.parse(row.payload_json)
      return [payload.level, payload.message]
    }))
    const authority = Object.fromEntries(readFileSync(ledger._jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((line) => line.kind === 'recordEvent')
      .map((line) => [line.args.payload.level, line.args.payload.message]))
    for (const record of [mirror, authority]) {
      assert.equal(record.huge.length, REQUEST_MAX_CHARS)
      assert.equal(record.huge.slice(0, 32), messages.huge.slice(0, 32))
      assert.equal(record.huge.slice(-marker.length), marker)
      assert.equal(record.short, messages.short)
      assert.equal(record.exact, messages.exact)
      assert.equal(record.over.length, REQUEST_MAX_CHARS)
      assert.equal(record.over.slice(0, 32), messages.over.slice(0, 32))
      assert.equal(record.over.slice(-marker.length), marker)
    }
  } finally { ledger.close() }
})
test('recordGateResult bounds string leaves without changing its verbatim structure', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const marker = '…[truncated]'
  try {
    const huge = 'g'.repeat(5 * 1024 * 1024)
    const checks = [
      { item: 'first', ok: true, note: huge },
      { item: 'second', ok: false, note: 'short note' },
    ]
    const violations = [huge, { code: 'short-code', allowed: false }]
    ledger.startSession({ adw_id: 'f10-gate', repo_slug: 'r', task_slug: 't' })
    ledger.recordGateResult({
      adw_id: 'f10-gate', phase_id: null, gate_name: 'gate', attempt: 1, ok: false,
      checks, violations, gate_generation: 1, pristine: false,
    })
    const mirrored = ledger.dumpTable('gate_results')[0]
    const mirroredChecks = JSON.parse(mirrored.checks_json)
    const mirroredViolations = JSON.parse(mirrored.violations_json)
    assert.equal(mirroredChecks.length, checks.length)
    assert.deepEqual(Object.keys(mirroredChecks[0]), Object.keys(checks[0]))
    assert.deepEqual(Object.keys(mirroredChecks[1]), Object.keys(checks[1]))
    assert.equal(mirroredChecks[0].ok, true)
    assert.equal(mirroredChecks[1].ok, false)
    assert.equal(mirroredChecks[1].note, checks[1].note)
    assert.equal(mirroredViolations.length, violations.length)
    assert.deepEqual(Object.keys(mirroredViolations[1]), Object.keys(violations[1]))
    assert.equal(mirroredViolations[1].allowed, false)
    for (const bounded of [mirroredChecks[0].note, mirroredViolations[0]]) {
      assert.equal(bounded.length, REQUEST_MAX_CHARS)
      assert.equal(bounded.slice(0, 32), huge.slice(0, 32))
      assert.equal(bounded.slice(-marker.length), marker)
    }
    const authority = readFileSync(ledger._jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .find((line) => line.kind === 'recordGateResult').args
    assert.deepEqual(authority.checks, mirroredChecks)
    assert.deepEqual(authority.violations, mirroredViolations)
  } finally { ledger.close() }
})
test('jsonlDrift refuses to measure a deleted mirror and names the absence', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    ledger.startSession({ adw_id: 'f9-gone', repo_slug: 'r', task_slug: 't' })
    assert.equal(ledger.jsonlDrift().measured, true)
    unlinkSync(dbPath)
    const gone = ledger.jsonlDrift()
    assert.equal(gone.measured, false)
    assert.equal(gone.drift_total, null)
    assert.equal(gone.unmeasured_reason, 'the mirror file is no longer on disk')
    assert.equal(ledger.stats().degraded, true)
    assert.equal(ledger.stats().degraded_reason, 'mirror_missing')
  } finally { ledger.close() }

  const intact = openTestLedger()
  try {
    intact.startSession({ adw_id: 'f9-intact', repo_slug: 'r', task_slug: 't' })
    assert.equal(intact.jsonlDrift().measured, true)
  } finally { intact.close() }
})
test('session, phase and event writers reject null or blank adw_id while boot refusals remain attributable', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    for (const adw_id of [null, '']) {
      assert.throws(() => ledger.startSession({ adw_id, repo_slug: 'r', task_slug: 't' }), LedgerUsageError)
      assert.throws(() => ledger.startPhase({ adw_id, name: 'phase' }), LedgerUsageError)
      assert.throws(() => ledger.recordEvent({ adw_id, type: 'log', payload: { level: 'info', message: 'event' } }), LedgerUsageError)
    }
    assert.deepEqual(ledger.dumpTable('sessions'), [])
    assert.deepEqual(ledger.dumpTable('phases'), [])
    assert.deepEqual(ledger.dumpTable('events'), [])
    assert.equal(existsSync(ledger._jsonlPath), false)

    ledger.recordCellFailure({ adw_id: null, role: 'planner', kind: 'boot-refusal' })
    const rows = ledger.dumpTable('cell_failures')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].adw_id, null)
    const lines = readFileSync(ledger._jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].args.adw_id, null)
  } finally { ledger.close() }
})
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
test('recordSessionRequest redacted replay does not rewrite the target authority', { skip: SKIP }, () => {
  const forgedJsonl = join(nextDir(), 'forged-request.jsonl')
  writeFileSync(forgedJsonl, `${JSON.stringify({
    v: 1,
    kind: 'recordSessionRequest',
    at: new Date().toISOString(),
    args: { adw_id: MARKER_NONCE_ONLY, request: null, source: null, redacted: true },
  })}\n`)

  const replayed = openTestLedger()
  assert.deepEqual(replayJsonl(forgedJsonl, replayed), {
    applied: 1, skipped: 0, failed: 0, complete: true, first_failure: null,
  })
  assert.equal(existsSync(replayed._jsonlPath), false, 'replay must not create or append the target authority')
  assert.deepEqual(replayed.dumpTable('sessions'), [])
})
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
  const replayed = replayJsonl(jsonlPath, ledger)
  assert.equal(replayed.failed, 1)
  assert.equal(replayed.complete, false)
  assert.ok(replayed.first_failure)
  assert.doesNotMatch(replayed.first_failure.reason, new RegExp(MARKER_NONCE_ONLY))
})
test('AC-14: the FTS5 probe returns a shaped capability readout', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const probe = ledger._probeFts5()
  assert.equal(typeof probe.available, 'boolean')
  const doctorRes = run(['doctor'])
  const payload = JSON.parse(doctorRes.stdout)
  assert.equal(typeof payload.fts5.available, 'boolean')
})
test('S12: replayJsonl counts an unknown kind as a failed line without throwing', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dir = nextDir()
  const jsonlPath = join(dir, 'bad-kind.jsonl')
  writeFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: 'notAWriter', at: new Date().toISOString(), args: {} })}\n`)
  let result = null
  assert.doesNotThrow(() => { result = replayJsonl(jsonlPath, ledger) })
  assert.equal(result.failed, 1)
  assert.equal(result.skipped, 0)
  assert.equal(result.complete, false)
  assert.ok(result.first_failure)
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
test('escalations groups typed outcomes by cause and actor over ended_at half-open windows', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const seed = (adwId, endedAt, outcome = 'escalated', terminalReason = 'transport', terminalActor = 'driver') => {
    ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: adwId, started_at: '2024-01-01T00:00:00.000Z' })
    ledger.endSession({ adw_id: adwId, status: outcome === 'escalated' ? 'aborted' : 'ok', outcome, terminal_reason: terminalReason, terminal_actor: terminalActor, ended_at: endedAt })
  }
  seed('escalation-driver-1', '2024-01-02T00:00:00.000Z')
  seed('escalation-driver-2', '2024-01-02T00:00:01.000Z')
  seed('escalation-lead', '2024-01-02T00:00:02.000Z', 'escalated', 'transport', 'lead')
  seed('escalation-budget', '2024-01-02T00:00:03.000Z', 'escalated', 'budget', 'driver')
  seed('escalation-at-until', '2024-01-02T00:01:00.000Z')
  seed('not-escalated', '2024-01-02T00:00:04.000Z', 'success', null, null)

  const rows = ledger.escalations({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-02T00:01:00.000Z' }).map((row) => ({ ...row }))
  assert.deepEqual(rows, [
    { cause: 'budget', actor: 'driver', count: 1, first_at: '2024-01-02T00:00:03.000Z', last_at: '2024-01-02T00:00:03.000Z' },
    { cause: 'transport', actor: 'driver', count: 2, first_at: '2024-01-02T00:00:00.000Z', last_at: '2024-01-02T00:00:01.000Z' },
    { cause: 'transport', actor: 'lead', count: 1, first_at: '2024-01-02T00:00:02.000Z', last_at: '2024-01-02T00:00:02.000Z' },
  ])
  assert.deepEqual(ledger.escalations({ since: '2024-01-02T00:01:00.000Z' }).map((row) => ({ ...row })), [
    { cause: 'transport', actor: 'driver', count: 1, first_at: '2024-01-02T00:01:00.000Z', last_at: '2024-01-02T00:01:00.000Z' },
  ])
})
test('endedRuns groups every ended outcome over an ended_at half-open window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const seed = (adwId, endedAt, outcome, terminalReason = null, terminalActor = null) => {
    ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: adwId, started_at: '2024-01-01T00:00:00.000Z' })
    const status = outcome === 'escalated' || outcome === 'aborted' ? 'aborted' : outcome === 'failed' ? 'fail' : 'ok'
    ledger.endSession({ adw_id: adwId, status, outcome, terminal_reason: terminalReason, terminal_actor: terminalActor, ended_at: endedAt })
  }
  seed('ended-success', '2024-01-02T00:00:00.000Z', 'success')
  seed('ended-escalated', '2024-01-02T00:00:01.000Z', 'escalated', 'transport', 'driver')
  seed('ended-failed', '2024-01-02T00:00:02.000Z', 'failed')
  seed('ended-untyped', '2024-01-02T00:00:03.000Z', null)
  seed('ended-at-until', '2024-01-02T00:01:00.000Z', 'success')

  try {
    const rows = ledger.endedRuns({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-02T00:01:00.000Z' }).map((row) => ({ ...row }))
    assert.deepEqual(rows, [
      { outcome: null, count: 1, first_at: '2024-01-02T00:00:03.000Z', last_at: '2024-01-02T00:00:03.000Z' },
      { outcome: 'escalated', count: 1, first_at: '2024-01-02T00:00:01.000Z', last_at: '2024-01-02T00:00:01.000Z' },
      { outcome: 'failed', count: 1, first_at: '2024-01-02T00:00:02.000Z', last_at: '2024-01-02T00:00:02.000Z' },
      { outcome: 'success', count: 1, first_at: '2024-01-02T00:00:00.000Z', last_at: '2024-01-02T00:00:00.000Z' },
    ])
  } finally { ledger.close() }
})
test('escalationWindow takes its numerator and denominator from one SQLite snapshot', { skip: SKIP }, () => {
  const writer = openTestLedger()
  const dbPath = writer._dbPath
  const since = '2024-01-02T00:00:00.000Z'
  const until = '2024-01-02T00:01:00.000Z'
  writer.startSession({ adw_id: 'snapshot-success', repo_slug: 'r', task_slug: 'snapshot-success', started_at: '2024-01-01T00:00:00.000Z' })
  writer.endSession({ adw_id: 'snapshot-success', status: 'ok', outcome: 'success', ended_at: '2024-01-02T00:00:00.000Z' })
  writer.startSession({ adw_id: 'snapshot-late-escalation', repo_slug: 'r', task_slug: 'snapshot-late-escalation', started_at: '2024-01-01T00:00:00.000Z' })

  const reader = openLedger({ dbPath, readOnly: true, stderr: { write: () => {} } })
  const conn = reader.readConnection()
  const prepare = conn.prepare.bind(conn)
  let snapshotStatements = 0
  let lateEscalationEnded = false
  conn.prepare = (sql) => {
    const statement = prepare(sql)
    if (!sql.includes('WITH window_sessions AS')) return statement
    snapshotStatements += 1
    return new Proxy(statement, {
      get(target, property) {
        if (property === 'all') {
          return (...args) => {
            const rows = target.all(...args)
            // This commit is exactly after the only reader statement consumed
            // its snapshot. Two independent statements would put the new run
            // in the denominator but leave it out of the numerator.
            if (!lateEscalationEnded) {
              lateEscalationEnded = true
              writer.endSession({
                adw_id: 'snapshot-late-escalation', status: 'aborted', outcome: 'escalated',
                terminal_reason: 'transport', terminal_actor: 'driver', ended_at: '2024-01-02T00:00:01.000Z',
              })
            }
            return rows
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  try {
    const snapshot = reader.escalationWindow({ since, until })
    const total = (rows) => rows.reduce((n, row) => n + Number(row.count ?? 0), 0)
    assert.equal(snapshotStatements, 1, 'the CLI reader must issue one aggregate statement')
    assert.equal(lateEscalationEnded, true)
    assert.equal(total(snapshot.rows), 0)
    assert.equal(total(snapshot.endedRows), 1)
    assert.equal(total(writer.escalations({ since, until })), 1)
    assert.equal(total(writer.endedRuns({ since, until })), 2)
  } finally {
    reader.close()
    writer.close()
  }
})
test('tableNames reads live schema names', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try { assert.ok(ledger.tableNames().includes('sessions')) } finally { ledger.close() }
})
test('columnNames reads live columns and validates its table', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try {
    assert.deepEqual(ledger.columnNames('sessions'), TABLES.sessions.columns.map(({ name }) => name))
    assert.throws(() => ledger.columnNames('not-a-table'), LedgerUsageError)
  } finally { ledger.close() }
})
test('sessionsFiltered returns filtered sessions in descending start order', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.sessionsFiltered({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' }).map((row) => row.adw_id), [run, 'reader-old'])
    assert.deepEqual(ledger.sessionsFiltered({ status: 'fail' }).map((row) => row.adw_id), ['reader-old'])
  } finally { ledger.close() }
})
test('runsStartedWithin honors its half-open start window and ordering', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    const rows = ledger.runsStartedWithin({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' })
    assert.deepEqual(rows.map((row) => row.adw_id), [run])
    assert.equal(rows.some((row) => row.adw_id === 'reader-until'), false)
    assert.deepEqual(ledger.runsStartedWithin({ since: '2024-01-02T00:00:00.000Z' }).map((row) => row.adw_id), ['reader-until', run])
  } finally { ledger.close() }
})
test('phasesFor returns only requested run phases in sequence order', { skip: SKIP }, () => {
  const { ledger, run, phaseId } = readerFixture()
  try {
    const rows = ledger.phasesFor([run, 'missing-run'])
    assert.deepEqual(rows.map(({ adw_id, id, name }) => ({ adw_id, id, name })), [{ adw_id: run, id: phaseId, name: 'plan' }])
    assert.deepEqual(ledger.phasesFor([]), [])
  } finally { ledger.close() }
})
test('agentEventsFor returns the agent event projection in id order', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    const rows = ledger.agentEventsFor([run])
    assert.deepEqual(rows.map(({ type, adw_id }) => ({ type, adw_id })), [
      { type: 'agent_start', adw_id: run }, { type: 'agent_end', adw_id: run },
    ])
  } finally { ledger.close() }
})
test('agentSessionsFor returns requested usage sessions and billed totals', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.agentSessionsFor([run]).map(({ adw_id, dispatch_id, billed_input_tokens, billed_output_tokens }) => ({ adw_id, dispatch_id, billed_input_tokens, billed_output_tokens })), [
      { adw_id: run, dispatch_id: 'reader-dispatch', billed_input_tokens: 11, billed_output_tokens: 12 },
    ])
  } finally { ledger.close() }
})
test('gateDiscriminationsFor returns requested generations in order', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.gateDiscriminationsFor([run]).map(({ adw_id, gate_generation, verdict }) => ({ adw_id, gate_generation, verdict })), [{ adw_id: run, gate_generation: 2, verdict: 'proven' }])
  } finally { ledger.close() }
})
test('gateResultsFor returns requested attempts in generation order', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.gateResultsFor([run]).map(({ adw_id, gate_name, attempt }) => ({ adw_id, gate_name, attempt })), [{ adw_id: run, gate_name: 'reader-gate', attempt: 1 }])
  } finally { ledger.close() }
})
test('reviewOutcomesFor returns requested review rows in created order', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.reviewOutcomesFor([run]).map(({ adw_id, dispatch_id, verdict }) => ({ adw_id, dispatch_id, verdict })), [{ adw_id: run, dispatch_id: 'reader-review', verdict: 'pass' }])
  } finally { ledger.close() }
})
test('acceptDecisionsFor returns requested decisions in created order', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.acceptDecisionsFor([run]).map(({ adw_id, where_at, outcome }) => ({ adw_id, where_at, outcome })), [{ adw_id: run, where_at: 'reader-review', outcome: 'accepted' }])
  } finally { ledger.close() }
})
test('supportsJson1 measures the JSON extraction capability', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try { assert.equal(ledger.supportsJson1(), true) } finally { ledger.close() }
})
test('eventsPage applies type, role, after and limit filters', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    const rows = ledger.eventsPage({ adw_id: run, after: 0, limit: 1, type: 'agent_start', role: 'builder' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].type, 'agent_start')
    assert.equal(JSON.parse(rows[0].payload_json).role, 'builder')
    assert.deepEqual(ledger.eventsPage({ adw_id: run, after: rows[0].id, limit: 1, type: 'agent_start' }), [])
  } finally { ledger.close() }
})
test('maxEventId returns the final event id and null for an unknown run', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    const rows = ledger.eventsPage({ adw_id: run })
    assert.equal(ledger.maxEventId(run), rows.at(-1).id)
    assert.equal(ledger.maxEventId('missing-run'), null)
  } finally { ledger.close() }
})
test('cellFailureRowsFor returns raw failures for requested runs', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.cellFailureRowsFor([run]).map(({ adw_id, kind, detail }) => ({ adw_id, kind, detail })), [{ adw_id: run, kind: 'seat-died', detail: 'reader-detail' }])
  } finally { ledger.close() }
})
test('unattributableCellFailures returns run-less and unknown-run facts in order', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try {
    assert.deepEqual(ledger.unattributableCellFailures({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' }).map(({ adw_id, kind }) => ({ adw_id, kind })), [
      { adw_id: null, kind: 'boot-refusal' }, { adw_id: 'reader-missing-run', kind: 'timeout' },
    ])
  } finally { ledger.close() }
})
test('seatTeardownRowsFor returns raw teardown rows for requested runs', { skip: SKIP }, () => {
  const { ledger, run } = readerFixture()
  try {
    assert.deepEqual(ledger.seatTeardownRowsFor([run]).map(({ adw_id, role, outcome }) => ({ adw_id, role, outcome })), [{ adw_id: run, role: 'builder', outcome: 'proven' }])
  } finally { ledger.close() }
})
test('intakePicks returns only picked rows in descending creation order', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try {
    assert.deepEqual(ledger.intakePicks({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' }).map(({ picked_issue }) => picked_issue), [11, 12])
  } finally { ledger.close() }
})
test('intakeSweepTotals returns the unwindowed aggregate row', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try {
    const row = ledger.intakeSweepTotals()
    assert.deepEqual({ sweeps: row.sweeps, first_at: row.first_at, last_at: row.last_at }, { sweeps: 3, first_at: '2024-01-01T00:00:00.000Z', last_at: '2024-01-03T00:00:00.000Z' })
  } finally { ledger.close() }
})
test('intakeCandidateRefusals returns the latest refusal facts by issue', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try {
    assert.deepEqual(ledger.intakeCandidateRefusals({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' }).map(({ issue, reason, detail, refusals }) => ({ issue, reason, detail, refusals })), [{ issue: 13, reason: 'stop-switch', detail: 'reader-refusal', refusals: 1 }])
  } finally { ledger.close() }
})
test('intakeCandidatePicks returns grouped picked issues in issue order', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try {
    assert.deepEqual(ledger.intakeCandidatePicks({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' }).map(({ issue, picks }) => ({ issue, picks })), [{ issue: 11, picks: 1 }, { issue: 12, picks: 1 }])
  } finally { ledger.close() }
})
test('agentSessionTokenTotals returns all four running token totals in its window', { skip: SKIP }, () => {
  const { ledger } = readerFixture()
  try {
    const row = ledger.agentSessionTokenTotals({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-03T00:00:00.000Z' })
    assert.deepEqual({ sessions: row.sessions, input: row.input, output: row.output, cache_write: row.cache_write, cache_read: row.cache_read }, {
      sessions: 1, input: 11, output: 12, cache_write: 13, cache_read: 14,
    })
  } finally { ledger.close() }
})
test('read-only writers refuse ordinary and sequence paths without changing authority or mirror', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({ adw_id: 'read-only-seed', repo_slug: 'repo', task_slug: 'seed' })
  source.startPhase({ adw_id: 'read-only-seed', seq: 1, name: 'plan' })
  const dbPath = source._dbPath
  const jsonlPath = source._jsonlPath
  const beforeJsonl = readFileSync(jsonlPath)
  const beforeSessions = source.listSessions()
  const beforePhases = source.dumpTable('phases')
  source.close()

  const reader = openLedger({ dbPath, readOnly: true, stderr: { write: () => {} } })
  try {
    assert.throws(() => reader.startSession({ adw_id: 'read-only-ordinary', repo_slug: 'repo', task_slug: 'ordinary' }))
    assert.throws(() => reader.startPhase({ adw_id: 'read-only-seed', seq: 2, name: 'build' }))
  } finally { reader.close() }

  const after = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    assert.deepEqual(after.listSessions(), beforeSessions)
    assert.deepEqual(after.dumpTable('phases'), beforePhases)
  } finally { after.close() }
  assert.deepEqual(readFileSync(jsonlPath), beforeJsonl)
})
test('read-only ledger answers delegated readouts without creating a missing path', { skip: SKIP }, () => {
  const missingDir = join(nextDir(), 'missing')
  const missingDb = join(missingDir, 'ledger.db')
  const missing = openLedger({ dbPath: missingDb, readOnly: true, stderr: { write: () => {} } })
  try { assert.equal(missing.readConnection(), null) } finally { missing.close() }
  for (const path of [missingDir, missingDb, `${missingDb}-wal`, `${missingDb}-shm`, join(missingDir, 'ledger.jsonl')]) assert.equal(existsSync(path), false, path)

  const source = openTestLedger()
  seedRun(source, 'read-only-reads', RUNSET_SINCE)
  source.recordCellFailure({ provider: 'anthropic', model_id: 'read-cell', agent: 'claude', effort: 'high', role: 'planner', kind: 'timeout', adw_id: null, created_at: RUNSET_SINCE })
  source.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'none', considered: 1, pages: 1, created_at: RUNSET_SINCE })
  source.recordIntakeRefusal({ board_owner: 'owner', board_project: 1, issue: 1, reason: 'stop-switch', created_at: RUNSET_SINCE })
  const dbPath = source._dbPath
  source.close()
  const writable = openLedger({ dbPath, stderr: { write: () => {} } })
  const reader = openLedger({ dbPath, readOnly: true, stderr: { write: () => {} } })
  try {
    const options = { since: RUNSET_SINCE, until: null }
    assert.deepEqual(reader.cellFailures(options), writable.cellFailures(options))
    assert.deepEqual(reader.cellAttempts(options), writable.cellAttempts(options))
    assert.deepEqual(reader.runSet(options), writable.runSet(options))
    assert.deepEqual(reader.intakeSweeps(options), writable.intakeSweeps(options))
    assert.deepEqual(reader.intakeRefusals(options), writable.intakeRefusals(options))
  } finally { reader.close(); writable.close() }
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
  assert.deepEqual(replayed, {
    applied: 1, skipped: 0, failed: 0, complete: true, first_failure: null,
  })
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
test('T4: seat teardown retries with distinct timestamps remain separate rows', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.recordSeatTeardown({ adw_id: 't4', role: 'builder', outcome: 'proven', reason: 'exited', created_at: '2024-01-01T00:00:00.000Z' })
    ledger.recordSeatTeardown({ adw_id: 't4', role: 'builder', outcome: 'failed', reason: 'still-alive', created_at: '2024-01-01T00:00:01.000Z' })
    assert.equal(ledger.dumpTable('seat_teardowns').length, 2)
    assert.equal(ledger.seatTeardowns().find((row) => row.outcome === 'failed').count, 1)
  } finally { ledger.close() }
})
test('T5: review retries with distinct timestamps retain both verdicts', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.recordReviewOutcome({ adw_id: 't5', dispatch_id: 'd5', role: 'reviewer', verdict: 'changes-needed', created_at: '2024-01-01T00:00:00.000Z' })
    ledger.recordReviewOutcome({ adw_id: 't5', dispatch_id: 'd5', role: 'reviewer', verdict: 'pass', created_at: '2024-01-01T00:00:01.000Z' })
    const rows = ledger.dumpTable('review_outcomes')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(({ verdict }) => verdict).sort(), ['changes-needed', 'pass'])
  } finally { ledger.close() }
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
  ledger.recordSeatTeardown(row)
  ledger.recordSeatTeardown({ ...row, outcome: 'failed', reason: 'probe-alive', created_at: '2024-01-01T00:00:01.000Z' })
  const rows = ledger.dumpTable('seat_teardowns')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(({ outcome }) => outcome).sort(), ['failed', 'proven'])
  const bad = openTestLedger()
  assert.throws(
    () => bad.recordSeatTeardown({ adw_id: 'seat-bad', role: 'builder', outcome: 'retired' }),
    (err) => err instanceof LedgerUsageError && !err.message.includes('retired'),
  )
  assert.deepEqual(bad.dumpTable('seat_teardowns'), [])
  const below = openLedger({ dbPath: join(nextDir(), 'seat-floor.db'), nodeVersion: '20.11.0', stderr: { write: () => {} } })
  assert.doesNotThrow(() => below.recordSeatTeardown({ adw_id: 'seat-floor', outcome: 'unproven' }))
})
test('an older migration prefix upgrades additively with seat_teardowns', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'seat-prefix.db')
  const seatIndex = MIGRATIONS.findIndex((statement) => /CREATE TABLE IF NOT EXISTS "seat_teardowns"/i.test(statement))
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
test('taskReadout marks context occupancy absent only while no agent row measures context_tokens', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'occupancy-absent', repo_slug: 'r', task_slug: 't' })
  ledger.startAgentSession({
    adw_id: 'occupancy-absent', dispatch_id: 'd1', role: 'builder', model: 'm',
    claude_session_id: 'cs1', transcript_path: '/tmp/t.jsonl',
  })
  const readout = ledger.taskReadout('occupancy-absent')
  assert.ok(readout.absent.context_occupancy)
  // The absence half above is satisfied by occupancy hardcoded absent, because
  // the FIXTURE never gave the readout a measured row to see. A second run
  // whose agent row does measure context_tokens is what makes the mark's
  // ARRIVAL and DEPARTURE both observable.
  // MUTATION C1: replace ledger.mjs's measuredContextOccupancy expression with
  // `false` and the assertion below reddens.
  ledger.startSession({ adw_id: 'occupancy-measured', repo_slug: 'r', task_slug: 't' })
  seedTaskAgentSession(ledger, 'occupancy-measured', 'occupancy', [1, 2, 3, 4])
  assert.equal(ledger.taskReadout('occupancy-measured').absent.context_occupancy, undefined)
})
test('a recordSessionRequest JSONL line replays through the closed writer set', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({ adw_id: 'request-replay', repo_slug: 'r', task_slug: 't' })
  source.recordSessionRequest({ adw_id: 'request-replay', request: 'replay this ask', source: 'dispatch' })
  const target = openTestLedger()
  assert.deepEqual(replayJsonl(source._jsonlPath, target), {
    applied: 2, skipped: 0, failed: 0, complete: true, first_failure: null,
  })
  assert.deepEqual({ request: target.getSession('request-replay').request, request_source: target.getSession('request-replay').request_source }, {
    request: 'replay this ask', request_source: 'dispatch',
  })
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
test('startProcess has no production caller; future wiring must update the retirement record', { skip: SKIP }, () => {
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
      if (/\bstartProcess\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(full)
    }
  }
  for (const root of ['crew', 'scripts', 'visualizer']) walk(join(ROOT, root))
  assert.deepEqual(offenders, [], 'update RETIRED_TABLES.processes and docs/ledger-queries.md when wiring startProcess')
})
test('sessions ends with typed outcomes and starts each row with all seven appended fields NULL', { skip: SKIP }, () => {
  assert.deepEqual(TABLES.sessions.columns.slice(-4).map(({ name }) => name), [
    'outcome', 'terminal_reason', 'terminal_actor', 'synthetic_reason',
  ])
  assert.equal(TABLES.sessions.columns.at(-5).name, 'proposed_strength')
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'heartbeat-null', repo_slug: 'r', task_slug: 't' })
  const row = ledger.getSession('heartbeat-null')
  assert.equal(row.last_heartbeat_at, null)
  assert.equal(row.tier, null)
  assert.equal(row.proposed_shape, null)
  assert.equal(row.proposed_strength, null)
  assert.equal(row.outcome, null)
  assert.equal(row.terminal_reason, null)
  assert.equal(row.terminal_actor, null)
  assert.equal(row.synthetic_reason, null)
})
test('agent sessions opened without a usage frame name the explicit no_usage_frame absence', { skip: SKIP }, () => {
  assert.deepEqual(AGENT_SESSION_ABSENT_REASON_KEYS, [AGENT_SESSION_ABSENT_REASONS.no_usage_frame])
  const { ledger } = openB499Ledger()
  try {
    ledger.startSession({ adw_id: 'usage-absent', repo_slug: 'r', task_slug: 't' })
    ledger.startAgentSession({
      adw_id: 'usage-absent', dispatch_id: 'd1', role: 'builder', model: 'model',
      claude_session_id: 'session-1', transcript_path: '/tmp/transcript.jsonl',
    })
    const row = ledger.dumpTable('agent_sessions')[0]
    assert.equal(row.absent_reason, AGENT_SESSION_ABSENT_REASONS.no_usage_frame)
    for (const field of ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']) {
      assert.equal(row[field], null, `${field} must stay unmeasured until an end usage frame arrives`)
    }
  } finally { ledger.close() }
})
test('endAgentSession clears its named absence and the cleared row replays identically', { skip: SKIP }, () => {
  const sourceFixture = openB499Ledger()
  const targetFixture = openB499Ledger()
  const { ledger: source } = sourceFixture
  const { ledger: target } = targetFixture
  try {
    source.startSession({ adw_id: 'usage-replay', repo_slug: 'r', task_slug: 't' })
    source.startAgentSession({
      adw_id: 'usage-replay', dispatch_id: 'd1', role: 'builder', model: 'model',
      claude_session_id: 'session-1', transcript_path: '/tmp/transcript.jsonl',
    })
    source.endAgentSession({
      adw_id: 'usage-replay', claude_session_id: 'session-1',
      context_tokens: 10, context_window: 20, raw_read_tokens: 30, raw_written_tokens: 40,
      billed_input_tokens: 50, billed_output_tokens: 60,
      billed_cache_write_tokens: 70, billed_cache_read_tokens: 80,
    })
    const sourceRow = source.dumpTable('agent_sessions')[0]
    assert.equal(sourceRow.absent_reason, null)
    const replay = replayJsonl(source._jsonlPath, target)
    assert.equal(replay.failed, 0)
    assert.deepEqual(target.dumpTable('agent_sessions'), [sourceRow])
  } finally {
    source.close()
    target.close()
  }
})
test('a preexisting sessions and agent_sessions schema gains both provenance columns without backfilling historical rows', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dir = scratchDir('b499-ledger-migration-')
  const db = new DatabaseSync(join(dir, 'ledger.db'))
  const oldSessions = TABLES.sessions.columns.filter(({ name }) => name !== 'synthetic_reason')
  const oldAgentSessions = TABLES.agent_sessions.columns.filter(({ name }) => name !== 'absent_reason')
  try {
    db.exec(`CREATE TABLE sessions (${oldSessions.map(({ name, decl }) => `"${name}" ${decl}`).join(', ')})`)
    db.exec(`CREATE TABLE agent_sessions (${oldAgentSessions.map(({ name, decl }) => `"${name}" ${decl}`).join(', ')})`)
    const sessionNames = oldSessions.map(({ name }) => name)
    db.prepare(`INSERT INTO sessions (${sessionNames.join(', ')}) VALUES (${sessionNames.map(() => '?').join(', ')})`).run(
      ...sessionNames.map((name) => ({
        adw_id: 'historical-session', repo_slug: 'r', task_slug: 't', started_at: '2024-01-01T00:00:00.000Z',
        ended_at: '2024-01-01T00:00:01.000Z', status: 'ok', tier: 'build',
      })[name] ?? null),
    )
    const agentNames = oldAgentSessions.map(({ name }) => name)
    db.prepare(`INSERT INTO agent_sessions (${agentNames.join(', ')}) VALUES (${agentNames.map(() => '?').join(', ')})`).run(
      ...agentNames.map((name) => ({
        id: 1, adw_id: 'historical-session', dispatch_id: 'd1', role: 'builder', model: 'model',
        claude_session_id: 'historical-agent', transcript_path: '/tmp/historical.jsonl',
        started_at: '2024-01-01T00:00:00.000Z', ended_at: '2024-01-01T00:00:01.000Z',
      })[name] ?? null),
    )
    applyMigrations(db)
    const session = db.prepare('SELECT * FROM sessions WHERE adw_id = ?').get('historical-session')
    const agent = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(1)
    assert.equal(session.synthetic_reason, null)
    assert.equal(agent.absent_reason, null)
    assert.ok(db.prepare('PRAGMA table_info(sessions)').all().some((row) => row.name === 'synthetic_reason'))
    assert.ok(db.prepare('PRAGMA table_info(agent_sessions)').all().some((row) => row.name === 'absent_reason'))
  } finally { db.close() }
})
test('B1: retired synthetic writer is absent from the ledger handle and emitter drops its callback', { skip: SKIP }, () => {
  const { ledger } = openB499Ledger()
  const stateDir = scratchDir('b548-ledger-emitter-')
  const emitter = openRun({
    stateDir, repoSlug: 'r', taskSlug: 't', dbPath: join(stateDir, 'ledger.db'), stderr: { write: () => {} },
  })
  try {
    assert.equal(Object.hasOwn(ledger, 'markSyntheticSession'), false)
    assert.throws(() => ledger.markSyntheticSession({}), TypeError)

    const droppedBefore = emitter.stats().dropped
    let accepted
    assert.doesNotThrow(() => {
      accepted = emitter.emit((handle) => handle.markSyntheticSession({}))
    })
    assert.equal(accepted, false)
    assert.equal(emitter.stats().dropped, droppedBefore + 1)
  } finally {
    ledger.close()
    emitter.dispose()
  }
})
test('C1: historical synthetic provenance remains readable while ordinary readers exclude the row', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const { ledger, dbPath } = openB499Ledger()
  const started = '2024-01-01T00:00:00.000Z'
  const ended = '2024-01-01T00:00:00.500Z'
  const historicalReason = 'gate_scratch_checkout'
  const window = { since: '2023-12-31T00:00:00.000Z', until: '2024-01-02T00:00:00.000Z' }
  try {
    ledger.startSession({ adw_id: 'synthetic-marked', repo_slug: 'r', task_slug: 'marked-task', started_at: started })
    ledger.endSession({
      adw_id: 'synthetic-marked', status: 'ok', outcome: 'escalated', terminal_reason: 'gate', terminal_actor: 'operator', ended_at: ended,
    })
    ledger.startSession({ adw_id: 'ordinary-short', repo_slug: 'r', task_slug: 'ordinary-task', started_at: started })
    ledger.endSession({ adw_id: 'ordinary-short', status: 'ok', outcome: 'success', ended_at: ended })
  } finally { ledger.close() }

  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('UPDATE sessions SET synthetic_reason = ? WHERE adw_id = ?').run(historicalReason, 'synthetic-marked')
  } finally { db.close() }

  const reader = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const ids = (rows) => rows.map((row) => row.adw_id)
    assert.deepEqual(ids(reader.listSessions()), ['ordinary-short'])
    assert.deepEqual(ids(reader.sessionsFiltered(window)), ['ordinary-short'])
    assert.deepEqual(ids(reader.runsStartedWithin(window)), ['ordinary-short'])
    assert.deepEqual(ids(reader.gateReviewGap()), ['ordinary-short'])
    assert.deepEqual(ids(reader.eligibleTasks()), ['ordinary-short'])
    assert.deepEqual(ids(reader.runSet(window)), ['ordinary-short'])
    assert.deepEqual(reader.escalations(window), [])
    assert.equal(reader.endedRuns(window).reduce((count, row) => count + row.count, 0), 1)
    assert.equal(reader.escalationWindow(window).endedRows.reduce((count, row) => count + row.count, 0), 1)
    assert.equal(reader.taskReadout('marked-task').adw_id, null)
    assert.equal(reader.taskReadout('ordinary-task').session.adw_id, 'ordinary-short')

    assert.equal(reader.getSession('synthetic-marked').synthetic_reason, historicalReason)
    const forensic = reader.phantomSessions().find((row) => row.adw_id === 'synthetic-marked')
    assert.equal(forensic?.synthetic_reason, historicalReason)
    assert.equal(reader.dumpTable('sessions').find((row) => row.adw_id === 'synthetic-marked').synthetic_reason, historicalReason)
  } finally { reader.close() }
})
test('phantomSessions admits only short zero-event rows and preserves historical provenance', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const { ledger, dbPath } = openB499Ledger()
  const historicalReason = 'gate_scratch_checkout'
  const sessions = [
    ['unmarked-phantom', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.500Z'],
    ['historical-phantom', '2024-01-01T00:00:02.000Z', '2024-01-01T00:00:02.500Z'],
    ['outside-window', '2024-01-01T00:00:04.000Z', '2024-01-01T00:00:14.000Z'],
    ['evented-phantom', '2024-01-01T00:00:16.000Z', '2024-01-01T00:00:16.500Z'],
  ]
  try {
    for (const [adw_id, started_at, ended_at] of sessions) {
      ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id, started_at })
      ledger.endSession({ adw_id, status: 'ok', ended_at })
    }
    ledger.recordEvent({ adw_id: 'evented-phantom', type: 'log', payload: { level: 'info', message: 'event excludes this row' } })
  } finally { ledger.close() }

  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('UPDATE sessions SET synthetic_reason = ? WHERE adw_id = ?').run(historicalReason, 'historical-phantom')
  } finally { db.close() }

  const reader = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const rows = reader.phantomSessions()
    assert.deepEqual(rows.map(({ adw_id, synthetic_reason, events, phases }) => ({ adw_id, synthetic_reason, events, phases })), [
      { adw_id: 'unmarked-phantom', synthetic_reason: null, events: 0, phases: 0 },
      { adw_id: 'historical-phantom', synthetic_reason: historicalReason, events: 0, phases: 0 },
    ])
    assert.equal(rows.some((row) => row.adw_id === 'outside-window'), false)
    assert.equal(rows.some((row) => row.adw_id === 'evented-phantom'), false)
    assert.ok(rows.every((row) => row.duration_ms >= 0 && row.duration_ms < 1000))
  } finally { reader.close() }
})
test('a read-only legacy mirror without synthetic_reason remains readable through session filters and run sets', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dir = scratchDir('b499-ledger-readonly-')
  const dbPath = join(dir, 'legacy.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE sessions (
        adw_id TEXT PRIMARY KEY, repo_slug TEXT, task_slug TEXT,
        started_at TEXT, ended_at TEXT, status TEXT
      );
      CREATE TABLE events (id INTEGER PRIMARY KEY, adw_id TEXT, type TEXT, payload_json TEXT);
    `)
    db.prepare('INSERT INTO sessions (adw_id, repo_slug, task_slug, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-session', 'r', 'legacy-task', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:01.000Z', 'ok')
  } finally { db.close() }
  const ledger = openLedger({ dbPath, readOnly: true, stderr: { write: () => {} } })
  try {
    assert.equal(ledger.stats().degraded, false)
    assert.deepEqual(ledger.listSessions().map((row) => row.adw_id), ['legacy-session'])
    assert.deepEqual(ledger.sessionsFiltered().map((row) => row.adw_id), ['legacy-session'])
    assert.deepEqual(ledger.runSet({ since: '2023-12-31T00:00:00.000Z' }).map((row) => row.adw_id), ['legacy-session'])
  } finally { ledger.close() }
})
test('excludeSynthetic re-probes a legacy read-only handle after the column is added and a historical value is persisted (kills negative latch)', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dir = scratchDir('b499-ledger-negative-latch-')
  const dbPath = join(dir, 'legacy.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE sessions (
        adw_id TEXT PRIMARY KEY, repo_slug TEXT, task_slug TEXT,
        started_at TEXT, ended_at TEXT, status TEXT
      );
    `)
    db.prepare('INSERT INTO sessions (adw_id, repo_slug, task_slug, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('late-marked', 'r', 'legacy-task', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:01.000Z', 'ok')
  } finally { db.close() }

  const legacy = openLedger({ dbPath, readOnly: true, stderr: { write: () => {} } })
  const migrator = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    assert.deepEqual(legacy.sessionsFiltered().map((row) => row.adw_id), ['late-marked'], 'the first read must establish the pre-column observation')
    assert.ok(migrator.getSession('late-marked'), 'the writable handle must apply the additive migration')
    const historical = new DatabaseSync(dbPath)
    try {
      historical.prepare('UPDATE sessions SET synthetic_reason = ? WHERE adw_id = ?').run('gate_scratch_checkout', 'late-marked')
    } finally { historical.close() }
    assert.deepEqual(legacy.sessionsFiltered().map((row) => row.adw_id), [], 'the same handle must learn the column appeared and exclude its historical row')
    assert.equal(legacy.stats().degraded, false)
  } finally {
    legacy.close()
    migrator.close()
  }
})
test('source text wires synthetic exclusion into exactly twelve ordinary readers and leaves forensic reads unfiltered', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const block = (name) => {
    const start = source.indexOf(`  function ${name}(`)
    assert.notEqual(start, -1, `missing reader ${name}`)
    const next = source.indexOf('\n  function ', start + 1)
    return source.slice(start, next === -1 ? source.length : next)
  }
  const ordinary = [
    'listSessions', 'sessionsFiltered', 'runsStartedWithin', 'gateReviewGap', 'escalations',
    'endedRuns', 'escalationWindow', 'eligibleTasks', 'runSet', 'taskReadout', 'cellFailures', 'cellAttempts',
  ]
  assert.equal(new Set(ordinary).size, 12)
  for (const name of ordinary) assert.match(block(name), /excludeSynthetic\(/, `${name} must consult the synthetic-session predicate`)
  for (const name of ['getSession', 'dumpTable', 'phantomSessions', 'unattributableCellFailures']) {
    assert.doesNotMatch(block(name), /excludeSynthetic\(/, `${name} must retain its forensic/non-session contract`)
  }
  assert.equal((source.match(/excludeSynthetic\(/g) ?? []).length, 15, 'one helper declaration plus fourteen ordinary query sites')
  const task = block('taskReadout')
  assert.match(task, /SELECT adw_id FROM sessions WHERE adw_id = \?/, 'direct forensic task lookup must remain visible')
  assert.match(task, /SELECT \* FROM sessions WHERE adw_id = \?/, 'resolved forensic task row must remain visible')
})
test('doctor reports per-writer JSONL/mirror drift naming the writer and the count', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({ adw_id: 'drift-present', repo_slug: 'r', task_slug: 't' })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: 'startSession', at: '2026-08-22T00:00:00.000Z', args: { adw_id: 'drift-missing' } })}\n`)
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const drift = ledger.jsonlDrift()
    assert.equal(drift.measured, true)
    assert.deepEqual(drift.writers.find((writer) => writer.writer === 'startSession'), {
      writer: 'startSession', table: 'sessions', unique_key: ['adw_id'],
      lines: 2, distinct_keys: 2, rows_present: 1, drift: 1, collapsed_keys: 0,
    })
    assert.equal(drift.drift_total, 1)
  } finally { ledger.close() }
})
test('a complete mirror reports no drift', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.startSession({ adw_id: 'drift-complete', repo_slug: 'r', task_slug: 't' })
    ledger.startPhase({ adw_id: 'drift-complete', seq: 1, name: 'build', started_at: '2026-08-22T00:00:00.000Z' })
    ledger.recordEvent({ adw_id: 'drift-complete', seq: 1, type: 'log', payload: {} })
    const drift = ledger.jsonlDrift()
    assert.equal(drift.measured, true)
    assert.equal(drift.drift_total, 0)
    assert.equal(drift.remedy, null)
    assert.ok(drift.writers.length >= 3)
    assert.ok(drift.writers.every((writer) => writer.drift === 0))
  } finally { ledger.close() }
})
test('complete mirrors normalize JSONL values through SQLite affinity', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.startPhase({ adw_id: 'drift-affinity', seq: '03', name: 'build', started_at: '2026-08-22T00:00:00.000Z' })
    ledger.recordGateResult({
      adw_id: 'drift-affinity', phase_id: null, gate_name: 'g', attempt: true, ok: true,
      gate_generation: 1, pristine: false,
    })
    const drift = ledger.jsonlDrift()
    assert.equal(drift.measured, true)
    assert.equal(drift.drift_total, 0)
    assert.deepEqual(drift.writers.filter(({ writer }) => ['startPhase', 'recordGateResult'].includes(writer)).map(({ writer, rows_present, drift: count }) => ({ writer, rows_present, drift: count })), [
      { writer: 'startPhase', rows_present: 1, drift: 0 },
      { writer: 'recordGateResult', rows_present: 1, drift: 0 },
    ])
  } finally { ledger.close() }
})
test('complete mirrors preserve SQLite REAL for an out-of-range integral double', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.startPhase({ adw_id: 'drift-range', seq: 1e20, name: 'build', started_at: '2026-08-22T00:00:00.000Z' })
    const drift = ledger.jsonlDrift()
    const writer = drift.writers.find(({ writer }) => writer === 'startPhase')
    assert.equal(writer.distinct_keys, 1)
    assert.equal(writer.rows_present, 1)
    assert.equal(writer.drift, 0)
    assert.equal(drift.drift_total, 0)
  } finally { ledger.close() }
})
test('complete mirrors preserve SQLite REAL at the lower int64 double boundary', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.startPhase({ adw_id: 'drift-lower-boundary', seq: -9223372036854776000, name: 'build', started_at: '2026-08-22T00:00:00.000Z' })
    const drift = ledger.jsonlDrift()
    const writer = drift.writers.find(({ writer }) => writer === 'startPhase')
    assert.equal(writer.distinct_keys, 1)
    assert.equal(writer.rows_present, 1)
    assert.equal(writer.drift, 0)
    assert.equal(drift.drift_total, 0)
  } finally { ledger.close() }
})
test('drift keys preserve the post-affinity storage class', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startPhase({ adw_id: 'run', seq: 'Infinity', name: 'build', started_at: '2026-08-22T00:00:00.000Z' })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: 'startPhase', at: '2026-08-22T00:00:00.000Z', args: { adw_id: 'run', seq: '1e400' } })}\n`)
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const drift = ledger.jsonlDrift()
    const writer = drift.writers.find(({ writer }) => writer === 'startPhase')
    assert.equal(writer.distinct_keys, 2)
    assert.equal(writer.rows_present, 1)
    assert.equal(writer.drift, 1)
    assert.equal(drift.drift_total, 1)
  } finally { ledger.close() }
})
test('an affinity-converted JSONL string and its mirrored integer share one drift key', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startPhase({ adw_id: 'affine', seq: 7, name: 'build', started_at: '2026-08-22T00:00:00.000Z' })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: 'startPhase', at: '2026-08-22T00:00:00.000Z', args: { adw_id: 'affine', seq: '7' } })}\n`)
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const drift = ledger.jsonlDrift()
    const writer = drift.writers.find(({ writer }) => writer === 'startPhase')
    assert.equal(writer.distinct_keys, 1)
    assert.equal(writer.rows_present, 1)
    assert.equal(writer.drift, 0)
    assert.equal(drift.drift_total, 0)
  } finally { ledger.close() }
})
test('null encoding keeps sentinel-like values distinct in drift', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.recordSeatTeardown({ adw_id: 'drift-null', role: 'ledger-drift:null', outcome: 'proven' })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: 'recordSeatTeardown', at: '2026-08-22T00:00:00.000Z', args: { adw_id: 'drift-null', role: null, outcome: 'proven' } })}\n`)
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const drift = ledger.jsonlDrift()
    const writer = drift.writers.find(({ writer }) => writer === 'recordSeatTeardown')
    assert.equal(writer.distinct_keys, 2)
    assert.equal(writer.rows_present, 1)
    assert.equal(writer.drift, 1)
    assert.equal(drift.drift_total, 1)
  } finally { ledger.close() }
})
test('repeat unique keys are upserts, not drift', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    for (let i = 0; i < 3; i += 1) {
      ledger.startSession({ adw_id: 'drift-repeat', repo_slug: 'r', task_slug: 't', started_at: `2026-08-22T00:00:0${i}.000Z` })
    }
    const drift = ledger.jsonlDrift()
    const writer = drift.writers.find((entry) => entry.writer === 'startSession')
    assert.equal(drift.lines, 3)
    assert.deepEqual({ lines: writer.lines, distinct_keys: writer.distinct_keys, rows_present: writer.rows_present, drift: writer.drift, collapsed_keys: writer.collapsed_keys }, {
      lines: 3, distinct_keys: 1, rows_present: 1, drift: 0, collapsed_keys: 1,
    })
    assert.equal(drift.collapsed_lines_total, 2)
    assert.equal(drift.collapse_remedy, DRIFT_COLLAPSE_REMEDY)
  } finally { ledger.close() }
})
test('an absent or unreadable JSONL authority reports drift as unmeasured, never zero', { skip: SKIP }, () => {
  const absent = openTestLedger()
  try {
    const drift = absent.jsonlDrift()
    assert.equal(drift.measured, false)
    assert.equal(drift.drift_total, null)
    assert.ok(drift.unmeasured_reason)
  } finally { absent.close() }

  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  mkdirSync(jsonlPath)
  const unreadable = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  try {
    const drift = unreadable.jsonlDrift()
    assert.equal(drift.measured, false)
    assert.equal(drift.drift_total, null)
    assert.ok(drift.unmeasured_reason)
  } finally { unreadable.close() }
  const cli = run(['doctor'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stderr, /UNMEASURED/)
})
test('an unparsable JSONL line makes the drift readout unmeasured', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    appendFileSync(ledger._jsonlPath, 'not json\n')
    const drift = ledger.jsonlDrift()
    assert.equal(drift.measured, false)
    assert.equal(drift.unparsed_lines, 1)
    assert.equal(drift.drift_total, null)
  } finally { ledger.close() }
})
test('a below-floor (degraded) handle reports drift as unmeasured rather than throwing', { skip: SKIP }, () => {
  const ledger = openTestLedger({ nodeVersion: '20.0.0' })
  assert.doesNotThrow(() => {
    const drift = ledger.jsonlDrift()
    assert.equal(drift.measured, false)
    assert.deepEqual(drift.writers, [])
  })
  ledger.close()
})
test('the doctor CLI names replayJsonl as the drift remedy', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({ adw_id: 'drift-cli-present', repo_slug: 'r', task_slug: 't' })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ v: 1, kind: 'startSession', at: '2026-08-22T00:00:00.000Z', args: { adw_id: 'drift-cli-missing' } })}\n`)
  const result = run(['doctor'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.jsonl_drift.remedy, DRIFT_REMEDY)
  assert.match(payload.jsonl_drift.remedy, /replayJsonl/)
  assert.match(result.stderr, /replayJsonl/)
})
test('an update-only writer line is not counted as a missing row', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.startSession({ adw_id: 'drift-update-only', repo_slug: 'r', task_slug: 't' })
    ledger.endSession({ adw_id: 'drift-update-only', status: 'ok' })
    const drift = ledger.jsonlDrift()
    assert.equal(drift.lines, 2)
    assert.equal(drift.measured, true)
    assert.equal(drift.drift_total, 0)
    assert.equal(drift.writers.some((writer) => writer.writer === 'endSession'), false)
  } finally { ledger.close() }
})

function routingLedgerFixture(overrides = {}) {
  return {
    entry_point: 'bench', tier: 'build', role: 'builder',
    policy_hash: 'a'.repeat(64), measurement_fingerprint: 'b'.repeat(64),
    outcome: 'abstained', chosen_cell: null,
    candidate_set: [{ provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }],
    exclusions: [{ cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }, reason: 'rate-absent' }],
    normalized_measurements: [{
      cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' },
      rate: { numerator: null, denominator: null, value: null, reason: 'rate-absent' },
      cost_usd: { value: null, reason: 'cost-absent' }, exclusion_reason: 'rate-absent',
    }],
    policy_entry: {
      candidates: [{ provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }],
      tie_break: ['first_round_pass_rate_desc', 'cost_usd_asc', 'policy_order'],
      measurement_window: { lookback_days: 30, minimum_rate_denominator: 12 },
      null_handling: { rate: 'exclude-with-reason', cost: 'exclude-with-reason' },
      abstention_reasons: ['no-eligible-candidate'],
    },
    reason: 'no-eligible-candidate', created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('routing ledger writer round-trips JSONL, SQLite, replay and preserves rate denominators', { skip: SKIP }, () => {
  const source = openTestLedger()
  const args = source.recordRoutingChoice(routingLedgerFixture())
  assert.deepEqual(args.chosen_cell, null)
  assert.equal(args.normalized_measurements[0].rate.denominator, null)
  const line = readFileSync(source._jsonlPath, 'utf8').trim().split('\n').map(JSON.parse).find((row) => row.kind === 'recordRoutingChoice')
  assert.ok(line)
  assert.deepEqual(line.args.chosen_cell, null)
  assert.equal(line.args.normalized_measurements[0].rate.denominator, null)
  const rows = source.dumpTable('routing_choices')
  assert.equal(rows.length, 1)
  assert.equal(JSON.parse(rows[0].normalized_measurements_json)[0].rate.denominator, null)
  assert.deepEqual(source.routingChoices({ entry_point: 'bench', tier: 'build', role: 'builder' }).map((row) => row.id), [rows[0].id])
  const replayed = openTestLedger()
  assert.deepEqual(replayJsonl(source._jsonlPath, replayed), { applied: 1, skipped: 0, failed: 0, complete: true, first_failure: null })
  assert.deepEqual(replayed.dumpTable('routing_choices'), source.dumpTable('routing_choices'))
  assert.equal(replayed.dumpTable('routing_choices').length, 1)
  source.close(); replayed.close()
})

test('routing ledger writer rejects closed outcomes and reasons without appending', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const before = existsSync(ledger._jsonlPath) ? readFileSync(ledger._jsonlPath, 'utf8') : ''
  assert.throws(() => ledger.recordRoutingChoice(routingLedgerFixture({ outcome: 'maybe' })), /recordRoutingChoice/)
  assert.throws(() => ledger.recordRoutingChoice(routingLedgerFixture({ reason: 'invented' })), /recordRoutingChoice/)
  assert.equal(existsSync(ledger._jsonlPath) ? readFileSync(ledger._jsonlPath, 'utf8') : '', before)
  ledger.close()
})

test('routing ledger writer keeps JSONL evidence when the SQLite mirror is unavailable', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'routing-degraded', repo_slug: 'r', task_slug: 't' })
  const { DatabaseSync } = require('node:sqlite')
  const raw = new DatabaseSync(ledger._dbPath)
  raw.exec('DROP TABLE routing_choices')
  raw.close()
  assert.doesNotThrow(() => ledger.recordRoutingChoice(routingLedgerFixture()))
  const line = readFileSync(ledger._jsonlPath, 'utf8').trim().split('\n').map(JSON.parse).find((row) => row.kind === 'recordRoutingChoice')
  assert.ok(line)
  assert.ok(ledger.stats().mirror_errors > 0)
  ledger.close()
})

test('chunk RV1-1 unbooted chunk reports null green with chunk-lane-unbooted and owned denominator', () => {
  const ledger = openTestLedger()
  ledger.recordChunkRun({ parentLane: 'p1', chunkId: 'c1', lane: 'p1-c1', wave: 0, checksOwned: ['A1'] })
  const { DatabaseSync } = require('node:sqlite')
  const conn = new DatabaseSync(ledger._dbPath)
  try {
    const out = chunkProgress({ conn, parentLane: 'p1' })
    const row = out.chunks.find((c) => c.chunk_id === 'c1')
    assert.ok(row)
    assert.equal(row.owned_green, null)
    assert.equal(row.reason, 'chunk-lane-unbooted')
    assert.equal(row.owned_total, 1)
    assert.equal(row.done, false)
  } finally {
    conn.close()
    ledger.close()
  }
})

test('chunk upsertChunkRun recompile replaces owned checks and CHUNK_PROGRESS_SQL matches docs', () => {
  const ledger = openTestLedger()
  ledger.recordChunkRun({ parentLane: 'p1', chunkId: 'c1', lane: 'p1-c1', wave: 0, checksOwned: ['A1'] })
  const { DatabaseSync } = require('node:sqlite')
  const conn = new DatabaseSync(ledger._dbPath)
  try {
    upsertChunkRun(conn, { parentLane: 'p1', chunkId: 'c1', lane: 'p1-c1', wave: 0, checksOwned: ['A1', 'A2', 'A3'] })
    const left = conn.prepare(`SELECT checks_owned_json FROM chunk_runs WHERE parent_lane = 'p1' AND chunk_id = 'c1'`).get()?.checks_owned_json
    assert.equal(JSON.parse(left).length, 3)
    const doc = readFileSync(join(ROOT, 'docs', 'ledger-queries.md'), 'utf8')
    const m = doc.match(/<!-- CHUNK_PROGRESS_SQL -->\s*```sql\s*([\s\S]*?)```/)
    assert.ok(m)
    assert.equal(m[1].replace(/\s+/g, ' ').trim(), CHUNK_PROGRESS_SQL.replace(/\s+/g, ' ').trim())
    assert.equal(Object.keys(TABLES).length, 42)
  } finally {
    conn.close()
    ledger.close()
  }
})

// Sol, #1414 pass 1: every JSONL row carries both time keys, and the old agent rows carry an
// explicit null. The first cut of #1412 treated `!= null` as "absent", so replayJsonl stamped
// those rows with the REPLAY's clock — a time nobody measured. Only an absent key is defaulted.
// Mutation killed: treating an explicit null as absent (`input[key] == null`).
test('an agent row recorded with no time replays with no time, while a fresh one is stamped', () => {
  const dir = scratchDir('ledger-replay-null-')
  const written = openLedger({ dbPath: join(dir, 'live.db'), stderr: { write: () => {} } })
  try {
    written.startSession({ adw_id: 'replay-null', repo_slug: 'r', task_slug: 't' })
    // The shape an old row was written with: both keys present and null.
    written.recordEvent({ adw_id: 'replay-null', type: 'agent_start', payload: { role: 'builder', dispatch_id: 'old' }, started_at: null, ended_at: null })
    written.recordEvent({ adw_id: 'replay-null', type: 'agent_end', payload: { role: 'builder', outcome: 'done', dispatch_id: 'old' }, started_at: null, ended_at: null })
    // A fresh emit with the keys absent.
    written.recordEvent({ adw_id: 'replay-null', type: 'agent_start', payload: { role: 'builder', dispatch_id: 'new' } })
  } finally { written.close() }
  const replayClock = Date.parse('2030-06-01T12:34:56.789Z')
  const rebuilt = openLedger({ dbPath: join(dir, 'rebuilt.db'), jsonlPath: join(dir, 'rebuilt.jsonl'), now: () => replayClock, stderr: { write: () => {} } })
  try {
    replayJsonl(join(dir, 'ledger.jsonl'), rebuilt)
    const rows = rebuilt.dumpTable('events').filter((row) => row.adw_id === 'replay-null')
    const byDispatch = (type, id) => rows.find((row) => row.type === type && JSON.parse(row.payload_json).dispatch_id === id)
    assert.equal(byDispatch('agent_start', 'old').started_at, null)
    assert.equal(byDispatch('agent_end', 'old').ended_at, null)
    const fresh = byDispatch('agent_start', 'new').started_at
    assert.match(fresh, /^\d{4}-\d\d-\d\dT/)
    assert.notEqual(fresh, new Date(replayClock).toISOString(), 'the fresh row keeps the time it was written, not the replay clock')
  } finally { rebuilt.close() }
})

test('cellAttempts counts applied swaps as target-cell attempts', () => {
  const ledger = openTestLedger()
  try {
    const seatCell = (adw_id, over = {}) => {
      ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id })
      ledger.recordRunSeat({
        adw_id, role: 'builder', agent: 'pi', provider: 'openai', model_id: 'luna', model: 'luna',
        effort: 'high', transport: 'pane', source: 'roster', policy_state: 'passed',
        created_at: '2026-09-25T12:00:00.000Z', ...over,
      })
    }
    const swap = (adw_id, outcome, to, created_at, over = {}) => {
      ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id })
      ledger.recordModifierAttempt({
        adw_id, role: 'builder', modifier: 'failure-upgrade', bounce: 'lane', outcome,
        from_provider: 'openai', from_model_id: 'luna', from_model: 'luna', from_agent: 'pi', from_effort: 'high',
        to_provider: 'openai', to_model_id: to, to_model: to, to_agent: 'pi', to_effort: 'high',
        created_at, ...over,
      })
    }
    const attempts = (model_id, bounds = {}) =>
      ledger.cellAttempts(bounds).find((row) => row.model_id === model_id)?.attempts ?? 0
    seatCell('old-seat')
    swap('swap-applied', 'applied', 'codex-spark', '2026-09-25T12:01:00.000Z')
    assert.equal(attempts('codex-spark'), 1, 'an applied swap counts with no target seat row')
    assert.equal(attempts('luna'), 1, 'the old seat still counts once')
    assert.equal(attempts('codex-spark', { until: '2026-09-25T12:01:00.000Z' }), 0, 'the modifier upper bound is exclusive')
    assert.equal(attempts('codex-spark', { since: '2026-09-25T12:01:00.000Z' }), 1, 'the modifier lower bound is inclusive')
    swap('swap-exhausted', 'exhausted', 'refused-target', '2026-09-25T12:02:00.000Z')
    assert.equal(attempts('refused-target'), 0, 'exhausted targets never count')
    swap('swap-identical', 'applied', 'luna', '2026-09-25T12:03:00.000Z')
    assert.equal(attempts('luna'), 1, 'an identical-cell modifier adds no attempt')
    swap('swap-effort', 'applied', 'luna', '2026-09-25T12:04:00.000Z', { to_effort: 'max' })
    assert.equal(
      ledger.cellAttempts().find((row) => row.model_id === 'luna' && row.effort === 'max')?.attempts,
      1,
      'an effort-only change counts for the new effort cell',
    )
    swap('swap-synthetic', 'applied', 'synthetic-target', '2026-09-25T12:05:00.000Z')
    const db = new (require('node:sqlite').DatabaseSync)(ledger._dbPath)
    try {
      db.prepare('UPDATE sessions SET synthetic_reason = ? WHERE adw_id = ?').run('gate_scratch_checkout', 'swap-synthetic')
    } finally { db.close() }
    assert.equal(attempts('synthetic-target'), 0, 'synthetic-session modifiers are excluded')
  } finally { ledger.close() }
})

test('cellAttempts keys operator overrides by model string', () => {
  const ledger = openTestLedger()
  try {
    const seat = (adw_id, cell) => {
      ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id })
      ledger.recordRunSeat({
        adw_id, role: 'builder', agent: 'pi', effort: 'high', transport: 'pane',
        policy_state: 'passed', created_at: '2026-09-25T12:00:00.000Z', ...cell,
      })
    }
    seat('roster-seat', { provider: 'openai', model_id: 'luna', model: 'luna', source: 'roster' })
    seat('override-a', { provider: null, model_id: null, model: 'vendor/override-a', source: 'operator_override' })
    seat('override-b', { provider: null, model_id: null, model: 'vendor/override-b', source: 'operator_override' })
    const rows = ledger.cellAttempts()
    assert.equal(rows.find((row) => row.model_id === 'luna')?.model_key ?? null, null, 'roster rows carry no model key')
    assert.equal(rows.find((row) => row.model_key === 'vendor/override-a')?.attempts, 1)
    assert.equal(rows.find((row) => row.model_key === 'vendor/override-b')?.attempts, 1)
  } finally { ledger.close() }
})
