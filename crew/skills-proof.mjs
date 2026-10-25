// Required-skill proof for lean seats (ADR-052): the envelope of a seat whose definition `requires`
// skills is accepted only if its session recording shows each one fully loaded before the seat's
// first write. Read only: it reuses the old path's load tracker and judges recorded rows, never grants.
import { readFile as fsReadFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillLoadTracker } from './headless.mjs'

// The skills root a lean seat is granted from (crew/acp/seat.mjs SKILLS_ROOT).
const SKILLS_ROOT = fileURLToPath(new URL('../skills', import.meta.url))
const CAT = /^cat\s+(['"]?)([^'"\s]+)\1$/

const UNPROVEN = 'required-skills-unproven'
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
const WRITE_KINDS = new Set(['edit', 'delete', 'move'])

// Fold tool_call and tool_call_update rows by call id: first-seen order, with metadata, input and
// locations kept across partial updates. `seq` is the row a call first appears on (its write
// boundary). A read counts as a load only once it has completed, and no earlier than the last row
// that changed what it names: a pending call can arrive with empty or different input and name
// its skill, or finish, only in a later update. `loadAt` is the later of those two rows.
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
    if (!calls.has(id)) calls.set(id, { id, seq: at, inputAt: null, doneAt: null, title: null, kind: null, status: null, tool: null, input: null, locations: null })
    const call = calls.get(id)
    const named = (update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput) && Object.keys(update.rawInput).length)
      || (Array.isArray(update.locations) && update.locations.length)
    if (named) call.inputAt = at
    if (typeof update.title === 'string') call.title = update.title
    if (typeof update.kind === 'string') call.kind = update.kind
    if (typeof update.status === 'string') call.status = update.status
    if (update.status === 'completed' && call.doneAt === null) call.doneAt = at
    const tool = update._meta?.claudeCode?.toolName
    if (typeof tool === 'string' && tool !== '') call.tool = tool
    const input = update.rawInput
    if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length) call.input = input
    if (Array.isArray(update.locations)) call.locations = update.locations
  }
  return [...calls.values()].map((call) => ({ ...call, loadAt: call.doneAt === null ? null : Math.max(call.inputAt ?? call.seq, call.doneAt) }))
}

function toolNameOf(call) {
  // The ACP kind outranks a free-form title (a pi or claude execute call may be titled "Run command").
  if (call.tool !== null) return call.tool
  if (call.kind === 'execute') return 'bash'
  if (call.title !== null && call.title !== '') return call.title
  return call.kind ?? 'other'
}

function inputsOf(call) {
  if (call.input) return [call.input]
  const located = (call.locations ?? []).map((l) => (typeof l === 'string' ? l : l?.path)).filter((p) => typeof p === 'string').map((path) => ({ path }))
  return located.length ? located : [{}]
}

// A read-type call is a load only when it reads a granted SKILL.md whole: its path, resolved against
// the seat's cwd when relative, equals <skills root>/<required>/SKILL.md, with no offset or limit, or
// it is a shell call that is exactly `cat <path>`. Returns the resolved path, or null when it is no load.
// A claude Skill call names its skill directly and is matched by namespace instead.
function wholeGrantedRead(name, input, required, skillsRoot, cwd) {
  if (name === 'Skill') return true
  // Only a read tool or a `cat` reads a file whole; a search such as Grep returns matching lines only.
  let path
  if (name === 'bash') path = typeof input.command === 'string' ? CAT.exec(input.command.trim())?.[2] : undefined
  else if (name.toLowerCase() !== 'read' || input.offset != null || input.limit != null) return null
  else path = input.path ?? input.file_path
  if (typeof path !== 'string' || path === '') return null
  if (!isAbsolute(path) && typeof cwd !== 'string') return null
  const full = isAbsolute(path) ? normalize(path) : resolve(cwd, path)
  return required.some((skill) => full === join(skillsRoot, skill, 'SKILL.md')) ? full : null
}

export async function proveRequiredSkills({ definition, sessionFile, cwd, readFile = fsReadFile, skillsRoot = SKILLS_ROOT }) {
  const required = definition?.requires ?? []
  if (required.length === 0) return null
  let raw
  try { raw = await readFile(sessionFile, 'utf8') } catch { return 'required-skills-unproven' }
  let calls
  try {
    if (typeof raw !== 'string' || raw.trim() === '') return UNPROVEN
    calls = foldCalls(raw)
  } catch { return UNPROVEN }
  const tracker = createSkillLoadTracker()
  let firstWrite = null
  for (const call of calls) {
    const name = toolNameOf(call)
    const lower = name.toLowerCase()
    for (const input of inputsOf(call)) {
      // A claude seat's granted skills load from its own plugin, `crew-skills-<role>` (adapter-claude
      // writeSeatSkills); a load namespaced under any other plugin is not the granted skill.
      const own = `crew-skills-${definition.role}:`
      const normalized = name === 'Skill' && typeof input.skill === 'string' && input.skill.includes(':')
        ? { ...input, skill: input.skill.startsWith(own) ? input.skill.slice(own.length) : null }
        : input
      const granted = call.loadAt !== null && call.status === 'completed' ? wholeGrantedRead(name, normalized, required, skillsRoot, cwd) : null
      // A whole read is observed as a read of its resolved path, so relative and `cat` loads classify alike.
      if (granted === true) tracker.observe(name, normalized, null, call.loadAt, call.id)
      else if (granted) tracker.observe('read', { path: granted }, null, call.loadAt, call.id)
      // For a repo writer every shell call is a write boundary, including one that reads a SKILL.md.
      const shell = call.kind === 'execute' || lower === 'bash'
      const writes = WRITE_TOOLS.has(lower) || WRITE_KINDS.has(call.kind) || (shell && definition.writes === 'repo')
      if (writes && firstWrite === null) firstWrite = call.seq
    }
    if (call.status === 'failed') tracker.fail(call.id)
  }
  const { loads } = tracker.snapshot()
  for (const skill of required) {
    const seqs = loads.filter((entry) => entry.skill === skill && entry.slice === null).map((entry) => entry.seq)
    if (seqs.length === 0) return 'required-skills-unproven'
    if (firstWrite !== null && Math.min(...seqs) >= firstWrite) return 'required-skills-unproven'
  }
  return null
}
