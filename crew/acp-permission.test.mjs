import test from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSION_POLICIES, PERMISSION_REFUSALS, permitQuestion, settlePermission, permissionHandler } from './acp-permission.mjs'

const toolCall = { title: 'shell', kind: 'execute', rawInput: { command: 'echo hi' } }
const options = [
  { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
  { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
  { kind: 'allow_always', name: 'Allow Always', optionId: 'always' },
]
const settle = (extra = {}) => settlePermission({ toolCall, options, ...extra })

test('P1 deny policy wins even over allow policy', () => {
  assert.equal(settle({ policy: { autoDeny: ['shell'], autoApprove: ['execute'] } }).optionId, 'reject')
})
test('P2 allow policy picks allow-once', () => {
  assert.equal(settle({ policy: { autoApprove: ['execute'] } }).optionId, 'allow')
})
test('roster deny row has exactly its six non-lead keys', () => {
  assert.deepEqual(settle({ policy: { autoDeny: ['shell'] } }).row, { kind: 'permission', tool: 'execute', title: 'shell', option_kind: 'reject_once', option: 'reject', policy: 'roster' })
})
test('P3 invokes lead exactly once with permit payload', () => {
  let calls = 0
  settle({ lead: (payload) => { calls++; assert.equal(payload.question, 'permit'); return { details: { decision: 'allow' } } } })
  assert.equal(calls, 1)
})
test('P4 accepts only a matching request optionId', () => {
  assert.equal(settle({ lead: () => ({ details: { decision: 'bogus' } }) }).optionId, 'reject')
})
test('P5 no lead defaults to reject without invoking a lead', () => {
  assert.equal(settle({ lead: null }).optionId, 'reject')
  assert.deepEqual(settle({ lead: null }).row, { kind: 'permission', tool: 'execute', title: 'shell', option_kind: 'reject_once', option: 'reject', policy: 'no-lead' })
})
test('P6 escalation and invalid/non-string/throwing answers fail closed', () => {
  for (const lead of [() => ({ details: { decision: 'escalate' } }), () => ({ details: { decision: 4 } }), () => { throw Error('failed') }])
    assert.equal(settle({ lead }).optionId, 'reject')
})
test('P7 missing reject option refuses before lead or selection journal', () => {
  let calls = 0
  assert.throws(() => settlePermission({ toolCall, options: [{ kind: 'allow_once', optionId: 'allow' }], lead: () => calls++, log: () => calls++ }), { reason: 'permission-no-reject-option' })
  assert.equal(calls, 0)
})
test('P8 result uses request optionId and exact permission row', () => {
  const result = settle({ lead: () => ({ details: { decision: 'reject' } }) })
  assert.equal(result.optionId, 'reject')
  assert.deepEqual(result.row, { kind: 'permission', tool: 'execute', title: 'shell', option_kind: 'reject_once', option: 'reject', policy: 'lead', answered: 'reject' })
})
test('P9 journal failure does not change selected answer', () => {
  assert.equal(settle({ policy: { autoDeny: ['shell'] }, log: () => { throw Error('journal') } }).optionId, 'reject')
})
test('P10 handler journals named refusal and returns null even when refusal logging fails', () => {
  const handler = permissionHandler({ log: () => { throw Error('journal') } })
  assert.equal(handler({ toolCall, options: [] }), null)
})
test('enums are frozen and exact', () => {
  assert.deepEqual(PERMISSION_POLICIES, ['roster', 'lead', 'no-lead'])
  assert.deepEqual(PERMISSION_REFUSALS, ['permission-no-reject-option'])
  assert.equal(Object.isFrozen(PERMISSION_POLICIES), true)
  assert.equal(Object.isFrozen(PERMISSION_REFUSALS), true)
})
test('permit question identifies call, options, required decision shape, and scope', () => {
  const question = permitQuestion({ toolCall, options })
  for (const text of ['shell', 'execute', '{"command":"echo hi"}', 'optionId=reject', 'reject_once', 'Deny', 'exactly one request optionId in details.decision', 'Out-of-task-scope calls must be rejected']) assert.ok(question.includes(text), text)
})
test('reject-always is used when reject-once is unavailable', () => {
  const result = settlePermission({ toolCall, options: [{ kind: 'reject_always', optionId: 'deny-all' }], lead: () => { throw Error('must not call') } })
  assert.equal(result.optionId, 'deny-all')
})
test('allow-always fallback is used and allow policy falls back to rejection', () => {
  const allowAlways = [{ kind: 'reject_once', optionId: 'deny' }, { kind: 'allow_always', optionId: 'all' }]
  assert.equal(settlePermission({ toolCall, options: allowAlways, policy: { autoApprove: ['shell'] } }).optionId, 'all')
  assert.equal(settlePermission({ toolCall, options, policy: { autoApprove: ['shell'] } }).optionId, 'allow')
  assert.equal(settlePermission({ toolCall, options: [options[0]], policy: { autoApprove: ['shell'] } }).optionId, 'reject')
})
test('Claude option IDs are accepted as IDs, not ACP kinds', () => {
  assert.equal(settle({ lead: () => ({ details: { decision: 'allow' } }) }).optionId, 'allow')
})
test('wrong-typed lead decision is journaled raw while rejecting', () => {
  assert.deepEqual(settle({ lead: () => ({ details: { decision: 4 } }) }).row, { kind: 'permission', tool: 'execute', title: 'shell', option_kind: 'reject_once', option: 'reject', policy: 'lead', answered: 4 })
})
test('lead throw is recorded as null answer with lead source', () => {
  assert.deepEqual(settle({ lead: () => { throw Error('no response') } }).row, { kind: 'permission', tool: 'execute', title: 'shell', option_kind: 'reject_once', option: 'reject', policy: 'lead', answered: null })
})
test('handler refusal logs refusal reason', () => {
  let row
  const handler = permissionHandler({ log: (entry) => { row = entry } })
  assert.equal(handler({ toolCall, options: [] }), null)
  assert.deepEqual(row, { kind: 'permission', reason: 'permission-no-reject-option' })
})
