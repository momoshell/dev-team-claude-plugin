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
  writeFileSync as fsWriteFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  collectAnchorPins,
  crewJsonPath,
  TEARDOWN_PROVEN,
  teardownVerdict,
} from './dispatch-batch.mjs'
import { journalRowsSinceRunStart, parseSuiteCounts, RUN_START_EVENT } from '../../crew/drive.mjs'
import { BATCH_DIR_EVENT, batchDirFromBrief, resolveTaskReturn as defaultResolveTaskReturn } from '../../crew/crew.mjs'
import { promptDocumentHits, promptSurfacePaths } from '../../crew/protected-paths.mjs'
import { loadCapabilities } from '../../crew/capabilities.mjs'
import { CELL_RATE_FLOOR, defaultDbPath as defaultLedgerDbPath, ingestJournal as defaultIngestJournal, openLedger as defaultOpenLedger } from './ledger.mjs'
import { probeDriverIdentity as defaultProbeDriverIdentity } from './lane-watch.mjs'

// 256 MiB: the suite's own output is the largest thing this module reads, and a truncated
// read is indistinguishable from a failure without it.
export const SPAWN_MAX_BUFFER = 256 * 1024 * 1024
export const CLOSEOUT_VERBS = Object.freeze(['merge-check', 'reap', 'recover', 'reconcile'])
export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2
export const STEP_EVENT = 'closeout-step'
export const STEP_OUTCOMES = Object.freeze({ OK: 'ok', REFUSED: 'refused' })
export const MERGE_CHECK_STEPS = Object.freeze(['pr-open', 'scratch-worktree', 'merge', 'suite', 'anchor-repair', 'report'])
export const REAP_STEPS = Object.freeze(['pr-merged', 'turns', 'issues', 'worktree', 'branch', 'prune', 'archive'])
export const RECOVER_STEPS = Object.freeze(['quiet', 'preserve', 'teardown', 'verify', 'closeout'])
export const RECONCILE_TERMINAL_STATUS = 'aborted'
export const RECONCILE_TERMINAL_OUTCOME = 'aborted'
export const RECONCILE_DEFAULT_REASON = 'driver-gone-without-terminal-envelope'
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
export const CLOSES_PATTERN = /^Closes:?\s+(.*)$/
const PROMPT_MEASURE_NAME = String.raw`(?:first-round pass rate|turns per seat|[a-z0-9][a-z0-9._-]* refusal frequency)`
const PROMPT_MEASURE_LINE = new RegExp(String.raw`(?:^|\r?\n)Measure: (${PROMPT_MEASURE_NAME})(?:\r?\n|$)`, 'i')
const PROMPT_UNMEASURED_LINE = new RegExp(String.raw`(?:^|\r?\n)unmeasured — n insufficient; reason: ([^;\n]*[^\s;\n][^;\n]*); re-measure after ([1-9]\d*) seats\.?(?:\r?\n|$)`, 'i')

export function parsePromptMeasureClaim(body) {
  const text = textOf(body)
  const unmeasured = PROMPT_UNMEASURED_LINE.exec(text)
  if (unmeasured === null) return null
  const measureMatch = PROMPT_MEASURE_LINE.exec(text)
  const measure = measureMatch === null ? null : measureMatch[1].trim().toLowerCase()
  const target_n = Number(unmeasured[2])
  if (!Number.isFinite(target_n) || target_n <= 0) return null
  return {
    measure,
    reason: unmeasured[1].trim(),
    target_n,
    closed_reason: measure === null ? 'measure-unnamed' : null,
  }
}
export const REAP_CLOSED_LABEL = 'closed'
export const REAP_REFERENCED_LABEL = 'referenced (left open)'
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
  SUITE_UNREADABLE: 'suite-unreadable',
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
  RECONCILE_SESSION_ABSENT: 'reconcile-session-absent',
  RECONCILE_SESSION_SETTLED: 'reconcile-session-settled',
  RECONCILE_IDENTITY_UNKNOWN: 'reconcile-identity-unknown',
  RECONCILE_DRIVER_ALIVE: 'reconcile-driver-alive',
  RECONCILE_TERMINAL_ENVELOPE: 'reconcile-terminal-envelope',
  RECONCILE_EVIDENCE_UNKNOWN: 'reconcile-evidence-unknown',
  RECONCILE_WRITE_FAILED: 'reconcile-write-failed',
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

function defaultPromptMeasurePath(deps) {
  try { return join(dirname(deps.defaultDbPath()), 'pending-prompt-measures.json') } catch { return null }
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
    writeFileSync: deps.writeFileSync || fsWriteFileSync,
    // The suite's TAP output passed Node's 1 MiB default on 2026-09-18 (1,047,788 bytes at
    // 5,618 tests), and a child that overruns it is killed with ENOBUFS — which merge-check
    // read as a RED SUITE. A cap this measurement can outgrow is a cap that lies about it.
    spawn: deps.spawn || ((options) => spawnSync(options.file, options.args, { cwd: options.cwd, env: options.env, encoding: 'utf8', maxBuffer: SPAWN_MAX_BUFFER })),
    newest: deps.newest || newestMtime,
    now: deps.now || (() => Date.now()),
    sleep: deps.sleep || sleepSync,
    openLedger: deps.openLedger || defaultOpenLedger,
    defaultDbPath: deps.defaultDbPath || defaultLedgerDbPath,
    probeDriverIdentity: deps.probeDriverIdentity || defaultProbeDriverIdentity,
    resolveTaskReturn: deps.resolveTaskReturn || defaultResolveTaskReturn,
    ingestJournal: deps.ingestJournal || defaultIngestJournal,
    home: deps.home || homedir(),
    log: deps.log || ((line) => process.stdout.write(`${line}\n`)),
  }
  d.promptMeasurePath = deps.promptMeasurePath || defaultPromptMeasurePath(d)
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
  return stripVTControlCharacters(String(text))
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

export function trailerIssues(text, pattern) {
  const found = []
  for (const line of String(text || '').split('\n')) {
    const match = pattern.exec(line)
    if (!match) continue
    for (const ref of match[1].matchAll(/#(\d+)/g)) {
      const number = Number(ref[1])
      if (!found.includes(number)) found.push(number)
    }
  }
  return found
}

export function refsFromPrBody(text) {
  return trailerIssues(text, REFS_PATTERN)
}

// #924 — Refs and Closes are DISTINCT trailers. Only Closes names an issue this
// merge closed; a number in both is closed, and is reported once, under closed.
export function issueTrailersFromPrBody(text) {
  const closes = trailerIssues(text, CLOSES_PATTERN)
  const referenced = refsFromPrBody(text).filter((number) => !closes.includes(number))
  return { closes, referenced }
}

export function reapIssueSummary({ closed = [], referenced = [] } = {}) {
  const list = (values) => (Array.isArray(values) && values.length ? values.map((number) => `#${number}`).join(', ') : 'none')
  return `${REAP_CLOSED_LABEL}: ${list(closed)} · ${REAP_REFERENCED_LABEL}: ${list(referenced)}`
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
  return { dirs: paths, quiet, reads, unknown }
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

export const BATCH_DIR_SOURCES = Object.freeze(['boot-journal', 'run-log', 'brief-sibling'])
export const BATCH_DIR_ABSENT = 'no source carried a batch dir: no batch-dir boot row, no --brief-file in run.log, and no compiled brief under an out/ directory'
export const FENCES_ABSENT_BATCH_UNKNOWN = 'the batch dir is unknown, so no fences.json can be located'
export const FENCES_ABSENT_NO_FILE = 'no fences.json under the batch dir'

export function adoptCommandLine({ lane, archive, batchDir, fencesPath } = {}) {
  const batch = typeof batchDir === 'string' && batchDir.trim() ? batchDir : null
  const fences = typeof fencesPath === 'string' && fencesPath.trim() ? fencesPath : null
  if (!batch || !fences) return null
  return `node scripts/factory/dispatch-batch.mjs --batch ${batch} --fences ${fences} --adopt ${lane}=${archive}`
}

function safeJson(path, d) {
  try { return JSON.parse(textOf(d.readFileSync(path, 'utf8'))) } catch { return null }
}

function runCommand(options, d) {
  try { return d.spawn(options) } catch (error) { return { status: null, error, stdout: '', stderr: '' } }
}

function turnEconomyUnavailable(reason, extras = {}) { return { measured: false, reason, ...extras } }

export function journalTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return NaN
}

function reapIdentity({ crewDir, lane, deps }) {
  const d = normalDeps(deps)
  const path = join(crewDir, 'ledger', 'run.json')
  let run
  try {
    run = JSON.parse(textOf(d.readFileSync(path, 'utf8')))
  } catch (error) {
    throw new Error(`cannot read ledger/run.json for ${lane}: ${error?.message || String(error)}`)
  }
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error(`ledger/run.json for ${lane} is not an object`)
  }
  if (typeof run.task_slug === 'string' && run.task_slug.trim() && run.task_slug !== lane) {
    throw new Error(`ledger/run.json identity does not match lane ${lane}`)
  }
  if (typeof run.adw_id !== 'string' || run.adw_id.trim() === '') {
    throw new Error(`ledger/run.json for ${lane} has no usable adw_id`)
  }
  if (typeof run.db_path !== 'string' || run.db_path.trim() === '') {
    throw new Error(`ledger/run.json for ${lane} has no usable db_path`)
  }
  return { adw_id: run.adw_id.trim(), db_path: run.db_path.trim() }
}

function currentRunWindow({ lane, laneDir, deps }) {
  const d = normalDeps(deps)
  const crewDir = dirname(crewJsonPath({ checkout: laneDir, lane, deps: d }))
  const journalPath = join(crewDir, 'journal.jsonl')
  const identity = reapIdentity({ crewDir, lane, deps: d })
  let text
  try {
    text = textOf(d.readFileSync(journalPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read current-run journal ${journalPath}: ${error?.message || String(error)}`)
  }

  let start = null
  let latest = null
  let unusableBoundary = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (row.event === RUN_START_EVENT) {
      const at = Object.prototype.hasOwnProperty.call(row, 'at') ? row.at : null
      const timestamp = journalTimestampMs(at)
      if (!Number.isFinite(timestamp)) {
        start = null
        latest = null
        unusableBoundary = at === null || at === undefined
          ? `run-start in ${journalPath} has no usable timestamp`
          : `run-start in ${journalPath} has an unusable timestamp`
        continue
      }
      start = { at, timestamp }
      latest = timestamp
      unusableBoundary = null
      continue
    }
    if (!start) continue
    if (!Object.prototype.hasOwnProperty.call(row, 'at')) continue
    const timestamp = journalTimestampMs(row.at)
    if (!Number.isFinite(timestamp)) continue
    if (timestamp > latest) latest = timestamp
  }
  if (unusableBoundary) throw new Error(unusableBoundary)
  if (!start || !Number.isFinite(latest)) throw new Error(`no timestamped ${RUN_START_EVENT} in ${journalPath}`)
  const untilMs = Math.floor(latest / 1000) * 1000 + 1000
  if (!Number.isFinite(untilMs)) throw new Error(`latest journal timestamp in ${journalPath} cannot form a whole-second boundary`)
  let until
  try { until = new Date(untilMs).toISOString() } catch (error) {
    throw new Error(`latest journal timestamp in ${journalPath} cannot form a whole-second boundary: ${error?.message || String(error)}`)
  }
  let since
  try {
    since = typeof start.at === 'string' && !Number.isFinite(Number(start.at))
      ? start.at
      : new Date(start.timestamp).toISOString()
  } catch (error) {
    throw new Error(`run-start in ${journalPath} has an unusable timestamp: ${error?.message || String(error)}`)
  }
  return { since, until, crewDir, journalPath, identity }
}

function ingestReadFailure(error) {
  return {
    applied: 0,
    skipped: 0,
    ignored: 0,
    failed: 0,
    complete: false,
    first_failure: { line: null, reason: error?.code || error?.name || 'ReadError' },
  }
}

function safeReapIngest({ journalPath, identity, since, deps }) {
  const d = normalDeps(deps)
  let ledger = null
  try {
    ledger = d.openLedger({ dbPath: identity.db_path })
    if (!ledger || ledger.degraded || (typeof ledger.stats === 'function' && ledger.stats().degraded)) {
      const reason = 'ledger mirror is degraded — journal ingest is unmeasured'
      return {
        applied: 0, skipped: 0, ignored: 0, failed: 0, complete: false,
        first_failure: { line: null, reason }, reason,
      }
    }
    const detail = d.ingestJournal(journalPath, ledger, { adw_id: identity.adw_id, since })
    if (ledger.degraded || (typeof ledger.stats === 'function' && ledger.stats().degraded)) {
      const reason = 'ledger mirror is degraded — journal ingest is unmeasured'
      return {
        applied: detail?.applied ?? 0,
        skipped: detail?.skipped ?? 0,
        ignored: detail?.ignored ?? 0,
        failed: detail?.failed ?? 0,
        complete: false,
        first_failure: detail?.first_failure ?? { line: null, reason }, reason,
      }
    }
    return detail
  } catch (error) { return { ...ingestReadFailure(error), reason: error?.code || error?.name || 'IngestError' } }
  finally {
    try { if (ledger) ledger.close() } catch { /* ingest instrumentation is non-load-bearing */ }
  }
}

function reapTurnEconomy({ lane, laneDir, root, deps }) {
  const d = normalDeps(deps)
  let context
  try { context = currentRunWindow({ lane, laneDir, deps: d }) } catch (error) {
    return turnEconomyUnavailable(error?.message || String(error))
  }
  const window = { since: context.since, until: context.until }
  const ingest = safeReapIngest({ journalPath: context.journalPath, identity: context.identity, deps: d, since: context.since })
  const command = {
    file: 'node',
    args: [join(root, 'scripts/factory/ledger.mjs'), 'turns', '--adw-id', context.identity.adw_id, '--since', window.since, '--until', window.until],
    cwd: root,
    env: { ...process.env, DEVTEAM_LEDGER_DB: context.identity.db_path },
  }
  const result = runCommand(command, d)
  if (!commandOk(result)) return turnEconomyUnavailable(childFailure(result), { window, ingest })
  let payload
  try { payload = JSON.parse(textOf(result.stdout).trim()) } catch (error) {
    return turnEconomyUnavailable(`cannot parse turns readout: ${error?.message || String(error)}`, { window, ingest })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schema !== 1) {
    return turnEconomyUnavailable('turns readout must be exactly one schema-1 JSON object', { window, ingest })
  }
  if (payload.absent) return { measured: false, reason: payload.absent, window, ingest, turn_economy: payload }
  return { measured: true, window, ingest, turn_economy: payload }
}

function commandOk(result) {
  return Boolean(result && result.status === 0)
}

const PROMPT_QUEUE_SCHEMA = 1

function promptQueuePath(deps) {
  try {
    const value = typeof deps.promptMeasurePath === 'function' ? deps.promptMeasurePath(deps) : deps.promptMeasurePath
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}

function promptQueueFailure(prefix, error) {
  const reason = error?.code || error?.message || error?.name || String(error)
  return `${prefix}: ${reason}`
}

function readPromptMeasureQueue(deps) {
  const path = promptQueuePath(deps)
  if (path === null) return { valid: false, path: null, records: [], reason: 'prompt-measures-path-unavailable' }
  let raw
  try {
    raw = deps.readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { valid: true, path, records: [], missing: true, reason: null }
    return { valid: false, path, records: [], reason: promptQueueFailure('prompt-measures-queue-unreadable', error) }
  }
  if (textOf(raw).trim() === '') return { valid: false, path, records: [], reason: 'prompt-measures-queue-malformed: empty state' }
  let parsed
  try {
    parsed = JSON.parse(textOf(raw))
  } catch (error) {
    return { valid: false, path, records: [], reason: promptQueueFailure('prompt-measures-queue-malformed', error) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== PROMPT_QUEUE_SCHEMA || !Array.isArray(parsed.records)) {
    return { valid: false, path, records: [], reason: 'prompt-measures-queue-invalid: expected schema 1 records array' }
  }
  if (parsed.records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
    return { valid: false, path, records: [], reason: 'prompt-measures-queue-invalid: records must be objects' }
  }
  return { valid: true, path, records: parsed.records, missing: false, reason: null }
}

function writePromptMeasureQueue({ deps, path, records }) {
  if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: 'prompt-measures-path-unavailable' }
  let temporary
  try {
    const stamp = String(deps.now())
    temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${stamp}.tmp`)
    deps.mkdirSync(dirname(path), { recursive: true })
    deps.writeFileSync(temporary, `${JSON.stringify({ schema: PROMPT_QUEUE_SCHEMA, records })}\n`, 'utf8')
    deps.renameSync(temporary, path)
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: promptQueueFailure('prompt-measures-queue-write-failed', error) }
  }
}

function meaningfulPromptAbsent(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.some((entry) => meaningfulPromptAbsent(entry))
  if (typeof value === 'object') return Object.values(value).some((entry) => meaningfulPromptAbsent(entry))
  return true
}

function promptMetricFailure(reason) {
  return { value: null, numerator: null, denominator: null, rate_floor: CELL_RATE_FLOOR, reason }
}

function finiteMetricNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function promptMetricName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function promptMetricCommand({ measure, mergedAt, direction, root, deps }) {
  const normalized = promptMetricName(measure)
  if (normalized !== 'first-round pass rate' && normalized !== 'turns per seat') {
    return promptMetricFailure(`measure-unsupported: ${measure}`)
  }
  if (typeof root !== 'string' || root.trim() === '') return promptMetricFailure('prompt-root-unavailable: root is absent')
  const verb = normalized === 'first-round pass rate' ? 'cells' : 'turns'
  let dbPath
  try { dbPath = deps.defaultDbPath() } catch (error) {
    return promptMetricFailure(promptQueueFailure('ledger-path-unavailable', error))
  }
  if (typeof dbPath !== 'string' || dbPath.trim() === '') return promptMetricFailure('ledger-path-unavailable: default path is absent')
  const command = {
    file: 'node',
    args: [join(root, 'scripts/factory/ledger.mjs'), verb, direction === 'before' ? '--until' : '--since', mergedAt],
    cwd: root,
    env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath },
  }
  const result = runCommand(command, deps)
  if (!commandOk(result)) return promptMetricFailure(promptQueueFailure('ledger-read-failed', new Error(childFailure(result))))
  let payload
  try {
    payload = JSON.parse(textOf(result.stdout).trim())
  } catch (error) {
    return promptMetricFailure(promptQueueFailure('ledger-read-malformed', error))
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schema !== 1) {
    return promptMetricFailure('ledger-read-invalid: expected schema 1 object')
  }
  if (payload.degraded === true || meaningfulPromptAbsent(payload.degraded)) return promptMetricFailure('ledger-degraded: readout is degraded')
  if (meaningfulPromptAbsent(payload.absent)) return promptMetricFailure(`ledger-absent: ${textOf(payload.absent)}`)
  if (normalized === 'first-round pass rate') {
    if (!Array.isArray(payload.rows)) return promptMetricFailure('ledger-read-invalid: cells rows must be an array')
    let numerator = 0
    let denominator = 0
    for (const row of payload.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || !finiteMetricNumber(row.first_round_passes) || !finiteMetricNumber(row.first_round_reviews)) {
        return promptMetricFailure('ledger-read-invalid: cells row has nonfinite fields')
      }
      numerator += row.first_round_passes
      denominator += row.first_round_reviews
      if (!finiteMetricNumber(numerator) || !finiteMetricNumber(denominator)) return promptMetricFailure('ledger-read-invalid: cells aggregate is nonfinite')
    }
    if (denominator < CELL_RATE_FLOOR) return { value: null, numerator, denominator, rate_floor: CELL_RATE_FLOOR, reason: `under-floor: ${denominator}/${CELL_RATE_FLOOR}` }
    const value = numerator / denominator
    if (!finiteMetricNumber(value)) return promptMetricFailure('ledger-read-invalid: cells rate is nonfinite')
    return { value, numerator, denominator, rate_floor: CELL_RATE_FLOOR, reason: null }
  }
  if (!finiteMetricNumber(payload.turns) || !finiteMetricNumber(payload.dispatches_measured)) return promptMetricFailure('ledger-read-invalid: turns fields are nonfinite')
  const numerator = payload.turns
  const denominator = payload.dispatches_measured
  if (denominator < CELL_RATE_FLOOR) return { value: null, numerator, denominator, rate_floor: CELL_RATE_FLOOR, reason: `under-floor: ${denominator}/${CELL_RATE_FLOOR}` }
  const value = numerator / denominator
  if (!finiteMetricNumber(value)) return promptMetricFailure('ledger-read-invalid: turns rate is nonfinite')
  return { value, numerator, denominator, rate_floor: CELL_RATE_FLOOR, reason: null }
}

function promptMetricReady(metric) {
  return Boolean(metric
    && finiteMetricNumber(metric.value)
    && finiteMetricNumber(metric.denominator)
    && finiteMetricNumber(metric.rate_floor)
    && metric.denominator >= metric.rate_floor)
}

function promptUnderFloorReason(metric, target) {
  if (!finiteMetricNumber(metric?.denominator)) return null
  const requested = finiteMetricNumber(Number(target)) ? Number(target) : CELL_RATE_FLOOR
  const required = Math.max(requested, finiteMetricNumber(metric.rate_floor) ? metric.rate_floor : CELL_RATE_FLOOR)
  return `under-floor: ${metric.denominator}/${required}`
}

function promptSettledAt(deps) {
  try {
    const raw = deps.now()
    const value = typeof raw === 'string' ? Date.parse(raw) : Number(raw)
    if (!Number.isFinite(value)) return null
    return new Date(value).toISOString()
  } catch {
    return null
  }
}

function promptMetadata({ lane, pr, deps, root, register }) {
  const result = runCommand({
    file: 'gh',
    args: ['pr', 'view', lane, '--json', 'files,mergedAt'],
    cwd: pr?.checkout || root,
  }, deps)
  if (!commandOk(result)) return { ok: false, reason: promptQueueFailure('prompt-metadata-unavailable', new Error(childFailure(result))) }
  let payload
  try {
    payload = JSON.parse(textOf(result.stdout).trim())
  } catch (error) {
    return { ok: false, reason: promptQueueFailure('prompt-metadata-malformed', error) }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.files)) {
    return { ok: false, reason: 'prompt-metadata-unavailable: files are absent' }
  }
  if (typeof payload.mergedAt !== 'string' || payload.mergedAt.trim() === '') return { ok: false, reason: 'prompt-metadata-unavailable: mergedAt is absent' }
  if (!Number.isFinite(Date.parse(payload.mergedAt))) return { ok: false, reason: 'prompt-metadata-unavailable: mergedAt is invalid' }
  const paths = payload.files
    .map((file) => file && typeof file.path === 'string' ? file.path.trim().replaceAll('\\', '/').replace(/^\.\//, '') : null)
    .filter((path) => path !== null && path !== '')
  // The same surface the publish guard and the dispatcher read (b826): prompt DOCUMENTS under the
  // static prefixes plus every skill file the register grants. A closeout that still read the bare
  // prefixes would sweep a granted-skill PR as not-prompt-change — a reason that is false, not absent.
  return { ok: true, merged_at: payload.mergedAt, paths, hits: promptDocumentHits(paths, promptSurfacePaths(register)) }
}

function promptSweepDetail({ records, pending, settled, comments, closed }) {
  return {
    queued: 0,
    settled,
    comments,
    pending: records.filter((record) => record.status === 'pending').length,
    closed,
    swept: pending.length,
  }
}

function promptComment(record, after) {
  return `Measure: ${record.measure}; before: ${record.before.value} (n=${record.before.denominator}); after: ${after.value} (n=${after.denominator})`
}

export function reapPromptMeasures({ lane, pr, root, deps, register = loadCapabilities() } = {}) {
  const d = normalDeps(deps)
  const queue = readPromptMeasureQueue(d)
  if (!queue.valid) return { queued: 0, settled: 0, comments: 0, pending: 0, swept: 0, closed: [queue.reason], reason: queue.reason }
  const records = queue.records
  const pending = records.filter((record) => record.status === 'pending')
  let settled = 0
  let comments = 0
  const closed = []
  for (const record of pending) {
    let after
    if (record.measure === null) {
      after = promptMetricFailure(record.closed_reason || 'measure-unnamed')
    } else {
      after = promptMetricCommand({ measure: record.measure, mergedAt: record.merged_at, direction: 'after', root, deps: d })
    }
    let nextReason = after.reason
    if (after.denominator >= record.target_n) {
      if (promptMetricReady(record.before) && promptMetricReady(after)) {
        const comment = promptComment(record, after)
        const previous = { status: record.status, after: record.after, settled_at: record.settled_at, closed_reason: record.closed_reason }
        record.status = 'settled'
        record.after = after
        record.settled_at = promptSettledAt(d)
        record.closed_reason = null
        const saved = writePromptMeasureQueue({ deps: d, path: queue.path, records })
        if (!saved.ok) {
          record.status = previous.status
          if (previous.after === undefined) delete record.after
          else record.after = previous.after
          if (previous.settled_at === undefined) delete record.settled_at
          else record.settled_at = previous.settled_at
          record.closed_reason = saved.reason
          closed.push(saved.reason)
          continue
        }
        settled += 1
        const commentResult = runCommand({ file: 'gh', args: ['pr', 'comment', String(record.pr_number), '--body', comment], cwd: root }, d)
        if (commandOk(commentResult)) comments += 1
        else {
          const failure = promptQueueFailure('prompt-comment-failed', new Error(childFailure(commentResult)))
          record.closed_reason = failure
          const noted = writePromptMeasureQueue({ deps: d, path: queue.path, records })
          closed.push(failure)
          if (!noted.ok) closed.push(noted.reason)
        }
        continue
      }
      nextReason = after.reason || (record.before?.value === null ? 'before-unmeasured' : promptUnderFloorReason(after, record.target_n))
    }
    nextReason = nextReason || promptUnderFloorReason(after, record.target_n) || 'prompt-measure-unmeasured'
    if (nextReason) closed.push(nextReason)
    if (record.closed_reason !== nextReason) {
      record.closed_reason = nextReason
      const saved = writePromptMeasureQueue({ deps: d, path: queue.path, records })
      if (!saved.ok) closed.push(saved.reason)
    }
  }

  const swept = promptSweepDetail({ records, pending, settled, comments, closed })
  const claim = parsePromptMeasureClaim(pr?.body)
  if (claim === null) return { ...swept, reason: 'no-unmeasured-claim' }
  const metadata = promptMetadata({ lane, pr, deps: d, root, register })
  if (!metadata.ok) return { ...swept, reason: metadata.reason }
  const promptChanged = metadata.hits.length > 0
  if (!promptChanged) return { queued: 0, reason: 'not-prompt-change' }
  const prNumber = Number(pr?.number)
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ...swept, reason: 'prompt-metadata-unavailable: PR number is absent' }
  if (records.some((record) => Number(record.pr_number) === prNumber)) return { ...swept, reason: 'already-queued' }
  const before = claim.measure === null
    ? promptMetricFailure(claim.closed_reason)
    : promptMetricCommand({ measure: claim.measure, mergedAt: metadata.merged_at, direction: 'before', root, deps: d })
  const record = {
    pr_number: prNumber,
    lane,
    measure: claim.measure,
    reason: claim.reason,
    target_n: claim.target_n,
    merged_at: metadata.merged_at,
    status: 'pending',
    before,
    closed_reason: claim.closed_reason || before.reason || null,
  }
  records.push(record)
  const saved = writePromptMeasureQueue({ deps: d, path: queue.path, records })
  if (!saved.ok) {
    records.pop()
    return { ...swept, reason: saved.reason }
  }
  if (record.closed_reason) swept.closed.push(record.closed_reason)
  return { ...swept, queued: 1, pending: records.filter((candidate) => candidate.status === 'pending').length, reason: 'queued', prompt_changed: true, protected_hits: metadata.hits }
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

function suiteCommand(cwd, env = colourNeutralEnv()) {
  return {
    file: 'node',
    args: ['--test', '--test-reporter=tap', '--test-timeout=30000', '**/*.test.mjs'],
    cwd,
    env,
  }
}

function runSuite({ cwd, deps, env, reason = CLOSEOUT_REFUSALS.SUITE_RED, step = 'suite' }) {
  const d = normalDeps(deps)
  const result = runCommand(suiteCommand(cwd, env), d)
  const suite = parseSuiteCounts(stripAnsi(textOf(result?.stdout)))
  // A run whose OUTPUT could not be read is unmeasured, and saying "the suite is red" about
  // it is a claim nobody made: ENOBUFS killed the child mid-stream, so `fail` is unknown.
  if (!suite) {
    refuse(`the suite in ${cwd} reported no counts: ${childFailure(result)}`, CLOSEOUT_REFUSALS.SUITE_UNREADABLE, step)
  }
  if (!commandOk(result) || suite.fail > 0) {
    refuse(`suite failed in ${cwd}: ${JSON.stringify(suite)}`, reason, step)
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
      report.suite = runSuite({ cwd: scratch, deps: d, env: { ...colourNeutralEnv(), DEVTEAM_LEDGER_DIR: join(scratch, '.dev-team', 'factory') } })
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
  const summary = { lanes: laneReports, closed: [], referenced: [], archived: [] }
  let refusal = null
  for (const lane of batch) {
    const laneDir = join(dirname(root), `dt-${lane}`)
    const laneReport = { lane, closed: [], referenced: [], archived: [] }
    let pr = null
    const runners = {
      'pr-merged': () => {
        pr = prView({ lane, checkout: root, deps: d, step: 'pr-merged' })
        if (pr.state !== MERGED_STATE) refuse(`PR for ${lane} is ${JSON.stringify(pr.state)}, expected ${MERGED_STATE}`, CLOSEOUT_REFUSALS.PR_NOT_MERGED, 'pr-merged')
        return { number: pr.number, state: pr.state }
      },
      turns: () => {
        const detail = reapTurnEconomy({ lane, laneDir, root, deps: d })
        laneReport.turn_economy = detail
        return detail
      },
      issues: () => {
        // Never infer: a body with neither trailer closes nothing and says so.
        const trailers = issueTrailersFromPrBody(pr.body)
        const closing = trailers.closes
        for (const issue of closing) closeIssue({ issue, lane, pr, deps: d })
        laneReport.closed = [...closing]
        laneReport.referenced = [...trailers.referenced]
        const promptMeasures = reapPromptMeasures({ lane, pr, root, deps: d })
        laneReport.prompt_measures = promptMeasures
        return { closed: laneReport.closed, referenced: laneReport.referenced, summary: reapIssueSummary(laneReport), prompt_measures: promptMeasures }
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
    summary.closed.push(...laneReport.closed)
    summary.referenced.push(...laneReport.referenced)
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

export function quietRefusalDetail(probe) {
  const dirs = Array.isArray(probe?.dirs) ? probe.dirs : []
  const reads = Array.isArray(probe?.reads) ? probe.reads : []
  const mark = (value) => (value === null || value === undefined ? 'unknown' : String(value))
  const parts = dirs.map((dir, index) => `${dir}: newest mtime ${mark(reads[0]?.[index])} then ${mark(reads[reads.length - 1]?.[index])}`)
  return `${parts.join(' · ')} · ${JSON.stringify(probe)}`
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

function readCrew({ crewDir, lane, deps, step = 'verify' }) {
  const d = normalDeps(deps)
  const path = join(crewDir, 'crew.json')
  let crew
  try { crew = JSON.parse(textOf(d.readFileSync(path, 'utf8'))) } catch (error) {
    refuse(`cannot read crew.json for ${lane}: ${error?.message || String(error)}`, CLOSEOUT_REFUSALS.CREW_UNREADABLE, step)
  }
  if (!crew || typeof crew !== 'object' || Array.isArray(crew) || crew.lane_name !== lane) {
    refuse(`crew lane_name is not ${lane}`, CLOSEOUT_REFUSALS.CREW_UNREADABLE, step)
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

function fromBootRow(rows) {
  const row = (Array.isArray(rows) ? rows : []).find((candidate) => candidate?.event === BATCH_DIR_EVENT && typeof candidate.batch_dir === 'string' && candidate.batch_dir.trim())
  return row ? { batch_dir: row.batch_dir, batch_dir_source: 'boot-journal' } : null
}

function fromRunLog({ crewDir, deps }) {
  const d = normalDeps(deps)
  const runLogPath = join(crewDir, 'run.log')
  let text
  try { text = textOf(d.readFileSync(runLogPath, 'utf8')) } catch { return null }
  const line = text.split('\n').find((entry) => entry.includes('--brief-file'))
  if (!line) return null
  const tokens = line.trim().split(/\s+/)
  const briefAt = tokens.indexOf('--brief-file')
  const derived = batchDirFromBrief(tokens[briefAt + 1])
  return derived.batch_dir ? { batch_dir: derived.batch_dir, batch_dir_source: 'run-log' } : null
}

function fromBriefRow(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.brief !== 'string' || !row.brief.trim()) continue
    const derived = batchDirFromBrief(row.brief)
    if (derived.batch_dir) return { batch_dir: derived.batch_dir, batch_dir_source: 'brief-sibling' }
  }
  return null
}

function hasExplicitNullBatchDir(rows) {
  return (Array.isArray(rows) ? rows : []).some((row) => row?.event === BATCH_DIR_EVENT && row.batch_dir === null)
}

function batchInfo({ crewDir, deps }) {
  const d = normalDeps(deps)
  let rows
  try {
    const journal = textOf(d.readFileSync(join(crewDir, 'journal.jsonl'), 'utf8'))
    rows = journalRowsSinceRunStart(journal)
  } catch {
    rows = []
  }
  const activeNullBatchDir = hasExplicitNullBatchDir(rows)
  const derived = fromBootRow(rows) || fromRunLog({ crewDir, deps: d }) || fromBriefRow(rows) || null
  if (activeNullBatchDir || !derived) {
    return { batch_dir: null, batch_dir_source: null, batch_dir_reason: BATCH_DIR_ABSENT, fences: null, fences_reason: FENCES_ABSENT_BATCH_UNKNOWN }
  }
  const candidate = join(derived.batch_dir, 'fences.json')
  let fences = null
  try { fences = d.existsSync(candidate) ? candidate : null } catch { fences = null }
  return { ...derived, batch_dir_reason: null, fences, fences_reason: fences ? null : FENCES_ABSENT_NO_FILE }
}

export function adoptReadyReport({ lane, report, deps }) {
  const d = normalDeps(deps)
  const archive = typeof report?.archive === 'string' && report.archive.trim() ? report.archive : `${report.crew_dir}${RECOVERY_COPY_SUFFIX}`
  const info = batchInfo({ crewDir: report.crew_dir, deps: d })
  const command = adoptCommandLine({ lane, archive, batchDir: info.batch_dir, fencesPath: info.fences })
  const missing = []
  if (!info.batch_dir) missing.push('--batch')
  if (!info.fences) missing.push('--fences')
  return { archive, ...info, adopt_argument: `${lane}=${archive}`, command, missing }
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
        const suite = runSuite({ cwd: cold, deps: d, env: { ...colourNeutralEnv(), DEVTEAM_LEDGER_DIR: join(cold, '.dev-team', 'factory') }, reason: CLOSEOUT_REFUSALS.COLD_VERIFY_FAILED, step: 'cold-verify' })
        report.cold_suite = suite
        return { suite }
      } finally {
        try { d.spawn({ file: 'git', args: ['worktree', 'remove', '--force', cold], cwd: checkout }) } catch { /* cleanup is best effort */ }
      }
    },
  }
  return runSteps({ verb: 'recover', lane, steps: CLOSEOUT_HALF_STEPS.map((name) => ({ name, run: runners[name] })), deps: d })
}

export function recover({ lane, checkout, checkoutExplicit, deps } = {}) {
  const d = normalDeps(deps)
  const name = typeof lane === 'string' ? lane : String(lane ?? '')
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  let crewDir = dirname(crewJsonPath({ checkout: root, lane: name, deps: d }))
  const report = { lane: name, crew_dir: crewDir, adopt: null }
  const runners = {
    quiet: () => {
      const crew = readCrew({ crewDir, lane: name, deps: d, step: 'quiet' })
      const probeRoot = checkoutExplicit ? root : fallbackLaneDir({ lane: name, checkout: root, crew })
      report.probe_root = probeRoot
      report.probe_root_source = checkoutExplicit ? 'checkout-flag' : (typeof crew?.checkout === 'string' && crew.checkout.trim() ? 'crew-json' : 'sibling-fallback')
      const probe = quietProbe({ dirs: [probeRoot, crewDir], deps: d })
      report.quiet = probe
      if (!probe.quiet) refuse(`tree is not quiet for ${name}: ${quietRefusalDetail(probe)}`, CLOSEOUT_REFUSALS.TREE_NOT_QUIET, 'quiet')
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

const RECONCILE_ACTIVE_STATUSES = new Set(['active', 'running', 'pending', 'working', 'open', 'unsettled', 'in-progress', 'in_progress'])

function reconcileSession({ ledger, lane, checkout, supplied }) {
  if (supplied && typeof supplied === 'object') return supplied
  let rows
  try { rows = ledger.listSessions() } catch { return null }
  const matches = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.task_slug === lane)
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
  // A checkout-derived repository match disambiguates identical task slugs in
  // a shared home, while the task-only fallback keeps old ledgers readable.
  const repo = basename(checkout)
  return matches.find((row) => row.repo_slug === repo) || matches[0] || null
}

function returnArtifactNames(names) {
  return (Array.isArray(names) ? names : [])
    .map((raw) => typeof raw === 'string' ? raw : raw?.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort()
}

function terminalEnvelopeEvidence({ crewDir, deps }) {
  const d = normalDeps(deps)
  const returnsDir = join(crewDir, 'returns')
  let taskReturn
  try { taskReturn = d.resolveTaskReturn({ dir: crewDir, returnsDir }, d) } catch (error) {
    return { state: 'unknown', reason: 'task-return-unresolved', detail: error?.code || 'resolve-error' }
  }
  if (typeof taskReturn !== 'string' || taskReturn.trim() === '') {
    return { state: 'unknown', reason: 'task-return-unresolved', detail: 'missing task return' }
  }
  const scopeDir = dirname(taskReturn)
  let names
  try { names = d.readdirSync(scopeDir) } catch (error) {
    return { state: 'unknown', reason: 'returns-unreadable', detail: error?.code || 'read-error' }
  }
  const artifacts = returnArtifactNames(names)
  const taskName = basename(taskReturn)
  const seatEnvelopes = artifacts.filter((name) => ENVELOPE_RE.test(name))
  if (!artifacts.includes(taskName)) {
    if (seatEnvelopes.length > 0) return { state: 'none', files: seatEnvelopes, task_return: taskReturn, scope_dir: scopeDir }
    return { state: 'unknown', reason: 'returns-empty', detail: 'no task or seat envelope' }
  }
  let raw
  try { raw = d.readFileSync(taskReturn, 'utf8') } catch (error) {
    return { state: 'unknown', reason: 'envelope-unreadable', detail: { file: taskName, error: error?.code || 'read-error' } }
  }
  if (textOf(raw).trim() === '') return { state: 'unknown', reason: 'envelope-empty', detail: { file: taskName } }
  let parsed
  try { parsed = JSON.parse(textOf(raw)) } catch {
    return { state: 'unknown', reason: 'envelope-malformed', detail: { file: taskName } }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.status !== 'string' || parsed.status.trim() === '') {
    return { state: 'unknown', reason: 'envelope-malformed', detail: { file: taskName } }
  }
  const status = parsed.status.trim().toLowerCase()
  if (!RECONCILE_ACTIVE_STATUSES.has(status)) {
    return { state: 'terminal', file: taskName, status: parsed.status, outcome: parsed.outcome ?? parsed.status, detail: { file: taskName, status: parsed.status }, task_return: taskReturn, scope_dir: scopeDir }
  }
  return { state: 'none', files: seatEnvelopes, task_return: taskReturn, scope_dir: scopeDir }
}

function reconciliationRefusal(value) {
  if (value === 'alive') refuse('current driver identity is alive', CLOSEOUT_REFUSALS.RECONCILE_DRIVER_ALIVE, 'reconcile')
  if (value === 'terminal-envelope-present') refuse('a terminal envelope already supplies an outcome', CLOSEOUT_REFUSALS.RECONCILE_TERMINAL_ENVELOPE, 'reconcile')
  refuse('current driver identity is unknown', CLOSEOUT_REFUSALS.RECONCILE_IDENTITY_UNKNOWN, 'reconcile')
}

function reconcileObservedAt(value) {
  const at = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : NaN
  if (!Number.isFinite(at)) return null
  try { return new Date(at).toISOString() } catch { return null }
}

export function commitReconciliation({ ledger, session, observation, actor = 'operator', reason = RECONCILE_DEFAULT_REASON } = {}) {
  if (!ledger || typeof ledger.endSession !== 'function') throw new Error('reconcile ledger is unavailable')
  return ledger.endSession({ adw_id: session.adw_id, status: 'aborted', outcome: 'aborted', terminal_reason: reason, terminal_actor: actor })
}

export function reconcile({ lane, checkout, crewDir, dbPath, dryRun = false, reason = RECONCILE_DEFAULT_REASON, actor = 'operator', session: suppliedSession, deps } = {}) {
  const d = normalDeps(deps)
  const name = typeof lane === 'string' ? lane : String(lane ?? '')
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const stateDir = typeof crewDir === 'string' && crewDir.trim() ? crewDir : dirname(crewJsonPath({ checkout: root, lane: name, deps: d }))
  const proposed = {
    status: RECONCILE_TERMINAL_STATUS,
    outcome: RECONCILE_TERMINAL_OUTCOME,
    terminal_reason: typeof reason === 'string' && reason.trim() ? reason.trim() : RECONCILE_DEFAULT_REASON,
    terminal_actor: typeof actor === 'string' && actor.trim() ? actor.trim() : 'operator',
  }
  const report = {
    event: 'closeout-reconcile',
    lane: name,
    crew_dir: stateDir,
    dry_run: dryRun === true,
    observed_at: null,
    identity: null,
    source: null,
    reason: null,
    observation: null,
    proposed_terminal_result: proposed,
    envelope: null,
    result: 'refused',
    refusal: null,
  }
  let ledger
  try {
    const openPath = typeof dbPath === 'string' && dbPath.trim() ? dbPath : d.defaultDbPath()
    ledger = d.openLedger({ dbPath: openPath, readOnly: dryRun === true, stderr: { write() {} } })
    let session = reconcileSession({ ledger, lane: name, checkout: root, supplied: suppliedSession })
    if (!session) refuse(`no unsettled ledger session found for ${name}`, CLOSEOUT_REFUSALS.RECONCILE_SESSION_ABSENT, 'reconcile')
    if (session.ended_at != null) refuse(`ledger session is already settled for ${name}`, CLOSEOUT_REFUSALS.RECONCILE_SESSION_SETTLED, 'reconcile')
    const measuredAt = reconcileObservedAt(d.now())
    if (measuredAt === null) refuse(`reconcile observation time is unavailable for ${name}`, CLOSEOUT_REFUSALS.RECONCILE_EVIDENCE_UNKNOWN, 'reconcile')
    report.observed_at = measuredAt
    const identity = d.probeDriverIdentity({ dir: stateDir, task: name, repo: basename(root) }, d)
    const identityState = ['alive', 'gone', 'unknown'].includes(identity?.driver_state ?? identity?.state)
      ? (identity.driver_state ?? identity.state)
      : 'unknown'
    report.identity = identity && typeof identity === 'object' ? { ...identity, driver_state: identityState } : { driver_state: 'unknown' }
    report.source = identity?.source ?? null
    report.reason = identity?.reason_code ?? null
    const observation = {
      adw_id: session.adw_id,
      observed_at: measuredAt,
      observer: `closeout.reconcile:${report.proposed_terminal_result.terminal_actor}`,
      driver_state: identityState,
      source: identity?.source ?? 'heartbeat',
      reason_code: identity?.reason_code ?? 'identity-unmeasured',
      detail: identity?.detail ?? {},
    }
    report.observation = observation
    if (observation.driver_state !== 'gone') return reconciliationRefusal(observation.driver_state)
    if (observation.source !== 'process_group') return reconciliationRefusal('unknown')
    report.envelope = terminalEnvelopeEvidence({ crewDir: stateDir, deps: d })
    const terminalEnvelope = report.envelope.state === 'terminal' ? report.envelope : null
    if (report.envelope.state === 'unknown') refuse(`terminal envelope evidence is unknown for ${name}`, CLOSEOUT_REFUSALS.RECONCILE_EVIDENCE_UNKNOWN, 'reconcile')
    if (terminalEnvelope !== null) return reconciliationRefusal('terminal-envelope-present')
    const actor = proposed.terminal_actor
    const reason = proposed.terminal_reason
    if (!dryRun) {
      if (typeof ledger.recordRunObservation !== 'function') refuse(`ledger does not support run observations for ${name}`, CLOSEOUT_REFUSALS.RECONCILE_WRITE_FAILED, 'reconcile')
      ledger.recordRunObservation(observation)
      const latest = typeof ledger.getSession === 'function' ? ledger.getSession(session.adw_id) : session
      if (latest && latest.ended_at != null) refuse(`ledger session settled during reconcile for ${name}`, CLOSEOUT_REFUSALS.RECONCILE_SESSION_SETTLED, 'reconcile')
      session = latest || session
    }
    if (!dryRun) commitReconciliation({ ledger, session, observation, actor, reason })
    report.terminal = !dryRun && typeof ledger.getSession === 'function' ? ledger.getSession(session.adw_id) : null
    report.result = dryRun ? 'would-reconcile' : 'reconciled'
  } catch (error) {
    const refusal = error instanceof CloseoutRefusal
      ? error
      : new CloseoutRefusal(error?.message || String(error), CLOSEOUT_REFUSALS.INTERNAL, 'reconcile')
    report.refusal = refusalObject(refusal)
  } finally {
    try { ledger?.close?.() } catch { /* evidence already captured */ }
  }
  d.log(JSON.stringify(report))
  return { verb: 'reconcile', lane: name, report, refusal: report.refusal, code: report.refusal ? EXIT_REFUSED : EXIT_OK }
}

export const USAGE = 'usage: node scripts/factory/closeout.mjs (merge-check <lane…> | reap <lane…> | recover <lane> | reconcile <lane>) [--checkout <dir>] [--dry-run]'

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new CloseoutUsageError(USAGE)
  let verb = null
  let checkout = process.cwd()
  let checkout_explicit = false
  let help = false
  let dry_run = false
  let reason = null
  const lanes = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { help = true; continue }
    if (argument === '--dry-run') { dry_run = true; continue }
    if (argument === '--reason') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) throw new CloseoutUsageError(`${USAGE}: --reason requires a value`)
      reason = value
      index += 1
      continue
    }
    if (argument === '--checkout') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) throw new CloseoutUsageError(`${USAGE}: --checkout requires a value`)
      checkout = value
      checkout_explicit = true
      index += 1
      continue
    }
    if (typeof argument !== 'string' || argument.startsWith('--')) throw new CloseoutUsageError(`${USAGE}: unknown option ${String(argument)}`)
    if (!verb) verb = argument
    else lanes.push(argument)
  }
  if (help) return { verb, lanes, checkout, checkout_explicit, help }
  if (!CLOSEOUT_VERBS.includes(verb)) throw new CloseoutUsageError(`${USAGE}: unknown verb ${String(verb)}`)
  if (dry_run && verb !== 'reconcile') throw new CloseoutUsageError(`${USAGE}: --dry-run is only valid for reconcile`)
  if (reason !== null && verb !== 'reconcile') throw new CloseoutUsageError(`${USAGE}: --reason is only valid for reconcile`)
  if (lanes.length === 0) throw new CloseoutUsageError(`${USAGE}: at least one lane is required`)
  if (verb === 'recover' && lanes.length !== 1) throw new CloseoutUsageError(`${USAGE}: recover accepts exactly one lane`)
  const parsed = { verb, lanes, checkout, checkout_explicit, help }
  if (dry_run) parsed.dry_run = true
  if (reason !== null) parsed.reason = reason
  return parsed
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
        : parsed.verb === 'recover'
          ? recover({ ...options, lane: parsed.lanes[0], checkoutExplicit: parsed.checkout_explicit })
          : reconcile({ ...options, lane: parsed.lanes[0], dryRun: parsed.dry_run === true, reason: parsed.reason })
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

const invokedDirectly = import.meta.main
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2))
