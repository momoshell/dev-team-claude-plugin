#!/usr/bin/env node
// lean-debt — harvest every `lean:` ceiling marker into one ledger, so a deliberate
// shortcut cannot quietly become permanent. Reads and reports; changes nothing.
//
// A marker is a WHOLE COMMENT LINE (crew/roles/_shared.md): the line, trimmed, begins
// with a comment prefix and then `lean:`. A `lean:` trailing on a code line, or inside a
// string, template or regex literal, is text — not debt. This is a lexical rule a grep
// can hold, not a heuristic about what surrounds it.
//
// Record shape: `lean: <ceiling>; <upgrade path>`. The FIRST `;` splits, so a ceiling
// may contain commas ("tuple key (tenant, user)"). No `;` → no upgrade path → `no-trigger`:
// those are the ones that rot.
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'

// Comment prefixes: line, hash, block open, block continuation `*`, HTML open.
export const MARKER = /^\s*(?:\/\/|#|\/\*+|\*|<!--)\s*lean:\s*(.*?)\s*(?:\*\/|-->)?\s*$/
export const SKIP_DIRS = Object.freeze(new Set(['node_modules', '.git', 'dist', 'returns', '.crew']))
export const TEXT_EXT = /\.(?:mjs|cjs|js|ts|svelte|md|json|sh|yml|yaml|css|html)$/

export function parseMarker(line) {
  const m = MARKER.exec(String(line).replace(/\r$/, ''))
  if (!m) return null
  const body = m[1].trim()
  if (!body) return null
  const at = body.indexOf(';')
  if (at === -1) return { ceiling: body, upgrade: null, tag: 'no-trigger' }
  const upgrade = body.slice(at + 1).trim()
  return { ceiling: body.slice(0, at).trim(), upgrade: upgrade || null, tag: upgrade ? null : 'no-trigger' }
}

// lstat, not stat: a symlink is neither a directory nor a file under lstat, so it is never
// followed (a link to `.` once harvested one marker 35 times). A directory that cannot be
// read is skipped, never thrown: a ledger is a report.
export function* walk(root, dir = root) {
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st; try { st = lstatSync(p) } catch { continue }
    if (st.isDirectory()) yield* walk(root, p)
    else if (st.isFile() && TEXT_EXT.test(name)) yield p
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
  const out = rows.map((r) => `${r.file}:${r.line}: ${r.ceiling}. upgrade: ${r.upgrade ?? '(none)'}.${r.tag ? ` [${r.tag}]` : ''}`)
  const none = rows.filter((r) => r.tag === 'no-trigger').length
  out.push('', `${rows.length} markers, ${none} with no trigger.`)
  return out.join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(render(harvest(process.argv[2] || process.cwd())))
}
