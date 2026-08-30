function words(value) {
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
}

function sentence(value) {
  const text = String(value || '').trim()
  if (text.length <= 96) return text
  const first = text.match(/^(.{24,110}?[.!?])(?:\s|$)/)?.[1]
  return first || `${text.slice(0, 93).trimEnd()}…`
}

function title(value) {
  const text = words(value)
  return text ? text[0].toUpperCase() + text.slice(1) : 'Unknown'
}

export function eventPayload(event = {}) {
  if (event?.payload_json == null && event?.payload && typeof event.payload === 'object') return event.payload
  try { return typeof event?.payload_json === 'string' ? JSON.parse(event.payload_json || '{}') : (event?.payload_json || {}) }
  catch { return event?.payload_json || '' }
}

function phaseName(phases, id) {
  const phase = (Array.isArray(phases) ? phases : []).find((entry) => entry?.id != null && String(entry.id) === String(id))
  return phase?.name ? title(phase.name) : (id == null ? null : `Phase ${id}`)
}

function logStory(message, level, phase) {
  const value = String(message || '').trim()
  const marker = value.match(/^(plan|check|build|scope-gate|lane|gate|review|finish|scout|repair|directed):r(\d+)$/)
  if (marker) {
    const nouns = {
      plan:'Planning', check:'Plan check', build:'Build', 'scope-gate':'Scope check',
      lane:'Lane verification', gate:'Acceptance gate', review:'Review', finish:'Finish',
      scout:'Repository survey', repair:'Repair', directed:'Directed build',
    }
    return { title:`${nouns[marker[1]]} round ${marker[2]} reached`, detail:phase ? `Workflow checkpoint recorded in ${phase}.` : 'Workflow checkpoint recorded.' }
  }

  const gateProof = value.match(/^gate-proof:(\d+)(:checks)?$/)
  if (gateProof) return {
    title:gateProof[2] ? `Gate proof ${gateProof[1]} checks recorded` : `Gate proof ${gateProof[1]} recorded`,
    detail:'Evidence for the acceptance gate was added to the ordered workflow history.',
  }
  const gateRepair = value.match(/^gate-(repair|reverify):(\d+)$/)
  if (gateRepair) return {
    title:gateRepair[1] === 'repair' ? `Gate repair ${gateRepair[2]} reached` : `Gate re-verification ${gateRepair[2]} reached`,
    detail:gateRepair[1] === 'repair' ? 'The acceptance gate required a repair checkpoint.' : 'The repaired acceptance gate was checked again.',
  }

  const exact = {
    'gate-baseline': ['Gate baseline recorded', 'The acceptance gate was measured before the implementation result.'],
    'review:pass': ['Review accepted the work', 'The review checkpoint recorded a pass.'],
    suite: ['Validation suite reached', 'The normal validation checkpoint was recorded.'],
    commit: ['Commit checkpoint reached', 'The workflow recorded its commit checkpoint.'],
    'suite:cold': ['Cold validation reached', 'Validation was repeated from a clean checkout context.'],
    done: ['Workflow completed', 'The final workflow checkpoint was recorded.'],
    'envelope-accept': ['Result envelope accepted', 'The returned result matched the expected handoff shape.'],
  }
  if (exact[value]) return { title:exact[value][0], detail:exact[value][1] }

  const escalation = value.match(/^escalate(?::([^\s]+))?$/)
  if (escalation) return { title:'Escalation recorded', detail:escalation[1] ? `The workflow escalated from ${title(escalation[1])}.` : null }
  const attention = value.match(/^attention:([^\s]+)(?:\s+park_id=\S+)?(?:\s+task=\S+)?\s*(.*)$/s)
  if (attention) {
    const attentionTitle = attention[1] === 'escalation' ? 'Task parked for operator attention' : `${title(attention[1])} requires operator attention`
    return { title:attentionTitle, detail:attention[2]?.trim() || 'The task was preserved with its context for a human decision.' }
  }
  const text = value
  return { title:sentence(text) || `${title(level)} log recorded`, detail:text && sentence(text) !== text ? text : null }
}

function endTitle(role, outcome) {
  const actor = title(role || 'agent')
  if (outcome === 'done' || outcome === 'ok') return `${actor} completed its turn`
  if (outcome === 'insufficient') return `${actor} reported insufficient context`
  if (outcome === 'escalate' || outcome === 'escalated') return `${actor} requested escalation`
  if (outcome === 'fail' || outcome === 'failed') return `${actor} turn failed`
  if (outcome === 'aborted') return `${actor} turn was aborted`
  return `${actor} turn ended`
}

export function eventStory(event = {}, phases = []) {
  const payload = eventPayload(event)
  const value = payload && typeof payload === 'object' ? payload : {}
  const role = value.role || null
  const dispatch = value.dispatch_id || null
  const outcome = value.outcome || null
  const phase = phaseName(phases, event?.phase_id)
  const base = {
    sequence: event?.seq ?? null,
    kind: event?.type || 'event',
    kindLabel: title(event?.type || 'event'),
    phase,
    role: role ? title(role) : null,
    dispatch,
    outcome: outcome ? title(outcome) : null,
    at: event?.started_at || event?.ended_at || null,
    tone: 'neutral',
    title: 'Ledger event recorded',
    detail: null,
    raw: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
  }

  if (event?.type === 'agent_start') {
    return { ...base, kindLabel:'Turn started', title:`${title(role || 'agent')} started a turn`, detail:dispatch ? `Dispatch ${dispatch} entered ${phase || 'the workflow'}.` : null, tone:'active' }
  }
  if (event?.type === 'agent_end') {
    const detail = [dispatch ? `Dispatch ${dispatch}` : null, outcome ? `ended with outcome “${words(outcome)}”` : 'ended'].filter(Boolean).join(' ')
    const tone = ['done','ok'].includes(outcome) ? 'ok' : ['fail','failed','aborted'].includes(outcome) ? 'fail' : ['insufficient','escalate','escalated'].includes(outcome) ? 'warn' : 'neutral'
    return { ...base, kindLabel:'Turn ended', title:endTitle(role, outcome), detail:`${detail}.`, tone }
  }
  if (event?.type === 'decision') {
    const decided = value.decided || value.outcome || 'recorded'
    const tone = /escalat|refus|fail/i.test(decided) ? 'warn' : /accept|pass|done|ok/i.test(decided) ? 'ok' : 'active'
    return { ...base, kindLabel:'Decision', title:`Decision: ${title(decided)}`, detail:value.why || value.reason || null, tone, outcome:title(decided) }
  }
  if (event?.type === 'log') {
    const level = String(value.level || 'info').toLowerCase()
    const story = logStory(value.message, level, phase)
    return { ...base, kindLabel:`${title(level)} log`, ...story, tone:level === 'warn' || level === 'error' ? 'warn' : 'neutral' }
  }
  return { ...base, title:sentence(value.message || value.summary || base.kindLabel), detail:value.why || value.reason || null }
}

export function eventStreamSummary(events = []) {
  const rows = Array.isArray(events) ? events : []
  return {
    total: rows.length,
    starts: rows.filter((event) => event?.type === 'agent_start').length,
    ends: rows.filter((event) => event?.type === 'agent_end').length,
    decisions: rows.filter((event) => event?.type === 'decision').length,
    logs: rows.filter((event) => event?.type === 'log').length,
  }
}
