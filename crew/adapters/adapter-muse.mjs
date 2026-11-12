import { cpSync, lstatSync, mkdirSync, statSync, symlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXTRAS = fileURLToPath(new URL('../mcp/crew-extras.mjs', import.meta.url))
const builtServers = new WeakSet()

export function assertSupportedGrants(grants = {}) {
  if ((grants?.extensions?.length ?? 0) > 0) {
    throw Object.assign(new Error('adapter-muse cannot express grant extensions — refusing to boot a silently weaker seat [grant-unsupported]'), { reason: 'grant-unsupported' })
  }
  const servers = grants?.mcp_servers || []
  for (const server of servers) {
    if ((server?.name !== 'fff' && !builtServers.has(server)) || servers.filter((entry) => entry?.name === server?.name).length !== 1 || (server.type != null && server.type !== 'stdio') || !server.command || server.url != null || typeof server.command.bin !== 'string' || !Array.isArray(server.command.args)) {
      throw Object.assign(new Error('adapter-muse cannot express MCP server grant [grant-unsupported]'), { reason: 'grant-unsupported' })
    }
  }
}

export function writeSeatSkills({ taskDir, grants = {} } = {}) {
  const skills = grants.skills || []
  if (!skills.length) return
  const seen = new Set()
  const entries = skills.map((source) => {
    const base = basename(String(source))
    const name = base === 'SKILL.md' ? basename(dirname(String(source))) : base.endsWith('.md') ? base.slice(0, -3) : base
    let file = false
    try { file = statSync(source).isFile() } catch { /* refused below */ }
    if (!file || !name || name === '.' || name === '..' || seen.has(name.toLowerCase())) {
      throw Object.assign(new Error(`adapter-muse cannot materialise granted skill ${JSON.stringify(source)} [grant-unsupported]`), { reason: 'grant-unsupported' })
    }
    seen.add(name.toLowerCase())
    return { source, base, name }
  })
  try {
    const root = join(taskDir, 'muse-skills')
    // The runtime is fresh; refusing an existing root also refuses a symlink escape.
    mkdirSync(root)
    for (const { source, base, name } of entries) {
      const dest = join(root, name)
      mkdirSync(dest)
      if (base === 'SKILL.md') cpSync(dirname(source), dest, { recursive: true })
      else cpSync(source, join(dest, 'SKILL.md'))
    }
  } catch (error) {
    throw Object.assign(new Error(`adapter-muse cannot materialise skills: ${error.message} [grant-unsupported]`), { reason: 'grant-unsupported' })
  }
}

export function acpLaunch(spec = {}) {
  const { bin, cwd, model, effort, writes, writableDirs, taskDir, piBinary, grants = {}, env = {} } = spec
  assertSupportedGrants(grants)
  if (typeof bin !== 'string' || !isAbsolute(bin)) throw new Error(`adapter-muse.acpLaunch: bin must be an ABSOLUTE path, got ${JSON.stringify(bin)}`)
  if (typeof taskDir !== 'string' || !isAbsolute(taskDir)) throw Object.assign(new Error('adapter-muse requires an absolute taskDir [grant-unsupported]'), { reason: 'grant-unsupported' })
  const home = join(taskDir, 'muse-home')
  const config = join(home, 'config')
  const data = join(home, 'data')
  const claude = join(home, 'claude')
  const codex = join(home, 'codex')
  try {
    // The seat runtime is fresh; refusing an existing root prevents symlink escapes.
    mkdirSync(home, { mode: 0o700 })
    for (const dir of [config, data, claude, codex, join(config, 'muse')]) mkdirSync(dir, { mode: 0o700 })
    const inherited = { ...process.env, ...env }
    const sourceConfig = inherited.XDG_CONFIG_HOME || (inherited.HOME && join(inherited.HOME, '.config'))
    if (sourceConfig) {
      const auth = resolve(sourceConfig, 'muse', 'auth.json')
      let present = true
      try { lstatSync(auth) } catch (error) { if (error.code === 'ENOENT') present = false; else throw error }
      if (present) symlinkSync(auth, join(config, 'muse', 'auth.json'))
    }
  } catch (error) {
    throw Object.assign(new Error(`adapter-muse cannot prepare isolated home: ${error.message} [grant-unsupported]`), { reason: 'grant-unsupported' })
  }
  const servers = [...(grants.mcp_servers || [])]
  const extras = [...(grants.skeletonread ? ['retrieve', 'skeleton'] : []), ...(grants.subagent ? ['agent'] : [])]
  if (extras.length) {
    const server = { name: 'crew-extras', command: { bin: process.execPath, args: [EXTRAS] }, url: null, env: {
      CREW_TASK_DIR: env.CREW_TASK_DIR || '', CREW_ROLE: env.CREW_ROLE || '',
      CREW_EXTRAS: JSON.stringify(extras), CREW_PI_AGENTS: JSON.stringify(grants.agents || []), CREW_PI_BINARY: piBinary || '',
    } }
    builtServers.add(server)
    servers.push(server)
  }
  assertSupportedGrants({ ...grants, mcp_servers: servers })
  const directories = [...(writes !== 'none' && Array.isArray(writableDirs) ? writableDirs : []), ...((grants.skills?.length ?? 0) ? [join(taskDir, 'muse-skills')] : [])]
  // Muse write_file bypasses permission requests. The task dir is a session root; lean.mjs checks lean records after the turn.
  return {
    bin,
    args: ['acp', '--model', model, '-c', 'model_reasoning_efforts=' + JSON.stringify({ [model]: effort }), '-c', 'tools.web_search.mode="off"', '-c', 'tools.web_fetch.enabled=false', ...(writes === 'none' ? ['--disable-write'] : [])],
    // HOME stays the operator's: Muse finds the account login through it, and a seat with another HOME is logged out.
    env: { ...env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, MUSE_EXPERIMENTAL_ACP: '1', MUSE_ENABLE_WEB_TOOLS: '0', MUSE_WEB_SEARCH_MODE: 'off', MUSE_EXPERIMENTAL_FOREIGN_PERSONAL_CONTEXT_KILL: '1', CREW_FFF: servers.some((server) => server.name === 'fff') ? '1' : '0' },
    mode: 'onRequest',
    sessionParams: { cwd, mcpServers: servers.map((server) => ({ name: server.name, command: server.command.bin, args: [...server.command.args], env: Object.entries(builtServers.has(server) ? server.env : {}).map(([name, value]) => ({ name, value })) })), ...(directories.length ? { additionalDirectories: directories } : {}) },
  }
}
