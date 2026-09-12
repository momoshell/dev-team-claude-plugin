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
  FENCE_ADMISSION_EVENT,
  FENCE_ADMISSION_SOURCES,
  fenceAdmission,
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
  historicalIssueBindings,
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
  relatedLanes,
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
import { laneFenceHits, parseDirectedBrief, WAITS_S } from '../crew/drive.mjs'
import { partitionShifts } from '../skills/qa-test-writing/anchor-pin.mjs'
import { laneFenceFor, renderBrief, resolveWriteSurface } from '../scripts/factory/make-brief.mjs'
import { DRIVER_GONE_PERIODS, HEARTBEAT_PERIOD_MS } from '../scripts/factory/lane-watch.mjs'
import { scratchDir } from './helpers.mjs'

test('E1 journals sourced admissions and refuses an unsourced admission', async () => {
  for (const source of [undefined, 'unknown']) {
    assert.throws(() => fenceAdmission({ lane: 'lane-a', file: './src/owned.mjs', source }), (error) => error instanceof BatchRefusal && error.reason === 'fence-admission-unsourced')
  }
  assert.equal(REFUSAL_REASONS.includes('fence-admission-unsourced'), true)
  assert.deepEqual(FENCE_ADMISSION_SOURCES, ['test-reach', 'anchor-pin', 'census-carrier'])
  for (const source of FENCE_ADMISSION_SOURCES) {
    const row = fenceAdmission({ lane: 'lane-a', file: './src/owned.mjs', source })
    assert.deepEqual(row, { lane: 'lane-a', file: 'src/owned.mjs', source })
  }
  const reachCheckout = reachFixture('source-e1')
  const reach = checkFences({
    fences: [entry('lane-a', ['lib/widget.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['lib/widget.mjs'] }],
    checkout: reachCheckout,
    outDir: join(reachCheckout, 'out'),
    deps: { home: join(root, 'source-e1-home'), log: () => {} },
  })
  assert.ok(reach.admissions.some((row) => row.source === 'test-reach'))
  const anchorCheckout = gitFixture()
  anchorFixtures(anchorCheckout, { example: { 'src/owned.mjs:1': 'export const OWNED = 1' } })
  const anchor = checkFences({
    fences: [entry('lane-a', ['src/owned.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['src/owned.mjs'] }],
    checkout: anchorCheckout,
    outDir: join(anchorCheckout, 'out'),
    deps: { home: join(root, 'source-e1-anchor-home'), log: () => {} },
  })
  assert.ok(anchor.admissions.some((row) => row.source === 'anchor-pin'))
  const censusCheckout = namedReachFixture('source-e1-census', { 'test/census.test.mjs': 'const census = true\n' })
  const census = checkFences({
    fences: [entry('lane-a', ['test/census.test.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['test/census.test.mjs'] }],
    checkout: censusCheckout,
    outDir: join(censusCheckout, 'out'),
    deps: { home: join(root, 'source-e1-census-home'), log: () => {} },
  })
  assert.equal(census.admissions.filter((row) => row.source === 'census-carrier').length, CENSUS_CARRIER_FILES.length)

  const dispatchCheckout = root
  const dispatchFile = 'lib/e1-widget.mjs'
  const dispatchTest = 'test/e1-admission.test.mjs'
  put(join(dispatchCheckout, dispatchFile), 'export const e1Widget = true\n')
  put(join(dispatchCheckout, dispatchTest), `import { e1Widget } from '../${dispatchFile}'\nif (!e1Widget) throw new Error('e1')\n`)
  const journalResult = await dispatchFixture({
    label: 'source-e1-journal',
    names: ['lane-a'],
    requests: { 'lane-a': request('journal sourced admissions', [dispatchFile]) },
    fences: [entry('lane-a', [dispatchFile])],
    existsProbe: (path) => fsExistsSync(path) || String(path).endsWith('/journal.jsonl'),
    spawnResult: (args) => {
      if (args.includes('ls-files')) return { status: 0, stdout: `${dispatchFile}\0${dispatchTest}\0`, stderr: '' }
      const outIndex = args.indexOf('--out')
      if (outIndex >= 0) put(args[outIndex + 1], '```proposal\n{"shape":"build","strength":null}\n```\n')
      return { status: 0, stdout: '', stderr: '' }
    },
    writeFile: (path, content) => put(path, content),
  })
  const journalRows = journalResult.appended
    .flatMap(({ content }) => String(content).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .filter((row) => row.event === FENCE_ADMISSION_EVENT)
  assert.ok(journalRows.length > 0)
  assert.ok(journalRows.every((row) => FENCE_ADMISSION_SOURCES.includes(row.source)))
  assert.ok(journalResult.logs.some((line) => line.includes(FENCE_ADMISSION_EVENT) && line.includes('source=test-reach')))
})

test('G1 preserves every scan blind spot byte-identically', () => {
  const expected = { anchor: ANCHOR_BLIND_SPOT, test: TEST_REACH_BLIND_SPOT, census: CENSUS_CARRIER_BLIND_SPOT }
  assert.deepEqual({ anchor: ANCHOR_BLIND_SPOT, test: TEST_REACH_BLIND_SPOT, census: CENSUS_CARRIER_BLIND_SPOT }, expected)
  const admittedCheckout = namedReachFixture('blind-admitted', { 'test/census.test.mjs': 'const census = true\n' })
  const admitted = checkFences({
    fences: [entry('lane-a', ['test/census.test.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['test/census.test.mjs'] }],
    checkout: admittedCheckout,
    outDir: join(admittedCheckout, 'out'),
    deps: { home: join(root, 'blind-admitted-home'), log: () => {} },
  })
  assert.ok(admitted.warnings.find(({ kind }) => kind === 'census-carrier').text.endsWith(CENSUS_CARRIER_BLIND_SPOT))
  const admittedPersisted = JSON.parse(readFileSync(join(admittedCheckout, 'out', FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(admittedPersisted.blind_spots['anchor-pin'], ANCHOR_BLIND_SPOT)
  assert.deepEqual(admittedPersisted.blind_spots['test-reach'], TEST_REACH_BLIND_SPOT)
  assert.deepEqual(admittedPersisted.blind_spots['census-carrier'], CENSUS_CARRIER_BLIND_SPOT)
  const held = liveHolderFixture('blind-held', CENSUS_CARRIER_FILES[0])
  const heldOut = join(held.checkout, 'out')
  const heldReport = checkFences({
    fences: [entry('lane-a', ['test/census.test.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['test/census.test.mjs'] }],
    checkout: held.checkout,
    outDir: heldOut,
    deps: { home: held.home, log: () => {} },
  })
  assert.equal(heldReport.perLane['lane-a'].files.includes(CENSUS_CARRIER_FILES[0]), false)
  assert.equal(heldReport.admissions.some((row) => row.file === CENSUS_CARRIER_FILES[0]), false)
  const heldWarning = heldReport.warnings.find(({ kind }) => kind === 'census-carrier')
  assert.equal(heldWarning?.missing.includes(CENSUS_CARRIER_FILES[0]), true)
  const heldPersisted = JSON.parse(readFileSync(join(heldOut, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(heldPersisted.blind_spots, admittedPersisted.blind_spots)
  assert.equal(heldPersisted.lanes[0].fence_admissions.some((row) => row.file === CENSUS_CARRIER_FILES[0]), false)
})

// B1 fixture literal retained for static carrier coverage: readFileSync('/tmp/crew-task/planner.md', 'utf8')
import {
  root,
  repoRoot,
  compiler,
  put,
  anchorFixtures,
  request,
  requestFor,
  makeBatch,
  briefWithTierAndShape,
  briefWithBlockOnly,
  directedBrief,
  briefWithQuotedTier,
  staffingBrief,
  entry,
  refusal,
  compilerLane,
  refusalAsync,
  thrown,
  thrownAsync,
  gitFixture,
  reachFixture,
  twoOwnerReachFixture,
  crewFixture,
  liveHolderFixture,
  collisionFixture,
  fixtureTests,
  reachReport,
  reachCheck,
  summaryFixture,
  summaryDeps,
  summaryLines,
  reportRowCount,
  namedReachFixture,
  warningFixture,
  fakedDispatch,
  dispatchFixture,
  turnCensusRow,
  adoptionArchive,
  adoptionDispatchFixture,
  cachePath,
  directBaseline,
  compileBriefProposal,
  carrierCheckout,
} from './factory-dispatch-batch-fences.test.mjs'

async function admittedAnchorAssuranceFixture(label, { laneAssurance = null, batchAssurance = null } = {}) {
  const adapter = 'crew/adapters/adapter-pi.mjs'
  const checkout = reachFixture(`rv1-3-${label}`, {
    files: {
      [adapter]: 'export const adapter = true\n',
      'crew/roles/anchors.json': JSON.stringify({ 'crew/adapters/adapter-pi.mjs:1': 'export const adapter = true' }),
    },
  })
  const laneRequest = request('keep the authored adapter assurance floor', [adapter])
  if (laneAssurance) laneRequest.assurance = laneAssurance
  return dispatchFixture({
    label: `rv1-3-${label}`,
    names: ['lane-a'],
    requests: { 'lane-a': laneRequest },
    fences: [entry('lane-a', [adapter])],
    checkout,
    readdir: fsReaddirSync,
    existsProbe: fsExistsSync,
    home: join(root, `rv1-3-${label}-home`),
    batchTier: batchAssurance ? null : 'mechanical',
    runFlags: batchAssurance ? { assurance: batchAssurance } : {},
  })
}

function dispatchRecordFor(fixture, lane = 'lane-a') {
  const path = join(fixture.out, `${lane}${DISPATCH_RECORD_SUFFIX}`)
  assert.ok(fsExistsSync(path))
  return JSON.parse(readFileSync(path, 'utf8'))
}

function siblingIncidentRegister() {
  const lanes = [
    { lane: 'b386-briefpack', where: ['skills/crew-recovery/anchors.json'], depends_on: [] },
    { lane: 'b391-prreviewtruth', where: ['skills/pr-review/SKILL.md', 'skills/pr-review/anchors.json'], depends_on: [] },
    { lane: 'b387-turneconomy', where: ['skills/pr-review/SKILL.md', 'skills/pr-review/anchors.json', 'skills/crew-recovery/anchors.json'], depends_on: ['b386-briefpack', 'b391-prreviewtruth'] },
  ]
  return {
    lanes,
    fences: [
      entry('b386-briefpack', ['skills/crew-recovery/anchors.json']),
      entry('b391-prreviewtruth', ['skills/pr-review/SKILL.md', 'skills/pr-review/anchors.json']),
      entry('b387-turneconomy', ['skills/pr-review/SKILL.md', 'skills/pr-review/anchors.json', 'skills/crew-recovery/anchors.json']),
    ],
  }
}

test('RV1-3 keeps sourced admissions out of assurance floors', async () => {
  const adapter = 'crew/adapters/adapter-pi.mjs'
  const admitted = 'crew/roles/anchors.json'
  const perLane = await admittedAnchorAssuranceFixture('lane', { laneAssurance: 'quick' })
  assert.deepEqual(perLane.report.fences.authoredPerLane['lane-a'].files, [adapter])
  assert.ok(perLane.report.fences.perLane['lane-a'].files.includes(admitted))
  assert.equal(promptSurfaceVerdict({ files: perLane.report.fences.perLane['lane-a'].files }).forced, 'judge')
  const perLaneRecord = dispatchRecordFor(perLane)
  assert.deepEqual(perLaneRecord.prompt_surface, { hits: [], prompt_change: false, forced: null })
  assert.equal(perLaneRecord.tier.settled, 'mechanical')

  const batch = await admittedAnchorAssuranceFixture('batch', { batchAssurance: 'quick' })
  const batchRecord = dispatchRecordFor(batch)
  assert.deepEqual(batchRecord.prompt_surface, { hits: [], prompt_change: false, forced: null })
  assert.equal(batchRecord.tier.requested, 'mechanical')
  assert.equal(batchRecord.tier.settled, 'mechanical')
})

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

test('J1 proves admission report behavior without presence-only assertions', () => {
  const checkout = namedReachFixture('J1')
  const outDir = join(checkout, 'j1-out')
  const result = checkFences({
    fences: [entry('lane-a', ['crew/adapters/adapter-pi.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/adapters/adapter-pi.mjs'] }],
    checkout,
    outDir,
    deps: { home: join(root, 'J1-home'), log: () => {} },
  })
  const admission = result.admissions.find((row) => row.file === 'crew/crew.test.mjs' && row.source === 'test-reach')
  assert.deepEqual(admission, { lane: 'lane-a', file: 'crew/crew.test.mjs', source: 'test-reach' })
  assert.equal(result.perLane['lane-a'].files.includes(admission.file), true)
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(persisted.lanes[0].fence_admissions.find((row) => row.file === admission.file && row.source === admission.source), admission)
})

test('N1a keeps an explicit unheld allow_test_reach file outside the fence', async () => {
  const checkout = namedReachFixture('N1a')
  const excluded = 'crew/crew.test.mjs'
  const why = 'covered by the higher-level integration lane'
  const result = await dispatchFixture({
    label: 'N1a-exclusion',
    names: ['lane-a'],
    checkout,
    requests: {
      'lane-a': { ...request('exclude one unheld reaching test', ['crew/adapters/adapter-pi.mjs']), allow_test_reach: [{ file: excluded, why }] },
    },
    fences: [entry('lane-a', ['crew/adapters/adapter-pi.mjs'])],
    existsProbe: fsExistsSync,
    spawnResult: (args) => args.includes('ls-files')
      ? spawnSync('git', ['-C', checkout, 'ls-files', '-z'], { encoding: 'utf8' })
      : { status: 0, stdout: '', stderr: '' },
  })
  assert.equal(result.report.lanes.length, 1)
  const fence = result.report.fences.perLane['lane-a']
  assert.equal(fence.files.includes(excluded), false)
  assert.equal(result.report.fences.admissions.some((row) => row.file === excluded), false)
  const persisted = JSON.parse(result.wrote.get(join(result.out, FENCE_REPORT_FILE)))
  assert.equal(Boolean(persisted.lanes[0].fence_admissions?.some((row) => row.file === excluded)), false)
  assert.ok(persisted.lanes[0].test_reach_overrides.some((row) => row.test === excluded && row.why === why && row.admission_override === true))
})

test('N1b warns that allow_test_reach overrode automatic admission', async () => {
  const checkout = namedReachFixture('N1b')
  const excluded = 'crew/crew.test.mjs'
  const why = 'covered by the higher-level integration lane'
  const result = await dispatchFixture({
    label: 'N1b-exclusion',
    names: ['lane-a'],
    checkout,
    requests: {
      'lane-a': { ...request('exclude one unheld reaching test', ['crew/adapters/adapter-pi.mjs']), allow_test_reach: [{ file: excluded, why }] },
    },
    fences: [entry('lane-a', ['crew/adapters/adapter-pi.mjs'])],
    existsProbe: fsExistsSync,
    spawnResult: (args) => args.includes('ls-files')
      ? spawnSync('git', ['-C', checkout, 'ls-files', '-z'], { encoding: 'utf8' })
      : { status: 0, stdout: '', stderr: '' },
  })
  const warning = result.report.fences.warnings.find(({ kind }) => kind === 'test-reach-override')
  assert.ok(warning)
  assert.match(warning.text, new RegExp(`${why}.*${excluded.replaceAll('.', '\\.')}`))
  assert.match(warning.text, /override=explicit-exclusion/)
  assert.match(warning.text, /operator exclusion overrode automatic admission/)
  const persisted = JSON.parse(result.wrote.get(join(result.out, FENCE_REPORT_FILE)))
  assert.match(persisted.lanes[0].test_reach_overrides.find((row) => row.test === excluded).why, /higher-level integration/)
})

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

test('L1 pins direct and two-hop reach row contents', () => {
  const checkout = namedReachFixture('B1', {
    'crew/reader.mjs': "import { grantsFor } from './adapters/adapter-pi.mjs'\nexport const readerValue = grantsFor()\n",
    'test/twohop.test.mjs': "import { readerValue } from '../crew/reader.mjs'\nif (!readerValue) throw new Error('x')\n",
  })
  const outDir = join(checkout, 'b1-out')
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/adapters/adapter-pi.mjs'] }],
    checkout,
    outDir,
    deps: { home: join(root, 'b1-home'), log: (line) => logs.push(String(line)) },
  })
  assert.ok(report.admissions.some((row) => row.source === 'test-reach' && row.file === 'crew/crew.test.mjs'))
  assert.ok(report.perLane['lane-a'].files.includes('crew/crew.test.mjs'))
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  const expectedRows = testsOutsideFence({
    surface: ['crew/adapters/adapter-pi.mjs'],
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    reach: collectTestReach({ checkout }),
  })
  assert.deepEqual(expectedRows, [
    { test: 'crew/crew.test.mjs', file: 'crew/adapters/adapter-pi.mjs', hops: null, how: 'path', symbols: [] },
    { test: 'test/twohop.test.mjs', file: 'crew/adapters/adapter-pi.mjs', hops: 2, how: 'import', symbols: [] },
    { test: 'crew/crew.test.mjs', file: 'crew/adapters/adapter-pi.mjs', hops: 1, how: 'import', symbols: ['assertGrantsBacked', 'grantsFor', 'loadCapabilities'] },
  ])
  assert.deepEqual(persisted.lanes[0].test_reach, expectedRows)
  assert.ok(logs.some((line) => line.includes('source=test-reach')))
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
    'census-carrier': CENSUS_CARRIER_BLIND_SPOT,
    'cross-batch-unknown': 'BLIND SPOT: a lane booted without --fences declares no surface at all and can be editing anything; a lane whose batch siblings have been reaped records no claim; and a repository whose git dir cannot be measured is not compared. None of those are cleared — they are reported unknown.',
  }
  assert.deepEqual(report.blind_spots, expected)
  const text = readFileSync(join(repoRoot, 'skills/crew-dispatch/references/batch.md'), 'utf8')
  for (const statement of Object.values(expected)) assert.equal(text.split(statement).length - 1, 1)
  assert.ok(summaryLines(logs).every((line) => line.includes('doctrine=skills/crew-dispatch/references/batch.md')))
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
  assert.equal(rejected.error, null)
  assert.ok(rejected.report.admissions.some((row) => row.source === 'test-reach' && row.file === testFile))

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
  assert.equal(admitted.report.admissions.some((row) => row.file === testFile && row.source === 'test-reach'), false)
  const override = admitted.logs.find((line) => line.startsWith(TEST_REACH_OVERRIDE_PREFIX))
  assert.match(override || '', new RegExp(`${testFile.replaceAll('.', '\\.')}`))
  assert.match(override || '', /override=explicit-exclusion/)

  const source = readFileSync(join(repoRoot, 'scripts', 'factory', 'dispatch-batch.mjs'), 'utf8')
  assert.ok(source.includes("Every `how === 'path'` row is a\n// `test-reach` admission candidate."))
  assert.ok(source.includes("a test's own relative import specifier for a fenced file emits"))
  assert.equal(source.includes('Every other row stays a warning.'), false)
  assert.ok(source.includes('Every other import/symbol row\n// stays a warning.'))

  const doctrine = readFileSync(join(repoRoot, 'skills', 'crew-dispatch', 'references', 'batch.md'), 'utf8')
  assert.ok(doctrine.includes('a test whose own relative import specifier names a fenced file now yields a `path` row'))
  assert.ok(doctrine.includes('Compile `allow_test_reach` only for a held test named by the CURRENT `dispatch-batch` run'))
  for (const sentence of [
    "A reviewer's table can compare how many refused tests each fenced surface names",
    'Treat such comparisons as run-specific diagnostics rather than a durable baseline.',
    'A historical pre-split record is superseded by the post-split rows',
  ]) assert.ok(doctrine.includes(sentence), `doctrine omitted ${sentence}`)
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
  const result = checkFences({
    fences: [entry('lane-a', [ownerA, ownerB])],
    lanes: [{ lane: 'lane-a', where: [ownerA, ownerB] }],
    checkout,
    outDir,
    deps: { home: root, log: (line) => logs.push(String(line)) },
  })
  assert.ok(result.admissions.some((row) => row.source === 'test-reach'))
  assert.ok(logs.some((line) => line.includes('test-reach=2 · actionable=0 · collapsed=1')))
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

test('RV2-1 doctrine describes qualitative comment-apostrophe scanner exposure', () => {
  const text = readFileSync(join(repoRoot, 'skills/crew-dispatch/references/batch.md'), 'utf8')
  const start = text.indexOf('The comment-desynchronisation exposure')
  const end = text.indexOf('\nThe **cross-batch-unknown** warning carries', start)
  assert.ok(start >= 0)
  assert.ok(end > start)
  const exposure = text.slice(start, end)
  assert.ok(exposure.includes('apostrophe inside a test comment can hide path literals'))
  assert.doesNotMatch(exposure, /\b\d+ of \d+\b/)
  assert.doesNotMatch(exposure, /\b\d+\s*->\s*\d+\b/)
  assert.doesNotMatch(exposure, /\b\d+\s+vs\s+\d+\b/)
})

test('D1 admits direct test reach and dry-run preserves the effective fence', async () => {
  const checkout = namedReachFixture('D1')
  const direct = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.equal(direct.error, null)
  assert.ok(direct.report.admissions.some((row) => row.source === 'test-reach' && row.file === 'crew/crew.test.mjs'))
  assert.ok(direct.logs.some((line) => line.includes('source=test-reach')))
  assert.ok(direct.report.perLane['lane-a'].files.includes('crew/crew.test.mjs'))

  const batch = join(checkout, 'd1-dry-batch')
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure admitted behavior', ['crew/adapters/adapter-pi.mjs'])))
  const dryLogs = []
  const dry = await dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'])],
    checkout,
    parentDir: join(checkout, 'parents'),
    outDir: join(checkout, 'd1-dry-out'),
    runFlags: { 'dry-run': true },
    deps: summaryDeps(join(root, 'd1-home'), dryLogs),
  })
  assert.equal(dry.dryRun, true)
  assert.ok(dry.fences.admissions.some((row) => row.source === 'test-reach'))
  assert.ok(dryLogs.some((line) => line.includes('source=test-reach')))
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

test('G1', async () => {
  const result = await dispatchFixture({
    label: 'granularity',
    names: ['plain', 'span'],
    fences: [
      entry('plain', ['crew/owned-plain.mjs']),
      entry('span', ['crew/owned-span.mjs:1-1']),
    ],
  })
  const lines = result.logs.filter((line) => line.startsWith('dispatch-batch: lane='))
  assert.ok(lines.some((line) => line.includes('lane=plain') && line.includes('whole-file(crew/owned-plain.mjs)')))
  assert.ok(lines.some((line) => line.includes('lane=span') && line.includes('span(crew/owned-span.mjs:1-1)')))
})

test('RV1-1', async () => {
  const span = 'crew/owned-span.mjs:1-1'
  const path = 'crew/owned-span.mjs'
  const result = await dispatchFixture({
    label: 'span-transport',
    names: ['span'],
    fences: [entry('span', [span])],
  })
  const run = result.spawned.find(({ args }) => args.includes('crew/crew.mjs') && args.includes('--files-in-scope'))
  assert.ok(run)
  const args = run.args.map(String)
  assert.equal(args[args.indexOf('--files-in-scope') + 1], path)

  const expected = 'files_in_scope (expected write surface; basis: fence register, lane "span"): crew/owned-span.mjs'
  const gathered = {
    request: request('transport a span fence without passing its coordinates to crew', [path]),
    where: [],
    discovery: { candidates: [path], tripwires: [], broadKeys: [] },
    writeSurface: resolveWriteSurface({ fences: [entry('span', [span])], lane: 'span' }),
  }
  for (const pack of [null, { counts: { readAndKeepGreen: 0 }, conventions: 'span.conventions.md' }]) {
    const brief = renderBrief({ ...gathered, ...(pack === null ? {} : { pack }) })
    assert.ok(brief.includes(expected))
    assert.equal(brief.includes(`${expected}:1-1`), false)
  }
})

// #881 review: overlap is symmetric, `fenceEntryIntersects` was not. Only the candidate was
// tested as the containing directory, so a lane owning a DIRECTORY did not intersect a
// sibling owning a FILE inside it. Externals are never iterated as `own`, so against an
// external sibling that orientation was the only one that could fire — a batch lane could
// dispatch onto a file a live external register already owned.
// #881 review: overlap is symmetric, `fenceEntryIntersects` was not — only the CANDIDATE
// was tested as the containing directory. Between two batch lanes this never showed,
// because both are iterated as `own` so the file-vs-directory orientation fires anyway.
// An EXTERNAL is never iterated as `own`, so for a live external sibling the missing
// orientation was the ONLY one that could fire: a batch lane owning a directory could
// dispatch straight over a file a live external register already held.
test('RV1-3 a batch lane owning a directory leaks against a live EXTERNAL owning a file in it', () => {
  const checkout = gitFixture()
  const home = join(root, 'symmetric-external-home')
  const parentDir = join(root, 'symmetric-external-parent')
  crewFixture({ home, repoDir: 'dt-external-live', laneDir: 'external-live', lane: 'external-live', checkout })
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['scripts/factory/']), entry('external-live', ['scripts/factory/make-brief.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['scripts/factory/'] }],
    checkout,
    externals: ['external-live'],
    parentDir,
    deps: { home, log: () => {} },
  }))
  assert.equal(error.reason, 'sibling-leak')
  for (const token of ['lane-a', 'external-live', 'scripts/factory/']) {
    assert.ok(error.message.includes(token), `RV1-3 omitted ${token}`)
  }
})

test('RV1-2', () => {
  const checkout = gitFixture()
  const directory = 'scripts/factory/'
  const span = 'scripts/factory/make-brief.mjs:1-100'
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', [directory]), entry('lane-b', [span])],
    lanes: [
      { lane: 'lane-a', where: [directory] },
      { lane: 'lane-b', where: ['scripts/factory/make-brief.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'directory-span-home'), log: () => {} },
  }))
  assert.equal(error.reason, 'sibling-leak')
  for (const token of ['lane-a', 'lane-b', directory, span]) assert.ok(error.message.includes(token), `RV1-2 omitted ${token}`)

  assert.deepEqual(crossBatchCollisions({
    entries: [entry('lane-c', [span])],
    live: [{ lane: 'live-directory', dir: '/tmp/live-directory', files: [directory] }],
  }), [{
    lane: 'lane-c', live: 'live-directory', dir: '/tmp/live-directory', files: [span],
  }])
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

test('checkFences admits a one-hop import naming the write surface when unheld', () => {
  const checkout = namedReachFixture('refuse-one-hop')
  const result = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.equal(result.error, null)
  assert.equal(REFUSAL_REASONS.includes('test-reach-unfenced'), true)
  assert.ok(result.report.admissions.some((row) => row.source === 'test-reach' && row.file === 'crew/crew.test.mjs'))
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

test('an admitted row stays visible in the warning before its fence is widened', () => {
  const only = namedReachFixture('warn-suppressed')
  const onlyRun = reachCheck({
    checkout: only,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.equal(onlyRun.error, null)
  assert.equal(onlyRun.logs.some((line) => line.startsWith('dispatch-batch: fence-admitted') && line.includes('source=test-reach')), true)

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
  assert.equal(mixedRun.error, null)
  const warningText = mixedRun.logs.find((line) => line.startsWith('dispatch-batch: WARNING-SUMMARY '))
  assert.ok(warningText)
  assert.match(warningText, /test-reach=3 · actionable=0 · collapsed=4/)
  assert.equal(warningText.includes('test/twohop.test.mjs'), false)
  assert.equal(warningText.includes('crew/crew.test.mjs'), false)
  assert.ok(mixedRun.report.admissions.some((row) => row.source === 'test-reach'))
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(persisted.lanes[0].test_reach.map((row) => row.test).sort(), ['crew/crew.test.mjs', 'crew/crew.test.mjs', 'test/twohop.test.mjs'])
})

test('allow_test_reach excludes an unheld test and records the automatic-admission override', () => {
  const checkout = namedReachFixture('override')
  const refused = reachCheck({
    checkout,
    fenceFiles: ['crew/capabilities.mjs', 'crew/adapters/adapter-pi.mjs'],
    surface: ['crew/adapters/adapter-pi.mjs'],
  })
  assert.equal(refused.error, null)
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
  assert.match(line || '', /crew\/crew\.test\.mjs/)
  assert.match(line || '', /the test is covered by a higher-level fixture/)
  assert.match(line || '', /override=explicit-exclusion/)
  const warning = admitted.report.warnings.find((row) => row.kind === 'test-reach-override')
  assert.ok(warning)
  assert.equal(warning.rows.every((row) => row.admission_override === true && row.holder === null), true)
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.equal(Boolean(persisted.lanes[0].fence_admissions?.some((row) => row.file === 'crew/crew.test.mjs' && row.source === 'test-reach')), false)
  assert.ok(persisted.lanes[0].test_reach_overrides.some((row) => row.test === 'crew/crew.test.mjs' && row.admission_override === true))
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
      'census-carrier': CENSUS_CARRIER_BLIND_SPOT,
      'cross-batch-unknown': CROSS_BATCH_BLIND_SPOT,
    },
    cross_batch_unknown: [],
    lanes: [{ lane: 'lane-a', test_reach: [], test_reach_dropped: [], citation_carriers: [], anchor_pins: [], census_carriers: [] }],
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

test('checkFences refuses an overlap across its declared edge', () => {
  const fences = [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])]
  const edge = [
    { lane: 'lane-a', where: ['crew/shared.mjs'], depends_on: [] },
    { lane: 'lane-b', where: ['crew/shared.mjs'], depends_on: ['lane-a'] },
  ]
  const { graph } = planWaves({ lanes: edge })
  refusal(() => checkFences({ fences, lanes: edge, graph }), 'sibling-leak')
  refusal(() => checkFences({ fences, lanes: edge.map((lane) => ({ ...lane, depends_on: [] })) }), 'sibling-leak')
  const unrelated = [
    { lane: 'lane-a', where: ['crew/owned-a.mjs'], depends_on: [] },
    { lane: 'lane-b', where: ['crew/owned-b.mjs'], depends_on: [] },
    { lane: 'lane-c', where: ['crew/owned-a.mjs'], depends_on: [] },
  ]
  const unrelatedFences = unrelated.map(({ lane, where }) => entry(lane, where))
  const unrelatedGraph = planWaves({ lanes: unrelated }).graph
  refusal(() => checkFences({ fences: unrelatedFences, lanes: unrelated, graph: unrelatedGraph }), 'sibling-leak')
})

test('sibling leakage reports each attributed path and the single-register remedy', () => {
  const paths = ['src/one.mjs', 'src/two.mjs', 'src/three.mjs']
  const lanes = [
    { lane: 'lane-a', where: paths.slice(0, 2), depends_on: [] },
    { lane: 'lane-b', where: [paths[0], paths[2]], depends_on: ['lane-a'] },
    { lane: 'lane-c', where: paths.slice(1), depends_on: [] },
  ]
  const fences = lanes.map(({ lane, where }) => entry(lane, where))
  const graph = planWaves({ lanes }).graph
  const error = thrown(() => checkFences({ fences, lanes, graph, deps: { readdirSync: () => [], log: () => {} } }))
  assert.equal(error.reason, 'sibling-leak')
  for (const path of paths) assert.equal(error.message.includes(path), true, path)
  assert.match(error.message, /dispatch each lane as its own single-lane register/)
  assert.match(error.message, /sequencing shared-file work requires separate registers, not narrower fences/)
})

test('a related created path is refused independently of dependency ordering', () => {
  const lanes = [
    { lane: 'lane-a', where: [], creates: ['./skills/one/references/new.md'], depends_on: [] },
    { lane: 'lane-b', where: [], depends_on: ['lane-a'] },
  ]
  const graph = planWaves({ lanes }).graph
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['skills/one/']), entry('lane-b', ['skills/one/references/new.md'])],
    lanes,
    graph,
    deps: { readdirSync: () => [], log: () => {} },
  }))
  assert.equal(error.reason, 'sibling-leak')
  assert.match(error.message, /skills\/one\/references\/new\.md/)
})

test('an unrelated directory fence still catches a created path through leakedCreates', () => {
  const lanes = [
    { lane: 'lane-a', where: [], creates: ['./skills/one/references/new.md'], depends_on: [] },
    { lane: 'lane-b', where: [], depends_on: [] },
  ]
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['skills/one/']), entry('lane-b', ['skills/one/references/'])],
    lanes,
    deps: { readdirSync: () => [], log: () => {} },
  }))
  assert.equal(error.reason, 'sibling-leak')
  assert.match(error.message, /lane lane-a creates path\(s\) inside sibling lane-b's fence/)
  assert.match(error.message, /skills\/one\/references\/new\.md/)
})

test('relatedLanes remains transitive, unrelated, and fail-closed', () => {
  const lanes = [{ lane: 'a' }, { lane: 'b', depends_on: ['a'] }, { lane: 'c', depends_on: ['b'] }, { lane: 'd' }]
  const graph = planWaves({ lanes }).graph
  assert.equal(relatedLanes(graph, 'a', 'c'), true)
  assert.equal(relatedLanes(graph, 'a', 'd'), false)
  assert.equal(relatedLanes(null, 'a', 'c'), false)
})

test('related holders still permit automatic anchor admission on disjoint fences', () => {
  const checkout = gitFixture()
  const manifest = 'skills/one/anchors.json'
  anchorFixtures(checkout, { one: { 'src/owned.mjs:1': 'export const OWNED = 1' } })
  const lanes = [
    { lane: 'lane-a', where: ['src/owned.mjs'], depends_on: [] },
    { lane: 'lane-b', where: [manifest], depends_on: ['lane-a'] },
  ]
  const graph = planWaves({ lanes }).graph
  const report = checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('lane-b', [manifest])],
    lanes,
    graph,
    checkout,
    outDir: join(checkout, 'related-holder-out'),
    deps: { home: join(root, 'related-holder-home'), log: () => {} },
  })
  assert.equal(report.admissions.filter((row) => row.lane === 'lane-a' && row.file === manifest && row.source === 'anchor-pin').length, 1)
  assert.equal(report.warnings.some(({ kind }) => kind === 'fence-admission-arbitrated'), false)
})

test('related admission owners keep automatic admissions out of arbitration', () => {
  const checkout = gitFixture()
  const manifest = 'skills/one/anchors.json'
  put(join(checkout, 'src', 'second.mjs'), 'export const SECOND = 1\n')
  anchorFixtures(checkout, { one: {
    'src/owned.mjs:1': 'export const OWNED = 1',
    'src/second.mjs:1': 'export const SECOND = 1',
  } })
  const lanes = [
    { lane: 'lane-a', where: ['src/owned.mjs'], depends_on: [] },
    { lane: 'lane-b', where: ['src/second.mjs'], depends_on: ['lane-a'] },
  ]
  const graph = planWaves({ lanes }).graph
  const report = checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('lane-b', ['src/second.mjs'])],
    lanes,
    graph,
    checkout,
    outDir: join(checkout, 'related-owner-out'),
    deps: { home: join(root, 'related-owner-home'), log: () => {} },
  })
  assert.equal(report.admissions.filter((row) => row.file === manifest && row.source === 'anchor-pin').length, 2)
  assert.equal(report.warnings.some(({ kind }) => kind === 'fence-admission-arbitrated'), false)
})

test('the incident register names all runtime-conflicting paths before dispatch', () => {
  const { lanes, fences } = siblingIncidentRegister()
  const expected = [...new Set(lanes.flatMap((lane) => laneFenceHits(
    lane.where,
    fences.filter((row) => row.lane !== lane.lane),
  ).map((hit) => hit.entry)))].sort()
  const graph = planWaves({ lanes }).graph
  const error = thrown(() => checkFences({ fences, lanes, graph, deps: { readdirSync: () => [], log: () => {} } }))
  assert.equal(error.reason, 'sibling-leak')
  assert.deepEqual(expected, [
    'skills/crew-recovery/anchors.json',
    'skills/pr-review/SKILL.md',
    'skills/pr-review/anchors.json',
  ])
  for (const path of expected) assert.equal(error.message.includes(path), true, path)
})

test('dispatchBatch refuses the incident register before any subprocess call', async () => {
  const { lanes, fences } = siblingIncidentRegister()
  const requests = Object.fromEntries(lanes.map((lane) => [lane.lane, {
    ...request(`measure ${lane.lane}`, lane.where),
    depends_on: lane.depends_on,
  }]))
  const spawned = []
  const error = await thrownAsync(() => dispatchFixture({
    label: 'incident-preflight',
    names: lanes.map((lane) => lane.lane),
    requests,
    fences,
    spawnedOut: spawned,
    spawnResult: () => ({ status: 0, stdout: '', stderr: '' }),
  }))
  assert.equal(error.reason, 'sibling-leak')
  assert.equal(spawned.length, 0)
  for (const path of ['skills/crew-recovery/anchors.json', 'skills/pr-review/SKILL.md', 'skills/pr-review/anchors.json']) {
    assert.equal(error.message.includes(path), true, path)
  }
})

test('sibling leakage wins before an outside-fence where path or arbitration warning', () => {
  const lanes = [
    { lane: 'lane-a', where: ['src/shared.mjs'], depends_on: [] },
    { lane: 'lane-b', where: ['src/shared.mjs', 'outside/not-owned.mjs'], depends_on: ['lane-a'] },
  ]
  const graph = planWaves({ lanes }).graph
  const logs = []
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/shared.mjs']), entry('lane-b', ['src/shared.mjs'])],
    lanes,
    graph,
    deps: { readdirSync: () => [], log: (line) => logs.push(String(line)) },
  }))
  assert.equal(error.reason, 'sibling-leak')
  assert.equal(logs.some((line) => line.includes('continues')), false)
  assert.equal(logs.some((line) => line.includes('arbitrated')), false)
})

test('D1 distinguishes untouched pins from pinned files the lane writes', () => {
  assert.ok(ANCHOR_PIN_POST_MERGE.includes('a manifest pinning only files this lane does not write is not an obligation on this lane'))
  assert.ok(ANCHOR_PIN_POST_MERGE.includes('a lane that writes the pinned file WILL owe the repair'))
  assert.ok(ANCHOR_PIN_POST_MERGE.includes('cannot reach it until the pinning manifest is added to its fence'))
  assert.equal(ANCHOR_PIN_POST_MERGE.includes('so a pinning manifest outside this fence is not an obligation on this lane'), false)
})

test('H1 pins the partitionShifts two-case truth table the doctrine constant claims', () => {
  const manifest = 'skills/example/anchors.json'
  const shifted = [{ rel: 'crew/pinned.mjs' }]
  assert.deepEqual(partitionShifts({
    shifted,
    fence: [manifest, shifted[0].rel],
    manifest,
  }), { inFence: shifted, outOfFence: [] })
  assert.deepEqual(partitionShifts({
    shifted,
    fence: [shifted[0].rel],
    manifest,
  }), { inFence: [], outOfFence: shifted })
  assert.deepEqual(partitionShifts({
    shifted,
    fence: [manifest],
    manifest,
  }), { inFence: [], outOfFence: shifted })
})

test('F1 warns without refusing dispatch', async () => {
  const checkout = gitFixture()
  const file = 'crew/owned.mjs'
  const manifest = ['skills', 'backend-node', 'anchors.json'].join('/')
  put(join(checkout, ...file.split('/')), 'export const OWNED = 1\n')
  anchorFixtures(checkout, { 'backend-node': { 'crew/owned.mjs:1': 'export const OWNED = 1' } })
  const batch = join(checkout, 'f1-batch')
  const outDir = join(checkout, 'f1-out')
  mkdirSync(batch)
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('measure anchor warning', [file])))
  let result
  await assert.doesNotReject(async () => {
    result = await dispatchBatch({
      batchDir: batch,
      fences: [entry('lane-a', [file])],
      checkout,
      parentDir: join(checkout, 'f1-parent'),
      outDir,
      runFlags: { 'dry-run': true },
      deps: {
        home: root,
        env: { DEVTEAM_LEDGER_DIR: root },
        existsSync: (path) => String(path).endsWith('anchors.json') ? fsExistsSync(path) : false,
        spawn: () => ({ status: 1, stdout: '', stderr: '' }),
        log: () => {},
      },
    })
  })
  assert.equal(result.dryRun, true)
  const warning = result.fences.warnings.find(({ kind }) => kind === 'anchor-pin')
  assert.ok(warning)
  assert.equal(warning.kind, 'anchor-pin')
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(persisted.lanes[0].anchor_pins, warning.pins)
  assert.equal(persisted.lanes[0].anchor_pins[0].manifest, manifest)
})

test('trips-and-dispatches: an unfenced anchor scan returns with the per-lane report intact', () => {
  const checkout = join(root, 'anchor-warning-checkout')
  const fixture = warningFixture(checkout)
  const report = checkFences({
    fences: [entry('lane-a', fixture.files)],
    lanes: [{ lane: 'lane-a', where: fixture.files }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  assert.deepEqual(report.perLane['lane-a'].files, [...fixture.files, ...fixture.manifestPaths, ...CENSUS_CARRIER_FILES].sort((a, b) => fixture.files.includes(a) && !fixture.files.includes(b) ? -1 : !fixture.files.includes(a) && fixture.files.includes(b) ? 1 : a.localeCompare(b)))
  assert.deepEqual(report.perLane['lane-a'].where, fixture.files)
  const anchorWarning = report.warnings.find(({ kind }) => kind === 'anchor-pin')
  assert.ok(anchorWarning)
  assert.equal(report.warnings.filter(({ kind }) => kind === 'anchor-pin').length, 1)
  assert.equal(anchorWarning.text.includes(ANCHOR_PIN_POST_MERGE), true)
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
  assert.equal(report.warnings.find(({ kind }) => kind === 'anchor-pin').text.includes(ANCHOR_BLIND_SPOT), true)
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
  assert.equal(report.warnings.filter(({ kind }) => kind === 'anchor-pin').length, 0)
  assert.equal(logs.some((line) => line.includes(ANCHOR_PIN_WARNING_PREFIX)), false)
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
  assert.equal(promptBoot.args[promptBoot.args.indexOf('--assurance') + 1], 'rigorous')
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
    '--brief-file', ordinaryRun.args[briefIndex + 1], '--keep', '--execution', 'full',
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
  // ADR-035 section 4 refuses the PAIR, matching values included: no precedence
  // rule to remember and no silent winner. Both arms therefore refuse.
  const matching = (() => { try { resolveRequestedTier({ tier: 'build', assurance: 'standard' }) } catch (error) { return error } })()
  assert.equal(matching?.reason, 'transport-conflict')
  const differing = (() => { try { resolveRequestedTier({ tier: 'build', assurance: 'rigorous' }) } catch (error) { return error } })()
  assert.equal(differing?.reason, 'transport-conflict')
  assert.match(differing?.message ?? '', /--assurance/)
  assert.match(differing?.message ?? '', /--tier/)
})

test('EX1', async () => {
  const result = await dispatchFixture({ label: 'EX1', names: ['lane-a'], runFlags: { execution: 'full' } })
  const run = result.spawned.find(({ args }) => args.includes('run'))
  assert.ok(run)
  assert.equal(run.args[run.args.indexOf('--execution') + 1], 'full')
  assert.equal(run.args.includes('--variant'), false)
  assert.equal(result.logs.some((line) => line.includes('DEPRECATED alias')), false)

  // The DEFERRED-WAVE RESUME command forwards execution through a SECOND site.
  // An operator pastes that line verbatim to start wave two, so if it emits the
  // dated alias the resume refuses the moment ADR-035's window closes. Proven
  // by hand: mutating only the run-command site left this green.
  const wave = await dispatchFixture({
    label: 'EX1-wave', names: ['lane-a', 'lane-b'],
    requests: { 'lane-b': requestFor('lane-b', { depends_on: ['lane-a'] }) },
    runFlags: { wave: '1', execution: 'full' },
  })
  const resume = wave.logs.find((line) => line.startsWith('dispatch-batch: deferred lane=lane-b '))
  assert.ok(resume, 'wave one must print a resume command for the deferred lane')
  assert.ok(resume.includes('--execution full'), 'the resume command must carry the canonical --execution')
  assert.equal(resume.includes('--variant'), false)
})

test('EK1', () => {
  assert.deepEqual(parseCliArgs(['--execution', 'full']), { execution: 'full' })
  assert.equal(resolveRequestedExecution({ execution: 'full' }), 'full')
})

test('VW1', async () => {
  const result = await dispatchFixture({
    label: 'VW1',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { variant: 'scout' }) },
  })
  const run = result.spawned.find(({ args }) => args.includes('run'))
  assert.equal(run.args[run.args.indexOf('--execution') + 1], 'scout')
  assert.equal(run.args.includes('--variant'), false)
  assert.equal(result.logs.filter((line) => line === 'warning: --variant is a DEPRECATED alias for --execution, removed at the next tagged release (ADR-035 §4)').length, 1)
})

test('VW2', async () => {
  const result = await dispatchFixture({
    label: 'VW2',
    names: ['lane-a', 'lane-b'],
    requests: {
      'lane-a': requestFor('lane-a', { variant: 'scout' }),
      'lane-b': requestFor('lane-b', { variant: 'full' }),
    },
  })
  assert.equal(result.logs.filter((line) => line === 'warning: --variant is a DEPRECATED alias for --execution, removed at the next tagged release (ADR-035 §4)').length, 1)
  assert.deepEqual(batchAliasWarnings({ lanes: [{ variantSupplied: true }, { variantSupplied: true }], runFlags: {} }), [
    'warning: --variant is a DEPRECATED alias for --execution, removed at the next tagged release (ADR-035 §4)',
  ])
})

test('AS1', async () => {
  const result = await dispatchFixture({ label: 'AS1', names: ['lane-a'], batchTier: 'build', runFlags: { assurance: 'standard' } })
  const boot = result.spawned.find(({ args }) => args.includes('boot'))
  assert.equal(boot.args[boot.args.indexOf('--assurance') + 1], 'standard')
  assert.equal(boot.args.includes('--tier'), false)
  assert.equal(result.logs.some((line) => line.includes('DEPRECATED alias')), false)
})

test('EQ1', async () => {
  const canonical = await dispatchFixture({
    label: 'EQ1-canonical',
    names: ['lane-a'],
    runFlags: { execution: 'full' },
    requests: { 'lane-a': requestFor('lane-a', { execution: 'scout' }) },
  })
  const alias = await dispatchFixture({
    label: 'EQ1-alias',
    names: ['lane-a'],
    runFlags: { execution: 'full' },
    requests: { 'lane-a': requestFor('lane-a', { variant: 'scout' }) },
  })
  const requestBytes = (result) => {
    const call = result.spawned.find(({ args }) => args.some((arg) => String(arg).endsWith('.compile-request.json')))
    return readFileSync(call.args[call.args.indexOf('--request') + 1], 'utf8')
  }
  assert.equal(requestBytes(canonical), requestBytes(alias))
  const run = canonical.spawned.find(({ args }) => args.includes('run'))
  assert.equal(run.args[run.args.indexOf('--execution') + 1], 'scout')
})

test('AQ1', async () => {
  const canonical = await dispatchFixture({
    label: 'AQ1-canonical',
    names: ['lane-a'],
    batchTier: 'mechanical',
    requests: { 'lane-a': requestFor('lane-a', { assurance: 'standard' }) },
  })
  const alias = await dispatchFixture({
    label: 'AQ1-alias',
    names: ['lane-a'],
    batchTier: 'mechanical',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'build' }) },
  })
  const requestBytes = (result) => {
    const call = result.spawned.find(({ args }) => args.some((arg) => String(arg).endsWith('.compile-request.json')))
    return readFileSync(call.args[call.args.indexOf('--request') + 1], 'utf8')
  }
  assert.equal(requestBytes(canonical), requestBytes(alias))
  const boot = canonical.spawned.find(({ args }) => args.includes('boot'))
  assert.equal(boot.args[boot.args.indexOf('--assurance') + 1], 'standard')
})

test('DF1', async () => {
  const result = await dispatchFixture({ label: 'DF1', names: ['lane-a'] })
  const compile = result.spawned.find(({ args }) => args.some((arg) => String(arg).endsWith('.compile-request.json')))
  const actual = readFileSync(compile.args[compile.args.indexOf('--request') + 1], 'utf8')
  assert.equal(actual, `${JSON.stringify(requestFor('lane-a'), null, 2)}\n`)
  const run = result.spawned.find(({ args }) => args.includes('run'))
  assert.equal(run.args[run.args.indexOf('--execution') + 1], 'full')
  const boot = result.spawned.find(({ args }) => args.includes('boot'))
  assert.equal(boot.args[boot.args.indexOf('--assurance') + 1], 'quick')
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

async function runIssueBodyCompile({ label, ask, doneMeans, body = 'Fetched body.\\n' }) {
  const lane = `lane-${label}`
  const batch = makeBatch([lane])
  const authored = request(ask)
  if (doneMeans !== undefined) authored.done_means = doneMeans
  const requestPath = put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(authored))
  const out = join(root, `compile-${label}-out`)
  const register = put(join(root, `compile-${label}-register.json`), JSON.stringify({ lanes: [entry(lane, ['crew/owned.mjs'], [])] }))
  const calls = []
  const writes = new Map()
  const logs = []
  const result = await compileLane({
    lane, batchDir: batch, requestPath, laneDir: root, registerPath: register, outDir: out,
    fences: [entry(lane, ['crew/owned.mjs'], [])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        if ((call.args || []).includes('--discover-reads')) return { status: 0, stdout: '[]', stderr: '' }
        if (call.file === 'gh') return { status: 0, stdout: body, stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      },
      readFileSync: (path, encoding) => String(path).endsWith('.brief.md') ? briefWithTierAndShape : readFileSync(path, encoding || 'utf8'),
      writeFileSync: (path, content) => writes.set(String(path), String(content)),
      log: (line) => logs.push(String(line)),
    },
  })
  return { lane, requestPath, out, calls, writes, logs, result }
}

test('A1 declared issue wins over prose background', async () => {
  const fixture = await runIssueBodyCompile({
    label: 'issue-a1',
    ask: 'Use the quoted background (#1146, unlanded) only as context.',
    doneMeans: 'details.closes=[1124] selects the issue context for this lane.',
    body: 'Declared issue body.\\n',
  })
  const gh = fixture.calls.find(({ file }) => file === 'gh')
  assert.ok(gh)
  assert.equal(gh.args[2], '1124')
  const compile = fixture.calls.find(({ args }) => args.includes('--out'))
  assert.ok(compile)
  const issueFlag = compile.args.indexOf('--issue-body')
  assert.notEqual(issueFlag, -1)
  const issuePath = compile.args[issueFlag + 1]
  assert.equal(fixture.writes.get(issuePath), 'Declared issue body.\\n')
})

test('RV1-1 scans later closes declarations after an illustrative placeholder', async () => {
  const fixture = await runIssueBodyCompile({
    label: 'issue-rv1-1',
    ask: 'Use #1146 only as background context.',
    doneMeans: 'A1 names details.closes=[A] only as a gate label.\nThe actual close is details.closes=[1155].',
  })
  const gh = fixture.calls.find(({ file }) => file === 'gh')
  assert.ok(gh)
  assert.equal(gh.args[2], '1155')
  assert.equal(fixture.logs.includes(`dispatch-batch: issue-body lane=${fixture.lane} issue=1155 source=declared status=available bytes=${Buffer.byteLength('Fetched body.\\n')}`), true)
  assert.equal(fixture.logs.includes(`dispatch-batch: issue-binding-disagreement lane=${fixture.lane} declared=1155 prose=1146`), true)
})

test('B1 successful issue-body fetch logs issue and bytes', async () => {
  const body = 'é declared body\\n'
  const fixture = await runIssueBodyCompile({ label: 'issue-b1', ask: 'Fetch #1124 for this lane.', body })
  assert.equal(fixture.logs.includes(`dispatch-batch: issue-body lane=${fixture.lane} issue=1124 source=prose status=available bytes=${Buffer.byteLength(body)}`), true)
})

test('C1a prose fallback still fetches an issue body', async () => {
  const fixture = await runIssueBodyCompile({ label: 'issue-c1a', ask: 'Fetch #1146 for this lane.', doneMeans: 'No close declaration is present.' })
  const gh = fixture.calls.find(({ file }) => file === 'gh')
  assert.ok(gh)
  assert.equal(gh.args[2], '1146')
  assert.ok(fixture.calls.find(({ args }) => args.includes('--issue-body')))
})

test('C1b prose fallback records prose source', async () => {
  const fixture = await runIssueBodyCompile({ label: 'issue-c1b', ask: 'Fetch #1146 for this lane.', doneMeans: 'details.closes=[] leaves the prose citation in charge.' })
  assert.equal(fixture.logs.includes(`dispatch-batch: issue-body lane=${fixture.lane} issue=1146 source=prose status=available bytes=${Buffer.byteLength('Fetched body.\\n')}`), true)
})

test('C2 declared binding records declared source', async () => {
  const fixture = await runIssueBodyCompile({ label: 'issue-c2', ask: 'The background cites #1146.', doneMeans: 'details.closes=[1124] is the declared issue.' })
  assert.equal(fixture.logs.includes(`dispatch-batch: issue-body lane=${fixture.lane} issue=1124 source=declared status=available bytes=${Buffer.byteLength('Fetched body.\\n')}`), true)
})

test('D1 disagreement names declared and prose issues', async () => {
  const fixture = await runIssueBodyCompile({
    label: 'issue-d1',
    ask: 'Use the quoted background (#1146, unlanded) only as context.',
    doneMeans: 'details.closes=[1124] selects the issue context for this lane.',
    body: 'Declared issue body.\\n',
  })
  assert.equal(fixture.logs.includes(`dispatch-batch: issue-binding-disagreement lane=${fixture.lane} declared=1124 prose=1146`), true)
  const gh = fixture.calls.find(({ file }) => file === 'gh')
  assert.ok(gh)
  assert.equal(gh.args[2], '1124')
  assert.ok(fixture.calls.find(({ args }) => args.includes('--issue-body')))
  assert.equal(fixture.result.topSection, 'Proposed tier')
})

test('E1a historical binding report carries its denominator', () => {
  const home = scratchDir('factory-issue-history-')
  const batch = join(home, 'batch-mini')
  put(join(batch, 'lane-match.request.json'), JSON.stringify({
    ...request('#100 declared match', ['crew/owned.mjs']),
    done_means: 'details.closes=[100] declares the matching issue.',
  }))
  put(join(batch, 'lane-mismatch.request.json'), JSON.stringify({
    ...request('Quoted background (#1146, unlanded)'),
    done_means: 'details.closes=[1124] declares the fetched issue.',
  }))
  put(join(batch, 'out', 'lane-mismatch.issue.md'), 'Fetched mismatch artifact.\\n')
  put(join(batch, 'lane-fallback.request.json'), JSON.stringify(request('Use prose #103 when no close is declared.')))
  put(join(batch, 'nested', 'batch-archived', 'lane-empty.request.json'), JSON.stringify({
    ...request('Use prose #104 when closes is empty.'),
    done_means: 'details.closes=[] leaves prose fallback.',
  }))
  const report = historicalIssueBindings({ home, deps: { existsSync: fsExistsSync, readFileSync, readdirSync: fsReaddirSync } })
  assert.deepEqual(report, {
    totalRequests: 4,
    withoutDeclaredClose: 2,
    proseWithoutDeclaredClose: 2,
    proseCited: 4,
    disagreements: 1,
    artifactBackedMisbindings: 1,
    reason: null,
  })
})

test('E1b unreadable history is null with one reason', () => {
  const nullCells = {
    totalRequests: null,
    withoutDeclaredClose: null,
    proseWithoutDeclaredClose: null,
    proseCited: null,
    disagreements: null,
    artifactBackedMisbindings: null,
  }
  const denied = historicalIssueBindings({
    home: join(root, 'issue-history-denied'),
    deps: { readdirSync: () => { const error = new Error('EPERM'); error.code = 'EPERM'; throw error } },
  })
  assert.deepEqual(denied, { ...nullCells, reason: 'archive-unreadable' })

  const malformedHome = scratchDir('factory-issue-history-malformed-')
  put(join(malformedHome, 'batch-bad', 'lane-bad.request.json'), '{')
  const malformed = historicalIssueBindings({ home: malformedHome })
  assert.deepEqual(malformed, { ...nullCells, reason: 'archive-unreadable' })

  const emptyHome = scratchDir('factory-issue-history-empty-')
  const empty = historicalIssueBindings({ home: emptyHome })
  assert.deepEqual(empty, { ...nullCells, reason: 'archive-empty' })
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
  assert.deepEqual(logs, ['dispatch-batch: issue-body lane=lane-gh issue=867 source=prose status=unavailable reason=gh-failed'])
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
  const logs = []
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
      log: (line) => logs.push(String(line)),
    },
  })
  const compile = calls.find(({ args }) => args.includes('--out'))
  assert.ok(compile)
  const issueFlag = compile.args.indexOf('--issue-body')
  assert.notEqual(issueFlag, -1)
  const issuePath = compile.args[issueFlag + 1]
  assert.equal(issuePath, join(out, `${lane}.issue.md`))
  assert.equal(writes.get(issuePath), 'Fetched body.\n')
  assert.deepEqual(logs, [`dispatch-batch: issue-body lane=${lane} issue=42 source=prose status=available bytes=${Buffer.byteLength('Fetched body.\n')}`])
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
    'dispatch-batch: lane=lane-a forced=none prompt=code-only proposed=none requested=mechanical requested_from=batch execution=full execution_from=batch variant=full variant_from=batch settled=mechanical',
  ), true)
  assert.match(line, / shape=judge strength=workhorse misclassified=false brief_bytes=65 top_section=none granularity=whole-file\(crew\/owned-lane-a\.mjs\)$/)
})

test('a proposal block without a tier line never supplies the seating tier', async () => {
  assert.equal(await compileBriefProposal(briefWithBlockOnly, 'block-only'), null)
})

test('a mid-sentence proposed tier quote does not outrank the compiler line', async () => {
  assert.equal(await compileBriefProposal(briefWithQuotedTier, 'quoted-tier'), 'build')
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
    return [task, call.args[call.args.indexOf('--assurance') + 1]]
  }))
  assert.deepEqual(seated, { 'lane-a': 'rigorous', 'lane-b': 'quick' })
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
    return [task, call.args[call.args.indexOf('--assurance') + 1]]
  }))
  assert.equal(seated['lane-a'], 'standard')
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

test('a batch mixes lane variants while preserving the batch default', async () => {
  const result = await dispatchFixture({
    label: 'lane-variants',
    names: ['lane-a', 'lane-b', 'lane-c'],
    requests: { 'lane-b': requestFor('lane-b', { variant: 'scout' }) },
  })
  const runs = result.spawned.filter(({ args }) => args.includes('run'))
  const variants = Object.fromEntries(runs.map(({ args }) => {
    const lane = args[args.indexOf('--task') + 1]
    return [lane, args[args.indexOf('--execution') + 1]]
  }))
  assert.deepEqual(variants, { 'lane-a': 'full', 'lane-b': 'scout', 'lane-c': 'full' })
  const settled = result.logs.filter((line) => line.startsWith('dispatch-batch: lane='))
  assert.ok(settled.some((line) => line.includes('lane=lane-b') && line.includes('variant=scout variant_from=lane')))
  assert.ok(settled.some((line) => line.includes('lane=lane-a') && line.includes('variant=full variant_from=batch')))
  assert.ok(settled.some((line) => line.includes('lane=lane-c') && line.includes('variant=full variant_from=batch')))
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

test('a batch without lane variants keeps the full variant on every run', async () => {
  const result = await dispatchFixture({ label: 'no-lane-variants' })
  const runs = result.spawned.filter(({ args }) => args.includes('run'))
  assert.equal(runs.length, 2)
  for (const { args } of runs) {
    const index = args.indexOf('--execution')
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
  refusal(() => checkFences({ fences, lanes, graph, checkout: root, deps: { readdirSync: () => [], log: () => {} } }), 'sibling-leak')
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
  assert.equal(boot.args[boot.args.indexOf('--assurance') + 1], 'rigorous')
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

test('a citation of a file outside the write surface is not a carrier row', () => {
  const checkout = carrierCheckout('carrier-off-surface')
  const pins = collectAnchorPins({ checkout })
  const carriers = citationCarriers({ checkout, pins })
  assert.deepEqual(citationCarriersOutsideFence({ surface: ['crew/other.mjs'], fenceFiles: ['crew/other.mjs'], carriers }), [])
})

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

test('the citation-carrier blind spot names the set-comparison case it cannot find', () => {
  assert.match(CITATION_CARRIER_BLIND_SPOT, /^BLIND SPOT: /)
  assert.match(CITATION_CARRIER_BLIND_SPOT, /skills\/crew-recovery\/references\/escalations\.md/)
  assert.match(CITATION_CARRIER_BLIND_SPOT, /no manifest pins/)
})

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
