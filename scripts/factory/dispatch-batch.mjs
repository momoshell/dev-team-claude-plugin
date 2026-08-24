#!/usr/bin/env node
// scripts/factory/dispatch-batch.mjs — executable batch dispatch (#584).
// It owns the ordered checks between a batch request directory and background
// crew runs; every failed check is a named refusal and stops the batch.

import { closeSync, existsSync as fsExistsSync, openSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn as childSpawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scopeMatcher, validateScopeEntries as driveValidateScopeEntries, VARIANT_NAMES, VARIANTS } from '../../crew/drive.mjs'
import { protectedHitsIn, resolveProtectedPaths } from '../../crew/protected-paths.mjs'
import { slug } from '../../crew/slug.mjs'
import { TIER_NAMES, gatherFences, validateRequest } from './make-brief.mjs'

const BATCH_EMPTY = 'batch-empty'
const BATCH_UNREADABLE = 'batch-unreadable'
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

export const REFUSAL_REASONS = Object.freeze([
  BATCH_EMPTY,
  BATCH_UNREADABLE,
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
])

// These two names belong to the compiler. The batch dispatcher parses its
// refusal text but deliberately does not add compiler names to its own list.
export const COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'
export const STALE_READ_ACK = 'stale-read-ack'

export const REQUEST_SUFFIX = '.request.json'

// Keys a lane's request carries for the DISPATCHER, not for the compiler. The
// compiler's request schema is closed (REQUEST_KEYS, make-brief.mjs:51), so a
// dispatch-only key is split off here and never reaches the compiled request.
export const DISPATCH_ONLY_REQUEST_KEYS = Object.freeze(['tier'])
export const COMPILE_REQUEST_SUFFIX = '.compile-request.json'

export class BatchRefusal extends Error {
  constructor(message, reason) {
    super(`dispatch-batch: ${message}`)
    this.name = 'BatchRefusal'
    this.reason = reason
  }
}

function refuse(message, reason) { throw new BatchRefusal(message, reason) }

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
    readdirSync: deps.readdirSync || fsReaddirSync,
    spawn: deps.spawn || ((options) => options?.background
      ? spawnBackground(options)
      : spawnSync(options.file, options.args, { cwd: options.cwd, env: options.env, encoding: 'utf8' })),
    log: deps.log || ((line) => process.stdout.write(`${line}\n`)),
  }
}

function normaliseRepoPath(value) {
  const normal = String(value).replaceAll('\\', '/')
  if (normal === './') return '.'
  return normal.startsWith('./') ? normal.slice(2) : normal
}

function laneNameOf(lane) {
  if (typeof lane === 'string') return lane
  if (lane && typeof lane.lane === 'string') return lane.lane
  if (lane && typeof lane.name === 'string') return lane.name
  return String(lane ?? '')
}

function laneWhereOf(lane) {
  if (lane && Array.isArray(lane.where)) return lane.where.map(normaliseRepoPath)
  if (lane && Array.isArray(lane.request?.where)) return lane.request.where.map(normaliseRepoPath)
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
      where: request.where.map(normaliseRepoPath),
    })
  }
  return lanes.sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)
}

export function checkFences({ fences, lanes } = {}) {
  const entries = fenceEntriesOf(fences).map(normaliseFence)
  const batchLanes = Array.isArray(lanes) ? lanes : []
  const byLane = new Map(entries.map((entry) => [entry.lane, entry]))

  // Check the register's membership before inspecting its shapes: a batch lane
  // can never fall through to an implicit, unfenced write surface.
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

  const perLane = {}
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    const own = byLane.get(name)
    const ownFiles = own.files.map(normaliseRepoPath)
    const ownWhere = laneWhereOf(lane)
    const matchOwn = scopeMatcher(ownFiles)
    if (!ownWhere.every(matchOwn)) {
      const outside = ownWhere.filter((path) => !matchOwn(path))
      refuse(`lane ${name} where path(s) outside own fence: ${outside.join(', ')}`, WHERE_OUTSIDE_FENCE)
    }

    const siblings = []
    for (const sibling of entries) {
      if (sibling.lane === name) continue
      const siblingFiles = sibling.files.map(normaliseRepoPath)
      const matchSibling = scopeMatcher(siblingFiles)
      if (ownFiles.some(matchSibling)) {
        const leaked = ownFiles.filter(matchSibling)
        refuse(`lane ${name} own fence overlaps sibling ${sibling.lane}: ${leaked.join(', ')}`, SIBLING_LEAK)
      }
      siblings.push({ lane: sibling.lane, files: siblingFiles })
    }
    perLane[name] = {
      lane: name,
      files: ownFiles,
      where: ownWhere,
      reads: Array.isArray(own.reads) ? own.reads : [],
      siblings,
    }
  }
  return { perLane }
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
        args: ['-C', root, 'worktree', 'add', '-b', plan.branch, plan.dir, 'main'],
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

function writeUpdatedRegister({ data, lane, reason, files, outDir, d }) {
  const copy = JSON.parse(JSON.stringify(data))
  if (!Array.isArray(copy?.lanes)) refuse(`compile fence register has no lanes array for ${lane}`, READS_UNRESOLVED)
  const entry = copy.lanes.find((candidate) => candidate && candidate.lane === lane)
  if (!entry) refuse(`compile fence register has no lane ${lane}`, READS_UNRESOLVED)
  const current = Array.isArray(entry.reads) ? entry.reads.filter((read) => read && typeof read.file === 'string') : []
  const byFile = new Map(current.map((read) => [normaliseRepoPath(read.file), { ...read, file: normaliseRepoPath(read.file) }]))
  if (reason === COUPLED_SOURCE_UNFENCED) {
    for (const file of files) {
      byFile.set(file, { file, why: `compiler reported a coupled source while compiling lane ${lane}` })
    }
  } else {
    for (const file of files) byFile.delete(file)
  }
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

export function measureBatchBaseline({ plans, outDir, checkout, deps } = {}) {
  const d = normalDeps(deps)
  if (!Array.isArray(plans) || plans.length < 2) return null
  const shas = new Set()
  for (const plan of plans) {
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
    shas.add(sha)
  }
  if (shas.size !== 1) {
    d.log('dispatch-batch: lanes do not share a commit; measuring per lane')
    return null
  }
  if (typeof outDir !== 'string' || !outDir.trim()) return null
  const path = join(outDir, 'batch-baseline.json')
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
  d.log(`dispatch-batch: measured shared baseline sha=${[...shas][0]} path=${path}`)
  return path
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

export function compileLane({ lane, batchDir, requestPath, laneDir, registerPath, outDir, fences, baselinePath, deps } = {}) {
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

  let currentRegister = authoredRegister
  let result
  try { result = d.spawn(compileCommand({ lane: name, requestPath: compileRequest, laneDir: checkout, registerPath: currentRegister, outDir: outputDir, baselinePath })) } catch (err) {
    refuse(`compiler could not start for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (result?.status === 0) {
    const briefPath = join(outputDir, `${name}.brief.md`)
    let brief
    try { brief = textOf(d.readFileSync(briefPath, 'utf8')) } catch (err) {
      refuse(`compiler produced no readable brief for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
    return { lane: name, brief: briefPath, registerPath: currentRegister, proposed: proposalFromBrief(brief) }
  }

  const firstStderr = childFailure(result)
  const parsed = readsFromRefusal(firstStderr)
  if (parsed.reason !== COUPLED_SOURCE_UNFENCED && parsed.reason !== STALE_READ_ACK) {
    refuse(`compiler refused lane ${name}: ${JSON.stringify(firstStderr)}`, READS_UNRESOLVED)
  }
  if (parsed.files.length === 0) {
    refuse(`compiler refusal for lane ${name} did not name any reads: ${JSON.stringify(firstStderr)}`, READS_UNRESOLVED)
  }
  const data = registerData({ fences, registerPath: authoredRegister, d })
  currentRegister = writeUpdatedRegister({ data, lane: name, reason: parsed.reason, files: parsed.files, outDir: outputDir, d })

  let second
  try { second = d.spawn(compileCommand({ lane: name, requestPath: compileRequest, laneDir: checkout, registerPath: currentRegister, outDir: outputDir, baselinePath })) } catch (err) {
    refuse(`compiler retry could not start for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!second || second.status !== 0) {
    refuse(`compiler retry refused lane ${name}: ${JSON.stringify(childFailure(second))}`, COMPILE_REFUSED)
  }
  const briefPath = join(outputDir, `${name}.brief.md`)
  let brief
  try { brief = textOf(d.readFileSync(briefPath, 'utf8')) } catch (err) {
    refuse(`compiler retry produced no readable brief for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  return { lane: name, brief: briefPath, registerPath: currentRegister, proposed: proposalFromBrief(brief) }
}

export function tierFloor({ files, extra } = {}) {
  const paths = resolveProtectedPaths(extra)
  const hits = protectedHitsIn(files, paths)
  const forced = hits.length > 0 ? 'judge' : null
  return { hits, forced, floor: forced }
}

export function reconcileTier({ lane, forced, proposed, requested } = {}) {
  if (forced && requested && TIER_NAMES.indexOf(requested) < TIER_NAMES.indexOf(forced)) {
    refuse(`lane ${lane} requested tier ${requested} below protected floor ${forced}`, TIER_FLOOR_CONFLICT)
  }
  const known = [forced, proposed, requested].filter((tier) => TIER_NAMES.includes(tier))
  const tier = known.length === 0
    ? null
    : known.reduce((best, candidate) => TIER_NAMES.indexOf(candidate) > TIER_NAMES.indexOf(best) ? candidate : best)
  return { lane, tier, forced, proposed, requested }
}

export function checkArrival({ crew, lane, batchTotal } = {}) {
  const state = crew && typeof crew === 'object' ? crew : {}
  if (state.lane_name !== lane) {
    refuse(`crew lane_name is ${JSON.stringify(state.lane_name)}, expected ${lane}`, FENCE_NOT_ARRIVED)
  }
  if (!Array.isArray(state.lane_fence)) {
    refuse(`crew lane_fence is missing or not an array for ${lane}`, FENCE_NOT_ARRIVED)
  }
  if (state.lane_fence.length !== batchTotal - 1) {
    refuse(`crew lane_fence for ${lane} names ${state.lane_fence.length} siblings, expected ${batchTotal - 1}`, FENCE_COUNT_MISMATCH)
  }
  return { lane, siblings: state.lane_fence }
}

export function crewJsonPath({ checkout, lane } = {}) {
  return join(homedir(), '.crew', slug(basename(checkout)), slug(lane), 'crew.json')
}

function bootCommand({ lane, laneDir, tier, registerPath }) {
  return {
    file: 'node',
    args: [
      'crew/crew.mjs', 'boot',
      '--task', lane,
      '--checkout', laneDir,
      '--tier', tier,
      '--fences', registerPath,
      '--lane', lane,
      '--headless-all',
    ],
    cwd: laneDir,
  }
}

function preflightRunOptions({ variant, runFlags = {} } = {}) {
  const selected = variant ?? runFlags.variant
  if (selected !== undefined && selected !== null && !VARIANT_NAMES.includes(String(selected))) {
    refuse(`unknown run variant: ${selected}`, RUN_FAILED)
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
  const lane = runFlags['validation-lane']
  if (VARIANTS[String(selected ?? 'full')]?.sources?.lane === 'ctx'
      && (typeof lane !== 'string' || lane.trim() === '')) {
    refuse(`run variant ${selected} requires --validation-lane`, RUN_FAILED)
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

export function dispatchBatch({ batchDir, fences, checkout, parentDir, outDir, tier, variant, runFlags = {}, deps } = {}) {
  const d = normalDeps(deps)
  const lanes = readBatch({ batchDir, deps: d })
  const fenceReport = checkFences({ fences, lanes })
  // Preflight BEFORE planWorktrees: planWorktrees probes git for existing
  // branches, so an unsupported --variant reached here after the probe and was
  // reported as `branch-taken` when the real cause was an invalid run option
  // (RV3-1). A refusal must name the cause it measured, not the first one it
  // tripped over. Ordering is the whole fix — both refusals still fire.
  preflightRunOptions({ variant, runFlags })
  const plans = planWorktrees({ lanes, parentDir, checkout, deps: d })
  const keep = runFlags['no-keep'] !== true
  const dryRun = runFlags['dry-run'] === true || runFlags.dryRun === true
  if (dryRun) {
    d.log(JSON.stringify({ dispatch: 'dry-run', plans }))
    return { dryRun: true, plans, lanes, fences: fenceReport }
  }

  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const outputDir = typeof outDir === 'string' && outDir.trim() ? resolve(outDir) : join(resolve(batchDir), 'out')
  try { mkdirSync(outputDir, { recursive: true }) } catch (err) {
    refuse(`cannot create dispatch output directory ${outputDir}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  const registerPath = typeof runFlags.fences === 'string' && runFlags.fences.trim()
    ? resolve(runFlags.fences)
    : join(outputDir, 'dispatch.fences.json')
  if (!runFlags.fences) {
    const data = registerData({ fences, registerPath, d })
    try { writeFileSync(registerPath, JSON.stringify(data, null, 2) + '\n') } catch (err) {
      refuse(`cannot write dispatch fence register ${registerPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
  }

  createWorktrees({ plans, checkout: root, deps: d })
  const baselinePath = measureBatchBaseline({ plans, outDir: outputDir, checkout: root, deps: d })
  // The compiler's request schema is closed, so every lane is compiled from a
  // copy of its request with the dispatch-only keys removed. The copy is named
  // so it can never be mistaken for an authored request, even when --out points
  // at the batch directory itself.
  const compileRequests = new Map()
  for (const lane of lanes) {
    const requestPath = join(outputDir, `${lane.lane}${COMPILE_REQUEST_SUFFIX}`)
    try { writeFileSync(requestPath, JSON.stringify(lane.request, null, 2) + '\n') } catch (err) {
      refuse(`cannot write compiler request ${requestPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
    compileRequests.set(lane.lane, requestPath)
  }

  const compiled = []
  for (const plan of plans) {
    compiled.push(compileLane({
      lane: plan.lane,
      batchDir: resolve(batchDir),
      requestPath: compileRequests.get(plan.lane),
      laneDir: plan.dir,
      registerPath,
      outDir: outputDir,
      fences,
      baselinePath,
      deps: d,
    }))
  }

  const laneByName = new Map(lanes.map((lane) => [lane.lane, lane]))
  const settled = []
  for (const item of compiled) {
    const plan = plans.find((candidate) => candidate.lane === item.lane)
    const laneFence = fenceReport.perLane[item.lane]
    const floor = tierFloor({ files: laneFence.files, extra: runFlags.protectedPaths })
    const laneEntry = laneByName.get(item.lane)
    // A lane's own tier is the requested tier for THAT lane; --tier stays the
    // batch default for every lane that does not name one. The floor still wins
    // and tier-floor-conflict still refuses, per lane.
    const requested = laneEntry?.tier ?? tier
    const result = reconcileTier({ lane: item.lane, forced: floor.forced, proposed: item.proposed, requested })
    if (!result.tier) refuse(`lane ${item.lane} has no known tier to boot`, BOOT_FAILED)
    d.log(`dispatch-batch: lane=${item.lane} forced=${floor.forced || 'none'} proposed=${item.proposed || 'none'} requested=${requested || 'none'} requested_from=${laneEntry?.tier ? 'lane' : (tier ? 'batch' : 'none')} settled=${result.tier}`)
    settled.push({ ...item, plan, floor, tier: result.tier })
  }

  const arrivals = []
  for (const item of settled) {
    let boot
    try { boot = d.spawn(bootCommand({ lane: item.lane, laneDir: item.plan.dir, tier: item.tier, registerPath })) } catch (err) {
      refuse(`crew boot failed for ${item.lane}: ${err?.message || String(err)}`, BOOT_FAILED)
    }
    if (!boot || boot.status !== 0) {
      refuse(`crew boot failed for ${item.lane}: ${JSON.stringify(childFailure(boot))}`, BOOT_FAILED)
    }
    const path = crewJsonPath({ checkout: item.plan.dir, lane: item.lane })
    let crew
    try { crew = JSON.parse(d.readFileSync(path, 'utf8')) } catch (err) {
      refuse(`crew boot produced no readable crew.json for ${item.lane}: ${err?.message || String(err)}`, FENCE_NOT_ARRIVED)
    }
    const arrival = checkArrival({ crew, lane: item.lane, batchTotal: lanes.length })
    arrivals.push({ ...item, crewPath: path, arrival })
  }

  const runs = []
  for (const item of arrivals) {
    const files = fenceReport.perLane[item.lane].files
    const crewDir = dirname(item.crewPath)
    const journal = join(crewDir, 'journal.jsonl')
    const runLog = join(crewDir, 'run.log')
    let run
    try {
      run = d.spawn({
        ...runCommand({
          lane: item.lane,
          laneDir: item.plan.dir,
          briefPath: item.brief,
          files,
          variant,
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
    const watchArgs = ['scripts/factory/crew-watch.mjs', item.lane, '--follow']
    d.log(`dispatch-batch: watch lane=${item.lane} crew_dir=${crewDir} journal=${journal} run_log=${runLog} command=node ${watchArgs.join(' ')}`)
    runs.push({ lane: item.lane, laneDir: item.plan.dir, result: run, crewDir, journal, runLog, watch: { file: 'node', args: watchArgs, cwd: root } })
  }

  // Keeping the workspaces is a CHOICE, so the dispatcher states it and names
  // the command that undoes it. crew.mjs self-tears-down only on a done run
  // without --keep (crew/crew.mjs:1888); an escalated lane is kept either way.
  d.log(keep
    ? 'dispatch-batch: workspaces keep=true — every lane workspace and crew dir is kept for inspection; pass --no-keep to let a lane that finishes done tear itself down'
    : 'dispatch-batch: workspaces keep=false — a lane that finishes done tears itself down and archives its crew dir; an escalated lane is kept either way')
  for (const item of runs) {
    d.log(`dispatch-batch: teardown lane=${item.lane} command=node crew/crew.mjs teardown --task ${item.lane} --checkout ${item.laneDir}`)
  }
  return { lanes: runs, plans, registerPath, outDir: outputDir, keep }
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) refuse('arguments must be an array', BATCH_UNREADABLE)
  const flags = {}
  const positional = []
  const valueFlags = new Set([
    'batch', 'fences', 'checkout', 'parent', 'out', 'tier', 'variant',
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'validation-lane', 'suite',
  ])
  const booleanFlags = new Set(['dry-run', 'force', 'no-keep'])
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
    if (!valueFlags.has(name)) refuse(`unknown option: --${name}`, BATCH_UNREADABLE)
    if (Object.prototype.hasOwnProperty.call(flags, name)) refuse(`duplicate --${name}`, BATCH_UNREADABLE)
    const value = argv[index + 1]
    if (value == null || (typeof value === 'string' && value.startsWith('--'))) {
      refuse(`--${name} requires a value`, BATCH_UNREADABLE)
    }
    flags[name] = value
    index += 1
  }
  if (positional.length > 0) refuse(`unexpected argument: ${positional[0]}`, BATCH_UNREADABLE)
  return flags
}

export function main(argv, deps = {}) {
  try {
    const flags = parseCliArgs(argv)
    if (typeof flags.batch !== 'string' || flags.batch.trim() === '') {
      refuse('--batch <directory> is required', BATCH_UNREADABLE)
    }
    if (typeof flags.fences !== 'string' || flags.fences.trim() === '') {
      refuse('--fences <register.json> is required', BATCH_UNREADABLE)
    }
    const checkout = resolve(typeof flags.checkout === 'string' ? flags.checkout : process.cwd())
    let fences
    try {
      fences = gatherFences({ fencesPath: flags.fences, checkout })
    } catch (err) {
      refuse(`cannot read or validate fences ${flags.fences}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
    }
    const parentDir = typeof flags.parent === 'string' ? resolve(flags.parent) : dirname(checkout)
    const outDir = typeof flags.out === 'string' ? resolve(flags.out) : join(resolve(flags.batch), 'out')
    dispatchBatch({
      batchDir: resolve(flags.batch),
      fences,
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
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
