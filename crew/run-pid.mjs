import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { supersededReturn } from '../visualizer/server/lean-journal-order.mjs'

const RUN_PID_FILE = 'run.pid'
export function probeAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'ESRCH' ? false : null }
}
export function writeRunPid(taskDir, pid, { writeFileSync: write = writeFileSync, rmSync: rm = rmSync } = {}) {
  const path = join(taskDir, RUN_PID_FILE)
  try { write(path, `${pid}\n`); return true } catch {
    try { rm(path, { force: true }) } catch { /* best effort */ }
    return false
  }
}
function openTail(rows) {
  const last = rows.findLast((row, index) => row?.event !== 'stage-end' && !supersededReturn(rows, row, index))
  return !!last && !(last.event === 'verdict' && last.status === 'stopped') && last.event !== 'pr'
    && last.event !== 'finish-ready' && !(last.event === 'finish-decision' && last.choice !== 'return')
}
export function deadRun({ rows, taskDir, readFileSync: read = readFileSync, alive = probeAlive }) {
  try {
    if (!openTail(rows)) return null
    const text = read(join(taskDir, RUN_PID_FILE), 'utf8')
    const pid = Number(text.trim())
    if (!/^\d+\n?$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0 || alive(pid) !== false) return null
    return { pid }
  } catch { return null }
}
