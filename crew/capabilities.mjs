// crew/capabilities.mjs — the runtime capability register and grant policy.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const CAPABILITY_REFUSALS = Object.freeze([
  'register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported',
  'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing',
  'local-endpoint-dead', 'grant-contradicts-deny',
])
const CAPABILITIES_PATH = join(HERE, 'capabilities.json')
const CAPABILITIES_SCHEMA_PATH = join(HERE, 'capabilities.schema.json')
export const REGISTER_ROOT = resolvePath(join(HERE, '..'))

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

  function walk(schemaNode, current, path) {
    const s = resolve(schemaNode)
    if (!s || typeof s !== 'object') {
      errors.push(`${path}: invalid schema reference`)
      return
    }
    if (Object.hasOwn(s, 'const')) {
      if (current !== s.const) errors.push(`${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(current)}`)
      return
    }
    if (s.enum && !s.enum.includes(current)) {
      errors.push(`${path}: ${JSON.stringify(current)} not in enum ${JSON.stringify(s.enum)}`)
      return
    }

    const matched = matchedTypes(current)
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type]
      if (!types.some((type) => matched.has(type))) {
        errors.push(`${path}: expected type ${types.join('|')}, got ${[...matched].join('|') || typeof current}`)
        return
      }
    }
    if (current === null) return
    if (typeof current === 'string' && s.pattern) {
      let valid = false
      try { valid = new RegExp(s.pattern).test(current) } catch { valid = false }
      if (!valid) errors.push(`${path}: ${JSON.stringify(current)} does not match pattern ${s.pattern}`)
    }
    if (Array.isArray(current) && s.items) {
      current.forEach((item, index) => walk(s.items, item, `${path}[${index}]`))
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const key of s.required || []) {
        if (!Object.hasOwn(current, key)) errors.push(`${path}: missing required property ${JSON.stringify(key)}`)
      }
      const patterns = Object.entries(s.patternProperties || {}).map(([pattern, child]) => [new RegExp(pattern), child])
      for (const [key, childValue] of Object.entries(current)) {
        const matchedSchemas = []
        if (s.properties && Object.hasOwn(s.properties, key)) matchedSchemas.push(s.properties[key])
        for (const [pattern, child] of patterns) if (pattern.test(key)) matchedSchemas.push(child)
        if (!matchedSchemas.length && s.additionalProperties === false) {
          errors.push(`${path}: additional property ${JSON.stringify(key)} not allowed`)
          continue
        }
        for (const child of matchedSchemas) walk(child, childValue, `${path}.${key}`)
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

function mergeAgents(base, overlay) {
  const out = new Map(base.map((grant) => [grant.name, grant]))
  for (const grant of overlay) out.set(grant.name, grant)
  return [...out.values()]
}

// #403 — the ADAPTER dimension. A role grant may carry `by_agent`, an overlay
// keyed by the RESOLVED adapter name (crew/crew.mjs:800), merged OVER the role
// grant. An adapter with no entry gets the role grant and nothing else, which
// is why the default claude planner is byte-identical after a pi-only grant
// lands — it never receives an extension it cannot express
// (crew/adapters/adapter-claude.mjs:65-72), rather than being filtered later.
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
  }
}

export function grantsFor(register, role, { root = REGISTER_ROOT, exists = existsSync, readFile = readFileSync, agent = null } = {}) {
  const spec = agentSpec(register, role, agent)
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

  return deepFreeze({
    tools: [...spec.tools], extensions, agents, skills,
    advisor: spec.advisor, requires: [...spec.requires],
  })
}

function relativeGrantMatches(declared, resolved) {
  const declaration = String(declared).replaceAll('\\', '/')
  const candidate = String(resolved).replaceAll('\\', '/')
  return candidate === declaration || candidate.endsWith(`/${declaration}`)
}

export function assertGrantsBacked(role, grants, register, { agent = null } = {}) {
  const spec = agentSpec(register, role, agent)
  if (!spec) throw refuse('unknown-grant', `seat ${role} has grants but no matching register role`)
  for (const tool of grants?.tools || []) {
    if (!spec.tools.includes(tool)) throw refuse('unknown-grant', `seat ${role} has unregistered tool grant ${JSON.stringify(tool)}`)
  }
  for (const extension of grants?.extensions || []) {
    if (!spec.extensions.some((declared) => relativeGrantMatches(declared, extension))) {
      throw refuse('unknown-grant', `seat ${role} has unregistered extension grant ${JSON.stringify(extension)}`)
    }
  }
  for (const skill of grants?.skills || []) {
    if (!spec.skills.some((declared) => relativeGrantMatches(declared, skill))) {
      throw refuse('unknown-grant', `seat ${role} has unregistered skill grant ${JSON.stringify(skill)}`)
    }
  }
  for (const agent of grants?.agents || []) {
    if (!spec.agents.some((declared) => declared.name === agent.name && relativeGrantMatches(declared.def, agent.def))) {
      throw refuse('unknown-grant', `seat ${role} has unregistered agent grant ${JSON.stringify(agent)}`)
    }
  }
  if (grants?.advisor === true && spec.advisor !== true) {
    throw refuse('unknown-grant', `seat ${role} has unregistered advisor grant`)
  }
  return grants
}

export const EMPTY_GRANTS = deepFreeze({
  tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [],
})

// A capability the REGISTER hands out, not one the binary simply has. The
// adapter declares what its CLI can do; crew/capabilities.json decides what
// THIS seat is given. HOW a grant delivers a capability is adapter-owned:
// pi turns `subagents` false→true when an agent definition is granted
// (crew/adapters/adapter-pi.mjs:74), while claude declares it invariantly true
// and carries fan-out only in the `Task` tool it was granted
// (crew/adapters/adapter-claude.mjs:17,61-63). So an adapter-owned false→true
// transition is trusted as delivery, and an already-true (invariant) profile
// still has to be backed by the registered tool — otherwise a claude seat with
// an agents-only grant would boot with no Task in its command line.
// Deliberately NOT inside adapter.capabilitiesFor(): visualizer/server/
// roster-edit.mjs and crew/daemon.mjs call that seam WITHOUT grants to
// pre-flight a roster cell, and narrowing there would refuse every claude
// planner in the propose-only editor.
export const CAPABILITY_DELIVERY = Object.freeze({
  subagents: Object.freeze({
    // claude: the CLI ships the Task tool and adapter-claude.mjs:61-63 merges a
    // granted tool into --allowedTools. Its declaration is invariantly true, so
    // the tool grant is the only thing that makes that declaration real.
    tools: Object.freeze(['Task']),
    // pi: the CLI ships NO subagent tool, so fan-out is an extension that
    // implements it plus an agent definition that names it
    // (crew/adapters/adapter-pi.mjs:24-26). Its capabilitiesFor flips on
    // grants.agents alone (:74), but seatCommand (:182-194) emits `-e
    // <extension>` and never emits the agent grant — an agents-only seat boots
    // --no-extensions with nothing to fan out with. The whole bundle or nothing.
    bundle: Object.freeze(['extensions', 'agents']),
  }),
})

export function effectiveCapabilities({ declared, bare, grants = EMPTY_GRANTS } = {}) {
  const nonEmpty = (key) => ((grants?.[key]) || []).length > 0
  const out = { ...declared }
  for (const [cap, delivery] of Object.entries(CAPABILITY_DELIVERY)) {
    if (out[cap] !== true) continue
    const delivered = bare?.[cap] === true
      // declared with no grants at all: the registered tool is what gives it to this seat
      ? delivery.tools.some((tool) => (grants?.tools || []).includes(tool))
      // declared only because of a grant: every piece the command line needs
      : delivery.bundle.every(nonEmpty)
    if (!delivered) out[cap] = false
  }
  return Object.freeze(out)
}

export const CAPABILITY_CLASSES = Object.freeze(['probe', 'vendor-binary', 'network', 'resolution'])
export const CAPABILITY_ADAPTERS = Object.freeze(['claude', 'pi'])
export const SUBAGENT_EXTENSION = 'crew/pi/extensions/subagent.ts'

// #623: this table asserts against mutable register data, never the presence of
// a name. An entry recording WHY a capability cannot be probed here is worth as
// much as a probe, because an unexercised claim must remain explicit.
export const CAPABILITY_PROBES = Object.freeze({
  advisor: Object.freeze({
    class: 'network',
    reason: 'The claim is a reachable model endpoint named by CREW_ADVISOR_ENDPOINT; probing that endpoint is a network call, and this suite deliberately makes none.',
  }),
  agents: Object.freeze({
    class: 'resolution',
    reason: 'The claim is that each registered agent definition is read, parsed, and checked for its declared name and non-empty prompt by grantsFor before delivery.',
  }),
  extensions: Object.freeze({
    class: 'resolution',
    reason: 'The claim is only that a checkout-relative path exists, which grantsFor and assertGrantsBacked already verify at their resolution checks; repeating that fact is redundancy sold as coverage. crew/pi/extensions/lab.ts is claimed as a path only: the probe imports it and reads none of its contents, so rewriting it cannot move this classification.',
  }),
  skills: Object.freeze({
    class: 'resolution',
    reason: 'The claim is only that a checkout-relative skill path exists, which grantsFor already verifies during resolution; no role grants a skill today, so there is no additional skill behavior for this checkout to exercise.',
  }),
  'subagents@claude': Object.freeze({
    class: 'vendor-binary',
    reason: 'The claim is that the Claude CLI ships a working Task tool; that executable belongs to the vendor rather than this checkout, so nothing short of spawning a real seat could exercise it.',
  }),
  'subagents@pi': Object.freeze({
    class: 'probe',
    reason: 'The claim is that crew/pi/extensions/subagent.ts plus crew/pi/agents/scout.json deliver fan-out, and both are in this checkout, so probeSubagentsPi loads and interrogates the granted bundle.',
    probe: probeSubagentsPi,
  }),
})

export function declaredCapabilities(register, { adapters = CAPABILITY_ADAPTERS } = {}) {
  const declared = new Set(['extensions', 'agents', 'skills', 'advisor'])
  const adapterNames = Array.isArray(adapters)
    ? [...new Set(adapters.map((adapter) => String(adapter)))]
    : []
  for (const spec of Object.values(register?.roles || {})) {
    for (const capability of spec?.requires || []) {
      for (const adapter of adapterNames) declared.add(`${capability}@${adapter}`)
    }
  }
  return [...declared].sort()
}

function probeErrorMessage(error) {
  try {
    const message = error?.message
    return message ? String(message) : String(error ?? 'unknown error')
  } catch {
    return 'unknown error'
  }
}

function probeErrorReason(error) {
  try { return String(error?.reason || 'unknown') } catch { return 'unknown' }
}

function grantBasename(path) {
  return String(path).replaceAll('\\', '/').split('/').pop() || ''
}

function capabilityFileURL(path) {
  const encoded = String(path).split('/').map((part) => encodeURIComponent(part)).join('/')
  return new URL(`file://${encoded}`).href
}

function restoreEnvironment(target, key, previous) {
  try {
    if (previous === undefined) delete target[key]
    else target[key] = previous
  } catch { /* environment restoration is best effort */ }
}

async function probeSubagentsPi(register, { root, load, env } = {}) {
  const findings = []
  const failures = []
  let grants

  try {
    grants = grantsFor(register, 'planner', { root, agent: 'pi' })
  } catch (error) {
    failures.push(`expected a resolvable pi fan-out bundle, found ${probeErrorReason(error)}: ${probeErrorMessage(error)}, at crew/capabilities.json`)
    return { findings, failures }
  }

  const bundle = CAPABILITY_DELIVERY.subagents.bundle
  if (!CAPABILITY_DELIVERY.subagents.bundle.every((kind) => (grants[kind] || []).length > 0)) {
    const emptyKind = bundle.find((kind) => (grants[kind] || []).length === 0) || 'unknown'
    failures.push(`expected a complete pi fan-out delivery bundle, found empty ${emptyKind}, at crew/capabilities.json`)
    return { findings, failures }
  }
  findings.push({ name: 'bundle', value: { extensions: grants.extensions.length, agents: grants.agents.length } })

  const payload = JSON.stringify(grants.agents.map(({ name, def }) => ({ name, def })))
  const loadedExtensions = []
  const extensionNames = []
  for (const path of grants.extensions) {
    try {
      const mod = await load(path)
      loadedExtensions.push({ path, mod })
      extensionNames.push(grantBasename(path))
    } catch (error) {
      failures.push(`expected the granted extension to load, found ${probeErrorMessage(error)}, at ${path}`)
    }
  }
  findings.push({ name: 'extensions-loaded', value: extensionNames })

  const delivering = loadedExtensions.find(({ path }) => relativeGrantMatches(SUBAGENT_EXTENSION, path))
  if (!delivering) {
    failures.push(`expected the granted subagent extension to load, found missing, at ${SUBAGENT_EXTENSION}`)
    return { findings, failures }
  }

  const mod = delivering.mod
  const names = grants.agents.map((one) => one.name)
  let tool
  try {
    tool = mod.createAgentTool({ env: { [mod.AGENTS_ENV]: payload } })
  } catch (error) {
    failures.push(`expected the granted extension to create its agent tool, found ${probeErrorMessage(error)}, at ${SUBAGENT_EXTENSION}`)
  }
  if (!tool || typeof mod?.AGENT_TOOL_NAME !== 'string' || tool.name !== mod?.AGENT_TOOL_NAME) {
    failures.push(`expected the agent tool name ${JSON.stringify(mod?.AGENT_TOOL_NAME)}, found ${JSON.stringify(tool?.name)}, at ${SUBAGENT_EXTENSION}`)
  }
  let toolEnum
  try { toolEnum = tool?.parameters?.properties?.agent?.enum } catch (error) {
    failures.push(`expected the agent tool enum to be readable, found ${probeErrorMessage(error)}, at ${SUBAGENT_EXTENSION}`)
  }
  try {
    if (JSON.stringify(toolEnum) !== JSON.stringify(names)) {
      failures.push(`expected the granted agent enum ${JSON.stringify(names)}, found ${JSON.stringify(toolEnum)}, at ${SUBAGENT_EXTENSION}`)
    }
  } catch (error) {
    failures.push(`expected the granted agent enum to be comparable, found ${probeErrorMessage(error)}, at ${SUBAGENT_EXTENSION}`)
  }
  findings.push({ name: 'tool-enum', value: toolEnum })

  const registered = []
  const subscribed = []
  const registrarEnv = env || process.env
  let envKey
  let previousEnv
  let previousProcessEnv
  try {
    envKey = mod?.AGENTS_ENV
    previousEnv = registrarEnv[envKey]
    previousProcessEnv = process.env[envKey]
    registrarEnv[envKey] = payload
    if (registrarEnv !== process.env) process.env[envKey] = payload
    await mod.default({
      registerTool: (toolValue) => registered.push(toolValue),
      on: (name) => subscribed.push(name),
    })
    let registeredEnum
    try { registeredEnum = registered[0]?.parameters?.properties?.agent?.enum } catch (error) {
      failures.push(`expected the registered agent enum to be readable, found ${probeErrorMessage(error)}, at ${SUBAGENT_EXTENSION}`)
    }
    let registeredMatches = registered.length === 1
      && registered[0]
      && registered[0].name === mod.AGENT_TOOL_NAME
    try { registeredMatches = registeredMatches && JSON.stringify(registeredEnum) === JSON.stringify(names) } catch {
      registeredMatches = false
    }
    if (!registeredMatches) {
      failures.push(`expected the registrar to register exactly one ${JSON.stringify(mod.AGENT_TOOL_NAME)} tool with the granted enum, found ${JSON.stringify(registered[0]?.name)}, at ${SUBAGENT_EXTENSION}`)
    }
    if (subscribed.length !== 1 || subscribed[0] !== 'tool_result') {
      failures.push(`expected the registrar to subscribe to tool_result, found ${JSON.stringify(subscribed)}, at ${SUBAGENT_EXTENSION}`)
    }
    findings.push({ name: 'registered-tool', value: registered[0]?.name })
  } catch (error) {
    failures.push(`expected the granted extension registrar to honor the agent grant, found ${probeErrorMessage(error)}, at ${SUBAGENT_EXTENSION}`)
  } finally {
    restoreEnvironment(registrarEnv, envKey, previousEnv)
    if (registrarEnv !== process.env) restoreEnvironment(process.env, envKey, previousProcessEnv)
  }

  for (const grant of grants.agents) {
    let loaded
    try {
      loaded = mod.loadAgentDefinition(grant)
    } catch (error) {
      failures.push(`expected a loadable agent definition for ${grant.name}, found ${probeErrorMessage(error)}, at ${grant.def}`)
      continue
    }
    if (loaded?.error) {
      failures.push(`expected a loadable agent definition for ${grant.name}, found ${loaded.error}, at ${grant.def}`)
      continue
    }
    const definition = loaded?.definition
    if (!definition || definition.name !== grant.name || !Array.isArray(definition.tools) || definition.tools.length === 0) {
      failures.push(`expected a named agent definition with non-empty tools for ${grant.name}, found ${JSON.stringify(definition)}, at ${grant.def}`)
      continue
    }

    let argv
    try {
      argv = mod.childArgs({ def: definition, task: 'capability probe', promptFile: '/dev/null' })
    } catch (error) {
      failures.push(`expected child arguments for ${grant.name}, found ${probeErrorMessage(error)}, at ${grant.def}`)
      continue
    }
    if (!Array.isArray(argv)) {
      failures.push(`expected child arguments for ${grant.name}, found ${JSON.stringify(argv)}, at ${grant.def}`)
      continue
    }
    const toolsValue = argv[argv.indexOf('--tools') + 1]
    if (toolsValue !== definition.tools.join(',')) {
      failures.push(`expected child --tools ${JSON.stringify(definition.tools.join(','))}, found ${JSON.stringify(toolsValue)}, at ${grant.def}`)
    }
    const excludeValue = argv[argv.indexOf('--exclude-tools') + 1]
    if (excludeValue !== mod.SUBAGENT_DENY.join(',')) {
      failures.push(`expected child --exclude-tools ${JSON.stringify(mod.SUBAGENT_DENY.join(','))}, found ${JSON.stringify(excludeValue)}, at ${grant.def}`)
    }
    let deniedAbsent = false
    try { deniedAbsent = mod.SUBAGENT_DENY.every((denied) => !definition.tools.includes(denied)) } catch { /* reported below */ }
    if (!deniedAbsent) {
      failures.push(`expected child tools not to include denied tools, found ${JSON.stringify(definition.tools)}, at ${grant.def}`)
    }
    findings.push({ name: 'child-args', value: argv })
  }

  return { findings, failures }
}

export async function probeCapability(key, {
  register = null,
  root = REGISTER_ROOT,
  load = (path) => import(capabilityFileURL(path)),
  env = process.env,
} = {}) {
  const entry = Object.hasOwn(CAPABILITY_PROBES, key) ? CAPABILITY_PROBES[key] : undefined
  if (!entry) throw new Error(`unknown capability ${JSON.stringify(key)}`)
  if (entry.class !== 'probe') {
    return { key, class: entry.class, reason: entry.reason, probed: false, ok: true, findings: [], failures: [] }
  }

  const findings = []
  const failures = []
  let resolvedRegister = register
  if (resolvedRegister === null) {
    try {
      resolvedRegister = loadCapabilities()
    } catch (error) {
      failures.push(`expected a resolvable pi fan-out bundle, found ${probeErrorReason(error)}: ${probeErrorMessage(error)}, at crew/capabilities.json`)
    }
  }
  if (failures.length === 0) {
    try {
      const result = await (entry.probe || probeSubagentsPi)(resolvedRegister, { root, load, env })
      findings.push(...(result?.findings || []))
      failures.push(...(result?.failures || []))
    } catch (error) {
      failures.push(`expected the pi fan-out probe to complete, found ${probeErrorMessage(error)}, at crew/capabilities.json`)
    }
  }
  return { key, class: entry.class, reason: entry.reason, probed: true, ok: failures.length === 0, findings, failures }
}

