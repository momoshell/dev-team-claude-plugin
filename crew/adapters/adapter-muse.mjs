import { cpSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

export function assertSupportedGrants(grants = {}) {
  for (const grant of ['extensions', 'advisor']) {
    if (grant === 'advisor' ? grants?.advisor === true : (grants?.[grant]?.length ?? 0) > 0) {
      throw Object.assign(new Error(`adapter-muse cannot express grant ${grant} — refusing to boot a silently weaker seat [grant-unsupported]`), { reason: 'grant-unsupported' })
    }
  }
  const servers = grants?.mcp_servers || []
  for (const server of servers) {
    if (servers.length !== 1 || server?.name !== 'fff' || (server.type != null && server.type !== 'stdio') || !server.command || server.url != null || typeof server.command.bin !== 'string' || !Array.isArray(server.command.args)) {
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
  const { bin, cwd, model, effort, writes, writableDirs, taskDir, grants = {}, env = {} } = spec
  assertSupportedGrants(grants)
  if (typeof bin !== 'string' || !isAbsolute(bin)) throw new Error(`adapter-muse.acpLaunch: bin must be an ABSOLUTE path, got ${JSON.stringify(bin)}`)
  const servers = grants.mcp_servers || []
  const directories = [...(writes !== 'none' && Array.isArray(writableDirs) ? writableDirs : []), ...((grants.skills?.length ?? 0) ? [join(taskDir, 'muse-skills')] : [])]
  // Muse write_file bypasses permission requests. The task dir is a session root; lean.mjs checks lean records after the turn.
  return {
    bin,
    args: ['acp', '--model', model, '-c', 'model_reasoning_efforts=' + JSON.stringify({ [model]: effort }), ...(writes === 'none' ? ['--disable-write'] : [])],
    env: { ...env, MUSE_EXPERIMENTAL_ACP: '1', CREW_FFF: servers.length ? '1' : '0' },
    mode: 'onRequest',
    sessionParams: { cwd, mcpServers: servers.map((server) => ({ name: server.name, command: server.command.bin, args: [...server.command.args], env: [] })), ...(directories.length ? { additionalDirectories: directories } : {}) },
  }
}
