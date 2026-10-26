// Required-skill proof for lean seats (ADR-052): the envelope of a seat whose definition `requires`
// skills is accepted only if its session recording shows each one fully loaded before the seat's
// first write. It judges the rows this process relayed for the turn, never the session file a
// task-dir seat could rewrite, and never grants.
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The skills root a lean seat is granted from (crew/acp/seat.mjs SKILLS_ROOT).
const SKILLS_ROOT = fileURLToPath(new URL('../skills', import.meta.url))
// Exactly `cat <path>`, the path bare or wholly single- or double-quoted (a quoted path may hold spaces).
const CAT = /^cat\s+(?:"([^"]+)"|'([^']+)'|([^\s'"]+))$/

const UNPROVEN = 'required-skills-unproven'
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
const WRITE_KINDS = new Set(['edit', 'delete', 'move'])

// Fold tool_call and tool_call_update rows by call id: first-seen order, with metadata and input
// kept across partial updates. `seq` is the row a call first appears on (its write
// boundary). A read counts as a load only once it has completed, and only if the input naming it was
// recorded by then: a pending call can arrive with empty or different input and name its skill only
// in a later update. `loadAt` is the completion row.
function foldCalls(raw) {
  const calls = new Map()
  let anonymous = 0
  let at = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const row = JSON.parse(line)
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('recording row is not an object')
    const update = row.update
    if (!update || (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')) continue
    at += 1
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : `anonymous-${++anonymous}`
    if (!calls.has(id)) calls.set(id, { id, seq: at, inputAt: null, doneAt: null, title: null, kind: null, status: null, tool: null, input: null })
    const call = calls.get(id)
    if (typeof update.title === 'string') call.title = update.title
    if (typeof update.kind === 'string') call.kind = update.kind
    if (typeof update.status === 'string') call.status = update.status
    if (update.status === 'completed' && call.doneAt === null) call.doneAt = at
    const tool = update._meta?.claudeCode?.toolName
    if (typeof tool === 'string' && tool !== '') call.tool = tool
    const input = update.rawInput
    const hasInput = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > 0
    if (hasInput) { call.input = input; call.inputAt = at }
  }
  // A call that names what it read only after it completed never showed that read: no load.
  return [...calls.values()].map((call) => ({ ...call, loadAt: call.doneAt === null || call.inputAt === null || call.inputAt > call.doneAt ? null : call.doneAt }))
}

function toolNameOf(call) {
  // The ACP kind outranks a free-form title (a pi or claude execute call may be titled "Run command").
  if (call.tool !== null) return call.tool
  if (call.kind === 'execute') return 'bash'
  if (call.title !== null && call.title !== '') return call.title
  return call.kind ?? 'other'
}

// The required skill a completed call loads, or null when it loads none.
// A claude seat loads its granted skills only through its own plugin, `crew-skills-<role>`
// (adapter-claude writeSeatSkills): a Skill call under that namespace counts, a bare or foreign name
// does not, and neither does a file read. A pi seat is granted SKILL.md paths (`--skill`), so for it
// only a whole read counts: a read tool with no offset or limit, or exactly `cat <path>` (a search such
// as Grep returns matching lines only), whose path, resolved against the seat's cwd when relative,
// is a path the skill was granted at (see grantedPaths).
function loadOf(name, input, { agent, role, required, granted, cwd }) {
  if (agent === 'claude') {
    const own = `crew-skills-${role}:`
    const skill = name === 'Skill' && typeof input.skill === 'string' && input.skill.startsWith(own) ? input.skill.slice(own.length) : null
    return required.includes(skill) ? skill : null
  }
  if (agent !== 'pi') return null
  let path
  if (name === 'bash') {
    const cat = typeof input.command === 'string' ? CAT.exec(input.command.trim()) : null
    path = cat ? cat[1] ?? cat[2] ?? cat[3] : undefined
  }
  else if (name.toLowerCase() === 'read' && input.offset == null && input.limit == null) path = input.path ?? input.file_path
  if (typeof path !== 'string' || path === '' || (!isAbsolute(path) && typeof cwd !== 'string')) return null
  const full = isAbsolute(path) ? normalize(path) : resolve(cwd, path)
  return required.find((skill) => granted.get(skill).has(full)) ?? null
}

// Where each required skill is granted, by crew/acp/seat.mjs resolveSkill: a bare name is
// <skills root>/<name>/SKILL.md, and a definition `skills` entry with a slash or a .md suffix is a path
// resolved against the seat's cwd, named by its directory when it is a SKILL.md, else by its file stem.
function grantedPaths(required, skills, skillsRoot, cwd) {
  const granted = new Map(required.map((skill) => [skill, new Set([join(skillsRoot, skill, 'SKILL.md')])]))
  for (const entry of Array.isArray(skills) ? skills : []) {
    if (typeof entry !== 'string' || !(entry.includes('/') || entry.endsWith('.md'))) continue
    if (!isAbsolute(entry) && typeof cwd !== 'string') continue
    const path = isAbsolute(entry) ? normalize(entry) : resolve(cwd, entry)
    const name = basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md')
    granted.get(name)?.add(path)
  }
  return granted
}

export function proveRequiredSkills({ definition, recorded, cwd, skillsRoot = SKILLS_ROOT }) {
  const required = definition?.requires ?? []
  if (required.length === 0) return null
  if (typeof recorded !== 'string' || recorded.trim() === '') return UNPROVEN
  let calls
  try { calls = foldCalls(recorded) } catch { return UNPROVEN }
  const scope = { agent: definition.agent, role: definition.role, required, granted: grantedPaths(required, definition.skills, skillsRoot, cwd), cwd }
  const loadedAt = new Map()
  let firstWrite = null
  for (const call of calls) {
    const name = toolNameOf(call)
    const lower = name.toLowerCase()
    // For a repo writer every shell call is a write boundary, including one that reads a SKILL.md.
    const writes = WRITE_TOOLS.has(lower) || WRITE_KINDS.has(call.kind) || (lower === 'bash' && definition.writes === 'repo')
    if (writes && firstWrite === null) firstWrite = call.seq
    // A load needs the recorded input: locations alone cannot show whether a read was whole.
    if (call.loadAt === null || call.status !== 'completed' || !call.input) continue
    const skill = loadOf(name, call.input, scope)
    if (skill !== null) loadedAt.set(skill, Math.min(loadedAt.get(skill) ?? Infinity, call.loadAt))
  }
  const proven = (skill) => loadedAt.has(skill) && (firstWrite === null || loadedAt.get(skill) < firstWrite)
  return required.every(proven) ? null : UNPROVEN
}
