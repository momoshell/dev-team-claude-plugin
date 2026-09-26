import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync, readdirSync, statSync,
} from 'node:fs'

import { join } from 'node:path'

import { spawnSync, spawn } from 'node:child_process'

import { ROOT, scratchDir } from './helpers.mjs'

import {
  openLedger, replayJsonl, isoMs, TABLES, MIGRATIONS, applyMigrations, DRIVER_GONE_THRESHOLD_MS, DRIVER_STATES, RUN_OBSERVATION_SOURCES, RUN_OBSERVATION_COLUMNS, RUN_OBSERVATION_WRITE_VERB, SESSION_STATUSES, SESSION_OUTCOMES, SEAT_VALUE_SOURCES, TERMINAL_ACTORS, ESCALATION_CAUSE_UNCLASSIFIED, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError, MODIFIER_KINDS, INTAKE_DISPATCH_OUTCOMES, SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, CELL_FAILURE_ATTRIBUTIONS, RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage, REQUEST_MAX_CHARS, USAGE_ABSENT_CAUSES, usageAbsentCause, AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS, CELL_RATE_FLOOR, SUITE_REFUSAL_DEFINITION, SUITE_REFUSAL_UNSTAMPED, SCREENER_PROPOSAL_OUTCOMES, CELL_PRICE_UNITS, REVIEW_VERDICTS, PHASE_SLOT_WAIT_KINDS, PHASE_SLOT_WAIT_DEPTH_ABSENT, PHASE_SLOT_WAIT_ABSENT, NARRATION_OUTCOMES, EVAL_ENVELOPE_STATUSES, EVAL_ABSENT_REASONS, EVAL_PAYLOAD_KEYS, ingestJournal, ingestExternalFenceRegister, JOURNAL_FACT_KEYS, JOURNAL_FACT_EVENTS, PLANNER_SYMBOLS_ARMS, PLANNER_SYMBOLS_SAMPLE_FLOOR, bootstrapPercentile,
} from '../scripts/factory/ledger.mjs'

import { FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, VARIANT_NAMES, SUITE_SLOT_PHASE_NAMES, anchorAbsentWhy, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS } from '../crew/drive.mjs'

import { emitAdapter, SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS } from '../crew/seat-io.mjs'

import { modelString as piModelString } from '../crew/adapters/adapter-pi.mjs'

import { _resetNoticeGuardsForTest, openRun, parseProposalBrief } from '../scripts/factory/emit.mjs'

import { loadDurableEscalationRecord, proposalFromResponse, proposalPrompt, triageEscalation } from '../scripts/factory/escalation-triage.mjs'

import { bootTieredRun } from './factory-ledger.test.mjs'

import { NONCE_PREFIX, SCRIPT, require, SQLITE_OK, SKIP, bootBriefRun, fixture, paneReviewRun, trackChild, nextDir, run, openTestLedger, openB499Ledger, seedCellUsage, makeUnenforcedSeatIndexDb, exerciseEveryWriter, seedTaskAgentSession, MARKER_ADW, seedAllWritersWithMarker, MARKER_PLAIN, MARKER_NONCE_ONLY, CALIBRATED_RENDEZVOUS_DELAY_MS, CALIBRATED_RENDEZVOUS_DELAYS_MS, resolveRendezvousDelayMs, runConcurrentEmitterTrial, RUNSET_SINCE, RUNSET_UNTIL, seedRun, seedConfigurationRun, seedConfigurationSeat, EXECUTION_AXIS_BOOT_CONFIGURATION, executionAxisState, writeExecutionAxisCrew, writeExecutionAxisJournal, executionAxisRuntime, executionAxisRow, readerFixture, ADVISOR_AB_EPOCH, advisorAbFixture, advisorAbEnvelope, advisorAbFinding, runAdvisorAb, advisorReasons, advisorNote, SANDBOX_LEDGER_URL, SANDBOX_DEFAULT_RESOLVER, runSandboxChild, B381_PROVIDER_FAILURE_LINE, B395_SLOT_WAIT_GATE_LINE, B395_SLOT_WAIT_WARM_LINE, B395_SLOT_WAIT_COLD_LINE, B395_OLD_CORPUS_LINES, B381_PLAN_SCOPE_LINE, B381_TIMEOUT_REASK_LINE, B381_RPC_EXIT_LINE, B381_PLAN_ADOPTION_LINE, B381_EXTERNAL_REGISTER, ingestJournalLine, journalFactsCli, measuredJournalFactsDb, assertMeasuredAndAbsent, writeTurnsCorpusJournal, turnsCorpusPayload, builderTurnRole, holdoutLedger, addHoldoutLane, holdoutRows, TRIAGE_MODEL, makeTriageFixture, triageLedger, triageResponse } from './factory-ledger.test.mjs'




test('Q6: suitefacts refusal CLI divides refused dispatches by stamped dispatches per cell and marks thin cells', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const JAN = Date.parse('2024-01-01T00:00:00.000Z')
  const FEB = Date.parse('2024-02-01T00:00:00.000Z')
  const seatArgs = (adw_id, provider = 'openai') => ({ adw_id, role: 'builder', agent: 'pi', provider, model_id: 'gpt-test', model: 'gpt-test', effort: 'medium', transport: 'headless-json', source: 'roster', policy_state: 'active', created_at: '2024-01-01T00:00:00.000Z' })
  // Amendment 1: each decision carries the cell it was written with; the seat map mirrors run_seats here.
  const cellOf = new Map()
  const recordRunSeat = ledger.recordRunSeat
  ledger.recordRunSeat = (args) => { cellOf.set(args.adw_id, { provider: args.provider, model_id: args.model_id, agent: args.agent, effort: args.effort }); return recordRunSeat(args) }
  const decision = (adw_id, dispatch_id, decision, at_ms, extra = {}) => ledger.recordSuiteDecision({ adw_id, run_id: 'r1', dispatch_id, role: 'builder', transport: 'headless-json', decision, at_ms, ...cellOf.get(adw_id), ...(decision === 'refused' ? { refusal_kind: 'suite-run-not-owned', command_class: 'test-run' } : { admitted: 1, refused: 0, unrecognised: 0 }), ...extra })
  // January: 12 openai dispatches (two refused, one re-asked and recovered, one unobserved).
  for (let i = 0; i < 12; i++) { ledger.recordRunSeat(seatArgs(`q6-a-${i}`)); decision(`q6-a-${i}`, 'd1', 'policy', JAN + 1000 + i) }
  decision('q6-a-0', 'd1', 'refused', JAN + 2000, { reask_dispatch_id: 'd2', reask_status: 'done' })
  decision('q6-a-1', 'd1', 'refused', JAN + 2001, { reask_absent_reason: 'reask-unobserved' })
  // (b) a dispatch whose policy row is in January and its refusal a millisecond past the
  // January bound: January denominator 1, refusals 0.
  ledger.recordRunSeat(seatArgs('q6-edge', 'edge'))
  decision('q6-edge', 'd1', 'policy', FEB - 1)
  decision('q6-edge', 'd1', 'refused', FEB)
  // (a) a seat booted in January, refused only in February: counts in February, absent from January.
  ledger.recordRunSeat(seatArgs('q6-late', 'late'))
  decision('q6-late', 'd1', 'policy', FEB + 4000)
  decision('q6-late', 'd1', 'refused', FEB + 5000)
  // (c) a refusal with no run_seats row keeps its counts under a null cell with a reason.
  ledger.recordSuiteDecision({ adw_id: 'q6-orphan', dispatch_id: 'orphan', role: 'planner', transport: 'headless-rpc', decision: 'refused', refusal_kind: 'suite-run-not-owned', command_class: 'test-run', at_ms: JAN + 3000 })
  const window = (sinceIso, untilIso) => {
    const result = run(['suite-refusals', '--since', sinceIso, '--until', untilIso], { DEVTEAM_LEDGER_DB: ledger._dbPath })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const jan = window('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z')
  const feb = window('2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z')
  assert.equal(jan.definition, SUITE_REFUSAL_DEFINITION)
  assert.equal(jan.floor, CELL_RATE_FLOOR)
  assert.deepEqual([jan.unstamped, jan.unstamped_absent_reason], [null, SUITE_REFUSAL_UNSTAMPED])
  const cell = (payload, provider) => payload.rows.find((row) => row.provider === provider)
  const populated = cell(jan, 'openai')
  assert.deepEqual([populated.dispatches, populated.refusals, populated.rate, populated.thin], [12, 2, 2 / 12, false])
  assert.deepEqual([populated.reasks, populated.recoveries, populated.reasks_unobserved, populated.recoveries_unobserved], [1, 1, 1, 0])
  // (a)
  assert.equal(cell(jan, 'late'), undefined)
  assert.deepEqual([cell(feb, 'late').dispatches, cell(feb, 'late').refusals, cell(feb, 'late').rate], [1, 1, 1])
  // (b)
  assert.deepEqual([cell(jan, 'edge').dispatches, cell(jan, 'edge').refusals, cell(jan, 'edge').rate], [1, 0, 0])
  assert.deepEqual([cell(feb, 'edge').dispatches, cell(feb, 'edge').refusals], [1, 1])
  // (c)
  const orphan = jan.rows.find((row) => row.role === 'planner')
  assert.deepEqual([orphan.provider, orphan.model_id, orphan.agent, orphan.effort, orphan.cell_absent_reason], [null, null, null, null, 'seat-cell-unavailable'])
  assert.deepEqual([orphan.dispatches, orphan.refusals], [1, 1])
  assert.equal(populated.cell_absent_reason, null)
  // (d) thin keys on the WINDOWED denominator: the same 12-seat cell has no February
  // decision, so it is absent there, and a 1-dispatch cell is thin.
  assert.equal(cell(feb, 'openai'), undefined)
  assert.equal(cell(feb, 'late').thin, true)
  assert.equal(cell(jan, 'edge').thin, true)
  assert.equal(run(['suite-refusals'], { DEVTEAM_LEDGER_DB: ledger._dbPath }).status, 2)
  assert.equal(run(['suite-refusals', '--since', '2024-01-02T00:00:00Z', '--until', '2024-01-02T00:00:00Z'], { DEVTEAM_LEDGER_DB: ledger._dbPath }).status, 2)
  ledger.close()
})

test('suitefacts thin keys on the windowed dispatch count, not on cell seats', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const JAN = Date.parse('2024-01-01T00:00:00.000Z')
  // 12 seats in the cell but only 11 have a decision in the window: thin.
  for (let i = 0; i < 12; i++) {
    ledger.recordRunSeat({ adw_id: `thin-${i}`, role: 'builder', agent: 'pi', provider: 'openai', model_id: 'gpt-test', model: 'gpt-test', effort: 'medium', transport: 'headless-json', source: 'roster', policy_state: 'active', created_at: '2024-01-01T00:00:00.000Z' })
    ledger.recordSuiteDecision({ adw_id: `thin-${i}`, run_id: 'r1', provider: 'openai', model_id: 'gpt-test', agent: 'pi', effort: 'medium', dispatch_id: 'd1', role: 'builder', transport: 'headless-json', decision: 'policy', admitted: 1, refused: 0, unrecognised: 0, at_ms: i === 11 ? JAN - 1 : JAN + i })
  }
  const result = run(['suite-refusals', '--since', '2024-01-01T00:00:00Z', '--until', '2024-02-01T00:00:00Z'], { DEVTEAM_LEDGER_DB: ledger._dbPath })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout).rows.find((r) => r.provider === 'openai')
  assert.deepEqual([row.dispatches, row.thin], [11, true])
  ledger.close()
})

test('suitefacts Amendment 1 counts dispatches on the full identity under the cell each row was written with', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const JAN = Date.parse('2024-01-01T00:00:00.000Z')
  const openai = { provider: 'openai', model_id: 'gpt-test', agent: 'pi', effort: 'medium' }
  const anthropic = { provider: 'anthropic', model_id: 'claude-test', agent: 'claude', effort: 'high' }
  // run_seats is unique per (adw_id, role): it keeps the FIRST boot's cell.
  ledger.recordRunSeat({ adw_id: 'reboot', role: 'builder', ...openai, model: 'gpt-test', transport: 'headless-json', source: 'roster', policy_state: 'active', created_at: '2024-01-01T00:00:00.000Z' })
  const decision = (run_id, cell, transport, dispatch_id, decision, at_ms, extra = {}) => ledger.recordSuiteDecision({ adw_id: 'reboot', run_id, ...cell, dispatch_id, role: 'builder', transport, decision, at_ms, ...(decision === 'refused' ? { refusal_kind: 'suite-run-not-owned', command_class: 'suite' } : { admitted: 1, refused: 1, unrecognised: 0 }), ...extra })
  decision('r1', openai, 'headless-json', 'd1', 'policy', JAN + 1)
  decision('r1', openai, 'headless-json', 'd1', 'refused', JAN + 2)
  // (a) the lane reboots (same adw_id, new run) onto another cell and is refused there.
  decision('r2', anthropic, 'headless-json', 'd1', 'policy', JAN + 10)
  decision('r2', anthropic, 'headless-json', 'd1', 'refused', JAN + 11)
  // (b) the pane transport issues its own d1 in the same run: a second dispatch.
  decision('r2', anthropic, 'pane', 'd1', 'policy', JAN + 12, { admitted: null, refused: null, unrecognised: null, policy_absent_reason: 'pane-no-intercept' })
  // (c) a pre-amendment row: no run and no cell, with the closed reason, counted.
  ledger.recordSuiteDecision({ adw_id: 'reboot', run_id_absent_reason: 'pre-amendment', cell_absent_reason: 'pre-amendment', dispatch_id: 'd9', role: 'builder', transport: 'headless-json', decision: 'refused', refusal_kind: 'suite-run-not-owned', command_class: 'suite', at_ms: JAN + 20 })
  const result = run(['suite-refusals', '--since', '2024-01-01T00:00:00Z', '--until', '2024-02-01T00:00:00Z'], { DEVTEAM_LEDGER_DB: ledger._dbPath })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout).rows
  const first = rows.find((row) => row.provider === 'openai')
  const second = rows.find((row) => row.provider === 'anthropic')
  const legacy = rows.find((row) => row.cell_absent_reason === 'pre-amendment')
  assert.deepEqual([first.dispatches, first.refusals, first.rate, first.rate_absent_reason], [1, 1, 1, null])
  // The pane d1 is a second dispatch, but the pane never observed its commands, so the cell's
  // rate is unmeasured: coverage-unavailable, never 1/2 read as measured nor 0.
  assert.deepEqual([second.model_id, second.agent, second.effort, second.dispatches, second.refusals, second.coverage_unavailable], ['claude-test', 'claude', 'high', 2, 1, 1])
  assert.deepEqual([second.rate, second.rate_absent_reason], [null, 'coverage-unavailable'])
  assert.deepEqual([legacy.provider, legacy.model_id, legacy.agent, legacy.effort, legacy.dispatches, legacy.refusals], [null, null, null, null, 1, 1])
  assert.deepEqual([legacy.rate, legacy.rate_absent_reason, legacy.identity_incomplete], [null, 'identity-incomplete', 1])
  assert.equal(rows.length, 3)
  ledger.close()
})

test('suitefacts a rate is printed only when every dispatch has identity, coverage and a correlated re-ask', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const JAN = Date.parse('2024-01-01T00:00:00.000Z')
  const cell = (provider) => ({ provider, model_id: 'm', agent: 'pi', effort: 'medium' })
  const policy = (adw_id, provider, extra = {}) => ledger.recordSuiteDecision({ adw_id, run_id: 'r1', ...cell(provider), dispatch_id: 'd1', role: 'builder', transport: 'headless-json', decision: 'policy', admitted: 1, refused: 0, unrecognised: 0, at_ms: JAN + 1, ...extra })
  const refused = (adw_id, provider, extra = {}) => ledger.recordSuiteDecision({ adw_id, run_id: 'r1', ...cell(provider), dispatch_id: 'd1', role: 'builder', transport: 'headless-json', decision: 'refused', refusal_kind: 'suite-run-not-owned', command_class: 'suite', at_ms: JAN + 2, ...extra })
  // measured: every clause holds.
  policy('m-1', 'measured'); refused('m-1', 'measured', { reask_dispatch_id: 'd2', reask_status: 'done' }); policy('m-2', 'measured')
  // (1) identity: two pre-amendment d1 dispatches.
  for (const adw_id of ['p-1', 'p-2']) { policy(adw_id, 'pre', { run_id: null, run_id_absent_reason: 'pre-amendment' }); refused(adw_id, 'pre', { run_id: null, run_id_absent_reason: 'pre-amendment' }) }
  // (2) coverage: a policy row whose counters were not observed, and a dispatch with no policy row at all.
  policy('c-1', 'coverage', { admitted: null, refused: null, unrecognised: null, policy_absent_reason: 'pane-no-intercept', transport: 'pane' })
  refused('c-2', 'nopolicy')
  // (3) re-ask: a refusal whose re-ask could not be correlated in its own run.
  policy('r-1', 'reask'); refused('r-1', 'reask', { reask_absent_reason: 'reask-uncorrelated' })
  const result = run(['suite-refusals', '--since', '2024-01-01T00:00:00Z', '--until', '2024-02-01T00:00:00Z'], { DEVTEAM_LEDGER_DB: ledger._dbPath })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout).rows
  const by = (provider) => rows.find((row) => row.provider === provider)
  assert.deepEqual([by('measured').dispatches, by('measured').refusals, by('measured').rate, by('measured').rate_absent_reason], [2, 1, 1 / 2, null])
  assert.deepEqual([by('pre').dispatches, by('pre').refusals, by('pre').rate, by('pre').rate_absent_reason], [2, 2, null, 'identity-incomplete'])
  assert.deepEqual([by('coverage').dispatches, by('coverage').refusals, by('coverage').rate, by('coverage').rate_absent_reason], [1, 0, null, 'coverage-unavailable'])
  assert.deepEqual([by('nopolicy').dispatches, by('nopolicy').refusals, by('nopolicy').rate, by('nopolicy').rate_absent_reason], [1, 1, null, 'coverage-unavailable'])
  assert.deepEqual([by('reask').dispatches, by('reask').refusals, by('reask').rate, by('reask').rate_absent_reason], [1, 1, null, 'reask-uncorrelated'])
  ledger.close()
})

test('T3: an out-of-range CLI window is a usage refusal', { skip: SKIP }, () => {
  const result = run(['seat-teardowns', '--since', '+058692-11-03T14:13:20.000Z'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /\[reason: usage\]/)
})
test('evals CLI publishes exactly the closed payload and keeps an empty bench absent', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const bench = 'eval-cli'.padEnd(64, '0')
  try {
    ledger.recordEvalCell({
      bench, role: 'builder', provider: 'anthropic', model_id: 'claude-sonnet-5', agent: 'claude', effort: 'medium',
      production: 1, task_sha: 'task-sha', envelope_status: 'received', asserts_declared: 1, asserts_passed: 1,
      judge_findings: [], billed_input_tokens: 1, billed_output_tokens: 1, billed_cache_read_tokens: 1,
      billed_cache_write_tokens: 1, duration_ms: 1,
    })
  } finally { ledger.close() }
  const measured = run(['evals', '--bench', bench], { DEVTEAM_LEDGER_DB: ledger._dbPath })
  assert.equal(measured.status, 0, measured.stderr)
  const payload = JSON.parse(measured.stdout)
  assert.deepEqual(Object.keys(payload).sort(), [...EVAL_PAYLOAD_KEYS].sort())
  assert.equal(payload.rows.length, 1)
  assert.equal(payload.production.in_table, true)
  assert.equal(payload.production.model, 'anthropic/claude-sonnet-5')
  assert.equal(payload.incomplete.some((entry) => entry.reason === 'production-absent'), false)

  const emptyBench = 'eval-empty'.padEnd(64, '0')
  const empty = run(['evals', '--bench', emptyBench], { DEVTEAM_LEDGER_DB: ledger._dbPath })
  assert.equal(empty.status, 0, empty.stderr)
  const emptyPayload = JSON.parse(empty.stdout)
  assert.equal(emptyPayload.rows, null)
  assert.equal(emptyPayload.ratifiable, false)
  assert.equal(emptyPayload.cost_is_floor, true)
  assert.equal(emptyPayload.incomplete.some((entry) => entry.reason === 'no-cells'), true)
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
    { verb: 'configurations', flag: 'since', args: ['configurations', '--since', since, '--until', until] },
    { verb: 'configurations', flag: 'until', args: ['configurations', '--since', since, '--until', until] },
    { verb: 'cell-failures', flag: 'since', args: ['cell-failures', '--since', since, '--until', until] },
    { verb: 'cell-failures', flag: 'until', args: ['cell-failures', '--since', since, '--until', until] },
    { verb: 'cells', flag: 'since', args: ['cells', '--since', since, '--until', until] },
    { verb: 'cells', flag: 'until', args: ['cells', '--since', since, '--until', until] },
    { verb: 'cells', flag: 'prices', args: ['cells', '--prices', join(dir, 'prices.json')] },
    { verb: 'evals', flag: 'bench', args: ['evals', '--bench', 'eval-case'.padEnd(64, '0')] },
    { verb: 'evals', flag: 'prices', args: ['evals', '--bench', 'eval-case'.padEnd(64, '0'), '--prices', join(dir, 'prices.json')] },
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
  for (const verb of ['sessions', 'phases', 'procs', 'task', 'gate-review-gap', 'eligible-tasks', 'evals', 'doctor']) {
    const result = run([verb, '--nope', 'x'])
    assert.equal(result.status, 2, `${verb}: ${result.stderr}`)
    assert.match(result.stderr, /unknown flag --nope/)
  }
})
test('#443: every window subcommand refuses the misspelled flag', { skip: SKIP }, () => {
  for (const verb of ['run-set', 'configurations', 'cell-failures', 'cells', 'modifier-attempts', 'seat-teardowns', 'escalations', 'ci-cycles', 'intake-sweeps']) {
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
  for (let i = 0; i < 3; i += 1) {
    const adw_id = `cli-escalation-success-${i}`
    ledger.startSession({ adw_id, repo_slug: 'r', task_slug: adw_id })
    ledger.endSession({ adw_id, status: 'ok', outcome: 'success', ended_at: `2024-01-03T00:00:0${i}.000Z` })
  }
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
  assert.ok(payload.causes.includes('unclassified'))

  const measuredZero = run(['escalations', '--since', '2024-01-03T00:00:00Z', '--until', '2024-01-03T00:01:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(measuredZero.status, 0, measuredZero.stderr)
  const zeroPayload = JSON.parse(measuredZero.stdout)
  assert.equal(zeroPayload.measured, true)
  assert.equal(zeroPayload.escalated, 0)
  assert.equal(zeroPayload.runs_ended, 3)
  assert.deepEqual(zeroPayload.absent, null)
  assert.deepEqual(zeroPayload.rows, [])
  assert.ok(zeroPayload.causes.includes('unclassified'))

  const unmeasured = run(['escalations', '--since', '2024-01-04T00:00:00Z', '--until', '2024-01-04T00:01:00Z'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(unmeasured.status, 0, unmeasured.stderr)
  const unmeasuredPayload = JSON.parse(unmeasured.stdout)
  assert.equal(unmeasuredPayload.measured, false)
  assert.equal(unmeasuredPayload.escalated, null)
  assert.equal(unmeasuredPayload.runs_ended, null)
  assert.deepEqual(unmeasuredPayload.absent, { escalations: 'no run ended in this window — not measured, never a measured zero' })

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
  assert.deepEqual(Object.keys(payload.path_dependent_tables).sort(), ['run_links', 'run_observations'])
  assert.match(payload.path_dependent_tables.run_observations, /crew:watch --follow/)
  assert.match(payload.path_dependent_tables.run_links, /only by the daemon path/)
})
test('doctor reports the retired processes reason beside an empty row count', { skip: SKIP }, () => {
  const dbPath = join(nextDir(), 'doctor-retired-processes.db')
  const res = run(['doctor'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.equal(payload.row_counts.processes, 0)
  assert.ok(typeof payload.retired_tables.processes === 'string' && payload.retired_tables.processes.length >= 40)
})
test('A1: retired synthetic-session vocabulary is absent from the ledger and CLI', { skip: SKIP }, async () => {
  const ledgerModule = await import('../scripts/factory/ledger.mjs')
  assert.equal(Object.hasOwn(ledgerModule, 'SESSION_SYNTHETIC_REASONS'), false)
  assert.equal(ledgerModule.WRITERS.includes('markSyntheticSession'), false)
  assert.equal(ledgerModule.UPDATE_ONLY_WRITERS.includes('markSyntheticSession'), false)
  for (const reader of ['listSessions', 'getSession', 'dumpTable', 'phantomSessions']) {
    assert.equal(ledgerModule.WRITERS.includes(reader), false)
  }

  const usage = run([])
  assert.equal(usage.status, 2)
  assert.doesNotMatch(usage.stderr, /mark-synthetic/)
  const retired = run(['mark-synthetic'])
  assert.equal(retired.status, 2)
  assert.match(retired.stderr, /unknown verb: mark-synthetic/)

  const phantom = run(['phantom-sessions'])
  assert.equal(phantom.status, 0, phantom.stderr)
  const payload = JSON.parse(phantom.stdout)
  assert.deepEqual(payload.reasons, [])
  assert.match(payload.definition, /historical persisted provenance/)
  assert.match(payload.definition, /currently writable operator mark/)
})
test('phantom-sessions CLI refuses malformed input and a degraded mirror', { skip: SKIP }, () => {
  for (const args of [
    ['phantom-sessions', 'unexpected'],
    ['phantom-sessions', '--unknown'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 2, `${args.join(' ')} must refuse`)
  }

  const corruptDb = join(scratchDir('b548-phantom-sessions-corrupt-'), 'ledger.db')
  writeFileSync(corruptDb, 'not a sqlite database')
  const degraded = run(['phantom-sessions'], { DEVTEAM_LEDGER_DB: corruptDb })
  assert.equal(degraded.status, 2, degraded.stderr)
  assert.match(degraded.stderr, /unanswerable/)
})

// ---------------------------------------------------------------------------
// settle verb: refusal-gated operator settlement of a running session whose
// linked driver PID is proven gone via run_links sidecars (A1-H1).
// ---------------------------------------------------------------------------

function settleSeedDb(adwId, crewDir) {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: 'settle' })
    ledger.linkRun({ run_id: `run-${adwId}`, adw_id: adwId, crew_dir: crewDir })
  } finally {
    ledger.close()
  }
  return dbPath
}

function settleWriteSidecar(crewDir, adwId, pid) {
  mkdirSync(join(crewDir, 'ledger'), { recursive: true })
  writeFileSync(join(crewDir, 'ledger', 'run.json'), JSON.stringify({ adw_id: adwId }))
  writeFileSync(join(crewDir, 'run.pid'), `${pid}\n`)
}

function settleReadSession(dbPath, adwId) {
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    return ledger.getSession(adwId)
  } finally {
    ledger.close()
  }
}

async function settleGonePid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('close', resolve))
  return child.pid
}

test('A1', async () => {
  const adwId = 'settle-a1-archived'
  const parent = scratchDir('settle-a1-')
  const live = join(parent, 'crew-a1')
  const archived = `${live}.archive-2026-09-02T00-00-00-000Z`
  settleWriteSidecar(archived, adwId, await settleGonePid())
  const dbPath = settleSeedDb(adwId, live)
  const res = run(['settle', adwId, '--reason', 'driver SIGKILLED after teardown'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(JSON.parse(res.stdout).status, 'aborted')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    assert.deepEqual(ledger.dumpTable('processes'), [])
    const session = ledger.getSession(adwId)
    assert.equal(session.status, 'aborted')
    assert.equal(session.outcome, 'aborted')
    assert.equal(session.terminal_reason, 'driver SIGKILLED after teardown')
  } finally {
    ledger.close()
  }
})

test('B1', async () => {
  const adwId = 'settle-b1-live'
  const crewDir = scratchDir('settle-b1-')
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    settleWriteSidecar(crewDir, adwId, child.pid)
    const dbPath = settleSeedDb(adwId, crewDir)
    const before = settleReadSession(dbPath, adwId)
    const res = run(['settle', adwId, '--reason', 'attempt while live'], { DEVTEAM_LEDGER_DB: dbPath })
    assert.equal(res.status, 2, res.stdout)
    assert.match(res.stderr, /still alive/)
    assert.deepEqual(settleReadSession(dbPath, adwId), before)
    assert.doesNotThrow(() => process.kill(child.pid, 0))
  } finally {
    child.kill('SIGKILL')
  }
})

test('C1', async () => {
  const adwId = 'settle-c1-actor'
  const crewDir = scratchDir('settle-c1-')
  settleWriteSidecar(crewDir, adwId, await settleGonePid())
  const dbPath = settleSeedDb(adwId, crewDir)
  const res = run(['settle', adwId, '--reason', 'operator stop by hand'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(settleReadSession(dbPath, adwId).terminal_actor, 'operator')
})

test('D1', async () => {
  const adwId = 'settle-d1-reason'
  const crewDir = scratchDir('settle-d1-')
  settleWriteSidecar(crewDir, adwId, await settleGonePid())
  const dbPath = settleSeedDb(adwId, crewDir)
  const before = settleReadSession(dbPath, adwId)
  const omitted = run(['settle', adwId], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(omitted.status, 2)
  assert.match(omitted.stderr, /--reason/)
  const blank = run(['settle', adwId, '--reason', '   '], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(blank.status, 2)
  assert.match(blank.stderr, /--reason/)
  const long = run(['settle', adwId, '--reason', 'x'.repeat(65)], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(long.status, 2)
  assert.match(long.stderr, /at most 64 characters/)
  assert.match(long.stderr, /ledger settle/)
  assert.deepEqual(settleReadSession(dbPath, adwId), before)
})

test('E1', () => {
  const adwId = 'settle-e1-absent'
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  ledger.close()
  const res = run(['settle', adwId, '--reason', 'no such run'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /settle-e1-absent/)
  assert.equal(settleReadSession(dbPath, adwId), null)
})

test('F1', async () => {
  const adwId = 'settle-f1-terminal'
  const crewDir = scratchDir('settle-f1-')
  settleWriteSidecar(crewDir, adwId, await settleGonePid())
  const dbPath = settleSeedDb(adwId, crewDir)
  const first = run(['settle', adwId, '--reason', 'first terminal write'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(first.status, 0, first.stderr)
  const row = settleReadSession(dbPath, adwId)
  assert.equal(row.status, 'aborted')
  const second = run(['settle', adwId, '--reason', 'second attempt'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(second.status, 2)
  assert.deepEqual(settleReadSession(dbPath, adwId), row)
})

test('G1', () => {
  const res = run(['kill', '--adw-id', 'settle-g1-norow', '--pid', '999999', '--yes'])
  assert.equal(res.status, 2)
  assert.equal(res.stderr, 'ledger kill: refused — no matching processes row for that (adw_id, pid)\n')
})

test('H1', () => {
  const doc = readFileSync(join(ROOT, 'skills/devops/references/processes.md'), 'utf8')
  assert.ok(doc.includes('After SIGKILL, run `node scripts/factory/ledger.mjs settle <adw-id> --reason <text>`'), 'processes.md must name the post-SIGKILL settle command')
})
