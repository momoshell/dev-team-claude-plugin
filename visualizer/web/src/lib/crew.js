const NORMAL_OUTCOME = new Set(['done', 'ok', 'success', 'returned'])

function seatIdentity(agent) {
  return `${agent?.role || 'unlinked'}\u0000${agent?.lane ?? 'unlinked'}`
}

function outcomeSummary(assignments) {
  const outcomes = assignments.map((assignment) => String(assignment?.outcome || 'unknown').toLowerCase())
  const failures = outcomes.filter((outcome) => outcome === 'fail' || outcome === 'failed').length
  if (failures) return { key:'failed', label:`${failures} failed` }
  const active = outcomes.filter((outcome) => outcome === 'active' || outcome === 'running').length
  if (active) return { key:'active', label:`${active} active` }
  const stale = outcomes.filter((outcome) => outcome === 'silent' || outcome === 'stale' || outcome === 'unverified').length
  if (stale) return { key:'unverified', label:`${stale} unverified` }
  if (outcomes.length && outcomes.every((outcome) => NORMAL_OUTCOME.has(outcome))) return { key:'done', label:'All done' }
  return { key:'unknown', label:'Mixed' }
}

export function crewSummary(rows = []) {
  const assignments = Array.isArray(rows) ? rows : []
  const seats = new Map()
  const dispatches = new Set()
  for (const assignment of assignments) {
    const key = seatIdentity(assignment)
    if (!seats.has(key)) seats.set(key, { key, role:assignment?.role ?? null, lane:assignment?.lane ?? null, assignments:[] })
    seats.get(key).assignments.push(assignment)
    if (assignment?.dispatch_id) dispatches.add(assignment.dispatch_id)
  }
  const collapsed = [...seats.values()].map((seat) => {
    const models = [...new Set(seat.assignments.map((assignment) => assignment?.model).filter(Boolean))]
    const measuredModels = seat.assignments.filter((assignment) => assignment?.model).length
    return {
      ...seat,
      assignment_count:seat.assignments.length,
      dispatch_ids:[...new Set(seat.assignments.map((assignment) => assignment?.dispatch_id).filter(Boolean))],
      models,
      model:models.length === 1 ? models[0] : models.length > 1 ? `${models.length} models observed` : null,
      model_title:models.join(', '),
      model_coverage:measuredModels,
      outcome:outcomeSummary(seat.assignments),
    }
  })
  return {
    seats:collapsed,
    seat_count:collapsed.length,
    assignment_count:assignments.length,
    dispatch_count:dispatches.size,
    process_count:null,
  }
}
