import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PANEL_REFRESH_MS, PANEL_STALE_AFTER_MS, acceptRows, fleetCost, fleetEscalationRate, fleetMedianDuration, fleetPassRate, fleetPhasesPerRun, fleetTokens, findingRows, gateChips, panelAgeLabel, panelReadLoop, readFreshness, reviewRows } from '../visualizer/web/src/lib/panels.js'
import { VIEWS, parseHash, formatHash } from '../visualizer/web/src/lib/route.js'
import { ATTENTION_KEYS, absenceMark, attentionBreakdown, configurationDimensionCell, configurationFilterView, costCell, createSemaphore, crewArchive, deriveDisplayStatus, deriveStatus, escalationProbeTargets, fleetActivity, fleetView, gateCell, heartbeatCell, needsAttention, openRecordNote, operationsOverview, profileEvidenceView, reviewCell, runActivity, runDetailConfiguration, runDetailSeats, runDetailState, runtimeActivitySummary, slotWaitCell, tokenCell, shipStatus } from '../visualizer/web/src/lib/fleet.js'
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
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  assert.doesNotMatch(app, /--role-|--lane-\d/)
  assert.match(app, /\.filter\(\(row\) => needsAttention\(row\.status\.key\)/)
  const tasks = readFileSync(join(root, 'lib/TaskList.svelte'), 'utf8')
  assert.match(tasks, /Why review\?/)
  assert.match(tasks, /status\.why/)
  assert.doesNotMatch(app, /class="attention-list"/)
  assert.doesNotMatch(app, /getReturns|probeEnvelopes|returnRequestSemaphore/)
})

// RV3-1: a residual recorded as a bare string carries its text in the item
// itself, not in a .why property. Reading only object properties emptied it,
// and the finding-id join then dropped it outright — recorded evidence lost.
// RV3-1b: a foreign id is still dropped. The fix above must not turn the join
// off — only items that cannot be matched at all are exempt from it.
// RV3-2: a recorded nonzero cosmetic count with no evidence items must explain
// itself, not render an unexplained empty area.
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

test('RV1-1 profile evidence references keep dispatch, field and role', () => {
  const view = profileEvidenceView('code_review', { envelopes:[{
    dispatch_seq:4,
    role:'reviewer',
    details:{ findings:[
      { id:'f1', severity:'must-fix', evidence:'a.js:1' },
      { id:'f2', severity:'should-fix', evidence:'b.js:2' },
    ] },
  }] })
  const references = view.blocks.find((block) => block.key === 'structured_findings').references
  assert.deepEqual(references.map((reference) => `${reference.dispatch_seq}-${reference.field}-${reference.role}`), ['4-findings-reviewer', '4-findings-reviewer'])})

test('fleet profile evidence names each evidence kind', () => {
  const fleetSource = readFileSync(join(ROOT, 'visualizer/web/src/lib/fleet.js'), 'utf8')
  for (const label of ['Review findings', 'Verification checks', 'Bug reproduction', 'Test discrimination']) assert.match(fleetSource, new RegExp(label))
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

import { readFileSync as readSource } from 'node:fs'

// MUTATION RV1-4b: drop the journal-unavailable branch of escalation_reason — an unreadable
// journal then reports no-escalation-recorded, a measured absence nobody measured.
// MUTATION RV2-1: read regressions only from the step's own gate row — a later step's red gate
// that regresses C1 then leaves step a green with C1 passed.
// MUTATION RV3-1: keep any later regression sticky — b's passing retry then leaves a red forever.
// MUTATION RV2-2: let latestOpen fall back to any earlier unterminated start — step a, whose
// terminal row is missing, is revived as active after step b finishes.
// MUTATION RV2-3: drop the reversed-window check from turnsReason — a round ending before it
// started then claims no builder census instead of invalid timestamps.
// Mutation killed: restoring the journal span's status when its envelope has no status.
// Mutation killed: deriving handoffs from the focused view without the run-wide span list.
// Mutation killed: retaining the previous run's returns when the detail identity changes.
// MUTATION EL2: blank the ' (estimated)' suffix in price_label and the estimated row reads as measured.
const reasonCopyProbes = await import('../visualizer/web/src/lib/reason-copy.js').catch(() => null)
const fleetProbes = await import('../visualizer/web/src/lib/fleet.js').catch(() => null)
const journalSourceProbes = await import('../visualizer/server/journal-source.mjs').catch(() => null)
test('EV1 profile evidence separates measured cards from quiet footer', () => {
  const view = profileEvidenceView('code_review', { envelopes: [] })
  assert.deepEqual(view.cards, [])
  assert.deepEqual(view.footer.map((e) => e.key), ['base_head_identity', 'structured_findings', 'severity', 'citations', 'zero_source_writes'])
  for (const entry of view.footer) {
    assert.ok(Object.hasOwn(reasonCopyProbes.REASON_COPY, entry.reason))
    assert.equal(entry.text, reasonCopyProbes.reasonText(entry.reason))
  }
})
// MUTATION RV1-1: restore the file-path key and duplicate recorded paths collide.
// MUTATION RV1-2: drop the missing-step title and its translated reason loses provenance.
const sameDispatchReturns = [
  { file: '/crew/returns/run-x/d1.planner.json', assignment_id: 'd1', dispatch_seq: 1, role: 'planner', coverage_reask: null, status: 'done', valid: true, summary: 'Plan narrative' },
  { file: '/crew/returns/run-x/d1.coverage-reask.planner.json', assignment_id: 'd1', dispatch_seq: 1, role: 'planner', coverage_reask: 'coverage-reask', status: 'insufficient', valid: true, summary: 'Coverage narrative' },
]

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
  for (const [index, role] of ['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver'].entries()) {
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
