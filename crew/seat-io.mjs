import {
  existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync,
  unlinkSync as fsUnlinkSync, renameSync as fsRenameSync, mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execSync as cpExecSync, execFileSync as cpExecFileSync, spawnSync as cpSpawnSync } from 'node:child_process'

import {
  cmux as defaultCmux, tree as defaultTree, locate as defaultLocate, sendLine as defaultSendLine,
  closeSurface as defaultCloseSurface, logLine as defaultLogLine, assignmentLine as defaultAssignmentLine,
} from './driver.mjs'
import { headlessIo as defaultHeadlessIo, PROVIDER_CONDITIONS, recogniseProviderCondition, writeCrewJson, updateCrewJson } from './headless.mjs'
import { headlessRpcIo as defaultHeadlessRpcIo, teardownOutcome } from './headless-rpc.mjs'
import { LIVENESS, PHASES, reservationEngine, markerLockName } from './reclaim.mjs'
import { modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { modelString as piModelString } from './adapters/adapter-pi.mjs'
import { hostLoad, loadPolicy } from './host-load.mjs'

export const DEFAULT_TRANSPORT = 'pane'
export const HEADLESS_TRANSPORT = 'headless-json'
export const HEADLESS_RPC_TRANSPORT = 'headless-rpc'
export const WAIT_POLL_MS = 5000
export const LIVENESS_PROBE_MS = 30_000
export const LIVENESS_MISSES_TO_DIE = 2
// Bound substrate probes so a dead pane manager fails promptly without conflating per-seat liveness.
export const SUBSTRATE_MISSES_TO_DIE = 2

// #392: an unparseable envelope from a seat that is still THERE is a defect in
// the report about the work, not in the work. Ask the one participant who can
// fix it — exactly once. The bound is DATA, not a loop: REASK_MAX asks per
// assignment, and the re-ask's own wait is clamped so a hung seat cannot
// double a stage budget.
export const REASK_MAX = 1
export const REASK_TIMEOUT_S = 600

// The canonical transport value is NOT the store directory name. Keep the
// production paths explicit: deriving a path from `headless-json` would find
// nothing and make capture inert.
export const DESCENDANT_STORE_DIRS = Object.freeze({
  [HEADLESS_TRANSPORT]: 'headless',
  [HEADLESS_RPC_TRANSPORT]: 'headless-rpc',
})
export const DESCENDANT_DIR = 'descendants'
export const DESCENDANT_PS_TIMEOUT_MS = 5000
export const DESCENDANT_SETTLE_MS = 250
export const DESCENDANT_SETTLE_POLLS = 4
export const DESCENDANT_MAX_ANCHORS = 8

const defaultBlockingSleep = (ms) => {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

// A synchronous caller can observe a just-killed direct child as a zombie until
// Node's event loop gets a chance to reap it. Keep that narrow local fact for
// the remainder of the teardown stack; the shim is removed on the next turn.
const locallySettledGroups = new Set()
let groupProbeShim = null
let groupProbeShimOriginal = null
// ONE notion of liveness for both ps probes: a `Z` state means the process has
// terminated and the kernel is holding its exit status for a parent that has not
// reaped it. That is a MEASURED death, not an over-claim (ADR-030) — unlike
// process.kill(pid, 0), which succeeds for a zombie and cannot see this at all.
export function statIsZombie(stat) {
  return typeof stat === 'string' && stat.trim().startsWith('Z')
}

function processIsZombie(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    const result = cpSpawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: DESCENDANT_PS_TIMEOUT_MS })
    return result?.status === 0 && String(result.stdout || '').trim().split(/\s+/).some(statIsZombie)
  } catch { return false }
}
function markLocallySettledGroup(rootPid, pgid = rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || !Number.isSafeInteger(pgid) || pgid <= 1 || !processIsZombie(rootPid)) return false
  locallySettledGroups.add(pgid)
  if (groupProbeShim) return
  groupProbeShimOriginal = process.kill
  groupProbeShim = function (pid, signal) {
    if (signal === 0 && Number.isSafeInteger(pid) && pid < -1 && locallySettledGroups.has(-pid)) {
      const err = new Error('process group is settled')
      err.code = 'ESRCH'
      throw err
    }
    return groupProbeShimOriginal.call(process, pid, signal)
  }
  try { process.kill = groupProbeShim } catch { groupProbeShim = null; groupProbeShimOriginal = null }
  if (groupProbeShim) setImmediate(() => {
    if (process.kill === groupProbeShim) process.kill = groupProbeShimOriginal
    groupProbeShim = null; groupProbeShimOriginal = null
    for (const value of locallySettledGroups) locallySettledGroups.delete(value)
  })
}
// Journal and ledger callbacks are user code. Never let them observe this
// teardown-only compatibility shim; restore it only for the caller's
// synchronous post-teardown probes (the event loop removes it on the next turn).
function withoutSettledGroupShim(fn) {
  if (!groupProbeShim || process.kill !== groupProbeShim) return fn()
  const shim = groupProbeShim
  const original = groupProbeShimOriginal
  process.kill = original
  try { return fn() } finally {
    if (groupProbeShim === shim) process.kill = shim
  }
}
function callTeardownCallback(fn) {
  try { return withoutSettledGroupShim(fn) } catch { return undefined }
}

function emptySnapshot() { return { ok: false, rows: new Map() } }

function freshDescendantSnapshot(deps = {}) {
  try {
    const value = typeof deps.snapshot === 'function' ? deps.snapshot() : psSnapshot(deps)
    if (!value || !(value.rows instanceof Map)) return emptySnapshot()
    return { ok: value.ok === true, rows: value.rows }
  } catch { return emptySnapshot() }
}

export function psSnapshot(deps = {}) {
  const spawnSync = deps.spawnSync || cpSpawnSync
  // `stat` is what tells a running process from a terminated-but-unreaped one;
  // `lstart` stays LAST because it is the only column that contains spaces. A ps
  // that cannot print the state column still yields a usable table: fall back to
  // the four-column request and leave `stat` null — unmeasured is never a
  // zombie, so a platform that cannot answer weakens no refusal.
  const read = (format) => {
    let result
    try {
      result = spawnSync('ps', ['-eo', format], { encoding: 'utf8', timeout: DESCENDANT_PS_TIMEOUT_MS })
    } catch { return null }
    const withStat = format.includes('stat=')
    const pattern = withStat
      ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/
      : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/
    const rows = new Map()
    const text = typeof result?.stdout === 'string' ? result.stdout : ''
    for (const line of text.split(/\r?\n/)) {
      const match = pattern.exec(line)
      if (!match) continue
      const pid = Number(match[1]), ppid = Number(match[2]), pgid = Number(match[3])
      const stat = withStat ? match[4] : null
      const start = (withStat ? match[5] : match[4]).trim()
      if (![pid, ppid, pgid].every(Number.isSafeInteger) || !start) continue
      rows.set(pid, { pid, ppid, pgid, start, stat })
    }
    return { ok: result?.status === 0 && rows.size > 0, rows }
  }
  const measured = read('pid=,ppid=,pgid=,stat=,lstart=')
  if (measured?.ok === true) return measured
  return read('pid=,ppid=,pgid=,lstart=') || measured || emptySnapshot()
}

export function escapedDescendants(snapshot, rootPid) {
  if (snapshot?.ok !== true || !(snapshot.rows instanceof Map)) return []
  const root = snapshot.rows.get(rootPid)
  if (!root) return []
  const children = new Map()
  for (const row of snapshot.rows.values()) {
    if (!row || !Number.isSafeInteger(row.ppid)) continue
    const list = children.get(row.ppid) || []
    list.push(row)
    children.set(row.ppid, list)
  }
  const out = []
  const seen = new Set([rootPid])
  const queue = [...(children.get(rootPid) || [])]
  while (queue.length) {
    const row = queue.shift()
    if (!row || seen.has(row.pid)) continue
    seen.add(row.pid)
    if (Number.isSafeInteger(row.pgid) && row.pgid > 1 && row.pgid !== root.pgid && !statIsZombie(row.stat)) {
      out.push({ pid: row.pid, pgid: row.pgid, start: row.start })
    }
    for (const child of children.get(row.pid) || []) queue.push(child)
  }
  return out
}

export function verifyGroup(candidate, snapshot, deps = {}) {
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal))
  const pgid = candidate?.pgid
  const refuse = (liveness, reason) => ({ signalable: false, liveness, reason, anchor: null })
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return refuse(LIVENESS.UNKNOWN, 'invalid-pgid')
  try {
    kill(-pgid, 0)
  } catch (err) {
    if (err?.code === 'ESRCH') return refuse(LIVENESS.DEAD, 'probe-dead')
    if (err?.code !== 'EPERM') return refuse(LIVENESS.UNKNOWN, 'probe-unknown')
  }
  if (snapshot?.ok !== true || !(snapshot.rows instanceof Map)) return refuse(LIVENESS.UNKNOWN, 'probe-unknown')
  let unreaped = null
  for (const anchor of Array.isArray(candidate?.anchors) ? candidate.anchors : []) {
    const row = snapshot.rows.get(anchor?.pid)
    if (!(row && row.pgid === pgid && anchor.pgid === pgid && row.start === anchor.start)) continue
    if (statIsZombie(row.stat)) { unreaped = unreaped || anchor; continue }
    return { signalable: true, liveness: LIVENESS.ALIVE, reason: 'probe-alive', anchor }
  }
  if (unreaped) {
    // A dead ANCHOR is not a dead GROUP: kill(-pgid, 0) stays positive while that
    // anchor is unreaped, and a `Z` state measures ONE pid. The matched anchor
    // binds the identity; the table decides liveness, and only a group with no
    // running member at all is dead.
    const peers = groupPeerState(pgid, snapshot)
    if (peers.state === LIVENESS.DEAD) return { signalable: false, liveness: LIVENESS.DEAD, reason: 'probe-dead', anchor: unreaped }
    if (peers.state === LIVENESS.UNKNOWN) return refuse(LIVENESS.UNKNOWN, 'probe-unknown')
    return { signalable: true, liveness: LIVENESS.ALIVE, reason: 'probe-alive', anchor: unreaped }
  }
  return refuse(LIVENESS.ALIVE, 'evidence-mismatch')
}

function descendantStorePath(taskDir) {
  return taskDir ? join(taskDir, DESCENDANT_DIR) : null
}

function recordNameKey(name) {
  return name.startsWith('.') && name.endsWith('.active.json') ? name.slice(1, -'.active.json'.length) : null
}

function descendantRecordEntries(dir) {
  if (!dir) return []
  let names
  try { names = fsReaddirSync(dir) } catch { return [] }
  const entries = []
  for (const name of names) {
    const key = recordNameKey(name)
    if (!key || name.includes('.json.tmp.')) continue
    const path = join(dir, name)
    try {
      const record = JSON.parse(String(fsReadFileSync(path, 'utf8')))
      if (record && typeof record === 'object' && typeof record.reservation_id === 'string' && record.reservation_id.trim()) {
        entries.push({ name, key, path, record })
      }
    } catch { /* corrupt records are inert to this pass */ }
  }
  return entries
}

function markerEntries(dir) {
  if (!dir) return []
  let names
  try { names = fsReaddirSync(dir) } catch { return [] }
  return names.filter((name) => /^\.(.+)\.active\.json$/.test(name) && !name.includes('.json.tmp.'))
}

function readMarker(dir, name) {
  try {
    const marker = JSON.parse(String(fsReadFileSync(join(dir, name), 'utf8')))
    return marker && typeof marker === 'object' ? marker : null
  } catch { return null }
}

function ownerLiveness(pid, deps = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return LIVENESS.UNKNOWN
  const kill = deps.kill || ((value, signal) => process.kill(value, signal))
  try { kill(pid, 0); return LIVENESS.ALIVE }
  catch (err) { return err?.code === 'ESRCH' ? LIVENESS.DEAD : LIVENESS.ALIVE }
}

function recordTimestamp(deps = {}) {
  let value
  try { value = typeof deps.now === 'function' ? deps.now() : Date.now() } catch { value = Date.now() }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
}

function engineClock(deps = {}) {
  return () => {
    try {
      const value = typeof deps.now === 'function' ? deps.now() : Date.now()
      return Number.isFinite(value) ? value : Date.now()
    } catch { return Date.now() }
  }
}

function descendantEngine(taskDir, deps = {}) {
  const dir = descendantStorePath(taskDir)
  const originalSleep = deps.sleep || defaultBlockingSleep
  return reservationEngine({
    dir,
    actor: `descendants:${process.pid}`,
    pathFor: (key) => join(dir, `.${key}.active.json`),
    lockNameFor: markerLockName,
    phases: { allowed: [PHASES.RESERVED, PHASES.RUNNING], preEffect: PHASES.RESERVED },
    deps: { ...deps, sleep: originalSleep, now: engineClock(deps) },
  })
}

function appendAnchor(group, anchor) {
  const anchors = Array.isArray(group.anchors) ? [...group.anchors] : []
  if (!anchors.some((item) => item?.pid === anchor.pid && item?.pgid === anchor.pgid && item?.start === anchor.start)) anchors.push(anchor)
  if (anchors.length > DESCENDANT_MAX_ANCHORS) {
    group.anchors = [anchors[0], ...anchors.slice(-(DESCENDANT_MAX_ANCHORS - 1))]
  } else group.anchors = anchors
}

function zeroCaptureSummary(ok = true) {
  return { ok, records: 0, captures: 0, missed_snapshots: 0, discovery_failures: 0 }
}

export function descendantCapture({ taskDir, log, deps = {} } = {}) {
  const storeDir = descendantStorePath(taskDir)
  let engine = null
  const getEngine = () => { if (!engine) engine = descendantEngine(taskDir, deps); return engine }
  const writeKnown = (states, force = false) => {
    if (!states.size || !storeDir || !fsExistsSync(storeDir)) return 0
    const store = getEngine()
    let writes = 0
    for (const state of states.values()) {
      if (state._new || state.record.swept_at != null) continue
      if (!state._changed && !force) continue
      try {
        store.advance({ key: state.key, reservation_id: state.record.reservation_id }, PHASES.RUNNING, state.patch)
        writes += 1
      } catch { /* another writer or a torn record leaves the next round to retry */ }
    }
    return writes
  }
  function round(force = false) {
    const snapshot = freshDescendantSnapshot(deps)
    const existing = fsExistsSync(storeDir) ? descendantRecordEntries(storeDir) : []
    if (snapshot.ok !== true) {
      const states = new Map()
      for (const entry of existing) {
        if (entry.record.swept_at != null) continue
        states.set(entry.key, {
          key: entry.key, record: entry.record, patch: { missed_snapshots: Number(entry.record.missed_snapshots) || 0 },
          _changed: true, _new: false,
        })
        states.get(entry.key).patch.missed_snapshots += 1
      }
      const writes = writeKnown(states, force)
      return { ...zeroCaptureSummary(false), records: writes, missed_snapshots: writes }
    }

    const states = new Map()
    for (const entry of existing) {
      if (entry.record.swept_at != null) continue
      states.set(entry.key, {
        key: entry.key, record: entry.record, original: JSON.stringify(entry.record), patch: {}, _changed: false, _new: false,
      })
    }
    let discoveries = 0
    let captures = 0
    let discoveryFailures = 0
    const knownFor = (dirName) => [...states.values()].filter((state) => {
      const transport = dirName === DESCENDANT_STORE_DIRS[HEADLESS_TRANSPORT] ? HEADLESS_TRANSPORT : HEADLESS_RPC_TRANSPORT
      return state.record.transport === transport && state.record.swept_at == null
    })
    const noteFailure = (dirName) => {
      discoveryFailures += 1
      for (const state of knownFor(dirName)) {
        state.record.discovery_failures = (Number(state.record.discovery_failures) || 0) + 1
        state.patch.discovery_failures = state.record.discovery_failures
        state._changed = true
      }
    }

    for (const [transport, dirName] of Object.entries(DESCENDANT_STORE_DIRS)) {
      const transportDir = join(taskDir, dirName)
      for (const name of markerEntries(transportDir)) {
        const marker = readMarker(transportDir, name)
        if (!marker || typeof marker.reservation_id !== 'string' || marker.reservation_id.trim() === '') {
          noteFailure(dirName)
          continue
        }
        const rootPid = marker.pid
        if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || !snapshot.rows.has(rootPid)) continue
        discoveries += 1
        const seatId = basename(String(marker.dir || '')) || String(marker.key)
        const key = `${dirName}__${seatId}__${marker.reservation_id}`
        let state = states.get(key)
        if (!state) {
          state = {
            key,
            record: {
              phase: PHASES.RUNNING,
              transport,
              role: marker.role ?? marker.key ?? null,
              seat_id: seatId,
              seat_reservation_id: marker.reservation_id,
              marker_owner_pid: Number.isSafeInteger(marker.owner?.pid) ? marker.owner.pid : null,
              owner_liveness: ownerLiveness(marker.owner?.pid, deps),
              root_pid: rootPid,
              root_pgid: snapshot.rows.get(rootPid)?.pgid ?? (Number.isSafeInteger(marker.pgid) ? marker.pgid : null),
              root_start: snapshot.rows.get(rootPid)?.start ?? null,
              groups: [], captures: 0, missed_snapshots: 0, discovery_failures: 0,
              root_settled: null, swept_at: null, sweep_id: null,
            },
            patch: {}, original: null, _changed: true, _new: true,
          }
          states.set(key, state)
        }
        if (state.record.swept_at != null) continue
        const row = snapshot.rows.get(rootPid)
        if (state.record.root_pid == null) state.record.root_pid = rootPid
        if (state.record.root_pgid == null) state.record.root_pgid = row?.pgid ?? marker.pgid ?? null
        if (state.record.root_start == null) state.record.root_start = row?.start ?? null
        if (state.record.marker_owner_pid == null && Number.isSafeInteger(marker.owner?.pid)) state.record.marker_owner_pid = marker.owner.pid
        if (state.record.owner_liveness == null) state.record.owner_liveness = ownerLiveness(marker.owner?.pid, deps)
        const groups = Array.isArray(state.record.groups) ? state.record.groups.map((group) => ({ ...group, anchors: Array.isArray(group.anchors) ? [...group.anchors] : [] })) : []
        const byPgid = new Map(groups.map((group) => [group.pgid, group]))
        for (const anchor of escapedDescendants(snapshot, rootPid)) {
          let group = byPgid.get(anchor.pgid)
          if (!group) {
            group = { pgid: anchor.pgid, anchors: [], first_seen_at: recordTimestamp(deps) }
            groups.push(group); byPgid.set(anchor.pgid, group)
          }
          appendAnchor(group, anchor)
        }
        state.record.groups = groups
        state.record.captures = (Number(state.record.captures) || 0) + 1
        state.patch = {
          transport: state.record.transport, role: state.record.role, seat_id: state.record.seat_id,
          seat_reservation_id: state.record.seat_reservation_id, marker_owner_pid: state.record.marker_owner_pid,
          owner_liveness: state.record.owner_liveness, root_pid: state.record.root_pid,
          root_pgid: state.record.root_pgid, root_start: state.record.root_start,
          groups: state.record.groups, captures: state.record.captures,
          missed_snapshots: Number(state.record.missed_snapshots) || 0,
          discovery_failures: Number(state.record.discovery_failures) || 0,
          root_settled: state.record.root_settled ?? null, swept_at: state.record.swept_at ?? null,
          sweep_id: state.record.sweep_id ?? null,
        }
        state._changed = state._new || state.original !== JSON.stringify(state.record)
        captures += 1
      }
    }
    for (const state of states.values()) {
      if (state._new) {
        try {
          getEngine().reserve(state.key, state.record)
        } catch { /* a concurrent reservation is retried on the next capture */ }
      } else if (state._changed || force) {
        try {
          getEngine().advance({ key: state.key, reservation_id: state.record.reservation_id }, PHASES.RUNNING, state.patch)
        } catch { /* a concurrent writer leaves the durable record authoritative */ }
      }
    }
    if (discoveries > 0 || captures > 0 || discoveryFailures > 0) {
      callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'descendant-capture', records: discoveries, captures, discovery_failures: discoveryFailures }))
    }
    return { ...zeroCaptureSummary(true), records: discoveries, captures, discovery_failures: discoveryFailures }
  }
  return { round }
}

function groupProbe(pgid, deps = {}) {
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal))
  try { kill(-pgid, 0); return { state: LIVENESS.ALIVE } }
  catch (err) {
    if (err?.code === 'ESRCH') return { state: LIVENESS.DEAD }
    if (err?.code === 'EPERM') return { state: LIVENESS.ALIVE, permission: true }
    return { state: LIVENESS.UNKNOWN }
  }
}

function signalGroup(pgid, signal, deps = {}) {
  const kill = deps.kill || ((pid, value) => process.kill(pid, value))
  try { kill(-pgid, signal); return { state: LIVENESS.ALIVE } }
  catch (err) {
    if (err?.code === 'ESRCH') return { state: LIVENESS.DEAD }
    if (err?.code === 'EPERM') return { state: LIVENESS.ALIVE, refused: true }
    return { state: LIVENESS.UNKNOWN, refused: true }
  }
}

function pollGroupUntilDead(pgid, deps = {}) {
  const sleep = deps.sleep || defaultBlockingSleep
  for (let i = 0; i < DESCENDANT_SETTLE_POLLS; i += 1) {
    const probe = groupProbe(pgid, deps)
    if (probe.state === LIVENESS.DEAD) return probe
    if (i + 1 < DESCENDANT_SETTLE_POLLS) sleep(DESCENDANT_SETTLE_MS)
  }
  return groupProbe(pgid, deps)
}

// Group liveness measured from a ps TABLE, never from kill(-pgid, 0): an unreaped
// member keeps signal zero positive forever, so only the snapshot can say whether
// any member of the group is still RUNNING. A table we could not read is unknown,
// never a death claim.
function groupPeerState(pgid, snapshot) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return { state: LIVENESS.UNKNOWN }
  if (snapshot?.ok !== true || !(snapshot.rows instanceof Map)) return { state: LIVENESS.UNKNOWN }
  for (const member of snapshot.rows.values()) {
    if (member?.pgid === pgid && !statIsZombie(member.stat)) return { state: LIVENESS.ALIVE }
  }
  return { state: LIVENESS.DEAD }
}

function pollGroupPeersUntilGone(pgid, deps = {}) {
  const sleep = deps.sleep || defaultBlockingSleep
  let probe = groupPeerState(pgid, freshDescendantSnapshot(deps))
  for (let i = 0; i < DESCENDANT_SETTLE_POLLS && probe.state === LIVENESS.ALIVE; i += 1) {
    sleep(DESCENDANT_SETTLE_MS)
    probe = groupPeerState(pgid, freshDescendantSnapshot(deps))
  }
  return probe
}

// A root that is an exact ZOMBIE row has already passed the pgid/start binding,
// so unlike an ABSENT root it still safely identifies -root_pgid. Its live
// same-pgid peers are excluded from descendant capture, so no later escaped-group
// sweep will ever reclaim them: settle them here, on the same TERM/KILL ladder,
// measuring what remains from ps rather than from signal zero.
function settleZombieRootPeers(pgid, deps = {}) {
  const unproven = { result: { root_settled: 'unproven', root_liveness: LIVENESS.DEAD, reason: 'probe-unknown' }, tally: 'unproven' }
  const proven = { result: { root_settled: 'proven', root_liveness: LIVENESS.DEAD, reason: 'probe-dead' }, tally: 'settled' }
  const term = signalGroup(pgid, 'SIGTERM', deps)
  if (term.state === LIVENESS.UNKNOWN || term.refused) return unproven
  let peers = pollGroupPeersUntilGone(pgid, deps)
  if (peers.state === LIVENESS.DEAD) return proven
  if (peers.state === LIVENESS.UNKNOWN) return unproven
  const killed = signalGroup(pgid, 'SIGKILL', deps)
  if (killed.state === LIVENESS.UNKNOWN || killed.refused) return unproven
  peers = pollGroupPeersUntilGone(pgid, deps)
  if (peers.state === LIVENESS.DEAD) return proven
  if (peers.state === LIVENESS.UNKNOWN) return unproven
  return { result: { root_settled: 'failed', root_liveness: LIVENESS.DEAD, reason: 'probe-alive' }, tally: 'failed' }
}

function rootBinding(record, snapshot, deps = {}) {
  if (snapshot?.ok !== true || !(snapshot.rows instanceof Map)) return { state: LIVENESS.UNKNOWN, reason: 'probe-unknown', row: null }
  const row = snapshot.rows.get(record.root_pid)
  if (!row) return { state: LIVENESS.DEAD, reason: 'probe-dead', row: null }
  if (row.pgid !== record.root_pgid || row.start !== record.root_start) return { state: LIVENESS.UNKNOWN, reason: 'root-unidentified', row }
  // On Darwin a synchronous parent observes its killed child as a zombie for
  // the duration of this stack. An EPERM group probe with the exact bound row
  // is that transient post-signal state; only use the local process probe (not
  // an injected cross-uid probe) for this reaping seam.
  if (!deps.kill) {
    const probe = groupProbe(record.root_pgid, deps)
    if (probe.state === LIVENESS.DEAD) return { state: LIVENESS.DEAD, reason: 'probe-dead', row }
    if (probe.permission && processIsZombie(record.root_pid) && markLocallySettledGroup(record.root_pid, record.root_pgid)) {
      return { state: LIVENESS.DEAD, reason: 'probe-dead', row }
    }
  }
  // ps prints what signal-zero cannot: a `Z` state is a root that has already
  // terminated and is merely unreaped. Treat the PROCESS as dead — the existing,
  // already-proven sweep path — while keeping the binding that still identifies
  // its process group.
  if (statIsZombie(row.stat)) return { state: LIVENESS.DEAD, reason: 'probe-dead', row, zombie: true }
  return { state: LIVENESS.ALIVE, reason: 'probe-alive', row }
}

function zeroRootSummary() {
  return { records: 0, settled: 0, already_dead: 0, unidentified: 0, failed: 0, unproven: 0 }
}

export function settleSeatRoots({ taskDir, log, deps = {} } = {}) {
  const storeDir = descendantStorePath(taskDir)
  const capture = descendantCapture({ taskDir, log, deps })
  try { capture.round(true) } catch { /* capture is evidence, never a teardown blocker */ }
  if (!storeDir || !fsExistsSync(storeDir)) return zeroRootSummary()
  const entries = descendantRecordEntries(storeDir)
  if (!entries.length) return zeroRootSummary()
  const engine = descendantEngine(taskDir, deps)
  const summary = zeroRootSummary()
  for (const entry of entries) {
    const record = entry.record
    if (record.swept_at != null || record.root_settled != null) continue
    summary.records += 1
    let result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: 'probe-unknown' }
    try {
      const initial = freshDescendantSnapshot(deps)
      const bound = rootBinding(record, initial, deps)
      if (bound.state === LIVENESS.DEAD) {
        // An ABSENT root has lost its identity and any claim on a pgid with it; an
        // exact zombie row has not. Only the zombie case may still settle
        // -root_pgid, and only while ps shows a non-zombie member of that group.
        const peers = bound.zombie === true ? groupPeerState(record.root_pgid, initial) : { state: LIVENESS.DEAD }
        if (peers.state === LIVENESS.ALIVE) {
          const settled = settleZombieRootPeers(record.root_pgid, deps)
          result = settled.result
          summary[settled.tally] += 1
        } else if (peers.state === LIVENESS.UNKNOWN) {
          result = { root_settled: 'unproven', root_liveness: LIVENESS.DEAD, reason: 'probe-unknown' }
          summary.unproven += 1
        } else {
          result = { root_settled: 'already-dead', root_liveness: LIVENESS.DEAD, reason: 'probe-dead' }
          summary.already_dead += 1
        }
      } else if (bound.reason === 'root-unidentified') {
        // Only a PRESENT row that contradicts the captured identity is a measured
        // mismatch. An unavailable snapshot measured nothing at all, and an
        // unmeasured table is `unproven` — never an identity fact (RV3-1).
        result = { root_settled: 'root-unidentified', root_liveness: LIVENESS.UNKNOWN, reason: 'root-unidentified' }
        summary.unidentified += 1
      } else if (bound.state !== LIVENESS.ALIVE) {
        result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: bound.reason || 'probe-unknown' }
        summary.unproven += 1
      } else if (!Number.isSafeInteger(record.root_pgid) || record.root_pgid <= 1) {
        result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: 'invalid-pgid' }
        summary.unproven += 1
      } else {
        const term = signalGroup(record.root_pgid, 'SIGTERM', deps)
        if (term.state === LIVENESS.DEAD) {
          result = { root_settled: 'proven', root_liveness: LIVENESS.DEAD, reason: 'probe-dead' }
          summary.settled += 1
        } else if (term.state === LIVENESS.UNKNOWN || term.refused) {
          result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: 'probe-unknown' }
          summary.unproven += 1
        } else {
          const afterTerm = pollGroupUntilDead(record.root_pgid, deps)
          if (afterTerm.state === LIVENESS.DEAD) {
            result = { root_settled: 'proven', root_liveness: LIVENESS.DEAD, reason: 'probe-dead' }
            summary.settled += 1
          } else if (afterTerm.state === LIVENESS.UNKNOWN || afterTerm.permission) {
            result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: 'probe-unknown' }
            summary.unproven += 1
          } else {
            const beforeKill = freshDescendantSnapshot(deps)
            const rebound = rootBinding(record, beforeKill, deps)
            if (rebound.state !== LIVENESS.ALIVE) {
              result = { root_settled: rebound.reason === 'root-unidentified' ? 'root-unidentified' : rebound.state === LIVENESS.DEAD ? 'proven' : 'unproven', root_liveness: rebound.state === LIVENESS.DEAD ? LIVENESS.DEAD : LIVENESS.UNKNOWN, reason: rebound.reason }
              if (result.root_settled === 'root-unidentified') summary.unidentified += 1
              else if (result.root_settled === 'proven') summary.settled += 1
              else summary.unproven += 1
            } else {
              const killed = signalGroup(record.root_pgid, 'SIGKILL', deps)
              if (killed.state === LIVENESS.DEAD) {
                result = { root_settled: 'proven', root_liveness: LIVENESS.DEAD, reason: 'probe-dead' }
                summary.settled += 1
              } else if (killed.state === LIVENESS.UNKNOWN || killed.refused) {
                result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: 'probe-unknown' }
                summary.unproven += 1
              } else {
                const afterKill = pollGroupUntilDead(record.root_pgid, deps)
                if (afterKill.state === LIVENESS.DEAD) {
                  result = { root_settled: 'proven', root_liveness: LIVENESS.DEAD, reason: 'probe-dead' }
                  summary.settled += 1
                } else if (afterKill.state === LIVENESS.UNKNOWN || afterKill.permission) {
                  result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: 'probe-unknown' }
                  summary.unproven += 1
                } else {
                  result = { root_settled: 'failed', root_liveness: LIVENESS.ALIVE, reason: 'probe-alive' }
                  summary.failed += 1
                }
              }
            }
          }
        }
      }
    } catch {
      result = { root_settled: 'unproven', root_liveness: LIVENESS.UNKNOWN, reason: 'probe-unknown' }
      summary.unproven += 1
    }
    try {
      engine.advance({ key: entry.key, reservation_id: record.reservation_id }, PHASES.RUNNING, {
        root_liveness: result.root_liveness, root_settled: result.root_settled,
      })
    } catch { /* leave the record retryable for a later teardown */ }
    callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'seat-root-settle', ...record, ...result }))
  }
  callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'seat-root-settle-sweep', ...summary }))
  return summary
}

function zeroSweepSummary(sweep_id) {
  return {
    sweep_id, records: 0, swept: 0, skipped: 0, retryable: 0, snapshot_ok: true,
    groups: 0, reclaimed: 0, live: 0, identity_refused: 0, probe_unknown: 0,
    signalled: 0, recorded: 0, record_failed: 0, incomplete: 0, coverage_outcome: 'unproven',
  }
}

function coverageReason(record, captures, missed, failures, rootSettled) {
  const parts = [`captures=${captures}`, `missed-snapshots=${missed}`, `discovery-failures=${failures}`]
  const owner = record.owner_liveness || null
  if (owner === LIVENESS.DEAD) parts.push('owner-dead')
  else if (owner === LIVENESS.ALIVE) parts.push('owner-alive')
  if (Array.isArray(record.groups) && record.groups.some((group) => (group.anchors?.length || 0) >= DESCENDANT_MAX_ANCHORS)) parts.push('capped-anchors')
  if (rootSettled) parts.push(`root-${rootSettled}`)
  return parts.join(' ')
}

export function reclaimDescendants({ taskDir, log, emit, deps = {} } = {}) {
  const sweepId = typeof deps.uuid === 'function' ? deps.uuid() : randomUUID()
  const storeDir = descendantStorePath(taskDir)
  if (!storeDir || !fsExistsSync(storeDir)) {
    const empty = zeroSweepSummary(sweepId)
    callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'descendant-reclaim-sweep', ...empty }))
    return empty
  }
  const entries = descendantRecordEntries(storeDir)
  const summary = zeroSweepSummary(sweepId)
  summary.records = 0
  summary.skipped = entries.filter((entry) => entry.record.swept_at != null).length
  if (!entries.length) {
    callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'descendant-reclaim-sweep', ...summary }))
    return summary
  }
  const engine = descendantEngine(taskDir, deps)
  for (const entry of entries) {
    const record = entry.record
    if (record.swept_at != null) continue
    summary.records += 1
    let row
    try {
      let rootSnapshot = freshDescendantSnapshot(deps)
      let recordSnapshotOk = rootSnapshot.ok === true
      if (!recordSnapshotOk) summary.snapshot_ok = false
      let root = rootBinding(record, rootSnapshot, deps)
      // A run-end SIGKILL can be delivered just after the capture round while
      // this synchronous driver is still unwinding. Observe that bounded race;
      // an actually live root remains untouched and is still root-alive.
      if (root.state === LIVENESS.ALIVE && !deps.kill) {
        const sleep = deps.sleep || defaultBlockingSleep
        for (let i = 1; i < DESCENDANT_SETTLE_POLLS && root.state === LIVENESS.ALIVE; i += 1) {
          sleep(DESCENDANT_SETTLE_MS)
          rootSnapshot = freshDescendantSnapshot(deps)
          if (rootSnapshot.ok !== true) { recordSnapshotOk = false; summary.snapshot_ok = false; break }
          root = rootBinding(record, rootSnapshot, deps)
        }
      }
      const rootUnidentified = root.reason === 'root-unidentified'
      const rootState = rootUnidentified ? LIVENESS.DEAD : root.state
      let rootLiveness = rootUnidentified ? LIVENESS.DEAD : root.state
      let rootReason = root.reason
      const captured = Array.isArray(record.groups) ? record.groups.length : 0
      summary.groups += captured
      let signalled = 0, reclaimed = 0, live = 0, identityRefused = 0, probeUnknown = 0
      let reason = rootReason
      if (rootState === LIVENESS.ALIVE) {
        reason = 'root-alive'
      } else if (rootState === LIVENESS.UNKNOWN) {
        reason = rootReason || 'probe-unknown'
        if (rootReason === 'probe-unknown') { summary.snapshot_ok = false; recordSnapshotOk = false }
      } else {
        const groups = Array.isArray(record.groups) ? record.groups : []
        for (const group of groups) {
          const beforeTerm = freshDescendantSnapshot(deps)
          if (beforeTerm.ok !== true) {
            summary.snapshot_ok = false; recordSnapshotOk = false; probeUnknown += 1; continue
          }
          const verdict = verifyGroup(group, beforeTerm, deps)
          if (verdict.liveness === LIVENESS.DEAD) { reclaimed += 1; continue }
          if (verdict.reason === 'evidence-mismatch') { identityRefused += 1; continue }
          if (verdict.reason === 'probe-unknown' || verdict.reason === 'invalid-pgid') { probeUnknown += 1; continue }
          const term = signalGroup(group.pgid, 'SIGTERM', deps)
          if (term.state === LIVENESS.DEAD) { reclaimed += 1; continue }
          if (term.state === LIVENESS.UNKNOWN || term.refused) { probeUnknown += 1; continue }
          signalled += 1
          const afterTerm = pollGroupUntilDead(group.pgid, deps)
          if (afterTerm.state === LIVENESS.DEAD) { reclaimed += 1; continue }
          // An UNMEASURED group is never escalated to. Opaque errno and EPERM both
          // say the probe could not adjudicate, and a SIGKILL taken on that
          // non-answer would read its own ESRCH as proof of a death nothing
          // measured. Count it unknown, leave the record retryable (RV3-2).
          if (afterTerm.state === LIVENESS.UNKNOWN || afterTerm.permission) { probeUnknown += 1; continue }
          const beforeKill = freshDescendantSnapshot(deps)
          if (beforeKill.ok !== true) { summary.snapshot_ok = false; recordSnapshotOk = false; probeUnknown += 1; continue }
          const rebound = verifyGroup(group, beforeKill, deps)
          if (rebound.liveness === LIVENESS.DEAD) { reclaimed += 1; continue }
          if (!rebound.signalable || rebound.reason === 'evidence-mismatch') { identityRefused += 1; continue }
          if (rebound.reason === 'probe-unknown' || rebound.reason === 'invalid-pgid') { probeUnknown += 1; continue }
          const killed = signalGroup(group.pgid, 'SIGKILL', deps)
          if (killed.state === LIVENESS.DEAD) { reclaimed += 1; continue }
          if (killed.state === LIVENESS.UNKNOWN || killed.refused) { probeUnknown += 1; continue }
          const afterKill = pollGroupUntilDead(group.pgid, deps)
          if (afterKill.state === LIVENESS.DEAD) reclaimed += 1
          // A cross-uid EPERM is a refused measurement, not a live group: only a
          // probe that ANSWERED may count a group live (RV3-3).
          else if (afterKill.state === LIVENESS.UNKNOWN || afterKill.permission) probeUnknown += 1
          else live += 1
        }
        if (live > 0) reason = 'probe-alive'
        else if (identityRefused > 0) reason = 'evidence-mismatch'
        else if (probeUnknown > 0 || recordSnapshotOk !== true) reason = 'probe-unknown'
        else if (captured > 0 && reclaimed === captured) reason = 'probe-dead'
        else reason = 'no-candidates'
      }
      const captures = Number(record.captures) || 0
      const missed = Number(record.missed_snapshots) || 0
      const failures = Number(record.discovery_failures) || 0
      const owner = record.owner_liveness || ownerLiveness(record.owner?.pid, deps)
      if (!record.owner_liveness) record.owner_liveness = owner
      const rootSettled = record.root_settled || null
      const outcome = live > 0 ? 'failed'
        : identityRefused > 0 || probeUnknown > 0 || recordSnapshotOk !== true || rootState === LIVENESS.UNKNOWN ? 'unproven'
          : captured > 0 && reclaimed === captured ? 'proven' : 'unproven'
      const coverage = coverageReason({ ...record, owner_liveness: owner }, captures, missed, failures, rootSettled)
      row = {
        adw_id: record.adw_id ?? null, phase_id: record.phase_id ?? null,
        transport: record.transport ?? null, seat_id: record.seat_id ?? null,
        reservation_id: record.seat_reservation_id ?? record.reservation_id,
        sweep_id: sweepId, role: record.role ?? null,
        owner_pid: record.marker_owner_pid ?? record.owner?.pid ?? null,
        owner_liveness: owner, root_pid: record.root_pid ?? null, root_pgid: record.root_pgid ?? null,
        root_start: record.root_start ?? null, root_liveness: rootLiveness,
        root_settled: rootSettled, captures, missed_snapshots: missed,
        discovery_failures: failures, captured, signalled, reclaimed, live,
        identity_refused: identityRefused, probe_unknown: probeUnknown,
        outcome, reason, coverage_outcome: 'unproven', coverage_reason: coverage,
        created_at: recordTimestamp(deps),
      }
      callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'descendant-reclaim', ...row }))
      let receipt = true
      if (typeof emit === 'function') {
        receipt = callTeardownCallback(() => emit({ kind: 'seat-reclaim', ...row }) === true) === true
        if (receipt) summary.recorded += 1
        else {
          summary.record_failed += 1
          callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'descendant-reclaim-record-failed', ...row }))
        }
      }
      const terminal = (outcome === 'proven' || (captured === 0 && rootLiveness === LIVENESS.DEAD)) && receipt
      if (terminal) summary.swept += 1
      else summary.retryable += 1
      if (captured > 0 && outcome !== 'proven') summary.incomplete += 1
      summary.reclaimed += reclaimed; summary.live += live; summary.identity_refused += identityRefused
      summary.probe_unknown += probeUnknown; summary.signalled += signalled
      try {
        engine.advance({ key: entry.key, reservation_id: record.reservation_id }, PHASES.RUNNING, {
          owner_liveness: owner, sweep_id: sweepId, ...(terminal ? { swept_at: recordTimestamp(deps) } : { swept_at: null }),
        })
      } catch { /* row remains retryable if its durable stamp could not be written */ }
    } catch (err) {
      summary.retryable += 1
      callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'descendant-reclaim-error', key: entry.key, reason: 'probe-unknown' }))
    }
  }
  callTeardownCallback(() => log?.({ at: recordTimestamp(deps), event: 'descendant-reclaim-sweep', ...summary }))
  return summary
}

const HERE = dirname(fileURLToPath(import.meta.url))

// One rung stronger = the SAME seat's cell one tier up, read from the crew
// RUNTIME's own roster (the rule crew/crew.mjs:364-371 states), never the
// target checkout's. No new roster field, no ctx plumbing, no boot change.
export const RESEAT_LADDER = Object.freeze(['mechanical', 'build', 'judge'])
export const RESEAT_REASONS = Object.freeze(['transport', 'exhausted', 'no-tier', 'agent-change'])

// The shipped adapters' roster-cell translations, keyed by the seat's own
// `agent` name — the same "injected wins, shipped default otherwise" shape
// crew/headless.mjs:128 and crew/headless-rpc.mjs:122 already use for command
// composition (#239). seatIo is synchronous, so it cannot do crew.mjs's
// dynamic import(): an agent whose adapter is not one of these two has nothing
// here that can vouch for the translation, and reseat refuses rather than
// writing a bare id.
const SHIPPED_MODEL_STRINGS = Object.freeze({ claude: claudeModelString, pi: piModelString })

export function modelStringFor(adapters, role, agent) {
  const injected = adapters?.[role]?.adapter
  if (typeof injected?.modelString === 'function') return injected.modelString.bind(injected)
  const shipped = SHIPPED_MODEL_STRINGS[String(agent)]
  return typeof shipped === 'function' ? shipped : null
}

export function nextRung(roster, tier, role) {
  const tiers = roster?.tiers || roster
  const index = RESEAT_LADDER.indexOf(tier)
  if (index < 0 || index >= RESEAT_LADDER.length - 1) return null
  const next = RESEAT_LADDER[index + 1]
  const cell = tiers?.[next]?.[role]
  if (!cell || typeof cell !== 'object') return null
  return {
    rung: `${tier}→${next}`,
    cell: { provider: cell.provider, id: cell.id, effort: cell.effort, agent: cell.agent },
  }
}

export function nextModelRung(roster, cell) {
  try {
    const provider = cell?.provider
    const id = cell?.id
    if (typeof provider !== 'string' || provider.trim() === '' || typeof id !== 'string' || id.trim() === '') return null
    const models = roster?.models
    if (!models || typeof models !== 'object' || Array.isArray(models)) return null
    const currentKey = `${provider}/${id}`
    if (!Object.hasOwn(models, currentKey)) return null
    const current = models[currentKey]
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Number.isFinite(current.cost_in_per_mtok)) return null
    const prefix = `${provider}/`
    const candidates = []
    for (const [key, entry] of Object.entries(models)) {
      if (!key.startsWith(prefix)) continue
      const nextId = key.slice(prefix.length)
      if (!nextId || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (!Number.isFinite(entry.cost_in_per_mtok) || entry.cost_in_per_mtok <= current.cost_in_per_mtok) continue
      if (Array.isArray(entry.tags) && entry.tags.includes('override-only')) continue
      candidates.push({ id: nextId, cost: entry.cost_in_per_mtok })
    }
    candidates.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const next = candidates[0]
    if (!next) return null
    return {
      rung: `model:${id}→${next.id}`,
      cell: { provider, id: next.id, effort: cell.effort, agent: cell.agent },
    }
  } catch { return null }
}

function addTotals(prev, delta) {
  return {
    billed_input_tokens: (prev?.billed_input_tokens ?? 0) + (delta?.billed_input_tokens ?? 0),
    billed_output_tokens: (prev?.billed_output_tokens ?? 0) + (delta?.billed_output_tokens ?? 0),
    billed_cache_write_tokens: (prev?.billed_cache_write_tokens ?? 0) + (delta?.billed_cache_write_tokens ?? 0),
    billed_cache_read_tokens: (prev?.billed_cache_read_tokens ?? 0) + (delta?.billed_cache_read_tokens ?? 0),
  }
}

// crew/crew.mjs boots with this name; the BYTES have one owner
// (crew/headless.mjs writeCrewJson), so this delegates rather than carrying a
// second copy of the same tmp+rename discipline (#539).
export function saveCrew(paths, crew, fs = {}) {
  writeCrewJson(paths, crew, fs)
}

export function resolveWorkerBin(args = {}) {
  const explicit = args['claude-bin']
  const env = process.env.CREW_CLAUDE_BIN
  const home = join(homedir(), '.local', 'bin', 'claude')
  const candidates = [
    ['--claude-bin', explicit],
    ['$CREW_CLAUDE_BIN', env],
    ['${HOME}/.local/bin/claude', home],
  ]
  for (const [label, candidate] of candidates) {
    if (!candidate) continue
    if (!String(candidate).startsWith('/')) {
      if (label === '--claude-bin' || label === '$CREW_CLAUDE_BIN') throw new Error(`headless worker binary ${label} must be an absolute path, got ${JSON.stringify(candidate)}`)
      continue
    }
    if (fsExistsSync(candidate)) return candidate
  }
  throw new Error(`no frozen headless worker binary found: checked --claude-bin, $CREW_CLAUDE_BIN, and ${home} (spike-findings.md:39-48)`)
}

export function docOpenArgs({ path, workspaceId, windowId }) {
  return ['open', path, '--workspace', workspaceId, '--window', windowId, '--direction', 'down', '--focus', 'false']
}

function newSurfaceIds(before, after) {
  const seen = new Set()
  for (const w of before.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || []) for (const s of p.surfaces || []) seen.add(s.id)
  const fresh = []
  for (const w of after.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || []) for (const s of p.surfaces || []) if (!seen.has(s.id)) fresh.push(s.id)
  return fresh
}

// Blueprint variants (#251): a shape's opening stage IS its own name; a bounded
// triage is that shape's planning phase. An envelope shape's acceptance is a
// terminal settle, not a build. A DATA map, so a new member is a data edit here
// too — not a new branch. Duplicated rather than imported: seat-io must not
// import the driver (the MODIFIER_OUTCOMES convention at :608); crew/crew.test.mjs
// pins this map against crew/drive.mjs's enum.
export const VARIANT_STAGE_PHASES = Object.freeze({ scout: 'planning', repair: 'planning', directed: 'planning', 'envelope-accept': 'finish' })

export function phaseForStage(label) {
  const head = String(label ?? '').split(':')[0]
  if (head === 'plan' || head === 'check') return 'planning'
  const declared = Object.prototype.hasOwnProperty.call(VARIANT_STAGE_PHASES, head)
    ? VARIANT_STAGE_PHASES[head] : null
  if (declared) return declared
  if (['build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify'].includes(head)) return 'build'
  if (head === 'review') return 'review'
  if (head === 'suite' || head === 'commit') return 'finish'
  if (head === 'done') return 'done'
  if (head === 'escalate') return 'escalation'
  return 'build'
}

// Map a transport's own err.stage onto the ledger's closed availability set.
// The stage strings are the transports' (crew/headless.mjs:204-212/:298,
// crew/headless-rpc.mjs:133-138, pane read boundary, waitForEnvelope :248);
// anything unrecognised is a transport error, never a silent drop.
// 'substrate-gone' deliberately falls through to transport-error; never fold it into seat-died.
export function cellFailureKind(err) {
  const stage = String((err && err.stage) || '')
  if (stage === 'seat-died') return 'seat-died'
  const tail = stage.replace(/^(headless|rpc|pane)-/, '')
  if (tail !== stage) {
    if (tail === 'timeout') return 'timeout'
    if (tail === 'no-envelope') return 'no-envelope'
    if (tail === 'malformed' || tail === 'parse-error') return 'unusable-envelope'
    if (tail === 'aborted') return 'aborted'
  }
  return 'transport-error'
}

export function emitAdapter(emitter, crew = null) {
  // The emitter owns the phase cursor and hands it back from every
  // phaseTransition; carry it onto every event so agent rows can be
  // associated with the phase they ran in (#123). A null cursor (degraded
  // emitter, or events before the first stage) is what recordEvent already
  // stores today, so this can never change a run.
  let phaseId = null
  const usageTotals = new Map()
  const record = (type, payload) => emitter.emit((handle, nextSeq) => handle.recordEvent({
    adw_id: emitter.adwId, type, seq: nextSeq('event'), phase_id: phaseId, payload,
  }))
  return (event) => {
    if (!event || typeof event !== 'object') return
    if (event.kind === 'stage') {
      const t = emitter.phaseTransition(phaseForStage(event.label))
      phaseId = typeof t?.phase_id === 'number' ? t.phase_id : null
      record('log', { level: 'info', message: event.label })
    } else if (event.kind === 'assign') {
      record('agent_start', { role: event.role, dispatch_id: event.id })
    } else if (event.kind === 'envelope') {
      record('agent_end', { role: event.role, outcome: event.status, dispatch_id: event.id })
      if (event.review) {
        // The reviewing seat's CELL, read from the booted crew — the same
        // source and the same reason as the cell-failure branch below (:1080):
        // the driver only ever knows the role. This is what makes a PANE
        // review attributable at all: a pane seat emits no `usage` frame, so
        // agent_sessions never gets a row to join (#404). Spread ONLY when the
        // role is seated: an unseated role has no cell, and
        // recordReviewOutcome's own `?? null` is the single place absence is
        // decided.
        const m = (crew && crew.members && crew.members[event.role]) || null
        emitter.emit((handle) => handle.recordReviewOutcome({
          adw_id: emitter.adwId, phase_id: phaseId, dispatch_id: event.id, role: event.role,
          verdict: event.review.verdict, must_fix: event.review.must_fix ?? null,
          should_fix: event.review.should_fix ?? null, consider: event.review.consider ?? null,
          ...(m ? {
            agent: m.agent ?? null, provider: m.provider ?? null, model_id: m.id ?? null,
            model: m.model ?? null, effort: m.effort ?? null, transport: m.transport ?? null,
          } : {}),
        }))
      }
    } else if (event.kind === 'decision') {
      record('decision', { decided: event.decided, why: event.why })
    } else if (event.kind === 'dissent') {
      record('decision', {
        decided: event.lead_decision,
        why: `dissent from ${event.from}`,
        alternatives: [event.recommendation],
      })
    } else if (event.kind === 'gate') {
      // The ledger's own gate tables, not a generic log row (#130).
      emitter.emit((handle) => handle.recordGateResult({
        adw_id: emitter.adwId, phase_id: phaseId,
        gate_name: String(event.name ?? 'gate'), attempt: event.attempt, ok: !!event.ok,
        checks: event.summary ? [event.summary] : [], violations: [],
        gate_generation: event.generation ?? null, pristine: !!event.pristine,
      }))
    } else if (event.kind === 'discrimination') {
      emitter.emit((handle) => handle.recordGateDiscrimination({
        adw_id: emitter.adwId, phase_id: phaseId, gate_generation: event.generation,
        verdict: event.verdict, checks_total: event.summary?.total ?? null,
        checks_failed: event.summary?.failed ?? null, checks_errored: event.summary?.errored ?? null,
        note: event.note ?? null,
      }))
    } else if (event.kind === 'accept-decision') {
      const residuals = Array.isArray(event.residuals) ? event.residuals : []
      const refuted = Array.isArray(event.refuted) ? event.refuted : []
      const unverified = Array.isArray(event.unverified) ? event.unverified : []
      const errors = Array.isArray(event.errors) ? event.errors : []
      emitter.emit((handle) => handle.recordAcceptDecision({
        adw_id: emitter.adwId, phase_id: phaseId, where: event.where, outcome: event.outcome,
        findings_total: event.findings_total ?? null,
        residual_count: residuals.length,
        refuted_count: refuted.length,
        cosmetic_count: residuals.filter((residual) => residual.type === 'cosmetic').length,
        unverified_count: unverified.length,
        invalid_reasons: errors.map(({ id, why }) => `${id ?? ''}: ${why}`).join('; '),
      }))
    } else if (event.kind === 'seat-teardown') {
      const m = (crew && crew.members && crew.members[event.role]) || null
      return emitter.emit((handle) => handle.recordSeatTeardown({
        adw_id: emitter.adwId, phase_id: phaseId, role: event.role ?? null,
        transport: event.transport ?? m?.transport ?? null,
        session_id: event.session_id ?? null, pgid: event.pgid ?? null,
        reservation_id: event.reservation_id ?? null, outcome: event.outcome,
        reason: event.reason ?? null, forced: event.forced ? 1 : 0,
        evidence_kind: event.evidence_kind ?? null,
      }))
    } else if (event.kind === 'seat-reclaim') {
      return emitter.emit((handle) => handle.recordSeatReclaim({
        adw_id: emitter.adwId, phase_id: phaseId,
        transport: event.transport, seat_id: event.seat_id,
        reservation_id: event.reservation_id, sweep_id: event.sweep_id,
        role: event.role ?? null, owner_pid: event.owner_pid ?? null,
        owner_liveness: event.owner_liveness ?? null, root_pid: event.root_pid ?? null,
        root_pgid: event.root_pgid ?? null, root_start: event.root_start ?? null,
        root_liveness: event.root_liveness ?? null, root_settled: event.root_settled ?? null,
        captures: event.captures ?? 0, missed_snapshots: event.missed_snapshots ?? 0,
        discovery_failures: event.discovery_failures ?? 0, captured: event.captured ?? 0,
        signalled: event.signalled ?? 0, reclaimed: event.reclaimed ?? 0,
        live: event.live ?? 0, identity_refused: event.identity_refused ?? 0,
        probe_unknown: event.probe_unknown ?? 0, outcome: event.outcome,
        reason: event.reason ?? null, coverage_outcome: event.coverage_outcome,
        coverage_reason: event.coverage_reason ?? null, created_at: event.created_at ?? null,
      }))
    } else if (event.kind === 'cell-failure') {
      // AVAILABILITY, not quality: the cell could not hold its seat or produce
      // anything usable. The cell itself is read from the booted crew, because
      // the driver only ever knows the role.
      const m = (crew && crew.members && crew.members[event.role]) || null
      emitter.emit((handle) => handle.recordCellFailure({
        adw_id: emitter.adwId, task_slug: (crew && crew.task) || null, phase_id: phaseId,
        dispatch_id: event.id ?? null, role: event.role ?? null,
        agent: m?.agent ?? null, provider: m?.provider ?? null, model_id: m?.id ?? null,
        model: m?.model ?? null, effort: m?.effort ?? null, transport: m?.transport ?? null,
        kind: event.failure, stage: event.stage ?? null, detail: event.detail ?? null,
        attribution: event.attribution ?? null,
      }))
    } else if (event.kind === 'modifier') {
      // MEASUREMENT, not policy (#238): every ATTEMPT lands a row, applied or not.
      // The transport is read from the booted crew because the driver only ever
      // knows the role — the same reason cell-failure enriches above.
      const m = (crew && crew.members && crew.members[event.role]) || null
      const cell = (c) => ({
        provider: c?.provider ?? null, model_id: c?.id ?? null, model: c?.model ?? null,
        agent: c?.agent ?? null, effort: c?.effort ?? null,
      })
      const from = cell(event.from || m)   // a null `from` means the role was not seated
      const to = cell(event.to)            // non-null iff the attempt APPLIED
      try {
        emitter.emit((handle) => handle.recordModifierAttempt({
          adw_id: emitter.adwId, task_slug: (crew && crew.task) || null, phase_id: phaseId,
          role: event.role ?? null, modifier: event.modifier, bounce: event.bounce ?? null,
          outcome: event.outcome, why: event.why ?? null, rung: event.rung ?? null,
          transport: m?.transport ?? null,
          from_provider: from.provider, from_model_id: from.model_id, from_model: from.model,
          from_agent: from.agent, from_effort: from.effort,
          to_provider: to.provider, to_model_id: to.model_id, to_model: to.model,
          to_agent: to.agent, to_effort: to.effort,
        }))
      } catch { /* modifier measurement is never load-bearing */ }
    } else if (event.kind === 'attention') {
      // ADR-029 §4: attention rides the existing closed log vocabulary.
      record('log', { level: 'warn', message: `attention:${event.moment} park_id=${event.park_id ?? 'null'} task=${event.task} ${event.why}` })
    } else if (event.kind === 'usage') {
      // agent_sessions is the per-assignment home; sessions.billed_* stays
      // NULL (per-run totals + money are the #119 follow-up). The table is
      // unique on (adw_id, claude_session_id) and a seat reuses ONE worker
      // session across assignments, while endAgentSession overwrites without
      // COALESCE — so what is written is the seat's RUNNING TOTAL, never a
      // delta that would clobber the previous assignment.
      emitter.emit((handle) => handle.startAgentSession({
        adw_id: emitter.adwId, dispatch_id: event.id ?? null, role: event.role ?? null,
        model: event.model ?? null, claude_session_id: event.session_id ?? null,
        transcript_path: event.transcript_path ?? null,
      }))
      if (event.usage) {                       // absent usage stays NULL, never 0
        const key = `${event.role}\u0000${event.session_id}`
        const total = addTotals(usageTotals.get(key), event.usage)
        usageTotals.set(key, total)
        emitter.emit((handle) => handle.endAgentSession({
          adw_id: emitter.adwId, claude_session_id: event.session_id ?? null,
          context_tokens: null, context_window: null,
          raw_read_tokens: null, raw_written_tokens: null, ...total,
        }))
      }
    } else if (event.kind === 'heartbeat') {
      // The ONE measured-liveness write (#297): seat-io's wait loop calls this
      // only after a probe came back TRUE, carrying that probe's timestamp.
      // A heartbeat with no probe timestamp behind it is a wall clock, not a
      // measurement — dropped, never stamped, because heartbeat() would
      // otherwise substitute its own now() and fabricate the observation.
      if (!Number.isFinite(event.at)) return
      return emitter.emit((handle) => handle.heartbeat({
        adw_id: emitter.adwId, target: 'session', at: event.at,
      }))
    }
  }
}

// Both run entrypoints settle their seats HERE. Teardown runs AFTER the run's
// envelope on purpose: a worker that refuses to die must never change the
// run's recorded outcome. A failure to RECORD is itself accounted — a
// teardown row that never reached the ledger used to be indistinguishable
// from a run with nothing to tear down.
export function settleSeatTeardown(io, deps = {}) {
  const at = deps.now || (() => new Date().toISOString())
  try { io?.captureDescendants?.() } catch { /* capture is never load-bearing */ }
  let rows = []
  try { rows = (typeof io?.teardown === 'function' ? io.teardown() : []) || [] }
  catch (err) { rows = [{ role: null, outcome: 'unproven', reason: 'teardown-threw', why: err.message }] }
  const tally = { proven: 0, failed: 0, unproven: 0 }
  let recorded = 0
  let recordFailed = 0
  for (const seat of rows) {
    tally[seat.outcome] = (tally[seat.outcome] ?? 0) + 1
    try { io?.log?.({ at: at(), event: 'seat-teardown', ...seat }) } catch { /* journal is diagnostics */ }
    // No emitter at all is an ABSENCE, not a failed write: neither counter
    // moves, and `seats` still says how many rows went unrecorded.
    // Ownership of the ledger key: seat_teardowns is unique on (adw_id, role)
    // with INSERT OR IGNORE (scripts/factory/ledger.mjs:702,1897), so the FIRST
    // row for a role wins forever. A row marked record: false is a row this
    // sweep LOOKED at but does not own — the run-end pane sweep (#426) closed
    // no surface, and teardownCore's later proven row must be the one the
    // ledger keeps. It is still tallied and still journalled; nothing about
    // what counts as PROOF changes here, and an unemitted row is an ABSENCE,
    // never a record_failed.
    // MUTATION A7: `seat.record === true` lets an unowned row squat the key.
    if (seat.record === false) continue
    if (typeof io?.emit !== 'function') continue
    // Only a POSITIVE verdict is a receipt. There is no boolean contract on
    // the optional io.emit (crew/io-contract.test.mjs:15-16), so `undefined`
    // is not evidence that a row was written — it joins false and throw.
    let ok = false
    try { ok = io.emit({ kind: 'seat-teardown', ...seat }) === true } catch { ok = false }
    if (ok) { recorded += 1; continue }
    recordFailed += 1
    try {
      io?.log?.({ at: at(), event: 'seat-teardown-record-failed',
        role: seat.role ?? null, outcome: seat.outcome, reason: seat.reason ?? null })
    } catch { /* journal is diagnostics */ }
  }
  const summary = { seats: rows.length, ...tally, recorded, record_failed: recordFailed }
  // Written even when it is zero: the journal is the archive and always says
  // teardown ran, while the ledger is the query surface and carries one row
  // per seat.
  try { io?.log?.({ at: at(), event: 'seat-teardown-sweep', ...summary }) } catch {}
  let descendants = null
  try { descendants = io?.reclaimDescendants?.() ?? null } catch { descendants = null }
  return { ...summary, rows, ...(descendants ? { descendants } : {}) }
}

export const PANE_SAMPLE_LINES = 200
export const PANE_SAMPLE_TIMEOUT_MS = 5000
const BOX_DRAWING = /[─-▟]/g

export function normaliseScreenText(text) {
  if (typeof text !== 'string' || !text) return ''
  return text.replace(BOX_DRAWING, ' ').replace(/\s+/g, ' ').trim()
}

// A READ and a CONDITION are different facts. A screen that could not be read
// is no evidence at all, and only a screen the probe actually read can be
// evidence that a condition has ENDED (#413).
export function samplePaneScreen(surfaceId, deps = {}) {
  const cmux = deps.cmux || defaultCmux
  let res
  try {
    res = cmux('read-screen', ['--surface', surfaceId, '--scrollback', '--lines', String(PANE_SAMPLE_LINES)], { timeoutMs: PANE_SAMPLE_TIMEOUT_MS })
  } catch { return { read: false, condition: null } }
  if (!res || res.ok !== true) return { read: false, condition: null }
  const text = normaliseScreenText(String(res.stdout || ''))
  if (!text) return { read: false, condition: null }
  return { read: true, condition: recogniseProviderCondition(text) }
}

// One record per RUN — one continuous stretch of the same recognised condition
// on one pane. `bound: 'lower'` still says the row can only undercount: the
// condition may have begun before first_seen_at and outlived last_seen_at, and
// a probe that misses it entirely is never recorded. What the row no longer
// does is COUNT: a per-probe counter turned one persistent on-screen artifact
// into N sightings that read as N incidents (#413).
export function paneSampleRow({ role, transport, model, condition, firstSeenAt, lastSeenAt }) {
  return {
    event: 'pane-provider-sample',
    role: role ?? null,
    transport: transport ?? null,
    model: model ?? null,
    condition,
    basis: 'sampled',
    bound: 'lower',
    first_seen_at: firstSeenAt ?? null,
    last_seen_at: lastSeenAt ?? null,
  }
}

export function providerConditionDetail(err) {
  const message = (err && err.message) || null
  const captured = err && err.providerCondition
  if (PROVIDER_CONDITIONS.some((c) => c.condition === captured)) return `[provider:${captured}] ${message ?? ''}`.trim()
  const sampled = err && err.sampledProviderCondition
  if (PROVIDER_CONDITIONS.some((c) => c.condition === sampled)) return `[provider-sampled:${sampled}] ${message ?? ''}`.trim()
  return message
}

// A pane's death is not instantaneous: close-surface returns as soon as cmux
// accepts it, so ONE probe can read a still-listed surface and call a dying
// seat `failed`. Poll a bounded window instead, so `failed` keeps meaning what
// the ledger says it means — a MEASURED live seat after teardown.
export const PANE_SETTLE_POLLS = 4
export const PANE_SETTLE_MS = 250

// One row per seat whose recorded SURFACE this teardown attempted to close —
// exactly the seats seatIo.teardown() structurally cannot see (it builds rows
// from declared headless-rpc members only), which is why an all-pane crew
// recorded `seats: 0`. The selection is deliberately narrow: it claims nothing
// about a future transport that owns BOTH a surface and a place in the
// transport sweep — two settles would then attempt two rows for one role, and
// `seat_teardowns` is unique on (adw_id, role) with INSERT OR IGNORE
// (scripts/factory/ledger.mjs:630,1755), so that case needs an ownership
// decision, not this loop.
// `unproven` is the answer for an indeterminate probe and never `proven`:
// teardownOutcome is the only mapping, and only positive death evidence says
// a seat is gone (ADR-030's closed set).
export function paneTeardownRows(crew, deps = {}) {
  // The default probe FORWARDS deps to paneAlive, so the real tri-state probe
  // is what runs in production and is reachable (via tree/locate) from a test.
  const probe = deps.probe || ((id) => paneAlive(id, deps))
  const sleep = deps.sleep || ((ms) => { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms) })
  const polls = deps.polls ?? PANE_SETTLE_POLLS
  const intervalMs = deps.intervalMs ?? PANE_SETTLE_MS
  const rows = []
  for (const [role, member] of Object.entries(crew?.members || {})) {
    if (!member?.surface_id) continue      // no surface closed here: not this sweep's seat
    let alive = probe(member.surface_id)
    for (let i = 1; i < polls && alive === true; i += 1) { sleep(intervalMs); alive = probe(member.surface_id) }
    const liveness = alive === true ? LIVENESS.ALIVE : alive === false ? LIVENESS.DEAD : LIVENESS.UNKNOWN
    rows.push({
      role,
      transport: member.transport || DEFAULT_TRANSPORT,
      outcome: teardownOutcome(liveness),
      reason: alive === true ? 'probe-alive' : alive === false ? 'probe-dead' : 'probe-unknown',
      forced: false,
    })
  }
  return rows
}

// An UNPARSEABLE return file is not an ABSENT one. `null` is the wait loop's
// "nothing on disk yet" and is polled to the seat deadline; but NOTHING ever
// rewrites a seat's envelope — reading is not authoring — so a file that IS
// there and cannot be parsed polls the full budget on a condition that can
// never resolve (lane b52-heartbeat: 40 minutes lost to one literal newline
// inside a summary string, then an escalation that reported 'no valid
// envelope' about a file sitting on disk). Fail at the READ boundary instead,
// staged so cellFailureKind maps it onto the EXISTING 'unusable-envelope'
// kind (:972). No new vocabulary, and no repair of the seat's own file.
export function readEnvelopeFile(returnPath, deps = {}) {
  const existsSync = deps.existsSync || fsExistsSync
  const readFileSync = deps.readFileSync || fsReadFileSync
  if (!existsSync(returnPath)) return null
  let raw
  // A read that loses a race with a rename, or that comes back denied, is an
  // ABSENCE and not a defect: the next poll sees the file. Only bytes we
  // actually read and cannot parse are terminal.
  try { raw = String(readFileSync(returnPath, 'utf8')) } catch { return null }
  try { return JSON.parse(raw) } catch (err) {
    const parseFailure = new Error(`unusable envelope at ${returnPath}: the file EXISTED (${raw.length} bytes) and is not JSON this driver can read: ${err.message}`)
    parseFailure.stage = 'pane-parse-error'
    if (deps.role) parseFailure.role = deps.role
    parseFailure.raw = raw   // the exact bytes that failed to parse, so a re-ask
    // can tell "not re-emitted yet" from "re-emitted and still broken". Nothing
    // ever writes them back: reading is not authoring.
    throw parseFailure
  }
}

// Who may be re-asked, decided from measured facts only. Exported and pure so
// the refusals are unit-testable without a seat: a re-ask to a seat that is
// settled, absent, indeterminate, or on a transport whose send seam this module
// does not own is a FABRICATED recovery, and the escalation must say which.
export function reaskDecision({ kind, transport, surfaceId, alive, asked }) {
  if (kind !== 'unusable-envelope') return { ask: false, why: `failure kind ${String(kind)} is not an unparseable envelope, so there is nothing a re-emit could fix` }
  if (asked) return { ask: false, why: `a re-ask was already sent for this envelope; the bound is ${REASK_MAX} per assignment` }
  const paneSeat = transport === DEFAULT_TRANSPORT
  if (!paneSeat) return { ask: false, why: `transport ${String(transport)} owns its own wait and send seam, so this driver has nobody here to ask` }
  if (!surfaceId) return { ask: false, why: 'the seat has no recorded surface, so there is no live participant to ask' }
  if (alive !== true) return { ask: false, why: `the pane probe returned ${alive === false ? 'probe-dead' : 'probe-unknown'}, and a re-ask to a seat that is not measurably alive is a fabricated recovery` }
  return { ask: true, why: 'a live pane seat can re-emit its own envelope' }
}

// The assignment line's charset admits neither parentheses nor quotes
// (crew/driver.mjs:69), and #359's message carries both — so the verbatim
// failure travels in a FILE and the line points at it, exactly as every other
// brief does.
export function reaskBrief({ role, id, returnPath, message }) {
  return [
    `# Re-ask ${id}: your ReturnEnvelope could not be parsed`,
    '',
    'Your WORK is not in question and the repo must not be touched. The file you',
    'wrote is on disk exactly as you left it; this driver never repairs,',
    're-encodes or rewrites it.',
    '',
    `verbatim parse failure: ${message}`,
    '',
    `Write the SAME ReturnEnvelope again as valid JSON to ${returnPath}, with one`,
    'complete write. The usual cause is a literal control character (most often a',
    'newline) inside a JSON string value where the escape belongs.',
    'Change nothing about the work you already did and make no repo edits.',
    `Then print exactly: CREW-DONE ${role} ${id}`,
    '',
    'This is the only re-ask; a second unparseable envelope ends the run.',
  ].join('\n')
}

export function waitForEnvelope({ returnPath, timeoutS, role, readEnvelope, probeSeat, sampleSeat, onAlive, now, sleep }) {
  const started = now()
  const deadline = started + timeoutS * 1000
  let lastProbeAt = started
  let misses = 0
  let substrateMisses = 0
  while (now() < deadline) {
    const env = readEnvelope()
    if (env != null) return env

    const current = now()
    if (probeSeat && current - lastProbeAt >= LIVENESS_PROBE_MS) {
      lastProbeAt = current
      const raw = probeSeat()
      const probe = (raw && typeof raw === 'object') ? raw : { alive: raw, substrate: null }
      const alive = probe.alive
      if (sampleSeat) try { sampleSeat(current) } catch { /* a sample is never load-bearing */ }
      // A heartbeat is a MEASUREMENT: stamped only where liveness was
      // OBSERVED. `current` is that probe's own timestamp — the same instant
      // the miss accounting records as `lastProbeAt`. An indeterminate probe
      // (null) and a miss (false) write NOTHING: a NULL beats a value nobody
      // measured (#297). The callback is the caller's to guard — seatIo.wait
      // owns that try/catch because it owns the emitter.
      if (alive === true) { misses = 0; if (onAlive) onAlive(current) }
      else if (alive === false) misses += 1
      if (probe.substrate === 'down') substrateMisses += 1
      else if (probe.substrate === 'ok') substrateMisses = 0
      if (misses >= LIVENESS_MISSES_TO_DIE) {
        const arrived = readEnvelope()
        if (arrived != null) return arrived
        const err = new Error(`seat died: ${role} — its pane is gone (${LIVENESS_MISSES_TO_DIE} consecutive liveness probes) and no envelope arrived at ${returnPath}`)
        err.stage = 'seat-died'
        err.role = role
        throw err
      }
      if (substrateMisses >= SUBSTRATE_MISSES_TO_DIE) {
        const arrivedLate = readEnvelope()
        if (arrivedLate != null) return arrivedLate
        const err = new Error(`substrate gone: ${role} — the pane manager stopped answering (${SUBSTRATE_MISSES_TO_DIE} consecutive substrate probes), so every pane it owned is unreachable and no envelope arrived at ${returnPath}`)
        err.stage = 'substrate-gone'
        err.role = role
        throw err
      }
    }
    sleep(WAIT_POLL_MS)
  }
  return null
}

const SUBSTRATE_DOWN = () => ({ alive: null, substrate: 'down' })

export function paneProbe(surfaceId, deps = {}) {
  const tree = deps.tree || defaultTree
  const locate = deps.locate || defaultLocate
  let t
  try { t = tree() } catch { return SUBSTRATE_DOWN() }
  if (!Array.isArray(t?.windows)) return SUBSTRATE_DOWN()
  try { return { alive: !!locate(t, surfaceId), substrate: 'ok' } }
  catch { return { alive: null, substrate: 'ok' } }
}

export function paneAlive(surfaceId, deps = {}) {          // true | false | null (indeterminate)
  return paneProbe(surfaceId, deps).alive
}

// #240: FORCE_COLOR is commonly set in the environment a crew is launched
// from, and Node's test runner honours it even into a pipe — so a gate that
// parses `node --test`'s summary reads "\x1b[34mℹ pass 965\x1b[39m" and calls a
// green suite red (2026-08-16, a whole build round lost). Neutralise colour
// once, where the driver spawns, so every gate ever authored is covered and no
// gate bytes change. The child env is EXTENDED, not sanitised: PATH, HOME and
// every credential a lane needs survive. A command that genuinely wants colour
// can still ask — it is a /bin/sh string, so `FORCE_COLOR=3 cmd` re-enables it
// for that command alone.
export function colorNeutralEnv(base = process.env) {
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  env.NO_COLOR = '1'
  return env
}

export function seatIo(crew, paths, checkout, emitter, adapters, args = {}, deps = {}) {
  const env = deps.env || process.env
  const hostLoadDeps = {}
  if (deps.loadavg) hostLoadDeps.loadavg = deps.loadavg
  if (deps.cpus) hostLoadDeps.cpus = deps.cpus
  const sendLine = deps.sendLine || defaultSendLine
  const assignmentLine = deps.assignmentLine || defaultAssignmentLine
  const tree = deps.tree || defaultTree
  const locate = deps.locate || defaultLocate
  const cmux = deps.cmux || defaultCmux
  const closeSurface = deps.closeSurface || defaultCloseSurface
  const logLine = deps.logLine || defaultLogLine
  const existsSync = deps.existsSync || fsExistsSync
  const readFileSync = deps.readFileSync || fsReadFileSync
  const writeFileSync = deps.writeFileSync || fsWriteFileSync
  const unlinkSync = deps.unlinkSync || fsUnlinkSync
  const renameSync = deps.renameSync || fsRenameSync
  const execSync = deps.execSync || cpExecSync
  const execFileSync = deps.execFileSync || cpExecFileSync
  const spawnSync = deps.spawnSync || cpSpawnSync
  const now = deps.now || (() => Date.now())
  const readRoster = deps.readRoster || (() => JSON.parse(readFileSync(join(HERE, 'roster.json'), 'utf8')))
  const sleep = deps.sleep || ((ms) => {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  })
  const capture = descendantCapture({
    taskDir: paths.taskDir,
    log: (obj) => io.log(obj),
    deps: { ...deps, spawnSync, sleep },
  })
  const resolveBin = deps.resolveWorkerBin || resolveWorkerBin
  let seq = 0
  const seatFor = new Map()
  const reasked = new Set()   // returnPaths already re-asked — the bound, per assignment
  const transportForPath = new Map()
  const transportFactories = {
    [HEADLESS_TRANSPORT]: deps.headlessIo || defaultHeadlessIo,
    [HEADLESS_RPC_TRANSPORT]: deps.headlessRpcIo || defaultHeadlessRpcIo,
  }
  const transportInstances = new Map()
  const transportArgs = {
    crew, paths, taskDir: paths.taskDir, checkout, adapters, bin: null,
    deps: {
      log: (obj) => logLine(join(paths.dir, 'journal.jsonl'), obj),
      emit: (event) => { try { io.emit?.(event) } catch { /* never load-bearing */ } },
    },
  }
  // Transport waits are synchronous Atomics.wait loops, so this is the only
  // owned seam at which a live seat can be captured without a timer. Always
  // serve the requested delay, even when the diagnostic capture fails.
  transportArgs.deps.sleep = (ms) => {
    try { capture.round() } catch { /* capture is never load-bearing */ }
    sleep(ms)
  }
  function transportIo(name, role) {
    if (!transportFactories[name]) throw new Error(`unknown transport "${name}" for seat ${role}`)
    if (!transportInstances.has(name)) {
      // Claude's frozen worker binary is for headless-json only; RPC is
      // explicitly pi --mode rpc and must never inherit crew.claude_bin.
      const factoryArgs = {
        ...transportArgs,
        bin: name === HEADLESS_RPC_TRANSPORT ? 'pi' : (crew.claude_bin || resolveBin(args)),
      }
      transportInstances.set(name, transportFactories[name](factoryArgs))
    }
    return transportInstances.get(name)
  }
  // Recognition is EVIDENCE on the EXISTING detail column. The closed kind set
  // lives in scripts/factory/ledger.mjs:183 (another lane's file) and
  // recordCellFailure refuses an unlisted kind (:1540), so a new member would
  // drop the whole row rather than enrich it. The prefix LEADS the string
  // because the ledger truncates detail at 500 chars (:1558). Only a member of
  // the closed condition set is ever recorded, and nothing branches on it.
  // A wait-budget expiry is evidence about the CELL only when the HOST was
  // measurably able to deliver. Same probe and same opt-in policy as the boot
  // refusal (crew/host-load.mjs, kept outside noteRunlessCellFailure at
  // crew/crew.mjs:1105 for exactly this reason): saturated at the instant the
  // budget expired attributes the row to the host, measurably quiet attributes
  // it to the cell, and an unmeasured host attributes NOTHING (null) rather
  // than guessing — host-load.mjs declares no default threshold on purpose.
  // Never load-bearing for the wait.
  const timeoutAttribution = () => {
    try {
      const record = hostLoad({ policy: loadPolicy(env), ...hostLoadDeps })
      if (!record) return null
      if (record.verdict === 'saturated') return 'host'
      if (record.verdict === 'quiet') return 'cell'
      return null
    } catch { return null }
  }
  const noteCellFailure = (role, id, failure, err) => {
    try {
      io.emit?.({
        kind: 'cell-failure', role, id: id ?? null, failure,
        stage: (err && err.stage) || null, detail: providerConditionDetail(err),
        attribution: failure === 'timeout' ? timeoutAttribution() : (err && err.stage === 'substrate-gone' ? 'host' : null),
      })
    } catch { /* never load-bearing */ }
  }
  // `sampledConditions` is the LAST condition recognised for a seat and is
  // never cleared: it is the evidence a cell failure quotes. `sampleRuns` is
  // the OPEN run, and it is the journal's unit — closed, and only then
  // written, when the condition changes, when a read shows it gone, or when
  // the wait ends.
  const sampledConditions = new Map()
  const sampleRuns = new Map()
  const closeSampleRun = (role) => {
    const run = sampleRuns.get(role)
    if (!run) return
    sampleRuns.delete(role)
    const m = crew.members?.[role] || null
    try {
      io.log({ at: now(), ...paneSampleRow({
        role, transport: m?.transport ?? DEFAULT_TRANSPORT, model: m?.model ?? null,
        condition: run.condition, firstSeenAt: run.firstSeenAt, lastSeenAt: run.lastSeenAt,
      }) })
    } catch { /* the journal is diagnostics, never load-bearing */ }
  }
  const samplePaneSeat = (role, surfaceId, at) => {
    const sample = samplePaneScreen(surfaceId, { cmux })
    // A failed or empty read is not evidence the condition ended — leave the
    // open run exactly as it was and record nothing.
    if (!sample.read) return null
    const condition = sample.condition
    if (!condition) { closeSampleRun(role); return null }
    // `at` is the probe's own instant, the same one the miss accounting and
    // the heartbeat stamp; now() is the fallback for a caller that has none.
    const seenAt = typeof at === 'number' ? at : now()
    const run = sampleRuns.get(role)
    if (run && run.condition === condition) run.lastSeenAt = seenAt
    else {
      closeSampleRun(role)
      sampleRuns.set(role, { condition, firstSeenAt: seenAt, lastSeenAt: seenAt })
    }
    sampledConditions.set(role, { condition })
    return condition
  }
  // #392: ONE bounded re-ask, composed by code the same way a bounce brief is.
  // The seat is alive, its bytes are on disk, and we hold a quotable parse
  // error — so ask the only participant who can fix it. Never repairs the file.
  const reaskUnusableEnvelope = ({ returnPath, info, transport, err, timeoutS }) => {
    const role = info?.role || 'unknown'
    const surfaceId = transport ? null : (info?.surface_id || null)
    const alive = surfaceId ? paneAlive(surfaceId, { tree, locate }) : null
    const decision = reaskDecision({
      kind: cellFailureKind(err),
      transport: transport ? (crew.members?.[role]?.transport || 'unknown') : DEFAULT_TRANSPORT,
      surfaceId,
      alive,
      asked: reasked.has(returnPath),
    })
    const note = (outcome, extra = {}) => {
      try { io.log({ at: now(), event: 'envelope-reask', role, id: info?.id ?? null, returnPath, outcome, ...extra }) }
      catch { /* the journal is diagnostics, never load-bearing for a wait */ }
    }
    if (!decision.ask) {
      err.message = `${err.message}\n[no re-ask: ${decision.why}]`
      err.reask = { attempted: false, why: decision.why }
      note('declined', { why: decision.why })
      return { envelope: null, error: err }
    }
    reasked.add(returnPath)
    const staleRaw = typeof err.raw === 'string' ? err.raw : null
    const briefPath = join(paths.taskDir, `reask-${info?.id || 'seat'}.${role}.md`)
    try {
      // The brief is written BEFORE the message is annotated, so what the seat
      // reads is the parse failure verbatim and nothing else.
      writeFileSync(briefPath, reaskBrief({ role, id: info?.id || 'reask', returnPath, message: err.message }))
      sendLine(surfaceId, assignmentLine({ id: info?.id || 'reask', role, briefFile: briefPath, returnPath, taskDir: paths.taskDir }))
    } catch (sendErr) {
      err.message = `${err.message}\n[re-ask attempted and not delivered: ${sendErr.message}]`
      err.reask = { attempted: true, delivered: false, recovered: false, why: sendErr.message }
      note('undelivered', { why: sendErr.message })
      return { envelope: null, error: err }
    }
    note('sent', { brief: briefPath })
    const window = Math.min(timeoutS, REASK_TIMEOUT_S)
    try {
      const env = waitForEnvelope({
        returnPath,
        timeoutS: window,
        role,
        // Only CHANGED bytes are an answer: the stale file is still on disk and
        // re-reading it would report the same defect before the seat could act.
        readEnvelope: () => {
          let raw
          try { raw = String(readFileSync(returnPath, 'utf8')) } catch { return null }
          if (raw === staleRaw) return null
          return readEnvelopeFile(returnPath, { existsSync, readFileSync, role })
        },
        probeSeat: () => paneProbe(surfaceId, { tree, locate }),
        sampleSeat: (at) => samplePaneSeat(role, surfaceId, at),
        onAlive: (at) => { try { io.emit?.({ kind: 'heartbeat', at, role }) } catch { /* never load-bearing */ } },
        now,
        sleep,
      })
      if (env != null) {
        err.message = `${err.message}\n[re-ask recovered: the seat re-emitted a parseable envelope and the run continued]`
        err.reask = { attempted: true, delivered: true, recovered: true }
        note('recovered')
        return { envelope: env, error: err }
      }
      err.message = `${err.message}\n[re-ask attempted: one re-ask was sent to ${role} and the file's bytes never changed within ${window}s]`
      err.reask = { attempted: true, delivered: true, recovered: false, second: null }
      note('no-new-bytes', { window_s: window })
    } catch (secondErr) {
      err.message = `${err.message}\n[re-ask attempted: one re-ask was sent to ${role} and the second envelope is still unparseable: ${secondErr.message}]`
      err.reask = { attempted: true, delivered: true, recovered: false, second: secondErr.message }
      note('unparseable-again', { second: secondErr.stage || null })
    }
    return { envelope: null, error: err }
  }
  // The stash stack is NOT per-worktree: `git rev-parse --git-path refs/stash`
  // resolves to the SAME file in the common git dir from every linked worktree,
  // so `git stash pop` restores whatever lane pushed LAST (#471). The entry a
  // push created is identified by the unique message it carries and restored by
  // its own commit id; an entry we cannot prove is ours is a refusal, never a
  // plausible guess.
  const stashEntries = () => {
    const list = spawnSync('git', ['stash', 'list', '--format=%H %gs'], { cwd: checkout, encoding: 'utf8' })
    if (list.status !== 0) throw new Error(`runClean: git stash list failed, refusing to guess which stash entry is ours:\n${list.stderr || list.stdout || ''}`)
    return String(list.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const sha = line.split(' ')[0]
      return { sha, subject: line.slice(sha.length + 1).trim(), index }
    })
  }
  const ownStashEntry = (tag, sha) => {
    const entries = stashEntries()
    const matches = entries.filter((entry) => (sha ? entry.sha === sha : entry.subject.endsWith(tag)))
    if (matches.length !== 1) {
      throw new Error(`runClean: refusing to restore a stash entry that is not provably ours — ${matches.length} of ${entries.length} entries match ${sha || tag}; the work this lane set aside is still in the stash (git stash list)`)
    }
    return matches[0]
  }
  const io = {
    assign(spec) {
      // Destructure EVERY field the pane path uses: `briefFile` is not in
      // seatIo's scope (it is runCmd's local), so leaving it out of this
      // pattern makes it a free identifier and every pane assignment dies
      // with a bare ReferenceError before a single line is sent.
      const { role, briefFile } = spec
      let id = null
      try {
        const m = crew.members[role]
        if (!m) throw new Error(`role ${role} not seated in this crew`)
        if (m.transport !== DEFAULT_TRANSPORT) {
          const transport = transportIo(m.transport, role)
          const result = transport.assign(spec)
          id = result?.id ?? null
          transportForPath.set(result.returnPath, transport)
          seatFor.set(result.returnPath, { role, id })
          return result
        }
        seq += 1
        id = `d${seq}`
        const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
        // Anti-replay: seq restarts every process, so a crashed/escalated run
        // leaves files a re-run's wait() would instantly (and wrongly) accept.
        if (existsSync(returnPath)) unlinkSync(returnPath)
        seatFor.set(returnPath, { role, surface_id: m.surface_id, id })
        sendLine(m.surface_id, assignmentLine({ id, role, briefFile, returnPath, taskDir: paths.taskDir }))
        return { id, returnPath }
      } catch (err) {
        noteCellFailure(role, id, cellFailureKind(err), err)
        throw err
      }
    },
    wait(returnPath, timeoutS) {
      const transport = transportForPath.get(returnPath)
      const info = seatFor.get(returnPath)
      try {
        const env = transport
          ? transport.wait(returnPath, timeoutS)
          : waitForEnvelope({
            returnPath, timeoutS, role: info?.role || 'unknown',
            readEnvelope: () => readEnvelopeFile(returnPath, { existsSync, readFileSync, role: info?.role }),
            probeSeat: info ? () => paneProbe(info.surface_id, { tree, locate }) : null,
            sampleSeat: info?.surface_id ? (at) => samplePaneSeat(info.role, info.surface_id, at) : null,
            onAlive: (at) => {
              // An absent or refusing emitter is an ABSENCE, never a failed
              // write: the ledger is diagnostics, the wait is the run.
              try { io.emit?.({ kind: 'heartbeat', at, role: info?.role || null }) }
              catch { /* the ledger is never load-bearing for a wait */ }
            },
            now, sleep,
          })
        if (env == null) {
          noteCellFailure(info?.role, info?.id, 'timeout', {
            message: `no envelope at ${returnPath} within ${timeoutS}s`,
            sampledProviderCondition: sampledConditions.get(info?.role)?.condition,
          })
        }
        return env
      } catch (err) {
        let failure = err
        if (cellFailureKind(err) === 'unusable-envelope') {
          const recovery = reaskUnusableEnvelope({ returnPath, info, transport, err, timeoutS })
          if (recovery.envelope != null) {
            // One cell failure is still recorded — the wasted turn is a real
            // cell defect — but the RUN continues as if the first envelope had
            // been readable.
            noteCellFailure(info?.role, info?.id, 'unusable-envelope', recovery.error || err)
            return recovery.envelope
          }
          failure = recovery.error || err
        }
        if (failure.stage === 'seat-died') io.log({ at: now(), seat_died: info?.role || 'unknown', returnPath })
        if (failure.stage === 'substrate-gone') io.log({ at: now(), substrate_gone: info?.role || 'unknown', returnPath })
        const sampled = sampledConditions.get(info?.role); if (sampled) failure.sampledProviderCondition = sampled.condition
        noteCellFailure(info?.role, info?.id, cellFailureKind(failure), failure)
        throw failure
      } finally {
        // The wait ending closes the run: a condition still on screen has been
        // seen from its first sighting to its last, and one row says so.
        closeSampleRun(info?.role)
      }
    },
    captureDescendants() { return capture.round(true) },
    reclaimDescendants() {
      // settleSeatTeardown calls THIS method, and it is the run-end sweep that
      // can stamp a record terminal. Settle roots FIRST, or a zombie root's live
      // same-pgid peers are never examined: the final teardownCore pass skips
      // every already-swept record. Never let it block the sweep.
      try { settleSeatRoots({ taskDir: paths.taskDir, log: io.log, deps: { ...deps, spawnSync, sleep } }) } catch { /* root settlement is evidence, never a sweep blocker */ }
      return reclaimDescendants({
        taskDir: paths.taskDir, log: io.log, emit: io.emit,
        deps: { ...deps, spawnSync, sleep },
      })
    },
    writeFile(path, content) { writeFileSync(path, content) },
    readFile(path) { return existsSync(path) ? readFileSync(path, 'utf8') : null },
    run(cmd) {
      const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: checkout, encoding: 'utf8', timeout: 900_000, env: colorNeutralEnv(deps.env || process.env) })
      // A timeout kill or a spawn failure must be legible in the output a
      // bounce brief pastes verbatim — never an empty "Failures:" block.
      let output = `${res.stdout || ''}${res.stderr || ''}`
      if (res.error) output += `\n[spawn error: ${res.error.message}]`
      if (res.signal) output += `\n[killed by ${res.signal}${res.signal === 'SIGTERM' ? ' — likely the 900s run timeout' : ''}]`
      return { ok: res.status === 0, output }
    },
    // Prove a command red on the PRE-BUILD tree while the stash stack is shared: set
    // the working changes aside, run, restore. The restore lives in a finally so
    // a throwing command can never leave the builder's work stashed, and a failed
    // round-trip throws loudly rather than silently reporting a result from the
    // wrong tree (runCmd turns the throw into an escalation envelope).
    runClean(cmd) {
      const dirty = execSync('git status --porcelain -uall', { cwd: checkout, encoding: 'utf8' }).trim()
      if (!dirty) return this.run(cmd) // nothing to set aside — the tree IS pristine
      const tag = `crew:runClean:${typeof deps.uuid === 'function' ? deps.uuid() : randomUUID()}`
      const push = spawnSync('git', ['stash', 'push', '--include-untracked', '-m', tag], { cwd: checkout, encoding: 'utf8' })
      if (push.status !== 0) throw new Error(`runClean: git stash push failed, refusing to judge a gate against the wrong tree:\n${push.stderr || push.stdout || ''}`)
      // Bind the identity NOW, while our push is still the newest thing on the
      // stack: a sibling lane's push shifts every index but never this commit id.
      const sha = ownStashEntry(tag, null).sha
      try {
        return this.run(cmd)
      } finally {
        const own = ownStashEntry(tag, sha)
        const apply = spawnSync('git', ['stash', 'apply', sha], { cwd: checkout, encoding: 'utf8' })
        if (apply.status !== 0) throw new Error(`runClean: git stash apply FAILED — the checkout is half-restored and the builder's work is in stash entry ${sha} (${tag}), never popped:\n${apply.stderr || apply.stdout || ''}`)
        const drop = spawnSync('git', ['stash', 'drop', `stash@{${own.index}}`], { cwd: checkout, encoding: 'utf8' })
        const dropped = /\(([0-9a-f]{7,40})\)/.exec(`${drop.stdout || ''}${drop.stderr || ''}`)?.[1] || ''
        if (drop.status !== 0 || !dropped || !(sha.startsWith(dropped) || dropped.startsWith(sha))) {
          throw new Error(`runClean: the tree is restored but the entry dropped was ${dropped || 'none'}, not ours (${sha}, ${tag}) — read git stash list before trusting the stack:\n${drop.stderr || drop.stdout || ''}`)
        }
      }
    },
    // Only headless-rpc is swept here. headless-json is deliberately not covered:
    // it spawns one process per assignment which exits on its own and ships no
    // teardown operation — its absence from this record is honest, not a clean
    // bill of health.
    teardown() {
      const rows = []
      // A DECLARED headless-rpc seat can hold a worker this run never assigned
      // through: ensureProcess advances the marker to RUNNING and then throws when
      // FIFO acquisition fails, and an earlier supervisor's marker outlives its
      // process. Instantiating the declared transport is what makes an empty
      // record a MEASURED zero instead of a run that never looked — and a
      // transport that cannot be CONSTRUCTED is that same false zero by another
      // route, so it lands one explicit unproven row per declared role.
      const declared = Object.entries(crew.members || {})
        .filter(([, member]) => member?.transport === HEADLESS_RPC_TRANSPORT)
        .map(([role]) => role)
      const initFailed = []
      if (declared.length) {
        try { transportIo(HEADLESS_RPC_TRANSPORT, declared[0]) }
        catch (err) {
          const why = String(err?.message ?? err)
          initFailed.push({ transport: HEADLESS_RPC_TRANSPORT, why })
          for (const role of declared) {
            rows.push({
              role, transport: HEADLESS_RPC_TRANSPORT, outcome: 'unproven',
              reason: 'teardown-threw', why,
            })
          }
        }
      }
      // A PANE seat is DECLARED in crew.json and is never instantiated through
      // transportIo, so neither source above can see it: on the driver-crash
      // path of #426 `declared` filtered to [] and transportInstances was empty,
      // and this sweep reported `seats: 0` about four live agents. Look at every
      // declared pane seat with a recorded surface — the same selection
      // paneTeardownRows makes (:1288), so both paths count the same seats.
      //
      // OWNERSHIP. This sweep CLOSES nothing (teardownCore does, and only on the
      // archive path), so a pane still on screen is `unproven` naming why and
      // never `failed` — `failed` means MEASURED ALIVE AFTER a close. And
      // seat_teardowns is unique on (adw_id, role) with INSERT OR IGNORE
      // (scripts/factory/ledger.mjs:702,1897), so a row that is not positive
      // death evidence must not squat that key ahead of the proven row
      // teardownCore writes later in the same run: it is journalled and counted
      // and carries record: false, which settleSeatTeardown never emits.
      //
      // MUTATION A1: `if (!covered.has(role))` and the loop covers only roles the
      // transport sweep already rowed — the false zero of #426 is back.
      // MUTATION A2: mapping an ALIVE pane through teardownOutcome reports a seat
      // nobody tried to close as `failed`.
      // MUTATION A3: seeding the entries with a ghost member makes a seatless crew
      // report a seat it never had.
      // MUTATION A5: seeding `covered` from crew.members drops every pane row.
      // MUTATION A6: moving the dead arm of the reason ternary to `alive === null`
      // stops positive death evidence being reported as probe-dead.
      // MUTATION A8: `if (member.surface_id) continue` inverts the recorded-surface
      // selection, so this sweep and teardownCore stop seeing the same seats.
      const covered = new Set(rows.map((row) => row.role).filter(Boolean))
      for (const [role, member] of Object.entries(crew.members || {})) {
        if ((member?.transport || DEFAULT_TRANSPORT) !== DEFAULT_TRANSPORT) continue
        if (!member.surface_id) continue
        if (covered.has(role)) continue
        const alive = paneAlive(member.surface_id, { tree, locate })
        rows.push({
          role,
          transport: DEFAULT_TRANSPORT,
          outcome: alive === false ? teardownOutcome(LIVENESS.DEAD) : 'unproven',
          reason: alive === false ? 'probe-dead' : alive === true ? 'surface-open-not-closed-here' : 'probe-unknown',
          forced: false,
          ...(alive === false ? {} : { record: false }),
        })
      }
      const swept = [...transportInstances.keys()]
      for (const transport of transportInstances.values()) {
        if (typeof transport.teardown !== 'function') continue
        try { rows.push(...transport.teardown()) }
        catch (err) { rows.push({ role: null, outcome: 'unproven', reason: 'teardown-threw', why: String(err?.message ?? err) }) }
      }
      try {
        logLine(join(paths.dir, 'journal.jsonl'), {
          at: new Date(now()).toISOString(), event: 'teardown-transports',
          declared, transports: swept, init_failed: initFailed, seats: rows.length,
        })
      } catch { /* diagnostics only */ }
      return rows
    },
    reseat(role, options = {}) {
      let from = null
      try {
        const { reason } = options || {}
        const roleName = String(role)
        const m = crew.members?.[role]
        if (!m) return { applied: false, reason: 'transport', why: `role ${roleName} is not seated in this crew`, from: null, to: null }
        const live = crew.seats?.[role] || m
        const snapshot = (cell) => ({
          provider: cell?.provider ?? null,
          id: cell?.id ?? null,
          effort: cell?.effort ?? null,
          agent: cell?.agent ?? null,
          model: cell?.model ?? null,
        })
        from = snapshot(live)
        const floorTier = typeof options.tier === 'string' && options.tier ? options.tier : null
        let floorTarget = null
        let roster
        if (floorTier) {
          try {
            roster = readRoster()
          } catch (err) {
            const message = err?.message ?? String(err)
            return { applied: false, reason: 'transport', why: `could not read the runtime roster: ${message}`, from, to: null }
          }
          floorTarget = roster?.tiers?.[floorTier]?.[role]
          if (!floorTarget || typeof floorTarget !== 'object' || Array.isArray(floorTarget)) {
            return { applied: false, reason: 'exhausted', why: `tier ${floorTier} seats no ${roleName}`, from, to: null }
          }
          const sameFloorCell = live.provider === floorTarget.provider
            && live.id === floorTarget.id
            && live.effort === floorTarget.effort
            && (live.agent == null || floorTarget.agent == null || live.agent === floorTarget.agent)
          if (sameFloorCell) {
            return {
              applied: true,
              already: true,
              from,
              to: { ...floorTarget, model: live.model ?? null },
              rung: `${crew.tier ?? 'unseated'}→${floorTier}`,
            }
          }
        }
        if (m.transport !== HEADLESS_TRANSPORT && m.transport !== HEADLESS_RPC_TRANSPORT) {
          const why = m.transport === DEFAULT_TRANSPORT
            ? 'a pane seat bakes model and effort into its launch command at boot (crew/crew.mjs:265); its reassign: true capability means give a settled seat NEW WORK, never change its cell'
            : `transport ${String(m.transport)} cannot change a seat cell in-session`
          return { applied: false, reason: 'transport', why, from, to: null }
        }
        if (!crew.tier && !floorTier) return { applied: false, reason: 'no-tier', why: 'booted with --roles rather than --tier, so there is no ladder', from, to: null }

        if (!roster) {
          try {
            roster = readRoster()
          } catch (err) {
            const message = err?.message ?? String(err)
            return { applied: false, reason: 'transport', why: `could not read the runtime roster: ${message}`, from, to: null }
          }
        }
        const currentCell = roster?.tiers?.[crew.tier]?.[role] || roster?.[crew.tier]?.[role]
        const currentCellOrLive = currentCell || live
        const modelFallbackWhy = 'model catalog has no costlier same-provider, non-override-only candidate'
        let rung = floorTier
          ? { rung: `${crew.tier ?? 'unseated'}→${floorTier}`, cell: floorTarget }
          : nextRung(roster, crew.tier, role)
        if (!floorTier && !rung) {
          const index = RESEAT_LADDER.indexOf(crew.tier)
          const why = index < 0
            ? `tier ${String(crew.tier)} is unknown; the ladder is mechanical → build → judge`
            : index === RESEAT_LADDER.length - 1
              ? `tier ${String(crew.tier)} is already at the top of the mechanical → build → judge ladder`
              : `the next tier ${RESEAT_LADDER[index + 1]} seats no ${roleName}`
          // An unknown tier is not a usable ladder position, so retain its
          // existing exhausted result rather than treating the live cell as a
          // model-only upgrade opportunity.
          if (index < 0) return { applied: false, reason: 'exhausted', why, from, to: null }
          rung = nextModelRung(roster, currentCellOrLive)
          if (!rung) return { applied: false, reason: 'exhausted', why: `${why}; ${modelFallbackWhy}`, from, to: null }
        }
        const sameCell = !floorTier && currentCell
          && currentCell.provider === rung.cell.provider
          && currentCell.id === rung.cell.id
          && currentCell.effort === rung.cell.effort
        if (sameCell) {
          rung = nextModelRung(roster, currentCellOrLive)
          if (!rung) {
            return {
              applied: false,
              reason: 'exhausted',
              why: `the next rung repeats the identical cell ${currentCell.id} with effort ${currentCell.effort}; ${modelFallbackWhy}`,
              from,
              to: null,
            }
          }
        }
        if (rung.cell.agent !== m.agent) {
          return {
            applied: false,
            reason: 'agent-change',
            why: `the next rung changes agent from ${m.agent} to ${rung.cell.agent}; the adapter is fixed at boot (crew/crew.mjs:389), so it cannot run in-session`,
            from,
            to: null,
          }
        }
        // #239: the run path passes no adapters (crew/crew.mjs:673), so the
        // old `: rung.cell.id` fallback fired in production and persisted an
        // un-namespaced pi id. Resolve the seat's own shipped adapter here, and
        // refuse when nothing can vouch: reseat is optional and never
        // load-bearing (ADR-024/026 clause 1), so no reseat beats a model
        // string no adapter translated. `reason` stays 'transport' because
        // crew/drive.mjs:42 MODIFIER_OUTCOMES is a closed set and the driver is
        // not in scope; the specificity lives in `why`.
        const translate = modelStringFor(adapters, role, rung.cell.agent ?? m.agent)
        if (!translate) {
          return {
            applied: false,
            reason: 'transport',
            why: `no adapter can translate the ${rung.rung} cell for ${roleName}: agent "${String(rung.cell.agent ?? m.agent)}" has no modelString here, and reseating to an untranslated id is the guessed passthrough adapter-pi refuses (#147/#239)`,
            from,
            to: null,
          }
        }
        let model
        try {
          model = translate({ provider: rung.cell.provider, id: rung.cell.id })
        } catch (err) {
          return {
            applied: false,
            reason: 'transport',
            why: `the ${String(rung.cell.agent ?? m.agent)} adapter refused to translate the ${rung.rung} cell for ${roleName}: ${err?.message ?? err}`,
            from,
            to: null,
          }
        }
        if (typeof model !== 'string' || model.trim() === '') {
          return {
            applied: false,
            reason: 'transport',
            why: `the ${String(rung.cell.agent ?? m.agent)} adapter returned no model string for the ${rung.rung} cell of ${roleName}`,
            from,
            to: null,
          }
        }
        const to = { ...rung.cell, model }
        if (m.transport === HEADLESS_RPC_TRANSPORT) {
          const refuse = (why) => ({ applied: false, reason: 'transport', why: String(why || `headless-rpc seat ${roleName} could not be retired`), from, to: null })
          try {
            const transport = transportIo(HEADLESS_RPC_TRANSPORT, role)
            if (typeof transport?.retire !== 'function') return refuse(`headless-rpc seat ${roleName} has no retire operation`)
            const retired = transport.retire(role)
            if (retired?.retired !== true && retired?.reason !== 'not-running') return refuse(retired?.why || `headless-rpc seat ${roleName} could not be retired (${retired?.reason || 'unknown reason'})`)
          } catch (err) {
            return refuse(err?.why || err?.message || String(err))
          }
        }
        for (const target of [m, crew.seats?.[role]]) {
          if (!target) continue
          target.model = model
          target.effort = rung.cell.effort
          target.provider = rung.cell.provider
          target.id = rung.cell.id
        }
        // A locked read-modify-write, not a whole-file republish: a seat
        // minting a session id from its own stale copy used to erase this
        // reseat entirely (#539).
        const persisted = updateCrewJson(paths, (disk) => {
          for (const target of [disk.members?.[role], disk.seats?.[role]]) {
            if (!target) continue
            target.model = model
            target.effort = rung.cell.effort
            target.provider = rung.cell.provider
            target.id = rung.cell.id
          }
          return true
        }, { writeFileSync, renameSync, readFileSync, existsSync })
        const record = { role, from, to, rung: rung.rung, reason }
        if (m.transport === HEADLESS_RPC_TRANSPORT) record.retired = true
        // A save that fails is VISIBLE — showDoc's posture (:2146). The run
        // otherwise continues while crew.json still names the cell the
        // operator did NOT select, silent from both ends. An ABSENT crew.json
        // is not a failure: test doubles omit it, exactly as the transports do.
        if (!persisted.ok && persisted.reason !== 'absent') {
          record.persisted = false
          record.persist_error = `${persisted.reason}${persisted.error ? `: ${persisted.error}` : ''}`
          process.stderr.write(`warning: reseat of ${roleName} to ${rung.rung} was NOT persisted to crew.json (${record.persist_error}) — the file still names the previous cell\n`)
        }
        try { io.log({ at: now(), reseat: record }) } catch { /* journal is diagnostics */ }
        if (record.persisted === false) return { applied: true, persisted: false, why: record.persist_error, from, to, rung: rung.rung }
        return { applied: true, from, to, rung: rung.rung }
      } catch (err) {
        return { applied: false, reason: 'transport', why: `io.reseat failed: ${err?.message ?? err}`, from, to: null }
      }
    },
    changedFiles() {
      // -z: NUL-delimited, no quoting of paths with spaces; -uall: untracked
      // files individually, never a collapsed '?? dir/'. Rename/copy entries
      // ('R'/'C' in X) carry the ORIGINAL path as the following NUL record —
      // both sides are real changes the scope gate must see.
      const out = execSync('git status --porcelain -uall -z', { cwd: checkout, encoding: 'utf8' })
      const parts = out.split('\0')
      const files = []
      for (let i = 0; i < parts.length; i += 1) {
        const entry = parts[i]
        if (!entry) continue
        files.push(entry.slice(3))
        if (entry[0] === 'R' || entry[0] === 'C') { i += 1; if (parts[i]) files.push(parts[i]) }
      }
      return files
    },
    commit(files, message) {
      // argv-form git (no shell string: planner-supplied paths are data, not
      // syntax), staging only what actually changed within scope — a planned-
      // but-never-created path must not crash the run after a green suite.
      const changed = this.changedFiles()
      const present = files.filter((f) => changed.includes(f))
      if (present.length === 0) throw new Error('commit: nothing in scope actually changed — refusing an empty commit')
      execFileSync('git', ['add', '--', ...present], { cwd: checkout })
      execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: checkout, input: message })
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
    },
    status(label) {
      if (!crew.workspace_id) return // A workspace-less (all-headless) crew has no pill to set.
      // Workspace pill: glanceable "which code stage is running" for the
      // humans watching. Best-effort — a pill failure never touches the loop.
      cmux('set-status', ['crew-stage', label, '--workspace', crew.workspace_id])
    },
    // Mount the plan of record in cmux's live-watching markdown viewer, ONCE.
    // The viewer follows the file, and the plan path is stable for the whole
    // task, so a revision needs no remount — this is a no-op after the first
    // call. Idempotency is persisted on crew.doc_viewer so a re-run against a
    // still-standing (escalated) workspace does not mount a second pane.
    // Best-effort like status(): a mount failure warns and returns.
    showDoc(path) {
      try {
        if (!crew.workspace_id) return // A workspace-less (all-headless) crew has no plan viewer to mount.
        if (crew.doc_viewer?.path === path) return
        if (crew.doc_viewer?.surface_id) closeSurface(crew.doc_viewer.surface_id)
        const before = tree()
        const res = cmux('markdown', docOpenArgs({ path, workspaceId: crew.workspace_id, windowId: crew.window_id }))
        if (!res.ok) throw new Error(res.error.message)
        // markdown open prints no id — recover it by tree diff. An ambiguous
        // diff still records the mount (surface_id null) so the singleton
        // guard holds; only the teardown close is lost.
        const surfaceId = newSurfaceIds(before, tree())
        crew.doc_viewer = { path, surface_id: surfaceId.length === 1 ? surfaceId[0] : null }
        // One field of a shared file: re-read under the lock rather than
        // republish this process's whole copy (#539).
        const saved = updateCrewJson(paths, (disk) => { disk.doc_viewer = crew.doc_viewer; return true }, { writeFileSync, renameSync, readFileSync, existsSync })
        if (!saved.ok && saved.reason !== 'absent') throw new Error(`crew.json not updated (${saved.reason})`)
        logLine(join(paths.dir, 'journal.jsonl'), { at: new Date(now()).toISOString(), event: 'doc-viewer', path, surface_id: crew.doc_viewer.surface_id })
      } catch (err) {
        process.stderr.write(`warning: plan viewer mount failed (${err.message}) — continuing\n`)
      }
    },
    log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },
    now() { return now() },
  }
  if (emitter) io.emit = emitAdapter(emitter, crew)
  return io
}
