// crew/host-load.mjs — opt-in host load policy and boot refusal.

import { loadavg as osLoadavg, cpus as osCpus } from 'node:os'
import { slotCapacity, slotStore } from './reclaim.mjs'

export const LOAD_ENV = Object.freeze({ threshold: 'CREW_LOAD_THRESHOLD' })

// Opt-in, exactly like the cell breaker: an absent/empty threshold means no
// policy and nothing is measured; every other malformed value is a boot-time
// configuration error. There is deliberately NO default threshold — a guessed
// number is a number nobody measured.
export function loadPolicy(env = process.env) {
  const raw = env?.[LOAD_ENV.threshold]
  if (raw === undefined || raw === '') return null
  const threshold = Number(raw)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`${LOAD_ENV.threshold} must be a finite number > 0 (got ${JSON.stringify(raw)})`)
  }
  return { threshold }
}

const LOAD_BASIS = 'os.loadavg()[0] / os.cpus().length'

function loadRecord(policy, verdict, why, load_1m = null, cores = null, per_core = null) {
  return {
    configured: true, threshold: policy.threshold, basis: LOAD_BASIS,
    load_1m, cores, per_core, verdict, why,
  }
}

export function hostLoad({ policy, loadavg = osLoadavg, cpus = osCpus, platform = process.platform } = {}) {
  if (policy == null) return null
  if (platform === 'win32') {
    return loadRecord(policy, 'unmeasurable', 'Node documents win32 os.loadavg() as a constant, not a measured host load')
  }

  let load_1m
  try {
    load_1m = loadavg()?.[0]
  } catch (err) {
    return loadRecord(policy, 'unmeasurable', `os.loadavg() failed: ${err?.message || String(err)}`)
  }
  if (typeof load_1m !== 'number' || !Number.isFinite(load_1m) || load_1m < 0) {
    return loadRecord(policy, 'unmeasurable', 'os.loadavg()[0] was not a finite non-negative number')
  }

  let coreList
  try {
    coreList = cpus()
  } catch (err) {
    return loadRecord(policy, 'unmeasurable', `os.cpus() failed: ${err?.message || String(err)}`)
  }
  if (!Array.isArray(coreList) || coreList.length === 0) {
    return loadRecord(policy, 'unmeasurable', 'os.cpus() did not return a non-empty array')
  }

  const cores = coreList.length
  const per_core = load_1m / cores
  const verdict = per_core > policy.threshold ? 'saturated' : 'quiet'
  return loadRecord(policy, verdict, null, load_1m, cores, per_core)
}

function loadError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function assertHostQuiet(record) {
  if (!record || record.verdict === 'quiet') return
  if (record.verdict === 'unmeasurable') {
    throw loadError(
      'host-load-unmeasurable',
      `host load: CREW_LOAD_THRESHOLD=${record.threshold} is configured but host load is unmeasurable (${record.why || 'unknown reason'}) — refusing to boot without a measured host load; repair the host load probe or unset CREW_LOAD_THRESHOLD.`,
    )
  }
  if (record.verdict !== 'saturated') return
  throw loadError(
    'host-load-open',
    `host load: 1-minute load average ${record.load_1m} over ${record.cores} cores = ${record.per_core.toFixed(2)} per core exceeds CREW_LOAD_THRESHOLD=${record.threshold} (basis: ${record.basis}, measured at boot) — refusing to boot a crew onto a saturated host; wait for the host to quiet down, seat fewer roles (--roles/--tier), or unset CREW_LOAD_THRESHOLD.`,
  )
}

// --- suite slots (#825, parent #822) -----------------------------------------
// K sits beside the load threshold because both answer one question — may this
// host take another suite right now — and differ only in the answer: the
// threshold REFUSES a boot, this QUEUES a suite. The number itself stays #823's
// (slotCapacity, crew/reclaim.mjs): one resolver, one throw rule, no second copy
// to diverge from it.
export const SUITE_SLOT_KIND = 'suite'
export const SLOT_WAIT_INTERVAL_MS = 2000
export const SLOT_WAIT_CEILING_MS = 30 * 60 * 1000

// crew/reclaim.mjs's idiom, not a new one: a synchronous sleep with no busy
// wait. It is duplicated rather than imported because reclaim does not export it.
const defaultSleep = (ms) => {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

export function slotPolicy({ env = process.env, cpus = osCpus } = {}) {
  const capacity = slotCapacity({ env, cpus })
  if (capacity === 0) return null
  return { capacity }
}

// #823's acquire is non-blocking by design (crew/reclaim.mjs:1275) — it reports
// `{ waiting: true, depth }` and returns. The loop is the caller's, and this is
// the one copy of it. `depth` is the pool occupancy of the LAST completed scan;
// a lost fence reports null, and null is carried through as unknown rather than
// flattened to 0.
function acquireSlot({ pool, owner, now, sleep, ceiling }) {
  const started = now()
  let depth = null
  let waits = 0
  for (;;) {
    const attempt = pool.acquire({ owner })
    if (attempt?.handle) return { handle: attempt.handle, slot: attempt.slot ?? null, waits, depth, waitedMs: now() - started }
    depth = Number.isSafeInteger(attempt?.depth) ? attempt.depth : null
    waits += 1
    if (now() - started >= ceiling) return { handle: null, slot: null, waits, depth, waitedMs: now() - started }
    sleep(SLOT_WAIT_INTERVAL_MS)
  }
}

// A queue is not a refusal: the failure mode of a wrong K is WAITING, never lost
// work (crew/reclaim.mjs:1136). So the ceiling hands the caller its suite back
// UNSLOTTED and says so, rather than failing a dispatch that would have run.
export function withSuiteSlot({ owner, root, env = process.env, log = () => {}, now = Date.now, sleep = defaultSleep, slots = slotStore, ceiling = SLOT_WAIT_CEILING_MS } = {}, run) {
  const policy = slotPolicy({ env })
  if (!policy) return run()
  const pool = slots({ dir: root, kind: SUITE_SLOT_KIND, capacity: policy.capacity })
  const acquired = acquireSlot({ pool, owner, now, sleep, ceiling })
  const seconds = Math.round(acquired.waitedMs / 1000)
  const behind = acquired.depth === null ? 'unknown' : acquired.depth
  if (!acquired.handle) {
    log(`suite slots: K=${policy.capacity}, waited ${seconds}s behind ${behind} and gave up; running unslotted`)
    return run()
  }
  if (acquired.waits > 0) log(`suite slots: K=${policy.capacity}, waited ${seconds}s behind ${behind}`)
  else log(`suite slots: K=${policy.capacity}, acquired ${acquired.slot ?? 'a slot'} with no wait`)
  try { return run() } finally { pool.release(acquired.handle) }
}

