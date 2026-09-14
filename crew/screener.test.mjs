import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINDING_DISPOSITIONS,
  SCREENER_AXES,
  SCREENER_REASONS,
  runScreenerPanel,
} from './screener.mjs'
import {
  FINDING_DISPOSITIONS as REVIEW_FINDING_DISPOSITIONS,
  FINDING_ID_SHAPE,
} from './drive.mjs'

const diff = Object.freeze('diff --git a/crew/example.mjs b/crew/example.mjs')
const acceptance = Object.freeze('the example remains bounded and reviewable')
const members = Object.freeze(SCREENER_AXES.map((axis, index) => Object.freeze({
  axis,
  provider: `provider-${index + 1}`,
  model: `model-${index + 1}`,
})))

function candidate(id, overrides = {}) {
  return {
    id,
    disposition: 'ask-user',
    location: 'crew/example.mjs:1',
    summary: `consider ${id}`,
    ...overrides,
  }
}

function seamsFor(screen, createContext = async (member) => ({ member })) {
  return { createContext, screen }
}

async function completePanel(overrides = {}) {
  return runScreenerPanel({ diff, acceptance, members, timeoutMs: 100, ...overrides }, seamsFor(
    ({ axis }) => [candidate(`${axis}-finding`)],
  ))
}

test('A1', async () => {
  const contextByMember = new Map()
  const contexts = new Set()
  let started = 0
  let release
  const allStarted = new Promise((resolve) => { release = resolve })
  const seen = []
  const createContext = async (member) => {
    const context = { member, number: contextByMember.size + 1 }
    contextByMember.set(member, context)
    return context
  }
  const screen = async (input) => {
    seen.push(input)
    started += 1
    if (started === members.length) release()
    await allStarted
    contexts.add(input.context)
    return [candidate(`${input.axis}-finding`)]
  }

  const result = await runScreenerPanel({ diff, acceptance, members, timeoutMs: 100 }, { createContext, screen })
  assert.equal(result.reason, null)
  assert.equal(result.answered, members.length)
  assert.equal(result.asked, members.length)
  assert.equal(seen.length, members.length)
  assert.equal(contextByMember.size, members.length)
  assert.equal(contexts.size, members.length)
  assert.deepEqual(seen.map(({ diff: seenDiff }) => seenDiff), members.map(() => diff))
  assert.deepEqual(seen.map(({ acceptance: seenAcceptance }) => seenAcceptance), members.map(() => acceptance))
  assert.deepEqual(seen.map(({ axis }) => axis), [...SCREENER_AXES])
  assert.deepEqual(seen.map(({ model }) => model), members.map(({ model }) => model))
  assert.deepEqual(seen.map(({ context }, index) => context === contextByMember.get(members[index])), members.map(() => true))
})

test('B1', async () => {
  const result = await runScreenerPanel(
    { diff, acceptance, members: [members[0]], timeoutMs: 100 },
    seamsFor(() => [candidate('B1-one'), candidate('B1-two')]),
  )
  assert.equal(result.reason, null)
  assert.equal(result.proposals.length, 2)
  for (const proposal of result.proposals) {
    assert.equal(proposal.source, 'screener')
    assert.equal(proposal.status, 'proposed')
  }
})

test('C1', async () => {
  const result = await runScreenerPanel(
    { diff, acceptance, members: [members[0]], timeoutMs: 100 },
    seamsFor(() => [candidate('C1-shape', {
      severity: 'must-fix',
      patch: 'delete everything',
      verdict: 'changes-needed',
      blocking: true,
      failure: true,
      panelVerdict: 'approve',
      checkFailure: true,
    })]),
  )
  assert.equal(result.reason, null)
  assert.deepEqual(Object.keys(result).sort(), ['answered', 'asked', 'members', 'proposals', 'reason'])
  assert.deepEqual(Object.keys(result.proposals[0]).sort(), [
    'disposition', 'id', 'location', 'model', 'severity', 'source', 'status', 'summary',
  ])
  assert.equal(result.proposals[0].severity, 'consider')
  for (const key of ['patch', 'verdict', 'blocking', 'failure', 'panelVerdict', 'checkFailure']) {
    assert.equal(Object.hasOwn(result.proposals[0], key), false)
    assert.equal(Object.hasOwn(result, key), false)
  }
})

test('D1', async () => {
  assert.deepEqual(FINDING_DISPOSITIONS, REVIEW_FINDING_DISPOSITIONS)
  assert.equal(Object.isFrozen(FINDING_DISPOSITIONS), true)
  for (const id of ['A1', 'finding_2', 'a-b', 'x'.repeat(64)]) {
    assert.equal(FINDING_ID_SHAPE.test(id), true)
  }
  for (const id of ['', '../escape', 'x'.repeat(65), 'has.dot']) {
    assert.equal(FINDING_ID_SHAPE.test(id), false)
  }

  const result = await runScreenerPanel(
    { diff, acceptance, members: [members[0]], timeoutMs: 100 },
    seamsFor(() => [candidate('D1-unknown', { disposition: 'later' })]),
  )
  assert.deepEqual(result.proposals, [])
  assert.equal(result.reason, 'panel-incomplete')
  assert.equal(result.members[0].status, 'unanswered')

  const invalidId = await runScreenerPanel(
    { diff, acceptance, members: [members[0]], timeoutMs: 100 },
    seamsFor(() => [candidate('../escape')]),
  )
  assert.deepEqual(invalidId.proposals, [])
  assert.equal(invalidId.reason, 'panel-incomplete')
  assert.equal(invalidId.members[0].status, 'unanswered')
})

test('E1', async () => {
  const good = members[0]
  const base = { diff, acceptance, timeoutMs: 40 }
  const calls = [
    runScreenerPanel({ ...base, members: [] }, seamsFor(() => [candidate('E1-empty')])),
    runScreenerPanel({ ...base, members: [good] }),
    runScreenerPanel({ ...base, members: [good] }, seamsFor(() => { throw new Error('sync failure') })),
    runScreenerPanel({ ...base, members: [good] }, seamsFor(() => Promise.reject(new Error('endpoint unavailable')))),
    runScreenerPanel({ ...base, members: [good] }, seamsFor(() => ({}))),
    runScreenerPanel({ ...base, members: [good] }, seamsFor(() => [])),
    runScreenerPanel(
      { ...base, members: [good, members[1]] },
      seamsFor(({ axis }) => axis === good.axis
        ? [candidate('E1-partial')]
        : Promise.reject(new Error('one member failed'))),
    ),
  ]

  for (const call of calls) {
    let result
    await assert.doesNotReject(async () => { result = await call })
    assert.ok(SCREENER_REASONS.includes(result.reason))
    assert.deepEqual(result.proposals, [])
  }
  const empty = await runScreenerPanel({ ...base, members: [] }, seamsFor(() => [candidate('E1-empty-again')]))
  assert.deepEqual(empty, {
    proposals: [], reason: 'no-local-provider', answered: 0, asked: 0, members: [],
  })
})

test('F1', async () => {
  const fast = Object.freeze({ axis: 'correctness', provider: 'provider-fast', model: 'model-fast' })
  const slow = Object.freeze({ axis: 'scope', provider: 'provider-slow', model: 'model-slow' })
  const run = runScreenerPanel(
    { diff, acceptance, members: [fast, slow], timeoutMs: 25 },
    seamsFor(({ axis }) => axis === fast.axis ? [candidate('F1-fast')] : new Promise(() => {})),
  )
  const wall = new Promise((resolve) => setTimeout(() => resolve('wall-timeout'), 400))
  const result = await Promise.race([run, wall])
  assert.notEqual(result, 'wall-timeout')
  assert.equal(result.reason, 'panel-incomplete')
  assert.equal(result.proposals.length, 0)
  assert.equal(result.members.find(({ model }) => model === slow.model)?.status, 'unanswered')
  assert.equal(result.members.find(({ model }) => model === fast.model)?.status, 'answered')
})

test('G1', async () => {
  const complete = await completePanel()
  const incomplete = await runScreenerPanel(
    { diff, acceptance, members: [members[0], members[1]], timeoutMs: 100 },
    seamsFor(({ axis }) => axis === members[0].axis ? [candidate('G1-answer')] : []),
  )
  const empty = await runScreenerPanel({ diff, acceptance, members: [], timeoutMs: 100 }, seamsFor(() => []))
  for (const result of [complete, incomplete, empty]) {
    assert.equal(Number.isInteger(result.answered), true)
    assert.equal(Number.isInteger(result.asked), true)
    assert.equal(result.asked, result.members.length)
    assert.ok(result.answered >= 0 && result.answered <= result.asked)
  }
  assert.deepEqual([complete.answered, complete.asked], [members.length, members.length])
  assert.deepEqual([incomplete.answered, incomplete.asked], [1, 2])
  assert.deepEqual([empty.answered, empty.asked], [0, 0])
})

test('H1', async () => {
  const first = Object.freeze({ axis: 'correctness', provider: 'provider-one', model: 'model-one' })
  const second = Object.freeze({ axis: 'scope', provider: 'provider-two', model: 'model-two' })
  const result = await runScreenerPanel(
    { diff, acceptance, members: [first, second], timeoutMs: 100 },
    seamsFor(({ model }) => [candidate(`H1-${model}`, { model: 'spoofed-model', severity: 'should-fix' })]),
  )
  assert.equal(result.reason, null)
  assert.deepEqual(result.proposals.map(({ model }) => model), ['model-one', 'model-two'])
})
