import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync, unlinkSync as fsUnlinkSync, mkdirSync as fsMkdirSync, readdirSync as fsReaddirSync, renameSync as fsRenameSync, linkSync as fsLinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readJsonAt, JSON_STATES } from './json-leaf.mjs'

export const PHASES = { RESERVED: 'reserved', SPAWNING: 'spawning', RUNNING: 'running' }
const VERDICTS = { FREE: 'free', RECLAIMABLE: 'reclaimable', BUSY: 'busy', UNRESOLVABLE: 'unresolvable' }
export const EVIDENCE_KINDS = { PGID: 'pgid', SUCCESSOR: 'successor' }
export const LIVENESS = { ALIVE: 'alive', DEAD: 'dead', UNKNOWN: 'unknown' }
const LOCK_ATTEMPTS = 20
const LOCK_INTERVAL_MS = 50
const LOCK_BACKOFF_CAP_MS = 1000

const digest = (value) => createHash('sha256').update(String(value)).digest('hex')
const defaultSleep = (ms) => {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function markerLockName(key) {
  return digest(JSON.stringify(['marker', key])).slice(0, 32)
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


export function reclaimStore({ dir, actor, probes = {}, evidencePolicies = {}, deps = {}, _lockOnly = false }) {
  const d = normalDeps(deps)
  const lockDir = join(dir, 'locks')
  const overridePath = join(dir, 'overrides.jsonl')
  // The store directory is initialized once so lock and marker creation can be
  // exclusive; headless allocation still creates each run directory separately.
  d.mkdirSync(dir, { recursive: true })
  d.mkdirSync(lockDir, { recursive: true })
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
  function retireSuperseded({ name, fence }) {
    for (const epoch of epochs(name)) {
      if (!(epoch < fence)) continue
      try { d.unlinkSync(lockPath(name, epoch)) } catch {}
    }
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
  function acquire(name, { deadlineMs = LOCK_ATTEMPTS * LOCK_INTERVAL_MS } = {}) {
    if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs < 0) throw new TypeError('deadlineMs must be a finite non-negative number')
    const startedAt = finiteNow(d.now)
    const maxAttempts = Math.ceil(deadlineMs / LOCK_INTERVAL_MS) + 1
    let attempts = 0
    let backoffMs = LOCK_INTERVAL_MS
    const waited = () => Math.max(0, finiteNow(d.now) - startedAt)
    const holderOf = (observed) => observed?.record ? {
      pid: observed.record.owner?.pid ?? null,
      started_at: observed.record.owner?.startedAt ?? null,
      actor: observed.record.actor ?? null,
      fence: observed.record.fence ?? observed.fence,
    } : null
    const failure = (reason, observed) => ({ ok: false, reason, attempts, holder: holderOf(observed), waited_ms: waited() })
    const contention = (observed) => {
      attempts += 1
      const elapsed = waited()
      if (elapsed >= deadlineMs || attempts >= maxAttempts) return failure('contended', observed)
      d.sleep(Math.min(backoffMs, Math.max(0, deadlineMs - elapsed)))
      backoffMs = Math.min(LOCK_BACKOFF_CAP_MS, backoffMs * 2)
      return null
    }
    while (true) {
      const cur = current(name)
      const overridden = matchingLockOverride(name, cur)
      if (cur && !overridden) {
        if (!cur.record) return failure('unresolvable', cur)
        if (cur.record.released !== true && ownerForLock(cur) !== LIVENESS.DEAD) {
          const stopped = contention(cur)
          if (stopped) return stopped
          continue
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
          const stopped = contention(current(name))
          if (stopped) return stopped
          continue
        }
        if (['EXDEV', 'EPERM', 'ENOTSUP'].includes(err?.code)) return failure('unresolvable', current(name))
        throw err
      } finally { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} }
      const after = current(name)
      if (after?.fence > fence) {
        releaseHistorical({ name, fence, token })
        return failure('lost', after)
      }
      if (after?.fence === fence && after.record?.token === token) {
        retireSuperseded({ name, fence })
        return { ok: true, handle: { name, fence, token }, attempts }
      }
      if (after?.fence === fence) return failure('unresolvable', after)
      return failure('lost', after)
    }
  }
  function checkFence(handle) {
    if (!handle?.name) return false
    const cur = current(handle.name)
    return !!(cur && cur.fence === handle.fence && cur.record?.token === handle.token && cur.record.released !== true && !matchingLockOverride(handle.name, cur))
  }
  function release(handle) { return releaseEpoch(handle) }
  function withLock(name, fn, options = {}) {
    const result = acquire(name, options)
    if (!result.ok) {
      const holder = result.holder
      const err = new Error(`reclaim lock unavailable: ${name} reason=${result.reason} pid=${holder?.pid ?? 'unknown'} actor=${holder?.actor ?? 'unknown'} fence=${holder?.fence ?? 'unknown'} waited_ms=${result.waited_ms}`)
      err.stage = 'reclaim-lock-unavailable'
      err.reason = result.reason
      err.holder = result.holder
      err.waited_ms = result.waited_ms
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

  if (_lockOnly) return { acquire, release, checkFence, withLock, overrideLock }

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

  return { reserve: engine.reserve, advance: engine.advance, clear: engine.clear, reconcile: engine.reconcile, override: engine.override, probeEvidence: engine.probeEvidence, acquire, release, checkFence, withLock, overrideLock }
}

function reservationEngine({ dir, actor, pathFor, lockNameFor, phases, completionProof = () => null, evidencePolicy = () => null, probes = {}, deps = {}, lock = null, overrides = {} }) {
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

export const SLOT_ENV = Object.freeze({ capacity: 'CREW_SUITE_SLOTS' })