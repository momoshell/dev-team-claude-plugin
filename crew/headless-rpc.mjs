// The stream is transport and observability, never the record; the envelope is
// the record; idle ≠ success. This synchronous supervisor keeps one pi RPC
// process per seat alive across assignments. retire is a boundary operation:
// it refuses an in-flight turn and leaves the session id intact.
import {
  existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync,
  unlinkSync as fsUnlinkSync, mkdirSync as fsMkdirSync, readdirSync as fsReaddirSync,
  openSync as fsOpenSync, writeSync as fsWriteSync, closeSync as fsCloseSync,
  renameSync as fsRenameSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn as cpSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { assignmentLine } from './driver.mjs'
import { shq, classifyRun, updateCrewJson } from './headless.mjs'
import { reclaimStore, PHASES, VERDICTS, EVIDENCE_KINDS, LIVENESS } from './reclaim.mjs'
import { translateDeny } from './adapters/adapter-pi.mjs'

export const WAIT_POLL_MS = 5000
// pi refuses input while compacting, and compaction runs between
// agent_end and agent_settled. Keep the settle gate bounded by polls rather
// than wall clock so injected supervisors can drive it deterministically.
export const SETTLE_GATE_POLLS = 12
export const PROMPT_REFUSAL_RETRIES = 2
const ABORT_SETTLE_MS = 2000
// The pre-SIGKILL window. The seat shell traps TERM (:316), so a SIGTERM
// delivered before the worker is exec'd is SWALLOWED and the worker never sees
// it — widening the wait alone does not make `proven` reachable, because the
// SIGNAL was lost, not the wait. Poll the seat's own exit marker on a short
// interval and re-deliver the TERM inside the window.
export const EXIT_MARKER_WINDOW_MS = 5000
export const EXIT_MARKER_POLL_MS = 25
export const TERM_REPEAT_MS = 500
const FIFO_RETRIES = 20
const FIFO_RETRY_MS = 100

// The closed run-end outcome set, mirroring ADR-030's gate discrimination
// vocabulary on purpose: `proven` is the ONLY answer that says a worker is
// gone. Anything that is not positive evidence of death — including "we sent
// the signal and kill() did not throw" — is unproven, never clean.
export function teardownOutcome(liveness) {
  if (liveness === LIVENESS.DEAD) return 'proven'
  if (liveness === LIVENESS.ALIVE) return 'failed'
  return 'unproven'
}

export const SEAT_COMMAND_FILE = 'cmd.fifo'
export function seatCommandPath(taskDir, role) {
  return join(taskDir, 'headless-rpc', role, SEAT_COMMAND_FILE)
}
export function steerFrame(message) { return { type: 'steer', message } }

// Do not use node:readline here. captures/pi-b5-readline-trap.txt has two
// LF-delimited records, while readline incorrectly exposes three around U+2028.
export function splitFrames(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8')
  const lines = []
  let start = 0
  for (;;) {
    const nl = input.indexOf(0x0a, start)
    if (nl < 0) break
    let line = input.subarray(start, nl).toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    lines.push(line)
    start = nl + 1
  }
  return { lines, rest: input.subarray(start) }
}

export function rpcCommand(spec = {}) {
  const {
    bin = 'pi', model, effort, sessionDir, sessionId, resume, promptFile,
    deny, env = {},
  } = spec
  return {
    bin,
    args: [
      '--mode', 'rpc', '--model', model,
      ...(effort ? ['--thinking', effort] : []),
      '--session-dir', sessionDir,
      ...(resume ? ['--session', sessionId] : ['--session-id', sessionId]),
      '--append-system-prompt', promptFile,
      ...(translateDeny(deny).length ? ['--exclude-tools', translateDeny(deny).join(',')] : []),
      '--no-context-files', '--no-extensions', '--no-skills',
    ],
    env,
  }
}

const byteLength = (value) => Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value ?? ''), 'utf8')

function usageInt(n) {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

function usageObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

// THE shared rule: which pi frame carries a SEAT'S OWN spend. It lives here and,
// character for character, in crew/pi/extensions/subagent.ts, and the two are
// pinned equal over one fixture table by the cross-file test in
// crew/pi/extensions/subagent.test.mjs. Make either side disagree and that test
// goes red: a comment in a third place is not a coupling.
//
// pi's agent loop emits a message_end for a NESTED TOOL RESULT too:
// createToolResultMessage sets role 'toolResult' and carries
// usage: finalized.result.usage, and emitToolResultMessage emits message_start
// and message_end for it (@earendil-works/pi-agent-core dist/agent-loop.js:536,
// :543, :549). The crew's own subagent tool returns a non-null usage on exactly
// that path. Folding it adds a nested tool's spend on top of the assistant turn
// that already accounts for it: a systematic OVER-count of what a seat cost.
//
// A message_end with NO role at all is REFUSED, deliberately. Both of pi's own
// emitters set one, so a role-less frame is not a shape pi produces. An absent
// role is an unrecognised frame, and an unrecognised frame must never inflate a
// billed total that prices into cost_usd. Refusing is also what subagent.ts's
// strict test already did, so the two reducers are IDENTICAL rather than merely
// compatible -- there is no property of either transport that wants them to
// differ here, and identical is the only agreement a table can pin.
export function carriesOwnSpend(frame) {
  if (!frame || frame.type !== 'message_end') return false
  const message = frame.message
  if (!message || typeof message !== 'object') return false
  return message.role === 'assistant'
}

// pi has no aggregate event: message_end carries a per-message delta, while
// turn_end and agent_end.messages[] replay that same usage. Counting either
// replay would double- or triple-count the billed tokens.
export function foldRpcUsage(frames) {
  const total = { billed_input_tokens: 0, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 }
  let measured = false
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!carriesOwnSpend(frame)) continue
    const usage = usageObject(frame.message.usage)
    if (!usage) continue
    measured = true
    total.billed_input_tokens += usageInt(usage.input)
    total.billed_output_tokens += usageInt(usage.output)
    total.billed_cache_write_tokens += usageInt(usage.cacheWrite)
    total.billed_cache_read_tokens += usageInt(usage.cacheRead)
  }
  return measured ? total : null
}

function addUsage(a, b) {
  if (b == null) return a
  if (a == null) return b
  return {
    billed_input_tokens: a.billed_input_tokens + b.billed_input_tokens,
    billed_output_tokens: a.billed_output_tokens + b.billed_output_tokens,
    billed_cache_write_tokens: a.billed_cache_write_tokens + b.billed_cache_write_tokens,
    billed_cache_read_tokens: a.billed_cache_read_tokens + b.billed_cache_read_tokens,
  }
}

function parseExit(path, read, exists) {
  if (!path || !exists(path)) return null
  try {
    const n = Number(String(read(path, 'utf8')).trim())
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

function envelopeAt(path, read, exists) {
  if (!path || !exists(path)) return null
  try {
    const value = JSON.parse(String(read(path, 'utf8')))
    return value && typeof value === 'object' ? value : null
  } catch { return null }
}

function adapterFor(adapters, role) {
  const entry = adapters?.[role]
  return entry?.adapter || entry || null
}

// The same ONE durability contract crew/headless.mjs owns (#539): this
// transport keeps its own persist entry point (the import firewall between the
// two transports is deliberate) but publishes through the single owner, so
// there is one atomic, locked writer of crew.json rather than two contracts.
function persistCrew(paths, role, patch, deps) {
  return updateCrewJson(paths, (disk) => {
    const member = disk?.members?.[role]
    if (!member) return false
    Object.assign(member, patch)
    return true
  }, deps)
}

function notePersist(log, now, role, result) {
  if (result?.ok || result?.reason === 'absent' || result?.reason === 'no-dir') return
  log({ at: now(), event: 'crew-json-persist-failed', role, reason: result?.reason ?? 'unknown', error: result?.error ?? null })
}

function staged(stage, message, role) {
  const err = new Error(message || stage)
  err.stage = stage
  if (role) err.role = role
  return err
}

// pi's refusal while it is compacting, verbatim: "Agent is already
// processing. Specify streamingBehavior ('steer' or 'followUp') to queue
// the message." A refusal is a boundary, not a failed turn.
export function isBusyRefusal(frame) {
  if (!frame || frame.success !== false) return false
  return /already processing|streamingBehavior/i.test(String(frame.error ?? ''))
}

export function emptyTurnEnvelope({ id, role, returnPath }) {
  return {
    assignment_id: id, role, status: 'insufficient',
    summary: `seat ${role} settled without writing an envelope to ${returnPath}; the turn produced no usable return`,
    artifacts: [],
    details: { degraded: 'rpc-no-envelope' },
  }
}

export function headlessRpcIo({ crew, paths, taskDir, checkout, adapters, bin, deps = {} }) {
  const spawn = deps.spawn || cpSpawn
  const open = deps.openSync || fsOpenSync
  const writeFd = deps.writeSync || fsWriteSync
  const closeFd = deps.closeSync || fsCloseSync
  const exists = deps.existsSync || fsExistsSync
  const read = deps.readFileSync || fsReadFileSync
  const write = deps.writeFileSync || fsWriteFileSync
  const unlink = deps.unlinkSync || fsUnlinkSync
  const mkdir = deps.mkdirSync || fsMkdirSync
  const readdir = deps.readdirSync || fsReaddirSync
  const rename = deps.renameSync || fsRenameSync
  const kill = deps.kill || ((p, signal) => process.kill(p, signal))
  const uuid = deps.uuid || randomUUID
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  })
  const pid = deps.pid ?? process.pid
  const injectedLog = deps.log
  const crewDeps = { existsSync: exists, readFileSync: read, writeFileSync: write, renameSync: rename, unlinkSync: unlink, mkdirSync: mkdir, readdirSync: readdir, uuid, now, sleep, pid }
  const emit = deps.emit
  function emitUsage(turn, seat, usage) {
    try {
      emit?.({ kind: 'usage', id: turn.id, role: turn.role, model: crew.members?.[turn.role]?.model ?? null, session_id: seat.sessionId ?? null, transcript_path: seat.stream, usage })
    } catch { /* ADR-026: instrumentation is never load-bearing */ }
  }
  const root = join(taskDir || paths.taskDir, 'headless-rpc')
  const store = reclaimStore({
    dir: root, actor: `headless-rpc:${pid}`, deps,
    // The seat layout intentionally differs from headless-json's d<n> run
    // directories; register its role-local pgid as the same evidence kind.
    evidencePolicies: { [EVIDENCE_KINDS.PGID]: (_role, marker) => marker?.evidence || null },
  })
  const seats = new Map()
  const pending = new Map()
  let commandSeq = 0
  let settlePolls = 0

  function log(value) {
    if (injectedLog) return injectedLog(value)
    try { write(join(paths.dir, 'journal.jsonl'), `${JSON.stringify(value)}\n`, { flag: 'a' }) } catch { /* diagnostics only */ }
  }
  function seatDir(role) { return join(root, role) }
  function seatFile(role, name) { return join(seatDir(role), name) }
  function sessionPath(role) { return seatFile(role, 'session.json') }
  function readJson(path) {
    try { return exists(path) ? JSON.parse(String(read(path, 'utf8'))) : null } catch { return null }
  }
  function saveJson(path, value) { write(path, JSON.stringify(value, null, 2)) }
  function session(role) { return readJson(sessionPath(role)) || {} }
  function saveSession(role, value) { saveJson(sessionPath(role), { ...session(role), ...value }) }
  function commandId(turn, command) {
    commandSeq += 1
    return `${turn?.id || 'rpc'}-${command}-${commandSeq}`
  }
  function fileSize(path) {
    if (!exists(path)) return 0
    try { return byteLength(read(path)) } catch { return 0 }
  }
  function nextAssignmentId() {
    let max = 0
    const inspect = (name) => { const m = /^d(\d+)(?:\.|$)/.exec(name); if (m) max = Math.max(max, Number(m[1])) }
    try { for (const name of readdir(root)) inspect(name) } catch {}
    try { for (const name of readdir(paths.returnsDir)) inspect(name) } catch {}
    try {
      for (const name of readdir(root)) {
        const saved = readJson(join(root, name, 'session.json'))
        max = Math.max(max, Number(String(saved?.lastAssignmentId || '').slice(1)) || 0)
      }
    } catch {}
    for (const seat of seats.values()) max = Math.max(max, Number(String(session(seat.role).lastAssignmentId || '').slice(1)) || 0)
    return `d${max + 1}`
  }
  function readFrames(seat) {
    const path = seat.stream
    if (!exists(path)) return []
    let current
    try {
      const raw = read(path)
      current = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
    } catch { return [] }
    if (current.length < seat.readOffset) { seat.readOffset = 0; seat.rest = Buffer.alloc(0) }
    const chunk = current.subarray(seat.readOffset)
    seat.readOffset = current.length
    const split = splitFrames(Buffer.concat([seat.rest || Buffer.alloc(0), chunk]))
    seat.rest = split.rest
    const out = []
    for (const line of split.lines) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* truncated or diagnostic lines are inert */ }
    }
    return out
  }
  function fold(seat, frames) {
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue
      if (seat.turn) {
        seat.turn.state.sawJson = true
        if (frame.type === 'agent_settled') seat.turn.state.settled = true
        // agent_end is only the conversation boundary; it is not completion.
        if (frame.type === 'agent_end') seat.turn.state.ended = true
      }
      if (!seat.turn && seat.settling && frame.type === 'agent_settled') seat.settling.state.settled = true
      if (frame.type === 'response') {
        if (frame.id != null) {
          seat.responses.set(frame.id, frame)
          pending.delete(frame.id)
        }
      }
    }
    if (seat.turn) seat.turn.usage = addUsage(seat.turn.usage, foldRpcUsage(frames))
    return frames
  }
  function pollSeat(seat) { return fold(seat, readFrames(seat)) }
  function responseError(role, frame) {
    const command = frame.command || 'unknown'
    return staged('rpc-command-error', `rpc command ${JSON.stringify(command)} failed: ${frame.error || 'unknown error'}`, role)
  }
  function send(seat, obj, command = obj.type || obj.command || 'command') {
    const id = obj.id || commandId(seat.turn, command)
    const value = { ...obj, id }
    pending.set(id, { command, at: now() })
    writeFd(seat.fd, `${JSON.stringify(value)}\n`)
    return id
  }
  function ensureProcess(role, assignmentId = 'd0') {
    const member = crew.members?.[role]
    if (!member) throw new Error(`role ${role} not seated in this crew`)
    let seat = seats.get(role)
    if (seat && (!seat.exit || !exists(seat.exit))) return seat
    if (seat?.fd != null) { try { closeFd(seat.fd) } catch {} }
    if (seat?.handle) { try { store.clear(seat.handle) } catch {} }
    seat = null
    const dir = seatDir(role)
    mkdir(dir, { recursive: true })
    const stream = seatFile(role, 'stream.jsonl'), stderr = seatFile(role, 'stderr.log')
    const exit = seatFile(role, 'exit'), pgid = seatFile(role, 'pgid'), fifo = seatFile(role, SEAT_COMMAND_FILE), cmdPath = seatFile(role, 'cmd.json')
    const old = session(role)
    const sessionId = member.session_id || old.sessionId || uuid()
    const resume = !!(member.started || old.sessionId)
    // A prior process may have exited while this supervisor was away. Observe
    // its completion proof before removing the reusable seat's exit marker.
    const prior = store.reconcile(role)
    if (prior.marker?.exit && exists(prior.marker.exit)) {
      try { store.clear(prior.handle) } catch {}
    }
    if (exists(exit)) { try { unlink(exit) } catch {} }
    let marker = store.reconcile(role)
    let fd = null
    let child = null
    if (marker.verdict === VERDICTS.BUSY && marker.marker?.pid) {
      // Adopt a still-running seat rather than opening a second pi session.
      fd = open(fifo, 'r+')
      seat = { role, dir, stream, stderr, exit, pgid, fifo, cmdPath, fd, pid: marker.marker.pid, sessionId, readOffset: fileSize(stream), rest: Buffer.alloc(0), responses: new Map(), turn: null, settling: null, handle: marker.handle }
      seats.set(role, seat)
      return seat
    }
    if (marker.verdict === VERDICTS.UNRESOLVABLE) throw staged('rpc-unresolvable-reservation', `rpc seat ${role} has an unresolvable reservation`, role)
    if (marker.verdict === VERDICTS.RECLAIMABLE) { try { store.clear(marker.handle) } catch {} }
    const adapter = adapterFor(adapters, role)
    const commandFactory = adapter?.rpcCommand || rpcCommand
    const command = commandFactory.call(adapter, {
      role, model: member.model, effort: member.effort, sessionDir: dir,
      sessionId, resume, promptFile: join(taskDir || paths.taskDir, `role-${role}.md`),
      deny: member.deny, bin: bin || 'pi', taskDir: taskDir || paths.taskDir,
      env: { ...process.env, DEVTEAM_WORKER: '1', CREW_ROLE: role, CREW_TASK_DIR: taskDir || paths.taskDir },
    })
    const args = command.args || []
    const shell = `trap ':' TERM INT; rm -f ${shq(exit)}; mkfifo ${shq(fifo)} 2>/dev/null; printf '%s' $$ >${shq(`${pgid}.tmp`)}; mv ${shq(`${pgid}.tmp`)} ${shq(pgid)}; ${shq(command.bin || bin || 'pi')} ${args.map(shq).join(' ')} <${shq(fifo)} >>${shq(stream)} 2>>${shq(stderr)}; printf '%s' $? >${shq(`${exit}.tmp`)}; mv ${shq(`${exit}.tmp`)} ${shq(exit)}`
    const reservation = store.reserve(role, {
      phase: PHASES.RESERVED, sessionId, evidence: { kind: EVIDENCE_KINDS.PGID, file: pgid },
      role, id: assignmentId, dir, returnPath: '', exit, startedAt: now(),
    })
    if (!reservation.ok) throw staged(reservation.reason === 'unresolvable' ? 'rpc-unresolvable-reservation' : 'rpc-session-busy', `rpc seat ${role} is busy`, role)
    const handle = reservation.handle
    try {
      saveJson(cmdPath, command)
      store.advance(handle, PHASES.SPAWNING)
      child = spawn('/bin/sh', ['-c', shell], { detached: true, stdio: 'ignore', cwd: checkout || crew.checkout, env: { ...process.env, ...(command.env || {}) } })
      child.unref?.()
      store.advance(handle, PHASES.RUNNING, { pid: child.pid })
      // Opening is the probe: injected supervisors may model the FIFO without
      // materializing a filesystem node, while the real O_RDWR open fails until
      // mkfifo has completed. Keep the retry bounded in either case.
      for (let i = 0; i < FIFO_RETRIES && fd == null; i += 1) {
        try { fd = open(fifo, 'r+') } catch { sleep(FIFO_RETRY_MS) }
      }
      if (fd == null) throw staged('rpc-spawn-failed', `rpc fifo did not appear for seat ${role}`, role)
      member.session_id = sessionId; member.started = true
      notePersist(log, now, role, persistCrew(paths, role, { session_id: sessionId, started: true }, crewDeps))
      saveSession(role, { sessionId, pid: child.pid, startedAt: now(), lastAssignmentId: assignmentId })
      seat = { role, dir, stream, stderr, exit, pgid, fifo, cmdPath, fd, pid: child.pid, sessionId, readOffset: fileSize(stream), rest: Buffer.alloc(0), responses: new Map(), turn: null, settling: null, handle }
      seats.set(role, seat)
      return seat
    } catch (err) {
      // A SPAWNING marker is deliberately retained when the child may have
      // started; reclaimStore is the authority used to resolve that case.
      if (!child) { try { store.clear(handle) } catch {} }
      throw err
    }
  }
  function commandResponse(seat, id, timeoutMs = ABORT_SETTLE_MS) {
    const deadline = now() + timeoutMs
    while (now() <= deadline) {
      pollSeat(seat)
      const frame = seat.responses.get(id)
      if (frame) return frame
      sleep(WAIT_POLL_MS)
    }
    return null
  }
  function pollUntilSettled(seat, state, polls = SETTLE_GATE_POLLS) {
    const limit = Math.max(0, Math.trunc(Number(polls) || 0))
    settlePolls = 0
    for (;;) {
      try { pollSeat(seat) } catch { return false }
      if (state.settled) return true
      if (settlePolls >= limit) return false
      settlePolls += 1
      try { sleep(WAIT_POLL_MS) } catch { return false }
    }
  }
  function awaitSettled(seat) {
    const settling = seat.settling
    if (!settling) return true
    const settled = pollUntilSettled(seat, settling.state)
    const polls = settlePolls
    seat.settling = null
    try {
      log({ at: now(), rpc_settle_gate: { role: settling.role, id: settling.id, settled, polls } })
    } catch { /* diagnostics only */ }
    return settled
  }
  function assign({ role, briefFile, note }) {
    const member = crew.members?.[role]
    if (!member) throw new Error(`role ${role} not seated in this crew`)
    let existing = seats.get(role)
    if (existing?.turn && !existing.turn.state.settled) throw staged('rpc-session-busy', `rpc seat ${role} already has an in-flight turn`, role)
    if (existing) awaitSettled(existing)
    const id = nextAssignmentId()
    const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
    if (exists(returnPath)) unlink(returnPath)
    const seat = ensureProcess(role, id)
    const offset = fileSize(seat.stream)
    seat.readOffset = offset; seat.rest = Buffer.alloc(0); seat.responses.clear()
    const prompt = assignmentLine({ id, role, briefFile, returnPath, taskDir: taskDir || paths.taskDir }) + (note ? `\n${note}` : '')
    const turn = { id, role, returnPath, prompt, retries: 0, offset, usage: null, state: { sawJson: false, settled: false, ended: false }, sentAt: now() }
    seat.turn = turn
    const promptId = send(seat, { type: 'prompt', message: prompt, id }, 'prompt')
    turn.promptId = promptId
    saveSession(role, { sessionId: seat.sessionId, pid: seat.pid, startedAt: session(role).startedAt || now(), lastAssignmentId: id })
    return { id, returnPath }
  }
  // The envelope is the record, but it is not the seat's readiness: pi may
  // still be compacting. Park an unsettled turn so the next assign can wait
  // for agent_settled instead of prompting into a refusal.
  function finishTurn(seat) {
    seat.settling = seat.turn && !seat.turn.state.settled ? seat.turn : null
    seat.turn = null
    seat.responses.clear()
  }
  function proveGroupDead(target) {
    const clearIfDead = (liveness) => {
      if (liveness === LIVENESS.DEAD && target.handle) {
        try { store.clear(target.handle) } catch { /* proof remains useful even if release is unavailable */ }
      }
    }
    const finish = (liveness, reason) => {
      clearIfDead(liveness)
      return { liveness, reason }
    }
    const exitProof = () => parseExit(target.exit, read, exists) !== null
    // The signal target is validated BEFORE anything is trusted: kill(-0, sig)
    // signals THIS crew's own group and kill(-1, sig) signals every process this
    // user can signal. Neither is ever a teardown.
    const pgid = Number(target.pid)
    const signalable = Number.isSafeInteger(pgid) && pgid > 1

    // A reaped worker's pgid may have since been reused. Never signal a target
    // that already left its own exit marker behind. This short-circuit is bound
    // to the SEAT'S OWN file, which ensureProcess unlinks before every spawn.
    if (exitProof()) return finish(LIVENESS.DEAD, 'exit-marker')
    // No probe either: an unsignalable target leaves the reservation intact and
    // settles UNKNOWN. UNKNOWN is never clean.
    if (!signalable) return finish(LIVENESS.UNKNOWN, 'invalid-pgid')

    try { kill(-pgid, 'SIGTERM') } catch {}
    let lastTerm = now()
    const deadline = now() + EXIT_MARKER_WINDOW_MS
    while (now() < deadline) {
      if (exitProof()) return finish(LIVENESS.DEAD, 'exit-marker')
      if (now() - lastTerm >= TERM_REPEAT_MS) {
        lastTerm = now()
        try { kill(-pgid, 'SIGTERM') } catch {}
      }
      sleep(Math.min(EXIT_MARKER_POLL_MS, Math.max(1, deadline - now())))
    }
    if (exitProof()) return finish(LIVENESS.DEAD, 'exit-marker')

    try { kill(-pgid, 'SIGKILL') }
    catch (err) { if (err?.code === 'ESRCH') return finish(LIVENESS.DEAD, 'signal-esrch') }
    if (exitProof()) return finish(LIVENESS.DEAD, 'exit-marker')

    const current = store.reconcile(target.role)
    if (!target.handle || typeof target.handle.reservation_id !== 'string'
      || typeof current.marker?.reservation_id !== 'string'
      || current.marker.reservation_id !== target.handle.reservation_id) {
      return finish(LIVENESS.UNKNOWN, 'reservation-mismatch')
    }
    // The evidence file is written by the spawn shell AFTER mkfifo and nothing
    // deletes it between spawns, so it can still hold a PREVIOUS run's number.
    // Proving a STALE group dead is not proof this one is: bind the evidence to
    // the validated target, and on mismatch keep the reservation (UNKNOWN never
    // reaches clearIfDead).
    const evidence = current.marker.evidence
    if (evidencePgid(evidence) !== pgid) return finish(LIVENESS.UNKNOWN, 'evidence-mismatch')
    const liveness = store.probeEvidence(evidence)
    if (liveness === LIVENESS.DEAD) return finish(LIVENESS.DEAD, 'probe-dead')
    if (liveness === LIVENESS.ALIVE) return finish(LIVENESS.ALIVE, 'probe-alive')
    return finish(LIVENESS.UNKNOWN, 'probe-unknown')
  }
  // Retire only at a settled boundary: kill the worker and release its seat,
  // while deliberately preserving the session id for the next assignment.
  function retire(role, options = {}) {
    const seat = seats.get(role)
    const inFlight = !!(seat?.turn && !seat.turn.state.settled)
    const forced = options?.force === true && inFlight
    if (inFlight && options?.force !== true) {
      return {
        retired: false,
        reason: 'in-flight',
        why: `rpc seat ${role} has an in-flight turn; retire it at a bounce boundary`,
      }
    }
    if (!seat) {
      return {
        retired: false,
        reason: 'not-running',
        why: `rpc seat ${role} is not running; the next assignment will spawn it`,
      }
    }
    try { closeFd(seat.fd) } catch {}
    const proof = proveGroupDead(seat)
    // Do not clear here: proveGroupDead retains an unproven reservation so a
    // later reader can still find the worker whose death we could not prove.
    // The session id survives a retire on purpose: ensureProcess will resume it
    // while reading the newly selected model and effort from the crew member.
    seats.delete(role)
    return { retired: true, sessionId: seat.sessionId, forced, liveness: proof.liveness, reason: proof.reason }
  }
  function abort(role, options = {}) {
    const seat = seats.get(role)
    if (!seat?.turn) throw staged('rpc-session-not-in-flight', `rpc seat ${role} has no in-flight turn`, role)
    const id = send(seat, { type: 'abort' }, 'abort')
    const deadline = now() + (options.settleMs ?? ABORT_SETTLE_MS)
    let response = null
    while (now() <= deadline) {
      pollSeat(seat)
      response ||= seat.responses.get(id)
      if (seat.turn.state.settled) return response
      sleep(WAIT_POLL_MS)
    }
    return response
  }
  // Boundary delivery, not interruption: an in-flight tool completes
  // undisturbed, and the guidance never changes wait()'s outcome.
  function steer(role, message) {
    const seat = seats.get(role)
    if (!seat?.turn || seat.turn.state.settled) throw staged('rpc-session-not-in-flight', `rpc seat ${role} has no in-flight turn`, role)
    const id = send(seat, steerFrame(message), 'steer')
    const response = commandResponse(seat, id)
    if (!response) throw staged('rpc-timeout', `timed out waiting for steer response for seat ${role}`, role)
    if (response.success === false) throw responseError(role, response)
    return response
  }
  function wait(returnPath, timeoutS) {
    const seat = [...seats.values()].find((s) => s.turn?.returnPath === returnPath)
    if (!seat) throw staged('rpc-no-envelope', `no rpc turn for ${returnPath}`)
    const turn = seat.turn
    const deadline = now() + Number(timeoutS) * 1000
    waitLoop: while (now() < deadline) {
      const frames = pollSeat(seat)
      for (const frame of frames) {
        if (frame?.type === 'response' && frame.command === 'parse' && frame.success === false) {
          emitUsage(turn, seat, turn.usage); finishTurn(seat); throw staged('rpc-parse-error', `rpc parse failed: ${frame.error || 'malformed input'}`, turn.role)
        }
        if (frame?.type === 'response' && frame.id === turn.promptId && frame.success === false) {
          if (isBusyRefusal(frame) && turn.retries < PROMPT_REFUSAL_RETRIES) {
            turn.retries += 1
            seat.responses.delete(frame.id)
            pollUntilSettled(seat, turn.state)
            turn.state.settled = false
            turn.state.ended = false
            turn.promptId = send(seat, {
              type: 'prompt', message: turn.prompt,
              id: `${turn.id}-p${turn.retries}`,
            }, 'prompt')
            log({ at: now(), rpc_prompt_retry: { role: turn.role, id: turn.id, attempt: turn.retries } })
            continue waitLoop
          }
          emitUsage(turn, seat, turn.usage); finishTurn(seat); throw responseError(turn.role, frame)
        }
      }
      const env = envelopeAt(returnPath, read, exists)
      const exitCode = parseExit(seat.exit, read, exists)
      if (env) {
        const outcome = classifyRun({ exitCode, signal: null, terminal: turn.state.settled, sawJson: turn.state.sawJson, envelope: env, timedOut: false })
        log({ at: now(), rpc_outcome: outcome, role: turn.role, id: turn.id, exit_code: exitCode })
        emitUsage(turn, seat, turn.usage)
        finishTurn(seat)
        return env
      }
      if (exitCode !== null) {
        const outcome = classifyRun({ exitCode, signal: null, terminal: turn.state.settled, sawJson: turn.state.sawJson, envelope: null, timedOut: false })
        emitUsage(turn, seat, turn.usage)
        finishTurn(seat)
        throw staged(`rpc-${outcome}`, `rpc ${outcome}: seat ${turn.role} produced no envelope at ${returnPath}`, turn.role)
      }
      if (turn.state.settled) {
        const detail = `rpc no-envelope: seat ${turn.role} produced no envelope at ${returnPath}`
        try {
          emit?.({ kind: 'cell-failure', role: turn.role, id: turn.id, failure: 'no-envelope', stage: 'rpc-no-envelope', detail })
        } catch { /* ADR-026: instrumentation is never load-bearing */ }
        try { log({ at: now(), rpc_outcome: 'no-envelope', role: turn.role, id: turn.id, degraded: true }) } catch { /* diagnostics only */ }
        emitUsage(turn, seat, turn.usage)
        finishTurn(seat)
        return emptyTurnEnvelope({ id: turn.id, role: turn.role, returnPath })
      }
      sleep(WAIT_POLL_MS)
    }
    abort(turn.role, { settleMs: ABORT_SETTLE_MS })
    if (!turn.state.settled) proveGroupDead(seat)
    // SIGTERM/abort handling can append a complete frame after the last
    // abort poll; drain it before the turn is cleared and usage is emitted.
    pollSeat(seat)
    emitUsage(turn, seat, turn.usage)
    finishTurn(seat)
    throw staged('rpc-timeout', `rpc timeout: seat ${turn.role} did not produce an envelope at ${returnPath}`, turn.role)
  }
  function entries(role, { since } = {}) {
    const seat = ensureProcess(role, 'd0')
    seat.responses.clear()
    const priorCursor = since ?? session(role).cursor ?? session(role).entries
    const id = send(seat, { type: 'get_entries', ...(priorCursor ? { since: priorCursor } : {}) }, 'get_entries')
    const response = commandResponse(seat, id)
    if (!response) throw staged('rpc-timeout', `timed out waiting for entries for seat ${role}`, role)
    if (response.success === false) throw responseError(role, response)
    const data = response.data || {}
    const list = Array.isArray(data.entries) ? data.entries : []
    const cursor = list.at(-1)?.id ?? data.leafId
    saveSession(role, { cursor, entries: cursor })
    return response
  }
  // The signal target is the marker's own RUN-BOUND pid. The role's `pgid` file
  // is written by the spawn shell after mkfifo and nothing deletes it between
  // spawns, so falling back to it means signalling the PREVIOUS run's group —
  // measured at baseline: an absent marker pid sent SIGTERM and SIGKILL to -702
  // and recorded `proven` from a stale probe while releasing the LIVE
  // reservation. The file may be read only in proveGroupDead's post-SIGKILL
  // tail, and only after it EQUALS this pid.
  function markerPgid(marker) {
    const candidate = Number(marker?.pid)
    return Number.isSafeInteger(candidate) && candidate > 1 ? candidate : null
  }
  function evidencePgid(evidence) {
    if (!evidence || evidence.kind !== EVIDENCE_KINDS.PGID
      || typeof evidence.file !== 'string') return null
    try {
      const value = Number(String(read(evidence.file, 'utf8')).trim())
      return Number.isSafeInteger(value) && value > 1 ? value : null
    } catch { return null }
  }
  // Run end: every piped seat this supervisor can identify, killed and PROVEN
  // dead. The candidates are the live seats plus the crew's roles — ensureProcess
  // refuses an unseated role, so this supervisor can have created nothing else.
  // A role with no seat can still hold a LIVE worker: spawn succeeds and
  // advances the marker to RUNNING, then FIFO acquisition fails and throws
  // before the seat is inserted. That worker is the leak this closes, so a
  // marker-only role is SIGNALLED, never merely probed.
  function teardown() {
    const rows = []
    const roles = new Set([...seats.keys(), ...Object.keys(crew.members || {})])
    const row = (role, values = {}) => ({
      role, transport: 'headless-rpc', session_id: null, pgid: null,
      reservation_id: null, outcome: 'unproven', reason: 'teardown-threw', forced: false,
      evidence_kind: EVIDENCE_KINDS.PGID, ...values,
    })
    for (const role of roles) {
      const seat = seats.get(role)
      try {
        if (seat) {
          const retired = retire(role, { force: true })
          rows.push(row(role, {
            session_id: retired.sessionId ?? seat.sessionId ?? null,
            pgid: seat.pid ?? null,
            reservation_id: seat.handle?.reservation_id ?? null,
            outcome: teardownOutcome(retired.liveness),
            reason: retired.reason,
            forced: retired.forced === true,
          }))
          continue
        }

        const current = store.reconcile(role)
        if (current.verdict === VERDICTS.FREE) continue
        if (current.marker === null && current.handle !== null) {
          rows.push(row(role, {
            reservation_id: current.handle.reservation_id ?? null,
            reason: 'unreadable-reservation',
            forced: false,
          }))
          continue
        }
        const marker = current.marker
        const targetPid = markerPgid(marker)
        const common = {
          session_id: marker?.sessionId ?? marker?.session_id ?? null,
          pgid: targetPid,
          reservation_id: current.handle?.reservation_id ?? marker?.reservation_id ?? null,
        }
        const proof = proveGroupDead({
          role, pid: targetPid, exit: seatFile(role, 'exit'), handle: current.handle,
        })
        rows.push(row(role, {
          ...common, outcome: teardownOutcome(proof.liveness), reason: proof.reason, forced: false,
        }))
      } catch (err) {
        rows.push(row(role, {
          session_id: seat?.sessionId ?? null,
          pgid: seat?.pid ?? null,
          reservation_id: seat?.handle?.reservation_id ?? null,
          why: String(err?.message ?? err),
        }))
      }
    }
    return rows
  }
  function close(role) {
    const targets = role ? [seats.get(role)].filter(Boolean) : [...seats.values()]
    for (const seat of targets) {
      try { closeFd(seat.fd) } catch {}
      if (seat.handle) { try { store.clear(seat.handle) } catch {} }
      seats.delete(seat.role)
    }
  }
  return { assign, wait, steer, abort, entries, retire, close, teardown }
}
