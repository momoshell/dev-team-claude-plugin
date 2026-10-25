import { spawn } from 'node:child_process'
import { constants, cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { compareFingerprints, fingerprintTree } from './tree-fingerprint.mjs'
import { stripVTControlCharacters } from 'node:util'

export const CHECK_REASONS = Object.freeze([
  'invalid-input', 'unsupported-platform', 'exit-nonzero', 'signal', 'spawn-error', 'timeout', 'output-limit',
  'cleanup-unproven', 'gate-no-fail', 'gate-failed', 'gate-inconsistent', 'gate-invalid', 'baseline-green',
  'baseline-unmeasured', 'baseline-invalid', 'invalid-mutations', 'preproof-not-green', 'unsafe-target',
  'bind-fail', 'copy-failed', 'checkout-changed', 'runner-threw', 'gate-green', 'target-not-failed',
  'mutations-survived', 'mutation-unmeasured',
])

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 2 ** 31 - 1
const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
const TERM_GRACE_MS = 150
const REAP_SETTLE_MS = 1000
const POLL_MS = 25
const INHERITED_ENV = ['FORCE_COLOR', 'CLICOLOR_FORCE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DECLARATION_KEYS = ['check', 'file', 'find', 'replace']
const FAIL_LINE = /^FAIL ([A-Za-z0-9][A-Za-z0-9._-]*)(?::.*)?$/
const SUMMARY_LINE = /^GATE-SUMMARY[ \t]+(.*)$/

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms))
const unmeasured = (reason, extra = {}) => ({ status: 'unmeasured', reason, code: null, signal: null, stdout: '', stderr: '', timedOut: false, pgid: null, ...extra })
const validTimeout = (ms) => Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMEOUT_MS
const describeError = (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error) })

function cleanEnv() {
  const env = { ...process.env, NO_COLOR: '1' }
  for (const key of INHERITED_ENV) delete env[key]
  return env
}

// lean: POSIX process groups only; add verified lineage tracking if escaped groups become required
function signalGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return false
  try { process.kill(-child.pid, signal); return true } catch { return false }
}

// Only ESRCH proves the group dead: EPERM means a live group we may not signal, anything else is unknown.
function groupState(probe, pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return 'unknown'
  try { probe(-pgid, 0); return 'live' } catch (error) {
    if (error?.code === 'ESRCH') return 'dead'
    return error?.code === 'EPERM' ? 'live' : 'unknown'
  }
}

// TERM, a short grace, KILL, then a bounded wait for the group to be gone AND the pipes closed.
async function reapGroup(child, probe, isClosed) {
  const reaped = () => groupState(probe, child.pid) === 'dead' && isClosed()
  const until = async (ms) => {
    for (let waited = 0; waited < ms; waited += POLL_MS) {
      if (reaped()) return true
      await sleep(POLL_MS)
    }
    return reaped()
  }
  signalGroup(child, 'SIGTERM')
  if (await until(TERM_GRACE_MS)) return true
  signalGroup(child, 'SIGKILL')
  return until(REAP_SETTLE_MS)
}

export function runSuite({ cwd, command, args = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}, deps = {}) {
  if (process.platform === 'win32') return Promise.resolve(unmeasured('unsupported-platform'))
  const valid = typeof cwd === 'string' && cwd !== '' && typeof command === 'string' && command !== ''
    && Array.isArray(args) && args.every((arg) => typeof arg === 'string')
    && validTimeout(timeoutMs)
  if (!valid) return Promise.resolve(unmeasured('invalid-input'))
  const probe = deps.probeKill ?? ((pid, signal) => process.kill(pid, signal))
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() })
    } catch (error) {
      resolveRun(unmeasured('spawn-error', { error: describeError(error) }))
      return
    }
    const pgid = Number.isSafeInteger(child.pid) ? child.pid : null
    let stdout = ''
    let stderr = ''
    let size = 0
    let timedOut = false
    let overflow = false
    let stopping = false
    let closed = false
    let done = false
    let spawnError = null
    let exit = { code: null, signal: null }

    const classify = (cleanup) => {
      const base = { code: exit.code, signal: exit.signal, stdout, stderr, timedOut, pgid, cleanup }
      if (spawnError) return { status: 'unmeasured', reason: 'spawn-error', ...base, error: describeError(spawnError) }
      if (cleanup === 'unproven') return { status: 'unmeasured', reason: 'cleanup-unproven', ...base }
      if (timedOut) return { status: 'unmeasured', reason: 'timeout', ...base }
      if (overflow) return { status: 'unmeasured', reason: 'output-limit', ...base }
      if (exit.code === null) return { status: 'unmeasured', reason: 'signal', ...base }
      if (exit.code === 0) return { status: 'green', reason: null, ...base }
      return { status: 'red', reason: 'exit-nonzero', ...base }
    }
    const settle = (cleanup) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      const emitters = [child, child.stdout, child.stderr].filter(Boolean)
      for (const emitter of emitters) { emitter.removeAllListeners(); emitter.on('error', () => {}) }
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolveRun(classify(cleanup))
    }
    // `force` is false only for an ordinary close, where a group already proven dead needs no signalling.
    const stop = async (force) => {
      if (stopping) return
      stopping = true
      clearTimeout(deadline)
      if (!force && groupState(probe, pgid) === 'dead') return settle('proven')
      settle(await reapGroup(child, probe, () => closed) ? 'proven' : 'unproven')
    }
    const append = (chunk, target) => {
      if (overflow) return
      size += Buffer.byteLength(chunk)
      if (size > OUTPUT_LIMIT_BYTES) { overflow = true; void stop(true); return }
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
    }

    // The deadline outlives `exit`: a leader that exits while descendants hold the pipes is still bounded.
    const deadline = setTimeout(() => { timedOut = true; void stop(true) }, timeoutMs)
    child.on('error', (error) => {
      spawnError = error
      if (pgid === null) settle('proven')
      else void stop(true)
    })
    child.on('exit', (code, signal) => { exit = { code, signal } })
    child.on('close', (code, signal) => { closed = true; exit = { code, signal }; void stop(false) })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'))
  })
}

function summaryInvalid(stdout, code, failingIds) {
  const lines = stdout.split(/\r?\n/).map((line) => SUMMARY_LINE.exec(line)).filter(Boolean)
  if (lines.length === 0) return false
  if (lines.length > 1) return true
  let summary
  try { summary = JSON.parse(lines[0][1]) } catch { return true }
  const { total, failed, errored } = summary ?? {}
  if (![total, failed, errored].every((n) => Number.isSafeInteger(n) && n >= 0)) return true
  return errored > 0 || failed > total || (failed > 0) !== (code !== 0) || failingIds.length !== failed
}

export async function runGate({ cwd, gatePath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = gatePath ?? 'task/gate.mjs'
  if (typeof cwd !== 'string' || cwd === '' || typeof target !== 'string' || target === '') return { ...unmeasured('invalid-input'), failingIds: [] }
  const run = await runSuite({ cwd, command: process.execPath, args: [resolve(cwd, target)], timeoutMs })
  const stdout = stripVTControlCharacters(run.stdout)
  const matches = stdout.split(/\r?\n/).map((line) => FAIL_LINE.exec(line)).filter(Boolean)
  const failingIds = [...new Set(matches.map((match) => match[1]))]
  if (run.status === 'unmeasured') return { ...run, failingIds }
  if (run.code !== 0 && failingIds.length === 0) return { ...run, status: 'red', reason: 'gate-no-fail', failingIds }
  if (summaryInvalid(stdout, run.code, failingIds)) return { ...run, status: 'red', reason: 'gate-invalid', failingIds }
  if (run.code === 0) return failingIds.length === 0 ? { ...run, failingIds } : { ...run, status: 'red', reason: 'gate-inconsistent', failingIds }
  return { ...run, status: 'red', reason: 'gate-failed', failingIds }
}

// The pre-build baseline must be a completed, nonzero gate that names at least one failing check.
export async function checkBaseline(spec = {}) {
  const result = await runGate(spec)
  if (result.status === 'green') return { accepted: false, reason: 'baseline-green', result }
  if (result.status === 'unmeasured') return { accepted: false, reason: 'baseline-unmeasured', result }
  if (result.reason === 'gate-failed' && result.failingIds.length > 0) return { accepted: true, reason: 'gate-failed', result }
  return { accepted: false, reason: 'baseline-invalid', result }
}


function declarationProblem(checks, mutations) {
  if (!Array.isArray(checks) || checks.length === 0) return 'checks must be a nonempty array'
  if (!checks.every((id) => typeof id === 'string' && CHECK_ID.test(id))) return 'every check id must match the stable id grammar'
  if (new Set(checks).size !== checks.length) return 'check ids must be unique'
  if (!Array.isArray(mutations) || mutations.length !== checks.length) return 'exactly one mutation per check is required'
  const seen = new Set()
  for (const declaration of mutations) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return 'a mutation must be an object'
    if (Object.keys(declaration).sort().join() !== DECLARATION_KEYS.join()) return 'a mutation must be exactly {check,file,find,replace}'
    if (!DECLARATION_KEYS.every((key) => typeof declaration[key] === 'string')) return 'mutation fields must be strings'
    if (declaration.find === '' || declaration.replace === declaration.find) return `mutation ${declaration.check} must change a nonempty find`
    if (!checks.includes(declaration.check)) return `mutation names an undeclared check ${declaration.check}`
    if (seen.has(declaration.check)) return `check ${declaration.check} has more than one mutation`
    seen.add(declaration.check)
  }
  return null
}

// A literal repo-relative path: no absolute, backslash, NUL, empty, dot, dotdot or .git segment.
function literalRelative(file) {
  if (file === '' || file.startsWith('/') || /[\\\0]/.test(file)) return false
  return file.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

// True when every ancestor of `path` under `root` is a real directory and the path is a regular file.
function regularFileUnder(root, path) {
  let dir = root
  for (const part of path.split('/').slice(0, -1)) {
    dir = join(dir, part)
    try { if (!lstatSync(dir).isDirectory()) return false } catch { return false }
  }
  try { return lstatSync(join(root, path)).isFile() } catch { return false }
}

// Every gate run of a proof, the preflight included, runs in a throwaway copy of the checkout,
// so nothing a gate writes (tracked, untracked, ignored, directories) can reach the checkout
// and nothing has to be restored. The copy leaves out the top-level .git, so it is not a git
// checkout: a gate that needs git metadata fails there, which reads as unmeasured, never killed.
// Copies clone on copy-on-write filesystems and copy bytes elsewhere.
function copyTreeDefault(cwd) {
  const root = resolve(cwd)
  const dir = mkdtempSync(join(tmpdir(), 'crew-proof-'))
  try {
    cpSync(root, dir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: (source) => resolve(source) !== join(root, '.git') })
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
  return dir
}

// A gate inside the checkout is run from the copy, so it sees the copy's code; one outside
// (the lane's task dir) is run where it is, with the copy as its working directory.
function gateIn(cwd, copy, gatePath) {
  const gate = resolve(cwd, gatePath ?? 'task/gate.mjs')
  const inside = relative(resolve(cwd), gate)
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? join(copy, inside) : gate
}

// A copy is not a sealed boundary: a symlink in the checkout can lead a gate back into it. So
// the checkout is fingerprinted around every run, and a run that changed it is never credited.
// Blind spot: ignored paths are outside the fingerprint.
async function inCopy(ctx, work) {
  const before = ctx.measure(ctx.cwd)
  if (!before?.measured) return { failed: { reason: 'checkout-changed', error: { code: null, message: `checkout unmeasured: ${before?.detail ?? before?.cause}` } } }
  let copy
  try { copy = ctx.copyTree(ctx.cwd) } catch (error) { return { failed: { reason: 'copy-failed', error: describeError(error) } } }
  let value
  try { value = await work(copy) } finally {
    try { rmSync(copy, { recursive: true, force: true }) } catch (error) { value = { cleanupFailed: describeError(error) } }
  }
  if (value?.cleanupFailed) return { failed: { reason: 'cleanup-unproven', error: value.cleanupFailed, copy } }
  const after = ctx.measure(ctx.cwd)
  if (!after?.measured || compareFingerprints(before, after).outcome !== 'unchanged') {
    return { failed: { reason: 'checkout-changed', error: { code: null, message: 'the checkout changed during a gate run in its copy' } } }
  }
  return { value }
}

function adjudicateMutation(check, result) {
  if (!result || typeof result !== 'object') return { check, outcome: 'unmeasured', reason: 'gate-invalid' }
  if (result.reason === 'timeout') return { check, outcome: 'unmeasured', reason: 'timeout', result }
  if (result.status === 'green') return { check, outcome: 'survived', reason: 'gate-green', result }
  const complete = result.timedOut !== true && !result.signal && Number.isInteger(result.code) && result.code !== 0
  if (result.status !== 'red' || !complete || result.reason !== 'gate-failed' || !Array.isArray(result.failingIds)) {
    const diagnostic = result.status !== 'red' || result.reason !== 'gate-failed'
    const reason = diagnostic && CHECK_REASONS.includes(result.reason) ? result.reason : 'mutation-unmeasured'
    return { check, outcome: 'unmeasured', reason, result }
  }
  if (result.failingIds.includes(check)) return { check, outcome: 'killed', reason: null, result }
  return { check, outcome: 'survived', reason: 'target-not-failed', result }
}

// One mutant in its own copy: bind, apply, run, adjudicate; the copy is removed whatever happens.
async function proveOne(ctx, { check, file, find, replace }) {
  const row = (outcome, reason, extra = {}) => ({ check, outcome, reason, ...extra })
  if (!literalRelative(file)) return row('unmeasured', 'unsafe-target')
  const done = await inCopy(ctx, async (copy) => {
    if (!regularFileUnder(copy, file)) return row('unmeasured', 'unsafe-target')
    const bytes = readFileSync(join(copy, file))
    const needle = Buffer.from(find)
    const offsets = []
    for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) offsets.push(at)
    if (offsets.length !== 1) return row('unmeasured', 'bind-fail', { occurrences: offsets.length })
    writeFileSync(join(copy, file), Buffer.concat([bytes.subarray(0, offsets[0]), Buffer.from(replace), bytes.subarray(offsets[0] + needle.length)]))
    try {
      return adjudicateMutation(check, await ctx.run({ cwd: copy, gatePath: gateIn(ctx.cwd, copy, ctx.gatePath), timeoutMs: ctx.timeoutMs }))
    } catch (error) { return row('unmeasured', 'runner-threw', { error: describeError(error) }) }
  })
  return done.failed ? row('unmeasured', done.failed.reason, { error: done.failed.error }) : done.value
}

// Proves each declared mutation is caught by its own check on a gate that is green after the build.
export async function proveMutations({ cwd, gatePath, checks, mutations, timeoutMs = DEFAULT_TIMEOUT_MS } = {}, deps = {}) {
  const refuse = (status, reason, extra = {}) => ({ status, reason, rows: [], ...extra })
  const badGate = gatePath !== undefined && (typeof gatePath !== 'string' || gatePath === '')
  if (typeof cwd !== 'string' || cwd === '' || badGate || !validTimeout(timeoutMs)) return refuse('unmeasured', 'invalid-input')
  const problem = declarationProblem(checks, mutations)
  if (problem) return refuse('red', 'invalid-mutations', { diagnostic: problem })
  const ctx = { cwd, gatePath, timeoutMs, run: deps.runGate ?? runGate, copyTree: deps.copyTree ?? copyTreeDefault, measure: deps.fingerprintTree ?? fingerprintTree }
  const preflight = await inCopy(ctx, async (copy) => {
    try { return await ctx.run({ cwd: copy, gatePath: gateIn(cwd, copy, gatePath), timeoutMs }) } catch (error) { return { thrown: describeError(error) } }
  })
  if (preflight.failed) return refuse('unmeasured', preflight.failed.reason, { error: preflight.failed.error })
  const green = preflight.value
  if (green?.thrown) return refuse('unmeasured', 'preproof-not-green', { error: green.thrown })
  if (green?.status !== 'green' || green.reason !== null || green.timedOut === true) {
    return refuse(green?.status === 'red' ? 'red' : 'unmeasured', 'preproof-not-green', { preflight: green })
  }
  const rows = []
  for (const id of checks) rows.push(await proveOne(ctx, mutations.find((declaration) => declaration.check === id)))
  if (rows.some((row) => row.outcome === 'survived')) return { status: 'red', reason: 'mutations-survived', rows }
  if (rows.some((row) => row.outcome !== 'killed')) return { status: 'unmeasured', reason: 'mutation-unmeasured', rows }
  return { status: 'green', reason: null, rows }
}
