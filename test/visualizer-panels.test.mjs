import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptRows, cellHealthPanel, fleetCost, fleetTokens, findingRows, gateChips, reviewRows, rosterEditForm, rosterPanel, rosterProposal } from '../visualizer/web/src/lib/panels.js'

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
