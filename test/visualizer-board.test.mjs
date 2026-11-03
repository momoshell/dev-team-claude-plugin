import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import * as fleet from '../visualizer/web/src/lib/fleet.js'
import { leanOutcome } from '../visualizer/web/src/lib/lean.js'
import { parseHash } from '../visualizer/web/src/lib/route.js'

const src = (path) => readFileSync(join(ROOT, 'visualizer/web/src', path), 'utf8')
const lane = (id, status, extra = {}) => ({ source: 'lean', adw_id: `lean:${id}`, goal: id, status, running: false, archived: false, tier: 'build', shape: 'standard', latest_stage: 'plan', started_at: '2026-01-01', ...extra })

test('board: operator-facing lean statuses reach Needs attention with their own keys', () => {
  // MUTATION: drop the abandoned key from the attention map.
  for (const [status, key, tone, attention, word] of [
    ['ready-for-operator', 'ready', 'serious', true, 'ready for operator'], ['returned', 'returned', 'serious', true, 'returned · no new run'],
    ['escalated', 'escalated', 'serious', true, 'escalated'], ['stopped', 'aborted', 'aborted', true, 'stopped'], ['abandoned', 'abandoned', 'serious', true, 'abandoned'],
  ]) {
    const result = fleet.leanStatus(lane(status, status))
    assert.deepEqual([result.key, result.tone, fleet.needsAttention(result.key), result.word], [key, tone, attention, word])
  }
  assert.deepEqual(fleet.leanStatus({ status: 'ok' }), { key: 'unknown', word: 'ok', tone: 'quiet', where: null, why: null, open: false })
  assert.equal(fleet.leanStatus({}).word, 'status not recorded')
})

test('board: the Finished tab never lists an unknown status', () => {
  assert.equal(typeof fleet.taskBoard, 'function', 'fleet.js exports taskBoard')
  // MUTATION: drop the unknown guard from the finished predicate.
  const rows = [lane('unknown', 'unknown'), lane('other', 'odd'), lane('done', 'done'), lane('open', 'running', { running: true })]
  assert.deepEqual(fleet.taskBoard(rows, { state: 'finished' }).rows.map((r) => r.goal), ['done'])
})

test('board: the Open tab counts journal-open lanes and no tab counts liveness or merges', () => {
  assert.equal(typeof fleet.taskBoard, 'function', 'fleet.js exports taskBoard')
  // MUTATION: make the open predicate false.
  const rows = [lane('reviewed', 'reviewed', { running: true }), lane('done', 'done'), lane('ready', 'ready-for-operator')]
  const board = fleet.taskBoard(rows, { state: 'open' })
  assert.deepEqual(board.counts, { all: 3, open: 1, finished: 2, attention: 1 })
  assert.deepEqual(board.rows.map((r) => r.goal), ['reviewed'])
  const task = src('lib/TaskList.svelte')
  for (const label of ['All tasks', 'Open', 'Finished', 'Needs attention', 'taskBoard(runs,']) assert.ok(task.includes(label))
  for (const label of ['Live now', 'Shipped']) assert.ok(!task.includes(label))
})

test('board: archived lanes are hidden unless Show archived is set', () => {
  assert.equal(typeof fleet.taskBoard, 'function', 'fleet.js exports taskBoard')
  // MUTATION: read run.triage?.reviewed_at instead of run.archived.
  const rows = [lane('archived', 'stopped', { archived: true }), lane('visible', 'returned', { triage: { reviewed_at: 'date' } })]
  assert.deepEqual(fleet.taskBoard(rows, { state: 'attention' }).rows.map((r) => r.goal), ['visible'])
  assert.equal(fleet.taskBoard(rows).counts.attention, 1)
  assert.equal(fleet.taskBoard(rows, { showArchived: true }).counts.attention, 2)
  assert.equal(fleet.taskBoard(rows, { showArchived: true }).rows.length, 2)
  assert.ok(src('App.svelte').includes("taskBoard(runs, { state: 'attention' })"))
})

test('board: search matches the fields a lean lane carries', () => {
  assert.equal(typeof fleet.taskBoard, 'function', 'fleet.js exports taskBoard')
  // MUTATION: drop shape from the searched fields.
  const row = lane('id', 'returned', { goal: 'GoalUnique', repo_slug: 'RepoUnique', adw_id: 'lean:IdUnique', tier: 'TierUnique', shape: 'ShapeUnique', latest_stage: 'StageUnique' })
  for (const query of ['goalunique', 'repounique', 'idunique', 'RETURNED', 'tierunique', 'shapeunique', 'stageunique']) assert.equal(fleet.taskBoard([row], { query }).rows.length, 1, query)
  assert.equal(fleet.taskBoard([row], { query: 'missing' }).rows.length, 0)
})

test('board: attention segments name every attention key and sum to the total', () => {
  // MUTATION: drop the ready label.
  const keys = ['ready', 'returned', 'escalated', 'aborted', 'abandoned']
  const result = fleet.attentionBreakdown(keys.map((key) => ({ status: { key } })))
  assert.deepEqual(result.segments, keys.map((key, i) => ({ key, label: ['ready for operator', 'returned', 'escalated', 'stopped', 'abandoned'][i], count: 1 })))
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.count, 0), result.total)
  assert.equal(result.total, 5)
})

test('board: the detail outcome agrees with the board for finish-stage statuses', () => {
  // MUTATION: remove the ready-for-operator branch of leanOutcome.
  for (const [status, headline, tone] of [['ready-for-operator', 'Ready for an operator decision', 'attention'], ['returned', 'Returned; no new run recorded', 'attention'], ['abandoned', 'Task abandoned by an operator', 'attention']]) {
    const outcome = leanOutcome({ status })
    assert.equal(outcome.headline, headline)
    assert.equal(outcome.tone, tone)
  }
  assert.match(leanOutcome({ status: 'ready-for-operator' }).next, /crew finish <lane>/)
})

test('board: fleet.js carries no heartbeat, driver or liveness code', () => {
  // MUTATION: restore heartbeatCell.
  const source = src('lib/fleet.js')
  for (const name of ['driverObservation', 'heartbeatCell', 'SILENT_AFTER_MS', 'runActivity', 'fleetActivity', "'silent'", "'unverified'", "'gone'", "'contradicted'"]) assert.ok(!source.includes(name), name)
})

test('board: App and route carry no dropped routes, envelope map or dead layout', () => {
  // MUTATION: restore repeat(4,.
  const app = src('App.svelte')
  const task = src('lib/TaskList.svelte')
  const route = src('lib/route.js')
  for (const text of ['const envelopes', "'prompts'", "'ops'", "'workflows'", "'assurances'", "route.view === 'phase'", 'ops-grid', '.diagnostics']) assert.ok(!app.includes(text), text)
  for (const source of [app, task, route]) for (const text of ['triage', 'envelopes']) assert.ok(!source.includes(text), text)
  assert.match(app, /@media \(max-width:760px\)[^\n]*repeat\(3,minmax\(0,1fr\)\)/)
  assert.deepEqual(parseHash('#/a/plan'), { view: 'run', adw_id: 'a' })
  assert.equal(existsSync(join(ROOT, 'visualizer/web/src/lib/configuration-controls.css')), false)
})
