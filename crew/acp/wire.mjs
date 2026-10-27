// Wire helpers: shell quoting, LF frame splitting and seat command-channel paths.
// Node builtins only, so the lean path owns them without the old driver.
import { lstatSync as fsLstatSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

// Quote one shell argument. The returned token is safe to interpolate into
// the detached /bin/sh -c wrapper, while the worker itself receives argv.
export function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export const SEAT_COMMAND_FILE = 'cmd.fifo'
// Keep FIFOs outside crew/task trees: BSD recursive grep blocks opening them.
// Headless-rpc keys by crew dir, ACP by task dir. The key is a readable prefix
// (at most 48 chars, so it stays under NAME_MAX) plus 128 bits of the
// resolved-path hash, which keeps same-named lanes apart. The full path is at
// most len(root) + len(role) + 101 bytes; FIFOs have no sun_path limit.
export function seatCommandPath(crewDir, role, root) {
  if (typeof root !== 'string' || root === '') throw new TypeError('seat command root is required')
  const resolved = resolve(crewDir)
  const key = `${(basename(resolved) || 'lane').slice(0, 48)}-${createHash('sha256').update(resolved).digest('hex').slice(0, 32)}`
  // Resolved, so the opened FIFO and its fifo-path record are absolute even under a relative TMPDIR.
  return resolve(root, 'crew-rpc', key, role, SEAT_COMMAND_FILE)
}
// Legacy command path inside the crew dir.
export function inCrewSeatCommandPath(crewDir, role) {
  return join(crewDir, 'rpc', role, SEAT_COMMAND_FILE)
}
// A shared tmpdir may contain a co-tenant's node that mkfifo leaves in place.
// Require an owned, private crew-rpc directory before using a command channel.
export function seatCommandRootPrivate(root, uid = process.getuid()) {
  if (typeof root !== 'string' || root === '') throw new TypeError('seat command root is required')
  try {
    const top = fsLstatSync(join(root, 'crew-rpc'))
    return top.isDirectory() && top.uid === uid && (top.mode & 0o077) === 0
  } catch { return false }
}

// Do not use node:readline here. captures/pi-b5-readline-trap.txt has two
// LF-delimited records, while readline incorrectly exposes three around U+2028.
export function splitFrames(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8')
  const lines = []
  let start = 0
  for (;;) {
    const nl = input.indexOf(0x0a, start)
    if (nl < 0) break
    let line = input.subarray(start, nl).toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    lines.push(line)
    start = nl + 1
  }
  return { lines, rest: input.subarray(start) }
}
