import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { compareFingerprints, fingerprintTree } from './tree-fingerprint.mjs'

export const CHECK_REASONS = Object.freeze([
  'invalid-input', 'unsupported-platform', 'exit-nonzero', 'signal', 'spawn-error', 'timeout', 'output-limit',
  'cleanup-unproven', 'gate-no-fail', 'gate-failed', 'gate-inconsistent', 'gate-invalid', 'baseline-green',
  'baseline-unmeasured', 'baseline-invalid', 'invalid-mutations', 'preproof-not-green', 'unsafe-target',
  'bind-fail', 'tree-unmeasured', 'tree-not-restored', 'runner-threw', 'gate-green', 'target-not-failed',
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

// Checkouts with a proof in flight: two concurrent proofs would snapshot and restore each other's mutants.
const proofsInFlight = new Set()
const byDepth = (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1)

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

// 'ok' when every ancestor is a real directory, 'missing' at the first absent one, else 'unsafe' (symlink, file, unreadable).
function ancestorState(cwd, path) {
  let dir = cwd
  for (const part of path.split('/').slice(0, -1)) {
    dir = join(dir, part)
    let st
    try { st = lstatSync(dir) } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unsafe' }
    if (!st.isDirectory()) return 'unsafe'
  }
  return 'ok'
}

// Ignored paths the fingerprint does not inventory, collapsed to the outermost ignored
// directory. A gate run that creates one is undone by removing it; a file written inside a
// directory that was already ignored before the run is not seen (blind spot).
function listIgnoredDefault(cwd) {
  const listed = spawnSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd, encoding: 'utf8', maxBuffer: OUTPUT_LIMIT_BYTES })
  if (listed.status !== 0) return null
  return listed.stdout.split('\0').filter(Boolean).map((path) => path.replace(/\/$/, ''))
}

// lean: serial mutations with an in-memory checkout snapshot; use isolated byte copies if scale requires it
function snapshotTree(cwd, measure, listIgnored) {
  const ignored = listIgnored(cwd)
  if (!ignored) return { ok: false, diagnostic: 'ignored paths unmeasured' }
  const before = measure(cwd)
  if (!before?.measured) return { ok: false, diagnostic: before?.detail ?? before?.cause ?? 'inventory unmeasured' }
  const nodes = new Map()
  try {
    for (const path of Object.keys(before.entries)) {
      const full = join(cwd, path)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) nodes.set(path, { kind: 'link', target: readlinkSync(full, 'buffer') })
      else if (st.isFile()) nodes.set(path, { kind: 'file', mode: st.mode & 0o7777, bytes: readFileSync(full) })
      else return { ok: false, diagnostic: `${path} is neither a regular file nor a symlink` }
    }
  } catch (error) { return { ok: false, diagnostic: describeError(error).message } }
  const drift = compareFingerprints(before, measure(cwd)).outcome
  if (drift !== 'unchanged') return { ok: false, diagnostic: `checkout ${drift} during the snapshot` }
  return { ok: true, measure, listIgnored, ignored: new Set(ignored), fingerprint: before, nodes }
}

function nodeMatches(node, full, st) {
  if (node.kind === 'link') return st.isSymbolicLink() && readlinkSync(full, 'buffer').equals(node.target)
  return st.isFile() && (st.mode & 0o7777) === node.mode && readFileSync(full).equals(node.bytes)
}

function restoreNode(cwd, path, node) {
  const full = join(cwd, path)
  const state = ancestorState(cwd, path)
  if (state === 'unsafe') throw new Error('an ancestor is not a real directory')
  if (state === 'missing') mkdirSync(dirname(full), { recursive: true })
  let current = null
  try { current = lstatSync(full) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current && nodeMatches(node, full, current)) return
  if (current) rmSync(full, { recursive: true, force: true })
  if (node.kind === 'link') { symlinkSync(node.target, full); return }
  writeFileSync(full, node.bytes, { flag: 'wx', mode: node.mode })
  chmodSync(full, node.mode)
}

// Removes added paths, rewrites changed or deleted ones from raw bytes, then proves it with a fresh fingerprint.
function restoreTreeDefault(cwd, snapshot) {
  const errors = []
  const attempt = (path, action) => { try { action() } catch (error) { errors.push({ path, ...describeError(error) }) } }
  const current = snapshot.measure(cwd)
  if (!current?.measured) errors.push({ path: null, code: null, message: `inventory unmeasured: ${current?.detail ?? current?.cause}` })
  const added = current?.measured ? Object.keys(current.entries).filter((path) => !snapshot.nodes.has(path)).sort(byDepth) : []
  for (const path of added) attempt(path, () => { if (ancestorState(cwd, path) === 'ok') rmSync(join(cwd, path), { force: true }) })
  for (const [path, node] of [...snapshot.nodes].sort(([a], [b]) => byDepth(a, b))) attempt(path, () => restoreNode(cwd, path, node))
  const newIgnored = () => snapshot.listIgnored(cwd)?.filter((path) => !snapshot.ignored.has(path)) ?? null
  for (const path of (newIgnored() ?? []).sort(byDepth).reverse()) {
    attempt(path, () => { if (literalRelative(path) && ancestorState(cwd, path) === 'ok') rmSync(join(cwd, path), { recursive: true, force: true }) })
  }
  const left = newIgnored()
  if (left === null) errors.push({ path: null, code: null, message: 'ignored paths unmeasured after restore' })
  else for (const path of left) errors.push({ path, code: null, message: 'an ignored path the gate created is still present' })
  const verdict = compareFingerprints(snapshot.fingerprint, snapshot.measure(cwd))
  if (verdict.outcome !== 'unchanged') errors.push({ path: null, code: null, message: `fresh fingerprint is ${verdict.outcome}` })
  return { restored: errors.length === 0, errors }
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

// One serial transaction: snapshot, apply, run, and ALWAYS restore before adjudicating anything.
async function proveOne(ctx, { check, file, find, replace }) {
  const { cwd, gatePath, timeoutMs, run, restoreTree, measure, listIgnored } = ctx
  const row = (outcome, reason, extra = {}) => ({ check, outcome, reason, ...extra })
  if (!literalRelative(file)) return row('unmeasured', 'unsafe-target')
  const snapshot = snapshotTree(cwd, measure, listIgnored)
  if (!snapshot.ok) return row('unmeasured', 'tree-unmeasured', { diagnostic: snapshot.diagnostic })
  const node = snapshot.nodes.get(file)
  if (node?.kind !== 'file' || ancestorState(cwd, file) !== 'ok') return row('unmeasured', 'unsafe-target')
  const needle = Buffer.from(find)
  const offsets = []
  for (let at = node.bytes.indexOf(needle); at !== -1; at = node.bytes.indexOf(needle, at + 1)) offsets.push(at)
  if (offsets.length !== 1) return row('unmeasured', 'bind-fail', { occurrences: offsets.length })
  const mutant = Buffer.concat([node.bytes.subarray(0, offsets[0]), Buffer.from(replace), node.bytes.subarray(offsets[0] + needle.length)])
  let outcome, failure
  try {
    writeFileSync(join(cwd, file), mutant)
    outcome = adjudicateMutation(check, await run({ cwd, gatePath, timeoutMs }))
  } catch (error) {
    outcome = row('unmeasured', 'runner-threw', { error: describeError(error) })
  } finally {
    failure = await restoreTree(cwd, snapshot)
  }
  if (failure) return row('unmeasured', 'tree-not-restored', { errors: failure })
  return outcome
}

// Proves each declared mutation is caught by its own check on a gate that is green after the build.
export async function proveMutations({ cwd, gatePath, checks, mutations, timeoutMs = DEFAULT_TIMEOUT_MS } = {}, deps = {}) {
  const refuse = (status, reason, extra = {}) => ({ status, reason, rows: [], ...extra })
  const badGate = gatePath !== undefined && (typeof gatePath !== 'string' || gatePath === '')
  if (typeof cwd !== 'string' || cwd === '' || badGate || !validTimeout(timeoutMs)) return refuse('unmeasured', 'invalid-input')
  const problem = declarationProblem(checks, mutations)
  if (problem) return refuse('red', 'invalid-mutations', { diagnostic: problem })
  const owner = resolve(cwd)
  if (proofsInFlight.has(owner)) return refuse('unmeasured', 'invalid-input', { diagnostic: 'another proof owns this checkout' })
  proofsInFlight.add(owner)
  try {
    const run = deps.runGate ?? runGate
    const measure = deps.fingerprintTree ?? fingerprintTree
    const listIgnored = deps.listIgnored ?? listIgnoredDefault
    const restoreImpl = deps.restoreTree ?? restoreTreeDefault
    const restoreTree = async (dir, snapshot) => {
      try {
        const done = await restoreImpl(dir, snapshot)
        return done?.restored === true ? null : done?.errors ?? [{ message: 'restoration was not confirmed' }]
      } catch (error) { return [describeError(error)] }
    }
    // The preflight is a gate run too: whatever it writes is undone before the first mutant,
    // so every mutant snapshot is the tree as the proof found it.
    const original = snapshotTree(cwd, measure, listIgnored)
    if (!original.ok) return refuse('unmeasured', 'tree-unmeasured', { diagnostic: original.diagnostic })
    let preflight
    try { preflight = await run({ cwd, gatePath, timeoutMs }) } catch (error) { preflight = { thrown: describeError(error) } }
    const preflightFailure = await restoreTree(cwd, original)
    if (preflightFailure) return refuse('unmeasured', 'tree-not-restored', { errors: preflightFailure, preflight })
    if (preflight?.thrown) return refuse('unmeasured', 'preproof-not-green', { error: preflight.thrown })
    if (preflight?.status !== 'green' || preflight.reason !== null || preflight.timedOut === true) {
      return refuse(preflight?.status === 'red' ? 'red' : 'unmeasured', 'preproof-not-green', { preflight })
    }
    const ctx = { cwd, gatePath, timeoutMs, run, restoreTree, measure, listIgnored }
    const rows = []
    for (const id of checks) {
      rows.push(await proveOne(ctx, mutations.find((declaration) => declaration.check === id)))
      if (rows.at(-1).reason === 'tree-not-restored') return { status: 'unmeasured', reason: 'tree-not-restored', rows }
    }
    if (rows.some((row) => row.outcome === 'survived')) return { status: 'red', reason: 'mutations-survived', rows }
    if (rows.some((row) => row.outcome !== 'killed')) return { status: 'unmeasured', reason: 'mutation-unmeasured', rows }
    return { status: 'green', reason: null, rows }
  } finally {
    proofsInFlight.delete(owner)
  }
}
