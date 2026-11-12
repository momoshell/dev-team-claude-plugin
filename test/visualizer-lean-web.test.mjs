import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import { leanView } from '../visualizer/web/src/lib/lean.js'
import { sessionsFeedState } from '../visualizer/web/src/lib/activity.js'
import { leanStatus } from '../visualizer/web/src/lib/fleet.js'

const src = (path) => readFileSync(join(ROOT, 'visualizer/web/src', path), 'utf8')
const open = { source: 'lean', adw_id: 'lean:x', goal: 'x', status: 'running', running: true, latest_stage: 'build', pending: { last_heartbeat_at: 'none recorded' } }

test("journal lines detail every loop event, show a verdict's observation and name advisor rows", () => {
  const rows = [
    { event: 'envelope', role: 'builder', parsed: { status: 'insufficient' }, defects: ['missing gap'] },
    { event: 'envelope', role: 'builder', error: { message: 'seat failed' } },
    { event: 'seat-turn', role: 'builder', model: 'model', seconds: 2, tool_calls: 3, stop_reason: 'end_turn', status: 'done', usage: { totalTokens: 42 } },
    { event: 'seat-turn', role: 'builder', usage: null, unmeasured: { usage: 'not-reported' } },
    { event: 'builder-continue', id: 'a', progressTurns: 1 }, { event: 'lead-bound-refund', id: 'b', progressTurns: 2 },
    { event: 'tier-raised', from: 'build', to: 'judge', reason: 'risk' }, { event: 'roster', tier: 'build', seats: { builder: {} } },
    { event: 'commit', head: 'abc' }, { event: 'finish-ready', status: 'ready', head: 'abc' }, { event: 'finish-decision', choice: 'return' },
    { event: 'memory-empty', role: 'builder', reason: 'empty' }, { event: 'verdict', status: 'stopped', observation: { question: 'Ship it?' } },
    { at: 1, advisor_consult: {}, role: 'builder' }, { event: 'stage-start' }, { event: 'run-start' },
  ]
  const lines = leanView({}, { rows }).lines
  assert.ok(lines.slice(0, 14).every((line) => line.detail))
  for (const detail of [/model/, /2s/, /3 tool calls/, /end_turn/, /done/, /42 tokens/]) assert.match(lines[2].detail, detail)
  assert.match(lines[3].detail, /not-reported/)
  assert.match(lines[0].detail, /missing gap/); assert.match(lines[1].detail, /seat failed/); assert.match(lines[12].detail, /Ship it\?/)
  assert.equal(lines[13].event, 'advisor_consult'); assert.match(lines[13].detail, /builder/)
  assert.equal(lines[14].detail, ''); assert.equal(lines[15].detail, '')
})

test('the task cell drops the lean id fragment, the usage cell shows turn coverage and the detail page names no event inspector', () => {
  const task = src('lib/TaskList.svelte')
  assert.doesNotMatch(task, /slice\(0, 8\)/); assert.ok(task.includes('tokens.turns'))
  assert.ok(!src('lib/LeanRunDetail.svelte').includes('event inspector'))
})

test('lean status and activity never claim liveness or merge', () => {
  assert.equal(leanStatus(open).key, 'running'); assert.match(leanStatus(open).word, /no terminal record/)
  const stopped = leanStatus({ status: 'stopped', reason: 'runner-threw' })
  assert.deepEqual([stopped.key, stopped.why], ['aborted', 'runner-threw'])
  assert.equal(leanStatus({ status: 'done' }).word, 'done')
  assert.equal(leanStatus({}).word, 'status not recorded')
})

// MUTATION: return success for an untagged status: 'ok' row.
test('status and activity read every row as a lean lane', () => {
  const status = { key: 'unknown', word: 'ok', tone: 'quiet', where: null, why: null, open: false }
  assert.deepEqual(leanStatus({ status: 'ok' }), status)
})

test('lean view lists journal rows in recorded order without timestamps', () => {
  const lines = leanView({}, { rows: [{ index: 0, event: 'stage-start', stage: 'a' }, { index: 1, event: 'verdict', stage: 'b', status: 'stopped', reason: 'r' }, { index: 2, event: 'pr', stage: 'start', pr: { number: 4 } }] }).lines
  assert.deepEqual(lines.map((line) => line.detail), ['', 'stopped · r', '#4'])
  assert.deepEqual(leanView({ goal: 'x' }, null).pending, []); assert.equal(leanView({ goal: 'x' }).stageReason, 'no stage recorded')
})

test('App wires lean lanes only: no ledger detail, no envelope probe, no dropped page', () => {
  const app = src('App.svelte')
  assert.match(app, /selectedRun\?\.source === 'lean'[\s\S]*LeanRunDetail/); assert.ok(!/RunDetail\.svelte|probeEnvelopes|getReturns/.test(app.replace(/LeanRunDetail/g, '')))
  assert.match(src('lib/api.js'), /getSeatSessions[\s\S]*seat-sessions/); assert.match(src('lib/LeanRunDetail.svelte'), /journalPulse/)
})

test('an operator-written pr row reads as done, hand-finished; a loop-written one stays plain done', () => {
  const pr = { number: 7, url: 'https://github.com/o/r/pull/7' }
  const operator = { status: 'done', pr, hand_finished: true, pr_actor: 'operator' }
  const loop = { status: 'done', pr, hand_finished: false, pr_actor: 'loop' }
  assert.equal(leanStatus(operator).word, 'done · hand-finished')
  assert.equal(leanStatus(operator).key, 'success')
  assert.equal(leanStatus(loop).word, 'done')
  assert.equal(leanStatus({ status: 'stopped', hand_finished: true }).word, 'stopped')
  const [op] = leanView({}, { rows: [{ event: 'pr', actor: 'operator', pr, index: 0 }] }).lines
  const [lp] = leanView({}, { rows: [{ event: 'pr', pr, index: 0 }] }).lines
  assert.equal(lp.detail, pr.url)
  assert.notEqual(op.detail, lp.detail)
  assert.ok(op.detail.includes(pr.url) && /operator/.test(op.detail))
})

test('lean presentation distinguishes accepted failing baselines, open stages and terminal task results', async () => {
  const {leanOutcome,leanStageStatus,leanCheckStatus,leanPullRequestUrl}=await import('../visualizer/web/src/lib/lean.js')
  const baseline=leanCheckStatus({result:{accepted:true,result:{status:'red'}}})
  assert.equal(baseline.tone,'attention');assert.match(baseline.label,/accepted.*failed/)
  assert.equal(leanStageStatus('green').tone,'ok');assert.equal(leanStageStatus('red').tone,'fail')
  assert.equal(leanStageStatus('running').label,'No stage-end record');assert.equal(leanStageStatus(undefined).label,'Outcome not recorded')
  assert.match(leanOutcome({status:'running'}).next,/does not establish/);assert.match(leanOutcome({status:'done',pr:{number:1}}).next,/Merge status is not recorded/)
  assert.match(leanOutcome({status:'stopped'}).next,/before deciding/)
  assert.equal(leanPullRequestUrl({url:'javascript:alert(1)'}),null);assert.equal(leanPullRequestUrl({url:'https://user:secret@github.com/o/r/pull/1'}),null);assert.equal(leanPullRequestUrl({url:'https://github.com/o/r/pull/1'}),'https://github.com/o/r/pull/1')
  assert.equal(leanCheckStatus({result:{code:0}}).label,'Exit code 0 recorded');assert.equal(leanCheckStatus({result:{accepted:false}}).tone,'fail')
})

test('VJ3 sessionsFeedState is the lean source alone: readable is available, anything else is unavailable', () => {
  const src_ = (lean) => ({ degraded: !lean, sources: { lean: { readable: lean, absent: lean ? null : 'x' } } })
  const a = sessionsFeedState(src_(true)); assert.equal(a.degraded, false); assert.equal(a.available, true); assert.equal(a.sources.lean.absent, null)
  const b = sessionsFeedState(src_(false)); assert.equal(b.degraded, true); assert.equal(b.sources.lean.absent, 'x')
  const empty = sessionsFeedState({ degraded: false, sources: { lean: { readable: true, runs: 0, absent: null } } })
  assert.equal(empty.degraded, false); assert.equal(empty.available, true); assert.equal(empty.sources.lean.runs, 0)
  assert.equal(Object.hasOwn(empty.sources, 'ledger'), false)
  // A response that says nothing about the lean source is unreadable, never assumed readable.
  assert.equal(sessionsFeedState({}).degraded, true); assert.equal(sessionsFeedState({}).sources.lean.runs, null)
})

test('VJ5 App.svelte takes feed state from sessionsFeedState and no longer claims a ledger connection', () => {
  const app = src('App.svelte')
  assert.match(app, /sessionsFeedState\(result\)/)
  for (const gone of ['result?.degraded === true', 'Ledger connected', 'Connecting to ledger']) assert.ok(!app.includes(gone), gone)
})

test('VJ5 the sidebar keeps per-source reasons when the whole feed is unavailable', () => {
  const app = src('App.svelte')
  const line = app.split('\n').find((l) => l.includes('class="connection"'))
  assert.match(line, /Feed unavailable/); assert.match(line, /sourceLine\(feedSources\)/)
  assert.ok(line.indexOf('{#if feedSources}') > line.indexOf('Feed unavailable'), 'sources render outside the unavailable branch')
})
