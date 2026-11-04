import { isAbsolute } from 'node:path'

export function acpLaunch(spec = {}) {
  const { bin, cwd, model, effort, writes, writableDirs, grants = {}, env = {} } = spec
  for (const grant of ['skills', 'extensions', 'mcp_servers', 'advisor']) {
    if (grant === 'advisor' ? grants?.advisor === true : (grants?.[grant]?.length ?? 0) > 0) {
      throw Object.assign(new Error(`adapter-muse cannot express grant ${grant} — refusing to boot a silently weaker seat [grant-unsupported]`), { reason: 'grant-unsupported' })
    }
  }
  if (typeof bin !== 'string' || !isAbsolute(bin)) throw new Error(`adapter-muse.acpLaunch: bin must be an ABSOLUTE path, got ${JSON.stringify(bin)}`)
  // Muse write_file bypasses permission requests. The task dir is a session root; lean.mjs checks lean records after the turn.
  return {
    bin,
    args: ['acp', '--model', model, '-c', 'model_reasoning_efforts=' + JSON.stringify({ [model]: effort }), ...(writes === 'none' ? ['--disable-write'] : [])],
    env: { ...env, MUSE_EXPERIMENTAL_ACP: '1' },
    mode: 'onRequest',
    sessionParams: { cwd, mcpServers: [], ...(writes !== 'none' && Array.isArray(writableDirs) && writableDirs.length ? { additionalDirectories: writableDirs } : {}) },
  }
}
