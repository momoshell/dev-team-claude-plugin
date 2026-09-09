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
  put,
  refusal,
  thrown,
  adoptionArchive,
  basenameOf,
} from './factory-dispatch-batch-fences.test.mjs'

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
