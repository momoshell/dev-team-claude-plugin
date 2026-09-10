// One JSON leaf reader shared by the crew's six callers. The three states are
// ABSENT for no path or no file, UNREADABLE for bytes that cannot be read or
// parsed, and VALUE for bytes that parse; readJsonTri projects those to null,
// undefined, or the parsed value, while readJsonAt preserves the distinctions
// and the raw bytes for callers that need them.
// There is no leaf shape filter: seat-io accepts arrays and daemon's isObject
// rejects them, so each caller keeps its own filter at its own call site.
// A file containing literal null is indistinguishable from absent through
// readJsonTri, as every collapsing copy was; readJsonAt preserves that VALUE
// state and raw bytes, which is why reclaim uses readJsonAt.
// existsSync is called WITHOUT a try because reclaim catches that throw and
// maps it to unreadable; the two callers that swallow it keep that policy at
// their own call sites rather than collapsing it here into absent.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'

export const JSON_STATES = Object.freeze({ ABSENT: 'absent', UNREADABLE: 'unreadable', VALUE: 'value' })

export function resolveSupersedingJsonPath(path, deps = {}) {
  if (!path) return path
  if (!deps.journalPath) return path
  const read = deps.readFileSync || fsReadFileSync
  let journal
  try { journal = String(read(deps.journalPath, 'utf8')) } catch { return path }
  if (!journal) return path
  let successor = path
  for (const line of journal.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event !== 'envelope-reask' || row?.outcome !== 'recovered' || row?.unusable_return_path !== path) continue
    if (typeof row.superseding_return_path !== 'string' || row.superseding_return_path.trim() === '') continue
    successor = row.superseding_return_path
  }
  return successor
}

export function readJsonAt(path, deps = {}) {
  const target = resolveSupersedingJsonPath(path, deps)
  const exists = deps.existsSync || fsExistsSync
  const read = deps.readFileSync || fsReadFileSync
  if (!target) return { state: JSON_STATES.ABSENT, raw: null, value: null }
  if (!exists(target)) return { state: JSON_STATES.ABSENT, raw: null, value: null }
  let raw
  try { raw = String(read(target, 'utf8')) } catch { return { state: JSON_STATES.UNREADABLE, raw: null, value: null } }
  try { return { state: JSON_STATES.VALUE, raw, value: JSON.parse(raw) } }
  catch { return { state: JSON_STATES.UNREADABLE, raw, value: null } }
}

export function readJsonTri(path, deps = {}) {
  const result = readJsonAt(path, deps)
  if (result.state === JSON_STATES.ABSENT) return null
  if (result.state === JSON_STATES.UNREADABLE) return undefined
  return result.value
}
