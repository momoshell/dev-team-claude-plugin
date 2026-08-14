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
  readSync as fsReadSync,
  fstatSync as fsFstatSync,
  closeSync as fsCloseSync,
  statSync as fsStatSync,
} from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fork as cpFork, execSync as cpExecSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { splitFrames } from './headless-rpc.mjs'
import { driveTask as defaultDriveTask } from './drive.mjs'
import { realIo as defaultRealIo, DEFAULT_TRANSPORT } from './realio.mjs'

const MAX_FRAME_BYTES = 1024 * 1024
const SELF_PATH = decodeURIComponent(new URL(import.meta.url).pathname)

export const RUN_STATES = Object.freeze(['working', 'blocked', 'done', 'dead'])
export const EVENT_KINDS = Object.freeze(['started', 'tool-call', 'blocked', 'terminal-result', 'died', 'usage'])
export const DAEMON_COMMANDS = Object.freeze(['ping', 'enqueue', 'list', 'state', 'result', 'tail', 'untail', 'stop'])
// Keep a tail for post-settle clients; ADR-029 already makes the projection lossy, so bound rather than drop.
export const SETTLED_FEED_RETENTION = 50

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

export function deriveState({ terminal, alive, blocked }) {
  if (terminal) return 'done'
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

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value) }

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

// A pane seat needs a human at a terminal; nothing the daemon forks has one.
function paneSeat(crew) {
  const roles = crew?.roles || Object.keys(crew?.members || {})
  for (const role of roles) {
    const member = crew?.members?.[role]
    if (!member || !member.transport || member.transport === DEFAULT_TRANSPORT) return role
  }
  return null
}

export function daemon(options = {}) {
  const root = resolvePath(options.root || join(homedir(), '.crew', 'daemon'))
  const socketPath = join(root, 'daemon.sock')
  const pidPath = join(root, 'daemon.json')
  const registryPath = join(root, 'runs.jsonl')
  const injected = options.deps || {}
  const net = injected.net || netDefault
  const fork = injected.fork || cpFork
  const kill = injected.kill || ((pid, signal) => process.kill(pid, signal))
  const now = injected.now || (() => Date.now())
  const uuid = injected.uuid || randomUUID
  const pid = injected.pid ?? process.pid
  const exists = injected.existsSync || fsExistsSync
  const read = injected.readFileSync || fsReadFileSync
  const write = injected.writeFileSync || fsWriteFileSync
  const append = injected.appendFileSync || fsAppendFileSync
  const mkdir = injected.mkdirSync || fsMkdirSync
  const unlink = injected.unlinkSync || fsUnlinkSync
  const open = injected.openSync || fsOpenSync
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

  function runError(code, message) { const err = new Error(message); err.code = code; return err }

  function appendRecord(record) {
    mkdir(root, { recursive: true })
    append(registryPath, `${JSON.stringify(record)}\n`, { flag: 'a' })
  }

  function orphanRun(run, reason = 'orphaned-on-restart') {
    if (run.lifecycle === 'orphaned' || run.lifecycle === 'settled') return
    run.lifecycle = 'orphaned'; run.orphaned = true; run.child_dead = true; run.orphan_reason = reason
    try { appendRecord({ kind: 'orphaned', run_id: run.run_id, at: now() }) } catch { /* preserve daemon liveness if the registry disk is unavailable */ }
    endFeed(run, 'orphaned')
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
      task_return: record.task_return,
      child_pid: null,
      lifecycle: 'enqueued',
      orphaned: false,
      orphan_reason: null,
      child_dead: false,
      sequence: 0,
      feed: [],
      journal: { offset: 0, rest: Buffer.alloc(0) },
      crew_cache: null,
      workers: new Map(),
      blocked: false,
      envelope: null,
    }
  }

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
    if (record.kind === 'orphaned') { run.lifecycle = 'orphaned'; run.orphaned = true; run.orphan_reason = 'orphaned-on-restart'; run.child_dead = true; return }
    if (record.kind === 'settled') { run.lifecycle = 'settled'; run.outcome_status = record.outcome_status; run.outcome_source = record.outcome_source; return }
  }

  function foldRegistry() {
    runs.clear()
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
      if (row.event === 'headless-spawn') createWorker(run, row)
    }
  }

  function settle(run, envelope) {
    if (run.lifecycle === 'settled') return
    run.envelope = envelope
    run.lifecycle = 'settled'
    if (run.feed.length > feedRetention) run.feed.splice(0, run.feed.length - feedRetention)
    appendRecord({ kind: 'settled', run_id: run.run_id, at: now(), outcome_status: envelope.status, outcome_source: 'envelope' })
    endFeed(run, 'settled')
  }

  function attachChild(run, child) {
    const spawnError = (err) => {
      try {
        if (run.lifecycle === 'orphaned' || run.lifecycle === 'settled') return
        appendEvent(run, normalizeEvent('daemon', { event: 'died', scope: 'run', exit_code: null, signal: null }))
        orphanRun(run, `child-spawn-error: ${err?.message || String(err)}`)
      } catch { /* an async child failure must never become an uncaught daemon error */ }
    }
    const exited = (code, signal) => {
      try {
        if (run.lifecycle === 'orphaned' || run.lifecycle === 'settled') return
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
    const alive = run.orphaned || run.child_dead || run.lifecycle === 'orphaned'
      ? false : processAlive(kill, run.child_pid)
    return deriveState({ terminal, alive, blocked: run.blocked })
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

  function enqueue(spec = {}) {
    ensureFolded()
    if (!isObject(spec) || typeof spec.crew_dir !== 'string' || !spec.crew_dir) throw runError('invalid-spec', 'enqueue requires crew_dir')
    const crewDir = resolvePath(spec.crew_dir)
    let crew
    try { crew = JSON.parse(String(read(join(crewDir, 'crew.json'), 'utf8'))) } catch (err) { throw runError('invalid-spec', `cannot read crew.json at ${join(crewDir, 'crew.json')}: ${err.message}`) }
    const pane = paneSeat(crew)
    if (pane) throw runError('invalid-spec', `daemon run refuses pane transport for seat ${pane}`)
    const active = [...runs.values()].find((run) => run.crew_dir === crewDir && !['settled', 'orphaned'].includes(run.lifecycle))
    if (active) throw runError('run-active', `run ${active.run_id} is already active for ${crewDir}`)
    const runId = String(spec.run_id || uuid())
    if (runs.has(runId)) throw runError('run-active', `run ${runId} already exists`)
    const taskReturn = absoluteChildPath(crewDir, spec.task_return || crew.task_return || join('returns', 'task.json'))
    const record = {
      kind: 'enqueued', run_id: runId, at: now(), crew_dir: crewDir,
      task: spec.task || crew.task || null, brief_file: spec.brief_file || spec.briefFile || null,
      lane: spec.lane || null, suite: spec.suite || 'node --test', checkout: spec.checkout || crew.checkout || null,
      task_return: taskReturn,
    }
    appendRecord(record)
    const run = freshRun(record)
    runs.set(runId, run)
    const childSpec = { ...spec, crew_dir: crewDir, task: record.task, brief_file: record.brief_file, lane: record.lane, suite: record.suite, checkout: record.checkout, task_return: taskReturn }
    let child
    try {
      child = fork(SELF_PATH, ['--run-child', JSON.stringify(childSpec)], { detached: true, stdio: 'ignore' })
      run.child_pid = child?.pid ?? null
      attachChild(run, child)
      child?.unref?.()
    } catch (err) {
      orphanRun(run, `child-spawn-error: ${err?.message || String(err)}`)
      throw err
    }
    if (!hasPid(run.child_pid)) {
      orphanRun(run, 'child-spawn-error: fork returned no pid')
      throw runError('child-spawn-error', `fork returned no pid for run ${runId}`)
    }
    run.lifecycle = 'started'
    appendRecord({ kind: 'started', run_id: runId, at: now(), child_pid: run.child_pid })
    appendEvent(run, normalizeEvent('daemon', { event: 'fork', run_id: runId, pid: run.child_pid }))
    return { run_id: runId }
  }

  function adoptOrOrphan() {
    for (const run of runs.values()) {
      if (['settled', 'orphaned'].includes(run.lifecycle)) continue
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

  return { start, stop, poll, enqueue, state, result, list, feed, subscribers: () => [...subscribers].map(({ id, runId }) => ({ id, run_id: runId })), socketPath, root }
}

function childArguments(argv) {
  if (isObject(argv) && !Array.isArray(argv)) return argv
  const values = Array.isArray(argv) ? argv : process.argv.slice(2)
  const index = values.indexOf('--run-child')
  const raw = index >= 0 ? values[index + 1] : values[0]
  if (!raw) throw new Error('run child requires a JSON run specification')
  try { return JSON.parse(raw) }
  catch (err) { throw new Error(`invalid run-child specification: ${err.message}`) }
}

export function runChild(argv, injected = {}) {
  const spec = childArguments(argv)
  const read = injected.readFileSync || fsReadFileSync
  const write = injected.writeFileSync || fsWriteFileSync
  const existsChild = injected.existsSync || fsExistsSync
  const mkdir = injected.mkdirSync || fsMkdirSync
  const exec = injected.execSync || cpExecSync
  // `harness` decides how a preflight failure is REPORTED — rethrown for a
  // test driving runChild directly, or written as an escalation envelope in
  // production. It deliberately no longer decides WHETHER preflight runs.
  const harness = !!(injected.driveTask || injected.realIo)
  // Preflight runs UNLESS a caller opts out explicitly. Deriving this from
  // `harness` meant "I supplied a fake io" silently also meant "skip the seat,
  // brief, checkout-identity and dirty-tree guards" — and DI is the crew's
  // universal seam. Only tests inject today, so nothing shipped weaker; the
  // switch was wrong-way-round for the first caller who injects in production.
  const strictPreflight = injected.preflight !== false
  const crewDir = resolvePath(spec.crew_dir)
  const crewPath = join(crewDir, 'crew.json')
  let crew
  try { crew = JSON.parse(String(read(crewPath, 'utf8'))) } catch (err) { throw new Error(`cannot read crew.json at ${crewPath}: ${err.message}`) }
  const roles = crew.roles || Object.keys(crew.members || {})
  const taskDir = join(crewDir, 'task')
  const returnsDir = join(crewDir, 'returns')
  const taskReturn = resolvePath(crewDir, spec.task_return || crew.task_return || join('returns', 'task.json'))
  const checkout = resolvePath(spec.checkout || crew.checkout || process.cwd())
  const briefFile = spec.brief_file || spec.briefFile
  const ctx = {
    task: spec.task || crew.task, briefFile: briefFile ? resolvePath(briefFile) : null,
    taskDir, checkout, journal: join(crewDir, 'journal.jsonl'),
    roles: roles.filter((role) => role !== 'lead'), lane: spec.lane || null, suite: spec.suite || 'node --test',
  }
  const failure = (err) => ({
    status: 'escalation', summary: `Task ${ctx.task} needs a human: the driver crashed (${err.message})`,
    artifacts: [ctx.journal], details: { stages: null, commit: null, dissents: [], escalation: { where: err.stage || 'child-preflight', why: err.message } },
  })
  let result
  try {
    const pane = paneSeat(crew)
    if (pane) throw new Error(`daemon run refuses pane transport for seat ${pane}`)
    if (strictPreflight) {
      for (const role of ['planner', 'builder', 'reviewer']) if (!crew.members?.[role]) throw new Error(`v3 run requires a ${role} seat (booted roles: ${roles.join(', ')})`)
      if (roles.includes('lead') && !crew.members?.lead) throw new Error(`v3 run requires a lead seat (booted roles: ${roles.join(', ')})`)
      if (!briefFile) throw new Error('run requires --brief-file <path to the task brief>')
      if (!existsChild(ctx.briefFile)) throw new Error(`brief file not found: ${ctx.briefFile}`)
      if (crew.checkout && resolvePath(crew.checkout) !== checkout) throw new Error(`this crew was booted for ${resolvePath(crew.checkout)}, not ${checkout} — same directory name, different checkout`)
      const dirty = String(exec('git status --porcelain', { cwd: checkout, encoding: 'utf8' }) || '').trim()
      if (dirty) throw new Error(`checkout is dirty — commit or stash before a crew run:\n${dirty.split('\n').slice(0, 10).join('\n')}`)
    }
    mkdir(taskDir, { recursive: true }); mkdir(returnsDir, { recursive: true })
    const realIo = injected.realIo || defaultRealIo
    const driveTask = injected.driveTask || defaultDriveTask
    const noCmux = injected.realIoDeps || {
      cmux: () => ({ ok: true }), tree: () => ({ windows: [] }), locate: () => null,
      sendLine: () => {}, closeSurface: () => {},
    }
    const io = realIo(crew, { dir: crewDir, taskDir, returnsDir }, checkout, null, injected.adapters || null, spec, noCmux)
    try { result = driveTask(ctx, io) } catch (err) { result = failure(err) }
  } catch (err) {
    if (harness) throw err
    result = failure(err)
  }
  write(taskReturn, JSON.stringify(result, null, 2))
  return result
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(SELF_PATH)
if (invokedDirectly && process.argv.includes('--run-child')) {
  try { runChild(process.argv.slice(2)) }
  catch (err) { process.stderr.write(`error: ${err.message}\n`); process.exitCode = 1 }
}
