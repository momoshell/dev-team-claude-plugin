import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync, unlinkSync as fsUnlinkSync, mkdirSync as fsMkdirSync, readdirSync as fsReaddirSync, renameSync as fsRenameSync, linkSync as fsLinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'


export const PHASES = { RESERVED: 'reserved', SPAWNING: 'spawning', RUNNING: 'running' }
export const VERDICTS = { FREE: 'free', RECLAIMABLE: 'reclaimable', BUSY: 'busy', UNRESOLVABLE: 'unresolvable' }
export const EVIDENCE_KINDS = { PGID: 'pgid' }
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
  if (owner.pid === d.pid) return LIVENESS.ALIVE
  try { d.kill(owner.pid, 0); return LIVENESS.ALIVE } catch (err) {
    return err?.code === 'ESRCH' ? LIVENESS.DEAD : LIVENESS.ALIVE
  }
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
    const cur = current(handle.name)
    if (!cur || cur.fence !== handle.fence || cur.record?.token !== handle.token) return false
    let value
    try { value = { ...cur.record, released: true } } catch { return false }
    const tmp = `${cur.path}.tmp.${d.uuid()}`
    try { d.writeFileSync(tmp, JSON.stringify(value)); d.renameSync(tmp, cur.path); return true } catch { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} ; return false }
  }
  function releaseHistorical(handle) {
    const path = lockPath(handle.name, handle.fence)
    let raw, record
    try { raw = String(d.readFileSync(path, 'utf8')); record = JSON.parse(raw) } catch { return false }
    if (record?.token !== handle.token || record.released === true) return false
    const tmp = `${path}.tmp.${d.uuid()}`
    try { d.writeFileSync(tmp, JSON.stringify({ ...record, released: true })); d.renameSync(tmp, path); return true } catch { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} ; return false }
  }
  function acquire(name) {
    let attempts = 0
    while (attempts < LOCK_ATTEMPTS) {
      const cur = current(name)
      const overridden = matchingLockOverride(name, cur)
      if (cur && !overridden) {
        if (!cur.record) return { ok: false, reason: 'unresolvable', attempts }
        if (cur.record.released !== true && ownerForLock(cur) !== LIVENESS.DEAD) {
          attempts += 1
          if (attempts >= LOCK_ATTEMPTS) return { ok: false, reason: 'contended', attempts }
          d.sleep(LOCK_INTERVAL_MS)
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
    const cur = current(handle.name)
    return !!(cur && cur.fence === handle.fence && cur.record?.token === handle.token && cur.record.released !== true && !matchingLockOverride(handle.name, cur))
  }
  function release(handle) { return releaseEpoch(handle) }
  function withLock(name, fn) {
    const result = acquire(name)
    if (!result.ok) { const err = new Error(`reclaim lock unavailable: ${name}`); err.stage = 'reclaim-lock-unavailable'; err.reason = result.reason; throw err }
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

export function reservationEngine({ dir, actor, pathFor, lockNameFor, phases, completionProof = () => null, evidencePolicy = () => null, probes = {}, deps = {}, lock = null }) {
  const d = normalDeps(deps)
  const withStore = lock || reclaimStore({ dir, actor, probes, deps: d, _lockOnly: true })
  const withLock = withStore.withLock
  const checkFence = withStore.checkFence
  const pathOf = pathFor || ((key) => join(dir, `.${key}.active.json`))
  const lockOf = lockNameFor || markerLockName
  const allowed = phases?.allowed || []
  const validPhase = (p) => allowed.includes(p)
  const probeMap = { [EVIDENCE_KINDS.PGID]: (e) => {
    if (!e || typeof e.file !== 'string') return LIVENESS.UNKNOWN
    let n
    try { n = Number(String(d.readFileSync(e.file, 'utf8')).trim()) } catch { return LIVENESS.UNKNOWN }
    if (!Number.isSafeInteger(n) || n <= 0) return LIVENESS.UNKNOWN
    try { d.kill(-n, 0); return LIVENESS.ALIVE } catch (err) { return err?.code === 'ESRCH' ? LIVENESS.DEAD : err?.code === 'EPERM' ? LIVENESS.ALIVE : LIVENESS.UNKNOWN }
  }, ...probes }
  function probeEvidence(evidence) {
    if (!evidence || typeof evidence.kind !== 'string' || !probeMap[evidence.kind]) return LIVENESS.UNKNOWN
    try { const result = probeMap[evidence.kind](evidence); return Object.values(LIVENESS).includes(result) ? result : LIVENESS.UNKNOWN } catch { return LIVENESS.UNKNOWN }
  }
  function readMarker(key) {
    const path = pathOf(key)
    if (!d.existsSync(path)) return { path, raw: null, marker: null }
    let raw
    try { raw = String(d.readFileSync(path, 'utf8')) } catch { return { path, raw: null, marker: null, unreadable: true } }
    try { return { path, raw, marker: JSON.parse(raw) } } catch { return { path, raw, marker: null } }
  }
  function identityFor(key, item) {
    return item.marker && typeof item.marker.reservation_id === 'string' ? { key, reservation_id: item.marker.reservation_id } : item.raw != null ? { key, digest: digest(item.raw) } : { key, digest: '' }
  }
  function overrideMatches(key, item) {
    if (item.raw == null) return false
    return readOverrides(join(dir, 'overrides.jsonl'), d).some((r) => {
      if (r?.kind !== 'reservation' || r.key !== key || !r.identity) return false
      if (r.identity.kind === 'reservation_id') return item.marker?.reservation_id === r.identity.value
      return r.identity.kind === 'digest' && digest(item.raw) === r.identity.value
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
      const v = VERDICTS.UNRESOLVABLE
      return { verdict: overrideMatches(key, item) ? VERDICTS.RECLAIMABLE : v, marker: item.marker, handle: identityFor(key, item) }
    }
    if (evidenceState === LIVENESS.DEAD || (phases.preEffect != null && item.marker.phase === phases.preEffect)) return { verdict: VERDICTS.RECLAIMABLE, marker: item.marker, handle: identityFor(key, item) }
    return { verdict: overrideMatches(key, item) ? VERDICTS.RECLAIMABLE : VERDICTS.UNRESOLVABLE, marker: item.marker, handle: identityFor(key, item) }
  }
  function reconcile(key) { const item = readMarker(key); return verdictOf(key, item) }
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
    try { outcome = withLock(lockOf(key), (lh) => {
      const item = readMarker(key); const verdict = verdictOf(key, item)
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
    }) } catch (err) { if (err.stage === 'reclaim-lock-unavailable') return { ok: false, reason: err.reason || 'contended' }; throw err }
    return outcome
  }
  function advance(handle, phase, patch = {}) {
    if (!validPhase(phase) || !handle?.reservation_id) throw new Error('invalid reservation phase or handle')
    return withLock(lockOf(handle.key), (lh) => {
      const h = { ...handle, __lock: lh }
      if (!checkFence(lh)) throw new Error('stale reservation')
      const item = readMarker(handle.key)
      if (!markerIdentityMatches(item, h)) throw new Error('stale reservation')
      if (!checkFence(lh)) throw new Error('stale reservation')
      const marker = { ...item.marker, ...patch, key: handle.key, reservation_id: handle.reservation_id, phase, at: d.now() }
      const tmp = `${item.path}.tmp.${d.uuid()}`
      try { d.writeFileSync(tmp, JSON.stringify(marker)); d.renameSync(tmp, item.path) } finally { try { if (d.existsSync(tmp)) d.unlinkSync(tmp) } catch {} }
      return marker
    })
  }
  function clear(handle) {
    if (!handle?.key) return false
    try { return withLock(lockOf(handle.key), (lh) => mutation({ ...handle, __lock: lh }, (item) => { try { d.unlinkSync(item.path); return true } catch (err) { if (err?.code === 'ENOENT') return false; throw err } })) } catch (err) { if (err.stage === 'reclaim-lock-unavailable') return false; throw err }
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
