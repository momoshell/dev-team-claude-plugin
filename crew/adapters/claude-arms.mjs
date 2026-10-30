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
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
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
  skeletonread: ['PreToolUse', 'PostToolUse'],
  reminders: ['SessionStart', 'PostToolUse', 'PostToolUseFailure'],
  builderloop: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  advisor: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
})
// Must outlive an inline pre-return consult: its 20s bound, the child kill graces, and the journal writes.
const HOOK_TIMEOUT_S = 45
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
export function writeArmsPlugin({ taskDir, role, arms, cwd, editAssist = null, fff = false, laneTaskDir = null, layout = null, nodeBin = process.execPath } = {}, deps = {}) {
  requireDir(taskDir, role, 'writeArmsPlugin')
  if (!Array.isArray(arms) || arms.length === 0 || !arms.every((arm) => CLAUDE_ARMS.includes(arm))) throw new Error(`adapter-claude.writeArmsPlugin: arms must be a nonempty list of ${CLAUDE_ARMS.join(', ')}`)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error(`adapter-claude.writeArmsPlugin: cwd must be an ABSOLUTE path, got ${JSON.stringify(cwd)}`)
  const root = armsPluginDir({ taskDir, role })
  const seat = basename(taskDir)
  const config = {
    version: CONFIG_VERSION, role, seat, cwd, arms: [...arms], fff,
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

// Parse only literal shell words; never evaluate shell syntax or promote composed commands.
function bashRead(command) {
  if (typeof command !== 'string' || /[\n\r]/.test(command)) return null
  const words = []
  let word = '', quote = '', active = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue }
    if (ch === '\\') {
      if (++i >= command.length) return null
      if (quote === '"' && !'\\"$`'.includes(command[i])) word += '\\'
      word += command[i]; active = true; continue
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      else if (ch === '$' || ch === '`') return null
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; active = true; continue }
    if (/\s/.test(ch)) { if (active) { words.push(word); word = ''; active = false } continue }
    if (/[|;&<>$`*?\[\]{}()~#]/.test(ch)) return null
    word += ch; active = true
  }
  if (quote) return null
  if (active) words.push(word)
  const positive = (s) => /^\d+$/.test(s ?? '') && Number.isSafeInteger(Number(s)) && Number(s) > 0 ? Number(s) : null
  let path, offset, limit
  if (words[0] === 'cat') {
    if (words[1] === '--') words.splice(1, 1)
    if (words.length !== 2) return null
    path = words[1]
  } else if (words[0] === 'head') {
    let count = 10
    if (words[1] === '-n') { count = positive(words[2]); words.splice(1, 2) }
    else if (words[1]?.startsWith('-n')) { count = positive(words[1].slice(2)); words.splice(1, 1) }
    if (!count || words.length !== 2) return null
    path = words[1]; offset = 1; limit = count
  } else if (words[0] === 'sed' && words.length === 4 && words[1] === '-n') {
    const match = /^(\d+)(?:,(\d+))?p$/.exec(words[2])
    const start = positive(match?.[1]), end = positive(match?.[2] ?? match?.[1])
    if (!start || !end || end < start || !Number.isSafeInteger(end - start + 1)) return null
    path = words[3]; offset = start; limit = end - start + 1
  } else return null
  if (!path || path === '-' || path.startsWith('-')) return null
  return { path, ...(offset === undefined ? {} : { offset, limit }) }
}

// Tokenize command boundaries without treating quoted text or heredoc bodies as shell commands.
// A nudge, not a boundary: it fails open. Only a segment certain to print a file counts; uncommon shell forms may pass.
function bashFileRead(command) {
  if (typeof command !== 'string') return false
  const segments = [], words = [], heredocs = []
  let word = '', active = false, quote = '', redirect = null, quoted = false, outputElsewhere = false
  const flush = () => {
    if (!active) return
    if (redirect) {
      if (redirect.startsWith('<<') && redirect !== '<<<') heredocs.push({ delimiter: word, tabs: redirect === '<<-' })
      redirect = null
    } else if (words.length || quoted || !['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!'].includes(word)) words.push(word)
    word = ''; active = false; quoted = false
  }
  const segment = () => { flush(); if (words.length) segments.push({ args: words.splice(0), outputElsewhere }); outputElsewhere = false }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue }
    if (ch === '\\') { if (i + 1 < command.length) { if (command[i + 1] !== '\n') { word += command[i + 1]; active = true; quoted = true } i++ } continue }
    if (quote === '"') { if (ch === '"') quote = ''; else word += ch; continue }
    if (ch === "'" || ch === '"') { quote = ch; active = true; quoted = true; continue }
    // A comment starts only at a word boundary; its contents are not shell commands.
    if (ch === '#' && !active) {
      const end = command.indexOf('\n', i)
      if (end < 0) break
      i = end - 1; continue
    }
    if (ch === '\n') {
      segment()
      while (heredocs.length && i + 1 < command.length) {
        const end = command.indexOf('\n', i + 1)
        const lineEnd = end < 0 ? command.length : end
        const line = command.slice(i + 1, lineEnd)
        i = lineEnd
        if ((heredocs[0].tabs ? line.replace(/^\t+/, '') : line) === heredocs[0].delimiter) heredocs.shift()
      }
      continue
    }
    if (/\s/.test(ch)) { flush(); continue }
    if (ch === '<' || ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      // An adjacent numeric word is a file descriptor, not an operand.
      let fd = ''
      if (ch === '&') { fd = '&'; i++ }
      else if (active && !quoted && /^\d+$/.test(word)) { fd = word; word = ''; active = false } else flush()
      const start = i
      let op = ch
      while (i + 1 < command.length && (command[i + 1] === ch || (ch === '<' && op === '<<' && command[i + 1] === '-'))) op += command[++i]
      if (command[i + 1] === '&') {
        i++
        // `>&-` closes stdout: nothing is printed.
        if (command[i + 1] === '-' && command[start] === '>' && (fd === '' || fd === '1')) outputElsewhere = true
        if (/[0-9-]/.test(command[i + 1] ?? '')) while (/[0-9-]/.test(command[i + 1] ?? '')) i++
        else redirect = op
      }
      else redirect = op
      // Output sent to a file is not printed; the segment is not a read.
      if (redirect && command[start] === '>' && (fd === '' || fd === '1' || fd === '&')) outputElsewhere = true
      continue
    }
    // A segment piped onward may print only what the filter keeps (`cat f | wc -l`); it is not a read.
    if (ch === '|' && command[i + 1] !== '|') outputElsewhere = true
    if (';|&'.includes(ch)) { segment(); if (command[i + 1] === ch) i++; continue }
    if (ch === '(' || ch === ')') { segment(); continue }
    // Braces are reserved words only at a command boundary and when delimited.
    if ((ch === '{' || ch === '}') && !active && !words.length && !redirect &&
        (i + 1 === command.length || /[\s;|&()<>]/.test(command[i + 1]))) { segment(); continue }
    word += ch; active = true
  }
  segment()
  return segments.some(({ args, outputElsewhere }) => {
    if (outputElsewhere) return false
    while (args.length && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(args[0])) args.shift()
    const program = basename(args[0] ?? '')
    if (!['cat', 'head', 'tail', 'nl', 'sed'].includes(program)) return false
    let options = true, sedQuiet = false, sedScript = false, zeroCount = false
    const operands = []
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (options && arg === '--') { options = false; continue }
      if (options && arg.startsWith('-') && arg !== '-') {
        // Fail open on any option whose printing behaviour is not known (`cat --help f`, `cat -Z f`).
        const known = program === 'cat' ? false
          : program === 'head' || program === 'tail' ? /^(?:-\d+|-[qv]*(?:[nc]\d*)?|--(?:lines|bytes)(?:=.*)?|--(?:quiet|silent|verbose))$/.test(arg)
            : program === 'sed' ? /^(?:-[ne]+|-[n]*[ef].*|--quiet|--silent|--(?:expression|file)(?:=.*)?)$/.test(arg)
              : /^(?:-[bdfhilnsvw].*|--[a-z-]+(?:=.*)?)$/.test(arg)
        if (!known) return false
        // Short sed options after e/f/l belong to that option's argument, not the option cluster.
        const sedShort = program === 'sed' && /^-([^-efl]*)([efl])(.*)$/.exec(arg)
        if (program === 'sed' && (arg === '--quiet' || arg === '--silent' ||
            (sedShort ? sedShort[1].includes('n') : /^-[^-]*n/.test(arg)))) sedQuiet = true
        const values = program === 'sed' ? ['-e', '--expression', '-f', '--file', '-l', '--line-length']
          : program === 'head' || program === 'tail' ? ['-n', '-c', '--lines', '--bytes', '-s', '--sleep-interval', '--pid']
            : program === 'nl' ? ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w', '--body-numbering', '--section-delimiter', '--footer-numbering', '--header-numbering', '--line-increment', '--join-blank-lines', '--number-format', '--number-separator', '--starting-line-number', '--number-width'] : []
        if (program === 'sed' && ((sedShort && 'ef'.includes(sedShort[2])) || /^--(?:expression|file)(?:=|$)/.test(arg))) sedScript = true
        // A zero line or byte count prints nothing.
        if ((program === 'head' || program === 'tail') && (/^0+$/.test(/^-[^-]*[nc]$/.test(arg) || ['--lines', '--bytes'].includes(arg) ? args[i + 1] ?? '' : '') ||
            /^(?:-[^-]*[nc]|--(?:lines|bytes)=)0+$/.test(arg))) zeroCount = true
        if (values.includes(arg) || (sedShort && sedShort[3] === '') ||
            ((program === 'head' || program === 'tail') && /^-[^-]*[ncs]$/.test(arg))) i++
        continue
      }
      operands.push(arg)
    }
    if (zeroCount) return false
    // Fail open: sed counts only for the measured print scripts (`Np`, `A,Bp`), never for -e/-f scripts.
    if (program === 'sed' && (!sedQuiet || sedScript || !/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(operands.shift() ?? ''))) return false
    return operands.some((arg) => arg !== '-' && arg !== '')
  })
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

// Take the lock directory (blocking, bounded); the returned function releases it.
function acquireLock(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { mkdirSync(lock); break } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue } } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error('arm state is locked')
      sleep(25)
    }
  }
  return () => { try { rmdirSync(lock) } catch { /* already gone */ } }
}

// Concurrent hooks (parallel tool calls) read-modify-write one file, so they take turns.
async function withLock(lock, fn) {
  const release = acquireLock(lock)
  try { return await fn() } finally { release() }
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

const ADVISOR_REQUESTS_DIR = 'advisor-requests'
const ADVISOR_NOTES_DIR = 'advisor-notes'
const ADVISOR_ACCEPTED_DIR = 'advisor-accepted'

// Write-then-rename: a reader never sees half a file.
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// A tier-1 consult outlives the hook that asked for it: hand it to a detached worker and return at once.
// Nothing here may throw into the hook; a consult that could not start costs the seat nothing.
function startConsultWorker(config, env, request) {
  try {
    const pluginRoot = config.plugin_root
    const requestPath = join(config.state_dir, ADVISOR_REQUESTS_DIR, `${request.consultId}.json`)
    // The seat session and run that asked: the note it earns is only ever delivered back to them.
    writeAtomic(requestPath, JSON.stringify({ ...request, hook: config.hook_identity }))
    const cwd = config.cwd
    const worker = spawn(process.execPath, [SELF, 'advisor-consult', pluginRoot, requestPath], { cwd, env, detached: true, stdio: 'ignore' })
    worker.on('error', () => {})
    worker.unref()
  } catch (error) { process.stderr.write(`crew advisor consult not started: ${String(error?.message ?? error).slice(0, 300)}\n`) }
}

// CREW_PI_BIN when it names an absolute file, else the first absolute PATH entry holding a pi.
function resolveConsultBinary(env) {
  const named = env.CREW_PI_BIN
  if (typeof named === 'string' && isAbsolute(named) && existsSync(named)) return { command: named, args: [] }
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, 'pi')
    if (existsSync(candidate)) return { command: candidate, args: [] }
  }
  return { error: 'the pi executable could not be resolved to an absolute path' }
}

async function instantiate(name, env, cwd, outbox, launches) {
  if (name === 'readgate') return (await import('../pi/extensions/readgate.ts')).createReadGate({ env, cwd })
  if (name === 'skeletonread') return (await import('../pi/extensions/skeletonread.ts')).createSkeletonRead({ env, cwd })
  if (name === 'reminders') return (await import('../pi/extensions/reminders.ts')).createReminders({ env })
  if (name === 'builderloop') return (await import('../pi/extensions/builderloop.ts')).createBuilderLoop({ env, cwd })
  // Tier 1 asks a model and outlives a hook: the hook only starts the consult (a detached worker) and a later hook delivers its note.
  if (name === 'advisor') return (await import('../pi/extensions/advisor.ts')).createAdvisor({ env, deps: { cwd, resolveBinary: () => resolveConsultBinary(env), deferTier1Consult: (request) => { launches.push(request) }, send: (message) => { outbox.push(`Advisor note: ${String(message?.content ?? '')}`) } } })
  throw new Error(`unknown arm ${name}`)
}

function armEnv(config) {
  const env = { ...process.env, CREW_ROLE: config.role, CREW_FFF: config.fff === true ? '1' : '0' }
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
    || (own(config, 'fff') && typeof config.fff !== 'boolean')
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
    // Only an arm that actually started may steer, and a parser failure fails open.
    if (tool === 'bash' && (arms.readgate || arms.skeletonread) && await guard('readgate', () => bashFileRead(payload.tool_input?.command))) {
      return { hookEventName: name, permissionDecision: 'deny', permissionDecisionReason: 'Refusing Bash file read. Use the Read tool (file_path, offset, limit); use offset and limit for a range.' }
    }
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
    const readInput = tool === 'bash' ? bashRead(payload.tool_input?.command) : null
    for (const arm of config.arms) {
      // Preserve the existing raw cat byte cap before consulting the equivalent read.
      if (arm === 'readgate' && readInput && !own(readInput, 'offset')) {
        const rawVerdict = await guard(arm, () => arms[arm]?.onToolCall?.(event, ctx))
        if (rawVerdict?.block === true && rawVerdict.reason) { reason = rawVerdict.reason; break }
      }
      const view = readInput && (arm === 'readgate' || arm === 'skeletonread') ? { ...event, toolName: 'read', input: readInput } : event
      const verdict = await guard(arm, () => arms[arm]?.onToolCall?.(view, ctx))
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
  const readInput = tool === 'bash' ? bashRead(payload.tool_input?.command) : null
  const response = payload.tool_response
  const unsafeRead = failed || event.isError || response?.interrupted === true || (typeof response?.stderr === 'string' && response.stderr !== '')
  for (const arm of config.arms) {
    // builderloop's lane run after a successful edit is not carried; edit assist rides on PreToolUse instead.
    if (arm === 'builderloop' && (tool === 'edit' || tool === 'write')) continue
    const view = readInput && (arm === 'readgate' || arm === 'skeletonread')
      ? { ...event, toolName: 'read', input: readInput, isError: Boolean(unsafeRead) } : event
    const result = await guard(arm, () => (arms[arm]?.onToolResult ?? arms[arm]?.toolResult)?.(view, ctx))
    if (Array.isArray(result?.content) && !(view !== event && unsafeRead)) event.content = result.content
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

// Finished consults' notes for this seat session and run, claimed under the state lock before they join the outbox:
// a note leaves the disk exactly when it is handed to this call's added context, so no later call sees it again.
// Another session's note stays for its owner; a note from an earlier run of this session is stale and dropped.
// Returns what was claimed, so a call that cannot hand its context over can put the notes back.
function deliverAdvisorNotes(config, outbox, advisor, identity) {
  const claimed = []
  try {
    const dir = join(config.state_dir, ADVISOR_NOTES_DIR)
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
      try {
        const file = join(dir, name)
        const raw = readFileSync(file, 'utf8')
        const stored = JSON.parse(raw)
        if (!isObject(stored) || stored.session !== identity.session) continue
        const note = stored.note
        if (stored.run_start !== identity.run_start || typeof note !== 'string' || !note) { rmSync(file, { force: true }); continue }
        unlinkSync(file);
        claimed.push({ file, raw })
        advisor.mergeTier1Memory(stored.memory)
        outbox.push(`Advisor note: ${note}`)
      } catch { /* an unreadable note is skipped, never thrown into the hook */ }
    }
  } catch { /* no notes yet */ }
  return claimed
}

function restoreAdvisorNotes(claimed) {
  for (const { file, raw } of claimed) { try { writeAtomic(file, raw) } catch { /* the note is lost with the store */ } }
}

// One hook call: the output to print, or null. Throws are the caller's no-op.
export async function runHook(pluginRoot, raw) {
  const config = { ...readConfig(pluginRoot), plugin_root: pluginRoot }
  const payload = JSON.parse(raw)
  if (!isObject(payload) || typeof payload.session_id !== 'string' || !payload.session_id || !['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name)) return null
  try { process.chdir(config.cwd) } catch { /* the arms resolve against config.cwd themselves */ }
  const env = armEnv(config)
  const identity = { version: STATE_VERSION, seat: config.seat, session: payload.session_id, run_start: laneRunStart(config) }
  config.hook_identity = { session: identity.session, run_start: identity.run_start }
  const file = join(config.state_dir, `${createHash('sha256').update(payload.session_id).digest('hex').slice(0, 24)}.json`)
  mkdirSync(config.state_dir, { recursive: true })
  return withLock(`${file}.lock`, async () => {
    const state = loadState(file, identity)
    if (state === MALFORMED) { rmSync(file, { force: true }); return null }
    const before = JSON.stringify(state)
    const outbox = []
    const arms = {}
    // Consults this call asked for start only once the count that pays for them is saved: a call that cannot save starts none.
    const launches = []
    for (const name of config.arms) {
      try {
        arms[name] = await instantiate(name, env, config.cwd, outbox, launches)
        if (state.arms[name] !== undefined && typeof arms[name].importState === 'function') arms[name].importState(state.arms[name])
      } catch (error) {
        // An arm that cannot start, or whose stored state is not its own, is not run (and starts fresh next time); the others are.
        process.stderr.write(`crew arm ${name} unavailable: ${String(error?.message ?? error).slice(0, 300)}\n`)
        delete arms[name]
        delete state.arms[name]
      }
    }
    const claimed = arms.advisor && payload.hook_event_name === 'PreToolUse' ? deliverAdvisorNotes(config, outbox, arms.advisor, config.hook_identity) : []
    try {
      const output = await dispatch(config, payload, arms, state, outbox)
      for (const [name, arm] of Object.entries(arms)) if (typeof arm.exportState === 'function') state.arms[name] = arm.exportState()
      saveState(file, state, before)
      for (const request of launches) startConsultWorker(config, env, request)
      return output
    } catch (error) { restoreAdvisorNotes(claimed); throw error }
  })
}

// The detached worker: run one deferred consult to the end. A note it earns is written for a later hook to deliver.
async function runConsultWorker(pluginRoot, requestPath) {
  const config = readConfig(pluginRoot)
  const request = JSON.parse(readFileSync(requestPath, 'utf8'))
  try { process.chdir(config.cwd) } catch { /* the advisor resolves against config.cwd itself */ }
  const env = armEnv(config)
  const hook = isObject(request.hook) ? request.hook : {}
  let advisor
  const send = (message) => {
    // The claim and the dedupe memory it earned travel together, bound to the session and run that asked.
    try { writeAtomic(join(config.state_dir, ADVISOR_NOTES_DIR, `${request.consultId}.json`), JSON.stringify({ session: hook.session, run_start: hook.run_start ?? null, note: String(message?.content ?? ''), memory: advisor?.tier1Memory() })) } catch { /* the journal row stands; the seat just never hears it */ }
  }
  // Consults in flight together are judged one at a time against what the others already had accepted, as the pi
  // advisor judges its own: the accepted claims and updates are kept per session and run, under their own lock.
  const ledger = join(config.state_dir, ADVISOR_ACCEPTED_DIR, `${createHash('sha256').update(String(hook.session)).digest('hex').slice(0, 24)}.json`)
  const exclusiveTier1Acceptance = (fn) => {
    mkdirSync(dirname(ledger), { recursive: true })
    const release = acquireLock(`${ledger}.lock`)
    try {
      try {
        const stored = JSON.parse(readFileSync(ledger, 'utf8'))
        if (isObject(stored) && stored.session === hook.session && stored.run_start === (hook.run_start ?? null)) advisor.mergeTier1Memory(stored.memory)
      } catch { /* no ledger yet */ }
      const accepted = fn()
      if (accepted) { try { writeAtomic(ledger, JSON.stringify({ session: hook.session, run_start: hook.run_start ?? null, memory: advisor.tier1Memory() })) } catch { /* the note stands */ } }
      return accepted
    } finally { release() }
  }
  advisor = (await import('../pi/extensions/advisor.ts')).createAdvisor({ env, deps: { cwd: config.cwd, send, exclusiveTier1Acceptance, resolveBinary: () => resolveConsultBinary(env) } })
  try { await advisor.runTier1Consult(request) } finally { try { rmSync(requestPath, { force: true }) } catch { /* left behind */ } }
}

async function main() {
  const [command, pluginRoot, requestPath] = process.argv.slice(2)
  if (command === 'advisor-consult' && pluginRoot && requestPath) {
    try { await runConsultWorker(pluginRoot, requestPath) } catch (error) {
      process.stderr.write(`crew advisor consult failed: ${String(error?.message ?? error).slice(0, 300)}\n`)
    }
    process.exit(0)
  }
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
