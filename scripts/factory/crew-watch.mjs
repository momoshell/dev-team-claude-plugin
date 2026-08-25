#!/usr/bin/env node
// scripts/factory/crew-watch.mjs — the bounded lane readout that composes
// lane-watch.mjs and re-implements none of it. It never acts on a crew and
// spawns nothing.

import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync, appendFileSync, realpathSync } from 'node:fs'
import { loadavg, cpus } from 'node:os'
import { join } from 'node:path'
import { archivedLanes, crewRoot, discoverLanes, journalAt, laneActive, readJournal, resolveTunables, watchPass, TERMINAL_STAGES } from './lane-watch.mjs'
import { fileURLToPath } from 'node:url'

export const DEFAULT_EVENTS = Object.freeze(['stage', 'attention', 'escalat', 'refus', 'review_outcome', 'gate_check_discrimination', 'commit', 'seat-teardown'])
export const KEYED_EVENTS = Object.freeze(['review_outcome', 'gate_check_discrimination'])
export const READOUT_INTERVAL_S = 2
export const WATCHDOG_INTERVAL_S = 30

// The bound on a name that has not resolved yet. `pending` is legitimate — a
// watcher may be armed BEFORE a lane boots — but an UNBOUNDED pending wait is
// fail-open in the one layer whose job is to tell "not finished" from "never
// started": it looks exactly like the lane it cannot find (#640). So the wait is
// bounded by default and `--pending-s never` is how an operator ASKS for the
// unbounded one, in writing.
//
// Normalising the name through slug() would have hidden this incident (the
// operator types `b231-helperdedupB`, the crew dir carries `b231-helperdedupb`);
// normalising through slug() is REFUSED all the same, because it would also
// swallow a genuine typo and would put a second copy of the slug rule — or a new
// scripts/-to-crew/ import — in the observability path. The refusal below does
// the job honestly instead: it names what never resolved AND the lanes that do
// exist, so a one-letter miss is visible on the same line.
export const PENDING_BOUND_S = 300

export class WatchUsageError extends Error {
  constructor(message, reason = 'missing-line') {
    super(message)
    this.name = 'WatchUsageError'
    this.reason = reason
  }
}

export function normalDeps(deps = {}) {
  return {
    existsSync: deps.existsSync || existsSync,
    readFileSync: deps.readFileSync || readFileSync,
    readdirSync: deps.readdirSync || readdirSync,
    statSync: deps.statSync || statSync,
    appendFileSync: deps.appendFileSync || appendFileSync,
    loadavg: deps.loadavg || loadavg,
    cpus: deps.cpus || cpus,
    platform: deps.platform || process.platform,
    now: deps.now || (() => Date.now()),
    openSync: deps.openSync || openSync,
    readSync: deps.readSync || readSync,
    closeSync: deps.closeSync || closeSync,
    ppid: deps.ppid || (() => process.ppid),
    stdout: deps.stdout || ((text) => process.stdout.write(text)),
    stderr: deps.stderr || ((text) => process.stderr.write(text)),
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    onSignal: deps.onSignal || ((signal, handler) => process.once(signal, handler)),
  }
}

export function parseArgs(argv) {
  const flags = {}
  const names = []
  const booleanFlags = new Set(['follow', 'all', 'no-watchdog'])
  const valueFlags = new Set(['events', 'interval', 'silence-s', 'load-per-core', 'pending-s'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      names.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      if (Object.prototype.hasOwnProperty.call(flags, name)) throw new WatchUsageError(`watch: duplicate --${name}`)
      flags[name] = true
      continue
    }
    if (!valueFlags.has(name)) throw new WatchUsageError(`watch: unknown option: --${name}`)
    if (Object.prototype.hasOwnProperty.call(flags, name)) throw new WatchUsageError(`watch: duplicate --${name}`)
    const value = argv[index + 1]
    if (value == null || value.startsWith('--')) throw new WatchUsageError(`watch: --${name} requires a value`)
    flags[name] = value
    index += 1
  }
  if (names.length === 0 && flags.all !== true) throw new WatchUsageError('watch: name a lane or pass --all')
  const events = flags.events === undefined
    ? [...DEFAULT_EVENTS]
    : flags.events.split(',').map((s) => s.trim()).filter(Boolean)
  if (events.length === 0) throw new WatchUsageError('watch: --events requires at least one event')
  const intervalS = flags.interval === undefined ? READOUT_INTERVAL_S : Number(flags.interval)
  if (!Number.isFinite(intervalS) || intervalS <= 0) throw new WatchUsageError('watch: --interval must be finite and positive')
  // Same refusal as --interval: a threshold coerced to NaN would be a worse
  // defect than the untunable one #469 fixes. Absent stays undefined so
  // lane-watch's resolveTunables remains the only place a default is named.
  const threshold = (name) => {
    if (flags[name] === undefined) return undefined
    const value = Number(flags[name])
    if (!Number.isFinite(value) || value <= 0) throw new WatchUsageError(`watch: --${name} must be finite and positive`)
    return value
  }
  const silenceS = threshold('silence-s')
  const loadPerCore = threshold('load-per-core')
  // `never` is the operator asking for the unbounded wait, in writing; anything
  // else goes through the same finite-and-positive refusal as --interval.
  const pendingS = flags['pending-s'] === undefined
    ? PENDING_BOUND_S
    : flags['pending-s'] === 'never' ? null : threshold('pending-s')
  // A threshold the watchdog can never consult must be REFUSED, not discarded: a
  // single-pass readout returns from main() before any watchPass, so accepting one
  // here is the same "looks like it works" defect the watchdog work was about. The
  // message names the MODE the flag belongs to, so it says what to do and not only
  // what went wrong; exit 2 comes from WatchUsageError (crew/crew.mjs:32).
  const followOnly = ['silence-s', 'load-per-core', 'pending-s'].filter((name) => flags[name] !== undefined)
  if (flags.follow !== true && followOnly.length > 0) {
    throw new WatchUsageError(`watch: --${followOnly[0]} applies to --follow only; a single-pass readout runs no watchdog`)
  }
  return {
    names,
    all: flags.all === true,
    follow: flags.follow === true,
    watchdog: !flags['no-watchdog'],
    events,
    intervalS,
    silenceS,
    loadPerCore,
    pendingS,
  }
}

export function lineLabels(line) {
  if (!line || typeof line !== 'object') return []
  if (typeof line.stage === 'string') return [line.stage, 'stage']
  if (typeof line.event === 'string') return [line.event]
  if (typeof line.kind === 'string') return [line.kind]
  const keyed = KEYED_EVENTS.find((key) => Object.prototype.hasOwnProperty.call(line, key))
  return keyed ? [keyed] : []
}

export function selectEvent(line, events) {
  return lineLabels(line).some((label) => events.some((token) => label.startsWith(token)))
}

export function formatEvent(task, line) {
  const labels = lineLabels(line)
  if (labels.length === 0) return null
  const at = journalAt(line.at)
  const date = at === null ? null : new Date(at)
  const clock = date === null || !Number.isFinite(date.getTime()) ? '--:--:--' : date.toISOString().slice(11, 19)
  const detail = ['why', 'role', 'note', 'error', 'dispatch']
    .filter((key) => Object.prototype.hasOwnProperty.call(line, key))
    .map((key) => ` ${key}=${String(line[key])}`)
    .join('')
  return `[${task}] ${clock} ${labels[0]}${detail}`
}

// The readout must ADMIT which numbers the watchdog used and where each came
// from: a watchdog that is quiet because its threshold cannot fire on this host
// is otherwise indistinguishable from a host with nothing wedged (#469).
export function watchdogLine({ watchdog = true, silenceS, loadThreshold } = {}) {
  if (!watchdog) return '[watchdog] off'
  const inForce = resolveTunables({ silenceS, loadThreshold })
  const say = (key) => `${key}=${inForce[key].value} (${inForce[key].origin})`
  return `[watchdog] ${say('silence_s')} ${say('load_per_core')}`
}

export function resolveLane(name, lanes) {
  return lanes.find((lane) => lane.task === name) || lanes.find((lane) => lane.id === name) || null
}

// The NEWEST archive for a name: a slug can be torn down more than once and the
// stamp sorts lexicographically (crew/crew.mjs:1623 mints an ISO-8601 stamp).
export function resolveArchivedLane(name, archives) {
  const matches = archives.filter((lane) => lane.task === name || lane.id === name || `${lane.repo}/${lane.task}` === name)
  if (matches.length === 0) return null
  return matches.slice().sort((a, b) => (a.archivedAt < b.archivedAt ? -1 : 1)).pop()
}

// The refusal NAMES what never resolved — and, beside it, the lanes that DO
// exist, so a one-letter miss reads as a typo and not a mystery. Same shape as
// dispatch-batch's dependency-unknown (scripts/factory/dispatch-batch.mjs:284).
export function unresolvedRefusal({ names, boundS, live }) {
  return new WatchUsageError(`watch: lane name(s) never resolved within ${boundS}s: ${names.join(', ')}; live lanes: ${live.length ? live.join(', ') : 'none'}`, 'lane-unresolved')
}

export function selectLanes({ root, names = [], all = false, deps = {} } = {}) {
  const d = normalDeps(deps)
  const discovered = discoverLanes(root, d)
  if (all) {
    return { lanes: discovered.filter((lane) => laneActive(lane, readJournal(lane.journal, d))), pending: [], archived: [] }
  }
  const lanes = []
  const pending = []
  const archived = []
  let archives = null
  for (const name of names) {
    const lane = resolveLane(name, discovered)
    if (lane) { lanes.push(lane); continue }
    // `pending` means "not created yet". A torn-down run is not that, and
    // reporting one as pending forever is the same archive-blindness from the
    // other direction (#417). The archive walk is lazy: a name that resolves
    // live never pays for it.
    if (archives === null) archives = archivedLanes(root, d)
    const found = resolveArchivedLane(name, archives)
    if (found) archived.push(found)
    else pending.push(name)
  }
  return { lanes, pending, archived }
}

export function boundedReport({ root, names = [], all = false, now, deps = {} } = {}) {
  const d = normalDeps(deps)
  const at = now === undefined ? d.now() : now
  const selected = selectLanes({ root, names, all, deps: d })
  const lines = []
  for (const lane of selected.lanes) {
    const journal = readJournal(lane.journal, d)
    const stage = journal.lastStage ?? 'none'
    const ageS = journal.lastActivityAt === null ? 'none' : Math.floor((at - journal.lastActivityAt) / 1000)
    const status = laneActive(lane, journal) ? 'active' : 'settled'
    lines.push(`[${lane.task}] stage=${stage} age=${ageS}s status=${status}`)
  }
  for (const lane of selected.archived) {
    const journal = readJournal(lane.journal, d)
    const stage = journal.lastStage ?? 'none'
    const ageS = journal.lastActivityAt === null ? 'none' : Math.floor((at - journal.lastActivityAt) / 1000)
    lines.push(`[${lane.task}] stage=${stage} age=${ageS}s status=archived`)
  }
  for (const name of selected.pending) lines.push(`[${name}] stage=none age=none status=pending`)
  return { lines, lanes: selected.lanes, pending: selected.pending }
}

export function readTail({ path, offset = 0, deps = {} } = {}) {
  const d = normalDeps(deps)
  let size
  try { size = d.statSync(path).size } catch { return { offset, text: '' } }
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return { offset, text: '' }
  const start = offset > size ? 0 : offset
  if (start >= size) return { offset, text: '' }
  const amount = size - start
  let fd
  let result = null
  let failed = false
  try {
    fd = d.openSync(path, 'r')
    const buffer = Buffer.alloc(amount)
    const bytesRead = d.readSync(fd, buffer, 0, amount, start)
    const text = buffer.toString('utf8', 0, bytesRead)
    const end = text.lastIndexOf('\n')
    if (end >= 0) {
      const complete = text.slice(0, end + 1)
      result = { offset: start + Buffer.byteLength(complete), text: complete }
    } else {
      result = { offset: start, text: '' }
    }
  } catch {
    failed = true
  } finally {
    if (fd !== undefined) {
      try { d.closeSync(fd) } catch { failed = true }
    }
  }
  return failed ? { offset, text: '' } : result
}

export function orphaned(bootPpid, ppid) {
  return Number.isInteger(bootPpid) && Number.isInteger(ppid) && ppid !== bootPpid
}

export function createState({ root, names = [], all = false, events = [...DEFAULT_EVENTS], intervalS = READOUT_INTERVAL_S, watchdog = true, silenceS, loadPerCore, pendingS = PENDING_BOUND_S, bootPpid, deps = {} } = {}) {
  return {
    root,
    names,
    all,
    events,
    intervalMs: intervalS * 1000,
    pendingMs: pendingS === null ? null : pendingS * 1000,
    startedAt: null,
    watchdog,
    silenceS,
    loadPerCore,
    bootPpid: bootPpid ?? normalDeps(deps).ppid(),
    offsets: new Map(),
    lastWatchdogAt: null,
    stopped: false,
  }
}

export function tick(state, deps = {}) {
  const d = normalDeps(deps)
  const selected = selectLanes({ root: state.root, names: state.names, all: state.all, deps: d })
  const now = d.now()
  if (state.startedAt == null) state.startedAt = now
  const lines = []
  for (const lane of selected.lanes) {
    const tail = readTail({ path: lane.journal, offset: state.offsets.get(lane.id) ?? 0, deps: d })
    state.offsets.set(lane.id, tail.offset)
    for (const raw of tail.text.split('\n')) {
      if (!raw.trim()) continue
      let line
      try { line = JSON.parse(raw) } catch { continue }
      if (!selectEvent(line, state.events)) continue
      const formatted = formatEvent(lane.task, line)
      if (formatted !== null) lines.push(formatted)
    }
  }
  let notes = []
  if (state.watchdog && (state.lastWatchdogAt === null || now - state.lastWatchdogAt >= WATCHDOG_INTERVAL_S * 1000)) {
    const pass = watchPass({ root: state.root, now, silenceS: state.silenceS, loadThreshold: state.loadPerCore, deps: d })
    state.lastWatchdogAt = now
    notes = pass.notes
  }
  if (orphaned(state.bootPpid, d.ppid())) return { lines, notes, stop: true, reason: 'orphaned' }
  if (state.pendingMs !== null && selected.pending.length > 0 && now - state.startedAt >= state.pendingMs) {
    return { lines, notes, stop: true, reason: 'unresolved', unresolved: [...selected.pending] }
  }
  if (selected.pending.length === 0 && selected.lanes.every((lane) => !laneActive(lane, readJournal(lane.journal, d)))) {
    return { lines, notes, stop: true, reason: 'settled' }
  }
  return { lines, notes, stop: false, reason: null }
}

export async function follow(state, deps = {}) {
  const d = normalDeps(deps)
  for (;;) {
    const result = tick(state, d)
    for (const line of result.lines) d.stdout(`${line}\n`)
    if (result.reason === 'unresolved') {
      throw unresolvedRefusal({ names: result.unresolved, boundS: state.pendingMs / 1000, live: discoverLanes(state.root, d).map((lane) => lane.task).sort() })
    }
    if (result.stop || state.stopped) return 0
    await d.sleep(state.intervalMs)
  }
}

export async function main(argv, deps = {}) {
  const d = normalDeps(deps)
  try {
    const flags = parseArgs(argv)
    const root = crewRoot()
    if (!flags.follow) {
      const report = boundedReport({ root, names: flags.names, all: flags.all, now: d.now(), deps: d })
      for (const line of report.lines) d.stdout(`${line}\n`)
      return 0
    }
    const state = createState({ root, names: flags.names, all: flags.all, events: flags.events, intervalS: flags.intervalS, watchdog: flags.watchdog, silenceS: flags.silenceS, loadPerCore: flags.loadPerCore, pendingS: flags.pendingS, deps: d })
    d.stdout(`${watchdogLine({ watchdog: flags.watchdog, silenceS: flags.silenceS, loadThreshold: flags.loadPerCore })}\n`)
    const stop = () => { state.stopped = true }
    d.onSignal('SIGINT', stop)
    d.onSignal('SIGTERM', stop)
    // A detached child can be reparented to PID 1 before its first instruction;
    // there is no original PID left to compare, so give that already-orphaned
    // process one readout turn before stopping it.
    if (state.bootPpid === 1) setTimeout(stop, READOUT_INTERVAL_S * 1000)
    return await follow(state, d)
  } catch (err) {
    if (err instanceof WatchUsageError) {
      d.stderr(`${err.message} [reason: ${err.reason}]\n`)
      return 2
    }
    throw err
  }
}

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}
