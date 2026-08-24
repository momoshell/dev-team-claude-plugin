import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INTAKE_REFUSAL_REASONS, INTAKE_WINDOW_MS, defaultCellWindow, defaultIntakeWindow, defaultRunSetWindow, RUN_SET_WINDOW_MS, shapeCellHealth, shapeGateChecks, shapeIntake, shapeRunSet, shapeRun, foldAgents, laneFor, matchesFilters, ROLE_ORDER, withCells } from '../visualizer/server/shape.mjs'
import { startServer } from '../visualizer/server/server.mjs'
import { drainEvents, createDrainQueue } from '../visualizer/web/src/lib/drain.js'
import { layoutTimeline, MIN_WIDTH, QUEUED_WIDTH } from '../visualizer/web/src/lib/timeline.js'
import { diffEnvelopes, attemptPairs } from '../visualizer/web/src/lib/envelope-diff.js'
import { INTAKE_REFUSALS, NODE_FLOOR, openLedger, USAGE_ABSENT_CAUSES } from '../scripts/factory/ledger.mjs'
import { emitAdapter } from '../crew/seat-io.mjs'

const require = createRequire(import.meta.url)
function sqliteAvailable() { try { require('node:sqlite'); return true } catch { return false } }
const SQLITE_SKIP = sqliteAvailable() ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`

const start = '2024-01-01T00:00:00.000Z'
const end = '2024-01-01T00:00:02.000Z'
const base = { adw_id: 'x', task_slug: 'task', repo_slug: 'repo', status: 'running', started_at: start, ended_at: null,
  billed_cost_usd: null, billed_input_tokens: null, billed_output_tokens: null, billed_cache_write_tokens: null, billed_cache_read_tokens: null }
const missingProbe = { missing: ['mode', 'engineer'], latched: false, probes: 1 }
// The pending floor is a LITERAL here, never Object.keys(run.pending): a loop over
// the implementation's own output cannot notice that output shrinking (#476 V8).
// MUTATION V8: derive this set from shapeRun's own output and a removed marker is
// invisible again.
const PENDING_FIELDS = ['accept_decisions', 'billed_cache_read_tokens', 'billed_cache_write_tokens', 'billed_cost_usd', 'billed_input_tokens', 'billed_output_tokens', 'engineer', 'gate_checks', 'gate_discrimination', 'gate_generations', 'last_heartbeat_at', 'mode', 'phase_lanes', 'read_tokens', 'reviews', 'tier', 'written_tokens']
// Deliberately NEWEST-FIRST: the generation sort is load-bearing only when input
// order and generation order disagree (#476 V9).
// MUTATION V9: pre-sort this fixture ascending and the sort stops being exercised.
const GATE_GENERATIONS_NEWEST_FIRST = [
  { gate_generation: 2, verdict: 'proven', checks_total: 2 },
  { gate_generation: 1, verdict: 'failed', checks_total: 2 },
]
const b52Events = [
  ['agent_start', { role: 'planner', dispatch_id: 'd1' }],
  ['agent_end', { role: 'planner', outcome: 'done', dispatch_id: 'd1' }],
  ['agent_start', { role: 'builder', dispatch_id: 'd2' }],
  ['agent_end', { role: 'builder', outcome: 'no-envelope', dispatch_id: 'd2' }],
  ['agent_start', { role: 'planner', dispatch_id: 'd1' }],
  ['agent_end', { role: 'planner', outcome: 'insufficient', dispatch_id: 'd1' }],
  ['agent_start', { role: 'lead', dispatch_id: 'd2' }],
  ['agent_end', { role: 'lead', outcome: 'done', dispatch_id: 'd2' }],
  ['agent_start', { role: 'planner', dispatch_id: 'd3' }],
  ['agent_end', { role: 'planner', outcome: 'done', dispatch_id: 'd3' }],
  ['agent_start', { role: 'lead', dispatch_id: 'd4' }],
  ['agent_end', { role: 'lead', outcome: 'insufficient', dispatch_id: 'd4' }],
].map(([type, payload], index) => ({ id: 4488 + index, type, payload_json: JSON.stringify(payload), started_at: null, ended_at: null }))

function allFiles(path, output = []) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory() && entry.name !== 'dist' && entry.name !== 'node_modules') allFiles(child, output)
    else if (entry.isFile()) output.push(child)
  }
  return output
}

test('shapeRun has an identical card key set for live and finished runs', () => {
  const live = shapeRun(base, [], [], null, missingProbe, Date.parse(end))
  const finished = shapeRun({ ...base, status: 'ok', ended_at: end }, [], [], null, missingProbe, Date.parse('2025-01-01'))
  assert.deepEqual(Object.keys(live).sort(), Object.keys(finished).sort())
  assert.equal(live.duration_ms, 2000)
  assert.equal(finished.duration_ms, 2000)
  assert.equal(live.running, true)
  assert.equal(finished.running, false)
})

test('every unmeasured field is null and has a non-empty pending reason', () => {
  const run = shapeRun(base, [], [], null, missingProbe, Date.parse(end))
  for (const field of Object.keys(run.pending)) {
    const value = field in run.metrics ? run.metrics[field] : run[field]
    assert.equal(value, null, `${field} must never be fabricated`)
    assert.equal(typeof run.pending[field], 'string')
    assert.ok(run.pending[field].length > 0)
    assert.notEqual(run.pending[field], 0)
  }
  for (const field of PENDING_FIELDS) assert.ok(field in run.pending, `${field} lost its pending reason`)
  assert.equal(run.metrics.read_tokens, null)
  assert.equal(run.metrics.written_tokens, null)
})

test('shapeRun aggregates billed token totals from agent sessions', () => {
  const run = shapeRun({ ...base, billed_input_tokens: 999, billed_output_tokens: 999 }, [], [], null, {}, Date.parse(end), {
    agentSessions: [
      { billed_input_tokens: 10, billed_output_tokens: 4, billed_cache_write_tokens: 2, billed_cache_read_tokens: 1 },
      { billed_input_tokens: 5, billed_output_tokens: 6, billed_cache_write_tokens: 3, billed_cache_read_tokens: 7 },
    ],
  })
  assert.equal(run.metrics.billed_input_tokens, 15)
  assert.equal(run.metrics.billed_output_tokens, 10)
  assert.equal(run.metrics.billed_cache_write_tokens, 5)
  assert.equal(run.metrics.billed_cache_read_tokens, 8)
})

test('shapeRun honors pre-119 session token fallbacks without agent rows', () => {
  const run = shapeRun({ ...base, billed_input_tokens: 12 }, [], [], null, {}, Date.parse(end))
  assert.equal(run.metrics.billed_input_tokens, 12)
  assert.equal(run.pending.billed_input_tokens, undefined)
})

test('shapeRun leaves all billed token fields null when no source measured them', () => {
  const run = shapeRun(base, [], [], null, {}, Date.parse(end))
  for (const field of ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']) {
    assert.equal(run.metrics[field], null)
    assert.notEqual(run.metrics[field], 0)
    assert.match(run.pending[field], /predates/i)
  }
})

test('shapeRun never derives a billed money value', () => {
  const run = shapeRun({ ...base, billed_input_tokens: 1000000 }, [], [], null, {}, Date.parse(end), {
    agentSessions: [{ billed_input_tokens: 1000000 }],
  })
  assert.equal(run.metrics.billed_cost_usd, null)
  assert.ok(run.pending.billed_cost_usd)
})

test('shapeRun keeps gate generations and selects the newest verdict', () => {
  const run = shapeRun(base, [], [], null, {}, Date.parse(end), {
    gateDiscriminations: [...GATE_GENERATIONS_NEWEST_FIRST],
  })
  assert.equal(run.gate_generations.length, 2)
  assert.equal(run.gate_discrimination, 'proven')
  assert.deepEqual(run.gate_generations.map((row) => row.gate_generation), [1, 2])
})

test('shapeRun leaves absent gate measurements null and pending', () => {
  const run = shapeRun(base, [], [], null, {}, Date.parse(end))
  assert.equal(run.gate_discrimination, null)
  assert.equal(run.gate_generations, null)
  assert.ok(run.pending.gate_discrimination)
  assert.notEqual(run.pending.gate_discrimination, 'failed')
  assert.notEqual(run.pending.gate_discrimination, 'unproven')
})

test('shapeRun maps review outcomes and preserves null counts', () => {
  const run = shapeRun(base, [], [], null, {}, Date.parse(end), {
    reviewOutcomes: [{ dispatch_id: 'd1', role: 'reviewer', verdict: 'changes-needed', must_fix: null }],
  })
  assert.equal(run.reviews.length, 1)
  assert.equal(run.reviews[0].must_fix, null)
  const absent = shapeRun(base, [], [], null, {}, Date.parse(end))
  assert.equal(absent.reviews, null)
  assert.ok(absent.pending.reviews)
})

test('shapeRun maps accept decisions in ledger order and normalizes empty diagnostics', () => {
  const run = shapeRun(base, [], [], null, {}, Date.parse(end), {
    acceptDecisions: [
      { where_at: 'review-exhausted', outcome: 'accepted', findings_total: 2, residual_count: null, refuted_count: 1, cosmetic_count: 0, unverified_count: 1, invalid_reasons: '', created_at: '2024-01-01T00:00:03.000Z' },
      { where_at: 'review-exhausted', outcome: 'escalated', findings_total: 2, residual_count: 1, refuted_count: 1, cosmetic_count: 0, unverified_count: 0, invalid_reasons: 'f1: still open', created_at: '2024-01-01T00:00:04.000Z' },
    ],
  })
  assert.deepEqual(run.accept_decisions.map((row) => row.created_at), ['2024-01-01T00:00:03.000Z', '2024-01-01T00:00:04.000Z'])
  assert.equal(run.accept_decisions[0].outcome, 'accepted')
  assert.equal(run.accept_decisions[0].residual_count, null)
  assert.equal(run.accept_decisions[0].invalid_reasons, null)
  assert.equal(run.accept_decisions[1].invalid_reasons, 'f1: still open')
})

test('shapeRun distinguishes missing and present-empty accept measurements', () => {
  const missing = shapeRun(base, [], [], null, { missing: ['accept_decisions'] }, Date.parse(end), { acceptDecisions: [] })
  assert.equal(missing.accept_decisions, null)
  assert.equal(missing.pending.accept_decisions, 'predates this measurement')
  const present = shapeRun(base, [], [], null, { missing: [] }, Date.parse(end), { acceptDecisions: [] })
  assert.equal(present.accept_decisions, null)
  assert.ok(present.pending.accept_decisions)
  assert.notEqual(present.pending.accept_decisions, 'predates this measurement')
})

test('shapeRun uses the NULL probe wording for missing new measurements', () => {
  const run = shapeRun(base, [], [], null, { missing: ['billed_input_tokens', 'gate_discrimination', 'reviews'] }, Date.parse(end))
  assert.equal(run.pending.billed_input_tokens, 'predates this measurement')
  assert.equal(run.pending.gate_discrimination, 'predates this measurement')
  assert.equal(run.pending.reviews, 'predates this measurement')
})

test('real emitted events leave phase lanes honestly unavailable, while linked events resolve', () => {
  const phases = [{ id: 1, seq: 1, name: 'plan', status: 'ok', started_at: start, ended_at: end }]
  const emitted = [{ type: 'agent_start', phase_id: null, payload_json: JSON.stringify({ role: 'planner', dispatch_id: 'd1' }), started_at: start }]
  const honest = shapeRun(base, phases, emitted, null, missingProbe, Date.parse(end))
  assert.equal(honest.phases[0].lane, null)
  assert.equal(honest.phase_lanes, null)
  assert.equal(typeof honest.pending.phase_lanes, 'string')
  assert.notEqual(honest.phases[0].lane, 0)
  const stale = shapeRun(base, phases, [{ ...emitted[0], phase_id: 99 }], null, missingProbe, Date.parse(end))
  assert.equal(stale.phases[0].lane, null)
  assert.equal(typeof stale.pending.phase_lanes, 'string')
  const linked = shapeRun(base, phases, [{ ...emitted[0], phase_id: 1 }], null, missingProbe, Date.parse(end))
  assert.equal(linked.phases[0].lane, laneFor('planner'))
  assert.equal(linked.phase_lanes, 'agent')
  assert.equal(linked.pending.phase_lanes, undefined)
})

test('foldAgents gap-fills starts and closes lanes on end', () => {
  const started = [{ type: 'agent_start', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'open' }), started_at: start }]
  assert.deepEqual(foldAgents(started)[0], { key: 'open#1', dispatch_id: 'open', role: 'builder', lane: laneFor('builder'), outcome: null, started_at: start, ended_at: null })
  const closed = foldAgents([...started, { type: 'agent_end', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'open', outcome: 'done' }), started_at: end }])[0]
  assert.equal(closed.outcome, 'done')
  assert.equal(closed.ended_at, end)
})

test('foldAgents splits two assignments that share a dispatch id and never relabels a row', () => {
  const rows = foldAgents(b52Events)
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map((row) => `${row.dispatch_id}/${row.role}/${row.outcome}`), [
    'd1/planner/done', 'd2/builder/no-envelope', 'd1/planner/insufficient',
    'd2/lead/done', 'd3/planner/done', 'd4/lead/insufficient',
  ])
  assert.equal(new Set(rows.map((row) => row.key)).size, 6)
  assert.ok(rows.every((row) => typeof row.key === 'string' && row.key.length > 0))
})

test('foldAgents keeps unique ids together and preserves the start role and lane', () => {
  const unique = foldAgents([
    { type: 'agent_start', payload_json: JSON.stringify({ role: 'planner', dispatch_id: 'u1' }), started_at: start },
    { type: 'agent_end', payload_json: JSON.stringify({ role: 'planner', outcome: 'done', dispatch_id: 'u1' }), ended_at: end },
    { type: 'agent_start', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'u2' }), started_at: start },
    { type: 'agent_end', payload_json: JSON.stringify({ role: 'builder', outcome: 'done', dispatch_id: 'u2' }), ended_at: end },
    { type: 'agent_start', payload_json: JSON.stringify({ role: 'reviewer', dispatch_id: 'u3' }), started_at: start },
    { type: 'agent_end', payload_json: JSON.stringify({ role: 'reviewer', outcome: 'done', dispatch_id: 'u3' }), ended_at: end },
  ])
  assert.equal(unique.length, 3)
  assert.deepEqual(unique.map((row) => row.dispatch_id), ['u1', 'u2', 'u3'])
  const mismatch = foldAgents([
    { type: 'agent_start', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'mismatch' }), started_at: start },
    { type: 'agent_end', payload_json: JSON.stringify({ role: 'lead', outcome: 'done', dispatch_id: 'mismatch' }), ended_at: end },
  ])[0]
  assert.equal(mismatch.role, 'builder')
  assert.equal(mismatch.lane, laneFor('builder'))
})

test('withCells attributes reused dispatch cells by role and keeps roleless fallback', () => {
  const rows = withCells(foldAgents(b52Events), [
    { dispatch_id: 'd2', role: 'builder', model: 'openai-codex/gpt-5.6-luna' },
    { dispatch_id: 'd3', model: 'model/live' },
  ])
  const builder = rows.find((row) => row.dispatch_id === 'd2' && row.role === 'builder')
  const lead = rows.find((row) => row.dispatch_id === 'd2' && row.role === 'lead')
  const roleless = rows.find((row) => row.dispatch_id === 'd3')
  assert.equal(builder.model, 'openai-codex/gpt-5.6-luna')
  assert.equal(builder.model_pending, null)
  assert.equal(lead.model, null)
  assert.match(lead.model_pending, /role/)
  assert.equal(roleless.model, 'model/live')
  assert.equal(roleless.model_pending, null)
})

test('laneFor follows the ratified role order and folds unknown roles into stable spare lanes', () => {
  assert.deepEqual([...ROLE_ORDER], ['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver'])
  ROLE_ORDER.forEach((role, index) => assert.equal(laneFor(role), index))
  const unknown = laneFor('nobody')
  assert.ok(unknown >= 6)
  assert.equal(unknown, laneFor('nobody'))
})

test('shapeRun surfaces a recorded tier and keeps an unmeasured row unmeasured', () => {
  const now = Date.parse('2024-01-01T00:02:00.000Z')
  const measured = shapeRun({ ...base, tier: 'build' }, [], [], null, missingProbe, now)
  assert.equal(measured.tier, 'build')
  assert.equal(measured.pending.tier, undefined)
  const unmeasured = shapeRun(base, [], [], null, missingProbe, now)
  assert.equal(unmeasured.tier, null)
  assert.match(unmeasured.pending.tier, /^not measured/)
})

test('shapeRun keeps tier and heartbeat absent until their sources measure them', () => {
  const now = Date.parse('2024-01-01T00:02:00.000Z')
  const absent = shapeRun(base, [], [], null, missingProbe, now)
  assert.equal(absent.tier, null)
  assert.ok(absent.pending.tier)
  assert.equal(absent.last_heartbeat_at, null)
  assert.equal(absent.heartbeat_age_ms, null)
  assert.ok(absent.pending.last_heartbeat_at)
  const latest = '2024-01-01T00:01:56.000Z'
  const measured = shapeRun(base, [], [], null, missingProbe, now, {
    agentSessions: [{ last_heartbeat_at: '2024-01-01T00:01:00.000Z' }, { last_heartbeat_at: latest }],
  })
  assert.equal(measured.last_heartbeat_at, latest)
  assert.equal(measured.heartbeat_age_ms, 4000)
  assert.equal(measured.pending.last_heartbeat_at, undefined)
})

test('theme role and lane aliases follow the ratified role order', () => {
  const css = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/theme.css'), 'utf8')
  for (const [index, role] of ROLE_ORDER.entries()) {
    assert.match(css, new RegExp(`--role-${role}\\s*:`))
    assert.match(css, new RegExp(`--lane-${index}\\s*:\\s*var\\(\\s*--role-${role}\\s*\\)`))
  }
})

test('matchesFilters covers mode, status, since, until and pending mode', () => {
  const pending = shapeRun(base, [], [], null, missingProbe, Date.parse(end))
  assert.equal(matchesFilters(pending, { mode: '' }), true)
  assert.equal(matchesFilters(pending, { mode: 'shop-floor' }), false)
  const complete = shapeRun({ ...base, status: 'ok', ended_at: end, mode: 'batch' }, [], [], null, { missing: ['engineer'] }, Date.parse(end))
  assert.equal(matchesFilters(complete, { mode: 'batch', status: 'ok', since: '2023-12-31', until: '2024-01-02' }), true)
  assert.equal(matchesFilters(complete, { mode: 'other' }), false)
  assert.equal(matchesFilters(complete, { status: 'running' }), false)
  assert.equal(matchesFilters(complete, { since: '2024-01-02' }), false)
  assert.equal(matchesFilters(complete, { until: '2024-01-01' }), false)
})

test('shapeCellHealth folds kinds into one cell and keeps run-less separate', () => {
  const result = shapeCellHealth({
    rows: [
      { provider: 'anthropic', model_id: 'cell', agent: 'claude', effort: 'high', role: 'planner', kind: 'boot-refusal', failures: 1, run_less: 1, first_at: '2024-01-01T00:00:00.000Z', last_at: '2024-01-01T00:00:00.000Z' },
      { provider: 'anthropic', model_id: 'cell', agent: 'claude', effort: 'high', role: 'builder', kind: 'timeout', failures: 1, run_less: 0, first_at: '2024-01-02T00:00:00.000Z', last_at: '2024-01-02T00:00:00.000Z' },
    ],
    roster: { tiers: [] }, since: start, until: null, label: 'last 7 days',
  })
  assert.equal(result.cells.length, 1)
  const cell = result.cells[0]
  assert.equal(cell.failures, 2)
  assert.equal(cell.run_less, 1)
  assert.equal(cell.in_run, 1)
  assert.deepEqual(cell.by_kind.map((kind) => kind.kind), ['boot-refusal', 'timeout'])
  assert.deepEqual(cell.roles, ['builder', 'planner'])
})

test('shapeCellHealth carries host-attributed failures and floors counted at zero', () => {
  const result = shapeCellHealth({
    rows: [
      { provider: 'openai', model_id: 'hosted', agent: 'pi', effort: 'max', role: 'planner', kind: 'timeout', failures: 4, run_less: 1, host_attributed: 1 },
      { provider: 'openai', model_id: 'floor', agent: 'pi', effort: 'max', role: 'planner', kind: 'timeout', failures: 1, run_less: 2, host_attributed: 1 },
    ],
    roster: { tiers: [] }, since: start, until: null, label: 'last 7 days',
  })
  const hosted = result.cells.find((cell) => cell.model_id === 'hosted')
  const floor = result.cells.find((cell) => cell.model_id === 'floor')
  assert.deepEqual({ host_attributed: hosted.host_attributed, counted: hosted.counted }, { host_attributed: 1, counted: 2 })
  assert.equal(floor.counted, 0)
  assert.equal(hosted.by_kind[0].host_attributed, 1)
})

test('shapeCellHealth marks a cell whose every failure is run-less', () => {
  const result = shapeCellHealth({
    rows: [{ provider: 'openai', model_id: 'cell', agent: 'pi', effort: 'max', role: 'reviewer', kind: 'no-envelope', failures: 2, run_less: 2 }],
    roster: { tiers: [] }, since: start, until: null, label: 'last 7 days',
  })
  assert.equal(result.cells[0].state, 'run-less-only')
})

test('shapeCellHealth reports a seated cell with no rows as silent, not healthy', () => {
  const result = shapeCellHealth({
    rows: [],
    roster: { tiers: [{ tier: 'build', seats: [{ role: 'builder', provider: 'openai', id: 'quiet', agent: 'pi', effort: 'max' }] }] },
    since: start, until: null, label: 'last 7 days',
  })
  assert.equal(result.cells.length, 1)
  assert.equal(result.cells[0].state, 'silent')
  assert.doesNotMatch(JSON.stringify(result), /"(verdict|open|closed|healthy|threshold)"/i)
})

test('shapeCellHealth refuses to render zeros for an absent table', () => {
  const result = shapeCellHealth({ rows: null, absent: 'cell_failures predates this ledger mirror', roster: { tiers: [] }, since: start, until: null, label: 'last 7 days' })
  assert.deepEqual(result.cells, [])
  assert.equal(result.absent, 'cell_failures predates this ledger mirror')
  assert.doesNotMatch(JSON.stringify(result), /"(failures|run_less|in_run)":\s*0/)
})

test('shapeRunSet never fabricates a zero for an unmeasured window', () => {
  const result = shapeRunSet({
    rows: [
      { ...base, agent_sessions: 0 },
      { ...base, adw_id: 'y', status: 'aborted', agent_sessions: 0 },
    ],
    since: start, until: end, label: 'last 24 hours',
  })
  assert.equal(result.usage, null)
  assert.ok(result.unmeasured.usage)
  assert.equal(result.coverage.measured, 0)
  assert.equal(result.coverage.total, 2)
  assert.doesNotMatch(JSON.stringify(result), /"billed_[a-z_]+":\s*0/)
})

test('shapeRunSet uses the ledger transport wording for unmeasured usage', () => {
  for (const [transports, cause] of [
    [['pane'], USAGE_ABSENT_CAUSES.pane],
    [['pane', 'headless-rpc'], USAGE_ABSENT_CAUSES.measured_transport],
    [[], USAGE_ABSENT_CAUSES.transport_unrecorded],
  ]) {
    const result = shapeRunSet({ rows: [{ ...base, agent_sessions: 0 }], transports, since: start, until: end, label: 'last 24 hours' })
    assert.equal(result.unmeasured.usage, `no run in this window has an agent_sessions row: ${cause}`)
    assert.doesNotMatch(JSON.stringify(result), /predates per-agent token measurement/)
  }
})

test('shapeRunSet distinguishes active agent sessions with no billed totals', () => {
  const result = shapeRunSet({
    rows: [{ ...base, agent_sessions: 1 }],
    since: start, until: end, label: 'last 24 hours',
  })
  assert.deepEqual(result.usage, {
    agent_sessions: 1,
    billed_input_tokens: null,
    billed_output_tokens: null,
    billed_cache_write_tokens: null,
    billed_cache_read_tokens: null,
  })
  assert.equal(result.coverage.measured, 0)
  assert.match(result.unmeasured.usage, /one or more runs in this window:/)
  assert.doesNotMatch(result.unmeasured.usage, /no agent_sessions rows/)
})

test('shapeRunSet sums only the measured runs and states its coverage', () => {
  const result = shapeRunSet({
    rows: [
      { ...base, agent_sessions: 2, billed_input_tokens: 10, billed_output_tokens: 4, billed_cache_write_tokens: 2, billed_cache_read_tokens: 1 },
      { ...base, adw_id: 'y', status: 'aborted', agent_sessions: 0 },
    ],
    since: start, until: end, label: 'last 24 hours',
  })
  assert.deepEqual(result.usage, { agent_sessions: 2, billed_input_tokens: 10, billed_output_tokens: 4, billed_cache_write_tokens: 2, billed_cache_read_tokens: 1 })
  assert.deepEqual(result.coverage, { measured: 1, total: 2 })
  assert.ok(result.unmeasured.usage)
})

test('shapeRunSet reports an empty window as a measured zero', () => {
  const result = shapeRunSet({ rows: [], since: start, until: end, label: 'last 24 hours' })
  assert.deepEqual(result.settled, { running: 0, ok: 0, fail: 0, aborted: 0 })
  assert.equal(result.usage, null)
  assert.equal(result.unmeasured.usage, undefined)
  assert.ok(result.unmeasured.parked)
})

test('shapeRunSet reports an absent readout as unanswerable, not empty', () => {
  const result = shapeRunSet({ rows: null, absent: 'sessions predates this ledger mirror', since: start, until: end, label: 'last 24 hours' })
  assert.equal(result.runs, null)
  assert.deepEqual(result.rows, [])
  assert.doesNotMatch(JSON.stringify(result), /"runs":\s*0/)
})

test('shapeRunSet marks a degraded ledger read absent instead of a measured zero', () => {
  const result = shapeRunSet({
    rows: [], degraded: true, degraded_reason: 'ERR_SQLITE_ERROR',
    since: start, until: end, label: 'last 24 hours',
  })
  assert.equal(result.degraded, true)
  assert.equal(result.degraded_reason, 'ERR_SQLITE_ERROR')
  assert.match(result.absent, /ERR_SQLITE_ERROR/)
  assert.equal(result.runs, null)
  assert.equal(result.settled, null)
  assert.deepEqual(result.rows, [])
  assert.doesNotMatch(JSON.stringify(result), /"runs":\s*0/)
})

test('shapeRunSet keeps a healthy zero-run window a measured zero', () => {
  const result = shapeRunSet({
    rows: [], degraded: false, degraded_reason: null,
    since: start, until: end, label: 'last 24 hours',
  })
  assert.equal(result.absent, null)
  assert.equal(result.degraded, false)
  assert.equal(result.degraded_reason, null)
  assert.equal(result.runs, 0)
  assert.deepEqual(result.settled, { running: 0, ok: 0, fail: 0, aborted: 0 })
})

test('shapeRunSet marks a degraded ledger read absent with the flag read after the query', { skip: SQLITE_SKIP }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'degraded-run-set-'))
  const dbPath = join(temp, 'ledger.db')
  writeFileSync(dbPath, 'this file is not a sqlite database')
  let ledger = null
  try {
    ledger = openLedger({ dbPath, stderr: { write: () => true } })
    assert.equal(ledger.stats().degraded, false)
    const rows = ledger.runSet({ since: start })
    const after = ledger.stats()
    assert.deepEqual(rows, [])
    assert.equal(after.degraded, true)
    assert.equal(after.degraded_reason, 'ERR_SQLITE_ERROR')
    const result = shapeRunSet({
      rows, degraded: after.degraded, degraded_reason: after.degraded_reason,
      since: start, until: end, label: 'last 24 hours',
    })
    assert.ok(result.absent.includes(after.degraded_reason))
    assert.equal(result.runs, null)
    assert.doesNotMatch(JSON.stringify(result), /"runs":\s*0/)
  } finally {
    try { ledger?.close() } finally { rmSync(temp, { recursive: true, force: true }) }
  }
})

test('the run-set route reads the feed degraded flag after the query it reports on', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/server/server.mjs'), 'utf8')
  const routeStart = source.indexOf("if (url.pathname === '/api/run-set')")
  const routeEnd = source.indexOf("if (url.pathname === '/api/", routeStart + 1)
  assert.ok(routeStart >= 0)
  assert.ok(routeEnd > routeStart)
  const route = source.slice(routeStart, routeEnd)
  assert.match(route, /degraded: runSetHealth\?\.degraded === true/)
  assert.match(route, /degraded_reason: runSetReason/)
  assert.ok(route.indexOf('feed.runSet(') < route.indexOf('feed.health()'))
})

test('the run-set route keeps healthy ledger rows measured when triage is degraded', async () => {
  const calls = []
  const feed = {
    runSet: () => { calls.push('runSet'); return { rows: [{ status: 'ok' }] } },
    health: () => { calls.push('health'); return { degraded: true } },
    _reason: () => { calls.push('reason'); return null },
    budgetWindow: () => ({ measured: false, total: null, sessions: null, absent: 'not measured in this fixture' }),
    close: () => {},
  }
  const { server } = startServer({ feed, port: 0, host: '127.0.0.1' })
  let listening = false
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
    })
    listening = true
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/api/run-set?since=${encodeURIComponent(start)}&until=${encodeURIComponent(end)}`)
    const result = await response.json()
    assert.equal(response.status, 200)
    assert.equal(result.absent, null)
    assert.equal(result.degraded, false)
    assert.equal(result.degraded_reason, null)
    assert.equal(result.runs, 1)
    assert.deepEqual(result.settled, { running: 0, ok: 1, fail: 0, aborted: 0 })
    assert.deepEqual(calls.slice(0, 3), ['runSet', 'health', 'reason'])
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve))
  }
})

test('defaultRunSetWindow states a 24-hour open-ended window', () => {
  const now = Date.parse('2024-01-08T00:00:00.000Z')
  const result = defaultRunSetWindow(now)
  assert.equal(result.until, null)
  assert.equal(Date.parse(result.since), now - RUN_SET_WINDOW_MS)
  assert.ok(result.label)
})

test('shapeCellHealth cannot enumerate silent cells without a roster', () => {
  const result = shapeCellHealth({ rows: [], roster: { tiers: null, error: 'unreadable' }, since: start, until: null, label: 'last 7 days' })
  assert.equal(result.silent_unknown, 'unreadable')
  assert.equal(result.cells.some((cell) => cell.state === 'silent'), false)
})

test('defaultCellWindow states a seven-day trailing window', () => {
  const now = Date.parse('2024-01-08T00:00:00.000Z')
  const result = defaultCellWindow(now)
  assert.equal(result.since, '2024-01-01T00:00:00.000Z')
  assert.equal(result.until, null)
  assert.ok(result.label)
})

test('drainEvents exhausts pages, stops stalled cursors, and reports max-page truncation', async () => {
  const source = Array.from({ length: 201 }, (_, i) => ({ id: i + 1 }))
  const fetchPage = async (after, limit) => {
    const events = source.filter((event) => event.id > after).slice(0, limit)
    return { events, cursor: events.length ? events.at(-1).id : after }
  }
  const drained = await drainEvents(fetchPage, { limit: 100 })
  assert.equal(drained.events.length, 201)
  assert.equal(new Set(drained.events.map((event) => event.id)).size, 201)
  assert.equal(drained.truncated, false)
  const stalled = await drainEvents(async () => ({ events: [{ id: 1 }], cursor: 0 }), { limit: 1 })
  assert.equal(stalled.truncated, true)
  const shortStalled = await drainEvents(async () => ({ events: [{ id: 1 }], cursor: 0 }), { limit: 100 })
  assert.equal(shortStalled.truncated, true)
  const guarded = await drainEvents(async (after) => ({ events: [{ id: after + 1 }], cursor: after + 1 }), { limit: 1, maxPages: 2 })
  assert.equal(guarded.truncated, true)
})

test('final drain is queued behind an in-flight periodic drain', async () => {
  let release
  const firstPage = new Promise((resolve) => { release = resolve })
  let calls = 0
  const queue = createDrainQueue(async () => { calls += 1; if (calls === 1) await firstPage })
  const running = queue.drain()
  const finishing = queue.drain({ final: true })
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  await running
  await finishing
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
})

test('crew-emitted agent events carry the phase linkage shapeRun folds into lanes', () => {
  // Was a source grep over crew/seat-io.mjs, which a comment could satisfy and which
  // a `/s` wildcard let any other phase_id occurrence satisfy (#476 V2). This drives
  // the real emitter instead and reads the visualizer-side consequence.
  // MUTATION V2: take the expected triple from the observed output and a null phase
  // cursor is invisible again.
  let seq = 0
  const events = []
  const emitter = {
    adwId: 'adw-shape-phase',
    phaseTransition: () => ({ phase_id: 7 }),
    emit: (fn) => fn({ recordEvent: (event) => events.push(event) }, () => ++seq),
  }
  const adapter = emitAdapter(emitter)
  adapter({ kind: 'stage', label: 'build:r1' })
  adapter({ kind: 'assign', id: 'd1', role: 'builder' })
  const rows = events.map((event, index) => ({ id: index + 1, type: event.type, phase_id: event.phase_id,
    payload_json: JSON.stringify(event.payload), started_at: null, ended_at: null }))
  const phases = [{ id: 7, seq: 1, name: 'build', status: 'ok', started_at: start, ended_at: end }]
  const run = shapeRun(base, phases, rows, null, {}, Date.parse(end))
  assert.deepEqual({ phases: events.map((event) => event.phase_id), lane: run.phases[0].lane, source: run.phase_lanes },
                   { phases: [7, 7], lane: laneFor('builder'), source: 'agent' })
})

test('shape.mjs carries no stale claim that crew agent events lack phase linkage', () => {
  // Textual on purpose: what it forbids IS a sentence, so there is no behaviour to
  // drive -- and the comment-shaped-to-match-the-regex trick cannot satisfy a
  // doesNotMatch, which a comment can only ever break.
  // MUTATION V2b: widen the forbidden pattern and the stale claim slips back in.
  const shape = readFileSync(join(process.cwd(), 'visualizer/server/shape.mjs'), 'utf8')
  assert.doesNotMatch(shape, /crew agent events carry no phase_id/)
})

test('timeline reserves request space and parks queued phases', () => {
  const run = { started_at: start, ended_at: end, phase_lanes: 'agent', phases: [
    { id: 1, seq: 1, name: 'plan', status: 'ok', lane: 0, started_at: start, ended_at: end },
    { id: 2, seq: 2, name: 'finish', status: 'running', lane: null, started_at: null, ended_at: null },
  ] }
  const out = layoutTimeline(run, [], { now: Date.parse(end) })
  assert.equal(out.origin_at, start)
  assert.equal(out.queued[0].queued, true)
  assert.equal(out.queued[0].width, QUEUED_WIDTH)
  assert.equal(out.request, null)
})

test('timeline excludes point events and keeps span marks', () => {
  const run = { phases: [{ id: 1, seq: 1, name: 'plan', status: 'ok', started_at: start, ended_at: end }] }
  const out = layoutTimeline(run, [{ id: 1, started_at: null, ended_at: null, payload_json: '{"duration_ms":99}' }, { id: 2, started_at: start, ended_at: end }], { now: Date.parse(end) })
  assert.deepEqual(out.marks.map((event) => event.id), [2])
})

test('timeline floors and separates consecutive blocks', () => {
  const run = { phases: [{ id: 1, seq: 1, name: 'a', started_at: start, ended_at: start }, { id: 2, seq: 2, name: 'b', started_at: end, ended_at: end }] }
  const out = layoutTimeline(run, [], { now: Date.parse(end) })
  assert.ok(out.blocks.every((block) => block.width >= MIN_WIDTH - 1e-9))
  assert.ok(out.blocks[0].x + out.blocks[0].width <= out.blocks[1].x + 1e-9)
})

test('envelope diff reports recursive changes in stable order', () => {
  const before = { status: 'done', summary: 'old', artifacts: ['a'], details: { remove: true } }
  const after = { status: 'done', summary: 'new', artifacts: ['a', 'b'], details: { add: true } }
  const rows = diffEnvelopes(before, after)
  assert.deepEqual(rows.map((row) => row.path), ['artifacts[1]', 'details.add', 'details.remove', 'summary'])
})

test('attemptPairs finds consecutive attempts per role', () => {
  const pairs = attemptPairs([{ role: 'builder', dispatch_seq: 1 }, { role: 'planner', dispatch_seq: 2 }, { role: 'builder', dispatch_seq: 3 }])
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].role, 'builder')
})

test('timeline empty run is safe', () => {
  const out = layoutTimeline({ phases: [] }, [])
  assert.deepEqual(out.blocks, [])
  assert.deepEqual(out.marks, [])
})

test('shapeRunSet averages measured rows only and states per-run usage', () => {
  const result = shapeRunSet({
    rows: [
      { adw_id: 'measured', status: 'ok', agent_sessions: 2, billed_input_tokens: 100, billed_output_tokens: 20, billed_cache_write_tokens: 5, billed_cache_read_tokens: 5 },
      { adw_id: 'unmeasured', status: 'ok', agent_sessions: 0, billed_input_tokens: null, billed_output_tokens: null, billed_cache_write_tokens: null, billed_cache_read_tokens: null },
    ],
    since: start, until: end, label: 'last 24 hours',
  })
  assert.equal(result.usage_mean_tokens_per_measured_run, 130)
  assert.deepEqual(result.rows.map((row) => row.usage_state), ['measured', 'unmeasured'])
  assert.match(result.unmeasured.per_run, /agent_sessions/)
})

test('shapeRunSet leaves budget numbers null when no ceiling is declared', () => {
  const result = shapeRunSet({ rows: [], since: start, until: end, label: 'last 24 hours' })
  assert.equal(result.budget.ceiling_tokens, null)
  assert.equal(result.budget.headroom_tokens, null)
  assert.equal(result.budget.fraction, null)
  assert.ok(result.budget.pending)
})

test('shapeRunSet compares a declared ceiling over an equal window', () => {
  const result = shapeRunSet({
    rows: [], since: start, until: end, label: 'last 24 hours',
    ceiling: { max_tokens: 1000, window_ms: 2000, source: 'test', error: null },
    burn: { measured: true, total: 130, sessions: 2, absent: null },
  })
  assert.equal(result.budget.comparable, true)
  assert.equal(result.budget.headroom_tokens, 870)
  assert.equal(result.budget.fraction, 0.13)
})

// Orchestrator close-out pin (mutation-found gap): the measured path was pinned
// but the unmeasured one was not. Letting an unmeasured burn fall through as
// burn_tokens: 0 / agent_sessions: 0 passed the entire suite — and against a real
// ceiling that renders as "0% of budget used" when the truth is "we do not know".
test('shapeRunSet refuses to compare an unmeasured burn, and never reads it as zero', () => {
  for (const burn of [
    { measured: false, total: null, sessions: null, absent: 'no agent_sessions rows in this window' },
    { measured: false, total: 0, sessions: 0, absent: null },
    undefined,
  ]) {
    const result = shapeRunSet({
      rows: [], since: start, until: end, label: 'last 24 hours',
      ceiling: { max_tokens: 1000, window_ms: 2000, source: 'test', error: null },
      burn,
    })
    assert.equal(result.budget.comparable, false, 'an unmeasured burn is never comparable')
    assert.equal(result.budget.burn_tokens, null, 'an unmeasured burn is never a measured zero')
    assert.equal(result.budget.agent_sessions, null, 'unmeasured sessions are never a measured zero')
    assert.equal(result.budget.fraction, null)
    assert.equal(result.budget.headroom_tokens, null)
    assert.ok(result.budget.pending, 'an unmeasured burn always says why it refused')
  }
})

test('shapeRunSet refuses a declared ceiling over a different window', () => {
  const result = shapeRunSet({
    rows: [], since: start, until: end, label: 'last 24 hours',
    ceiling: { max_tokens: 1000, window_ms: 14000, source: 'test', error: null },
    burn: { measured: true, total: 130, sessions: 2, absent: null },
  })
  assert.equal(result.budget.comparable, false)
  assert.equal(result.budget.headroom_tokens, null)
  assert.equal(result.budget.fraction, null)
  assert.match(result.budget.pending, /14000.*2000/)
})

test('shapeCellHealth marks seated cells undetermined when its readout is absent', () => {
  const result = shapeCellHealth({
    rows: null, absent: 'cell_failures predates this ledger mirror',
    roster: { tiers: [{ tier: 'build', seats: [{ role: 'builder', provider: 'openai', id: 'gpt-5', agent: 'pi', effort: 'max' }] }] },
    since: start, until: null, label: 'last 7 days',
  })
  assert.equal(result.cells.length, 1)
  assert.equal(result.cells[0].state, 'undetermined')
  assert.equal(result.cells[0].failures, null)
  assert.equal(result.cells[0].run_less, null)
  assert.equal(result.cells[0].in_run, null)
  assert.equal(result.cells[0].undetermined_why, 'cell_failures predates this ledger mirror')
  assert.doesNotMatch(JSON.stringify(result), /"(verdict|open|closed|healthy|threshold)"/i)
})

test('shapeCellHealth carries catalog prices and leaves absent prices pending', () => {
  const result = shapeCellHealth({
    rows: [],
    roster: {
      tiers: [{ tier: 'build', seats: [
        { role: 'builder', provider: 'openai', id: 'gpt-5', agent: 'pi', effort: 'max' },
        { role: 'planner', provider: 'anthropic', id: 'ghost', agent: 'claude', effort: 'medium' },
      ] }],
      models: [{ key: 'openai/gpt-5', cost_in_per_mtok: 2, cost_out_per_mtok: 12, cost_cache_read_per_mtok: 0.2, cost_cache_write_per_mtok: 0, cache_rate_source: 'published prompt-caching rates', context: 400000, source: 'vendor', last_verified: '2026-08-13' }],
    },
    since: start, until: null, label: 'last 7 days',
  })
  const known = result.cells.find((cell) => cell.model_id === 'gpt-5')
  const unknown = result.cells.find((cell) => cell.model_id === 'ghost')
  assert.equal(known.price.cost_in_per_mtok, 2)
  assert.equal(known.price.cost_out_per_mtok, 12)
  assert.equal(known.price.cost_cache_read_per_mtok, 0.2)
  assert.equal(known.price.cost_cache_write_per_mtok, 0)
  assert.equal(known.price.cache_rate_source, 'published prompt-caching rates')
  assert.equal(known.price_pending, null)
  assert.equal(unknown.price, null)
  assert.ok(unknown.price_pending)
  assert.doesNotMatch(JSON.stringify(result), /"(?:[a-z_]*(?:usd|spend|total_cost|cost_total)[a-z_]*)"/i)
})

test('visualizer architecture keeps sqlite and legacy Svelte syntax behind the boundaries', () => {
  const files = allFiles(join(process.cwd(), 'visualizer'))
  const allowed = new Set(['visualizer/server/triage.mjs'])
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const relative = file.replace(`${process.cwd()}/`, '')
    if (source.includes('node:sqlite')) assert.ok(allowed.has(relative), relative)
    if (file.endsWith('.svelte')) {
      assert.doesNotMatch(source, /^\s*export\s+let\s/m, relative)
      assert.doesNotMatch(source, /^\s*\$:\s/m, relative)
    }
  }
  const feed = readFileSync(join(process.cwd(), 'visualizer/server/ledger-feed.mjs'), 'utf8')
  assert.doesNotMatch(feed, /node:sqlite/)
  assert.doesNotMatch(feed, /DatabaseSync/)
  assert.match(feed, /import \{ openLedger \} from ['"]\.\.\/\.\.\/scripts\/factory\/ledger\.mjs['"]/)
})

test('shapeIntake merges per-issue candidates, keeps the latest refusal, and sorts by issue', () => {
  const view = shapeIntake({
    sweeps: [], refusals: [], picks: [], ever: { sweeps: 1 }, absent: null,
    candidate_refusals: [
      { board_owner: 'owner', board_project: 1, issue: 7, reason: 'protected-path', detail: 'newer', priority: 'P1', created_at: '2024-01-02T00:00:00.000Z', refusals: 1 },
      { board_owner: 'owner', board_project: 1, issue: 7, reason: 'tier-judge', detail: 'older', priority: 'P1', created_at: '2024-01-01T00:00:00.000Z', refusals: 1 },
    ],
    candidate_picks: [{ issue: 9, board_owner: 'owner', board_project: 1, created_at: '2024-01-02T00:00:30.000Z', picks: 1 }],
    candidates_absent: null,
  })
  assert.equal(view.candidates.measured, true)
  assert.deepEqual(view.candidates.items.map((item) => item.issue), [7, 9])
  assert.deepEqual(view.candidates.items.map((item) => item.verdict), ['would-refuse', 'would-take'])
  assert.equal(view.candidates.items[0].reason, 'protected-path')
  assert.equal(view.candidates.items[0].reason_recognised, true)
  assert.equal(view.candidates.items[0].refused_at, '2024-01-02T00:00:00.000Z')
})

test('shapeIntake lets a strictly newer pick win, but not an older or tied pick', () => {
  const source = (refusedAt, pickedAt) => shapeIntake({
    sweeps: [], refusals: [], picks: [], ever: { sweeps: 1 }, absent: null,
    candidate_refusals: [{ board_owner: 'owner', board_project: 1, issue: 7, reason: 'protected-path', created_at: refusedAt, refusals: 1 }],
    candidate_picks: [{ issue: 7, board_owner: 'owner', board_project: 1, created_at: pickedAt, picks: 1 }],
    candidates_absent: null,
  }).candidates.items[0]
  assert.equal(source('2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z').verdict, 'would-take')
  assert.equal(source('2024-01-02T00:00:00.000Z', '2024-01-01T00:00:00.000Z').verdict, 'would-refuse')
  assert.equal(source('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z').verdict, 'would-refuse')
})

test('shapeIntake preserves an off-set candidate reason and flags recognition', () => {
  const view = shapeIntake({
    sweeps: [], refusals: [], picks: [], ever: { sweeps: 1 }, absent: null,
    candidate_refusals: [
      { board_owner: 'owner', board_project: 1, issue: 7, reason: 'protected-path', created_at: '2024-01-01T00:00:00.000Z', refusals: 1 },
      { board_owner: 'owner', board_project: 1, issue: 8, reason: 'made-up', created_at: '2024-01-01T00:00:01.000Z', refusals: 1 },
    ],
    candidate_picks: [], candidates_absent: null,
  })
  const seven = view.candidates.items.find((item) => item.issue === 7)
  const eight = view.candidates.items.find((item) => item.issue === 8)
  assert.equal(seven.reason_recognised, true)
  assert.ok(INTAKE_REFUSAL_REASONS.includes(seven.reason))
  assert.equal(eight.reason, 'made-up')
  assert.equal(eight.reason_recognised, false)
})

test('shapeIntake keeps candidate absence unmeasured, including a wholly missing readout', () => {
  const base = { sweeps: [], refusals: [], picks: [], ever: { sweeps: 1 }, absent: null, since: start, until: null, label: 'last 24 hours' }
  const absent = shapeIntake({ ...base, candidate_refusals: null, candidate_picks: null, candidates_absent: 'intake_refusals predates this ledger mirror' })
  assert.equal(absent.candidates.measured, false)
  assert.equal(absent.candidates.absent, 'intake_refusals predates this ledger mirror')
  assert.deepEqual(absent.candidates.items, [])
  assert.match(absent.candidates.unmeasured, /not a live read|has not seen/i)
  const missing = shapeIntake(base)
  assert.equal(missing.candidates.measured, false)
  assert.deepEqual(missing.candidates.items, [])
  assert.equal(missing.readonly, true)
})

test('shapeIntake tells a loop that never swept from a loop that swept and found nothing', () => {
  const base = { refusals: [], picks: [], absent: null, since: '2024-01-01T00:00:00.000Z', until: null, label: 'last 24 hours' }
  const views = [
    shapeIntake({ ...base, sweeps: null, ever: null, absent: 'intake_sweeps predates this ledger mirror' }),
    shapeIntake({ ...base, sweeps: [], ever: { sweeps: 0, first_at: null, last_at: null } }),
    shapeIntake({ ...base, sweeps: [], ever: { sweeps: 2, first_at: '2023-12-30T00:00:00.000Z', last_at: '2023-12-31T00:00:00.000Z' } }),
    shapeIntake({ ...base, sweeps: [{ outcome: 'none', reason: null, count: 3, first_at: '2024-01-01T01:00:00.000Z', last_at: '2024-01-01T02:00:00.000Z' }], ever: { sweeps: 3, first_at: '2024-01-01T01:00:00.000Z', last_at: '2024-01-01T02:00:00.000Z' } }),
  ]
  assert.equal(new Set(views.map((view) => view.loop.state)).size, 4)
  assert.equal(new Set(views.map((view) => view.loop.why)).size, 4)
  assert.match(views[2].loop.why, /last swept.*last 24 hours.*window/i)
  assert.equal(views[3].loop.state, 'swept-idle')
})

test('an absent intake table is unmeasured, never a measured zero', () => {
  const result = shapeIntake({ sweeps: null, refusals: null, picks: null, ever: null, absent: 'intake_sweeps predates this ledger mirror', since: start, until: null, label: 'last 24 hours' })
  assert.equal(result.loop.swept, null)
  assert.equal(result.loop.picked, null)
  assert.equal(result.loop.parked, null)
  assert.equal(result.loop.none, null)
  for (const group of result.refusals.groups) for (const row of group.reasons) {
    assert.equal(row.count, null)
    assert.equal(row.state, 'unmeasured')
  }
  assert.doesNotMatch(JSON.stringify(result), /"(swept|picked|parked)":\s*0/)
})

test('every closed refusal reason survives to the view in exactly one group', () => {
  assert.deepEqual([...INTAKE_REFUSAL_REASONS].sort(), [...INTAKE_REFUSALS].sort())
  const result = shapeIntake({
    sweeps: [
      { outcome: 'parked', reason: 'stop-switch', count: 1, first_at: start, last_at: start },
      { outcome: 'parked', reason: 'redacted', count: 1, first_at: end, last_at: end },
    ],
    refusals: [{ reason: 'redacted', count: 1, first_at: start, last_at: end }], picks: [],
    ever: { sweeps: 2, first_at: start, last_at: end }, absent: null, since: start, until: null, label: 'last 24 hours',
  })
  const groups = result.refusals.groups
  const reasons = groups.flatMap((group) => group.reasons.map((row) => row.reason))
  assert.equal(new Set(reasons).size, INTAKE_REFUSAL_REASONS.length)
  assert.deepEqual(reasons, ['intake-block-missing', 'intake-block-malformed', 'brief-uncompilable', 'priority-unknown', 'repeat-escalation', 'stop-switch', 'window-cap', 'rate-limit-floor', 'protected-path', 'tier-judge', 'not-first-in-order'])
  assert.equal(groups[0].group, 'authoring')
  assert.equal(groups.at(-1).group, 'ordering')
  assert.equal(groups[1].reasons.find((row) => row.reason === 'stop-switch').count, 1)
  assert.ok(result.refusals.unrecognised.some((row) => row.reason === 'redacted'))
})

test('the intake window is stated and bounded', () => {
  const now = Date.parse('2024-01-08T00:00:00.000Z')
  const window = defaultIntakeWindow(now)
  assert.equal(Date.parse(window.since), now - INTAKE_WINDOW_MS)
  assert.equal(window.until, null)
  assert.equal(window.label, 'last 24 hours')
  const result = shapeIntake({ sweeps: [], refusals: [], picks: [], ever: { sweeps: 2, first_at: start, last_at: end }, absent: null, ...window })
  assert.equal(result.window.label, window.label)
  assert.ok(result.unmeasured.window)
  assert.equal(result.loop.first_sweep_at, start)
  assert.equal(result.loop.last_sweep_at, end)
})

test('shapeRun carries model cells while effort and context stay explicitly pending', () => {
  const events = [{ type: 'agent_start', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'd1' }), started_at: start }]
  const run = shapeRun(base, [], events, null, { missing: [] }, Date.parse(end), { agentSessions: [{ dispatch_id: 'd1', model: 'model/live' }] })
  const agent = run.agents[0]
  assert.equal(agent.model, 'model/live')
  assert.equal(agent.model_pending, null)
  assert.equal(agent.effort, null)
  assert.equal(agent.context_tokens, null)
  assert.equal(agent.context_window, null)
  assert.ok(agent.effort_pending)
  assert.ok(agent.context_pending)
  assert.deepEqual(Object.keys(foldAgents(events)[0]).sort(), ['dispatch_id', 'ended_at', 'key', 'lane', 'outcome', 'role', 'started_at'].sort())
  assert.deepEqual(withCells([], []), [])
})

test('shapeGateChecks normalises recorded items and degrades malformed JSON', () => {
  const rows = shapeGateChecks([
    { gate_generation: 1, checks_json: JSON.stringify([{ name: 'named', note: 'kept note', ok: true }, 'summary']) },
    { gate_generation: 2, checks_json: '{not-json' },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].checks, [{ label: 'named', note: 'kept note', ok: true }, { label: 'summary', note: null, ok: null }])
  assert.deepEqual(rows[1].checks, [])
  assert.equal(rows[1].checks_raw, '{not-json')
  assert.ok(rows[1].checks_pending)
})
