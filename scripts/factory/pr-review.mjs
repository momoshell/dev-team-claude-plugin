#!/usr/bin/env node
// scripts/factory/pr-review.mjs — resolve one pull request and run a read-only,
// identity-bound review in a disposable worktree.

import { createHash } from 'node:crypto'
import { readlinkSync, realpathSync,
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
  HEAD_MOVED: 'head-moved',
  POST_FAILED: 'post-failed',
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

export function parseMainArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'usage: node scripts/factory/pr-review.mjs --pr <positive decimal integer> [--request-changes] [--no-post] [--panel] [--panel-distinct-agents]')
  }
  let pr = null
  let requestChanges = false
  let noPost = false
  let panel = false
  let panelDistinctAgents = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--pr') {
      if (pr !== null) refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'duplicate --pr option')
      const value = argv[++index]
      if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
        refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'missing value for --pr')
      }
      pr = positivePr(value)
    } else if (argument === '--request-changes') {
      if (requestChanges) refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'duplicate --request-changes option')
      requestChanges = true
    } else if (argument === '--no-post') {
      if (noPost) refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'duplicate --no-post option')
      noPost = true
    } else if (argument === '--panel') {
      if (panel) refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'duplicate --panel option')
      panel = true
    } else if (argument === '--panel-distinct-agents') {
      if (panelDistinctAgents) refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'duplicate --panel-distinct-agents option')
      panelDistinctAgents = true
    } else {
      refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, `unknown option: ${String(argument)}`)
    }
  }
  if (pr === null) {
    refuse(PR_REVIEW_REFUSALS.MALFORMED_PR, 'usage: node scripts/factory/pr-review.mjs --pr <positive decimal integer> [--request-changes] [--no-post] [--panel] [--panel-distinct-agents]')
  }
  return { pr, requestChanges, noPost, panel, panelDistinctAgents }
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

function buildBrief({ title, body, diff, skill, rubric, falsification, base, head, panel }) {
  return [
    '# Pull-request review',
    '',
    `execution: ${panel ? 'review_panel' : 'review_only'}`,
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
    '## Falsification and adjudication',
    falsification,
    '',
  ].join('\n')
}

/**
 * Findings and coverage are measured from the accepted envelope; changed files
 * are measured from the PR diff.
 */
export function reportCounts(values, changedFiles) {
  return {
    findings: { count: values.findings.length, reason: 'review-envelope' },
    changed_files: { count: changedFiles.length, reason: 'pr-diff' },
    reviewed_files: { count: values.reviewed_files.length, reason: 'review-envelope' },
    unreviewable_files: { count: values.unreviewable_files.length, reason: 'review-envelope' },
  }
}

export function renderReviewBody(report, verdict) {
  const panelSection = report.panel == null ? {} : { panel: report.panel };
  const payload = {
    schema: 'review_only',
    head: report.head,
    verdict,
    findings: report.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      location: finding.location,
      summary: finding.summary,
      evidence: finding.evidence,
      disposition: finding.disposition,
      ...(finding.vacuity_claim !== undefined ? { vacuity_claim: finding.vacuity_claim } : {}),
    })),
    counts: {
      findings: { count: report.counts.findings.count, reason: report.counts.findings.reason },
      changed_files: { count: report.counts.changed_files.count, reason: report.counts.changed_files.reason },
      reviewed_files: { count: report.counts.reviewed_files.count, reason: report.counts.reviewed_files.reason },
      unreviewable_files: { count: report.counts.unreviewable_files.count, reason: report.counts.unreviewable_files.reason },
    },
    unreviewable_files: report.unreviewable_files.map((row) => ({ path: row.path, reason: row.reason })),
    ...panelSection,
  }
  if (payload.panel) payload.panel = { changed_files: report.panel.changed_files, reviewers: report.panel.reviewers, adjudicator: report.panel.adjudicator, findings: report.panel.findings.map((finding) => ({ id: finding.id, raised_by: finding.raised_by, panel_disposition: finding.panel_disposition, reason: finding.reason })) };
  const canonical = JSON.stringify(payload)
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  const marker = `<!-- review-only:${digest} -->`
  return { body: `${canonical}\n\n${marker}`, marker, payload }
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

const REVIEW_FINDING_FIELDS = Object.freeze(['id', 'severity', 'location', 'summary', 'evidence', 'disposition'])
const REVIEW_FINDING_OPTIONAL_FIELDS = Object.freeze(['vacuity_claim'])
const REVIEW_VACUITY_CLAIMS = new Set(['mutation-survived', 'source-text-only'])
const REVIEW_SEVERITIES = new Set(['must-fix', 'should-fix', 'consider'])
const REVIEW_DISPOSITIONS = new Set(['auto-fix', 'ask-user', 'no-op'])
const REVIEW_UNREVIEWABLE_REASONS = new Set(['binary', 'generated', 'too-large', 'out-of-context'])
const REVIEW_FINDING_ID = /^[A-Za-z0-9_-]{1,64}$/

function hasExactFields(value, fields, optionalFields = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set([...fields, ...optionalFields])
  return fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
    && Reflect.ownKeys(value).every((field) => typeof field === 'string' && allowed.has(field))
}

function acceptedFinding(value) {
  return hasExactFields(value, REVIEW_FINDING_FIELDS, REVIEW_FINDING_OPTIONAL_FIELDS)
    && typeof value.id === 'string' && REVIEW_FINDING_ID.test(value.id)
    && typeof value.severity === 'string' && REVIEW_SEVERITIES.has(value.severity)
    && typeof value.location === 'string'
    && typeof value.summary === 'string'
    && typeof value.evidence === 'string'
    && typeof value.disposition === 'string' && REVIEW_DISPOSITIONS.has(value.disposition)
    && (!Object.prototype.hasOwnProperty.call(value, 'vacuity_claim')
      || (REVIEW_VACUITY_CLAIMS.has(value.vacuity_claim)
        && value.severity === 'must-fix'
        && value.disposition !== 'no-op'))
}

function acceptedUnreviewable(value) {
  return hasExactFields(value, ['path', 'reason'])
    && typeof value.path === 'string' && value.path.length > 0
    && typeof value.reason === 'string' && REVIEW_UNREVIEWABLE_REASONS.has(value.reason)
}

const REVIEW_PANEL_DISPOSITIONS = new Set(['consensus', 'upheld', 'dismissed'])

function acceptedPanelCoverage(value) {
  return hasExactFields(value, ['role', 'reviewed_files', 'unreviewable_files'])
    && typeof value.role === 'string' && value.role.length > 0
    && Array.isArray(value.reviewed_files)
    && value.reviewed_files.every((path) => typeof path === 'string' && path.length > 0)
    && Array.isArray(value.unreviewable_files)
    && value.unreviewable_files.every(acceptedUnreviewable)
}

function acceptedPanelFinding(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string' && value.id.trim().length > 0
    && Array.isArray(value.raised_by) && value.raised_by.length > 0
    && value.raised_by.every((role) => typeof role === 'string' && role.trim().length > 0)
    && typeof value.panel_disposition === 'string' && REVIEW_PANEL_DISPOSITIONS.has(value.panel_disposition)
    && typeof value.reason === 'string' && value.reason.trim().length > 0
}

// The two seats that inspect the diff. The lead adjudicates and is NOT a reviewer.
const PANEL_REVIEWER_ROLES = Object.freeze(['reviewer', 'tech-lead'])
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

/**
 * Panel provenance is a TRUST BOUNDARY, not a shape. A seat can claim any
 * coverage it likes; the only authority for what changed is the PR diff we
 * measured ourselves, and the only authority for which findings are real is
 * the envelope's own top-level findings. Anything a seat asserts beyond those
 * two is fabricated, and this refuses it rather than posting it as measured.
 */
function acceptedPanel(value, changedFiles = null, findingIds = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!Array.isArray(value.changed_files)
    || !value.changed_files.every((path) => typeof path === 'string' && path.length > 0)) return false
  // Exact equality with the measured diff: a claimed file we did not measure is invented.
  if (changedFiles && !sameSet(value.changed_files, changedFiles)) return false
  if (!Array.isArray(value.reviewers) || !value.reviewers.every(acceptedPanelCoverage)) return false
  // Exactly the two reviewer roles, each once. No invented role, no missing seat.
  if (!sameSet(value.reviewers.map((seat) => seat.role), [...PANEL_REVIEWER_ROLES])) return false
  // A seat may only claim to have read a file that actually changed.
  if (!value.reviewers.every((seat) => seat.reviewed_files.every((f) => value.changed_files.includes(f)))) return false
  if (!acceptedPanelCoverage(value.adjudicator) || value.adjudicator.role !== 'lead') return false
  if (!Array.isArray(value.findings) || !value.findings.every(acceptedPanelFinding)) return false
  const ids = value.findings.map((f) => f.id)
  if (new Set(ids).size !== ids.length) return false
  for (const f of value.findings) {
    // raised_by is a CLOSED membership over the two reviewer seats.
    if (!f.raised_by.every((role) => PANEL_REVIEWER_ROLES.includes(role))) return false
    if (new Set(f.raised_by).size !== f.raised_by.length) return false
    // An upheld finding must exist in the actionable findings it claims to be.
    if (findingIds && f.panel_disposition !== 'dismissed' && !findingIds.includes(f.id)) return false
  }
  return true
}

async function readTaskEnvelope(pointer, expected, d, panel = false, changedFiles = null) {
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
    || (values.outcome === 'findings' ? values.findings.length === 0 : values.findings.length !== 0)
    || !values.findings.every(acceptedFinding)
    || !Array.isArray(values.reviewed_files)
    || !values.reviewed_files.every((path) => typeof path === 'string' && path.length > 0)
    || !Array.isArray(values.unreviewable_files)
    || !values.unreviewable_files.every(acceptedUnreviewable)
    || (panel && !acceptedPanel(values.panel, changedFiles, values.findings.map((f) => f.id)))) {
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
// Canonical form of a worktree path that may no longer exist: the real path of the target, or of its
// parent plus its own name. git lists real paths (/private/var on macOS) while resolve() keeps the
// symlinked form. When neither resolves (a symlinked parent that is itself gone), the path is
// UNRESOLVED: the registration git lists may be the real path, so absence cannot be proven.
export function canonicalWorktreePath(target, realpath = realpathSync) {
  const [first] = worktreePathCandidates(target, { realpath })
  return first ?? null
}

// Every path git could list for this worktree, most resolved first. A dangling symlink resolves
// through its own link target, which is what git recorded. An empty list means NOTHING resolved:
// absence cannot be proven, and the caller fails closed.
export function worktreePathCandidates(target, { realpath = realpathSync, readlink = readlinkSync, lstat = lstatSync } = {}) {
  const candidates = []
  const add = (value) => { if (typeof value === "string" && value && !candidates.includes(value)) candidates.push(value) }
  try { add(realpath(target)) } catch { /* the worktree directory may already be removed */ }
  try {
    if (lstat(target).isSymbolicLink()) {
      const link = resolve(dirname(target), readlink(target))
      try { add(realpath(link)) } catch { /* the link target may already be removed */ }
      try { add(`${realpath(dirname(link))}/${basename(link)}`) } catch { /* its parent may be gone too */ }
      add(link)
    }
  } catch { /* not a symlink, or unreadable */ }
  try { add(`${realpath(dirname(target))}/${basename(target)}`) } catch { /* the parent may be gone */ }
  return candidates
}

export function removeWorktreeDefault(checkout, worktree, options = {}) {
  const spawn = options.spawn || options.spawnSync || defaultSpawn
  const remove = options.rmSync || rmSync
  const lstat = options.lstatSync || lstatSync
  const target = resolve(worktree)
  const candidatePaths = worktreePathCandidates(target, {
    realpath: options.realpathSync || realpathSync,
    readlink: options.readlinkSync || readlinkSync,
    lstat: options.lstatSync || lstatSync,
  })
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
      if (candidatePaths.length === 0) {
        registrationError = 'worktree path could not be canonicalized, so its git registration cannot be proven absent'
      } else {
        registrationAbsent = paths.every((path) => path !== target && !candidatePaths.includes(path))
      }
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

function postCommandSucceeded(result) {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result)
    && !Buffer.isBuffer(result) && !result.error && !result.signal && result.status === 0)
}

async function readCurrentReviewState(pr, d) {
  let result
  try {
    result = await invoke(d.gh, ['pr', 'view', pr, '--json', 'headRefOid,reviews'], {
      cwd: d.checkout, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    })
  } catch (error) {
    refuse(PR_REVIEW_REFUSALS.POST_FAILED, `gh could not re-check PR ${pr}: ${errorText(error)}`)
  }
  if (!commandSucceeded(result)) {
    refuse(PR_REVIEW_REFUSALS.POST_FAILED, `gh could not re-check PR ${pr}: ${commandFailure(result, 'lookup failed')}`)
  }
  let current
  try { current = parseJson(commandOutput(result) || result) } catch (error) {
    refuse(PR_REVIEW_REFUSALS.POST_FAILED, `gh returned invalid re-check JSON for PR ${pr}: ${errorText(error)}`)
  }
  const head = current?.headRefOid
  const reviews = current?.reviews
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || typeof head !== 'string' || !SHA.test(head)
    || !Array.isArray(reviews)
    || !reviews.every((review) => review && typeof review === 'object' && !Array.isArray(review)
      && (review.body === undefined || review.body === null || typeof review.body === 'string'))) {
    refuse(PR_REVIEW_REFUSALS.POST_FAILED, `gh returned malformed re-check data for PR ${pr}`)
  }
  return { head_sha: head, reviews }
}

async function postReview(pr, report, config, d) {
  const verdict = config.requestChanges ? 'REQUEST_CHANGES' : 'COMMENT'
  const rendered = renderReviewBody(report, verdict)
  const body = rendered.body
  const marker = rendered.marker
  report = { ...report, verdict }
  if (config.noPost) return { ...report, posted: false, reason: 'no-post', review_body: body }

  const current = await readCurrentReviewState(pr, d)
  if (current.head_sha !== report.head) refuse(PR_REVIEW_REFUSALS.HEAD_MOVED, `PR ${pr} head moved from ${report.head} to ${current.head_sha}`)
  const existingReviews = current.reviews
  if (existingReviews.some((review) => textOf(review?.body).includes(marker))) return { ...report, posted: false, reason: 'already-posted', review_body: body }

  const reviewFlag = verdict === 'REQUEST_CHANGES' ? '--request-changes' : '--comment'
  let result
  try {
    result = await invoke(d.gh, ['pr', 'review', pr, reviewFlag, '--body', body], {
      cwd: d.checkout, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    })
  } catch (error) {
    refuse(PR_REVIEW_REFUSALS.POST_FAILED, `gh pr review failed: ${errorText(error)}`)
  }
  if (!postCommandSucceeded(result)) {
    refuse(PR_REVIEW_REFUSALS.POST_FAILED, `gh pr review failed: ${commandFailure(result, 'review command did not complete successfully')}`)
  }
  return { ...report, posted: true, review_body: body }
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
    let falsification
    try {
      skill = await d.readFile(join(d.checkout, 'skills/pr-review/SKILL.md'), 'utf8')
      rubric = await d.readFile(join(d.checkout, 'skills/pr-review/references/rubric.md'), 'utf8')
      falsification = await d.readFile(join(d.checkout, 'skills/pr-review/references/falsification.md'), 'utf8')
      await d.writeFile(briefPath, buildBrief({ title: metadata.title, body: metadata.body, diff, skill: textOf(skill), rubric: textOf(rubric), falsification: textOf(falsification), base, head: metadata.head_sha, panel: config.panel === true }), 'utf8')
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
    const bootArgs = config.panel
      ? ['boot', '--task', task, '--checkout', worktree, '--roles', 'reviewer,tech-lead,lead', '--profile', 'code_review']
      : ['boot', '--task', task, '--checkout', worktree, '--roles', 'reviewer', '--profile', 'code_review']
    if (config.panelDistinctAgents) bootArgs.push('--panel-distinct-agents')
    requireCommandSuccess(await crewCommand(d, bootArgs, worktree), 'crew boot')
    const runArgs = config.panel
      ? ['run', '--task', task, '--checkout', worktree, '--brief-file', briefPath, '--execution', 'review_panel', '--review-base-sha', base, '--review-head-sha', metadata.head_sha, '--keep']
      : ['run', '--task', task, '--checkout', worktree, '--brief-file', briefPath, '--execution', 'review_only', '--review-base-sha', base, '--review-head-sha', metadata.head_sha, '--keep']
    const runResult = await crewCommand(d, runArgs, worktree)
    const terminal = parseTerminalLine(commandOutput(runResult))
    if (terminal.status === 'escalation') {
      const escalationPointer = resolve(terminal.task_return)
      let escalationTask = null
      try { escalationTask = readJsonValue(await d.readFile(escalationPointer, 'utf8')) } catch { escalationTask = null }
      const failure = escalationTask?.details?.panel?.failure
      const escalationReason = failure?.reason || escalationTask?.details?.reason || 'escalation'
      const escalationSeat = failure?.seat || escalationTask?.details?.seat || null
      refuse(PR_REVIEW_REFUSALS.CREW_FAILED, `panel refusal ${escalationReason}${escalationSeat ? ` (${escalationSeat})` : ''}`)
    }
    const pointer = resolve(terminal.task_return)
    const accepted = await readTaskEnvelope(pointer, { base, head: metadata.head_sha }, d, config.panel === true, changedFiles)
    const counts = reportCounts(accepted.values, changedFiles)
    report = {
      pr: pr,
      title: metadata.title,
      base,
      head: metadata.head_sha,
      outcome: accepted.values.outcome,
      findings: accepted.values.findings,
      reviewed_files: accepted.values.reviewed_files,
      unreviewable_files: accepted.values.unreviewable_files,
      changed_files: changedFiles,
      counts,
      panel: config.panel === true ? (accepted.values.panel ?? null) : null,
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
  if (primaryError) throw primaryError
  if (removalError) throw removalError
  if (teardownError) throw teardownError
  return postReview(pr, report, config, d)
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv && typeof argv === 'object' && !Array.isArray(argv)) {
    const options = argv
    argv = options.argv ?? process.argv.slice(2)
    deps = options.deps ?? deps
  }
  try {
    const config = parseMainArgs(argv)
    const runner = typeof deps.runPrReview === 'function' ? deps.runPrReview : runPrReview
    const result = await runner({ ...config, deps })
    if (config.noPost) {
      if (typeof result?.review_body !== 'string') refuse(PR_REVIEW_REFUSALS.POST_FAILED, 'render-only review body is unavailable')
      if (typeof deps.stdout === 'function') deps.stdout(`${result.review_body}\n`)
      else process.stdout.write(`${result.review_body}\n`)
    } else if (typeof deps.stdout === 'function') deps.stdout(`${JSON.stringify(result)}\n`)
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
