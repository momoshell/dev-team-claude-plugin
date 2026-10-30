// Read-only view of lean lanes (ADR-052): ~/.crew/dt-<lane>/<lane>/{crew.json,task/...}.
// Lanes are found live, then as the newest sibling <lane>.archive-*, then under the separate
// archive root. Nothing here writes, spawns, or trusts a path the lane's own files name.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const LEAN_SPEC_FILE = 'lean.json'
const VERDICT_EVENT = 'verdict'
const LEAN_JOURNAL_FILE = 'journal.jsonl'
const LEAN_SESSIONS_DIR = 'lean'

const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/
const ROLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
const PREFIX = 'lean:'
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

// A row time is an epoch-ms number inside the Date range (past it, toISOString throws); anything else is unknown.
const rowTime = (value) => (Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null)

export const leanIdentity = (lane) => `${PREFIX}${lane}`
export const isLeanIdentity = (id) => typeof id === 'string' && id.startsWith(PREFIX)
export const isLeanSlug = (slug) => typeof slug === 'string' && slug.startsWith('dt-')

function dirs(path) {
  try { return readdirSync(path).sort() } catch { return [] }
}
function isDir(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}
// A lane file is read only when it resolves inside the lane: a symlink out of the lane reads as absent.
function readJson(path, laneDir) {
  if (!within(laneDir, path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function within(root, path) {
  try {
    const real = realpathSync(path), base = realpathSync(root)
    return real === base || real.startsWith(`${base}${sep}`)
  } catch { return false }
}

export function createLeanSource({ crewRoot, archiveRoot } = {}) {
  const root = resolve(crewRoot)
  const archive = resolve(archiveRoot ?? join(dirname(root), '.crew-journal-archive'))

  // Candidate lane directories, best first: live, newest sibling archive, then the archive root's.
  function candidates(lane) {
    const out = []
    for (const base of [root, archive]) {
      const laneDir = join(base, `dt-${lane}`)
      const siblings = dirs(laneDir).filter((name) => name.startsWith(`${lane}.archive-`)).reverse()
      for (const name of [lane, ...siblings]) out.push({ base, dir: join(laneDir, name), archived: name !== lane || base === archive })
    }
    return out
  }

  function resolveLane(lane) {
    if (typeof lane !== 'string' || !LANE.test(lane)) return null
    for (const candidate of candidates(lane)) {
      if (!isDir(candidate.dir) || !within(candidate.base, candidate.dir)) continue
      const spec = readJson(join(candidate.dir, 'task', LEAN_SPEC_FILE), candidate.dir)
      if (!isObject(spec) || spec.id !== lane) continue
      const crew = readJson(join(candidate.dir, 'crew.json'), candidate.dir)
      if (!isObject(crew) || !isObject(crew.members)) continue
      const seats = Object.entries(crew.members)
      if (!seats.length || seats.some(([name, member]) => !ROLE.test(name) || !isObject(member))) continue
      return { lane, dir: candidate.dir, base: candidate.base, archived: candidate.archived, spec, members: crew.members }
    }
    return null
  }

  // A root that does not exist holds no lanes; any other read failure (not a directory, permission denied)
  // is thrown so the caller reports the source unreadable rather than an empty list.
  function laneNames(base) {
    try { return readdirSync(base).sort() } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw new Error(`lean root ${base} unreadable: ${error?.code ?? error?.message}`)
    }
  }

  function lanes() {
    const names = new Set()
    for (const base of [root, archive]) for (const name of laneNames(base)) if (name.startsWith('dt-') && LANE.test(name.slice(3))) names.add(name.slice(3))
    return [...names].sort().map(resolveLane).filter(Boolean)
  }

  // Resolve a request's identity: all three of repo_slug, task_slug and adw_id must name the same lane.
  function identify({ repo_slug, task_slug, adw_id } = {}) {
    const wanted = isLeanIdentity(adw_id) ? adw_id.slice(PREFIX.length) : null
    const bare = wanted === null && !adw_id && isLeanSlug(repo_slug) && repo_slug === `dt-${task_slug}` && resolveLane(task_slug) !== null
    if (wanted === null && !bare) return { lean: false }
    const lane = wanted ?? task_slug
    if (lane !== task_slug || repo_slug !== `dt-${lane}`) return { lean: true, error: 'lean identity does not match repo_slug and task_slug' }
    const found = resolveLane(lane)
    if (!found) return { lean: true, error: `no lean lane ${lane}` }
    return { lean: true, lane: found }
  }

  function readJournalRows(found) {
    const out = { rows: [], skipped_malformed: 0, skipped_line_numbers: [], error: null }
    const path = join(found.dir, 'task', LEAN_JOURNAL_FILE)
    let text
    try {
      // A missing journal makes within() false too; statSync tells the two apart by throwing ENOENT.
      if (!within(found.dir, path) && statSync(path)) { out.error = 'task journal resolves outside the lane'; return out }
      text = readFileSync(path, 'utf8')
    } catch (error) {
      out.error = error?.code === 'ENOENT' ? 'task journal was not recorded' : `task journal unreadable: ${error?.code ?? error?.message}`
      return out
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue
      let row
      try { row = JSON.parse(lines[i]) } catch { row = null }
      if (!isObject(row)) { out.skipped_malformed += 1; out.skipped_line_numbers.push(i + 1); continue }
      out.rows.push({ ...row, index: out.rows.length, line_number: i + 1, channel: row.channel ?? null })
    }
    return out
  }

  // Seat recordings of one role, numeric turn order, confined to the resolved lane.
  function readSeatSessions(found, role) {
    if (typeof role !== 'string' || !ROLE.test(role) || !Object.hasOwn(found.members, role)) return { status: 400, error: `${JSON.stringify(role)} is not a member of lane ${found.lane}` }
    const roleDir = join(found.dir, 'task', LEAN_SESSIONS_DIR, role)
    const turn = new RegExp(`^[A-Za-z0-9._-]+\\.${role}\\.([0-9]+)(?:\\.[A-Za-z0-9-]+)*\\.jsonl$`)
    const files = dirs(roleDir).flatMap((name) => (turn.test(name) ? [[Number(name.match(turn)[1]), name]] : []))
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    const sessions = [], errors = []
    for (const [, name] of files) {
      const path = join(roleDir, name)
      const file = `task/${LEAN_SESSIONS_DIR}/${role}/${name}`
      if (!within(found.dir, path)) { errors.push({ file, error: 'recording resolves outside the lane' }); continue }
      try { sessions.push({ file, raw: readFileSync(path, 'utf8') }) } catch (error) { errors.push({ file, error: `unreadable: ${error?.code ?? error?.message}` }) }
    }
    return {
      status: 200, role, sessions,
      absent: sessions.length ? null : errors.length ? 'recordings exist but could not be read' : `no ${role} recording under task/${LEAN_SESSIONS_DIR}/${role}`,
      ...(errors.length ? { errors } : {}),
      source: found.archived ? 'archive' : 'live',
    }
  }

  const pendingReasons = {
    duration_ms: 'lean journal rows after run-start carry no timestamps', ended_at: 'lean journal rows after run-start carry no timestamps',
    last_heartbeat_at: 'lean lanes record no heartbeat', tokens: 'lean seat recordings are not counted', cost: 'lean lanes record no cost',
    mode: 'lean lanes record no mode',
  }

  function summarizeCheckResult(result) {
    if (!isObject(result)) return null
    return {
      accepted: result.accepted,
      status: result.status,
      code: result.code,
      ...(isObject(result.result) ? { result: { status: result.result.status } } : {}),
    }
  }

  function summarize(found) {
    const { rows, skipped_malformed, error } = readJournalRows(found)
    const phases = []
    let latest_stage = null, status = 'unknown', reason = null, pr = null, running = false, started_at = null
    let hand_finished = false, pr_actor = null, lastAt = null
    for (const row of rows) {
      const at = rowTime(row.at)
      if (row.event === 'run-start') started_at = at
      else if (at !== null) lastAt = at
      const stage = nonEmpty(row.stage) ? row.stage : null
      if (stage) latest_stage = stage
      if (row.event === 'stage-start' && stage) phases.push({ id: phases.length + 1, name: stage, status: 'running', checks: [], started_at: at, ended_at: null })
      else if (row.event === 'stage-end' && stage) {
        const phase = phases.findLast((entry) => entry.name === stage && entry.status === 'running')
        const code = row.outcome?.code
        const outcome = nonEmpty(row.outcome?.status) ? row.outcome.status : (typeof code === 'number' && code !== 0 ? 'failed' : 'done')
        if (phase) { phase.status = outcome; phase.ended_at = at } else phases.push({ id: phases.length + 1, name: stage, status: outcome, checks: [], started_at: null, ended_at: at })
      } else if (row.event === 'check' && stage) {
        const phase = phases.findLast((entry) => entry.name === stage)
        const check = { check: row.check ?? null, result: summarizeCheckResult(row.result) }
        if (phase) phase.checks.push(check)
        else phases.push({ id: phases.length + 1, name: stage, status: 'running', checks: [check], started_at: null, ended_at: null })
      } else if (row.event === VERDICT_EVENT && stage && !phases.some((entry) => entry.name === stage)) {
        phases.push({ id: phases.length + 1, name: stage, status: nonEmpty(row.status) ? row.status : 'unknown', checks: [], started_at: null, ended_at: null })
      }
    }
    // A stop inside a stage is followed by that stage's (and any enclosing stage's) stage-end row, so the
    // lane's state is its last row that is not a stage-end.
    let last = rows.findLast((row) => row.event !== 'stage-end') ?? rows.at(-1)
    // `crew finish --accept` appends a `pr` row then a `finish-decision` row: a pr row after the last
    // finish-ready, followed only by those, is the lane's state.
    if (last?.event === 'finish-decision') {
      const tail = rows.findLast((row) => row.event !== 'stage-end' && row.event !== 'finish-decision')
      const ready = rows.findLastIndex((row) => row.event === 'finish-ready')
      if (tail?.event === 'pr' && isObject(tail.pr) && tail.index > ready) last = tail
    }
    if (error || !rows.length) {
      reason = error ?? (skipped_malformed ? 'task journal has no readable rows' : 'task journal is empty')
    } else if (last.event === VERDICT_EVENT) {
      status = nonEmpty(last.status) ? last.status : 'unknown'
      reason = typeof last.reason === 'string' ? last.reason : null
      if (!nonEmpty(last.status)) reason = 'final verdict records no status'
      running = status === 'reviewed'
    } else if (last.event === 'pr' && isObject(last.pr)) {
      status = 'done'; pr = last.pr
      hand_finished = last.actor === 'operator'
      pr_actor = hand_finished ? 'operator' : 'loop'
    } else {
      status = 'running'; running = true
    }
    let ended_at = null, duration_ms = null
    if (!running && lastAt !== null) ended_at = lastAt
    if (started_at !== null && ended_at !== null) duration_ms = Date.parse(ended_at) - Date.parse(started_at)
    const pending = { ...pendingReasons }
    if (ended_at !== null) delete pending.ended_at
    if (duration_ms !== null) delete pending.duration_ms
    if (started_at === null) pending.started_at = 'the lane journal records no valid run-start time'
    const seats = Object.entries(found.members).map(([role, member]) => ({
      role, agent: nonEmpty(member.agent) ? member.agent : null, model: nonEmpty(member.model) ? member.model : null,
      transport: nonEmpty(member.transport) ? member.transport : null,
    }))
    return {
      source: 'lean', adw_id: leanIdentity(found.lane), goal: found.lane, repo_slug: `dt-${found.lane}`, task_slug: found.lane,
      latest_stage, status, reason, running, phases, seats, pr, hand_finished, pr_actor,
      archived: found.archived, journal_rows: rows.length, journal_skipped_malformed: skipped_malformed, journal_error: error ?? null,
      tier: nonEmpty(found.spec.tier) ? found.spec.tier : null, shape: nonEmpty(found.spec.shape) ? found.spec.shape : null,
      mode: null, started_at, ended_at, duration_ms, last_heartbeat_at: null,
      pending,
      ship: { state: 'unmeasured', reason: pr ? 'pull request recorded; merge state is not recorded in the lane' : 'lean lanes record no ship state', stale: false },
    }
  }

  // Filters match what the lean rows carry: status by equality, the time window by the run-start time. Lean
  // lanes record no mode, so a mode filter matches none; a lane with no start time cannot be placed in a window.
  function listRuns(filters = {}) {
    const inWindow = (run) => {
      if (!filters.since && !filters.until) return true
      if (run.started_at === null) return false
      const at = Date.parse(run.started_at)
      return (!filters.since || at >= Date.parse(filters.since)) && (!filters.until || at < Date.parse(filters.until))
    }
    return lanes().map(summarize).filter((run) => !filters.mode && (!filters.status || filters.status === run.status) && inWindow(run))
  }

  return { listRuns, identify, readJournalRows, readSeatSessions, resolveLane }
}
