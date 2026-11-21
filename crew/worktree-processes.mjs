import { spawnSync } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'

const linux = process.platform === 'linux'
const mac = process.platform === 'darwin'
const real = (path) => {
  try { return realpathSync.native(path) } catch { return null }
}
const pidOk = (pid) => Number.isSafeInteger(pid) && pid > 0

function output(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
  return !result.error && result.status === 0 ? result.stdout : ''
}

function macExecutables(select) {
  const entries = new Map()
  for (const line of output('/bin/ps', [...select, '-o', 'pid=,comm=']).split('\n')) {
    const match = /^\s*(\d+)\s+(\/.*)$/.exec(line)
    if (match) entries.set(Number(match[1]), real(match[2]))
  }
  return entries
}

function macCwds() {
  const entries = new Map()
  let pid
  for (const field of output('/usr/sbin/lsof', ['-nP', '-d', 'cwd', '-F0pn']).split('\0')) {
    const entry = field.replace(/^\n/, '')
    const kind = entry[0], value = entry.slice(1)
    if (kind === 'p') pid = Number(value)
    if (kind === 'n' && pidOk(pid) && isAbsolute(value)) entries.set(pid, real(value))
  }
  return entries
}

export function reapWorktreeProcesses(worktree, { alive, sleep, now }) {
  const stopped = [], unproven = [], cwdOnly = [], matches = []
  const root = real(worktree)
  const inside = (path) => path && (path === root || path.startsWith(`${root}${sep}`))
  let cwdsChecked = false
  if (root && linux) {
    let entries = []
    try { entries = readdirSync('/proc') } catch { /* procfs unavailable */ }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name), cwd = real(`/proc/${pid}/cwd`)
      if (cwd) cwdsChecked = true
      if (!pidOk(pid) || pid === process.pid) continue
      const executable = real(`/proc/${pid}/exe`)
      if (inside(executable)) matches.push({ pid, executable })
      else if (executable && inside(cwd)) cwdOnly.push({ pid, cwd })
    }
  } else if (root && mac) {
    const executables = macExecutables(['-axww']), cwds = macCwds()
    cwdsChecked = [...cwds.values()].some(Boolean)
    for (const [pid, executable] of executables) {
      if (!pidOk(pid) || pid === process.pid) continue
      if (inside(executable)) matches.push({ pid, executable })
      else if (executable && inside(cwds.get(pid))) cwdOnly.push({ pid, cwd: cwds.get(pid) })
    }
  }

  // Missing executable evidence (including an unresolvable path) never authorizes a signal.
  // Recheck the exact path before each signal. The OS can still reuse a PID between check and signal.
  let pending = matches
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    pending = pending.filter(({ pid, executable }) => {
      const current = linux ? real(`/proc/${pid}/exe`) : macExecutables(['-ww', '-p', String(pid)]).get(pid)
      if (current !== executable) return false
      try { process.kill(pid, signal) } catch { /* probe below; delivery alone proves nothing */ }
      return true
    })
    // Use the seat reaper's grace and polling interval for each round, shared by all matches.
    const deadline = now() + 5000
    for (let poll = 0; pending.length && poll <= 200 && now() < deadline; poll++) {
      pending = pending.filter(({ pid }) => alive(pid) === true)
      if (pending.length) sleep(25)
    }
  }
  for (const record of matches) (alive(record.pid) === false ? stopped : unproven).push(record)
  return { stopped, unproven, cwdOnly, cwdsChecked }
}
