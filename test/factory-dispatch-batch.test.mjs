import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync as fsExistsSync, mkdirSync, readFileSync, readdirSync as fsReaddirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  BAND_FLOOR_REASONS,
  BatchRefusal,
  CROSS_BATCH_BLIND_SPOT,
  CROSS_BATCH_UNKNOWN_PREFIX,
  baseContains,
  batchSeatsFrom,
  BOOT_TRANSPORT,
  PANE_TRANSPORT,
  COUPLED_SOURCE_UNFENCED,
  ANCHOR_BLIND_SPOT,
  ANCHOR_PIN_WARNING_PREFIX,
  REFUSAL_REASONS,
  DISPATCH_RECORD_SUFFIX,
  DRY_RUN_BLIND_SPOT,
  DISPATCH_ONLY_REQUEST_KEYS,
  MISCLASSIFIED_PREFIX,
  REQUEST_SUFFIX,
  SEAT_FIELDS,
  STALE_READ_ACK,
  SYMBOL_FANOUT_LIMIT,
  TEST_REACH_BLIND_SPOT,
  TEST_REACH_DEPTH,
  TEST_REACH_ROW_LIMIT,
  TEST_REACH_WARNING_PREFIX,
  checkArrival,
  checkDirectedBrief,
  checkFences,
  checkPlanScope,
  collectAnchorPins,
  collectTestReach,
  crewJsonPath,
  compileLane,
  dispatchBatch,
  laneOutcome,
  main,
  normalDeps,
  parseCliArgs,
  planWaves,
  planWorktrees,
  readsFromRefusal,
  readBatch,
  reconcileTier,
  seatChain,
  seatFlagArgs,
  seatFromSpec,
  seatSpec,
  shortfallFlagArgs,
  staffingFromBrief,
  resolveTransport,
  ROSTER_PATH,
  seatFloorRefusal,
  seatRolesUnseated,
  seatsDefect,
  mergeSeats,
  tierFloor,
} from '../scripts/factory/dispatch-batch.mjs'
import { parseDirectedBrief } from '../crew/drive.mjs'
import { scratchDir } from './helpers.mjs'

const root = scratchDir('factory-dispatch-batch-')
const repoRoot = dirname(dirname(new URL(import.meta.url).pathname))
const compiler = join(repoRoot, 'scripts', 'factory', 'make-brief.mjs')

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function anchorFixtures(checkout, manifests) {
  for (const [skill, pins] of Object.entries(manifests)) {
    put(join(checkout, 'skills', skill, 'anchors.json'), typeof pins === 'string' ? pins : JSON.stringify(pins))
  }
}

function request(ask = 'measure one owned source behavior', where = ['crew/owned.mjs']) {
  return {
    ask,
    where,
    done_means: 'the focused check reports the measured result',
    out_of_scope: 'unrelated repository behavior',
  }
}

function requestFor(lane, extra = {}) {
  return { ...request(`measure ${lane} source behavior`, [`crew/owned-${lane}.mjs`]), ...extra }
}

function makeBatch(names = ['lane-b', 'lane-a']) {
  const batch = join(root, `batch-${Math.random().toString(36).slice(2)}`)
  mkdirSync(batch, { recursive: true })
  for (const lane of names) put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(request(`measure ${lane} source behavior`)))
  return batch
}

// tier and shape DIFFER: a fixture where they agree passes against the defect.
const briefWithTierAndShape = [
  '## Proposed tier',
  'proposed tier: build',
  'proposed shape: mechanical',
  '```proposal',
  '{',
  '  "shape": "mechanical",',
  '  "strength": "workhorse"',
  '}',
  '```',
].join('\n')

const briefWithBlockOnly = [
  '```proposal',
  '{',
  '  "shape": "judge",',
  '  "strength": "workhorse"',
  '}',
  '```',
].join('\n')

const directedBrief = [
  '```directed',
  '{',
  '  "gate_cmd": "npm test",',
  '  "files_in_scope": ["crew/owned-lane-a.mjs"]',
  '}',
  '```',
].join('\n')

const briefWithQuotedTier = [
  'The ask quotes proposed tier: judge mid-sentence.',
  '## Proposed tier',
  'proposed tier: build',
  '```proposal',
  '{',
  '  "shape": "mechanical",',
  '  "strength": "workhorse"',
  '}',
  '```',
].join('\n')

function staffingBrief({ shape, strength, tier = 'build', misclassification = null } = {}) {
  return [
    '## Proposed tier',
    `proposed tier: ${tier}`,
    `proposed shape: ${shape ?? 'no proposal'}`,
    `proposed strength: ${strength ?? 'no proposal'}`,
    ...(misclassification ? [misclassification] : []),
    ...(shape === null && strength === null ? [] : ['```proposal', JSON.stringify({ shape, strength }, null, 2), '```']),
  ].join('\n')
}

function entry(lane, files, reads = []) { return { lane, files, reads } }
function refusal(fn, reason) {
  assert.throws(fn, (err) => err instanceof BatchRefusal && err.reason === reason)
}
async function refusalAsync(fn, reason) {
  await assert.rejects(fn, (err) => err instanceof BatchRefusal && err.reason === reason)
}
function thrown(fn) {
  try { fn() } catch (error) { return error }
  assert.fail('expected a refusal')
}
async function thrownAsync(fn) {
  try { return await fn() } catch (error) { return error }
  assert.fail('expected a refusal')
}

let gitFixtureCount = 0
function gitFixture() {
  gitFixtureCount += 1
  const dir = join(root, `compiler-git-${gitFixtureCount}`)
  mkdirSync(dir, { recursive: true })
  put(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }))
  put(join(dir, 'src', 'owned.mjs'), 'export const OWNED = 1\n')
  put(join(dir, 'src', 'coupled.mjs'), "import { OWNED } from './owned.mjs'\nexport const COUPLED = OWNED\n")
  put(join(dir, 'src', 'stale.mjs'), 'export const STALE = 1\n')
  const init = spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  for (const args of [
    ['-C', dir, 'config', 'user.email', 'factory@test.invalid'],
    ['-C', dir, 'config', 'user.name', 'factory test'],
    ['-C', dir, 'add', '.'],
    ['-C', dir, 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  }
  return dir
}

function reachFixture(name, { extraDirect = 0, files = {} } = {}) {
  const checkout = join(root, `reach-${name}`)
  mkdirSync(checkout, { recursive: true })
  put(join(checkout, 'lib', 'widget.mjs'), 'export const widgetValue = 1\nexport function widgetShape() { return widgetValue }\n')
  put(join(checkout, 'lib', 'caller.mjs'), "import { widgetShape } from './widget.mjs'\nexport const callerValue = widgetShape()\n")
  put(join(checkout, 'lib', 'outer.mjs'), "import { callerValue } from './caller.mjs'\nexport const outerValue = callerValue\n")
  put(join(checkout, 'test', 'direct.test.mjs'), "import { widgetShape } from '../lib/widget.mjs'\nwidgetShape()\n")
  put(join(checkout, 'test', 'twohop.test.mjs'), "import { callerValue } from '../lib/caller.mjs'\nif (callerValue !== 1) throw new Error('x')\n")
  put(join(checkout, 'test', 'threehop.test.mjs'), "import { outerValue } from '../lib/outer.mjs'\nif (outerValue !== 1) throw new Error('x')\n")
  for (let index = 0; index < extraDirect; index += 1) {
    put(join(checkout, 'test', `direct-${String(index).padStart(2, '0')}.test.mjs`), "import { widgetShape } from '../lib/widget.mjs'\nwidgetShape()\n")
  }
  for (const [file, body] of Object.entries(files)) put(join(checkout, file), body)
  for (const args of [['init', '-q', checkout], ['-C', checkout, 'add', '-A']]) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  }
  return checkout
}

function crewFixture({ home, repoDir, laneDir, lane = laneDir, fence = [], checkout, malformed = false, archived = false, stamp = '2026-08-01T00-00-00Z' }) {
  const directory = archived
    ? join(home, '.crew', repoDir, `${laneDir}.archive-${stamp}`)
    : join(home, '.crew', repoDir, laneDir)
  const crew = malformed ? '{ this is not json' : JSON.stringify({
    schema_version: 3,
    task: lane,
    checkout,
    lane_name: lane,
    lane_fence: fence,
  })
  put(join(directory, 'crew.json'), crew)
  put(join(directory, 'journal.jsonl'), `${JSON.stringify({ at: 1, stage: archived ? 'done' : 'build:r1' })}\n`)
  if (archived) put(join(directory, 'returns', 'task.json'), JSON.stringify({ status: 'done' }))
  return directory
}

function collisionFixture(name, ownFiles, liveFiles) {
  const checkout = gitFixture()
  const home = join(root, `cross-batch-${name}`)
  crewFixture({
    home,
    repoDir: 'dt-ghost',
    laneDir: 'ghost-lane',
    lane: 'ghost-lane',
    checkout,
    fence: [{ lane: 'other-lane', files: liveFiles }],
  })
  crewFixture({
    home,
    repoDir: 'dt-other',
    laneDir: 'other-lane',
    lane: 'other-lane',
    checkout,
    fence: [{ lane: 'ghost-lane', files: ['docs/x.md'] }],
  })
  return { checkout, home, ownFiles }
}

function reachReport(checkout, fenceFiles = ['lib/widget.mjs'], surface = fenceFiles, deps = {}) {
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', fenceFiles)],
    lanes: [{ lane: 'lane-a', where: surface }],
    checkout,
    deps: { home: root, log: (line) => logs.push(String(line)), ...deps },
  })
  const warning = report.warnings.find((item) => item.kind === 'test-reach')
  return { report, logs, warning, rows: warning?.reach || [] }
}

test('checkFences reports direct and two-hop test reach without refusing', () => {
  const checkout = reachFixture('depth')
  const { report, warning, rows } = reachReport(checkout)
  assert.ok(warning)
  assert.equal(rows.find((row) => row.test === 'test/direct.test.mjs')?.hops, 1)
  assert.equal(rows.find((row) => row.test === 'test/twohop.test.mjs')?.hops, 2)
  assert.equal(rows.some((row) => row.test === 'test/threehop.test.mjs'), false)
  assert.equal(TEST_REACH_DEPTH, 2)
  assert.equal(warning.text.includes('test/twohop.test.mjs'), true)
  assert.equal(warning.text.includes(TEST_REACH_BLIND_SPOT), true)
  assert.equal(REFUSAL_REASONS.some((reason) => reason.includes('reach')), false)
  assert.ok(report.perLane['lane-a'])
})

test('collectTestReach records no hop beyond TEST_REACH_DEPTH', () => {
  const checkout = reachFixture('bounded-depth')
  const reach = collectTestReach({ checkout, deps: { home: root } })
  const beyond = []
  let threeHop = false
  const surface = new Map([...reach.byFile].filter(([file]) => file === 'lib/widget.mjs'))
  for (const [file, perTest] of surface) {
    for (const [test, hops] of perTest) {
      if (test === 'test/threehop.test.mjs') threeHop = true
      if (!(hops <= TEST_REACH_DEPTH)) beyond.push(`${test} -> ${file} (hops=${hops})`)
    }
  }
  assert.deepEqual(beyond, [])
  assert.equal(threeHop, false)
})

test('cross-batch collision refuses with its distinct reason', () => {
  const fixture = collisionFixture('reason', ['scripts/keep.mjs'], ['scripts/keep.mjs'])
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', fixture.ownFiles)],
    lanes: [{ lane: 'lane-a', where: fixture.ownFiles }],
    checkout: fixture.checkout,
    deps: { home: fixture.home, log: () => {} },
  }))
  assert.equal(error.reason, 'cross-batch-collision')
  assert.notEqual(error.reason, 'sibling-leak')
  assert.equal(REFUSAL_REASONS.includes('cross-batch-collision'), true)
})

test('cross-batch refusal names the live lane, file, and crew directory', () => {
  const fixture = collisionFixture('details', ['scripts/keep.mjs'], ['scripts/keep.mjs'])
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', fixture.ownFiles)],
    lanes: [{ lane: 'lane-a', where: fixture.ownFiles }],
    checkout: fixture.checkout,
    deps: { home: fixture.home, log: () => {} },
  }))
  const liveDir = join(fixture.home, '.crew', 'dt-other', 'other-lane')
  assert.equal(error.message.includes('other-lane'), true)
  assert.equal(error.message.includes('scripts/keep.mjs'), true)
  assert.equal(error.message.includes(liveDir), true)
})

test('claim recovery uses parsed lane_name instead of the slugged crew directory', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-lane-name')
  crewFixture({
    home,
    repoDir: 'dt-ghost',
    laneDir: 'ghost-lane',
    lane: 'ghost_lane',
    checkout,
    fence: [{ lane: 'other_lane', files: ['scripts/keep.mjs'] }],
  })
  crewFixture({
    home,
    repoDir: 'dt-other',
    laneDir: 'other-lane',
    lane: 'other_lane',
    checkout,
    fence: [{ lane: 'ghost_lane', files: ['docs/x.md'] }],
  })
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: () => {} },
  }))
  assert.equal(error.reason, 'cross-batch-collision')
  assert.equal(error.message.includes('other_lane'), true)
})

test('foreign archived claims do not contaminate same-repository claim recovery', () => {
  const checkout = gitFixture()
  const foreignCheckout = gitFixture()
  const home = join(root, 'cross-batch-foreign-archive')
  crewFixture({
    home,
    repoDir: 'dt-local',
    laneDir: 'other-lane',
    lane: 'other_lane',
    checkout,
    fence: [],
  })
  crewFixture({
    home,
    repoDir: 'dt-foreign',
    laneDir: 'arch-lane',
    lane: 'arch_lane',
    checkout: foreignCheckout,
    archived: true,
    fence: [{ lane: 'other_lane', files: ['scripts/keep.mjs'] }],
  })
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: () => {} },
  })
  const unknown = report.crossBatch.unknown.find((row) => row.lane === 'other-lane')
  assert.deepEqual(unknown, { lane: 'other-lane', reason: 'claim-unrecorded' })
  assert.equal(report.crossBatch.cleared, false)
  assert.equal(report.warnings.some((item) => item.kind === 'cross-batch-unknown'), true)
})

test('a stale archived claim does not satisfy a solo live lane', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-stale-archive')
  crewFixture({
    home,
    repoDir: 'dt-local',
    laneDir: 'other-lane',
    lane: 'other-lane',
    checkout,
    fence: [],
  })
  crewFixture({
    home,
    repoDir: 'dt-old',
    laneDir: 'other-lane',
    lane: 'other-lane',
    checkout,
    archived: true,
    fence: [{ lane: 'other-lane', files: ['scripts/keep.mjs'] }],
  })
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: () => {} },
  })
  assert.deepEqual(report.crossBatch.unknown.find((row) => row.lane === 'other-lane'), {
    lane: 'other-lane', reason: 'claim-unrecorded',
  })
  assert.equal(report.crossBatch.cleared, false)
  assert.equal(report.warnings.some((item) => item.kind === 'cross-batch-unknown'), true)
})

test('an unreadable live crew.json is unknown and warns without refusing', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-unknown')
  crewFixture({
    home,
    repoDir: 'dt-bad',
    laneDir: 'bad-lane',
    lane: 'bad-lane',
    checkout,
    malformed: true,
  })
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: (line) => logs.push(String(line)) },
  })
  const cross = report.crossBatch
  const unknown = cross.unknown.find((row) => row.lane === 'bad-lane')
  const warning = report.warnings.find((item) => item.kind === 'cross-batch-unknown')
  assert.deepEqual(unknown, { lane: 'bad-lane', reason: 'crew-json-unreadable' })
  assert.equal(cross.cleared, false)
  assert.ok(warning)
  assert.equal(warning.text.includes(CROSS_BATCH_UNKNOWN_PREFIX), true)
  assert.equal(warning.text.includes(CROSS_BATCH_BLIND_SPOT), true)
  assert.equal(logs.some((line) => line.includes(CROSS_BATCH_UNKNOWN_PREFIX) && line.includes(CROSS_BATCH_BLIND_SPOT)), true)
})

test('an unreadable crew root is unknown and does not refuse', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-unreadable-root')
  const crewRootPath = join(home, '.crew')
  mkdirSync(crewRootPath, { recursive: true })
  const readdirSync = (path, options) => {
    if (String(path) === crewRootPath) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    return fsReaddirSync(path, options)
  }
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, readdirSync, log: () => {} },
  })
  assert.equal(report.crossBatch.state, 'unreadable')
  assert.equal(report.crossBatch.cleared, false)
})

test('an unreadable crew repository child leaves the live set unknown', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-unreadable-child')
  crewFixture({
    home,
    repoDir: 'dt-hidden',
    laneDir: 'hidden-lane',
    lane: 'hidden-lane',
    checkout,
    fence: [],
  })
  const readdirSync = (path, options) => {
    if (String(path) === join(home, '.crew', 'dt-hidden')) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    return fsReaddirSync(path, options)
  }
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, readdirSync, log: () => {} },
  })
  assert.deepEqual(report.crossBatch.unknown.find((row) => row.reason === 'crew-walk-incomplete'), {
    lane: null, reason: 'crew-walk-incomplete',
  })
  assert.equal(report.crossBatch.cleared, false)
  assert.equal(report.warnings.some((item) => item.kind === 'cross-batch-unknown'), true)
})

test('an absent crew root is a cleared empty set without an unknown warning', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-absent-root')
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: () => {} },
  })
  assert.equal(report.crossBatch.state, 'absent')
  assert.equal(report.crossBatch.cleared, true)
  assert.equal(report.warnings.some((item) => item.kind === 'cross-batch-unknown'), false)
})

test('archived lanes are claim sources but never live collision claimants', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-archived')
  crewFixture({
    home,
    repoDir: 'dt-ghost',
    laneDir: 'ghost-lane',
    lane: 'ghost-lane',
    checkout,
    fence: [{ lane: 'arch-lane', files: ['scripts/keep.mjs'] }],
  })
  crewFixture({
    home,
    repoDir: 'dt-arch',
    laneDir: 'arch-lane',
    lane: 'arch-lane',
    checkout,
    archived: true,
    fence: [{ lane: 'ghost-lane', files: ['docs/x.md'] }],
  })
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: () => {} },
  })
  const live = report.crossBatch.live.map((row) => row.lane)
  assert.equal(live.includes('ghost-lane'), true)
  assert.equal(live.includes('arch-lane'), false)
  assert.equal(report.crossBatch.live.some((row) => row.lane === 'arch-lane'), false)
})

test('a live lane named by this batch is recorded as own and does not collide', () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-own')
  crewFixture({
    home,
    repoDir: 'dt-ghost',
    laneDir: 'ghost-lane',
    lane: 'ghost-lane',
    checkout,
    fence: [{ lane: 'lane-a', files: ['scripts/keep.mjs'] }],
  })
  crewFixture({
    home,
    repoDir: 'dt-lanea',
    laneDir: 'lane-a',
    lane: 'lane-a',
    checkout,
    fence: [{ lane: 'ghost-lane', files: ['docs/x.md'] }],
  })
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: () => {} },
  })
  assert.equal(report.crossBatch.own.includes('lane-a'), true)
  assert.equal(report.crossBatch.live.some((row) => row.lane === 'lane-a'), false)
})

test('a live lane in another git repository is foreign and does not collide', () => {
  const checkout = gitFixture()
  const otherCheckout = gitFixture()
  const home = join(root, 'cross-batch-foreign')
  crewFixture({
    home,
    repoDir: 'dt-other-repo',
    laneDir: 'foreign-lane',
    lane: 'foreign-lane',
    checkout: otherCheckout,
    fence: [{ lane: 'another-lane', files: ['scripts/keep.mjs'] }],
  })
  const report = checkFences({
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/keep.mjs'] }],
    checkout,
    deps: { home, log: () => {} },
  })
  assert.equal(report.crossBatch.foreign.includes('foreign-lane'), true)
  assert.equal(report.crossBatch.live.some((row) => row.lane === 'foreign-lane'), false)
  assert.equal(report.crossBatch.unknown.some((row) => row.lane === 'foreign-lane'), false)
})

test('cross-batch collision matches directory and file scopes in either direction', () => {
  const directoryLive = collisionFixture('directory-live', ['src/scripts/keep.mjs'], ['src/scripts/'])
  const first = thrown(() => checkFences({
    fences: [entry('lane-a', directoryLive.ownFiles)],
    lanes: [{ lane: 'lane-a', where: directoryLive.ownFiles }],
    checkout: directoryLive.checkout,
    deps: { home: directoryLive.home, log: () => {} },
  }))
  assert.equal(first.reason, 'cross-batch-collision')

  const fileLive = collisionFixture('file-live', ['src/scripts/'], ['src/scripts/keep.mjs'])
  const second = thrown(() => checkFences({
    fences: [entry('lane-a', fileLive.ownFiles)],
    lanes: [{ lane: 'lane-a', where: fileLive.ownFiles }],
    checkout: fileLive.checkout,
    deps: { home: fileLive.home, log: () => {} },
  }))
  assert.equal(second.reason, 'cross-batch-collision')
})

test('sibling-leak and test-reach warnings remain unchanged with a live crew root', () => {
  const home = join(root, 'cross-batch-live-root')
  const checkout = gitFixture()
  crewFixture({
    home,
    repoDir: 'dt-ghost',
    laneDir: 'ghost-lane',
    lane: 'ghost-lane',
    checkout,
    fence: [{ lane: 'other-lane', files: ['docs/x.md'] }],
  })
  crewFixture({
    home,
    repoDir: 'dt-other',
    laneDir: 'other-lane',
    lane: 'other-lane',
    checkout,
    fence: [{ lane: 'ghost-lane', files: ['docs/y.md'] }],
  })
  const shared = ['scripts/keep.mjs']
  const siblingError = thrown(() => checkFences({
    fences: [entry('lane-a', shared), entry('lane-b', shared)],
    lanes: [{ lane: 'lane-a', where: shared }, { lane: 'lane-b', where: [] }],
    checkout,
    deps: { home, log: () => {} },
  }))
  assert.equal(siblingError.reason, 'sibling-leak')

  const reach = reachFixture('live-root')
  const report = reachReport(reach, ['lib/widget.mjs'], ['lib/widget.mjs'], { home, log: () => {} })
  assert.equal(report.warning.text.startsWith(TEST_REACH_WARNING_PREFIX), true)
})

test('dispatchBatch logs cross-batch unknown during dry-run and returns normally', async () => {
  const checkout = gitFixture()
  const home = join(root, 'cross-batch-dry-run-unknown')
  crewFixture({
    home,
    repoDir: 'dt-bad',
    laneDir: 'bad-lane',
    lane: 'bad-lane',
    checkout,
    malformed: true,
  })
  const batch = join(checkout, 'cross-batch-dry-run')
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure dry-run unknown', ['scripts/keep.mjs'])))
  const logs = []
  const report = await dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['scripts/keep.mjs'])],
    checkout,
    parentDir: join(checkout, 'parents'),
    outDir: join(checkout, 'cross-batch-dry-run-out'),
    runFlags: { 'dry-run': true },
    deps: {
      home,
      env: { DEVTEAM_LEDGER_DIR: join(home, 'factory-state') },
      spawn: (options) => options.args?.includes('ls-files')
        ? spawnSync(options.file, options.args, { cwd: options.cwd, encoding: 'utf8' })
        : { status: 1, stdout: '', stderr: '' },
      log: (line) => logs.push(String(line)),
    },
  })
  assert.equal(report.dryRun, true)
  assert.equal(logs.some((line) => line.startsWith(CROSS_BATCH_UNKNOWN_PREFIX)), true)
  assert.equal(report.fences.crossBatch.cleared, false)
})

test('dispatchBatch logs test reach during dry-run without changing the outcome', async () => {
  const checkout = reachFixture('dry-run')
  const batch = join(checkout, 'reach-batch')
  mkdirSync(batch)
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure reach warning', ['lib/widget.mjs'])))
  const logs = []
  const report = await dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['lib/widget.mjs'])],
    checkout,
    parentDir: join(checkout, 'parents'),
    outDir: join(checkout, 'reach-out'),
    runFlags: { 'dry-run': true },
    deps: {
      home: root,
      env: { DEVTEAM_LEDGER_DIR: root },
      spawn: (options) => options.args?.includes('ls-files')
        ? spawnSync(options.file, options.args, { cwd: options.cwd, encoding: 'utf8' })
        : { status: 1, stdout: '', stderr: '' },
      log: (line) => logs.push(String(line)),
    },
  })
  assert.equal(report.dryRun, true)
  const warning = logs.find((line) => line.includes(TEST_REACH_WARNING_PREFIX))
  assert.ok(warning)
  assert.equal(warning.includes('test/twohop.test.mjs'), true)
})

test('symbol reach reports literal names and drops broad fan-out', () => {
  const broadTests = Object.fromEntries(Array.from({ length: SYMBOL_FANOUT_LIMIT + 1 }, (_, index) => [
    `test/common-${String(index).padStart(2, '0')}.test.mjs`, 'commonName\\n',
  ]))
  const checkout = reachFixture('symbols', {
    files: {
      'lib/loader.mjs': "export async function load(name) { return import(`./${name}.mjs`) }\\n",
      'lib/broad.mjs': 'export const commonName = 1\\n',
      'test/dynamic.test.mjs': "import { load } from '../lib/loader.mjs'\\nconst mod = await load('widget')\\nif (mod.widgetShape() !== 2) throw new Error('widgetShape changed')\\n",
      ...broadTests,
    },
  })
  const { warning, rows } = reachReport(checkout, ['lib/widget.mjs', 'lib/broad.mjs'])
  const symbolRow = rows.find((row) => row.test === 'test/dynamic.test.mjs')
  assert.ok(symbolRow)
  assert.equal(symbolRow.how, 'symbol')
  assert.equal(symbolRow.symbols.includes('widgetShape'), true)
  assert.equal(warning.text.includes('widgetShape'), true)
  assert.equal(rows.some((row) => row.symbols.includes('commonName')), false)
})

test('test reach enumerates only when fenced code exists and only once per batch', () => {
  const noCode = reachFixture('no-code', { files: { 'docs/notes.md': '# notes\\n' } })
  const noCodeCalls = []
  const noCodeReport = checkFences({
    fences: [entry('lane-a', ['docs/notes.md'])],
    lanes: [{ lane: 'lane-a', where: ['docs/notes.md'] }],
    checkout: noCode,
    deps: {
      home: root,
      spawn: (options) => { noCodeCalls.push(options); return { status: 0, stdout: '' } },
      log: () => {},
    },
  })
  assert.ok(noCodeReport.perLane['lane-a'])
  assert.equal(noCodeCalls.length, 0)

  const checkout = reachFixture('one-enumeration')
  const calls = []
  checkFences({
    fences: [entry('lane-a', ['lib/widget.mjs']), entry('lane-b', ['lib/caller.mjs']), entry('lane-c', ['lib/outer.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['lib/widget.mjs'] },
      { lane: 'lane-b', where: [] },
      { lane: 'lane-c', where: [] },
    ],
    checkout,
    deps: {
      home: root,
      spawn: (options) => {
        calls.push(options)
        return spawnSync(options.file, options.args, { cwd: options.cwd, encoding: 'utf8' })
      },
      log: () => {},
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.includes('ls-files'), true)
})

test('test reach carries every row while warning text caps the listed rows', () => {
  const checkout = reachFixture('row-limit', { extraDirect: TEST_REACH_ROW_LIMIT })
  const { warning, rows } = reachReport(checkout)
  assert.ok(warning)
  assert.equal(rows.length, TEST_REACH_ROW_LIMIT + 2)
  assert.equal(warning.text.includes(`listing at most ${TEST_REACH_ROW_LIMIT}`), true)
  assert.equal(warning.text.includes('2 further row(s) not listed here and carried on the report'), true)
  assert.equal(rows.filter((row) => row.hops === 1).length, TEST_REACH_ROW_LIMIT + 1)
  assert.equal(rows.find((row) => row.test === 'test/twohop.test.mjs')?.hops, 2)
})

test('readBatch reads request JSON, normalises where paths, and sorts lanes', () => {
  const batch = makeBatch()
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify({
    ...request('measure lane-a source behavior'), creates: ['./crew/x.mjs'],
  }))
  const lanes = readBatch({ batchDir: batch })
  assert.deepEqual(lanes.map(({ lane }) => lane), ['lane-a', 'lane-b'])
  assert.equal(lanes[0].name, 'lane-a.request.json')
  assert.deepEqual(lanes[0].where, ['crew/owned.mjs'])
  assert.deepEqual(lanes[0].creates, ['crew/x.mjs'])
  assert.deepEqual(lanes[0].request.creates, ['./crew/x.mjs'])
  assert.equal(lanes[0].request.ask, 'measure lane-a source behavior')
})

test('readBatch refuses an unreadable directory and an empty batch by name', () => {
  refusal(() => readBatch({ batchDir: join(root, 'missing-batch') }), 'batch-unreadable')
  const empty = join(root, 'empty-batch')
  mkdirSync(empty)
  refusal(() => readBatch({ batchDir: empty }), 'batch-empty')
})

test('readBatch splits depends_on from the compiler request and preserves unique order', () => {
  const batch = makeBatch(['lane-a'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', {
    depends_on: ['lane-b', 'lane-b', 'lane-c'],
  })))
  const [lane] = readBatch({ batchDir: batch })
  assert.deepEqual(lane.depends_on, ['lane-b', 'lane-c'])
  assert.equal(Object.hasOwn(lane.request, 'depends_on'), false)
})

test('malformed depends_on values refuse batch-unreadable at their request path', () => {
  for (const depends_on of ['lane-a', [1], ['']]) {
    const batch = makeBatch(['lane-a'])
    put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { depends_on })))
    assert.throws(() => readBatch({ batchDir: batch }), (error) => error instanceof BatchRefusal
      && error.reason === 'batch-unreadable'
      && error.message.includes(`${batch}/lane-a${REQUEST_SUFFIX}`))
  }
})

test('planWaves places chains and diamonds in topological levels', () => {
  assert.deepEqual(planWaves({ lanes: [
    { lane: 'lane-a', depends_on: [] },
    { lane: 'lane-b', depends_on: ['lane-a'] },
  ] }).waves, [['lane-a'], ['lane-b']])
  assert.deepEqual(planWaves({ lanes: [
    { lane: 'lane-a', depends_on: [] },
    { lane: 'lane-b', depends_on: ['lane-a'] },
    { lane: 'lane-c', depends_on: ['lane-a'] },
    { lane: 'lane-d', depends_on: ['lane-b', 'lane-c'] },
  ] }).waves, [['lane-a'], ['lane-b', 'lane-c'], ['lane-d']])
})

test('planWaves refuses cycles, self-edges, and unknown predecessors by name', () => {
  assert.throws(() => planWaves({ lanes: [
    { lane: 'lane-a', depends_on: ['lane-b'] },
    { lane: 'lane-b', depends_on: ['lane-a'] },
  ] }), (error) => error instanceof BatchRefusal
    && error.reason === 'dependency-cycle'
    && error.message.includes('lane-a') && error.message.includes('lane-b'))
  refusal(() => planWaves({ lanes: [{ lane: 'lane-a', depends_on: ['lane-a'] }] }), 'dependency-cycle')
  assert.throws(() => planWaves({ lanes: [{ lane: 'lane-a', depends_on: ['missing'] }] }), (error) => error instanceof BatchRefusal
    && error.reason === 'dependency-unknown'
    && error.message.includes('missing')
    && !error.message.includes('dependency cycle'))
})

test('planWaves records transitive ancestors and the no-edges wave', () => {
  const planned = planWaves({ lanes: [
    { lane: 'lane-a', depends_on: [] },
    { lane: 'lane-b', depends_on: ['lane-a'] },
    { lane: 'lane-c', depends_on: ['lane-b'] },
  ] })
  assert.equal(planned.graph.hasEdges, true)
  assert.deepEqual([...planned.graph.ancestors.get('lane-c')], ['lane-b', 'lane-a'])
  const flat = planWaves({ lanes: [{ lane: 'lane-b' }, { lane: 'lane-a' }] })
  assert.deepEqual(flat.waves, [['lane-b', 'lane-a']])
  assert.equal(flat.graph.hasEdges, false)
})

test('worktree-exists and branch-taken are first checks with named refusals', () => {
  refusal(() => planWorktrees({
    lanes: ['lane-a'], parentDir: root, checkout: root,
    deps: { existsSync: () => true, spawn: () => ({ status: 1 }) },
  }), 'worktree-exists')
  refusal(() => planWorktrees({
    lanes: ['lane-a'], parentDir: root, checkout: root,
    deps: { existsSync: () => false, spawn: () => ({ status: 0 }) },
  }), 'branch-taken')
})

test('checkFences refuses sibling leakage before any worktree subprocess', () => {
  const fences = [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])]
  const lanes = [{ lane: 'lane-a', where: ['crew/shared.mjs'] }, { lane: 'lane-b', where: ['crew/shared.mjs'] }]
  refusal(() => checkFences({ fences, lanes }), 'sibling-leak')
})

test('checkFences refuses a register superset by name', () => {
  assert.throws(() => checkFences({
    fences: [entry('lane-a', ['crew/owned-a.mjs']), entry('lane-b', ['crew/owned-b.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/owned-a.mjs'] }],
    deps: { readdirSync: () => [], log: () => {} },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'fence-register-mismatch'
    && error.message.includes('lane-b')
    && error.message.includes('fence-count-mismatch'))
})

test('checkFences still refuses a batch lane absent from the register', () => {
  // This is the pre-existing direction of the same invariant: batch membership without a register entry.
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned-a.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['crew/owned-a.mjs'] },
      { lane: 'lane-b', where: ['crew/owned-b.mjs'] },
    ],
  }), 'lane-unfenced')
})

test('dispatchBatch refuses a register superset before any worktree exists', async () => {
  const spawned = []
  const batch = makeBatch(['lane-a'])
  await assert.rejects(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs']), entry('lane-b', ['crew/owned-lane-b.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'register-superset-dry-run-out'),
    tier: 'mechanical',
    variant: 'full',
    runFlags: { 'dry-run': true },
    deps: {
      home: root,
      env: { DEVTEAM_LEDGER_DIR: root },
      existsSync: () => false,
      spawn: (call) => { spawned.push(call); return { status: 1, stdout: '', stderr: '' } },
      log: () => {},
    },
  }), (error) => error instanceof BatchRefusal && error.reason === 'fence-register-mismatch')
  assert.equal(spawned.length, 0)
})

test('checkFences inherits an overlap only across its declared edge', () => {
  const fences = [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])]
  const edge = [
    { lane: 'lane-a', where: ['crew/shared.mjs'], depends_on: [] },
    { lane: 'lane-b', where: ['crew/shared.mjs'], depends_on: ['lane-a'] },
  ]
  const { graph } = planWaves({ lanes: edge })
  assert.doesNotThrow(() => checkFences({ fences, lanes: edge, graph }))
  refusal(() => checkFences({ fences, lanes: edge.map((lane) => ({ ...lane, depends_on: [] })) }), 'sibling-leak')
  const unrelated = [
    ...edge,
    { lane: 'lane-c', where: ['crew/shared.mjs'], depends_on: [] },
  ]
  const unrelatedFences = [...fences, entry('lane-c', ['crew/shared.mjs'])]
  const unrelatedGraph = planWaves({ lanes: unrelated }).graph
  refusal(() => checkFences({ fences: unrelatedFences, lanes: unrelated, graph: unrelatedGraph }), 'sibling-leak')
})

test('checkFences pins own coverage, register membership, and scope entry shape', () => {
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/not-owned.mjs'] }],
  }), 'where-outside-fence')
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/owned.mjs'], creates: ['crew/not-owned.mjs'] }],
  }), 'where-outside-fence')
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    lanes: [{ lane: 'lane-b', where: ['crew/owned.mjs'] }],
  }), 'lane-unfenced')
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/*'])],
    lanes: [{ lane: 'lane-a', where: ['crew/owned.mjs'] }],
  }), 'scope-entry-invalid')
  refusal(() => checkFences({
    fences: [entry('lane-a', [null])],
    lanes: [{ lane: 'lane-a', where: ['null'] }],
  }), 'scope-entry-invalid')
  refusal(() => checkFences({
    fences: [{ lane: 'lane-a', files: 'crew/owned.mjs' }],
    lanes: [{ lane: 'lane-a', where: ['crew/owned.mjs'] }],
  }), 'scope-entry-invalid')
})

function warningFixture(checkout) {
  const manifests = {
    'backend-node': {
      'crew/drive.mjs:124': 'a',
      'crew/drive.mjs:238': 'b',
      'crew/drive.mjs:244': 'c',
      'crew/drive.test.mjs:4158': 'd',
      'crew/drive.test.mjs:4159': 'e',
    },
    'crew-dispatch': {
      'crew/drive.mjs:23': 'f',
      'crew/drive.mjs:44': 'g',
      'crew/drive.mjs:339': 'h',
    },
    'crew-recovery': {
      'crew/drive.mjs:2511': 'i',
      'crew/drive.test.mjs:2513': 'j',
    },
  }
  anchorFixtures(checkout, manifests)
  return {
    files: ['crew/drive.mjs', 'crew/drive.test.mjs'],
    manifestPaths: Object.keys(manifests).map((skill) => `skills/${skill}/anchors.json`),
    keys: Object.values(manifests).flatMap((pins) => Object.keys(pins)),
  }
}

test('trips-and-dispatches: an unfenced anchor scan returns with the per-lane report intact', () => {
  const checkout = join(root, 'anchor-warning-checkout')
  const fixture = warningFixture(checkout)
  const report = checkFences({
    fences: [entry('lane-a', fixture.files)],
    lanes: [{ lane: 'lane-a', where: fixture.files }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  assert.deepEqual(report.perLane['lane-a'].files, fixture.files)
  assert.deepEqual(report.perLane['lane-a'].where, fixture.files)
  assert.equal(report.warnings.length, 1)
})

test('an anchor warning names both pinned files, all manifests, and every line key', () => {
  const checkout = join(root, 'anchor-warning-details-checkout')
  const fixture = warningFixture(checkout)
  const report = checkFences({
    fences: [entry('lane-a', fixture.files)],
    lanes: [{ lane: 'lane-a', where: fixture.files }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  const text = report.warnings[0].text
  for (const token of [...fixture.files, ...fixture.manifestPaths, ...fixture.keys]) {
    assert.equal(text.includes(token), true, `warning omitted ${token}`)
  }
})

test('an anchor warning carries the blind-spot sentence', () => {
  const checkout = join(root, 'anchor-warning-blind-spot-checkout')
  const fixture = warningFixture(checkout)
  const report = checkFences({
    fences: [entry('lane-a', fixture.files)],
    lanes: [{ lane: 'lane-a', where: fixture.files }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  assert.equal(report.warnings[0].text.includes(ANCHOR_BLIND_SPOT), true)
})

test('dry-run warns with the anchor prefix and every line key', async () => {
  const checkout = join(root, 'anchor-warning-dry-run-checkout')
  const fixture = warningFixture(checkout)
  const batch = join(root, 'anchor-warning-dry-run-batch')
  mkdirSync(batch)
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure the anchor warning', fixture.files)))
  const logs = []
  const report = await dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', fixture.files)],
    checkout,
    parentDir: root,
    outDir: join(root, 'anchor-warning-dry-run-out'),
    runFlags: { 'dry-run': true },
    deps: {
      home: root,
      env: { DEVTEAM_LEDGER_DIR: root },
      existsSync: (path) => String(path).endsWith('anchors.json') ? fsExistsSync(path) : false,
      spawn: () => ({ status: 1 }),
      log: (line) => logs.push(String(line)),
    },
  })
  assert.equal(report.dryRun, true)
  const warning = logs.find((line) => line.includes(ANCHOR_PIN_WARNING_PREFIX))
  assert.ok(warning)
  for (const key of fixture.keys) assert.equal(warning.includes(key), true, `dry-run omitted ${key}`)
})

test('a lane that owns every pinning manifest is silent', () => {
  const checkout = join(root, 'anchor-warning-owned-checkout')
  const fixture = warningFixture(checkout)
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', [...fixture.files, ...fixture.manifestPaths])],
    lanes: [{ lane: 'lane-a', where: fixture.files }],
    checkout,
    deps: { home: root, log: (line) => logs.push(String(line)) },
  })
  assert.equal(report.warnings.length, 0)
  assert.equal(logs.some((line) => line.includes(ANCHOR_PIN_WARNING_PREFIX)), false)
})

test('a directory write surface still warns for a pinned descendant', () => {
  const checkout = join(root, 'anchor-directory-checkout')
  anchorFixtures(checkout, {
    devops: { 'crew/subdir/owned.mjs:12': 'export const OWNED = 1' },
  })
  const report = checkFences({
    fences: [entry('lane-a', ['crew/subdir/'])],
    lanes: [{ lane: 'lane-a', where: ['crew/subdir/'] }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  assert.equal(report.warnings.length, 1)
  assert.equal(report.warnings[0].text.includes('crew/subdir/owned.mjs'), true)
  assert.equal(report.warnings[0].text.includes('skills/devops/anchors.json'), true)
})

test("b220's corrected fence owns both pinning manifests and passes silently", () => {
  const checkout = join(root, 'anchor-fenced-checkout')
  anchorFixtures(checkout, {
    'crew-recovery': { 'crew/crew.mjs:664': 'export function reseat(' },
    devops: {
      'crew/crew.mjs:1881': 'const KEEP_ON_DONE = false',
      'crew/crew.mjs:2133': 'function paneCommand(role',
    },
  })
  const files = [
    'crew/crew.mjs',
    'crew/crew.test.mjs',
    'skills/crew-recovery/anchors.json',
    'skills/crew-recovery/references/closeout.md',
    'skills/devops/anchors.json',
    'skills/devops/SKILL.md',
    'skills/devops/references/worktrees.md',
    'skills/devops/references/processes.md',
    'crew/tree-fingerprint.mjs',
    'crew/tree-fingerprint.test.mjs',
  ]
  const report = checkFences({
    fences: [entry('b220-treefingerprint', files)],
    lanes: [{
      lane: 'b220-treefingerprint',
      where: files.slice(0, 8),
      creates: files.slice(8),
    }],
    checkout,
  })
  assert.deepEqual(report.perLane['b220-treefingerprint'].creates, files.slice(8))
})

test('a batch touching no pinned file passes and reads each manifest once', () => {
  const checkout = join(root, 'anchor-count-checkout')
  anchorFixtures(checkout, {
    'backend-node': { 'crew/arms.mjs:12': 'export function arm(' },
    'crew-dispatch': { 'scripts/factory/dispatch-batch.mjs:18': "TRANSPORT_CONFLICT = 'transport-conflict'" },
    'crew-recovery': { 'crew/crew.mjs:664': 'export function reseat(' },
    devops: { 'crew/crew.mjs:1881': 'const KEEP_ON_DONE = false' },
  })
  let reads = 0
  const deps = {
    readFileSync: (path, encoding) => {
      if (String(path).endsWith('anchors.json')) reads += 1
      return readFileSync(path, encoding)
    },
  }
  const lanes = ['lane-a', 'lane-b', 'lane-c']
  assert.doesNotThrow(() => checkFences({
    fences: lanes.map((lane) => entry(lane, [`crew/owned-${lane}.mjs`])),
    lanes: lanes.map((lane) => ({ lane, where: [`crew/owned-${lane}.mjs`] })),
    checkout,
    deps,
  }))
  assert.equal(reads, 4)
})

test('a plan declaring a path outside the lane fence refuses and names only the offender', () => {
  assert.throws(() => checkPlanScope({
    lane: 'lane-a',
    declared: ['crew/crew.mjs', 'skills/other/anchors.json'],
    files: ['crew/crew.mjs'],
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'plan-scope-outside-fence'
    && error.message.includes('skills/other/anchors.json'))
})

test('a strict subset and a created path inside the fence both pass', () => {
  assert.doesNotThrow(() => checkPlanScope({
    lane: 'lane-a',
    declared: ['crew/crew.mjs'],
    files: ['crew/crew.mjs', 'crew/crew.test.mjs'],
  }))
  assert.doesNotThrow(() => checkPlanScope({
    lane: 'lane-a',
    declared: ['crew/new/file.mjs', './crew/new/other.mjs'],
    files: ['crew/new/'],
  }))
})

test('collectAnchorPins skips an unreadable or malformed manifest', () => {
  const checkout = join(root, 'anchor-malformed-checkout')
  anchorFixtures(checkout, {
    valid: { 'crew/owned.mjs:12': 'export const OWNED = 1' },
    malformed: 'not json',
  })
  assert.doesNotThrow(() => {
    const pins = collectAnchorPins({ checkout })
    assert.deepEqual([...pins.byFile.keys()], ['crew/owned.mjs'])
    assert.deepEqual(pins.manifests, ['skills/valid/anchors.json'])
  })
})

test('created paths are covered by the own fence, cannot leak to a sibling, and are reported per lane', () => {
  assert.throws(() => checkFences({
    fences: [
      entry('lane-a', ['skills/crew-dispatch/']),
      entry('lane-b', ['skills/crew-dispatch/references/new.md']),
    ],
    lanes: [{ lane: 'lane-a', where: [], creates: ['./skills/crew-dispatch/references/new.md'] }, { lane: 'lane-b', where: [] }],
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'sibling-leak'
    && error.message.includes('skills/crew-dispatch/references/new.md'))

  const report = checkFences({
    fences: [entry('lane-a', ['crew/new/']), entry('lane-b', ['docs/reference/'])],
    lanes: [{ lane: 'lane-a', where: [], creates: ['./crew/new/file.mjs'] }, { lane: 'lane-b', where: [] }],
  })
  assert.deepEqual(report.perLane['lane-a'].creates, ['crew/new/file.mjs'])
})

test('crew state paths and arrival checks use the runtime slug and exact sibling count', () => {
  assert.match(crewJsonPath({ checkout: '/tmp/dt-lane-a', lane: 'lane_a' }), /\/lane-a\/crew\.json$/)
  refusal(() => checkArrival({ crew: { lane_fence: [] }, lane: 'lane-a', batchTotal: 1 }), 'fence-not-arrived')
  refusal(() => checkArrival({ crew: { lane_name: 'lane-a', lane_fence: [] }, lane: 'lane-a', batchTotal: 2 }), 'fence-count-mismatch')
  assert.deepEqual(
    checkArrival({ crew: { lane_name: 'lane-a', lane_fence: [{ lane: 'lane-b', files: [] }] }, lane: 'lane-a', batchTotal: 2 }),
    { lane: 'lane-a', siblings: [{ lane: 'lane-b', files: [] }] },
  )
})

test('tier floor and reconciliation keep the protected path at judge', () => {
  assert.deepEqual(tierFloor({ files: ['crew/drive.mjs'] }), {
    hits: ['crew/drive.mjs'], forced: 'judge', floor: 'judge',
  })
  assert.equal(tierFloor({ files: ['skills/crew-dispatch/references/batch.md'] }).forced, null)
  refusal(() => reconcileTier({ lane: 'lane-a', forced: 'judge', proposed: 'build', requested: 'build' }), 'tier-floor-conflict')
  assert.equal(reconcileTier({ lane: 'lane-a', forced: null, proposed: 'build', requested: 'judge' }).tier, 'judge')
  assert.equal(reconcileTier({ lane: 'lane-a', forced: null, proposed: null, requested: null }).tier, null)
})

test('REFUSAL_REASONS is frozen, unique, and names every reason argument in the source', () => {
  assert.equal(Object.isFrozen(REFUSAL_REASONS), true)
  assert.equal(new Set(REFUSAL_REASONS).size, REFUSAL_REASONS.length)
  const source = readFileSync(join(repoRoot, 'scripts', 'factory', 'dispatch-batch.mjs'), 'utf8')
  const constants = new Map([...source.matchAll(/const\s+([A-Z_]+)\s*=\s*'([^']+)'/g)].map((match) => [match[1], match[2]]))
  const names = []
  for (const line of source.split('\n').filter((line) => line.includes('refuse('))) {
    const match = /,\s*([A-Z_]+)\)/.exec(line)
    if (match) names.push(match[1])
  }
  const thrown = new Set(names.map((name) => constants.get(name)).filter(Boolean))
  assert.deepEqual(new Set(REFUSAL_REASONS), thrown)
})

test('readsFromRefusal parses both compiler refusal shapes from real compiler output', () => {
  const checkout = gitFixture()
  const batch = join(checkout, 'batch')
  mkdirSync(batch)
  put(join(batch, 'lane-a.request.json'), JSON.stringify(request('measure owned source behavior', ['src/owned.mjs'])))
  const out = join(checkout, 'out')
  mkdirSync(out)
  const coupledRegister = join(checkout, 'coupled-register.json')
  put(coupledRegister, JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs'], [])] }))
  const coupled = spawnSync(process.execPath, [
    compiler, '--request', join(batch, 'lane-a.request.json'), '--checkout', checkout,
    '--fences', coupledRegister, '--lane', 'lane-a', '--out', join(out, 'coupled.md'), '--force',
  ], { cwd: repoRoot, encoding: 'utf8' })
  assert.notEqual(coupled.status, 0)
  const first = readsFromRefusal(coupled.stderr)
  assert.equal(first.reason, COUPLED_SOURCE_UNFENCED)
  assert.deepEqual(first.files, ['src/coupled.mjs'])

  const staleRegister = join(checkout, 'stale-register.json')
  put(staleRegister, JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs', 'src/coupled.mjs'], [{ file: 'src/stale.mjs', why: 'fixture stale acknowledgement' }])] }))
  const stale = spawnSync(process.execPath, [
    compiler, '--request', join(batch, 'lane-a.request.json'), '--checkout', checkout,
    '--fences', staleRegister, '--lane', 'lane-a', '--out', join(out, 'stale.md'), '--force',
  ], { cwd: repoRoot, encoding: 'utf8' })
  assert.notEqual(stale.status, 0)
  const second = readsFromRefusal(stale.stderr)
  assert.equal(second.reason, STALE_READ_ACK)
  assert.deepEqual(second.files, ['src/stale.mjs'])
})

test('dispatchBatch refuses a leaking register before spawning any subprocess', async () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  const spawned = []
  const deps = {
    home: root,
    env: { DEVTEAM_LEDGER_DIR: root },
    readdirSync: () => ['lane-a.request.json', 'lane-b.request.json'],
    readFileSync: (path) => {
      const lane = String(path).split('/').pop().replace(REQUEST_SUFFIX, '')
      return JSON.stringify(request(`measure ${lane} source behavior`, ['crew/shared.mjs']))
    },
    existsSync: () => false,
    spawn: (call) => { spawned.push(call); return { status: 0 } },
  }
  await refusalAsync(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])],
    checkout: root, parentDir: root, outDir: join(root, 'out'), deps,
  }), 'sibling-leak')
  assert.equal(spawned.length, 0)
})

test('dispatchBatch compiles lanes concurrently and then boots and runs them', async () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  const out = join(root, 'concurrent-out')
  const baseline = join(root, 'concurrent-baseline.json')
  put(baseline, JSON.stringify({ sha: 'a'.repeat(40), command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const fences = [entry('lane-a', ['crew/owned-a.mjs']), entry('lane-b', ['crew/owned-b.mjs'])]
  const spawned = []
  const events = []
  let started = 0
  let release
  const allStarted = new Promise((resolve) => { release = resolve })
  const deps = {
    home: root,
    env: { DEVTEAM_LEDGER_DIR: root },
    existsSync: () => false,
    readdirSync: () => ['lane-a.request.json', 'lane-b.request.json'],
    readFileSync: (path) => {
      const text = String(path)
      if (text.endsWith(REQUEST_SUFFIX)) {
        const lane = text.split('/').pop().replace(REQUEST_SUFFIX, '')
        return JSON.stringify(request(`measure ${lane} source behavior`, [`crew/owned-${lane.slice(-1)}.mjs`]))
      }
      if (text.endsWith('.brief.md')) return '```proposal\n{"shape":"build","strength":null}\n```\n'
      if (text.endsWith('/package.json')) return JSON.stringify({ private: true, scripts: { test: 'npm test' } })
      if (text.endsWith('/crew.json')) {
        const parts = text.split('/')
        const lane = parts[parts.length - 2]
        const sibling = lane === 'lane-a' ? 'lane-b' : 'lane-a'
        return JSON.stringify({ lane_name: lane, lane_fence: [{ lane: sibling, files: [] }] })
      }
      return readFileSync(text, 'utf8')
    },
    spawn: (call) => {
      spawned.push(call)
      if (call.args.includes('rev-parse') && call.args.includes('HEAD')) return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (call.args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    spawnAsync: async (call) => {
      spawned.push(call)
      const lane = call.args[call.args.indexOf('--lane') + 1]
      events.push(`start:${lane}`)
      started += 1
      if (started === 2) release()
      await allStarted
      events.push(`end:${lane}`)
      return { status: 0, stdout: '', stderr: '' }
    },
    log: () => {},
  }
  const report = await dispatchBatch({
    batchDir: batch, fences, checkout: root, parentDir: root, outDir: out,
    tier: 'mechanical', variant: 'full', runFlags: { baseline }, deps,
  })
  assert.deepEqual(report.lanes.map(({ lane }) => lane), ['lane-a', 'lane-b'])
  const firstEnd = events.findIndex((event) => event.startsWith('end:'))
  assert.equal(events.slice(0, firstEnd).filter((event) => event.startsWith('start:')).length, 2)
  const compileCalls = spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(compileCalls.length, 2)
  assert.equal(spawned.filter(({ args }) => args.includes('worktree')).length, 2)
  const runCalls = spawned.filter(({ args }) => args.includes('run'))
  assert.equal(runCalls.length, 2)
  assert.equal(runCalls.every((call) => call.background === true && String(call.logPath).endsWith('/run.log')), true)
})

async function fakedDispatch({ label, names, shaFor, measurementStatus = 0 }) {
  const batch = makeBatch(names)
  for (const lane of names) {
    put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(request(
      `measure ${lane} source behavior`, [`crew/owned-${lane}.mjs`],
    )))
  }
  const out = join(root, `baseline-${label}-out`)
  const parent = join(root, `baseline-${label}-parent`)
  const spawned = []
  const deps = {
    home: root,
    env: { DEVTEAM_LEDGER_DIR: root },
    existsSync: () => false,
    readdirSync: () => names.map((lane) => `${lane}${REQUEST_SUFFIX}`),
    readFileSync: (path, encoding) => {
      const text = String(path)
      if (text.endsWith(REQUEST_SUFFIX)) return readFileSync(text, 'utf8')
      if (text.endsWith('.brief.md')) return '```proposal\n{"shape":"build","strength":null}\n```\n'
      if (text.endsWith('/crew.json')) {
        const lane = text.split('/').at(-2)
        const siblings = names.filter((candidate) => candidate !== lane)
        return JSON.stringify({
          lane_name: lane,
          lane_fence: siblings.map((sibling) => ({ lane: sibling, files: [] })),
        })
      }
      return readFileSync(text, encoding || 'utf8')
    },
    spawn: (call) => {
      spawned.push(call)
      const args = (call.args || []).map(String)
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        const index = args.indexOf('-C')
        const target = index === -1 ? String(call.cwd || '') : args[index + 1]
        return { status: 0, stdout: `${shaFor(target)}\n`, stderr: '' }
      }
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      if (args.includes('--measure-baseline')) {
        return { status: measurementStatus, stdout: '', stderr: measurementStatus === 0 ? '' : 'measurement failed' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
    log: () => {},
  }
  const report = await dispatchBatch({
    batchDir: batch,
    fences: names.map((lane) => entry(lane, [`crew/owned-${lane}.mjs`])),
    checkout: root,
    parentDir: parent,
    outDir: out,
    tier: 'mechanical',
    variant: 'full',
    deps,
  })
  const measures = spawned.filter(({ args }) => (args || []).map(String).includes('--measure-baseline'))
  const compiles = spawned.filter(({ args }) => {
    const list = (args || []).map(String)
    return list.some((arg) => arg.endsWith('make-brief.mjs')) && list.includes('--request')
  })
  return { report, spawned, measures, compiles }
}

async function dispatchFixture({
  label,
  names = ['lane-a', 'lane-b'],
  requests = {},
  fences,
  batchTier = 'mechanical',
  runFlags = {},
  brief = briefWithBlockOnly,
  briefs = {},
  workspaceFor = (lane) => `ws-${lane}`,
  outcomes = {},
  ancestor = () => 0,
  spawnResult = () => ({ status: 0, stdout: '', stderr: '' }),
  spawnAsync = null,
  assertQuiet = null,
  headFor = null,
  readObserver = () => {},
  home = root,
} = {}) {
  const batch = join(root, `dispatch-${label}-${Math.random().toString(36).slice(2)}`)
  const parent = join(root, `dispatch-${label}-parent`)
  const out = join(root, `dispatch-${label}-out`)
  mkdirSync(batch, { recursive: true })
  const authored = Object.fromEntries(names.map((lane) => [lane, requests[lane] || requestFor(lane)]))
  for (const lane of names) put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(authored[lane]))
  const spawned = []
  const logs = []
  const laneFences = fences || names.map((lane) => entry(lane, [`crew/owned-${lane}.mjs`]))
  const deps = {
    home,
    env: { DEVTEAM_LEDGER_DIR: join(home, 'factory-state') },
    existsSync: (path) => String(path).endsWith('returns/task.json')
      && Object.hasOwn(outcomes, laneFromOutcomePath(String(path))),
    readdirSync: () => names.map((lane) => `${lane}${REQUEST_SUFFIX}`),
    readFileSync: (path, encoding) => {
      const text = String(path)
      readObserver(text)
      if (text.endsWith(REQUEST_SUFFIX) && text.startsWith(batch)) {
        const name = basenameOf(text)
        const lane = name.slice(0, -REQUEST_SUFFIX.length)
        return JSON.stringify(authored[lane])
      }
      if (text.endsWith('.brief.md')) {
        const lane = basenameOf(text).slice(0, -'.brief.md'.length)
        return briefs[lane] ?? brief
      }
      if (text.endsWith('returns/task.json')) return JSON.stringify(outcomes[laneFromOutcomePath(text)])
      if (text.endsWith('/package.json')) return JSON.stringify({ private: true, scripts: { test: 'npm test' } })
      if (text.endsWith('/crew.json')) {
        const lane = text.split('/').at(-2)
        return JSON.stringify({
          lane_name: lane,
          lane_fence: names.filter((candidate) => candidate !== lane).map((sibling) => ({ lane: sibling, files: [] })),
          workspace_id: workspaceFor(lane),
        })
      }
      return readFileSync(text, encoding || 'utf8')
    },
    spawn: (call) => {
      spawned.push(call)
      const args = (call.args || []).map(String)
      if (args.includes('merge-base')) return { status: ancestor(args), stdout: '', stderr: '' }
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        const index = args.indexOf('-C')
        const target = index === -1 ? String(call.cwd || '') : args[index + 1]
        return headFor ? { status: 0, stdout: `${headFor(target)}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }
      }
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      return spawnResult(args, call)
    },
    ...(spawnAsync ? { spawnAsync: (call) => { spawned.push(call); return spawnAsync(call) } } : {}),
    ...(assertQuiet ? { assertQuiet } : {}),
    log: (line) => logs.push(String(line)),
  }
  const report = await dispatchBatch({
    batchDir: batch,
    fences: laneFences,
    checkout: root,
    parentDir: parent,
    outDir: out,
    tier: batchTier,
    variant: 'full',
    runFlags,
    deps,
  })
  return { report, spawned, logs, batch, parent, out, fences: laneFences }
}

function basenameOf(path) {
  return String(path).split('/').at(-1)
}

function laneFromOutcomePath(path) {
  return String(path).split('/').at(-3)
}

function cachePath(home, sha) {
  return join(home, 'factory-state', 'baselines', `${sha}.json`)
}

test('a four-lane batch measures the baseline once', async () => {
  const names = ['lane-a', 'lane-b', 'lane-c', 'lane-d']
  const result = await fakedDispatch({ label: 'four', names, shaFor: () => 'a'.repeat(40) })
  // Measured mechanism: four lanes cost four suite runs before this lane and one after.
  assert.equal(result.measures.length, 1)
  assert.equal(result.compiles.length, 4)
  assert.equal(result.compiles.every(({ args }) => (args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 4)
})

test('lanes on different commits fall back to measuring per lane', async () => {
  const names = ['lane-a', 'lane-b', 'lane-c']
  const result = await fakedDispatch({
    label: 'divergent', names,
    shaFor: (target) => String(target).endsWith('lane-a') ? 'a'.repeat(40) : 'b'.repeat(40),
  })
  assert.equal(result.measures.length, 0)
  assert.equal(result.compiles.length, 3)
  assert.equal(result.compiles.every(({ args }) => !(args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 3)
})

test('a failed batch measurement never refuses the batch', async () => {
  const names = ['lane-a', 'lane-b', 'lane-c']
  const result = await fakedDispatch({
    label: 'failed-measurement', names, shaFor: () => 'a'.repeat(40), measurementStatus: 1,
  })
  assert.equal(result.measures.length, 1)
  assert.equal(result.compiles.length, 3)
  assert.equal(result.compiles.every(({ args }) => !(args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 3)
})

test('a single-lane batch takes no separate batch measurement', async () => {
  const result = await fakedDispatch({ label: 'single', names: ['lane-a'], shaFor: () => 'a'.repeat(40) })
  assert.equal(result.measures.length, 0)
  assert.equal(result.compiles.length, 1)
  assert.equal(result.compiles.every(({ args }) => !(args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 1)
})

test('three lanes start compiling before any compile returns', async () => {
  const sha = 'a'.repeat(40)
  const home = join(root, 'concurrency-three-home')
  const baseline = join(root, 'concurrency-three-baseline.json')
  put(baseline, JSON.stringify({ sha, command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const events = []
  let started = 0
  let release
  let timer
  const allStarted = new Promise((resolve) => {
    release = () => {
      if (timer) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(release, 250)
  })
  const result = await dispatchFixture({
    label: 'concurrency-three',
    names: ['lane-a', 'lane-b', 'lane-c'],
    home,
    headFor: () => sha,
    runFlags: { baseline },
    spawnAsync: async (call) => {
      const lane = call.args[call.args.indexOf('--lane') + 1]
      events.push(`start:${lane}`)
      started += 1
      if (started === 3) release()
      await allStarted
      events.push(`end:${lane}`)
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  const firstEnd = events.findIndex((event) => event.startsWith('end:'))
  assert.equal(events.slice(0, firstEnd).filter((event) => event.startsWith('start:')).length, 3)
  assert.equal(result.report.lanes.length, 3)
})

test('a refused compile names its lane and cannot be masked by a sibling success', async () => {
  const sha = 'a'.repeat(40)
  const baseline = join(root, 'refused-lane-baseline.json')
  put(baseline, JSON.stringify({ sha, command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const started = []
  let boots = 0
  await assert.rejects(() => dispatchFixture({
    label: 'refused-lane',
    home: join(root, 'refused-lane-home'),
    headFor: () => sha,
    runFlags: { baseline },
    spawnAsync: async (call) => {
      const lane = call.args[call.args.indexOf('--lane') + 1]
      started.push(lane)
      return lane === 'lane-a'
        ? { status: 1, stdout: '', stderr: 'compiler refused the lane without a named retry' }
        : { status: 0, stdout: '', stderr: '' }
    },
    spawnResult: (args) => {
      if (args.includes('boot')) boots += 1
      return { status: 0, stdout: '', stderr: '' }
    },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'reads-unresolved'
    && error.message.includes('lane-a'))
  assert.deepEqual(started.sort(), ['lane-a', 'lane-b'])
  assert.equal(boots, 0)
})

test('at-risk compiles are serialised with a host quiet consult between them', async () => {
  const baseline = join(root, 'at-risk-baseline.json')
  put(baseline, JSON.stringify({ sha: 'b'.repeat(40) }))
  const events = []
  const result = await dispatchFixture({
    label: 'at-risk-serial',
    home: join(root, 'at-risk-serial-home'),
    headFor: () => 'a'.repeat(40),
    runFlags: { baseline },
    assertQuiet: () => { events.push('quiet') },
    spawnAsync: async (call) => {
      const lane = call.args[call.args.indexOf('--lane') + 1]
      events.push(`start:${lane}`)
      events.push(`end:${lane}`)
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(events, [
    'quiet', 'start:lane-a', 'end:lane-a',
    'quiet', 'start:lane-b', 'end:lane-b',
  ])
  assert.equal(result.report.lanes.length, 2)
})

test('a matching-sha baseline with a different command is serialised as a fallback', async () => {
  const sha = 'a'.repeat(40)
  const baseline = join(root, 'at-risk-command-baseline.json')
  put(baseline, JSON.stringify({ sha, command: 'npm run other-suite', pass: 1, fail: 0, status: 'green' }))
  const events = []
  const result = await dispatchFixture({
    label: 'at-risk-command',
    home: join(root, 'at-risk-command-home'),
    headFor: () => sha,
    runFlags: { baseline },
    assertQuiet: () => { events.push('quiet') },
    spawnAsync: async (call) => {
      const lane = call.args[call.args.indexOf('--lane') + 1]
      events.push(`start:${lane}`)
      events.push(`end:${lane}`)
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(events, [
    'quiet', 'start:lane-a', 'end:lane-a',
    'quiet', 'start:lane-b', 'end:lane-b',
  ])
  assert.equal(result.report.lanes.length, 2)
})

test('a matching sha and command cache hit skips measurement and reaches every compiler', async () => {
  const sha = 'a'.repeat(40)
  const home = join(root, 'cache-hit-home')
  const entryPath = cachePath(home, sha)
  put(entryPath, JSON.stringify({ sha, command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const result = await dispatchFixture({
    label: 'cache-hit',
    home,
    headFor: () => sha,
  })
  const measures = result.spawned.filter(({ args }) => args.includes('--measure-baseline'))
  const compiles = result.spawned.filter(({ args }) => args.includes('--request') && args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(measures.length, 0)
  assert.equal(compiles.length, 2)
  assert.equal(compiles.every(({ args }) => args[args.indexOf('--baseline') + 1] === entryPath), true)
})

test('a cache record for another sha is replaced by a fresh measurement', async () => {
  const sha = 'a'.repeat(40)
  const home = join(root, 'cache-sha-miss-home')
  const entryPath = cachePath(home, sha)
  put(entryPath, JSON.stringify({ sha: 'b'.repeat(40), command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const result = await dispatchFixture({
    label: 'cache-sha-miss',
    home,
    headFor: () => sha,
    spawnResult: (args) => {
      if (args.includes('--measure-baseline')) {
        put(args[args.indexOf('--measure-baseline') + 1], JSON.stringify({ sha, command: 'npm test', pass: 2, fail: 0, status: 'green' }))
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(result.spawned.filter(({ args }) => args.includes('--measure-baseline')).length, 1)
  assert.equal(JSON.parse(readFileSync(entryPath, 'utf8')).sha, sha)
})

test('a cache record for another command is replaced by a fresh measurement', async () => {
  const sha = 'a'.repeat(40)
  const home = join(root, 'cache-command-miss-home')
  const entryPath = cachePath(home, sha)
  put(entryPath, JSON.stringify({ sha, command: 'npm run other-suite', pass: 1, fail: 0, status: 'green' }))
  const result = await dispatchFixture({
    label: 'cache-command-miss',
    home,
    headFor: () => sha,
    spawnResult: (args) => {
      if (args.includes('--measure-baseline')) {
        put(args[args.indexOf('--measure-baseline') + 1], JSON.stringify({ sha, command: 'npm test', pass: 2, fail: 0, status: 'green' }))
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(result.spawned.filter(({ args }) => args.includes('--measure-baseline')).length, 1)
  assert.equal(JSON.parse(readFileSync(entryPath, 'utf8')).command, 'npm test')
})

test('an operator baseline wins over a valid cache hit', async () => {
  const sha = 'a'.repeat(40)
  const home = join(root, 'operator-baseline-home')
  const cached = cachePath(home, sha)
  put(cached, JSON.stringify({ sha, command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const supplied = join(root, 'operator-baseline.json')
  put(supplied, JSON.stringify({ sha }))
  const result = await dispatchFixture({
    label: 'operator-baseline',
    home,
    headFor: () => sha,
    runFlags: { baseline: supplied },
  })
  const compiles = result.spawned.filter(({ args }) => args.includes('--request') && args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(result.spawned.filter(({ args }) => args.includes('--measure-baseline')).length, 0)
  assert.equal(compiles.every(({ args }) => args[args.indexOf('--baseline') + 1] === supplied), true)
  assert.equal(compiles.every(({ args }) => args[args.indexOf('--baseline') + 1] !== cached), true)
})

test('relocated baseline cache writes under DEVTEAM_LEDGER_DIR, not home', async () => {
  const sha = 'a'.repeat(40)
  const home = join(root, 'relocated-cache-home')
  const result = await dispatchFixture({
    label: 'relocated-cache',
    home,
    headFor: () => sha,
    spawnResult: (args) => {
      if (args.includes('--measure-baseline')) {
        put(args[args.indexOf('--measure-baseline') + 1], JSON.stringify({ sha, command: 'npm test', pass: 2, fail: 0, status: 'green' }))
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(fsExistsSync(cachePath(home, sha)), true)
  assert.equal(fsExistsSync(join(home, '.dev-team')), false)
  assert.equal(result.report.lanes.length, 2)
})

test('memory boot flags are forwarded verbatim and omitted when unset', async () => {
  const result = await dispatchFixture({
    label: 'memory-flags',
    names: ['lane-a', 'lane-b'],
    runFlags: { 'memory-dir': '/tmp/mem', 'memory-backend': 'sqlite', 'memory-budget-bytes': '4096' },
  })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  assert.equal(boots.length, 2)
  for (const { args } of boots) {
    for (const [flag, value] of [['--memory-dir', '/tmp/mem'], ['--memory-backend', 'sqlite'], ['--memory-budget-bytes', '4096']]) {
      assert.equal(args[args.indexOf(flag) + 1], value)
    }
  }
  const bare = await dispatchFixture({ label: 'memory-flags-absent', names: ['lane-a'] })
  for (const { args } of bare.spawned.filter(({ args }) => args.includes('boot'))) {
    assert.equal(args.some((arg) => String(arg).startsWith('--memory-')), false)
  }
})

test('parseCliArgs accepts baseline and memory values while preserving refusals', () => {
  assert.deepEqual(parseCliArgs([
    '--baseline', '/tmp/base.json', '--memory-dir', '/tmp/mem', '--memory-backend', 'sqlite', '--memory-budget-bytes', '4096',
  ]), {
    baseline: '/tmp/base.json',
    'memory-dir': '/tmp/mem',
    'memory-backend': 'sqlite',
    'memory-budget-bytes': '4096',
  })
  refusal(() => parseCliArgs(['--memory-bogus', 'x']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--baseline', 'a', '--baseline', 'b']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--baseline']), 'batch-unreadable')
})

test('parseCliArgs refuses missing values and unknown flags', () => {
  refusal(() => parseCliArgs(['--tier']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--not-a-flag', 'x']), 'batch-unreadable')
})

test('main loads the fence register, forwards dry-run, and returns a usage code', async () => {
  const checkout = gitFixture()
  const batch = join(checkout, 'main-batch')
  mkdirSync(batch)
  put(join(batch, 'lane-a.request.json'), JSON.stringify(request('measure main path behavior', ['src/owned.mjs'])))
  const register = join(checkout, 'main-fences.json')
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs'])] }))
  const code = await main([
    '--batch', batch,
    '--fences', register,
    '--checkout', checkout,
    '--parent', root,
    '--out', join(root, 'main-out'),
    '--dry-run',
  ], { home: root, env: { DEVTEAM_LEDGER_DIR: root }, existsSync: () => false, spawn: () => ({ status: 1 }), log: () => {} })
  assert.equal(code, 0)
  assert.equal(await main(['--unknown'], { log: () => {} }), 2)
})

test('an unsupported run variant refuses before any run launch', async () => {
  const batch = makeBatch(['lane-a'])
  const spawned = []
  await refusalAsync(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'bad-variant-out'),
    variant: 'not-a-variant',
    deps: { home: root, env: { DEVTEAM_LEDGER_DIR: root }, existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 1 } } },
  }), 'run-failed')
  assert.equal(spawned.some(({ args }) => args.includes('run')), false)
})

test('an unsupported run variant refuses BEFORE the branch probe, not after it', async () => {
  const batch = makeBatch(['lane-a'])
  const spawned = []
  // Both faults are present at once: the variant is invalid AND the lane branch
  // already exists (the probe answers status 0). Before the preflight was moved
  // above planWorktrees, the git probe ran first and the batch refused
  // `branch-taken` — naming a cause it tripped over instead of the one it
  // measured, and spawning a subprocess to do it (RV3-1).
  await refusalAsync(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'variant-before-probe-out'),
    variant: 'not-a-variant',
    deps: { home: root, env: { DEVTEAM_LEDGER_DIR: root }, existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 0 } } },
  }), 'run-failed')
  assert.deepEqual(spawned, [], 'no subprocess may run before the run options are preflighted')
})

test('moving the preflight earlier does not disarm branch-taken for valid run options', async () => {
  // The reverse direction: with the variant valid, the same taken branch must
  // still refuse `branch-taken`. A reorder that silenced this would trade one
  // wrong refusal for a missing one.
  const batch = makeBatch(['lane-a'])
  const spawned = []
  await refusalAsync(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'valid-variant-taken-branch-out'),
    variant: 'full',
    deps: { home: root, env: { DEVTEAM_LEDGER_DIR: root }, existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 0 } } },
  }), 'branch-taken')
  assert.equal(spawned.some(({ args }) => args.includes('rev-parse')), true)
})

test('--dry-run plans branch probes but creates no worktree', async () => {
  const batch = makeBatch(['lane-a'])
  const spawned = []
  const report = await dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'dry-run-out'),
    runFlags: { 'dry-run': true },
    deps: { home: root, env: { DEVTEAM_LEDGER_DIR: root }, existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 1 } }, log: () => {} },
  })
  assert.equal(report.dryRun, true)
  assert.equal(spawned.some(({ args }) => args.includes('worktree')), false)
})

test('a dispatch over a checkout with pinned files unrelated to the batch still dispatches', async () => {
  const checkout = gitFixture()
  const batch = join(checkout, 'pinned-dry-run-batch')
  mkdirSync(batch)
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure pinned dry-run behavior', ['src/owned.mjs'])))
  const fences = [entry('lane-a', ['src/owned.mjs'])]
  const deps = { home: root, env: { DEVTEAM_LEDGER_DIR: root }, existsSync: () => false, spawn: () => ({ status: 1 }), log: () => {} }
  const withoutManifest = await dispatchBatch({
    batchDir: batch,
    fences,
    checkout,
    parentDir: root,
    outDir: join(root, 'pinned-dry-run-out'),
    runFlags: { 'dry-run': true },
    deps,
  })
  anchorFixtures(checkout, { devops: { 'crew/other.mjs:12': 'export const OTHER = 1' } })
  const withManifest = await dispatchBatch({
    batchDir: batch,
    fences,
    checkout,
    parentDir: root,
    outDir: join(root, 'pinned-dry-run-out'),
    runFlags: { 'dry-run': true },
    deps,
  })
  assert.equal(JSON.stringify(withManifest.plans), JSON.stringify(withoutManifest.plans))
})

test('normalDeps supplies the house-style dependency surface', () => {
  const deps = normalDeps({})
  assert.deepEqual(Object.keys(deps).sort(), ['assertQuiet', 'env', 'existsSync', 'home', 'log', 'readFileSync', 'readdirSync', 'spawn', 'spawnAsync'])
})

test('compileLane performs at most two passes and carries compiler reads into a retry register', async () => {
  const batch = makeBatch(['lane-a'])
  const out = join(root, 'compile-out')
  const register = join(root, 'register.json')
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['crew/owned.mjs'], [])] }))
  const calls = []
  let pass = 0
  const result = await compileLane({
    lane: 'lane-a', batchDir: batch, laneDir: root, registerPath: register, outDir: out,
    fences: [entry('lane-a', ['crew/owned.mjs'], [])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        pass += 1
        if (pass === 1) return { status: 2, stderr: 'brief: coupled source(s) outside lane fence: crew/x.mjs · X [reason: coupled-source-unfenced]' }
        return { status: 0, stdout: '', stderr: '' }
      },
      readFileSync: (path) => path.endsWith('.brief.md') ? briefWithTierAndShape : readFileSync(path, 'utf8'),
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(result.proposed, 'build')
  const retry = calls[1].args[calls[1].args.indexOf('--fences') + 1]
  assert.notEqual(retry, register)
  assert.deepEqual(JSON.parse(readFileSync(retry, 'utf8')).lanes[0].reads.map(({ file }) => file), ['crew/x.mjs'])
})

test('staffing pair comes from a real compiled brief proposal block', async () => {
  const checkout = gitFixture()
  const batch = join(checkout, 'staffing-real-batch')
  const out = join(checkout, 'staffing-real-out')
  mkdirSync(batch)
  mkdirSync(out)
  const requestPath = put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure owned source behavior', ['src/owned.mjs'])))
  const registerPath = put(join(out, 'dispatch.fences.json'), JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs', 'src/coupled.mjs'], [])] }))
  const briefPath = join(out, 'lane-a.brief.md')
  const compiled = spawnSync(process.execPath, [
    compiler, '--request', requestPath, '--checkout', checkout,
    '--fences', registerPath, '--lane', 'lane-a', '--out', briefPath, '--force',
    '--profile', join(checkout, 'missing-profile.json'),
  ], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `${compiled.stderr}\n${compiled.stdout}`)
  const brief = readFileSync(briefPath, 'utf8')
  const lines = brief.split('\n')
  const start = lines.findIndex((line) => line.trim() === '```proposal')
  assert.notEqual(start, -1)
  const end = lines.findIndex((line, index) => index > start && line.trim() === '```')
  assert.notEqual(end, -1)
  const expected = JSON.parse(lines.slice(start + 1, end).join('\n'))
  assert.ok(expected.shape)
  assert.ok(expected.strength)
  const result = await compileLane({
    lane: 'lane-a', batchDir: batch, laneDir: checkout, registerPath,
    outDir: join(root, 'staffing-real-compile-out'), fences: [entry('lane-a', ['src/owned.mjs', 'src/coupled.mjs'], [])],
    deps: {
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
      readFileSync: (path, encoding) => String(path).endsWith('.brief.md') ? brief : readFileSync(path, encoding || 'utf8'),
    },
  })
  assert.equal(result.staffing.shape, expected.shape)
  assert.equal(result.staffing.strength, expected.strength)
  assert.notEqual(result.staffing.shape, null)
  assert.notEqual(result.staffing.strength, null)
})

test('dispatch records shape and strength for each lane', async () => {
  const result = await dispatchFixture({
    label: 'staffing-pairs',
    names: ['lane-a', 'lane-b'],
    briefs: {
      'lane-a': staffingBrief({ shape: 'mechanical', strength: 'workhorse' }),
      'lane-b': staffingBrief({ shape: 'judge', strength: 'frontier' }),
    },
  })
  const records = Object.fromEntries(['lane-a', 'lane-b'].map((lane) => [
    lane, JSON.parse(readFileSync(join(result.out, `${lane}.dispatch.json`), 'utf8')),
  ]))
  assert.deepEqual(
    { shape: records['lane-a'].shape, strength: records['lane-a'].strength },
    { shape: 'mechanical', strength: 'workhorse' },
  )
  assert.deepEqual(
    { shape: records['lane-b'].shape, strength: records['lane-b'].strength },
    { shape: 'judge', strength: 'frontier' },
  )
  assert.notDeepEqual(
    { shape: records['lane-a'].shape, strength: records['lane-a'].strength },
    { shape: records['lane-b'].shape, strength: records['lane-b'].strength },
  )
  const lines = result.logs.filter((line) => line.startsWith('dispatch-batch: lane='))
  assert.ok(lines.some((line) => line.includes('lane=lane-a') && line.includes('shape=mechanical') && line.includes('strength=workhorse')))
  assert.ok(lines.some((line) => line.includes('lane=lane-b') && line.includes('shape=judge') && line.includes('strength=frontier')))
})

test('dispatch records a compiler misclassification verbatim', async () => {
  const note = `${MISCLASSIFIED_PREFIX}: complexity build prices frontier — repropose the shape`
  const result = await dispatchFixture({
    label: 'staffing-note',
    names: ['lane-a'],
    briefs: { 'lane-a': staffingBrief({ shape: 'mechanical', strength: 'frontier', misclassification: note }) },
  })
  const record = JSON.parse(readFileSync(join(result.out, 'lane-a.dispatch.json'), 'utf8'))
  assert.equal(record.misclassification, note)
  assert.ok(result.logs.some((line) => line.startsWith('dispatch-batch: lane=lane-a ') && line.includes('misclassified=true')))
})

test('recording a misclassification changes no dispatch decisions', async () => {
  const note = `${MISCLASSIFIED_PREFIX}: complexity build prices frontier — repropose the shape`
  const withNote = await dispatchFixture({
    label: 'staffing-note-present',
    names: ['lane-a'],
    briefs: { 'lane-a': staffingBrief({ shape: 'mechanical', strength: 'frontier', misclassification: note }) },
  })
  const withoutNote = await dispatchFixture({
    label: 'staffing-note-absent',
    names: ['lane-a'],
    briefs: { 'lane-a': staffingBrief({ shape: 'mechanical', strength: 'frontier' }) },
  })
  const first = JSON.parse(readFileSync(join(withNote.out, 'lane-a.dispatch.json'), 'utf8'))
  const second = JSON.parse(readFileSync(join(withoutNote.out, 'lane-a.dispatch.json'), 'utf8'))
  assert.deepEqual(first.tier, second.tier)
  const differing = [...new Set([...Object.keys(first), ...Object.keys(second)])]
    .filter((key) => key !== 'brief' && JSON.stringify(first[key]) !== JSON.stringify(second[key]))
  assert.deepEqual(differing, ['misclassification'])
})

test('staffing absence records null axes and never invents a shape', async () => {
  const malformed = [
    {
      label: 'staffing-absent',
      brief: staffingBrief({ shape: null, strength: null }),
    },
    {
      label: 'staffing-unknown-shape',
      brief: ['proposed tier: build', '```proposal', '{"shape":"wizard"}', '```'].join('\n'),
    },
    {
      label: 'staffing-unparseable',
      brief: ['proposed tier: build', '```proposal', 'not json', '```'].join('\n'),
    },
    {
      label: 'staffing-two-blocks',
      brief: [
        'proposed tier: build',
        '```proposal', '{"shape":"judge","strength":"frontier"}', '```',
        '```proposal', '{"shape":"mechanical","strength":"workhorse"}', '```',
      ].join('\n'),
    },
  ]
  for (const { label, brief } of malformed) {
    const result = await dispatchFixture({ label, names: ['lane-a'], brief })
    const record = JSON.parse(readFileSync(join(result.out, 'lane-a.dispatch.json'), 'utf8'))
    assert.equal(record.shape, null, `${label} shape`)
    assert.equal(record.strength, null, `${label} strength`)
    assert.notEqual(record.shape, 'mechanical', `${label} invented shape`)
    assert.ok(result.logs.some((line) => line.includes('shape=absent strength=absent')), `${label} absence log`)
  }
})

test('dispatcher misclassification literal stays pinned to the compiler', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'factory', 'make-brief.mjs'), 'utf8')
  assert.equal(source.includes(MISCLASSIFIED_PREFIX), true)
})

test('staffing fields append to the existing settled dispatch log line', async () => {
  const result = await dispatchFixture({ label: 'staffing-log-order', names: ['lane-a'] })
  const line = result.logs.find((entry) => entry.startsWith('dispatch-batch: lane=lane-a '))
  assert.ok(line)
  assert.equal(line.startsWith(
    'dispatch-batch: lane=lane-a forced=none proposed=none requested=mechanical requested_from=batch variant=full variant_from=batch settled=mechanical',
  ), true)
  assert.match(line, / shape=judge strength=workhorse misclassified=false$/)
})

async function compileBriefProposal(brief, label) {
  const batch = makeBatch(['lane-a'])
  const out = join(root, `proposal-${label}-out`)
  const register = join(root, `proposal-${label}-register.json`)
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['crew/owned.mjs'], [])] }))
  const result = await compileLane({
    lane: 'lane-a', batchDir: batch, laneDir: root, registerPath: register, outDir: out,
    fences: [entry('lane-a', ['crew/owned.mjs'], [])],
    deps: {
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
      readFileSync: (path) => String(path).endsWith('.brief.md') ? brief : readFileSync(path, 'utf8'),
    },
  })
  return result.proposed
}

test('a proposal block without a tier line never supplies the seating tier', async () => {
  assert.equal(await compileBriefProposal(briefWithBlockOnly, 'block-only'), null)
})

test('a mid-sentence proposed tier quote does not outrank the compiler line', async () => {
  assert.equal(await compileBriefProposal(briefWithQuotedTier, 'quoted-tier'), 'build')
})

test('readBatch splits a lane tier and leaves the compiler request schema clean', () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { tier: 'judge' })))
  const lanes = readBatch({ batchDir: batch })
  assert.equal(lanes.find(({ lane }) => lane === 'lane-a').tier, 'judge')
  assert.equal(lanes.find(({ lane }) => lane === 'lane-b').tier, null)
  assert.equal(Object.hasOwn(lanes.find(({ lane }) => lane === 'lane-a').request, 'tier'), false)
})

test('a lane tier seats that lane while a sibling takes the batch default', async () => {
  const result = await dispatchFixture({
    label: 'lane-tier',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'judge' }) },
    batchTier: 'mechanical',
  })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  const seated = Object.fromEntries(boots.map((call) => {
    const task = call.args[call.args.indexOf('--task') + 1]
    return [task, call.args[call.args.indexOf('--tier') + 1]]
  }))
  assert.deepEqual(seated, { 'lane-a': 'judge', 'lane-b': 'mechanical' })
  const requested = result.logs.filter((line) => line.startsWith('dispatch-batch: lane='))
  assert.ok(requested.some((line) => line.includes('lane=lane-a') && line.includes('requested=judge requested_from=lane')))
  assert.ok(requested.some((line) => line.includes('lane=lane-b') && line.includes('requested=mechanical requested_from=batch')))
})

test('the compiler receives exactly the four schema request keys', async () => {
  const result = await dispatchFixture({
    label: 'clean-request',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'judge', variant: 'scout' }) },
  })
  const compiles = result.spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(compiles.length, 2)
  const expected = ['ask', 'done_means', 'out_of_scope', 'where']
  for (const call of compiles) {
    const path = call.args[call.args.indexOf('--request') + 1]
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), expected)
  }
})

test('a dispatched depends_on lane still compiles with exactly the schema keys', async () => {
  const result = await dispatchFixture({
    label: 'depends-on-request',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '2' },
    outcomes: { 'lane-a': { status: 'done', details: { commit: 'a'.repeat(40) } } },
  })
  const compiles = result.spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(compiles.length, 1)
  const path = compiles[0].args[compiles[0].args.indexOf('--request') + 1]
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['ask', 'done_means', 'out_of_scope', 'where'])
})

test('creates reaches the compiler as an optional fifth key while tier remains dispatch-only', async () => {
  const result = await dispatchFixture({
    label: 'creates-request',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'judge', creates: ['./crew/new-a.mjs'] }) },
    fences: [
      entry('lane-a', ['crew/owned-lane-a.mjs', 'crew/new-a.mjs']),
      entry('lane-b', ['crew/owned-lane-b.mjs']),
    ],
  })
  const compiles = result.spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  const laneA = compiles.find(({ args }) => args.some((arg) => String(arg).endsWith('/lane-a.compile-request.json')))
  const parsed = JSON.parse(readFileSync(laneA.args[laneA.args.indexOf('--request') + 1], 'utf8'))
  assert.deepEqual(Object.keys(parsed).sort(), ['ask', 'creates', 'done_means', 'out_of_scope', 'where'])
  assert.deepEqual(parsed.creates, ['./crew/new-a.mjs'])
  assert.equal(Object.hasOwn(parsed, 'tier'), false)
})

test('readBatch splits a lane variant and leaves the compiler request clean', () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { variant: 'scout' })))
  const lanes = readBatch({ batchDir: batch })
  assert.equal(lanes.find(({ lane }) => lane === 'lane-a').variant, 'scout')
  assert.equal(lanes.find(({ lane }) => lane === 'lane-b').variant, null)
  assert.equal(Object.hasOwn(lanes.find(({ lane }) => lane === 'lane-a').request, 'variant'), false)
})

test('a batch mixes lane variants while preserving the batch default', async () => {
  const result = await dispatchFixture({
    label: 'lane-variants',
    names: ['lane-a', 'lane-b', 'lane-c'],
    requests: { 'lane-b': requestFor('lane-b', { variant: 'scout' }) },
  })
  const runs = result.spawned.filter(({ args }) => args.includes('run'))
  const variants = Object.fromEntries(runs.map(({ args }) => {
    const lane = args[args.indexOf('--task') + 1]
    return [lane, args[args.indexOf('--variant') + 1]]
  }))
  assert.deepEqual(variants, { 'lane-a': 'full', 'lane-b': 'scout', 'lane-c': 'full' })
  const settled = result.logs.filter((line) => line.startsWith('dispatch-batch: lane='))
  assert.ok(settled.some((line) => line.includes('lane=lane-b') && line.includes('variant=scout variant_from=lane')))
  assert.ok(settled.some((line) => line.includes('lane=lane-a') && line.includes('variant=full variant_from=batch')))
  assert.ok(settled.some((line) => line.includes('lane=lane-c') && line.includes('variant=full variant_from=batch')))
})

test('lane variants are preflighted by name and ctx lanes require validation', async () => {
  await assert.rejects(() => dispatchFixture({
    label: 'lane-unknown-variant',
    requests: { 'lane-b': requestFor('lane-b', { variant: 'not-a-variant' }) },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'run-failed'
    && error.message.includes('lane-b')
    && error.message.includes('not-a-variant'))
  await assert.rejects(() => dispatchFixture({
    label: 'lane-repair-without-validation',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { variant: 'repair' }) },
  }), (error) => error instanceof BatchRefusal && error.reason === 'run-failed'
    && error.message.includes('lane-a')
    && error.message.includes('--validation-lane'))
  const repaired = await dispatchFixture({
    label: 'lane-repair-with-validation',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { variant: 'repair' }) },
    runFlags: { 'validation-lane': 'lane-a' },
  })
  const run = repaired.spawned.find(({ args }) => args.includes('run'))
  assert.equal(run.args[run.args.indexOf('--variant') + 1], 'repair')
})

test('a directed lane whose brief fails the parser refuses before boot', async () => {
  const brief = briefWithBlockOnly
  const defect = parseDirectedBrief(brief).defect
  const spawned = []
  const batch = makeBatch(['lane-a'])
  await assert.rejects(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'directed-invalid-out'),
    tier: 'mechanical',
    variant: 'directed',
    runFlags: { 'validation-lane': 'npm test' },
    deps: {
      home: root,
      env: { DEVTEAM_LEDGER_DIR: root },
      existsSync: () => false,
      readFileSync: (path, encoding) => String(path).endsWith('.brief.md')
        ? brief
        : readFileSync(path, encoding || 'utf8'),
      spawn: (call) => {
        spawned.push(call)
        return (call.args || []).includes('rev-parse')
          ? { status: 1, stdout: '', stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      },
      log: () => {},
    },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'directed-brief-invalid'
    && error.message.includes(defect))
  assert.equal(spawned.some(({ args }) => (args || []).includes('boot')), false)
})

test('a valid directed brief still dispatches the lane', async () => {
  const result = await dispatchFixture({
    label: 'directed-valid',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { variant: 'directed' }) },
    runFlags: { 'validation-lane': 'npm test' },
    brief: directedBrief,
  })
  assert.deepEqual(result.report.lanes.map(({ lane }) => lane), ['lane-a'])
})

test('checkDirectedBrief leaves every other variant alone', () => {
  assert.deepEqual(checkDirectedBrief({
    lane: 'lane-a',
    variant: 'full',
    briefPath: join(root, 'missing-directed-brief.md'),
    deps: { readFileSync: () => { throw new Error('must not read') } },
  }), { lane: 'lane-a', variant: 'full', checked: false })
})

test('invalid lane variant shapes refuse batch-unreadable at the request path', () => {
  for (const variant of [42, '']) {
    const batch = makeBatch(['lane-a'])
    put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { variant })))
    assert.throws(() => readBatch({ batchDir: batch }), (error) => error instanceof BatchRefusal
      && error.reason === 'batch-unreadable'
      && error.message.includes(`${batch}/lane-a${REQUEST_SUFFIX}`))
  }
})

test('a batch without lane variants keeps the full variant on every run', async () => {
  const result = await dispatchFixture({ label: 'no-lane-variants' })
  const runs = result.spawned.filter(({ args }) => args.includes('run'))
  assert.equal(runs.length, 2)
  for (const { args } of runs) {
    const index = args.indexOf('--variant')
    assert.equal(index >= 0, true)
    assert.equal(args[index + 1], 'full')
  }
})

test('checkFences refuses declared edges without a measured graph', () => {
  const fences = [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])]
  const lanes = [
    { lane: 'lane-a', where: ['crew/shared.mjs'], depends_on: [] },
    { lane: 'lane-b', where: ['crew/shared.mjs'], depends_on: ['lane-a'] },
  ]
  assert.throws(() => checkFences({ fences, lanes, checkout: root, deps: { readdirSync: () => [], log: () => {} } }), (error) => error instanceof BatchRefusal
    && error.reason === 'graph-unmeasured'
    && error.message.includes('depends_on'))
  const { graph } = planWaves({ lanes })
  assert.doesNotThrow(() => checkFences({ fences, lanes, graph, checkout: root, deps: { readdirSync: () => [], log: () => {} } }))
  const disjoint = [
    { lane: 'lane-a', where: ['crew/owned-a.mjs'], depends_on: [] },
    { lane: 'lane-b', where: ['crew/owned-b.mjs'], depends_on: [] },
  ]
  assert.doesNotThrow(() => checkFences({
    fences: [entry('lane-a', ['crew/owned-a.mjs']), entry('lane-b', ['crew/owned-b.mjs'])],
    lanes: disjoint,
    checkout: root,
    deps: { readdirSync: () => [], log: () => {} },
  }))
})

test('planWaves refuses the lane array argument shape', () => {
  const lanes = [{ lane: 'lane-a', depends_on: [] }, { lane: 'lane-b', depends_on: ['lane-a'] }]
  refusal(() => planWaves(lanes), 'lane-shape-invalid')
  assert.deepEqual(planWaves({ lanes }).waves, [['lane-a'], ['lane-b']])
})

test('planWaves refuses an unresolvable lane name with the offending object', () => {
  assert.throws(() => planWaves({ lanes: [{ id: 'lane-a' }] }), (error) => error instanceof BatchRefusal
    && error.reason === 'lane-shape-invalid'
    && error.message.includes('{"id":"lane-a"}'))
})

test('a lane tier below its protected floor refuses tier-floor-conflict', async () => {
  const requestBody = requestFor('lane-a', { tier: 'mechanical', where: ['crew/drive.mjs'] })
  await assert.rejects(() => dispatchFixture({
    label: 'floor-conflict',
    names: ['lane-a'],
    requests: { 'lane-a': requestBody },
    fences: [entry('lane-a', ['crew/drive.mjs'])],
  }), (err) => err instanceof BatchRefusal && err.reason === 'tier-floor-conflict')
})

test('an unrecognised lane tier refuses batch-unreadable', async () => {
  await assert.rejects(() => dispatchFixture({
    label: 'unknown-tier',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { tier: 'operator' }) },
  }), (err) => err instanceof BatchRefusal && err.reason === 'batch-unreadable')
})

test('keep defaults on, --no-keep removes it, and the report states the choice', async () => {
  const kept = await dispatchFixture({ label: 'keep-default' })
  const keptRuns = kept.spawned.filter(({ args }) => args.includes('run'))
  assert.equal(kept.report.keep, true)
  assert.equal(keptRuns.length, 2)
  assert.equal(keptRuns.every(({ args }) => args.includes('--keep')), true)

  const released = await dispatchFixture({ label: 'keep-off', runFlags: { 'no-keep': true } })
  const releasedRuns = released.spawned.filter(({ args }) => args.includes('run'))
  assert.equal(released.report.keep, false)
  assert.equal(releasedRuns.length, 2)
  assert.equal(releasedRuns.every(({ args }) => !args.includes('--keep')), true)
  assert.equal(released.logs.filter((line) => line.startsWith('dispatch-batch: workspaces keep=false')).length, 1)
})

test('parseCliArgs accepts --no-keep as a boolean override', () => {
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--no-keep']), { batch: 'b', 'no-keep': true })
})

test('parseCliArgs accepts both transport flags as booleans and refuses duplicates', () => {
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--panes']), { batch: 'b', panes: true })
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--headless-all']), { batch: 'b', 'headless-all': true })
  refusal(() => parseCliArgs(['--batch', 'b', '--panes', '--panes']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--batch', 'b', '--headless-all', '--headless-all']), 'batch-unreadable')
})

test('resolveTransport defaults headless, selects panes, and refuses conflicting choices', () => {
  assert.equal(resolveTransport(), BOOT_TRANSPORT)
  assert.equal(resolveTransport({ runFlags: { panes: true } }), PANE_TRANSPORT)
  refusal(() => resolveTransport({ runFlags: { panes: true, 'headless-all': true } }), 'transport-conflict')
})

test('default dispatch reports headless transport and every boot carries its flag', async () => {
  const result = await dispatchFixture({ label: 'default-transport' })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  assert.equal(result.report.transport, BOOT_TRANSPORT)
  assert.equal(boots.every(({ args }) => args.includes('--headless-all')), true)
})

test('--panes dispatch omits transport flags and reports returned workspaces', async () => {
  const result = await dispatchFixture({ label: 'panes-argv-and-report', runFlags: { panes: true } })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  assert.equal(boots.every(({ args }) => !args.includes('--headless-all') && !args.includes('--panes')), true)
  assert.deepEqual(result.report.lanes.map(({ lane, workspaceId }) => ({ lane, workspaceId })), [
    { lane: 'lane-a', workspaceId: 'ws-lane-a' },
    { lane: 'lane-b', workspaceId: 'ws-lane-b' },
  ])
})

test('--panes dispatch refuses when boot returns a null workspace_id', async () => {
  await assert.rejects(() => dispatchFixture({
    label: 'panes-null-workspace',
    runFlags: { panes: true },
    workspaceFor: () => null,
  }), (err) => err instanceof BatchRefusal
    && err.reason === 'boot-failed'
    && err.message.includes('crew.json workspace_id is null'))
})

test('pane closing output names each returned workspace', async () => {
  const result = await dispatchFixture({ label: 'panes-closing-output', runFlags: { panes: true } })
  const transport = result.logs.filter((line) => line.startsWith('dispatch-batch: transport='))
  assert.equal(transport.length, 1)
  assert.equal(transport[0].startsWith(`dispatch-batch: transport=${PANE_TRANSPORT}`), true)
  assert.match(transport[0], /lane-a=ws-lane-a/)
  assert.match(transport[0], /lane-b=ws-lane-b/)
  assert.doesNotMatch(transport[0], /workspace_id is null/)
})

test('closing output states the transport, keep policy, and names one teardown command per lane', async () => {
  const result = await dispatchFixture({ label: 'closing-output' })
  const transport = result.logs.filter((line) => line.startsWith('dispatch-batch: transport='))
  assert.equal(transport.length, 1)
  assert.equal(transport[0].startsWith(`dispatch-batch: transport=${BOOT_TRANSPORT}`), true)
  assert.match(transport[0], /workspace_id is null/)
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  assert.equal(boots.length, 2)
  assert.equal(boots.every(({ args }) => args.includes('--headless-all')), true)
  assert.equal(result.logs.filter((line) => line.startsWith('dispatch-batch: workspaces keep=true')).length, 1)
  for (const lane of ['lane-a', 'lane-b']) {
    assert.ok(result.logs.includes(
      `dispatch-batch: teardown lane=${lane} command=node crew/crew.mjs teardown --task ${lane} --checkout ${join(result.parent, `dt-${lane}`)}`,
    ))
  }
})

test('wave one dispatches only its level and re-emits baseline and memory flags for deferred lanes', async () => {
  const baseline = join(root, 'wave-one-baseline.json')
  put(baseline, JSON.stringify({ sha: 'a'.repeat(40), command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const result = await dispatchFixture({
    label: 'wave-one',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: {
      baseline,
      'memory-dir': '/tmp/mem',
      'memory-backend': 'sqlite',
      'memory-budget-bytes': '4096',
    },
  })
  assert.deepEqual(result.report.waves, [['lane-a'], ['lane-b']])
  assert.deepEqual(result.report.lanes.map(({ lane }) => lane), ['lane-a'])
  assert.deepEqual(result.report.deferred, [{ lane: 'lane-b', wave: 2, predecessors: ['lane-a'] }])
  assert.deepEqual(result.report.unstarted, [])
  assert.equal(result.spawned.filter(({ args }) => args.includes('boot')).length, 1)
  const deferred = result.logs.find((line) => line.includes('deferred lane=lane-b'))
  assert.ok(deferred)
  assert.match(deferred, /after=lane-a/)
  assert.match(deferred, /--wave 2/)
  assert.match(deferred, new RegExp(`--baseline ${baseline}`))
  for (const [flag, value] of [['--memory-dir', '/tmp/mem'], ['--memory-backend', 'sqlite'], ['--memory-budget-bytes', '4096']]) {
    assert.match(deferred, new RegExp(`${flag} ${value}`))
  }
})

test('wave two stops behind escalation or an unsettled predecessor', async () => {
  const escalated = await dispatchFixture({
    label: 'wave-escalated',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '2' },
    outcomes: { 'lane-a': { status: 'escalation', details: {} } },
  })
  assert.equal(escalated.spawned.filter(({ args }) => args.includes('boot')).length, 0)
  assert.deepEqual(escalated.report.unstarted, [{ lane: 'lane-b', reason: 'predecessor-escalated', predecessor: 'lane-a' }])

  const unsettled = await dispatchFixture({
    label: 'wave-unsettled',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '2' },
  })
  assert.deepEqual(unsettled.report.unstarted, [{ lane: 'lane-b', reason: 'predecessor-unsettled', predecessor: 'lane-a' }])
  assert.equal(unsettled.spawned.length, 0)
})

test('wave two refuses a stale predecessor base and dispatches when containment is proven', async () => {
  const commit = 'c'.repeat(40)
  await assert.rejects(() => dispatchFixture({
    label: 'wave-stale-base',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '2' },
    outcomes: { 'lane-a': { status: 'done', details: { commit } } },
    ancestor: () => 1,
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'dependent-base-stale'
    && error.message.includes('lane-a') && error.message.includes(commit))

  const contained = await dispatchFixture({
    label: 'wave-contained-base',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '2' },
    outcomes: { 'lane-a': { status: 'done', details: { commit } } },
    ancestor: () => 0,
  })
  assert.equal(contained.spawned.filter(({ args }) => args.includes('merge-base')).length, 1)
  assert.deepEqual(contained.report.lanes.map(({ lane }) => lane), ['lane-b'])
})

test('wave selection rejects a number outside the planned range', async () => {
  await assert.rejects(() => dispatchFixture({
    label: 'wave-out-of-range',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '3' },
  }), (error) => error instanceof BatchRefusal && error.reason === 'batch-unreadable'
    && error.message.includes('2 wave(s)'))
})

test('an unflagged no-edges dispatch adds no wave output and reports empty deferrals', async () => {
  const result = await dispatchFixture({ label: 'no-edges' })
  assert.equal(result.logs.filter((line) => /wave|deferred|unstarted/i.test(line)).length, 0)
  assert.equal(result.report.waves.length, 1)
  assert.deepEqual(result.report.deferred, [])
  assert.deepEqual(result.report.unstarted, [])

  const dry = await dispatchFixture({ label: 'no-edges-dry-run', runFlags: { 'dry-run': true } })
  assert.deepEqual(dry.logs, [
    JSON.stringify({ dispatch: 'dry-run', plans: dry.report.plans }),
    'dispatch-batch: dry-run lane=lane-a tier=mechanical seats=none seats_from=none',
    'dispatch-batch: dry-run lane=lane-b tier=mechanical seats=none seats_from=none',
    DRY_RUN_BLIND_SPOT,
  ])
  assert.equal(dry.logs[0].startsWith('{"dispatch":"dry-run","plans":['), true)
  assert.equal(dry.report.waves.length, 1)
  assert.deepEqual(dry.report.deferred, [])
  assert.deepEqual(dry.report.unstarted, [])
})

test('dry-run wave selection still gates unsettled and stale predecessors', async () => {
  const blocked = await dispatchFixture({
    label: 'dry-wave-unsettled',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '2', 'dry-run': true },
  })
  assert.deepEqual(blocked.report.unstarted, [{ lane: 'lane-b', reason: 'predecessor-unsettled', predecessor: 'lane-a' }])
  assert.equal(blocked.spawned.length, 0)
  assert.equal(blocked.logs.some((line) => line.startsWith('{"dispatch":"dry-run"')), false)

  const commit = 'd'.repeat(40)
  await assert.rejects(() => dispatchFixture({
    label: 'dry-wave-stale',
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '2', 'dry-run': true },
    outcomes: { 'lane-a': { status: 'done', details: { commit } } },
    ancestor: () => 1,
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'dependent-base-stale'
    && error.message.includes(commit))
})

test('laneOutcome reads live and newest archived envelopes defensively', () => {
  const laneDir = '/tmp/dt-lane-a'
  const live = join(dirname(crewJsonPath({ checkout: laneDir, lane: 'lane-a' })), 'returns', 'task.json')
  const archiveNew = join(dirname(dirname(dirname(live))), 'lane-a.archive-new', 'returns', 'task.json')
  const outcome = laneOutcome({
    lane: 'lane-a',
    laneDir,
    deps: {
      existsSync: (path) => path === live ? false : path === archiveNew,
      readdirSync: () => ['lane-a.archive-old', 'lane-a.archive-new'],
      readFileSync: () => JSON.stringify({ status: 'done', details: { commit: 'a'.repeat(40) } }),
    },
  })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.commit, 'a'.repeat(40))
  assert.equal(outcome.path, archiveNew)

  const unreadable = laneOutcome({ lane: 'lane-a', laneDir, deps: {
    existsSync: (path) => path === live,
    readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
    readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
  } })
  assert.deepEqual(unreadable, { status: null, commit: null, path: live })
})

test('baseContains treats only a measured zero probe as containment', () => {
  const calls = []
  assert.equal(baseContains({ commit: 'a', base: 'main', checkout: '/repo', deps: {
    spawn: (call) => { calls.push(call); return { status: 0 } },
  } }), true)
  assert.deepEqual(calls[0].args, ['-C', '/repo', 'merge-base', '--is-ancestor', 'a', 'main'])
  assert.equal(baseContains({ commit: 'a', base: 'main', checkout: '/repo', deps: {
    spawn: () => ({ status: 1 }),
  } }), false)
  assert.equal(baseContains({ commit: null, base: 'main', checkout: '/repo', deps: {
    spawn: () => ({ status: 0 }),
  } }), false)
})

test('a request seats compile without carrying seats into the compiler request', async () => {
  const seats = { planner: { agent: 'pi', model: 'openai-codex/gpt-5.6-sol', effort: 'high' } }
  assert.equal(DISPATCH_ONLY_REQUEST_KEYS.includes('seats'), true)
  const result = await dispatchFixture({
    label: 'seats-request',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { seats }) },
  })
  const compile = result.spawned.find(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.ok(compile)
  const compiled = JSON.parse(readFileSync(compile.args[compile.args.indexOf('--request') + 1], 'utf8'))
  assert.equal(Object.hasOwn(compiled, 'seats'), false)
  assert.deepEqual(readBatch({ batchDir: result.batch })[0].seats, seats)
})

test('invalid seats shapes refuse batch-unreadable at the request path', () => {
  const cases = [
    [null, 'plain object'],
    [{ planner: null }, 'role'],
    [{ planner: { unknown: 'pi' } }, 'unknown'],
    [{ planner: { agent: '' } }, 'non-empty'],
  ]
  for (const [seats, detail] of cases) {
    const batch = makeBatch(['lane-a'])
    const path = join(batch, `lane-a${REQUEST_SUFFIX}`)
    put(path, JSON.stringify(requestFor('lane-a', { seats })))
    assert.throws(() => readBatch({ batchDir: batch }), (error) => error instanceof BatchRefusal
      && error.reason === 'batch-unreadable'
      && error.message.includes(path)
      && error.message.toLowerCase().includes(detail))
  }
})

test('parseCliArgs accepts every batch seat flag and preserves generic refusals', () => {
  assert.deepEqual(parseCliArgs([
    '--agent-planner', 'pi', '--model-planner', 'raw', '--effort-planner', 'high',
    '--allow-shortfall-planner', 'subagents',
  ]), {
    'agent-planner': 'pi',
    'model-planner': 'raw',
    'effort-planner': 'high',
    'allow-shortfall-planner': 'subagents',
  })
  refusal(() => parseCliArgs(['--nonsense', 'x']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--agent-planner', 'pi', '--agent-planner', 'claude']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--allow-shortfall-planner']), 'batch-unreadable')
})

test('seat merge and forwarding helpers are deterministic and preserve field provenance', () => {
  const batch = batchSeatsFrom({ 'model-planner': 'batch-model', 'agent-builder': 'batch-agent', 'allow-shortfall-planner': 'subagents' })
  const lane = { planner: { agent: 'lane-agent', effort: 'high' } }
  assert.deepEqual(batch, {
    builder: { agent: 'batch-agent' },
    planner: { model: 'batch-model', allow_shortfall: 'subagents' },
  })
  assert.deepEqual(mergeSeats(batch, lane), {
    builder: { agent: 'batch-agent' },
    planner: { agent: 'lane-agent', model: 'batch-model', effort: 'high', allow_shortfall: 'subagents' },
  })
  assert.deepEqual(seatChain(batch, lane), {
    builder: { agent: { batch: 'batch-agent', lane: null, settled: 'batch-agent', from: 'batch' } },
    planner: {
      agent: { batch: null, lane: 'lane-agent', settled: 'lane-agent', from: 'lane' },
      model: { batch: 'batch-model', lane: null, settled: 'batch-model', from: 'batch' },
      effort: { batch: null, lane: 'high', settled: 'high', from: 'lane' },
      allow_shortfall: { batch: 'subagents', lane: null, settled: 'subagents', from: 'batch' },
    },
  })
  assert.deepEqual(seatFlagArgs(mergeSeats(batch, lane)), [
    '--agent-builder', 'batch-agent', '--agent-planner', 'lane-agent',
    '--model-planner', 'batch-model', '--effort-planner', 'high',
  ])
  assert.deepEqual(shortfallFlagArgs(mergeSeats(batch, lane)), ['--allow-shortfall-planner', 'subagents'])
  assert.equal(seatSpec(mergeSeats(batch, lane)), 'builder.agent=batch-agent,planner.agent=lane-agent,planner.model=batch-model,planner.effort=high,planner.allow_shortfall=subagents')
  assert.equal(seatFromSpec(batch, lane), 'builder.agent=batch,planner.agent=lane,planner.model=batch,planner.effort=lane,planner.allow_shortfall=batch')
})

test('boot argv carries regular seat flags before a declared shortfall waiver', async () => {
  const result = await dispatchFixture({
    label: 'seats-argv',
    names: ['lane-a'],
    requests: {
      'lane-a': requestFor('lane-a', {
        seats: { planner: { agent: 'pi', model: 'raw-model', effort: 'high' } },
      }),
    },
    runFlags: { 'allow-shortfall-planner': 'subagents' },
  })
  const boot = result.spawned.find(({ args }) => args.includes('boot'))
  assert.ok(boot)
  const at = boot.args.indexOf('--lane') + 2
  assert.deepEqual(boot.args.slice(at, at + 8), [
    '--agent-planner', 'pi', '--model-planner', 'raw-model', '--effort-planner', 'high',
    '--allow-shortfall-planner', 'subagents',
  ])
})

test('lane seat fields override batch defaults while batch fields fill gaps', async () => {
  const laneWins = await dispatchFixture({
    label: 'lane-seat-precedence',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { seats: { planner: { agent: 'pi' } } }) },
    runFlags: { 'agent-planner': 'claude', 'model-planner': 'batch-model' },
  })
  const laneBoot = laneWins.spawned.find(({ args }) => args.includes('boot'))
  assert.equal(laneBoot.args[laneBoot.args.indexOf('--agent-planner') + 1], 'pi')
  assert.equal(laneBoot.args[laneBoot.args.indexOf('--model-planner') + 1], 'batch-model')
  assert.ok(laneWins.logs.some((line) => line.includes('seats_from=planner.agent=lane,planner.model=batch')))

  const batchWins = await dispatchFixture({
    label: 'batch-seat-default',
    names: ['lane-a'],
    runFlags: { 'agent-planner': 'claude' },
  })
  const batchBoot = batchWins.spawned.find(({ args }) => args.includes('boot'))
  assert.equal(batchBoot.args[batchBoot.args.indexOf('--agent-planner') + 1], 'claude')
  assert.ok(batchWins.logs.some((line) => line.includes('seats_from=planner.agent=batch')))
})

test('dispatch records a per-field seat chain and an empty chain for untouched lanes', async () => {
  const result = await dispatchFixture({
    label: 'seat-record',
    names: ['lane-a', 'lane-b'],
    requests: {
      'lane-a': requestFor('lane-a', {
        seats: { planner: { agent: 'pi', model: 'raw-model', effort: 'high' } },
      }),
    },
  })
  const overridden = JSON.parse(readFileSync(join(result.out, `lane-a${DISPATCH_RECORD_SUFFIX}`), 'utf8'))
  const untouched = JSON.parse(readFileSync(join(result.out, `lane-b${DISPATCH_RECORD_SUFFIX}`), 'utf8'))
  assert.deepEqual(overridden.seats.planner, {
    agent: { batch: null, lane: 'pi', settled: 'pi', from: 'lane' },
    model: { batch: null, lane: 'raw-model', settled: 'raw-model', from: 'lane' },
    effort: { batch: null, lane: 'high', settled: 'high', from: 'lane' },
  })
  assert.deepEqual(untouched.seats, {})
})

test('an unseated seat override refuses before any lane boots', async () => {
  let boots = 0
  await assert.rejects(() => dispatchFixture({
    label: 'unseated-seat',
    names: ['lane-a', 'lane-b'],
    requests: { 'lane-b': requestFor('lane-b', { seats: { 'tech-lead': { agent: 'pi' } } }) },
    spawnResult: (args) => {
      if (args.includes('boot')) boots += 1
      return { status: 0, stdout: '', stderr: '' }
    },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'seat-floor-conflict'
    && error.message.includes('tech-lead'))
  assert.equal(boots, 0)
})

test('an unreadable roster refuses seat overrides and no-seat dispatches never read it', async () => {
  assert.throws(() => seatRolesUnseated({
    seats: { planner: { agent: 'pi' } },
    tier: 'build',
    deps: { readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'seat-floor-conflict'
    && error.message.includes(ROSTER_PATH))
  let rosterReads = 0
  await dispatchFixture({
    label: 'no-roster-read',
    names: ['lane-a'],
    readObserver: (path) => { if (path === ROSTER_PATH) rosterReads += 1 },
  })
  assert.equal(rosterReads, 0)
})

test('boot band-floor refusals are distinct from capability shortfalls', async () => {
  const floorStderr = 'crew boot refused at crew/model-ladder.json [band-below-floor]'
  await assert.rejects(() => dispatchFixture({
    label: 'boot-band-floor',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { seats: { planner: { model: 'raw-model' } } }) },
    spawnResult: (args) => args.includes('boot')
      ? { status: 1, stdout: '', stderr: floorStderr }
      : { status: 0, stdout: '', stderr: '' },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'seat-floor-conflict'
    && error.message.includes('[band-below-floor]'))

  const capabilityStderr = 'seat planner requires capability "subagents" — refusing to boot a weaker seat'
  await assert.rejects(() => dispatchFixture({
    label: 'boot-capability-shortfall',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { seats: { planner: { agent: 'pi' } } }) },
    spawnResult: (args) => args.includes('boot')
      ? { status: 1, stdout: '', stderr: capabilityStderr }
      : { status: 0, stdout: '', stderr: '' },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'boot-failed')
  assert.equal(seatFloorRefusal(floorStderr), 'band-below-floor')
  assert.equal(seatFloorRefusal(capabilityStderr), null)
})

test('protected-path seat overrides retain a forced judge tier', async () => {
  const result = await dispatchFixture({
    label: 'seat-protected-floor',
    names: ['lane-a'],
    batchTier: 'mechanical',
    fences: [entry('lane-a', ['crew/model-ladder.json'])],
    requests: {
      'lane-a': requestFor('lane-a', {
        where: ['crew/model-ladder.json'],
        seats: { planner: { agent: 'pi' } },
      }),
    },
  })
  const boot = result.spawned.find(({ args }) => args.includes('boot'))
  assert.equal(boot.args[boot.args.indexOf('--tier') + 1], 'judge')
  const record = JSON.parse(readFileSync(join(result.out, `lane-a${DISPATCH_RECORD_SUFFIX}`), 'utf8'))
  assert.equal(record.tier.forced, 'judge')
  assert.equal(record.tier.settled, 'judge')
})

test('dry-run logs each lane seat settlement and keeps the blind spot unchanged', async () => {
  const result = await dispatchFixture({
    label: 'seat-dry-run',
    names: ['lane-a'],
    runFlags: { 'dry-run': true, 'agent-planner': 'claude' },
    requests: { 'lane-a': requestFor('lane-a', { seats: { planner: { agent: 'pi' } } }) },
  })
  assert.ok(result.logs.includes('dispatch-batch: dry-run lane=lane-a tier=mechanical seats=planner.agent=pi seats_from=planner.agent=lane'))
  assert.ok(result.logs.includes(DRY_RUN_BLIND_SPOT))
})

test('resume commands re-emit every batch seat flag', async () => {
  const result = await dispatchFixture({
    label: 'seat-resume',
    names: ['lane-a', 'lane-b'],
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { 'agent-planner': 'claude', 'model-planner': 'raw-model', 'allow-shortfall-planner': 'subagents' },
  })
  const deferred = result.logs.find((line) => line.includes('deferred lane=lane-b'))
  assert.ok(deferred)
  assert.match(deferred, /--agent-planner claude/)
  assert.match(deferred, /--model-planner raw-model/)
  assert.match(deferred, /--allow-shortfall-planner subagents/)
})

test('seat vocabulary stays mirrored to crew boot constants', () => {
  const source = readFileSync(join(repoRoot, 'crew', 'crew.mjs'), 'utf8')
  for (const prefix of Object.values(SEAT_FIELDS)) assert.equal(source.includes(prefix), true, prefix)
  for (const reason of BAND_FLOOR_REASONS) assert.equal(source.includes(reason), true, reason)
})

test('parseCliArgs accepts --wave and refuses its missing value', () => {
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--wave', '2']), { batch: 'b', wave: '2' })
  refusal(() => parseCliArgs(['--batch', 'b', '--wave']), 'batch-unreadable')
})
