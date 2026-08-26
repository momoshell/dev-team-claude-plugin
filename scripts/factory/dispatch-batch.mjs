#!/usr/bin/env node
// scripts/factory/dispatch-batch.mjs — executable batch dispatch (#584).
// It owns the ordered checks between a batch request directory and background
// crew runs; every failed check is a named refusal and stops the batch.

import { closeSync, existsSync as fsExistsSync, openSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn as childSpawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseDirectedBrief, scopeMatcher, validateScopeEntries as driveValidateScopeEntries, VARIANT_NAMES, VARIANTS } from '../../crew/drive.mjs'
import { protectedHitsIn, resolveProtectedPaths } from '../../crew/protected-paths.mjs'
import { slug } from '../../crew/slug.mjs'
import { LADDER_BANDS, PROPOSAL_BLOCK, TIER_NAMES, gatherFences, validateRequest } from './make-brief.mjs'

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
])

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
export const DISPATCH_ONLY_REQUEST_KEYS = Object.freeze(['tier', 'depends_on', 'variant'])
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

// Every skills/<name>/anchors.json in ONE pass, keyed by the file each pin targets. A
// lane loop must never re-read a manifest: the scan is O(manifests), not O(lanes x files).
export function collectAnchorPins({ checkout, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const byFile = new Map()
  const manifests = []
  let names
  try { names = d.readdirSync(join(root, 'skills')) } catch { return { byFile, manifests } }
  if (!Array.isArray(names)) return { byFile, manifests }
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw : raw?.name
    if (typeof name !== 'string') continue
    const manifest = `skills/${name}/anchors.json`
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

export function checkFences({ fences, lanes, graph, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const entries = fenceEntriesOf(fences).map(normaliseFence)
  const batchLanes = Array.isArray(lanes) ? lanes : []
  const byLane = new Map(entries.map((entry) => [entry.lane, entry]))

  // An absent graph is UNMEASURED edges, not "no edges": relatedLanes reads false for every
  // pair, so an exemption this register does carry is reported as a sibling-leak that does
  // not exist. That false premise cost b224-fencechecks a lane at plan:r1 (#634). With no
  // edge declared anywhere the graph is irrelevant and the answer is unchanged.
  const declaredEdges = batchLanes.some((lane) => Array.isArray(lane?.depends_on) && lane.depends_on.length > 0)
  const hasGraph = Boolean(graph && graph.ancestors instanceof Map)
  if (declaredEdges && !hasGraph) refuse(`checkFences cannot judge sibling-leak for a batch that declares depends_on edges without the graph that carries them; pass the graph planWaves returns`, GRAPH_UNMEASURED)

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

  const pins = collectAnchorPins({ checkout, deps: d })
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
      const text = `${ANCHOR_PIN_WARNING_PREFIX} lane ${name} writes anchor-pinned file(s) whose pinning manifest is outside its fence: ${detail}; a shift is repairable with node skills/qa-test-writing/anchor-pin.mjs --repair <skill dir>, so this does not block dispatch; rot and ambiguity still fail in the skill's own exhibits.test.mjs. ${ANCHOR_BLIND_SPOT}`
      warnings.push({ lane: name, pins: unfencedPins, text })
      d.log(text)
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
  const batchNames = new Set(batchLanes.map(laneNameOf))
  const absent = entries.map(({ lane }) => lane).filter((name) => !batchNames.has(name))
  if (absent.length > 0) refuse(`fence register names lane(s) absent from the batch: ${absent.join(', ')}; the batch carries ${[...batchNames].join(', ') || 'no lanes'}, and a lane's sibling count is derived from batch size, so this register can only refuse at boot as ${FENCE_COUNT_MISMATCH}`, FENCE_REGISTER_MISMATCH)
  return { perLane, warnings }
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
    return { lane: name, brief: briefPath, registerPath: currentRegister, proposed: proposalFromBrief(brief), staffing: staffingFromBrief(brief) }
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
  return { lane: name, brief: briefPath, registerPath: currentRegister, proposed: proposalFromBrief(brief), staffing: staffingFromBrief(brief) }
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
  const crewDir = dirname(crewJsonPath({ checkout: laneDir, lane }))
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

function bootCommand({ lane, laneDir, tier, registerPath, transport }) {
  return {
    file: 'node',
    args: [
      'crew/crew.mjs', 'boot',
      '--task', lane,
      '--checkout', laneDir,
      '--tier', tier,
      '--fences', registerPath,
      '--lane', lane,
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
  for (const flag of [
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'validation-lane', 'suite',
  ]) add(flag, runFlags[flag])
  for (const flag of ['no-keep', PANE_TRANSPORT, BOOT_TRANSPORT, 'force']) {
    if (runFlags[flag] === true) args.push(`--${flag}`)
  }
  add('wave', wave)
  return args.join(' ')
}

export function dispatchBatch({ batchDir, fences, checkout, parentDir, outDir, tier, variant, runFlags = {}, deps } = {}) {
  const d = normalDeps(deps)
  const transport = resolveTransport({ runFlags })
  const lanes = readBatch({ batchDir, deps: d })
  const { waves, graph } = planWaves({ lanes })
  const fenceReport = checkFences({ fences, lanes, graph, checkout, deps: d })
  // Preflight BEFORE planWorktrees: planWorktrees probes git for existing
  // branches, so an unsupported --variant reached here after the probe and was
  // reported as `branch-taken` when the real cause was an invalid run option
  // (RV3-1). A refusal must name the cause it measured, not the first one it
  // tripped over. Ordering is the whole fix — both refusals still fire.
  preflightRunOptions({ variant, runFlags, lanes })

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
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const parent = typeof parentDir === 'string' && parentDir.trim() ? parentDir : dirname(resolve(root))
  const outputDir = typeof outDir === 'string' && outDir.trim() ? resolve(outDir) : join(resolve(batchDir), 'out')
  const registerPath = typeof runFlags.fences === 'string' && runFlags.fences.trim()
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
  const baselinePath = measureBatchBaseline({ plans, outDir: outputDir, checkout: root, deps: d })
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
    const staffing = item.staffing || { ...ABSENT_STAFFING }
    const plan = plans.find((candidate) => candidate.lane === item.lane)
    const laneFence = fenceReport.perLane[item.lane]
    const floor = tierFloor({ files: laneFence.files, extra: runFlags.protectedPaths })
    const laneEntry = laneByName.get(item.lane)
    // A lane's own tier is the requested tier for THAT lane; --tier stays the
    // batch default for every lane that does not name one. The floor still wins
    // and tier-floor-conflict still refuses, per lane.
    const requested = laneEntry?.tier ?? tier
    const laneVariant = laneEntry?.variant ?? variant
    const result = reconcileTier({ lane: item.lane, forced: floor.forced, proposed: item.proposed, requested })
    if (!result.tier) refuse(`lane ${item.lane} has no known tier to boot`, BOOT_FAILED)
    d.log(`dispatch-batch: lane=${item.lane} forced=${floor.forced || 'none'} proposed=${item.proposed || 'none'} requested=${requested || 'none'} requested_from=${laneEntry?.tier ? 'lane' : (tier ? 'batch' : 'none')} variant=${laneVariant || 'none'} variant_from=${laneEntry?.variant ? 'lane' : (variant ? 'batch' : 'none')} settled=${result.tier} shape=${staffing.shape || STAFFING_ABSENT} strength=${staffing.strength || STAFFING_ABSENT} misclassified=${staffing.misclassification ? 'true' : 'false'}`)
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
      },
      variant: laneVariant || null,
      brief: item.brief,
    }
    try { writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n') } catch (err) {
      refuse(`cannot write dispatch record ${recordPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
    settled.push({ ...item, plan, floor, tier: result.tier, variant: laneVariant, staffing, record: recordPath })
  }

  // #658: every lane whose plan IS its brief is validated before ANY lane boots — the brief is
  // already on disk, and a defect in lane B's brief must not cost lane A's seats. Last in the
  // pre-boot order on purpose: no existing refusal loses the cause it names.
  for (const item of settled) {
    checkDirectedBrief({ lane: item.lane, variant: item.variant, briefPath: item.brief, deps: d })
  }

  const arrivals = []
  for (const item of settled) {
    let boot
    try { boot = d.spawn(bootCommand({ lane: item.lane, laneDir: item.plan.dir, tier: item.tier, registerPath, transport })) } catch (err) {
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
    // A pane boot's proof is what boot RETURNED, not the argv it was given:
    // crew.mjs writes workspace_id null whenever no workspace was created
    // (crew/crew.mjs:1626), and a --panes lane with a null workspace is exactly
    // the silent degradation this flag exists to remove.
    const workspaceId = typeof crew.workspace_id === 'string' && crew.workspace_id.trim() ? crew.workspace_id : null
    if (transport === PANE_TRANSPORT && !workspaceId) {
      refuse(`crew boot under --${PANE_TRANSPORT} produced no workspace for ${item.lane}: crew.json workspace_id is ${JSON.stringify(crew.workspace_id ?? null)}`, BOOT_FAILED)
    }
    const arrival = checkArrival({ crew, lane: item.lane, batchTotal: lanes.length })
    arrivals.push({ ...item, crewPath: path, arrival, workspaceId })
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
    const watchArgs = ['scripts/factory/crew-watch.mjs', item.lane, '--follow']
    d.log(`dispatch-batch: watch lane=${item.lane} crew_dir=${crewDir} journal=${journal} run_log=${runLog} command=node ${watchArgs.join(' ')}`)
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
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'validation-lane', 'suite',
  ])
  const booleanFlags = new Set(['dry-run', 'force', 'no-keep', PANE_TRANSPORT, BOOT_TRANSPORT])
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
