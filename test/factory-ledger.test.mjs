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
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { ROOT, scratchDir, sqliteAvailable } from './helpers.mjs'
// Inlined from the retired legacy runtime's contract (scripts/cmux/contract.mjs):
// the completion-nonce prefix the ledger's sweep guard checks against.
const NONCE_PREFIX = 'devteam-done-'
import {
  openLedger, mkdirpBounded, replayJsonl, isoMs, TABLES, MIGRATIONS, applyMigrations, NODE_FLOOR,
  SESSION_STATUSES, SESSION_OUTCOMES, TERMINAL_ACTORS, ESCALATION_CAUSES, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError,
  MODIFIER_KINDS, MODIFIER_ATTEMPT_OUTCOMES, INTAKE_DISPATCH_OUTCOMES,
  SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, CELL_FAILURE_KINDS, CELL_FAILURE_ATTRIBUTIONS,
  RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage,
  REQUEST_MAX_CHARS, ADVISOR_AB_INCOMPLETE_REASONS, USAGE_ABSENT_CAUSES, usageAbsentCause,
  CELL_RATE_FLOOR, CELL_PRICE_UNITS, REVIEW_VERDICTS,
} from '../scripts/factory/ledger.mjs'
import { FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, VARIANT_NAMES } from '../crew/drive.mjs'
import { emitAdapter } from '../crew/seat-io.mjs'
import { headlessIo } from '../crew/headless.mjs'
import { modelString as piModelString } from '../crew/adapters/adapter-pi.mjs'
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

const SQLITE_OK = sqliteAvailable()
const SKIP = SQLITE_OK ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`

// Boots a run the way crew/crew.mjs and crew/child.mjs do — stateDir is the
// crew dir, which is where crew.json lives — and returns its mirrored sessions
// row. `tier: null` writes a boot record with NO tier key at all, which is
// exactly what a --roles boot produces.
function bootTieredRun(tier, runConfiguration = null) {
  const stateDir = mkdtempSync(join(tmpdir(), 'factory-ledger-boot-'))
  writeFileSync(join(stateDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'boot-tier', roles: ['lead', 'planner'], ...(tier === null ? {} : { tier }),
    ...(runConfiguration ? { run_configuration: runConfiguration } : {}),
  }))
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  const emitter = openRun({ stateDir, repoSlug: 'r', taskSlug: 'boot-tier', dbPath })
  try {
    emitter.startRun()
    const ledger = openLedger({ dbPath })
    try {
      return {
        ...ledger.getSession(emitter.adwId),
        configuration: ledger.dumpTable('run_configurations').find((row) => row.adw_id === emitter.adwId) ?? null,
      }
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

// Drives ONE pane-seated review through emitAdapter into a real run, exactly
// as crew/crew.mjs:1370 -> crew/seat-io.mjs:1963 wire it, and emits NO usage
// event — a pane seat has none, which is why agent_sessions stays empty (#404).
function paneReviewRun(cell, review = { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 }, { role = 'reviewer', dispatchId = 'd3' } = {}) {
  const stateDir = mkdtempSync(join(fixture, 'pane-review-'))
  writeFileSync(join(stateDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'b84-attrib', roles: ['planner', 'builder', 'reviewer'], tier: 'build',
  }))
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  const emitter = openRun({ stateDir, repoSlug: 'r', taskSlug: 'b84-attrib', dbPath, stderr: { write: () => {} } })
  try {
    emitter.startRun()
    const crew = { task: 'b84-attrib', members: { [role]: { transport: 'pane', ...cell } } }
    const adapter = emitAdapter(emitter, crew)
    adapter({ kind: 'stage', label: 'review:r1' })
    adapter({ kind: 'assign', role, id: dispatchId })
    adapter({ kind: 'envelope', id: dispatchId, role, status: 'done', review })
    emitter.endRun({ status: 'ok' })
    return { dbPath, adwId: emitter.adwId }
  } finally { emitter.dispose() }
}
after(() => rmSync(fixture, { recursive: true, force: true }))

test("#404: a PANE-seated review is attributable to the reviewing seat's boot cell with no agent_sessions row", { skip: SKIP }, () => {
  const cell = {
    agent: 'pi', provider: 'openai', id: 'gpt-5.6-terra', model: 'openai-codex/gpt-5.6-terra', effort: 'max', transport: 'pane',
  }
  const { dbPath, adwId } = paneReviewRun(cell)
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('SELECT * FROM review_outcomes WHERE adw_id = ?').get(adwId)
    assert.ok(row)
    assert.deepEqual({
      agent: row.agent, provider: row.provider, model_id: row.model_id, model: row.model,
      effort: row.effort, transport: row.transport,
    }, {
      agent: cell.agent, provider: cell.provider, model_id: cell.id, model: cell.model,
      effort: cell.effort, transport: cell.transport,
    })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get().count, 0)
  } finally { db.close() }
})

test('#404: a raw --model-<role> override is recorded, not the roster cell', { skip: SKIP }, () => {
  const cell = {
    // A model the roster does NOT seat: this test proves the raw override is
    // recorded INSTEAD of the roster cell, so the fixture must differ from it.
    // gpt-5.6-sol was seated at build/reviewer on 2026-08-31, which made the
    // final assertion vacuously false; terra is catalogued but seated nowhere.
    agent: 'pi', provider: null, id: null, model: 'openai-codex/gpt-5.6-terra', effort: 'high', transport: 'pane',
  }
  const { dbPath, adwId } = paneReviewRun(cell)
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('SELECT * FROM review_outcomes WHERE adw_id = ?').get(adwId)
    assert.ok(row)
    assert.equal(row.agent, 'pi')
    assert.equal(row.provider, null)
    assert.equal(row.model_id, null)
    assert.equal(row.model, cell.model)
    assert.equal(row.effort, 'high')
    assert.equal(row.transport, 'pane')
    const rosterId = JSON.parse(readFileSync(join(ROOT, 'crew', 'roster.json'), 'utf8')).tiers.build.reviewer.id
    assert.ok(!row.model.includes(rosterId))
  } finally { db.close() }
})

test("#404: the headless usage writer's agent_sessions arguments are unchanged", () => {
  const starts = []; const ends = []
  const emitter = {
    adwId: 'adw-404-headless',
    emit: (fn) => fn({
      startAgentSession: (row) => starts.push(row),
      endAgentSession: (row) => ends.push(row),
    }),
  }
  const headlessCrew = { members: { reviewer: { transport: 'headless-json', agent: 'pi', model: 'sonnet', effort: 'high' } } }
  emitAdapter(emitter, headlessCrew)({
    kind: 'usage', id: 'd3', role: 'reviewer', model: 'sonnet', session_id: 'session-404', transcript_path: '/tmp/session-404.jsonl',
    usage: { billed_input_tokens: 5, billed_output_tokens: 6, billed_cache_write_tokens: 7, billed_cache_read_tokens: 8 },
  })
  assert.deepEqual(starts, [{
    adw_id: 'adw-404-headless', dispatch_id: 'd3', role: 'reviewer', model: 'sonnet',
    claude_session_id: 'session-404', transcript_path: '/tmp/session-404.jsonl',
  }])
  assert.deepEqual(ends, [{
    adw_id: 'adw-404-headless', claude_session_id: 'session-404',
    context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
    billed_input_tokens: 5, billed_output_tokens: 6, billed_cache_write_tokens: 7, billed_cache_read_tokens: 8,
  }])
})

test('#404: an unattributed review stays NULL and reads as unattributable, and nothing backfills it', () => {
  assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /UPDATE\s+review_outcomes/i)
  if (!SQLITE_OK) return
  const ledger = openTestLedger()
  try {
    ledger.recordReviewOutcome({ adw_id: 'adw-404-unattributed', dispatch_id: 'direct', role: 'reviewer', verdict: 'pass' })
    const handle = {
      recordEvent: () => {},
      recordReviewOutcome: (input) => ledger.recordReviewOutcome(input),
    }
    const emitter = {
      adwId: 'adw-404-unattributed',
      emit: (fn) => fn(handle, () => 1),
    }
    emitAdapter(emitter)({ kind: 'envelope', id: 'null-crew', role: 'reviewer', status: 'done', review: { verdict: 'pass' } })
    emitAdapter(emitter, { members: { builder: { agent: 'pi', model: 'sonnet', effort: 'high', transport: 'pane' } } })({
      kind: 'envelope', id: 'unseated-role', role: 'reviewer', status: 'done', review: { verdict: 'pass' },
    })
    const rows = ledger.dumpTable('review_outcomes').filter((row) => row.adw_id === 'adw-404-unattributed')
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.deepEqual({
        agent: row.agent, provider: row.provider, model_id: row.model_id, model: row.model,
        effort: row.effort, transport: row.transport,
      }, { agent: null, provider: null, model_id: null, model: null, effort: null, transport: null })
    }
  } finally { ledger.close() }
})

test('#404: the four #376 measurements compute from one query over pane reviews', { skip: SKIP }, () => {
  const cell = {
    agent: 'pi', provider: 'openai', id: 'gpt-5.6-terra', model: 'openai-codex/gpt-5.6-terra', effort: 'max', transport: 'pane',
  }
  const { dbPath, adwId } = paneReviewRun(cell, { verdict: 'changes-needed', must_fix: 2, should_fix: 0, consider: 0 })
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const reviewPhase = ledger.dumpTable('phases').find((phase) => phase.name === 'review')
    assert.ok(reviewPhase)
    ledger.recordAcceptDecision({
      adw_id: adwId, phase_id: reviewPhase.id, where: 'review-exhausted', outcome: 'accepted',
      findings_total: 3, residual_count: 1, refuted_count: 2, cosmetic_count: 0, unverified_count: 0,
    })
    const historicalAdwId = 'adw-404-historical'
    ledger.startSession({ adw_id: historicalAdwId, repo_slug: 'r', task_slug: 'b84-attrib' })
    const historicalPhase = ledger.startPhase({
      adw_id: historicalAdwId, seq: 1, name: 'review', started_at: '2024-01-01T00:00:00.000Z',
    })
    ledger.endPhase({
      adw_id: historicalAdwId, seq: 1, status: 'ok', ended_at: '2024-01-01T00:00:10.000Z',
    })
    ledger.recordReviewOutcome({
      adw_id: historicalAdwId, phase_id: historicalPhase, dispatch_id: 'historical-review', role: 'reviewer',
      verdict: 'pass', must_fix: 0,
    })
  } finally { ledger.close() }

  const MEASUREMENTS_QUERY = `
WITH acc AS (
  SELECT adw_id, SUM(COALESCE(residual_count, 0)) AS survived,
         SUM(COALESCE(refuted_count, 0)) AS overturned
  FROM accept_decisions GROUP BY adw_id
),
last_review AS (
  SELECT adw_id, MAX(id) AS id FROM review_outcomes GROUP BY adw_id
)
SELECT
  COALESCE(r.agent, 'unattributable')     AS agent,
  COALESCE(r.model, 'unattributable')     AS model,
  COALESCE(r.effort, 'unattributable')    AS effort,
  COALESCE(r.transport, 'unattributable') AS transport,
  COUNT(*)                                                                                AS reviews,
  SUM(CASE WHEN r.verdict = 'changes-needed' THEN 1 ELSE 0 END)                            AS bounces,
  ROUND(1.0 * SUM(CASE WHEN r.verdict = 'changes-needed' THEN 1 ELSE 0 END) / COUNT(*), 3) AS bounce_rate,
  ROUND(AVG(COALESCE(r.must_fix, 0)), 3)                                                  AS must_fix_per_review,
  SUM(CASE WHEN lr.id IS NULL THEN 0 ELSE COALESCE(acc.survived, 0) END)                   AS findings_survived,
  SUM(CASE WHEN lr.id IS NULL THEN 0 ELSE COALESCE(acc.overturned, 0) END)                 AS findings_overturned,
  ROUND(AVG((julianday(p.ended_at) - julianday(p.started_at)) * 86400.0), 1)               AS review_round_seconds
FROM review_outcomes r
JOIN phases p ON p.id = r.phase_id
LEFT JOIN last_review lr ON lr.id = r.id
LEFT JOIN acc ON acc.adw_id = r.adw_id
GROUP BY 1, 2, 3, 4
ORDER BY reviews DESC`
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db.prepare(MEASUREMENTS_QUERY).all()
    assert.equal(rows.length, 2)
    const attributed = rows.find((row) => row.model === cell.model)
    const unattributable = rows.find((row) => row.model === 'unattributable')
    assert.ok(attributed)
    assert.ok(unattributable)
    for (const measure of ['reviews', 'bounce_rate', 'must_fix_per_review', 'findings_survived', 'findings_overturned', 'review_round_seconds']) {
      assert.notEqual(attributed[measure], null)
      assert.notEqual(attributed[measure], undefined)
    }
    assert.equal(attributed.reviews, 1)
    assert.equal(attributed.bounces, 1)
    assert.equal(attributed.bounce_rate, 1)
    assert.equal(attributed.must_fix_per_review, 2)
    assert.equal(attributed.findings_survived, 1)
    assert.equal(attributed.findings_overturned, 2)
    assert.equal(unattributable.reviews, 1)
  } finally { db.close() }
})

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

function seedCellUsage({ tag, provider, model_id, agent = 'claude', model = model_id, effort = 'high', sessions }) {
  const ledger = openTestLedger()
  sessions.forEach((tokens, i) => {
    const adwId = `${tag}-adw-${i}`
    const dispatchId = `${tag}-r${i}`
    const sessionId = `${tag}-session-${i}`
    ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: `${tag}-${i}`, tier: 'build' })
    ledger.recordReviewOutcome({
      adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', verdict: 'pass',
      provider, model_id, agent, model, effort, transport: 'headless-json',
      created_at: '2024-01-01T00:00:00.000Z',
    })
    ledger.startAgentSession({
      adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', model,
      claude_session_id: sessionId, transcript_path: null,
    })
    ledger.endAgentSession({
      adw_id: adwId, claude_session_id: sessionId,
      context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
      billed_input_tokens: tokens.in, billed_output_tokens: tokens.out,
      billed_cache_write_tokens: tokens.cw, billed_cache_read_tokens: tokens.cr,
    })
  })
  const dbPath = ledger._dbPath
  ledger.close()
  return dbPath
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

test('escalationCause maps the archived envelopes and never guesses an unknown pair', () => {
  const cases = [
    // b309-dispatchprep — /Users/momoshell/.crew/dt-b309-dispatchprep/b309-dispatchprep.archive-2026-08-29T08-11-33-004Z/returns/task.json
    { where: 'planner', why: 'planner: no valid envelope at /Users/momoshell/.crew/dt-b309-dispatchprep/b309-dispatchprep/returns/d1.planner.json within 1800s — the seat is WORKING: planner produced a transcript frame 30s ago and simply exceeded its ', cause: 'budget', actor: 'driver' },
    // b317-drivergone — /Users/momoshell/.crew/dt-b317-drivergone/b317-drivergone.archive-2026-08-29T14-24-05-878Z/returns/task.json
    { where: 'cold-suite', why: 'the cold verification produced no verdict (unproven): neutralColdPath: no neutral cold checkout path for ["b317-drivergone","dt-b317-drivergone","dev-team-claude-plugin"] — every candidate root was rejected [/private/var', cause: 'infrastructure', actor: 'driver' },
    // b321-driverpublish — /Users/momoshell/.crew/dt-b321-driverpublish/b321-driverpublish.archive-2026-08-29T16-35-01-212Z/returns/task.json
    { where: 'driver', why: 'sendLine: could not clear the pane input back to baseline before retype', cause: 'transport', actor: 'driver' },
    // b322-closeout#1 — /Users/momoshell/.crew/dt-b322-closeout/b322-closeout.archive-2026-08-29T15-14-14-427Z/returns/task.json
    { where: 'driver', why: 'sendLine: echo not verified exactly once over baseline (before 0, last 0)', cause: 'transport', actor: 'driver' },
    // b322-closeout#2 — /Users/momoshell/.crew/dt-b322-closeout/b322-closeout.archive-2026-08-29T15-18-22-532Z/returns/task.json
    { where: 'driver', why: 'sendLine: echo not verified exactly once over baseline (before 0, last 0)', cause: 'transport', actor: 'driver' },
    // b324-closeoutscript — /Users/momoshell/.crew/dt-b324-closeoutscript/b324-closeoutscript.archive-2026-08-29T17-05-09-432Z/returns/task.json
    { where: 'driver', why: 'sendLine: could not clear the pane input back to baseline before retype', cause: 'transport', actor: 'driver' },
    // b325-driverpublish#1 — /Users/momoshell/.crew/dt-b325-driverpublish/b325-driverpublish.archive-2026-08-29T17-01-58-919Z/returns/task.json
    { where: 'driver', why: 'sendLine: could not clear the pane input back to baseline before retype', cause: 'transport', actor: 'driver' },
    // b325-driverpublish#final — /Users/momoshell/.crew/dt-b325-driverpublish/b325-driverpublish/returns/task.json
    { where: 'gate', why: 'roof is clean (32/32 red, 0 errored) and 31 of 32 per-check mutations killed. The sole failure is A3b, whose outcome is anchor-absent: the plan declared find text "const rebased = baseSha !== mergeBase" for crew/drive.mjs, but the builder wrote `let rebased = false` at crew/drive', cause: 'plan-build-disagreement', actor: 'driver' },
    // b329-closeoutscript — /Users/momoshell/.crew/dt-b329-closeoutscript/b329-closeoutscript.archive-2026-08-30T15-32-26-023Z/returns/task.json
    { where: 'plan', why: "allowlisted read-only recipe' test reddens the moment package.json gains factory:closeout. The compiled brief therefore demands (acceptance h + 'Full suite green') something its own fence forbids — a contradiction inside an artifact compiled outside this workspace. A bounce is wo", cause: 'brief-contradiction', actor: 'operator' },
    { where: 'review', why: 'the lead could not settle finding 2 within its rounds', cause: 'review-unresolved', actor: 'lead' },
    { where: 'gate', why: 'the gate check C3 survived its declared mutation and the repair did not fix it', cause: 'gate-defect', actor: 'lead' },
  ]
  for (const { where, why, cause, actor } of cases) {
    const mapped = escalationCause({ where, why })
    assert.deepEqual(mapped, { cause, actor }, `${where}: ${why}`)
    assert.equal(Object.isFrozen(mapped), true)
  }
  for (const input of [{}, { where: 42, why: 17 }, { where: null, why: false }, null, 'not-an-envelope']) {
    assert.deepEqual(escalationCause(input), { cause: 'unclassified', actor: null })
  }
  assert.deepEqual(escalationCause({ where: 'driver', why: 'anchor-absent in an unapplied change' }), { cause: 'plan-build-disagreement', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'scope', why: 'exceeded its 1800s budget' }), { cause: 'plan-build-disagreement', actor: 'driver' })
})

test('a budget-refused headless outcome composes the ledger budget escalation cause', () => {
  const dir = scratchDir('factory-ledger-budget-refused-')
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const crew = { checkout: dir, members: { builder: { model: 'claude-fable-5', transport: 'headless-json' } } }
  const logs = []
  try {
    const io = headlessIo({
      crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir,
      adapters: { builder: { headlessCommand: () => ({ bin: '/bin/worker', args: [], env: {} }) } },
      bin: '/bin/worker',
      deps: {
        uuid: () => 'budget-refused-session', log: (row) => logs.push(row), kill: () => {},
        spawn: () => {
          const runDir = join(taskDir, 'headless', 'd1')
          writeFileSync(join(runDir, 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } })}\n${JSON.stringify({ type: 'result', terminal_reason: 'api_error' })}\n`)
          writeFileSync(join(runDir, 'exit'), '1')
          return { pid: 7001, unref() {} }
        },
      },
    })
    const run = io.assign({ role: 'builder', briefFile: join(taskDir, 'brief.md') })
    let error
    try { io.wait(run.returnPath, 1) } catch (err) { error = err }
    assert.equal(error?.stage, 'headless-budget-refused')
    assert.ok(logs.some((row) => row.headless_outcome === 'budget-refused'))
    assert.deepEqual(escalationCause({ where: 'builder', why: error.message }), { cause: 'budget', actor: 'driver' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
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

test('T1: isoMs is symmetric across the number-to-string replay boundary', () => {
  for (const value of [0, 1, 1000, Date.now(), 253402300799999]) {
    const once = isoMs(value)
    assert.equal(isoMs(once), once, `isoMs round-trip changed ${value}`)
  }
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

test('T3: an out-of-range CLI window is a usage refusal', { skip: SKIP }, () => {
  const result = run(['seat-teardowns', '--since', '+058692-11-03T14:13:20.000Z'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /\[reason: usage\]/)
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

function makeUnenforcedSeatIndexDb() {
  const { DatabaseSync } = require('node:sqlite')
  const dir = nextDir()
  const dbPath = join(dir, 'unenforced-seat.db')
  const jsonlPath = join(dir, 'authority.jsonl')
  const db = new DatabaseSync(dbPath)
  const withheld = MIGRATIONS.filter((statement) => !(/CREATE UNIQUE INDEX/.test(statement) && /seat_teardowns/.test(statement)))
  applyMigrations(db, withheld)
  const insert = db.prepare('INSERT INTO seat_teardowns (adw_id, role, outcome, reason, forced, created_at) VALUES (?, ?, ?, ?, 0, ?)')
  insert.run('t12', 'builder', 'proven', 'exited', '2024-01-01T00:00:00.000Z')
  insert.run('t12', 'builder', 'failed', 'still-alive', '2024-01-01T00:00:00.000Z')
  db.close()
  const line = (outcome, reason) => JSON.stringify({
    v: 1, kind: 'recordSeatTeardown', at: '2024-01-01T00:00:00.000Z',
    args: { adw_id: 't12', role: 'builder', outcome, reason, forced: 0, created_at: '2024-01-01T00:00:00.000Z' },
  })
  writeFileSync(jsonlPath, `${line('proven', 'exited')}\n${line('failed', 'still-alive')}\n`)
  return { dbPath, jsonlPath }
}

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

test('cell failure attributions are a frozen axis separate from failure kinds', () => {
  assert.equal(Object.isFrozen(CELL_FAILURE_ATTRIBUTIONS), true)
  assert.deepEqual([...CELL_FAILURE_ATTRIBUTIONS], ['cell', 'host'])
  assert.equal([...CELL_FAILURE_ATTRIBUTIONS].some((value) => CELL_FAILURE_KINDS.includes(value)), false)
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
  assert.equal(runless.attribution, null)
  const inRun = rows.find((row) => row.kind === 'seat-died')
  assert.deepEqual({ adw_id: inRun.adw_id, phase_id: inRun.phase_id, dispatch_id: inRun.dispatch_id, detail: inRun.detail }, {
    adw_id: 'run-cell', phase_id: 4, dispatch_id: 'd1', detail: 'mid-run',
  })
  assert.equal(inRun.attribution, null)
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
  // The readout is BUILT from MODIFIER_KINDS/MODIFIER_ATTEMPT_OUTCOMES, so
  // comparing the payload to those exports is a mirror against itself and sees
  // no drift. Both expected sides come from somewhere ledger.mjs cannot edit:
  // the ratified #45 literal below (two of whose four kinds are crew/drive.mjs
  // constants) and drive.mjs's MODIFIER_OUTCOMES.
  // MUTATION C2: point the expected side back at [...MODIFIER_KINDS] and
  // deleting 'sensitivity-floor' from ledger.mjs goes unseen again.
  const ratifiedKinds = [FAILURE_UPGRADE, SENSITIVITY_FLOOR, 'vendor-diversity', 'budget-ceiling']
  assert.deepEqual(
    { payload: payload.modifiers, exported: [...MODIFIER_KINDS] },
    { payload: ratifiedKinds, exported: ratifiedKinds },
  )
  assert.deepEqual(payload.outcomes, [...MODIFIER_OUTCOMES])
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
  ledger.recordCellFailure({ ...common, kind: 'boot-refusal', attribution: 'host', created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordCellFailure({ ...common, kind: 'boot-refusal', created_at: '2024-01-02T00:00:00.000Z' })
  ledger.recordCellFailure({ ...common, adw_id: 'run-1', kind: 'boot-refusal', created_at: '2024-01-03T00:00:00.000Z' })
  ledger.recordCellFailure({ ...common, adw_id: 'run-1', kind: 'timeout', attribution: 'host', created_at: '2024-01-04T00:00:00.000Z' })

  const all = ledger.cellFailures()
  const boots = all.find((row) => row.kind === 'boot-refusal')
  assert.equal(boots.failures, 3)
  assert.equal(boots.run_less, 2)
  assert.equal(boots.host_attributed, 0)
  assert.equal(boots.first_at, '2024-01-01T00:00:00.000Z')
  assert.equal(boots.last_at, '2024-01-03T00:00:00.000Z')
  const timeouts = all.find((row) => row.kind === 'timeout')
  assert.equal(timeouts.host_attributed, 1)

  const bounded = ledger.cellFailures({ since: '2024-01-02T00:00:00.000Z', until: '2024-01-04T00:00:00.000Z' })
  assert.deepEqual(bounded.map(({ kind, failures, run_less, host_attributed }) => ({ kind, failures, run_less, host_attributed })), [
    { kind: 'boot-refusal', failures: 2, run_less: 1, host_attributed: 0 },
  ])
})

test('cell-failures CLI prints rows and refuses an inverted optional window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordCellFailure({
    task_slug: 'cli-failures', role: 'builder', provider: 'anthropic', model_id: 'sonnet', agent: 'claude', effort: 'high',
    kind: 'boot-refusal', created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordCellFailure({
    adw_id: 'run-cli', task_slug: 'cli-failures', role: 'builder', provider: 'anthropic', model_id: 'sonnet', agent: 'claude', effort: 'high',
    kind: 'boot-refusal', attribution: 'host', created_at: '2024-01-01T00:00:01.000Z',
  })
  const dbPath = ledger._dbPath
  ledger.close()

  const ok = run(['cell-failures'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(ok.status, 0, ok.stderr)
  const payload = JSON.parse(ok.stdout.trim())
  assert.deepEqual({ schema: payload.schema, since: payload.since, until: payload.until }, { schema: 1, since: null, until: null })
  assert.deepEqual(payload.attributions, ['cell', 'host'])
  assert.equal(payload.rows[0].kind, 'boot-refusal')
  assert.equal(payload.rows[0].run_less, 1)
  assert.equal(payload.rows[0].host_attributed, 1)

  const inverted = run([
    'cell-failures', '--since', '2024-01-02T00:00:00Z', '--until', '2024-01-01T00:00:00Z',
  ], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(inverted.status, 2)
  assert.match(inverted.stderr, /cell-failures: --until must be later than --since/)
})

test('cellReviews aggregates by cell and task class and counts only a run\'s first round', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const cellA = { agent: 'claude', provider: 'anthropic', model_id: 'cell-a', model: 'model-a', effort: 'high' }
  const cellB = { agent: 'pi', provider: 'openai', model_id: 'cell-b', model: 'model-b', effort: 'max' }
  const review = (adw_id, dispatch_id, cell, verdict, created_at) => ledger.recordReviewOutcome({
    adw_id, dispatch_id, role: 'reviewer', verdict, created_at, ...cell,
  })

  ledger.startSession({ adw_id: 'reviews-a', repo_slug: 'r', task_slug: 'a', tier: 'build' })
  review('reviews-a', 'a-r1', cellA, 'pass', '2024-01-01T00:00:00.000Z')
  review('reviews-a', 'a-r2', cellB, 'changes-needed', '2024-01-02T00:00:00.000Z')
  ledger.startSession({ adw_id: 'reviews-b', repo_slug: 'r', task_slug: 'b', tier: 'build' })
  review('reviews-b', 'b-r1', cellA, 'pass', '2024-01-03T00:00:00.000Z')
  ledger.startSession({ adw_id: 'reviews-c', repo_slug: 'r', task_slug: 'c', tier: 'judge' })
  review('reviews-c', 'c-r1', cellA, 'changes-needed', '2024-01-01T00:00:00.000Z')
  ledger.startSession({ adw_id: 'reviews-d', repo_slug: 'r', task_slug: 'd' })
  review('reviews-d', 'd-r1', cellA, 'pass', '2024-01-01T00:00:00.000Z')

  const rows = ledger.cellReviews()
  const find = (model_id, task_class) => rows.find((row) => row.model_id === model_id && row.task_class === task_class)
  assert.deepEqual(
    find('cell-a', 'build') && {
      reviews: find('cell-a', 'build').reviews,
      first_round_reviews: find('cell-a', 'build').first_round_reviews,
      first_round_passes: find('cell-a', 'build').first_round_passes,
    },
    { reviews: 2, first_round_reviews: 2, first_round_passes: 2 },
  )
  assert.deepEqual(
    find('cell-b', 'build') && {
      reviews: find('cell-b', 'build').reviews,
      first_round_reviews: find('cell-b', 'build').first_round_reviews,
      first_round_passes: find('cell-b', 'build').first_round_passes,
    },
    { reviews: 1, first_round_reviews: 0, first_round_passes: 0 },
  )
  assert.deepEqual(
    find('cell-a', 'judge') && {
      reviews: find('cell-a', 'judge').reviews,
      first_round_reviews: find('cell-a', 'judge').first_round_reviews,
      first_round_passes: find('cell-a', 'judge').first_round_passes,
    },
    { reviews: 1, first_round_reviews: 1, first_round_passes: 0 },
  )
  assert.deepEqual(
    find('cell-a', null) && {
      reviews: find('cell-a', null).reviews,
      first_round_reviews: find('cell-a', null).first_round_reviews,
      first_round_passes: find('cell-a', null).first_round_passes,
    },
    { reviews: 1, first_round_reviews: 1, first_round_passes: 1 },
  )
  ledger.close()
})

test('cellReviews keys a model-only review on its model and never splits a roster-keyed cell', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'model-keyed-reviews', repo_slug: 'r', task_slug: 'model-keyed-reviews', tier: 'build' })
  const review = (dispatch_id, cell) => ledger.recordReviewOutcome({
    adw_id: 'model-keyed-reviews', dispatch_id, role: 'reviewer', verdict: 'pass',
    created_at: '2024-01-01T00:00:00.000Z', ...cell,
  })
  review('override-review', { agent: 'pi', provider: null, model_id: null, model: 'openai-codex/gpt-5.6-sol', effort: 'high' })
  review('roster-review-one', { agent: 'pi', provider: 'openai', model_id: 'gpt-5.6-terra', model: 'openai-codex/gpt-5.6-terra', effort: 'max' })
  review('roster-review-two', { agent: 'pi', provider: 'openai', model_id: 'gpt-5.6-terra', model: 'legacy-terra', effort: 'max' })
  const rows = ledger.cellReviews()
  assert.equal(rows.reduce((total, row) => total + Number(row.reviews), 0), 3)
  const modelKeyed = rows.find((row) => row.model_key === 'openai-codex/gpt-5.6-sol')
  assert.equal(modelKeyed?.reviews, 1)
  const rosterKeyed = rows.find((row) => row.provider === 'openai' && row.model_id === 'gpt-5.6-terra')
  assert.deepEqual({ reviews: rosterKeyed?.reviews, model_key: rosterKeyed?.model_key }, { reviews: 2, model_key: null })
  assert.equal(rows.filter((row) => row.provider === 'openai' && row.model_id === 'gpt-5.6-terra').length, 1)
  ledger.close()
})

test('cells CLI reads an override-booted review as its own cell and leaves an identity-less one unattributed', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const seed = (adw_id, dispatch_id, cell = {}) => {
    ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id, tier: 'build' })
    ledger.recordReviewOutcome({
      adw_id, dispatch_id, role: 'reviewer', verdict: 'pass', created_at: '2024-01-01T00:00:00.000Z', ...cell,
    })
  }
  seed('override-cell', 'override-cell-r1', {
    agent: 'pi', provider: null, model_id: null, model: 'openai-codex/gpt-5.6-sol', effort: 'high', transport: 'pane',
  })
  for (let i = 0; i < 3; i++) seed(`identityless-${i}`, `identityless-${i}-r1`)
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout.trim())
  const modelRow = payload.rows.find((row) => row.model === 'openai-codex/gpt-5.6-sol')
  assert.equal(modelRow?.reviews, 1)
  assert.equal(modelRow?.model, 'openai-codex/gpt-5.6-sol')
  assert.ok(Object.prototype.hasOwnProperty.call(modelRow.absent, 'roster_cell'))
  assert.ok(!Object.prototype.hasOwnProperty.call(modelRow.absent, 'cell'))
  const identityless = payload.rows.find((row) => row.provider === null && row.model_id === null && row.model === null)
  assert.equal(identityless?.reviews, 3)
  assert.equal(identityless?.model, null)
  assert.match(identityless.absent.cell, /unattributed/)
  assert.ok(!Object.prototype.hasOwnProperty.call(identityless.absent, 'roster_cell'))
})

test('cells CLI prices a model-keyed cell through the adapter namespace it was booted in', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'model-priced'
  const dispatchId = 'model-priced-r1'
  const model = 'openai-codex/gpt-5.6-sol'
  assert.equal(piModelString({ provider: 'openai', id: 'gpt-5.6-sol' }), model)
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'model-priced', tier: 'build' })
  ledger.recordReviewOutcome({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', verdict: 'pass',
    agent: 'pi', provider: null, model_id: null, model, effort: 'high', transport: 'headless-json',
    created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.startAgentSession({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', model,
    claude_session_id: 'model-priced-session', transcript_path: null,
  })
  ledger.endAgentSession({
    adw_id: adwId, claude_session_id: 'model-priced-session',
    context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
    billed_input_tokens: 1_000_000, billed_output_tokens: 2_000_000,
    billed_cache_write_tokens: 0, billed_cache_read_tokens: 0,
  })
  const pricePath = join(nextDir(), 'model-priced.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'openai/gpt-5.6-sol': { cost_in_per_mtok: 5, cost_out_per_mtok: 30, cost_cache_read_per_mtok: 0.5, cost_cache_write_per_mtok: 0 } },
  }))
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model === model)
  assert.equal(row.price_key, 'openai/gpt-5.6-sol')
  assert.equal(row.cost_usd, 65)
})

test('cells CLI leaves an unmappable model string unpriced, never mispriced', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const seed = (adw_id, agent, model) => {
    ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id, tier: 'build' })
    ledger.recordReviewOutcome({
      adw_id, dispatch_id: `${adw_id}-r1`, role: 'reviewer', verdict: 'pass',
      agent, provider: null, model_id: null, model, effort: 'high', transport: 'headless-json',
      created_at: '2024-01-01T00:00:00.000Z',
    })
  }
  seed('unmappable-prefix', 'pi', 'weird-cli/gpt-5.6-sol')
  seed('unmappable-agent', 'unknown-agent', 'openai-codex/gpt-5.6-sol')
  const pricePath = join(nextDir(), 'unmappable.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'openai/gpt-5.6-sol': { cost_in_per_mtok: 5, cost_out_per_mtok: 30 } },
  }))
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout.trim()).rows
  for (const model of ['weird-cli/gpt-5.6-sol', 'openai-codex/gpt-5.6-sol']) {
    const row = rows.find((candidate) => candidate.model === model)
    assert.equal(row.price_key, null)
    assert.equal(row.cost_usd, null)
    assert.match(row.absent.price_key, new RegExp(model.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
    assert.match(row.absent.cost_usd, /unpriced/)
  }
})

test('a model-keyed cell crosses the rate floor exactly as a roster-keyed one does', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const seed = (model, count) => {
    for (let i = 0; i < count; i++) {
      const adwId = `model-floor-${model}-${i}`
      ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: adwId, tier: 'build' })
      ledger.recordReviewOutcome({
        adw_id: adwId, dispatch_id: `${adwId}-r1`, role: 'reviewer', verdict: 'pass',
        agent: 'pi', provider: null, model_id: null, model, effort: 'high', transport: 'headless-json',
        created_at: '2024-01-01T00:00:00.000Z',
      })
    }
  }
  seed('openai-codex/gpt-5.6-sol', CELL_RATE_FLOOR - 1)
  seed('openai-codex/gpt-5.6-luna', CELL_RATE_FLOOR)
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout.trim()).rows
  assert.equal(rows.find((row) => row.model === 'openai-codex/gpt-5.6-sol').thin, true)
  assert.equal(rows.find((row) => row.model === 'openai-codex/gpt-5.6-luna').thin, false)
})

test('cells CLI joins usage to the model-keyed cell that earned it', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const seed = (adwId, dispatchId, model, effort, totals) => {
    ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: adwId, tier: 'build' })
    ledger.recordReviewOutcome({
      adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', verdict: 'pass',
      agent: 'pi', provider: null, model_id: null, model, effort, transport: 'headless-json',
      created_at: '2024-01-01T00:00:00.000Z',
    })
    if (totals === null) return
    const sessionId = `${adwId}-session`
    ledger.startAgentSession({ adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', model, claude_session_id: sessionId, transcript_path: null })
    ledger.endAgentSession({
      adw_id: adwId, claude_session_id: sessionId,
      context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
      billed_input_tokens: totals[0], billed_output_tokens: totals[1],
      billed_cache_write_tokens: null, billed_cache_read_tokens: null,
    })
  }
  seed('usage-sol', 'usage-sol-r1', 'openai-codex/gpt-5.6-sol', 'high', [1_000_000, 2_000_000])
  seed('usage-luna', 'usage-luna-r1', 'openai-codex/gpt-5.6-luna', 'max', [2_000_000, 1_000_000])
  seed('usage-pane', 'usage-pane-r1', 'openai-codex/gpt-5.6-pane', 'high', null)
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout.trim()).rows
  const sol = rows.find((row) => row.model === 'openai-codex/gpt-5.6-sol')
  const luna = rows.find((row) => row.model === 'openai-codex/gpt-5.6-luna')
  const pane = rows.find((row) => row.model === 'openai-codex/gpt-5.6-pane')
  assert.deepEqual({ sessions: sol.usage_sessions, input: sol.billed_input_tokens, output: sol.billed_output_tokens }, { sessions: 1, input: 1_000_000, output: 2_000_000 })
  assert.deepEqual({ sessions: luna.usage_sessions, input: luna.billed_input_tokens, output: luna.billed_output_tokens }, { sessions: 1, input: 2_000_000, output: 1_000_000 })
  assert.equal(pane.usage_sessions, 0)
  assert.ok(Object.prototype.hasOwnProperty.call(pane.absent, 'usage'))
})

test('the cells definition block states the model key it computes', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const definition = JSON.parse(result.stdout.trim()).definition
  assert.match(definition.cell, /keyed on that model string/)
  assert.match(definition.cell, /none of the three stays unattributed/)
  assert.match(definition.cell, /two are never merged/)
  assert.match(definition.model, /^the raw override model string/)
  assert.match(definition.price_key, /never a stripped prefix/)
})

test('cells CLI reports a measured rate, a measured zero, and an unmeasured denominator', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const cell = (model_id) => ({ agent: 'claude', provider: 'anthropic', model_id, model: model_id, effort: 'high' })
  const review = (adw_id, dispatch_id, value, verdict, created_at) => ledger.recordReviewOutcome({
    adw_id, dispatch_id, role: 'reviewer', verdict, created_at, ...value,
  })
  ledger.startSession({ adw_id: 'rate-one', repo_slug: 'r', task_slug: 'rate-one', tier: 'build' })
  review('rate-one', 'rate-one-r1', cell('rate'), 'pass', '2024-01-01T00:00:00.000Z')
  ledger.startSession({ adw_id: 'rate-two', repo_slug: 'r', task_slug: 'rate-two', tier: 'build' })
  review('rate-two', 'rate-two-r1', cell('rate'), 'changes-needed', '2024-01-01T00:00:00.000Z')
  ledger.startSession({ adw_id: 'zero-one', repo_slug: 'r', task_slug: 'zero-one', tier: 'judge' })
  review('zero-one', 'zero-one-r1', cell('zero'), 'changes-needed', '2024-01-01T00:00:00.000Z')
  ledger.startSession({ adw_id: 'unknown-one', repo_slug: 'r', task_slug: 'unknown-one', tier: 'build' })
  review('unknown-one', 'unknown-one-r1', cell('other'), 'pass', '2024-01-01T00:00:00.000Z')
  review('unknown-one', 'unknown-one-r2', cell('unknown'), 'pass', '2024-01-02T00:00:00.000Z')
  const dbPath = ledger._dbPath
  ledger.close()

  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout.trim())
  assert.deepEqual(payload.verdicts, [...REVIEW_VERDICTS])
  const row = (model_id, task_class) => payload.rows.find((candidate) => candidate.model_id === model_id && candidate.task_class === task_class)
  const measured = row('rate', 'build')
  assert.equal(measured.first_round_reviews, 2)
  assert.equal(measured.first_round_passes, 1)
  assert.equal(measured.first_round_pass_rate, 0.5)
  const zero = row('zero', 'judge')
  assert.equal(zero.first_round_pass_rate, 0)
  assert.ok(!Object.prototype.hasOwnProperty.call(zero.absent, 'first_round_pass_rate'))
  const unknown = row('unknown', 'build')
  assert.equal(unknown.first_round_reviews, 0)
  assert.equal(unknown.first_round_pass_rate, null)
  assert.match(unknown.absent.first_round_pass_rate, /UNMEASURED/)
})

test('cells CLI prices a cell from the named catalog and names the units', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'priced-cell'
  const dispatchId = 'priced-cell-r1'
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'priced', tier: 'build' })
  ledger.recordReviewOutcome({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', verdict: 'pass',
    provider: 'anthropic', model_id: 'priced-model', agent: 'claude', model: 'priced', effort: 'high',
    transport: 'headless-json', created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.startAgentSession({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', model: 'priced',
    claude_session_id: 'priced-session', transcript_path: null,
  })
  ledger.endAgentSession({
    adw_id: adwId, claude_session_id: 'priced-session',
    context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
    billed_input_tokens: 2_000_000, billed_output_tokens: 3_000_000,
    billed_cache_write_tokens: 4_000_000, billed_cache_read_tokens: 5_000_000,
  })
  const pricePath = join(nextDir(), 'prices.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'anthropic/priced-model': { cost_in_per_mtok: 2, cost_out_per_mtok: 10, cost_cache_read_per_mtok: 0.2, cost_cache_write_per_mtok: 2.5 } },
  }))
  const dbPath = ledger._dbPath
  ledger.close()

  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.price_source.path, pricePath)
  assert.equal(payload.price_source.updated_at, '2024-02-01')
  assert.equal(payload.price_source.units, CELL_PRICE_UNITS)
  const row = payload.rows.find((candidate) => candidate.model_id === 'priced-model')
  assert.equal(row.cost_usd, 45)
})

test('cells prices the b168 planner seat from the shipped roster catalog', { skip: SKIP }, () => {
  const dbPath = seedCellUsage({
    tag: 'b168-planner', provider: 'anthropic', model_id: 'claude-opus-5',
    sessions: [{ in: 146, out: 32393, cw: 132204, cr: 8141239 }],
  })
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'claude-opus-5')
  assert.ok(Math.abs(row.cost_usd - 6.2032145) <= 1e-6)
  assert.ok(row.cost_usd > 7 * 0.810555)
})

test('cells prices the b168 static lead seat', { skip: SKIP }, () => {
  const dbPath = seedCellUsage({
    tag: 'b168-lead', provider: 'anthropic', model_id: 'claude-opus-5',
    sessions: [{ in: 2, out: 7, cw: 13650, cr: 18545 }],
  })
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'claude-opus-5')
  assert.ok(Math.abs(row.cost_usd - 0.1459575) <= 1e-6)
  assert.ok(row.cost_usd > 700 * 0.000185)
})

test('a model with no cache rate is unpriced, never partly priced', { skip: SKIP }, () => {
  const dbPath = seedCellUsage({
    tag: 'cache-less', provider: 'anthropic', model_id: 'cache-less-model',
    sessions: [{ in: 1_000_000, out: 2_000_000, cw: 3_000_000, cr: 4_000_000 }],
  })
  const pricePath = join(nextDir(), 'cache-less.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'anthropic/cache-less-model': { cost_in_per_mtok: 5, cost_out_per_mtok: 25 } },
  }))
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'cache-less-model')
  assert.equal(row.cost_usd, null)
  assert.ok(row.absent.cost_usd.includes(USAGE_ABSENT_CAUSES.cache_unpriced))
  assert.match(row.absent.cost_usd, /cost_cache_read_per_mtok/)
  assert.match(row.absent.cost_usd, /cost_cache_write_per_mtok/)
})

test('an unmeasured token class in ONE member of a cell leaves the whole cell unpriced', { skip: SKIP }, () => {
  const pricePath = join(nextDir(), 'mixed-rated.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'anthropic/mixed-model': {
      cost_in_per_mtok: 5, cost_out_per_mtok: 25,
      cost_cache_read_per_mtok: 0.5, cost_cache_write_per_mtok: 10,
    } },
  }))
  const complete = { in: 1_000_000, out: 2_000_000, cw: 3_000_000, cr: 4_000_000 }
  for (const [column, field] of [
    ['billed_input_tokens', 'in'],
    ['billed_output_tokens', 'out'],
    ['billed_cache_read_tokens', 'cr'],
    ['billed_cache_write_tokens', 'cw'],
  ]) {
    const dbPath = seedCellUsage({
      tag: `mixed-${field}`, provider: 'anthropic', model_id: 'mixed-model',
      sessions: [complete, { ...complete, [field]: null }],
    })
    const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
    assert.equal(result.status, 0, result.stderr)
    const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'mixed-model')
    assert.equal(row[column], null)
    assert.equal(row.cost_usd, null)
    assert.match(row.absent.cost_usd, new RegExp(column))
  }
})

test('a published zero cache-write rate is priced, not treated as absent', { skip: SKIP }, () => {
  const dbPath = seedCellUsage({
    tag: 'zero-cache-write', provider: 'openai', model_id: 'zero-cache-write-model',
    sessions: [{ in: 1_000_000, out: 2_000_000, cw: 3_000_000, cr: 4_000_000 }],
  })
  const pricePath = join(nextDir(), 'zero-cache-write.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'openai/zero-cache-write-model': {
      cost_in_per_mtok: 5, cost_out_per_mtok: 25,
      cost_cache_read_per_mtok: 0.5, cost_cache_write_per_mtok: 0,
    } },
  }))
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'zero-cache-write-model')
  assert.ok(Number.isFinite(row.cost_usd))
  assert.equal(Object.prototype.hasOwnProperty.call(row.absent, 'cost_usd'), false)
})

test('CELL_PRICE_UNITS describes what cells computes', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout.trim())
  assert.doesNotMatch(CELL_PRICE_UNITS, /NOT priced/)
  assert.match(CELL_PRICE_UNITS, /cost_cache_read_per_mtok/)
  assert.match(CELL_PRICE_UNITS, /cost_cache_write_per_mtok/)
  assert.equal(payload.definition.cost_usd, CELL_PRICE_UNITS)
  assert.equal(payload.price_source.units, CELL_PRICE_UNITS)
})

test('every roster model carries its ratified cache rates and their provenance', () => {
  const roster = JSON.parse(readFileSync(join(ROOT, 'crew', 'roster.json'), 'utf8'))
  const expectedRates = {
    'anthropic/claude-opus-5': { read: 0.5, write: 10 },
    'anthropic/claude-sonnet-5': { read: 0.2, write: 4 },
    'anthropic/claude-haiku-4-5': { read: 0.1, write: 2 },
    'anthropic/claude-fable-5': { read: 1, write: 20 },
    'openai/gpt-5.6-sol': { read: 0.4, write: 0 },
    'openai/gpt-5.6-terra': { read: 0.2, write: 0 },
    'openai/gpt-5.6-luna': { read: 0.02, write: 0 },
  }
  const expectedSources = {
    anthropic: "anthropic published prompt-caching multipliers applied to this entry's own cost_in_per_mtok: cache read 0.10x, 1h-TTL cache write 2.00x. billed_cache_write_tokens collapses the 1h and 5m TTLs into one column, so pricing every cache write at the 1h rate is an explicit lossy convention, not a reconstruction of any session's TTL; 1h is the ratified one because this task's acceptance figures require it and because both sampled b168-paneusage claude-opus-5 pane seats used only 1h writes.",
    openai: "openai published prompt-caching rates applied to this entry's own cost_in_per_mtok: cached input 0.10x, and cache writes are not charged, so cost_cache_write_per_mtok is a published 0.00x rate rather than an absent one.",
  }
  assert.deepEqual(Object.keys(roster.models).sort(), Object.keys(expectedRates).sort())
  for (const [key, expected] of Object.entries(expectedRates)) {
    const model = roster.models[key]
    assert.deepEqual({ read: model.cost_cache_read_per_mtok, write: model.cost_cache_write_per_mtok }, expected)
    assert.ok(Math.abs(model.cost_cache_read_per_mtok - model.cost_in_per_mtok * 0.10) <= 1e-12)
    const vendor = key.slice(0, key.indexOf('/'))
    assert.equal(model.cache_rate_source, expectedSources[vendor])
  }
})

test('cells CLI reads an unpriced model as unpriced, never as free', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'unpriced-cell'
  const dispatchId = 'unpriced-cell-r1'
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'unpriced', tier: 'build' })
  ledger.recordReviewOutcome({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', verdict: 'pass',
    provider: 'anthropic', model_id: 'missing-model', agent: 'claude', model: 'missing', effort: 'high',
    transport: 'headless-json', created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.startAgentSession({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', model: 'missing',
    claude_session_id: 'unpriced-session', transcript_path: null,
  })
  ledger.endAgentSession({
    adw_id: adwId, claude_session_id: 'unpriced-session',
    context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
    billed_input_tokens: 1_000_000, billed_output_tokens: 2_000_000,
    billed_cache_write_tokens: null, billed_cache_read_tokens: null,
  })
  const pricePath = join(nextDir(), 'empty-prices.json')
  writeFileSync(pricePath, JSON.stringify({ schema_version: 1, updated_at: '2024-02-01', models: {} }))
  const dbPath = ledger._dbPath
  ledger.close()

  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'missing-model')
  assert.equal(row.cost_usd, null)
  assert.match(row.absent.cost_usd, /unpriced/)

  const missing = run(['cells', '--prices', join(nextDir(), 'does-not-exist.json')], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /cells: --prices must be a readable JSON price catalog with a models object/)
})

test('cells CLI treats null catalog rates as unpriced, never free', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'null-rate-cell'
  const dispatchId = 'null-rate-cell-r1'
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'null-rate', tier: 'build' })
  ledger.recordReviewOutcome({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', verdict: 'pass',
    provider: 'anthropic', model_id: 'null-rate-model', agent: 'claude', model: 'null-rate', effort: 'high',
    transport: 'headless-json', created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.startAgentSession({
    adw_id: adwId, dispatch_id: dispatchId, role: 'reviewer', model: 'null-rate',
    claude_session_id: 'null-rate-session', transcript_path: null,
  })
  ledger.endAgentSession({
    adw_id: adwId, claude_session_id: 'null-rate-session',
    context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
    billed_input_tokens: 1_000_000, billed_output_tokens: 2_000_000,
    billed_cache_write_tokens: null, billed_cache_read_tokens: null,
  })
  const pricePath = join(nextDir(), 'null-rates.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'anthropic/null-rate-model': { cost_in_per_mtok: null, cost_out_per_mtok: null } },
  }))
  const dbPath = ledger._dbPath
  ledger.close()

  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'null-rate-model')
  assert.equal(row.cost_usd, null)
  assert.match(row.absent.cost_usd, /unpriced/)
})

test('cells CLI carries the denominator and the sample floor with every rate', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const seed = (model_id, count) => {
    for (let i = 0; i < count; i++) {
      const adwId = `floor-${model_id}-${i}`
      ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: adwId, tier: 'build' })
      ledger.recordReviewOutcome({
        adw_id: adwId, dispatch_id: `${adwId}-r1`, role: 'reviewer', verdict: 'pass',
        provider: 'anthropic', model_id, agent: 'claude', model: model_id, effort: 'high',
        transport: 'headless-json', created_at: '2024-01-01T00:00:00.000Z',
      })
    }
  }
  seed('under-floor', CELL_RATE_FLOOR - 1)
  seed('at-floor', CELL_RATE_FLOOR)
  const dbPath = ledger._dbPath
  ledger.close()

  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.rate_floor, CELL_RATE_FLOOR)
  for (const row of payload.rows) assert.ok(Number.isInteger(row.first_round_reviews))
  assert.equal(payload.rows.find((row) => row.model_id === 'under-floor').thin, true)
  assert.equal(payload.rows.find((row) => row.model_id === 'at-floor').thin, false)
})

test("cells CLI leaves a pane-only cell's usage unmeasured, never zero", { skip: SKIP }, () => {
  const cell = { agent: 'pi', provider: 'openai', id: 'pane-model', model: 'pane', effort: 'high', transport: 'pane' }
  const { dbPath } = paneReviewRun(cell)
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.model_id === 'pane-model')
  assert.equal(row.usage_sessions, 0)
  for (const key of ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']) {
    assert.equal(row[key], null)
  }
  assert.equal(row.absent.usage, USAGE_ABSENT_CAUSES.pane)
})

test('cells CLI reads an unattributed review as no cell', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'no-cell', repo_slug: 'r', task_slug: 'no-cell', tier: 'build' })
  ledger.recordReviewOutcome({
    adw_id: 'no-cell', dispatch_id: 'no-cell-r1', verdict: 'pass', created_at: '2024-01-01T00:00:00.000Z',
  })
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout.trim()).rows.find((candidate) => candidate.provider === null && candidate.model_id === null)
  assert.ok(row)
  assert.equal(row.agent, null)
  assert.equal(row.effort, null)
  assert.equal(row.role, null)
  assert.match(row.absent.cell, /unattributed/)
})

test('cells CLI is read-only', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'read-only', repo_slug: 'r', task_slug: 'read-only', tier: 'build' })
  ledger.recordReviewOutcome({ adw_id: 'read-only', dispatch_id: 'read-only-r1', verdict: 'pass' })
  const before = Object.fromEntries(Object.keys(TABLES).map((name) => [name, ledger.dumpTable(name).length]))
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const afterLedger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const after = Object.fromEntries(Object.keys(TABLES).map((name) => [name, afterLedger.dumpTable(name).length]))
    assert.deepEqual(after, before)
  } finally { afterLedger.close() }
})

test('cells CLI refuses a positional, an inverted window and an unknown flag', { skip: SKIP }, () => {
  const positional = run(['cells', 'oops'])
  assert.equal(positional.status, 2)
  assert.match(positional.stderr, /cells: takes no positional arguments/)
  const inverted = run(['cells', '--since', '2024-01-02T00:00:00Z', '--until', '2024-01-01T00:00:00Z'])
  assert.equal(inverted.status, 2)
  assert.match(inverted.stderr, /cells: --until must be later than --since/)
  const unknown = run(['cells', '--nope', 'x'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown flag --nope/)
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

test('taskReadout and ledger task carry typed run outcomes while marking legacy rows absent', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-typed-outcome', repo_slug: 'r', task_slug: 'typed-outcome' })
  ledger.endSession({
    adw_id: 'task-typed-outcome', status: 'aborted', outcome: 'escalated',
    terminal_reason: 'budget', terminal_actor: 'driver', ended_at: '2024-01-01T00:00:01.000Z',
  })
  const readout = ledger.taskReadout('task-typed-outcome')
  assert.deepEqual({
    outcome: readout.session.outcome,
    terminal_reason: readout.session.terminal_reason,
    terminal_actor: readout.session.terminal_actor,
  }, { outcome: 'escalated', terminal_reason: 'budget', terminal_actor: 'driver' })
  assert.equal(Object.hasOwn(readout.absent, 'outcome'), false)

  ledger.startSession({ adw_id: 'task-legacy-outcome', repo_slug: 'r', task_slug: 'legacy-outcome' })
  const legacy = ledger.taskReadout('task-legacy-outcome')
  assert.equal(legacy.session.outcome, null)
  assert.match(legacy.absent.outcome, /predates typed run outcomes/)

  const dbPath = ledger._dbPath
  ledger.close()
  const cli = run(['task', 'task-typed-outcome'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(cli.status, 0, cli.stderr)
  const payload = JSON.parse(cli.stdout)
  assert.deepEqual({
    outcome: payload.session.outcome,
    terminal_reason: payload.session.terminal_reason,
    terminal_actor: payload.session.terminal_actor,
  }, { outcome: 'escalated', terminal_reason: 'budget', terminal_actor: 'driver' })
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
    outcome: 'this run predates typed run outcomes (#779) — sessions.status carries the legacy verdict alone; NULL is never a measured outcome, and no historical row is backfilled by inference',
    context_occupancy: 'no live transport records occupancy — pane seats land no agent_sessions row at all; headless-json/headless-rpc land rows with both columns NULL; context_window has no verified source (U-4); see docs/ledger-queries.md',
    usage: `this run has no agent_sessions rows: ${USAGE_ABSENT_CAUSES.transport_unrecorded}`,
    gate_discrimination: 'predates gate discrimination (#168)',
    review_outcomes: 'predates structured review outcomes (#169/#170)',
    accept_decisions: 'predates typed accept decisions (#170)',
    gate_results: 'predates gate verdict recording (#130)',
    phases: 'no phase rows recorded for this run',
    variant: "this run's first recorded event is not a shape marker — the run shape is unmeasured (#251), never a measured \"full\"",
  })
  assert.match(readout.absent.usage, /per-agent token measurement \(#119\)/)
  assert.notEqual(readout.absent.usage, `this run has no agent_sessions rows: ${USAGE_ABSENT_CAUSES.pane}`)
})

test('usageAbsentCause names pane, recorded non-pane, and unattributable states', { skip: SKIP }, () => {
  assert.equal(usageAbsentCause(['pane']), USAGE_ABSENT_CAUSES.pane)
  assert.equal(usageAbsentCause(['pane', 'pane']), USAGE_ABSENT_CAUSES.pane)
  assert.equal(usageAbsentCause(['pane', 'headless-rpc']), USAGE_ABSENT_CAUSES.measured_transport)
  assert.equal(usageAbsentCause(['headless-json']), USAGE_ABSENT_CAUSES.measured_transport)
  assert.equal(usageAbsentCause([]), USAGE_ABSENT_CAUSES.transport_unrecorded)
  assert.equal(usageAbsentCause(undefined), USAGE_ABSENT_CAUSES.transport_unrecorded)
  assert.match(USAGE_ABSENT_CAUSES.pane, /no pane runner emits a usage frame into the ledger adapter/)
  assert.doesNotMatch(USAGE_ABSENT_CAUSES.pane, /#119/)
  assert.match(USAGE_ABSENT_CAUSES.transport_unrecorded, /per-agent token measurement \(#119\)/)
})

test('transportsFor unions every declared transport table and preserves absence', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const mixed = 'transport-map-mixed'
  const empty = 'transport-map-empty'
  ledger.recordSeatTeardown({ adw_id: mixed, role: 'builder', transport: 'pane', outcome: 'proven' })
  ledger.recordModifierAttempt({ adw_id: mixed, role: 'builder', modifier: 'failure-upgrade', outcome: 'applied', transport: 'headless-rpc' })

  const transports = ledger.transportsFor([mixed, empty])
  assert.deepEqual([...transports.get(mixed)].sort(), ['headless-rpc', 'pane'])
  assert.equal(transports.has(empty), false)
})

test('taskReadout names the pane structural cause for a pane-only run', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-pane-usage', repo_slug: 'r', task_slug: 'pane-usage' })
  ledger.recordSeatTeardown({ adw_id: 'task-pane-usage', role: 'builder', transport: 'pane', outcome: 'proven' })

  const marker = ledger.taskReadout('task-pane-usage').absent.usage
  assert.equal(marker, `this run has no agent_sessions rows: ${USAGE_ABSENT_CAUSES.pane}`)
  assert.match(marker, /no pane runner emits a usage frame into the ledger adapter/)
  assert.doesNotMatch(marker, /per-agent token measurement \(#119\)/)
})

test('taskReadout names a recorded non-pane cause without naming pane or #119', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-headless-usage', repo_slug: 'r', task_slug: 'headless-usage' })
  ledger.recordSeatTeardown({ adw_id: 'task-headless-usage', role: 'builder', transport: 'headless-rpc', outcome: 'proven' })

  const marker = ledger.taskReadout('task-headless-usage').absent.usage
  assert.equal(marker, `this run has no agent_sessions rows: ${USAGE_ABSENT_CAUSES.measured_transport}`)
  assert.doesNotMatch(marker, /no pane runner emits a usage frame into the ledger adapter/)
  assert.doesNotMatch(marker, /per-agent token measurement \(#119\)/)
})

test('taskReadout distinguishes rows with unbilled usage from missing rows', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'task-unbilled-usage', repo_slug: 'r', task_slug: 'unbilled-usage' })
  ledger.startAgentSession({
    adw_id: 'task-unbilled-usage', dispatch_id: 'unbilled-dispatch', role: 'builder', model: 'sonnet',
    claude_session_id: 'unbilled-claude', transcript_path: '/tmp/unbilled-claude.jsonl',
  })

  const marker = ledger.taskReadout('task-unbilled-usage').absent.usage
  assert.equal(marker, `this run's usage is absent: ${USAGE_ABSENT_CAUSES.unbilled_rows}`)
})

test('taskReadout and run-set draw the same pane cause', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'same-pane-cause', RUNSET_SINCE)
  ledger.recordSeatTeardown({ adw_id: 'same-pane-cause', role: 'builder', transport: 'pane', outcome: 'proven' })
  const taskMarker = ledger.taskReadout('same-pane-cause').absent.usage
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const windowMarker = JSON.parse(res.stdout).absent.usage
  assert.ok(taskMarker.includes(USAGE_ABSENT_CAUSES.pane))
  assert.ok(windowMarker.includes(USAGE_ABSENT_CAUSES.pane))
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
  const replayed = replayJsonl(jsonlPath, ledger)
  assert.equal(replayed.failed, 1)
  assert.equal(replayed.complete, false)
  assert.ok(replayed.first_failure)
  assert.doesNotMatch(replayed.first_failure.reason, new RegExp(MARKER_NONCE_ONLY))
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
  assert.equal(session.outcome, 'failed')
  assert.equal(session.terminal_reason, 'SIGTERM')
  assert.equal(session.terminal_actor, 'finalizer')
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
// #541: allocate-then-confirm and collapse readout pins
// ---------------------------------------------------------------------------

// #541: two live emitters on one adw_id lose no record.
test('#541: two live emitters on one adw_id lose no record', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const emitter = join(dir, 'emitter.mjs')
  writeFileSync(emitter, `
    import { openLedger } from ${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)}
    import { existsSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    const [dbPath, dir, tag] = process.argv.slice(2)
    const ledger = openLedger({ dbPath })
    writeFileSync(join(dir, 'ready.' + tag), '')
    const other = tag === 'A' ? 'B' : 'A'
    const deadline = Date.now() + 10000
    while (!existsSync(join(dir, 'ready.' + other)) && Date.now() < deadline) {}
    for (let i = 0; i < 25; i += 1) {
      ledger.recordEvent({ adw_id: '541-race', type: 'log', payload: { level: 'info', message: tag + ':' + i } })
    }
    ledger.close()
  `)
  const childA = trackChild(spawn(process.execPath, [emitter, dbPath, dir, 'A'], { stdio: 'ignore' }))
  const childB = trackChild(spawn(process.execPath, [emitter, dbPath, dir, 'B'], { stdio: 'ignore' }))
  assert.notEqual(childA.pid, process.pid, 'the emitter must be a REAL second process')
  assert.notEqual(childB.pid, process.pid, 'the emitter must be a REAL second process')
  const [exitA, exitB] = await Promise.all([
    new Promise((resolve) => childA.on('exit', (code) => resolve(code))),
    new Promise((resolve) => childB.on('exit', (code) => resolve(code))),
  ])
  assert.equal(exitA, 0, 'emitter A crashed')
  assert.equal(exitB, 0, 'emitter B crashed')
  const jsonlEvents = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((line) => line.kind === 'recordEvent')
  assert.equal(jsonlEvents.length, 50)
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    assert.equal(ledger.dumpTable('events').filter((row) => row.adw_id === '541-race').length, 50)
    const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
    try {
      replayJsonl(jsonlPath, rebuilt)
      assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-race').length, 50)
    } finally { rebuilt.close() }
  } finally { ledger.close() }
})

// #541: a degraded handle's spent sequence numbers are not re-issued.
test('#541: degraded-then-healthy allocation preserves distinct authority seqs', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const degraded = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    for (let i = 0; i < 5; i += 1) {
      degraded.recordEvent({ adw_id: '541-degraded', type: 'log', payload: { level: 'info', message: `degraded-${i}` } })
    }
  } finally { degraded.close() }
  const healthy = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  try {
    for (let i = 0; i < 5; i += 1) {
      healthy.recordEvent({ adw_id: '541-degraded', type: 'log', payload: { level: 'info', message: `healthy-${i}` } })
    }
  } finally { healthy.close() }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-degraded')
  assert.equal(lines.length, 10)
  assert.equal(new Set(lines.map((line) => line.args.seq)).size, 10)
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  try {
    replayJsonl(jsonlPath, rebuilt)
    assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-degraded').length, 10)
  } finally { rebuilt.close() }
})

// #541: an explicit seq advances a degraded handle's memoized authority floor.
test('#541: explicit sequence advances the degraded allocator floor', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const ledger = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    ledger.recordEvent({ adw_id: '541-explicit-floor', type: 'log', payload: { level: 'info', message: 'automatic-1' } })
    ledger.recordEvent({ adw_id: '541-explicit-floor', seq: 2, type: 'log', payload: { level: 'info', message: 'explicit-2' } })
    ledger.recordEvent({ adw_id: '541-explicit-floor', type: 'log', payload: { level: 'info', message: 'automatic-3' } })
  } finally { ledger.close() }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-explicit-floor')
  assert.deepEqual(lines.map((line) => line.args.seq), [1, 2, 3])
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  try {
    replayJsonl(jsonlPath, rebuilt)
    assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-explicit-floor').length, 3)
  } finally { rebuilt.close() }
})

// #541: an empty memoized floor scans prior authority before an explicit write.
test('#541: explicit sequence floor scans prior degraded authority', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const first = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    first.recordEvent({ adw_id: '541-explicit-scan', seq: 2, type: 'log', payload: { level: 'info', message: 'explicit-2' } })
  } finally { first.close() }
  const second = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    second.recordEvent({ adw_id: '541-explicit-scan', seq: 1, type: 'log', payload: { level: 'info', message: 'explicit-1' } })
    second.recordEvent({ adw_id: '541-explicit-scan', type: 'log', payload: { level: 'info', message: 'automatic-3' } })
  } finally { second.close() }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-explicit-scan')
  assert.deepEqual(lines.map((line) => line.args.seq), [2, 1, 3])
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  try {
    replayJsonl(jsonlPath, rebuilt)
    assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-explicit-scan').length, 3)
  } finally { rebuilt.close() }
})

// #541: a different-content duplicate key is visible without changing drift.
test('#541: the detector reports a collapsed key', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.recordEvent({ adw_id: '541-collapse', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  const first = JSON.parse(readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)[0])
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ ...first, args: { ...first.args, payload: { level: 'info', message: 'second' } } })}\n`)
  const ledger = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  try {
    const drift = ledger.jsonlDrift()
    assert.equal(drift.collapsed_lines_total, 1)
    assert.equal(drift.collapse_remedy, DRIFT_COLLAPSE_REMEDY)
    assert.equal(drift.writers.find((writer) => writer.writer === 'recordEvent').collapsed_keys, 1)
    assert.equal(drift.drift_total, 0)
  } finally { ledger.close() }
})

// #541: repeats with identical content are idempotent, not collapse.
test('#541: the detector discriminates idempotent repeats from collapse', { skip: SKIP }, () => {
  const source = openTestLedger()
  try {
    for (let i = 0; i < 3; i += 1) {
      source.recordEvent({ adw_id: '541-identical', seq: 1, type: 'log', payload: { level: 'info', message: 'same' } })
    }
    let drift = source.jsonlDrift()
    assert.equal(drift.collapsed_lines_total, 0)
    assert.equal(drift.collapse_remedy, null)
    assert.equal(drift.drift_total, 0)
  } finally { source.close() }

  const sourceAgain = openTestLedger()
  sourceAgain.recordEvent({ adw_id: '541-replay', seq: 1, type: 'log', payload: { level: 'info', message: 'same' } })
  const sourcePath = sourceAgain._jsonlPath
  sourceAgain.close()
  const target = openTestLedger({ jsonlPath: sourcePath })
  try {
    replayJsonl(sourcePath, target)
    replayJsonl(sourcePath, target)
    const drift = target.jsonlDrift()
    assert.equal(drift.collapsed_lines_total, 0)
    assert.equal(drift.collapse_remedy, null)
    assert.equal(drift.drift_total, 0)
  } finally { target.close() }
})

// #541: an explicit different-content collision is counted by stats.
test('#541: the collision is visible in stats()', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.recordEvent({ adw_id: '541-stats', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
    ledger.recordEvent({ adw_id: '541-stats', seq: 1, type: 'log', payload: { level: 'info', message: 'different' } })
    const collided = ledger.stats()
    assert.equal(collided.seq_collisions, 1)
    assert.equal(collided.mirror_errors, 1)
    ledger.recordEvent({ adw_id: '541-stats', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
    const replayed = ledger.stats()
    assert.equal(replayed.seq_collisions, collided.seq_collisions)
    assert.equal(replayed.mirror_errors, collided.mirror_errors)
  } finally { ledger.close() }
})

// #541: doctor names a measured key collapse independently of drift.
test('#541: the doctor CLI names a key collapse', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.recordEvent({ adw_id: '541-doctor', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  const first = JSON.parse(readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)[0])
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ ...first, args: { ...first.args, payload: { level: 'info', message: 'second' } } })}\n`)
  const result = run(['doctor'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /key collapse/)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.jsonl_drift.collapsed_lines_total, 1)
})

// ---------------------------------------------------------------------------
// S12: cheap missing negative tests
// ---------------------------------------------------------------------------

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
// #443: unknown CLI flags are refusals, not silent defaults
// ---------------------------------------------------------------------------

test('#443: run-set refuses an unknown flag and preserves the bounded answer for the correct spelling', { skip: SKIP }, () => {
  const refused = run(['run-set', '--since', '2026-08-21T00:00:00Z', '--untill', '2026-08-21T01:00:00Z'])
  assert.equal(refused.status, 2, refused.stderr)
  assert.equal(refused.stdout, '')
  assert.match(refused.stderr, /unknown flag --untill/)

  const accepted = run(['run-set', '--since', '2026-08-21T00:00:00Z', '--until', '2026-08-21T01:00:00Z'])
  assert.equal(accepted.status, 0, accepted.stderr)
  const payload = JSON.parse(accepted.stdout)
  assert.equal(payload.until, '2026-08-21T01:00:00.000Z')
  assert.notEqual(payload.since, null)
})

test('#443: every documented CLI flag remains accepted', { skip: SKIP }, () => {
  const since = '2026-08-21T00:00:00Z'
  const until = '2026-08-21T01:00:00Z'
  const dir = nextDir()
  const runDir = join(dir, 'advisor-run')
  mkdirSync(join(runDir, 'returns'), { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), '')
  writeFileSync(join(dir, 'prices.json'), JSON.stringify({ schema_version: 1, updated_at: since, models: {} }))
  const adjudications = join(dir, 'adjudications.json')
  writeFileSync(adjudications, JSON.stringify({ schema: 1, adjudications: [] }))
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, '# Task\n## The ask\n\nUse the accepted flag\n')

  const cases = [
    { verb: 'tail', flag: 'after', args: ['tail', 'cli-1', '--after', '0', '--limit', '1'] },
    { verb: 'tail', flag: 'limit', args: ['tail', 'cli-1', '--after', '0', '--limit', '1'] },
    { verb: 'run-set', flag: 'since', args: ['run-set', '--since', since, '--until', until] },
    { verb: 'run-set', flag: 'until', args: ['run-set', '--since', since, '--until', until] },
    { verb: 'cell-failures', flag: 'since', args: ['cell-failures', '--since', since, '--until', until] },
    { verb: 'cell-failures', flag: 'until', args: ['cell-failures', '--since', since, '--until', until] },
    { verb: 'cells', flag: 'since', args: ['cells', '--since', since, '--until', until] },
    { verb: 'cells', flag: 'until', args: ['cells', '--since', since, '--until', until] },
    { verb: 'cells', flag: 'prices', args: ['cells', '--prices', join(dir, 'prices.json')] },
    { verb: 'modifier-attempts', flag: 'since', args: ['modifier-attempts', '--since', since, '--until', until] },
    { verb: 'modifier-attempts', flag: 'until', args: ['modifier-attempts', '--since', since, '--until', until] },
    { verb: 'seat-teardowns', flag: 'since', args: ['seat-teardowns', '--since', since, '--until', until] },
    { verb: 'seat-teardowns', flag: 'until', args: ['seat-teardowns', '--since', since, '--until', until] },
    { verb: 'escalations', flag: 'since', args: ['escalations', '--since', since, '--until', until] },
    { verb: 'escalations', flag: 'until', args: ['escalations', '--since', since, '--until', until] },
    { verb: 'ci-cycles', flag: 'since', args: ['ci-cycles', '--since', since, '--until', until] },
    { verb: 'ci-cycles', flag: 'until', args: ['ci-cycles', '--since', since, '--until', until] },
    { verb: 'intake-sweeps', flag: 'since', args: ['intake-sweeps', '--since', since, '--until', until] },
    { verb: 'intake-sweeps', flag: 'until', args: ['intake-sweeps', '--since', since, '--until', until] },
    { verb: 'request', flag: 'from-brief', args: ['request', 'accepted-request', '--from-brief', brief] },
    { verb: 'advisor-ab', flag: 'run-dir', args: ['advisor-ab', '--run-dir', runDir, '--run-started-at', since, '--adjudications', adjudications, 'd1'] },
    { verb: 'advisor-ab', flag: 'run-started-at', args: ['advisor-ab', '--run-dir', runDir, '--run-started-at', since, '--adjudications', adjudications, 'd1'] },
    { verb: 'advisor-ab', flag: 'adjudications', args: ['advisor-ab', '--run-dir', runDir, '--run-started-at', since, '--adjudications', adjudications, 'd1'] },
    { verb: 'kill', flag: 'adw-id', args: ['kill', '--adw-id', 'no-such-adw', '--pid', '999999', '--yes'] },
    { verb: 'kill', flag: 'pid', args: ['kill', '--adw-id', 'no-such-adw', '--pid', '999999', '--yes'] },
    { verb: 'kill', flag: 'yes', args: ['kill', '--adw-id', 'no-such-adw', '--pid', '999999', '--yes'] },
  ]
  for (const { verb, flag, args } of cases) {
    const result = run(args)
    assert.doesNotMatch(result.stderr, /unknown flag/, `${verb} --${flag} was refused as unknown: ${result.stderr}`)
  }
})

test('#443: flagless subcommands refuse an unknown flag', { skip: SKIP }, () => {
  for (const verb of ['sessions', 'phases', 'procs', 'task', 'gate-review-gap', 'eligible-tasks', 'doctor']) {
    const result = run([verb, '--nope', 'x'])
    assert.equal(result.status, 2, `${verb}: ${result.stderr}`)
    assert.match(result.stderr, /unknown flag --nope/)
  }
})

test('#443: every window subcommand refuses the misspelled flag', { skip: SKIP }, () => {
  for (const verb of ['run-set', 'cell-failures', 'cells', 'modifier-attempts', 'seat-teardowns', 'escalations', 'ci-cycles', 'intake-sweeps']) {
    const result = run([verb, '--sicne', '2026-08-21T00:00:00Z'])
    assert.equal(result.status, 2, `${verb}: ${result.stderr}`)
    assert.match(result.stderr, /unknown flag --sicne/)
  }
})

test('#443: success, usage refusal, and unexpected internal error retain distinct exit codes', { skip: SKIP }, () => {
  const success = run(['sessions'])
  assert.equal(success.status, 0, success.stderr)

  const refusal = run(['sessions', '--nope', 'x'])
  assert.equal(refusal.status, 2, refusal.stderr)
  assert.match(refusal.stderr, /unknown flag --nope/)

  const url = new URL('../scripts/factory/ledger.mjs', import.meta.url).href
  const source = [
    `const { main } = await import(${JSON.stringify(url)});`,
    "process.stdout.write = () => { throw new Error('test-induced internal failure') };",
    "process.exitCode = main(['sessions']);",
  ].join('\n')
  const internal = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_LEDGER_DB: join(nextDir(), 'ledger.db') },
  })
  assert.equal(internal.status, 1, internal.stderr)
})

test('escalations CLI prints grouped causes and refuses unbounded or invalid windows', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'cli-escalation-driver', repo_slug: 'r', task_slug: 'cli-escalation-driver' })
  ledger.endSession({ adw_id: 'cli-escalation-driver', status: 'aborted', outcome: 'escalated', terminal_reason: 'transport', terminal_actor: 'driver', ended_at: '2024-01-02T00:00:00.000Z' })
  ledger.startSession({ adw_id: 'cli-escalation-lead', repo_slug: 'r', task_slug: 'cli-escalation-lead' })
  ledger.endSession({ adw_id: 'cli-escalation-lead', status: 'aborted', outcome: 'escalated', terminal_reason: 'transport', terminal_actor: 'lead', ended_at: '2024-01-02T00:00:01.000Z' })
  const dbPath = ledger._dbPath
  ledger.close()

  const result = run(['escalations', '--since', '2024-01-02T00:00:00Z', '--until', '2024-01-02T00:01:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schema, 1)
  assert.equal(payload.question, 'How many lanes did the factory lose to itself, and to what?')
  assert.equal(payload.measured, true)
  assert.equal(payload.escalated, 2)
  assert.deepEqual(payload.rows.map(({ cause, actor, count }) => ({ cause, actor, count })), [
    { cause: 'transport', actor: 'driver', count: 1 },
    { cause: 'transport', actor: 'lead', count: 1 },
  ])
  assert.deepEqual(payload.absent, null)

  for (const args of [
    ['escalations'],
    ['escalations', '--since', 'not-a-timestamp'],
    ['escalations', '--since', '2024-01-02T00:01:00Z', '--until', '2024-01-02T00:00:00Z'],
    ['escalations', '--since', '2024-01-02T00:00:00Z', '--unexpected', 'x'],
  ]) {
    const refused = run(args)
    assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stderr}`)
    assert.match(refused.stderr, /escalations/)
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

function readerFixture() {
  const ledger = openTestLedger()
  const run = 'reader-run'
  seedRun(ledger, run, '2024-01-02T00:00:00.000Z', 'ok')
  seedRun(ledger, 'reader-old', '2024-01-01T00:00:00.000Z', 'fail')
  seedRun(ledger, 'reader-until', '2024-01-03T00:00:00.000Z', 'ok')
  const phaseId = ledger.startPhase({ adw_id: run, name: 'plan', started_at: '2024-01-02T00:00:01.000Z' })
  ledger.recordEvent({
    adw_id: run, type: 'agent_start', phase_id: phaseId,
    payload: { role: 'builder', model: 'reader-model', dispatch_id: 'reader-dispatch' },
    started_at: '2024-01-02T00:00:02.000Z',
  })
  ledger.recordEvent({
    adw_id: run, type: 'agent_end', phase_id: phaseId,
    payload: { role: 'builder', outcome: 'done', dispatch_id: 'reader-dispatch' },
    ended_at: '2024-01-02T00:00:03.000Z',
  })
  ledger.startAgentSession({
    adw_id: run, dispatch_id: 'reader-dispatch', role: 'builder', model: 'reader-model',
    claude_session_id: 'reader-session', transcript_path: null,
    started_at: '2024-01-02T00:00:04.000Z',
  })
  ledger.endAgentSession({
    adw_id: run, claude_session_id: 'reader-session', ended_at: '2024-01-02T00:00:05.000Z',
    context_tokens: 10, context_window: 100, raw_read_tokens: 8, raw_written_tokens: 9,
    billed_input_tokens: 11, billed_output_tokens: 12, billed_cache_write_tokens: 13, billed_cache_read_tokens: 14,
  })
  ledger.recordGateDiscrimination({
    adw_id: run, phase_id: phaseId, gate_generation: 2, verdict: 'proven',
    checks_total: 4, checks_failed: 0, checks_errored: 0, note: 'reader-proof',
    created_at: '2024-01-02T00:00:06.000Z',
  })
  ledger.recordGateResult({
    adw_id: run, phase_id: phaseId, gate_name: 'reader-gate', attempt: 1, ok: true,
    checks: [{ item: 'reader', ok: true }], violations: [], gate_generation: 2, pristine: false,
    created_at: '2024-01-02T00:00:07.000Z',
  })
  ledger.recordReviewOutcome({
    adw_id: run, phase_id: phaseId, dispatch_id: 'reader-review', role: 'reviewer', verdict: 'pass',
    must_fix: 0, should_fix: 1, consider: 2, created_at: '2024-01-02T00:00:08.000Z',
  })
  ledger.recordAcceptDecision({
    adw_id: run, phase_id: phaseId, where: 'reader-review', outcome: 'accepted',
    findings_total: 1, residual_count: 0, refuted_count: 1, cosmetic_count: 0, unverified_count: 0,
    created_at: '2024-01-02T00:00:09.000Z',
  })
  ledger.recordCellFailure({
    adw_id: run, phase_id: phaseId, dispatch_id: 'reader-failure', role: 'builder',
    agent: 'pi', provider: 'openai', model_id: 'reader-model', effort: 'high', transport: 'pane',
    kind: 'seat-died', stage: 'reader-stage', detail: 'reader-detail', created_at: '2024-01-02T00:00:10.000Z',
  })
  ledger.recordCellFailure({
    adw_id: null, role: 'builder', kind: 'boot-refusal', created_at: '2024-01-02T00:00:11.000Z',
  })
  ledger.recordCellFailure({
    adw_id: 'reader-missing-run', role: 'builder', kind: 'timeout', created_at: '2024-01-02T00:00:12.000Z',
  })
  ledger.recordSeatTeardown({
    adw_id: run, phase_id: phaseId, role: 'builder', transport: 'pane', outcome: 'proven',
    reason: 'reader-exit', created_at: '2024-01-02T00:00:13.000Z',
  })
  ledger.recordIntakeSweep({
    board_owner: 'reader-owner', board_project: 1, outcome: 'picked', considered: 2, pages: 1,
    picked_issue: 12, created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordIntakeSweep({
    board_owner: 'reader-owner', board_project: 1, outcome: 'picked', considered: 1, pages: 1,
    picked_issue: 11, created_at: '2024-01-02T00:00:14.000Z',
  })
  ledger.recordIntakeSweep({
    board_owner: 'reader-owner', board_project: 1, outcome: 'none', considered: 0, pages: 1,
    created_at: '2024-01-03T00:00:00.000Z',
  })
  ledger.recordIntakeRefusal({
    board_owner: 'reader-owner', board_project: 1, issue: 13, reason: 'stop-switch',
    detail: 'reader-refusal', priority: 'P1', issue_created_at: '2023-12-31T00:00:00.000Z',
    created_at: '2024-01-02T00:00:15.000Z',
  })
  return { ledger, run, phaseId }
}

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
    assert.deepEqual(reader.runSet(options), writable.runSet(options))
    assert.deepEqual(reader.intakeSweeps(options), writable.intakeSweeps(options))
    assert.deepEqual(reader.intakeRefusals(options), writable.intakeRefusals(options))
  } finally { reader.close(); writable.close() }
})

test('runSet keeps runs and null billing when agent_sessions is absent', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'legacy.db')
  const conn = new (require('node:sqlite').DatabaseSync)(dbPath)
  conn.exec(`CREATE TABLE sessions (
    adw_id TEXT PRIMARY KEY, repo_slug TEXT, task_slug TEXT, started_at TEXT,
    ended_at TEXT, status TEXT, billed_input_tokens INTEGER,
    billed_output_tokens INTEGER, billed_cache_write_tokens INTEGER,
    billed_cache_read_tokens INTEGER
  )`)
  conn.prepare('INSERT INTO sessions (adw_id, repo_slug, task_slug, started_at, status) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-run', 'repo', 'legacy', RUNSET_SINCE, 'ok')
  conn.close()
  const ledger = openLedger({ dbPath, readOnly: true, stderr: { write: () => {} } })
  try {
    const rows = ledger.runSet({ since: RUNSET_SINCE })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].adw_id, 'legacy-run')
    assert.equal(rows[0].agent_sessions, 0)
    for (const key of ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']) assert.equal(rows[0][key], null)
  } finally { ledger.close() }
})

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

test('run-set names the pane structural cause for a pane-only window', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'runset-pane-a', RUNSET_SINCE)
  seedRun(ledger, 'runset-pane-b', '2026-08-15T00:01:00.000Z')
  ledger.recordSeatTeardown({ adw_id: 'runset-pane-a', role: 'builder', transport: 'pane', outcome: 'proven' })
  ledger.recordSeatTeardown({ adw_id: 'runset-pane-b', role: 'builder', transport: 'pane', outcome: 'proven' })
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE, '--until', RUNSET_UNTIL], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.absent.usage, `no run in this window has an agent_sessions row: ${USAGE_ABSENT_CAUSES.pane}`)
  assert.match(payload.absent.usage, /no pane runner emits a usage frame into the ledger adapter/)
  assert.doesNotMatch(payload.absent.usage, /#119/)
})

test('run-set keeps no-transport windows unattributable', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'runset-no-transport-a', RUNSET_SINCE)
  seedRun(ledger, 'runset-no-transport-b', '2026-08-15T00:01:00.000Z')
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE, '--until', RUNSET_UNTIL], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.absent.usage, `no run in this window has an agent_sessions row: ${USAGE_ABSENT_CAUSES.transport_unrecorded}`)
  assert.match(payload.absent.usage, /per-agent token measurement \(#119\)/)
  assert.notEqual(payload.absent.usage, `no run in this window has an agent_sessions row: ${USAGE_ABSENT_CAUSES.pane}`)
})

test('run-set gives a mixed transport window the recorded non-pane cause', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  seedRun(ledger, 'runset-mixed-pane', RUNSET_SINCE)
  seedRun(ledger, 'runset-mixed-headless', '2026-08-15T00:01:00.000Z')
  ledger.recordSeatTeardown({ adw_id: 'runset-mixed-pane', role: 'builder', transport: 'pane', outcome: 'proven' })
  ledger.recordSeatTeardown({ adw_id: 'runset-mixed-headless', role: 'builder', transport: 'headless-json', outcome: 'proven' })
  const dbPath = ledger._dbPath
  ledger.close()

  const res = run(['run-set', '--since', RUNSET_SINCE, '--until', RUNSET_UNTIL], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.absent.usage, `no run in this window has an agent_sessions row: ${USAGE_ABSENT_CAUSES.measured_transport}`)
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

test('the intake-sweeps CLI prints dispatches beside sweeps and refusals', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const sweepAt = '2024-01-01T00:00:00.000Z'
  const dispatchAt = '2024-01-01T00:00:01.000Z'
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 7, outcome: 'none', considered: 0, pages: 1, created_at: sweepAt })
  ledger.recordIntakeDispatch({ board_owner: 'owner', board_project: 7, issue: 4, outcome: 'claimed', created_at: dispatchAt })
  const refusalAt = '2024-01-01T00:00:02.000Z'
  ledger.recordIntakeRefusal({ board_owner: 'owner', board_project: 7, issue: 5, reason: 'stop-switch', created_at: refusalAt })
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['intake-sweeps'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.deepEqual(payload.dispatch_outcomes, [...INTAKE_DISPATCH_OUTCOMES])
  const expectedSweepRows = [{ outcome: 'none', reason: null, count: 1, first_at: sweepAt, last_at: sweepAt }]
  assert.deepEqual(payload.rows, expectedSweepRows, 'the sweeps the title names must appear in the payload')
  const expectedDispatchRows = [{ outcome: 'claimed', reason: null, count: 1, first_at: dispatchAt, last_at: dispatchAt }]
  assert.deepEqual(payload.dispatches, expectedDispatchRows, 'the dispatches the title names must appear in the payload')
  const refusalRows = payload.refusal_rows
  assert.deepEqual(refusalRows, [{ reason: 'stop-switch', count: 1, first_at: refusalAt, last_at: refusalAt }])
})

test('ci-cycles CLI marks an unwatched window as not measured', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['ci-cycles', '--since', '2030-01-01T00:00:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.measured, false)
  assert.equal(payload.watched, null)
  assert.equal(payload.caught, null)
  assert.ok(payload.absent?.ci_cycles)
})

test('ci-cycles CLI reports a measured zero for a watched window with nothing reproduced', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordCiCycle({
    branch: 'main', head_sha: 'ci-head-1', check_name: 'test', cycle: 1,
    conclusion: 'success', classification: 'green', decision: 'none',
  })
  ledger.recordCiCycle({
    branch: 'main', head_sha: 'ci-head-2', check_name: 'test', cycle: 1,
    conclusion: 'success', classification: 'green', decision: 'none',
  })
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['ci-cycles'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.measured, true)
  assert.equal(payload.watched, 2)
  assert.equal(payload.caught, 0)
  assert.equal(payload.absent, null)
})

test('intake-sweeps CLI marks an unswept window as not measured', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['intake-sweeps', '--since', '2030-01-01T00:00:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.measured, false)
  for (const key of ['swept', 'picked', 'parked']) assert.equal(payload[key], null)
  assert.ok(payload.absent?.intake_sweeps)
})

test('intake-sweeps CLI reports a measured zero for a swept window that picked nothing', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 7, outcome: 'none', considered: 0, pages: 1 })
  const dbPath = ledger._dbPath
  ledger.close()
  const res = run(['intake-sweeps'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.measured, true)
  assert.equal(payload.swept, 1)
  assert.equal(payload.picked, 0)
  assert.equal(payload.parked, 0)
  assert.equal(payload.absent, null)
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

test('doctor reports the retired processes reason beside an empty row count', { skip: SKIP }, () => {
  const dbPath = join(nextDir(), 'doctor-retired-processes.db')
  const res = run(['doctor'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.row_counts.processes, 0)
  assert.ok(typeof payload.retired_tables.processes === 'string' && payload.retired_tables.processes.length >= 40)
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

test('sessions ends with typed outcomes and starts each row with all six appended fields NULL', { skip: SKIP }, () => {
  assert.deepEqual(TABLES.sessions.columns.slice(-3).map(({ name }) => name), [
    'outcome', 'terminal_reason', 'terminal_actor',
  ])
  assert.equal(TABLES.sessions.columns.at(-4).name, 'proposed_strength')
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

test('openRun records the effective task profile, execution shape and assurance from the boot decision', { skip: SKIP }, () => {
  const booted = bootTieredRun('build', {
    profile: { requested: 'implementation', effective: 'implementation', source: 'explicit' },
    execution: { requested: null, effective: 'full', source: 'profile_recommendation' },
    assurance: { requested: 'standard', effective: 'standard', source: 'explicit' },
  })
  assert.equal(booted.tier, 'build')
  assert.equal(booted.configuration.task_profile, 'implementation')
  assert.equal(booted.configuration.task_profile_source, 'explicit')
  assert.equal(booted.configuration.effective_execution, 'full')
  assert.equal(booted.configuration.execution_source, 'profile_recommendation')
  assert.equal(booted.configuration.requested_assurance, 'standard')
  assert.equal(booted.configuration.effective_assurance, 'standard')
  assert.equal(booted.configuration.assurance_source, 'explicit')
  assert.equal(booted.configuration.legacy_tier, 'build')
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

test('a sessions table predating the typed outcome columns upgrades without backfilling any existing value', { skip: SKIP }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = join(nextDir(), 'outcome-upgrade.db')
  const db = new DatabaseSync(dbPath)
  const older = TABLES.sessions.columns.filter(({ name }) => !['outcome', 'terminal_reason', 'terminal_actor'].includes(name))
  const names = older.map(({ name }) => name)
  try {
    db.exec(`CREATE TABLE sessions (${older.map(({ name, decl }) => `"${name}" ${decl}`).join(', ')})`)
    const values = names.map((name) => name === 'adw_id' ? 'historical-proposal' : name === 'tier' ? 'build' : null)
    db.prepare(`INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values)
    const before = db.prepare('SELECT * FROM sessions WHERE adw_id = ?').get('historical-proposal')
    applyMigrations(db)
    const after = db.prepare('SELECT * FROM sessions WHERE adw_id = ?').get('historical-proposal')
    for (const name of names) assert.deepEqual(after[name], before[name], `existing session column changed: ${name}`)
    assert.equal(after.outcome, null)
    assert.equal(after.terminal_reason, null)
    assert.equal(after.terminal_actor, null)
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

test('proposal fields and the run configuration row replay through JSONL', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.startSession({
    adw_id: 'proposal-replay', repo_slug: 'r', task_slug: 't',
    proposed_shape: 'mechanical', proposed_strength: 'workhorse',
  })
  source.recordRunConfiguration({
    adw_id: 'proposal-replay', schema_version: 1,
    task_profile: 'implementation', task_profile_source: 'explicit',
    requested_execution: null, effective_execution: 'full', execution_source: 'profile_recommendation',
    requested_assurance: 'standard', effective_assurance: 'standard', assurance_source: 'explicit',
    legacy_variant: null, legacy_tier: 'build',
  })
  const target = openTestLedger()
  assert.deepEqual(replayJsonl(source._jsonlPath, target), {
    applied: 2, skipped: 0, failed: 0, complete: true, first_failure: null,
  })
  const row = target.getSession('proposal-replay')
  assert.equal(row.proposed_shape, 'mechanical')
  assert.equal(row.proposed_strength, 'workhorse')
  const configuration = target.dumpTable('run_configurations')[0]
  assert.equal(configuration.task_profile, 'implementation')
  assert.equal(configuration.effective_execution, 'full')
  assert.equal(configuration.effective_assurance, 'standard')
})

test('ledger query docs pin typed outcome columns, the closed cause vocabulary, and the escalations recipe', () => {
  const docs = readFileSync(join(ROOT, 'docs', 'ledger-queries.md'), 'utf8')
  for (const field of ['sessions.outcome', 'sessions.terminal_reason', 'sessions.terminal_actor']) {
    assert.ok(docs.includes(`\`${field}\``), `docs missing ${field}`)
  }
  for (const cause of [...ESCALATION_CAUSES, 'unclassified']) {
    assert.equal((docs.match(new RegExp('`' + cause + '`', 'g')) || []).length, 1, `${cause} must appear as a backticked vocabulary member exactly once`)
  }
  assert.match(docs, /ledger\.mjs escalations --since <iso>/)
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
  const endedAt = Date.parse('2026-01-02T03:04:10.010Z')
  ledger.endSession({ adw_id: adwId, status: 'ok', ended_at: endedAt })
  ledger.heartbeat({ adw_id: adwId, target: 'session', at: Date.parse('2026-01-02T03:04:20.020Z') })
  const afterEnd = ledger.getSession(adwId)
  assert.equal(afterEnd.last_heartbeat_at, isoMs(secondAt))
  assert.equal(afterEnd.ended_at, isoMs(endedAt))
  assert.ok(Date.parse(afterEnd.last_heartbeat_at) <= Date.parse(afterEnd.ended_at))
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
  assert.deepEqual(replayJsonl(source._jsonlPath, target), {
    applied: 2, skipped: 0, failed: 0, complete: true, first_failure: null,
  })
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

test('WRITER_MIRROR_TABLES and UPDATE_ONLY_WRITERS classify every WRITERS name exactly once, and every mapped table declares a unique key', () => {
  const mapped = Object.keys(WRITER_MIRROR_TABLES)
  const updateOnly = [...UPDATE_ONLY_WRITERS]
  assert.equal(new Set(mapped).size, mapped.length)
  assert.equal(new Set(updateOnly).size, updateOnly.length)
  assert.deepEqual(mapped.filter((writer) => updateOnly.includes(writer)), [])
  assert.deepEqual([...new Set([...mapped, ...updateOnly])].sort(), [...WRITERS].sort())
  for (const table of Object.values(WRITER_MIRROR_TABLES)) {
    assert.ok(TABLES[table])
    assert.ok(Array.isArray(TABLES[table].unique) && TABLES[table].unique.length > 0)
  }
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

// #821 — the runtime ledger sandbox
const SANDBOX_LEDGER_URL = new URL('../scripts/factory/ledger.mjs', import.meta.url).href
const SANDBOX_DEFAULT_RESOLVER = ['default', 'Db', 'Path'].join('')

function runSandboxChild(source, home, extra = {}) {
  const script = join(home, 'sandbox-child.mjs')
  writeFileSync(script, `${source}\n`)
  const env = { ...process.env, HOME: home }
  delete env.DEVTEAM_LEDGER_DB
  delete env.DEVTEAM_LEDGER_DIR
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8', env,
  })
}

test('home-default resolution refuses from a process under node --test', () => {
  const home = scratchDir('factory-ledger-home-default-')
  const source = [
    `import { ${SANDBOX_DEFAULT_RESOLVER} } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    'let result',
    `try { ${SANDBOX_DEFAULT_RESOLVER}(); result = { threw: false } } catch (err) { result = { threw: true, name: err?.name, message: err?.message } }`,
    'process.stdout.write(JSON.stringify(result))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout.trim())
  assert.equal(result.threw, true)
  assert.equal(result.name, 'LedgerUsageError')
  assert.match(result.message, /DEVTEAM_LEDGER_DB/)
  assert.match(result.message, /scripts\/factory\/ledger\.mjs/)
})

test('explicit database and directory paths still resolve under node --test', () => {
  const home = scratchDir('factory-ledger-explicit-')
  const explicitDb = join(home, 'x.db')
  const explicitDir = join(home, 'explicit-dir')
  const source = [
    `import { ${SANDBOX_DEFAULT_RESOLVER} } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    `const dbPath = ${SANDBOX_DEFAULT_RESOLVER}()`,
    'delete process.env.DEVTEAM_LEDGER_DB',
    `const dirPath = ${SANDBOX_DEFAULT_RESOLVER}()`,
    'process.stdout.write(JSON.stringify({ dbPath, dirPath }))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home, {
    DEVTEAM_LEDGER_DB: explicitDb,
    DEVTEAM_LEDGER_DIR: explicitDir,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout.trim()), { dbPath: explicitDb, dirPath: join(explicitDir, 'ledger.db') })
})

test('openLedger refuses the home default under node --test without creating state', () => {
  const home = scratchDir('factory-ledger-open-home-')
  const source = [
    "import { homedir } from 'node:os'",
    "import { join } from 'node:path'",
    `import { openLedger } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    "const dbPath = join(homedir(), '.dev-team', 'factory', 'ledger.db')",
    'let result',
    'try {',
    "  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })",
    '  ledger.close()',
    '  result = { threw: false }',
    '} catch (err) {',
    '  result = { threw: true, name: err?.name, message: err?.message }',
    '}',
    'process.stdout.write(JSON.stringify(result))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout.trim())
  assert.equal(result.threw, true)
  assert.equal(result.name, 'LedgerUsageError')
  assert.equal(existsSync(join(home, '.dev-team')), false)
})

test('the crew home-default spawn shape is refused before any ledger state lands', () => {
  const home = scratchDir('factory-ledger-crew-shape-')
  const source = [
    "import { homedir } from 'node:os'",
    "import { join } from 'node:path'",
    `import { openLedger } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    'const dbPath = process.env.DEVTEAM_LEDGER_DB',
    "  || join(process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')",
    'let result',
    'try {',
    "  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })",
    "  ledger.startSession({ adw_id: 'b350-test-spawn', repo_slug: 'test', task_slug: 'home-default' })",
    '  ledger.close()',
    '  result = { threw: false }',
    '} catch (err) {',
    '  result = { threw: true, name: err?.name, message: err?.message }',
    '}',
    'process.stdout.write(JSON.stringify(result))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout.trim())
  assert.equal(result.threw, true)
  assert.equal(result.name, 'LedgerUsageError')
  assert.equal(existsSync(join(home, '.dev-team')), false)
})

test('outside a test process the home-default resolution and open remain unchanged', { skip: SKIP }, () => {
  const home = scratchDir('factory-ledger-production-')
  const source = [
    `import { ${SANDBOX_DEFAULT_RESOLVER}, openLedger } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    `const dbPath = ${SANDBOX_DEFAULT_RESOLVER}()`,
    "const ledger = openLedger({ dbPath, stderr: { write: () => {} } })",
    "ledger.startSession({ adw_id: 'b350-test-production', repo_slug: 'test', task_slug: 'production' })",
    'ledger.close()',
    'process.stdout.write(JSON.stringify({ dbPath }))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home, { NODE_TEST_CONTEXT: undefined })
  assert.equal(child.status, 0, child.stderr)
  const expected = join(home, '.dev-team', 'factory', 'ledger.db')
  assert.deepEqual(JSON.parse(child.stdout.trim()), { dbPath: expected })
  assert.equal(existsSync(expected), true)
})
