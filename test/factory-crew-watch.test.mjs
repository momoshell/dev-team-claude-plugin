import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EVENTS,
  KEYED_EVENTS,
  PENDING_BOUND_S,
  WATCHDOG_INTERVAL_S,
  boundedReport,
  createState,
  formatEvent,
  follow,
  lineLabels,
  main,
  orphaned,
  parseArgs,
  resolveLane,
  selectEvent,
  tick,
  watchdogLine,
} from '../scripts/factory/crew-watch.mjs'
import { discoverLanes, watchPass } from '../scripts/factory/lane-watch.mjs'
import { makeSeedLane } from './helpers.mjs'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-crew-watch-'))
const NOW = Date.parse('2026-08-19T18:00:00.000Z')
const seedLane = makeSeedLane(NOW)
let worldNumber = 0

const QUIET = {
  loadavg: () => [1, 1, 1],
  cpus: () => new Array(10).fill({ model: 'test' }),
  platform: 'darwin',
}

function world() {
  const root = join(fixtureRoot, `world-${++worldNumber}`)
  mkdirSync(root, { recursive: true })
  return root
}

function deps(now = NOW, extra = {}) {
  return { ...QUIET, now: () => now, ppid: () => 777, ...extra }
}

function journalObjects(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

test('orphaned is pure and only reports an integer ppid change', () => {
  assert.equal(orphaned(7, 7), false)
  assert.equal(orphaned(7, 8), true)
  assert.equal(orphaned(7, undefined), false)
  assert.equal(orphaned(undefined, 8), false)
  assert.equal(orphaned('7', 8), false)
})

test('tick flushes a tail before stopping when its parent changes', () => {
  const root = world()
  seedLane(root, { journalLines: [{ at: NOW - 5_000, stage: 'plan:r1' }] })
  const state = createState({ root, names: ['demo-lane'], bootPpid: 777, deps: deps() })
  const result = tick(state, deps(NOW, { ppid: () => 1 }))
  assert.equal(result.stop, true)
  assert.equal(result.reason, 'orphaned')
  assert.equal(result.lines.length, 1)
  assert.match(result.lines[0], /\[demo-lane\].*plan:r1/)
})

test('bounded report shows active and settled lane status', () => {
  const root = world()
  seedLane(root, { task: 'live', journalLines: [{ at: NOW - 5_000, stage: 'build:r1' }] })
  seedLane(root, { task: 'finished', settled: true, journalLines: [{ at: NOW - 8_000, stage: 'done' }] })
  const report = boundedReport({ root, names: ['live', 'finished'], now: NOW, deps: deps() })
  assert.deepEqual(report.lines, [
    '[live] stage=build:r1 age=5s status=active',
    '[finished] stage=done age=8s status=settled',
  ])
})

test('boundedReport tells a retrying seat from a stale one and from a working one', () => {
  const root = world()
  seedLane(root, {
    task: 'retrying',
    journalLines: [
      { at: NOW - 20_000, stage: 'build:r1' },
      { at: NOW - 12_000, event: 'seat-retrying', id: 'd1', role: 'builder' },
    ],
  })
  seedLane(root, {
    task: 'stale',
    journalLines: [
      { at: NOW - 20_000, stage: 'build:r1' },
      { at: NOW - 11_000, event: 'seat-stale', id: 'd2', role: 'builder' },
    ],
  })
  seedLane(root, { task: 'working', journalLines: [{ at: NOW - 5_000, stage: 'build:r1' }] })
  seedLane(root, {
    task: 'cleared',
    journalLines: [
      { at: NOW - 10_000, stage: 'build:r1' },
      { at: NOW - 8_000, event: 'seat-retrying', id: 'd4', role: 'builder' },
      { at: NOW - 2_000, event: 'seat-retry-cleared', id: 'd4', role: 'builder' },
    ],
  })
  const report = boundedReport({ root, names: ['retrying', 'stale', 'working', 'cleared'], now: NOW, deps: deps() })
  assert.deepEqual(report.lines, [
    '[retrying] stage=build:r1 age=12s status=retrying seen=12s',
    '[stale] stage=build:r1 age=11s status=stale seen=11s',
    '[working] stage=build:r1 age=5s status=active',
    '[cleared] stage=build:r1 age=2s status=active',
  ])
})

test('a condition is scoped to its dispatch and retrying outranks stale on one tick', () => {
  const sameTickRoot = world()
  seedLane(sameTickRoot, {
    task: 'same-tick',
    journalLines: [
      { at: NOW - 10_000, stage: 'build:r1' },
      { at: NOW - 5_000, event: 'seat-retrying', id: 'd1', role: 'builder' },
      { at: NOW - 5_000, event: 'seat-stale', id: 'd1', role: 'builder' },
    ],
  })
  assert.match(boundedReport({ root: sameTickRoot, names: ['same-tick'], now: NOW, deps: deps() }).lines[0], /status=retrying seen=5s/)

  const scopedRoot = world()
  seedLane(scopedRoot, {
    task: 'scoped',
    journalLines: [
      { at: NOW - 10_000, stage: 'build:r1' },
      { at: NOW - 9_000, event: 'seat-stale', id: 'd2', role: 'builder' },
      { at: NOW - 2_000, event: 'seat-stale-cleared', id: 'd1', role: 'lead' },
    ],
  })
  assert.match(boundedReport({ root: scopedRoot, names: ['scoped'], now: NOW, deps: deps() }).lines[0], /status=stale seen=9s/)

  const recoveredRoot = world()
  seedLane(recoveredRoot, {
    task: 'recovered',
    journalLines: [
      { at: NOW - 10_000, stage: 'build:r1' },
      { at: NOW - 8_000, event: 'seat-stale', id: 'd3', role: 'builder' },
      { at: NOW - 3_000, event: 'seat-stale-cleared', id: 'd3', role: 'builder' },
    ],
  })
  assert.equal(boundedReport({ root: recoveredRoot, names: ['recovered'], now: NOW, deps: deps() }).lines[0], '[recovered] stage=build:r1 age=3s status=active')
})

test('retry transitions are selected through both default event construction paths', () => {
  assert.equal(selectEvent({ event: 'seat-retrying' }, DEFAULT_EVENTS), true)
  const parsed = parseArgs(['demo-lane'])
  assert.equal(parsed.events.includes('seat-retrying'), true)
  assert.equal(parsed.events.includes('seat-retry-cleared'), true)
  const state = createState({ root: world(), names: ['demo-lane'] })
  assert.equal(state.events.includes('seat-retrying'), true)
  assert.equal(state.events.includes('seat-retry-cleared'), true)
})

test('--all reports live lanes only', () => {
  const root = world()
  seedLane(root, { task: 'live', journalLines: [{ at: NOW - 5_000, stage: 'build:r1' }] })
  seedLane(root, {
    task: 'demo-lane.archive-2026-08-20T23-25-28-377Z',
    journalLines: [{ at: NOW - 700_000, stage: 'build:r2' }],
  })

  const report = boundedReport({ root, all: true, now: NOW, deps: deps() })
  assert.deepEqual(report.lines, ['[live] stage=build:r1 age=5s status=active'])
})

test('a named lane that has been archived reports archived, never pending', () => {
  const root = world()
  seedLane(root, {
    task: 'demo-lane.archive-2026-08-20T23-25-28-377Z',
    journalLines: [{ at: NOW - 700_000, stage: 'build:r2' }],
  })

  const report = boundedReport({ root, names: ['demo-lane', 'never-booted'], now: NOW, deps: deps() })
  assert.deepEqual(report.lines, [
    '[demo-lane] stage=build:r2 age=700s status=archived',
    '[never-booted] stage=none age=none status=pending',
  ])
})

test('a pending lane is rediscovered after its directory appears', () => {
  const root = world()
  const state = createState({ root, names: ['not-yet'], bootPpid: 777, deps: deps() })
  const first = tick(state, deps())
  assert.deepEqual(first.lines, [])
  assert.deepEqual(boundedReport({ root, names: ['not-yet'], now: NOW, deps: deps() }).lines, [
    '[not-yet] stage=none age=none status=pending',
  ])
  seedLane(root, { task: 'not-yet', journalLines: [{ at: NOW, event: 'seat-teardown' }] })
  const second = tick(state, deps())
  assert.equal(second.stop, false)
  assert.equal(second.lines.length, 1)
  assert.match(second.lines[0], /\[not-yet\].*seat-teardown/)
})

test('a lane armed before it boots still waits and then follows it', () => {
  const root = world()
  const now = NOW
  const d = { ...QUIET, ppid: () => 777, now: () => now }
  const state = createState({ root, names: ['not-yet'], watchdog: false, bootPpid: 777, deps: d })
  const first = tick(state, d)
  assert.equal(first.stop, false)
  seedLane(root, { task: 'not-yet', journalLines: [{ at: NOW, event: 'seat-teardown' }], settled: true })
  const second = tick(state, d)
  assert.equal(second.stop, true)
  assert.equal(second.reason, 'settled')
  assert.equal(second.lines.length, 1)
  assert.match(second.lines[0], /\[not-yet\].*seat-teardown/)
})

test('--pending-s never restores the unbounded wait the operator asked for', () => {
  const root = world()
  let now = NOW
  const d = { ...QUIET, ppid: () => 777, now: () => now }
  const state = createState({ root, names: ['never-booted'], pendingS: null, watchdog: false, bootPpid: 777, deps: d })
  assert.equal(tick(state, d).stop, false)
  now += PENDING_BOUND_S * 10 * 1000
  const result = tick(state, d)
  assert.equal(result.stop, false)
  assert.notEqual(result.reason, 'unresolved')
})

test('a watcher armed on a name that never resolves refuses instead of waiting', async () => {
  const root = world()
  seedLane(root, { task: 'b231-helperdedupb', journalLines: [{ at: NOW, stage: 'done' }], settled: true })
  let now = NOW
  let sleeps = 0
  const sentinel = new Error('unbounded wait sentinel')
  const d = {
    ...QUIET,
    ppid: () => 777,
    now: () => now,
    stdout: () => {},
    sleep: async (ms) => {
      sleeps += 1
      if (sleeps > 200) throw sentinel
      now += ms
    },
  }
  const state = createState({ root, names: ['b231-helperdedupB'], bootPpid: 777, deps: d })
  await assert.rejects(follow(state, d), (err) => err !== sentinel
    && err.name === 'WatchUsageError'
    && err.reason === 'lane-unresolved'
    && err.message.includes('b231-helperdedupB')
    && err.message.includes('live lanes: b231-helperdedupb'))
})

test('resolveLane prefers task names and also accepts lane ids', () => {
  const root = world()
  seedLane(root, { repo: 'dt-b86-docs', task: 'b86-docs-r2', journalLines: [] })
  const lanes = discoverLanes(root)
  assert.equal(resolveLane('b86-docs-r2', lanes).id, 'dt-b86-docs/b86-docs-r2')
  assert.equal(resolveLane('dt-b86-docs/b86-docs-r2', lanes).id, 'dt-b86-docs/b86-docs-r2')
  assert.equal(resolveLane('unknown', lanes), null)
})

test('journal offsets emit appended events once and stay idle thereafter', () => {
  const root = world()
  const lane = seedLane(root, { journalLines: [{ at: NOW, stage: 'plan:r1' }] })
  const state = createState({ root, names: ['demo-lane'], bootPpid: 777, watchdog: false, deps: deps() })
  const first = tick(state, deps())
  assert.equal(first.lines.length, 1)
  appendFileSync(lane.journal, `${JSON.stringify({ at: NOW + 1, stage: 'build:r1' })}\n`)
  const second = tick(state, deps(NOW + 1))
  assert.equal(second.lines.length, 1)
  assert.match(second.lines[0], /build:r1/)
  const third = tick(state, deps(NOW + 2))
  assert.deepEqual(third.lines, [])
})

test('the default allowlist selects heterogeneous journal events and an override replaces it', () => {
  const selected = [
    [{ at: NOW, stage: 'plan:r1' }, true],
    [{ at: NOW, stage: 'escalate:scope' }, true],
    [{ at: NOW, stage: 'commit' }, true],
    [{ at: NOW, kind: 'attention' }, true],
    [{ at: NOW, review_outcome: { dispatch: 'd3' } }, true],
    [{ at: NOW, gate_check_discrimination: 'ok' }, true],
    [{ at: NOW, event: 'seat-teardown' }, true],
    [{ at: NOW, event: 'seat-ready' }, false],
    [{ at: NOW, event: 'doc-viewer' }, false],
  ]
  for (const [line, expected] of selected) assert.equal(selectEvent(line, DEFAULT_EVENTS), expected, JSON.stringify(line))
  assert.deepEqual(lineLabels({ review_outcome: {} }), KEYED_EVENTS.slice(0, 1))
  assert.equal(selectEvent({ stage: 'done' }, parseArgs(['demo-lane', '--events', 'commit,done']).events), true)
  assert.equal(selectEvent({ stage: 'plan:r1' }, ['commit']), false)
  assert.equal(formatEvent('demo', { at: NOW, event: 'attention', why: 'quiet', role: 'planner' }), '[demo] 18:00:00 attention why=quiet role=planner')
})

test('the watchdog runs during a follow tick and records a silent-lane note', () => {
  const root = world()
  const lane = seedLane(root, {
    task: 'wedged',
    journalLines: [{ at: NOW - 700_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'plan.md', ageS: 800 }],
  })
  const state = createState({ root, names: ['wedged'], bootPpid: 777, deps: deps() })
  const result = tick(state, deps())
  assert.ok(result.notes.some((note) => note.note === 'silent-lane'))
  assert.ok(journalObjects(lane.journal).some((line) => line.event === 'lane-watch' && line.note === 'silent-lane'))
  assert.equal(watchPass({ root, now: NOW, deps: deps() }).notes.length, 0)
})

test('--no-watchdog keeps the readout while suppressing watchdog notes', () => {
  const root = world()
  const lane = seedLane(root, {
    task: 'wedged',
    journalLines: [{ at: NOW - 700_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'plan.md', ageS: 800 }],
  })
  const state = createState({ root, names: ['wedged'], bootPpid: 777, watchdog: false, deps: deps() })
  const result = tick(state, deps())
  assert.ok(result.lines.some((line) => line.includes('plan:r1')))
  assert.deepEqual(journalObjects(lane.journal).filter((line) => line.event === 'lane-watch'), [])
})

test('the watchdog honors its thirty-second cadence after lane activity changes', () => {
  const root = world()
  const lane = seedLane(root, {
    task: 'cadence',
    journalLines: [{ at: NOW - 700_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'plan.md', ageS: 800 }],
  })
  let now = NOW
  const state = createState({ root, names: ['cadence'], bootPpid: 777, deps: deps(now) })
  tick(state, deps(now))
  const firstCount = journalObjects(lane.journal).filter((line) => line.event === 'lane-watch').length
  now += 10_000
  tick(state, deps(now))
  assert.equal(journalObjects(lane.journal).filter((line) => line.event === 'lane-watch').length, firstCount)
  appendFileSync(lane.journal, `${JSON.stringify({ at: NOW - 600_000, stage: 'build:r1' })}\n`)
  now += (WATCHDOG_INTERVAL_S * 1000) + 1
  tick(state, deps(now))
  assert.ok(journalObjects(lane.journal).filter((line) => line.event === 'lane-watch').length > firstCount)
})

test('parseArgs is bounded by default and validates options', () => {
  const base = parseArgs(['demo', 'other'])
  assert.deepEqual(base.names, ['demo', 'other'])
  assert.equal(base.follow, false)
  assert.equal(base.all, false)
  assert.equal(base.watchdog, true)
  assert.equal(base.intervalS, 2)
  assert.deepEqual(base.events, [...DEFAULT_EVENTS])
  assert.equal(base.silenceS, undefined)
  assert.equal(base.loadPerCore, undefined)
  assert.equal(base.pendingS, PENDING_BOUND_S)
  const flagged = parseArgs(['--all', '--follow', '--no-watchdog', '--interval', '7', '--events', 'commit, done', '--silence-s', '600', '--load-per-core', '2'])
  assert.deepEqual(flagged, {
    names: [], all: true, follow: true, watchdog: false, events: ['commit', 'done'], intervalS: 7, silenceS: 600, loadPerCore: 2, pendingS: PENDING_BOUND_S,
  })
  assert.equal(parseArgs(['--follow', 'x', '--pending-s', 'never']).pendingS, null)
  for (const argv of [
    ['--nope'],
    [],
    ['--interval', '0'],
    ['--events', ' , '],
    ['demo', '--events', ''],
    ['--follow', '--follow'],
    ['--all', '--silence-s', '0'],
    ['--all', '--silence-s', 'abc'],
    ['--all', '--silence-s', '-1'],
    ['--all', '--load-per-core', '0'],
    ['--all', '--load-per-core', '-1'],
    ['--all', '--load-per-core', 'abc'],
    ['--all', '--silence-s', '600', '--silence-s', '600'],
    ['x', '--follow', '--pending-s', '0'],
    ['x', '--follow', '--pending-s', 'abc'],
    ['x', '--follow', '--pending-s', '-1'],
    ['x', '--follow', '--pending-s', '1', '--pending-s', '1'],
    ['x', '--pending-s', '30'],
  ]) {
    assert.throws(() => parseArgs(argv), { name: 'WatchUsageError' })
  }
})

test('a threshold flag is refused in the single-pass readout it cannot reach', () => {
  assert.throws(() => parseArgs(['--all', '--silence-s', '600']), (err) => err.name === 'WatchUsageError' && err.message.includes('--silence-s') && err.message.includes('applies to --follow only'))
  assert.throws(() => parseArgs(['demo', '--load-per-core', '2']), (err) => err.name === 'WatchUsageError' && err.message.includes('--load-per-core') && err.message.includes('applies to --follow only'))
})

test('the refusal exits 2 through main', async () => {
  const stdout = []
  const stderr = []
  const status = await main(['--all', '--silence-s', '600'], {
    ...deps(),
    stderr: (text) => stderr.push(text),
    stdout: (text) => stdout.push(text),
  })
  assert.equal(status, 2)
  assert.match(stderr.join(''), /--silence-s/)
  assert.match(stderr.join(''), /--follow/)
  assert.equal(stdout.join(''), '')
})

test('the unresolved refusal exits 2 through main', async () => {
  const home = world()
  seedLane(join(home, '.crew'), { task: 'b231-helperdedupb', journalLines: [{ at: NOW, stage: 'done' }], settled: true })
  let now = NOW
  const stdout = []
  const stderr = []
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const status = await main(['b231-helperdedupB', '--follow', '--pending-s', '1', '--interval', '0.05'], {
      ...QUIET,
      ppid: () => 777,
      now: () => now,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      onSignal: () => {},
      sleep: async (ms) => { now += ms },
    })
    assert.equal(status, 2)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
  const text = stderr.join('')
  assert.match(text, /b231-helperdedupB/)
  assert.match(text, /\[reason: lane-unresolved\]/)
})

test('the follow arm still accepts a threshold and still reaches the pass', () => {
  const operatorRoot = world()
  const operatorLane = seedLane(operatorRoot, {
    task: 'thresholded',
    journalLines: [{ at: NOW - 120_000, stage: 'plan:r1' }],
  })
  const operatorDeps = deps()
  const operatorState = createState({ root: operatorRoot, names: ['thresholded'], bootPpid: 777, silenceS: 60, deps: operatorDeps })
  const operatorResult = tick(operatorState, operatorDeps)
  const operatorNote = operatorResult.notes.find((note) => note.note === 'silent-lane')
  assert.ok(operatorNote)
  assert.equal(operatorNote.threshold_s, 60)
  assert.equal(journalObjects(operatorLane.journal).filter((line) => line.note === 'silent-lane').length, 1)

  const defaultRoot = world()
  const defaultLane = seedLane(defaultRoot, {
    task: 'thresholded',
    journalLines: [{ at: NOW - 120_000, stage: 'plan:r1' }],
  })
  const defaultDeps = deps()
  const defaultState = createState({ root: defaultRoot, names: ['thresholded'], bootPpid: 777, deps: defaultDeps })
  const defaultResult = tick(defaultState, defaultDeps)
  assert.deepEqual(defaultResult.notes.filter((note) => note.note === 'silent-lane'), [])
  assert.deepEqual(journalObjects(defaultLane.journal).filter((line) => line.note === 'silent-lane'), [])
})

test('a single pass with no threshold flags is unchanged', async () => {
  const home = world()
  seedLane(join(home, '.crew'), { task: 'wedged', journalLines: [{ at: NOW, stage: 'plan:r1' }] })
  const stdout = []
  const stderr = []
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const status = await main(['wedged'], {
      ...deps(),
      stderr: (text) => stderr.push(text),
      stdout: (text) => stdout.push(text),
    })
    assert.equal(status, 0)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
  assert.match(stdout.join(''), /\[wedged\] stage=plan:r1 .*status=active/)
  assert.doesNotMatch(stdout.join(''), /\[watchdog\]/)
  assert.doesNotMatch(stderr.join(''), /\[watchdog\]/)
})

test('CLI thresholds reach the watchdog pass through createState and tick', () => {
  const defaultSilenceRoot = world()
  const defaultSilenceLane = seedLane(defaultSilenceRoot, {
    journalLines: [{ at: NOW - 400_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'plan.md', ageS: 400 }],
  })
  const defaultSilenceDeps = deps()
  const defaultSilenceState = createState({ root: defaultSilenceRoot, all: true, bootPpid: 777, deps: defaultSilenceDeps })
  const defaultSilence = tick(defaultSilenceState, defaultSilenceDeps)
  assert.ok(defaultSilence.notes.some((note) => note.note === 'silent-lane'))

  const operatorSilenceRoot = world()
  const operatorSilenceLane = seedLane(operatorSilenceRoot, {
    journalLines: [{ at: NOW - 400_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'plan.md', ageS: 400 }],
  })
  const operatorSilenceDeps = deps()
  const operatorSilenceState = createState({ root: operatorSilenceRoot, all: true, bootPpid: 777, silenceS: 600, deps: operatorSilenceDeps })
  const operatorSilence = tick(operatorSilenceState, operatorSilenceDeps)
  assert.deepEqual(operatorSilence.notes.filter((note) => note.note === 'silent-lane'), [])
  assert.deepEqual(journalObjects(operatorSilenceLane.journal).filter((line) => line.note === 'silent-lane'), [])
  assert.equal(journalObjects(defaultSilenceLane.journal).filter((line) => line.note === 'silent-lane').length, 1)

  const defaultLoadRoot = world()
  const defaultLoadLane = seedLane(defaultLoadRoot, {
    journalLines: [{ at: NOW - 5_000, stage: 'build:r1' }],
    artifacts: [{ name: 'a.txt', ageS: 5 }],
  })
  const loadDeps = deps(NOW, { loadavg: () => [25, 25, 25] })
  const defaultLoadState = createState({ root: defaultLoadRoot, all: true, bootPpid: 777, deps: loadDeps })
  const defaultLoad = tick(defaultLoadState, loadDeps)
  assert.deepEqual(defaultLoad.notes.filter((note) => note.note === 'host-load'), [])
  assert.deepEqual(journalObjects(defaultLoadLane.journal).filter((line) => line.note === 'host-load'), [])

  const operatorLoadRoot = world()
  const operatorLoadLane = seedLane(operatorLoadRoot, {
    journalLines: [{ at: NOW - 5_000, stage: 'build:r1' }],
    artifacts: [{ name: 'a.txt', ageS: 5 }],
  })
  const operatorLoadState = createState({ root: operatorLoadRoot, all: true, bootPpid: 777, loadPerCore: 1, deps: loadDeps })
  const operatorLoad = tick(operatorLoadState, loadDeps)
  assert.ok(operatorLoad.notes.some((note) => note.note === 'host-load'))
  assert.equal(journalObjects(operatorLoadLane.journal).filter((line) => line.note === 'host-load').length, 1)
})

test('watchdogLine states each threshold value and origin', () => {
  assert.equal(watchdogLine(), '[watchdog] silence_s=300 (default) load_per_core=4 (default)')
  assert.equal(watchdogLine({ silenceS: 600 }), '[watchdog] silence_s=600 (operator) load_per_core=4 (default)')
  assert.equal(watchdogLine({ watchdog: false }), '[watchdog] off')
})

test('a torn-down lane resolves from the archive and the archive walk stays lazy', async () => {
  const archiveRoot = world()
  seedLane(archiveRoot, {
    task: 'retired-lane.archive-2026-08-20T23-25-28-377Z',
    journalLines: [{ at: NOW - 700_000, stage: 'build:r2' }],
  })
  const report = boundedReport({ root: archiveRoot, names: ['retired-lane'], now: NOW, deps: deps() })
  assert.deepEqual(report.lines, ['[retired-lane] stage=build:r2 age=700s status=archived'])
  let now = NOW + (PENDING_BOUND_S * 1000) + 1
  const archiveDeps = {
    ...QUIET,
    ppid: () => 777,
    now: () => now,
    stdout: () => {},
    sleep: async (ms) => { now += ms },
  }
  const archiveState = createState({ root: archiveRoot, names: ['retired-lane'], watchdog: false, bootPpid: 777, deps: archiveDeps })
  assert.equal(await follow(archiveState, archiveDeps), 0)

  const countRootReads = (root, names) => {
    let reads = 0
    const countedDeps = {
      ...deps(),
      readdirSync: (path, options) => {
        if (path === root) reads += 1
        return readdirSync(path, options)
      },
    }
    boundedReport({ root, names, now: NOW, deps: countedDeps })
    return reads
  }
  const liveRoot = world()
  seedLane(liveRoot, { task: 'live-a', settled: true })
  seedLane(liveRoot, { task: 'live-b', settled: true })
  assert.equal(countRootReads(liveRoot, ['live-a', 'live-b']), 1)
  const missingRoot = world()
  seedLane(missingRoot, { task: 'live-a', settled: true })
  assert.equal(countRootReads(missingRoot, ['live-a', 'ghost']), 2)
})

test('every named lane resolving and terminal still settles at exit 0', async () => {
  const root = world()
  seedLane(root, { task: 'finished', journalLines: [{ at: NOW, stage: 'done' }], settled: true })
  const d = { ...QUIET, ppid: () => 777, now: () => NOW, stdout: () => {} }
  const state = createState({ root, names: ['finished'], watchdog: false, bootPpid: 777, deps: d })
  const result = tick(state, d)
  assert.equal(result.stop, true)
  assert.equal(result.reason, 'settled')
  assert.equal(await follow(state, d), 0)
})

test('follow has no process-spawning surface and no child after one tick', async () => {
  const source = readFileSync(new URL('../scripts/factory/crew-watch.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /child_process|spawnSync|execSync/)
  const home = world()
  seedLane(join(home, '.crew'), { journalLines: [{ at: Date.now(), stage: 'plan:r1' }] })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/factory/crew-watch.mjs', import.meta.url)), '--all', '--follow', '--interval', '2'], {
    stdio: 'ignore', env: { ...process.env, HOME: home },
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const state = spawnSync('ps', ['-o', 'state=', '-p', String(child.pid)], { encoding: 'utf8' })
    assert.match(String(state.stdout || '').trim(), /^[^Z]/)
    const kids = spawnSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
    assert.equal(String(kids.stdout || '').trim(), '')
  } finally {
    try { process.kill(child.pid, 'SIGKILL') } catch {}
  }
})

test('lane-watch remains byte-identical', () => {
  const source = readFileSync(new URL('../scripts/factory/lane-watch.mjs', import.meta.url))
  assert.equal(createHash('sha256').update(source).digest('hex'), 'aea054f933f4618663d8205dda12e093893155630818d2740e8fa6e53086ef06')
})
