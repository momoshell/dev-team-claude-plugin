// The arms a claude ACP seat runs, as Claude Code plugin hooks (ADR-052 Amendment 2).
//
// A pi seat loads crew/pi/extensions/*.ts and the arms attach to pi's events. A claude seat has no such seam, so
// the seat gets one crew-owned plugin whose hooks run those same factories: PreToolUse stands in for tool_call,
// PostToolUse for tool_result, SessionStart for the start of the session. No arm's rule is written here; this file
// translates Claude's hook payloads into the pi-shaped events the factories read, and their results back into hook output.
//
// Every hook call is a fresh process, so what an arm keeps between calls (exportState/importState on the factories)
// lives in a file under the lane's task dir, one per seat session, written under a lock. Which arms exist is fixed at
// launch in config.json beside the hooks; an arm that is not in it is never imported, and no ambient flag grants one.
// A hook that fails for any reason prints nothing and exits 0: a granted arm that breaks never changes the turn.
//
// Claude validates an Edit's input before any hook fires, so a failed Edit has no hook. Edit assist reads the session
// transcript on the next PreToolUse instead and hands the hint over one tool call late.
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTEXT_LAYOUT_ENV, LEAN_LAYOUT, journalPathOf } from '../pi/context-layout.mjs'

const SELF = fileURLToPath(import.meta.url)
export const ARMS_CONFIG_FILE = 'config.json'
const CONFIG_VERSION = 1
const STATE_VERSION = 1
// The arms this lane carries. subagent and codemode have no hook to run on and stay refused.
export const CLAUDE_EXTENSION_ARMS = Object.freeze(['readgate', 'skeletonread', 'reminders', 'builderloop'])
export const CLAUDE_ARMS = Object.freeze([...CLAUDE_EXTENSION_ARMS, 'advisor'])
// advisor.ts ADVISED_ROLES: any other role's advisor never attaches on pi, so it must not be silently inert here.
export const CLAUDE_ADVISED_ROLES = Object.freeze(['builder', 'planner'])
const EVENTS_OF = Object.freeze({
  readgate: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  skeletonread: ['PostToolUse'],
  reminders: ['SessionStart', 'PostToolUse', 'PostToolUseFailure'],
  builderloop: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  advisor: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
})
const HOOK_TIMEOUT_S = 30
const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000
const TRANSCRIPT_WINDOW_BYTES = 8 * 1024 * 1024
const JOURNAL_WINDOW_BYTES = 8 * 1024 * 1024
const HINTED_CAP = 256
const HINTS_PER_CALL = 3
const TOOL_NAMES = Object.freeze({ Bash: 'bash', Read: 'read', Edit: 'edit', Write: 'write' })
// A skeleton ends by pointing at pi's retrieve tool, which a claude seat does not have: it reads the range instead.
const RETRIEVE_USAGE = /^Retrieve usage: retrieve\(.*$/m
const NO_RETRIEVE_TOOL = 'Retrieve usage: this seat has no retrieve tool; read the lines you need with the Read tool (file_path, offset, limit).'

// The arms a grant set names, in grant order, and the extensions this lane does not carry.
export function claudeArmsOf(grants) {
  const arms = []
  const unsupported = []
  for (const extension of grants?.extensions ?? []) {
    const match = /(?:^|\/)crew\/pi\/extensions\/([a-z]+)\.ts$/.exec(String(extension).replaceAll('\\', '/'))
    if (!match || !CLAUDE_EXTENSION_ARMS.includes(match[1])) unsupported.push(extension)
    else if (!arms.includes(match[1])) arms.push(match[1])
  }
  if (grants?.advisor === true) arms.push('advisor')
  return { arms, unsupported }
}

function requireDir(taskDir, role, label) {
  if (typeof taskDir !== 'string' || !isAbsolute(taskDir)) throw new Error(`adapter-claude.${label}: taskDir must be an ABSOLUTE path, got ${JSON.stringify(taskDir)}`)
  if (typeof role !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(role)) throw new Error(`adapter-claude.${label}: unsafe role ${JSON.stringify(role)}`)
}

export function armsPluginDir({ taskDir, role } = {}) {
  requireDir(taskDir, role, 'armsPluginDir')
  return join(taskDir, 'claude-arms', role)
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`

// The plugin a seat with these arms loads: a manifest, one command hook per event the arms use, and the launch
// configuration the hook reads. taskDir is the per-seat runtime; the seat's lasting state goes under laneTaskDir.
export function writeArmsPlugin({ taskDir, role, arms, cwd, editAssist = null, laneTaskDir = null, layout = null, nodeBin = process.execPath } = {}, deps = {}) {
  requireDir(taskDir, role, 'writeArmsPlugin')
  if (!Array.isArray(arms) || arms.length === 0 || !arms.every((arm) => CLAUDE_ARMS.includes(arm))) throw new Error(`adapter-claude.writeArmsPlugin: arms must be a nonempty list of ${CLAUDE_ARMS.join(', ')}`)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error(`adapter-claude.writeArmsPlugin: cwd must be an ABSOLUTE path, got ${JSON.stringify(cwd)}`)
  const root = armsPluginDir({ taskDir, role })
  const seat = basename(taskDir)
  const config = {
    version: CONFIG_VERSION, role, seat, cwd, arms: [...arms],
    edit_assist: editAssist === 'on' || editAssist === 'off' ? editAssist : null,
    lane_task_dir: laneTaskDir || null, layout: laneTaskDir && layout === LEAN_LAYOUT ? LEAN_LAYOUT : null,
    state_dir: join(laneTaskDir || root, 'claude-arms', seat),
  }
  const command = `${shellQuote(nodeBin)} ${shellQuote(SELF)} hook ${shellQuote(root)}`
  const events = [...new Set(arms.flatMap((arm) => EVENTS_OF[arm]))]
  const hooks = Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }]]))
  const rm = deps.rmSync ?? rmSync
  const mkdir = deps.mkdirSync ?? mkdirSync
  const write = deps.writeFileSync ?? writeFileSync
  rm(root, { recursive: true, force: true })
  mkdir(join(root, '.claude-plugin'), { recursive: true })
  mkdir(join(root, 'hooks'), { recursive: true })
  write(join(root, ARMS_CONFIG_FILE), JSON.stringify(config, null, 2))
  write(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks }, null, 2))
  write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: `crew-arms-${role}`, version: '0.0.0', description: `Crew arms for the ${role} seat`, author: { name: 'crew' },
  }, null, 2))
  return root
}

// ---- translation -----------------------------------------------------------------------------------------------

const toolOf = (name) => TOOL_NAMES[name] ?? String(name ?? '').toLowerCase()
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const partText = (part) => (typeof part?.text === 'string' ? part.text : '')
// Claude's own count: the recorded Read responses give numLines === content.split('\n').length ('alpha\n' is 2).
const lineCount = (text) => (text === '' ? 0 : text.split('\n').length)

// Claude's tool input in the shape the factories read: path, edits[{oldText,newText}], content.
function piInput(tool, raw) {
  const input = isObject(raw) ? raw : {}
  if (tool === 'read') return { path: input.file_path, ...(own(input, 'offset') ? { offset: input.offset } : {}), ...(own(input, 'limit') ? { limit: input.limit } : {}) }
  if (tool === 'edit') return { path: input.file_path, edits: typeof input.old_string === 'string' ? [{ oldText: input.old_string, newText: String(input.new_string ?? '') }] : [] }
  if (tool === 'write') return { path: input.file_path, content: input.content }
  return input
}

function textParts(response) {
  if (typeof response === 'string') return [{ type: 'text', text: response }]
  if (Array.isArray(response)) return response.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => ({ type: 'text', text: block.text }))
  if (isObject(response) && typeof response.content === 'string') return [{ type: 'text', text: response.content }]
  return []
}

// A finished tool call as a pi tool_result event, or null when its output is not text the arms may read or replace.
function resultEvent(payload, failed) {
  const toolName = toolOf(payload.tool_name)
  const base = { toolName, toolCallId: String(payload.tool_use_id ?? ''), input: piInput(toolName, payload.tool_input), isError: failed }
  const response = payload.tool_response
  if (failed) return { ...base, content: [{ type: 'text', text: String(payload.error ?? '') }] }
  if (toolName === 'read') {
    if (response?.type !== 'text' || typeof response.file?.content !== 'string') return null
    return { ...base, content: [{ type: 'text', text: response.file.content }] }
  }
  if (toolName === 'bash') {
    if (!isObject(response) || typeof response.stdout !== 'string') return null
    const stderr = typeof response.stderr === 'string' ? response.stderr : ''
    const text = stderr === '' ? response.stdout : `${response.stdout}${response.stdout === '' || response.stdout.endsWith('\n') ? '' : '\n'}${stderr}`
    return { ...base, isError: Number.isInteger(response.exitCode) && response.exitCode !== 0, content: [{ type: 'text', text }] }
  }
  if (toolName === 'edit' || toolName === 'write') return { ...base, content: [] }
  return { ...base, content: textParts(response) }
}

// The tool's own output with its text replaced: Claude drops anything that does not keep the output's shape.
function rewrittenResponse(event, response, text) {
  if (!isObject(response)) return null
  const clone = structuredClone(response)
  if (event.toolName === 'read' && isObject(clone.file)) {
    clone.file.content = text
    clone.file.numLines = lineCount(text)
    if (!own(event.input, 'offset') && !own(event.input, 'limit')) clone.file.totalLines = clone.file.numLines
    return clone
  }
  if (event.toolName === 'bash') return { ...clone, stdout: text, stderr: '' }
  return null
}

// ---- edit assist -----------------------------------------------------------------------------------------------

function readWindow(path, bytes) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    let filled = 0
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, start + filled)
      if (count === 0) break
      filled += count
    }
    const text = buffer.subarray(0, filled).toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch { return null } finally { if (fd !== null) { try { closeSync(fd) } catch { /* nothing to release */ } } }
}

const errorText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(partText).join('\n') : '').replace(/<\/?tool_use_error>/g, '').trim()

// Failed Edit results in the transcript not yet hinted, each with the input that made it. Claude says "String to replace not
// found" and "Found N matches"; builderloop's failed-edit path reads "Could not find the exact text" and "Found N occurrences".
export function failedEdits(transcriptPath, hinted) {
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) return []
  const text = readWindow(transcriptPath, TRANSCRIPT_WINDOW_BYTES)
  if (text === null) return []
  const uses = new Map()
  const failed = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    for (const block of Array.isArray(row?.message?.content) ? row.message.content : []) {
      if (block?.type === 'tool_use' && block.name === 'Edit' && isObject(block.input) && typeof block.id === 'string') uses.set(block.id, block.input)
      else if (block?.type === 'tool_result' && block.is_error === true && uses.has(block.tool_use_id) && !hinted.includes(block.tool_use_id)) {
        const input = uses.get(block.tool_use_id)
        const reported = errorText(block.content)
        const path = input.file_path
        const matches = /Found (\d+) matches? of the string to replace/.exec(reported)
        const message = /String to replace not found/.test(reported) ? `Could not find the exact text in ${path}.`
          : matches ? `Found ${matches[1]} occurrences of the text in ${path}.` : reported
        failed.push({ id: block.tool_use_id, path, event: { toolName: 'edit', toolCallId: block.tool_use_id, input: piInput('edit', input), isError: true, content: [{ type: 'text', text: message }] } })
      }
    }
  }
  return failed
}

// ---- state -----------------------------------------------------------------------------------------------------

function laneRunStart(config) {
  if (!config.lane_task_dir) return null
  const raw = readWindow(journalPathOf(config.lane_task_dir, config.layout ? { [CONTEXT_LAYOUT_ENV]: config.layout } : {}), JOURNAL_WINDOW_BYTES)
  let anchor = null
  for (const line of String(raw ?? '').split('\n')) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event !== 'run-start') continue
    const at = row.at ?? row.started_at ?? row.run_started_at ?? row.timestamp
    const ms = typeof at === 'number' ? at : Date.parse(at)
    if (Number.isFinite(ms)) anchor = ms
  }
  return anchor
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// Concurrent hooks (parallel tool calls) read-modify-write one file, so they take turns.
async function withLock(lock, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { mkdirSync(lock); break } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue } } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error('arm state is locked')
      sleep(25)
    }
  }
  try { return await fn() } finally { try { rmdirSync(lock) } catch { /* already gone */ } }
}

const MALFORMED = Symbol('malformed')

// The stored state for this seat session, a fresh one when there is none or it belongs to another seat, session or
// run, and MALFORMED when it is unreadable as ours.
function loadState(path, identity) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return { ...identity, arms: {}, hinted: [] }; return MALFORMED }
  let state
  try { state = JSON.parse(raw) } catch { return MALFORMED }
  if (!isObject(state) || state.version !== STATE_VERSION || !isObject(state.arms) || !Array.isArray(state.hinted) || !state.hinted.every((id) => typeof id === 'string')) return MALFORMED
  if (state.seat !== identity.seat || state.session !== identity.session || state.run_start !== identity.run_start) return { ...identity, arms: {}, hinted: [] }
  return state
}

function saveState(path, state, before) {
  const text = JSON.stringify(state)
  if (text === before) return
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// ---- the hook --------------------------------------------------------------------------------------------------

async function instantiate(name, env, cwd, outbox) {
  if (name === 'readgate') return (await import('../pi/extensions/readgate.ts')).createReadGate({ env, cwd })
  if (name === 'skeletonread') return (await import('../pi/extensions/skeletonread.ts')).createSkeletonRead({ env, cwd })
  if (name === 'reminders') return (await import('../pi/extensions/reminders.ts')).createReminders({ env })
  if (name === 'builderloop') return (await import('../pi/extensions/builderloop.ts')).createBuilderLoop({ env, cwd })
  // Tier 1 asks a model and outlives a hook, so the advisor runs its mechanical predicates only.
  if (name === 'advisor') return (await import('../pi/extensions/advisor.ts')).createAdvisor({ env, deps: { cwd, tier1: false, send: (message) => { outbox.push(`Advisor note: ${String(message?.content ?? '')}`) } } })
  throw new Error(`unknown arm ${name}`)
}

function armEnv(config) {
  const env = { ...process.env, CREW_ROLE: config.role }
  // The grants are the launch configuration, not whatever flags the process inherited.
  delete env.CREW_ADVISOR
  delete env.CREW_EDIT_ASSIST
  delete env[CONTEXT_LAYOUT_ENV]
  if (config.arms.includes('advisor')) env.CREW_ADVISOR = '1'
  if (config.edit_assist) env.CREW_EDIT_ASSIST = config.edit_assist
  if (config.lane_task_dir) env.CREW_TASK_DIR = config.lane_task_dir
  else delete env.CREW_TASK_DIR
  if (config.layout) env[CONTEXT_LAYOUT_ENV] = config.layout
  return env
}

function readConfig(pluginRoot) {
  const config = JSON.parse(readFileSync(join(pluginRoot, ARMS_CONFIG_FILE), 'utf8'))
  if (!isObject(config) || config.version !== CONFIG_VERSION || typeof config.role !== 'string' || typeof config.seat !== 'string' || typeof config.cwd !== 'string' || typeof config.state_dir !== 'string'
    || !Array.isArray(config.arms) || !config.arms.every((arm) => CLAUDE_ARMS.includes(arm))) throw new Error('arms config is malformed')
  return config
}

async function dispatch(config, payload, arms, state, outbox) {
  const name = payload.hook_event_name
  const cwd = config.cwd
  const ctx = { cwd }
  const guard = async (arm, fn) => { try { return await fn() } catch (error) { process.stderr.write(`crew arm ${arm} failed: ${String(error?.message ?? error).slice(0, 300)}\n`); return undefined } }
  if (name === 'SessionStart') {
    const text = await guard('reminders', () => arms.reminders?.sessionStart())
    return text ? { hookEventName: name, additionalContext: text } : null
  }
  const tool = toolOf(payload.tool_name)
  if (name === 'PreToolUse') {
    const extras = []
    if (arms.builderloop && config.role === 'builder') {
      // The hint for the Edit that failed since the last call: Claude fires no hook for it.
      const unseen = failedEdits(payload.transcript_path, state.hinted)
      for (const failure of unseen.slice(-HINTS_PER_CALL)) {
        const result = await guard('builderloop', () => arms.builderloop.onToolResult(failure.event, ctx))
        const hint = (result?.content ?? []).filter((part) => !failure.event.content.includes(part)).map(partText).join('\n')
        if (hint) extras.push(`Edit assist — your Edit of ${failure.path} failed:\n${hint}`)
      }
      state.hinted = [...state.hinted, ...unseen.map((failure) => failure.id)].slice(-HINTED_CAP)
    }
    const event = { toolName: tool, toolCallId: String(payload.tool_use_id ?? ''), input: piInput(tool, payload.tool_input) }
    let reason = null
    for (const arm of config.arms) {
      const verdict = await guard(arm, () => arms[arm]?.onToolCall?.(event, ctx))
      if (verdict?.block === true && typeof verdict.reason === 'string' && verdict.reason) { reason = verdict.reason; break }
    }
    extras.push(...outbox)
    const out = { hookEventName: name }
    if (reason !== null) Object.assign(out, { permissionDecision: 'deny', permissionDecisionReason: reason })
    if (extras.length) out.additionalContext = extras.join('\n')
    return reason !== null || extras.length ? out : null
  }
  // PostToolUse and PostToolUseFailure
  const failed = name === 'PostToolUseFailure'
  const event = resultEvent(payload, failed)
  if (event === null) return null
  const original = event.content
  for (const arm of config.arms) {
    // builderloop's lane run after a successful edit is not carried; edit assist rides on PreToolUse instead.
    if (arm === 'builderloop' && (tool === 'edit' || tool === 'write')) continue
    const result = await guard(arm, () => (arms[arm]?.onToolResult ?? arms[arm]?.toolResult)?.(event, ctx))
    if (Array.isArray(result?.content)) event.content = result.content
  }
  const added = event.content.filter((part) => !original.includes(part)).map(partText)
  const rewritten = event.content.filter((part) => original.includes(part)).length !== original.length
  const out = { hookEventName: name }
  const notes = [...outbox]
  // A rewrite replaces the tool's output in its own shape; anything else an arm added is context. A failed call's output cannot be replaced.
  if (rewritten) {
    const response = failed ? null : rewrittenResponse(event, payload.tool_response, event.content.map(partText).join('\n').replace(RETRIEVE_USAGE, NO_RETRIEVE_TOOL))
    if (response) out.updatedToolOutput = response
  } else notes.unshift(...added)
  const context = notes.filter(Boolean).join('\n')
  if (context) out.additionalContext = context
  return out.updatedToolOutput !== undefined || context ? out : null
}

// One hook call: the output to print, or null. Throws are the caller's no-op.
export async function runHook(pluginRoot, raw) {
  const config = readConfig(pluginRoot)
  const payload = JSON.parse(raw)
  if (!isObject(payload) || typeof payload.session_id !== 'string' || !payload.session_id || !['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name)) return null
  try { process.chdir(config.cwd) } catch { /* the arms resolve against config.cwd themselves */ }
  const env = armEnv(config)
  const identity = { version: STATE_VERSION, seat: config.seat, session: payload.session_id, run_start: laneRunStart(config) }
  const file = join(config.state_dir, `${createHash('sha256').update(payload.session_id).digest('hex').slice(0, 24)}.json`)
  mkdirSync(config.state_dir, { recursive: true })
  return withLock(`${file}.lock`, async () => {
    const state = loadState(file, identity)
    if (state === MALFORMED) { rmSync(file, { force: true }); return null }
    const before = JSON.stringify(state)
    const outbox = []
    const arms = {}
    for (const name of config.arms) {
      try {
        arms[name] = await instantiate(name, env, config.cwd, outbox)
        if (state.arms[name] !== undefined && typeof arms[name].importState === 'function') arms[name].importState(state.arms[name])
      } catch (error) {
        // An arm that cannot start, or whose stored state is not its own, is not run (and starts fresh next time); the others are.
        process.stderr.write(`crew arm ${name} unavailable: ${String(error?.message ?? error).slice(0, 300)}\n`)
        delete arms[name]
        delete state.arms[name]
      }
    }
    const output = await dispatch(config, payload, arms, state, outbox)
    for (const [name, arm] of Object.entries(arms)) if (typeof arm.exportState === 'function') state.arms[name] = arm.exportState()
    saveState(file, state, before)
    return output
  })
}

async function main() {
  const [command, pluginRoot] = process.argv.slice(2)
  if (command !== 'hook' || !pluginRoot) return
  let output = null
  try { output = await runHook(pluginRoot, readFileSync(0, 'utf8')) } catch (error) {
    process.stderr.write(`crew arms hook failed: ${String(error?.message ?? error).slice(0, 300)}\n`)
  }
  if (output) process.stdout.write(JSON.stringify({ hookSpecificOutput: output }))
}

let isMain = false
try { isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(SELF) } catch { /* imported */ }
if (isMain) await main()
