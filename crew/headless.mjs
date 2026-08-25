// Synchronous headless-json transport. A detached shell records the worker's
// output and exit status on disk so driveTask can poll without an event loop.
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  unlinkSync as fsUnlinkSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn as cpSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { assignmentLine } from './driver.mjs'
import { headlessCommand as defaultHeadlessCommand } from './adapters/adapter-claude.mjs'
import { reclaimStore, PHASES, VERDICTS, EVIDENCE_KINDS, LIVENESS } from './reclaim.mjs'
import { readJsonTri } from './json-leaf.mjs'

export const WAIT_POLL_MS = 5000
const KILL_GRACE_MS = 10_000

// The provider conditions this transport can RECOGNISE in bytes it ALREADY
// captured. Evidence about a run, never a verdict on one: nothing in the crew
// branches on the result (#373 owns the pane half and will reuse this). Ordered
// — first match wins — and a DATA table, so a new condition is a data edit.
export const PROVIDER_CONDITIONS = Object.freeze([
  { condition: 'overloaded', pattern: /overloaded_error|\boverloaded\b/i },
  { condition: 'rate-limit', pattern: /rate_limit_error|\brate limit\b/i },
  { condition: 'auth', pattern: /authentication_error|invalid api key|\bunauthorized\b/i },
])

// The refusal vocabulary is DATA, so adding a member is a data edit rather
// than a new branch. Order is load-bearing: the first match wins.
export const SEAT_REFUSALS = Object.freeze([
  { member: 'overflowed', pattern: /context_length_exceeded|prompt is too long|exceeds the context window/i },
  { member: 'quota', pattern: /\b(?:session|weekly) limit\b|usage limit (?:has been )?reached/i },
  { member: 'rejected', pattern: /is not supported on this model|is not supported when using|invalid_request_error|no api key for provider|model not found|safeguards flagged/i },
  { member: 'suspended', pattern: /computer went to sleep/i },
  { member: 'transient', pattern: /overloaded_error|\boverloaded\b|rate_limit_error|\brate limit\b|connection closed|websocket|internal server error|\bterminated\b|fetch failed/i },
])

// A frame no pattern matched is not a frame that warrants no action: "we could
// not classify it" and "nothing is warranted" are different conclusions. The
// unclassified case is a strictly WEAKER signal than `rejected`, whose one
// identical re-send #567 already ratified — so it earns the same action, gated
// on the one thing that distinguishes a stalled seat from a working one:
// SILENCE. `silenceReaskDecision` (crew/seat-io.mjs) owns that gate.
export const UNCLASSIFIED_REFUSAL = 'unclassified'

// What the DRIVER may do about each member, and a data map for the same reason
// the vocabulary is one: a policy change is a data edit, not a new branch.
export const SEAT_REFUSAL_ACTIONS = Object.freeze({
  rejected: 'reprompt',   // one identical re-send, then end named (#567, b177 vs b175)
  quota: 'end',           // the frame states the reset; re-prompting cannot help
  transient: 'journal',   // self-heals; let the budget ride
  suspended: 'journal',   // the host slept; the seat is not at fault
  overflowed: 'journal',  // n=0 in 219 lanes — a first occurrence is itself the news
  [UNCLASSIFIED_REFUSAL]: 'reprompt-on-silence',   // verbatim: mutation G1
})

// The SAME CSI pattern scripts/factory/make-brief.mjs:53 carries, re-inlined
// rather than imported across the factory boundary — the precedent is
// scripts/factory/probe-repo.mjs:498. A worker colourises inside the phrase
// ("rate\x1b[0m limit"), which a raw-byte matcher cannot see at all.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g

export function recogniseProviderCondition(text) {
  if (typeof text !== 'string' || !text) return null
  const plain = text.replace(ANSI_CSI, '')
  for (const { condition, pattern } of PROVIDER_CONDITIONS) if (pattern.test(plain)) return condition
  return null
}

export function recogniseSeatRefusal(text) {
  if (typeof text !== 'string' || !text) return null
  const plain = text.replace(ANSI_CSI, '')
  for (const { member, pattern } of SEAT_REFUSALS) if (pattern.test(plain)) return member
  return null
}

// ONLY the stderr the wrapper already redirected (:238). One read on the
// failure path: no new capture, no poll, no timer. A missing, empty or
// unreadable file is an ABSENCE — it never fabricates a condition, and it
// never fabricates the absence of one either (the caller attaches nothing).
function capturedCondition(run, read, exists) {
  const path = run && run.stderr
  if (!path || !exists(path)) return null
  try { return recogniseProviderCondition(String(read(path, 'utf8'))) } catch { return null }
}

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

// An UNREADABLE envelope is not an ABSENT one. crew/seat-io.mjs:1369
// readEnvelopeFile already states the rule and is the reference implementation;
// this cannot CALL it, because the import direction is seat-io ->
// headless-rpc -> headless (the writeCrewJson rationale at :215), so the shape
// is mirrored here ONCE and headless-rpc imports it rather than growing a
// second copy. `stage` is the caller's own so cellFailureKind
// (crew/seat-io.mjs:1059) maps it onto the EXISTING 'unusable-envelope' kind:
// no new vocabulary, and no repair of the seat's own file.
export function readEnvelopeOrThrow(path, { existsSync, readFileSync, stage, role = null }) {
  if (!path || !existsSync(path)) return null
  let raw
  // A read that loses a race with a rename, or that comes back denied, is an
  // ABSENCE and not a defect: the next poll sees the file. Only bytes we
  // actually read and cannot parse are terminal.
  try { raw = String(readFileSync(path, 'utf8')) } catch { return null }
  let value
  try { value = JSON.parse(raw) } catch (err) {
    const parseFailure = new Error(`unusable envelope at ${path}: the file EXISTED (${raw.length} bytes) and is not JSON this driver can read: ${err.message}`)
    parseFailure.stage = stage
    if (role) parseFailure.role = role
    parseFailure.raw = raw   // reading is not authoring: the exact bytes travel with
    // the failure so a re-ask can tell "not re-emitted yet" from "re-emitted and
    // still broken", and nothing ever writes them back.
    throw parseFailure
  }
  return value && typeof value === 'object' ? value : null
}

function adapterFor(adapters, role) {
  const entry = adapters?.[role]
  return entry?.adapter || entry || null
}

function workerCommand(adapter, spec) {
  const fn = adapter?.headlessCommand || defaultHeadlessCommand
  return fn.call(adapter, spec)
}

// ONE durability contract for crew.json (#539, phase 2 of #546). Three
// modules write this file and every reader parses it with no retry
// (crew/crew.mjs:315 loadCrew, crew/daemon.mjs:1083), so a plain writeFileSync
// publishes an O_TRUNC window the whole runtime can fall into — measured at
// 2084 torn reads in 68156 (docs/audits/2026-08-23/hunt/h1/repro/r6-*.mjs).
// The owner lives HERE, not in seat-io.mjs, because the import direction is
// seat-io -> headless-rpc -> headless: this module is the only one of the
// three writers the other two already import, and inverting that edge is a
// cycle. seat-io.mjs's saveCrew stays exported (crew/crew.mjs boots with it)
// and delegates.
export const CREW_JSON_LOCK = 'crew-json'
export const CREW_JSON_LOCK_DIR = '.crewjson-lock'

export function crewJsonPath(paths) {
  return paths?.dir ? join(paths.dir, 'crew.json') : null
}

function parseCrewJson(readFileSync, path) {
  try {
    const value = JSON.parse(String(readFileSync(path, 'utf8')))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}

// The ONLY code path that publishes crew.json bytes: a uniquely named sibling
// temp (a fixed `.tmp` name is itself a collision two writers can tear, the
// `<name>.json.tmp.<uuid>` convention is crew/reclaim.mjs:166) followed by
// renameSync, an atomic replace on POSIX — no reader can observe the file
// absent or half-written.
export function writeCrewJson(paths, crew, deps = {}) {
  const writeFileSync = deps.writeFileSync || fsWriteFileSync
  const renameSync = deps.renameSync || fsRenameSync
  const unlinkSync = deps.unlinkSync || fsUnlinkSync
  const uuid = deps.uuid || randomUUID
  const p = crewJsonPath(paths)
  if (!p) throw new Error('writeCrewJson: no crew directory')
  const tmp = `${p}.tmp.${uuid()}`
  try {
    writeFileSync(tmp, JSON.stringify(crew, null, 2))
    renameSync(tmp, p)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* nothing staged */ }
    throw err
  }
  return p
}

// Locked read-modify-write, the posture scripts/factory/emit.mjs:875-902
// already uses. Every writer used to republish a whole private in-memory copy,
// so a seat minting a session id erased the driver's reseat with no race at
// all. `mutate` receives the CURRENT on-disk crew and returns false to publish
// nothing. Fails CLOSED: an absent or unparseable file is never overwritten,
// and the reason is returned rather than swallowed. The lock is
// crew/reclaim.mjs's own fenced, link-exclusive, dead-owner-aware one — a
// third implementation of a lock in this tree is not the fix.
export function updateCrewJson(paths, mutate, deps = {}) {
  const existsSync = deps.existsSync || fsExistsSync
  const readFileSync = deps.readFileSync || fsReadFileSync
  const p = crewJsonPath(paths)
  if (!p) return { ok: false, reason: 'no-dir' }
  if (!existsSync(p)) return { ok: false, reason: 'absent' }
  let store
  try {
    store = reclaimStore({ dir: join(paths.dir, CREW_JSON_LOCK_DIR), actor: `crew-json:${deps.pid ?? process.pid}`, deps, _lockOnly: true })
  } catch (err) {
    return { ok: false, reason: 'lock-unavailable', error: String(err?.message ?? err) }
  }
  try {
    return store.withLock(CREW_JSON_LOCK, () => {
      const draft = parseCrewJson(readFileSync, p)
      if (!draft) return { ok: false, reason: 'unreadable' }
      if (mutate(draft) === false) return { ok: true, changed: false, crew: draft }
      writeCrewJson(paths, draft, deps)
      return { ok: true, changed: true, crew: draft }
    })
  } catch (err) {
    const reason = err?.stage === 'reclaim-lock-unavailable' ? 'lock-unavailable' : 'write-failed'
    return { ok: false, reason, error: String(err?.message ?? err) }
  }
}

function persistCrew(paths, role, patch, deps) {
  // Session ids are useful after a supervisor restart. Test doubles commonly
  // omit a real crew.json, so an absent file stays a silent no-op — but this
  // seat owns only its OWN member fields, so it re-reads under the lock and
  // applies THIS delta instead of republishing a private whole-file copy.
  return updateCrewJson(paths, (disk) => {
    const member = disk?.members?.[role]
    if (!member) return false
    Object.assign(member, patch)
    return true
  }, deps)
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
  const rename = deps.renameSync || fsRenameSync
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal))
  const uuid = deps.uuid || randomUUID
  const pid = deps.pid ?? process.pid
  const root = join(taskDir || paths.taskDir, 'headless')
  const store = reclaimStore({ dir: root, actor: `headless:${pid}`, deps })
  const runs = new Map()

  const crewDeps = { existsSync: exists, readFileSync: read, writeFileSync: write, renameSync: rename, unlinkSync: unlink, mkdirSync: mkdir, readdirSync: readdir, uuid, now, sleep, pid }
  // Best-effort is not silent: a persist that FAILS is journalled, so the
  // operator can see that crew.json no longer matches this supervisor.
  function notePersist(role, result) {
    if (result?.ok || result?.reason === 'absent' || result?.reason === 'no-dir') return
    log({ at: now(), event: 'crew-json-persist-failed', role, reason: result?.reason ?? 'unknown', error: result?.error ?? null })
  }

  function activePath(role) { return join(root, `.${role}.active.json`) }
  function readState(path) { return readJsonTri(path, { existsSync: exists, readFileSync: read }) ?? null }
  function activeRun(role) { return readState(activePath(role)) }
  function readEnvelope(returnPath, role) { return readEnvelopeOrThrow(returnPath, { existsSync: exists, readFileSync: read, stage: 'headless-parse-error', role }) }
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
    err.stage = `headless-${outcome}`; err.role = run.role
    const condition = capturedCondition(run, read, exists)
    if (condition) err.providerCondition = condition
    return err
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
      notePersist(role, persistCrew(paths, role, { session_id: sessionId }, crewDeps))
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
    notePersist(role, persistCrew(paths, role, { started: true }, crewDeps))
    const run = { role, id, model: member.model ?? null, sessionId, pid: child.pid, reservation_id: handle.reservation_id, dir, stream, stderr, exit, cmdPath, returnPath, startedAt: now() }
    runs.set(returnPath, run)
    log({ at: now(), event: 'headless-spawn', role, id, pid: child.pid, dir, returnPath })
    return { id, returnPath }
  }
  // An unreadable envelope is TERMINAL, and it leaves this transport the way
  // every other terminal outcome does: the outcome journalled and the spend
  // emitted before the failure travels. Nothing here rewrites the seat's file.
  function readEnvelopeOrFail(run) {
    try { return readEnvelope(run.returnPath, run.role) }
    catch (err) {
      const exitCode = parseExit(run.exit, read, exists)
      const stream = parseStream(run.stream, read, exists)
      recordOutcome(run, 'parse-error', stream, exitCode)
      emitUsage(run, stream.usage)
      const condition = capturedCondition(run, read, exists)
      if (condition) err.providerCondition = condition
      throw err
    }
  }
  function wait(returnPath, timeoutS) {
    const run = runs.get(returnPath) || { role: 'unknown', returnPath, stream: '', exit: '' }
    const deadline = now() + Number(timeoutS) * 1000
    while (now() < deadline) {
      const env = readEnvelopeOrFail(run)
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
    const raced = readEnvelopeOrFail(run)
    if (raced) { const stream = parseStream(run.stream, read, exists); const exitCode = parseExit(run.exit, read, exists); const outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: raced, timedOut: false }); recordOutcome(run, outcome, stream, exitCode); emitUsage(run, stream.usage); return raced }
    const exitCode = parseExit(run.exit, read, exists), stream = parseStream(run.stream, read, exists), outcome = classifyRun({ exitCode, signal: null, terminal: stream.terminal, sawJson: stream.sawJson, envelope: null, timedOut: true })
    recordOutcome(run, outcome, stream, exitCode); emitUsage(run, stream.usage); throw outcomeError(run, outcome)
  }
  return { assign, wait }
}
