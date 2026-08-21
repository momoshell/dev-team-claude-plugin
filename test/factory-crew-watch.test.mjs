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
  orphaned,
  parseArgs,
  resolveLane,
  selectEvent,
  tick,
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
  const flagged = parseArgs(['--all', '--follow', '--no-watchdog', '--interval', '7', '--events', 'commit, done'])
  assert.deepEqual(flagged, {
    names: [], all: true, follow: true, watchdog: false, events: ['commit', 'done'], intervalS: 7,
  })
  for (const argv of [['--nope'], [], ['--interval', '0'], ['--events', ' , '], ['demo', '--events', ''], ['--follow', '--follow']]) {
    assert.throws(() => parseArgs(argv), { name: 'WatchUsageError' })
  }
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
  assert.equal(createHash('sha256').update(source).digest('hex'), '9fb26f904275180abea056ec32674b8e28cc629c9183fcd27f5c8ad9f4180158')
})
