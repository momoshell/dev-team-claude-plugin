// Read a JSON leaf as ABSENT, UNREADABLE or VALUE, preserving raw bytes.
// No leaf shape filter is applied; callers decide what values they accept.
// existsSync is called without a try because reclaim catches that throw and
// maps it to unreadable.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'

export const JSON_STATES = Object.freeze({ ABSENT: 'absent', UNREADABLE: 'unreadable', VALUE: 'value' })

export function readJsonAt(path, deps = {}) {
  const exists = deps.existsSync || fsExistsSync
  const read = deps.readFileSync || fsReadFileSync
  if (!path) return { state: JSON_STATES.ABSENT, raw: null, value: null }
  if (!exists(path)) return { state: JSON_STATES.ABSENT, raw: null, value: null }
  let raw
  try { raw = String(read(path, 'utf8')) } catch { return { state: JSON_STATES.UNREADABLE, raw: null, value: null } }
  try { return { state: JSON_STATES.VALUE, raw, value: JSON.parse(raw) } }
  catch { return { state: JSON_STATES.UNREADABLE, raw, value: null } }
}
