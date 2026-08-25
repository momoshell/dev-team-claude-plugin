import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '../visualizer/server/server.mjs'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import { buildTrajectory, focusTrajectory, projectSpan, spansActiveIn, toMs } from '../visualizer/web/src/lib/spans.js'
import { JOURNAL_CHANNELS } from '../crew/drive.mjs'
import { scratchDir, treeDigest } from './helpers.mjs'

const DURATION_KEY = /dur|elaps|_ms$|secs|seconds/i
const LEDGER_SANDBOX = scratchDir('visualizer-trajectory-ledger-', { parent: tmpdir() })
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX

function lane(root, { repo = 'repo', task = 'task', adw_id = 'run-1', journal = null } = {}) {
  const dir = join(root, repo, task)
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(join(dir, 'ledger', 'run.json'), JSON.stringify({ adw_id, repo_slug: repo, task_slug: task }))
  if (journal !== null) writeFileSync(join(dir, 'journal.jsonl'), journal)
  return { dir, journal: join(dir, 'journal.jsonl') }
}

function lines(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
}

function spanRows() {
  return [
    { at: 0, assign: 'turn-1', role: 'planner' },
    { at: 1000, envelope: 'turn-1', role: 'planner', status: 'done' },
    { at: 200, stage: 'open-stage' },
    { at: 700, stage: 'later-stage' },
    { at: 800, stage_done: 'later-stage' },
  ]
}

test('trajectory keeps open spans honest and measures closed siblings', () => {
  const result = buildTrajectory([
    { at: 0, stage: 'closed-stage' },
    { at: 100, stage_done: 'closed-stage' },
    { at: 200, stage: 'open-stage' },
    { at: 300, assign: 'closed-turn', role: 'planner' },
    { at: 350, envelope: 'closed-turn', role: 'planner', status: 'done' },
    { at: 400, assign: 'open-turn', role: 'builder' },
  ])
  const closed = result.spans.find((span) => span.label === 'closed-stage')
  assert.equal(closed.duration_ms, 100)
  const open = result.spans.filter((span) => span.ended_at === null)
  assert.deepEqual(open.map((span) => span.label), ['open-stage', 'open-turn:builder'])
  for (const span of open) {
    assert.equal('duration_ms' in span, false)
    assert.deepEqual(Object.keys(span).filter((key) => DURATION_KEY.test(key)), [])
  }
  const closedAssignment = result.spans.find((span) => span.label === 'closed-turn:planner')
  assert.equal(closedAssignment.duration_ms, 50)
})

test('trajectory nests stages by their innermost parent', () => {
  const result = buildTrajectory([
    { at: 0, stage: 'gate:r1' },
    { at: 10, stage: 'gate-proof:1' },
    { at: 20, stage: 'gate-proof:1:checks' },
    { at: 30, stage_done: 'gate-proof:1:checks' },
    { at: 40, stage_done: 'gate-proof:1' },
    { at: 50, stage_done: 'gate:r1' },
  ])
  const outer = result.spans.find((span) => span.label === 'gate:r1')
  const middle = result.spans.find((span) => span.label === 'gate-proof:1')
  const inner = result.spans.find((span) => span.label === 'gate-proof:1:checks')
  assert.deepEqual([outer.depth, middle.depth, inner.depth], [0, 1, 2])
  assert.equal(result.spans[inner.parent], middle)
  assert.equal(result.spans[middle.parent], outer)
  for (const child of [middle, inner]) {
    const parent = result.spans[child.parent]
    assert.ok(parent.started_at < child.started_at)
    assert.ok(parent.ended_at > child.ended_at)
  }
})

test('trajectory reports a stage completion with an empty stack', () => {
  const result = buildTrajectory([{ at: 10, stage_done: 'missing' }])
  assert.equal(result.spans.length, 0)
  assert.equal(result.anomalies.length, 1)
  assert.deepEqual(result.anomalies[0], { kind: 'stack_imbalance', label: 'missing', expected: null, index: 0, at_ms: 10 })
})

test('trajectory reports a wrong top without closing either stage', () => {
  const result = buildTrajectory([
    { at: 0, stage: 'A' },
    { at: 1, stage: 'B' },
    { at: 2, stage_done: 'A' },
  ])
  assert.deepEqual(result.anomalies.map((anomaly) => ({ kind: anomaly.kind, label: anomaly.label, expected: anomaly.expected })), [{ kind: 'stack_imbalance', label: 'A', expected: 'B' }])
  assert.equal(result.spans.filter((span) => span.ended_at !== null).length, 0)
  assert.deepEqual(result.spans.map((span) => span.label), ['A', 'B'])
})

test('journal reader skips a torn line and reports its one-based line number', () => {
  const root = scratchDir('visualizer-trajectory-malformed-')
  lane(root, { journal: `${JSON.stringify({ at: 1, event: 'first' })}\n{"at":\n${JSON.stringify({ at: 3, event: 'third' })}\n` })
  const result = createJournalSource({ crewRoot: root }).readJournal({ repo_slug: 'repo', task_slug: 'task', adw_id: 'run-1' })
  assert.deepEqual(result.rows.map((row) => row.event), ['first', 'third'])
  assert.deepEqual(result.rows.map((row) => row.line_number), [1, 3])
  assert.equal(result.rows[0].channel, null)
  assert.equal(result.skipped_malformed, 1)
  assert.deepEqual(result.skipped_line_numbers, [2])
})

test('journal reader degrades instead of throwing when journal.jsonl is absent', () => {
  const root = scratchDir('visualizer-trajectory-missing-')
  lane(root)
  const source = createJournalSource({ crewRoot: root })
  let result
  try {
    result = source.readJournal({ repo_slug: 'repo', task_slug: 'task', adw_id: 'run-1' })
  } catch (error) {
    assert.fail(`readJournal threw: ${error.message}`)
  }
  assert.equal(result.degraded, true)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
  assert.deepEqual(result.rows, [])
})

test('assignment envelopes close the most recent matching assignment', () => {
  const result = buildTrajectory([
    { at: 0, assign: 'recovered', role: 'planner' },
    { at: 100, assign: 'recovered', role: 'planner' },
    { at: 120, envelope: 'recovered', role: 'planner', status: 'done' },
  ])
  const assignments = result.spans.filter((span) => span.family === 'assignment')
  assert.equal(assignments.length, 2)
  assert.equal(assignments[0].ended_at, null)
  assert.equal(assignments[1].ended_at, 120)
  assert.equal(assignments[1].duration_ms, 20)
  assert.equal(assignments[1].status, 'done')
})

test('trajectory hides only the supplied operational channel and preserves null channels', () => {
  const rows = [
    { at: 0, event: 'record', channel: JOURNAL_CHANNELS.record },
    { at: 1, event: 'operation', channel: JOURNAL_CHANNELS.operational },
    { at: 2, event: 'legacy' },
  ]
  const hidden = buildTrajectory(rows, { operational_channel: JOURNAL_CHANNELS.operational })
  assert.equal(hidden.hidden_operational, 1)
  assert.deepEqual(hidden.rows.map((row) => row.event), ['record', 'legacy'])
  assert.equal(hidden.rows.find((row) => row.event === 'legacy').channel, null)
  const revealed = buildTrajectory(rows, { operational_channel: JOURNAL_CHANNELS.operational, reveal: true })
  assert.deepEqual(revealed.rows.map((row) => row.event), ['record', 'operation', 'legacy'])
  assert.equal(revealed.rows.find((row) => row.event === 'operation').channel, JOURNAL_CHANNELS.operational)
})

test('trajectory excludes absent and unparseable timestamps without dating them', () => {
  const result = buildTrajectory([
    { event: 'absent' },
    { at: 'not a timestamp', event: 'invalid' },
    { at: 4, event: 'dated' },
  ])
  assert.equal(result.excluded_no_timestamp, 2)
  assert.deepEqual(result.rows.map((row) => row.event), ['dated'])
  assert.equal(result.rows.some((row) => row.event === 'absent' || row.event === 'invalid'), false)
  assert.equal(toMs(undefined), null)
  assert.equal(toMs(null), null)
})

test('focus selects straddling and open spans but not a wholly later span', () => {
  const trajectory = buildTrajectory(spanRows())
  const focused = focusTrajectory(trajectory, 400, 600)
  assert.deepEqual(focused.spans.map((span) => span.label), ['turn-1:planner', 'open-stage'])
  assert.equal(spansActiveIn(trajectory.spans, 400, 600).length, 2)
})

test('focus adds active span endpoints to an otherwise empty ledger interval', () => {
  const trajectory = buildTrajectory(spanRows())
  const focused = focusTrajectory(trajectory, 400, 600)
  assert.deepEqual(focused.rows.map((row) => row.index), [0, 2, 1])
  assert.equal(focused.rows.some((row) => row.index === 3 || row.index === 4), false)
  assert.deepEqual(trajectory.rows.map((row) => row.index), [0, 2, 3, 4, 1])
})

test('journal route remains read-only and outside the write guard', async () => {
  const root = scratchDir('visualizer-trajectory-route-')
  lane(root, { journal: lines([{ at: 0, event: 'hello' }]) })
  const feed = { close: () => {} }
  const handles = startServer({ port: 0, host: '127.0.0.1', feed, crewRoot: root })
  await new Promise((resolve, reject) => {
    handles.server.once('listening', resolve)
    handles.server.once('error', reject)
  })
  const base = `http://127.0.0.1:${handles.server.address().port}`
  try {
    const post = await fetch(`${base}/api/journal?repo_slug=repo&task_slug=task`, { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET')
    assert.equal((await post.json()).error, 'method not allowed')
    const missing = await fetch(`${base}/api/journal`)
    assert.equal(missing.status, 400)
    assert.ok((await missing.json()).error.includes('repo_slug and task_slug'))
    const partial = await fetch(`${base}/api/journal?repo_slug=repo`)
    assert.equal(partial.status, 400)
    assert.ok((await partial.json()).error.includes('repo_slug and task_slug'))
    const get = await fetch(`${base}/api/journal?repo_slug=repo&task_slug=task&adw_id=run-1`)
    assert.equal(get.status, 200)
    const body = await get.json()
    assert.deepEqual(body.rows.map((row) => row.event), ['hello'])
    assert.deepEqual(body.channels, JOURNAL_CHANNELS)
  } finally {
    await new Promise((resolve) => handles.server.close(resolve))
  }
})

test('journal reads do not change the crew tree, including traversal attempts', () => {
  const root = scratchDir('visualizer-trajectory-readonly-')
  lane(root, { journal: lines([{ at: 0, event: 'hello' }]) })
  const source = createJournalSource({ crewRoot: root })
  const before = treeDigest(root)
  source.readJournal({ repo_slug: 'repo', task_slug: 'task', adw_id: 'run-1' })
  const traversal = source.readJournal({ repo_slug: '../repo', task_slug: 'task', adw_id: 'run-1' })
  assert.equal(traversal.error, 'invalid repo_slug or task_slug')
  assert.equal(treeDigest(root), before)
  assert.equal(source.health().readonly, true)
})

test('projectSpan uses a marker without a width for an open span', () => {
  const box = projectSpan({ started_at: 50, ended_at: null }, 0, 100)
  assert.deepEqual(box, { left: 0.5, marker: true })
  assert.equal('width' in box, false)
})
