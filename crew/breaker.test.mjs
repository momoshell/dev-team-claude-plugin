import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BREAKER_ENV, DEFAULT_BREAKER_WINDOW_MS, assertCellsClosed, breakerPolicy, cellHealth,
} from './breaker.mjs'
import { NODE_FLOOR } from '../scripts/factory/ledger.mjs'

const CELL = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }
const SEATS = { builder: { ...CELL } }
const NOW = Date.parse('2026-08-16T02:00:00.000Z')

function row(over = {}) {
  return {
    provider: CELL.provider, model_id: CELL.id, agent: CELL.agent, effort: CELL.effort,
    role: 'builder', kind: 'timeout', failures: 1,
    first_at: '2026-08-16T00:00:00.000Z', last_at: '2026-08-16T01:00:00.000Z', run_less: 0, synthetic: 0,
    ...over,
  }
}

function attempt(over = {}) {
  return {
    provider: CELL.provider, model_id: CELL.id, agent: CELL.agent, effort: CELL.effort,
    role: 'builder', attempts: 12,
    first_at: '2026-08-16T00:00:00.000Z', last_at: '2026-08-16T01:00:00.000Z',
    ...over,
  }
}

function attemptsForSeats(seats) {
  const cells = new Map()
  for (const [role, seat] of Object.entries(seats || {})) {
    if (seat?.provider == null || seat?.id == null) continue
    const key = [seat.provider, seat.id, seat.agent, seat.effort].join('\u001f')
    if (!cells.has(key)) cells.set(key, attempt({
      provider: seat.provider, model_id: seat.id, agent: seat.agent, effort: seat.effort, role,
    }))
  }
  return [...cells.values()]
}

function fakeLedger(rows, { attemptRows = [attempt()], degraded = false, mirrorErrors = 0, throwOnRead = null } = {}) {
  const calls = []
  const reads = []
  const attemptReads = []
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
      cellAttempts(options) {
        attemptReads.push(options)
        if (throwOnRead) throw new Error(throwOnRead)
        return attemptRows
      },
      stats() { return { mirror_errors: mirrorErrors } },
      close() { closes += 1 },
    }
  }
  open.calls = calls
  open.reads = reads
  open.attemptReads = attemptReads
  open.closes = () => closes
  return open
}

function health(rows, options = {}) {
  const seats = options.seats ?? SEATS
  const attemptRows = options.attemptRows ?? attemptsForSeats(seats)
  const openLedger = options.openLedger || fakeLedger(rows, { ...options, attemptRows })
  return {
    record: cellHealth({
      policy: { threshold_rate: options.threshold_rate ?? 0.1, window_ms: options.window_ms ?? 3600000 },
      seats,
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

test('breakerPolicy is absent when unset and honours threshold rate and window values', () => {
  assert.equal(breakerPolicy({}), null)
  assert.deepEqual(breakerPolicy({ [BREAKER_ENV.threshold]: '0.3' }), {
    threshold_rate: 0.3, window_ms: DEFAULT_BREAKER_WINDOW_MS,
  })
  assert.deepEqual(breakerPolicy({
    [BREAKER_ENV.threshold]: '0.3', [BREAKER_ENV.window_ms]: '900000',
  }), { threshold_rate: 0.3, window_ms: 900000 })
})

test('breakerPolicy rejects malformed or non-positive values naming the variable and value', () => {
  for (const value of ['0', '-1', 'two', '1.5', 'Infinity', 'NaN']) {
    assert.throws(
      () => breakerPolicy({ [BREAKER_ENV.threshold]: value }),
      (error) => error.message.includes(BREAKER_ENV.threshold) && error.message.includes(value),
    )
  }
  for (const value of ['0', 'x', '9007199254740992']) {
    assert.throws(
      () => breakerPolicy({ [BREAKER_ENV.threshold]: '0.2', [BREAKER_ENV.window_ms]: value }),
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
    policy: { threshold_rate: 0.2, window_ms: 1000 }, seats: null, dbPath: '/tmp/fake-ledger.db', openLedger, existsSync: () => true,
  })
  assert.equal(record.verdict, 'not-applicable')
  assert.equal(record.why, 'no roster cells (--roles boot)')
  assert.deepEqual(record.cells, [])
  assert.equal(openLedger.calls.length, 0)
})

test('cellHealth uses the rate edge: one short is closed and the threshold rate is open', () => {
  const under = health([row({ failures: 1 })], { threshold_rate: 0.1 }).record
  assert.equal(under.verdict, 'closed')
  assert.equal(under.cells[0].counted, 1)
  assert.equal(under.cells[0].rate, 1 / 12)

  const at = health([row({ failures: 2 })], { threshold_rate: 1 / 6 }).record
  assert.equal(at.verdict, 'open')
  assert.equal(at.cells[0].verdict, 'open')
})

test('cellHealth excludes run-less failures from opening while reporting them', () => {
  const onlyRunLess = health([row({ failures: 5, run_less: 5, kind: 'boot-refusal' })], { threshold_rate: 0.1 }).record
  assert.notEqual(onlyRunLess.verdict, 'open')
  assert.equal(onlyRunLess.cells[0].run_less, 5)
  assert.equal(onlyRunLess.cells[0].counted, 0)
  assert.equal(onlyRunLess.cells[0].by_kind['boot-refusal'], 0)

  const mixed = health([row({ failures: 5, run_less: 3 })], { threshold_rate: 0.1 }).record
  assert.equal(mixed.verdict, 'open')
  assert.equal(mixed.cells[0].counted, 2)
})

test('cellHealth excludes host-attributed failures while keeping genuine failures open', () => {
  const onlyHost = health([row({ failures: 3, host_attributed: 3 })], { threshold_rate: 0.1 }).record
  assert.equal(onlyHost.verdict, 'closed')
  assert.equal(onlyHost.cells[0].host_attributed, 3)
  assert.equal(onlyHost.cells[0].counted, 0)

  const genuine = health([row({ failures: 3, host_attributed: 0 })], { threshold_rate: 0.1 }).record
  assert.equal(genuine.verdict, 'open')
  assert.equal(genuine.cells[0].counted, 3)

  const mixed = health([row({ failures: 4, host_attributed: 1 })], { threshold_rate: 0.1 }).record
  assert.equal(mixed.verdict, 'open')
  assert.equal(mixed.cells[0].counted, 3)
  let refusal
  assert.doesNotThrow(() => assertCellsClosed(onlyHost))
  assert.throws(() => assertCellsClosed(mixed), (error) => {
    refusal = error
    return error.code === 'breaker-open'
  })
  assert.match(refusal.message, /host_attributed=1/)
})

test('synthetic-session failures do not raise the cell rate', () => {
  const record = health([row({ failures: 3, synthetic: 3 })], {
    threshold_rate: 0.2, attemptRows: [attempt({ attempts: 12 })],
  }).record
  assert.equal(record.cells[0].synthetic, 3)
  assert.equal(record.cells[0].numerator, 0)
  assert.equal(record.cells[0].rate, 0)
  assert.equal(record.cells[0].verdict, 'closed')
  assert.equal(record.verdict, 'closed')
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
  ], { seats, threshold_rate: 0.1 }).record
  assert.equal(record.verdict, 'open')
  assert.equal(record.cells.length, 4)
  const same = record.cells.find((cell) => cell.effort === 'max' && cell.agent === 'pi' && cell.provider === 'openai')
  assert.deepEqual(same.roles, ['builder', 'reviewer'])
  assert.equal(same.counted, 2)
  assert.equal(record.cells.filter((cell) => cell.verdict === 'closed').length, 3)
})

test('cellHealth ignores rows that do not match a seated cell', () => {
  const record = health([row({ model_id: 'gpt-not-seated', failures: 100 })], { threshold_rate: 0.1 }).record
  assert.equal(record.verdict, 'closed')
  assert.equal(record.cells[0].counted, 0)
})

test('cellHealth skips a null provider/id override even when a matching null row exists', () => {
  const seats = { builder: { ...CELL, provider: null, id: null } }
  const record = health([row({ provider: null, model_id: null, failures: 100 })], { seats, threshold_rate: 0.1 }).record
  assert.equal(record.verdict, 'closed')
  assert.deepEqual(record.cells, [])
})

test('cellHealth passes the same since and no until to both cell queries', () => {
  const openLedger = fakeLedger([row()])
  const record = health([row()], { openLedger, window_ms: 900000 }).record
  assert.equal(record.since, new Date(NOW - 900000).toISOString())
  assert.equal(openLedger.reads.length, 1)
  assert.equal(openLedger.reads[0].since, record.since)
  assert.equal(openLedger.reads[0].until, undefined)
  assert.equal(openLedger.attemptReads.length, 1)
  assert.deepEqual(openLedger.attemptReads[0], openLedger.reads[0])
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
      policy: { threshold_rate: 0.1, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/fake-ledger.db',
      now: () => NOW, openLedger, existsSync: () => true, nodeVersion: options.nodeVersion || '26.0.0',
    })
    assert.equal(record.verdict, 'unmeasurable')
    assert.ok(record.why)
  }
})

test('cellHealth treats an absent database as zero-denominator unmeasured evidence without opening it', () => {
  const openLedger = fakeLedger([])
  const record = cellHealth({
    policy: { threshold_rate: 0.1, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/missing-ledger.db',
    openLedger, existsSync: () => false, now: () => NOW,
  })
  assert.equal(record.verdict, 'unmeasured')
  assert.equal(record.cells[0].denominator, 0)
  assert.equal(record.cells[0].measured, false)
  assert.equal(record.cells[0].rate, null)
  assert.equal(openLedger.calls.length, 0)
})

test('assertCellsClosed ignores null and non-open verdicts, and describes open and unmeasurable refusals distinctly', () => {
  for (const verdict of [null, 'closed', 'unmeasured', 'not-applicable']) {
    assert.doesNotThrow(() => assertCellsClosed(verdict === null ? null : { verdict }))
  }
  const open = health([row({ kind: 'timeout', failures: 2 }), row({ kind: 'seat-not-ready', failures: 1 })], { threshold_rate: 0.1 }).record
  let openError
  assert.throws(() => assertCellsClosed(open), (error) => {
    openError = error
    return error.code === 'breaker-open'
  })
  for (const value of [CELL.provider, CELL.id, CELL.agent, CELL.effort, 'builder', 'timeout', 'seat-not-ready', open.since, 'rate=0.25', 'threshold_rate=0.1', 'numerator=3', 'denominator=12', 'synthetic=0', 'synthetic-session rows are excluded from the count', '--model-', '--agent-', '--tier']) {
    assert.ok(openError.message.includes(value), `open refusal omitted ${value}`)
  }

  const unmeasurable = cellHealth({
    policy: { threshold_rate: 0.1, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/unreadable.db',
    now: () => NOW, openLedger: () => { throw new Error('no access') }, existsSync: () => true,
  })
  let unreadableError
  assert.throws(() => assertCellsClosed(unmeasurable), (error) => {
    unreadableError = error
    return error.code === 'breaker-unmeasurable'
  })
  assert.notEqual(unreadableError.message, openError.message)
  assert.ok(unreadableError.message.includes('/tmp/unreadable.db'))
  assert.match(unreadableError.message, /rate.*numerator.*denominator/)
  assert.doesNotMatch(unreadableError.message, /by_kind|run-less rows are excluded/)
})

test('cellHealth closes a ledger handle even when cellFailures throws', () => {
  const openLedger = fakeLedger([], { throwOnRead: 'query failed' })
  const record = cellHealth({
    policy: { threshold_rate: 0.1, window_ms: 1000 }, seats: SEATS, dbPath: '/tmp/fake-ledger.db',
    openLedger, existsSync: () => true, now: () => NOW,
  })
  assert.equal(record.verdict, 'unmeasurable')
  assert.equal(openLedger.closes(), 1)
})

// kills: policy-empty-not-null — treats an empty threshold as malformed instead of no policy.
test('breakerPolicy treats an empty threshold as no policy at all', () => {
  assert.equal(breakerPolicy({ [BREAKER_ENV.threshold]: '' }), null)
})

// kills: version-lt-becomes-lte — treats a version exactly at NODE_FLOOR as below the floor.
// kills: version-equal-is-below — returns false for a version exactly equal to NODE_FLOOR.
// kills: version-unparseable-passes — lets an unparseable version pass the floor check.
test('cellHealth measures at exactly NODE_FLOOR and refuses an unparseable version', () => {
  const atFloor = health([], { nodeVersion: NODE_FLOOR }).record
  assert.notEqual(atFloor.verdict, 'unmeasurable')

  const unparseable = health([], { nodeVersion: 'not-a-version' }).record
  assert.equal(unparseable.verdict, 'unmeasurable')
  assert.ok(unparseable.why.includes(NODE_FLOOR))
})

// equivalent: version-gt-becomes-gte — versionAtLeast is only called with NODE_FLOOR = '24.0.0', whose minor and patch are both 0; returning early on an equal part can differ only when a later part is below a nonzero floor, which cannot happen here.
// equivalent: version-major-only — with NODE_FLOOR = '24.0.0', the minor and patch comparisons cannot change the answer, so comparing only the major part is equivalent until the floor gains a nonzero minor or patch.
test('cellHealth skips a seat missing either half of its cell identity', () => {
  // kills: seat-null-provider-admitted — admits a seat whose provider is null.
  const nullProvider = health(
    [row({ provider: null, failures: 100 })],
    { seats: { builder: { ...CELL, provider: null } } },
  ).record
  assert.equal(nullProvider.verdict, 'closed')
  assert.deepEqual(nullProvider.cells, [])

  // kills: seat-null-id-admitted — admits a seat whose id is null.
  const nullId = health(
    [row({ model_id: null, failures: 100 })],
    { seats: { builder: { ...CELL, id: null } } },
  ).record
  assert.equal(nullId.verdict, 'closed')
  assert.deepEqual(nullId.cells, [])
})

// kills: null-row-not-skipped — does not skip a null ledger row before reading its fields.
// kills: rows-not-array-guarded — iterates a non-array cellFailures result.
test('cellHealth survives a null row and a non-array cellFailures result', () => {
  let withNullRow
  assert.doesNotThrow(() => {
    withNullRow = health([null, row({ failures: 2 })]).record
  })
  assert.equal(withNullRow.verdict, 'open')

  let withUndefinedRows
  assert.doesNotThrow(() => {
    withUndefinedRows = health(undefined).record
  })
  assert.equal(withUndefinedRows.verdict, 'closed')
  assert.equal(withUndefinedRows.cells[0].counted, 0)
  assert.equal(withUndefinedRows.cells[0].host_attributed, 0)
})

// kills: counted-floor-removed — leaves a negative counted value when run_less exceeds failures.
// kills: number-value-not-guarded — retains a non-finite value instead of coercing it to zero.
test('cellHealth floors a negative count and ignores a non-numeric failure count', () => {
  const negative = health([row({ failures: 1, run_less: 3 })]).record
  assert.equal(negative.cells[0].counted, 0)

  const nonNumeric = health([row({ failures: 'lots', host_attributed: 'unknown' })]).record
  assert.equal(nonNumeric.cells[0].failures, 0)
  assert.equal(nonNumeric.cells[0].host_attributed, 0)
  assert.equal(nonNumeric.cells[0].counted, 0)

  const olderAggregate = health([row({ failures: 2, host_attributed: 'not-a-number' })], { threshold_rate: 0.1 }).record
  assert.equal(olderAggregate.cells[0].host_attributed, 0)
  assert.equal(olderAggregate.cells[0].counted, 2)
  assert.equal(olderAggregate.verdict, 'open')
})

// kills: cellkey-no-separator — concatenates cell identity fields without a separator.
test('cellHealth keeps cells distinct when their fields would concatenate alike', () => {
  const seats = {
    a: { provider: 'open', id: 'ai-x', agent: 'pi', effort: 'max' },
    b: { provider: 'openai', id: '-x', agent: 'pi', effort: 'max' },
  }
  const record = health([], { seats }).record
  assert.equal(record.cells.length, 2)
})

// kills: open-cells-not-filtered — includes non-open cells in an open refusal.
test('an open refusal names only the open cells', () => {
  const seats = {
    builder: { ...CELL },
    reviewer: { ...CELL, effort: 'medium' },
  }
  const record = health([
    row({ role: 'builder', failures: 2 }),
    row({ role: 'reviewer', effort: 'medium', failures: 1 }),
  ], { seats }).record
  let error
  assert.throws(() => assertCellsClosed(record), (caught) => {
    error = caught
    return caught.code === 'breaker-open'
  })
  assert.ok(error.message.includes('effort=max'))
  assert.doesNotMatch(error.message, /effort=medium/)
})

// kills: window-label-hours — omits the hour form from a refusal window label.
// kills: window-label-minutes — omits the minute form from a refusal window label.
test('an open refusal labels the window in hours, minutes, or milliseconds', () => {
  const refusal = (window_ms) => {
    const record = health([row({ failures: 2 })], { window_ms }).record
    let error
    assert.throws(() => assertCellsClosed(record), (caught) => {
      error = caught
      return caught.code === 'breaker-open'
    })
    return error.message
  }

  assert.match(refusal(3600000), /\(1h\)/)
  assert.match(refusal(900000), /\(15m\)/)
  assert.match(refusal(1000), /\(1000ms\)/)
})

// kills: cell-sort-dropped — leaves cells in seat insertion order.
// kills: roles-sort-dropped — leaves shared-cell roles in seat insertion order.
// kills: by-kind-sort-dropped — leaves by_kind keys in row insertion order.
test('cellHealth returns cells, roles, and by_kind in sorted order', () => {
  const seats = {
    zeta: { ...CELL, provider: 'openai' },
    alpha: { ...CELL, provider: 'openai' },
    beta: { ...CELL, provider: 'anthropic' },
  }
  const record = health([
    row({ role: 'zeta', kind: 'timeout', failures: 1 }),
    row({ role: 'alpha', kind: 'boot-refusal', failures: 1 }),
  ], { seats }).record
  assert.deepEqual(record.cells.map((cell) => cell.provider), ['anthropic', 'openai'])
  const shared = record.cells.find((cell) => cell.provider === 'openai')
  assert.deepEqual(shared.roles, ['alpha', 'zeta'])
  assert.deepEqual(Object.keys(shared.by_kind), ['boot-refusal', 'timeout'])
})

test('a cell opens on failure rate at the threshold', () => {
  const at = health([row({ failures: 1 })], {
    threshold_rate: 1 / 12, attemptRows: [attempt({ attempts: 12 })],
  }).record
  assert.equal(at.cells[0].numerator, 1)
  assert.equal(at.cells[0].denominator, 12)
  assert.equal(at.cells[0].rate, 1 / 12)
  assert.equal(at.cells[0].verdict, 'open')

  const below = health([row({ failures: 1 })], {
    threshold_rate: 1 / 12, attemptRows: [attempt({ attempts: 13 })],
  }).record
  assert.equal(below.cells[0].verdict, 'closed')
})

test('a busy healthy cell stays closed despite twelve failures', () => {
  const record = health([row({ failures: 12 })], {
    threshold_rate: 0.2, attemptRows: [attempt({ attempts: 120 })],
  }).record
  assert.equal(record.cells[0].numerator, 12)
  assert.equal(record.cells[0].denominator, 120)
  assert.equal(record.cells[0].rate, 0.1)
  assert.equal(record.verdict, 'closed')
})

test('a lightly-used broken cell opens at the sample floor', () => {
  const record = health([row({ failures: 11 })], {
    threshold_rate: 0.5, attemptRows: [attempt({ attempts: 12 })],
  }).record
  assert.equal(record.cells[0].denominator, 12)
  assert.equal(record.cells[0].rate, 11 / 12)
  assert.equal(record.verdict, 'open')
})

test('below-floor evidence is unmeasured rather than healthy', () => {
  const record = health([row({ failures: 1 })], {
    threshold_rate: 0.01, attemptRows: [attempt({ attempts: 11 })],
  }).record
  assert.equal(record.verdict, 'unmeasured')
  assert.equal(record.cells[0].measured, false)
  assert.equal(record.cells[0].rate, null)
  assert.match(record.cells[0].reason, /below sample floor/)
})

test('below-floor evidence does not open', () => {
  const record = health([row({ failures: 11 })], {
    threshold_rate: 0.01, attemptRows: [attempt({ attempts: 11 })],
  }).record
  assert.equal(record.cells[0].verdict, 'unmeasured')
  assert.equal(record.verdict, 'unmeasured')
  assert.doesNotThrow(() => assertCellsClosed(record))
})

test('failures without attempt rows remain explicitly unmeasured', () => {
  const record = health([row({ failures: 4 })], {
    threshold_rate: 0.01, attemptRows: [],
  }).record
  assert.equal(record.cells[0].numerator, 4)
  assert.equal(record.cells[0].denominator, 0)
  assert.equal(record.cells[0].measured, false)
  assert.equal(record.cells[0].rate, null)
  assert.equal(record.cells[0].verdict, 'unmeasured')
  assert.equal(record.verdict, 'unmeasured')
})

test('every cell verdict reports numerator and denominator', () => {
  const seats = {
    builder: { ...CELL },
    reviewer: { ...CELL, effort: 'medium' },
  }
  const record = health([row({ failures: 1 })], {
    seats,
    threshold_rate: 0.1,
    attemptRows: [attempt({ attempts: 12 }), attempt({ role: 'reviewer', effort: 'medium', attempts: 11 })],
  }).record
  assert.equal(record.cells.length, 2)
  for (const cell of record.cells) {
    assert.equal(typeof cell.numerator, 'number')
    assert.equal(typeof cell.denominator, 'number')
    assert.ok(Object.hasOwn(cell, 'rate'))
    assert.ok(Object.hasOwn(cell, 'measured'))
    assert.ok(Object.hasOwn(cell, 'reason'))
    assert.ok(Object.hasOwn(cell, 'verdict'))
  }
  assert.equal(record.cells.find((cell) => cell.effort === 'medium').measured, false)
})

test('an unconfigured breaker remains unmeasured', () => {
  const openLedger = fakeLedger([])
  const record = cellHealth({
    policy: breakerPolicy({ [BREAKER_ENV.threshold]: '' }), seats: SEATS,
    dbPath: '/tmp/fake-ledger.db', openLedger, existsSync: () => true,
  })
  assert.equal(record, null)
  assert.equal(openLedger.calls.length, 0)
})

// equivalent: assert-passthrough-closed-dropped — after the pass-through line, every verdict other than unmeasurable and open already returns, so removing the explicit closed check cannot change behavior.
// equivalent: assert-passthrough-degraded-dropped — after the pass-through line, every verdict other than unmeasurable and open already returns, so removing the explicit degraded check cannot change behavior.
// equivalent: assert-passthrough-na-dropped — after the pass-through line, every verdict other than unmeasurable and open already returns, so removing the explicit not-applicable check cannot change behavior.
// equivalent: assert-passthrough-whole-line-dropped — the whole pass-through line minus its !record half is redundant because the later verdict checks return for closed, degraded, and not-applicable; the !record half remains load-bearing.
