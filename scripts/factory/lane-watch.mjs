#!/usr/bin/env node
// scripts/factory/lane-watch.mjs — the tier-0 lane watchdog: a BOUNDED pass over
// live crew directories that records what an orchestrator otherwise hand-rebuilds
// with a shell monitor and `uptime`.

// JOURNAL LINES ONLY
// A note is a line in that crew's existing journal.jsonl. No ledger table, no
// schema change, no new column. The watchdog is unproven; committing schema to
// it before it has earned anything is the wrong order.

// NEVER ACTS
// It observes and records. It does not signal, kill, tear down, reseat, write to
// a seat, or touch GitHub. A watchdog that can act is a second authority over a
// running crew and nothing here asks for one.

// SILENCE IS NOT EVIDENCE
// Measured 2026-08-19: lane b37-percheck-proof sat 645 seconds with a silent
// journal while its planner wrote a 29,589-byte gate.mjs touched 48 seconds
// earlier. The driver journals STAGES, not a seat's in-progress writes. So the
// wedged predicate is silence AND artifact mtimes not advancing.

import { existsSync as fsExistsSync, appendFileSync as fsAppendFileSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs'
import { homedir, loadavg as osLoadavg, cpus as osCpus } from 'node:os'
import { join } from 'node:path'

export const NOTE_KINDS = Object.freeze(['silent-lane', 'host-load', 'final-round'])
export const WATCH_EVENT = 'lane-watch'

// Defaults, each with a measured basis rather than a guess:
// silence_s 300 — the false-positive episode ran 645s with a 48s-old artifact,
//   so 300 catches a real stall while the conjunction spares a thinking seat.
// load_per_core 4 — measured four-lane batches peak near load 23 on a 10-core
//   host (2.3 per core); the saturation incident hit 291 (29 per core). 4 sits
//   between the two measurements.
export const WATCH_DEFAULTS = Object.freeze({ silence_s: 300, load_per_core: 4 })

// A lane past these is finished, not wedged: it will be silent forever and a
// note every pass would be a guaranteed false positive.
export const TERMINAL_STAGES = Object.freeze(['done', 'converge'])
// stage head -> the limits key that budgets it.
export const BUDGET_KEYS = Object.freeze({ plan: 'plan_rounds', build: 'build_rounds', review: 'review_rounds' })

export function normalDeps(deps = {}) {
  return {
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    readdirSync: deps.readdirSync || fsReaddirSync,
    statSync: deps.statSync || fsStatSync,
    appendFileSync: deps.appendFileSync || fsAppendFileSync,
    loadavg: deps.loadavg || osLoadavg,
    cpus: deps.cpus || osCpus,
    platform: deps.platform || process.platform,
    now: deps.now || (() => Date.now()),
  }
}

export function crewRoot({ home } = {}) {
  return join(home ?? homedir(), '.crew')
}

// `at` is EITHER epoch ms (drive.mjs stage lines: io.now()) or an ISO string
// (crew.mjs and seat-io.mjs events). Both are live in every real journal.
export function journalAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

export function readJournal(path, deps = {}) {
  const d = normalDeps(deps)
  let text = ''
  try { text = d.readFileSync(path, 'utf8') } catch { return { lines: [], lastActivityAt: null, lastStage: null, limits: null, notes: [] } }
  const lines = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try { lines.push(JSON.parse(raw)) } catch { /* an unparseable line is not activity */ }
  }
  let lastActivityAt = null
  let lastStage = null
  let limits = null
  const notes = []
  for (const line of lines) {
    if (line.event === WATCH_EVENT) { notes.push(line); continue }
    const at = journalAt(line.at)
    // The watchdog must never count its OWN notes as lane activity, or it
    // silences itself after the first pass.
    if (at !== null && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at
    if (typeof line.stage === 'string') lastStage = line.stage
    if (line.event === 'limits') limits = line
  }
  return { lines, lastActivityAt, lastStage, limits, notes }
}

export function latestArtifactMs(taskDir, deps = {}) {
  const d = normalDeps(deps)
  let newest = null
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try { entries = d.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) { walk(p, depth + 1); continue }
      let st
      try { st = d.statSync(p) } catch { continue }
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
    }
  }
  walk(taskDir, 0)
  return newest
}

// crew/crew.mjs:1623 mints an archive as `${paths.dir}.archive-${stamp}` and
// crew.mjs:1530 recognises one by that same marker; this is that recogniser, one
// layer down. A live slug can never carry a dot (crew/slug.mjs:13 strips every
// character outside [a-z0-9-]), so the marker cannot collide with a real lane.
export const ARCHIVE_MARKER = '.archive-'

// The base task slug of an archived lane directory, or null for a live one. An
// archive is a FINISHED run: a record to read, never a watch target to write.
export function archivedLaneName(name) {
  const at = name.indexOf(ARCHIVE_MARKER)
  if (at <= 0) return null
  return { task: name.slice(0, at), archivedAt: name.slice(at + ARCHIVE_MARKER.length) }
}

// ONE walk, one meaning of "a lane": every candidate is classified here and
// the two views below only filter it. No second discovery path, no cache.
function walkLanes(root, d) {
  const lanes = []
  let repos
  try { repos = d.readdirSync(root, { withFileTypes: true }) } catch { return lanes }
  for (const repo of repos.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    let tasks
    try { tasks = d.readdirSync(join(root, repo.name), { withFileTypes: true }) } catch { continue }
    for (const task of tasks.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const dir = join(root, repo.name, task.name)
      if (!d.existsSync(join(dir, 'crew.json')) || !d.existsSync(join(dir, 'journal.jsonl'))) continue
      const archive = archivedLaneName(task.name)
      lanes.push({
        id: `${repo.name}/${task.name}`,
        repo: repo.name,
        task: archive ? archive.task : task.name,
        dir,
        journal: join(dir, 'journal.jsonl'),
        taskDir: join(dir, 'task'),
        settled: d.existsSync(join(dir, 'returns', 'task.json')),
        archived: archive !== null,
        archivedAt: archive ? archive.archivedAt : null,
      })
    }
  }
  return lanes
}

// LIVE lanes only. An archived directory is a rename of a live one, so it still
// holds crew.json + journal.jsonl and satisfied every predicate here — which is
// how the watchdog came to append notes to 243 finished runs (#417).
export function discoverLanes(root, deps = {}) {
  return walkLanes(root, normalDeps(deps)).filter((lane) => !lane.archived)
}

// The archived counterpart, for a caller that must REPORT on a lane that has
// since been torn down. Same walk, opposite view; nothing here writes.
export function archivedLanes(root, deps = {}) {
  return walkLanes(root, normalDeps(deps)).filter((lane) => lane.archived)
}

export function laneActive(lane, journal) {
  if (lane.settled) return false
  const stage = journal.lastStage
  if (typeof stage !== 'string') return true
  if (TERMINAL_STAGES.includes(stage)) return false
  return !stage.startsWith('escalate:')
}

export function hostLoad({ threshold, deps = {} } = {}) {
  const d = normalDeps(deps)
  if (d.platform === 'win32') return null
  let load_1m
  let coreList
  try { load_1m = d.loadavg()?.[0] } catch { return null }
  try { coreList = d.cpus() } catch { return null }
  if (typeof load_1m !== 'number' || !Number.isFinite(load_1m) || load_1m < 0) return null
  if (!Array.isArray(coreList) || coreList.length === 0) return null
  const cores = coreList.length
  const perCore = Number((load_1m / cores).toFixed(2))
  if (!(perCore > threshold)) return null
  return { note: 'host-load', load_1m, cores, per_core: perCore, threshold, basis: 'os.loadavg()[0] / os.cpus().length' }
}

export function roundNote(journal) {
  const stage = journal.lastStage
  if (typeof stage !== 'string') return null
  const m = /^(plan|build|review):r([0-9]+)$/.exec(stage)
  if (!m) return null
  const phase = m[1]
  const round = Number(m[2])
  const limits = journal.limits
  // The budget is read from the run's recorded limits event, never from a
  // LIMITS default a --plan-rounds flag overrides.
  if (!limits) return null
  const budget = limits[BUDGET_KEYS[phase]]
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return null
  if (!(round >= budget)) return null
  return { note: 'final-round', phase, round, budget, source: limits.source?.[BUDGET_KEYS[phase]] ?? 'unknown' }
}

export function silenceNote({ journal, artifactMs, now, silenceS }) {
  const silenceMs = silenceS * 1000
  const journalAgeMs = journal.lastActivityAt === null ? null : now - journal.lastActivityAt
  const artifactAgeMs = artifactMs === null ? null : now - artifactMs
  const journalSilent = journalAgeMs !== null && journalAgeMs >= silenceMs
  // THE CONJUNCTION. Silence alone is a measured false positive.
  const artifactStale = artifactAgeMs === null || artifactAgeMs >= silenceMs
  if (!journalSilent || !artifactStale) return null
  return {
    note: 'silent-lane',
    silent_s: Math.floor(journalAgeMs / 1000),
    artifact_age_s: artifactAgeMs === null ? null : Math.floor(artifactAgeMs / 1000),
    threshold_s: silenceS,
    last_stage: journal.lastStage,
  }
}

// The dedup key: one note per (kind, phase/round, journal epoch). A repeated
// bounded pass over an unchanged lane appends nothing.
export function noteKey(note, journal) {
  return [note.note, journal.lastActivityAt ?? 'none', note.phase ?? '', note.round ?? ''].join('|')
}

export function alreadyNoted(previous, note) {
  return previous.some((p) => p.key === note.key)
}

function appendNote(lane, note, deps) {
  const d = normalDeps(deps)
  const line = { at: new Date(note.__at).toISOString(), event: WATCH_EVENT, lane: lane.id, task: lane.task, repo: lane.repo, ...note }
  delete line.__at
  d.appendFileSync(lane.journal, JSON.stringify(line) + '\n')
  return line
}

// A bounded pass. The caller repeats it; nothing here loops, sleeps, or lives on.
export function watchPass({ root, now, silenceS, loadThreshold, deps = {} } = {}) {
  const d = normalDeps(deps)
  const at = typeof now === 'number' ? now : d.now()
  const silence = typeof silenceS === 'number' ? silenceS : WATCH_DEFAULTS.silence_s
  const threshold = typeof loadThreshold === 'number' ? loadThreshold : WATCH_DEFAULTS.load_per_core
  const watchRoot = root || crewRoot()
  const lanes = discoverLanes(watchRoot, d)
  const load = hostLoad({ threshold, deps: d })
  const written = []
  const watched = []

  for (const lane of lanes) {
    const journal = readJournal(lane.journal, d)
    if (!laneActive(lane, journal)) continue
    watched.push(lane.id)
    const artifactMs = latestArtifactMs(lane.taskDir, d)
    const laneNotes = []
    const silent = silenceNote({ journal, artifactMs, now: at, silenceS: silence })
    if (silent) laneNotes.push(silent)
    if (load) laneNotes.push({ ...load })
    const round = roundNote(journal)
    if (round) laneNotes.push(round)
    for (const note of laneNotes) note.key = noteKey(note, journal)
    // A lane with nothing to report gets nothing — never an all-clear line.
    if (laneNotes.length === 0) continue
    const previous = journal.notes
    for (const note of laneNotes) {
      if (alreadyNoted(previous, note)) continue
      written.push(appendNote(lane, { ...note, __at: at }, d))
    }
  }
  return { at: new Date(at).toISOString(), root: watchRoot, lanes: watched, notes: written }
}
