// Synchronous headless-json transport. A detached shell records the worker's
// output and exit status on disk so driveTask can poll without an event loop.
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  unlinkSync as fsUnlinkSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn as cpSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { assignmentLine } from './driver.mjs'
import { headlessCommand as defaultHeadlessCommand } from './adapters/adapter-claude.mjs'
import { reclaimStore, PHASES, VERDICTS, EVIDENCE_KINDS, LIVENESS } from './reclaim.mjs'

export const WAIT_POLL_MS = 5000
const KILL_GRACE_MS = 10_000

// Quote one shell argument. The returned token is safe to interpolate into
// the detached /bin/sh -c wrapper, while the worker itself receives argv.
export function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

// The envelope is the record of a turn. Stream and exit evidence are useful
// diagnostics, but can never replace a missing ReturnEnvelope.
export function classifyRun({ exitCode, signal, terminal, sawJson, envelope, timedOut }) {
  if (envelope) return (exitCode === 0 && terminal) ? 'ok' : 'ok-degraded'
  if (timedOut) return 'timeout'
  if (!sawJson) return 'malformed'
  if (!terminal) return 'aborted'
  return 'no-envelope'
}

function defaultSleep(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function usageInt(n) {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

function usageObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function mapClaudeUsage(usage) {
  return {
    billed_input_tokens: usageInt(usage.input_tokens),
    billed_output_tokens: usageInt(usage.output_tokens),
    billed_cache_write_tokens: usageInt(usage.cache_creation_input_tokens),
    billed_cache_read_tokens: usageInt(usage.cache_read_input_tokens),
  }
}

// Inline prior art from readUsage: result.usage is the run aggregate, while
// assistant usage is a repeated per-message delta; summing both double-counts.
// Without a result, dedupe assistant message ids last-occurrence-wins, then sum.
export function foldUsage(text) {
  const messages = new Map()
  let resultUsage = null
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const result = usageObject(event?.type === 'result' ? event.usage : null)
    if (result) resultUsage = result
    const message = event?.type === 'assistant' ? event.message : null
    const usage = usageObject(message?.usage)
    if (message?.id != null && usage) messages.set(message.id, usage)
  }
  if (resultUsage) return mapClaudeUsage(resultUsage)
  if (!messages.size) return null
  const total = { billed_input_tokens: 0, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 }
  for (const usage of messages.values()) {
    const mapped = mapClaudeUsage(usage)
    total.billed_input_tokens += mapped.billed_input_tokens
    total.billed_output_tokens += mapped.billed_output_tokens
    total.billed_cache_write_tokens += mapped.billed_cache_write_tokens
    total.billed_cache_read_tokens += mapped.billed_cache_read_tokens
  }
  return total
}

function parseStream(path, readFileSync, existsSync) {
  if (!existsSync(path)) return { sawJson: false, terminal: false, terminalReason: null, lines: 0, usage: null }
  let text
  try { text = readFileSync(path, 'utf8') } catch { return { sawJson: false, terminal: false, terminalReason: null, lines: 0, usage: null } }
  let sawJson = false
  let terminal = false
  let terminalReason = null
  let lines = 0
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    lines += 1
    try {
      const event = JSON.parse(line)
      sawJson = true
      if (event?.type === 'result') {
        terminal = true
        terminalReason = event.terminal_reason || event.subtype || null
      }
    } catch { /* truncated trailing JSONL is not itself a malformed run */ }
  }
  return { sawJson, terminal, terminalReason, lines, usage: foldUsage(text) }
}

function parseExit(path, readFileSync, existsSync) {
  if (!existsSync(path)) return null
  try {
    const n = Number(String(readFileSync(path, 'utf8')).trim())
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

function envelopeAt(path, existsSync, readFileSync) {
  if (!existsSync(path)) return null
  try {
    const env = JSON.parse(readFileSync(path, 'utf8'))
    return env && typeof env === 'object' ? env : null
  } catch { return null }
}

function adapterFor(adapters, role) {
  const entry = adapters?.[role]
  return entry?.adapter || entry || null
}

function workerCommand(adapter, spec) {
  const fn = adapter?.headlessCommand || defaultHeadlessCommand
  return fn.call(adapter, spec)
}

function persistCrew(crew, paths, writeFileSync) {
  // Session ids are useful after a supervisor restart. Test doubles commonly
  // omit a real crew.json, so persistence is best-effort and never load-bearing.
  const file = paths?.dir && join(paths.dir, 'crew.json')
  if (!file) return
  try {
    if (fsExistsSync(file)) writeFileSync(file, JSON.stringify(crew, null, 2))
  } catch { /* the in-memory member remains authoritative for this process */ }
}

export function headlessIo({ crew, paths, taskDir, checkout, adapters, bin, deps = {} }) {
  const spawn = deps.spawn || cpSpawn
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || defaultSleep
  const exists = deps.existsSync || fsExistsSync
  const read = deps.readFileSync || fsReadFileSync
  const unlink = deps.unlinkSync || fsUnlinkSync
  const mkdir = deps.mkdirSync || fsMkdirSync
  const readdir = deps.readdirSync || fsReaddirSync
  const write = deps.writeFileSync || fsWriteFileSync
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal))
  const uuid = deps.uuid || randomUUID
  const pid = deps.pid ?? process.pid
  const root = join(taskDir || paths.taskDir, 'headless')
  const store = reclaimStore({ dir: root, actor: `headless:${pid}`, deps })
  const runs = new Map()

  function activePath(role) { return join(root, `.${role}.active.json`) }
  function readState(path) {
    if (!exists(path)) return null
    try { return JSON.parse(read(path, 'utf8')) } catch { return null }
  }
  function activeRun(role) { return readState(activePath(role)) }
  function readEnvelope(returnPath) { return envelopeAt(returnPath, exists, read) }
  function allocateRun() {
    mkdir(root, { recursive: true })
    let n = 0
    try {
      for (const name of readdir(root)) {
        const match = /^d(\d+)$/.exec(name)
        if (match) n = Math.max(n, Number(match[1]))
      }
    } catch { /* root was just created */ }
    for (;;) {
      n += 1
      const dir = join(root, `d${n}`)
      try { mkdir(dir) ; return { id: `d${n}`, dir } }
      catch (err) { if (err?.code === 'EEXIST') continue; throw err }
    }
  }
  const injectedLog = deps.log
  const emit = deps.emit
  function emitUsage(run, usage) {
    try {
      emit?.({ kind: 'usage', id: run.id, role: run.role, model: run.model ?? null, session_id: run.sessionId ?? null, transcript_path: run.stream || null, usage })
    } catch { /* ADR-026: instrumentation is never load-bearing */ }
  }
  function log(obj) {
    if (injectedLog) return injectedLog(obj)
    try { write(join(paths.dir, 'journal.jsonl'), `${JSON.stringify(obj)}\n`, { flag: 'a' }) } catch { /* diagnostics only */ }
  }
  function recordOutcome(run, outcome, stream, exitCode, signal = null) {
    log({ at: now(), headless_outcome: outcome, exit_code: exitCode, signal, terminal_reason: stream.terminalReason, lines: stream.lines, stream: run.stream, ...(outcome === 'ok-degraded' ? { mismatch: 'envelope arrived but exit/terminal evidence was not a clean match' } : {}) })
  }
  function outcomeError(run, outcome, message) {
    const err = new Error(message || `headless ${outcome}: seat ${run.role} produced no valid envelope at ${run.returnPath}`)
    err.stage = `headless-${outcome}`; err.role = run.role; return err
  }
  function busy(role, sessionId) {
    const err = new Error(`headless: seat ${role} already has a live invocation against session ${sessionId} — refusing a concurrent turn (ADR-029 §5 c3)`)
    err.stage = 'headless-session-busy'; err.role = role; return err
  }
  function unresolvable(role, sessionId) {
    const err = new Error(`headless: seat ${role} has an unresolvable reservation for session ${sessionId} at ${activePath(role)} — use override to recover it`)
    err.stage = 'headless-unresolvable-reservation'; err.role = role; return err
  }
  function assign({ role, briefFile, note }) {
    const member = crew.members?.[role]
    if (!member) throw new Error(`role ${role} not seated in this crew`)
    const prior = [...runs.values()].reverse().find((r) => r.role === role)
    const persisted = activeRun(role)
    const sessionId = member.session_id || persisted?.sessionId || uuid()
    if (prior && !exists(prior.exit)) throw busy(role, sessionId)
    const reconciliation = store.reconcile(role)
    if (reconciliation.verdict === VERDICTS.BUSY) throw busy(role, sessionId)
    if (reconciliation.verdict === VERDICTS.UNRESOLVABLE) throw unresolvable(role, sessionId)
    if (reconciliation.verdict === VERDICTS.RECLAIMABLE) store.clear(reconciliation.handle)
    if (!member.session_id) {
      member.session_id = sessionId
      persistCrew(crew, paths, write)
    }
    const allocation = allocateRun()
    const { id, dir } = allocation
    const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
    if (exists(returnPath)) unlink(returnPath)
    const stream = join(dir, 'stream.jsonl'), stderr = join(dir, 'stderr.log'), exit = join(dir, 'exit'), cmdPath = join(dir, 'cmd.json')
    const prompt = assignmentLine({ id, role, briefFile, returnPath, taskDir: taskDir || paths.taskDir }) + (note ? `\n${note}` : '')
    const command = workerCommand(adapterFor(adapters, role), { role, model: member.model, promptFile: join(taskDir || paths.taskDir, `role-${role}.md`), tools: member.tools || undefined, deny: member.deny || undefined, taskDir: taskDir || paths.taskDir, prompt, sessionId, resume: !!member.started, bin, effort: member.effort })
    const args = command.args || []
    const pgid = join(dir, 'pgid')
    const shell = `printf '%s' $$ >${shq(`${pgid}.tmp`)}; mv ${shq(`${pgid}.tmp`)} ${shq(pgid)}; ${shq(command.bin)} ${args.map(shq).join(' ')} >${shq(stream)} 2>${shq(stderr)}; printf '%s' $? >${shq(`${exit}.tmp`)}; mv ${shq(`${exit}.tmp`)} ${shq(exit)}`
    const reservation = store.reserve(role, { phase: PHASES.RESERVED, sessionId, evidence: { kind: EVIDENCE_KINDS.PGID, file: pgid }, role, id, dir, returnPath, exit, startedAt: now() })
    if (!reservation.ok) {
      if (reservation.reason === 'unresolvable') throw unresolvable(role, sessionId)
      throw busy(role, sessionId)
    }
    const handle = reservation.handle
    try {
      write(cmdPath, JSON.stringify(command, null, 2))
      store.advance(handle, PHASES.SPAWNING)
    } catch (err) {
      try { if (exists(cmdPath)) unlink(cmdPath) } catch {}
      try { store.clear(handle) } catch {}
      throw err
    }
    let child
    try {
      child = spawn('/bin/sh', ['-c', shell], { detached: true, stdio: 'ignore', cwd: checkout || crew.checkout, env: { ...process.env, ...(command.env || {}) } })
    } catch (err) {
      try { if (exists(cmdPath)) unlink(cmdPath) } catch {}
      try { store.clear(handle) } catch {}
      throw err
    }
    // unref is intentionally outside the spawn try: after spawn returns the
    // SPAWNING marker is the recovery record, even if this supervisor crashes.
    child.unref?.()
    store.advance(handle, PHASES.RUNNING, { pid: child.pid })
    member.started = true
    persistCrew(crew, paths, write)
    const run = { role, id, model: member.model ?? null, sessionId, pid: child.pid, reservation_id: handle.reservation_id, dir, stream, stderr, exit, cmdPath, returnPath, startedAt: now() }
    runs.set(returnPath, run)
    log({ at: now(), event: 'headless-spawn', role, id, pid: child.pid, dir, returnPath })
    return { id, returnPath }
  }
  function wait(returnPath, timeoutS) {
    const run = runs.get(returnPath) || { role: 'unknown', returnPath, stream: '', exit: '' }
    const deadline = now() + Number(timeoutS) * 1000
    while (now() < deadline) {
      const env = readEnvelope(returnPath)
      if (env) { const exitCode = parseExit(run.exit, read, exists); const stream = parseStream(run.stream, read, exists); const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: env, timedOut: false }); recordOutcome(run, outcome, stream, exitCode); emitUsage(run, stream.usage); return env }
      const exitCode = parseExit(run.exit, read, exists)
      if (exitCode !== null) { const stream = parseStream(run.stream, read, exists); const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: null, timedOut: false }); recordOutcome(run, outcome, stream, exitCode); emitUsage(run, stream.usage); throw outcomeError(run, outcome) }
      sleep(WAIT_POLL_MS)
    }
    if (run.pid != null) { try { kill(-run.pid, 'SIGTERM') } catch {} }
    const graceDeadline = now() + KILL_GRACE_MS
    while (now() < graceDeadline && parseExit(run.exit, read, exists) === null) sleep(WAIT_POLL_MS)
    if (parseExit(run.exit, read, exists) === null && run.pid != null) {
      let proven = false
      try { kill(-run.pid, 'SIGKILL'); proven = true } catch (err) { proven = err?.code === 'ESRCH' }
      if (!proven) {
        const current = store.reconcile(run.role)
        if (current.marker?.reservation_id === run.reservation_id) proven = store.probeEvidence(current.marker.evidence) === LIVENESS.DEAD
      }
      if (proven) store.clear({ key: run.role, reservation_id: run.reservation_id })
      else log({ at: now(), event: 'headless-timeout-marker-retained', role: run.role, id: run.id })
    }
    const raced = readEnvelope(returnPath)
    if (raced) { const stream = parseStream(run.stream, read, exists); const exitCode = parseExit(run.exit, read, exists); const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: raced, timedOut: false }); recordOutcome(run, outcome, stream, exitCode); emitUsage(run, stream.usage); return raced }
    const exitCode = parseExit(run.exit, read, exists), stream = parseStream(run.stream, read, exists), outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: null, timedOut: true })
    recordOutcome(run, outcome, stream, exitCode); emitUsage(run, stream.usage); throw outcomeError(run, outcome)
  }
  return { assign, wait }
}
