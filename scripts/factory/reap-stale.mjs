#!/usr/bin/env node
// scripts/factory/reap-stale.mjs — the stale-descendant sweep (#419, layer 3).
// REFERENCE IMPLEMENTATION authored by the planner and proven against gate.mjs
// (12/13 green; A13 needs the lane test file). Every LITERAL anchor in plan.md
// appears here verbatim. The builder may adopt it, but owns its correctness.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync } from 'node:fs'
import { spawnSync as cpSpawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { DESCENDANT_DIR, reclaimDescendants } from '../../crew/seat-io.mjs'
import { LIVENESS } from '../../crew/reclaim.mjs'
import { crewRoot } from './lane-watch.mjs'

export const ARCHIVE_RE = /\.archive-\d{4}-\d{2}-\d{2}T/
export const REAP_VERDICTS = Object.freeze({
  RECLAIMED: 'reclaimed',
  REFUSED_LIVE: 'refused-live',
  REFUSED_MISMATCH: 'refused-evidence-mismatch',
  REFUSED_UNKNOWN: 'refused-unknown',
  EMPTY: 'no-candidates',
})
export const REAP_OUTCOMES = Object.freeze({
  NOTHING: 'nothing-to-reclaim',
  PENDING: 'pending-reclaim',
  RECLAIMED: 'reclaimed',
  PARTIAL: 'partial',
  REFUSED: 'all-refused',
})

export class ReapUsageError extends Error {
  constructor(message, reason = 'usage') {
    super(message)
    this.name = 'ReapUsageError'
    this.reason = reason
  }
}

export function normalDeps(deps = {}) {
  return {
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    readdirSync: deps.readdirSync || fsReaddirSync,
    kill: deps.kill || null,
    snapshot: deps.snapshot || null,
    sleep: deps.sleep || null,
    paneSleep: deps.paneSleep || paneSleep,
    now: deps.now || null,
    uuid: deps.uuid || null,
    reclaim: deps.reclaim || reclaimDescendants,
    paneSnapshot: deps.paneSnapshot || null,
    fdProbe: deps.fdProbe || null,
    identityProbe: deps.identityProbe || null,
    spawnSync: deps.spawnSync || null,
    stdout: deps.stdout || ((text) => process.stdout.write(text)),
    stderr: deps.stderr || ((text) => process.stderr.write(text)),
    home: deps.home,
  }
}

export function guardedKill(kill) {
  return (pid, signal) => {
    if (!Number.isSafeInteger(pid) || (pid < 0 ? -pid : pid) <= 1) {
      const err = new Error(`reap: refusing to signal pid ${pid}`)
      err.code = 'EINVAL'
      throw err
    }
    return kill(pid, signal)
  }
}

export function isArchived(name) {
  return ARCHIVE_RE.test(String(name))
}

// The proven/failed/unproven accounting reclaimDescendants already adjudicates
// per record (crew/seat-io.mjs, `outcome`). Carried through the sweep so a
// process that could not be PROVEN dead is reported unproven, never assumed
// dead (#473).
export const REAP_ACCOUNTING = Object.freeze(['proven', 'failed', 'unproven'])

function zeroOutcomes() {
  const out = {}
  for (const name of REAP_ACCOUNTING) out[name] = 0
  return out
}

function reclaimDeps(d) {
  const out = {}
  const base = d.kill || ((pid, signal) => process.kill(pid, signal))
  out.kill = guardedKill(base)
  if (d.snapshot) out.snapshot = d.snapshot
  if (d.sleep) out.sleep = d.sleep
  if (d.now) out.now = d.now
  if (d.uuid) out.uuid = d.uuid
  return out
}

export function candidateTasks(root, deps = {}) {
  const d = normalDeps(deps)
  const out = []
  let repos
  try { repos = d.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const repo of repos.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    let tasks
    try { tasks = d.readdirSync(join(root, repo.name), { withFileTypes: true }) } catch { continue }
    for (const task of tasks.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // An archived dir is ENUMERATED, not excluded: leaking and then archiving
      // is the normal order of events, so the excluded dirs were exactly the
      // ones most likely to hold a leak (#473). Archived still means finished —
      // the row says which it is and nothing downstream reads it as active.
      const dir = join(root, repo.name, task.name)
      const taskDir = join(dir, 'task')
      if (!d.existsSync(join(taskDir, DESCENDANT_DIR))) continue
      out.push({ id: `${repo.name}/${task.name}`, repo: repo.name, task: task.name, dir, taskDir, archived: isArchived(task.name) })
    }
  }
  return out
}

export function pendingRecords(taskDir, deps = {}) {
  const d = normalDeps(deps)
  const dir = join(taskDir, DESCENDANT_DIR)
  let names
  try { names = d.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    const match = /^\.(.+)\.active\.json$/.exec(name)
    if (!match || name.includes('.json.tmp.')) continue
    const path = join(dir, name)
    let record
    try { record = JSON.parse(String(d.readFileSync(path, 'utf8'))) } catch { continue }
    if (!record || typeof record !== 'object') continue
    if (record.swept_at != null) continue
    out.push({ key: match[1], path, record })
  }
  return out
}

export function classifyRecord(row) {
  if (row.reason === 'root-alive' || row.live > 0) return REAP_VERDICTS.REFUSED_LIVE
  if (row.reason === 'evidence-mismatch' || row.identity_refused > 0) return REAP_VERDICTS.REFUSED_MISMATCH
  if (row.reason === 'probe-unknown' || row.probe_unknown > 0 || row.root_liveness === LIVENESS.UNKNOWN) return REAP_VERDICTS.REFUSED_UNKNOWN
  if (row.outcome === 'proven' && row.reclaimed > 0) return REAP_VERDICTS.RECLAIMED
  return REAP_VERDICTS.EMPTY
}

function zeroVerdicts() {
  const out = {}
  for (const value of Object.values(REAP_VERDICTS)) out[value] = 0
  return out
}

export function reapTask(task, { dryRun = false, deps = {} } = {}) {
  const d = normalDeps(deps)
  const pending = pendingRecords(task.taskDir, d)
  const base = {
    id: task.id, repo: task.repo, task: task.task, taskDir: task.taskDir,
    archived: task.archived === true,
    dry_run: dryRun === true, pending: pending.length, verdicts: zeroVerdicts(), outcomes: zeroOutcomes(),
    records: 0, swept: 0, skipped: 0, retryable: 0, groups: 0, reclaimed: 0, refused: 0,
  }
  if (dryRun) {
    base.candidates = pending.map(({ record }) => ({
      key: record.key ?? null, role: record.role ?? null, seat_id: record.seat_id ?? null,
      transport: record.transport ?? null, root_pid: record.root_pid ?? null,
      groups: Array.isArray(record.groups) ? record.groups.length : 0,
    }))
    return base
  }
  const rows = []
  // No emit: a standalone sweep has no ledger phase, and reclaimDescendants
  // treats an absent emit as a granted receipt so a proven record can stamp
  // swept_at. Passing an emit that cannot record would make every pass retryable.
  const summary = d.reclaim({ taskDir: task.taskDir, log: (row) => rows.push(row), deps: reclaimDeps(d) })
  base.records = summary.records
  base.swept = summary.swept
  base.skipped = summary.skipped
  base.retryable = summary.retryable
  base.groups = summary.groups
  base.reclaimed = summary.reclaimed
  for (const row of rows) {
    if (row.event !== 'descendant-reclaim') continue
    const verdict = classifyRecord(row)
    base.verdicts[verdict] += 1
    if (REAP_ACCOUNTING.includes(row.outcome)) base.outcomes[row.outcome] += 1
    if (verdict !== REAP_VERDICTS.RECLAIMED && verdict !== REAP_VERDICTS.EMPTY) base.refused += 1
  }
  return base
}

export function reapOutcome(totals, dryRun) {
  if (dryRun) return totals.pending > 0 ? REAP_OUTCOMES.PENDING : REAP_OUTCOMES.NOTHING
  if (totals.records === 0) return REAP_OUTCOMES.NOTHING
  const reclaimed = totals.verdicts[REAP_VERDICTS.RECLAIMED]
  if (reclaimed > 0 && totals.refused > 0) return REAP_OUTCOMES.PARTIAL
  if (reclaimed > 0) return REAP_OUTCOMES.RECLAIMED
  if (totals.refused > 0) return REAP_OUTCOMES.REFUSED
  return REAP_OUTCOMES.NOTHING
}

export function reapPass({ root, dryRun = false, reclaimPaneShells = false, deps = {} } = {}) {
  const d = normalDeps(deps)
  const sweepRoot = root || crewRoot({ home: d.home })
  const tasks = candidateTasks(sweepRoot, d).map((task) => reapTask(task, { dryRun, deps: d }))
  const totals = {
    tasks: tasks.length, active_tasks: 0, archived_tasks: 0, pending: 0, records: 0, swept: 0, skipped: 0,
    retryable: 0, groups: 0, reclaimed: 0, refused: 0, verdicts: zeroVerdicts(), outcomes: zeroOutcomes(),
  }
  for (const task of tasks) {
    totals[task.archived ? 'archived_tasks' : 'active_tasks'] += 1
    for (const key of ['pending', 'records', 'swept', 'skipped', 'retryable', 'groups', 'reclaimed', 'refused']) totals[key] += task[key]
    for (const [verdict, count] of Object.entries(task.verdicts)) totals.verdicts[verdict] += count
    for (const [name, count] of Object.entries(task.outcomes)) totals.outcomes[name] += count
  }
  // The pane sweep is a SEPARATE class and may never move a descendant verdict
  // (#933 criterion (e)): it is computed after the totals are closed, it writes
  // into its own field, and a throw from it degrades to an unmeasured pane
  // report rather than into this function's result.
  // A true `dryRun` means nothing anywhere is signalled, and that has to hold
  // for a DIRECT caller of reapPass, not only for the CLI whose parseArgs
  // already refuses. Derived once, and used for the sweep AND its fallback.
  const panesReclaim = dryRun !== true && reclaimPaneShells === true
  let pane
  try { pane = panePass({ reclaim: panesReclaim, deps: d }) }
  catch { pane = unmeasuredPane(panesReclaim, PANE_UNKNOWN_REASONS.TABLE) }
  return { root: sweepRoot, dry_run: dryRun === true, tasks, totals, pane, outcome: reapOutcome(totals, dryRun === true) }
}

export function formatReport(pass) {
  const lines = [`reap: root ${pass.root}${pass.dry_run ? ' (dry-run)' : ''}`]
  for (const task of pass.tasks) {
    if (pass.dry_run) {
      const detail = (task.candidates || []).map((c) => `${c.transport}/${c.seat_id} root=${c.root_pid} groups=${c.groups}`).join('; ')
      lines.push(`reap: ${task.id}${task.archived ? ' [archived]' : ''} — pending ${task.pending}${detail ? ` (${detail})` : ''}`)
      continue
    }
    lines.push(`reap: ${task.id}${task.archived ? ' [archived]' : ''} — records ${task.records} swept ${task.swept} skipped ${task.skipped} retryable ${task.retryable} refused ${task.refused} | groups ${task.groups} reclaimed ${task.reclaimed}`)
  }
  const t = pass.totals
  lines.push(pass.dry_run
    ? `reap: totals — tasks ${t.tasks} (active ${t.active_tasks}, archived ${t.archived_tasks}) pending ${t.pending}`
    : `reap: totals — tasks ${t.tasks} (active ${t.active_tasks}, archived ${t.archived_tasks}) records ${t.records} swept ${t.swept} skipped ${t.skipped} retryable ${t.retryable} refused ${t.refused} | groups ${t.groups} reclaimed ${t.reclaimed} (live ${t.verdicts[REAP_VERDICTS.REFUSED_LIVE]}, mismatch ${t.verdicts[REAP_VERDICTS.REFUSED_MISMATCH]}, unknown ${t.verdicts[REAP_VERDICTS.REFUSED_UNKNOWN]}) | proven ${t.outcomes.proven} failed ${t.outcomes.failed} unproven ${t.outcomes.unproven}`)
  if (pass.dry_run) lines.push('reap: dry run — nothing was signalled; re-run with `npm run crew:reap -- --reclaim` to reclaim')
  if (pass.pane) lines.push(...formatPaneReport(pass.pane))
  lines.push(`reap-outcome: ${pass.outcome}`)
  return lines
}

// ---------------------------------------------------------------------------
// The pane host shell class (#933). A pane's login shell is the process cmux
// spawns to HOST a seat (`crew/crew.mjs:1937`, `cmux new-workspace`) — one
// level ABOVE anything the driver reserves, so it has no descendant
// reservation record and the sweep above is blind to it by construction, not
// by defect. It is enumerated here as a SEPARATE class with its own verdicts,
// its own report and its own opt-in selector; nothing in this block may change
// what the descendant sweep adjudicates.
//
// What `ps -o tty=` prints for a process with no controlling terminal: `??` on
// macOS, `?` on Linux, `-` on some BSDs. A row outside this set holds a live
// terminal, which is a person's shell and is never signalled (#933 ask 4).
export const NO_TTY = Object.freeze(['??', '?', '-', ''])
export const STD_FDS = Object.freeze([0, 1, 2])
export const PANE_VERDICTS = Object.freeze({
  ORPHAN: 'orphaned-pane-host-candidate',
  REFUSED_TTY: 'refused-live-tty',
  CLEAR: 'clear',
  UNKNOWN: 'unknown',
})
export const PANE_UNKNOWN_REASONS = Object.freeze({
  TABLE: 'process-table-unavailable',
  FD_PROBE: 'fd-probe-unavailable',
  FD_EMPTY: 'fd-probe-empty',
  IDENTITY: 'identity-unavailable',
})
// A destructive action is bound to a process START, never to a bare pid — the
// same binding `rootBinding` already requires of the descendant half
// (`crew/seat-io.mjs:701-705`). These are the closed reasons the pre-signal
// recheck refuses with; each one ends in no signal at all.
export const PANE_RECHECK_REFUSALS = Object.freeze({
  MISMATCH: 'identity-mismatch',
  UNREADABLE: 'identity-unreadable',
  CHANGED: 'no-longer-orphan',
  EXECED: 'no-longer-a-login-shell',
})
export const PANE_OUTCOMES = Object.freeze({
  NONE: 'no-pane-orphans',
  PENDING: 'pending-pane-orphans',
  RECLAIMED: 'pane-orphans-reclaimed',
  PARTIAL: 'pane-orphans-partial',
  UNMEASURED: 'pane-unmeasured',
})
// Stated, not omitted. This sweep proves a process is an unregistered LOGIN
// SHELL with no terminal and no standard streams; it does not prove cmux
// launched it, because nothing durable records that (the follow-up to #933).
export const PANE_PROVENANCE_BLIND_SPOT = 'provenance NOT proven — a leading dash on argv0 marks a login shell, not a cmux pane host, so a login shell this factory never launched can appear here'
// One `ps` row answers every identity question about one pid. `LC_ALL=C` is
// DECLARED so `lstart` is always the five-field C form (`Www Mmm _d HH:MM:SS
// YYYY`) and the command that follows it can be taken as the rest of the row;
// `command` is last because it is then the only column allowed to contain
// spaces. Measured on this box 2026-09-06 for pid 77238:
// `77238 77237 ttys000  Wed Sep  2 14:40:27 2026     -/opt/homebrew/bin/nu`
export const PANE_PS_IDENTITY_FORMAT = 'pid=,ppid=,tty=,lstart=,command='
export const PANE_PS_IDENTITY_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+?)\s*$/
export const PANE_PS_TIMEOUT_MS = 5000
export const PANE_LSOF_TIMEOUT_MS = 10000
export const PANE_SETTLE_MS = 250

// The settle wait is not optional in production. Without it the signal-zero
// proof races the SIGTERM that was just sent, and every delivered signal
// reports `unproven` for a shell that is in fact gone. This is a CLI that must
// not return before the kernel has had its chance, and there is no async seam
// to await here, so the wait is synchronous: `Atomics.wait` on a throwaway
// buffer is the only dependency-free way to block a Node main thread.
export function paneSleep(ms) {
  const span = Math.max(0, Number(ms) || 0)
  if (span === 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, span)
}

// The ONLY generic marker measured here: a login shell is spawned with a
// leading `-` on argv[0] — all four orphans of #933 were `-/opt/homebrew/bin/nu`.
// This repo has no configured-shell registry, so a basename allowlist would
// make every other login shell invisible BY CONSTRUCTION; the dash is what
// separates a login shell from the hundreds of ppid=1 daemons a process table
// also carries. A leading `--` is an option, not an argv0 mark.
export function isLoginShell(command) {
  const argv0 = String(command || '').trim().split(/\s+/)[0] || ''
  return argv0.length > 1 && argv0.startsWith('-') && !argv0.startsWith('--')
}

export function paneShellSnapshot(deps = {}) {
  const spawnSync = deps.spawnSync || cpSpawnSync
  let result
  try { result = spawnSync('ps', ['-eo', 'pid=,ppid=,tty=,command='], { encoding: 'utf8', timeout: PANE_PS_TIMEOUT_MS }) }
  catch { return { ok: false, rows: [] } }
  const rows = []
  for (const line of String(result?.stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
    rows.push({ pid, ppid, tty: match[3], command: match[4].trim() })
  }
  return { ok: result?.status === 0 && rows.length > 0, rows }
}

// The START binding, and the last reading that stands between a candidate and
// a SIGTERM. ONE `ps` answer supplies every part of it — presence, start,
// parent, terminal and the CURRENT command — because an identity ASSEMBLED
// from two samples is an identity of two different processes whenever the pid
// was recycled between them: the old matching START would pair with the new
// process's login-shell command and the sweep would signal it.
export function paneShellIdentity(pid, deps = {}) {
  const spawnSync = deps.spawnSync || cpSpawnSync
  const unmeasured = { ok: false, reason: PANE_UNKNOWN_REASONS.IDENTITY, present: false, ppid: null, tty: null, start: null, command: null }
  const wanted = Number(pid)
  let result
  try { result = spawnSync('ps', ['-o', PANE_PS_IDENTITY_FORMAT, '-p', String(pid)], { encoding: 'utf8', timeout: PANE_PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } }) }
  catch { return unmeasured }
  if (result?.error) return unmeasured
  const text = String(result?.stdout || '')
  // `ps` exits with EXACTLY status 1 and an EMPTY table for a pid that is
  // simply gone: that is a measured absence, and the one case where a reclaim
  // may stop without signalling and still report `proven`. Every OTHER pairing
  // of status and output — a timeout, a denied probe, a `ps` that is not on
  // PATH — is a probe that did not answer, and unknown is never a zero.
  if (result?.status === 1 && text.trim() === '') return { ok: true, reason: null, present: false, ppid: null, tty: null, start: null, command: null }
  if (result?.status !== 0) return unmeasured
  const row = text.split(/\r?\n/).find((line) => line.trim()) || ''
  // The WHOLE row validates or nothing does: pid, ppid, tty, the five `lstart`
  // fields and a command. A row that parses only in part is not an answer.
  const match = PANE_PS_IDENTITY_ROW.exec(row)
  if (!match) return unmeasured
  const seen = Number(match[1])
  const ppid = Number(match[2])
  // A table describing some OTHER process is not an answer about this one.
  if (!Number.isSafeInteger(seen) || !Number.isSafeInteger(ppid) || seen !== wanted) return unmeasured
  return { ok: true, reason: null, present: true, ppid, tty: match[3], start: match[4], command: match[5] }
}

// lsof exits 1 both when it finds nothing and when it could not finish, and the
// exit status alone cannot tell those apart. A NONZERO status is therefore
// unmeasured even when stdout carries a partial descriptor table, and a
// zero-status table with no descriptor line at all is unmeasured too: unknown
// is never a zero. The four orphans of #933 each still held nushell's own fd
// 3/4 socketpair, so a real orphan does print descriptor lines.
export function paneShellFds(pid, deps = {}) {
  const spawnSync = deps.spawnSync || cpSpawnSync
  const unmeasured = (reason) => ({ ok: false, reason, fds: [], cwd: null })
  let result
  try { result = spawnSync('lsof', ['-p', String(pid), '-Fftn'], { encoding: 'utf8', timeout: PANE_LSOF_TIMEOUT_MS }) }
  catch { return unmeasured(PANE_UNKNOWN_REASONS.FD_PROBE) }
  if (result?.error) return unmeasured(PANE_UNKNOWN_REASONS.FD_PROBE)
  if (result?.status !== 0) return unmeasured(PANE_UNKNOWN_REASONS.FD_PROBE)
  const fds = []
  let cwd = null
  let field = null
  let seen = false
  for (const line of String(result?.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('f')) {
      field = line.slice(1)
      seen = true
      if (/^\d+$/.test(field)) fds.push(Number(field))
      continue
    }
    if (line.startsWith('n') && field === 'cwd' && cwd === null) cwd = line.slice(1)
  }
  if (!seen) return unmeasured(PANE_UNKNOWN_REASONS.FD_EMPTY)
  return { ok: true, reason: null, fds, cwd }
}

// Refusal precedence first, exactly as classifyRecord does for the descendant
// half: a live controlling terminal outranks every other signal, and an
// unmeasured descriptor table outranks the orphan verdict it would support.
export function classifyPaneShell(row, probe, identity) {
  if (!NO_TTY.includes(String(row?.tty ?? ''))) return { verdict: PANE_VERDICTS.REFUSED_TTY, reason: 'controlling-tty' }
  if (row?.ppid !== 1) return { verdict: PANE_VERDICTS.CLEAR, reason: 'has-parent' }
  if (identity && identity.ok !== true) return { verdict: PANE_VERDICTS.UNKNOWN, reason: identity.reason || PANE_UNKNOWN_REASONS.IDENTITY }
  if (identity && identity.present === false) return { verdict: PANE_VERDICTS.CLEAR, reason: 'already-gone' }
  if (!probe || probe.ok !== true) return { verdict: PANE_VERDICTS.UNKNOWN, reason: probe?.reason || PANE_UNKNOWN_REASONS.FD_PROBE }
  if (STD_FDS.some((fd) => probe.fds.includes(fd))) return { verdict: PANE_VERDICTS.CLEAR, reason: 'has-standard-streams' }
  return { verdict: PANE_VERDICTS.ORPHAN, reason: null }
}

const PANE_TOTAL_KEYS = Object.freeze({
  [PANE_VERDICTS.ORPHAN]: 'orphan',
  [PANE_VERDICTS.REFUSED_TTY]: 'refused_live_tty',
  [PANE_VERDICTS.CLEAR]: 'clear',
  [PANE_VERDICTS.UNKNOWN]: 'unknown',
})

function zeroPaneTotals() {
  return { candidates: 0, orphan: 0, refused_live_tty: 0, clear: 0, unknown: 0, signalled: 0, proven: 0, unproven: 0, failed: 0, refused_recheck: 0 }
}

function unmeasuredPane(reclaim, reason) {
  return { ok: false, reason, reclaim: reclaim === true, rows: [], totals: zeroPaneTotals(), outcome: PANE_OUTCOMES.UNMEASURED }
}

// Nothing is signalled on the strength of a table read seconds ago. The whole
// adjudication is re-run against a FRESH identity immediately before the
// signal: a pid whose start differs is a reused pid, an identity that cannot be
// read is unmeasured, and a shell that has since acquired a terminal or a
// standard stream is no longer an orphan. Each ends in a closed reason and no
// signal (`crew/seat-io.mjs:701-705` is the same discipline for a root pid).
function recheckPaneShell(entry, probeFor, identityFor) {
  // The ORDER of these two readings is the guarantee, which is why one array
  // literal fixes it: production `lsof` may block for PANE_LSOF_TIMEOUT_MS, so
  // whichever reading is taken first is stale by exactly that long when the
  // signal goes out. The identity — start, parent, terminal and the CURRENT
  // command — is therefore taken LAST, immediately before the SIGTERM.
  const [probe, fresh] = [probeFor(entry.pid), identityFor(entry.pid)]
  if (!fresh || fresh.ok !== true) return { refused: PANE_RECHECK_REFUSALS.UNREADABLE, gone: false }
  if (fresh.present !== true) return { refused: null, gone: true }
  if (fresh.start !== entry.start) return { refused: PANE_RECHECK_REFUSALS.MISMATCH, gone: false }
  // The CURRENT command, never the enumerated one: a pid that kept its start
  // but exec'd another program is no longer the thing that was adjudicated.
  if (!isLoginShell(fresh.command)) return { refused: PANE_RECHECK_REFUSALS.EXECED, gone: false }
  const again = classifyPaneShell({ ppid: fresh.ppid, tty: fresh.tty, command: fresh.command }, probe, fresh)
  if (again.verdict !== PANE_VERDICTS.ORPHAN) return { refused: PANE_RECHECK_REFUSALS.CHANGED, gone: false }
  return { refused: null, gone: false }
}

// The same proven/unproven accounting the descendant half already keeps
// (REAP_ACCOUNTING): a shell that was signalled but could not be PROVEN gone is
// reported unproven, never assumed dead.
// `signalled` is owned here, because only here is it known whether the kernel
// took the signal: an ESRCH at the SIGTERM itself means the process was already
// gone and NOTHING was delivered. The reclaim is still `proven`; the
// accounting simply may not claim a signal that was refused.
function settlePaneShell(pid, kill, d) {
  try { kill(pid, 'SIGTERM') }
  catch (err) {
    if (err?.code === 'ESRCH') return { signalled: false, outcome: 'proven', reason: 'already-gone' }
    return { signalled: false, outcome: 'failed', reason: err?.code || 'signal-failed' }
  }
  ;(d.sleep || d.paneSleep)(PANE_SETTLE_MS)
  try { kill(pid, 0); return { signalled: true, outcome: 'unproven', reason: 'still-present' } }
  catch (err) { return err?.code === 'ESRCH' ? { signalled: true, outcome: 'proven', reason: null } : { signalled: true, outcome: 'unproven', reason: err?.code || 'probe-failed' } }
}

function reclaimPaneShell(entry, kill, d, probeFor, identityFor) {
  const recheck = recheckPaneShell(entry, probeFor, identityFor)
  if (recheck.gone === true) return { signalled: false, outcome: 'proven', reason: 'already-gone' }
  if (recheck.refused) return { signalled: false, outcome: 'refused_recheck', reason: recheck.refused }
  return settlePaneShell(entry.pid, kill, d)
}

// An outcome may never read clean over evidence the sweep did not gather: a
// candidate counted `unknown` keeps NONE and RECLAIMED off the table, because
// both of those say the sweep LOOKED. Unknown is never a zero.
export function paneOutcome(totals, reclaim) {
  if (totals.orphan === 0) return totals.unknown > 0 ? PANE_OUTCOMES.UNMEASURED : PANE_OUTCOMES.NONE
  if (!reclaim) return PANE_OUTCOMES.PENDING
  return totals.unknown === 0 && totals.proven === totals.orphan ? PANE_OUTCOMES.RECLAIMED : PANE_OUTCOMES.PARTIAL
}

export function panePass({ reclaim = false, deps = {} } = {}) {
  const d = normalDeps(deps)
  const snapshot = d.paneSnapshot || (() => paneShellSnapshot(d))
  let snap
  try { snap = snapshot() } catch { snap = null }
  if (snap?.ok !== true) return unmeasuredPane(reclaim, PANE_UNKNOWN_REASONS.TABLE)
  const probeFor = d.fdProbe || ((pid) => paneShellFds(pid, d))
  const identityFor = d.identityProbe || ((pid) => paneShellIdentity(pid, d))
  const kill = guardedKill(d.kill || ((pid, signal) => process.kill(pid, signal)))
  const totals = zeroPaneTotals()
  const rows = []
  for (const row of Array.isArray(snap.rows) ? snap.rows : []) {
    if (!isLoginShell(row?.command)) continue
    // The two subprocess probes are the expensive half, so they run only for a
    // shell the cheap `ps` columns have already narrowed to a candidate.
    const suspect = NO_TTY.includes(String(row?.tty ?? '')) && row?.ppid === 1
    let identity = null
    let probe = null
    if (suspect) {
      try { probe = probeFor(row.pid) } catch { probe = { ok: false, reason: PANE_UNKNOWN_REASONS.FD_PROBE, fds: [], cwd: null } }
      try { identity = identityFor(row.pid) } catch { identity = { ok: false, reason: PANE_UNKNOWN_REASONS.IDENTITY, present: false, ppid: null, tty: null, start: null, command: null } }
    }
    const measured = identity?.present === true ? { ...row, ppid: identity.ppid, tty: identity.tty } : row
    const { verdict, reason } = classifyPaneShell(measured, probe, identity)
    const cwd = probe?.ok === true ? (probe.cwd ?? null) : null
    const entry = {
      pid: row.pid,
      ppid: measured.ppid,
      tty: String(measured.tty ?? ''),
      command: String(row.command ?? ''),
      start: identity?.ok === true ? identity.start : null,
      verdict,
      reason,
      fds: probe?.ok === true ? [...probe.fds] : null,
      cwd,
      cwd_present: cwd === null ? null : d.existsSync(cwd) === true,
      signalled: false,
      outcome: null,
    }
    totals.candidates += 1
    totals[PANE_TOTAL_KEYS[verdict]] += 1
    // Fail CLOSED: only a candidate ADJUDICATED an orphan reaches the reclaim
    // path at all, so a person's live terminal and an unmeasured candidate are
    // both spared by the classifier's own verdict rather than by a second,
    // forgettable guard — and the reclaim path then re-proves it from scratch.
    if (reclaim === true && verdict === PANE_VERDICTS.ORPHAN) {
      const settled = reclaimPaneShell(entry, kill, d, probeFor, identityFor)
      entry.signalled = settled.signalled === true
      entry.outcome = settled.outcome
      entry.reason = settled.reason ?? entry.reason
      if (entry.signalled) totals.signalled += 1
      totals[settled.outcome] += 1
    }
    rows.push(entry)
  }
  return { ok: true, reason: null, reclaim: reclaim === true, rows, totals, outcome: paneOutcome(totals, reclaim === true) }
}

export function formatPaneReport(pane) {
  if (!pane || pane.ok !== true) {
    return [
      `reap: pane hosts — UNMEASURED [reason: ${pane?.reason || PANE_UNKNOWN_REASONS.TABLE}]; no pane host shell was swept, and this is a stated blind spot, not a clear`,
      `pane-outcome: ${pane?.outcome || PANE_OUTCOMES.UNMEASURED}`,
    ]
  }
  const t = pane.totals
  const lines = [`reap: pane hosts — candidates ${t.candidates} (orphan ${t.orphan}, refused-live-tty ${t.refused_live_tty}, clear ${t.clear}, unknown ${t.unknown}) — ${PANE_PROVENANCE_BLIND_SPOT}`]
  for (const row of pane.rows) {
    const fdText = row.fds === null ? 'unmeasured' : row.fds.length === 0 ? 'none' : row.fds.join(',')
    const cwdText = row.cwd === null ? 'unmeasured' : `${row.cwd}${row.cwd_present === false ? ' (unlinked)' : ''}`
    lines.push(`reap: pane ${row.verdict} pid ${row.pid} ppid ${row.ppid} tty ${row.tty || '??'} fds ${fdText} cwd ${cwdText}${row.reason ? ` [reason: ${row.reason}]` : ''} — ${row.command}`)
  }
  if (t.orphan > 0 && pane.reclaim !== true) lines.push('reap: pane dry run — nothing was signalled; re-run with `npm run crew:reap -- --reclaim --reclaim-pane-shells` to reclaim')
  if (pane.reclaim === true) lines.push(`reap: pane totals — signalled ${t.signalled} proven ${t.proven} unproven ${t.unproven} failed ${t.failed} refused-recheck ${t.refused_recheck}`)
  lines.push(`pane-outcome: ${pane.outcome}`)
  return lines
}

export function parseArgs(argv) {
  const flags = { dryRun: true, reclaimPaneShells: false, root: null, help: false }
  let reclaim = false
  let reclaimPane = false
  let explicitDryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') { explicitDryRun = true; continue }
    if (argument === '--reclaim') { reclaim = true; continue }
    if (argument === '--reclaim-pane-shells') { reclaimPane = true; continue }
    if (argument === '--help' || argument === '-h') { flags.help = true; continue }
    if (argument === '--root') {
      const value = argv[index + 1]
      if (value == null || value.startsWith('--')) throw new ReapUsageError('reap: --root requires a value', 'missing-value')
      flags.root = value
      index += 1
      continue
    }
    throw new ReapUsageError(`reap: unknown option: ${argument}`, 'unknown-option')
  }
  // Safe by construction: only --reclaim turns the sweep destructive, and an
  // explicit --dry-run wins over it in either order (#439).
  flags.dryRun = explicitDryRun || !reclaim
  // Signalling a pane host shell needs BOTH keys. `--reclaim` stays the one
  // global destructive key and keeps its descendant-only meaning;
  // `--reclaim-pane-shells` is the additional class selector and is report-only
  // on its own. So `dryRun` remains a truthful WHOLE-COMMAND invariant: when it
  // is true, nothing anywhere is signalled.
  let paneReclaim = reclaimPane
  if (!reclaim) paneReclaim = false
  if (explicitDryRun) paneReclaim = false
  flags.reclaimPaneShells = paneReclaim
  return flags
}

export const USAGE = 'usage: npm run crew:reap -- [--reclaim] [--reclaim-pane-shells] [--dry-run] [--root <crew-root>] (default: dry run — nothing is signalled without --reclaim; a pane host shell also needs --reclaim-pane-shells)'

export async function main(argv, deps = {}) {
  const d = normalDeps(deps)
  try {
    const flags = parseArgs(argv)
    if (flags.help) { d.stdout(`${USAGE}\n`); return 0 }
    const root = flags.root || crewRoot({ home: d.home })
    if (!d.existsSync(root)) {
      d.stderr(`reap: no crew root at ${root} [reason: absent-root]\n`)
      return 2
    }
    const pass = reapPass({ root, dryRun: flags.dryRun, reclaimPaneShells: flags.reclaimPaneShells, deps: d })
    for (const line of formatReport(pass)) d.stdout(`${line}\n`)
    return 0
  } catch (err) {
    if (err instanceof ReapUsageError) {
      d.stderr(`${err.message} [reason: ${err.reason}]\n${USAGE}\n`)
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
