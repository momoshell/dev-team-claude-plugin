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
  CENSUS_CARRIER_BLIND_SPOT,
  CENSUS_CARRIER_FILES,
  CENSUS_CARRIER_REPAIR,
  CENSUS_CARRIER_WARNING_PREFIX,
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
  batchAliasWarnings,
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
  resolveRequestedExecution,
  resolveRequestedTier,
} from '../scripts/factory/dispatch-batch.mjs'
import { parseDirectedBrief, WAITS_S } from '../crew/drive.mjs'
import { laneFenceFor, renderBrief, resolveWriteSurface } from '../scripts/factory/make-brief.mjs'
import { DRIVER_GONE_PERIODS, HEARTBEAT_PERIOD_MS } from '../scripts/factory/lane-watch.mjs'
import { scratchDir } from './helpers.mjs'

function censusFixture(name, fenceFiles, { withReport = false } = {}) {
  const checkout = namedReachFixture(`census-${name}`, {
    'test/census.test.mjs': 'const census = true\nif (!census) throw new Error("unreachable")\n',
  })
  const outDir = withReport ? join(checkout, `${name}-out`) : undefined
  return { checkout, outDir, ...reachCheck({ checkout, fenceFiles, surface: fenceFiles, outDir }) }
}

test('A1', () => {
  const fixture = censusFixture('A1', ['test/census.test.mjs'])
  assert.equal(fixture.error, null)
  const warnings = fixture.report.warnings.filter(({ kind }) => kind === 'census-carrier')
  assert.equal(warnings.length, 1)
  const [warning] = warnings
  assert.equal(warning.text.startsWith(CENSUS_CARRIER_WARNING_PREFIX), true)
  for (const carrier of CENSUS_CARRIER_FILES) assert.equal(warning.text.includes(carrier), true)
  assert.equal(warning.text.includes('WARNING, not a refusal'), true)
  // The census is derived, not stated (this change), so the warning must say no
  // repair is owed rather than ordering the operator to update a deleted constant.
  assert.equal(warning.text.includes('No repair is OWEd'), true)
  assert.equal(warning.text.includes('DERIVED from git discovery'), true)
  assert.equal(/const (measurement|pristinePairs)/.test(warning.text), false)
  for (const literal of ['batch.md', 're-measure']) assert.equal(warning.text.includes(literal), true)
})

test('B1', () => {
  const fixture = censusFixture('B1', ['test/census.test.mjs', ...CENSUS_CARRIER_FILES], { withReport: true })
  assert.equal(fixture.error, null)
  assert.equal(fixture.report.warnings.some(({ kind }) => kind === 'census-carrier'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.outDir, FENCE_REPORT_FILE), 'utf8')).lanes[0].census_carriers, [])
  const summary = fixture.logs.find((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY '))
  assert.ok(summary)
  assert.equal(summary.includes('census-carrier=0'), true)
})

test('C1', () => {
  const fixture = censusFixture('C1', ['crew/capabilities.mjs'], { withReport: true })
  assert.equal(fixture.error, null)
  assert.equal(fixture.report.warnings.some(({ kind }) => kind === 'census-carrier'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.outDir, FENCE_REPORT_FILE), 'utf8')).lanes[0].census_carriers, [])
  const summary = fixture.logs.find((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY '))
  assert.ok(summary)
  assert.equal(summary.includes('census-carrier=0'), true)
})

test('D1', () => {
  for (const [index, carrier] of CENSUS_CARRIER_FILES.entries()) {
    const fenceFiles = ['test/census.test.mjs', carrier]
    const fixture = censusFixture(`D1-${index}`, fenceFiles)
    assert.equal(fixture.error, null)
    const warnings = fixture.report.warnings.filter(({ kind }) => kind === 'census-carrier')
    assert.equal(warnings.length, 1)
    const [warning] = warnings
    const missing = CENSUS_CARRIER_FILES.filter((candidate) => candidate !== carrier)
    assert.deepEqual(warning.missing, missing)
    for (const path of CENSUS_CARRIER_FILES) assert.equal(warning.text.includes(path), true)
  }
})

test('E1', () => {
  const fixture = censusFixture('E1', ['test/census.test.mjs'], { withReport: true })
  assert.equal(fixture.error, null)
  const warning = fixture.report.warnings.find(({ kind }) => kind === 'census-carrier')
  const persisted = JSON.parse(readFileSync(join(fixture.outDir, FENCE_REPORT_FILE), 'utf8'))
  const row = persisted.lanes[0].census_carriers[0]
  assert.deepEqual(Object.keys(row).sort(), ['blind_spot', 'carriers', 'kind', 'lane', 'missing', 'repair', 'text'])
  assert.deepEqual(row, {
    kind: 'census-carrier',
    lane: 'lane-a',
    carriers: [...CENSUS_CARRIER_FILES],
    missing: [...CENSUS_CARRIER_FILES],
    repair: CENSUS_CARRIER_REPAIR,
    blind_spot: CENSUS_CARRIER_BLIND_SPOT,
    text: warning.text,
  })
  assert.equal(persisted.blind_spots['census-carrier'], CENSUS_CARRIER_BLIND_SPOT)
  const doctrine = readFileSync(join(process.cwd(), 'skills/crew-dispatch/references/batch.md'), 'utf8')
  assert.equal(doctrine.split(CENSUS_CARRIER_BLIND_SPOT).length - 1, 1)
})

test('F1', () => {
  let fixture
  assert.doesNotThrow(() => { fixture = censusFixture('F1', ['test/census.test.mjs']) })
  assert.equal(fixture.error, null)
  assert.equal(fixture.report.warnings.some(({ kind }) => kind === 'census-carrier'), true)
  assert.equal(REFUSAL_REASONS.includes('census-carrier'), false)
})

import {
  root,
  compiler,
  put,
  anchorFixtures,
  request,
  requestFor,
  makeBatch,
  entry,
  refusal,
  compilerLane,
  thrownAsync,
  gitFixture,
  reachCheck,
  reachFixture,
  crewFixture,
  liveHolderFixture,
  namedReachFixture,
  dispatchFixture,
} from './factory-dispatch-batch-fences.test.mjs'

test('D1 admits unheld census carriers', async () => {
  const fixture = censusFixture('admit-D1', ['test/census.test.mjs'], { withReport: true })
  assert.equal(fixture.error, null)
  const admissions = fixture.report.admissions.filter((row) => row.source === 'census-carrier')
  assert.deepEqual(admissions.map((row) => row.file), [...CENSUS_CARRIER_FILES].sort())
  assert.deepEqual(fixture.report.perLane['lane-a'].files.slice(-2).sort(), [...CENSUS_CARRIER_FILES].sort())
  const batch = makeBatch(['census-dry'])
  put(join(batch, `census-dry${REQUEST_SUFFIX}`), JSON.stringify(request('admit census carriers', ['test/census.test.mjs'])))
  const logs = []
  const dry = await dispatchBatch({
    batchDir: batch,
    fences: [entry('census-dry', ['test/census.test.mjs'])],
    checkout: fixture.checkout,
    parentDir: join(root, 'census-dry-parent'),
    outDir: join(root, 'census-dry-out'),
    tier: 'mechanical',
    runFlags: { 'dry-run': true },
    deps: { home: join(root, 'census-dry-home'), log: (line) => logs.push(String(line)) },
  })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.fences.admissions.filter((row) => row.source === 'census-carrier').length, 2)
  assert.equal(logs.filter((line) => line.includes('source=census-carrier')).length, 2)
})

test('RV1-1 keeps held anchor and census candidates warning-only through a stable witness', () => {
  const checkout = gitFixture()
  const source = ['src', 'owned.mjs'].join('/')
  const censusTest = ['test', 'census.test.mjs'].join('/')
  const manifest = ['skills', 'example', 'anchors.json'].join('/')
  const heldCensus = ['skills', 'crew-dispatch', 'references', 'batch.md'].join('/')
  put(join(checkout, censusTest), 'const census = true\n')
  anchorFixtures(checkout, { example: { [`${source}:1`]: 'export const OWNED = 1' } })
  const outDir = join(checkout, 'RV1-1-warning-only-out')
  const report = checkFences({
    fences: [entry('lane-a', [manifest, heldCensus]), entry('lane-b', [source, censusTest])],
    lanes: [
      { lane: 'lane-a', where: [] },
      { lane: 'lane-b', where: [source, censusTest] },
    ],
    checkout,
    outDir,
    deps: { home: join(root, 'RV1-1-warning-only-home'), log: () => {} },
  })
  const held = new Set([manifest, heldCensus])
  assert.equal(report.perLane['lane-b'].files.some((file) => held.has(file)), false)
  assert.deepEqual(report.admissions.filter(({ file }) => held.has(file)), [])
  assert.equal(report.warnings.some((row) => row.kind === 'anchor-pin' && row.lane === 'lane-b' && row.pins.some((pin) => pin.manifest === manifest)), true)
  const censusWarning = report.warnings.find((row) => row.kind === 'census-carrier' && row.lane === 'lane-b')
  assert.equal(censusWarning?.missing.includes(heldCensus), true)
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual((persisted.lanes[1].fence_admissions || []).filter(({ file }) => held.has(file)), [])
  assert.deepEqual(persisted.lanes[1].anchor_pins.map(({ manifest: path }) => path), [manifest])
  assert.equal(persisted.lanes[1].census_carriers[0].missing.includes(heldCensus), true)
})

test('B1 refuses held test reach and names its holder', () => {
  const candidate = 'crew/crew.test.mjs'
  const holder = liveHolderFixture('refuse-B1', candidate)
  const outDir = join(holder.checkout, 'refuse-B1-out')
  const logs = []
  let error
  try {
    checkFences({
      fences: [entry('lane-a', ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'])],
      lanes: [{ lane: 'lane-a', where: ['crew/adapters/adapter-pi.mjs'] }],
      checkout: holder.checkout,
      outDir,
      deps: { home: holder.home, log: (line) => logs.push(String(line)) },
    })
  } catch (caught) { error = caught }
  assert.equal(error?.reason, 'test-reach-unfenced')
  assert.ok(error.message.includes(holder.holder))
  assert.ok(error.message.includes(holder.holderDir))
  assert.ok(error.message.includes(candidate))
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.equal(Object.hasOwn(persisted.lanes[0], 'fence_admissions'), false)
  assert.equal(logs.some((line) => line.includes('source=test-reach')), false)
})

test('F1 preserves allow_test_reach for a held test', () => {
  const candidate = 'crew/crew.test.mjs'
  const holder = liveHolderFixture('override-F1', candidate)
  const outDir = join(holder.checkout, 'override-F1-out')
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/adapters/adapter-pi.mjs'], allow_test_reach: [{ file: candidate, why: 'held by a measured sibling' }] }],
    checkout: holder.checkout,
    outDir,
    deps: { home: holder.home, log: (line) => logs.push(String(line)) },
  })
  assert.equal(report.perLane['lane-a'].files.includes(candidate), false)
  const overrides = report.perLane['lane-a']
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  const rows = persisted.lanes[0].test_reach_overrides.filter((row) => row.test === candidate)
  assert.ok(rows.length > 0)
  assert.ok(rows.every((row) => row.holder.lane === holder.holder && row.holder.dir === holder.holderDir))
  assert.ok(logs.some((line) => line.startsWith('dispatch-batch: test-reach-override:') && line.includes(holder.holderDir)))
})

test('RV1-2 recognizes a live external register holder before admission', () => {
  const candidate = 'crew/host-load.test.mjs'
  const checkout = reachFixture('rv1-2-external-holder', {
    files: {
      'crew/host-load.mjs': 'export const hostLoad = true\n',
      [candidate]: [
        "import { hostLoad } from './host-load.mjs'",
        'void hostLoad',
        '',
      ].join('\n'),
    },
  })
  const home = join(root, 'rv1-2-external-home')
  const parentDir = join(root, 'rv1-2-external-parent')
  const holderDir = crewFixture({
    home,
    repoDir: 'dt-ext-lane',
    laneDir: 'ext-lane',
    checkout,
    fence: [{ lane: 'lane-x', files: ['crew/host-load.mjs'] }],
  })
  const fences = [
    entry('lane-x', ['crew/host-load.mjs']),
    entry('ext-lane', [candidate]),
  ]
  let held
  try {
    checkFences({
      fences,
      lanes: [{ lane: 'lane-x', where: ['crew/host-load.mjs'] }],
      checkout,
      externals: ['ext-lane'],
      parentDir,
      deps: { home, log: () => {} },
    })
  } catch (caught) { held = caught }
  assert.equal(held?.reason, 'test-reach-unfenced')
  assert.ok(held.message.includes('ext-lane'))
  assert.ok(held.message.includes(holderDir))
  assert.equal(held.message.includes('own fence overlaps'), false)

  const report = checkFences({
    fences,
    lanes: [{
      lane: 'lane-x',
      where: ['crew/host-load.mjs'],
      allow_test_reach: [{ file: candidate, why: 'held by the live external lane' }],
    }],
    checkout,
    externals: ['ext-lane'],
    parentDir,
    deps: { home, log: () => {} },
  })
  assert.equal(report.perLane['lane-x'].files.includes(candidate), false)
  const overrides = report.warnings.find((row) => row.kind === 'test-reach-override')?.rows.filter((row) => row.test === candidate) || []
  assert.ok(overrides.length > 0)
  assert.ok(overrides.every((row) => row.holder.lane === 'ext-lane' && row.holder.dir === holderDir))
})

test('a trailing-slash directory write surface admits the same unheld reaching test', () => {
  const checkout = namedReachFixture('refuse-directory')
  const result = reachCheck({
    checkout,
    fenceFiles: ['crew/adapters/'],
    surface: ['crew/adapters/'],
  })
  assert.equal(result.error, null)
  assert.ok(result.report.admissions.some((row) => row.source === 'test-reach' && row.file === 'crew/crew.test.mjs'))
  assert.equal(result.report.perLane['lane-a'].files.includes('crew/crew.test.mjs'), true)
})

test('register-superset remains after unheld test-reach admission', () => {
  const checkout = namedReachFixture('precedence')
  const result = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
    extraFences: [entry('lane-ghost', ['docs/ghost.md'])],
  })
  assert.ok(result.error instanceof BatchRefusal)
  assert.equal(result.error.reason, 'fence-register-mismatch')
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

test('XC1', () => {
  const batch = makeBatch(['lane-a'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { execution: 'full', variant: 'scout' })))
  assert.throws(() => readBatch({ batchDir: batch }), (error) => error instanceof BatchRefusal
    && error.reason === 'transport-conflict'
    && error.message.includes('--execution')
    && error.message.includes('--variant'))
})

test('AC1', () => {
  const batch = makeBatch(['lane-a'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { assurance: 'standard', tier: 'mechanical' })))
  assert.throws(() => readBatch({ batchDir: batch }), (error) => error instanceof BatchRefusal
    && error.reason === 'transport-conflict'
    && error.message.includes('--assurance')
    && error.message.includes('--tier'))
})

test('lane variants are preflighted by name and ctx lanes require validation', async () => {
  await assert.rejects(() => dispatchFixture({
    label: 'lane-unknown-variant',
    requests: { 'lane-b': requestFor('lane-b', { variant: 'not-a-variant' }) },
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'batch-unreadable'
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
  assert.equal(run.args[run.args.indexOf('--execution') + 1], 'repair')
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

test('--panes dispatch refuses when boot returns a null workspace_id', async () => {
  await assert.rejects(() => dispatchFixture({
    label: 'panes-null-workspace',
    runFlags: { panes: true },
    workspaceFor: () => null,
  }), (err) => err instanceof BatchRefusal
    && err.reason === 'boot-failed'
    && err.message.includes('crew.json workspace_id is null'))
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
