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

export const STEP_TITLE_REASONS = Object.freeze(['plan-text-unreadable','plan-text-has-no-step-titles'])
export const ACCEPTANCE_REASONS = Object.freeze(['brief-path-not-journaled','brief-outside-crew-root','brief-unreadable','brief-has-no-acceptance-text'])

export function createJournalSource({ crewRoot = join(homedir(), '.crew') } = {}) {
  const root = resolve(crewRoot)
  function readJournal({ repo_slug, task_slug, adw_id } = {}) {
    const empty = { dir: null, verified: false, rows: [], skipped_malformed: 0, skipped_line_numbers: [], channels: JOURNAL_CHANNELS, degraded: false, plan: { chunks: null, absent: 'plan-not-accepted' }, step_titles: null, step_titles_reason: 'plan-text-unreadable', acceptance: null, acceptance_reason: 'brief-path-not-journaled' }
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
    try {
      const acceptedPlan = JSON.parse(readFileSync(join(chosen, 'task', 'plan.accepted.envelope.json'), 'utf8'))
      if (!acceptedPlan || typeof acceptedPlan !== 'object' || Array.isArray(acceptedPlan)) result.plan.absent = 'plan-unreadable'
      else if (!Array.isArray(acceptedPlan.details?.chunks) || acceptedPlan.details.chunks.length === 0) result.plan.absent = 'plan-has-no-chunks'
      else result.plan = { chunks: acceptedPlan.details.chunks, absent: null }
    } catch (err) { result.plan.absent = err.code === 'ENOENT' ? 'plan-not-accepted' : 'plan-unreadable' }
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
    let step_titles = null
    let step_titles_reason = 'plan-text-unreadable'
    try {
      const planText = readFileSync(join(chosen, 'task', 'plan.accepted.md'), 'utf8')
      const titles = {}
      for (const line of planText.split('\n')) {
        const match = line.match(/^### Step[ \t]+(\S+)[ \t]+—[ \t]+(.+?)\s*$/);
        if (match) titles[match[1]] = match[2].trim()
      }
      if (Object.keys(titles).length === 0) { step_titles = null; step_titles_reason = 'plan-text-has-no-step-titles' }
      else { step_titles = titles; step_titles_reason = null }
    } catch { step_titles = null; step_titles_reason = 'plan-text-unreadable' }
    result.step_titles = step_titles
    result.step_titles_reason = step_titles_reason
    let acceptance = null
    let acceptance_reason = 'brief-path-not-journaled'
    const row = [...result.rows].reverse().find((entry) => entry.event === 'batch-dir')
    if (row && typeof row.brief === 'string' && row.brief) {
      const rootPrefix = `${root}${sep}`
      const briefPath = resolve(row.brief)
      if (!briefPath.startsWith(rootPrefix) || !briefPath.endsWith('.brief.md')) { acceptance = null; acceptance_reason = 'brief-outside-crew-root' }
      else {
        let briefText = null
        try { briefText = readFileSync(briefPath, 'utf8') } catch { briefText = null }
        if (briefText === null) { acceptance = null; acceptance_reason = 'brief-unreadable' }
        else {
          const briefLines = briefText.split('\n')
          const startIndex = briefLines.findIndex((line) => line.trim() === '## Acceptance')
          const section = startIndex === -1 ? [] : briefLines.slice(startIndex + 1)
          const items = {}
          let current = null
          for (const line of section) {
            if (/^## /.test(line)) break
            const item = line.match(/^\(([^)]+)\)\s+(.*)$/)
            if (item) { current = item[1]; items[current] = item[2].trim() }
            else if (line.trim() && current) items[current] += ' ' + line.trim()
          }
          if (Object.keys(items).length === 0) { acceptance = null; acceptance_reason = 'brief-has-no-acceptance-text' }
          else { acceptance = items; acceptance_reason = null }
        }
      }
    }
    result.acceptance = acceptance
    result.acceptance_reason = acceptance_reason
    return result
  }
  return { readJournal, health: () => ({ crew_root: root, readonly: true }) }
}
