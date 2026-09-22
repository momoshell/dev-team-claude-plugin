#!/usr/bin/env node
// Mutant census: discover deduplicated survived diff mutants from the
// ${HOME}/.crew report corpus, classify applicability against a checkout,
// optionally run a bounded tranche of the full suite with restoration, and
// report every rate with its denominator and remainder.
//
// Sequential in-place target mutation plus `finally` restoration is deliberate.
// lean: one census process per checkout; move runs to disposable worktrees before adding parallel workers.
// A SIGKILL cannot run JavaScript restoration, so never run two censuses
// against one checkout and never claim crash-proof cleanup.
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatRate, restoreSnapshot, snapshotFile } from './kill-redundancy.mjs'

export const CENSUS_REPORT_SUFFIX = '.report.json'

export const CLASSIFICATION_REASONS = new Set([
  'applies-once',
  'text-absent',
  'text-ambiguous',
  'file-absent',
])

export class CensusError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'CensusError'
    this.code = code
    this.detail = detail
  }
}

function compareId(a, b) {
  const left = typeof a === 'string' ? a : a?.id
  const right = typeof b === 'string' ? b : b?.id
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isSafeRepoPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.startsWith('/') || path.includes('\\')) return false
  const segments = path.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function rerunKey(mutant) {
  return JSON.stringify([mutant.path, mutant.line ?? null, mutant.operator ?? null, mutant.original, mutant.replacement])
}

// Every report path is named before any report is read, so a rerun over an
// unchanged corpus reads the same files in the same order.
function collectReportPaths(corpus) {
  let root
  try {
    root = resolve(corpus)
  } catch {
    throw new CensusError('corpus-unreadable', String(corpus))
  }
  const found = []
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      throw new CensusError('corpus-unreadable', `${dir}: ${err?.message ?? String(err)}`)
    }
    for (const entry of names) {
      const full = join(dir, entry.name)
      let stat
      try {
        stat = lstatSync(full)
      } catch (err) {
        throw new CensusError('corpus-unreadable', `${full}: ${err?.message ?? String(err)}`)
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) pending.push(full)
      else if (stat.isFile() && entry.name.endsWith(CENSUS_REPORT_SUFFIX)) found.push(full)
    }
  }
  return found.sort()
}

function readReport(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new CensusError('report-unreadable', `${path}: ${err?.message ?? String(err)}`)
  }
  let report
  try {
    report = JSON.parse(raw)
  } catch (err) {
    throw new CensusError('report-malformed', `${path}: ${err?.message ?? String(err)}`)
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.mutants)) {
    throw new CensusError('report-malformed', `${path}: expected an object with a mutants array`)
  }
  return report
}

function validateSurvivor(row, reportPath) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new CensusError('mutant-malformed', `${reportPath}: survived row is not an object`)
  }
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new CensusError('mutant-malformed', `${reportPath}: survived row has no id`)
  }
  if (!isSafeRepoPath(row.path)) {
    throw new CensusError('mutant-malformed', `${reportPath}: survived row ${row.id} has an unsafe path`)
  }
  if (typeof row.original !== 'string' || row.original.length === 0) {
    throw new CensusError('mutant-malformed', `${reportPath}: survived row ${row.id} has no original text`)
  }
  if (typeof row.replacement !== 'string') {
    throw new CensusError('mutant-malformed', `${reportPath}: survived row ${row.id} has no replacement text`)
  }
  return { id: row.id, path: row.path, line: row.line ?? null, operator: row.operator ?? null, original: row.original, replacement: row.replacement }
}

export function discoverSurvivors(corpus = join(homedir(), '.crew')) {
  const paths = collectReportPaths(corpus)
  const byId = new Map()
  const survived = []
  for (const path of paths) {
    const report = readReport(path)
    for (const row of report.mutants) {
      if (!row || typeof row !== 'object' || row.outcome !== 'survived') continue
      const mutant = validateSurvivor(row, path)
      survived.push(mutant)
      const prior = byId.get(mutant.id)
      if (prior === undefined) byId.set(mutant.id, mutant)
      else if (rerunKey(prior) !== rerunKey(mutant)) {
        throw new CensusError('duplicate-conflict', `id ${mutant.id} reruns with different fields in ${path}`)
      }
    }
  }
  function distinct() {
    return [...byId.values()].sort(compareId)
  }
  return {
    rows: distinct(),
    scanned: paths.length,
    readable: paths.length,
    survived: survived.length,
    distinct: byId.size,
  }
}

export function assertClassificationReason(reason) {
  if (!CLASSIFICATION_REASONS.has(reason)) throw new CensusError('classification-reason-invalid', reason)
  return reason
}

// Containment is measured on REAL paths, not lexical ones. A checkout file that is a
// symlink into the evidence corpus is lexically inside the checkout and physically is
// not: Sol pointed one at ~/.crew and the mutation wrote through it. realpath collapses
// the alias, so the refusal sees where the write would actually land. The parent is
// resolved separately so a target that does not exist yet still gets a real root.
function resolveTarget(checkout, repoPath) {
  const root = realOrSelf(resolve(checkout))
  const lexical = resolve(root, repoPath)
  if (lexical !== root && !lexical.startsWith(root + sep)) {
    throw new CensusError('unsafe-target', repoPath)
  }
  let abs
  try {
    abs = realpathSync(lexical)
  } catch {
    abs = join(realOrSelf(dirname(lexical)), basename(lexical))
  }
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new CensusError('unsafe-target', `${repoPath} resolves outside the checkout`)
  }
  return abs
}

function realOrSelf(path) {
  try { return realpathSync(path) } catch { return path }
}

export function classifyMutant(mutant, { checkout = process.cwd(), readFile = readFileSync } = {}) {
  if (!isSafeRepoPath(mutant?.path)) throw new CensusError('mutant-malformed', 'mutant path is not a safe repo-relative path')
  if (typeof mutant?.original !== 'string' || mutant.original.length === 0) {
    throw new CensusError('mutant-malformed', `mutant ${mutant?.id ?? '(no id)'} has no original text`)
  }
  const abs = resolveTarget(checkout, mutant.path)
  let text
  try {
    text = readFile(abs, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { ...mutant, reason: 'file-absent', runnable: false }
    throw new CensusError('target-unreadable', `${mutant.path}: ${err?.message ?? String(err)}`)
  }
  const occurrences = text.split(mutant.original).length - 1
  if (occurrences === 0) return { ...mutant, reason: 'text-absent', runnable: false }
  if (occurrences > 1) return { ...mutant, reason: 'text-ambiguous', runnable: false }
  return { ...mutant, reason: 'applies-once', runnable: true }
}

export function classifyMutants(mutants, options = {}) {
  return (mutants ?? []).map((mutant) => classifyMutant(mutant, options))
}

export function parseRunCount(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new CensusError('run-invalid', `--run accepts only a non-negative safe integer, got ${value}`)
  const count = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new CensusError('run-invalid', `--run accepts only a non-negative safe integer, got ${value}`)
  return count
}

export function selectTranche(classified, count) {
  count = parseRunCount(count)
  const applicable = (classified ?? []).filter((mutant) => mutant?.runnable === true)
  return applicable.sort(compareId).slice(0, count)
}

// Every suite child this process starts is tracked here so a catchable signal
// can kill the suite before the census re-raises it; otherwise an interrupted
// `--run` leaves `npm test` running in a checkout the next run mutates, breaking
// the one-census-per-checkout invariant. Children are spawned detached so the
// kill reaches the whole suite process group, not just the npm wrapper.
const liveSuiteChildren = new Set()
function killSuiteChildren() {
  for (const child of liveSuiteChildren) {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    try { child.kill('SIGKILL') } catch {}
  }
  liveSuiteChildren.clear()
}
export function defaultRunSuite({ checkout }) {
  return new Promise((settle) => {
    let done = false
    const resolveOnce = (value) => { if (!done) { done = true; settle(value) } }
    let child
    try {
      child = spawn('npm', ['test'], { cwd: checkout, shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
    } catch (err) {
      resolveOnce({ status: null, signal: null, error: err })
      return
    }
    liveSuiteChildren.add(child)
    child.on('error', (error) => { liveSuiteChildren.delete(child); resolveOnce({ status: null, signal: null, error }) })
    child.on('close', (status, signal) => { liveSuiteChildren.delete(child); resolveOnce({ status, signal, error: null }) })
  })
}

function interpretSuiteResult(result) {
  if (!result || typeof result !== 'object') return { outcome: 'unmeasured', reason: 'runner-indeterminate' }
  if (result.error != null || result.signal != null) {
    return { outcome: 'unmeasured', reason: result.error?.code === 'ETIMEDOUT' ? 'suite-timeout' : 'suite-indeterminate' }
  }
  if (result.status === 0) return { outcome: 'survived' }
  if (typeof result.status === 'number') return { outcome: 'killed' }
  return { outcome: 'unmeasured', reason: 'suite-indeterminate' }
}

// A catchable signal must leave pristine bytes: while a snapshot is live, each
// handler synchronously restores through the validated helper, removes all
// handlers, and re-raises the same signal. The synchronous spawnSync suite never
// ran these callbacks, so the runner is asynchronous (see defaultRunSuite).
// SIGKILL cannot run JavaScript restoration; never claim otherwise.
const RESTORATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
function installRestorationHandlers(restore) {
  const handlers = new Map()
  function removeRestorationHandlers() {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    handlers.clear()
  }
  for (const signal of RESTORATION_SIGNALS) {
    const handler = () => {
      try { killSuiteChildren(); restore() } finally {
        removeRestorationHandlers()
        process.kill(process.pid, signal)
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return removeRestorationHandlers
}
function restoreMutantSnapshot(checkout, mutant, snapshot) {
  const currentRestoreTarget = resolveTarget(checkout, mutant.path)
  if (currentRestoreTarget !== snapshot.path) throw new CensusError('unsafe-target', `${mutant.path} moved during the run; mutant bytes remain at ${snapshot.path} (expected sha256 ${snapshot.sha256})`)
  restoreSnapshot(snapshot)
}
export async function runTranche(selected, { checkout = process.cwd(), runSuite = defaultRunSuite } = {}) {
  const results = []
  for (const mutant of selected ?? []) {
    try {
    const abs = resolveTarget(checkout, mutant.path)
    const snapshot = snapshotFile(abs)
    const removeRestorationHandlers = installRestorationHandlers(() => restoreMutantSnapshot(checkout, mutant, snapshot))
    let wrote = false
    let rowsBeforeVerdict = results.length
    try {
      const text = snapshot.bytes.toString('utf8')
      const first = text.indexOf(mutant.original)
      if (first === -1 || text.lastIndexOf(mutant.original) !== first) {
        results.push({ id: mutant.id, path: mutant.path, outcome: 'unmeasured', reason: 'target-changed' })
        continue
      }
      const currentWriteTarget = resolveTarget(checkout, mutant.path)
      if (currentWriteTarget !== snapshot.path) throw new CensusError('unsafe-target', `${mutant.path} moved before the write`)
      writeFileSync(currentWriteTarget, `${text.slice(0, first)}${mutant.replacement}${text.slice(first + mutant.original.length)}`)
      wrote = true
      rowsBeforeVerdict = results.length
      const verdict = interpretSuiteResult(await runSuite({ checkout, mutant, abs: currentWriteTarget }))
      results.push({ id: mutant.id, path: mutant.path, outcome: verdict.outcome, ...(verdict.reason ? { reason: verdict.reason } : {}) })
    } finally {
      removeRestorationHandlers()
      try {
        restoreMutantSnapshot(checkout, mutant, snapshot)
      } catch (restoreErr) {
        const isRefusal = restoreErr instanceof CensusError && restoreErr.code === 'unsafe-target'
        // Any failure after the write leaves mutant bytes installed, refusal
        // or not: name the dirty path and its expected sha256. Reword
        // refusals; annotate anything else as context on the original error
        // so its errno still reaches the caller (a blind spot is stated).
        const residue = `${mutant.path} moved during the run; mutant bytes remain at ${snapshot.path} (expected sha256 ${snapshot.sha256})`
        if (!wrote && isRefusal) {
          // Nothing was written for this mutant (target-changed skip, or a
          // pre-write refusal already propagating): never write through a
          // swapped path to "restore". Falling through skips only the
          // redundant restore; a propagating body error continues past this
          // finally untouched (a `continue`/`return` here would discard it).
        } else {
          let errToThrow = restoreErr
          if (isRefusal && restoreErr.detail !== residue) errToThrow = new CensusError('unsafe-target', residue)
          if (wrote && isRefusal) {
            // The suite verdict recorded above was measured against a target
            // that has since moved, so it is not a measurement: replace it
            // with the refusal before the error escapes, so the outer catch
            // attaches the corrected rows.
            results.length = rowsBeforeVerdict
            results.push({ id: mutant.id, path: mutant.path, outcome: 'unmeasured', reason: 'restore-refused' })
          } else if (wrote) {
            restoreErr.residue = residue
          }
          throw errToThrow
        }
      }
    }
    } catch (err) {
      // Single attachment point for every mid-tranche abort — resolveTarget
      // and snapshotFile before the inner try included, and non-refusal
      // restore failures too: the completed rows travel on the error so main
      // can still print a partial summary. Only object errors can carry rows;
      // anything else rethrows untouched rather than masking itself.
      if (err !== null && (typeof err === 'object' || typeof err === 'function')) err.results = results
      throw err
    }
  }
  return results
}

export function summarizeCensus({ discovery, classified, requested = 0, results = [] } = {}) {
  const distinct = (classified ?? []).length
  const counts = { 'applies-once': 0, 'text-absent': 0, 'text-ambiguous': 0, 'file-absent': 0 }
  for (const mutant of classified ?? []) {
    assertClassificationReason(mutant?.reason)
    counts[mutant.reason] += 1
  }
  const applicable = counts['applies-once']
  const selected = (results ?? []).length
  const killed = (results ?? []).filter((row) => row?.outcome === 'killed').length
  const survived = (results ?? []).filter((row) => row?.outcome === 'survived').length
  const measured = killed + survived
  const executionUnmeasured = selected - measured
  const applicableRemainder = applicable - selected
  const json = {
    discovery: {
      scanned: discovery?.scanned ?? 0,
      readable: discovery?.readable ?? 0,
      survived: discovery?.survived ?? 0,
      distinct: discovery?.distinct ?? distinct,
    },
    classification: {
      distinct,
      applies_once: counts['applies-once'],
      text_absent: counts['text-absent'],
      text_ambiguous: counts['text-ambiguous'],
      file_absent: counts['file-absent'],
    },
    run: {
      requested,
      applicable,
      selected,
      measured,
      killed,
      survived,
      execution_unmeasured: executionUnmeasured,
      applicable_remainder: applicableRemainder,
      results: results ?? [],
    },
  }
  const lines = [
    `Reports: ${formatRate(json.discovery.readable, json.discovery.scanned)}`,
    `Survived records: ${json.discovery.survived}`,
    `Distinct: ${formatRate(json.discovery.distinct, json.discovery.survived)}`,
    `Applies once: ${formatRate(counts['applies-once'], distinct)}`,
    `Text absent: ${formatRate(counts['text-absent'], distinct)}`,
    `Text ambiguous: ${formatRate(counts['text-ambiguous'], distinct)}`,
    `File absent: ${formatRate(counts['file-absent'], distinct)}`,
    `Selected: ${formatRate(selected, applicable)}`,
    `Killed: ${formatRate(killed, measured)}`,
    `Survived: ${formatRate(survived, measured)}`,
    `Execution unmeasured: ${formatRate(executionUnmeasured, selected)}`,
    `Applicable remainder: ${formatRate(applicableRemainder, applicable)}`,
  ]
  return { json, lines }
}

export { summarizeCensus as summaryCensus }

const USAGE = [
  'usage: node scripts/factory/mutant-census.mjs [--corpus <dir>] [--checkout <dir>] [--run <n>]',
  '  --corpus <dir>    report corpus root (default ${HOME}/.crew)',
  '  --checkout <dir>  checkout the mutants apply to (default cwd)',
  '  --run <n>         run the first n applicable mutants through `npm test` (default 0: classify only)',
].join('\n')

export function parseArgs(argv = []) {
  const parsed = { corpus: join(homedir(), '.crew'), checkout: process.cwd(), run: 0 }
  const args = [...(argv ?? [])]
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]
    if (flag === '--help') throw new CensusError('help', USAGE)
    const needs = (name) => {
      const value = args[++i]
      if (value === undefined || value.startsWith('--')) throw new CensusError('arg-missing', `${name} requires a value`)
      return value
    }
    if (flag === '--corpus') parsed.corpus = needs(flag)
    else if (flag === '--checkout') parsed.checkout = needs(flag)
    else if (flag === '--run') parsed.run = parseRunCount(needs(flag))
    else throw new CensusError('arg-unknown', `unknown flag ${flag}`)
  }
  return parsed
}

export function assertDisjointRoots(corpus, checkout) {
  const corpusRoot = realOrSelf(resolve(corpus))
  const checkoutRoot = realOrSelf(resolve(checkout))
  const contains = (outer, inner) => inner === outer || inner.startsWith(outer + sep)
  if (contains(corpusRoot, checkoutRoot) || contains(checkoutRoot, corpusRoot)) {
    throw new CensusError('roots-overlap', `the corpus ${corpusRoot} and the checkout ${checkoutRoot} overlap; a run would mutate the evidence it reads`)
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? console.log
  const options = parseArgs(argv)
  const discovery = discoverSurvivors(options.corpus)
  const classified = classifyMutants(discovery.rows, { checkout: options.checkout })
  const tranche = selectTranche(classified, options.run)
  // The corpus is evidence and has no second copy; the checkout is the thing this
  // program deliberately mutates. If one contains the other, a run writes into the
  // evidence. Classification is read-only and stays allowed — only the mutating
  // tranche is refused (Sol, 2nd pass).
  // MUTATION: drop this guard and `--corpus X --checkout X --run 1` mutates the corpus.
  if (options.run !== 0) assertDisjointRoots(options.corpus, options.checkout)
  let results
  try {
    results = options.run === 0 ? [] : await runTranche(tranche, { checkout: options.checkout, runSuite: deps.runSuite })
  } catch (err) {
    // A mid-tranche abort carries the measurements completed so far: print the
    // partial summary before the error propagates, so hours of suite runs are
    // not discarded with it. Any error with rows travels, not just closed
    // CensusErrors — filesystem codes stay closed and unwrapped.
    if (Array.isArray(err.results)) {
      const partial = summarizeCensus({ discovery, classified, requested: options.run, results: err.results })
      stdout(JSON.stringify(partial.json))
      for (const line of partial.lines) stdout(line)
    }
    throw err
  }
  const summary = summarizeCensus({ discovery, classified, requested: options.run, results })
  stdout(JSON.stringify(summary.json))
  for (const line of summary.lines) stdout(line)
  return summary
}

const invokedAsCli = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedAsCli) {
  try {
    await main()
  } catch (err) {
    if (err instanceof CensusError && err.code === 'help') {
      console.log(USAGE)
    } else if (err instanceof CensusError) {
      console.error(`census-error [${err.code}] ${err.detail ?? ''}`.trim())
      process.exitCode = 2
    } else {
      console.error(err?.stack ?? String(err))
      process.exitCode = 1
    }
  }
}
