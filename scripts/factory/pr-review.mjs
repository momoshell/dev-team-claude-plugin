#!/usr/bin/env node
// scripts/factory/pr-review.mjs — resolve one pull request and run a read-only,
// identity-bound review in a disposable worktree.

import { realpathSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = resolve(HERE, '../..')
const CREW = join(CHECKOUT, 'crew', 'crew.mjs')
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const PR_NUMBER = /^(?:0*[1-9][0-9]*)$/
const MAX_BUFFER = 32 * 1024 * 1024

export const PR_REVIEW_REFUSALS = Object.freeze({
  MALFORMED_PR: 'malformed-pr',
  UNKNOWN_PR: 'unknown-pr',
  INVALID_REVIEW_SHA: 'invalid-review-sha',
  WORKTREE_ADD_FAILED: 'worktree-add-failed',
  WORKTREE_REMOVE_FAILED: 'worktree-remove-failed',
  GIT_DIFF_FAILED: 'git-diff-failed',
  REVIEW_INPUT_UNREADABLE: 'review-input-unreadable',
  CREW_FAILED: 'crew-failed',
  TERMINAL_UNREADABLE: 'terminal-unreadable',
  TASK_RETURN_UNREADABLE: 'task-return-unreadable',
  TASK_RETURN_INVALID: 'task-return-invalid',
  TEARDOWN_FAILED: 'teardown-failed',
})

const REFUSAL_NAMES = new Set(Object.values(PR_REVIEW_REFUSALS))

export class PrReviewError extends Error {
  constructor(reason, detail = reason) {
    if (!REFUSAL_NAMES.has(reason)) throw new Error(`unknown PR-review refusal ${JSON.stringify(reason)}`)
    super(`${detail} [${reason}]`)
    this.name = 'PrReviewError'
    this.reason = reason
    this.refusal = reason
    this.detail = detail
  }
}

function refuse(reason, detail) {
  throw new PrReviewError(reason, detail)
}

function textOf(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return String(value)
}

function errorText(value, fallback = 'unknown failure') {
  if (typeof value === 'string' && value.trim()) return value
  if (value && typeof value === 'object') {
    const message = value.message || value.error?.message
    if (typeof message === 'string' && message.trim()) return message
  }
  const text = textOf(value).trim()
  return text || fallback
}

function commandOutput(result) {
  if (typeof result === 'string' || Buffer.isBuffer(result)) return textOf(result)
  if (typeof result?.output === 'string' || Buffer.isBuffer(result?.output)) return textOf(result.output)
  if (typeof result?.stdout === 'string' || Buffer.isBuffer(result?.stdout)) return textOf(result.stdout)
  return ''
}

function commandSucceeded(result) {
  if (typeof result === 'string' || Buffer.isBuffer(result)) return true
  if (!result || result.error || result.signal) return false
  if (result.ok === true && result.status === undefined) return true
  return result.status === 0
}

function commandFailure(result, fallback) {
  return errorText(result?.stderr || result?.error || result?.stdout, result?.status === undefined
    ? fallback
    : `${fallback} (exit ${String(result.status)})`)
}

function defaultSpawn(file, args, options = {}) {
  return spawnSync(file, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || MAX_BUFFER,
  })
}

function normalDeps(deps = {}) {
  const source = deps && typeof deps === 'object' && !Array.isArray(deps) ? deps : {}
  const file = source.file && typeof source.file === 'object' ? source.file : {}
  const checkout = resolve(typeof source.checkout === 'string' && source.checkout.trim() ? source.checkout : process.cwd())
  const spawn = source.spawn || source.spawnSync || defaultSpawn
  const options = (extra = {}) => ({ cwd: checkout, encoding: 'utf8', maxBuffer: MAX_BUFFER, ...extra })
  return {
    ...source,
    checkout,
    tempRoot: typeof source.tempRoot === 'string' && source.tempRoot.trim() ? source.tempRoot : tmpdir(),
    spawn,
    gh: source.gh || ((args, opts) => spawn('gh', args, options(opts))),
    git: source.git || ((args, opts) => spawn('git', args, options(opts))),
    crew: source.crew || ((args, opts) => spawn(process.execPath, [CREW, ...args], options(opts))),
    readFile: source.readFile || source.readFileSync || file.readFile || file.readFileSync || readFileSync,
    writeFile: source.writeFile || source.writeFileSync || file.writeFile || file.writeFileSync || writeFileSync,
    mkdtemp: source.mkdtemp || source.mkdtempSync || file.mkdtemp || file.mkdtempSync || mkdtempSync,
    rmSync: source.rmSync || file.rmSync || rmSync,
    lstatSync: source.lstatSync || file.lstatSync || lstatSync,
    removeWorktree: source.removeWorktree || ((root, worktree) => removeWorktreeDefault(root, worktree, { spawn, rmSync: source.rmSync || file.rmSync || rmSync, lstatSync: source.lstatSync || file.lstatSync || lstatSync })),
    stdout: source.stdout || ((value) => process.stdout.write(value)),
    stderr: source.stderr || ((value) => process.stderr.write(value)),
  }
}

async function invoke(fn, args, options) {
  if (fn.length >= 3) return await fn(options?.cwd, args, options)
  return await fn(args, options)
}

function positivePr(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, `PR number must be a positive decimal integer, got ${JSON.stringify(value)}`)
    return String(value)
  }
  if (typeof value !== 'string' || !PR_NUMBER.test(value)) {
    refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, `PR number must be a positive decimal integer, got ${JSON.stringify(value)}`)
  }
  try {
    if (BigInt(value) <= 0n) refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, `PR number must be positive, got ${JSON.stringify(value)}`)
  } catch {
    refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, `PR number is not a decimal integer: ${JSON.stringify(value)}`)
  }
  return value
}

function parseMainArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--pr') {
    refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'usage: node scripts/factory/pr-review.mjs --pr <positive decimal integer>')
  }
  return positivePr(argv[1])
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
    && !('stdout' in value) && !('output' in value) && !('status' in value)) return value
  return JSON.parse(textOf(value))
}

async function resolvePullRequest(pr, d) {
  let result
  try {
    result = await invoke(d.gh, ['pr', 'view', pr, '--json', 'headRefOid,title,body'], { cwd: d.checkout, encoding: 'utf8' })
  } catch (error) {
    refuse(PR_REVIEW_REFUSALS.UNKNOWN_PR, `gh could not resolve PR ${pr}: ${errorText(error)}`)
  }
  if (!commandSucceeded(result)) {
    refuse(PR_REVIEW_REFUSALS.UNKNOWN_PR, `gh could not resolve PR ${pr}: ${commandFailure(result, 'lookup failed')}`)
  }
  let metadata
  try { metadata = parseJson(commandOutput(result) || result) } catch (error) {
    refuse(PR_REVIEW_REFUSALS.UNKNOWN_PR, `gh returned invalid JSON for PR ${pr}: ${errorText(error)}`)
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    refuse(PR_REVIEW_REFUSALS.UNKNOWN_PR, `gh returned no metadata for PR ${pr}`)
  }
  const head = metadata.headRefOid
  if (typeof head !== 'string' || head.length === 0 || head.trim() === '') {
    refuse(PR_REVIEW_REFUSALS.UNKNOWN_PR, `PR ${pr} has no headRefOid`)
  }
  if (!SHA.test(head)) {
    refuse(PR_REVIEW_REFUSALS.INVALID_REVIEW_SHA, `PR ${pr} headRefOid is not a lowercase 40- or 64-character SHA`)
  }
  return {
    head_sha: head,
    title: typeof metadata.title === 'string' ? metadata.title : '',
    body: typeof metadata.body === 'string' ? metadata.body : '',
  }
}

async function gitText(d, args, reason, detail) {
  let result
  try { result = await invoke(d.git, args, { cwd: d.checkout, encoding: 'utf8', maxBuffer: MAX_BUFFER }) } catch (error) {
    refuse(reason, `${detail}: ${errorText(error)}`)
  }
  if (!commandSucceeded(result)) refuse(reason, `${detail}: ${commandFailure(result, 'git command failed')}`)
  return commandOutput(result)
}

async function resolveBase(head, d) {
  const text = await gitText(d, ['merge-base', head, 'origin/main'], PR_REVIEW_REFUSALS.INVALID_REVIEW_SHA, 'git merge-base could not resolve origin/main')
  const base = text.endsWith('\n') ? text.slice(0, -1) : text
  if (!SHA.test(base)) refuse(PR_REVIEW_REFUSALS.INVALID_REVIEW_SHA, 'git merge-base returned a malformed review base SHA')
  return base
}

/**
 * Parse exactly the NUL-delimited output of `git diff --name-only -z`.
 * Newlines and spaces are pathname data, not separators or padding.
 */
export function parseChangedFiles(output) {
  return textOf(output).split('\0').filter((path) => path.length > 0)
}

function buildBrief({ title, body, diff, skill, rubric, base, head }) {
  return [
    '# Pull-request review',
    '',
    'execution: review_only',
    'profile: code_review',
    `base_sha: ${base}`,
    `head_sha: ${head}`,
    '',
    '## Pull request title',
    title,
    '',
    '## Pull request body',
    body,
    '',
    '## Pull request diff',
    '```diff',
    diff,
    '```',
    '',
    '## Review skill',
    skill,
    '',
    '## Review rubric',
    rubric,
    '',
  ].join('\n')
}

/**
 * Findings are measured from the accepted envelope and changed files from the
 * PR diff. The review variant has no coverage field, so reviewed and
 * unreviewable remain honest unknowns rather than inferred zeros.
 */
export function reportCounts(values, changedFiles) {
  const findings = Array.isArray(values?.findings) ? values.findings.length : null
  const changed = Array.isArray(changedFiles) ? changedFiles.length : null
  return {
    findings: { count: findings, reason: 'review-envelope' },
    changed_files: { count: changed, reason: 'pr-diff' },
    reviewed: { count: null, reason: 'review-envelope-has-no-coverage' },
    unreviewable: { count: null, reason: 'review-envelope-has-no-coverage' },
  }
}

function parseTerminalLine(output) {
  const lines = textOf(output).split(/\r?\n/).filter((line) => line.trim().length > 0)
  const line = lines.at(-1)
  if (!line) refuse(PR_REVIEW_REFUSALS.TERMINAL_UNREADABLE, 'crew run produced no terminal JSON line')
  let terminal
  try { terminal = JSON.parse(line) } catch (error) {
    refuse(PR_REVIEW_REFUSALS.TERMINAL_UNREADABLE, `crew terminal line is not JSON: ${errorText(error)}`)
  }
  const keys = Object.keys(terminal || {}).sort()
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)
    || keys.join(',') !== 'archived,commit,status,task_return'
    || !['done', 'escalation'].includes(terminal.status)
    || typeof terminal.task_return !== 'string' || terminal.task_return.trim() === '') {
    refuse(PR_REVIEW_REFUSALS.TERMINAL_UNREADABLE, 'crew terminal line has an unknown shape or no task_return pointer')
  }
  if (terminal.commit !== null && typeof terminal.commit !== 'string') {
    refuse(PR_REVIEW_REFUSALS.TERMINAL_UNREADABLE, 'crew terminal commit is not null or text')
  }
  if (terminal.archived !== null && typeof terminal.archived !== 'string') {
    refuse(PR_REVIEW_REFUSALS.TERMINAL_UNREADABLE, 'crew terminal archived value is not null or text')
  }
  return terminal
}

function readJsonValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Buffer.isBuffer(raw)) return raw
  return JSON.parse(textOf(raw))
}

async function readTaskEnvelope(pointer, expected, d) {
  let raw
  try { raw = await d.readFile(pointer, 'utf8') } catch (error) {
    refuse(PR_REVIEW_REFUSALS.TASK_RETURN_UNREADABLE, `cannot read task envelope ${pointer}: ${errorText(error)}`)
  }
  let task
  try { task = readJsonValue(raw) } catch (error) {
    refuse(PR_REVIEW_REFUSALS.TASK_RETURN_INVALID, `task envelope ${pointer} is not JSON: ${errorText(error)}`)
  }
  const values = task?.details?.envelope?.values
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || !['done', 'escalation'].includes(task.status)
    || !values || typeof values !== 'object' || Array.isArray(values)
    || typeof values.base !== 'string' || typeof values.head !== 'string'
    || values.base !== expected.base || values.head !== expected.head
    || !['findings', 'no-findings'].includes(values.outcome)
    || !Array.isArray(values.findings)
    || (values.outcome === 'findings' ? values.findings.length === 0 : values.findings.length !== 0)) {
    refuse(PR_REVIEW_REFUSALS.TASK_RETURN_INVALID, `task envelope ${pointer} is not an accepted review envelope`)
  }
  return { task, values }
}

function worktreePaths(output) {
  return textOf(output).split('\0')
    .filter((record) => record.startsWith('worktree '))
    .map((record) => record.slice('worktree '.length))
}

function syncCommand(spawn, file, args, options = {}) {
  return spawn(file, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...options })
}

/**
 * Remove a worktree and prove both sides of removal. A successful git command
 * alone is not evidence: a partial add can leave either a directory or a
 * registration behind.
 */
// Canonical form of a worktree path that may no longer exist: the real path of its parent plus its
// own name. git lists real paths (/private/var on macOS) while resolve() keeps the symlinked form.
export function canonicalWorktreePath(target, realpath = realpathSync) {
  try { return realpath(target) } catch { /* the worktree directory may already be removed */ }
  try { return `${realpath(dirname(target))}/${basename(target)}` } catch { return target }
}

export function removeWorktreeDefault(checkout, worktree, options = {}) {
  const spawn = options.spawn || options.spawnSync || defaultSpawn
  const remove = options.rmSync || rmSync
  const lstat = options.lstatSync || lstatSync
  const target = resolve(worktree)
  const canonicalTarget = canonicalWorktreePath(target, options.realpathSync || realpathSync)
  let removeResult
  let removeUnknown = null
  try {
    removeResult = syncCommand(spawn, 'git', ['-C', checkout, 'worktree', 'remove', '--force', target])
    if (!commandSucceeded(removeResult) && (removeResult?.error || removeResult?.signal || removeResult?.status === null || removeResult?.status === undefined)) {
      removeUnknown = commandFailure(removeResult, 'git worktree remove was not observed to finish')
    }
  } catch (error) {
    removeUnknown = errorText(error, 'git worktree remove could not be spawned')
  }

  let pathError = null
  try { remove(target, { recursive: true, force: true }) } catch (error) { pathError = errorText(error, 'recursive worktree removal failed') }

  let pruneError = null
  try {
    const pruneResult = syncCommand(spawn, 'git', ['-C', checkout, 'worktree', 'prune'])
    if (!commandSucceeded(pruneResult)) pruneError = commandFailure(pruneResult, 'git worktree prune failed')
  } catch (error) { pruneError = errorText(error, 'git worktree prune could not be spawned') }

  let directoryAbsent = false
  try {
    lstat(target)
  } catch (error) {
    directoryAbsent = error?.code === 'ENOENT'
  }

  let registrationAbsent = false
  let registrationError = null
  try {
    const listResult = syncCommand(spawn, 'git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'])
    const listed = commandOutput(listResult)
    const paths = worktreePaths(listed)
    // Empty output is not proof that a registration is absent: the source
    // checkout itself should have produced at least one worktree record.
    if (!commandSucceeded(listResult) || paths.length === 0) {
      registrationError = commandFailure(listResult, 'git worktree list returned no records')
    } else {
      registrationAbsent = paths.every((path) => path !== target && path !== canonicalTarget)
    }
  } catch (error) { registrationError = errorText(error, 'git worktree list could not be spawned') }

  const why = removeUnknown || pathError || pruneError || registrationError
    || (!directoryAbsent ? 'worktree directory still exists' : null)
    || (!registrationAbsent ? 'worktree registration still exists' : null)
  if (why) return { removed: false, why: `worktree-remove-failed: ${why}`, workdir: target }
  return { removed: true, why: null, workdir: target, directory_absent: true, registration_absent: true }
}

function cleanupResult(value, worktree) {
  if (value === true) return { removed: true, why: null, workdir: worktree }
  if (value && typeof value === 'object' && value.removed === true) return { ...value, workdir: value.workdir || worktree }
  return { removed: false, why: value === false ? 'worktree removal returned false' : 'worktree removal did not prove removal', workdir: worktree }
}

async function crewCommand(d, args, worktree) {
  let result
  try { result = await invoke(d.crew, args, { cwd: worktree, encoding: 'utf8', maxBuffer: MAX_BUFFER }) } catch (error) {
    refuse(PR_REVIEW_REFUSALS.CREW_FAILED, `crew ${args[0]} failed: ${errorText(error)}`)
  }
  return result
}

function requireCommandSuccess(result, label) {
  if (!commandSucceeded(result)) refuse(PR_REVIEW_REFUSALS.CREW_FAILED, `${label}: ${commandFailure(result, `${label} failed`)}`)
}

export async function runPrReview(input = {}, maybeDeps = {}) {
  const config = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : { pr: input, deps: maybeDeps }
  const pr = positivePr(config.pr)
  const depConfig = { ...(config.deps || maybeDeps || {}) }
  if (config.checkout !== undefined) depConfig.checkout = config.checkout
  if (config.tempRoot !== undefined) depConfig.tempRoot = config.tempRoot
  const d = normalDeps(depConfig)
  const metadata = await resolvePullRequest(pr, d)
  const base = await resolveBase(metadata.head_sha, d)
  let diff
  let changedFiles
  try {
    diff = await gitText(d, ['diff', `${base}...${metadata.head_sha}`], PR_REVIEW_REFUSALS.GIT_DIFF_FAILED, 'git diff could not read the PR')
    const changedText = await gitText(d, ['diff', '--name-only', '-z', `${base}...${metadata.head_sha}`], PR_REVIEW_REFUSALS.GIT_DIFF_FAILED, 'git diff could not list changed files')
    changedFiles = parseChangedFiles(changedText)
  } catch (error) {
    throw error
  }

  let root = null
  let worktree = null
  let worktreeAttempted = false
  let bootAttempted = false
  let primaryError = null
  let teardownError = null
  let removalError = null
  let report = null
  try {
    root = await d.mkdtemp(join(d.tempRoot, 'pr-review-'))
    if (typeof root !== 'string' || root.trim() === '') refuse(PR_REVIEW_REFUSALS.WORKTREE_ADD_FAILED, 'temporary review root was not allocated')
    worktree = join(root, 'worktree')
    const briefPath = join(root, 'brief.md')
    let skill
    let rubric
    try {
      skill = await d.readFile(join(d.checkout, 'skills/pr-review/SKILL.md'), 'utf8')
      rubric = await d.readFile(join(d.checkout, 'skills/pr-review/references/rubric.md'), 'utf8')
      await d.writeFile(briefPath, buildBrief({ title: metadata.title, body: metadata.body, diff, skill: textOf(skill), rubric: textOf(rubric), base, head: metadata.head_sha }), 'utf8')
    } catch (error) {
      refuse(PR_REVIEW_REFUSALS.REVIEW_INPUT_UNREADABLE, `cannot build the review brief: ${errorText(error)}`)
    }

    worktreeAttempted = true
    let added
    try {
      added = await invoke(d.git, ['worktree', 'add', '--detach', worktree, metadata.head_sha], { cwd: d.checkout, encoding: 'utf8', maxBuffer: MAX_BUFFER })
    } catch (error) {
      refuse(PR_REVIEW_REFUSALS.WORKTREE_ADD_FAILED, `git worktree add failed: ${errorText(error)}`)
    }
    if (!commandSucceeded(added)) refuse(PR_REVIEW_REFUSALS.WORKTREE_ADD_FAILED, `git worktree add failed: ${commandFailure(added, 'git worktree add failed')}`)

    const task = `pr-review-${pr}`
    bootAttempted = true
    requireCommandSuccess(await crewCommand(d, ['boot', '--task', task, '--checkout', worktree, '--roles', 'reviewer', '--profile', 'code_review'], worktree), 'crew boot')
    const runResult = await crewCommand(d, [
      'run', '--task', task, '--checkout', worktree, '--brief-file', briefPath,
      '--execution', 'review_only', '--review-base-sha', base, '--review-head-sha', metadata.head_sha, '--keep',
    ], worktree)
    const terminal = parseTerminalLine(commandOutput(runResult))
    const pointer = resolve(terminal.task_return)
    const accepted = await readTaskEnvelope(pointer, { base, head: metadata.head_sha }, d)
    const counts = reportCounts(accepted.values, changedFiles)
    report = {
      pr: pr,
      title: metadata.title,
      base,
      head: metadata.head_sha,
      outcome: accepted.values.outcome,
      findings: accepted.values.findings,
      changed_files: changedFiles,
      counts,
      terminal_status: terminal.status,
      task_return: pointer,
      brief_file: briefPath,
    }
  } catch (error) {
    primaryError = error instanceof PrReviewError ? error : new PrReviewError(PR_REVIEW_REFUSALS.CREW_FAILED, errorText(error))
  } finally {
    if (bootAttempted) {
      try {
        const teardown = await crewCommand(d, ['teardown', '--task', `pr-review-${pr}`, '--checkout', worktree], worktree)
        requireCommandSuccess(teardown, 'crew teardown')
      } catch (error) {
        teardownError = error instanceof PrReviewError && error.reason === PR_REVIEW_REFUSALS.CREW_FAILED
          ? new PrReviewError(PR_REVIEW_REFUSALS.TEARDOWN_FAILED, error.detail)
          : new PrReviewError(PR_REVIEW_REFUSALS.TEARDOWN_FAILED, errorText(error, 'crew teardown failed'))
      }
    }
    if (worktreeAttempted && worktree) {
      try {
        const result = await d.removeWorktree(d.checkout, worktree)
        const cleaned = cleanupResult(result, worktree)
        if (!cleaned.removed) removalError = new PrReviewError(PR_REVIEW_REFUSALS.WORKTREE_REMOVE_FAILED, cleaned.why)
      } catch (error) {
        removalError = new PrReviewError(PR_REVIEW_REFUSALS.WORKTREE_REMOVE_FAILED, errorText(error, 'worktree removal failed'))
      }
    }
    if (root) {
      try { d.rmSync(root, { recursive: true, force: true }) } catch { /* worktree verification owns the verdict */ }
    }
  }
  if (removalError) throw removalError
  if (teardownError) throw teardownError
  if (primaryError) throw primaryError
  return report
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv && typeof argv === 'object' && !Array.isArray(argv)) {
    const options = argv
    argv = options.argv ?? process.argv.slice(2)
    deps = options.deps ?? deps
  }
  try {
    const pr = parseMainArgs(argv)
    const runner = typeof deps.runPrReview === 'function' ? deps.runPrReview : runPrReview
    const result = await runner({ pr, deps })
    if (typeof deps.stdout === 'function') deps.stdout(`${JSON.stringify(result)}\n`)
    else process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    const reason = error?.reason || PR_REVIEW_REFUSALS.UNKNOWN_PR
    const message = `${reason}: ${errorText(error)}`
    if (typeof deps.stderr === 'function') deps.stderr(`${message}\n`)
    else process.stderr.write(`${message}\n`)
    return 2
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${errorText(error)}\n`)
    process.exitCode = 2
  })
}
