import test from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSION_POLICIES, PERMISSION_REFUSALS, permitQuestion, settlePermission, permissionHandler, readOnlyCommand, panelPermission } from './acp-permission.mjs'

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

test('B1 read-only command allowlist accepts ten safe commands and pipelines', () => {
  for (const command of [
    'git diff', 'git log --oneline', 'git show HEAD', 'git status --short', 'git blame file',
    'git rev-parse HEAD', 'git ls-files', 'git grep pattern', 'grep -n pattern file', 'rg pattern file',
    'cat file', 'head -n 2 file', 'tail file', 'wc -l file', 'ls -la', 'sed -n 1,4p file',
    "cat 'file name' | wc -l", 'git diff | head -n 5',
  ]) assert.equal(readOnlyCommand(command), true, command)
})

test('B2 read-only command allowlist rejects unsafe commands and malformed syntax', () => {
  for (const command of [
    'git push', 'git diff --output=file', 'git diff --ext-diff', 'git diff -Ofoo', 'git diff --open-files-in-pager=x',
    'git grep -lOrm foo', 'git grep --open=rm foo', 'git grep --open-files=rm foo',
    'rg --pre=cmd pattern', 'rg --hostname-bin=./scripts/x foo', 'sh -c true', 'echo hi', 'cat a > b',
    'cat a; cat b', 'cat a && cat b', 'cat a || cat b', '| cat a', 'cat a |', 'cat a\\| wc',
    'cat $HOME', 'cat `pwd`', 'cat "unfinished', 'sed -e s/a/b/ file', 'git diff\\ > file',
    'cat a\ncat b', 'cat a\rcat b', 'cat (a)', 'cat {a}',
  ]) assert.equal(readOnlyCommand(command), false, String(command))
  for (const command of [null, undefined, 4, '', ' ', '\n']) assert.equal(readOnlyCommand(command), false)
})

test('RV1-1 rejects git grep pager option aliases', () => {
  for (const command of ['git grep -lOrm foo', 'git grep --open=rm foo', 'git grep --open-files=rm foo'])
    assert.equal(readOnlyCommand(command), false, command)
})

test('B4 panel execute decisions are roster-attributed and only allow_once can approve', () => {
  const approve = panelPermission({ kind: 'execute', rawInput: { command: 'git diff' } })
  const refuse = panelPermission({ kind: 'execute', rawInput: { command: 'git diff > f' } })
  const mutation = panelPermission({ title: 'write', kind: 'other' })
  assert.deepEqual(approve, { policy: 'roster', verdict: 'allow' })
  assert.deepEqual(refuse, { policy: 'roster', verdict: 'reject' })
  assert.deepEqual(mutation, { policy: 'roster', verdict: 'reject' })
  for (const answer of [approve, refuse, mutation]) {
    const result = settlePermission({ toolCall, options, lead: () => answer })
    assert.equal(result.row.policy, 'roster')
    assert.equal(Object.hasOwn(result.row, 'answered'), false)
    assert.equal(result.optionId, answer.verdict === 'allow' ? 'allow' : 'reject')
  }
  assert.equal(settlePermission({ toolCall, options: [options[0], options[2]], lead: () => approve }).optionId, 'reject')
  assert.equal(settlePermission({ toolCall, options, lead: () => ({ decision: 'allow' }) }).row.policy, 'lead')
})
