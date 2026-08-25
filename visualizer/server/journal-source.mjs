import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { JOURNAL_CHANNELS } from '../../crew/drive.mjs'

function validSegment(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function createJournalSource({ crewRoot = join(homedir(), '.crew') } = {}) {
  const root = resolve(crewRoot)
  function readJournal({ repo_slug, task_slug, adw_id } = {}) {
    const empty = { dir: null, verified: false, rows: [], skipped_malformed: 0, skipped_line_numbers: [], channels: JOURNAL_CHANNELS, degraded: false }
    if (!validSegment(repo_slug) || !validSegment(task_slug)) return { ...empty, error: 'invalid repo_slug or task_slug' }
    const parent = resolve(root, repo_slug)
    const candidateRoot = resolve(parent, task_slug)
    if (!parent.startsWith(`${root}${sep}`) || !candidateRoot.startsWith(`${root}${sep}`)) return { ...empty, error: 'invalid repo_slug or task_slug' }
    let candidates = []
    try { if (statSync(candidateRoot).isDirectory()) candidates.push(candidateRoot) } catch {}
    try {
      for (const name of readdirSync(parent)) {
        if (!name.startsWith(`${task_slug}.archive-`)) continue
        const path = join(parent, name)
        try { if (statSync(path).isDirectory()) candidates.push(path) } catch {}
      }
    } catch {}
    candidates = [...new Set(candidates)].sort()
    if (!candidates.length) return { ...empty, error: 'no task directory for this run' }

    let chosen = null, chosenVerified = false, hasRun = false
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i]
      const runPath = join(candidate, 'ledger', 'run.json')
      if (!existsSync(runPath)) continue
      hasRun = true
      const run = readJson(runPath)
      if (run && run.adw_id === adw_id) { chosen = candidate; chosenVerified = true; break }
    }
    if (!chosen && !hasRun) { chosen = candidates.at(-1); chosenVerified = false }
    if (!chosen) return { ...empty, error: 'no task directory for this run' }

    const result = { ...empty, dir: chosen, verified: chosenVerified }
    let text = ''
    try { text = readFileSync(join(chosen, 'journal.jsonl'), 'utf8') } catch (err) { result.degraded = true; result.error = err.message; return result }
    const rows = []
    let skipped_malformed = 0
    const skipped_line_numbers = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { skipped_malformed += 1; skipped_line_numbers.push(i + 1); continue }
      if (!row || typeof row !== 'object' || Array.isArray(row)) { skipped_malformed += 1; skipped_line_numbers.push(i + 1); continue }
      rows.push({ ...row, index: rows.length, line_number: i + 1, channel: row.channel ?? null })
    }
    result.rows = rows
    result.skipped_malformed = skipped_malformed
    result.skipped_line_numbers = skipped_line_numbers
    return result
  }
  return { readJournal, health: () => ({ crew_root: root, readonly: true }) }
}
