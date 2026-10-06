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

export const STEP_TIMELINE_REASONS = Object.freeze(['plan-files-not-recorded','plan-dependencies-not-recorded','plan-checks-not-recorded','plan-chunk-carries-no-intent','no-gate-result','round-open','bounce-summary-not-journaled','not-a-bounce','gate-labels-not-recorded','invalid-round-timestamps','no-builder-census-in-window','ambiguous-builder-census','invalid-builder-census','no-per-step-cost-source','no-escalation-recorded','no-step-events','not-started','superseded-open-round','journal-unavailable','degrade-step-not-recorded','degrade-remaining-not-recorded','degrade-budget-not-recorded'])
export const STEP_TIMELINE_STATES = Object.freeze(['done','active','red','escalated','degraded','not-started'])
export const STEP_TIMELINE_OUTCOMES = Object.freeze(['done','red','bounced','accepted-by-gate'])
export const STEP_TIMELINE_TONES = Object.freeze(['ok','busy','fail','serious','muted'])
const TIMELINE_EVENTS = new Set(['step:start','step:done','step:red','step:bounce','step:accepted-by-gate','step:reverified','step:reverify-red','step:degrade'])
const TERMINALS = new Set(['step:done','step:red','step:bounce','step:accepted-by-gate'])
const GATE_EVENTS = new Set(['step:done','step:red','step:accepted-by-gate','step:reverified','step:reverify-red'])
const timelineReason = (value) => STEP_TIMELINE_REASONS.includes(value) ? value : null
const timelineState = (value) => value === null || STEP_TIMELINE_STATES.includes(value) ? value : null
const timelineOutcome = (event) => ({'step:done':STEP_TIMELINE_OUTCOMES[0],'step:red':STEP_TIMELINE_OUTCOMES[1],'step:bounce':STEP_TIMELINE_OUTCOMES[2],'step:accepted-by-gate':STEP_TIMELINE_OUTCOMES[3]})[event] ?? null
const toneFor = (state, result, regressed) => state === 'done' || result === 'passed' ? STEP_TIMELINE_TONES[0] : state === 'active' ? STEP_TIMELINE_TONES[1] : state === 'red' || result === 'failed' || regressed ? STEP_TIMELINE_TONES[2] : state === 'escalated' ? STEP_TIMELINE_TONES[3] : STEP_TIMELINE_TONES[4]
function timeValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value || !/^\d{4}-\d\d-\d\dT/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
export function stepTimeline(payload = {}) {
  const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const legacy = planSteps(safePayload), chunks = safePayload.plan?.chunks
  const validChunks = !legacy.absent && Array.isArray(chunks) ? chunks.filter((chunk) => chunk && typeof chunk === 'object' && !Array.isArray(chunk) && typeof chunk.id === 'string' && chunk.id.trim()) : []
  const rows = (Array.isArray(safePayload.rows) ? safePayload.rows : []).filter((row) => row && typeof row === 'object' && !Array.isArray(row) && (row.channel == null || row.channel === 'record'))
  const events = rows.map((row,index)=>({row,index})).filter(({row})=>TIMELINE_EVENTS.has(row.event))
  const anyEvents = events.length > 0, lastDegrade = [...events].reverse().find(({row})=>row.event==='step:degrade')
  const drow = lastDegrade?.row
  const degraded = safePayload.error || safePayload.degraded ? {value:null,step:null,step_reason:'journal-unavailable',remaining:null,remaining_reason:'journal-unavailable',reason:'journal-unavailable',budget:null,budget_reason:'journal-unavailable'} :
    drow ? {value:true,step:typeof drow.step==='string'?drow.step:null,...(typeof drow.step==='string'?{}:{step_reason:'degrade-step-not-recorded'}),remaining:Array.isArray(drow.remaining)?[...drow.remaining]:null,...(Array.isArray(drow.remaining)?{}:{remaining_reason:'degrade-remaining-not-recorded'}),reason:drow.reason??null,budget:drow.budget??null,...(drow.budget==null?{budget_reason:'degrade-budget-not-recorded'}:{})} :
    {value:anyEvents?false:null,reason:anyEvents?null:'no-step-events'}
  const starts = events.filter(({row})=>row.event==='step:start' && typeof row.step==='string' && Number.isInteger(row.round) && row.round>0)
  const lastStarts = [...new Map(starts.map((entry) => [entry.row.step, entry])).values()].sort((a, b) => a.index - b.index)
  const latestOpen = lastStarts.filter(({row,index})=>!events.some(({row:t,index:ti})=>ti>index && TERMINALS.has(t.event) && t.step===row.step && t.round===row.round)).at(-1)
  const steps = validChunks.map((chunk) => {
    const owned = Array.isArray(chunk.checks_owned) ? chunk.checks_owned.filter(x=>typeof x==='string') : null
    const related = events.filter(({row})=>row.step===chunk.id)
    const gate = related.filter(({row})=>GATE_EVENTS.has(row.event)).at(-1)?.row
    const passed = Array.isArray(gate?.passed)?gate.passed:[], failed = Array.isArray(gate?.failed)?gate.failed:[]
    const checks = owned?.map((id) => ({ id, result: passed.includes(id) ? 'passed' : failed.includes(id) ? 'failed' : null, regressed: Array.isArray(gate?.regressed)?gate.regressed.includes(id):false, reason:gate?(!passed.includes(id)&&!failed.includes(id)?'no-gate-result':null):'no-gate-result', tone:toneFor(null,passed.includes(id)?'passed':failed.includes(id)?'failed':null,Array.isArray(gate?.regressed)&&gate.regressed.includes(id)) })) ?? null
    const ownStarts=starts.filter(({row})=>row.step===chunk.id)
    const rounds=ownStarts.map(({row,index}, si)=>{
      const next=ownStarts.slice(si+1).find(x=>x.row.round===row.round)
      const terminal=events.filter(({row:t,index:ti})=>ti>index&&(!next||ti<next.index)&&TERMINALS.has(t.event)&&t.step===row.step&&t.round===row.round).at(-1)?.row
      const startMs=timeValue(row.at), endMs=timeValue(terminal?.at)
      const duration_ms = startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null
      const duration_reason=terminal?(duration_ms===null?'invalid-round-timestamps':null):'round-open'
      const censuses=rows.filter((r)=>r.seat_turn_census?.role==='builder' && timeValue(r.at)!==null && startMs!==null && endMs!==null && timeValue(r.at)>=startMs && timeValue(r.at)<=endMs)
      let turnsReason=terminal?(startMs===null||endMs===null?'invalid-round-timestamps':censuses.length===0?'no-builder-census-in-window':censuses.length>1?'ambiguous-builder-census':null):'round-open'
      const turns = censuses.length === 1 ? censuses[0].seat_turn_census.turns : null
      const validTurns=Number.isInteger(turns)&&turns>=0
      if(censuses.length === 1 && !validTurns) turnsReason='invalid-builder-census'
      const outcome=terminal?timelineOutcome(terminal.event):null
      const bounced=terminal?.event==='step:bounce'
      return {round:row.round,outcome,reason:terminal?null:'round-open',bounce_status:terminal?.event === 'step:bounce' ? terminal.status ?? null : null,bounce_reason:null,bounce_reason_reason:bounced?'bounce-summary-not-journaled':'not-a-bounce',failed:terminal?(Array.isArray(terminal.failed)?[...terminal.failed]:null):null,failed_reason:terminal?(Array.isArray(terminal.failed)?null:'gate-labels-not-recorded'):'round-open',regressed:terminal?(Array.isArray(terminal.regressed)?[...terminal.regressed]:null):null,regressed_reason:terminal?(Array.isArray(terminal.regressed)?null:'gate-labels-not-recorded'):'round-open',duration_ms,duration_reason,turns:validTurns?turns:null,turns_reason:turnsReason,cost:null,cost_reason:'no-per-step-cost-source'}
    })
    const doneAfter=(degradeIndex)=>related.some(({row,index})=>index>degradeIndex&&['step:done','step:accepted-by-gate','step:reverified'].includes(row.event))
    const completedAfterDegrade=drow?doneAfter(lastDegrade.index):false
    const isDegraded = Array.isArray(drow?.remaining) && drow.remaining.includes(chunk.id) && !completedAfterDegrade
    const open=latestOpen?.row.step===chunk.id
    const laterEscalation=latestOpen&&open?rows.slice(latestOpen.index+1).findLast(r=>typeof r.stage==='string'&&r.stage.startsWith('escalate:')):null
    const escalation = laterEscalation?.stage ?? null
    let state, reason
    if(safePayload.error||safePayload.degraded){state=null;reason='journal-unavailable'}
    else if(!anyEvents){state=null;reason='no-step-events'}
    else if(isDegraded){state='degraded';reason=null}
    else if(open){state=escalation?'escalated':'active';reason=null}
    else if(!related.length){state='not-started';reason='not-started'}
    else {const last=related.at(-1).row;state=last.event==='step:done'||last.event==='step:accepted-by-gate'||last.event==='step:reverified'?'done':last.event==='step:red'||last.event==='step:reverify-red'||last.event==='step:bounce'?'red':'not-started';reason=state==='not-started'?'not-started':null}
    const ownLastStart=lastStarts.find(({row})=>row.step===chunk.id)
    if(latestOpen && ownLastStart && ownLastStart.index<latestOpen.index && !open && !events.some(({row:t,index:ti})=>ti>ownLastStart.index&&TERMINALS.has(t.event)&&t.step===ownLastStart.row.step&&t.round===ownLastStart.row.round)){state=null;reason='superseded-open-round'}
    const unavailable=Boolean(safePayload.error || safePayload.degraded)
    const finalChecks=unavailable?owned?.map(id=>({id,result:null,regressed:null,reason:'journal-unavailable',tone:'muted'})):checks
    const finalRounds=unavailable?null:rounds
    const finalEscalation=unavailable?null:escalation
    const finalState=unavailable?null:timelineState(state), finalReason=timelineReason(unavailable?'journal-unavailable':reason)
    const tone=unavailable?'muted':toneFor(finalState,null,finalChecks?.some(c=>c.regressed))
    return {id:chunk.id,files: Array.isArray(chunk.files_in_scope) ? [...chunk.files_in_scope] : null,files_reason:Array.isArray(chunk.files_in_scope)?null:'plan-files-not-recorded',depends_on:Array.isArray(chunk.depends_on)?[...chunk.depends_on]:null,depends_on_reason:Array.isArray(chunk.depends_on)?null:'plan-dependencies-not-recorded',intent:typeof chunk.intent==='string'?chunk.intent:null,intent_reason:typeof chunk.intent==='string'?null:'plan-chunk-carries-no-intent',checks:finalChecks,checks_reason:owned?null:'plan-checks-not-recorded',rounds:finalRounds,state:finalState,reason:finalReason,escalation:finalEscalation,escalation_reason:unavailable?'journal-unavailable':finalEscalation?null:'no-escalation-recorded',tone}
  })
  return {steps,absent:legacy.absent,unplanned:legacy.unplanned,degraded,strip:steps.map(({id,state,reason,tone})=>({id,state,reason,tone}))}
}
