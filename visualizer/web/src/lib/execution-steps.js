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

export function factoryStepName(value) {
  const source = String(value || 'factory step')
  const round = source.match(/^(.+):r(\d+)$/)
  const named = round ? `${round[1]} · round ${round[2]}` : source
  return named.replaceAll(':', ' · ').replaceAll('-', ' ')
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

export function factoryStepTrace(journalState = {}, timeline = {}, { now = Date.now() } = {}) {
  const payload = journalState.payload || {}
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  const trajectory = buildTrajectory(rows, { operational_channel: payload.channels?.operational ?? null })
  const blocks = [...(timeline.blocks || [])].filter((block) => !block.queued)
    .sort((left, right) => (time(left.started_at) - time(right.started_at)) || ((left.seq ?? 0) - (right.seq ?? 0)))
  const stages = trajectory.spans.filter((span) => span.family === 'stage')
  const assignments = trajectory.spans.filter((span) => span.family === 'assignment')
  const project = (span) => {
    const startBlock = blockAt(blocks, span.started_at, now)
    const endAt = span.ended_at ?? span.started_at
    const endBlock = blockAt(blocks, endAt, now) || startBlock
    const left = projectAt(startBlock, span.started_at, now) ?? 0
    const right = span.ended_at == null ? left : (projectAt(endBlock, span.ended_at, now) ?? left)
    return { phase_id:startBlock?.phase_id ?? null, phase:startBlock?.name ?? null, x:clamp(left), width:Math.max(0, clamp(right) - clamp(left)), marker:span.ended_at == null }
  }
  const overlaps = (assignment, stage) => {
    const assignmentEnd = assignment.ended_at ?? now
    const stageEnd = stage.ended_at ?? now
    return assignment.started_at <= stageEnd && assignmentEnd >= stage.started_at
  }
  const steps = stages.map((span) => {
    const category = factoryStepCategory(span.label)
    return {
      ...span,
      ...project(span),
      name: factoryStepName(span.label),
      category,
      handoffs: assignments.filter((assignment) => overlaps(assignment, span)).map((assignment) => ({ ...assignment, ...project(assignment) })),
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
