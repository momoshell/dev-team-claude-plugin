import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isObject, within } from './lane-core.mjs'

// A historical marker binds the record, but only the current leader's command and
// start time can distinguish it from a group which later reused the same pgid.
export function reapLaneSeats({ dir, alive, kill, spawnSync, sleep, now }) {
  const stopped = [], unproven = [], records = [], groups = new Map()
  const unreadable = (path) => unproven.push({ role: path, pgid: null })
  const list = (path) => {
    try {
      lstatSync(path)
      if (!within(dir, path)) { unreadable(path); return [] }
      return readdirSync(path).sort()
    } catch (error) {
      if (error?.code !== 'ENOENT') unreadable(path)
      return []
    }
  }
  const runtime = join(dir, 'seat-runtime')
  for (const seat of list(runtime).filter((name) => name.startsWith('acp-seat-'))) {
    const seatDir = join(runtime, seat), acp = join(seatDir, 'acp')
    try {
      lstatSync(seatDir)
      if (!within(dir, seatDir)) { unreadable(seatDir); continue }
    } catch (error) { if (error?.code !== 'ENOENT') unreadable(seatDir); continue }
    for (const role of list(acp).filter((name) => !name.startsWith('.'))) {
      const file = join(acp, role, 'pgid'), markerFile = join(acp, `.${role}.active.json`)
      try { lstatSync(file) } catch (error) { if (error?.code !== 'ENOENT') unreadable(file); continue }
      if (!within(dir, file)) { unreadable(file); continue }
      let pgid
      try { pgid = Number(readFileSync(file, 'utf8').trim()) } catch { unreadable(file); continue }
      const record = { role, pgid, file, valid: false }
      records.push(record)
      if (!Number.isSafeInteger(pgid) || pgid <= 1) continue
      if (!groups.has(pgid)) groups.set(pgid, [])
      groups.get(pgid).push(record)
      let marker
      try {
        if (!within(dir, markerFile)) throw new Error('outside lane')
        marker = JSON.parse(readFileSync(markerFile, 'utf8'))
      } catch { continue }
      if (!isObject(marker) || marker.evidence?.kind !== 'pgid' || marker.evidence?.file !== file || marker.pid !== pgid || marker.phase !== 'running' || marker.dir !== dirname(file) || !Number.isSafeInteger(marker.owner?.pid) || marker.owner.pid <= 0 || ![marker.startedAt, marker.owner.startedAt, marker.at].every(Number.isFinite)) continue
      try { if (alive(marker.owner.pid) !== false) continue } catch { continue }
      record.marker = marker
      record.valid = true
    }
  }
  const probe = (record) => {
    try {
      const pgid = Number(readFileSync(record.file, 'utf8').trim())
      if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid !== record.pgid) return 'unknown'
      try { kill(-pgid, 0); return 'alive' } catch (error) { return error?.code === 'ESRCH' ? 'dead' : error?.code === 'EPERM' ? 'alive' : 'unknown' }
    } catch { return 'unknown' }
  }
  const identity = (record) => {
    let result
    try { result = spawnSync('ps', ['-ww', '-o', 'pid=,pgid=,lstart=,command=', '-p', String(record.pgid)], { encoding: 'utf8', timeout: 1000 }) } catch { return false }
    if (!result || result.error || result.status !== 0) return false
    return String(result.stdout ?? '').split('\n').some((line) => {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 8 || Number(parts[0]) !== record.pgid || Number(parts[1]) !== record.pgid) return false
      const start = Date.parse(parts.slice(2, 7).join(' ')), command = parts.slice(7).join(' '), marker = record.marker
      return Number.isFinite(start) && start >= Math.min(marker.startedAt, marker.owner.startedAt) - 2000 && start <= marker.at + 2000 && (command.includes(record.file) || command.includes(marker.dir))
    })
  }
  const seen = new Set()
  for (const record of records) {
    const { role, pgid } = record
    if (Number.isSafeInteger(pgid) && pgid > 1) {
      if (seen.has(pgid)) continue
      seen.add(pgid)
    }
    if (!record.valid || groups.get(pgid)?.some((item) => !item.valid)) { unproven.push({ role, pgid }); continue }
    let state = probe(record)
    if (state === 'dead') continue
    if (state !== 'alive' || !identity(record)) { unproven.push({ role, pgid }); continue }
    state = probe(record)
    if (state === 'dead') continue
    if (state !== 'alive') { unproven.push({ role, pgid }); continue }
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { kill(-pgid, signal) } catch (error) { if (error?.code === 'ESRCH') { state = 'dead'; break } }
      const deadline = now() + 5000
      for (let poll = 0; poll <= 200 && now() < deadline; poll++) {
        state = probe(record)
        if (state !== 'alive') break
        sleep(25)
      }
      if (state !== 'alive') break
    }
    ;(state === 'dead' ? stopped : unproven).push({ role, pgid })
  }
  return { stopped, unproven }
}
