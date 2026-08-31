import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOAD_ENV, loadPolicy, hostLoad, assertHostQuiet, slotPolicy, withSuiteSlot } from './host-load.mjs'

test('loadPolicy is opt-in and strictly validates a positive finite threshold', () => {
  assert.deepEqual(LOAD_ENV, { threshold: 'CREW_LOAD_THRESHOLD' })
  assert.equal(loadPolicy({}), null)
  assert.equal(loadPolicy({ CREW_LOAD_THRESHOLD: '' }), null)
  assert.deepEqual(loadPolicy({ CREW_LOAD_THRESHOLD: '1.5' }), { threshold: 1.5 })
  for (const value of ['abc', '0', '-1', 'NaN', 'Infinity']) {
    assert.throws(() => loadPolicy({ CREW_LOAD_THRESHOLD: value }), (err) => {
      assert.match(err.message, /CREW_LOAD_THRESHOLD/)
      assert.match(err.message, new RegExp(value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
      return true
    })
  }
})

test('hostLoad measures only with a policy and uses a strict per-core threshold edge', () => {
  let loadCalls = 0
  let cpuCalls = 0
  const none = hostLoad({ policy: null, loadavg: () => { loadCalls += 1; return [1] }, cpus: () => { cpuCalls += 1; return [{}] } })
  assert.equal(none, null)
  assert.equal(loadCalls, 0)
  assert.equal(cpuCalls, 0)
  const quiet = hostLoad({ policy: { threshold: 2 }, loadavg: () => [4, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' })
  assert.deepEqual(quiet, {
    configured: true, threshold: 2, basis: 'os.loadavg()[0] / os.cpus().length',
    load_1m: 4, cores: 8, per_core: 0.5, verdict: 'quiet', why: null,
  })
  const edge = hostLoad({ policy: { threshold: 2 }, loadavg: () => [16, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' })
  assert.equal(edge.verdict, 'quiet')
  const saturated = hostLoad({ policy: { threshold: 2 }, loadavg: () => [291, 0, 0], cpus: () => new Array(10).fill({}), platform: 'darwin' })
  assert.equal(saturated.verdict, 'saturated')
  assert.equal(saturated.load_1m, 291)
  assert.equal(saturated.cores, 10)
})

test('every unmeasurable host-load mode refuses without inventing a measurement', () => {
  const cases = [
    { loadavg: () => { throw new Error('no loadavg') }, cpus: () => new Array(8).fill({}), platform: 'darwin' },
    { loadavg: () => [Number.NaN, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' },
    { loadavg: () => [1, 1, 1], cpus: () => { throw new Error('no cpus') }, platform: 'darwin' },
    { loadavg: () => [1, 1, 1], cpus: () => [], platform: 'darwin' },
    { loadavg: () => [0, 0, 0], cpus: () => new Array(8).fill({}), platform: 'win32' },
  ]
  const saturated = hostLoad({ policy: { threshold: 1 }, loadavg: () => [3, 0, 0], cpus: () => [{}], platform: 'darwin' })
  let saturatedMessage
  assert.throws(() => assertHostQuiet(saturated), (err) => { saturatedMessage = err.message; return err.code === 'host-load-open' })
  for (const deps of cases) {
    const record = hostLoad({ policy: { threshold: 1 }, ...deps })
    assert.equal(record.verdict, 'unmeasurable')
    assert.equal(record.load_1m, null)
    assert.equal(record.cores, null)
    assert.equal(record.per_core, null)
    assert.ok(record.why)
    assert.throws(() => assertHostQuiet(record), (err) => {
      assert.equal(err.code, 'host-load-unmeasurable')
      assert.notEqual(err.message, saturatedMessage)
      assert.doesNotMatch(err.message, /per core/)
      return true
    })
  }
})

test('saturated host refusal names measured load, basis, threshold, and remediation', () => {
  const quiet = hostLoad({ policy: { threshold: 2 }, loadavg: () => [1, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' })
  assert.doesNotThrow(() => assertHostQuiet(null))
  assert.doesNotThrow(() => assertHostQuiet(quiet))
  const hot = hostLoad({ policy: { threshold: 1.5 }, loadavg: () => [291, 0, 0], cpus: () => new Array(10).fill({}), platform: 'darwin' })
  assert.throws(() => assertHostQuiet(hot), (err) => {
    assert.equal(err.code, 'host-load-open')
    for (const value of ['291', '10', '1.5', 'CREW_LOAD_THRESHOLD', 'os.loadavg()[0] / os.cpus().length']) assert.ok(err.message.includes(value), `refusal omitted ${value}`)
    assert.match(err.message, /wait for the host|seat fewer roles|unset CREW_LOAD_THRESHOLD/)
    return true
  })
})

test('slotPolicy delegates capacity resolution and preserves its throw rule', () => {
  assert.equal(slotPolicy({ env: { CREW_SUITE_SLOTS: '0' }, cpus: () => new Array(48).fill({}) }), null)
  assert.deepEqual(slotPolicy({ env: { CREW_SUITE_SLOTS: '3' }, cpus: () => [] }), { capacity: 3 })
  assert.deepEqual(slotPolicy({ env: {}, cpus: () => new Array(17).fill({}) }), { capacity: 2 })
  assert.deepEqual(slotPolicy({ env: {}, cpus: () => new Array(48).fill({}) }), { capacity: 8 })
  for (const value of ['-1', 'abc']) {
    assert.throws(() => slotPolicy({ env: { CREW_SUITE_SLOTS: value }, cpus: () => [] }), (err) => {
      assert.match(err.message, /CREW_SUITE_SLOTS/)
      return true
    })
  }
})

test('withSuiteSlot acquires before running, releases after, and passes through the result', () => {
  const order = []
  const handle = { kind: 'suite', slot: 'suite-0', token: 'token', owner: 'owner' }
  const pool = {
    acquire: ({ owner }) => { order.push(`acquire:${owner}`); return { slot: 'suite-0', handle } },
    release: (released) => { order.push(`release:${released.token}`); return true },
  }
  const result = withSuiteSlot({
    owner: 'owner', root: '/tmp/factory', env: { CREW_SUITE_SLOTS: '1' },
    slots: () => pool, log: () => {},
  }, () => { order.push('run'); return 42 })
  assert.equal(result, 42)
  assert.deepEqual(order, ['acquire:owner', 'run', 'release:token'])
})

test('withSuiteSlot polls and logs the last completed depth', () => {
  const sleeps = []
  const logs = []
  let clock = 100
  let attempts = 0
  const pool = {
    acquire: () => {
      attempts += 1
      if (attempts <= 2) return { waiting: true, depth: 2 }
      return { slot: 'suite-0', handle: { kind: 'suite', slot: 'suite-0', token: 'token', owner: 'owner' } }
    },
    release: () => true,
  }
  const result = withSuiteSlot({
    owner: 'owner', root: '/tmp/factory', env: { CREW_SUITE_SLOTS: '1' },
    slots: () => pool, now: () => clock,
    sleep: (ms) => { sleeps.push(ms); clock += ms }, log: (line) => logs.push(line),
  }, () => 'done')
  assert.equal(result, 'done')
  assert.deepEqual(sleeps, [2000, 2000])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^suite slots: K=1, waited \d+s behind 2$/)
})

test('withSuiteSlot carries an unknown depth instead of flattening it to zero', () => {
  const logs = []
  let clock = 0
  let attempts = 0
  const pool = {
    acquire: () => {
      attempts += 1
      return attempts === 1
        ? { waiting: true, depth: null }
        : { slot: 'suite-0', handle: { kind: 'suite', slot: 'suite-0', token: 'token', owner: 'owner' } }
    },
    release: () => true,
  }
  withSuiteSlot({
    owner: 'owner', root: '/tmp/factory', env: { CREW_SUITE_SLOTS: '1' },
    slots: () => pool, now: () => clock, sleep: (ms) => { clock += ms }, log: (line) => logs.push(line),
  }, () => {})
  assert.equal(logs.length, 1)
  assert.match(logs[0], /behind unknown/)
  assert.doesNotMatch(logs[0], /behind 0/)
})

test('withSuiteSlot gives up at the ceiling and runs unslotted without releasing', () => {
  let clock = 0
  let releases = 0
  const logs = []
  const pool = {
    acquire: () => ({ waiting: true, depth: 1 }),
    release: () => { releases += 1 },
  }
  let runs = 0
  const result = withSuiteSlot({
    owner: 'owner', root: '/tmp/factory', env: { CREW_SUITE_SLOTS: '1' },
    slots: () => pool, now: () => clock,
    sleep: (ms) => { clock += ms }, ceiling: 2000, log: (line) => logs.push(line),
  }, () => { runs += 1; return 'unslotted' })
  assert.equal(result, 'unslotted')
  assert.equal(runs, 1)
  assert.equal(releases, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /and gave up/)
})

test('withSuiteSlot does nothing when suite slots are disabled', () => {
  let constructed = 0
  const logs = []
  const result = withSuiteSlot({
    owner: 'owner', root: '/tmp/factory', env: { CREW_SUITE_SLOTS: '0' },
    slots: () => { constructed += 1; throw new Error('pool must stay disabled') },
    log: (line) => logs.push(line),
  }, () => 'direct')
  assert.equal(result, 'direct')
  assert.equal(constructed, 0)
  assert.deepEqual(logs, [])
})
