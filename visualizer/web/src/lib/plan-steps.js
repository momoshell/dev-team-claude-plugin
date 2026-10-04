export const PLAN_STEP_STATUSES = Object.freeze(['not-started', 'started', 'done', 'red', 'bounced'])
export const PLAN_STEP_REASONS = Object.freeze(['no-step-events', 'degraded-to-whole-build', 'journal-unavailable'])
export const PLAN_ABSENCE_REASONS = Object.freeze(['plan-not-accepted', 'plan-unreadable', 'plan-has-no-chunks'])

const STATUS_BY_EVENT = Object.freeze({
  'step:start': 'started',
  'step:done': 'done',
  'step:red': 'red',
  'step:bounce': 'bounced',
  'step:accepted-by-gate': 'done',
  'step:reverified': 'done',
  'step:reverify-red': 'red',
})
const COMPLETION_EVENTS = new Set(['step:done', 'step:accepted-by-gate', 'step:reverified'])
const STEP_EVENTS = new Set([...Object.keys(STATUS_BY_EVENT), 'step:degrade'])

export function planSteps(payload = {}) {
  const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const plan = safePayload.plan
  const chunks = plan?.chunks
  const absent = plan == null ? 'plan-not-accepted' : plan.absent ?? (!Array.isArray(chunks) || chunks.length === 0 ? 'plan-has-no-chunks' : null)
  if (absent) return { steps: [], absent, unplanned: [] }
  const validChunks = chunks.filter((chunk) => chunk && typeof chunk === 'object' && !Array.isArray(chunk) && typeof chunk.id === 'string' && chunk.id.trim())
  const planned = new Set(validChunks.map(({ id }) => id))
  const events = new Map()
  const unplanned = new Set()
  let recognized = false
  let eventIndex = 0
  for (const row of Array.isArray(safePayload.rows) ? safePayload.rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || (row.channel != null && row.channel !== 'record')) continue
    if (!STEP_EVENTS.has(row.event)) continue
    recognized = true
    const ids = []
    if (row.event === 'step:degrade') {
      if (Array.isArray(row.remaining)) ids.push(...row.remaining)
    } else if (typeof row.step === 'string') ids.push(row.step)
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) continue
      if (!planned.has(id)) unplanned.add(id)
      const state = events.get(id) ?? { statusEvent: null, rounds: null, degradedAt: null, completedAfterDegrade: false }
      if (row.event === 'step:degrade') {
        state.degradedAt = eventIndex
        state.completedAfterDegrade = false
      } else {
        if (row.event === 'step:start' && Number.isInteger(row.round) && row.round > 0) state.rounds = Math.max(state.rounds ?? 0, row.round)
        if (state.degradedAt !== null && COMPLETION_EVENTS.has(row.event)) state.completedAfterDegrade = true
        if (STATUS_BY_EVENT[row.event]) state.statusEvent = row.event
      }
      events.set(id, state)
    }
    eventIndex += 1
  }
  const steps = validChunks.map((chunk) => {
    const metadata = Object.fromEntries(['id', 'checks_owned', 'files_in_scope', 'depends_on'].filter((key) => key in chunk).map((key) => [key, Array.isArray(chunk[key]) ? [...chunk[key]] : chunk[key]]))
    const state = events.get(chunk.id)
    let status = null
    let via = null
    let reason = null
    let rounds = state?.rounds ?? null
    if (safePayload.error || safePayload.degraded) { reason = 'journal-unavailable'; rounds = null }
    else if (!recognized) { reason = 'no-step-events'; rounds = null }
    else if (state?.degradedAt !== null && state?.degradedAt !== undefined && !state.completedAfterDegrade) { reason = 'degraded-to-whole-build'; rounds = null }
    else if (!state) { status = 'not-started' }
    else if (state.statusEvent) { via = state.statusEvent; status = STATUS_BY_EVENT[via] }
    return { ...metadata, status, via, reason, rounds }
  })
  return { steps, absent: null, unplanned: [...unplanned] }
}
