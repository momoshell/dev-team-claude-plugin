import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const REPO = process.cwd()
function walk(dir, out = [], ext = null) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out, ext)
    else if (!ext || p.endsWith(ext)) out.push(p)
  }
  return out
}
const all = walk(REPO)
const byBase = new Map()
for (const p of all) {
  const b = p.split('/').pop()
  if (!byBase.has(b)) byBase.set(b, [])
  byBase.get(b).push(p.slice(REPO.length + 1))
}
const docs = [...walk(join(REPO, 'skills'), [], '.md'), ...walk(join(REPO, 'commands'), [], '.md')].sort()
const RE = /([A-Za-z0-9_./-]+\.(?:mjs|ts|js|json|md|sh|css|svelte|yml|yaml)):(\d+)(?:-(\d+))?/g
const rows = []
for (const f of docs) {
  const rel = f.slice(REPO.length + 1)
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(RE)) rows.push({ site: `${rel}:${i + 1}`, target: m[1], from: +m[2], to: m[3] ? +m[3] : +m[2] })
  })
}
let unres = 0
for (const r of rows) {
  let path = existsSync(join(REPO, r.target)) ? r.target : null
  let note = ''
  if (!path) {
    const cands = byBase.get(r.target.split('/').pop()) || []
    const hit = cands.filter((c) => c.endsWith(r.target))
    if (hit.length === 1) { path = hit[0]; note = 'basename→' + hit[0] }
    else if (cands.length === 1) { path = cands[0]; note = 'basename→' + cands[0] }
  }
  if (!path) { console.log(`${r.site}\tUNRESOLVED\t${r.target}:${r.from}`); unres++; continue }
  const lines = readFileSync(join(REPO, path), 'utf8').split('\n')
  const oor = r.to > lines.length
  if (oor) unres++
  const excerpt = oor ? `(file has ${lines.length} lines)` : lines.slice(r.from - 1, r.to).map((l) => l.trim()).join(' ⏎ ').slice(0, 170)
  console.log(`${r.site}\t${oor ? 'OOR' : 'ok'}\t${r.target}:${r.from}${r.to !== r.from ? '-' + r.to : ''}${note ? ' [' + note + ']' : ''}\t${excerpt}`)
}
console.log(`\nTOTAL ${rows.length} unresolved/OOR ${unres}`)
