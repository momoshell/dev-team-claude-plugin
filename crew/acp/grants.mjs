// crew/acp/grants.mjs — the runtime capability register loader and grant policy the lean seat path arms from.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const CAPABILITY_REFUSALS = Object.freeze([
  'register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported',
  'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-provider-undeclared',
  'local-endpoint-dead', 'grant-contradicts-deny', 'vendor-extension-missing',
  'agent-unresolved', 'agent-provider-unsupported', 'agent-unavailable', 'local-provider-reserved',
])
const CAPABILITIES_PATH = join(HERE, '..', 'capabilities.json')
const CAPABILITIES_SCHEMA_PATH = join(HERE, '..', 'capabilities.schema.json')
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

export function validateCapabilities(schema, value) {
  const errors = []
  walk(schema, value, '$')
  return errors

  function resolve(node) {
    if (!node || typeof node !== 'object' || !node.$ref) return node
    return resolve(byPath(node.$ref))
  }

  function byPath(ref) {
    let node = schema
    const parts = String(ref).replace(/^#\/?/, '').split('/').filter(Boolean)
    for (const part of parts) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    return node
  }

  function matchedTypes(current) {
    const matched = new Set()
    if (current === null) matched.add('null')
    else if (Array.isArray(current)) matched.add('array')
    else if (typeof current === 'number') {
      matched.add('number')
      if (Number.isInteger(current)) matched.add('integer')
    } else if (typeof current === 'string') matched.add('string')
    else if (typeof current === 'boolean') matched.add('boolean')
    else if (typeof current === 'object') matched.add('object')
    return matched
  }

  function walk(schemaNode, current, path, report = errors) {
    const s = resolve(schemaNode)
    if (!s || typeof s !== 'object') {
      report.push(`${path}: invalid schema reference`)
      return
    }
    if (Object.hasOwn(s, 'const')) {
      if (current !== s.const) report.push(`${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(current)}`)
      return
    }
    if (s.enum && !s.enum.includes(current)) {
      report.push(`${path}: ${JSON.stringify(current)} not in enum ${JSON.stringify(s.enum)}`)
      return
    }

    const matched = matchedTypes(current)
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type]
      if (!types.some((type) => matched.has(type))) {
        report.push(`${path}: expected type ${types.join('|')}, got ${[...matched].join('|') || typeof current}`)
        return
      }
    }
    if (Array.isArray(s.oneOf)) {
      let matches = 0
      for (const branch of s.oneOf) {
        const branchErrors = []
        walk(branch, current, path, branchErrors)
        if (branchErrors.length === 0) matches += 1
      }
      if (matches !== 1) report.push(`${path}: expected exactly one oneOf schema to match, got ${matches}`)
    }
    if (current === null) return
    if (typeof current === 'string' && s.pattern) {
      let valid = false
      try { valid = new RegExp(s.pattern).test(current) } catch { valid = false }
      if (!valid) report.push(`${path}: ${JSON.stringify(current)} does not match pattern ${s.pattern}`)
    }
    if (Array.isArray(current) && Number.isInteger(s.minItems) && current.length < s.minItems) {
      report.push(`${path}: expected at least ${s.minItems} item(s), got ${current.length}`)
    }
    if (Array.isArray(current) && s.items) {
      current.forEach((item, index) => walk(s.items, item, `${path}[${index}]`, report))
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const key of s.required || []) {
        if (!Object.hasOwn(current, key)) report.push(`${path}: missing required property ${JSON.stringify(key)}`)
      }
      const patterns = Object.entries(s.patternProperties || {}).map(([pattern, child]) => [new RegExp(pattern), child])
      for (const [key, childValue] of Object.entries(current)) {
        const matchedSchemas = []
        if (s.properties && Object.hasOwn(s.properties, key)) matchedSchemas.push(s.properties[key])
        for (const [pattern, child] of patterns) if (pattern.test(key)) matchedSchemas.push(child)
        if (!matchedSchemas.length && s.additionalProperties === false) {
          report.push(`${path}: additional property ${JSON.stringify(key)} not allowed`)
          continue
        }
        for (const child of matchedSchemas) walk(child, childValue, `${path}.${key}`, report)
      }
    }
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

// The register is runtime policy: grant paths resolve against this checkout,
// not the target checkout. The shipped file carries the role-level claude Task
// fan-out grant and, adapter-scoped under the planner's by_agent.pi overlay,
// the checkout-pinned pi subagent assets (#403); advisor runtime behavior
// remains reserved and default-off (#294).
export function loadCapabilities({ path = CAPABILITIES_PATH, schemaPath = CAPABILITIES_SCHEMA_PATH, register = null } = {}) {
  let schema
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  } catch (err) {
    throw refuse('register-invalid', `runtime capability policy schema ${schemaPath} is unreadable or unparseable under the runtime-policy rule: ${err.message}`)
  }

  let value
  if (register === null) {
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw refuse('register-invalid', `runtime capability register ${path} is unreadable or unparseable under the runtime-policy rule: ${err.message}`)
    }
  } else {
    try {
      value = cloneJson(register)
    } catch (err) {
      throw refuse('register-invalid', `injected runtime capability register for ${path} is unparseable under the runtime-policy rule: ${err.message}`)
    }
  }

  const errors = validateCapabilities(schema, value)
  if (errors.length) {
    throw refuse('register-invalid', `runtime capability register ${path} failed schema validation under the runtime-policy rule: ${errors.slice(0, 3).join('; ')}`)
  }
  const duplicateMcp = (list, where) => {
    const seen = new Set()
    for (const server of list || []) {
      if (seen.has(server?.name)) {
        throw refuse('register-invalid', `runtime capability register ${path} declares MCP server name ${JSON.stringify(server.name)} twice under ${where} — a duplicate name makes the grant ambiguous under the runtime-policy rule`)
      }
      seen.add(server?.name)
    }
  }
  const validateMcp = (list, where) => {
    for (const server of list || []) {
      const hasCommand = server?.command !== null
      const hasUrl = server?.url !== null
      if (hasCommand === hasUrl) {
        throw refuse('register-invalid', `runtime capability register ${path} declares MCP server ${JSON.stringify(server?.name)} under ${where} with exactly one of command or url required — both present or both absent are forbidden under the runtime-policy rule`)
      }
    }
  }
  for (const [role, spec] of Object.entries(value?.roles || {})) {
    duplicateMcp(spec?.mcp_servers, `roles.${role}`)
    validateMcp(spec?.mcp_servers, `roles.${role}`)
    for (const [agent, overlay] of Object.entries(spec?.by_agent || {})) {
      duplicateMcp(overlay?.mcp_servers, `roles.${role}.by_agent.${agent}`)
      validateMcp(overlay?.mcp_servers, `roles.${role}.by_agent.${agent}`)
    }
  }
  const duplicateAgentValues = (list, path, label) => {
    const seen = new Set()
    for (const value of list || []) {
      if (seen.has(value)) throw refuse('register-invalid', `runtime capability register ${path} declares coding agent ${label} ${JSON.stringify(value)} twice — duplicate values make the inventory ambiguous under the runtime-policy rule`)
      seen.add(value)
    }
  }
  for (const [agent, entry] of Object.entries(value?.coding_agents || {})) {
    const base = `coding_agents.${agent}`
    duplicateAgentValues(entry.providers, `${base}.providers`, 'provider')
    duplicateAgentValues(entry.transports, `${base}.transports`, 'transport'); if (entry.default_transport !== undefined && !entry.transports.includes(entry.default_transport)) throw refuse('register-invalid', `${base}.default_transport must be one of the integration's declared transports`)
    duplicateAgentValues(entry.refuses, `${base}.refuses`, 'refusal')
    const expectedAdapter = `crew/adapters/adapter-${agent}.mjs`
    if (entry.adapter !== expectedAdapter) {
      throw refuse('register-invalid', `runtime capability register ${path} expects coding agent ${agent} adapter ${JSON.stringify(expectedAdapter)}, found ${JSON.stringify(entry.adapter)}, at ${base}.adapter — adapter key and path must agree under the runtime-policy rule`)
    }
  }
  return deepFreeze(value)
}

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

function mergeAgents(base, overlay) {
  const out = new Map(base.map((grant) => [grant.name, grant]))
  for (const grant of overlay) out.set(grant.name, grant)
  return [...out.values()]
}

export function mergeMcpServers(base = [], overlay = []) {
  const out = new Map((base || []).map((server) => [server.name, server]))
  for (const server of overlay || []) out.set(server.name, server)
  return [...out.values()]
}

// #403 — the ADAPTER dimension. A role grant may carry `by_agent`, an overlay
// keyed by the resolved adapter name, merged over the role grant.
// An adapter with no entry gets the role grant and nothing else.
// tools/advisor/requires are role-level ONLY and no overlay can move them.
function agentSpec(register, role, agent) {
  const spec = register?.roles && Object.hasOwn(register.roles, role) ? register.roles[role] : null
  if (!spec) return null
  const overlay = agent && spec.by_agent && Object.hasOwn(spec.by_agent, agent) ? spec.by_agent[agent] : null
  if (!overlay) return spec
  return {
    ...spec,
    extensions: [...new Set([...spec.extensions, ...(overlay.extensions || [])])],
    skills: [...new Set([...spec.skills, ...(overlay.skills || [])])],
    agents: mergeAgents(spec.agents, overlay.agents || []),
    mcp_servers: mergeMcpServers(spec.mcp_servers || [], overlay.mcp_servers || []),
  }
}

export function grantsFor(register, role, { root = REGISTER_ROOT, exists = existsSync, readFile = readFileSync } = {}) {
  const spec = register?.roles && Object.hasOwn(register.roles, role) ? register.roles[role] : null
  if (!spec) throw refuse('register-invalid', `runtime capability register has no grant for unknown role ${JSON.stringify(role)} under the runtime-policy rule`)

  const extensions = spec.extensions.map((relativePath) => {
    const path = resolvedGrantPath(root, relativePath)
    if (!pathExists(exists, path)) throw pathMessage('extension-missing', role, 'extension grant', 'an existing checkout-relative path', 'missing', path)
    return path
  })
  const skills = spec.skills.map((relativePath) => {
    const path = resolvedGrantPath(root, relativePath)
    if (!pathExists(exists, path)) throw pathMessage('unknown-skill', role, 'skill grant', 'an existing checkout-relative path', 'missing', path)
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
  return deepFreeze({
    tools: [...spec.tools],
    extensions,
    agents, skills,
    advisor: spec.advisor, requires: [...spec.requires],
    mcp_servers,
  })
}

const LEAN_FFF_BIN = '/opt/homebrew/bin/fff-mcp'
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

function registeredAgents(register, role, agent) {
  const own = agentSpec(register, role, agent)?.agents ?? []
  if (own.length > 0) return own
  const named = new Map()
  for (const spec of Object.values(register?.roles ?? {})) {
    for (const group of [spec, ...Object.values(spec?.by_agent ?? {})]) {
      for (const grant of group?.agents ?? []) if (!named.has(grant.name)) named.set(grant.name, grant)
    }
  }
  return [...named.values()]
}

// The grants one lean seat's effective definition asks for, and no others: a native extension name
// becomes its checkout extension, fff becomes the register's MCP server, and subagent brings
// the registered agent definitions it needs. Resolution and refusals are grantsFor's own; a declared
// asset that is missing refuses instead of leaving a weaker seat.
export function armGrants({ role, agent, extensions = [] }, { register = loadCapabilities(), root = REGISTER_ROOT, exists = existsSync, readFile = readFileSync } = {}) {
  const paths = []
  const mcp_servers = []
  for (const name of extensions) {
    if (LEAN_MCP_ARMS.includes(name)) {
      const server = registeredMcpServer(register, name)
      if (!server) throw refuse('unknown-grant', `seat ${role} extension ${JSON.stringify(name)} has no MCP server in the register`)
      if (!pathExists(exists, LEAN_FFF_BIN)) throw pathMessage('extension-missing', role, 'fff MCP server', 'an installed fff-mcp binary', 'missing', LEAN_FFF_BIN)
      mcp_servers.push(server)
    } else if (/^[a-z]+$/.test(name)) {
      paths.push(`crew/pi/extensions/${name}.ts`)
    } else {
      throw refuse('unknown-grant', `seat ${role} has unregistered extension ${JSON.stringify(name)}`)
    }
  }
  const fanout = agent === 'pi' && paths.includes(SUBAGENT_EXTENSION)
  const agents = fanout ? registeredAgents(register, role, agent) : []
  if (fanout && agents.length === 0) {
    throw refuse('unknown-grant', `seat ${role} asks for subagent but the register declares no agent definition for it`)
  }
  const narrow = { roles: { [role]: { tools: [], extensions: paths, agents, skills: [], advisor: false, requires: [], mcp_servers } } }
  return grantsFor(narrow, role, { root, exists, readFile })
}

export const EMPTY_GRANTS = deepFreeze({
  tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [],
})

export const SUBAGENT_EXTENSION = 'crew/pi/extensions/subagent.ts'
