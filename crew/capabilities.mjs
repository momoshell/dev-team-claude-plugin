// crew/capabilities.mjs — the runtime capability register and grant policy.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CAPABILITY_REFUSALS, REGISTER_ROOT, refuse, validateCapabilities, loadCapabilities,
  resolvedGrantPath, pathExists, pathMessage, VENDOR_ROOT_ENV, PI_AGENT_DIR_ENV, vendorRoots,
  resolveVendorExtension, mergeMcpServers, grantsFor, armGrants, assertGrantsBacked,
  EMPTY_GRANTS, SUBAGENT_EXTENSION, relativeGrantMatches,
} from './acp/grants.mjs'

export {
  CAPABILITY_REFUSALS, REGISTER_ROOT, refuse, validateCapabilities, loadCapabilities,
  resolvedGrantPath, pathExists, pathMessage, VENDOR_ROOT_ENV, PI_AGENT_DIR_ENV, vendorRoots,
  resolveVendorExtension, mergeMcpServers, grantsFor, armGrants, assertGrantsBacked,
  EMPTY_GRANTS, SUBAGENT_EXTENSION,
}

export const AGENT_AVAILABILITY_STATES = Object.freeze([
  'executable', 'discovered-unavailable', 'installed-unconfigured', 'proposal-stub',
])
export const AGENT_AVAILABILITY_REASONS = Object.freeze([
  'executable', 'proposal-stub', 'adapter-import-failed', 'discovered-unavailable',
  'shim-not-binary', 'version-spawn-failed', 'version-interrupted',
  'installed-unconfigured', 'transport-refused',
])
export function seatableLocalProviderNames(register) {
  return Object.keys(register?.local_providers ?? {})
}

function agentAvailabilityResult(entry, agent, state, reason = state) {
  if (!AGENT_AVAILABILITY_REASONS.includes(reason)) {
    throw new Error(`unknown agent availability reason ${JSON.stringify(reason)}`)
  }
  return Object.freeze({
    agent,
    state,
    reason,
    display_name: entry.display_name,
    install_hint: entry.install_hint,
  })
}

function agentUnavailable(role, agent, availability) {
  return Object.assign(
    refuse('agent-unavailable', `seat ${role} coding agent ${JSON.stringify(agent)} unavailable: state ${availability.state}, reason ${availability.reason}, at coding_agents.${agent}`),
    { state: availability.state, availability_reason: availability.reason },
  )
}

function unavailableRosterAgent(location, agent, availability) {
  return Object.assign(
    refuse('agent-unavailable', `roster cell ${location} coding agent ${JSON.stringify(agent)} unavailable: state ${availability.state}, reason ${availability.reason}, at ${location}.agent`),
    { state: availability.state, availability_reason: availability.reason },
  )
}

export function agentAvailability(register, agent, probe = null) {
  const codingAgents = register?.coding_agents
  const entry = typeof agent === 'string' && codingAgents && Object.hasOwn(codingAgents, agent)
    ? codingAgents[agent]
    : null
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw refuse('agent-unresolved', `expected coding agent ${JSON.stringify(agent)}, found no entry, at coding_agents.${agent}`)
  }

  if (probe === null) return agentAvailabilityResult(entry, agent, entry.availability, entry.availability_reason)

  const exists = probe?.exists ?? existsSync
  const which = probe?.which ?? null
  const adapterPath = resolvedGrantPath(REGISTER_ROOT, entry.adapter)
  if (!pathExists(exists, adapterPath)) return agentAvailabilityResult(entry, agent, 'proposal-stub', 'proposal-stub')
  if (probe?.adapterLoadError) return agentAvailabilityResult(entry, agent, 'proposal-stub', 'adapter-import-failed')

  let binary = null
  if (which !== null) {
    try { binary = which(entry.binary) } catch {}
    if (which !== null && !binary) return agentAvailabilityResult(entry, agent, 'discovered-unavailable', 'discovered-unavailable')
  }

  const version = probe?.version ?? null
  if (version?.error) return agentAvailabilityResult(entry, agent, 'discovered-unavailable', 'version-spawn-failed')
  if (version && version.status === null && version.signal) return agentAvailabilityResult(entry, agent, 'discovered-unavailable', 'version-interrupted')
  if (version && version.status !== 0) return agentAvailabilityResult(entry, agent, 'discovered-unavailable', 'shim-not-binary')

  if (which !== null && Array.isArray(entry.config) && entry.config.length) {
    const home = typeof probe?.home === 'string' ? probe.home : ''
    const configured = entry.config.some((configPath) => {
      const candidate = configPath.startsWith('~/') ? join(home, configPath.slice(2)) : configPath
      return pathExists(exists, candidate)
    })
    if (!configured) return agentAvailabilityResult(entry, agent, 'installed-unconfigured', 'installed-unconfigured')
  }

  if (probe?.transportRefusals?.length) return agentAvailabilityResult(entry, agent, 'installed-unconfigured', 'transport-refused')
  return agentAvailabilityResult(entry, agent, 'executable', 'executable')
}

export function agentRegisterEntry(register, agent, { role = 'unknown', probe } = {}) {
  const codingAgents = register?.coding_agents
  if (typeof agent !== 'string' || !codingAgents || !Object.hasOwn(codingAgents, agent) || !codingAgents[agent]) {
    throw refuse('agent-unresolved', `seat ${role} expected coding agent ${JSON.stringify(agent)}, found no entry, at coding_agents.${agent}`)
  }
  const availability = agentAvailability(register, agent, probe)
  if (availability.state !== 'executable') throw agentUnavailable(role, agent, availability)
  return register.coding_agents[agent]
}

export function validateRosterAgents(roster, register, probe = null) {
  for (const mapName of ['tiers', 'assurances']) {
    const seating = roster?.[mapName]
    if (!seating || typeof seating !== 'object' || Array.isArray(seating)) continue
    for (const [tier, cells] of Object.entries(seating)) {
      if (!cells || typeof cells !== 'object' || Array.isArray(cells)) continue
      for (const [role, cell] of Object.entries(cells)) {
        if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) continue
        validateCell(cell, `${mapName}.${tier}.${role}`)
      }
    }
  }
  return roster

  function validateCell(cell, location) {
    validateAgent(cell.agent, location)
    for (const [index, fallback] of (Array.isArray(cell.fallback) ? cell.fallback : []).entries()) {
      if (fallback === null || typeof fallback !== 'object' || Array.isArray(fallback)) continue
      validateAgent(fallback.agent, `${location}.fallback[${index}]`)
    }
  }

  function validateAgent(agent, location) {
    const codingAgents = register?.coding_agents
    if (typeof agent !== 'string' || !codingAgents || !Object.hasOwn(codingAgents, agent)) {
      throw refuse('agent-unresolved', `roster cell ${location} expected coding agent ${JSON.stringify(agent)}, found no entry, at coding_agents.${agent}`)
    }
    const availability = agentAvailability(register, agent, probe)
    if (availability.state !== 'executable') throw unavailableRosterAgent(location, agent, availability)
  }
}

export function assertAgentProvider(register, agent, provider, { role = 'unknown' } = {}) {
  const entry = agentRegisterEntry(register, agent, { role })
  if (!entry.providers.includes(provider)) throw refuse('agent-provider-unsupported', `seat ${role} expected coding agent ${agent} to drive provider ${JSON.stringify(provider)}, found ${JSON.stringify(entry.providers)}, at coding_agents.${agent}.providers`)
  return entry
}

export function assertAgentTransport(register, agent, transport, { role = 'unknown' } = {}) {
  const entry = agentRegisterEntry(register, agent, { role })
  if (!entry.transports.includes(transport)) throw refuse('capability-shortfall', `seat ${role} expected coding agent ${agent} to use transport ${JSON.stringify(transport)}, found ${JSON.stringify(entry.transports)}, at coding_agents.${agent}.transports`)
  return entry
}

export function assertAgentAdapter(register, agent, adapterPath, { role = 'unknown' } = {}) {
  const entry = agentRegisterEntry(register, agent, { role })
  const expected = String(entry.adapter).replaceAll('\\', '/')
  const found = String(adapterPath).replaceAll('\\', '/')
  const matches = found === expected || found.endsWith(`/${expected}`)
  if (!matches) throw refuse('register-invalid', `seat ${role} expected coding agent ${agent} adapter ${JSON.stringify(expected)}, found ${JSON.stringify(adapterPath)}, at coding_agents.${agent}.adapter`)
  return entry
}

export function assertAgentRefusals(register, agent, activeDimensions, { role = 'unknown' } = {}) {
  const entry = agentRegisterEntry(register, agent, { role })
  const active = Array.isArray(activeDimensions) ? activeDimensions : []
  const refused = active.filter((dimension) => entry.refuses.includes(dimension))
  if (refused.length) throw refuse('grant-unsupported', `seat ${role} expected coding agent ${agent} to express active dimensions ${JSON.stringify(active)}, found refused ${JSON.stringify(refused)}, at coding_agents.${agent}.refuses`)
  return entry
}

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
  const nonEmpty = (key) => ((grants?.[key]) || []).some((value) => key !== 'extensions' || !String(value).startsWith('builtin:'))
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
// TRD §4.1; #795 spreads this frozen transport profile into each adapter's PROFILES.
export const ACP_TRANSPORT_PROFILE = Object.freeze({ interjection: 'turn', abort: 'cancel', session_resume: true, durable_cursor: 'protocol', reassign: false })

// #623: this table asserts against mutable register data, never the presence of
// a name. An entry recording WHY a capability cannot be probed here is worth as
// much as a probe, because an unexercised claim must remain explicit.
export const CAPABILITY_PROBES = Object.freeze({
  advisor: Object.freeze({
    class: 'network',
    reason: 'The claim is a register-granted roster consult launched as a local tool-less child; it makes no CREW_ADVISOR_ENDPOINT network probe.',
  }),
  agents: Object.freeze({
    class: 'resolution',
    reason: 'The claim is that each registered agent definition is read, parsed, and checked for its declared name and non-empty prompt by grantsFor before delivery.',
  }),
  extensions: Object.freeze({
    class: 'resolution',
    reason: 'The claim is that each granted extension path exists and is backed by a register declaration; checkout-relative paths and host-resolved vendor paths are both covered by grantsFor and assertGrantsBacked, so repeating that fact is redundancy sold as coverage. crew/pi/extensions/lab.ts is claimed as a path only: the probe imports it and reads none of its contents, so rewriting it cannot move this classification.',
  }),
  vendor_extensions: Object.freeze({
    class: 'vendor-binary',
    reason: "The claim is that a package the OPERATOR installed under pi's own npm root declares the pi extension entries this checkout can name. That package belongs to the host rather than this checkout, so nothing short of a host with it installed could exercise it; absence is refused by name (vendor-extension-missing) for a required grant and recorded by the same name for an optional one.",
  }),
  skills: Object.freeze({
    class: 'resolution',
    reason: 'The claim is only that a checkout-relative skill path exists, which grantsFor already verifies during resolution; no role grants a skill today, so there is no additional skill behavior for this checkout to exercise.',
  }),
  mcp_servers: Object.freeze({
    class: 'resolution',
    reason: 'The claim is that each inline MCP server definition is selected from the immutable register, merged by adapter overlay, and resolved without inheriting host configuration.',
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
  const declared = new Set(['extensions', 'agents', 'vendor_extensions', 'skills', 'advisor', 'mcp_servers'])
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

