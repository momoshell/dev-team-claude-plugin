#!/usr/bin/env node
// scripts/factory/model-eval.mjs — compile and run a reproducible, serial
// model-evaluation bench. The bench inputs are its authority; the ledger is
// only written after each candidate has reached a measured terminal shape.

import {
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  probeLocalEndpoint,
  loadRoster,
  rosterSeating,
  resolveAdapters,
} from '../../crew/crew.mjs'
import { seatIo, settleSeatTeardown } from '../../crew/seat-io.mjs'
import { GATE_SUMMARY_PREFIX, parseGateSummary } from '../../crew/drive.mjs'
import {
  EVAL_ABSENT_REASONS,
  openLedger,
  defaultDbPath,
} from './ledger.mjs'

export const EVAL_REFUSALS = Object.freeze([
  'bench-unreadable', 'bench-sha-mismatch',
  'no-mechanical-gate', 'production-absent', 'local-endpoint-dead',
])
export const EVAL_SEAT_FAILURE_REASONS = Object.freeze({ boot_exit: 'boot-failed', boot_parse: 'boot-unreadable', assignment: 'assignment-failed', wait_error: 'wait-failed', wait_empty: 'wait-empty', runner: 'seat-runner-failed' })
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
  // RETIRED (#983): no same-vendor candidate refusal.
  // No ADR ratifies the rule; a bench whose judge shares a candidate's vendor is now the operator's call, and during a single-provider outage it is the ONLY bench that can run.

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
      seat = { envelope: null, absent_reason: EVAL_SEAT_FAILURE_REASONS.runner, duration_ms: null, error: err?.message || String(err) }
    }
    seat ||= { envelope: null }
    const absentReason = seat.envelope == null ? (seat.absent_reason ?? 'no-envelope') : null
    let recordReason = absentReason
    let gate = null
    let judgeFindings = null
    try {
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
              dir: seat.workdir ?? resolve(dir),
            })
            judgeFindings = findingsFromJudge(judged)
            if (judgeFindings === null) recordReason = recordReason ?? 'judge-not-briefed'
          } catch {
            recordReason = recordReason ?? 'judge-not-briefed'
          }
        }
      }
    } finally {
      try {
        const cleanupResult = await seat.cleanup?.()
        if (cleanupResult?.removed === false && seat.error == null) seat.error = cleanupResult.why || 'worktree cleanup did not prove removal'
      } catch (err) {
        if (seat.error == null) seat.error = errorText(err)
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
      error_text: seat.error ?? null,
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

function commandResult(args, { cwd = process.cwd(), timeout = 0, spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    ...(timeout > 0 ? { timeout } : {}),
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    result,
    parsed: parseJsonOutput(result?.stdout),
    output: `${String(result?.stdout || '')}\n${String(result?.stderr || '')}`,
  }
}

function normaliseCommandResult(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { output: value == null ? '' : String(value) }
  const result = source.result && typeof source.result === 'object' && !Array.isArray(source.result)
    ? source.result
    : source
  const stdout = result?.stdout ?? source.stdout ?? ''
  const stderr = result?.stderr ?? source.stderr ?? ''
  const output = typeof source.output === 'string' ? source.output : `${String(stdout)}\n${String(stderr)}`
  return {
    result: result && typeof result === 'object' ? result : { status: null },
    parsed: source.parsed === undefined ? parseJsonOutput(stdout || output) : source.parsed,
    output,
  }
}

function errorText(value, fallback = 'unknown failure') {
  if (typeof value === 'string' && value.trim()) return value
  if (value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim()) return value.message
  const text = String(value ?? '').trim()
  return text || fallback
}

function commandFailureText(command, fallback) {
  const output = String(command?.output || '').trim()
  if (output) return output
  return errorText(command?.result?.error, fallback)
}

function makeWorktreeDefault(checkout, { spawn = spawnSync, mkdtemp = mkdtempSync, tempRoot = tmpdir() } = {}) {
  const dir = join(mkdtemp(join(tempRoot, 'model-eval-')), 'tree')
  const result = spawn('git', ['-C', checkout, 'worktree', 'add', '--detach', dir, 'HEAD'], { encoding: 'utf8' })
  if (result?.error || result?.status !== 0) {
    throw new Error(`model-eval: git worktree add --detach failed at ${dir}, refusing to run a candidate in the live checkout:\n${String(result?.stderr || result?.stdout || result?.error?.message || '')}`)
  }
  return dir
}

function removeWorktreeDefault(checkout, dir, { spawn = spawnSync } = {}) {
  const result = spawn('git', ['-C', checkout, 'worktree', 'remove', '--force', dir], { encoding: 'utf8' })
  if (result?.status === 0) return { removed: true, why: null, workdir: dir }
  return { removed: false, why: String(result?.stderr || result?.stdout || result?.error?.message || `git worktree remove exited ${String(result?.status)}`), workdir: dir }
}

function worktreeCleanup(sourceCheckout, checkout, removeWorktree) {
  let settled = false
  let result = null
  const finish = (value) => {
    if (value && typeof value === 'object') return { ...value, workdir: value.workdir ?? checkout }
    if (value === true) return { removed: true, why: null, workdir: checkout }
    return { removed: false, why: value === false ? 'worktree removal returned false' : 'worktree removal returned no result', workdir: checkout }
  }
  return () => {
    if (settled) return result
    settled = true
    try {
      const removed = removeWorktree(sourceCheckout, checkout)
      if (removed && typeof removed.then === 'function') {
        result = removed.then(finish)
        return result
      }
      result = finish(removed)
      return result
    } catch (err) {
      result = { removed: false, why: errorText(err), workdir: checkout }
      return result
    }
  }
}

export async function defaultRunSeat({ task, candidate, role, bench, dir, briefFile = null, deps = {} }) {
  const root = resolve(dir || process.cwd())
  const taskFile = briefFile ? resolve(root, String(briefFile)) : join(root, 'task.md')
  const taskSlug = `model-eval-${String(bench).slice(0, 16)}-${role}-${candidate.provider}-${candidate.id}`
    .replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120)
  const now = deps.now || (() => Date.now())
  const started = now()
  if (typeof deps.commandResult !== 'function') deps = { ...deps, commandResult: (args, options) => commandResult(args, { ...options, spawn: deps.spawnSync || spawnSync }) }
  if (typeof deps.makeWorktree !== 'function') deps = { ...deps, makeWorktree: (sourceCheckout) => makeWorktreeDefault(sourceCheckout, { spawn: deps.spawnSync || spawnSync, mkdtemp: deps.mkdtemp || mkdtempSync, tempRoot: deps.tempRoot || tmpdir() }) }
  if (typeof deps.removeWorktree !== 'function') deps = { ...deps, removeWorktree: (sourceCheckout, checkout) => removeWorktreeDefault(sourceCheckout, checkout, { spawn: deps.spawnSync || spawnSync }) }
  if (typeof deps.resolveAdapters !== 'function') deps = { ...deps, resolveAdapters }
  if (typeof deps.seatIo !== 'function') deps = { ...deps, seatIo }
  if (typeof deps.settleSeatTeardown !== 'function') deps = { ...deps, settleSeatTeardown }
  if (typeof deps.readFile !== 'function') deps = { ...deps, readFile: readFileSync }

  const checkout = deps.makeWorktree(process.cwd())
  if (!NON_BLANK(checkout)) throw new Error('model-eval: worktree helper returned no checkout')
  const cleanup = worktreeCleanup(process.cwd(), checkout, deps.removeWorktree)
  const failure = (reason, detail) => ({
    envelope: null,
    absent_reason: reason,
    duration_ms: Math.max(0, now() - started),
    error: errorText(detail),
    workdir: checkout,
    cleanup,
  })
  let io = null
  try {
    const bootArgs = [
      CREW, 'boot', '--task', taskSlug, '--checkout', checkout, '--roles', role,
      `--model-${role}`, candidateModel(candidate),
      `--agent-${role}`, candidate.agent,
      `--effort-${role}`, candidate.effort,
      '--headless-all',
    ]
    let boot
    try {
      boot = normaliseCommandResult(await deps.commandResult(bootArgs, { cwd: checkout }))
    } catch (err) {
      return failure(EVAL_SEAT_FAILURE_REASONS.boot_exit, err)
    }
    if (boot.result?.error || boot.result?.status !== 0) {
      return failure(EVAL_SEAT_FAILURE_REASONS.boot_exit, commandFailureText(boot, 'crew boot did not complete'))
    }
    if (!boot.parsed || typeof boot.parsed !== 'object' || Array.isArray(boot.parsed) || !NON_BLANK(boot.parsed.crew_json)) {
      return failure(EVAL_SEAT_FAILURE_REASONS.boot_parse, commandFailureText(boot, 'crew boot output did not include a readable crew_json path'))
    }

    const crewJson = resolve(checkout, String(boot.parsed.crew_json))
    let crew
    try {
      const raw = await deps.readFile(crewJson, 'utf8')
      crew = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : JSON.parse(String(raw))
    } catch (err) {
      return failure(EVAL_SEAT_FAILURE_REASONS.boot_parse, err)
    }
    const member = crew?.members?.[role]
    if (!crew || typeof crew !== 'object' || Array.isArray(crew) || !member || !['headless-json', 'headless-rpc'].includes(member.transport)) {
      return failure(EVAL_SEAT_FAILURE_REASONS.boot_parse, 'crew.json did not describe a headless member for the requested role')
    }
    const stateDir = dirname(crewJson)
    const taskDir = NON_BLANK(boot.parsed.task_dir)
      ? resolve(checkout, String(boot.parsed.task_dir))
      : join(stateDir, 'task')
    const paths = {
      dir: stateDir,
      taskDir,
      returnsDir: join(stateDir, 'returns'),
    }
    const adapterArgs = {
      [`model-${role}`]: member.model || candidateModel(candidate),
      [`agent-${role}`]: member.agent || candidate.agent,
      [`effort-${role}`]: member.effort || candidate.effort,
      ...(member.transport === 'headless-rpc' ? { 'headless-rpc': role } : { headless: role }),
    }
    const adapters = await deps.resolveAdapters([role], adapterArgs)
    io = await deps.seatIo(crew, paths, checkout, null, adapters, adapterArgs, deps.seatIoDeps || {})
    if (!io || typeof io !== 'object') throw new Error('model-eval: seat I/O factory returned no I/O object')

    let returnPath = null
    try {
      const assignment = io.assign({ role, briefFile: taskFile })
      if (!assignment || !NON_BLANK(assignment.returnPath)) throw new Error('seat I/O assignment returned no return path')
      returnPath = assignment.returnPath
    } catch (err) {
      return failure(EVAL_SEAT_FAILURE_REASONS.assignment, err)
    }

    let waited
    try {
      waited = await io.wait(returnPath, 24 * 60 * 60)
    } catch (err) {
      return failure(EVAL_SEAT_FAILURE_REASONS.wait_error, err)
    }
    if (!waited || typeof waited !== 'object' || Array.isArray(waited) || typeof waited.status !== 'string' || waited.status === 'still-running') {
      return failure(EVAL_SEAT_FAILURE_REASONS.wait_empty, 'seat I/O wait returned no terminal envelope')
    }
    return {
      envelope: waited,
      adw_id: waited.adw_id ?? null,
      workdir: checkout,
      duration_ms: Math.max(0, now() - started),
      usage: waited.usage ?? null,
      cleanup,
    }
  } catch (err) {
    return failure(EVAL_SEAT_FAILURE_REASONS.runner, err)
  } finally {
    try { deps.settleSeatTeardown(io) } catch { /* seat teardown is best-effort; the worktree remains isolated until runBench cleanup */ }
  }
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

async function defaultRunJudge({ judge, envelope, gate, task, bench, dir, deps = {} }) {
  // The judge uses the same seat transport seam as a candidate, but its model
  // is intentionally not added to the candidate cells. Brief it with the
  // candidate's actual envelope and gate result; an unreadable judge response
  // is an absent finding set, never a fabricated empty list.
  const slash = String(judge?.model || '').indexOf('/')
  const provider = slash < 0 ? judge?.vendor : String(judge.model).slice(0, slash)
  const id = slash < 0 ? judge?.model : String(judge.model).slice(slash + 1)
  const root = resolve(dir || process.cwd())
  const briefFile = join(root, `.model-eval-${String(bench)}-judge.md`)
  const writeFile = deps.writeFile || writeFileSync
  const unlinkFile = deps.unlinkFile || unlinkSync
  let seat = null
  try {
    await writeFile(briefFile, [
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
    seat = await defaultRunSeat({
      task, candidate: { provider, id, agent: judge?.agent ?? (provider === 'openai' ? 'pi' : 'claude'), effort: judge?.effort ?? 'medium' },
      role: 'reviewer', bench: `${bench}-judge`, dir, briefFile, deps,
    })
    const findings = findingsFromJudge(seat?.envelope)
    return findings === null ? null : { findings }
  } catch {
    return null
  } finally {
    try { await seat?.cleanup?.() } catch { /* a failed worktree removal remains isolated and is not a finding */ }
    try { await unlinkFile(briefFile) } catch { /* a failed cleanup is not a finding */ }
  }
}

export function normalDeps(deps = {}) {
  const source = deps && typeof deps === 'object' && !Array.isArray(deps) ? deps : {}
  const defaultReadRoster = () => rosterSeating(loadRoster(ROSTER))
  const runtime = {
    ...source,
    commandResult: source.commandResult ?? ((args, options) => commandResult(args, { ...options, spawn: source.spawnSync || spawnSync })),
    makeWorktree: source.makeWorktree ?? ((checkout) => makeWorktreeDefault(checkout, { spawn: source.spawnSync || spawnSync, mkdtemp: source.mkdtemp || mkdtempSync, tempRoot: source.tempRoot || tmpdir() })),
    removeWorktree: source.removeWorktree ?? ((checkout, dir) => removeWorktreeDefault(checkout, dir, { spawn: source.spawnSync || spawnSync })),
    resolveAdapters: source.resolveAdapters ?? resolveAdapters,
    seatIo: source.seatIo ?? seatIo,
    settleSeatTeardown: source.settleSeatTeardown ?? settleSeatTeardown,
    readFile: source.readFile ?? source.readFileSync ?? readFileSync,
    writeFile: source.writeFile ?? writeFileSync,
    unlinkFile: source.unlinkFile ?? unlinkSync,
    now: source.now ?? (() => Date.now()),
  }
  return {
    runSeat: source.runSeat ?? ((spec) => defaultRunSeat({ ...spec, deps: runtime })),
    runGate: source.runGate ?? defaultRunGate,
    runJudge: source.runJudge ?? ((spec) => defaultRunJudge({ ...spec, deps: runtime })),
    probe: async (url) => {
      try { return await (source.probe ?? probeLocalEndpoint)(url) } catch { return false }
    },
    readRoster: source.readRoster === null ? null : (source.readRoster ?? defaultReadRoster),
    ledger: source.ledger === undefined ? null : source.ledger,
    openLedger: source.openLedger ?? (() => openLedger({ dbPath: defaultDbPath() })),
    now: runtime.now,
    commandResult: runtime.commandResult,
    makeWorktree: runtime.makeWorktree,
    removeWorktree: runtime.removeWorktree,
    resolveAdapters: runtime.resolveAdapters,
    seatIo: runtime.seatIo,
    settleSeatTeardown: runtime.settleSeatTeardown,
    readFile: runtime.readFile,
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
