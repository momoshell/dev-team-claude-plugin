import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const validGlob = (g) => typeof g === 'string' && g.length > 0 && !g.startsWith('/') && !g.endsWith('/') && !g.includes('\\') && !g.includes('?') && g.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..' && (!s.includes('**') || s === '**'))
const keySet = (o, keys) => object(o) && Object.keys(o).every((k) => keys.includes(k))

// A strict load (requireSkillFiles) refuses a map naming a skill it cannot open. Seat delivery
// passes false and reports each unopenable skill on its own row, so one missing file never
// withholds every other skill.
const SKILL_ENTRY_RE = /^dev-team:([a-z0-9][a-z0-9-]*)(?:#([a-z0-9][a-z0-9-]*))?$/
function parseSkillEntry(s) {
  const m = typeof s === 'string' ? s.match(SKILL_ENTRY_RE) : null
  if (!m) return null
  const skill = m[1]
  const ref = m[2] || null
  return { skill, ref, path: ref ? 'skills/' + skill + '/references/' + ref + '.md' : 'skills/' + skill + '/SKILL.md' }
}
export function validateMap(map, root = process.cwd(), { requireSkillFiles = true } = {}) {
  if (!keySet(map, ['version', 'exempt', 'rules']) || map.version !== 1 || !Array.isArray(map.exempt) || !map.exempt.length || !map.exempt.every(validGlob) || !Array.isArray(map.rules) || !map.rules.length) return false
  return map.rules.every((rule) => {
    if (!keySet(rule, ['when', 'skills', 'delivery']) || !keySet(rule.when, ['paths', 'roles']) || (!Object.hasOwn(rule.when, 'paths') && !Object.hasOwn(rule.when, 'roles')) || !Array.isArray(rule.skills) || !rule.skills.length) return false
    if (Object.hasOwn(rule, 'delivery') && rule.delivery !== 'inline' && rule.delivery !== 'grant') return false
    if (Object.hasOwn(rule.when, 'paths') && (!Array.isArray(rule.when.paths) || !rule.when.paths.length || !rule.when.paths.every(validGlob))) return false
    if (Object.hasOwn(rule.when, 'roles') && (!Array.isArray(rule.when.roles) || !rule.when.roles.length || !rule.when.roles.every((r) => typeof r === 'string' && r.length))) return false
    return rule.skills.every((s) => {
      const parsed = parseSkillEntry(s)
      if (!parsed) return false
      if (!requireSkillFiles) return true
      try { return !!readFileSync(join(root, parsed.path)) } catch { return false }
    })
  })
}

export function loadMap(root, { requireSkillFiles = true } = {}) {
  let text
  try { text = readFileSync(join(root, 'skills', 'skill-map.json'), 'utf8') } catch (e) { return { ok: false, reason: 'map-unreadable' } }
  let map
  try { map = JSON.parse(text) } catch { return { ok: false, reason: 'map-unparseable' } }
  if (!validateMap(map, root, { requireSkillFiles })) return { ok: false, reason: 'map-schema' }
  return { ok: true, map }
}

export function matchGlob(glob, path) {
  if (!validGlob(glob) || typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..')) return false
  const p = path.split('/')
  const g = glob.split('/')
  const memo = new Map()
  const segmentMatches = (pattern, value) => {
    let source = '^'
    for (const char of pattern) source += char === '*' ? '.*' : ('\\^$.*+?()[]{}|'.includes(char) ? `\\${char}` : char)
    return new RegExp(`${source}$`).test(value)
  }
  const match = (i, j) => {
    const k = `${i}:${j}`
    if (memo.has(k)) return memo.get(k)
    let result
    if (i === g.length) result = j === p.length
    else if (g[i] === '**') result = match(i + 1, j) || (j < p.length && match(i, j + 1))
    else result = j < p.length && segmentMatches(g[i], p[j]) && match(i + 1, j + 1)
    memo.set(k, result)
    return result
  }
  return match(0, 0)
}

function collectSeatEntries({ map, role, files }) {
  const roleRules = map.rules.filter((rule) => !Object.hasOwn(rule.when, 'paths') && rule.when.roles?.includes(role))
  const pathRules = files === null ? [] : map.rules.filter((rule) => (!Object.hasOwn(rule.when, 'roles') || rule.when.roles.includes(role)) && rule.when.paths?.some((glob) => files.some((file) => !map.exempt.some((exempt) => matchGlob(exempt, file)) && matchGlob(glob, file))))
  const byPath = new Map()
  const order = []
  for (const rule of [...roleRules, ...pathRules]) {
    for (const s of rule.skills) {
      const parsed = parseSkillEntry(s)
      if (!parsed) continue
      const prior = byPath.get(parsed.path)
      if (!prior) {
        const entry = { path: parsed.path, delivery: rule.delivery || 'grant', selected_by: Object.hasOwn(rule.when, 'paths') ? 'map-path' : 'map-role', globs: Object.hasOwn(rule.when, 'paths') ? [...rule.when.paths] : [] }
        byPath.set(parsed.path, entry)
        order.push(parsed.path)
      } else {
        if (rule.delivery === 'inline') prior.delivery = 'inline'
        if (Object.hasOwn(rule.when, 'paths')) for (const g of rule.when.paths) if (!prior.globs.includes(g)) prior.globs.push(g)
      }
    }
  }
  const entries = order.map((p) => byPath.get(p))
  return { entries, skills: entries.map((e) => e.path) }
}

export function resolveSeatSkills({ map, role, files }) {
  const built = collectSeatEntries({ map, role, files })
  const paths_unmeasured = files === null ? 'no-fence-register' : null
  return { skills: [...built.skills], entries: built.entries, paths_unmeasured }
}
