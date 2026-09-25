import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync, readdirSync, statSync,
} from 'node:fs'

import { join } from 'node:path'

import { spawnSync, spawn } from 'node:child_process'

import { ROOT, scratchDir } from './helpers.mjs'

import {
  openLedger, replayJsonl, isoMs, TABLES, MIGRATIONS, applyMigrations, DRIVER_GONE_THRESHOLD_MS, DRIVER_STATES, RUN_OBSERVATION_SOURCES, RUN_OBSERVATION_COLUMNS, RUN_OBSERVATION_WRITE_VERB, SESSION_STATUSES, SESSION_OUTCOMES, SEAT_VALUE_SOURCES, TERMINAL_ACTORS, ESCALATION_CAUSE_UNCLASSIFIED, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError, MODIFIER_KINDS, INTAKE_DISPATCH_OUTCOMES, SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, CELL_FAILURE_ATTRIBUTIONS, RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage, REQUEST_MAX_CHARS, USAGE_ABSENT_CAUSES, usageAbsentCause, AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS, CELL_RATE_FLOOR, SCREENER_PROPOSAL_OUTCOMES, CELL_PRICE_UNITS, REVIEW_VERDICTS, PHASE_SLOT_WAIT_KINDS, PHASE_SLOT_WAIT_DEPTH_ABSENT, PHASE_SLOT_WAIT_ABSENT, NARRATION_OUTCOMES, EVAL_ENVELOPE_STATUSES, EVAL_ABSENT_REASONS, EVAL_PAYLOAD_KEYS, ingestJournal, ingestExternalFenceRegister, JOURNAL_FACT_KEYS, JOURNAL_FACT_EVENTS, PLANNER_SYMBOLS_ARMS, PLANNER_SYMBOLS_SAMPLE_FLOOR, bootstrapPercentile,
} from '../scripts/factory/ledger.mjs'

import { FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, VARIANT_NAMES, SUITE_SLOT_PHASE_NAMES, anchorAbsentWhy, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS } from '../crew/drive.mjs'

import { emitAdapter, SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS } from '../crew/seat-io.mjs'

import { modelString as piModelString } from '../crew/adapters/adapter-pi.mjs'

import { _resetNoticeGuardsForTest, openRun, parseProposalBrief } from '../scripts/factory/emit.mjs'

import { loadDurableEscalationRecord, proposalFromResponse, proposalPrompt, triageEscalation } from '../scripts/factory/escalation-triage.mjs'

import { bootTieredRun } from './factory-ledger.test.mjs'

import { NONCE_PREFIX, SCRIPT, require, SQLITE_OK, SKIP, bootBriefRun, fixture, paneReviewRun, trackChild, nextDir, run, openTestLedger, openB499Ledger, seedCellUsage, makeUnenforcedSeatIndexDb, exerciseEveryWriter, seedTaskAgentSession, MARKER_ADW, seedAllWritersWithMarker, MARKER_PLAIN, MARKER_NONCE_ONLY, CALIBRATED_RENDEZVOUS_DELAY_MS, CALIBRATED_RENDEZVOUS_DELAYS_MS, resolveRendezvousDelayMs, runConcurrentEmitterTrial, RUNSET_SINCE, RUNSET_UNTIL, seedRun, seedConfigurationRun, seedConfigurationSeat, EXECUTION_AXIS_BOOT_CONFIGURATION, executionAxisState, writeExecutionAxisCrew, writeExecutionAxisJournal, executionAxisRuntime, executionAxisRow, readerFixture, ADVISOR_AB_EPOCH, advisorAbFixture, advisorAbEnvelope, advisorAbFinding, runAdvisorAb, advisorReasons, advisorNote, SANDBOX_LEDGER_URL, SANDBOX_DEFAULT_RESOLVER, runSandboxChild, B381_PROVIDER_FAILURE_LINE, B395_SLOT_WAIT_GATE_LINE, B395_SLOT_WAIT_WARM_LINE, B395_SLOT_WAIT_COLD_LINE, B395_OLD_CORPUS_LINES, B381_PLAN_SCOPE_LINE, B381_TIMEOUT_REASK_LINE, B381_RPC_EXIT_LINE, B381_PLAN_ADOPTION_LINE, B381_EXTERNAL_REGISTER, ingestJournalLine, journalFactsCli, measuredJournalFactsDb, assertMeasuredAndAbsent, writeTurnsCorpusJournal, turnsCorpusPayload, builderTurnRole, holdoutLedger, addHoldoutLane, holdoutRows, TRIAGE_MODEL, makeTriageFixture, triageLedger, triageResponse } from './factory-ledger.test.mjs'




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
test('cellFailures classifies synthetic sessions without dropping failures', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const common = { task_slug: 'synthetic-failures', role: 'builder', agent: 'claude', provider: 'anthropic', model_id: 'sonnet', effort: 'high', kind: 'boot-refusal' }
  try {
    ledger.startSession({ adw_id: 'ordinary-failure', repo_slug: 'r', task_slug: 'ordinary-failure' })
    ledger.startSession({ adw_id: 'synthetic-failure', repo_slug: 'r', task_slug: 'synthetic-failure' })
    ledger.recordCellFailure({ ...common, adw_id: 'ordinary-failure', created_at: '2024-01-01T00:00:00.000Z' })
    ledger.recordCellFailure({ ...common, adw_id: 'synthetic-failure', created_at: '2024-01-01T00:00:01.000Z' })
    ledger.recordCellFailure({ ...common, created_at: '2024-01-01T00:00:02.000Z' })
    const db = new (require('node:sqlite').DatabaseSync)(ledger._dbPath)
    try {
      db.prepare('UPDATE sessions SET synthetic_reason = ? WHERE adw_id = ?').run('gate_scratch_checkout', 'synthetic-failure')
    } finally { db.close() }

    const rows = ledger.cellFailures()
    assert.equal(rows.length, 1)
    const failure = rows[0]
    assert.deepEqual({ failures: failure.failures, run_less: failure.run_less, host_attributed: failure.host_attributed, synthetic: failure.synthetic }, {
      failures: 3, run_less: 1, host_attributed: 0, synthetic: 1,
    })
    assert.equal(failure.failures - failure.run_less - failure.synthetic, 1, 'the ordinary run-attributed row is not synthetic')
  } finally { ledger.close() }
})
test('attempt windows use run seat timestamps rather than agent start timestamps', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const since = '2024-01-02T00:00:00.000Z'
  const until = '2024-01-02T01:00:00.000Z'
  const cell = { role: 'builder', agent: 'pi', provider: 'openai', model_id: 'attempt-cell', model: 'attempt-cell', effort: 'high', transport: 'headless-json', source: 'roster', policy_state: 'passed', warnings: [] }
  const seat = (adw_id, created_at, over = {}) => {
    ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id, started_at: created_at })
    ledger.recordRunSeat({ ...cell, adw_id, created_at, ...over })
  }
  for (let index = 1; index <= 12; index += 1) {
    seat(`attempt-${index}`, `2024-01-02T00:00:${String(index).padStart(2, '0')}.000Z`)
  }
  seat('attempt-old', '2024-01-01T23:59:59.000Z')
  seat('attempt-until', until)
  seat('attempt-synthetic', '2024-01-02T00:00:30.000Z')
  const db = new (require('node:sqlite').DatabaseSync)(ledger._dbPath)
  try {
    db.prepare('UPDATE sessions SET synthetic_reason = ? WHERE adw_id = ?').run('gate_scratch_checkout', 'attempt-synthetic')
  } finally { db.close() }

  try {
    const rows = ledger.cellAttempts({ since, until })
    assert.deepEqual(rows.map((row) => ({ ...row })), [{
      provider: 'openai', model_id: 'attempt-cell', model_key: null, agent: 'pi', effort: 'high', role: 'builder',
      attempts: 12, first_at: '2024-01-02T00:00:01.000Z', last_at: '2024-01-02T00:00:12.000Z',
    }])
    assert.equal(rows[0].attempts, 12)
    assert.deepEqual(Object.fromEntries(Object.entries(rows[0]).filter(([key]) => ['provider', 'model_id', 'agent', 'effort', 'role'].includes(key))), {
      provider: 'openai', model_id: 'attempt-cell', agent: 'pi', effort: 'high', role: 'builder',
    })
  } finally { ledger.close() }
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
    'anthropic/claude-opus-5-5': { read: 0.2, write: 8 },
    'anthropic/claude-opus-5': { read: 0.5, write: 10 },
    'anthropic/claude-sonnet-5': { read: 0.2, write: 4 },
    'anthropic/claude-haiku-4-5': { read: 0.1, write: 2 },
    'anthropic/claude-fable-5': { read: 1, write: 20 },
    'anthropic/claude-fable-5-1': { read: 0.25, write: 20 },
    'openai/gpt-6-sol': { read: 0.2, write: 2.5 },
    'openai/gpt-5.6-sol': { read: 0.4, write: 0 },
    'openai/gpt-5.6-terra': { read: 0.2, write: 0 },
    'openai/gpt-5.6-luna': { read: 0.02, write: 0 },
    'openai/gpt-6-luna': { read: 0.01, write: 0.125 },
    'openai/gpt-6-astra': { read: 1, write: 12.5 },
    "meta/muse-spark-1.3-contributor": { read: 0.002, write: 0 },
    'llama-swap/qwen3.8-27b': { read: 0, write: 0 },
    'llama-swap/gpt-oss-20b': { read: 0, write: 0 },
    'llama-swap/gemma4-31b': { read: 0, write: 0 },
  }
  const expectedSources = {
    anthropic: "anthropic published prompt-caching multipliers applied to this entry's own cost_in_per_mtok: cache read 0.10x, 1h-TTL cache write 2.00x. billed_cache_write_tokens collapses the 1h and 5m TTLs into one column, so pricing every cache write at the 1h rate is an explicit lossy convention, not a reconstruction of any session's TTL; 1h is the ratified one because this task's acceptance figures require it and because both sampled b168-paneusage claude-opus-5 pane seats used only 1h writes.",
    openai: "openai published prompt-caching rates applied to this entry's own cost_in_per_mtok: cached input 0.10x, and cache writes are not charged, so cost_cache_write_per_mtok is a published 0.00x rate rather than an absent one.",
    "openai/gpt-6-astra": "pi's model directory publishes these rates directly for openai-codex/gpt-6-astra rather than as multipliers of this entry's cost_in_per_mtok: cacheRead 1.00 and cacheWrite 12.50 per Mtok. The directory also declares a second price tier above 272000 input tokens (input 20, output 50->75, cacheRead 2, cacheWrite 25); that tier is NOT represented here because the schema carries one rate per column, and it is unreachable within a single request since the tier threshold equals this model's whole context window. A conversation billed above the threshold would be underpriced by this entry.",
    'anthropic/claude-opus-5-5': 'models.dev lists anthropic/claude-opus-5-5 at input 4, cacheRead 0.2 and cacheWrite 5 per Mtok. The cache read is recorded as published: 0.05x, not the 0.10x other anthropic entries carry. models.dev\'s cacheWrite is the 5-minute rate; this entry prices writes at the ratified 1h-TTL rate, because billed_cache_write_tokens collapses both TTLs into one column and the anthropic convention prices that column at 1h. Claude Code 2.1.280\'s model price table publishes that rate for this model (tier_4_20_cache_read_0_20: cache_write_5m 5, cache_write_1h 8), equal to anthropic\'s 2.00x multiplier.',
    'anthropic/claude-fable-5-1': 'models.dev lists anthropic/claude-fable-5-1 at input 10, cacheRead 0.25 and cacheWrite 12.5 per Mtok. The cache read is recorded as published: 0.025x, not the 0.10x other anthropic entries carry. models.dev\'s cacheWrite is the 5-minute rate; this entry prices writes at the ratified 1h-TTL rate, because billed_cache_write_tokens collapses both TTLs into one column and the anthropic convention prices that column at 1h. Claude Code 2.1.280\'s model price table publishes both for this model (tier_10_50_cache_read_0_25: cache_write_5m 12.5, cache_write_1h 20, cache_read 0.25).',
    'openai/gpt-6-sol': 'models.dev lists cache writes at 2.5 per Mtok for openai/gpt-6-sol, contradicting the older statement that OpenAI cache writes are not charged. It lists openai/gpt-6-sol at input 2, output 10, cacheRead 0.2, cacheWrite 2.5 per Mtok. It also declares a second price tier above 272000 input tokens (input 4, output 15, cacheRead 0.4, cacheWrite 5) that this single-rate entry cannot represent; the openai-codex route this model is seated through serves a 272K context, so one request cannot reach it there, but a route serving the listed 1050000 context would be underpriced by this entry.',
    'openai/gpt-6-luna': 'models.dev lists openai/gpt-6-luna at input 0.1, output 0.5, cacheRead 0.01, cacheWrite 0.125 per Mtok and context 1050000. It also declares a second price tier above 272000 input tokens (input 0.2, output 0.75, cacheRead 0.02, cacheWrite 0.25) that this single-rate entry cannot represent; the openai-codex route this model is seated through serves a 272K context, so one request cannot reach it there, but a route serving the listed 1050000 context would be underpriced by this entry.',
    "meta/muse-spark-1.3-contributor": "openrouter publishes a cacheRead of 0.002 per Mtok against a 0.1 input rate for meta/muse-spark-1.3-contributor — a 0.02x multiplier, NOT the 0.10x that anthropic and openai publish. The figure is recorded as served rather than normalised to the ratified 0.10x, because a rate nobody charges is not a cheaper guess, it is a wrong one. cacheWrite is a published 0.00x rate rather than an absent one.",
    'llama-swap/qwen3.8-27b': 'llama-swap local serving has a published 0 rate rather than an absent one for llama-swap/qwen3.8-27b cache reads and writes.',
    'llama-swap/gpt-oss-20b': 'llama-swap local serving has a published 0 rate rather than an absent one for llama-swap/gpt-oss-20b cache reads and writes.',
    'llama-swap/gemma4-31b': 'llama-swap local serving has a published 0 rate rather than an absent one for llama-swap/gemma4-31b cache reads and writes.',
  }
  assert.deepEqual(Object.keys(roster.models).sort(), Object.keys(expectedRates).sort())
  for (const [key, expected] of Object.entries(expectedRates)) {
    const model = roster.models[key]
    assert.deepEqual({ read: model.cost_cache_read_per_mtok, write: model.cost_cache_write_per_mtok }, expected)
    if (key.startsWith('llama-swap/')) {
      assert.equal(model.cost_in_per_mtok, 0)
      assert.equal(model.cost_out_per_mtok, 0)
      assert.equal(model.cost_cache_read_per_mtok, 0)
      assert.equal(model.cost_cache_write_per_mtok, 0)
    } else if (key === "meta/muse-spark-1.3-contributor") {
      // openrouter serves this model's cache reads at 0.02x, not the 0.10x anthropic
      // and openai publish. Pinned to the SERVED figure so a 0.10x normalisation
      // cannot creep back in: the exemption is this one key, not the rule.
      assert.ok(Math.abs(model.cost_cache_read_per_mtok - model.cost_in_per_mtok * 0.02) <= 1e-12)
    } else if (key === 'anthropic/claude-opus-5-5') {
      // models.dev (2026-09-23) lists this model's cache reads at 0.2 against a 4 input
      // rate: 0.05x, not the 0.10x multiplier. Pinned to the PUBLISHED figure, as muse
      // is above, so neither a 0.10x normalisation nor a drift passes silently.
      assert.ok(Math.abs(model.cost_cache_read_per_mtok - model.cost_in_per_mtok * 0.05) <= 1e-12)
    } else if (key === 'anthropic/claude-fable-5-1') {
      // Published at 0.25 against a 10 input — 0.025x — by models.dev and by Claude Code's own
      // price table; pinned to that figure for the same reason as Opus 5.5 above.
      assert.ok(Math.abs(model.cost_cache_read_per_mtok - model.cost_in_per_mtok * 0.025) <= 1e-12)
    } else {
      assert.ok(Math.abs(model.cost_cache_read_per_mtok - model.cost_in_per_mtok * 0.10) <= 1e-12)
    }
    const vendor = key.slice(0, key.indexOf('/'))
    // Every anthropic write is priced at the ratified 1h-TTL rate, 2.00x input, whatever
    // 5-minute figure a catalog lists (models.dev lists 1.25x for all of them).
    if (vendor === 'anthropic') assert.ok(Math.abs(model.cost_cache_write_per_mtok - model.cost_in_per_mtok * 2) <= 1e-12, key)
    assert.equal(model.cache_rate_source, expectedSources[key] || expectedSources[vendor])
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
test('A1: run observations have the complete six-field schema', { skip: SKIP }, () => {
  assert.deepEqual([...RUN_OBSERVATION_COLUMNS], ['observed_at', 'observer', 'driver_state', 'source', 'reason_code', 'detail'])
  const ledger = openTestLedger()
  const replayed = openTestLedger()
  try {
    const names = ledger.columnNames('run_observations')
    assert.ok(names.includes('adw_id'))
    for (const field of RUN_OBSERVATION_COLUMNS) assert.ok(names.includes(field), `${field} is required`)
    ledger.recordRunObservation({
      adw_id: 'observation-schema', observed_at: '2026-09-11T12:00:00.000Z', observer: 'test',
      driver_state: 'unknown', source: 'heartbeat', reason_code: 'heartbeat-unmeasured', detail: { measured: false },
    })
    const result = replayJsonl(ledger._jsonlPath, replayed)
    assert.equal(result.complete, true)
    assert.deepEqual(replayed.runObservationsFor(['observation-schema']).map(({ id, ...row }) => row), [{
      adw_id: 'observation-schema', observed_at: '2026-09-11T12:00:00.000Z', observer: 'test',
      driver_state: 'unknown', source: 'heartbeat', reason_code: 'heartbeat-unmeasured', detail: '{"measured":false}',
    }])
  } finally { ledger.close(); replayed.close() }
})
test('A2: run observations append instead of updating', { skip: SKIP }, () => {
  assert.equal(RUN_OBSERVATION_WRITE_VERB, 'INSERT')
  const ledger = openTestLedger()
  try {
    const first = { adw_id: 'observation-append', observer: 'watch', driver_state: 'alive', source: 'process_group', reason_code: 'pid-alive' }
    ledger.recordRunObservation({ ...first, observed_at: '2026-09-11T12:00:00.000Z', detail: 'first evidence' })
    ledger.recordRunObservation({ ...first, observed_at: '2026-09-11T12:00:01.000Z', driver_state: 'gone', reason_code: 'pid-gone', detail: 'second evidence' })
    const rows = ledger.runObservationsFor(['observation-append'])
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row.detail), ['first evidence', 'second evidence'])
    assert.ok(rows[1].id > rows[0].id)
    assert.equal(UPDATE_ONLY_WRITERS.includes('recordRunObservation'), false)
    assert.equal(WRITER_MIRROR_TABLES.recordRunObservation, 'run_observations')
  } finally { ledger.close() }
})
test('B1: driver state is a closed three-value enum', { skip: SKIP }, () => {
  assert.deepEqual([...DRIVER_STATES], ['alive', 'gone', 'unknown'])
  assert.deepEqual([...RUN_OBSERVATION_SOURCES], ['daemon', 'process_group', 'cmux', 'heartbeat'])
  const ledger = openTestLedger()
  try {
    assert.throws(() => ledger.recordRunObservation({
      adw_id: 'closed-observation', observed_at: '2026-09-11T12:00:00.000Z', observer: 'test',
      driver_state: 'indeterminate', source: 'heartbeat', reason_code: 'bad-state', detail: 'invalid',
    }))
  } finally { ledger.close() }
})
test('sessions preserve a stale heartbeat as a running settlement', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const staleAt = Date.now() - DRIVER_GONE_THRESHOLD_MS
  ledger.startSession({ adw_id: '682c0155', repo_slug: 'r', task_slug: 'b609-siblingleak' })
  ledger.heartbeat({ adw_id: '682c0155', target: 'session', at: staleAt })
  ledger.startSession({ adw_id: 'fresh-control', repo_slug: 'r', task_slug: 'fresh-control' })
  ledger.heartbeat({ adw_id: 'fresh-control', target: 'session', at: Date.now() })
  ledger.startSession({ adw_id: 'terminal-control', repo_slug: 'r', task_slug: 'terminal-control' })
  ledger.endSession({ adw_id: 'terminal-control', status: 'ok', outcome: 'success', terminal_reason: 'natural-completion', terminal_actor: 'driver' })
  ledger.close()

  const result = run(['sessions'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0)
  const payload = JSON.parse(result.stdout)
  const stale = payload.sessions.find((row) => row.adw_id === '682c0155')
  const fresh = payload.sessions.find((row) => row.adw_id === 'fresh-control')
  const terminal = payload.sessions.find((row) => row.adw_id === 'terminal-control')
  assert.equal(stale.status, 'running')
  assert.equal(Object.hasOwn(stale, 'status_absent_reason'), false)
  assert.equal(stale.ended_at, null)
  assert.equal(stale.outcome, null)
  assert.equal(stale.terminal_reason, null)
  assert.equal(stale.terminal_actor, null)
  assert.equal(fresh.status, 'running')
  assert.equal(terminal.status, 'ok')
  assert.equal(terminal.outcome, 'success')
  assert.equal(terminal.terminal_reason, 'natural-completion')
  assert.equal(terminal.terminal_actor, 'driver')
})
test('A1 execution journal supplies explicit axis to first ledger row', { skip: SKIP }, () => {
  const stateDir = executionAxisState()
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  writeExecutionAxisCrew(stateDir)
  writeExecutionAxisJournal(stateDir, [
    { event: 'run-start' },
    { event: 'run-configuration', run_configuration: executionAxisRuntime({ requested: 'scout', effective: 'scout', source: 'explicit', status: 'existing' }) },
  ])
  const emitter = openRun({ stateDir, repoSlug: 'r', taskSlug: 'execution-axis', dbPath, stderr: { write: () => {} } })
  try {
    emitter.startRun()
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = executionAxisRow(ledger, emitter.adwId)
      assert.ok(row)
      assert.deepEqual({
        requested_execution: row.requested_execution,
        effective_execution: row.effective_execution,
        execution_source: row.execution_source,
      }, {
        requested_execution: 'scout', effective_execution: 'scout', execution_source: 'explicit',
      })
    } finally { ledger.close() }
  } finally {
    emitter.dispose()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
test('C1 journal axis is present on the first insert-or-ignore write', { skip: SKIP }, () => {
  const stateDir = executionAxisState()
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  const poisonedBoot = {
    ...EXECUTION_AXIS_BOOT_CONFIGURATION,
    execution: { requested: 'full', effective: 'full', source: 'poisoned_fixture' },
  }
  writeExecutionAxisCrew(stateDir, poisonedBoot)
  writeExecutionAxisJournal(stateDir, [
    { event: 'run-start' },
    { event: 'run-configuration', run_configuration: executionAxisRuntime({ requested: 'repair', effective: 'repair', source: 'explicit', status: 'existing' }) },
  ])
  const emitter = openRun({ stateDir, repoSlug: 'r', taskSlug: 'execution-axis', dbPath, stderr: { write: () => {} } })
  try {
    emitter.startRun()
    assert.equal(emitter.emit((handle) => handle.recordRunConfiguration({
      adw_id: emitter.adwId,
      schema_version: 1,
      task_profile: 'implementation', task_profile_source: 'explicit',
      requested_execution: 'full', effective_execution: 'full', execution_source: 'poisoned_second_write',
      requested_assurance: 'standard', effective_assurance: 'standard', assurance_source: 'explicit',
      legacy_variant: null, legacy_tier: 'fixture-tier',
    })), true)
  } finally { emitter.dispose() }
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const rows = ledger.dumpTable('run_configurations').filter((row) => row.adw_id === emitter.adwId)
    assert.equal(rows.length, 1)
    assert.deepEqual({
      requested_execution: rows[0].requested_execution,
      effective_execution: rows[0].effective_execution,
      execution_source: rows[0].execution_source,
    }, {
      requested_execution: 'repair', effective_execution: 'repair', execution_source: 'explicit',
    })
  } finally {
    ledger.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
test('D1 journal supplies resolved default execution with null request', { skip: SKIP }, () => {
  const stateDir = executionAxisState()
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  writeExecutionAxisCrew(stateDir)
  writeExecutionAxisJournal(stateDir, [
    { event: 'run-start' },
    { event: 'run-configuration', run_configuration: executionAxisRuntime({ requested: null, effective: 'scout', source: 'profile_default', status: 'existing' }) },
  ])
  const emitter = openRun({ stateDir, repoSlug: 'r', taskSlug: 'execution-axis', dbPath, stderr: { write: () => {} } })
  try {
    emitter.startRun()
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = executionAxisRow(ledger, emitter.adwId)
      assert.ok(row)
      assert.deepEqual({
        requested_execution: row.requested_execution,
        effective_execution: row.effective_execution,
        execution_source: row.execution_source,
      }, {
        requested_execution: null,
        effective_execution: 'scout',
        execution_source: 'profile_default',
      })
    } finally { ledger.close() }
  } finally {
    emitter.dispose()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
test('E1 missing or unreadable runtime execution remains null without inference', { skip: SKIP }, () => {
  const oldRuntime = { event: 'run-configuration', run_configuration: executionAxisRuntime({ requested: 'full', effective: 'full', source: 'explicit', status: 'existing' }) }
  const cases = [
    {
      label: 'absent',
      current: { event: 'phase', variant: 'distinctive-legacy-variant', phases: ['distinctive-phase'], roles: ['distinctive-role'] },
    },
    {
      label: 'malformed',
      current: {
        event: 'run-configuration',
        variant: 'distinctive-malformed-variant', phases: ['distinctive-malformed-phase'], roles: ['distinctive-malformed-role'],
        run_configuration: { ...EXECUTION_AXIS_BOOT_CONFIGURATION, execution: ['not-an-axis'] },
      },
    },
  ]
  for (const { label, current } of cases) {
    const stateDir = executionAxisState()
    const dbPath = join(stateDir, 'ledger', 'ledger.db')
    writeExecutionAxisCrew(stateDir)
    writeExecutionAxisJournal(stateDir, [
      { event: 'run-start' }, oldRuntime,
      { event: 'run-start' }, current,
    ])
    const emitter = openRun({ stateDir, repoSlug: 'r', taskSlug: 'execution-axis', dbPath, stderr: { write: () => {} } })
    try {
      emitter.startRun()
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      try {
        const row = executionAxisRow(ledger, emitter.adwId)
        assert.ok(row)
        assert.deepEqual({
          requested_execution: row.requested_execution,
          effective_execution: row.effective_execution,
          execution_source: row.execution_source,
        }, { requested_execution: null, effective_execution: null, execution_source: null }, label)
      } finally { ledger.close() }
    } finally {
      emitter.dispose()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }
})
test('F1 refused configuration write is counted and never load-bearing', { skip: SKIP }, () => {
  _resetNoticeGuardsForTest()
  const stateDir = executionAxisState()
  const dbPath = join(stateDir, 'ledger', 'ledger.db')
  writeExecutionAxisCrew(stateDir)
  writeExecutionAxisJournal(stateDir, [
    { event: 'run-start' },
    { event: 'run-configuration', run_configuration: executionAxisRuntime({ requested: 'scout', effective: 'scout', source: 'explicit', status: 'existing' }) },
  ])
  const stderrLines = []
  let sessionCalls = 0
  let phaseCalls = 0
  const emitter = openRun({
    stateDir, repoSlug: 'r', taskSlug: 'execution-axis', dbPath, stderr: { write: (line) => stderrLines.push(String(line)) },
    _openLedger: () => ({
      startSession: () => { sessionCalls += 1 },
      recordRunConfiguration: () => { throw new Error('configuration refused') },
      startPhase: () => { phaseCalls += 1; return 1 },
      stats: () => ({ mirror_errors: 0 }),
      close: () => {},
    }),
  })
  try {
    assert.doesNotThrow(() => emitter.startRun())
    assert.equal(sessionCalls, 1)
    assert.equal(phaseCalls, 1)
    assert.equal(emitter.stats().dropped, 1)
    assert.equal(stderrLines.length, 1)
    assert.match(stderrLines[0], /^emit: emission dropped: configuration refused/)
  } finally {
    emitter.dispose()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
test('G1 configurations reports execution override tri-state', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    seedConfigurationRun(ledger, 'configuration-different-execution', '2024-01-01T00:00:00.000Z', {
      requested_execution: 'scout', effective_execution: 'full', execution_source: 'operator_override',
    })
    seedConfigurationRun(ledger, 'configuration-equal-execution', '2024-01-01T00:01:00.000Z', {
      requested_execution: 'scout', effective_execution: 'scout', execution_source: 'explicit',
    })
    seedConfigurationRun(ledger, 'configuration-unrequested-execution', '2024-01-01T00:02:00.000Z', {
      requested_execution: null, effective_execution: 'scout', execution_source: 'profile_default',
    })
    const executions = ledger.configurationReadout({ since: '2024-01-01T00:00:00.000Z' }).dimensions
      .filter((row) => row.dimension === 'execution')
    assert.equal(executions.length, 3)
    assert.equal(executions.find((row) => row.requested === 'scout' && row.effective === 'full').override, true)
    assert.equal(executions.find((row) => row.requested === 'scout' && row.effective === 'scout').override, false)
    assert.equal(executions.find((row) => row.requested === null && row.effective === 'scout').override, null)
  } finally { ledger.close() }
})
test('A1: configuration readout reports profile execution and assurance', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const since = '2024-01-01T00:00:00.000Z'
  const until = '2024-01-02T00:00:00.000Z'
  let closed = false
  try {
    seedConfigurationRun(ledger, 'configuration-inside', '2024-01-01T00:10:00.000Z', {
      requested_execution: 'standard', effective_execution: 'rigorous', execution_source: 'operator_override',
    })
    seedRun(ledger, 'configuration-historical', '2024-01-01T00:20:00.000Z')
    seedConfigurationRun(ledger, 'configuration-outside', '2024-01-02T00:10:00.000Z')

    const readout = ledger.configurationReadout({ since, until })
    assert.equal(readout.runs, 2, 'the denominator is every session started in the half-open window')
    assert.equal(readout.configurations, 1)
    assert.equal(readout.measured, true)
    assert.deepEqual(readout.dimensions.map((row) => row.dimension), ['profile', 'execution', 'assurance'])
    const profile = readout.dimensions[0]
    assert.deepEqual({ value: profile.value, source: profile.source }, { value: 'implementation', source: 'explicit' })
    assert.equal(Object.hasOwn(profile, 'requested'), false)
    const execution = readout.dimensions[1]
    assert.deepEqual({ requested: execution.requested, effective: execution.effective }, { requested: 'standard', effective: 'rigorous' })
    assert.equal(execution.override, true)
    const assurance = readout.dimensions[2]
    assert.equal(assurance.dimension, 'assurance')
    for (const row of readout.dimensions) {
      assert.equal(row.count, 1)
      assert.equal(row.denominator, 1)
    }

    const dbPath = ledger._dbPath
    ledger.close()
    closed = true
    const result = run(['configurations', '--since', '2024-01-01T00:00:00Z', '--until', '2024-01-02T00:00:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.since, since)
    assert.equal(payload.until, until)
    assert.equal(payload.runs, 2)
    assert.equal(payload.configurations, 1)
    assert.match(payload.definition.override, /null when no requested value was recorded/)
    assert.match(payload.definition.override, /source alias means a name translation rather than an operator override/)
  } finally {
    if (!closed) ledger.close()
  }
})
test('B1: configuration readout preserves requested and effective overrides', { skip: SKIP }, async (t) => {
  const ledger = openTestLedger()
  try {
    seedConfigurationRun(ledger, 'configuration-override', '2024-01-01T00:00:00.000Z', {
      requested_execution: 'standard', effective_execution: 'rigorous', execution_source: 'operator_override',
    })
    const execution = ledger.configurationReadout({ since: '2024-01-01T00:00:00.000Z' }).dimensions
      .find((row) => row.dimension === 'execution')
    assert.deepEqual({ requested: execution.requested, effective: execution.effective, override: execution.override }, {
      requested: 'standard', effective: 'rigorous', override: true,
    })

    await t.test('configuration readout preserves requested and effective overrides', () => {
      seedConfigurationRun(ledger, 'configuration-unrequested-assurance', '2024-01-01T00:01:00.000Z', {
        requested_assurance: null, effective_assurance: 'standard', assurance_source: 'migration_default',
      })
      const assurance = ledger.configurationReadout({ since: '2024-01-01T00:00:00.000Z' }).dimensions
        .find((row) => row.dimension === 'assurance' && row.requested === null && row.effective === 'standard')
      assert.equal(assurance.override, null)
      assert.deepEqual({ requested: assurance.requested, effective: assurance.effective, override: assurance.override }, {
        requested: null, effective: 'standard', override: null,
      })
    })
  } finally { ledger.close() }
})
test('C1: configuration readout preserves source provenance', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    seedConfigurationRun(ledger, 'configuration-sources', '2024-01-01T00:00:00.000Z')
    SEAT_VALUE_SOURCES.forEach((source, index) => seedConfigurationSeat(ledger, 'configuration-sources', `role-${index}`, source))
    const readout = ledger.configurationReadout({ since: '2024-01-01T00:00:00.000Z' })
    assert.deepEqual(readout.seats.map((seat) => seat.source).sort(), [...SEAT_VALUE_SOURCES].sort())
    for (const seat of readout.seats) {
      assert.equal(seat.policy_state, 'passed')
      assert.deepEqual(seat.warnings, [`warning-${seat.role}`])
    }
  } finally { ledger.close() }
})
test('D1: configuration readout pairs every count with its denominator', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    seedConfigurationRun(ledger, 'configuration-denominator-a', '2024-01-01T00:00:00.000Z')
    seedConfigurationRun(ledger, 'configuration-denominator-b', '2024-01-01T00:01:00.000Z', {
      task_profile: 'review', requested_execution: 'review_only', effective_execution: 'review_only',
    })
    const payload = ledger.configurationReadout({ since: '2024-01-01T00:00:00.000Z' })
    const visit = (value) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) return value.forEach(visit)
      if (Object.hasOwn(value, 'count')) {
        assert.equal(typeof value.denominator, 'number', `count without numeric denominator: ${JSON.stringify(value)}`)
      }
      Object.values(value).forEach(visit)
    }
    visit(payload)
    assert.ok(payload.dimensions.every((row) => row.denominator === 2))
  } finally { ledger.close() }
})
test('E1: configuration readout marks an unmeasured window absent', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    seedRun(ledger, 'configuration-historical-only', '2024-01-01T00:00:00.000Z')
    const readout = ledger.configurationReadout({ since: '2024-01-01T00:00:00.000Z', until: '2024-01-02T00:00:00.000Z' })
    assert.equal(readout.runs, 1)
    assert.equal(readout.measured, false)
    assert.equal(readout.configurations, null)
    assert.deepEqual(readout.dimensions, [])
    assert.equal(readout.absent.run_configurations, 'no run_configurations rows in this window — not recorded, never a measured zero or inferred default')
    assert.notEqual(readout.configurations, 0)
  } finally { ledger.close() }
})
test('F1: configuration readout never marks a measured run absent', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    seedConfigurationRun(ledger, 'configuration-measured', '2024-01-01T00:00:00.000Z')
    const readout = ledger.configurationReadout({ since: '2024-01-01T00:00:00.000Z' })
    assert.equal(readout.measured, true)
    assert.equal(readout.configurations, 1)
    assert.ok(readout.dimensions.length > 0)
    assert.equal(Object.hasOwn(readout.absent, 'run_configurations'), false)
  } finally { ledger.close() }
})
test('G1: configuration query documentation names canonical commands and units', () => {
  const docs = readFileSync(join(ROOT, 'docs', 'ledger-queries.md'), 'utf8')
  const command = 'node scripts/factory/ledger.mjs configurations [--since <iso>] [--until <iso>]'
  const rows = docs.split('\n').filter((line) => line.startsWith('| Which task profile, execution shape, and assurance did runs use? |') || line.startsWith('| Which agent, model, effort and transport actually sat in each role? |'))
  assert.equal(rows.length, 2)
  assert.ok(rows[0].includes('`' + command + '`'))
  assert.ok(rows[1].includes('`' + command + '`'))
  assert.match(rows[0], /one run × configuration dimension/)
  assert.match(rows[1], /one effective role seat/)
  assert.doesNotMatch(docs, /Query `run_configurations` by `adw_id`/)
  assert.doesNotMatch(docs, /Query `run_seats` by `adw_id`/)
})
test('configurations CLI refuses positionals, inverted windows, and degraded mirrors', { skip: SKIP }, () => {
  const positional = run(['configurations', 'unexpected'])
  assert.equal(positional.status, 2)
  assert.match(positional.stderr, /takes no positional arguments/)
  const inverted = run(['configurations', '--since', '2024-01-02T00:00:00Z', '--until', '2024-01-01T00:00:00Z'])
  assert.equal(inverted.status, 2)
  assert.match(inverted.stderr, /--until must be later/)

  const corruptDir = nextDir()
  const corruptDb = join(corruptDir, 'ledger.db')
  writeFileSync(corruptDb, 'not a sqlite database')
  const degraded = run(['configurations'], { DEVTEAM_LEDGER_DB: corruptDb })
  assert.equal(degraded.status, 2)
  assert.equal(degraded.stdout, '')
  assert.match(degraded.stderr, /degraded/)
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
test('I1 ledger classifies review_only and verify_only runs as measured', { skip: SKIP }, () => {
  assert.equal(variantFromFirstMessage('review_only:r1'), 'review_only')
  assert.equal(variantFromFirstMessage('verify_only:r1'), 'verify_only')
  const ledger = openTestLedger()
  seedRun(ledger, 'variant-task-review-only', RUNSET_SINCE)
  ledger.recordEvent({ adw_id: 'variant-task-review-only', type: 'log', payload: { level: 'info', message: 'review_only:r1' } })
  ledger.recordEvent({ adw_id: 'variant-task-review-only', type: 'log', payload: { level: 'info', message: 'scope-gate:r1' } })
  const reviewReadout = ledger.taskReadout('variant-task-review-only')
  assert.equal(reviewReadout.variant, 'review_only')
  assert.equal('variant' in reviewReadout.absent, false)
  seedRun(ledger, 'variant-task-verify-only', RUNSET_SINCE)
  ledger.recordEvent({ adw_id: 'variant-task-verify-only', type: 'log', payload: { level: 'info', message: 'verify_only:r1' } })
  ledger.recordEvent({ adw_id: 'variant-task-verify-only', type: 'log', payload: { level: 'info', message: 'scope-gate:r1' } })
  const verifyReadout = ledger.taskReadout('variant-task-verify-only')
  assert.equal(verifyReadout.variant, 'verify_only')
  assert.equal('variant' in verifyReadout.absent, false)
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
  assert.equal(variantFromFirstMessage('verify_only:r1'), 'verify_only')
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
    ['unknown', [fence, '{"shape":"mechanical","strength":"workhorse","tier":"build"}', '```'].join('\n'), /unsupported key set/],
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
test('A1 narration measurements round-trip from journal to queryable ledger', { skip: SKIP }, () => {
  assert.deepEqual(NARRATION_OUTCOMES, ['accepted', 'refused'])
  assert.equal(WRITERS.includes('recordNarrationMeasurement'), true)
  assert.equal(WRITER_MIRROR_TABLES.recordNarrationMeasurement, 'narration_measurements')
  assert.equal(UPDATE_ONLY_WRITERS.includes('recordNarrationMeasurement'), false)
  assert.equal(JOURNAL_FACT_KEYS.narration, 'recordNarrationMeasurement')
  assert.deepEqual(TABLES.narration_measurements.columns.map(({ name }) => name), [
    'adw_id', 'attempted', 'model', 'duration_ms', 'outcome', 'reason', 'created_at',
  ])
  assert.deepEqual(TABLES.narration_measurements.unique, [['adw_id']])

  const rows = [
    {
      adw_id: 'b683-accepted', at: '2026-09-13T12:00:00.001Z',
      narration: { attempted: true, model: 'gpt-oss-20b', duration_ms: 6600, outcome: 'accepted', reason: null },
    },
    {
      adw_id: 'b683-timeout', at: '2026-09-13T12:00:00.002Z',
      narration: { attempted: true, model: 'qwen3.8-27b', duration_ms: 30000, outcome: 'refused', reason: 'narrator-timeout' },
    },
    {
      adw_id: 'b683-dead', at: '2026-09-13T12:00:00.003Z',
      narration: { attempted: true, model: 'gemma4-31b', duration_ms: 12, outcome: 'refused', reason: 'narrator-unreachable' },
    },
    {
      adw_id: 'b683-pre', at: '2026-09-13T12:00:00.004Z',
      narration: { attempted: false, model: null, duration_ms: null, outcome: 'refused', reason: 'narrator-unconfigured' },
    },
  ]
  const authorityPath = join(nextDir(), 'narration-authority.jsonl')
  const ledger = openTestLedger({ jsonlPath: authorityPath })
  let originalRows
  let originalFacts
  try {
    const journalPath = join(nextDir(), 'narration-journal.jsonl')
    writeFileSync(journalPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    assert.deepEqual(ingestJournal(journalPath, ledger), {
      applied: 4, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null,
    })
    originalRows = ledger.dumpTable('narration_measurements').map((row) => ({ ...row }))
    assert.deepEqual(originalRows, [
      { adw_id: 'b683-accepted', attempted: 1, model: 'gpt-oss-20b', duration_ms: 6600, outcome: 'accepted', reason: null, created_at: '2026-09-13T12:00:00.001Z' },
      { adw_id: 'b683-dead', attempted: 1, model: 'gemma4-31b', duration_ms: 12, outcome: 'refused', reason: 'narrator-unreachable', created_at: '2026-09-13T12:00:00.003Z' },
      { adw_id: 'b683-pre', attempted: 0, model: null, duration_ms: null, outcome: 'refused', reason: 'narrator-unconfigured', created_at: '2026-09-13T12:00:00.004Z' },
      { adw_id: 'b683-timeout', attempted: 1, model: 'qwen3.8-27b', duration_ms: 30000, outcome: 'refused', reason: 'narrator-timeout', created_at: '2026-09-13T12:00:00.002Z' },
    ])
    originalFacts = ledger.journalFacts({}).narration_measurements
    assert.deepEqual(originalFacts, {
      measured: true, measurements: 4, count: 4,
      outcomes: { accepted: 1, refused: 3 },
      reasons: { 'narrator-timeout': 1, 'narrator-unreachable': 1, 'narrator-unconfigured': 1 },
      models: { 'gemma4-31b': 1, 'gpt-oss-20b': 1, 'qwen3.8-27b': 1 },
      duration_ms: 36612, absent: null,
    })
  } finally { ledger.close() }

  const replayDir = nextDir()
  const replayDbPath = join(replayDir, 'replay.db')
  const replay = openLedger({ dbPath: replayDbPath, jsonlPath: join(replayDir, 'replay.jsonl'), stderr: { write: () => {} } })
  try {
    assert.deepEqual(replayJsonl(authorityPath, replay), {
      applied: 4, skipped: 0, failed: 0, complete: true, first_failure: null,
    })
    assert.deepEqual(replay.dumpTable('narration_measurements').map((row) => ({ ...row })), originalRows)
    assert.deepEqual(replay.journalFacts({}).narration_measurements, originalFacts)
  } finally { replay.close() }
  assert.deepEqual(journalFactsCli(replayDbPath).narration_measurements, originalFacts)

  const malformedPath = join(nextDir(), 'malformed-narration.jsonl')
  const malformed = [
    { adw_id: 'b683-missing-model', narration: { attempted: true, duration_ms: 1, outcome: 'accepted' } },
    { adw_id: 'b683-missing-duration', narration: { attempted: true, model: 'gpt-oss-20b', outcome: 'accepted' } },
    { adw_id: 'b683-missing-outcome', narration: { attempted: true, model: 'gpt-oss-20b', duration_ms: 1 } },
  ]
  writeFileSync(malformedPath, `${malformed.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const malformedLedger = openTestLedger()
  try {
    const result = ingestJournal(malformedPath, malformedLedger)
    assert.equal(result.applied, 0)
    assert.equal(result.failed, 3)
    assert.equal(result.complete, false)
    assert.equal(malformedLedger.dumpTable('narration_measurements').length, 0)
  } finally { malformedLedger.close() }

  const { DatabaseSync } = require('node:sqlite')
  const migrationPath = join(nextDir(), 'migration.db')
  const migrationDb = new DatabaseSync(migrationPath)
  try {
    const narrationStart = MIGRATIONS.findIndex((stmt) => /CREATE TABLE IF NOT EXISTS "narration_measurements"/.test(stmt))
    assert.ok(narrationStart > 0)
    applyMigrations(migrationDb, MIGRATIONS.slice(0, narrationStart))
    assert.deepEqual(migrationDb.prepare('PRAGMA table_info(narration_measurements)').all(), [])
    applyMigrations(migrationDb)
    assert.deepEqual(migrationDb.prepare('PRAGMA table_info(narration_measurements)').all().map((row) => row.name), [
      'adw_id', 'attempted', 'model', 'duration_ms', 'outcome', 'reason', 'created_at',
    ])
  } finally { migrationDb.close() }
})
test('b395 T1 the recorded phase-slot-wait row round-trips journal to ledger to query', { skip: SKIP }, () => {
  const adwId = 'b395-t1'
  const { ledger, result, dbPath } = ingestJournalLine(B395_SLOT_WAIT_GATE_LINE, adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('phase_slot_waits')[0] }, {
      adw_id: adwId, kind: 'gate', queue_depth: null,
      queue_depth_absent: PHASE_SLOT_WAIT_DEPTH_ABSENT, waited_ms: 1, slotted: 1,
      at_ms: 1788380185199, created_at: isoMs(1788380185199),
    })
  } finally { ledger.close() }
  const payload = journalFactsCli(dbPath)
  assert.equal(payload.phase_slot_waits.waits, 1)
  assert.equal(payload.phase_slot_waits.waited_ms, 1)
})
test('b395 T2 all three recorded phase-slot-wait kinds ingest and count by kind', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `${[
    B395_SLOT_WAIT_GATE_LINE,
    B395_SLOT_WAIT_WARM_LINE,
    B395_SLOT_WAIT_COLD_LINE,
  ].join('\n')}\n`)
  try {
    assert.deepEqual(ingestJournal(journalPath, ledger, { adw_id: 'b395-t2' }), {
      applied: 3, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null,
    })
    const payload = ledger.journalFacts({})
    assert.deepEqual(payload.phase_slot_waits.by_kind, {
      gate: 1, 'suite-warm': 1, 'suite-cold': 1,
    })
  } finally { ledger.close() }
})
test('b395 T3 phase-slot-wait kinds equal the producer vocabulary and reject unknown values', { skip: SKIP }, () => {
  assert.deepEqual(PHASE_SLOT_WAIT_KINDS, [...SUITE_SLOT_PHASE_NAMES])
  const ledger = openTestLedger()
  try {
    assert.throws(() => ledger.recordPhaseSlotWait({ kind: 'not-a-phase', waited_ms: 1 }), LedgerUsageError)
  } finally { ledger.close() }
})
test('b395 T4 a measured queue depth stores an integer without an absence reason', { skip: SKIP }, () => {
  // No recorded row carries either value; this is derived from the producer's
  // measured-depth path at crew/drive.mjs:5469, not presented as a capture.
  const ledger = openTestLedger()
  try {
    ledger.recordPhaseSlotWait({
      adw_id: 'b395-t4', kind: 'suite-cold', queue_depth: 3, waited_ms: 240000,
      slotted: false, at_ms: 1788385488371, created_at: '2026-09-02T00:00:00.000Z',
    })
    const row = ledger.dumpTable('phase_slot_waits')[0]
    assert.equal(row.queue_depth, 3)
    assert.equal(row.queue_depth_absent, null)
    assert.equal(row.slotted, 0)
  } finally { ledger.close() }
})
test('b395 T5 the phase-slot-wait JSONL authority replays into a fresh mirror', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.recordPhaseSlotWait({
    adw_id: 'b395-t5', kind: 'gate', queue_depth: null, waited_ms: 1,
    slotted: true, at_ms: 1788380185199, created_at: '2026-09-01T00:00:00.000Z',
  })
  const target = openTestLedger()
  try {
    assert.deepEqual(replayJsonl(source._jsonlPath, target), {
      applied: 1, skipped: 0, failed: 0, complete: true, first_failure: null,
    })
    assert.deepEqual(target.dumpTable('phase_slot_waits'), source.dumpTable('phase_slot_waits'))
  } finally {
    source.close()
    target.close()
  }
})
test('b395 T6 the recorded pre-change corpus is additive and leaves phase-slot-waits unmeasured', { skip: SKIP }, () => {
  const jsonlPath = join(nextDir(), 'old-corpus.jsonl')
  writeFileSync(jsonlPath, `${B395_OLD_CORPUS_LINES.join('\n')}\n`)
  const ledger = openTestLedger()
  try {
    assert.deepEqual(replayJsonl(jsonlPath, ledger), {
      applied: 2, skipped: 0, failed: 0, complete: true, first_failure: null,
    })
    assert.deepEqual(ledger.dumpTable('phase_slot_waits'), [])
    assert.deepEqual(ledger.journalFacts({}).phase_slot_waits, {
      measured: false, waits: null, count: null, waited_ms: null, by_kind: null,
      by_day: null, depth_measured: null, depth_absent: null, absent: PHASE_SLOT_WAIT_ABSENT,
    })
  } finally { ledger.close() }
})
test('b395 T7 phase-slot-wait by_day carries both terms per UTC day', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.recordPhaseSlotWait({
      adw_id: 'b395-t7-a', kind: 'gate', queue_depth: null, waited_ms: 1,
      slotted: true, at_ms: 1788380185199, created_at: '2026-09-01T10:00:00.000Z',
    })
    ledger.recordPhaseSlotWait({
      adw_id: 'b395-t7-b', kind: 'suite-warm', queue_depth: null, waited_ms: 2,
      slotted: true, at_ms: 1788385340219, created_at: '2026-09-02T11:30:00.000Z',
    })
    const family = ledger.journalFacts({}).phase_slot_waits
    assert.deepEqual(family.by_day, {
      '2026-09-01': { waits: 1, waited_ms: 1 },
      '2026-09-02': { waits: 1, waited_ms: 2 },
    })
    assert.equal(family.waited_ms, 3)
    assert.equal(family.waits, 2)
  } finally { ledger.close() }
})
test('b395 T8 the command in Recipe M runs against a two-wait window', { skip: SKIP }, () => {
  const docs = readFileSync(join(ROOT, 'docs', 'ledger-queries.md'), 'utf8')
  const headingAt = docs.indexOf('### Recipe M')
  assert.notEqual(headingAt, -1)
  const recipe = docs.slice(headingAt)
  const fenceAt = recipe.indexOf('```sh')
  assert.notEqual(fenceAt, -1)
  const body = recipe.slice(fenceAt + 5)
  const closeAt = body.indexOf('```')
  assert.notEqual(closeAt, -1)
  const lines = body.slice(0, closeAt).split('\n').map((line) => line.trim()).filter(Boolean)
  const nodeLines = lines.filter((line) => line.startsWith('node '))
  assert.equal(nodeLines.length, 1)
  assert.match(nodeLines[0], /^node scripts\/factory\/ledger\.mjs journal-facts/)
  const bounds = ['2026-09-01T00:00:00.000Z', '2026-09-03T00:00:00.000Z']
  let bound = 0
  const tokens = nodeLines[0].split(/\s+/)
  const args = tokens.slice(2).map((token) => token === '<iso>' ? bounds[bound++] : token)
  const ledger = openTestLedger()
  ledger.recordPhaseSlotWait({
    adw_id: 'b395-t8-a', kind: 'gate', queue_depth: null, waited_ms: 1,
    slotted: true, at_ms: 1788380185199, created_at: '2026-09-01T10:00:00.000Z',
  })
  ledger.recordPhaseSlotWait({
    adw_id: 'b395-t8-b', kind: 'suite-warm', queue_depth: null, waited_ms: 2,
    slotted: true, at_ms: 1788385340219, created_at: '2026-09-02T11:30:00.000Z',
  })
  const dbPath = ledger._dbPath
  ledger.close()
  const result = run(args, { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const family = JSON.parse(result.stdout).phase_slot_waits
  assert.equal(family.waits, 2)
  assert.equal(family.waited_ms, 3)
  assert.deepEqual(family.by_day, {
    '2026-09-01': { waits: 1, waited_ms: 1 },
    '2026-09-02': { waits: 1, waited_ms: 2 },
  })
})
test('b381 F1 the recorded b371 provider_failure row round-trips journal to ledger to query', { skip: SKIP }, () => {
  const adwId = 'b381-f1'
  const { ledger, result, dbPath } = ingestJournalLine(B381_PROVIDER_FAILURE_LINE, adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('provider_failures')[0] }, {
      adw_id: adwId, role: null, dispatch_id: null, kind: 'rate_limit', status: 429,
      outcome: 'budget-refused', at_ms: 1788292622004, created_at: isoMs(1788292622004),
    })
  } finally { ledger.close() }
  const payload = journalFactsCli(dbPath)
  assert.equal(payload.provider_failures.count, 1)
  assert.equal(payload.provider_failures.failures, 1)
  assert.equal(payload.provider_failures.runs_seen, 1)
})
test('b381 F2 the recorded b374 plan_scope row round-trips journal to ledger to query', { skip: SKIP }, () => {
  const adwId = 'b381-f2'
  const { ledger, result, dbPath } = ingestJournalLine(B381_PLAN_SCOPE_LINE, adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('plan_scope_changes')[0] }, {
      adw_id: adwId, round: 1, verdict: 'plan-scope-same', added: 0, dropped: 0,
      dispatched: 8, planned: 8, created_at: isoMs(1788293864633),
    })
  } finally { ledger.close() }
  const payload = journalFactsCli(dbPath)
  assert.equal(payload.plan_scope.count, 1)
  assert.equal(payload.plan_scope.changes, 1)
  assert.equal(payload.plan_scope.rounds_seen, 1)
})
test('b381 F3 the recorded b374 seat-timeout-reask row round-trips journal to ledger to query', { skip: SKIP }, () => {
  const adwId = 'b381-f3'
  const { ledger, result, dbPath } = ingestJournalLine(B381_TIMEOUT_REASK_LINE, adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('seat_reasks')[0] }, {
      adw_id: adwId, event: 'seat-timeout-reask', role: 'builder', dispatch_id: 'd6', cause: 'timeout',
      outcome: 'failed', spent_ms: 2828375, ceiling_s: 2400, from_run_id: 'd6', to_run_id: null,
      at_ms: 1788303101703, created_at: isoMs(1788303101703),
    })
  } finally { ledger.close() }
  const payload = journalFactsCli(dbPath)
  assert.equal(payload.seat_reasks.count, 1)
  assert.equal(payload.seat_reasks.reasks, 1)
  assert.equal(payload.seat_reasks.reasks_seen, 1)
})
test('b381 F4 a seat-abort-reask row round-trips journal to ledger to query', { skip: SKIP }, () => {
  const source = JSON.parse(B381_TIMEOUT_REASK_LINE)
  source.event = SEAT_RETRY_EVENTS[SEAT_RETRY_KINDS[1]]
  source.cause = SEAT_RETRY_KINDS[1]
  const adwId = 'b381-f4'
  const { ledger, result, dbPath } = ingestJournalLine(JSON.stringify(source), adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('seat_reasks')[0] }, {
      adw_id: adwId, event: SEAT_RETRY_EVENTS[SEAT_RETRY_KINDS[1]], role: 'builder', dispatch_id: 'd6',
      cause: SEAT_RETRY_KINDS[1], outcome: 'failed', spent_ms: 2828375, ceiling_s: 2400,
      from_run_id: 'd6', to_run_id: null, at_ms: 1788303101703, created_at: isoMs(1788303101703),
    })
  } finally { ledger.close() }
  const payload = journalFactsCli(dbPath)
  assert.equal(payload.seat_reasks.count, 1)
  assert.equal(payload.seat_reasks.reasks_seen, 1)
})
test('b381 F5 the recorded b374 rpc_exit_context row round-trips journal to ledger to query', { skip: SKIP }, () => {
  const adwId = 'b381-f5'
  const { ledger, result, dbPath } = ingestJournalLine(B381_RPC_EXIT_LINE, adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('rpc_exit_contexts')[0] }, {
      adw_id: adwId, role: 'builder', dispatch_id: 'd6', outcome: 'timeout', exit_code: 143,
      exit_signal: 'SIGTERM', attribution: 'driver-retired', driver_signalled: 1,
      group_before_signal: 'alive', turn_index: 5, frames: 189, last_frame: 'response', last_tool: 'bash',
      exit_gap_ms: 0, stderr_bytes: 119, at_ms: 1788303101702, created_at: isoMs(1788303101702),
    })
  } finally { ledger.close() }
  const payload = journalFactsCli(dbPath)
  assert.equal(payload.rpc_exits.count, 1)
  assert.equal(payload.rpc_exits.exits, 1)
  assert.equal(payload.rpc_exits.exits_seen, 1)
})
test('b381 F6 the recorded b368 plan-adopted row round-trips journal to ledger to query', { skip: SKIP }, () => {
  const adwId = 'b381-f6'
  const { ledger, result, dbPath } = ingestJournalLine(B381_PLAN_ADOPTION_LINE, adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('plan_adoptions')[0] }, {
      task_slug: 'b368-scopesubset', lane: 'b368-scopesubset',
      archive: '/Users/momoshell/.crew/dt-b365-scopesubset/b365-scopesubset',
      source: '/Users/momoshell/.crew/dt-b365-scopesubset/b365-scopesubset/task',
      plan_sha: 'db151a63f9133b26e351a99a1a2b20bcd9a2d724fd540aab8129737f645578bb',
      files: 3, findings: 1, adopt_from: 'cli', at_ms: Date.parse('2026-09-01T17:34:33.665Z'),
      created_at: '2026-09-01T17:34:33.665Z',
    })
  } finally { ledger.close() }
  const payload = journalFactsCli(dbPath)
  assert.equal(payload.plan_adoptions.count, 1)
  assert.equal(payload.plan_adoptions.adoptions, 1)
  assert.equal(payload.plan_adoptions.adoptions_seen, 1)
})
test('b381 F7 the recorded b374 external fence register round-trips to ledger to query', { skip: SKIP }, () => {
  const ledger = openTestLedger({ now: () => Date.parse('2026-09-02T00:00:00.000Z') })
  const registerPath = join(nextDir(), 'dispatch.external.fences.json')
  writeFileSync(registerPath, B381_EXTERNAL_REGISTER)
  const batchId = 'batch-2026-09-01-r8'
  try {
    const result = ingestExternalFenceRegister(registerPath, ledger, { batch_id: batchId })
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...ledger.dumpTable('external_fences')[0] }, {
      batch_id: batchId, lane: 'b374-loopgates', files: 8, reads: 36,
      register_path: registerPath, created_at: '2026-09-02T00:00:00.000Z',
    })
  } finally {
    const dbPath = ledger._dbPath
    ledger.close()
    const payload = journalFactsCli(dbPath)
    assert.equal(payload.external_fences.count, 1)
    assert.equal(payload.external_fences.fences, 1)
    assert.equal(payload.external_fences.lanes_seen, 1)
  }
})
test('b385 F1 a mutation_anchor_absent journal row round-trips to the ledger through the public handle', { skip: SKIP }, () => {
  const at = '2026-09-03T00:00:00.000Z'
  const adwId = 'b385-f1'
  const absenceLine = JSON.stringify({ at, mutation_anchor_absent: {
    generation: 1, check: 'B2', file: 'crew/drive.mjs', correction: 'accepted', refusal: null, why: 'corrected and killed',
  } })
  const absence = ingestJournalLine(absenceLine, adwId)
  try {
    assert.deepEqual(absence.result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...absence.ledger.dumpTable('mutation_anchor_absences')[0] }, {
      adw_id: adwId, gate_generation: 1, check_name: 'B2', file: 'crew/drive.mjs', correction: 'accepted',
      refusal: null, why: 'corrected and killed', at_ms: Date.parse(at), created_at: at,
    })
  } finally { absence.ledger.close() }

  const bindLine = JSON.stringify({ at, mutation_anchor_bind: {
    generation: 1, declared: 2, exact: 1, normalized: 0, absent: 1, corrected: 1,
    checks: [{ check: 'B2', file: 'crew/drive.mjs', status: 'absent' }],
  } })
  const bind = ingestJournalLine(bindLine, adwId)
  try {
    assert.deepEqual(bind.result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.deepEqual({ ...bind.ledger.dumpTable('mutation_anchor_binds')[0] }, {
      adw_id: adwId, gate_generation: 1, declared: 2, exact: 1, normalized: 0, absent: 1, corrected: 1,
      at_ms: Date.parse(at), created_at: at,
    })
    assert.throws(() => bind.ledger.recordMutationAnchorAbsence({ adw_id: adwId, gate_generation: 2, check_name: 'bad', correction: 'unknown' }), LedgerUsageError)
    assert.throws(() => bind.ledger.recordMutationAnchorAbsence({ adw_id: adwId, gate_generation: 3, check_name: 'bad', correction: 'none', refusal: 'unknown' }), LedgerUsageError)
  } finally { bind.ledger.close() }
  assert.deepEqual(MUTATION_ANCHOR_CORRECTIONS, MUTATION_CORRECTION_OUTCOMES)
  assert.deepEqual(MUTATION_ANCHOR_REFUSALS, MUTATION_CORRECTION_REFUSALS)
})
test('b385 F2 the mutation_anchors family publishes declarations_seen beside its count', { skip: SKIP }, () => {
  const dbPath = measuredJournalFactsDb()
  const measured = journalFactsCli(dbPath)
  assertMeasuredAndAbsent(dbPath, 'mutation_anchors', 'declarations_seen', 'binds')
  assert.ok(Object.hasOwn(measured.mutation_anchors, 'by_correction'))
  assert.ok(Object.hasOwn(measured.mutation_anchors, 'by_refusal'))
  const why = anchorAbsentWhy([{ check: 'B2', file: 'crew/drive.mjs', status: 'absent', correction: 'none', why: 'nowhere' }])
  assert.deepEqual(escalationCause({ where: 'anchor-absent', why }), { cause: 'plan-build-disagreement', actor: 'driver' })
})
test('b385 F3 an empty mutation_anchors window returns null with a reason and never zero', { skip: SKIP }, () => {
  const dbPath = measuredJournalFactsDb()
  const absent = journalFactsCli(dbPath, ['--since', '2030-01-01T00:00:00Z', '--until', '2031-01-01T00:00:00Z'])
  assert.equal(absent.mutation_anchors.measured, false)
  assert.equal(absent.mutation_anchors.binds, null)
  assert.equal(absent.mutation_anchors.declarations_seen, null)
  assert.equal(absent.mutation_anchors.absences, null)
  assert.notEqual(absent.mutation_anchors.declarations_seen, 0)
  assert.equal(absent.mutation_anchors.absent, 'no rows in this window — not measured, never a measured zero')
})
test('b381 A1 an accept-reask emit reaches the ledger through the adapter', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const emitter = { adwId: 'b381-a1', emit: (fn) => fn(ledger) }
  try {
    const receipt = emitAdapter(emitter)({ kind: 'accept-reask', where: 'accept', reask: 1, errors: ['missing finding'] })
    assert.equal(receipt.at_ms, null)
    assert.equal(receipt.reask, 1)
    assert.equal(receipt.errors, 1)
    assert.deepEqual({ ...ledger.dumpTable('accept_reasks')[0] }, {
      adw_id: 'b381-a1', where_at: 'accept', reask: 1, errors: 1, at_ms: null,
      created_at: receipt.created_at,
    })
  } finally { ledger.close() }
})
test('b381 D1 the provider_failures family publishes runs_seen beside its count', { skip: SKIP }, () => {
  assertMeasuredAndAbsent(measuredJournalFactsDb(), 'provider_failures', 'runs_seen', 'failures')
})
test('b381 D2 the plan_scope family publishes rounds_seen beside its count', { skip: SKIP }, () => {
  assertMeasuredAndAbsent(measuredJournalFactsDb(), 'plan_scope', 'rounds_seen', 'changes')
})
test('b381 D3 the seat_reasks family publishes reasks_seen beside its count', { skip: SKIP }, () => {
  assertMeasuredAndAbsent(measuredJournalFactsDb(), 'seat_reasks', 'reasks_seen', 'reasks')
})
test('b381 D4 the accept_reasks family publishes accepts_seen beside its count', { skip: SKIP }, () => {
  assertMeasuredAndAbsent(measuredJournalFactsDb(), 'accept_reasks', 'accepts_seen', 'reasks')
})
test('b381 D5 the rpc_exits family publishes exits_seen beside its count', { skip: SKIP }, () => {
  assertMeasuredAndAbsent(measuredJournalFactsDb(), 'rpc_exits', 'exits_seen', 'exits')
})
test('b381 D6 the plan_adoptions family publishes adoptions_seen beside its count', { skip: SKIP }, () => {
  assertMeasuredAndAbsent(measuredJournalFactsDb(), 'plan_adoptions', 'adoptions_seen', 'adoptions')
})
test('b381 D7 the external_fences family publishes lanes_seen beside its count', { skip: SKIP }, () => {
  assertMeasuredAndAbsent(measuredJournalFactsDb(), 'external_fences', 'lanes_seen', 'fences')
})
test('b381 E1 a journal carrying none of these rows leaves the ledger byte-identical', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const adwId = 'b381-e1'
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'none' })
  const beforeBytes = readFileSync(ledger._jsonlPath)
  const beforeRows = Object.fromEntries(Object.keys(TABLES).map((table) => [table, ledger.dumpTable(table)]))
  const journalPath = join(nextDir(), 'journal.jsonl')
  const none = [
    { at: '2026-01-01T00:00:00.000Z', event: 'boot', task: 'b381-e1' },
    { at: '2026-01-01T00:00:01.000Z', event: 'ordinary-log', message: 'not one of the seven facts' },
    { at: '2026-01-01T00:00:02.000Z', event: 'heartbeat', role: 'builder' },
  ]
  writeFileSync(journalPath, `${none.map((row) => JSON.stringify(row)).join('\n')}\n`)
  try {
    const result = ingestJournal(journalPath, ledger, { adw_id: adwId })
    assert.deepEqual(result, { applied: 0, skipped: 0, ignored: none.length, failed: 0, complete: true, first_failure: null })
    assert.deepEqual(readFileSync(ledger._jsonlPath), beforeBytes)
    for (const table of Object.keys(TABLES)) assert.deepEqual(ledger.dumpTable(table), beforeRows[table], table)
  } finally { ledger.close() }
})
test('A2 reap ingests provider failures', { skip: SKIP }, () => {
  const adwId = 'a2-reap-provider'
  const ledger = openTestLedger()
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `${JSON.stringify({
    at: '2030-01-01T00:00:00.000Z', role: 'builder', id: 'd-provider',
    headless_outcome: 'budget-refused', provider_failure: { kind: 'rate_limit', status: 429 },
  })}\n`)
  try {
    assert.deepEqual(ingestJournal(journalPath, ledger, { adw_id: adwId }), {
      applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null,
    })
    assert.deepEqual(ledger.dumpTable('provider_failures').map(({ adw_id, role, dispatch_id, kind, status, outcome }) => ({
      adw_id, role, dispatch_id, kind, status, outcome,
    })), [{
      adw_id: adwId, role: 'builder', dispatch_id: 'd-provider', kind: 'rate_limit', status: 429,
      outcome: 'budget-refused',
    }])
  } finally { ledger.close() }
})
test('A3 reap ingests boot seats exactly once', { skip: SKIP }, () => {
  const adwId = 'a3-reap-seats'
  const at = '2030-01-01T00:00:00.000Z'
  const seat = (agent, provider, id, model, effort) => ({ agent, provider, id, model, effort })
  const boot = {
    at, event: 'boot', roles: ['planner', 'builder', 'reviewer'],
    seats: {
      planner: seat('claude', 'anthropic', 'claude-sonnet', 'claude-sonnet', 'high'),
      builder: seat('pi', 'openai', 'gpt-5', 'openai-codex/gpt-5', 'max'),
      reviewer: seat('claude', 'anthropic', 'claude-opus', 'claude-opus', 'high'),
    },
    transports: { planner: 'pane', builder: 'headless-rpc', reviewer: 'headless-json' },
    allocation: {
      planner: { agent: 'roster', model: 'roster', effort: 'roster', transport: 'pane' },
      builder: { agent: 'override', model: 'roster', effort: 'roster', transport: 'headless-rpc' },
      reviewer: { agent: 'roster', model: 'roster', effort: 'roster', transport: 'headless-json' },
    },
    vendor_withheld: { planner: [], builder: ['subagents'], reviewer: [] },
  }
  const ledger = openTestLedger()
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `${JSON.stringify(boot)}\n`)
  try {
    const first = ingestJournal(journalPath, ledger, { adw_id: adwId })
    const rowsAfterFirst = ledger.dumpTable('run_seats')
    const second = ingestJournal(journalPath, ledger, { adw_id: adwId })
    const rowsAfterSecond = ledger.dumpTable('run_seats')
    assert.equal(first.applied, 3)
    assert.equal(first.complete, true)
    assert.equal(second.complete, true)
    assert.equal(rowsAfterFirst.length, 3)
    assert.equal(rowsAfterSecond.length, rowsAfterFirst.length)
    const byRole = Object.fromEntries(rowsAfterSecond.map((row) => [row.role, row]))
    assert.equal(byRole.planner.source, 'roster')
    assert.equal(byRole.builder.source, 'operator_override')
    assert.equal(byRole.builder.policy_state, 'warned')
    assert.deepEqual(JSON.parse(byRole.builder.warnings_json), ['subagents'])
    assert.equal(byRole.reviewer.policy_state, 'passed')
    assert.equal(byRole.builder.model_id, 'gpt-5')
    assert.equal(byRole.builder.transport, 'headless-rpc')
  } finally { ledger.close() }
})
test('A4 turn economy excludes a concurrent sibling lane', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const since = '2030-01-01T00:00:00.000Z'
  const until = '2030-01-02T00:00:00.000Z'
  const at = Date.parse(since)
  ledger.recordSeatTurnCensus({ adw_id: 'a4-lane', role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: 10, at_ms: at, created_at: since })
  ledger.recordSeatTurnCensus({ adw_id: 'a4-lane', role: 'reviewer', dispatch_id: 'd2', transport: 'headless-json', turns: null, absent_reason: 'no observable turns', at_ms: at + 1000, created_at: '2030-01-01T00:00:01.000Z' })
  ledger.recordSeatTurnCensus({ adw_id: 'a4-sibling', role: 'builder', dispatch_id: 'sibling', transport: 'headless-rpc', turns: 99, at_ms: at + 2000, created_at: '2030-01-01T00:00:02.000Z' })
  try {
    const facts = ledger.turnEconomy({ since, until, adw_id: 'a4-lane' })
    assert.equal(facts.dispatches, 2)
    assert.equal(facts.dispatches_measured, 1)
    assert.equal(facts.turns, 10)
    assert.equal(facts.turns_per_dispatch, 10)
    assert.equal(facts.excluded.rows, 1)
    assert.deepEqual(facts.by_role_tier.map(({ role, dispatches, dispatches_measured, turns }) => ({ role, dispatches, dispatches_measured, turns })), [
      { role: 'builder', dispatches: 1, dispatches_measured: 1, turns: 10 },
      { role: 'reviewer', dispatches: 1, dispatches_measured: 0, turns: null },
    ])
  } finally { ledger.close() }
})
test('A6 malformed journal line reports an unmeasured reason', { skip: SKIP }, () => {
  const adwId = 'a6-malformed'
  const valid = { at: '2030-01-01T00:00:01.000Z', seat_turn_census: {
    role: 'builder', dispatch_id: 'd-later', transport: 'headless-rpc', turns: 3,
  } }
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `{not valid json\n${JSON.stringify(valid)}\n`)
  const ledger = openTestLedger()
  try {
    const result = ingestJournal(journalPath, ledger, { adw_id: adwId })
    assert.deepEqual(result, {
      applied: 1, skipped: 1, ignored: 0, failed: 0, complete: false,
      first_failure: { line: 1, reason: 'journal line is not valid JSON' },
    })
    assert.equal(ledger.dumpTable('seat_turn_census').length, 1)
    assert.equal(ledger.dumpTable('seat_turn_census')[0].turns, 3)
    const facts = ledger.turnEconomy({ since: '2030-01-01T00:00:00.000Z', until: '2030-01-02T00:00:00.000Z', adw_id: adwId })
    assert.equal(facts.dispatches, 1)
    assert.equal(facts.turns, 3)
  } finally { ledger.close() }
})
test('b401 a journalled seat_turn_census row ingests to a seat_turn_census ledger row', { skip: SKIP }, () => {
  const adwId = 'b401-census'
  const line = JSON.stringify({
    at: '2030-01-01T00:00:00.000Z',
    seat_turn_census: {
      role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc',
      turns: 10, tool_calls: null, distinct_files_read: 3, suite_runs: 1, re_reads: 2,
      by_class: { edit: 1, read: 2, test: 3, other: 4 },
      in_tool_ms: { edit: 10, read: 20, test: 30, other: 40 },
      out_of_tool_ms: 100, span_ms: 200, tool_spans_matched: 4,
      tool_spans_unmatched: 1, tool_spans_same_poll: 0, absent_reason: 'tool_calls unmeasured',
    },
  })
  const { ledger, result } = ingestJournalLine(line, adwId)
  try {
    assert.deepEqual(result, { applied: 1, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    const row = ledger.dumpTable('seat_turn_census')[0]
    assert.equal(row.turns, 10)
    assert.equal(row.tool_calls, null)
    assert.equal(row.edit_calls, 1)
    assert.equal(row.read_calls, 2)
    assert.equal(row.in_tool_test_ms, 30)
    assert.equal(row.absent_reason, 'tool_calls unmeasured')
  } finally { ledger.close() }
})
test('RV1-1 turns breakdown carries a boot before run-start into the run segment', () => {
  const root = scratchDir('turns-corpus-rv1-1-')
  writeTurnsCorpusJournal(root, 'lane', [{ turns: 4, status: 'insufficient' }])
  const payload = turnsCorpusPayload(root)
  const cell = builderTurnRole(payload).by_transport.find((entry) => entry.transport === 'headless-json')
  assert.ok(cell)
  assert.equal(payload.corpus.dispatches, 1)
  assert.equal(payload.corpus.measured_rows, 1)
  assert.equal(payload.corpus.excluded_rows, 0)
  assert.deepEqual({ numerator: cell.insufficient_with_turns.numerator, denominator: cell.insufficient_with_turns.denominator }, { numerator: 1, denominator: 1 })
})
test('B1 zero turns and insufficient overlap remain separate', () => {
  const root = scratchDir('turns-corpus-b1-')
  writeTurnsCorpusJournal(root, 'lane', [
    { turns: 4, status: 'insufficient' },
    { turns: 0, status: 'done' },
    { turns: 0, status: 'insufficient' },
  ])
  const cell = builderTurnRole(turnsCorpusPayload(root)).by_transport.find((entry) => entry.transport === 'headless-json')
  assert.deepEqual({ numerator: cell.insufficient_with_turns.numerator, denominator: cell.insufficient_with_turns.denominator }, { numerator: 1, denominator: 1 })
  assert.deepEqual({ numerator: cell.zero_turn.numerator, denominator: cell.zero_turn.denominator }, { numerator: 2, denominator: 3 })
  assert.deepEqual({ numerator: cell.overlap.numerator, denominator: cell.overlap.denominator }, { numerator: 1, denominator: 3 })
})
test('E1 unreadable turns journal is skipped with closed reason', () => {
  const root = scratchDir('turns-corpus-e1-')
  writeTurnsCorpusJournal(root, 'readable', [{ turns: 1, status: 'done' }])
  const unreadable = join(root, 'unreadable', 'journal.jsonl')
  mkdirSync(unreadable, { recursive: true })
  const payload = turnsCorpusPayload(root)
  assert.equal(payload.skipped_journals.filter((entry) => entry.journal === unreadable).length, 1)
  assert.ok(['EISDIR', 'EPERM', 'EACCES'].includes(payload.skipped_journals.find((entry) => entry.journal === unreadable).reason))
  const cell = builderTurnRole(payload).by_transport.find((entry) => entry.transport === 'headless-json')
  assert.equal(cell.zero_turn.numerator, 0)
  assert.equal(cell.zero_turn.denominator, 1)
})
test('b401 the turns query publishes its denominator and answers null over an empty window', { skip: SKIP }, () => {
  const emptyDb = join(nextDir(), 'empty.db')
  const crewRoot = scratchDir('turns-cli-corpus-empty-')
  const empty = run(['turns', '--crew-root', crewRoot, '--since', '2001-01-01T00:00:00.000Z', '--until', '2001-01-02T00:00:00.000Z'], { DEVTEAM_LEDGER_DB: emptyDb })
  assert.equal(empty.status, 0, empty.stderr)
  const emptyPayload = JSON.parse(empty.stdout)
  assert.equal(emptyPayload.dispatches, null)
  assert.equal(emptyPayload.turns_per_dispatch, null)
  assert.equal(typeof emptyPayload.absent, 'string')
  assert.ok(Array.isArray(emptyPayload.by_role_tier))
  assert.equal(emptyPayload.excluded.rows, null)
  assert.equal(typeof emptyPayload.excluded.reason, 'string')
  assert.ok(emptyPayload.excluded.reason.length > 0)
  assert.equal(emptyPayload.rate_floor, CELL_RATE_FLOOR)
  assert.ok(emptyPayload.definition.limitations.includes('lanes reaped before the current crew-root state are absent'))
  assert.ok(emptyPayload.definition.limitations.includes('Pi turns are observed through the RPC stream rather than a provider transcript'))

  const filledDb = join(nextDir(), 'filled.db')
  const ledger = openLedger({ dbPath: filledDb, jsonlPath: join(nextDir(), 'filled.jsonl') })
  ledger.recordSeatTurnCensus({ adw_id: 'b401-filled', role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: 10, at_ms: Date.parse('2030-01-01T00:00:00.000Z'), created_at: '2030-01-01T00:00:00.000Z' })
  ledger.recordSeatTurnCensus({ adw_id: 'b401-filled', role: 'builder', dispatch_id: 'd2', transport: 'headless-rpc', turns: 20, at_ms: Date.parse('2030-01-01T00:00:01.000Z'), created_at: '2030-01-01T00:00:01.000Z' })
  ledger.close()
  const filled = run(['turns', '--crew-root', crewRoot, '--since', '2029-12-31T00:00:00.000Z', '--until', '2030-01-02T00:00:00.000Z'], { DEVTEAM_LEDGER_DB: filledDb })
  assert.equal(filled.status, 0, filled.stderr)
  const filledPayload = JSON.parse(filled.stdout)
  assert.equal(filledPayload.dispatches, 2)
  assert.equal(filledPayload.turns_per_dispatch, 15)

  const typo = run(['turns', '--crew-root', crewRoot, '--untill', '2030-01-01T00:00:00.000Z'], { DEVTEAM_LEDGER_DB: emptyDb })
  assert.equal(typo.status, 2)
  assert.match(typo.stderr, new RegExp(`turns: unknown flag --${'untill'}`))
})
test('HoldC1', { skip: SKIP }, () => {
  const source = holdoutLedger('c1-source')
  try {
    source.ledger.recordExperimentArm({
      adw_id: 'c1-replay', role: 'planner', experiment: 'planner-symbols', arm: 'control', fraction: 0.5,
      at_ms: Date.parse('2030-02-01T00:00:00.000Z'), created_at: '2030-02-01T00:00:00.000Z',
    })
    source.ledger.recordExperimentArm({
      adw_id: 'c1-replay', role: 'planner', experiment: 'planner-symbols', arm: 'control', fraction: 0.5,
      at_ms: Date.parse('2030-02-01T00:00:00.000Z'), created_at: '2030-02-01T00:00:00.000Z',
    })
    assert.equal(source.ledger.dumpTable('experiment_arms').length, 1)
  } finally { source.ledger.close() }
  const replay = holdoutLedger('c1-replay')
  try {
    const replayed = replayJsonl(source.jsonlPath, replay.ledger)
    assert.equal(replayed.complete, true)
    assert.equal(replay.ledger.dumpTable('experiment_arms').length, 1)

    const journalPath = join(replay.dir, 'crew-journal.jsonl')
    writeFileSync(journalPath, [
      {
        at: '2030-02-01T00:01:00.000Z', event: 'experiment-arm', role: 'planner',
        experiment: 'planner-symbols', arm: 'symbols-omitted', fraction: 0.25,
      },
      {
        adw_id: 'c1-nested', at: '2030-02-01T00:02:00.000Z',
        experiment_arm: { role: 'planner', experiment: 'planner-symbols', arm: 'control', fraction: 0.25 },
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const ingested = ingestJournal(journalPath, replay.ledger, { adw_id: 'c1-ingested' })
    assert.equal(ingested.applied, 2)
    assert.equal(replay.ledger.dumpTable('experiment_arms').find((row) => row.adw_id === 'c1-ingested').role, 'planner')
    assert.equal(replay.ledger.dumpTable('experiment_arms').find((row) => row.adw_id === 'c1-nested').arm, 'control')

    assert.deepEqual(TABLES.experiment_arms.columns.map(({ name, decl }) => [name, decl]), [
      ['adw_id', 'TEXT'], ['role', 'TEXT'], ['experiment', 'TEXT'], ['arm', 'TEXT'],
      ['fraction', 'REAL'], ['at_ms', 'INTEGER'], ['created_at', 'TEXT'],
    ])
    assert.deepEqual(TABLES.experiment_arms.unique, [['adw_id', 'role', 'experiment']])
    assert.equal(WRITERS.includes('recordExperimentArm'), true)
    assert.equal(WRITER_MIRROR_TABLES.recordExperimentArm, 'experiment_arms')
    assert.equal(JOURNAL_FACT_EVENTS['experiment-arm'], 'recordExperimentArm')
    assert.equal(JOURNAL_FACT_KEYS.experiment_arm, 'recordExperimentArm')

    const fixture = holdoutLedger('c1-join')
    try {
      for (let index = 0; index < PLANNER_SYMBOLS_SAMPLE_FLOOR; index += 1) {
        addHoldoutLane(fixture.ledger, index, {
          turns: 2, distinct_files_read: 3, re_reads: 4,
          roleCensus: { role: 'builder', turns: 200, distinct_files_read: 200, re_reads: 200 },
        })
      }
      const report = fixture.ledger.plannerSymbolsHoldout()
      const rows = holdoutRows(report)
      assert.equal(rows.find((row) => row.arm === 'control' && row.metric === 'turns').mean, 2)
      assert.equal(rows.find((row) => row.arm === 'control' && row.metric === 'distinct_files_read').mean, 3)
      assert.equal(rows.find((row) => row.arm === 'control' && row.metric === 're_reads').mean, 4)
    } finally { fixture.ledger.close() }
  } finally { replay.ledger.close() }
})
test('HoldD1', { skip: SKIP }, () => {
  const fixture = holdoutLedger('d1')
  try {
    addHoldoutLane(fixture.ledger, 0, { arm: 'control' })
    addHoldoutLane(fixture.ledger, 1, { arm: 'symbols-omitted' })
    const rows = holdoutRows(fixture.ledger.plannerSymbolsHoldout())
    assert.equal(rows.length, 8)
    assert.equal(rows.some((row) => row.arm === 'pooled' || row.arm === 'all'), false)
    assert.deepEqual(rows.map(({ arm, metric }) => `${arm}:${metric}`), [
      'control:turns', 'control:distinct_files_read', 'control:re_reads', 'control:first_round_plan_acceptance',
      'symbols-omitted:turns', 'symbols-omitted:distinct_files_read', 'symbols-omitted:re_reads', 'symbols-omitted:first_round_plan_acceptance',
    ])
  } finally { fixture.ledger.close() }
})
test('HoldD2', { skip: SKIP }, () => {
  const fixture = holdoutLedger('d2')
  try {
    addHoldoutLane(fixture.ledger, 0, { arm: 'control' })
    addHoldoutLane(fixture.ledger, 1, { arm: 'symbols-omitted' })
    const rows = holdoutRows(fixture.ledger.plannerSymbolsHoldout())
    for (const row of rows) assert.equal(Number.isInteger(row.n), true)
    assert.equal(rows.every((row) => !Object.hasOwn(row, 'arm') || PLANNER_SYMBOLS_ARMS.includes(row.arm)), true)
  } finally { fixture.ledger.close() }
})
test('HoldE1', { skip: SKIP }, () => {
  const fixture = holdoutLedger('e1')
  try {
    for (let index = 0; index < 19; index += 1) addHoldoutLane(fixture.ledger, index, { arm: 'control', turns: index })
    const rows = holdoutRows(fixture.ledger.plannerSymbolsHoldout())
    const turns = rows.find((row) => row.arm === 'control' && row.metric === 'turns')
    assert.equal(turns.n, 19)
    assert.equal(turns.status, 'unmeasured')
    assert.equal(turns.floor, 20)
    assert.equal(Object.hasOwn(turns, 'mean'), false)
    assert.equal(Object.hasOwn(turns, 'interval'), false)
  } finally { fixture.ledger.close() }
})
test('HoldE2', { skip: SKIP }, () => {
  const fixture = holdoutLedger('e2')
  try {
    for (let index = 0; index < 20; index += 1) addHoldoutLane(fixture.ledger, index, { arm: 'symbols-omitted', turns: 2 })
    const rows = holdoutRows(fixture.ledger.plannerSymbolsHoldout())
    const turns = rows.find((row) => row.arm === 'symbols-omitted' && row.metric === 'turns')
    assert.equal(turns.n, 20)
    assert.equal(turns.status, 'measured')
    assert.equal(turns.mean, 2)
    assert.deepEqual(turns.interval, { low: 2, high: 2, confidence: 0.95 })
    assert.equal(Object.hasOwn(turns, 'floor'), false)
  } finally { fixture.ledger.close() }
})
test('HoldF1', { skip: SKIP }, () => {
  assert.deepEqual(bootstrapPercentile([0, 0, 0, 0, 10]), { low: 0, high: 6 })
  const fixture = holdoutLedger('f1')
  try {
    for (let index = 0; index < PLANNER_SYMBOLS_SAMPLE_FLOOR; index += 1) {
      addHoldoutLane(fixture.ledger, index, { arm: 'control', turns: index === PLANNER_SYMBOLS_SAMPLE_FLOOR - 1 ? 10 : 0 })
    }
    const turns = holdoutRows(fixture.ledger.plannerSymbolsHoldout()).find((row) => row.arm === 'control' && row.metric === 'turns')
    assert.deepEqual(turns.interval, { low: 0, high: 1.5, confidence: 0.95 })
  } finally { fixture.ledger.close() }
})
test('HoldF2', { skip: SKIP }, () => {
  const fixture = holdoutLedger('f2')
  try {
    for (let index = 0; index < PLANNER_SYMBOLS_SAMPLE_FLOOR; index += 1) addHoldoutLane(fixture.ledger, index, { arm: 'control', turns: 1 })
    const report = fixture.ledger.plannerSymbolsHoldout()
    assert.deepEqual(report.bootstrap, {
      method: 'percentile-bootstrap', confidence: 0.95, resamples: 10_000, seed: 1059,
    })
    const turns = holdoutRows(report).find((row) => row.arm === 'control' && row.metric === 'turns')
    assert.deepEqual(turns.interval, { low: 1, high: 1, confidence: 0.95 })
  } finally { fixture.ledger.close() }
})
test('HoldG1', { skip: SKIP }, () => {
  const fixture = holdoutLedger('g1')
  try {
    for (let index = 0; index < 20; index += 1) {
      addHoldoutLane(fixture.ledger, index, {
        arm: 'control', turns: 1, review: index === 0 ? null : 'pass', terminal_reason: index === 0 ? 'boot-failed' : undefined,
      })
    }
    for (let index = 0; index < 20; index += 1) {
      addHoldoutLane(fixture.ledger, 100 + index, { arm: 'symbols-omitted', turns: 1, review: 'pass' })
    }
    const report = fixture.ledger.plannerSymbolsHoldout()
    const rows = holdoutRows(report)
    const controlAcceptance = rows.find((row) => row.arm === 'control' && row.metric === 'first_round_plan_acceptance')
    const treatmentAcceptance = rows.find((row) => row.arm === 'symbols-omitted' && row.metric === 'first_round_plan_acceptance')
    assert.equal(controlAcceptance.n, 19)
    assert.equal(controlAcceptance.status, 'unmeasured')
    assert.equal(treatmentAcceptance.n, 20)
    assert.equal(treatmentAcceptance.proportion, 1)
    assert.deepEqual(report.excluded_from_first_round, [{ arm: 'control', reason: 'boot-failed', count: 1 }])
  } finally { fixture.ledger.close() }
})
test('HoldG2', { skip: SKIP }, () => {
  const fixture = holdoutLedger('g2')
  try {
    addHoldoutLane(fixture.ledger, 0, { arm: 'control', review: null, terminal_reason: 'seat-refused' })
    addHoldoutLane(fixture.ledger, 1, { arm: 'control', review: null })
    addHoldoutLane(fixture.ledger, 2, { arm: 'symbols-omitted', review: null, terminal_reason: 'review-unresolved' })
    const excluded = fixture.ledger.plannerSymbolsHoldout().excluded_from_first_round
    assert.deepEqual(excluded, [
      { arm: 'control', reason: 'seat-refused', count: 1 },
      { arm: 'control', reason: 'no-review-outcome-recorded', count: 1 },
      { arm: 'symbols-omitted', reason: 'review-unresolved', count: 1 },
    ])
    assert.equal(excluded.every((row) => typeof row.reason === 'string' && row.reason.length > 0), true)
  } finally { fixture.ledger.close() }
})
test('b401 the turns query excludes an unmeasured turn count from both terms', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const at = Date.parse('2030-01-01T00:00:00.000Z')
  ledger.recordSeatTurnCensus({ adw_id: 'b401-rate', role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: 10, tool_calls: 12, at_ms: at, created_at: '2030-01-01T00:00:00.000Z' })
  ledger.recordSeatTurnCensus({ adw_id: 'b401-rate', role: 'builder', dispatch_id: 'd2', transport: 'pane', turns: null, tool_calls: null, absent_reason: 'pane', at_ms: at + 1000, created_at: '2030-01-01T00:00:01.000Z' })
  try {
    const facts = ledger.turnEconomy({ since: '2029-12-31T00:00:00.000Z', until: '2030-01-02T00:00:00.000Z' })
    assert.equal(facts.dispatches, 2)
    assert.equal(facts.dispatches_measured, 1)
    assert.equal(facts.turns, 10)
    assert.equal(facts.turns_per_dispatch, 10)
    assert.equal(facts.excluded.rows, 1)
    assert.ok(facts.excluded.reason.length > 0)
  } finally { ledger.close() }
})
test('gate timing fields round-trip through JSONL replay and gateResultsFor', { skip: SKIP }, () => {
  const source = openTestLedger()
  const target = openTestLedger()
  try {
    source.recordGateResult({ adw_id: 'gate-timing', phase_id: null, gate_name: 'measured', attempt: 1, ok: true, checks: [], violations: [], gate_generation: 1, pristine: false, gate_run_ms: 7, gate_run_ms_absent_reason: null })
    source.recordGateResult({ adw_id: 'gate-timing', phase_id: null, gate_name: 'unmeasured', attempt: 1, ok: true, checks: [], violations: [], gate_generation: 1, pristine: false, gate_run_ms: null, gate_run_ms_absent_reason: 'clock-unavailable' })
    const applied = replayJsonl(source._jsonlPath, target)
    assert.ok(applied.applied >= 2)
    const rows = target.gateResultsFor(['gate-timing'])
    assert.deepEqual(rows.map((row) => ({ gate_name: row.gate_name, gate_run_ms: row.gate_run_ms, gate_run_ms_absent_reason: row.gate_run_ms_absent_reason })), [
      { gate_name: 'measured', gate_run_ms: 7, gate_run_ms_absent_reason: null },
      { gate_name: 'unmeasured', gate_run_ms: null, gate_run_ms_absent_reason: 'clock-unavailable' },
    ])
  } finally {
    source.close()
    target.close()
  }
})
test('G1 a populated legacy gate_results table migrates with NULL timing fields', { skip: SKIP }, () => {
  const dbPath = join(nextDir(), 'legacy-gate.db')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE gate_results (
    id INTEGER PRIMARY KEY, adw_id TEXT, phase_id INTEGER, gate_name TEXT, attempt INTEGER,
    ok INTEGER, checks_json TEXT, violations_json TEXT, created_at TEXT, gate_generation INTEGER, pristine INTEGER,
    UNIQUE (adw_id, gate_name, attempt)
  )`)
  db.prepare('INSERT INTO gate_results (adw_id, gate_name, attempt, ok, checks_json, violations_json, created_at, gate_generation, pristine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('legacy-gate', 'gate', 1, 1, '[]', '[]', '2030-01-01T00:00:00.000Z', 1, 0)
  db.close()
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const row = ledger.gateResultsFor(['legacy-gate'])[0]
    assert.equal(row.gate_run_ms, null)
    assert.equal(row.gate_run_ms_absent_reason, null)
  } finally { ledger.close() }
})
test('ingest-all replay contract: every journal-fed table survives a second ingest byte-identical', { skip: SKIP }, () => {
  const adwId = 'replay-contract'
  const base = Date.parse('2030-01-01T00:00:00.000Z')
  const at = (offset) => new Date(base + offset).toISOString()
  const seat = (agent, provider, id, model, effort) => ({ agent, provider, id, model, effort })
  const rows = [
    { at: at(0), role: 'builder', id: 'd1', headless_outcome: 'budget-refused', provider_failure: { kind: 'rate_limit', status: 429 } },
    { at: at(1000), provider_failure: { kind: 'authentication_failed', status: 401 } },
    { at: at(2000), plan_scope: { round: 1, verdict: 'plan-scope-same', added: 0, dropped: 0, dispatched: 2, planned: 3 } },
    { at: at(3000), accept_reask: { where_at: 'accept', reask: 1, errors: 0 } },
    { at: at(4000), role: 'builder', rpc_exit_context: { role: 'builder', outcome: 'exited' } },
    { at: at(5000), seat_turn_census: { role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: 3 } },
    { at: at(6000), event: 'experiment-arm', role: 'planner', experiment: 'planner-symbols', arm: 'control', fraction: 0.5 },
    { at: at(7000), mutation_anchor_bind: { generation: 7, declared: 2, exact: 1, normalized: 1, absent: 0, corrected: 0 } },
    { at: at(8000), mutation_anchor_absent: { generation: 7, check: 'I1', file: 'x.mjs' } },
    { at: at(9000), narration: { attempted: true, model: 'm', duration_ms: 5, outcome: 'accepted' } },
    { at: at(10000), screener_proposal: { round: 1, proposal_id: 'p1', axis: 'a', model: 'm', outcome: 'adopted' } },
    { at: at(11000), event: 'seat-timeout-reask', outcome: 'reasked' },
    { at: at(12000), event: 'plan-adopted', lane: 'lane-a', plan_sha: 'sha1' },
    { at: at(13000), event: 'phase-slot-wait', kind: 'gate', waited_ms: 5 },
    {
      at: at(14000), event: 'boot', roles: ['planner', 'builder'],
      seats: {
        planner: seat('claude', 'anthropic', 'claude-sonnet', 'claude-sonnet', 'high'),
        builder: seat('pi', 'openai', 'gpt-5', 'openai-codex/gpt-5', 'max'),
      },
      transports: { planner: 'pane', builder: 'headless-rpc' },
    },
  ]
  const ledger = openTestLedger()
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const dumpAll = () => {
    const out = {}
    for (const table of Object.keys(TABLES)) out[table] = ledger.dumpTable(table).map((row) => ({ ...row }))
    return out
  }
  try {
    const first = ingestJournal(journalPath, ledger, { adw_id: adwId })
    assert.deepEqual(first, { applied: 16, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.equal(ledger.dumpTable('provider_failures').length, 2)
    assert.equal(ledger.dumpTable('plan_scope_changes').length, 1)
    assert.equal(ledger.dumpTable('accept_reasks').length, 1)
    assert.equal(ledger.dumpTable('rpc_exit_contexts').length, 1)
    assert.equal(ledger.dumpTable('seat_turn_census').length, 1)
    assert.equal(ledger.dumpTable('experiment_arms').length, 1)
    assert.equal(ledger.dumpTable('mutation_anchor_binds').length, 1)
    assert.equal(ledger.dumpTable('mutation_anchor_absences').length, 1)
    assert.equal(ledger.dumpTable('narration_measurements').length, 1)
    assert.equal(ledger.dumpTable('screener_proposals').length, 1)
    assert.equal(ledger.dumpTable('seat_reasks').length, 1)
    assert.equal(ledger.dumpTable('plan_adoptions').length, 1)
    assert.equal(ledger.dumpTable('phase_slot_waits').length, 1)
    assert.equal(ledger.dumpTable('run_seats').length, 2)
    // The nullable composite keys round-trip as measured nulls, not blanks.
    const nullable = ledger.dumpTable('provider_failures').find((row) => row.dispatch_id === null)
    assert.equal(nullable.role, null)
    assert.equal(nullable.kind, 'authentication_failed')
    const nullReask = ledger.dumpTable('seat_reasks')[0]
    assert.equal(nullReask.role, null)
    assert.equal(nullReask.dispatch_id, null)
    const before = dumpAll()
    const logBefore = readFileSync(ledger._jsonlPath)
    const second = ingestJournal(journalPath, ledger, { adw_id: adwId })
    assert.deepEqual(second, { applied: 0, skipped: 0, ignored: 16, failed: 0, complete: true, first_failure: null })
    assert.deepEqual(dumpAll(), before)
    assert.deepEqual(readFileSync(ledger._jsonlPath), logBefore)
  } finally { ledger.close() }
})
test('ingest-all replay keeps the first physical row and pins malformed lines', { skip: SKIP }, () => {
  const adwId = 'replay-physical'
  const lines = [
    'this is not json',
    JSON.stringify({ at: '2030-01-01T00:00:00.000Z', event: 'plan-adopted', lane: 'lane-dup', plan_sha: 'sha-dup', source: 'first' }),
    JSON.stringify({ at: '2030-01-01T00:00:05.000Z', event: 'plan-adopted', lane: 'lane-dup', plan_sha: 'sha-dup', source: 'second' }),
    JSON.stringify({ at: '2030-01-01T00:00:10.000Z', role: 'builder', id: 'd-dup', provider_failure: { kind: 'rate_limit', status: 429 } }),
    JSON.stringify({ at: '2030-01-01T00:00:10.000Z', role: 'builder', id: 'd-dup', headless_outcome: 'other', provider_failure: { kind: 'server_error', status: 500 } }),
    JSON.stringify({ at: '2030-01-01T00:00:11.000Z', event: 'ordinary-log', message: 'not a fact' }),
  ]
  const ledger = openTestLedger()
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `${lines.join('\n')}\n`)
  const dumpAll = () => {
    const out = {}
    for (const table of Object.keys(TABLES)) out[table] = ledger.dumpTable(table).map((row) => ({ ...row }))
    return out
  }
  try {
    const first = ingestJournal(journalPath, ledger, { adw_id: adwId })
    assert.deepEqual(first, { applied: 2, skipped: 1, ignored: 3, failed: 0, complete: false, first_failure: { line: 1, reason: 'journal line is not valid JSON' } })
    assert.equal(ledger.dumpTable('plan_adoptions')[0].source, 'first')
    assert.equal(ledger.dumpTable('provider_failures')[0].kind, 'rate_limit')
    const before = dumpAll()
    const logBefore = readFileSync(ledger._jsonlPath)
    const second = ingestJournal(journalPath, ledger, { adw_id: adwId })
    assert.deepEqual(second, { applied: 0, skipped: 1, ignored: 5, failed: 0, complete: false, first_failure: { line: 1, reason: 'journal line is not valid JSON' } })
    assert.deepEqual(dumpAll(), before)
    assert.deepEqual(readFileSync(ledger._jsonlPath), logBefore)
  } finally { ledger.close() }
})
test('ingest-all dry_run counts eligible facts without invoking writers', { skip: SKIP }, () => {
  const adwId = 'replay-dry'
  const rows = [
    { at: '2030-01-01T00:00:00.000Z', role: 'builder', id: 'd1', provider_failure: { kind: 'rate_limit', status: 429 } },
    { at: '2030-01-01T00:00:01.000Z', seat_turn_census: { role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: 3 } },
    { at: '2030-01-01T00:00:02.000Z', event: 'plan-adopted', lane: 'lane-dry', plan_sha: 'sha-dry' },
  ]
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const ledger = openTestLedger()
  const dumpAll = () => {
    const out = {}
    for (const table of Object.keys(TABLES)) out[table] = ledger.dumpTable(table).map((row) => ({ ...row }))
    return out
  }
  try {
    const dry = ingestJournal(journalPath, ledger, { adw_id: adwId, dry_run: true })
    assert.deepEqual(dry, { applied: 3, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    for (const table of Object.keys(TABLES)) assert.deepEqual(ledger.dumpTable(table), [], table)
    assert.equal(existsSync(ledger._jsonlPath), false)
    const withoutLedger = ingestJournal(journalPath, null, { adw_id: adwId, dry_run: true })
    assert.deepEqual(withoutLedger, dry)
    const real = ingestJournal(journalPath, ledger, { adw_id: adwId })
    assert.deepEqual(real, { applied: 3, skipped: 0, ignored: 0, failed: 0, complete: true, first_failure: null })
    assert.ok(Object.values(dumpAll()).some((rows) => rows.length > 0))
    const logBefore = readFileSync(ledger._jsonlPath)
    const before = dumpAll()
    const dryAgain = ingestJournal(journalPath, ledger, { adw_id: adwId, dry_run: true })
    assert.deepEqual(dryAgain, { applied: 0, skipped: 0, ignored: 3, failed: 0, complete: true, first_failure: null })
    assert.deepEqual(dumpAll(), before)
    assert.deepEqual(readFileSync(ledger._jsonlPath), logBefore)
  } finally { ledger.close() }
})
