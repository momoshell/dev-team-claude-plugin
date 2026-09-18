#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, join, relative } from 'node:path'
import { generateDiffCandidates, applyDiffCandidate } from './prove-mutations.mjs'

export const DRIVER_SUITES = Object.freeze([
  'crew/drive-build.test.mjs',
  'crew/drive-plan.test.mjs',
  'crew/drive-publish.test.mjs',
  'crew/drive-review.test.mjs',
  'crew/drive.test.mjs',
])
export const SAMPLE_UNMEASURED_REASON = 'sample-killed-nothing'
export const MUTANT_UNMEASURED_REASONS = Object.freeze([
  'suite-missing', 'no-tap-output', 'spawn-denied', 'interrupted', 'timeout',
])
export const USAGE = `usage: node scripts/factory/kill-redundancy.mjs [--mutants <n>] [--out <json>] [--md <markdown>] [--suites <suite>] [--checkout <dir>] [--timeout-ms <n>] [--seed <n>]`

function seededNumber(seed) {
  let value = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 0x9e3779b9
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
  return { candidates, skips: generated.skips }
}

export function parseTapKills(output) {
  if (typeof output !== 'string' || !/^# tests\s+\d+\s*$/m.test(output.replace(/\x1b\[[0-9;]*m/g, ''))) return null
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  let file = null
  const killers = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(ok|not ok)\s+\d+\s*(?:-\s*(.*))?\s*$/.exec(line)
    if (!match) continue
    const title = (match[2] || '').trim()
    const indented = /^\s+/.test(line)
    if (!indented && /(?:^|[/\\])[^/\\]+\.test\.mjs$/.test(title)) {
      file = title
      continue
    }
    if (indented && match[1] === 'not ok' && file) killers.push(`${file} :: ${title}`)
  }
  return { killers: [...new Set(killers)] }
}

function resultError(result) {
  if (!result) return null
  if (result.error) return result.error
  if (result.spawnError) return result.spawnError
  return null
}

export function classifyMutantOutcome({ suiteOutputs = [] } = {}) {
  if (!suiteOutputs.length) return { status: 'unmeasured', reason: 'no-tap-output', survivor: false, killers: [] }
  const killers = new Set()
  for (const result of suiteOutputs) {
    const error = resultError(result)
    if (result?.timedOut || result?.timeout || error?.code === 'ETIMEDOUT') {
      return { status: 'unmeasured', reason: 'timeout', survivor: false, killers: [] }
    }
    if (result?.interrupted || result?.signal) {
      return { status: 'unmeasured', reason: 'interrupted', survivor: false, killers: [] }
    }
    if (error) {
      const reason = error.code === 'ENOENT' ? 'suite-missing' : 'spawn-denied'
      return { status: 'unmeasured', reason, survivor: false, killers: [] }
    }
    const parsed = parseTapKills(`${result?.stdout || ''}${result?.stderr || ''}`)
    if (!parsed) return { status: 'unmeasured', reason: 'no-tap-output', survivor: false, killers: [] }
    for (const killer of parsed.killers) killers.add(killer)
  }
  const list = [...killers]
  return { status: 'measured', survivor: list.length === 0, killers: list }
}

function mutantOf(result) {
  return result?.mutant || result || {}
}

function redundantRecord(candidate, candidateKills, dominator) {
  return { key: candidate, kills: [...candidateKills], status: 'redundant', dominatedBy: dominator };
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
        const record = redundantRecord(candidate, candidateKills, dominator)
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

function functionForLine(lines, lineNumber) {
  for (let index = Math.min(lines.length - 1, lineNumber - 1); index >= 0; index -= 1) {
    const match = /\bfunction\s+([A-Za-z_$][\w$]*)/.exec(lines[index]) || /\b([A-Za-z_$][\w$]*)\s*\(/.exec(lines[index])
    if (match) return match[1]
  }
  return '(best-effort enclosing function unavailable)'
}

export function formatRate(k, total) {
  const denominator = Number(total)
  const numerator = Number(k)
  const percent = denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : 0
  return `${k} of ${total} (${percent}%)`;
}

function namesForSet(analysis, set) {
  return analysis.tests?.filter((test) => test.kills && test.kills.size === set.size && [...set].every((id) => test.kills.has(id))).map((test) => test.name) || []
}

export function buildMarkdown(analysis = {}) {
  const sampled = analysis.sampledMutants ?? analysis.mutantResults?.length ?? 0
  const killed = analysis.killedMutants ?? 0
  const observed = analysis.observedTests ?? analysis.tests?.length ?? 0
  const withKillSet = analysis.testsWithKillSet ?? analysis.tests?.filter((test) => test.kills?.size).length ?? 0
  const seconds = Number(analysis.wallClockSeconds || 0)
  const lines = [
    '# Driver test redundancy measurement',
    '',
    `Suites measured: ${formatRate(analysis.suitesMeasured ?? DRIVER_SUITES.length, DRIVER_SUITES.length)}`,
    'Driver suites:',
    ...(analysis.suitePaths || DRIVER_SUITES).map((suite) => `- ${suite}`),
    `Mutants sampled: ${formatRate(sampled, sampled)}`,
    `Mutants killed: ${formatRate(killed, sampled)}`,
    `Tests observed: ${formatRate(observed, observed)}`,
    `Tests with a kill-set: ${formatRate(withKillSet, observed)}`,
    `Wall clock seconds: ${formatRate(seconds, seconds)}`,
    '',
    '## Redundancy candidates (grouped by dominating test)',
  ]
  if (!analysis.redundant?.length) lines.push('- none observed')
  else for (const entry of analysis.redundant) {
    const dominators = namesForSet(analysis, entry.dominatedBy)
    lines.push(`- ${dominators.join(', ') || '(dominating test key unavailable)'} dominates ${formatRate(entry.kills.length, sampled)} mutant kills`)
  }
  lines.push('', '## Survivors (gaps in this sample)')
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
  lines.push('', `Sample blind spot: only the first generated candidate per sampled line was measured (${formatRate(sampled, sampled)}).`)
  return `${lines.join('\n')}\n`
}

function jsonAnalysis(analysis) {
  return {
    ...analysis,
    tests: (analysis.tests || []).map((test) => ({ ...test, kills: [...(test.kills || [])] })),
    redundant: (analysis.redundant || []).map((entry) => ({ ...entry, key: [...entry.key], dominatedBy: [...entry.dominatedBy] })),
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
  const started = performance.now()
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
          suiteOutputs = options.suites.map((suite) => runSuite(suite, checkout, options.timeoutMs, spawn))
        }
      } catch (error) {
        suiteOutputs = [{ error }]
      } finally {
        restoreSnapshot(snapshot)
        inFlightSnapshot = null
      }
      mutantResults.push({ mutant, ...classifyMutantOutcome({ suiteOutputs }) })
    }
  } finally {
    signals.removeListener('SIGINT', handleSigint)
    if (inFlightSnapshot) restoreSnapshot(inFlightSnapshot)
  }
  const analysis = analyzeKills({ mutantResults })
  analysis.sourceLines = sourceLines
  analysis.suitesMeasured = options.suites.length
  analysis.suitePaths = options.suites
  analysis.sampledMutants = generated.candidates.length
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
