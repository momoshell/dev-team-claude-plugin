import { assuranceMeta } from './workflow-semantics.js'

export const SILENT_AFTER_MS = 30_000
const TOKEN_FIELDS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
export const DEFAULT_FILTERS = Object.freeze({ hide_slugless: true, hide_archived: true })

export function createSemaphore(limit = 1) {
  const maximum = Number.isInteger(limit) && limit > 0 ? limit : 1
  let active = 0
  const waiters = []
  function acquire() {
    if (active < maximum) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  function release() {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }
  return {
    async run(task) {
      await acquire()
      try { return await task() } finally { release() }
    },
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textNumber(value) {
  return value.toLocaleString('en-US')
}

function measuredCell(value, text = String(value)) {
  return { value, text, dashed: false, title: null }
}

function envelopeFor(envelopes, adwId) {
  if (envelopes instanceof Map) return envelopes.get(adwId) || null
  if (envelopes && typeof envelopes === 'object') return envelopes[adwId] || null
  return null
}

export function absenceMark(reason) {
  return { value: null, text: reason || 'not measured', dashed: true, title: reason || null }
}

export function deriveStatus(run = {}, taskEnvelope = null) {
  const escalation = taskEnvelope?.details?.escalation
  if (taskEnvelope?.status === 'escalation') {
    return { key: 'escalated', word: 'escalated', tone: 'serious', where: escalation?.where, why: escalation?.why }
  }
  if (run?.status === 'ok') return { key: 'success', word: 'success', tone: 'ok', where: null, why: null }
  if (run?.status === 'fail') return { key: 'fail', word: 'failed', tone: 'fail', where: null, why: null }
  if (run?.status === 'aborted') return { key: 'aborted', word: 'aborted', tone: 'aborted', where: null, why: null }
  if (run?.running && !run?.phases?.length) return { key: 'queued', word: 'queued', tone: 'quiet', where: null, why: null }
  if (run?.running) return { key: 'running', word: 'running', tone: 'busy', where: null, why: null }
  return { key: 'unknown', word: 'status not recorded', tone: 'quiet', where: null, why: null }
}

function conciseAge(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

// #953 — whether this run's crew state directory is archived is MEASURED BY THE SERVER and
// only REPORTED here. Three values and never two: true, false, or null with a stated reason.
// An unmeasured crew state is never read as "not archived".
export function crewArchive(run = {}) {
  const state = run?.crew_state && typeof run.crew_state === 'object' ? run.crew_state : null
  const archived = state && typeof state.archived === 'boolean' ? state.archived : null
  return {
    archived,
    archived_at: state?.archived_at ?? null,
    // TL8 — when the archive is measured but its instant is not, the reason travels with it.
    archived_at_absent: state?.archived_at_absent ?? null,
    absent: archived === null ? absenceMark(run?.pending?.crew_state) : null,
  }
}

export function runActivity(run = {}, now = Date.now()) {
  if (!run?.running) return { key: 'settled', live: false, attention: false, heartbeat: heartbeatCell(run, now) }
  const heartbeat = heartbeatCell(run, now)
  // #953 — the ledger and the crew state dir disagree. Report the disagreement; do not pick
  // a side. This sits AFTER the settled return, so settlement is read from the ledger and
  // never from the crew dir, and it answers only on a MEASURED archived === true.
  //
  // TL7 — the key is its OWN token and never 'silent'. Every consumer translates 'silent'
  // into "stale heartbeat", and this lane's heartbeat can be seconds old; that translation
  // would be a measurement nobody made. execution-steps.js is taught the key in §3.7, so
  // PhaseGantt keeps rendering "No return recorded" instead of falling through to
  // "In progress".
  const archive = crewArchive(run)
  if (archive.archived === true) {
    const ledgerSide = run?.started_at ? `started ${run.started_at}` : 'started at a time the ledger did not record'
    const archiveSide = archive.archived_at ? `archived ${archive.archived_at}` : `archived at a time this feed could not measure (${archive.archived_at_absent || 'no reason was recorded for the absence'})`
    return {
      key: 'contradicted', live: false, attention: true, heartbeat,
      word: 'contradicted · ledger running, crew state archived', tone: 'serious',
      why: `The ledger row still says running (${ledgerSide}), but this lane's crew state directory is archived (${archiveSide}). The two sides disagree; neither is guessed away. This run is not live, not merely stale, and not settled.`,
    }
  }
  if (heartbeat.dashed) {
    return {
      key: 'unverified', live: false, attention: true, heartbeat,
      word: 'running · heartbeat unavailable', tone: 'serious',
      why: 'The ledger says this session is running, but this feed does not provide a heartbeat, so live activity cannot be verified.',
    }
  }
  if (heartbeat.stale) {
    const quietFor = conciseAge(heartbeat.age_ms)
    return {
      key: 'silent', live: false, attention: true, heartbeat,
      word: `stale · heartbeat ${quietFor} ago`, tone: 'serious',
      why: `The session still says running, but its last heartbeat was ${quietFor} ago.`,
    }
  }
  return { key: 'live', live: true, attention: false, heartbeat, word: 'live', tone: 'busy', why: null }
}

// #953 · TL7 — ONE list of the status keys that mean an operator must look at this run. It
// was hard-coded in App.svelte:52 and TaskList.svelte:25,:57, which is exactly how a key
// minted in this module reaches neither. Those two consumers ask this predicate; the
// fleetView rail selects the key directly and is not a caller.
export const ATTENTION_KEYS = Object.freeze(['escalated', 'fail', 'aborted', 'silent', 'unverified', 'contradicted'])
export function needsAttention(statusKey) { return ATTENTION_KEYS.includes(statusKey) }

// #953 · TL7 — the heading an operator reads for an open record that is not live, keyed by
// the SAME status key. A contradicted lane is NOT stale: its evidence is the crew state
// directory and its heartbeat may be four seconds old, so calling it stale states a
// measurement nobody made.
const OPEN_RECORD_NOTES = Object.freeze({
  silent: 'Stale open record',
  unverified: 'Open record not verified',
  contradicted: 'Ledger running · crew state archived',
})
export function openRecordNote(statusKey) { return OPEN_RECORD_NOTES[statusKey] ?? null }

export function fleetActivity(runs = [], now = Date.now()) {
  const summary = { live: 0, silent: 0, contradicted: 0, unverified: 0, open: 0 }
  for (const run of Array.isArray(runs) ? runs : []) {
    const activity = runActivity(run, now)
    if (activity.key === 'live') summary.live += 1
    if (activity.key === 'silent') summary.silent += 1
    // #953 · TL7 — counted ONCE, in its own bucket. Round 7 incremented `silent` too, and
    // every consumer that counts `silent` calls the row a stale heartbeat.
    if (activity.key === 'contradicted') summary.contradicted += 1
    if (activity.key === 'unverified') summary.unverified += 1
    if (run?.running) summary.open += 1
  }
  return summary
}

export function deriveDisplayStatus(run = {}, taskEnvelope = null, now = Date.now()) {
  const recorded = deriveStatus(run, taskEnvelope)
  if (!['running', 'queued'].includes(recorded.key)) return recorded
  const activity = runActivity(run, now)
  if (activity.key === 'silent' || activity.key === 'unverified' || activity.key === 'contradicted') {
    // #953 — a contradicted row's evidence is the crew state directory, not the heartbeat;
    // `where` was hard-coded to 'heartbeat' and that would now be a false attribution.
    return { key: activity.key, word: activity.word, tone: activity.tone, where: activity.key === 'contradicted' ? 'crew state' : 'heartbeat', why: activity.why }
  }
  return recorded
}

export function heartbeatCell(run = {}, now = Date.now()) {
  let age = finiteNumber(run?.heartbeat_age_ms)
  if (age == null && run?.last_heartbeat_at != null) {
    const timestamp = Date.parse(String(run.last_heartbeat_at))
    if (Number.isFinite(timestamp) && Number.isFinite(now)) age = now - timestamp
  }
  if (age == null) return absenceMark(run?.pending?.last_heartbeat_at)
  const seconds = Math.round(age / 1000)
  if (age <= SILENT_AFTER_MS) return { text: `${seconds}s ago`, stale: false, dashed: false, age_ms: age }
  return { text: `silent ${seconds}s`, stale: true, dashed: false, age_ms: age }
}

// #826 (parent epic #822) — the suite-slot wait a pool would otherwise convert into a
// silent gap. Three absences and never one zero: an unmeasured window carries the ledger's
// own reason, a run that never waited carries no chip at all, and a wait whose admission
// scan never reported a queue depth says unknown.
export function slotWaitCell(run = {}) {
  const rows = Array.isArray(run?.slot_waits) ? run.slot_waits : null
  // MUTATION D1: hand an unmeasured window a measured zero and the row claims no lane
  // waited, on evidence nobody collected.
  if (rows === null) return absenceMark(run?.slot_waits_absent)
  // MUTATION B1: render this case anyway and every row carries a chip — the same blindness
  // as no chip at all.
  if (!rows.length) return null
  const waited = rows.map((row) => row.waited_ms).filter((value) => finiteNumber(value) != null)
  if (!waited.length) return absenceMark(null)
  const total = waited.reduce((sum, value) => sum + value, 0)
  const seconds = Math.max(0, Math.round(total / 1000))
  // MUTATION C2: read anything but the depth column and a MEASURED queue depth disappears
  // behind "unknown".
  const depths = rows.map((row) => row.queue_depth).filter((value) => finiteNumber(value) != null)
  // MUTATION C1: coalesce an unmeasured depth to 0 and a queue nobody scanned reads as a
  // measured queue of length zero.
  const depth = depths.length ? Math.max(...depths) : null
  return {
    // MUTATION A1 (from the signature line) / MUTATION E1 (this sentence): drop the chip, or
    // rename what it says, and the run row stops telling the operator it was queued.
    ...measuredCell(total, `waiting for a suite slot · ${seconds}s`),
    waits: rows.length,
    depth,
    depth_text: depth === null ? 'queue depth unknown' : `queue depth ${depth}`,
    depth_title: depth === null ? (rows.find((row) => row.queue_depth_absent)?.queue_depth_absent ?? null) : null,
  }
}

export function tokenCell(run = {}) {
  const metrics = run?.metrics ?? run ?? {}
  let total = null
  for (const field of TOKEN_FIELDS) {
    const value = metrics?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) total = (total ?? 0) + value
  }
  if (total == null) return absenceMark(run?.pending?.billed_input_tokens)
  const input = finiteNumber(metrics?.billed_input_tokens)
  const output = finiteNumber(metrics?.billed_output_tokens)
  const cacheWrite = finiteNumber(metrics?.billed_cache_write_tokens)
  const cacheRead = finiteNumber(metrics?.billed_cache_read_tokens)
  const promptMeasured = [input, cacheWrite, cacheRead].every((value) => value != null)
  const promptTotal = promptMeasured ? input + cacheWrite + cacheRead : null
  const cacheRate = promptTotal > 0 ? cacheRead / promptTotal * 100 : null
  return {
    ...measuredCell(total, textNumber(total)),
    input,
    output,
    cacheWrite,
    cacheRead,
    promptTotal,
    cacheRate,
    cachePending: cacheRate == null ? (run?.pending?.billed_cache_read_tokens || 'prompt cache usage was not measured') : null,
  }
}

export function costCell(run = {}) {
  const reason = run?.pending?.billed_cost_usd
  if (run?.transport === 'pane' || (typeof reason === 'string' && /subscription seat/i.test(reason))) {
    return absenceMark('not measured · pane')
  }
  return absenceMark(reason)
}

export function gateCell(run = {}) {
  const generations = Array.isArray(run?.gate_generations) ? run.gate_generations : []
  if (!generations.length) return absenceMark(run?.pending?.gate_discrimination)
  const newest = [...generations].sort((a, b) => (a?.gate_generation ?? 0) - (b?.gate_generation ?? 0)).at(-1)
  const verdict = ['proven', 'failed', 'unproven'].includes(newest?.verdict) ? newest.verdict : 'unproven'
  return { ...measuredCell(verdict, verdict), verdict, generation: newest?.gate_generation ?? null }
}

export function reviewCell(run = {}) {
  const reviews = Array.isArray(run?.reviews) ? run.reviews : []
  if (!reviews.length) return absenceMark(run?.pending?.reviews)
  const last = reviews.at(-1)
  const round = reviews.length
  const bounces = reviews.filter((review) => review?.verdict === 'changes-needed').length
  const verdict = last?.verdict ?? null
  const text = `${verdict ?? 'status not recorded'} · round ${round} · ${bounces} bounce${bounces === 1 ? '' : 's'}`
  return { ...measuredCell(verdict, text), verdict, round, bounces }
}

export function tierCell(run = {}) {
  if (run?.tier == null) return absenceMark(run?.pending?.tier)
  const assurance = assuranceMeta(run.tier)
  return { ...measuredCell(run.tier, assurance.label), key: assurance.key, summary: assurance.summary }
}

export function durationCell(run = {}) {
  const duration = finiteNumber(run?.duration_ms)
  if (duration == null) return absenceMark(run?.pending?.duration_ms)
  const seconds = Math.max(0, Math.round(duration / 1000))
  if (seconds < 60) return measuredCell(duration, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return measuredCell(duration, `${minutes}m ${seconds % 60}s`)
  return measuredCell(duration, `${Math.floor(minutes / 60)}h ${minutes % 60}m`)
}

function visibleRows(runs, envelopes, now, filters) {
  return (Array.isArray(runs) ? runs : []).filter((run) => {
    if (filters.hide_slugless && !run?.goal) return false
    if (filters.hide_archived && run?.triage?.reviewed_at) return false
    return true
  }).map((run) => {
    const status = deriveStatus(run, envelopeFor(envelopes, run.adw_id))
    return {
      adw_id: run.adw_id,
      run_label: run.goal || run.adw_id || 'Untitled run',
      status,
      tier: tierCell(run),
      gate: gateCell(run),
      review: reviewCell(run),
      duration: durationCell(run),
      tokens: tokenCell(run),
      cost: costCell(run),
      heartbeat: heartbeatCell(run, now),
      slot_wait: slotWaitCell(run),
      activity: runActivity(run, now),
    }
  })
}

export function fleetView(runs, { envelopes = new Map(), now = Date.now(), filters } = {}) {
  const selected = { ...DEFAULT_FILTERS, ...(filters || {}) }
  const source = Array.isArray(runs) ? runs : []
  const rows = visibleRows(source, envelopes, now, selected)
  const hiddenCount = source.length - rows.length
  const hidden = {
    count: hiddenCount,
    line: hiddenCount === 0 ? '' : `${hiddenCount} row${hiddenCount === 1 ? '' : 's'} hidden by the default filter (slug-less or archived)`,
  }
  const escalated = rows.filter((row) => row.status.key === 'escalated')
    .map((row) => ({ ...row, why: row.status.why }))
  const contradicted = rows.filter((row) => row.activity.key === 'contradicted')
    .map((row) => ({ ...row, why: row.activity.why }))
  // The rail composition keeps an escalated contradicted lane from appearing on the rail
  // twice; with no contradicted run present this list is byte-identical to today's. The
  // contradicted clause is the ONLY clause that can rank a non-escalated lane archived seconds ago whose heartbeat is still fresh.
  const silent = rows.filter((row) => row.status.key === 'running' && row.heartbeat.stale && row.activity.key !== 'contradicted' && row.status.key !== 'escalated')
    .map((row) => ({ ...row, why: row.heartbeat.text }))
  return { rows, rail: [...escalated, ...contradicted.filter((row) => row.status.key !== 'escalated'), ...silent], hidden, shown: rows.length }
}

export function escalationProbeTargets(rows = []) {
  const targets = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const run = row?.run && typeof row.run === 'object' ? row.run : row
    const slug = run?.goal ?? run?.task_slug
    const status = typeof run?.status === 'object' ? run.status.key : run?.status
    if (!run?.repo_slug || !slug || status === 'ok' || status === 'success' || run?.adw_id == null || seen.has(run.adw_id)) continue
    seen.add(run.adw_id)
    targets.push(run.adw_id)
  }
  return targets
}
