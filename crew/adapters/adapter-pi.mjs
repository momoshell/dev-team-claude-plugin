import { fileURLToPath } from 'node:url'
import { join, isAbsolute } from 'node:path'

// crew/adapters/adapter-pi.mjs — ACP launch and capability profile for pi seats.
const INVARIANT = Object.freeze({
  // --append-system-prompt treats an existing path as file contents
  // (verified in pi's resource-loader), so the merged role file lands intact.
  prompt_file: true,
  // --exclude-tools is pi's enforced denylist (filters the active tool set
  // by exact name match). translateDeny() maps the seat's claude-named deny
  // list into pi's own tool namespace before it reaches this flag — see the
  // translation table below.
  tool_deny: true,
  // pi has no per-tool approval gate at all, so there is nothing to bypass.
  // (--approve/-a only governs trusting project-local config files, not
  // tool calls — deliberately not passed here.)
  unattended: true,
  // pi ships no subagent tool, so fan-out is a GRANT: an extension plus an
  // agent definition named in the checkout-pinned capability register, never
  // an assumption about the binary.
  subagents: false,
  // --thinking <off|minimal|low|medium|high|xhigh|max> (also the
  // ':<level>' model-string shorthand) — live-verified 2026-08-13: a
  // luna:high seat showed "gpt-5.6-luna • high" in its status bar.
  effort: true,
  // PI_CODING_AGENT_DIR (below) and the pi_provider namespace lookup
  // (modelString) are the checkout-pinned local-provider seams.
  local_provider: true,
})

const PROFILES = Object.freeze({
  // Literal, not spread from capabilities.mjs ACP_TRANSPORT_PROFILE: this module is in
  // subagent.ts's import closure, which must stay node:-only (subagent.test.mjs).
  // capabilities.test.mjs pins every shared key to ACP_TRANSPORT_PROFILE.
  acp: Object.freeze({
    interjection: 'turn',
    abort: 'cancel',
    // acp-server.ts advertises loadSession: false.
    session_resume: false,
    durable_cursor: 'protocol',
    reassign: false,
    // acp-server.ts forwards tool permission requests.
    permission_requests: true,
  }),
})

export function capabilitiesFor({ transport, grants } = {}) {
  const p = transport === 'acp' ? PROFILES.acp : null
  if (!p) throw new Error(`adapter-pi: no capability profile for transport "${transport}" (shipped: ${Object.keys(PROFILES).join(', ')}) — refusing a guessed passthrough`)
  if (grants?.extensions?.includes('builtin:mcp')) piMcpTools(grants.mcp_servers || [])
  return Object.freeze({
    ...INVARIANT, ...p,
    ...(grants?.extensions?.includes('builtin:mcp') ? { mcp_servers: true } : {}),
    // Fan-out is available only to seats granted agents.
    subagents: (grants?.agents?.length ?? 0) > 0,
  })
}

// pi namespaces models as <pi-provider>/<id>. openai -> openai-codex is
// DELIBERATE: that provider routes through the ChatGPT subscription OAuth
// (verified `pi auth check --provider openai-codex`). meta -> meta is the Muse
// Code subscription OAuth at api.meta.ai, not per-token OpenRouter (probed
// 2026-10-16 against muse-spark-1.3-contributor and muse-wonder-1.0-contributor).
export const PI_PROVIDERS = Object.freeze({ openai: 'openai-codex', anthropic: 'anthropic', meta: 'meta' })

// An OWN-property lookup on BOTH halves (#739): a bare bracket read reaches
// Object.prototype, so a roster provider named `toString` or `constructor`
// resolved to a function — truthy — and modelString synthesized
// `function toString() { [native code] }/<id>` instead of taking the refusal
// below. adapter-claude.mjs's modelString already guards its local half the
// same way. An OWN property is still honoured even when its name collides
// with a prototype member, and a null-prototype register behaves identically.
const own = (obj, key) => Boolean(obj) && typeof obj === 'object' && Object.hasOwn(obj, key)

export function modelString({ provider, id, localProviders }) {
  const p = own(PI_PROVIDERS, provider)
    ? PI_PROVIDERS[provider]
    : own(localProviders, provider) ? localProviders[provider]?.pi_provider : undefined
  if (!p) {
    const known = Object.keys({ ...PI_PROVIDERS, ...(localProviders || {}) })
    throw new Error(`adapter-pi: no pi provider for roster provider "${provider}" (known: ${known.join(', ')}) — refusing a guessed passthrough: pi synthesizes phantom models on narrowed lookups`)
  }
  return `${p}/${id}`
}

// claude tool name -> pi tool name. null = the tool has no pi equivalent, so
// denying it is vacuously satisfied: pi has NO subagent tool at all, which is
// why Task/Agent drop. The drop stays honest only because the grant that would
// make pi fan out is refused at boot (assertFanoutCoherent, crew/crew.mjs); the
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

export const PI_ACP_GATED_TOOLS = Object.freeze(['bash', 'edit', 'write', 'powershell'])

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
// the table that keys it, rather than imported from crew/capabilities.mjs — the
// adapter must not depend on the register to compose a command.
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

export function piActivatedTools({ tools = [], extensions = [], vendorExtensions = [], agents = [], mcpServers = [], table = PI_FIRST_PARTY_EXTENSION_TOOLS } = {}) {
  const validated = validatePiExtensionTools(table)
  const activated = new Set([...PI_BUILTIN_TOOLS, ...tools])
  const vendorEntries = new Set(vendorExtensions.flatMap((grant) => grant?.entries || []).map(normaliseExtensionPath))
  for (const extension of extensions.map(normaliseExtensionPath)) {
    if (Object.hasOwn(PI_BUILTIN_EXTENSION_TOOLS, extension)) {
      for (const tool of PI_BUILTIN_EXTENSION_TOOLS[extension]) activated.add(tool)
      if (extension === 'builtin:mcp') for (const tool of piMcpTools(mcpServers)) activated.add(tool)
      continue
    }
    if (vendorEntries.has(extension)) continue
    const declaration = Object.keys(validated).find((key) => extension === key || extension.endsWith(`/${key}`))
    if (!declaration) throw piExtensionRefusal(extension, 'a declared first-party extension', 'missing declaration', 'unknown-registering-extension')
    for (const tool of validated[declaration]) activated.add(tool)
  }
  // RV1-1: deriving the allowlist from the extension TABLE dropped the old
  // `fanout` branch, which keyed off grants.agents. A role granting agents
  // without also being granted the extension that REGISTERS the agent tool then
  // booted with CREW_PI_AGENTS populated and no `agent` in --tools: fan-out
  // silently dead, no refusal, where it previously worked. An unbacked grant is
  // refused by name at composition time rather than dropped, which is the same
  // rule assertGrantsBacked applies to a grant naming something unbacked.
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

// ADR-047 §1: a consult is spelled by the advisor agent's adapter, never passed raw. The
// boot record keeps the canonical catalog key as its identity (`model`) and carries this
// adapter's spelling in `consult_model`; the extension checks its model against the catalog
// it is handed and passes the same string to `pi --model`, so the catalog handed down is
// keyed by the spelling. A record without `consult_model` (written before ADR-047) keeps
// its legacy shape exactly.
export function advisorLaunchCell(record) {
  if (!record) return null
  const models = record.model_only ? record.models : undefined
  if (typeof record.consult_model !== 'string' || record.consult_model === record.model) {
    return { endpoint: record.endpoint, model: record.model, models }
  }
  const entry = models && Object.hasOwn(models, record.model) ? models[record.model] : undefined
  return { endpoint: record.endpoint, model: record.consult_model, models: entry === undefined ? {} : { [record.consult_model]: entry } }
}

export function piSeatAgentDir({ taskDir, role } = {}) {
  if (typeof taskDir !== 'string' || !taskDir.trim() || !isAbsolute(taskDir)) throw new Error('adapter-pi: taskDir must be a non-blank absolute path')
  if (typeof role !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(role)) throw new Error(`adapter-pi: unsafe role ${JSON.stringify(role)}`)
  return join(taskDir, 'pi-agent', role)
}

export function mcpConfigPath(spec) { return join(piSeatAgentDir(spec), 'mcp.json') }

function piFffEnv(grants) {
  const granted = grants?.extensions?.includes('builtin:mcp') && grants?.mcp_servers?.some((server) => server?.name === 'fff' && server?.command?.bin === '/opt/homebrew/bin/fff-mcp')
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

export function piRpcSeatParts(spec = {}) {
  const { model, effort, promptFile, deny, env = {}, grants = NO_GRANTS, configDir, advisorCell = null, role, taskDir } = spec
  const agentDir = hasPiAgentDir(grants) ? piSeatAgentDir({ taskDir, role }) : configDir
  const piDeny = translateDeny(deny)
  const advisor = grants?.advisor === true
  const extensions = [...new Set([...(grants?.extensions || []), ...(advisor ? [PI_ADVISOR_EXTENSION] : [])])]
  const activatedTools = piActivatedTools({ tools: grants?.tools, extensions, vendorExtensions: grants?.vendor_extensions, agents: grants?.agents || [], mcpServers: grants?.mcp_servers || [] })
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
  const { bin, cwd, deny, role } = spec
  if (!isAbsolute(bin)) throw new Error(`adapter-pi: ACP pi binary must be absolute: ${String(bin)}`)
  for (const raw of String(deny || '').split(',')) {
    const name = raw.trim()
    if (!name) continue
    if (!Object.hasOwn(PI_TOOL_NAMES, name)) throw new Error(`adapter-pi: unknown ACP deny tool "${name}"`)
  }
  const autoDeny = translateDeny(deny)
  const GATED_TOOLS = PI_ACP_GATED_TOOLS
  const gated = GATED_TOOLS.filter((tool) => !autoDeny.includes(tool))
  const bridge = fileURLToPath(new URL('../pi/acp-bridge.mjs', import.meta.url))
  const seat = piRpcSeatParts(spec)
  const seatArgs = seat.args
  return {
    bin: process.execPath,
    args: [bridge, ...seatArgs],
    env: { ...seat.env, CREW_PI_BIN: bin, CREW_ACP_GATED_TOOLS: gated.join(',') },
    sessionParams: { cwd, mcpServers: [] },
    policy: { autoDeny, autoApprove: role === 'builder' ? gated : [], escalate: role === 'builder' ? [] : gated },
  }
}

const NO_GRANTS = Object.freeze({ tools: [], extensions: [], agents: [], skills: [], advisor: false })
