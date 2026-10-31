import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const JOURNAL_CHANNELS = Object.freeze({ record: 'record', operational: 'operational' })

function validSegment(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

export const STEP_TITLE_REASONS = Object.freeze(['plan-text-unreadable','plan-text-has-no-step-titles'])
export const ACCEPTANCE_REASONS = Object.freeze(['brief-path-not-journaled','brief-outside-crew-root','brief-unreadable','brief-has-no-acceptance-text'])

export function createJournalSource({ crewRoot = join(homedir(), '.crew'), lean = null } = {}) {
  const root = resolve(crewRoot)
  function readJournal({ repo_slug, task_slug, adw_id } = {}) {
    const empty = { dir: null, verified: false, rows: [], skipped_malformed: 0, skipped_line_numbers: [], channels: JOURNAL_CHANNELS, degraded: false, plan: { chunks: null, absent: 'plan-not-accepted' }, step_titles: null, step_titles_reason: 'plan-text-unreadable', acceptance: null, acceptance_reason: 'brief-path-not-journaled' }
    if (!validSegment(repo_slug) || !validSegment(task_slug)) return { ...empty, error: 'invalid repo_slug or task_slug' }
    const identity = lean?.identify({ repo_slug, task_slug, adw_id })
    if (!identity?.lean) return { ...empty, error: 'only lean lanes have journals' }
    if (identity.error) return { ...empty, error: identity.error }
    const read = lean.readJournalRows(identity.lane)
    const result = { ...empty, dir: identity.lane.dir, verified: true, rows: read.rows, skipped_malformed: read.skipped_malformed, skipped_line_numbers: read.skipped_line_numbers, acceptance_reason: 'lean lanes journal no brief path' }
    if (read.error) { result.degraded = true; result.error = read.error }
    result.plan = { chunks: null, absent: 'lean lanes have no accepted plan envelope' }
    result.step_titles_reason = 'lean lanes have no accepted plan text'
    return result
  }
  return { readJournal, health: () => ({ crew_root: root, readonly: true }) }
}
