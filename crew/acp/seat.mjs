import {
  accessSync, appendFileSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACP_POLL_MS, ACP_UPDATE_KINDS, acpClient } from '../acp-client.mjs'
import { permissionHandler, readOnlyCommand } from '../acp-permission.mjs'
import { AGENT_ROLES } from '../protocols.mjs'
import * as claudeAdapter from '../adapters/adapter-claude.mjs'
import * as piAdapter from '../adapters/adapter-pi.mjs'

const ROLE = 'seat'
const WRITES = Object.freeze(['none', 'task-dir', 'repo'])
const DEFAULT_TOOLS = Object.freeze({
  repo: 'Read,Edit,Write,Glob,Grep,Bash',
  'task-dir': 'Read,Glob,Grep,Bash,Write',
  none: 'Read,Glob,Grep',
})
const EFFORTS =Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
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

// An existing directory's real path; anything else grants nothing.
function canonicalRoot(dir, real) {
  try {
    const path = real(resolve(dir))
    return statSync(path).isDirectory() ? path : null
  } catch { return null }
}

// Walks the target one component at a time so a symlink or '..' is resolved before it is trusted.
// Only a verified ENOENT is absence (a file about to be created); every other failure is null.
function canonicalWritePath(target, base, real) {
  if (!nonempty(target) || target.includes('\0') || !nonempty(base)) return null
  const root = isAbsolute(target) ? parse(target).root : ''
  let current = root || base
  let absent = false
  for (const part of target.slice(root.length).split(sep)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (absent) return null
      current = dirname(current)
      continue
    }
    const next = join(current, part)
    if (!absent) {
      try { lstatSync(next) } catch (error) {
        if (error?.code !== 'ENOENT') return null
        absent = true
      }
    }
    if (absent) { current = next; continue }
    try { current = real(next) } catch { return null }
  }
  return current
}

const inside = (path, root) => root != null && (path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))

export function runAcpSeat({ definition, cwd, taskDir, prompt, sessionFile, binaries = {}, deps = {} }) {
  if (!definition || typeof definition !== 'object') throw new Error('definition must be an object')
  if (!['claude', 'pi'].includes(definition.agent)) throw new Error(`unsupported agent: ${definition.agent}`)
  if (!nonempty(cwd)) throw new Error('cwd must be a nonempty string')
  if (!nonempty(sessionFile)) throw new Error('sessionFile must be a nonempty string')
  if (typeof prompt !== 'string') throw new Error('prompt must be a string')
  if (typeof definition.model !== 'string' || !MODEL.test(definition.model)) throw new Error(`model must be provider/id, got ${JSON.stringify(definition.model)}`)
  if (!EFFORTS.includes(definition.effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(definition.effort)}`)
  if (definition.role !== undefined && !AGENT_ROLES.includes(definition.role)) throw new Error(`unknown role ${JSON.stringify(definition.role)}`)
  const role = definition.role ?? ROLE
  const waitS = definition.wait_s === undefined ? 2400 : definition.wait_s
  if (!Number.isSafeInteger(waitS) || waitS <= 0) throw new Error(`wait_s must be a positive safe integer, got ${JSON.stringify(definition.wait_s)}`)
  const writes = WRITES.includes(definition.writes) ? definition.writes : 'none'
  const skills = definition.skills ?? []
  if (!Array.isArray(skills)) throw new Error('skills must be a list of skill names or paths')
  const workdir = resolve(cwd)
  const recordTo = resolve(sessionFile)
  const model = definition.model.slice(definition.model.indexOf('/') + 1)
  const piModel = definition.model
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => Number(process.hrtime.bigint()) / 1e6)
  const sleep = deps.sleep ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) })
  const isClaude = definition.agent === 'claude'
  let tools
  let deny = ''
  if (isClaude) {
    const requestedTools = definition.tools === undefined ? DEFAULT_TOOLS[writes].split(',') : definition.tools
    if (!Array.isArray(requestedTools) || !requestedTools.every((tool) => typeof tool === 'string' && tool.trim() !== '')) throw new Error('tools must be a list of nonempty strings')
    tools = [...new Set(requestedTools.map((tool) => tool.trim()))].join(',')
    if (!tools) throw Object.assign(new Error('Claude seat requires at least one tool'), { code: 'ACP_EMPTY_TOOLS' })
    deny = writes === 'task-dir' ? 'Edit,NotebookEdit' : ''
  }
  const claudeAcp = isClaude ? resolveBinary('claude ACP', binaries.claudeAcp, 'claude-agent-acp', env) : null
  const claude = isClaude ? resolveBinary('claude', binaries.claude, 'claude', env) : null
  const pi = isClaude ? null : resolveBinary('pi', binaries.pi, 'pi', env)
  const grantedSkills = skills.map((skill) => resolveSkill(skill, workdir))
  const grants = { tools: [], extensions: [], agents: [], skills: grantedSkills, advisor: false, mcp_servers: [] }

  const append = deps.appendFileSync ?? appendFileSync
  const real = deps.realpathSync ?? realpathSync
  const laneTaskDir = nonempty(taskDir) ? resolve(taskDir) : null
  const workRoot = canonicalRoot(workdir, real)
  const taskRoot = laneTaskDir ? canonicalRoot(laneTaskDir, real) : null

  function record(row) {
    try {
      append(recordTo, `${JSON.stringify(row)}\n`, 'utf8')
    } catch { /* session recording never changes the turn */ }
  }
  const recordUpdate = (payload) => record({ sessionId: payload.sessionId, update: payload.update })
  function recordPermission(decision) {
    const { sessionId, toolCall, options, optionId } = decision
    record({
      kind: 'permission', role, writes, sessionId: sessionId ?? null, tool_call_id: toolCall?.toolCallId ?? null,
      tool: toolCall?.kind ?? null, title: toolCall?.title ?? null, option: optionId ?? null,
      option_kind: options.find((o) => o?.optionId === optionId)?.kind ?? null,
    })
  }

  // The effective definition's writes are the only authority; anything the rules do not name is refused.
  function seatPermission(toolCall) {
    if (toolCall?.kind === 'execute') {
      if (!nonempty(toolCall.rawInput?.command)) return false
      return writes === 'repo' || readOnlyCommand(toolCall?.rawInput?.command)
    }
    if (!['edit', 'write', 'delete'].includes(toolCall?.kind)) return false
    if (writes === 'none') return false
    const named = [toolCall.rawInput?.path, toolCall.rawInput?.file_path].filter((value) => value !== undefined)
    if (named.length === 0 || !named.every((value) => value === named[0]) || !nonempty(named[0])) return false
    const target = canonicalWritePath(named[0], workRoot, real)
    if (target == null) return false
    if (writes === 'task-dir') return inside(target, taskRoot)
    if (writes === 'repo') return inside(target, workRoot) || inside(target, taskRoot)
    return false
  }
  const decide = permissionHandler({ lead: ({ tool_call }) => ({ policy: 'roster', verdict: seatPermission(tool_call) ? 'allow' : 'reject' }) })
  function onPermission({ sessionId, toolCall, options }) {
    let optionId = null
    try { optionId = decide({ toolCall, options }) } catch { /* an undecidable request is cancelled */ }
    recordPermission({ sessionId, toolCall, options, optionId })
    return optionId
  }
  try { mkdirSync(dirname(recordTo), { recursive: true }) } catch { /* the first append reports nothing either */ }

  const runtime = mkdtempSync(join(tmpdir(), 'acp-seat-'))
  let client = null
  let started = false
  let closed = null
  try {
    const promptFile = join(runtime, 'system.md')
    writeFileSync(promptFile, '')
    const writableDirs = writes === 'none' || !laneTaskDir ? [] : [laneTaskDir]
    const spec = { role, cwd: workdir, effort: definition.effort, promptFile, taskDir: runtime, grants, tools, deny, writableDirs }
    let launch
    if (isClaude) {
      claudeAdapter.writeSeatSkills({ taskDir: runtime, role, grants }, deps.skillDeps ?? {})
      launch = claudeAdapter.acpLaunch({ ...spec, bin: claudeAcp, claudeBin: claude, model })
    } else {
      for (const file of grantedSkills) {
        if (!statSync(file).isFile()) throw new Error(`granted skill ${JSON.stringify(file)} is not a file`)
      }
      launch = piAdapter.acpLaunch({ ...spec, bin: pi, model: piModel })
    }
    const sinkKinds = [...ACP_UPDATE_KINDS, 'unknown']
    client = (deps.clientFactory ?? acpClient)({
      launch, dir: join(runtime, 'acp'), cwd: workdir, role, onPermission,
      sinks: Object.fromEntries(sinkKinds.map((kind) => [kind, recordUpdate])),
      deps: deps.clientDeps ?? {},
    })
    client.start()
    started = true
    client.initialize()
    client.newSession(launch.sessionParams)
    if (launch.mode) client.setMode(launch.mode)
    const deadline = now() + waitS * 1000
    const promptId = client.beginPrompt([{ type: 'text', text: prompt }])
    while (now() < deadline) {
      const turn = client.pollPrompt(promptId)
      if (now() >= deadline) break
      if (turn) return turn
      sleep(Math.max(0, Math.min(ACP_POLL_MS, deadline - now())))
    }
    // The cancel is a courtesy: its answer is never awaited, and a failed write cannot replace the deadline.
    // A turn that settled too late is no longer pending, so the session-wide cancel stands in for the prompt's.
    try { client.cancelPrompt(promptId) || client.cancel() } catch { /* the deadline stands */ }
    throw Object.assign(new Error(`${role} produced no answer within ${waitS}s (acp-seat-deadline)`), { reason: 'acp-seat-deadline' })
  } finally {
    try { closed = client?.close() ?? null } catch { /* teardown never overwrites the turn */ }
    // An unproven teardown keeps the runtime: it holds the evidence the next owner reclaims by.
    if (!started || closed?.outcome === 'proven') { try { rmSync(runtime, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}
