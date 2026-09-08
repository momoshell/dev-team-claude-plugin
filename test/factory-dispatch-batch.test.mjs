import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFileSync as fsAppendFileSync, existsSync as fsExistsSync, mkdirSync, readFileSync, readdirSync as fsReaddirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  ADOPT_BLOCK,
  ADOPT_EVENT,
  BAND_FLOOR_REASONS,
  LINEAGE_BASELINE_REASONS,
  LINEAGE_SOURCES,
  carriedLineage,
  lineageBaseline,
  lineageLine,
  BatchRefusal,
  CROSS_BATCH_BLIND_SPOT,
  CROSS_BATCH_UNKNOWN_PREFIX,
  WARNING_ROWS_UNPERSISTED_PREFIX,
  baseContains,
  baselineCacheRoot,
  batchSeatsFrom,
  BOOT_TRANSPORT,
  PANE_TRANSPORT,
  COUPLED_SOURCE_UNFENCED,
  ANCHOR_BLIND_SPOT,
  ANCHOR_PIN_POST_MERGE,
  ANCHOR_PIN_WARNING_PREFIX,
  CITATION_CARRIER_BLIND_SPOT,
  CITATION_CARRIER_POST_MERGE,
  CITATION_CARRIER_ROW_LIMIT,
  CITATION_CARRIER_WARNING_PREFIX,
  citationCarriers,
  citationCarriersOutsideFence,
  REFUSAL_REASONS,
  PROMPT_SURFACE,
  PROMPT_SURFACE_BLIND_SPOT,
  promptSurfaceVerdict,
  DISPATCH_RECORD_SUFFIX,
  DRY_RUN_BLIND_SPOT,
  EXTERNAL_FENCE_PREFIX,
  EXTERNAL_REGISTER_NAME,
  FENCE_REPORT_FILE,
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
  TEST_REACH_OVERRIDE_KEY,
  TEST_REACH_OVERRIDE_PREFIX,
  isTestReachOverride,
  TEST_REACH_REFUSAL_BLIND_SPOT,
  TEST_REACH_REFUSAL_REMEDY,
  reachRefusalRows,
  surfaceExportsOf,
  checkArrival,
  checkDirectedBrief,
  externalCrewDir,
  externalFenceLiveness,
  externalLaneReason,
  applyAdoption,
  adoptSourceDir,
  checkFences,
  checkPlanScope,
  checkMachineryBudget,
  crossBatchCollisions,
  collectAnchorPins,
  collectTestReach,
  testsOutsideFence,
  ROLES_ANCHOR_COMPANIONS,
  ROLES_ANCHOR_MANIFEST,
  crewJsonPath,
  briefMeasure,
  compileLane,
  dispatchBatch,
  factoryStateRoot,
  formatTurnBudgetReport,
  readTurnCensus,
  turnBudgetReport,
  TURN_CENSUS_FLAG,
  laneOutcome,
  main,
  bootCommand,
  measureBatchBaseline,
  mergeCheckLine,
  normalDeps,
  parseCliArgs,
  resolveAdoptions,
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
  parsePlannerSymbolsHoldoutFraction,
  selectPlannerSymbolsArm,
  PLANNER_SYMBOLS_ARM_EVENT,
  PLANNER_SYMBOLS_EXPERIMENT,
  ROSTER_PATH,
  seatFloorRefusal,
  seatRolesUnseated,
  teardownVerdict,
  seatsDefect,
  mergeSeats,
  tierFloor,
  readRegister,
  resolveRequestedTier,
} from '../scripts/factory/dispatch-batch.mjs'
import { parseDirectedBrief, WAITS_S } from '../crew/drive.mjs'
import { laneFenceFor, renderBrief } from '../scripts/factory/make-brief.mjs'
import { DRIVER_GONE_PERIODS, HEARTBEAT_PERIOD_MS } from '../scripts/factory/lane-watch.mjs'
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
function compilerLane(args) {
  const values = (args || []).map(String)
  const flag = values.includes('--lane') ? '--lane' : '--discover-reads'
  return values[values.indexOf(flag) + 1]
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

function twoOwnerReachFixture(name, { importer = false } = {}) {
  const ownerA = ['lib', 'owner-a.mjs'].join('/')
  const ownerB = ['lib', 'owner-b.mjs'].join('/')
  const ownerBPath = ['..', 'lib', 'owner-b.mjs'].join('/')
  const mixedTest = [
    'const seenAlpha = "alphaName"',
    'const seenBeta = "betaName"',
    `const reachedPath = ${JSON.stringify(ownerBPath)}`,
    'void seenAlpha',
    'void seenBeta',
    'void reachedPath',
    '',
  ].join('\n')
  const files = {
    [ownerA]: 'export const alphaName = 1\nexport const betaName = 2\n',
    [ownerB]: 'export const bravoName = 3\n',
    'test/two-owner.test.mjs': mixedTest,
  }
  if (importer) {
    files['test/two-owner-import.test.mjs'] = [
      `import { alphaName } from ${JSON.stringify(['..', 'lib', 'owner-a.mjs'].join('/'))}`,
      'const seenBeta = "betaName"',
      `const reachedPath = ${JSON.stringify(ownerBPath)}`,
      'void alphaName',
      'void seenBeta',
      'void reachedPath',
      '',
    ].join('\n')
  }
  return reachFixture(`two-owner-${name}`, { files })
}

function crewFixture({ home, repoDir, laneDir, lane = laneDir, fence = [], checkout, malformed = false, archived = false, stamp = '2026-08-01T00-00-00Z', at = Date.now() }) {
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
  put(join(directory, 'journal.jsonl'), `${JSON.stringify({ at, stage: archived ? 'done' : 'build:r1' })}\n`)
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

test('readRegister strips external markers into an out-dir register and keeps them in lane fences', () => {
  const checkout = gitFixture()
  const authored = put(join(checkout, 'external-register.json'), JSON.stringify({ lanes: [
    entry('lane-a', ['src/owned.mjs']),
    entry('lane-b', ['src/stale.mjs']),
    { lane: 'other-batch', files: ['README.md'], external: true },
  ] }, null, 2))
  const outDir = join(checkout, 'external-register-out')
  const result = readRegister({ fencesPath: authored, checkout, outDir, deps: { home: root } })
  assert.deepEqual(result.externals, ['other-batch'])
  assert.equal(result.sanitised, true)
  assert.equal(result.registerPath, join(outDir, EXTERNAL_REGISTER_NAME))
  const written = JSON.parse(readFileSync(result.registerPath, 'utf8'))
  assert.equal(Object.hasOwn(written.lanes.at(-1), 'external'), false)
  assert.deepEqual(laneFenceFor({ fences: result.fences, lane: 'lane-a' }), [
    { lane: 'lane-b', files: ['src/stale.mjs'] },
    { lane: 'other-batch', files: ['README.md'] },
  ])
  assert.deepEqual(laneFenceFor({ fences: result.fences, lane: 'lane-b' }), [
    { lane: 'lane-a', files: ['src/owned.mjs'] },
    { lane: 'other-batch', files: ['README.md'] },
  ])
})

test('readRegister returns the authored path and writes nothing without external entries', () => {
  const checkout = gitFixture()
  const authored = put(join(checkout, 'plain-register.json'), JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs'])] }))
  const outDir = join(checkout, 'plain-register-out')
  mkdirSync(outDir)
  put(join(outDir, 'sentinel'), 'unchanged\n')
  const before = fsReaddirSync(outDir).sort()
  const result = readRegister({ fencesPath: authored, checkout, outDir, deps: { home: root } })
  assert.equal(result.sanitised, false)
  assert.equal(result.registerPath, authored)
  assert.deepEqual(fsReaddirSync(outDir).sort(), before)
  assert.deepEqual(result.externals, [])
})

test('readRegister refuses malformed external markers, missing names, and duplicates', () => {
  const checkout = gitFixture()
  const outDir = join(checkout, 'invalid-register-out')
  const cases = [
    { name: 'wrong marker', lanes: [{ lane: 'lane-a', files: ['src/owned.mjs'], external: 'yes' }] },
    { name: 'missing name', lanes: [{ files: ['src/owned.mjs'], external: true }] },
    { name: 'duplicate', lanes: [
      { lane: 'other-batch', files: ['README.md'], external: true },
      { lane: 'other-batch', files: ['src/stale.mjs'], external: true },
    ] },
  ]
  for (const item of cases) {
    const path = put(join(checkout, `${item.name.replaceAll(' ', '-')}.json`), JSON.stringify({ lanes: item.lanes }))
    const error = thrown(() => readRegister({ fencesPath: path, checkout, outDir, deps: { home: root } }))
    assert.equal(error.reason, 'batch-unreadable', item.name)
    assert.equal(error.message.includes(item.name === 'wrong marker' ? 'external' : item.name === 'missing name' ? 'no lane name' : 'twice'), true, item.name)
  }
})

test('externalFenceLiveness distinguishes live, settled, and absent crew directories', () => {
  const checkout = gitFixture()
  const home = join(root, 'external-liveness')
  const parentDir = join(root, 'external-liveness-parent')
  crewFixture({ home, repoDir: 'dt-live-external', laneDir: 'live-external', lane: 'live-external', checkout })
  const settled = crewFixture({ home, repoDir: 'dt-settled-external', laneDir: 'settled-external', lane: 'settled-external', checkout })
  put(join(settled, 'returns', 'task.json'), JSON.stringify({ status: 'done' }))
  const rows = externalFenceLiveness({
    externals: ['live-external', 'settled-external', 'absent-external'],
    parentDir,
    deps: { home },
  })
  assert.deepEqual(rows.map(({ lane, live, reason, stage }) => ({ lane, live, reason, stage })), [
    { lane: 'live-external', live: true, reason: null, stage: 'build:r1' },
    { lane: 'settled-external', live: false, reason: 'run-settled', stage: 'build:r1' },
    { lane: 'absent-external', live: false, reason: 'crew-dir-absent', stage: null },
  ])
  assert.equal(rows[0].dir, externalCrewDir({ lane: 'live-external', parentDir, deps: { home } }))
})

test('externalFenceLiveness uses fresh heartbeats, abandons stale activity, and leaves empty journals unmeasured', () => {
  const checkout = gitFixture()
  const home = join(root, 'external-heartbeat-states')
  const parentDir = join(root, 'external-heartbeat-parent')
  const now = 10 * 60 * 60 * 1000
  const staleAfter = DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS
  crewFixture({ home, repoDir: 'dt-fresh-heartbeat', laneDir: 'fresh-heartbeat', checkout, at: now - staleAfter })
  const abandoned = crewFixture({ home, repoDir: 'dt-abandoned-heartbeat', laneDir: 'abandoned-heartbeat', checkout, at: now - staleAfter - 1 })
  const unmeasured = crewFixture({ home, repoDir: 'dt-empty-heartbeat', laneDir: 'empty-heartbeat', checkout, at: now - staleAfter - 1 })
  put(join(unmeasured, 'journal.jsonl'), '')
  const rows = externalFenceLiveness({
    externals: ['fresh-heartbeat', 'abandoned-heartbeat', 'empty-heartbeat'],
    parentDir,
    deps: { home, now: () => now },
  })
  assert.deepEqual(rows.map(({ lane, live, reason, heartbeat_age_ms, stale_after_ms }) => ({
    lane, live, reason, heartbeat_age_ms, stale_after_ms,
  })), [
    { lane: 'fresh-heartbeat', live: true, reason: null, heartbeat_age_ms: staleAfter, stale_after_ms: staleAfter },
    { lane: 'abandoned-heartbeat', live: false, reason: 'external-fence-abandoned', heartbeat_age_ms: staleAfter + 1, stale_after_ms: staleAfter },
    { lane: 'empty-heartbeat', live: true, reason: null, heartbeat_age_ms: null, stale_after_ms: staleAfter },
  ])
  assert.equal(rows[2].sibling_files.length, 0)
})

test('externalLaneReason preserves settled, complete, and escalated terminal reasons', () => {
  assert.equal(externalLaneReason({ settled: true, stage: 'escalate:scope' }), 'run-settled')
  assert.equal(externalLaneReason({ settled: false, stage: 'done' }), 'run-complete')
  assert.equal(externalLaneReason({ settled: false, stage: 'escalate:scope' }), 'run-escalated')
  assert.equal(externalLaneReason({ settled: false, stage: null }), 'run-complete')
})

test('checkFences distinguishes an abandoned external refusal from a settled one', () => {
  const checkout = gitFixture()
  const home = join(root, 'external-terminal-reasons')
  const parentDir = join(root, 'external-terminal-parent')
  const now = 10 * 60 * 60 * 1000
  const staleAfter = DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS
  crewFixture({ home, repoDir: 'dt-abandoned-external', laneDir: 'abandoned-external', checkout, at: now - staleAfter - 1 })
  const abandoned = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('abandoned-external', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }],
    checkout,
    externals: ['abandoned-external'],
    parentDir,
    deps: { home, now: () => now, log: () => {} },
  }))
  assert.equal(abandoned.reason, 'external-fence-abandoned')
  assert.match(abandoned.message, /heartbeat age/)
  assert.match(abandoned.message, /stale after/)
  const settledDir = crewFixture({ home, repoDir: 'dt-settled-external', laneDir: 'settled-external', checkout, at: now - staleAfter - 1 })
  put(join(settledDir, 'returns', 'task.json'), JSON.stringify({ status: 'done' }))
  const settled = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('settled-external', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }],
    checkout,
    externals: ['settled-external'],
    parentDir,
    deps: { home, now: () => now, log: () => {} },
  }))
  assert.equal(settled.reason, 'external-fence-stale')
})

test('checkFences reports external fence contradictions and marks an empty comparison unmeasured', () => {
  const checkout = gitFixture()
  const home = join(root, 'external-fence-comparison')
  const parentDir = join(root, 'external-fence-comparison-parent')
  const now = 10 * 60 * 60 * 1000
  crewFixture({
    home, repoDir: 'dt-claimed-external', laneDir: 'claimed-external', checkout, at: now,
    fence: [{ lane: 'external-sibling', files: ['docs/claimed.md'] }],
  })
  crewFixture({ home, repoDir: 'dt-empty-external', laneDir: 'empty-external', checkout, at: now })
  const logs = []
  const report = checkFences({
    fences: [
      entry('lane-a', ['src/owned.mjs']),
      entry('lane-b', ['src/stale.mjs']),
      entry('claimed-external', ['docs/claimed.md']),
      entry('empty-external', ['README.md']),
    ],
    lanes: [{ lane: 'lane-a', where: [] }, { lane: 'lane-b', where: [] }],
    checkout,
    externals: ['claimed-external', 'empty-external'],
    parentDir,
    deps: { home, now: () => now, log: (line) => logs.push(String(line)) },
  })
  const mismatch = report.warnings.find(({ kind }) => kind === 'external-fence-mismatch')
  assert.deepEqual(mismatch.declared, ['docs/claimed.md'])
  assert.deepEqual(mismatch.claimed, ['docs/claimed.md'])
  assert.deepEqual(mismatch.files, ['docs/claimed.md'])
  assert.match(mismatch.text, /under-declared external is not measured/)
  assert.ok(logs.some((line) => line.includes('lane=empty-external') && line.includes('fence_compare=unmeasured')))
})

test('externalFenceLiveness rejects a slug-collision crew identity by the requested name', () => {
  const checkout = gitFixture()
  const home = join(root, 'external-slug-collision')
  const parentDir = join(root, 'external-slug-collision-parent')
  crewFixture({ home, repoDir: 'dt-other-lane', laneDir: 'other-lane', lane: 'other-lane', checkout })
  const [requested, actual] = externalFenceLiveness({
    externals: ['other_lane', 'other-lane'],
    parentDir,
    deps: { home },
  })
  assert.deepEqual(
    { lane: requested.lane, live: requested.live, reason: requested.reason, stage: requested.stage },
    { lane: 'other_lane', live: false, reason: 'crew-lane-mismatch', stage: null },
  )
  assert.equal(actual.live, true)
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('other_lane', ['src/stale.mjs'])],
    lanes: [{ lane: 'lane-a', where: [] }],
    checkout,
    externals: ['other_lane'],
    parentDir,
    deps: { home, log: () => {} },
  }))
  assert.equal(error.reason, 'external-fence-stale')
  assert.equal(error.message.includes('other_lane'), true)
  assert.equal(error.message.includes('crew-lane-mismatch'), true)
})

test('checkFences refuses a batch lane marked external', () => {
  refusal(() => checkFences({
    fences: [entry('lane-a', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }],
    externals: ['lane-a'],
    deps: { home: join(root, 'claimed-both-home'), log: () => {} },
  }), 'fence-register-mismatch')
})

test('crossBatchCollisions skips only the named external self-pair', () => {
  const files = ['README.md']
  assert.deepEqual(crossBatchCollisions({
    entries: [{ lane: 'external-lane', files }],
    live: [{ lane: 'external-lane', dir: '/tmp/external', files }],
    externals: ['external-lane'],
  }), [])
  const collisions = crossBatchCollisions({
    entries: [{ lane: 'lane-a', files }],
    live: [{ lane: 'external-lane', dir: '/tmp/external', files }],
    externals: ['external-lane'],
  })
  assert.equal(collisions.length, 1)
  assert.equal(collisions[0].lane, 'lane-a')
})

test('crossBatchCollisions reports a collision when a different live lane holds an external entry', () => {
  const collisions = crossBatchCollisions({
    entries: [{ lane: 'external-lane', files: ['docs/notes.md'] }],
    live: [{ lane: 'different-live-lane', dir: '/tmp/different-live', files: ['docs/notes.md'] }],
    externals: ['external-lane'],
  })
  assert.deepEqual(collisions, [{
    lane: 'external-lane', live: 'different-live-lane', dir: '/tmp/different-live', files: ['docs/notes.md'],
  }])
})

test('checkFences validates external liveness, logs carried rows, and preserves sibling leakage', () => {
  const checkout = gitFixture()
  const home = join(root, 'external-fence-checks')
  const parentDir = join(root, 'external-fence-parent')
  crewFixture({ home, repoDir: 'dt-external-live', laneDir: 'external-live', lane: 'external-live', checkout })
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('lane-b', ['src/stale.mjs']), entry('external-live', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }, { lane: 'lane-b', where: [] }],
    checkout,
    externals: ['external-live'],
    parentDir,
    deps: { home, log: (line) => logs.push(String(line)) },
  })
  assert.deepEqual(report.externals.map(({ lane, live }) => ({ lane, live })), [{ lane: 'external-live', live: true }])
  assert.equal(logs.some((line) => line.startsWith(EXTERNAL_FENCE_PREFIX) && line.includes('lane=external-live') && line.includes('crew_dir=')), true)
  assert.equal(logs.some((line) => line.startsWith(EXTERNAL_FENCE_PREFIX) && line.includes('carried=1') && line.includes('NOT counted in the sibling total')), true)

  const stale = crewFixture({ home, repoDir: 'dt-external-stale', laneDir: 'external-stale', lane: 'external-stale', checkout })
  put(join(stale, 'returns', 'task.json'), JSON.stringify({ status: 'done' }))
  const staleError = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('lane-b', ['src/stale.mjs']), entry('external-stale', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }, { lane: 'lane-b', where: [] }],
    checkout,
    externals: ['external-stale'],
    parentDir,
    deps: { home, log: () => {} },
  }))
  assert.equal(staleError.reason, 'external-fence-stale')
  assert.equal(staleError.message.includes('external-stale'), true)

  const siblingError = thrown(() => checkFences({
    fences: [entry('lane-a', ['README.md']), entry('lane-b', ['src/stale.mjs']), entry('external-live', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }, { lane: 'lane-b', where: [] }],
    checkout,
    externals: ['external-live'],
    parentDir,
    deps: { home, log: () => {} },
  }))
  assert.equal(siblingError.reason, 'sibling-leak')
})

test('checkFences refuses an absent external lane by name', () => {
  const checkout = gitFixture()
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('lane-b', ['src/stale.mjs']), entry('external-missing', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }, { lane: 'lane-b', where: [] }],
    checkout,
    externals: ['external-missing'],
    parentDir: join(root, 'external-absent-parent'),
    deps: { home: join(root, 'external-absent-home'), log: () => {} },
  }))
  assert.equal(error.reason, 'external-fence-stale')
  assert.equal(error.message.includes('external-missing'), true)
})

function fixtureTests(checkout, why = 'fixture test reach reviewed') {
  try {
    return fsReaddirSync(join(checkout, 'test'))
      .filter((name) => name.endsWith('.test.mjs'))
      .map((name) => ({ file: `test/${name}`, why }))
  } catch { return [] }
}

function reachReport(checkout, fenceFiles = ['lib/widget.mjs'], surface = fenceFiles, deps = {}, outDir, allow = fixtureTests(checkout)) {
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', fenceFiles)],
    lanes: [{ lane: 'lane-a', where: surface, [TEST_REACH_OVERRIDE_KEY]: allow }],
    checkout,
    outDir,
    deps: { home: root, log: (line) => logs.push(String(line)), ...deps },
  })
  const warning = report.warnings.find((item) => item.kind === 'test-reach')
  return { report, logs, warning, rows: warning?.reach || [] }
}

function reachCheck({ checkout, fenceFiles, surface = fenceFiles, allow, outDir, extraFences = [], deps = {} }) {
  const logs = []
  try {
    const report = checkFences({
      fences: [entry('lane-a', fenceFiles), ...extraFences],
      lanes: [{ lane: 'lane-a', where: surface, [TEST_REACH_OVERRIDE_KEY]: allow }],
      checkout,
      outDir,
      deps: { home: root, log: (line) => logs.push(String(line)), ...deps },
    })
    return { report, logs, error: null }
  } catch (error) {
    return { report: null, logs, error }
  }
}

function summaryFixture(name) {
  const checkout = reachFixture(`summary-${name}`)
  anchorFixtures(checkout, { one: { 'lib/widget.mjs:1': 'export const widgetValue = 1' } })
  put(join(checkout, 'skills', 'one', 'references', 'notes.md'), 'Declared at `lib/widget.mjs:1`.\n')
  const home = join(root, `summary-${name}-home`)
  crewFixture({ home, repoDir: `dt-summary-${name}`, laneDir: 'unknown-lane', lane: 'unknown-lane', checkout, malformed: true })
  const fences = [entry('lane-a', ['lib/widget.mjs']), entry('lane-b', ['lib/caller.mjs'])]
  const lanes = [
    { lane: 'lane-a', where: ['lib/widget.mjs'], allow_test_reach: fixtureTests(checkout) },
    { lane: 'lane-b', where: ['lib/caller.mjs'], allow_test_reach: fixtureTests(checkout) },
  ]
  return { checkout, home, fences, lanes }
}

function summaryDeps(home, logs) {
  return {
    home,
    spawn: (options) => options.args?.includes('ls-files')
      ? spawnSync(options.file, options.args, { cwd: options.cwd, encoding: 'utf8' })
      : { status: 1, stdout: '', stderr: '' },
    log: (line) => logs.push(String(line)),
  }
}

function summaryLines(logs) {
  return logs.filter((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY '))
}

test('an unwritable report prints every warning row on stdout instead of losing it', () => {
  // The summary replaced the full listing on stdout, so the rows live only in the report.
  // An unwritable outDir would otherwise turn N rows into a single count and record them
  // nowhere at all. The log gets shorter; a row is never LOST.
  const fixture = summaryFixture('unpersisted')
  const logs = []
  const deps = {
    ...summaryDeps(fixture.home, logs),
    writeFileSync: () => { const err = new Error('EACCES: permission denied'); err.code = 'EACCES'; throw err },
  }
  const report = checkFences({
    fences: fixture.fences,
    lanes: fixture.lanes,
    checkout: fixture.checkout,
    outDir: join(fixture.checkout, 'unpersisted-out'),
    deps,
  })
  const summary = summaryLines(logs)
  assert.equal(summary.length > 0, true)
  assert.match(summary[0], /report=\(report unavailable: EACCES\)/)

  const banner = logs.filter((line) => line.startsWith(WARNING_ROWS_UNPERSISTED_PREFIX))
  assert.equal(banner.length, 1, 'the operator is told the rows are printed because nothing persisted them')

  // every warning the check produced reaches stdout in full
  const rowsOnStdout = report.warnings.filter((w) => typeof w.text === 'string' && w.text)
  assert.equal(rowsOnStdout.length > 0, true, 'the fixture must produce at least one warning')
  for (const warning of rowsOnStdout) {
    assert.equal(logs.includes(warning.text), true, `warning kind ${warning.kind} was lost`)
  }
  // and the BLIND SPOT text survives with them
  assert.equal(logs.some((line) => line.includes('BLIND SPOT')), true)
})

test('a writable report keeps the log short and does NOT print the rows', () => {
  const fixture = summaryFixture('persisted')
  const logs = []
  const outDir = join(fixture.checkout, 'persisted-out')
  const report = checkFences({
    fences: fixture.fences, lanes: fixture.lanes, checkout: fixture.checkout, outDir,
    deps: summaryDeps(fixture.home, logs),
  })
  assert.equal(logs.filter((line) => line.startsWith(WARNING_ROWS_UNPERSISTED_PREFIX)).length, 0)
  // test-reach-override logs in full by design and is excluded; the DEFERRED kinds are
  // the ones the summary moved off stdout, and those must not reappear when persisted.
  const deferredKinds = new Set(['citation-carrier', 'test-reach', 'anchor-pin'])
  const texts = report.warnings.filter((w) => deferredKinds.has(w.kind) && typeof w.text === 'string' && w.text).map((w) => w.text)
  assert.equal(texts.length > 0, true, 'the fixture must produce at least one deferred warning')
  for (const text of texts) assert.equal(logs.includes(text), false, 'a persisted row must not also be printed in full')
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.equal(reportRowCount(persisted) > 0, true)
})

function reportRowCount(report) {
  return report.lanes.reduce((total, lane) => total + lane.anchor_pins.length + lane.citation_carriers.length + lane.test_reach.length, 0) + report.cross_batch_unknown.length
}

function namedReachFixture(name, files = {}) {
  return reachFixture(name, {
    files: {
      'crew/capabilities.mjs': 'export const CAPABILITY_REFUSALS = []\n',
      'crew/adapters/adapter-pi.mjs': [
        'export function grantsFor() { return {} }',
        'export function loadCapabilities() { return {} }',
        'export function assertGrantsBacked() { return true }',
        '',
      ].join('\n'),
      'crew/crew.test.mjs': [
        "import { grantsFor, loadCapabilities, assertGrantsBacked } from './adapters/adapter-pi.mjs'",
        'grantsFor()',
        'loadCapabilities()',
        'assertGrantsBacked()',
        '',
      ].join('\n'),
      ...files,
    },
  })
}

test('A1', async () => {
  const fixture = summaryFixture('A1')
  const directLogs = []
  const outDir = join(fixture.checkout, 'a1-direct-out')
  const direct = checkFences({
    fences: fixture.fences,
    lanes: fixture.lanes,
    checkout: fixture.checkout,
    outDir,
    deps: summaryDeps(fixture.home, directLogs),
  })
  const directSummaries = summaryLines(directLogs)
  assert.equal(directSummaries.length, fixture.lanes.length)
  assert.deepEqual(directSummaries.map((line) => line.match(/lane=([^ ]+)/)?.[1]), ['lane-a', 'lane-b'])
  assert.match(directSummaries[0], /refusals=none anchor-pin=1 · citation-carrier=1 · test-reach=3 · actionable=0 · collapsed=1 · cross-batch-unknown=1/)
  assert.match(directSummaries[1], /refusals=none anchor-pin=0 · citation-carrier=0 · test-reach=3 · actionable=0 · collapsed=1 · cross-batch-unknown=1/)
  for (const line of directSummaries) {
    assert.ok(line.includes(join(outDir, FENCE_REPORT_FILE)))
    assert.ok(line.includes('doctrine=skills/crew-dispatch/references/batch.md'))
    assert.doesNotMatch(line, /test\/(?:direct|twohop|threehop)\.test\.mjs|lib\/(?:widget|caller)\.mjs|skills\/one\/references\/notes\.md|lib\/widget\.mjs:1/)
    assert.equal(line.includes('\n'), false)
    assert.ok(Buffer.byteLength(line, 'utf8') < 600)
  }
  assert.equal(direct.warnings.filter(({ kind }) => ['anchor-pin', 'citation-carrier', 'test-reach', 'cross-batch-unknown'].includes(kind)).length, 5)

  const batch = join(fixture.checkout, 'a1-dry-batch')
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify({ ...request('measure lane-a', ['lib/widget.mjs']), allow_test_reach: fixture.lanes[0].allow_test_reach }))
  put(join(batch, `lane-b${REQUEST_SUFFIX}`), JSON.stringify({ ...request('measure lane-b', ['lib/caller.mjs']), allow_test_reach: fixture.lanes[1].allow_test_reach }))
  const dryLogs = []
  const dryOut = join(fixture.checkout, 'a1-dry-out')
  const dry = await dispatchBatch({
    batchDir: batch,
    fences: fixture.fences,
    checkout: fixture.checkout,
    parentDir: join(fixture.checkout, 'parents'),
    outDir: dryOut,
    runFlags: { 'dry-run': true },
    deps: summaryDeps(fixture.home, dryLogs),
  })
  assert.equal(dry.dryRun, true)
  const drySummaries = summaryLines(dryLogs)
  assert.equal(drySummaries.length, fixture.lanes.length)
  assert.ok(drySummaries.every((line) => line.includes(join(dryOut, FENCE_REPORT_FILE))))
  assert.ok(drySummaries.every((line) => line.includes('doctrine=skills/crew-dispatch/references/batch.md')))
})

test('B1', () => {
  const checkout = namedReachFixture('B1', {
    'crew/reader.mjs': "import { grantsFor } from './adapters/adapter-pi.mjs'\nexport const readerValue = grantsFor()\n",
    'test/twohop.test.mjs': "import { readerValue } from '../crew/reader.mjs'\nif (!readerValue) throw new Error('x')\n",
  })
  const outDir = join(checkout, 'b1-out')
  const logs = []
  let error
  try {
    checkFences({
      fences: [entry('lane-a', ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'])],
      lanes: [{ lane: 'lane-a', where: ['crew/adapters/adapter-pi.mjs'] }],
      checkout,
      outDir,
      deps: { home: join(root, 'b1-home'), log: (line) => logs.push(String(line)) },
    })
  } catch (caught) {
    error = caught
  }
  assert.equal(error?.reason, 'test-reach-unfenced')
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  const expectedRows = testsOutsideFence({
    surface: ['crew/adapters/adapter-pi.mjs'],
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    reach: collectTestReach({ checkout }),
  })
  assert.deepEqual(persisted.lanes[0].test_reach, expectedRows)
  assert.ok(expectedRows.some((row) => row.test === 'crew/crew.test.mjs' && row.hops === 1))
  assert.ok(expectedRows.some((row) => row.test === 'test/twohop.test.mjs' && row.hops === 2))
  const summary = summaryLines(logs)[0]
  assert.match(summary, /test-reach=3 · actionable=2 · collapsed=3/)
  assert.equal(persisted.lanes[0].test_reach.length, expectedRows.length)
})

test('C1', () => {
  const checkout = gitFixture()
  const outDir = join(checkout, 'c1-out')
  const logs = []
  const result = checkFences({
    fences: [entry('lane-a', ['src/owned.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['src/owned.mjs'] }],
    checkout,
    outDir,
    deps: { home: join(root, 'c1-home'), log: (line) => logs.push(String(line)) },
  })
  const report = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  const expected = {
    'anchor-pin': 'BLIND SPOT: an unpinned file:line citation is in no manifest key, so neither this check nor the citation-carrier check can find it; a citation the anchor corpus does not pin is still discoverable only by hand',
    'citation-carrier': 'BLIND SPOT: this finds docs carrying a PINNED path:line citation and nothing else. A citation no manifest pins is in no key, and a doc whose exhibit set-compares a documented table against source (skills/crew-recovery/references/escalations.md and the escalate() producers) reddens with every citation in it still correct. Neither is discoverable here; read the exhibits suites of the manifests named above before choosing this fence',
    'test-reach': 'BLIND SPOT: this is a proxy in BOTH directions and names candidates, never proof. A test can assert the changed behaviour through a higher-level entry point without importing the changed file at all, and a computed path or dynamic import is invisible to a static scan — crew/crew.mjs loads every adapter that way. A test can equally import a fenced file without asserting anything about the part being changed. The literal symbol scan sees only whole-word occurrences of an exported name, is blind to a renamed re-export, and drops any symbol naming more than 8 test files as too broad to be evidence. Read the named files before choosing this fence; an unnamed one is not cleared. An apostrophe or quote inside a // or /* */ comment opens a phantom literal and hides every real path literal after it in that file.',
    'cross-batch-unknown': 'BLIND SPOT: a lane booted without --fences declares no surface at all and can be editing anything; a lane whose batch siblings have been reaped records no claim; and a repository whose git dir cannot be measured is not compared. None of those are cleared — they are reported unknown.',
  }
  assert.deepEqual(report.blind_spots, expected)
  const text = readFileSync(join(repoRoot, 'skills/crew-dispatch/references/batch.md'), 'utf8')
  for (const statement of Object.values(expected)) assert.equal(text.split(statement).length - 1, 1)
  assert.ok(summaryLines(logs).every((line) => line.includes('doctrine=skills/crew-dispatch/references/batch.md')))
})

test('path reach reports a rooted planner charter literal', () => {
  const planner = ['crew', 'roles', 'planner.md'].join('/')
  const reach = collectTestReach({ checkout: repoRoot })
  const rows = testsOutsideFence({ surface: [planner], fenceFiles: [planner], reach })
  assert.deepEqual(rows.find((row) => row.test === 'crew/crew.test.mjs'), {
    test: 'crew/crew.test.mjs', file: planner, hops: null, how: 'path', symbols: [],
  })
  const result = reachCheck({ checkout: repoRoot, fenceFiles: [planner], surface: [planner] })
  assert.equal(result.error?.reason, 'test-reach-unfenced')
  assert.match(result.error?.message || '', /crew\/crew\.test\.mjs reaches crew\/roles\/planner\.md through a static path literal/)
})

test('path reach rejects an absolute basename collision', () => {
  const checkout = reachFixture('path-absolute', {
    files: {
      'crew/roles/planner.md': '# planner\\n',
      'test/absolute.test.mjs': "readFileSync('/tmp/crew-task/planner.md', 'utf8')\\n",
    },
  })
  const rows = testsOutsideFence({
    surface: ['crew/roles/planner.md'], fenceFiles: [], reach: collectTestReach({ checkout }),
  })
  assert.equal(rows.some((row) => row.file === 'crew/roles/planner.md'), false)
})


test('path reach resolves joined repository segments', () => {
  const checkout = reachFixture('path-joined', {
    files: {
      'crew/roles/planner.md': '# planner\\n',
      'test/joined.test.mjs': ['join(ROOT', " 'crew'", " 'roles'", " 'planner.md')"].join(','),
    },
  })
  const rows = testsOutsideFence({
    surface: ['crew/roles/planner.md'], fenceFiles: [], reach: collectTestReach({ checkout }),
  })
  assert.deepEqual(rows.find((row) => row.test === 'test/joined.test.mjs'), {
    test: 'test/joined.test.mjs', file: 'crew/roles/planner.md', hops: null, how: 'path', symbols: [],
  })
})

test('allow_test_reach requires a why for every test', () => {
  const invalid = [
    ['test/direct.test.mjs'],
    [{ file: 'test/direct.test.mjs' }],
    [{ why: 'missing file' }],
    [{ file: '', why: 'blank file' }],
    [{ file: 'test/direct.test.mjs', why: '' }],
    [{ file: 'test/direct.test.mjs', why: '   ' }],
  ]
  for (const allow of invalid) {
    const batch = makeBatch(['lane-a'])
    const requestPath = join(batch, `lane-a${REQUEST_SUFFIX}`)
    put(requestPath, JSON.stringify(requestFor('lane-a', { [TEST_REACH_OVERRIDE_KEY]: allow })))
    assert.throws(() => readBatch({ batchDir: batch }), (error) => error instanceof BatchRefusal
      && error.reason === 'batch-unreadable' && error.message.includes(requestPath))
  }
  assert.equal(isTestReachOverride({ file: 'test/direct.test.mjs', why: 'covered' }), true)
  const batch = makeBatch(['lane-a'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', {
    [TEST_REACH_OVERRIDE_KEY]: [{ file: ' ./test/direct.test.mjs ', why: ' covered by a separate suite ' }],
  })))
  const [lane] = readBatch({ batchDir: batch })
  assert.deepEqual(lane[TEST_REACH_OVERRIDE_KEY], [{ file: 'test/direct.test.mjs', why: 'covered by a separate suite' }])
})

test('path reach preserves import, symbol, and path rows byte for byte', () => {
  const checkout = reachFixture('path-preserves', {
    files: {
      'test/import-and-path.test.mjs': "import { widgetShape } from '../lib/widget.mjs'\\nconst path = '../lib/widget.mjs'\\nwidgetShape()\\nvoid path\\n",
      'test/symbol-and-path.test.mjs': "const path = '../lib/widget.mjs'\\nconst seen = 'widgetShape'\\nvoid path\\nif (!seen) throw new Error('x')\\n",
    },
  })
  const droppedRows = []
  const rows = testsOutsideFence({
    surface: ['lib/widget.mjs'], fenceFiles: [], reach: collectTestReach({ checkout }), droppedRows,
  })
  assert.deepEqual(rows.find((row) => row.test === 'test/import-and-path.test.mjs' && row.how === 'import'), {
    test: 'test/import-and-path.test.mjs', file: 'lib/widget.mjs', hops: 1, how: 'import', symbols: ['widgetShape'],
  })
  assert.deepEqual(rows.find((row) => row.test === 'test/import-and-path.test.mjs' && row.how === 'path'), {
    test: 'test/import-and-path.test.mjs', file: 'lib/widget.mjs', hops: null, how: 'path', symbols: [],
  })
  assert.deepEqual(rows.find((row) => row.test === 'test/symbol-and-path.test.mjs' && row.how === 'symbol'), {
    test: 'test/symbol-and-path.test.mjs', file: 'lib/widget.mjs', hops: null, how: 'symbol', symbols: ['widgetShape'],
  })
  assert.deepEqual(rows.find((row) => row.test === 'test/symbol-and-path.test.mjs' && row.how === 'path'), {
    test: 'test/symbol-and-path.test.mjs', file: 'lib/widget.mjs', hops: null, how: 'path', symbols: [],
  })
  assert.deepEqual(droppedRows.filter((row) => row.test === 'test/import-and-path.test.mjs'), [{
    test: 'test/import-and-path.test.mjs', file: 'lib/widget.mjs', hops: null, how: 'symbol', symbols: ['widgetShape'],
  }])
})

test('relative import specifiers are path refusals and doctrine tells operators', () => {
  const surface = ['lib', 'widget.mjs'].join('/')
  const testFile = ['test', 'import-specifier.test.mjs'].join('/')
  const relativeSpecifier = ['..', 'lib', 'widget.mjs'].join('/')
  const checkout = reachFixture('relative-import-specifier', {
    files: {
      [testFile]: [
        `import { notExportedHere } from ${JSON.stringify(relativeSpecifier)}`,
        'notExportedHere()',
        '',
      ].join('\n'),
    },
  })
  const allowDirect = [{ file: 'test/direct.test.mjs', why: 'the default direct fixture is outside this focused check' }]
  const rejected = reachCheck({ checkout, fenceFiles: [surface], surface: [surface], allow: allowDirect })
  assert.equal(rejected.error?.reason, 'test-reach-unfenced')
  assert.ok(rejected.error?.message.includes(`${testFile} reaches ${surface} through a static path literal (which includes its own import specifier; path-only, how=path)`))

  const rows = testsOutsideFence({ surface: [surface], fenceFiles: [], reach: collectTestReach({ checkout }) })
    .filter((row) => row.test === testFile)
  assert.deepEqual(rows.find((row) => row.how === 'import'), {
    test: testFile, file: surface, hops: 1, how: 'import', symbols: [],
  })
  assert.deepEqual(rows.find((row) => row.how === 'path'), {
    test: testFile, file: surface, hops: null, how: 'path', symbols: [],
  })
  assert.deepEqual(reachRefusalRows({ rows, surfaceExports: ['widgetShape'] }), [{
    test: testFile, file: surface, symbols: [],
  }])

  const admitted = reachCheck({
    checkout,
    fenceFiles: [surface],
    surface: [surface],
    allow: [...allowDirect, { file: testFile, why: 'the current refusal list names the import-specifier path fact' }],
  })
  assert.equal(admitted.error, null)
  const override = admitted.logs.find((line) => line.startsWith(TEST_REACH_OVERRIDE_PREFIX))
  assert.ok(override?.includes(`${testFile} reaches ${surface} through a static path literal (which includes its own import specifier; path-only, how=path)`))

  const source = readFileSync(join(repoRoot, 'scripts', 'factory', 'dispatch-batch.mjs'), 'utf8')
  assert.ok(source.includes("Every `how === 'path'` row is an\n// unconditional `test-reach-unfenced` refusal."))
  assert.ok(source.includes("a test's own relative import specifier for a fenced file emits"))
  assert.equal(source.includes('Every other row stays a warning.'), false)
  assert.ok(source.includes('Every other import/symbol row\n// stays a warning.'))

  const doctrine = readFileSync(join(repoRoot, 'skills', 'crew-dispatch', 'references', 'batch.md'), 'utf8')
  assert.ok(doctrine.includes('a test whose own relative import specifier names a fenced file now yields a `path` row and is a hard `test-reach-unfenced` refusal'))
  assert.ok(doctrine.includes('Compile `allow_test_reach` from the CURRENT `dispatch-batch` run\'s refusal list, not from prior experience of the surface.'))
  for (const measurement of [
    '`crew/crew.mjs` 6 -> 15 refused tests',
    '`crew/drive.mjs` 15 -> 17',
    '`scripts/factory/dispatch-batch.mjs` 3 -> 4',
    '`crew/adapters/adapter-pi.mjs` (8 -> 8)',
    '`crew/host-load.mjs` (1 -> 1)',
    '`crew/roster.json` (5 -> 5) were unchanged',
    'measured over those six fence surfaces on this tree',
  ]) assert.ok(doctrine.includes(measurement), `doctrine omitted ${measurement}`)
})

test('two-file mixed reach keeps an actionable path fact', () => {
  const checkout = twoOwnerReachFixture('mixed')
  const ownerA = ['lib', 'owner-a.mjs'].join('/')
  const ownerB = ['lib', 'owner-b.mjs'].join('/')
  const testFile = ['test', 'two-owner.test.mjs'].join('/')
  const rows = testsOutsideFence({
    surface: [ownerA, ownerB], fenceFiles: [], reach: collectTestReach({ checkout }),
  }).filter((row) => row.test === testFile)
  assert.deepEqual(rows, [
    { test: testFile, file: ownerA, hops: null, how: 'symbol', symbols: ['alphaName', 'betaName'] },
    { test: testFile, file: ownerB, hops: null, how: 'path', symbols: [] },
  ])
  assert.deepEqual(reachRefusalRows({ rows, surfaceExports: ['alphaName', 'betaName', 'bravoName'] }), [{
    test: testFile, file: ownerB, symbols: [],
  }])
})

test('the path fact names the file reached by path', () => {
  const checkout = twoOwnerReachFixture('path-owner')
  const ownerB = ['lib', 'owner-b.mjs'].join('/')
  const testFile = ['test', 'two-owner.test.mjs'].join('/')
  const row = testsOutsideFence({
    surface: [ ['lib', 'owner-a.mjs'].join('/'), ownerB ], fenceFiles: [], reach: collectTestReach({ checkout }),
  }).find((candidate) => candidate.test === testFile && candidate.how === 'path')
  assert.deepEqual(row, { test: testFile, file: ownerB, hops: null, how: 'path', symbols: [] })
})

test('symbol-only reach remains non-actionable', () => {
  const checkout = twoOwnerReachFixture('symbol-only')
  const ownerA = ['lib', 'owner-a.mjs'].join('/')
  const testFile = ['test', 'two-owner.test.mjs'].join('/')
  const row = testsOutsideFence({
    surface: [ownerA], fenceFiles: [], reach: collectTestReach({ checkout }),
  }).find((candidate) => candidate.test === testFile && candidate.how === 'symbol')
  assert.deepEqual(row, { test: testFile, file: ownerA, hops: null, how: 'symbol', symbols: ['alphaName', 'betaName'] })
  assert.deepEqual(reachRefusalRows({ rows: [row], surfaceExports: ['alphaName', 'betaName'] }), [])
})

test('the warning report retains both cross-file facts', () => {
  const checkout = twoOwnerReachFixture('report')
  const ownerA = ['lib', 'owner-a.mjs'].join('/')
  const ownerB = ['lib', 'owner-b.mjs'].join('/')
  const testFile = ['test', 'two-owner.test.mjs'].join('/')
  const surface = [ownerA, ownerB]
  const outDir = join(checkout, 'warnings')
  checkFences({
    fences: [entry('lane-a', surface)],
    lanes: [{ lane: 'lane-a', where: surface, allow_test_reach: fixtureTests(checkout) }],
    checkout,
    outDir,
    deps: { home: root, log: () => {} },
  })
  const report = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(report.lanes[0].test_reach.filter((row) => row.test === testFile), [
    { test: testFile, file: ownerA, hops: null, how: 'symbol', symbols: ['alphaName', 'betaName'] },
    { test: testFile, file: ownerB, hops: null, how: 'path', symbols: [] },
  ])
  assert.ok(Array.isArray(report.lanes[0].test_reach_dropped))
})

test('the report names every collapsed reach row', () => {
  const checkout = twoOwnerReachFixture('dropped', { importer: true })
  const ownerA = ['lib', 'owner-a.mjs'].join('/')
  const importer = ['test', 'two-owner-import.test.mjs'].join('/')
  const mixed = ['test', 'two-owner.test.mjs'].join('/')
  const droppedRows = []
  const rows = testsOutsideFence({
    surface: [ownerA], fenceFiles: [], reach: collectTestReach({ checkout }), droppedRows,
  })
  assert.ok(rows.some((row) => row.test === importer && row.how === 'import'))
  assert.deepEqual(droppedRows, [
    { test: importer, file: ownerA, hops: null, how: 'symbol', symbols: ['alphaName'] },
    { test: importer, file: ownerA, hops: null, how: 'symbol', symbols: ['betaName'] },
    { test: mixed, file: ownerA, hops: null, how: 'symbol', symbols: ['betaName'] },
  ])

  const outDir = join(checkout, 'dropped-report')
  checkFences({
    fences: [entry('lane-a', [ownerA])],
    lanes: [{ lane: 'lane-a', where: [ownerA], allow_test_reach: fixtureTests(checkout) }],
    checkout,
    outDir,
    deps: { home: root, log: () => {} },
  })
  const report = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(report.lanes[0].test_reach_dropped, droppedRows)
  assert.equal(report.lanes[0].test_reach_dropped.length, 3)
  for (const row of report.lanes[0].test_reach_dropped) {
    assert.deepEqual(Object.keys(row).sort(), ['file', 'hops', 'how', 'symbols', 'test'])
  }
})

test('summary separates row actionable and collapsed counts', () => {
  const checkout = twoOwnerReachFixture('summary')
  const ownerA = ['lib', 'owner-a.mjs'].join('/')
  const ownerB = ['lib', 'owner-b.mjs'].join('/')
  const logs = []
  const outDir = join(checkout, 'summary')
  assert.throws(() => checkFences({
    fences: [entry('lane-a', [ownerA, ownerB])],
    lanes: [{ lane: 'lane-a', where: [ownerA, ownerB] }],
    checkout,
    outDir,
    deps: { home: root, log: (line) => logs.push(String(line)) },
  }), (error) => error instanceof BatchRefusal && error.reason === 'test-reach-unfenced')
  assert.ok(logs.some((line) => line.includes('test-reach=2 · actionable=1 · collapsed=1')))
  const report = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.equal(report.lanes[0].test_reach.length, 2)
  assert.equal(report.lanes[0].test_reach_dropped.length, 1)
})

test('the ledger floor path reach is actionable on the b542 surface', () => {
  const ledger = ['scripts', 'factory', 'ledger.mjs'].join('/')
  const ledgerTest = ['test', 'factory-ledger.test.mjs'].join('/')
  const floorTest = ['test', 'factory-ledger-floor.test.mjs'].join('/')
  const reach = collectTestReach({ checkout: repoRoot })
  const rows = testsOutsideFence({ surface: [ledger, ledgerTest], fenceFiles: [ledger, ledgerTest], reach })
  const floorPath = rows.find((row) => row.test === floorTest && row.file === ledgerTest && row.how === 'path')
  assert.deepEqual(floorPath, { test: floorTest, file: ledgerTest, hops: null, how: 'path', symbols: [] })
  const refusals = reachRefusalRows({ rows, surfaceExports: surfaceExportsOf({ surface: [ledger, ledgerTest], reach }) })
  assert.ok(refusals.some((row) => row.test === floorTest && row.file === ledgerTest && row.symbols.length === 0))
})

// The 50, 25, and 27 figures are functions of every tracked *.test.mjs file in the repo, not of this test. If this guard reddens in your lane, you have added or removed an apostrophe inside a comment in some tracked test file and flipped its parity; the fix is to RE-MEASURE and update skills/crew-dispatch/references/batch.md rather than hunt a scanner regression.
// Re-measure comment-apostrophe exposure with: node --input-type=module -e "import{readFileSync}from\"node:fs\";import{execFileSync}from\"node:child_process\";const files=execFileSync(\"git\",[\"ls-files\",\"-z\"],{encoding:\"utf8\"}).split(String.fromCharCode(0)).filter(file=>file.endsWith(\".test.mjs\")),apostrophes=text=>[...text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)].reduce((total,comment)=>total+[...comment[0]].filter(char=>char===String.fromCharCode(39)).length,0),measure=textOf=>{const counts=files.map(file=>apostrophes(textOf(file)));return{withApostrophe:counts.filter(Boolean).length,odd:counts.filter(value=>value%2).length}},shipped=measure(file=>readFileSync(file,\"utf8\")),head=measure(file=>execFileSync(\"git\",[\"show\",String.fromCharCode(72,69,65,68,58)+file],{encoding:\"utf8\"}));console.log({filesWithCommentApostrophe:shipped.withApostrophe,shippedOddCommentApostropheFiles:shipped.odd,pristineHEADOddCommentApostropheFiles:head.odd})"
test('RV2-1 doctrine separates shipped and pristine HEAD odd-comment counts', () => {
  const text = readFileSync(join(repoRoot, 'skills/crew-dispatch/references/batch.md'), 'utf8')
  const exposure = '50 of 77 tracked `*.test.mjs` files carry at least one apostrophe inside a comment, and 25 of those carry an odd number on the shipped tree (27 at pristine `HEAD`).'
  assert.equal(text.split(exposure).length - 1, 1)
})

test('D1', async () => {
  const checkout = namedReachFixture('D1')
  const direct = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.equal(direct.error?.reason, 'test-reach-unfenced')
  for (const token of ['lane lane-a', 'crew/crew.test.mjs', 'crew/adapters/adapter-pi.mjs', 'grantsFor', 'loadCapabilities', 'assertGrantsBacked', TEST_REACH_REFUSAL_REMEDY, TEST_REACH_REFUSAL_BLIND_SPOT]) assert.ok(direct.error.message.includes(token), `D1 omitted ${token}`)
  assert.equal(direct.logs.length, 1)
  assert.match(direct.logs[0], /refusals=test-reach-unfenced/)
  assert.equal(direct.logs[0].includes('crew/crew.test.mjs'), false)

  const batch = join(checkout, 'd1-dry-batch')
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure refusal behavior', ['crew/adapters/adapter-pi.mjs'])))
  const dryLogs = []
  const dryError = await thrownAsync(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'])],
    checkout,
    parentDir: join(checkout, 'parents'),
    outDir: join(checkout, 'd1-dry-out'),
    runFlags: { 'dry-run': true },
    deps: summaryDeps(join(root, 'd1-home'), dryLogs),
  }))
  assert.equal(dryError.reason, 'test-reach-unfenced')
  for (const token of ['lane lane-a', 'crew/crew.test.mjs', 'crew/adapters/adapter-pi.mjs', 'grantsFor', TEST_REACH_REFUSAL_REMEDY, TEST_REACH_REFUSAL_BLIND_SPOT]) assert.ok(dryError.message.includes(token), `D1 dry omitted ${token}`)
  const drySummary = summaryLines(dryLogs)[0]
  assert.match(drySummary, /refusals=test-reach-unfenced/)
  assert.equal(drySummary.includes('crew/crew.test.mjs'), false)
})

test('E1', async () => {
  const fixture = summaryFixture('E1')
  const logs = []
  const outDir = join(fixture.checkout, 'e1-out')
  const result = checkFences({
    fences: fixture.fences,
    lanes: fixture.lanes,
    checkout: fixture.checkout,
    outDir,
    deps: summaryDeps(fixture.home, logs),
  })
  const retained = result.warnings
    .filter(({ kind }) => ['anchor-pin', 'citation-carrier', 'test-reach', 'cross-batch-unknown'].includes(kind))
    .map(({ text }) => text)
  const summaries = summaryLines(logs)
  const before = Buffer.byteLength(retained.join('\n'), 'utf8')
  const after = Buffer.byteLength(summaries.join('\n'), 'utf8')
  const report = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.equal(reportRowCount(report), 9)
  assert.ok(after < before)
  assert.ok(after * 2 < before)

  const batch = join(fixture.checkout, 'e1-dry-batch')
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify({ ...request('measure lane-a', ['lib/widget.mjs']), allow_test_reach: fixture.lanes[0].allow_test_reach }))
  put(join(batch, `lane-b${REQUEST_SUFFIX}`), JSON.stringify({ ...request('measure lane-b', ['lib/caller.mjs']), allow_test_reach: fixture.lanes[1].allow_test_reach }))
  const dryLogs = []
  await dispatchBatch({
    batchDir: batch,
    fences: fixture.fences,
    checkout: fixture.checkout,
    parentDir: join(fixture.checkout, 'parents'),
    outDir: join(fixture.checkout, 'e1-dry-out'),
    runFlags: { 'dry-run': true },
    deps: summaryDeps(fixture.home, dryLogs),
  })
  const dryReport = JSON.parse(readFileSync(join(fixture.checkout, 'e1-dry-out', FENCE_REPORT_FILE), 'utf8'))
  assert.equal(reportRowCount(report), reportRowCount(dryReport))
  assert.equal(retained.length, 5)
  assert.equal(summaries.length, 2)
  console.log(`warning-log-bytes before=${before} after=${after} rows=${reportRowCount(report)}`)
})

test('checkFences reports direct and two-hop test reach without refusing', () => {
  const checkout = reachFixture('depth')
  const { report, warning, rows } = reachReport(checkout)
  assert.ok(warning)
  assert.equal(rows.find((row) => row.test === 'test/direct.test.mjs' && row.how === 'import')?.hops, 1)
  assert.equal(rows.find((row) => row.test === 'test/twohop.test.mjs' && row.how === 'import')?.hops, 2)
  assert.equal(rows.some((row) => row.test === 'test/threehop.test.mjs'), false)
  assert.equal(TEST_REACH_DEPTH, 2)
  assert.equal(warning.text.includes('test/twohop.test.mjs'), true)
  assert.equal(warning.text.includes(TEST_REACH_BLIND_SPOT), true)
  assert.equal(REFUSAL_REASONS.includes('test-reach-unfenced'), true)
  assert.ok(report.perLane['lane-a'])
})

test('checkFences refuses a one-hop import naming the write surface and names the remedy', () => {
  const checkout = namedReachFixture('refuse-one-hop')
  const result = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.ok(result.error instanceof BatchRefusal)
  assert.equal(result.error.reason, 'test-reach-unfenced')
  assert.equal(REFUSAL_REASONS.includes('test-reach-unfenced'), true)
  for (const token of ['crew/crew.test.mjs', 'crew/adapters/adapter-pi.mjs', 'grantsFor', 'loadCapabilities', 'assertGrantsBacked']) {
    assert.equal(result.error.message.includes(token), true, `refusal omitted ${token}`)
  }
  const corrected = ['crew/adapters/adapter-pi.mjs', 'crew/capabilities.mjs', 'crew/crew.test.mjs'].join(', ')
  assert.equal(result.error.message.includes(corrected), true)
  assert.equal(result.error.message.includes(TEST_REACH_REFUSAL_REMEDY), true)
  assert.equal(result.error.message.includes(TEST_REACH_REFUSAL_BLIND_SPOT), true)
})

test('a trailing-slash directory write surface refuses the same reaching test', () => {
  const checkout = namedReachFixture('refuse-directory')
  const result = reachCheck({
    checkout,
    fenceFiles: ['crew/adapters/'],
    surface: ['crew/adapters/'],
  })
  assert.ok(result.error instanceof BatchRefusal)
  assert.equal(result.error.reason, 'test-reach-unfenced')
  assert.equal(result.error.message.includes('crew/crew.test.mjs'), true)
  assert.equal(result.error.message.includes('crew/adapters/adapter-pi.mjs'), true)
  assert.equal(result.error.message.includes('grantsFor'), true)
  assert.equal(result.error.message.includes('crew/adapters/, crew/crew.test.mjs'), true)
})

test('test reach still only warns for a symbol-only row, a two-hop row, and an import naming no exported symbol', () => {
  const symbolCheckout = reachFixture('warn-symbol-only', {
    files: { 'test/symbol-only.test.mjs': 'const named = "widgetShape"\nif (!named) throw new Error("x")\n' },
  })
  const symbolRun = reachCheck({ checkout: symbolCheckout, fenceFiles: ['lib/widget.mjs'], surface: ['lib/widget.mjs'], allow: [{ file: 'test/direct.test.mjs', why: 'symbol-only fixture is intentionally outside the fence' }] })
  assert.equal(symbolRun.error, null)
  const symbolRow = symbolRun.report.warnings.find((row) => row.kind === 'test-reach').reach.find((row) => row.test === 'test/symbol-only.test.mjs')
  assert.equal(reachRefusalRows({ rows: [symbolRow], surfaceExports: surfaceExportsOf({ surface: ['lib/widget.mjs'], reach: collectTestReach({ checkout: symbolCheckout }) }) }).length, 0)

  const twoHopCheckout = reachFixture('warn-two-hop')
  const twoHopRun = reachCheck({ checkout: twoHopCheckout, fenceFiles: ['lib/widget.mjs'], surface: ['lib/widget.mjs'], allow: [{ file: 'test/direct.test.mjs', why: 'two-hop fixture is intentionally outside the fence' }] })
  assert.equal(twoHopRun.error, null)
  const twoHopRow = twoHopRun.report.warnings.find((row) => row.kind === 'test-reach').reach.find((row) => row.test === 'test/twohop.test.mjs')
  assert.equal(reachRefusalRows({ rows: [twoHopRow], surfaceExports: ['widgetShape'] }).length, 0)

  const noOverlapCheckout = reachFixture('warn-no-overlap', {
    files: { 'test/no-overlap.test.mjs': "import { notExportedHere } from '../lib/widget'\nnotExportedHere()\n" },
  })
  const noOverlapRun = reachCheck({ checkout: noOverlapCheckout, fenceFiles: ['lib/widget.mjs'], surface: ['lib/widget.mjs'], allow: [
    { file: 'test/direct.test.mjs', why: 'direct fixture is intentionally outside the fence' },
  ] })
  assert.equal(noOverlapRun.error, null)
  const noOverlapRows = noOverlapRun.report.warnings.find((row) => row.kind === 'test-reach').reach.filter((row) => row.test === 'test/no-overlap.test.mjs')
  const noOverlapRow = noOverlapRows.find((row) => row.how === 'import')
  assert.equal(noOverlapRows.some((row) => row.how === 'path'), false)
  assert.deepEqual(noOverlapRow.symbols, [])
  assert.equal(reachRefusalRows({ rows: [noOverlapRow], surfaceExports: ['widgetShape'] }).length, 0)
})

test('reachRefusalRows intersects against the declared write surface, not any symbol', () => {
  const row = { test: 'test/mixed.test.mjs', file: 'lib/widget.mjs', hops: 1, how: 'import', symbols: ['notExportedHere', 'widgetShape'] }
  assert.deepEqual(reachRefusalRows({ rows: [row], surfaceExports: ['widgetShape'] }), [{
    test: 'test/mixed.test.mjs', file: 'lib/widget.mjs', symbols: ['widgetShape'],
  }])
})

test('a refused row is never first announced as not a refusal, and the rest still warn', () => {
  const only = namedReachFixture('warn-suppressed')
  const onlyRun = reachCheck({
    checkout: only,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.equal(onlyRun.error?.reason, 'test-reach-unfenced')
  assert.equal(onlyRun.logs.some((line) => line.startsWith(TEST_REACH_WARNING_PREFIX)), false)

  const mixed = namedReachFixture('warn-mixed', {
    'crew/reader.mjs': "import { grantsFor } from './adapters/adapter-pi.mjs'\nexport const readerValue = grantsFor()\n",
    'test/twohop.test.mjs': "import { readerValue } from '../crew/reader.mjs'\n// pins grantsFor through readerValue\nif (!readerValue) throw new Error('x')\n",
  })
  const outDir = join(mixed, 'warnings')
  const mixedRun = reachCheck({
    checkout: mixed,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
    outDir,
  })
  assert.equal(mixedRun.error?.reason, 'test-reach-unfenced')
  const warningText = mixedRun.logs.find((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY '))
  assert.ok(warningText)
  assert.match(warningText, /test-reach=3 · actionable=2 · collapsed=4/)
  assert.equal(warningText.includes('test/twohop.test.mjs'), false)
  assert.equal(warningText.includes('crew/crew.test.mjs'), false)
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(persisted.lanes[0].test_reach.map((row) => row.test).sort(), ['crew/crew.test.mjs', 'crew/crew.test.mjs', 'test/twohop.test.mjs'])
})

test('test-reach-unfenced precedes the register-superset refusal', () => {
  const checkout = namedReachFixture('precedence')
  const result = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
    extraFences: [entry('lane-ghost', ['docs/ghost.md'])],
  })
  assert.ok(result.error instanceof BatchRefusal)
  assert.equal(result.error.reason, 'test-reach-unfenced')
})

test('allow_test_reach admits a reaching test and the decision is logged and persisted', () => {
  const checkout = namedReachFixture('override')
  const refused = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.equal(refused.error?.reason, 'test-reach-unfenced')
  const outDir = join(checkout, 'warnings')
  const admitted = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
    allow: [{ file: 'crew/crew.test.mjs', why: 'the test is covered by a higher-level fixture' }],
    outDir,
  })
  assert.equal(admitted.error, null)
  const line = admitted.logs.find((value) => value.startsWith(TEST_REACH_OVERRIDE_PREFIX))
  assert.ok(line)
  for (const token of ['crew/crew.test.mjs', 'crew/adapters/adapter-pi.mjs', 'grantsFor', 'the test is covered by a higher-level fixture']) assert.equal(line.includes(token), true)
  assert.ok(admitted.report.warnings.find((row) => row.kind === 'test-reach-override'))
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.equal(persisted.lanes[0].test_reach_overrides.length, 2)
  assert.deepEqual(persisted.lanes[0].test_reach_overrides.find((row) => row.symbols.length > 0), {
    test: 'crew/crew.test.mjs', file: 'crew/adapters/adapter-pi.mjs', symbols: ['assertGrantsBacked', 'grantsFor', 'loadCapabilities'], why: 'the test is covered by a higher-level fixture',
  })
  assert.deepEqual(persisted.lanes[0].test_reach_overrides.find((row) => row.symbols.length === 0), {
    test: 'crew/crew.test.mjs', file: 'crew/adapters/adapter-pi.mjs', symbols: [], why: 'the test is covered by a higher-level fixture',
  })
})

test('a batch with no reaching tests writes the fence report it wrote before', () => {
  const checkout = gitFixture()
  put(join(checkout, 'lib', 'widget.mjs'), 'export function widgetShape() { return 1 }\n')
  put(join(checkout, 'test', 'unrelated.test.mjs'), "const other = 1\nif (!other) throw new Error('x')\n")
  const outDir = join(checkout, 'warnings')
  const result = reachCheck({ checkout, fenceFiles: ['lib/widget.mjs'], surface: ['lib/widget.mjs'], outDir })
  assert.equal(result.error, null)
  const expected = JSON.stringify({
    schema_version: 1,
    blind_spots: {
      'anchor-pin': ANCHOR_BLIND_SPOT,
      'citation-carrier': CITATION_CARRIER_BLIND_SPOT,
      'test-reach': TEST_REACH_BLIND_SPOT,
      'cross-batch-unknown': CROSS_BATCH_BLIND_SPOT,
    },
    cross_batch_unknown: [],
    lanes: [{ lane: 'lane-a', test_reach: [], test_reach_dropped: [], citation_carriers: [], anchor_pins: [] }],
  }, null, 2) + '\n'
  assert.equal(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'), expected)
  assert.equal(result.logs.some((line) => line.startsWith(TEST_REACH_WARNING_PREFIX)), false)
})

test('splitDispatchKeys refuses a malformed allow_test_reach', () => {
  for (const allow of [null, 'test/direct.test.mjs', [''], [1]]) {
    const batch = makeBatch(['lane-a'])
    const path = join(batch, `lane-a${REQUEST_SUFFIX}`)
    put(path, JSON.stringify(requestFor('lane-a', { [TEST_REACH_OVERRIDE_KEY]: allow })))
    assert.throws(() => readBatch({ batchDir: batch }), (error) => error instanceof BatchRefusal
      && error.reason === 'batch-unreadable'
      && error.message.includes(path))
  }
})

test('readBatch carries allow_test_reach onto the lane', () => {
  const batch = makeBatch(['lane-a'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', {
    [TEST_REACH_OVERRIDE_KEY]: [{ file: './test/direct.test.mjs', why: 'the direct fixture is covered elsewhere' }],
  })))
  const [lane] = readBatch({ batchDir: batch })
  assert.deepEqual(lane[TEST_REACH_OVERRIDE_KEY], [{ file: 'test/direct.test.mjs', why: 'the direct fixture is covered elsewhere' }])
  assert.equal(Object.hasOwn(lane.request, TEST_REACH_OVERRIDE_KEY), false)
  assert.equal(DISPATCH_ONLY_REQUEST_KEYS.includes(TEST_REACH_OVERRIDE_KEY), true)
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
  assert.equal(logs.some((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY ') && line.includes('cross-batch-unknown=1')), true)
  assert.equal(logs.some((line) => line.includes(CROSS_BATCH_UNKNOWN_PREFIX) && line.includes(CROSS_BATCH_BLIND_SPOT)), false)
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
  assert.equal(logs.some((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY ') && line.includes('cross-batch-unknown=1')), true)
  assert.equal(logs.some((line) => line.startsWith(CROSS_BATCH_UNKNOWN_PREFIX)), false)
  assert.equal(report.fences.crossBatch.cleared, false)
})

test('dispatchBatch logs test reach during dry-run without changing the outcome', async () => {
  const checkout = reachFixture('dry-run')
  const batch = join(checkout, 'reach-batch')
  mkdirSync(batch)
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify({ ...request('measure reach warning', ['lib/widget.mjs']), allow_test_reach: [{ file: 'test/direct.test.mjs', why: 'the direct fixture is covered elsewhere' }] }))
  const logs = []
  const outDir = join(checkout, 'reach-out')
  const report = await dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['lib/widget.mjs'])],
    checkout,
    parentDir: join(checkout, 'parents'),
    outDir,
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
  const warning = logs.find((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY '))
  assert.ok(warning)
  assert.match(warning, /test-reach=3 · actionable=0 · collapsed=1/)
  assert.equal(warning.includes('test/twohop.test.mjs'), false)
  assert.equal(fsExistsSync(join(outDir, FENCE_REPORT_FILE)), true)
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

test('test reach enumerates for any existing fenced surface and only once per batch', () => {
  const noCode = reachFixture('no-code', { files: { 'docs/notes.md': '# notes\\n' } })
  const noCodeCalls = []
  const noCodeReport = checkFences({
    fences: [entry('lane-a', ['docs/notes.md'])],
    lanes: [{ lane: 'lane-a', where: ['docs/notes.md'], allow_test_reach: fixtureTests(noCode) }],
    checkout: noCode,
    deps: {
      home: root,
      spawn: (options) => { noCodeCalls.push(options); return { status: 0, stdout: '' } },
      log: () => {},
    },
  })
  assert.ok(noCodeReport.perLane['lane-a'])
  assert.equal(noCodeCalls.length, 1)

  const checkout = reachFixture('one-enumeration')
  const calls = []
  checkFences({
    fences: [entry('lane-a', ['lib/widget.mjs']), entry('lane-b', ['lib/caller.mjs']), entry('lane-c', ['lib/outer.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['lib/widget.mjs'], allow_test_reach: fixtureTests(checkout) },
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
  assert.equal(rows.length, TEST_REACH_ROW_LIMIT * 2 + 3)
  assert.equal(warning.text.includes(`listing at most ${TEST_REACH_ROW_LIMIT}`), true)
  assert.equal(warning.text.includes(`${rows.length - TEST_REACH_ROW_LIMIT} further row(s) not listed here and carried in full on the report (report unavailable: no-out-dir)`), true)
  assert.equal(rows.filter((row) => row.hops === 1).length, TEST_REACH_ROW_LIMIT + 1)
  assert.equal(rows.find((row) => row.test === 'test/twohop.test.mjs')?.hops, 2)
})

test('test reach lists symbol-only rows before import rows when truncating', () => {
  const directImports = Object.fromEntries(Array.from({ length: TEST_REACH_ROW_LIMIT }, (_, index) => [
    `test/z-direct-value-${String(index).padStart(2, '0')}.test.mjs`, "import { widgetValue } from '../lib/widget.mjs'\nvoid widgetValue\n",
  ]))
  const checkout = reachFixture('row-limit-symbol-first', {
    files: {
      ...directImports,
      'test/symbol-only.test.mjs': 'const seen = "widgetShape"\nif (!seen) throw new Error("x")\n',
    },
  })
  const { warning, rows } = reachReport(checkout)
  assert.ok(warning)
  const symbolIndex = rows.findIndex((row) => row.test === 'test/symbol-only.test.mjs' && row.how === 'symbol')
  const firstImportIndex = rows.findIndex((row) => row.hops !== null)
  assert.ok(symbolIndex >= 0)
  assert.equal(rows[symbolIndex]?.hops, null)
  assert.ok(symbolIndex < firstImportIndex)
  assert.ok(warning.text.includes('test/symbol-only.test.mjs'))
  const importRows = rows.filter((row) => row.hops !== null).map((row) => row.test)
  assert.ok(importRows.some((file) => !warning.text.includes(file)))
})

test('checkFences writes every reach row and cites the report, including unavailable writes', () => {
  const checkout = reachFixture('report', { extraDirect: TEST_REACH_ROW_LIMIT })
  const outDir = join(checkout, 'warnings')
  const { warning, rows } = reachReport(checkout, ['lib/widget.mjs'], ['lib/widget.mjs'], {}, outDir)
  const reportPath = join(outDir, FENCE_REPORT_FILE)
  assert.equal(fsExistsSync(reportPath), true)
  assert.ok(warning.text.includes(reportPath))
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.schema_version, 1)
  assert.equal(report.lanes.length, 1)
  assert.deepEqual(report.lanes[0].test_reach, rows)
  assert.deepEqual(report.lanes[0].citation_carriers, [])

  const noOut = reachReport(reachFixture('report-no-out', { extraDirect: TEST_REACH_ROW_LIMIT }))
  assert.ok(noOut.warning.text.includes('report unavailable: no-out-dir'))

  const failed = reachReport(reachFixture('report-write-failed', { extraDirect: TEST_REACH_ROW_LIMIT }), ['lib/widget.mjs'], ['lib/widget.mjs'], {
    writeFileSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) },
  }, join(checkout, 'failed'))
  assert.ok(failed.warning.text.includes('report unavailable: EPERM'))
})

test('checkFences records every carrier and cites its report from both warning kinds', () => {
  const checkout = reachFixture('report-with-carriers', { extraDirect: TEST_REACH_ROW_LIMIT })
  const key = 'lib/widget.mjs:1'
  const expectedCarriers = Array.from({ length: CITATION_CARRIER_ROW_LIMIT + 1 }, (_, index) => ({
    file: 'lib/widget.mjs',
    doc: `skills/one/references/notes-${String(index).padStart(2, '0')}.md`,
    keys: [key],
  }))
  put(join(checkout, 'skills', 'one', 'anchors.json'), JSON.stringify({ [key]: 'export const widgetValue = 1' }))
  for (const { doc } of expectedCarriers) put(join(checkout, ...doc.split('/')), `Declared at \`${key}\`.\n`)
  const outDir = join(checkout, 'warnings')
  const report = checkFences({
    fences: [entry('lane-a', ['lib/widget.mjs', 'skills/one/anchors.json'])],
    lanes: [{ lane: 'lane-a', where: ['lib/widget.mjs', 'skills/one/anchors.json'], allow_test_reach: fixtureTests(checkout) }],
    checkout,
    outDir,
    deps: { home: root, log: () => {} },
  })
  const reach = report.warnings.find((row) => row.kind === 'test-reach')
  const carriers = report.warnings.find((row) => row.kind === 'citation-carrier')
  const reportPath = join(outDir, FENCE_REPORT_FILE)
  assert.ok(reach)
  assert.ok(carriers)
  assert.ok(reach.text.includes(reportPath))
  assert.ok(carriers.text.includes(reportPath))
  const persisted = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.deepEqual(persisted.lanes[0].test_reach, reach.reach)
  assert.deepEqual(carriers.carriers, expectedCarriers)
  assert.deepEqual(persisted.lanes[0].citation_carriers, expectedCarriers)
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
  assert.equal(report.warnings[0].text.includes(ANCHOR_PIN_POST_MERGE), true)
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
  const warning = logs.find((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY '))
  assert.ok(warning)
  assert.match(warning, /anchor-pin=10/)
  assert.equal(warning.includes(ANCHOR_PIN_WARNING_PREFIX), false)
  assert.equal(warning.includes(ANCHOR_PIN_POST_MERGE), false)
  for (const key of fixture.keys) assert.equal(warning.includes(key), false, `dry-run emitted ${key}`)
})

test('two lanes with external manifests warn without refusing', () => {
  const checkout = join(root, 'anchor-warning-two-lanes-checkout')
  anchorFixtures(checkout, {
    first: { 'crew/owned-a.mjs:1': 'export const OWNED_A = 1' },
    second: { 'crew/owned-b.mjs:1': 'export const OWNED_B = 1' },
  })
  const report = checkFences({
    fences: [entry('lane-a', ['crew/owned-a.mjs']), entry('lane-b', ['crew/owned-b.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/owned-a.mjs'] }, { lane: 'lane-b', where: ['crew/owned-b.mjs'] }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  const warnings = report.warnings.filter(({ kind }) => kind === 'anchor-pin')
  assert.equal(warnings.length, 2)
  assert.deepEqual(warnings.map(({ lane }) => lane), ['lane-a', 'lane-b'])
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

test('machinery budget reports over-creation as one ask-user finding', () => {
  const over = checkMachineryBudget({
    lane: 'lane-a',
    creates: ['lib/one.mjs'],
    newFiles: ['lib/one.mjs', 'lib/two.mjs', 'lib/three.mjs'],
    newSymbols: ['alpha', 'beta'],
  })
  assert.equal(over.budget, 3)
  assert.equal(over.counted, 5)
  assert.equal(over.excess, 2)
  assert.equal(over.findings.length, 1)
  assert.equal(over.findings[0].disposition, 'ask-user')
  assert.match(over.findings[0].summary, /2/)

  const within = checkMachineryBudget({ lane: 'lane-a', creates: ['lib/one.mjs'], newFiles: ['lib/one.mjs'], newSymbols: ['alpha'] })
  assert.equal(within.findings.length, 0)
  const boundary = checkMachineryBudget({ lane: 'lane-a', creates: [], newFiles: ['lib/one.mjs', 'lib/two.mjs'], newSymbols: [] })
  assert.equal(boundary.counted, boundary.budget)
  assert.equal(boundary.findings.length, 0)
  const symbolsOnly = checkMachineryBudget({ lane: 'lane-a', creates: [], newFiles: [], newSymbols: ['alpha', 'beta', 'gamma'] })
  assert.equal(symbolsOnly.findings.length, 1)
  assert.doesNotThrow(() => checkMachineryBudget({ lane: 'lane-a', creates: ['lib/one.mjs'], newFiles: ['lib/one.mjs', 'lib/two.mjs', 'lib/three.mjs'], newSymbols: ['alpha', 'beta'] }))
})

test('collectAnchorPins scans the roles manifest even when skills is absent', () => {
  const checkout = join(root, 'roles-anchor-checkout')
  put(join(checkout, 'crew', 'roles', 'anchors.json'), JSON.stringify({
    'crew/drive.mjs:1': 'export const DRIVE = 1',
  }))
  const pins = collectAnchorPins({ checkout })
  assert.deepEqual(pins.manifests, [ROLES_ANCHOR_MANIFEST])
  assert.deepEqual([...pins.byFile.keys()], ['crew/drive.mjs'])
})

test('collectAnchorPins keeps the roles and skills manifests in one scan', () => {
  const checkout = join(root, 'roles-and-skills-anchor-checkout')
  put(join(checkout, 'crew', 'roles', 'anchors.json'), JSON.stringify({
    'crew/drive.mjs:1': 'export const DRIVE = 1',
  }))
  put(join(checkout, 'skills', 'valid', 'anchors.json'), JSON.stringify({
    'crew/crew.mjs:2': 'export const CREW = 2',
  }))
  const pins = collectAnchorPins({ checkout })
  assert.deepEqual(pins.manifests, [ROLES_ANCHOR_MANIFEST, 'skills/valid/anchors.json'])
  assert.deepEqual([...pins.byFile.keys()], ['crew/drive.mjs', 'crew/crew.mjs'])
})

test('a roles anchor warning names its bijection companions and does not refuse', () => {
  const checkout = join(root, 'roles-anchor-warning-checkout')
  put(join(checkout, 'crew', 'drive.test.mjs'), 'import { test } from \'node:test\'\n')
  put(join(checkout, 'crew', 'roles', 'anchors.json'), JSON.stringify({
    'crew/drive.test.mjs:1': "import { test } from 'node:test'",
  }))
  put(join(checkout, 'crew', 'roles', 'planner.md'), '# planner\n')
  put(join(checkout, 'crew', 'roles', 'tech-lead.md'), '# tech-lead\n')
  const report = checkFences({
    fences: [entry('lane-a', ['crew/drive.test.mjs']), entry('lane-b', ['docs/notes.md'])],
    lanes: [{ lane: 'lane-a', where: ['crew/drive.test.mjs'] }, { lane: 'lane-b', where: [] }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  const warning = report.warnings.find(({ kind, lane }) => kind === 'anchor-pin' && lane === 'lane-a')
  assert.ok(warning)
  for (const path of [ROLES_ANCHOR_MANIFEST, ...ROLES_ANCHOR_COMPANIONS]) {
    assert.match(warning.text, new RegExp(path.replaceAll('/', '\\/').replaceAll('.', '\\.') ))
  }
  assert.match(warning.text, /every crew\/drive\.mjs anchor the tech-lead charter cites resolves to the code it names/)
  assert.match(warning.text, /post-merge/)
  assert.match(warning.text, /must still fence all three/)
  assert.match(warning.text, /line shift is repaired/)
  assert.equal(warning.text.includes('must be fenced together'), false)
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

test('crew state paths honor injected home and arrival checks use the runtime slug', () => {
  const home = join(root, 'crew-json-home')
  assert.equal(crewJsonPath({ checkout: '/tmp/dt-lane-a', lane: 'lane_a', deps: { home } }), join(home, '.crew', 'dt-lane-a', 'lane-a', 'crew.json'))
  assert.match(crewJsonPath({ checkout: '/tmp/dt-lane-a', lane: 'lane_a' }), /\/lane-a\/crew\.json$/)
  refusal(() => checkArrival({ crew: { lane_fence: [] }, lane: 'lane-a', batchTotal: 1 }), 'fence-not-arrived')
  refusal(() => checkArrival({ crew: { lane_name: 'lane-a', lane_fence: [] }, lane: 'lane-a', batchTotal: 2 }), 'fence-count-mismatch')
  assert.deepEqual(
    checkArrival({ crew: { lane_name: 'lane-a', lane_fence: [{ lane: 'lane-b', files: [] }] }, lane: 'lane-a', batchTotal: 2 }),
    { lane: 'lane-a', siblings: [{ lane: 'lane-b', files: [] }], externals: [] },
  )
})

test('checkArrival counts batch siblings separately and requires each external fence', () => {
  const crew = {
    lane_name: 'lane-a',
    lane_fence: [
      { lane: 'lane-b', files: [] },
      { lane: 'external-lane', files: ['README.md'] },
    ],
  }
  assert.deepEqual(checkArrival({ crew, lane: 'lane-a', batchTotal: 2, externals: ['external-lane'] }), {
    lane: 'lane-a',
    siblings: [{ lane: 'lane-b', files: [] }],
    externals: [{ lane: 'external-lane', files: ['README.md'] }],
  })
  const missingSibling = thrown(() => checkArrival({
    crew: { ...crew, lane_fence: [{ lane: 'external-lane', files: ['README.md'] }] },
    lane: 'lane-a',
    batchTotal: 2,
    externals: ['external-lane'],
  }))
  assert.equal(missingSibling.reason, 'fence-count-mismatch')
  const missingExternal = thrown(() => checkArrival({
    crew: { ...crew, lane_fence: [{ lane: 'lane-b', files: [] }] },
    lane: 'lane-a',
    batchTotal: 2,
    externals: ['external-lane'],
  }))
  assert.equal(missingExternal.reason, 'fence-not-arrived')
  assert.equal(missingExternal.message.includes('external-lane'), true)
})

test('tier floor and reconciliation keep the protected path at judge', () => {
  assert.deepEqual(tierFloor({ files: ['crew/drive.mjs'] }), {
    hits: ['crew/drive.mjs'], forced: 'judge', floor: 'judge',
  })
  assert.equal(tierFloor({ files: ['skills/crew-dispatch/references/batch.md'] }).forced, null)
  refusal(() => reconcileTier({ lane: 'lane-a', forced: 'judge', proposed: 'build', requested: 'build' }), 'tier-floor-conflict')
  assert.equal(reconcileTier({ lane: 'lane-a', forced: null, proposed: 'build', requested: 'judge' }).tier, 'judge')
  assert.equal(reconcileTier({ lane: 'lane-a', forced: null, proposed: null, requested: null }).tier, null)
  const laneOverride = reconcileTier({ lane: 'lane-a', forced: null, proposed: 'judge', requested: 'build', requestedFrom: 'lane' })
  assert.equal(laneOverride.tier, 'build')
  assert.equal(laneOverride.overrodeProposal, true)
  refusal(() => reconcileTier({ lane: 'lane-a', forced: 'judge', proposed: null, requested: 'build', requestedFrom: 'lane' }), 'tier-floor-conflict')
  refusal(() => reconcileTier({ lane: 'lane-a', forced: 'build', proposed: 'judge', requested: 'mechanical', requestedFrom: 'lane' }), 'tier-floor-conflict')
  assert.equal(reconcileTier({ lane: 'lane-a', forced: 'build', proposed: 'judge', requested: 'build', requestedFrom: 'lane' }).tier, 'build')
  const batchDefault = reconcileTier({ lane: 'lane-a', forced: null, proposed: 'judge', requested: 'build', requestedFrom: 'batch' })
  assert.equal(batchDefault.tier, 'judge')
  assert.equal(batchDefault.overrodeProposal, false)
  assert.equal(reconcileTier({ lane: 'lane-a', forced: 'build', proposed: 'judge', requested: null }).tier, 'judge')
})

test('PS1', () => {
  const verdict = promptSurfaceVerdict({ files: ['crew/roles/planner.md'] })
  assert.deepEqual(verdict, {
    hits: ['crew/roles/planner.md'], promptChange: true, forced: 'judge',
  })
  assert.equal(reconcileTier({
    lane: 'planner', forced: verdict.forced, proposed: 'build', requested: 'mechanical',
    requestedFrom: 'batch', forceReason: 'prompt-surface-conflict',
  }).tier, 'judge')
})

test('PS2', () => {
  const verdict = promptSurfaceVerdict({ files: ['crew/guidelines/review-do-not-flag.md'] })
  assert.deepEqual(verdict, {
    hits: ['crew/guidelines/review-do-not-flag.md'], promptChange: true, forced: 'judge',
  })
  assert.equal(reconcileTier({
    lane: 'guideline', forced: verdict.forced, proposed: 'build', requested: 'mechanical',
    requestedFrom: 'batch', forceReason: 'prompt-surface-conflict',
  }).tier, 'judge')
})

test('PS3', () => {
  assert.deepEqual(PROMPT_SURFACE, {
    paths: ['crew/roles/', 'crew/guidelines/'],
    templateBlocks: ['ACCEPTANCE_GATE_BLOCK', 'HOSTILE_ENV_BLOCK', 'CONVENTIONS_BLOCK', 'MUTATION_CONTRACT_BLOCK'],
  })
  assert.equal(Object.isFrozen(PROMPT_SURFACE), true)
  assert.equal(Object.isFrozen(PROMPT_SURFACE.paths), true)
  assert.equal(Object.isFrozen(PROMPT_SURFACE.templateBlocks), true)
})

test('PS4', () => {
  const prompt = thrown(() => reconcileTier({
    lane: 'prompt', forced: 'judge', proposed: 'build', requested: 'build', requestedFrom: 'lane',
    forceReason: 'prompt-surface-conflict',
  }))
  const protectedFloor = thrown(() => reconcileTier({
    lane: 'protected', forced: 'judge', proposed: 'build', requested: 'build', requestedFrom: 'lane',
  }))
  assert.equal(prompt.reason, 'prompt-surface-conflict')
  assert.equal(protectedFloor.reason, 'tier-floor-conflict')
  assert.notEqual(prompt.reason, protectedFloor.reason)
  assert.notEqual(prompt.message, protectedFloor.message)
  assert.match(prompt.message, /prompt surface/)
  assert.match(prompt.message, /judge/)
})

test('PS5', () => {
  const verdict = promptSurfaceVerdict({ files: ['src/owned.mjs'] })
  assert.deepEqual(verdict, { hits: [], promptChange: false, forced: null })
  const settled = reconcileTier({
    lane: 'code-only', forced: verdict.forced, proposed: 'build', requested: 'mechanical', requestedFrom: 'lane',
  })
  assert.equal(settled.tier, 'mechanical')
})

test('PS6', () => {
  const verdict = promptSurfaceVerdict({ files: ['crew/roles/planner.md'] })
  let settled
  assert.doesNotThrow(() => {
    settled = reconcileTier({
      lane: 'prompt', forced: verdict.forced, proposed: 'build', requested: 'judge', requestedFrom: 'lane',
      forceReason: 'prompt-surface-conflict',
    })
  })
  assert.equal(settled.tier, 'judge')
})

test('PS7', async () => {
  const prompt = await dispatchFixture({
    label: 'PS7-prompt',
    names: ['lane-a'],
    batchTier: 'mechanical',
    requests: { 'lane-a': requestFor('lane-a', { where: ['crew/roles/planner.md'] }) },
    fences: [entry('lane-a', ['crew/roles/planner.md'])],
  })
  const control = await dispatchFixture({
    label: 'PS7-code',
    names: ['lane-a'],
    batchTier: 'mechanical',
    requests: { 'lane-a': requestFor('lane-a', { where: ['src/owned.mjs'] }) },
    fences: [entry('lane-a', ['src/owned.mjs'])],
  })
  const promptLine = prompt.logs.find((line) => line.startsWith('dispatch-batch: lane=lane-a '))
  const controlLine = control.logs.find((line) => line.startsWith('dispatch-batch: lane=lane-a '))
  assert.match(promptLine, /forced=none prompt=change proposed=/)
  assert.match(controlLine, /forced=none prompt=code-only proposed=/)
  const promptBoot = prompt.spawned.find(({ args }) => args.includes('boot'))
  assert.equal(promptBoot.args[promptBoot.args.indexOf('--tier') + 1], 'judge')
  const promptRecord = JSON.parse(readFileSync(join(prompt.out, 'lane-a.dispatch.json'), 'utf8'))
  assert.deepEqual(promptRecord.prompt_surface, {
    hits: ['crew/roles/planner.md'], prompt_change: true, forced: 'judge',
  })
})

test('PS8', () => {
  const error = thrown(() => reconcileTier({
    lane: 'prompt', forced: 'judge', proposed: 'build', requested: 'build', requestedFrom: 'lane',
    forceReason: 'prompt-surface-conflict',
  }))
  assert.equal(error.reason, 'prompt-surface-conflict')
  assert.ok(error.message.includes(PROMPT_SURFACE_BLIND_SPOT))
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
      if (call.args.includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
      const lane = compilerLane(call.args)
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
  assert.equal(compileCalls.length, 4)
  assert.equal(compileCalls.filter(({ args }) => args.includes('--discover-reads')).length, 2)
  assert.equal(compileCalls.filter(({ args }) => args.includes('--out')).length, 2)
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
      if (args.includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
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
  const compilerCalls = spawned.filter(({ args }) => {
    const list = (args || []).map(String)
    return list.some((arg) => arg.endsWith('make-brief.mjs')) && list.includes('--request')
  })
  const discovers = compilerCalls.filter(({ args }) => args.includes('--discover-reads'))
  const compiles = compilerCalls.filter(({ args }) => args.includes('--out'))
  return { report, spawned, measures, compiles, discovers }
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
  crewJsonFor = null,
  outcomes = {},
  ancestor = () => 0,
  spawnResult = () => ({ status: 0, stdout: '', stderr: '' }),
  discover = () => ({ status: 0, stdout: '[]', stderr: '' }),
  spawnAsync = null,
  assertQuiet = null,
  headFor = null,
  readObserver = () => {},
  home = root,
  existsProbe = null,
  // A caller whose subject WRITES through the seam (adoption) passes real
  // writers; the default recorder is for callers that only observe the write.
  writeFile = null,
  appendFile = null,
  spawnedOut = null,
  random = null,
  timeline = null,
} = {}) {
  const batch = join(root, `dispatch-${label}-${Math.random().toString(36).slice(2)}`)
  const parent = join(root, `dispatch-${label}-parent`)
  const out = join(root, `dispatch-${label}-out`)
  mkdirSync(batch, { recursive: true })
  const authored = Object.fromEntries(names.map((lane) => [lane, requests[lane] || requestFor(lane)]))
  for (const lane of names) put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(authored[lane]))
  const spawned = []
  const recordSpawn = (call) => {
    spawned.push(call)
    if (Array.isArray(spawnedOut)) spawnedOut.push(call)
    if (Array.isArray(timeline)) timeline.push({ kind: 'spawn', call })
  }
  const logs = []
  const wrote = new Map()
  const appended = []
  const laneFences = fences || names.map((lane) => entry(lane, [`crew/owned-${lane}.mjs`]))
  const deps = {
    home,
    env: { DEVTEAM_LEDGER_DIR: join(home, 'factory-state') },
    existsSync: (path) => existsProbe
      ? existsProbe(path)
      : String(path).endsWith('returns/task.json')
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
        if (wrote.has(text)) return wrote.get(text)
        const lane = text.split('/').at(-2)
        if (crewJsonFor) return crewJsonFor(lane)
        return JSON.stringify({
          lane_name: lane,
          lane_fence: names.filter((candidate) => candidate !== lane).map((sibling) => ({ lane: sibling, files: [] })),
          workspace_id: workspaceFor(lane),
        })
      }
      return readFileSync(text, encoding || 'utf8')
    },
    writeFileSync: (path, content) => { wrote.set(String(path), String(content)); if (writeFile) writeFile(path, content) },
    appendFileSync: (path, content) => { appended.push({ path: String(path), content: String(content) }); if (appendFile) appendFile(path, content) },
    spawn: (call) => {
      recordSpawn(call)
      const args = (call.args || []).map(String)
      if (args.includes('merge-base')) return { status: ancestor(args), stdout: '', stderr: '' }
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        const index = args.indexOf('-C')
        const target = index === -1 ? String(call.cwd || '') : args[index + 1]
        return headFor ? { status: 0, stdout: `${headFor(target)}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }
      }
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      const result = args.includes('--discover-reads')
        ? (typeof discover === 'function' ? discover(args, call) : discover)
        : spawnResult(args, call)
      if (call.background === true) return { ...(result || {}), pid: result?.pid ?? 43117 }
      return result
    },
    ...(spawnAsync ? { spawnAsync: (call) => {
      recordSpawn(call)
      const args = (call.args || []).map(String)
      if (args.includes('--discover-reads')) return typeof discover === 'function' ? discover(args, call) : discover
      return spawnAsync(call)
    } } : {}),
    ...(assertQuiet ? { assertQuiet } : {}),
    ...(random ? { random } : {}),
    log: (line) => {
      const text = String(line)
      logs.push(text)
      if (Array.isArray(timeline)) timeline.push({ kind: 'log', line: text })
    },
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
  return { report, spawned, logs, batch, parent, out, fences: laneFences, wrote, appended }
}

function turnCensusRow({ turns, out_of_tool_ms, span_ms, in_tool_ms = { edit: 1, read: 2, test: 3, other: 4 }, role = 'builder' }) {
  return { role, turns, out_of_tool_ms, span_ms, in_tool_ms }
}

test('TB1', async () => {
  const censusPath = put(join(root, 'turn-census-TB1.jsonl'), `${JSON.stringify({ seat_turn_census: turnCensusRow({ turns: 362, out_of_tool_ms: 5293017, span_ms: 5404151, in_tool_ms: { edit: 0, read: 10058, test: 80892, other: 20184 } }) })}\n`)
  const timeline = []
  const result = await dispatchFixture({
    label: 'TB1', names: ['lane-a'],
    runFlags: { 'wait-builder': '5400', [TURN_CENSUS_FLAG]: [censusPath] }, timeline,
  })
  const line = result.logs.find((entry) => entry.startsWith('dispatch-batch: turn-budget '))
  assert.match(line, /wait_s=5400/)
  assert.match(line, /affordable_turns=369/)
  const budgetIndex = timeline.findIndex((entry) => entry.kind === 'log' && entry.line.startsWith('dispatch-batch: turn-budget '))
  const workIndex = timeline.findIndex((entry) => entry.kind === 'spawn' && ['worktree', 'boot', 'run'].some((word) => (entry.call.args || []).includes(word)))
  assert.ok(budgetIndex >= 0)
  assert.ok(workIndex > budgetIndex)
})

test('TB2', () => {
  const emptyPath = put(join(root, 'turn-census-TB2-empty.jsonl'), '')
  const malformedPath = put(join(root, 'turn-census-TB2-malformed.jsonl'), '{not json\n{"event":"other"}\n')
  const noBuilderPath = put(join(root, 'turn-census-TB2-no-builder.jsonl'), `${JSON.stringify({ seat_turn_census: turnCensusRow({ role: 'planner', turns: 362, out_of_tool_ms: 5293017, span_ms: 5404151 }) })}\n`)
  const zeroLatencyPath = put(join(root, 'turn-census-TB2-zero-latency.jsonl'), `${JSON.stringify({ seat_turn_census: turnCensusRow({ turns: 1, out_of_tool_ms: 0, span_ms: 5000, in_tool_ms: { edit: 0, read: 0, test: 5000, other: 0 } }) })}\n`)
  const cases = [
    undefined,
    [join(root, 'turn-census-TB2-missing.jsonl')],
    [emptyPath],
    [malformedPath],
    [noBuilderPath],
  ]
  for (const paths of cases) {
    const source = readTurnCensus(paths)
    assert.deepEqual(source.rows, [])
    assert.equal(typeof source.reason, 'string')
    const report = turnBudgetReport({ waitSeconds: 5400, censusRows: source.rows, reason: source.reason })
    assert.deepEqual(report, { measured: false, affordable_turns: null, reason: source.reason })
    const line = formatTurnBudgetReport(report)
    assert.match(line, /affordable_turns=unmeasured/)
    assert.match(line, /latency_ms_per_turn=unmeasured/)
    assert.doesNotMatch(line, /affordable_turns=(?!unmeasured)/)
    assert.doesNotMatch(line, /latency_ms_per_turn=(?!unmeasured)/)
    assert.doesNotMatch(line, /5293017|5404151|362/)
  }
  const zeroLatencySource = readTurnCensus([zeroLatencyPath])
  assert.equal(zeroLatencySource.rows.length, 1)
  const zeroLatencyReport = turnBudgetReport({ waitSeconds: 5400, censusRows: zeroLatencySource.rows, reason: zeroLatencySource.reason })
  assert.equal(zeroLatencyReport.measured, false)
  assert.equal(zeroLatencyReport.affordable_turns, null)
  assert.equal(typeof zeroLatencyReport.reason, 'string')
  assert.ok(zeroLatencyReport.reason)
  const zeroLatencyLine = formatTurnBudgetReport(zeroLatencyReport)
  assert.match(zeroLatencyLine, /affordable_turns=unmeasured/)
  assert.match(zeroLatencyLine, /latency_ms_per_turn=unmeasured/)
  assert.doesNotMatch(zeroLatencyLine, /Infinity|affordable_turns=0|latency_ms_per_turn=0/)
  assert.doesNotMatch(zeroLatencyLine, /0/)
})

test('TB3', () => {
  const rows = [
    turnCensusRow({ turns: 10, out_of_tool_ms: 100, span_ms: 120 }),
    turnCensusRow({ turns: 20, out_of_tool_ms: 300, span_ms: 330 }),
  ]
  const report = turnBudgetReport({ waitSeconds: 5400, censusRows: rows })
  assert.equal(report.latency_ms_per_turn, 400 / 30)
  assert.equal(report.n, 2)
  assert.equal(report.min_latency_ms_per_turn, 10)
  assert.equal(report.max_latency_ms_per_turn, 15)
  assert.deepEqual(report.denominator, { out_of_tool_ms: 400, turns: 30, span_ms: 450 })
  const line = formatTurnBudgetReport(report)
  assert.match(line, /latency_ms_per_turn=13\.333333333333334/)
  assert.match(line, /n=2/)
  assert.match(line, /denominator=out_of_tool_ms:400,turns:30,span_ms:450/)
})

test('TB4', () => {
  const report = turnBudgetReport({
    waitSeconds: 5400,
    censusRows: [turnCensusRow({ turns: 10, out_of_tool_ms: 100, span_ms: 120, in_tool_ms: { edit: 1, read: 2, test: 3, other: 4 } })],
  })
  const line = formatTurnBudgetReport(report)
  assert.match(line, /in_tool_ms=edit:1,read:2,test:3,other:4,total:10/)
  assert.doesNotMatch(line, /\[object Object\]/)
})

test('TB6', async () => {
  const ordinary = await dispatchFixture({ label: 'TB6-ordinary', names: ['lane-a'] })
  const ordinaryRun = ordinary.spawned.find(({ args }) => args.includes('run'))
  assert.ok(ordinaryRun)
  const checkoutIndex = ordinaryRun.args.indexOf('--checkout')
  const briefIndex = ordinaryRun.args.indexOf('--brief-file')
  assert.deepEqual(ordinaryRun.args, [
    'crew/crew.mjs', 'run', '--task', 'lane-a', '--checkout', ordinaryRun.args[checkoutIndex + 1],
    '--brief-file', ordinaryRun.args[briefIndex + 1], '--keep', '--variant', 'full',
    '--files-in-scope', 'crew/owned-lane-a.mjs',
  ])

  const authored = await dispatchFixture({ label: 'TB6-authored', names: ['lane-a'], runFlags: { 'wait-builder': '5400' } })
  const authoredRun = authored.spawned.find(({ args }) => args.includes('run'))
  assert.ok(authoredRun.args.includes('--wait-builder'))
  assert.equal(authoredRun.args[authoredRun.args.indexOf('--wait-builder') + 1], '5400')
  assert.equal(authoredRun.args.includes('--wait-planner'), false)

  const emptyWaitCensusPath = put(join(root, 'turn-census-TB6-empty-wait.jsonl'), `${JSON.stringify({ seat_turn_census: turnCensusRow({ turns: 362, out_of_tool_ms: 5293017, span_ms: 5404151, in_tool_ms: { edit: 0, read: 10058, test: 80892, other: 20184 } }) })}\n`)
  const emptyWaitFlags = parseCliArgs(['--wait-builder', '', `--${TURN_CENSUS_FLAG}`, emptyWaitCensusPath])
  assert.deepEqual(emptyWaitFlags, { 'wait-builder': '', [TURN_CENSUS_FLAG]: [emptyWaitCensusPath] })
  const emptyWait = await dispatchFixture({ label: 'TB6-empty-wait', names: ['lane-a'], runFlags: emptyWaitFlags })
  const emptyWaitLine = emptyWait.logs.find((line) => line.startsWith('dispatch-batch: turn-budget '))
  const expectedAffordableTurns = Math.floor(WAITS_S.builder * 1000 / (5293017 / 362))
  assert.equal(expectedAffordableTurns, 164)
  assert.ok(emptyWaitLine?.includes(`wait_s=${WAITS_S.builder}`))
  assert.ok(emptyWaitLine?.includes(`affordable_turns=${expectedAffordableTurns}`))
  assert.equal(emptyWait.spawned.find(({ args }) => args.includes('run')).args.includes('--wait-builder'), false)

  const censusPath = put(join(root, 'turn-census-TB6.jsonl'), `${JSON.stringify({ seat_turn_census: turnCensusRow({ turns: 2, out_of_tool_ms: 20, span_ms: 30 }) })}\n`)
  const wave = await dispatchFixture({
    label: 'TB6-wave', names: ['lane-a', 'lane-b'],
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '1', [TURN_CENSUS_FLAG]: [censusPath] },
  })
  assert.deepEqual(parseCliArgs([`--${TURN_CENSUS_FLAG}`, 'one.jsonl', `--${TURN_CENSUS_FLAG}`, 'two.jsonl'])[TURN_CENSUS_FLAG], ['one.jsonl', 'two.jsonl'])
  const resume = wave.logs.find((line) => line.startsWith('dispatch-batch: deferred lane=lane-b '))
  assert.ok(resume?.includes(`--${TURN_CENSUS_FLAG} ${censusPath}`))
  const seatCommands = wave.spawned.filter(({ args }) => args.includes('boot') || args.includes('run'))
  assert.ok(seatCommands.length > 0)
  for (const command of seatCommands) {
    assert.equal(command.args.includes(`--${TURN_CENSUS_FLAG}`), false)
    assert.equal(command.args.includes(censusPath), false)
  }
})

function adoptionArchive(label, { plan = '# Archived plan\n', gate = '// Archived gate\n', planCheck = null, journal = null, omit = null } = {}) {
  const archive = join(root, `adoption-archive-${label}-${Math.random().toString(36).slice(2)}`)
  if (omit !== 'plan.md') put(join(archive, 'task', 'plan.md'), plan)
  if (omit !== 'gate.mjs') put(join(archive, 'task', 'gate.mjs'), gate)
  if (planCheck !== null) put(join(archive, 'task', 'plan-check.md'), planCheck)
  if (journal !== null) put(join(archive, 'journal.jsonl'), journal)
  return archive
}

async function adoptionDispatchFixture({
  label,
  names = ['lane-a'],
  requests = {},
  runFlags = {},
  brief = briefWithBlockOnly,
  briefs = {},
  outcomes = {},
  home = join(root, `adoption-home-${label}-${Math.random().toString(36).slice(2)}`),
  spawnedOut = null,
} = {}) {
  return dispatchFixture({
    label,
    names,
    requests,
    runFlags,
    brief,
    briefs,
    outcomes,
    home,
    spawnedOut,
    // applyAdoption copies through the write seam (#856), so the adoption
    // fixture must land those bytes on disk, not merely record them.
    writeFile: (path, content) => put(path, content),
    appendFile: (path, content) => { mkdirSync(dirname(String(path)), { recursive: true }); fsAppendFileSync(path, content) },
    existsProbe: (path) => fsExistsSync(path)
      || (String(path).endsWith('returns/task.json') && Object.hasOwn(outcomes, laneFromOutcomePath(String(path)))),
    spawnAsync: async (call) => {
      const args = (call.args || []).map(String)
      if (args.includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
      const outIndex = args.indexOf('--out')
      if (outIndex >= 0) {
        const lane = compilerLane(args)
        put(args[outIndex + 1], briefs[lane] ?? brief)
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
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

function directBaseline({ label, sha = 'a'.repeat(40), capacity = '1', cachedFor = null, waitOnce = false, onWait = null } = {}) {
  const home = join(root, `slot-baseline-${label}-${Math.random().toString(36).slice(2)}`)
  const state = join(home, 'factory-state')
  const outDir = join(home, 'out')
  mkdirSync(home, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  if (cachedFor) put(cachePath(home, cachedFor), JSON.stringify({ sha: cachedFor, command: 'npm test', pass: 1, fail: 0, status: 'green' }))
  const events = []
  const logs = []
  const plans = [{ lane: 'lane-a', dir: home }, { lane: 'lane-b', dir: home }]
  const heads = new Map([['lane-a', sha], ['lane-b', sha]])
  let clock = 1000
  let waits = 0
  const pool = {
    acquire: () => {
      events.push('acquire')
      if (waitOnce && waits++ === 0) return { waiting: true, depth: 1 }
      return { slot: 'suite-0', handle: { kind: 'suite', slot: 'suite-0', token: 'token', owner: 'test' } }
    },
    release: () => { events.push('release'); return true },
  }
  const deps = {
    home,
    env: { DEVTEAM_LEDGER_DIR: state, CREW_SUITE_SLOTS: capacity },
    readFileSync: (path, encoding) => String(path).endsWith('/package.json')
      ? JSON.stringify({ private: true, scripts: { test: 'npm test' } })
      : readFileSync(path, encoding || 'utf8'),
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      if (onWait) onWait({ home, state, sha })
    },
    slots: () => pool,
    spawn: (call) => {
      events.push('spawn')
      const args = (call.args || []).map(String)
      const path = args[args.indexOf('--measure-baseline') + 1]
      put(path, JSON.stringify({ sha, command: 'npm test', pass: 2, fail: 0, status: 'green' }))
      return { status: 0, stdout: '', stderr: '' }
    },
    log: (line) => logs.push(String(line)),
  }
  const result = measureBatchBaseline({ plans, outDir, checkout: home, heads, deps })
  return { result, events, logs, home, state, outDir }
}

test('measureBatchBaseline acquires before measurement and releases after it', () => {
  const run = directBaseline({ label: 'ordered' })
  assert.equal(run.result, join(run.outDir, 'batch-baseline.json'))
  assert.deepEqual(run.events, ['acquire', 'spawn', 'release'])
})

test('measureBatchBaseline rechecks the cache after waiting for a slot', () => {
  const sha = 'a'.repeat(40)
  const run = directBaseline({
    label: 'queued-recheck', waitOnce: true,
    onWait: ({ state }) => put(join(state, 'baselines', `${sha}.json`), JSON.stringify({ sha, command: 'npm test', pass: 3, fail: 0, status: 'green' })),
  })
  assert.equal(run.result, cachePath(run.home, sha))
  assert.equal(run.events.includes('spawn'), false)
  assert.equal(run.events.at(-1), 'release')
  assert.equal(run.logs.filter((line) => /dispatch-batch: suite slots: K=1, waited \d+s behind 1/.test(line)).length, 1)
})

test('measureBatchBaseline still measures a sha with no cache record', () => {
  const run = directBaseline({ label: 'other-sha-cache', cachedFor: 'b'.repeat(40) })
  assert.equal(run.events.filter((event) => event === 'spawn').length, 1)
  assert.equal(run.result, join(run.outDir, 'batch-baseline.json'))
})

test('measureBatchBaseline preserves the unslotted path when slots are disabled', () => {
  const run = directBaseline({ label: 'disabled', capacity: '0' })
  assert.equal(run.result, join(run.outDir, 'batch-baseline.json'))
  assert.deepEqual(run.events, ['spawn'])
  assert.equal(run.logs.some((line) => line.includes('suite slots:')), false)
})

test('factoryStateRoot is relocatable and baselineCacheRoot keeps its suffix', () => {
  const relocated = join(root, 'relocated-state')
  assert.equal(factoryStateRoot({ env: { DEVTEAM_LEDGER_DIR: relocated }, home: '/tmp/nope' }), relocated)
  const fallback = join(root, 'fallback-home')
  const deps = { env: {}, home: fallback }
  assert.equal(factoryStateRoot(deps), join(fallback, '.dev-team', 'factory'))
  assert.equal(baselineCacheRoot(deps), join(fallback, '.dev-team', 'factory', 'baselines'))
})

test('a four-lane batch measures the baseline once', async () => {
  const names = ['lane-a', 'lane-b', 'lane-c', 'lane-d']
  const result = await fakedDispatch({ label: 'four', names, shaFor: () => 'a'.repeat(40) })
  // Measured mechanism: four lanes cost four suite runs before this lane and one after.
  assert.equal(result.measures.length, 1)
  assert.equal(result.compiles.length, 4)
  assert.equal(result.discovers.length, 4)
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
  assert.equal(result.discovers.length, 3)
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
  assert.equal(result.discovers.length, 3)
  assert.equal(result.compiles.every(({ args }) => !(args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 3)
})

test('a single-lane batch takes no separate batch measurement', async () => {
  const result = await fakedDispatch({ label: 'single', names: ['lane-a'], shaFor: () => 'a'.repeat(40) })
  assert.equal(result.measures.length, 0)
  assert.equal(result.compiles.length, 1)
  assert.equal(result.discovers.length, 1)
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
      const lane = compilerLane(call.args)
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
      const lane = compilerLane(call.args)
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
      const lane = compilerLane(call.args)
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
      const lane = compilerLane(call.args)
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
  const compilerCalls = result.spawned.filter(({ args }) => args.includes('--request') && args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  const discovers = compilerCalls.filter(({ args }) => args.includes('--discover-reads'))
  const compiles = compilerCalls.filter(({ args }) => args.includes('--out'))
  assert.equal(measures.length, 0)
  assert.equal(discovers.length, 2)
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
  const compilerCalls = result.spawned.filter(({ args }) => args.includes('--request') && args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  const discovers = compilerCalls.filter(({ args }) => args.includes('--discover-reads'))
  const compiles = compilerCalls.filter(({ args }) => args.includes('--out'))
  assert.equal(result.spawned.filter(({ args }) => args.includes('--measure-baseline')).length, 0)
  assert.equal(discovers.length, 2)
  assert.equal(compiles.length, 2)
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

test('bootCommand hands every lane the dispatching checkout roster path', () => {
  const laneDir = '/tmp/dispatching-lane'
  const command = bootCommand({ lane: 'lane-a', laneDir, tier: 'build', registerPath: '/tmp/register.json', transport: BOOT_TRANSPORT, seats: {}, runFlags: {} })
  assert.equal(command.cwd, laneDir)
  assert.equal(command.args[command.args.indexOf('--roster') + 1], ROSTER_PATH)
  assert.equal(ROSTER_PATH.startsWith(laneDir), false)
})

test('turn-ceiling boot flags are parsed, forwarded verbatim, and omitted when unset', async () => {
  const expected = {
    'max-turns-planner': '70', 'max-turns-tech-lead': '71', 'max-turns-builder': '72',
    'max-turns-reviewer': '73', 'max-turns-lead': '74',
  }
  assert.deepEqual(parseCliArgs(Object.entries(expected).flatMap(([flag, value]) => [`--${flag}`, value])), expected)
  const result = await dispatchFixture({ label: 'turn-ceiling-flags', names: ['lane-a'], runFlags: expected })
  const boot = result.spawned.find(({ args }) => args.includes('boot'))
  for (const [flag, value] of Object.entries(expected)) {
    const index = boot.args.indexOf(`--${flag}`)
    assert.notEqual(index, -1)
    assert.equal(boot.args[index + 1], value)
  }
  const bare = await dispatchFixture({ label: 'turn-ceiling-flags-absent', names: ['lane-a'] })
  const bareBoot = bare.spawned.find(({ args }) => args.includes('boot'))
  for (const flag of Object.keys(expected)) assert.equal(bareBoot.args.includes(`--${flag}`), false)
})

test('canonical assurance parses, reconciles, and emits without its tier alias', () => {
  assert.deepEqual(parseCliArgs(['--assurance', 'rigorous']), { assurance: 'rigorous' })
  assert.equal(resolveRequestedTier({ assurance: 'quick' }), 'mechanical')
  assert.equal(resolveRequestedTier({ assurance: 'standard' }), 'build')
  assert.equal(resolveRequestedTier({ assurance: 'rigorous' }), 'judge')
  const command = bootCommand({
    lane: 'lane-a', laneDir: '/tmp/dispatching-lane', tier: 'build', registerPath: '/tmp/register.json',
    transport: BOOT_TRANSPORT, seats: {}, runFlags: { assurance: 'standard' },
  })
  const index = command.args.indexOf('--assurance')
  assert.equal(command.args[index + 1], 'standard')
  assert.equal(command.args.includes('--tier'), false)
  const unknown = (() => { try { resolveRequestedTier({ assurance: 'unknown' }) } catch (error) { return error } })()
  assert.equal(unknown?.reason, 'batch-unreadable')
  const conflict = (() => { try { resolveRequestedTier({ tier: 'build', assurance: 'standard' }) } catch (error) { return error } })()
  assert.equal(conflict?.reason, 'batch-unreadable')
  assert.match(conflict?.message ?? '', /mutually exclusive/)
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
    assert.equal(args[args.indexOf('--roster') + 1], ROSTER_PATH)
    assert.equal(args[args.indexOf('--roster') + 1].startsWith(args[args.indexOf('--checkout') + 1]), false)
    for (const [flag, value] of [['--memory-dir', '/tmp/mem'], ['--memory-backend', 'sqlite'], ['--memory-budget-bytes', '4096']]) {
      assert.equal(args[args.indexOf(flag) + 1], value)
    }
  }
  const bare = await dispatchFixture({ label: 'memory-flags-absent', names: ['lane-a'] })
  for (const { args } of bare.spawned.filter(({ args }) => args.includes('boot'))) {
    assert.equal(args[args.indexOf('--roster') + 1], ROSTER_PATH)
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

test('main sanitises an external register before dispatch and boot', async () => {
  const checkout = gitFixture()
  const batch = join(checkout, 'main-external-batch')
  const parentDir = join(root, 'main-external-parent')
  const outDir = join(root, 'main-external-out')
  const home = join(root, 'main-external-home')
  const external = 'external-lane'
  mkdirSync(batch)
  put(join(batch, 'lane-a.request.json'), JSON.stringify(request('measure main external behavior', ['src/owned.mjs'])))
  const authored = join(checkout, 'main-external-fences.json')
  put(authored, JSON.stringify({ lanes: [
    entry('lane-a', ['src/owned.mjs']),
    { lane: external, files: ['src/stale.mjs'], external: true },
  ] }))
  crewFixture({ home, repoDir: 'dt-external-lane', laneDir: external, lane: external, checkout })
  const spawned = []
  const logs = []
  const code = await main([
    '--batch', batch,
    '--fences', authored,
    '--checkout', checkout,
    '--parent', parentDir,
    '--out', outDir,
    '--tier', 'mechanical',
    '--variant', 'full',
  ], {
    home,
    env: { DEVTEAM_LEDGER_DIR: join(home, 'factory-state') },
    assertQuiet: () => {},
    readFileSync: (path, encoding) => {
      const text = String(path)
      if (text.endsWith(join('dt-lane-a', 'lane-a', 'crew.json'))) {
        return JSON.stringify({
          lane_name: 'lane-a',
          lane_fence: [{ lane: external, files: ['src/stale.mjs'] }],
        })
      }
      return readFileSync(text, encoding || 'utf8')
    },
    spawn: (call) => {
      spawned.push(call)
      const args = (call.args || []).map(String)
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    spawnAsync: async (call) => {
      spawned.push(call)
      const args = (call.args || []).map(String)
      if (args.includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
      const outAt = args.indexOf('--out')
      if (outAt >= 0) put(args[outAt + 1], briefWithBlockOnly)
      return { status: 0, stdout: '', stderr: '' }
    },
    log: (line) => logs.push(String(line)),
  })
  assert.equal(code, 0)
  const stripped = join(outDir, EXTERNAL_REGISTER_NAME)
  const sanitised = JSON.parse(readFileSync(stripped, 'utf8'))
  assert.equal(Object.hasOwn(sanitised.lanes.find((entry) => entry.lane === external), 'external'), false)
  assert.equal(logs.some((line) => line.startsWith(EXTERNAL_FENCE_PREFIX) && line.includes(`lane=${external}`)), true)
  const fencedCalls = spawned.filter((call) => call.args.includes('--fences'))
  assert.ok(fencedCalls.length >= 3)
  assert.equal(fencedCalls.every((call) => call.args[call.args.indexOf('--fences') + 1] === stripped), true)
  const boots = spawned.filter((call) => call.args.includes('boot'))
  assert.equal(boots.length, 1)
  assert.equal(boots[0].args[boots[0].args.indexOf('--fences') + 1], stripped)
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

test('HoldB1', async () => {
  const result = await dispatchFixture({
    label: 'hold-b1',
    names: ['lane-a'],
    random: () => { throw new Error('random must not be touched when the flag is absent') },
  })
  const compilerCalls = result.spawned.filter(({ args }) => (args || []).some((arg) => String(arg).endsWith('make-brief.mjs')) && (args || []).includes('--request'))
  const runCalls = result.spawned.filter(({ args }) => (args || []).includes('run'))
  assert.equal(compilerCalls.filter(({ args }) => (args || []).includes('--out')).length, 1)
  assert.equal(runCalls.length, 1)
  assert.equal(compilerCalls.some(({ args }) => (args || []).includes('--pack-omission')), false)
  assert.equal(result.appended.length, 0)
  assert.equal(selectPlannerSymbolsArm(null, () => { throw new Error('null arm selector must not draw') }), null)
  const record = JSON.parse(readFileSync(join(result.out, 'lane-a.dispatch.json'), 'utf8'))
  assert.equal(Object.hasOwn(record, 'experiment'), false)
  for (const value of [0, 1, 0.5]) assert.equal(parsePlannerSymbolsHoldoutFraction(value), value)
  for (const value of ['', 'NaN', 'Infinity', '-0.1', '1.1', ' 0.5', '0.5x']) {
    assert.throws(() => parsePlannerSymbolsHoldoutFraction(value), BatchRefusal)
  }
})

test('HoldB2', async () => {
  const draws = [0.1, 0.6, 0.9]
  let randomCalls = 0
  const result = await dispatchFixture({
    label: 'hold-b2',
    names: ['lane-a', 'lane-b', 'lane-c'],
    runFlags: { 'planner-symbols-holdout-fraction': '0.5' },
    random: () => draws[randomCalls++],
  })
  assert.equal(randomCalls, 3)
  const compiles = result.spawned.filter(({ args }) => (args || []).some((arg) => String(arg).endsWith('make-brief.mjs')) && (args || []).includes('--out'))
  assert.equal(compiles.length, 3)
  const byLane = new Map(compiles.map((call) => [call.args[call.args.indexOf('--lane') + 1], call]))
  assert.equal(byLane.get('lane-a').args.includes('--pack-omission'), false)
  assert.equal(byLane.get('lane-b').args[byLane.get('lane-b').args.indexOf('--pack-omission') + 1], 'symbols')
  assert.equal(byLane.get('lane-c').args[byLane.get('lane-c').args.indexOf('--pack-omission') + 1], 'symbols')
  const runs = result.spawned.filter(({ args }) => (args || []).includes('run'))
  assert.equal(runs.length, 3)
  for (const call of runs) {
    const lane = call.args[call.args.indexOf('--task') + 1]
    assert.equal(call.args[call.args.indexOf('--brief-file') + 1], join(result.out, `${lane}.brief.md`))
  }
  assert.equal(result.appended.length, 3)
})

test('HoldB3', async () => {
  const result = await dispatchFixture({
    label: 'hold-b3',
    names: ['lane-a'],
    runFlags: { 'planner-symbols-holdout-fraction': '1' },
    random: () => 0.999,
  })
  const row = JSON.parse(result.appended[0].content)
  assert.deepEqual(row, {
    at: row.at,
    event: PLANNER_SYMBOLS_ARM_EVENT,
    role: 'planner',
    experiment: PLANNER_SYMBOLS_EXPERIMENT,
    arm: 'control',
    fraction: 1,
  })
  const record = JSON.parse(readFileSync(join(result.out, 'lane-a.dispatch.json'), 'utf8'))
  assert.deepEqual(record.experiment, { name: PLANNER_SYMBOLS_EXPERIMENT, arm: 'control', fraction: 1 })

  const deferred = await dispatchFixture({
    label: 'hold-b3-resume',
    names: ['lane-a', 'lane-b'],
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: 2, 'planner-symbols-holdout-fraction': '0.25' },
  })
  assert.ok(deferred.logs.some((line) => line.includes('--planner-symbols-holdout-fraction 0.25')), JSON.stringify(deferred.logs))
})

test('HoldB4', async () => {
  const trace = []
  const result = await dispatchFixture({
    label: 'hold-b4',
    names: ['lane-a'],
    runFlags: { 'planner-symbols-holdout-fraction': '0' },
    random: () => 0,
    appendFile: () => trace.push('arm'),
    spawnResult: (args) => {
      if (args.includes('boot')) trace.push('boot')
      if (args.includes('run')) trace.push('run')
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(trace, ['boot', 'arm', 'run'])
  assert.equal(result.appended.length, 1)
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

test('briefMeasure reports UTF-8 bytes and the largest section, or null', () => {
  const text = ['## Small', 'one', '## Largest', '·'.repeat(4), 'more', '## Tail', 'x'].join('\n')
  assert.deepEqual(briefMeasure(text), { bytes: Buffer.byteLength(text), topSection: 'Largest' })
  assert.deepEqual(briefMeasure('plain text ·'), { bytes: Buffer.byteLength('plain text ·'), topSection: null })
})

test('normalDeps supplies the house-style dependency surface', () => {
  const deps = normalDeps({})
  assert.deepEqual(Object.keys(deps).sort(), ['appendFileSync', 'assertQuiet', 'env', 'existsSync', 'home', 'log', 'mkdirSync', 'now', 'random', 'readFileSync', 'readdirSync', 'sleep', 'slots', 'spawn', 'spawnAsync', 'writeFileSync'])
})

test('compileLane discovers reads once and compiles once', async () => {
  const batch = makeBatch(['lane-a'])
  const out = join(root, 'compile-out')
  const register = join(root, 'register.json')
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['crew/owned.mjs'], [])] }))
  const calls = []
  const why = 'compiler reported a coupled source while compiling lane lane-a'
  const discovered = JSON.stringify([{ file: 'crew/x.mjs', why }])
  const result = await compileLane({
    lane: 'lane-a', batchDir: batch, laneDir: root, registerPath: register, outDir: out,
    fences: [entry('lane-a', ['crew/owned.mjs'], [])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        return call.args.includes('--discover-reads')
          ? { status: 0, stdout: discovered, stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      },
      readFileSync: (path) => path.endsWith('.brief.md') ? briefWithTierAndShape : readFileSync(path, 'utf8'),
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].args.includes('--discover-reads'), true)
  assert.equal(calls[0].args.includes('--out'), false)
  assert.equal(calls[1].args.includes('--out'), true)
  assert.equal(calls[1].args.includes('--pack'), true)
  assert.equal(calls[1].args[calls[1].args.indexOf('--pack') + 1], out)
  assert.equal(result.proposed, 'build')
  const retry = calls[1].args[calls[1].args.indexOf('--fences') + 1]
  assert.notEqual(retry, register)
  assert.deepEqual(JSON.parse(readFileSync(retry, 'utf8')).lanes[0].reads, [{ file: 'crew/x.mjs', why }])
})

test('compileLane soft-fails an unavailable issue body without refusing or passing it', async () => {
  const lane = 'lane-gh'
  const batch = makeBatch([lane])
  const requestPath = put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(request(
    '#867 Carry the cited issue context into this lane brief',
    ['crew/owned.mjs'],
  )))
  const out = join(root, 'compile-gh-out')
  const register = put(join(root, 'compile-gh-register.json'), JSON.stringify({ lanes: [entry(lane, ['crew/owned.mjs'], [])] }))
  const calls = []
  const logs = []
  const result = await compileLane({
    lane, batchDir: batch, requestPath, laneDir: root, registerPath: register, outDir: out,
    fences: [entry(lane, ['crew/owned.mjs'], [])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        if ((call.args || []).includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
        if (call.file === 'gh') return { status: 1, stdout: '', stderr: 'gh failed' }
        return { status: 0, stdout: '', stderr: '' }
      },
      readFileSync: (path, encoding) => String(path).endsWith('.brief.md') ? briefWithTierAndShape : readFileSync(path, encoding || 'utf8'),
      log: (line) => logs.push(String(line)),
    },
  })
  const compile = calls.find(({ args }) => args.includes('--out'))
  assert.ok(compile)
  assert.equal(compile.args.includes('--pack'), true)
  assert.equal(compile.args.includes('--issue-body'), false)
  const gh = calls.find(({ file }) => file === 'gh')
  assert.ok(gh)
  assert.deepEqual(gh.args, ['issue', 'view', '867', '--json', 'body', '--jq', '.body'])
  assert.deepEqual(logs, ['dispatch-batch: issue-body lane=lane-gh issue=867 status=unavailable reason=gh-failed'])
  assert.equal(result.topSection, 'Proposed tier')
})

test('compileLane passes a fetched issue body path only after gh returns content', async () => {
  const lane = 'lane-gh-ok'
  const batch = makeBatch([lane])
  const requestPath = put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(request(
    '#42 Carry the cited issue context into this lane brief',
    ['crew/owned.mjs'],
  )))
  const out = join(root, 'compile-gh-ok-out')
  const register = put(join(root, 'compile-gh-ok-register.json'), JSON.stringify({ lanes: [entry(lane, ['crew/owned.mjs'], [])] }))
  const calls = []
  const writes = new Map()
  const result = await compileLane({
    lane, batchDir: batch, requestPath, laneDir: root, registerPath: register, outDir: out,
    fences: [entry(lane, ['crew/owned.mjs'], [])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        if ((call.args || []).includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
        if (call.file === 'gh') return { status: 0, stdout: 'Fetched body.\n', stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      },
      readFileSync: (path, encoding) => String(path).endsWith('.brief.md') ? briefWithTierAndShape : readFileSync(path, encoding || 'utf8'),
      writeFileSync: (path, content) => writes.set(String(path), String(content)),
    },
  })
  const compile = calls.find(({ args }) => args.includes('--out'))
  assert.ok(compile)
  const issueFlag = compile.args.indexOf('--issue-body')
  assert.notEqual(issueFlag, -1)
  const issuePath = compile.args[issueFlag + 1]
  assert.equal(issuePath, join(out, `${lane}.issue.md`))
  assert.equal(writes.get(issuePath), 'Fetched body.\n')
  assert.equal(result.bytes, Buffer.byteLength(briefWithTierAndShape))
})

test('dispatch records compiler intent in crew.json and the journal', async () => {
  const intent = 'The dispatched lane purpose.'
  const brief = [
    '## Intent',
    intent,
    '## Proposed tier',
    'proposed tier: mechanical',
    '```proposal',
    '{"shape":"mechanical","strength":"workhorse"}',
    '```',
  ].join('\n')
  const result = await dispatchFixture({ label: 'intent-surfaces', names: ['lane-a'], brief })
  const crewWrites = [...result.wrote.entries()].filter(([path]) => path.endsWith('/crew.json'))
  assert.equal(crewWrites.length, 1)
  const crew = JSON.parse(crewWrites[0][1])
  assert.equal(crew.intent, intent)
  assert.equal(crew.lane_name, 'lane-a')
  assert.deepEqual(crew.lane_fence, [])
  assert.equal(crew.workspace_id, 'ws-lane-a')

  const rows = result.appended
    .filter(({ path }) => path.endsWith('journal.jsonl'))
    .flatMap(({ content }) => content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, 'lane-intent')
  assert.equal(rows[0].task, 'lane-a')
  assert.equal(rows[0].lane, 'lane-a')
  assert.equal(rows[0].intent, intent)
})

test('compiler-owned intent outranks an Intent heading quoted by the ask', async () => {
  const canonical = 'Canonical authored intent.'
  const spoofed = 'Spoofed journal value.'
  const prefix = 'Carry the authored intent into dispatch surfaces.'
  const ask = [prefix, '## The ask', prefix, '## Intent', spoofed].join('\n')
  const request = requestFor('lane-a', { ask, intent: canonical })
  const brief = renderBrief({
    request,
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
  })
  const result = await dispatchFixture({
    label: 'intent-quoted-heading',
    names: ['lane-a'],
    requests: { 'lane-a': request },
    brief,
  })
  const crew = JSON.parse([...result.wrote.entries()].find(([path]) => path.endsWith('/crew.json'))[1])
  assert.equal(crew.intent, canonical)
  assert.notEqual(crew.intent, spoofed)
  const row = result.appended
    .filter(({ path }) => path.endsWith('journal.jsonl'))
    .flatMap(({ content }) => content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)))[0]
  assert.equal(row.intent, canonical)
  assert.notEqual(row.intent, spoofed)

  const olderBrief = brief.replace(`\n## Intent\n${canonical}\n`, '\n')
  const older = await dispatchFixture({
    label: 'intent-quoted-heading-older',
    names: ['lane-a'],
    requests: { 'lane-a': request },
    brief: olderBrief,
  })
  assert.equal([...older.wrote.keys()].some((path) => path.endsWith('/crew.json')), false)
  assert.equal(older.appended.some(({ path }) => path.endsWith('journal.jsonl')), false)
})

test('a brief without compiler intent leaves crew.json and journal untouched', async () => {
  const result = await dispatchFixture({ label: 'intent-absent', names: ['lane-a'], brief: briefWithBlockOnly })
  assert.equal([...result.wrote.keys()].some((path) => path.endsWith('/crew.json')), false)
  assert.equal(result.appended.some(({ path }) => path.endsWith('journal.jsonl')), false)
})

test('an unreadable crew.json still gets an intent journal row', async () => {
  const intent = 'The malformed crew fixture purpose.'
  const brief = ['## Intent', intent, '## Proposed tier', 'proposed tier: mechanical'].join('\n')
  let reads = 0
  const result = await dispatchFixture({
    label: 'intent-malformed-crew',
    names: ['lane-a'],
    brief,
    crewJsonFor: () => {
      reads += 1
      return reads === 1
        ? JSON.stringify({ lane_name: 'lane-a', lane_fence: [], workspace_id: 'ws-lane-a' })
        : '{not-json'
    },
  })
  assert.equal([...result.wrote.keys()].some((path) => path.endsWith('/crew.json')), false)
  const rows = result.appended
    .filter(({ path }) => path.endsWith('journal.jsonl'))
    .flatMap(({ content }) => content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, 'lane-intent')
  assert.equal(rows[0].intent, intent)
})

test('a compile that still refuses coupled sources after discovery refuses reads-unresolved', async () => {
  const batch = makeBatch(['lane-a'])
  const out = join(root, 'compile-still-refused-out')
  const register = join(root, 'compile-still-refused-register.json')
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['crew/owned.mjs'], [])] }))
  const calls = []
  await assert.rejects(() => compileLane({
    lane: 'lane-a', batchDir: batch, laneDir: root, registerPath: register, outDir: out,
    fences: [entry('lane-a', ['crew/owned.mjs'], [])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        return call.args.includes('--discover-reads')
          ? { status: 0, stdout: '[]', stderr: '' }
          : { status: 2, stdout: '', stderr: 'coupled source(s) outside lane fence: crew/x.mjs · X [reason: coupled-source-unfenced]' }
      },
    },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'reads-unresolved'
    && error.message.includes('lane-a')
    && error.message.includes('coupled-source-unfenced'))
  assert.equal(calls.length, 2)
  assert.equal(calls.some(({ args }) => args.includes('--out') && args.includes('--discover-reads')), false)
})

test('read discovery that prints no usable JSON refuses reads-unresolved', async () => {
  for (const [index, stdout] of ['', '{"file":"x"}'].entries()) {
    const batch = makeBatch([`lane-json-${index}`])
    const lane = `lane-json-${index}`
    const out = join(root, `compile-discovery-invalid-${index}-out`)
    const register = join(root, `compile-discovery-invalid-${index}-register.json`)
    put(register, JSON.stringify({ lanes: [entry(lane, ['crew/owned.mjs'], [])] }))
    const calls = []
    await assert.rejects(() => compileLane({
      lane, batchDir: batch, laneDir: root, registerPath: register, outDir: out,
      fences: [entry(lane, ['crew/owned.mjs'], [])],
      deps: {
        spawn: (call) => {
          calls.push(call)
          return call.args.includes('--discover-reads')
            ? { status: 0, stdout, stderr: '' }
            : { status: 0, stdout: '', stderr: '' }
        },
      },
    }), (error) => error instanceof BatchRefusal && error.reason === 'reads-unresolved')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].args.includes('--discover-reads'), true)
  }
})

test('a hand-authored register that over-acknowledges still refuses stale-read-ack', async () => {
  const batch = makeBatch(['lane-stale'])
  const out = join(root, 'compile-stale-read-out')
  const register = join(root, 'compile-stale-read-register.json')
  put(register, JSON.stringify({ lanes: [entry('lane-stale', ['crew/owned.mjs'], [{ file: 'crew/stale.mjs', why: 'hand-authored' }])] }))
  const calls = []
  await assert.rejects(() => compileLane({
    lane: 'lane-stale', batchDir: batch, laneDir: root, registerPath: register, outDir: out,
    fences: [entry('lane-stale', ['crew/owned.mjs'], [{ file: 'crew/stale.mjs', why: 'hand-authored' }])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        return call.args.includes('--discover-reads')
          ? { status: 0, stdout: '[]', stderr: '' }
          : { status: 2, stdout: '', stderr: 'stale read acknowledgement(s): crew/stale.mjs [reason: stale-read-ack]' }
      },
    },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'reads-unresolved'
    && error.message.includes('stale-read-ack'))
  assert.equal(calls.length, 2)
})

test('the dispatch line and run.pid carry the spawned pid', async () => {
  const previousHome = process.env.HOME
  const home = join(root, 'dispatch-pid-home')
  const lane = 'pid-lane'
  const knownPid = 49231
  process.env.HOME = home
  try {
    const result = await dispatchFixture({
      label: 'pid', names: [lane], home,
      spawnResult: (args, call) => {
        if (args.includes('boot')) {
          const checkout = args[args.indexOf('--checkout') + 1]
          mkdirSync(dirname(crewJsonPath({ checkout, lane })), { recursive: true })
        }
        if (call.background === true) return { status: 0, stdout: '', stderr: '', pid: knownPid }
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    const line = result.logs.find((entry) => entry.includes(`lane=${lane}`) && entry.includes('crew_dir='))
    assert.match(line, new RegExp(`run pid=${knownPid}\\b`))
    assert.equal(readFileSync(join(result.report.lanes[0].crewDir, 'run.pid'), 'utf8'), `${knownPid}\n`)
  } finally {
    process.env.HOME = previousHome
  }
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
      spawn: (call) => call.args.includes('--discover-reads')
        ? { status: 0, stdout: '[]', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
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
    'dispatch-batch: lane=lane-a forced=none prompt=code-only proposed=none requested=mechanical requested_from=batch variant=full variant_from=batch settled=mechanical',
  ), true)
  assert.match(line, / shape=judge strength=workhorse misclassified=false brief_bytes=65 top_section=none$/)
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
      spawn: (call) => call.args.includes('--discover-reads')
        ? { status: 0, stdout: '[]', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
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

test('a lane tier overrides a higher proposal and says so', async () => {
  const result = await dispatchFixture({
    label: 'tier-override',
    names: ['lane-a', 'lane-b'],
    batchTier: 'mechanical',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'build' }) },
    brief: staffingBrief({ shape: 'mechanical', strength: 'workhorse', tier: 'judge' }),
  })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  const seated = Object.fromEntries(boots.map((call) => {
    const task = call.args[call.args.indexOf('--task') + 1]
    return [task, call.args[call.args.indexOf('--tier') + 1]]
  }))
  assert.equal(seated['lane-a'], 'build')
  const laneA = result.logs.find((line) => line.startsWith('dispatch-batch: lane=lane-a '))
  const laneB = result.logs.find((line) => line.startsWith('dispatch-batch: lane=lane-b '))
  assert.ok(laneA?.includes('settled=build'))
  assert.ok(laneA?.includes('overrode proposal judge with lane tier build'))
  assert.ok(laneB?.includes('settled=judge'))
  assert.equal(laneB?.includes('overrode proposal'), false)
  const laneARecord = JSON.parse(readFileSync(join(result.out, 'lane-a.dispatch.json'), 'utf8'))
  const laneBRecord = JSON.parse(readFileSync(join(result.out, 'lane-b.dispatch.json'), 'utf8'))
  assert.equal(laneARecord.tier.overrode_proposal, true)
  assert.equal(laneARecord.tier.proposed, 'judge')
  assert.equal(laneBRecord.tier.overrode_proposal, false)
})

test('the compiler receives exactly the four schema request keys', async () => {
  const result = await dispatchFixture({
    label: 'clean-request',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'judge', variant: 'scout' }) },
  })
  const compiles = result.spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(compiles.length, 4)
  assert.equal(compiles.filter(({ args }) => args.includes('--discover-reads')).length, 2)
  assert.equal(compiles.filter(({ args }) => args.includes('--out')).length, 2)
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
  assert.equal(compiles.length, 2)
  assert.equal(compiles.filter(({ args }) => args.includes('--discover-reads')).length, 1)
  assert.equal(compiles.filter(({ args }) => args.includes('--out')).length, 1)
  const path = compiles[0].args[compiles[0].args.indexOf('--request') + 1]
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['ask', 'done_means', 'out_of_scope', 'where'])
})

test('parseCliArgs accepts repeated --adopt and refuses a spec with no lane', () => {
  assert.deepEqual(parseCliArgs([
    '--adopt', 'lane-a=/tmp/archive-a', '--adopt', 'lane-b=/tmp/archive-b',
  ]).adopt, ['lane-a=/tmp/archive-a', 'lane-b=/tmp/archive-b'])
  for (const spec of ['=dir', 'lane=', 'lane']) {
    refusal(() => resolveAdoptions({
      lanes: [{ lane: 'lane' }],
      runFlags: { adopt: [spec] },
      deps: { existsSync: () => false },
    }), 'plan-adopt-unreadable')
  }
})

test('adoptSourceDir takes an operator-named task directory at its word', () => {
  const task = join(root, 'operator-named-task', 'task')
  assert.equal(adoptSourceDir(task), task)
  assert.equal(adoptSourceDir(dirname(task)), task)
})

test('lineageBaseline carries measured, explicit-null, predecessor, absent, and unreadable states', () => {
  assert.deepEqual([...LINEAGE_SOURCES], ['carried', 'predecessor-round1'])
  const source = join(root, 'lineage-carried', 'task')
  const carriedPath = join(root, 'lineage-carried', 'journal.jsonl')
  put(carriedPath, `${JSON.stringify({ event: ADOPT_EVENT, lineage_baseline_bytes: 120, lineage_reason: 'lineage-journal-absent' })}\n${JSON.stringify({ plan_growth: { round: 1, combined_bytes: 999 } })}\n`)
  assert.deepEqual(lineageBaseline({ source, combined_bytes: 240 }), { baseline_bytes: 120, source: 'carried', reason: null })

  const explicit = join(root, 'lineage-explicit-null', 'task')
  put(join(root, 'lineage-explicit-null', 'journal.jsonl'), JSON.stringify({
    event: ADOPT_EVENT, lineage_baseline_bytes: null, lineage_reason: 'lineage-journal-absent',
  }) + '\n' + JSON.stringify({ plan_growth: { round: 1, combined_bytes: 999 } }) + '\n')
  assert.deepEqual(lineageBaseline({ source: explicit, combined_bytes: 200 }), { baseline_bytes: null, source: null, reason: 'lineage-journal-absent' })

  const predecessor = join(root, 'lineage-predecessor', 'task')
  put(join(root, 'lineage-predecessor', 'journal.jsonl'), JSON.stringify({ plan_growth: { round: 1, combined_bytes: 80 } }) + '\n')
  assert.deepEqual(lineageBaseline({ source: predecessor, combined_bytes: 160 }), { baseline_bytes: 80, source: 'predecessor-round1', reason: null })

  const absent = join(root, 'lineage-absent', 'task')
  assert.deepEqual(lineageBaseline({ source: absent, combined_bytes: 160 }), { baseline_bytes: null, source: null, reason: 'lineage-journal-absent' })
  const unreadable = join(root, 'lineage-unreadable', 'task')
  assert.deepEqual(lineageBaseline({ source: unreadable, combined_bytes: 160, deps: {
    existsSync: () => true,
    readFileSync: () => { throw new Error('EPERM') },
  } }), { baseline_bytes: null, source: null, reason: 'lineage-journal-unreadable' })
})

test('resolveAdoptions measures the adoption and carries the lineage baseline into its row', () => {
  const archive = adoptionArchive('lineage-resolve', {
    plan: 'p'.repeat(30), gate: 'g'.repeat(20),
    journal: JSON.stringify({ plan_growth: { round: 1, combined_bytes: 10 } }) + '\n',
  })
  const adoption = resolveAdoptions({ lanes: [{ lane: 'lane-a', adopt: archive }], runFlags: {} }).get('lane-a')
  assert.equal(adoption.plan_bytes, 30)
  assert.equal(adoption.gate_bytes, 20)
  assert.equal(adoption.combined_bytes, 50)
  assert.equal(adoption.lineage_baseline_bytes, 10)
  assert.equal(adoption.lineage_baseline_source, 'predecessor-round1')
  assert.equal(adoption.lineage_ratio, 5)
  assert.equal(adoption.lineage_reason, null)
  const crewDir = join(root, 'lineage-resolve-crew')
  const briefPath = put(join(root, 'lineage-resolve-brief.md'), '# brief\n')
  applyAdoption({ adoption, crewDir, briefPath })
  const row = readFileSync(join(crewDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((entry) => entry.event === ADOPT_EVENT)
  assert.equal(row.plan_bytes, 30)
  assert.equal(row.gate_bytes, 20)
  assert.equal(row.combined_bytes, 50)
  assert.equal(row.lineage_baseline_bytes, 10)
  assert.equal(row.lineage_ratio, 5)
})

test('dispatchBatch refuses quoted absolute adoption paths before worktree creation', async () => {
  const first = '/Users/example/Dev/dt-predecessor/crew/seat-io.mjs'
  const second = '/Users/example/Dev/dt-predecessor'
  const archive = adoptionArchive('absolute-gate', {
    gate: [`import { seatIo } from '${first}'`, `const OLD_REPO = '${second}'`].join('\n'),
  })
  const home = join(root, 'absolute-gate-home')
  const spawned = []
  const error = await thrownAsync(() => adoptionDispatchFixture({
    label: 'absolute-gate', home, spawnedOut: spawned,
    runFlags: parseCliArgs(['--adopt', `lane-a=${archive}`]),
  }))
  assert.equal(error.reason, 'plan-adopt-gate-absolute-path')
  assert.match(error.message, /gate\.mjs/)
  assert.match(error.message, /process\.cwd\(\)/)
  assert.match(error.message, /line\(s\) 1, 2/)
  assert.equal(error.message.includes(first), true)
  assert.equal(error.message.includes(second), true)
  assert.equal(spawned.length, 0)
  assert.equal(fsExistsSync(join(home, '.crew')), false)
})

test('resolveAdoptions refuses a gate pinned to its OWN checkout, not only a predecessor', () => {
  // prove-mutations runs the gate in a fresh temporary worktree, so a gate pinned to
  // any absolute checkout -- its own included -- can kill no mutation.
  // A real lane checkout, not a temp path: a repo-root assignment under the system
  // temp dir is exempt as a scratch fixture (see the sibling test), so the limitation
  // is stated by the pair rather than hidden.
  const self = '/Users/example/Dev/dt-self-pinned'
  const archive = adoptionArchive('self-pinned-gate', {
    gate: `const REPO = '${self}'\n`,
  })
  const error = thrown(() => resolveAdoptions({
    lanes: [{ lane: 'lane-a', adopt: archive }], checkout: self, runFlags: {},
  }))
  assert.equal(error.reason, 'plan-adopt-gate-absolute-path')
  assert.equal(error.message.includes(self), true)
})

test('resolveAdoptions admits a gate whose scratch fixture repo lives under system temp', () => {
  // Measured: 4 of the 8 archives the first predicate flagged were gates minting their
  // own scratch repository -- const CHECKOUT = '/tmp/bNNN-gate-repo' -- which is a
  // fixture, not the repository under test. An IMPORT from temp is still refused.
  const gate = [
    "const CHECKOUT = '/tmp/b352-gate-repo'",
    'const REPO = process.cwd()',
  ].join('\n')
  const archive = adoptionArchive('scratch-fixture-gate', { gate })
  const adopted = resolveAdoptions({
    lanes: [{ lane: 'lane-a', adopt: archive }], checkout: process.cwd(), runFlags: {},
  }).get('lane-a')
  assert.equal(adopted?.gate_bytes, Buffer.byteLength(gate, 'utf8'))
})

test('an IMPORT from system temp is refused even though a repo-root assignment there is exempt', () => {
  // The scratch exemption is deliberately narrow: it covers a repo-root ASSIGNMENT
  // only. An import specifier is never exempt, because that is the shape that made a
  // gate measure the wrong tree (b508-coldledger) and the shape prove-mutations cannot
  // follow into its temporary worktree.
  const archive = adoptionArchive('temp-import-gate', {
    gate: "import { seatIo } from '/tmp/b352-gate-repo/crew/seat-io.mjs'\n",
  })
  const error = thrown(() => resolveAdoptions({
    lanes: [{ lane: 'lane-a', adopt: archive }], checkout: process.cwd(), runFlags: {},
  }))
  assert.equal(error.reason, 'plan-adopt-gate-absolute-path')
})

test('resolveAdoptions admits absolute literals that are not repo resolutions', () => {
  // The premise 'any quoted absolute literal is unsafe' measured 10/214 precision over
  // the archived corpus: bare '/' hit 58 times and the comment '// gate' 214 times.
  const gate = [
    "const GH = '/usr/bin/gh'",
    "const SCRATCH = '/tmp/b427-gate-task'",
    "const SEP = '/'",
    '// gate',
    'const REPO = process.cwd()',
  ].join('\n')
  const archive = adoptionArchive('data-literals-gate', { gate })
  const adopted = resolveAdoptions({
    lanes: [{ lane: 'lane-a', adopt: archive }], checkout: process.cwd(), runFlags: {},
  }).get('lane-a')
  assert.equal(adopted?.gate_bytes, Buffer.byteLength(gate, 'utf8'))
})

test('resolveAdoptions permits process.cwd and join based gate paths', () => {
  const gate = [
    "import { join } from 'node:path'",
    'const REPO = process.cwd()',
    "const target = join(REPO, 'crew', 'seat-io.mjs')",
  ].join('\n')
  const archive = adoptionArchive('portable-gate', { gate })
  const adopted = resolveAdoptions({
    lanes: [{ lane: 'lane-a', adopt: archive }],
    checkout: process.cwd(),
    runFlags: {},
  }).get('lane-a')
  assert.equal(adopted?.gate_bytes, Buffer.byteLength(gate, 'utf8'))
})

test('resolveAdoptions reads gate.mjs once and measures those same bytes', () => {
  const gate = 'const REPO = process.cwd()\n'
  const archive = adoptionArchive('single-gate-read', { gate })
  const gatePath = join(archive, 'task', 'gate.mjs')
  let gateReads = 0
  const adopted = resolveAdoptions({
    lanes: [{ lane: 'lane-a', adopt: archive }],
    checkout: process.cwd(),
    runFlags: {},
    deps: {
      readFileSync: (path, encoding) => {
        if (String(path) === gatePath) gateReads += 1
        return readFileSync(path, encoding)
      },
    },
  }).get('lane-a')
  assert.equal(gateReads, 1)
  assert.equal(adopted?.gate_bytes, Buffer.byteLength(gate, 'utf8'))
})

test('lineageLine appears on both adoption print surfaces and preserves unmeasured reasons', async () => {
  const archive = adoptionArchive('lineage-prints', { plan: 'p'.repeat(10), gate: 'g'.repeat(5) })
  const adoption = resolveAdoptions({ lanes: [{ lane: 'lane-a', adopt: archive }], runFlags: {} }).get('lane-a')
  const measured = lineageLine(adoption)
  assert.match(measured, /lineage_baseline=null/)
  assert.match(measured, /lineage_ratio=null/)
  assert.match(measured, /lineage-journal-absent/)
  const dry = await adoptionDispatchFixture({
    label: 'lineage-dry-print', runFlags: { ...parseCliArgs(['--adopt', `lane-a=${archive}`]), 'dry-run': true },
  })
  assert.ok(dry.logs.some((line) => line.includes('dry-run lane=lane-a') && line.includes('lineage_ratio=null')))
  const normal = await adoptionDispatchFixture({
    label: 'lineage-normal-print', runFlags: parseCliArgs(['--adopt', `lane-a=${archive}`]),
  })
  assert.ok(normal.logs.some((line) => line.includes('plan-adopted lane=lane-a') && line.includes('lineage_ratio=null')))
})

test('resolveAdoptions refuses a CLI adoption whose lane is outside the batch', () => {
  const archive = adoptionArchive('outside-batch')
  refusal(() => resolveAdoptions({
    lanes: [{ lane: 'lane-a' }],
    runFlags: { adopt: [`not-in-batch=${archive}`] },
  }), 'plan-adopt-unreadable')
})

test('resolveAdoptions refuses an unreadable plan-check.md', () => {
  const archive = adoptionArchive('unreadable-plan-check', { planCheck: 'VERDICT: revise\n' })
  const checkPath = join(archive, 'task', 'plan-check.md')
  const error = thrown(() => resolveAdoptions({
    lanes: [{ lane: 'lane-a' }],
    runFlags: { adopt: [`lane-a=${archive}`] },
    deps: {
      readFileSync: (path, encoding) => {
        if (String(path) === checkPath) throw new Error('EACCES: permission denied')
        return readFileSync(path, encoding)
      },
    },
  }))
  assert.equal(error.reason, 'plan-adopt-unreadable')
  assert.match(error.message, /plan-check\.md is unreadable/)
  assert.match(error.message, /EACCES: permission denied/)
})

test('applyAdoption refuses each required source missing at copy time without creating task files', () => {
  for (const missing of ['plan.md', 'gate.mjs']) {
    const archive = adoptionArchive(`copy-time-missing-${missing}`, { omit: missing })
    const crewDir = join(root, `copy-time-missing-${missing}-crew`)
    const briefPath = put(join(root, `copy-time-missing-${missing}-brief.md`), '# brief\n')
    const error = thrown(() => applyAdoption({
      adoption: { lane: 'lane-a', archive, source: join(archive, 'task'), revise: false, from: 'cli' },
      crewDir,
      briefPath,
    }))
    assert.equal(error.reason, 'plan-adopt-unreadable')
    assert.match(error.message, new RegExp(missing.replace('.', '\\.') ))
    assert.equal(fsExistsSync(join(crewDir, 'task')), false)
  }
})

test('applyAdoption reads every source before writing and rolls back a later write failure', () => {
  const archive = adoptionArchive('atomic-write')
  const crewDir = join(root, 'atomic-write-crew')
  const briefPath = put(join(root, 'atomic-write-brief.md'), '# brief\n')
  const calls = []
  const error = thrown(() => applyAdoption({
    adoption: { lane: 'lane-a', archive, source: join(archive, 'task'), revise: false, from: 'cli' },
    crewDir,
    briefPath,
    deps: {
      mkdirSync: (...args) => { calls.push('mkdir'); mkdirSync(...args) },
      writeFileSync: (path, body) => {
        calls.push(`write:${basenameOf(path)}`)
        if (String(path).endsWith('/gate.mjs')) throw new Error('interrupted write')
        writeFileSync(path, body)
      },
      appendFileSync: (...args) => { calls.push('append'); fsAppendFileSync(...args) },
    },
  }))
  assert.equal(error.reason, 'plan-adopt-unreadable')
  assert.deepEqual(calls.slice(0, 3), ['mkdir', 'write:plan.md', 'write:gate.mjs'])
  assert.equal(fsExistsSync(join(crewDir, 'task', 'plan.md')), false)
  assert.equal(fsExistsSync(join(crewDir, 'task', 'gate.mjs')), false)
  assert.equal(fsExistsSync(briefPath), true)
  assert.equal(readFileSync(briefPath, 'utf8'), '# brief\n')
})

test('applyAdoption uses append seams and swallows only journal append failures', () => {
  const archive = adoptionArchive('append-seams')
  const crewDir = join(root, 'append-seams-crew')
  const briefPath = put(join(root, 'append-seams-brief.md'), '# brief\n')
  const appended = []
  const applied = applyAdoption({
    adoption: { lane: 'lane-a', archive, source: join(archive, 'task'), revise: false, from: 'cli' },
    crewDir,
    briefPath,
    deps: {
      appendFileSync: (path, body) => {
        appended.push(String(path))
        if (String(path).endsWith('/journal.jsonl')) throw new Error('journal unavailable')
        fsAppendFileSync(path, body)
      },
    },
  })
  assert.equal(applied.files.join(','), 'plan.md,gate.mjs')
  assert.equal(appended.some((path) => path === briefPath), true)
  assert.equal(appended.some((path) => path.endsWith('/journal.jsonl')), true)
  assert.equal(readFileSync(join(crewDir, 'task', 'plan.md'), 'utf8'), '# Archived plan\n')
  assert.match(readFileSync(briefPath, 'utf8'), /dispatched write surface/)
})

test('a brief append failure refuses after the copied files have been prepared', () => {
  const archive = adoptionArchive('append-brief-failure')
  const crewDir = join(root, 'append-brief-failure-crew')
  const briefPath = put(join(root, 'append-brief-failure-brief.md'), '# brief\n')
  const error = thrown(() => applyAdoption({
    adoption: { lane: 'lane-a', archive, source: join(archive, 'task'), revise: false, from: 'cli' },
    crewDir,
    briefPath,
    deps: {
      appendFileSync: (path, body) => {
        if (String(path) === briefPath) throw new Error('brief append unavailable')
        fsAppendFileSync(path, body)
      },
    },
  }))
  assert.equal(error.reason, 'plan-adopt-unreadable')
  assert.match(error.message, /brief append unavailable/)
  assert.equal(fsExistsSync(join(crewDir, 'task', 'plan.md')), true)
})

test('both adoption routes copy the same archived plan and gate into the lane task dir', async () => {
  const cliArchive = adoptionArchive('route-cli', { plan: '# CLI archived plan\n', gate: '// CLI archived gate\n' })
  const requestArchive = adoptionArchive('route-request', { plan: '# request archived plan\n', gate: '// request archived gate\n' })
  const cli = await adoptionDispatchFixture({
    label: 'route-cli',
    runFlags: parseCliArgs(['--adopt', `lane-a=${cliArchive}`]),
  })
  const requestRoute = await adoptionDispatchFixture({
    label: 'route-request',
    requests: { 'lane-a': requestFor('lane-a', { adopt: requestArchive }) },
  })
  for (const [run, archive] of [[cli, cliArchive], [requestRoute, requestArchive]]) {
    const record = run.report.lanes.find(({ lane }) => lane === 'lane-a')
    assert.equal(readFileSync(join(record.crewDir, 'task', 'plan.md'), 'utf8'), readFileSync(join(archive, 'task', 'plan.md'), 'utf8'))
    assert.equal(readFileSync(join(record.crewDir, 'task', 'gate.mjs'), 'utf8'), readFileSync(join(archive, 'task', 'gate.mjs'), 'utf8'))
  }
})

test('an archive missing gate.mjs or plan.md refuses by name and copies nothing', async () => {
  for (const [missing, archive] of [
    ['gate.mjs', adoptionArchive('missing-gate', { omit: 'gate.mjs' })],
    ['plan.md', adoptionArchive('missing-plan', { omit: 'plan.md' })],
  ]) {
    const home = join(root, `adoption-missing-${missing}-${Math.random().toString(36).slice(2)}`)
    const error = await thrownAsync(() => adoptionDispatchFixture({
      label: `missing-${missing}`,
      home,
      runFlags: parseCliArgs(['--adopt', `lane-a=${archive}`]),
    }))
    assert.equal(error.reason, 'plan-adopt-unreadable')
    assert.match(error.message, new RegExp(missing.replace('.', '\\.') ))
    assert.equal(fsExistsSync(join(home, '.crew')), false)
  }
})

test('the adopted plan block names the dispatched ceiling before the scope guard runs', () => {
  const archive = adoptionArchive('ceiling')
  const briefPath = put(join(root, 'ceiling-brief.md'), '# brief\n')
  applyAdoption({
    adoption: { lane: 'lane-a', archive, source: join(archive, 'task'), revise: false, from: 'cli' },
    crewDir: join(root, 'ceiling-crew'),
    briefPath,
  })
  assert.match(readFileSync(briefPath, 'utf8'), /dispatched write surface/)
  assert.match(ADOPT_BLOCK, /files_in_scope/)
  assert.throws(() => checkPlanScope({
    lane: 'lane-a',
    declared: ['scripts/factory/dispatch-batch.mjs', 'scripts/factory/make-brief.mjs'],
    files: ['scripts/factory/dispatch-batch.mjs'],
  }), (error) => error instanceof BatchRefusal && error.reason === 'plan-scope-outside-fence')
})

test('the standing adoption block is byte-identical across two adopting lanes', async () => {
  const firstArchive = adoptionArchive('standing-first')
  const secondArchive = adoptionArchive('standing-second', { plan: '# A different plan\n' })
  const result = await adoptionDispatchFixture({
    label: 'standing-block',
    names: ['lane-a', 'lane-b'],
    requests: {
      'lane-a': requestFor('lane-a', { adopt: firstArchive }),
      'lane-b': requestFor('lane-b', { adopt: secondArchive }),
    },
  })
  const first = readFileSync(join(result.out, 'lane-a.brief.md'), 'utf8').slice(briefWithBlockOnly.length)
  const second = readFileSync(join(result.out, 'lane-b.brief.md'), 'utf8').slice(briefWithBlockOnly.length)
  assert.notEqual(first.trim(), '')
  assert.equal(first, second)
})

test('a revising plan-check adds findings while an accepted one does not', async () => {
  const reviseArchive = adoptionArchive('findings-revise', { planCheck: 'finding\n\nVERDICT: revise\n' })
  const acceptArchive = adoptionArchive('findings-accept', { planCheck: 'finding\n\nVERDICT: accept\n' })
  const revise = await adoptionDispatchFixture({
    label: 'findings-revise',
    requests: { 'lane-a': requestFor('lane-a', { adopt: reviseArchive }) },
  })
  const accept = await adoptionDispatchFixture({
    label: 'findings-accept',
    requests: { 'lane-a': requestFor('lane-a', { adopt: acceptArchive }) },
  })
  const withFindings = readFileSync(join(revise.out, 'lane-a.brief.md'), 'utf8')
  const withoutFindings = readFileSync(join(accept.out, 'lane-a.brief.md'), 'utf8')
  assert.match(withFindings, /plan-check\.md/)
  assert.doesNotMatch(withoutFindings, /plan-check\.md/)
})

test('the plan-adopted journal row carries the archive and sha256 of plan.md', async () => {
  const archive = adoptionArchive('journal', { plan: '# Journal plan\nwith bytes\n' })
  const result = await adoptionDispatchFixture({
    label: 'journal',
    runFlags: parseCliArgs(['--adopt', `lane-a=${archive}`]),
  })
  const record = result.report.lanes.find(({ lane }) => lane === 'lane-a')
  const rows = readFileSync(record.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter(({ event }) => event === 'plan-adopted')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].archive, archive)
  assert.equal(rows[0].plan_sha, createHash('sha256')
    .update(readFileSync(join(archive, 'task', 'plan.md'), 'utf8')).digest('hex'))
})

test('a batch that adopts nothing leaves the compiled brief and task dir untouched', async () => {
  const result = await adoptionDispatchFixture({ label: 'no-adoption' })
  assert.equal(readFileSync(join(result.out, 'lane-a.brief.md'), 'utf8'), briefWithBlockOnly)
  const record = result.report.lanes.find(({ lane }) => lane === 'lane-a')
  assert.equal(fsExistsSync(join(record.crewDir, 'task')), false)
})

test('a request adopt key is dispatch-only and never reaches the compiler request', async () => {
  const archive = adoptionArchive('compiler-request')
  const result = await adoptionDispatchFixture({
    label: 'compiler-request',
    requests: { 'lane-a': requestFor('lane-a', { adopt: archive }) },
  })
  const compile = result.spawned.find(({ args }) => args.includes('--out'))
  const path = compile.args[compile.args.indexOf('--request') + 1]
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')), 'adopt'), false)
})

test('an adopting resume line re-emits every --adopt value', async () => {
  const firstArchive = adoptionArchive('resume-first')
  const secondArchive = adoptionArchive('resume-second')
  const result = await adoptionDispatchFixture({
    label: 'resume-adoption',
    names: ['lane-a', 'lane-b'],
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: {
      wave: '1',
      ...parseCliArgs(['--adopt', `lane-a=${firstArchive}`, '--adopt', `lane-b=${secondArchive}`]),
    },
  })
  const deferred = result.logs.find((line) => line.includes('deferred lane=lane-b'))
  assert.ok(deferred)
  assert.equal(deferred.includes(`--adopt lane-a=${firstArchive}`), true)
  assert.equal(deferred.includes(`--adopt lane-b=${secondArchive}`), true)
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
        if ((call.args || []).includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
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
  assert.equal(result.logs.filter((line) => line === 'dispatch-batch: merge-check command=node scripts/factory/closeout.mjs merge-check lane-a lane-b').length, 1)
})

test('mergeCheckLine renders empty and multiple lane lists', () => {
  assert.equal(mergeCheckLine([]), 'dispatch-batch: merge-check command=node scripts/factory/closeout.mjs merge-check ')
  assert.equal(mergeCheckLine(['lane-a', 'lane-b']), 'dispatch-batch: merge-check command=node scripts/factory/closeout.mjs merge-check lane-a lane-b')
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
  assert.deepEqual(dry.logs.filter((line) => !line.startsWith('dispatch-batch: WARNING-SUMMARY ') && !line.startsWith('dispatch-batch: turn-budget ')), [
    JSON.stringify({ dispatch: 'dry-run', plans: dry.report.plans }),    'dispatch-batch: dry-run lane=lane-a tier=mechanical seats=none seats_from=none',
    'dispatch-batch: dry-run lane=lane-b tier=mechanical seats=none seats_from=none',
    DRY_RUN_BLIND_SPOT,
  ])
  assert.equal(dry.logs.filter((line) => !line.startsWith('dispatch-batch: WARNING-SUMMARY ') && !line.startsWith('dispatch-batch: turn-budget '))[0].startsWith('{"dispatch":"dry-run","plans":['), true)
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
  assert.equal(DISPATCH_ONLY_REQUEST_KEYS.includes('adopt'), true)
  assert.equal(DISPATCH_ONLY_REQUEST_KEYS.includes(TEST_REACH_OVERRIDE_KEY), true)
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
  const at = boot.args.indexOf('--roster') + 2
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

test('model-not-in-catalog boot refusals are classified without a retry', async () => {
  const stderr = 'crew boot refused at crew/roster.json models [model-not-in-catalog]'
  let boots = 0
  await assert.rejects(() => dispatchFixture({
    label: 'boot-model-not-in-catalog',
    names: ['lane-a'],
    spawnResult: (args) => {
      if (args.includes('boot')) { boots += 1; return { status: 1, stdout: '', stderr } }
      return { status: 0, stdout: '', stderr: '' }
    },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'seat-floor-conflict'
    && error.message.includes('[model-not-in-catalog]'))
  assert.equal(seatFloorRefusal(stderr), 'model-not-in-catalog')
  assert.equal(boots, 1)
})

test('a first boot failure tears the lane down, re-boots once, and the lane proceeds', async () => {
  let boots = 0
  const result = await dispatchFixture({
    label: 'boot-retry-proceeds',
    names: ['lane-a'],
    spawnResult: (args) => {
      if (args.includes('boot')) {
        boots += 1
        return boots === 1
          ? { status: 1, stdout: '', stderr: 'first boot failed' }
          : { status: 0, stdout: '', stderr: '' }
      }
      if (args.includes('teardown')) return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  const lifecycle = result.spawned
    .filter(({ args }) => args.includes('boot') || args.includes('teardown'))
    .map(({ args }) => args.includes('boot') ? 'boot' : 'teardown')
  assert.deepEqual(lifecycle, ['boot', 'teardown', 'boot'])
  assert.deepEqual(result.report.lanes.map(({ lane }) => lane), ['lane-a'])
})

test('the boot-retried row carries the FIRST failure\'s reason', async () => {
  let boots = 0
  const first = 'first boot stderr reason'
  const second = 'second boot stderr reason'
  const result = await dispatchFixture({
    label: 'boot-retry-row',
    names: ['lane-a'],
    spawnResult: (args) => {
      if (args.includes('boot')) {
        boots += 1
        return boots === 1
          ? { status: 1, stdout: '', stderr: first }
          : { status: 0, stdout: '', stderr: second }
      }
      if (args.includes('teardown')) {
        return {
          status: 0,
          stdout: JSON.stringify({ archived: '/tmp/archived', seats: null, seats_absent: 'headless', fingerprint: null }),
          stderr: '',
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  const rows = result.appended
    .filter(({ path }) => path.endsWith('journal.jsonl'))
    .flatMap(({ content }) => content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, 'boot-retried')
  assert.equal(rows[0].lane, 'lane-a')
  assert.equal(rows[0].attempts, 2)
  assert.match(rows[0].first_failure, new RegExp(first))
  assert.doesNotMatch(rows[0].first_failure, new RegExp(second))
})

test('a second boot failure refuses boot-failed and names both attempts', async () => {
  let boots = 0
  const first = 'first boot failed twice'
  const second = 'second boot failed twice'
  const error = await thrownAsync(() => dispatchFixture({
    label: 'boot-retry-refused',
    names: ['lane-a'],
    spawnResult: (args) => {
      if (args.includes('boot')) {
        boots += 1
        return { status: 1, stdout: '', stderr: boots === 1 ? first : second }
      }
      if (args.includes('teardown')) return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
  }))
  assert.ok(error instanceof BatchRefusal)
  assert.equal(error.reason, 'boot-failed')
  assert.equal(boots, 2)
  assert.match(error.message, new RegExp(`attempt 1: .*${first}`))
  assert.match(error.message, new RegExp(`attempt 2: .*${second}`))
})

test('teardownVerdict treats a seats: null payload at exit 0 as unproven', () => {
  const absent = teardownVerdict({
    status: 0,
    stdout: JSON.stringify({ archived: '/tmp/archived', seats: null, seats_absent: 'headless', fingerprint: null }),
    stderr: '',
  })
  assert.equal(absent.verdict, 'unproven')
  assert.equal(absent.exit, 0)
  assert.equal(absent.seats, null)
  assert.match(absent.why, /seats: null/)

  const proven = teardownVerdict({
    status: 0,
    stdout: JSON.stringify({ seats: { seats: 2, proven: 2, failed: 0 } }),
    stderr: '',
  })
  assert.equal(proven.verdict, 'proven')
  assert.deepEqual(proven.seats, { seats: 2, proven: 2, failed: 0 })
  assert.equal(proven.why, null)

  const incomplete = teardownVerdict({
    status: 0,
    stdout: JSON.stringify({ seats: { seats: 2, proven: 1, failed: 1 } }),
    stderr: '',
  })
  assert.equal(incomplete.verdict, 'unproven')
  assert.match(incomplete.why, /proved 1 of 2/)

  const failed = teardownVerdict({
    status: 1,
    stdout: JSON.stringify({ seats: { seats: 2, proven: 2, failed: 0 } }),
    stderr: 'teardown interrupted',
  })
  assert.equal(failed.verdict, 'unproven')
  assert.equal(failed.exit, 1)
  assert.match(failed.why, /exited 1/)

  const unreadable = teardownVerdict({ status: 0, stdout: 'not json', stderr: 'payload unavailable' })
  assert.equal(unreadable.verdict, 'unproven')
  assert.equal(unreadable.seats, null)
  assert.match(unreadable.why, /no readable payload/)
})

test('a boot that succeeds first time spawns no teardown and journals no boot-retried row', async () => {
  const result = await dispatchFixture({
    label: 'boot-clean',
    names: ['lane-a'],
    spawnResult: (args) => args.includes('boot')
      ? { status: 0, stdout: '', stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
  })
  assert.equal(result.spawned.filter(({ args }) => args.includes('boot')).length, 1)
  assert.equal(result.spawned.filter(({ args }) => args.includes('teardown')).length, 0)
  assert.equal(result.appended.filter(({ path, content }) => path.endsWith('journal.jsonl') && content.includes('boot-retried')).length, 0)
})

test('a ratified band-floor refusal is not retried', async () => {
  let boots = 0
  let teardowns = 0
  const error = await thrownAsync(() => dispatchFixture({
    label: 'boot-floor-no-retry',
    names: ['lane-a'],
    spawnResult: (args) => {
      if (args.includes('boot')) {
        boots += 1
        return { status: 1, stdout: '', stderr: 'crew boot refused [band-below-floor]' }
      }
      if (args.includes('teardown')) teardowns += 1
      return { status: 0, stdout: '', stderr: '' }
    },
  }))
  assert.ok(error instanceof BatchRefusal)
  assert.equal(error.reason, 'seat-floor-conflict')
  assert.equal(boots, 1)
  assert.equal(teardowns, 0)
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
    batchTier: 'build',
    runFlags: {
      assurance: 'standard',
      'agent-planner': 'claude', 'model-planner': 'raw-model', 'allow-shortfall-planner': 'subagents',
      'max-turns-planner': '70', 'max-turns-tech-lead': '71', 'max-turns-builder': '72',
      'max-turns-reviewer': '73', 'max-turns-lead': '74',
    },
  })
  const deferred = result.logs.find((line) => line.includes('deferred lane=lane-b'))
  assert.ok(deferred)
  assert.match(deferred, /--agent-planner claude/)
  assert.match(deferred, /--model-planner raw-model/)
  assert.match(deferred, /--allow-shortfall-planner subagents/)
  assert.match(deferred, /--assurance standard/)
  assert.doesNotMatch(deferred, /--tier /)
  for (const [flag, value] of Object.entries({
    'max-turns-planner': '70', 'max-turns-tech-lead': '71', 'max-turns-builder': '72',
    'max-turns-reviewer': '73', 'max-turns-lead': '74',
  })) assert.match(deferred, new RegExp(`--${flag} ${value}`))
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

// --- citation carriers (b388-mutanchor) ------------------------------------------
//
// b388 held all four anchors.json manifests in its fence and none of the docs whose
// path:line citations named the lines it moved. Its plan was approved, its build
// finished, and the scope gate ended the lane with no seat able to widen
// files_in_scope. These tests pin the derivation that names those docs.

function carrierCheckout(name, { doc = 'skills/one/references/notes.md', citation = 'crew/drive.mjs:2' } = {}) {
  const checkout = join(root, name)
  put(join(checkout, 'crew', 'drive.mjs'), 'line one\nexport const TWO = 2\n')
  put(join(checkout, 'skills', 'one', 'anchors.json'), JSON.stringify({ 'crew/drive.mjs:2': 'export const TWO = 2' }))
  put(join(checkout, ...doc.split('/')), `The driver declares it (\`${citation}\`).\n`)
  return checkout
}

// Mutation killed: drop the doc scan (return an empty byFile) and this finds nothing, which
// is the b388 shape exactly — the manifest is fenced, the doc that cites it is not.
test('citationCarriers names the doc that cites a line the lane moves', () => {
  const checkout = carrierCheckout('carrier-basic')
  const pins = collectAnchorPins({ checkout })
  const carriers = citationCarriers({ checkout, pins })
  assert.deepEqual([...carriers.byFile.keys()], ['crew/drive.mjs'])
  assert.deepEqual(carriers.byFile.get('crew/drive.mjs'), [{ doc: 'skills/one/references/notes.md', keys: ['crew/drive.mjs:2'] }])
  const outside = citationCarriersOutsideFence({
    surface: ['crew/drive.mjs'], fenceFiles: ['crew/drive.mjs', 'skills/one/anchors.json'], carriers,
  })
  assert.deepEqual(outside, [{ doc: 'skills/one/references/notes.md', file: 'crew/drive.mjs', keys: ['crew/drive.mjs:2'] }])
})

// Mutation killed: fence the carrier doc and the row must disappear. Without this a check
// that always reports would be indistinguishable from one that measures.
test('a fenced citation carrier produces no row', () => {
  const checkout = carrierCheckout('carrier-fenced')
  const pins = collectAnchorPins({ checkout })
  const carriers = citationCarriers({ checkout, pins })
  assert.deepEqual(citationCarriersOutsideFence({
    surface: ['crew/drive.mjs'],
    fenceFiles: ['crew/drive.mjs', 'skills/one/anchors.json', 'skills/one/references/notes.md'],
    carriers,
  }), [])
})

// Mutation killed: a file the lane does not write must not raise a carrier row, so a lane
// whose surface misses the cited file stays silent.
test('a citation of a file outside the write surface is not a carrier row', () => {
  const checkout = carrierCheckout('carrier-off-surface')
  const pins = collectAnchorPins({ checkout })
  const carriers = citationCarriers({ checkout, pins })
  assert.deepEqual(citationCarriersOutsideFence({ surface: ['crew/other.mjs'], fenceFiles: ['crew/other.mjs'], carriers }), [])
})

// Mutation killed: drop the (?!\d) lookahead in carriesCitation and `crew/drive.mjs:2` is
// found inside `crew/drive.mjs:23`, attributing a citation to a doc that never made it.
test('a longer citation does not satisfy a shorter manifest key', () => {
  const checkout = join(root, 'carrier-prefix')
  put(join(checkout, 'crew', 'drive.mjs'), 'line one\nexport const TWO = 2\n')
  put(join(checkout, 'skills', 'one', 'anchors.json'), JSON.stringify({ 'crew/drive.mjs:2': 'export const TWO = 2' }))
  put(join(checkout, 'skills', 'one', 'references', 'notes.md'), 'It is at `crew/drive.mjs:23`, elsewhere.\n')
  const pins = collectAnchorPins({ checkout })
  const carriers = citationCarriers({ checkout, pins })
  assert.equal(carriers.byFile.size, 0)
  assert.deepEqual(carriers.docsScanned, ['skills/one/references/notes.md'])
})

// Mutation killed: the SKILL.md + references/*.md layout is anchor-pin.mjs's skillDocs
// (restated, not imported), and crew/roles keeps neither — it holds its charters directly.
// Read only one layout and crew/roles resolves to no docs and every roles citation is missed,
// which is the crew/roles/tech-lead.md half of b388's fence gap.
test('citationCarriers reads the SKILL.md layout and the flat crew/roles one', () => {
  const checkout = join(root, 'carrier-layouts')
  put(join(checkout, 'crew', 'drive.mjs'), 'line one\nexport const TWO = 2\n')
  put(join(checkout, 'skills', 'one', 'anchors.json'), JSON.stringify({ 'crew/drive.mjs:2': 'export const TWO = 2' }))
  put(join(checkout, 'skills', 'one', 'SKILL.md'), 'Cited at `crew/drive.mjs:2`.\n')
  put(join(checkout, 'crew', 'roles', 'anchors.json'), JSON.stringify({ 'crew/drive.mjs:2': 'export const TWO = 2' }))
  put(join(checkout, 'crew', 'roles', 'tech-lead.md'), 'Also cited at `crew/drive.mjs:2`.\n')
  const pins = collectAnchorPins({ checkout })
  const carriers = citationCarriers({ checkout, pins })
  assert.deepEqual(carriers.byFile.get('crew/drive.mjs').map(({ doc }) => doc),
    ['crew/roles/tech-lead.md', 'skills/one/SKILL.md'])
})

// Mutation killed: state a completeness this cannot have. escalations.md carries NO shifted
// citation — its exhibit set-compares a documented table against the escalate() producers —
// so the warning must say what it cannot find rather than implying it found everything.
test('the citation-carrier blind spot names the set-comparison case it cannot find', () => {
  assert.match(CITATION_CARRIER_BLIND_SPOT, /^BLIND SPOT: /)
  assert.match(CITATION_CARRIER_BLIND_SPOT, /skills\/crew-recovery\/references\/escalations\.md/)
  assert.match(CITATION_CARRIER_BLIND_SPOT, /no manifest pins/)
})

// Mutation killed: never push the warning (or read the carriers of a fence that already holds
// the doc) and checkFences reports nothing, which is what b388's dispatch did. The wiring is
// what the lane needed, not the derivation alone.
test('checkFences warns with the citation-carrier prefix and names the fence additions', () => {
  const checkout = join(root, 'carrier-warning-checkout')
  put(join(checkout, 'crew', 'drive.mjs'), 'line one\nexport const TWO = 2\n')
  put(join(checkout, 'skills', 'one', 'anchors.json'), JSON.stringify({ 'crew/drive.mjs:2': 'export const TWO = 2' }))
  put(join(checkout, 'skills', 'one', 'references', 'notes.md'), 'Declared at `crew/drive.mjs:2`.\n')
  const files = ['crew/drive.mjs', 'skills/one/anchors.json']
  const report = checkFences({
    fences: [entry('lane-a', files)],
    lanes: [{ lane: 'lane-a', where: files }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  const warning = report.warnings.find((row) => row.kind === 'citation-carrier')
  assert.ok(warning, 'no citation-carrier warning')
  assert.equal(warning.text.startsWith(CITATION_CARRIER_WARNING_PREFIX), true)
  assert.deepEqual(warning.docs, ['skills/one/references/notes.md'])
  assert.equal(warning.text.includes(CITATION_CARRIER_POST_MERGE), true)
  assert.equal(warning.text.includes('Fence these docs if you want them correct at merge time: skills/one/references/notes.md'), true)
  for (const retired of ['Add to this lane\'s fence', 'NOT repairable in lane', 'no seat may widen files_in_scope']) {
    assert.equal(warning.text.includes(retired), false, `retired carrier wording: ${retired}`)
  }
  assert.equal(warning.text.includes(CITATION_CARRIER_BLIND_SPOT), true)
})

// Mutation killed: warn regardless of the fence and a correctly fenced lane is told to widen a
// fence it already has — the false positive that would make the operator stop reading warnings.
test('checkFences raises no citation-carrier warning when the doc is fenced', () => {
  const checkout = join(root, 'carrier-warning-fenced-checkout')
  put(join(checkout, 'crew', 'drive.mjs'), 'line one\nexport const TWO = 2\n')
  put(join(checkout, 'skills', 'one', 'anchors.json'), JSON.stringify({ 'crew/drive.mjs:2': 'export const TWO = 2' }))
  put(join(checkout, 'skills', 'one', 'references', 'notes.md'), 'Declared at `crew/drive.mjs:2`.\n')
  const files = ['crew/drive.mjs', 'skills/one/anchors.json', 'skills/one/references/notes.md']
  const report = checkFences({
    fences: [entry('lane-a', files)],
    lanes: [{ lane: 'lane-a', where: files }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  assert.equal(report.warnings.some((row) => row.kind === 'citation-carrier'), false)
})
