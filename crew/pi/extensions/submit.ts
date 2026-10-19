import { randomBytes } from 'node:crypto'
import { existsSync, renameSync as fsRenameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logLine, parseAssignment } from '../../driver.mjs'
// lean: load the full drive module once per pi seat for shared base validation; extract a shared validator only if startup cost becomes material
import { envelopeDefect } from '../../drive.mjs'

function strictIdentityDefect(envelope: any, assignment: any): any {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { reason: 'status-kind', why: 'envelope must be an object' }
  if (typeof envelope.status !== 'string') return { reason: 'status-kind', why: 'status must be a string' }
  if (envelope.assignment_id !== assignment.id) return { reason: 'assignment-id-mismatch', why: 'assignment_id does not match this assignment' }
  if (envelope.role !== assignment.role) return { reason: 'role-mismatch', why: 'role does not match this assignment' }
  if (assignment.runId !== null && (typeof envelope.run_id !== 'string' || !envelope.run_id.trim() || envelope.run_id !== assignment.runId)) {
    return { reason: 'run-mismatch', why: 'run_id does not match this assignment' }
  }
  return null
}

function textResult(text: string, details: any = {}) {
  return { content: [{ type: 'text', text }], details }
}

function atomicWrite(assignment: any, envelope: any, io: any = {}) {
  const tempPath = `${assignment.returnPath}.${randomBytes(8).toString('hex')}.tmp`
  const renameSync = io.renameSync || fsRenameSync
  try {
    writeFileSync(tempPath, `${JSON.stringify(envelope)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(tempPath, assignment.returnPath)
  } finally {
    try { unlinkSync(tempPath) } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
  }
}

export const SUBMIT_REFUSAL_REASONS = Object.freeze(['status-kind', 'assignment-id-mismatch', 'role-mismatch', 'run-mismatch', 'no-envelope', 'summary', 'artifacts', 'details'])
export function createSubmitTool(state: any, io: any = {}) {
  return {
    name: 'submit_envelope',
    label: 'Submit return envelope',
    description: 'Validate and atomically submit this assignment ReturnEnvelope. artifacts: absolute paths of task-dir files you wrote, never the return file; repo edits are read from git.',
    parameters: { type: 'object', properties: { envelope: { type: 'object', additionalProperties: true } }, required: ['envelope'], additionalProperties: true },
    async execute(_toolCallId: string, params: any) {
      const assignment = state.assignment
      if (!assignment) return textResult('refused: no active assignment', { reason: 'no-assignment' })
      const envelope = params?.envelope
      const identityDefect = strictIdentityDefect(envelope, assignment)
      const shapeDefect = identityDefect ? null : envelopeDefect(envelope, { envelope_fields: [] })
      const defect = identityDefect || shapeDefect
      const attempt = state.failures + 1
      const journal = (outcome: string, reason: string | null, why: string | null = null) => {
        const listed = reason !== null && SUBMIT_REFUSAL_REASONS.includes(reason) ? reason : null
        logLine(
          join(dirname(process.env.CREW_TASK_DIR || assignment.taskDir), 'journal.jsonl'),
          { at: new Date().toISOString(), event: 'submit_envelope', submit_envelope: { id: assignment.id, role: assignment.role, outcome, reason: listed, ...(reason !== null && listed === null ? { reason_unmeasured: 'unlisted-defect' } : {}), why: outcome === 'refused' || outcome === 'overridden' ? why : null, attempt } },
        )
      }
      if (defect) {
        state.failures = attempt
        const failures = state.failures
        if (failures >= 3) {
          try {
            atomicWrite(assignment, envelope, io)
          } catch (error: any) {
            journal('write-error', defect.reason)
            return textResult(`submission write failed: ${error?.message || String(error)}`, { reason: 'write-error' })
          }
          journal('overridden', defect.reason, defect.why)
          return textResult(`submitted after three refusals; driver may refuse this envelope (${defect.reason})`, { reason: defect.reason, why: defect.why, submit_overridden: true })
        }
        journal('refused', defect.reason, defect.why)
        return textResult(`refused: ${defect.why}`, { reason: defect.reason, why: defect.why, attempt })
      }
      state.failures = 0
      try {
        atomicWrite(assignment, envelope, io)
      } catch (error: any) {
        journal('write-error', null)
        return textResult(`submission write failed: ${error?.message || String(error)}`, { reason: 'write-error' })
      }
      journal('submitted', null)
      return textResult('ReturnEnvelope submitted', { submitted: true })
    },
  }
}

export function attachSubmit(pi: any, io: any = {}) {
  const state: any = { assignment: null, failures: 0, nudged: false }
  pi.registerTool(createSubmitTool(state, io))
  // Idea credit: the submit-envelope tool follows oh-my-pi's yield tool; no oh-my-pi source is copied, ideas only.
  pi.on('before_agent_start', (event: any) => {
    const assignment = parseAssignment(event?.prompt)
    if (!assignment) {
      state.assignment = null
      state.failures = 0
      state.nudged = false
      return
    }
    const previous = state.assignment
    if (!previous || previous.id !== assignment.id || previous.returnPath !== assignment.returnPath || previous.runId !== assignment.runId) {
      state.assignment = assignment
      state.failures = 0
      state.nudged = false
    } else state.assignment = assignment
  })
  pi.on('agent_before_settle', (event: any) => {
    const assignment = state.assignment
    if (!assignment || state.nudged || existsSync(assignment.returnPath)) return
    state.nudged = true
    logLine(join(dirname(process.env.CREW_TASK_DIR || assignment.taskDir), 'journal.jsonl'), {
      event: 'submit_nudge', submit_nudge: { id: assignment.id, role: assignment.role },
    })
    return {
      entries: [{ type: 'custom_message', customType: 'submit_nudge', content: `no envelope was submitted for ASSIGNMENT ${assignment.id}; if the work is unfinished, finish it and submit done — use insufficient only for a gap you cannot close yourself; then call submit_envelope`, display: true }],
      continue: true,
    }
  })
}

export default attachSubmit
