import { readFileSync as fsReadFileSync, realpathSync, existsSync, cpSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, basename, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
let sharedFffSearchProgram

export const CLAUDE_SEAT_SETTINGS = fileURLToPath(new URL('./claude-usage.settings.json', import.meta.url))

const NO_GRANTS = Object.freeze({ tools: [], extensions: [], agents: [], skills: [], advisor: false, mcp_servers: [] })
const FFF_MCP_NAME = 'fff'
export const FFF_HOOK_PATH = fileURLToPath(import.meta.url)

export function hasFffGrant(grants = NO_GRANTS) {
  return Array.isArray(grants?.mcp_servers) && grants.mcp_servers.some((server) => (
    server?.name === FFF_MCP_NAME
  ))
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

function assertSupportedGrants(grants = NO_GRANTS) {
  if ((grants?.extensions?.length ?? 0) > 0 || grants?.advisor === true) {
    throw Object.assign(
      new Error(`adapter-claude cannot express grants ${JSON.stringify({ extensions: grants.extensions, advisor: grants.advisor })} — refusing to boot a silently weaker seat [grant-unsupported]`),
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

export function acpLaunch(spec = {}) {
  const { bin, claudeBin, cwd, model, tools, deny, effort, promptFile, role, taskDir, grants = NO_GRANTS, env = {} } = spec
  assertSupportedGrants(grants)
  assertSkillsMaterialised({ role, taskDir, grants })
  if (typeof bin !== 'string' || !bin || !isAbsolute(bin)) {
    throw new Error(`adapter-claude.acpLaunch: bin must be a nonempty ABSOLUTE ACP path, got ${JSON.stringify(bin)}`)
  }
  if (!claudeBin || !isAbsolute(claudeBin)) {
    throw new Error(`adapter-claude.acpLaunch: claudeBin must be an ABSOLUTE frozen worker path, got ${JSON.stringify(claudeBin)}`)
  }
  const hasSkills = (grants?.skills?.length ?? 0) > 0
  const hasMcpServers = (grants?.mcp_servers?.length ?? 0) > 0
  const mcpServers = {}
  for (const server of grants?.mcp_servers || []) {
    if (server.command !== null) {
      mcpServers[server.name] = { command: server.command.bin, args: [...server.command.args] }
    } else {
      mcpServers[server.name] = { type: 'http', url: server.url }
    }
  }
  const acpAllowedTools = [...new Set([
    ...allowedTools(tools, grants).split(',').filter(Boolean),
    ...(hasFffGrant(grants) ? ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep'] : []),
  ])]
  const acpTools = hasSkills ? [...acpAllowedTools.filter((tool) => tool !== 'Skill'), 'Skill'] : acpAllowedTools
  const plugins = [
    ...(hasSkills ? [{ type: 'local', path: skillsPluginDir({ taskDir, role }) }] : []),
  ]
  return {
    bin,
    args: [],
    env: { ...env, CLAUDE_CODE_EXECUTABLE: claudeBin, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...fffEnvironment(grants) },
    mode: 'acceptEdits',
    sessionParams: {
      cwd,
      mcpServers: [],
      _meta: { claudeCode: { options: {
        model,
        settingSources: ['project'], settings: CLAUDE_SEAT_SETTINGS,
        ...(hasMcpServers ? { mcpServers } : {}),
        strictMcpConfig: true,
        allowedTools: acpTools,
        tools: acpTools,
        ...(plugins.length > 0 ? { plugins } : {}),
        disallowedTools: deniedTools(deny, grants).split(',').filter(Boolean),
        additionalDirectories: spec.writableDirs,
        extraArgs: { ...(effort ? { effort } : {}), 'append-system-prompt-file': promptFile },
      } } },
    },
  }
}
