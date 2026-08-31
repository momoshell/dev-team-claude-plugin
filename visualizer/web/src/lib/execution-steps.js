import { buildTrajectory } from './spans.js'

const CATEGORY = [
  [/^scope-gate|^gate|^suite/, { key:'validation', label:'Validation' }],
  [/^review/, { key:'review', label:'Review' }],
  [/^plan|^check|^build|^lane/, { key:'work', label:'Agent work' }],
  [/^commit|^converge|^envelope-accept|^done|^escalate/, { key:'factory', label:'Factory' }],
]

function time(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value, min = 0, max = 1) { return Math.min(max, Math.max(min, value)) }

function seatMap(rows = []) {
  const seats = new Map()
  for (const row of rows) {
    if (!row?.seats || typeof row.seats !== 'object') continue
    for (const [role, seat] of Object.entries(row.seats)) seats.set(role, seat || {})
  }
  return seats
}

function assignmentState(assignment, stage, activity = 'live') {
  if (assignment.ended_at != null) {
    const status = String(assignment.status || 'returned').toLowerCase()
    return { key:status === 'done' || status === 'ok' ? 'returned' : status, label:status === 'done' || status === 'ok' ? 'Returned' : status.replaceAll('_',' ') }
  }
  if (stage.ended_at != null) return { key:'missing', label:'No return recorded' }
  if (activity === 'silent' || activity === 'settled') return { key:'missing', label:'No return recorded' }
  if (activity === 'unverified') return { key:'unverified', label:'Return unverified' }
  return { key:'active', label:'In progress' }
}

export function factoryStepName(value) {
  const source = String(value || 'factory step')
  const known = {
    'gate-baseline':'Gate baseline',
    'review:pass':'Review verdict',
    'suite:cold':'Cold test suite',
    'envelope-accept':'Accept return',
    'done':'Run complete',
  }
  if (known[source]) return known[source]
  const proofChecks = source.match(/^gate-proof:(\d+):checks$/)
  if (proofChecks) return `Mutation checks · generation ${proofChecks[1]}`
  const proof = source.match(/^gate-proof:(\d+)$/)
  if (proof) return `Gate proof · generation ${proof[1]}`
  const round = source.match(/^(.+):r(\d+)$/)
  const named = round ? `${round[1]} · round ${round[2]}` : source.replaceAll(':', ' · ')
  return named.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

export function factoryStepCategory(label) {
  return CATEGORY.find(([pattern]) => pattern.test(String(label || '')))?.[1] ?? { key:'factory', label:'Factory' }
}

function blockBounds(block, now) {
  const start = time(block.started_at)
  const end = time(block.ended_at) ?? (block.status === 'running' ? now : start)
  return { start, end: end == null || start == null ? null : Math.max(start, end) }
}

function blockAt(blocks, at, now) {
  const candidates = blocks.filter((block) => {
    const bounds = blockBounds(block, now)
    return bounds.start != null && bounds.end != null && bounds.start <= at && at <= bounds.end
  })
  if (candidates.length) return candidates.at(-1)
  return blocks.reduce((closest, block) => {
    const started = time(block.started_at)
    if (started == null) return closest
    const distance = Math.abs(started - at)
    return !closest || distance < closest.distance ? { block, distance } : closest
  }, null)?.block ?? null
}

function projectAt(block, at, now) {
  if (!block) return null
  const bounds = blockBounds(block, now)
  const elapsed = bounds.start == null || bounds.end == null ? 0 : bounds.end - bounds.start
  const fraction = elapsed > 0 ? clamp((at - bounds.start) / elapsed) : 0
  return block.x + fraction * block.width
}

export function factoryStepTrace(journalState = {}, timeline = {}, { now = Date.now(), activity = 'live' } = {}) {
  const payload = journalState.payload || {}
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  const trajectory = buildTrajectory(rows, { operational_channel: payload.channels?.operational ?? null })
  const blocks = [...(timeline.blocks || [])].filter((block) => !block.queued)
    .sort((left, right) => (time(left.started_at) - time(right.started_at)) || ((left.seq ?? 0) - (right.seq ?? 0)))
  const stages = trajectory.spans.filter((span) => span.family === 'stage')
  const assignments = trajectory.spans.filter((span) => span.family === 'assignment')
  const seats = seatMap(rows)
  const project = (span) => {
    const startBlock = blockAt(blocks, span.started_at, now)
    const endAt = span.ended_at ?? span.started_at
    const endBlock = blockAt(blocks, endAt, now) || startBlock
    const left = projectAt(startBlock, span.started_at, now) ?? 0
    const right = span.ended_at == null ? left : (projectAt(endBlock, span.ended_at, now) ?? left)
    return { phase_id:startBlock?.phase_id ?? null, phase:startBlock?.name ?? null, x:clamp(left), width:Math.max(0, clamp(right) - clamp(left)), marker:span.ended_at == null }
  }
  // A parent stage contains its nested check, so naive overlap paints the same
  // assignment on two rows. Ownership goes to the deepest stage active when the
  // assignment began; this is the journal's actual programmatic boundary.
  const ownerByAssignment = new Map(assignments.map((assignment) => {
    const owner = stages.filter((stage) => assignment.started_at >= stage.started_at && assignment.started_at <= (stage.ended_at ?? now))
      .sort((left, right) => (right.depth - left.depth) || (right.started_at - left.started_at))[0] ?? null
    return [assignment.started_index, owner?.started_index ?? null]
  }))
  const steps = stages.map((span) => {
    const category = factoryStepCategory(span.label)
    const handoffs = assignments.filter((assignment) => ownerByAssignment.get(assignment.started_index) === span.started_index).map((assignment) => {
      const seat = seats.get(assignment.role) || {}
      const state = assignmentState(assignment, span, activity)
      const knownEnd = span.ended_at ?? (state.key === 'missing' ? now : null)
      const visual = assignment.ended_at == null && knownEnd != null
        ? project({ ...assignment, ended_at:knownEnd })
        : project(assignment)
      return {
        ...assignment,
        ...visual,
        state,
        no_return:state.key === 'missing',
        model:seat.model ?? seat.id ?? null,
        effort:seat.effort ?? null,
      }
    })
    const state = handoffs.some((handoff) => handoff.no_return)
      ? { key:'missing', label:'No return recorded' }
      : handoffs.some((handoff) => handoff.state.key === 'active')
        ? { key:'active', label:'In progress' }
        : handoffs.some((handoff) => handoff.state.key === 'unverified')
          ? { key:'unverified', label:'Return unverified' }
        : handoffs.find((handoff) => handoff.state.key !== 'returned')?.state
          ?? (handoffs.length
            ? { key:'returned', label:'Returned' }
            : { key:'factory', label:'Recorded' })
    return {
      ...span,
      ...project(span),
      name: factoryStepName(span.label),
      category,
      kind:handoffs.length ? 'agent' : 'control',
      state,
      handoffs,
    }
  })
  const readError = journalState.error || payload.error
  const unavailable = payload.degraded === true || (readError && !rows.length)
    ? readError || 'the journal reader reported a degraded read'
    : null
  return {
    steps,
    unavailable,
    anomalies: trajectory.anomalies,
    measured: rows.length > 0,
  }
}
