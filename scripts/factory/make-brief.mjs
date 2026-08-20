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
// parsed. Repo-specific test_command and conventions now come from a ratified
// repo profile. A recorded baseline is never consumed: it describes a commit,
// while the profile records no commit sha, so every compile measures the
// checkout. --require-profile is the explicit autonomous-caller posture;
// hand-driven callers state and use the package.json fallback when profile
// facts are absent.
//
// A tier is proposed, never decided: #45 item 4's ratified rule lives here
// because these mechanical signals exist before boot. Protected paths are the
// authored floor plus additions from the profile, --protected JSON, or a
// library parameter; blueprint proposal is deliberately absent pending #251.
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
import {
  ProbeUsageError, ProfileRefusal, defaultProfilePath, profileProtectedPaths, readProfile, repoKeyFor, requireField,
} from './probe-repo.mjs'
import { resolveProtectedPaths } from '../../crew/protected-paths.mjs'

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
const BASELINE_TIMEOUT_MS = 300_000

export const TIER_NAMES = Object.freeze(['mechanical', 'build', 'judge'])
export const DEFAULT_PROTECTED_PATHS = resolveProtectedPaths()
export const LADDER_PATH = new URL('../../crew/model-ladder.json', import.meta.url)

// The four ratified strength bands (crew/model-ladder.json, ratified 2026-08-14).
// A strength proposal is only ever a member of this list; an unreadable ladder
// proposes nothing rather than inventing a name.
export function readLadderBands(ladderPath = LADDER_PATH) {
  try {
    const data = JSON.parse(readFileSync(ladderPath, 'utf8'))
    return Object.freeze(data.bands
      .map((band) => band && band.band)
      .filter((name) => typeof name === 'string' && name.length > 0))
  } catch {
    return Object.freeze([])
  }
}

export const LADDER_BANDS = readLadderBands()

// #291: risk pins the seats that GOVERN (shape) …
const JUDGE_PROTECTED_FLOOR = 2
// … and complexity prices the seats that PRODUCE (strength).
const STRENGTH_BY_COMPLEXITY = Object.freeze({
  mechanical: 'utility', build: 'workhorse', judge: 'frontier',
})
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
const COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'
const STALE_READ_ACK = 'stale-read-ack'
const PROFILE_UNREADABLE = 'profile-unreadable'
const PROFILE_UNRATIFIED = 'profile-unratified'

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
  COUPLED_SOURCE_UNFENCED,
  STALE_READ_ACK,
  PROFILE_UNREADABLE,
  PROFILE_UNRATIFIED,
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

// The per-check mutation contract quoted from its single enforcement point,
// `validateMutations` in crew/drive.mjs. Two lanes lost a plan round each to a
// format documented nowhere a planner reads (#330, #345); a standing block is the
// only delivery that does not depend on an orchestrator remembering.
export const MUTATION_CONTRACT_BLOCK = Object.freeze(`A per-check mutation declaration is MACHINE-APPLIED: the driver find-and-replaces
on a scratch copy of the built tree, re-runs the gate, and requires that one check
to redden. A prose field (\`"kills": "leaving the loop unconditional"\`) cannot be
applied and is refused — \`validateMutations\` in \`crew/drive.mjs\` is the single
enforcement point. Each entry in \`details.mutations\` is EITHER a mutation OR an
exemption, never both, and at most 32 entries in all (\`MUTATIONS_MAX\`).

A mutation entry carries exactly:

    { "check": "C1", "file": "lib/widget.mjs", "find": "<literal text present in the file>", "replace": "<literal replacement>" }

- \`check\` — a stable token matching \`/^[A-Za-z0-9][A-Za-z0-9._-]*$/\` (letters,
  digits, dot, underscore, hyphen; starting with a letter or digit), unique across
  all entries. The gate MUST print \`FAIL <check>\` on that check's failing line
  (\`CHECK_FAIL_PREFIX\`), matched as an exact token — the label you declare and the
  label the gate prints are one string.
- \`file\` — required, repo-relative, a file and not a directory, and inside
  \`files_in_scope\`.
- \`find\` — required, non-empty LITERAL text that actually occurs in that file; not
  a regex, not a description.
- \`replace\` — required string, and must DIFFER from \`find\`; an identical pair
  mutates nothing.

An exemption entry carries exactly \`{ "check": "<token>", "exempt": "<non-empty reason>" }\`
and no \`file\`, \`find\` or \`replace\`.

The human sentence saying what a mutation kills belongs in a comment beside the
check in the gate file and in \`plan.md\`, never in the entry. Worked example — the
gate carries, above the check that prints \`FAIL C1\`:

    // MUTATION C1: neutralise the standing block in renderBrief's lines array and
    // no compiled brief carries the contract any more.

and the declaration is \`{ "check": "C1", "file": "scripts/factory/make-brief.mjs", "find": "standingBlocks().mutations", "replace": "standingBlocks().nothing" }\`.
Rationale: #330.`)

function standingBlocks() {
  return { acceptance: ACCEPTANCE_GATE_BLOCK, mutations: MUTATION_CONTRACT_BLOCK, conventions: CONVENTIONS_BLOCK }
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

function normaliseSourceInput(source, filePath = '') {
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    filePath = source.file || source.path || ''
    source = source.source || ''
  }
  if (filePath && typeof filePath === 'object') filePath = filePath.file || filePath.path || ''
  return { source, filePath }
}

function exportedSymbols(source) {
  const symbols = new Set()
  for (const match of source.matchAll(EXPORTED_DECLARATION)) symbols.add(match[1])
  for (const match of source.matchAll(EXPORTED_LIST)) {
    for (const part of match[1].split(',')) {
      const item = part.trim()
      if (!item) continue
      const alias = item.match(/\bas\s+([A-Za-z_$][\w$]*)/) || item.match(/^([A-Za-z_$][\w$]*)/)
      if (alias) symbols.add(alias[1])
    }
  }
  return symbols
}

function isCodeFile(filePath) {
  return !nonEmptyString(filePath)
    || CODE_EXTENSIONS.includes(extname(String(filePath)).toLowerCase())
}

export function extractSymbols(source, filePath = '') {
  ({ source, filePath } = normaliseSourceInput(source, filePath))
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  if (!isCodeFile(filePath)) return []
  return [...exportedSymbols(source)].filter((key) => key.length >= 4).sort()
}

export function extractKeys(source, filePath = '') {
  ({ source, filePath } = normaliseSourceInput(source, filePath))
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  const keys = new Set()
  if (nonEmptyString(filePath)) keys.add(normaliseRepoPath(filePath))
  if (isCodeFile(filePath)) {
    for (const symbol of exportedSymbols(source)) keys.add(symbol)
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
  const symbolOwners = new Map()
  const ownerFiles = new Set()
  const allKeys = new Set()
  for (const sourceFile of sourceFiles) {
    let source
    try {
      source = readFileSync(sourceFile.absolute, 'utf8')
    } catch {
      refuseUsage(`where path cannot be read: ${sourceFile.file}`, MISSING_PATH)
    }
    const keys = extractKeys(source, sourceFile.file)
    const symbols = extractSymbols(source, sourceFile.file)
    ownerFiles.add(sourceFile.file)
    for (const key of keys) {
      allKeys.add(key)
      if (!keyOwners.has(key)) keyOwners.set(key, new Set())
      keyOwners.get(key).add(sourceFile.file)
    }
    for (const symbol of symbols) {
      if (!symbolOwners.has(symbol)) symbolOwners.set(symbol, new Set())
      symbolOwners.get(symbol).add(sourceFile.file)
    }
  }

  // The owner-path mention is intentionally unbounded: it only narrows the
  // exported-symbol coupling set, never the existing broad-key tripwire set.
  const mentionsByOwner = new Map()
  for (const owner of [...ownerFiles].sort()) {
    const mentions = new Set([
      ...grepHits(checkout, owner),
      ...grepHits(checkout, basename(owner)),
    ])
    mentions.delete(owner)
    mentionsByOwner.set(owner, mentions)
  }

  const tripwireMap = new Map()
  const coupledMap = new Map()
  const broadKeys = []
  for (const key of [...allKeys].sort()) {
    const hits = grepHits(checkout, key)
    if (hits.length > BROAD_KEY_LIMIT) {
      broadKeys.push({ key, count: hits.length })
      continue
    }
    for (const hit of hits) {
      if (isTripwireFile(hit)) {
        if (keyOwners.get(key)?.has(hit)) continue
        if (!tripwireMap.has(hit)) tripwireMap.set(hit, new Set())
        tripwireMap.get(hit).add(key)
        continue
      }
      if (!CODE_EXTENSIONS.includes(extname(hit).toLowerCase())) continue
      if (ownerFiles.has(hit)) continue
      const owners = symbolOwners.get(key)
      if (!owners) continue
      const namedOwner = [...owners].find((owner) => mentionsByOwner.get(owner)?.has(hit))
      if (!namedOwner) continue
      if (!coupledMap.has(hit)) coupledMap.set(hit, new Set())
      coupledMap.get(hit).add(key)
    }
  }

  const tripwires = [...tripwireMap.entries()]
    .map(([file, keys]) => ({ file, keys: [...keys].sort() }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const coupled = [...coupledMap.entries()]
    .map(([file, keys]) => ({ file, keys: [...keys].sort() }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const candidateSet = new Set(sourceFiles.map(({ file }) => file))
  for (const tripwire of tripwires) candidateSet.add(tripwire.file)
  // candidates feeds proposeTier, where sourceCount = candidates −
  // tripwireFiles drives the ratified tier bands; adding coupled sources would
  // silently raise tiers, and this lane may not change that ratified rule.
  // Coupling therefore gets its own rendered section.
  const result = {
    candidates: [...candidateSet].sort(),
    tripwires,
    broadKeys: broadKeys.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    coupled,
  }
  // Keep the complete key register available to the pure renderer without
  // changing the documented enumerable return fields.
  Object.defineProperty(result, 'keys', { value: [...allKeys].sort(), enumerable: false })
  return result
}

function colourNeutralEnv(base = process.env) {
  // Copied from crew/seat-io.mjs:1304 rather than imported: crew/ is a separate
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

export function gatherProfile({ checkout, profilePath, factoryRoot, requireProfile = false } = {}) {
  let path = null
  let located = 'none'
  if (profilePath != null) {
    path = resolve(profilePath)
    located = 'flag'
  } else {
    try {
      path = resolve(defaultProfilePath({ repoKey: repoKeyFor({ checkout }), factoryRoot }))
      located = 'default-path'
    } catch (err) {
      if (!(err instanceof ProbeUsageError)) throw err
      if (requireProfile) {
        refuseUsage(`cannot resolve the default profile path for checkout ${resolve(checkout || process.cwd())}`, PROFILE_UNREADABLE)
      }
      return { path: null, profile: null, reason: PROFILE_UNREADABLE, located: 'none' }
    }
  }

  try {
    const profile = readProfile(path)
    if (profile == null) {
      if (requireProfile) refuseUsage(`profile is unreadable at ${path}`, PROFILE_UNREADABLE)
      return { path, profile: null, reason: PROFILE_UNREADABLE, located }
    }
    return { path, profile, reason: null, located }
  } catch (err) {
    if (!(err instanceof ProbeUsageError)) throw err
    if (requireProfile) refuseUsage(`profile is unreadable at ${path}`, PROFILE_UNREADABLE)
    return { path, profile: null, reason: PROFILE_UNREADABLE, located }
  }
}

export function profileField(profileResult, name) {
  const result = profileResult || {}
  const path = result.path || null
  const profile = result.profile || null
  if (!profile) {
    const reason = result.reason || PROFILE_UNREADABLE
    const basis = path
      ? `no profile at ${path} (${reason})`
      : 'no profile path could be resolved'
    return { used: false, value: null, basis, reason }
  }
  try {
    const value = requireField(profile, name)
    return {
      used: true,
      value,
      basis: `ratified profile field ${name} · ${path}`,
      reason: null,
    }
  } catch (err) {
    if (!(err instanceof ProfileRefusal)) throw err
    const status = profile?.fields?.[name]?.status ?? 'absent'
    if (err.reason === 'profile-ratification-refused') {
      return {
        used: false,
        value: null,
        recorded: profile?.fields?.[name]?.value,
        basis: `profile field ${name} is ratified but commit-scoped, so a direct read refuses it · ${path}`,
        reason: err.reason,
      }
    }
    if (err.reason === 'profile-ratification-invalid') {
      return {
        used: false,
        value: null,
        basis: `profile field ${name} is ratified but invalid · ${path}`,
        reason: err.reason,
      }
    }
    return {
      used: false,
      value: null,
      basis: `profile field ${name} is ${status}, not ratified · ${path}`,
      reason: err.reason,
    }
  }
}

function unknownBaseline(lane, reason, laneBasis = 'package.json scripts.test') {
  return {
    lane: lane || null,
    pass: null,
    fail: null,
    status: 'unknown',
    reason,
    laneBasis,
  }
}

export function gatherBaseline({ checkout, lane = null, laneBasis = null } = {}) {
  const root = resolve(checkout || process.cwd())
  const basis = nonEmptyString(laneBasis) ? laneBasis : 'package.json scripts.test'
  let selectedLane = nonEmptyString(lane) ? lane : null
  if (!selectedLane) {
    let packageData
    try {
      packageData = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    } catch {
      return unknownBaseline(null, 'bad-package-json', basis)
    }
    selectedLane = packageData && packageData.scripts && packageData.scripts.test
    if (typeof selectedLane !== 'string' || !selectedLane.trim()) {
      return unknownBaseline(null, 'no-test-script', basis)
    }
  }

  let result
  try {
    result = spawnSync('/bin/sh', ['-c', selectedLane], {
      cwd: root,
      encoding: 'utf8',
      env: colourNeutralEnv(),
      timeout: BASELINE_TIMEOUT_MS,
    })
  } catch {
    return unknownBaseline(selectedLane, 'spawn-error', basis)
  }
  if (!result || result.error) {
    const timeout = result && (result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT')
    return unknownBaseline(selectedLane, timeout ? 'timeout' : 'spawn-error', basis)
  }
  if (result.signal) return unknownBaseline(selectedLane, 'timeout', basis)

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI_CSI, '')
  const passMatch = output.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)\s*$/m)
  const failMatch = output.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)\s*$/m)
  if (!passMatch || !failMatch) return unknownBaseline(selectedLane, 'missing-summary', basis)
  const pass = Number(passMatch[1])
  const fail = Number(failMatch[1])
  if (fail > 0) return { lane: selectedLane, pass, fail, status: 'red', reason: null, laneBasis: basis }
  if (result.status !== 0) return { lane: selectedLane, pass, fail, status: 'unknown', reason: 'nonzero-exit', laneBasis: basis }
  return { lane: selectedLane, pass, fail, status: 'green', reason: null, laneBasis: basis }
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
    const unknown = Object.keys(entry).filter((key) => !['lane', 'files', 'reads'].includes(key))
    if (unknown.length > 0) refuseUsage(`fences.lanes[${index}] has unknown keys`, BAD_FENCES)
    let reads = []
    if (Object.prototype.hasOwnProperty.call(entry, 'reads')) {
      if (!Array.isArray(entry.reads)) refuseUsage(`fences.lanes[${index}].reads must be an array`, BAD_FENCES)
      const seen = new Set()
      reads = entry.reads.map((read, readIndex) => {
        if (!read || typeof read !== 'object' || Array.isArray(read)) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}] must be an object`, BAD_FENCES)
        }
        const readUnknown = Object.keys(read).filter((key) => key !== 'file' && key !== 'why')
        if (readUnknown.length > 0) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}] has unknown keys`, BAD_FENCES)
        }
        if (!nonEmptyString(read.file)) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}].file must be a non-blank string`, BAD_FENCES)
        }
        if (!nonEmptyString(read.why)) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}].why must be a non-blank string`, BAD_FENCES)
        }
        const file = normaliseRepoPath(read.file)
        if (seen.has(file)) {
          refuseUsage(`fences.lanes[${index}].reads contains duplicate file: ${file}`, BAD_FENCES)
        }
        seen.add(file)
        return { file, why: read.why }
      }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    }
    return { lane: entry.lane, files: [...new Set(entry.files)].sort(), reads }
  })
  return lanes.sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)
}

export function resolveWriteSurface({ fences, lane, where = [] } = {}) {
  if (lane == null) {
    const files = [...new Set(where.map((entry) => normaliseRepoPath(entry.path)))].sort()
    return { lane: null, basis: 'where', files, reads: [] }
  }
  if (!nonEmptyString(lane)) refuseUsage('--lane requires a value', MISSING_LINE)
  if (fences == null) {
    refuseUsage(`no fence register supplied for lane: ${lane}`, UNKNOWN_LANE)
  }
  const entry = fences.find((candidate) => candidate.lane === lane)
  if (!entry) refuseUsage(`lane is not in the fence register: ${lane}`, UNKNOWN_LANE)
  const files = [...new Set(entry.files.map((file) => normaliseRepoPath(file)))].sort()
  return { lane, basis: 'fences', files, reads: entry.reads || [] }
}

// The OTHER lanes' write surfaces, for a RUNTIME that must refuse to write what
// another live lane owns. Resolving this lane's own surface first is load-bearing:
// resolveWriteSurface refuses a missing register and an unknown lane name, so a typo
// can never resolve to "every lane is somebody else's" and fence off the whole tree.
// Returns [] when the register names only this lane. Additive: nothing above changes.
export function laneFenceFor({ fences, lane } = {}) {
  if (lane == null) refuseUsage('lane fence requires a lane name', MISSING_LINE)
  if (!Array.isArray(fences)) refuseUsage(`no fence register supplied for lane: ${lane}`, UNKNOWN_LANE)
  resolveWriteSurface({ fences, lane })
  return fences
    .filter((entry) => entry.lane !== lane)
    .map((entry) => ({
      lane: entry.lane,
      files: [...new Set(entry.files.map((file) => normaliseRepoPath(file)))].sort(),
    }))
    .sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0))
}

function normaliseCoupledEntries(discovery) {
  if (!Array.isArray(discovery?.coupled)) return null
  const entries = new Map()
  for (const entry of discovery.coupled) {
    if (!entry || typeof entry !== 'object' || !nonEmptyString(entry.file)) continue
    const file = normaliseRepoPath(entry.file)
    const keys = Array.isArray(entry.keys)
      ? [...new Set(entry.keys.filter((key) => typeof key === 'string' && key.length > 0))].sort()
      : []
    if (!entries.has(file)) entries.set(file, { file, keys })
    else entries.get(file).keys = [...new Set([...entries.get(file).keys, ...keys])].sort()
  }
  return [...entries.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
}

export function crossCheckCoupling({ discovery, writeSurface, enforce = true } = {}) {
  const coupled = normaliseCoupledEntries(discovery)
  const records = coupled == null
    ? null
    : coupled.map((entry) => ({ ...entry, status: 'no-fence' }))
  if (writeSurface?.basis !== 'fences') {
    // compileIntakeBrief supplies `fences: null, lane: null`: its write
    // surface is authored `where`, so no fence exists for coupling to
    // contradict. Rendering is informative; refusing would break #52's
    // shipped intake loop.
    return {
      enforced: false,
      coupled: records,
      in_fence: [],
      acknowledged: [],
      unfenced: [],
      stale: [],
    }
  }

  const fenceFiles = new Set(Array.isArray(writeSurface.files)
    ? writeSurface.files.map((file) => normaliseRepoPath(file))
    : [])
  const reads = Array.isArray(writeSurface.reads) ? writeSurface.reads : []
  const readsByFile = new Map()
  for (const read of reads) {
    if (!read || typeof read !== 'object' || !nonEmptyString(read.file)) continue
    readsByFile.set(normaliseRepoPath(read.file), read)
  }
  const inFence = []
  const acknowledged = []
  const unfenced = []
  for (const entry of records || []) {
    const record = { ...entry }
    if (fenceFiles.has(entry.file)) {
      record.status = 'in-fence'
      inFence.push(record)
    } else if (readsByFile.has(entry.file)) {
      record.status = 'acknowledged'
      record.why = readsByFile.get(entry.file).why
      acknowledged.push(record)
    } else {
      record.status = 'unfenced'
      unfenced.push(record)
    }
  }
  const coupledOutsideFence = new Set([...acknowledged, ...unfenced].map(({ file }) => file))
  const stale = reads
    .filter((read) => read && typeof read === 'object' && nonEmptyString(read.file))
    .map((read) => ({ file: normaliseRepoPath(read.file), why: read.why }))
    .filter((read) => !coupledOutsideFence.has(read.file))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)

  const result = {
    enforced: enforce !== false,
    coupled: records == null ? null : [
      ...inFence,
      ...acknowledged,
      ...unfenced,
    ].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    in_fence: inFence.map(({ file }) => file),
    acknowledged: acknowledged.map(({ file, why }) => ({ file, why })),
    unfenced: unfenced.map(({ file }) => file),
    stale,
  }
  if (enforce !== false && stale.length > 0) {
    refuseUsage(`stale read acknowledgement(s): ${stale.map((read) => read.file).join(', ')}`, STALE_READ_ACK)
  }
  if (enforce !== false && unfenced.length > 0) {
    const details = unfenced
      .map((entry) => `${entry.file} · ${entry.keys.join(', ')}`)
      .join('; ')
    refuseUsage(`coupled source(s) outside lane fence: ${details}`, COUPLED_SOURCE_UNFENCED)
  }
  return result
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

export function gatherProtectedPaths({ protectedPathsFile, extra = [] } = {}) {
  let fileEntries = []
  if (protectedPathsFile != null) {
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
    fileEntries = normaliseProtectedPaths(data.paths)
  }
  return resolveProtectedPaths([...fileEntries, ...extra])
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

function proposeShape(protectedHits) {
  if (protectedHits.length === 0) {
    return { shape: 'mechanical', reasons: ['risk signal · protected-path hits: none — shape mechanical'] }
  }
  if (protectedHits.length < JUDGE_PROTECTED_FLOOR) {
    return { shape: 'build', reasons: [`risk signal · protected path hit: ${protectedHits.join(', ')} — shape build`] }
  }
  return {
    shape: 'judge',
    reasons: [`risk signal · ${protectedHits.length} protected path hits: ${protectedHits.join(', ')} — shape judge`],
  }
}

function proposeStrength(complexityTier, signals, ladderBands) {
  const band = STRENGTH_BY_COMPLEXITY[complexityTier] ?? null
  const reasons = [
    `complexity signal · scope breadth: ${signals.sourceCount} source file(s) named by where`,
    `complexity signal · tripwire tests pinning that scope: ${signals.tripwireCount}`,
    `complexity signal · directory where: ${signals.directoryWhere.length ? signals.directoryWhere.join(', ') : 'none'}`,
  ]
  if (band == null || !ladderBands.includes(band)) {
    return { strength: null, reasons: [...reasons, `no ratified ladder band for complexity ${complexityTier} — proposing none`] }
  }
  return { strength: band, reasons: [...reasons, `complexity ${complexityTier} → ratified ladder band ${band}`] }
}

// The three absence cases propose NEITHER and say why, rather than defaulting.
function absentProposal(reasons, signals) {
  return {
    tier: null, shape: null, strength: null,
    reasons, shapeReasons: [...reasons], strengthReasons: [...reasons], signals,
  }
}

export function proposeTier({ where, discovery, protectedPaths = DEFAULT_PROTECTED_PATHS, protectedBasis = null, ladderBands = LADDER_BANDS } = {}) {
  const normalised = normaliseProtectedPaths(protectedPaths)
  const protectedEntries = resolveProtectedPaths(normalised)
  const basisReason = `protected paths in force: ${protectedEntries.length}${protectedBasis ? ` · ${protectedBasis}` : ' · authored floor (no profile basis supplied)'}`
  const verifiedWhere = Array.isArray(where)
    ? where.filter((entry) => entry && typeof entry === 'object'
      && typeof entry.path === 'string'
      && ['file', 'directory'].includes(entry.kind))
    : []
  if (verifiedWhere.length === 0) {
    return absentProposal(
      [basisReason, 'no verified where entries — nothing to measure'],
      {
        sourceCount: 0,
        tripwireCount: 0,
        directoryWhere: [],
        protectedHits: [],
        suppressedKeys: [],
      },
    )
  }

  const sourceDiscovery = discovery && typeof discovery === 'object' ? discovery : {}
  const candidates = Array.isArray(sourceDiscovery.candidates)
    ? [...new Set(sourceDiscovery.candidates
      .filter((candidate) => typeof candidate === 'string')
      .map((candidate) => normaliseRepoPath(candidate)))]
      .sort()
    : []
  if (candidates.length === 0) {
    return absentProposal(
      [basisReason, 'discovery produced no scope candidates'],
      {
        sourceCount: 0,
        tripwireCount: 0,
        directoryWhere: [...new Set(verifiedWhere
          .filter((entry) => entry.kind === 'directory')
          .map((entry) => entry.path))].sort(),
        protectedHits: [],
        suppressedKeys: [],
      },
    )
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
    return absentProposal(
      [basisReason, `breadth is unmeasured: 0 tripwire tests found while ${broadKeys.length} key(s) exceeded the broad-key limit — absent, not zero`],
      signals,
    )
  }

  const { band, tier: baseTier } = proposalBand(sourceCount)
  let tier = baseTier
  const reasons = [
    basisReason,
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

  const complexityTier = tier   // raises so far are complexity-only
  signals.protectedHits = candidates.filter((candidate) => protectedEntries.some((protectedPath) => (
    protectedPath.endsWith('/')
      ? candidate.startsWith(protectedPath)
      : candidate === protectedPath
  )))
  if (signals.protectedHits.length === 0) {
    reasons.push('protected-path hits: none')
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

  const { shape, reasons: shapeReasons } = proposeShape(signals.protectedHits)
  const { strength, reasons: strengthReasons } = proposeStrength(complexityTier, signals, ladderBands)
  return { tier, shape, strength, reasons, shapeReasons, strengthReasons, signals }
}

function formatCountBasis(profileBaseline) {
  const basis = 'count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed'
  if (profileBaseline?.recorded !== undefined) {
    const value = profileBaseline.recorded
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (typeof value.passed === 'number' || typeof value.passed === 'string')) {
      return `${basis} (profile records passed ${value.passed} in a ratified cell, refused at the read boundary as commit-scoped and not used)`
    }
    return `${basis} (profile records a ratified baseline, refused at the read boundary as commit-scoped and not used)`
  }
  if (!profileBaseline?.used) return basis
  const value = profileBaseline.value
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (typeof value.passed === 'number' || typeof value.passed === 'string')) {
    return `${basis} (profile records passed ${value.passed}, not used)`
  }
  return `${basis} (profile records a ratified baseline, not used)`
}

function formatBaseline(baseline, profile = null) {
  const lane = baseline.lane || '(no test lane)'
  const line = baseline.status === 'unknown'
    ? `lane: ${lane} · unknown · reason: ${baseline.reason}`
    : `lane: ${lane} · pass ${baseline.pass} · fail ${baseline.fail} · status: ${baseline.status}`
  const laneBasis = baseline.laneBasis
    || profile?.testCommand?.basis
    || 'package.json scripts.test — no profile consulted'
  return `${line}\nlane basis: ${laneBasis}\n${formatCountBasis(profile?.baseline)}`
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

// The coupling bound is a floor, not a proof: grep cannot see dynamic,
// string-built, or renamed couplings.
function renderCoupled(coupling) {
  const lines = [
    'coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible).',
  ]
  if (!coupling || coupling.coupled == null) {
    lines.push('- (not discovered — this caller supplied no coupling discovery)')
    return lines.join('\n')
  }
  if (coupling.coupled.length === 0) {
    lines.push('- (none discovered)')
    return lines.join('\n')
  }
  const acknowledgements = new Map((coupling.acknowledged || [])
    .filter((entry) => entry && typeof entry.file === 'string')
    .map((entry) => [normaliseRepoPath(entry.file), entry.why]))
  for (const entry of coupling.coupled) {
    const keys = Array.isArray(entry.keys) && entry.keys.length ? entry.keys.join(', ') : '(none)'
    let status = 'no fence in play'
    if (entry.status === 'in-fence') status = 'inside this lane\'s fence'
    if (entry.status === 'acknowledged') {
      status = `acknowledged read-only: ${acknowledgements.get(normaliseRepoPath(entry.file)) ?? entry.why ?? ''}`
    }
    if (entry.status === 'unfenced') status = 'not in any fence (refused)'
    lines.push(`- ${entry.file} · ${keys} · ${status}`)
  }
  return lines.join('\n')
}

export function renderProposedTier(proposal) {
  const tier = proposal && TIER_NAMES.includes(proposal.tier) ? proposal.tier : null
  const reasons = proposal && Array.isArray(proposal.reasons)
    ? proposal.reasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : []
  const shape = proposal && TIER_NAMES.includes(proposal.shape) ? proposal.shape : null
  const strength = proposal && LADDER_BANDS.includes(proposal.strength) ? proposal.strength : null
  const shapeReasons = proposal && Array.isArray(proposal.shapeReasons)
    ? proposal.shapeReasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : []
  const strengthReasons = proposal && Array.isArray(proposal.strengthReasons)
    ? proposal.strengthReasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : []
  return [
    'PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms',
    'or overrides this at boot; the compiler never decides the tier.',
    `proposed tier: ${tier || 'no proposal'}`,
    'because:',
    ...(reasons.length ? reasons.map((reason) => `- ${reason}`) : ['- no mechanical signals were available']),
    `proposed shape: ${shape || 'no proposal'}`,
    'because (risk signals):',
    ...(shapeReasons.length ? shapeReasons.map((reason) => `- ${reason}`) : ['- no risk signals were available']),
    `proposed strength: ${strength || 'no proposal'}`,
    'because (complexity signals):',
    ...(strengthReasons.length ? strengthReasons.map((reason) => `- ${reason}`) : ['- no complexity signals were available']),
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

function renderConventions(profileConventions) {
  if (!profileConventions) {
    return 'conventions of record: (not available) — basis: no profile consulted'
  }
  if (!profileConventions.used) {
    return `conventions of record: (not available) — basis: ${profileConventions.basis}`
  }
  const files = profileConventions.value?.files
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
    return `conventions of record: (not available) — basis: ${profileConventions.basis} (value.files must be an array of strings)`
  }
  return `conventions of record (basis: ${profileConventions.basis}): ${files.length ? files.join(', ') : '(none)'}`
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
  const profile = gathered.profile || null
  const fences = Object.prototype.hasOwnProperty.call(gathered, 'fences') ? gathered.fences : null
  const writeSurface = Object.prototype.hasOwnProperty.call(gathered, 'writeSurface')
    ? gathered.writeSurface
    : resolveWriteSurface({ fences, lane: gathered.lane ?? null, where })
  const coupling = gathered.coupling ?? crossCheckCoupling({ discovery, writeSurface, enforce: false })
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
    '## Coupled sources',
    renderCoupled(coupling),
    '## Baseline',
    formatBaseline(baseline, profile),
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
    '## Per-check mutations',
    standingBlocks().mutations,
    '## Validation lane',
    renderValidation(baseline, discovery),
    '## Conventions',
    renderWriteSurface(writeSurface, discovery),
    renderConventions(profile?.conventions),
    generatedGrep(discovery),
    standingBlocks().conventions,
    '',
  ]
  return lines.join('\n')
}

function parseCliArgs(argv) {
  const flags = {}
  const positional = []
  const valueFlags = new Set(['request', 'checkout', 'out', 'fences', 'protected', 'lane', 'profile'])
  const booleanFlags = new Set(['force', 'require-profile'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      if (Object.prototype.hasOwnProperty.call(flags, name)) refuseUsage(`duplicate --${name}`, MISSING_LINE)
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
  const profileResult = gatherProfile({
    checkout,
    profilePath: flags.profile,
    requireProfile: flags['require-profile'] === true,
  })
  const testCommand = profileField(profileResult, 'test_command')
  if (flags['require-profile'] === true && !testCommand.used) {
    refuseUsage(`test_command is not ratified: ${testCommand.basis}`, PROFILE_UNRATIFIED)
  }
  const conventions = profileField(profileResult, 'conventions')
  // A baseline is a fact about a commit; profile metadata has no commit sha,
  // so this value is evidence only and is never used to replace measurement.
  const recordedBaseline = profileField(profileResult, 'baseline')
  // default_branch and ci have no consumer in this module (ci belongs to the
  // sibling profile-ci-shape lane), so they deliberately stay out of wiring.
  const lane = testCommand.used && nonEmptyString(testCommand.value)
    ? testCommand.value
    : null
  const laneBasis = testCommand.used && lane == null
    ? `package.json scripts.test — ${testCommand.basis} (value is not a non-blank string)`
    : testCommand.used
      ? testCommand.basis
      : `package.json scripts.test — ${testCommand.basis}`
  const fences = gatherFences({ fencesPath: flags.fences })
  const writeSurface = resolveWriteSurface({ fences, lane: flags.lane ?? null, where })
  const coupling = crossCheckCoupling({ discovery, writeSurface })
  const baseline = gatherBaseline({ checkout, lane, laneBasis })
  let fromProfile
  try {
    fromProfile = profileProtectedPaths(profileResult.profile, { path: profileResult.path })
  } catch (err) {
    if (!(err instanceof ProfileRefusal)) throw err
    refuseUsage(err.message, BAD_PROTECTED)
  }
  const protectedPaths = gatherProtectedPaths({ protectedPathsFile: flags.protected, extra: fromProfile.paths })
  const proposal = proposeTier({ where, discovery, protectedPaths, protectedBasis: fromProfile.basis })
  const content = renderBrief({
    request,
    where,
    discovery,
    coupling,
    baseline,
    fences,
    lane: flags.lane ?? null,
    writeSurface,
    proposal,
    profile: { testCommand, conventions, baseline: recordedBaseline },
  })
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
