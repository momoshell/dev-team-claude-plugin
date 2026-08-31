import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync, unlinkSync as fsUnlinkSync, mkdirSync as fsMkdirSync, readdirSync as fsReaddirSync, renameSync as fsRenameSync, linkSync as fsLinkSync } from 'node:fs'
import { join } from 'node:path'
import { cpus as osCpus } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { readJsonAt, readJsonTri, JSON_STATES } from './json-leaf.mjs'

export const PHASES = { RESERVED: 'reserved', SPAWNING: 'spawning', RUNNING: 'running' }
export const VERDICTS = { FREE: 'free', RECLAIMABLE: 'reclaimable', BUSY: 'busy', UNRESOLVABLE: 'unresolvable' }
export const EVIDENCE_KINDS = { PGID: 'pgid', SUCCESSOR: 'successor' }
export const LEASE_PHASES = { HELD: 'held', TRANSFERRED: 'transferred' }
export const SUCCESSOR_STATES = { ABSENT: 'absent', ACTIVE: 'active', RESUMED: 'resumed', ABANDONED: 'abandoned', MISMATCH: 'mismatch', UNKNOWN: 'unknown' }
export const PARK_STATES = Object.freeze(['parked', 'claimed', 'resumed', 'abandoned'])
export const LAUNCH_STATES = Object.freeze([null, 'pending', 'enqueued'])
export const CONFLICT_REASONS = Object.freeze(['answer-conflict', 'successor-conflict', 'decision-mismatch', 'no-answer', 'park-settled', 'seat-busy', 'enqueue-unresolved', 'unresolvable'])
export const LIVENESS = { ALIVE: 'alive', DEAD: 'dead', UNKNOWN: 'unknown' }
export const LOCK_ATTEMPTS = 20
export const LOCK_INTERVAL_MS = 50

const digest = (value) => createHash('sha256').update(String(value)).digest('hex')
const defaultSleep = (ms) => {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

export function markerLockName(key) {
  return digest(JSON.stringify(['marker', key])).slice(0, 32)
}

export function leaseKey(role, sessionId) {
  return digest(JSON.stringify(['lease', role, sessionId])).slice(0, 32)
}

export function parkLockName(park_id) {
  return digest(JSON.stringify(['park', park_id])).slice(0, 32)
}

function leaseLockName(key) {
  return digest(JSON.stringify(['lease-lock', key])).slice(0, 32)
}

function normalDeps(deps) {
  return {
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    writeFileSync: deps.writeFileSync || fsWriteFileSync,
    unlinkSync: deps.unlinkSync || fsUnlinkSync,
    mkdirSync: deps.mkdirSync || fsMkdirSync,
    readdirSync: deps.readdirSync || fsReaddirSync,
    renameSync: deps.renameSync || fsRenameSync,
    linkSync: deps.linkSync || fsLinkSync,
    kill: deps.kill || ((pid, signal) => process.kill(pid, signal)),
    now: deps.now || (() => Date.now()),
    uuid: deps.uuid || randomUUID,
    sleep: deps.sleep || defaultSleep,
    pid: deps.pid ?? process.pid,
  }
}

function appendLine(path, record, d) {
  d.writeFileSync(path, `\n${JSON.stringify(record)}\n`, { flag: 'a' })
}

function readOverrides(path, d) {
  if (!d.existsSync(path)) return []
  let text
  try { text = d.readFileSync(path, 'utf8') } catch { return [] }
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* torn or corrupt records are inert */ }
  }
  return out
}

function validAttestation(a) {
  return a && a.quiesced === true && typeof a.method === 'string' && a.method.trim() !== ''
}

function ownerState(owner, d) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return LIVENESS.UNKNOWN
  // This function USED to short-circuit `owner.pid === d.pid` to ALIVE. That
  // was dropped when the lease surface landed, and the drop is deliberate —
  // acknowledged here rather than left silent, because this is shared
  // lock/marker code the lease work did not otherwise touch.
  //
  // Production behaviour is unchanged: `process.kill(self, 0)` always
  // succeeds, so the probe returns ALIVE for our own pid with or without the
  // shortcut (verified, not assumed). It differs only under an injected
  // `kill` that reports our own process dead — which is exactly how the
  // crash-recovery fixtures simulate a supervisor that died holding a lease.
  // Restoring the shortcut makes that simulation impossible and breaks the
  // D14 terminal-only lease test, so the probe stays authoritative.
  try { d.kill(owner.pid, 0); return LIVENESS.ALIVE } catch (err) {
    return err?.code === 'ESRCH' ? LIVENESS.DEAD : LIVENESS.ALIVE
  }
}

function nonblank(v) {
  return typeof v === 'string' && v.trim() !== ''
}

function safeId(v) {
  return nonblank(v) && !v.includes('/') && !v.includes('\\') && !v.includes('\0') && v !== '.' && v !== '..'
}

function finiteNow(now) {
  let value
  try { value = now() } catch (cause) {
    const err = Error('invalid reclaim clock', { cause })
    err.stage = 'reclaim-clock-invalid'
    throw err
  }
  if (!Number.isFinite(value)) {
    const err = Error('invalid reclaim clock')
    err.stage = 'reclaim-clock-invalid'
    throw err
  }
  return value
}

function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  const top = Object.keys(spec).sort()
  if (top.join('\0') !== ['decision', 'resumes_park_id', 'run_id'].join('\0')) return null
  const decision = spec.decision
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null
  const decisionKeys = Object.keys(decision).sort()
  if (decisionKeys.join('\0') !== ['actor', 'answer', 'decision_id'].join('\0')) return null
  if (![spec.run_id, spec.resumes_park_id, decision.decision_id, decision.actor, decision.answer].every(nonblank)) return null
  return {
    run_id: spec.run_id,
    resumes_park_id: spec.resumes_park_id,
    decision: {
      decision_id: decision.decision_id,
      actor: decision.actor,
      answer: decision.answer,
    },
  }
}

function successorLiveness(state) {
  if (state === SUCCESSOR_STATES.ACTIVE) return LIVENESS.ALIVE
  if (state === SUCCESSOR_STATES.RESUMED || state === SUCCESSOR_STATES.ABANDONED) return LIVENESS.DEAD
  return LIVENESS.UNKNOWN
}

function leaseSetKeysEqual(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return false
  if (new Set(expected).size !== expected.length || new Set(actual).size !== actual.length) return false
  if (expected.length !== actual.length) return false
  const actualSet = new Set(actual)
  return expected.every((key) => actualSet.has(key))
}

export function reclaimStore({ dir, actor, probes = {}, evidencePolicies = {}, deps = {}, _lockOnly = false, _staleCorruptLock = false }) {
  const d = normalDeps(deps)
  const lockDir = join(dir, 'locks')
  const overridePath = join(dir, 'overrides.jsonl')
  // The store directory is initialized once so lock and marker creation can be
  // exclusive; headless allocation still creates each run directory separately.
  d.mkdirSync(dir, { recursive: true })
  d.mkdirSync(lockDir, { recursive: true })
  const leasesDir = join(dir, 'leases')
  const parksDir = join(dir, 'parks')

  // A record file is `<key>.json`. Everything else in these directories is
  // scratch: writeReplace/advance stage `<key>.json.tmp.<uuid>` beside the
  // record, and a crashed writer leaves one behind. Scratch is SKIPPED, never
  // reported — reporting it as corrupt wedges settlement forever, because the
  // post-release scan keeps seeing a lease that is not a lease. A `.json`
  // whose contents will not parse is still reported corrupt: a real record
  // that cannot be read must never be silently omitted.
  const isRecordName = (name) => name.endsWith('.json') && !name.includes('.json.tmp.')
  const recordNames = (path) => {
    try { return d.readdirSync(path).sort().filter(isRecordName) } catch { return [] }
  }

  function lockPath(name, fence) { return join(lockDir, `${name}.lock.${fence}`) }
  function epochs(name) {
    let names
    try { names = d.readdirSync(lockDir) } catch { return [] }
    const prefix = `${name}.lock.`
    return names.filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
      .map((n) => Number(n.slice(prefix.length))).filter(Number.isSafeInteger).sort((a, b) => a - b)
  }
  function current(name) {
    const ns = epochs(name)
    if (!ns.length) return null
    const fence = ns[ns.length - 1]
    const path = lockPath(name, fence)
    let raw
    try { raw = d.readFileSync(path, 'utf8') } catch { return { fence, path, raw: null, record: null } }
    let record = null
    try { record = JSON.parse(raw) } catch { /* corrupt maximum */ }
    return { fence, path, raw: String(raw), record }
  }
  function matchingLockOverride(name, cur) {
    if (!cur) return false
    return readOverrides(overridePath, d).some((r) => {
      if (r?.kind !== 'lock' || r.name !== name || !validAttestation(r.attestation)) return false
      if (r.fence !== cur.fence || !r.identity) return false
      if (r.identity.kind === 'token') return cur.record?.token === r.identity.value
      return r.identity.kind === 'digest' && cur.raw != null && digest(cur.raw) === r.identity.value
    })
  }
  function ownerForLock(cur) {
    return cur?.record ? ownerState(cur.record.owner, d) : LIVENESS.UNKNOWN
  }
  // The shape of the record acquire() writes for itself below. A parsed value
  // that is not this shape is DAMAGED, not a lock: `{}`, `[]`, `1` and a row
  // missing its token or owner all parse into a truthy `cur.record`, and asking
  // ownerForLock about one yields LIVENESS.UNKNOWN — never DEAD — so the default
  // path retries such an epoch to contention forever.
  function validLockRecord(cur) {
    const record = cur?.record
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false
    if (record.fence !== cur.fence || !nonblank(record.token)) return false
    const owner = record.owner
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.startedAt)) return false
    return typeof record.released === 'boolean'
  }
  function releaseEpoch(handle) {
    if (!handle?.name) return false
    const cur = current(handle.name)
    if (!cur || cur.fence !== handle.fence || cur.record?.token !== handle.token) return false
    let value
    try { value = { ...cur.record, released: true } } catch { return false }
    const tmp = `${cur.path}.tmp.${d.uuid()}`
    try {
      d.writeFileSync(tmp, JSON.stringify(value))
      d.renameSync(tmp, cur.path)
      return true
    } catch {
      try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {}
      return false
    }
  }
  function releaseHistorical(handle) {
    if (!handle?.name) return false
    const path = lockPath(handle.name, handle.fence)
    let raw, record
    try { raw = String(d.readFileSync(path, 'utf8')); record = JSON.parse(raw) } catch { return false }
    if (record?.token !== handle.token || record.released === true) return false
    const tmp = `${path}.tmp.${d.uuid()}`
    try {
      d.writeFileSync(tmp, JSON.stringify({ ...record, released: true }))
      d.renameSync(tmp, path)
      return true
    } catch {
      try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {}
      return false
    }
  }
  function acquire(name) {
    let attempts = 0
    while (attempts < LOCK_ATTEMPTS) {
      const cur = current(name)
      const overridden = matchingLockOverride(name, cur)
      if (cur && !overridden) {
        // The opt-in stale case is BYTES WERE READ *and* the parsed value is not
        // a valid epoch record. Both halves are load-bearing.
        //
        // `cur.raw !== null` fails closed on a read failure: current() collapses
        // "could not read the bytes" and "read them but they would not parse"
        // into the same `record: null` (crew/reclaim.mjs:186-196), and an
        // EIO/EACCES over a possibly LIVE lock is no evidence its bytes are
        // damaged — stealing it would put two callbacks in one critical section.
        //
        // `!validLockRecord(cur)` is what catches PARSEABLE damage, which a bare
        // truthiness test misses entirely and which the default path turns into a
        // permanent wedge rather than a refusal.
        //
        // The option stays private and default-off. For markers, leases and parks
        // a damaged lock is repaired by an ATTESTED override
        // (crew/reclaim.test.mjs:106); only the slot pool opts out, because there
        // one lock stands in front of K slots (docs/conventions.md:64).
        const staleCorrupt = _staleCorruptLock && cur.raw !== null && !validLockRecord(cur)
        if (!staleCorrupt) {
          if (!cur.record) return { ok: false, reason: 'unresolvable', attempts }
          if (cur.record.released !== true && ownerForLock(cur) !== LIVENESS.DEAD) {
            attempts += 1
            if (attempts >= LOCK_ATTEMPTS) return { ok: false, reason: 'contended', attempts }
            d.sleep(LOCK_INTERVAL_MS)
            continue
          }
        }
      }
      const fence = (cur?.fence || 0) + 1
      const token = d.uuid()
      const record = { fence, token, owner: { pid: d.pid, startedAt: d.now() }, actor, at: d.now(), released: false }
      const tmp = join(lockDir, `.${name}.${token}.tmp`)
      try {
        d.writeFileSync(tmp, JSON.stringify(record))
        d.linkSync(tmp, lockPath(name, fence))
      } catch (err) {
        try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {}
        if (err?.code === 'EEXIST') {
          attempts += 1
          if (attempts >= LOCK_ATTEMPTS) return { ok: false, reason: 'contended', attempts }
          d.sleep(LOCK_INTERVAL_MS)
          continue
        }
        if (['EXDEV', 'EPERM', 'ENOTSUP'].includes(err?.code)) return { ok: false, reason: 'unresolvable', attempts }
        throw err
      } finally { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} }
      const after = current(name)
      if (after?.fence > fence) {
        releaseHistorical({ name, fence, token })
        return { ok: false, reason: 'lost', attempts }
      }
      if (after?.fence === fence && after.record?.token === token) return { ok: true, handle: { name, fence, token }, attempts }
      if (after?.fence === fence) return { ok: false, reason: 'unresolvable', attempts }
      return { ok: false, reason: 'lost', attempts }
    }
    return { ok: false, reason: 'contended', attempts }
  }
  function checkFence(handle) {
    if (!handle?.name) return false
    const cur = current(handle.name)
    return !!(cur && cur.fence === handle.fence && cur.record?.token === handle.token && cur.record.released !== true && !matchingLockOverride(handle.name, cur))
  }
  function release(handle) { return releaseEpoch(handle) }
  function withLock(name, fn) {
    const result = acquire(name)
    if (!result.ok) {
      const err = new Error(`reclaim lock unavailable: ${name}`)
      err.stage = 'reclaim-lock-unavailable'
      err.reason = result.reason
      throw err
    }
    try { return fn(result.handle) } finally { release(result.handle) }
  }
  function overrideLock(name, input = {}) {
    const cur = current(name)
    if (!input.actor || !input.reason || !validAttestation(input.attestation)) throw new Error('invalid lock override attestation')
    if (!cur || cur.fence !== input.fence) throw new Error('lock override fence mismatch')
    const identity = input.token != null ? { kind: 'token', value: input.token } : input.digest != null ? { kind: 'digest', value: input.digest } : null
    if (!identity || (identity.kind === 'token' && cur.record?.token !== identity.value) || (identity.kind === 'digest' && (cur.raw == null || digest(cur.raw) !== identity.value))) throw new Error('lock override identity mismatch')
    appendLine(overridePath, { at: d.now(), actor: input.actor, reason: input.reason, kind: 'lock', name, fence: cur.fence, identity, attestation: input.attestation }, d)
  }

  // AFTER the _lockOnly return, deliberately: reservationEngine builds an
  // internal lock-only store for every reclaim root, and creating leases/ and
  // parks/ there would plant two directories inside headless/ and
  // headless-rpc/, whose allocateRun and nextAssignmentId enumerate the root.
  // Harmless today, but a lock-only store has no records and must not shape
  // another consumer's on-disk layout.
  if (_lockOnly) return { acquire, release, checkFence, withLock, overrideLock }

  d.mkdirSync(leasesDir, { recursive: true })
  d.mkdirSync(parksDir, { recursive: true })

  const clock = () => finiteNow(d.now)
  const stamp = () => clock()
  const probeSuccessor = (successorState, spec) => {
    if (typeof successorState !== 'function') return SUCCESSOR_STATES.UNKNOWN
    try {
      const value = successorState(spec)
      return Object.values(SUCCESSOR_STATES).includes(value) ? value : SUCCESSOR_STATES.UNKNOWN
    } catch { return SUCCESSOR_STATES.UNKNOWN }
  }
  const orderSeats = (seats, order = []) => {
    const rank = new Map((Array.isArray(order) ? order : []).map((role, index) => [role, index]))
    return [...seats].sort((a, b) => {
      const ar = rank.has(a.role) ? rank.get(a.role) : Infinity
      const br = rank.has(b.role) ? rank.get(b.role) : Infinity
      return ar - br || String(a.role).localeCompare(String(b.role)) || String(a.sessionId).localeCompare(String(b.sessionId))
    })
  }
  const frozenSpec = (park) => {
    const spec = normalizeSpec(park?.spec)
    if (!spec) return null
    return Object.freeze({
      run_id: spec.run_id,
      resumes_park_id: spec.resumes_park_id,
      decision: Object.freeze({ ...spec.decision }),
    })
  }
  const leasePath = (key) => join(leasesDir, `${key}.json`)
  const parkPath = (id) => join(parksDir, `${id}.json`)
  const readJson = (path) => readJsonTri(path, d)
  const writeExclusive = (path, value) => {
    const tmp = `${path}.tmp.${d.uuid()}`
    try {
      d.writeFileSync(tmp, JSON.stringify(value))
      d.linkSync(tmp, path)
    } finally {
      try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {}
    }
  }
  const writeReplace = (path, value) => {
    const tmp = `${path}.tmp.${d.uuid()}`
    try {
      d.writeFileSync(tmp, JSON.stringify(value))
      d.renameSync(tmp, path)
      return true
    } finally {
      try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {}
    }
  }
  const seatsNormalized = (seats) => Array.isArray(seats) && seats.length > 0 && seats.every((seat) => seat && typeof seat === 'object' && !Array.isArray(seat) && nonblank(seat.role) && nonblank(seat.sessionId))
  const seatKeySet = (seats) => new Set(seats.map((seat) => leaseKey(seat.role, seat.sessionId)))
  const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')

  const validateLeaseRecord = (record, seat, path) => {
    if (!exactKeys(record, ['reservation_id', 'key', 'phase', 'role', 'sessionId', 'spec', 'owner', 'at'])) return { ok: false, reason: 'lease-record-invalid' }
    if (record.key !== leaseKey(seat.role, seat.sessionId) || path !== leasePath(record.key) || record.role !== seat.role || record.sessionId !== seat.sessionId) return { ok: false, reason: 'lease-record-invalid' }
    if (![LEASE_PHASES.HELD, LEASE_PHASES.TRANSFERRED].includes(record.phase) || !nonblank(record.reservation_id)) return { ok: false, reason: 'lease-record-invalid' }
    if (!exactKeys(record.owner, ['pid', 'startedAt']) || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 0 || !Number.isFinite(record.owner.startedAt) || !Number.isFinite(record.at)) return { ok: false, reason: 'lease-record-invalid' }
    const spec = normalizeSpec(record.spec)
    if (!spec) return { ok: false, reason: 'lease-record-invalid' }
    return { ok: true, spec }
  }

  const overrideLease = (role, sessionId, input = {}) => {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    if (!nonblank(role) || !nonblank(sessionId) || !nonblank(args.actor) || !nonblank(args.reason) || !validAttestation(args.attestation)) throw new Error('invalid lease override attestation')
    const key = leaseKey(role, sessionId)
    const path = leasePath(key)
    let raw
    try { raw = String(d.readFileSync(path, 'utf8')) } catch { throw new Error('lease override identity mismatch') }
    const identity = args.reservation_id != null ? { kind: 'reservation_id', value: args.reservation_id } : args.digest != null ? { kind: 'digest', value: args.digest } : null
    if (!identity || !nonblank(identity.value)) throw new Error('lease override identity mismatch')
    if (identity.kind === 'reservation_id') {
      let record
      try { record = JSON.parse(raw) } catch { record = null }
      if (record?.reservation_id !== identity.value) throw new Error('lease override identity mismatch')
    } else if (digest(raw) !== identity.value) throw new Error('lease override identity mismatch')
    appendLine(overridePath, { at: d.now(), actor: args.actor, reason: args.reason, kind: 'lease', key, identity, attestation: args.attestation }, d)
  }

  const leaseEngine = (successorState) => reservationEngine({
    dir,
    actor,
    pathFor: leasePath,
    lockNameFor: leaseLockName,
    phases: { allowed: [LEASE_PHASES.HELD, LEASE_PHASES.TRANSFERRED], preEffect: null },
    completionProof: () => false,
    evidencePolicy: (_key, marker) => {
      const spec = normalizeSpec(marker?.spec)
      return spec ? { kind: EVIDENCE_KINDS.SUCCESSOR, spec } : null
    },
    probes: {
      [EVIDENCE_KINDS.SUCCESSOR]: (evidence) => successorLiveness(probeSuccessor(successorState, evidence.spec)),
    },
    deps: { ...d, now: () => stamp() },
    lock: { withLock, checkFence },
    overrides: { kind: 'lease', attested: true },
  })

  const clearLease = (handle) => {
    if (!handle || !nonblank(handle.role) || !nonblank(handle.sessionId) || !nonblank(handle.reservation_id)) return false
    try {
      return leaseEngine(() => SUCCESSOR_STATES.UNKNOWN).clear({ key: leaseKey(handle.role, handle.sessionId), reservation_id: handle.reservation_id })
    } catch { return false }
  }

  const releaseLeases = (handles = []) => {
    const input = Array.isArray(handles) ? handles : []
    const released = []
    const remaining = []
    for (const handle of [...input].reverse()) {
      const seat = handle && { role: handle.role, sessionId: handle.sessionId }
      if (!seat || !nonblank(seat.role) || !nonblank(seat.sessionId) || !nonblank(handle.reservation_id)) {
        remaining.push(seat || handle)
        continue
      }
      try {
        if (clearLease(handle)) {
          released.push(seat)
        } else {
          const path = leasePath(leaseKey(seat.role, seat.sessionId))
          if (d.existsSync(path)) remaining.push(seat)
          else released.push(seat)
        }
      } catch { remaining.push(seat) }
    }
    return { ok: remaining.length === 0, released, remaining }
  }

  const reconcileLease = (role, sessionId, opts = {}) => {
    const options = opts && typeof opts === 'object' ? opts : {}
    return leaseEngine(options.successorState).reconcile(leaseKey(role, sessionId))
  }

  const acquireLeases = (seats, opts = {}) => {
    const options = opts && typeof opts === 'object' ? opts : {}
    const spec = normalizeSpec(options.spec)
    if (!seatsNormalized(seats) || seatKeySet(seats).size !== seats.length || (options.order !== undefined && !Array.isArray(options.order)) || typeof options.successorState !== 'function' || !spec) return { ok: false, reason: 'unresolvable' }
    try { finiteNow(d.now) } catch { return { ok: false, reason: 'unresolvable' } }
    const ordered = orderSeats(seats, options.order)
    const engine = leaseEngine(options.successorState)
    const held = []
    for (const seat of ordered) {
      const key = leaseKey(seat.role, seat.sessionId)
      let verdict
      try { verdict = engine.reconcile(key) } catch { verdict = { verdict: VERDICTS.UNRESOLVABLE } }
      let result
      if (verdict.verdict === VERDICTS.FREE) {
        try { result = engine.reserve(key, { phase: LEASE_PHASES.HELD, role: seat.role, sessionId: seat.sessionId, spec }) } catch { result = { ok: false, reason: 'unresolvable' } }
      } else if (verdict.verdict === VERDICTS.RECLAIMABLE) {
        try { engine.clear(verdict.handle) } catch {}
        try { result = engine.reserve(key, { phase: LEASE_PHASES.HELD, role: seat.role, sessionId: seat.sessionId, spec }) } catch { result = { ok: false, reason: 'unresolvable' } }
      } else {
        result = { ok: false, reason: verdict.verdict === VERDICTS.BUSY ? 'seat-busy' : 'unresolvable' }
      }
      if (!result?.ok) {
        const released = releaseLeases(held)
        // reserve() loses a race with its own vocabulary — 'busy' (EEXIST) or
        // 'contended' (lock attempts exhausted). Both mean another holder took
        // the seat, which is exactly 'seat-busy' and is RETRYABLE; leaking
        // them through would report a retryable race as the terminal
        // 'unresolvable', and neither is a member of the closed
        // CONFLICT_REASONS this surface promises callers is exhaustive.
        const raced = result.reason === 'busy' || result.reason === 'contended'
        const reason = released.ok ? (raced ? 'seat-busy' : result.reason) : 'unresolvable'
        const out = { ok: false, failedAt: { role: seat.role, sessionId: seat.sessionId }, reason }
        if (released.remaining.length) out.remaining = released.remaining
        return out
      }
      held.push({ reservation_id: result.handle.reservation_id, role: seat.role, sessionId: seat.sessionId })
    }
    return { ok: true, handles: held }
  }

  const activeLeases = () => {
    const names = recordNames(leasesDir)
    return names.map((name) => {
      const path = join(leasesDir, name)
      try {
        const value = readJson(path)
        return value === undefined || value === null ? { path, corrupt: true } : value
      } catch { return { path, corrupt: true } }
    })
  }

  const specResidue = (parkSpec) => activeLeases().some((record) => {
    if (record?.corrupt) return true
    const recordSpec = normalizeSpec(record?.spec)
    return !!(parkSpec && recordSpec && JSON.stringify(recordSpec) === JSON.stringify(parkSpec))
  })

  const validateParkRecord = (record, id) => {
    if (!exactKeys(record, ['park_id', 'run_id', 'state', 'launch_state', 'seats', 'leases', 'decision', 'spec', 'linked_at', 'reason', 'parked_at', 'updated_at'])) return false
    if (!safeId(record.park_id) || record.park_id !== id || !nonblank(record.run_id) || !PARK_STATES.includes(record.state) || !LAUNCH_STATES.includes(record.launch_state)) return false
    if (!seatsNormalized(record.seats) || record.seats.some((seat) => !exactKeys(seat, ['role', 'sessionId', 'warm']) || typeof seat.warm !== 'boolean') || seatKeySet(record.seats).size !== record.seats.length) return false
    if (!Array.isArray(record.leases) || record.leases.some((handle) => !exactKeys(handle, ['reservation_id', 'role', 'sessionId']) || !nonblank(handle.reservation_id) || !nonblank(handle.role) || !nonblank(handle.sessionId))) return false
    if (new Set(record.leases.map((handle) => leaseKey(handle.role, handle.sessionId))).size !== record.leases.length) return false
    if (!Number.isFinite(record.parked_at) || !Number.isFinite(record.updated_at) || !(record.linked_at === null || Number.isFinite(record.linked_at)) || typeof record.reason !== 'string') return false
    if (record.decision !== null && (!exactKeys(record.decision, ['decision_id', 'actor', 'at', 'answer']) || !nonblank(record.decision.decision_id) || !nonblank(record.decision.actor) || !nonblank(record.decision.answer) || !Number.isFinite(record.decision.at))) return false
    if (record.spec !== null && !normalizeSpec(record.spec)) return false
    if (record.state === 'parked' && (record.launch_state !== null || record.spec !== null || record.leases.length !== 0)) return false
    if (record.state === 'claimed' && (!['pending', 'enqueued'].includes(record.launch_state) || !record.decision || !record.spec)) return false
    if ((record.state === 'resumed' || record.state === 'abandoned') && (record.launch_state !== null || record.leases.length !== 0)) return false
    if (record.spec && normalizeSpec(record.spec).resumes_park_id !== record.park_id) return false
    if (record.spec && record.decision) {
      const expected = { decision_id: record.decision.decision_id, actor: record.decision.actor, answer: record.decision.answer }
      if (JSON.stringify(normalizeSpec(record.spec).decision) !== JSON.stringify(expected)) return false
    }
    return true
  }

  const readPark = (id) => {
    if (!safeId(id)) return null
    try {
      const value = readJson(parkPath(id))
      return value && validateParkRecord(value, id) ? value : null
    } catch { return null }
  }

  const listParks = () => {
    const names = recordNames(parksDir)
    return names.map((name) => {
      const path = join(parksDir, name)
      const id = name.slice(0, -5)
      try {
        const value = readJson(path)
        return value && validateParkRecord(value, id) ? value : { path, corrupt: true }
      } catch { return { path, corrupt: true } }
    })
  }

  const verifyLeaseSet = (park) => {
    if (!park || !Array.isArray(park.seats) || !Array.isArray(park.leases)) return { ok: false, reason: 'lease-set-mismatch' }
    const expected = park.seats.map((seat) => leaseKey(seat.role, seat.sessionId))
    const actual = park.leases.map((handle) => leaseKey(handle.role, handle.sessionId))
    if (!leaseSetKeysEqual(expected, actual)) return { ok: false, reason: 'lease-set-mismatch' }
    const records = []
    for (const handle of park.leases) {
      const path = leasePath(leaseKey(handle.role, handle.sessionId))
      let record
      try { record = readJson(path) } catch { record = undefined }
      if (!record || record.reservation_id !== handle.reservation_id) return { ok: false, reason: 'lease-set-id-mismatch' }
      const valid = validateLeaseRecord(record, { role: handle.role, sessionId: handle.sessionId }, path)
      if (!valid.ok) {
        return { ok: false, reason: normalizeSpec(record.spec) ? 'lease-set-id-mismatch' : 'lease-set-spec-mismatch' }
      }
      records.push(record)
    }
    const parkSpec = normalizeSpec(park.spec)
    if (!parkSpec || parkSpec.resumes_park_id !== park.park_id || !park.decision) return { ok: false, reason: 'lease-set-spec-mismatch' }
    const decision = { decision_id: park.decision.decision_id, actor: park.decision.actor, answer: park.decision.answer }
    if (JSON.stringify(parkSpec.decision) !== JSON.stringify(decision)) return { ok: false, reason: 'lease-set-spec-mismatch' }
    if (records.some((record) => JSON.stringify(normalizeSpec(record.spec)) !== JSON.stringify(parkSpec))) return { ok: false, reason: 'lease-set-spec-mismatch' }
    return { ok: true }
  }

  const transferLeases = (park, lockHandle) => {
    let transferred = 0
    try {
      if (!park || !Array.isArray(park.seats) || !Array.isArray(park.leases)) return { ok: false, reason: 'lease-lost' }
      const handles = orderSeats(park.seats).map((seat) => park.leases.find((handle) => leaseKey(handle.role, handle.sessionId) === leaseKey(seat.role, seat.sessionId)))
      for (const handle of handles) {
        if (!handle || !checkFence(lockHandle)) return { ok: false, reason: 'lease-lost' }
        const key = leaseKey(handle.role, handle.sessionId)
        const record = readJson(leasePath(key))
        if (!record || record.reservation_id !== handle.reservation_id) return { ok: false, reason: 'lease-lost' }
        if (record.phase === LEASE_PHASES.HELD) {
          try {
            leaseEngine(() => SUCCESSOR_STATES.UNKNOWN).advance({ key, reservation_id: handle.reservation_id }, LEASE_PHASES.TRANSFERRED)
          } catch { return { ok: false, reason: 'lease-lost' } }
          transferred += 1
        } else if (record.phase === LEASE_PHASES.TRANSFERRED) {
          transferred += 1
        } else return { ok: false, reason: 'lease-lost' }
      }
      return { ok: true, transferred }
    } catch { return { ok: false, reason: 'lease-lost' } }
  }

  const writePark = (id, value, lockHandle) => {
    if (!checkFence(lockHandle)) return false
    return writeReplace(parkPath(id), value)
  }

  const terminalRowValid = (park) => {
    if (!park || !['resumed', 'abandoned'].includes(park.state) || park.launch_state !== null || park.leases.length !== 0) return false
    for (const record of activeLeases()) {
      if (record?.corrupt) return false
      const spec = normalizeSpec(record?.spec)
      if (spec?.resumes_park_id === park.park_id) return false
    }
    return true
  }

  const mintPark = (input = {}) => {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const run_id = value.run_id
    const seats = value.seats
    const reason = value.reason === undefined ? '' : value.reason
    if (!nonblank(run_id) || typeof reason !== 'string' || !seatsNormalized(seats) || seatKeySet(seats).size !== seats.length) return { ok: false, reason: 'unresolvable' }
    let id
    try { id = d.uuid() } catch { return { ok: false, reason: 'unresolvable' } }
    if (!safeId(id)) return { ok: false, reason: 'unresolvable' }
    try {
      return withLock(parkLockName(id), (lockHandle) => {
        let at
        try { at = stamp() } catch { return { ok: false, reason: 'unresolvable' } }
        const park = {
          park_id: id,
          run_id,
          state: 'parked',
          launch_state: null,
          seats: seats.map((seat) => ({ role: seat.role, sessionId: seat.sessionId, warm: seat.warm === true })),
          leases: [],
          decision: null,
          spec: null,
          linked_at: null,
          reason,
          parked_at: at,
          updated_at: at,
        }
        try {
          if (!checkFence(lockHandle)) return { ok: false, reason: 'unresolvable' }
          writeExclusive(parkPath(id), park)
          return { ok: true, park }
        } catch { return { ok: false, reason: 'unresolvable' } }
      })
    } catch { return { ok: false, reason: 'unresolvable' } }
  }

  const recordAnswer = (id, input = {}) => {
    const answer = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    if (!safeId(id) || !nonblank(answer.decision_id) || !nonblank(answer.actor) || !nonblank(answer.answer)) return { ok: false, reason: 'unresolvable' }
    try {
      return withLock(parkLockName(id), (lockHandle) => {
        const park = readPark(id)
        if (!park || (park.decision === null && park.state !== 'parked')) return { ok: false, reason: 'unresolvable' }
        const payload = { decision_id: answer.decision_id, actor: answer.actor, answer: answer.answer }
        if (park.decision) {
          const existing = { decision_id: park.decision.decision_id, actor: park.decision.actor, answer: park.decision.answer }
          if (JSON.stringify(existing) === JSON.stringify(payload)) return { ok: true, park, existing: true }
          return { ok: false, reason: 'answer-conflict' }
        }
        const at = stamp()
        const next = { ...park, decision: { ...payload, at }, updated_at: at }
        if (!writePark(id, next, lockHandle)) return { ok: false, reason: 'unresolvable' }
        return { ok: true, park: next }
      })
    } catch { return { ok: false, reason: 'unresolvable' } }
  }

  const planRelease = (park) => {
    if (!park || !Array.isArray(park.seats) || !Array.isArray(park.leases)) return { ok: false, reason: 'lease-set-mismatch' }
    const expected = park.seats.map((seat) => leaseKey(seat.role, seat.sessionId))
    const actual = park.leases.map((handle) => leaseKey(handle.role, handle.sessionId))
    if (!leaseSetKeysEqual(expected, actual)) return { ok: false, reason: 'lease-set-mismatch' }
    const parkSpec = normalizeSpec(park.spec)
    if (!parkSpec) return { ok: false, reason: 'lease-set-spec-mismatch' }
    const release = []
    const foreign = []
    for (const seat of orderSeats(park.seats)) {
      const key = leaseKey(seat.role, seat.sessionId)
      const handle = park.leases.find((candidate) => leaseKey(candidate.role, candidate.sessionId) === key)
      if (!handle || !nonblank(handle.reservation_id)) return { ok: false, reason: 'lease-set-mismatch' }
      const path = leasePath(key)
      let present
      try { present = d.existsSync(path) } catch { return { ok: false, reason: 'lease-record-invalid' } }
      if (!present) continue
      let record
      try { record = readJson(path) } catch { record = undefined }
      const valid = record && validateLeaseRecord(record, seat, path)
      if (!valid?.ok) return { ok: false, reason: 'lease-record-invalid' }
      const sameSpec = JSON.stringify(valid.spec) === JSON.stringify(parkSpec)
      if (sameSpec) release.push({ reservation_id: record.reservation_id, role: seat.role, sessionId: seat.sessionId })
      else if (record.reservation_id === handle.reservation_id) return { ok: false, reason: 'lease-set-spec-mismatch' }
      else foreign.push({ role: seat.role, sessionId: seat.sessionId })
    }
    return { ok: true, release, foreign }
  }

  const rollbackPark = (park, lockHandle) => {
    try {
      const plan = planRelease(park)
      if (!plan.ok) return 'unresolvable'
      const released = releaseLeases(plan.release)
      if (!released.ok) return 'unresolvable'
      if (specResidue(normalizeSpec(park.spec))) return 'unresolvable'
      const next = { ...park, state: 'parked', launch_state: null, leases: [], spec: null, updated_at: stamp() }
      return writePark(park.park_id, next, lockHandle) ? 'restored' : 'unresolvable'
    } catch { return 'unresolvable' }
  }

  const settleRow = (park, state, lockHandle, onFailure = null) => {
    const fail = (reason = 'unresolvable') => {
      if (typeof onFailure === 'function') onFailure(reason)
      return 'unresolvable'
    }
    try {
      const plan = planRelease(park)
      if (!plan.ok) return fail()
      const released = releaseLeases(plan.release)
      if (!released.ok) return fail('lease-release-incomplete')
      if (specResidue(normalizeSpec(park.spec))) return fail('lease-release-incomplete')
      const linked_at = park.linked_at === null ? stamp() : park.linked_at
      const next = { ...park, state, launch_state: null, leases: [], linked_at, updated_at: stamp() }
      return writePark(park.park_id, next, lockHandle) ? 'settled' : fail()
    } catch { return fail() }
  }

  const relaunchPark = (park, lockHandle, options = {}) => {
    const args = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
    const parkSpec = normalizeSpec(park?.spec)
    if (!parkSpec || typeof args.enqueue !== 'function' || typeof args.successorState !== 'function' || (args.order !== undefined && !Array.isArray(args.order))) return 'unresolvable'
    let current = park
    const engine = leaseEngine(args.successorState)
    try {
      for (const seat of orderSeats(park.seats, args.order)) {
        if (!checkFence(lockHandle)) return 'unresolvable'
        const key = leaseKey(seat.role, seat.sessionId)
        const path = leasePath(key)
        let record
        try { record = readJson(path) } catch { record = undefined }
        const valid = record && validateLeaseRecord(record, seat, path)
        let reservation_id = null
        if (valid?.ok && JSON.stringify(valid.spec) === JSON.stringify(parkSpec)) {
          try {
            engine.advance({ key, reservation_id: record.reservation_id }, LEASE_PHASES.HELD, { owner: { pid: d.pid, startedAt: stamp() } })
            reservation_id = record.reservation_id
          } catch { reservation_id = null }
        }
        if (!reservation_id) {
          const persisted = current.leases.find((handle) => leaseKey(handle.role, handle.sessionId) === key)
          let clearable = true
          try {
            if (record?.reservation_id === persisted?.reservation_id) {
              clearable = engine.clear({ key, reservation_id: persisted.reservation_id })
            } else {
              const verdict = engine.reconcile(key)
              if (verdict.verdict === VERDICTS.FREE) clearable = true
              else if (verdict.verdict === VERDICTS.RECLAIMABLE) clearable = engine.clear(verdict.handle)
              else clearable = false
            }
          } catch { clearable = false }
          if (!clearable) return rollbackPark(current, lockHandle)
          let reserved
          try {
            reserved = engine.reserve(key, { phase: LEASE_PHASES.HELD, role: seat.role, sessionId: seat.sessionId, spec: parkSpec })
          } catch { reserved = { ok: false } }
          if (!reserved?.ok) return rollbackPark(current, lockHandle)
          reservation_id = reserved.handle.reservation_id
        }
        const next = {
          ...current,
          leases: current.leases.map((handle) => leaseKey(handle.role, handle.sessionId) === key ? { ...handle, reservation_id } : handle),
          updated_at: stamp(),
        }
        if (!writePark(park.park_id, next, lockHandle)) return 'unresolvable'
        current = next
      }
      if (!verifyLeaseSet(current).ok) return 'unresolvable'
      const spec = frozenSpec(current)
      if (!spec) return 'unresolvable'
      let enqueued
      try { enqueued = args.enqueue(spec) } catch { return 'unresolvable' }
      if (!enqueued) return rollbackPark(current, lockHandle)
      return 'relaunched'
    } catch { return 'unresolvable' }
  }

  function linkActive(park, lockHandle) {
    try {
      if (!checkFence(lockHandle)) return false
      const verified = verifyLeaseSet(park)
      if (!verified.ok) return false
      const linked_at = park.linked_at === null ? stamp() : park.linked_at
      const updated_at = stamp()
      const next = { ...park, launch_state: 'enqueued', linked_at, updated_at }
      if (!writePark(park.park_id, next, lockHandle)) return false
      const transferred = transferLeases(next, lockHandle)
      return transferred.ok
    } catch { return false }
  }

  const claim = (id, input = {}) => {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    if (!safeId(id) || !nonblank(args.decision_id) || !nonblank(args.successor_run_id) || (args.order !== undefined && !Array.isArray(args.order)) || typeof args.enqueue !== 'function' || typeof args.successorState !== 'function') return { ok: false, reason: 'unresolvable' }
    try {
      return withLock(parkLockName(id), (lockHandle) => {
        let park = readPark(id)
        if (!park) return { ok: false, reason: 'unresolvable' }
        if (park.state === 'resumed' || park.state === 'abandoned') return { ok: false, reason: 'park-settled' }
        if (park.state === 'claimed') {
          if (park.decision?.decision_id === args.decision_id && park.spec?.run_id === args.successor_run_id) return { ok: true, replayed: true, park }
          if (park.decision?.decision_id === args.decision_id) return { ok: false, reason: 'successor-conflict' }
          return { ok: false, reason: 'decision-mismatch' }
        }
        if (park.state !== 'parked' || park.launch_state !== null) return { ok: false, reason: 'unresolvable' }
        if (!park.decision) return { ok: false, reason: 'no-answer' }
        if (park.decision.decision_id !== args.decision_id) return { ok: false, reason: 'decision-mismatch' }
        const spec = Object.freeze({
          run_id: args.successor_run_id,
          resumes_park_id: id,
          decision: Object.freeze({ decision_id: park.decision.decision_id, actor: park.decision.actor, answer: park.decision.answer }),
        })
        const acquired = acquireLeases(park.seats, { order: args.order, spec, successorState: args.successorState })
        if (!acquired.ok) {
          // Carry `remaining` through: acquireLeases reports leases its
          // rollback could NOT release, and dropping them here made a leaked
          // seat invisible to the caller — while claim's own writePark-failure
          // path below already propagates it.
          const reason = acquired.reason === 'seat-busy' ? 'seat-busy' : 'unresolvable'
          return { ok: false, reason, ...(acquired.remaining?.length ? { remaining: acquired.remaining } : {}) }
        }
        let next
        try {
          next = { ...park, state: 'claimed', launch_state: 'pending', leases: acquired.handles, spec, updated_at: stamp() }
          if (!writePark(id, next, lockHandle)) {
            const released = releaseLeases(acquired.handles)
            return { ok: false, reason: 'unresolvable', ...(released.remaining.length ? { remaining: released.remaining } : {}) }
          }
        } catch {
          const released = releaseLeases(acquired.handles)
          return { ok: false, reason: 'unresolvable', ...(released.remaining.length ? { remaining: released.remaining } : {}) }
        }
        let enqueued
        try { enqueued = args.enqueue(spec) } catch { return { ok: false, reason: 'enqueue-unresolved' } }
        if (!enqueued) return { ok: false, reason: 'enqueue-unresolved' }
        park = readPark(id) || next
        // `linked` is REPORTED, not swallowed. linkActive writes
        // launch_state:'enqueued' before transferLeases, so a lease lock lost
        // mid-transfer leaves the park enqueued with only some members
        // transferred, and it returns false. That is not a failed claim — the
        // successor really is enqueued and the frozen spec is durable — so ok
        // stays true; but a caller that is told nothing cannot know the set is
        // half-transferred. Completing it is the reconciler's job (slice 2b).
        let linked = null
        if (probeSuccessor(args.successorState, spec) === SUCCESSOR_STATES.ACTIVE) {
          linked = linkActive(park, lockHandle)
          park = readPark(id) || park
        }
        return { ok: true, park, ...(linked === null ? {} : { linked }) }
      })
    } catch { return { ok: false, reason: 'unresolvable' } }
  }

  const settlePark = (id, input = {}) => {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    if (!safeId(id) || typeof args.successorState !== 'function') return { ok: false, reason: 'unresolvable' }
    try {
      return withLock(parkLockName(id), (lockHandle) => {
        const park = readPark(id)
        if (!park) return { ok: false, reason: 'unresolvable' }
        if (park.state === 'resumed' || park.state === 'abandoned') {
          if (!terminalRowValid(park)) return { ok: false, reason: 'unresolvable' }
          return { ok: true, already: true, park }
        }
        if (park.state !== 'claimed' || !park.spec) return { ok: false, reason: 'unresolvable' }
        const state = probeSuccessor(args.successorState, park.spec)
        if (state === SUCCESSOR_STATES.ACTIVE) return { ok: false, reason: 'successor-active' }
        if (state === SUCCESSOR_STATES.UNKNOWN || state === SUCCESSOR_STATES.MISMATCH) return { ok: false, reason: 'unresolvable' }
        if (state === SUCCESSOR_STATES.ABSENT) return { ok: false, reason: 'no-terminal-evidence' }
        let failureReason = 'unresolvable'
        const outcome = settleRow(park, state, lockHandle, (reason) => { failureReason = reason })
        if (outcome !== 'settled') return { ok: false, reason: failureReason }
        return { ok: true, park: readPark(id) }
      })
    } catch { return { ok: false, reason: 'unresolvable' } }
  }

  const reconcileParks = (input = {}) => {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const result = { linked: [], relaunched: [], restored: [], unresolvable: [], waiting: [], settled: [] }
    if (typeof args.enqueue !== 'function' || typeof args.successorState !== 'function' || (args.order !== undefined && !Array.isArray(args.order))) return result
    let rows
    try { rows = listParks() } catch { return result }
    const bucket = (id, value) => {
      if (Object.hasOwn(result, value)) result[value].push(id)
      else result.unresolvable.push(id)
    }
    const filenameStem = (path) => String(path).split(/[\\/]/).pop().replace(/\.json$/, '')
    for (const row of rows) {
      const id = row?.corrupt ? filenameStem(row.path) : row?.park_id
      if (row?.corrupt) {
        result.unresolvable.push(id)
        continue
      }
      try {
        if (!safeId(id)) {
          result.unresolvable.push(id)
          continue
        }
        const outcome = withLock(parkLockName(id), (lockHandle) => {
          const park = readPark(id)
          if (!park) return 'unresolvable'
          if (park.state === 'parked' && park.launch_state === null) return 'waiting'
          if ((park.state === 'resumed' || park.state === 'abandoned') && park.launch_state === null) return terminalRowValid(park) ? 'settled' : 'unresolvable'
          if (park.state !== 'claimed' || !['pending', 'enqueued'].includes(park.launch_state)) return 'unresolvable'
          const state = probeSuccessor(args.successorState, frozenSpec(park))
          if (state === SUCCESSOR_STATES.ACTIVE) return linkActive(park, lockHandle) ? 'linked' : 'unresolvable'
          if (state === SUCCESSOR_STATES.RESUMED || state === SUCCESSOR_STATES.ABANDONED) return settleRow(park, state, lockHandle)
          if (state === SUCCESSOR_STATES.ABSENT) {
            if (park.launch_state === 'pending') return relaunchPark(park, lockHandle, args)
            return rollbackPark(park, lockHandle)
          }
          return 'unresolvable'
        })
        bucket(id, outcome)
      } catch { result.unresolvable.push(id) }
    }
    for (const values of Object.values(result)) values.sort()
    return result
  }

  const phases = { allowed: [PHASES.RESERVED, PHASES.SPAWNING, PHASES.RUNNING], preEffect: PHASES.RESERVED }
  const engine = reservationEngine({ dir, actor, pathFor: (key) => join(dir, `.${key}.active.json`), lockNameFor: markerLockName, phases, completionProof: (key, marker) => {
    if (!marker || !((typeof marker.reservation_id === 'string' && phases.allowed.includes(marker.phase)) || (['starting', 'running'].includes(marker.phase) && typeof marker.role === 'string'))) return false
    if (typeof marker.id !== 'string' || !/^d\d+$/.test(marker.id) || (marker.key ?? marker.role) !== key) return false
    return marker.exit === join(dir, marker.id, 'exit') && d.existsSync(marker.exit)
  }, evidencePolicy: (key, marker) => {
    if (marker?.evidence?.kind === EVIDENCE_KINDS.PGID && typeof marker.id === 'string' && /^d\d+$/.test(marker.id) && marker.evidence.file === join(dir, marker.id, 'pgid')) return marker.evidence
    const kind = marker?.evidence?.kind
    if (kind && typeof evidencePolicies[kind] === 'function') {
      try { return evidencePolicies[kind](key, marker) || null } catch { return null }
    }
    // Registered probes are a compatibility seam for surfaces that predate
    // per-kind validators; new surfaces should provide evidencePolicies.
    if (kind && probes[kind]) return marker.evidence
    return null
  }, probes, deps: d, lock: { withLock, checkFence } })

  return { reserve: engine.reserve, advance: engine.advance, clear: engine.clear, reconcile: engine.reconcile, override: engine.override, probeEvidence: engine.probeEvidence, acquire, release, checkFence, withLock, overrideLock, overrideLease, acquireLeases, releaseLeases, reconcileLease, clearLease, activeLeases, verifyLeaseSet, transferLeases, mintPark, recordAnswer, claim, settlePark, reconcileParks, readPark, listParks }
}

export function reservationEngine({ dir, actor, pathFor, lockNameFor, phases, completionProof = () => null, evidencePolicy = () => null, probes = {}, deps = {}, lock = null, overrides = {} }) {
  const d = normalDeps(deps)
  const withStore = lock || reclaimStore({ dir, actor, probes, deps: d, _lockOnly: true })
  const withLock = withStore.withLock
  const checkFence = withStore.checkFence
  const pathOf = pathFor || ((key) => join(dir, `.${key}.active.json`))
  const lockOf = lockNameFor || markerLockName
  const allowed = phases?.allowed || []
  const validPhase = (phase) => allowed.includes(phase)
  const probeMap = { [EVIDENCE_KINDS.PGID]: (evidence) => {
    if (!evidence || typeof evidence.file !== 'string') return LIVENESS.UNKNOWN
    let number
    try { number = Number(String(d.readFileSync(evidence.file, 'utf8')).trim()) } catch { return LIVENESS.UNKNOWN }
    if (!Number.isSafeInteger(number) || number <= 0) return LIVENESS.UNKNOWN
    try { d.kill(-number, 0); return LIVENESS.ALIVE } catch (err) { return err?.code === 'ESRCH' ? LIVENESS.DEAD : err?.code === 'EPERM' ? LIVENESS.ALIVE : LIVENESS.UNKNOWN }
  }, ...probes }
  function probeEvidence(evidence) {
    if (!evidence || typeof evidence.kind !== 'string' || !probeMap[evidence.kind]) return LIVENESS.UNKNOWN
    try { const result = probeMap[evidence.kind](evidence); return Object.values(LIVENESS).includes(result) ? result : LIVENESS.UNKNOWN } catch { return LIVENESS.UNKNOWN }
  }
  function readMarker(key) {
    const path = pathOf(key)
    const read = readJsonAt(path, d)
    if (read.state === JSON_STATES.ABSENT) return { path, raw: null, marker: null }
    if (read.raw === null) return { path, raw: null, marker: null, unreadable: true }
    return { path, raw: read.raw, marker: read.state === JSON_STATES.VALUE ? read.value : null }
  }
  function identityFor(key, item) {
    return item.marker && typeof item.marker.reservation_id === 'string' ? { key, reservation_id: item.marker.reservation_id } : item.raw != null ? { key, digest: digest(item.raw) } : { key, digest: '' }
  }
  const overrideKind = overrides.kind || 'reservation'
  const overrideAttested = overrides.attested === true
  function overrideMatches(key, item) {
    if (item.raw == null) return false
    return readOverrides(join(dir, 'overrides.jsonl'), d).some((record) => {
      if (record?.kind !== overrideKind || record.key !== key || !record.identity) return false
      if (overrideAttested && !validAttestation(record.attestation)) return false
      if (record.identity.kind === 'reservation_id') return item.marker?.reservation_id === record.identity.value
      return record.identity.kind === 'digest' && digest(item.raw) === record.identity.value
    })
  }
  function ownerAlive(marker) { return ownerState(marker?.owner || (marker && marker.ownerPid ? { pid: marker.ownerPid } : null), d) }
  function verdictOf(key, item) {
    if (item.raw == null && !item.unreadable) return { verdict: VERDICTS.FREE, marker: null, handle: null }
    if (!item.marker) return { verdict: overrideMatches(key, item) ? VERDICTS.RECLAIMABLE : VERDICTS.UNRESOLVABLE, marker: null, handle: identityFor(key, item) }
    let complete = false
    try { complete = completionProof(key, item.marker) === true } catch { complete = false }
    if (complete) return { verdict: VERDICTS.RECLAIMABLE, marker: item.marker, handle: identityFor(key, item) }
    const evidence = (() => { try { return evidencePolicy(key, item.marker) } catch { return null } })()
    const evidenceState = probeEvidence(evidence)
    if (evidenceState === LIVENESS.ALIVE) return { verdict: VERDICTS.BUSY, marker: item.marker, handle: identityFor(key, item) }
    if (ownerAlive(item.marker) === LIVENESS.ALIVE) return { verdict: VERDICTS.BUSY, marker: item.marker, handle: identityFor(key, item) }
    if (typeof item.marker.reservation_id !== 'string' || !validPhase(item.marker.phase)) {
      const value = VERDICTS.UNRESOLVABLE
      return { verdict: overrideMatches(key, item) ? VERDICTS.RECLAIMABLE : value, marker: item.marker, handle: identityFor(key, item) }
    }
    if (evidenceState === LIVENESS.DEAD || (phases.preEffect != null && item.marker.phase === phases.preEffect)) return { verdict: VERDICTS.RECLAIMABLE, marker: item.marker, handle: identityFor(key, item) }
    return { verdict: overrideMatches(key, item) ? VERDICTS.RECLAIMABLE : VERDICTS.UNRESOLVABLE, marker: item.marker, handle: identityFor(key, item) }
  }
  function reconcile(key) { return verdictOf(key, readMarker(key)) }
  function markerIdentityMatches(item, handle) {
    if (!item.raw || !handle || handle.key == null) return false
    if (handle.reservation_id != null) return item.marker?.reservation_id === handle.reservation_id
    return handle.digest != null && digest(item.raw) === handle.digest
  }
  function writeNew(path, value) {
    const tmp = `${path}.tmp.${d.uuid()}`
    try { d.writeFileSync(tmp, JSON.stringify(value)); d.linkSync(tmp, path) } finally { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} }
  }
  function mutation(handle, fn, absent = false) {
    if (!handle || !checkFence(handle.__lock)) return absent
    const item = readMarker(handle.key)
    if (!markerIdentityMatches(item, handle)) return absent
    if (!checkFence(handle.__lock)) return absent
    return fn(item)
  }
  function reserve(key, record = {}) {
    let outcome
    try {
      outcome = withLock(lockOf(key), (lockHandle) => {
        const item = readMarker(key)
        const verdict = verdictOf(key, item)
        if (verdict.verdict !== VERDICTS.FREE) return { ok: false, reason: verdict.verdict === VERDICTS.UNRESOLVABLE ? 'unresolvable' : 'busy' }
        const reservation_id = d.uuid()
        const marker = { ...record, reservation_id, key, phase: record.phase, owner: { pid: d.pid, startedAt: d.now() }, evidence: record.evidence, at: d.now() }
        if (!validPhase(marker.phase)) return { ok: false, reason: 'unresolvable' }
        try { writeNew(pathOf(key), marker) } catch (err) {
          if (err?.code === 'EEXIST') return { ok: false, reason: 'busy' }
          if (['EXDEV', 'EPERM', 'ENOTSUP'].includes(err?.code)) return { ok: false, reason: 'unresolvable' }
          throw err
        }
        return { ok: true, handle: { key, reservation_id }, marker }
      })
    } catch (err) {
      if (err.stage === 'reclaim-lock-unavailable') return { ok: false, reason: err.reason || 'contended' }
      throw err
    }
    return outcome
  }
  function advance(handle, phase, patch = {}) {
    if (!validPhase(phase) || !handle?.reservation_id) throw new Error('invalid reservation phase or handle')
    return withLock(lockOf(handle.key), (lockHandle) => {
      const h = { ...handle, __lock: lockHandle }
      if (!checkFence(lockHandle)) throw new Error('stale reservation')
      const item = readMarker(handle.key)
      if (!markerIdentityMatches(item, h)) throw new Error('stale reservation')
      if (!checkFence(lockHandle)) throw new Error('stale reservation')
      const marker = { ...item.marker, ...patch, key: handle.key, reservation_id: handle.reservation_id, phase, at: d.now() }
      const tmp = `${item.path}.tmp.${d.uuid()}`
      try { d.writeFileSync(tmp, JSON.stringify(marker)); d.renameSync(tmp, item.path) } finally { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} }
      return marker
    })
  }
  function clear(handle) {
    if (!handle?.key) return false
    try {
      return withLock(lockOf(handle.key), (lockHandle) => mutation({ ...handle, __lock: lockHandle }, (item) => {
        try { d.unlinkSync(item.path); return true } catch (err) { if (err?.code === 'ENOENT') return false; throw err }
      }))
    } catch (err) {
      if (err.stage === 'reclaim-lock-unavailable') return false
      throw err
    }
  }
  function override(key, input = {}) {
    if (!input.actor) throw new Error('override actor required')
    const item = readMarker(key)
    const identity = input.reservation_id != null ? { kind: 'reservation_id', value: input.reservation_id } : input.digest != null ? { kind: 'digest', value: input.digest } : null
    if (!identity || !markerIdentityMatches(item, { key, ...input })) throw new Error('reservation override identity mismatch')
    appendLine(join(dir, 'overrides.jsonl'), { at: d.now(), actor: input.actor, reason: input.reason, kind: 'reservation', key, identity, marker: item.marker }, d)
  }
  return { reserve, advance, clear, reconcile, override, probeEvidence }
}

// --- suite slots (#823, parent #822) -----------------------------------------
// A suite slot is a COUNTED LEASE: the discipline reclaimStore already runs for
// markers, leases and parks — linkSync exclusive creates, one epoch lock per
// mutation, LOCK_ATTEMPTS/LOCK_INTERVAL_MS, and the FREE/RECLAIMABLE/BUSY
// verdicts — differing only in that there are K numbered slots in ONE shared
// directory rather than one lease per seat. No second locking scheme exists
// here: slotStore builds a lock-only reclaimStore and borrows its withLock.

export const SLOT_ENV = Object.freeze({ capacity: 'CREW_SUITE_SLOTS' })
export const SLOT_DEFAULT_FLOOR = 2
export const SLOT_CORES_PER_SLOT = 6

export function slotLockName(kind) {
  return digest(JSON.stringify(['slot-lock', kind])).slice(0, 32)
}

// DELIBERATE DIVERGENCE from CREW_LOAD_THRESHOLD's no-default precedent
// (crew/host-load.mjs: "There is deliberately NO default threshold — a guessed
// number is a number nobody measured"). That precedent guards a REFUSAL: a
// guessed threshold refuses boots that would have succeeded, and work nobody
// asked to lose is lost. This guards a QUEUE, and the failure mode of a wrong K
// is WAITING, not refusing — so a default is safe, and being on by default is
// what removes the cross-lane contention #822 measured. The default answers
// ABSENCE only: a blank value reads as absent (crew/limits.mjs:31), 0 means
// disabled, and every other malformed value is an operator typo that throws,
// exactly as the threshold does.
//
// `cpus` is the injected probe seam, defaulting to the real node:os reader, so
// the default path is genuinely CPU-derived while every test stays deterministic.
// A probe that throws or reports no usable core count falls back to the floor
// rather than to a number nobody measured.
export function slotCapacity({ env = process.env, cpus = osCpus } = {}) {
  const raw = env?.[SLOT_ENV.capacity]
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const configured = Number(raw)
    if (!Number.isSafeInteger(configured) || configured < 0) {
      throw new Error(`${SLOT_ENV.capacity} must be a non-negative integer (got ${JSON.stringify(raw)})`)
    }
    return configured
  }
  let cores = null
  try { cores = cpus()?.length ?? null } catch { cores = null }
  const measured = Number.isSafeInteger(cores) && cores > 0 ? cores : 0
  return Math.max(SLOT_DEFAULT_FLOOR, Math.floor(measured / SLOT_CORES_PER_SLOT))
}

export function slotStore({ dir, kind, capacity, deps = {} }) {
  const d = normalDeps(deps)
  if (!nonblank(kind) || !safeId(kind)) throw new Error('slotStore requires a filesystem-safe kind')
  const size = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : 0
  // Capacity 0 is the documented off switch (CREW_SUITE_SLOTS=0 reaching here
  // through slotCapacity), so it touches no disk at all: a disabled pool that
  // still mkdirs is a pool. The handle is inert and its release is a no-op, so
  // no caller needs a branch.
  if (size === 0) {
    const idle = Object.freeze({ kind, slot: null, token: null, disabled: true })
    return { kind, capacity: 0, acquire: () => ({ slot: null, handle: idle }), release: (handle) => handle?.disabled === true }
  }
  // Everything this pool creates lives under poolDir — the records AND the lock
  // epochs the borrowed store keeps — because `dir` is a SHARED cross-lane root
  // and a store must never shape another consumer's layout (the hazard recorded
  // at the _lockOnly return above). _staleCorruptLock is the pool's opt-in to
  // the corrupt-lock-is-stale rule: one lock stands in front of K slots here, so
  // a damaged epoch must not wedge the pool (docs/conventions.md:64). It is only
  // ever DAMAGE — an epoch whose bytes could not be read at all stays
  // unresolvable, because unreadable is not evidence of corrupt.
  const poolDir = join(dir, 'slots')
  const store = reclaimStore({ dir: poolDir, actor: kind, deps: d, _lockOnly: true, _staleCorruptLock: true })
  const lockName = slotLockName(kind)
  const slots = Array.from({ length: size }, (_, index) => `${kind}-${index}`)
  const slotPath = (slot) => join(poolDir, `${slot}.json`)
  const validRecord = (record) => !!record && typeof record === 'object' && !Array.isArray(record)
    && Number.isSafeInteger(record.pid) && record.pid > 0
    && Number.isFinite(record.start) && Number.isFinite(record.acquired_at)
    && nonblank(record.owner) && nonblank(record.token)

  // Stale is never a wedge (docs/conventions.md 2026-08-02). Absent is FREE;
  // unreadable, misshapen and dead-pid rows are all RECLAIMABLE; only a
  // well-formed row whose pid is alive is BUSY. So no torn byte parks a slot
  // forever, and the verdicts are the store's existing ones verbatim. readJsonAt
  // rather than readJsonTri because a literal `null` on disk is a FILE that
  // exists, and treating it as absent would send the claim into a certain EEXIST.
  const verdictFor = (read) => {
    if (read.state === JSON_STATES.ABSENT) return VERDICTS.FREE
    if (read.state === JSON_STATES.UNREADABLE || !validRecord(read.value)) return VERDICTS.RECLAIMABLE
    return ownerState({ pid: read.value.pid, startedAt: read.value.start }, d) === LIVENESS.ALIVE ? VERDICTS.BUSY : VERDICTS.RECLAIMABLE
  }
  // The identity of the exact row a scan adjudicated: a token for a well-formed
  // row, the digest of the raw bytes for damaged ones. `null` means there is
  // nothing this store may claim to have observed — an absent row, or one whose
  // bytes could not be read at all (a directory planted at the path) — and a null
  // identity never authorises an unlink.
  const rowIdentity = (read) => {
    if (read.state === JSON_STATES.ABSENT) return null
    if (read.state === JSON_STATES.VALUE && validRecord(read.value)) return { kind: 'token', value: read.value.token }
    return read.raw == null ? null : { kind: 'digest', value: digest(read.raw) }
  }
  const identityMatches = (read, identity) => {
    const current = rowIdentity(read)
    return !!identity && !!current && current.kind === identity.kind && current.value === identity.value
  }
  // Fence, re-read, identity, fence, mutate — the shape reservationEngine's
  // `mutation` uses. The re-read is the window in which a newer epoch can
  // displace this callback, so the fence is checked on BOTH sides of it; a lost
  // fence yields no ownership at all rather than moving on to another slot.
  const dropRow = (slot, lockHandle, identity) => {
    if (!store.checkFence(lockHandle)) return 'lost'
    if (!identityMatches(readJsonAt(slotPath(slot), d), identity)) return 'skip'
    if (!store.checkFence(lockHandle)) return 'lost' // the guard that matters: the re-read above is the displacement window
    try { d.unlinkSync(slotPath(slot)) } catch (err) { return err?.code === 'ENOENT' ? 'ok' : 'skip' }
    return 'ok'
  }
  // Exclusive create, EEXIST = loser (docs/conventions.md 2026-08-02): even
  // holding the pool lock the claim is a linkSync, so a writer that raced the
  // lock can never make two acquirers believe they hold one slot.
  const claimRow = (slot, owner, lockHandle) => {
    if (!store.checkFence(lockHandle)) return { outcome: 'lost' }
    const at = finiteNow(d.now)
    const record = { pid: d.pid, start: at, owner, acquired_at: at, token: d.uuid() }
    const tmp = join(poolDir, `.${slot}.${record.token}.tmp`)
    try {
      d.writeFileSync(tmp, JSON.stringify(record))
      if (!store.checkFence(lockHandle)) return { outcome: 'lost' } // last look before the exclusive create
      d.linkSync(tmp, slotPath(slot))
      if (!store.checkFence(lockHandle)) {
        // The outer epoch is already dead, so nesting this lock is safe:
        // releaseEpoch re-reads the maximum and the outer finally cannot release
        // a newer epoch. This pool opts into _staleCorruptLock, so a readable
        // damaged own maximum is re-acquired immediately. If another supervisor
        // advanced after adjudicating us DEAD, it reclaims this row itself; and a
        // fresh dropRow `skip` means a successor token won and must stay intact.
        // withLock can contend out after 20x50ms, so preserve the lost result
        // rather than throw. A live operator-override displacer can leave a row
        // for that operator — a residual strictly better than an unconditional
        // orphan from this callback.
        try {
          store.withLock(lockName, (fresh) => dropRow(slot, fresh, { kind: 'token', value: record.token }))
        } catch { /* the row could not be reclaimed under a fresh fence */ }
        return { outcome: 'lost' }
      }
    } catch (err) {
      if (err?.code === 'EEXIST') return { outcome: 'skip' }
      const failure = Error(`slot claim failed: ${slot}`, { cause: err })
      failure.stage = 'slot-claim-unresolvable'
      throw failure
    } finally { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} }
    return { outcome: 'ok', handle: { kind, slot, token: record.token, owner } }
  }
  // `depth` is pool OCCUPANCY on a completed scan, not a queue length — there
  // is no queue here and FIFO is not promised, only eventual admission (#823).
  // It is returned so a caller can log "waiting behind N holders" without a
  // second read of the pool. A lost fence cuts the scan short, so its depth is
  // null rather than a partial counter. `lost: true` is the separate, honest
  // signal that a newer epoch displaced this attempt.
  const acquire = (input = {}) => {
    const owner = nonblank(input?.owner) ? input.owner : null
    if (!owner) throw new Error('slotStore.acquire requires a non-blank owner')
    return store.withLock(lockName, (lockHandle) => {
      let busy = 0
      for (const slot of slots) {
        const read = readJsonAt(slotPath(slot), d)
        const verdict = verdictFor(read)
        if (verdict === VERDICTS.BUSY) { busy += 1; continue }
        if (verdict === VERDICTS.RECLAIMABLE) {
          const dropped = dropRow(slot, lockHandle, rowIdentity(read))
          if (dropped === 'lost') return { waiting: true, depth: null, lost: true }
          if (dropped === 'skip') { busy += 1; continue }
        }
        const claimed = claimRow(slot, owner, lockHandle)
        if (claimed.outcome === 'lost') return { waiting: true, depth: null, lost: true }
        if (claimed.outcome === 'ok') return { slot, handle: claimed.handle }
        busy += 1
      }
      return { waiting: true, depth: busy }
    })
  }
  const release = (handle) => {
    if (handle?.disabled === true) return true
    if (!handle || handle.kind !== kind || !slots.includes(handle.slot) || !nonblank(handle.token)) return false
    try {
      // Verified before unlink (docs/conventions.md 2026-08-02): a handle whose
      // token no longer matches the row on disk was already reclaimed, and
      // unlinking then would hand the successor's slot to a third acquirer. The
      // comparison lives in dropRow and ONLY there — a second copy here would
      // leave neither copy provable by mutation, because either one alone
      // already refuses.
      return store.withLock(lockName, (lockHandle) => dropRow(handle.slot, lockHandle, { kind: 'token', value: handle.token }) === 'ok')
    } catch { return false }
  }
  return { kind, capacity: size, acquire, release }
}
