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

function parseStream(path, readFileSync, existsSync) {
  if (!existsSync(path)) return { sawJson: false, terminal: false, terminalReason: null, lines: 0 }
  let text
  try { text = readFileSync(path, 'utf8') } catch { return { sawJson: false, terminal: false, terminalReason: null, lines: 0 } }
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
  return { sawJson, terminal, terminalReason, lines }
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
  const log = deps.log || ((obj) => {
    try { write(join(paths.dir, 'journal.jsonl'), `${JSON.stringify(obj)}\n`, { flag: 'a' }) } catch { /* diagnostics only */ }
  })
  const root = join(taskDir || paths.taskDir, 'headless')
  let seq = 0
  try {
    for (const name of readdir(root)) {
      const match = /^d(\d+)$/.exec(name)
      if (match) seq = Math.max(seq, Number(match[1]))
    }
  } catch { /* the root is created lazily by the first assignment */ }
  const runs = new Map()

  function activePath(role) { return join(root, `.${role}.active.json`) }
  function readState(path) {
    if (!exists(path)) return null
    try { return JSON.parse(read(path, 'utf8')) } catch { return null }
  }
  function activeRun(role) { return readState(activePath(role)) }
  function ownerAlive(pid) {
    if (!pid || pid === process.pid) return true
    try { kill(pid, 0); return true } catch { return false }
  }
  function clearFinishedActive(role, active) {
    if (active && exists(active.exit)) {
      try { unlink(activePath(role)) } catch { /* stale marker cleanup is best effort */ }
    }
  }
  function clearKilledActive(run) {
    const active = activeRun(run.role)
    // Never remove a marker belonging to a replacement process. Matching the
    // run id and pid proves this is the group we just terminated.
    if (!active || active.id !== run.id || active.pid !== run.pid) return
    try { unlink(activePath(run.role)) } catch { /* cleanup is best effort */ }
  }

  function readEnvelope(returnPath) { return envelopeAt(returnPath, exists, read) }

  function recordOutcome(run, outcome, stream, exitCode, signal = null) {
    log({
      at: now(), headless_outcome: outcome, exit_code: exitCode, signal,
      terminal_reason: stream.terminalReason, lines: stream.lines, stream: run.stream,
      ...(outcome === 'ok-degraded' ? { mismatch: 'envelope arrived but exit/terminal evidence was not a clean match' } : {}),
    })
  }

  function outcomeError(run, outcome, message) {
    const err = new Error(message || `headless ${outcome}: seat ${run.role} produced no valid envelope at ${run.returnPath}`)
    err.stage = `headless-${outcome}`
    err.role = run.role
    return err
  }

  function assign({ role, briefFile, note }) {
    const member = crew.members?.[role]
    if (!member) throw new Error(`role ${role} not seated in this crew`)
    const prior = [...runs.values()].reverse().find((r) => r.role === role)
    const persisted = activeRun(role)
    const sessionId = member.session_id || persisted?.sessionId || uuid()
    const livePersisted = persisted && !exists(persisted.exit)
    const staleReservation = livePersisted && persisted.phase === 'starting' && !persisted.pid && !ownerAlive(persisted.ownerPid)
    if ((prior && !exists(prior.exit)) || (livePersisted && !staleReservation)) {
      const err = new Error(`headless: seat ${role} already has a live invocation against session ${sessionId} — refusing a concurrent turn (ADR-029 §5 c3)`)
      err.stage = 'headless-session-busy'
      err.role = role
      throw err
    }
    // An owner that died can leave a marker behind before its child was
    // spawned; reclaim only that proven-dead reservation. A marker with an
    // exit file is simply a completed prior turn. In either case, its stable
    // session id must be retained for --resume.
    if (staleReservation) {
      try { unlink(activePath(role)) } catch { /* stale marker cleanup is best effort */ }
    }
    clearFinishedActive(role, persisted)
    if (!member.session_id) {
      member.session_id = sessionId
      persistCrew(crew, paths, write)
    }
    seq += 1
    const id = `d${seq}`
    const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
    if (exists(returnPath)) unlink(returnPath)
    const dir = join(root, id)
    mkdir(dir, { recursive: true })
    const stream = join(dir, 'stream.jsonl')
    const stderr = join(dir, 'stderr.log')
    const exit = join(dir, 'exit')
    const cmdPath = join(dir, 'cmd.json')
    const prompt = assignmentLine({ id, role, briefFile, returnPath, taskDir: taskDir || paths.taskDir }) + (note ? `\n${note}` : '')
    const command = workerCommand(adapterFor(adapters, role), {
      role,
      model: member.model,
      promptFile: join(taskDir || paths.taskDir, `role-${role}.md`),
      tools: member.tools || undefined,
      deny: member.deny || undefined,
      taskDir: taskDir || paths.taskDir,
      prompt,
      sessionId,
      resume: !!member.started,
      bin,
      effort: member.effort,
    })
    const args = command.args || []
    const shell = `${shq(command.bin)} ${args.map(shq).join(' ')} >${shq(stream)} 2>${shq(stderr)}; printf '%s' $? >${shq(`${exit}.tmp`)}; mv ${shq(`${exit}.tmp`)} ${shq(exit)}`
    write(cmdPath, JSON.stringify(command, null, 2))
    const reservation = { phase: 'starting', role, id, pid: null, ownerPid: process.pid, sessionId, dir, returnPath, exit, startedAt: now() }
    try {
      write(activePath(role), JSON.stringify(reservation), { flag: 'wx' })
    } catch (err) {
      // Another supervisor may have claimed the seat between our initial
      // inspection and reservation. Surface the same attributable busy error.
      if (exists(activePath(role))) {
        const busy = new Error(`headless: seat ${role} already has a live invocation against session ${sessionId} — refusing a concurrent turn (ADR-029 §5 c3)`)
        busy.stage = 'headless-session-busy'; busy.role = role
        throw busy
      }
      throw err
    }
    let child
    try {
      child = spawn('/bin/sh', ['-c', shell], {
        detached: true,
        stdio: 'ignore',
        cwd: checkout || crew.checkout,
        env: { ...process.env, ...(command.env || {}) },
      })
      child.unref?.()
    } catch (err) {
      try { unlink(cmdPath) } catch { /* leave diagnostics if cleanup fails */ }
      try { unlink(activePath(role)) } catch { /* leave reservation if cleanup fails */ }
      throw err
    }
    member.started = true
    persistCrew(crew, paths, write)
    const run = { role, id, pid: child.pid, dir, stream, stderr, exit, cmdPath, returnPath, startedAt: now() }
    // Update the reservation with the detached child pid. The marker is the
    // cross-supervisor serialization record; a restart can distinguish a
    // live child from a failed pre-spawn reservation.
    write(activePath(role), JSON.stringify({ phase: 'running', role, id, pid: child.pid, ownerPid: process.pid, sessionId, dir, returnPath, exit, startedAt: run.startedAt }))
    runs.set(returnPath, run)
    log({ at: now(), event: 'headless-spawn', role, id, pid: child.pid, dir, returnPath })
    return { id, returnPath }
  }

  function wait(returnPath, timeoutS) {
    const run = runs.get(returnPath) || { role: 'unknown', returnPath, stream: '', exit: '' }
    const deadline = now() + Number(timeoutS) * 1000
    while (now() < deadline) {
      const env = readEnvelope(returnPath)
      if (env) {
        const exitCode = parseExit(run.exit, read, exists)
        const stream = parseStream(run.stream, read, exists)
        const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: env, timedOut: false })
        recordOutcome(run, outcome, stream, exitCode)
        return env
      }
      const exitCode = parseExit(run.exit, read, exists)
      if (exitCode !== null) {
        const stream = parseStream(run.stream, read, exists)
        const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: null, timedOut: false })
        recordOutcome(run, outcome, stream, exitCode)
        throw outcomeError(run, outcome)
      }
      sleep(WAIT_POLL_MS)
    }

    // The deadline is a budget, not permission to hang. Kill the detached
    // process group so grandchildren owned by the worker are reaped too.
    if (run.pid != null) {
      try { kill(-run.pid, 'SIGTERM') } catch { /* it may have exited in the race */ }
    }
    const graceDeadline = now() + KILL_GRACE_MS
    while (now() < graceDeadline && parseExit(run.exit, read, exists) === null) sleep(WAIT_POLL_MS)
    if (parseExit(run.exit, read, exists) === null && run.pid != null) {
      try { kill(-run.pid, 'SIGKILL') } catch { /* already dead */ }
      // SIGKILL terminates the shell wrapper before it can publish `exit`.
      // The process group was explicitly killed, so this marker is now a
      // proven-dead run and must not poison the seat forever.
      clearKilledActive(run)
    }
    const raced = readEnvelope(returnPath)
    if (raced) {
      const stream = parseStream(run.stream, read, exists)
      const exitCode = parseExit(run.exit, read, exists)
      const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: raced, timedOut: false })
      recordOutcome(run, outcome, stream, exitCode)
      return raced
    }
    const exitCode = parseExit(run.exit, read, exists)
    const stream = parseStream(run.stream, read, exists)
    const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: null, timedOut: true })
    recordOutcome(run, outcome, stream, exitCode)
    throw outcomeError(run, outcome)
  }

  return { assign, wait }
}
