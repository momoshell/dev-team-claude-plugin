// crew/acp/grants.mjs — the runtime capability register and grant policy the lean seat path arms from.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUBAGENT_EXTENSION } from '../adapters/adapter-pi.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const CAPABILITY_REFUSALS = Object.freeze([
  'register-invalid', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'agent-def-invalid',
])
export const REGISTER_ROOT = resolvePath(join(HERE, '..', '..'))

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export function refuse(reason, message) {
  if (!CAPABILITY_REFUSALS.includes(reason)) throw new Error(`unknown capability refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

// Grant paths resolve against the runtime checkout, not the target checkout.
export const REGISTER = deepFreeze({ roles: {
  lead: { agents: [], mcp_servers: [] },
  planner: { agents: [], mcp_servers: [], by_agent: { pi: {
    agents: [{ name: 'scout', def: 'crew/pi/agents/scout.json' }],
    mcp_servers: [{ name: 'fff', command: { bin: '/opt/homebrew/bin/fff-mcp', args: [] }, url: null }],
  } } },
  builder: { agents: [], mcp_servers: [] },
  reviewer: { agents: [], mcp_servers: [] },
  'tech-lead': { agents: [], mcp_servers: [] },
} })

export function resolvedGrantPath(root, relativePath) {
  return resolvePath(join(resolvePath(root), relativePath))
}

export function pathExists(exists, path) {
  try { return !!exists(path) } catch { return false }
}

export function pathMessage(reason, seat, kind, expected, found, path) {
  return refuse(reason, `seat ${seat} ${kind} expected ${expected}, found ${found}, at ${path}`)
}

export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'

export function grantsFor(register, role, { root = REGISTER_ROOT, exists = existsSync, readFile = readFileSync } = {}) {
  const spec = register?.roles && Object.hasOwn(register.roles, role) ? register.roles[role] : null
  if (!spec) throw refuse('register-invalid', `runtime capability register has no grant for unknown role ${JSON.stringify(role)} under the runtime-policy rule`)

  const extensions = (spec.extensions ?? []).map((relativePath) => {
    const path = resolvedGrantPath(root, relativePath)
    if (!pathExists(exists, path)) throw pathMessage('extension-missing', role, 'extension grant', 'an existing checkout-relative path', 'missing', path)
    return path
  })
  const agents = spec.agents.map((grant) => {
    const path = resolvedGrantPath(root, grant.def)
    let raw
    try {
      raw = readFile(path, 'utf8')
    } catch (err) {
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, 'a readable JSON definition', `unreadable (${err.message})`, path)
    }
    let definition
    try {
      definition = JSON.parse(String(raw))
    } catch (err) {
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, 'parseable JSON', `unparseable (${err.message})`, path)
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)
      || typeof definition.name !== 'string' || definition.name.trim() === '' || definition.name !== grant.name) {
      const found = definition && typeof definition === 'object' ? JSON.stringify(definition.name) : JSON.stringify(definition)
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, `name ${JSON.stringify(grant.name)}`, `name ${found}`, path)
    }
    if (typeof definition.prompt !== 'string' || definition.prompt.trim() === '') {
      const found = definition && Object.hasOwn(definition, 'prompt') ? JSON.stringify(definition.prompt) : 'missing prompt'
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, 'a non-empty prompt', found, path)
    }
    return { name: grant.name, def: path }
  })

  const mcp_servers = (spec.mcp_servers || []).map((server) => ({
    name: server.name,
    command: server.command === null
      ? null
      : { bin: server.command.bin, args: [...server.command.args] },
    url: server.url,
  }))
  return deepFreeze({ extensions, agents, mcp_servers })
}

// ADR-055 §8 retired the other MCP arm.
const LEAN_MCP_ARMS = Object.freeze(['fff'])

// The register entry an MCP arm resolves to: the first role or adapter overlay that declares the server.
function registeredMcpServer(register, name) {
  for (const spec of Object.values(register?.roles ?? {})) {
    for (const group of [spec, ...Object.values(spec?.by_agent ?? {})]) {
      const found = (group?.mcp_servers ?? []).find((server) => server?.name === name)
      if (found) return found
    }
  }
  return null
}

// The seat's own role and adapter overlay first, then every other role: a seat gets its own definition of a
// name, and a name it does not define falls back (the reviewer's scout comes from the planner's pi overlay).
function registeredAgents(register, role, agent) {
  const roles = register?.roles ?? {}
  const own = Object.hasOwn(roles, role) ? roles[role] : null
  const ownOverlay = own && Object.hasOwn(own.by_agent ?? {}, agent) ? own.by_agent[agent] : null
  const groups = [own, ownOverlay, ...Object.values(roles).flatMap((spec) => [spec, ...Object.values(spec?.by_agent ?? {})])]
  const named = new Map()
  for (const group of groups) for (const grant of group?.agents ?? []) if (!named.has(grant.name)) named.set(grant.name, grant)
  return [...named.values()]
}

// The grants one lean seat's effective definition asks for, and no others: a native extension name
// becomes its checkout extension, fff becomes the register's MCP server, and subagent brings
// the registered agent definitions it needs. Resolution and refusals are grantsFor's own; a declared
// asset that is missing refuses instead of leaving a weaker seat.
export function armGrants({ role, agent, extensions = [] }, { register = REGISTER, root = REGISTER_ROOT, exists = existsSync, readFile = readFileSync } = {}) {
  const paths = []
  const mcp_servers = []
  for (const name of extensions) {
    if (LEAN_MCP_ARMS.includes(name)) {
      const server = registeredMcpServer(register, name)
      if (!server) throw refuse('unknown-grant', `seat ${role} extension ${JSON.stringify(name)} has no MCP server in the register`)
      const bin = server.command?.bin
      if (typeof bin !== 'string' || !bin.trim() || !pathExists(exists, bin)) throw pathMessage('extension-missing', role, 'fff MCP server', 'an installed fff-mcp binary', 'missing', bin ?? 'no command')
      mcp_servers.push(server)
    } else if (agent === 'muse' && ['skeletonread', 'subagent'].includes(name)) {
      continue
    } else if (/^[a-z]+$/.test(name)) {
      paths.push(`crew/pi/extensions/${name}.ts`)
    } else {
      throw refuse('unknown-grant', `seat ${role} has unregistered extension ${JSON.stringify(name)}`)
    }
  }
  const fanout = (agent === 'pi' && paths.includes(SUBAGENT_EXTENSION)) || (agent === 'muse' && extensions.includes('subagent'))
  const agents = fanout ? registeredAgents(register, role, agent) : []
  if (fanout && agents.length === 0) {
    throw refuse('unknown-grant', `seat ${role} asks for subagent but the register declares no agent definition for it`)
  }
  const narrow = { roles: { [role]: { extensions: paths, agents, mcp_servers } } }
  return grantsFor(narrow, role, { root, exists, readFile })
}
