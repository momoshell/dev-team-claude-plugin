// crew/host-load.mjs — opt-in host load policy and boot refusal.

import { loadavg as osLoadavg, cpus as osCpus } from 'node:os'

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

