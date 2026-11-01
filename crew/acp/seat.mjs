import {
  accessSync, appendFileSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACP_POLL_MS, ACP_UPDATE_KINDS, acpClient } from '../acp-client.mjs'
import { permissionHandler, readOnlyCommand } from '../acp-permission.mjs'
import { armGrants, PI_AGENT_DIR_ENV, refuse } from './grants.mjs'
import { AGENT_ROLES, validateEnvelope } from '../protocols.mjs'
import * as claudeAdapter from '../adapters/adapter-claude.mjs'
import * as piAdapter from '../adapters/adapter-pi.mjs'
import { CONTEXT_LAYOUT_ENV, LEAN_LAYOUT, journalPathOf, plannerReturnNumber, plannerReturnsDirOf } from '../pi/context-layout.mjs'
import { ADVISED_ROLES, loadContext as advisorContext } from '../pi/extensions/advisor.ts'
import { loadPlannerContext } from '../pi/extensions/builderloop.ts'
import { loadAcceptedContext } from '../pi/extensions/skeletonread.ts'

const ROLE = 'seat'
const WRITES = Object.freeze(['none', 'task-dir', 'repo'])
const DEFAULT_TOOLS = Object.freeze({
  repo: 'Read,Edit,Write,Glob,Grep,Bash',
  'task-dir': 'Read,Glob,Grep,Bash,Write',
  none: 'Read,Glob,Grep',
})
// Tools claude-agent-acp would run without asking when listed in allowedTools.
const UNASKED_TOOLS = Object.freeze(['Write', 'Edit', 'NotebookEdit', 'Bash'])
const EFFORTS =Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/
const READ_ONLY_HOOK = fileURLToPath(new URL('../adapters/claude-readonly.mjs', import.meta.url))
const SKILLS_ROOT = fileURLToPath(new URL('../../skills', import.meta.url))
// A plain string replaces claude-agent-acp's claude_code preset; the role prompt arrives in the turn itself.
const LEAN_CLAUDE_SYSTEM_PROMPT = 'You are a coding agent. Work in the current directory with the tools you have. Prefer short command output: use quiet or dot reporters and tail long logs. Be concise.'

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

// The pi arms that read the lane's own context: its run anchor and the planner's return. Each names the
// planner details it cannot do without.
const CONTEXT_ARMS = Object.freeze({
  advisor: ['files_in_scope'],
  builderloop: ['files_in_scope', 'validation_lane', 'gate_cmd'],
  edit_assist: ['files_in_scope', 'validation_lane', 'gate_cmd'],
  skeletonread: ['files_in_scope', 'plan_path'],
})
const CONTEXT_EXTENSIONS = Object.freeze(['builderloop', 'skeletonread'])
const ADVISOR_MANIFEST = 'advisor-manifest.json'
const ADVISOR_MANIFEST_VERSION = 1
// advisor.ts SAFE_MODEL: the spellings its manifest reader accepts for a cell.
const SAFE_CELL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

const nonempty = (value) => typeof value === 'string' && value !== ''

// The arms the effective definition declares, as the seat's grants. An arm the adapter cannot express
// is refused here or by the adapter itself; none is dropped. Claude runs the arms adapter-claude lists as plugin hooks,
// expresses the fff and lab MCP servers, and refuses the rest (subagent among them) when it builds the launch.
function seatGrants(definition, { role, isClaude, skills, deps }) {
  const extensions = definition.extensions ?? []
  if (!Array.isArray(extensions) || !extensions.every(nonempty)) throw new Error('extensions must be a list of extension names')
  const advisor = definition.advisor !== undefined && definition.advisor !== null
  if (!isClaude && advisor && !ADVISED_ROLES.has(role)) throw refuse('grant-unsupported', `advisor grant is unsupported for seat ${role}`)
  if (isClaude && definition.codemode === true) throw refuse('grant-unsupported', `adapter-claude cannot express the codemode arm of seat ${role} — refusing to boot a silently weaker seat`)
  const armed = armGrants({ role, agent: definition.agent, extensions }, { register: deps.register, root: deps.root, exists: deps.exists })
  const mcp = armed.mcp_servers.length > 0
  const piBuiltins = isClaude ? [] : [...(definition.codemode === true ? ['builtin:codemode'] : []), ...(mcp ? ['builtin:mcp'] : [])]
  return {
    tools: isClaude && armed.mcp_servers.some((server) => server.name === 'lab') ? [...piAdapter.PI_MCP_SERVER_TOOLS.lab] : [],
    extensions: [...armed.extensions, ...piBuiltins],
    agents: [...armed.agents],
    skills,
    advisor,
    mcp_servers: armed.mcp_servers.map((server) => ({ ...server })),
  }
}

// pi reads settings and MCP servers from its agent dir. A seat that needs either gets its own dir in the
// per-seat runtime: the operator's dir symlinked in, settings.json and mcp.json written for the seat.
function writePiAgentDir({ agentDir, grants, cwd, env, role }) {
  const mcp = grants.extensions.includes('builtin:mcp')
  const codemode = grants.extensions.includes('builtin:codemode')
  if (!mcp && !codemode) return
  try {
    if (mcp && existsSync(join(cwd, '.pi', 'mcp.json'))) throw new Error(`project MCP config ${join(cwd, '.pi', 'mcp.json')} would add to or override the granted servers`)
    const baseDir = resolve(env[PI_AGENT_DIR_ENV] ?? join(homedir(), '.pi', 'agent'))
    const inside = relative(agentDir, baseDir)
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error(`base directory ${baseDir} is within seat destination ${agentDir}`)
    let base = {}
    try { base = JSON.parse(readFileSync(join(baseDir, 'settings.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('settings.json must contain an object')
    let names = []
    try { names = readdirSync(baseDir) } catch (error) { if (error.code !== 'ENOENT') throw error }
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(codemode ? { ...base, codemode: { ...base.codemode, mode: 'only' } } : base, null, 2))
    if (mcp) {
      const mcpServers = {}
      for (const server of grants.mcp_servers) {
        mcpServers[server.name] = { command: server.command.bin, args: [...server.command.args], exposure: 'direct', ...(server.name === 'lab' ? { timeout: 960 } : {}) }
      }
      writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers }, null, 2))
    }
    for (const name of names) if (name !== 'settings.json' && name !== 'mcp.json') symlinkSync(join(baseDir, name), join(agentDir, name))
  } catch (error) {
    throw refuse('grant-unsupported', `seat ${role} pi agent directory materialisation failed: ${error.message}`)
  }
}

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

const epochMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number.isFinite(Number(value)) ? Number(value) : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

// The Tripwire tests section of the brief, as the old path's advisorManifest reads it (crew/crew.mjs).
function briefTripwires(briefText) {
  const lines = String(briefText ?? '').split(/\r?\n/)
  const marker = lines.findIndex((line) => line.trim().toLowerCase() === 'tripwire tests:')
  const tripwires = []
  if (marker >= 0) for (let i = marker + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (/^broad keys\b/i.test(line)) break
    const match = /^-\s+(.+?)\s+·/.exec(line)
    if (match && match[1].trim()) tripwires.push(match[1].trim())
  }
  return tripwires
}

// The brief's `## Acceptance` items (`- (ID) text`), id kept, so the pre-return consult can check the change against them.
function briefAcceptanceItems(briefText) {
  const lines = String(briefText ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+acceptance\s*$/i.test(line.trim()))
  const items = []
  if (start >= 0) for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (/^##\s/.test(line)) break
    const match = /^-\s+(\(.+?\).*)$/.exec(line)
    if (match) items.push(match[1].trim())
  }
  return items
}

// A cell the manifest reader would accept, from the definition's advisor entry; anything else is no cell.
function advisorCellOf(advisor) {
  const model = advisor?.model
  if (advisor?.agent !== 'pi' || typeof model !== 'string' || !MODEL.test(model) || !EFFORTS.includes(advisor.effort)) return null
  const cell = { provider: model.slice(0, model.indexOf('/')), id: model.slice(model.indexOf('/') + 1), agent: advisor.agent, effort: advisor.effort, model }
  return Object.values(cell).every((value) => SAFE_CELL_VALUE.test(value)) ? cell : null
}

// What a lean seat's context arms need, read from the lane's own task dir and nowhere else: the lane's run-start
// anchor (written once by the loop, never per seat) and, past the planner, the planner's current return. A seat that
// cannot be given them is refused here, before it starts, rather than booted with arms that read nothing.
function laneContext({ arms, role, laneTaskDir, workdir, definition, briefText, deps }) {
  const refusal = (why) => { throw refuse('grant-unsupported', `seat ${role} declares ${arms.join(', ')}, which read the lane context, and ${why} — refusing to boot a silently weaker seat`) }
  if (!laneTaskDir) return refusal('it has no task dir')
  const layout = { [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT }
  const read = deps.readFileSync ?? readFileSync
  let journal
  try { journal = read(journalPathOf(laneTaskDir, layout), 'utf8') } catch { return refusal(`the lane journal ${journalPathOf(laneTaskDir, layout)} is unreadable`) }
  let anchor = null
  for (const line of String(journal).split('\n')) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event !== 'run-start') continue
    const at = epochMs(row.at ?? row.started_at ?? row.run_started_at ?? row.timestamp)
    if (at !== null) anchor = at
  }
  if (anchor === null) return refusal('the lane journal has no run-start')
  if (role !== 'planner') {
    const needs = [...new Set(arms.flatMap((arm) => CONTEXT_ARMS[arm]))]
    let planner = null
    try {
      const dir = plannerReturnsDirOf(laneTaskDir, layout)
      const candidates = readdirSync(dir)
        .map((name) => ({ name, number: plannerReturnNumber(name, layout) }))
        .filter((entry) => entry.number !== null && statSync(join(dir, entry.name)).mtimeMs >= anchor)
        .sort((a, b) => b.number - a.number)
      if (candidates[0]) planner = JSON.parse(read(join(dir, candidates[0].name), 'utf8'))
    } catch { planner = null }
    const details = planner?.status === 'done' && validateEnvelope('planner', planner).defects.length === 0 ? planner.details : null
    const missing = details === null ? needs : needs.filter((key) => (Array.isArray(details[key]) ? details[key].length === 0 : !nonempty(details[key])))
    if (missing.length) return refusal(`the lane's planner return written since its start does not carry ${missing.join(', ')}`)
    // The arms' own readers have the last word, so a return this check accepts is one each arm can read.
    const env = { [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT, CREW_TASK_DIR: laneTaskDir }
    const unread = arms.filter((arm) => (arm === 'skeletonread'
      ? loadAcceptedContext({ taskDir: laneTaskDir, cwd: workdir, env }) === null
      : ['builderloop', 'edit_assist'].includes(arm) && loadPlannerContext({ taskDir: laneTaskDir, env }) === null))
    if (unread.length) return refusal(`${unread.join(', ')} cannot read the lane's planner return`)
  }
  if (!arms.includes('advisor')) return
  const cell = advisorCellOf(definition.advisor)
  if (!cell) return refusal('the advisor cell is not a pi provider/id with an effort')
  const manifest = { schema_version: ADVISOR_MANIFEST_VERSION, generated_at: new Date().toISOString(), task: basename(dirname(laneTaskDir)), run_started_at: anchor, tripwires: briefTripwires(briefText), acceptance_items: briefAcceptanceItems(briefText), cell }
  const target = join(laneTaskDir, ADVISOR_MANIFEST)
  try {
    ;(deps.writeFileSync ?? writeFileSync)(`${target}.tmp`, JSON.stringify(manifest))
    ;(deps.renameSync ?? renameSync)(`${target}.tmp`, target)
    const written = JSON.parse(read(target, 'utf8'))
    if (written?.run_started_at !== anchor || written.cell?.model !== cell.model) throw new Error('the manifest read back differs from the one written')
  } catch (error) { refusal(`the advisor manifest could not be written: ${error.message}`) }
  if (role !== 'planner' && advisorContext({ taskDir: laneTaskDir, env: { [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT, CREW_TASK_DIR: laneTaskDir } }).scope_source === 'absent') refusal(`the advisor cannot read the lane's planner return`)
}

export function runAcpSeat({ definition, cwd, taskDir, prompt, briefText, sessionFile, binaries = {}, deps = {} }) {
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
  const piModel = definition.agent === 'pi' ? piAdapter.modelString({ provider: definition.model.split('/')[0], id: model }) : definition.model
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
  const grants = seatGrants(definition, { role, isClaude, skills: grantedSkills, deps })
  // fff replaces native search, as the old path's effectiveDeny did; pi reads Glob and Grep as find and grep.
  if (grants.mcp_servers.some((server) => server.name === 'fff')) deny = [deny, 'Glob,Grep'].filter(Boolean).join(',')
  const editAssist = typeof definition.edit_assist === 'boolean' ? (definition.edit_assist ? 'on' : 'off') : null
  const contextArms = [
    ...(definition.extensions ?? []).filter((name) => CONTEXT_EXTENSIONS.includes(name)),
    ...(grants.advisor ? ['advisor'] : []), ...(definition.edit_assist === true ? ['edit_assist'] : []),
  ]

  const append = deps.appendFileSync ?? appendFileSync
  const real = deps.realpathSync ?? realpathSync
  const laneTaskDir = nonempty(taskDir) ? resolve(taskDir) : null
  // edit_assist runs inside builderloop; without it the seat would carry the flag and no arm to act on it.
  if (contextArms.includes('edit_assist') && !contextArms.includes('builderloop')) throw refuse('grant-unsupported', `seat ${role} declares edit_assist without builderloop, which runs it — refusing to boot a silently weaker seat`)
  if (contextArms.length) laneContext({ arms: contextArms, role, laneTaskDir, workdir, definition, briefText, deps })
  const workRoot = canonicalRoot(workdir, real)
  const taskRoot = laneTaskDir ? canonicalRoot(laneTaskDir, real) : null
  // lean.mjs records every turn under <taskDir>/lean; a seat never edits the record of a turn.
  // Case is folded because the default macOS volume resolves LEAN and Lean to the same directory.
  const leanRoot = taskRoot ? canonicalWritePath(join(taskRoot, 'lean'), taskRoot, real) : null

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
    if (inside(target.toLowerCase(), leanRoot?.toLowerCase())) return false
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

  // A lean seat's runtime sits beside its lane's task dir, so a glob over another lane's runtimes cannot reach it.
  const runtimeRoot = deps.runtimeRoot ?? (laneTaskDir ? join(dirname(laneTaskDir), 'seat-runtime') : tmpdir())
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
  const runtime = mkdtempSync(join(runtimeRoot, 'acp-seat-'))
  let client = null
  let started = false
  let closed = null
  try {
    const promptFile = join(runtime, 'system.md')
    writeFileSync(promptFile, '')
    const writableDirs = writes === 'none' || !laneTaskDir ? [] : [laneTaskDir]
    // taskDir stays the per-seat runtime, where materialised resources live; the lane's task dir reaches the seat through its environment.
    const spec = {
      role, cwd: workdir, effort: definition.effort, promptFile, taskDir: runtime, grants, tools, deny, writableDirs, editAssist,
      env: {
        ...(laneTaskDir ? { CREW_ROLE: role, CREW_TASK_DIR: laneTaskDir, [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT } : { CREW_ROLE: role }),
        // Launch-authoritative: an inherited value never decides whether the seat's refusals carry a reason.
        CREW_READ_ONLY: writes === 'repo' ? '0' : '1', CREW_READ_ONLY_NODE: process.execPath, CREW_READ_ONLY_HOOK: READ_ONLY_HOOK,
      },
    }
    let launch
    if (isClaude) {
      claudeAdapter.writeSeatSkills({ taskDir: runtime, role, grants }, deps.skillDeps ?? {})
      // The arms' hooks keep their state in the lane's task dir (spec.env), not in this runtime.
      claudeAdapter.writeSeatArms({ taskDir: runtime, role, grants, cwd: workdir, editAssist, env: spec.env }, deps.armDeps ?? {})
      launch = claudeAdapter.acpLaunch({ ...spec, bin: claudeAcp, claudeBin: claude, model, armHooks: true })
      launch.sessionParams._meta.systemPrompt = LEAN_CLAUDE_SYSTEM_PROMPT
      const options = launch.sessionParams._meta.claudeCode.options
      // The target checkout's permissions.allow would approve calls before they reach onPermission.
      // An explicit empty list overrides the SDK defaults; the usage settings and plugins stay.
      options.settingSources = []
      if (writes !== 'repo') {
        // `default` (Manual) asks before every change; acceptEdits would take an edit in cwd silently.
        // Listed tools stay available but lose auto-approval, so each write or shell call reaches onPermission.
        launch.mode = 'default'
        options.allowedTools = options.allowedTools.filter((tool) => !UNASKED_TOOLS.includes(tool.split('(')[0].trim()))
      }
    } else {
      for (const file of grantedSkills) {
        if (!statSync(file).isFile()) throw new Error(`granted skill ${JSON.stringify(file)} is not a file`)
      }
      writePiAgentDir({ agentDir: piAdapter.piSeatAgentDir({ taskDir: runtime, role }), grants, cwd: workdir, env, role })
      launch = piAdapter.acpLaunch({ ...spec, bin: pi, model: piModel })
    }
    const sinkKinds = [...ACP_UPDATE_KINDS, 'unknown']
    client = (deps.clientFactory ?? acpClient)({
      launch, dir: join(runtime, 'acp'), cwd: workdir, role, onPermission,
      sinks: Object.fromEntries(sinkKinds.map((kind) => [kind, recordUpdate])),
      deps: { seatCommandRoot: runtime, ...deps.clientDeps },
    })
    client.start()
    started = true
    client.initialize()
    client.newSession(launch.sessionParams)
    if (launch.mode) client.setMode(launch.mode)
    const deadline = now() + waitS * 1000
    const promptId = client.beginPrompt([{ type: 'text', text: prompt }])
    while (now() < deadline) {
      // Nothing can repair a lost runtime, and the stream it held would stay silent until the deadline.
      if (!existsSync(runtime)) {
        throw Object.assign(new Error(`${role} runtime ${runtime} disappeared mid-turn (acp-seat-runtime-missing)`), { reason: 'acp-seat-runtime-missing' })
      }
      const turn = client.pollPrompt(promptId)
      if (now() >= deadline) break
      if (turn) return turn
      // A seat that died with no answer would otherwise hold the turn until its deadline.
      if (client.hasExitMarker?.()) {
        // The answer may have settled between the empty poll and the marker.
        const exitedTurn = client.pollPrompt(promptId)
        if (now() >= deadline) break
        if (exitedTurn) return exitedTurn
        throw Object.assign(new Error(`${role} exited before answering (acp-seat-closed)`), { reason: 'acp-seat-closed' })
      }
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
