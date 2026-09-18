#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDiffCandidates, applyDiffCandidate } from './prove-mutations.mjs'

export const DRIVER_SUITES = Object.freeze([
  'crew/drive-build.test.mjs',
  'crew/drive-plan.test.mjs',
  'crew/drive-publish.test.mjs',
  'crew/drive-review.test.mjs',
  'crew/drive.test.mjs',
])
export const SAMPLE_UNMEASURED_REASON = 'sample-killed-nothing'
// Every reason an unmeasured mutant can carry, named once; every emit site reads a name
// from here, so a reason outside the closed list cannot be spelled.
export const REASON = Object.freeze({
  SUITE_MISSING: 'suite-missing', NO_TAP_OUTPUT: 'no-tap-output', SPAWN_DENIED: 'spawn-denied', INTERRUPTED: 'interrupted', TIMEOUT: 'timeout',
  FILE_LEVEL_FAILURE: 'file-level-failure', FAILURES_UNATTRIBUTED: 'failures-unattributed', SUITE_EXIT_UNATTRIBUTED: 'suite-exit-unattributed',
  CANCELLED: 'cancelled', OUTCOME_SET_DIFFERS: 'outcome-set-differs', BASELINE_UNMEASURED: 'baseline-unmeasured', BASELINE_RED: 'baseline-red',
})
export const MUTANT_UNMEASURED_REASONS = Object.freeze(Object.values(REASON))
export const USAGE = `usage: node scripts/factory/kill-redundancy.mjs [--mutants <n>] [--out <json>] [--md <markdown>] [--suites <suite>] [--checkout <dir>] [--timeout-ms <n>] [--seed <n>]`

// xorshift32 is stuck at zero forever, so seed 0 is folded with the golden-ratio constant
// and a zero state is bumped: every seed is a distinct, deterministic stream.
function seededNumber(seed) {
  let value = ((Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 0) ^ 0x9e3779b9) >>> 0
  if (value === 0) value = 1
  return () => {
    value = (value ^ (value << 13)) >>> 0
    value = (value ^ (value >>> 17)) >>> 0
    value = (value ^ (value << 5)) >>> 0
    return value / 0x100000000
  }
}

export function sampleLineNumbers({ lineCount, count, seed = 0 } = {}) {
  const total = Number.isSafeInteger(lineCount) && lineCount > 0 ? lineCount : 0
  const wanted = Number.isSafeInteger(count) && count > 0 ? Math.min(count, total) : 0
  if (wanted === 0) return []
  const random = seededNumber(seed)
  const selected = new Set()
  for (let i = 0; i < wanted; i += 1) {
    const start = Math.floor(i * total / wanted)
    const end = Math.max(start + 1, Math.floor((i + 1) * total / wanted))
    const offset = Math.floor(random() * (end - start))
    selected.add(start + offset + 1)
  }
  return [...selected].sort((a, b) => a - b)
}

export function buildSyntheticPatch(target, entries) {
  return { files: [{ path: target, added: entries }] }
}

export function mutantsForLines({ target, lines, texts } = {}) {
  const entries = (lines || []).map((lineNumber, index) => ({
    lineNumber,
    text: texts?.[index] ?? '',
  }))
  const generated = generateDiffCandidates(buildSyntheticPatch(target, entries))
  const sampled = new Set(entries.map((entry) => entry.lineNumber))
  const candidates = []
  for (const candidate of generated.candidates) {
    if (!sampled.has(candidate.line) || candidates.some((item) => item.line === candidate.line)) continue
    candidates.push(candidate)
  }
  // Every count the selection dropped, so the report can state them with their denominators.
  const candidateLines = new Set(generated.candidates.map((candidate) => candidate.line).filter((line) => sampled.has(line)))
  const sampling = {
    sampledLines: sampled.size,
    candidateLines: candidateLines.size,
    skippedLines: sampled.size - candidateLines.size,
    generatedCandidates: generated.candidates.filter((candidate) => sampled.has(candidate.line)).length,
    selectedCandidates: candidates.length,
  }
  sampling.omittedCandidates = sampling.generatedCandidates - sampling.selectedCandidates
  return { candidates, skips: generated.skips, sampling }
}

// TAP as `node --test --test-reporter=tap <one file>` emits it: top-level `ok N - title`
// records, nested subtests indented four spaces under `# Subtest: name`, a parent's record
// AFTER its children, and a file-level failure as a single record whose title is the
// file. A test key is `<suite> :: <subtest path>`; a parent that has children is a
// container and is never a killer or an observed test on its own. Null when the text is
// not a finished TAP run (no `# tests` summary).
// The YAML diagnostic block under a record: indented lines up to its `...` terminator.
function yamlBlockHas(lines, from, pattern) {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\s+/.test(line)) return false
    if (pattern.test(line)) return true
    if (/^\s+\.\.\.\s*$/.test(line)) return false
  }
  return false
}

export function parseTapKills(output, suite = null) {
  if (typeof output !== 'string') return null
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  const totalsMatch = /^# tests\s+(\d+)\s*$/m.exec(text)
  if (!totalsMatch) return null
  const count = (name) => { const m = new RegExp(`^# ${name}\\s+(\\d+)\\s*$`, 'm').exec(text); return m ? Number(m[1]) : null }
  const totals = { tests: Number(totalsMatch[1]), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'), todo: count('todo') }
  const prefix = suite ? `${suite} :: ` : ''
  const suiteName = suite ? String(suite).split(/[/\\]/).pop() : null
  const lines = text.split(/\r?\n/)
  const names = []
  const records = []
  let fileLevel = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const subtest = /^(\s*)# Subtest: (.*)$/.exec(line)
    if (subtest) { names[subtest[1].length / 4] = subtest[2].trim(); continue }
    const match = /^(\s*)(ok|not ok)\s+\d+\s*(?:-\s*(.*?))?\s*(?:#\s*(SKIP|TODO)\b.*)?$/i.exec(line)
    if (!match) continue
    const depth = match[1].length / 4
    const title = (match[3] || '').trim()
    const directive = match[4] ? match[4].toUpperCase() : null
    // A file-level failure is the record node emits FOR the file: top-level, titled by the
    // suite's own name, with the process diagnostics (`exitCode:`) in its YAML block. A test
    // that merely calls itself "x.test.mjs" is a test.
    if (depth === 0 && suiteName !== null && (title === suiteName || title === suite) && match[2] === 'not ok' && yamlBlockHas(lines, index + 1, /^\s+exitCode:/)) { fileLevel = true; continue }
    const path = [...names.slice(0, depth), title].filter(Boolean).join(' > ')
    records.push({ depth, failed: match[2] === 'not ok', directive, key: `${prefix}${path}` })
  }
  // A skipped or TODO record is neither observed nor a kill: it did not measure the mutant.
  const measuring = (record) => record.directive === null
  const leaves = records.filter((record, index) => !(index > 0 && records[index - 1].depth > record.depth))
  // Occurrence identity: the second test titled `same` is `same#2`, so a run that dropped
  // one of two duplicates, or ran them in another order, measured something else.
  const seen = new Map()
  // A title can contain any text, so a suffix like `#2` can collide with a real title; the
  // first occurrence keeps its plain key (what a reader sees) and every later one carries its
  // ordinal in a form no title can produce (a NUL-separated tail).
  for (const record of leaves) { if (!measuring(record)) continue; const n = (seen.get(record.key) ?? 0) + 1; seen.set(record.key, n); record.id = n === 1 ? record.key : `${record.key}\u0000${n}` }
  const killers = leaves.filter((record) => record.failed && measuring(record)).map((record) => record.id)
  const observed = leaves.filter(measuring).map((record) => record.id)
  // Node's `# fail` counts containers too and excludes TODO failures, so attribution is
  // checked against every non-directive failed record, while kills and observations are
  // the leaves.
  const failedRecords = records.filter((record) => record.failed && measuring(record)).length + (fileLevel ? 1 : 0)
  return { killers, observed, totals, fileLevel, failedRecords }
}

function resultError(result) {
  if (!result) return null
  if (result.error) return result.error
  if (result.spawnError) return result.spawnError
  return null
}

// A mutant is MEASURED only when every suite run finished with attributable outcomes: a
// failure the parser could not put on a test (a file-level crash, a non-zero exit with no
// failing record, a `# fail` total above the records attributed) is an unmeasured mutant
// with a closed reason — never a survivor, never a kill.
// The pristine run of one suite: the leaf tests it measures when nothing is mutated. A
// mutant run whose observed set differs — a truncated run, a crash after some tests, a
// test that appeared — did not measure the same thing, and is unmeasured with a reason.
export function baselineCensus(result) {
  const verdict = classifyMutantOutcome({ suiteOutputs: [result] })
  if (verdict.status !== 'measured') return { suite: result?.suite ?? null, status: 'unmeasured', reason: verdict.reason, observed: null }
  if (verdict.killers.length > 0) return { suite: result?.suite ?? null, status: 'unmeasured', reason: REASON.BASELINE_RED, observed: null }
  return { suite: result?.suite ?? null, status: 'measured', reason: null, observed: verdict.observed }
}

export function classifyMutantOutcome({ suiteOutputs = [], baselines = null } = {}) {
  const unmeasured = (reason) => ({ status: 'unmeasured', reason, survivor: false, killers: [], observed: [], suitesMeasured: [] })
  if (!suiteOutputs.length) return unmeasured(REASON.NO_TAP_OUTPUT)
  const killers = new Set()
  const observed = new Set()
  const suitesMeasured = []
  for (const result of suiteOutputs) {
    const error = resultError(result)
    if (result?.timedOut || result?.timeout || error?.code === 'ETIMEDOUT') return unmeasured(REASON.TIMEOUT)
    if (result?.interrupted || result?.signal) return unmeasured(REASON.INTERRUPTED)
    if (error) return unmeasured(error.code === 'ENOENT' ? REASON.SUITE_MISSING : REASON.SPAWN_DENIED)
    const parsed = parseTapKills(`${result?.stdout || ''}${result?.stderr || ''}`, result?.suite ?? null)
    if (!parsed) return unmeasured(REASON.NO_TAP_OUTPUT)
    if (parsed.fileLevel) return unmeasured(REASON.FILE_LEVEL_FAILURE)
    if (parsed.totals.cancelled > 0) return unmeasured(REASON.CANCELLED)
    const failed = Number.isInteger(parsed.totals.fail) ? parsed.totals.fail : null
    if (failed !== null && failed !== parsed.failedRecords) return unmeasured(REASON.FAILURES_UNATTRIBUTED)
    if (typeof result?.status === 'number' && result.status !== 0 && parsed.killers.length === 0) return unmeasured(REASON.SUITE_EXIT_UNATTRIBUTED)
    const baseline = baselines instanceof Map ? baselines.get(result?.suite ?? null) : undefined
    // The same tests, the same number of times, in the same order — or it is another run.
    if (baseline !== undefined && (parsed.observed.length !== baseline.length || parsed.observed.some((id, index) => id !== baseline[index]))) return unmeasured(REASON.OUTCOME_SET_DIFFERS)
    for (const killer of parsed.killers) killers.add(killer)
    for (const key of parsed.observed) observed.add(key)
    suitesMeasured.push(result?.suite ?? null)
  }
  const list = [...killers]
  return { status: 'measured', survivor: list.length === 0, killers: list, observed: [...observed], suitesMeasured }
}

function mutantOf(result) {
  return result?.mutant || result || {}
}

// A strict subset of a sampled kill-set is a CANDIDATE for redundancy, not proof of it:
// the sample is finite, one operator per line, and tests can share hooks or order effects.
export const REDUNDANCY_CANDIDATE = 'redundancy-candidate'
function redundantRecord(candidate, candidateKills, dominator, dominatorKills) {
  return { candidate, kills: [...candidateKills], dominator, dominatorKills: [...dominatorKills], status: REDUNDANCY_CANDIDATE }
}

export function analyzeKills({ mutantResults = [], observedTests = [] } = {}) {
  const measured = []
  const unmeasured = []
  const survivors = []
  for (const result of mutantResults) {
    const mutant = mutantOf(result)
    const id = mutant.id ?? result.id
    const status = result.status || 'measured'
    if (status === 'unmeasured') {
      unmeasured.push({ id, reason: result.reason })
      continue
    }
    const killers = [...new Set(result.killers || mutant.killers || [])]
    if (killers.length === 0) {
      survivors.push(mutant.id)
    } else {
      measured.push({ id, killers })
    }
  }

  const tests = new Map()
  for (const name of observedTests) tests.set(name, new Set())
  for (const result of measured) for (const name of result.killers) {
    if (!tests.has(name)) tests.set(name, new Set())
    tests.get(name).add(result.id)
  }
  const withKillSet = [...tests.entries()].filter(([, kills]) => kills.size > 0)
  const redundant = []
  const testRows = [...tests.entries()].map(([key, kills]) => ({ key, kills, status: kills.size ? 'measured' : 'unmeasured', ...(kills.size ? {} : returnSampleUnmeasured()) }))
  for (const [candidateName, candidate] of withKillSet) {
    for (const [dominatorName, dominator] of withKillSet) {
      if (candidateName === dominatorName) continue
      const candidateKills = [...candidate]
      if (candidate.size < dominator.size && [...candidate].every((m) => dominator.has(m))) {
        const record = redundantRecord(candidateName, candidateKills, dominatorName, dominator)
        redundant.push(record)
        const row = testRows.find((test) => test.key === candidateName)
        if (row) { row.status = record.status; row.dominatedBy = dominatorName }
        break
      }
    }
  }
  const sampledMutants = mutantResults.length
  const killedMutants = measured.filter((entry) => entry.killers.length > 0).length
  return {
    mutantResults,
    tests: testRows,
    redundant,
    survivors: [...new Set(survivors)],
    unmeasured,
    sampledMutants,
    killedMutants,
    observedTests: tests.size,
    testsWithKillSet: withKillSet.length,
    wallClockSeconds: 0,
  }
}

function returnSampleUnmeasured() {
  return { status: 'unmeasured', reason: SAMPLE_UNMEASURED_REASON }
}

export function snapshotFile(path) {
  const bytes = readFileSync(path)
  return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export function restoreSnapshot(snapshot) {
  writeFileSync(snapshot.path, snapshot.bytes)
}

// What a reader needs to reproduce the run exactly: the seed, the checkout's commit, the
// tool's own bytes, the runtime. A checkout that is not a repository states that.
function provenance(checkout, options, spawn) {
  let headSha = null
  try {
    const head = spawn('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    headSha = head && head.status === 0 && typeof head.stdout === 'string' && /^[0-9a-f]{40}/.test(head.stdout.trim()) ? head.stdout.trim() : null
  } catch { headSha = null }
  let toolSha256 = null
  try { toolSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') } catch { toolSha256 = null }
  return { seed: options.seed, mutantsRequested: options.mutants, headSha, toolSha256, node: process.version }
}

function neutralEnv(base = process.env) {
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  env.NO_COLOR = '1'
  return env
}

function runSuite(suite, checkout, timeoutMs, spawn) {
  try {
    const result = spawn('node', ['--test', '--test-reporter=tap', suite], {
      cwd: checkout,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: neutralEnv(),
    })
    return { suite, ...result }
  } catch (error) {
    return { suite, error }
  }
}

function parseArgs(argv) {
  const parsed = { mutants: 200, out: null, md: 'docs/audits/2026-09-18/kill-redundancy.md', suites: [], checkout: process.cwd(), timeoutMs: 30000, seed: 0 }
  const args = [...(argv || [])]
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]
    if (flag === '--help') throw new Error(USAGE)
    const needs = (name) => {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
      return value
    }
    if (flag === '--mutants') parsed.mutants = Number(needs(flag))
    else if (flag === '--out') parsed.out = needs(flag)
    else if (flag === '--md') parsed.md = needs(flag)
    else if (flag === '--suites') parsed.suites.push(needs(flag))
    else if (flag === '--checkout') parsed.checkout = needs(flag)
    else if (flag === '--timeout-ms') parsed.timeoutMs = Number(needs(flag))
    else if (flag === '--seed') parsed.seed = Number(needs(flag))
    else throw new Error(`unknown flag ${flag}`)
  }
  if (!Number.isSafeInteger(parsed.mutants) || parsed.mutants <= 0) throw new Error('--mutants must be a positive integer')
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) throw new Error('--timeout-ms must be positive')
  parsed.suites = parsed.suites.length ? parsed.suites : [...DRIVER_SUITES]
  return parsed
}

// Best-effort: the nearest preceding column-0 or indented `function NAME(` / `const NAME = (…) =>`
// DECLARATION. Calls, keywords and strings are never a group; a line inside an arrow the
// scan cannot see lands in the declaration above it, which is the stated limit.
function functionForLine(lines, lineNumber) {
  for (let index = Math.min(lines.length - 1, lineNumber - 1); index >= 0; index -= 1) {
    const match = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(lines[index])
      || /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(lines[index])
    if (match) return match[1]
  }
  return '(top level: no enclosing declaration found)'
}

// A rate is a numerator AND its denominator; a zero denominator is not 0%, it is a cell
// nobody could measure.
export function formatRate(k, total) {
  const denominator = Number(total)
  const numerator = Number(k)
  if (!(denominator > 0)) return `${k} of ${total} (unmeasured: denominator 0)`
  return `${k} of ${total} (${Number(((numerator / denominator) * 100).toFixed(1))}%)`
}

export function buildMarkdown(analysis = {}) {
  const sampled = analysis.sampledMutants ?? analysis.mutantResults?.length ?? 0
  const killed = analysis.killedMutants ?? 0
  const observed = analysis.observedTests ?? analysis.tests?.length ?? 0
  const withKillSet = analysis.testsWithKillSet ?? analysis.tests?.filter((test) => test.kills?.size).length ?? 0
  const seconds = Number(analysis.wallClockSeconds || 0)
  const suites = analysis.suitePaths || DRIVER_SUITES
  const runs = analysis.suiteRuns || { measured: null, total: null }
  const sampling = analysis.sampling || {}
  const provenance = analysis.provenance || {}
  const lines = [
    '# Driver test redundancy measurement',
    '',
    `Suites with at least one measured run: ${formatRate(analysis.suitesMeasured ?? 0, suites.length)}`,
    `Suite runs measured: ${formatRate(runs.measured ?? 0, runs.total ?? 0)}`,
    'Driver suites (pristine baseline: measured leaf tests, or the reason it was not):',
    ...suites.map((suite) => { const b = (analysis.baselines || []).find((row) => row.suite === suite); return `- ${suite}: ${b ? (b.status === 'measured' ? `${b.tests} tests` : `unmeasured (${b.reason})`) : 'no baseline recorded'}` }),
    `Mutants selected: ${formatRate(sampled, sampled)}`,
    `Mutants measured (over the baseline-eligible suites only): ${formatRate(sampled - (analysis.unmeasured?.length ?? 0), sampled)}`,
    `Mutants killed: ${formatRate(killed, sampled)}`,
    `Tests observed: ${observed > 0 ? `${observed}` : 'unmeasured (no suite run finished with attributable outcomes)'}`,
    `Tests with a kill-set: ${formatRate(withKillSet, observed)}`,
    `Wall clock seconds (baseline census and mutation loop): ${seconds}`,
    '',
    '## Sampling',
    `Lines requested: ${provenance.mutantsRequested ?? sampling.sampledLines ?? 'unmeasured'}`,
    `Lines sampled: ${sampling.sampledLines ?? 'unmeasured'}`,
    `Lines with a candidate: ${formatRate(sampling.candidateLines ?? 0, sampling.sampledLines ?? 0)}`,
    `Lines skipped (no candidate): ${formatRate(sampling.skippedLines ?? 0, sampling.sampledLines ?? 0)}`,
    `Candidates generated on sampled lines: ${sampling.generatedCandidates ?? 'unmeasured'}`,
    `Candidates selected (first per line): ${formatRate(sampling.selectedCandidates ?? 0, sampling.generatedCandidates ?? 0)}`,
    `Candidates omitted: ${formatRate(sampling.omittedCandidates ?? 0, sampling.generatedCandidates ?? 0)}`,
    '',
    '## Provenance',
    `Seed: ${provenance.seed ?? 'unmeasured'}`,
    `Checkout HEAD: ${provenance.headSha ?? 'unmeasured (not a git checkout or git unavailable)'}`,
    `Tool sha256: ${provenance.toolSha256 ?? 'unmeasured'}`,
    `Node: ${provenance.node ?? 'unmeasured'}`,
    '',
    '## Redundancy candidates (sampled kill-set subsumption, not proof of redundancy)',
    'A candidate is a test whose sampled kill-set is a strict subset of another test\'s.',
    'The sample is finite and one operator per line; shared hooks and ordering effects are',
    'not modelled. Unsampled mutants may separate the two tests.',
  ]
  if (!analysis.redundant?.length) lines.push('- none observed')
  else for (const entry of analysis.redundant) {
    lines.push(`- ${entry.dominator} dominates ${entry.candidate}: ${formatRate(entry.kills.length, sampled)} of its sampled kills are also the dominator's (dominator: ${formatRate(entry.dominatorKills.length, sampled)})`)
  }
  lines.push('', '## Survivors (gaps in this sample), grouped by enclosing declaration — best-effort')
  if (!analysis.survivors?.length) lines.push('- none observed')
  else {
    const groups = new Map()
    for (const id of analysis.survivors) {
      const mutant = analysis.mutantResults?.find((row) => (mutantOf(row).id ?? row.id) === id)
      const group = functionForLine(analysis.sourceLines || [], mutantOf(mutant).line || 1)
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(id)
    }
    for (const [group, ids] of groups) lines.push(`- ${group}: ${formatRate(ids.length, analysis.survivors.length)} survivors`)
  }
  lines.push('', '## Unmeasured outcomes')
  if (!analysis.unmeasured?.length) lines.push('- none observed')
  else for (const row of analysis.unmeasured) lines.push(`- ${row.id}: ${row.reason}`)
  lines.push('', `Sample blind spot: only the first generated candidate per sampled line was measured (${formatRate(sampling.selectedCandidates ?? sampled, sampling.generatedCandidates ?? sampled)} of the candidates generated on sampled lines).`)
  return `${lines.join('\n')}\n`
}

function jsonAnalysis(analysis) {
  return {
    ...analysis,
    tests: (analysis.tests || []).map((test) => ({ ...test, kills: [...(test.kills || [])] })),
    redundant: (analysis.redundant || []).map((entry) => ({ ...entry, kills: [...entry.kills], dominatorKills: [...entry.dominatorKills] })),
  }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  let options
  try { options = parseArgs(argv) } catch (error) {
    ;(deps.stderr || process.stderr).write(`${error.message}\n${USAGE}\n`)
    return 2
  }
  const checkout = options.checkout
  const target = 'crew/drive.mjs'
  const targetPath = join(checkout, target)
  const source = readFileSync(targetPath, 'utf8')
  const sourceLines = source.split(/\r?\n/)
  const lineNumbers = sampleLineNumbers({ lineCount: sourceLines.length, count: options.mutants, seed: options.seed })
  const generated = mutantsForLines({ target, lines: lineNumbers, texts: lineNumbers.map((line) => sourceLines[line - 1]) })
  const spawn = deps.spawnSync || spawnSync
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal))
  const observedTests = new Set()
  const suitesWithMeasuredRun = new Set()
  const suiteRuns = { measured: 0, total: 0 }
  const started = performance.now()
  // Pristine census first: what each suite measures with nothing mutated. A suite whose
  // baseline is unmeasured (or red) is not run against mutants at all.
  const baselines = new Map()
  const baselineOutcomes = []
  for (const suite of options.suites) {
    const census = baselineCensus(runSuite(suite, checkout, options.timeoutMs, spawn))
    baselineOutcomes.push(census)
    if (census.status === 'measured') { baselines.set(suite, census.observed); for (const key of census.observed) observedTests.add(key) }
  }
  const measurableSuites = options.suites.filter((suite) => baselines.has(suite))
  // The signal source is a seam: node --test's own child listens for SIGINT on process
  // and aborts the file, so a test hands in its own emitter.
  const signals = deps.signals || process
  const mutantResults = []
  let inFlightSnapshot = null
  const handleSigint = () => {
    if (inFlightSnapshot) restoreSnapshot(inFlightSnapshot)
    signals.removeListener('SIGINT', handleSigint)
    kill(process.pid, 'SIGINT')
  }
  signals.on('SIGINT', handleSigint)
  try {
    for (const mutant of generated.candidates) {
      const snapshot = snapshotFile(targetPath)
      inFlightSnapshot = snapshot
      let suiteOutputs = []
      try {
        const applied = applyDiffCandidate(snapshot.bytes, mutant)
        if (!applied?.bytes) {
          suiteOutputs = [{ error: Object.assign(new Error(applied?.reason || 'apply failed'), { code: 'EACCES' }) }]
        } else {
          const nextBytes = applied.bytes
          writeFileSync(targetPath, nextBytes)
          suiteOutputs = measurableSuites.length === 0
            ? [{ error: Object.assign(new Error('no suite has a measured baseline'), { code: 'BASELINE' }) }]
            : measurableSuites.map((suite) => runSuite(suite, checkout, options.timeoutMs, spawn))
        }
      } catch (error) {
        suiteOutputs = [{ error }]
      } finally {
        restoreSnapshot(snapshot)
        inFlightSnapshot = null
      }
      const outcome = suiteOutputs[0]?.error?.code === 'BASELINE' ? { status: 'unmeasured', reason: REASON.BASELINE_UNMEASURED, survivor: false, killers: [], observed: [], suitesMeasured: [] } : classifyMutantOutcome({ suiteOutputs, baselines })
      // The denominator is every configured suite for this mutant, not only the eligible ones.
      suiteRuns.total += options.suites.length
      suiteRuns.measured += outcome.suitesMeasured.length
      for (const suite of outcome.suitesMeasured) if (suite) suitesWithMeasuredRun.add(suite)
      mutantResults.push({ mutant, ...outcome })
    }
  } finally {
    signals.removeListener('SIGINT', handleSigint)
    if (inFlightSnapshot) restoreSnapshot(inFlightSnapshot)
  }
  const analysis = analyzeKills({ mutantResults, observedTests: [...observedTests] })
  analysis.sourceLines = sourceLines
  analysis.suitesMeasured = suitesWithMeasuredRun.size
  analysis.suiteRuns = suiteRuns
  analysis.baselines = baselineOutcomes.map((census) => ({ suite: census.suite, status: census.status, reason: census.reason, tests: census.observed ? census.observed.length : null }))
  analysis.suitePaths = options.suites
  analysis.sampledMutants = generated.candidates.length
  analysis.sampling = generated.sampling
  analysis.provenance = provenance(checkout, options, spawn)
  analysis.wallClockSeconds = Number(((performance.now() - started) / 1000).toFixed(3))
  const markdown = buildMarkdown(analysis)
  const outputPath = (path) => path.startsWith('/') ? path : join(checkout, path)
  const mdPath = outputPath(options.md)
  mkdirSync(dirname(mdPath), { recursive: true })
  writeFileSync(mdPath, markdown)
  if (options.out) {
    const outPath = outputPath(options.out)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(jsonAnalysis(analysis), null, 2)}\n`)
  }
  ;(deps.stdout || process.stdout).write(`wrote ${relative(checkout, mdPath)}\n`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main()
