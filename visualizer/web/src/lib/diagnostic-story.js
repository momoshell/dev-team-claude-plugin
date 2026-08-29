const ROLE_ORDER = ['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver']

function words(value) {
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
}

function title(value) {
  const text = words(value)
  return text ? text[0].toUpperCase() + text.slice(1) : 'Unknown'
}

export function duration(value) {
  if (value == null) return 'In flight'
  const seconds = Math.max(0, Math.round(value / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function envelopeGroups(envelopes = []) {
  const map = new Map()
  for (const envelope of Array.isArray(envelopes) ? envelopes : []) {
    const role = envelope?.role || 'unknown'
    if (!map.has(role)) map.set(role, [])
    map.get(role).push(envelope)
  }
  return [...map.entries()]
    .map(([role, entries]) => ({ role, entries:[...entries].sort((a, b) => (a.dispatch_seq ?? 0) - (b.dispatch_seq ?? 0)) }))
    .sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.role), bi = ROLE_ORDER.indexOf(b.role)
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.role.localeCompare(b.role)
    })
}

export function envelopeOverview(envelopes = [], task = null) {
  const rows = Array.isArray(envelopes) ? envelopes : []
  const roles = new Set(rows.map((entry) => entry?.role).filter(Boolean))
  return {
    returns: rows.length,
    roles: roles.size,
    completed: rows.filter((entry) => entry?.valid && entry?.status === 'done').length,
    invalid: rows.filter((entry) => entry?.valid === false).length,
    retries: Math.max(0, rows.length - roles.size),
    taskStatus: task?.status || null,
  }
}

function gateChecks(entry) {
  const match = String(entry?.details?.baseline_gate_summary || '').match(/"total"\s*:\s*(\d+)/)
  return match ? Number(match[1]) : null
}

export function envelopeFacts(entry = {}) {
  const details = entry?.details || {}
  const files = details.files_changed || details.files_in_scope || []
  const findings = Array.isArray(details.findings) ? details.findings : null
  const checks = gateChecks(entry)
  const facts = []
  if (details.verdict) facts.push({ label:'Verdict', value:title(details.verdict), tone:details.verdict === 'pass' ? 'ok' : 'warn' })
  if (Array.isArray(files)) facts.push({ label:details.files_changed ? 'Changed' : 'Scope', value:`${files.length} file${files.length === 1 ? '' : 's'}` })
  if (findings) facts.push({ label:'Findings', value:String(findings.length), tone:findings.length ? 'warn' : 'ok' })
  if (details.must_fix != null) facts.push({ label:'Must-fix', value:String(details.must_fix), tone:details.must_fix ? 'fail' : 'ok' })
  if (checks != null) facts.push({ label:'Gate checks', value:String(checks) })
  if (details.validation) facts.push({ label:'Validation', value:'Recorded', tone:'ok' })
  if (details.commit_message || details.commit_subject) facts.push({ label:'Commit', value:'Prepared' })
  if (Array.isArray(entry.artifacts)) facts.push({ label:'Artifacts', value:String(entry.artifacts.length) })
  return facts.slice(0, 5)
}

export function envelopeSections(entry = {}) {
  const details = entry?.details || {}
  const sections = []
  const addText = (heading, value) => { if (typeof value === 'string' && value.trim()) sections.push({ heading, kind:'text', value:value.trim() }) }
  const addList = (heading, value) => { if (Array.isArray(value) && value.length) sections.push({ heading, kind:'list', value }) }
  addText('Why this return stopped', details.reason || details.why)
  addText('Operator guidance', details.guidance)
  addText('Validation performed', details.validation)
  addText('Validation lane', details.validation_lane)
  addText('Commit intent', details.commit_message || details.commit_subject)
  addList(details.files_changed ? 'Files changed' : 'Files in scope', details.files_changed || details.files_in_scope)
  addList('Issues', details.issues)
  addList('Questions for the operator', details.consult_questions)
  return sections
}

export function trajectorySummary(view = {}) {
  const spans = Array.isArray(view.spans) ? view.spans : []
  const assignments = spans.filter((span) => span.family === 'assignment')
  const markers = assignments.flatMap((span) => span.markers || [])
  return {
    handoffs: assignments.length,
    completed: assignments.filter((span) => span.ended_at != null).length,
    inFlight: assignments.filter((span) => span.ended_at == null).length,
    seatIncidents: markers.filter((marker) => marker.event === 'seat-retrying' || marker.event === 'seat-stale').length,
    substrateOutages: markers.filter((marker) => marker.event === 'seat-substrate-down').length,
    driverStages: spans.filter((span) => span.family === 'stage' && span.actor === 'driver').length,
  }
}

export function assignmentPath(view = {}) {
  return (Array.isArray(view.spans) ? view.spans : [])
    .filter((span) => span.family === 'assignment')
    .sort((a, b) => a.started_at - b.started_at)
    .map((span, index) => ({
      ...span,
      order:index + 1,
      dispatch:span.id || String(span.label || '').split(':')[0],
      role:span.role || 'unknown',
      outcome:span.status || (span.ended_at == null ? 'in flight' : 'returned'),
      duration:duration(span.duration_ms),
    }))
}

function stageLabel(value) {
  const match = String(value || '').match(/^(.+):r(\d+)$/)
  if (match) return `${title(match[1])} round ${match[2]}`
  return title(value)
}

export function trajectoryRowStory(entry = {}) {
  const row = entry.row || {}
  const base = { title:title(entry.event || 'journal event'), detail:null, role:row.role || null, tone:'neutral', raw:JSON.stringify(row, null, 2) }
  if (row.assign) return { ...base, title:`${title(row.role || 'agent')} received ${row.assign}`, detail:row.brief ? `Brief: ${String(row.brief).split('/').at(-1)}` : 'A new agent handoff began.', tone:'active' }
  if (row.envelope) return { ...base, title:`${title(row.role || 'agent')} returned ${row.envelope}`, detail:`Outcome recorded as ${words(row.status || 'unknown')}.`, tone:row.status === 'done' ? 'ok' : 'warn' }
  if (row.stage) return { ...base, title:`${stageLabel(row.stage)} started`, detail:'Factory coordination checkpoint.', tone:'active' }
  if (row.stage_done) return { ...base, title:`${stageLabel(row.stage_done)} completed`, detail:'Factory coordination checkpoint completed.', tone:'ok' }
  if (row.review_outcome) {
    const review = row.review_outcome
    return { ...base, title:`Review ${words(review.verdict || 'recorded')}`, detail:`${review.findings?.length ?? 0} finding${review.findings?.length === 1 ? '' : 's'} · ${review.must_fix ?? '—'} must-fix.`, tone:review.verdict === 'pass' ? 'ok' : 'warn' }
  }
  if (row.gate_discrimination) return { ...base, title:`Gate discrimination ${words(row.gate_discrimination)}`, detail:`Generation ${row.gate_generation ?? '—'} · ${row.gate_summary?.total ?? '—'} checks.`, tone:row.gate_discrimination === 'proven' ? 'ok' : 'warn' }
  if (row.gate_check_discrimination) return { ...base, title:`Gate check discrimination ${words(row.gate_check_discrimination)}`, detail:`${row.gate_check_discriminations?.length ?? 0} declared mutation checks recorded.`, tone:row.gate_check_discrimination === 'proven' ? 'ok' : 'warn' }
  if (row.cold_suite) return { ...base, title:`Cold validation ${words(row.cold_suite.verdict || 'recorded')}`, detail:'The suite was repeated from a clean checkout context.', tone:row.cold_suite.verdict === 'green' ? 'ok' : 'warn' }
  if (entry.event === 'seat-retrying') return { ...base, title:`${title(row.role || 'seat')} began retrying`, detail:'The seat was waiting on its provider.', tone:'warn' }
  if (entry.event === 'seat-substrate-down') return { ...base, title:'Pane substrate became unavailable', detail:'This may affect multiple seats in the same batch.', tone:'fail' }
  return base
}
