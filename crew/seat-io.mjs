import {
  existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync,
  unlinkSync as fsUnlinkSync, renameSync as fsRenameSync, mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync, statSync as fsStatSync, realpathSync as fsRealpathSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { execSync as cpExecSync, execFileSync as cpExecFileSync, spawnSync as cpSpawnSync } from 'node:child_process'

import {
  cmux as defaultCmux, tree as defaultTree, locate as defaultLocate, sendLine as defaultSendLine,
  closeSurface as defaultCloseSurface, logLine as defaultLogLine, assignmentLine as defaultAssignmentLine,
} from './driver.mjs'
import {
  headlessIo as defaultHeadlessIo, PROVIDER_CONDITIONS, SEAT_REFUSALS, SEAT_REFUSAL_ACTIONS,
  UNCLASSIFIED_REFUSAL, recogniseProviderCondition, recogniseSeatRefusal, writeCrewJson, updateCrewJson,
} from './headless.mjs'
import { headlessRpcIo as defaultHeadlessRpcIo, teardownOutcome } from './headless-rpc.mjs'
import { LIVENESS, PHASES, reservationEngine, markerLockName } from './reclaim.mjs'
import { operationalRow, recordRow } from './drive.mjs'
import { readJsonTri } from './json-leaf.mjs'
import { modelString as claudeModelString, paneUsageRecords as claudePaneUsageRecords } from './adapters/adapter-claude.mjs'
import { readSessionUsage } from '../scripts/factory/transcript.mjs'
import { modelString as piModelString } from './adapters/adapter-pi.mjs'
import { hostLoad, loadPolicy } from './host-load.mjs'
import { compareFingerprints, FINGERPRINT_OUTCOMES, fingerprintTree } from './tree-fingerprint.mjs'
export const DEFAULT_TRANSPORT = 'pane'
// The distinct, named reason a runClean window refuses: a concurrent writer was
// DETECTED in the working tree the driver had set aside. Never folded into a
// stash refusal — the stash stack and the working tree fail for different
// reasons and an operator must be able to tell them apart.
export const TREE_WITNESS_REFUSAL = 'tree-witness'
export const HEADLESS_TRANSPORT = 'headless-json'
export const HEADLESS_RPC_TRANSPORT = 'headless-rpc'
export const WAIT_POLL_MS = 5000
export const LIVENESS_PROBE_MS = 30_000
export const LIVENESS_MISSES_TO_DIE = 2
// Every gate, baseline, repair, validation lane and full suite reaches the
// shell through io.run below. Node's spawnSync default maxBuffer is 1 MiB, and
// past it the child is SIGTERM'd, `res.error.code` is ENOBUFS and a PASSING
// command is reported red with the END of its output — GATE-SUMMARY, the TAP
// `# fail N` line, the `not ok` assertion — discarded. A green full suite on
// this checkout is already 34% of that default.
export const RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024
// #682, measured 2026-08-26: cmux stopped answering and FOUR lanes died within
// 23 seconds of each other. Every driver probes the SAME pane manager, so a
// substrate verdict is correlated BY CONSTRUCTION and its blast radius is every
// lane running — unlike LIVENESS_MISSES_TO_DIE above, which governs one seat's
// pane and can only cost one seat. The seats were never the problem: all four
// delivered valid `status: done` envelopes 9 to 13 minutes AFTER their driver
// had already exited, and 2 probes is 60 SECONDS of silence, which is not
// evidence of a permanent outage. The counter already resets on any `ok` probe
// (:1629-1630 below), so a self-healing substrate is distinguishable from a dead
// one by simply waiting longer.
// 900_000 is a STATED DEFAULT, revisable when measured again. Three reasons for
// this number and not another: it is the smallest round bound above the 780s
// (13-minute) self-heal actually observed; it is the same 900s this file already
// treats as "dead" for a frozen transcript (TRANSCRIPT_STALE_MS below), so the
// two instruments cannot contradict each other; and it still leaves a 1800s
// planner seat half its budget to deliver after the substrate returns, which is
// what keeps `substrate-gone` a REACHABLE verdict on every real seat budget
// instead of collapsing silently into the timeout.
export const SUBSTRATE_GRACE_MS = 900_000
// DERIVED, never hand-set: the loop counts PROBES and the grace is stated in
// TIME, so the two can never drift apart when the probe cadence changes.
export const SUBSTRATE_MISSES_TO_DIE = Math.ceil(SUBSTRATE_GRACE_MS / LIVENESS_PROBE_MS)
// b187-jsonleaf, 2026-08-24: a seat stopped mid-turn with NO error frame in any
// store while the pane rendered a spinner and an incrementing timer for 83
// minutes, its token counters byte-identical across 50 minutes, and a re-nudge
// produced zero frames in 300s. paneProbe said alive because the pane existed;
// SEAT_REFUSALS said nothing because there was no error frame to read. The one
// signal that cannot lie already exists: a transcript grows on EVERY frame.
// 900s is MEASURED, not guessed. Over the 880-transcript corpus under
// ~/.pi/agent/sessions, gaps where a frame was OWED (previous frame an assistant
// frame with stop=toolUse, or a toolResult) are n=52833, p50=0.05s, p90=15.9s,
// p99=80.7s, p99.9=525.7s — and only 37 of 52833 exceed 900s. IDLE gaps (a human
// between turns) run an order of magnitude longer (p90=422s), which is why the
// naive all-gaps distribution must not be used. 900s therefore sits above p99.9
// of healthy mid-turn work and far below the 83-minute measured death: a tool
// call that legitimately takes minutes is never called stale.
export const TRANSCRIPT_STALE_MS = 900_000

// b204-reprompt, measured 2026-08-24 on b199-resumestate: a planner emitted one
// unclassified error frame, produced no frame for 14 minutes, and a HAND
// re-nudge woke it — it resumed and finished. The nudge landed 7 seconds after
// the 1800s budget lapsed, so the lane escalated anyway. 300s is chosen against
// the same corpus as TRANSCRIPT_STALE_MS above: p99 of gaps where a frame was
// OWED is 80.7s, so 300s is well past a legitimately slow tool call, and it is a
// third of the 900s staleness threshold — the re-send therefore lands with a
// turn's budget left instead of at expiry, which is the whole difference between
// tonight's revival and tonight's escalation.
export const SILENCE_REASK_MS = 300_000   // verbatim: mutation G6

// #392: an unparseable envelope from a seat that is still THERE is a defect in
// the report about the work, not in the work. Ask the one participant who can
// fix it — exactly once. The bound is DATA, not a loop: REASK_MAX asks per
// assignment, and the re-ask's own wait is clamped so a hung seat cannot
// double a stage budget.
// #669: a refusal reading is a MEASUREMENT OF A MOMENT, never a standing
// property of a seat. `lastRefusal` had no lifetime, so one WebSocket blip named
// every later wait in the run `refused` — b254-retryvis escalated on a reading
// minutes old while its builder was writing a gate-green envelope. 300_000 is the
// bound SILENCE_REASK_MS above already carries and for the same measured
// reason: over the #590 corpus p99 of gaps where a frame was OWED is 80.7s, so a
// reading older than 300s describes a condition the seat has had ample room to
// leave, and 300s is a third of TRANSCRIPT_STALE_MS, so the reading retires well
// before the staleness instrument reaches its own verdict and the two can never
// contradict each other. PRIVATE on purpose: this lane freezes both modules'
// export sets, so the bound is proven at its boundary by behaviour, not by name.
const REFUSAL_READING_MAX_MS = 300_000

export const REASK_MAX = 1
export const REASK_TIMEOUT_S = 600

// A transport re-ask is a fresh ASSIGNMENT, and a headless-json seat's prior
// invocation may not have written its `exit` file yet at the instant its
// unparseable envelope is read — assign refuses that as busy
// (crew/headless.mjs:422). Settling is part of DELIVERING the one re-ask, never a
// second one: at most REASK_SETTLE_POLLS retries of the same undelivered ask,
// REASK_SETTLE_MS apart, and then the run fails exactly as it fails today. This
// loop runs BEFORE the re-ask's own `window` begins, so it is bounded by these two
// constants and by nothing else — 5000ms is crew/headless.mjs:21's own
// WAIT_POLL_MS and 12 polls is a 60s ceiling, an order of magnitude above the
// write-then-exit gap it waits out.
export const REASK_SETTLE_MS = 5000
export const REASK_SETTLE_POLLS = 12
// The two transports' own words for "this seat still has a live turn"
// (crew/headless.mjs:408, crew/headless-rpc.mjs:477). PRIVATE: this is this
// module's READING of the other two, not a contract to export.
const REASK_BUSY_STAGES = new Set(['headless-session-busy', 'rpc-session-busy'])
// Only a transport whose re-ask semantics have been deliberately ENROLLED may be
// re-asked. A transport io can expose `assign` and `wait` and ignore the optional
// `reask` override entirely, so method existence is not capability (#623): a newly
// added transport is refused here until someone enrols it on purpose. PRIVATE for
// the same reason REASK_BUSY_STAGES is.
const REASK_TRANSPORTS = new Set([HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT])

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
  const marker = readJsonTri(join(dir, name)) ?? null
  return marker && typeof marker === 'object' ? marker : null
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
      callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'descendant-capture', records: discoveries, captures, discovery_failures: discoveryFailures })))
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
    callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'seat-root-settle', ...record, ...result })))
  }
  callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'seat-root-settle-sweep', ...summary })))
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
    callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'descendant-reclaim-sweep', ...empty })))
    return empty
  }
  const entries = descendantRecordEntries(storeDir)
  const summary = zeroSweepSummary(sweepId)
  summary.records = 0
  summary.skipped = entries.filter((entry) => entry.record.swept_at != null).length
  if (!entries.length) {
    callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'descendant-reclaim-sweep', ...summary })))
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
      callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'descendant-reclaim', ...row })))
      let receipt = true
      if (typeof emit === 'function') {
        receipt = callTeardownCallback(() => emit({ kind: 'seat-reclaim', ...row }) === true) === true
        if (receipt) summary.recorded += 1
        else {
          summary.record_failed += 1
          callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'descendant-reclaim-record-failed', ...row })))
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
      callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'descendant-reclaim-error', key: entry.key, reason: 'probe-unknown' })))
    }
  }
  callTeardownCallback(() => log?.(operationalRow({ at: recordTimestamp(deps), event: 'descendant-reclaim-sweep', ...summary })))
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
const SHIPPED_PANE_USAGE = Object.freeze({ claude: claudePaneUsageRecords })

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

function totalsOf(usage) {
  return {
    billed_input_tokens: Number.isFinite(usage?.billed_input_tokens) ? usage.billed_input_tokens : 0,
    billed_output_tokens: Number.isFinite(usage?.billed_output_tokens) ? usage.billed_output_tokens : 0,
    billed_cache_write_tokens: Number.isFinite(usage?.billed_cache_write_tokens) ? usage.billed_cache_write_tokens : 0,
    billed_cache_read_tokens: Number.isFinite(usage?.billed_cache_read_tokens) ? usage.billed_cache_read_tokens : 0,
  }
}

function subtractTotals(total, sent) {
  if (sent === null) return total
  return {
    billed_input_tokens: Math.max(0, (total?.billed_input_tokens ?? 0) - (sent?.billed_input_tokens ?? 0)),
    billed_output_tokens: Math.max(0, (total?.billed_output_tokens ?? 0) - (sent?.billed_output_tokens ?? 0)),
    billed_cache_write_tokens: Math.max(0, (total?.billed_cache_write_tokens ?? 0) - (sent?.billed_cache_write_tokens ?? 0)),
    billed_cache_read_tokens: Math.max(0, (total?.billed_cache_read_tokens ?? 0) - (sent?.billed_cache_read_tokens ?? 0)),
  }
}

export function paneUsageFrames({ taskDir, role, id = null, model = null, agent = 'claude', sent = {}, adapter = null, deps = {} } = {}) {
  const readRecords = adapter?.paneUsageRecords ?? SHIPPED_PANE_USAGE[agent] ?? null
  if (!readRecords) return { frames: [], sent, records: 0, skipped: 0 }
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) sent = {}
  let records
  try { records = readRecords({ taskDir, role, deps }) } catch { return { frames: [], sent, records: 0, skipped: 0 } }
  if (!Array.isArray(records)) return { frames: [], sent, records: 0, skipped: 0 }

  const frames = []
  let skipped = 0
  for (const record of records) {
    if (!record || typeof record.session_id !== 'string' || !record.session_id || typeof record.transcript_path !== 'string' || !record.transcript_path) {
      skipped += 1
      continue
    }
    if (Object.hasOwn(sent, record.session_id) && (!sent[record.session_id] || typeof sent[record.session_id] !== 'object' || Array.isArray(sent[record.session_id]))) {
      skipped += 1
      continue
    }
    try {
      const fold = readSessionUsage({ transcriptPath: record.transcript_path })
      if (!fold || typeof fold !== 'object') throw new Error('pane usage fold was not an object')
      const delta = subtractTotals(totalsOf(fold), sent[record.session_id] ?? null)
      frames.push({
        kind: 'usage', id, role, model, session_id: record.session_id,
        transcript_path: record.transcript_path, usage: fold.measured ? delta : null,
      })
      if (fold.measured) sent[record.session_id] = totalsOf(fold)
    } catch {
      skipped += 1
    }
  }
  return { frames, sent, records: records.length, skipped }
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
  // A refusal is an adapter/provider failure; transport-error is the only
  // member of the ledger's closed set available to this lane.
  if (stage === SEAT_REFUSAL_STAGE) return 'transport-error'   // verbatim: mutation C16
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
        // the driver only ever knows the role. This keeps a PANE review tied to
        // the booted cell even when its usage frame is absent (for example a pi
        // pane or an unmeasured Claude transcript). Spread ONLY when the role is
        // seated: an unseated role has no cell, and recordReviewOutcome's own
        // `?? null` is the single place absence is decided.
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
    try { io?.log?.(operationalRow({ at: at(), event: 'seat-teardown', ...seat })) } catch { /* journal is diagnostics */ }
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
      io?.log?.(operationalRow({ at: at(), event: 'seat-teardown-record-failed',
        role: seat.role ?? null, outcome: seat.outcome, reason: seat.reason ?? null }))
    } catch { /* journal is diagnostics */ }
  }
  const summary = { seats: rows.length, ...tally, recorded, record_failed: recordFailed }
  // Written even when it is zero: the journal is the archive and always says
  // teardown ran, while the ledger is the query surface and carries one row
  // per seat.
  try { io?.log?.(operationalRow({ at: at(), event: 'seat-teardown-sweep', ...summary })) } catch {}
  let descendants = null
  try { descendants = io?.reclaimDescendants?.() ?? null } catch { descendants = null }
  return { ...summary, rows, ...(descendants ? { descendants } : {}) }
}

export function providerConditionDetail(err) {
  const message = (err && err.message) || null
  const refusal = err && err.seatRefusal
  if (SEAT_REFUSALS.some((r) => r.member === refusal)) return `[refusal:${refusal}] ${message ?? ''}`.trim()
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
export function reaskDecision({ kind, transport, surfaceId, alive, asked, reassignable = false }) {
  if (kind !== 'unusable-envelope') return { ask: false, why: `failure kind ${String(kind)} is not an unparseable envelope, so there is nothing a re-emit could fix` }
  if (asked) return { ask: false, why: `a re-ask was already sent for this envelope; the bound is ${REASK_MAX} per assignment` }
  if (transport === DEFAULT_TRANSPORT) {
    if (!surfaceId) return { ask: false, why: 'the seat has no recorded surface, so there is no live participant to ask' }
    if (alive !== true) return { ask: false, why: `the pane probe returned ${alive === false ? 'probe-dead' : 'probe-unknown'}, and a re-ask to a seat that is not measurably alive is a fabricated recovery` }
    return { ask: true, why: 'a live pane seat can re-emit its own envelope' }
  }
  // A transport seat has no surface and no liveness to probe: its re-ask is a
  // fresh assignment onto the seam the transport io itself owns, and the only
  // measured question is whether this driver HOLDS that seam.
  if (!reassignable) return { ask: false, why: `transport ${String(transport)} owns its own wait and send seam and this driver holds no re-assign seam for it, so there is nobody here to ask` }
  return { ask: true, why: `transport ${String(transport)} re-asks by a fresh assignment carrying the original id` }
}

// What the driver owes a seat that emitted an UNCLASSIFIED refusal frame, from
// measured facts only: the frame's instant, the newest transcript mtime, now,
// and whether the one re-send was already sent. Pure and exported for the same
// reason reaskDecision is — the policy is unit-testable without a seat. `sentAt`
// IS the bound made visible: once set, this function can never answer 'reask'
// again, so a re-send can no more loop than #392's re-ask can.
export function silenceReaskDecision({ frameAt, latest, at, sentAt = null, quietMs = SILENCE_REASK_MS }) {   // verbatim: mutation G11
  if (!Number.isFinite(frameAt)) return { act: 'none', why: 'no unclassified refusal frame is armed for this assignment' }
  const grewSince = (mark) => Number.isFinite(latest) && latest > mark   // verbatim: mutation G8
  if (!Number.isFinite(sentAt)) {                                        // verbatim: mutation G4
    // A transcript frame AFTER the unclassified frame is the seat answering for
    // itself: a working seat is never re-asked.
    if (grewSince(frameAt)) return { act: 'none', why: 'the seat produced a transcript frame after the unclassified frame' }   // verbatim: mutation G3
    if (at - frameAt >= quietMs) return { act: 'reask', why: `no transcript frame for ${Math.round((at - frameAt) / 1000)}s after an unclassified refusal frame` }   // verbatim: mutation G2
    return { act: 'wait', why: `silent for ${Math.round((at - frameAt) / 1000)}s, under the ${Math.round(quietMs / 1000)}s threshold` }
  }
  if (grewSince(sentAt)) return { act: 'revived', why: 'the seat produced a transcript frame after the re-send' }
  if (at - sentAt >= quietMs) return { act: 'still-silent', why: `no transcript frame for ${Math.round((at - sentAt) / 1000)}s after the one re-send; the bound is ${REASK_MAX} per assignment` }
  return { act: 'wait', why: 'the one re-send is outstanding' }
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

// --- provider retry: the state no transcript instrument can see -------------
// b249-labdefects, 2026-08-25 (#659): a lead's provider request returned 529
// Overloaded and the harness retried INSIDE one turn, the pane banner climbing
// `attempt 8/10` -> `10/10` across ~4.5 minutes. A retry writes NO transcript
// frame, so `transcriptGrowth` kept returning the pre-retry mtime and the stale
// arm of `waitState` below would have named a live seat dead. The operator read
// that frozen mtime as a stalled seat and nearly re-nudged a live turn.
//
// WHERE THE EVIDENCE COMES FROM, stated because an unmeasurable state declared
// as measurable is the defect this fixes: the ONLY source is the PANE's
// rendered text, read with `cmux read-screen`. Nothing else on this side
// carries it — not the transcript, not the journal, not `paneProbe`, which
// answers only that a surface exists. It follows that a headless seat
// (HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT) has no pane and therefore
// CANNOT report this state at all: `paneRetryFrame` returns null there, and
// null is UNKNOWN — never "not retrying" (#297, a NULL beats a value nobody
// measured).
const PANE_RETRY_LINES = 40
// The same CSI shape as crew/headless.mjs:68, kept local because that module is
// outside this lane's fence. A pane frame is ANSI-laden and an unstripped
// matcher can miss a banner split by a colour reset.
const RETRY_ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
// PRIVATE: implementation detail of recogniseProviderRetry, with no external
// consumer.
const PROVIDER_RETRY_BACKOFF = /retrying in (\d+)\s*s/i
const PROVIDER_RETRY_ATTEMPT = /attempt (\d+)\s*\/\s*(\d+)/i

// PURE, so the state is unit-testable without a pane. The BACKOFF clause is the
// gate: a screen that never says it is retrying yields null, so the state is
// read out of the banner and never inferred from a symbol (#623).
export function recogniseProviderRetry(text) {
  if (typeof text !== 'string' || !text) return null
  const plain = text.replace(RETRY_ANSI_CSI, '')
  const backoff = PROVIDER_RETRY_BACKOFF.exec(plain)
  if (backoff === null) return null
  const attempt = PROVIDER_RETRY_ATTEMPT.exec(plain)
  return {
    retry_in_s: Number(backoff[1]),
    attempt: attempt ? Number(attempt[1]) : null,
    of: attempt ? Number(attempt[2]) : null,
    condition: recogniseProviderCondition(plain),
  }
}

// The pane read. EVERY failure path returns null — no surface (the headless
// case), a throwing or non-zero cmux, a stdout that is not a string. A reader
// that could not read is UNKNOWN, and unknown never fabricates a state.
export function paneRetryFrame(surfaceId, deps = {}) {
  if (!surfaceId) return null
  const run = deps.cmux || defaultCmux
  let res
  try { res = run('read-screen', ['--surface', surfaceId, '--lines', String(PANE_RETRY_LINES)]) }
  catch { return null }
  if (!res || res.ok !== true || typeof res.stdout !== 'string') return null
  return recogniseProviderRetry(res.stdout)
}

// #583: the operator — and #583's record — must see that the one extension was
// SPENT. APPENDED to the classifier's own sentence and never woven into it, so
// the text of a wait that got no extension stays byte-identical to today's.
const waitExtendedClause = (extensionS) => ` (budget extended once by ${extensionS}s because the seat was working at the first expiry)`

// Which of four states a wait that expired was in. PURE, so the escalation text
// is unit-testable without a seat. Precedence follows the evidence: a measured
// stale transcript is the CURRENT state and outranks a refusal frame that may be
// minutes old; a NAMED refusal outranks a bare budget overrun; a seat still
// producing frames simply ran out of budget. This never kills or restarts
// anything — naming the state is this lane, the action policy is #567's.
export function waitState({ role, latest, refusal, at, timeoutS, staleMs = TRANSCRIPT_STALE_MS, retry = null }) {
  const measured = Number.isFinite(latest)                                        // verbatim: mutation A5
  const idleS = measured ? Math.max(0, Math.round((at - latest) / 1000)) : null
  // The brief's third state is "refused under a NAMED condition", so membership
  // of the CLOSED vocabulary is the guard, never truthiness.
  // `recogniseSeatRefusal` returns null for any frame no pattern matches
  // (`crew/headless.mjs:68-72`), both transcript readers keep that null as
  // `frame.member`, and `sampleSeatRefusal` stores the frame in `lastRefusal`
  // before its default `journal` action (`crew/seat-io.mjs:1623-1642`) — so a
  // truthy check renders "REFUSED ... (unclassified)" from real production
  // input. An unclassified frame's raw provider message still travels in the
  // timeout evidence (§1g's existing `the provider says:` clause); it just does
  // not get to NAME the state.
  // #669: only a TERMINAL member may name `refused`, and only while its reading
  // is FRESH. `transient` is `terminal: false`, so a seat that recovered falls
  // through to the `working` arm below on its own measured frames — the arm
  // ordering does not change, the membership test does. An unmeasured reading
  // (no `at`) never expires: a NULL beats a value nobody measured (#297).
  const row = refusal ? SEAT_REFUSALS.find((entry) => entry.member === refusal.member) ?? null : null   // verbatim: mutation A16
  const readingAt = Number.isFinite(refusal?.at) ? refusal.at : null
  const expired = readingAt !== null && at - readingAt >= REFUSAL_READING_MAX_MS
  const named = !!row && row.terminal === true && !expired
  // RETRYING outranks STALE, and that ordering IS the #659 fix: a harness
  // retrying a provider call writes no transcript frame, so `latest` is frozen
  // at the instant the turn began and the stale arm below would name a live
  // seat dead. This reading is a CURRENT pane measurement; the frozen mtime is
  // the ABSENCE of one. It outranks a refusal frame for the same reason the
  // existing comment gives for stale: a frame may be minutes old. `retry` is
  // null on every headless seat and on every pane the reader could not read, so
  // this arm cannot fire without evidence.
  if (retry !== null) {                                                         // verbatim: mutation R2
    return { state: 'retrying', text: `the seat is RETRYING: ${role} — its harness is retrying a provider call (attempt ${retry.attempt ?? '?'}/${retry.of ?? '?'}${retry.condition ? `, ${retry.condition}` : ''}), read from the pane; a retry writes no transcript frame, so the ${idleS === null ? 'unmeasured' : `${idleS}s-old`} last frame is not evidence of death` }
  }
  if (measured && at - latest >= staleMs) {                                       // verbatim: mutation A2
    return { state: 'stale', text: `the seat is STALE: ${role} produced its last transcript frame ${idleS}s ago, past the ${Math.round(staleMs / 1000)}s staleness threshold — a spinner and an elapsed timer are not evidence of life` }
  }
  if (named) {
    return { state: 'refused', text: `the seat REFUSED: ${role} — the provider says: ${refusal.message} (${refusal.member})` }   // verbatim: mutation A3
  }
  if (measured) {
    return { state: 'working', text: `the seat is WORKING: ${role} produced a transcript frame ${idleS}s ago and simply exceeded its ${timeoutS}s budget` }   // verbatim: mutation A4
  }
  return null   // unmeasured is not stale (#297): a NULL beats a value nobody measured
}

// The newest mtime across a seat's transcript files, or null when NOTHING is
// readable. Growth is the measurement; absence of a reading is NOT staleness.
export function transcriptGrowth(paths, deps = {}) {
  const stat = deps.statSync ?? fsStatSync
  let latest = null
  for (const path of Array.isArray(paths) ? paths : []) {
    let mtime
    try { mtime = stat(path).mtimeMs } catch { continue }
    if (!Number.isFinite(mtime)) continue
    if (latest === null || mtime > latest) latest = mtime                          // verbatim: mutation A6
  }
  return latest
}

export function waitForEnvelope({ returnPath, timeoutS, role, readEnvelope, probeSeat, sampleSeat, sampleGrowth, onGrowth, onSubstrate, onAlive, classifyExpiry, onExtend, now, sleep }) {
  const started = now()
  let deadline = started + timeoutS * 1000
  let lastProbeAt = started
  let misses = 0
  let substrateMisses = 0
  let extended = false
  let expired = null
  // #583: ONE bounded extension for a seat this driver ITSELF classifies as
  // WORKING at its first expiry. Measured four times, most recently on
  // b309-dispatchprep: the escalation text said `the seat is WORKING: planner
  // produced a transcript frame 30s ago` and the driver exited anyway; the
  // envelope landed 7 minutes later in a returns/ nobody read. The grant is the
  // SAME shape as the restartBudget seam below — it moves `deadline` and
  // nothing else — and it is spent at most once per wait: a second expiry ends
  // the wait exactly as it does today. A `stale`, `retrying`, `refused` or
  // UNMEASURED (null) classification buys nothing: a NULL beats a value nobody
  // measured (#297), and a retrying seat already has its own restartBudget
  // path. A classifier that throws is an absence, never a grant.
  const atDeadline = () => {
    // #669: the deadline is a CLOCK reading, not a measurement of the seat. A
    // seat that wrote its envelope during the final poll interval loses every
    // byte of it for no reason; one last read costs one stat.
    expired = readEnvelope()
    if (expired != null) return false
    if (extended || typeof classifyExpiry !== 'function') return false
    const at = now()
    let verdict = null
    try { verdict = classifyExpiry(at) } catch { verdict = null }
    if (verdict?.state !== 'working') return false
    extended = true
    deadline = at + timeoutS * 1000
    if (onExtend) { try { onExtend({ at, extensionS: timeoutS }) } catch { /* the journal is never load-bearing for a wait */ } }
    return true
  }
  while (now() < deadline || atDeadline()) {
    const env = readEnvelope()
    if (env != null) return env

    const current = now()
    if (probeSeat && current - lastProbeAt >= LIVENESS_PROBE_MS) {
      lastProbeAt = current
      const raw = probeSeat()
      const probe = (raw && typeof raw === 'object') ? raw : { alive: raw, substrate: null }
      const alive = probe.alive
      if (sampleSeat) {
        let signal = null
        try { signal = sampleSeat(current) } catch (err) {
          // A refusal is the third member of the seat-died / substrate-gone family:
          // the ONLY exception a sample may end a wait with. Everything else stays
          // never-load-bearing, exactly as before.
          if (err && err.stage === SEAT_REFUSAL_STAGE) throw err
        }
        // One bounded re-prompt has been sent to this seat: the clock it was
        // waiting against belongs to a request the provider never accepted.
        if (signal && signal.restartBudget === true) deadline = current + timeoutS * 1000
      }
      // Transcript growth on the SAME tick as the pane probe. The pane says a
      // surface EXISTS; only the transcript says a frame ARRIVED. Never
      // load-bearing and never fatal: a throwing sampler is swallowed exactly
      // like sampleSeat's non-refusal exceptions, and a stale reading ends
      // nothing here — it is recorded so the ESCALATION can name it.
      if (sampleGrowth) {
        let latest = null
        try { latest = sampleGrowth(current) } catch { latest = null }
        if (Number.isFinite(latest) && onGrowth) onGrowth({ at: current, latest })  // verbatim: mutation A7
      }
      // A heartbeat is a MEASUREMENT: stamped only where liveness was
      // OBSERVED. `current` is that probe's own timestamp — the same instant
      // the miss accounting records as `lastProbeAt`. An indeterminate probe
      // (null) and a miss (false) write NOTHING: a NULL beats a value nobody
      // measured (#297). The callback is the caller's to guard — seatIo.wait
      // owns that try/catch because it owns the emitter.
      if (alive === true) { misses = 0; if (onAlive) onAlive(current) }
      else if (alive === false) misses += 1
      // The substrate is now SURVIVABLE for SUBSTRATE_GRACE_MS, so this wait can
      // sit silently through minutes an operator must be able to account for.
      // Edge-triggered, exactly like the retry family: the caller hears the
      // RISING edge once, and hears the recovery only when a probe MEASURES it.
      // Never load-bearing — the caller owns the try/catch, as it does for onAlive.
      if (probe.substrate === 'down') {
        substrateMisses += 1
        if (substrateMisses === 1 && onSubstrate) onSubstrate({ at: current, state: 'down', misses: substrateMisses, graceMs: SUBSTRATE_GRACE_MS })
      } else if (probe.substrate === 'ok') {
        if (substrateMisses > 0 && onSubstrate) onSubstrate({ at: current, state: 'ok', misses: substrateMisses, graceMs: SUBSTRATE_GRACE_MS })
        substrateMisses = 0   // a recovery is a MEASUREMENT: it forgives the outage that just ended
      }
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
        const err = new Error(`substrate gone: ${role} — the pane manager stopped answering (${SUBSTRATE_MISSES_TO_DIE} consecutive substrate probes over ${SUBSTRATE_GRACE_MS / 1000}s), so every pane it owned is unreachable and no envelope arrived at ${returnPath}`)
        err.stage = 'substrate-gone'
        err.role = role
        throw err
      }
    }
    sleep(WAIT_POLL_MS)
  }
  // The wait ended at an expiry `atDeadline` already read for (#669) — the
  // envelope it found, or null. b254-retryvis wrote `status: done` with a green
  // gate five minutes after its driver had already exited on this return.
  return expired
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

// --- the COLD verification checkout --------------------------------------------
// Why a NEUTRAL path, and not /tmp/coldcheck-<lane>: measured on b281-spawnbudget
// / PR #706, byte-identical files at an identical HEAD were GREEN in the lane's
// worktree and RED in CI. The discriminator was neither warmth nor cached state —
// it was the checkout PATH. The failing assertion was
// `assert.match(refusedOf(run.result), /budget/i)`, and the refusal embeds an
// absolute path, so /budget/i was matching the DIRECTORY NAME: the lane's worktree
// was dt-b281-spawnbudget and CI's checkout was not. The budget refusal never
// fired on either side. A cold checkout cut at /tmp/coldcheck-b281-spawnbudget
// would have carried the lane name straight back into the path and PRESERVED that
// bug, so the only path that discriminates is one sharing no meaningful substring
// with the lane name or the repository name. COLD_PATH_MIN_SHARED is where
// "meaningful" is set: three characters is short enough to catch `budget` inside a
// longer name, and long enough that a two-character hex coincidence does not churn
// the generator.
export const COLD_PATH_MIN_SHARED = 3
export const COLD_PATH_ATTEMPTS = 32

// The ordered production FALLBACK roots, tried after node:os.tmpdir(). /tmp is here
// because the default macOS temp root CANNOT serve this repository: tmpdir() is
// /var/folders/<...>/T, whose canonical form is /private/var/folders/<...>/T, and
// `folders` carries the window `old` — which is also a window of every *-coldverify
// lane name. Every candidate below that root therefore collides no matter how its
// final segment is drawn, so a single-root generator would refuse to cold-verify
// this very lane on an ordinary developer machine. Canonical /private/tmp shares
// nothing with this lane, this worktree or this repository.
export const COLD_PATH_FALLBACK_ROOTS = Object.freeze(['/tmp'])

// PURE. A shared substring of exactly COLD_PATH_MIN_SHARED characters occurring in
// BOTH `path` and one of `names`, or '' when the path is neutral. A shared substring
// of AT LEAST that length exists iff a shared window of exactly that length does, so
// scanning fixed windows is equivalent to (and simpler than) a longest-first search.
// Callers need only collision/non-collision, so WHICH window is reported is not part
// of the contract. Case-insensitive, because a test regex is routinely /budget/i.
export function coldPathCollision(path, names = []) {
  const haystack = String(path).toLowerCase()
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || '').toLowerCase()
    for (let i = 0; i + COLD_PATH_MIN_SHARED <= name.length; i += 1) {
      const piece = name.slice(i, i + COLD_PATH_MIN_SHARED)
      if (haystack.includes(piece)) return piece
    }
  }
  return ''
}

// PURE. The WHOLE guarded name occurring in `path`, case-insensitively, or '' when
// none does. This is the ROOT rule, and it is deliberately weaker than
// coldPathCollision's sliding window: measured 2026-08-29 on b317-drivergone, the
// window rule applied to the ROOT rejected every macOS temp root, because `riv`
// is a window of d-riv-ergone and every macOS temp root canonicalises under
// /private — /private/tmp and /private/var/folders alike — so a green suite
// escalated at its last step on an ordinary developer Mac. A root is dangerous
// only when a test regex built from a guarded name could match it, and that needs
// the WHOLE name; a three-character coincidence with a system directory cannot.
// The window rule stays where it was tuned: the random LEAF. Names shorter than
// COLD_PATH_MIN_SHARED are ignored here for the reason coldGuardNames drops them.
export function coldRootCollision(path, names = []) {
  const haystack = String(path).toLowerCase()
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || '').trim().toLowerCase()
    if (name.length < COLD_PATH_MIN_SHARED) continue
    if (haystack.includes(name)) return name
  }
  return ''
}

// The names a cold checkout must share nothing with: the directory the lane built
// in (always dt-<lane> for a dispatched lane) and the repository that worktree
// belongs to. In a LINKED worktree those two differ, and the repository half is the
// one the checkout basename cannot supply. The caller adds the lane name and the
// task name, which it is the only one to know. Short and dot names are dropped:
// they would collide with everything.
export function coldGuardNames(checkout = '', gitCommonDir = '') {
  const repo = gitCommonDir ? basename(dirname(String(gitCommonDir))) : ''
  return [basename(String(checkout || '')), repo]
    .map((name) => String(name || '').trim())
    .filter((name) => name.length >= COLD_PATH_MIN_SHARED && name !== '.' && name !== '..')
}

// The ORDERED roots to try. An explicit tmpRoots (or a single tmpRoot) is used
// verbatim — a caller that names its roots gets exactly those and no silent
// fallback; the production default is tmpdir() first, then COLD_PATH_FALLBACK_ROOTS.
export function coldPathRoots(deps = {}) {
  if (Array.isArray(deps.tmpRoots) && deps.tmpRoots.length) return [...deps.tmpRoots]
  if (deps.tmpRoot) return [String(deps.tmpRoot)]
  return [tmpdir(), ...COLD_PATH_FALLBACK_ROOTS]
}

// Cut a path no test regex can match by accident: coldPathCollision measures the random
// LEAF the generator mints with its 3-character-window rule, while coldRootCollision
// measures the canonical ROOT by WHOLE guarded names (see its comment for why).
// Randomness alone is not enough: hex digits collide with lane names like b304-coldverify,
// so a candidate sharing a substring with a guarded name is DISCARDED and redrawn. Each
// root is CANONICALIZED first and the candidate is built under the canonical form, because
// the canonical path is the one the process actually enters — a neutral-looking symlink
// pointing into a colliding directory would otherwise pass. A root whose own canonical
// path already collides can never yield a neutral candidate, so it is rejected BEFORE any
// redraw rather than after burning all of them. Exhaustion of every root is never silent
// and never falls open: it THROWS.
export function neutralColdPath(names = [], deps = {}) {
  const rand = deps.rand || (() => randomUUID().replaceAll('-', ''))
  const attempts = deps.attempts || COLD_PATH_ATTEMPTS
  const realpath = deps.realpath || fsRealpathSync
  const rejected = []
  for (const raw of coldPathRoots(deps)) {
    let root
    try { root = String(realpath(String(raw))) } catch (err) { rejected.push(`${raw}: unresolvable (${err.message})`); continue }
    const rootHit = coldRootCollision(root, names)
    if (rootHit) { rejected.push(`${root}: the root itself contains the guarded name ${JSON.stringify(rootHit)}`); continue }
    let last = ''
    for (let i = 0; i < attempts; i += 1) {
      const leaf = String(rand(i))
      last = coldPathCollision(leaf, names)
      if (!last) return join(root, leaf)
    }
    rejected.push(`${root}: ${attempts} candidates all shared ${JSON.stringify(last)}`)
  }
  throw new Error(`neutralColdPath: no neutral cold checkout path for ${JSON.stringify(names)} — every candidate root was rejected [${rejected.join('; ')}]; point TMPDIR (or the cold tmpRoots dep) at a directory whose CANONICAL path shares no substring with this lane or repository`)
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
  const mkdirSync = deps.mkdirSync || fsMkdirSync
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
  const refusalFloor = new Map()      // role -> the instant after which a frame is THIS request's
  const lastRefusal = new Map()       // role -> the last refusal frame seen, the evidence a failure quotes
  const lastGrowth = new Map()        // returnPath -> { at, latest }, the last measured transcript reading
  const lastDiagnosis = new Map()     // returnPath -> the state a wait expired in
  const waitExtensions = new Map()    // returnPath -> the seconds this dispatch's ONE wait extension bought
  const staleNoted = new Set()        // returnPaths already warned — one per DISPATCH, re-armable
  const substrateNoted = new Set()   // returnPaths whose substrate outage is standing
  const lastRetry = new Map()         // returnPath -> the CURRENT pane retry reading, refreshed on every read
  const repromptedRefusals = new Set() // returnPaths already re-prompted — the bound, per assignment
  const silenceWatch = new Map()      // returnPath -> the unclassified frame being watched for silence
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
  const refusalError = (info, returnPath, frame) => {
    const at = Number.isFinite(frame?.at) ? frame.at : now()
    const err = new Error(`seat refused: ${info?.role || 'unknown'} — the provider says: ${frame?.message ?? ''} `
      + `(${frame?.member ?? 'unclassified'}, from the ${frame?.source || 'unknown'} transcript at ${new Date(at).toISOString()}); `
      + `no envelope arrived at ${returnPath}`)
    err.stage = SEAT_REFUSAL_STAGE
    err.role = info?.role || 'unknown'
    err.seatRefusal = frame?.member
    return err
  }
  const sampleSeatRefusal = (info, at) => {
    const role = info?.role
    if (!role) return null
    const member = crew.members?.[role] || null
    const reader = deps.refusalFrames ?? SHIPPED_REFUSAL_READERS[member?.agent ?? 'claude'] ?? null
    let frames
    try {
      frames = typeof reader === 'function'
        ? reader({
          checkout, taskDir: paths.taskDir, role,
          since: refusalFloor.get(role) ?? info.at,
          adapter: adapters?.[role]?.adapter ?? null, deps,
        })
        : []
    } catch { frames = [] }
    if (!Array.isArray(frames)) frames = []
    for (const frame of frames) {
      if (!frame || !Number.isFinite(frame.at)) continue
      refusalFloor.set(role, frame.at)          // never re-fire on a frame already handled
      lastRefusal.set(role, frame)
      const policyKey = frame.member ?? UNCLASSIFIED_REFUSAL
      const action = Object.hasOwn(SEAT_REFUSAL_ACTIONS, policyKey) ? SEAT_REFUSAL_ACTIONS[policyKey] : 'journal'
      const note = (outcome, extra = {}) => {
        try {
          io.log(recordRow({ event: 'seat-refusal', role, id: info?.id ?? null, member: frame.member,
            source: frame.source, message: frame.message, at: frame.at, outcome,
            ...(frame.member === 'overflowed' ? { news: 'first-occurrence' } : {}), ...extra }))
        } catch { /* refusal journalling is diagnostics, never load-bearing */ }
      }
      if (action === 'end') {
        note('ended')
        throw refusalError(info, info?.returnPath, frame)
      }
      if (action === 'reprompt-on-silence') {   // verbatim: mutation G5
        armSilenceWatch(info, frame)
        note('watching')
        continue
      }
      if (action !== 'reprompt') {
        note('journalled')
        continue
      }
      if (repromptedRefusals.has(info?.returnPath)) {   // verbatim: mutation C13
        note('ended-after-reprompt')
        throw refusalError(info, info?.returnPath, frame)
      }
      if (!info?.surface_id || (member?.transport && member.transport !== DEFAULT_TRANSPORT)) {
        note('declined', { why: !info?.surface_id ? 'no surface_id' : `transport ${member.transport} is not pane` })
        continue
      }
      repromptedRefusals.add(info?.returnPath)       // verbatim: mutation C15
      try {
        sendLine(info.surface_id, assignmentLine({ id: info.id, role, briefFile: info.brief, returnPath: info.returnPath, taskDir: paths.taskDir }))
      } catch (sendErr) {
        note('undelivered', { why: sendErr?.message || 'assignment send failed' })
        continue
      }
      note('reprompted')
      return { restartBudget: true }
    }
    return pollSilence(info, at)
  }
  // Same seam as sampleSeatRefusal: agent-keyed, deps-overridable. The pi reader
  // addresses a CHECKOUT, not a seat (piSessionDir), so a busy sibling can mask a
  // stale pi seat — that is the same coarseness piRefusalFrames already
  // carries, and it errs toward 'working', never toward a false 'stale'.
  const growthFor = (info) => {
    const role = info?.role
    if (!role) return null
    const member = crew.members?.[role] || null
    const reader = deps.transcriptPaths ?? SHIPPED_TRANSCRIPT_READERS[member?.agent ?? 'claude'] ?? null
    let files
    try {
      files = typeof reader === 'function'
        ? reader({ checkout, taskDir: paths.taskDir, role, adapter: adapters?.[role]?.adapter ?? null, deps })
        : []
    } catch { return null }
    return transcriptGrowth(files, deps)
  }
  // Edge-triggered in the JOURNAL, level-tracked in memory. The rising edge is
  // journalled once; the reading itself is refreshed on EVERY successful read,
  // so an expiry diagnosis quotes attempt 10, not the attempt 8 that first
  // crossed. A headless seat declines here and journals nothing: honest
  // silence, never a claim of health.
  const noteRetry = (info, returnPath, at) => {
    try {
      const member = crew.members?.[info?.role] || null
      if (!info?.surface_id || (member?.transport && member.transport !== DEFAULT_TRANSPORT)) return
      const reading = paneRetryFrame(info.surface_id, { cmux })
      const standing = lastRetry.get(returnPath) ?? null
      if (reading) {
        lastRetry.set(returnPath, reading)                                      // verbatim: mutation P2
        if (!standing) io.log(operationalRow({ at, event: 'seat-retrying', role: info.role, id: info.id ?? null, attempt: reading.attempt, of: reading.of, retry_in_s: reading.retry_in_s, condition: reading.condition, source: 'pane' }))
      } else if (standing) {
        clearRetry(info, returnPath, at)
      }
    } catch { /* the retry reading is evidence, never load-bearing for a wait */ }
  }

  // `waitForEnvelope` returns an arriving envelope BEFORE any probe
  // (crew/seat-io.mjs:1499-1502), so the ordinary success shape — the retry
  // succeeds, the seat writes its envelope, the next 5s poll reads it — never
  // reaches another 30s sample. A reading only ever cleared by a later sample
  // would therefore stand forever on the happy path.
  const clearRetry = (info, returnPath, at) => {
    if (!lastRetry.has(returnPath)) return
    lastRetry.delete(returnPath)
    try { io.log(operationalRow({ at, event: 'seat-retry-cleared', role: info?.role ?? null, id: info?.id ?? null, source: 'pane' })) }
    catch { /* the journal is diagnostics, never load-bearing for a wait */ }
  }

  // A survivable outage is a state, and a state nobody can see is what #682
  // actually cost. Edge-triggered in the JOURNAL like the retry family: the
  // rising edge is journalled once, and only a MEASURED `ok` probe retires it.
  const noteSubstrate = (info, returnPath, record) => {
    try {
      if (record.state === 'down') {
        if (substrateNoted.has(returnPath)) return
        substrateNoted.add(returnPath)
        io.log(operationalRow({ at: record.at, event: 'seat-substrate-down', role: info?.role ?? null, id: info?.id ?? null, misses: record.misses, grace_ms: SUBSTRATE_GRACE_MS }))
        return
      }
      if (!substrateNoted.delete(returnPath)) return
      io.log(operationalRow({ at: record.at, event: 'seat-substrate-recovered', role: info?.role ?? null, id: info?.id ?? null, misses: record.misses, grace_ms: SUBSTRATE_GRACE_MS }))
    } catch { /* the journal is diagnostics, never load-bearing for a wait */ }
  }

  // A stale row was TRUE WHEN WRITTEN; leaving it standing makes a recovered
  // seat read stale for the life of the process. Only a MEASUREMENT retires it.
  const clearStale = (info, returnPath, at) => {
    if (!staleNoted.has(returnPath)) return
    staleNoted.delete(returnPath)
    try { io.log(operationalRow({ at, event: 'seat-stale-cleared', role: info?.role ?? null, id: info?.id ?? null })) }
    catch { /* the journal is diagnostics, never load-bearing for a wait */ }
  }

  // Retry state is retired at EVERY exit: the provider call ended, whatever
  // ended it. Stale state is NOT. A budget that expired measured nothing about
  // the transcript — `waitForEnvelope` returns null on its deadline without a
  // further sample (:1497-1563) — so clearing stale there would turn a
  // still-frozen seat `active` on the strength of a clock. Only a completing
  // envelope (positive evidence the seat produced work) or measured
  // sub-threshold growth in `noteGrowth` retires it. A lane that then settles or
  // escalates is already non-active via `laneActive`.
  const settleSeatConditions = (info, returnPath, at, envelope) => {
    clearRetry(info, returnPath, at)
    // The wait ending measures nothing about the pane manager, so a recovery
    // row here would be a claim nobody made; retire the standing edge silently.
    substrateNoted.delete(returnPath)
    waitExtensions.delete(returnPath)
    if (envelope != null) clearStale(info, returnPath, at)                      // verbatim: mutation X1
  }

  // The classifier the escalation text already uses, asked at BOTH expiries: the
  // first (inside waitForEnvelope, where a WORKING seat buys one extension) and
  // the last (below, where it names the state the wait ended in). ONE function,
  // so the reading that grants the extension and the reading the operator reads
  // can never diverge.
  const diagnoseExpiry = (info, returnPath, at, timeoutS) => waitState({
    role: info?.role || 'unknown', latest: lastGrowth.get(returnPath)?.latest ?? null,
    refusal: lastRefusal.get(info?.role) ?? null, at, timeoutS,                  // verbatim: mutation A15
    retry: lastRetry.get(returnPath) ?? null,
  })

  // Journalled through the SAME operational path `seat-stale` uses: the role, the
  // assignment id, the idle seconds the classifier measured, and the seconds
  // granted. Never load-bearing — the journal is diagnostics, the wait is the run.
  const noteWaitExtended = (info, returnPath, record) => {
    waitExtensions.set(returnPath, record.extensionS)
    const latest = lastGrowth.get(returnPath)?.latest ?? null
    const idleS = Number.isFinite(latest) ? Math.max(0, Math.round((record.at - latest) / 1000)) : null
    try { io.log(operationalRow({ at: record.at, event: 'wait-extended', role: info?.role ?? null, id: info?.id ?? null, idle_s: idleS, extension_s: record.extensionS })) }
    catch { /* the journal is diagnostics, never load-bearing for a wait */ }
  }

  const noteGrowth = (info, returnPath, record) => {
    lastGrowth.set(returnPath, record)
    const role = info?.role
    if (!role) return
    if (record.at - record.latest < TRANSCRIPT_STALE_MS) { clearStale(info, returnPath, record.at); return }   // verbatim: mutation X2
    if (staleNoted.has(returnPath)) return
    staleNoted.add(returnPath)
    try { io.log(operationalRow({ at: record.at, event: 'seat-stale', role, id: info?.id ?? null, last_frame_at: record.latest, stale_ms: record.at - record.latest, threshold_ms: TRANSCRIPT_STALE_MS })) }
    catch { /* the journal is diagnostics, never load-bearing for a wait */ }
  }

  // ONE sampler for both pane waits. Production has two waitForEnvelope call
  // sites — the bounded malformed-envelope re-ask (:1899) and the ordinary wait
  // (:2040) — and a retry storm during the re-ask was exactly as invisible as
  // one during the wait. Neither call changes waitForEnvelope's exported
  // signature: this is the caller's own arrow, as before.
  const samplePane = (info, returnPath) => (at) => {
    noteRetry(info, returnPath, at)
    return sampleSeatRefusal({ ...info, returnPath }, at)
  }

  const armSilenceWatch = (info, frame) => {
    const returnPath = info?.returnPath
    if (!returnPath) return
    const watch = silenceWatch.get(returnPath)
    // A SECOND unclassified frame before any re-send is itself evidence of life:
    // restart the quiet clock rather than counting silence from the first one.
    if (!watch) silenceWatch.set(returnPath, { frameAt: frame.at, sentAt: null, notedSilent: false })
    else if (watch.sentAt === null) watch.frameAt = frame.at
  }
  // The liveness tick already measures transcript growth (:1495); this is the
  // same measurement asked the one question nothing asked before — has the seat
  // said ANYTHING since it errored? Never fatal: no path here throws, so a
  // silent seat's wait ends exactly as it does today unless a re-send revives it.
  const pollSilence = (info, at) => {
    const returnPath = info?.returnPath
    const watch = returnPath ? silenceWatch.get(returnPath) : null
    if (!watch) return null
    const decision = silenceReaskDecision({ frameAt: watch.frameAt, latest: growthFor(info), at, sentAt: watch.sentAt })
    const note = (outcome, extra = {}) => {
      try {
        io.log(recordRow({
          at, event: 'seat-silence-reask', role: info?.role ?? null, id: info?.id ?? null, returnPath,
          outcome, why: decision.why, silent_ms: at - (watch.sentAt ?? watch.frameAt), ...extra,
        }))
      } catch { /* the journal is diagnostics, never load-bearing for a wait */ }
    }
    if (decision.act === 'wait') return null
    if (decision.act === 'none') { silenceWatch.delete(returnPath); note('growing'); return null }
    if (decision.act === 'revived') { silenceWatch.delete(returnPath); note('revived'); return null }
    if (decision.act === 'still-silent') {
      if (watch.notedSilent) return null
      watch.notedSilent = true
      note('still-silent')
      return null
    }
    // 'reask'. The bound is the SAME set #567's reprompt uses, so one assignment
    // can never be re-sent twice by the two paths between them.
    const member = crew.members?.[info?.role] || null
    if (repromptedRefusals.has(returnPath)) {
      silenceWatch.delete(returnPath)
      note('declined', { why: `the re-send bound of ${REASK_MAX} per assignment is already spent` })
      return null
    }
    if (!info?.surface_id || (member?.transport && member.transport !== DEFAULT_TRANSPORT)) {
      silenceWatch.delete(returnPath)
      note('declined', { why: !info?.surface_id ? 'no surface_id' : `transport ${member.transport} is not pane` })
      return null
    }
    repromptedRefusals.add(returnPath)
    watch.sentAt = at
    try {
      sendLine(info.surface_id, assignmentLine({ id: info.id, role: info.role, briefFile: info.brief, returnPath, taskDir: paths.taskDir }))
    } catch (sendErr) {
      note('undelivered', { why: sendErr?.message || 'assignment send failed' })
      return null
    }
    note('sent')
    return { restartBudget: true, silence: 'sent' }   // verbatim: mutation G7
  }
  const reaskUnusableEnvelope = ({ returnPath, info, transport, err, timeoutS }) => {
    const role = info?.role || 'unknown'
    const surfaceId = transport ? null : (info?.surface_id || null)
    const alive = surfaceId ? paneAlive(surfaceId, { tree, locate }) : null
    const transportName = transport ? (crew.members?.[role]?.transport || 'unknown') : DEFAULT_TRANSPORT
    // What this driver HOLDS, measured rather than assumed: an ENROLLED transport
    // io that exposes both halves of the seam is one this driver can ask again.
    // The NAME is load-bearing — a member whose transport this build never
    // enrolled, or cannot name at all, is refused rather than promised a re-ask
    // nothing here knows how to deliver.
    const reassignable = !!transport && REASK_TRANSPORTS.has(transportName) && typeof transport.assign === 'function' && typeof transport.wait === 'function'
    let attempts = 1
    const decision = reaskDecision({
      kind: cellFailureKind(err),
      transport: transportName,
      surfaceId,
      alive,
      asked: reasked.has(returnPath),
      reassignable,
    })
    const note = (outcome, extra = {}) => {
      try { io.log(recordRow({ at: now(), event: 'envelope-reask', role, id: info?.id ?? null, returnPath, transport: transportName, outcome, ...extra })) }
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
    const reaskId = info?.id || 'reask'
    const briefPath = join(paths.taskDir, `reask-${reaskId}.${role}.md`)
    // A transport re-ask collects on its OWN path. The seat's original file is
    // evidence: read, never rewritten and never removed — so the second envelope
    // needs somewhere else to land, or the transport's own wait reads the stale
    // unparseable bytes straight back as the answer.
    const reaskPath = join(paths.returnsDir, `${reaskId}.reask.${role}.json`)
    let collectPath = returnPath
    try {
      // The brief is written BEFORE the message is annotated, so what the seat
      // reads is the parse failure verbatim and nothing else.
      writeFileSync(briefPath, reaskBrief({ role, id: reaskId, returnPath: reassignable ? reaskPath : returnPath, message: err.message }))
      if (reassignable) {
        // The id is the ORIGINAL one: an envelope carrying the re-ask's own id
        // would be refused by the driver's anti-replay check (crew/drive.mjs:631)
        // and the recovery would be spent for nothing. EVERY delivery attempt is
        // journalled with its ordinal — a minute of refused deliveries that only
        // reported its own last line would be a minute nobody can read back.
        let polls = 0
        for (;;) {
          attempts = polls + 1
          try {
            const attempt = transport.assign({ role, briefFile: briefPath, reask: { id: reaskId, returnPath: reaskPath } })
            collectPath = attempt?.returnPath || reaskPath
            break
          } catch (assignErr) {
            if (!REASK_BUSY_STAGES.has(assignErr?.stage) || polls >= REASK_SETTLE_POLLS) throw assignErr
            note('busy', { attempt: attempts, why: assignErr.message })
            polls += 1
            sleep(REASK_SETTLE_MS)
          }
        }
      } else {
        sendLine(surfaceId, assignmentLine({ id: reaskId, role, briefFile: briefPath, returnPath, taskDir: paths.taskDir }))
      }
    } catch (sendErr) {
      err.message = `${err.message}\n[re-ask attempted and not delivered: ${sendErr.message}]`
      err.reask = { attempted: true, delivered: false, recovered: false, why: sendErr.message }
      note('undelivered', { why: sendErr.message, attempt: attempts })
      return { envelope: null, error: err }
    }
    note('sent', { brief: briefPath, attempt: attempts })
    const window = Math.min(timeoutS, REASK_TIMEOUT_S)
    try {
      const env = reassignable
        ? transport.wait(collectPath, window)
        : waitForEnvelope({
        returnPath,
        timeoutS: window,
        role,
        readEnvelope: () => {
          let raw
          try { raw = String(readFileSync(returnPath, 'utf8')) } catch { return null }
          if (raw === staleRaw) return null
          return readEnvelopeFile(returnPath, { existsSync, readFileSync, role })
        },
        probeSeat: () => paneProbe(surfaceId, { tree, locate }),
        sampleSeat: samplePane(info, returnPath),
        sampleGrowth: () => growthFor(info),
        onGrowth: (record) => noteGrowth(info, returnPath, record),
        onSubstrate: (record) => noteSubstrate(info, returnPath, record),
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
      // What the SECOND attempt actually did, named from the same closed set the
      // first failure was named from. `unparseable-again` is now reserved for the
      // one case it describes; anything else is a re-ask that failed before it
      // could produce a usable envelope, and it says so rather than borrowing a
      // parse defect's name.
      const secondKind = cellFailureKind(secondErr)
      if (secondErr && secondErr.stage === SEAT_REFUSAL_STAGE) {
        note('failed', { failure: secondKind, second: secondErr.stage || null, refused: true })
        throw secondErr
      }
      if (secondKind === 'unusable-envelope') {
        err.message = `${err.message}\n[re-ask attempted: one re-ask was sent to ${role} and the second envelope is still unparseable: ${secondErr.message}]`
        err.reask = { attempted: true, delivered: true, recovered: false, second: secondErr.message }
        note('unparseable-again', { second: secondErr.stage || null })
      } else {
        err.message = `${err.message}\n[re-ask failed before producing a usable envelope: ${secondErr.message}]`
        err.reask = { attempted: true, delivered: true, recovered: false, failure: secondKind, second: secondErr.stage || null }
        note('failed', { failure: secondKind, second: secondErr.stage || null })
      }
    }
    return { envelope: null, error: err }
  }
  // The stash stack is NOT per-worktree: `git rev-parse --git-path refs/stash` resolves to the SAME file in the common git dir from every linked worktree,
  // so `git stash pop` restores whatever lane pushed LAST (#471). The entry a
  // push created is identified by the unique message it carries and restored by
  // its own commit id; an entry we cannot prove is ours is a refusal, never a
  // plausible guess.
  const paneUsageSentPath = (role) => join(paths.taskDir, 'usage', `${role}.sent.json`)
  const emitPaneUsage = (info) => {
    try {
      const member = crew.members?.[info?.role] || null
      const sentPath = paneUsageSentPath(info.role)
      let sent = {}
      try {
        const parsed = JSON.parse(String(readFileSync(sentPath, 'utf8')))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sent = parsed
      } catch { sent = {} }
      const result = paneUsageFrames({
        taskDir: paths.taskDir, role: info.role, id: info.id,
        model: member?.model ?? null, agent: member?.agent ?? 'claude', sent,
        adapter: adapters?.[info.role]?.adapter ?? null, deps,
      })
      for (const frame of result.frames || []) {
        try { io.emit?.(frame) } catch { /* usage instrumentation is never load-bearing */ }
      }
      try {
        mkdirSync(join(paths.taskDir, 'usage'), { recursive: true })
        writeFileSync(sentPath, JSON.stringify(result.sent))
      } catch { /* durable usage is best-effort; the frame already carried the observation */ }

      const readRecords = adapters?.[info.role]?.adapter?.paneUsageRecords
        ?? SHIPPED_PANE_USAGE[member?.agent ?? 'claude'] ?? null
      let records = []
      try { records = readRecords ? readRecords({ taskDir: paths.taskDir, role: info.role, deps }) : [] } catch { records = [] }
      for (const record of records) {
        try {
          const fold = readSessionUsage({ transcriptPath: record.transcript_path })
          io.log(operationalRow({
            event: 'pane-usage', role: info.role, id: info.id ?? null,
            session_id: record.session_id, parent: fold.parent_usage ?? null,
            subagents: fold.subagent_usage ?? null, subagent_files: fold.subagent_files ?? 0,
            measured: fold.measured === true,
          }))
        } catch { /* the journal is diagnostics, never load-bearing */ }
      }
    } catch { /* ADR-026: pane usage measurement is never load-bearing */ }
  }
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
  // THE WINDOW BELONGS TO THE DRIVER (#725). runClean sets the ENTIRE working
  // tree aside and runs an arbitrary gate command against it for seconds to
  // minutes; nothing stops a still-alive seat from writing into that tree while
  // it does. Recorded live on b175-paneusage 2026-08-23, where what merged was
  // correct by ordering luck alone. The posture is settled and stated here: the
  // working tree belongs to the driver for as long as a runClean window is open,
  // and a violation is DETECTED AND NAMED — never prevented, never silently
  // tolerated. No quiescence, pause or seat lock is built here; #725 ask 3 chose
  // detection as the first increment and this is that increment.
  //
  // BLIND SPOT: a seat that CREATES a new file mid-window is not caught. A gate
  // command legitimately writes untracked artifacts and this witness cannot tell
  // those from a seat's new file, so `added` paths are REPORTED — in the refusal
  // detail and in the journal row — and never refused.
  const treeWitness = (path) => (deps.fingerprintTree || fingerprintTree)(path)
  // What the window is refused FOR, or null when nothing it can adjudicate
  // happened. An unmeasurable side comes first and is never widened: a tree that
  // could not be measured is never reported as a quiet one.
  const witnessViolation = (diff) => {
    if (diff.outcome === FINGERPRINT_OUTCOMES.unmeasurable) return `the tree could not be measured on the ${diff.side} side of the window: ${diff.cause}${diff.detail ? ` (${diff.detail})` : ''}`
    const named = []
    if ((diff.modified || []).length > 0) named.push(`modified: ${diff.modified.join(', ')}`)
    if ((diff.removed || []).length > 0) named.push(`removed: ${diff.removed.join(', ')}`)
    if (named.length > 0) return named.join('; ')
    return null
  }
  const openTreeWitness = () => {
    const opened = treeWitness(checkout)
    return {
      // Taken BEFORE any restore: this is the tree the gate command left behind.
      close: () => treeWitness(checkout),
      // RESTORE FIRST, THEN REFUSE — every caller adjudicates only after the
      // builder's work is back, because stranding it inside a stash entry is a
      // worse outcome than the defect this witness exists to name.
      adjudicate: (closed) => {
        const diff = compareFingerprints(opened, closed)
        const violation = witnessViolation(diff)
        if (diff.outcome !== FINGERPRINT_OUTCOMES.unchanged) {
          try {
            io.log(operationalRow({
              at: now(), event: 'tree-witness', checkout, outcome: diff.outcome,
              refused: violation !== null, modified: diff.modified, removed: diff.removed,
              added: diff.added, head_changed: diff.head_changed, cause: diff.cause, detail: diff.detail,
            }))
          } catch { /* the journal is diagnostics; the refusal below is the run */ }
        }
        if (violation === null) return
        const err = new Error(`runClean: ${TREE_WITNESS_REFUSAL} — the working tree at ${checkout} CHANGED while the gate command ran. The stashed work has been restored first; the working tree belongs to the driver for the duration of a runClean window, so this is a concurrent writer, detected and named rather than prevented. ${violation}. Also seen, never a refusal on its own: added: ${(diff.added || []).join(', ') || 'none'}`)
        err.reason = TREE_WITNESS_REFUSAL
        throw err
      },
    }
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
          const assignedAt = now()
          seatFor.set(result.returnPath, { role, id, brief: briefFile, at: assignedAt, returnPath: result.returnPath, transport: m.transport })
          refusalFloor.set(role, assignedAt)
          lastRefusal.delete(role)
          return result
        }
        seq += 1
        id = `d${seq}`
        const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
        // Anti-replay: seq restarts every process, so a crashed/escalated run
        // leaves files a re-run's wait() would instantly (and wrongly) accept.
        if (existsSync(returnPath)) unlinkSync(returnPath)
        const assignedAt = now()
        seatFor.set(returnPath, { role, surface_id: m.surface_id, id, brief: briefFile, at: assignedAt, returnPath, transport: m.transport })
        refusalFloor.set(role, assignedAt)
        lastRefusal.delete(role)
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
      let settled = null   // the envelope THIS wait produced, if any — the only positive completion evidence
      try {
        const env = transport
          ? transport.wait(returnPath, timeoutS)
          : waitForEnvelope({
            returnPath, timeoutS, role: info?.role || 'unknown',
            readEnvelope: () => readEnvelopeFile(returnPath, { existsSync, readFileSync, role: info?.role }),
            probeSeat: info ? () => info.surface_id ? paneProbe(info.surface_id, { tree, locate }) : { alive: null, substrate: 'ok' } : null,
            sampleSeat: info ? samplePane(info, returnPath) : null,
            sampleGrowth: info ? () => growthFor(info) : null,
            onGrowth: (record) => noteGrowth(info, returnPath, record),
            onSubstrate: (record) => noteSubstrate(info, returnPath, record),
            onAlive: (at) => {
              // An absent or refusing emitter is an ABSENCE, never a failed
              // write: the ledger is diagnostics, the wait is the run.
              try { io.emit?.({ kind: 'heartbeat', at, role: info?.role || null }) }
              catch { /* the ledger is never load-bearing for a wait */ }
            },
            classifyExpiry: info ? (at) => diagnoseExpiry(info, returnPath, at, timeoutS) : null,
            onExtend: (record) => noteWaitExtended(info, returnPath, record),
            now, sleep,
          })
        if (env == null) {
          const refusal = lastRefusal.get(info?.role)
          const spent = waitExtensions.get(returnPath) ?? null
          const verdict = diagnoseExpiry(info, returnPath, now(), timeoutS)
          const diagnosis = (verdict && spent !== null)
            ? { ...verdict, text: `${verdict.text}${waitExtendedClause(spent)}` }
            : verdict
          if (diagnosis) lastDiagnosis.set(returnPath, diagnosis)                    // verbatim: mutation A8
          noteCellFailure(info?.role, info?.id, 'timeout', {
            message: `no envelope at ${returnPath} within ${timeoutS}s${diagnosis ? `; ${diagnosis.text}` : ''}${refusal ? `; the provider says: ${refusal.message}` : ''}`,
            seatRefusal: refusal?.member,
          })
        }
        settled = env
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
            settled = recovery.envelope
            return recovery.envelope
          }
          failure = recovery.error || err
        }
        if (failure.stage === 'seat-died') io.log(recordRow({ at: now(), seat_died: info?.role || 'unknown', returnPath }))
        if (failure.stage === 'substrate-gone') io.log(recordRow({ at: now(), substrate_gone: info?.role || 'unknown', returnPath }))
        const refusal = lastRefusal.get(info?.role)
        if (refusal) failure.seatRefusal = refusal.member
        noteCellFailure(info?.role, info?.id, cellFailureKind(failure), failure)
        throw failure
      } finally {
        // The condition rows are scoped to THIS dispatch; the dispatch is over.
        try { settleSeatConditions(info, returnPath, now(), settled) } catch { /* never load-bearing */ }
        // A pane's hook side channel is the only usage source for this
        // transport. Measure in finally so a timeout or seat death still
        // records spend already written to the transcript.
        if (!transport && info?.role) emitPaneUsage(info)
        // Transcript refusal frames are durable evidence; no screen run is
        // closed here because liveness no longer reads pane pixels.
      }
    },
    // The state the wait EXPIRED in, for the escalation the operator reads.
    // Optional by design: a transport io that owns its own wait has nothing to
    // report, and drive.mjs calls it with `?.` (crew/io-contract.test.mjs:235
    // checks membership, never an exhaustive key set).
    waitDiagnosis(returnPath) { return lastDiagnosis.get(returnPath) ?? null },
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
      const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: checkout, encoding: 'utf8', timeout: 900_000, maxBuffer: RUN_MAX_BUFFER_BYTES, env: colorNeutralEnv(deps.env || process.env) })
      // A timeout kill or a spawn failure must be legible in the output a
      // bounce brief pastes verbatim — never an empty "Failures:" block.
      let output = `${res.stdout || ''}${res.stderr || ''}`
      if (res.error) output += `\n[spawn error: ${res.error.message}]`
      if (res.signal) output += `\n[killed by ${res.signal}${res.signal === 'SIGTERM' ? ' — likely the 900s run timeout' : ''}]`
      // An overflow is UNMEASURED, never red: the command may well have passed
      // and the bytes that would say so are the bytes that were dropped. The
      // marker is appended LAST so it is what a reader and a test see at the end.
      const overflowed = res.error?.code === 'ENOBUFS'
      if (overflowed) output += `\n[output exceeded ${RUN_MAX_BUFFER_BYTES} bytes — this run is UNMEASURED, not red]`
      const result = { ok: res.status === 0, output }
      if (overflowed) result.truncated = true
      return result
    },
    // Prove a command red on the PRE-BUILD tree while the stash stack is shared: set
    // the working changes aside, run, restore. The restore lives in a finally so
    // a throwing command can never leave the builder's work stashed, and a failed
    // round-trip throws loudly rather than silently reporting a result from the
    // wrong tree (runCmd turns the throw into an escalation envelope).
    runClean(cmd) {
      const dirty = execSync('git status --porcelain -uall', { cwd: checkout, encoding: 'utf8' }).trim()
      if (!dirty) {
        // A clean tree is exactly as writable by a live seat as a stashed one,
        // so the non-stashing arm carries the same witness around the same command.
        const quiet = openTreeWitness()
        const result = this.run(cmd) // nothing to set aside — the tree IS pristine
        quiet.adjudicate(quiet.close())
        return result
      }
      const tag = `crew:runClean:${typeof deps.uuid === 'function' ? deps.uuid() : randomUUID()}`
      const push = spawnSync('git', ['stash', 'push', '--include-untracked', '-m', tag], { cwd: checkout, encoding: 'utf8' })
      if (push.status !== 0) throw new Error(`runClean: git stash push failed, refusing to judge a gate against the wrong tree:\n${push.stderr || push.stdout || ''}`)
      // Bind the identity NOW, while our push is still the newest thing on the
      // stack: a sibling lane's push shifts every index but never this commit id.
      const sha = ownStashEntry(tag, null).sha
      const witness = openTreeWitness()
      try {
        return this.run(cmd)
      } finally {
        const closed = witness.close()
        const own = ownStashEntry(tag, sha)
        const apply = spawnSync('git', ['stash', 'apply', sha], { cwd: checkout, encoding: 'utf8' })
        if (apply.status !== 0) throw new Error(`runClean: git stash apply FAILED — the checkout is half-restored and the builder's work is in stash entry ${sha} (${tag}), never popped:\n${apply.stderr || apply.stdout || ''}`)
        const drop = spawnSync('git', ['stash', 'drop', `stash@{${own.index}}`], { cwd: checkout, encoding: 'utf8' })
        const dropped = /\(([0-9a-f]{7,40})\)/.exec(`${drop.stdout || ''}${drop.stderr || ''}`)?.[1] || ''
        if (drop.status !== 0 || !dropped || !(sha.startsWith(dropped) || dropped.startsWith(sha))) {
          throw new Error(`runClean: the tree is restored but the entry dropped was ${dropped || 'none'}, not ours (${sha}, ${tag}) — read git stash list before trusting the stack:\n${drop.stderr || drop.stdout || ''}`)
        }
        witness.adjudicate(closed)
      }
    },
    // A COLD verification run: the same command, in a checkout this lane has never
    // written into, cut at a NEUTRAL path (neutralColdPath above states why the
    // PATH, and not the warmth, is what discriminates). A worktree can only be cut
    // at a commit, so this is meaningful only AFTER the lane has committed.
    // Returns {ok, output, path, kept} for a suite that RAN: on green the checkout
    // is REMOVED, on red it is KEPT and named so an operator reproduces the failure
    // by cd-ing into it rather than by cutting a worktree by hand. Everything else
    // — an unresolvable repository name, no neutral path anywhere, a checkout that
    // could not be cut, a suite that could not be spawned, a green whose checkout
    // could not be removed — THROWS, because a cold verdict this method could not
    // actually take must never be reported as one, exactly as runClean refuses to
    // judge the wrong tree.
    runCold(cmd, names = []) {
      let commonDir = ''
      try {
        const out = execSync('git rev-parse --git-common-dir', { cwd: checkout, encoding: 'utf8' }).trim()
        commonDir = out.startsWith('/') ? out : join(checkout, out)
      } catch (err) {
        // FAIL CLOSED. In a linked dispatch worktree the checkout basename is the
        // LANE name, not the repository name, so losing the common dir silently
        // would drop exactly the repository-name half of the guard.
        throw new Error(`runCold: git rev-parse --git-common-dir failed in ${checkout}, refusing to cut a cold checkout without the repository-name guard: ${err.message}`)
      }
      const guard = [...(Array.isArray(names) ? names : []), ...coldGuardNames(checkout, commonDir)]
      const path = neutralColdPath(guard, deps.cold || {})
      const add = spawnSync('git', ['-C', checkout, 'worktree', 'add', '--detach', path, 'HEAD'], { encoding: 'utf8' })
      if (add.status !== 0) throw new Error(`runCold: git worktree add failed at ${path}, refusing to report a cold verdict from the checkout this lane built in:\n${add.stderr || add.stdout || ''}`)
      const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: path, encoding: 'utf8', timeout: 900_000, maxBuffer: RUN_MAX_BUFFER_BYTES, env: colorNeutralEnv(deps.env || process.env) })
      let output = `${res.stdout || ''}${res.stderr || ''}`
      if (res.signal) output += `\n[killed by ${res.signal}${res.signal === 'SIGTERM' ? ' — likely the 900s run timeout' : ''}]`
      if (res.error) throw new Error(`runCold: the cold suite could not be spawned in ${path} (kept for inspection): ${res.error.message}`)
      const ok = res.status === 0
      if (ok) {
        const removed = spawnSync('git', ['-C', checkout, 'worktree', 'remove', '--force', path], { encoding: 'utf8' })
        if (removed.status !== 0) throw new Error(`runCold: the cold suite was GREEN but its checkout could not be removed and is still registered at ${path}:\n${removed.stderr || removed.stdout || ''}`)
      }
      return { ok, output, path, kept: ok ? null : path }
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
        logLine(join(paths.dir, 'journal.jsonl'), operationalRow({
          at: new Date(now()).toISOString(), event: 'teardown-transports',
          declared, transports: swept, init_failed: initFailed, seats: rows.length,
        }))
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
        try { io.log(recordRow({ at: now(), reseat: record })) } catch { /* journal is diagnostics */ }
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
      return entryPaths(statusEntries(execSync('git status --porcelain -uall -z', { cwd: checkout, encoding: 'utf8' })))
    },
    commit(files, message) {
      // argv-form git (no shell string: planner-supplied paths are data, not
      // syntax), staging only what actually changed within scope — a planned-
      // but-never-created path must not crash the run after a green suite.
      // ONE status read: the scope membership and the staging decision are the
      // same view of the tree.
      const entries = statusEntries(execSync('git status --porcelain -uall -z', { cwd: checkout, encoding: 'utf8' }))
      const changed = entryPaths(entries)
      const present = files.filter((f) => changed.includes(f))
      if (present.length === 0) throw new Error('commit: nothing in scope actually changed — refusing an empty commit')
      // An already-staged deletion is a real change with nothing left to add:
      // it commits from the index and never reaches a pathspec that cannot
      // match it (#688).
      const toAdd = present.filter((f) => needsStaging(entries, f))
      if (toAdd.length > 0) execFileSync('git', ['add', '--', ...toAdd], { cwd: checkout })
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
        logLine(join(paths.dir, 'journal.jsonl'), operationalRow({ at: new Date(now()).toISOString(), event: 'doc-viewer', path, surface_id: crew.doc_viewer.surface_id }))
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

// One record per `git status --porcelain -uall -z` entry: x and y are the index
// and worktree columns, path is the entry's own path, and origin is the
// ORIGINAL path of a rename/copy — the following NUL record. Declared below
// seatIo (hoisted) so the anchor-pinned lines above it never shift.
function statusEntries(porcelain) {
  const parts = porcelain.split('\0')
  const entries = []
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (!entry) continue
    const record = { x: entry[0], y: entry[1], path: entry.slice(3), origin: null }
    if (record.x === 'R' || record.x === 'C') { i += 1; if (parts[i]) record.origin = parts[i] }
    entries.push(record)
  }
  return entries
}

// Both sides of a rename are real changes the scope gate must see.
function entryPaths(entries) {
  const files = []
  for (const record of entries) { files.push(record.path); if (record.origin) files.push(record.origin) }
  return files
}

// A path needs `git add` only when its WORKTREE column is non-blank: a blank y
// means the index already matches the worktree, so there is nothing left to
// stage. This is not an optimisation. An ALREADY-STAGED deletion ('D ', what
// `git rm` leaves) is in neither the worktree nor the index, so
// `git add -- <path>` matches no pathspec and git exits fatal — crashing a lane
// whose deletion was already staged correctly (#688). A rename's ORIGINAL path
// has no entry of its own and is likewise already gone, so it is never staged.
function needsStaging(entries, path) {
  return entries.some((record) => record.path === path && record.y !== ' ')
}

export const SEAT_REFUSAL_STAGE = 'seat-refused'
const PI_REFUSAL_STOPS = new Set(['error', 'length'])

export function piSessionDir(checkout, deps = {}) {
  return join(deps.home ?? homedir(), '.pi', 'agent', 'sessions', `-${String(checkout).replaceAll('/', '-')}--`)
}

function refusalSince(since) {
  if (Number.isFinite(since)) return Number(since)
  const parsed = Date.parse(String(since ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function refusalAt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function zeroPiUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every((key) => usage[key] === 0)
}

function piRefusalRow(row) {
  const message = row?.message
  const stop = message?.stopReason
  if (!PI_REFUSAL_STOPS.has(stop)) return null
  const at = refusalAt(row?.timestamp)
  if (at === null) return null
  if (stop === 'length') {
    return { at, member: 'overflowed', message: message.errorMessage || 'stopReason: length', source: 'pi' }
  }
  const content = message?.content
  if (!Array.isArray(content)) return null
  if (!zeroPiUsage(message?.usage)) return null
  if (typeof message.errorMessage !== 'string' || !message.errorMessage) return null
  const refusal = recogniseSeatRefusal(message.errorMessage)
  return { at, member: refusal, message: message.errorMessage, source: 'pi' }
}

export function piRefusalFrames({ checkout, since = 0, deps = {} } = {}) {
  const exists = deps.existsSync ?? fsExistsSync
  const read = deps.readFileSync ?? fsReadFileSync
  const readdir = deps.readdirSync ?? fsReaddirSync
  let dir
  try { dir = piSessionDir(checkout, deps) } catch { return [] }
  try {
    if (!exists(dir)) return []
    const names = readdir(dir)
    if (!Array.isArray(names)) return []
    const floor = refusalSince(since)
    const frames = []
    for (const name of names) {
      const path = join(dir, String(name))
      let raw
      try { raw = String(read(path, 'utf8')) } catch { continue }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        let frame
        try { frame = piRefusalRow(row) } catch { frame = null }
        if (!frame || frame.at <= floor) continue
        frames.push(frame)
      }
    }
    frames.sort((a, b) => a.at - b.at)
    return frames
  } catch { return [] }
}

function claudeRefusalRow(row) {
  if (row?.isApiErrorMessage !== true) return null
  const at = refusalAt(row?.timestamp)
  if (at === null) return null
  const content = row?.message?.content
  if (!Array.isArray(content)) return null
  const texts = content.map((part) => part?.text).filter((text) => typeof text === 'string')
  const message = texts.join('')
  if (!message) return null
  return { at, member: recogniseSeatRefusal(message), message, source: 'claude' }
}

export function claudeRefusalFrames({ taskDir, role, since = 0, adapter = null, deps = {} } = {}) {
  const readRecords = adapter?.paneUsageRecords ?? SHIPPED_PANE_USAGE.claude
  if (typeof readRecords !== 'function') return []
  let records
  try { records = readRecords({ taskDir, role, deps }) } catch { return [] }
  if (!Array.isArray(records)) return []
  const floor = refusalSince(since)
  const frames = []
  for (const record of records) {
    if (!record || typeof record.session_id !== 'string' || !record.session_id
      || typeof record.transcript_path !== 'string' || !record.transcript_path) continue
    let raw
    try { raw = String((deps.readFileSync ?? fsReadFileSync)(record.transcript_path, 'utf8')) } catch { continue }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      let frame
      try { frame = claudeRefusalRow(row) } catch { frame = null }
      if (!frame || frame.at <= floor) continue
      frames.push(frame)
    }
  }
  frames.sort((a, b) => a.at - b.at)
  return frames
}

export function claudeTranscriptPaths({ taskDir, role, adapter = null, deps = {} } = {}) {
  const readRecords = adapter?.paneUsageRecords ?? SHIPPED_PANE_USAGE.claude
  if (typeof readRecords !== 'function') return []
  let records
  try { records = readRecords({ taskDir, role, deps }) } catch { return [] }
  if (!Array.isArray(records)) return []
  return records.map((record) => record?.transcript_path).filter((path) => typeof path === 'string' && path)   // verbatim: mutation A13
}

export function piTranscriptPaths({ checkout, deps = {} } = {}) {
  const exists = deps.existsSync ?? fsExistsSync
  const readdir = deps.readdirSync ?? fsReaddirSync
  let dir
  try { dir = piSessionDir(checkout, deps) } catch { return [] }
  try {
    if (!exists(dir)) return []
    const names = readdir(dir)
    return Array.isArray(names) ? names.filter((name) => String(name).endsWith('.jsonl')).map((name) => join(dir, String(name))) : []   // verbatim: mutation A14
  } catch { return [] }
}

const SHIPPED_TRANSCRIPT_READERS = Object.freeze({ claude: claudeTranscriptPaths, pi: piTranscriptPaths })

const SHIPPED_REFUSAL_READERS = Object.freeze({ claude: claudeRefusalFrames, pi: piRefusalFrames })
