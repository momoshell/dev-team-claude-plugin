// Pure presentation for lean lanes (ADR-052). Lean lanes record no heartbeat or usage and date only their
// run-start: every unrecorded value is shown absent with the reason the server gave, never guessed.
import { leanStatus } from './fleet.js'

// Journal rows → recorded-order lines. No time is read or invented.
export function journalLines(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const stage = row.stage ?? '—'
    let detail = ''
    if (row.event === 'check') detail = `${row.check ?? 'check'}: ${row.result?.status ?? 'result not recorded'}`
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
