import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

function validSegment(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function createReturnsSource({ crewRoot = join(homedir(), '.crew') } = {}) {
  const root = resolve(crewRoot)
  function listEnvelopes({ repo_slug, task_slug, adw_id } = {}) {
    const empty = { dir: null, verified: false, envelopes: [], task: null }
    if (!validSegment(repo_slug) || !validSegment(task_slug)) return { ...empty, error: 'invalid repo_slug or task_slug' }
    const parent = resolve(root, repo_slug)
    const candidateRoot = resolve(parent, task_slug)
    if (!parent.startsWith(`${root}${sep}`) || !candidateRoot.startsWith(`${root}${sep}`)) return { ...empty, error: 'invalid repo_slug or task_slug' }
    let candidates = []
    try {
      if (statSync(candidateRoot).isDirectory()) candidates.push(candidateRoot)
    } catch {}
    try {
      for (const name of readdirSync(parent)) {
        if (!name.startsWith(`${task_slug}.archive-`)) continue
        const path = join(parent, name)
        try { if (statSync(path).isDirectory()) candidates.push(path) } catch {}
      }
    } catch {}
    candidates = [...new Set(candidates)].sort()
    if (!candidates.length) return { ...empty, error: 'no task directory for this run' }

    // #718: a candidate whose ledger/run.json names a DIFFERENT run is still a
    // task directory that exists on disk. It used to set a run marker, which disabled
    // the unverified fallback below, so the route denied a directory it had just
    // read — while a candidate with NO run.json was returned with verified:false.
    // More information must never produce a worse answer than less. The absence
    // reported at line 33 (no candidate directory at all) is now the only one
    // this route can claim, and it is always true. An omitted adw_id — '' from
    // server.mjs:339 — is a legitimate "any run" query and lands here too: the
    // newest candidate, verified:false.
    let chosen = null, chosenVerified = false
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i]
      const run = readJson(join(candidate, 'ledger', 'run.json'))
      if (run && run.adw_id === adw_id) { chosen = candidate; chosenVerified = true; break }
    }
    if (!chosen) { chosen = candidates.at(-1); chosenVerified = false }

    const result = { ...empty, dir: chosen, verified: chosenVerified, envelopes: [], degraded: false, error: undefined }
    const returnsDir = join(chosen, 'returns')
    let names = []
    try { names = readdirSync(returnsDir) } catch (err) { result.degraded = true; result.error = err.message; return result }
    const entries = []
    for (const name of names) {
      if (name === 'task.json') { result.task = readJson(join(returnsDir, name)); continue }
      const match = name.match(/^d(\d+)\.([a-z][a-z0-9-]*)\.json$/)
      if (!match) continue
      const file = join(returnsDir, name)
      let bytes = null
      try { bytes = statSync(file).size } catch {}
      let body = null, valid = true, invalid_reason = null
      try {
        body = JSON.parse(readFileSync(file, 'utf8'))
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('envelope must be a JSON object')
      } catch (err) { valid = false; invalid_reason = err.message || 'invalid JSON' }
      entries.push({
        assignment_id: valid ? (body.assignment_id ?? `d${match[1]}`) : `d${match[1]}`,
        dispatch_seq: Number(match[1]), role: match[2], file, bytes,
        status: valid ? (body.status ?? null) : null,
        summary: valid ? (body.summary ?? null) : null,
        artifacts: valid ? (body.artifacts ?? null) : null,
        details: valid ? (body.details ?? null) : null,
        valid, invalid_reason,
      })
    }
    entries.sort((a, b) => a.dispatch_seq - b.dispatch_seq)
    const totals = new Map(), counts = new Map()
    for (const entry of entries) counts.set(entry.role, (counts.get(entry.role) || 0) + 1)
    for (const entry of entries) { totals.set(entry.role, (totals.get(entry.role) || 0) + 1); entry.attempt = totals.get(entry.role); entry.attempts_total = counts.get(entry.role) }
    result.envelopes = entries
    return result
  }
  return { listEnvelopes, health: () => ({ crew_root: root, readonly: true }) }
}
