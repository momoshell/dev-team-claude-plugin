// Read-only view of lean lanes (ADR-052): ~/.crew/dt-<lane>/<lane>/{crew.json,task/...}.
// Lanes are found live, then as the newest sibling <lane>.archive-*, then under the separate
// archive root ordered by the first journal row's time. Nothing here writes, spawns, or trusts a path the lane's own files name.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { stateless, supersededReturn } from './lean-journal-order.mjs'
import { deadRun, probeAlive } from './run-pid.mjs'
import { deriveMembers } from './protocols.mjs'
import { isObject, within } from './lane-core.mjs'

const LEAN_SPEC_FILE = 'lean.json'
const VERDICT_EVENT = 'verdict'
const LEAN_JOURNAL_FILE = 'journal.jsonl'
const LEAN_SESSIONS_DIR = 'lean'

const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/
const ROLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
const PREFIX = 'lean:'
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

// A row time is an epoch-ms number inside the Date range (past it, toISOString throws); anything else is unknown.
const rowTime = (value) => (Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null)

const leanIdentity = (lane) => `${PREFIX}${lane}`
const isLeanIdentity = (id) => typeof id === 'string' && id.startsWith(PREFIX)
const isLeanSlug = (slug) => typeof slug === 'string' && slug.startsWith('dt-')

function dirs(path) {
  try { return readdirSync(path).sort() } catch { return [] }
}
function isDir(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}
function leanRolesOf(dir) {
  const leanDir = join(dir, 'task', LEAN_SESSIONS_DIR)
  return within(dir, leanDir) ? dirs(leanDir).filter((name) => isDir(join(leanDir, name)) && within(dir, join(leanDir, name))) : []
}
// A lane file is read only when it resolves inside the lane: a symlink out of the lane reads as absent.
function readJson(path, laneDir) {
  if (!within(laneDir, path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
export function createLeanSource({ crewRoot, archiveRoot, alive = probeAlive } = {}) {
  const root = resolve(crewRoot)
  const archive = resolve(archiveRoot ?? join(dirname(root), '.crew-journal-archive'))
  const cache = new Map()
  function cacheEntry(path, laneDir) {
    try {
      if (!within(laneDir, path)) return null
      const { mtimeMs, size } = statSync(path)
      let entry = cache.get(path)
      if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
        entry = { mtimeMs, size }
        cache.set(path, entry)
      }
      return entry
    } catch { return null }
  }

  // Live lanes and their sibling archives come first, followed by the newest closeout archive.
  function candidates(lane) {
    const out = []
    for (const base of [root, archive]) {
      const prefix = `dt-${lane}.archive-`
      // First-row times survive later journal appends; suffixes break ties and order unknown times.
      const outer = base === archive ? dirs(base).filter((name) => name === `dt-${lane}` || (name.startsWith(prefix) && /^[1-9]\d*$/.test(name.slice(prefix.length))))
        .map((name) => {
          const laneDir = join(base, name, lane), path = join(laneDir, 'task', LEAN_JOURNAL_FILE)
          let at = null
          try {
            if (within(base, laneDir) && within(laneDir, path)) {
              const entry = cacheEntry(path, laneDir)
              if (entry && Object.hasOwn(entry, 'at')) at = entry.at
              else {
                try {
                  const value = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).at
                  if (Number.isFinite(value)) at = value
                } catch { /* An unreadable first row has unknown time. */ }
                if (entry) entry.at = at
              }
            }
          } catch { /* An unreadable first row has unknown time. */ }
          return { name, at, suffix: name === `dt-${lane}` ? 1 : Number(name.slice(prefix.length)) }
        })
        .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || b.suffix - a.suffix).map(({ name }) => name) : [`dt-${lane}`]
      for (const dirName of outer) {
        const laneDir = join(base, dirName)
        const siblings = dirs(laneDir).filter((name) => name.startsWith(`${lane}.archive-`)).reverse()
        for (const name of [lane, ...siblings]) out.push({ base, dir: join(laneDir, name), archived: name !== lane || base === archive })
      }
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
    for (const base of [root, archive]) for (const name of laneNames(base)) {
      const lane = (base === archive ? name.replace(/\.archive-[1-9]\d*$/, '') : name).slice(3)
      if (name.startsWith('dt-') && LANE.test(lane)) names.add(lane)
    }
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
      out.rows.push({ ...row, index: out.rows.length, line_number: i + 1 })
    }
    return out
  }

  // Seat recordings of one role, numeric turn order, confined to the resolved lane.
  function readSeatSessions(found, role) {
    if (typeof role !== 'string' || !ROLE.test(role)) return { status: 400, error: `${JSON.stringify(role)} is not a member of lane ${found.lane}` }
    if (!Object.hasOwn(found.members, role)) {
      const rows = readJournalRows(found).rows
      const { members } = deriveMembers({ members: found.members, rows, leanRoles: leanRolesOf(found.dir), tier: found.spec.tier })
      if (!Object.hasOwn(members, role)) return { status: 400, error: `${JSON.stringify(role)} is not a member of lane ${found.lane}` }
    }
    const roleDir = join(found.dir, 'task', LEAN_SESSIONS_DIR, role)
    const turn = new RegExp(`^[A-Za-z0-9._-]+\\.${role}\\.([0-9]+)((?:\\.[A-Za-z0-9-]+)*)\\.jsonl$`)
    const files = dirs(roleDir).flatMap((name) => {
      const match = name.match(turn)
      if (!match) return []
      const suffixes = match[2].split('.')
      return [[Number(match[1]), (suffixes.includes('repair') ? 2 : 0) + (suffixes.includes('rerun') ? 1 : 0), Number(suffixes.find((s) => /^retry-[1-9]\d*$/.test(s))?.slice(6) ?? 0), name]]
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0))
    const sessions = [], errors = []
    for (const [, , , name] of files) {
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
    last_heartbeat_at: 'lean lanes record no heartbeat', cost: 'lean lanes record no cost',
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

  function stageOutcome(outcome) {
    if (nonEmpty(outcome?.status)) return { status: outcome.status, reason: null }
    if (typeof outcome?.code === 'number') return { status: outcome.code !== 0 ? 'failed' : 'done', reason: null }
    if (outcome?.halt) return { status: nonEmpty(outcome.halt.status) ? outcome.halt.status : 'stopped', reason: outcome.halt.reason ?? null }
    if (outcome?.held) return { status: 'held', reason: outcome.held.reason ?? null }
    if (outcome?.envelope) return nonEmpty(outcome.envelope.status) ? { status: outcome.envelope.status, reason: null } : { status: 'unknown', reason: 'envelope records no status' }
    if (outcome?.threw) return { status: 'failed', reason: 'stage threw' }
    return { status: 'unknown', reason: outcome == null ? 'stage-end records no outcome' : 'stage-end outcome records no status' }
  }

  function summarize(found) {
    const { rows, skipped_malformed, error } = readJournalRows(found)
    const leanRoles = rows.some((row) => row.event === 'tier-raised') ? leanRolesOf(found.dir) : []
    const { members, tier } = deriveMembers({ members: found.members, rows, leanRoles, tier: found.spec.tier })
    const phases = []
    let latest_stage = null, status = 'unknown', reason = null, pr = null, running = false, started_at = null
    let hand_finished = false, pr_actor = null, lastAt = null
    for (const row of rows) {
      const at = rowTime(row.at)
      if (row.event === 'run-start') { started_at = at; lastAt = null }
      else if (at !== null) lastAt = at
      const stage = nonEmpty(row.stage) ? row.stage : null
      if (stage) latest_stage = stage
      if (row.event === 'stage-start' && stage) phases.push({ id: phases.length + 1, name: stage, status: 'running', checks: [], started_at: at, ended_at: null })
      else if (row.event === 'stage-end' && stage) {
        const phase = phases.findLast((entry) => entry.name === stage && entry.status === 'running')
        const outcome = stageOutcome(row.outcome)
        if (phase) { Object.assign(phase, outcome); phase.ended_at = at } else phases.push({ id: phases.length + 1, name: stage, ...outcome, checks: [], started_at: null, ended_at: at })
      } else if (row.event === 'envelope' && stage && nonEmpty(row.role)) {
        const phase = phases.findLast((entry) => entry.name === stage)
        if (phase) phase.role = row.role
      } else if (row.event === 'check' && stage) {
        const phase = phases.findLast((entry) => entry.name === stage)
        const check = { check: row.check ?? null, result: summarizeCheckResult(row.result) }
        if (phase) phase.checks.push(check)
        else phases.push({ id: phases.length + 1, name: stage, status: 'running', checks: [check], started_at: null, ended_at: null })
      } else if (row.event === VERDICT_EVENT && stage && !phases.some((entry) => entry.name === stage)) {
        phases.push({ id: phases.length + 1, name: stage, status: nonEmpty(row.status) ? row.status : 'unknown', checks: [], started_at: null, ended_at: null })
      }
    }
    // Ignore stage ends, advisor rows and in-flight checks after a stop when choosing the state.
    let last = rows.findLast((row, index) => !stateless(rows, row, index) && !supersededReturn(rows, row, index)) ?? rows.at(-1)
    // `crew finish --accept` appends a `pr` row then a `finish-decision` row: a pr row after the last
    // finish-ready, followed only by those, is the lane's state.
    const ready = rows.findLastIndex((row) => row.event === 'finish-ready')
    if (last?.event === 'finish-decision') {
      const tail = rows.findLast((row, index) => !stateless(rows, row, index) && row.event !== 'finish-decision')
      // A returned finish can start or stop before its parent records the decision.
      if ((tail?.event === 'pr' && isObject(tail.pr) && tail.index > ready)
        || (last.choice === 'return' && ready >= 0 && tail?.index > ready)) last = tail
    }
    const terminalIndex = rows.findLastIndex((row, index) => row.event === 'finish-ready' || (row.event === 'finish-decision' && !supersededReturn(rows, row, index)))
    const terminal = rows[terminalIndex]
    if (error || !rows.length) {
      reason = error ?? (skipped_malformed ? 'task journal has no readable rows' : 'task journal is empty')
    } else if (terminal?.event === 'finish-ready' && !(last.event === VERDICT_EVENT && last.status === 'stopped' && last.index > terminalIndex)
      && !rows.some((row, index) => index > terminalIndex && row.launchedAt > terminalIndex && supersededReturn(rows, row, index))) {
      status = 'ready-for-operator'
    } else if (terminal?.choice === 'abandon') {
      status = 'abandoned'
    } else if (terminal?.choice === 'return' && !rows.slice(ready >= 0 ? ready + 1 : terminalIndex + 1).some((row) => row.event === 'stage-start' || (row.event === VERDICT_EVENT && row.status === 'stopped'))) {
      status = 'returned'
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
    if (found.archived && running) { status = 'stopped'; reason = 'archived-without-terminal-row'; running = false }
    if (!found.archived && !error && deadRun({ rows, taskDir: join(found.dir, 'task'), alive, readFileSync: (path, encoding) => {
      if (!within(found.dir, path)) throw new Error('run pid resolves outside the lane')
      return readFileSync(path, encoding)
    } })) { status = 'stopped'; reason = 'run-died'; running = false }
    let ended_at = null, duration_ms = null
    if (!running && lastAt !== null) ended_at = lastAt
    if (started_at !== null && ended_at !== null) duration_ms = Date.parse(ended_at) - Date.parse(started_at)
    const turns = rows.filter((row) => row.event === 'seat-turn')
    const fields = { inputTokens: 'billed_input_tokens', outputTokens: 'billed_output_tokens', cachedReadTokens: 'billed_cache_read_tokens', cachedWriteTokens: 'billed_cache_write_tokens' }
    const validUsage = (row) => Object.keys(fields).every((field) => Number.isFinite(row.usage?.[field]) && row.usage[field] >= 0)
    const measured = turns.filter(validUsage).length
    const missing = turns.find((row) => !validUsage(row))
    const metrics = Object.fromEntries(Object.entries(fields).map(([source, target]) => [target, turns.length && !missing ? turns.reduce((sum, row) => sum + row.usage[source], 0) : null]))
    const usage_turns = turns.length ? { measured, total: turns.length } : null
    const pending = { ...pendingReasons }
    if (!turns.length) pending.tokens = 'no seat-turn rows recorded'
    else if (missing) pending.tokens = nonEmpty(missing.unmeasured?.usage) ? missing.unmeasured.usage : 'usage-malformed'
    const startIndex = rows.findLastIndex((row) => row.event === 'run-start')
    const endReason = error || !rows.length ? reason : running ? 'the lane is still open: no terminal row recorded'
      : startIndex >= 0 && startIndex === rows.length - 1 ? 'the lane journal records no row after run-start'
        : 'lean journal rows after run-start carry no timestamps'
    if (ended_at !== null) delete pending.ended_at
    else pending.ended_at = endReason
    if (duration_ms !== null) delete pending.duration_ms
    else pending.duration_ms = started_at === null ? 'the lane journal records no valid run-start time' : endReason
    if (started_at === null) pending.started_at = 'the lane journal records no valid run-start time'
    const seats = Object.entries(members).map(([role, member]) => ({
      role, agent: nonEmpty(member.agent) ? member.agent : null, model: nonEmpty(member.model) ? member.model : null,
      transport: nonEmpty(member.transport) ? member.transport : null,
    }))
    return {
      source: 'lean', adw_id: leanIdentity(found.lane), goal: found.lane, repo_slug: `dt-${found.lane}`, task_slug: found.lane,
      latest_stage, status, reason, running, phases, seats, pr, hand_finished, pr_actor,
      archived: found.archived, journal_rows: rows.length, journal_skipped_malformed: skipped_malformed, journal_error: error ?? null,
      tier: nonEmpty(tier) ? tier : null, shape: nonEmpty(found.spec.shape) ? found.spec.shape : null,
      mode: null, started_at, ended_at, duration_ms, last_heartbeat_at: null,
      pending, metrics, usage_turns,
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
    return lanes().map((found) => {
      const entry = found.archived ? cacheEntry(join(found.dir, 'task', LEAN_JOURNAL_FILE), found.dir) : null
      if (entry?.summary) return entry.summary
      const summary = summarize(found)
      if (entry) entry.summary = summary
      return summary
    }).filter((run) => !filters.mode && (!filters.status || filters.status === run.status) && inWindow(run))
  }

  return { listRuns, identify, readJournalRows, readSeatSessions, resolveLane }
}
