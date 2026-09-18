#!/usr/bin/env node
// lean-debt — harvest every `lean:` ceiling marker into one ledger, so a deliberate
// shortcut cannot quietly become permanent. Reads and reports; changes nothing.
//
// A marker is a WHOLE COMMENT LINE (crew/roles/_shared.md): the line, trimmed, begins
// with a comment prefix and then `lean:`. A `lean:` trailing on a code line, or inside a
// single-line string, template or regex literal, is text — not debt. This is a lexical
// rule a grep can hold, not a heuristic about what surrounds it.
//
// lean: line-based scan counts a marker-shaped line INSIDE a multiline literal; a JS lexer if a fixture ever needs one
// That ceiling is the contract: never write a marker-shaped line into a multiline string.
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
  const at = body.indexOf(';')
  const ceiling = (at === -1 ? body : body.slice(0, at)).trim()
  if (!ceiling) return null   // an empty ceiling names nothing: not a record
  const upgrade = at === -1 ? null : (body.slice(at + 1).trim() || null)
  return { ceiling, upgrade, tag: upgrade ? null : 'no-trigger' }
}

// lstat, not stat: a symlink is neither a directory nor a file under lstat, so it is never
// followed (a link to `.` once harvested one marker 35 times). A directory that cannot be
// read is skipped, never thrown: a ledger is a report.
// Yields { file } for a readable candidate and { unmeasured, reason } for anything it could
// not read. A skipped path is a blind spot the ledger must state — never a silent clear.
export function* walk(root, dir = root) {
  let names
  try { names = readdirSync(dir) } catch { yield { unmeasured: dir, reason: 'dir-unreadable' }; return }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st; try { st = lstatSync(p) } catch { yield { unmeasured: p, reason: 'stat-failed' }; continue }
    if (st.isDirectory()) yield* walk(root, p)
    else if (st.isFile() && TEXT_EXT.test(name)) yield { file: p }
  }
}

export const UNMEASURED_REASONS = Object.freeze(['dir-unreadable', 'stat-failed', 'file-unreadable'])

export function harvest(root) {
  const rows = [], unmeasured = []
  for (const entry of walk(root)) {
    if (entry.unmeasured) { unmeasured.push({ path: relative(root, entry.unmeasured).replaceAll('\\', '/') || '.', reason: entry.reason }); continue }
    const file = entry.file
    let lines; try { lines = readFileSync(file, 'utf8').split('\n') } catch { unmeasured.push({ path: relative(root, file).replaceAll('\\', '/'), reason: 'file-unreadable' }); continue }
    lines.forEach((line, i) => {
      const parsed = parseMarker(line)
      if (parsed) rows.push({ file: relative(root, file).replaceAll('\\', '/'), line: i + 1, ...parsed })
    })
  }
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  unmeasured.sort((a, b) => a.path.localeCompare(b.path))
  return { rows, unmeasured }
}

// 'Clean ledger' is a claim about EVERY candidate. With any path unmeasured it is not made.
export function render({ rows, unmeasured = [] }) {
  const out = rows.map((r) => `${r.file}:${r.line}: ${r.ceiling}. upgrade: ${r.upgrade ?? '(none)'}.${r.tag ? ` [${r.tag}]` : ''}`)
  for (const u of unmeasured) out.push(`${u.path}: unmeasured [${u.reason}]`)
  if (rows.length === 0 && unmeasured.length === 0) return 'No lean: debt. Clean ledger.\n'
  const none = rows.filter((r) => r.tag === 'no-trigger').length
  out.push('', `${rows.length} markers, ${none} with no trigger, ${unmeasured.length} paths unmeasured.`)
  return out.join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(render(harvest(process.argv[2] || process.cwd())))
}
