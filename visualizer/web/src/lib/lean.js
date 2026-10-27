// Pure presentation for lean lanes (ADR-052). Lean lanes record no heartbeat or usage and date only their
// run-start: every unrecorded value is shown absent with the reason the server gave, never guessed.
import { leanStatus } from './fleet.js'

// Journal rows → recorded-order lines. No time is read or invented.
export function journalLines(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const stage = row.stage ?? '—'
    let detail = ''
    if (row.event === 'check') detail = `${row.check ?? 'check'}: ${leanCheckStatus(row).label}`
    else if (row.event === 'stage-end') detail = row.outcome?.status ?? (row.outcome?.code != null ? `exit ${row.outcome.code}` : 'outcome not recorded')
    else if (row.event === 'verdict') detail = [row.status, row.verdict, row.reason].filter((part) => typeof part === 'string' && part).join(' · ') || 'verdict fields not recorded'
    else if (row.event === 'pr') {
      detail = row.pr?.url ?? (row.pr?.number != null ? `#${row.pr.number}` : 'pull request not recorded')
      if (row.actor === 'operator') detail += ' · recorded by operator · hand-finished'
    }
    return { index: row.index, event: row.event ?? 'unknown', stage, detail }
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
  if (value==='running') return {label:'No stage-end record',tone:'quiet'}
  if (value==='skipped') return {label:'Skipped',tone:'quiet'}
  return {label:value ? displayName(value) : 'Outcome not recorded',tone:'quiet'}
}
export function leanOutcome(run = {}) {
  if (run.status==='done') return {headline:run.hand_finished?'Task finished by an operator':'Task finished',next:run.pr?'Review the recorded pull request and its checks. Merge status is not recorded here.':'Inspect the recorded stages and outputs before accepting the result.',tone:'ok',icon:'check'}
  if (run.status==='stopped') return {headline:'Task stopped',next:'Inspect the recorded reason and latest checks before deciding how to continue.',tone:'attention',icon:'pause'}
  if (['failed','error'].includes(run.status)) return {headline:'Task failed',next:'Inspect the failed stage and its evidence before retrying.',tone:'fail',icon:'alert'}
  if (['blocked','escalated'].includes(run.status)) return {headline:'Task needs attention',next:'Review the recorded reason and stage evidence to decide the next action.',tone:'attention',icon:'alert'}
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
