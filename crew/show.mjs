// crew show <lane> [<role>] [--json]
//
// Read-only view of a lane's recorded seat sessions (ADR-052 section 1). With a lane alone it
// lists each seat and the session files it recorded; with a role it prints that seat's
// sessions as readable text, or with --json the recorded JSONL bytes untouched. A lane is the
// live crew directory or, when that is gone, its newest archive. Nothing here launches a seat
// or writes a file.
//
// Lean ACP seats record JSONL under task/lean/<role>/<lane>.<role>.<turn>[.repair][.rerun][.retry-N].jsonl.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANE, isObject } from './lane-core.mjs'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'
const ROLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
class ShowRefusal extends Error {}

const defaultDeps = () => ({ readFileSync, readdirSync, statSync, crewRoot: join(homedir(), '.crew') })

const pretty = (value) => JSON.stringify(value, null, 2)

// ACP recordings: a {type:'prompt'} head record, then {sessionId, update} frames. Adjacent chunks of
// one kind are one utterance, so their text joins without separators.
function renderAcp(events) {
  const parts = []
  let open = null
  const chunk = (heading, text) => {
    if (open?.heading === heading) { open.text += text; return }
    open = { heading, text }
    parts.push(open)
  }
  for (const event of events) {
    const update = event?.update
    const kind = update?.sessionUpdate
    const text = update?.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : null
    if (event?.type === 'prompt' && typeof event.text === 'string') { open = null; parts.push({ heading: 'USER', text: event.text }) }
    else if (kind === 'user_message_chunk' && text !== null) chunk('USER', text)
    else if (kind === 'agent_message_chunk' && text !== null) chunk('ASSISTANT', text)
    else if (kind === 'agent_thought_chunk' && text !== null) chunk('THINKING', text)
    else {
      open = null
      if (kind === 'tool_call') parts.push({ heading: `TOOL ${update.title ?? update.kind ?? ''} ${update.toolCallId ?? ''}`.trimEnd(), text: pretty(update.rawInput ?? update.content ?? null) })
      else if (kind === 'tool_call_update') parts.push({ heading: `TOOL UPDATE ${update.toolCallId ?? ''}${update.status ? ` ${update.status}` : ''}`.trimEnd(), text: pretty(update.content ?? update.rawOutput ?? null) })
      else parts.push({ heading: 'EVENT', text: pretty(event) })
    }
  }
  return parts.map(({ heading, text }) => `${heading}\n${text}`)
}

function renderSession({ rel, raw }) {
  const lines = raw.split('\n').flatMap((line, index) => (line.trim() === '' ? [] : [[index + 1, line]]))
  const events = lines.map(([number, line]) => {
    try { return JSON.parse(line) } catch (error) { throw new ShowRefusal(`${rel} line ${number} is not a complete JSON record (${error.message})`) }
  })
  return `=== ${rel} ===\n${(events.length ? renderAcp(events) : ['no recorded events']).join('\n\n')}\n`
}

export function showLane({ lane, role, json = false, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  if (typeof lane !== 'string' || !LANE.test(lane)) throw new ShowRefusal(`${JSON.stringify(lane)} is not a lane name: lowercase letters, digits and -`)
  if (json && role === undefined) throw new ShowRefusal('--json needs a role')
  if (role !== undefined && !ROLE.test(role)) throw new ShowRefusal(`${JSON.stringify(role)} is not a role name`)

  // Only a missing path is absence; a denied or interrupted read must not turn into "no such lane".
  const attempt = (path, read) => {
    try { return read(path) } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new ShowRefusal(`cannot read ${path}: ${error?.code ?? error?.message}`)
    }
  }
  const stat = (path) => attempt(path, d.statSync)
  // shortcut: whole-session buffering; stream incrementally if recordings outgrow CLI memory
  const text = (path) => attempt(path, (file) => d.readFileSync(file, 'utf8'))

  const laneDir = join(d.crewRoot, `dt-${lane}`)
  let crewDir = null
  const liveStat = stat(join(laneDir, lane))
  if (liveStat) {
    if (!liveStat.isDirectory()) throw new ShowRefusal(`lane ${lane}: ${join(laneDir, lane)} is not a directory`)
    crewDir = join(laneDir, lane)
  } else {
    const archives = (attempt(laneDir, d.readdirSync) ?? []).filter((name) => name.startsWith(`${lane}.archive-`)).sort().reverse()
    crewDir = archives.map((name) => join(laneDir, name)).find((path) => stat(path)?.isDirectory()) ?? null
  }
  const archiveRoot = d.archiveRoot ?? join(dirname(d.crewRoot), '.crew-journal-archive')
  if (!crewDir) crewDir = createLeanSource({ crewRoot: d.crewRoot, archiveRoot }).resolveLane(lane)?.dir ?? null
  if (!crewDir) throw new ShowRefusal(`unknown lane ${lane}: no crew directory ${join(laneDir, lane)}, no ${lane}.archive-* beside it, and none in ${archiveRoot}`)

  const crewPath = join(crewDir, 'crew.json')
  const crewText = text(crewPath)
  if (crewText === null) throw new ShowRefusal(`lane ${lane}: ${crewPath} is missing`)
  let members
  try { members = JSON.parse(crewText).members } catch (error) { throw new ShowRefusal(`lane ${lane}: ${crewPath} is not valid JSON (${error.message})`) }
  if (!isObject(members)) throw new ShowRefusal(`lane ${lane}: ${crewPath} has no members object`)
  const seats = Object.entries(members)
  if (seats.length === 0) throw new ShowRefusal(`lane ${lane}: ${crewPath} lists no members`)
  for (const [name, member] of seats) {
    if (!ROLE.test(name)) throw new ShowRefusal(`lane ${lane}: ${crewPath} names unsafe member ${JSON.stringify(name)}`)
    if (!isObject(member)) throw new ShowRefusal(`lane ${lane}: member ${name} in ${crewPath} is not an object`)
  }
  if (role !== undefined && !Object.hasOwn(members, role)) throw new ShowRefusal(`lane ${lane} has no role ${role}; it has ${seats.map(([name]) => name).join(', ')}`)

  const sessionsOf = (name, transport) => {
    if (transport === 'lean-acp') {
      const turn = new RegExp(`^[A-Za-z0-9._-]+\\.${name}\\.([0-9]+)(\\.repair)?(\\.rerun)?(?:\\.retry-([1-9][0-9]*))?\\.jsonl$`)
      const turns = (attempt(join(crewDir, 'task', 'lean', name), d.readdirSync) ?? []).flatMap((file) => {
        const match = file.match(turn)
        return match ? [[Number(match[1]), (match[2] ? 2 : 0) + (match[3] ? 1 : 0), Number(match[4] ?? 0), file]] : []
      }).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0))
      return { files: turns.map(([, , , file]) => ({ rel: `task/lean/${name}/${file}`, prompt: undefined })), reason: 'no session file recorded' }
    }
    return { files: [], reason: `no session file: transport ${transport} records none this reads` }
  }
  const seatOf = (name) => {
    const member = members[name]
    const field = (key) => (typeof member[key] === 'string' && member[key] !== '' ? member[key] : 'unknown')
    return { agent: field('agent'), model: field('model'), transport: field('transport') }
  }

  if (role === undefined) {
    return seats.map(([name]) => {
      const { agent, model, transport } = seatOf(name)
      const { files, reason } = sessionsOf(name, transport)
      return `${name}  ${agent}  ${model}  ${transport}\n${files.length ? files.map((file) => `  ${file.rel}\n`).join('') : `  ${reason}\n`}`
    }).join('')
  }

  const { transport } = seatOf(role)
  const { files, reason } = sessionsOf(role, transport)
  if (files.length === 0) throw new ShowRefusal(`lane ${lane} role ${role} has no session: ${reason}`)
  const streams = files.map((file) => {
    const raw = text(join(crewDir, file.rel))
    if (raw === null) throw new ShowRefusal(`lane ${lane} role ${role}: ${file.rel} disappeared while reading`)
    return { ...file, raw }
  })
  if (streams.every((session) => session.raw.trim() === '')) throw new ShowRefusal(`lane ${lane} role ${role} recorded no events: ${streams.map((session) => session.rel).join(', ')} is empty`)
  if (json) return streams.map((session) => session.raw).join('')
  return streams.map((session) => renderSession(session)).join('\n')
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), ...deps }
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const [lane, role, ...extra] = argv.filter((arg) => !arg.startsWith('-'))
  const asJson = flags.length === 1 && flags[0] === '--json'
  if (lane === undefined || extra.length > 0 || (flags.length > 0 && !asJson) || (asJson && role === undefined)) {
    d.stderr('usage: crew show <lane> [<role>] [--json]\n')
    return 2
  }
  try {
    d.stdout(showLane({ lane, role, json: asJson, deps }))
    return 0
  } catch (error) {
    if (!(error instanceof ShowRefusal)) throw error
    d.stderr(`crew show: ${error.message.replace(/\p{Cc}+/gu, ' ')}\n`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
