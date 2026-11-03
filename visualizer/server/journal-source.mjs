import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function validSegment(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

export function createJournalSource({ crewRoot = join(homedir(), '.crew'), lean = null } = {}) {
  const root = resolve(crewRoot)
  function readJournal({ repo_slug, task_slug, adw_id } = {}) {
    const empty = { dir: null, verified: false, rows: [], skipped_malformed: 0, skipped_line_numbers: [], degraded: false }
    if (!validSegment(repo_slug) || !validSegment(task_slug)) return { ...empty, error: 'invalid repo_slug or task_slug' }
    const identity = lean?.identify({ repo_slug, task_slug, adw_id })
    if (!identity?.lean) return { ...empty, error: 'only lean lanes have journals' }
    if (identity.error) return { ...empty, error: identity.error }
    const read = lean.readJournalRows(identity.lane)
    const result = { ...empty, dir: identity.lane.dir, verified: true, rows: read.rows, skipped_malformed: read.skipped_malformed, skipped_line_numbers: read.skipped_line_numbers }
    if (read.error) { result.degraded = true; result.error = read.error }
    return result
  }
  return { readJournal, health: () => ({ crew_root: root }) }
}
