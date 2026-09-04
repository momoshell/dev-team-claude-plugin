#!/usr/bin/env node
// scripts/factory/model-eval.mjs — compile and run a reproducible, serial
// model-evaluation bench. The bench inputs are its authority; the ledger is
// only written after each candidate has reached a measured terminal shape.

import {
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  shadowExclusion,
  SHADOW_EXCLUSIONS,
  probeLocalEndpoint,
  loadRoster,
  rosterSeating,
} from '../../crew/crew.mjs'
import { GATE_SUMMARY_PREFIX, parseGateSummary } from '../../crew/drive.mjs'
import {
  EVAL_ABSENT_REASONS,
  openLedger,
  defaultDbPath,
} from './ledger.mjs'

// The vendor rule is crew/crew.mjs:1190's, not a copy: shadowExclusion validates
// its name against SHADOW_EXCLUSIONS and throws on anything outside it, so a
// rename there breaks this line rather than silently forking the vocabulary.
export const VENDOR_COLLISION = shadowExclusion('vendor-collision').reason
export const EVAL_REFUSALS = Object.freeze([
  'bench-unreadable', 'bench-sha-mismatch', VENDOR_COLLISION,
  'no-mechanical-gate', 'production-absent', 'local-endpoint-dead',
])
export { EVAL_ABSENT_REASONS }

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = resolve(HERE, '../..')
const CREW = resolve(HERE, '../../crew/crew.mjs')
const ROSTER = resolve(HERE, '../../crew/roster.json')
const HEX_SHA = /^[a-f0-9]{64}$/i
const NON_BLANK = (value) => typeof value === 'string' && value.trim() !== ''

export class EvalRefusal extends Error {
  constructor(refusal, detail) {
    if (!EVAL_REFUSALS.includes(refusal)) throw new Error(`unknown eval refusal ${JSON.stringify(refusal)}`)
    super(`${refusal}: ${detail}`)
    this.name = 'EvalRefusal'
    this.refusal = refusal
    this.detail = detail
  }
}

function refusal(name, detail) {
  return new EvalRefusal(name, detail)
}

function candidateModel(candidate) {
  if (!candidate || typeof candidate !== 'object') return null
  if (!NON_BLANK(candidate.provider) || !NON_BLANK(candidate.id)) return null
  return `${candidate.provider}/${candidate.id}`
}

function validateBenchShape({ task, gate, judge, candidates, benchSha }) {
  if (!NON_BLANK(task) || !NON_BLANK(gate)) throw new Error('task.md and gate.mjs must be non-blank text files')
  if (!judge || typeof judge !== 'object' || Array.isArray(judge)
    || !NON_BLANK(judge.model) || !NON_BLANK(judge.vendor)) {
    throw new Error('judge.json must contain non-blank model and vendor strings')
  }
  if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)
    || candidates.schema !== 1 || !NON_BLANK(candidates.role) || !NON_BLANK(candidates.production)
    || !Array.isArray(candidates.candidates) || candidates.candidates.length === 0) {
    throw new Error('candidates.json must contain role, production and a non-empty candidates array')
  }
  for (const [index, candidate] of candidates.candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !NON_BLANK(candidate.provider) || !NON_BLANK(candidate.id)
      || !NON_BLANK(candidate.agent) || !NON_BLANK(candidate.effort)) {
      throw new Error(`candidates.json candidate ${index + 1} must contain provider, id, agent and effort strings`)
    }
    if (candidate.source === 'local' && !NON_BLANK(candidate.base_url)) {
      throw new Error(`candidates.json local candidate ${index + 1} must contain base_url`)
    }
  }
  if (!NON_BLANK(benchSha) || !HEX_SHA.test(benchSha.trim())) {
    throw new Error('bench.sha must contain one hexadecimal sha256 digest')
  }
}

function readBench(dir) {
  const root = resolve(String(dir || ''))
  const paths = {
    task: join(root, 'task.md'),
    gate: join(root, 'gate.mjs'),
    judge: join(root, 'judge.json'),
    candidates: join(root, 'candidates.json'),
    benchSha: join(root, 'bench.sha'),
  }
  try {
    const task = readFileSync(paths.task, 'utf8')
    const gate = readFileSync(paths.gate, 'utf8')
    const judgeText = readFileSync(paths.judge, 'utf8')
    const candidatesText = readFileSync(paths.candidates, 'utf8')
    const benchSha = readFileSync(paths.benchSha, 'utf8').trim()
    const judge = JSON.parse(judgeText)
    const candidates = JSON.parse(candidatesText)
    validateBenchShape({ task, gate, judge, candidates, benchSha })
    return {
      root,
      task,
      gate,
      judge,
      judgeText,
      candidates,
      candidatesText,
      benchSha,
      gatePath: paths.gate,
    }
  } catch (err) {
    if (err instanceof EvalRefusal) throw err
    throw refusal('bench-unreadable', `bench inputs under ${root} are missing, empty or malformed (${err?.message || String(err)})`)
  }
}

export function benchSha({ task, gate, judge, candidates }) {
  const parts = [task, gate, judge, candidates]
  const hash = createHash('sha256')
  for (const part of parts) {
    const serialized = typeof part === 'string' ? part : JSON.stringify(part)
    const text = serialized === undefined ? '' : serialized
    hash.update(`${Buffer.byteLength(text)}\n${text}`)
  }
  return hash.digest('hex')
}

function gateSummary(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const direct = value.total !== undefined && value.failed !== undefined && value.errored !== undefined
      ? value
      : value.summary
    if (direct && [direct.total, direct.failed, direct.errored].every((number) => Number.isSafeInteger(number) && number >= 0)) {
      return { total: direct.total, failed: direct.failed, errored: direct.errored }
    }
    if (typeof direct === 'string') return parseGateSummary(direct)
    if (typeof value.stdout === 'string' || typeof value.output === 'string') {
      return parseGateSummary(value.stdout ?? value.output)
    }
  }
  if (typeof value === 'string') return parseGateSummary(value)
  return parseGateSummary(value == null ? '' : String(value))
}

function rosterProduction(candidates, readRoster) {
  // A readable roster controls the production comparison. An explicitly
  // unavailable reader, or an unreadable roster, uses its declaration as the
  // documented fallback; an empty or ambiguous seated role is not a claim.
  const declared = candidates.production
  if (typeof readRoster !== 'function') return declared
  try {
    const seating = readRoster()
    if (!seating || typeof seating !== 'object' || Array.isArray(seating) || Object.keys(seating).length === 0) {
      throw new Error('roster seating is unreadable')
    }
    const cells = Object.values(seating)
      .map((preset) => preset?.[candidates.role])
      .filter((cell) => cell && typeof cell === 'object' && !Array.isArray(cell))
    const rosterKeys = [...new Set(cells.map(candidateModel).filter(Boolean))]
    return rosterKeys.length === 1 ? rosterKeys[0] : null
  } catch {
    return declared
  }
}

function summarizeRunGate(value) {
  return gateSummary(value)
}

function gateAsserts({ total, failed, errored } = {}) {
  if (![total, failed, errored].every((number) => Number.isSafeInteger(number) && number >= 0)) {
    return { declared: null, passed: null }
  }
  return { declared: total, passed: total - failed - errored }
}

export async function compileBench({ dir, deps = {} } = {}) {
  deps = normalDeps(deps)
  const source = readBench(dir)
  const sha = benchSha({
    task: source.task,
    gate: source.gate,
    judge: source.judgeText,
    candidates: source.candidatesText,
  })
  if (sha !== source.benchSha) {
    throw refusal('bench-sha-mismatch', `bench.sha ${source.benchSha} does not match the digest of task.md, gate.mjs, judge.json and candidates.json (${sha})`)
  }

  let baseline
  try {
    baseline = gateSummary(await deps.runGate({
      path: source.gatePath,
      gate_path: source.gatePath,
      dir: CHECKOUT,
      cwd: CHECKOUT,
      bench: sha,
    }))
  } catch (err) {
    throw refusal('no-mechanical-gate', `gate.mjs could not provide a readable ${GATE_SUMMARY_PREFIX} summary (${err?.message || String(err)})`)
  }
  if (!baseline || !Number.isSafeInteger(baseline.total) || !Number.isSafeInteger(baseline.failed) || !Number.isSafeInteger(baseline.errored)) {
    throw refusal('no-mechanical-gate', `gate.mjs did not print a readable ${GATE_SUMMARY_PREFIX} summary — a gate that cannot be parsed is unmeasured`)
  }
  if (baseline.total === 0) {
    throw refusal('no-mechanical-gate', 'gate.mjs reports zero mechanical checks — the bench cannot measure a candidate')
  }

  const { judge, candidates: candidateDocument } = source
  const candidates = candidateDocument.candidates
  for (const candidate of candidates) {
    if (candidate.provider === judge.vendor) {
      throw refusal(VENDOR_COLLISION, `candidate ${candidateModel(candidate)} shares judge vendor ${judge.vendor}`)
    }
  }

  const productionModel = rosterProduction(candidateDocument, deps.readRoster)
  const production = candidates.find((candidate) => candidateModel(candidate) === productionModel) ?? null
  if (production === null) {
    throw refusal('production-absent', `the seated ${candidateDocument.role} model ${productionModel} is not among candidates`)
  }

  for (const candidate of candidates) {
    if (candidate.source === 'local' && !(await deps.probe(candidate.base_url))) {
      throw refusal('local-endpoint-dead', `local candidate ${candidateModel(candidate)} at ${candidate.base_url} did not answer the endpoint probe`)
    }
  }

  return Object.freeze({
    sha,
    task: source.task,
    gate_path: source.gatePath,
    judge,
    role: candidateDocument.role,
    candidates,
    production,
  })
}

function usageFromSeat(seat) {
  const usage = seat?.usage
  return {
    billed_input_tokens: usage && typeof usage === 'object' && !Array.isArray(usage)
      ? usage.billed_input_tokens ?? usage.input ?? null
      : null,
    billed_output_tokens: usage && typeof usage === 'object' && !Array.isArray(usage)
      ? usage.billed_output_tokens ?? usage.output ?? null
      : null,
    billed_cache_read_tokens: usage && typeof usage === 'object' && !Array.isArray(usage)
      ? usage.billed_cache_read_tokens ?? usage.cache_read ?? null
      : null,
    billed_cache_write_tokens: usage && typeof usage === 'object' && !Array.isArray(usage)
      ? usage.billed_cache_write_tokens ?? usage.cache_write ?? null
      : null,
  }
}

function findingsFromJudge(result) {
  const findings = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && !Array.isArray(result)
      ? Array.isArray(result.findings)
        ? result.findings
        : Array.isArray(result.judge_findings)
          ? result.judge_findings
          : Array.isArray(result.details?.findings) ? result.details.findings : null
      : null
  if (findings === null) return null
  return findings.map((finding) => typeof finding === 'string' ? finding : finding?.id)
    .filter((finding) => typeof finding === 'string')
}

export async function runBench({ dir, deps = {} } = {}) {
  deps = normalDeps(deps)
  const bench = await compileBench({ dir, deps })
  if (deps.ledger == null) deps.ledger = deps.openLedger()
  if (!deps.ledger || typeof deps.ledger.recordEvalCell !== 'function') {
    throw new Error('model-eval: a ledger with recordEvalCell is required')
  }
  const recorded = []
  for (const candidate of bench.candidates) {
  const handed = bench.task
    const taskSha = createHash('sha256').update(handed).digest('hex')
    let seat
    try {
      seat = await deps.runSeat({
        task: handed,
        candidate,
        role: bench.role,
        bench: bench.sha,
        dir: resolve(dir),
      })
    } catch (err) {
      seat = { envelope: null, absent_reason: 'seat-refused', duration_ms: null, error: err?.message || String(err) }
    }
    seat ||= { envelope: null }
    const absentReason = seat.envelope == null ? (seat.absent_reason ?? 'no-envelope') : null
    let recordReason = absentReason
    let gate = null
    let judgeFindings = null
    if (absentReason === null) {
      try {
        gate = summarizeRunGate(await deps.runGate({
          path: bench.gate_path,
          gate_path: bench.gate_path,
          dir: seat.workdir ?? resolve(dir),
          cwd: seat.workdir ?? resolve(dir),
          candidate,
          bench: bench.sha,
          envelope: seat.envelope,
          task: handed,
        }))
        if (gate === null) recordReason = recordReason ?? 'gate-not-run'
      } catch {
        recordReason = recordReason ?? 'gate-not-run'
      }
      if (recordReason === null) {
        try {
          const judged = await deps.runJudge({
            judge: bench.judge,
            envelope: seat.envelope,
            gate,
            task: handed,
            candidate,
            bench: bench.sha,
            dir: resolve(dir),
          })
          judgeFindings = findingsFromJudge(judged)
          if (judgeFindings === null) recordReason = recordReason ?? 'judge-not-briefed'
        } catch {
          recordReason = recordReason ?? 'judge-not-briefed'
        }
      }
    }
    const asserts = absentReason === null ? gateAsserts(gate) : { declared: null, passed: null }
    const usage = usageFromSeat(seat)
    const row = {
      bench: bench.sha,
      adw_id: seat.adw_id ?? null,
      role: bench.role,
      provider: candidate.provider,
      model_id: candidate.id,
      agent: candidate.agent,
      effort: candidate.effort,
      production: candidateModel(candidate) === candidateModel(bench.production) ? 1 : 0,
      task_sha: taskSha,
      envelope_status: seat.envelope == null ? 'absent' : 'received',
      absent_reason: recordReason,
      asserts_declared: asserts.declared,
      asserts_passed: asserts.passed,
      judge_findings: seat.envelope == null ? null : judgeFindings,
      ...usage,
      duration_ms: seat.duration_ms ?? null,
    }
    await deps.ledger.recordEvalCell({
      ...row,
    })
    recorded.push(row)
  }
  return {
    bench: bench.sha,
    task_sha: createHash('sha256').update(bench.task).digest('hex'),
    cells: recorded,
    production: bench.production,
  }
}

function parseJsonOutput(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]) } catch { /* seek the last JSON line */ }
  }
  return null
}

function commandResult(args, { cwd = process.cwd(), timeout = 0 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    ...(timeout > 0 ? { timeout } : {}),
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    result,
    parsed: parseJsonOutput(result.stdout),
    output: `${String(result.stdout || '')}\n${String(result.stderr || '')}`,
  }
}

function defaultRunSeat({ task, candidate, role, bench, dir, briefFile = null }) {
  const root = resolve(dir || process.cwd())
  const taskFile = briefFile || join(root, 'task.md')
  const taskSlug = `model-eval-${String(bench).slice(0, 16)}-${role}-${candidate.provider}-${candidate.id}`
    .replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120)
  const checkout = process.cwd()
  const bootArgs = [
    CREW, 'boot', '--task', taskSlug, '--checkout', checkout, '--roles', role,
    `--model-${role}`, candidateModel(candidate),
    `--agent-${role}`, candidate.agent,
    `--effort-${role}`, candidate.effort,
    '--headless-all',
  ]
  const started = Date.now()
  const boot = commandResult(bootArgs, { cwd: checkout })
  if (boot.result.status !== 0 || !boot.parsed) {
    return { envelope: null, absent_reason: 'seat-refused', duration_ms: Date.now() - started }
  }
  const handoff = commandResult([
    CREW, 'handoff', '--task', taskSlug, '--checkout', checkout, '--brief-file', taskFile,
  ], { cwd: checkout })
  if (handoff.result.status !== 0) {
    return { envelope: null, absent_reason: 'seat-refused', duration_ms: Date.now() - started }
  }
  const waited = commandResult([
    CREW, 'wait', '--task', taskSlug, '--checkout', checkout,
  ], { cwd: checkout, timeout: 24 * 60 * 60 * 1000 })
  if (waited.parsed && typeof waited.parsed.status === 'string' && waited.parsed.status !== 'still-running') {
    return {
      envelope: waited.parsed,
      workdir: checkout,
      duration_ms: Date.now() - started,
      usage: null,
    }
  }
  return { envelope: null, absent_reason: 'no-envelope', duration_ms: Date.now() - started }
}

function defaultRunGate({ path, gate_path, dir, cwd }) {
  const result = spawnSync(process.execPath, [path || gate_path], {
    cwd: cwd || dir || process.cwd(),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  })
  return gateSummary(`${String(result.stdout || '')}\n${String(result.stderr || '')}`)
}

async function defaultRunJudge({ judge, envelope, gate, task, bench, dir }) {
  // The judge uses the same seat transport seam as a candidate, but its model
  // is intentionally not added to the candidate cells. Brief it with the
  // candidate's actual envelope and gate result; an unreadable judge response
  // is an absent finding set, never a fabricated empty list.
  const slash = String(judge?.model || '').indexOf('/')
  const provider = slash < 0 ? judge?.vendor : String(judge.model).slice(0, slash)
  const id = slash < 0 ? judge?.model : String(judge.model).slice(slash + 1)
  const root = resolve(dir || process.cwd())
  const briefFile = join(root, `.model-eval-${String(bench)}-judge.md`)
  try {
    writeFileSync(briefFile, [
      '# Model evaluation judge',
      '',
      'Evaluate the candidate response against the bench task and mechanical gate.',
      '',
      '## Bench task',
      task,
      '',
      '## Candidate envelope',
      JSON.stringify(envelope),
      '',
      '## Mechanical gate',
      JSON.stringify(gate),
      '',
    ].join('\n'))
    const seat = await defaultRunSeat({
      task, candidate: { provider, id, agent: judge?.agent ?? (provider === 'openai' ? 'pi' : 'claude'), effort: judge?.effort ?? 'medium' },
      role: 'reviewer', bench: `${bench}-judge`, dir, briefFile,
    })
    const findings = findingsFromJudge(seat?.envelope)
    return findings === null ? null : { findings }
  } catch {
    return null
  } finally {
    try { unlinkSync(briefFile) } catch { /* a failed cleanup is not a finding */ }
  }
}

export function normalDeps(deps = {}) {
  const source = deps && typeof deps === 'object' && !Array.isArray(deps) ? deps : {}
  const defaultReadRoster = () => rosterSeating(loadRoster(ROSTER))
  return {
    runSeat: source.runSeat ?? defaultRunSeat,
    runGate: source.runGate ?? defaultRunGate,
    runJudge: source.runJudge ?? defaultRunJudge,
    probe: async (url) => {
      try { return await (source.probe ?? probeLocalEndpoint)(url) } catch { return false }
    },
    readRoster: source.readRoster === null ? null : (source.readRoster ?? defaultReadRoster),
    ledger: source.ledger === undefined ? null : source.ledger,
    openLedger: source.openLedger ?? (() => openLedger({ dbPath: defaultDbPath() })),
    now: source.now ?? (() => Date.now()),
  }
}

function cliRefusal(refusalName, detail) {
  process.stdout.write(`${JSON.stringify({ refusal: refusalName, detail })}\n`)
  return 2
}

export function main(argv = []) {
  return (async () => {
    const args = Array.isArray(argv) ? [...argv] : []
    const command = args.shift()
    if (command !== 'compile' && command !== 'run') {
      return cliRefusal('bench-unreadable', 'usage: model-eval.mjs <compile|run> --bench <dir>')
    }
    let dir = null
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--bench') {
        dir = args[index + 1]
        index += 1
      } else {
        return cliRefusal('bench-unreadable', `unknown or positional argument ${JSON.stringify(arg)} — use --bench <dir>`)
      }
    }
    if (!NON_BLANK(dir)) return cliRefusal('bench-unreadable', '--bench <dir> is required')
    try {
      const result = command === 'compile'
        ? await compileBench({ dir })
        : await runBench({ dir })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    } catch (err) {
      if (err instanceof EvalRefusal) return cliRefusal(err.refusal, err.detail)
      process.stdout.write(`${JSON.stringify({ error: err?.message || String(err) })}\n`)
      return 1
    }
  })()
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((err) => {
    process.stdout.write(`${JSON.stringify({ error: err?.message || String(err) })}\n`)
    process.exitCode = 1
  })
}
