import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leanView, leanStageStatus } from '../visualizer/web/src/lib/lean.js'
import { sessionsFeedState } from '../visualizer/web/src/lib/activity.js'
import { leanStatus } from '../visualizer/web/src/lib/fleet.js'

test('leanStageStatus gives every phase status the server sends a tone and a label', () => {
  for (const [status, label, tone] of [['escalate', 'Escalated', 'attention'], ['held', 'Held', 'attention'], ['insufficient', 'Insufficient', 'attention'], ['unmeasured', 'Unmeasured', 'quiet'], ['unknown', 'Outcome unknown', 'quiet'], ['running', 'No stage-end record', 'quiet'], ['done', 'Stage ended', 'ok'], ['failed', 'failed', 'fail'], ['stopped', 'stopped', 'attention']]) assert.deepEqual(leanStageStatus(status), { label, tone })
})

test('a stage-end line states its envelope, halt, held or threw outcome', () => {
  const cases = [
    [{ envelope: { role: 'planner', status: 'done' } }, 'planner · done'],
    [{ halt: { status: 'stopped', reason: 'lead-escalated' } }, 'stopped · lead-escalated'],
    [{ held: { reason: 'insufficient', envelope: { status: 'insufficient' } } }, 'held · insufficient'],
    [{ threw: { message: 'failure' } }, 'threw · failure'],
    [{ envelope: {} }, 'envelope records no status'], [{}, 'outcome records no status'], [null, 'outcome not recorded'],
    [{ status: 'done', code: 1 }, 'done'], [{ code: 1, halt: {} }, 'exit 1'],
  ]
  assert.deepEqual(leanView({}, { rows: cases.map(([outcome]) => ({ event: 'stage-end', outcome })) }).lines.map(line => line.detail), cases.map(([, expected]) => expected))
})

test('scout_nudge and subagent_usage rows are named with their role', () => {
  const rows = [{ role: 'reviewer', scout_nudge: { reads: 8, directories: 7 } }, { role: 'reviewer', subagent_usage: { agent: 'scout', outcome: 'ok' } }]
  assert.deepEqual(leanView({}, { rows }).lines.map(({ event, detail }) => [event, detail]), [['scout_nudge', 'reviewer · 8 reads · 7 directories'], ['subagent_usage', 'reviewer · scout · ok']])
})

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

test('lean view lists journal rows in recorded order without timestamps', () => {
  const lines = leanView({}, { rows: [{ index: 0, event: 'stage-start', stage: 'a' }, { index: 1, event: 'verdict', stage: 'b', status: 'stopped', reason: 'r' }, { index: 2, event: 'pr', stage: 'start', pr: { number: 4 } }] }).lines
  assert.deepEqual(lines.map((line) => line.detail), ['', 'stopped · r', '#4'])
  assert.deepEqual(leanView({ goal: 'x' }, null).pending, []); assert.equal(leanView({ goal: 'x' }).stageReason, 'no stage recorded')
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
