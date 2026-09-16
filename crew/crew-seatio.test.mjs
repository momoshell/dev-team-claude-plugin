import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seatReadySignal, waitForEnvelope, WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE, seatLiveness } from './crew.mjs'
import { driveTask } from './drive.mjs'
import { cellFailureKind, paneAlive, paneProbe, seatIo, SEAT_REFUSAL_STAGE, SUBSTRATE_GRACE_MS, SUBSTRATE_MISSES_TO_DIE } from './seat-io.mjs'
import { scratchDir } from '../test/helpers.mjs'
import { callCounter } from './crew-test-helpers.mjs'

// Keep lexical import reach visible before byte-pinned regex test bodies.
void [test, assert, mkdtempSync, rmSync, mkdirSync, tmpdir, join, seatReadySignal, waitForEnvelope, WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE, seatLiveness, driveTask, cellFailureKind, paneAlive, paneProbe, seatIo, SEAT_REFUSAL_STAGE, SUBSTRATE_GRACE_MS, SUBSTRATE_MISSES_TO_DIE, scratchDir, callCounter]


test('seatLiveness reports headless and preserves pane probe values', () => {
  const probed = []
  const crew = { members: {
    lead: { surface_id: 'surface-lead' }, planner: { surface_id: 'surface-planner' }, builder: { surface_id: null },
  } }
  const alive = seatLiveness(crew, (surface) => { probed.push(surface); return surface === 'surface-lead' ? true : null })
  assert.deepEqual(alive, { lead: true, planner: null, builder: 'headless' })
  assert.deepEqual(probed, ['surface-lead', 'surface-planner'])
})

test('seatIo status and showDoc make no cmux calls without a workspace and status still works with one', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-seat-io-'))
  const paths = { dir: parent, taskDir: parent, returnsDir: join(parent, 'returns') }
  mkdirSync(paths.returnsDir, { recursive: true })
  const cmuxHeadless = callCounter()
  try {
    const headless = seatIo({ workspace_id: null, window_id: null, members: { builder: { surface_id: null } } }, paths, parent, null, null, {}, { cmux: cmuxHeadless, tree: () => ({ windows: [] }) })
    headless.status('build')
    headless.showDoc(join(parent, 'plan.md'))
    assert.equal(cmuxHeadless.calls.length, 0)

    const cmuxPanes = callCounter()
    const paned = seatIo({ workspace_id: 'workspace-1', window_id: 'window-1', members: { lead: { surface_id: 'surface-lead' } } }, paths, parent, null, null, {}, { cmux: cmuxPanes, tree: () => ({ windows: [] }) })
    paned.status('build')
    assert.equal(cmuxPanes.calls.length, 1)
    assert.equal(cmuxPanes.calls[0][0], 'set-status')
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('seatIo gateNow uses an injected clock and a finite default monotonic clock', () => {
  const parent = scratchDir('crew-gate-clock-')
  const paths = { dir: parent, taskDir: parent, returnsDir: join(parent, 'returns') }
  mkdirSync(paths.returnsDir, { recursive: true })
  try {
    const injected = seatIo({ workspace_id: null, window_id: null, members: {} }, paths, parent, null, null, {}, { gateNow: () => 17 })
    assert.equal(injected.gateNow(), 17)
    const fallback = seatIo({ workspace_id: null, window_id: null, members: {} }, paths, parent, null, null, {}, {})
    const first = fallback.gateNow()
    const second = fallback.gateNow()
    assert.equal(Number.isFinite(first), true)
    assert.equal(Number.isFinite(second), true)
    assert.ok(first > 0)
    assert.ok(second >= first)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('seatIo wait reports a dead substrate as a host transport failure and journals it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-substrate-wait-'))
  const paths = { dir: parent, taskDir: parent, returnsDir: join(parent, 'returns') }
  mkdirSync(paths.returnsDir, { recursive: true })
  let t = 0
  const events = []
  const journal = []
  try {
    const io = seatIo({
      workspace_id: 'workspace-1', window_id: 'window-1',
      members: { builder: { surface_id: 'surface-builder', transport: 'pane' } },
    }, paths, parent, null, null, {}, {
      now: () => t,
      sleep: (ms) => { t += ms },
      tree: () => { throw new Error('cmux unavailable') },
      locate: () => ({ id: 'surface-builder' }),
      sendLine: () => {},
      assignmentLine: () => 'assignment',
      cmux: () => ({ ok: false, stdout: '' }),
      logLine: (_path, row) => journal.push(row),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/brief.md' })
    assert.throws(() => io.wait(assignment.returnPath, 1200), (err) => err.stage === 'substrate-gone')
    const failures = events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    const failure = failures[0]
    assert.equal(failure.failure, 'transport-error')
    assert.equal(failure.stage, 'substrate-gone')
    assert.equal(failure.attribution, 'host')
    const row = journal.find((entry) => entry.substrate_gone === 'builder')
    assert.equal(row.substrate_gone, 'builder')
    assert.equal(row.returnPath, assignment.returnPath)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('seatReadySignal: ready-reply beats chrome, chrome is a real fallback, and the echoed brief never fakes a ready reply', () => {
  assert.equal(seatReadySignal('ready: builder', 'builder'), 'ready-reply')
  assert.equal(seatReadySignal('$0.000 (sub)  gpt-5.6-luna • high', 'builder'), 'chrome')
  assert.equal(seatReadySignal('  ⏵⏵ bypass permissions on', 'lead'), 'chrome')
  assert.equal(seatReadySignal('x@host ~/repo %\n', 'lead'), null)
  const brief = 'Crew for task demo. Task dir /tmp. Read your role in the system prompt, reply exactly ready: your-role, then wait.'
  assert.equal(seatReadySignal(brief, 'builder'), null)
})

test('waitForEnvelope returns an envelope after polling and times out for a live seat', () => {
  let t = 0
  const now = () => t
  const sleep = (ms) => { t += ms }
  let polls = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 60, role: 'builder',
    readEnvelope: () => (++polls >= 3 ? { status: 'done' } : null),
    probeSeat: () => true, now, sleep,
  })
  assert.deepEqual(env, { status: 'done' })
  t = 0
  assert.equal(waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 15, role: 'builder',
    readEnvelope: () => null, probeSeat: () => true, now, sleep,
  }), null)
})

test('waitForEnvelope fast-fails after consecutive gone probes, but indeterminate probes time out', () => {
  let t = 0
  const now = () => t
  const sleep = (ms) => { t += ms }
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => null, probeSeat: () => false, now, sleep,
  }), (err) => err.stage === 'seat-died' && /seat died: builder/.test(err.message) && t < 1200 * 1000)
  t = 0
  assert.equal(waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 60, role: 'builder',
    readEnvelope: () => null, probeSeat: () => null, now, sleep,
  }), null)
})

test('waitForEnvelope rethrows only a staged seat refusal and restarts only on its signal', () => {
  let clock = 0
  const refusal = Object.assign(new Error('seat refused: provider text'), { stage: SEAT_REFUSAL_STAGE })
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/refusal.json', timeoutS: 600, role: 'builder', readEnvelope: () => null,
    probeSeat: () => true, sampleSeat: () => { throw refusal }, now: () => clock, sleep: (ms) => { clock += ms },
  }), (err) => err === refusal)
  const run = (signal) => {
    let t = 0
    let calls = 0
    waitForEnvelope({
      returnPath: '/tmp/restart.json', timeoutS: 60, role: 'builder', readEnvelope: () => null,
      probeSeat: () => true, sampleSeat: () => (++calls === 1 ? signal : null), now: () => t,
      sleep: (ms) => { t += ms },
    })
    return t
  }
  const plain = run(null)
  assert.ok(run({ restartBudget: true }) > plain)
  assert.equal(run({ restartBudget: 'yes' }), plain)
})

test('waitForEnvelope extends a working seat once and accepts an envelope inside the extension', () => {
  let t = 0
  let classifications = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/extended.json', timeoutS: 100, role: 'planner',
    readEnvelope: () => (t >= 150_000 ? { status: 'done' } : null),
    probeSeat: () => true,
    classifyExpiry: (at) => {
      classifications += 1
      assert.equal(at, 100_000)
      return { state: 'working' }
    },
    now: () => t, sleep: (ms) => { t += ms },
  })
  assert.deepEqual(env, { status: 'done' })
  assert.equal(classifications, 1)
  assert.ok(t >= 150_000)
})

test('waitForEnvelope grants a working extension at most once', () => {
  let t = 0
  let classifications = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/extended-once.json', timeoutS: 100, role: 'planner',
    readEnvelope: () => null,
    probeSeat: () => true,
    classifyExpiry: () => { classifications += 1; return { state: 'working' } },
    now: () => t, sleep: (ms) => { t += ms },
  })
  assert.equal(env, null)
  assert.equal(t, 2 * 100_000)
  assert.equal(classifications, 1)
})

test('waitForEnvelope does not extend stale, retrying or unmeasured seats', () => {
  for (const classification of [{ state: 'stale' }, { state: 'retrying' }, null]) {
    let t = 0
    let classifications = 0
    const env = waitForEnvelope({
      returnPath: '/tmp/not-extended.json', timeoutS: 100, role: 'planner',
      readEnvelope: () => (t >= 150_000 ? { status: 'late' } : null),
      probeSeat: () => true,
      classifyExpiry: () => { classifications += 1; return classification },
      now: () => t, sleep: (ms) => { t += ms },
    })
    assert.equal(env, null)
    assert.equal(t, 100_000)
    assert.equal(classifications, 1)
  }
})

test('waitForEnvelope composes a restart budget with one working extension', () => {
  let t = 0
  let samples = 0
  let classifications = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/restart-extended.json', timeoutS: 100, role: 'planner',
    readEnvelope: () => null,
    probeSeat: () => true,
    sampleSeat: () => (++samples === 1 ? { restartBudget: true } : null),
    classifyExpiry: () => { classifications += 1; return { state: 'working' } },
    now: () => t, sleep: (ms) => { t += ms },
  })
  assert.equal(env, null)
  assert.equal(t, 230_000)
  assert.equal(classifications, 1)
  assert.ok(samples >= 1)
})

test('a staged refusal escapes driveTask with provider text intact for child escalation mapping', () => {
  const text = 'the provider says: prompt_cache_retention is not supported on this model'
  const refusal = Object.assign(new Error(text), { stage: SEAT_REFUSAL_STAGE, role: 'builder' })
  let gateRuns = 0
  const io = {
    readFile: (path) => path === '/tmp/brief.md'
      ? '```directed\n{"gate_cmd":"gate-cmd","files_in_scope":["crew/seat-io.mjs"]}\n```' : '',
    writeFile: () => {}, log: () => {}, status: () => {}, now: () => 0,
    assign: () => ({ id: 'd1', returnPath: '/tmp/refusal.json' }),
    wait: () => { throw refusal },
    run: (command) => {
      // a hand-built io has no `.calls`, so the census valve reads it as production and runs
      // the census; answer it like the gate rather than letting the gate record stand in
      if (String(command).includes('census-exhibits.mjs')) return { ok: true, output: '{"action":"none","verdict":"green","selected":[],"failures":[],"defects":[],"detail":null,"reason":null,"denominator":{"suites":0,"tests":0}}\n' }
      gateRuns += 1
      return gateRuns === 1
        ? { ok: false, output: 'red\nGATE-SUMMARY {"total":1,"failed":1,"errored":0}' }
        : { ok: true, output: 'GATE-SUMMARY {"total":1,"failed":0,"errored":0}' }
    },
    changedFiles: () => [],
  }
  assert.throws(() => driveTask({
    task: 'seat-refusal', briefFile: '/tmp/brief.md', taskDir: '/tmp/seat-refusal',
    checkout: '/tmp/repo', journal: '/tmp/seat-refusal/journal.jsonl',
    roles: ['builder', 'reviewer'], seatedRoles: ['builder', 'reviewer'], variant: 'directed',
    lane: 'lane-cmd', suite: 'suite-cmd', files_in_scope: ['crew/seat-io.mjs'],
  }, io), (err) => {
    assert.equal(err, refusal)
    assert.equal(err.stage, SEAT_REFUSAL_STAGE)
    assert.match(err.message, /prompt_cache_retention is not supported on this model/)
    const mapped = { escalation: { where: err.stage || 'child-preflight', why: err.message } }
    assert.equal(mapped.escalation.where, SEAT_REFUSAL_STAGE)
    assert.match(mapped.escalation.why, /provider says/)
    return true
  })
})

test('waitForEnvelope envelope wins at death time and liveness constants are integer exports', () => {
  let t = 0
  let probes = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => (probes >= LIVENESS_MISSES_TO_DIE ? { status: 'done' } : null),
    probeSeat: () => { probes += 1; return false }, now: () => t, sleep: (ms) => { t += ms },
  })
  assert.deepEqual(env, { status: 'done' })
  assert.equal(probes, LIVENESS_MISSES_TO_DIE)
  for (const value of [WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE]) assert.equal(Number.isInteger(value), true)
})

test('waitForEnvelope fails a waiting seat with substrate-gone when the pane manager stops answering', () => {
  let t = 0
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => null,
    probeSeat: () => ({ alive: null, substrate: 'down' }),
    now: () => t, sleep: (ms) => { t += ms },
  }), (err) => {
    assert.equal(err.stage, 'substrate-gone')
    assert.doesNotMatch(err.message, /seat died/)
    assert.equal(err.role, 'builder')
    assert.ok(t < 1200 * 1000)
    return true
  })
})

test('waitForEnvelope: a null seat probe while the substrate answers is never death', () => {
  const run = (probe) => {
    let t = 0
    return waitForEnvelope({
      returnPath: '/tmp/return.json', timeoutS: 120, role: 'builder',
      readEnvelope: () => null, probeSeat: probe,
      now: () => t, sleep: (ms) => { t += ms },
    })
  }
  assert.equal(run(() => ({ alive: null, substrate: 'ok' })), null)
  let t = 0
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => null, probeSeat: () => ({ alive: false, substrate: 'ok' }),
    now: () => t, sleep: (ms) => { t += ms },
  }), (err) => err.stage === 'seat-died')
})

test('waitForEnvelope requires consecutive substrate misses and resets when the substrate answers', () => {
  let t = 0
  const sequence = [
    { alive: null, substrate: 'down' },
    { alive: null, substrate: 'ok' },
    { alive: null, substrate: 'down' },
  ]
  assert.equal(waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 120, role: 'builder',
    readEnvelope: () => null,
    probeSeat: () => sequence.shift() || { alive: null, substrate: 'ok' },
    now: () => t, sleep: (ms) => { t += ms },
  }), null)

  t = 0
  let probes = 0
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => null,
    probeSeat: () => { probes += 1; return { alive: null, substrate: 'down' } },
    now: () => t, sleep: (ms) => { t += ms },
  }), (err) => err.stage === 'substrate-gone')
  assert.equal(probes, SUBSTRATE_MISSES_TO_DIE)
  assert.ok(SUBSTRATE_MISSES_TO_DIE >= 2)
})

test('waitForEnvelope re-reads an envelope before throwing substrate-gone', () => {
  let t = 0
  let probes = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => (probes >= SUBSTRATE_MISSES_TO_DIE ? { status: 'done' } : null),
    probeSeat: () => { probes += 1; return { alive: null, substrate: 'down' } },
    now: () => t, sleep: (ms) => { t += ms },
  })
  assert.deepEqual(env, { status: 'done' })
  assert.equal(probes, SUBSTRATE_MISSES_TO_DIE)
})

test('waitForEnvelope outlives the measured 13-minute substrate outage', () => {
  let t = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1800, role: 'builder',
    readEnvelope: () => t >= 780_000 ? { status: 'done' } : null,
    probeSeat: () => t < 780_000 ? { alive: null, substrate: 'down' } : { alive: true, substrate: 'ok' },
    now: () => t, sleep: (ms) => { t += ms },
  })
  assert.deepEqual(env, { status: 'done' })
  assert.ok(SUBSTRATE_GRACE_MS >= 780_000)
  assert.equal(SUBSTRATE_MISSES_TO_DIE, Math.ceil(SUBSTRATE_GRACE_MS / LIVENESS_PROBE_MS))
})

test('waitForEnvelope never sums two separate substrate outages', () => {
  const outage = SUBSTRATE_MISSES_TO_DIE
  const envelopeAt = 2 * outage * LIVENESS_PROBE_MS
  let t = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: envelopeAt / 1000 + 120, role: 'builder',
    readEnvelope: () => t >= envelopeAt ? { status: 'done' } : null,
    probeSeat: () => Math.round(t / LIVENESS_PROBE_MS) === outage
      ? { alive: null, substrate: 'ok' } : { alive: null, substrate: 'down' },
    now: () => t, sleep: (ms) => { t += ms },
  })
  assert.deepEqual(env, { status: 'done' })
})

test('waitForEnvelope still terminates a genuinely dead substrate as substrate-gone', () => {
  let t = 0
  let probes = 0
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 7200, role: 'builder',
    readEnvelope: () => null,
    probeSeat: () => { probes += 1; return { alive: null, substrate: 'down' } },
    now: () => t, sleep: (ms) => { t += ms },
  }), (err) => {
    assert.equal(err.stage, 'substrate-gone')
    assert.equal(err.role, 'builder')
    assert.equal(cellFailureKind(err), 'transport-error')
    assert.notEqual(cellFailureKind(err), 'seat-died')
    assert.equal(t, SUBSTRATE_MISSES_TO_DIE * LIVENESS_PROBE_MS)
    return true
  })
  assert.equal(probes, SUBSTRATE_MISSES_TO_DIE)
})

test('waitForEnvelope reports substrate outage edges to its caller', () => {
  let t = 0
  const records = []
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => t >= 6 * LIVENESS_PROBE_MS ? { status: 'done' } : null,
    probeSeat: () => {
      const index = Math.round(t / LIVENESS_PROBE_MS)
      return index >= 1 && index <= 3 ? { alive: null, substrate: 'down' } : { alive: true, substrate: 'ok' }
    },
    onSubstrate: (record) => records.push(record),
    now: () => t, sleep: (ms) => { t += ms },
  })
  assert.deepEqual(env, { status: 'done' })
  assert.equal(records.filter((record) => record.state === 'down').length, 1)
  assert.equal(records.filter((record) => record.state === 'ok').length, 1)
  assert.deepEqual(records[0], { at: LIVENESS_PROBE_MS, state: 'down', misses: 1, graceMs: SUBSTRATE_GRACE_MS })
  assert.deepEqual(records[1], { at: 4 * LIVENESS_PROBE_MS, state: 'ok', misses: 3, graceMs: SUBSTRATE_GRACE_MS })

  t = 0
  const healthy = []
  assert.equal(waitForEnvelope({
    returnPath: '/tmp/healthy.json', timeoutS: 120, role: 'builder', readEnvelope: () => null,
    probeSeat: () => ({ alive: true, substrate: 'ok' }), onSubstrate: (record) => healthy.push(record),
    now: () => t, sleep: (ms) => { t += ms },
  }), null)
  assert.deepEqual(healthy, [])
})

test('waitForEnvelope keeps the liveness axis bound to two misses', () => {
  let t = 0
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 7200, role: 'builder', readEnvelope: () => null,
    probeSeat: () => ({ alive: false, substrate: 'ok' }),
    now: () => t, sleep: (ms) => { t += ms },
  }), (err) => {
    assert.equal(err.stage, 'seat-died')
    assert.equal(t, 2 * LIVENESS_PROBE_MS)
    return true
  })
  assert.equal(LIVENESS_MISSES_TO_DIE, 2)
})

test('waitForEnvelope keeps legacy tri-state probes unchanged', () => {
  const run = (probe, timeoutS = 120) => {
    let t = 0
    return waitForEnvelope({
      returnPath: '/tmp/return.json', timeoutS, role: 'builder',
      readEnvelope: () => null, probeSeat: probe,
      now: () => t, sleep: (ms) => { t += ms },
    })
  }
  assert.equal(run(() => null), null)
  assert.equal(run(() => true), null)
  let t = 0
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => null, probeSeat: () => false,
    now: () => t, sleep: (ms) => { t += ms },
  }), (err) => {
    assert.equal(err.stage, 'seat-died')
    assert.equal(err.message, `seat died: builder — its pane is gone (${LIVENESS_MISSES_TO_DIE} consecutive liveness probes) and no envelope arrived at /tmp/return.json`)
    return true
  })
})

test('paneProbe separates substrate and seat outcomes while paneAlive keeps its tri-state', () => {
  const locatedTree = () => ({ windows: [{ id: 'window-1' }] })
  const locate = (_tree, id) => id === 'surface-1' ? { id } : null
  const cases = [
    [{ tree: () => { throw new Error('cmux unavailable') }, locate }, { alive: null, substrate: 'down' }, null],
    [{ tree: () => ({}), locate }, { alive: null, substrate: 'down' }, null],
    [{ tree: locatedTree, locate }, { alive: true, substrate: 'ok' }, true],
    [{ tree: locatedTree, locate: (_tree, _id) => null }, { alive: false, substrate: 'ok' }, false],
    [{ tree: locatedTree, locate: () => { throw new Error('locate interrupted') } }, { alive: null, substrate: 'ok' }, null],
  ]
  for (const [deps, expected, alive] of cases) {
    assert.deepEqual(paneProbe('surface-1', deps), expected)
    assert.equal(paneAlive('surface-1', deps), alive)
  }
})

test('cellFailureKind keeps substrate-gone on the transport axis', () => {
  assert.equal(cellFailureKind({ stage: 'substrate-gone' }), 'transport-error')
  assert.notEqual(cellFailureKind({ stage: 'substrate-gone' }), 'seat-died')
})
