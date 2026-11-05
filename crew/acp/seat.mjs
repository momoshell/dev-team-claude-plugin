import {
  accessSync, appendFileSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACP_POLL_MS, ACP_UPDATE_KINDS, acpClient } from '../acp-client.mjs'
import { permissionHandler, readOnlyCommand } from '../acp-permission.mjs'
import { armGrants, PI_AGENT_DIR_ENV, refuse } from './grants.mjs'
import { AGENT_ROLES, validateEnvelope } from '../protocols.mjs'
import { GIT_STATUS_ARGS } from '../lane-core.mjs'
import * as claudeAdapter from '../adapters/adapter-claude.mjs'
import * as piAdapter from '../adapters/adapter-pi.mjs'
import * as museAdapter from '../adapters/adapter-muse.mjs'
import { CONTEXT_LAYOUT_ENV, LEAN_LAYOUT, journalPathOf, plannerReturnNumber, plannerReturnsDirOf } from '../pi/context-layout.mjs'
import { ADVISOR_MANIFEST_FILE, ADVISOR_CONFIG_VERSION, SAFE_MODEL, ADVISED_ROLES, READ_CAP_BYTES, boundText, createAdvisor, loadContext as advisorContext } from '../pi/extensions/advisor.ts'
import { loadAcceptedContext } from '../pi/extensions/skeletonread.ts'
import { createReadGate, fffSearchProgram } from '../pi/extensions/readgate.ts'
import { createScoutNudge } from '../pi/extensions/subagent.ts'

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

// Limits: ignored files, outside writes (including the main repo's .git), restored edits,
// index-only changes and writes after unproven teardown escape detection; directories are status-only.
function gitRepoState(cwd) {
  try {
    const result = spawnSync('git', [...GIT_STATUS_ARGS], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024 })
    if (result.status !== 0 || typeof result.stdout !== 'string') return null
    if (result.stdout === '') return ''
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024 })
    if (root.status !== 0 || typeof root.stdout !== 'string' || !root.stdout.endsWith('\n')) return null
    const fields = result.stdout.split('\0')
    const entries = []
    for (let i = 0; i < fields.length; i++) {
      let entry = fields[i]
      if (!entry) continue
      const path = join(root.stdout.slice(0, -1), entry.slice(3))
      if (entry[0] === 'R' || entry[0] === 'C') entry += ` <- ${fields[++i]}`
      let digest
      try {
        const stat = lstatSync(path)
        if (stat.isFile()) digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
        else if (stat.isSymbolicLink()) digest = `link:${readlinkSync(path)}`
        else if (stat.isDirectory()) digest = 'dir'
        else return null
      } catch (error) {
        if (error?.code !== 'ENOENT') return null
        digest = 'missing'
      }
      entries.push(`${entry} ${digest}\0`)
    }
    return entries.join('')
  } catch { return null }
}

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
  skeletonread: ['files_in_scope', 'plan_path'],
})
const CONTEXT_EXTENSIONS = Object.freeze(['skeletonread'])

const nonempty = (value) => typeof value === 'string' && value !== ''

// armGrants resolves extension assets; muse handles readgate at its permission boundary.
function seatGrants(definition, { role, isPi, skills, deps }) {
  const extensions = definition.extensions ?? []
  if (!Array.isArray(extensions) || !extensions.every(nonempty)) throw new Error('extensions must be a list of extension names')
  const advisor = definition.advisor !== undefined && definition.advisor !== null
  if ((isPi || definition.agent === 'muse') && advisor && !ADVISED_ROLES.has(role)) throw refuse('grant-unsupported', `advisor grant is unsupported for seat ${role}`)
  const readgate = definition.agent === 'muse' && extensions.includes('readgate')
  const armed = armGrants({ role, agent: definition.agent, extensions: readgate ? extensions.filter((name) => name !== 'readgate') : extensions }, { register: deps.register, root: deps.root, exists: deps.exists })
  const mcp = armed.mcp_servers.length > 0
  const piBuiltins = isPi && mcp ? ['builtin:mcp'] : []
  return {
    tools: [],
    extensions: [...armed.extensions, ...piBuiltins],
    agents: [...armed.agents],
    skills,
    advisor,
    readgate,
    skeletonread: definition.agent === 'muse' && extensions.includes('skeletonread'),
    subagent: definition.agent === 'muse' && extensions.includes('subagent'),
    mcp_servers: armed.mcp_servers.map((server) => ({ ...server })),
  }
}

// pi reads settings and MCP servers from its agent dir. A seat that needs either gets its own dir in the
// per-seat runtime: the operator's dir symlinked in, settings.json and mcp.json written for the seat.
function writePiAgentDir({ agentDir, grants, cwd, env, role }) {
  const mcp = grants.extensions.includes('builtin:mcp')
  if (!mcp) return
  try {
    if (mcp && existsSync(join(cwd, '.pi', 'mcp.json'))) throw new Error(`project MCP config ${join(cwd, '.pi', 'mcp.json')} would add to or override the granted servers`)
    if (env[PI_AGENT_DIR_ENV] === '') throw new Error(`${PI_AGENT_DIR_ENV} must not be empty`)
    const baseDir = resolve(env[PI_AGENT_DIR_ENV] ?? join(homedir(), '.pi', 'agent'))
    const inside = relative(agentDir, baseDir)
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error(`base directory ${baseDir} is within seat destination ${agentDir}`)
    let base = {}
    try { base = JSON.parse(readFileSync(join(baseDir, 'settings.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('settings.json must contain an object')
    let names = []
    try { names = readdirSync(baseDir) } catch (error) { if (error.code !== 'ENOENT') throw error }
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(base, null, 2))
    if (mcp) {
      const mcpServers = {}
      for (const server of grants.mcp_servers) {
        mcpServers[server.name] = { command: server.command.bin, args: [...server.command.args], exposure: 'direct' }
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

// Extract numbered criteria up to the next section.
function planCriteria(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^## Criteria\s*$/.test(line.trim()))
  if (start < 0) return []
  const items = []
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (/^##\s/.test(line)) break
    if (/^\d+\.\s+\S/.test(line)) items.push(line)
  }
  return items
}

// A cell the manifest reader would accept, from the definition's advisor entry; anything else is no cell.
function advisorCellOf(advisor) {
  const model = advisor?.model
  if (advisor?.agent !== 'pi' || typeof model !== 'string' || !MODEL.test(model) || !EFFORTS.includes(advisor.effort)) return null
  const cell = { provider: model.slice(0, model.indexOf('/')), id: model.slice(model.indexOf('/') + 1), agent: advisor.agent, effort: advisor.effort, model }
  return Object.values(cell).every((value) => SAFE_MODEL.test(value)) ? cell : null
}

// What a lean seat's context arms need, read from the lane's own task dir and nowhere else: the lane's run-start
// anchor (written once by the loop, never per seat) and, past the planner, the planner's current return. A seat that
// cannot be given them is refused here, before it starts, rather than booted with arms that read nothing.
function laneContext({ arms, role, laneTaskDir, workdir, definition, deps, requirePlan = false }) {
  const refusal = (why) => { throw refuse('grant-unsupported', `seat ${role} declares ${arms.join(', ')}, which read the lane context, and ${why} — refusing to boot a silently weaker seat`) }
  if (!laneTaskDir) return refusal('it has no task dir')
  const layout = { [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT }
  const read = deps.readFileSync ?? readFileSync
  let journal
  try { journal = read(journalPathOf(laneTaskDir), 'utf8') } catch { return refusal(`the lane journal ${journalPathOf(laneTaskDir)} is unreadable`) }
  let anchor = null
  for (const line of String(journal).split('\n')) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event !== 'run-start') continue
    const at = epochMs(row.at ?? row.started_at ?? row.run_started_at ?? row.timestamp)
    if (at !== null) anchor = at
  }
  if (anchor === null) return refusal('the lane journal has no run-start')
  let planner = null
  if (role !== 'planner' || requirePlan) {
    const needs = [...new Set(arms.flatMap((arm) => CONTEXT_ARMS[arm]))]
    try {
      const dir = plannerReturnsDirOf(laneTaskDir)
      const candidates = readdirSync(dir)
        .map((name) => ({ name, number: plannerReturnNumber(name) }))
        .filter((entry) => entry.number !== null && statSync(join(dir, entry.name)).mtimeMs >= anchor)
        .sort((a, b) => b.number - a.number)
      for (const candidate of candidates) {
        const value = JSON.parse(read(join(dir, candidate.name), 'utf8'))
        if (value?.status === 'done' && validateEnvelope('planner', value, { archived: true }).defects.length === 0) { planner = value; break }
      }
    } catch (error) { return refusal(`the lane's planner return could not be checked (${error?.code ?? error?.message})`) }
    const details = planner?.status === 'done' && validateEnvelope('planner', planner, { archived: true }).defects.length === 0 ? planner.details : null
    const missing = details === null ? needs : needs.filter((key) => (Array.isArray(details[key]) ? details[key].length === 0 : !nonempty(details[key])))
    if (missing.length) return refusal(`the lane's planner return written since its start does not carry ${missing.join(', ')}`)
    // The arms' own readers have the last word, so a return this check accepts is one each arm can read.
    const env = { [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT, CREW_TASK_DIR: laneTaskDir }
    const unread = arms.filter((arm) => arm === 'skeletonread' && loadAcceptedContext({ taskDir: laneTaskDir, cwd: workdir, env }) === null)
    if (unread.length) return refusal(`${unread.join(', ')} cannot read the lane's planner return`)
  }
  if (!arms.includes('advisor')) return
  const cell = advisorCellOf(definition.advisor)
  if (!cell) return refusal('the advisor cell is not a pi provider/id with an effort')
  const accepted = role !== 'planner' ? loadAcceptedContext({ taskDir: laneTaskDir, cwd: workdir, env: layout }) : null
  const criteria = planCriteria(accepted?.plan_text)
  const tests = Array.isArray(planner?.details?.tests) ? planner.details.tests.filter((test) => nonempty(test?.file) && nonempty(test?.title)).map(({ file, title }) => ({ file, title })) : []
  const manifest = { schema_version: ADVISOR_CONFIG_VERSION, generated_at: new Date().toISOString(), task: basename(dirname(laneTaskDir)), run_started_at: anchor, criteria, tests, cell }
  if (Buffer.byteLength(JSON.stringify(manifest)) > READ_CAP_BYTES) {
    // Match the reader's bounds first; JSON escaping can still expand the result beyond its read cap.
    manifest.criteria = criteria.slice(0, 32).map((item) => boundText(item, 512))
    manifest.tests = tests.slice(0, 32).map(({ file, title }) => ({ file: boundText(file, 256), title: boundText(title, 256) }))
    while (Buffer.byteLength(JSON.stringify(manifest)) > READ_CAP_BYTES && (manifest.criteria.length || manifest.tests.length)) {
      if (manifest.criteria.length) manifest.criteria.pop()
      else manifest.tests.pop()
    }
  }
  const target = join(laneTaskDir, ADVISOR_MANIFEST_FILE)
  try {
    ;(deps.writeFileSync ?? writeFileSync)(`${target}.tmp`, JSON.stringify(manifest))
    ;(deps.renameSync ?? renameSync)(`${target}.tmp`, target)
    const written = JSON.parse(read(target, 'utf8'))
    if (written?.run_started_at !== anchor || written.cell?.model !== cell.model) throw new Error('the manifest read back differs from the one written')
  } catch (error) { refusal(`the advisor manifest could not be written: ${error.message}`) }
  if (role !== 'planner' && advisorContext({ taskDir: laneTaskDir, env: { [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT, CREW_TASK_DIR: laneTaskDir } }).scope_source === 'absent') refusal(`the advisor cannot read the lane's planner return`)
}

export async function runAcpSeat({ definition, cwd, taskDir, prompt, sessionFile, binaries = {}, deps = {} }) {
  if (!definition || typeof definition !== 'object') throw new Error('definition must be an object')
  if (!['claude', 'pi', 'muse'].includes(definition.agent)) throw new Error(`unsupported agent: ${definition.agent}`)
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
  const wait = deps.wait ?? deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const isClaude = definition.agent === 'claude'
  const isPi = definition.agent === 'pi'
  const isMuse = definition.agent === 'muse'
  const confineRepo = isMuse && writes === 'task-dir'
  const repoState = deps.repoState ?? gitRepoState
  let before = null
  if (confineRepo) {
    try { before = repoState(workdir) } catch { /* an unreadable worktree fails closed */ }
    if (typeof before !== 'string') throw refuse('grant-unsupported', 'muse task-dir seat needs a readable git worktree')
  }
  if (isMuse && !definition.model.startsWith('meta/')) throw new Error(`muse requires a meta model, got ${definition.model}`)
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
  const pi = isPi ? resolveBinary('pi', binaries.pi, 'pi', env) : null
  const muse = isMuse ? resolveBinary('muse', binaries.muse, 'muse', env) : null
  const grantedSkills = skills.map((skill) => resolveSkill(skill, workdir))
  const grants = seatGrants(definition, { role, isPi, skills: grantedSkills, deps })
  if (isMuse) museAdapter.assertSupportedGrants(grants)
  // fff replaces native search; pi reads Glob and Grep as find and grep.
  if (grants.mcp_servers.some((server) => server.name === 'fff')) deny = [deny, 'Glob,Grep'].filter(Boolean).join(',')
  const contextArms = !(isPi || isMuse) ? [] : [
    ...(definition.extensions ?? []).filter((name) => CONTEXT_EXTENSIONS.includes(name)),
    ...(grants.advisor ? ['advisor'] : []),
  ]

  const append = deps.appendFileSync ?? appendFileSync
  const real = deps.realpathSync ?? realpathSync
  const laneTaskDir = nonempty(taskDir) ? resolve(taskDir) : null
  let gateFailed = false
  const readgate = grants.readgate ? createReadGate({ cwd: workdir, taskDir: laneTaskDir, env: { ...env, CREW_FFF: grants.mcp_servers.some((server) => server.name === 'fff') ? '1' : '0' }, recordFailure: (row) => {
    gateFailed = true
    if (laneTaskDir) append(journalPathOf(laneTaskDir), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`)
  } }) : null
  if (contextArms.length) laneContext({ arms: contextArms, role, laneTaskDir, workdir, definition, deps, requirePlan: isMuse && grants.skeletonread })
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
  // Wall-clock receipt time is recording evidence; the runner's `now` is monotonic.
  const toolCalls = new Map()
  const advisorNotes = []
  const nudge = isMuse && grants.subagent && grants.agents.length ? createScoutNudge({ env: { ...env, CREW_ROLE: role, CREW_TASK_DIR: laneTaskDir, [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT }, send: (message) => advisorNotes.push(message.content) }) : null
  const seenNudge = new Set()
  const resolveConsultPi = () => { try { return { command: resolveBinary('pi', binaries.pi, 'pi', env) } } catch { return { error: 'pi binary unresolved' } } }
  const advisor = isMuse && grants.advisor ? createAdvisor({ env: { ...env, CREW_ROLE: role, CREW_TASK_DIR: laneTaskDir, [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT }, deps: { ...deps.advisorDeps, cwd: workdir, resolveBinary: resolveConsultPi, send: (message) => advisorNotes.push(message.content) } }) : null
  const advised = new Map()
  const seenAdvice = new Set()
  const completed = new Set()
  const recordUpdate = (payload) => {
    try {
      const update = payload.update
      if (isMuse && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && nonempty(update.toolCallId)) {
        const fields = Object.fromEntries(['kind', 'rawInput', 'title'].filter((key) => update[key] !== undefined).map((key) => [key, update[key]]))
        const call = { ...toolCalls.get(update.toolCallId), ...fields }
        toolCalls.set(update.toolCallId, call)
        const inputReady = call.rawInput && (['completed', 'failed'].includes(update.status) || (call.kind === 'execute' ? nonempty(call.rawInput.command) : ['read', 'edit', 'write'].includes(call.kind) ? nonempty(call.rawInput.path ?? call.rawInput.file_path) : true))
        if (nudge && inputReady && !seenNudge.has(update.toolCallId)) {
          seenNudge.add(update.toolCallId)
          const toolName = ({ execute: 'bash', read: 'read', edit: 'edit', write: 'write' })[call.kind] || ({ 'mcp__crew-extras__agent': 'agent', 'mcp__fff__grep': 'grep', 'mcp__fff__multi_grep': 'grep', 'mcp__fff__find_files': 'find' })[call.title] || call.title
          nudge.onToolCall({ toolName, input: { ...call.rawInput, path: call.rawInput.path ?? call.rawInput.file_path } })
        }
        if (advisor && inputReady && !seenAdvice.has(update.toolCallId)) {
          seenAdvice.add(update.toolCallId)
          const toolName = ({ execute: 'bash', read: 'read', edit: 'edit', write: 'write' })[call.kind] || call.title
          advised.set(update.toolCallId, Promise.resolve(advisor.onToolCall({ toolName, input: { ...call.rawInput, path: call.rawInput.path ?? call.rawInput.file_path }, toolCallId: update.toolCallId }, { cwd: workdir })).catch(() => undefined))
        }
        if (advisor && seenAdvice.has(update.toolCallId) && ['completed', 'failed'].includes(update.status) && !completed.has(update.toolCallId)) {
          completed.add(update.toolCallId)
          const toolName = ({ execute: 'bash', read: 'read', edit: 'edit', write: 'write' })[call.kind] || call.title
          const content = typeof update.rawOutput === 'string' ? [{ type: 'text', text: update.rawOutput }] : (update.content || []).map((item) => item.content || item)
          advisor.onToolResult({ toolName, input: { ...call.rawInput, path: call.rawInput.path ?? call.rawInput.file_path }, toolCallId: update.toolCallId, isError: update.status === 'failed', content }, { cwd: workdir })
        }
      }
      record({ sessionId: payload.sessionId, update, at: (deps.recordNow ?? Date.now)() })
    } catch { /* recording cannot change the turn */ }
  }
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
    if (readgate && (toolCall?.kind === 'execute' || toolCall?.kind === 'read')) {
      try {
        const input = toolCall.rawInput
        const isRead = toolCall.kind === 'read'
        const path = input?.path ?? input?.file_path
        if (isRead ? nonempty(path) : nonempty(input?.command)) {
          gateFailed = false
          const event = { toolName: isRead ? 'read' : 'bash', input: isRead ? { ...input, path } : input, toolCallId: toolCall.toolCallId }
          const result = readgate.onToolCall(event, { cwd: workdir })
          if (result?.block) return false
          // The shared gate handles cd + rg; apply its direct-search rule to the other certain cd shapes too.
          const cd = !isRead && /^\s*cd\s+((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\\.|[^\s;&|])+)\s+&&\s+([\s\S]*)$/.exec(input.command)
          if (cd && !/[`$]/.test(cd[1]) && /^(?:grep|rg|find|fd)(?:\s|$)/.test(cd[2]) && fffSearchProgram(cd[2]) && readgate.onToolCall({ ...event, input: { command: cd[2] } }, { cwd: workdir })?.block) return false
          if (isRead && !gateFailed) return true
        }
      } catch { /* fall through to the existing permission decision */ }
    }
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
  const decide = permissionHandler({ permit: seatPermission })
  function onPermission({ sessionId, toolCall, options }) {
    let optionId = null
    try {
      if (isMuse && toolCalls.has(toolCall?.toolCallId)) {
        toolCall = { ...toolCalls.get(toolCall.toolCallId), ...Object.fromEntries(Object.entries(toolCall).filter(([, value]) => value !== undefined)) }
      }
    } catch { /* leave the request unchanged */ }
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
      role, cwd: workdir, effort: definition.effort, promptFile, taskDir: runtime, grants, tools, deny, writableDirs,
      env: {
        ...(laneTaskDir ? { CREW_ROLE: role, CREW_TASK_DIR: laneTaskDir, [CONTEXT_LAYOUT_ENV]: LEAN_LAYOUT } : { CREW_ROLE: role }),
        // Launch-authoritative: an inherited value never decides whether the seat's refusals carry a reason.
        CREW_READ_ONLY: writes === 'repo' ? '0' : '1', CREW_READ_ONLY_NODE: process.execPath, CREW_READ_ONLY_HOOK: READ_ONLY_HOOK,
      },
    }
    let launch
    if (isClaude) {
      claudeAdapter.writeSeatSkills({ taskDir: runtime, role, grants }, deps.skillDeps ?? {})
      launch = claudeAdapter.acpLaunch({ ...spec, bin: claudeAcp, claudeBin: claude, model })
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
    } else if (isPi) {
      for (const file of grantedSkills) {
        if (!statSync(file).isFile()) throw new Error(`granted skill ${JSON.stringify(file)} is not a file`)
      }
      writePiAgentDir({ agentDir: piAdapter.piSeatAgentDir({ taskDir: runtime, role }), grants, cwd: workdir, env, role })
      launch = piAdapter.acpLaunch({ ...spec, bin: pi, model: piModel })
    } else {
      museAdapter.writeSeatSkills({ taskDir: runtime, grants })
      launch = museAdapter.acpLaunch({ ...spec, bin: muse, model, writes, piBinary: grants.subagent ? resolveConsultPi().command : undefined })
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
    // ACP's selected rejection carries only an option ID, so give the redirects before the turn.
    const guidance = readgate ? `\n\nReadgate is active: whole-file reads and cat/head/tail of large files are refused; use a ranged read instead.${grants.mcp_servers.some((server) => server.name === 'fff') ? ' Direct grep/rg/find/fd searches are refused; use mcp__fff__grep or mcp__fff__find_files instead.' : ''}` : ''
    const extras = [grants.skeletonread && 'mcp__crew-extras__retrieve', grants.skeletonread && 'mcp__crew-extras__skeleton', grants.subagent && 'mcp__crew-extras__agent'].filter(Boolean)
    const extraGuidance = (extras.length ? `\n\nGranted tools: ${extras.join(', ')}.` : '') + (grants.skeletonread ? ' A whole read of a large in-scope source file is refused; call mcp__crew-extras__skeleton with its path for the indexed signatures and plan citations, then mcp__crew-extras__retrieve for a range or symbol.' : '')
    // Muse writes without asking, so a return the advisor blocked is already on disk, however it was written. A
    // blocked turn records the returns this run wrote; after the follow-up turn, any still byte-identical is removed.
    const returnName = new RegExp('^' + role + '-\\d+\\.json$')
    const returnHashes = () => {
      const hashes = new Map()
      try {
        for (const name of laneTaskDir ? readdirSync(laneTaskDir) : []) {
          if (returnName.test(name)) hashes.set(join(laneTaskDir, name), createHash('sha256').update(readFileSync(join(laneTaskDir, name))).digest('hex'))
        }
      } catch { /* an unreadable return is never removed */ }
      return hashes
    }
    const priorReturns = returnHashes()
    let blockedReturns = null
    let promptId = client.beginPrompt([{ type: 'text', text: prompt + guidance + extraGuidance }])
    let settleTimedOut = false
    const finishTurn = async (turn) => {
      if (blockedReturns) {
        for (const [path, hash] of returnHashes()) if (blockedReturns.get(path) === hash) try { rmSync(path, { force: true }) } catch { /* the block was still delivered */ }
        blockedReturns = null
      }
      // A refused or cancelled turn is terminal: queued advice never turns it into another prompt.
      const terminal = turn.refusal != null || turn.stopReason !== 'end_turn'
      if (advisor && !terminal) {
        let timer
        const settled = await Promise.race([
          (async () => {
            const verdicts = await Promise.all(advised.values())
            await advisor.settled()
            return verdicts
          })().catch(() => []),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - now())) }),
        ])
        clearTimeout(timer)
        if (settled === null || now() >= deadline) { settleTimedOut = true; return null }
        advised.clear()
        const blocks = settled.filter((verdict) => verdict?.block && nonempty(verdict.reason))
        for (const verdict of blocks) advisorNotes.push(verdict.reason)
        if (isMuse && blocks.length) blockedReturns = new Map([...returnHashes()].filter(([path, hash]) => priorReturns.get(path) !== hash))
      }
      if (advisorNotes.length && !terminal) {
        promptId = client.beginPrompt([{ type: 'text', text: advisorNotes.splice(0).join('\n\n') }])
        return null
      }
      return isMuse ? { ...turn, usage: null, usage_reason: 'usage-unavailable', ...(grantedSkills.length ? { museSkillsRoot: join(runtime, 'muse-skills') } : {}) } : turn
    }
    while (now() < deadline) {
      // Nothing can repair a lost runtime, and the stream it held would stay silent until the deadline.
      if (!existsSync(runtime)) {
        throw Object.assign(new Error(`${role} runtime ${runtime} disappeared mid-turn (acp-seat-runtime-missing)`), { reason: 'acp-seat-runtime-missing' })
      }
      const turn = client.pollPrompt(promptId)
      if (now() >= deadline) break
      if (turn) {
        const finished = await finishTurn(turn)
        if (finished) return finished
        if (settleTimedOut) break
        continue
      }
      // A seat that died with no answer would otherwise hold the turn until its deadline.
      if (client.hasExitMarker?.()) {
        // The answer may have settled between the empty poll and the marker.
        const exitedTurn = client.pollPrompt(promptId)
        if (now() >= deadline) break
        if (exitedTurn) {
          const finished = await finishTurn(exitedTurn)
          if (finished) return finished
          if (settleTimedOut) break
          continue
        }
        throw Object.assign(new Error(`${role} exited before answering (acp-seat-closed)`), { reason: 'acp-seat-closed' })
      }
      await wait(Math.max(0, Math.min(ACP_POLL_MS, deadline - now())))
    }
    // The cancel is a courtesy: its answer is never awaited, and a failed write cannot replace the deadline.
    // A turn that settled too late is no longer pending, so the session-wide cancel stands in for the prompt's.
    try { client.cancelPrompt(promptId) || client.cancel() } catch { /* the deadline stands */ }
    throw Object.assign(new Error(`${role} produced no answer within ${waitS}s (acp-seat-deadline)`), { reason: 'acp-seat-deadline' })
  } finally {
    try { closed = client?.close() ?? null } catch { /* teardown never overwrites the turn */ }
    // An unproven teardown keeps the runtime: it holds the evidence the next owner reclaims by.
    if ((!started && !client?.spawned) || closed?.outcome === 'proven') { try { rmSync(runtime, { recursive: true, force: true }) } catch { /* best effort */ } }
    if (confineRepo && (started || client?.spawned)) {
      let after = null
      try { after = repoState(workdir) } catch { /* an unreadable worktree fails closed */ }
      if (typeof after !== 'string' || after !== before) {
        const reason = typeof after !== 'string' ? 'acp-seat-repo-unmeasured' : 'acp-seat-wrote-repo'
        const paths = typeof after === 'string' ? `: ${after.split('\0').filter((field) => field && !before.split('\0').includes(field)).slice(0, 3).join(', ') || 'content changed'}` : ''
        throw Object.assign(new Error(`${role} worktree check failed${paths} (${reason})`), { reason })
      }
    }
  }
}
