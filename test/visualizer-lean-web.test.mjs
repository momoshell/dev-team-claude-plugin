import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import { journalLines, leanView } from '../visualizer/web/src/lib/lean.js'
import { sessionsFeedState } from '../visualizer/web/src/lib/activity.js'
import { leanActivity, leanStatus } from '../visualizer/web/src/lib/fleet.js'
import { deriveDisplayStatus, deriveStatus, fleetActivity, runActivity } from '../visualizer/web/src/lib/fleet.js'

const src = (path) => readFileSync(join(ROOT, 'visualizer/web/src', path), 'utf8')
const open = { source: 'lean', adw_id: 'lean:x', goal: 'x', status: 'running', running: true, latest_stage: 'build', pending: { last_heartbeat_at: 'none recorded' } }

test('lean status and activity never claim liveness or merge', () => {
  assert.equal(deriveDisplayStatus(open).key, 'running'); assert.match(deriveStatus(open).word, /no terminal record/)
  assert.equal(runActivity(open).live, false); assert.equal(fleetActivity([open]).live, 0); assert.equal(fleetActivity([open]).open, 1)
  assert.equal(leanActivity(open).why, 'none recorded')
  const stopped = leanStatus({ status: 'stopped', reason: 'runner-threw' })
  assert.deepEqual([stopped.key, stopped.why], ['aborted', 'runner-threw'])
  assert.equal(leanStatus({ status: 'done' }).word, 'done')
  assert.equal(leanStatus({}).word, 'status not recorded')
})

test('lean view lists journal rows in recorded order without timestamps', () => {
  const lines = journalLines([{ index: 0, event: 'stage-start', stage: 'a' }, { index: 1, event: 'verdict', stage: 'b', status: 'stopped', reason: 'r' }, { index: 2, event: 'pr', stage: 'start', pr: { number: 4 } }])
  assert.deepEqual(lines.map((line) => line.detail), ['', 'stopped · r', '#4'])
  assert.deepEqual(leanView({ goal: 'x' }, null).pending, []); assert.equal(leanView({ goal: 'x' }).stageReason, 'no stage recorded')
})

test('ledger rows keep their old status derivation and App wires lean only', () => {
  assert.equal(deriveStatus({ status: 'ok' }).key, 'success'); assert.equal(deriveStatus({ running: true, phases: [] }).key, 'queued')
  const app = src('App.svelte')
  assert.match(app, /selectedRun\?\.source === 'lean'[\s\S]*LeanRunDetail/); assert.match(app, /probeEnvelopes\(nextRuns\.filter\(\(run\) => run\?\.source !== 'lean'\)\)/)
  assert.match(src('lib/api.js'), /getSeatSessions[\s\S]*seat-sessions/); assert.match(src('lib/LeanRunDetail.svelte'), /journalPulse/)
})

test('an operator-written pr row reads as done, hand-finished; a loop-written one stays plain done', () => {
  const pr = { number: 7, url: 'https://github.com/o/r/pull/7' }
  const operator = { status: 'done', pr, hand_finished: true, pr_actor: 'operator' }
  const loop = { status: 'done', pr, hand_finished: false, pr_actor: 'loop' }
  assert.equal(leanStatus(operator).word, 'done · hand-finished')
  assert.equal(leanStatus(operator).key, 'success')
  assert.equal(deriveDisplayStatus({ source: 'lean', ...operator }).word, 'done · hand-finished')
  assert.equal(leanStatus(loop).word, 'done')
  assert.equal(leanStatus({ status: 'stopped', hand_finished: true }).word, 'stopped')
  const [op] = journalLines([{ event: 'pr', actor: 'operator', pr, index: 0 }])
  const [lp] = journalLines([{ event: 'pr', pr, index: 0 }])
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
  assert.match(leanOutcome({status:'stopped'}).next,/before deciding/);assert.equal(leanOutcome({status:'failed'}).tone,'fail')
  assert.equal(leanPullRequestUrl({url:'javascript:alert(1)'}),null);assert.equal(leanPullRequestUrl({url:'https://user:secret@github.com/o/r/pull/1'}),null);assert.equal(leanPullRequestUrl({url:'https://github.com/o/r/pull/1'}),'https://github.com/o/r/pull/1')
  assert.equal(leanCheckStatus({result:{code:0}}).label,'Exit code 0 recorded');assert.equal(leanCheckStatus({result:{accepted:false}}).tone,'fail')
})

test('VJ3 sessionsFeedState treats a readable lean source as available when the ledger is not', () => {
  const src_ = (lean, ledger) => ({ degraded: !ledger, sources: { lean: { readable: lean, absent: lean ? null : 'x' }, ledger: { readable: ledger, absent: ledger ? null : 'unable to open' } } })
  const a = sessionsFeedState(src_(true, false)); assert.equal(a.degraded, false); assert.equal(a.available, true); assert.equal(a.sources.ledger.absent, 'unable to open')
  assert.equal(sessionsFeedState(src_(false, false)).degraded, true)
  assert.equal(sessionsFeedState(src_(false, true)).degraded, false)
  const empty = sessionsFeedState({ degraded: true, sources: { lean: { readable: true, runs: 0, absent: null }, ledger: { readable: false, absent: 'unable to open' } } })
  assert.equal(empty.degraded, false); assert.equal(empty.available, true)
  assert.equal(sessionsFeedState({ degraded: true }).degraded, true); assert.equal(sessionsFeedState({}).degraded, false)
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
