import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFileSync as fsAppendFileSync, existsSync as fsExistsSync, mkdirSync, readFileSync, readdirSync as fsReaddirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import { fileURLToPath } from 'node:url'

const DIRECT = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
const root = scratchDir('factory-dispatch-batch-')
const repoRoot = dirname(dirname(new URL(import.meta.url).pathname))
const compiler = join(repoRoot, 'scripts', 'factory', 'make-brief.mjs')

const NO_ADMISSION_REPORT_FIXTURE = `{
  "schema_version": 1,
  "blind_spots": {
    "anchor-pin": "BLIND SPOT: an unpinned file:line citation is in no manifest key, so neither this check nor the citation-carrier check can find it; a citation the anchor corpus does not pin is still discoverable only by hand",
    "citation-carrier": "BLIND SPOT: this finds docs carrying a PINNED path:line citation and nothing else. A citation no manifest pins is in no key, and a doc whose exhibit set-compares a documented table against source (skills/crew-recovery/references/escalations.md and the escalate() producers) reddens with every citation in it still correct. Neither is discoverable here; read the exhibits suites of the manifests named above before choosing this fence",
    "test-reach": "BLIND SPOT: this is a proxy in BOTH directions and names candidates, never proof. A test can assert the changed behaviour through a higher-level entry point without importing the changed file at all, and a computed path or dynamic import is invisible to a static scan — crew/crew.mjs loads every adapter that way. A test can equally import a fenced file without asserting anything about the part being changed. The literal symbol scan sees only whole-word occurrences of an exported name, is blind to a renamed re-export, and drops any symbol naming more than 8 test files as too broad to be evidence. Read the named files before choosing this fence; an unnamed one is not cleared. An apostrophe or quote inside a // or /* */ comment opens a phantom literal and hides every real path literal after it in that file.",
    "census-carrier": "BLIND SPOT: this warning fires on the POSSIBILITY that a fenced *.test.mjs edit moves either repository-wide census, not on the fact; dispatch cannot inspect bytes the builder has not written and cannot predict whether either census will move.",
    "cross-batch-unknown": "BLIND SPOT: a lane booted without --fences declares no surface at all and can be editing anything; a lane whose batch siblings have been reaped records no claim; and a repository whose git dir cannot be measured is not compared. None of those are cleared — they are reported unknown."
  },
  "cross_batch_unknown": [],
  "lanes": [
    {
      "lane": "lane-a",
      "test_reach": [],
      "test_reach_dropped": [],
      "citation_carriers": [],
      "anchor_pins": [],
      "census_carriers": []
    }
  ]
}
`

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

function liveHolderFixture(name, candidate, { holder = 'holder-lane' } = {}) {
  const checkout = namedReachFixture(`holder-${name}`)
  const home = join(root, `holder-${name}-home`)
  const source = `source-${name}`
  const sourceDir = crewFixture({
    home,
    repoDir: `dt-${name}-source`,
    laneDir: source,
    lane: source,
    checkout,
    fence: [{ lane: holder, files: [candidate] }],
  })
  const holderDir = crewFixture({
    home,
    repoDir: `dt-${name}-holder`,
    laneDir: holder,
    lane: holder,
    checkout,
    fence: [{ lane: source, files: [] }],
  })
  return { checkout, home, holder, holderDir, source, candidate }
}

function arbitrationFixture(name) {
  const checkout = reachFixture(`arbitration-${name}`, {
    files: {
      'lib/neighbor-a.mjs': 'export const neighborA = true\\n',
      'lib/neighbor-b.mjs': 'export const neighborB = true\\n',
      'test/shared.test.mjs': [
        "import { neighborA } from '../lib/neighbor-a.mjs'",
        "import { neighborB } from '../lib/neighbor-b.mjs'",
        'if (!neighborA || !neighborB) throw new Error(\'shared\')',
        '',
      ].join('\\n'),
    },
  })
  const shared = 'test/shared.test.mjs'
  const firstFile = 'lib/neighbor-a.mjs'
  const secondFile = 'lib/neighbor-b.mjs'
  return {
    checkout,
    shared,
    firstFile,
    secondFile,
    fences: [entry('lane-a', [firstFile]), entry('lane-b', [secondFile])],
    requests: {
      'lane-a': request('dispatch the first neighboring module', [firstFile]),
      'lane-b': request('dispatch the second neighboring module', [secondFile]),
    },
  }
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


































// The 55, 32, and 30 figures are functions of every tracked *.test.mjs file in the repo, not of this test. If this guard reddens in your lane, you have added or removed an apostrophe inside a comment in some tracked test file and flipped its parity; the fix is to RE-MEASURE and update skills/crew-dispatch/references/batch.md rather than hunt a scanner regression.
// Re-measure comment-apostrophe exposure with: node --input-type=module -e "import{readFileSync}from\"node:fs\";import{execFileSync}from\"node:child_process\";const files=execFileSync(\"git\",[\"ls-files\",\"-z\"],{encoding:\"utf8\"}).split(String.fromCharCode(0)).filter(file=>file.endsWith(\".test.mjs\")),headFiles=execFileSync(\"git\",[\"ls-tree\",\"-r\",\"--name-only\",\"-z\",\"HEAD\"],{encoding:\"utf8\"}).split(String.fromCharCode(0)).filter(file=>file.endsWith(\".test.mjs\")),apostrophes=text=>[...text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)].reduce((total,comment)=>total+[...comment[0]].filter(char=>char===String.fromCharCode(39)).length,0),measure=(paths,textOf)=>{const counts=paths.map(file=>apostrophes(textOf(file)));return{withApostrophe:counts.filter(Boolean).length,odd:counts.filter(value=>value%2).length}},shipped=measure(files,file=>readFileSync(file,\"utf8\")),head=measure(headFiles,file=>execFileSync(\"git\",[\"show\",String.fromCharCode(72,69,65,68,58)+file],{encoding:\"utf8\"}));console.log({filesWithCommentApostrophe:shipped.withApostrophe,shippedOddCommentApostropheFiles:shipped.odd,pristineHEADOddCommentApostropheFiles:head.odd})"




















































































































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
  checkout = root,
  readdir = null,
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
    readdirSync: (path, options) => {
      if (String(path) === batch) return names.map((lane) => `${lane}${REQUEST_SUFFIX}`)
      if (readdir) return readdir(path, options)
      return names.map((lane) => `${lane}${REQUEST_SUFFIX}`)
    },
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
    checkout,
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


// Mutation killed: fence the carrier doc and the row must disappear. Without this a check
// that always reports would be indistinguishable from one that measures.


// Mutation killed: a file the lane does not write must not raise a carrier row, so a lane
// whose surface misses the cited file stays silent.


// Mutation killed: drop the (?!\d) lookahead in carriesCitation and `crew/drive.mjs:2` is
// found inside `crew/drive.mjs:23`, attributing a citation to a doc that never made it.


// Mutation killed: the SKILL.md + references/*.md layout is anchor-pin.mjs's skillDocs
// (restated, not imported), and crew/roles keeps neither — it holds its charters directly.
// Read only one layout and crew/roles resolves to no docs and every roles citation is missed,
// which is the crew/roles/tech-lead.md half of b388's fence gap.


// Mutation killed: state a completeness this cannot have. escalations.md carries NO shifted
// citation — its exhibit set-compares a documented table against the escalate() producers —
// so the warning must say what it cannot find rather than implying it found everything.


// Mutation killed: never push the warning (or read the carriers of a fence that already holds
// the doc) and checkFences reports nothing, which is what b388's dispatch did. The wiring is
// what the lane needed, not the derivation alone.


// Mutation killed: warn regardless of the fence and a correctly fenced lane is told to widen a
// fence it already has — the false positive that would make the operator stop reading warnings.

export {
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
  basenameOf,
  cachePath,
  directBaseline,
  compileBriefProposal,
  carrierCheckout,
}


DIRECT && test('checkFences distinguishes an abandoned external refusal from a settled one', () => {
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

DIRECT && test('checkFences reports external fence contradictions and marks an empty comparison unmeasured', () => {
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

DIRECT && test('checkFences refuses a batch lane marked external', () => {
  refusal(() => checkFences({
    fences: [entry('lane-a', ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [] }],
    externals: ['lane-a'],
    deps: { home: join(root, 'claimed-both-home'), log: () => {} },
  }), 'fence-register-mismatch')
})

DIRECT && test('checkFences refuses an absent external lane by name', () => {
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

DIRECT && test('path reach admits a rooted planner charter literal when unheld', () => {
  const planner = ['crew', 'roles', 'planner.md'].join('/')
  const reach = collectTestReach({ checkout: repoRoot })
  const rows = testsOutsideFence({ surface: [planner], fenceFiles: [planner], reach })
  assert.deepEqual(rows.find((row) => row.test === 'crew/crew.test.mjs'), {
    test: 'crew/crew.test.mjs', file: planner, hops: null, how: 'path', symbols: [],
  })
  const result = reachCheck({ checkout: repoRoot, fenceFiles: [planner], surface: [planner] })
  assert.equal(result.error, null)
  assert.ok(result.report.admissions.some((row) => row.source === 'test-reach' && row.file === 'crew/crew.test.mjs'))
})

DIRECT && test('A1 admits unheld test reach', async () => {
  const checkout = reachFixture('admit-unheld')
  const outDir = join(checkout, 'admit-unheld-out')
  const logs = []
  const report = checkFences({
    fences: [entry('lane-a', ['lib/widget.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['lib/widget.mjs'] }],
    checkout,
    outDir,
    deps: { home: join(root, 'admit-unheld-home'), log: (line) => logs.push(String(line)) },
  })
  const admissions = report.admissions.filter((row) => row.source === 'test-reach')
  assert.ok(admissions.length > 0)
  assert.ok(report.perLane['lane-a'].files.includes(admissions[0].file))
  assert.equal(new Set(admissions.map((row) => `${row.lane}:${row.file}:${row.source}`)).size, admissions.length)
  assert.ok(logs.some((line) => line.includes('fence-admitted') && line.includes('source=test-reach')))
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(persisted.lanes[0].fence_admissions.filter((row) => row.source === 'test-reach'), admissions)

  const batch = makeBatch(['dry-admit'])
  put(join(batch, `dry-admit${REQUEST_SUFFIX}`), JSON.stringify(request('admit test reach', ['lib/widget.mjs'])))
  const dryLogs = []
  const dry = await dispatchBatch({
    batchDir: batch,
    fences: [entry('dry-admit', ['lib/widget.mjs'])],
    checkout,
    parentDir: join(root, 'admit-unheld-parent'),
    outDir: join(root, 'admit-unheld-dry-out'),
    tier: 'mechanical',
    runFlags: { 'dry-run': true },
    deps: { home: join(root, 'admit-unheld-dry-home'), log: (line) => dryLogs.push(String(line)) },
  })
  assert.ok(dry.fences.admissions.some((row) => row.source === 'test-reach'))
  assert.ok(dryLogs.some((line) => line.includes('source=test-reach')))
})

DIRECT && test('C1 admits an unheld anchor manifest', () => {
  const checkout = gitFixture()
  const file = 'src/owned.mjs'
  const manifest = 'skills/example/anchors.json'
  anchorFixtures(checkout, { example: { [`${file}:1`]: 'export const OWNED = 1' } })
  const outDir = join(checkout, 'anchor-admission-out')
  const report = checkFences({
    fences: [entry('lane-a', [file])],
    lanes: [{ lane: 'lane-a', where: [file] }],
    checkout,
    outDir,
    deps: { home: join(root, 'anchor-admission-home'), log: () => {} },
  })
  const rows = report.admissions.filter((row) => row.source === 'anchor-pin')
  assert.deepEqual(rows, [{ lane: 'lane-a', file: manifest, source: 'anchor-pin' }])
  assert.equal(report.perLane['lane-a'].files.filter((candidate) => candidate === manifest).length, 1)
  const warning = report.warnings.find(({ kind }) => kind === 'anchor-pin')
  assert.ok(warning.text.endsWith(ANCHOR_BLIND_SPOT))
  const persisted = JSON.parse(readFileSync(join(outDir, FENCE_REPORT_FILE), 'utf8'))
  assert.deepEqual(persisted.lanes[0].fence_admissions, rows)
})

DIRECT && test('K1 compares a complete fence report with a fixed fixture', async () => {
  const checkout = gitFixture()
  const file = 'src/owned.mjs'
  const firstOut = join(checkout, 'complete-one')
  const secondOut = join(checkout, 'complete-two')
  const args = {
    fences: [entry('lane-a', [file])],
    lanes: [{ lane: 'lane-a', where: [file] }],
    checkout,
    deps: { home: join(root, 'complete-fence-home'), log: () => {} },
  }
  checkFences({ ...args, outDir: firstOut })
  const actualReport = readFileSync(join(firstOut, FENCE_REPORT_FILE), 'utf8')
  assert.equal(actualReport, NO_ADMISSION_REPORT_FIXTURE)
  assert.equal(actualReport.includes('fence_admissions'), false)
  assert.equal(actualReport.includes('fence-admitted'), false)

  // This second current-build report is intentionally retained as a mutation witness:
  // adding an anchor makes the report observably different without weakening the fixed fixture.
  anchorFixtures(checkout, { example: { [`${file}:1`]: 'export const OWNED = 1' } })
  checkFences({ ...args, outDir: secondOut })
  const secondReport = readFileSync(join(secondOut, FENCE_REPORT_FILE), 'utf8')
  assert.notEqual(actualReport, secondReport)
  assert.match(secondReport, /fence_admissions/)

  const batch = makeBatch(['lane-a'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(request('complete authored fence', [file])))
  const cleanCheckout = gitFixture()
  const outDir = join(cleanCheckout, 'complete-dispatch-out')
  const dry = await dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', [file])],
    checkout: cleanCheckout,
    parentDir: join(cleanCheckout, 'complete-dispatch-parent'),
    outDir,
    runFlags: { 'dry-run': true },
    deps: { home: join(root, 'complete-dispatch-home'), log: () => {} },
  })
  assert.equal(dry.fences.admissions.length, 0)
  assert.equal(Object.hasOwn(dry, 'registerPath'), false)
})

DIRECT && test('M1a dispatches both lanes after first-lane admission arbitration', async () => {
  const fixture = arbitrationFixture('M1a')
  const result = await dispatchFixture({
    label: 'M1a-arbitration',
    names: ['lane-a', 'lane-b'],
    requests: fixture.requests,
    fences: fixture.fences,
    checkout: fixture.checkout,
    existsProbe: fsExistsSync,
    spawnResult: (args) => args.includes('ls-files')
      ? spawnSync('git', ['-C', fixture.checkout, 'ls-files', '-z'], { encoding: 'utf8' })
      : { status: 0, stdout: '', stderr: '' },
  })
  assert.deepEqual(result.report.lanes.map(({ lane }) => lane), ['lane-a', 'lane-b'])
  const first = result.report.fences.perLane['lane-a']
  const second = result.report.fences.perLane['lane-b']
  assert.equal(first.files.includes(fixture.shared), true)
  assert.equal(second.files.includes(fixture.shared), false)
  assert.deepEqual(result.report.fences.admissions.filter((row) => row.file === fixture.shared), [
    { lane: 'lane-a', file: fixture.shared, source: 'test-reach' },
  ])
})

DIRECT && test('M1b excludes the second admission and warns with the first holder', async () => {
  const fixture = arbitrationFixture('M1b')
  const result = await dispatchFixture({
    label: 'M1b-arbitration',
    names: ['lane-a', 'lane-b'],
    requests: fixture.requests,
    fences: fixture.fences,
    checkout: fixture.checkout,
    existsProbe: fsExistsSync,
    spawnResult: (args) => args.includes('ls-files')
      ? spawnSync('git', ['-C', fixture.checkout, 'ls-files', '-z'], { encoding: 'utf8' })
      : { status: 0, stdout: '', stderr: '' },
  })
  const warning = result.report.fences.warnings.find(({ kind, file }) => kind === 'fence-admission-arbitrated' && file === fixture.shared)
  assert.deepEqual({ lane: warning?.lane, file: warning?.file, source: warning?.source }, {
    lane: 'lane-b', file: fixture.shared, source: 'test-reach',
  })
  assert.deepEqual(warning?.holder, { lane: 'lane-a', file: fixture.shared, source: 'test-reach' })
  assert.match(warning?.text || '', /lane-a/)
  assert.match(warning?.text || '', /test\/shared\.test\.mjs/)
  const persisted = JSON.parse(result.wrote.get(join(result.out, FENCE_REPORT_FILE)))
  assert.equal(persisted.lanes[1].fence_admission_arbitrated.length, 1)
  assert.equal(persisted.lanes[1].fence_admission_arbitrated[0].holder.lane, 'lane-a')
})

DIRECT && test('O1 still refuses a candidate held in an authored sibling fence', () => {
  const fixture = arbitrationFixture('O1')
  const heldTest = fixture.shared
  const error = thrown(() => checkFences({
    fences: [fixture.fences[0], entry('lane-b', [heldTest])],
    lanes: [
      { lane: 'lane-a', where: [fixture.firstFile] },
      { lane: 'lane-b', where: [] },
    ],
    checkout: fixture.checkout,
    outDir: join(fixture.checkout, 'O1-out'),
    deps: { home: join(root, 'O1-home'), log: () => {} },
  }))
  assert.equal(error.reason, 'test-reach-unfenced')
  assert.match(error.message, /lane-b/)
  assert.match(error.message, /test\/shared\.test\.mjs/)
  assert.doesNotMatch(error.message, /own fence overlaps/)
  const persisted = JSON.parse(readFileSync(join(fixture.checkout, 'O1-out', FENCE_REPORT_FILE), 'utf8'))
  assert.equal(Boolean(persisted.lanes[0].fence_admissions?.some((row) => row.file === heldTest)), false)
})

DIRECT && test('P1a keeps external-fence-stale reachable before admission', () => {
  const fixture = arbitrationFixture('P1a')
  const home = join(root, 'P1a-home')
  const parentDir = join(root, 'P1a-parent')
  const external = 'external-stale'
  const externalDir = crewFixture({ home, repoDir: 'dt-external-stale', laneDir: external, lane: external, checkout: fixture.checkout })
  put(join(externalDir, 'returns', 'task.json'), JSON.stringify({ status: 'done' }))
  const logs = []
  const error = thrown(() => checkFences({
    fences: [...fixture.fences, entry(external, ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [fixture.firstFile] }, { lane: 'lane-b', where: [fixture.secondFile] }],
    checkout: fixture.checkout,
    externals: [external],
    parentDir,
    deps: { home, log: (line) => logs.push(String(line)) },
  }))
  assert.equal(error.reason, 'external-fence-stale')
  assert.equal(logs.some((line) => line.includes('fence-admitted')), false)
})

DIRECT && test('P1b keeps external-fence-abandoned reachable before admission', () => {
  const fixture = arbitrationFixture('P1b')
  const home = join(root, 'P1b-home')
  const parentDir = join(root, 'P1b-parent')
  const external = 'external-abandoned'
  const now = 10 * 60 * 60 * 1000
  const staleAfter = DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS
  crewFixture({ home, repoDir: 'dt-external-abandoned', laneDir: external, lane: external, checkout: fixture.checkout, at: now - staleAfter - 1 })
  const logs = []
  const error = thrown(() => checkFences({
    fences: [...fixture.fences, entry(external, ['README.md'])],
    lanes: [{ lane: 'lane-a', where: [fixture.firstFile] }, { lane: 'lane-b', where: [fixture.secondFile] }],
    checkout: fixture.checkout,
    externals: [external],
    parentDir,
    deps: { home, now: () => now, log: (line) => logs.push(String(line)) },
  }))
  assert.equal(error.reason, 'external-fence-abandoned')
  assert.equal(logs.some((line) => line.includes('fence-admitted')), false)
})

DIRECT && test('path reach rejects an absolute basename collision', () => {
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

DIRECT && test('path reach resolves joined repository segments', () => {
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

DIRECT && test('path reach preserves import, symbol, and path rows byte for byte', () => {
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

DIRECT && test('the path fact names the file reached by path', () => {
  const checkout = twoOwnerReachFixture('path-owner')
  const ownerB = ['lib', 'owner-b.mjs'].join('/')
  const testFile = ['test', 'two-owner.test.mjs'].join('/')
  const row = testsOutsideFence({
    surface: [ ['lib', 'owner-a.mjs'].join('/'), ownerB ], fenceFiles: [], reach: collectTestReach({ checkout }),
  }).find((candidate) => candidate.test === testFile && candidate.how === 'path')
  assert.deepEqual(row, { test: testFile, file: ownerB, hops: null, how: 'path', symbols: [] })
})

DIRECT && test('D1', () => {
  const checkout = gitFixture()
  put(join(checkout, 'crew', 'shared.mjs'), `${Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n')}\n`)
  assert.doesNotThrow(() => checkFences({
    fences: [
      entry('lane-a', ['crew/shared.mjs:1-10']),
      entry('lane-b', ['crew/shared.mjs:11-20']),
    ],
    lanes: [
      { lane: 'lane-a', where: ['crew/shared.mjs'] },
      { lane: 'lane-b', where: ['crew/shared.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'span-disjoint-home'), log: () => {} },
  }))
})

DIRECT && test('E1', () => {
  const checkout = gitFixture()
  put(join(checkout, 'crew', 'shared.mjs'), `${Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n')}\n`)
  const first = 'crew/shared.mjs:1-10'
  const second = 'crew/shared.mjs:10-20'
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', [first]), entry('lane-b', [second])],
    lanes: [
      { lane: 'lane-a', where: ['crew/shared.mjs'] },
      { lane: 'lane-b', where: ['crew/shared.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'span-overlap-home'), log: () => {} },
  }))
  assert.equal(error.reason, 'sibling-leak')
  for (const token of ['lane-a', 'lane-b', first, second]) assert.ok(error.message.includes(token), `E1 omitted ${token}`)
})

DIRECT && test('F1a', () => {
  const checkout = gitFixture()
  assert.doesNotThrow(() => checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('lane-b', ['src/stale.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['src/owned.mjs'] },
      { lane: 'lane-b', where: ['src/stale.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'legacy-files-home'), log: () => {} },
  }))
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/owned.mjs']), entry('lane-b', ['src/owned.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['src/owned.mjs'] },
      { lane: 'lane-b', where: ['src/owned.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'legacy-file-overlap-home'), log: () => {} },
  }))
  assert.equal(error.reason, 'sibling-leak')
})

DIRECT && test('F1b', () => {
  const checkout = gitFixture()
  assert.doesNotThrow(() => checkFences({
    fences: [entry('lane-a', ['src/sub/']), entry('lane-b', ['src/other.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['src/sub/'] },
      { lane: 'lane-b', where: ['src/other.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'legacy-directory-home'), log: () => {} },
  }))
  const error = thrown(() => checkFences({
    fences: [entry('lane-a', ['src/sub/']), entry('lane-b', ['src/sub/file.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['src/sub/'] },
      { lane: 'lane-b', where: ['src/sub/file.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'legacy-directory-overlap-home'), log: () => {} },
  }))
  assert.equal(error.reason, 'sibling-leak')
})

DIRECT && test('cross-batch refusal names the live lane, file, and crew directory', () => {
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

DIRECT && test('claim recovery uses parsed lane_name instead of the slugged crew directory', () => {
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

DIRECT && test('foreign archived claims do not contaminate same-repository claim recovery', () => {
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

DIRECT && test('a stale archived claim does not satisfy a solo live lane', () => {
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

DIRECT && test('an unreadable crew root is unknown and does not refuse', () => {
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

DIRECT && test('an unreadable crew repository child leaves the live set unknown', () => {
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

DIRECT && test('an absent crew root is a cleared empty set without an unknown warning', () => {
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

DIRECT && test('archived lanes are claim sources but never live collision claimants', () => {
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

DIRECT && test('a live lane named by this batch is recorded as own and does not collide', () => {
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

DIRECT && test('a live lane in another git repository is foreign and does not collide', () => {
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

DIRECT && test('cross-batch collision matches directory and file scopes in either direction', () => {
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

DIRECT && test('test reach enumerates for any existing fenced surface and only once per batch', () => {
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

DIRECT && test('checkFences refuses sibling leakage before any worktree subprocess', () => {
  const fences = [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])]
  const lanes = [{ lane: 'lane-a', where: ['crew/shared.mjs'] }, { lane: 'lane-b', where: ['crew/shared.mjs'] }]
  refusal(() => checkFences({ fences, lanes }), 'sibling-leak')
})

DIRECT && test('checkFences still refuses a batch lane absent from the register', () => {
  // This is the pre-existing direction of the same invariant: batch membership without a register entry.
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned-a.mjs'])],
    lanes: [
      { lane: 'lane-a', where: ['crew/owned-a.mjs'] },
      { lane: 'lane-b', where: ['crew/owned-b.mjs'] },
    ],
  }), 'lane-unfenced')
})

DIRECT && test('checkFences pins own coverage, register membership, and scope entry shape', () => {
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

DIRECT && test('A1 warns for a pinned file in the write surface when its manifest is unfenced', () => {
  const checkout = join(root, 'anchor-warning-a1-checkout')
  const file = 'crew/owned.mjs'
  const manifest = 'skills/backend-node/anchors.json'
  put(join(checkout, ...file.split('/')), 'export const OWNED = 1\n')
  anchorFixtures(checkout, { 'backend-node': { 'crew/owned.mjs:1': 'export const OWNED = 1' } })
  const report = checkFences({
    fences: [entry('lane-a', [file])],
    lanes: [{ lane: 'lane-a', where: [file] }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  const warnings = report.warnings.filter(({ kind }) => kind === 'anchor-pin')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].text.includes(manifest))
  assert.ok(warnings[0].text.includes('WILL owe the repair'))
  assert.ok(warnings[0].text.includes('cannot reach it'))
})

DIRECT && test('B1 stays silent when the pinning manifest is fenced', () => {
  const checkout = join(root, 'anchor-warning-b1-checkout')
  const file = 'crew/owned.mjs'
  const manifest = 'skills/backend-node/anchors.json'
  put(join(checkout, ...file.split('/')), 'export const OWNED = 1\n')
  anchorFixtures(checkout, { 'backend-node': { 'crew/owned.mjs:1': 'export const OWNED = 1' } })
  const report = checkFences({
    fences: [entry('lane-a', [file, manifest])],
    lanes: [{ lane: 'lane-a', where: [file] }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  assert.equal(report.warnings.some(({ kind }) => kind === 'anchor-pin'), false)
})

DIRECT && test('C1 stays silent when the write surface contains no pinned file', () => {
  const checkout = join(root, 'anchor-warning-c1-checkout')
  const file = 'crew/owned.mjs'
  put(join(checkout, ...file.split('/')), 'export const OWNED = 1\n')
  const fences = [entry('lane-a', [file])]
  const lanes = [{ lane: 'lane-a', where: [file] }]
  const before = checkFences({ fences, lanes, checkout, deps: { home: root, log: () => {} } })
  anchorFixtures(checkout, { 'backend-node': { 'crew/untouched.mjs:1': 'export const UNTOUCHED = 1' } })
  const after = checkFences({ fences, lanes, checkout, deps: { home: root, log: () => {} } })
  assert.equal(before.warnings.some(({ kind }) => kind === 'anchor-pin'), false)
  assert.equal(after.warnings.some(({ kind }) => kind === 'anchor-pin'), false)
  assert.deepEqual(after.perLane, before.perLane)
})

DIRECT && test('G1 replays the b593 crew drive manifest collision', () => {
  const checkout = gitFixture()
  const file = 'crew/drive.mjs'
  const manifest = 'skills/crew-recovery/anchors.json'
  put(join(checkout, ...file.split('/')), 'export const DRIVE = 1\n')
  anchorFixtures(checkout, { 'crew-recovery': { 'crew/drive.mjs:1': 'export const DRIVE = 1' } })
  const report = checkFences({
    fences: [entry('lane-a', [file])],
    lanes: [{ lane: 'lane-a', where: [file] }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  const warning = report.warnings.find(({ kind }) => kind === 'anchor-pin')
  assert.ok(warning)
  assert.ok(warning.text.includes(manifest))
  assert.ok(warning.text.includes('added to its fence'))
})

DIRECT && test('an anchor warning names both pinned files, all manifests, and every line key', () => {
  const checkout = join(root, 'anchor-warning-details-checkout')
  const fixture = warningFixture(checkout)
  const report = checkFences({
    fences: [entry('lane-a', fixture.files)],
    lanes: [{ lane: 'lane-a', where: fixture.files }],
    checkout,
    deps: { home: root, log: () => {} },
  })
  const text = report.warnings.find(({ kind }) => kind === 'anchor-pin').text
  for (const token of [...fixture.files, ...fixture.manifestPaths, ...fixture.keys]) {
    assert.equal(text.includes(token), true, `warning omitted ${token}`)
  }
})

DIRECT && test('two lanes with external manifests warn without refusing', () => {
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

DIRECT && test('a directory write surface still warns for a pinned descendant', () => {
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

DIRECT && test("b220's corrected fence owns both pinning manifests and passes silently", () => {
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

DIRECT && test('a batch touching no pinned file passes and reads each manifest once', () => {
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

DIRECT && test('checkFences raises no citation-carrier warning when the doc is fenced', () => {
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

DIRECT && test('RV1-1 arbitrates duplicate automatic admissions in batch order', () => {
  const checkout = reachFixture('rv1-1-effective-overlap', {
    files: {
      'crew/acp-client.mjs': 'export const acpClient = true\n',
      'crew/capabilities.mjs': 'export const capabilities = true\n',
      'crew/acp-client.test.mjs': [
        "import { acpClient } from './acp-client.mjs'",
        "import { capabilities } from './capabilities.mjs'",
        'void acpClient',
        'void capabilities',
        '',
      ].join('\n'),
    },
  })
  const report = checkFences({
    fences: [
      entry('lane-x', ['crew/acp-client.mjs']),
      entry('lane-y', ['crew/capabilities.mjs']),
    ],
    lanes: [
      { lane: 'lane-x', where: ['crew/acp-client.mjs'] },
      { lane: 'lane-y', where: ['crew/capabilities.mjs'] },
    ],
    checkout,
    deps: { home: join(root, 'rv1-1-home'), log: () => {} },
  })
  const shared = 'crew/acp-client.test.mjs'
  assert.deepEqual(report.admissions.filter((row) => row.file === shared), [
    { lane: 'lane-x', file: shared, source: 'test-reach' },
  ])
  assert.equal(report.perLane['lane-x'].files.includes(shared), true)
  assert.equal(report.perLane['lane-y'].files.includes(shared), false)
  const warning = report.warnings.find((row) => row.kind === 'fence-admission-arbitrated' && row.file === shared)
  assert.equal(warning.holder.lane, 'lane-x')
})
