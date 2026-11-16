import { spawn } from 'node:child_process'

const monotonicNow = () => Number(process.hrtime.bigint()) / 1e6
const SAMPLE_MS = 25
// Heuristic: an event-loop stall over 5s is indistinguishable from host suspension.
const SUSPEND_GAP_MS = 5_000

export function holdIdleSleep(pid, { platform = process.platform, spawn: launch } = {}) {
  if (platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 1) return
  // Test workers must inject a spawn to avoid holding real host sleep assertions.
  if (launch === undefined && process.env.NODE_TEST_CONTEXT !== undefined) return
  if (launch === undefined) launch = spawn
  try {
    const child = launch('caffeinate', ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch { /* no assertion is not a launch failure */ }
}

// Absent means measured zero for older producers; explicit null poisons the total.
export function addSleepCredit(total, part) {
  if (part?.sleep_credited_s === null) {
    total.sleep_credited_s = null
    total.sleep_credit_reason = 'clock-unavailable'
  } else if (total.sleep_credited_s !== null && part?.sleep_credited_s > 0) {
    total.sleep_credited_s = (total.sleep_credited_s ?? 0) + part.sleep_credited_s
  }
  return total
}

export function sampledBudget(ms, { now = monotonicNow, sampleNow = now, setTimeout: schedule = setTimeout, clearTimeout: clear = clearTimeout } = {}) {
  const start = now()
  let last, credited = 0, interval = SAMPLE_MS, available = typeof sampleNow === 'function', timer, stopped = false, finalRemaining
  const read = () => {
    try {
      const value = sampleNow()
      if (!Number.isFinite(value)) throw new Error('clock unavailable')
      return value
    } catch { available = false; return undefined }
  }
  if (available) last = read()
  const remaining = () => {
    if (stopped) return finalRemaining
    if (available) {
      const current = read()
      if (available) {
        const gap = current - last
        if (gap > SUSPEND_GAP_MS) credited += gap - interval
        if (gap < 0) available = false
        last = current
      }
    }
    return Math.max(0, ms - (now() - start) + credited)
  }
  const next = () => (interval = Math.min(SAMPLE_MS, remaining()))
  const cancel = () => { clear(timer); timer = undefined }
  const stop = () => {
    if (stopped) return
    finalRemaining = remaining()
    stopped = true
    cancel()
  }
  return {
    remaining, next, stop,
    fields() {
      remaining()
      return !available ? { sleep_credited_s: null, sleep_credit_reason: 'clock-unavailable' } : credited > 0 ? { sleep_credited_s: credited / 1000 } : {}
    },
    watch(expire) {
      const tick = () => {
        if (stopped) return
        const delay = next()
        if (delay <= 0) expire()
        else timer = schedule(tick, delay)
      }
      tick()
      return cancel
    },
  }
}
