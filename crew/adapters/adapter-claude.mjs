import { readFileSync as fsReadFileSync, realpathSync, existsSync, cpSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, basename, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ROUTER_ATTEMPT_URL_ENV, routerAttemptUrl } from './adapter-pi.mjs'

const require = createRequire(import.meta.url)
let sharedFffSearchProgram

export const PANE_USAGE_SETTINGS = fileURLToPath(new URL('./claude-usage.settings.json', import.meta.url))

// crew/adapters/adapter-claude.mjs — the claude agent adapter.
//
// An adapter is the seam between a crew seat and the CLI agent that fills it:
// `capabilitiesFor(...)` resolves one frozen profile per (adapter, transport)
// pair, and `seatCommand(...)` composes the pane's command line. crew.mjs resolves the
// adapter by seat.agent (default 'claude', overridable via --agent-<role>)
// and never builds the invocation itself — that composition lives here.
//
// seatCommand's output is no longer byte-identical to the pre-refactor
// paneCommand() in crew.mjs: the per-seat usage settings path is required for
// pane usage measurement (#492). Any change to the string below is a behavior
// change, not a refactor.
const INVARIANT = Object.freeze({
  prompt_file: true, tool_deny: true, unattended: true,
  // The Task tool is available in every claude transport; the seats that need
  // fan-out discovery carry it in their allowlist (crew.mjs SEAT_DEFAULTS).
  subagents: true,
  // claude --effort <low|medium|high|xhigh|max> (verified against the
  // installed CLI 2026-08-13) — the roster's effort dimension is enforceable.
  effort: true,
  // The claude CLI takes a full model id and has no checkout-pinned
  // provider-config seam, so a local-provider cell cannot be honoured here.
  local_provider: false,
  mcp_servers: true,
})

const PROFILES = Object.freeze({
  pane: Object.freeze({
    // ADR-029 §3:52 — pane stdin is not a supported mid-turn channel.
    interjection: 'none',
    // ADR-029 §3:54 — pane owns no process handle for an abort.
    abort: 'none',
    // ADR-029 §3:54 — pane command passes no --session-id.
    session_resume: false,
    // ADR-029 §3:54 — pane has no client-resumable observation cursor.
    durable_cursor: 'none',
    // #131 — drive.mjs bounce paths reassign a settled pane seat.
    reassign: true,
  }),
  'headless-json': Object.freeze({
    // ADR-029 §3:52 — text stdin is read to EOF before the turn.
    interjection: 'turn',
    // ADR-029 §3:53 — supervisor signal is the supported abort mechanism.
    abort: 'signal',
    // ADR-029 §3:54 — the headless session persists for a later invocation.
    session_resume: true,
    // ADR-029 §3:54 — claude's session file is not a durable cursor.
    durable_cursor: 'none',
    // #131 — no capture establishes reassign for headless-json.
    reassign: false,
  }),
})

const NO_GRANTS = Object.freeze({ tools: [], extensions: [], agents: [], skills: [], advisor: false, mcp_servers: [] })
const FFF_MCP_NAME = 'fff'
const FFF_MCP_BIN = '/opt/homebrew/bin/fff-mcp'
const FFF_HOOK_COMMAND = 'if [ "$CREW_FFF" != "1" ]; then exit 0; fi; exec "$CREW_FFF_NODE" "$CREW_FFF_HOOK"'
export const FFF_HOOK_PATH = fileURLToPath(import.meta.url)

export function hasFffGrant(grants = NO_GRANTS) {
  return Array.isArray(grants?.mcp_servers) && grants.mcp_servers.some((server) => (
    server?.name === FFF_MCP_NAME && server?.command?.bin === FFF_MCP_BIN
  ))
}

export function hasFffPreToolUseHook(settings) {
  try {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
    const entries = settings.hooks?.PreToolUse
    if (!Array.isArray(entries)) return false
    return entries.some((entry) => (
      entry?.matcher === 'Bash'
      && Array.isArray(entry.hooks)
      && entry.hooks.some((hook) => hook?.type === 'command' && hook.command === FFF_HOOK_COMMAND)
    ))
  } catch {
    return false
  }
}

function loadFffSettings({ settings, settingsDocument, readSettings, settingsReader } = {}) {
  try {
    let source
    if (settings !== undefined) source = settings
    else if (settingsDocument !== undefined) source = settingsDocument
    else if (typeof readSettings === 'function') source = readSettings(PANE_USAGE_SETTINGS)
    else if (typeof settingsReader === 'function') source = settingsReader(PANE_USAGE_SETTINGS)
    else source = fsReadFileSync(PANE_USAGE_SETTINGS, 'utf8')
    if (Buffer.isBuffer(source)) source = source.toString('utf8')
    if (typeof source === 'string') {
      if (!source.trim()) return undefined
      return JSON.parse(source)
    }
    return source
  } catch {
    return undefined
  }
}

function fffEnvironment(grants = NO_GRANTS) {
  return {
    CREW_FFF: hasFffGrant(grants) ? '1' : '0',
    CREW_FFF_NODE: hasFffGrant(grants) ? process.execPath : '',
    CREW_FFF_HOOK: hasFffGrant(grants) ? FFF_HOOK_PATH : '',
  }
}

function hookDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

function fffSearchProgramForClaude(command) {
  if (!sharedFffSearchProgram) {
    const readgate = require('../pi/extensions/readgate.ts')
    if (typeof readgate?.fffSearchProgram !== 'function') throw new Error('fff search classifier is unavailable')
    sharedFffSearchProgram = readgate.fffSearchProgram
  }
  return sharedFffSearchProgram(command)
}

function hookInput(payload) {
  if (Buffer.isBuffer(payload)) return payload.toString('utf8')
  return payload
}

export function fffHookDecision(payload, options = {}) {
  const input = typeof options === 'boolean' ? { granted: options } : (options && typeof options === 'object' ? options : {})
  let granted = input.granted
  if (granted === undefined) {
    try { granted = (input.env ?? process.env)?.CREW_FFF === '1' } catch { granted = false }
  }
  if (granted !== true) return undefined

  let value = hookInput(payload)
  if (typeof value === 'string') {
    if (!value.trim()) return hookDeny('Refusing Bash: unable to verify the command for fff search enforcement.')
    try { value = JSON.parse(value) } catch { return hookDeny('Refusing Bash: unable to verify the command for fff search enforcement.') }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return hookDeny('Refusing Bash: unable to verify the command for fff search enforcement.')
  }

  const hasToolName = Object.hasOwn(value, 'tool_name') || Object.hasOwn(value, 'toolName')
  const toolName = value.tool_name ?? value.toolName
  if (!hasToolName) return hookDeny('Refusing Bash: unable to verify the command for fff search enforcement.')
  if (toolName !== 'Bash') return undefined

  const toolInput = value.tool_input ?? value.toolInput ?? value.input
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput) || typeof toolInput.command !== 'string' || toolInput.command.trim() === '') {
    return hookDeny('Refusing Bash: unable to verify the command for fff search enforcement.')
  }
  let program
  try { program = fffSearchProgramForClaude(toolInput.command) } catch {
    return hookDeny('Refusing Bash: unable to verify the command for fff search enforcement.')
  }
  if (program === undefined) return undefined
  const replacement = program === 'grep' || program === 'rg' ? 'mcp__fff__grep' : 'mcp__fff__find_files'
  return hookDeny(`Refusing ${program}: use ${replacement} instead.`)
}

function invokedDirectly() {
  try {
    if (!process.argv[1]) return false
    return realpathSync(process.argv[1]) === realpathSync(FFF_HOOK_PATH)
  } catch {
    return process.argv[1] === FFF_HOOK_PATH
  }
}

function runHook() {
  let raw
  try { raw = fsReadFileSync(0, 'utf8') } catch { raw = undefined }
  let payload = raw
  if (typeof raw === 'string') {
    try { payload = raw.trim() ? JSON.parse(raw) : undefined } catch { payload = undefined }
  }
  const decision = fffHookDecision(payload)
  if (decision !== undefined) process.stdout.write(`${JSON.stringify(decision)}\n`)
}

if (invokedDirectly()) runHook()

export function capabilitiesFor({ transport, grants = NO_GRANTS, settings: injectedSettings, settingsDocument, readSettings, settingsReader } = {}) {
  const p = PROFILES[transport]
  if (!p) throw new Error(`adapter-claude: no capability profile for transport "${transport}" (shipped: ${Object.keys(PROFILES).join(', ')}) — refusing a guessed passthrough`)
  const settings = hasFffGrant(grants)
    ? loadFffSettings({ settings: injectedSettings, settingsDocument, readSettings, settingsReader })
    : undefined
  if (hasFffGrant(grants) && !hasFffPreToolUseHook(settings)) {
    throw Object.assign(
      new Error(`adapter-claude cannot enforce the fff Bash hook from ${PANE_USAGE_SETTINGS} — refusing to boot a silently weaker seat [grant-unsupported]`),
      { reason: 'grant-unsupported' },
    )
  }
  return Object.freeze({ ...INVARIANT, ...p })
}

const STRICT_MCP_ARGS = Object.freeze(['--strict-mcp-config'])

export function mcpConfigPath({ taskDir, role } = {}) {
  if (typeof taskDir !== 'string' || !isAbsolute(taskDir)) {
    throw new Error(`adapter-claude.mcpConfigPath: taskDir must be an ABSOLUTE path, got ${JSON.stringify(taskDir)}`)
  }
  if (typeof role !== 'string' || role.trim() === '') {
    throw new Error(`adapter-claude.mcpConfigPath: role must be non-blank, got ${JSON.stringify(role)}`)
  }
  return join(taskDir, 'mcp', `${role}.json`)
}

function allowedTools(tools, grants = NO_GRANTS) {
  return [...new Set([...String(tools || '').split(','), ...(grants?.tools || [])].filter(Boolean))].join(',')
}

function deniedTools(deny, grants = NO_GRANTS) {
  const names = []
  const seen = new Set()
  for (const raw of String(deny || '').split(',')) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  if ((grants?.mcp_servers?.length ?? 0) === 0) names.push('mcp__*')
  return [...new Set(names)].join(',')
}

const PLUGIN_DIR_FLAG = '--plugin-dir'

function assertSupportedGrants(grants = NO_GRANTS) {
  if ((grants?.extensions?.length ?? 0) > 0) {
    throw Object.assign(
      new Error(`adapter-claude cannot express extension grants ${JSON.stringify({ extensions: grants.extensions })} — refusing to boot a silently weaker seat [grant-unsupported]`),
      { reason: 'grant-unsupported' },
    )
  }
}

export function skillsPluginDir({ taskDir, role } = {}) {
  if (typeof taskDir !== 'string' || !isAbsolute(taskDir)) {
    throw new Error(`adapter-claude.skillsPluginDir: taskDir must be an ABSOLUTE path, got ${JSON.stringify(taskDir)}`)
  }
  if (typeof role !== 'string' || role.trim() === '') {
    throw new Error(`adapter-claude.skillsPluginDir: role must be non-blank, got ${JSON.stringify(role)}`)
  }
  return join(taskDir, 'claude-skills', role)
}

export function skillDirName(source) {
  const base = basename(String(source))
  if (base === 'SKILL.md') return basename(dirname(String(source)))
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

export function seatSkillFiles({ taskDir, role, grants } = {}) {
  return (grants?.skills || []).map((source) => join(skillsPluginDir({ taskDir, role }), 'skills', skillDirName(source), 'SKILL.md'))
}

// Sol on #1426 reproduced three ways a materialisation can go wrong, all of them silent:
// a symlinked plugin parent wrote OUTSIDE the task dir (and deleted what was there), a
// granted path that is a DIRECTORY named SKILL.md passed every existence check and booted
// a seat whose skill the CLI would not load, and on a case-insensitive filesystem
// `Foo/SKILL.md` and `foo/SKILL.md` collapsed to one destination so the second silently
// replaced the first. Each is refused by name before anything is written.
const REAL = (path, deps) => {
  try { return (deps.realpathSync ?? realpathSync)(path) } catch { return null }
}

// The plugin root, and every parent of it that exists, must live inside the task dir: a
// symlink anywhere on that chain is an escape, and this function WRITES and REMOVES.
function assertInsideTaskDir(root, taskDir, deps) {
  const realTask = REAL(taskDir, deps) ?? taskDir
  let probe = root
  for (;;) {
    const real = REAL(probe, deps)
    if (real !== null) {
      const contained = real === realTask || real.startsWith(`${realTask}/`)
      if (!contained) {
        throw Object.assign(
          new Error(`adapter-claude refuses to materialise skills at ${JSON.stringify(root)}: ${JSON.stringify(probe)} resolves to ${JSON.stringify(real)}, outside the task dir ${JSON.stringify(realTask)} — refusing to write outside the seat [grant-unsupported]`),
          { reason: 'grant-unsupported' },
        )
      }
      return
    }
    const parent = dirname(probe)
    if (parent === probe) return
    probe = parent
  }
}

export function writeSeatSkills({ taskDir, role, grants } = {}, deps = {}) {
  const skills = grants?.skills || []
  if (skills.length === 0) return
  const cp = deps.cpSync ?? cpSync
  const mkdir = deps.mkdirSync ?? mkdirSync
  const write = deps.writeFileSync ?? writeFileSync
  const rm = deps.rmSync ?? rmSync
  const stat = deps.statSync ?? statSync
  const seen = new Map()
  for (const source of skills) {
    const name = skillDirName(source)
    // A granted source must be a readable FILE. A directory named SKILL.md satisfies
    // existsSync and produces a plugin the CLI does not load.
    let sourceStat
    try { sourceStat = stat(String(source)) } catch (error) {
      throw Object.assign(
        new Error(`adapter-claude cannot read granted skill ${JSON.stringify(String(source))} (${error?.message ?? error}) — refusing to boot a silently weaker seat [grant-unsupported]`),
        { reason: 'grant-unsupported' },
      )
    }
    if (!sourceStat.isFile()) {
      throw Object.assign(
        new Error(`adapter-claude granted skill ${JSON.stringify(String(source))} is not a file — refusing to boot a seat whose skill the CLI will not load [grant-unsupported]`),
        { reason: 'grant-unsupported' },
      )
    }
    // Case-insensitive, because APFS and NTFS are: two names differing only in case
    // become ONE destination, and the second copy replaces the first without a word.
    const key = name.toLowerCase()
    if (seen.has(key)) {
      throw Object.assign(
        new Error(`adapter-claude cannot materialise duplicate skill name ${JSON.stringify(name)}: it collides with ${JSON.stringify(seen.get(key))}, which differs only in case on a case-insensitive filesystem — refusing to boot an ambiguous seat [grant-unsupported]`),
        { reason: 'grant-unsupported' },
      )
    }
    seen.set(key, name)
  }
  const root = skillsPluginDir({ taskDir, role })
  assertInsideTaskDir(root, taskDir, deps)
  rm(root, { recursive: true, force: true })
  mkdir(root, { recursive: true })
  for (const source of skills) {
    const name = skillDirName(source)
    const destDir = join(root, 'skills', name)
    mkdir(destDir, { recursive: true })
    if (basename(String(source)) === 'SKILL.md') cp(dirname(String(source)), destDir, { recursive: true })
    else cp(String(source), join(destDir, 'SKILL.md'))
  }
  mkdir(join(root, '.claude-plugin'), { recursive: true })
  write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: `crew-skills-${role}`,
    version: '0.0.0',
    description: `Crew skills for the ${role} seat`,
    author: { name: 'crew' },
  }, null, 2))
}

export function assertSkillsMaterialised({ taskDir, role, grants } = {}) {
  const skills = grants?.skills || []
  if (skills.length === 0) return
  for (const skillFile of seatSkillFiles({ taskDir, role, grants })) {
    if (!existsSync(skillFile)) {
      throw Object.assign(
        new Error(`adapter-claude skills not materialised at ${JSON.stringify(skillFile)} — refusing to boot a silently weaker seat [grant-unsupported]`),
        { reason: 'grant-unsupported' },
      )
    }
  }
}

function assertNoLocalProvider(configDir) {
  if (configDir !== null && configDir !== undefined) {
    throw Object.assign(
      new Error(`adapter-claude cannot express local-provider configDir ${JSON.stringify(configDir)} — refusing to boot a silently weaker seat [grant-unsupported]`),
      { reason: 'grant-unsupported' },
    )
  }
}

// The claude CLI accepts full model ids, so the roster's {provider,id} pair
// needs no namespace prefix — the id IS the CLI's namespace.
export function modelString({ provider, id, localProviders }) {
  if (localProviders && typeof localProviders === 'object' && Object.hasOwn(localProviders, provider)) {
    throw Object.assign(
      new Error(`adapter-claude cannot express local provider ${JSON.stringify(provider)} — refusing to boot a silently weaker seat [grant-unsupported]`),
      { reason: 'grant-unsupported' },
    )
  }
  return id
}

// The headless-json invocation shape. Returns ARGV (never a shell string):
// crew never assembles agent flags, and argv sidesteps quoting entirely.
// --verbose accompanies --output-format stream-json in every HW-1 capture.
// resume=false CREATES the session (--session-id); resume=true CONTINUES it
// (--resume).
export function headlessCommand({ role, model, promptFile, tools, deny, taskDir,
                                  prompt, sessionId, resume = false, bin, effort, grants = NO_GRANTS, configDir = null, env = process.env }) {
  assertSupportedGrants(grants)
  assertSkillsMaterialised({ taskDir, role, grants })
  assertNoLocalProvider(configDir)
  const headlessRouterUrl = routerAttemptUrl(env)
  if (!bin || !bin.startsWith('/')) throw new Error(`adapter-claude.headlessCommand: bin must be an ABSOLUTE frozen worker binary path, got ${JSON.stringify(bin)} — refusing to inherit whatever PATH resolves`)
  if (!sessionId) throw new Error('adapter-claude.headlessCommand: sessionId is required (one session per seat)')
  return {
    bin,
    args: [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--permission-mode', 'bypassPermissions',
      ...STRICT_MCP_ARGS,
      '--mcp-config', mcpConfigPath({ taskDir, role }),
      '--settings', PANE_USAGE_SETTINGS,
      ...((grants?.skills?.length ?? 0) > 0 ? [PLUGIN_DIR_FLAG, skillsPluginDir({ taskDir, role })] : []),
      ...(effort ? ['--effort', effort] : []),
      '--allowedTools', allowedTools(tools, grants),
      '--disallowedTools', deniedTools(deny, grants),
      '--append-system-prompt-file', promptFile,
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ],
    env: { DEVTEAM_WORKER: '1', CREW_ROLE: role, CREW_TASK_DIR: taskDir, ...(headlessRouterUrl ? { ANTHROPIC_BASE_URL: headlessRouterUrl } : {}), ...fffEnvironment(grants) },
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `\'"\'"\'`)}'`
}

export function seatCommand({ role, model, promptFile, tools, deny, taskDir, bootBrief, effort, grants = NO_GRANTS, configDir = null, env = process.env }) {
  assertSupportedGrants(grants)
  assertSkillsMaterialised({ taskDir, role, grants })
  assertNoLocalProvider(configDir)
  const routerUrl = routerAttemptUrl(env)
  const fff = fffEnvironment(grants)
  // `env` (a real binary) sets the vars regardless of how cmux runs the
  // command. DEVTEAM_WORKER=1 keeps any installed dev-team plugin hooks
  // quiet inside the pane (defensive; a no-op when the plugin is absent).
  // bypassPermissions: crew seats run unattended (no human at their pane to
  // approve). The ENFORCED tool boundary is --disallowedTools (it holds even
  // under bypass; --allowedTools is only an auto-approve list and is inert
  // here) — beyond that, containment is the git scope gate, the feature-
  // branch blast radius, and the operator's global deny rules.
  // effort is OPTIONAL: absent, the command stays byte-identical to the
  // effort-less fff-aware adapter (the compatibility pin in crew.test.mjs holds).
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR="${taskDir}"`,
    ...(routerUrl ? [`ANTHROPIC_BASE_URL=${shellSingleQuote(routerUrl)}`] : []),
    `CREW_FFF=${fff.CREW_FFF}`, `CREW_FFF_NODE="${fff.CREW_FFF_NODE}"`, `CREW_FFF_HOOK="${fff.CREW_FFF_HOOK}"`,
    'claude', '--model', model, '--permission-mode', 'bypassPermissions',
    ...STRICT_MCP_ARGS,
    '--mcp-config', `"${mcpConfigPath({ taskDir, role })}"`,
    '--settings', `"${PANE_USAGE_SETTINGS}"`,
    ...((grants?.skills?.length ?? 0) > 0 ? [PLUGIN_DIR_FLAG, `"${skillsPluginDir({ taskDir, role })}"`] : []),
    ...(effort ? ['--effort', `"${effort}"`] : []),
    '--allowedTools', `"${allowedTools(tools, grants)}"`,
    '--disallowedTools', `"${deniedTools(deny, grants)}"`,
    '--append-system-prompt-file', `"${promptFile}"`,
    `"${bootBrief}"`,
  ].join(' ')
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function paneUsageRecords({ taskDir, role, deps = {} } = {}) {
  if (typeof taskDir !== 'string' || typeof role !== 'string') return []
  let raw
  try {
    const readFileSync = deps.readFileSync ?? fsReadFileSync
    raw = readFileSync(join(taskDir, 'usage', `${role}.jsonl`), 'utf8')
  } catch {
    return []
  }
  let lines
  try { lines = String(raw).split(/\r?\n/) } catch { return [] }
  const records = []
  const seen = new Set()
  for (const line of lines) {
    if (!line.trim()) continue
    let payload
    try { payload = JSON.parse(line) } catch { continue }
    const sessionId = payload && typeof payload === 'object' ? payload.session_id : null
    const transcriptPath = payload && typeof payload === 'object' ? payload.transcript_path : null
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) continue
    if (typeof transcriptPath !== 'string' || !transcriptPath.startsWith('/') || !transcriptPath.endsWith('.jsonl')) continue
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    records.push({ session_id: sessionId, transcript_path: transcriptPath })
  }
  return records
}
