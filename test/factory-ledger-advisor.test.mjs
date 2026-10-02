import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync, readdirSync, statSync,
} from 'node:fs'

import { join } from 'node:path'

import { spawnSync, spawn } from 'node:child_process'

import { ROOT, scratchDir } from './helpers.mjs'

import {
  openLedger, replayJsonl, isoMs, TABLES, MIGRATIONS, applyMigrations, DRIVER_GONE_THRESHOLD_MS, DRIVER_STATES, RUN_OBSERVATION_SOURCES, RUN_OBSERVATION_COLUMNS, RUN_OBSERVATION_WRITE_VERB, SESSION_STATUSES, SESSION_OUTCOMES, SEAT_VALUE_SOURCES, TERMINAL_ACTORS, ESCALATION_CAUSE_UNCLASSIFIED, ESCALATION_CAUSE_RULE_GAP, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError, MODIFIER_KINDS, INTAKE_DISPATCH_OUTCOMES, SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, CELL_FAILURE_ATTRIBUTIONS, RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage, REQUEST_MAX_CHARS, USAGE_ABSENT_CAUSES, usageAbsentCause, AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS, CELL_RATE_FLOOR, SCREENER_PROPOSAL_OUTCOMES, CELL_PRICE_UNITS, REVIEW_VERDICTS, PHASE_SLOT_WAIT_KINDS, PHASE_SLOT_WAIT_DEPTH_ABSENT, PHASE_SLOT_WAIT_ABSENT, NARRATION_OUTCOMES, EVAL_ENVELOPE_STATUSES, EVAL_ABSENT_REASONS, EVAL_PAYLOAD_KEYS, ingestJournal, ingestExternalFenceRegister, JOURNAL_FACT_KEYS, JOURNAL_FACT_EVENTS, ADVISOR_SPEND_COVERAGE, LANE_SPEND_ABSENT_REASONS, priceKeyForModel, PLANNER_SYMBOLS_ARMS, PLANNER_SYMBOLS_SAMPLE_FLOOR, bootstrapPercentile,
  advisorArmsReadout, ADVISOR_SOURCES, ADVISOR_SOURCE_BACKFILL_OUTCOMES, advisorSourceBackfill,
  ADVISOR_ARMS,
} from '../scripts/factory/ledger.mjs'

import { readAdvisorArms as readDispatchAdvisorArms } from '../scripts/factory/dispatch-batch.mjs'

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
    adw_id: 'adw-404-headless', claude_session_id: 'session-404', model: 'sonnet',
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
      applied: 1, skipped: 0, ignored: 0, failed: 0, unstamped: 0, complete: true, first_failure: null,
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

// ---------------------------------------------------------------------------
// Advisor strength arms (ADR-047 decision 10). Kept out of factory-ledger.test.mjs, which ten
// sibling suites import as a helper module, so these tests register once, not eleven times.
// ---------------------------------------------------------------------------

// A finished run by default: an arm reads outcomes only from runs that ended.
function advisorArmTestRun(id, arm = 'p/m', grant = '["builder"]', ledger = openTestLedger(), { running = false, status = 'ok', outcome = 'success' } = {}) {
  seedConfigurationRun(ledger, id, '2024-01-02T00:00:00.000Z', { advisor_model: arm, advisor_granted_json: grant })
  const db = new (require('node:sqlite').DatabaseSync)(ledger._dbPath)
  db.prepare("UPDATE sessions SET tier='build' WHERE adw_id=?").run(id)
  db.close()
  if (!running) ledger.endSession({ adw_id: id, status, outcome })
  return ledger
}

test('R1', () => { const row = bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION, { seats: { advisor: { provider: 'p', id: 'm' } } }); assert.equal(row.configuration.advisor_model, 'p/m') })
test('R2', () => { const row = bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION, { seats: { advisor: null } }); assert.equal(row.configuration.advisor_model, 'none') })
test('R3', () => { const row = bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION); assert.equal(row.configuration.advisor_model, null) })
test('R4', () => { const granted = bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION, { seats: { advisor: null }, granted: ['builder'] }); const absent = bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION, { seats: { advisor: null } }); assert.equal(granted.configuration.advisor_granted_json, '["builder"]'); assert.equal(absent.configuration.advisor_granted_json, null) })
test('S1', () => { const ledger = openTestLedger(); seedConfigurationRun(ledger, 's1', '2024-01-02T00:00:00.000Z', { advisor_model: 'p/m', advisor_granted_json: '["builder"]' }); assert.equal(ledger.dumpTable('run_configurations')[0].advisor_model, 'p/m'); ledger.close() })
test('A1', () => { const ledger = advisorArmTestRun('a1', null); assert.equal(advisorArmsReadout(ledger).excluded.unrecorded, 1); ledger.close() })

const windowInstant = '2024-01-02T00:00:00.000Z'
const windowView = ({ sessions = [], windows = [], configs = [] } = {}) => ({
  stats: () => ({ degraded: false, mirror_errors: 0 }),
  tableNames: () => ['sessions', 'advisor_ab_windows'],
  dumpTable: (name) => ({ sessions, advisor_ab_windows: windows, run_configurations: configs }[name] ?? []),
})
const windowSession = (adw_id, started_at, ended_at = '2024-01-03T00:00:00.000Z') => ({ adw_id, tier: 'build', started_at, ended_at })
const windowConfig = (adw_id) => ({ adw_id, advisor_model: 'none', advisor_granted_json: '["builder"]', advisor_source: 'rotation' })
// MUTATION W1: remove the before-window continue; old completed and in-flight runs must both disappear.
test('W1 advisor window excludes pre-window completed and in-flight sessions', () => {
  const readout = advisorArmsReadout(windowView({ sessions: [windowSession('old-done', '2024-01-01T00:00:00Z'), windowSession('old-live', '2024-01-01T00:00:00Z', null)], windows: [{ started_at: windowInstant }], configs: [windowConfig('old-done'), windowConfig('old-live')] }), { arms: ['none'] })
  assert.deepEqual([readout.arms[0].runs, readout.arms[0].in_flight], [0, 0])
})
// MUTATION W2: neutralise beforeWindow++; one old eligible build is excluded exactly once.
test('W2 advisor window counts excluded build sessions', () => {
  const readout = advisorArmsReadout(windowView({ sessions: [windowSession('old', '2024-01-01T00:00:00Z')], windows: [{ started_at: windowInstant }], configs: [windowConfig('old')] }), { arms: ['none'] })
  assert.equal(readout.excluded.before_window, 1)
})
// MUTATION W3: give an absent window a current-time fallback; both historical completed runs must remain.
test('W3 advisor readout preserves history when no window is recorded', () => {
  const readout = advisorArmsReadout(windowView({ sessions: [windowSession('a', '2024-01-01T00:00:00Z'), windowSession('b', '2024-01-02T00:00:00Z')], configs: [windowConfig('a'), windowConfig('b')] }), { arms: ['none'] })
  assert.equal(readout.arms[0].runs, 2)
})
// MUTATION W4: ignore the explicit --since precedence over a newer recorded window.
test('W4 advisor readout honors earlier explicit since', () => {
  const readout = advisorArmsReadout(windowView({ sessions: [windowSession('middle', '2024-01-02T00:00:00Z')], windows: [{ started_at: '2024-01-03T00:00:00Z' }], configs: [windowConfig('middle')] }), { arms: ['none'], since: '2024-01-01T00:00:00Z' })
  assert.equal(readout.arms[0].runs, 1)
})
// MUTATION W5: replace the CLI writer with an inert object; the append-only JSONL row must persist.
test('W5 advisor start-window CLI persists a noted window', () => {
  const home = scratchDir('advisor-window-w5-')
  const result = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--start-window', '--note', 'x'], { env: { ...process.env, HOME: home, DEVTEAM_LEDGER_DIR: home, DEVTEAM_LEDGER_DB: join(home, 'ledger.db') }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const ledger = openLedger({ dbPath: join(home, 'ledger.db') })
  assert.equal(ledger.dumpTable('advisor_ab_windows').length, 1)
  assert.equal(ledger.dumpTable('advisor_ab_windows')[0].note, 'x')
  ledger.close()
})
// MUTATION W6: choose windows.at(0); latest appended/effective window must be reported.
test('W6 advisor readout selects the latest recorded window', () => {
  const readout = advisorArmsReadout(windowView({ windows: [{ started_at: '2024-01-01T00:00:00Z' }, { started_at: windowInstant }] }), { arms: ['none'] })
  assert.equal(readout.window.started_at, windowInstant)
})
// MUTATION W7: blank the windowLine; empty text readout must name no window and zero exclusions.
test('W7 advisor text readout reports the absent window', () => {
  const home = scratchDir('advisor-window-w7-')
  const result = spawnSync(process.execPath, [SCRIPT, 'advisor-arms'], { env: { ...process.env, HOME: home, DEVTEAM_LEDGER_DIR: home, DEVTEAM_LEDGER_DB: join(home, 'ledger.db') }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /window: none; before-window=0/)
})
// MUTATION: omit note or either timestamp from the persisted window row; equal instants must still append twice.
test('advisor window writer records note, timestamps, JSONL authority, replay, and duplicate instants', () => {
  const ledger = openTestLedger()
  const start = '2024-01-02T00:00:00.000Z'
  const first = ledger.recordAdvisorAbWindow({ started_at: start, created_at: start, note: 'operator note' })
  const second = ledger.recordAdvisorAbWindow({ started_at: start, created_at: start, note: 'again' })
  assert.deepEqual([first.started_at, first.created_at, first.note], [start, start, 'operator note'])
  assert.deepEqual(ledger.dumpTable('advisor_ab_windows').map(({ started_at }) => started_at), [start, start])
  const authority = readFileSync(ledger._jsonlPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(authority.map(({ kind, args }) => [kind, args.started_at]), [['recordAdvisorAbWindow', start], ['recordAdvisorAbWindow', start]])
  const replay = openTestLedger()
  replayJsonl(ledger._jsonlPath, replay)
  // The mirror orders rows by window_id, so the replay is compared per window identity.
  const byId = (rows) => Object.fromEntries(rows.map(({ window_id, note }) => [window_id, note]))
  assert.deepEqual(byId(replay.dumpTable('advisor_ab_windows')), { [first.window_id]: 'operator note', [second.window_id]: 'again' })
  replay.close()
  ledger.close()
})
// MUTATION: drop the window_id unique key, or insert without OR IGNORE; replaying the JSONL into the ledger that
// already holds the rows must not manufacture a second copy of either operator window.
test('advisor window replay into the same ledger adds no duplicate window', () => {
  const ledger = openTestLedger()
  const start = '2024-01-02T00:00:00.000Z'
  const first = ledger.recordAdvisorAbWindow({ started_at: start, created_at: start, note: 'one' })
  const second = ledger.recordAdvisorAbWindow({ started_at: start, created_at: start, note: 'two' })
  assert.notEqual(first.window_id, second.window_id)
  replayJsonl(ledger._jsonlPath, ledger)
  replayJsonl(ledger._jsonlPath, ledger)
  // A replayed duplicate is ignored, never a mirror error: MUTATION plain INSERT reddens this.
  assert.equal(ledger.stats().mirror_errors, 0)
  assert.deepEqual(ledger.dumpTable('advisor_ab_windows').map(({ window_id, note }) => [window_id, note]).sort(), [[first.window_id, 'one'], [second.window_id, 'two']].sort())
  ledger.close()
})
// MUTATION: drop the replay-time window_id refusal; an id-less authority row replayed twice would
// mint two ids and manufacture two windows from one recorded call.
test('advisor window replay refuses an authority row without its window_id', () => {
  const ledger = openTestLedger()
  const jsonlPath = join(scratchDir('advisor-window-idless-'), 'authority.jsonl')
  writeFileSync(jsonlPath, `${JSON.stringify({ kind: 'recordAdvisorAbWindow', args: { started_at: '2024-01-02T00:00:00.000Z', note: null, created_at: '2024-01-02T00:00:00.000Z' } })}\n`)
  const results = [replayJsonl(jsonlPath, ledger), replayJsonl(jsonlPath, ledger)]
  assert.deepEqual(results.map(({ applied, failed }) => [applied, failed]), [[0, 1], [0, 1]])
  assert.match(results[0].first_failure.reason, /window_id/)
  assert.equal(ledger.dumpTable('advisor_ab_windows').length, 0)
  ledger.close()
})
// MUTATION: ignore the supplied since option or compare local timestamp spellings instead of instants.
test('advisor window explicit since source, inclusive boundary, and timezone instant', () => {
  const at = '2024-01-02T01:00:00+01:00'
  const readout = advisorArmsReadout(windowView({ sessions: [windowSession('equal', at)], windows: [{ started_at: '2024-01-03T00:00:00Z' }], configs: [windowConfig('equal')] }), { arms: ['none'], since: '2024-01-02T00:00:00Z' })
  assert.equal(readout.window.source, 'since')
  assert.equal(readout.arms[0].runs, 1)
  assert.equal(readout.excluded.before_window, 0)
})
// MUTATION: accept an invalid --since token rather than returning usage status 2.
test('advisor window CLI refuses invalid since with usage status', () => {
  const home = scratchDir('advisor-window-invalid-since-')
  const result = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--since', 'not-a-time'], { env: { ...process.env, HOME: home, DEVTEAM_LEDGER_DIR: home, DEVTEAM_LEDGER_DB: join(home, 'ledger.db') }, encoding: 'utf8' })
  assert.equal(result.status, 2)
})
// MUTATION: create or require the window table on an older read-only database; stats must remain unchanged.
test('advisor window old read-only mirror has no window table and preserves stats', () => {
  const ledger = openTestLedger(), dbPath = ledger._dbPath
  ledger.recordAdvisorAbWindow({ note: 'scratch bootstrap' })
  ledger.close()
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('DROP TABLE advisor_ab_windows')
  db.close()
  const oldLedger = openLedger({ dbPath, readOnly: true })
  const before = oldLedger.stats()
  const readout = advisorArmsReadout(oldLedger, { arms: ['none'] })
  assert.equal(readout.window.source, null)
  assert.deepEqual(oldLedger.stats(), before)
  oldLedger.close()
})
// MUTATION: silently treat malformed evidence as a valid window or eligible session.
test('advisor window malformed timestamps fail closed', () => {
  assert.throws(() => advisorArmsReadout(windowView({ windows: [{ started_at: 'broken' }] }), { arms: ['none'] }), /malformed recorded window timestamp/)
  assert.throws(() => advisorArmsReadout(windowView({ windows: [{ started_at: windowInstant }], sessions: [windowSession('bad', undefined)], configs: [windowConfig('bad')] }), { arms: ['none'] }), /malformed build-session timestamp/)
})
// MUTATION: allow start-window, note, or since flags to be silently ignored by unrelated verbs.
test('advisor window flags are refused on other verbs', () => {
  const home = scratchDir('advisor-window-other-verb-')
  for (const flag of ['--start-window', '--note', '--since']) {
    const result = spawnSync(process.execPath, [SCRIPT, 'sessions', flag, ...(flag === '--start-window' ? [] : ['value'])], { env: { ...process.env, HOME: home, DEVTEAM_LEDGER_DIR: home, DEVTEAM_LEDGER_DB: join(home, 'ledger.db') }, encoding: 'utf8' })
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`)
  }
})
test('A2', () => { const ledger = advisorArmTestRun('a2', 'p/m', '[]'); assert.equal(advisorArmsReadout(ledger).excluded.ungranted, 1); ledger.close() })
test('A3', () => { const ledger = advisorArmTestRun('a3'); assert.equal(advisorArmsReadout(ledger).arms[0].build_rounds_per_run, null); ledger.close() })
test('A4', () => { const ledger = advisorArmTestRun('a4'); for (const [seq, message] of ['plan:r1', 'build:r1', 'build:r2', 'build:r3', 'done'].entries()) ledger.recordEvent({ adw_id: 'a4', type: 'log', seq: seq + 1, payload: { level: 'info', message } }); assert.equal(advisorArmsReadout(ledger).arms[0].build_rounds, 3); ledger.close() })
test('A5', () => { const ledger = advisorArmTestRun('a5'); const row = advisorArmsReadout(ledger).arms[0]; assert.equal(row.review_denominator, 0); ledger.close() })
test('A6', () => { const ledger = advisorArmTestRun('a6'); assert.equal(advisorArmsReadout(ledger).arms[0].escalation_denominator, 1); ledger.close() })
test('LANE_SPEND_ABSENT_REASONS is a closed frozen vocabulary', () => {
  assert.equal(Object.isFrozen(LANE_SPEND_ABSENT_REASONS), true)
  assert.deepEqual(LANE_SPEND_ABSENT_REASONS, ['no-agent-sessions', 'session-id-unavailable', 'model-unpriced-or-ambiguous', 'usage-unavailable', 'price-rate-unavailable', 'cost-not-finite'])
})
test('A7', () => { const ledger = advisorArmTestRun('a7'); assert.equal(advisorArmsReadout(ledger).arms[0].advisor_spend.absent_reason, 'no-advisor-usage'); ledger.close() })

test('build rounds evidence', async (t) => {
  function markers(ledger, id, messages) {
    for (const [index, message] of messages.entries()) ledger.recordEvent({ adw_id: id, type: 'log', seq: index + 1, payload: { level: 'info', message } })
  }
  function seed(ledger, id, messages = [], options = {}) {
    advisorArmTestRun(id, 'p/m', '["builder"]', ledger, options)
    markers(ledger, id, messages)
  }
  function view(ledger, calls = []) {
    return { stats: () => ledger.stats(), dumpTable: (name) => { calls.push(name); return ledger.dumpTable(name) } }
  }
  await t.test('R1', () => {
    // MUTATION R1: replace event build-round extraction with empty phase-derived rounds.
    const ledger = openTestLedger()
    try {
      seed(ledger, 'rounds-r1', ['plan:r1', 'build:r1', 'build:r2', 'build:r3', 'done'])
      seed(ledger, 'other-run', ['build:r1'])
      ledger.recordEvent({ adw_id: 'rounds-r1', type: 'decision', seq: 1, payload: {} })
      const calls = []
      const readout = advisorArmsReadout(view(ledger, calls), { arms: ['p/m'] }).arms[0]
      assert.equal(readout.build_rounds, 3)
      assert.equal(calls.filter((name) => name === 'events').length, 1)
      assert.equal(readout.rounds_denominator, 1)
      assert.equal(readout.rounds_unmeasured_runs, 1)
    } finally { ledger.close() }
  })
  await t.test('R2', () => {
    // MUTATION R2: expose runs as rounds_denominator.
    const ledger = openTestLedger()
    try { seed(ledger, 'r2-measured', ['build:r1', 'build:r2', 'build:r3', 'done']); seed(ledger, 'r2-empty'); const row = advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0]; assert.deepEqual([row.rounds_denominator, row.runs], [1, 2]) }
    finally { ledger.close() }
  })
  await t.test('R3', () => {
    // MUTATION R3: reject an empty build-round array.
    const ledger = openTestLedger()
    try { seed(ledger, 'r3', ['plan:r1', 'escalate:plan']); const row = advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0]; assert.deepEqual([row.build_rounds, row.rounds_denominator, row.rounds_unmeasured_runs], [0, 1, 0]) }
    finally { ledger.close() }
  })
  await t.test('R4', () => {
    // MUTATION R4: only done is terminal.
    const ledger = openTestLedger()
    try { seed(ledger, 'r4', ['build:r1', 'build:r2', 'escalate:gate']); assert.equal(advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0].build_rounds, 2) }
    finally { ledger.close() }
  })
  await t.test('R5', () => {
    // MUTATION R5: remove terminal requirement.
    const ledger = openTestLedger()
    try { seed(ledger, 'r5', ['build:r1', 'build:r2']); const row = advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0]; assert.deepEqual([row.rounds_unmeasured_runs, row.rounds_denominator], [1, 0]) }
    finally { ledger.close() }
  })
  await t.test('R6', () => {
    // MUTATION R6: bypass contiguous-round validation.
    const ledger = openTestLedger()
    try {
      for (const [id, stream] of [['r6-gap', ['build:r1', 'build:r3', 'done']], ['r6-duplicate', ['build:r1', 'build:r1', 'done']], ['r6-zero', ['build:r0', 'done']], ['r6-missing-first', ['build:r2', 'done']]]) seed(ledger, id, stream)
      assert.equal(advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0].rounds_unmeasured_runs, 4)
    } finally { ledger.close() }
  })
  await t.test('R7', () => {
    // MUTATION R7: return measured zero for an empty marker stream.
    const ledger = openTestLedger()
    try {
      seed(ledger, 'r7-empty')
      const baseView = view(ledger)
      const malformedView = { stats: baseView.stats, dumpTable: (name) => name === 'events' ? [...baseView.dumpTable(name), { adw_id: 'r7-malformed', type: 'log', payload_json: '{' }] : baseView.dumpTable(name) }
      seed(ledger, 'r7-malformed', ['build:r1', 'done'])
      const row = advisorArmsReadout(malformedView, { arms: ['p/m'] }).arms[0]
      assert.equal(row.rounds_unmeasured_runs, 2)
    } finally { ledger.close() }
  })
  await t.test('R8', () => {
    // MUTATION R8: increment unmeasured counter on the existing in-flight branch.
    const ledger = openTestLedger()
    try { seed(ledger, 'r8', ['build:r1'], { running: true }); const row = advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0]; assert.deepEqual([row.build_rounds, row.rounds_denominator, row.rounds_unmeasured_runs], [0, 0, 0]) }
    finally { ledger.close() }
  })
  await t.test('R9', () => {
    // MUTATION R9: use zero instead of null for an absent rounds rate.
    const ledger = openTestLedger()
    try { for (let i = 0; i < 12; i++) seed(ledger, `r9-${i}`); assert.equal(advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0].build_rounds_per_run, null) }
    finally { ledger.close() }
  })
  await t.test('R10', () => {
    // MUTATION R10: replace the zero-denominator absence reason.
    const ledger = openTestLedger()
    try {
      for (let i = 0; i < 12; i++) seed(ledger, `r10-${i}`)
      const populated = advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0]
      assert.equal(populated.build_rounds_absent_reason, 'no-measured-rounds')
      const empty = advisorArmsReadout(view(ledger), { arms: ['empty-arm'] }).arms[0]
      assert.deepEqual([empty.rounds_denominator, empty.rounds_unmeasured_runs, empty.build_rounds_per_run, empty.build_rounds_absent_reason], [0, 0, null, 'no-measured-rounds'])
    } finally { ledger.close() }
  })
  await t.test('R11', () => {
    // MUTATION R11: apply rounds floor to all runs.
    const ledger = openTestLedger()
    try { for (let i = 0; i < 11; i++) seed(ledger, `r11-${i}`, ['build:r1', 'done']); seed(ledger, 'r11-missing'); const row = advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0]; assert.deepEqual([row.build_rounds_per_run, row.build_rounds_absent_reason], [null, 'below-run-floor']) }
    finally { ledger.close() }
  })
  await t.test('R12', () => {
    // MUTATION R12: divide the measured total by all finished runs.
    const ledger = openTestLedger()
    try { for (let i = 0; i < 12; i++) seed(ledger, `r12-${i}`, i < 6 ? ['build:r1', 'build:r2', 'done'] : ['build:r1', 'build:r2', 'build:r3', 'done']); seed(ledger, 'r12-missing'); assert.equal(advisorArmsReadout(view(ledger), { arms: ['p/m'] }).arms[0].build_rounds_per_run, 2.5) }
    finally { ledger.close() }
  })
  await t.test('R13', () => {
    // MUTATION R13: remove the rounds-unmeasured field from the CLI template.
    const ledger = openTestLedger()
    try {
      seed(ledger, 'r13')
      const dbPath = ledger._dbPath
      const child = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--arms', 'p/m'], { encoding: 'utf8', env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath }, timeout: 30000 })
      assert.equal(child.status, 0, child.stderr)
      assert.match(child.stdout, /p\/m: runs=1; rounds=0\/0; rounds-unmeasured=1;/)
    } finally { ledger.close() }
  })
  await t.test('D1', () => {
    // MUTATION D1: replace measurement 1 with the main phases[] paragraph.
    const doc = readFileSync(join(ROOT, 'docs', 'advisor-ab-protocol.md'), 'utf8')
    const section = doc.split('1. **rounds per run.**')[1]?.split('2. **bounce rate.**')[0] ?? ''
    assert.match(section, /rounds_unmeasured_runs/); assert.match(section, /events/); assert.match(section, /log/)
    assert.match(section, /node scripts\/factory\/ledger\.mjs tail <adw_id> --limit <n>/)
    assert.match(section, /done/); assert.match(section, /escalate:/); assert.match(section, /r1\.\.rN/); assert.match(section, /zero/)
    assert.match(section, /dropped final `build:r<N>` before a recorded terminal marker is not detectable/)
    assert.equal(section.includes('phases[]'), false)
    const readout = doc.split('## Build-run arm readout')[1]?.split('## The four measurements')[0] ?? ''
    assert.match(readout, /rounds_unmeasured_runs/); assert.match(readout, /build_rounds_absent_reason/)
  })
})
// Kills: counting an unbilled run's null billed_cost_usd as measured $0 lane spend (Number(null) is 0),
// which inflates lane_spend_denominator; and dropping a billed run (the spend and denominator fall).
test('A7 lane spend: an unbilled run is missing spend, never a measured zero', () => {
  const ledger = advisorArmTestRun('a7-billed', 'p/m', '["builder"]', openTestLedger(), { running: true })
  advisorArmTestRun('a7-unbilled', 'p/m', '["builder"]', ledger)
  ledger.endSession({ adw_id: 'a7-billed', status: 'ok', outcome: 'success', billed_cost_usd: 999 })
  const usage = { adw_id: 'a7-billed', dispatch_id: 'd1', role: 'builder', model: 'claude-sonnet-5', claude_session_id: 's1', transcript_path: null }
  ledger.startAgentSession(usage)
  ledger.endAgentSession({ adw_id: usage.adw_id, claude_session_id: usage.claude_session_id, model: usage.model, context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, billed_input_tokens: 1_000_000, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 })
  const catalog = { models: { 'anthropic/claude-sonnet-5': { cost_in_per_mtok: 1.5, cost_out_per_mtok: 0, cost_cache_write_per_mtok: 0, cost_cache_read_per_mtok: 0 } } }
  const arm = advisorArmsReadout(ledger, { catalog }).arms[0]
  assert.equal(arm.runs, 2)
  assert.equal(arm.lane_spend_usd, 1.5)
  assert.equal(arm.lane_spend_denominator, 1)
  assert.equal(arm.lane_spend_missing_runs, 1)
  assert.equal(arm.lane_spend_absent_reason, 'no-agent-sessions')
  ledger.close()
})
test('lane spend rejects NULL token classes and unavailable or non-finite rates', () => {
  const catalog = { models: { 'anthropic/claude-sonnet-5': { cost_in_per_mtok: 1, cost_out_per_mtok: 2, cost_cache_write_per_mtok: 3, cost_cache_read_per_mtok: 4 } } }
  const tokens = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
  for (const token of tokens) {
    const ledger = advisorArmTestRun(`null-${token}`)
    ledger.startAgentSession({ adw_id: `null-${token}`, dispatch_id: 'd', role: 'builder', model: 'claude-sonnet-5', claude_session_id: 's', transcript_path: null })
    ledger.endAgentSession({ adw_id: `null-${token}`, claude_session_id: 's', model: 'claude-sonnet-5', context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, ...Object.fromEntries(tokens.map((name) => [name, name === token ? null : 0])) })
    const arm = advisorArmsReadout(ledger, { catalog }).arms[0]
    assert.equal(arm.lane_spend_usd, null); assert.equal(arm.lane_spend_denominator, 0); assert.equal(arm.lane_spend_missing_runs, 1)
    assert.equal(arm.lane_spend_absent_reason, 'usage-unavailable'); assert.ok(LANE_SPEND_ABSENT_REASONS.includes(arm.lane_spend_absent_reason))
    ledger.close()
  }
  for (const rate of [undefined, NaN, Infinity]) {
    const ledger = advisorArmTestRun(`rate-${String(rate)}`)
    ledger.startAgentSession({ adw_id: `rate-${String(rate)}`, dispatch_id: 'd', role: 'builder', model: 'claude-sonnet-5', claude_session_id: 's', transcript_path: null })
    ledger.endAgentSession({ adw_id: `rate-${String(rate)}`, claude_session_id: 's', model: 'claude-sonnet-5', context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, billed_input_tokens: 1, billed_output_tokens: 1, billed_cache_write_tokens: 1, billed_cache_read_tokens: 1 })
    const rates = { ...catalog.models['anthropic/claude-sonnet-5'] }
    if (rate === undefined) delete rates.cost_in_per_mtok; else rates.cost_in_per_mtok = rate
    const arm = advisorArmsReadout(ledger, { catalog: { models: { 'anthropic/claude-sonnet-5': rates } } }).arms[0]
    assert.equal(arm.lane_spend_absent_reason, 'price-rate-unavailable'); assert.ok(LANE_SPEND_ABSENT_REASONS.includes(arm.lane_spend_absent_reason))
    ledger.close()
  }
})
test('lane spend requires a globally unique model mapping and counts zero usage as measured', () => {
  const rows = { billed_input_tokens: 0, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 }
  const rates = { cost_in_per_mtok: 1, cost_out_per_mtok: 1, cost_cache_write_per_mtok: 1, cost_cache_read_per_mtok: 1 }
  const cases = [
    { model: 'unknown-model', catalog: { models: { 'anthropic/claude-sonnet-5': rates } }, reason: 'model-unpriced-or-ambiguous', key: null },
    { model: 'sonnet', catalog: { models: { 'anthropic/sonnet': rates, 'meta/sonnet': rates } }, reason: 'model-unpriced-or-ambiguous', key: null },
    { model: 'anthropic/sonnet', catalog: { models: { 'anthropic/anthropic/sonnet': rates, 'anthropic/sonnet': rates } }, reason: 'model-unpriced-or-ambiguous', key: null },
  ]
  for (const [index, item] of cases.entries()) {
    assert.equal(priceKeyForModel(item.catalog, item.model), item.key)
    const ledger = advisorArmTestRun(`mapping-${index}`)
    ledger.startAgentSession({ adw_id: `mapping-${index}`, dispatch_id: 'd', role: 'builder', model: item.model, claude_session_id: 's', transcript_path: null })
    ledger.endAgentSession({ adw_id: `mapping-${index}`, claude_session_id: 's', model: item.model, context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, ...rows })
    const arm = advisorArmsReadout(ledger, { catalog: item.catalog }).arms[0]
    assert.equal(arm.lane_spend_absent_reason, item.reason); assert.ok(LANE_SPEND_ABSENT_REASONS.includes(arm.lane_spend_absent_reason))
    ledger.close()
  }
  const shared = { models: { 'anthropic/anthropic/sonnet': rates } }
  assert.equal(priceKeyForModel(shared, 'anthropic/anthropic/sonnet'), 'anthropic/anthropic/sonnet')
  const ledger = advisorArmTestRun('zero-usage')
  ledger.startAgentSession({ adw_id: 'zero-usage', dispatch_id: 'd', role: 'builder', model: 'anthropic/anthropic/sonnet', claude_session_id: 's', transcript_path: null })
  ledger.endAgentSession({ adw_id: 'zero-usage', claude_session_id: 's', model: 'anthropic/anthropic/sonnet', context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, ...rows })
  const arm = advisorArmsReadout(ledger, { catalog: shared }).arms[0]
  assert.strictEqual(arm.lane_spend_usd, 0); assert.equal(arm.lane_spend_denominator, 1); assert.equal(arm.lane_spend_missing_runs, 0)
  ledger.close()
})
test('lane spend reports deterministic first absence and no absence for a requested empty arm', () => {
  const ledger = advisorArmTestRun('z-no-rows', 'lane')
  const modelMissing = advisorArmTestRun('a-unknown-model', 'lane', '["builder"]', ledger)
  modelMissing.startAgentSession({ adw_id: 'a-unknown-model', dispatch_id: 'd', role: 'builder', model: 'unknown-model', claude_session_id: 's', transcript_path: null })
  modelMissing.endAgentSession({ adw_id: 'a-unknown-model', claude_session_id: 's', model: 'unknown-model', context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, billed_input_tokens: 1, billed_output_tokens: 1, billed_cache_write_tokens: 1, billed_cache_read_tokens: 1 })
  const catalog = { models: { 'anthropic/claude-sonnet-5': { cost_in_per_mtok: 1, cost_out_per_mtok: 1, cost_cache_write_per_mtok: 1, cost_cache_read_per_mtok: 1 } } }
  assert.deepEqual(ledger.dumpTable('sessions').map((row) => row.adw_id), ['a-unknown-model', 'z-no-rows'])
  const result = advisorArmsReadout(ledger, { catalog })
  assert.equal(result.arms[0].lane_spend_absent_reason, 'model-unpriced-or-ambiguous')
  assert.ok(LANE_SPEND_ABSENT_REASONS.includes(result.arms[0].lane_spend_absent_reason))
  const empty = advisorArmsReadout(ledger, { arms: ['absent-arm'], catalog }).arms[0]
  assert.equal(empty.lane_spend_usd, null); assert.equal(empty.lane_spend_denominator, 0)
  assert.equal(empty.lane_spend_missing_runs, 0); assert.equal(empty.lane_spend_absent_reason, null)
  ledger.close()
})
// Kills: dropping any one token class from the lane-spend sum, or pairing it with another class's
// rate. Each class carries its own decimal digit (1 + 20 + 300 + 4000), so every such change moves the total.
test('lane spend prices every billed token class at its own rate', () => {
  const ledger = advisorArmTestRun('every-class')
  ledger.startAgentSession({ adw_id: 'every-class', dispatch_id: 'd', role: 'builder', model: 'claude-sonnet-5', claude_session_id: 's', transcript_path: null })
  ledger.endAgentSession({ adw_id: 'every-class', claude_session_id: 's', model: 'claude-sonnet-5', context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, billed_input_tokens: 1_000_000, billed_output_tokens: 2_000_000, billed_cache_write_tokens: 3_000_000, billed_cache_read_tokens: 4_000_000 })
  const catalog = { models: { 'anthropic/claude-sonnet-5': { cost_in_per_mtok: 1, cost_out_per_mtok: 10, cost_cache_write_per_mtok: 100, cost_cache_read_per_mtok: 1000 } } }
  const arm = advisorArmsReadout(ledger, { catalog }).arms[0]
  assert.equal(arm.lane_spend_usd, 4321); assert.equal(arm.lane_spend_denominator, 1)
  ledger.close()
})
// Kills: pricing rows that carry no session id. Two such rows for one model share an identity, so
// endAgentSession writes the same running total onto both and the run would price twice ($4 here, not $2).
test('lane spend refuses rows without a session id instead of pricing a duplicated running total', () => {
  const ledger = advisorArmTestRun('null-session')
  for (const dispatch_id of ['d1', 'd2']) ledger.startAgentSession({ adw_id: 'null-session', dispatch_id, role: 'builder', model: 'claude-sonnet-5', claude_session_id: null, transcript_path: null })
  ledger.endAgentSession({ adw_id: 'null-session', claude_session_id: null, model: 'claude-sonnet-5', context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null, billed_input_tokens: 2_000_000, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 })
  const catalog = { models: { 'anthropic/claude-sonnet-5': { cost_in_per_mtok: 1, cost_out_per_mtok: 0, cost_cache_write_per_mtok: 0, cost_cache_read_per_mtok: 0 } } }
  assert.equal(ledger.dumpTable('agent_sessions').length, 2)
  const arm = advisorArmsReadout(ledger, { catalog }).arms[0]
  assert.deepEqual([arm.lane_spend_usd, arm.lane_spend_denominator, arm.lane_spend_missing_runs, arm.lane_spend_absent_reason], [null, 0, 1, 'session-id-unavailable'])
  ledger.close()
})
// Kills: counting a run still in flight into the arm's runs and rates (twelve running sessions
// would read runs 12, build_rounds_per_run 0, escalation_rate 0: outcomes nobody has yet), and
// leaving in-flight runs out of the rotation (next_arm would keep choosing the busy arm).
test('A10 a run still in flight counts toward the rotation, never toward an outcome rate', () => {
  const ledger = openTestLedger()
  for (let i = 1; i <= 12; i++) advisorArmTestRun(`a10-live-${i}`, 'live', '["builder"]', ledger, { running: true })
  advisorArmTestRun('a10-done', 'done', '["builder"]', ledger)
  const out = advisorArmsReadout(ledger, { arms: ['live', 'done'] })
  const live = out.arms.find((row) => row.arm === 'live')
  assert.equal(live.runs, 0)
  assert.equal(live.in_flight, 12)
  assert.equal(live.thin, true)
  assert.equal(live.build_rounds_per_run, null)
  assert.equal(live.escalation_rate, null)
  assert.equal(out.next_arm, 'done')
  ledger.close()
})
// Kills: dropping an in-flight run's id from advisor spend (its consults read as no-advisor-usage
// while the run is active, then reappear after endSession).
test('A12 an in-flight run still contributes its recorded advisor consults to spend', () => {
  const ledger = advisorArmTestRun('a12-live', 'p/m', '["builder"]', openTestLedger(), { running: true })
  ledger.recordAdvisorUsage({ adw_id: 'a12-live', consult_id: 'c1', model: 'no-such-provider/no-such-model', usage: { billed_input_tokens: 10, billed_output_tokens: 10, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 } })
  const arm = advisorArmsReadout(ledger).arms[0]
  assert.equal(arm.runs, 0)
  assert.equal(arm.in_flight, 1)
  assert.equal(arm.advisor_spend.usage_count, 1)
  assert.equal(arm.advisor_spend.absent_reason, 'model-unpriced-or-ambiguous')
  ledger.close()
})
// Kills: dropping the changes-needed increment (bounce numerator reads 0) and dropping the
// escalation increment (escalations read 0); the A1–A9 fixtures carry neither.
test('A11 bounce and escalation numerators count changes-needed reviews and escalated runs', () => {
  const ledger = openTestLedger()
  for (let i = 1; i <= 11; i++) advisorArmTestRun(`a11-${i}`, 'p/m', '["builder"]', ledger)
  advisorArmTestRun('a11-esc', 'p/m', '["builder"]', ledger, { status: 'fail', outcome: 'escalated' })
  ledger.recordReviewOutcome({ adw_id: 'a11-1', dispatch_id: 'd1', verdict: 'changes-needed' })
  ledger.recordReviewOutcome({ adw_id: 'a11-1', dispatch_id: 'd2', verdict: 'pass' })
  ledger.recordReviewOutcome({ adw_id: 'a11-2', dispatch_id: 'd3', verdict: 'pass' })
  const arm = advisorArmsReadout(ledger).arms[0]
  assert.equal(arm.runs, 12)
  assert.equal(arm.changes_needed, 1)
  assert.equal(arm.review_denominator, 3)
  assert.equal(arm.bounce_rate, 1 / 3)
  assert.equal(arm.escalations, 1)
  assert.equal(arm.escalation_rate, 1 / 12)
  ledger.close()
})
// Kills: bounding advisor_model by the 64-character tier bound, which refuses a longer model id
// that resolveTier accepts and so drops its run from every arm.
test('S2 a run configuration records an advisor model longer than the tier bound', () => {
  const ledger = openTestLedger()
  const model = `provider/${'m'.repeat(58)}`
  assert.equal(model.length, 67)
  seedConfigurationRun(ledger, 's2', '2024-01-02T00:00:00.000Z', { advisor_model: model, advisor_granted_json: '["builder"]' })
  assert.equal(ledger.dumpTable('run_configurations')[0].advisor_model, model)
  ledger.close()
})
test('A8', () => { const ledger = openTestLedger(); seedConfigurationRun(ledger, 'a8', '2024-01-02T00:00:00.000Z', { advisor_model: 'p/m', advisor_granted_json: '["builder"]' }); assert.equal(advisorArmsReadout(ledger).excluded.non_build_excluded, 1); ledger.close() })
test('dispatcharms arm vocabulary is frozen and independently ordered', () => {
  assert.deepEqual(ADVISOR_ARMS, ['none', 'openai/gpt-6-luna', 'openai/gpt-5.6-terra', 'openai/gpt-6.1-sol'])
  assert.equal(Object.isFrozen(ADVISOR_ARMS), true)
  assert.throws(() => { ADVISOR_ARMS.push('x') })
})

test('dispatcharms CLI defaults to the four arms and preserves explicit order and library omission', () => {
  const ledger = openTestLedger()
  const dbPath = ledger._dbPath
  assert.equal(advisorArmsReadout(ledger).next_arm, null)
  ledger.close()
  const env = { ...process.env, DEVTEAM_LEDGER_DB: dbPath }
  const json = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--json'], { env, encoding: 'utf8' })
  const text = spawnSync(process.execPath, [SCRIPT, 'advisor-arms'], { env, encoding: 'utf8' })
  assert.equal(json.status, 0, json.stderr)
  assert.equal(text.status, 0, text.stderr)
  assert.equal(JSON.parse(json.stdout).next_arm, 'none')
  assert.deepEqual(JSON.parse(json.stdout).arms.map(({ arm }) => arm), ADVISOR_ARMS)
  assert.match(text.stdout, /next_arm: none/)
  const override = ['openai/gpt-6.1-sol', 'none']
  const explicit = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--arms', override.join(','), '--json'], { env, encoding: 'utf8' })
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.deepEqual(JSON.parse(explicit.stdout).arms.map(({ arm }) => arm), override)
  const malformed = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--arms', 'none,', '--json'], { env, encoding: 'utf8' })
  assert.equal(malformed.status, 2)
})

// Kills deletion of the finally close (both branches) and mapping a degraded real read to ledger-unreadable at readAdvisorArms catch.
test('dispatcharms real read counts history and reservations and closes on success and failure', () => {
  const ledger = advisorArmTestRun('dispatcharms-historical', 'none')
  const dbPath = ledger._dbPath
  ledger.close()
  let closes = 0
  // Every path the spy opens is one this test created, so the real ledger is never reachable.
  const sandboxPaths = new Set([dbPath])
  const spy = (options) => {
    assert.ok(sandboxPaths.has(options.dbPath), `spy opened ${options.dbPath}, outside this test`)
    const handle = openLedger({ ...options, dbPath: options.dbPath })
    const close = handle.close.bind(handle)
    handle.close = () => { closes++; return close() }
    return handle
  }
  assert.throws(() => spy({ dbPath: join(nextDir(), 'outside.db') }), /outside this test/)
  const result = readDispatchAdvisorArms({ deps: { env: { DEVTEAM_LEDGER_DB: dbPath } }, inFlight: [{ lane: 'synthetic-lane', arm: 'openai/gpt-6-luna', reserved_at: new Date().toISOString() }], open: spy })
  assert.equal(result.reason, null)
  assert.equal(result.readout.arms.find(({ arm }) => arm === 'none').runs, 1)
  assert.equal(result.readout.arms.find(({ arm }) => arm === 'openai/gpt-6-luna').in_flight, 1)
  assert.equal(result.readout.next_arm, 'openai/gpt-5.6-terra')
  assert.equal(closes, 1)
  closes = 0
  const failed = readDispatchAdvisorArms({
    deps: { env: { DEVTEAM_LEDGER_DB: dbPath } },
    open: (options) => {
      const handle = spy(options)
      handle.dumpTable = () => { throw new Error('injected read failure') }
      return handle
    },
  })
  assert.equal(failed.reason, 'ledger-unreadable')
  assert.equal(closes, 1)
  closes = 0
  const corruptPath = join(nextDir(), 'corrupt.db')
  writeFileSync(corruptPath, 'not a sqlite database')
  sandboxPaths.add(corruptPath)
  const degraded = readDispatchAdvisorArms({ deps: { env: { DEVTEAM_LEDGER_DB: corruptPath } }, open: spy })
  assert.equal(degraded.reason, 'ledger-degraded')
  assert.equal(degraded.readout, null)
})

// MUTATION S3: hard-code a source in emission; crew provenance must survive without guessing or filling absence.
test('advisor-source S3 emitted configuration preserves valid sources and absent source', () => {
  assert.deepEqual(['rotation', 'explicit', 'default'].map((advisor_source) => bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION, { advisor_source }).configuration.advisor_source), ['rotation', 'explicit', 'default'])
  assert.equal(bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION, { advisor_source: undefined }).configuration.advisor_source, null)
  assert.equal(bootTieredRun('build', EXECUTION_AXIS_BOOT_CONFIGURATION, { advisor_source: 'guess' }).configuration.advisor_source, null)
})

// MUTATION S4: remove enum validation or skip additive pre-column migration; guessed input must refuse and legacy evidence remain absent.
test('advisor-source S4 refuses guessed provenance and upgrades a pre-column table without guessing', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  assert.throws(() => ledger.recordRunConfiguration({ adw_id: 'source-guess', schema_version: 1, task_profile: 'implementation', task_profile_source: 'explicit', requested_execution: 'full', effective_execution: 'full', execution_source: 'explicit', requested_assurance: 'standard', effective_assurance: 'standard', assurance_source: 'explicit', legacy_variant: null, legacy_tier: 'build', advisor_source: 'guess' }), /advisor_source/)
  assert.deepEqual(ADVISOR_SOURCES, ['rotation', 'explicit', 'default'])
  assert.equal(Object.isFrozen(ADVISOR_SOURCES), true)
  assert.deepEqual(ADVISOR_SOURCE_BACKFILL_OUTCOMES, ['unreadable', 'not-rotation', 'no-run', 'already-recorded', 'arm-mismatch', 'ambiguous', 'backfilled', 'would-backfill'])
  assert.equal(Object.isFrozen(ADVISOR_SOURCE_BACKFILL_OUTCOMES), true)
  ledger.close()

  const dbPath = join(scratchDir('advisor-source-s4-'), 'legacy.db')
  const db = new (require('node:sqlite').DatabaseSync)(dbPath)
  db.exec(`CREATE TABLE run_configurations (
    adw_id TEXT PRIMARY KEY, schema_version INTEGER, task_profile TEXT, task_profile_source TEXT,
    requested_execution TEXT, effective_execution TEXT, execution_source TEXT,
    requested_assurance TEXT, effective_assurance TEXT, assurance_source TEXT,
    legacy_variant TEXT, legacy_tier TEXT, created_at TEXT, advisor_model TEXT, advisor_granted_json TEXT
  )`)
  db.prepare('INSERT INTO run_configurations (adw_id) VALUES (?)').run('legacy-source-row')
  db.close()
  const upgraded = openLedger({ dbPath })
  // MUTATION S4-upgrade: omit either additive column migration; both old-row projections must remain SQL NULL.
  assert.ok(upgraded.columnNames('run_configurations').includes('advisor_source'))
  assert.ok(upgraded.columnNames('run_configurations').includes('advisor_source_evidence'))
  const legacy = upgraded.dumpTable('run_configurations').find(({ adw_id }) => adw_id === 'legacy-source-row')
  assert.deepEqual([legacy.advisor_source, legacy.advisor_source_evidence], [null, null])
  upgraded.close()
})

// MUTATION S5: remove the rotation source filter; only rotation is eligible.
test('advisor-source S5 excludes non-rotated and unrecorded runs from arms', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  for (const [i, source] of ['rotation', 'default', 'explicit', null].entries()) {
    seedConfigurationRun(ledger, `advisor-source-s5-${i}`, `2024-01-0${i + 1}T00:00:00.000Z`, { advisor_model: 'none', advisor_granted_json: '["builder"]', advisor_source: source })
    const db = new (require('node:sqlite').DatabaseSync)(ledger._dbPath); db.prepare("UPDATE sessions SET tier='build' WHERE adw_id=?").run(`advisor-source-s5-${i}`); db.close()
    ledger.endSession({ adw_id: `advisor-source-s5-${i}`, status: 'ok', outcome: 'success' })
  }
  const output = advisorArmsReadout(ledger, { arms: ['none'] })
  assert.deepEqual([output.arms[0].runs, output.excluded.source_default, output.excluded.source_explicit, output.excluded.source_unrecorded, output.backfilled], [1, 1, 1, 1, 0])
  ledger.close()
})

// MUTATION S7: bypass ambiguity, accept null-arm/non-build candidates, skip outcomes, or certify ineligible evidence.
test('advisor-source S7 backfills only one eligible evidence match and preserves every outcome', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const rows = [
    ['advisor-source-s7-unique', 'unique-lane', 'none', 'build', null, '["builder"]', null],
    ['advisor-source-s7-a', 'ambiguous-lane', 'none', 'build', null, '["builder"]', null],
    ['advisor-source-s7-b', 'ambiguous-lane', 'none', 'build', null, '["builder"]', null],
    ['advisor-source-s7-mismatch', 'mismatch-lane', 'none', 'build', null, '["builder"]', null],
    ['advisor-source-s7-null-arm', 'null-arm-lane', null, 'build', null, '["builder"]', null],
    ['advisor-source-s7-non-build', 'non-build-lane', 'none', 'mechanical', null, '["builder"]', null],
    ['advisor-source-s7-dry', 'dry-lane', 'none', 'build', null, '["builder"]', null],
    ['advisor-source-s7-default-evidence', 'default-evidence-lane', 'none', 'build', 'prior-default-evidence', '["builder"]', 'default'],
    ['advisor-source-s7-ungranted', 'ungranted-lane', 'none', 'build', 'prior-evidence', '[]', 'rotation'],
    ['advisor-source-s7-reused-early', 'reused-lane', 'none', 'build', null, '["builder"]', 'rotation'],
    ['advisor-source-s7-reused-late', 'reused-lane', 'none', 'build', null, '["builder"]', null],
  ]
  for (const [id, lane, model, tier, evidence, granted, source] of rows) {
    seedConfigurationRun(ledger, id, '2024-01-02T00:00:00.000Z', { advisor_model: model, advisor_granted_json: granted, advisor_source: source, advisor_source_evidence: evidence })
    const db = new (require('node:sqlite').DatabaseSync)(ledger._dbPath)
    db.prepare('UPDATE sessions SET tier=?, task_slug=? WHERE adw_id=?').run(tier, lane, id)
    db.close()
    ledger.endSession({ adw_id: id, status: 'ok', outcome: 'success' })
  }
  const dir = scratchDir('advisor-source-s7-')
  const evidence = (name, record) => { const path = join(dir, name); writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record)); return path }
  const malformed = evidence('malformed.json', '{')
  const array = evidence('array.json', [])
  const badLane = evidence('bad-lane.json', { lane: 17, advisor_rotation: { source: 'rotation', arm: 'none' } })
  const noRun = evidence('no-run.json', { lane: 'missing-lane', advisor_rotation: { source: 'rotation', arm: 'none' } })
  const unique = evidence('unique.dispatch.json', { lane: 'unique-lane', advisor_rotation: { source: 'rotation', arm: 'none' } })
  const ambiguous = evidence('ambiguous.dispatch.json', { lane: 'ambiguous-lane', advisor_rotation: { source: 'rotation', arm: 'none' } })
  const mismatch = evidence('mismatch.json', { lane: 'mismatch-lane', advisor_rotation: { source: 'rotation', arm: 'other' } })
  const nullArm = evidence('null-arm.json', { lane: 'null-arm-lane', advisor_rotation: { source: 'rotation', arm: null } })
  const nonBuild = evidence('non-build.json', { lane: 'non-build-lane', advisor_rotation: { source: 'rotation', arm: 'none' } })
  const dry = evidence('dry.json', { lane: 'dry-lane', advisor_rotation: { source: 'rotation', arm: 'none' } })
  // A reused lane name: the record cannot prove which run it describes, so the later unrecorded run stays unrecorded.
  const reused = evidence('reused.dispatch.json', { lane: 'reused-lane', advisor_rotation: { source: 'rotation', arm: 'none' } })
  assert.deepEqual(advisorSourceBackfill(ledger, [reused]), [{ path: reused, outcome: 'ambiguous' }])
  assert.equal(ledger.dumpTable('run_configurations').find(({ adw_id }) => adw_id === 'advisor-source-s7-reused-late').advisor_source, null)
  // MUTATION S7-dry: allow dry-run to call the writer; outcome and stored source prove it is write-free.
  assert.deepEqual(advisorSourceBackfill(ledger, [dry], { dryRun: true }), [{ path: dry, outcome: 'would-backfill', adw_id: 'advisor-source-s7-dry' }])
  assert.equal(ledger.dumpTable('run_configurations').find(({ adw_id }) => adw_id === 'advisor-source-s7-dry').advisor_source, null)
  // MUTATION S7-order: reorder or collapse path outcomes; this literal pins input order and every named branch.
  assert.deepEqual(advisorSourceBackfill(ledger, [malformed, array, badLane, noRun, mismatch, nullArm, nonBuild, unique, unique, ambiguous]), [
    { path: malformed, outcome: 'unreadable' },
    { path: array, outcome: 'unreadable' },
    { path: badLane, outcome: 'unreadable' },
    { path: noRun, outcome: 'no-run' },
    { path: mismatch, outcome: 'arm-mismatch' },
    { path: nullArm, outcome: 'arm-mismatch' },
    { path: nonBuild, outcome: 'no-run' },
    { path: unique, outcome: 'backfilled', adw_id: 'advisor-source-s7-unique' },
    { path: unique, outcome: 'already-recorded' },
    { path: ambiguous, outcome: 'ambiguous' },
  ])
  // MUTATION S7-evidence: delete or move backfilled++ before source/grant eligibility; only this eligible row counts.
  const readout = advisorArmsReadout(ledger, { arms: ['none'] })
  assert.equal(readout.backfilled, 1)
  assert.equal(readout.excluded.source_default, 1)
  assert.equal(readout.excluded.ungranted, 1)
  const uniqueRow = ledger.dumpTable('run_configurations').find(({ adw_id }) => adw_id === 'advisor-source-s7-unique')
  const ungrantedRow = ledger.dumpTable('run_configurations').find(({ adw_id }) => adw_id === 'advisor-source-s7-ungranted')
  assert.deepEqual([uniqueRow.advisor_source, uniqueRow.advisor_source_evidence], ['rotation', unique])
  assert.deepEqual([ungrantedRow.advisor_source, ungrantedRow.advisor_source_evidence], ['rotation', 'prior-evidence'])
  // MUTATION S7-replay: omit update-writer replay; evidence must reproduce into an independent ledger.
  const replay = openTestLedger(); replayJsonl(ledger._jsonlPath, replay)
  assert.equal(replay.dumpTable('run_configurations').find(({ adw_id }) => adw_id === 'advisor-source-s7-unique').advisor_source_evidence, unique)
  replay.close(); ledger.close()
})

test('A9', () => {
  const ledger = advisorArmTestRun('a9-1', 'first')
  for (let i = 2; i <= 3; i++) advisorArmTestRun(`a9-${i}`, 'first', '["builder"]', ledger)
  advisorArmTestRun('a9-4', 'second', '["builder"]', ledger)
  advisorArmTestRun('a9-5', 'third', '["builder"]', ledger)
  advisorArmTestRun('a9-6', 'fourth', '["builder"]', ledger)
  advisorArmTestRun('a9-7', 'fourth', '["builder"]', ledger)
  const arms = ['first', 'second', 'third', 'fourth']
  const row = advisorArmsReadout(ledger, { arms })
  assert.deepEqual(row.arms.map((arm) => arm.runs), [3, 1, 1, 2])
  assert.equal(row.next_arm, 'second')
  const dbPath = ledger._dbPath
  ledger.close()
  const env = { ...process.env, DEVTEAM_LEDGER_DB: dbPath }
  const json = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--arms', arms.join(','), '--json'], { env, encoding: 'utf8' })
  const text = spawnSync(process.execPath, [SCRIPT, 'advisor-arms', '--arms', arms.join(',')], { env, encoding: 'utf8' })
  if (json.status === 0 && text.status === 0) {
    assert.equal(JSON.parse(json.stdout).next_arm, 'second')
    assert.match(text.stdout, /next_arm: second/)
    for (const arm of JSON.parse(json.stdout).arms) assert.match(text.stdout, new RegExp(`${arm.arm}: runs=${arm.runs}`))
  } else {
    assert.match(json.stderr + text.stderr, /degraded/)
  }
})
