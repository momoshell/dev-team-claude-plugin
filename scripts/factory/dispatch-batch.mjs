#!/usr/bin/env node
// scripts/factory/dispatch-batch.mjs — executable batch dispatch (#584).
// It owns the ordered checks between a batch request directory and background
// crew runs; every failed check is a named refusal and stops the batch.

import { appendFileSync, closeSync, existsSync as fsExistsSync, openSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn as childSpawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseDirectedBrief, scopeMatcher, validateScopeEntries as driveValidateScopeEntries, VARIANT_NAMES, VARIANTS } from '../../crew/drive.mjs'
import { assertHostQuiet, hostLoad, loadPolicy, withSuiteSlot } from '../../crew/host-load.mjs'
import { protectedHitsIn, resolveProtectedPaths } from '../../crew/protected-paths.mjs'
import { slug } from '../../crew/slug.mjs'
import { LADDER_BANDS, PROPOSAL_BLOCK, TIER_NAMES, extractSymbols, gatherFences, isTripwireFile, validateRequest } from './make-brief.mjs'
import { archivedLanes, crewRoot, discoverLanes, DRIVER_GONE_PERIODS, HEARTBEAT_PERIOD_MS, laneActive, readJournal } from './lane-watch.mjs'

const BATCH_EMPTY = 'batch-empty'
const BATCH_UNREADABLE = 'batch-unreadable'
const TRANSPORT_CONFLICT = 'transport-conflict'
const LANE_UNFENCED = 'lane-unfenced'
const SCOPE_ENTRY_INVALID = 'scope-entry-invalid'
const WHERE_OUTSIDE_FENCE = 'where-outside-fence'
const SIBLING_LEAK = 'sibling-leak'
const WORKTREE_EXISTS = 'worktree-exists'
const BRANCH_TAKEN = 'branch-taken'
const WORKTREE_FAILED = 'worktree-failed'
const COMPILE_REFUSED = 'compile-refused'
const READS_UNRESOLVED = 'reads-unresolved'
const TIER_FLOOR_CONFLICT = 'tier-floor-conflict'
const BOOT_FAILED = 'boot-failed'
const FENCE_NOT_ARRIVED = 'fence-not-arrived'
const FENCE_COUNT_MISMATCH = 'fence-count-mismatch'
const RUN_FAILED = 'run-failed'
const DEPENDENCY_CYCLE = 'dependency-cycle'
const DEPENDENCY_UNKNOWN = 'dependency-unknown'
const DEPENDENT_BASE_STALE = 'dependent-base-stale'
const PLAN_SCOPE_OUTSIDE_FENCE = 'plan-scope-outside-fence'
const GRAPH_UNMEASURED = 'graph-unmeasured'
const LANE_SHAPE_INVALID = 'lane-shape-invalid'
const FENCE_REGISTER_MISMATCH = 'fence-register-mismatch'
const DIRECTED_BRIEF_INVALID = 'directed-brief-invalid'
const SEAT_FLOOR_CONFLICT = 'seat-floor-conflict'
const CROSS_BATCH_COLLISION = 'cross-batch-collision'
const PLAN_ADOPT_UNREADABLE = 'plan-adopt-unreadable'
const EXTERNAL_FENCE_STALE = 'external-fence-stale'
const EXTERNAL_FENCE_ABANDONED = 'external-fence-abandoned'

export const REFUSAL_REASONS = Object.freeze([
  BATCH_EMPTY,
  BATCH_UNREADABLE,
  TRANSPORT_CONFLICT,
  LANE_UNFENCED,
  SCOPE_ENTRY_INVALID,
  WHERE_OUTSIDE_FENCE,
  SIBLING_LEAK,
  WORKTREE_EXISTS,
  BRANCH_TAKEN,
  WORKTREE_FAILED,
  COMPILE_REFUSED,
  READS_UNRESOLVED,
  TIER_FLOOR_CONFLICT,
  BOOT_FAILED,
  FENCE_NOT_ARRIVED,
  FENCE_COUNT_MISMATCH,
  RUN_FAILED,
  DEPENDENCY_CYCLE,
  DEPENDENCY_UNKNOWN,
  DEPENDENT_BASE_STALE,
  PLAN_SCOPE_OUTSIDE_FENCE,
  GRAPH_UNMEASURED,
  LANE_SHAPE_INVALID,
  FENCE_REGISTER_MISMATCH,
  DIRECTED_BRIEF_INVALID,
  SEAT_FLOOR_CONFLICT,
  CROSS_BATCH_COLLISION,
  PLAN_ADOPT_UNREADABLE,
  EXTERNAL_FENCE_STALE,
  EXTERNAL_FENCE_ABANDONED,
])

export const CROSS_BATCH_UNKNOWN_PREFIX = 'dispatch-batch: WARNING cross-batch-unknown:'
export const CROSS_BATCH_BLIND_SPOT = 'BLIND SPOT: a lane booted without --fences declares no surface at all and can be editing anything; a lane whose batch siblings have been reaped records no claim; and a repository whose git dir cannot be measured is not compared. None of those are cleared — they are reported unknown.'

// A fence carried in from another batch is not a sibling: the operator must see WHICH
// live lane it came from and that it was never counted in the arrival total checkArrival derives (#845).
export const EXTERNAL_FENCE_PREFIX = 'dispatch-batch: external-fence'
export const EXTERNAL_REGISTER_NAME = 'dispatch.external.fences.json'

export const ROLES_ANCHOR_MANIFEST = 'crew/roles/anchors.json'
export const ROLES_ANCHOR_COMPANIONS = Object.freeze(['crew/roles/planner.md', 'crew/roles/tech-lead.md'])

// The scan reads anchors.json manifests, which are machine-readable. Prose file:line
// citations in .md files are not, and a heuristic over prose would refuse every doc that
// mentions a line number. The check therefore states what it cannot see rather than
// implying a completeness it does not have.
export const ANCHOR_BLIND_SPOT = 'BLIND SPOT: prose file:line citations in .md files are not discoverable from anchors.json and this check does not find them; look for them by hand before re-dispatching this lane'

// The scan survives; the refusal does not. #635 made a shifted anchor repairable, so a
// pin outside a lane's fence is a fact an operator should SEE, not a batch outcome.
export const ANCHOR_PIN_WARNING_PREFIX = 'dispatch-batch: WARNING anchor-pin-unfenced:'

// These two names belong to the compiler. The batch dispatcher parses its
// refusal text but deliberately does not add compiler names to its own list.
export const COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'
export const STALE_READ_ACK = 'stale-read-ack'

export const PREDECESSOR_ESCALATED = 'predecessor-escalated'
export const PREDECESSOR_UNSETTLED = 'predecessor-unsettled'
export const DISPATCH_BASE_REF = 'main'

export const REQUEST_SUFFIX = '.request.json'

// Keys a lane's request carries for the DISPATCHER, not for the compiler. The
// compiler's request schema is closed (REQUEST_KEYS, make-brief.mjs:51), so a
// dispatch-only key is split off here and never reaches the compiled request.
export const DISPATCH_ONLY_REQUEST_KEYS = Object.freeze(['tier', 'depends_on', 'variant', 'seats', 'adopt'])
// The transports a dispatched batch can boot. Headless is the software-factory
// mode and stays the DEFAULT, so an unflagged batch behaves exactly as it did
// before this flag existed. #617 made the transport STATED; it is choosable
// here because the observability meant to replace panes does not exist yet, so
// until the visualizer can monitor a live lane a pane workspace is the only
// surface a running lane has. Both constants ARE their flag names: one string
// for the flag boot passes, the flag the caller types, and the transport the
// closing line names, so the three cannot drift apart.
export const BOOT_TRANSPORT = 'headless-all'
export const PANE_TRANSPORT = 'panes'
export const COMPILE_REQUEST_SUFFIX = '.compile-request.json'

// Plan adoption (#763). A re-dispatched lane whose predecessor already wrote a plan
// reads it out of its own task dir instead of planning again, and the block that says
// so is the SAME sentence every time — never a per-lane paragraph typed by hand.
export const ADOPT_REQUIRED = Object.freeze(['plan.md', 'gate.mjs'])
export const ADOPT_OPTIONAL = Object.freeze(['plan-check.md'])
export const ADOPT_REVISE_MARKER = 'VERDICT: revise'
export const ADOPT_EVENT = 'plan-adopted'
export const ADOPT_BLOCK = [
  '',
  '## Adopted plan',
  '',
  'Your task dir ALREADY holds plan.md and gate.mjs, copied from a previous attempt at',
  'this same task. Read both before you plan anything. If they hold, ADOPT them: leave',
  'the files as they are, say so in your summary, and return the envelope that points at',
  'them. If they do not hold, AMEND the smallest part that is wrong and say what you',
  'changed and why. Do not re-plan from nothing — re-deriving a plan that already holds',
  'is the cost this block exists to remove.',
  '',
  'Your files_in_scope may never exceed the dispatched write surface this lane was given,',
  'named under files_in_scope in the Conventions section of this brief. The adopted plan was',
  'scoped to a PREVIOUS attempt and this fence may be NARROWER: narrow the adopted scope to',
  'that surface and say so. The scope guard measures the fence you were dispatched with,',
  'never the one the archive remembers.',
  '',
].join('\n')
export const ADOPT_FINDINGS_CLAUSE = [
  'The previous attempt was BOUNCED: your task dir also holds plan-check.md carrying',
  `${ADOPT_REVISE_MARKER}. Close every finding it names FIRST, and say per finding whether`,
  'you closed it or why it does not apply.',
  '',
].join('\n')

// The four per-role boot flags crew.mjs already accepts (ROLE_FLAG_PREFIXES,
// crew/crew.mjs:2488) and the request-key spelling of each. Mirrored rather
// than imported: importing crew/crew.mjs would pull the whole boot graph into
// a dispatcher that only needs four names. test/factory-dispatch-batch.test.mjs
// pins the two surfaces together, exactly as MISCLASSIFIED_PREFIX is pinned.
export const SEAT_FIELDS = Object.freeze({
  agent: 'agent-', model: 'model-', effort: 'effort-', allow_shortfall: 'allow-shortfall-',
})
// crew.mjs boot reads all three (KNOWN_FLAGS.boot, crew/crew.mjs:2448) and each carries a value
// (FLAG_VALUE_CONTRACT, crew/crew.mjs:2471). The dispatcher forwards what it was given, verbatim,
// and never invents a default.
export const BOOT_MEMORY_FLAGS = Object.freeze(['memory-dir', 'memory-backend', 'memory-budget-bytes'])

function memoryFlagArgs(runFlags = {}) {
  const args = []
  for (const flag of BOOT_MEMORY_FLAGS) {
    const value = runFlags[flag]
    if (value === undefined || value === null || value === '') continue
    args.push(`--${flag}`, String(value))
  }
  return args
}
// The ratified staffing artifact. A lane may not staff a role its settled tier
// does not seat, and crew/roster.json is where that is ratified.
export const ROSTER_PATH = fileURLToPath(new URL('../../crew/roster.json', import.meta.url))
// Boot's own closed band-floor reason enum (crew/crew.mjs:645). A boot refusal
// carrying one of these is a ratified FLOOR refusal, not a generic boot failure,
// and the dispatcher names it rather than swallowing it as boot-failed.
export const BAND_FLOOR_REASONS = Object.freeze([
  'ladder-unreadable', 'floor-unratified', 'band-unknown', 'band-below-floor',
])

// #291 step 3: the compiler computes SHAPE (risk) and STRENGTH (complexity) on two
// axes and the dispatcher recorded only the collapsed tier word, so no operator and
// no later ledger query could join a matrix cell to its cost or its outcome. The
// pair is READ out of the compiler's own ```proposal block — never re-derived here,
// because a second derivation is a second answer to a question already answered.
export const DISPATCH_RECORD_SUFFIX = '.dispatch.json'
// Absence is not zero: a brief carrying no proposal block records null, never a
// stand-in shape. The word the log prints for that null.
export const STAFFING_ABSENT = 'absent'
// A copy of make-brief.mjs:1178, which is not exported and whose file this lane may
// not touch. test/factory-dispatch-batch.test.mjs pins the two surfaces together.
export const MISCLASSIFIED_PREFIX = 'misclassified · shape mechanical has no reinforced column'
const ABSENT_STAFFING = Object.freeze({ shape: null, strength: null, misclassification: null })

// A dry run reports success in the same tone a fully validated dispatch would, and an
// operator read that as validation, split a batch and dispatched it twice (#658). Nothing has
// booted here, so every check reading booted state is STRUCTURALLY unreachable; the closing
// line names them rather than leaving an absence to read as a pass.
export const DRY_RUN_BLIND_SPOT = 'dispatch-batch: dry-run BLIND SPOT — nothing booted, so every check that reads booted state is unreachable from here: fence arrival and the sibling count in a lane crew.json, boot and workspace failures, compiler refusals, and every journal or run outcome. A green dry run is not a validated dispatch.'

export const TEST_REACH_DEPTH = 2
export const TEST_REACH_ROW_LIMIT = 12
export const SYMBOL_FANOUT_LIMIT = 8
export const TEST_REACH_WARNING_PREFIX = 'dispatch-batch: WARNING test-reach-unfenced:'
export const TEST_REACH_BLIND_SPOT = 'BLIND SPOT: this is a proxy in BOTH directions and names candidates, never proof. A test can assert the changed behaviour through a higher-level entry point without importing the changed file at all, and a computed dynamic import is invisible to a static scan — crew/crew.mjs loads every adapter that way. A test can equally import a fenced file without asserting anything about the part being changed. The literal symbol scan sees only whole-word occurrences of an exported name, is blind to a renamed re-export, and drops any symbol naming more than 8 test files as too broad to be evidence. Read the named files before choosing this fence; an unnamed one is not cleared.'
const CODE_SUFFIX = /\.(?:mjs|js)$/
const IMPORT_SPECIFIER = /(?:^|[\n;])\s*(?:import|export)[^\n;]*?from\s*['\"]([^'\"]+)['\"]|\bimport\(\s*['\"]([^'\"]+)['\"]\s*\)/g

function emptyTestReach() {
  return {
    byFile: new Map(),
    tests: new Map(),
    files: [],
    depth: TEST_REACH_DEPTH,
    symbolsFor: () => [],
  }
}

function sourceText(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return String(value)
}

function repoPathFor(root, file) {
  return join(root, ...normaliseRepoPath(file).split('/'))
}

function importedPath(file, specifier, codeFiles) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null
  const target = normaliseRepoPath(join(dirname(file), specifier))
  const candidates = [target, `${target}.mjs`, `${target}.js`, `${target}/index.mjs`, `${target}/index.js`]
  return candidates.find((candidate) => codeFiles.has(candidate)) || null
}

function importsFrom(source, file, codeFiles) {
  const imported = []
  if (typeof source !== 'string' || source.length === 0) return imported
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const target = importedPath(file, match[1] || match[2], codeFiles)
    if (target && !imported.includes(target)) imported.push(target)
  }
  return imported
}

export function collectTestReach({ checkout, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  let result
  try {
    result = d.spawn({
      file: 'git',
      args: ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      cwd: root,
    })
  } catch {
    return emptyTestReach()
  }
  if (!result || (result.status !== 0 && result.status !== null)) return emptyTestReach()
  const files = [...new Set(sourceText(result.stdout)
    .split('\0')
    .map(normaliseRepoPath)
    .filter(Boolean))].sort()
  const codeFiles = new Set(files.filter((file) => CODE_SUFFIX.test(file)))
  const sourceByFile = new Map()
  const readSource = (file) => {
    const normal = normaliseRepoPath(file)
    if (sourceByFile.has(normal)) return sourceByFile.get(normal)
    let source = ''
    try { source = sourceText(d.readFileSync(repoPathFor(root, normal), 'utf8')) } catch { /* unreadable files cannot contribute edges or symbols */ }
    sourceByFile.set(normal, source)
    return source
  }
  const tests = new Map()
  for (const file of files) {
    if (codeFiles.has(file) && isTripwireFile(file)) tests.set(file, readSource(file))
  }
  const byFile = new Map()
  const importsByFile = new Map()
  const importsFor = (file) => {
    const normal = normaliseRepoPath(file)
    if (!importsByFile.has(normal)) importsByFile.set(normal, importsFrom(readSource(normal), normal, codeFiles))
    return importsByFile.get(normal)
  }
  for (const [test, source] of tests) {
    const seen = new Map([[test, 0]])
    const pending = [{ file: test, hops: 0, source }]
    while (pending.length > 0) {
      const current = pending.shift()
      // ONE bound, not two. A second guard at the depth limit
      // made the bound below unreachable-when-false, so widening the bound changed
      // nothing and the R3 mutation PR #708 declared SURVIVED its own check. The walk
      // still terminates: nothing is pushed above the bound. #699.
      for (const file of importsFor(current.file)) {
        const hops = current.hops + 1
        if (hops <= TEST_REACH_DEPTH) {
          const prior = seen.get(file)
          if (prior !== undefined && prior <= hops) continue
          seen.set(file, hops)
          pending.push({ file, hops })
          if (!byFile.has(file)) byFile.set(file, new Map())
          const perTest = byFile.get(file)
          if (!perTest.has(test) || hops < perTest.get(test)) perTest.set(test, hops)
        }
      }
    }
  }
  const symbolCache = new Map()
  const symbolsFor = (file) => {
    const normal = normaliseRepoPath(file)
    if (!codeFiles.has(normal)) return []
    if (!symbolCache.has(normal)) symbolCache.set(normal, extractSymbols(readSource(normal), normal))
    return symbolCache.get(normal)
  }
  return { byFile, tests, files, depth: TEST_REACH_DEPTH, symbolsFor }
}

function wholeWord(source, symbol) {
  if (typeof source !== 'string' || typeof symbol !== 'string' || symbol.length === 0) return false
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(source)
}

export function testsOutsideFence({ surface, fenceFiles, reach } = {}) {
  const ownSurface = (Array.isArray(surface) ? surface : []).filter((file) => typeof file === 'string').map(normaliseRepoPath)
  const ownFence = (Array.isArray(fenceFiles) ? fenceFiles : []).filter((file) => typeof file === 'string').map(normaliseRepoPath)
  const matchesSurface = scopeMatcher(ownSurface)
  const inFence = scopeMatcher(ownFence)
  const byTest = new Map()
  const byFile = reach?.byFile instanceof Map ? reach.byFile : new Map()
  for (const [fileValue, perTest] of byFile) {
    const file = normaliseRepoPath(fileValue)
    if (!matchesSurface(file) || !(perTest instanceof Map)) continue
    for (const [testValue, hopsValue] of perTest) {
      const test = normaliseRepoPath(testValue)
      if (inFence(test)) continue
      const hops = Number.isFinite(hopsValue) ? hopsValue : null
      const row = byTest.get(test)
      if (!row || row.hops === null || (hops !== null && hops < row.hops)) {
        byTest.set(test, { test, file, hops, how: 'import', symbols: row ? row.symbols : [] })
      }
    }
  }
  const tests = reach?.tests instanceof Map ? reach.tests : new Map()
  const files = (Array.isArray(reach?.files) ? reach.files : [])
    .filter((file) => typeof file === 'string' && CODE_SUFFIX.test(file) && matchesSurface(file))
  for (const owner of files) {
    let symbols
    try { symbols = reach?.symbolsFor?.(owner) } catch { symbols = [] }
    if (!Array.isArray(symbols)) continue
    for (const symbol of symbols) {
      const hits = []
      for (const [testValue, source] of tests) {
        const test = normaliseRepoPath(testValue)
        if (inFence(test) || test === owner) continue
        if (wholeWord(source, symbol)) hits.push(test)
      }
      if (hits.length === 0 || hits.length > SYMBOL_FANOUT_LIMIT) continue
      for (const test of hits) {
        const row = byTest.get(test) || { test, file: owner, hops: null, how: 'symbol', symbols: [] }
        if (!row.symbols.includes(symbol)) row.symbols = [...row.symbols, symbol].sort()
        byTest.set(test, row)
      }
    }
  }
  return [...byTest.values()].sort((a, b) => {
    const left = a.hops === null ? TEST_REACH_DEPTH + 1 : a.hops
    const right = b.hops === null ? TEST_REACH_DEPTH + 1 : b.hops
    return left - right || (a.test < b.test ? -1 : a.test > b.test ? 1 : 0)
  })
}

function reachRowText(row) {
  const hops = row.hops === null ? 'symbol-only' : `hops=${row.hops}`
  const symbols = row.symbols.length > 0 ? ` symbols=${row.symbols.join(',')}` : ''
  return `${row.test} -> ${row.file} (${hops}, how=${row.how}${symbols})`
}

export class BatchRefusal extends Error {
  constructor(message, reason) {
    super(`dispatch-batch: ${message}`)
    this.name = 'BatchRefusal'
    this.reason = reason
  }
}

function refuse(message, reason) { throw new BatchRefusal(message, reason) }

function spawnAsyncDefault({ file, args, cwd, env }) {
  return new Promise((resolve) => {
    const child = childSpawn(file, args, { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ status: null, error, stdout, stderr }))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function spawnBackground({ file, args, cwd, env, logPath }) {
  let fd
  try {
    fd = openSync(logPath, 'a')
    const child = childSpawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    if (!child) return { status: null, error: new Error('background spawn returned no child') }
    child.on('error', (err) => {
      try { writeFileSync(logPath, `[spawn error: ${err?.message || String(err)}]\n`, { flag: 'a' }) } catch { /* the child failure is already represented by its log path */ }
    })
    child.unref()
    return child
  } catch (err) {
    return { status: null, error: err }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* the child owns its inherited descriptors */ }
    }
  }
}

export function normalDeps(deps = {}) {
  return {
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    writeFileSync: deps.writeFileSync || writeFileSync,
    appendFileSync: deps.appendFileSync || appendFileSync,
    readdirSync: deps.readdirSync || fsReaddirSync,
    mkdirSync: deps.mkdirSync || mkdirSync,
    home: deps.home || homedir(),
    spawn: deps.spawn || ((options) => options?.background
      ? spawnBackground(options)
      : spawnSync(options.file, options.args, { cwd: options.cwd, env: options.env, encoding: 'utf8' })),
    env: deps.env || process.env,
    spawnAsync: deps.spawnAsync || deps.spawn || spawnAsyncDefault,
    assertQuiet: deps.assertQuiet || ((env) => assertHostQuiet(hostLoad({ policy: loadPolicy(env) }))),
    log: deps.log || ((line) => process.stdout.write(`${line}\n`)),
    // Suite-slot seams (#825): pass-through only. withSuiteSlot owns their
    // defaults, so an absent seam must stay `undefined` rather than become null.
    now: deps.now,
    sleep: deps.sleep,
    slots: deps.slots,
  }
}

function normaliseRepoPath(value) {
  const normal = String(value).replaceAll('\\', '/')
  if (normal === './') return '.'
  return normal.startsWith('./') ? normal.slice(2) : normal
}

// A lane whose name cannot be resolved used to become '' and then vanish from every
// map keyed by name — the graph simply lost it. Refuse by name instead (#634).
function laneNameOf(lane) {
  const resolved = typeof lane === 'string' ? lane
    : typeof lane?.lane === 'string' ? lane.lane
      : typeof lane?.name === 'string' ? lane.name
        : null
  if (resolved === null || resolved.trim() === '') refuse(`cannot resolve a lane name from ${JSON.stringify(lane)}; a lane is a non-empty string, or an object carrying a non-empty lane or name string`, LANE_SHAPE_INVALID)
  return resolved
}

function laneWhereOf(lane) {
  if (lane && Array.isArray(lane.where)) return lane.where.map(normaliseRepoPath)
  if (lane && Array.isArray(lane.request?.where)) return lane.request.where.map(normaliseRepoPath)
  return []
}

function laneCreatesOf(lane) {
  if (lane && Array.isArray(lane.creates)) return lane.creates.map(normaliseRepoPath)
  if (lane && Array.isArray(lane.request?.creates)) return lane.request.creates.map(normaliseRepoPath)
  return []
}

function fenceEntriesOf(fences) {
  if (Array.isArray(fences)) return fences
  if (fences && Array.isArray(fences.lanes)) return fences.lanes
  return []
}

function normaliseFence(entry) {
  return {
    ...entry,
    lane: typeof entry?.lane === 'string' ? entry.lane : String(entry?.lane ?? ''),
    files: Array.isArray(entry?.files)
      ? entry.files.map((file) => typeof file === 'string' ? normaliseRepoPath(file) : file)
      : entry?.files,
    reads: Array.isArray(entry?.reads)
      ? entry.reads.map((read) => ({ ...read, file: typeof read?.file === 'string' ? normaliseRepoPath(read.file) : read?.file }))
      : entry?.reads,
  }
}

function textOf(value) {
  if (value == null) return ''
  return typeof value === 'string' ? value : String(value)
}

function childFailure(result) {
  const stderr = textOf(result?.stderr)
  const stdout = textOf(result?.stdout)
  const error = result?.error ? textOf(result.error.message || result.error) : ''
  const signal = result?.signal ? `signal ${result.signal}` : ''
  return stderr || error || signal || stdout || `exit ${String(result?.status)}`
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function seatsDefect(value) {
  if (!plainObject(value)) return 'expected a plain object of role seat overrides'
  for (const [role, fields] of Object.entries(value)) {
    if (!plainObject(fields)) return `role ${JSON.stringify(role)} must carry a plain object of seat fields`
    for (const [field, setting] of Object.entries(fields)) {
      if (!Object.hasOwn(SEAT_FIELDS, field)) return `role ${JSON.stringify(role)} names an unknown seat field ${JSON.stringify(field)}; expected ${Object.keys(SEAT_FIELDS).join(', ')}`
      if (typeof setting !== 'string' || setting.length === 0) return `role ${JSON.stringify(role)} field ${field} must be a non-empty string`
    }
  }
  return null
}

// A dispatch-only key travels with the lane it describes. The tier value is
// checked here rather than at boot so a typo names its own file.
function splitDispatchKeys(parsed, requestPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { dispatch: {}, request: parsed }
  const dispatch = {}
  const request = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (DISPATCH_ONLY_REQUEST_KEYS.includes(key)) dispatch[key] = value
    else request[key] = value
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, 'tier') && !TIER_NAMES.includes(dispatch.tier)) {
    refuse(`request ${requestPath} names an unknown tier ${JSON.stringify(dispatch.tier)}; expected one of ${TIER_NAMES.join(', ')}`, BATCH_UNREADABLE)
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, 'depends_on')
      && (!Array.isArray(dispatch.depends_on)
        || !dispatch.depends_on.every((dep) => typeof dep === 'string' && dep.trim() !== ''))) {
    refuse(`request ${requestPath} has an invalid depends_on; expected an array of non-empty strings`, BATCH_UNREADABLE)
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, 'variant')
      && (typeof dispatch.variant !== 'string' || dispatch.variant.trim() === '')) {
    refuse(`request ${requestPath} has an invalid variant; expected a non-empty string naming one of ${VARIANT_NAMES.join(', ')}`, BATCH_UNREADABLE)
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, 'adopt')
      && (typeof dispatch.adopt !== 'string' || dispatch.adopt.trim() === '')) {
    refuse(`request ${requestPath} has an invalid adopt; expected a non-empty string naming an archived crew or task directory`, BATCH_UNREADABLE)
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, 'seats')) {
    const defect = seatsDefect(dispatch.seats)
    if (defect) refuse(`request ${requestPath} has an invalid seats: ${defect}`, BATCH_UNREADABLE)
  }
  return { dispatch, request }
}

export function readBatch({ batchDir, deps } = {}) {
  const d = normalDeps(deps)
  if (typeof batchDir !== 'string' || batchDir.trim() === '') {
    refuse('batch directory is required', BATCH_UNREADABLE)
  }
  const directory = resolve(batchDir)
  let names
  try {
    names = d.readdirSync(directory)
  } catch (err) {
    refuse(`cannot read batch directory ${directory}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
  }
  if (!Array.isArray(names)) refuse(`cannot enumerate batch directory ${directory}`, BATCH_UNREADABLE)
  const requestNames = names
    .map((name) => typeof name === 'string' ? name : name?.name)
    .filter((name) => typeof name === 'string' && name.endsWith(REQUEST_SUFFIX))
    .sort()
  if (requestNames.length === 0) refuse(`batch directory contains no ${REQUEST_SUFFIX} files: ${directory}`, BATCH_EMPTY)

  const lanes = []
  for (const name of requestNames) {
    const lane = name.slice(0, -REQUEST_SUFFIX.length)
    if (!lane) refuse(`request filename has no lane name: ${name}`, BATCH_UNREADABLE)
    const requestPath = join(directory, name)
    let parsed
    try {
      parsed = JSON.parse(d.readFileSync(requestPath, 'utf8'))
    } catch (err) {
      refuse(`cannot read or validate request ${requestPath}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
    }
    const { dispatch, request } = splitDispatchKeys(parsed, requestPath)
    try {
      validateRequest(request, { taskName: lane })
    } catch (err) {
      refuse(`cannot read or validate request ${requestPath}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
    }
    lanes.push({
      lane,
      name,
      request,
      tier: typeof dispatch.tier === 'string' ? dispatch.tier : null,
      variant: typeof dispatch.variant === 'string' ? dispatch.variant : null,
      seats: dispatch.seats && typeof dispatch.seats === 'object' ? dispatch.seats : null,
      adopt: typeof dispatch.adopt === 'string' ? dispatch.adopt : null,
      depends_on: Array.isArray(dispatch.depends_on) ? [...new Set(dispatch.depends_on)] : [],
      where: request.where.map(normaliseRepoPath),
      creates: Array.isArray(request.creates) ? request.creates.map(normaliseRepoPath) : [],
    })
  }
  return lanes.sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)
}

export function planWaves({ lanes } = {}) {
  // An empty wave list from a non-empty batch is never a legitimate answer, and the call
  // that produced one was planWaves(lanes): an ARRAY where the options object belongs
  // destructures to undefined and silently plans nothing (#634).
  if (!Array.isArray(lanes)) refuse(`planWaves requires { lanes: [...] } and received ${JSON.stringify(lanes)}; passing the lane array itself plans no waves at all`, LANE_SHAPE_INVALID)
  const batchLanes = lanes
  const laneNames = batchLanes.map(laneNameOf)
  const byName = new Map(batchLanes.map((lane) => [laneNameOf(lane), lane]))
  const deps = new Map()
  let hasEdges = false
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    const declared = Array.isArray(lane?.depends_on) ? lane.depends_on : []
    const unique = []
    for (const dep of declared) {
      if (!byName.has(dep)) refuse(`lane ${name} depends_on names a lane that is not in this batch: ${dep}`, DEPENDENCY_UNKNOWN)
      if (!unique.includes(dep)) unique.push(dep)
    }
    deps.set(name, unique)
    if (unique.length > 0) hasEdges = true
  }

  const depsOf = (name) => deps.get(name) || []
  const ancestors = new Map(laneNames.map((name) => [name, new Set()]))
  const pending = [...laneNames]
  const placed = new Set()
  const waves = []
  while (pending.length > 0) {
    const ready = pending.filter((lane) => depsOf(lane).every((dep) => placed.has(dep)))
    if (ready.length === 0) {
      const cycle = [...pending].sort()
      refuse(`dependency cycle among lanes: ${cycle.join(', ')}`, DEPENDENCY_CYCLE)
    }
    waves.push(ready)
    for (const name of ready) {
      const ownAncestors = ancestors.get(name)
      for (const dep of depsOf(name)) {
        ownAncestors.add(dep)
        for (const ancestor of ancestors.get(dep) || []) ownAncestors.add(ancestor)
      }
      placed.add(name)
    }
    const readySet = new Set(ready)
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (readySet.has(pending[index])) pending.splice(index, 1)
    }
  }
  return { waves, graph: { deps, ancestors, hasEdges } }
}

export function relatedLanes(graph, a, b) {
  if (!graph || !(graph.ancestors instanceof Map)) return false
  return Boolean(graph.ancestors.get(a)?.has(b) || graph.ancestors.get(b)?.has(a))
}

// Every anchors.json manifest in ONE pass, keyed by the file each pin targets. A
// lane loop must never re-read a manifest: the scan is O(manifests), not O(lanes x files).
export function collectAnchorPins({ checkout, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const byFile = new Map()
  const manifests = []
  const manifestPaths = [ROLES_ANCHOR_MANIFEST]
  let names
  try { names = d.readdirSync(join(root, 'skills')) } catch { names = [] }
  if (Array.isArray(names)) {
    for (const raw of names) {
      const name = typeof raw === 'string' ? raw : raw?.name
      if (typeof name !== 'string') continue
      manifestPaths.push(`skills/${name}/anchors.json`)
    }
  }
  for (const manifest of manifestPaths) {
    const path = join(root, manifest)
    let parsed
    try {
      if (!d.existsSync(path)) continue
      parsed = JSON.parse(d.readFileSync(path, 'utf8'))
    } catch { continue }
    manifests.push(manifest)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    for (const key of Object.keys(parsed)) {
      const at = key.lastIndexOf(':')
      if (at < 1 || !/^\d+$/.test(key.slice(at + 1))) continue
      const file = normaliseRepoPath(key.slice(0, at))
      if (!byFile.has(file)) byFile.set(file, new Map())
      const perManifest = byFile.get(file)
      if (!perManifest.has(manifest)) perManifest.set(manifest, [])
      perManifest.get(manifest).push(key)
    }
  }
  return { byFile, manifests }
}

export function anchorPinsOutsideFence({ surface, fenceFiles, pins } = {}) {
  const inFence = scopeMatcher(Array.isArray(fenceFiles) ? fenceFiles : [])
  const matchesSurface = scopeMatcher(Array.isArray(surface) ? surface : [])
  const byFile = pins && pins.byFile instanceof Map ? pins.byFile : new Map()
  const found = []
  for (const [file, perManifest] of byFile) {
    if (!matchesSurface(file)) continue
    for (const [manifest, keys] of perManifest) {
      if (inFence(manifest)) continue
      found.push({ file, manifest, keys: [...keys].sort() })
    }
  }
  return found
}

function repoCommonDir(checkout, d) {
  if (typeof checkout !== 'string' || checkout.trim() === '') return null
  const target = resolve(checkout)
  let result
  try {
    result = d.spawn({
      file: 'git',
      args: ['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      cwd: target,
    })
  } catch {
    return null
  }
  if (!result || result.error || result.signal || result.status !== 0) return null
  const output = textOf(result.stdout).trim()
  if (!output) return null
  try { return resolve(output) } catch { return null }
}

function readCrewClaim(lane, d) {
  try {
    const parsed = JSON.parse(d.readFileSync(join(lane.dir, 'crew.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { parsed: null, unreadable: true }
    return { parsed, unreadable: false }
  } catch {
    return { parsed: null, unreadable: true }
  }
}

function claimFor(parsed) {
  return {
    lane: typeof parsed?.lane_name === 'string' ? parsed.lane_name : null,
    checkout: typeof parsed?.checkout === 'string' ? parsed.checkout : null,
  }
}

export function liveLaneClaims({ checkout, batchNames, deps } = {}) {
  const d = normalDeps(deps)
  const root = crewRoot({ home: d.home })
  let rootExists
  try { rootExists = d.existsSync(root) } catch {
    return { state: 'unreadable', root, live: [], own: [], foreign: [], unknown: [{ lane: null, reason: 'crew-root-unreadable' }], cleared: false }
  }
  if (!rootExists) return { state: 'absent', root, live: [], own: [], foreign: [], unknown: [], cleared: true }
  try {
    d.readdirSync(root)
  } catch {
    return { state: 'unreadable', root, live: [], own: [], foreign: [], unknown: [{ lane: null, reason: 'crew-root-unreadable' }], cleared: false }
  }
  const walkErrors = new Set()
  const walkDeps = {
    existsSync: (path) => {
      try { return d.existsSync(path) } catch (err) {
        walkErrors.add(String(path))
        throw err
      }
    },
    readFileSync: d.readFileSync,
    readdirSync: (path, options) => {
      try { return d.readdirSync(path, options) } catch (err) {
        walkErrors.add(String(path))
        throw err
      }
    },
  }
  let liveLanes = []
  try { liveLanes = discoverLanes(root, walkDeps) } catch { /* the wrapper records a partial walk */ }
  const activeLanes = liveLanes.filter((lane) => laneActive(lane, readJournal(lane.journal, walkDeps)))
  const unknown = []
  const records = activeLanes.map((lane) => {
    const crew = readCrewClaim(lane, d)
    return { lane, crew, claim: crew.unreadable ? null : claimFor(crew.parsed), repo: null }
  })
  const measured = records.filter(({ crew }) => !crew.unreadable)
  const dispatchRepo = activeLanes.length > 0 ? repoCommonDir(checkout, d) : null
  for (const record of measured) record.repo = repoCommonDir(record.claim.checkout, d)

  const noteUnknown = (lane, reason) => unknown.push({ lane, reason })
  const own = []
  const foreign = []
  const live = []
  batchNames = batchNames instanceof Set ? batchNames : new Set(Array.isArray(batchNames) ? batchNames : [])
  const sameRepo = (record) => record.repo && dispatchRepo && record.repo === dispatchRepo
  const nonOwn = records.filter((record) => !record.crew.unreadable
    && sameRepo(record)
    && !batchNames.has(record.claim.lane))

  const claims = new Map()
  if (nonOwn.length > 0) {
    const allLanes = [...liveLanes, ...archivedLanes(root, walkDeps)]
    const byDir = new Map(records.map((record) => [record.lane.dir, record.crew]))
    const sourceRepos = new Map(records.map((record) => [record.lane.dir, record.repo]))
    const candidateNames = new Set(nonOwn.map((record) => record.claim.lane).filter((name) => typeof name === 'string' && name.trim() !== ''))
    const candidateSiblings = new Map()
    for (const record of nonOwn) {
      if (!candidateSiblings.has(record.claim.lane)) candidateSiblings.set(record.claim.lane, new Set())
      const siblings = candidateSiblings.get(record.claim.lane)
      const fences = Array.isArray(record.crew.parsed?.lane_fence) ? record.crew.parsed.lane_fence : []
      for (const entry of fences) {
        if (typeof entry?.lane === 'string' && entry.lane.trim() !== '') siblings.add(entry.lane)
      }
    }
    for (const lane of allLanes) {
      const source = byDir.get(lane.dir) || readCrewClaim(lane, d)
      if (source.unreadable) continue
      const sourceClaim = claimFor(source.parsed)
      const fences = Array.isArray(source.parsed?.lane_fence) ? source.parsed.lane_fence : []
      const relevant = fences.filter((entry) => typeof entry?.lane === 'string'
        && entry.lane.trim() !== '' && candidateNames.has(entry.lane)
        && candidateSiblings.get(entry.lane)?.has(sourceClaim.lane) && Array.isArray(entry.files))
      if (relevant.length === 0) continue
      let sourceRepo
      if (sourceRepos.has(lane.dir)) {
        sourceRepo = sourceRepos.get(lane.dir)
      } else {
        sourceRepo = repoCommonDir(sourceClaim.checkout, d)
        sourceRepos.set(lane.dir, sourceRepo)
      }
      if (!sourceRepo || !dispatchRepo || sourceRepo !== dispatchRepo) continue
      for (const entry of relevant) {
        if (!claims.has(entry.lane)) claims.set(entry.lane, new Set())
        const files = claims.get(entry.lane)
        for (const file of entry.files) {
          if (typeof file === 'string') files.add(normaliseRepoPath(file))
        }
      }
    }
  }

  for (const path of walkErrors) noteUnknown(null, 'crew-walk-incomplete')

  for (const record of records) {
    const lane = record.lane
    const claim = record.claim || { lane: null, checkout: null }
    if (record.crew.unreadable) {
      noteUnknown(lane.task, 'crew-json-unreadable')
      continue
    }
    if (!record.repo || !dispatchRepo) {
      noteUnknown(lane.task, 'repo-unmeasured')
      continue
    }
    if (record.repo !== dispatchRepo) {
      foreign.push(lane.task)
      continue
    }
    if (batchNames.has(claim.lane)) {
      own.push(claim.lane)
      continue
    }
    const files = claims.get(claim.lane)
    if (!files) {
      noteUnknown(lane.task, 'claim-unrecorded')
      continue
    }
    live.push({ lane: claim.lane, dir: lane.dir, files: [...files].sort() })
  }
  const state = 'read'
  const cleared = state === 'read' && unknown.length === 0
  return { state, root, live, own, foreign, unknown, cleared }
}

export function externalCrewDir({ lane, parentDir, deps } = {}) {
  const d = normalDeps(deps)
  const parent = typeof parentDir === 'string' && parentDir.trim() ? parentDir : process.cwd()
  return join(crewRoot({ home: d.home }), slug(basename(join(parent, `dt-${lane}`))), slug(lane))
}

export function externalLaneReason({ settled, stage }) {
  if (settled) return 'run-settled'
  if (typeof stage === 'string' && stage.startsWith('escalate:')) return 'run-escalated'
  return 'run-complete'
}

export function externalFenceLiveness({ externals, parentDir, deps } = {}) {
  const d = normalDeps(deps)
  return (Array.isArray(externals) ? externals : []).map((lane) => {
    const dir = externalCrewDir({ lane, parentDir, deps: d })
    const crewPath = join(dir, 'crew.json')
    let crewExists
    try { crewExists = d.existsSync(crewPath) } catch {
      return {
        lane, dir, live: false, reason: 'crew-json-unreadable', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    if (!crewExists) {
      return {
        lane, dir, live: false, reason: 'crew-dir-absent', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    let crew
    try { crew = JSON.parse(d.readFileSync(crewPath, 'utf8')) } catch {
      return {
        lane, dir, live: false, reason: 'crew-json-unreadable', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    if (crew?.lane_name !== lane) {
      return {
        lane, dir, live: false, reason: 'crew-lane-mismatch', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    let settled
    try { settled = d.existsSync(join(dir, 'returns', 'task.json')) } catch {
      return {
        lane, dir, live: false, reason: 'crew-json-unreadable', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    const journal = readJournal(join(dir, 'journal.jsonl'), d)
    const stage = journal.lastStage ?? null
    const live = laneActive({ settled }, journal)
    let nowMs
    try { nowMs = typeof d.now === 'function' ? d.now() : Date.now() } catch { nowMs = null }
    const staleAfterMs = DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS
    const age = journal.lastActivityAt === null || !Number.isFinite(nowMs) ? null : nowMs - journal.lastActivityAt
    const abandoned = live && age !== null && age > staleAfterMs
    const siblingFiles = [...new Set((Array.isArray(crew.lane_fence) ? crew.lane_fence : [])
      .flatMap((entry) => Array.isArray(entry?.files) ? entry.files : [])
      .filter((file) => typeof file === 'string')
      .map(normaliseRepoPath))].sort()
    return {
      lane,
      dir,
      live: live && !abandoned,
      reason: live ? (abandoned ? EXTERNAL_FENCE_ABANDONED : null) : externalLaneReason({ settled, stage }),
      stage,
      heartbeat_age_ms: age,
      stale_after_ms: staleAfterMs,
      sibling_files: siblingFiles,
    }
  })
}

export function crossBatchCollisions({ entries, live, externals } = {}) {
  const collisions = []
  const ownEntries = Array.isArray(entries) ? entries : []
  const liveLanes = Array.isArray(live) ? live : []
  const externalNames = new Set(Array.isArray(externals) ? externals : [])
  for (const entry of ownEntries) {
    const ownFiles = (Array.isArray(entry?.files) ? entry.files : [])
      .filter((file) => typeof file === 'string').map(normaliseRepoPath)
    const matchOwn = scopeMatcher(ownFiles)
    for (const current of liveLanes) {
      // An external entry DECLARES that this live lane holds these files, so the pair it
      // names is the intent, never a collision. Every other pair still refuses.
      if (externalNames.has(entry.lane) && entry.lane === current.lane) continue
      const liveFiles = (Array.isArray(current?.files) ? current.files : [])
        .filter((file) => typeof file === 'string').map(normaliseRepoPath)
      const matchLive = scopeMatcher(liveFiles)
      const collided = ownFiles.some(matchLive) || liveFiles.some(matchOwn)
      if (!collided) continue
      const files = [...new Set([...ownFiles.filter(matchLive), ...liveFiles.filter(matchOwn)])].sort()
      collisions.push({ lane: entry.lane, live: current.lane, dir: current.dir, files })
    }
  }
  return collisions
}

export function checkFences({ fences, lanes, graph, checkout, externals, parentDir, deps } = {}) {
  const d = normalDeps(deps)
  const entries = fenceEntriesOf(fences).map(normaliseFence)
  const batchLanes = Array.isArray(lanes) ? lanes : []
  const byLane = new Map(entries.map((entry) => [entry.lane, entry]))
  const externalNames = new Set((Array.isArray(externals) ? externals : []).filter((name) => typeof name === 'string' && name.trim() !== ''))

  // An absent graph is UNMEASURED edges, not "no edges": relatedLanes reads false for every
  // pair, so an exemption this register does carry is reported as a sibling-leak that does
  // not exist. That false premise cost b224-fencechecks a lane at plan:r1 (#634). With no
  // edge declared anywhere the graph is irrelevant and the answer is unchanged.
  const declaredEdges = batchLanes.some((lane) => Array.isArray(lane?.depends_on) && lane.depends_on.length > 0)
  const hasGraph = Boolean(graph && graph.ancestors instanceof Map)
  if (declaredEdges && !hasGraph) refuse(`checkFences cannot judge sibling-leak for a batch that declares depends_on edges without the graph that carries them; pass the graph planWaves returns`, GRAPH_UNMEASURED)

  // Check the register's membership before inspecting its shapes: a batch lane
  // can never fall through to an implicit, unfenced write surface.
  const batchNames = new Set(batchLanes.map(laneNameOf))
  const claimedBoth = [...batchNames].filter((name) => externalNames.has(name))
  if (claimedBoth.length > 0) refuse(`fence register marks batch lane(s) external: ${claimedBoth.join(', ')}; an external entry names a lane from ANOTHER batch`, FENCE_REGISTER_MISMATCH)
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    if (!byLane.has(name)) refuse(`lane is not in the fence register: ${name}`, LANE_UNFENCED)
  }

  // The drive-side validator is intentionally used here. The compiler's helper
  // has a different object-shaped contract and throws instead of returning rows.
  for (const entry of entries) {
    if (!Array.isArray(entry.files)) {
      refuse(`invalid scope entries for lane ${entry.lane}: files must be an array`, SCOPE_ENTRY_INVALID)
    }
    let shapeErrors
    try { shapeErrors = driveValidateScopeEntries(entry.files) } catch (err) {
      refuse(`invalid scope entries for lane ${entry.lane}: ${err?.message || String(err)}`, SCOPE_ENTRY_INVALID)
    }
    if (shapeErrors.length > 0) {
      refuse(`invalid scope entries for lane ${entry.lane}: ${shapeErrors.map(({ entry: path, why }) => `${path} (${why})`).join('; ')}`, SCOPE_ENTRY_INVALID)
    }
  }

  const pins = collectAnchorPins({ checkout, deps: d })
  const scanRoot = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const fenceHasCode = entries.some((entry) => (Array.isArray(entry.files) ? entry.files : []).some((file) => {
    if (typeof file !== 'string') return false
    const path = normaliseRepoPath(file)
    if (!CODE_SUFFIX.test(path) && !path.endsWith('/')) return false
    try { return d.existsSync(join(scanRoot, ...path.split('/'))) } catch { return false }
  }))
  let reachIndex = null
  const reachFor = () => (reachIndex ??= collectTestReach({ checkout: scanRoot, deps: d }))
  const warnings = []
  const perLane = {}
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    const own = byLane.get(name)
    const ownFiles = own.files.map(normaliseRepoPath)
    const ownWhere = laneWhereOf(lane)
    const ownCreates = laneCreatesOf(lane)
    const matchOwn = scopeMatcher(ownFiles)
    const ownSurface = [...ownWhere, ...ownCreates]
    if (!ownSurface.every(matchOwn)) {
      const outside = ownSurface.filter((path) => !matchOwn(path))
      refuse(`lane ${name} where path(s) outside own fence: ${outside.join(', ')}`, WHERE_OUTSIDE_FENCE)
    }

    // #635 made a shift REPAIRABLE: content found once at a new line is relocated and
    // reported, not failed. The premise this check refused on — "the lane cannot edit the
    // manifest that would re-anchor it" — therefore no longer implies a failure, and the
    // refusal falsely blocked three of five lanes in one batch. The SCAN stays: it names
    // every pin in one shot, the sweep that cost b217-treefingerprint a lane when done by
    // hand. Rot and ambiguity are still fatal and are still caught where they become
    // facts — the skill's own exhibits.test.mjs — not by a static pre-dispatch guess.
    const unfencedPins = anchorPinsOutsideFence({ surface: ownSurface, fenceFiles: ownFiles, pins })
    if (unfencedPins.length > 0) {
      const detail = unfencedPins.map(({ file, manifest, keys }) => `${file} pinned by ${manifest} at ${keys.join(', ')}`).join('; ')
      const rolesManifestUnfenced = unfencedPins.some(({ manifest }) => manifest === ROLES_ANCHOR_MANIFEST)
      const rolesClause = rolesManifestUnfenced
        ? ` The roles manifest is held to a strict bijection with the charters ${ROLES_ANCHOR_COMPANIONS.join(' and ')} at crew/drive.test.mjs:1041, so all three must be fenced together — a hard test failure, not a warning.`
        : ''
      const text = `${ANCHOR_PIN_WARNING_PREFIX} lane ${name} writes anchor-pinned file(s) whose pinning manifest is outside its fence: ${detail}; a shift is repairable with node skills/qa-test-writing/anchor-pin.mjs --repair <skill dir>, so this does not block dispatch; rot and ambiguity still fail in the skill's own exhibits.test.mjs.${rolesClause} ${ANCHOR_BLIND_SPOT}`
      warnings.push({ kind: 'anchor-pin', lane: name, pins: unfencedPins, text })
      d.log(text)
    }

    const reachRows = fenceHasCode ? testsOutsideFence({ surface: ownSurface, fenceFiles: ownFiles, reach: reachFor() }) : []
    if (reachRows.length > 0) {
      const listed = reachRows.slice(0, TEST_REACH_ROW_LIMIT).map(reachRowText).join('; ')
      const omitted = reachRows.length - Math.min(reachRows.length, TEST_REACH_ROW_LIMIT)
      const tail = omitted > 0 ? `; ${omitted} further row(s) not listed here and carried on the report` : ''
      const reachText = `${TEST_REACH_WARNING_PREFIX} lane ${name} changes file(s) reached by ${reachRows.length} test file(s) outside its fence, nearest first (listing at most ${TEST_REACH_ROW_LIMIT}): ${listed}${tail}; a named test is a file to READ before this fence is chosen, not a refusal. ${TEST_REACH_BLIND_SPOT}`
      warnings.push({ kind: 'test-reach', lane: name, reach: reachRows, text: reachText })
      d.log(reachText)
    }

    const siblings = []
    for (const sibling of entries) {
      if (sibling.lane === name) continue
      const siblingFiles = sibling.files.map(normaliseRepoPath)
      const matchSibling = scopeMatcher(siblingFiles)
      const inherited = relatedLanes(graph, name, sibling.lane)
      if (!inherited && ownFiles.some(matchSibling)) {
        const leaked = ownFiles.filter(matchSibling)
        refuse(`lane ${name} own fence overlaps sibling ${sibling.lane}: ${leaked.join(', ')}`, SIBLING_LEAK)
      }
      // A created path can hide from the fence-vs-fence check above: this lane may
      // own it only through a directory prefix while a sibling owns it literally,
      // and a register-only sibling is never visited as `name`.
      const leakedCreates = ownCreates.filter(matchSibling)
      if (!inherited && leakedCreates.length > 0) {
        refuse(`lane ${name} creates path(s) inside sibling ${sibling.lane}'s fence: ${leakedCreates.join(', ')}`, SIBLING_LEAK)
      }
      siblings.push({ lane: sibling.lane, files: siblingFiles })
    }
    perLane[name] = {
      lane: name,
      files: ownFiles,
      where: ownWhere,
      creates: ownCreates,
      reads: Array.isArray(own.reads) ? own.reads : [],
      siblings,
    }
  }
  // The other half of the invariant the membership loop above measures (#658): a register may
  // not be a SUPERSET of the batch it is dispatched with. A lane's sibling count is DERIVED
  // from batch size, so such a register can only ever be caught at boot, as
  // fence-count-mismatch, after every seat has been paid for. Both halves are decidable from
  // these two inputs with nothing booted. This check runs LAST on purpose: no existing
  // refusal changes the cause it names.
  const absent = entries.map(({ lane }) => lane).filter((name) => !batchNames.has(name) && !externalNames.has(name))
  if (absent.length > 0) refuse(`fence register names lane(s) absent from the batch: ${absent.join(', ')}; the batch carries ${[...batchNames].join(', ') || 'no lanes'}, and a lane's sibling count is derived from batch size, so this register can only refuse at boot as ${FENCE_COUNT_MISMATCH}`, FENCE_REGISTER_MISMATCH)
  const externalRows = externalFenceLiveness({ externals: [...externalNames], parentDir, deps: d })
  const abandonedRows = externalRows.filter((row) => row.reason === EXTERNAL_FENCE_ABANDONED)
  const dead = externalRows.filter((row) => row.live !== true && row.reason !== EXTERNAL_FENCE_ABANDONED)
  if (dead.length > 0) refuse(`the fence register names external lane(s) that are not live: ${dead.map((row) => `${row.lane} (${row.reason}, crew dir ${row.dir})`).join('; ')}; an external fence denies a surface its lane must still hold`, EXTERNAL_FENCE_STALE)
  if (abandonedRows.length > 0) refuse(`the fence register names external lane(s) whose driver is gone: ${abandonedRows.map((row) => `${row.lane} (crew dir ${row.dir}, heartbeat age ${row.heartbeat_age_ms}ms, stale after ${row.stale_after_ms}ms)`).join('; ')}; the lane's driver is gone, so the surface is denied by a lane nobody is running`, EXTERNAL_FENCE_ABANDONED)
  for (const row of externalRows) {
    const declared = [...new Set((byLane.get(row.lane)?.files || [])
      .filter((file) => typeof file === 'string')
      .map(normaliseRepoPath))].sort()
    const claimed = row.sibling_files === null
      ? null
      : [...new Set((row.sibling_files || [])
        .filter((file) => typeof file === 'string')
        .map(normaliseRepoPath))].sort()
    const matchClaimed = scopeMatcher(claimed || [])
    const overlap = declared.filter(matchClaimed)
    const fenceCompare = !claimed || claimed.length === 0
      ? 'unmeasured'
      : overlap.length > 0 ? 'mismatch' : 'clear'
    d.log(`${EXTERNAL_FENCE_PREFIX} lane=${row.lane} crew_dir=${row.dir} stage=${row.stage ?? 'none'} files=${declared.join(',')} fence_compare=${fenceCompare}`)
    if (overlap.length > 0) {
      const mismatchText = `${EXTERNAL_FENCE_PREFIX} lane=${row.lane} crew_dir=${row.dir} mismatch declared=${declared.join(',') || 'none'} claimed=${claimed.join(',')} files=${overlap.join(',')}; blind spot: a lane's own fence is not recorded in its own crew.json, so only a file another lane demonstrably owns can be contradicted — an under-declared external is not measured.`
      warnings.push({ kind: 'external-fence-mismatch', lane: row.lane, declared, claimed, files: overlap, text: mismatchText })
      d.log(mismatchText)
    }
  }
  if (externalRows.length > 0) {
    d.log(`${EXTERNAL_FENCE_PREFIX} carried=${externalRows.length} lanes=${externalRows.map((row) => row.lane).join(',')} — carried in from lanes outside this batch; they deny every batch lane's write surface and are NOT counted in the sibling total checkArrival derives`)
  }
  // Every check above reads only the register and the batch in hand; this one reads LIVE
  // state OUTSIDE both. A cause an operator can fix from the register alone is named first
  // and is never masked by one that depends on what else happens to be running.
  //
  // This REFUSES where the test-reach scan only warns, and the difference is not severity:
  // the reach scan is a static proxy (#635 measured a heuristic refusal falsely blocking
  // three of five lanes in one batch), while a collision here is a FACT read from a live
  // lane's own persisted fence. An UNDETERMINED live set is neither — it warns, and it
  // never reads as "no collision" (#678, #687).
  const crossBatch = liveLaneClaims({ checkout: scanRoot, batchNames, deps: d })
  const collisions = crossBatchCollisions({ entries, live: crossBatch.live, externals: [...externalNames] })
  if (collisions.length > 0) {
    const detail = collisions.map((row) => `lane ${row.lane} collides with live lane ${row.live} on ${row.files.join(', ')} (crew dir ${row.dir})`).join('; ')
    refuse(`the fence register grants file(s) that a live lane outside this batch already holds: ${detail}; "ONE register, ONE batch" holds only while one batch runs at a time — settle, archive or narrow the named lane, or narrow this register`, CROSS_BATCH_COLLISION)
  }
  if (!crossBatch.cleared) {
    const text = `${CROSS_BATCH_UNKNOWN_PREFIX} the live lane set could not be determined in full (crew root ${crossBatch.root}, state ${crossBatch.state}): ${crossBatch.unknown.map((row) => `${row.lane ?? 'crew-root'} (${row.reason})`).join('; ') || 'none named'}; this batch is NOT cleared against those lanes and this absence is not a clear. ${CROSS_BATCH_BLIND_SPOT}`
    warnings.push({ kind: 'cross-batch-unknown', lane: null, unknown: crossBatch.unknown, text })
    d.log(text)
  }
  return { perLane, warnings, crossBatch, externals: externalRows }
}

// A fence denies a SIBLING's declared surface; it never denied an UNCLAIMED path, so a
// planner could declare a write surface wider than the brief asked for and collide with
// nothing only by luck. The lane's own fence is the authority the driver's plan-accept
// never consulted (crew/drive.mjs:2419 checks siblings only). Refuse and NAME the paths:
// silently narrowing a declaration is how a fence stops meaning anything.
export function checkPlanScope({ lane, declared, files } = {}) {
  const name = laneNameOf(lane)
  const fenceFiles = (Array.isArray(files) ? files : []).map(normaliseRepoPath)
  const inFence = scopeMatcher(fenceFiles)
  const paths = (Array.isArray(declared) ? declared : []).map(normaliseRepoPath)
  const outside = paths.filter((path) => !inFence(path))
  if (outside.length > 0) {
    refuse(`lane ${name} plan declares files_in_scope outside the lane fence: ${outside.join(', ')}; the lane fence is ${fenceFiles.join(', ') || 'empty'}`, PLAN_SCOPE_OUTSIDE_FENCE)
  }
  return { lane: name, declared: paths, fence: fenceFiles }
}

const MACHINERY_ALLOWANCE = 2

// TRD §5 R2 / §10 decision 6. The scope gate adjudicates PATHS; this
// adjudicates PURPOSE-adjacent growth, and it is a FINDING the lead
// disposes of, never a refusal — an over-creating plan may still be the
// right plan. Counts are supplied by the caller, exactly as checkPlanScope
// takes its `declared` list.
export function checkMachineryBudget({ lane, creates = [], newFiles = [], newSymbols = [], allowance = MACHINERY_ALLOWANCE } = {}) {
  const name = laneNameOf(lane)
  const created = (Array.isArray(creates) ? creates : []).map(normaliseRepoPath)
  const files = (Array.isArray(newFiles) ? newFiles : []).map(normaliseRepoPath)
  const symbols = (Array.isArray(newSymbols) ? newSymbols : []).map((symbol) => String(symbol))
  const budget = created.length + allowance
  const counted = files.length + symbols.length
  const excess = counted - budget
  const findings = excess > 0
    ? [{
        id: `MB-${name}`,
        severity: 'should-fix',
        location: files[0] || 'plan.md',
        summary: `lane ${name} plans ${counted} new item(s) — ${files.length} file(s) [${files.join(', ') || 'none'}] and ${symbols.length} exported symbol(s) [${symbols.join(', ') || 'none'}] — against a budget of ${budget} (creates ${created.length} + allowance ${allowance}): ${excess} over. Added machinery is a decision, not a defect: keep it, narrow it, or drop it.`,
        disposition: 'ask-user',
      }]
    : []
  return { lane: name, budget, counted, excess, findings }
}

// #658: a directed lane's PLAN IS ITS BRIEF, and the compiled brief is an artefact the
// dispatcher holds in hand before it boots anything. parseDirectedBrief is the authority the
// driver itself uses (crew/drive.mjs:2332) and its own defect string is reported verbatim, so
// one defect has one sentence rather than two that can drift. The variant is recognised by
// what it DECLARES — sources.gate === 'brief' — exactly as preflightRunOptions recognises a
// ctx validation lane, so a later shape whose gate comes from its brief is checked too.
export function checkDirectedBrief({ lane, variant, briefPath, deps } = {}) {
  const d = normalDeps(deps)
  const name = laneNameOf(lane)
  const resolved = String(variant ?? 'full')
  if (VARIANTS[resolved]?.sources?.gate !== 'brief') return { lane: name, variant: resolved, checked: false }
  let text = null
  try { text = textOf(d.readFileSync(briefPath, 'utf8')) } catch (err) {
    refuse(`cannot read the compiled brief for ${resolved} lane ${name} at ${briefPath}: ${err?.message || String(err)}`, DIRECTED_BRIEF_INVALID)
  }
  const parsed = parseDirectedBrief(text)
  if (parsed.defect) refuse(`lane ${name} runs the ${resolved} shape, whose plan IS its brief, and ${briefPath} is not a plan this driver can run: ${parsed.defect}`, DIRECTED_BRIEF_INVALID)
  return { lane: name, variant: resolved, checked: true, gate_cmd: parsed.gate_cmd, files_in_scope: parsed.files_in_scope }
}

export function seatRolesUnseated({ seats, tier, deps } = {}) {
  const d = normalDeps(deps)
  let roster
  try {
    roster = JSON.parse(d.readFileSync(ROSTER_PATH, 'utf8'))
  } catch (err) {
    refuse(`cannot read or parse ratified roster ${ROSTER_PATH}: ${err?.message || String(err)}`, SEAT_FLOOR_CONFLICT)
  }
  if (!plainObject(roster) || !plainObject(roster.tiers) || !plainObject(roster.tiers[tier])) {
    refuse(`cannot read ratified roster ${ROSTER_PATH}: missing tiers.${tier}`, SEAT_FLOOR_CONFLICT)
  }
  const tierRoster = roster.tiers[tier]
  return [...seatMaps(seats).keys()].filter((role) => !Object.hasOwn(tierRoster, role) || tierRoster[role] == null)
}

// Boot's reasons are a closed enum it renders as `[reason]` (crew/crew.mjs:654);
// this reads that tag rather than the prose around it — the same posture
// readsFromRefusal takes with the compiler.
export function seatFloorRefusal(text) {
  return BAND_FLOOR_REASONS.find((reason) => String(text ?? '').includes(`[${reason}]`)) || null
}

export function planWorktrees({ lanes, parentDir, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const parent = typeof parentDir === 'string' && parentDir.trim() ? parentDir : dirname(resolve(checkout || process.cwd()))
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const plans = []
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const name = laneNameOf(lane)
    const dir = join(parent, 'dt-' + name)
    const branch = name
    let exists
    try { exists = d.existsSync(dir) } catch (err) {
      refuse(`cannot check worktree path ${dir}: ${err?.message || String(err)}`, WORKTREE_EXISTS)
    }
    if (exists) refuse(`worktree already exists: ${dir}`, WORKTREE_EXISTS)
    let branchProbe
    try {
      branchProbe = d.spawn({
        file: 'git',
        args: ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + name],
        cwd: root,
      })
    } catch (err) {
      refuse(`cannot verify branch ${name}: ${err?.message || String(err)}`, BRANCH_TAKEN)
    }
    if (!branchProbe || branchProbe.status === 0) {
      refuse(`branch is already taken or could not be verified as free: ${name}`, BRANCH_TAKEN)
    }
    plans.push({ lane: name, dir, branch })
  }
  return plans
}

export function createWorktrees({ plans, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  for (const plan of Array.isArray(plans) ? plans : []) {
    let result
    try {
      result = d.spawn({
        file: 'git',
        args: ['-C', root, 'worktree', 'add', '-b', plan.branch, plan.dir, DISPATCH_BASE_REF],
        cwd: root,
      })
    } catch (err) {
      refuse(`worktree creation failed for ${plan.lane}: ${err?.message || String(err)}`, WORKTREE_FAILED)
    }
    if (!result || result.status !== 0) {
      refuse(`worktree creation failed for ${plan.lane}: ${JSON.stringify(childFailure(result))}`, WORKTREE_FAILED)
    }
  }
  return plans
}

export function readsFromRefusal(stderr) {
  const text = textOf(stderr)
  const unfencedPrefix = 'coupled source(s) outside lane fence: '
  const stalePrefix = 'stale read acknowledgement(s): '
  const unfencedAt = text.indexOf(unfencedPrefix)
  const staleAt = text.indexOf(stalePrefix)
  if (unfencedAt < 0 && staleAt < 0) return { reason: null, files: [] }

  const parse = (prefix, at, separator, stripKey) => {
    let details = text.slice(at + prefix.length)
    const end = details.indexOf(' [reason:')
    if (end >= 0) details = details.slice(0, end)
    const files = details.split(separator).map((part) => {
      const value = stripKey ? part.split('·')[0] : part
      return value.trim()
    }).filter(Boolean)
    return [...new Set(files)].sort()
  }
  if (unfencedAt >= 0 && (staleAt < 0 || unfencedAt < staleAt)) {
    return { reason: COUPLED_SOURCE_UNFENCED, files: parse(unfencedPrefix, unfencedAt, ';', true) }
  }
  return { reason: STALE_READ_ACK, files: parse(stalePrefix, staleAt, ',', false) }
}

// `gatherFences` refuses unknown entry keys, including `external`, so strip the marker
// before compile and boot (`scripts/factory/make-brief.mjs:935`). The entry stays inside
// `lanes` because `laneFenceFor` hands every non-own register entry to each lane
// (`scripts/factory/make-brief.mjs:1060`).
export function readRegister({ fencesPath, checkout, outDir, deps } = {}) {
  const d = normalDeps(deps)
  const authored = resolve(fencesPath)
  let raw
  try { raw = JSON.parse(d.readFileSync(authored, 'utf8')) } catch (err) {
    refuse(`cannot read or parse fences ${authored}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.lanes)) {
    refuse(`fence register ${authored} must be an object carrying a lanes array`, BATCH_UNREADABLE)
  }
  const externals = []
  const lanes = raw.lanes.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refuse(`fence register ${authored} lanes[${index}] must be an object`, BATCH_UNREADABLE)
    }
    if (!Object.hasOwn(entry, 'external')) return entry
    if (entry.external !== true) {
      refuse(`fence register ${authored} lanes[${index}] external must be true or absent, found ${JSON.stringify(entry.external)}`, BATCH_UNREADABLE)
    }
    if (typeof entry.lane !== 'string' || entry.lane.trim() === '') {
      refuse(`fence register ${authored} lanes[${index}] marks an external entry with no lane name`, BATCH_UNREADABLE)
    }
    if (externals.includes(entry.lane)) refuse(`fence register ${authored} names external lane ${entry.lane} twice`, BATCH_UNREADABLE)
    externals.push(entry.lane)
    const copy = { ...entry }
    delete copy.external
    return copy
  })
  if (externals.length === 0) {
    return { fences: gatherFences({ fencesPath: authored, checkout }), externals: [], registerPath: authored, sanitised: false }
  }
  const target = join(resolve(outDir), EXTERNAL_REGISTER_NAME)
  try {
    mkdirSync(resolve(outDir), { recursive: true })
    writeFileSync(target, JSON.stringify({ ...raw, lanes }, null, 2) + '\n')
  } catch (err) {
    refuse(`cannot write the external-stripped fence register ${target}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
  }
  return { fences: gatherFences({ fencesPath: target, checkout }), externals: [...externals].sort(), registerPath: target, sanitised: true }
}

function registerData({ fences, registerPath, d }) {
  const entries = fenceEntriesOf(fences)
  if (entries.length > 0) {
    return { lanes: entries.map((entry) => ({
      lane: entry.lane,
      files: [...(entry.files || [])],
      ...(Array.isArray(entry.reads) ? { reads: entry.reads.map((read) => ({ ...read })) } : {}),
    })) }
  }
  try { return JSON.parse(d.readFileSync(resolve(registerPath), 'utf8')) } catch (err) {
    refuse(`cannot read compile fence register ${registerPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
}

function writeUpdatedRegister({ data, lane, reads, outDir, d }) {
  const copy = JSON.parse(JSON.stringify(data))
  if (!Array.isArray(copy?.lanes)) refuse(`compile fence register has no lanes array for ${lane}`, READS_UNRESOLVED)
  const entry = copy.lanes.find((candidate) => candidate && candidate.lane === lane)
  if (!entry) refuse(`compile fence register has no lane ${lane}`, READS_UNRESOLVED)
  const current = Array.isArray(entry.reads) ? entry.reads.filter((read) => read && typeof read.file === 'string') : []
  const byFile = new Map(current.map((read) => [normaliseRepoPath(read.file), { ...read, file: normaliseRepoPath(read.file) }]))
  for (const read of reads) byFile.set(read.file, { file: read.file, why: read.why })
  entry.reads = [...byFile.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const path = join(outDir, `${lane}.fences.json`)
  try { writeFileSync(path, JSON.stringify(copy, null, 2) + '\n') } catch (err) {
    refuse(`cannot write compiler retry fence register ${path}: ${err?.message || String(err)}`, READS_UNRESOLVED)
  }
  return path
}

// The compiler proposes a tier on ONE line and renders the proposal block from
// the other two axes: PROPOSAL_KEYS is ['shape', 'strength'] (make-brief.mjs:148)
// and the block never carries a tier at all. Shape is the RISK axis and shares
// the mechanical|build|judge vocabulary with tier, so reading it through
// TIER_NAMES passed the membership guard on the wrong axis and seated every
// lane at its shape. The line anchor keeps a phrase quoted mid-sentence in the
// ask from outranking the compiler's own line.
function proposalFromBrief(text) {
  const match = /^proposed tier:\s*(mechanical|build|judge)\b/im.exec(text)
  return match ? match[1].toLowerCase() : null
}

const INTENT_EVENT = 'lane-intent'

// Reads back what the compiler already decided, exactly as proposalFromBrief
// does. The compiler echoes the authored ask in the title and `## The ask`;
// that framing identifies its own intent section instead of one an ask quotes.
// A brief with no intent section records null — an older brief keeps producing
// the bytes it always did.
function intentFromBrief(text) {
  if (typeof text !== 'string') return null
  const titlePrefix = '# Task: '
  const askHeading = '\n## The ask\n'
  const intentHeading = '\n## Intent\n'
  let framed = false
  let longestEchoedAskLength = -1
  let longestEchoedAskEnd = -1
  if (text.startsWith(titlePrefix)) {
    let heading = text.indexOf(askHeading, titlePrefix.length)
    while (heading >= 0) {
      const ask = text.slice(titlePrefix.length, heading)
      const echoed = heading + askHeading.length
      if (text.startsWith(ask, echoed) && ask.length > longestEchoedAskLength) {
        framed = true
        longestEchoedAskLength = ask.length
        longestEchoedAskEnd = echoed + ask.length
      }
      heading = text.indexOf(askHeading, heading + 1)
    }
    if (framed) {
      if (!text.startsWith(intentHeading, longestEchoedAskEnd)) return null
      const bodyStart = longestEchoedAskEnd + intentHeading.length
      const end = text.indexOf('\n## ', bodyStart)
      const body = text.slice(bodyStart, end < 0 ? text.length : end)
      const value = body.split('\n').find((line) => line.trim() !== '')
      return value ? value.trim() : null
    }
  }
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## Intent')
  if (start < 0) return null
  const body = lines.slice(start + 1).find((line) => line.trim() !== '')
  if (body === undefined || body.startsWith('## ')) return null
  return body.trim() || null
}

// Reads what the compiler already decided. The misclassification is a bare line in
// the brief, not part of the block, so it is matched independently: a brief may
// report one with or without a readable block.
export function staffingFromBrief(text) {
  if (typeof text !== 'string' || !text.trim()) return { ...ABSENT_STAFFING }
  const lines = text.split('\n')
  const misclassification = lines.map((line) => line.trim())
    .find((line) => line.startsWith(MISCLASSIFIED_PREFIX)) || null
  const fence = '```' + PROPOSAL_BLOCK
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== fence) continue
    const end = lines.findIndex((line, j) => j > i && line.trim() === '```')
    if (end < 0) break
    blocks.push(lines.slice(i + 1, end).join('\n'))
    i = end
  }
  if (blocks.length !== 1) return { ...ABSENT_STAFFING, misclassification }
  let parsed
  try { parsed = JSON.parse(blocks[0]) } catch { return { ...ABSENT_STAFFING, misclassification } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...ABSENT_STAFFING, misclassification }
  }
  const shape = TIER_NAMES.includes(parsed.shape) ? parsed.shape : null
  const strength = LADDER_BANDS.includes(parsed.strength) ? parsed.strength : null
  return { shape, strength, misclassification }
}

export const BASELINE_CACHE_DIRNAME = 'baselines'

// The factory state root, relocatable exactly as the ledger's is
// (scripts/factory/ledger.mjs:3658). One file per commit; a {sha, command} key needs no
// eviction because both halves are immutable facts about that commit.
export function factoryStateRoot(deps) {
  const d = normalDeps(deps)
  return d.env.DEVTEAM_LEDGER_DIR || join(d.home, '.dev-team', 'factory')
}

export function baselineCacheRoot(deps) {
  return join(factoryStateRoot(deps), BASELINE_CACHE_DIRNAME)
}

export function baselineCachePath({ sha, deps } = {}) {
  return join(baselineCacheRoot(deps), `${sha}.json`)
}

// Returns the PATH of a usable record, or null. It never decides reuse: whatever it returns is
// handed to make-brief as --baseline and passes make-brief's own acceptance
// (reuseBaseline, scripts/factory/make-brief.mjs) unchanged.
export function readBaselineCache({ sha, command, deps } = {}) {
  if (typeof sha !== 'string' || !sha.trim()) return null
  const d = normalDeps(deps)
  const path = baselineCachePath({ sha, deps: d })
  let record
  try { record = JSON.parse(textOf(d.readFileSync(path, 'utf8'))) } catch { return null }
  if (!record || typeof record !== 'object') return null
  if (record.sha !== sha) return null
  if (record.command !== command) return null
  return path
}

export function recordBaselineCache({ measured, sha, deps } = {}) {
  const d = normalDeps(deps)
  let record
  try { record = JSON.parse(textOf(d.readFileSync(measured, 'utf8'))) } catch { return null }
  if (!record || record.sha !== sha || typeof record.command !== 'string' || !record.command.trim()) return null
  const path = baselineCachePath({ sha, deps: d })
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  } catch (err) {
    d.log(`dispatch-batch: cannot record baseline cache ${path}: ${err?.message || String(err)}`)
    return null
  }
  return path
}

// One `git rev-parse HEAD` per lane, computed ONCE and shared by the baseline measurement and
// the compile scheduler. Returns a Map lane -> sha, or null when any lane's head is unknown.
export function laneHeads({ plans, deps } = {}) {
  const d = normalDeps(deps)
  const heads = new Map()
  for (const plan of Array.isArray(plans) ? plans : []) {
    let result
    try {
      result = d.spawn({
        file: 'git',
        args: ['-C', plan.dir, 'rev-parse', 'HEAD'],
        cwd: plan.dir,
      })
    } catch (err) {
      d.log(`dispatch-batch: cannot measure shared commit for ${plan.lane}: ${err?.message || String(err)}`)
      return null
    }
    const sha = result?.status === 0 ? textOf(result.stdout).trim() : ''
    if (!sha) {
      d.log(`dispatch-batch: cannot measure shared commit for ${plan.lane}; measuring per lane`)
      return null
    }
    heads.set(plan.lane, sha)
  }
  return heads
}

function laneTestCommand({ dir, deps }) {
  const d = normalDeps(deps)
  try {
    const data = JSON.parse(textOf(d.readFileSync(join(dir, 'package.json'), 'utf8')))
    return typeof data?.scripts?.test === 'string' && data.scripts.test.trim() ? data.scripts.test : null
  } catch { return null }
}

// A real worktree is created before this probe. The fallback is only for injected
// seams that report a successful worktree spawn without materialising its path;
// an existing lane worktree with no command remains unknown and cannot claim reuse.
function laneCommandForPlan({ plan, fallbackDir, deps }) {
  const d = normalDeps(deps)
  const command = laneTestCommand({ dir: plan?.dir, deps: d })
  if (command || typeof fallbackDir !== 'string' || !fallbackDir.trim()) return command
  let exists
  try { exists = d.existsSync(plan?.dir) } catch { return null }
  if (exists || d.existsSync === fsExistsSync) return null
  return laneTestCommand({ dir: fallbackDir, deps: d })
}

export function measureBatchBaseline({ plans, outDir, checkout, heads, deps } = {}) {
  const d = normalDeps(deps)
  if (!Array.isArray(plans) || plans.length < 2) return null
  const measuredHeads = heads || laneHeads({ plans, deps: d })
  if (!measuredHeads) return null
  const shas = new Set(measuredHeads.values())
  if (shas.size !== 1) {
    d.log('dispatch-batch: lanes do not share a commit; measuring per lane')
    return null
  }
  if (typeof outDir !== 'string' || !outDir.trim()) return null
  const sha = [...shas][0]
  const command = laneCommandForPlan({ plan: plans[0], fallbackDir: checkout, deps: d })
  const cached = readBaselineCache({ sha, command, deps: d })
  if (cached) {
    d.log(`dispatch-batch: reusing cached baseline sha=${sha} path=${cached}`)
    return cached
  }
  const path = join(outDir, 'batch-baseline.json')
  // Acquire, then LOOK AGAIN (#825). The cache is keyed by sha, so the lane that
  // held this slot before may have recorded the very baseline this one queued to
  // measure: five lanes on one commit become one suite and four reads. The
  // recheck lives INSIDE the slot, because outside it the answer is the one that
  // was already false above.
  return withSuiteSlot({
    owner: `dispatch-batch:${sha}`,
    root: factoryStateRoot(d),
    env: d.env,
    log: (line) => d.log(`dispatch-batch: ${line}`),
    now: d.now,
    sleep: d.sleep,
    slots: d.slots,
  }, () => {
    const queued = readBaselineCache({ sha, command, deps: d })
    if (queued) {
      d.log(`dispatch-batch: reusing cached baseline sha=${sha} path=${queued} (recorded while queued for a suite slot)`)
      return queued
    }
    let result
    try {
      result = d.spawn({
        file: 'node',
        args: ['scripts/factory/make-brief.mjs', '--measure-baseline', path, '--checkout', plans[0].dir],
        cwd: plans[0].dir,
      })
    } catch (err) {
      d.log(`dispatch-batch: batch baseline measurement failed: ${err?.message || String(err)}; measuring per lane`)
      return null
    }
    if (!result || result.status !== 0) {
      d.log(`dispatch-batch: batch baseline measurement failed; measuring per lane`)
      return null
    }
    recordBaselineCache({ measured: path, sha, deps: d })
    d.log(`dispatch-batch: measured shared baseline sha=${sha} path=${path}`)
    return path
  })
}

function compileCommand({ requestPath, lane, laneDir, registerPath, outDir, baselinePath }) {
  const args = [
    'scripts/factory/make-brief.mjs',
    '--request', requestPath,
    '--checkout', laneDir,
    '--fences', registerPath,
    '--lane', lane,
    '--out', join(outDir, `${lane}.brief.md`),
    '--force',
  ]
  if (typeof baselinePath === 'string' && baselinePath.trim()) args.push('--baseline', baselinePath)
  return { file: 'node', args, cwd: laneDir }
}

// Pass one asks the compiler for the reads this lane must acknowledge; the
// compile that follows is the only other pass (#737).
function discoverCommand({ requestPath, lane, laneDir, registerPath }) {
  const args = [
    'scripts/factory/make-brief.mjs',
    '--discover-reads', lane,
    '--request', requestPath,
    '--checkout', laneDir,
    '--fences', registerPath,
  ]
  return { file: 'node', args, cwd: laneDir }
}

// The compiler's --discover-reads payload: a JSON array of {file, why}
// records. The dispatcher transcribes it and never derives coupling itself.
function discoveredReads(stdout, lane) {
  let parsed
  try { parsed = JSON.parse(textOf(stdout)) } catch {
    refuse(`compiler read discovery for lane ${lane} produced no JSON: ${JSON.stringify(textOf(stdout).slice(0, 200))}`, READS_UNRESOLVED)
  }
  if (!Array.isArray(parsed)) refuse(`compiler read discovery for lane ${lane} produced no array`, READS_UNRESOLVED)
  return parsed.map((record, index) => {
    const named = (value) => typeof value === 'string' && value.trim() !== ''
    if (!plainObject(record) || !named(record.file) || !named(record.why)) {
      refuse(`compiler read discovery for lane ${lane} record ${index} is not {file, why}: ${JSON.stringify(record)}`, READS_UNRESOLVED)
    }
    return { file: normaliseRepoPath(record.file), why: record.why }
  })
}

export async function compileLane({ lane, batchDir, requestPath, laneDir, registerPath, outDir, fences, baselinePath, deps } = {}) {
  const d = normalDeps(deps)
  const name = laneNameOf(lane)
  const requestDir = resolve(batchDir)
  const checkout = typeof laneDir === 'string' && laneDir.trim() ? laneDir : process.cwd()
  const outputDir = typeof outDir === 'string' && outDir.trim() ? outDir : join(requestDir, 'out')
  const authoredRegister = registerPath || join(outputDir, 'dispatch.fences.json')
  const compileRequest = typeof requestPath === 'string' && requestPath.trim()
    ? requestPath
    : join(requestDir, `${name}${REQUEST_SUFFIX}`)
  try { mkdirSync(outputDir, { recursive: true }) } catch (err) {
    refuse(`cannot create compiler output directory ${outputDir}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!registerPath) {
    const data = registerData({ fences, registerPath: authoredRegister, d })
    try { writeFileSync(authoredRegister, JSON.stringify(data, null, 2) + '\n') } catch (err) {
      refuse(`cannot write compiler fence register ${authoredRegister}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
  }

  let discovered
  try { discovered = await d.spawnAsync(discoverCommand({ lane: name, requestPath: compileRequest, laneDir: checkout, registerPath: authoredRegister })) } catch (err) {
    refuse(`compiler could not start read discovery for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!discovered || discovered.status !== 0) {
    refuse(`compiler could not discover reads for lane ${name}: ${JSON.stringify(childFailure(discovered))}`, READS_UNRESOLVED)
  }
  const reads = discoveredReads(discovered.stdout, name)
  let currentRegister = authoredRegister
  if (reads.length > 0) {
    const data = registerData({ fences, registerPath: authoredRegister, d })
    currentRegister = writeUpdatedRegister({ data, lane: name, reads, outDir: outputDir, d })
  }
  let result
  try { result = await d.spawnAsync(compileCommand({ lane: name, requestPath: compileRequest, laneDir: checkout, registerPath: currentRegister, outDir: outputDir, baselinePath })) } catch (err) {
    refuse(`compiler could not start for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!result || result.status !== 0) {
    const stderr = childFailure(result)
    const parsed = readsFromRefusal(stderr)
    // Discovery has already run: a compiler that STILL names reads is naming
    // ones this lane cannot resolve, never a retry (#737).
    const detail = parsed.reason ? `still refuses ${parsed.reason} after read discovery` : 'refused after read discovery'
    refuse(`compiler ${detail} for lane ${name}: ${JSON.stringify(stderr)}`, READS_UNRESOLVED)
  }
  const briefPath = join(outputDir, `${name}.brief.md`)
  let brief
  try { brief = textOf(d.readFileSync(briefPath, 'utf8')) } catch (err) {
    refuse(`compiler produced no readable brief for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  return { lane: name, brief: briefPath, registerPath: currentRegister, proposed: proposalFromBrief(brief), staffing: staffingFromBrief(brief), intent: intentFromBrief(brief) }
}

export function tierFloor({ files, extra } = {}) {
  const paths = resolveProtectedPaths(extra)
  const hits = protectedHitsIn(files, paths)
  const forced = hits.length > 0 ? 'judge' : null
  return { hits, forced, floor: forced }
}

export function reconcileTier({ lane, forced, proposed, requested, requestedFrom = 'lane' } = {}) {
  if (forced && requestedFrom !== 'batch' && requested && TIER_NAMES.indexOf(requested) < TIER_NAMES.indexOf(forced)) {
    refuse(`lane ${lane} requested tier ${requested} below protected floor ${forced}`, TIER_FLOOR_CONFLICT)
  }
  // #762: an explicit lane tier is the operator's decision. The compiler's
  // proposal advises and never raises it; only the protected floor does.
  const laneChoice = requestedFrom === 'lane' && TIER_NAMES.includes(requested)
  const candidates = laneChoice ? [forced, requested] : [forced, proposed, requested]
  const known = candidates.filter((tier) => TIER_NAMES.includes(tier))
  const tier = known.length === 0
    ? null
    : known.reduce((best, candidate) => TIER_NAMES.indexOf(candidate) > TIER_NAMES.indexOf(best) ? candidate : best)
  const overrodeProposal = laneChoice && TIER_NAMES.includes(proposed) && TIER_NAMES.indexOf(proposed) > TIER_NAMES.indexOf(tier)
  return { lane, tier, forced, proposed, requested, overrodeProposal }
}

// The override is printed, not merely recorded: an operator reading the dispatch
// line must see that the lane's own tier beat a higher proposal (#762).
function overrideNote(result) {
  return result.overrodeProposal ? ` overrode proposal ${result.proposed} with lane tier ${result.tier}` : ''
}

export function checkArrival({ crew, lane, batchTotal, externals } = {}) {
  const state = crew && typeof crew === 'object' ? crew : {}
  if (state.lane_name !== lane) {
    refuse(`crew lane_name is ${JSON.stringify(state.lane_name)}, expected ${lane}`, FENCE_NOT_ARRIVED)
  }
  if (!Array.isArray(state.lane_fence)) {
    refuse(`crew lane_fence is missing or not an array for ${lane}`, FENCE_NOT_ARRIVED)
  }
  const externalNames = new Set((Array.isArray(externals) ? externals : []).filter((name) => typeof name === 'string' && name.trim() !== ''))
  const fence = state.lane_fence
  const members = fence.filter((entry) => !externalNames.has(entry?.lane))
  if (members.length !== batchTotal - 1) {
    refuse(`crew lane_fence for ${lane} names ${members.length} batch sibling(s) besides ${externalNames.size} external fence(s), expected ${batchTotal - 1}`, FENCE_COUNT_MISMATCH)
  }
  const missing = [...externalNames].filter((name) => !fence.some((entry) => entry?.lane === name))
  if (missing.length > 0) {
    refuse(`crew lane_fence for ${lane} does not carry external fence(s): ${missing.join(', ')}`, FENCE_NOT_ARRIVED)
  }
  return { lane, siblings: members, externals: fence.filter((entry) => externalNames.has(entry?.lane)) }
}

export function crewJsonPath({ checkout, lane, deps } = {}) {
  const d = normalDeps(deps)
  return join(d.home, '.crew', slug(basename(checkout)), slug(lane), 'crew.json')
}

function outcomeFromPath(path, d) {
  let exists
  try { exists = d.existsSync(path) } catch {
    return { found: true, outcome: { status: null, commit: null, path } }
  }
  if (!exists) return { found: false, outcome: null }
  try {
    const envelope = JSON.parse(d.readFileSync(path, 'utf8'))
    return {
      found: true,
      outcome: {
        status: typeof envelope?.status === 'string' ? envelope.status : null,
        commit: typeof envelope?.details?.commit === 'string' ? envelope.details.commit : null,
        path,
      },
    }
  } catch {
    return { found: true, outcome: { status: null, commit: null, path } }
  }
}

export function laneOutcome({ lane, laneDir, deps } = {}) {
  const d = normalDeps(deps)
  const crewDir = dirname(crewJsonPath({ checkout: laneDir, lane, deps: d }))
  const livePath = join(crewDir, 'returns', 'task.json')
  const live = outcomeFromPath(livePath, d)
  if (live.found) return live.outcome

  const parent = dirname(crewDir)
  const base = `${basename(crewDir)}.archive-`
  let names
  try { names = d.readdirSync(parent) } catch {
    return { status: null, commit: null, path: null }
  }
  if (!Array.isArray(names)) return { status: null, commit: null, path: null }
  const archives = names
    .map((name) => typeof name === 'string' ? name : name?.name)
    .filter((name) => typeof name === 'string' && name.startsWith(base))
    .sort()
    .reverse()
  for (const archive of archives) {
    const path = join(parent, archive, 'returns', 'task.json')
    const result = outcomeFromPath(path, d)
    if (result.found) return result.outcome
  }
  return { status: null, commit: null, path: null }
}

export function baseContains({ commit, base, checkout, deps } = {}) {
  if (typeof commit !== 'string' || commit.trim() === ''
      || typeof base !== 'string' || base.trim() === '') return false
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  let probe
  try {
    probe = d.spawn({
      file: 'git',
      args: ['-C', root, 'merge-base', '--is-ancestor', commit, base],
      cwd: root,
    })
  } catch {
    return false
  }
  return probe?.status === 0
}

// The transport is a CALLER's choice with headless as the default, so both
// flags at once is a NAMED refusal: a silent precedence is how a whole session
// went by without anyone noticing which transport had booted (#617).
export function resolveTransport({ runFlags = {} } = {}) {
  const panes = runFlags[PANE_TRANSPORT] === true || runFlags[PANE_TRANSPORT] === 'true'
  const headless = runFlags[BOOT_TRANSPORT] === true || runFlags[BOOT_TRANSPORT] === 'true'
  if (panes && headless) {
    refuse(`--${PANE_TRANSPORT} and --${BOOT_TRANSPORT} name different transports; pass exactly one`, TRANSPORT_CONFLICT)
  }
  return panes ? PANE_TRANSPORT : BOOT_TRANSPORT
}

function seatMaps(value) {
  const maps = new Map()
  if (!plainObject(value)) return maps
  for (const role of Object.keys(value).sort()) {
    const fields = value[role]
    if (!plainObject(fields)) continue
    const fieldMap = new Map()
    for (const field of Object.keys(SEAT_FIELDS)) {
      if (Object.hasOwn(fields, field) && typeof fields[field] === 'string' && fields[field].length > 0) {
        fieldMap.set(field, fields[field])
      }
    }
    if (fieldMap.size > 0) maps.set(role, fieldMap)
  }
  return maps
}

function seatsObject(maps) {
  return Object.fromEntries([...maps.entries()].map(([role, fields]) => [role, Object.fromEntries(fields)]))
}

export function batchSeatsFrom(runFlags = {}) {
  const maps = new Map()
  if (!runFlags || typeof runFlags !== 'object') return {}
  for (const [flag, value] of Object.entries(runFlags)) {
    const match = Object.entries(SEAT_FIELDS).find(([, prefix]) => flag.startsWith(prefix) && flag.length > prefix.length)
    if (!match || typeof value !== 'string' || value.length === 0) continue
    const [field, prefix] = match
    const role = flag.slice(prefix.length)
    if (!maps.has(role)) maps.set(role, new Map())
    maps.get(role).set(field, value)
  }
  const ordered = new Map([...maps.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return seatsObject(ordered)
}

export function mergeSeats(batch, lane) {
  const merged = new Map()
  for (const source of [batch, lane]) {
    for (const [role, fields] of seatMaps(source)) {
      if (!merged.has(role)) merged.set(role, new Map())
      const target = merged.get(role)
      for (const [field, value] of fields) target.set(field, value)
    }
  }
  const ordered = new Map([...merged.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return seatsObject(ordered)
}

export function seatChain(batch, lane) {
  const batchMap = seatMaps(batch)
  const laneMap = seatMaps(lane)
  const roles = [...new Set([...batchMap.keys(), ...laneMap.keys()])].sort()
  const chain = new Map()
  for (const role of roles) {
    const batchFields = batchMap.get(role) || new Map()
    const laneFields = laneMap.get(role) || new Map()
    const fields = new Map()
    for (const field of Object.keys(SEAT_FIELDS)) {
      if (!batchFields.has(field) && !laneFields.has(field)) continue
      const fromLane = laneFields.has(field)
      fields.set(field, {
        batch: batchFields.get(field) ?? null,
        lane: laneFields.get(field) ?? null,
        settled: fromLane ? laneFields.get(field) : batchFields.get(field),
        from: fromLane ? 'lane' : 'batch',
      })
    }
    if (fields.size > 0) chain.set(role, fields)
  }
  return seatsObject(chain)
}

function seatEntries(seats, fields = Object.keys(SEAT_FIELDS)) {
  const maps = seatMaps(seats)
  const entries = []
  for (const [role, values] of maps) {
    for (const field of fields) {
      if (values.has(field)) entries.push({ role, field, value: values.get(field) })
    }
  }
  return entries
}

export function seatFlagArgs(seats) {
  return seatEntries(seats, Object.keys(SEAT_FIELDS).filter((field) => field !== 'allow_shortfall'))
    .flatMap(({ role, field, value }) => [`--${SEAT_FIELDS[field]}${role}`, value])
}

export function shortfallFlagArgs(seats) {
  return seatEntries(seats, ['allow_shortfall'])
    .flatMap(({ role, field, value }) => [`--${SEAT_FIELDS[field]}${role}`, value])
}

export function seatSpec(seats) {
  const entries = seatEntries(seats)
  return entries.length > 0 ? entries.map(({ role, field, value }) => `${role}.${field}=${value}`).join(',') : 'none'
}

export function seatFromSpec(batch, lane) {
  const chain = seatChain(batch, lane)
  const entries = []
  for (const role of Object.keys(chain).sort()) {
    for (const field of Object.keys(SEAT_FIELDS)) {
      const cell = chain[role]?.[field]
      if (cell) entries.push(`${role}.${field}=${cell.from}`)
    }
  }
  return entries.length > 0 ? entries.join(',') : 'none'
}

// `--adopt <lane>=<archive-dir>` and a request's `adopt` key name the SAME thing: the
// crew dir a previous attempt left behind. The files live under its task subdirectory,
// so an operator who names the task dir itself is taken at their word.
export function adoptSourceDir(archive) {
  return basename(archive) === 'task' ? archive : join(archive, 'task')
}

export function parseAdoptSpec(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const at = text.indexOf('=')
  if (at <= 0 || at === text.length - 1) {
    refuse(`--adopt must be <lane>=<archive-dir> and received ${JSON.stringify(value)}`, PLAN_ADOPT_UNREADABLE)
  }
  return { lane: text.slice(0, at).trim(), archive: resolve(text.slice(at + 1).trim()) }
}

// Verified BEFORE any worktree is created: a partial adoption is worse than none, so a
// refusal here has copied nothing anywhere. A --adopt for a lane also carrying an
// `adopt` request key wins, and the dispatch line says which route was taken.
export function resolveAdoptions({ lanes, runFlags = {}, deps } = {}) {
  const d = normalDeps(deps)
  const batch = Array.isArray(lanes) ? lanes : []
  const names = new Set(batch.map(laneNameOf))
  const asked = new Map()
  for (const lane of batch) {
    const value = lane?.adopt
    if (typeof value === 'string' && value.trim() !== '') {
      asked.set(laneNameOf(lane), { archive: resolve(value.trim()), from: 'request' })
    }
  }
  const flag = runFlags.adopt
  const specs = Array.isArray(flag) ? flag : (flag === undefined || flag === null ? [] : [flag])
  for (const spec of specs) {
    const { lane, archive } = parseAdoptSpec(spec)
    asked.set(lane, { archive, from: 'cli' })
  }
  const adoptions = new Map()
  for (const [lane, { archive, from }] of [...asked].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!names.has(lane)) refuse(`--adopt names a lane that is not in this batch: ${lane}`, PLAN_ADOPT_UNREADABLE)
    const source = adoptSourceDir(archive)
    const missing = ADOPT_REQUIRED.filter((name) => !d.existsSync(join(source, name)))
    if (missing.length > 0) refuse(`lane ${lane} cannot adopt ${archive}: the archive holds no ${missing.join(' and no ')} under ${source}`, PLAN_ADOPT_UNREADABLE)
    const checkPath = join(source, ADOPT_OPTIONAL[0])
    const hasCheck = d.existsSync(checkPath)
    let revise = false
    if (hasCheck) {
      let text = ''
      try { text = textOf(d.readFileSync(checkPath, 'utf8')) } catch (err) {
        refuse(`lane ${lane} cannot adopt ${archive}: ${checkPath} is unreadable: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
      }
      revise = text.includes(ADOPT_REVISE_MARKER)
    }
    adoptions.set(lane, { lane, archive, source, from, revise, planCheck: hasCheck ? checkPath : null })
  }
  return adoptions
}

// The standing block is a CONSTANT: the same sentence for every adopting lane, plus one
// constant clause when the predecessor was bounced. Nothing lane-specific enters it.
export function adoptionBlock(adoption) {
  return ADOPT_BLOCK + (adoption.revise ? ADOPT_FINDINGS_CLAUSE : '')
}

// Copies, appends the block, records the row — once the lane has booted (so its crew dir
// exists) and before its run starts (so the planner sees the files). Returns null for a
// lane that adopts nothing, so a batch with no adoption produces the bytes it always did.
export function applyAdoption({ adoption, crewDir, briefPath, deps } = {}) {
  const d = normalDeps(deps)
  if (!adoption) return null
  const taskDir = join(crewDir, 'task')
  const texts = new Map()
  let names
  try {
    const missingNow = ADOPT_REQUIRED.filter((name) => !d.existsSync(join(adoption.source, name)))
    if (missingNow.length > 0) {
      refuse(`lane ${adoption.lane} cannot adopt ${adoption.archive}: required file(s) gone at copy time: ${missingNow.join(', ')}`, PLAN_ADOPT_UNREADABLE)
    }
    names = [...ADOPT_REQUIRED, ...ADOPT_OPTIONAL.filter((name) => d.existsSync(join(adoption.source, name)))]
    for (const name of names) {
      const from = join(adoption.source, name)
      const text = textOf(d.readFileSync(from, 'utf8'))
      texts.set(name, text)
    }
  } catch (err) {
    if (err instanceof BatchRefusal) throw err
    refuse(`lane ${adoption.lane} could not read adoption ${adoption.archive} from ${adoption.source}: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
  }
  const written = []
  try {
    d.mkdirSync(taskDir, { recursive: true })
    for (const name of names) {
      const target = join(taskDir, name)
      written.push(target)
      d.writeFileSync(target, texts.get(name))
    }
  } catch (err) {
    for (const path of written) {
      try { rmSync(path, { force: true }) } catch { /* rollback is best effort after an interrupted write */ }
    }
    refuse(`lane ${adoption.lane} could not adopt ${adoption.archive} into ${taskDir}: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
  }
  const planSha = createHash('sha256').update(texts.get('plan.md')).digest('hex')
  try { d.appendFileSync(briefPath, adoptionBlock(adoption)) } catch (err) {
    refuse(`lane ${adoption.lane} could not carry the adoption block into ${briefPath}: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
  }
  const row = {
    at: new Date().toISOString(),
    event: ADOPT_EVENT,
    task: adoption.lane,
    lane: adoption.lane,
    archive: adoption.archive,
    source: adoption.source,
    plan_sha: planSha,
    files: [...texts.keys()],
    findings: adoption.revise,
    adopt_from: adoption.from,
  }
  // Instrumentation is never load-bearing: the copy has already happened and the
  // dispatch line already names it, so a journal that cannot be appended never fails a lane.
  try { d.appendFileSync(join(crewDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`) } catch { /* the dispatch line carries the same fact */ }
  return { plan_sha: planSha, files: [...texts.keys()], taskDir }
}

// The lane's purpose reaches the two surfaces a running lane is read through.
// Both writes are instrumentation: a lane never fails for want of a record.
function recordIntent({ intent, crewPath, crewDir, lane, deps } = {}) {
  const d = normalDeps(deps)
  if (typeof intent !== 'string' || !intent.trim()) return null
  let crew
  try { crew = JSON.parse(textOf(d.readFileSync(crewPath, 'utf8'))) } catch { crew = null }
  if (crew && typeof crew === 'object' && !Array.isArray(crew)) {
    const merged = { ...crew, intent }
    try { d.writeFileSync(crewPath, JSON.stringify(merged, null, 2) + '\n') } catch { /* the log line carries the same fact */ }
  }
  const row = { at: new Date().toISOString(), event: INTENT_EVENT, task: lane, lane, intent }
  try { d.appendFileSync(join(crewDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`) } catch { /* instrumentation is never load-bearing */ }
  return { intent }
}

function bootCommand({ lane, laneDir, tier, registerPath, transport, seats, runFlags = {} }) {
  return {
    file: 'node',
    args: [
      'crew/crew.mjs', 'boot',
      '--task', lane,
      '--checkout', laneDir,
      '--tier', tier,
      '--fences', registerPath,
      '--lane', lane,
      ...seatFlagArgs(seats),
      ...shortfallFlagArgs(seats),
      ...memoryFlagArgs(runFlags),
      // crew.mjs boot knows no --panes flag (KNOWN_FLAGS.boot, crew/crew.mjs:2232):
      // a pane seat is what boot produces WITHOUT --headless-all, so the pane
      // transport is the ABSENCE of this flag, never a flag of its own.
      ...(transport === BOOT_TRANSPORT ? ['--' + BOOT_TRANSPORT] : []),
    ],
    cwd: laneDir,
  }
}

function preflightRunOptions({ variant, runFlags = {}, lanes = [] } = {}) {
  // Both variant checks are PER LANE now: --variant stays the batch default and a lane's own
  // request key wins, so a scout rides in a batch of full lanes (#634). The closed name set
  // and the ctx-lane shapes that require --validation-lane move together.
  const selections = [{ lane: null, selected: variant ?? runFlags.variant }]
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (typeof lane?.variant === 'string') selections.push({ lane: laneNameOf(lane), selected: lane.variant })
  }
  const validationLane = runFlags['validation-lane']
  for (const { lane, selected } of selections) {
    const where = lane ? ` for lane ${lane}` : ''
    if (selected !== undefined && selected !== null && !VARIANT_NAMES.includes(String(selected))) {
      refuse(`unknown run variant${where}: ${selected}`, RUN_FAILED)
    }
    if (VARIANTS[String(selected ?? 'full')]?.sources?.lane === 'ctx'
        && (typeof validationLane !== 'string' || validationLane.trim() === '')) {
      refuse(`run variant ${selected}${where} requires --validation-lane`, RUN_FAILED)
    }
  }
  const rounds = [
    ['plan-rounds', 10], ['build-rounds', 10], ['review-rounds', 10],
  ]
  for (const [flag, max] of rounds) {
    const raw = runFlags[flag]
    if (raw === undefined || raw === null || raw === '') continue
    const text = String(raw).trim()
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > max) {
      refuse(`invalid run option --${flag}: ${raw}`, RUN_FAILED)
    }
  }
  const waits = ['wait-builder', 'wait-planner', 'wait-reviewer', 'wait-lead', 'wait-tech-lead']
  for (const flag of waits) {
    const raw = runFlags[flag]
    if (raw === undefined || raw === null || raw === '') continue
    const text = String(raw).trim()
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 21600) {
      refuse(`invalid run option --${flag}: ${raw}`, RUN_FAILED)
    }
  }
}

function runCommand({ lane, laneDir, briefPath, files, variant, keep, runFlags = {} }) {
  const args = ['crew/crew.mjs', 'run', '--task', lane, '--checkout', laneDir, '--brief-file', briefPath]
  if (keep) args.push('--keep')
  const add = (flag, value) => {
    if (value === undefined || value === null || value === '') return
    args.push(`--${flag}`, String(value))
  }
  add('variant', variant ?? runFlags.variant)
  add('files-in-scope', files.join(','))
  add('validation-lane', runFlags['validation-lane'])
  for (const flag of [
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'suite',
  ]) add(flag, runFlags[flag])
  return { file: 'node', args, cwd: laneDir }
}

function resumeCommand({ batchDir, fences, checkout, parentDir, outDir, tier, variant, runFlags = {}, wave }) {
  const args = ['node', 'scripts/factory/dispatch-batch.mjs']
  const add = (flag, value) => {
    if (value === undefined || value === null || value === '') return
    args.push(`--${flag}`, String(value))
  }
  add('batch', batchDir)
  add('fences', typeof runFlags.fences === 'string' ? runFlags.fences : fences)
  add('checkout', checkout)
  add('parent', parentDir)
  add('out', outDir)
  add('tier', runFlags.tier ?? tier)
  add('variant', runFlags.variant ?? variant)
  add('baseline', runFlags.baseline)
  for (const spec of Array.isArray(runFlags.adopt) ? runFlags.adopt : (runFlags.adopt ? [runFlags.adopt] : [])) add('adopt', spec)
  for (const flag of [
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'validation-lane', 'suite',
  ]) add(flag, runFlags[flag])
  for (const flag of BOOT_MEMORY_FLAGS) add(flag, runFlags[flag])
  for (const flag of Object.keys(runFlags).filter((flag) => Object.values(SEAT_FIELDS)
    .some((prefix) => flag.startsWith(prefix) && flag.length > prefix.length)).sort()) {
    add(flag, runFlags[flag])
  }
  for (const flag of ['no-keep', PANE_TRANSPORT, BOOT_TRANSPORT, 'force']) {
    if (runFlags[flag] === true) args.push(`--${flag}`)
  }
  add('wave', wave)
  return args.join(' ')
}

export async function dispatchBatch({ batchDir, fences, checkout, parentDir, outDir, tier, variant, externals, registerPath: registerOverride, runFlags = {}, deps } = {}) {
  const d = normalDeps(deps)
  const transport = resolveTransport({ runFlags })
  const lanes = readBatch({ batchDir, deps: d })
  const { waves, graph } = planWaves({ lanes })
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const parent = typeof parentDir === 'string' && parentDir.trim() ? parentDir : dirname(resolve(root))
  const fenceReport = checkFences({ fences, lanes, graph, checkout, externals, parentDir: parent, deps: d })
  // Preflight BEFORE planWorktrees: planWorktrees probes git for existing
  // branches, so an unsupported --variant reached here after the probe and was
  // reported as `branch-taken` when the real cause was an invalid run option
  // (RV3-1). A refusal must name the cause it measured, not the first one it
  // tripped over. Ordering is the whole fix — both refusals still fire.
  preflightRunOptions({ variant, runFlags, lanes })
  // Before any worktree exists: an archive that does not hold a plan refuses here,
  // having copied nothing.
  const adoptions = resolveAdoptions({ lanes, runFlags, deps: d })

  const waveRaw = runFlags.wave === undefined || runFlags.wave === null ? 1 : runFlags.wave
  const waveText = String(waveRaw).trim()
  const waveNumber = /^\d+$/.test(waveText) ? Number(waveText) : NaN
  if (!Number.isSafeInteger(waveNumber) || waveNumber < 1 || waveNumber > waves.length) {
    refuse(`invalid --wave ${JSON.stringify(waveRaw)}; this batch has ${waves.length} wave(s)`, BATCH_UNREADABLE)
  }
  const dispatchedNames = waves[waveNumber - 1]
  const waveLanes = lanes.filter((lane) => dispatchedNames.includes(lane.lane))
  const laneNames = lanes.map(laneNameOf)
  const waveOf = new Map(waves.flatMap((wave, index) => wave.map((name) => [name, index + 1])))
  const depsOf = (name) => graph.deps.get(name) || []
  const deferred = laneNames.filter((name) => !dispatchedNames.includes(name))
    .map((name) => ({ lane: name, wave: waveOf.get(name), predecessors: depsOf(name) }))
  const keep = runFlags['no-keep'] !== true
  const dryRun = runFlags['dry-run'] === true || runFlags.dryRun === true
  const batchSeats = batchSeatsFrom(runFlags)
  const outputDir = typeof outDir === 'string' && outDir.trim() ? resolve(outDir) : join(resolve(batchDir), 'out')
  const registerPath = typeof registerOverride === 'string' && registerOverride.trim()
    ? resolve(registerOverride)
    : typeof runFlags.fences === 'string' && runFlags.fences.trim()
      ? resolve(runFlags.fences)
      : join(outputDir, 'dispatch.fences.json')
  const unstarted = []

  const logWaveState = () => {
    if (waves.length > 1) {
      d.log(`dispatch-batch: waves=${waves.length} wave=${waveNumber} lanes=${dispatchedNames.join(',')}`)
      for (const item of deferred) {
        d.log(`dispatch-batch: deferred lane=${item.lane} wave=${item.wave} after=${item.predecessors.join(',')} resume=${resumeCommand({ batchDir, fences: registerPath, checkout: root, parentDir: parent, outDir: outputDir, tier, variant, runFlags, wave: item.wave })}`)
      }
      for (const item of unstarted) {
        d.log(`dispatch-batch: unstarted lane=${item.lane} reason=${item.reason} predecessor=${item.predecessor}`)
      }
    }
  }

  if (waveNumber > 1) {
    const blocked = []
    for (const lane of waveLanes) {
      for (const dep of depsOf(lane.lane)) {
        const outcome = laneOutcome({ lane: dep, laneDir: join(parent, 'dt-' + dep), deps: d })
        if (outcome.status !== 'done') {
          blocked.push({
            lane: lane.lane,
            reason: outcome.status === 'escalation' ? PREDECESSOR_ESCALATED : PREDECESSOR_UNSETTLED,
            predecessor: dep,
          })
          break
        }
        const baseRef = DISPATCH_BASE_REF
        if (!baseContains({ commit: outcome.commit, base: baseRef, checkout: root, deps: d })) refuse(`lane ${lane.lane} depends on ${dep} whose result ${outcome.commit || 'none'} is not contained in the dispatch base ${baseRef}; merge it before dispatching wave ${waveNumber}`, DEPENDENT_BASE_STALE)
      }
    }
    if (blocked.length > 0) {
      const first = blocked[0]
      const byLane = new Map(blocked.map((item) => [item.lane, item]))
      for (const lane of waveLanes) {
        unstarted.push(byLane.get(lane.lane) || {
          lane: lane.lane,
          reason: 'wave-stopped',
          predecessor: first.lane,
        })
      }
      logWaveState()
      return { lanes: [], plans: [], registerPath, outDir: outputDir, keep, transport, waves, wave: waveNumber, deferred, unstarted }
    }
  }
  if (dryRun) {
    const plans = planWorktrees({ lanes: waveLanes, parentDir, checkout, deps: d })
    d.log(JSON.stringify({ dispatch: 'dry-run', plans }))
    for (const lane of waveLanes) {
      d.log(`dispatch-batch: dry-run lane=${lane.lane} tier=${lane.tier ?? tier ?? 'none'} seats=${seatSpec(mergeSeats(batchSeats, lane.seats))} seats_from=${seatFromSpec(batchSeats, lane.seats)}`)
    }
    for (const lane of waveLanes) {
      const adoption = adoptions.get(lane.lane)
      if (adoption) d.log(`dispatch-batch: dry-run lane=${lane.lane} adopt=${adoption.archive} source=${adoption.source} findings=${adoption.revise} adopt_from=${adoption.from}`)
    }
    d.log(DRY_RUN_BLIND_SPOT)
    return { dryRun: true, plans, lanes: waveLanes, fences: fenceReport, waves, wave: waveNumber, deferred, unstarted }
  }
  logWaveState()
  const plans = planWorktrees({ lanes: waveLanes, parentDir, checkout, deps: d })

  try { mkdirSync(outputDir, { recursive: true }) } catch (err) {
    refuse(`cannot create dispatch output directory ${outputDir}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!runFlags.fences) {
    const data = registerData({ fences, registerPath, d })
    try { writeFileSync(registerPath, JSON.stringify(data, null, 2) + '\n') } catch (err) {
      refuse(`cannot write dispatch fence register ${registerPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
  }

  createWorktrees({ plans, checkout: root, deps: d })
  const heads = laneHeads({ plans, deps: d })
  const supplied = typeof runFlags.baseline === 'string' && runFlags.baseline.trim() ? resolve(runFlags.baseline) : null
  if (supplied) d.log(`dispatch-batch: operator supplied baseline path=${supplied}`)
  const baselinePath = supplied || measureBatchBaseline({ plans, outDir: outputDir, checkout: root, heads, deps: d })
  // The compiler's request schema is closed, so every lane is compiled from a
  // copy of its request with the dispatch-only keys removed. The copy is named
  // so it can never be mistaken for an authored request, even when --out points
  // at the batch directory itself.
  const compileRequests = new Map()
  for (const lane of waveLanes) {
    const requestPath = join(outputDir, `${lane.lane}${COMPILE_REQUEST_SUFFIX}`)
    try { writeFileSync(requestPath, JSON.stringify(lane.request, null, 2) + '\n') } catch (err) {
      refuse(`cannot write compiler request ${requestPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
    compileRequests.set(lane.lane, requestPath)
  }

  // SCHEDULING ONLY. make-brief owns baseline acceptance (reuseBaseline,
  // scripts/factory/make-brief.mjs) and still decides reuse for every lane; this predicate never
  // changes what a lane is handed. It answers the one question the scheduler must answer BEFORE it
  // spawns: can this compile run a full suite? A lane handed no baseline, or one recorded for a
  // different commit than its own worktree carries, is at risk, and N of those at once is N suites.
  const atRisk = (plan) => {
    if (!baselinePath) return true
    const head = heads?.get(plan.lane) || null
    if (!head) return true
    let record
    try { record = JSON.parse(textOf(d.readFileSync(baselinePath, 'utf8'))) } catch { return true }
    const command = laneCommandForPlan({ plan, fallbackDir: root, deps: d })
    return !record || typeof record !== 'object' || Array.isArray(record)
      || record.sha !== head
      || !command || record.command !== command
      || !Number.isInteger(record.pass) || record.pass < 0
      || !Number.isInteger(record.fail) || record.fail < 0
  }

  let serial = Promise.resolve()
  const runSerialised = (fn) => {
    const next = serial.then(async () => {
      try { await d.assertQuiet(d.env) } catch (err) {
        refuse(`refusing to measure a lane baseline on a saturated host: ${err?.message || String(err)}`, COMPILE_REFUSED)
      }
      return fn()
    })
    serial = next.then(() => {}, () => {})
    return next
  }

  const startCompile = (plan) => {
    const compile = () => compileLane({
      lane: plan.lane,
      batchDir: resolve(batchDir),
      requestPath: compileRequests.get(plan.lane),
      laneDir: plan.dir,
      registerPath,
      outDir: outputDir,
      fences,
      baselinePath,
      deps: d,
    })
    return atRisk(plan) ? runSerialised(compile) : compile()
  }

  const compiled = []
  const results = await Promise.allSettled(plans.map((plan) => startCompile(plan)))
  for (const settled of results) {
    if (settled.status === 'rejected') throw settled.reason
    compiled.push(settled.value)
  }

  const laneByName = new Map(lanes.map((lane) => [lane.lane, lane]))
  const settled = []
  for (const item of compiled) {
    const staffing = item.staffing || { ...ABSENT_STAFFING }
    const plan = plans.find((candidate) => candidate.lane === item.lane)
    const laneFence = fenceReport.perLane[item.lane]
    const floor = tierFloor({ files: laneFence.files, extra: runFlags.protectedPaths })
    const laneEntry = laneByName.get(item.lane)
    // A lane's own tier is the requested tier for THAT lane; --tier stays the
    // batch default for every lane that does not name one. A protected floor
    // raises a lower batch default, while an explicit lane tier below it refuses.
    const requested = laneEntry?.tier ?? tier
    const laneVariant = laneEntry?.variant ?? variant
    const seats = mergeSeats(batchSeats, laneEntry?.seats)
    const result = reconcileTier({ lane: item.lane, forced: floor.forced, proposed: item.proposed, requested, requestedFrom: laneEntry?.tier ? 'lane' : 'batch' })
    if (!result.tier) refuse(`lane ${item.lane} has no known tier to boot`, BOOT_FAILED)
    d.log(`dispatch-batch: lane=${item.lane} forced=${floor.forced || 'none'} proposed=${item.proposed || 'none'} requested=${requested || 'none'} requested_from=${laneEntry?.tier ? 'lane' : (tier ? 'batch' : 'none')} variant=${laneVariant || 'none'} variant_from=${laneEntry?.variant ? 'lane' : (variant ? 'batch' : 'none')} settled=${result.tier} seats=${seatSpec(seats)} seats_from=${seatFromSpec(batchSeats, laneEntry?.seats)} shape=${staffing.shape || STAFFING_ABSENT} strength=${staffing.strength || STAFFING_ABSENT} misclassified=${staffing.misclassification ? 'true' : 'false'}${overrideNote(result)}`)
    const recordPath = join(outputDir, `${item.lane}${DISPATCH_RECORD_SUFFIX}`)
    const record = {
      lane: item.lane,
      shape: staffing.shape,
      strength: staffing.strength,
      misclassification: staffing.misclassification,
      tier: {
        forced: floor.forced || null,
        proposed: item.proposed || null,
        requested: requested || null,
        settled: result.tier,
        overrode_proposal: result.overrodeProposal === true,
      },
      seats: seatChain(batchSeats, laneEntry?.seats),
      variant: laneVariant || null,
      brief: item.brief,
    }
    try { writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n') } catch (err) {
      refuse(`cannot write dispatch record ${recordPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
    settled.push({ ...item, plan, floor, tier: result.tier, variant: laneVariant, seats, staffing, record: recordPath })
  }

  // #658: every lane whose plan IS its brief is validated before ANY lane boots — the brief is
  // already on disk, and a defect in lane B's brief must not cost lane A's seats. Last in the
  // pre-boot order on purpose: no existing refusal loses the cause it names.
  for (const item of settled) {
    checkDirectedBrief({ lane: item.lane, variant: item.variant, briefPath: item.brief, deps: d })
    if (Object.keys(item.seats).length > 0) {
      const unseated = seatRolesUnseated({ seats: item.seats, tier: item.tier, deps: d })
      if (unseated.length > 0) refuse(`lane ${item.lane} seat override(s) name role(s) the settled tier ${item.tier} does not seat: ${unseated.join(', ')}; crew/roster.json tiers.${item.tier} is the ratified staffing floor and a lane may not staff outside it`, SEAT_FLOOR_CONFLICT)
    }
  }

  const arrivals = []
  for (const item of settled) {
    let boot
    try { boot = d.spawn(bootCommand({ lane: item.lane, laneDir: item.plan.dir, tier: item.tier, registerPath, transport, seats: item.seats, runFlags })) } catch (err) {
      refuse(`crew boot failed for ${item.lane}: ${err?.message || String(err)}`, BOOT_FAILED)
    }
    if (!boot || boot.status !== 0) {
      const floorReason = seatFloorRefusal(childFailure(boot))
      if (floorReason) refuse(`crew boot refused ${item.lane} at a ratified floor [${floorReason}]: ${JSON.stringify(childFailure(boot))}`, SEAT_FLOOR_CONFLICT)
      refuse(`crew boot failed for ${item.lane}: ${JSON.stringify(childFailure(boot))}`, BOOT_FAILED)
    }
    const path = crewJsonPath({ checkout: item.plan.dir, lane: item.lane, deps: d })
    let crew
    try { crew = JSON.parse(d.readFileSync(path, 'utf8')) } catch (err) {
      refuse(`crew boot produced no readable crew.json for ${item.lane}: ${err?.message || String(err)}`, FENCE_NOT_ARRIVED)
    }
    // A pane boot's proof is what boot RETURNED, not the argv it was given:
    // crew.mjs writes workspace_id null whenever no workspace was created
    // (crew/crew.mjs:1626), and a --panes lane with a null workspace is exactly
    // the silent degradation this flag exists to remove.
    const workspaceId = typeof crew.workspace_id === 'string' && crew.workspace_id.trim() ? crew.workspace_id : null
    if (transport === PANE_TRANSPORT && !workspaceId) {
      refuse(`crew boot under --${PANE_TRANSPORT} produced no workspace for ${item.lane}: crew.json workspace_id is ${JSON.stringify(crew.workspace_id ?? null)}`, BOOT_FAILED)
    }
    const arrival = checkArrival({ crew, lane: item.lane, batchTotal: lanes.length, externals })
    arrivals.push({ ...item, crewPath: path, arrival, workspaceId })
  }

  const runs = []
  for (const item of arrivals) {
    const files = fenceReport.perLane[item.lane].files
    const crewDir = dirname(item.crewPath)
    const journal = join(crewDir, 'journal.jsonl')
    const runLog = join(crewDir, 'run.log')
    const adoption = adoptions.get(item.lane) ?? null
    const applied = applyAdoption({ adoption, crewDir, briefPath: item.brief, deps: d })
    const recorded = recordIntent({ intent: item.intent, crewPath: item.crewPath, crewDir, lane: item.lane, deps: d })
    if (recorded) d.log(`dispatch-batch: intent lane=${item.lane} intent=${JSON.stringify(recorded.intent)}`)
    if (applied) d.log(`dispatch-batch: plan-adopted lane=${item.lane} archive=${adoption.archive} source=${adoption.source} plan_sha=${applied.plan_sha} files=${applied.files.join(',')} findings=${adoption.revise} adopt_from=${adoption.from}`)
    let run
    try {
      run = d.spawn({
        ...runCommand({
          lane: item.lane,
          laneDir: item.plan.dir,
          briefPath: item.brief,
          files,
          variant: item.variant,
          keep,
          runFlags,
        }),
        background: true,
        logPath: runLog,
      })
    } catch (err) {
      refuse(`crew run failed for ${item.lane}: ${err?.message || String(err)}`, RUN_FAILED)
    }
    if (run && run.status !== undefined && run.status !== 0 && run.status !== 3) {
      refuse(`crew run failed for ${item.lane}: ${JSON.stringify(childFailure(run))}`, RUN_FAILED)
    }
    // b313-waitextend's driver died with no pid anywhere on disk (#749 ask 1).
    // The pid is a DIAGNOSTIC, never the run's liveness: the run log's terminal
    // {"status":…} line stays the signal.
    const pid = run && Number.isInteger(run.pid) ? run.pid : null
    if (pid !== null) {
      try { writeFileSync(join(crewDir, 'run.pid'), `${pid}\n`) } catch { /* a lane never fails for want of a diagnostic */ }
    }
    const watchArgs = ['scripts/factory/crew-watch.mjs', item.lane, '--follow']
    d.log(`dispatch-batch: watch lane=${item.lane} crew_dir=${crewDir} journal=${journal} run_log=${runLog} run pid=${pid ?? 'none'} command=node ${watchArgs.join(' ')}`)
    runs.push({ lane: item.lane, laneDir: item.plan.dir, result: run, crewDir, journal, runLog, watch: { file: 'node', args: watchArgs, cwd: root }, workspaceId: item.workspaceId, staffing: item.staffing, record: item.record })
  }

  // Keeping the workspaces is a CHOICE, so the dispatcher states it and names
  // the command that undoes it. crew.mjs self-tears-down only on a done run
  // without --keep (crew/crew.mjs:1888); an escalated lane is kept either way.
  const workspaces = runs.map((item) => `${item.lane}=${item.workspaceId}`).join(', ')
  d.log(transport === PANE_TRANSPORT
    ? `dispatch-batch: transport=${PANE_TRANSPORT} — every seat booted into a cmux pane, so each lane HAS a workspace to open: ${workspaces}. Headless is the software-factory mode and the default; panes exist for the interval in which a running lane has no other surface`
    : `dispatch-batch: transport=${BOOT_TRANSPORT} — every seat booted headless, so this batch created no cmux workspace and no panes (workspace_id is null); headless is the software-factory mode. Follow a lane by the crew dir and journal above, never by a workspace`)
  d.log(keep
    ? 'dispatch-batch: workspaces keep=true — every lane workspace and crew dir is kept for inspection; pass --no-keep to let a lane that finishes done tear itself down'
    : 'dispatch-batch: workspaces keep=false — a lane that finishes done tears itself down and archives its crew dir; an escalated lane is kept either way')
  for (const item of runs) {
    d.log(`dispatch-batch: teardown lane=${item.lane} command=node crew/crew.mjs teardown --task ${item.lane} --checkout ${item.laneDir}`)
  }
  return { lanes: runs, plans, registerPath, outDir: outputDir, keep, transport, waves, wave: waveNumber, deferred, unstarted }
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) refuse('arguments must be an array', BATCH_UNREADABLE)
  const flags = {}
  const positional = []
  const valueFlags = new Set([
    'batch', 'fences', 'checkout', 'parent', 'out', 'tier', 'variant', 'wave',
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'validation-lane', 'suite', 'baseline',
    ...BOOT_MEMORY_FLAGS,
  ])
  const booleanFlags = new Set(['dry-run', 'force', 'no-keep', PANE_TRANSPORT, BOOT_TRANSPORT])
  const repeatableFlags = new Set(['adopt'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      if (Object.prototype.hasOwnProperty.call(flags, name)) refuse(`duplicate --${name}`, BATCH_UNREADABLE)
      flags[name] = true
      continue
    }
    const seatFlag = Object.values(SEAT_FIELDS).some((prefix) => name.startsWith(prefix) && name.length > prefix.length)
    if (!seatFlag && !valueFlags.has(name) && !repeatableFlags.has(name)) refuse(`unknown option: --${name}`, BATCH_UNREADABLE)
    if (!repeatableFlags.has(name) && Object.prototype.hasOwnProperty.call(flags, name)) refuse(`duplicate --${name}`, BATCH_UNREADABLE)
    const value = argv[index + 1]
    if (value == null || (typeof value === 'string' && value.startsWith('--'))) {
      refuse(`--${name} requires a value`, BATCH_UNREADABLE)
    }
    if (repeatableFlags.has(name)) flags[name] = [...(flags[name] || []), value]
    else flags[name] = value
    index += 1
  }
  if (positional.length > 0) refuse(`unexpected argument: ${positional[0]}`, BATCH_UNREADABLE)
  return flags
}

export async function main(argv, deps = {}) {
  try {
    const flags = parseCliArgs(argv)
    if (typeof flags.batch !== 'string' || flags.batch.trim() === '') {
      refuse('--batch <directory> is required', BATCH_UNREADABLE)
    }
    if (typeof flags.fences !== 'string' || flags.fences.trim() === '') {
      refuse('--fences <register.json> is required', BATCH_UNREADABLE)
    }
    const checkout = resolve(typeof flags.checkout === 'string' ? flags.checkout : process.cwd())
    const parentDir = typeof flags.parent === 'string' ? resolve(flags.parent) : dirname(checkout)
    const outDir = typeof flags.out === 'string' ? resolve(flags.out) : join(resolve(flags.batch), 'out')
    let register
    try {
      register = readRegister({ fencesPath: flags.fences, checkout, outDir, deps })
    } catch (err) {
      if (err instanceof BatchRefusal) throw err
      refuse(`cannot read or validate fences ${flags.fences}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
    }
    await dispatchBatch({
      batchDir: resolve(flags.batch),
      fences: register.fences,
      externals: register.externals,
      registerPath: register.sanitised ? register.registerPath : undefined,
      checkout,
      parentDir,
      outDir,
      tier: flags.tier,
      variant: flags.variant,
      runFlags: flags,
      deps,
    })
    return 0
  } catch (err) {
    if (err instanceof BatchRefusal) {
      process.stderr.write(`${err.message} [reason: ${err.reason}]\n`)
      return 2
    }
    process.stderr.write(`${err?.message || String(err)}\n`)
    return 1
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) main(process.argv.slice(2)).then((code) => { process.exitCode = code })
