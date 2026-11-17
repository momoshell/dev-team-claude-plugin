import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import * as fleet from '../visualizer/web/src/lib/fleet.js'
import { leanOutcome } from '../visualizer/web/src/lib/lean.js'
import { layoutTimeline } from '../visualizer/web/src/lib/timeline.js'

const src = (path) => readFileSync(join(ROOT, 'visualizer/web/src', path), 'utf8')
const lane = (id, status, extra = {}) => ({ source: 'lean', adw_id: `lean:${id}`, goal: id, status, running: false, archived: false, tier: 'build', shape: 'standard', latest_stage: 'plan', started_at: '2026-01-01', ...extra })

test('board: unwritten lane statuses, the timeline constants and the task_profile filter are gone', () => {
  assert.equal(fleet.leanStatus({ status: 'escalated' }).key, 'unknown'); assert.equal(fleet.needsAttention('escalated'), false)
  assert.deepEqual(fleet.attentionBreakdown([]).segments.map((s) => s.key), ['ready', 'returned', 'aborted', 'abandoned'])
  for (const status of ['failed', 'error', 'blocked', 'escalated']) assert.equal(leanOutcome({ status }).headline, 'Outcome not recorded')
  const timeline = layoutTimeline({ phases: [] })
  for (const key of ['request', 'queued', 'marks', 'lanes']) assert.equal(key in timeline, false)
  assert.ok(!fleet.configurationFilterView([{ adw_id: 'p', task_profile: 'implementation' }]).dimensions.some((d) => d.key === 'task_profile'))
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
  const keys = ['ready', 'returned', 'aborted', 'abandoned']
  const result = fleet.attentionBreakdown(keys.map((key) => ({ status: { key } })))
  assert.deepEqual(result.segments, keys.map((key, i) => ({ key, label: ['ready for operator', 'returned', 'stopped', 'abandoned'][i], count: 1 })))
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.count, 0), result.total)
  assert.equal(result.total, 4)
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
