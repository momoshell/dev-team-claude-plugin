import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const validGlob = (g) => typeof g === 'string' && g.length > 0 && !g.startsWith('/') && !g.endsWith('/') && !g.includes('\\') && !g.includes('?') && g.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..' && (!s.includes('**') || s === '**'))
const keySet = (o, keys) => object(o) && Object.keys(o).every((k) => keys.includes(k))

// requireSkillFiles: the edit gate refuses a map naming a skill it cannot open. Seat delivery
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
    if (!keySet(rule, ['when', 'skills', 'delivery']) || !keySet(rule.when, ['paths', 'roles']) || (!own(rule.when, 'paths') && !own(rule.when, 'roles')) || !Array.isArray(rule.skills) || !rule.skills.length) return false
    if (own(rule, 'delivery') && rule.delivery !== 'inline' && rule.delivery !== 'grant') return false
    if (own(rule.when, 'paths') && (!Array.isArray(rule.when.paths) || !rule.when.paths.length || !rule.when.paths.every(validGlob))) return false
    if (own(rule.when, 'roles') && (!Array.isArray(rule.when.roles) || !rule.when.roles.length || !rule.when.roles.every((r) => typeof r === 'string' && r.length))) return false
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

function collectSeatEntries({ map, role, files, reachable }) {
  const roleRules = map.rules.filter((rule) => !own(rule.when, 'paths') && rule.when.roles?.includes(role))
  const pathRules = reachable
    ? map.rules.filter((rule) => own(rule.when, 'paths') && (!own(rule.when, 'roles') || rule.when.roles.includes(role)))
    : (files === null ? [] : map.rules.filter((rule) => (!own(rule.when, 'roles') || rule.when.roles.includes(role)) && rule.when.paths?.some((glob) => files.some((file) => !map.exempt.some((exempt) => matchGlob(exempt, file)) && matchGlob(glob, file)))))
  const byPath = new Map()
  const order = []
  for (const rule of [...roleRules, ...pathRules]) {
    for (const s of rule.skills) {
      const parsed = parseSkillEntry(s)
      if (!parsed) continue
      const prior = byPath.get(parsed.path)
      if (!prior) {
        const entry = { path: parsed.path, delivery: rule.delivery || 'grant', selected_by: own(rule.when, 'paths') ? 'map-path' : 'map-role', globs: own(rule.when, 'paths') ? [...rule.when.paths] : [] }
        byPath.set(parsed.path, entry)
        order.push(parsed.path)
      } else {
        if (rule.delivery === 'inline') prior.delivery = 'inline'
        if (own(rule.when, 'paths')) for (const g of rule.when.paths) if (!prior.globs.includes(g)) prior.globs.push(g)
      }
    }
  }
  const entries = order.map((p) => byPath.get(p))
  return { entries, skills: entries.map((e) => e.path) }
}

export function resolveSeatSkills({ map, role, files }) {
  const built = collectSeatEntries({ map, role, files, reachable: false })
  const paths_unmeasured = files === null ? 'no-fence-register' : null
  return { skills: [...built.skills], entries: built.entries, paths_unmeasured }
}

export function reachableSeatSkills({ map, role }) {
  const built = collectSeatEntries({ map, role, files: [], reachable: true })
  return { skills: [...built.skills], entries: built.entries, paths_unmeasured: null }
}

export function requiredSkills(map, path) {
  if (map.exempt.some((g) => matchGlob(g, path))) return []
  const result = new Set()
  for (const rule of map.rules) {
    if (!own(rule.when, 'paths')) continue
    if (own(rule.when, 'roles')) continue
    if (rule.when.paths.some((g) => matchGlob(g, path))) for (const skill of rule.skills) result.add(skill.split('#')[0])
  }
  return [...result].sort()
}

const pushSkillBlocks = (value, skills) => {
  const content = value?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') skills.add(block.input.skill)
}
export function scanTranscript(transcriptPath, sessionId, agentId) {
  const found = new Set()
  const scan = (file, wanted) => {
    if (!file) return
    let data
    try { data = readFileSync(file, 'utf8') } catch { return }
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        const rowAgent = row.agentId
        if (wanted === 'main' ? rowAgent === undefined : rowAgent === wanted) pushSkillBlocks(row, found)
      } catch {}
    }
  }
  scan(transcriptPath, agentId ?? 'main')
  if (agentId && transcriptPath && sessionId) {
    const transcriptDir = dirname(transcriptPath)
    const sidecar = resolve(transcriptDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
    const sidecarRel = relative(transcriptDir, sidecar)
    if (sidecarRel !== '..' && !sidecarRel.startsWith(`..${sep}`) && !isAbsolute(sidecarRel)) scan(sidecar, agentId)
  }
  return found
}

function findMapRoot(from) {
  let dir = resolve(from)
  while (true) {
    try { statSync(join(dir, 'skills', 'skill-map.json')); return dir } catch (error) { if (error?.code !== 'ENOENT') return dir }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
const statePath = (root, session, agent) => join(root, `${Buffer.from(JSON.stringify([session ?? '', agent ?? 'main'])).toString('base64url')}.json`)
function stateSkills(root, input) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root, input.session_id, input.agent_id), 'utf8'))
    return new Set(Array.isArray(parsed.skills) ? parsed.skills.filter((x) => typeof x === 'string') : [])
  } catch { return new Set() }
}
function recordSkill(root, input) {
  const skills = stateSkills(root, input)
  if (typeof input.tool_input?.skill === 'string') skills.add(input.tool_input.skill)
  mkdirSync(root, { recursive: true })
  const dest = statePath(root, input.session_id, input.agent_id)
  const temp = `${dest}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify({ skills: [...skills].sort() }), { mode: 0o600 })
  renameSync(temp, dest)
}
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
function errorOut(reason) { process.stderr.write(`skill-gate: ${reason}\n`); process.exitCode = 1 }
function contextFor(map) {
  const essential = 'Loading a skill is not applying it: walk each change against the loaded skill.\nDisable with DEV_TEAM_SKILL_GATE=off.'
  const rows = map.rules.filter((r) => own(r.when, 'paths') && !own(r.when, 'roles')).map((r) => `${r.when.paths.join(', ')} → ${r.skills.join(', ')}`).join('\n')
  if (!rows) return ''
  const budget = Math.max(0, 10000 - essential.length - 1)
  return `${rows.slice(0, budget)}\n${essential}`
}

export function main(argv = process.argv.slice(2)) {
  if (process.env.DEVTEAM_WORKER === '1' || process.env.DEV_TEAM_SKILL_GATE === 'off') return 0
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { errorOut('stdin-unparseable'); return 1 }
  if (!object(input)) { errorOut('stdin-unparseable'); return 1 }
  const verb = argv[0]
  if (!['session-start', 'post-skill', 'pre-edit'].includes(verb)) return 0
  const stateRoot = process.env.DEV_TEAM_SKILL_GATE_STATE || join(tmpdir(), 'dev-team-skill-gate')
  if (verb === 'post-skill') {
    try { recordSkill(stateRoot, input) } catch { /* a future pre-edit can use transcript fallback */ }
    return 0
  }
  let from = process.cwd()
  let target
  if (verb === 'pre-edit') {
    const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path
    if (typeof raw === 'string') { target = resolve(input.cwd || process.cwd(), raw); from = dirname(target) }
  }
  const root = findMapRoot(from)
  if (!root) return 0
  const loaded = loadMap(root)
  if (!loaded.ok) { errorOut(loaded.reason); return 1 }
  if (verb === 'session-start') {
    const context = contextFor(loaded.map); if (context) emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }); return 0
  }
  if (!target) return 0
  const rel = relative(root, target).split(sep).join('/')
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return 0
  const required = requiredSkills(loaded.map, rel)
  if (!required.length) return 0
  const loadedSkills = stateSkills(stateRoot, input)
  let missing = required.filter((skill) => !loadedSkills.has(skill))
  if (missing.length) {
    for (const skill of scanTranscript(input.transcript_path, input.session_id, input.agent_id)) loadedSkills.add(skill)
    missing = required.filter((skill) => !loadedSkills.has(skill))
  }
  if (missing.length) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `skill-gate: invoke the Skill tool for ${missing.join(', ')} before editing ${rel} (skills/skill-map.json), then retry` } })
  return 0
}

if (process.argv[1] && process.argv[1].endsWith('/skill-gate.mjs')) process.exitCode = main()
