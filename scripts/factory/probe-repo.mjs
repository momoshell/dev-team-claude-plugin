#!/usr/bin/env node
// scripts/factory/probe-repo.mjs — propose a deterministic, read-only profile
// of a checkout for a human to ratify before a factory consumer uses it.
//
// NEVER WRITES INTO THE TARGET: probing is read-only; only an explicit writer
// may create a profile, and that writer refuses a path inside the checkout.
// The no-write boundary follows make-brief.mjs:19-21 and issue #252.
//
// THE PROBE PROPOSES, IT NEVER RATIFIES: every fresh field is proposed or
// unknown. Ratification is a human act, not an inference from a heuristic.
// The refusal is deliberately load-bearing, like crew/breaker.mjs:216-221.
//
// UNKNOWN IS NEVER A GUESS AND NEVER A ZERO: an unknown cell carries null and
// one closed reason. This keeps an unmeasured lane from looking like a green
// count, and keeps #252's profile honest when evidence is absent.
//
// OFFLINE AND DETERMINISTIC BY DEFAULT: filesystem and allowlisted read-only
// git inspection are local; gh is consulted only when --gh is explicit. The
// profile body excludes timestamps, durations, and absolute paths.
//
// LIBRARY vs CLI: importing performs no I/O. main(argv) returns an exit code
// and never calls process.exit; the direct-invocation guard sets exitCode.
// Exit codes are 0 for a profile, 1 for an unexpected throw, and 2 for usage
// or refusal, matching the other scripts/factory modules.
//
// The protected-path read boundary is consumed by the crew run entry points and
// brief compiler through the shared rule below; probing itself remains read-only.

import {
  createHash,
} from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { slug } from '../../crew/slug.mjs'
import { resolveProtectedPaths } from '../../crew/protected-paths.mjs'

export const PROFILE_VERSION = 1
export const LOAD_BEARING = Object.freeze(['test_command', 'default_branch'])
export const STATUSES = Object.freeze(['ratified', 'proposed', 'unknown'])
export const BASE_BRANCH_REFUSALS = Object.freeze(['profile-unreadable', 'profile-field-unknown', 'profile-unratified', 'profile-ratification-invalid', 'profile-ratification-refused', 'base-branch-invalid'])
// gh failure reasons describe what the evidence actually showed:
// - gh_unavailable: gh never ran or never answered (for example, ENOENT,
//   EACCES, or timeout). Human action: install gh or fix PATH.
// - gh_unauthenticated: gh ran and said we are not logged in. Human action:
//   run `gh auth login`.
// - gh_scope_missing: gh ran and rejected a token scope we do not hold.
//   Human action: run `gh auth refresh -s <scope>`.
// - gh_request_rejected: gh ran and rejected our request for any other reason,
//   or answered with output we could not parse. Human action: fix our request.
export const UNKNOWN_REASONS = Object.freeze([
  'no_test_command',
  'multiple_candidates',
  'not_measured',
  'suite_failed',
  'suite_unparsed',
  'no_ci',
  'no_remote_head',
  'not_a_git_repo',
  'gh_not_consulted',
  'gh_unavailable',
  'gh_request_rejected',
  'gh_unauthenticated',
  'gh_scope_missing',
  'none_found',
])
export const IDIOM_CLASSES = Object.freeze(['dependency_injection', 'boolean_helpers', 'logging_placement', 'error_retry_shape', 'comment_density'])
export const IDIOM_UNMEASURED_REASONS = Object.freeze(['no_sources', 'no_sample', 'insufficient_sample', 'no_majority', 'no_exemplar', 'ls_files_failed', 'ls_files_oversized', 'source_read_failed', 'source_path_invalid'])
const IDIOM_SAMPLE_MIN = 2
const IDIOM_DENSITY_MIN_FILES = 1
const IDIOM_LIST_MAX_BYTES = 1024 * 1024
const IDIOM_SUPPORTED_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts', '.svelte'])

// This is an exported register rather than a hidden blacklist: a future
// consumer can show exactly which heuristic produced a protected-path
// candidate. The shared floor and union rule live in crew/protected-paths.mjs.
export const PROTECTED_PATH_PATTERNS = Object.freeze([
  '.github/workflows/',
  '**/migrations/',
  '**/migrate/',
  'terraform/',
  'infra/',
  'deploy/',
  'Dockerfile',
  'docker-compose*',
  '**/auth/',
  '/auth|session|token|credential|secret/i',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'flake.lock',
  'uv.lock',
  'mix.lock',
  'pubspec.lock',
  'Package.resolved',
])

// Field kinds name the merge rule as well as the evidence boundary:
// - stable is a fact about the repo (today's rule), so byte-identical probe
//   values retain a human ratification and changed values are superseded.
// - commit_scoped is a fact about one commit; profile metadata carries no
//   commit sha, so a recorded value cannot prove it still applies. Ratification
//   is refused outright at BOTH read boundaries (requireField and the semantic
//   consumer) and never carried forward; the human value is kept under
//   refused_ratification for review.
// - authored_superset is a human-authored list a heuristic can only partly
//   discover. The ratified list is authoritative, fewer probe entries are not
//   drift, and probe-only additions are surfaced under probe_additions.
// Kinds are declared, never inferred. A field absent from this table is stable:
// the default is today's behaviour, so a new field cannot quietly get a looser
// merge rule. Kinds are properties of fields, not probe-run profile data.
export const FIELD_KIND_NAMES = Object.freeze(['stable', 'commit_scoped', 'authored_superset'])
export const FIELD_KINDS = Object.freeze({
  toolchain: 'stable',
  test_command: 'stable',
  baseline: 'commit_scoped',
  ci: 'stable',
  protected_paths_candidates: 'authored_superset',
  conventions: 'stable',
  default_branch: 'stable',
  pr_conventions: 'stable',
  // intake_board is stable: the board a repository is worked from is a fact
  // about the REPOSITORY, not about one commit (nothing here is measured from
  // a working tree, so commit_scoped would refuse a value that still applies),
  // and not a human-authored superset a heuristic under-discovers (the probe
  // enumerates the linked projects exhaustively — there is no hidden remainder
  // for a human to add). Stable is therefore the honest kind: a byte-identical
  // re-probe keeps the human ratification, a changed board supersedes it and
  // drops back to proposed.
  // LOAD_BEARING is intentionally unchanged: repositories that never use
  // intake must not become unrunnable merely because no board is ratified.
  intake_board: 'stable',
})

export const INTAKE_BOARD_FIELD = 'intake_board'
export const INTAKE_COLUMN_ROLES = Object.freeze({
  ready: Object.freeze(['ready']),
  work: Object.freeze(['in progress', 'in-progress', 'inprogress', 'doing', 'wip']),
  review: Object.freeze(['in review', 'in-review', 'review', 'reviewing']),
})
export function fieldKind(name) {
  return Object.hasOwn(FIELD_KINDS, name) ? FIELD_KINDS[name] : 'stable'
}
export function isRatifiable(name) {
  return fieldKind(name) !== 'commit_scoped'
}

export class ProfileRefusal extends Error {
  constructor(message, reason = 'profile-unratified') {
    super(message)
    this.name = 'ProfileRefusal'
    this.reason = reason
  }
}

export class ProbeUsageError extends Error {
  constructor(message, reason = 'usage') {
    super(message)
    this.name = 'ProbeUsageError'
    this.reason = reason
  }
}

function refuseUsage(message, reason = 'usage') {
  throw new ProbeUsageError(`probe-repo: ${message}`, reason)
}

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normaliseRepoPath(value) {
  const out = String(value).replaceAll('\\', '/')
  if (out === './') return '.'
  return out.startsWith('./') ? out.slice(2) : out
}

function repoRelative(root, path) {
  return normaliseRepoPath(relative(root, path))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

function iso(value) {
  return new Date(value instanceof Date ? value.getTime() : value).toISOString()
}

function cell(status, value, source, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error(`probe-repo: invalid cell status ${status}`)
  if ((value === null) !== (status === 'unknown')) {
    throw new Error('probe-repo: cell null/status invariant violated')
  }
  const out = { status, value }
  if (status === 'unknown') {
    if (!UNKNOWN_REASONS.includes(extra.reason)) {
      throw new Error('probe-repo: unknown cell reason is not closed')
    }
    out.reason = extra.reason
    if (extra.candidates !== undefined) out.candidates = clone(extra.candidates)
    return out
  }
  if (!nonEmptyString(source)) throw new Error('probe-repo: non-unknown cell source is required')
  out.source = source
  if (extra.candidates !== undefined) out.candidates = clone(extra.candidates)
  if (extra.detail !== undefined) out.detail = extra.detail
  if (status === 'ratified') {
    if (!nonEmptyString(extra.ratified_by) || !nonEmptyString(extra.ratified_at)) {
      throw new Error('probe-repo: ratified cell human metadata is required')
    }
    out.ratified_by = extra.ratified_by
    out.ratified_at = extra.ratified_at
  }
  return out
}

function unknownCell(reason, candidates) {
  return cell('unknown', null, undefined, { reason, candidates })
}

function proposedCell(value, source, extra = {}) {
  return cell('proposed', value, source, extra)
}

function runProcess(command, args, { cwd, timeout = 10_000, env, maxBuffer = 1024 * 1024, rawResult = false } = {}) {
  let result
  try {
    result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      env,
      maxBuffer,
    })
  } catch (error) {
    if (rawResult) return { status: null, error }
    return null
  }
  if (rawResult) return result
  if (!result || result.error || result.status !== 0) return null
  return String(result.stdout || '').trim()
}

function checkoutDirectory(checkout) {
  if (!nonEmptyString(checkout)) refuseUsage('--checkout <dir> is required', 'missing-checkout')
  const requested = resolve(checkout)
  let stats
  try {
    stats = statSync(requested)
  } catch {
    refuseUsage(`checkout is not a directory: ${requested}`, 'checkout-not-directory')
  }
  if (!stats.isDirectory()) refuseUsage(`checkout is not a directory: ${requested}`, 'checkout-not-directory')
  return realpathOr(requested)
}

// Git access is read-only by construction. This is the complete allowlist:
// `git rev-parse --show-toplevel`, `git symbolic-ref`, `git remote get-url
// origin`, `git config --get`, `git log --format=%s -n 50`, and
// `git ls-files -z`. In particular, no `git status` or index-refreshing
// command is used: the probe must not write .git/index or alter the target
// in any other way.
function gitOutput(root, args, options = {}) {
  return runProcess('git', ['-C', root, ...args], { ...options, cwd: root })
}

function gitRoot(root, git = gitOutput) {
  const output = git(root, ['rev-parse', '--show-toplevel'])
  return nonEmptyString(output) ? realpathOr(resolve(output)) : null
}

function remoteRepoKey(root, isGit, git = gitOutput) {
  if (!isGit) return `local__${slug(basename(root))}`
  const remote = git(root, ['remote', 'get-url', 'origin'])
  if (!nonEmptyString(remote)) return `local__${slug(basename(root))}`
  let value = remote.trim().replace(/\.git$/, '')
  if (/^[^/\s]+@[^:\s]+:/.test(value)) value = value.slice(value.indexOf(':') + 1)
  else value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  value = value.replace(/^[^/\s]+@/, '')
  const parts = value.split('/').filter(Boolean)
  if (parts.length < 2) return `local__${slug(basename(root))}`
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1].replace(/\.git$/, '')
  try {
    return `${slug(owner)}__${slug(repo)}`
  } catch {
    return `local__${slug(basename(root))}`
  }
}

function packageData(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function gatherToolchain(root) {
  const markers = [
    ['node', 'package.json'],
    ['rust', 'Cargo.toml'],
    ['go', 'go.mod'],
    ['python', 'pyproject.toml'],
    ['python', 'setup.py'],
    ['python', 'requirements.txt'],
  ]
  const found = markers.filter(([, marker]) => existsSync(join(root, marker)))
  const tools = [...new Set(found.map(([tool]) => tool))].sort()
  if (tools.length === 0) return unknownCell('none_found')
  if (tools.length > 1) return unknownCell('multiple_candidates', tools)
  return proposedCell(tools[0], found.map(([, marker]) => marker).sort().join(', '))
}

function workflowFiles(root) {
  const directory = join(root, '.github', 'workflows')
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && /\.(?:yml|yaml)$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort()
}

function normaliseCommand(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function scalar(value) {
  let out = String(value || '').trim()
  if (out.endsWith(',')) out = out.slice(0, -1).trim()
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1)
  }
  return out
}

function withoutInlineComment(value) {
  return String(value || '').replace(/\s+#.*$/, '').trim()
}

function looksLikeTestInvocation(command) {
  const value = normaliseCommand(withoutInlineComment(command))
  if (!value) return false
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\b|$)/i.test(value)
    || /(?:^|[;&|]\s*)node\s+(?:--test|[^;&|]*\s--test)(?:\b|$)/i.test(value)
    || /\bcargo\s+test(?:\b|$)/i.test(value)
    || /\bgo\s+test(?:\b|$)/i.test(value)
    || /\bpytest(?:\b|$)/i.test(value)
    || /\bpython(?:3)?\s+-m\s+pytest(?:\b|$)/i.test(value)
    || /\b(?:make|just)\s+(?:test|check)(?:\b|$)/i.test(value)
    || /\b(?:mvn|gradle|dotnet|mix)\s+test(?:\b|$)/i.test(value)
    || /\bbundle\s+exec\s+(?:rspec|rake\s+test)(?:\b|$)/i.test(value)
}

function parseRunLines(file, root) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const commands = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?run\s*:\s*(.*)$/)
    if (!match) continue
    const raw = scalar(match[1])
    const command = normaliseCommand(withoutInlineComment(raw))
    if (looksLikeTestInvocation(command)) {
      commands.push({ command, source: repoRelative(root, file), detail: raw })
    }
  }
  return commands
}

function addCandidate(map, candidate) {
  if (!map.has(candidate.command)) {
    map.set(candidate.command, {
      command: candidate.command,
      sources: new Set(),
      details: new Set(),
      detailsBySource: new Map(),
    })
  }
  const current = map.get(candidate.command)
  current.sources.add(candidate.source)
  if (nonEmptyString(candidate.detail)) {
    current.details.add(candidate.detail)
    current.detailsBySource.set(candidate.source, candidate.detail)
  }
}

function candidateList(map) {
  return [...map.values()]
    .sort((a, b) => a.command < b.command ? -1 : a.command > b.command ? 1 : 0)
    .map((candidate) => {
      const sources = [...candidate.sources].sort()
      const details = [...candidate.details].sort()
      const detail = candidate.detailsBySource.get('package.json') || details[0] || null
      return {
        command: candidate.command,
        source: sources.join(', '),
        detail,
        sources,
        details,
      }
    })
}

function gatherTestCommand(root) {
  const candidates = new Map()
  const packageJson = packageData(root)
  const script = packageJson && packageJson.scripts && packageJson.scripts.test
  if (typeof script === 'string' && script.trim()) {
    addCandidate(candidates, {
      command: 'npm test', source: 'package.json', detail: script.trim(),
    })
  }
  for (const file of workflowFiles(root)) {
    for (const candidate of parseRunLines(file, root)) addCandidate(candidates, candidate)
  }
  const markers = [
    ['Cargo.toml', 'cargo test'],
    ['go.mod', 'go test ./...'],
    ['pyproject.toml', 'pytest'],
    ['setup.py', 'pytest'],
    ['requirements.txt', 'pytest'],
  ]
  for (const [marker, command] of markers) {
    if (existsSync(join(root, marker))) addCandidate(candidates, { command, source: marker })
  }
  const values = candidateList(candidates)
  if (values.length === 0) return unknownCell('no_test_command')
  if (values.length > 1) return unknownCell('multiple_candidates', values)
  const only = values[0]
  return proposedCell(only.command, only.sources.join(', '), {
    candidates: values,
    detail: only.detail,
  })
}

function colourNeutralEnv(base = process.env) {
  // Copied from make-brief.mjs:528 (itself copied from
  // crew/seat-io.mjs:1304), rather than imported: that module is a consumer of
  // this profile and importing it would reverse the subsystem direction.
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  env.NO_COLOR = '1'
  return env
}

function gatherBaseline(root, testCommand, enabled) {
  if (!enabled || testCommand.status !== 'proposed') {
    return { cell: unknownCell('not_measured'), command: null, duration: null }
  }
  const command = testCommand.value
  const started = Date.now()
  let result
  try {
    // The command is the already-proposed lane, run verbatim just as
    // make-brief.mjs:428-465 does. A shell is required for npm scripts and
    // is bounded so a stuck suite cannot turn observation into a hang.
    result = spawnSync('/bin/sh', ['-c', command], {
      cwd: root,
      timeout: 300_000,
      encoding: 'utf8',
      env: colourNeutralEnv(),
    })
  } catch {
    return { cell: unknownCell('suite_failed'), command, duration: Date.now() - started }
  }
  const duration = Math.max(0, Date.now() - started)
  if (!result || result.error || result.signal || result.status !== 0) {
    return { cell: unknownCell('suite_failed'), command, duration }
  }
  // Keep the parser byte-for-byte tolerant of the same ANSI residue that
  // make-brief.mjs strips after applying the colour-neutral environment.
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
  const passMatch = output.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)\s*$/m)
  const failMatch = output.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)\s*$/m)
  if (!passMatch || !failMatch) {
    return { cell: unknownCell('suite_unparsed'), command, duration }
  }
  const passed = Number(passMatch[1])
  const failed = Number(failMatch[1])
  return {
    cell: proposedCell({ tests: passed + failed, passed, failed }, 'baseline command'),
    command,
    duration,
  }
}

function indentation(line) {
  const match = line.match(/^[ \t]*/)
  return (match ? match[0] : '').replaceAll('\t', '  ').length
}

function parseList(value) {
  const text = scalar(value)
  if (!text.startsWith('[') || !text.endsWith(']')) return text ? [text] : []
  return text.slice(1, -1).split(',').map((entry) => scalar(entry)).filter(Boolean)
}

function parseWorkflow(file, root) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    text = ''
  }
  const relativeFile = repoRelative(root, file)
  const fallbackName = basename(file).replace(/\.(?:yml|yaml)$/i, '')
  let name = fallbackName
  const triggers = []
  const jobs = []
  let inOn = false
  let onIndent = -1
  let inJobs = false
  let jobsIndent = -1
  let currentJob = null
  let currentStep = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = indentation(line)
    if (indent === 0) {
      inOn = false
      inJobs = false
      currentJob = null
      currentStep = null
      const top = line.match(/^([^:#]+):\s*(.*)$/)
      if (!top) continue
      const key = top[1].trim()
      const value = top[2]
      if (key === 'name') {
        const parsed = scalar(value)
        if (parsed) name = parsed
      } else if (key === 'on') {
        const parsed = parseList(value)
        for (const trigger of parsed) if (!triggers.includes(trigger)) triggers.push(trigger)
        if (!value.trim()) {
          inOn = true
          onIndent = indent
        }
      } else if (key === 'jobs') {
        inJobs = true
        jobsIndent = indent
      }
      continue
    }
    if (inOn && indent > onIndent) {
      const trigger = line.match(/^\s*(?:-\s*)?([^:#\s]+):(?:\s*.*)?$/)
      if (trigger) {
        const value = scalar(trigger[1])
        if (!triggers.includes(value)) triggers.push(value)
      } else if (/^\s*-\s*(\S+)/.test(line)) {
        const value = scalar(line.replace(/^\s*-\s*/, ''))
        if (!triggers.includes(value)) triggers.push(value)
      }
      continue
    }
    if (!inJobs || indent <= jobsIndent) continue
    if (indent === jobsIndent + 2 && /^[^\s-][^:]*:\s*(?:#.*)?$/.test(trimmed)) {
      const id = trimmed.slice(0, trimmed.indexOf(':')).trim()
      currentJob = { id, name: null, runs_on: null, steps_run: [] }
      jobs.push(currentJob)
      currentStep = null
      continue
    }
    if (!currentJob) continue
    if (indent === jobsIndent + 4) {
      const field = trimmed.match(/^([^:#]+):\s*(.*)$/)
      if (!field) continue
      const key = field[1].trim()
      const value = scalar(field[2])
      if (key === 'name') currentJob.name = value
      if (key === 'runs-on') currentJob.runs_on = value
      if (key === 'steps') currentStep = null
      continue
    }
    if (indent >= jobsIndent + 6) {
      const runInList = trimmed.match(/^-\s*run:\s*(.*)$/)
      if (runInList) {
        const command = normaliseCommand(withoutInlineComment(scalar(runInList[1])))
        currentStep = { run: command }
        if (command) currentJob.steps_run.push(command)
        continue
      }
      const stepName = trimmed.match(/^-\s*name:\s*(.*)$/)
      if (stepName) {
        currentStep = { run: null }
        continue
      }
      const runField = trimmed.match(/^run:\s*(.*)$/)
      if (runField && currentStep) {
        const command = normaliseCommand(withoutInlineComment(scalar(runField[1])))
        currentStep.run = command
        if (command) currentJob.steps_run.push(command)
      }
    }
  }
  return {
    file: relativeFile,
    name,
    triggers,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      check_name: job.name || job.id,
      runs_on: job.runs_on,
      steps_run: job.steps_run,
    })),
  }
}

function gatherCi(root) {
  const files = workflowFiles(root)
  if (files.length === 0) return unknownCell('no_ci')
  const workflows = files.map((file) => parseWorkflow(file, root))
  return proposedCell({ workflows }, '.github/workflows')
}

function walkTree(root) {
  const entries = []
  const visit = (directory, prefix = '') => {
    let children
    try {
      children = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of children) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      const rel = normaliseRepoPath(join(prefix, entry.name))
      if (entry.isDirectory()) {
        entries.push({ path: rel, directory: true })
        visit(path, rel)
      } else if (entry.isFile()) {
        entries.push({ path: rel, directory: false })
      }
    }
  }
  visit(root)
  return entries
}

function isLockfile(path) {
  const base = basename(path)
  return [
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock',
    'go.sum', 'flake.lock', 'uv.lock', 'mix.lock', 'pubspec.lock', 'Package.resolved',
  ].includes(base)
}

function gatherProtectedPaths(root) {
  const found = new Set()
  const entries = walkTree(root)
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const workflows = byPath.get('.github') && byPath.get('.github/workflows')
  if (workflows && workflows.directory) found.add('.github/workflows/')
  for (const entry of entries) {
    const path = entry.path
    const base = basename(path)
    if (entry.directory && /^(?:migrations|migrate|auth)$/.test(base)) found.add(`${path}/`)
    if (entry.directory && path.split('/').length === 1 && /^(terraform|infra|deploy)$/.test(base)) found.add(`${path}/`)
    if (!entry.directory && (base === 'Dockerfile' || /^docker-compose/.test(base))) found.add(path)
    if (!entry.directory && /auth|session|token|credential|secret/i.test(path)) found.add(path)
    if (!entry.directory && isLockfile(path)) found.add(path)
  }
  return proposedCell([...found].sort(), 'heuristic')
}

// Idiom mining is deterministic, read-only, and honestly sampled: every miner
// shares one offset-preserving lexical masker, one crude function collector,
// one strict-majority decision, and one unmeasured shape. All five classes
// measure from the tracked partition; anything unmeasurable stays null with a
// closed reason instead of a guessed rule.
// lean: tracked listing capped at 1 MiB; raise IDIOM_LIST_MAX_BYTES if large checkouts report ls_files_oversized.
function listTrackedSources(root) {
  const result = gitOutput(root, ['ls-files', '-z'], { rawResult: true, maxBuffer: IDIOM_LIST_MAX_BYTES })
  if (!result || result.error || result.signal != null || result.status !== 0) {
    const code = result && result.error ? result.error.code : null
    const message = result && result.error && result.error.message ? String(result.error.message) : ''
    if (code === 'ENOBUFS' || message.includes('ENOBUFS')) return { ok: false, reason: 'ls_files_oversized' }
    return { ok: false, reason: 'ls_files_failed' }
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout === undefined ? '' : result.stdout)
  if (stdout.length > 0 && stdout.charAt(stdout.length - 1) !== '\0') return { ok: false, reason: 'ls_files_failed' }
  const seen = new Set()
  const files = []
  const entries = stdout.split('\0')
  for (let ei = 0; ei < entries.length; ei += 1) {
    const entry = entries[ei]
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    files.push(entry)
  }
  return { ok: true, files }
}

function scanIdiomSources(root) {
  const listed = listTrackedSources(root)
  if (!listed.ok) return listed
  const supported = []
  let skipped = 0
  const extensions = new Set()
  const realRoot = realpathOr(root)
  for (const name of listed.files) {
    const extension = IDIOM_SUPPORTED_EXTENSIONS.find((candidate) => name.endsWith(candidate))
    if (!extension) {
      skipped += 1
      continue
    }
    if (isAbsolute(name) || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      return { ok: false, reason: 'source_path_invalid' }
    }
    const absolute = resolve(root, name)
    const rel = relative(realRoot, resolve(realRoot, name))
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      return { ok: false, reason: 'source_path_invalid' }
    }
    let entry
    let target
    try {
      entry = lstatSync(absolute)
      target = realpathSync(absolute)
    } catch {
      return { ok: false, reason: 'source_read_failed' }
    }
    if (target !== realRoot && target.startsWith(realRoot + sep) === false) {
      return { ok: false, reason: 'source_path_invalid' }
    }
    if (entry.isSymbolicLink()) {
      let targetStat
      try {
        targetStat = statSync(absolute)
      } catch {
        return { ok: false, reason: 'source_read_failed' }
      }
      if (!targetStat.isFile()) return { ok: false, reason: 'source_read_failed' }
    } else if (!entry.isFile()) {
      return { ok: false, reason: 'source_read_failed' }
    }
    let text
    try {
      text = readFileSync(absolute, 'utf8')
    } catch {
      return { ok: false, reason: 'source_read_failed' }
    }
    supported.push({ name, text })
    extensions.add(extension)
  }
  const result = { ok: true, supported, skipped, extensions }
  result.corpus = idiomCorpus(result)
  return result
}

function textLineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === '\n') starts.push(index + 1)
  }
  return starts
}

function textLineOf(starts, index) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return low
}

function svelteScriptBody(text) {
  const keep = new Array(text.length).fill(false)
  const openPattern = /<script(\s[^>]*)?>/g
  let found = openPattern.exec(text)
  while (found !== null) {
    const bodyStart = found.index + found[0].length
    const close = text.indexOf('</script>', bodyStart)
    if (close < 0) break
    for (let index = bodyStart; index < close; index += 1) keep[index] = true
    openPattern.lastIndex = close + 9
    found = openPattern.exec(text)
  }
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (keep[index] || char === '\n' || char === '\r') out += char
    else out += ' '
  }
  return out
}

// lean: regex literals are not masked; use a JS parser if regex-heavy sources distort measured samples.
// lean: opaque template bodies including interpolation are blanked whole; use a JS parser if template-heavy sources distort measured samples.
function maskSource(text) {
  const chars = text.split('')
  const starts = textLineStarts(text)
  const comment = new Array(starts.length).fill(false)
  const blank = (index) => {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }
  const blankLiteral = (start, end) => {
    for (let index = start; index < end; index += 1) blank(index)
    chars[start] = '0'
  }
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    const next = text.charAt(index + 1)
    if (char === '/' && next === '/') {
      comment[textLineOf(starts, index)] = true
      blank(index)
      blank(index + 1)
      index += 2
      while (index < text.length && text.charAt(index) !== '\n') {
        blank(index)
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      const stop = end < 0 ? text.length : end + 2
      for (let cursor = index; cursor < stop; cursor += 1) {
        comment[textLineOf(starts, cursor)] = true
        blank(cursor)
      }
      index = stop
      continue
    }
    if (char === "'" || char === '"') {
      let cursor = index + 1
      let closed = false
      while (cursor < text.length) {
        const cur = text.charAt(cursor)
        if (cur === '\\') {
          cursor += 2
          continue
        }
        if (cur === '\n') break
        if (cur === char) {
          closed = true
          break
        }
        cursor += 1
      }
      const stop = closed ? cursor + 1 : cursor
      blankLiteral(index, stop)
      index = stop
      continue
    }
    if (char === '`') {
      let cursor = index + 1
      let closed = false
      while (cursor < text.length) {
        const cur = text.charAt(cursor)
        if (cur === '\\') {
          cursor += 2
          continue
        }
        if (cur === '`') {
          closed = true
          break
        }
        cursor += 1
      }
      const stop = closed ? cursor + 1 : cursor
      blankLiteral(index, stop)
      index = stop
      continue
    }
    index += 1
  }
  const masked = chars.join('')
  const code = masked.split('\n').map((line) => line.search(/[^ \t\r\f\v]/) !== -1)
  return { masked, comment, code }
}

const IDIOM_DECL_SOURCE = '(?:^|[;{}])\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)\\s*\\('
const IDIOM_ARROW_SOURCE = '(?:^|[;{}\n])\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(async\\s+)?'
const IDIOM_INJECTION_WORDS = Object.freeze(['io', 'deps', 'dependencies', 'contracts'])
const IDIOM_PREDICATE_PATTERN = /^(?:is|has|can|should)(?:[A-Z]|$)/

function balanceCloser(text, openIndex, openChar, closeChar) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text.charAt(index) === openChar) depth += 1
    else if (text.charAt(index) === closeChar) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitTopLevelParams(params) {
  const parts = []
  let depth = 0
  let current = ''
  for (let pi = 0; pi < params.length; pi += 1) {
    const char = params.charAt(pi)
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

function idiomInjectionFlags(params) {
  const braced = params.match(/\{[^}]*\}/g) || []
  const destructuredInjection = braced.some((group) => IDIOM_INJECTION_WORDS.some((word) => group.indexOf(word) !== -1 && group.search(new RegExp('\\b' + word + '\\b')) !== -1))
  let positionalInjection = false
  const parts = splitTopLevelParams(params)
  for (let pi = 0; pi < parts.length; pi += 1) {
    const noDefault = parts[pi].split('=')[0].trim().replace(/^\.\.\./, '').trim()
    const head = noDefault.match(/^([A-Za-z_$][\w$]*)\??(?:\s*:.*)?$/)
    if (head && IDIOM_INJECTION_WORDS.indexOf(head[1]) !== -1) positionalInjection = true
  }
  return { destructuredInjection, positionalInjection }
}

function makeIdiomFunction(path, name, params, sigStart, endOffset, signature, starts, expressionBody, expression) {
  const flags = idiomInjectionFlags(params)
  return {
    path,
    name,
    start: textLineOf(starts, sigStart) + 1,
    end: textLineOf(starts, Math.max(endOffset, sigStart)) + 1,
    signature,
    predicateName: IDIOM_PREDICATE_PATTERN.test(name),
    returnsValue: expressionBody && expression !== null,
    returnExpressions: expressionBody ? [expression] : [],
    destructuredInjection: flags.destructuredInjection,
    positionalInjection: flags.positionalInjection,
    expressionBody,
    _start: sigStart,
    _end: endOffset,
  }
}

function idiomOwnerAt(functions, offset) {
  let best = null
  for (const fn of functions) {
    if (fn._start <= offset && offset <= fn._end) {
      if (!best || fn._start >= best._start) best = fn
    }
  }
  return best
}

// lean: function signatures and brace spans are parsed crudely without an AST, and a function naming both injection shapes counts as destructured; use a JS parser if nested or multiline signatures misclassify functions.
function collectIdiomFunctions(path, body, maskedText) {
  const functions = []
  const starts = textLineStarts(maskedText)
  const originalLines = body.split('\n')
  const signatureAt = (offset) => originalLines[textLineOf(starts, offset)].trim()
  const skipSpaces = (offset) => {
    while (offset < maskedText.length && maskedText.charAt(offset).search(/\s/) !== -1) offset += 1
    return offset
  }
  const decls = maskedText.matchAll(new RegExp(IDIOM_DECL_SOURCE, 'gm'))
  for (const match of decls) {
    const name = match[1]
    const sigStart = match.index + match[0].lastIndexOf('function')
    const openParen = match.index + match[0].length - 1
    const closeParen = balanceCloser(maskedText, openParen, '(', ')')
    if (closeParen < 0) continue
    const params = maskedText.slice(openParen + 1, closeParen)
    let cursor = skipSpaces(closeParen + 1)
    if (maskedText.charAt(cursor) === ':') {
      let end = cursor + 1
      while (end < maskedText.length && maskedText.charAt(end) !== '{' && maskedText.charAt(end) !== ';') end += 1
      if (end >= maskedText.length || maskedText.charAt(end) !== '{') continue
      cursor = end
    }
    if (maskedText.charAt(cursor) !== '{') continue
    const bodyClose = balanceCloser(maskedText, cursor, '{', '}')
    if (bodyClose < 0) continue
    functions.push(makeIdiomFunction(path, name, params, sigStart, bodyClose, signatureAt(sigStart), starts, false, null))
  }
  const arrows = maskedText.matchAll(new RegExp(IDIOM_ARROW_SOURCE, 'gm'))
  for (const match of arrows) {
    const name = match[1]
    let cursor = skipSpaces(match.index + match[0].length)
    let params = null
    if (maskedText.charAt(cursor) === '(') {
      const closeParen = balanceCloser(maskedText, cursor, '(', ')')
      if (closeParen < 0) continue
      params = maskedText.slice(cursor + 1, closeParen)
      cursor = skipSpaces(closeParen + 1)
    } else if (cursor < maskedText.length && maskedText.charAt(cursor).search(/[A-Za-z_$]/) !== -1) {
      const tail = maskedText.slice(cursor).match(/^[A-Za-z_$][\w$]*/)
      if (!tail) continue
      params = tail[0]
      cursor = skipSpaces(cursor + params.length)
    } else {
      continue
    }
    if (maskedText.slice(cursor, cursor + 2) !== '=>') continue
    cursor = skipSpaces(cursor + 2)
    const keyword = match[0].match(/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?$/)
    const sigStart = match.index + (keyword ? match[0].lastIndexOf(keyword[0]) : match[0].length)
    if (maskedText.charAt(cursor) === '{') {
      const bodyClose = balanceCloser(maskedText, cursor, '{', '}')
      if (bodyClose < 0) continue
      functions.push(makeIdiomFunction(path, name, params, sigStart, bodyClose, signatureAt(sigStart), starts, false, null))
    } else {
      let end = cursor
      while (end < maskedText.length && maskedText.charAt(end) !== ';' && maskedText.charAt(end) !== '\n') end += 1
      const expression = maskedText.slice(cursor, end).trim()
      functions.push(makeIdiomFunction(path, name, params, sigStart, end, signatureAt(sigStart), starts, true, expression || null))
    }
  }
  const anonymous = maskedText.matchAll(/\bfunction\s*\(/g)
  for (const match of anonymous) {
    const openParen = match.index + match[0].lastIndexOf('(')
    const closeParen = balanceCloser(maskedText, openParen, '(', ')')
    if (closeParen < 0) continue
    const cursor = skipSpaces(closeParen + 1)
    if (maskedText.charAt(cursor) !== '{') continue
    const end = balanceCloser(maskedText, cursor, '{', '}')
    if (end < 0) continue
    const fn = makeIdiomFunction(path, '<callback>', maskedText.slice(openParen + 1, closeParen), match.index, end, signatureAt(match.index), starts, false, null)
    fn.ownerOnly = true
    functions.push(fn)
  }
  const callbacks = maskedText.matchAll(/(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)
  for (const match of callbacks) {
    const arrow = match.index + match[0].lastIndexOf('=>')
    const open = maskedText.indexOf('{', arrow + 2)
    const end = balanceCloser(maskedText, open, '{', '}')
    if (end < 0) continue
    if (functions.some((fn) => fn._end === end)) continue
    const params = match[0].slice(0, match[0].lastIndexOf('=>')).trim().replace(/^async\s+/, '').replace(/^\(|\)$/g, '')
    const fn = makeIdiomFunction(path, '<callback>', params, match.index, end, signatureAt(match.index), starts, false, null)
    fn.ownerOnly = true
    functions.push(fn)
  }
  const returns = maskedText.matchAll(/\breturn\b/g)
  for (const match of returns) {
    const owner = idiomOwnerAt(functions, match.index)
    if (!owner || owner.expressionBody) continue
    let cursor = match.index + 6
    const gap = cursor < maskedText.length ? maskedText.charAt(cursor) : ''
    if (gap === ' ' || gap === '\t' || gap === '\r') {
      let probe = cursor
      while (probe < maskedText.length && (maskedText.charAt(probe) === ' ' || maskedText.charAt(probe) === '\t' || maskedText.charAt(probe) === '\r')) probe += 1
      const probeChar = probe < maskedText.length ? maskedText.charAt(probe) : ''
      if (probeChar === '' || probeChar === '\n' || probeChar === ';' || probeChar === '}') {
        owner.returnExpressions.push(null)
        continue
      }
    } else if (gap === '' || gap === ';' || gap === '}' || gap === '\n') {
      owner.returnExpressions.push(null)
      continue
    }
    let end = cursor
    while (end < maskedText.length && maskedText.charAt(end) !== ';' && maskedText.charAt(end) !== '\n') end += 1
    const expression = maskedText.slice(cursor, end).trim()
    owner.returnExpressions.push(expression || null)
  }
  for (const fn of functions) {
    if (fn.expressionBody === false && fn.returnExpressions.some((entry) => entry !== null && entry !== '')) {
      fn.returnsValue = true
    }
  }
  return functions
}

function unmeasuredIdiom(kind, reason, sampleSize = null) {
  return { class: kind, rule: null, exemplars: [], sample_size: sampleSize, basis: null, reason }
}

function mineCommentDensity(scan) {
  if (scan.ok === false) return unmeasuredIdiom('comment_density', scan.reason, null)
  if (scan.supported.length < IDIOM_DENSITY_MIN_FILES) return unmeasuredIdiom('comment_density', 'no_sources', null)
  let commentLines = 0
  let codeLines = 0
  const functions = []
  for (const file of idiomCorpus(scan)) {
    for (let line = 0; line < file.comment.length; line += 1) {
      if (file.comment[line]) commentLines += 1
      if (file.code[line]) codeLines += 1
    }
    for (const fn of file.functions) if (!fn.ownerOnly) functions.push(fn)
  }
  if (codeLines === 0) return unmeasuredIdiom('comment_density', 'no_sample', null)
  const ordered = functions.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start))
  const exemplars = ordered.slice(0, 3).map((fn) => ({ path: fn.path, name: fn.name, start: fn.start, end: fn.end }))
  if (exemplars.length === 0) return unmeasuredIdiom('comment_density', 'no_exemplar', scan.supported.length)
  const density = Number((commentLines * 100 / codeLines).toFixed(2))
  const count = scan.supported.length
  const ruleText = density + ' comment lines per 100 code lines across ' + count + ' scanned files (sample_size ' + count + ')'
  return {
    class: 'comment_density',
    rule: ruleText,
    exemplars,
    sample_size: count,
    basis: 'line comment/code density',
    value: density,
  }
}
function idiomCorpus(scan) {
  if (scan.corpus) return scan.corpus
  const files = []
  for (const file of scan.supported) {
    const body = file.name.endsWith('.svelte') ? svelteScriptBody(file.text) : file.text
    const masked = maskSource(body)
    files.push({ name: file.name, body, ...masked, functions: collectIdiomFunctions(file.name, body, masked.masked) })
  }
  return files
}

function idiomExemplars(functions) {
  const seen = new Set()
  const unique = []
  for (const fn of functions) {
    if (fn !== null && fn !== undefined && fn.ownerOnly !== true && !seen.has(fn)) {
      seen.add(fn)
      unique.push(fn)
    }
  }
  return unique.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start)).slice(0, 3).map((fn) => ({ path: fn.path, name: fn.name, start: fn.start, end: fn.end }))
}

function decideIdiomMajority(kind, sampleSize, buckets) {
  if (sampleSize < IDIOM_SAMPLE_MIN) return unmeasuredIdiom(kind, 'insufficient_sample', sampleSize)
  const ordered = buckets.slice().sort((a, b) => b.count - a.count)
  const largest = ordered[0]
  if (largest.count * 2 <= sampleSize) return unmeasuredIdiom(kind, 'no_majority', sampleSize)
  return { measured: true, largest }
}

function idiomDepthZero(text) {
  let depth = 0
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      out += ' '
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1)
      out += ' '
    } else {
      out += depth === 0 ? char : ' '
    }
  }
  return out
}

function stripBalancedParens(expression) {
  let current = String(expression).trim()
  while (current.length >= 2 && current.charAt(0) === '(' && balanceCloser(current, 0, '(', ')') === current.length - 1) {
    current = current.slice(1, -1).trim()
  }
  return current
}

function isBooleanShaped(expression) {
  const inner = stripBalancedParens(expression)
  if (inner === 'true' || inner === 'false') return true
  if (inner.charAt(0) === '!') return true
  const top = idiomDepthZero(inner)
  if (/(^|[^?])\?(?![.?])/.test(top)) return false
  if (/===|!==|==|!=|<=|>=/.test(top)) return true
  if (/\b(?:in|instanceof)\b/.test(top)) return true
  if (/(^|\s)<(?![=>])(?:\s|$)/.test(top)) return true
  if (/(^|\s)>(?![=>])(?:\s|$)/.test(top.replace(/=>/g, '  '))) return true
  return false
}

function mineDependencyInjection(scan) {
  const kind = 'dependency_injection'
  if (scan.ok === false) return unmeasuredIdiom(kind, scan.reason, null)
  if (scan.supported.length === 0) return unmeasuredIdiom(kind, 'no_sources', null)
  const injected = []
  const positionalOnly = []
  for (const file of idiomCorpus(scan)) {
    for (const fn of file.functions) {
      if (fn.ownerOnly) continue
      if (fn.destructuredInjection) injected.push(fn)
      else if (fn.positionalInjection) {
        injected.push(fn)
        positionalOnly.push(fn)
      }
    }
  }
  const sampleSize = injected.length
  if (sampleSize === 0) return unmeasuredIdiom(kind, 'no_sample', null)
  const destructured = injected.filter(fn => fn.destructuredInjection).length
  const destructuredFns = injected.filter((fn) => fn.destructuredInjection)
  const buckets = [
    { shape: 'destructured', count: destructured, matchingFunctions: destructuredFns },
    { shape: 'positional', count: positionalOnly.length, matchingFunctions: positionalOnly },
  ]
  const decision = decideIdiomMajority(kind, sampleSize, buckets)
  if (decision.measured !== true) return decision
  const exemplars = idiomExemplars(decision.largest.matchingFunctions)
  if (exemplars.length === 0) return unmeasuredIdiom(kind, 'no_exemplar', sampleSize)
  const shape = decision.largest.shape === 'destructured' ? 'destructured object parameters' : 'positional named parameters'
  const rule = decision.largest.count + ' of ' + sampleSize + ' injected functions in the sample use ' + shape + ' (sample_size ' + sampleSize + ')'
  return { class: kind, rule, exemplars, sample_size: sampleSize, basis: 'injected parameter shape dominance' }
}

function mineBooleanHelpers(scan) {
  const kind = 'boolean_helpers'
  if (scan.ok === false) return unmeasuredIdiom(kind, scan.reason, null)
  if (scan.supported.length === 0) return unmeasuredIdiom(kind, 'no_sources', null)
  const predicates = []
  for (const file of idiomCorpus(scan)) {
    for (const fn of file.functions) {
      if (fn.ownerOnly) continue
      const returns = fn.returnExpressions
      const everyBoolean = returns.length > 0 && returns.every((entry) => entry !== null && entry !== '' && isBooleanShaped(entry))
      if (fn.predicateName || everyBoolean) predicates.push(fn)
    }
  }
  const sampleSize = predicates.length
  if (sampleSize === 0) return unmeasuredIdiom(kind, 'no_sample', null)
  const prefixed = predicates.filter(fn => fn.predicateName).length
  const buckets = [
    { shape: 'prefixed', count: prefixed, matchingFunctions: predicates.filter((fn) => fn.predicateName) },
    { shape: 'nonprefix', count: sampleSize - prefixed, matchingFunctions: predicates.filter((fn) => !fn.predicateName) },
  ]
  const decision = decideIdiomMajority(kind, sampleSize, buckets)
  if (decision.measured !== true) return decision
  const exemplars = idiomExemplars(decision.largest.matchingFunctions)
  if (exemplars.length === 0) return unmeasuredIdiom(kind, 'no_exemplar', sampleSize)
  let rule = prefixed + ' of ' + sampleSize + ' predicate functions in the sample are named is*/has*/can*/should*'
  if (decision.largest.shape !== 'prefixed') rule += ' with non-prefix naming dominant'
  rule += ' (sample_size ' + sampleSize + ')'
  return { class: kind, rule, exemplars, sample_size: sampleSize, basis: 'predicate naming and return-shape dominance' }
}

// lean: only literal console and logger receivers are counted and aliased loggers are missed; use a binding-aware parser if logger aliases carry the convention.
function mineLoggingPlacement(scan) {
  const kind = 'logging_placement'
  if (scan.ok === false) return unmeasuredIdiom(kind, scan.reason, null)
  if (scan.supported.length === 0) return unmeasuredIdiom(kind, 'no_sources', null)
  const logs = []
  for (const file of idiomCorpus(scan)) {
    const calls = file.masked.matchAll(/\b(?:console|logger)\s*\.\s*[A-Za-z_$][\w$]*\s*\(|\blogger\s*\(/g)
    for (const match of calls) logs.push({ owner: idiomOwnerAt(file.functions, match.index) })
  }
  const sampleSize = logs.length
  if (sampleSize === 0) return unmeasuredIdiom(kind, 'no_sample', null)
  const helperLogs = logs.filter(log => log.owner?.returnsValue).length
  const helperOwners = []
  const callerOwners = []
  for (const log of logs) {
    if (log.owner === null || log.owner === undefined) continue
    if (log.owner.returnsValue === true) helperOwners.push(log.owner)
    else callerOwners.push(log.owner)
  }
  const buckets = [
    { shape: 'helper', count: helperLogs, matchingFunctions: helperOwners },
    { shape: 'caller', count: sampleSize - helperLogs, matchingFunctions: callerOwners },
  ]
  const decision = decideIdiomMajority(kind, sampleSize, buckets)
  if (decision.measured !== true) return decision
  const exemplars = idiomExemplars(decision.largest.matchingFunctions)
  if (exemplars.length === 0) return unmeasuredIdiom(kind, 'no_exemplar', sampleSize)
  const rule = decision.largest.count + ' of ' + sampleSize + ' logging calls in the sample are in ' + decision.largest.shape + ' functions (sample_size ' + sampleSize + ')'
  return { class: kind, rule, exemplars, sample_size: sampleSize, basis: 'logging call-site ownership dominance' }
}

// lean: catch bodies and loop spans are matched with crude brace counting and only for and while loops enclose retries; use a JS parser if single-statement or nested loop bodies misclassify catches.
function collectIdiomLoopSpans(masked) {
  const spans = []
  const loops = masked.matchAll(/\b(?:for|while)\b/g)
  for (const match of loops) {
    let cursor = match.index + match[0].length
    while (cursor < masked.length && /\s/.test(masked.charAt(cursor))) cursor += 1
    if (masked.charAt(cursor) === '(') {
      const close = balanceCloser(masked, cursor, '(', ')')
      if (close < 0) continue
      cursor = close + 1
      while (cursor < masked.length && /\s/.test(masked.charAt(cursor))) cursor += 1
    }
    if (masked.charAt(cursor) !== '{') continue
    const end = balanceCloser(masked, cursor, '{', '}')
    if (end < 0) continue
    spans.push({ start: cursor, end })
  }
  return spans
}

function mineErrorRetryShape(scan) {
  const kind = 'error_retry_shape'
  if (scan.ok === false) return unmeasuredIdiom(kind, scan.reason, null)
  if (scan.supported.length === 0) return unmeasuredIdiom(kind, 'no_sources', null)
  const catches = []
  for (const file of idiomCorpus(scan)) {
    const loops = collectIdiomLoopSpans(file.masked)
    const found = file.masked.matchAll(/\bcatch\b/g)
    for (const match of found) {
      let cursor = match.index + 5
      while (cursor < file.masked.length && /\s/.test(file.masked.charAt(cursor))) cursor += 1
      if (file.masked.charAt(cursor) === '(') {
        const close = balanceCloser(file.masked, cursor, '(', ')')
        if (close < 0) continue
        cursor = close + 1
        while (cursor < file.masked.length && /\s/.test(file.masked.charAt(cursor))) cursor += 1
      }
      if (file.masked.charAt(cursor) !== '{') continue
      const end = balanceCloser(file.masked, cursor, '{', '}')
      if (end < 0) continue
      const body = file.masked.slice(cursor + 1, end)
      let shape = 'other'
      if (loops.some((span) => span.start <= match.index && match.index <= span.end)) shape = 'retry-loop'
      else if (/^\s*return\s+null\b/.test(body)) shape = 'swallow-and-return-null'
      else if (/^\s*throw\b/.test(body)) shape = 'rethrow'
      catches.push({ path: file.name, offset: match.index, shape, owner: idiomOwnerAt(file.functions, match.index) })
    }
  }
  const sampleSize = catches.length
  if (sampleSize === 0) return unmeasuredIdiom(kind, 'no_sample', null)
  const swallow = catches.filter(block => block.shape === 'swallow-and-return-null').length
  const shapeOwners = { 'retry-loop': [], 'swallow-and-return-null': [], rethrow: [], other: [] }
  for (const block of catches) {
    if (block.owner !== null && block.owner !== undefined) shapeOwners[block.shape].push(block.owner)
  }
  const buckets = [
    { shape: 'retry-loop', count: catches.filter((block) => block.shape === 'retry-loop').length, matchingFunctions: shapeOwners['retry-loop'] },
    { shape: 'swallow-and-return-null', count: swallow, matchingFunctions: shapeOwners['swallow-and-return-null'] },
    { shape: 'rethrow', count: catches.filter((block) => block.shape === 'rethrow').length, matchingFunctions: shapeOwners.rethrow },
    { shape: 'other', count: catches.filter((block) => block.shape === 'other').length, matchingFunctions: shapeOwners.other },
  ]
  const decision = decideIdiomMajority(kind, sampleSize, buckets)
  if (decision.measured !== true) return decision
  const exemplars = idiomExemplars(decision.largest.matchingFunctions)
  if (exemplars.length === 0) return unmeasuredIdiom(kind, 'no_exemplar', sampleSize)
  const rule = decision.largest.count + ' of ' + sampleSize + ' catch handlers in the sample use ' + decision.largest.shape + ' (sample_size ' + sampleSize + ')'
  return { class: kind, rule, exemplars, sample_size: sampleSize, basis: 'catch-handler shape dominance' }
}
function gatherConventions(root) {
  const names = [
    'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'README.md',
    'docs/conventions.md', 'docs/adr/', '.claude/', '.editorconfig',
  ]
  const files = names.filter((name) => {
    try {
      return statSync(join(root, name.replace(/\/$/, ''))).isDirectory() === name.endsWith('/')
    } catch {
      return false
    }
  }).sort()
  const output = gitOutput(root, ['log', '--format=%s', '-n', '50'])
  const subjects = output == null ? [] : output.split(/\r?\n/).filter((line) => line.length > 0)
  const conventional = subjects.filter((subject) => /^\w+(\([^)]+\))?!?: /.test(subject))
  const types = [...new Set(conventional.map((subject) => subject.match(/^(\w+)/)?.[1]).filter(Boolean))].sort()
  const scan = scanIdiomSources(root)
  const density = mineCommentDensity(scan)
  const idioms = IDIOM_CLASSES.map((kind) => {
    if (kind === 'comment_density') return density
    if (kind === 'dependency_injection') return mineDependencyInjection(scan)
    if (kind === 'boolean_helpers') return mineBooleanHelpers(scan)
    if (kind === 'logging_placement') return mineLoggingPlacement(scan)
    return mineErrorRetryShape(scan)
  })
  let idiom_scan
  if (scan.ok) {
    const skipped = scan.skipped
    idiom_scan = {
      files_scanned: scan.supported.length,
      files_skipped_by_extension: skipped,
      extensions: [...scan.extensions].sort(),
    }
  } else {
    idiom_scan = { files_scanned: null, files_skipped_by_extension: null, extensions: [] }
  }
  const value = {
    files,
    commit_style: {
      sampled: subjects.length,
      conventional: subjects.length === 0 ? 0 : conventional.length / subjects.length,
      types,
    },
    idioms,
    idiom_scan,
  }
  if (files.length === 0 && subjects.length === 0) return proposedCell(value, 'tracked source heuristics')
  return proposedCell(value, files.length > 0 ? 'convention markers and git log' : 'git log')
}

function classifyGhFailure(stderr) {
  if (/not been granted|required scopes?|missing (?:the )?scopes?/i.test(stderr)) return 'gh_scope_missing'
  if (/gh auth login|not logged in|authentication token not found|requires authentication|HTTP 401/i.test(stderr)) {
    return 'gh_unauthenticated'
  }
  return 'gh_request_rejected'
}

function runGhArgs(root, args) {
  let result
  try {
    result = spawnSync(process.env.GH_BIN || 'gh', args,
      { cwd: root, encoding: 'utf8', timeout: 30_000 })
  } catch {
    return { ok: false, reason: 'gh_unavailable' }
  }
  // No exit status means the tool did not run to completion (missing binary,
  // not executable, timed out) — that is absence, not a rejected request.
  if (!result || result.error || typeof result.status !== 'number') {
    return { ok: false, reason: 'gh_unavailable' }
  }
  if (result.status !== 0) {
    return { ok: false, reason: classifyGhFailure(String(result.stderr || '')) }
  }
  let data
  try {
    data = JSON.parse(String(result.stdout || '').trim())
  } catch {
    return { ok: false, reason: 'gh_request_rejected' }
  }
  // A plain object is data; anything else is gh answering something we cannot use.
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'gh_request_rejected' }
  }
  return { ok: true, data }
}

function runGh(root, fields) {
  return runGhArgs(root, ['repo', 'view', '--json', fields.join(',')])
}

function ghView(root, fields) {
  const r = runGh(root, fields)
  return r.ok ? r.data : null
}

function gatherDefaultBranch(root, isGit, consultGh) {
  // gh is a best-effort shortcut here. If it cannot answer, this cell reports
  // the git evidence below, so its unknown reasons describe git, not gh.
  if (consultGh) {
    const data = ghView(root, ['defaultBranchRef'])
    const name = data && data.defaultBranchRef && data.defaultBranchRef.name
    if (nonEmptyString(name)) return proposedCell(name, 'gh repo view --json defaultBranchRef')
  }
  if (isGit) {
    const ref = gitOutput(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    if (nonEmptyString(ref)) {
      const value = ref.trim()
      const prefix = 'refs/remotes/origin/'
      const name = value.startsWith(prefix) ? value.slice(prefix.length) : value.split('/').pop()
      if (nonEmptyString(name)) return proposedCell(name, 'git symbolic-ref refs/remotes/origin/HEAD')
    }
    return unknownCell('no_remote_head')
  }
  return unknownCell('not_a_git_repo')
}

function gatherPrConventions(root, consultGh) {
  if (!consultGh) return unknownCell('gh_not_consulted')
  const fields = [
    'nameWithOwner', 'squashMergeAllowed', 'mergeCommitAllowed',
    'rebaseMergeAllowed', 'deleteBranchOnMerge', 'allowAutoMerge',
  ]
  const bulk = runGh(root, fields)
  if (bulk.ok) return proposedCell(bulk.data, `gh repo view --json ${fields.join(',')}`)
  const answered = {}
  const askedOk = []
  const unanswered = []
  for (const field of fields) {
    const one = runGh(root, [field])
    if (one.ok && Object.hasOwn(one.data, field)) {
      answered[field] = one.data[field]
      askedOk.push(field)
    } else {
      unanswered.push({ field, reason: one.ok ? 'gh_request_rejected' : one.reason })
    }
  }
  if (askedOk.length === 0) {
    const reasons = [...new Set(unanswered.map((entry) => entry.reason))]
    return unknownCell(reasons.length === 1 ? reasons[0] : 'gh_request_rejected')
  }
  return proposedCell(answered, `gh repo view --json ${askedOk.join(',')}`, { detail: { unanswered } })
}

function normaliseIntakeColumn(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function intakeProjectCandidate(node) {
  return {
    number: node?.number ?? null,
    title: node?.title ?? null,
    url: node?.url ?? null,
  }
}

function intakeProjectReference(node) {
  const resourcePath = typeof node?.resourcePath === 'string' ? node.resourcePath.trim() : ''
  const match = resourcePath.match(/^\/(users|orgs)\/([^/]+)\/projects\/(\d+)\/?$/)
  const nodeNumber = Number(node?.number)
  const pathNumber = match ? Number(match[3]) : NaN
  if (!match || !Number.isInteger(nodeNumber) || nodeNumber <= 0
    || !Number.isInteger(pathNumber) || pathNumber <= 0 || nodeNumber !== pathNumber) {
    return null
  }
  return {
    owner: match[2],
    ownerType: match[1] === 'users' ? 'user' : 'organization',
    number: pathNumber,
  }
}

function intakeFieldsQuery(ownerType) {
  const root = ownerType === 'organization' ? 'organization' : 'user'
  return `query($owner:String!,$number:Int!){
    ${root}(login:$owner){projectV2(number:$number){title fields(first:100){nodes{
      ... on ProjectV2SingleSelectField{name options{name}}
    }}}}
  }`
}

function gatherIntakeBoard(root, consultGh) {
  if (!consultGh) return unknownCell('gh_not_consulted')

  const projectsResult = runGh(root, ['projectsV2'])
  if (!projectsResult.ok) return unknownCell(projectsResult.reason)
  const projects = projectsResult.data.projectsV2
  const nodes = Array.isArray(projects?.Nodes)
    ? projects.Nodes
    : Array.isArray(projects?.nodes) ? projects.nodes : null
  if (!nodes) return unknownCell('gh_request_rejected')

  const open = nodes.filter((node) => node && typeof node === 'object' && node.closed !== true)
  const candidates = open.map(intakeProjectCandidate)
  if (open.length === 0) return unknownCell('none_found')
  if (open.length > 1) return unknownCell('multiple_candidates', candidates)

  const node = open[0]
  const reference = intakeProjectReference(node)
  if (!reference) return unknownCell('gh_request_rejected')

  const graphql = runGhArgs(root, [
    'api', 'graphql', '-f', `query=${intakeFieldsQuery(reference.ownerType)}`,
    '-F', `owner=${reference.owner}`, '-F', `number=${reference.number}`,
  ])
  if (!graphql.ok) return unknownCell(graphql.reason)
  const data = graphql.data.data
  const project = data && typeof data === 'object' && !Array.isArray(data)
    ? data[reference.ownerType]?.projectV2
    : null
  const fieldNodes = project?.fields?.nodes
  if (!project || typeof project !== 'object' || Array.isArray(project)
    || !Array.isArray(fieldNodes)) return unknownCell('gh_request_rejected')

  const singleSelectFields = fieldNodes.filter((field) => (
    field && typeof field === 'object' && !Array.isArray(field)
      && nonEmptyString(field.name) && Array.isArray(field.options)
  ))
  const singleSelectFieldNames = singleSelectFields.map((field) => field.name)
  const matchingFields = singleSelectFields.filter((field) => {
    const options = field.options
    return Object.values(INTAKE_COLUMN_ROLES).every((role) => options.some((option) => (
      option && nonEmptyString(option.name) && role.includes(normaliseIntakeColumn(option.name))
    )))
  })
  if (matchingFields.length === 0) return unknownCell('none_found', singleSelectFieldNames)
  if (matchingFields.length > 1) return unknownCell('multiple_candidates', matchingFields.map((field) => field.name))

  const statusField = matchingFields[0]
  const optionNames = statusField.options
    .map((option) => option && option.name)
    .filter((name) => typeof name === 'string')
  const optionFor = (role) => statusField.options.find((option) => (
    option && nonEmptyString(option.name) && role.includes(normaliseIntakeColumn(option.name))
  ))?.name
  const projectTitle = typeof project.title === 'string' ? project.title : node.title ?? null
  return proposedCell({
    owner: reference.owner,
    project_number: reference.number,
    status_field: statusField.name,
    ready_column: optionFor(INTAKE_COLUMN_ROLES.ready),
    work_column: optionFor(INTAKE_COLUMN_ROLES.work),
    review_column: optionFor(INTAKE_COLUMN_ROLES.review),
  }, 'gh repo view --json projectsV2 + gh api graphql projectV2 fields', {
    candidates: [intakeProjectCandidate(node)],
    detail: {
      project_title: projectTitle,
      project_url: node.url ?? null,
      owner_type: reference.ownerType,
      status_options: optionNames,
      columns_validated_at: 'probe',
    },
  })
}

export function profileBody(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile
  const body = clone(profile)
  delete body.meta
  return body
}

export function profileDigest(profile) {
  const body = profile && profile.meta !== undefined ? profileBody(profile) : profile
  return createHash('sha256').update(canonicalJson(body)).digest('hex')
}

export function probeRepo({ checkout, baseline = false, gh = false, now = () => Date.now() } = {}) {
  const started = Date.now()
  const root = checkoutDirectory(checkout)
  const gitRootPath = gitRoot(root)
  const isGit = gitRootPath !== null
  const probedAt = iso(now())
  const testCommand = gatherTestCommand(root)
  const baselineResult = gatherBaseline(root, testCommand, baseline === true)
  const profile = {
    schema: PROFILE_VERSION,
    profile_version: PROFILE_VERSION,
    repo_key: remoteRepoKey(root, isGit),
    repo_slug: slug(basename(root)),
    fields: {
      toolchain: gatherToolchain(root),
      test_command: testCommand,
      baseline: baselineResult.cell,
      ci: gatherCi(root),
      protected_paths_candidates: gatherProtectedPaths(root),
      conventions: gatherConventions(root),
      default_branch: gatherDefaultBranch(root, isGit, gh === true),
      pr_conventions: gatherPrConventions(root, gh === true),
      intake_board: gatherIntakeBoard(root, gh === true),
    },
    meta: {
      probed_at: probedAt,
      probe_duration_ms: Math.max(0, Date.now() - started),
      probed_from: root,
      baseline_command: baselineResult.command,
      baseline_duration_ms: baselineResult.duration,
      gh_consulted: gh === true,
      body_digest: null,
    },
  }
  profile.meta.body_digest = profileDigest(profile)
  return profile
}

function profilePathLabel(profile) {
  if (profile && profile.meta && nonEmptyString(profile.meta.profile_path)) return profile.meta.profile_path
  return '<profile path>'
}

function refusalMessage(profile, name, status, reason) {
  const repoKey = profile && nonEmptyString(profile.repo_key) ? profile.repo_key : '<unknown repo>'
  const suffix = reason ? ` (reason: ${reason})` : ''
  const state = status === 'ratified' && reason === 'profile-ratification-invalid'
    ? `is ${status} but invalid${suffix}`
    : status === 'ratified' && reason === 'profile-ratification-refused'
      ? `is ${status} but its ${fieldKind(name)} value is evidence only and cannot be used${suffix}`
      : `is ${status}, not ratified${suffix}`
  return `probe-repo: field "${name}" ${state} — refusing to use the repo profile for ${repoKey}, whose lane cannot be trusted unreviewed (ratify the field in ${profilePathLabel(profile)}, or pass the value explicitly).`
}

function validRatifiedCell(field) {
  return !!field
    && typeof field === 'object'
    && !Array.isArray(field)
    && field.status === 'ratified'
    && field.value !== null
    && field.value !== undefined
    && nonEmptyString(field.source)
    && nonEmptyString(field.ratified_by)
    && nonEmptyString(field.ratified_at)
}

export function requireField(profile, name) {
  const fields = profile && profile.fields && typeof profile.fields === 'object' ? profile.fields : null
  if (!fields || !Object.hasOwn(fields, name)) {
    throw new ProfileRefusal(
      `probe-repo: field "${name}" is absent, not ratified (reason: profile-field-unknown) — refusing to use the repo profile for ${profile && profile.repo_key ? profile.repo_key : '<unknown repo>'}, whose lane cannot be trusted unreviewed (ratify the field in ${profilePathLabel(profile)}, or pass the value explicitly).`,
      'profile-field-unknown',
    )
  }
  const field = fields[name]
  if (field && field.status === 'ratified') {
    if (!isRatifiable(name)) {
      const reason = 'profile-ratification-refused'
      throw new ProfileRefusal(refusalMessage(profile, name, 'ratified', reason), reason)
    }
    if (validRatifiedCell(field)) return field.value
    const reason = 'profile-ratification-invalid'
    throw new ProfileRefusal(refusalMessage(profile, name, 'ratified', reason), reason)
  }
  const status = field && nonEmptyString(field.status) ? field.status : 'unknown'
  const reason = status === 'unknown'
    ? (field && field.reason) || 'profile-field-unknown'
    : 'profile-unratified'
  const messageReason = status === 'unknown' ? reason : null
  throw new ProfileRefusal(refusalMessage(profile, name, status, messageReason), reason)
}

export function assertRunnable(profile) {
  const values = {}
  for (const name of LOAD_BEARING) values[name] = requireField(profile, name)
  return values
}

export const PROTECTED_PATHS_FIELD = 'protected_paths_candidates'
const PROTECTED_PATHS_INVALID = 'protected-paths-invalid'

function protectedProfilePathLabel(path) {
  return nonEmptyString(path) ? path : 'no profile path resolved'
}

function protectedPathsRefusal(profile, path, detail) {
  const repoKey = profile && nonEmptyString(profile.repo_key) ? profile.repo_key : '<unknown repo>'
  return new ProfileRefusal(
    `probe-repo: field "${PROTECTED_PATHS_FIELD}" is ratified but ${detail} (reason: ${PROTECTED_PATHS_INVALID}) — refusing to guess the protected list for ${repoKey} (fix the field in ${protectedProfilePathLabel(path)})`,
    PROTECTED_PATHS_INVALID,
  )
}

function protectedPathsFloor(reason, basis) {
  return { paths: resolveProtectedPaths(), used: false, reason, basis }
}

export function profileProtectedPaths(profile, { path = null } = {}) {
  const profilePath = protectedProfilePathLabel(path)
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return protectedPathsFloor(
      'profile-unreadable',
      `authored floor · no readable profile at ${profilePath}`,
    )
  }
  const fields = profile.fields && typeof profile.fields === 'object' && !Array.isArray(profile.fields)
    ? profile.fields
    : null
  if (!fields || !Object.hasOwn(fields, PROTECTED_PATHS_FIELD)) {
    return protectedPathsFloor(
      'profile-field-unknown',
      `authored floor · profile field ${PROTECTED_PATHS_FIELD} is absent · ${profilePath}`,
    )
  }
  const field = fields[PROTECTED_PATHS_FIELD]
  if (!field || field.status !== 'ratified') {
    const status = field && nonEmptyString(field.status) ? field.status : 'unknown'
    const reason = status === 'unknown'
      ? (field && field.reason) || 'profile-field-unknown'
      : 'profile-unratified'
    return protectedPathsFloor(
      reason,
      `authored floor · profile field ${PROTECTED_PATHS_FIELD} is ${status} · ${profilePath}`,
    )
  }

  let value
  try {
    value = requireField(profile, PROTECTED_PATHS_FIELD)
  } catch (err) {
    if (!(err instanceof ProfileRefusal)) throw err
    throw protectedPathsRefusal(profile, path, `its cell is invalid — ${err.reason}`)
  }
  if (!Array.isArray(value)) {
    const kind = value === null ? 'null' : typeof value
    throw protectedPathsRefusal(profile, path, `its value is not a list of paths (got ${kind})`)
  }
  const badIndex = value.findIndex((entry) => typeof entry !== 'string' || !entry.trim())
  if (badIndex !== -1) {
    const entry = value[badIndex]
    throw protectedPathsRefusal(profile, path, `its value is not a list of paths (entry ${badIndex}: ${String(entry)})`)
  }
  return {
    paths: resolveProtectedPaths(value),
    used: true,
    reason: null,
    basis: `ratified profile field ${PROTECTED_PATHS_FIELD} (${value.length} entries) added to the authored floor · ${profilePath}`,
  }
}

// Run entry points need the profile key but not the expensive whole-tree probe.
// Keep this read-only identity lookup separate so a run never pays for probing.
export function repoKeyFor({ checkout, git = gitOutput } = {}) {
  const root = checkoutDirectory(checkout)
  const gitRootPath = gitRoot(root, git)
  return remoteRepoKey(root, gitRootPath !== null, git)
}

export function isPlainBranchName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || /[\s\x00-\x1f\x7f]/u.test(value) || value.includes('..') || value.includes('@{')) return false
  try {
    const result = spawnSync('git', ['check-ref-format', '--branch', value], { encoding: 'utf8', timeout: 3000 })
    return !result.error && result.status === 0
  } catch { return false }
}

export function checkoutBaseBranch({ checkout, profilePath = null, factoryRoot } = {}) {
  const path = profilePath || defaultProfilePath({ repoKey: repoKeyFor({ checkout }), factoryRoot })
  let present = false
  try { lstatSync(path); present = true } catch (error) {
    if (error?.code !== 'ENOENT') throw new ProfileRefusal(`cannot inspect base branch profile · ${path}`, 'profile-unreadable')
  }
  if (!present) return { branch: 'main', basis: `default base branch main · no profile at ${path}` }
  let profile
  try { profile = readProfile(path) } catch {
    throw new ProfileRefusal(`cannot read base branch profile · ${path}`, 'profile-unreadable')
  }
  const branch = requireField(profile, 'default_branch')
  if (!isPlainBranchName(branch)) throw new ProfileRefusal(`base branch ${JSON.stringify(branch)} is invalid · ${path}`, 'base-branch-invalid')
  return { branch, basis: `ratified profile field default_branch · ${path}` }
}

export function checkoutProtectedPaths({ checkout, profilePath = null, factoryRoot } = {}) {
  const path = profilePath != null
    ? resolve(profilePath)
    : defaultProfilePath({ repoKey: repoKeyFor({ checkout }), factoryRoot })
  let profile = null
  try {
    profile = readProfile(path)
  } catch (err) {
    if (!(err instanceof ProbeUsageError)) throw err
  }
  return profileProtectedPaths(profile, { path })
}

export function classifyTestRunner(command) {
  if (typeof command !== 'string') return 'unparsed'
  const trimmed = command.trim()
  if (!trimmed) return 'unparsed'
  const executable = basename(trimmed.split(/\s+/u, 1)[0])
  if (executable === 'cargo') return 'cargo'
  if (['node', 'npm', 'npx', 'yarn', 'pnpm'].includes(executable)) return 'node'
  return 'unparsed'
}

// `suite` is the run's explicit --suite command. When it differs from the ratified
// test_command it is the command that actually runs, so it is the one classified.
export function checkoutTestRunner({ checkout, profilePath = null, factoryRoot, suite = null } = {}) {
  const profiled = profiledTestRunner({ checkout, profilePath, factoryRoot })
  const explicit = typeof suite === 'string' ? suite.trim() : ''
  if (!explicit || explicit === profiled.command) return profiled.answer
  return { runner: classifyTestRunner(explicit), basis: `run --suite ${JSON.stringify(explicit)} · overrides ${profiled.answer.basis}` }
}

function profiledTestRunner({ checkout, profilePath, factoryRoot }) {
  const path = profilePath != null
    ? resolve(profilePath)
    : defaultProfilePath({ repoKey: repoKeyFor({ checkout }), factoryRoot })
  let profile
  try {
    profile = readProfile(path)
  } catch (err) {
    if (!(err instanceof ProbeUsageError)) throw err
    return { command: null, answer: { runner: 'node', basis: `legacy node runner · no readable profile at ${path}` } }
  }
  const field = profile?.fields && typeof profile.fields === 'object' ? profile.fields.test_command : undefined
  if (!field || field.status !== 'ratified') {
    const status = field && nonEmptyString(field.status) ? field.status : 'unknown'
    return { command: null, answer: { runner: 'node', basis: `legacy node runner · profile field test_command is ${status} · ${path}` } }
  }
  const value = requireField(profile, 'test_command')
  return { command: typeof value === 'string' ? value.trim() : null, answer: { runner: classifyTestRunner(value), basis: `ratified profile field test_command · ${path}` } }
}

export const INTAKE_BOARD_REFUSALS = Object.freeze([
  'profile-unreadable',
  'profile-field-unknown',
  'profile-unratified',
  'intake-board-invalid',
])

function intakeBoardPathLabel(path) {
  return nonEmptyString(path) ? path : 'no profile path resolved'
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function intakeBoardRefusal(profile, path, reason, detail) {
  const repoKey = profile && nonEmptyString(profile.repo_key) ? profile.repo_key : '<unknown repo>'
  return new ProfileRefusal(
    `probe-repo: field "${INTAKE_BOARD_FIELD}" ${detail} (reason: ${reason}) — refusing to use the intake board for ${repoKey} (fix the field in ${intakeBoardPathLabel(path)})`,
    reason,
  )
}

function intakeBoardInvalid(profile, path, key, detail) {
  throw intakeBoardRefusal(
    profile,
    path,
    'intake-board-invalid',
    `has an invalid ${key}${detail ? ` (${detail})` : ''}`,
  )
}

export function profileIntakeBoard(profile, { path = null } = {}) {
  const profilePath = intakeBoardPathLabel(path)
  if (!plainObject(profile)) {
    throw intakeBoardRefusal(profile, path, 'profile-unreadable', 'is not a readable profile object')
  }
  const fields = profile.fields
  if (!plainObject(fields) || !Object.hasOwn(fields, INTAKE_BOARD_FIELD)) {
    throw intakeBoardRefusal(profile, path, 'profile-field-unknown', 'has no known intake_board field')
  }
  const field = fields[INTAKE_BOARD_FIELD]
  if (!plainObject(field) || field.status === 'unknown' || !nonEmptyString(field.status)) {
    throw intakeBoardRefusal(profile, path, 'profile-field-unknown', 'has an unknown intake_board field')
  }
  if (field.status !== 'ratified') {
    throw intakeBoardRefusal(profile, path, 'profile-unratified', `has an intake_board field that is ${field.status}`)
  }

  let value
  try {
    value = requireField(profile, INTAKE_BOARD_FIELD)
  } catch (err) {
    if (!(err instanceof ProfileRefusal)) throw err
    throw intakeBoardRefusal(profile, path, 'intake-board-invalid', `cannot be used (${err.reason})`)
  }
  if (!plainObject(value)) intakeBoardInvalid(profile, path, 'value', 'expected a plain object')

  const requiredStrings = [
    ['owner', value.owner],
    ['status_field', value.status_field],
    ['ready_column', value.ready_column],
    ['work_column', value.work_column],
    ['review_column', value.review_column],
  ]
  for (const [key, candidate] of requiredStrings) {
    if (!nonEmptyString(candidate)) intakeBoardInvalid(profile, path, key, 'expected a non-empty string')
  }
  if (!Number.isInteger(value.project_number) || value.project_number <= 0) {
    intakeBoardInvalid(profile, path, 'project_number', 'expected a positive integer')
  }
  const columns = [
    ['ready_column', value.ready_column],
    ['work_column', value.work_column],
    ['review_column', value.review_column],
  ]
  for (let index = 1; index < columns.length; index += 1) {
    if (columns.slice(0, index).some(([, column]) => column === columns[index][1])) {
      intakeBoardInvalid(profile, path, columns[index][0], 'column names must be distinct')
    }
  }

  return {
    board: { owner: value.owner.trim(), projectNumber: value.project_number },
    config: {
      statusField: value.status_field,
      readyColumn: value.ready_column,
      workColumn: value.work_column,
      reviewColumn: value.review_column,
    },
    basis: `ratified profile field ${INTAKE_BOARD_FIELD} · ${profilePath}`,
  }
}

export function checkoutIntakeBoard({ checkout, profilePath = null, factoryRoot } = {}) {
  const path = profilePath != null
    ? resolve(profilePath)
    : defaultProfilePath({ repoKey: repoKeyFor({ checkout }), factoryRoot })
  let profile = null
  try {
    profile = readProfile(path)
  } catch (err) {
    if (!(err instanceof ProbeUsageError)) throw err
  }
  return profileIntakeBoard(profile, { path })
}

export function defaultProfilePath({ repoKey, factoryRoot } = {}) {
  if (!nonEmptyString(repoKey)) throw new ProbeUsageError('probe-repo: repoKey is required', 'missing-repo-key')
  const root = factoryRoot ?? (process.env.DEVTEAM_FACTORY_DIR || join(homedir(), '.dev-team', 'factory'))
  return join(root, 'profiles', `${repoKey}.json`)
}

function pathForContainment(path) {
  const missing = []
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    missing.unshift(current.slice(parent.length + 1))
    current = parent
  }
  const existing = realpathOr(current)
  return join(existing, ...missing)
}

function pathInside(path, directory) {
  const rel = relative(directory, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function mergedRatified(fresh, oldCell, value) {
  const out = {
    ...fresh,
    status: 'ratified',
    value: clone(value),
    source: oldCell.source || fresh.source,
    ratified_by: oldCell.ratified_by,
    ratified_at: oldCell.ratified_at,
  }
  delete out.reason
  delete out.superseded_ratification
  delete out.refused_ratification
  delete out.probe_additions
  return out
}

function mergeRatifications(profile, existing) {
  const merged = clone(profile)
  if (!existing || !existing.fields || typeof existing.fields !== 'object') return merged
  for (const [name, oldCell] of Object.entries(existing.fields)) {
    const fresh = merged.fields && merged.fields[name]
    if (!fresh || !validRatifiedCell(oldCell)) continue
    const kind = fieldKind(name)
    if (kind === 'commit_scoped') {
      merged.fields[name] = { ...fresh, refused_ratification: clone(oldCell.value) }
      continue
    }
    // A malformed ratified authored-superset value is not a set; let it fall
    // through to the stable merge behaviour instead of treating it as one.
    if (kind === 'authored_superset' && Array.isArray(oldCell.value)) {
      const known = new Set(oldCell.value.map(canonicalJson))
      const additions = Array.isArray(fresh.value)
        ? fresh.value.filter((entry) => !known.has(canonicalJson(entry)))
        : []
      const out = mergedRatified(fresh, oldCell, oldCell.value)
      if (additions.length > 0) out.probe_additions = clone(additions)
      merged.fields[name] = out
      continue
    }
    if (deepEqual(oldCell.value, fresh.value)) {
      merged.fields[name] = mergedRatified(fresh, oldCell, oldCell.value)
    } else if (fresh.status === 'unknown') {
      // A changed probe cannot become a proposed null: preserve the cell
      // invariant and retain the superseded human value for review.
      merged.fields[name] = { ...fresh, superseded_ratification: clone(oldCell.value) }
    } else {
      merged.fields[name] = {
        ...fresh,
        status: 'proposed',
        superseded_ratification: clone(oldCell.value),
      }
    }
  }
  return merged
}

export function readProfile(path) {
  if (!nonEmptyString(path)) throw new ProbeUsageError('probe-repo: profile path is required', 'missing-profile-path')
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch {
    throw new ProbeUsageError(`probe-repo: cannot read or parse profile: ${resolve(path)}`, 'profile-unreadable')
  }
}

export function writeProfile({ profile, out, checkout } = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new ProbeUsageError('probe-repo: profile is required', 'missing-profile')
  }
  if (!nonEmptyString(out)) throw new ProbeUsageError('probe-repo: output path is required', 'missing-output')
  const target = resolve(out)
  // A writer without the checkout cannot prove that its destination is
  // foreign. Fail closed before reading, creating, or replacing anything;
  // the CLI always supplies this explicit boundary too.
  const root = checkoutDirectory(checkout)
  if (pathInside(target, root) || pathInside(pathForContainment(target), root)) {
    throw new ProfileRefusal(
      `probe-repo: refusing to write profile inside checkout ${root} — refusing to write the repo profile into the target checkout`,
      'writes-into-checkout',
    )
  }
  let existing = null
  if (existsSync(target)) {
    existing = readProfile(target)
  }
  const merged = mergeRatifications(profile, existing)
  if (!merged.meta || typeof merged.meta !== 'object') merged.meta = {}
  merged.meta.body_digest = profileDigest(merged)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

function parseCliArgs(argv) {
  const flags = {}
  const positional = []
  const valueFlags = new Set(['checkout', 'out'])
  const booleanFlags = new Set(['baseline', 'gh', 'save'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      if (Object.hasOwn(flags, name)) refuseUsage(`duplicate --${name}`, 'duplicate-flag')
      flags[name] = true
      continue
    }
    if (!valueFlags.has(name)) refuseUsage(`unknown option: --${name}`, 'unknown-option')
    if (Object.hasOwn(flags, name)) refuseUsage(`duplicate --${name}`, 'duplicate-flag')
    const value = argv[index + 1]
    if (value == null || !nonEmptyString(String(value)) || String(value).startsWith('--')) {
      refuseUsage(`--${name} requires a value`, 'missing-value')
    }
    flags[name] = String(value)
    index += 1
  }
  if (positional.length > 0) refuseUsage(`unexpected argument: ${positional[0]}`, 'unexpected-argument')
  if (Object.hasOwn(flags, 'out') && flags.save) refuseUsage('--out and --save are mutually exclusive', 'duplicate-output')
  return flags
}

function compile(flags) {
  if (!flags.checkout) refuseUsage('--checkout <dir> is required', 'missing-checkout')
  const checkout = checkoutDirectory(flags.checkout)
  const profile = probeRepo({
    checkout,
    baseline: flags.baseline === true,
    gh: flags.gh === true,
  })
  const output = Object.hasOwn(flags, 'out')
    ? flags.out
    : (flags.save ? defaultProfilePath({ repoKey: profile.repo_key }) : null)
  if (output) {
    writeProfile({ profile, out: output, checkout })
  } else {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
  }
  return 0
}

export function main(argv = []) {
  try {
    return compile(parseCliArgs(argv))
  } catch (err) {
    if (err instanceof ProbeUsageError || err instanceof ProfileRefusal) {
      process.stderr.write(`${err.message} [reason: ${err.reason}]\n`)
      return 2
    }
    process.stderr.write(`${err && err.stack}\n`)
    return 1
  }
}

const invokedDirectly = import.meta.main
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
