const ROLE_ORDER = ['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver']

export const STORY_KINDS = Object.freeze([
  'stage', 'assign', 'envelope', 'plan_frozen', 'review_outcome', 'gate_discrimination',
  'gate_check_discrimination', 'cold_suite', 'build_bounce', 'acceptance-coverage-bounce',
  'step:bounce', 'decision', 'reseat', 'published', 'provider-retry', 'provider-retry-resumed',
  'provider-retry-declined', 'seat-retrying', 'seat-substrate-down', 'seat-substrate-recovered',
])
const STORY_SET = new Set(STORY_KINDS)

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

export function assignmentPath(view = {}, envelopes = [], fullView = view) {
  const spans = (Array.isArray(view.spans) ? view.spans : [])
    .filter((span) => span.family === 'assignment')
    .sort((a, b) => a.started_at - b.started_at)
  const groups = new Map()
  for (const span of Array.isArray(fullView.spans) ? fullView.spans : []) {
    if (span.family !== 'assignment') continue
    const dispatch = span.id || String(span.label || '').split(':')[0]
    const role = span.role || 'unknown'
    const key = `${dispatch} ${role}`
    const group = groups.get(key) ?? { count: 0, marked: 0 }
    group.count += 1
    if (span.coverage_reask === 'coverage-reask') group.marked += 1
    groups.set(key, group)
  }
  const list = Array.isArray(envelopes) ? envelopes : []
  return spans.map((span, index) => {
    const dispatch = span.id || String(span.label || '').split(':')[0]
    const role = span.role || 'unknown'
    const handoff = { ...span, order:index + 1, dispatch, role, outcome:'outcome not recorded', tone:'neutral', duration:duration(span.duration_ms) }
    if (span.ended_at == null) return { ...handoff, outcome:'in flight', tone:'warn' }
    const group = groups.get(`${dispatch} ${role}`) ?? { count: 0, marked: 0 }
    const wantReask = span.coverage_reask ?? null
    if (group.count > 1 && wantReask === null && group.marked === 0) return handoff
    const joinedList = list.filter((entry) => entry?.valid !== false && entry?.assignment_id === dispatch && entry?.role === role && (entry?.coverage_reask ?? null) === wantReask)
    if (joinedList.length !== 1) return handoff
    const joined = joinedList[0]
    const status = joined?.status
    const details = joined?.details ?? {}
    const verdict = details?.verdict
    const decision = details?.decision
    let outcome
    let tone = 'neutral'
    if (status === 'insufficient') { outcome = 'insufficient'; tone = 'warn' }
    else if (status === 'blocked') { outcome = 'blocked'; tone = 'fail' }
    else if (role === 'tech-lead' && verdict === 'approve') { outcome = 'accepted'; tone = 'ok' }
    else if (role === 'tech-lead' && verdict === 'revise') { outcome = 'changes requested'; tone = 'warn' }
    else if (role === 'tech-lead' && typeof verdict === 'string' && verdict) { outcome = words(verdict) }
    else if (role === 'reviewer' && verdict === 'pass') { outcome = 'accepted'; tone = 'ok' }
    else if (role === 'reviewer' && verdict === 'changes-needed') {
      const mustFix = details?.must_fix
      outcome = `changes requested${mustFix != null ? ` with ${mustFix} must-fix` : ''}`
      tone = 'warn'
    } else if (role === 'reviewer' && typeof verdict === 'string' && verdict) { outcome = words(verdict) }
    else if (role === 'builder' && status === 'done') {
      const count = Array.isArray(details.files_changed) ? details.files_changed.length : null
      outcome = count == null ? 'done' : `done with ${count} file${count === 1 ? '' : 's'} changed`
      tone = 'ok'
    } else if (role === 'lead' && decision === 'accept') { outcome = 'accepted'; tone = 'ok' }
    else if (role === 'lead' && typeof decision === 'string' && decision.startsWith('bounce')) { outcome = 'bounced'; tone = 'warn' }
    else if (role === 'lead' && typeof decision === 'string' && decision.startsWith('escalate')) { outcome = 'escalated'; tone = 'fail' }
    else if (role === 'lead' && typeof decision === 'string' && decision) { outcome = words(decision) }
    else if (status === 'done') { outcome = 'done'; tone = 'ok' }
    else { outcome = words(status || 'unknown') }
    return { ...handoff, outcome, tone }
  })
}

function kindOf(entry) {
  if (typeof entry?.event === 'string' && entry.event) return entry.event
  if (typeof entry?.row?.event === 'string') return entry.row.event
  return 'row'
}

function sentenceFor(entry, joined) {
  const row = entry?.row ?? {}
  const kind = kindOf(entry)
  const actor = row.role || 'agent'
  if (kind === 'assign') return `${actor} received ${row.assign}`
  if (kind === 'envelope') {
    const files = Array.isArray(joined?.details?.files_changed) ? joined.details.files_changed : null
    const filePhrase = files == null ? '' : ` with ${files.length} file${files.length === 1 ? '' : 's'} changed`
    return `${actor} ${row.envelope} returned ${words(row.status || 'unknown')}${filePhrase}`
  }
  if (kind === 'stage') {
    if (typeof row.stage === 'string' && row.stage.startsWith('escalate:')) return `escalated at ${words(row.stage.slice('escalate:'.length))}`
    return `${stageLabel(row.stage)} started`
  }
  if (kind === 'plan_frozen') return 'plan accepted'
  if (kind === 'review_outcome') {
    const review = row.review_outcome && typeof row.review_outcome === 'object' ? row.review_outcome : {}
    return `review${review.dispatch ? ` ${review.dispatch}` : ''} ${words(review.verdict || 'recorded')} with ${review.must_fix ?? 0} must-fix`
  }
  if (kind === 'gate_discrimination') {
    const total = row.gate_summary?.total
    const failed = row.gate_summary?.failed
    if (typeof total === 'number' && typeof failed === 'number') return `gate ${words(row.gate_discrimination || 'recorded')}, ${failed} of ${total} checks red on the unchanged tree`
    return `gate discrimination ${words(row.gate_discrimination || 'recorded')}`
  }
  if (kind === 'gate_check_discrimination') return `gate check discrimination ${words(row.gate_check_discrimination || 'recorded')} with ${row.gate_check_discriminations?.length ?? 0} declared mutation checks`
  if (kind === 'cold_suite') {
    const verdict = row.cold_suite && typeof row.cold_suite === 'object' ? row.cold_suite?.verdict : row.cold_suite
    return `cold validation ${words(verdict || 'recorded')}`
  }
  if (kind === 'seat-retrying') return `${row.role || 'seat'} began retrying`
  if (kind === 'seat-substrate-down') return 'pane substrate became unavailable'
  if (kind === 'seat-substrate-recovered') return 'pane substrate recovered'
  const prefix = row.role ? `${row.role} ` : 'factory '
  const suffix = row.status ? ` ${words(row.status)}` : ''
  return `${prefix}${words(kind)}${suffix}`
}

export function journalLines(rows = [], { reveal = false, envelopes = [] } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const pool = Array.isArray(envelopes) ? envelopes : []
  const byKey = new Map()
  for (const envelope of pool) {
    if (envelope?.valid === false) continue
    const key = `${envelope?.assignment_id}\0${envelope?.role}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(envelope)
  }
  let operationalCount = 0
  const groups = []
  let last = null
  for (const entry of list) {
    const row = entry?.row ?? {}
    const kind = kindOf(entry)
    const isStory = STORY_SET.has(kind)
    if (!isStory) operationalCount += 1
    if (!isStory && !reveal) continue
    const hits = typeof row.envelope === 'string' ? byKey.get(`${row.envelope}\0${row.role}`) ?? [] : []
    const joined = hits.length === 1 ? hits[0] : null
    if (last && last.kind === kind) {
      last.entries.push({ entry, row, joined })
    } else {
      const group = { kind, entries:[{ entry, row, joined }] }
      groups.push(group)
      last = group
    }
  }
  const lines = groups.map((group) => {
    const first = group.entries[0].entry
    const count = group.entries.length
    let text
    if (count === 1) text = sentenceFor(first, group.entries[0].joined)
    else {
      const skills = group.kind === 'seat-skills'
      const totals = new Map()
      for (const item of group.entries) {
        const role = item.row?.role || 'factory'
        const n = skills ? (Array.isArray(item.row?.skills) ? item.row.skills.length : 0) : 1
        totals.set(role, (totals.get(role) ?? 0) + n)
      }
      const rollup = [...totals.entries()].map(([role, n]) => `${role} ${n}`).join(', ')
      text = skills ? `${count} seats loaded skills — ${rollup}` : `${words(group.kind)} recorded ${count} times — ${rollup}`
    }
    return { index:first.index, indexes:group.entries.map((item) => item.entry.index), at_ms:first.at_ms, kind:group.kind, count, text, tone:trajectoryRowStory(first).tone, raw:group.entries.map((item) => JSON.stringify(item.entry.row ?? {}, null, 2)).join('\n') }
  })
  return { lines, operationalCount }
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
