import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRunner, mockAgent, waves } from './helpers.mjs'

const run = makeRunner()

test('linear chain runs in dependency order, all pass', async () => {
  const { out, logs } = await run(
    { goal: 'g', tasks: [
      { id: 't0', domain: 'backend', brief: 'a' },
      { id: 't1', domain: 'backend', brief: 'b', depends_on: ['t0'] },
      { id: 't2', domain: 'backend', brief: 'c', depends_on: ['t1'] },
    ] }, mockAgent())
  assert.deepEqual(waves(logs), [['t0'], ['t1'], ['t2']])
  assert.equal(out.total, 3)
  assert.equal(out.passed, 3)
})

test('diamond runs the two middle tasks in one wave', async () => {
  const { logs } = await run(
    { goal: 'g', tasks: [
      { id: 't0', domain: 'backend', brief: 'base' },
      { id: 't1', domain: 'backend', brief: 'left', depends_on: ['t0'] },
      { id: 't2', domain: 'frontend', brief: 'right', depends_on: ['t0'] },
      { id: 't3', domain: 'backend', brief: 'join', depends_on: ['t1', 't2'] },
    ] }, mockAgent())
  const w = waves(logs)
  assert.deepEqual(w[0], ['t0'])
  assert.deepEqual(new Set(w[1]), new Set(['t1', 't2']))
  assert.deepEqual(w[2], ['t3'])
})

test('dependent is skipped when its prerequisite fails the gate', async () => {
  const { out } = await run(
    { goal: 'g', tasks: [
      { id: 't0', domain: 'backend', brief: 'a' },
      { id: 't1', domain: 'backend', brief: 'b', depends_on: ['t0'] },
    ] },
    mockAgent({ gatePass: (o) => !o.label.endsWith('t0') })) // t0's gate fails
  const t0 = out.results.find((r) => r.id === 't0')
  const t1 = out.results.find((r) => r.id === 't1')
  assert.equal(t0.pass, false)
  assert.equal(t1.status, 'skipped')
  assert.match(t1.findings.join(' '), /did not pass the gate/)
})

test('unknown dependency → task skipped with a clear reason', async () => {
  const { out } = await run(
    { goal: 'g', tasks: [{ id: 't0', domain: 'backend', brief: 'x', depends_on: ['ghost'] }] },
    mockAgent())
  assert.equal(out.results[0].status, 'skipped')
  assert.match(out.results[0].findings.join(' '), /unknown dependency 'ghost'/)
})

test('dependency cycle → all skipped, no waves run', async () => {
  const { out, logs } = await run(
    { goal: 'g', tasks: [
      { id: 'a', domain: 'backend', brief: 'x', depends_on: ['b'] },
      { id: 'b', domain: 'backend', brief: 'y', depends_on: ['a'] },
    ] }, mockAgent())
  assert.equal(waves(logs).length, 0)
  assert.equal(out.passed, 0)
  for (const r of out.results) assert.match(r.findings.join(' '), /cycle|unresolvable/)
})

test('unroutable domain is rejected, not laundered into a fallback lead', async () => {
  const { out } = await run(
    { goal: 'g', tasks: [
      { id: 'ok', domain: 'backend', brief: 'x' },
      { id: 'bad', domain: 'mobile', brief: 'y' },
    ] }, mockAgent())
  assert.equal(out.routable, 1)
  assert.equal(out.rejected, 1)
  assert.equal(out.rejectedTasks[0].id, 'bad')
  assert.equal(out.rejectedTasks[0].domain, 'mobile')
})

test('qa tasks are executed by test-engineer, not the coder', async () => {
  const calls = []
  await run({ goal: 'g', tasks: [{ id: 'q', domain: 'qa', brief: 'tests' }] }, mockAgent({ calls }))
  const build = calls.find((c) => c.kind === 'build')
  assert.equal(build.agentType, 'dev-team:test-engineer')
})

test('args delivered as a JSON string is parsed, not treated as empty', async () => {
  const argStr = JSON.stringify({ goal: 'str', tasks: [{ id: 'be-01', domain: 'backend', brief: 'x' }] })
  const { out } = await run(argStr, mockAgent())
  assert.equal(out.goal, 'str')
  assert.equal(out.total, 1)
  assert.equal(out.passed, 1)
})

test('deep triggers and the devops domain escalate the review tier', async () => {
  const deepByKeyword = await run(
    { goal: 'g', tasks: [{ id: 'be-01', domain: 'backend', brief: 'x' }] },
    mockAgent({ specFor: () => ({ acceptance_criteria: ['run the DB migration cleanly'] }) }))
  assert.equal(deepByKeyword.out.results[0].review_tier, 'deep')

  const standard = await run(
    { goal: 'g', tasks: [{ id: 'be-02', domain: 'backend', brief: 'x' }] }, mockAgent())
  assert.equal(standard.out.results[0].review_tier, 'standard')

  const devops = await run(
    { goal: 'g', tasks: [{ id: 'ops-01', domain: 'devops', brief: 'x' }] }, mockAgent())
  assert.equal(devops.out.results[0].review_tier, 'deep')
})

test('build-validator is advisory: a dead run does not block; a reported failure does', async () => {
  const died = await run(
    { goal: 'g', tasks: [{ id: 'be-01', domain: 'backend', brief: 'x' }] },
    mockAgent({ buildNull: () => true }))
  assert.equal(died.out.results[0].pass, true)
  assert.match(died.out.results[0].findings.join(' '), /advisory|not blocking/)

  const broke = await run(
    { goal: 'g', tasks: [{ id: 'be-02', domain: 'backend', brief: 'x' }] },
    mockAgent({ buildPass: () => false }))
  assert.equal(broke.out.results[0].pass, false)
  assert.match(broke.out.results[0].findings.join(' '), /build failed/)
})

test('empty / missing tasks is a clean no-op', async () => {
  const { out } = await run({ goal: 'g', tasks: [] }, mockAgent())
  assert.equal(out.total, 0)
  assert.equal(out.passed, 0)
  assert.deepEqual(out.results, [])
})
