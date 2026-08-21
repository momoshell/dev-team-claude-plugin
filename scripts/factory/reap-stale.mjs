#!/usr/bin/env node
// scripts/factory/reap-stale.mjs — the stale-descendant sweep (#419, layer 3).
// REFERENCE IMPLEMENTATION authored by the planner and proven against gate.mjs
// (12/13 green; A13 needs the lane test file). Every LITERAL anchor in plan.md
// appears here verbatim. The builder may adopt it, but owns its correctness.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync } from 'node:fs'
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
    now: deps.now || null,
    uuid: deps.uuid || null,
    reclaim: deps.reclaim || reclaimDescendants,
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
      if (isArchived(task.name)) continue
      const dir = join(root, repo.name, task.name)
      const taskDir = join(dir, 'task')
      if (!d.existsSync(join(taskDir, DESCENDANT_DIR))) continue
      out.push({ id: `${repo.name}/${task.name}`, repo: repo.name, task: task.name, dir, taskDir })
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
    dry_run: dryRun === true, pending: pending.length, verdicts: zeroVerdicts(),
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

export function reapPass({ root, dryRun = false, deps = {} } = {}) {
  const d = normalDeps(deps)
  const sweepRoot = root || crewRoot({ home: d.home })
  const tasks = candidateTasks(sweepRoot, d).map((task) => reapTask(task, { dryRun, deps: d }))
  const totals = {
    tasks: tasks.length, pending: 0, records: 0, swept: 0, skipped: 0,
    retryable: 0, groups: 0, reclaimed: 0, refused: 0, verdicts: zeroVerdicts(),
  }
  for (const task of tasks) {
    for (const key of ['pending', 'records', 'swept', 'skipped', 'retryable', 'groups', 'reclaimed', 'refused']) totals[key] += task[key]
    for (const [verdict, count] of Object.entries(task.verdicts)) totals.verdicts[verdict] += count
  }
  return { root: sweepRoot, dry_run: dryRun === true, tasks, totals, outcome: reapOutcome(totals, dryRun === true) }
}

export function formatReport(pass) {
  const lines = [`reap: root ${pass.root}${pass.dry_run ? ' (dry-run)' : ''}`]
  for (const task of pass.tasks) {
    if (pass.dry_run) {
      const detail = (task.candidates || []).map((c) => `${c.transport}/${c.seat_id} root=${c.root_pid} groups=${c.groups}`).join('; ')
      lines.push(`reap: ${task.id} — pending ${task.pending}${detail ? ` (${detail})` : ''}`)
      continue
    }
    lines.push(`reap: ${task.id} — records ${task.records} swept ${task.swept} skipped ${task.skipped} retryable ${task.retryable} refused ${task.refused} | groups ${task.groups} reclaimed ${task.reclaimed}`)
  }
  const t = pass.totals
  lines.push(pass.dry_run
    ? `reap: totals — tasks ${t.tasks} pending ${t.pending}`
    : `reap: totals — tasks ${t.tasks} records ${t.records} swept ${t.swept} skipped ${t.skipped} retryable ${t.retryable} refused ${t.refused} | groups ${t.groups} reclaimed ${t.reclaimed} (live ${t.verdicts[REAP_VERDICTS.REFUSED_LIVE]}, mismatch ${t.verdicts[REAP_VERDICTS.REFUSED_MISMATCH]}, unknown ${t.verdicts[REAP_VERDICTS.REFUSED_UNKNOWN]})`)
  lines.push(`reap-outcome: ${pass.outcome}`)
  return lines
}

export function parseArgs(argv) {
  const flags = { dryRun: false, root: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') { flags.dryRun = true; continue }
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
  return flags
}

export const USAGE = 'usage: npm run crew:reap -- [--dry-run] [--root <crew-root>]'

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
    const pass = reapPass({ root, dryRun: flags.dryRun, deps: d })
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
