import { fileURLToPath } from 'node:url'
import { join, isAbsolute } from 'node:path'

// ACP launch for pi seats.
// pi namespaces models as <pi-provider>/<id>. openai -> openai-codex is
// DELIBERATE: that provider routes through the ChatGPT subscription OAuth
// (verified `pi auth check --provider openai-codex`). meta -> meta is the Muse
// Code subscription OAuth at api.meta.ai, not per-token OpenRouter (probed
// 2026-10-16 against muse-spark-1.3-contributor and muse-wonder-1.0-contributor).
export const PI_PROVIDERS = Object.freeze({ openai: 'openai-codex', anthropic: 'anthropic', meta: 'meta' })

// An own-property lookup prevents Object.prototype names from resolving as providers (#739).
const own = (obj, key) => Boolean(obj) && typeof obj === 'object' && Object.hasOwn(obj, key)

export function modelString({ provider, id }) {
  const p = own(PI_PROVIDERS, provider) ? PI_PROVIDERS[provider] : undefined
  if (!p) {
    const known = Object.keys(PI_PROVIDERS)
    throw new Error(`adapter-pi: no pi provider for roster provider "${provider}" (known: ${known.join(', ')}) — refusing a guessed passthrough: pi synthesizes phantom models on narrowed lookups`)
  }
  return `${p}/${id}`
}

// claude tool name -> pi tool name. null = the tool has no pi equivalent, so
// denying it is vacuously satisfied: pi has NO subagent tool at all, which is
// why Task/Agent drop. The drop stays honest only because the grant that would
// make pi fan out is checked against the extension table at boot; the
// dropped denial itself enforces nothing.
const PI_TOOL_NAMES = Object.freeze({
  Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash',
  Glob: 'find', Grep: 'grep',
  NotebookEdit: null, Task: null, Agent: null, Workflow: null,
})

// pi's COMPLETE built-in tool set, in pi's own namespace, as literals
// (dist/core/tools/index.js:17 — allToolNames, pi 0.84.2). This is the
// adapter's own knowledge of pi, NOT a translation of the seat's
// claude-named `tools` allowlist: #146/#147 ratified that that list stays
// unused, and mapping it here would undo both.
export const PI_BUILTIN_TOOLS = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])

const PI_ACP_GATED_TOOLS = Object.freeze(['bash', 'edit', 'write', 'powershell'])

// Unknown claude names DROP rather than pass through: passing an unmatched
// name would be inert inside pi anyway, and a typo must not look enforced.
export function translateDeny(deny) {
  const out = []
  for (const raw of String(deny || '').split(',')) {
    const name = raw.trim()
    if (!name) continue
    const mapped = PI_TOOL_NAMES[name]
    if (!mapped) continue
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out
}

// RV1-2: the diagnosis is a PARAMETER, not a constant prefix. Hardcoding
// 'unknown-registering-extension' made a declared-but-malformed extension report
// the wrong cause, and every assertion that checked for the token passed on text
// that proved nothing — the D1 fixture path is
// crew/pi/extensions/unknown-registering-extension.ts, so the token appeared via
// the interpolated path no matter which refusal fired.
function piExtensionRefusal(extension, expected, found, diagnosis = 'malformed-extension-declaration') {
  const error = new Error(`adapter-pi: ${diagnosis} "${extension}": expected ${expected}, found ${found} [grant-unsupported]`)
  error.reason = 'grant-unsupported'
  error.diagnosis = diagnosis
  return error
}

// The extension whose declaration backs an `agents` grant. Named here, beside
// the table that keys it; the adapter must not depend on the register to compose a command.
export const SUBAGENT_EXTENSION = 'crew/pi/extensions/subagent.ts'

export const PI_BUILTIN_EXTENSION_TOOLS = Object.freeze({
  'builtin:mcp': Object.freeze([]),
})
export const PI_MCP_SERVER_TOOLS = Object.freeze({
  fff: Object.freeze(['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']),
})

function piMcpTools(mcpServers) {
  const activated = new Set()
  for (const server of mcpServers || []) {
    if (!own(PI_MCP_SERVER_TOOLS, server.name)) throw piExtensionRefusal(server.name, 'a declared pi MCP server', 'missing declaration')
    for (const tool of PI_MCP_SERVER_TOOLS[server.name] || []) activated.add(tool)
  }
  return [...activated]
}

export const PI_FIRST_PARTY_EXTENSION_TOOLS = Object.freeze({
  'crew/pi/extensions/advisor.ts': Object.freeze([]),
  'crew/pi/extensions/readgate.ts': Object.freeze([]),
  'crew/pi/extensions/skeletonread.ts': Object.freeze(['retrieve']),
  'crew/pi/extensions/subagent.ts': Object.freeze(['agent']),
})

export function validatePiExtensionTools(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw piExtensionRefusal('<table>', 'an object keyed by checkout-relative extension paths', JSON.stringify(table))
  }
  for (const [extension, tools] of Object.entries(table)) {
    if (!Array.isArray(tools)) throw piExtensionRefusal(extension, 'an array of tool names', JSON.stringify(tools))
    for (const tool of tools) {
      if (typeof tool !== 'string' || tool.trim() === '') throw piExtensionRefusal(extension, 'a non-blank string tool name', JSON.stringify(tool))
    }
  }
  return table
}

const normaliseExtensionPath = (extension) => String(extension).replaceAll('\\', '/')

export function piActivatedTools({ tools = [], extensions = [], agents = [], mcpServers = [], table = PI_FIRST_PARTY_EXTENSION_TOOLS } = {}) {
  const validated = validatePiExtensionTools(table)
  const activated = new Set([...PI_BUILTIN_TOOLS, ...tools])
  for (const extension of extensions.map(normaliseExtensionPath)) {
    if (Object.hasOwn(PI_BUILTIN_EXTENSION_TOOLS, extension)) {
      for (const tool of PI_BUILTIN_EXTENSION_TOOLS[extension]) activated.add(tool)
      if (extension === 'builtin:mcp') for (const tool of piMcpTools(mcpServers)) activated.add(tool)
      continue
    }
    const declaration = Object.keys(validated).find((key) => extension === key || extension.endsWith(`/${key}`))
    if (!declaration) throw piExtensionRefusal(extension, 'a declared first-party extension', 'missing declaration', 'unknown-registering-extension')
    for (const tool of validated[declaration]) activated.add(tool)
  }
  // RV1-1: deriving the allowlist from the extension TABLE dropped the old
  // `fanout` branch, which keyed off grants.agents. A role granting agents
  // without also being granted the extension that REGISTERS the agent tool then
  // booted with CREW_PI_AGENTS populated and no `agent` in --tools: fan-out
  // silently dead, no refusal, where it previously worked. An unbacked grant is
  // refused by name at composition time rather than dropped.
  const subagentTools = validated[SUBAGENT_EXTENSION] || []
  if (agents.length > 0 && !subagentTools.every((tool) => activated.has(tool))) {
    throw piExtensionRefusal(
      SUBAGENT_EXTENSION,
      `a granted extension registering ${JSON.stringify(subagentTools)}, because ${agents.length} agent grant(s) are declared`,
      'no granted extension declares it',
      'agent-grant-unbacked',
    )
  }
  return [...activated]
}

// The advisor extension a register-granted seat loads. The register grants a
// BOOLEAN, not a path, so the path is the adapter's own checkout-pinned
// knowledge — resolved from this file's URL, never from cwd.
export const PI_ADVISOR_EXTENSION = fileURLToPath(new URL('../pi/extensions/advisor.ts', import.meta.url))

export function piSeatAgentDir({ taskDir, role } = {}) {
  if (typeof taskDir !== 'string' || !taskDir.trim() || !isAbsolute(taskDir)) throw new Error('adapter-pi: taskDir must be a non-blank absolute path')
  if (typeof role !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(role)) throw new Error(`adapter-pi: unsafe role ${JSON.stringify(role)}`)
  return join(taskDir, 'pi-agent', role)
}

function piFffEnv(grants) {
  const granted = grants?.extensions?.includes('builtin:mcp') && grants?.mcp_servers?.some((server) => server?.name === 'fff')
  return { CREW_FFF: granted ? '1' : '0' }
}

function hasPiAgentDir(grants) {
  return grants?.extensions?.some((extension) => extension === 'builtin:mcp')
}

function isPiSeatWithheldEnvKey(key) { return key.startsWith('CREW_ADVISOR') || key === 'CREW_PI_AGENTS' }

// A key the seat parts withheld must not return via the daemon's inherited
// env; an explicit seat-env value (the grant-built one) always wins. Node
// drops undefined env values at spawn.
export function piSeatSpawnEnv(inherited = {}, seatEnv = {}) { const env = { ...inherited, ...seatEnv }; for (const key of Object.keys(inherited)) if (isPiSeatWithheldEnvKey(key) && !Object.hasOwn(seatEnv, key)) env[key] = undefined; return env }

export function piSeatParts(spec = {}) {
  const { model, effort, promptFile, deny, env = {}, grants = NO_GRANTS, role, taskDir } = spec
  const agentDir = hasPiAgentDir(grants) ? piSeatAgentDir({ taskDir, role }) : undefined
  const piDeny = translateDeny(deny)
  const advisor = grants?.advisor === true
  const extensions = [...new Set([...(grants?.extensions || []), ...(advisor ? [PI_ADVISOR_EXTENSION] : [])])]
  const activatedTools = piActivatedTools({ tools: grants?.tools, extensions, agents: grants?.agents || [], mcpServers: grants?.mcp_servers || [] })
  const skills = grants?.skills || []
  return {
    args: [
      '--model', model, ...(effort ? ['--thinking', effort] : []),
      '--append-system-prompt', promptFile, '--tools', activatedTools.join(','),
      ...(piDeny.length ? ['--exclude-tools', piDeny.join(',')] : []),
      '--no-context-files', '--no-extensions', ...extensions.flatMap((extension) => ['-e', extension]),
      '--no-skills', ...skills.flatMap((skill) => ['--skill', skill]),
    ],
    env: {
      ...Object.fromEntries(Object.entries(env).filter(([key]) => !isPiSeatWithheldEnvKey(key))),
      ...piFffEnv(grants),
      ...(agentDir !== null && agentDir !== undefined ? { PI_CODING_AGENT_DIR: agentDir } : {}),
      ...(advisor ? { CREW_ADVISOR: '1' } : {}),
      ...(grants?.agents?.length ? { CREW_PI_AGENTS: JSON.stringify(grants.agents.map(({ name, def }) => ({ name, def }))) } : {}),
    },
  }
}

export function acpLaunch(spec = {}) {
  const { bin, cwd, deny } = spec
  if (!isAbsolute(bin)) throw new Error(`adapter-pi: ACP pi binary must be absolute: ${String(bin)}`)
  for (const raw of String(deny || '').split(',')) {
    const name = raw.trim()
    if (!name) continue
    if (!Object.hasOwn(PI_TOOL_NAMES, name)) throw new Error(`adapter-pi: unknown ACP deny tool "${name}"`)
  }
  const excluded = translateDeny(deny)
  const GATED_TOOLS = PI_ACP_GATED_TOOLS
  const gated = GATED_TOOLS.filter((tool) => !excluded.includes(tool))
  const bridge = fileURLToPath(new URL('../pi/acp-bridge.mjs', import.meta.url))
  const seat = piSeatParts(spec)
  const seatArgs = seat.args
  return {
    bin: process.execPath,
    args: [bridge, ...seatArgs],
    env: { ...seat.env, CREW_PI_BIN: bin, CREW_ACP_GATED_TOOLS: gated.join(',') },
    sessionParams: { cwd, mcpServers: [] },
  }
}

const NO_GRANTS = Object.freeze({ tools: [], extensions: [], agents: [], skills: [], advisor: false })
