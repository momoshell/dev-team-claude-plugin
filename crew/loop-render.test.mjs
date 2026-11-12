import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitBody, seatTurnRow } from './loop.mjs'

test('seatTurnRow renders failed and measured turns', () => {
  const cases = [
    [{ role: 'planner', id: 'p', recording: null, turnError: { message: 'failed' }, parsed: null, started: undefined, ended: undefined, turnBefore: null, turnAfter: null }, {
      role: 'planner', id: 'p', agent: null, model: null, effort: null, tool_calls: null, stop_reason: null, usage: null, seconds: null, status: null, worktree_changed: null,
      unmeasured: { agent: 'turn-failed', model: 'turn-failed', effort: 'turn-failed', tool_calls: 'turn-failed', stop_reason: 'turn-failed', usage: 'turn-failed', seconds: 'clock-unmeasured', status: 'no-return', worktree_changed: 'not-repo-seat' },
    }],
    [{ role: 'builder', id: 'b', recording: { definition: { agent: 'pi', model: 'local/model', effort: 'high' }, toolCalls: 3, stopReason: 'end_turn', usage: { inputTokens: 12 } }, turnError: null, parsed: { status: 'done' }, started: 1000, ended: 3500, turnBefore: 'a', turnAfter: 'b' }, {
      role: 'builder', id: 'b', agent: 'pi', model: 'local/model', effort: 'high', tool_calls: 3, stop_reason: 'end_turn', usage: { inputTokens: 12 }, seconds: 2.5, status: 'done', worktree_changed: true, unmeasured: {},
    }],
  ]
  for (const [input, expected] of cases) {
    const row = seatTurnRow(input)
    assert.deepEqual(row, expected)
    assert.deepEqual(Object.keys(row), Object.keys(expected))
  }
})

test('commitBody renders standard, should-fix and finish bodies', () => {
  const base = { source: 'issue 1', isFinish: false, tier: 'build', stop: null, finishReviews: [], measurements: ['- proof: unmeasured', '- Suite: unmeasured.'], priorFindings: [], secondFindings: [] }
  const standard = 'Source: "issue 1"\n\n## Measurements\n- proof: unmeasured\n- Suite: unmeasured.'
  for (const [input, expected] of [
    [base, standard],
    [{ ...base, priorFindings: [{ id: 'R1', severity: 'should-fix', location: 'lib.mjs:1', summary: 'Fix this' }] }, `${standard}\n\n## Should-fix\n- R1 (reviewer) at lib.mjs:1: Fix this`],
    [{ ...base, isFinish: true, stop: { reason: 'round-bound', observation: { role: 'builder' } }, finishReviews: [{ verdict: 'pass', findings: [] }] }, 'Source: "issue 1"\n\n## Finish\n- Stop: round-bound: {"role":"builder"}\n- Review 1: pass; findings: none\n\n## Measurements\n- proof: unmeasured\n- Suite: unmeasured.'],
  ]) assert.equal(commitBody(input), expected)
})
