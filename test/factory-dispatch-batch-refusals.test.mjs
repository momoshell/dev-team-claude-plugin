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

import {
  root,
  compiler,
  put,
  request,
  requestFor,
  makeBatch,
  entry,
  refusal,
  compilerLane,
  thrownAsync,
  reachCheck,
  namedReachFixture,
  dispatchFixture,
} from './factory-dispatch-batch-fences.test.mjs'

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
