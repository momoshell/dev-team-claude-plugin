#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The three census transports this readout admits, read by own key only so an inherited
// name such as `__proto__` is a miss rather than a match.
export const TRANSPORT_AGENTS = Object.freeze({ 'headless-rpc': 'pi', 'headless-json': 'claude', acp: 'acp' })
const agentOf = (transport) => (Object.hasOwn(TRANSPORT_AGENTS, transport) ? TRANSPORT_AGENTS[transport] : undefined)
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/

function args(argv) {
  let root = join(homedir(), '.crew'), since = -Infinity
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = argv[++i]
    else if (argv[i] === '--since' && argv[i + 1]) {
      const text = argv[++i]
      const value = ISO_TIMESTAMP.test(text) ? Date.parse(text) : NaN
      if (!Number.isFinite(value)) throw new Error('--since must be an ISO timestamp')
      since = value
    } else throw new Error(`unknown or malformed option: ${argv[i]}`)
  }
  return { root, since }
}

export function report(root, since = -Infinity) {
  const groups = new Map(), unreadable = [], parseErrors = [], traversalErrors = [], timestampErrors = []
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) }
    catch (error) { traversalErrors.push(`${dir}: ${error.message}`); continue }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.name === 'journal.jsonl') {
        let text
        try { text = readFileSync(path, 'utf8') } catch (error) { unreadable.push(path); continue }
        for (const [index, line] of text.split('\n').entries()) {
          if (!line.trim()) continue
          let value
          try { value = JSON.parse(line) } catch (error) { parseErrors.push(`${path}:${index + 1}`); continue }
          const row = value?.seat_turn_census
          const agent = agentOf(row?.transport)
          if (!agent || !row) continue
          const stamp = typeof value.at === 'number' ? value.at : Date.parse(value.at)
          if (!Number.isFinite(stamp)) { timestampErrors.push(`${path}:${index + 1}`); continue }
          if (stamp < since) continue
          const key = `${agent}\0${row.role ?? 'unknown'}`
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(row)
        }
      } else if (entry.isDirectory()) pending.push(path)
    }
  }
  for (const [key, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [agent, role] = key.split('\0')
    const measured = rows.filter((row) => Array.isArray(row.skill_reads))
    const denominator = measured.length
    const any = measured.filter((row) => row.skill_reads.length > 0).length
    console.log(`${agent} ${role}: ${any} of ${denominator} measured; ${rows.length - denominator} unmeasured`)
    const counts = new Map()
    for (const row of measured) for (const skill of new Set(row.skill_reads)) counts.set(skill, (counts.get(skill) ?? 0) + 1)
    for (const [skill, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) console.log(`${agent} ${role} ${skill}: ${count} of ${denominator}`)
  }
  if (unreadable.length) console.error(`${unreadable.length} unreadable journals: ${unreadable.join(', ')}`)
  if (parseErrors.length) console.error(`${parseErrors.length} journal parse failures: ${parseErrors.join(', ')}`)
  if (traversalErrors.length) console.error(`${traversalErrors.length} root traversal errors: ${traversalErrors.join(', ')}`)
  if (timestampErrors.length) console.error(`${timestampErrors.length} census timestamps missing or invalid: ${timestampErrors.join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const options = args(process.argv.slice(2)); report(options.root, options.since) }
  catch (error) { console.error(error.message); process.exitCode = 2 }
}
