import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PANEL_REFRESH_MS, PANEL_STALE_AFTER_MS, acceptRows, brakePanel, cellHealthPanel, fleetCost, fleetEscalationRate, fleetMedianDuration, fleetPassRate, fleetPhasesPerRun, fleetTokens, findingRows, gateChips, intakeCandidateRows, intakePanel, reviewRows, rosterEditForm, rosterPanel, panelAgeLabel, panelReadLoop, readFreshness, rosterProposal, runSetPanel, teardownPanel } from '../visualizer/web/src/lib/panels.js'
import { parseHash, formatHash } from '../visualizer/web/src/lib/route.js'
import { absenceMark, costCell, createSemaphore, deriveDisplayStatus, deriveStatus, escalationProbeTargets, fleetActivity, fleetView, gateCell, heartbeatCell, reviewCell, runActivity, tokenCell } from '../visualizer/web/src/lib/fleet.js'
import { ROLE_ORDER, acceptEvidence, bounceArrows, gateMarkers, gateProofStory, laneRows, phaseFilterId, phasePanel, renderMarkdown } from '../visualizer/web/src/lib/trace.js'
import { eventStory, eventStreamSummary } from '../visualizer/web/src/lib/event-story.js'
import { assignmentPath, envelopeFacts, envelopeGroups, envelopeOverview, envelopeSections, trajectoryRowStory, trajectorySummary } from '../visualizer/web/src/lib/diagnostic-story.js'
import { factoryStepCategory, factoryStepName, factoryStepTrace } from '../visualizer/web/src/lib/execution-steps.js'
import { assuranceMeta, assuranceOption, executionMeta, runConfiguration, taskProfileMeta } from '../visualizer/web/src/lib/workflow-semantics.js'

test('workflow semantics separate profile, execution and assurance without inference', () => {
  assert.deepEqual(assuranceOption('build'), { value:'build', label:'Standard · build' })
  assert.equal(assuranceMeta('mechanical').label, 'Quick')
  assert.equal(assuranceMeta('judge').label, 'Rigorous')
  assert.equal(executionMeta('scout').label, 'Scout')
  assert.equal(taskProfileMeta(null).label, 'Not recorded')
  assert.match(taskProfileMeta(null).summary, /does not infer/)
  assert.deepEqual(runConfiguration({ tier:'build', variant:'full' }), {
    profile: taskProfileMeta(null),
    execution: executionMeta('full'),
    assurance: assuranceMeta('build'),
  })
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

test('the metrics strip renders the sessions derivations and derives nothing', () => {
  const root = join(process.cwd(), 'visualizer/web/src')
  const strip = readFileSync(join(root, 'lib/MetricsStrip.svelte'), 'utf8')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  const taskList = readFileSync(join(root, 'lib/TaskList.svelte'), 'utf8')
  const importLine = strip.split('\n').find((line) => line.includes("from './panels.js'"))
  assert.ok(importLine)
  for (const name of ['fleetPassRate', 'fleetMedianDuration', 'fleetPhasesPerRun', 'fleetEscalationRate']) {
    assert.match(importLine, new RegExp(`\\b${name}\\b`))
  }
  assert.match(strip, /let \{ runs = \[\], envelopes = null, degraded = false, now = Date\.now\(\), onactivity = \(\) => \{\} \} = \$props\(\)/)
  for (const needle of ['Activity now', 'open', 'live', 'unverified', 'onactivity']) assert.match(strip, new RegExp(needle))
  for (const pattern of [/runs\.filter\(/, /runs\.reduce\(/, /runs\.map\(/, /\.sort\(/]) {
    assert.doesNotMatch(strip, pattern)
  }
  assert.match(app, /feedDegraded = result\?\.degraded === true/)
  const mounts = app.match(/<MetricsStrip[^>]*>/g) || []
  assert.equal(mounts.length, 2)
  for (const mount of mounts) {
    assert.match(mount, /envelopes=/)
    assert.match(mount, /degraded=/)
    assert.match(mount, /\{now\}/)
    assert.match(mount, /onactivity=/)
  }
  assert.match(app, /function focusActivity\(\)/)
  assert.match(app, /focus=\{taskFocus\}/)
  assert.match(taskList, /focus\?\.revision/)
  assert.match(taskList, /id="task-board"/)
})

test('the metrics strip probes task envelopes for successful sessions', () => {
  const app = readFileSync(join(process.cwd(), 'visualizer/web/src/App.svelte'), 'utf8')
  assert.equal(app.includes('escalationProbeTargets(nextRuns)'), false)
  assert.ok(app.includes(`for (const run of Array.isArray(nextRuns) ? nextRuns : []) {
      const id = run?.adw_id
      if (!run?.repo_slug || !(run?.goal ?? run?.task_slug) || id == null) continue`))
})

test('the metrics strip publishes task envelopes as probes finish across refreshes', () => {
  const app = readFileSync(join(process.cwd(), 'visualizer/web/src/App.svelte'), 'utf8')
  assert.match(app, /const envelopeCache = new Map\(\)/)
  assert.match(app, /envelopes = new Map\(envelopeCache\)/)
  assert.match(app, /envelopeQueued\.has\(id\)/)
  assert.doesNotMatch(app, /if \(generation === refreshGeneration\) envelopes = found/)
  assert.doesNotMatch(app, /envelopes = new Map\(\)/)
})

test('rosterPanel passes through a degraded reason without presenting an empty roster', () => {
  const result = rosterPanel({ tiers: null, models: null, path: '/tmp/roster.json', error: 'roster unreadable at /tmp/roster.json' })
  assert.deepEqual(result.tiers, [])
  assert.equal(result.pending, 'roster unreadable at /tmp/roster.json')
  assert.notEqual(result.pending, '')
})

test('rosterPanel keeps healthy seats and never derives money', () => {
  const result = rosterPanel({
    tiers: [{ tier: 'build', seats: [{ role: 'reviewer', effort: 'max', model: { cost_in_per_mtok: 2, cost_out_per_mtok: 12 } }], unseated: [] }],
    models: [{ key: 'openai/gpt-5.6-terra', cost_in_per_mtok: 2, cost_out_per_mtok: 12, last_verified: '2026-08-13' }],
  })
  assert.equal(result.pending, null)
  assert.equal(result.tiers[0].seats[0].effort, 'max')
  assert.doesNotMatch(JSON.stringify(result), /"(?:[a-z_]*(?:usd|spend|total_cost|cost_total)[a-z_]*)"/i)
})

test('rosterEditForm refuses a degraded payload instead of offering a blank form', () => {
  const result = rosterEditForm({ tiers: null, models: null, error: 'unable to read roster at /tmp/roster.json' }, { tier: 'build', role: 'reviewer' })
  assert.deepEqual(result.tiers, [])
  assert.deepEqual(result.roles, [])
  assert.equal(result.cell, null)
  assert.equal(result.pending, 'unable to read roster at /tmp/roster.json')
})

test('rosterEditForm derives options and seeds the selected seat', () => {
  const result = rosterEditForm({
    tiers: [
      { tier: 'build', seats: [{ role: 'reviewer', provider: 'openai', id: 'gpt-5', agent: 'pi', effort: 'max' }], unseated: ['tech-lead'] },
      { tier: 'judge', seats: [], unseated: ['lead'] },
    ],
  }, { tier: 'build', role: 'reviewer' })
  assert.deepEqual(result.tiers, ['build', 'judge'])
  assert.deepEqual(result.roles, ['reviewer', 'tech-lead'])
  assert.deepEqual(result.cell, { provider: 'openai', id: 'gpt-5', agent: 'pi', effort: 'max' })
  assert.equal(result.pending, null)
})

test('rosterProposal exposes refusals as pending and preserves a successful diff', () => {
  const refused = rosterProposal({ ok: false, diff: null, refusals: [{ code: 'cross_vendor', message: 'cross-vendor planner' }] })
  assert.equal(refused.diff, null)
  assert.equal(refused.refusals.length, 1)
  assert.ok(refused.pending)
  const success = rosterProposal({ ok: true, diff: '--- a/crew/roster.json', refusals: [] })
  assert.equal(success.diff, '--- a/crew/roster.json')
  assert.deepEqual(success.refusals, [])
  assert.equal(success.pending, null)
  for (const value of [rosterEditForm({ tiers: null, error: 'unavailable' }), rosterProposal({ ok: false, refusals: [] })]) {
    assert.doesNotMatch(JSON.stringify(value), /"(?:[a-z_]*(?:usd|spend|total_cost|cost_total)[a-z_]*)"/i)
  }
})

test('rosterPanel marks an uncatalogued seat instead of fabricating rates', () => {
  const result = rosterPanel({
    tiers: [{ tier: 'build', seats: [{ role: 'builder', model_key: 'openai/ghost-1', model: null }], unseated: [] }],
    models: [],
  })
  const seat = result.tiers[0].seats[0]
  assert.ok(seat)
  assert.equal(seat.model, null)
  assert.ok(seat.model_pending)
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

test('cellHealthPanel states the window and never invents one', () => {
  const result = cellHealthPanel({ window: { since: '2024-01-01T00:00:00.000Z', until: null, label: 'last 7 days' }, cells: [] })
  assert.match(result.window_label, /2024-01-01T00:00:00.000Z/)
  assert.equal(result.note, 'this window is the board’s own; the boot breaker (#45) owns cell policy and its own window')
  assert.equal(cellHealthPanel({ cells: [] }).window_label, 'window unavailable')
})

test('cellHealthPanel keeps silence, run-less and recorded visually distinct', () => {
  const result = cellHealthPanel({ cells: [
    { key: 'a', provider: 'a', model_id: 'a', agent: 'a', effort: 'a', roles: [], tiers: [], state: 'silent', failures: 0, run_less: 0, in_run: 0, by_kind: [] },
    { key: 'b', provider: 'b', model_id: 'b', agent: 'b', effort: 'b', roles: [], tiers: [], state: 'run-less-only', failures: 2, run_less: 2, in_run: 0, by_kind: [] },
    { key: 'c', provider: 'c', model_id: 'c', agent: 'c', effort: 'c', roles: [], tiers: [], state: 'recorded', failures: 2, run_less: 1, in_run: 1, by_kind: [] },
  ] })
  assert.equal(new Set(result.rows.map((row) => row.tone)).size, 3)
  assert.equal(new Set(result.rows.map((row) => row.label)).size, 3)
  assert.match(result.rows[0].label, /no failures recorded/)
  assert.doesNotMatch(result.rows[0].label, /^0\b/)
})

test('cellHealthPanel exposes the kind breakdown on the row', () => {
  const result = cellHealthPanel({ cells: [{ key: 'a', provider: 'anthropic', model_id: 'cell', agent: 'claude', effort: 'high', roles: ['planner'], tiers: ['build'], state: 'recorded', failures: 2, run_less: 1, in_run: 1, by_kind: [
    { kind: 'boot-refusal', failures: 1, run_less: 1 },
    { kind: 'timeout', failures: 1, run_less: 0 },
  ] }] })
  assert.deepEqual(result.rows[0].kinds.map((kind) => kind.label), ['boot-refusal ×1', 'timeout ×1'])
})

test('cellHealthPanel passes an absent reason through without rows', () => {
  const result = cellHealthPanel({ absent: 'cell_failures predates this ledger mirror', cells: [] })
  assert.equal(result.absent, 'cell_failures predates this ledger mirror')
  assert.deepEqual(result.rows, [])
  assert.doesNotMatch(JSON.stringify(result), /"(failures|run_less|in_run)":\s*0/)
})

test('runSetPanel renders an unmeasured window as unmeasured, never zero', () => {
  const result = runSetPanel({
    window: { since: '2024-01-01T00:00:00.000Z', until: null, label: 'last 24 hours' },
    runs: 1,
    settled: { running: 1, ok: 0, fail: 0, aborted: 0 },
    usage: null,
    coverage: { measured: 0, total: 1 },
    unmeasured: { parked: 'parks are unmeasured', usage: 'usage is unmeasured, not zero' },
    rows: [{ adw_id: 'p1', task_slug: 'pane', repo_slug: 'repo', status: 'running', usage_measured: false }],
  })
  assert.match(result.usage_label, /unmeasured/i)
  assert.doesNotMatch(result.usage_label, /0/)
  assert.notEqual(result.rows[0].usage_label, '0')
})

test('runSetPanel keeps an empty window distinct from an unmeasured one', () => {
  const empty = runSetPanel({ runs: 0, settled: { running: 0, ok: 0, fail: 0, aborted: 0 }, usage: null, coverage: { measured: 0, total: 0 }, unmeasured: { parked: 'parks are unmeasured' }, rows: [] })
  const unmeasured = runSetPanel({ runs: 1, settled: { running: 1, ok: 0, fail: 0, aborted: 0 }, usage: null, coverage: { measured: 0, total: 1 }, unmeasured: { parked: 'parks are unmeasured', usage: 'usage is unmeasured' }, rows: [{ adw_id: 'p1', usage_measured: false }] })
  assert.equal(empty.empty, true)
  assert.equal(unmeasured.empty, false)
  assert.notEqual(empty.usage_label, unmeasured.usage_label)
})

test('runSetPanel carries the parks marker and the coverage count', () => {
  const result = runSetPanel({
    runs: 2,
    settled: { running: 0, ok: 1, fail: 0, aborted: 1 },
    usage: { agent_sessions: 1, billed_input_tokens: 15, billed_output_tokens: null, billed_cache_write_tokens: null, billed_cache_read_tokens: null },
    coverage: { measured: 1, total: 2 },
    unmeasured: { parked: 'parks are unmeasured here' },
    rows: [],
  })
  assert.match(result.parked_note, /park/i)
  assert.match(result.coverage_label, /1.*2/)
})

test('runSetPanel passes an absent reason through without rows', () => {
  const result = runSetPanel({ absent: 'sessions predates this ledger mirror', rows: [] })
  assert.equal(result.absent, 'sessions predates this ledger mirror')
  assert.deepEqual(result.rows, [])
  assert.doesNotMatch(JSON.stringify(result), /"runs":\s*0/)
})

test('runSetPanel labels unmeasured rows and exposes the mean note', () => {
  const result = runSetPanel({
    runs: 2,
    usage: { agent_sessions: 2, billed_input_tokens: 100, billed_output_tokens: 20, billed_cache_write_tokens: 5, billed_cache_read_tokens: 5 },
    coverage: { measured: 1, total: 2 },
    usage_mean_tokens_per_measured_run: 130,
    unmeasured: { per_run: 'no agent_sessions rows for this run — unmeasured, not zero' },
    rows: [
      { adw_id: 'measured', usage_measured: true, billed_input_tokens: 100, billed_output_tokens: 20, billed_cache_write_tokens: 5, billed_cache_read_tokens: 5 },
      { adw_id: 'unmeasured', usage_measured: false },
    ],
  })
  const unmeasured = result.rows.find((row) => row.adw_id === 'unmeasured')
  const measured = result.rows.find((row) => row.adw_id === 'measured')
  assert.match(unmeasured.usage_label, /unmeasured.*not zero/i)
  assert.doesNotMatch(unmeasured.usage_label, /(^|\D)0(\D|$)/)
  assert.notEqual(unmeasured.usage_tone, measured.usage_tone)
  assert.ok(result.unmeasured_note)
  assert.ok(result.mean_label)
})

test('runSetPanel states an undeclared ceiling without a percentage', () => {
  const result = runSetPanel({ runs: 1, budget: { ceiling_tokens: null, pending: 'no ceiling declared' }, rows: [] })
  assert.ok(result.budget_pending)
  assert.doesNotMatch(result.budget_label, /%/)
  assert.doesNotMatch(result.budget_label, /\bof\b/i)
})

test('runSetPanel formats a declared ceiling and its provenance', () => {
  const result = runSetPanel({
    runs: 1,
    budget: { ceiling_tokens: 1000, burn_tokens: 130, headroom_tokens: 870, fraction: 0.13, comparable: true, provenance: 'the daemon holds its own ceiling in memory only' },
    rows: [],
  })
  assert.match(result.budget_label, /1,?000/)
  assert.match(result.budget_label, /870/)
  assert.match(result.budget_label, /13%/)
  assert.match(result.budget_note, /daemon/i)
})

test('cellHealthPanel distinguishes undetermined cards and carries model prices', () => {
  const result = cellHealthPanel({ cells: [
    { key: 'silent', provider: 'openai', model_id: 'quiet', state: 'silent', roles: [], tiers: [], failures: 0, run_less: 0, in_run: 0, by_kind: [], price: null, price_pending: 'not in the roster model catalog' },
    { key: 'unknown', provider: 'openai', model_id: 'unknown', state: 'undetermined', undetermined_why: 'cell readout absent', roles: [], tiers: [], failures: null, run_less: null, in_run: null, by_kind: [], price: null, price_pending: 'not in the roster model catalog' },
    { key: 'priced', provider: 'openai', model_id: 'gpt-5', state: 'silent', roles: [], tiers: [], failures: 0, run_less: 0, in_run: 0, by_kind: [], price: { cost_in_per_mtok: 2, cost_out_per_mtok: 12 }, price_pending: null },
  ] })
  const undetermined = result.rows.find((row) => row.state === 'undetermined')
  const priced = result.rows.find((row) => row.model_label === 'openai/gpt-5')
  assert.notEqual(undetermined.tone, 'silent')
  assert.match(undetermined.label, /health cannot be determined/i)
  assert.equal(priced.model_label, 'openai/gpt-5')
  assert.match(priced.price_label, /in \$2\/Mtok.*out \$12\/Mtok/)
  assert.doesNotMatch(JSON.stringify(result), /"(?:[a-z_]*(?:usd|spend|total_cost|cost_total)[a-z_]*)"/i)
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

test('intakePanel gives never-swept and swept-idle different headlines and tones', () => {
  const states = ['unmeasured', 'never-swept', 'not-swept-in-window', 'parked', 'picking', 'swept-idle']
  const panels = states.map((state) => intakePanel({ loop: { state, why: `why ${state}`, swept: null, picked: null, parked: null, none: null } }))
  assert.equal(new Set(panels.map((panel) => panel.headline)).size, states.length)
  assert.equal(new Set(panels.map((panel) => panel.tone)).size, states.length)
  assert.match(panels[1].headline, /loop has not run/i)
})

test('intakePanel lists all ten refusal reasons with the human-actionable group first', () => {
  const authoring = ['intake-block-missing', 'intake-block-malformed', 'brief-uncompilable', 'priority-unknown']
  const guardrail = ['stop-switch', 'window-cap', 'rate-limit-floor', 'protected-path', 'tier-judge']
  const ordering = ['not-first-in-order']
  const groups = [
    { group: 'authoring', title: 'an issue needs a human to author or fix it', asserts: 'a human editing the issue unblocks this', reasons: authoring.map((reason) => ({ reason, count: reason === authoring[0] ? 0 : 1 })) },
    { group: 'guardrail', title: 'the loop refused on purpose; lifting it is a human decision', asserts: 'nothing is broken', reasons: guardrail.map((reason) => ({ reason, count: 1 })) },
    { group: 'ordering', title: 'nothing is wrong; this candidate was simply not first', asserts: 'no action', reasons: ordering.map((reason) => ({ reason, count: 1 })) },
  ]
  const result = intakePanel({ refusals: { groups } })
  assert.match(result.groups[0].title, /human.*author|fix/i)
  assert.match(result.groups[0].asserts, /human/i)
  assert.deepEqual(result.groups.flatMap((group) => group.rows.map((row) => row.label)), [...authoring, ...guardrail, ...ordering])
  assert.equal(result.groups[0].rows[0].count_label, 'not refused in this window')
})

test('an absent payload renders as pending, not as an empty loop', () => {
  const result = intakePanel({
    absent: 'intake_sweeps predates this ledger mirror',
    loop: { state: 'unmeasured', swept: null, picked: null, parked: null, none: null },
    refusals: { groups: [{ group: 'authoring', reasons: [{ reason: 'intake-block-missing', count: null, state: 'unmeasured' }] }] },
  })
  assert.equal(result.absent, 'intake_sweeps predates this ledger mirror')
  assert.match(result.counts_label, /—/)
  assert.equal(result.groups[0].rows[0].count_label, '—')
  assert.doesNotMatch(JSON.stringify(result), /not refused in this window/)
})

test('intakePanel states its window and offers no write path', () => {
  const result = intakePanel({
    window: { since: '2024-01-01T00:00:00.000Z', until: null, label: 'last 24 hours' },
    loop: { state: 'picking', why: 'picking', swept: 1, picked: 1, parked: 0, none: 0 },
    picks: [{ issue: 52, board: { owner: 'owner', project: 1 }, at: '2024-01-01T01:00:00.000Z' }],
  })
  assert.match(result.window_label, /last 24 hours/)
  assert.match(result.window_label, /since 2024-01-01T00:00:00.000Z/)
  assert.match(result.window_label, /until now/)
  assert.equal(Object.keys(result).some((key) => /^(on|post|submit|mutate)/i.test(key)), false)
  assert.equal(result.readonly_note, 'this view reads the ledger; the intake module owns every decision shown here')
})

test('intakeCandidateRows labels verdicts and keeps take/refuse tones distinct', () => {
  const result = intakeCandidateRows({ candidates: {
    measured: true, absent: null, unmeasured: 'bound', items: [
      { issue: 7, board: { owner: 'owner', project: 1 }, verdict: 'would-refuse', reason: 'protected-path', reason_recognised: true, last_seen_at: '2024-01-01T00:00:00.000Z' },
      { issue: 9, board: { owner: 'owner', project: 1 }, verdict: 'would-take', reason: null, reason_recognised: false, last_seen_at: '2024-01-02T00:00:00.000Z' },
    ],
  } })
  assert.match(result.rows[0].label, /#7|owner/)
  assert.equal(result.rows[0].verdict_label, 'would refuse')
  assert.equal(result.rows[0].reason_label, 'protected-path')
  assert.equal(result.rows[1].verdict_label, 'would take')
  assert.notEqual(result.rows[0].tone, result.rows[1].tone)
  assert.match(result.rows[1].at_label, /2024-01-02/)
})

test('intakeCandidateRows renders an absent source without a zero candidate count', () => {
  const result = intakeCandidateRows({ candidates: { measured: false, absent: 'intake_refusals predates this ledger mirror', items: [], unmeasured: 'bound note' } })
  assert.equal(result.measured, false)
  assert.deepEqual(result.rows, [])
  assert.equal(result.absent, 'intake_refusals predates this ledger mirror')
  assert.match(result.note, /bound note/)
  assert.doesNotMatch(JSON.stringify(result), /0 candidates/i)
})

test('brakePanel keeps engaged, clear and unreadable states distinct', () => {
  const common = { checkout: '/checkout', path: '/checkout/.factory/STOP' }
  const engaged = brakePanel({ ...common, state: 'engaged', measured: true })
  const clear = brakePanel({ ...common, state: 'clear', measured: true })
  const unreadable = brakePanel({ ...common, state: null, measured: false, read_error: 'permission denied' })
  assert.match(engaged.label, /brake engaged/)
  assert.match(clear.label, /brake clear/)
  assert.match(unreadable.label, /unreadable/)
  assert.equal(unreadable.tone, 'unmeasured')
  assert.doesNotMatch(unreadable.label, /engaged|stopped/i)
  assert.equal(new Set([engaged.tone, clear.tone, unreadable.tone]).size, 3)
})

test('brakePanel preserves a failed transition while reporting the read state', () => {
  const result = brakePanel({ ok: false, error: 'ENOTDIR', state: 'clear', checkout: '/checkout', path: '/checkout/.factory/STOP' })
  assert.equal(result.state, 'clear')
  assert.match(result.label, /failed/i)
  assert.match(result.label, /clear/)
  assert.equal(result.tone, 'unmeasured')
})

test('brakePanel names the resolved checkout and switch path in every state', () => {
  const common = { checkout: '/tree-a', path: '/tree-a/.factory/STOP' }
  for (const payload of [
    { ...common, state: 'engaged', measured: true },
    { ...common, state: 'clear', measured: true },
    { ...common, state: null, measured: false, read_error: 'unreadable' },
    { ...common, ok: false, state: 'clear', error: 'failed' },
  ]) {
    const result = brakePanel(payload)
    assert.match(result.path_label, /\/tree-a/)
    assert.match(result.path_label, /STOP/)
  }
})

test('hash routes parse and format all five canonical views', () => {
  for (const hash of ['#/', '#/ops', '#/roster', '#/adw-123', '#/adw-123/plan']) {
    assert.equal(formatHash(parseHash(hash)), hash)
  }
  assert.deepEqual(parseHash(''), { view: 'fleet', adw_id: null, phase: null })
  assert.deepEqual(parseHash('#'), { view: 'fleet', adw_id: null, phase: null })
  assert.deepEqual(parseHash('#/adw-123/'), { view: 'run', adw_id: 'adw-123', phase: null })
  assert.deepEqual(parseHash('#/ops/ignored/extra'), { view: 'ops', adw_id: null, phase: null })
  assert.deepEqual(parseHash('#/adw-123/plan/ignored'), { view: 'phase', adw_id: 'adw-123', phase: 'plan' })
  assert.equal(parseHash('#/ops').adw_id, null)
  assert.equal(parseHash('#/roster').adw_id, null)
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
  const why = 'escalation evidence'
  const status = deriveStatus({ status: 'aborted' }, { status: 'escalation', details: { escalation: { where: 'gate', why } } })
  assert.equal(status.key, 'escalated')
  assert.equal(status.why, why)
  assert.equal(new Set(['proven', 'failed', 'unproven'].map((verdict) => gateCell({ gate_generations: [{ verdict }] }).text)).size, 3)
  assert.equal(reviewCell({ reviews: [{ verdict: 'changes-needed' }, { verdict: 'pass' }] }).bounces, 1)
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
  assert.deepEqual(fleetActivity([fresh, stale, unverified], now), { live: 1, silent: 1, unverified: 1, open: 3 })
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

  const root = join(process.cwd(), 'visualizer/web/src/lib')
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

test('role colour stays isolated to RoleTag and escalations render their why in the rail', () => {
  const root = join(process.cwd(), 'visualizer/web/src')
  for (const file of ['App.svelte', 'lib/FleetTable.svelte', 'lib/RunCard.svelte', 'lib/Filters.svelte']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /--role-|--lane-\d/)
  }
  const tag = readFileSync(join(root, 'lib/RoleTag.svelte'), 'utf8')
  assert.match(tag, /--role-|--lane-/)
  assert.match(tag, /\{\s*role\s*\}/)
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  assert.match(app, /row\.status\.key === 'escalated'[\s\S]*?class="rail-why">\{row\.why\}/)
  assert.match(app, /returnRequestSemaphore = createSemaphore\(6\)/)
  assert.match(app, /returnRequestSemaphore\.run\(\(\) => getReturns/)
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
  assert.deepEqual(assignmentPath(view).map((item) => [item.dispatch,item.role,item.outcome]), [['d1','planner','done'],['d2','builder','in flight']])
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
  const panel = phasePanel({ phases:[{ id:1, name:'planning' }] }, { phase:'planning', returns:{ envelopes:[
    { role:'planner', dispatch_seq:1, status:'done', summary:'BLOCKER: first return', artifacts:['task/plan.md'] },
    { role:'lead', dispatch_seq:3, status:'done', summary:'Escalate with context.', artifacts:['task/plan.md','returns/d3.json'] },
  ] } })
  assert.deepEqual(panel.artifacts.documents.map((document) => document.role), ['lead','planner'])
  assert.equal(panel.artifacts.paths.length, 2)
  assert.deepEqual(panel.artifacts.paths.find((artifact) => artifact.path === 'task/plan.md').sources, ['planner d1','lead d3'])
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhasePanel.svelte'), 'utf8')
  assert.match(source, /let documentOpen = \$state\(\{\}\)/)
  assert.match(source, /ontoggle=\{\(event\) => rememberDocument\(event, document\)\}/)
  assert.doesNotMatch(source, /open=\{index === 0\}/)
})

test('phase inspection explains factory checkpoints and suppresses empty gate counters', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhasePanel.svelte'), 'utf8')
  assert.match(source, /Task completion recorded/)
  assert.match(source, /No agent lane owned this checkpoint/)
  assert.match(source, /No gate ran on this checkpoint/)
  assert.match(source, /Validation evidence is attached to/)
  assert.match(source, /What this establishes/)
  assert.match(source, /How the gate was proved/)
  assert.match(source, /formatted from the ledger/)
  assert.doesNotMatch(source, /check\.label/)
  assert.doesNotMatch(source, /gate verdict unavailable/)
  assert.doesNotMatch(source, /unlinked.*lane/)
})

test('operations cadence keeps time labels below the chart baseline', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/OperationsOverview.svelte'), 'utf8')
  assert.match(source, /\.histogram::before[^}]*inset:0 0 1\.15rem[^}]*border-bottom/)
  assert.match(source, /\.bar-column[^}]*grid-template-rows:minmax\(0,1fr\) 1\.15rem/)
  assert.match(source, /\.bar-column > span[^}]*grid-row:2/)
  assert.match(source, /\.bar-stack[^}]*grid-row:1/)
})

test('trace source tripwires keep route, role order, and server read-only', () => {
  const root = join(process.cwd(), 'visualizer')
  const shape = readFileSync(join(root, 'server/shape.mjs'), 'utf8')
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
  assert.ok(shape.includes("Object.freeze(['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver'])"))
  for (const file of ['visualizer/server/shape.mjs', 'visualizer/server/ledger-feed.mjs']) {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    assert.equal(/INSERT INTO|UPDATE \\w+ SET|DELETE FROM/i.test(source), false)
  }
})

test('PhaseGantt resolves identity by lane key rather than timeline row position', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.ok(source.includes('identityFor(lane)'))
  assert.equal(source.includes('identities.lanes[laneIndex]'), false)
})

test('PhaseGantt renders every gate marker attached to a block', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
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
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.match(source, /class="bounce-layer"/)
  assert.ok(source.includes('connectorPath(from, to)'))
  assert.ok(source.includes('connectorLabel(from, to, arrow)'))
})

test('PhaseGantt offsets bounce SVG to the geometry track column', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.ok(source.includes('--identity-column:15rem'))
  assert.ok(source.includes('--lane-gap:.6rem'))
  assert.ok(source.includes('left:calc(var(--identity-column) + var(--lane-gap))'))
  assert.ok(source.includes('right:0'))
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
    trace.steps[1].handoffs.map((handoff) => [Number(handoff.x.toFixed(2)), Number(handoff.width.toFixed(2))]),
    [],
  )
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
  const detail = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  const trajectory = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/Trajectory.svelte'), 'utf8')
  const waterfall = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  assert.match(detail, /<PhaseGantt[^>]*\{journalState\}/)
  assert.match(detail, /<Trajectory[^>]*\{journalState\}/)
  assert.equal(trajectory.includes("fetch(`/api/journal"), false)
  assert.match(waterfall, /Factory internals/)
  assert.match(waterfall, /validation and control checkpoints/)
})

test('factory checkpoint inspection stays local and highlights the related waterfall phase', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhaseGantt.svelte'), 'utf8')
  const inspect = source.match(/function inspectStep\(step\) \{([^}]*)\}/)?.[1] || ''
  assert.equal(inspect.includes('onselectphase'), false)
  assert.match(source, /class:step-linked=\{sameId\(block\.phase_id, linkedPhase\)\}/)
  assert.match(source, /class:selected=\{linkedPhase == null && selected === block\.name\}/)
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
  assert.match(source, /border-top:2px dashed var\(--agent-color\)/)
  assert.match(source, /class="round-row"/)
  assert.match(source, /class:has-rounds=/)
  assert.match(source, /class:last-round=/)
  assert.match(source, /class:missing-return=/)
  assert.match(source, /selectedDetail\.state\.label/)
  assert.match(source, /How to read this trace/)
  assert.match(source, /Dashed seat · solid round/)
  assert.match(source, /Gate proof/)
  assert.match(source, /handoffTooltip\(handoff\)/)
  assert.match(source, /stepTooltip\(step\)/)
  assert.doesNotMatch(source, /<em>Factory step<\/em>/)
})

test('task detail refreshes do not reset finished-run disclosures for an unchanged task id', () => {
  const detail = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/RunDetail.svelte'), 'utf8')
  const trajectory = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/Trajectory.svelte'), 'utf8')
  assert.match(detail, /target\.adw_id === detailKey/)
  assert.match(detail, /key === journalKey/)
  assert.ok(detail.indexOf('key === journalKey') < detail.indexOf('journalState = initialJournalState()'))
  assert.match(detail, /if \(!shouldRead\(\{ running:run\.running \}\)\) return/)
  assert.match(trajectory, /id === trajectoryRunKey/)
})

test('PhasePanel shows pending gate retries alongside valid checks', () => {
  const source = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/PhasePanel.svelte'), 'utf8')
  assert.ok(source.includes('{#if panel.gate.checks_pending}'))
  assert.ok(source.includes('class="checks-pending muted"'))
  assert.equal(source.includes('{:else if panel.gate.checks_pending}'), false)
})

const PANEL_SHAPERS = { 'CellHealthPanel.svelte': cellHealthPanel, 'TeardownPanel.svelte': teardownPanel, 'RunSetPanel.svelte': runSetPanel }
const READ_AT = 1700000000000

test('the three panels date their reading and hedge only when it is old', () => {
  assert.equal(PANEL_REFRESH_MS, 3000)
  for (const [file, shape] of Object.entries(PANEL_SHAPERS)) {
    const fresh = shape({}, { read_at: READ_AT, now: READ_AT + 2000, refresh_ms: PANEL_REFRESH_MS }).freshness
    assert.equal(fresh.age_ms, 2000, file)
    assert.equal(fresh.stale, false, file)
    assert.equal(fresh.label, 'read 2s ago', file)
    assert.doesNotMatch(fresh.label, /stale|may no longer|unavailable|cannot be dated/i, file)
    assert.equal(fresh.refresh_label, 're-reads every 3s', file)
    const old = shape({}, { read_at: READ_AT, now: READ_AT + 6600000, refresh_ms: PANEL_REFRESH_MS }).freshness
    assert.equal(old.stale, true, file)
    assert.match(old.label, /^read 1h50m ago — /, file)
    assert.match(old.label, /may no longer be true/, file)
  }
  const absentRunSet = runSetPanel({ absent: 'sessions predates this ledger mirror' }, { read_at: READ_AT, now: READ_AT + 2000, refresh_ms: PANEL_REFRESH_MS })
  assert.equal(absentRunSet.freshness.label, 'read 2s ago')
})

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

// MUTATION: this pin dies if any of the three panels stops passing its own read
// clock to the shaper, stops rendering the dated readout, or stops clearing its
// interval when the panel is gone. It reads comment-stripped source, so a comment
// shaped like the wiring cannot satisfy it — a tripwire a deleted implementation
// still passes is worse than no tripwire.
test('each panel wires its own read clock and tears its timer down', () => {
  const root = join(process.cwd(), 'visualizer/web/src/lib')
  for (const [file, shape] of Object.entries(PANEL_SHAPERS)) {
    const source = readFileSync(join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.ok(source.includes(`import { PANEL_REFRESH_MS, ${shape.name}, panelReadLoop } from './panels.js'`), file)
    assert.ok(source.includes(`$derived(${shape.name}(`), file)
    assert.ok(source.includes('{ read_at, now, refresh_ms: PANEL_REFRESH_MS })'), file)
    assert.equal((source.match(/read_at = Date\.now\(\)/g) || []).length, 1, file)
    assert.ok(source.includes('const stop = panelReadLoop('), file)
    assert.ok(source.includes('return () => { active = false; stop() }'), file)
    assert.doesNotMatch(source, /\bsetInterval\s*\(/, file)
    assert.ok(source.includes('{panel.freshness.label}'), file)
    assert.ok(source.includes('{panel.freshness.refresh_label}'), file)
  }
})
