import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EVENTS,
  KEYED_EVENTS,
  WATCHDOG_INTERVAL_S,
  boundedReport,
  createState,
  formatEvent,
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

const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-crew-watch-'))
const NOW = Date.parse('2026-08-19T18:00:00.000Z')
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

function seedLane(root, {
  repo = 'dt-demo',
  task = 'demo-lane',
  journalLines = [],
  artifacts = [],
  settled = false,
} = {}) {
  const dir = join(root, repo, task)
  const taskDir = join(dir, 'task')
  mkdirSync(taskDir, { recursive: true })
  mkdirSync(join(dir, 'returns'), { recursive: true })
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ schema_version: 3, task, checkout: `/tmp/${repo}` }))
  writeFileSync(join(dir, 'journal.jsonl'), journalLines.map((line) => JSON.stringify(line)).join('\n') + (journalLines.length ? '\n' : ''))
  for (const artifact of artifacts) {
    const path = join(taskDir, artifact.name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, artifact.body ?? 'x')
    const when = (NOW - artifact.ageS * 1000) / 1000
    utimesSync(path, when, when)
  }
  if (settled) writeFileSync(join(dir, 'returns', 'task.json'), '{}')
  return { dir, taskDir, journal: join(dir, 'journal.jsonl') }
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
  const flagged = parseArgs(['--all', '--follow', '--no-watchdog', '--interval', '7', '--events', 'commit, done', '--silence-s', '600', '--load-per-core', '2'])
  assert.deepEqual(flagged, {
    names: [], all: true, follow: true, watchdog: false, events: ['commit', 'done'], intervalS: 7, silenceS: 600, loadPerCore: 2,
  })
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
