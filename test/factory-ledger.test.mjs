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
  DRIVER_GONE_THRESHOLD_MS, SESSION_STATUS_ABSENT, projectSessions, DRIVER_STATES, RUN_OBSERVATION_SOURCES, RUN_OBSERVATION_COLUMNS, RUN_OBSERVATION_WRITE_VERB,
  SESSION_STATUSES, SESSION_OUTCOMES, SEAT_VALUE_SOURCES, TERMINAL_ACTORS, ESCALATION_CAUSES, ESCALATION_CAUSE_UNCLASSIFIED, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError,
  MODIFIER_KINDS, MODIFIER_ATTEMPT_OUTCOMES, INTAKE_DISPATCH_OUTCOMES,
  SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, CELL_FAILURE_KINDS, CELL_FAILURE_ATTRIBUTIONS,
  RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage,
  REQUEST_MAX_CHARS, ADVISOR_AB_INCOMPLETE_REASONS, USAGE_ABSENT_CAUSES, usageAbsentCause,
  AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS,
  CELL_RATE_FLOOR, SCREENER_PROPOSAL_OUTCOMES, TURN_TRANSPORTS, CELL_PRICE_UNITS, REVIEW_VERDICTS,
  PHASE_SLOT_WAIT_KINDS, PHASE_SLOT_WAIT_DEPTH_ABSENT, PHASE_SLOT_WAIT_ABSENT,
  NARRATION_OUTCOMES,
  EVAL_ENVELOPE_STATUSES, EVAL_ABSENT_REASONS, EVAL_INCOMPLETE_REASONS, EVAL_PAYLOAD_KEYS,
  ingestJournal, ingestExternalFenceRegister,
  JOURNAL_FACT_KEYS, JOURNAL_FACT_EVENTS, PLANNER_SYMBOLS_ARMS, PLANNER_SYMBOLS_SAMPLE_FLOOR,
  PLANNER_SYMBOLS_BOOTSTRAP_RESAMPLES, PLANNER_SYMBOLS_BOOTSTRAP_SEED, bootstrapPercentile,
} from '../scripts/factory/ledger.mjs'
import { FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, VARIANT_NAMES, SUITE_SLOT_PHASE_NAMES, anchorAbsentWhy, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS } from '../crew/drive.mjs'
import { SUBMIT_BLIND_SPOT } from '../crew/driver.mjs'
import { emitAdapter, SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS } from '../crew/seat-io.mjs'
import { headlessIo } from '../crew/headless.mjs'
import { modelString as piModelString } from '../crew/adapters/adapter-pi.mjs'
// openRun is the only production writer of sessions.tier and the compiler
// proposal columns: it reads the boot record/brief and forwards them. The
// forwarding is pinned here, next to the columns it writes, because
// test/factory-emit.test.mjs is not this lane's to edit.
import {
  _resetNoticeGuardsForTest, openRun, parseProposalBrief,
} from '../scripts/factory/emit.mjs'
import {
  loadDurableEscalationRecord,
  proposalFromResponse,
  proposalPrompt,
  triageEscalation,
} from '../scripts/factory/escalation-triage.mjs'

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
  if (runConfiguration?.execution) {
    writeFileSync(join(stateDir, 'journal.jsonl'), [
      JSON.stringify({ event: 'run-start' }),
      JSON.stringify({ event: 'run-configuration', run_configuration: runConfiguration }),
    ].join('\n') + '\n')
  }
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

function openB499Ledger(extra = {}) {
  const dir = scratchDir('b499-ledger-')
  const dbPath = join(dir, 'ledger.db')
  return { dir, dbPath, ledger: openLedger({ dbPath, stderr: { write: () => {} }, ...extra }) }
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





// ---------------------------------------------------------------------------
// AC-1: schema exactness
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// M1: dumpTable('sessions') must not silently return [] (regression: the
// naturalKey fallback used a hardcoded 'id' column that sessions does not
// have — its primary key is adw_id — so the ORDER BY threw and the bare
// catch swallowed it into an empty array).
// ---------------------------------------------------------------------------



























// ---------------------------------------------------------------------------
// M2: startPhase must not trust a stale, connection-global lastInsertRowid
// when its INSERT OR IGNORE is actually ignored (a natural-key collision).
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// AC-3: pragmas read back from the live connection
// ---------------------------------------------------------------------------









// ---------------------------------------------------------------------------
// AC-4: additive, idempotent migrations
// ---------------------------------------------------------------------------







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







// ---------------------------------------------------------------------------
// AC-5: reconstructability via replayJsonl
// ---------------------------------------------------------------------------

function exerciseEveryWriter(ledger, adwId) {
  ledger.startSession({ adw_id: adwId, repo_slug: 'repo', task_slug: 'task' })
  ledger.recordRunSeat({
    adw_id: adwId, role: 'planner', agent: 'claude', provider: 'anthropic', model_id: 'claude-sonnet',
    model: 'sonnet', effort: 'high', transport: 'pane', source: 'roster', policy_state: 'passed',
    warnings: ['fixture-warning'], created_at: '2024-01-01T00:00:00.000Z',
  })
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
  ledger.recordEvalCell({
    bench: `bench-${adwId}`, adw_id: adwId, role: 'builder', provider: 'anthropic',
    model_id: 'claude-sonnet-5', agent: 'claude', effort: 'high', production: 1,
    task_sha: 'task-sha', envelope_status: 'received', absent_reason: null,
    asserts_declared: 2, asserts_passed: 2, judge_findings: ['f1'],
    billed_input_tokens: 10, billed_output_tokens: 20, billed_cache_read_tokens: 30,
    billed_cache_write_tokens: 40, duration_ms: 50, created_at: '2024-01-01T00:00:00.000Z',
  })
  ledger.recordRoutingChoice({
    entry_point: 'bench', tier: 'build', role: 'builder',
    policy_hash: 'a'.repeat(64), measurement_fingerprint: 'b'.repeat(64),
    outcome: 'abstained', chosen_cell: null,
    candidate_set: [{ provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }],
    exclusions: [{ cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }, reason: 'rate-absent' }],
    normalized_measurements: [{ cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }, rate: { numerator: null, denominator: null, value: null, reason: 'rate-absent' }, cost_usd: { value: null, reason: 'cost-absent' }, exclusion_reason: 'rate-absent' }],
    policy_entry: { candidates: [{ provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }], tie_break: ['first_round_pass_rate_desc', 'cost_usd_asc', 'policy_order'], measurement_window: { lookback_days: 30, minimum_rate_denominator: 12 }, null_handling: { rate: 'exclude-with-reason', cost: 'exclude-with-reason' }, abstention_reasons: ['no-eligible-candidate'] },
    reason: 'no-eligible-candidate', created_at: '2024-01-01T00:00:00.000Z',
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



































// ---------------------------------------------------------------------------
// AC-6: polling query + index
// ---------------------------------------------------------------------------











// ---------------------------------------------------------------------------
// AC-7: JSONL precedes db; a db failure never propagates
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// AC-9: field-hygiene mutation test
// ---------------------------------------------------------------------------

const MARKER_ADW = 'devteam-done-marker-should-never-persist-anywhere'

function seedAllWritersWithMarker(ledger) {
  const ctx = 'marker-run'
  ledger.startSession({ adw_id: ctx, repo_slug: 'r', task_slug: 't', DEVTEAM_SECRET: MARKER_ADW })
  ledger.recordRunSeat({
    adw_id: ctx, role: 'builder', agent: MARKER_ADW, provider: 'anthropic', model_id: 'sonnet',
    model: 'sonnet', effort: 'high', transport: 'pane', source: 'roster', policy_state: 'passed',
    warnings: [MARKER_ADW], created_at: '2024-01-01T00:00:00.000Z',
  })
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
  ledger.recordRoutingChoice({
    entry_point: 'bench', tier: 'build', role: 'builder',
    policy_hash: 'a'.repeat(64), measurement_fingerprint: 'b'.repeat(64),
    outcome: 'abstained', chosen_cell: null,
    candidate_set: [{ provider: MARKER_ADW, id: 'marker-model', agent: 'pi', effort: 'max' }],
    exclusions: [{ cell: { provider: MARKER_ADW, id: 'marker-model', agent: 'pi', effort: 'max' }, reason: 'measurement-invalid' }],
    normalized_measurements: [{ cell: { provider: MARKER_ADW, id: 'marker-model', agent: 'pi', effort: 'max' }, rate: { numerator: null, denominator: null, value: null, reason: 'rate-invalid' }, cost_usd: { value: null, reason: 'cost-absent' }, exclusion_reason: 'measurement-invalid' }],
    policy_entry: { candidates: [{ provider: MARKER_ADW, id: 'marker-model', agent: 'pi', effort: 'max' }], tie_break: ['first_round_pass_rate_desc', 'cost_usd_asc', 'policy_order'], measurement_window: { lookback_days: 30, minimum_rate_denominator: 12 }, null_handling: { rate: 'exclude-with-reason', cost: 'exclude-with-reason' }, abstention_reasons: ['no-eligible-candidate'] },
    reason: 'no-eligible-candidate', created_at: '2024-01-01T00:00:03.000Z',
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









// --- S3: a marker-bearing INVALID value must never reach a refusal message


// ---------------------------------------------------------------------------
// AC-10: kill helper refusal gates
// ---------------------------------------------------------------------------





// Despite the name of the gate ("pid matches this process or its parent"),
// passing THIS test's own pid as --pid only ever exercises the ppid half:
// the kill CLI runs as a freshly spawned subprocess, so its own
// process.pid is a value this test cannot know before spawning it — the
// `pidNum === process.pid` disjunct is therefore untestable out-of-process
// by construction. See the dedicated S8 test below for the same coverage,
// named accurately.




// S8(b): a live pid whose recorded `command` deliberately does not match
// the process's real, live command must refuse and send no signal.






// S8: exercises the SIGTERM-exhausted -> re-check -> SIGKILL escalation
// path against a target that deliberately traps and ignores SIGTERM.
// DEVTEAM_LEDGER_TERM_TO_KILL_MS (a CLI-only TEST SEAM, see its definition
// in ledger.mjs) shortens the wait from 5s to 200ms so this stays fast.


// ---------------------------------------------------------------------------
// AC-11 (runtime half): finalizer idempotence + signal landing
// ---------------------------------------------------------------------------





// Cheap add: pins endSession's COALESCE behavior directly, independent of
// the finalizer's own read-first guard above — reverting the COALESCE(?,
// column) SQL back to a bare `?` must make this go red on its own.


// S6: a signal arriving AFTER the run's own clean endSession(ok, spend)
// must be a no-op over the finalizer — not overwrite status to 'fail' nor
// NULL out the already-recorded spend figures via an unconditional UPDATE.












// ---------------------------------------------------------------------------
// AC-14: FTS5 capability probe (printed only, never asserted about its value)
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// S11(c): concurrent first-open race (one retry on a locked open, never
// permanently degrading a handle purely for losing a benign race)
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// #541: allocate-then-confirm and collapse readout pins
// ---------------------------------------------------------------------------

// #541: the calibrated delay is a measured default; the optional environment
// override is validated by the same resolver used by the named witnesses.
const CALIBRATED_RENDEZVOUS_DELAY_MS = 0
const CALIBRATED_RENDEZVOUS_DELAYS_MS = Object.freeze([0, 1, 2])

function resolveRendezvousDelayMs() {
  const rendezvousDelayInput = process.env.CREW_LEDGER_RENDEZVOUS_DELAY_MS
  const rendezvousDelayMs = rendezvousDelayInput === undefined ? CALIBRATED_RENDEZVOUS_DELAY_MS : Number(rendezvousDelayInput)
  assert.ok(
    rendezvousDelayInput === undefined
      || (rendezvousDelayInput.trim() !== ''
        && Number.isFinite(rendezvousDelayMs)
        && Number.isInteger(rendezvousDelayMs)
        && rendezvousDelayMs >= 0),
    'CREW_LEDGER_RENDEZVOUS_DELAY_MS must be a finite nonnegative integer',
  )
  return rendezvousDelayMs
}

function waitForEmitterReady(child, tag) {
  return new Promise((resolve, reject) => {
    const settle = (error = null) => {
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onMessage = (message) => {
      if (message?.type !== 'ready' || message?.tag !== tag) {
        settle(new Error(`emitter ${tag} sent malformed readiness IPC`))
        return
      }
      settle()
    }
    const onExit = (code, signal) => {
      settle(new Error(`emitter ${tag} exited before readiness (${code ?? 'null'}, ${signal ?? 'none'})`))
    }
    if (child.exitCode !== null) {
      onExit(child.exitCode, child.signalCode)
      return
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}

async function runConcurrentEmitterTrial({ delayMs }) {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const emitter = join(dir, 'emitter.mjs')
  writeFileSync(emitter, `
    import { openLedger } from ${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)}
    const [dbPath, tag] = process.argv.slice(2)
    const ledger = openLedger({ dbPath })
    ledger.dumpTable('events')
    process.send?.({ type: 'ready', tag })
    await new Promise((resolve, reject) => {
      process.once('message', resolve)
      process.once('disconnect', () => reject(new Error('parent disconnected before release')))
    })
    for (let i = 0; i < 25; i += 1) {
      ledger.recordEvent({ adw_id: '541-race', type: 'log', payload: { level: 'info', message: tag + ':' + i } })
    }
    ledger.close()
    process.disconnect?.()
  `)
  function childStderr(child) {
    let text = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { text += chunk })
    return () => text
  }
  const childA = trackChild(spawn(process.execPath, [emitter, dbPath, 'A'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
  const stderrA = childStderr(childA)
  await waitForEmitterReady(childA, 'A')
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  const childB = trackChild(spawn(process.execPath, [emitter, dbPath, 'B'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
  const stderrB = childStderr(childB)
  await waitForEmitterReady(childB, 'B')
  assert.notEqual(childA.pid, process.pid, 'the emitter must be a REAL second process')
  assert.notEqual(childB.pid, process.pid, 'the emitter must be a REAL second process')
  assert.notEqual(childA.pid, childB.pid, 'the emitters must be distinct processes')
  assert.equal(childA.exitCode, null, 'emitter A exited before release')
  assert.equal(childB.exitCode, null, 'emitter B exited before release')
  const exitA = new Promise((resolve) => childA.once('exit', (code, signal) => resolve({ code, signal })))
  const exitB = new Promise((resolve) => childB.once('exit', (code, signal) => resolve({ code, signal })))
  childA.send('release')
  childB.send('release')
  const [exitAInfo, exitBInfo] = await Promise.all([exitA, exitB])
  const jsonlEvents = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-race')
  const live = openLedger({ dbPath, stderr: { write: () => {} } })
  let sqliteCount
  try {
    sqliteCount = live.dumpTable('events').filter((row) => row.adw_id === '541-race').length
  } finally { live.close() }
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  let replayCount
  try {
    replayJsonl(jsonlPath, rebuilt)
    replayCount = rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-race').length
  } finally { rebuilt.close() }
  const perTagCounts = Object.fromEntries(['A', 'B'].map((tag) => [
    tag, jsonlEvents.filter((line) => String(line.args.payload?.message).startsWith(`${tag}:`)).length,
  ]))
  let sqliteWasRead = false
  const trial = {
    exits: [exitAInfo, exitBInfo],
    stderr: [stderrA(), stderrB()],
    perTagCounts,
    jsonlCount: jsonlEvents.length,
    replayCount,
    childPids: [childA.pid, childB.pid],
    emitterPath: emitter,
    dbPath,
    jsonlPath,
  }
  Object.defineProperty(trial, 'sqliteCount', {
    enumerable: true,
    get() { sqliteWasRead = true; return sqliteCount },
  })
  Object.defineProperty(trial, 'sqliteMeasured', {
    enumerable: false,
    get() { return sqliteWasRead },
  })
  return trial
}

// #541: two live emitters on one adw_id lose no record.



















// #541: a degraded handle's spent sequence numbers are not re-issued.


// #541: an explicit seq advances a degraded handle's memoized authority floor.


// #541: an empty memoized floor scans prior authority before an explicit write.


// #541: a different-content duplicate key is visible without changing drift.


// #541: repeats with identical content are idempotent, not collapse.


// #541: an explicit different-content collision is counted by stats.


// #541: doctor names a measured key collapse independently of drift.


// ---------------------------------------------------------------------------
// S12: cheap missing negative tests
// ---------------------------------------------------------------------------









// ---------------------------------------------------------------------------
// AC-18: the four read-only npm-recipe CLI verbs
// ---------------------------------------------------------------------------







// ---------------------------------------------------------------------------
// #443: unknown CLI flags are refusals, not silent defaults
// ---------------------------------------------------------------------------













// ---------------------------------------------------------------------------
// #193: one-run-set readout
// ---------------------------------------------------------------------------

const RUNSET_SINCE = '2026-08-15T00:00:00.000Z'
const RUNSET_UNTIL = '2026-08-15T01:00:00.000Z'

function seedRun(ledger, adwId, startedAt, status = 'running') {
  ledger.startSession({ adw_id: adwId, repo_slug: 'r', task_slug: adwId, started_at: startedAt })
  if (status !== 'running') ledger.endSession({ adw_id: adwId, status })
}

function seedConfigurationRun(ledger, adwId, startedAt, overrides = {}) {
  seedRun(ledger, adwId, startedAt)
  const values = {
    schema_version: 1,
    task_profile: 'implementation',
    task_profile_source: 'explicit',
    requested_execution: 'full',
    effective_execution: 'full',
    execution_source: 'profile_recommendation',
    requested_assurance: 'standard',
    effective_assurance: 'standard',
    assurance_source: 'explicit',
    legacy_variant: null,
    legacy_tier: null,
    ...overrides,
  }
  ledger.recordRunConfiguration({ adw_id: adwId, ...values, created_at: values.created_at ?? startedAt })
}

function seedConfigurationSeat(ledger, adwId, role, source, createdAt = '2024-01-01T00:00:10.000Z') {
  ledger.recordRunSeat({
    adw_id: adwId,
    role,
    agent: 'claude',
    provider: 'anthropic',
    model_id: `model-${role}`,
    model: `model-${role}`,
    effort: 'high',
    transport: 'pane',
    source,
    policy_state: 'passed',
    warnings: [`warning-${role}`],
    created_at: createdAt,
  })
}

const EXECUTION_AXIS_BOOT_CONFIGURATION = {
  profile: { requested: 'implementation', effective: 'implementation', source: 'explicit' },
  assurance: { requested: 'standard', effective: 'standard', source: 'explicit' },
}

function executionAxisState() {
  return nextDir()
}

function writeExecutionAxisCrew(stateDir, runConfiguration = EXECUTION_AXIS_BOOT_CONFIGURATION) {
  writeFileSync(join(stateDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'execution-axis', roles: ['lead', 'planner'], tier: 'fixture-tier', run_configuration: runConfiguration,
  }))
}

function writeExecutionAxisJournal(stateDir, rows) {
  writeFileSync(join(stateDir, 'journal.jsonl'), `${rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n')}\n`)
}

function executionAxisRuntime(execution) {
  return {
    profile: EXECUTION_AXIS_BOOT_CONFIGURATION.profile,
    execution: { ...execution },
    assurance: EXECUTION_AXIS_BOOT_CONFIGURATION.assurance,
  }
}

function executionAxisRow(ledger, adwId) {
  return ledger.dumpTable('run_configurations').find((row) => row.adw_id === adwId) ?? null
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































































































































// ---------------------------------------------------------------------------
// Shopfloor slice D: request provenance, honest absence, and retirement.
// ---------------------------------------------------------------------------









































































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











// b381 recorded exhibits. These are kept as source rows rather than synthetic
// fixtures so the ingest tests prove the producer's actual JSON shapes.
// Copied from /Users/momoshell/.crew/dt-b371-loopgates/b371-loopgates/journal.jsonl:422.
const B381_PROVIDER_FAILURE_LINE = String.raw`{"at":1788292622004,"headless_outcome":"budget-refused","exit_code":1,"signal":null,"terminal_reason":"api_error","lines":959,"stream":"/Users/momoshell/.crew/dt-b371-loopgates/b371-loopgates/task/headless/d1/stream.jsonl","provider_failure":{"kind":"rate_limit","status":429}}`

// b395 recorded exhibits (#826). Kept as source rows rather than synthetic fixtures so
// the ingest tests prove the producer's actual JSON shape.
// Copied from /Users/momoshell/.crew/dt-b390-mutanchor/b390-mutanchor/journal.jsonl:345.
const B395_SLOT_WAIT_GATE_LINE = String.raw`{"at":1788380185199,"event":"phase-slot-wait","kind":"gate","queue_depth":null,"waited_ms":1,"slotted":true,"channel":"operational"}`
// Copied from /Users/momoshell/.crew/dt-b390-mutanchor/b390-mutanchor/journal.jsonl:2204.
const B395_SLOT_WAIT_WARM_LINE = String.raw`{"at":1788385340219,"event":"phase-slot-wait","kind":"suite-warm","queue_depth":null,"waited_ms":2,"slotted":true,"channel":"operational"}`
// Copied from /Users/momoshell/.crew/dt-b390-mutanchor/b390-mutanchor/journal.jsonl:2207.
const B395_SLOT_WAIT_COLD_LINE = String.raw`{"at":1788385488371,"event":"phase-slot-wait","kind":"suite-cold","queue_depth":null,"waited_ms":1,"slotted":true,"channel":"operational"}`
// Recorded ledger.jsonl lines that PREDATE this change, copied verbatim from
// ~/.dev-team/factory/ledger.jsonl:37160 and :37209. Measured 2026-09-03: that live
// corpus holds 37,238 lines and ZERO recordPhaseSlotWait lines.
const B395_OLD_CORPUS_LINES = [
  String.raw`{"v":1,"kind":"startSession","at":"2026-09-03T08:50:00.652Z","args":{"adw_id":"957dce91-dfb9-4b73-add9-58a58ca61016","repo_slug":"dt-b395-slotwait","task_slug":"b395-slotwait","started_at":"2026-09-03T08:50:00.651Z","ended_at":null,"status":"running","billed_input_tokens":null,"billed_output_tokens":null,"billed_cache_write_tokens":null,"billed_cache_read_tokens":null,"billed_cost_usd":null,"ledger_version":1,"request":null,"request_source":null,"last_heartbeat_at":null,"tier":"build","proposed_shape":"mechanical","proposed_strength":"workhorse"}}`,
  String.raw`{"v":1,"kind":"recordGateResult","at":"2026-09-03T08:52:08.694Z","args":{"adw_id":"c0154d11-e242-47ba-8c17-f7cb3462ab1b","phase_id":482,"gate_name":"gate-baseline","attempt":1,"ok":false,"checks":[{"total":15,"failed":13,"errored":0}],"violations":[],"created_at":"2026-09-03T08:52:08.694Z","gate_generation":1,"pristine":false}}`,
]
// Copied from /Users/momoshell/.crew/dt-b374-loopgates/b374-loopgates/journal.jsonl:218.
const B381_PLAN_SCOPE_LINE = String.raw`{"at":1788293864633,"plan_scope":{"round":1,"verdict":"plan-scope-same","added":[],"dropped":[],"dispatched":8,"planned":8},"channel":"record"}`
// Copied from /Users/momoshell/.crew/dt-b374-loopgates/b374-loopgates/journal.jsonl:1909.
const B381_TIMEOUT_REASK_LINE = String.raw`{"at":1788303101703,"event":"seat-timeout-reask","role":"builder","id":"d6","cause":"timeout","outcome":"failed","spent_ms":2828375,"ceiling_s":2400,"from_return_path":"/Users/momoshell/.crew/dt-b374-loopgates/b374-loopgates/returns/d6.builder.json","to_return_path":"/Users/momoshell/.crew/dt-b374-loopgates/b374-loopgates/returns/d6.retry.builder.json","from_run_id":"d6","to_run_id":null,"failure":"timeout","second":"rpc-timeout","channel":"record"}`
// Copied from /Users/momoshell/.crew/dt-b374-loopgates/b374-loopgates/journal.jsonl:1887.
const B381_RPC_EXIT_LINE = String.raw`{"at":1788303101702,"rpc_exit_context":{"role":"builder","id":"d6","outcome":"timeout","exit_code":143,"exit_signo":15,"exit_signal":"SIGTERM","attribution":"driver-retired","driver_signalled":true,"group_before_signal":"alive","turn_index":5,"frames":189,"last_frame":"response","last_frame_at":1788303101702,"last_tool":"bash","last_tool_at":1788299242622,"exit_seen_at":1788303101702,"exit_gap_ms":0,"stderr_bytes":119,"stderr_tail":"Warning: No project session found with id '44975ae8-15c9-4248-b83d-db399edb76bb'; creating a new session with that id.\n","stderr_truncated":false,"stderr_reason":null}}`
// Copied from /Users/momoshell/.crew/dt-b368-scopesubset/b368-scopesubset/journal.jsonl:4.
const B381_PLAN_ADOPTION_LINE = String.raw`{"at":"2026-09-01T17:34:33.665Z","event":"plan-adopted","task":"b368-scopesubset","lane":"b368-scopesubset","archive":"/Users/momoshell/.crew/dt-b365-scopesubset/b365-scopesubset","source":"/Users/momoshell/.crew/dt-b365-scopesubset/b365-scopesubset/task","plan_sha":"db151a63f9133b26e351a99a1a2b20bcd9a2d724fd540aab8129737f645578bb","files":["plan.md","gate.mjs","plan-check.md"],"findings":true,"adopt_from":"cli"}`
// The full b374 register entry from /Users/momoshell/.crew/batch-2026-09-01-r8/out/dispatch.external.fences.json.
const B381_EXTERNAL_REGISTER = JSON.stringify({ lanes: [{
  lane: 'b374-loopgates',
  files: [
    'crew/drive.mjs', 'crew/drive.test.mjs', 'crew/daemon.test.mjs',
    'crew/io-contract.test.mjs', 'crew/escalation-policy.test.mjs',
    'crew/roles/anchors.json', 'crew/roles/planner.md', 'crew/roles/tech-lead.md',
  ],
  reads: [
    'crew/child.mjs', 'crew/crew.mjs', 'crew/daemon.mjs', 'crew/factoryctl.mjs',
    'crew/headless.mjs', 'crew/limits.mjs', 'crew/protected-paths.mjs',
    'crew/seat-io.mjs', 'crew/variants.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/A-08-run-resolvers.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/B-e5-shape-and-usage.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a1-validate.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a2-matcher.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a3-fence-e2e.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a4-fence-e2e.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a5-directed-mutations.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a6-fs-aliasing.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a7-residual.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/C-a8-constant-drift.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/D-a5-protected-bypass.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/E-probe1.mjs',
    'docs/audits/2026-08-23/hunt/h2/repro/E-probe3.mjs',
    'docs/audits/2026-08-23/hunt/h3/repro/f1-orphaned-issues.mjs',
    'docs/audits/2026-08-23/hunt/h3/repro/f2-acceptfindings-clobber.mjs',
    'docs/audits/2026-08-23/hunt/h3/repro/f3-ungoverned-extra-rounds.mjs',
    'docs/audits/2026-08-23/hunt/h3/repro/f4-unreachable-no-envelope.mjs',
    'docs/audits/2026-08-23/hunt/h3/repro/f5-unreachable-build-exhaustion.mjs',
    'docs/audits/2026-08-23/hunt/h3/repro/f6-pure-helper-defects.mjs',
    'docs/audits/2026-08-23/hunt/h3/repro/harness.mjs',
    'scripts/factory/dispatch-batch.mjs', 'scripts/factory/emit.mjs',
    'scripts/factory/lane-watch.mjs', 'scripts/factory/ledger.mjs',
    'scripts/factory/make-brief.mjs', 'skills/qa-test-writing/anchor-pin.mjs',
    'visualizer/server/journal-source.mjs',
  ].map((file) => ({ file, why: 'compiler reported a coupled source while compiling lane b374-loopgates' })),
}] })

function ingestJournalLine(line, adwId) {
  const ledger = openTestLedger()
  const journalPath = join(nextDir(), 'journal.jsonl')
  writeFileSync(journalPath, `${line}\n`)
  const result = ingestJournal(journalPath, ledger, { adw_id: adwId })
  return { ledger, journalPath, result, dbPath: ledger._dbPath }
}

function journalFactsCli(dbPath, flags = []) {
  const result = run(['journal-facts', ...flags], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}











































function measuredJournalFactsDb() {
  const ledger = openTestLedger({ now: () => Date.parse('2024-01-01T00:00:00.000Z') })
  const at = '2024-01-01T00:00:00.000Z'
  ledger.recordProviderFailure({ adw_id: 'b381-denom', kind: 'rate_limit', status: 429, created_at: at })
  ledger.recordPlanScope({ adw_id: 'b381-denom', round: 1, verdict: 'plan-scope-same', dispatched: 1, planned: 1, created_at: at })
  ledger.recordSeatReask({ adw_id: 'b381-denom', event: 'seat-timeout-reask', outcome: 'failed', created_at: at })
  ledger.recordAcceptReask({ adw_id: 'b381-denom', created_at: at })
  ledger.recordRpcExitContext({ adw_id: 'b381-denom', role: 'builder', outcome: 'timeout', created_at: at })
  ledger.recordPlanAdoption({ lane: 'b381-denom', plan_sha: 'sha', created_at: at })
  ledger.recordExternalFence({ batch_id: 'b381-denom', lane: 'b381-denom', created_at: at })
  ledger.recordMutationAnchorBind({ adw_id: 'b381-denom', gate_generation: 1, declared: 1, exact: 1, normalized: 0, absent: 0, corrected: 0, created_at: at })
  ledger.recordMutationAnchorAbsence({ adw_id: 'b381-denom', gate_generation: 1, check_name: 'B2', correction: 'none', refusal: null, why: 'nowhere', created_at: at })
  const dbPath = ledger._dbPath
  ledger.close()
  return dbPath
}

function assertMeasuredAndAbsent(dbPath, family, denominator, countName) {
  const measured = journalFactsCli(dbPath)
  assert.equal(measured[family].measured, true)
  assert.equal(measured[family][countName], 1)
  assert.equal(measured[family][denominator], 1)
  const absent = journalFactsCli(dbPath, ['--since', '2030-01-01T00:00:00Z', '--until', '2031-01-01T00:00:00Z'])
  assert.equal(absent[family].measured, false)
  assert.equal(absent[family][countName], null)
  assert.equal(absent[family][denominator], null)
  assert.equal(absent[family].absent, 'no rows in this window — not measured, never a measured zero')
  assert.notEqual(absent[family][denominator], 0)
}





















function writeTurnsCorpusJournal(root, name, entries, {
  role = 'builder', transport = 'headless-json', provider = 'anthropic', id = 'claude-sonnet',
} = {}) {
  const lane = join(root, name)
  mkdirSync(lane, { recursive: true })
  const base = Date.parse('2030-01-01T00:00:00.000Z')
  const seat = { agent: 'claude', provider, id, model: `${provider}/${id}`, effort: 'high' }
  const rows = [
    { at: isoMs(base), event: 'boot', roles: [role], seats: { [role]: seat }, transports: { [role]: transport } },
    { at: isoMs(base + 1), event: 'run-start' },
  ]
  entries.forEach(({ turns, status = 'done' }, index) => {
    const dispatchId = `${name}-${index}`
    const censusAt = isoMs(base + 10 + index * 2)
    rows.push({ at: censusAt, seat_turn_census: { role, dispatch_id: dispatchId, transport, turns } })
    rows.push({ at: isoMs(base + 11 + index * 2), envelope: dispatchId, role, status })
  })
  const journal = join(lane, 'journal.jsonl')
  writeFileSync(journal, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return journal
}

function turnsCorpusPayload(root, extra = []) {
  const result = run(['turns', '--crew-root', root, ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function builderTurnRole(payload) {
  const role = payload.by_role.find((entry) => entry.role === 'builder')
  assert.ok(role)
  return role
}



















function holdoutLedger(label) {
  const dir = scratchDir(`planner-symbols-${label}-`)
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const ledger = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  return { dir, dbPath, jsonlPath, ledger }
}

function addHoldoutLane(ledger, index, {
  arm = 'control', fraction = 0.5, turns = 1, distinct_files_read = 1, re_reads = 0,
  review = null, terminal_reason = undefined, roleCensus = null,
} = {}) {
  const adwId = `holdout-${index}`
  const atMs = Date.parse('2030-02-01T00:00:00.000Z') + index * 60_000
  const createdAt = isoMs(atMs)
  ledger.recordExperimentArm({
    adw_id: adwId, role: 'planner', experiment: 'planner-symbols', arm, fraction,
    at_ms: atMs, created_at: createdAt,
  })
  ledger.recordSeatTurnCensus({
    adw_id: adwId, role: 'planner', dispatch_id: `planner-${index}`, transport: 'headless-json',
    turns, distinct_files_read, re_reads, at_ms: atMs + 1, created_at: isoMs(atMs + 1),
  })
  if (roleCensus) {
    ledger.recordSeatTurnCensus({
      adw_id: adwId, role: roleCensus.role || 'builder', dispatch_id: `other-${index}`,
      transport: 'headless-json', turns: roleCensus.turns ?? 99,
      distinct_files_read: roleCensus.distinct_files_read ?? 99, re_reads: roleCensus.re_reads ?? 99,
      at_ms: atMs + 2, created_at: isoMs(atMs + 2),
    })
  }
  if (review !== null) {
    ledger.recordReviewOutcome({
      adw_id: adwId, dispatch_id: `review-${index}`, role: 'reviewer', verdict: review,
      created_at: isoMs(atMs + 3),
    })
  }
  if (terminal_reason !== undefined) {
    ledger.startSession({ adw_id: adwId, repo_slug: 'holdout', task_slug: adwId, started_at: isoMs(atMs - 1) })
    ledger.endSession({
      adw_id: adwId, status: 'fail', outcome: 'failed', terminal_reason,
      ended_at: isoMs(atMs + 4),
    })
  }
  return adwId
}

function holdoutRows(report) {
  assert.deepEqual(report.arms, [...PLANNER_SYMBOLS_ARMS])
  assert.deepEqual(report.metrics, ['turns', 'distinct_files_read', 're_reads', 'first_round_plan_acceptance'])
  return report.rows
}

























const TRIAGE_MODEL = 'triage-model-exact'

function makeTriageFixture({ id, ledger, where = 'mystery', why = 'the run stopped without a rule', streamEvidence = 'stream evidence', returnMarker = `${id}-return` } = {}) {
  const dir = scratchDir(`escalation-${id}-`)
  mkdirSync(join(dir, 'returns'), { recursive: true })
  mkdirSync(join(dir, 'task', 'headless', 'd1'), { recursive: true })
  writeFileSync(join(dir, 'returns', 'task.json'), JSON.stringify({
    assignment_id: id,
    status: 'escalation',
    summary: returnMarker,
    details: { escalation: { where, why } },
  }))
  writeFileSync(join(dir, 'journal.jsonl'), [
    { event: 'run-start', run_id: id, task: id },
    { event: 'escalation-evidence', detail: `${id}-journal-marker` },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(dir, 'task', 'headless', 'd1', 'stream.jsonl'), [
    { type: 'assistant', text: streamEvidence },
    { type: 'result', terminal_reason: 'budget-exhausted', detail: streamEvidence },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  ledger.startSession({ adw_id: id, repo_slug: 'test', task_slug: id })
  ledger.endSession({
    adw_id: id, status: 'fail', outcome: 'escalated', terminal_reason: ESCALATION_CAUSE_UNCLASSIFIED,
    terminal_actor: 'driver',
  })
  return dir
}

function triageLedger(prefix = 'triage-ledger-') {
  const dir = scratchDir(prefix)
  const ledger = openLedger({ dbPath: join(dir, 'ledger.db'), stderr: { write() {} } })
  return { dir, ledger }
}

function triageResponse(cause = 'budget', evidence = 'measured budget exhaustion in the durable stream tail') {
  return { ok: true, status: 200, json: async () => ({ proposed_cause: cause, evidence }) }
}















// ---------------------------------------------------------------------------
// Screener proposal adoption readout
// ---------------------------------------------------------------------------

export {
  NONCE_PREFIX, SCRIPT, require, SQLITE_OK, SKIP, bootTieredRun, bootBriefRun, fixture, paneReviewRun, spawnedChildren, trackChild, nextDir, run, openTestLedger, openB499Ledger, seedCellUsage, makeUnenforcedSeatIndexDb, exerciseEveryWriter, seedTaskAgentSession, MARKER_ADW, seedAllWritersWithMarker, MARKER_PLAIN, MARKER_NONCE_ONLY, CALIBRATED_RENDEZVOUS_DELAY_MS, CALIBRATED_RENDEZVOUS_DELAYS_MS, resolveRendezvousDelayMs, waitForEmitterReady, runConcurrentEmitterTrial, RUNSET_SINCE, RUNSET_UNTIL, seedRun, seedConfigurationRun, seedConfigurationSeat, EXECUTION_AXIS_BOOT_CONFIGURATION, executionAxisState, writeExecutionAxisCrew, writeExecutionAxisJournal, executionAxisRuntime, executionAxisRow, readerFixture, ADVISOR_AB_EPOCH, advisorAbFixture, advisorAbEnvelope, advisorAbFinding, runAdvisorAb, advisorReasons, advisorNote, SANDBOX_LEDGER_URL, SANDBOX_DEFAULT_RESOLVER, runSandboxChild, B381_PROVIDER_FAILURE_LINE, B395_SLOT_WAIT_GATE_LINE, B395_SLOT_WAIT_WARM_LINE, B395_SLOT_WAIT_COLD_LINE, B395_OLD_CORPUS_LINES, B381_PLAN_SCOPE_LINE, B381_TIMEOUT_REASK_LINE, B381_RPC_EXIT_LINE, B381_PLAN_ADOPTION_LINE, B381_EXTERNAL_REGISTER, ingestJournalLine, journalFactsCli, measuredJournalFactsDb, assertMeasuredAndAbsent, writeTurnsCorpusJournal, turnsCorpusPayload, builderTurnRole, holdoutLedger, addHoldoutLane, holdoutRows, TRIAGE_MODEL, makeTriageFixture, triageLedger, triageResponse,
}

test('chunk CLI chunk-progress prints parent progress and refuses unknown flags', () => {
  const ledger = openTestLedger()
  ledger.recordChunkRun({ parentLane: 'cli-p', chunkId: 'c1', lane: 'cli-p-c1', wave: 0, checksOwned: ['A1', 'A2'] })
  const dbPath = ledger._dbPath
  const env = { ...process.env, DEVTEAM_LEDGER_DB: dbPath }
  const ok = spawnSync(process.execPath, [SCRIPT, 'chunk-progress', 'cli-p'], { env, encoding: 'utf8' })
  assert.equal(ok.status, 0)
  const payload = JSON.parse(ok.stdout)
  assert.equal(payload.parent_lane, 'cli-p')
  assert.equal(payload.chunks_total, 1)
  assert.equal(payload.chunks[0].owned_total, 2)
  assert.equal(payload.chunks[0].owned_green, null)
  assert.equal(payload.chunks[0].reason, 'chunk-lane-unbooted')
  const bad = spawnSync(process.execPath, [SCRIPT, 'chunk-progress', 'cli-p', '--bogus', 'x'], { env, encoding: 'utf8' })
  assert.equal(bad.status, 2)
  ledger.close()
})
