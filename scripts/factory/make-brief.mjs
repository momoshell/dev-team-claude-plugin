#!/usr/bin/env node
// scripts/factory/make-brief.mjs — compile the mechanical half of a brief from
// four ratified authored lines. It verifies the requested paths, finds tests
// that pin those paths and their discoverable keys, measures the target's
// baseline, carries caller-supplied fences, and repeats the standing blocks.
// It never decides the carve, acceptance judgment, or crew decisions.
//
// LIBRARY vs CLI: importing this file performs no I/O. main(argv) returns an
// exit code and never calls process.exit; the invokedDirectly guard at the
// bottom sets process.exitCode. Exit codes are 0 for success, 1 for an
// unexpected internal error, and 2 for a usage/refusal error, matching the
// other scripts/factory modules.
//
// The discovery transcription is the specification in
// crew/roles/planner.md:67-83. That charter is cited here, not read at
// runtime: crew/ is a separate lane and coupling a compiler to prose would
// make an unrelated charter edit change a compilation. #240 is why the
// baseline child gets a colour-neutral environment before its output is
// parsed. The standing blocks remain inline constants only until #252's repo
// profile lands; then each small gatherer can be swapped without rewriting
// the compiler.
//
// A tier is proposed, never decided: #45 item 4's ratified rule lives here
// because these mechanical signals exist before boot. Protected paths arrive
// via a library parameter, --protected JSON, or the default owned by #250;
// blueprint/shape proposal is deliberately absent pending #251.
//
// A blank decision slot is not authored by this module: it is emitted as the
// literal UNFILLED SLOT marker so the orchestrator can fill it. The ask is the
// one authored line that is checked at construction time and refused when it
// is blank, too short, or merely repeats its task heading.
//
// The declared write surface comes from the fence register when --lane names
// a lane in it, from the authored where otherwise, and never from the output
// filename.

import {
  existsSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REQUEST_KEYS = Object.freeze(['ask', 'where', 'done_means', 'out_of_scope'])
const CODE_EXTENSIONS = Object.freeze(['.js', '.mjs'])
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ERROR_CODE = /^[a-z0-9]+(?:[-:][a-z0-9]+)+$/
const WRITTEN_PATH = /^[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+$/
const QUOTED_LITERAL = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g
const EXPORTED_DECLARATION = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
const EXPORTED_LIST = /^export\s*\{([^}]*)\}/gm
const TEST_FILE = /(^|\/)[^/]*\.test\.mjs$/
const BROAD_KEY_LIMIT = 30
const BASELINE_TIMEOUT_MS = 30_000

export const TIER_NAMES = Object.freeze(['mechanical', 'build', 'judge'])
// Injected by the caller; #250 owns the real list. Wiring it later is a
// one-line change to this default.
export const DEFAULT_PROTECTED_PATHS = Object.freeze([])
const MECHANICAL_MAX_SOURCES = 1
const BUILD_MAX_SOURCES = 4
const BROAD_TRIPWIRE_FLOOR = 6

// These are the only refusal reasons this CLI publishes. Keeping the list
// closed makes a caller able to enumerate every expected refusal without
// depending on incidental filesystem or parser wording.
const MISSING_LINE = 'missing-line'
const WRONG_TYPE = 'wrong-type'
const UNKNOWN_KEY = 'unknown-key'
const BLANK_ASK = 'blank-ask'
const RESTATING_ASK = 'restating-ask'
const MISSING_PATH = 'missing-path'
const NOT_A_GIT_REPO = 'not-a-git-repo'
const OUT_DIR_MISSING = 'out-dir-missing'
const OUT_EXISTS = 'out-exists'
const BAD_FENCES = 'bad-fences'
const BAD_PROTECTED = 'bad-protected'
const UNKNOWN_LANE = 'unknown-lane'

export const REFUSAL_REASONS = Object.freeze([
  MISSING_LINE,
  WRONG_TYPE,
  UNKNOWN_KEY,
  BLANK_ASK,
  RESTATING_ASK,
  MISSING_PATH,
  NOT_A_GIT_REPO,
  OUT_DIR_MISSING,
  OUT_EXISTS,
  BAD_FENCES,
  BAD_PROTECTED,
  UNKNOWN_LANE,
])

export const BROAD_KEY_HIT_LIMIT = BROAD_KEY_LIMIT
export const SLOT_MARKER = 'UNFILLED SLOT'

// Copied byte-for-byte from the converged brief's standing acceptance block.
export const ACCEPTANCE_GATE_BLOCK = Object.freeze(`Planner authors it; **RED at baseline**, printing
\`GATE-SUMMARY {"total":n,"failed":n,"errored":n}\` (\`GATE_SUMMARY_PREFIX\`,
\`crew/drive.mjs:70\`) with \`errored: 0\` at baseline (#153). Prove the gate
discriminates (#168), resolve the repo from \`process.cwd()\`, name in a comment
the mutation each check kills, never assert the checkout is clean. If your
gate shells out to the suite, strip ANSI before parsing it (#240).`)

// The task-specific write-surface and grep lines precede this unchanged
// standing tail in the rendered Conventions block.
export const CONVENTIONS_BLOCK = Object.freeze(`- The factory scripts carry a Node ≥24 floor; follow the existing
  \`scripts/factory/*\` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No \`Co-Authored-By\` trailers.
- If interrupted, write your ReturnEnvelope first on resume — \`status:
  insufficient\` if incomplete. A silent seat is indistinguishable from a dead
  one.`)

function standingBlocks() {
  return { acceptance: ACCEPTANCE_GATE_BLOCK, conventions: CONVENTIONS_BLOCK }
}

export class BriefUsageError extends Error {
  constructor(message, reason = MISSING_LINE) {
    super(message)
    this.name = 'BriefUsageError'
    this.reason = reason
  }
}

function refuseUsage(message, reason = MISSING_LINE) {
  throw new BriefUsageError(`brief: ${message}`, reason)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function repoRelative(repoRoot, filePath) {
  const value = relative(repoRoot, filePath).split(sep).join('/')
  return value === '' ? '.' : value
}

function normaliseRepoPath(value) {
  const normal = String(value).replaceAll('\\', '/')
  if (normal === './') return '.'
  return normal.startsWith('./') ? normal.slice(2) : normal
}

function gitRoot(checkout) {
  const cwd = realpathOr(resolve(checkout || process.cwd()))
  let result
  try {
    result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    refuseUsage(`checkout is not a git repository: ${cwd}`, NOT_A_GIT_REPO)
  }
  if (!result || result.status !== 0 || !nonEmptyString(result.stdout)) {
    refuseUsage(`checkout is not a git repository: ${cwd}`, NOT_A_GIT_REPO)
  }
  return realpathOr(resolve(result.stdout.trim()))
}

function parseTaskStem(filePath) {
  const file = basename(filePath)
  const extension = extname(file)
  return extension ? file.slice(0, -extension.length) : file
}

function askTokens(value) {
  return String(value).toLowerCase().match(/[a-z0-9]+/g) || []
}

// This is deliberately the compiler's construction-time definition of a
// heading-restating ask: at least three alphanumeric tokens, and every unique
// ask token appears in the task-name token set.
export function validateAsk(ask, taskName) {
  if (typeof ask !== 'string') refuseUsage('ask must be a string', WRONG_TYPE)
  if (!ask.trim()) refuseUsage('ask must not be blank', BLANK_ASK)
  const tokens = askTokens(ask)
  if (tokens.length < 3) {
    refuseUsage('ask must contain at least three alphanumeric tokens', MISSING_LINE)
  }
  const heading = new Set(askTokens(taskName || ''))
  const distinct = new Set(tokens)
  if (heading.size > 0 && [...distinct].every((token) => heading.has(token))) {
    refuseUsage('ask merely restates the task name', RESTATING_ASK)
  }
  return ask
}

export function validateRequest(request, { taskName } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    refuseUsage('request must be a JSON object', WRONG_TYPE)
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(key)) {
      refuseUsage(`unknown request key: ${key}`, UNKNOWN_KEY)
    }
  }
  for (const key of REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) {
      refuseUsage(`request is missing ${key}`, MISSING_LINE)
    }
  }
  if (typeof request.ask !== 'string') refuseUsage('ask must be a string', WRONG_TYPE)
  if (!request.ask.trim()) refuseUsage('ask must not be blank', BLANK_ASK)
  if (!Array.isArray(request.where)) refuseUsage('where must be an array', WRONG_TYPE)
  if (request.where.length === 0) refuseUsage('where must not be empty', MISSING_LINE)
  for (const path of request.where) {
    if (typeof path !== 'string') refuseUsage('every where entry must be a string', WRONG_TYPE)
    if (!path.trim()) refuseUsage('every where entry must be non-blank', MISSING_LINE)
  }
  for (const key of ['done_means', 'out_of_scope']) {
    if (typeof request[key] !== 'string') refuseUsage(`${key} must be a string`, WRONG_TYPE)
    if (!request[key].trim()) refuseUsage(`${key} must not be blank`, MISSING_LINE)
  }
  validateAsk(request.ask, taskName)
  return request
}

function absoluteWhere(checkout, entry) {
  return resolve(realpathOr(resolve(checkout)), entry)
}

export function verifyWhere({ checkout, where }) {
  const root = gitRoot(checkout)
  if (!Array.isArray(where)) refuseUsage('where must be an array', WRONG_TYPE)
  return where.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      refuseUsage(`where entry is invalid: ${String(entry)}`, MISSING_LINE)
    }
    const absolute = absoluteWhere(root, entry)
    const relativePath = relative(root, absolute).split(sep).join('/')
    if (relativePath === '..' || relativePath.startsWith('../')) {
      refuseUsage(`where path is outside checkout: ${entry}`, MISSING_PATH)
    }
    let stat
    try {
      stat = statSync(absolute)
    } catch {
      refuseUsage(`where path does not exist: ${entry}`, MISSING_PATH)
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      refuseUsage(`where path is neither a file nor directory: ${entry}`, MISSING_PATH)
    }
    // Resolve the repository once here as a refusal, even for an otherwise
    // valid path. The return keeps the author's spelling for rendering.
    if (!root) refuseUsage(`checkout is not a git repository: ${checkout}`, NOT_A_GIT_REPO)
    return { path: entry, kind: stat.isDirectory() ? 'directory' : 'file' }
  })
}

function listDirectoryFiles(checkout, repoRoot, entry) {
  const absolute = absoluteWhere(checkout, entry.path)
  const relativeEntry = repoRelative(repoRoot, absolute)
  const pathspec = relativeEntry === '.' ? '.' : relativeEntry
  let result
  try {
    result = spawnSync('git', ['-C', checkout, 'ls-files', '-z', '--', pathspec], {
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    refuseUsage(`cannot list files under ${entry.path}`, NOT_A_GIT_REPO)
  }
  if (!result || result.status !== 0) {
    refuseUsage(`cannot list files under ${entry.path}`, NOT_A_GIT_REPO)
  }
  return String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .map((file) => normaliseRepoPath(file))
}

function expandFiles({ checkout, entries, repoRoot }) {
  const files = []
  for (const entry of entries) {
    if (entry.kind === 'file') {
      files.push({
        file: repoRelative(repoRoot, absoluteWhere(checkout, entry.path)),
        absolute: absoluteWhere(checkout, entry.path),
      })
      continue
    }
    for (const file of listDirectoryFiles(checkout, repoRoot, entry)) {
      files.push({ file, absolute: join(repoRoot, ...file.split('/')) })
    }
  }
  const byFile = new Map()
  for (const file of files) byFile.set(normaliseRepoPath(file.file), file)
  return [...byFile.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
}

function addQuotedKeys(source, keys) {
  for (const match of source.matchAll(QUOTED_LITERAL)) {
    const literal = match[2]
    if (ERROR_CODE.test(literal) || WRITTEN_PATH.test(literal)) {
      keys.add(literal)
      if (WRITTEN_PATH.test(literal)) {
        const base = literal.split('/').filter(Boolean).pop()
        if (base) keys.add(base)
      }
    }
  }
}

export function extractKeys(source, filePath = '') {
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    filePath = source.file || source.path || ''
    source = source.source || ''
  }
  if (filePath && typeof filePath === 'object') filePath = filePath.file || filePath.path || ''
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  const keys = new Set()
  if (nonEmptyString(filePath)) keys.add(normaliseRepoPath(filePath))
  const isCode = !nonEmptyString(filePath)
    || CODE_EXTENSIONS.includes(extname(String(filePath)).toLowerCase())
  if (isCode) {
    for (const match of source.matchAll(EXPORTED_DECLARATION)) keys.add(match[1])
    for (const match of source.matchAll(EXPORTED_LIST)) {
      for (const part of match[1].split(',')) {
        const item = part.trim()
        if (!item) continue
        const alias = item.match(/\bas\s+([A-Za-z_$][\w$]*)/) || item.match(/^([A-Za-z_$][\w$]*)/)
        if (alias) keys.add(alias[1])
      }
    }
    addQuotedKeys(source, keys)
  }
  return [...keys].filter((key) => key.length >= 4).sort()
}

function grepHits(checkout, key) {
  let result
  try {
    result = spawnSync('git', ['-C', checkout, 'grep', '-l', '-F', '-e', key, '--', '.'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
  } catch {
    return []
  }
  if (!result || (result.status !== 0 && result.status !== 1)) return []
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => normaliseRepoPath(line.trim()))
    .filter(Boolean)
}

function isTripwireFile(file) {
  return TEST_FILE.test(file) || file.startsWith('test/')
}

export function discoverTripwires({ checkout, files }) {
  const repoRoot = gitRoot(checkout)
  if (!Array.isArray(files)) refuseUsage('files must be an array', WRONG_TYPE)
  const entries = files.map((entry) => {
    if (typeof entry === 'string') return verifyWhere({ checkout, where: [entry] })[0]
    if (!entry || typeof entry !== 'object' || !['file', 'directory'].includes(entry.kind) || typeof entry.path !== 'string') {
      refuseUsage('files must contain verified path entries', WRONG_TYPE)
    }
    return entry
  })
  const sourceFiles = expandFiles({ checkout: repoRoot, entries, repoRoot })
  const keyOwners = new Map()
  const allKeys = new Set()
  for (const sourceFile of sourceFiles) {
    let source
    try {
      source = readFileSync(sourceFile.absolute, 'utf8')
    } catch {
      refuseUsage(`where path cannot be read: ${sourceFile.file}`, MISSING_PATH)
    }
    const keys = extractKeys(source, sourceFile.file)
    for (const key of keys) {
      allKeys.add(key)
      if (!keyOwners.has(key)) keyOwners.set(key, new Set())
      keyOwners.get(key).add(sourceFile.file)
    }
  }

  const tripwireMap = new Map()
  const broadKeys = []
  for (const key of [...allKeys].sort()) {
    const hits = grepHits(checkout, key)
    if (hits.length > BROAD_KEY_LIMIT) {
      broadKeys.push({ key, count: hits.length })
      continue
    }
    for (const hit of hits) {
      if (!isTripwireFile(hit)) continue
      if (keyOwners.get(key)?.has(hit)) continue
      if (!tripwireMap.has(hit)) tripwireMap.set(hit, new Set())
      tripwireMap.get(hit).add(key)
    }
  }

  const tripwires = [...tripwireMap.entries()]
    .map(([file, keys]) => ({ file, keys: [...keys].sort() }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const candidateSet = new Set(sourceFiles.map(({ file }) => file))
  for (const tripwire of tripwires) candidateSet.add(tripwire.file)
  const result = {
    candidates: [...candidateSet].sort(),
    tripwires,
    broadKeys: broadKeys.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  }
  // Keep the complete key register available to the pure renderer without
  // changing the documented enumerable return fields.
  Object.defineProperty(result, 'keys', { value: [...allKeys].sort(), enumerable: false })
  return result
}

function colourNeutralEnv(base = process.env) {
  // Copied from crew/realio.mjs:344 rather than imported: crew/ is a separate
  // lane, and this compiler must keep the #240 child-environment rule local.
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  // A compiler invoked by node --test inherits this worker marker; leaving it
  // in place makes the target's own node --test invocation recurse and emit
  // no summary. It is runner control state, not a lane credential.
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  env.NO_COLOR = '1'
  return env
}

function unknownBaseline(lane, reason) {
  return { lane: lane || null, pass: null, fail: null, status: 'unknown', reason }
}

export function gatherBaseline({ checkout }) {
  const root = resolve(checkout || process.cwd())
  let packageData
  try {
    packageData = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return unknownBaseline(null, 'bad-package-json')
  }
  const lane = packageData && packageData.scripts && packageData.scripts.test
  if (typeof lane !== 'string' || !lane.trim()) return unknownBaseline(null, 'no-test-script')

  let result
  try {
    result = spawnSync('/bin/sh', ['-c', lane], {
      cwd: root,
      encoding: 'utf8',
      env: colourNeutralEnv(),
      timeout: BASELINE_TIMEOUT_MS,
    })
  } catch {
    return unknownBaseline(lane, 'spawn-error')
  }
  if (!result || result.error) {
    const timeout = result && (result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT')
    return unknownBaseline(lane, timeout ? 'timeout' : 'spawn-error')
  }
  if (result.signal) return unknownBaseline(lane, 'timeout')

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI_CSI, '')
  const passMatch = output.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)\s*$/m)
  const failMatch = output.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)\s*$/m)
  if (!passMatch || !failMatch) return unknownBaseline(lane, 'missing-summary')
  const pass = Number(passMatch[1])
  const fail = Number(failMatch[1])
  if (fail > 0) return { lane, pass, fail, status: 'red', reason: null }
  if (result.status !== 0) return { lane, pass, fail, status: 'unknown', reason: 'nonzero-exit' }
  return { lane, pass, fail, status: 'green', reason: null }
}

export function gatherFences({ fencesPath } = {}) {
  if (fencesPath == null) return null
  let data
  try {
    data = JSON.parse(readFileSync(resolve(fencesPath), 'utf8'))
  } catch {
    refuseUsage(`cannot read or parse fences file: ${fencesPath}`, BAD_FENCES)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((key) => key !== 'lanes')) {
    refuseUsage('fences must contain only a lanes array', BAD_FENCES)
  }
  if (!Array.isArray(data.lanes)) refuseUsage('fences.lanes must be an array', BAD_FENCES)
  const lanes = data.lanes.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refuseUsage(`fences.lanes[${index}] must be an object`, BAD_FENCES)
    }
    if (!nonEmptyString(entry.lane) || !Array.isArray(entry.files)) {
      refuseUsage(`fences.lanes[${index}] must contain lane and files`, BAD_FENCES)
    }
    if (entry.files.some((file) => typeof file !== 'string' || !file.trim())) {
      refuseUsage(`fences.lanes[${index}].files must contain non-blank strings`, BAD_FENCES)
    }
    const unknown = Object.keys(entry).filter((key) => key !== 'lane' && key !== 'files')
    if (unknown.length > 0) refuseUsage(`fences.lanes[${index}] has unknown keys`, BAD_FENCES)
    return { lane: entry.lane, files: [...new Set(entry.files)].sort() }
  })
  return lanes.sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)
}

export function resolveWriteSurface({ fences, lane, where = [] } = {}) {
  if (lane == null) {
    const files = [...new Set(where.map((entry) => normaliseRepoPath(entry.path)))].sort()
    return { lane: null, basis: 'where', files }
  }
  if (!nonEmptyString(lane)) refuseUsage('--lane requires a value', MISSING_LINE)
  if (fences == null) {
    refuseUsage(`no fence register supplied for lane: ${lane}`, UNKNOWN_LANE)
  }
  const entry = fences.find((candidate) => candidate.lane === lane)
  if (!entry) refuseUsage(`lane is not in the fence register: ${lane}`, UNKNOWN_LANE)
  const files = [...new Set(entry.files.map((file) => normaliseRepoPath(file)))].sort()
  return { lane, basis: 'fences', files }
}

function normaliseProtectedPaths(protectedPaths) {
  if (!Array.isArray(protectedPaths)) {
    refuseUsage('protectedPaths must be an array', BAD_PROTECTED)
  }
  const paths = protectedPaths.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      refuseUsage(`protectedPaths[${index}] must be a non-blank string`, BAD_PROTECTED)
    }
    return normaliseRepoPath(entry)
  })
  return [...new Set(paths)].sort()
}

export function gatherProtectedPaths({ protectedPathsFile } = {}) {
  if (protectedPathsFile == null) return DEFAULT_PROTECTED_PATHS
  let data
  try {
    data = JSON.parse(readFileSync(resolve(protectedPathsFile), 'utf8'))
  } catch {
    refuseUsage(`cannot read or parse protected paths file: ${protectedPathsFile}`, BAD_PROTECTED)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((key) => key !== 'paths')) {
    refuseUsage('protected paths must contain only a paths array', BAD_PROTECTED)
  }
  if (!Array.isArray(data.paths)) refuseUsage('protected paths must contain a paths array', BAD_PROTECTED)
  return normaliseProtectedPaths(data.paths)
}

function proposalTierAfterRaise(tier) {
  const index = TIER_NAMES.indexOf(tier)
  return index === -1 || index === TIER_NAMES.length - 1 ? tier : TIER_NAMES[index + 1]
}

function proposalBand(sourceCount) {
  if (sourceCount <= MECHANICAL_MAX_SOURCES) return { band: '1', tier: 'mechanical' }
  if (sourceCount <= BUILD_MAX_SOURCES) return { band: '2-4', tier: 'build' }
  return { band: '≥5', tier: 'judge' }
}

export function proposeTier({ where, discovery, protectedPaths = DEFAULT_PROTECTED_PATHS } = {}) {
  const protectedEntries = normaliseProtectedPaths(protectedPaths)
  const verifiedWhere = Array.isArray(where)
    ? where.filter((entry) => entry && typeof entry === 'object'
      && typeof entry.path === 'string'
      && ['file', 'directory'].includes(entry.kind))
    : []
  if (verifiedWhere.length === 0) {
    return {
      tier: null,
      reasons: ['no verified where entries — nothing to measure'],
      signals: {
        sourceCount: 0,
        tripwireCount: 0,
        directoryWhere: [],
        protectedHits: [],
        suppressedKeys: [],
      },
    }
  }

  const sourceDiscovery = discovery && typeof discovery === 'object' ? discovery : {}
  const candidates = Array.isArray(sourceDiscovery.candidates)
    ? [...new Set(sourceDiscovery.candidates
      .filter((candidate) => typeof candidate === 'string')
      .map((candidate) => normaliseRepoPath(candidate)))]
      .sort()
    : []
  if (candidates.length === 0) {
    return {
      tier: null,
      reasons: ['discovery produced no scope candidates'],
      signals: {
        sourceCount: 0,
        tripwireCount: 0,
        directoryWhere: [...new Set(verifiedWhere
          .filter((entry) => entry.kind === 'directory')
          .map((entry) => entry.path))].sort(),
        protectedHits: [],
        suppressedKeys: [],
      },
    }
  }

  const tripwires = Array.isArray(sourceDiscovery.tripwires) ? sourceDiscovery.tripwires : []
  const broadKeys = Array.isArray(sourceDiscovery.broadKeys) ? sourceDiscovery.broadKeys : []
  const tripwireFiles = new Set(tripwires
    .filter((tripwire) => tripwire && typeof tripwire.file === 'string')
    .map((tripwire) => normaliseRepoPath(tripwire.file)))
  const sourceCount = candidates.filter((candidate) => !tripwireFiles.has(candidate)).length
  const directoryWhere = [...new Set(verifiedWhere
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.path))].sort()
  const suppressedKeys = [...new Set(broadKeys
    .map((entry) => typeof entry === 'string' ? entry : entry && entry.key)
    .filter((key) => typeof key === 'string'))].sort()
  const signals = {
    sourceCount,
    tripwireCount: tripwires.length,
    directoryWhere,
    protectedHits: [],
    suppressedKeys,
  }

  if (tripwires.length === 0 && broadKeys.length > 0) {
    return {
      tier: null,
      reasons: [`breadth is unmeasured: 0 tripwire tests found while ${broadKeys.length} key(s) exceeded the broad-key limit — absent, not zero`],
      signals,
    }
  }

  const { band, tier: baseTier } = proposalBand(sourceCount)
  let tier = baseTier
  const reasons = [
    `scope breadth: ${sourceCount} source file${sourceCount === 1 ? '' : 's'} named by where (${band} → ${baseTier})`,
    `tripwire tests pinning that scope: ${tripwires.length}`,
  ]

  if (baseTier === 'mechanical' && directoryWhere.length > 0) {
    tier = 'build'
    reasons.push(`directory where: ${directoryWhere.join(', ')} — raised mechanical → build`)
  }
  if (baseTier === 'mechanical' && tripwires.length >= BROAD_TRIPWIRE_FLOOR) {
    tier = 'build'
    reasons.push(`broad pinning: ${tripwires.length} tripwire tests — raised mechanical → build`)
  }

  signals.protectedHits = candidates.filter((candidate) => protectedEntries.some((protectedPath) => (
    protectedPath.endsWith('/')
      ? candidate.startsWith(protectedPath)
      : candidate === protectedPath
  )))
  if (signals.protectedHits.length === 0) {
    reasons.push(`protected-path hits: none${protectedEntries.length === 0
      ? ' (injected list is empty)'
      : ` (injected list has ${protectedEntries.length} path${protectedEntries.length === 1 ? '' : 's'})`}`)
  } else {
    const before = tier
    const raised = proposalTierAfterRaise(before)
    if (raised === before) {
      reasons.push(`protected path hit: ${signals.protectedHits.join(', ')} — tier ${before} unchanged (already highest)`)
    } else {
      tier = raised
      reasons.push(`protected path hit: ${signals.protectedHits.join(', ')} — raised ${before} → ${raised}`)
    }
  }

  return { tier, reasons, signals }
}

function formatBaseline(baseline) {
  const lane = baseline.lane || '(no test lane)'
  if (baseline.status === 'unknown') return `lane: ${lane} · unknown · reason: ${baseline.reason}`
  return `lane: ${lane} · pass ${baseline.pass} · fail ${baseline.fail} · status: ${baseline.status}`
}

function keyList(discovery) {
  const keys = new Set(discovery.keys || [])
  for (const tripwire of discovery.tripwires || []) {
    for (const key of tripwire.keys || []) keys.add(key)
  }
  for (const broad of discovery.broadKeys || []) {
    keys.add(typeof broad === 'string' ? broad : broad.key)
  }
  return [...keys].filter(Boolean).sort()
}

function generatedGrep(discovery) {
  const keys = keyList(discovery)
  return `grep -rn "${keys.join('\\|')}" crew/ test/ scripts/ docs/`
}

function renderWhere(where) {
  return where.map((entry) => `verified · ${entry.kind} · ${entry.path}`).join('\n')
}

function renderTripwires(discovery) {
  const lines = []
  lines.push(`candidates: ${discovery.candidates.length ? discovery.candidates.join(', ') : '(none)'}`)
  lines.push('tripwire tests:')
  if (discovery.tripwires.length === 0) lines.push('- (none discovered)')
  for (const tripwire of discovery.tripwires) {
    lines.push(`- ${tripwire.file} · ${tripwire.keys.join(', ')}`)
  }
  lines.push('broad keys (not used as tripwires):')
  if (discovery.broadKeys.length === 0) lines.push('- (none)')
  for (const broad of discovery.broadKeys) {
    const key = typeof broad === 'string' ? broad : broad.key
    const count = typeof broad === 'string' ? '?' : broad.count
    lines.push(`- ${key} · ${count} hits`)
  }
  lines.push(`declare every hit: ${generatedGrep(discovery)}`)
  return lines.join('\n')
}

export function renderProposedTier(proposal) {
  const tier = proposal && TIER_NAMES.includes(proposal.tier) ? proposal.tier : null
  const reasons = proposal && Array.isArray(proposal.reasons)
    ? proposal.reasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : []
  return [
    'PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms',
    'or overrides this at boot; the compiler never decides the tier.',
    `proposed tier: ${tier || 'no proposal'}`,
    'because:',
    ...(reasons.length ? reasons.map((reason) => `- ${reason}`) : ['- no mechanical signals were available']),
  ].join('\n')
}

function renderFences(fences) {
  if (fences == null) return 'no fence register supplied (`--fences` not given)'
  const lines = []
  for (const lane of fences) {
    for (const file of lane.files) lines.push(`${lane.lane} owns ${file}`)
  }
  return lines.length ? lines.join('\n') : '(fence register is empty)'
}

function renderWriteSurface(writeSurface, discovery) {
  const files = Array.isArray(writeSurface?.files) ? writeSurface.files : []
  const listedFiles = files.length ? files.join(', ') : '(none)'
  const basis = writeSurface?.basis === 'fences'
    ? `fence register, lane "${writeSurface.lane}"`
    : 'authored where paths, no lane fence applied'
  const writable = new Set(files)
  const discovered = Array.isArray(discovery?.candidates)
    ? [...new Set(discovery.candidates.map((file) => normaliseRepoPath(file)))].sort()
    : []
  const tripwireFiles = discovered.filter((file) => !writable.has(file))
  return [
    `files_in_scope (expected write surface; basis: ${basis}): ${listedFiles}`,
    `read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): ${tripwireFiles.length ? tripwireFiles.join(', ') : '(none)'}`,
  ].join('\n')
}

function renderValidation(baseline, discovery) {
  const tests = discovery.tripwires.map((tripwire) => tripwire.file).sort()
  const narrow = tests.length ? `node --test ${tests.join(' ')}` : 'no tripwire tests discovered'
  const full = baseline.lane || 'no full test lane'
  const count = baseline.status === 'unknown'
    ? `unknown (${baseline.reason})`
    : `pass ${baseline.pass}, fail ${baseline.fail}`
  return `narrow: ${narrow}\nfull: ${full} · measured baseline ${count}`
}

export function renderBrief(gathered) {
  const request = gathered.request || gathered
  const where = gathered.where || []
  const discovery = gathered.discovery || gathered.tripwires || { candidates: [], tripwires: [], broadKeys: [] }
  const baseline = gathered.baseline || { lane: null, pass: null, fail: null, status: 'unknown', reason: 'not-gathered' }
  const fences = Object.prototype.hasOwnProperty.call(gathered, 'fences') ? gathered.fences : null
  const writeSurface = Object.prototype.hasOwnProperty.call(gathered, 'writeSurface')
    ? gathered.writeSurface
    : resolveWriteSurface({ fences, lane: gathered.lane ?? null, where })
  const proposal = gathered.proposal ?? proposeTier({ where, discovery })
  const lines = [
    `# Task: ${request.ask}`,
    '## The ask',
    request.ask,
    '## Proposed tier',
    renderProposedTier(proposal),
    '## Where',
    renderWhere(where),
    '## Done means',
    request.done_means,
    '## Tripwires',
    renderTripwires(discovery),
    '## Baseline',
    formatBaseline(baseline),
    '## Out of scope',
    request.out_of_scope,
    '## Fences',
    renderFences(fences),
    '## What the crew decides',
    SLOT_MARKER,
    '## Acceptance',
    `${request.done_means} · Full suite green. · ${SLOT_MARKER}`,
    '## Acceptance gate',
    standingBlocks().acceptance,
    '## Validation lane',
    renderValidation(baseline, discovery),
    '## Conventions',
    renderWriteSurface(writeSurface, discovery),
    generatedGrep(discovery),
    standingBlocks().conventions,
    '',
  ]
  return lines.join('\n')
}

function parseCliArgs(argv) {
  const flags = {}
  const positional = []
  const valueFlags = new Set(['request', 'checkout', 'out', 'fences', 'protected', 'lane'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (name === 'force') {
      if (Object.prototype.hasOwnProperty.call(flags, name)) refuseUsage('duplicate --force', MISSING_LINE)
      flags[name] = true
      continue
    }
    if (!valueFlags.has(name)) refuseUsage(`unknown option: --${name}`, MISSING_LINE)
    if (Object.prototype.hasOwnProperty.call(flags, name)) refuseUsage(`duplicate --${name}`, MISSING_LINE)
    const value = argv[index + 1]
    if (value == null || value.startsWith('--')) refuseUsage(`--${name} requires a value`, MISSING_LINE)
    flags[name] = value
    index += 1
  }
  if (positional.length > 0) refuseUsage(`unexpected argument: ${positional[0]}`, MISSING_LINE)
  return flags
}

function readRequestFile(requestPath) {
  let data
  try {
    data = JSON.parse(readFileSync(resolve(requestPath), 'utf8'))
  } catch {
    refuseUsage(`cannot read or parse request file: ${requestPath}`, MISSING_LINE)
  }
  return data
}

function outputPathOrNull(value) {
  if (value == null || value === '-') return null
  return resolve(value)
}

function writeBrief(content, outPath, force) {
  if (outPath == null) {
    process.stdout.write(content)
    return
  }
  const parent = dirname(outPath)
  if (!existsSync(parent)) refuseUsage(`output directory does not exist: ${parent}`, OUT_DIR_MISSING)
  let parentStat
  try { parentStat = statSync(parent) } catch { refuseUsage(`output directory does not exist: ${parent}`, OUT_DIR_MISSING) }
  if (!parentStat.isDirectory()) refuseUsage(`output directory does not exist: ${parent}`, OUT_DIR_MISSING)
  if (existsSync(outPath)) {
    let outputStat
    try { outputStat = statSync(outPath) } catch { outputStat = null }
    if (outputStat && outputStat.isDirectory()) {
      refuseUsage(`output path is a directory, not a file: ${outPath}`, OUT_EXISTS)
    }
    if (!force) refuseUsage(`output already exists: ${outPath}`, OUT_EXISTS)
  }
  writeFileSync(outPath, content)
}

function compile(flags) {
  if (typeof flags.request !== 'string' || !flags.request) refuseUsage('--request <file> is required', MISSING_LINE)
  const outPath = outputPathOrNull(flags.out)
  const taskName = parseTaskStem(outPath || flags.request)
  const request = readRequestFile(flags.request)
  validateRequest(request, { taskName })
  const checkout = gitRoot(flags.checkout || process.cwd())
  const where = verifyWhere({ checkout, where: request.where })
  const discovery = discoverTripwires({ checkout, files: where })
  const fences = gatherFences({ fencesPath: flags.fences })
  const writeSurface = resolveWriteSurface({ fences, lane: flags.lane ?? null, where })
  const baseline = gatherBaseline({ checkout })
  const protectedPaths = gatherProtectedPaths({ protectedPathsFile: flags.protected })
  const proposal = proposeTier({ where, discovery, protectedPaths })
  const content = renderBrief({ request, where, discovery, baseline, fences, lane: flags.lane ?? null, writeSurface, proposal })
  writeBrief(content, outPath, flags.force === true)
  return 0
}

export function main(argv) {
  try {
    const flags = parseCliArgs(argv)
    return compile(flags)
  } catch (err) {
    if (err instanceof BriefUsageError) {
      process.stderr.write(`${err.message} [reason: ${err.reason}]\n`)
      return 2
    }
    process.stderr.write(`${err && err.stack}\n`)
    return 1
  }
}

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
