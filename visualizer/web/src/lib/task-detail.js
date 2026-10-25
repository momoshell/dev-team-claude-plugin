import { deriveDisplayStatus } from './fleet.js'

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null
const sequence = (row) => Number.isSafeInteger(row?.dispatch_seq) && row.dispatch_seq >= 0 ? row.dispatch_seq : null

// Folder fallbacks are useful for diagnosis, but cannot establish this run's outcome.
export function verifiedTaskReturns(payload = {}) {
  if (payload?.verified !== true || payload?.degraded === true) return { envelopes: [], task: null }
  return {
    ...payload,
    envelopes: (Array.isArray(payload.envelopes) ? payload.envelopes : []).filter((row) => row?.valid === true),
    task: payload.task && typeof payload.task === 'object' && !Array.isArray(payload.task) && typeof payload.task.status === 'string' ? payload.task : null,
  }
}

export function taskDetailSummary(run = {}, payload = {}, now = Date.now()) {
  const evidence = verifiedTaskReturns(payload)
  const ordered = evidence.envelopes.filter((row) => sequence(row) !== null).sort((a, b) => sequence(a) - sequence(b))
  const report = ordered.filter((row) => text(row.summary) && row.role === 'builder').at(-1)
    ?? ordered.filter((row) => text(row.summary)).at(-1) ?? null
  const review = ordered.filter((row) => row.role === 'reviewer' && text(row.details?.verdict)).at(-1) ?? null
  const status = deriveDisplayStatus(run, evidence.task, now)
  const actions = {
    success: ['Task completed', 'Inspect the delivered work and verification evidence.', 'verification'],
    ok: ['Task completed', 'Inspect the delivered work and verification evidence.', 'verification'],
    escalated: ['A decision is needed', 'Read the recorded escalation and acceptance evidence before deciding how to continue.', 'verification'],
    failed: ['Task failed', 'Inspect the last phase and its returned evidence to understand the failure.', 'activity'],
    fail: ['Task failed', 'Inspect the last phase and its returned evidence to understand the failure.', 'activity'],
    aborted: ['Task stopped', 'Inspect the last recorded phase before starting another attempt.', 'activity'],
    unverified: ['Completion is not confirmed', 'Refresh the records, then inspect runtime details if the task remains unsettled.', 'details'],
    silent: ['Activity needs checking', 'Refresh the records and inspect the last heartbeat before treating this task as active.', 'details'],
    gone: ['The driver is no longer present', 'Inspect the recorded runtime state and the available reconciliation command.', 'details'],
    contradicted: ['The records disagree', 'Inspect the runtime details: the ledger is open but the task directory was archived.', 'details'],
    running: ['Work is in progress', 'Follow the phase history. A final task outcome has not been recorded.', 'activity'],
    queued: ['Waiting to start', 'Inspect the recorded activity for progress. No completion is established yet.', 'activity'],
  }
  const [headline, next, target] = actions[status.key] ?? ['Outcome needs inspection', 'Inspect the task records; the available evidence does not establish an outcome.', 'details']
  const files = [...new Set(ordered.flatMap((row) => row.role === 'builder' && Array.isArray(row.details?.files_changed) ? row.details.files_changed.filter((path) => text(path)) : []))]
  const decision = status.key === 'escalated' ? text(evidence.task?.details?.escalation?.question?.prompt) : null
  const reason = text(status.why)
  const reasonPreview = reason && reason.length > 260 ? reason.slice(0, 257).trimEnd() + '…' : reason
  const reportText = text(report?.summary)
  const reportPreview = reportText && reportText.length > 420 ? reportText.slice(0, 417).replace(/\s+\S*$/, '') + '…' : reportText
  return { status, reportPreview, headline, next: decision ?? next, target, reasonPreview, report, review, files, identityVerified: payload?.verified === true && payload?.degraded !== true }
}
