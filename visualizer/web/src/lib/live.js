function createPulse() {
  const listeners = new Set()
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    pulse() { for (const listener of [...listeners]) listener() },
    get size() { return listeners.size },
  }
}

// One clock for the whole page: App's completion-based refresh loop publishes here.
// A second poll loop over the same server is a defect, not a feature (#630).
export const journalPulse = createPulse()

// Wait AFTER a read finishes. An interval can keep a slow feed continuously busy.
export function createRefreshLoop(read, options = {}) {
  const delay = options.delay ?? 30000
  const schedule = options.setTimeout ?? setTimeout
  const cancel = options.clearTimeout ?? clearTimeout
  const visible = options.visible ?? (() => true)
  let enabled = options.enabled ?? true
  let timer = null
  let pending = null
  let stopped = false
  function clear() { if (timer !== null) cancel(timer); timer = null }
  function arm() {
    clear()
    if (stopped || !enabled || pending) return
    timer = schedule(() => {
      timer = null
      if (visible()) void refresh().catch(() => {})
      else arm()
    }, delay)
  }
  function refresh() {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    clear()
    pending = Promise.resolve().then(read).finally(() => { pending = null; arm() })
    return pending
  }
  return {
    refresh,
    setEnabled(value) { enabled = value === true; arm() },
    stop() { stopped = true; clear() },
  }
}
