#!/usr/bin/env node
// scripts/factory/suite-cost.mjs — a read-only, repository-wide test-suite cost
// sweep. Importing this module never runs a suite; the CLI is the only runner.

import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_RUNS = 3
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 128 * 1024 * 1024
const CLOSED_REASONS = new Set([
  'spawn-denied',
  'nonzero-exit',
  'timeout',
  'interrupted',
  'empty-output',
  'malformed-tap',
  'clock-unavailable',
  'not-measured',
  'test-count-varied',
])

export const USAGE = 'usage: node scripts/factory/suite-cost.mjs [--checkout <dir>] [--runs <n>] [--timeout-ms <n>] [--json]'

class SuiteCostUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SuiteCostUsageError'
  }
}

function normalisePath(path) {
  return String(path).replaceAll('\\', '/')
}

function normaliseSuite(path) {
  const value = normalisePath(path)
  return value.startsWith('./') ? value.slice(2) : value
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : null
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function normalDeps(deps = {}) {
  const source = deps && typeof deps === 'object' ? deps : {}
  const clock = source.clock
  const clockNow = typeof clock === 'function'
    ? clock
    : (typeof clock?.now === 'function' ? () => clock.now() : null)
  return {
    spawn: source.spawn || source.spawnSync || spawnSync,
    lstatSync: source.lstatSync || source.statSync || lstatSync,
    statSync: source.statSync || statSync,
    readFileSync: source.readFileSync || readFileSync,
    git: source.git || null,
    env: source.env || process.env,
    now: source.now || clockNow || (() => Number(process.hrtime.bigint()) / 1e6),
    stdout: source.stdout || ((text) => process.stdout.write(text)),
    stderr: source.stderr || ((text) => process.stderr.write(text)),
  }
}

function spawnOptions({ cwd, timeoutMs, env }) {
  const childEnv = { ...env }
  delete childEnv.FORCE_COLOR
  delete childEnv.CLICOLOR_FORCE
  return {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    env: childEnv,
  }
}

function spawnFailureReason(result) {
  if (!result) return 'spawn-denied'
  const errorCode = result.error?.code
  if (errorCode === 'ETIMEDOUT' || result.timedOut === true) return 'timeout'
  if (result.error) {
    if (errorCode === 'EINTR' || errorCode === 'SIGINT' || errorCode === 'SIGTERM') return 'interrupted'
    return 'spawn-denied'
  }
  if (result.timedOut === true) return 'timeout'
  if (result.signal) return 'interrupted'
  if (!Number.isInteger(result.status)) return 'interrupted'
  if (result.status !== 0) return 'nonzero-exit'
  return null
}

function outputOf(result) {
  if (typeof result?.stdout === 'string') return result.stdout
  if (Buffer.isBuffer(result?.stdout)) return result.stdout.toString('utf8')
  return ''
}

function elapsedSeconds(start, end) {
  const delta = Number(end) - Number(start)
  return Number.isFinite(delta) && delta >= 0 ? delta / 1000 : null
}

function readNow(d) {
  try {
    const value = d.now()
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function gitResult(d, checkout, args) {
  const options = { cwd: checkout, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: DEFAULT_TIMEOUT_MS }
  if (d.git) return d.git(checkout, args, options)
  return d.spawn('git', args, options)
}

function gitText(result) {
  if (typeof result === 'string') return result
  if (Buffer.isBuffer(result?.stdout)) return result.stdout.toString('utf8')
  return typeof result?.stdout === 'string' ? result.stdout : null
}

function gitFailure(result) {
  if (typeof result === 'string' || Buffer.isBuffer(result)) return null
  if (!result) return 'git-spawn-denied'
  if (result.error?.code === 'ETIMEDOUT' || result.timedOut) return 'git-timeout'
  if (result.error) return 'git-spawn-denied'
  if (result.signal) return 'git-interrupted'
  if (result.status !== 0) return 'git-nonzero-exit'
  if (gitText(result) == null) return 'git-empty-output'
  return null
}

function regularFile(path, d) {
  try {
    const stat = d.lstatSync(path)
    return typeof stat?.isFile === 'function' && stat.isFile()
  } catch {
    return false
  }
}

// Discovery is deliberately the same git partition used by the operator: both
// cached and untracked paths are visible, but ignored paths are not. A stat gate
// prevents deleted index entries, directories, and symlinks from becoming suites.
export function trackedSuites({ checkout = process.cwd(), deps = {} } = {}) {
  const d = normalDeps(deps)
  const args = ['ls-files', '-co', '--exclude-standard', '-z']
  let result
  try {
    result = gitResult(d, checkout, args)
  } catch (error) {
    throw new Error(`suite-cost: cannot discover tracked suites: ${error?.code || error?.message || 'spawn-denied'}`)
  }
  const failure = gitFailure(result)
  if (failure) throw new Error(`suite-cost: cannot discover tracked suites: ${failure}`)
  const text = gitText(result)
  const names = text.split('\0')
    .filter(Boolean)
    .map(normaliseSuite)
    .filter((suite, index, all) => suite.endsWith('.test.mjs') && all.indexOf(suite) === index)
    .filter((suite) => regularFile(join(checkout, ...suite.split('/')), d))
  return names.sort()
}

function parseSummary(lines, key, end) {
  for (let index = end; index >= 0; index -= 1) {
    const match = lines[index].match(new RegExp(`^# ${key}\\s+(\\d+)\\s*$`))
    if (match) return Number(match[1])
  }
  return null
}

function parsePlan(lines, end) {
  for (let index = end; index >= 0; index -= 1) {
    const match = lines[index].match(/^1\.\.(\d+)\s*$/)
    if (match) return Number(match[1])
  }
  return null
}

// Parse only the final runner summary. A child suite may print its own TAP-like
// text, so all totals are selected from their last occurrence rather than from
// the first one. Top-level Subtest blocks carry the per-test durations; nested
// describe children are intentionally not counted as a second runner test.
export function parseTap(input) {
  if (typeof input !== 'string' || input.trim() === '') return null
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  const summaryAt = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^# tests\s+\d+\s*$/.test(lines[index])) summaryAt.push(index)
  }
  const end = summaryAt.at(-1)
  const start = (summaryAt.at(-2) ?? -1) + 1
  if (end == null) return null
  const summaryEnd = lines.length - 1
  const tests = parseSummary(lines, 'tests', summaryEnd)
  const suites = parseSummary(lines, 'suites', summaryEnd)
  const pass = parseSummary(lines, 'pass', summaryEnd)
  const fail = parseSummary(lines, 'fail', summaryEnd)
  const cancelled = parseSummary(lines, 'cancelled', summaryEnd)
  const skipped = parseSummary(lines, 'skipped', summaryEnd)
  const todo = parseSummary(lines, 'todo', summaryEnd)
  const plan = parsePlan(lines, summaryEnd)
  if (![tests, suites, pass, fail, cancelled, skipped, todo, plan].every(Number.isInteger)) return null
  if (tests < 0 || suites < 0 || pass < 0 || fail < 0 || cancelled < 0 || skipped < 0 || todo < 0) return null
  if (plan !== tests) return null

  const durations = []
  for (let index = start; index < end; index += 1) {
    const title = lines[index].match(/^# Subtest:\s*(.+?)\s*$/)?.[1]
    if (!title) continue
    let duration = null
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (/^# Subtest:\s*/.test(lines[cursor])) break
      const match = lines[cursor].match(/^\s+duration_ms:\s*([0-9]+(?:\.[0-9]+)?)\s*$/)
      if (match) { duration = Number(match[1]); break }
    }
    if (Number.isFinite(duration)) durations.push({ title, duration_ms: duration })
  }
  return { test_count: tests, suites, pass, fail, cancelled, skipped, todo, tests: durations }
}

function baseMeasurement(suite) {
  return {
    suite,
    duration_seconds: null,
    test_count: null,
    seconds_per_test: null,
    reason: null,
    slowest_tests: [],
  }
}

function measureConfig(input, options) {
  if (typeof input === 'string') return { ...(options || {}), suite: normaliseSuite(input) }
  return { ...(input || {}) }
}

// Run a single suite in isolation. Every sample must provide a clean exit and a
// parseable TAP summary; a partial population is unknown, never a zero.
export function measureSuite(input, options = {}) {
  const config = measureConfig(input, options)
  const suite = normaliseSuite(config.suite || '')
  const checkout = config.checkout || process.cwd()
  const runs = config.runs === undefined ? DEFAULT_RUNS : Number(config.runs)
  const timeoutMs = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(config.timeoutMs)
  const d = normalDeps(config.deps)
  const result = baseMeasurement(suite)
  if (!suite.endsWith('.test.mjs') || !Number.isInteger(runs) || runs < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    result.reason = 'not-measured'
    return result
  }

  const samples = []
  let closedReason = null
  for (let index = 0; index < runs; index += 1) {
    const started = readNow(d)
    let child
    try {
      child = d.spawn(process.execPath, ['--test', '--test-reporter=tap', suite], spawnOptions({ cwd: checkout, timeoutMs, env: d.env }))
    } catch {
      closedReason ||= 'spawn-denied'
      continue
    }
    const ended = readNow(d)
    const spawnReason = spawnFailureReason(child)
    if (spawnReason) {
      closedReason ||= spawnReason
      continue
    }
    const duration = elapsedSeconds(started, ended)
    if (duration === null) {
      closedReason ||= 'clock-unavailable'
      continue
    }
    const output = outputOf(child)
    if (output.trim() === '') {
      closedReason ||= 'empty-output'
      continue
    }
    const parsed = parseTap(output)
    if (!parsed) {
      closedReason ||= 'malformed-tap'
      continue
    }
    if (parsed.fail > 0) {
      closedReason ||= 'nonzero-exit'
      continue
    }
    samples.push({ duration, parsed })
  }
  if (closedReason || samples.length !== runs) {
    result.reason = closedReason || 'not-measured'
    return result
  }

  const counts = new Set(samples.map(({ parsed }) => parsed.test_count))
  if (counts.size !== 1) {
    result.reason = 'test-count-varied'
    return result
  }
  const testCount = samples[0].parsed.test_count
  const wall = median(samples.map(({ duration }) => duration))
  if (wall === null) {
    result.reason = 'clock-unavailable'
    return result
  }
  const durationsByTitle = new Map()
  for (const { parsed } of samples) {
    for (const item of parsed.tests) {
      const values = durationsByTitle.get(item.title) || []
      values.push(item.duration_ms)
      durationsByTitle.set(item.title, values)
    }
  }
  const slowest = [...durationsByTitle.entries()]
    .map(([title, values]) => ({ title, duration_ms: median(values) }))
    .sort((a, b) => b.duration_ms - a.duration_ms || a.title.localeCompare(b.title))
    .map(({ title }) => title)
  return {
    suite,
    duration_seconds: wall,
    test_count: testCount,
    seconds_per_test: testCount > 0 ? wall / testCount : null,
    reason: null,
    slowest_tests: slowest,
  }
}

function rowFromMeasurement(suite, measurement) {
  const value = measurement && typeof measurement === 'object' ? measurement : {}
  const duration = finite(value.duration_seconds)
  const testCount = Number.isInteger(value.test_count)
    ? value.test_count
    : (Number.isInteger(value.tests) ? value.tests : null)
  const reason = duration === null
    // RV1-6: a reason outside the closed set NEVER enters the record verbatim.
    // Passing an arbitrary string through would put open vocabulary into committed
    // data, which is the shape 'one closed reason' exists to prevent.
    ? (CLOSED_REASONS.has(value.reason) ? value.reason : 'not-measured')
    : null
  return {
    suite,
    duration_seconds: duration,
    test_count: testCount,
    seconds_per_test: duration !== null && testCount > 0 ? duration / testCount : null,
    reason,
    slowest_tests: Array.isArray(value.slowest_tests) ? value.slowest_tests.filter((title) => typeof title === 'string') : [],
  }
}

export function summarizeSuiteCosts(input = {}) {
  const config = Array.isArray(input) ? { measurements: input } : (input || {})
  const measurements = Array.isArray(config.measurements) ? config.measurements : []
  const tracked = Array.isArray(config.tracked) ? config.tracked : []
  const bySuite = new Map()
  for (const measurement of measurements) {
    const suite = normaliseSuite(measurement?.suite || '')
    if (suite && !bySuite.has(suite)) bySuite.set(suite, measurement)
  }
  const suites = [...new Set([...tracked, ...bySuite.keys()].map(normaliseSuite))]
    .filter((suite) => suite.endsWith('.test.mjs'))
    .sort()
  const rows = suites.map((suite) => rowFromMeasurement(suite, bySuite.get(suite)))
  const durations = rows.map((row) => row.duration_seconds).filter(Number.isFinite)
  const distribution = durations.length === 0
    ? { min: null, q1: null, median: null, q3: null, iqr: null, p90: null, max: null }
    : (() => {
        const q1 = quantile(durations, 0.25)
        const q3 = quantile(durations, 0.75)
        return {
          min: quantile(durations, 0),
          q1,
          median: quantile(durations, 0.5),
          q3,
          iqr: q3 - q1,
          p90: quantile(durations, 0.9),
          max: quantile(durations, 1),
        }
      })()
  const slowest = rows
    .filter((row) => Number.isFinite(row.duration_seconds))
    .sort((a, b) => b.duration_seconds - a.duration_seconds || a.suite.localeCompare(b.suite))
    .map((row) => row.suite)
  return {
    denominator: {
      suites: rows.length,
      measured_suites: durations.length,
      tests: rows.reduce((total, row) => total + (Number.isInteger(row.test_count) && row.test_count > 0 ? row.test_count : 0), 0),
    },
    distribution,
    slowest_suites: slowest,
    suites: rows,
  }
}

// WITHDRAWN at closeout. #1080 ask 4 wanted an acceptance-gate cost ceiling
// derived from this sweep, and a Tukey upper fence over the suite population was
// the obvious statistic. It is the WRONG statistic for the question, and that is
// a measurement fact rather than a preference: re-swept on a green tree with a
// 180s per-run timeout, all 85 suites measure and the fence yields **3 seconds**,
// because the population is dominated by suites under one second. A real
// acceptance gate names two or three suites and exceeds 3s immediately, so the
// number would be confidently useless. The 30s originally recorded here was not
// derivable from this distribution at all — it came from a run whose rows were
// inflated by failing suites.
//
// The sweep and the distribution below are kept: they answer #1080 asks 1 and 3,
// which is what the measurement supports. A gate-cost RULE needs a statistic
// over gate compositions, not over the suite population, and nothing here
// measures that. Stated rather than guessed.

function buildReport({ tracked, measurements, measuredAt = new Date().toISOString(), sampleRuns = DEFAULT_RUNS, cheaperTests = [] } = {}) {
  const summary = summarizeSuiteCosts({ tracked, measurements })
  return {
    schema: 1,
    measured_at: measuredAt,
    sample_runs: sampleRuns,
    denominator: summary.denominator,
    distribution: summary.distribution,
    slowest_suites: summary.slowest_suites,
    suites: summary.suites,
    fixture_substitutions: cheaperTests,
  }
}

function parseCliArgs(argv) {
  const flags = { checkout: process.cwd(), runs: DEFAULT_RUNS, timeoutMs: DEFAULT_TIMEOUT_MS, json: false, help: false }
  const values = [...argv]
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index]
    if (flag === '--help' || flag === '-h') { flags.help = true; continue }
    if (flag === '--json') { flags.json = true; continue }
    if (flag === '--checkout' || flag === '--runs' || flag === '--timeout-ms') {
      const value = values[++index]
      if (!value || value.startsWith('--')) throw new SuiteCostUsageError(`${flag} requires a value`)
      if (flag === '--checkout') flags.checkout = value
      else {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1) throw new SuiteCostUsageError(`${flag} requires a positive integer`)
        if (flag === '--runs') flags.runs = parsed
        else flags.timeoutMs = parsed
      }
      continue
    }
    throw new SuiteCostUsageError(`unknown option: ${flag}`)
  }
  return flags
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = normalDeps(deps)
  try {
    const flags = parseCliArgs(argv)
    if (flags.help) { d.stdout(`${USAGE}\n`); return 0 }
    const suites = trackedSuites({ checkout: flags.checkout, deps: d })
    const measurements = suites.map((suite) => measureSuite({ suite, checkout: flags.checkout, runs: flags.runs, timeoutMs: flags.timeoutMs, deps: d }))
    const report = buildReport({ tracked: suites, measurements, sampleRuns: flags.runs })
    if (flags.json) d.stdout(`${JSON.stringify(report, null, 2)}\n`)
    else d.stdout(`SUITE-COST suites=${report.denominator.suites} measured=${report.denominator.measured_suites} tests=${report.denominator.tests} slowest=${report.slowest_suites[0] ?? 'unmeasured'}\n`)
    return 0
  } catch (error) {
    if (error instanceof SuiteCostUsageError) {
      d.stderr(`${error.message} [reason: usage]\n${USAGE}\n`)
      return 2
    }
    d.stderr(`${error?.message || String(error)} [reason: sweep-failed]\n`)
    return 2
  }
}

// Recorded on this checkout with three isolated TAP runs per suite. The rows are
// data, not an import-time sweep: validation and gate proof read the record
// without paying for the repository-wide measurement again.
const RECORDED_SUITE_SAMPLES = Object.freeze([
  ["commands/commands.test.mjs", 0.06804004201292992, 9, null],
  ["crew/acp-client.test.mjs", 0.276317959010601, 13, null],
  ["crew/adapter-pi.test.mjs", 0.13482329100370408, 22, null],
  ["crew/arms.test.mjs", 6.669267749994993, 30, null],
  ["crew/assurances.test.mjs", 0.06916087499260902, 5, null],
  ["crew/breaker.test.mjs", 0.08307795801758766, 24, null],
  ["crew/capabilities.test.mjs", 0.18507883301377295, 42, null],
  ["crew/converge.test.mjs", 0.13940316697955132, 11, null],
  ["crew/crew.test.mjs", 14.04472745898366, 356, null],
  ["crew/daemon.test.mjs", 1.862405540972948, 161, null],
  ["crew/drive-build.test.mjs", 4.251040040999651, 167, null],
  ["crew/drive-docs.test.mjs", 0.6206992500126362, 21, null],
  ["crew/drive-plan.test.mjs", 0.14145133399963378, 111, null],
  ["crew/drive-publish.test.mjs", 0.11660025000572205, 28, null],
  ["crew/drive-review.test.mjs", 3.363651708006859, 174, null],
  ["crew/drive.test.mjs", 1.1027843340039254, 185, null],
  ["crew/driver.test.mjs", 0.09536870801448823, 56, null],
  ["crew/escalation-policy.test.mjs", 0.06882529199123383, 11, null],
  ["crew/factoryctl.test.mjs", 0.5042846669852734, 70, null],
  ["crew/fence-scope.test.mjs", 0.06687483301758766, 6, null],
  ["crew/harvest.test.mjs", 7.284364958018065, 13, null],
  ["crew/headless-rpc.test.mjs", 7.225224250018597, 100, null],
  ["crew/headless.test.mjs", 19.60172429198027, 201, null],
  ["crew/host-load.test.mjs", 0.07442058297991752, 10, null],
  ["crew/io-contract.test.mjs", 0.21465970900654793, 55, null],
  ["crew/json-leaf.test.mjs", 0.07015424999594688, 7, null],
  ["crew/memory.test.mjs", 0.08316529101133346, 21, null],
  ["crew/pi/extensions/advisor.test.mjs", 0.23602266600728036, 7, null],
  ["crew/pi/extensions/builderloop.test.mjs", 0.2278280000090599, 13, null],
  ["crew/pi/extensions/lab.test.mjs", 35.42733366701007, 58, null],
  ["crew/pi/extensions/readgate.test.mjs", 0.14324500000476836, 27, null],
  ["crew/pi/extensions/skeletonread.test.mjs", 0.1682647500038147, 18, null],
  ["crew/pi/extensions/subagent.test.mjs", 0.14970920899510384, 39, null],
  ["crew/reclaim-descendants.test.mjs", 1.3557575419843197, 37, null],
  ["crew/reclaim.test.mjs", 0.5360021249949932, 119, null],
  ["crew/roster-refresh.test.mjs", 0.1690917499959469, 19, null],
  ["crew/run-configuration.test.mjs", 0.07233337497711181, 11, null],
  ["crew/seat-io-death.test.mjs", 0.7963295419812202, 17, null],
  ["crew/seat-io-heartbeat.test.mjs", 0.3321666250228882, 8, null],
  ["crew/seat-io-runclean.test.mjs", 16.263764083981513, 145, null],
  ["crew/task-profiles.test.mjs", 0.07201166599988937, 6, null],
  ["crew/tree-fingerprint.test.mjs", 1.6457767090201378, 16, null],
  ["skills/backend-node/exhibits.test.mjs", 0.16967574998736382, 4, null],
  ["skills/crew-dispatch/cli-contract.test.mjs", 0.088708792001009, 5, null],
  ["skills/crew-dispatch/exhibits.test.mjs", 0.15430529102683066, 20, null],
  ["skills/crew-recovery/exhibits.test.mjs", 0.15158224999904632, 10, null],
  ["skills/devops/exhibits.test.mjs", 0.15175170800089835, 4, null],
  ["skills/pr-review/findings-shape.test.mjs", 0.08306320798397064, 8, null],
  ["skills/qa-test-writing/anchor-pin.test.mjs", 1.1667134580016136, 70, null],
  ["test/docs-decisions.test.mjs", 0.07281512498855591, 5, null],
  ["test/factory-absence.test.mjs", 0.12760120898485183, 5, null],
  ["test/factory-closeout.test.mjs", 0.4011809169948101, 54, null],
  ["test/factory-crew-watch.test.mjs", 1.6828032079935074, 47, null],
  ["test/factory-dispatch-batch.test.mjs", 6.901821083009243, 290, null],
  ["test/factory-emit-floor.test.mjs", 0.09630941700935364, 4, null],
  ["test/factory-emit.test.mjs", 15.309085999995471, 77, null],
  ["test/factory-env.test.mjs", 0.6667242079973221, 30, null],
  ["test/factory-extract-suite-corpus.test.mjs", 0.08465749999880791, 7, null],
  ["test/factory-intake.test.mjs", 23.214630957990884, 91, null],
  ["test/factory-lane-watch.test.mjs", 0.18124062502384186, 28, null],
  ["test/factory-ledger-floor.test.mjs", 0.3072290830016136, 19, null],
  ["test/factory-ledger.test.mjs", 14.442227416992187, 342, null],
  ["test/factory-make-brief.test.mjs", 30.175507458001377, 156, null],
  ["test/factory-model-eval.test.mjs", 0.09932108300924301, 9, null],
  ["test/factory-probe-repo.test.mjs", 12.191476374983788, 41, null],
  ["test/factory-prove-mutations.test.mjs", 2.8283966250121595, 22, null],
  ["test/factory-reap-stale.test.mjs", 0.2784874169826508, 33, null],
  ["test/factory-seams.test.mjs", 1.1239287500083446, 14, null],
  ["test/factory-suite-cost.test.mjs", 0.08435729101300239, 9, null],
  ["test/factory-transcript.test.mjs", 0.10301308399438858, 37, null],
  ["test/fixtures.test.mjs", 0.06735758301615714, 5, null],
  ["test/helpers.test.mjs", 0.28738950002193453, 15, null],
  ["test/review-procedure-loader.test.mjs", 0.22342420801520346, 9, null],
  ["test/vacuity.test.mjs", 0.11600629201531411, 5, null],
  ["test/version-agreement.test.mjs", 0.06643204101920128, 4, null],
  ["test/visualizer-local-env.test.mjs", 0.0656567910015583, 2, null],
  ["test/visualizer-model-catalog.test.mjs", 0.06662979102134704, 10, null],
  ["test/visualizer-model-directory.test.mjs", 0.06319312500953675, 2, null],
  ["test/visualizer-panels.test.mjs", 0.15121829199790954, 123, null],
  ["test/visualizer-returns.test.mjs", 0.07137504199147224, 1, null],
  ["test/visualizer-roster-edit.test.mjs", 0.1341970829963684, 30, null],
  ["test/visualizer-server.test.mjs", 5.458807999998331, 82, null],
  ["test/visualizer-shape.test.mjs", 0.14856475001573563, 74, null],
  ["test/visualizer-teardown.test.mjs", 0.20945816701650619, 8, null],
  ["test/visualizer-trajectory.test.mjs", 0.1441399590075016, 36, null],
])

const RECORDED_SLOWEST_TESTS = Object.freeze({
  'test/factory-make-brief.test.mjs': Object.freeze([
    'context pack records complete source data beyond argv limits',
    'indexing a 70k-symbol file stays within a countable byte budget',
    'tracked key discovery retains a tripwire beyond argv limits',
  ]),
  'test/factory-intake.test.mjs': Object.freeze([
    'a changed body lifts the repeat escalation park, while metadata bumps do not',
    'hand dispatch still boots after two escalations and digest rows pair by dispatch',
    'an escalation followed by done leaves the issue pickable',
  ]),
  'crew/headless.test.mjs': Object.freeze([
    'RV1-1 classified provider failures use retry routing before model fallback',
    'RV1-1 observes expiry and overshoot only after the retry route runs',
    'B3 a measured wait that overshot the bound carries its reason',
  ]),
  'test/factory-dispatch-batch.test.mjs': Object.freeze([
    'readsFromRefusal parses both compiler refusal shapes from real compiler output',
    'created paths are covered by the own fence, cannot leak to a sibling, and are reported per lane',
    'checkFences inherits an overlap only across its declared edge',
  ]),
  'test/factory-suite-cost.test.mjs': Object.freeze([
    'RV1-2 records delivered measurements for construction-time suites',
    'trackedSuites sorts regular test files from cached and untracked git output',
    'measureSuite takes three wall samples, derives runner count, and sorts TAP durations',
  ]),
})

const RECORDED_SUITE_MEASUREMENTS = Object.freeze(RECORDED_SUITE_SAMPLES.map(([suite, duration_seconds, test_count, reason]) => ({
  suite, duration_seconds, test_count, reason, slowest_tests: RECORDED_SLOWEST_TESTS[suite] || [],
})))
const RECORDED_SUITE_SUMMARY = summarizeSuiteCosts({
  tracked: RECORDED_SUITE_SAMPLES.map(([suite]) => suite),
  measurements: RECORDED_SUITE_MEASUREMENTS,
})

// #1080 ask 1 — ATTRIBUTION. Which tests dominate the slowest suite, and what do
// they actually do. This is a finding, not a saving: no before/after is claimed,
// because the suite-level difference the six fixture substitutions produce is
// inside sample noise (the recorded before_seconds 29.2 was the issue's single
// unrepeated sample; this lane's own three samples median 28.84 against 28.49).
// The answer to ask 2 is that the dominant cost is INHERENT — each retained test
// says why it stays expensive — not recoverable fixture waste.
const RECORDED_MAKE_BRIEF_ATTRIBUTION = Object.freeze({
  suite: 'test/factory-make-brief.test.mjs',
  samples_seconds: Object.freeze([28.687606208, 28.839590209, 29.1169855]),
  test_count: 156,
  removed_tests: Object.freeze([]),
  saving_claimed: null,
  saving_absent_reason: 'within-sample-noise',
  dominant_tests: Object.freeze([
    { title: 'context pack records complete source data beyond argv limits', classifications: Object.freeze(['compilation', 'discovery scan', 'filesystem fixtures']) },
    { title: 'indexing a 70k-symbol file stays within a countable byte budget', classifications: Object.freeze(['compilation', 'discovery scan']) },
    { title: 'tracked key discovery retains a tripwire beyond argv limits', classifications: Object.freeze(['compilation', 'discovery scan', 'real git', 'filesystem fixtures']) },
  ]),
  retained_tests: Object.freeze([
    { title: 'indexing a 70k-symbol file stays within a countable byte budget', why: '70,000 exported symbols remain the argv-scale and context-completeness coverage cost.' },
    { title: 'literal-heavy real discovery completes without modifying its reproducers', why: 'The real repository discovery fixture retains both scan and grep timeout phases.' },
  ]),
})

const KILLED_FAST_BASELINE_PROOF = Object.freeze({
  outcome: 'killed',
  method: 'A failing fixture baseline removed a post-baseline fixture input; the named compiler assertion then failed.',
})
const UNREACHED_FAST_BASELINE_PROOF = Object.freeze({
  outcome: 'survived',
  reason: 'Every case refuses in fence validation or coupling before baseline resolution, so the substituted command is unreachable.',
})
const RECORDED_CHEAPER_TESTS = Object.freeze([
  { title: 'pack mode moves boilerplate to sidecars and preserves the inline verdict', before_seconds: 0.8, after_seconds: 0.56, before_samples_seconds: Object.freeze([0.8, 0.8, 0.83]), after_samples_seconds: Object.freeze([0.56, 0.56, 0.58]), coverage: 'unchanged', mutation: 'killed', faster: true, explanation: 'Only the incidental baseline command changed; compiler, git, and filesystem coverage remained real.', behavior_proof: KILLED_FAST_BASELINE_PROOF },
  { title: 'every packed absence uses one closed reason and never invents a value', before_seconds: 0.98, after_seconds: 0.68, before_samples_seconds: Object.freeze([0.98, 0.98, 0.99]), after_samples_seconds: Object.freeze([0.67, 0.68, 0.7]), coverage: 'unchanged', mutation: 'killed', faster: true, explanation: 'Only the incidental baseline command changed; compiler, git, and filesystem coverage remained real.', behavior_proof: KILLED_FAST_BASELINE_PROOF },
  { title: 'creates keeps missing-path strict in both where/creates directions and accepts an empty list', before_seconds: 0.62, after_seconds: 0.51, before_samples_seconds: Object.freeze([0.61, 0.62, 0.63]), after_samples_seconds: Object.freeze([0.51, 0.51, 0.51]), coverage: 'unchanged', mutation: 'killed', faster: true, explanation: 'Only the incidental baseline command changed; compiler, git, and filesystem coverage remained real.', behavior_proof: KILLED_FAST_BASELINE_PROOF },
  { title: 'scope validation refuses unslashed directories without changing the rendered surface', before_seconds: 0.79, after_seconds: 0.69, before_samples_seconds: Object.freeze([0.78, 0.79, 0.8]), after_samples_seconds: Object.freeze([0.68, 0.69, 0.69]), coverage: 'unchanged', mutation: 'killed', faster: true, explanation: 'Only the incidental baseline command changed; compiler, git, and filesystem coverage remained real.', behavior_proof: KILLED_FAST_BASELINE_PROOF },
  { title: 'out refusal and force overwrite follow the CLI contract', before_seconds: 0.97, after_seconds: 0.67, before_samples_seconds: Object.freeze([0.96, 0.97, 0.98]), after_samples_seconds: Object.freeze([0.67, 0.67, 0.67]), coverage: 'unchanged', mutation: 'killed', faster: true, explanation: 'Only the incidental baseline command changed; compiler, git, and filesystem coverage remained real.', behavior_proof: KILLED_FAST_BASELINE_PROOF },
  // RV1-4: this substitution did NOT make the test cheaper — it is 0.02s SLOWER,
  // and its behaviour proof survived rather than killed. It is recorded because it
  // was made, not because it paid off; reusing the savings explanation here claimed
  // a benefit the numbers refuse.
  { title: 'stale and malformed coupling acknowledgements refuse by input reason', before_seconds: 0.64, after_seconds: 0.66, faster: false, before_samples_seconds: Object.freeze([0.64, 0.64, 0.64]), after_samples_seconds: Object.freeze([0.66, 0.66, 0.67]), coverage: 'unchanged', mutation: 'survived', explanation: 'No saving: the substituted baseline is 0.02s slower than the original and its proof survived, because every case in this test refuses during fence or coupling validation before the substituted command is reachable.', behavior_proof: UNREACHED_FAST_BASELINE_PROOF },
])

export const RECORDED_SUITE_COST_REPORT = Object.freeze({
  schema: 1,
  measured_at: '2026-09-09T09:38:00.000Z',
  sample_runs: 3,
  timeout_ms: 180_000,
  denominator: RECORDED_SUITE_SUMMARY.denominator,
  distribution: RECORDED_SUITE_SUMMARY.distribution,
  slowest_suites: RECORDED_SUITE_SUMMARY.slowest_suites,
  suites: RECORDED_SUITE_SUMMARY.suites,
  attribution: RECORDED_MAKE_BRIEF_ATTRIBUTION,
  fixture_substitutions: RECORDED_CHEAPER_TESTS,
})

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

const invokedDirectly = !process.env.NODE_TEST_CONTEXT && process.argv[1]
  && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exitCode = main()
