import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BREAKER_ENV, DEFAULT_BREAKER_WINDOW_MS, assertCellsClosed, breakerPolicy, cellHealth,
} from './breaker.mjs'

const CELL = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }
const SEATS = { builder: { ...CELL } }
const NOW = Date.parse('2026-08-16T02:00:00.000Z')

function row(over = {}) {
  return {
    provider: CELL.provider, model_id: CELL.id, agent: CELL.agent, effort: CELL.effort,
    role: 'builder', kind: 'timeout', failures: 1,
    first_at: '2026-08-16T00:00:00.000Z', last_at: '2026-08-16T01:00:00.000Z', run_less: 0,
    ...over,
  }
}

function fakeLedger(rows, { degraded = false, mirrorErrors = 0, throwOnRead = null } = {}) {
  const calls = []
  const reads = []
  let closes = 0
  const open = (options) => {
    calls.push(options)
    return {
      get degraded() { return degraded },
      cellFailures(options) {
        reads.push(options)
        if (throwOnRead) throw new Error(throwOnRead)
        return rows
      },
      stats() { return { mirror_errors: mirrorErrors } },
      close() { closes += 1 },
    }
  }
  open.calls = calls
  open.reads = reads
  open.closes = () => closes
  return open
}

function health(rows, options = {}) {
  const openLedger = options.openLedger || fakeLedger(rows, options)
  return {
    record: cellHealth({
      policy: { threshold: options.threshold ?? 2, window_ms: options.window_ms ?? 3600000 },
      seats: options.seats ?? SEATS,
      dbPath: options.dbPath ?? '/tmp/fake-ledger.db',
      now: () => NOW,
      openLedger,
      existsSync: options.existsSync || (() => true),
      nodeVersion: options.nodeVersion ?? '26.0.0',
      stderr: { write() {} },
    }),
    openLedger,
  }
}

test('breakerPolicy is absent when unset and honours threshold and window values', () => {
  assert.equal(breakerPolicy({}), null)
  assert.deepEqual(breakerPolicy({ [BREAKER_ENV.threshold]: '3' }), {
    threshold: 3, window_ms: DEFAULT_BREAKER_WINDOW_MS,
  })
  assert.deepEqual(breakerPolicy({
    [BREAKER_ENV.threshold]: '3', [BREAKER_ENV.window_ms]: '900000',
  }), { threshold: 3, window_ms: 900000 })
})

test('breakerPolicy rejects malformed or non-positive values naming the variable and value', () => {
  for (const value of ['0', '-1', 'two', '1.5']) {
    assert.throws(
      () => breakerPolicy({ [BREAKER_ENV.threshold]: value }),
      (error) => error.message.includes(BREAKER_ENV.threshold) && error.message.includes(value),
    )
  }
  for (const value of ['0', 'x', '9007199254740992']) {
    assert.throws(
      () => breakerPolicy({ [BREAKER_ENV.threshold]: '2', [BREAKER_ENV.window_ms]: value }),
      (error) => error.message.includes(BREAKER_ENV.window_ms) && error.message.includes(value),
    )
  }
})

test('cellHealth with a null policy returns null without opening the ledger', () => {
  const openLedger = fakeLedger([])
  const record = cellHealth({
    policy: null, seats: SEATS, dbPath: '/tmp/fake-ledger.db', openLedger, existsSync: () => true,
  })
  assert.equal(record, null)
  assert.equal(openLedger.calls.length, 0)
})

test('cellHealth marks a roles-only boot not-applicable without opening the ledger', () => {
  const openLedger = fakeLedger([])
  const record = cellHealth({
    policy: { threshold: 2, window_ms: 1000 }, seats: null, dbPath: '/tmp/fake-ledger.db', openLedger, existsSync: () => true,
  })
  assert.equal(record.verdict, 'not-applicable')
  assert.equal(record.why, 'no roster cells (--roles boot)')
  assert.deepEqual(record.cells, [])
  assert.equal(openLedger.calls.length, 0)
})

test('cellHealth uses the threshold edge: one short is degraded and exactly threshold is open', () => {
  const under = health([row({ failures: 1 })], { threshold: 2 }).record
  assert.equal(under.verdict, 'degraded')
  assert.equal(under.cells[0].counted, 1)

  const at = health([row({ failures: 2 })], { threshold: 2 }).record
  assert.equal(at.verdict, 'open')
  assert.equal(at.cells[0].verdict, 'open')
})

test('cellHealth excludes run-less failures from opening while reporting them', () => {
  const onlyRunLess = health([row({ failures: 5, run_less: 5, kind: 'boot-refusal' })], { threshold: 2 }).record
  assert.notEqual(onlyRunLess.verdict, 'open')
  assert.equal(onlyRunLess.cells[0].run_less, 5)
  assert.equal(onlyRunLess.cells[0].counted, 0)
  assert.equal(onlyRunLess.cells[0].by_kind['boot-refusal'], 0)

  const mixed = health([row({ failures: 5, run_less: 3 })], { threshold: 2 }).record
  assert.equal(mixed.verdict, 'open')
  assert.equal(mixed.cells[0].counted, 2)
})

test('cellHealth groups rows by provider/model/agent/effort, not role', () => {
  const seats = {
    builder: { ...CELL }, reviewer: { ...CELL },
    planner: { ...CELL, effort: 'medium' },
    lead: { ...CELL, agent: 'claude' },
    tech: { ...CELL, provider: 'anthropic' },
  }
  const record = health([
    row({ role: 'builder', failures: 1 }),
    row({ role: 'reviewer', failures: 1 }),
    row({ role: 'planner', effort: 'medium', failures: 1 }),
    row({ role: 'lead', agent: 'claude', failures: 1 }),
    row({ role: 'tech', provider: 'anthropic', failures: 1 }),
  ], { seats, threshold: 2 }).record
  assert.equal(record.verdict, 'open')
  assert.equal(record.cells.length, 4)
  const same = record.cells.find((cell) => cell.effort === 'max' && cell.agent === 'pi' && cell.provider === 'openai')
  assert.deepEqual(same.roles, ['builder', 'reviewer'])
  assert.equal(same.counted, 2)
  assert.equal(record.cells.filter((cell) => cell.verdict === 'degraded').length, 3)
})

test('cellHealth ignores rows that do not match a seated cell', () => {
  const record = health([row({ model_id: 'gpt-not-seated', failures: 100 })], { threshold: 2 }).record
  assert.equal(record.verdict, 'closed')
  assert.equal(record.cells[0].counted, 0)
})

test('cellHealth skips a null provider/id override even when a matching null row exists', () => {
  const seats = { builder: { ...CELL, provider: null, id: null } }
  const record = health([row({ provider: null, model_id: null, failures: 100 })], { seats, threshold: 2 }).record
  assert.equal(record.verdict, 'closed')
  assert.deepEqual(record.cells, [])
})

test('cellHealth passes since and no until to cellFailures', () => {
  const openLedger = fakeLedger([row()])
  const record = health([row()], { openLedger, window_ms: 900000 }).record
  assert.equal(record.since, new Date(NOW - 900000).toISOString())
  assert.equal(openLedger.reads.length, 1)
  assert.equal(openLedger.reads[0].since, record.since)
  assert.equal(openLedger.reads[0].until, undefined)
})

test('cellHealth reports every unreadable-ledger mode as unmeasurable', () => {
  const cases = [
    { nodeVersion: '20.0.0' },
    { openLedger: () => { throw new Error('open failed') } },
    { degraded: true },
    { mirrorErrors: 1 },
  ]
  for (const options of cases) {
    const openLedger = options.openLedger || fakeLedger([], options)
    const record = cellHealth({
      policy: { threshold: 2, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/fake-ledger.db',
      now: () => NOW, openLedger, existsSync: () => true, nodeVersion: options.nodeVersion || '26.0.0',
    })
    assert.equal(record.verdict, 'unmeasurable')
    assert.ok(record.why)
  }
})

test('cellHealth treats an absent database as a fresh closed ledger without opening it', () => {
  const openLedger = fakeLedger([])
  const record = cellHealth({
    policy: { threshold: 2, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/missing-ledger.db',
    openLedger, existsSync: () => false, now: () => NOW,
  })
  assert.equal(record.verdict, 'closed')
  assert.equal(openLedger.calls.length, 0)
})

test('assertCellsClosed ignores null and non-open verdicts, and describes open and unmeasurable refusals distinctly', () => {
  for (const verdict of [null, 'closed', 'degraded', 'not-applicable']) {
    assert.doesNotThrow(() => assertCellsClosed(verdict === null ? null : { verdict }))
  }
  const open = health([row({ kind: 'timeout', failures: 2 }), row({ kind: 'seat-not-ready', failures: 1 })], { threshold: 2 }).record
  let openError
  assert.throws(() => assertCellsClosed(open), (error) => {
    openError = error
    return error.code === 'breaker-open'
  })
  for (const value of [CELL.provider, CELL.id, CELL.agent, CELL.effort, 'builder', 'timeout', 'seat-not-ready', open.since, '--model-', '--agent-', '--tier']) {
    assert.ok(openError.message.includes(value), `open refusal omitted ${value}`)
  }

  const unmeasurable = cellHealth({
    policy: { threshold: 2, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/unreadable.db',
    now: () => NOW, openLedger: () => { throw new Error('no access') }, existsSync: () => true,
  })
  let unreadableError
  assert.throws(() => assertCellsClosed(unmeasurable), (error) => {
    unreadableError = error
    return error.code === 'breaker-unmeasurable'
  })
  assert.notEqual(unreadableError.message, openError.message)
  assert.ok(unreadableError.message.includes('/tmp/unreadable.db'))
  assert.doesNotMatch(unreadableError.message, /by_kind|run-less rows are excluded/)
})

test('cellHealth closes a ledger handle even when cellFailures throws', () => {
  const openLedger = fakeLedger([], { throwOnRead: 'query failed' })
  const record = cellHealth({
    policy: { threshold: 2, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/fake-ledger.db',
    openLedger, existsSync: () => true, now: () => NOW,
  })
  assert.equal(record.verdict, 'unmeasurable')
  assert.equal(openLedger.closes(), 1)
})
