export const PAGE_LIMIT = 200

// Fetch rowid-cursor pages until the server returns a short page. A stalled
// cursor or runaway page count is reported as truncated rather than hidden.
export async function drainEvents(fetchPage, { after = 0, limit = PAGE_LIMIT, maxPages = 500 } = {}) {
  const events = []
  let cursor = after
  let truncated = false
  if (maxPages <= 0) return { events, cursor, truncated: true }
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(cursor, limit)
    const rows = Array.isArray(page?.events) ? page.events : []
    events.push(...rows)
    if (rows.length === 0) break
    const next = page?.cursor
    if (!Number.isFinite(next) || next <= cursor) {
      truncated = true
      break
    }
    cursor = next
    if (rows.length < limit) break
    if (pageNumber === maxPages - 1) truncated = true
  }
  return { events, cursor, truncated }
}

// Coalesce a final drain behind an in-flight periodic drain. The caller's
// task remains framework-free, making the finish race directly testable.
export function createDrainQueue(task) {
  let inFlight = null
  let queuedFinal = false
  async function drain({ final = false } = {}) {
    if (inFlight) {
      if (final) queuedFinal = true
      return inFlight
    }
    inFlight = Promise.resolve().then(task)
    try {
      return await inFlight
    } finally {
      inFlight = null
      if (queuedFinal) {
        queuedFinal = false
        void drain().catch(() => {})
      }
    }
  }
  return { drain }
}
