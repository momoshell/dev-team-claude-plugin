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
// not the target checkout. The shipped file carries the claude Task fan-out
// grant; checkout-pinned pi assets remain reserved for a later slice, as does
// advisor runtime behavior.
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

export function assertGrantsBacked(role, grants, register) {
  const spec = register?.roles && Object.hasOwn(register.roles, role) ? register.roles[role] : null
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

