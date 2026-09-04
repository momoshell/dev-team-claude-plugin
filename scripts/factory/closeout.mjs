#!/usr/bin/env node
// scripts/factory/closeout.mjs — one measured closeout entry point (#758).
// Every operation is a named step. A refusal stops the sequence before a later
// operation can turn an incomplete observation into a destructive action.

import {
  cpSync as fsCpSync,
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  mkdtempSync as fsMkdtempSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import {
  collectAnchorPins,
  crewJsonPath,
  TEARDOWN_PROVEN,
  teardownVerdict,
} from './dispatch-batch.mjs'
import { parseSuiteCounts } from '../../crew/drive.mjs'

export const CLOSEOUT_VERBS = Object.freeze(['merge-check', 'reap', 'recover'])
export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2
export const STEP_EVENT = 'closeout-step'
export const STEP_OUTCOMES = Object.freeze({ OK: 'ok', REFUSED: 'refused' })
export const MERGE_CHECK_STEPS = Object.freeze(['pr-open', 'scratch-worktree', 'merge', 'suite', 'anchor-repair', 'report'])
export const REAP_STEPS = Object.freeze(['pr-merged', 'issues', 'worktree', 'branch', 'prune', 'archive'])
export const RECOVER_STEPS = Object.freeze(['quiet', 'preserve', 'teardown', 'verify', 'closeout'])
export const QUIET_READS = 2
export const QUIET_GAP_MS = 10_000
export const ARCHIVE_MARK = '.archive-'
export const RECOVERY_COPY_SUFFIX = '.recovery-copy'
export const ROT_MARK = 'this is rot, not a shift'
export const AMBIGUOUS_MARK = 'a repair refuses to guess'
export const REPAIRED_PREFIX = 'repaired '
export const REFUSED_PREFIX = 'refused '
export const MERGED_STATE = 'MERGED'
export const REFS_PATTERN = /^Refs:?\s+(.*)$/
export const ENVELOPE_RE = /^d(\d+)\.([a-z-]+)\.json$/
export const ENVELOPE_REFUSED = 'envelope-present-but-refused'
export const ENVELOPE_ACCEPTED = 'envelope-accepted'
export const ENVELOPE_ABSENT = 'envelope-absent'
export const CLOSEOUT_REFUSALS = Object.freeze({
  USAGE: 'usage',
  PR_UNREADABLE: 'pr-unreadable',
  PR_NOT_OPEN: 'pr-not-open',
  PR_NOT_MERGED: 'pr-not-merged',
  MERGE_CONFLICT: 'merge-conflict',
  SUITE_RED: 'suite-red',
  ANCHOR_ROT: 'anchor-rot',
  ANCHOR_AMBIGUOUS: 'anchor-ambiguous',
  ISSUE_CLOSE_FAILED: 'issue-close-failed',
  WORKTREE_FAILED: 'worktree-failed',
  BRANCH_FAILED: 'branch-failed',
  ARCHIVE_FAILED: 'archive-failed',
  TREE_NOT_QUIET: 'tree-not-quiet',
  PRESERVE_FAILED: 'preserve-failed',
  TEARDOWN_UNPROVEN: 'teardown-unproven',
  CREW_UNREADABLE: 'crew-unreadable',
  FENCE_ABSENT: 'fence-absent',
  REBASE_FAILED: 'rebase-failed',
  GATE_RED: 'gate-red',
  COLD_VERIFY_FAILED: 'cold-verify-failed',
  INTERNAL: 'internal',
})

export class CloseoutRefusal extends Error {
  constructor(message, reason, step) {
    super(message)
    this.name = 'CloseoutRefusal'
    this.reason = reason
    this.step = step
  }
}

export class CloseoutUsageError extends Error {
  constructor(message, reason = CLOSEOUT_REFUSALS.USAGE) {
    super(message)
    this.name = 'CloseoutUsageError'
    this.reason = reason
  }
}

function refuse(message, reason, step) {
  throw new CloseoutRefusal(message, reason, step)
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

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* synchronous fallback for hosts without Atomics.wait */ }
  }
}

export function normalDeps(deps = {}) {
  const d = {
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    readdirSync: deps.readdirSync || fsReaddirSync,
    statSync: deps.statSync || fsStatSync,
    mkdirSync: deps.mkdirSync || fsMkdirSync,
    mkdtempSync: deps.mkdtempSync || fsMkdtempSync,
    cpSync: deps.cpSync || fsCpSync,
    renameSync: deps.renameSync || fsRenameSync,
    rmSync: deps.rmSync || fsRmSync,
    spawn: deps.spawn || ((options) => spawnSync(options.file, options.args, { cwd: options.cwd, env: options.env, encoding: 'utf8' })),
    newest: deps.newest || newestMtime,
    now: deps.now || (() => Date.now()),
    sleep: deps.sleep || sleepSync,
    home: deps.home || homedir(),
    log: deps.log || ((line) => process.stdout.write(`${line}\n`)),
  }
  return d
}

// Copied from scripts/factory/make-brief.mjs:783 rather than imported: this
// factory boundary keeps the child-environment rule local to closeout.
export function colourNeutralEnv(base = process.env) {
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  env.NO_COLOR = '1'
  return env
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '')
}

// Keep this run-log loop as the single convention used by all three verbs.
export function runSteps({ verb, lane, steps, deps } = {}) {
  const d = normalDeps(deps)
  const lines = []
  let refusal = null
  for (const step of Array.isArray(steps) ? steps : []) {
    const started = d.now()
    let outcome = STEP_OUTCOMES.OK
    let reason = null
    let detail = null
    try { detail = step.run() ?? null } catch (err) {
      refusal = err instanceof CloseoutRefusal ? err : new CloseoutRefusal(err?.message || String(err), CLOSEOUT_REFUSALS.INTERNAL, step.name)
      outcome = STEP_OUTCOMES.REFUSED
      reason = refusal.reason
    }
    const row = {
      event: STEP_EVENT, verb, lane, step: step.name,
      ms: d.now() - started,
      outcome, reason, detail,
    }
    lines.push(row)
    d.log(JSON.stringify(row))
    if (outcome === STEP_OUTCOMES.REFUSED) break
  }
  return { lines, refusal }
}

export function refsFromPrBody(text) {
  const refs = []
  for (const line of String(text || '').split('\n')) {
    const match = REFS_PATTERN.exec(line)
    if (!match) continue
    for (const ref of match[1].matchAll(/#(\d+)/g)) {
      const number = Number(ref[1])
      if (!refs.includes(number)) refs.push(number)
    }
  }
  return refs
}

export function parseRepairOutput(stdout) {
  const repairs = []
  const refusals = []
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim()
    if (line.startsWith(REPAIRED_PREFIX)) {
      const value = line.slice(REPAIRED_PREFIX.length)
      const at = value.indexOf(' -> ')
      if (at > 0 && at < value.length - 4) {
        repairs.push({ key: value.slice(0, at), nextKey: value.slice(at + 4) })
      }
      continue
    }
    if (line.startsWith(REFUSED_PREFIX)) refusals.push(line.slice(REFUSED_PREFIX.length))
  }
  return { repairs, refusals }
}

export function classifyRepairRefusals(refusals) {
  const rot = []
  const ambiguous = []
  const other = []
  for (const refusal of Array.isArray(refusals) ? refusals : []) {
    const text = String(refusal)
    if (text.includes(ROT_MARK)) rot.push(text)
    else if (text.includes(AMBIGUOUS_MARK)) ambiguous.push(text)
    else other.push(text)
  }
  return { rot, ambiguous, other }
}

export function archiveName(base, at) {
  return `${base}${ARCHIVE_MARK}${at.replaceAll(':', '-').replaceAll('.', '-')}`
}

export function newestMtime(dir, deps = {}) {
  const d = normalDeps(deps)
  let newest = null
  const walk = (current) => {
    const entries = d.readdirSync(current, { withFileTypes: true })
    for (const raw of entries) {
      const name = typeof raw === 'string' ? raw : raw?.name
      if (typeof name !== 'string') continue
      const path = join(current, name)
      const directory = typeof raw?.isDirectory === 'function' && raw.isDirectory()
      if (directory) {
        walk(path)
        continue
      }
      const stat = d.statSync(path)
      const mtime = Number(stat?.mtimeMs)
      if (!Number.isFinite(mtime)) throw new Error(`unreadable mtime for ${path}`)
      if (newest === null || mtime > newest) newest = mtime
    }
  }
  try {
    walk(dir)
    return newest
  } catch {
    return null
  }
}

export function quietProbe({ dirs, deps } = {}) {
  const d = normalDeps(deps)
  const paths = Array.isArray(dirs) ? dirs : []
  const reads = []
  let interrupted = false
  for (let index = 0; index < QUIET_READS; index += 1) {
    const tuple = paths.map((dir) => {
      try {
        const value = d.newest(dir, d)
        return value == null ? null : value
      } catch {
        return null
      }
    })
    reads.push(tuple)
    if (index < QUIET_READS - 1) {
      try { d.sleep(QUIET_GAP_MS) } catch { interrupted = true }
    }
  }
  const unknown = interrupted || reads.some((tuple) => tuple.some((value) => value === null))
  const first = reads[0] || []
  const quiet = !unknown && reads.every((tuple) => tuple.length === first.length && tuple.every((value, index) => value === first[index]))
  return { quiet, reads, unknown }
}

function absentEnvelope() {
  return {
    present: false,
    file: null,
    expected_id: null,
    assignment_id: null,
    status: null,
    mutations: null,
    verdict: ENVELOPE_ABSENT,
    path: null,
  }
}

export function envelopeReport({ returnsDir, escalationWhy, deps } = {}) {
  const d = normalDeps(deps)
  let names
  try { names = d.readdirSync(returnsDir) } catch { return absentEnvelope() }
  const candidates = []
  for (const raw of Array.isArray(names) ? names : []) {
    const name = typeof raw === 'string' ? raw : raw?.name
    if (typeof name !== 'string') continue
    const match = ENVELOPE_RE.exec(name)
    if (match) candidates.push({ name, number: Number(match[1]) })
  }
  if (candidates.length === 0) return absentEnvelope()
  candidates.sort((a, b) => a.number - b.number || (a.name < b.name ? -1 : 1))
  const selected = candidates[candidates.length - 1]
  const path = join(returnsDir, selected.name)
  const expected_id = `d${selected.number}`
  let parsed = null
  try { parsed = JSON.parse(textOf(d.readFileSync(path, 'utf8'))) } catch { parsed = null }
  const assignment_id = typeof parsed?.assignment_id === 'string' ? parsed.assignment_id : null
  const status = typeof parsed?.status === 'string' ? parsed.status : null
  const mutations = Array.isArray(parsed?.details?.mutations) ? parsed.details.mutations.length : null
  return {
    present: true,
    file: selected.name,
    expected_id,
    assignment_id,
    status,
    mutations,
    verdict: assignment_id === expected_id ? ENVELOPE_ACCEPTED : ENVELOPE_REFUSED,
    path,
  }
}

const BATCH_UNKNOWN = '<batch-dir UNKNOWN: no boot brief row in journal.jsonl>'
const FENCES_UNKNOWN = '<fences UNKNOWN: no fences.json under the batch dir>'

export function adoptCommandLine({ lane, archive, batchDir, fencesPath } = {}) {
  const batch = typeof batchDir === 'string' && batchDir.trim() ? batchDir : BATCH_UNKNOWN
  const fences = typeof fencesPath === 'string' && fencesPath.trim() ? fencesPath : FENCES_UNKNOWN
  return `node scripts/factory/dispatch-batch.mjs --batch ${batch} --fences ${fences} --adopt ${lane}=${archive}`
}

function safeJson(path, d) {
  try { return JSON.parse(textOf(d.readFileSync(path, 'utf8'))) } catch { return null }
}

function runCommand(options, d) {
  try { return d.spawn(options) } catch (error) { return { status: null, error, stdout: '', stderr: '' } }
}

function commandOk(result) {
  return Boolean(result && result.status === 0)
}

function prView({ lane, checkout, deps, step = 'pr-open' }) {
  const d = normalDeps(deps)
  const result = runCommand({
    file: 'gh',
    args: ['pr', 'view', lane, '--json', 'number,state,headRefName,body'],
    cwd: checkout,
  }, d)
  if (!commandOk(result)) refuse(`cannot read PR for ${lane}: ${childFailure(result)}`, CLOSEOUT_REFUSALS.PR_UNREADABLE, step)
  let pr
  try { pr = JSON.parse(textOf(result.stdout)) } catch (error) {
    refuse(`cannot parse PR for ${lane}: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.PR_UNREADABLE, step)
  }
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    refuse(`cannot parse PR for ${lane}: response is not an object`, CLOSEOUT_REFUSALS.PR_UNREADABLE, step)
  }
  pr.lane = lane
  pr.checkout = checkout
  return pr
}

function mergeOne({ lane, scratch, deps }) {
  const d = normalDeps(deps)
  const result = runCommand({ file: 'git', args: ['merge', '--no-ff', '--no-edit', lane], cwd: scratch }, d)
  if (!commandOk(result)) refuse(`merge failed for ${lane}: ${childFailure(result)}`, CLOSEOUT_REFUSALS.MERGE_CONFLICT, 'merge')
  return { lane, merged: true }
}

function suiteCommand(cwd) {
  return {
    file: 'node',
    args: ['--test', '--test-reporter=tap', '--test-timeout=30000', '**/*.test.mjs'],
    cwd,
    env: colourNeutralEnv(),
  }
}

function runSuite({ cwd, deps, reason = CLOSEOUT_REFUSALS.SUITE_RED, step = 'suite' }) {
  const d = normalDeps(deps)
  const result = runCommand(suiteCommand(cwd), d)
  const suite = parseSuiteCounts(stripAnsi(textOf(result?.stdout)))
  if (!commandOk(result) || !suite || suite.fail > 0) {
    refuse(`suite failed in ${cwd}: ${suite ? JSON.stringify(suite) : childFailure(result)}`, reason, step)
  }
  return suite
}

const removeScratch = ({ scratch, checkout, deps: d }) => d.spawn({ file: 'git', args: ['worktree', 'remove', '--force', scratch], cwd: checkout })

export function mergeCheck({ lanes, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const batch = Array.isArray(lanes) ? lanes : []
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const prs = new Map()
  let scratch = null
  const report = { merged: 0, suite: null, pins_moved: [], refusals: [] }
  const runners = {
    'pr-open': () => {
      for (const lane of batch) {
        const pr = prView({ lane, checkout: root, deps: d })
        if (pr.state !== 'OPEN') refuse(`PR for ${lane} is ${JSON.stringify(pr.state)}, expected OPEN`, CLOSEOUT_REFUSALS.PR_NOT_OPEN, 'pr-open')
        prs.set(lane, pr)
      }
      return { prs: batch.length }
    },
    'scratch-worktree': () => {
      try { scratch = d.mkdtempSync(join(tmpdir(), 'closeout-scratch-')) } catch (error) {
        refuse(`cannot create scratch worktree: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.WORKTREE_FAILED, 'scratch-worktree')
      }
      const result = runCommand({ file: 'git', args: ['worktree', 'add', '--detach', scratch, 'origin/main'], cwd: root }, d)
      if (!commandOk(result)) refuse(`scratch worktree creation failed: ${childFailure(result)}`, CLOSEOUT_REFUSALS.WORKTREE_FAILED, 'scratch-worktree')
      return { scratch }
    },
    merge: () => {
      // Keep the complete batch: a scratch merge that omits a lane is not a merge-check.
      for (const lane of batch) mergeOne({ lane, scratch, deps: d })
      report.merged = batch.length
      return { merged: batch.length }
    },
    suite: () => {
      report.suite = runSuite({ cwd: scratch, deps: d })
      return { suite: report.suite }
    },
    'anchor-repair': () => {
      // The manifest set is enumerated from checkout, not scratch, because it is the operator's tree of record.
      const pins = collectAnchorPins({ checkout: root, deps: d })
      const moved = []
      const refusals = []
      for (const manifest of pins.manifests) {
        const dir = dirname(manifest)
        const result = runCommand({
          file: 'node',
          args: [join(scratch, 'skills/qa-test-writing/anchor-pin.mjs'), '--repair-all', join(scratch, dir), '--root', scratch],
          cwd: scratch,
        }, d)
        const output = `${textOf(result?.stdout)}${result?.stderr ? `\n${textOf(result.stderr)}` : ''}`
        const parsed = parseRepairOutput(output)
        for (const repair of parsed.repairs) moved.push({ dir, key: repair.key, nextKey: repair.nextKey })
        refusals.push(...parsed.refusals)
        if (!commandOk(result) && parsed.refusals.length === 0) refusals.push(childFailure(result))
      }
      report.pins_moved = moved
      report.refusals = refusals
      const blocking = classifyRepairRefusals(refusals)
      if (blocking.rot.length > 0 || blocking.ambiguous.length > 0) refuse(blocking.rot.length > 0 ? blocking.rot.join('; ') : blocking.ambiguous.join('; '), blocking.rot.length > 0 ? CLOSEOUT_REFUSALS.ANCHOR_ROT : CLOSEOUT_REFUSALS.ANCHOR_AMBIGUOUS, 'anchor-repair')
      return { pins_moved: moved, refusals }
    },
    report: () => ({ merged: report.merged, suite: report.suite, pins_moved: report.pins_moved, refusals: report.refusals }),
  }
  let run
  try {
    const steps = MERGE_CHECK_STEPS.map((name) => ({ name, run: runners[name] }))
    run = runSteps({ verb: 'merge-check', lane: batch.join(','), steps, deps: d })
  } catch (error) {
    run = { lines: [], refusal: error instanceof CloseoutRefusal ? error : new CloseoutRefusal(error?.message || String(error), CLOSEOUT_REFUSALS.INTERNAL, 'merge-check') }
  } finally {
    if (scratch) {
      try { removeScratch({ scratch, checkout: root, deps: d }) } catch { /* cleanup is best effort; the refusal remains the measured result */ }
    }
  }
  const refusal = refusalObject(run.refusal)
  return { verb: 'merge-check', lanes: batch, scratch, lines: run.lines, refusal, report, code: refusal ? 1 : 0 }
}

function refusalObject(error) {
  if (!error) return null
  return { reason: error.reason || CLOSEOUT_REFUSALS.INTERNAL, step: error.step || null, message: error.message || String(error) }
}

const closeComment = (lane, pr) => `closed by ${lane} in PR #${pr.number} (reaped by scripts/factory/closeout.mjs)`

function closeIssue({ issue, lane, pr, deps }) {
  const d = normalDeps(deps)
  const comment = closeComment(lane, pr)
  const result = runCommand({ file: 'gh', args: ['issue', 'close', String(issue), '--comment', comment], cwd: pr.checkout }, d)
  if (!commandOk(result)) refuse(`could not close issue #${issue} for ${pr.lane}: ${childFailure(result)}`, CLOSEOUT_REFUSALS.ISSUE_CLOSE_FAILED, 'issues')
  return { issue, closed: true }
}

function gitStep({ args, cwd, reason, step, deps, message }) {
  const d = normalDeps(deps)
  const result = runCommand({ file: 'git', args, cwd }, d)
  if (!commandOk(result)) refuse(message || `${args.join(' ')} failed: ${childFailure(result)}`, reason, step)
  return { args, cwd }
}

function archiveRecoveryCopies({ lane, checkout, deps }) {
  const d = normalDeps(deps)
  const root = dirname(dirname(crewJsonPath({ checkout, lane, deps: d })))
  let entries
  try { entries = d.readdirSync(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return { archived: [], root, unknown: false }
    refuse(`cannot read crew archive root ${root}: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.ARCHIVE_FAILED, 'archive')
  }
  const isoValue = d.now()
  const iso = typeof isoValue === 'string' ? isoValue : new Date(Number(isoValue)).toISOString()
  const archived = []
  for (const raw of Array.isArray(entries) ? entries : []) {
    const name = typeof raw === 'string' ? raw : raw?.name
    if (typeof name !== 'string' || !name.endsWith(RECOVERY_COPY_SUFFIX) || name.includes(ARCHIVE_MARK)) continue
    if (raw && typeof raw.isDirectory === 'function' && !raw.isDirectory()) continue
    const from = join(root, name)
    const to = archiveName(from.slice(0, -RECOVERY_COPY_SUFFIX.length), iso) + RECOVERY_COPY_SUFFIX
    // This module contains no rmSync call whose path is under the crew root.
    try { d.renameSync(from, to) } catch (error) {
      refuse(`could not archive recovery copy ${from}: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.ARCHIVE_FAILED, 'archive')
    }
    archived.push({ from, to })
  }
  return { archived, root, unknown: false }
}

export function reap({ lanes, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const batch = Array.isArray(lanes) ? lanes : []
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const lines = []
  const laneReports = []
  const summary = { lanes: laneReports, issues: [], archived: [] }
  let refusal = null
  for (const lane of batch) {
    const laneDir = join(dirname(root), `dt-${lane}`)
    const laneReport = { lane, issues: [], archived: [] }
    let pr = null
    const runners = {
      'pr-merged': () => {
        pr = prView({ lane, checkout: root, deps: d, step: 'pr-merged' })
        if (pr.state !== MERGED_STATE) refuse(`PR for ${lane} is ${JSON.stringify(pr.state)}, expected ${MERGED_STATE}`, CLOSEOUT_REFUSALS.PR_NOT_MERGED, 'pr-merged')
        return { number: pr.number, state: pr.state }
      },
      issues: () => {
        const refs = refsFromPrBody(pr.body)
        for (const issue of refs) closeIssue({ issue, lane, pr, deps: d })
        laneReport.issues = refs
        return { issues: refs }
      },
      worktree: () => gitStep({ args: ['worktree', 'remove', laneDir], cwd: root, reason: CLOSEOUT_REFUSALS.WORKTREE_FAILED, step: 'worktree', deps: d, message: `worktree removal failed for ${lane}` }),
      branch: () => gitStep({ args: ['branch', '-d', lane], cwd: root, reason: CLOSEOUT_REFUSALS.BRANCH_FAILED, step: 'branch', deps: d, message: `branch deletion failed for ${lane}` }),
      prune: () => gitStep({ args: ['worktree', 'prune'], cwd: root, reason: CLOSEOUT_REFUSALS.WORKTREE_FAILED, step: 'prune', deps: d, message: `worktree prune failed for ${lane}` }),
      archive: () => {
        const archived = archiveRecoveryCopies({ lane, checkout: laneDir, deps: d })
        laneReport.archived = archived.archived
        return archived
      },
    }
    const run = runSteps({ verb: 'reap', lane, steps: REAP_STEPS.map((name) => ({ name, run: runners[name] })), deps: d })
    lines.push(...run.lines)
    laneReports.push(laneReport)
    summary.issues.push(...laneReport.issues)
    summary.archived.push(...laneReport.archived)
    if (run.refusal) {
      refusal = refusalObject(run.refusal)
      break
    }
  }
  return { verb: 'reap', lanes: batch, lines, refusal, report: summary, code: refusal ? 1 : 0 }
}

function fallbackLaneDir({ lane, checkout, crew }) {
  return typeof crew?.checkout === 'string' && crew.checkout.trim() ? crew.checkout : join(dirname(checkout), `dt-${lane}`)
}

function pgrepFallback({ lane, verdict, deps }) {
  const d = normalDeps(deps)
  const result = runCommand({ file: 'pgrep', args: ['-f', lane], cwd: process.cwd() }, d)
  const stdout = textOf(result?.stdout).trim()
  // The documented closeout CLI matches its own argv; only another PID is live evidence.
  const pids = stdout.split(/\s+/).filter(Boolean).filter((pid) => pid !== String(process.pid))
  if (pids.length > 0) refuse(`teardown for ${lane} remains unproven (${verdict.why}); pgrep found ${pids.join(' ')}`, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN, 'teardown')
  if ((result?.status === 1 && stdout === '') || (result?.status === 0 && stdout !== '')) return { ...verdict, proven: false, pgrep: 'clear' }
  refuse(`teardown for ${lane} remains unproven (${verdict.why}); pgrep result was not a measured clear`, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN, 'teardown')
}

function readCrew({ crewDir, lane, deps }) {
  const d = normalDeps(deps)
  const path = join(crewDir, 'crew.json')
  let crew
  try { crew = JSON.parse(textOf(d.readFileSync(path, 'utf8'))) } catch (error) {
    refuse(`cannot read crew.json for ${lane}: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.CREW_UNREADABLE, 'verify')
  }
  if (!crew || typeof crew !== 'object' || Array.isArray(crew) || crew.lane_name !== lane) {
    refuse(`crew lane_name is not ${lane}`, CLOSEOUT_REFUSALS.CREW_UNREADABLE, 'verify')
  }
  return crew
}

function teardownArchive(result) {
  let payload = null
  for (const line of String(result?.stdout ?? '').split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try { payload = JSON.parse(text) } catch { /* a non-payload line is not the teardown's archive locator */ }
  }
  return typeof payload?.archived === 'string' && payload.archived.trim() ? payload.archived.trim() : null
}

function stateDirAfterTeardown({ lane, result, crewDir, deps }) {
  const d = normalDeps(deps)
  let originalExists
  try { originalExists = d.existsSync(crewDir) } catch (error) {
    refuse(`cannot inspect crew state for ${lane} after teardown: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN, 'teardown')
  }
  if (originalExists) return crewDir
  const archived = teardownArchive(result)
  if (!archived || !archived.startsWith(`${crewDir}${ARCHIVE_MARK}`)) {
    refuse(`teardown for ${lane} removed ${crewDir} without a matching archive locator`, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN, 'teardown')
  }
  let archiveExists
  try { archiveExists = d.existsSync(archived) } catch (error) {
    refuse(`cannot inspect archived crew state for ${lane}: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN, 'teardown')
  }
  if (!archiveExists) refuse(`cannot confirm archived crew state for ${lane} at ${archived}`, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN, 'teardown')
  return archived
}

function teardownLane({ lane, checkout, crewDir, deps }) {
  const d = normalDeps(deps)
  const crew = readCrew({ crewDir, lane, deps: d })
  const laneDir = fallbackLaneDir({ lane, checkout, crew })
  const result = runCommand({ file: 'node', args: ['crew/crew.mjs', 'teardown', '--task', lane, '--checkout', laneDir], cwd: checkout }, d)
  const verdict = teardownVerdict(result)
  const evidence = verdict.verdict !== TEARDOWN_PROVEN ? pgrepFallback({ lane, verdict, deps: d }) : verdict
  const stateDir = stateDirAfterTeardown({ lane, result, crewDir, deps: d })
  return { ...evidence, laneDir, stateDir }
}

function gitOutput({ args, cwd, deps }) {
  const d = normalDeps(deps)
  const result = runCommand({ file: 'git', args, cwd }, d)
  return {
    result,
    value: commandOk(result) ? textOf(result.stdout).trim() : null,
    error: commandOk(result) ? null : childFailure(result),
  }
}

function batchInfo({ crewDir, deps }) {
  const d = normalDeps(deps)
  let rows
  try {
    rows = textOf(d.readFileSync(join(crewDir, 'journal.jsonl'), 'utf8')).split('\n').map((line) => {
      try { return line.trim() ? JSON.parse(line) : null } catch { return null }
    }).filter(Boolean)
  } catch {
    rows = []
  }
  const boot = rows.find((row) => row?.event === 'boot' && typeof row.brief === 'string' && row.brief.trim())
  const batchDir = boot ? dirname(dirname(boot.brief)) : null
  let fencesPath = null
  if (batchDir) {
    try {
      if (d.existsSync(join(batchDir, 'fences.json'))) fencesPath = join(batchDir, 'fences.json')
    } catch { fencesPath = null }
  }
  return {
    batch_dir: batchDir || BATCH_UNKNOWN,
    fences: fencesPath || FENCES_UNKNOWN,
  }
}

export function adoptReadyReport({ lane, report, deps }) {
  const d = normalDeps(deps)
  const archive = typeof report?.archive === 'string' && report.archive.trim()
    ? report.archive
    : `${report.crew_dir}${RECOVERY_COPY_SUFFIX}`
  const info = batchInfo({ crewDir: report.crew_dir, deps: d })
  const command = adoptCommandLine({ lane, archive, batchDir: info.batch_dir === BATCH_UNKNOWN ? null : info.batch_dir, fencesPath: info.fences === FENCES_UNKNOWN ? null : info.fences })
  return { archive, batch_dir: info.batch_dir, fences: info.fences, command }
}

function adoptReady({ lane, report, deps }) {
  const d = normalDeps(deps)
  // recover never spawns a dispatch; the operator chooses whether to run the printed command.
  const adopt = adoptReadyReport({ lane, report, deps: d })
  report.adopt = adopt
  d.log(JSON.stringify({ event: 'closeout-adopt-ready', lane, adopt }))
  return { adopt }
}

function verifyLane({ lane, checkout, crewDir, deps, report }) {
  const d = normalDeps(deps)
  const crew = readCrew({ crewDir, lane, deps: d })
  if (!Array.isArray(crew.lane_fence)) refuse(`crew lane_fence is missing or not an array for ${lane}`, CLOSEOUT_REFUSALS.FENCE_ABSENT, 'verify')
  const laneDir = fallbackLaneDir({ lane, checkout, crew })
  const head = gitOutput({ args: ['rev-parse', 'HEAD'], cwd: laneDir, deps: d })
  const dirty = gitOutput({ args: ['status', '--porcelain'], cwd: laneDir, deps: d })
  const taskPath = join(crewDir, 'returns', 'task.json')
  const task = safeJson(taskPath, d)
  const details = task && typeof task.details === 'object' && !Array.isArray(task.details) ? task.details : {}
  const returnsDir = join(crewDir, 'returns')
  const escalationWhy = typeof details.escalation?.why === 'string' ? details.escalation.why : null
  const envelope = envelopeReport({ returnsDir, escalationWhy, deps: d })
  const files = {}
  for (const name of ['plan.md', 'gate.mjs', 'plan-check.md']) {
    try { files[name] = d.existsSync(join(crewDir, 'task', name)) } catch { files[name] = null }
  }
  const measured = {
    lane,
    crew_dir: crewDir,
    lane_dir: laneDir,
    head: head.value,
    head_error: head.error,
    dirty: dirty.value,
    dirty_error: dirty.error,
    lane_fence: crew.lane_fence,
    stages: Array.isArray(details.stages) ? details.stages : null,
    escalation: details.escalation && typeof details.escalation === 'object' ? details.escalation : null,
    escalation_why: escalationWhy,
    commit: Object.prototype.hasOwnProperty.call(details, 'commit') ? details.commit : null,
    task_head: Object.prototype.hasOwnProperty.call(details, 'head') ? details.head : null,
    envelope,
    files,
  }
  Object.assign(report, measured)
  return measured
}

const CLOSEOUT_HALF_STEPS = Object.freeze(['rebase', 'gate', 'suite', 'cold-verify'])

function closeoutHalf({ lane, checkout, crewDir, deps, report }) {
  const d = normalDeps(deps)
  const laneDir = report.lane_dir || fallbackLaneDir({ lane, checkout, crew: null })
  const runners = {
    rebase: () => gitStep({ args: ['rebase', 'main'], cwd: laneDir, reason: CLOSEOUT_REFUSALS.REBASE_FAILED, step: 'rebase', deps: d, message: `rebase failed for ${lane}` }),
    gate: () => {
      const result = runCommand({ file: 'node', args: [join(crewDir, 'task', 'gate.mjs')], cwd: laneDir }, d)
      if (!commandOk(result)) refuse(`acceptance gate failed for ${lane}: ${childFailure(result)}`, CLOSEOUT_REFUSALS.GATE_RED, 'gate')
      return { gate: 'green' }
    },
    suite: () => {
      report.suite = runSuite({ cwd: laneDir, deps: d })
      return { suite: report.suite }
    },
    'cold-verify': () => {
      let cold = null
      try { cold = d.mkdtempSync(join(tmpdir(), 'closeout-cold-')) } catch (error) {
        refuse(`cannot create cold verification worktree: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.COLD_VERIFY_FAILED, 'cold-verify')
      }
      try {
        const added = runCommand({ file: 'git', args: ['worktree', 'add', '--detach', cold, 'HEAD'], cwd: checkout }, d)
        if (!commandOk(added)) refuse(`cold verification worktree failed: ${childFailure(added)}`, CLOSEOUT_REFUSALS.COLD_VERIFY_FAILED, 'cold-verify')
        const suite = runSuite({ cwd: cold, deps: d, reason: CLOSEOUT_REFUSALS.COLD_VERIFY_FAILED, step: 'cold-verify' })
        report.cold_suite = suite
        return { suite }
      } finally {
        try { d.spawn({ file: 'git', args: ['worktree', 'remove', '--force', cold], cwd: checkout }) } catch { /* cleanup is best effort */ }
      }
    },
  }
  return runSteps({ verb: 'recover', lane, steps: CLOSEOUT_HALF_STEPS.map((name) => ({ name, run: runners[name] })), deps: d })
}

export function recover({ lane, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const name = typeof lane === 'string' ? lane : String(lane ?? '')
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  let crewDir = dirname(crewJsonPath({ checkout: root, lane: name, deps: d }))
  const report = { lane: name, crew_dir: crewDir, adopt: null }
  const runners = {
    quiet: () => {
      const probe = quietProbe({ dirs: [root, crewDir], deps: d })
      report.quiet = probe
      if (!probe.quiet) refuse(`tree is not quiet for ${name}: ${JSON.stringify(probe)}`, CLOSEOUT_REFUSALS.TREE_NOT_QUIET, 'quiet')
      return probe
    },
    preserve: () => {
      const to = `${crewDir}${RECOVERY_COPY_SUFFIX}`
      try { d.cpSync(crewDir, to, { recursive: true }) } catch (error) {
        refuse(`could not preserve ${crewDir}: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.PRESERVE_FAILED, 'preserve')
      }
      report.archive = to
      return { from: crewDir, to }
    },
    teardown: () => {
      const result = teardownLane({ lane: name, checkout: root, crewDir, deps: d })
      report.teardown = result
      crewDir = result.stateDir
      return result
    },
    verify: () => verifyLane({ lane: name, checkout: root, crewDir, deps: d, report }),
    closeout: () => {
      if (report.commit === null) return adoptReady({ lane: name, report, deps: d })
      return { commit: report.commit }
    },
  }
  const first = runSteps({ verb: 'recover', lane: name, steps: RECOVER_STEPS.map((step) => ({ name: step, run: runners[step] })), deps: d })
  let lines = first.lines
  let refusal = first.refusal
  if (!refusal && report.commit !== null) {
    const tail = closeoutHalf({ lane: name, checkout: root, crewDir, deps: d, report })
    lines = [...lines, ...tail.lines]
    refusal = tail.refusal
  }
  const resultRefusal = refusalObject(refusal)
  return { verb: 'recover', lane: name, lines, refusal: resultRefusal, report, code: resultRefusal ? 1 : 0 }
}

export const USAGE = 'usage: node scripts/factory/closeout.mjs (merge-check <lane…> | reap <lane…> | recover <lane>) [--checkout <dir>]'

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new CloseoutUsageError(USAGE)
  let verb = null
  let checkout = process.cwd()
  let help = false
  const lanes = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { help = true; continue }
    if (argument === '--checkout') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) throw new CloseoutUsageError(`${USAGE}: --checkout requires a value`)
      checkout = value
      index += 1
      continue
    }
    if (typeof argument !== 'string' || argument.startsWith('--')) throw new CloseoutUsageError(`${USAGE}: unknown option ${String(argument)}`)
    if (!verb) verb = argument
    else lanes.push(argument)
  }
  if (help) return { verb, lanes, checkout, help }
  if (!CLOSEOUT_VERBS.includes(verb)) throw new CloseoutUsageError(`${USAGE}: unknown verb ${String(verb)}`)
  if (lanes.length === 0) throw new CloseoutUsageError(`${USAGE}: at least one lane is required`)
  if (verb === 'recover' && lanes.length !== 1) throw new CloseoutUsageError(`${USAGE}: recover accepts exactly one lane`)
  return { verb, lanes, checkout, help }
}

export function main(argv, deps = {}) {
  const d = normalDeps(deps)
  try {
    const parsed = parseArgs(argv)
    if (parsed.help) { d.log(USAGE); return 0 }
    const options = { checkout: parsed.checkout, deps: d }
    const result = parsed.verb === 'merge-check'
      ? mergeCheck({ ...options, lanes: parsed.lanes })
      : parsed.verb === 'reap'
        ? reap({ ...options, lanes: parsed.lanes })
        : recover({ ...options, lane: parsed.lanes[0] })
    if (result.refusal) return EXIT_REFUSED
    return EXIT_OK
  } catch (error) {
    if (error instanceof CloseoutUsageError) {
      d.log(`${error.message} [reason: ${error.reason}]`)
      return EXIT_USAGE
    }
    if (error instanceof CloseoutRefusal) {
      d.log(`${error.message} [reason: ${error.reason}]`)
      return EXIT_REFUSED
    }
    d.log(`${error?.message || String(error)} [reason: ${CLOSEOUT_REFUSALS.INTERNAL}]`)
    return EXIT_REFUSED
  }
}

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2))
