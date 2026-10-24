// crew show <lane> [<role>] [--json]
//
// Read-only view of a lane's recorded seat sessions (ADR-052 section 1). With a lane alone it
// lists each seat and the session files it recorded; with a role it prints that seat's
// sessions as readable text, or with --json the recorded JSONL bytes untouched. A lane is the
// live crew directory or, when that is gone, its newest archive. Nothing here launches a seat
// or writes a file.
//
// Claude seats (headless-json) record one stream per dispatch under task/headless/d<N>; the
// seat is named by the CREW_ROLE the driver saved in that dispatch's cmd.json, because N is the
// order dispatches were allocated in, not a role. Pi seats (headless-rpc) record one persistent
// stream under task/headless-rpc/<role>. Other transports record nothing this reads.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/
const ROLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
// Lifecycle frames whose content a canonical message record already carries; rendering them would repeat it.
const QUIET = {
  'headless-json': new Set(['system', 'rate_limit_event', 'result']),
  'headless-rpc': new Set(['session', 'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end']),
}

class ShowRefusal extends Error {}

const defaultDeps = () => ({ readFileSync, readdirSync, statSync, crewRoot: join(homedir(), '.crew') })

const pretty = (value) => JSON.stringify(value, null, 2)

// A block list or string rendered to parts; `heading` labels text, null leaves it bare for nesting.
function renderContent(content, heading) {
  const labelled = (text) => (heading ? `${heading}\n${text}` : text)
  if (typeof content === 'string') return [labelled(content)]
  if (content === undefined || content === null) return []
  if (!Array.isArray(content)) return [pretty(content)]
  return content.map((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return labelled(block.text)
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return `THINKING\n${block.thinking}`
    if (block?.type === 'tool_use') return `TOOL ${block.name} ${block.id}\n${pretty(block.input)}`
    if (block?.type === 'toolCall') return `TOOL ${block.name} ${block.id}\n${pretty(block.arguments)}`
    if (block?.type === 'tool_result') {
      return `TOOL RESULT ${block.tool_use_id}${block.is_error ? ' ERROR' : ''}\n${renderContent(block.content, null).join('\n')}`
    }
    return pretty(block)
  })
}

function renderSession({ rel, raw, prompt }, transport) {
  const claude = transport === 'headless-json'
  const lines = raw.split('\n').flatMap((line, index) => (line.trim() === '' ? [] : [[index + 1, line]]))
  const events = lines.map(([number, line]) => {
    try { return JSON.parse(line) } catch (error) { throw new ShowRefusal(`${rel} line ${number} is not a complete JSON record (${error.message})`) }
  })
  const parts = prompt === undefined ? [] : [`USER\n${prompt}`]
  // A failed pi turn is recorded with empty content, so its stopReason and errorMessage are all there is to show.
  const message = (m) => {
    const heading = String(m?.role ?? 'message').toUpperCase()
    const shown = m?.role === 'toolResult'
      ? [`TOOL RESULT ${m.toolCallId}${m.isError ? ' ERROR' : ''}\n${renderContent(m.content, null).join('\n')}`]
      : renderContent(m?.content, heading)
    if (typeof m?.errorMessage === 'string') shown.push(`${heading} ${m.stopReason ?? 'error'}\n${m.errorMessage}`)
    return shown
  }
  for (const event of events) {
    if (event === null || typeof event !== 'object') parts.push(`EVENT\n${pretty(event)}`)
    else if (claude) {
      if (event.type === 'assistant' || event.type === 'user') parts.push(...message(event.message))
      else if (!(QUIET[transport].has(event.type) && !event.is_error)) parts.push(`EVENT ${event.type}\n${pretty(event)}`)
    } else if (event.type === 'message_end') parts.push(...message(event.message))
    else if (!QUIET[transport].has(event.type)) parts.push(`EVENT ${event.type}\n${pretty(event)}`)
  }
  if (events.length === 0) parts.push('no recorded events')
  return `=== ${rel} ===\n${parts.join('\n\n')}\n`
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
  // lean: whole-session buffering; stream incrementally if recordings outgrow CLI memory
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
  if (!crewDir) throw new ShowRefusal(`unknown lane ${lane}: no crew directory ${join(laneDir, lane)} and no ${lane}.archive-* beside it`)

  const crewPath = join(crewDir, 'crew.json')
  const crewText = text(crewPath)
  if (crewText === null) throw new ShowRefusal(`lane ${lane}: ${crewPath} is missing`)
  let members
  try { members = JSON.parse(crewText).members } catch (error) { throw new ShowRefusal(`lane ${lane}: ${crewPath} is not valid JSON (${error.message})`) }
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isObject(members)) throw new ShowRefusal(`lane ${lane}: ${crewPath} has no members object`)
  const seats = Object.entries(members)
  if (seats.length === 0) throw new ShowRefusal(`lane ${lane}: ${crewPath} lists no members`)
  for (const [name, member] of seats) {
    if (!ROLE.test(name)) throw new ShowRefusal(`lane ${lane}: ${crewPath} names unsafe member ${JSON.stringify(name)}`)
    if (!isObject(member)) throw new ShowRefusal(`lane ${lane}: member ${name} in ${crewPath} is not an object`)
  }
  if (role !== undefined && !Object.hasOwn(members, role)) throw new ShowRefusal(`lane ${lane} has no role ${role}; it has ${seats.map(([name]) => name).join(', ')}`)

  // Claude dispatches, attributed through the CREW_ROLE each dispatch recorded, in numeric order.
  const dispatches = new Map()
  if (seats.some(([, member]) => member.transport === 'headless-json')) {
    const root = join(crewDir, 'task', 'headless')
    const names = (attempt(root, d.readdirSync) ?? []).filter((name) => /^d[0-9]+$/.test(name))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    for (const name of names) {
      const rel = `task/headless/${name}/stream.jsonl`
      if (!stat(join(crewDir, rel))) continue
      const cmdRel = `task/headless/${name}/cmd.json`
      const cmdText = text(join(crewDir, cmdRel))
      if (cmdText === null) throw new ShowRefusal(`lane ${lane}: ${cmdRel} is missing, so ${rel} cannot be attributed to a seat`)
      let command
      try { command = JSON.parse(cmdText) } catch (error) { throw new ShowRefusal(`lane ${lane}: ${cmdRel} is not valid JSON (${error.message})`) }
      if (!isObject(command)) throw new ShowRefusal(`lane ${lane}: ${cmdRel} is not an object`)
      const sessionRole = command.env?.CREW_ROLE
      if (typeof sessionRole !== 'string' || !Object.hasOwn(members, sessionRole)) {
        throw new ShowRefusal(`lane ${lane}: ${cmdRel} records ${sessionRole === undefined ? 'no CREW_ROLE' : `CREW_ROLE ${JSON.stringify(sessionRole)}`}, which is not a member of ${crewPath}`)
      }
      const at = Array.isArray(command.args) ? command.args.indexOf('-p') : -1
      const prompt = at >= 0 && typeof command.args[at + 1] === 'string' ? command.args[at + 1] : undefined
      dispatches.set(sessionRole, [...(dispatches.get(sessionRole) ?? []), { rel, prompt }])
    }
  }
  const sessionsOf = (name, transport) => {
    if (transport === 'headless-json') return { files: dispatches.get(name) ?? [], reason: 'no session file recorded' }
    if (transport !== 'headless-rpc') return { files: [], reason: `no session file: transport ${transport} records none this reads` }
    const rel = `task/headless-rpc/${name}/stream.jsonl`
    return { files: stat(join(crewDir, rel)) ? [{ rel, prompt: undefined }] : [], reason: 'no session file recorded' }
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
  return streams.map((session) => renderSession(session, transport)).join('\n')
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
