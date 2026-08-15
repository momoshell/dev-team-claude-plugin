// The daemon owns long-lived headless runs; clients only observe a projection.
import netDefault from 'node:net'
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  appendFileSync as fsAppendFileSync,
  mkdirSync as fsMkdirSync,
  unlinkSync as fsUnlinkSync,
  openSync as fsOpenSync,
  writeSync as fsWriteSync,
  readSync as fsReadSync,
  fstatSync as fsFstatSync,
  closeSync as fsCloseSync,
  statSync as fsStatSync,
} from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fork as cpFork, spawnSync as cpSpawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { splitFrames, seatCommandPath, steerFrame } from './headless-rpc.mjs'
import { slugOrNull } from './slug.mjs'
import { regrantVerdict, continuationBrief } from './escalation-policy.mjs'

const regranted = new Set()
const MAX_FRAME_BYTES = 1024 * 1024
const SELF_PATH = decodeURIComponent(new URL(import.meta.url).pathname)
const HERE = dirname(SELF_PATH)
const CHILD_PATH = join(HERE, 'child.mjs')
// The daemon SPAWNS crew.mjs as a child process and must never import it; see the daemon.test.mjs import firewall.
const CREW_PATH = join(HERE, 'crew.mjs')
const adapterCache = new Map()
const SEND_INTERJECTION = 'boundary'
const MAX_SEND_BYTES = 512

function runError(code, message) { const err = new Error(message); err.code = code; return err }

async function capabilityProfile(agent, transport) {
  const name = String(agent || 'claude')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw runError('not-capable', `invalid adapter name ${JSON.stringify(name)}`)
  let mod = adapterCache.get(name)
  if (!mod) {
    const file = join(HERE, 'adapters', `adapter-${name}.mjs`)
    if (!fsExistsSync(file)) throw runError('not-capable', `no adapter "${name}" is installed`)
    try { mod = await import(pathToFileURL(file).href) }
    catch (err) { throw runError('not-capable', `cannot load adapter "${name}": ${err?.message || String(err)}`) }
    adapterCache.set(name, mod)
  }
  try {
    if (typeof mod.capabilitiesFor !== 'function') throw new Error(`adapter "${name}" has no capabilitiesFor export`)
    return mod.capabilitiesFor({ transport })
  } catch (err) {
    throw runError('not-capable', err?.message || String(err))
  }
}

export const RUN_STATES = Object.freeze(['queued', 'working', 'blocked', 'done', 'dead'])
export const EVENT_KINDS = Object.freeze(['started', 'tool-call', 'blocked', 'terminal-result', 'died', 'usage'])
export const DAEMON_COMMANDS = Object.freeze(['ping', 'enqueue', 'list', 'state', 'result', 'tail', 'untail', 'stop', 'send'])
// Keep a tail for post-settle clients; ADR-029 already makes the projection lossy, so bound rather than drop.
export const SETTLED_FEED_RETENTION = 50
// Two concurrent crews, not one and not "as many as you hand me". Each
// running run is a full headless crew (3+ agent processes) drawing on
// one shared API usage window, and this repo has already paid for
// unbounded burn once (#39 cost discipline); a second slot keeps an
// unrelated checkout moving while the first crew is mid-review without
// doubling that risk again. Raise it per-daemon with daemon({concurrency}).
export const DEFAULT_CONCURRENCY = 2
// Budget windows count only measured headless daemon work. Pane seats report
// no usage and are uncounted because enqueue refuses pane transport before a
// run is admitted; no run this ceiling governs can contain one.
export const DEFAULT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000
// Duplicated from scripts/factory/ledger.mjs:78 (NODE_FLOOR), which is the
// source of truth. The import firewall forbids importing it here, the same
// posture this file already takes for the ledger db-path convention and the
// agent_sessions column names. The two literals must move together: below
// this floor the emitter degrades to JSONL only and writes no DB, so a ceiling
// read here would be zero forever.
export const LEDGER_NODE_FLOOR = '24.0.0'
// Date's representable millisecond range. A larger window makes the rolling
// start invalid at admission, so reject it with the rest of budget validation.
const MAX_BUDGET_WINDOW_MS = 8_640_000_000_000_000

// TODO(#165/#46): unresolved-attention snapshot derives here once parks are minted; ADR-029 §4 forbids live attention before the park id exists.

function splitStream() {
  let rest = Buffer.alloc(0)
  return {
    push(chunk) {
      const input = Buffer.concat([rest, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')])
      const split = splitFrames(input)
      rest = split.rest
      if (rest.length > MAX_FRAME_BYTES || split.lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES)) {
        const err = new Error('frame exceeds 1 MiB')
        err.code = 'frame-too-large'
        throw err
      }
      return split.lines
    },
    rest() { return rest },
  }
}

function valueRole(row) { return row?.role ?? row?.worker_role ?? row?.seat ?? null }
function roleEvent(kind, role, fields = {}) { return { kind, ...(role == null ? {} : { role }), ...fields } }

function streamContent(row) {
  if (Array.isArray(row?.message?.content)) return row.message.content
  if (Array.isArray(row?.content)) return row.content
  if (Array.isArray(row?.delta?.content)) return row.delta.content
  return []
}

function usageEvent(row) {
  const usage = row?.usage && typeof row.usage === 'object' ? row.usage
    : row?.message?.usage && typeof row.message.usage === 'object' ? row.message.usage : row
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null && usage.inputTokens == null && usage.outputTokens == null)) return null
  const fields = {}
  if (usage.input_tokens != null || usage.inputTokens != null) fields.input_tokens = usage.input_tokens ?? usage.inputTokens
  if (usage.output_tokens != null || usage.outputTokens != null) fields.output_tokens = usage.output_tokens ?? usage.outputTokens
  return roleEvent('usage', valueRole(row), fields)
}

export function deriveState({ terminal, alive, blocked, queued }) {
  if (terminal) return 'done'
  if (queued === true) return 'queued'
  if (alive === false) return 'dead'
  if (blocked === true) return 'blocked'
  return 'working'
}

export function normalizeEvent(source, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  if (source === 'daemon') {
    if (row.event === 'fork' || row.event === 'run-forked' || row.event === 'started' || row.forked === true || row.run_forked === true) {
      const runId = row.run_id ?? row.runId
      if (runId == null || row.pid == null) return null
      return { kind: 'started', scope: 'run', run_id: runId, pid: row.pid }
    }
    if (row.event === 'died' || row.dead === true) {
      return { kind: 'died', scope: row.scope || 'run', ...(valueRole(row) == null ? {} : { role: valueRole(row) }), exit_code: row.exit_code ?? null, signal: row.signal ?? null }
    }
    return null
  }
  if (source === 'journal') {
    if (row.event === 'headless-spawn') {
      if (row.id == null || row.pid == null) return null
      return { kind: 'started', scope: 'worker', role: row.role, worker_id: row.id, pid: row.pid }
    }
    if (row.no_lead_escalation != null) return { kind: 'blocked', why: String(row.no_lead_escalation) }
    if (row.headless_outcome != null || row.rpc_outcome != null) {
      return roleEvent('terminal-result', valueRole(row), {
        outcome: row.headless_outcome ?? row.rpc_outcome,
        exit_code: row.exit_code ?? null,
        terminal_reason: row.terminal_reason ?? null,
      })
    }
    return null
  }
  if (source === 'stream') {
    const role = valueRole(row)
    if (row.type === 'result') return roleEvent('terminal-result', role, { terminal_reason: row.terminal_reason ?? row.subtype ?? null })
    if (row.type === 'assistant') {
      const block = streamContent(row).find((part) => part && (part.type === 'tool_use' || part.type === 'tool-call' || part.type === 'tool_call'))
      if (block) {
        const tool = block.name ?? block.tool ?? block.tool_name
        return tool == null ? null : roleEvent('tool-call', role, { tool })
      }
    }
    if (row.type === 'usage' || row.usage || row.message?.usage || row.input_tokens != null || row.output_tokens != null) return usageEvent(row)
    return null
  }
  if (source === 'worker' && (row.event === 'exit' || row.event === 'died' || row.dead === true)) {
    return { kind: 'died', scope: 'worker', ...(valueRole(row) == null ? {} : { role: valueRole(row) }), exit_code: row.exit_code ?? null, signal: row.signal ?? null }
  }
  return null
}

// Exported for the child entry, not part of the daemon protocol.
export function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value) }

function isPlainObject(value) {
  if (!isObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function versionAtLeast(value, floor) {
  const parse = (version) => {
    const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/)
    return match ? match.slice(1).map(Number) : null
  }
  const actual = parse(value)
  const minimum = parse(floor)
  if (!actual || !minimum) return false
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

// Each agent_sessions row is a running total for one session, not a delta;
// SUM-over-rows is therefore correct (scripts/factory/ledger.mjs:1378), while
// MAX or a last-row read silently under-reports a window.
export function usageWindow({ dbPath, since, nodeVersion = process.versions.node } = {}) {
  if (!versionAtLeast(nodeVersion, LEDGER_NODE_FLOOR)) {
    return {
      measured: false, total: null, sessions: 0,
      why: `node ${nodeVersion} is below the ledger's ${LEDGER_NODE_FLOOR} floor — the run emitter records JSONL only and writes no database, so this window cannot be measured`,
    }
  }
  let db = null
  try {
    // An absent db is fresh only when this runtime can read future ledger
    // rows. Without node:sqlite, child emitters are JSONL-only and a configured
    // ceiling must fail closed rather than remain zero forever.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    if (!fsExistsSync(dbPath)) return { measured: true, total: 0, sessions: 0 }
    db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare(`
      SELECT COUNT(*) AS sessions,
             COALESCE(SUM(billed_input_tokens),0)       AS input,
             COALESCE(SUM(billed_output_tokens),0)      AS output,
             COALESCE(SUM(billed_cache_write_tokens),0) AS cache_write,
             COALESCE(SUM(billed_cache_read_tokens),0)  AS cache_read
      FROM agent_sessions WHERE started_at >= ?
    `).get(since)
    const total = ['input', 'output', 'cache_write', 'cache_read']
      .reduce((sum, key) => sum + Number(row?.[key] ?? 0), 0)
    return { measured: true, total, sessions: Number(row?.sessions ?? 0) }
  } catch (err) {
    return { measured: false, total: null, sessions: 0, why: err?.message || String(err) }
  } finally {
    try { db?.close() } catch { /* a read-only close is best effort */ }
  }
}

function hasPid(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

function processAlive(kill, value) {
  const n = Number(value)
  if (!hasPid(n)) return null
  try { kill(n, 0); return true }
  catch (err) { return err?.code === 'ESRCH' ? false : true }
}

function jsonAt(path, exists, read) {
  if (!path || !exists(path)) return null
  try {
    const value = JSON.parse(String(read(path, 'utf8')))
    return isObject(value) ? value : null
  } catch { return null }
}

function absoluteChildPath(root, value) {
  if (!value) return null
  return resolvePath(root, String(value))
}

// Deliberately duplicates realio.mjs:16: importing realio.mjs for one string is
// the exact cost this change removes; daemon.test.mjs pins the two together.
export const PANE_TRANSPORT = 'pane'

// Exported for the child entry, not part of the daemon protocol.
// A pane seat needs a human at a terminal; nothing the daemon forks has one.
export function paneSeat(crew) {
  const roles = crew?.roles || Object.keys(crew?.members || {})
  for (const role of roles) {
    const member = crew?.members?.[role]
    if (!member || !member.transport || member.transport === PANE_TRANSPORT) return role
  }
  return null
}

export function daemon(options = {}) {
  const concurrency = options.concurrency === undefined ? DEFAULT_CONCURRENCY : options.concurrency
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be an integer >= 1')
  const injected = options.deps || {}
  const env = injected.env || process.env
  const budgetOption = options.budget
  if (budgetOption !== undefined && budgetOption !== null && !isPlainObject(budgetOption)) {
    throw new Error('budget must be a plain object')
  }
  if (budgetOption && (!Number.isInteger(budgetOption.max_tokens) || budgetOption.max_tokens < 1)) {
    throw new Error('budget.max_tokens must be an integer >= 1')
  }
  if (budgetOption && budgetOption.window_ms !== undefined
      && (!Number.isInteger(budgetOption.window_ms) || budgetOption.window_ms < 1 || budgetOption.window_ms > MAX_BUDGET_WINDOW_MS)) {
    throw new Error(`budget.window_ms must be an integer from 1 through ${MAX_BUDGET_WINDOW_MS}`)
  }
  if (budgetOption && budgetOption.ledger_db !== undefined
      && (typeof budgetOption.ledger_db !== 'string' || budgetOption.ledger_db.trim() === '')) {
    throw new Error('budget.ledger_db must be a non-empty string')
  }
  const budgetLedgerDb = budgetOption?.ledger_db
    || env.DEVTEAM_LEDGER_DB
    || join(env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')
  const budget = budgetOption == null ? null : {
    max_tokens: budgetOption.max_tokens,
    window_ms: budgetOption.window_ms ?? DEFAULT_BUDGET_WINDOW_MS,
    ledger_db: budgetLedgerDb,
  }
  const root = resolvePath(options.root || join(homedir(), '.crew', 'daemon'))
  const socketPath = join(root, 'daemon.sock')
  const pidPath = join(root, 'daemon.json')
  const registryPath = join(root, 'runs.jsonl')
  const net = injected.net || netDefault
  const fork = injected.fork || cpFork
  const spawnSync = injected.spawnSync || cpSpawnSync
  const kill = injected.kill || ((pid, signal) => process.kill(pid, signal))
  const now = injected.now || (() => Date.now())
  const nodeVersion = injected.nodeVersion || process.versions.node
  const readUsageWindow = injected.usageWindow || usageWindow
  const uuid = injected.uuid || randomUUID
  const pid = injected.pid ?? process.pid
  const exists = injected.existsSync || fsExistsSync
  const read = injected.readFileSync || fsReadFileSync
  const write = injected.writeFileSync || fsWriteFileSync
  const append = injected.appendFileSync || fsAppendFileSync
  const mkdir = injected.mkdirSync || fsMkdirSync
  const unlink = injected.unlinkSync || fsUnlinkSync
  const open = injected.openSync || fsOpenSync
  const writeAt = injected.writeSync || fsWriteSync
  const readAt = injected.readSync || fsReadSync
  const fstat = injected.fstatSync || fsFstatSync
  const close = injected.closeSync || fsCloseSync
  const stat = injected.statSync || fsStatSync
  const setEvery = injected.setInterval || setInterval
  const clearEvery = injected.clearInterval || clearInterval
  const pollMs = injected.pollMs ?? 250
  const feedRetention = injected.feedRetention ?? SETTLED_FEED_RETENTION

  const runs = new Map()
  const subscribers = new Set()
  const connections = new Set()
  let server = null
  let interval = null
  let intervalSet = false
  let started = false
  let ownsFiles = false
  let folded = false

  function appendRecord(record) {
    mkdir(root, { recursive: true })
    append(registryPath, `${JSON.stringify(record)}\n`, { flag: 'a' })
  }

  function orphanRun(run, reason = 'orphaned-on-restart') {
    if (run.lifecycle === 'orphaned' || run.lifecycle === 'settled') return
    run.lifecycle = 'orphaned'; run.orphaned = true; run.child_dead = true; run.orphan_reason = reason
    try { appendRecord({ kind: 'orphaned', run_id: run.run_id, at: now() }) } catch { /* preserve daemon liveness if the registry disk is unavailable */ }
    endFeed(run, 'orphaned')
    pump()
  }

  function freshRun(record) {
    return {
      run_id: record.run_id,
      crew_dir: record.crew_dir,
      task: record.task,
      brief_file: record.brief_file,
      lane: record.lane,
      suite: record.suite,
      checkout: record.checkout,
      tier_identity: record.tier_identity || null,
      task_return: record.task_return,
      child_pid: null,
      child_generation: 0,
      lifecycle: 'queued',
      orphaned: false,
      orphan_reason: null,
      child_dead: false,
      sequence: 0,
      feed: [],
      journal: { offset: 0, rest: Buffer.alloc(0) },
      crew_cache: null,
      workers: new Map(),
      review_outcomes: [],
      continuation: false,
      blocked: false,
      envelope: null,
    }
  }

  const SETTLED_LIFECYCLES = ['settled', 'orphaned']
  function isQueued(run) { return run.lifecycle === 'queued' }
  function isRunning(run) { return run.lifecycle === 'started' || run.lifecycle === 'adopted' }

  function applyRecord(record) {
    if (!isObject(record) || typeof record.run_id !== 'string') return
    let run = runs.get(record.run_id)
    if (record.kind === 'enqueued') {
      run = freshRun(record)
      runs.set(record.run_id, run)
      return
    }
    if (!run) return
    if (record.kind === 'started') { run.child_pid = record.child_pid; run.lifecycle = 'started'; return }
    if (record.kind === 'adopted') { run.lifecycle = 'adopted'; return }
    if (record.kind === 'requeued') { run.lifecycle = 'queued'; return }
    if (record.kind === 'regrant') {
      const key = record.task_key || run.tier_identity || run.crew_dir
      if (key) regranted.add(key)
      run.brief_file = record.brief_file
      run.continuation = true
      run.lifecycle = 'queued'
      run.child_pid = null
      return
    }
    if (record.kind === 'orphaned') { run.lifecycle = 'orphaned'; run.orphaned = true; run.orphan_reason = 'orphaned-on-restart'; run.child_dead = true; return }
    if (record.kind === 'settled') { run.lifecycle = 'settled'; run.outcome_status = record.outcome_status; run.outcome_source = record.outcome_source; return }
  }

  function foldRegistry() {
    runs.clear()
    regranted.clear()
    if (exists(registryPath)) {
      try {
        const text = String(read(registryPath, 'utf8'))
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try { applyRecord(JSON.parse(line)) } catch { /* a torn registry tail is inert */ }
        }
      } catch { /* a missing/unreadable registry is an empty registry */ }
    }
    folded = true
  }

  function ensureFolded() { if (!folded) foldRegistry() }

  function findRun(runId) {
    const run = runs.get(String(runId ?? ''))
    if (!run) throw runError('not-found', `unknown run ${JSON.stringify(runId)}`)
    return run
  }

  function runEnvelope(run) { return jsonAt(run.task_return, exists, read) }

  function notify(run, event) {
    for (const subscriber of [...subscribers]) {
      if (subscriber.runId !== run.run_id || subscriber.socket.destroyed) continue
      try { subscriber.socket.write(`${JSON.stringify({ id: subscriber.id, event })}\n`) }
      catch { subscribers.delete(subscriber) }
    }
  }

  // Transport-level end of stream. Deliberately NOT an event: it says the feed
  // is over, never what the run achieved — result() owns that answer.
  function endFeed(run, reason) {
    for (const subscriber of [...subscribers]) {
      if (subscriber.runId !== run.run_id || subscriber.socket.destroyed) continue
      try { subscriber.socket.write(`${JSON.stringify({ id: subscriber.id, end: { run_id: run.run_id, reason } })}\n`) }
      catch { subscribers.delete(subscriber) }
    }
  }

  function appendEvent(run, event) {
    if (!event || !EVENT_KINDS.includes(event.kind)) return null
    const stamped = { seq: ++run.sequence, at: now(), ...event }
    run.feed.push(stamped)
    if (event.kind === 'blocked') run.blocked = true
    notify(run, stamped)
    return stamped
  }

  // Read [offset, EOF) without paying for the head of the file. Returns the file's size too, because size < offset is the truncation/rotation signal.
  function readFrom(path, offset) {
    const fd = open(path, 'r')
    try {
      const size = fstat(fd).size
      if (size <= offset) return { size, bytes: Buffer.alloc(0) }
      const buf = Buffer.allocUnsafe(size - offset)
      let got = 0
      while (got < buf.length) {
        const n = readAt(fd, buf, got, buf.length - got, offset + got)
        if (!n) break
        got += n
      }
      return { size, bytes: got === buf.length ? buf : buf.subarray(0, got) }
    } finally { close(fd) }
  }

  function cursorLines(path, cursor) {
    if (!path || !exists(path)) return []
    try {
      let { size, bytes } = readFrom(path, cursor.offset)
      if (size < cursor.offset) {
        cursor.offset = 0
        cursor.rest = Buffer.alloc(0)
        const reset = readFrom(path, 0)
        size = reset.size
        bytes = reset.bytes
      }
      cursor.offset += bytes.length
      const split = splitFrames(Buffer.concat([cursor.rest || Buffer.alloc(0), bytes]))
      cursor.rest = split.rest
      return split.lines
    } catch { return [] }
  }

  function createWorker(run, row) {
    const workerId = String(row.id ?? row.worker_id ?? `${row.role || 'worker'}-${row.pid}`)
    let worker = run.workers.get(workerId)
    if (worker) return worker
    const dir = absoluteChildPath(run.crew_dir, row.dir)
    worker = {
      worker_id: workerId,
      role: row.role ?? null,
      pid: row.pid,
      dir,
      stream: dir ? join(dir, 'stream.jsonl') : null,
      exit: dir ? join(dir, 'exit') : null,
      cursor: { offset: 0, rest: Buffer.alloc(0) },
      terminal: false,
      exit_seen: false,
    }
    run.workers.set(workerId, worker)
    return worker
  }

  function rpcPid(path) {
    if (!path || !exists(path)) return null
    try {
      const value = Number(String(read(path, 'utf8')).trim())
      return hasPid(value) ? value : null
    } catch { return null }
  }

  function crewConfig(run) {
    const path = join(run.crew_dir, 'crew.json')
    let stamp = null
    try { const s = stat(path); stamp = `${s.mtimeMs}:${s.size}` } catch { return null }
    if (run.crew_cache && run.crew_cache.stamp === stamp) return run.crew_cache.value
    const value = jsonAt(path, exists, read)
    run.crew_cache = { stamp, value }
    return value
  }

  function discoverRpcWorkers(run) {
    const crew = crewConfig(run)
    for (const [role, member] of Object.entries(crew?.members || {})) {
      if (member?.transport !== 'headless-rpc' || run.workers.has(role)) continue
      const dir = join(run.crew_dir, 'task', 'headless-rpc', role)
      const pid = rpcPid(join(dir, 'pgid'))
      const evidence = pid != null || exists(join(dir, 'stream.jsonl')) || exists(join(dir, 'exit'))
      if (!evidence) continue
      createWorker(run, { id: role, role, pid, dir })
    }
  }

  function pollWorker(run, worker) {
    for (const line of cursorLines(worker.stream, worker.cursor)) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (!isObject(row)) continue
      const withRole = { ...row, ...(row.role == null && worker.role != null ? { role: worker.role } : {}) }
      const event = normalizeEvent('stream', withRole)
      if (event) {
        if (event.kind === 'terminal-result') worker.terminal = true
        appendEvent(run, event)
      }
      // A result frame can carry usage as well as the terminal marker. The
      // normalized vocabulary keeps those as two independent observations.
      if ((row.usage || row.message?.usage) && event?.kind !== 'usage') appendEvent(run, usageEvent(withRole))
    }
    if (worker.exit && exists(worker.exit) && !worker.exit_seen) {
      worker.exit_seen = true
      let exitCode = null
      try {
        const value = Number(String(read(worker.exit, 'utf8')).trim())
        exitCode = Number.isFinite(value) ? value : null
      } catch { /* exit evidence may still be arriving */ }
      appendEvent(run, normalizeEvent('worker', { event: 'exit', role: worker.role, worker_id: worker.worker_id, exit_code: exitCode, signal: null }))
    }
  }

  function pollJournal(run) {
    const path = join(run.crew_dir, 'journal.jsonl')
    for (const line of cursorLines(path, run.journal)) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (!isObject(row)) continue
      const event = normalizeEvent('journal', row)
      if (event) {
        appendEvent(run, event)
        if (event.kind === 'terminal-result' && row.rpc_outcome != null) {
          const worker = [...run.workers.values()].find((candidate) => candidate.role === row.role)
          if (worker) worker.terminal = true
        }
      }
      if (isObject(row.review_outcome)) run.review_outcomes.push(row.review_outcome)
      if (row.event === 'headless-spawn') createWorker(run, row)
    }
  }

  // A regrant that threw AFTER its fork owns a live, detached child. Sever it
  // from the run first (generation bump + cleared pid make its exit callbacks
  // no-ops), then signal it, so the restored escalation is the last word even
  // if the signal itself fails.
  function reapLaunchedContinuation(run) {
    const pid = run.child_pid
    if (!hasPid(pid)) return false
    run.child_generation += 1
    run.child_pid = null
    run.child_dead = true
    try { kill(pid, 'SIGTERM') } catch { /* an already-exited child is the outcome we wanted */ }
    try { appendEvent(run, normalizeEvent('daemon', { event: 'died', scope: 'run', exit_code: null, signal: 'SIGTERM' })) } catch { /* the feed must never re-throw inside a recovery path */ }
    return true
  }

  function regrantIfEligible(run, envelope) {
    let priorPath = null
    let priorWritten = false
    let terminalRemoved = false
    let registryRecorded = false
    try {
      if (envelope?.status !== 'escalation') return false
      pollJournal(run)
      const key = run.tier_identity || run.crew_dir
      const verdict = regrantVerdict(envelope, run.review_outcomes, { regranted: regranted.has(key) })
      if (!verdict.eligible) return false
      const briefPath = join(run.crew_dir, 'task', 'regrant-brief.md')
      const lastOutcome = run.review_outcomes.at(-1)
      write(briefPath, continuationBrief({
        findings: lastOutcome?.findings ?? [],
        guidance: envelope.details?.escalation?.why,
        branch: null,
        commit: envelope.details?.commit ?? null,
      }))
      priorPath = run.task_return?.endsWith('.json')
        ? `${run.task_return.slice(0, -'.json'.length)}.regrant-1.json`
        : `${run.task_return}.regrant-1.json`
      write(priorPath, JSON.stringify(envelope, null, 2))
      priorWritten = true
      unlink(run.task_return)
      terminalRemoved = true
      appendRecord({
        kind: 'regrant', run_id: run.run_id, at: now(), crew_dir: run.crew_dir,
        task: run.task, task_key: key, brief_file: briefPath,
        prior_envelope: envelope, eligible: true, reasons: verdict.reasons,
      })
      registryRecorded = true
      regranted.add(key)
      run.child_generation += 1
      run.brief_file = briefPath
      run.continuation = true
      run.lifecycle = 'queued'
      run.child_pid = null
      run.child_dead = false
      run.orphan_reason = null
      run.envelope = null
      run.blocked = false
      const failures = pump(run)
      const launchFailure = failures.get(run.run_id)
      if (launchFailure) throw launchFailure
      return true
    } catch {
      reapLaunchedContinuation(run)
      if (terminalRemoved) {
        try { write(run.task_return, JSON.stringify(envelope, null, 2)) } catch { /* preserve the in-memory terminal path if disk recovery also fails */ }
      }
      if (priorWritten && !registryRecorded) {
        try { unlink(priorPath) } catch { /* the original envelope is the load-bearing recovery artifact */ }
      }
      return false
    }
  }

  function settle(run, envelope) {
    if (run.lifecycle === 'settled') return
    if (regrantIfEligible(run, envelope)) return
    run.envelope = envelope
    run.lifecycle = 'settled'
    if (run.feed.length > feedRetention) run.feed.splice(0, run.feed.length - feedRetention)
    appendRecord({ kind: 'settled', run_id: run.run_id, at: now(), outcome_status: envelope.status, outcome_source: 'envelope' })
    endFeed(run, 'settled')
    pump()
  }

  function attachChild(run, child, generation) {
    const childPid = child?.pid ?? null
    const isCurrentChild = () => run.child_generation === generation && run.child_pid === childPid
    const spawnError = (err) => {
      try {
        if (!isCurrentChild() || run.lifecycle === 'orphaned' || run.lifecycle === 'settled') return
        appendEvent(run, normalizeEvent('daemon', { event: 'died', scope: 'run', exit_code: null, signal: null }))
        orphanRun(run, `child-spawn-error: ${err?.message || String(err)}`)
      } catch { /* an async child failure must never become an uncaught daemon error */ }
    }
    const exited = (code, signal) => {
      try {
        if (!isCurrentChild() || run.lifecycle === 'orphaned' || run.lifecycle === 'settled') return
        const envelope = runEnvelope(run)
        if (envelope) settle(run, envelope)
        else {
          run.child_dead = true
          run.orphan_reason ||= signal ? `child-exit:${signal}` : `child-exit:${code ?? 'unknown'}`
          appendEvent(run, normalizeEvent('daemon', { event: 'died', scope: 'run', exit_code: code ?? null, signal: signal ?? null }))
          const after = runEnvelope(run)
          if (after) settle(run, after)
          else orphanRun(run, run.orphan_reason)
        }
      } catch { /* diagnostics are subordinate to daemon liveness */ }
    }
    try {
      child?.on?.('error', spawnError)
      child?.on?.('exit', exited)
    } catch { /* a test double or exotic child handle may omit EventEmitter semantics */ }
  }

  function pollRun(run) {
    if (run.lifecycle === 'orphaned' || run.lifecycle === 'settled') return
    discoverRpcWorkers(run)
    pollJournal(run)
    for (const worker of run.workers.values()) pollWorker(run, worker)
    const before = runEnvelope(run)
    if (before) settle(run, before)
    if (run.lifecycle !== 'settled') {
      const alive = run.child_dead ? false : processAlive(kill, run.child_pid)
      if (alive === false && !run.child_dead) {
        run.child_dead = true
        run.orphan_reason ||= 'child-dead'
        appendEvent(run, normalizeEvent('daemon', { event: 'died', scope: 'run', exit_code: null, signal: null }))
      }
      const after = runEnvelope(run)
      if (after) settle(run, after)
      else if (run.child_dead) orphanRun(run, run.orphan_reason || 'child-dead')
    }
  }

  function poll() {
    ensureFolded()
    for (const run of runs.values()) pollRun(run)
    pump()
  }

  function runState(run, workerId = null) {
    if (workerId != null) {
      const key = String(workerId)
      const worker = run.workers.get(key) || [...run.workers.values()].find((candidate) => candidate.role === key)
      if (!worker) throw runError('not-found', `unknown worker ${JSON.stringify(workerId)} for run ${run.run_id}`)
      const exitSeen = !!(worker.exit && exists(worker.exit))
      const terminal = worker.terminal && exitSeen
      // Workers publish their own atomically-renamed exit marker; a PID probe
      // would invent death for a detached worker whose PID is not ours to own.
      return deriveState({ terminal, alive: exitSeen ? false : true, blocked: false })
    }
    const terminal = !!runEnvelope(run)
    const alive = isQueued(run) ? null : run.orphaned || run.child_dead || run.lifecycle === 'orphaned'
      ? false : processAlive(kill, run.child_pid)
    return deriveState({ terminal, alive, blocked: run.blocked, queued: isQueued(run) })
  }

  function state(query = {}) {
    ensureFolded()
    const run = findRun(query.run)
    pollRun(run)
    return { state: runState(run, query.worker) }
  }

  function result(query = {}) {
    ensureFolded()
    const run = findRun(query.run)
    const envelope = runEnvelope(run)
    if (envelope) return { outcome: envelope.status, envelope, source: 'envelope' }
    return { outcome: null, envelope: null, source: null, reason: run.orphan_reason || 'pending' }
  }

  function list() {
    ensureFolded()
    return [...runs.values()].map((run) => ({ run_id: run.run_id, task: run.task, crew_dir: run.crew_dir, state: runState(run) }))
  }

  function feed(runId, since = 0) {
    ensureFolded()
    const run = findRun(runId)
    const n = Number(since)
    const floor = Number.isFinite(n) ? n : 0
    return run.feed.filter((event) => event.seq > floor).map((event) => ({ ...event }))
  }

  // Boot a crew for a tier in a CHILD PROCESS: importing crew.mjs would pull
  // drive.mjs back into the server (#174/PR #191, daemon.test.mjs firewall).
  function bootTierCrew(spec) {
    const tier = String(spec.tier)
    if (typeof spec.task !== 'string' || !spec.task) throw runError('invalid-spec', 'a tier enqueue requires task')
    if (typeof spec.checkout !== 'string' || !spec.checkout) throw runError('invalid-spec', 'a tier enqueue requires checkout')
    const checkout = resolvePath(spec.checkout)
    const briefFile = spec.brief_file || spec.briefFile
    if (typeof briefFile !== 'string' || !briefFile || !exists(resolvePath(briefFile))) {
      throw runError('invalid-spec', `brief file not found: ${briefFile ? resolvePath(briefFile) : '<missing>'}`)
    }
    const argv = [CREW_PATH, 'boot', '--task', String(spec.task), '--checkout', checkout, '--tier', tier, '--headless-all']
    const result = spawnSync(process.execPath, argv, { cwd: checkout, encoding: 'utf8' })
    const stderr = String(result?.stderr || '').trim()
    if (result?.error || result?.status !== 0) {
      throw runError('boot-failed', `crew boot failed for tier "${tier}" in ${checkout} (exit ${result?.status ?? 'none'}): ${result?.error?.message || stderr || '<no stderr>'}`)
    }
    // Take the crew dir from what boot REPORTED — re-deriving it from the
    // checkout basename is the #192 defect.
    const printed = String(result?.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
    for (let i = printed.length - 1; i >= 0; i -= 1) {
      let parsed
      try { parsed = JSON.parse(printed[i]) } catch { continue }
      if (parsed && typeof parsed.crew_json === 'string' && parsed.crew_json) return resolvePath(dirname(parsed.crew_json))
    }
    throw runError('boot-failed', `crew boot for tier "${tier}" in ${checkout} reported no crew_json: ${stderr || String(result?.stdout || '').trim() || '<no output>'}`)
  }

  // crew.mjs keys persistent state by its canonical checkout basename/task slug,
  // so this identity must use the SAME rule — hence the shared leaf module
  // rather than the local copy this function used to carry. A degenerate task or
  // basename yields no identity rather than throwing: an unidentifiable request
  // falls through to the crew_dir collision check and then to boot, which fails
  // loudly on its own.
  function tierIdentity(spec) {
    if (typeof spec.task !== 'string' || !spec.task || typeof spec.checkout !== 'string' || !spec.checkout) return null
    const task = slugOrNull(spec.task)
    if (!task) return null
    const checkout = resolvePath(spec.checkout)
    return `${slugOrNull(basename(checkout)) || 'repo'}/${task}`
  }

  function activeTierRun(spec) {
    const identity = tierIdentity(spec)
    if (!identity) return null
    return [...runs.values()].find((run) => run.tier_identity === identity && !SETTLED_LIFECYCLES.includes(run.lifecycle)) || null
  }

  function canonicalCheckout(value) {
    return typeof value === 'string' && value ? resolvePath(String(value)) : null
  }

  function childSpecFor(run) {
    return {
      crew_dir: run.crew_dir, task: run.task, brief_file: run.brief_file,
      lane: run.lane, suite: run.suite, checkout: run.checkout, task_return: run.task_return,
      continuation: run.continuation === true,
      ledger_db: budgetLedgerDb, budget_enabled: budget !== null,
    }
  }

  function startRun(run, { preserveOnFailure = false } = {}) {
    if (!isQueued(run)) return null
    // An envelope here can only be one that appeared AFTER admission —
    // enqueue refuses a crew dir that already holds one — so settling on it
    // is this run's own result, never a predecessor's.
    const envelope = runEnvelope(run)
    if (envelope) {
      settle(run, envelope)
      return null
    }
    let child
    const generation = ++run.child_generation
    try {
      child = fork(CHILD_PATH, ['--run-child', JSON.stringify(childSpecFor(run))], { detached: true, stdio: 'ignore' })
      run.child_pid = child?.pid ?? null
      attachChild(run, child, generation)
      child?.unref?.()
    } catch (err) {
      if (preserveOnFailure) { run.child_pid = null; run.lifecycle = 'queued' }
      else orphanRun(run, `child-spawn-error: ${err?.message || String(err)}`)
      return err
    }
    if (!hasPid(run.child_pid)) {
      if (preserveOnFailure) { run.child_pid = null; run.lifecycle = 'queued' }
      else orphanRun(run, 'child-spawn-error: fork returned no pid')
      return runError('child-spawn-error', `fork returned no pid for run ${run.run_id}`)
    }
    run.lifecycle = 'started'
    appendRecord({ kind: 'started', run_id: run.run_id, at: now(), child_pid: run.child_pid })
    appendEvent(run, normalizeEvent('daemon', { event: 'fork', run_id: run.run_id, pid: run.child_pid }))
    return null
  }

  function runningCount() {
    let n = 0
    for (const run of runs.values()) if (isRunning(run)) n += 1
    return n
  }

  function checkoutBusy(checkout) {
    if (!checkout) return false
    for (const run of runs.values()) if (isRunning(run) && run.checkout === checkout) return true
    return false
  }

  let pumping = false
  function pump(protectedRun = null) {
    const failures = new Map()
    if (pumping) return failures
    pumping = true
    try {
      for (const run of runs.values()) {
        if (!isQueued(run)) continue
        if (runningCount() >= concurrency) break
        if (checkoutBusy(run.checkout)) continue
        const err = startRun(run, { preserveOnFailure: run === protectedRun })
        if (err) failures.set(run.run_id, err)
      }
    } finally { pumping = false }
    return failures
  }

  function budgetWindowLabel(windowMs) {
    const hours = windowMs / (60 * 60 * 1000)
    return Number.isInteger(hours) ? `${hours}h` : `${windowMs}ms`
  }

  // Recompute from the factory ledger for every admission. No counter or
  // second registry record is held in daemon state, so restart survival is
  // structural and ADR-029 §4's single run-state record remains intact.
  function assertBudget() {
    if (!budget) return
    const since = new Date(now() - budget.window_ms).toISOString()
    let usage
    try {
      usage = readUsageWindow({ dbPath: budgetLedgerDb, since, nodeVersion })
    } catch (err) {
      usage = { measured: false, total: null, sessions: 0, why: err?.message || String(err) }
    }
    if (!usage?.measured) {
      const why = String(usage?.why || 'unknown error').replace(/\s+/g, ' ')
      throw runError('budget-unmeasurable', `budget ceiling: a ceiling of ${budget.max_tokens} tokens is set but the ledger at ${budgetLedgerDb} could not be read (${why}) — refusing to admit a run whose spend cannot be measured (repair the ledger, or clear the ceiling with daemon({budget:null})).`)
    }
    if (usage.total >= budget.max_tokens) {
      const panePolicy = 'Pane-transport seats report no usage and are not counted; the daemon refuses pane transport, so no run this ceiling governs contains one.'
      throw runError('budget-exceeded', `budget ceiling: ${usage.total} tokens of measured crew spend since ${since} (${usage.sessions ?? 0} agent sessions) meets the ceiling of ${budget.max_tokens} for this ${budgetWindowLabel(budget.window_ms)} window — refusing to admit this run rather than seating it cheaper or queueing it (wait for the window to roll off, or raise/clear the ceiling with daemon({budget})). ${panePolicy}`)
    }
  }

  function enqueue(spec = {}) {
    ensureFolded()
    if (!isObject(spec)) throw runError('invalid-spec', 'enqueue requires a spec object')
    const hasDir = typeof spec.crew_dir === 'string' && !!spec.crew_dir
    const hasTier = typeof spec.tier === 'string' && !!spec.tier
    if (hasDir && hasTier) throw runError('invalid-spec', 'enqueue takes crew_dir or tier, never both')
    if (!hasDir && !hasTier) throw runError('invalid-spec', 'enqueue requires crew_dir or tier')
    assertBudget()
    if (hasTier) {
      const active = activeTierRun(spec)
      if (active) throw runError('run-active', `run ${active.run_id} is already active for ${active.crew_dir}`)
    }
    const crewDir = hasDir ? resolvePath(spec.crew_dir) : bootTierCrew(spec)
    let crew
    try { crew = JSON.parse(String(read(join(crewDir, 'crew.json'), 'utf8'))) } catch (err) { throw runError('invalid-spec', `cannot read crew.json at ${join(crewDir, 'crew.json')}: ${err.message}`) }
    const pane = paneSeat(crew)
    if (pane) throw runError('invalid-spec', `daemon run refuses pane transport for seat ${pane}`)
    const active = [...runs.values()].find((run) => run.crew_dir === crewDir && !SETTLED_LIFECYCLES.includes(run.lifecycle))
    if (active) throw runError('run-active', `run ${active.run_id} is already active for ${crewDir}`)
    const runId = String(spec.run_id || uuid())
    if (runs.has(runId)) throw runError('run-active', `run ${runId} already exists`)
    const taskReturn = absoluteChildPath(crewDir, spec.task_return || crew.task_return || join('returns', 'task.json'))
    // task_return is per CREW DIR, so run identity and envelope identity are
    // the same thing (child.mjs:54/92 resolves the same path from the same
    // dir). A crew dir whose envelope is already the record cannot host a
    // second run: honouring the envelope never starts the new run, and
    // starting it overwrites the old one. Refuse the request like boot-failed;
    // the envelope is never deleted, moved or ignored.
    const settled = jsonAt(taskReturn, exists, read)
    if (settled) {
      throw runError('crew-settled', `crew dir ${crewDir} already holds a terminal envelope`
        + ` (status ${JSON.stringify(settled.status ?? null)}) at ${taskReturn}`
        + ' — a settled crew dir is re-BOOTED, not re-enqueued: boot a fresh crew'
        + ' (factoryctl run --tier …) and enqueue that')
    }
    const identity = hasTier ? tierIdentity(spec) : null
    const record = {
      kind: 'enqueued', run_id: runId, at: now(), crew_dir: crewDir,
      task: spec.task || crew.task || null, brief_file: spec.brief_file || spec.briefFile || null,
      lane: spec.lane || null, suite: spec.suite || 'node --test', checkout: canonicalCheckout(spec.checkout || crew.checkout),
      ...(identity ? { tier_identity: identity } : {}),
      task_return: taskReturn,
    }
    appendRecord(record)
    const run = freshRun(record)
    runs.set(runId, run)
    const failure = pump().get(runId)
    if (failure) throw failure
    return { run_id: runId, crew_dir: crewDir, state: runState(run) }
  }

  async function send(params = {}) {
    ensureFolded()
    if (!isObject(params)) throw runError('invalid-params', 'send requires params to be an object')
    const run = findRun(params.run)
    pollRun(run)
    if (isQueued(run)) throw runError('not-live', `run ${run.run_id} is queued and has no workers yet`)
    if (typeof params.message !== 'string' || params.message.length === 0) throw runError('invalid-params', 'send requires a non-empty message')
    if (SETTLED_LIFECYCLES.includes(run.lifecycle) || run.child_dead) {
      throw runError('not-live', `run ${run.run_id} has settled — send reaches live workers only; the envelope is the record`)
    }
    const crew = crewConfig(run)
    if (!crew || !isObject(crew.members)) throw runError('invalid-spec', `cannot read crew.json at ${join(run.crew_dir, 'crew.json')}`)
    const members = crew.members
    const roles = Object.keys(members)
    let role
    let member
    let caps
    if (params.role !== undefined) {
      role = params.role
      if (!Object.prototype.hasOwnProperty.call(members, role)) {
        throw runError('not-found', `unknown role ${JSON.stringify(role)} for run ${run.run_id} (seated roles: ${roles.join(', ')})`)
      }
      member = members[role]
      caps = await capabilityProfile(member?.agent, member?.transport)
    } else {
      const profiles = []
      for (const candidateRole of roles) {
        const candidate = members[candidateRole]
        try {
          profiles.push({ role: candidateRole, member: candidate, caps: await capabilityProfile(candidate?.agent, candidate?.transport) })
        } catch (error) {
          profiles.push({ role: candidateRole, member: candidate, caps: null, error })
        }
      }
      const steerable = profiles.filter((candidate) => candidate.caps?.interjection === SEND_INTERJECTION)
      if (steerable.length === 1) {
        ({ role, member, caps } = steerable[0])
      } else if (steerable.length > 1) {
        throw runError('invalid-params', `multiple steerable seats for run ${run.run_id}: ${steerable.map((candidate) => candidate.role).join(', ')} — specify --role`)
      } else {
        const listing = profiles.map((candidate) => {
          const transport = JSON.stringify(candidate.member?.transport)
          const interjection = JSON.stringify(candidate.caps?.interjection ?? 'unavailable')
          return `${candidate.role}: transport ${transport}, interjection ${interjection}`
        }).join('; ')
        throw runError('not-capable', `no seat for run ${run.run_id} declares interjection "${SEND_INTERJECTION}"; ${listing}`)
      }
    }
    if (caps.interjection !== SEND_INTERJECTION) {
      throw runError('not-capable', `seat ${role} of run ${run.run_id} declares interjection ${JSON.stringify(caps.interjection)} on transport ${JSON.stringify(member.transport)}; send requires interjection "${SEND_INTERJECTION}" — refusing rather than queueing`)
    }
    if (member.transport !== 'headless-rpc') {
      throw runError('not-capable', `no command channel is implemented for transport ${JSON.stringify(member.transport)}`)
    }
    const fifo = seatCommandPath(join(run.crew_dir, 'task'), role)
    const seatDir = dirname(fifo)
    if (exists(join(seatDir, 'exit'))) throw runError('not-live', `seat ${role} has exited`)
    const workerPid = rpcPid(join(seatDir, 'pgid'))
    if (workerPid == null || processAlive(kill, workerPid) === false) throw runError('not-live', `seat ${role} has no running worker`)
    if (!exists(fifo)) throw runError('not-live', `seat ${role} has no command channel`)
    const id = `send-${uuid()}`
    const line = `${JSON.stringify({ ...steerFrame(params.message), id })}\n`
    const size = Buffer.byteLength(line, 'utf8')
    if (size > MAX_SEND_BYTES) throw runError('invalid-params', `send frame exceeds ${MAX_SEND_BYTES} bytes (actual ${size})`)
    try {
      const fd = open(fifo, 'r+')
      try { writeAt(fd, line) } finally { close(fd) }
    } catch (error) {
      throw runError('not-live', `cannot write to the seat command channel: ${error?.message || String(error)}`)
    }
    appendRecord({ kind: 'sent', run_id: run.run_id, at: now(), role, command_id: id })
    return { delivered: 'command-channel', run_id: run.run_id, role, transport: member.transport, interjection: SEND_INTERJECTION, command_id: id }
  }

  function adoptOrOrphan() {
    for (const run of runs.values()) {
      if (SETTLED_LIFECYCLES.includes(run.lifecycle)) continue
      if (isQueued(run)) {
        appendRecord({ kind: 'requeued', run_id: run.run_id, at: now() })
        continue
      }
      if (!hasPid(run.child_pid)) {
        const envelope = runEnvelope(run)
        if (envelope) settle(run, envelope)
        else orphanRun(run, 'orphaned-on-restart')
        continue
      }
      const alive = processAlive(kill, run.child_pid)
      if (alive === true || alive === null) {
        run.lifecycle = 'adopted'
        appendRecord({ kind: 'adopted', run_id: run.run_id, at: now() })
        continue
      }
      const envelope = runEnvelope(run)
      if (envelope) settle(run, envelope)
      else orphanRun(run, 'orphaned-on-restart')
    }
  }

  function activeMessage(holder) { return `daemon already running (pid ${holder}) on ${socketPath}` }

  async function probeSocket() {
    return await new Promise((resolve) => {
      let finished = false
      let timer = null
      let socket = null
      const finish = (value) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        try { socket?.destroy?.() } catch {}
        resolve(value)
      }
      try {
        socket = net.connect(socketPath)
        timer = setTimeout(() => finish(false), 150)
        socket.on('error', () => finish(false))
        socket.on('close', () => finish(false))
        socket.on('data', (chunk) => {
          const split = splitFrames(chunk)
          if (split.lines.length > 0) finish(true)
        })
        socket.on('connect', () => {
          try { socket.write(`${JSON.stringify({ id: '__daemon_probe__', cmd: 'ping' })}\n`) }
          catch { finish(false) }
        })
      } catch { finish(false) }
    })
  }

  function closeServer(value) {
    if (!value?.close) return Promise.resolve()
    return new Promise((resolve) => {
      try { value.close(() => resolve()) } catch { resolve() }
    })
  }

  function listen(value) {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (err) => { if (!settled) { settled = true; reject(err) } }
      const done = () => { if (!settled) { settled = true; resolve(value) } }
      try {
        value.on?.('error', fail)
        value.listen(socketPath, done)
      } catch (err) { fail(err) }
    })
  }

  async function bind(holderHint = null) {
    let retried = false
    for (;;) {
      const candidate = net.createServer((socket) => attach(socket))
      try { return await listen(candidate) }
      catch (err) {
        await closeServer(candidate)
        if (err?.code !== 'EADDRINUSE' || retried) throw err
        retried = true
        const live = await probeSocket()
        if (live) {
          let holder = holderHint || 'unknown'
          try { holder = JSON.parse(String(read(pidPath, 'utf8'))).pid || holder } catch {}
          throw runError('daemon-active', activeMessage(holder))
        }
        try { unlink(socketPath) } catch {}
      }
    }
  }

  function writeFrame(socket, value) {
    if (!socket || socket.destroyed || socket.writableEnded) return
    try { socket.write(`${JSON.stringify(value)}\n`) } catch { connections.delete(socket) }
  }

  function errorFrame(id, code, message, command) {
    return { id, ok: false, error: { code, message, ...(command == null ? {} : { command }) } }
  }

  function removeSubscriber(socket, id = null, runId = null) {
    let removed = 0
    for (const subscriber of [...subscribers]) {
      if (subscriber.socket !== socket) continue
      if (id != null && subscriber.id !== id) continue
      if (runId != null && subscriber.runId !== String(runId)) continue
      subscribers.delete(subscriber); removed += 1
    }
    return removed
  }

  function tail(socket, id, params) {
    const runId = String(params.run)
    const since = Number.isFinite(Number(params.since)) ? Number(params.since) : 0
    const run = findRun(runId)
    removeSubscriber(socket, id, runId)
    pollRun(run)
    for (const event of feed(runId, since)) writeFrame(socket, { id, event })
    subscribers.add({ socket, id, runId })
    writeFrame(socket, { id, ok: true, result: { tailing: true } })
  }

  async function dispatch(socket, request) {
    const { id, cmd, params = {} } = request
    if (!isObject(params)) throw runError('invalid-params', 'params must be an object')
    if (cmd === 'ping') return { pid, socket: socketPath }
    if (cmd === 'enqueue') return enqueue(params)
    if (cmd === 'send') return await send(params)
    if (cmd === 'list') return list()
    if (cmd === 'state') return state(params)
    if (cmd === 'result') return result(params)
    if (cmd === 'tail') { tail(socket, id, params); return null }
    if (cmd === 'untail') {
      const removed = removeSubscriber(socket, params.id ?? (params.run == null ? id : null), params.run ?? null)
      return { removed: removed > 0 }
    }
    if (cmd === 'stop') {
      writeFrame(socket, { id, ok: true, result: { stopped: true } })
      await stop(socket)
      return null
    }
    throw runError('unknown-command', `unknown daemon command ${JSON.stringify(cmd)}`)
  }

  function request(socket, line) {
    let parsed
    try { parsed = JSON.parse(line) } catch { writeFrame(socket, errorFrame(null, 'parse', 'malformed JSON request')); return }
    const usableId = isObject(parsed) && typeof parsed.id === 'string' ? parsed.id : null
    if (!isObject(parsed) || typeof parsed.id !== 'string' || typeof parsed.cmd !== 'string') {
      writeFrame(socket, errorFrame(usableId, 'parse', 'request must contain string id and cmd'))
      return
    }
    if (!DAEMON_COMMANDS.includes(parsed.cmd)) {
      writeFrame(socket, errorFrame(parsed.id, 'unknown-command', `unknown daemon command ${JSON.stringify(parsed.cmd)}`, parsed.cmd))
      return
    }
    Promise.resolve().then(() => dispatch(socket, parsed)).then((result) => {
      if (parsed.cmd === 'tail' || result === null) return
      writeFrame(socket, { id: parsed.id, ok: true, result })
    }).catch((err) => {
      const code = err?.code || 'error'
      writeFrame(socket, errorFrame(parsed.id, code, err?.message || String(err), code === 'unknown-command' ? parsed.cmd : undefined))
    })
  }

  function attach(socket) {
    connections.add(socket)
    const splitter = splitStream()
    socket.on?.('data', (chunk) => {
      let lines
      try { lines = splitter.push(chunk) }
      catch (err) {
        writeFrame(socket, errorFrame(null, 'parse', err.message))
        try { socket.destroy?.() } catch {}
        return
      }
      for (const line of lines) request(socket, line)
    })
    socket.on?.('close', () => { connections.delete(socket); removeSubscriber(socket) })
    socket.on?.('error', () => { connections.delete(socket); removeSubscriber(socket) })
  }

  async function start() {
    if (started) throw runError('daemon-active', activeMessage(pid))
    mkdir(root, { recursive: true })
    folded = false
    foldRegistry()
    let holder = null
    if (exists(pidPath)) {
      try { holder = JSON.parse(String(read(pidPath, 'utf8'))) } catch { holder = null }
      const holderPid = Number(holder?.pid)
      if (holder && Number.isFinite(holderPid) && holderPid > 0 && processAlive(kill, holderPid) !== false) throw runError('daemon-active', activeMessage(holder.pid))
      try { unlink(pidPath) } catch {}
    }
    if (Buffer.byteLength(socketPath, 'utf8') >= 104) throw new Error(`daemon socket path exceeds POSIX sun_path limit: ${socketPath}`)
    server = await bind(holder?.pid || null)
    try {
      const startedAt = now()
      let startedText
      try { startedText = new Date(startedAt).toISOString() } catch { startedText = String(startedAt) }
      write(pidPath, JSON.stringify({ pid, socket: socketPath, started_at: startedText }, null, 2))
    } catch (err) {
      await closeServer(server); server = null
      try { unlink(socketPath) } catch {}
      throw err
    }
    started = true
    ownsFiles = true
    adoptOrOrphan()
    pump()
    interval = setEvery(() => poll(), pollMs)
    intervalSet = true
    return { pid, socket: socketPath }
  }

  async function stop(keepSocket = null) {
    if (!started && !ownsFiles && !server) return
    if (intervalSet) { clearEvery(interval); interval = null; intervalSet = false }
    for (const socket of [...connections]) {
      if (socket === keepSocket) { try { socket.end?.() } catch {} }
      else { try { socket.destroy?.() } catch {} }
    }
    subscribers.clear()
    const value = server
    server = null
    started = false
    if (value) await closeServer(value)
    if (ownsFiles) {
      try { unlink(socketPath) } catch {}
      try { unlink(pidPath) } catch {}
      ownsFiles = false
    }
  }

  return { start, stop, poll, enqueue, send, state, result, list, feed, subscribers: () => [...subscribers].map(({ id, runId }) => ({ id, run_id: runId })), socketPath, root }
}
