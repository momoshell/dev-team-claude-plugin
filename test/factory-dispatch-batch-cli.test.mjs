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
  refusal,
  thrownAsync,
  dispatchFixture,
  adoptionArchive,
  adoptionDispatchFixture,
} from './factory-dispatch-batch-fences.test.mjs'

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

test('EK2', async () => {
  const result = await dispatchFixture({
    label: 'EK2',
    names: ['lane-a', 'lane-b'],
    requests: { 'lane-a': requestFor('lane-a', { execution: 'scout' }) },
  })
  const lane = readBatch({ batchDir: result.batch }).find(({ lane: name }) => name === 'lane-a')
  assert.equal(lane.execution, 'scout')
  assert.equal(lane.request.execution, undefined)
  assert.equal(lane.request.variant, undefined)
  const compileRequests = result.spawned
    .filter(({ args }) => args.some((arg) => String(arg).endsWith('.compile-request.json')))
    .map(({ args }) => JSON.parse(readFileSync(args[args.indexOf('--request') + 1], 'utf8')))
  assert.equal(compileRequests.length, 4)
  for (const compiled of compileRequests) {
    for (const key of ['execution', 'variant', 'assurance', 'tier']) assert.equal(Object.hasOwn(compiled, key), false)
  }
})

test('AK1', () => {
  const batch = makeBatch(['lane-a'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { assurance: 'standard' })))
  const [lane] = readBatch({ batchDir: batch })
  assert.equal(lane.assurance, 'build')
  assert.equal(lane.tier, null)
  assert.equal(Object.hasOwn(lane.request, 'assurance'), false)
  assert.equal(Object.hasOwn(lane.request, 'tier'), false)
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

test('readBatch splits a lane tier and leaves the compiler request schema clean', () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { tier: 'judge' })))
  const lanes = readBatch({ batchDir: batch })
  assert.equal(lanes.find(({ lane }) => lane === 'lane-a').tier, 'judge')
  assert.equal(lanes.find(({ lane }) => lane === 'lane-b').tier, null)
  assert.equal(Object.hasOwn(lanes.find(({ lane }) => lane === 'lane-a').request, 'tier'), false)
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

test('readBatch splits a lane variant and leaves the compiler request clean', () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { variant: 'scout' })))
  const lanes = readBatch({ batchDir: batch })
  assert.equal(lanes.find(({ lane }) => lane === 'lane-a').variant, 'scout')
  assert.equal(lanes.find(({ lane }) => lane === 'lane-b').variant, null)
  assert.equal(Object.hasOwn(lanes.find(({ lane }) => lane === 'lane-a').request, 'variant'), false)
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

test('parseCliArgs accepts --wave and refuses its missing value', () => {
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--wave', '2']), { batch: 'b', wave: '2' })
  refusal(() => parseCliArgs(['--batch', 'b', '--wave']), 'batch-unreadable')
})
