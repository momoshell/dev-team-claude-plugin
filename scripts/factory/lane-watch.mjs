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

import {
  existsSync as fsExistsSync, appendFileSync as fsAppendFileSync, readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync, statSync as fsStatSync, openSync as fsOpenSync,
  readSync as fsReadSync, closeSync as fsCloseSync,
} from 'node:fs'
import { homedir, loadavg as osLoadavg, cpus as osCpus } from 'node:os'
import { join } from 'node:path'
import { LIVENESS_PROBE_MS, SEAT_LIVENESS_EVENT } from '../../crew/seat-io.mjs'
import { defaultDbPath, openLedger } from './ledger.mjs'

export { SEAT_LIVENESS_EVENT }

export const NOTE_KINDS = Object.freeze(['silent-lane', 'host-load', 'final-round', 'driver-gone'])
export const WATCH_EVENT = 'lane-watch'

// Defaults, each with a measured basis rather than a guess:
// silence_s 300 — the false-positive episode ran 645s with a 48s-old artifact,
//   so 300 catches a real stall while the conjunction spares a thinking seat.
// load_per_core 4 — measured four-lane batches peak near load 23 on a 10-core
//   host (2.3 per core); the saturation incident hit 291 (29 per core). 4 sits
//   between the two measurements.
export const WATCH_DEFAULTS = Object.freeze({ silence_s: 300, load_per_core: 4 })

// The ONE place either threshold resolves. An operator value wins; absent, the
// measured default above stands — and the ORIGIN is NAMED rather than inferred,
// so a second fallback one layer up would have to lie about it (#469). A value
// that is not a finite positive number is not a value.
export function resolveTunables({ silenceS, loadThreshold } = {}) {
  const pick = (value, fallback) => (Number.isFinite(value) && value > 0
    ? { value, origin: 'operator' }
    : { value: fallback, origin: 'default' })
  return {
    silence_s: pick(silenceS, WATCH_DEFAULTS.silence_s),
    load_per_core: pick(loadThreshold, WATCH_DEFAULTS.load_per_core),
  }
}

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
    openSync: deps.openSync || fsOpenSync,
    readSync: deps.readSync || fsReadSync,
    closeSync: deps.closeSync || fsCloseSync,
    appendFileSync: deps.appendFileSync || fsAppendFileSync,
    readSession: deps.readSession || readLaneSession,
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
  try { text = d.readFileSync(path, 'utf8') } catch { return { lines: [], lastActivityAt: null, lastStage: null, limits: null, waits: null, liveness: [], notes: [] } }
  const lines = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try { lines.push(JSON.parse(raw)) } catch { /* an unparseable line is not activity */ }
  }
  let lastActivityAt = null
  let lastStage = null
  let limits = null
  let waits = null
  const liveness = []
  const notes = []
  for (const line of lines) {
    if (line.event === WATCH_EVENT) { notes.push(line); continue }
    if (line.event === SEAT_LIVENESS_EVENT) {
      liveness.push(line)
      // A probed-no-growth reading is proof the PROBE ran, never proof the LANE
      // advanced. Counting it as activity would silence silenceNote for a wedged
      // lane whose driver is still politely probing it.
      if (line.growth !== true) continue
    }
    const at = journalAt(line.at)
    // The watchdog must never count its OWN notes as lane activity, or it
    // silences itself after the first pass.
    if (at !== null && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at
    if (typeof line.stage === 'string') lastStage = line.stage
    if (line.event === 'limits') limits = line
    if (line.event === 'waits') waits = line
  }
  return { lines, lastActivityAt, lastStage, limits, waits, liveness, notes }
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

// The heartbeat period has ONE owner (crew/seat-io.mjs:38) and this is a
// re-export, never a second copy: a watcher that hardcoded 30_000 would drift
// silently the day the probe cadence changes.
// scripts/factory/reap-stale.mjs:11 is the precedent for this import direction.
export const HEARTBEAT_PERIOD_MS = LIVENESS_PROBE_MS
// TWO periods: one missed beat is a scheduling hiccup, two is silence.
export const DRIVER_GONE_PERIODS = 2

// The run's LONGEST configured seat wait, in ms, or null when the run recorded
// none. Read off the journal's `waits` line (crew/crew.mjs:2041) rather than
// imported from crew/drive.mjs: the recorded value is the EFFECTIVE budget,
// flag or default, and it is what the seat was actually given.
export function seatWaitCeilingMs(journal) {
  const row = journal?.waits
  if (!row || typeof row !== 'object') return null
  let max = null
  for (const [key, value] of Object.entries(row)) {
    if (key === 'at' || key === 'event' || key === 'source' || key === 'channel') continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    if (max === null || value > max) max = value
  }
  return max === null ? null : max * 1000
}

// #813: a seat whose configured wait is 1800s cannot be judged silent at 60s.
// The threshold is the longest wait the driver may legitimately sit inside,
// PLUS the two-period floor, and its ORIGIN is named rather than inferred —
// the same posture resolveTunables takes at :47.
export function driverGoneThresholdMs(journal) {
  const floor = DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS
  const ceiling = seatWaitCeilingMs(journal)
  if (ceiling === null) return { ms: floor, origin: 'default' }
  return { ms: Math.max(floor, ceiling + floor), origin: 'waits' }
}

export const DRIVER_RUNNING = 'running'
export const DRIVER_GONE = 'driver-gone'
export const DRIVER_EXITED = 'exited'
export const DRIVER_UNKNOWN = 'unknown'
// The terminal line is the LAST line of run.log; a bounded tail is enough and a
// whole-file read is not — a long run's log is megabytes of seat noise.
export const RUN_LOG_TAIL_BYTES = 65_536

// The sibling `terminalRunLine` lives in crew/factoryctl.mjs:498. This copy
// keeps scripts/factory/* from depending on that non-leaf CLI module, so the
// observability path stays leaf-only.
export function runLogTerminal(lane, deps = {}) {
  const d = normalDeps(deps)
  let path
  try { path = join(lane?.dir, 'run.log') } catch { return null }
  let size
  try { size = d.statSync(path).size } catch { return null }
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null
  const start = Math.max(0, size - RUN_LOG_TAIL_BYTES)
  const amount = size - start
  let fd
  let buffer
  let failed = false
  try {
    fd = d.openSync(path, 'r')
    buffer = Buffer.alloc(amount)
    const bytesRead = d.readSync(fd, buffer, 0, amount, start)
    if (bytesRead !== amount) failed = true
  } catch { failed = true }
  finally {
    if (fd !== undefined) {
      try { d.closeSync(fd) } catch { failed = true }
    }
  }
  if (failed || buffer === undefined) return null
  let status = null
  for (const raw of buffer.toString('utf8').split('\n')) {
    try {
      const frame = JSON.parse(raw)
      if (frame && typeof frame.status === 'string') status = frame.status
    } catch { /* seat noise, torn lines and non-JSON frames are not terminal */ }
  }
  return status
}

export function readLaneSession(lane, deps = {}) {
  const dbPath = deps.defaultDbPath || defaultDbPath
  const open = deps.openLedger || openLedger
  let handle
  let failed = false
  let row = null
  try {
    handle = open({ dbPath: dbPath(), readOnly: true })
    const connection = handle?.readConnection?.()
    if (!connection) return null
    row = connection.prepare(
      'SELECT ended_at, last_heartbeat_at FROM sessions WHERE repo_slug = ? AND task_slug = ? ORDER BY started_at DESC LIMIT 1',
    ).get(lane.repo, lane.task) || null
  } catch { failed = true }
  finally {
    if (handle) {
      try { handle.close?.() } catch { failed = true }
    }
  }
  return failed ? null : row
}

export function laneLedgerView(lane, deps = {}) {
  const d = normalDeps(deps)
  let session = null
  try { session = d.readSession(lane) } catch { /* an injected read failure is unmeasured */ }
  return { session, terminal: runLogTerminal(lane, d), now: d.now() }
}

export function driverGone(lane, journal, ledger) {
  if (!laneActive(lane, journal)) return false
  const session = ledger?.session
  if (session == null) return false                  // unmeasured is never gone
  if (session.ended_at != null) return false         // the run closed its own session
  if (ledger.terminal != null) return false          // run.log already answered for this run
  const beat = journalAt(session.last_heartbeat_at)
  if (beat === null) return false                    // never measured (#297)
  if (!Number.isFinite(ledger.now)) return false
  const threshold = driverGoneThresholdMs(journal).ms
  return ledger.now - beat >= threshold
}

export function driverState(lane, journal, ledger) {
  const threshold = driverGoneThresholdMs(journal)
  if (!laneActive(lane, journal)) return { state: null, heartbeat_age_ms: null, stale_after_ms: null, threshold_origin: null }
  const terminal = ledger?.terminal
  const session = ledger?.session
  // A terminal frame is positive evidence that this run's driver exited even
  // when the read-only ledger is missing or degraded.
  if (session == null) {
    return terminal != null
      ? { state: DRIVER_EXITED, heartbeat_age_ms: null, stale_after_ms: threshold.ms, threshold_origin: threshold.origin }
      : { state: DRIVER_UNKNOWN, heartbeat_age_ms: null, stale_after_ms: threshold.ms, threshold_origin: threshold.origin }
  }
  const beat = journalAt(session.last_heartbeat_at)
  const age = beat === null || !Number.isFinite(ledger.now) ? null : ledger.now - beat
  // It is not a fresh liveness observation, so never fold terminal evidence
  // back into `running`.
  if (terminal != null) return { state: DRIVER_EXITED, heartbeat_age_ms: age, stale_after_ms: threshold.ms, threshold_origin: threshold.origin }
  if (age === null) return { state: DRIVER_UNKNOWN, heartbeat_age_ms: null, stale_after_ms: threshold.ms, threshold_origin: threshold.origin }
  if (driverGone(lane, journal, ledger)) return { state: DRIVER_GONE, heartbeat_age_ms: age, stale_after_ms: threshold.ms, threshold_origin: threshold.origin }
  return { state: DRIVER_RUNNING, heartbeat_age_ms: age, stale_after_ms: threshold.ms, threshold_origin: threshold.origin }
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
  const d = normalDeps(typeof now === 'number' ? { ...deps, now: () => now } : deps)
  const at = typeof now === 'number' ? now : d.now()
  const tunables = resolveTunables({ silenceS, loadThreshold })
  const silence = tunables.silence_s.value
  const threshold = tunables.load_per_core.value
  const watchRoot = root || crewRoot()
  const lanes = discoverLanes(watchRoot, d)
  const load = hostLoad({ threshold, deps: d })
  const written = []
  const watched = []

  for (const lane of lanes) {
    const journal = readJournal(lane.journal, d)
    if (!laneActive(lane, journal)) continue
    watched.push(lane.id)
    const driver = driverState(lane, journal, laneLedgerView(lane, d))
    const artifactMs = latestArtifactMs(lane.taskDir, d)
    const laneNotes = []
    if (driver.state === DRIVER_GONE) {
      laneNotes.push({
        note: 'driver-gone',
        heartbeat_age_s: Math.max(0, Math.floor(driver.heartbeat_age_ms / 1000)),
        threshold_s: Math.round(driver.stale_after_ms / 1000),
        threshold_origin: driver.threshold_origin,
        last_stage: journal.lastStage,
      })
    } else if (driver.state !== DRIVER_EXITED) {
      const silent = silenceNote({ journal, artifactMs, now: at, silenceS: silence })
      if (silent) laneNotes.push(silent)
    }
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
  return { at: new Date(at).toISOString(), root: watchRoot, lanes: watched, notes: written, tunables }
}
