import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acceptRows, cellHealthPanel, fleetCost, fleetTokens, findingRows, gateChips, intakePanel, reviewRows, rosterEditForm, rosterPanel, rosterProposal, runSetPanel } from '../visualizer/web/src/lib/panels.js'
import { parseHash, formatHash } from '../visualizer/web/src/lib/route.js'
import { absenceMark, costCell, createSemaphore, deriveStatus, escalationProbeTargets, fleetView, gateCell, heartbeatCell, reviewCell, tokenCell } from '../visualizer/web/src/lib/fleet.js'

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
})

test('fleetCost never derives money from token totals', () => {
  const result = fleetCost([{ metrics: { billed_input_tokens: 999999999 } }])
  assert.equal(result.usd, null)
  assert.ok(result.pending)
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
  assert.equal(costCell({ transport: 'pane' }).text, 'not measured · pane')
  assert.equal(heartbeatCell({ last_heartbeat_at: new Date(now - 4000).toISOString() }, now).text, '4s ago')
  assert.equal(heartbeatCell({ last_heartbeat_at: new Date(now - 91000).toISOString() }, now).text, 'silent 91s')
  assert.equal(heartbeatCell({ pending: { last_heartbeat_at: 'not measured' } }, now).dashed, true)
  assert.equal(deriveStatus({ status: 'aborted' }, null).key, 'fail')
  const why = 'escalation evidence'
  const status = deriveStatus({ status: 'aborted' }, { status: 'escalation', details: { escalation: { where: 'gate', why } } })
  assert.equal(status.key, 'escalated')
  assert.equal(status.why, why)
  assert.equal(new Set(['proven', 'failed', 'unproven'].map((verdict) => gateCell({ gate_generations: [{ verdict }] }).text)).size, 3)
  assert.equal(reviewCell({ reviews: [{ verdict: 'changes-needed' }, { verdict: 'pass' }] }).bounces, 1)
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
