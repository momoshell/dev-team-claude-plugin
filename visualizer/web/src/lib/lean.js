// Pure presentation for lean lanes (ADR-052). Stage boundaries and checks carry timestamps;
// unrecorded values remain absent with their reason.
import { leanStatus } from './fleet.js'

// Journal rows → recorded-order lines. No time is read or invented.
function journalLines(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const stage = row.stage ?? '—'
    const named = !row.event ? Object.keys(row).find((key) => key.startsWith('advisor_') || key === 'scout_nudge' || key === 'subagent_usage') : null
    const event = row.event ?? named ?? 'unknown'
    const parts = (...values) => values.filter((value) => value != null && value !== '').map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' · ')
    let detail = ''
    if (named === 'scout_nudge') detail = parts(row.role, row.scout_nudge?.reads != null ? `${row.scout_nudge.reads} reads` : null, row.scout_nudge?.directories != null ? `${row.scout_nudge.directories} directories` : null)
    else if (named === 'subagent_usage') detail = parts(row.role, row.subagent_usage?.agent, row.subagent_usage?.outcome)
    else if (named) detail = row.role ?? ''
    else if (event === 'envelope') detail = parts(row.role, row.parsed?.status, ...(Array.isArray(row.defects) ? row.defects : []), row.error?.message ?? row.error) || 'envelope details not recorded'
    else if (event === 'seat-turn') detail = parts(row.role, row.model, row.seconds != null ? `${row.seconds}s` : null, row.tool_calls != null ? `${row.tool_calls} tool calls` : null, row.stop_reason, row.status, row.usage?.totalTokens != null ? `${row.usage.totalTokens} tokens` : row.unmeasured?.usage ?? 'usage not recorded')
    else if (event === 'builder-continue' || event === 'lead-bound-refund') detail = parts(row.id, row.progressTurns != null ? `${row.progressTurns} progress turns` : null) || 'progress not recorded'
    else if (event === 'tier-raised') detail = parts(row.from, row.to, row.reason) || 'tier change not recorded'
    else if (event === 'roster') detail = parts(row.tier, ...Object.keys(row.seats ?? {})) || 'roster not recorded'
    else if (event === 'commit') detail = parts(row.head) || 'head not recorded'
    else if (event === 'finish-ready') detail = parts(row.status, row.head) || 'finish details not recorded'
    else if (event === 'finish-decision') detail = parts(row.choice) || 'choice not recorded'
    else if (event === 'memory-empty') detail = parts(row.role, row.reason) || 'memory reason not recorded'
    else if (row.event === 'check') detail = `${row.check ?? 'check'}: ${leanCheckStatus(row).label}`
    else if (row.event === 'stage-end') {
      const outcome = row.outcome
      if (typeof outcome?.status === 'string' && outcome.status.trim()) detail = outcome.status
      else if (typeof outcome?.code === 'number') detail = `exit ${outcome.code}`
      else if (outcome?.halt) detail = parts(outcome.halt.status || 'stopped', outcome.halt.reason)
      else if (outcome?.held) detail = parts('held', outcome.held.reason)
      else if (outcome?.envelope) detail = typeof outcome.envelope.status === 'string' && outcome.envelope.status.trim() ? parts(outcome.envelope.role, outcome.envelope.status) : 'envelope records no status'
      else if (outcome?.threw) detail = parts('threw', outcome.threw.message)
      else detail = outcome == null ? 'outcome not recorded' : 'outcome records no status'
    }
    else if (row.event === 'verdict') detail = parts(row.status, row.verdict, row.reason, row.observation) || 'verdict fields not recorded'
    else if (row.event === 'pr') {
      detail = row.pr?.url ?? (row.pr?.number != null ? `#${row.pr.number}` : 'pull request not recorded')
      if (row.actor === 'operator') detail += ' · recorded by operator · hand-finished'
    }
    return { index: row.index, event, stage, detail }
  })
}

export function leanView(run = {}, journal = null) {
  return {
    lane: run.goal ?? null, status: leanStatus(run), stage: run.latest_stage ?? null,
    stageReason: run.latest_stage ? null : 'no stage recorded',
    seats: Array.isArray(run.seats) ? run.seats : [],
    lines: journalLines(journal?.rows),
    pr: run.pr ?? null,
    pending: Object.entries(run.pending ?? {}).map(([field, reason]) => ({ field, reason })),
  }
}

const displayName = value => typeof value === 'string' && value ? value.replaceAll(/[_-]/g, ' ') : 'Not recorded'
export function leanStageStatus(value) {
  if (value==='green') return {label:'Checks passed',tone:'ok'}
  if (value==='red') return {label:'Checks failed',tone:'fail'}
  if (value==='done') return {label:'Stage ended',tone:'ok'}
  if (['ok','pass','passed','done','completed','success','reviewed'].includes(value)) return { label: displayName(value), tone:'ok' }
  if (['failed','fail','error'].includes(value)) return { label:displayName(value),tone:'fail' }
  if (['stopped','blocked','escalated','changes-needed'].includes(value)) return {label:displayName(value),tone:'attention'}
  if (value==='escalate') return {label:'Escalated',tone:'attention'}
  if (value==='held') return {label:'Held',tone:'attention'}
  if (value==='insufficient') return {label:'Insufficient',tone:'attention'}
  if (value==='unmeasured') return {label:'Unmeasured',tone:'quiet'}
  if (value==='unknown') return {label:'Outcome unknown',tone:'quiet'}
  if (value==='running') return {label:'No stage-end record',tone:'quiet'}
  if (value==='skipped') return {label:'Skipped',tone:'quiet'}
  return {label:value ? displayName(value) : 'Outcome not recorded',tone:'quiet'}
}
export function leanOutcome(run = {}) {
  if (run.status==='ready-for-operator') return {headline:'Ready for an operator decision',next:'Use crew finish <lane> to accept, return or abandon.',tone:'attention',icon:'alert'}
  if (run.status==='returned') return {headline:'Returned; no new run recorded',next:'Inspect the recorded decision before continuing.',tone:'attention',icon:'alert'}
  if (run.status==='abandoned') return {headline:'Task abandoned by an operator',next:'Inspect the recorded decision; the lane stays in Needs attention until it is archived.',tone:'attention',icon:'alert'}
  if (run.status==='done') return {headline:run.hand_finished?'Task finished by an operator':'Task finished',next:run.pr?'Review the recorded pull request and its checks. Merge status is not recorded here.':'Inspect the recorded stages and outputs before accepting the result.',tone:'ok',icon:'check'}
  if (run.status==='stopped') return {headline:'Task stopped',next:'Inspect the recorded reason and latest checks before deciding how to continue.',tone:'attention',icon:'pause'}
  if (run.status==='running' || run.status==='reviewed') return {headline:run.status==='reviewed'?'Review recorded; task still open':'No terminal outcome recorded',next:'Inspect the last recorded stage. This journal does not establish whether agents are still active.',tone:'quiet',icon:'info'}
  return {headline:'Outcome not recorded',next:'Refresh the journal or inspect the recorded sessions for more evidence.',tone:'quiet',icon:'info'}
}
export function leanPullRequestUrl(pr) {
  try {const url=new URL(pr?.url);return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null}catch{return null}
}
export const leanLabel = displayName

export function leanCheckStatus(check = {}) {
  const result=check.result
  if(result?.accepted===true){const state=leanStageStatus(result.result?.status);return {label:`Baseline accepted · ${state.label.toLowerCase()}`,tone:state.tone==='fail'?'attention':state.tone}}
  if(result?.accepted===false)return {label:'Baseline rejected',tone:'fail'}
  if(result?.status)return leanStageStatus(result.status)
  if(Number.isFinite(result?.code))return {label:`Exit code ${result.code} recorded`,tone:result.code===0?'quiet':'fail'}
  return {label:'Outcome not recorded',tone:'quiet'}
}
