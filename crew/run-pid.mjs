import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateless, supersededReturn } from './lean-journal-order.mjs'

const RUN_PID_FILE = 'run.pid'
export function parsePidRecord(text) {
  const match = /^(\d+)(?: (\d+))?\n?$/.exec(text)
  const pid = Number(match?.[1])
  if (!match || !Number.isSafeInteger(pid) || pid <= 0 || (match[2] !== undefined && !Number.isSafeInteger(Number(match[2])))) return null
  return match[2] === undefined ? { pid } : { pid, startedAt: Number(match[2]) }
}
export const pidRecord = (pid, startedAt) => Number.isFinite(startedAt) ? `${pid} ${startedAt}\n` : `${pid}\n`
export const selfStartedAt = () => Math.round(performance.timeOrigin)

export function probeAlive(pid, startedAt, ps = spawnSync) {
  let alive
  try { process.kill(pid, 0); alive = true } catch (error) {
    if (error?.code === 'ESRCH') return false
    alive = null
  }
  if (Number.isFinite(startedAt)) {
    const result = ps('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } })
    const start = result.status === 0 ? Date.parse(`${result.stdout.trim()} UTC`) : NaN
    if (!Number.isFinite(start)) return null
    if (Math.abs(start - startedAt) > 2000) return false
  }
  return alive
}
export function writeRunPid(taskDir, pid, { writeFileSync: write = writeFileSync, rmSync: rm = rmSync } = {}, startedAt) {
  const path = join(taskDir, RUN_PID_FILE)
  try { write(path, pidRecord(pid, startedAt)); return true } catch {
    try { rm(path, { force: true }) } catch { /* best effort */ }
    return false
  }
}
function openTail(rows) {
  const last = rows.findLast((row, index) => !stateless(rows, row, index) && !supersededReturn(rows, row, index))
  return !!last && !(last.event === 'verdict' && last.status === 'stopped') && last.event !== 'pr'
    && last.event !== 'finish-ready' && !(last.event === 'finish-decision' && last.choice !== 'return')
}
export function deadRun({ rows, taskDir, readFileSync: read = readFileSync, alive = probeAlive }) {
  try {
    if (!openTail(rows)) return null
    const text = read(join(taskDir, RUN_PID_FILE), 'utf8')
    const record = parsePidRecord(text)
    if (!record || alive(record.pid, record.startedAt) !== false) return null
    return record
  } catch { return null }
}
