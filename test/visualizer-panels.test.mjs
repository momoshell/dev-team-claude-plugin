import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PANEL_REFRESH_MS, PANEL_STALE_AFTER_MS, acceptRows, fleetCost, fleetEscalationRate, fleetMedianDuration, fleetPassRate, fleetPhasesPerRun, fleetTokens, findingRows, gateChips, panelAgeLabel, panelReadLoop, readFreshness, reviewRows } from '../visualizer/web/src/lib/panels.js'
import { VIEWS, parseHash, formatHash } from '../visualizer/web/src/lib/route.js'
import { ATTENTION_KEYS, absenceMark, attentionBreakdown, configurationDimensionCell, configurationFilterView, costCell, createSemaphore, crewArchive, deriveDisplayStatus, deriveStatus, escalationProbeTargets, fleetActivity, fleetView, gateCell, heartbeatCell, needsAttention, openRecordNote, operationsOverview, profileEvidenceView, reviewCell, runActivity, runDetailConfiguration, runDetailSeats, runDetailState, runtimeActivitySummary, slotWaitCell, tokenCell, shipStatus } from '../visualizer/web/src/lib/fleet.js'
import { ROLE_ORDER, acceptEvidence, bounceArrows, gateMarkers, gateProofStory, laneRows, phaseFilterId, phasePanel, renderMarkdown } from '../visualizer/web/src/lib/trace.js'
import { eventStory, eventStreamSummary } from '../visualizer/web/src/lib/event-story.js'
import { STORY_KINDS, assignmentPath, envelopeFacts, envelopeGroups, envelopeOverview, envelopeSections, journalLines, trajectoryRowStory, trajectorySummary } from '../visualizer/web/src/lib/diagnostic-story.js'
import { executionTopology, factoryStepCategory, factoryStepName, factoryStepTrace } from '../visualizer/web/src/lib/execution-steps.js'
import { crewSummary } from '../visualizer/web/src/lib/crew.js'
import { assuranceMeta, assuranceOption, executionMeta, runConfiguration, taskProfileMeta } from '../visualizer/web/src/lib/workflow-semantics.js'
import { diffLines } from '../visualizer/web/src/lib/diff-lines.js'
import { ROOT, scratchDir, sqliteAvailable } from './helpers.mjs'
import { getPluginWriteMode, proposeSkills } from '../visualizer/web/src/lib/api.js'
import { activitySummary } from '../visualizer/web/src/lib/activity.js'
test('RO6', async () => {
  // MUTATION: change the getter URL; the behavioral fetch assertion must fail.
  const original = globalThis.fetch
  let requested
  globalThis.fetch = async (url) => { requested = url; return { ok:true, json:async () => ({ writable:false }) } }
  try {
    assert.deepEqual(await getPluginWriteMode(), { writable:false })
    assert.equal(requested, '/api/plugin-write-mode')
    globalThis.fetch = async () => ({ ok:false, json:async () => ({ error:'readonly' }) })
    await assert.rejects(getPluginWriteMode(), /readonly/)
  } finally { globalThis.fetch = original }
})

async function withAttentionFixture(extraKey, callback) {
  const dir = scratchDir('visualizer-attention-')
  try {
    const sourcePath = join(ROOT, 'visualizer/web/src/lib/fleet.js')
    const semanticsPath = join(ROOT, 'visualizer/web/src/lib/workflow-semantics.js')
    const reasonCopyPath = join(ROOT, 'visualizer/web/src/lib/reason-copy.js')
    const shapesPath = join(ROOT, 'visualizer/web/src/lib/run-shapes.js')
    const source = readFileSync(sourcePath, 'utf8')
    const original = "export const ATTENTION_KEYS = Object.freeze(['escalated', 'fail', 'aborted', 'silent', 'unverified', 'gone', 'contradicted'])"
    const changed = `export const ATTENTION_KEYS = Object.freeze(['escalated', 'fail', 'aborted', 'silent', 'unverified', 'gone', 'contradicted', '${extraKey}'])`
    const moduleDir = join(dir, 'visualizer', 'web', 'src', 'lib')
    assert.equal(source.includes(original), true)
    mkdirSync(moduleDir, { recursive:true })
    writeFileSync(join(moduleDir, 'workflow-semantics.js'), readFileSync(semanticsPath, 'utf8'))
    writeFileSync(join(moduleDir, 'reason-copy.js'), readFileSync(reasonCopyPath, 'utf8'))
    writeFileSync(join(moduleDir, 'fleet.js'), source.replace(original, changed))
    writeFileSync(join(moduleDir, 'run-shapes.js'), readFileSync(shapesPath, 'utf8'))
    const module = await import(`${pathToFileURL(join(moduleDir, 'fleet.js')).href}?attention=${encodeURIComponent(extraKey)}`)
    return await callback(module)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('workflow semantics separate profile, execution and assurance without inference', () => {
  assert.deepEqual(assuranceOption('build'), { value:'build', label:'Standard · build' })
  assert.equal(assuranceMeta('mechanical').label, 'Quick')
  assert.equal(assuranceMeta('judge').label, 'Rigorous')
  assert.equal(assuranceMeta('standard').alias, 'build')
  assert.equal(executionMeta('scout').label, 'Scout')
  assert.equal(taskProfileMeta(null).label, 'Not recorded')
  assert.match(taskProfileMeta(null).summary, /does not infer/)
  const historical = runConfiguration({ tier:'build', variant:'full' })
  assert.equal(historical.profile.label, 'Not recorded')
  assert.equal(historical.execution.label, 'Full reviewed')
  assert.equal(historical.assurance.label, 'Standard')
  assert.equal(historical.assurance.recording, 'legacy_alias')
  const recorded = runConfiguration({ configuration:{
    task_profile:{ requested:null, effective:'implementation', source:'explicit' },
    execution:{ requested:null, effective:'full', source:'profile_recommendation' },
    assurance:{ requested:'standard', effective:'standard', source:'explicit' },
    legacy_tier:'build',
  } })
  assert.equal(recorded.profile.label, 'Implementation')
  assert.equal(recorded.execution.label, 'Full reviewed')
  assert.equal(recorded.assurance.label, 'Standard')
  assert.equal(recorded.assurance.source, 'explicit')
  assert.equal(recorded.assurance.recording, 'canonical')
})

function configurationFixture() {
  const historical = { adw_id: 'historical', tier: 'build', variant: 'full', task_profile: null, execution_shape: null, assurance: null }
  const measured = { adw_id: 'measured', task_profile: 'implementation', execution_shape: 'full', assurance: 'standard' }
  const other = { adw_id: 'other', task_profile: 'audit', execution_shape: 'scout', assurance: 'rigorous' }
  const colliding = { adw_id: 'colliding', task_profile: 'Not recorded', execution_shape: 'directed', assurance: 'quick' }
  return { historical, measured, other, colliding, rows: [historical, measured, other, colliding] }
}

test('A1', () => {
  const { historical } = configurationFixture()
  assert.deepEqual(configurationFilterView([historical]).dimensions, [])
})

test('B1', () => {
  const { rows } = configurationFixture()
  const view = configurationFilterView(rows)
  assert.deepEqual(view.dimensions.map((dimension) => dimension.key), ['task_profile', 'execution_shape', 'assurance'])
  assert.ok(view.dimensions.every((dimension) => dimension.options.length > 0))
  assert.ok(view.dimensions.every((dimension) => dimension.options.every((option) => option.value !== null)))
})

test('C1', () => {
  const { historical } = configurationFixture()
  const marks = ['task_profile', 'execution_shape', 'assurance'].map((dimension) => configurationDimensionCell(historical, dimension))
  assert.ok(marks.every((mark) => mark.value === null && mark.text === 'Not recorded' && mark.dashed === true))
  assert.notEqual(marks[0].text, historical.tier)
  assert.notEqual(marks[1].text, historical.variant)
  assert.notEqual(marks[2].text, 'Standard')
})

test('D1', () => {
  const { historical, colliding } = configurationFixture()
  const absent = configurationDimensionCell(historical, 'task_profile')
  const real = configurationDimensionCell(colliding, 'task_profile')
  assert.equal(absent.value, null)
  assert.equal(absent.dashed, true)
  assert.equal(real.value, 'Not recorded')
  assert.equal(real.dashed, false)
  assert.notDeepEqual({ value: absent.value, dashed: absent.dashed }, { value: real.value, dashed: real.dashed })
})

test('E1', () => {
  const { historical, measured, other } = configurationFixture()
  const view = configurationFilterView([historical, measured, other], { task_profile: 'implementation' })
  assert.deepEqual(view.rows.map((row) => row.adw_id), ['historical', 'measured'])
  assert.equal(view.excluded.count, 1)
  assert.equal(view.excluded.line, '1 measured row excluded by configuration filters · not-recorded rows remain visible')
})

test('F1', () => {
  const { measured, colliding } = configurationFixture()
  const view = configurationFilterView([measured, colliding])
  const options = (key) => view.dimensions.find((dimension) => dimension.key === key).options.map((option) => option.value)
  assert.deepEqual(options('task_profile'), ['Not recorded', 'implementation'])
  assert.deepEqual(options('execution_shape'), ['directed', 'full'])
  assert.deepEqual(options('assurance'), ['quick', 'standard'])
  assert.doesNotMatch(JSON.stringify(view), /audit|scout|rigorous/)
})

test('G1', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/TaskList.svelte'), 'utf8')
  assert.match(source, /import \{[^}]*configurationDimensionCell[^}]*configurationFilterView[^}]*\} from '\.\/fleet\.js'/)
  assert.match(source, /let baseRows = \$derived\(/)
  assert.match(source, /configurationFilterView\(baseRows,/)
  for (const dimension of ['task_profile', 'execution_shape', 'assurance']) assert.match(source, new RegExp(`configurationDimensionCell\\(run, '${dimension}'\\)`))
  assert.match(source, /configurationView\.excluded\.line/)
  assert.doesNotMatch(source, /runConfiguration|run\.tier|run\.variant|configuration\.legacy_(?:tier|variant)/)
})

test('A1 task detail configuration preserves changed requested effective and source', () => {
  const rows = runDetailConfiguration({ configuration: { assurance: { requested: 'standard', effective: 'rigorous', source: 'protected_floor' } } })
  const assurance = rows.find((row) => row.key === 'assurance')
  assert.deepEqual({ requested: assurance.requested, effective: assurance.effective, source: assurance.source, changed: assurance.changed }, { requested:'standard', effective:'rigorous', source:'protected_floor', changed:true })
  assert.deepEqual({ requested: assurance.requested_text, effective: assurance.effective_text, source: assurance.source_text }, { requested:'standard', effective:'rigorous', source:'protected_floor' })
})

test('B1 task detail configuration keeps all four provenance sources distinct', () => {
  const sources = ['roster', 'profile_recommendation', 'operator_override', 'reseat']
  const found = sources.map((source) => runDetailConfiguration({ configuration: { assurance: { requested:'standard', effective:'rigorous', source } } }).find((row) => row.key === 'assurance').source)
  assert.deepEqual(found, sources)
})

test('C1 task detail configuration marks missing provenance Not recorded and changed null', () => {
  const rows = runDetailConfiguration({ tier:'build', variant:'full', assurance:'standard', configuration: { assurance: { requested:'standard', effective:'standard', source:null } } })
  const assurance = rows.find((row) => row.key === 'assurance')
  assert.equal(assurance.source, null)
  assert.equal(assurance.source_text, 'Not recorded')
  assert.equal(assurance.changed, null)
  assert.equal(rows.find((row) => row.key === 'task_profile').effective_text, 'Not recorded')
})

test('D1 task detail seats keep distinctive warnings attached to their original roles', () => {
  const result = runDetailSeats({ seats: [
    { role:'planner', source:'roster', policy_state:'passed', warnings:['planner-only'] },
    { role:'builder', source:'reseat', policy_state:'warned', warnings:['builder-only'] },
  ] })
  assert.deepEqual(result.rows.map((row) => [row.role, row.warnings]), [['planner', ['planner-only']], ['builder', ['builder-only']]])
})

test('E1 task detail seats distinguish null from measured-empty', () => {
  const absent = runDetailSeats({ seats:null })
  const empty = runDetailSeats({ seats:[] })
  assert.deepEqual(absent, { state:'not-recorded', rows:[], summary:'Not recorded' })
  assert.deepEqual(empty, { state:'measured-empty', rows:[], summary:'No seat overrides or policy warnings recorded' })
})

test('F1 task detail seats preserve unknown future policy states', () => {
  const row = runDetailSeats({ seats: [{ role:'reviewer', source:'operator_override', policy_state:'future_policy', warnings:[] }] }).rows[0]
  assert.equal(row.policy_state, 'future_policy')
  assert.deepEqual(row.warnings, [])
})

test('G1 task detail state reports measured facts and independently missing facts', () => {
  const measured = runDetailState({
    settlement:{ state:'settled', outcome:'success', reason:'operator-complete' },
    runtime:{ driver_state:'alive', source:'daemon', reason_code:'healthy', heartbeat_state:'fresh' },
    phases:[{ name:'request' }, { name:'build' }],
    reconciliation_command:'node reconcile --dry-run',
  }, [{ type:'agent_start' }, { type:'agent_end' }])
  assert.match(measured.settlement.text, /settled.*success.*operator-complete/)
  assert.equal(measured.driver.text, 'alive · daemon')
  assert.equal(measured.heartbeat.text, 'fresh')
  assert.match(measured.heartbeat.caveat, /heartbeat freshness does not establish driver liveness/i)
  assert.equal(measured.latest.phase, 'build')
  assert.equal(measured.latest.event, 'agent_end')
  assert.equal(measured.remediation.text, 'node reconcile --dry-run')

  const absent = runDetailState({ settlement:null, runtime:null, phases:[], reconciliation_command:null }, [])
  assert.deepEqual([absent.settlement.text, absent.driver.text, absent.heartbeat.text, absent.latest.phase, absent.latest.event, absent.remediation.text], Array(6).fill('Not recorded'))
  assert.match(absent.heartbeat.caveat, /heartbeat/i)
  const noPhase = runDetailState({ phases:[], runtime:{ heartbeat_state:'overdue' } }, [{ type:'log' }])
  assert.equal(noPhase.latest.phase, 'Not recorded')
  assert.equal(noPhase.latest.event, 'log')
  assert.equal(noPhase.heartbeat.text, 'overdue')
})

test('H1 RunDetail composes plain detail helpers and renders each audited field', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  assert.match(source, /import \{ durationCell, gateCell, profileEvidenceView, runDetailConfiguration, runDetailSeats, runDetailState, shipStatus, tokenCell \} from '\.\/fleet\.js'/)
  assert.match(source, /let configurationDetail = \$derived\(runDetailConfiguration\(run\)\)/)
  assert.match(source, /let seatPolicy = \$derived\(runDetailSeats\(run\)\)/)
  assert.match(source, /let runState = \$derived\(runDetailState\(run, events\)\)/)
  for (const helper of ['runDetailConfiguration', 'runDetailSeats', 'runDetailState']) assert.doesNotMatch(source, new RegExp(`function\\s+${helper}\\s*\\(`))
  for (const token of [
    'configuration-strip', 'requested_text', 'effective_text', 'source_text',
    'configuration-equal', 'configuration-changed', 'seat-policy', 'seatPolicy.rows',
    'seat.source', 'seat.policy_state', 'seat.warnings', 'No policy warnings recorded',
    'run-state-card', 'Settlement', 'Driver observation', 'Heartbeat', 'caveat',
    'Latest phase', 'Latest event', 'Operator remediation', 'runState.remediation.command',
  ]) assert.match(source, new RegExp(token.replace('.', '\\.' )))
})

test('crew summary separates distinct seats, assignment turns, and reused dispatch labels', () => {
  const result = crewSummary([
    { key:'d1#1', dispatch_id:'d1', role:'planner', lane:0, model:'claude-opus-5', outcome:'done' },
    { key:'d2#1', dispatch_id:'d2', role:'planner', lane:0, model:null, outcome:'done' },
    { key:'d2#2', dispatch_id:'d2', role:'tech-lead', lane:3, model:'openai/gpt-sol', outcome:'done' },
    { key:'d3#1', dispatch_id:'d3', role:'lead', lane:4, model:'claude-opus-5', outcome:'failed' },
  ])
  assert.deepEqual([result.seat_count, result.assignment_count, result.dispatch_count, result.process_count], [3, 4, 3, null])
  assert.deepEqual(result.seats[0].dispatch_ids, ['d1', 'd2'])
  assert.equal(result.seats[0].model, 'claude-opus-5')
  assert.equal(result.seats[0].model_coverage, 1)
  assert.deepEqual(result.seats[2].outcome, { key:'failed', label:'1 failed' })
})

test('fleetTokens never fabricates a zero for an unmeasured fleet', () => {
  const result = fleetTokens([
    { metrics: { billed_input_tokens: null }, pending: { billed_input_tokens: 'predates this measurement' } },
    { metrics: { billed_input_tokens: null } },
  ])
  assert.equal(result.total, null)
  assert.notEqual(result.total, 0)
  assert.equal(result.measured, 0)
  assert.equal(result.runs, 2)
  assert.ok(result.pending)
})

test('fleetTokens sums measured runs and reports partial coverage', () => {
  const result = fleetTokens([
    { metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 5 } },
    { metrics: { billed_input_tokens: null, billed_output_tokens: null, billed_cache_write_tokens: null, billed_cache_read_tokens: null }, pending: { billed_input_tokens: 'predates this measurement' } },
  ])
  assert.equal(result.total, 20)
  assert.equal(result.measured, 1)
  assert.equal(result.runs, 2)
  assert.equal(result.pending, null)
  assert.equal(result.cacheRate, 5 / 18 * 100)
  assert.equal(result.cacheMeasured, 1)
})

test('fleetCost never derives money from token totals', () => {
  const result = fleetCost([{ metrics: { billed_input_tokens: 999999999 } }])
  assert.equal(result.usd, null)
  assert.ok(result.pending)
})

test('the sessions derivations never fabricate a zero for a degraded or unmeasured feed', () => {
  const derivations = [
    [fleetPassRate, 'percent'],
    [fleetMedianDuration, 'ms'],
    [fleetPhasesPerRun, 'average'],
    [fleetEscalationRate, 'percent'],
  ]
  const measuredRows = [
    { adw_id: 'ok', status: 'ok', duration_ms: 1000, phases: [{}], agents: [] },
    { adw_id: 'fail', status: 'fail', duration_ms: 2000, phases: [{}, {}], agents: [] },
  ]
  for (const [runs, options] of [[[], { degraded: true }], [measuredRows, { degraded: true }]]) {
    for (const [derive, key] of derivations) {
      const result = derive(runs, options)
      assert.equal(result[key], null)
      assert.notEqual(result[key], 0)
      assert.equal(typeof result.pending, 'string')
      assert.ok(result.pending.length)
      assert.match(result.pending, /degrad/i)
    }
  }
  for (const [derive, key] of derivations) {
    const result = derive([], { degraded: false })
    assert.equal(result[key], null)
    assert.notEqual(result[key], 0)
    assert.match(result.pending, /no run in this window carried a recorded outcome/i)
  }
})

test('the sessions derivations report a genuinely measured zero as a real zero', () => {
  const failedRuns = [
    { adw_id: 'fail-a', status: 'fail', phases: [], agents: [] },
    { adw_id: 'fail-b', status: 'fail', phases: [], agents: [] },
  ]
  const passRate = fleetPassRate(failedRuns, { degraded: false })
  const phases = fleetPhasesPerRun(failedRuns, { degraded: false })
  assert.equal(passRate.percent, 0)
  assert.equal(passRate.pending, null)
  assert.equal(phases.average, 0)
  assert.equal(phases.pending, null)

  const doneRuns = [
    { adw_id: 'done-a', status: 'ok', phases: [], agents: [] },
    { adw_id: 'done-b', status: 'ok', phases: [], agents: [] },
  ]
  const escalation = fleetEscalationRate(doneRuns, {
    degraded: false,
    envelopes: new Map([['done-a', { status: 'done' }], ['done-b', { status: 'done' }]]),
  })
  assert.equal(escalation.percent, 0)
  assert.equal(escalation.pending, null)
})

test('fleetEscalationRate counts only recorded escalations, never failures or aborts', () => {
  const run = (adw_id, status = 'ok', extra = {}) => ({ adw_id, status, phases: [], agents: [], ...extra })
  const terminal = fleetEscalationRate([run('aborted', 'aborted'), run('failed', 'fail'), run('ok')], { degraded: false })
  assert.equal(terminal.percent, 0)
  assert.equal(terminal.escalated, 0)

  const b52 = fleetEscalationRate([run('b52-heartbeat'), run('done')], {
    degraded: false,
    envelopes: new Map([
      ['b52-heartbeat', { status: 'escalation', details: { escalation: { where: 'build:r2', why: 'scope' } } }],
      ['done', { status: 'done' }],
    ]),
  })
  assert.equal(b52.percent, 50)

  const agent = fleetEscalationRate([run('agent', 'ok', { agents: [{ outcome: 'escalate' }] }), run('plain')], {
    degraded: false,
    envelopes: { agent: { status: 'done' }, plain: { status: 'done' } },
  })
  assert.equal(agent.percent, 50)
})

test('fleetEscalationRate does not count a run that did not escalate', () => {
  const result = fleetEscalationRate([
    { adw_id: 'a', status: 'ok', phases: [], agents: [{ outcome: 'ok' }] },
    { adw_id: 'b', status: 'ok', phases: [], agents: [{ outcome: 'ok' }] },
  ], {
    degraded: false,
    envelopes: { a: { status: 'done' }, b: { status: 'done' } },
  })
  assert.equal(result.escalated, 0)
  assert.equal(result.percent, 0)
  assert.notEqual(result.percent, null)
})

test('the board no longer probes task envelopes: lean lanes carry their status in the journal row', () => {
  const app = readFileSync(join(ROOT, 'visualizer/web/src/App.svelte'), 'utf8')
  for (const gone of ['probeEnvelopes', 'envelopeCache', 'envelopeQueued', 'getReturns', 'escalationProbeTargets']) assert.equal(app.includes(gone), false, gone)
  assert.match(app, /const envelopes = new Map\(\)/)
})

test('gateChips keeps unproven distinct from failed and proven', () => {
  const result = gateChips({ gate_generations: [
    { gate_generation: 1, verdict: 'failed' },
    { gate_generation: 2, verdict: 'unproven' },
    { gate_generation: 3, verdict: 'proven' },
  ] })
  const [failed, unproven, proven] = result.chips
  assert.notEqual(unproven.tone, failed.tone)
  assert.notEqual(unproven.label, failed.label)
  assert.doesNotMatch(unproven.label, /fail/i)
  assert.notEqual(proven.tone, failed.tone)
  assert.notEqual(proven.label, failed.label)
})

test('gateChips orders repaired generations oldest first', () => {
  const result = gateChips({ gate_generations: [
    { gate_generation: 2, verdict: 'proven' },
    { gate_generation: 1, verdict: 'failed' },
  ] })
  assert.equal(result.chips.length, 2)
  assert.equal(result.repaired, true)
  assert.deepEqual(result.chips.map((chip) => chip.generation), [1, 2])
})

test('gateChips leaves absent generations pending without a fabricated verdict', () => {
  const result = gateChips({ gate_generations: null, pending: { gate_discrimination: 'predates this measurement' } })
  assert.deepEqual(result.chips, [])
  assert.equal(result.repaired, false)
  assert.ok(result.pending)
})

test('gateProofStory turns ledger attempts into a decision path without changing their outcomes', () => {
  const summary = (total, failed, errored = 0) => [{ label:JSON.stringify({ total, failed, errored }) }]
  const result = gateProofStory([
    { gate_generation:1, gate_name:'gate-baseline', attempt:1, ok:0, checks:summary(4, 4) },
    { gate_generation:1, gate_name:'gate:r1', attempt:2, ok:1, checks:summary(4, 0) },
    { gate_generation:1, gate_name:'gate-proof:1', attempt:3, ok:0, pristine:1, checks:summary(4, 4) },
    { gate_generation:1, gate_name:'gate-proof:1:checks:m1', attempt:4, ok:0, checks:summary(4, 1) },
    { gate_generation:1, gate_name:'gate-proof:1:checks:m2', attempt:5, ok:1, checks:summary(4, 0) },
  ], 1, [{ gate_generation:1, verdict:'proven' }])
  assert.equal(result.headline, 'The gate distinguishes the built result')
  assert.deepEqual(result.stages.map((stage) => [stage.label, stage.result, stage.tone]), [
    ['Before work', 'Red as expected', 'expected'],
    ['Built result', 'Passed', 'expected'],
    ['Without built changes', 'Turned red', 'expected'],
  ])
  assert.deepEqual(result.mutation, { total:2, red:1, green:1, unknown:0, summary:'1 of 2 recorded mutation probes turned the gate red' })
  assert.equal(result.attempts[0].summary, '4 run · 4 failed · 0 errored')
})

test('reviewRows preserves null counts while retaining recorded zero', () => {
  const result = reviewRows({ reviews: [
    { dispatch_id: 'd1', role: 'reviewer', verdict: 'changes-needed', must_fix: null },
    { dispatch_id: 'd2', role: 'reviewer', verdict: 'pass', must_fix: 0 },
  ] })
  assert.equal(result.rows[0].round, 1)
  assert.equal(result.rows[0].must_fix, null)
  assert.notEqual(result.rows[0].must_fix, 0)
  assert.equal(result.rows[1].must_fix, 0)
  assert.equal(result.pending, null)
})

test('acceptRows keeps held and refused decisions visually distinct', () => {
  const result = acceptRows({ accept_decisions: [
    { outcome: 'accepted', where_at: 'review-exhausted', residual_count: 1, refuted_count: 0, cosmetic_count: 1, unverified_count: 0 },
    { outcome: 'escalated', where_at: 'review-exhausted', residual_count: 2, invalid_reasons: 'f1: unresolved' },
  ] })
  const [held, refused] = result.rows
  assert.equal(held.tone, 'held')
  assert.equal(held.label, 'accepted with residuals')
  assert.equal(refused.tone, 'refused')
  assert.equal(refused.label, 'accept refused — failed closed to escalate')
  assert.notEqual(held.tone, refused.tone)
  assert.equal(refused.invalid_reasons, 'f1: unresolved')
  assert.equal(result.refused, 1)
})

test('acceptRows leaves absent decisions pending without fabricated counts', () => {
  const result = acceptRows({ accept_decisions: null, pending: { accept_decisions: 'predates this measurement' } })
  assert.deepEqual(result.rows, [])
  assert.ok(result.pending)
  assert.notEqual(result.pending, 0)
})

test('findingRows distinguishes absent findings from an explicit empty measurement', () => {
  const measured = findingRows({ envelopes: [
    { role: 'reviewer', dispatch_seq: 3, details: { findings: [{ id: 'f1', severity: 'must-fix', location: 'src/a.js:1', summary: 'fix it' }] } },
    { role: 'reviewer', dispatch_seq: 4, details: {} },
  ] })
  assert.equal(measured.pending, null)
  assert.deepEqual(measured.groups[0].findings[0], { id: 'f1', severity: 'must-fix', location: 'src/a.js:1', summary: 'fix it' })
  const absent = findingRows({ envelopes: [{ details: {} }] })
  assert.ok(absent.pending)
  const empty = findingRows({ envelopes: [{ role: 'reviewer', dispatch_seq: 5, details: { findings: [] } }] })
  assert.equal(empty.pending, null)
  assert.equal(empty.groups[0].findings.length, 0)
})

test('hash routes parse and format every kept canonical view', () => {
  for (const hash of ['#/', '#/agents', '#/skills', '#/adw-123', '#/adw-123/plan']) {
    assert.equal(formatHash(parseHash(hash)), hash)
  }
  assert.deepEqual(parseHash(''), { view: 'fleet', adw_id: null, phase: null })
  assert.deepEqual(parseHash('#'), { view: 'fleet', adw_id: null, phase: null })
  assert.deepEqual(parseHash('#/adw-123/'), { view: 'run', adw_id: 'adw-123', phase: null })
  assert.deepEqual(parseHash('#/agents/ignored/extra'), { view: 'agents', adw_id: null, phase: null })
  // A dropped view's hash is read as a run id, never routed to a page that no longer exists.
  for (const dropped of ['ops', 'roster', 'prompts', 'workflows', 'assurances']) assert.equal(parseHash(`#/${dropped}`).view, 'run')
  assert.deepEqual(parseHash('#/adw-123/plan/ignored'), { view: 'phase', adw_id: 'adw-123', phase: 'plan' })
  assert.equal(parseHash('#/agents').adw_id, null)
  assert.equal(parseHash('#/skills').adw_id, null)
})

test('E1 agents page route nav and title are wired', () => {
  const root = join(ROOT, 'visualizer/web/src')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  const page = readFileSync(join(root, 'lib/AgentsPage.svelte'), 'utf8')
  assert.deepEqual(VIEWS, ['fleet', 'agents', 'skills', 'run', 'phase'])
  assert.match(app, /route\.view === 'agents'/)
  assert.match(app, /Agents · Factory/)
  assert.match(app, /<AgentsPage\s*\/?\s*>/)
  assert.match(app, /route\.view === 'agents'[^\n]*>Agents</)
  assert.match(page, /aria-label="Agent library"/)
})

test('skills-page:D1', () => {
  const root = join(ROOT, 'visualizer/web/src')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  const page = readFileSync(join(root, 'lib/SkillsPage.svelte'), 'utf8')
  assert.equal(formatHash(parseHash('#/skills')), '#/skills')
  assert.ok(app.includes("import SkillsPage from './lib/SkillsPage.svelte'"))
  assert.ok(app.includes('Skills · Factory'))
  assert.ok(app.includes("route.view === 'skills'"))
  assert.ok(app.includes('<SkillsPage />'))
  assert.match(app, />Skills<\//)
  assert.ok(page.includes('onsubmit={save}'))
  assert.match(page, /saveSkillFile\(\{name,text,expected_revision:editor.revision\}\)/)
  assert.ok(page.includes('Selection rules'))
  assert.ok(page.includes('Discard your unsaved skill changes?'))
  assert.doesNotMatch(page, /proposeSkills|Proposal only/)
  assert.doesNotMatch(page, /#[0-9a-f]{3,8}\b|rgb\(|--(?:ink|paper|spot|serious)/i)
})

test('skills-page:E1', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path: String(path), options })
    return new Response(JSON.stringify({ ok: true, diff: '--- a/crew/capabilities.json\\n+++ b/crew/capabilities.json', refusals: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await proposeSkills('builder', ['frontend-svelte'])
    assert.equal(result.ok, true)
    assert.match(result.diff, /capabilities\.json/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/api/skills/propose')
    assert.deepEqual(JSON.parse(calls[0].options.body), { role: 'builder', skills: ['frontend-svelte'] })
    assert.equal(calls[0].options.method, 'POST')
    assert.equal(calls[0].options.headers['content-type'], 'application/json')
    assert.doesNotMatch(calls[0].path, /\/apply(?:\?|$)/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('F1 agents page uses only Tier-2 colour aliases', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/AgentsPage.svelte'), 'utf8')
  const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ''
  const declarations = [...css.matchAll(/(?:^|[;{}])\s*[-a-z]+\s*:\s*([^;{}]+)/g)].map((match) => match[1].trim())
  assert.equal(css.includes('data-theme'), false)
  assert.equal(declarations.some((value) => /#[0-9a-f]{3,8}\b/i.test(value)), false)
  assert.equal(declarations.some((value) => /(?:^|\s)(?:white|black|red|blue|green|gray|grey)(?:\s|$)/i.test(value)), false)
  assert.equal(declarations.some((value) => /--(?:ink|paper|spot|serious|status-\w+-raw|role-\w+-(?:dark|light))/.test(value)), false)
  assert.ok(source.includes('background:var(--panel); border:1px solid var(--line);'))
  for (const token of ['Create agent', 'Use a copy', 'Save agent']) assert.ok(source.includes(token), token)
  for (const tab of ['Project library', 'Available on system']) assert.ok(source.includes(tab), tab); assert.doesNotMatch(source, /Skill delivery|skills-panel/); const skillsPage = readFileSync(join(ROOT, 'visualizer/web/src/lib/SkillDelivery.svelte'), 'utf8'); assert.match(skillsPage, /Skill delivery/); assert.match(skillsPage, /<th>Skill<\/th><th>Last recorded delivery<\/th>/); assert.match(skillsPage, /cell\?\.last_seat_delivery === true/)
})

test('fleet cells preserve honest absence and discriminate status evidence', () => {
  const now = Date.parse('2024-01-01T00:02:00.000Z')
  assert.equal(absenceMark(null).text, 'not measured')
  assert.equal(tokenCell({ metrics: { billed_input_tokens: null }, pending: { billed_input_tokens: 'predates this measurement' } }).value, null)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 5 } }).value, 20)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 5 } }).cacheRate, 5 / 18 * 100)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: null, billed_cache_read_tokens: 5 } }).cacheRate, null)
  assert.equal(costCell({ transport: 'pane' }).text, 'not measured · pane')
  assert.equal(heartbeatCell({ last_heartbeat_at: new Date(now - 4000).toISOString() }, now).text, '4s ago')
  assert.equal(heartbeatCell({ last_heartbeat_at: new Date(now - 91000).toISOString() }, now).text, 'silent 91s')
  assert.equal(heartbeatCell({ pending: { last_heartbeat_at: 'not measured' } }, now).dashed, true)
  assert.equal(deriveStatus({ status: 'aborted' }, null).key, 'aborted')
  const typedEscalated = deriveStatus({ status: 'aborted', settlement: { outcome: 'escalated' } }, null)
  assert.equal(typedEscalated.key, 'escalated')
  assert.equal(typedEscalated.word, 'escalated')
  const why = 'escalation evidence'
  const status = deriveStatus({ status: 'aborted', settlement: { outcome: 'escalated' } }, { status: 'escalation', details: { escalation: { where: 'gate', why } } })
  assert.equal(status.key, 'escalated')
  assert.equal(status.where, 'gate')
  assert.equal(status.why, why)
  const typedAborted = deriveStatus({ status: 'aborted', settlement: { outcome: 'aborted' } }, null)
  assert.equal(typedAborted.key, 'aborted')
  assert.equal(typedAborted.word, 'aborted')
  const typedSuccess = deriveStatus({ status: 'aborted', settlement: { outcome: 'success' } }, null)
  assert.equal(typedSuccess.key, 'success')
  assert.equal(typedSuccess.word, 'success')
  const typedFailed = deriveStatus({ status: 'aborted', settlement: { outcome: 'failed' } }, null)
  assert.equal(typedFailed.key, 'fail')
  assert.equal(typedFailed.word, 'failed')
  const legacyAborted = deriveStatus({ status: 'aborted', settlement: { outcome: null } }, null)
  assert.equal(legacyAborted.key, 'aborted')
  assert.equal(legacyAborted.word, 'aborted')
  assert.equal(new Set(['proven', 'failed', 'unproven'].map((verdict) => gateCell({ gate_generations: [{ verdict }] }).text)).size, 3)
  assert.equal(reviewCell({ reviews: [{ verdict: 'changes-needed' }, { verdict: 'pass' }] }).bounces, 1)
})

test('slotWaitCell preserves measured waits and honest absence', () => {
  const depthReason = 'no admission scan reported a queue depth for this wait — unmeasured, never a measured zero'
  const measuredUnknown = slotWaitCell({
    slot_waits: [{ waited_ms: 12_000, queue_depth: null, queue_depth_absent: depthReason }],
    slot_waits_absent: null,
  })
  assert.equal(measuredUnknown.text, 'waiting for a suite slot · 12s')
  assert.equal(measuredUnknown.dashed, false)
  assert.equal(measuredUnknown.depth, null)
  assert.equal(measuredUnknown.depth_text, 'queue depth unknown')
  assert.equal(measuredUnknown.depth_title, depthReason)
  assert.doesNotMatch(measuredUnknown.text, /0s/)
  assert.equal(slotWaitCell({ slot_waits: [], slot_waits_absent: null }), null)

  const measuredDepth = slotWaitCell({
    slot_waits: [{ waited_ms: 1_000, queue_depth: 3, queue_depth_absent: null }],
    slot_waits_absent: null,
  })
  assert.equal(measuredDepth.depth, 3)
  assert.equal(measuredDepth.depth_text, 'queue depth 3')

  const windowReason = 'no phase-slot-wait rows in this window — a corpus predating the ledger mirror for this event reads exactly like a window with no waits, so this is unmeasured and never a measured zero'
  const unmeasured = slotWaitCell({ slot_waits: null, slot_waits_absent: windowReason })
  assert.equal(unmeasured.value, null)
  assert.equal(unmeasured.dashed, true)
  assert.equal(unmeasured.text, windowReason)
  assert.doesNotMatch(unmeasured.text, /0s/)

  const card = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunCard.svelte'), 'utf8')
  assert.match(card, /import \{[^}]*slotWaitCell[^}]*\} from '\.\/fleet\.js'/)
  assert.match(card, /let slotWait = \$derived\(slotWaitCell\(run\)\)/)
  assert.match(card, /\{#if slotWait\}/)
  assert.match(card, /\{slotWait\.text\}/)
  assert.match(card, /\{slotWait\.depth_text\}/)
})

test('running records require a fresh heartbeat before the UI calls them live', () => {
  const now = Date.parse('2024-01-01T12:00:00.000Z')
  const fresh = { status: 'running', running: true, phases: [{}], last_heartbeat_at: new Date(now - 4000).toISOString() }
  const stale = { status: 'running', running: true, phases: [{}], last_heartbeat_at: new Date(now - 3_720_000).toISOString() }
  const unverified = { status: 'running', running: true, phases: [{}], pending: { last_heartbeat_at: 'not measured' } }
  assert.equal(runActivity(fresh, now).key, 'live')
  assert.equal(runActivity(stale, now).key, 'silent')
  assert.equal(runActivity(stale, now).word, 'stale · heartbeat 1h 2m ago')
  assert.equal(runActivity(unverified, now).key, 'unverified')
  assert.equal(deriveDisplayStatus(stale, null, now).key, 'silent')
  assert.deepEqual(fleetActivity([fresh, stale, unverified], now), { live: 1, silent: 1, contradicted: 0, unverified: 1, gone: 0, open: 3 })
})

test('K1: the top bar calls an unobserved run unsettled and runtime unconfirmed', () => {
  const stale = {
    running: true, settlement: { state: 'unsettled' },
    runtime: { driver_state: 'unknown', source: null },
    last_heartbeat_at: '2024-01-01T00:00:00.000Z',
  }
  assert.equal(runtimeActivitySummary([stale]), '1 unsettled · runtime unconfirmed')
  const activity = runActivity(stale, Date.parse('2024-01-01T12:00:00.000Z'))
  assert.equal(activity.key, 'unverified')
  assert.equal(activity.word, 'unsettled · runtime unconfirmed')
  assert.equal(activity.heartbeat.stale, true)
})

test('L1: the visualizer only copies the reconciliation command', () => {
  const detail = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  assert.match(detail, /Copy reconciliation command/)
  assert.match(detail, /await navigator\.clipboard\.writeText\(run\.reconciliation_command\)/)
  assert.doesNotMatch(detail, /fetch\(run\.reconciliation_command\)/)
})

test('fleet view pins escalations and silent runs and probes only non-green slugged runs', () => {
  const now = Date.parse('2024-01-01T00:05:00.000Z')
  const base = { repo_slug: 'repo', status: 'ok', running: false, phases: [{ seq: 1 }], started_at: '2024-01-01T00:00:00.000Z', duration_ms: 1000, metrics: {}, pending: {}, reviews: null, gate_generations: null, triage: { reviewed_at: null } }
  const runs = [
    { ...base, adw_id: 'ok', goal: 'ok' },
    { ...base, adw_id: 'esc', goal: 'esc', status: 'aborted' },
    { ...base, adw_id: 'silent', goal: 'silent', status: 'running', running: true, last_heartbeat_at: new Date(now - 91000).toISOString() },
    { ...base, adw_id: 'slugless', goal: null },
    { ...base, adw_id: 'archived', goal: 'archived', triage: { reviewed_at: '2024-01-01T00:01:00.000Z' } },
  ]
  const why = 'needs human attention'
  const view = fleetView(runs, { now, envelopes: new Map([['esc', { status: 'escalation', details: { escalation: { where: 'gate', why } } }]]) })
  assert.equal(view.rail[0].adw_id, 'esc')
  assert.equal(view.rail[0].why, why)
  assert.ok(view.rail.some((row) => row.adw_id === 'silent'))
  assert.equal(view.hidden.count, 2)
  assert.equal(view.rows.length, 3)
  assert.deepEqual(escalationProbeTargets(runs), ['esc', 'silent'])
  assert.equal(fleetView(runs, { now, filters: { hide_slugless: false, hide_archived: false } }).hidden.count, 0)
})

test('fleet surfaces pin honest cost, heartbeat, and escalated status tone', () => {
  const now = Date.parse('2024-01-01T00:05:00.000Z')
  const base = {
    repo_slug: 'repo', status: 'ok', running: false, phases: [{ seq: 1 }], metrics: {},
    triage: { reviewed_at: null }, pending: {},
  }
  const pane = {
    ...base,
    adw_id: 'pane',
    goal: 'pane run',
    pending: { billed_cost_usd: 'money deferred — a subscription seat is not billed per token (#185)' },
  }
  const unmeasured = { ...base, adw_id: 'unmeasured', goal: 'unmeasured run' }
  const rows = fleetView([pane, unmeasured], { now }).rows
  assert.equal(rows[0].cost.text, 'not measured · pane')
  assert.equal(rows[0].cost.value, null)
  assert.equal(rows[0].cost.dashed, true)
  assert.equal(rows[1].cost.value, null)
  assert.equal(rows[1].cost.dashed, true)
  assert.notEqual(rows[1].cost.text, '0')

  const root = join(ROOT, 'visualizer/web/src/lib')
  const table = readFileSync(join(root, 'FleetTable.svelte'), 'utf8')
  assert.match(table, /duration<\/th><th class="micro">tokens<\/th><th class="micro">cost<\/th><th class="micro">heartbeat<\/th>/)
  assert.match(table, /\{@render mark\(row\.cost\)\}/)
  assert.match(table, /row\.heartbeat/)
  assert.match(table, /class:stale=\{row\.heartbeat\.stale\}/)
  assert.match(table, /\.stale \{ color:var\(--status-escalated\); \}/)
  assert.doesNotMatch(table, /\.status\.ok,\s*\.status\.serious\s*\{\s*color:var\(--status-ok\)/)
  assert.match(table, /\.status\.serious\s*\{\s*color:var\(--status-escalated\)/)
  const card = readFileSync(join(root, 'RunCard.svelte'), 'utf8')
  assert.match(card, /status-dot[\s\S]*status\.word/)
  assert.match(card, /\{#each run\.agents as agent \(agent\.key\)\}/)
  assert.doesNotMatch(card, /\{#each run\.agents as agent \(agent\.dispatch_id\)\}/)
})

test('return probing shares one six-request semaphore across refresh generations', async () => {
  const semaphore = createSemaphore(2)
  let active = 0
  let maximum = 0
  const releases = []
  const tasks = Array.from({ length: 4 }, () => semaphore.run(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => releases.push(resolve))
    active -= 1
  }))
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  await tick()
  assert.equal(active, 2)
  while (releases.length) {
    releases.shift()()
    await tick()
  }
  await Promise.all(tasks)
  assert.equal(maximum, 2)
})

test('role colour stays isolated and escalation reasons remain in task history', () => {
  const root = join(ROOT, 'visualizer/web/src')
  for (const file of ['App.svelte', 'lib/FleetTable.svelte', 'lib/RunCard.svelte', 'lib/Filters.svelte']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /--role-|--lane-\d/)
  }
  const tag = readFileSync(join(root, 'lib/RoleTag.svelte'), 'utf8')
  assert.match(tag, /--role-|--lane-/)
  assert.match(tag, /\{\s*role\s*\}/)
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  assert.match(app, /\.filter\(\(row\) => needsAttention\(row\.status\.key\)/)
  const tasks = readFileSync(join(root, 'lib/TaskList.svelte'), 'utf8')
  assert.match(tasks, /Why review\?/)
  assert.match(tasks, /status\.why/)
  assert.doesNotMatch(app, /class="attention-list"/)
  assert.doesNotMatch(app, /getReturns|probeEnvelopes|returnRequestSemaphore/)
})

test('laneRows names lanes by event role and collapses an empty seat', () => {
  const run = {
    phase_lanes: 'agent',
    phases: [{ id: 1, lane: 1, name: 'build:r1' }],
    agents: [{ dispatch_id: 'd1', role: 'builder', lane: 1 }, { dispatch_id: 'd2', role: 'lead', lane: 4 }],
  }
  const events = [{ type: 'agent_start', phase_id: 1, payload_json: '{"role":"builder"}' }]
  const result = laneRows(run, events)
  assert.equal(result.lanes[0].role, 'builder')
  assert.deepEqual(result.collapsed, [{ lane: 4, role: 'lead' }])
})

test('laneRows keeps effort and context dashed without a fabricated zero', () => {
  const result = laneRows({ phase_lanes: 'agent', phases: [{ id: 1, lane: 1 }], agents: [{ role: 'builder', lane: 1 }] })
  const header = result.lanes[0].header
  assert.equal(header.effort_mark.dashed, true)
  assert.equal(header.context_mark.dashed, true)
  assert.equal(/(?:^|[^0-9.])0(?:[^0-9%]|$)/.test(JSON.stringify({ effort: header.effort_mark, context: header.context_mark })), false)
})

test('laneRows shows a measured model beside an unmeasured effort mark', () => {
  const result = laneRows({ phase_lanes: 'agent', phases: [{ id: 1, lane: 1 }], agents: [{ role: 'builder', lane: 1, model: 'model/live' }] })
  assert.equal(result.lanes[0].header.model, 'model/live')
  assert.equal(result.lanes[0].header.model_mark, null)
  assert.equal(result.lanes[0].header.effort_mark.dashed, true)
})

test('laneRows does not deny an agent-backed row when context columns are NULL', () => {
  const result = laneRows({ phase_lanes: 'agent', phases: [{ id: 1, lane: 1 }], agents: [{ role: 'builder', lane: 1 }] })
  const title = result.lanes[0].header.context_mark.title
  assert.doesNotMatch(title, /no agent_sessions row at all/)
  assert.match(title, /both columns NULL/)
  assert.match(title, /U-4/)
})

test('laneRows explains an unmeasured model without denying its agent row', () => {
  const result = laneRows({ phase_lanes: 'agent', phases: [{ id: 1, lane: 1 }], agents: [{ role: 'builder', lane: 1 }] })
  const title = result.lanes[0].header.model_mark.title
  assert.doesNotMatch(title, /no agent_sessions row for this dispatch/)
  assert.match(title, /no agent_sessions row carries a model/)
})

test('laneRows gives a seat-supplied context reason precedence over the constant', () => {
  const result = laneRows({ phase_lanes: 'agent', phases: [{ id: 1, lane: 1 }], agents: [{ role: 'builder', lane: 1, context_pending: 'seat supplied context reason' }] })
  assert.equal(result.lanes[0].header.context_mark.title, 'seat supplied context reason')
})

test('bounceArrows pairs changes-needed reviews and distinguishes null from zero', () => {
  const result = bounceArrows({ phases: [{ id: 1, seq: 1, name: 'review:r1' }, { id: 2, seq: 2, name: 'build:r2' }, { id: 3, seq: 3, name: 'review:r2' }, { id: 4, seq: 4, name: 'build:r3' }], reviews: [{ verdict: 'changes-needed', must_fix: null }, { verdict: 'changes-needed', must_fix: 0 }] })
  assert.equal(result.arrows[0].must_fix, null)
  assert.equal(result.arrows[0].label, 'must-fix —')
  assert.equal(result.arrows[1].must_fix, 0)
  assert.notEqual(result.arrows[0].label, result.arrows[1].label)
})

test('bounceArrows reports pending reviews instead of empty measured output', () => {
  const result = bounceArrows({ reviews: null, pending: { reviews: 'predates this measurement' } })
  assert.deepEqual(result.arrows, [])
  assert.equal(result.pending, 'predates this measurement')
})

test('gateMarkers keeps proven failed and unproven tones distinct', () => {
  const result = gateMarkers({
    gate_generations: [
      { gate_generation: 1, verdict: 'failed' },
      { gate_generation: 2, verdict: 'unproven' },
      { gate_generation: 3, verdict: 'proven', checks_total: 11, checks_failed: 9, checks_errored: 0 },
    ],
    gate_checks: [],
  })
  assert.equal(new Set(result.markers.map((marker) => marker.tone)).size, 3)
  assert.equal(result.markers[0].label, 'Gate G1 · Failed proof')
  assert.equal(result.markers[1].label, 'Gate G2 · Proof incomplete')
  assert.equal(result.markers[2].label, 'Gate G3 · Proven')
  assert.match(result.markers[2].title, /turned red when those changes were removed/i)
  assert.match(result.markers[2].title, /9 failed · 0 errored · 11 checks/)
})

test('phasePanel resolves names, rejects unknown routes, and scopes events', () => {
  const run = { phases: [{ id: 1, name: 'build:r1', lane: 1, duration_ms: 10 }], gate_checks: [{ phase_id: 1, gate_generation: 1, checks: [{ label: 'check', note: 'note' }] }], gate_generations: [{ gate_generation: 1, verdict: 'proven' }], accept_decisions: [] }
  const events = [{ id: 1, phase_id: 1 }, { id: 2, phase_id: 9 }]
  assert.equal(phasePanel(run, { phase: 'build:r1', events }).found, true)
  assert.deepEqual(phasePanel(run, { phase: 'build:r1', events }).events.map((event) => event.phase_id), [1])
  assert.equal(phasePanel(run, { phase: 'missing', events }).found, false)
})

test('event-stream phase filters resolve route names to ledger phase ids', () => {
  const run = { phases: [{ id: 148, name: 'planning' }, { id: 153, name: 'escalation' }] }
  assert.equal(phaseFilterId(run, 'planning'), 148)
  assert.equal(phaseFilterId(run, '153'), 153)
  assert.equal(phaseFilterId(run, ''), '')
})

test('event stories translate low-level rows without discarding their evidence', () => {
  const phases = [{ id: 148, name: 'planning' }]
  const started = eventStory({ type:'agent_start', seq:2, phase_id:148, payload_json:JSON.stringify({ role:'planner', dispatch_id:'d1' }) }, phases)
  assert.equal(started.title, 'Planner started a turn')
  assert.equal(started.phase, 'Planning')
  assert.equal(started.dispatch, 'd1')

  const ended = eventStory({ type:'agent_end', seq:3, phase_id:148, payload_json:JSON.stringify({ role:'planner', dispatch_id:'d1', outcome:'insufficient' }) }, phases)
  assert.equal(ended.title, 'Planner reported insufficient context')
  assert.equal(ended.tone, 'warn')

  const decision = eventStory({ type:'decision', seq:4, phase_id:148, payload_json:JSON.stringify({ decided:'escalate', why:'operator action required' }) }, phases)
  assert.equal(decision.title, 'Decision: Escalate')
  assert.equal(decision.detail, 'operator action required')
  assert.match(decision.raw, /operator action required/)
})

test('event stories name workflow markers and summarize the visible sequence', () => {
  const events = [
    { type:'log', payload_json:JSON.stringify({ level:'info', message:'plan:r2' }) },
    { type:'agent_start' }, { type:'agent_end' }, { type:'decision' },
  ]
  assert.equal(eventStory(events[0]).title, 'Planning round 2 reached')
  assert.equal(eventStory({ type:'log', payload_json:JSON.stringify({ message:'scope-gate:r1' }) }).title, 'Scope check round 1 reached')
  assert.equal(eventStory({ type:'log', payload_json:JSON.stringify({ message:'suite:cold' }) }).title, 'Cold validation reached')
  assert.equal(eventStory({ type:'log', payload_json:JSON.stringify({ message:'gate-proof:2:checks' }) }).title, 'Gate proof 2 checks recorded')
  assert.deepEqual(eventStreamSummary(events), { total:4, starts:1, ends:1, decisions:1, logs:1 })
})

test('agent return stories group attempts and surface role-specific evidence', () => {
  const envelopes = [
    { role:'builder', dispatch_seq:4, status:'done', valid:true, artifacts:['a.js'], details:{ files_changed:['a.js'], validation:'suite green', commit_message:'fix it' } },
    { role:'planner', dispatch_seq:1, status:'done', valid:true, artifacts:['plan.md'], details:{ files_in_scope:['a.js','b.js'], baseline_gate_summary:'GATE-SUMMARY {"total":5,"failed":1}' } },
    { role:'builder', dispatch_seq:2, status:'done', valid:true, artifacts:[], details:{} },
  ]
  assert.deepEqual(envelopeGroups(envelopes).map((group) => [group.role, group.entries.map((entry) => entry.dispatch_seq)]), [['planner',[1]],['builder',[2,4]]])
  assert.deepEqual(envelopeOverview(envelopes, { status:'done' }), { returns:3, roles:2, completed:3, invalid:0, retries:1, taskStatus:'done' })
  assert.ok(envelopeFacts(envelopes[0]).some((fact) => fact.label === 'Changed' && fact.value === '1 file'))
  assert.ok(envelopeFacts(envelopes[1]).some((fact) => fact.label === 'Gate checks' && fact.value === '5'))
  assert.deepEqual(envelopeSections(envelopes[0]).map((section) => section.heading), ['Validation performed','Commit intent','Files changed'])
})

test('trajectory stories separate handoffs from factory stages and explain journal rows', () => {
  const view = { spans:[
    { family:'stage', actor:'driver', label:'gate:r1', started_at:0, ended_at:100, duration_ms:100 },
    { family:'assignment', id:'d1', role:'planner', status:'done', started_at:10, ended_at:70, duration_ms:60, markers:[] },
    { family:'assignment', id:'d2', role:'builder', status:null, started_at:80, ended_at:null, markers:[{ event:'seat-retrying' }] },
  ] }
  assert.deepEqual(trajectorySummary(view), { handoffs:2, completed:1, inFlight:1, seatIncidents:1, substrateOutages:0, driverStages:1 })
  assert.deepEqual(assignmentPath(view).map((item) => [item.dispatch,item.role,item.outcome]), [['d1','planner','outcome not recorded'],['d2','builder','in flight']])
  assert.equal(trajectoryRowStory({ event:'row', row:{ assign:'d2', role:'builder', brief:'/tmp/plan.md' } }).title, 'Builder received d2')
  assert.equal(trajectoryRowStory({ event:'row', row:{ review_outcome:{ verdict:'pass', findings:[], must_fix:0 } } }).title, 'Review pass')
})

test('acceptEvidence joins lead evidence and reports missing evidence separately', () => {
  const run = { accept_decisions: [{ outcome: 'accepted', refuted_count: 2, residual_count: 0 }] }
  const returns = { envelopes: [{ role: 'lead', dispatch_seq: 1, details: { refuted: [{ id: 'f1', why: 'closed' }], residuals: [] } }] }
  const joined = acceptEvidence(run, returns)
  assert.deepEqual(joined.rows[0].evidence.map((item) => item.id), ['f1'])
  const pending = acceptEvidence(run, { envelopes: [] }).rows[0].evidence_pending
  assert.match(pending, /counts are recorded.*evidence is not/i)
  assert.doesNotMatch(pending, /no refutations/i)
})

test('renderMarkdown returns typed safe blocks and keeps markup literal', () => {
  const blocks = renderMarkdown('# Title\n\n<script>alert(1)</script>\nnext paragraph\n\n1. first\n2. second\n\nBLOCKER (scope): operator action required\n\n- <img onerror=...>')
  assert.ok(blocks.some((block) => block.kind === 'heading'))
  assert.ok(blocks.some((block) => block.kind === 'list'))
  assert.ok(blocks.some((block) => block.kind === 'list' && block.ordered === true))
  assert.ok(blocks.some((block) => block.kind === 'callout' && block.tone === 'serious'))
  assert.equal(blocks.filter((block) => block.kind === 'paragraph').length, 2)
  assert.match(JSON.stringify(blocks), /alert\(1\)/)
  assert.match(JSON.stringify(blocks), /onerror/)
  assert.equal(typeof blocks, 'object')
})

test('phase artifacts keep return narratives separate and deduplicate file evidence', () => {
  const panel = phasePanel({ phases:[{ id:1, name:'planning' }] }, { phase:'planning', events:[
    { type:'agent_start', phase_id:1, payload:{ dispatch_id:'d1', role:'planner' } },
    { type:'agent_end', phase_id:1, payload:{ dispatch_id:'d1', role:'planner' } },
    { type:'agent_start', phase_id:1, payload:{ dispatch_id:'d3', role:'lead' } },
    { type:'agent_end', phase_id:1, payload:{ dispatch_id:'d3', role:'lead' } },
  ], returns:{ envelopes:[
    { role:'planner', dispatch_seq:1, status:'done', summary:'BLOCKER: first return', artifacts:['task/plan.md'] },
    { role:'lead', dispatch_seq:3, status:'done', summary:'Escalate with context.', artifacts:['task/plan.md','returns/d3.json'] },
  ] } })
  assert.deepEqual(panel.artifacts.documents.map((document) => document.role), ['lead','planner'])
  assert.equal(panel.artifacts.paths.length, 2)
  assert.deepEqual(panel.artifacts.paths.find((artifact) => artifact.path === 'task/plan.md').sources, ['planner d1','lead d3'])
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhasePanel.svelte'), 'utf8')
  assert.match(source, /let documentOpen = \$state\(\{\}\)/)
  assert.match(source, /ontoggle=\{\(event\) => rememberDocument\(event, document\)\}/)
  assert.doesNotMatch(source, /open=\{index === 0\}/)
})

test('phase inspection explains factory checkpoints and suppresses empty gate counters', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhasePanel.svelte'), 'utf8')
  assert.match(source, /Task completion recorded/)
  assert.match(source, /No agent lane owned this checkpoint/)
  assert.match(source, /What this establishes/)
  assert.match(source, /How the gate was proved/)
  assert.match(source, /formatted from the ledger/)
  assert.doesNotMatch(source, /check\.label/)
  assert.doesNotMatch(source, /gate verdict unavailable/)
  assert.doesNotMatch(source, /unlinked.*lane/)
  const panel = phasePanel({ phases: [{ id: 1, name: 'done', status: 'ok' }, { id: 2, name: 'build', status: 'ok' }], gate_checks: [{ phase_id: 2, gate_generation: 1, checks: [] }], gate_generations: [{ gate_generation: 1, verdict: 'proven' }] }, { phase: 1, events: [], returns: { envelopes: [] } })
  const gateEntry = panel.footer.find((entry) => entry.reason === 'no-gate-in-phase')
  assert.ok(gateEntry)
  assert.match(gateEntry.text, /Validation evidence is attached to/)
})

test('trace source tripwires keep route, role order, and server read-only', () => {
  const root = join(ROOT, 'visualizer')
  const runDetail = readFileSync(join(root, 'web/src/lib/RunDetail.svelte'), 'utf8')
  const eventStream = readFileSync(join(root, 'web/src/lib/EventStream.svelte'), 'utf8')
  assert.ok(runDetail.includes('phase = null') && runDetail.includes('$props()'))
  assert.ok(runDetail.includes("import PhasePanel from './PhasePanel.svelte'"))
  assert.ok(eventStream.includes('phaseFilterId(run, requested)'))
  assert.ok(eventStream.includes('untrack(() =>'))
  for (const file of ['AcceptPanel.svelte', 'EnvelopeInspector.svelte', 'MarkdownView.svelte', 'PhaseGantt.svelte', 'PhasePanel.svelte', 'ReviewPanel.svelte', 'RunDetail.svelte']) {
    assert.equal(readFileSync(join(root, 'web/src/lib', file), 'utf8').includes('{@html'), false)
  }
  assert.deepEqual([...ROLE_ORDER], ['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver'])
})

test('PhaseGantt resolves identity by lane key rather than timeline row position', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.ok(source.includes('identityFor(lane)'))
  assert.equal(source.includes('identities.lanes[laneIndex]'), false)
})

test('PhaseGantt renders every gate marker attached to a block', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.ok(source.includes('markersFor(block.phase_id)'))
  assert.match(source, /#each markers as marker/)
})

test('phasePanel retains checks from every gate retry on one phase', () => {
  const run = {
    phases: [{ id: 1, name: 'build:r1' }],
    gate_checks: [
      { phase_id: 1, gate_generation: 1, attempt: 1, checks: [{ label: 'first', note: 'first note' }] },
      { phase_id: 1, gate_generation: 2, attempt: 1, checks: [{ label: 'second', note: 'second note' }] },
    ],
    gate_generations: [{ gate_generation: 1, verdict: 'failed' }, { gate_generation: 2, verdict: 'proven' }],
  }
  const checks = phasePanel(run, { phase: 'build:r1' }).gate.checks
  assert.deepEqual(checks.map((check) => check.label), ['first', 'second'])
})

test('acceptEvidence joins lead evidence to measured reviewer finding ids', () => {
  const run = { accept_decisions: [{ outcome: 'accepted', refuted_count: 1 }] }
  const returns = { envelopes: [
    { role: 'reviewer', details: { findings: [{ id: 'f1', summary: 'real' }] } },
    { role: 'lead', dispatch_seq: 2, details: { refuted: [{ id: 'f1', why: 'closed' }, { id: 'stale', why: 'foreign' }] } },
  ] }
  const evidence = acceptEvidence(run, returns).rows[0].evidence
  assert.deepEqual(evidence.map((item) => item.id), ['f1'])
})

// RV3-1: a residual recorded as a bare string carries its text in the item
// itself, not in a .why property. Reading only object properties emptied it,
// and the finding-id join then dropped it outright — recorded evidence lost.
test('acceptEvidence renders a bare-string residual and never drops it for lacking an id', () => {
  const run = { accept_decisions: [{ outcome: 'accepted', residual_count: 1 }] }
  const returns = { envelopes: [
    { role: 'reviewer', details: { findings: [{ id: 'f1', summary: 'real' }] } },
    { role: 'lead', dispatch_seq: 2, details: { residuals: ['a plain string residual'] } },
  ] }
  const row = acceptEvidence(run, returns).rows[0]
  const strings = row.evidence.filter((item) => item.kind === 'residual')
  assert.equal(strings.length, 1, 'the id-less residual was dropped by the finding-id join')
  assert.equal(strings[0].why, 'a plain string residual')
  assert.ok(
    JSON.stringify(strings[0].blocks).includes('a plain string residual'),
    'the residual rendered as empty markdown, hiding recorded evidence',
  )
})

// RV3-1b: a foreign id is still dropped. The fix above must not turn the join
// off — only items that cannot be matched at all are exempt from it.
test('acceptEvidence still drops evidence whose id the findings array does not know', () => {
  const run = { accept_decisions: [{ outcome: 'accepted', refuted_count: 1 }] }
  const returns = { envelopes: [
    { role: 'reviewer', details: { findings: [{ id: 'f1', summary: 'real' }] } },
    { role: 'lead', dispatch_seq: 2, details: { refuted: [{ id: 'stale', why: 'foreign' }] } },
  ] }
  assert.deepEqual(acceptEvidence(run, returns).rows[0].evidence.map((item) => item.id), [])
})

// RV3-2: a recorded nonzero cosmetic count with no evidence items must explain
// itself, not render an unexplained empty area.
test('acceptEvidence explains a pending cosmetic count', () => {
  const run = { accept_decisions: [{ outcome: 'accepted', cosmetic_count: 2 }] }
  const pending = acceptEvidence(run, { envelopes: [] }).rows[0].evidence_pending
  assert.match(pending, /counts are recorded.*evidence is not/i)
})

test('PhaseGantt draws named bounce connectors inside the timeline layer', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.match(source, /class="bounce-layer"/)
  assert.ok(source.includes('connectorPath(from, to)'))
  assert.ok(source.includes('connectorLabel(from, to, arrow)'))
  assert.match(source, /Review → rework/)
  assert.match(source, /Review requested changes:/)
  assert.match(source, /class="bounce-hit-layer"/)
  assert.match(source, /class="bounce-hotspot"/)
  assert.match(source, /role="tooltip"/)
})

test('PhaseGantt offsets bounce SVG to the geometry track column', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.ok(source.includes('--identity-column:17rem'))
  assert.ok(source.includes('--lane-gap:.6rem'))
  assert.ok(source.includes('left:calc(var(--identity-column) + var(--lane-gap))'))
  assert.ok(source.includes('width:calc(100% - var(--identity-column) - var(--lane-gap))'))
})

test('PhaseGantt starts its round connector below the phase number', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.match(source, /waterfall-row\.has-rounds \.phase-meta::before/)
  assert.ok(source.includes('top:calc(50% + .72rem)'))
})

test('PhaseGantt keeps compact gate proof badges readable on narrow bars', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.match(source, /gateChipLabel\(marker\)/)
  assert.match(source, /\.bar \{[^}]*overflow:visible/)
  assert.match(source, /\.bar > span,\.gate \{ flex:0 0 auto; \}/)
})

test('PhaseGantt clears a selected child when a phase is chosen', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  const handler = source.match(/function choosePhase\(block\) \{([^}]*)\}/)?.[1] || ''
  assert.match(handler, /selectedStep = null/)
  assert.match(handler, /onselectphase\(block\.phase_id \?\? block\.name\)/)
  assert.match(source, /onclick=\{\(\) => choosePhase\(block\)\}/)
  assert.match(source, /resolveSelectedPhaseId\(selected\)/)
  assert.match(source, /sameId\(block\.phase_id, selectedPhaseId\)/)
})

test('factory step trace projects measured journal spans into their owning phase', () => {
  const journalState = { payload:{ rows:[
    { at:1000, event:'boot', seats:{ builder:{ model:'openai/gpt-test', effort:'high' } } },
    { at:1100, stage:'build:r1' },
    { at:1150, assign:'d1', role:'builder' },
    { at:1200, stage:'gate:r1' },
    { at:1400, stage_done:'gate:r1' },
    { at:1700, envelope:'d1', role:'builder', status:'done' },
    { at:1800, stage_done:'build:r1' },
  ], channels:{ operational:null } }, error:'' }
  const timeline = { blocks:[{ phase_id:7, name:'building', started_at:1000, ended_at:2000, x:.1, width:.8, status:'ok' }] }
  const trace = factoryStepTrace(journalState, timeline, { now:2000 })
  assert.equal(trace.unavailable, null)
  assert.equal(trace.steps.length, 2)
  assert.deepEqual(trace.steps.map((step) => [step.name, step.category.label, step.phase]), [
    ['Build · round 1', 'Agent work', 'building'],
    ['Gate · round 1', 'Validation', 'building'],
  ])
  assert.deepEqual(trace.steps.map((step) => step.kind), ['agent','control'])
  assert.deepEqual(trace.steps.map((step) => [Number(step.x.toFixed(2)), Number(step.width.toFixed(2))]), [[.18,.56],[.26,.16]])
  assert.equal(trace.steps[1].depth, 1)
  assert.deepEqual(trace.steps.map((step) => step.handoffs.map((handoff) => [handoff.role, handoff.id])), [[['builder','d1']],[]])
  assert.deepEqual(trace.steps[0].handoffs.map((handoff) => [handoff.model, handoff.effort, handoff.state.label]), [['openai/gpt-test','high','Returned']])
  assert.deepEqual(
    [trace.steps[0].coverage.stage_ms, trace.steps[0].coverage.seat_ms, trace.steps[0].coverage.factory_only_ms],
    [700, 550, 150],
  )
  assert.deepEqual(trace.steps[0].coverage.gaps.map((gap) => gap.duration_ms), [50, 100])
  assert.deepEqual(
    trace.steps[1].handoffs.map((handoff) => [Number(handoff.x.toFixed(2)), Number(handoff.width.toFixed(2))]),
    [],
  )
})

test('profile evidence consumes declaration order and measured envelope families', () => {
  const returns = { envelopes: [
    { assignment_id:'r1', dispatch_seq:1, role:'reviewer', details:{ findings:[{ id:'f1', severity:'must-fix', evidence:'a.js:1' }] } },
    { assignment_id:'q1', dispatch_seq:2, role:'reviewer', details:{ check_matrix:[{ id:'v1', status:'passed', command:'node --test', result:'green', evidence:'tap' }] } },
    { assignment_id:'b1', dispatch_seq:3, role:'builder', details:{ reproduction:'fails before fix', reproduction_or_cited_failure:'fails before fix', validation:'green', mutations:[{ check:'m1', status:'passed' }] } },
  ] }
  const review = profileEvidenceView('code_review', returns)
  assert.deepEqual(review.blocks.map((block) => block.key), ['base_head_identity', 'structured_findings', 'severity', 'citations', 'zero_source_writes'])
  assert.match(review.blocks.find((block) => block.key === 'structured_findings').summary, /1 finding recorded/)
  assert.match(review.blocks.find((block) => block.key === 'citations').summary, /1 citation recorded/)
  const implementation = profileEvidenceView('implementation', returns)
  assert.deepEqual(implementation.blocks.map((block) => block.key), ['scoped_diff', 'validation', 'review', 'terminal_result'])
  assert.equal(implementation.blocks.find((block) => block.key === 'scoped_diff').summary, 'Not recorded')
  const verification = profileEvidenceView('qa_verification', returns)
  assert.match(verification.blocks.find((block) => block.key === 'checks_run').summary, /1 verification check recorded/)
  const bug = profileEvidenceView('bug_fix', returns)
  assert.match(bug.blocks.find((block) => block.key === 'reproduction_or_cited_failure').summary, /fails before fix/)
  assert.match(bug.blocks.find((block) => block.key === 'fix_validation').summary, /green/)
  const authored = profileEvidenceView('test_authoring', returns)
  assert.match(authored.blocks.find((block) => block.key === 'mutation_or_negative_control').summary, /1 mutation/)
})

test('profile evidence keeps historical and empty payloads explicit', () => {
  const absent = profileEvidenceView(null, { envelopes:[{ role:'reviewer', details:{} }] })
  assert.deepEqual(absent.blocks.map((block) => block.key), ['structured_findings', 'checks_run', 'reproduction_or_cited_failure', 'mutation_or_negative_control'])
  assert.equal(absent.profile.key, null)
  assert.equal(absent.profile.label, 'Not recorded')
  assert.equal(absent.profile_specific, false)
  assert.equal(absent.blocks.every((block) => block.summary === 'Not recorded'), true)
  const empty = profileEvidenceView('code_review', { envelopes:[{ role:'reviewer', details:{ findings:[] } }] })
  assert.match(empty.blocks.find((block) => block.key === 'structured_findings').summary, /0 finding/)
  assert.equal(empty.blocks.find((block) => block.key === 'structured_findings').measured, true)
  assert.equal(profileEvidenceView('unknown-profile', {}).profile.key, null)
})

test('RV1-1 profile evidence array references use distinct RunDetail keys', () => {
  const view = profileEvidenceView('code_review', { envelopes:[{
    dispatch_seq:4,
    role:'reviewer',
    details:{ findings:[
      { id:'f1', severity:'must-fix', evidence:'a.js:1' },
      { id:'f2', severity:'should-fix', evidence:'b.js:2' },
    ] },
  }] })
  const references = view.blocks.find((block) => block.key === 'structured_findings').references
  assert.deepEqual(references.map((reference) => `${reference.dispatch_seq}-${reference.field}-${reference.role}`), ['4-findings-reviewer', '4-findings-reviewer'])
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  assert.ok(source.includes("{#each block.references as reference, index (`${reference.dispatch_seq ?? 'task'}-${reference.field}-${reference.role ?? 'unknown'}-${index}`)}"))
})

test('RV1-2 execution topology de-duplicates repeated undeclared journal labels', () => {
  const topology = executionTopology('scout', [
    'commit:r1', 'commit:r1', 'scout:r1', 'scout:r1', 'scope-gate:r1', 'scope-gate:r1', 'envelope-accept',
  ], { complete:true })
  assert.deepEqual(topology.defects.filter((defect) => defect.kind === 'undeclared'), [
    { kind:'undeclared', stage:'commit:r1', message:'Stage commit:r1 was not declared by scout.' },
  ])
  assert.deepEqual(topology.undeclared, ['commit:r1'])
})

test('execution topology reports settled gaps, undeclared stages, and pending work', () => {
  const missing = executionTopology('scout', ['scout:r1', 'envelope-accept'], { complete:true })
  assert.equal(missing.rows.find((row) => row.stage === 'scope-gate').status, 'missing')
  assert.deepEqual(missing.defects.find((defect) => defect.kind === 'missing'), { kind:'missing', stage:'scope-gate', message:'Expected stage scope-gate was not recorded.' })
  const undeclared = executionTopology('scout', ['scout:r1', 'scope-gate:r1', 'commit:r1', 'envelope-accept'], { complete:true })
  assert.deepEqual(undeclared.defects.find((defect) => defect.kind === 'undeclared'), { kind:'undeclared', stage:'commit:r1', message:'Stage commit:r1 was not declared by scout.' })
  assert.equal(undeclared.rows.some((row) => row.stage === 'commit:r1'), false)
  const complete = executionTopology('scout', ['scout:r1', 'scope-gate:r1', 'envelope-accept'], { complete:true })
  assert.deepEqual(complete.defects, [])
  const pending = executionTopology('scout', ['scout:r1'], { complete:false })
  assert.equal(pending.defects.length, 0)
  assert.equal(pending.rows.find((row) => row.stage === 'scope-gate').status, 'pending')
  assert.deepEqual(executionTopology(null, ['scout:r1'], { complete:true }), {
    execution_shape:null, status:'not-recorded', measured:false, rows:[], defects:[], observed:['scout:r1'], observed_heads:[], terminals:[],
  })
})

test('factory step trace keeps checkpoints in distinct measured phases', () => {
  const trace = factoryStepTrace({ payload:{ rows:[
    { at:1000, stage:'build:r1' }, { at:1100, stage_done:'build:r1' },
    { at:2100, stage:'suite:cold' }, { at:2200, stage_done:'suite:cold' },
  ] } }, { blocks:[
    { phase_id:1, name:'building', started_at:900, ended_at:1500, x:0, width:.45 },
    { phase_id:2, name:'validating', started_at:1900, ended_at:2500, x:.55, width:.45 },
  ] }, { now:2500 })
  assert.deepEqual(trace.steps.map((step) => [step.label, step.phase_id]), [['build:r1',1], ['suite:cold',2]])
})

test('RunDetail places profile evidence before raw payloads and keeps topology plain', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  const fleetSource = readFileSync(join(ROOT, 'visualizer/web/src/lib/fleet.js'), 'utf8')
  assert.match(source, /profileEvidenceView\(configuration\.profile\.key, evidence\)/)
  assert.match(source, /executionTopology\(configuration\.execution\.key, observedStageLabels/)
  assert.match(source, /class="profile-evidence" aria-label="Profile evidence summary"/)
  assert.ok(source.indexOf('class="profile-evidence"') < source.indexOf('<EnvelopeInspector'))
  assert.doesNotMatch(source, /function\s+executionTopology\s*\(/)
  for (const label of ['Review findings', 'Verification checks', 'Bug reproduction', 'Test discrimination']) assert.match(fleetSource, new RegExp(label))
})

test('factory step trace makes a closed stage with no envelope visibly incomplete', () => {
  const trace = factoryStepTrace({ payload:{ rows:[
    { at:1000, stage:'build:r1' },
    { at:1100, assign:'d1', role:'builder' },
    { at:1900, stage_done:'build:r1' },
  ] } }, { blocks:[{ phase_id:1, name:'build', started_at:1000, ended_at:2000, x:0, width:1, status:'ok' }] }, { now:2000 })
  assert.equal(trace.steps[0].state.label, 'No return recorded')
  assert.equal(trace.steps[0].handoffs[0].no_return, true)
  assert.equal(trace.steps[0].handoffs[0].marker, false)
  assert.equal(Number(trace.steps[0].handoffs[0].width.toFixed(1)), .8)
})

test('factory step trace does not call an open assignment live after its heartbeat went stale', () => {
  const trace = factoryStepTrace({ payload:{ rows:[
    { at:1000, stage:'build:r1' },
    { at:1100, assign:'d1', role:'builder' },
  ] } }, { blocks:[{ phase_id:1, name:'build', started_at:1000, ended_at:null, x:0, width:1, status:'running' }] }, { now:2000, activity:'silent' })
  assert.equal(trace.steps[0].state.label, 'No return recorded')
  assert.equal(trace.steps[0].handoffs[0].marker, false)
})

test('factory step trace distinguishes unavailable telemetry from a measured empty journal', () => {
  assert.match(factoryStepTrace({ payload:{ rows:[], degraded:true }, error:'journal missing' }, {}).unavailable, /journal missing/)
  const empty = factoryStepTrace({ payload:{ rows:[], degraded:false }, error:'' }, {})
  assert.equal(empty.unavailable, null)
  assert.equal(empty.measured, false)
  assert.deepEqual(factoryStepCategory('suite:cold'), { key:'validation', label:'Validation' })
  assert.equal(factoryStepName('envelope-accept'), 'Accept return')
  assert.equal(factoryStepName('gate-proof:2:checks'), 'Mutation checks · generation 2')
})

test('task detail shares one journal read between waterfall and trajectory', () => {
  const detail = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  const trajectory = readFileSync(join(ROOT, 'visualizer/web/src/lib/Trajectory.svelte'), 'utf8')
  const waterfall = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.match(detail, /<PhaseGantt[^>]*\{journalState\}/)
  assert.match(detail, /<Trajectory[^>]*\{journalState\}/)
  assert.equal(trajectory.includes("fetch(`/api/journal"), false)
  assert.match(waterfall, /Factory internals/)
  assert.match(waterfall, /validation and control checkpoints/)
})

test('factory checkpoint inspection stays local and highlights the related waterfall phase', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  const inspect = source.match(/function inspectStep\(step\) \{([^}]*)\}/)?.[1] || ''
  assert.equal(inspect.includes('onselectphase'), false)
  assert.match(source, /class:step-linked=\{sameId\(block\.phase_id, linkedPhase\)\}/)
  assert.match(source, /class:selected=\{linkedPhase == null && sameId\(block\.phase_id, selectedPhaseId\)\}/)
  assert.match(source, /step\.handoffs/)
  assert.match(source, /Agent work above, factory control here/)
  assert.match(source, /class="agent-guide"/)
  assert.match(source, /class="factory-guide"/)
  assert.match(source, /class="control-guide"/)
  assert.match(source, /Seat assignment ended without a return/)
  assert.match(source, /class="checkpoint-groups"/)
  assert.match(source, /class="checkpoint"/)
  assert.match(source, /roundsFor\(block\)/)
  assert.match(source, /controlsFor\(block\)/)
  assert.match(source, /background:var\(--agent-color\)/)
  assert.match(source, /class="round-row"/)
  assert.match(source, /class:has-rounds=/)
  assert.match(source, /class:last-round=/)
  assert.match(source, /class:missing-return=/)
  assert.match(source, /selectedDetail\.state\.label/)
  assert.match(source, /How to read this trace/)
  assert.match(source, /Thin seat · solid round/)
  assert.match(source, /class="coverage-line"/)
  assert.match(source, /class="factory-gap"/)
  assert.match(source, /Empty track is genuinely unassigned time/)
  assert.match(source, /Gate proof/)
  assert.match(source, /handoffTooltip\(handoff\)/)
  assert.match(source, /stepTooltip\(step\)/)
  assert.doesNotMatch(source, /<em>Factory step<\/em>/)
})

test('task detail refreshes do not reset finished-run disclosures for an unchanged task id', () => {
  const detail = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  const trajectory = readFileSync(join(ROOT, 'visualizer/web/src/lib/Trajectory.svelte'), 'utf8')
  assert.match(detail, /target\.adw_id === detailKey/)
  assert.match(detail, /key === journalKey/)
  assert.ok(detail.indexOf('key === journalKey') < detail.indexOf('journalState = initialJournalState()'))
  assert.doesNotMatch(detail, /if \(!shouldRead\(\{ running:run\.running \}\)\) return/)
  assert.match(trajectory, /id === trajectoryRunKey/)
})

test('PhasePanel shows pending gate retries alongside valid checks', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhasePanel.svelte'), 'utf8')
  assert.ok(source.includes('{#if panel.gate.checks_pending}'))
  assert.ok(source.includes('class="checks-pending muted"'))
  assert.equal(source.includes('{:else if panel.gate.checks_pending}'), false)
})

const READ_AT = 1700000000000

test('the staleness floor is a boundary an injected clock decides', () => {
  assert.equal(readFreshness(READ_AT, READ_AT + PANEL_STALE_AFTER_MS, PANEL_REFRESH_MS).stale, false)
  assert.equal(readFreshness(READ_AT, READ_AT + PANEL_STALE_AFTER_MS + 1, PANEL_REFRESH_MS).stale, true)
  assert.deepEqual(
    readFreshness(READ_AT, READ_AT + 5000, PANEL_REFRESH_MS),
    readFreshness(READ_AT, READ_AT + 5000, PANEL_REFRESH_MS))
  const undated = readFreshness(null, null, PANEL_REFRESH_MS)
  assert.equal(undated.age_ms, null)
  assert.equal(undated.stale, false)
  assert.match(undated.label, /cannot be dated/)
  assert.match(readFreshness(READ_AT, READ_AT, PANEL_REFRESH_MS).refresh_label, /re-reads every 3s/)
  assert.match(readFreshness(READ_AT, READ_AT, null).refresh_label, /does not re-read/)
  assert.doesNotMatch(readFreshness(READ_AT, READ_AT, null).refresh_label, /re-reads every/)
  assert.deepEqual([panelAgeLabel(2000), panelAgeLabel(90000), panelAgeLabel(6600000)], ['2s', '1m', '1h50m'])
})

test('the panel read loop re-reads on the family cadence and stops when the panel is gone', () => {
  const reads = []
  const registered = []
  const cleared = []
  let tick = null
  const stop = panelReadLoop(() => reads.push('read'), {
    refresh_ms: PANEL_REFRESH_MS,
    setInterval: (fn, ms) => { tick = fn; registered.push(ms); return 41 },
    clearInterval: (handle) => cleared.push(handle),
  })
  assert.equal(reads.length, 1)
  assert.deepEqual(registered, [PANEL_REFRESH_MS])
  tick()
  assert.equal(reads.length, 2)
  stop()
  assert.deepEqual(cleared, [41])
})

test('a contradicted lane names both sides and is never called stale', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z')
  const run = {
    status: 'running', running: true, phases: [{}],
    started_at: '2026-09-05T20:00:00.000Z',
    last_heartbeat_at: new Date(now - 4_000).toISOString(),
    crew_state: { archived: true, archived_at: '2026-09-05T22:15:38.543Z' },
  }
  const activity = runActivity(run, now)
  assert.equal(activity.key, 'contradicted')
  assert.notEqual(activity.key, 'silent')
  assert.equal(activity.attention, true)
  assert.match(activity.word, /crew state archived/)
  assert.match(activity.why, /2026-09-05T20:00:00.000Z/)
  assert.match(activity.why, /2026-09-05T22:15:38.543Z/)
  assert.equal(deriveDisplayStatus(run, null, now).where, 'crew state')
  const stale = { ...run, crew_state: { archived: false }, last_heartbeat_at: new Date(now - 91_000).toISOString() }
  assert.equal(runActivity(stale, now).key, 'silent')
  assert.equal(deriveDisplayStatus(stale, null, now).where, 'heartbeat')
})

test('an unmeasured crew state is never read as not archived', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z')
  const reason = 'crew state read returned EACCES'
  const run = {
    status: 'running', running: true, phases: [{}],
    last_heartbeat_at: new Date(now - 91_000).toISOString(),
    pending: { crew_state: reason },
  }
  const state = crewArchive(run)
  assert.equal(state.archived, null)
  assert.equal(state.absent.text, reason)
  assert.equal(runActivity(run, now).key, 'silent')
  assert.notEqual(runActivity(run, now).key, 'contradicted')
  assert.notEqual(runActivity(run, now).key, 'settled')
  const measured = { ...run, crew_state: { archived: false } }
  assert.equal(crewArchive(measured).archived, false)
  assert.equal(crewArchive(measured).absent, null)
})

test('settlement is read from the ledger, never from the crew dir', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z')
  const archived = { archived: true, archived_at: '2026-09-05T22:15:38.543Z' }
  const settled = {
    status: 'ok', running: false, ended_at: '2026-09-05T22:10:00.000Z',
    phases: [{}], last_heartbeat_at: new Date(now - 4_000).toISOString(), crew_state: archived,
  }
  assert.equal(runActivity(settled, now).key, 'settled')
  const running = { ...settled, status: 'running', running: true, ended_at: null }
  const activity = runActivity(running, now)
  assert.equal(activity.key, 'contradicted')
  assert.equal(activity.heartbeat.stale, false)
  assert.notEqual(activity.key, 'live')
})

test('a contradicted lane is not suppressed', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z')
  const base = {
    repo_slug: 'repo', status: 'running', running: true, phases: [{}],
    started_at: '2026-09-05T20:00:00.000Z', triage: { reviewed_at: null },
    pending: {}, metrics: {}, goal: 'task',
  }
  const fresh = { ...base, adw_id: 'fresh', last_heartbeat_at: new Date(now - 4_000).toISOString(), crew_state: { archived: true, archived_at: '2026-09-05T22:15:38.543Z' } }
  const stale = { ...base, adw_id: 'stale', goal: 'stale-task', last_heartbeat_at: new Date(now - 91_000).toISOString(), crew_state: { archived: true, archived_at: '2026-09-05T22:15:38.543Z' } }
  const view = fleetView([fresh, stale], { now })
  assert.equal(view.hidden.count, 0)
  assert.equal(view.rows.length, 2)
  assert.equal(view.rail.filter((row) => row.adw_id === 'fresh').length, 1)
  assert.equal(view.rail.filter((row) => row.adw_id === 'stale').length, 1)
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/fleet.js'), 'utf8')
  assert.match(source, /run\?\.triage\?\.reviewed_at/)
})

test('an escalated contradicted lane appears on the rail once', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z')
  const why = 'review evidence needs a human decision'
  const run = {
    adw_id: 'escalated-contradicted', goal: 'task', repo_slug: 'repo', status: 'running', running: true,
    phases: [{}], started_at: '2026-09-05T20:00:00.000Z', last_heartbeat_at: new Date(now - 4_000).toISOString(),
    crew_state: { archived: true, archived_at: '2026-09-05T22:15:38.543Z' }, triage: { reviewed_at: null }, pending: {}, metrics: {},
  }
  const view = fleetView([run], {
    now,
    envelopes: new Map([[run.adw_id, { status: 'escalation', details: { escalation: { where: 'review', why } } }]]),
  })
  assert.equal(view.rows[0].status.key, 'escalated')
  assert.equal(view.rows[0].activity.key, 'contradicted')
  const rail = view.rail.filter((row) => row.adw_id === run.adw_id)
  assert.equal(rail.length, 1)
  assert.equal(rail[0].why, why)
})

test('fleetActivity counts contradictions without changing its denominator', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z')
  const fresh = { running: true, status: 'running', phases: [{}], last_heartbeat_at: new Date(now - 4_000).toISOString(), crew_state: { archived: true } }
  const stale = { running: true, status: 'running', phases: [{}], last_heartbeat_at: new Date(now - 91_000).toISOString(), crew_state: { archived: false } }
  assert.deepEqual(fleetActivity([fresh, stale], now), { live: 0, silent: 1, contradicted: 1, unverified: 0, gone: 0, open: 2 })
})

test('the contradiction sentence says why the archive time is missing', () => {
  const reason = 'archive suffix was unparsable'
  const run = {
    running: true, status: 'running', phases: [{}], last_heartbeat_at: new Date(Date.parse('2026-09-06T00:00:00.000Z') - 4_000).toISOString(),
    crew_state: { archived: true, archived_at: null, archived_at_absent: reason },
  }
  assert.equal(crewArchive(run).archived_at_absent, reason)
  assert.match(runActivity(run, Date.parse('2026-09-06T00:00:00.000Z')).why, new RegExp(reason))
})

test('a contradicted lane renders as an open record with no return, never in progress', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z')
  const run = { running: true, status: 'running', phases: [{}], last_heartbeat_at: new Date(now - 4_000).toISOString(), crew_state: { archived: true } }
  const key = runActivity(run, now).key
  const journal = { payload: { rows: [{ at: 1000, stage: 'build:r1' }, { at: 1100, assign: 'd1', role: 'builder' }] } }
  const timeline = { blocks: [{ phase_id: 1, name: 'build', started_at: 1000, ended_at: null, x: 0, width: 1, status: 'running' }] }
  const trace = factoryStepTrace(journal, timeline, { now: 2000, activity: key })
  assert.deepEqual(trace.steps[0].handoffs[0].state, { key: 'missing', label: 'No return recorded' })
  assert.equal(trace.steps[0].handoffs[0].no_return, true)
  assert.notEqual(trace.steps[0].state.key, 'active')
  assert.notEqual(trace.steps[0].state.label, 'In progress')
  const live = factoryStepTrace(journal, timeline, { now: 2000, activity: 'live' })
  assert.deepEqual(live.steps[0].handoffs[0].state, { key: 'active', label: 'In progress' })
})

test('A1: every visualizer consumer uses the shared attention classifier', () => {
  const root = join(ROOT, 'visualizer/web/src')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  const taskList = readFileSync(join(root, 'lib/TaskList.svelte'), 'utf8')
  const fleet = readFileSync(join(root, 'lib/fleet.js'), 'utf8')
  assert.match(app, /import \{[^}]*attentionBreakdown[^}]*needsAttention[^}]*\} from '\.\/lib\/fleet\.js'/)
  assert.match(app, /\.filter\(\(row\) => needsAttention\(row\.status\.key\) && !row\.run\.triage\?\.reviewed_at\)/)
  assert.match(app, /let attentionSummary = \$derived\(attentionBreakdown\(attentionRows\)\)/)
  assert.match(app, /const state = attentionRows\.length \? 'attention'/)
  assert.doesNotMatch(app, /activity\.silent \|\| activity\.unverified \|\| activity\.contradicted \? 'attention'/)
  assert.doesNotMatch(app, /attentionRows\.filter\(/)
  assert.match(taskList, /import \{[^}]*needsAttention[^}]*\} from '\.\/fleet\.js'/)
  assert.match(taskList, /function statusFor\(run\) \{ return deriveDisplayStatus\(run, envelopeFor\(run\.adw_id\), now\) \}/)
  assert.match(taskList, /if \(state === 'attention'\) return needsAttention\(status\.key\)/)
  assert.match(taskList, /runs\.filter\(\(run\) => needsAttention\(statusFor\(run\)\.key\)/)
  assert.match(fleet, /attention: needsAttention\(key\)/)
  assert.doesNotMatch(fleet, /attention:\s*(?:true|false)/)
})

test('the contradiction heading is not the stale heading', () => {
  const note = openRecordNote('contradicted')
  assert.match(note, /crew state/i)
  assert.doesNotMatch(note, /stale|heartbeat/i)
  assert.equal(openRecordNote('silent'), 'Stale open record')
  assert.equal(openRecordNote('unverified'), 'Open record not verified')
  assert.equal(openRecordNote('live'), null)
  const detail = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  assert.ok(detail.includes('taskDetailSummary(run, returns'))
  assert.doesNotMatch(detail, /'Stale open record'/)
})

test('activity summary keeps contradicted open runs out of successful outcomes', async () => {
  const { activitySummary } = await import('../visualizer/web/src/lib/activity.js')
  const summary = activitySummary([{adw_id:'a', running:true, status:'running', started_at:'2026-10-25T10:00:00Z', crew_state:{archived:true}}], {now:Date.parse('2026-10-25T12:00:00Z')})
  assert.equal(summary.counts.open, 1)
  assert.equal(summary.successRate, null)
  assert.equal(summary.attention[0].status.key, 'contradicted')
  assert.match(summary.attention[0].status.why, /archived/)
})


test('B1: a synthetic vocabulary key reaches every attention consumer', async () => {
  const root = join(ROOT, 'visualizer/web/src')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  const taskList = readFileSync(join(root, 'lib/TaskList.svelte'), 'utf8')
  assert.match(app, /needsAttention\(row\.status\.key\)/)
  assert.match(app, /attentionBreakdown\(attentionRows\)/)
  assert.match(app, /const state = attentionRows\.length \? 'attention'/)
  assert.match(taskList, /needsAttention\(statusFor\(run\)\.key\)/)
  await withAttentionFixture('synthetic-attention', (fleet) => {
    assert.equal(fleet.needsAttention('synthetic-attention'), true)
    const summary = fleet.attentionBreakdown([{ status: { key: 'synthetic-attention' } }])
    assert.equal(summary.total, 1)
    assert.equal(summary.unattributed, 1)
    assert.equal(summary.text, '1 unattributed')
    assert.equal(summary.segments.reduce((sum, segment) => sum + segment.count, 0) + summary.unattributed, summary.total)
  })
})

test('C1: every current attention key routes the metric click to attention', () => {
  // App.svelte's routing is pinned by source because no plain module owns it.
  const app = readFileSync(join(ROOT, 'visualizer/web/src/App.svelte'), 'utf8')
  assert.match(app, /const state = attentionRows\.length \? 'attention' : activity\.live \? 'active' : 'all'/)
})

test('D1: named attention segments and unattributed rows reconcile to the total', () => {
  const summary = attentionBreakdown(ATTENTION_KEYS.map((key) => ({ status: { key } })))
  assert.equal(summary.total, ATTENTION_KEYS.length)
  assert.equal(summary.unattributed, 0)
  assert.deepEqual(summary.segments.map((segment) => [segment.key, segment.count]), ATTENTION_KEYS.map((key) => [key, 1]))
  assert.equal(summary.segments.reduce((sum, segment) => sum + segment.count, 0) + summary.unattributed, summary.total)
})

test('E1: an added vocabulary key without a label is reported as unattributed', async () => {
  await withAttentionFixture('synthetic-attention', (fleet) => {
    const summary = fleet.attentionBreakdown([
      { status: { key: 'synthetic-attention' } },
      { status: { key: 'outside-attention-vocabulary' } },
    ])
    assert.equal(summary.total, 1)
    assert.equal(summary.unattributed, 1)
    assert.match(summary.text, /1 unattributed/)
    assert.equal(summary.segments.reduce((sum, segment) => sum + segment.count, 0) + summary.unattributed, summary.total)
  })
})

test('F1: every reachable run activity result derives attention from its key', () => {
  const now = Date.parse('2026-09-14T00:00:00.000Z')
  const fixtures = [
    { running: false },
    { running: true, crew_state: { archived: true }, last_heartbeat_at: new Date(now - 1_000).toISOString() },
    { running: true, runtime: {}, last_heartbeat_at: new Date(now - 1_000).toISOString() },
    { running: true, runtime: { driver_state: 'gone', source: 'gate' }, last_heartbeat_at: new Date(now - 1_000).toISOString() },
    { running: true, runtime: { driver_state: 'alive', source: 'gate' }, last_heartbeat_at: new Date(now - 1_000).toISOString() },
    { running: true, last_heartbeat_at: new Date(now - 60_000).toISOString() },
    { running: true, last_heartbeat_at: new Date(now - 1_000).toISOString() },
  ]
  for (const run of fixtures) {
    const activity = runActivity(run, now)
    assert.equal(activity.attention, needsAttention(activity.key))
  }
})

test('G1: a key outside the attention vocabulary is not attention work', () => {
  assert.equal(needsAttention('outside-attention-vocabulary'), false)
})

function resolveStageSite(site, scanned) {
  const matches = scanned.filter((call) => call.callee === (site.callee || 'stage') && call.label === site.label)
  return Number.isSafeInteger(site.occurrence) && site.occurrence >= 1 ? matches[site.occurrence - 1] || null : null
}

// Mutation killed: storing a line number again reintroduces the pin that broke b768.
const NO_CALL_REASONS = Object.freeze(['declared-without-executor-call'])
function stripJavaScriptComments(source) {
  let output = ''
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') { lineComment = false; output += char }
      else output += ' '
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') { output += '  '; index += 1; blockComment = false }
      else output += char === '\n' ? '\n' : ' '
      continue
    }
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') { output += '  '; index += 1; lineComment = true; continue }
    if (char === '/' && next === '*') { output += '  '; index += 1; blockComment = true; continue }
    if (char === '\'' || char === '"' || char === '`') quote = char
    output += char
  }
  return output
}
function readQuotedArgument(source, start) {
  const quote = source[start]
  if (!['\'', '"', '`'].includes(quote)) return null
  let label = ''
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) { label += char; escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === quote) return { label, end: index + 1 }
    label += char
  }
  return null
}
function scanStageSites(source) {
  const scannedSource = stripJavaScriptComments(source)
  const calls = []
  const STAGE_CALL = /\bstage[ \t\r\n]*\([ \t\r\n]*/g
  for (const match of scannedSource.matchAll(STAGE_CALL)) {
    const parsed = readQuotedArgument(scannedSource, match.index + match[0].length)
    if (!parsed) continue
    calls.push({ line: scannedSource.slice(0, match.index).split('\n').length, callee: 'stage', label: parsed.label })
  }
  const WRAPPER_CALL = /\b(recordGateProof|acceptRepairedGate)[ \t\r\n]*\([ \t\r\n]*/g
  for (const match of scannedSource.matchAll(WRAPPER_CALL)) {
    let argumentStart = match.index + match[0].length
    if (match[1] === 'acceptRepairedGate') {
      const comma = scannedSource.indexOf(',', argumentStart)
      if (comma === -1) continue
      argumentStart = comma + 1
      while (/[ \t\r\n]/.test(scannedSource[argumentStart] || '')) argumentStart += 1
    }
    const parsed = readQuotedArgument(scannedSource, argumentStart)
    if (!parsed) continue
    calls.push({ line: scannedSource.slice(0, match.index).split('\n').length, callee: match[1], label: parsed.label })
  }
  return calls
}
function resolveStageLabel(site) {
  const bindings = site.bindings || {}
  return site.label.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (full, name) => Object.prototype.hasOwnProperty.call(bindings, name) ? String(bindings[name]) : full)
}
function stageHeadFromLabel(label) { return label.split(':')[0] }

test('A1.comment-call', () => {
  const sites = scanStageSites("// stage('commented')\n/* stage('blocked') */\nstage('real')")
  assert.deepEqual(sites, [{ line: 3, callee: 'stage', label: 'real' }])
})

test('A1.multiline-call', () => {
  assert.deepEqual(scanStageSites("stage(\n  'multi-line'\n)"), [{ line: 1, callee: 'stage', label: 'multi-line' }])
})

test('A1.variant-sites', () => {
  const docs = JSON.parse(readFileSync(join(ROOT, 'visualizer/web/src/lib/stage-docs.json'), 'utf8'))
  assert.deepEqual(docs.repair.source.sites, [{ callee: 'stage', label: '${variant}:r1', occurrence: 2, bindings: { variant: 'repair' } }])
  assert.deepEqual(docs.directed.source.sites, [{ callee: 'stage', label: '${variant}:r1', occurrence: 3, bindings: { variant: 'directed' } }])
  for (const key of ['scout', 'review_only', 'verify_only']) {
    assert.deepEqual(docs[key].source.sites, [{ callee: 'stage', label: '${variant}:r1', occurrence: 1, bindings: { variant: key } }])
  }
})

import { PLAN_STEP_STATUSES, PLAN_STEP_REASONS, PLAN_ABSENCE_REASONS, planSteps } from '../visualizer/web/src/lib/plan-steps.js'
import { readFileSync as readSource } from 'node:fs'

test('PV3', () => {
  const payload = { plan:{ chunks:[{ id:'a', checks_owned:['C1'], files_in_scope:['a.js'], depends_on:['b'] }] }, rows:[
    { channel:'record', event:'step:start', step:'a', round:1, at:99 }, { channel:null, event:'step:start', step:'a', round:3, at:1 },
    { channel:'record', event:'step:done', step:'a' }, { channel:'record', event:'step:red', step:'a' },
  ] }
  assert.deepEqual(planSteps(payload).steps[0], { id:'a', checks_owned:['C1'], files_in_scope:['a.js'], depends_on:['b'], status:'red', via:'step:red', reason:null, rounds:3 })
  payload.rows.push({ event:'step:bounce', step:'a' }, { event:'step:start', step:'a', round:4 })
  assert.equal(planSteps(payload).steps[0].status, 'started')
  assert.equal(planSteps(payload).steps[0].rounds, 4)
})
test('PV4', () => {
  const base = { plan:{ chunks:[{ id:'a' }] } }
  assert.equal(planSteps({...base, rows:[{ event:'step:accepted-by-gate', step:'a' }]}).steps[0].via, 'step:accepted-by-gate')
  assert.equal(planSteps({...base, rows:[{ event:'step:reverified', step:'a' }]}).steps[0].status, 'done')
  assert.equal(planSteps({...base, rows:[{ event:'step:reverified', step:'a' }, { event:'step:reverify-red', step:'a' }]}).steps[0].status, 'red')
  const redThenDone = planSteps({...base, rows:[{ event:'step:red', step:'a' }, { event:'step:done', step:'a' }]}).steps[0]
  assert.deepEqual([redThenDone.status, redThenDone.via], ['done', 'step:done'])
})
test('PV5', () => {
  const plan = { chunks:[{ id:'a' }, { id:'b' }] }
  assert.deepEqual([planSteps({ plan, rows:[] }).steps[0].status, planSteps({ plan, rows:[] }).steps[0].reason], [null, 'no-step-events'])
  const result = planSteps({ plan, rows:[{ event:'step:start', step:'a', round:1 }] })
  assert.equal(result.steps[1].status, 'not-started')
})
test('PV6', () => {
  const plan = { chunks:[{ id:'a' }] }
  const result = planSteps({ plan, rows:[{ event:'step:degrade', remaining:['a','outside','outside'] }] })
  assert.deepEqual([result.steps[0].status, result.steps[0].reason], [null, 'degraded-to-whole-build'])
  assert.deepEqual(result.unplanned, ['outside'])
  assert.equal(planSteps({ plan, rows:[{ event:'step:degrade', remaining:['a'] }, { event:'step:done', step:'a' }, { event:'step:red', step:'a' }] }).steps[0].status, 'red')
})
test('PV7', () => {
  assert.equal(planSteps({}).absent, 'plan-not-accepted')
  const errored = planSteps({ plan:{ chunks:[{ id:'a' }, { id:'b' }] }, rows:[{ event:'step:done', step:'a' }, { event:'step:done', step:'b' }], error:'read failed' })
  assert.deepEqual(errored.steps.map(({ status, reason }) => [status, reason]), [[null, 'journal-unavailable'], [null, 'journal-unavailable']])
  assert.deepEqual(PLAN_STEP_STATUSES, ['not-started','started','done','red','bounced'])
  assert.deepEqual(PLAN_STEP_REASONS, ['no-step-events','degraded-to-whole-build','journal-unavailable'])
  assert.deepEqual(PLAN_ABSENCE_REASONS, ['plan-not-accepted','plan-unreadable','plan-has-no-chunks'])
  assert.equal(Object.isFrozen(PLAN_STEP_STATUSES), true)
  assert.equal(planSteps({ plan:{ chunks:[null, {}, { id:' ' }, { id:'ok', checks_owned:['x'] }] }, rows:[null, []] }).steps.length, 1)
})
test('PV8', () => {
  const source = readSource(new URL('../visualizer/web/src/lib/plan-steps.js', import.meta.url), 'utf8')
  const detector = (text) => /(?:from\s*|import\s*(?:\(\s*)?)['"](?!\.)/.test(text)
  // Mutation killed: allowing a bare dynamic import in plan-steps.js must fail this shared detector.
  assert.equal(detector(source), false)
  assert.equal(detector("import x from 'bare-package'"), true)
  assert.equal(detector("import 'node:fs'"), true)
  assert.equal(detector("const fs = import('node:fs')"), true)
  assert.equal(detector("import('./local.js')"), false)
})
test('PV9', () => {
  const component = readSource(new URL('../visualizer/web/src/lib/PlanSteps.svelte', import.meta.url), 'utf8')
  const detail = readSource(new URL('../visualizer/web/src/lib/RunDetail.svelte', import.meta.url), 'utf8')
  assert.match(component, /import \{ planStepCards \} from '\.\/plan-steps\.js'/)
  assert.match(component, /let \{ journalState \} = \$props\(\)/)
  assert.match(component, /step\.checks/)
  assert.match(component, /<details/)
  assert.match(component, /Not recorded:/)
  assert.match(component, /<ol class="step-timeline">/)
  assert.match(component, /aria-current=\{step\.state === 'active' \? 'step' : undefined\}/)
  assert.match(detail, /<PlanSteps \{journalState\} \/>/)
  assert.match(component, /if view\.steps\.length === 0/)
  assert.match(component, /Loading accepted plan/)
  assert.match(component, /Inspect the accepted planner return/)
  assert.match(component, /role="status"/)
  assert.match(component, /var\(--panel\).*var\(--line\)/)
  const style = component.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  assert.doesNotMatch(style, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
  assert.match(detail, /<PlanSteps {journalState} \/>/)
})

// Stepped projection acceptance probes; import dynamically so missing behavior is an assertion failure.
const steppedModule = await import('../visualizer/web/src/lib/plan-steps.js')
const stepped = (...args) => typeof steppedModule.stepTimeline === 'function' ? steppedModule.stepTimeline(...args) : {}
const steppedPayload = (rows=[], chunks=[{id:'a',files_in_scope:['a.js'],depends_on:[],checks_owned:['C1','C2']}]) => ({plan:{chunks},rows})
const timelineStart = (step='a',round=1,at=100) => ({event:'step:start',step,round,at})
const timelineDone = (step='a',round=1,at=200) => ({event:'step:done',step,round,at,passed:['C1','C2']})
const timelineCensus = (at=150,turns=7,role='builder') => ({at,seat_turn_census:{role,turns,dispatch_id:89}})
test('VS1', () => {
 const v=stepped(steppedPayload([], [null,{id:'a',files_in_scope:['a.js'],depends_on:[],checks_owned:[]},{id:'b',files_in_scope:['b.js'],depends_on:['a']}]))
 assert.deepEqual(v.steps.map(s=>[s.id,s.files,s.depends_on,s.intent,s.intent_reason]),[['a',['a.js'],[],null,'plan-chunk-carries-no-intent'],['b',['b.js'],['a'],null,'plan-chunk-carries-no-intent']])
 for (const [p,r] of [[{},'plan-not-accepted'],[{plan:{absent:'plan-unreadable'}},'plan-unreadable'],[{plan:{chunks:[]}},'plan-has-no-chunks']]) assert.equal(stepped(p).absent,r)
 assert.equal(stepped(steppedPayload([], [{id:'a',intent:'Recorded'}])).steps[0].intent,'Recorded')
 const filtered=stepped(steppedPayload([null,{event:'step:done',step:'a',channel:'foreign'},{event:'step:start',step:'a',round:1,at:1,channel:null}]))
 assert.deepEqual(filtered.steps[0].rounds.map(r=>r.outcome),[null])
})
test('VS2', () => {
 const v=stepped(steppedPayload([timelineDone(),{event:'step:red',step:'a',round:2,failed:['C1'],regressed:['C1']}]))
 assert.deepEqual(v.steps[0].checks.map(c=>[c.id,c.result,c.regressed,c.reason]),[['C1','failed',true,null],['C2',null,false,'no-gate-result']])
 assert.deepEqual(stepped(steppedPayload([timelineDone()])).steps[0].checks.map(c=>c.result),['passed','passed'])
 assert.equal(stepped(steppedPayload([timelineStart(),{event:'step:reverify-red',step:'a',failed:['C2'],regressed:['C2']}])).steps[0].checks[1].result,'failed')
})
test('VS3', () => {
 const rows=[timelineStart(),{event:'step:bounce',step:'a',round:1,at:200,status:'blocked'},timelineStart('a',2,300),timelineDone('a',2,400),timelineStart('a',3,500),{event:'step:accepted-by-gate',step:'a',round:3,at:600,passed:['C1']}]
 const rounds=stepped(steppedPayload(rows)).steps[0].rounds
 assert.deepEqual(rounds.map(r=>r.outcome),['bounced','done','accepted-by-gate'])
 assert.deepEqual([rounds[0].bounce_status,rounds[0].bounce_reason,rounds[0].bounce_reason_reason],['blocked',null,'bounce-summary-not-journaled'])
 const red=stepped(steppedPayload([timelineStart(),timelineDone('outside'),{event:'step:red',step:'a',round:1,at:201,failed:['C2'],regressed:['C1']}])).steps[0].rounds[0]
 assert.deepEqual([red.outcome,red.failed,red.regressed],['red',['C2'],['C1']])
})
test('VS4', () => {
 for (const [a,b] of [[100,250],['2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.150Z']]) assert.equal(stepped(steppedPayload([timelineStart('a',1,a),timelineDone('a',1,b)])).steps[0].rounds[0].duration_ms,150)
 assert.deepEqual([stepped(steppedPayload([timelineStart()])).steps[0].rounds[0].duration_ms,stepped(steppedPayload([timelineStart()])).steps[0].rounds[0].duration_reason],[null,'round-open'])
 const bad=stepped(steppedPayload([timelineStart('a',1,'bad'),timelineDone()])).steps[0].rounds[0]
 assert.deepEqual([bad.duration_ms,bad.duration_reason],[null,'invalid-round-timestamps'])
})
test('VS5', () => {
 for (const [cs,turns,reason] of [[[],null,'no-builder-census-in-window'],[[timelineCensus()],7,null],[[timelineCensus(),timelineCensus(160,9)],null,'ambiguous-builder-census']]) {
 const r=stepped(steppedPayload([timelineCensus(50,88),timelineStart(),timelineCensus(140,99,'reviewer'),...cs,timelineDone(),timelineCensus(250,77)])).steps[0].rounds[0]
 assert.deepEqual([r.turns,r.turns_reason,r.cost,r.cost_reason],[turns,reason,null,'no-per-step-cost-source'])
 }
 assert.equal(stepped(steppedPayload([timelineStart(),timelineCensus(150,0),timelineDone()])).steps[0].rounds[0].turns,0)
})
test('VS6', () => {
 const v=stepped(steppedPayload([timelineStart(),{at:150,stage:'escalate:build'}])).steps[0]
 assert.deepEqual([v.state,v.escalation,v.escalation_reason],['escalated','escalate:build',null])
 assert.equal(stepped(steppedPayload([timelineStart()])).steps[0].state,'active')
 const two=stepped(steppedPayload([timelineStart(),timelineStart('b',1,150)],[{id:'a'},{id:'b'}]))
 assert.deepEqual(two.steps.map(s=>[s.state,s.reason]),[[null,'superseded-open-round'],['active',null]])
 const resumed=stepped(steppedPayload([timelineStart(),{event:'step:red',step:'a',round:1,at:120},timelineStart('a',2,130),{at:140,stage:'escalate:build'},timelineStart('a',1,150),timelineDone('a',1,170),timelineStart('b')],[{id:'a'},{id:'b'}]))
 assert.equal(resumed.steps[0].state,'done')
})
test('VS7', () => {
 const d={event:'step:degrade',step:'a',remaining:['a','b'],reason:'budget-reserved',budget:2,at:200}
 const v=stepped(steppedPayload([timelineStart(),d,timelineDone('b',1,300)],[{id:'a'},{id:'b'}]))
 assert.deepEqual(v.degraded,{value:true,step:'a',remaining:['a','b'],reason:d.reason,budget:2})
 assert.deepEqual(v.steps.map(s=>s.state),['degraded','done'])
 assert.equal(stepped(steppedPayload([timelineStart()])).degraded.value,false)
 assert.deepEqual([stepped(steppedPayload()).degraded.value,stepped(steppedPayload()).degraded.reason],[null,'no-step-events'])
 const completed=stepped(steppedPayload([d,timelineDone('a',1,250)])).steps[0]
 assert.equal(completed.state,'done')
})
test('VS8', () => {
 const v=stepped(steppedPayload([timelineStart(),timelineDone(),timelineStart('b')],[{id:'a'},{id:'b'}]))
 assert.deepEqual(v.strip.map(s=>[s.id,s.state,s.reason,s.tone]),v.steps.map(s=>[s.id,s.state,s.reason,s.tone]))
 const detail=readFileSync(new URL('../visualizer/web/src/lib/RunDetail.svelte',import.meta.url),'utf8')
 const header=detail.match(/<header class="task-header">([\s\S]*?)<\/header>/)?.[1] ?? ''
 assert.equal(header.includes('step-strip'), false, 'plan progress has one home in Activity')
 assert.ok(detail.includes('<PlanSteps {journalState} />'))
 const component=readFileSync(new URL('../visualizer/web/src/lib/PlanSteps.svelte',import.meta.url),'utf8')
 assert.match(component,/<ol\b[^>]*class="step-timeline"/)
 assert.match(component,/aria-current=\{step.state === 'active' \? 'step' : undefined\}/)
})
test('VS9', () => {
 for (const flag of [{error:'read denied'},{degraded:true}]) {
 const v=stepped({...steppedPayload([timelineStart(),timelineCensus(),timelineDone()]),...flag}),s=v.steps[0]
 assert.deepEqual([s.state,s.reason,s.rounds],[null,'journal-unavailable',null])
 assert.deepEqual(s.checks.map(c=>[c.result,c.regressed,c.reason]),[[null,null,'journal-unavailable'],[null,null,'journal-unavailable']])
 assert.deepEqual([v.degraded.value,v.degraded.reason],[null,'journal-unavailable'])
 assert.deepEqual(v.strip.map(e=>[e.state,e.reason]),[[null,'journal-unavailable']])
 }
})
test('RV1-1 resumed step round rows have unique presentation keys', () => {
 const rows=[timelineStart(),{at:110,stage:'escalate:build'},timelineStart('a',1,120),timelineDone('a',1,130)]
 const view=stepped(steppedPayload(rows))
 assert.deepEqual(view.steps[0].rounds.map(r=>r.round),[1,1])
 const source=readFileSync(new URL('../visualizer/web/src/lib/PlanSteps.svelte',import.meta.url),'utf8')
 assert.match(source,/{#each step.rounds as round, i \(i\)}/)
})
test('RV1-2 only each card latest start can remain open', () => {
 const rows=[timelineStart(),{event:'step:red',step:'a',round:1,at:110},timelineStart('a',2,120),{at:125,stage:'escalate:build'},timelineStart('a',1,130),timelineDone('a',1,140),timelineStart('b',1,150),timelineDone('b',1,160)]
 assert.equal(stepped(steppedPayload(rows,[{id:'a'},{id:'b'}])).steps[0].state,'done')
})
test('RV1-3 plan header strip mirrors card IDs and states', () => {
 assert.equal(stepped(steppedPayload([timelineStart(),timelineCensus(150,3),timelineCensus(160,4),timelineDone()])).steps[0].rounds[0].turns_reason,'ambiguous-builder-census')
 const view=stepped(steppedPayload([timelineStart(),timelineDone()]))
 assert.deepEqual(view.strip.map(x=>[x.id,x.state]),view.steps.map(x=>[x.id,x.state]))
})
test('RV1-1 duplicate starts retain separate ordered round rows and keyed rendering', () => {
 const view=stepped(steppedPayload([timelineStart('a',1,100),{event:'step:bounce',step:'a',round:1,at:110,status:'retry'},timelineStart('a',1,120),timelineDone('a',1,130)]))
 assert.deepEqual(view.steps[0].rounds.map(r=>[r.round,r.outcome]),[[1,'bounced'],[1,'done']])
 const source=readFileSync(new URL('../visualizer/web/src/lib/PlanSteps.svelte',import.meta.url),'utf8')
 assert.match(source,/{#each step.rounds as round, i \(i\)}/)
})
test('RV1-2 latest open start in journal order owns active state', () => {
 const view=stepped(steppedPayload([timelineStart('a',1,100),timelineStart('b',1,110),timelineStart('a',2,120)],[{id:'a'},{id:'b'}]))
 assert.deepEqual(view.steps.map(s=>[s.state,s.reason]),[['active',null],[null,'superseded-open-round']])
})
test('RV1-3 task strip mirrors ordered card state and absence metadata', () => {
 const view=stepped(steppedPayload([timelineStart(),{event:'step:red',step:'a',round:1,at:200,failed:['C1']}]))
 assert.deepEqual(view.strip.map(x=>[x.id,x.state,x.reason,x.tone]),view.steps.map(x=>[x.id,x.state,x.reason,x.tone]))
 const component=readFileSync(new URL('../visualizer/web/src/lib/RunDetail.svelte',import.meta.url),'utf8')
 assert.match(component,/<PlanSteps \{journalState\} \/>/)
})
test('RV1-5 timeline vocabularies are frozen and consulted', () => {
 const {STEP_TIMELINE_REASONS,STEP_TIMELINE_STATES,STEP_TIMELINE_OUTCOMES,STEP_TIMELINE_TONES}=steppedModule
 assert.deepEqual(STEP_TIMELINE_REASONS,['plan-files-not-recorded','plan-dependencies-not-recorded','plan-checks-not-recorded','plan-chunk-carries-no-intent','no-gate-result','round-open','bounce-summary-not-journaled','not-a-bounce','gate-labels-not-recorded','invalid-round-timestamps','no-builder-census-in-window','ambiguous-builder-census','invalid-builder-census','no-per-step-cost-source','no-escalation-recorded','no-step-events','not-started','superseded-open-round','journal-unavailable','degrade-step-not-recorded','degrade-remaining-not-recorded','degrade-budget-not-recorded'])
 assert.deepEqual(STEP_TIMELINE_STATES,['done','active','red','escalated','degraded','not-started'])
 assert.deepEqual(STEP_TIMELINE_OUTCOMES,['done','red','bounced','accepted-by-gate'])
 assert.deepEqual(STEP_TIMELINE_TONES,['ok','busy','fail','serious','muted'])
 for(const values of [STEP_TIMELINE_REASONS,STEP_TIMELINE_STATES,STEP_TIMELINE_OUTCOMES,STEP_TIMELINE_TONES]) assert.equal(Object.isFrozen(values),true)
})
// MUTATION RV1-4b: drop the journal-unavailable branch of escalation_reason — an unreadable
// journal then reports no-escalation-recorded, a measured absence nobody measured.
test('RV1-4 an unreadable journal reports its escalation as journal-unavailable', () => {
 for (const flag of [{error:'read denied'},{degraded:true}]) {
  const s=stepped({...steppedPayload([timelineStart(),{at:150,stage:'escalate:build'}]),...flag}).steps[0]
  assert.deepEqual([s.escalation,s.escalation_reason],[null,'journal-unavailable'])
 }
 const s=stepped(steppedPayload([timelineStart(),{at:150,stage:'escalate:build'}])).steps[0]
 assert.deepEqual([s.escalation,s.escalation_reason],['escalate:build',null])
})
// MUTATION RV2-1: read regressions only from the step's own gate row — a later step's red gate
// that regresses C1 then leaves step a green with C1 passed.
// MUTATION RV3-1: keep any later regression sticky — b's passing retry then leaves a red forever.
test('RV2-1 a regression seen by a later step marks the owning step until a later gate passes it', () => {
 const chunks=[{id:'a',checks_owned:['C1','C2']},{id:'b',checks_owned:['C3']}]
 const red=[timelineStart(),timelineDone(),timelineStart('b',1,300),{event:'step:red',step:'b',round:1,at:400,failed:['C1'],regressed:['C1']}]
 const v=stepped(steppedPayload(red,chunks))
 assert.deepEqual(v.steps[0].checks.map(c=>[c.id,c.result,c.regressed,c.tone]),[['C1','failed',true,'fail'],['C2','passed',false,'ok']])
 assert.deepEqual([v.steps[0].state,v.steps[0].tone],['done','fail'])
 assert.deepEqual(v.strip[0],{id:'a',state:'done',reason:null,tone:'fail'})
 const retried=stepped(steppedPayload([...red,timelineStart('b',2,500),{event:'step:done',step:'b',round:2,at:600,passed:['C1','C2','C3']}],chunks))
 assert.deepEqual(retried.steps[0].checks.map(c=>[c.id,c.result,c.regressed,c.tone]),[['C1','passed',false,'ok'],['C2','passed',false,'ok']])
 assert.deepEqual(retried.strip[0],{id:'a',state:'done',reason:null,tone:'ok'})
})

// MUTATION RV2-2: let latestOpen fall back to any earlier unterminated start — step a, whose
// terminal row is missing, is revived as active after step b finishes.
test('RV2-2 an unterminated start superseded by a later step is never revived', () => {
 const v=stepped(steppedPayload([timelineStart(),timelineStart('b',1,300),timelineDone('b',1,400)],[{id:'a'},{id:'b'}]))
 assert.deepEqual(v.steps.map(s=>[s.id,s.state,s.reason]),[['a',null,'superseded-open-round'],['b','done',null]])
})

// MUTATION RV2-3: drop the reversed-window check from turnsReason — a round ending before it
// started then claims no builder census instead of invalid timestamps.
test('RV2-3 a reversed round window reports invalid timestamps for turns too', () => {
 const r=stepped(steppedPayload([timelineStart('a',1,200),timelineDone('a',1,100)])).steps[0].rounds[0]
 assert.deepEqual([r.duration_reason,r.turns,r.turns_reason],['invalid-round-timestamps',null,'invalid-round-timestamps'])
})

test('JR1 story kinds list journal filtering and counting', () => {
  assert.deepEqual(STORY_KINDS, ['stage', 'assign', 'envelope', 'plan_frozen', 'review_outcome', 'gate_discrimination', 'gate_check_discrimination', 'cold_suite', 'build_bounce', 'acceptance-coverage-bounce', 'step:bounce', 'decision', 'reseat', 'published', 'provider-retry', 'provider-retry-resumed', 'provider-retry-declined', 'seat-retrying', 'seat-substrate-down', 'seat-substrate-recovered'])
  assert.equal(Object.isFrozen(STORY_KINDS), true)
  const entry = (index, event, row, channel = null) => ({ index, at_ms: index * 1000, channel, event, row })
  const rows = [
    entry(0, 'assign', { assign: 'd2', role: 'builder' }),
    entry(1, 'stage', { stage: 'build:r1' }),
    entry(2, 'envelope', { envelope: 'd1', role: 'planner', status: 'done' }),
    entry(3, 'stage_done', { stage_done: 'build:r1' }),
    entry(4, 'fence-admitted', { 'fence-admitted': 'gate:r1' }),
    entry(5, 'seat-skills', { event: 'seat-skills', role: 'builder', skills: ['a', 'b', 'c'] }),
    entry(6, 'zz-unknown', { 'zz-unknown': true }),
    entry(7, 'seat-retrying', { event: 'seat-retrying', role: 'builder' }, 'operational'),
    entry(8, 'descendant-capture', { event: 'descendant-capture', role: 'builder' }, 'operational')
  ]
  const out = journalLines(rows, { reveal: false })
  assert.deepEqual(out.lines.map((l) => l.kind), ['assign', 'stage', 'envelope', 'seat-retrying'])
  assert.equal(out.operationalCount, 5)
})

test('JR2 envelope and gate journal sentences use plain words', () => {
  const entry = (index, event, row, channel = null) => ({ index, at_ms: index * 1000, channel, event, row })
  const env = journalLines([entry(0, 'envelope', { envelope: 'd4', role: 'builder', status: 'done' })], { envelopes: [{ assignment_id: 'd4', role: 'builder', status: 'done', valid: true, details: { files_changed: ['a.mjs', 'b.mjs'] } }] })
  const text = String(env.lines[0].text).toLowerCase()
  assert.ok(text.includes('builder'))
  assert.ok(text.includes('d4'))
  assert.ok(text.includes('done'))
  assert.ok(text.includes('2 files'))
  assert.equal(text.includes('unclassified'), false)
  const gate = journalLines([entry(1, 'gate_discrimination', { gate_discrimination: 'proven', gate_summary: { total: 5, failed: 5 } })], {})
  assert.ok(String(gate.lines[0].text).includes('5 of 5'))
  for (const line of env.lines.concat(gate.lines)) assert.equal(String(line.text).includes('unclassified'), false)
})

test('JR3 adjacent seat skills collapse with role rollup', () => {
  const entry = (index, event, row, channel = null) => ({ index, at_ms: index * 1000, channel, event, row })
  const skills = [
    entry(0, 'seat-skills', { event: 'seat-skills', role: 'builder', skills: ['a', 'b', 'c'] }),
    entry(1, 'seat-skills', { event: 'seat-skills', role: 'planner', skills: ['a'] }),
    entry(2, 'seat-skills', { event: 'seat-skills', role: 'lead', skills: [] }),
    entry(3, 'seat-skills', { event: 'seat-skills', role: 'reviewer', skills: [] }),
    entry(4, 'seat-skills', { event: 'seat-skills', role: 'tech-lead', skills: [] })
  ]
  const out = journalLines(skills, { reveal: true })
  assert.equal(out.lines.length, 1)
  assert.equal(out.lines[0].count, 5)
  assert.ok(String(out.lines[0].text).includes('builder 3'))
  assert.ok(String(out.lines[0].text).includes('planner 1'))
  const split = journalLines([entry(0, 'assign', { assign: 'd1', role: 'planner' }), entry(1, 'stage', { stage: 'build:r1' }), entry(2, 'assign', { assign: 'd2', role: 'builder' })], {})
  assert.equal(split.lines.filter((l) => l.kind === 'assign').length, 2)
})

test('JR4 handoff outcomes join envelopes with precedence', () => {
  const span = (id, role, started_at, ended_at, status = null) => ({ family: 'assignment', id, role, status, started_at, ended_at, duration_ms: ended_at == null ? null : ended_at - started_at, started_index: started_at })
  const view = { spans: [
    span('d1', 'tech-lead', 1, 2),
    span('d2', 'tech-lead', 3, 4),
    span('d4', 'builder', 5, 6),
    span('d6', 'reviewer', 7, 8),
    span('d1', 'planner', 9, 10),
    span('d1', 'planner', 11, 12),
    span('d9', 'builder', 13, 14),
    span('d10', 'builder', 15, null),
    span('d11', 'tech-lead', 16, 17)
  ] }
  const envelopes = [
    { assignment_id: 'd1', role: 'tech-lead', status: 'done', valid: true, details: { verdict: 'revise' } },
    { assignment_id: 'd2', role: 'tech-lead', status: 'done', valid: true, details: { verdict: 'approve' } },
    { assignment_id: 'd4', role: 'builder', status: 'done', valid: true, details: { files_changed: ['a.mjs', 'b.mjs'] } },
    { assignment_id: 'd6', role: 'reviewer', status: 'done', valid: true, details: { verdict: 'pass', must_fix: 0 } },
    { assignment_id: 'd1', role: 'planner', status: 'done', valid: true, details: {} },
    { assignment_id: 'd11', role: 'tech-lead', status: 'done', valid: true, details: { verdict: 'wobble' } }
  ]
  const path = assignmentPath(view, envelopes)
  const get = (d, r, occ = 0) => path.filter((p) => p.dispatch === d && p.role === r)[occ] || {}
  assert.equal(get('d1', 'tech-lead').outcome, 'changes requested')
  assert.equal(get('d2', 'tech-lead').outcome, 'accepted')
  assert.equal(get('d6', 'reviewer').outcome, 'accepted')
  assert.equal(get('d1', 'planner', 0).outcome, 'outcome not recorded')
  assert.equal(get('d1', 'planner', 1).outcome, 'outcome not recorded')
  assert.equal(get('d9', 'builder').outcome, 'outcome not recorded')
  assert.equal(get('d10', 'builder').outcome, 'in flight')
  assert.equal(get('d11', 'tech-lead').outcome, 'wobble')
  assert.ok(String(get('d4', 'builder').outcome).includes('done'))
  assert.ok(String(get('d4', 'builder').outcome).includes('2 files'))
  assert.equal(get('d2', 'tech-lead').tone, 'ok')
  assert.notEqual(get('d11', 'tech-lead').tone, 'ok')
})

// Mutation killed: restoring the journal span's status when its envelope has no status.
test('RV1-1 handoff status comes only from the joined envelope', () => {
  for (const role of ['builder', 'planner']) {
    const view = { spans:[{ family:'assignment', id:'d4', role, status:'done', started_at:1, ended_at:2 }] }
    for (const status of [{}, { status:null }]) {
      const envelopes = [{ assignment_id:'d4', role, valid:true, ...status }]
      assert.deepEqual(assignmentPath(view, envelopes).map(({ outcome, tone }) => ({ outcome, tone })), [{ outcome:'unknown', tone:'neutral' }])
    }
    assert.deepEqual(assignmentPath(view, [{ assignment_id:'d4', role, valid:true, status:'done' }]).map(({ outcome, tone }) => ({ outcome, tone })), [{ outcome:'done', tone:'ok' }])
  }
})

// Mutation killed: deriving handoffs from the focused view without the run-wide span list.
test('RV1-2 focused reused dispatch keeps run-wide envelope ambiguity', async () => {
  const { initialJournalState, trajectoryView } = await import('../visualizer/web/src/lib/live.js')
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/Trajectory.svelte'), 'utf8')
  const expression = source.match(/let handoffs = \$derived\((.+)\)/)?.[1]
  assert.ok(expression, 'the handoff derived expression must be readable')
  const handoffs = new Function('view', 'sourceState', 'envelopes', 'assignmentPath', 'trajectoryView', 'now', 'run', 'PANEL_REFRESH_MS', `return ${expression}`)
  const base = initialJournalState()
  const state = { ...base, payload:{ ...base.payload, rows:[
    { at:1000, assign:'d1', role:'planner' },
    { at:2000, envelope:'d1', role:'planner', status:'done' },
    { at:3000, assign:'d1', role:'planner' },
    { at:4000, envelope:'d1', role:'planner', status:'done' },
    { at:5000, assign:'d2', role:'builder' },
    { at:6000, envelope:'d2', role:'builder', status:'done' },
  ] } }
  const envelopes = [
    { assignment_id:'d1', role:'planner', valid:true, status:'done' },
    { assignment_id:'d2', role:'builder', valid:true, status:'done' },
  ]
  const path = (range) => {
    const sourceState = { ...state, range }
    const view = trajectoryView(sourceState)
    return handoffs(view, sourceState, envelopes, assignmentPath, trajectoryView, 6000, { running:false }, PANEL_REFRESH_MS)
  }
  assert.deepEqual(path(null).map(({ outcome, tone }) => [outcome, tone]), [['outcome not recorded','neutral'], ['outcome not recorded','neutral'], ['done','ok']])
  for (const [from, to, started_index] of [[1100,1900,0], [3100,3900,2]]) {
    assert.deepEqual(path({ from, to }).map(({ started_index, outcome, tone }) => [started_index, outcome, tone]), [[started_index,'outcome not recorded','neutral']])
  }
  assert.deepEqual(path({ from:5100, to:5900 }).map(({ outcome, tone }) => [outcome, tone]), [['done','ok']])
})

// Mutation killed: retaining the previous run's returns when the detail identity changes.
test('RV2-1 switching runs clears envelope joins before delayed details without clearing refreshes', async () => {
  const { applyRead, createPulse, initialJournalState, shouldRead, trajectoryView } = await import('../visualizer/web/src/lib/live.js')
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  // Execute the component's loaders and read effects; no DOM or rune scheduling is simulated.
  const setup = source.slice(source.indexOf('  let returns = $state('), source.indexOf('  $effect(() => {\n    const requested = phase'))
    .replace(/^  let \w+ = \$derived\([^\n]*\)\n/gm, '')
  const effects = []
  const pulse = createPulse()
  const pending = []
  const requests = []
  const runA = { repo_slug:'repo', goal:'task', adw_id:'run-A', running:true }
  const runB = { ...runA, adw_id:'run-B' }
  const returnsA = { envelopes:[{ assignment_id:'d4', role:'builder', status:'done', details:{ files_changed:['a.mjs','b.mjs'] } }], task:null }
  const returnsB = { envelopes:[{ assignment_id:'d4', role:'builder', status:'blocked', details:{ files_changed:['c.mjs'] } }], task:null }
  const instantiate = new Function('run', 'initialJournalState', 'applyRead', 'shouldRead', 'getReturns', 'getEvents', 'drainEvents', 'getJournal', 'journalPulse', '$state', '$effect', `${setup}
    return { setRun(next) { run = next }, snapshot() { return { returns, journalState, error } } }`)
  const reader = instantiate(runA, initialJournalState, applyRead, shouldRead,
    async (repo, task, id) => {
      requests.push(id)
      return id === 'run-A' ? returnsA : new Promise((resolve) => pending.push(resolve))
    },
    async () => ({ events:[] }), async () => ({ events:[] }),
    async (repo, task, id) => ({ ...initialJournalState().payload, rows:[
      { at:1000, assign:'d4', role:'builder' },
      { at:2000, envelope:'d4', role:'builder', status:id === 'run-A' ? 'done' : 'blocked' },
    ] }),
    pulse, (value) => value, (effect) => effects.push(effect))
  const [identity, journal, subscribe] = effects
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const story = () => {
    const { returns, journalState } = reader.snapshot()
    const view = trajectoryView(journalState)
    return {
      path:assignmentPath(view, returns.envelopes).map(({ outcome, tone }) => [outcome, tone]),
      journal:journalLines(view.rows, { envelopes:returns.envelopes }).lines.filter((line) => line.kind === 'envelope').map((line) => line.text),
    }
  }
  identity(); journal()
  const unsubscribe = subscribe()
  try {
    await tick()
    assert.deepEqual(story(), { path:[['done with 2 files changed','ok']], journal:['builder d4 returned done with 2 files changed'] })
    reader.setRun(runB)
    identity(); journal()
    await tick()
    assert.deepEqual(requests, ['run-A','run-B'])
    assert.equal(pending.length, 1)
    assert.deepEqual(story(), { path:[['outcome not recorded','neutral']], journal:['builder d4 returned blocked'] })
    pending.shift()(returnsB)
    await tick()
    const expectedB = { path:[['blocked','fail']], journal:['builder d4 returned blocked with 1 file changed'] }
    assert.deepEqual(story(), expectedB)
    identity(); journal()
    assert.deepEqual(story(), expectedB)
    pulse.pulse()
    await tick()
    assert.equal(pending.length, 1)
    assert.deepEqual(story(), expectedB)
    pending.shift()(returnsB)
    await tick()
    assert.deepEqual(story(), expectedB)
  } finally { unsubscribe() }
})

test('JR5 trajectory renders shaped journal with closed inspect', () => {
  const traj = readFileSync(join(ROOT, 'visualizer/web/src/lib/Trajectory.svelte'), 'utf8')
  const detail = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  assert.equal(traj.includes('unclassified'), false)
  assert.ok(traj.match(/<details(?![^>]*\bopen\b)[^>]*>\s*<summary>Inspect<\/summary>\s*<pre>\{line\.raw\}<\/pre>/))
  assert.ok(traj.split('journal.operationalCount').length - 1 >= 2)
  assert.ok(traj.includes('journalLines'))
  assert.ok(detail.includes('<Trajectory {run} {journalState} returns={evidence} />'))
  assert.ok(traj.includes('No agent handoffs in this view'))
  assert.ok(traj.includes('No journal rows in this interval'))
})

// MUTATION EL2: blank the ' (estimated)' suffix in price_label and the estimated row reads as measured.
const reasonCopyProbes = await import('../visualizer/web/src/lib/reason-copy.js').catch(() => null)
const traceProbes = await import('../visualizer/web/src/lib/trace.js').catch(() => null)
const fleetProbes = await import('../visualizer/web/src/lib/fleet.js').catch(() => null)
const planCardsProbes = await import('../visualizer/web/src/lib/plan-steps.js').catch(() => null)
const journalSourceProbes = await import('../visualizer/server/journal-source.mjs').catch(() => null)
test('PU1 reason copy covers every timeline and server slug', () => {
  assert.ok(reasonCopyProbes && planCardsProbes && journalSourceProbes, 'expected reason-copy, plan-steps and journal-source modules');
  assert.equal(Object.isFrozen(reasonCopyProbes.REASON_COPY), true);
  assert.ok(traceProbes && fleetProbes, 'expected trace and fleet modules');
  assert.equal(Object.isFrozen(traceProbes.PHASE_PANEL_REASONS), true);
  assert.equal(Object.isFrozen(fleetProbes.PROFILE_EVIDENCE_REASONS), true);
  const lists = [planCardsProbes.STEP_TIMELINE_REASONS, planCardsProbes.PLAN_STEP_REASONS, planCardsProbes.PLAN_ABSENCE_REASONS, journalSourceProbes.STEP_TITLE_REASONS, journalSourceProbes.ACCEPTANCE_REASONS, traceProbes.PHASE_PANEL_REASONS, fleetProbes.PROFILE_EVIDENCE_REASONS];
  for (const list of lists) {
    assert.equal(Array.isArray(list), true);
    for (const slug of list) {
      const text = reasonCopyProbes.reasonText(slug);
      assert.equal(typeof text, 'string');
      assert.notEqual(text.length, 0);
      assert.equal(text.includes(slug), false, slug);
    }
  }
  assert.equal(reasonCopyProbes.reasonText('made-up-slug').includes('made-up-slug'), true);
  assert.notEqual(reasonCopyProbes.reasonText(null).length, 0);
})
test('PH1 done phase headline records completion and collapses', () => {
  const panel = phasePanel({ phases: [{ id: 10987, name: 'done', status: 'ok', duration_ms: 1400 }], gate_checks: [] }, { phase: 10987, events: [{ phase_id: 10987, type: 'log', payload_json: '{"level":"info","message":"done"}' }], returns: { envelopes: [{ role: 'planner', dispatch_seq: 1, status: 'done', summary: 'Planner narrative.' }] } })
  assert.equal(panel.headline.text, 'Done · completion recorded in 1.4 s')
  assert.equal(panel.headline.collapsed, true)
})
test('PH2 build phase headline groups dispatches with gate proof', () => {
  const ev = (id, type, dispatch_id, at) => ({ id, phase_id: 2, type, payload_json: JSON.stringify({ role: 'builder', dispatch_id }), started_at: at, ended_at: at })
  const panel = phasePanel({ phases: [{ id: 2, name: 'build', status: 'ok' }], gate_checks: [{ phase_id: 2, gate_generation: 1, checks: [] }], gate_generations: [{ gate_generation: 1, verdict: 'proven', checks_total: 5, checks_failed: 0, checks_errored: 0 }] }, { phase: 2, events: [ev(1, 'agent_start', 'd4', 1000), ev(2, 'agent_end', 'd4', 260000), ev(3, 'agent_start', 'd5', 1000), ev(4, 'agent_end', 'd5', 689000)], returns: { envelopes: [] } })
  assert.equal(panel.headline.text, 'Build · 2 builder dispatches · 4m 19s + 11m 28s · gate 5/5 passed')
  assert.equal(panel.headline.collapsed, false)
  assert.deepEqual(panel.dispatches.map((d) => d.duration_ms), [259000, 688000])
})
test('PH2 built gate counts, not pristine proof', () => {
  // MUTATION: replace builtSummary with generation's pristine-proof counters.
  const summary = (total, failed, errored = 0) => [{ label:JSON.stringify({ total, failed, errored }) }]
  const builtRow = (failed, attempt) => ({ phase_id:2, gate_generation:1, gate_name:'gate:r1', attempt, checks:summary(10, failed) })
  const headline = (builtRows, verdict = 'proven') => phasePanel({
    phases:[{ id:2, name:'build', status:'ok' }],
    gate_checks:[
      ...builtRows,
      { phase_id:2, gate_generation:1, gate_name:'gate-proof:1', attempt:3, checks:summary(10, 10) },
    ],
    gate_generations:[{ gate_generation:1, verdict, checks_total:10, checks_failed:10, checks_errored:0 }],
  }, { phase:2 }).headline.text
  const green = headline([builtRow(2, 1), builtRow(0, 2)])
  assert.match(green, / · gate 10\/10 passed$/)
  assert.doesNotMatch(green, /\b0\/10\b/)
  assert.equal(headline([builtRow(2, 1)]), 'Build · gate 8/10 passed')
  assert.equal(headline([], 'failed'), 'Build · gate failed')
})
test('PH3 unpaired dispatch headline carries no zero duration and pins its footer', () => {
  const panel = phasePanel({ phases: [{ id: 2, name: 'build', status: 'running' }], gate_checks: [] }, { phase: 2, events: [{ id: 1, phase_id: 2, type: 'agent_start', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'd6' }), started_at: 1000, ended_at: 1000 }], returns: { envelopes: [] } })
  assert.equal(panel.headline.text, 'Build · 1 builder dispatch')
  assert.equal(panel.dispatches[0].duration_ms, null)
  const entry = panel.footer.find((e) => e.reason === 'dispatch-end-not-recorded')
  assert.ok(entry)
  assert.equal(entry.text, reasonCopyProbes.reasonText('dispatch-end-not-recorded'))
})
test('PH4 phase panel renders headline with collapsed details and quiet footer', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/PhasePanel.svelte'), 'utf8')
  assert.ok(source.includes('{panel.headline.text}'))
  assert.ok(source.includes('panel.headline.collapsed'))
  assert.ok(source.includes('<details class="phase-details">'))
  assert.ok(source.includes('<summary>details ▸</summary>'))
  assert.ok(source.includes('<details class="not-recorded">'))
  assert.equal(source.includes('evidence-elsewhere'), false)
  assert.equal(source.includes('No envelope narrative was recorded.'), false)
})
test('EV1 profile evidence separates measured cards from quiet footer', () => {
  const view = profileEvidenceView('code_review', { envelopes: [] })
  assert.deepEqual(view.cards, [])
  assert.deepEqual(view.footer.map((e) => e.key), ['base_head_identity', 'structured_findings', 'severity', 'citations', 'zero_source_writes'])
  for (const entry of view.footer) {
    assert.ok(Object.hasOwn(reasonCopyProbes.REASON_COPY, entry.reason))
    assert.equal(entry.text, reasonCopyProbes.reasonText(entry.reason))
  }
})
test('EV2 run detail renders measured cards with a quiet footer', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  assert.ok(source.includes('{#each profileEvidence.cards as block'))
  assert.ok(source.includes('<details class="not-recorded">'))
  assert.ok(source.includes('Not recorded: {profileEvidence.footer'))
  assert.equal(source.includes("{block.measured ? 'Recorded' : 'Not recorded'}"), false)
})
test('TS1 topology pills carry stage names without visible text', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  assert.ok(source.includes('aria-label={row.stage}'))
  assert.ok(source.includes('title={row.stage}'))
  assert.ok(source.includes('topology-defects'))
  assert.equal(source.includes("<small>{row.status === 'conditional' ? 'Conditional' : row.status}</small>"), false)
  assert.equal(source.includes('<strong>{row.stage}</strong>'), false)
})
test('TS2 converge checkpoint is conditional with no missing defect', () => {
  const topo = executionTopology('full', ['plan', 'check', 'gate-baseline', 'build', 'gate', 'scope-gate', 'lane', 'gate-proof', 'review', 'commit', 'document', 'rebase', 'suite', 'publish', 'done'], { complete: true })
  assert.deepEqual(topo.defects, [])
  assert.equal(topo.rows.find((r) => r.stage === 'converge').status, 'conditional')
})
test('HS1 plan is presented once with readable absence reasons', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  const plan = readFileSync(join(ROOT, 'visualizer/web/src/lib/PlanSteps.svelte'), 'utf8')
  assert.equal(source.split('<PlanSteps {journalState} />').length - 1, 1)
  assert.ok(plan.includes('reasonText(check.reason)'))
  assert.equal(source.includes('step-strip'), false)
})
test('PU2 plan step cards choose titles by precedence', () => {
  assert.ok(planCardsProbes && typeof planCardsProbes.planStepCards === 'function', 'expected planStepCards');
  const cases = [
    [{ plan: { chunks: [{ id: 'S1', intent: 'Recorded', checks_owned: ['LG4'] }] }, rows: [] }, 'Recorded', 'intent'],
    [{ plan: { chunks: [{ id: 'S1', checks_owned: ['LG4'] }] }, rows: [], step_titles: { S1: 'process-group registry' } }, 'process-group registry', 'plan-heading'],
    [{ plan: { chunks: [{ id: 'S1', checks_owned: ['LG4'] }] }, rows: [], acceptance: { LG4: 'Reaps the group. More text.' } }, 'Reaps the group.', 'acceptance'],
    [{ plan: { chunks: [{ id: 'S1', checks_owned: ['LG1', 'LG2'] }] }, rows: [] }, 'Owns checks LG1, LG2', 'check-ids'],
    [{ plan: { chunks: [{ id: 'S1' }] }, rows: [] }, 'Step S1', 'step-id'],
  ];
  for (const entry of cases) {
    const card = planCardsProbes.planStepCards(entry[0]).steps[0];
    assert.deepEqual([card.title, card.title_source], [entry[1], entry[2]]);
  }
})
test('PU3 plan step cards render one-line round labels and durations', () => {
  assert.ok(planCardsProbes && typeof planCardsProbes.planStepCards === 'function' && typeof planCardsProbes.formatStepDuration === 'function', 'expected planStepCards and formatStepDuration');
  const build = (id, owned, ms, turns) => planCardsProbes.planStepCards({ plan: { chunks: [{ id, checks_owned: owned, files_in_scope: [], depends_on: [] }] }, rows: [{ event: 'step:start', step: id, round: 1, at: 1000 }, { at: 1500, seat_turn_census: { role: 'builder', turns } }, { event: 'step:done', step: id, round: 1, at: 1000 + ms, passed: owned }] }).steps[0].rounds[0].label;
  assert.equal(build('S2', ['LG1', 'LG2', 'LG3', 'LG5'], 688047, 52), 'Round 1 \u00b7 4/4 checks passed \u00b7 11m 28s \u00b7 52 turns');
  assert.equal(build('S1', ['LG4'], 258539, 21), 'Round 1 \u00b7 1/1 checks passed \u00b7 4m 19s \u00b7 21 turns');
  assert.deepEqual([planCardsProbes.formatStepDuration(42000), planCardsProbes.formatStepDuration(258539), planCardsProbes.formatStepDuration(3780000)], ['42s', '4m 19s', '1h 3m']);
})
test('PU4 plan step cards show failed segments only when recorded', () => {
  assert.ok(planCardsProbes && typeof planCardsProbes.planStepCards === 'function', 'expected planStepCards');
  const view = (t) => planCardsProbes.planStepCards({ plan: { chunks: [{ id: 'S1', checks_owned: ['C1', 'C2'], files_in_scope: [], depends_on: [] }] }, rows: [{ event: 'step:start', step: 'S1', round: 1, at: 1000 }, { at: 1500, seat_turn_census: { role: 'builder', turns: 3 } }, t] });
  const red = view({ event: 'step:red', step: 'S1', round: 1, at: 2000, failed: ['C1'], regressed: ['C2'] });
  assert.equal(red.steps[0].rounds[0].label.includes(' \u00b7 failed: C1 \u00b7 regressed: C2'), true);
  const bare = view({ event: 'step:red', step: 'S1', round: 1, at: 2000 });
  assert.equal(bare.steps[0].rounds[0].label.includes('failed:'), false);
  assert.equal(bare.steps[0].rounds[0].label.includes('Unmeasured'), false);
  assert.equal(bare.footer.some((e) => e.reason === 'gate-labels-not-recorded'), true);
  const done = view({ event: 'step:done', step: 'S1', round: 1, at: 2000, passed: ['C1', 'C2'] });
  assert.equal(done.footer.some((e) => e.reason === 'gate-labels-not-recorded'), false);
})
test('PU5 plan step cards footer always names cost and missing descriptions', () => {
  assert.ok(planCardsProbes && reasonCopyProbes, 'expected planStepCards and reasonText');
  const payload = (extra) => ({ plan: { chunks: [{ id: 'S1', checks_owned: ['C1'], files_in_scope: [], depends_on: [] }] }, rows: [{ event: 'step:start', step: 'S1', round: 1, at: 1000 }, { at: 1500, seat_turn_census: { role: 'builder', turns: 3 } }, { event: 'step:done', step: 'S1', round: 1, at: 2000, passed: ['C1'] }], ...extra });
  const full = planCardsProbes.planStepCards(payload({ step_titles: { S1: 'Do the thing' } }));
  assert.deepEqual(full.footer.map((e) => e.label), ['cost per step']);
  assert.deepEqual([full.footer[0].reason, full.footer[0].steps], ['no-per-step-cost-source', ['S1']]);
  const bare = planCardsProbes.planStepCards(payload({ step_titles: null, acceptance: null }));
  assert.deepEqual(bare.footer.map((e) => e.label), ['cost per step', 'step description']);
  for (const e of bare.footer) assert.equal(e.text, reasonCopyProbes.reasonText(e.reason));
})
test('PU7 plan steps panel renders cards with details and footer', () => {
  const source = readSource(new URL('../visualizer/web/src/lib/PlanSteps.svelte', import.meta.url), 'utf8');
  assert.equal(source.includes('Unmeasured \u2014 ${'), false);
  assert.equal(source.includes('planStepCards'), true);
  assert.equal((source.match(/<details/g) || []).length >= 2, true);
  assert.equal(source.includes('Not recorded:'), true);
  assert.equal(source.includes('<ol class="step-timeline">'), true);
  assert.equal(source.includes('{#each step.rounds as round, i (i)}'), true);
})

// MUTATION RV1-1: restore the file-path key and duplicate recorded paths collide.
test('RV1-1 plan steps preserve duplicate files with index-keyed rendering', () => {
  const view = planCardsProbes.planStepCards({
    plan: { chunks: [{ id: 'S1', files_in_scope: ['a.mjs', 'a.mjs'] }] },
    rows: [],
  })
  assert.deepEqual(view.steps[0].files, ['a.mjs', 'a.mjs'])
  const source = readSource(new URL('../visualizer/web/src/lib/PlanSteps.svelte', import.meta.url), 'utf8')
  assert.match(source, /\{#each step\.files as file, i \(i\)\}<li>\{file\}<\/li>\{\/each\}/)
})

// MUTATION RV1-2: drop the missing-step title and its translated reason loses provenance.
test('RV1-2 plan steps keep degradation reason slugs beside translated values', () => {
  const view = planCardsProbes.planStepCards({
    plan: { chunks: [{ id: 'S1' }] },
    rows: [{ event: 'step:degrade', reason: 'degraded-to-whole-build' }],
  })
  assert.deepEqual(view.degraded, {
    value: true, step: null, step_reason: 'degrade-step-not-recorded',
    remaining: null, remaining_reason: 'degrade-remaining-not-recorded',
    reason: 'degraded-to-whole-build', budget: null, budget_reason: 'degrade-budget-not-recorded',
  })
  const source = readSource(new URL('../visualizer/web/src/lib/PlanSteps.svelte', import.meta.url), 'utf8')
  for (const span of [
    "<span title={view.degraded.reason || undefined}>{reasonText(view.degraded.reason) || 'Source reason not recorded'}</span>",
    '<span title={view.degraded.step_reason || undefined}>{view.degraded.step ?? reasonText(view.degraded.step_reason)}</span>',
    "<span title={view.degraded.remaining_reason || undefined}>{view.degraded.remaining?.join(', ') ?? reasonText(view.degraded.remaining_reason)}</span>",
    '<span title={view.degraded.budget_reason || undefined}>{view.degraded.budget ?? reasonText(view.degraded.budget_reason)}</span>',
  ]) assert.ok(source.includes(span), span)
})

test('coverage-reask handoff joins each span to the envelope of its own kind', async () => {
  // Mutation killed: the unmarked-pair refusal without the coverage_reask join (VF4).
  const { buildTrajectory } = await import('../visualizer/web/src/lib/spans.js')
  const envelopes = [
    { assignment_id: 'd1', role: 'planner', valid: true, status: 'done', coverage_reask: null, details: {} },
    { assignment_id: 'd1', role: 'planner', valid: true, status: 'insufficient', coverage_reask: 'coverage-reask', details: {} },
  ]
  const view = buildTrajectory([
    { at: 1000, assign: 'd1', role: 'planner', brief: '/crew/task/planner-assignment-r1.md' },
    { at: 2000, envelope: 'd1', role: 'planner', status: 'done' },
    { at: 3000, assign: 'd1', role: 'planner', brief: '/crew/task/planner-coverage-reask-r1.md' },
    { at: 4000, envelope: 'd1', role: 'planner', status: 'done' },
  ])
  assert.deepEqual(assignmentPath(view, envelopes).map((entry) => [entry.outcome, entry.tone]), [['done', 'ok'], ['insufficient', 'warn']])
  const unmarked = buildTrajectory([
    { at: 1000, assign: 'd1', role: 'planner' },
    { at: 2000, envelope: 'd1', role: 'planner', status: 'done' },
    { at: 3000, assign: 'd1', role: 'planner' },
    { at: 4000, envelope: 'd1', role: 'planner', status: 'done' },
  ])
  assert.deepEqual(assignmentPath(unmarked, envelopes).map((entry) => entry.outcome), ['outcome not recorded', 'outcome not recorded'])
})

test('phase artifacts scope documents, paths and blocks to the phase dispatch set', () => {
  // Mutation killed: documents: artifactDocuments(phaseEnvelopes) -> artifactDocuments(envelopeList) (VF5).
  const run = { phases: [{ id: 1, name: 'plan' }, { id: 2, name: 'build' }, { id: 3, name: 'review' }] }
  const events = [
    { type: 'agent_start', phase_id: 1, payload: { dispatch_id: 'd1', role: 'planner' } },
    { type: 'agent_end', phase_id: 1, payload: { dispatch_id: 'd1', role: 'planner' } },
    { type: 'agent_start', phase_id: 2, payload: { dispatch_id: 'd4', role: 'builder' } },
    { type: 'agent_end', phase_id: 2, payload: { dispatch_id: 'd4', role: 'builder' } },
  ]
  const returns = { envelopes: [
    { role: 'planner', dispatch_seq: 1, status: 'done', summary: 'Plan narrative', artifacts: ['task/plan.md'], details: {} },
    { role: 'builder', dispatch_seq: 4, status: 'done', summary: 'Build narrative', artifacts: ['src/build.mjs'], details: {} },
  ] }
  const panel = phasePanel(run, { phase: 'plan', events, returns })
  assert.deepEqual(panel.artifacts.documents.map((document) => document.dispatch_seq), [1])
  assert.deepEqual(panel.artifacts.paths.map((artifact) => artifact.path), ['task/plan.md'])
  const blocks = JSON.stringify(panel.artifacts.blocks)
  assert.ok(blocks.includes('Plan narrative'))
  assert.equal(blocks.includes('Build narrative'), false)
  const empty = phasePanel(run, { phase: 'review', events, returns })
  assert.deepEqual(empty.artifacts.documents, [])
  assert.deepEqual(empty.artifacts.paths, [])
  assert.ok(empty.footer.some((entry) => entry.reason === 'no-envelope-narrative-in-phase'))
})

test('event story raw block renders under the approved Inspect label', () => {
  // Mutation killed: <summary>Inspect</summary> -> <summary>Raw ledger event</summary> (VF6).
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/EventStory.svelte'), 'utf8')
  assert.ok(source.includes('<details class="raw"><summary>Inspect</summary><pre>{story.raw}</pre></details>'))
  assert.equal(source.includes('Raw ledger event'), false)
})

const sameDispatchReturns = [
  { file: '/crew/returns/run-x/d1.planner.json', assignment_id: 'd1', dispatch_seq: 1, role: 'planner', coverage_reask: null, status: 'done', valid: true, summary: 'Plan narrative' },
  { file: '/crew/returns/run-x/d1.coverage-reask.planner.json', assignment_id: 'd1', dispatch_seq: 1, role: 'planner', coverage_reask: 'coverage-reask', status: 'insufficient', valid: true, summary: 'Coverage narrative' },
]

test('RV1-1 same-dispatch returns remain independently selectable in Inspector', () => {
  // Mutation killed: current() compares dispatch_seq instead of file.
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/EnvelopeInspector.svelte'), 'utf8')
  const current = source.match(/  function current[^\n]+/)?.[0]
  const chooseAttempt = source.match(/  function chooseAttempt[^\n]+/)?.[0]
  const inspector = new Function('selectedAttempt', `let showDiff = false
${current}
${chooseAttempt}
return { current, chooseAttempt }`)({})
  const [{ role, entries }] = envelopeGroups(sameDispatchReturns)
  assert.equal(inspector.current(role, entries).summary, 'Coverage narrative')
  inspector.chooseAttempt(role, '/crew/returns/run-x/d1.planner.json')
  assert.equal(inspector.current(role, entries).summary, 'Plan narrative')
  inspector.chooseAttempt(role, '/crew/returns/run-x/d1.coverage-reask.planner.json')
  assert.equal(inspector.current(role, entries).summary, 'Coverage narrative')
  assert.match(source, /\{#each activeGroup\.entries as attempt \(attempt\.file\)\}/)
  assert.match(source, /onclick=\{\(\) => chooseAttempt\(activeGroup\.role, attempt\.file\)\}/)
})

test('RV1-1 same-dispatch phase narratives retain independent disclosure identities', () => {
  // Mutation killed: artifactDocuments() drops the envelope file from document IDs.
  const panel = phasePanel({ phases: [{ id: 1, name: 'planning' }] }, {
    phase: 'planning',
    events: [
      { type: 'agent_start', phase_id: 1, payload: { dispatch_id: 'd1', role: 'planner' } },
      { type: 'agent_end', phase_id: 1, payload: { dispatch_id: 'd1', role: 'planner' } },
    ],
    returns: { envelopes: sameDispatchReturns },
  })
  assert.deepEqual(panel.artifacts.documents.map((document) => [document.id, document.status, document.blocks]), [
    ['/crew/returns/run-x/d1.coverage-reask.planner.json', 'insufficient', renderMarkdown('Coverage narrative')],
    ['/crew/returns/run-x/d1.planner.json', 'done', renderMarkdown('Plan narrative')],
  ])
})

test('PP1 pairs same-id dispatches of different roles separately', () => {
  // Mutation killed: pairing key back to String(id) alone merges the two d1 rows into one 8000 ms planner row.
  const ev = (id, phase_id, type, role, dispatch_id, at) => ({ id, phase_id, type, payload_json: JSON.stringify({ role, dispatch_id }), started_at: at, ended_at: at })
  const panel = phasePanel({ phases: [{ id: 1, name: 'plan', status: 'ok' }], gate_checks: [] }, { phase: 'plan', events: [
    ev(1, 1, 'agent_start', 'planner', 'd1', 1000), ev(2, 1, 'agent_end', 'planner', 'd1', 5000),
    ev(3, 1, 'agent_start', 'tech-lead', 'd1', 6000), ev(4, 1, 'agent_end', 'tech-lead', 'd1', 9000),
  ], returns: { envelopes: [] } })
  assert.deepEqual(panel.dispatches.map((d) => [d.role, d.dispatch_id, d.duration_ms]), [['planner', 'd1', 4000], ['tech lead', 'd1', 3000]])
  assert.match(panel.headline.text, /1 planner dispatch, 1 tech lead dispatch/)
})

test('PP2 scopes plan-phase envelopes by (role, dispatch_seq)', () => {
  // Mutation killed: dropping the raw-role half of the phaseEnvelopes match leaks the reviewer d1 return into plan.
  const ev = (id, phase_id, type, role, dispatch_id, at) => ({ id, phase_id, type, payload_json: JSON.stringify({ role, dispatch_id }), started_at: at, ended_at: at })
  const run = { phases: [{ id: 1, name: 'plan', status: 'ok' }, { id: 2, name: 'review', status: 'ok' }], gate_checks: [] }
  const events = [
    ev(1, 1, 'agent_start', 'planner', 'd1', 1000), ev(2, 1, 'agent_end', 'planner', 'd1', 5000),
    ev(3, 1, 'agent_start', 'tech-lead', 'd1', 6000), ev(4, 1, 'agent_end', 'tech-lead', 'd1', 9000),
    ev(5, 2, 'agent_start', 'reviewer', 'd1', 1000), ev(6, 2, 'agent_end', 'reviewer', 'd1', 5000),
  ]
  const returns = { envelopes: [
    { role: 'planner', dispatch_seq: 1, status: 'done', summary: 'Planner PP2 narrative' },
    { role: 'tech-lead', dispatch_seq: 1, status: 'done', summary: 'TechLead PP2 narrative' },
    { role: 'reviewer', dispatch_seq: 1, status: 'done', summary: 'Reviewer PP2 narrative' },
  ] }
  const panel = phasePanel(run, { phase: 'plan', events, returns })
  assert.deepEqual(panel.artifacts.documents.map((d) => d.role).sort(), ['planner', 'tech-lead'])
  assert.equal(JSON.stringify(panel.artifacts.blocks).includes('Reviewer PP2 narrative'), false)
})

test('PP3 labels unpaired same-id dispatches with distinct role names', () => {
  // Mutation killed: label back to 'dispatch ' + dispatch.dispatch_id collapses the two d1 labels to duplicates.
  const ev = (id, phase_id, type, role, dispatch_id, at) => ({ id, phase_id, type, payload_json: JSON.stringify({ role, dispatch_id }), started_at: at, ended_at: at })
  const panel = phasePanel({ phases: [{ id: 1, name: 'plan', status: 'running' }], gate_checks: [] }, { phase: 'plan', events: [
    ev(1, 1, 'agent_start', 'planner', 'd1', 1000), ev(2, 1, 'agent_start', 'tech-lead', 'd1', 6000),
  ], returns: { envelopes: [] } })
  const entries = panel.footer.filter((e) => e.reason === 'dispatch-end-not-recorded')
  assert.equal(entries.length, 2)
  assert.equal(new Set(entries.map((e) => e.label)).size, entries.length)
  assert.deepEqual(entries.map((e) => e.label).sort(), ['planner dispatch d1', 'tech lead dispatch d1'])
})

const now = Date.parse('2026-10-25T12:00:00Z')
const run = (id, overrides = {}) => ({ adw_id:id, started_at:'2026-10-25T10:00:00Z', running:false, status:'ok', duration_ms:1000, ...overrides })

test('activity shares task outcome precedence, period and terminal denominator', () => {
  const rows = [run('a'), run('b', { settlement:{outcome:'escalated'} }), run('c', {status:'fail'}), run('d', {status:'aborted'}), run('e', {status:'running', running:true, duration_ms:999999}), run('f', {status:null, duration_ms:999999}), run('old', {started_at:'2026-09-01T00:00:00Z'})]
  const result = activitySummary(rows, {now, period:'1'})
  assert.equal(result.total, 6)
  assert.deepEqual(result.counts, {success:1, escalated:1, fail:1, aborted:1, open:1, unknown:1})
  assert.equal(result.settled, 4)
  assert.equal(result.successRate, 25)
  assert.equal(result.durationMeasured, 4)
  assert.equal(result.median, 1000)
  assert.equal(result.buckets.reduce((n,b) => n+b.count, 0), result.total)
  assert.equal(result.attention.length, 4)
  assert.equal(activitySummary(rows, {now, period:'all'}).total, 7)
})

test('activity honors escalation envelopes and keeps archives in history only', () => {
  const rows = [run('a'), run('b', {status:'fail', triage:{reviewed_at:'2026-10-25'}})]
  const result = activitySummary(rows, {now, envelopes:new Map([['a', {status:'escalation'}]])})
  assert.equal(result.counts.escalated, 1)
  assert.equal(result.counts.success, 0)
  assert.equal(result.total, 2)
  assert.deepEqual(result.attention.map(r=>r.run.adw_id), ['a'])
})

test('usage preserves missing and partial categories, and includes real zero', () => {
  const rows = [run('a', {metrics:{billed_input_tokens:100, billed_output_tokens:20, billed_cache_read_tokens:200, billed_cache_write_tokens:0}}), run('b', {metrics:{billed_input_tokens:0}}), run('c')]
  const {usage} = activitySummary(rows, {now})
  assert.deepEqual(usage, {total:320, measured:2, complete:1, input:100, output:20, cacheWrite:0, cacheRead:200})
  assert.equal(activitySummary([run('a')], {now}).usage.total, null)
  assert.equal(activitySummary([run('a',{metrics:{billed_input_tokens:0}})], {now}).usage.total, 0)
})

test('degraded reads suppress all numerators, charts and drilldowns', () => {
  for (const rows of [[],[run('a')]]) {
    const result = activitySummary(rows, {now, degraded:true})
    for (const key of ['total','counts','settled','successRate','median','usage','durationMeasured']) assert.equal(result[key], null, key)
    assert.deepEqual(result.rows, [])
    assert.deepEqual(result.buckets, [])
    assert.deepEqual(result.attention, [])
    assert.match(result.unavailable, /Retry/)
  }
})

test('time boundaries and missing dates cannot silently become chart events', () => {
  const rows = [run('start',{started_at:new Date(now-86400000).toISOString()}),run('end',{started_at:new Date(now).toISOString()}),run('future',{started_at:new Date(now+1).toISOString()}),run('unknown',{started_at:null}),run('before',{started_at:new Date(now-86400001).toISOString()})]
  const scoped = activitySummary(rows, {now, period:'1'})
  assert.equal(scoped.total, 2)
  assert.equal(scoped.undated, 2)
  assert.equal(scoped.buckets[0].count, 1)
  assert.equal(scoped.buckets.at(-1).count, 1)
  const all = activitySummary(rows, {now, period:'all'})
  assert.equal(all.total, 5)
  assert.equal(all.buckets.reduce((n,b)=>n+b.count,0), 3)
  assert.equal(activitySummary([], {now}).successRate, null)
})

test('ledger refresh waits after completion, coalesces clicks and resets its pause', async () => {
  const { createRefreshLoop } = await import('../visualizer/web/src/lib/live.js')
  const timers = new Map()
  let next = 0, reads = 0, finish
  const loop = createRefreshLoop(() => { reads += 1; return new Promise(resolve => { finish = resolve }) }, {
    setTimeout: (fn, delay) => { timers.set(++next, {fn, delay}); return next },
    clearTimeout: id => timers.delete(id),
  })
  const first = loop.refresh()
  await Promise.resolve()
  assert.equal(reads, 1)
  assert.equal(loop.refresh(), first)
  assert.equal(timers.size, 0, 'a slow read must never have a periodic timer alongside it')
  finish()
  await first
  assert.deepEqual([...timers.values()].map(t => t.delay), [30000])
  const manual = loop.refresh()
  await Promise.resolve()
  assert.equal(timers.size, 0, 'manual refresh cancels the old scheduled read')
  assert.equal(reads, 2)
  finish()
  await manual
  assert.deepEqual([...timers.values()].map(t => t.delay), [30000])
  loop.stop()
  assert.equal(timers.size, 0)
})

test('paused, hidden and disposed ledger refreshes do not restart themselves', async () => {
  const { createRefreshLoop } = await import('../visualizer/web/src/lib/live.js')
  const timers = new Map()
  let next = 0, reads = 0, finish, visible = false
  const loop = createRefreshLoop(() => { reads += 1; return new Promise(resolve => { finish = resolve }) }, {
    visible: () => visible,
    setTimeout: (fn, delay) => { timers.set(++next, {fn, delay}); return next },
    clearTimeout: id => timers.delete(id),
  })
  const tick = () => { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn() }
  const initial = loop.refresh()
  await Promise.resolve(); finish(); await initial
  tick(); await Promise.resolve()
  assert.equal(reads, 1, 'hidden tabs skip the scheduled read')
  assert.equal(timers.size, 1)
  loop.setEnabled(false)
  assert.equal(timers.size, 0)
  const manual = loop.refresh()
  await Promise.resolve(); finish(); await manual
  assert.equal(reads, 2, 'manual refresh remains available while auto refresh is paused')
  assert.equal(timers.size, 0)
  loop.setEnabled(true)
  visible = true
  tick(); await Promise.resolve()
  assert.equal(reads, 3)
  const running = loop.refresh()
  loop.setEnabled(false)
  finish(); await running
  assert.equal(timers.size, 0, 'pausing during a request must suppress its next timer')
  const last = loop.refresh()
  await Promise.resolve(); loop.stop(); finish(); await last
  assert.equal(timers.size, 0, 'a completed read must not resurrect a disposed loop')
  await loop.refresh()
  assert.equal(reads, 4)
})

test('task overview distinguishes reported work, review and final outcome', async () => {
  const { taskDetailSummary, verifiedTaskReturns } = await import('../visualizer/web/src/lib/task-detail.js')
  const run = { running:true, status:'running', phases:[{ name:'build' }], runtime:{ driver_state:'unknown' }, settlement:{state:'unsettled'} }
  const rows = [
    {valid:true,role:'builder',dispatch_seq:10,status:'done',summary:'Later work',details:{files_changed:['a.js','b.js']}},
    {valid:true,role:'reviewer',dispatch_seq:9,status:'done',summary:'Review',details:{verdict:'pass'}},
    {valid:true,role:'builder',dispatch_seq:2,status:'done',summary:'Earlier work',details:{files_changed:['a.js']}},
    {valid:false,role:'builder',dispatch_seq:11,summary:'Invalid report'},
    {valid:true,role:'builder',dispatch_seq:null,summary:'Unordered report'},
  ]
  const verified = {verified:true,envelopes:rows,task:null}
  const view = taskDetailSummary(run, verified)
  assert.equal(view.report.summary,'Later work')
  assert.equal(view.review.dispatch_seq,9)
  assert.equal(view.status.key,'unverified')
  assert.deepEqual(view.files,['a.js','b.js'])
  for (const payload of [{...verified,verified:false},{...verified,degraded:true},{}]) {
    const unknown = taskDetailSummary(run,payload)
    assert.equal(unknown.report,null)
    assert.equal(unknown.review,null)
    assert.deepEqual(unknown.files,[])
    assert.deepEqual(verifiedTaskReturns(payload),{envelopes:[],task:null})
  }
  const escalation={status:'escalation',details:{escalation:{why:'Gate could not run',question:{prompt:'Which environment should be used?'}}}}
  assert.equal(taskDetailSummary(run,{...verified,task:escalation}).next,'Which environment should be used?')
  assert.equal(taskDetailSummary(run,{...verified,verified:false,task:escalation}).status.key,'unverified')
  assert.equal(taskDetailSummary({...run,settlement:{outcome:'success'}},{...verified,task:escalation}).status.key,'success')
  assert.equal(verifiedTaskReturns({...verified,task:[]}).task,null)
})

test('missing round results are not presented as zero passed', () => {
  const card = (extra) => planCardsProbes.planStepCards({plan:{chunks:[{id:'a',checks_owned:['C1','C2']}]}, rows:[
    {event:'step:start',step:'a',round:1,at:1000},
    {event:'step:red',step:'a',round:1,at:2000,...extra},
  ]}).steps[0].rounds[0]
  assert.match(card({}).label,/Pass count not recorded/)
  assert.doesNotMatch(card({}).label,/0\/2/)
  assert.match(card({passed:[],failed:['C1','C2']}).label,/0\/2 checks passed/)
})

test('detail refresh includes final settlement and preserves successful partial reads', async () => {
  const {applyRead,createPulse,initialJournalState} = await import('../visualizer/web/src/lib/live.js')
  const source=readFileSync(join(ROOT,'visualizer/web/src/lib/RunDetail.svelte'),'utf8')
  const setup=source.slice(source.indexOf('  let returns = $state('),source.indexOf('  $effect(() => {\n    const requested = phase')).replace(/^  let \w+ = \$derived\([^\n]*\)\n/gm,'')
  const effects=[],pulse=createPulse();let reads=0,failEvents=false
  const instantiate=new Function('run','initialJournalState','applyRead','getReturns','getEvents','drainEvents','getJournal','journalPulse','$state','$effect',`${setup};return {snapshot(){return {returns,events,error,loading}},setRun(next){run=next}}`)
  const run={adw_id:'a',repo_slug:'r',goal:'g',running:true}
  const reader=instantiate(run,initialJournalState,applyRead,async()=>({verified:true,envelopes:[],task:{status:++reads===1?'running':'escalation'}}),async()=>{},async()=>{if(failEvents)throw Error('offline');return {events:[{id:1}]}},async()=>({rows:[]}),pulse,v=>v,f=>effects.push(f))
  const tick=()=>new Promise(resolve=>setImmediate(resolve))
  effects[0]();effects[1]();const unsubscribe=effects[2]()
  try {
    await tick();assert.equal(reader.snapshot().returns.task.status,'running')
    reader.setRun({...run,running:false});failEvents=true;pulse.pulse();await tick()
    assert.equal(reads,2)
    assert.equal(reader.snapshot().returns.task.status,'escalation')
    assert.deepEqual(reader.snapshot().events,[{id:1}])
    assert.match(reader.snapshot().error,/Event history could not be refreshed/)
    assert.equal(reader.snapshot().loading,false)
  } finally {unsubscribe()}
})


// Reversing an edit must remove the pending move, not keep a no-op ready to apply.
test('visualizer architecture keeps legacy Svelte syntax out of every component', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? (entry.name === 'node_modules' || entry.name === 'dist' ? [] : walk(join(dir, entry.name))) : [join(dir, entry.name)])
  const files = walk(join(ROOT, 'visualizer'))
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const relative = file.replace(`${ROOT}/`, '')
    if (file.endsWith('.svelte')) {
      assert.doesNotMatch(source, /^\s*export\s+let\s/m, relative)
      assert.doesNotMatch(source, /^\s*\$:\s/m, relative)
    }
  }
  assert.ok(files.some((file) => file.endsWith('.svelte')))
})

test('theme role and lane aliases follow the ratified role order', () => {
  const css = readFileSync(join(ROOT, 'visualizer/web/src/lib/theme.css'), 'utf8')
  for (const [index, role] of ROLE_ORDER.entries()) {
    assert.match(css, new RegExp(`--role-${role}\\s*:`))
    assert.match(css, new RegExp(`--lane-${index}\\s*:\\s*var\\(\\s*--role-${role}\\s*\\)`))
  }
})

test('theme gives component scrollbars a thin theme-aware treatment', () => {
  const css = readFileSync(join(ROOT, 'visualizer/web/src/lib/theme.css'), 'utf8')
  assert.match(css, /--scrollbar-track\s*:/)
  assert.match(css, /--scrollbar-thumb\s*:/)
  assert.match(css, /scrollbar-width:\s*thin/)
  assert.match(css, /scrollbar-color:\s*var\(--scrollbar-thumb\) var\(--scrollbar-track\)/)
  assert.match(css, /\*::\-webkit-scrollbar\s*\{[^}]*width:\s*\.625rem[^}]*height:\s*\.625rem/)
  assert.match(css, /\*::\-webkit-scrollbar-thumb:hover\s*\{[^}]*var\(--scrollbar-thumb-hover\)/)
  assert.match(css, /:root\[data-theme='ink'\]\s*\{\s*color-scheme:\s*dark/)
})

test('the kept frontend imports nothing from crew/ or scripts/', () => {
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!/\.(js|mjs|svelte)$/.test(name)) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('.')) continue
        const target = join(dir, match[1]).slice(ROOT.length + 1)
        if (/^(crew|scripts)\//.test(target)) found.push(`${path.slice(ROOT.length + 1)} -> ${match[1]}`)
      }
    }
  }
  walk(join(ROOT, 'visualizer/web/src'))
  assert.deepEqual(found, [])
})

// MUTATION: count shipped without the measured guard and a lean board reads "Shipped 0".
test('the Shipped tab shows no count when no run has a measured ship state', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/TaskList.svelte'), 'utf8')
  assert.match(source, /let shipMeasured = \$derived\(runs\.some\(\(run\) => shipStatus\(run\)\.key !== 'unmeasured'\)\)/)
  assert.match(source, /shipped: shipMeasured \? runs\.filter\([^\n]*\)\.length : null,/)
  assert.match(source, /\{counts\[tab\[0\]\] \?\? '—'\}/)
  assert.match(source, /title=\{counts\[tab\[0\]\] == null \? 'ship state not measured' : undefined\}/)
})
