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
// NO CONSUMER IS WIRED IN THIS SLICE: this module proposes the profile only;
// no crew, visualizer, or factory consumer reads it yet (#252).

import {
  createHash,
} from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { slug } from '../../crew/slug.mjs'

export const PROFILE_VERSION = 1
export const LOAD_BEARING = Object.freeze(['test_command', 'default_branch'])
export const STATUSES = Object.freeze(['ratified', 'proposed', 'unknown'])
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

// This is an exported register rather than a hidden blacklist: a future
// consumer can show exactly which heuristic produced a protected-path
// candidate. crew/drive.mjs:44-52 remains hardcoded until a later slice.
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

function runProcess(command, args, { cwd, timeout = 10_000, env } = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      env,
    })
    if (!result || result.error || result.status !== 0) return null
    return String(result.stdout || '').trim()
  } catch {
    return null
  }
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
// origin`, `git config --get`, and `git log --format=%s -n 50`. In
// particular, no `git status` or index-refreshing command is used: the probe
// must not write .git/index or alter the target in any other way.
function gitOutput(root, args) {
  return runProcess('git', ['-C', root, ...args], { cwd: root })
}

function gitRoot(root) {
  const output = gitOutput(root, ['rev-parse', '--show-toplevel'])
  return nonEmptyString(output) ? realpathOr(resolve(output)) : null
}

function remoteRepoKey(root, isGit) {
  if (!isGit) return `local__${slug(basename(root))}`
  const remote = gitOutput(root, ['remote', 'get-url', 'origin'])
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
  // Copied from make-brief.mjs:409-422 (itself copied from
  // crew/realio.mjs:344), rather than imported: that module is a consumer of
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
  if (files.length === 0 && subjects.length === 0) return unknownCell('none_found')
  return proposedCell({
    files,
    commit_style: {
      sampled: subjects.length,
      conventional: subjects.length === 0 ? 0 : conventional.length / subjects.length,
      types,
    },
  }, files.length > 0 ? 'convention markers and git log' : 'git log')
}

function classifyGhFailure(stderr) {
  if (/not been granted|required scopes?|missing (?:the )?scopes?/i.test(stderr)) return 'gh_scope_missing'
  if (/gh auth login|not logged in|authentication token not found|requires authentication|HTTP 401/i.test(stderr)) {
    return 'gh_unauthenticated'
  }
  return 'gh_request_rejected'
}

function runGh(root, fields) {
  let result
  try {
    result = spawnSync(process.env.GH_BIN || 'gh',
      ['repo', 'view', '--json', fields.join(',')],
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

function mergeRatifications(profile, existing) {
  const merged = clone(profile)
  if (!existing || !existing.fields || typeof existing.fields !== 'object') return merged
  for (const [name, oldCell] of Object.entries(existing.fields)) {
    const fresh = merged.fields && merged.fields[name]
    if (!fresh || !validRatifiedCell(oldCell)) continue
    if (deepEqual(oldCell.value, fresh.value)) {
      merged.fields[name] = {
        ...fresh,
        status: 'ratified',
        value: clone(oldCell.value),
        source: oldCell.source || fresh.source,
        ratified_by: oldCell.ratified_by,
        ratified_at: oldCell.ratified_at,
      }
      delete merged.fields[name].superseded_ratification
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

const invokedDirectly = process.argv[1]
  && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
