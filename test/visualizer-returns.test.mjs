import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createReturnsSource } from '../visualizer/server/returns-source.mjs'
import { scratchDir, treeDigest } from './helpers.mjs'

test('returns source resolves archives, attempts, malformed envelopes, and never writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'visualizer-returns-'))
  try {
    const dir = join(root, 'repo', 'task.archive-2026-01-01T00-00-00-000Z')
    const returns = join(dir, 'returns')
    mkdirSync(join(dir, 'ledger'), { recursive: true }); mkdirSync(returns)
    writeFileSync(join(dir, 'ledger', 'run.json'), JSON.stringify({ adw_id: 'run-1' }))
    const envelope = (id, role) => JSON.stringify({ assignment_id: id, role, status: 'done', summary: id, artifacts: [], details: {} })
    writeFileSync(join(returns, 'd1.planner.json'), envelope('d1', 'planner'))
    writeFileSync(join(returns, 'd2.builder.json'), envelope('d2', 'builder'))
    writeFileSync(join(returns, 'd4.builder.json'), envelope('d4', 'builder'))
    writeFileSync(join(returns, 'd3.reviewer.json'), '{bad')
    writeFileSync(join(returns, 'task.json'), JSON.stringify({ status: 'done' }))
    writeFileSync(join(returns, 'r1.task.json'), envelope('r1', 'task'))
    writeFileSync(join(returns, 'r2.task.a2.json'), envelope('r2', 'task'))
    const mismatched = join(root, 'repo', 'task.archive-2026-01-01T00-00-00-001Z')
    mkdirSync(join(mismatched, 'ledger'), { recursive: true }); mkdirSync(join(mismatched, 'returns'))
    writeFileSync(join(mismatched, 'ledger', 'run.json'), JSON.stringify({ adw_id: 'different-run' }))
    writeFileSync(join(mismatched, 'returns', 'd9.builder.json'), envelope('d9', 'builder'))
    const before = treeDigest(root)
    const result = createReturnsSource({ crewRoot: root }).listEnvelopes({ repo_slug: 'repo', task_slug: 'task', adw_id: 'run-1' })
    assert.equal(result.verified, true)
    assert.equal(result.dir, dir)
    // #718: a non-matching ledger/run.json is not an absence. The newest
    // candidate is returned unverified, exactly as a candidate with no
    // run.json is (below), and an omitted adw_id ('' from server.mjs:339) is
    // answered the same way rather than with a false denial.
    const rejected = createReturnsSource({ crewRoot: root }).listEnvelopes({ repo_slug: 'repo', task_slug: 'task', adw_id: 'missing-run' })
    assert.equal(rejected.dir, mismatched)
    assert.equal(rejected.verified, false)
    assert.equal(rejected.envelopes.length, 1)
    assert.equal(rejected.error, undefined)
    const anyRun = createReturnsSource({ crewRoot: root }).listEnvelopes({ repo_slug: 'repo', task_slug: 'task', adw_id: '' })
    assert.equal(anyRun.dir, mismatched)
    assert.equal(anyRun.verified, false)
    assert.deepEqual(result.envelopes.map((entry) => entry.assignment_id), ['d1', 'd2', 'd3', 'd4'])
    assert.equal(result.envelopes.some((entry) => entry.assignment_id === 'r1' || entry.assignment_id === 'r2'), false)
    assert.equal(result.envelopes.find((entry) => entry.assignment_id === 'd3').valid, false)
    assert.deepEqual(result.envelopes.filter((entry) => entry.role === 'builder').map((entry) => entry.attempt), [1, 2])
    assert.equal(result.task.status, 'done')
    for (const repo_slug of ['../', '/etc', '']) {
      const invalid = createReturnsSource({ crewRoot: root }).listEnvelopes({ repo_slug, task_slug: 'task', adw_id: 'run-1' })
      assert.equal(invalid.error, 'invalid repo_slug or task_slug'); assert.deepEqual(invalid.envelopes, [])
    }
    assert.equal(treeDigest(root), before)

    const conventionRoot = join(root, 'convention'), conventionDir = join(conventionRoot, 'repo', 'task.archive-2026-01-01T00-00-00-002Z')
    mkdirSync(join(conventionDir, 'returns'), { recursive: true })
    writeFileSync(join(conventionDir, 'returns', 'd1.planner.json'), envelope('d1', 'planner'))
    const convention = createReturnsSource({ crewRoot: conventionRoot }).listEnvelopes({ repo_slug: 'repo', task_slug: 'task', adw_id: 'legacy-run' })
    assert.equal(convention.verified, false)
    assert.equal(convention.envelopes.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('returns source serves the latest run-start scoped directory with re-ask envelopes first', () => {
  // Mutation killed: returnsDir = join(flatReturnsDir, latestRunId) -> returnsDir = flatReturnsDir (VF1),
  // and reaskMatch -> null (VF3); either keeps the scoped d1 pair out of the listing.
  const root = scratchDir('visualizer-returns-scoped-')
  const dir = join(root, 'repo', 'task')
  const envelope = (id, role, status) => JSON.stringify({ assignment_id: id, role, status, summary: id, artifacts: [], details: {} })
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(join(dir, 'ledger', 'run.json'), JSON.stringify({ adw_id: 'run-1' }))
  writeFileSync(join(dir, 'journal.jsonl'), [
    JSON.stringify({ event: 'run-start', run_id: 'oldRun1' }),
    JSON.stringify({ event: 'other' }),
    '{torn',
    JSON.stringify({ event: 'run-start', run_id: 'run-x' }),
  ].join('\n') + '\n')
  mkdirSync(join(dir, 'returns'), { recursive: true })
  writeFileSync(join(dir, 'returns', 'd9.builder.json'), envelope('d9', 'builder', 'done'))
  mkdirSync(join(dir, 'returns', 'oldRun1'), { recursive: true })
  writeFileSync(join(dir, 'returns', 'oldRun1', 'd8.builder.json'), envelope('d8', 'builder', 'done'))
  mkdirSync(join(dir, 'returns', 'run-x'), { recursive: true })
  writeFileSync(join(dir, 'returns', 'run-x', 'd1.planner.json'), envelope('d1', 'planner', 'done'))
  writeFileSync(join(dir, 'returns', 'run-x', 'd1.coverage-reask.planner.json'), envelope('d1', 'planner', 'blocked'))
  writeFileSync(join(dir, 'returns', 'run-x', 'task.json'), JSON.stringify({ status: 'scoped-task' }))
  const result = createReturnsSource({ crewRoot: root }).listEnvelopes({ repo_slug: 'repo', task_slug: 'task', adw_id: 'run-1' })
  assert.deepEqual(result.envelopes.map((entry) => [entry.dispatch_seq, entry.role, entry.coverage_reask, entry.status]), [[1, 'planner', null, 'done'], [1, 'planner', 'coverage-reask', 'blocked']])
  assert.equal(result.task?.status, 'scoped-task')
})

test('returns source reads the flat directory without a run-start journal row', () => {
  // Mutation killed: the VF2 adoption line falling back to flat when a run is named;
  // these journals name no run, so flat is the measured answer in both cases.
  for (const journal of [null, JSON.stringify({ event: 'assign', assign: 'd1' }) + '\n']) {
    const root = scratchDir('visualizer-returns-flat-')
    const dir = join(root, 'repo', 'task')
    mkdirSync(join(dir, 'ledger'), { recursive: true })
    writeFileSync(join(dir, 'ledger', 'run.json'), JSON.stringify({ adw_id: 'run-1' }))
    if (journal !== null) writeFileSync(join(dir, 'journal.jsonl'), journal)
    mkdirSync(join(dir, 'returns'), { recursive: true })
    writeFileSync(join(dir, 'returns', 'd3.reviewer.json'), JSON.stringify({ assignment_id: 'd3', role: 'reviewer', status: 'done', summary: 'd3', artifacts: [], details: {} }))
    const result = createReturnsSource({ crewRoot: root }).listEnvelopes({ repo_slug: 'repo', task_slug: 'task', adw_id: 'run-1' })
    assert.deepEqual(result.envelopes.map((entry) => [entry.assignment_id, entry.status]), [['d3', 'done']])
  }
})

test('returns source serves zero envelopes when the named run directory is absent', () => {
  // Mutation killed: the VF2 adoption line falling back to the stale flat d9 envelope.
  const root = scratchDir('visualizer-returns-missing-')
  const dir = join(root, 'repo', 'task')
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(join(dir, 'ledger', 'run.json'), JSON.stringify({ adw_id: 'run-1' }))
  writeFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ event: 'run-start', run_id: 'run-y' }) + '\n')
  mkdirSync(join(dir, 'returns'), { recursive: true })
  writeFileSync(join(dir, 'returns', 'd9.builder.json'), JSON.stringify({ assignment_id: 'd9', role: 'builder', status: 'done', summary: 'd9', artifacts: [], details: {} }))
  const result = createReturnsSource({ crewRoot: root }).listEnvelopes({ repo_slug: 'repo', task_slug: 'task', adw_id: 'run-1' })
  assert.deepEqual(result.envelopes.map((entry) => entry.assignment_id), [])
  assert.equal(result.task, null)
})
