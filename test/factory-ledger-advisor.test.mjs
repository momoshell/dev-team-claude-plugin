import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync, readdirSync, statSync,
} from 'node:fs'

import { join } from 'node:path'

import { spawnSync, spawn } from 'node:child_process'

import { ROOT, scratchDir } from './helpers.mjs'

import {
  openLedger, replayJsonl, isoMs, TABLES, MIGRATIONS, applyMigrations, DRIVER_GONE_THRESHOLD_MS, DRIVER_STATES, RUN_OBSERVATION_SOURCES, RUN_OBSERVATION_COLUMNS, RUN_OBSERVATION_WRITE_VERB, SESSION_STATUSES, SESSION_OUTCOMES, SEAT_VALUE_SOURCES, TERMINAL_ACTORS, ESCALATION_CAUSE_UNCLASSIFIED, ESCALATION_CAUSE_RULE_GAP, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError, MODIFIER_KINDS, INTAKE_DISPATCH_OUTCOMES, SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, CELL_FAILURE_ATTRIBUTIONS, RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage, REQUEST_MAX_CHARS, USAGE_ABSENT_CAUSES, usageAbsentCause, AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS, CELL_RATE_FLOOR, SCREENER_PROPOSAL_OUTCOMES, CELL_PRICE_UNITS, REVIEW_VERDICTS, PHASE_SLOT_WAIT_KINDS, PHASE_SLOT_WAIT_DEPTH_ABSENT, PHASE_SLOT_WAIT_ABSENT, NARRATION_OUTCOMES, EVAL_ENVELOPE_STATUSES, EVAL_ABSENT_REASONS, EVAL_PAYLOAD_KEYS, ingestJournal, ingestExternalFenceRegister, JOURNAL_FACT_KEYS, JOURNAL_FACT_EVENTS, ADVISOR_SPEND_COVERAGE, PLANNER_SYMBOLS_ARMS, PLANNER_SYMBOLS_SAMPLE_FLOOR, bootstrapPercentile,
} from '../scripts/factory/ledger.mjs'

import { FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, VARIANT_NAMES, SUITE_SLOT_PHASE_NAMES, anchorAbsentWhy, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS } from '../crew/drive.mjs'

import { emitAdapter, SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS } from '../crew/seat-io.mjs'

import { modelString as piModelString } from '../crew/adapters/adapter-pi.mjs'

import { _resetNoticeGuardsForTest, openRun, parseProposalBrief } from '../scripts/factory/emit.mjs'

import { loadDurableEscalationRecord, proposalFromResponse, proposalPrompt, triageEscalation } from '../scripts/factory/escalation-triage.mjs'

import { bootTieredRun } from './factory-ledger.test.mjs'

import { NONCE_PREFIX, SCRIPT, require, SQLITE_OK, SKIP, bootBriefRun, fixture, paneReviewRun, trackChild, nextDir, run, openTestLedger, openB499Ledger, seedCellUsage, makeUnenforcedSeatIndexDb, exerciseEveryWriter, seedTaskAgentSession, MARKER_ADW, seedAllWritersWithMarker, MARKER_PLAIN, MARKER_NONCE_ONLY, CALIBRATED_RENDEZVOUS_DELAY_MS, CALIBRATED_RENDEZVOUS_DELAYS_MS, resolveRendezvousDelayMs, runConcurrentEmitterTrial, RUNSET_SINCE, RUNSET_UNTIL, seedRun, seedConfigurationRun, seedConfigurationSeat, EXECUTION_AXIS_BOOT_CONFIGURATION, executionAxisState, writeExecutionAxisCrew, writeExecutionAxisJournal, executionAxisRuntime, executionAxisRow, readerFixture, ADVISOR_AB_EPOCH, advisorAbFixture, advisorAbEnvelope, advisorAbFinding, runAdvisorAb, advisorReasons, advisorNote, SANDBOX_LEDGER_URL, SANDBOX_DEFAULT_RESOLVER, runSandboxChild, B381_PROVIDER_FAILURE_LINE, B395_SLOT_WAIT_GATE_LINE, B395_SLOT_WAIT_WARM_LINE, B395_SLOT_WAIT_COLD_LINE, B395_OLD_CORPUS_LINES, B381_PLAN_SCOPE_LINE, B381_TIMEOUT_REASK_LINE, B381_RPC_EXIT_LINE, B381_PLAN_ADOPTION_LINE, B381_EXTERNAL_REGISTER, ingestJournalLine, journalFactsCli, measuredJournalFactsDb, assertMeasuredAndAbsent, writeTurnsCorpusJournal, turnsCorpusPayload, builderTurnRole, holdoutLedger, addHoldoutLane, holdoutRows, TRIAGE_MODEL, makeTriageFixture, triageLedger, triageResponse } from './factory-ledger.test.mjs'




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
  const advisorStart = source.indexOf("if (verb === 'advisor-ab')")
  // AC-13 in test/factory-ledger-floor.test.mjs forbids this file from naming the CLI-only
  // resolver, so the needle is assembled the way that check assembles its own.
  const advisorEnd = source.indexOf(`const dbPath = ${['default', 'Db', 'Path'].join('')}()`, advisorStart)
  const advisorReadoutStart = source.indexOf('export function advisorAbReadout')
  const advisorReadoutEnd = source.indexOf('export function evalsReadout', advisorReadoutStart)
  assert.ok(advisorStart >= 0 && advisorEnd > advisorStart)
  assert.ok(advisorReadoutStart >= 0 && advisorReadoutEnd > advisorReadoutStart)
  assert.doesNotMatch(`${source.slice(advisorStart, advisorEnd)}\n${source.slice(advisorReadoutStart, advisorReadoutEnd)}`, /readdir|opendir|globSync/)
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
test('a request that times out is endpoint-timeout, by TimeoutError as AbortSignal.timeout names it', { skip: SKIP }, async () => {
  const { ledger } = triageLedger()
  const id = 'timeout-run'
  const crewDir = makeTriageFixture({ id, ledger })
  const durableRecord = loadDurableEscalationRecord({ crewDir, ledger })
  const result = await triageEscalation({ durableRecord, endpoint: 'http://triage.test/v1', model: TRIAGE_MODEL, ledger }, {
    request: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) },
  })
  assert.deepEqual(result, { recorded: false, reason: 'endpoint-timeout' })
  assert.equal(ledger.escalationProposalFor(id), null)
})

test('a durable read interrupted by a TimeoutError is diagnosed ABORT_ERR and -interrupted, never treated as absent', { skip: SKIP }, () => {
  const { ledger } = triageLedger()
  const crewDir = makeTriageFixture({ id: 'read-timeout', ledger })
  const record = loadDurableEscalationRecord({ crewDir, ledger }, {
    readdirSync: () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) },
  })
  const hit = record.diagnostics.find((d) => d.source === 'streams')
  assert.ok(hit, 'a streams diagnostic is recorded')
  assert.equal(hit.reason, 'streams-interrupted')
  assert.equal(hit.code, 'ABORT_ERR')
})

test('A1 escalation proposal remains separate from measured outcome', { skip: SKIP }, async (t) => {
  const { dir, ledger } = triageLedger()
  const id = 'a1-run'
  try {
    const crewDir = makeTriageFixture({ id, ledger })
    const durableRecord = loadDurableEscalationRecord({ crewDir, ledger })
    const measuredBefore = JSON.stringify(ledger.getSession(id))
    const result = await triageEscalation({ durableRecord, endpoint: 'http://triage.test/v1', model: TRIAGE_MODEL, ledger }, {
      request: async () => triageResponse('budget', 'budget evidence'),
    })
    assert.deepEqual(result, { recorded: true, reason: 'recorded' })
    assert.equal(JSON.stringify(ledger.getSession(id)), measuredBefore)
    assert.equal(ledger.getSession(id).terminal_reason, ESCALATION_CAUSE_UNCLASSIFIED)
    const proposal = ledger.escalationProposalFor(id)
    assert.deepEqual({ ...proposal }, {
      adw_id: id, proposed_cause: 'budget', proposed_by: TRIAGE_MODEL,
      proposed_evidence: 'budget evidence', created_at: proposal.created_at,
    })
    assert.equal(ledger.getSession(id).proposed_cause, undefined)
    assert.equal(UPDATE_ONLY_WRITERS.includes('recordEscalationProposal'), false)
    assert.equal(WRITER_MIRROR_TABLES.recordEscalationProposal, 'escalation_proposals')
    const drift = ledger.jsonlDrift()
    const proposalDrift = drift.writers.find((writer) => writer.writer === 'recordEscalationProposal')
    assert.equal(proposalDrift?.drift, 0)
    assert.equal(proposalDrift?.rows_present, 1)

    const unavailable = openLedger({
      dbPath: join(dir, 'unavailable.db'),
      jsonlPath: join(dir, 'unavailable.jsonl'),
      nodeVersion: '0.0.0',
      stderr: { write() {} },
    })
    try {
      unavailable.startSession({ adw_id: 'a1-mirror-unavailable', repo_slug: 'test', task_slug: 'unavailable' })
      unavailable.endSession({
        adw_id: 'a1-mirror-unavailable', status: 'fail', outcome: 'escalated',
        terminal_reason: ESCALATION_CAUSE_UNCLASSIFIED, terminal_actor: 'driver',
      })
      assert.deepEqual(unavailable.recordEscalationProposal({
        adw_id: 'a1-mirror-unavailable', proposed_cause: 'budget', proposed_by: TRIAGE_MODEL, proposed_evidence: 'unavailable mirror',
      }), { recorded: false, reason: 'mirror-unavailable' })
    } finally { unavailable.close() }

    const duplicateRecord = loadDurableEscalationRecord({ crewDir, ledger })
    let duplicateCalls = 0
    const duplicate = await triageEscalation({ durableRecord: duplicateRecord, endpoint: 'http://triage.test', model: TRIAGE_MODEL, ledger }, {
      request: async () => { duplicateCalls += 1; return triageResponse('infrastructure', 'must not replace first proposal') },
    })
    assert.deepEqual(duplicate, { recorded: false, reason: 'already-proposed' })
    assert.equal(duplicateCalls, 0)
    assert.equal(ledger.escalationProposalFor(id).proposed_cause, 'budget')

    const replayed = openLedger({ dbPath: join(dir, 'replay.db'), stderr: { write() {} } })
    try {
      const replay = replayJsonl(ledger._jsonlPath, replayed)
      assert.equal(replay.failed, 0)
      assert.equal(replayed.escalationProposalFor(id).proposed_cause, 'budget')
      assert.equal(replayed.getSession(id).terminal_reason, ESCALATION_CAUSE_UNCLASSIFIED)
    } finally { replayed.close() }
    await t.test('proposal writer is classified as an insert mirror', () => {
      assert.equal(WRITER_MIRROR_TABLES.recordEscalationProposal, 'escalation_proposals')
    })
  } finally { ledger.close() }
})
test('B1 escalation proposal records its proposing model', { skip: SKIP }, async () => {
  const { ledger } = triageLedger()
  const id = 'b1-run'
  try {
    const crewDir = makeTriageFixture({ id, ledger })
    const durableRecord = loadDurableEscalationRecord({ crewDir, ledger })
    const exactModel = 'local/triage-model-2026'
    const result = await triageEscalation({ durableRecord, endpoint: 'http://triage.test', model: exactModel, ledger }, {
      request: async () => triageResponse('infrastructure', 'model provenance evidence'),
    })
    assert.equal(result.recorded, true)
    assert.equal(ledger.escalationProposalFor(id).proposed_by, exactModel)
  } finally { ledger.close() }
})
test('C1 escalation triage degradation is an inert no-op', { skip: SKIP }, async () => {
  const { ledger } = triageLedger()
  const cases = [
    { id: 'c1-missing', endpoint: undefined, request: async () => { throw new Error('must not call') }, reason: 'endpoint-unconfigured' },
    { id: 'c1-dead', endpoint: 'http://dead.test', request: async () => ({ ok: false, status: 503 }), reason: 'endpoint-failed' },
    { id: 'c1-throw', endpoint: 'http://throw.test', request: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }, reason: 'endpoint-failed' },
  ]
  try {
    const edgeDir = makeTriageFixture({ id: 'c1-edge', ledger })
    writeFileSync(join(edgeDir, 'task', 'headless', 'd1', 'stream.jsonl'), '')
    mkdirSync(join(edgeDir, 'task', 'headless', 'd2'), { recursive: true })
    writeFileSync(join(edgeDir, 'task', 'headless', 'd2', 'stream.jsonl'), '{"torn":')
    const edgeRecord = loadDurableEscalationRecord({ crewDir: edgeDir, ledger })
    assert.ok(edgeRecord.diagnostics.some(({ reason }) => reason === 'stream-d1-empty'))
    assert.ok(edgeRecord.diagnostics.some(({ reason }) => reason === 'stream-d2-torn-final'))
    for (const code of ['ENOENT', 'EPERM', 'EINTR']) {
      const interrupted = loadDurableEscalationRecord({ crewDir: edgeDir, ledger }, {
        readFileSync: () => { throw Object.assign(new Error(code), { code }) },
        readdirSync: () => { throw Object.assign(new Error(code), { code }) },
      })
      assert.ok(interrupted.diagnostics.some((entry) => entry.code === code))
    }

    const malformedDir = makeTriageFixture({ id: 'c1-malformed', ledger })
    const malformedRecord = loadDurableEscalationRecord({ crewDir: malformedDir, ledger })
    let writerCalls = 0
    const originalWriter = ledger.recordEscalationProposal
    ledger.recordEscalationProposal = (...args) => { writerCalls += 1; return originalWriter(...args) }
    const malformed = await triageEscalation({ durableRecord: malformedRecord, endpoint: 'http://malformed.test', model: TRIAGE_MODEL, ledger }, {
      request: async () => ({ ok: true, status: 200, json: async () => '{not-json' }),
    })
    assert.deepEqual(malformed, { recorded: false, reason: 'response-invalid' })

    for (const item of cases) {
      const crewDir = makeTriageFixture({ id: item.id, ledger })
      const durableRecord = loadDurableEscalationRecord({ crewDir, ledger })
      let calls = 0
      const callerSentinel = { progress: 'before' }
      let result
      await assert.doesNotReject(async () => {
        const pending = triageEscalation({ durableRecord, endpoint: item.endpoint, model: TRIAGE_MODEL, ledger }, {
          request: async (...args) => { calls += 1; return item.request(...args) },
        })
        callerSentinel.progress = 'after'
        result = await pending
      })
      assert.equal(callerSentinel.progress, 'after')
      assert.deepEqual(result, { recorded: false, reason: item.reason })
      assert.equal(calls, item.endpoint ? 1 : 0)
      assert.equal(writerCalls, 0)
      assert.equal(ledger.escalationProposalFor(item.id), null)
    }
  } finally { ledger.close() }
})
test('D1 b332 and b333 durable records propose budget', { skip: SKIP }, async () => {
  const { ledger } = triageLedger()
  try {
    for (const id of ['b332', 'b333']) {
      const crewDir = makeTriageFixture({
        id,
        ledger,
        streamEvidence: `${id}: local model budget exhaustion evidence`,
        returnMarker: `${id}-durable-return`,
      })
      const durableRecord = loadDurableEscalationRecord({ crewDir, ledger })
      assert.equal(escalationCause(durableRecord.escalation).cause, ESCALATION_CAUSE_RULE_GAP)
      assert.match(JSON.stringify(durableRecord.streams), new RegExp(`${id}: local model budget exhaustion evidence`))
      const result = await triageEscalation({ durableRecord, endpoint: 'http://triage.test', model: TRIAGE_MODEL, ledger }, {
        request: async () => triageResponse('budget', `${id} budget evidence`),
      })
      assert.deepEqual(result, { recorded: true, reason: 'recorded' })
      assert.equal(ledger.escalationProposalFor(id).proposed_cause, 'budget')
      assert.equal(ledger.getSession(id).terminal_reason, ESCALATION_CAUSE_UNCLASSIFIED)
    }
  } finally { ledger.close() }
})
test('E1 measured escalation receives no proposal', { skip: SKIP }, async () => {
  const { ledger } = triageLedger()
  const id = 'e1-run'
  try {
    const crewDir = makeTriageFixture({ id, ledger, where: 'gate', why: 'the gate failed' })
    const durableRecord = loadDurableEscalationRecord({ crewDir, ledger })
    let calls = 0
    const result = await triageEscalation({ durableRecord, endpoint: 'http://triage.test', model: TRIAGE_MODEL, ledger }, {
      request: async () => { calls += 1; return triageResponse('budget', 'must not be used') },
    })
    assert.deepEqual(result, { recorded: false, reason: 'already-classified' })
    assert.equal(calls, 0)
    assert.equal(ledger.getSession(id).terminal_reason, ESCALATION_CAUSE_UNCLASSIFIED)
    assert.equal(ledger.escalationProposalFor(id), null)
  } finally { ledger.close() }
})
test('F1 escalation proposal rejects an unknown cause', { skip: SKIP }, async () => {
  const { ledger } = triageLedger()
  const id = 'f1-run'
  try {
    const crewDir = makeTriageFixture({ id, ledger })
    const durableRecord = loadDurableEscalationRecord({ crewDir, ledger })
    const result = await triageEscalation({ durableRecord, endpoint: 'http://triage.test', model: TRIAGE_MODEL, ledger }, {
      request: async () => triageResponse('this is not a ledger cause', 'free text evidence'),
    })
    assert.deepEqual(result, { recorded: false, reason: 'proposal-cause-invalid' })
    assert.deepEqual(proposalFromResponse(JSON.stringify({ proposed_cause: 'free text', evidence: 'x' })), {
      recorded: false, reason: 'proposal-cause-invalid',
    })
    assert.equal(ledger.escalationProposalFor(id), null)
  } finally { ledger.close() }
})
test('G1 escalation triage sends only durable record evidence', { skip: SKIP }, async () => {
  const { ledger } = triageLedger()
  const id = 'g1-run'
  const checkoutTrap = 'CHECKOUT_SENTINEL_MUST_NOT_REACH_MODEL'
  const diffTrap = 'DIFF_SENTINEL_MUST_NOT_REACH_MODEL'
  try {
    const crewDir = makeTriageFixture({
      id,
      ledger,
      streamEvidence: `${id}-stream-marker budget exhaustion`,
      returnMarker: `${id}-return-marker`,
    })
    const checkout = { readCheckout: () => { throw new Error(checkoutTrap) }, readDiff: () => { throw new Error(diffTrap) } }
    ledger.recordRunObservation({
      adw_id: id,
      observed_at: '2026-01-01T00:00:00.000Z',
      observer: 'g1', driver_state: 'gone', source: 'process_group', reason_code: 'budget',
      detail: 'g1-observation-marker',
    })
    const durableRecord = loadDurableEscalationRecord({ crewDir, ledger }, checkout)
    const prompt = proposalPrompt(durableRecord)
    assert.ok(Buffer.byteLength(prompt, 'utf8') <= 64 * 1024)
    let requestUrl = null
    let requestOptions = null
    const result = await triageEscalation({ durableRecord, endpoint: 'http://triage.test/v1/', model: TRIAGE_MODEL, ledger }, {
      request: async (url, options) => {
        requestUrl = url
        requestOptions = options
        return triageResponse('budget', 'é'.repeat(2048))
      },
    })
    assert.deepEqual(result, { recorded: true, reason: 'recorded' })
    assert.equal(requestUrl, 'http://triage.test/v1/chat/completions')
    const sent = JSON.parse(requestOptions.body)
    const content = sent.messages[0].content
    assert.match(content, /g1-run-return-marker/)
    assert.match(content, /g1-run-journal-marker/)
    assert.match(content, /g1-observation-marker/)
    assert.match(content, /g1-run-stream-marker budget exhaustion/)
    assert.doesNotMatch(content, new RegExp(checkoutTrap))
    assert.doesNotMatch(content, new RegExp(diffTrap))
    assert.doesNotMatch(content, /process\\.cwd\\(\\)/)
    assert.ok(Buffer.byteLength(ledger.escalationProposalFor(id).proposed_evidence, 'utf8') <= 2 * 1024)
    assert.equal(readFileSync(join(crewDir, 'returns', 'task.json'), 'utf8').includes(checkoutTrap), false)
  } finally { ledger.close() }
})
test('A1 screener proposal journal rows persist model and outcome', { skip: SKIP }, () => {
  const dir = nextDir()
  const journalPath = join(dir, 'journal.jsonl')
  const createdAt = '2024-01-01T00:00:00.000Z'
  writeFileSync(journalPath, `${JSON.stringify({
    at: createdAt,
    screener_proposal: {
      round: 2, proposal_id: 'proposal-1', axis: 'correctness', model: 'model-a',
      outcome: 'adopted', finding_id: 'finding-1',
    },
  })}\n`)
  const source = openTestLedger()
  try {
    assert.deepEqual(ingestJournal(journalPath, source, { adw_id: 'screener-a1' }), {
      applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null,
    })
    assert.ok(Object.isFrozen(SCREENER_PROPOSAL_OUTCOMES))
    assert.deepEqual([...SCREENER_PROPOSAL_OUTCOMES], ['adopted', 'rejected', 'unadjudicated'])
    assert.equal(JOURNAL_FACT_KEYS.screener_proposal, 'recordScreenerProposal')
    assert.ok(WRITERS.includes('recordScreenerProposal'))
    assert.equal(WRITER_MIRROR_TABLES.recordScreenerProposal, 'screener_proposals')
    assert.deepEqual(TABLES.screener_proposals.columns.map(({ name }) => name), [
      'adw_id', 'round', 'proposal_id', 'axis', 'model', 'outcome',
      'finding_id', 'reason', 'at_ms', 'created_at',
    ])
    const persisted = source.dumpTable('screener_proposals')
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].model, 'model-a')
    assert.equal(persisted[0].outcome, 'adopted')
    assert.equal(persisted[0].finding_id, 'finding-1')
    const target = openTestLedger()
    try {
      assert.deepEqual(replayJsonl(source._jsonlPath, target), {
        applied: 1, skipped: 0, failed: 0, complete: true, first_failure: null,
      })
      const replayed = target.dumpTable('screener_proposals')
      assert.equal(replayed.length, 1)
      assert.equal(replayed[0].model, 'model-a')
      assert.equal(replayed[0].outcome, 'adopted')
    } finally { target.close() }
  } finally { source.close() }
})
test('advisor usage journal facts persist measured and absent spend idempotently', { skip: SKIP }, () => {
  const dir = nextDir()
  const journalPath = join(dir, 'journal.jsonl')
  writeFileSync(journalPath, [
    { at: '2024-01-01T00:00:00.000Z', advisor_usage: { consult_id: 'measured', run_started_at: 'start', role: 'builder', model: 'model-a', usage: { billed_input_tokens: 17, billed_output_tokens: 5, billed_cache_write_tokens: 3, billed_cache_read_tokens: 2 }, usage_reason: null } },
    { at: '2024-01-01T00:00:01.000Z', advisor_usage: { consult_id: 'absent', role: 'planner', model: 'model-a', usage: null, usage_reason: 'usage-unavailable' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  const ledger = openTestLedger()
  try {
    assert.equal(JOURNAL_FACT_KEYS.advisor_usage, 'recordAdvisorUsage')
    assert.equal(WRITER_MIRROR_TABLES.recordAdvisorUsage, 'advisor_usage')
    assert.ok(WRITERS.includes('recordAdvisorUsage'))
    assert.equal(ingestJournal(journalPath, ledger, { adw_id: 'advisor-test' }).applied, 2)
    assert.equal(ingestJournal(journalPath, ledger, { adw_id: 'advisor-test' }).applied, 0)
    const rows = ledger.dumpTable('advisor_usage')
    assert.equal(rows.length, 2)
    const measured = rows.find((row) => row.consult_id === 'measured')
    const absent = rows.find((row) => row.consult_id === 'absent')
    assert.deepEqual([measured.billed_input_tokens, measured.billed_output_tokens, measured.billed_cache_write_tokens, measured.billed_cache_read_tokens], [17, 5, 3, 2])
    assert.deepEqual([absent.billed_input_tokens, absent.billed_output_tokens, absent.billed_cache_write_tokens, absent.billed_cache_read_tokens, absent.usage_reason], [null, null, null, null, 'usage-unavailable'])
    assert.equal(readFileSync(ledger._jsonlPath, 'utf8').split('\n').filter((line) => line.includes('"kind":"recordAdvisorUsage"')).length, 2)
    assert.throws(() => ledger.recordAdvisorUsage({ adw_id: 'advisor-test', consult_id: 'zero', model: 'model-a', usage: null, usage_reason: 'wrong' }))
    assert.throws(() => ledger.recordAdvisorUsage({ adw_id: 'advisor-test', consult_id: 'mixed', model: 'model-a', usage: { billed_input_tokens: 0, billed_output_tokens: null, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 } }))
  } finally { ledger.close() }
})
test('cells CLI prices advisor spend with all four rates', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordAdvisorUsage({
    adw_id: 'advisor-priced', consult_id: 'c1', run_started_at: null, role: 'builder', model: 'openai-codex/gpt-5.6-sol',
    usage: { billed_input_tokens: 1_000_000, billed_output_tokens: 2_000_000, billed_cache_write_tokens: 3_000_000, billed_cache_read_tokens: 4_000_000 },
    created_at: '2024-01-01T00:00:00.000Z',
  })
  const pricePath = join(nextDir(), 'advisor-priced.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'openai/gpt-5.6-sol': { cost_in_per_mtok: 1, cost_out_per_mtok: 10, cost_cache_write_per_mtok: 100, cost_cache_read_per_mtok: 1000 } },
  }))
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  const row = payload.advisor_spend.find((candidate) => candidate.model === 'openai-codex/gpt-5.6-sol')
  assert.equal(row.price_key, 'openai/gpt-5.6-sol')
  assert.equal(row.consult_count, 1)
  assert.equal(row.cost_usd, 4321)
  assert.deepEqual([row.billed_input_tokens, row.billed_output_tokens, row.billed_cache_write_tokens, row.billed_cache_read_tokens], [1_000_000, 2_000_000, 3_000_000, 4_000_000])
  assert.deepEqual(row.absent, {})
  assert.equal(payload.rows.find((candidate) => candidate.adw_id === 'advisor-priced'), undefined)
})
test('cells CLI leaves advisor spend unpriced when model or usage is absent', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const measured = (adw_id, consult_id, model) => ledger.recordAdvisorUsage({
    adw_id, consult_id, role: 'builder', model,
    usage: { billed_input_tokens: 1, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 4 },
    created_at: '2024-01-01T00:00:00.000Z',
  })
  measured('advisor-weird', 'c1', 'weird-cli/gpt-5.6-sol')
  ledger.recordAdvisorUsage({ adw_id: 'advisor-absent', consult_id: 'c2', role: 'builder', model: 'openai-codex/gpt-5.6-sol', usage: null, usage_reason: 'usage-unavailable', created_at: '2024-01-01T00:00:00.000Z' })
  measured('advisor-rate-missing', 'c3', 'openai-codex/gpt-5.6-terra')
  const pricePath = join(nextDir(), 'advisor-incomplete.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: {
      'openai/gpt-5.6-sol': { cost_in_per_mtok: 1, cost_out_per_mtok: 10, cost_cache_write_per_mtok: 100, cost_cache_read_per_mtok: 1000 },
      'openai/gpt-5.6-terra': { cost_in_per_mtok: 1, cost_out_per_mtok: 10, cost_cache_write_per_mtok: 100 },
    },
  }))
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout).advisor_spend
  for (const [adw_id, reason] of [['advisor-weird', 'model-unpriced-or-ambiguous'], ['advisor-absent', 'usage-unavailable'], ['advisor-rate-missing', 'price-rate-unavailable']]) {
    const row = rows.find((candidate) => candidate.adw_id === adw_id)
    assert.equal(row.consult_count, 1)
    assert.equal(row.cost_usd, null)
    assert.notEqual(row.cost_usd, 0)
    assert.equal(row.absent.cost_usd, reason)
  }
})
// Sol, #1547 hand-finish pass 1: the advisor accepts a model of up to 128 characters
// (advisor.ts SAFE_MODEL), so the writer must too, or a valid consult's spend never lands.
// Mutation killed: bounding the model at the 64-character short-name bound again.
test('advisor usage keeps a model at the advisor bound and refuses one past it', { skip: SKIP }, () => {
  const dir = nextDir()
  const journalPath = join(dir, 'journal.jsonl')
  const model = `openai-codex/${'m'.repeat(128 - 'openai-codex/'.length)}`
  assert.equal(model.length, 128)
  writeFileSync(journalPath, JSON.stringify({ at: '2024-01-01T00:00:00.000Z', advisor_usage: { consult_id: 'long', role: 'builder', model, usage: { billed_input_tokens: 1, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 4 }, usage_reason: null } }) + '\n')
  const ledger = openTestLedger()
  try {
    assert.equal(ingestJournal(journalPath, ledger, { adw_id: 'advisor-long' }).applied, 1)
    assert.deepEqual(ledger.dumpTable('advisor_usage').map((row) => [row.model, row.billed_input_tokens]), [[model, 1]])
    assert.throws(() => ledger.recordAdvisorUsage({ adw_id: 'advisor-long', consult_id: 'too-long', model: `${model}x`, usage: null, usage_reason: 'usage-unavailable' }), /at most 128 characters/)
  } finally { ledger.close() }
})
// Sol, #1547 hand-finish pass 1: finite rates can overflow to Infinity; that cost is null
// with its own reason, never an unexplained null. Mutation killed: dropping the finite check.
test('cells CLI names an overflowing advisor cost instead of printing it', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordAdvisorUsage({
    adw_id: 'advisor-overflow', consult_id: 'c1', role: 'builder', model: 'openai-codex/gpt-5.6-sol',
    usage: { billed_input_tokens: 2_000_000, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 },
    created_at: '2024-01-01T00:00:00.000Z',
  })
  const pricePath = join(nextDir(), 'advisor-overflow.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'openai/gpt-5.6-sol': { cost_in_per_mtok: 1e308, cost_out_per_mtok: 1, cost_cache_write_per_mtok: 1, cost_cache_read_per_mtok: 1 } },
  }))
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout).advisor_spend.find((candidate) => candidate.adw_id === 'advisor-overflow')
  assert.equal(row.cost_usd, null)
  assert.deepEqual(row.absent, { cost_usd: 'cost-not-finite' })
})
// Sol, #1547 hand-finish pass 2: the JSONL authority stores the four billed columns flat,
// so a replay must restore both a measured and an absent consult from that shape.
// Mutation killed: dropping the flat-shape rebuild (replay then fails on missing usage).
test('advisor usage replays from its own persisted JSONL', { skip: SKIP }, () => {
  const source = openTestLedger()
  let jsonlPath
  try {
    source.recordAdvisorUsage({ adw_id: 'advisor-replay', consult_id: 'm', role: 'builder', model: 'model-r', usage: { billed_input_tokens: 7, billed_output_tokens: 6, billed_cache_write_tokens: 5, billed_cache_read_tokens: 4 }, created_at: '2024-01-01T00:00:00.000Z' })
    source.recordAdvisorUsage({ adw_id: 'advisor-replay', consult_id: 'a', role: 'builder', model: 'model-r', usage: null, usage_reason: 'usage-unavailable', created_at: '2024-01-01T00:00:01.000Z' })
    jsonlPath = source._jsonlPath
  } finally { source.close() }
  const target = openTestLedger()
  try {
    const result = replayJsonl(jsonlPath, target)
    assert.equal(result.failed, 0, JSON.stringify(result.first_failure))
    const rows = target.dumpTable('advisor_usage')
    const pick = (id) => { const r = rows.find((row) => row.consult_id === id); return [r.billed_input_tokens, r.billed_output_tokens, r.billed_cache_write_tokens, r.billed_cache_read_tokens, r.usage_reason] }
    assert.deepEqual(pick('m'), [7, 6, 5, 4, null])
    assert.deepEqual(pick('a'), [null, null, null, null, 'usage-unavailable'])
  } finally { target.close() }
})
// Sol, #1547 hand-finish pass 2: an unreadable advisor_usage mirror is an unanswerable
// readout, never an empty one. Mutation killed: reporting the failed read's [] as advisor_spend.
test('cells CLI reports an unreadable advisor mirror as absent, not empty', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.recordAdvisorUsage({ adw_id: 'advisor-unreadable', consult_id: 'c1', role: 'builder', model: 'model-u', usage: null, usage_reason: 'usage-unavailable', created_at: '2024-01-01T00:00:00.000Z' })
  const dbPath = ledger._dbPath
  ledger.close()
  const { DatabaseSync } = require('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  // An integer past the JS safe range makes node:sqlite throw on read: this table's read fails, no other.
  raw.exec("INSERT INTO advisor_usage (adw_id, consult_id, model, billed_input_tokens, created_at) VALUES ('advisor-unreadable', 'c2', 'model-u', 9007199254740993, '2024-01-01T00:00:00.000Z')")
  raw.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.advisor_spend, null)
  assert.match(payload.absent.advisor_spend, /unanswerable, not empty/)
})
// Sol, #1547 hand-finish pass 2: a token sum past MAX_SAFE_INTEGER is rounded, so it is not
// published. Mutation killed: dropping the safe-sum check (a rounded total is printed).
test('cells CLI withholds an advisor token total that is not a safe integer', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  for (const [consult_id, input] of [['c1', Number.MAX_SAFE_INTEGER], ['c2', 1], ['c3', 1]]) {
    ledger.recordAdvisorUsage({ adw_id: 'advisor-unsafe', consult_id, role: 'builder', model: 'openai-codex/gpt-5.6-sol', usage: { billed_input_tokens: input, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 }, created_at: '2024-01-01T00:00:00.000Z' })
  }
  const pricePath = join(nextDir(), 'advisor-unsafe.json')
  writeFileSync(pricePath, JSON.stringify({
    schema_version: 1, updated_at: '2024-02-01',
    models: { 'openai/gpt-5.6-sol': { cost_in_per_mtok: 1, cost_out_per_mtok: 1, cost_cache_write_per_mtok: 1, cost_cache_read_per_mtok: 1 } },
  }))
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells', '--prices', pricePath], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout).advisor_spend.find((candidate) => candidate.adw_id === 'advisor-unsafe')
  assert.equal(row.consult_count, 3)
  assert.equal(row.billed_input_tokens, null)
  assert.equal(row.cost_usd, null)
  assert.deepEqual(row.absent, { cost_usd: 'usage-total-unsafe' })
})
// Sol, #1547 hand-finish pass 3: pre-#1547 consults carry usage on advisor_consult only and are
// never backfilled, so an empty advisor_spend must not read as no spend. Mutation killed: dropping
// the coverage statement from the payload.
test('cells CLI states the advisor spend coverage gap even when no advisor row exists', { skip: SKIP }, () => {
  const dir = nextDir()
  const journalPath = join(dir, 'journal.jsonl')
  writeFileSync(journalPath, JSON.stringify({ at: '2024-01-01T00:00:00.000Z', advisor_consult: { tier: 1, role: 'builder', model: 'model-old', usage: { billed_input_tokens: 9, billed_output_tokens: 9, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 } } }) + '\n')
  const ledger = openTestLedger()
  ingestJournal(journalPath, ledger, { adw_id: 'advisor-old' })
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(['cells'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(payload.advisor_spend, [])
  assert.equal(payload.absent.advisor_spend_coverage, ADVISOR_SPEND_COVERAGE)
  assert.match(payload.absent.advisor_spend_coverage, /never zero spend/)
})
// Sol, #1547 hand-finish pass 4: an incomplete child usage frame is recorded as unmeasured with
// its own reason, and prices as nothing. Mutation killed: refusing the usage-incomplete reason.
test('advisor usage records an incomplete consult as unmeasured, never priced', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.recordAdvisorUsage({ adw_id: 'advisor-incomplete', consult_id: 'c1', role: 'builder', model: 'model-i', usage: null, usage_reason: 'usage-incomplete', created_at: '2024-01-01T00:00:00.000Z' })
    const row = ledger.dumpTable('advisor_usage')[0]
    assert.deepEqual([row.billed_input_tokens, row.billed_output_tokens, row.billed_cache_write_tokens, row.billed_cache_read_tokens, row.usage_reason], [null, null, null, null, 'usage-incomplete'])
    assert.throws(() => ledger.recordAdvisorUsage({ adw_id: 'advisor-incomplete', consult_id: 'c2', model: 'model-i', usage: null, usage_reason: 'invented' }))
  } finally { ledger.close() }
})
test('B1 screener adoption readout groups rates by model', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const createdAt = '2024-01-01T00:00:00.000Z'
  const add = (model, outcome, index) => ledger.recordScreenerProposal({
    adw_id: 'screener-b1', round: 1, proposal_id: `${model}-${index}`, axis: 'scope', model, outcome, created_at: createdAt,
  })
  try {
    for (let i = 0; i < 12; i += 1) add('model-a', 'adopted', `a-${i}`)
    for (let i = 0; i < 12; i += 1) add('model-a', 'rejected', `r-${i}`)
    for (let i = 0; i < 12; i += 1) add('model-b', 'adopted', `a-${i}`)
    for (let i = 0; i < 4; i += 1) add('model-b', 'rejected', `r-${i}`)
    const rows = ledger.screenerAdoptions({ since: createdAt, until: '2024-01-02T00:00:00.000Z' })
    assert.deepEqual(rows.map((row) => row.model), ['model-a', 'model-b'])
    assert.deepEqual(rows.map((row) => ({ proposals: row.proposals, adopted: row.adopted, rejected: row.rejected })), [
      { proposals: 24, adopted: 12, rejected: 12 },
      { proposals: 16, adopted: 12, rejected: 4 },
    ])
    assert.deepEqual(rows.map((row) => row.rate), [0.5, 0.75])
  } finally { ledger.close() }
})
test('C1 screener adoption rates carry numerator and denominator', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const createdAt = '2024-01-01T00:00:00.000Z'
  const add = (model, outcome, index) => ledger.recordScreenerProposal({
    adw_id: 'screener-c1', round: 1, proposal_id: `${model}-${outcome}-${index}`, axis: 'vacuity', model, outcome, created_at: createdAt,
  })
  for (let i = 0; i < 12; i += 1) add('model-a', 'adopted', i)
  for (let i = 0; i < 12; i += 1) add('model-a', 'rejected', i)
  for (let i = 0; i < 12; i += 1) add('model-b', 'adopted', i)
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run([
    'screener-adoptions', '--since', '2024-01-01T00:00:00Z', '--until', '2024-01-02T00:00:00Z',
  ], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schema, 1)
  assert.equal(payload.measured, true)
  assert.ok(payload.rows.length >= 2)
  for (const row of payload.rows) {
    for (const key of ['numerator', 'denominator']) assert.equal(Number.isInteger(row[key]), true)
    assert.equal(row.numerator, row.adopted)
    assert.equal(row.denominator, row.adjudicated)
    assert.equal(row.denominator, row.adopted + row.rejected)
    assert.equal(typeof row.measured, 'boolean')
    assert.ok(Object.hasOwn(row, 'rate'))
    assert.ok(Object.hasOwn(row, 'reason'))
  }
})
test('D1 screener adoption rates below the floor are unmeasured', { skip: SKIP }, () => {
  const empty = openTestLedger()
  const emptyDb = empty._dbPath
  empty.close()
  const emptyResult = run([
    'screener-adoptions', '--since', '2030-01-01T00:00:00Z', '--until', '2030-01-02T00:00:00Z',
  ], { DEVTEAM_LEDGER_DB: emptyDb })
  assert.equal(emptyResult.status, 0, emptyResult.stderr)
  const emptyPayload = JSON.parse(emptyResult.stdout)
  assert.equal(emptyPayload.measured, false)
  assert.deepEqual(emptyPayload.rows, [])
  assert.match(emptyPayload.reason, /^unmeasured:/)

  const ledger = openLedger({ dbPath: emptyDb, stderr: { write: () => {} } })
  ledger.recordScreenerProposal({
    adw_id: 'screener-d1', round: 1, proposal_id: 'thin-1', axis: 'scope', model: 'thin-model', outcome: 'adopted',
    created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.close()
  const below = run([
    'screener-adoptions', '--since', '2024-01-01T00:00:00Z', '--until', '2024-01-02T00:00:00Z',
  ], { DEVTEAM_LEDGER_DB: emptyDb })
  assert.equal(below.status, 0, below.stderr)
  const belowRow = JSON.parse(below.stdout).rows.find((row) => row.model === 'thin-model')
  assert.equal(belowRow.denominator, 1)
  assert.equal(belowRow.rate, null)
  assert.equal(belowRow.measured, false)
  assert.match(belowRow.reason, new RegExp(`denominator 1.*${CELL_RATE_FLOOR}`))

  const atFloor = openLedger({ dbPath: emptyDb, stderr: { write: () => {} } })
  try {
    for (let i = 1; i < CELL_RATE_FLOOR; i += 1) {
      atFloor.recordScreenerProposal({
        adw_id: 'screener-d1', round: 1, proposal_id: `thin-${i + 1}`, axis: 'scope', model: 'thin-model', outcome: 'rejected',
        created_at: '2024-01-01T00:00:00.000Z',
      })
    }
  } finally { atFloor.close() }
  const measured = run([
    'screener-adoptions', '--since', '2024-01-01T00:00:00Z', '--until', '2024-01-02T00:00:00Z',
  ], { DEVTEAM_LEDGER_DB: emptyDb })
  assert.equal(measured.status, 0, measured.stderr)
  const measuredRow = JSON.parse(measured.stdout).rows.find((row) => row.model === 'thin-model')
  assert.equal(measuredRow.denominator, CELL_RATE_FLOOR)
  assert.equal(measuredRow.measured, true)
  assert.equal(measuredRow.rate, 1 / CELL_RATE_FLOOR)
})
test('E1 rejected and unadjudicated screener proposals remain distinct', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    const base = { adw_id: 'screener-e1', round: 1, model: 'model-e', created_at: '2024-01-01T00:00:00.000Z' }
    ledger.recordScreenerProposal({ ...base, proposal_id: 'adopted', axis: 'correctness', outcome: 'adopted' })
    ledger.recordScreenerProposal({ ...base, proposal_id: 'rejected', axis: 'scope', outcome: 'rejected', reason: 'not supported' })
    ledger.recordScreenerProposal({ ...base, proposal_id: 'unknown', axis: 'vacuity', outcome: 'unadjudicated' })
    const row = ledger.screenerAdoptions({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-02T00:00:00.000Z' })[0]
    assert.deepEqual({ proposals: row.proposals, adopted: row.adopted, rejected: row.rejected, unadjudicated: row.unadjudicated, adjudicated: row.adjudicated }, {
      proposals: 3, adopted: 1, rejected: 1, unadjudicated: 1, adjudicated: 2,
    })
    assert.equal(row.denominator, row.adopted + row.rejected)
  } finally { ledger.close() }
})
test('F1 colliding screener proposal ids preserve unadjudicated rows', { skip: SKIP }, () => {
  const dir = nextDir()
  const journalPath = join(dir, 'journal.jsonl')
  const rows = [
    { round: 1, proposal_id: 'same-id', axis: 'correctness', model: 'model-f', outcome: 'rejected', reason: 'wrong' },
    { round: 1, proposal_id: 'same-id', axis: 'scope', model: 'model-f', outcome: 'unadjudicated' },
  ]
  writeFileSync(journalPath, rows.map((screener_proposal) => JSON.stringify({ at: '2024-01-01T00:00:00.000Z', screener_proposal })).join('\n') + '\n')
  const ledger = openTestLedger()
  try {
    const result = ingestJournal(journalPath, ledger, { adw_id: 'screener-f1' })
    assert.equal(result.applied, 2)
    assert.equal(ledger.dumpTable('screener_proposals').length, 2)
    const row = ledger.screenerAdoptions({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-02T00:00:00.000Z' })[0]
    assert.deepEqual({ proposals: row.proposals, adopted: row.adopted, rejected: row.rejected, unadjudicated: row.unadjudicated, adjudicated: row.adjudicated }, {
      proposals: 2, adopted: 0, rejected: 1, unadjudicated: 1, adjudicated: 1,
    })
  } finally { ledger.close() }
})
test('H1 screener adoption recipe names command and row unit', () => {
  const docs = readFileSync(join(ROOT, 'docs', 'ledger-queries.md'), 'utf8')
  const question = "| What fraction of each screener model's proposals did reviewers adopt? |"
  const rows = docs.split('\n').filter((line) => line.startsWith(question))
  assert.equal(rows.length, 1)
  assert.match(rows[0], /node scripts\/factory\/ledger\.mjs screener-adoptions \[--since <iso>\] \[--until <iso>\]/)
  assert.match(rows[0], /each row is one screener model/)
  assert.match(rows[0], /numerator is adopted/)
  assert.match(rows[0], /denominator is adjudicated \(`adopted \+ rejected`\)/)
  assert.match(rows[0], /Unadjudicated proposals are counted separately and excluded/)
})
