import {
  accessSync, appendFileSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACP_UPDATE_KINDS, acpClient } from '../acp-client.mjs'
import * as claudeAdapter from '../adapters/adapter-claude.mjs'
import * as piAdapter from '../adapters/adapter-pi.mjs'

const ROLE = 'seat'
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/
const SKILLS_ROOT = fileURLToPath(new URL('../../skills', import.meta.url))

function resolveBinary(label, explicit, name, env) {
  const executable = (path) => { try { accessSync(path, fsConstants.X_OK); return statSync(path).isFile() } catch { return false } }
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !isAbsolute(explicit)) throw new Error(`${label} binary must be an absolute path, got ${JSON.stringify(explicit)}`)
    if (!executable(explicit)) throw new Error(`${label} binary ${JSON.stringify(explicit)} is not an executable file`)
    return explicit
  }
  for (const dir of String(env?.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, name)
    if (executable(candidate)) return candidate
  }
  throw new Error(`${label} binary "${name}" was not found on an absolute PATH directory`)
}

// A bare identifier names a checkout skill; a string with a slash or .md suffix is a path.
function resolveSkill(skill, cwd) {
  if (typeof skill !== 'string' || skill === '') throw new Error(`skill must be a nonempty string, got ${JSON.stringify(skill)}`)
  if (skill.includes('/') || skill.endsWith('.md')) return resolve(cwd, skill)
  const file = resolve(SKILLS_ROOT, skill, 'SKILL.md')
  if (!file.startsWith(`${SKILLS_ROOT}${sep}`)) throw new Error(`skill ${JSON.stringify(skill)} escapes the skills root`)
  return file
}

const nonempty = (value) => typeof value === 'string' && value !== ''

export function runAcpSeat({ definition, cwd, prompt, sessionFile, binaries = {}, deps = {} }) {
  if (!definition || typeof definition !== 'object') throw new Error('definition must be an object')
  if (!['claude', 'pi'].includes(definition.agent)) throw new Error(`unsupported agent: ${definition.agent}`)
  if (!nonempty(cwd)) throw new Error('cwd must be a nonempty string')
  if (!nonempty(sessionFile)) throw new Error('sessionFile must be a nonempty string')
  if (typeof prompt !== 'string') throw new Error('prompt must be a string')
  if (typeof definition.model !== 'string' || !MODEL.test(definition.model)) throw new Error(`model must be provider/id, got ${JSON.stringify(definition.model)}`)
  if (!EFFORTS.includes(definition.effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(definition.effort)}`)
  const skills = definition.skills ?? []
  if (!Array.isArray(skills)) throw new Error('skills must be a list of skill names or paths')
  const workdir = resolve(cwd)
  const recordTo = resolve(sessionFile)
  const model = definition.model.slice(definition.model.indexOf('/') + 1)
  const piModel = definition.model
  const env = deps.env ?? process.env
  const isClaude = definition.agent === 'claude'
  const claudeAcp = isClaude ? resolveBinary('claude ACP', binaries.claudeAcp, 'claude-agent-acp', env) : null
  const claude = isClaude ? resolveBinary('claude', binaries.claude, 'claude', env) : null
  const pi = isClaude ? null : resolveBinary('pi', binaries.pi, 'pi', env)
  const grantedSkills = skills.map((skill) => resolveSkill(skill, workdir))
  const grants = { tools: [], extensions: [], agents: [], skills: grantedSkills, advisor: false, mcp_servers: [] }

  const append = deps.appendFileSync ?? appendFileSync
  function recordUpdate(payload) {
    try {
      append(recordTo, `${JSON.stringify({ sessionId: payload.sessionId, update: payload.update })}\n`, 'utf8')
    } catch { /* session recording never changes the turn */ }
  }
  try { mkdirSync(dirname(recordTo), { recursive: true }) } catch { /* the first append reports nothing either */ }

  const runtime = mkdtempSync(join(tmpdir(), 'acp-seat-'))
  let client = null
  let started = false
  let closed = null
  try {
    const promptFile = join(runtime, 'system.md')
    writeFileSync(promptFile, '')
    const spec = { role: ROLE, cwd: workdir, effort: definition.effort, promptFile, taskDir: runtime, grants, deny: '', writableDirs: [] }
    let launch
    if (isClaude) {
      claudeAdapter.writeSeatSkills({ taskDir: runtime, role: ROLE, grants }, deps.skillDeps ?? {})
      launch = claudeAdapter.acpLaunch({ ...spec, bin: claudeAcp, claudeBin: claude, model })
    } else {
      for (const file of grantedSkills) {
        if (!statSync(file).isFile()) throw new Error(`granted skill ${JSON.stringify(file)} is not a file`)
      }
      launch = piAdapter.acpLaunch({ ...spec, bin: pi, model: piModel })
    }
    const sinkKinds = [...ACP_UPDATE_KINDS, 'unknown']
    client = acpClient({
      launch, dir: join(runtime, 'acp'), cwd: workdir, role: ROLE,
      sinks: Object.fromEntries(sinkKinds.map((kind) => [kind, recordUpdate])),
      deps: deps.clientDeps ?? {},
    })
    client.start()
    started = true
    client.initialize()
    client.newSession(launch.sessionParams)
    if (launch.mode) client.setMode(launch.mode)
    return client.prompt([{ type: 'text', text: prompt }])
  } finally {
    try { closed = client?.close() ?? null } catch { /* teardown never overwrites the turn */ }
    // An unproven teardown keeps the runtime: it holds the evidence the next owner reclaims by.
    if (!started || closed?.outcome === 'proven') { try { rmSync(runtime, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}
