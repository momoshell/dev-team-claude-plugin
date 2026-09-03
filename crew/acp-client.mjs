import { spawn as cpSpawn } from 'node:child_process'
import {
  existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync, openSync as fsOpenSync, writeSync as fsWriteSync, closeSync as fsCloseSync,
} from 'node:fs'
import { join } from 'node:path'

import { splitFrames } from './headless-rpc.mjs'
import { shq } from './headless.mjs'
import { reclaimStore, PHASES, EVIDENCE_KINDS, LIVENESS } from './reclaim.mjs'

export const ACP_PROTOCOL_VERSION = 1
export const ACP_CLIENT_CAPABILITIES = Object.freeze({
  fs: Object.freeze({ readTextFile: false, writeTextFile: false }), terminal: false,
})
export const ACP_UPDATE_KINDS = Object.freeze([
  'agent_message_chunk', 'agent_thought_chunk', 'plan', 'tool_call', 'tool_call_update', 'usage_update',
])
export const ACP_STOP_REASONS = Object.freeze(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
export const ACP_REFUSALS = Object.freeze([
  'acp-malformed-frame', 'acp-protocol-mismatch', 'acp-spawn-failed', 'acp-session-busy',
  'acp-session-cancelled', 'acp-unresolvable-reservation', 'acp-request-timeout',
])
export const ACP_REQUEST_TIMEOUT_MS = 600000
export const ACP_POLL_MS = 25
const METHOD_NOT_FOUND = -32601

export function acpRefuse(reason, message) {
  if (!ACP_REFUSALS.includes(reason)) throw new Error(`unknown acp refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

export function acpSeatPaths(dir, role) {
  const seat = join(dir, role)
  return Object.freeze({
    dir: seat, stream: join(seat, 'stream.jsonl'), stderr: join(seat, 'stderr'),
    exit: join(seat, 'exit'), pgid: join(seat, 'pgid'), fifo: join(seat, 'cmd.fifo'),
  })
}

export function turnUsage(result) { return result && typeof result.usage === 'object' && result.usage !== null ? result.usage : null }

export function teardownOutcome(liveness) {
  if (liveness === LIVENESS.DEAD) return 'proven'
  if (liveness === LIVENESS.ALIVE) return 'failed'
  return 'unproven'
}

export function acpClient({ launch, dir, cwd, role = 'builder', sinks = {}, onPermission = null, deps = {} }) {
  const spawn = deps.spawn || cpSpawn
  const open = deps.openSync || fsOpenSync
  const writeFd = deps.writeSync || fsWriteSync
  const closeFd = deps.closeSync || fsCloseSync
  const exists = deps.existsSync || fsExistsSync
  const read = deps.readFileSync || fsReadFileSync
  const write = deps.writeFileSync || fsWriteFileSync
  const mkdir = deps.mkdirSync || fsMkdirSync
  const kill = deps.kill || ((p, signal) => process.kill(p, signal))
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms) })
  const pid = deps.pid ?? process.pid
  const journal = deps.log || (() => {})
  const paths = acpSeatPaths(dir, role)
  const store = reclaimStore({
    dir, actor: `acp:${pid}`, deps,
    evidencePolicies: { [EVIDENCE_KINDS.PGID]: (_role, marker) => marker?.evidence || null },
  })

  const session = { id: null, cancelled: false }
  const responses = new Map()
  let seq = 0
  let fd = null
  let child = null
  let handle = null
  let offset = 0
  let rest = Buffer.alloc(0)
  let closed = false
  let closeResult = null

  function log(row) { try { journal(row) } catch { /* instrumentation is never load-bearing */ } }
  function send(frame) { writeFd(fd, `${JSON.stringify(frame)}\n`) }
  function streamEnd() {
    try {
      if (!exists(paths.stream)) return 0
      const buffer = read(paths.stream)
      return Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(String(buffer), 'utf8')
    } catch (err) {
      throw acpRefuse('acp-spawn-failed', `acp stream for seat ${role} is unreadable: ${err?.message || err}`)
    }
  }

  function start() {
    mkdir(paths.dir, { recursive: true })
    offset = streamEnd()
    rest = Buffer.alloc(0)
    const reservation = store.reserve(role, {
      phase: PHASES.RESERVED, sessionId: null, evidence: { kind: EVIDENCE_KINDS.PGID, file: paths.pgid },
      role, id: role, dir: paths.dir, returnPath: '', exit: paths.exit, startedAt: now(),
    })
    if (!reservation.ok) throw acpRefuse(reservation.reason === 'unresolvable' ? 'acp-unresolvable-reservation' : 'acp-session-busy', `acp seat ${role} is busy`)
    handle = reservation.handle
    const args = launch?.args || []
    const shell = `trap ':' TERM INT; rm -f ${shq(paths.exit)}; mkfifo ${shq(paths.fifo)} 2>/dev/null; printf '%s' $$ >${shq(`${paths.pgid}.tmp`)}; mv ${shq(`${paths.pgid}.tmp`)} ${shq(paths.pgid)}; ${shq(launch?.bin)} ${args.map(shq).join(' ')} <${shq(paths.fifo)} >>${shq(paths.stream)} 2>>${shq(paths.stderr)}; printf '%s' $? >${shq(`${paths.exit}.tmp`)}; mv ${shq(`${paths.exit}.tmp`)} ${shq(paths.exit)}`
    store.advance(handle, PHASES.SPAWNING)
    try {
      child = spawn('/bin/sh', ['-c', shell], { detached: true, stdio: 'ignore', cwd, env: { ...process.env, ...(launch?.env || {}) } })
      child.unref?.()
    } catch (err) {
      try { store.clear(handle) } catch {}
      throw acpRefuse('acp-spawn-failed', `acp seat ${role} could not spawn: ${err?.message || err}`)
    }
    store.advance(handle, PHASES.RUNNING, { pid: child.pid })
    for (let i = 0; i < 20 && fd == null; i += 1) {
      try { fd = open(paths.fifo, 'r+') } catch { sleep(ACP_POLL_MS) }
    }
    if (fd == null) throw acpRefuse('acp-spawn-failed', `acp fifo did not appear for seat ${role}`)
    return { pid: child.pid }
  }

  // Two phases, deliberately. Staging PARSES every line in the batch and refuses
  // the whole batch on the first unparseable one; only a fully staged batch is
  // delivered. A client that fans out as it parses has already applied part of
  // a frame sequence it then refuses.
  function stage(line) {
    let frame
    try { frame = JSON.parse(line) } catch { throw acpRefuse('acp-malformed-frame', `acp seat ${role} wrote an unparseable frame`) }
    if (!frame || typeof frame !== 'object' || frame.jsonrpc !== '2.0') throw acpRefuse('acp-malformed-frame', `acp seat ${role} wrote a frame that is not JSON-RPC 2.0`)
    if (typeof frame.method === 'string' && Object.hasOwn(frame, 'id')) return { type: 'request', frame }
    if (typeof frame.method === 'string') return { type: 'notification', frame }
    if (Object.hasOwn(frame, 'id')) return { type: 'response', frame }
    throw acpRefuse('acp-malformed-frame', `acp seat ${role} wrote a frame that is neither a request, a notification nor a response`)
  }

  function fanOut(update) {
    const kind = update?.sessionUpdate
    if (!ACP_UPDATE_KINDS.includes(kind)) return { sink: 'unknown', kind, update }
    return { sink: kind, kind, update }
  }

  function answerPermission(frame) {
    const options = Array.isArray(frame.params?.options) ? frame.params.options : []
    const chosen = onPermission ? onPermission({ sessionId: frame.params?.sessionId ?? null, toolCall: frame.params?.toolCall ?? null, options }) : null
    const fallback = options.find((o) => o?.kind === 'reject_once') || null
    const optionId = chosen ?? fallback?.optionId ?? null
    log({ at: now(), acp_permission: { role, policy: chosen == null ? 'no-lead' : 'injected', optionId, tool: frame.params?.toolCall?.kind ?? null } })
    if (optionId == null) return send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } })
    return send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId } } })
  }

  function deliver(item) {
    const { type, frame } = item
    if (type === 'response') { responses.set(frame.id, frame); return }
    if (type === 'request') {
      if (frame.method === 'session/request_permission') return answerPermission(frame)
      log({ at: now(), acp_unknown_request: { role, method: frame.method } })
      return send({ jsonrpc: '2.0', id: frame.id, error: { code: METHOD_NOT_FOUND, message: `acp client does not implement ${frame.method}` } })
    }
    if (frame.method !== 'session/update') {
      log({ at: now(), acp_unknown_notification: { role, method: frame.method } })
      return undefined
    }
    const routed = fanOut(frame.params?.update)
    if (routed.sink === 'unknown') log({ at: now(), acp_unknown_update: { role, sessionUpdate: routed.kind ?? null } })
    const sink = sinks[routed.sink]
    if (typeof sink === 'function') sink({ sessionId: frame.params?.sessionId ?? null, kind: routed.kind, update: routed.update, at: now() })
    return undefined
  }

  function pump() {
    if (!exists(paths.stream)) return
    const buffer = read(paths.stream)
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8')
    if (bytes.length <= offset) return
    const fresh = Buffer.concat([rest, bytes.subarray(offset)])
    offset = bytes.length
    const { lines, rest: tail } = splitFrames(fresh)
    rest = tail
    const staged = []
    for (const line of lines) if (line.trim().length) staged.push(stage(line))
    for (const item of staged) deliver(item)
  }

  function request(method, params) {
    seq += 1
    const id = seq
    send({ jsonrpc: '2.0', id, method, params })
    const deadline = now() + ACP_REQUEST_TIMEOUT_MS
    for (;;) {
      pump()
      if (responses.has(id)) { const frame = responses.get(id); responses.delete(id); return frame }
      if (now() > deadline) throw acpRefuse('acp-request-timeout', `acp seat ${role} did not answer ${method}`)
      sleep(ACP_POLL_MS)
    }
  }

  function initialize() {
    const frame = request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: ACP_CLIENT_CAPABILITIES })
    if (frame.error) throw acpRefuse('acp-protocol-mismatch', `acp seat ${role} refused initialize: ${frame.error.message}`)
    if (frame.result?.protocolVersion !== ACP_PROTOCOL_VERSION) throw acpRefuse('acp-protocol-mismatch', `acp seat ${role} answered protocolVersion ${JSON.stringify(frame.result?.protocolVersion)}`)
    return frame.result
  }

  function newSession(params = {}) {
    const meta = params._meta ?? null
    const frame = request('session/new', { cwd: params.cwd ?? cwd, mcpServers: params.mcpServers ?? [], ...(meta ? { _meta: meta } : {}) })
    if (frame.error) throw acpRefuse('acp-protocol-mismatch', `acp seat ${role} refused session/new: ${frame.error.message}`)
    session.id = frame.result?.sessionId ?? null
    return session.id
  }

  function resumeSession(sessionId) {
    const frame = request('session/resume', { sessionId })
    if (frame.error) throw acpRefuse('acp-protocol-mismatch', `acp seat ${role} refused session/resume: ${frame.error.message}`)
    session.id = sessionId
    session.cancelled = false
    return session.id
  }

  function setMode(modeId) {
    const frame = request('session/set_mode', { sessionId: session.id, modeId })
    if (frame.error) throw acpRefuse('acp-protocol-mismatch', `acp seat ${role} refused session/set_mode: ${frame.error.message}`)
    return frame.result ?? null
  }

  function prompt(blocks) {
    if (session.cancelled) throw acpRefuse('acp-session-cancelled', `acp session ${session.id} was cancelled and accepts no further prompt`)
    const frame = request('session/prompt', { sessionId: session.id, prompt: blocks })
    if (frame.error) {
      const refusal = { code: frame.error.code ?? null, message: frame.error.message ?? null, errorKind: frame.error?.data?.errorKind ?? null }
      log({ at: now(), acp_turn_refused: { role, ...refusal } })
      return { stopReason: null, usage: null, refusal }
    }
    const stopReason = typeof frame.result?.stopReason === 'string' ? frame.result.stopReason : null
    if (stopReason === 'cancelled') session.cancelled = true
    return { stopReason, usage: turnUsage(frame.result), refusal: null }
  }

  function cancel() {
    session.cancelled = true
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.id } })
  }

  function proveDead() {
    const exitProof = () => exists(paths.exit)
    if (exitProof()) return { liveness: LIVENESS.DEAD, reason: 'exit-marker' }
    const pgid = Number(child?.pid)
    if (!Number.isSafeInteger(pgid) || pgid <= 1) return { liveness: LIVENESS.UNKNOWN, reason: 'invalid-pgid' }
    try { kill(-pgid, 'SIGTERM') } catch {}
    const deadline = now() + 5000
    while (now() < deadline) {
      if (exitProof()) return { liveness: LIVENESS.DEAD, reason: 'exit-marker' }
      sleep(ACP_POLL_MS)
    }
    try { kill(-pgid, 'SIGKILL') } catch (err) { if (err?.code === 'ESRCH') return { liveness: LIVENESS.DEAD, reason: 'signal-esrch' } }
    if (exitProof()) return { liveness: LIVENESS.DEAD, reason: 'exit-marker' }
    return { liveness: store.probeEvidence({ kind: EVIDENCE_KINDS.PGID, file: paths.pgid }), reason: 'probe' }
  }

  function close() {
    if (closed) return closeResult
    closed = true
    try { if (fd != null) closeFd(fd) } catch {}
    const proof = proveDead()
    if (proof.liveness === LIVENESS.DEAD && handle) { try { store.clear(handle) } catch {} }
    const result = { outcome: teardownOutcome(proof.liveness), reason: proof.reason }
    closeResult = result
    log({ at: now(), acp_teardown: { role, ...result } })
    return result
  }

  return { start, initialize, newSession, resumeSession, setMode, prompt, cancel, close, get sessionId() { return session.id } }
}
