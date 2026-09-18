#!/usr/bin/env node
// lean-debt — harvest every `lean:` ceiling marker into one ledger, so a deliberate
// shortcut cannot quietly become permanent. Reads and reports; changes nothing.
//
// The marker convention (crew/roles/_shared.md): `lean: <ceiling>, <upgrade path>` in a
// comment. Only a comment-prefixed marker counts — prose that merely mentions the
// convention is not debt. A marker with no comma-separated upgrade path is `no-trigger`:
// those are the ones that rot.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// A comment prefix preceded by a quote, backtick or slash is INSIDE a string, template or
// regex literal — an example or a fixture, not debt. Block-comment continuation  is
// too loose a prefix (it matches inside regex source) and is not one.
export const MARKER = /(?<!['"`\/])(?:\/\/|#|\/\*|<!--)\s*lean:\s*(.+?)\s*(?:\*\/|-->)?\s*$/
export const SKIP_DIRS = Object.freeze(new Set(['node_modules', '.git', 'dist', 'returns', '.crew']))
export const TEXT_EXT = /\.(?:mjs|cjs|js|ts|svelte|md|json|sh|yml|yaml|css|html)$/

export function parseMarker(text) {
  const m = MARKER.exec(text)
  if (!m) return null
  const body = m[1].trim()
  const comma = body.indexOf(',')
  if (comma === -1) return { ceiling: body, upgrade: null, tag: 'no-trigger' }
  const upgrade = body.slice(comma + 1).trim()
  return { ceiling: body.slice(0, comma).trim(), upgrade: upgrade || null, tag: upgrade ? null : 'no-trigger' }
}

export function* walk(root, dir = root) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) yield* walk(root, p)
    else if (TEXT_EXT.test(name)) yield p
  }
}

export function harvest(root) {
  const rows = []
  for (const file of walk(root)) {
    let lines; try { lines = readFileSync(file, 'utf8').split('\n') } catch { continue }
    lines.forEach((line, i) => {
      const parsed = parseMarker(line)
      if (parsed) rows.push({ file: relative(root, file).replaceAll('\\', '/'), line: i + 1, ...parsed })
    })
  }
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return rows
}

export function render(rows) {
  if (rows.length === 0) return 'No lean: debt. Clean ledger.\n'
  const out = rows.map((r) => `${r.file}:${r.line}, ${r.ceiling}. ceiling: ${r.ceiling}. upgrade: ${r.upgrade ?? '(none)'}.${r.tag ? ` [${r.tag}]` : ''}`)
  const none = rows.filter((r) => r.tag === 'no-trigger').length
  out.push('', `${rows.length} markers, ${none} with no trigger.`)
  return out.join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] || process.cwd()
  process.stdout.write(render(harvest(root)))
}
