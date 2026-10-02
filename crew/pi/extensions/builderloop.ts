// The builder-seat result hook runs the planner's fenced Node lane after successful edits/writes,
// and journals failed edits with optional bounded, file-derived repair hints.
//
// Why .ts: pi loads extensions directly through jiti and this checkout imports
// the file with Node's erasable type stripping. This file uses only erasable
// syntax and node:-only imports; it has no runtime dependency on pi or the repo.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const EDIT_ASSIST_ENV = 'CREW_EDIT_ASSIST'
export const EDIT_FAILURE_CAUSES = Object.freeze(['not-unique', 'indentation', 'never-seen', 'partly-seen', 'seen-stale', 'other'])
export const EDIT_FAILURE_ABSENT_REASONS = Object.freeze(['file-unreadable', 'file-too-large'])
// lean: 2 MiB file reads; raise when real edit targets routinely exceed this bound
export const EDIT_FILE_CAP_BYTES = 2 * 1024 * 1024
// lean: 512 KiB rolling result corpus; use indexed storage when corpus volume justifies it
export const EDIT_CORPUS_CAP_BYTES = 512 * 1024
export const EDIT_HINT_CAP_BYTES = 8 * 1024

const READ_CAP_BYTES = 64 * 1024
const JOURNAL_CAP_BYTES = READ_CAP_BYTES
const MAX_RETURN_ENTRIES = 4096
const MAX_FENCE_ENTRIES = 512
const MAX_FENCE_PATH_BYTES = 1024
const MAX_COMMAND_BYTES = 16 * 1024
const MAX_METADATA_BYTES = 512
const MAX_METADATA_TESTS = 64
const TAIL_BYTES = 4 * 1024
const DEFAULT_DEADLINE_MS = 30_000
const DEFAULT_GRACE_MS = 250
const DEFAULT_POLL_MS = 25
const DEFAULT_POLL_MAX = 400
const FAILURE_REASONS = new Set(['crash', 'timeout', 'interrupted'])
const TEST_PATH = /\.test\.(?:mjs|js|ts)$/
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/
const RUN_START_EVENT = 'run-start'
const RERUN_REFUSAL_RULE = 'builder-rerun-refusal'

const defaultRead = (path, encoding) => readFileSync(path, encoding)
const defaultAppend = (path, text) => appendFileSync(path, text)
const defaultNow = () => new Date().toISOString()

function bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

function dropPassingLines(text) {
  const raw = typeof text === 'string' ? text : ''
  // lean: retain one reporter output; stream segments if test-output volume becomes material
  const segments = raw.match(/[^\n]*\n|[^\n]+$/g) || []
  const remove = new Set()
  const suites = new Map()
  const subtests = new Map()
  const plainAt = (index) => segments[index].replace(/\x1b\[[0-9;]*m/g, '').replace(/\r?\n$/, '')
  for (let i = 0; i < segments.length; i += 1) {
    const plain = plainAt(i)
    const indent = plain.match(/^\s*/)[0].length
    if (/^\s*▶ /.test(plain)) suites.set(indent, i)
    if (/^\s*# Subtest:/.test(plain)) subtests.set(indent, i)
    if (/^\s*✔ /.test(plain)) remove.add(i)
    if (/^\s*✔ /.test(plain)) {
      if (suites.has(indent)) { remove.add(suites.get(indent)); suites.delete(indent) }
      if (subtests.has(indent)) subtests.delete(indent)
    }
    if (/^\s*ok \d+(?:\s|$)/.test(plain)) {
      remove.add(i)
      if (subtests.has(indent)) { remove.add(subtests.get(indent)); subtests.delete(indent) }
      let yamlEnd = -1
      let yamlStarted = false
      for (let k = i + 1; k < segments.length; k += 1) {
        const yaml = plainAt(k)
        const yamlIndent = yaml.match(/^\s*/)[0].length
        if (yaml.trim() && yamlIndent <= indent) break
        if (yamlIndent > indent && /^\s*---$/.test(yaml)) yamlStarted = true
        if (yamlStarted && yamlIndent > indent && /^\s*\.\.\.$/.test(yaml)) { yamlEnd = k; break }
      }
      if (yamlEnd >= 0) for (let k = i + 1; k <= yamlEnd; k += 1) remove.add(k)
    }
    if (/^\s*not ok \d+(?:\s|$)/.test(plain)) subtests.delete(indent)
  }
  return segments.filter((_, index) => !remove.has(index)).join('')
}

function boundedText(value, cap = MAX_METADATA_BYTES) {
  const text = String(value ?? '')
  if (bytes(text) <= cap) return text
  const decoder = new StringDecoder('utf8')
  return decoder.write(Buffer.from(text, 'utf8').subarray(0, cap))
}

function slash(value) {
  return String(value ?? '').replaceAll('\\', '/')
}

function normalizeFencePath(value) {
  let path = slash(value).trim()
  if (path.startsWith('./')) path = path.replace(/^\.\/+/, '')
  return path
}

function epochMilliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function optionsFor(value, extra = {}) {
  if (typeof value === 'string') return { taskDir: value, deps: { ...extra } }
  const input = value && typeof value === 'object' ? value : {}
  return { ...input, deps: { ...(input.deps || {}), ...extra } }
}

function boundedRead(path, read) {
  let raw
  try { raw = read(path, 'utf8') } catch { return null }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  if (bytes(text) > READ_CAP_BYTES) return null
  return text
}

function runStartFrom(text) {
  let latest = null
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.event !== RUN_START_EVENT) continue
    const at = epochMilliseconds(row.at ?? row.started_at ?? row.run_started_at ?? row.timestamp)
    // The run id is the SAME authority the driver scopes returns by (crew/crew.mjs runReturnsDir):
    // returns/<run_id>/dN.planner.json. A run-start without one names no directory to read.
    // `.` and `..` pass a character-class check and would read returns/ itself or escape it (Sol, #1399).
    const runId = typeof row.run_id === 'string' && /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(row.run_id) ? row.run_id : null
    if (at !== null) latest = { at, runId }
  }
  return latest
}

function bytesBuffer(raw) {
  try { return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8') } catch { return null }
}

function bufferText(buffer) {
  const decoder = new StringDecoder('utf8')
  return decoder.end(buffer)
}

function tailRunStart(buffer, partial) {
  let tail = buffer
  if (partial) {
    const newline = tail.indexOf(0x0a)
    tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1)
  }
  return runStartFrom(bufferText(tail))
}

function lastRunStart(size, readWindow) {
  if (!Number.isSafeInteger(size) || size < 0 || typeof readWindow !== 'function') return null
  let end = size
  while (end > 0) {
    const start = Math.max(0, end - JOURNAL_CAP_BYTES)
    const length = end - start
    const window = readWindow(start, length)
    if (!Buffer.isBuffer(window) || window.length !== length) return null
    let partial = false
    if (start > 0) {
      const previous = readWindow(start - 1, 1)
      if (!Buffer.isBuffer(previous) || previous.length !== 1) return null
      partial = previous[0] !== 0x0a
    }
    const anchor = tailRunStart(window, partial)
    if (anchor !== null) return anchor
    if (!partial) {
      end = start
      continue
    }
    const newline = window.indexOf(0x0a)
    const nextEnd = newline < 0 ? start : start + newline + 1
    end = nextEnd < end ? nextEnd : start
  }
  return null
}

function runStartFromJournalBytes(raw) {
  const journal = bytesBuffer(raw)
  if (journal === null) return null
  return lastRunStart(journal.length, (position, length) => journal.subarray(position, position + length))
}

function journalSize(path, deps) {
  try {
    const stat = (deps.stat || deps.statSync || statSync)(path)
    const size = Number(stat?.size)
    return Number.isSafeInteger(size) && size >= 0 ? size : null
  } catch { return null }
}

function journalWindow(path, position, length, deps) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || length > JOURNAL_CAP_BYTES) return null
  const open = deps.openSync || openSync
  const read = deps.readSync || readSync
  const close = deps.closeSync || closeSync
  let descriptor = null
  try {
    descriptor = open(path, 'r')
    const window = Buffer.allocUnsafe(length)
    const count = Number(read(descriptor, window, 0, length, position))
    if (!Number.isInteger(count) || count < 0 || count > length) return null
    return window.subarray(0, count)
  } catch { return null } finally {
    if (Number.isInteger(descriptor)) {
      try { close(descriptor) } catch {}
    }
  }
}

function journalRunStart(path, deps, read) {
  // Dependency-backed readers are test seams; production uses positioned reads so a
  // long journal never materializes in memory. Both paths walk bounded windows
  // backward from EOF until they find the last run-start anchor.
  if (deps.readFile || deps.readFileSync) {
    let raw
    try { raw = read(path, 'utf8') } catch { return null }
    return runStartFromJournalBytes(raw)
  }
  const size = journalSize(path, deps)
  if (size === null) return null
  return lastRunStart(size, (position, length) => journalWindow(path, position, length, deps))
}

function candidateMtime(path, deps) {
  try {
    const value = deps.fileMtime
      ? deps.fileMtime(path)
      : (deps.stat || deps.statSync || statSync)(path).mtimeMs
    const numeric = typeof value === 'object' && value !== null ? Number(value.mtimeMs) : Number(value)
    return Number.isFinite(numeric) ? numeric : null
  } catch { return null }
}

function plannerEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.status !== 'done' || raw.role !== 'planner') return null
  const details = raw.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  if (!Array.isArray(details.files_in_scope) || details.files_in_scope.length > MAX_FENCE_ENTRIES) return null
  const files = []
  for (const entry of details.files_in_scope) {
    if (typeof entry !== 'string') return null
    const clean = normalizeFencePath(entry)
    if (!clean || bytes(clean) > MAX_FENCE_PATH_BYTES || clean.startsWith('/') || clean.includes('\0')) return null
    const segments = clean.split('/')
    if (segments.some((segment) => segment === '..' || segment === '.')) return null
    files.push(clean)
  }
  if (typeof details.validation_lane !== 'string' || !details.validation_lane.trim()) return null
  if (bytes(details.validation_lane) > MAX_COMMAND_BYTES) return null
  if (typeof details.gate_cmd !== 'string' || !details.gate_cmd.trim()) return null
  if (bytes(details.gate_cmd) > MAX_COMMAND_BYTES) return null
  return {
    files_in_scope: files,
    validation_lane: details.validation_lane.trim(),
    gate_cmd: details.gate_cmd.trim(),
  }
}

// This reader is deliberately called at every tool result. A builder process
// boots before d<N>.planner.json exists, so an absent first read must not become
// a cached permanent absence. The journal's last run-start is the only run
// boundary; candidate mtimes older than it are ignored.
export function loadPlannerContext(value = {}, extraDeps = {}) {
  const input = optionsFor(value, extraDeps)
  const deps = input.deps || {}
  const taskDir = String(input.taskDir || input.env?.CREW_TASK_DIR || '')
  if (!taskDir) return null
  const read = deps.readFile || deps.readFileSync || defaultRead
  const journalPath = join(dirname(taskDir), 'journal.jsonl')
  const anchor = journalRunStart(journalPath, deps, read)
  if (anchor === null || anchor.runId === null) return null
  // Returns have been run-scoped since 2fac235d (2026-09-13). Scanning returns/ itself found only
  // run-id directories, matched nothing, and this hook was silently inert for five days.
  const returnsDir = join(dirname(taskDir), 'returns', anchor.runId)
  const runStart = anchor.at
  let names
  try { names = (deps.readDir || deps.readdirSync || readdirSync)(returnsDir) } catch { return null }
  if (!Array.isArray(names) || names.length > MAX_RETURN_ENTRIES) return null
  const candidates = []
  for (const name of names) {
    const match = /^d(\d+)\.planner\.json$/.exec(String(name))
    if (!match) continue
    const path = join(returnsDir, String(name))
    const mtime = candidateMtime(path, deps)
    if (mtime === null || mtime < runStart) continue
    candidates.push({ number: Number(match[1]), path })
  }
  candidates.sort((left, right) => right.number - left.number)
  const candidate = candidates[0]
  if (!candidate) return null
  const text = boundedRead(candidate.path, read)
  if (text === null) return null
  let envelope
  try { envelope = JSON.parse(text) } catch { return null }
  return plannerEnvelope(envelope)
}

function targetRelative(cwd, inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) return null
  if (inputPath.includes('\0')) return null
  let root
  let absolute
  try {
    root = resolve(String(cwd || ''))
    absolute = resolve(root, inputPath)
  } catch { return null }
  let candidate
  try { candidate = slash(relative(root, absolute)) } catch { return null }
  if (!candidate || candidate === '..' || candidate.startsWith('../') || isAbsolute(candidate)) return null
  return candidate
}

function inFence(files, target) {
  if (!Array.isArray(files) || typeof target !== 'string') return false
  return files.some((entry) => {
    const fence = normalizeFencePath(entry)
    return fence.endsWith('/') ? target.startsWith(fence) : target === fence
  })
}

function testOperand(value) {
  if (typeof value !== 'string' || !value || value.startsWith('-')) return null
  if (value.includes('\\') || value.includes('\0') || /[;&|<>`$\r\n]/.test(value)) return null
  if (isAbsolute(value)) return null
  const clean = value.replace(/^\.\/+/, '')
  if (!clean || !SAFE_PATH.test(clean) || !TEST_PATH.test(clean)) return null
  const segments = clean.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return clean
}

// lean: a second decoder until #1406 lands; import shellWords then
function decodeShellWords(command) {
  if (typeof command !== 'string' || bytes(command) > MAX_COMMAND_BYTES) return null
  const words = []
  let word = ''
  let haveWord = false
  let mode = 'bare'
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (mode === 'single') {
      if (character === "'") mode = 'bare'
      else word += character
      haveWord = true
      continue
    }
    if (mode === 'double') {
      if (character === '"') { mode = 'bare'; haveWord = true; continue }
      if (character === '\\') {
        const next = command[index + 1]
        if (next === '"' || next === '\\') { word += next; index += 1 }
        else word += character
      } else word += character
      haveWord = true
      continue
    }
    if (/\s/.test(character)) {
      if (haveWord) { words.push(word); word = ''; haveWord = false }
      continue
    }
    if (character === "'") { mode = 'single'; haveWord = true; continue }
    if (character === '"') { mode = 'double'; haveWord = true; continue }
    if (character === '\\') {
      const next = command[index + 1]
      if (next === undefined) return null
      word += next; index += 1; haveWord = true; continue
    }
    word += character
    haveWord = true
  }
  if (mode !== 'bare') return null
  if (haveWord) words.push(word)
  return words
}

function wordsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((word, index) => word === right[index])
}

function defaultMeasureTree(cwd, deps = {}) {
  const spawnSync = deps.spawnSync || nodeSpawnSync
  const lstat = deps.lstatSync || lstatSync
  const runGit = (args) => {
    let result
    try { result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) } catch (error) { return { ok: false, error } }
    const error = result?.error
    if (error || result?.status !== 0 || result?.signal) return { ok: false, error, result }
    const stdout = result.stdout === undefined || result.stdout === null
      ? ''
      : Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout)
    return { ok: true, stdout }
  }
  const gitDir = runGit(['rev-parse', '--git-dir'])
  if (!gitDir.ok) return { measured: false, cause: gitDir.error?.code === 'ENOENT' ? 'git-missing' : 'not-a-repository', detail: gitDir.error?.message || gitDir.result?.stderr || '' }
  const tracked = runGit(['ls-files', '-v'])
  if (!tracked.ok) return { measured: false, cause: 'git-failed', detail: tracked.error?.message || tracked.result?.stderr || '' }
  if (tracked.stdout.split('\n').some((line) => line && line[0] !== 'H')) return { measured: false, cause: 'assumed-or-skip-worktree', detail: tracked.stdout }
  const staged = runGit(['ls-files', '--stage'])
  if (!staged.ok) return { measured: false, cause: 'git-failed', detail: staged.error?.message || staged.result?.stderr || '' }
  if (staged.stdout.split('\n').some((line) => /^160000\s/.test(line))) return { measured: false, cause: 'submodule', detail: staged.stdout }
  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) return { measured: false, cause: 'git-failed', detail: status.error?.message || status.result?.stderr || '' }
  const diff = runGit(['diff', 'HEAD', '--'])
  if (!diff.ok) return { measured: false, cause: 'git-failed', detail: diff.error?.message || diff.result?.stderr || '' }
  const head = runGit(['rev-parse', 'HEAD'])
  if (!head.ok || !head.stdout.trim()) return { measured: false, cause: 'git-failed', detail: head.error?.message || head.result?.stderr || '' }
  const untracked = []
  const statusParts = status.stdout.split('\0')
  for (const part of statusParts) {
    if (!part.startsWith('?? ')) continue
    const rel = part.slice(3)
    if (!rel) return { measured: false, cause: 'unreadable', detail: 'empty untracked path' }
    let stat
    try { stat = lstat(join(cwd, rel)) } catch (error) { return { measured: false, cause: 'unreadable', detail: error?.message || String(error) } }
    if (stat?.isSymbolicLink?.()) return { measured: false, cause: 'untracked-symlink', detail: rel }
    const size = Number(stat?.size)
    const mtimeMs = Number(stat?.mtimeMs)
    if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return { measured: false, cause: 'unreadable', detail: rel }
    untracked.push([rel, size, mtimeMs])
  }
  const payload = { status: status.stdout, diff: diff.stdout, head: head.stdout.trim(), untracked }
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return { measured: true, digest }
}

function recordUnmeasured(path, cause, appendFile, now) {
  try {
    const at = (() => { try { return now() } catch { return defaultNow() } })()
    appendFile(path, `${JSON.stringify({ at, builder_loop_unmeasured: { cause } })}\n`)
  } catch {}
}

function recordRefusal(path, reason, words, appendFile, now) {
  try {
    const at = (() => { try { return now() } catch { return defaultNow() } })()
    appendFile(path, `${JSON.stringify({ at, builder_loop_refusal: { rule: RERUN_REFUSAL_RULE, command: words, previous: reason } })}\n`)
  } catch {}
}

export function fencedNodeTestCommand(current) {
  const lane = current && typeof current === 'object' ? current.validation_lane : null
  if (typeof lane !== 'string' || !lane.trim() || bytes(lane) > MAX_COMMAND_BYTES) return null
  if (/[;&|<>`$\r\n]/.test(lane)) return null
  const parts = lane.trim().split(/\s+/)
  if (parts.length < 3 || parts[0] !== 'node' || parts[1] !== '--test') return null
  const tests = []
  for (const operand of parts.slice(2)) {
    const test = testOperand(operand)
    if (!test) return null
    if (inFence(current.files_in_scope, test) && !tests.includes(test)) tests.push(test)
  }
  if (!tests.length) return null
  return { bin: process.execPath, args: ['--test', ...tests] }
}

function errorWithReason(reason, cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause ?? reason))
  try { error.reason = reason } catch {}
  try { error.builderLoopReason = reason } catch {}
  return error
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function streamTail() {
  let retained = Buffer.alloc(0)
  return {
    push(value) {
      let chunk
      try { chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8') } catch { return }
      if (!chunk.length) return
      if (chunk.length >= TAIL_BYTES) retained = chunk.subarray(chunk.length - TAIL_BYTES)
      else {
        const combined = Buffer.concat([retained, chunk])
        retained = combined.length > TAIL_BYTES ? combined.subarray(combined.length - TAIL_BYTES) : combined
      }
    },
    text() {
      const decoder = new StringDecoder('utf8')
      return decoder.end(retained)
    },
  }
}

function runnerSettings(value, extraDeps = {}) {
  const input = value && typeof value === 'object' ? value : {}
  const deps = { ...(input.deps || {}), ...extraDeps }
  for (const key of ['spawn', 'kill', 'setTimeout', 'clearTimeout', 'deadlineMs', 'timeoutMs', 'graceMs', 'pollMs', 'pollMax', 'now']) {
    if (input[key] !== undefined) deps[key] = input[key]
  }
  return {
    cwd: input.cwd || input.ctx?.cwd || process.cwd(),
    signal: input.signal || input.ctx?.signal || null,
    deps,
    deadlineMs: positiveNumber(input.deadlineMs ?? input.timeoutMs ?? deps.deadlineMs ?? deps.timeoutMs, DEFAULT_DEADLINE_MS),
    graceMs: Math.min(positiveNumber(input.graceMs ?? deps.graceMs, DEFAULT_GRACE_MS), DEFAULT_GRACE_MS),
    pollMs: positiveNumber(input.pollMs ?? deps.pollMs, DEFAULT_POLL_MS),
    pollMax: Math.max(1, Math.trunc(positiveNumber(input.pollMax ?? deps.pollMax, DEFAULT_POLL_MAX))),
  }
}

// The runner is deliberately a Promise over the child CLOSE event, not EXIT:
// close is the point at which both piped streams have drained. The group probe
// then supplies the second ownership fact, so a detached descendant cannot outlive
// the result that reports it.
export function runNodeTests(command, value = {}, extraDeps = {}) {
  const settings = runnerSettings(value, extraDeps)
  const deps = settings.deps
  const spawn = deps.spawn || nodeSpawn
  const setTimer = deps.setTimeout || setTimeout
  const clearTimer = deps.clearTimeout || clearTimeout
  const tail = streamTail()

  return new Promise((resolveResult, rejectResult) => {
    let child
    try {
      const spawnOptions = {
        cwd: settings.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }
      const childEnv = { ...(deps.env || process.env) }
      delete childEnv.NODE_TEST_CONTEXT
      if (deps.env || Object.hasOwn(process.env, 'NODE_TEST_CONTEXT')) spawnOptions.env = childEnv
      child = spawn(command?.bin, command?.args, spawnOptions)
    } catch (error) {
      rejectResult(errorWithReason('crash', error))
      return
    }

    if (!child || typeof child.on !== 'function') {
      rejectResult(errorWithReason('crash', new Error('builder test runner returned no child process')))
      return
    }

    const pid = Number(child.pid || 0)
    let parentClosed = false
    let parentCode = null
    let parentSignal = null
    let childError = null
    let closedReason = null
    let terminationRequested = false
    let settled = false
    let polls = 0
    let deadlineTimer = null
    let graceTimer = null
    let pollTimer = null
    let abortListener = null

    const remove = (target, event, listener) => {
      try { target?.removeListener?.(event, listener) } catch {}
    }
    const clear = (timer) => {
      if (timer !== null) {
        try { clearTimer(timer) } catch {}
      }
    }
    const unref = (timer) => { try { timer?.unref?.() } catch {} }
    const groupSignal = (signal) => {
      if (!pid) return
      if (deps.kill) {
        try { deps.kill(-child.pid, signal) } catch {}
      } else if (signal === 'SIGTERM') {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }
    }
    const groupState = () => {
      if (!pid) return 'gone'
      try {
        if (deps.kill) deps.kill(-child.pid, 0)
        else process.kill(-child.pid, 0)
        return 'alive'
      } catch (error) {
        if (error?.code === 'ESRCH') return 'gone'
        if (error?.code === 'EPERM') return 'alive'
        return 'unknown'
      }
    }
    const cleanup = () => {
      clear(deadlineTimer); deadlineTimer = null
      clear(graceTimer); graceTimer = null
      clear(pollTimer); pollTimer = null
      if (settings.signal && abortListener) {
        try { settings.signal.removeEventListener?.('abort', abortListener) } catch {}
      }
      remove(child, 'close', onClose)
      remove(child, 'error', onError)
      remove(child.stdout, 'data', onStdout)
      remove(child.stderr, 'data', onStderr)
      try { child.stdout?.destroy?.() } catch {}
      try { child.stderr?.destroy?.() } catch {}
      try { child.unref?.() } catch {}
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) rejectResult(error)
      else resolveResult(result)
    }
    const finishAfterOwnership = () => {
      if (settled || !parentClosed) return
      if (childError) { finish(errorWithReason('crash', childError)); return }
      if (closedReason) { finish(errorWithReason(closedReason, new Error(closedReason))); return }
      if (parentSignal || parentCode === null) {
        finish(errorWithReason('crash', new Error(parentSignal ? `builder test ended by ${parentSignal}` : 'builder test ended without an exit code')))
        return
      }
      finish(null, { code: parentCode, signal: parentSignal, tail: tail.text() })
    }
    const pollGroup = () => {
      if (settled) return
      const state = groupState()
      if (state === 'gone') {
        clear(graceTimer); graceTimer = null
        if (parentClosed) finishAfterOwnership()
        else {
          polls += 1
          if (polls >= settings.pollMax) {
            finish(errorWithReason(closedReason || 'crash', new Error('builder test parent did not close after its process group disappeared')))
            return
          }
          schedulePoll()
        }
        return
      }
      polls += 1
      if (polls >= settings.pollMax) {
        groupSignal('SIGKILL')
        finish(errorWithReason(closedReason || 'crash', new Error('builder test process group did not disappear')))
        return
      }
      schedulePoll()
    }
    const schedulePoll = () => {
      if (settled || pollTimer !== null) return
      try { pollTimer = setTimer(() => { pollTimer = null; pollGroup() }, settings.pollMs) } catch { pollTimer = null }
      unref(pollTimer)
    }
    const beginPoll = () => {
      if (settled) return
      pollGroup()
    }
    const requestTermination = (reason) => {
      if (settled || terminationRequested) return
      terminationRequested = true
      closedReason = reason
      groupSignal('SIGTERM')
      try {
        graceTimer = setTimer(() => {
          graceTimer = null
          if (settled) return
          groupSignal('SIGKILL')
          beginPoll()
        }, settings.graceMs)
        unref(graceTimer)
      } catch { graceTimer = null; groupSignal('SIGKILL'); beginPoll() }
      beginPoll()
    }
    const onStdout = (chunk) => { tail.push(chunk) }
    const onStderr = (chunk) => { tail.push(chunk) }
    const onError = (error) => {
      if (terminationRequested) return
      childError = childError || errorWithReason('crash', error)
      if (!parentClosed) requestTermination('crash')
    }
    function onClose(code, signal) {
      if (parentClosed) return
      parentClosed = true
      parentCode = code === undefined ? null : code
      parentSignal = signal || null
      clear(deadlineTimer); deadlineTimer = null
      beginPoll()
    }

    child.stdout?.on?.('data', onStdout)
    child.stderr?.on?.('data', onStderr)
    child.on('error', onError)
    child.on('close', onClose)

    if (settings.signal) {
      abortListener = () => requestTermination('interrupted')
      if (settings.signal.aborted) requestTermination('interrupted')
      else {
        try { settings.signal.addEventListener?.('abort', abortListener, { once: true }) } catch {}
      }
    }
    if (!terminationRequested) {
      try {
        deadlineTimer = setTimer(() => {
          deadlineTimer = null
          requestTermination('timeout')
        }, settings.deadlineMs)
        unref(deadlineTimer)
      } catch { requestTermination('timeout') }
    }
  })
}

function laneResultPart(result, args) {
  const tests = Array.isArray(args) ? args.slice(1).map((value) => String(value)) : []
  const status = result.code === 0 ? 'PASS' : 'FAIL'
  const exit = result.code === null || result.code === undefined ? 'exit unknown' : `exit ${result.code}`
  const signal = result.signal ? ` signal ${result.signal}` : ''
  const header = `Builder fenced Node lane ${status}: node --test ${tests.join(' ')} (${exit}${signal})`
  const text = `${header}\n${dropPassingLines(result.tail)}`
  return { type: 'text', text }
}

function failureReason(error) {
  const reason = error?.reason || error?.builderLoopReason
  return FAILURE_REASONS.has(reason) ? reason : 'crash'
}

function preserveAfterFailure(error, recordFailure, metadata) {
  const reason = failureReason(error)
  metadata.reason = reason
  try { recordFailure(metadata) } catch { /* instrumentation is best effort */ }
  return undefined
}

function metadataFor({ role, target, tests }) {
  return {
    role: boundedText(role, MAX_METADATA_BYTES),
    target: boundedText(target, MAX_METADATA_BYTES),
    tests: (Array.isArray(tests) ? tests : []).slice(0, MAX_METADATA_TESTS).map((test) => boundedText(test, MAX_METADATA_BYTES)),
    reason: null,
  }
}

function currentRole(env) {
  return String(env?.CREW_ROLE || '')
}

function eligibleTestWords(words, current) {
  if (!Array.isArray(words) || words.length < 2) return false
  const program = String(words[0]).split('/').at(-1)
  if (program !== 'node' || !words.includes('--test')) return false
  let operands = 0
  for (const word of words.slice(1)) {
    if (word.startsWith('-')) continue
    const operand = testOperand(word)
    if (!operand || !inFence(current?.files_in_scope, operand)) return false
    operands += 1
  }
  return operands > 0
}

export function createBuilderLoop(value = {}) {
  const input = value && typeof value === 'object' ? value : {}
  const deps = input.deps || {}
  const env = input.env || process.env
  const role = currentRole(env)
  const taskDir = String(input.taskDir || deps.taskDir || env?.CREW_TASK_DIR || '')
  const cwdDefault = input.cwd || deps.cwd || process.cwd()
  const loadContext = input.loadPlannerContext || deps.loadPlannerContext || loadPlannerContext
  const runTests = input.runNodeTests || deps.runNodeTests || runNodeTests
  const appendFile = deps.appendFile || deps.appendFileSync || defaultAppend
  const readFile = deps.readFile || deps.readFileSync || defaultRead
  const statFile = deps.stat || deps.statSync || statSync
  const now = deps.now || defaultNow
  const measureTree = deps.measureTree || ((cwd) => defaultMeasureTree(cwd, deps))
  const journalPath = join(dirname(taskDir), 'journal.jsonl')
  const contextDeps = deps.contextDeps || deps
  const runnerDeps = deps.runnerDeps || deps

  const recordFailure = deps.recordFailure || ((metadata) => {
    const payload = { ...metadata, tests: [...metadata.tests] }
    const row = { at: (() => { try { return now() } catch { return defaultNow() } })(), builder_loop_failure: payload, ...payload }
    appendFile(journalPath, `${JSON.stringify(row)}\n`)
  })

  let last = null
  const corpus = []
  let corpusBytes = 0
  let currentId = null

  function onBeforeAgentStart(event) {
    const first = String(event?.prompt || event?.text || '').split(/\r?\n/, 1)[0]
    const parsed = /^ASSIGNMENT\s+([^\s:]+):/.exec(first); const assignment = parsed && { id: parsed[1] }
    if (assignment && assignment.id !== currentId) corpus.length = 0
    if (assignment && assignment.id !== currentId) corpusBytes = 0
    if (assignment) currentId = assignment.id
    return undefined
  }

  function saveCorpus(event) {
    for (const part of Array.isArray(event?.content) ? event.content : []) {
      if (part?.type !== 'text' || typeof part.text !== 'string') continue
      corpus.push(part.text)
      corpusBytes += bytes(part.text)
      while (corpus.length && corpusBytes > EDIT_CORPUS_CAP_BYTES) corpusBytes -= bytes(corpus.shift())
    }
  }

  function onToolCall(event, ctx) {
    try {
      if (role !== 'builder' || event?.toolName !== 'bash') return undefined
      const raw = event?.input?.command
      if (typeof raw !== 'string') return undefined
      const words = decodeShellWords(raw)
      if (words === null) return undefined
      const loaded = loadContext({ taskDir, env, deps: contextDeps })
      if (!loaded || typeof loaded !== 'object') return undefined
      const laneWords = []
      if (fencedNodeTestCommand(loaded)) {
        const decodedLane = decodeShellWords(loaded.validation_lane)
        if (decodedLane) laneWords.push(decodedLane)
      }
      const decodedGate = decodeShellWords(loaded.gate_cmd)
      if (decodedGate) laneWords.push(decodedGate)
      const eligible = laneWords.some((candidate) => wordsEqual(candidate, words)) || eligibleTestWords(words, loaded)
      if (!eligible) return undefined
      const cwd = ctx?.cwd || cwdDefault
      const fingerprint = measureTree(cwd)
      if (!fingerprint || !fingerprint.measured) {
        recordUnmeasured(journalPath, fingerprint.cause, appendFile, now); return undefined
      }
      if (last !== null) {
        const sameWords = wordsEqual(last.words, words)
        const sameTree = last.digest === fingerprint.digest
        if (sameWords && sameTree) {
          const reason = RERUN_REFUSAL_RULE + ': rerun of ' + last.raw
          recordRefusal(journalPath, reason, words, appendFile, now)
          return { block: true, reason }
        }
      }
      last = { words, digest: fingerprint.digest, raw, toolName: event.toolName }
      return undefined
    } catch { return undefined }
  }

  async function onToolResult(event, ctx) {
    if (role === 'builder' && event?.toolName === 'bash') {
      saveCorpus(event)
      const command = typeof event?.input?.command === 'string' ? event.input.command : ''
      const content = event?.content
      if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
        const visible = content[0].text
        const nodeTestCommand = /\bnode\b[\s\S]*?(?:^|\s)--test(?:\s|$)/.test(command)
        const testSummary = /^(?:ℹ|#) tests \d+\b/m.test(visible.replace(/\x1b\[[0-9;]*m/g, ''))
        if (nodeTestCommand && testSummary) {
          let source = visible
          const fullOutputPath = event.details?.fullOutputPath
          if (typeof fullOutputPath === 'string') {
            try {
              const stats = statFile(fullOutputPath)
              if (Number.isFinite(stats?.size) && stats.size <= 8 * 1024 * 1024) {
                const full = readFile(fullOutputPath, 'utf8')
                if (typeof full === 'string' && bytes(full) <= 8 * 1024 * 1024) {
                  const candidate = dropPassingLines(full)
                  if (bytes(candidate) <= 51200) source = full
                }
              }
            } catch {}
          }
          const filtered = dropPassingLines(source)
          const ansi = source.replace(/\x1b\[[0-9;]*m/g, '')
          const passingCount = ansi.split(/\r?\n/).filter((line) => /^\s*(?:✔ |ok \d+(?:\s|$))/.test(line)).length
          const notice = `[test output filtered: dropped ${passingCount} passing-test lines, ${bytes(source) - bytes(filtered)} bytes]`
          const text = `${filtered}\n${notice}`
          const patch = { content: [{ type: 'text', text }] }
          if (event.structuredContent !== undefined) patch.structuredContent = { ...event.structuredContent, output: text }
          return patch
        }
      }
      return undefined
    }
    if (role !== 'builder' || event?.toolName !== 'edit' || !event?.isError) {
      saveCorpus(event)
      return normalToolResult(event, ctx)
    }
    const failureResult = failedEdit(event, { cwd: ctx?.cwd || cwdDefault, env, corpus, readFile, statFile, appendFile, journalPath, now })
    saveCorpus(event)
    return failureResult
  }

  async function normalToolResult(event, ctx) {
    let loaded
    try {
      loaded = loadContext({ taskDir, env, deps: contextDeps })
    } catch { loaded = null }
    const current = loaded && typeof loaded === 'object' ? { ...loaded, role } : null
    const cwd = ctx?.cwd || cwdDefault
    if (!eligible(event, current, cwd)) return undefined
    const command = fencedNodeTestCommand(current)
    const target = targetRelative(cwd, event?.input?.path)
    const metadata = metadataFor({ role, target: target || '', tests: command.args.slice(1) })
    try {
      const result = await runTests(command, { cwd, signal: ctx?.signal, deps: runnerDeps })
      return { content: [...event.content, laneResultPart(result, command.args)] }
    } catch (error) {
      return preserveAfterFailure(error, recordFailure, metadata)
    }
  }

  return { onToolCall, onToolResult, onBeforeAgentStart }
}

function failedEdit(event, { cwd, env, corpus, readFile, statFile, appendFile, journalPath, now }) {
  let path = targetRelative(cwd, event?.input?.path)
  let cause = 'other'
  let causeAbsentReason = null
  let editIndex = null
  let fileText = null
  let oldText = null
  if (path && Array.isArray(event?.input?.edits)) {
    const messages = (Array.isArray(event.content) ? event.content : []).filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n')
    const match = /(?:Could not find|Found \d+ occurrences of) edits\[(\d+)\] in /.exec(messages)
    const singleMatch = event.input.edits.length === 1 && /(?:Could not find the exact text|Found \d+ occurrences of the text) in /.test(messages)
    const index = match ? Number(match[1]) : singleMatch ? 0 : null
    if (index !== null) {
      if (Number.isSafeInteger(index) && index >= 0 && index < event.input.edits.length && typeof event.input.edits[index]?.oldText === 'string') {
        editIndex = index
        oldText = event.input.edits[index].oldText
        let stats
        try { stats = statFile(resolve(cwd, path)) } catch { stats = null }
        if (!stats) causeAbsentReason = 'file-unreadable'
        else if (!Number.isFinite(stats.size) || stats.size > EDIT_FILE_CAP_BYTES) causeAbsentReason = 'file-too-large'
        else {
          try {
            const raw = readFile(resolve(cwd, path), 'utf8')
            const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
            if (bytes(value) > EDIT_FILE_CAP_BYTES) causeAbsentReason = 'file-too-large'
            else fileText = value
          } catch { causeAbsentReason = 'file-unreadable' }
          if (fileText !== null) {
            const notUnique = /Found \d+ occurrences/.test(messages)
            if (notUnique) cause = 'not-unique'
            else {
              const indentationMatch = indentationLines(fileText, oldText).length === 1
              if (indentationMatch) cause = 'indentation'
              else {
                const strippedLines = oldText.split(/\r?\n/).map((line) => line.trimStart())
                const longestLine = strippedLines.sort((a, b) => b.length - a.length)[0] || oldText
                if (corpus.some((text) => text.includes(oldText))) cause = 'seen-stale'
                else if (corpus.some((text) => text.includes(longestLine))) cause = 'partly-seen'
                else cause = 'never-seen'
              }
            }
          }
        }
      }
    }
  } else if (path === null) causeAbsentReason = 'file-unreadable'
  if (causeAbsentReason) cause = null
  const assist = env[EDIT_ASSIST_ENV] === 'on' ? 'on' : 'off'
  const failure = { cause, cause_absent_reason: causeAbsentReason, assist, edit_index: editIndex, path }
  try { appendFile(journalPath, `${JSON.stringify({ at: now(), builder_edit_failure: failure })}\n`) } catch {}
  if (assist !== 'on' || cause === null || !fileText || !oldText) return undefined
  let hintText = ''
  if (cause === 'not-unique') hintText = occurrenceHint(fileText, oldText)
  if (cause === 'never-seen' || cause === 'partly-seen' || cause === 'seen-stale') hintText = windowHint(fileText, oldText, path)
  if (cause === 'indentation') hintText = indentationHint(fileText, oldText)
  if (!hintText) return undefined
  return { content: [...event.content, { type: 'text', text: boundedText(hintText, EDIT_HINT_CAP_BYTES) }] }
}

function indentationLines(fileText, oldText) {
  const normalized = (text) => text.split(/\r?\n/).map((line) => line.replace(/^\s+/, '')).join('\n')
  const lines = fileText.split(/\r?\n/)
  const wanted = normalized(oldText).split('\n')
  const found = []
  for (let i = 0; i <= lines.length - wanted.length; i += 1) if (normalized(lines.slice(i, i + wanted.length).join('\n')) === wanted.join('\n')) found.push(i)
  return found
}

// Stops once the hint outgrows EDIT_HINT_CAP_BYTES: a short oldText in a large file has one
// occurrence per character, and building every block first exhausts string length.
function occurrenceHint(fileText, oldText) {
  const lines = fileText.split(/\r?\n/)
  let line = 0, scanned = 0, size = 0, from = 0
  const lineAt = (offset) => {
    for (; scanned < offset; scanned += 1) if (fileText.charCodeAt(scanned) === 10) line += 1
    return line
  }
  const result = []
  while (size <= EDIT_HINT_CAP_BYTES) {
    const idx = fileText.indexOf(oldText, from)
    if (idx < 0) break
    const firstLine = lineAt(idx), lastLine = lineAt(idx + oldText.length - 1)
    const start = Math.max(0, firstLine - 2), end = Math.min(lines.length, lastLine + 3)
    const block = lines.slice(start, end).map((text, offset) => `${start + offset + 1}: ${text}`).join('\n')
    result.push(block)
    size += block.length
    from = idx + oldText.length
  }
  return result.join('\n---\n')
}

function indentationHint(fileText, oldText) {
  const lines = fileText.split(/\r?\n/), wanted = oldText.split(/\r?\n/)
  for (let i = 0; i <= lines.length - wanted.length; i += 1) {
    if (indentationLines(lines.slice(i, i + wanted.length).join('\n'), oldText).length === 1) {
      return lines.slice(i, i + wanted.length).map((text, offset) => `${i + offset + 1}: ${text}`).join('\n')
    }
  }
  return ''
}

function windowHint(fileText, oldText, path) {
  const lines = fileText.split(/\r?\n/), oldLines = oldText.split(/\r?\n/)
  const candidates = oldLines.map((line) => line.trimStart()).filter(Boolean)
  const anchor = [...candidates].sort((a, b) => b.length - a.length).find((candidate) => lines.some((line) => line.trimStart().includes(candidate)))
  if (!anchor) return `none of the oldText lines occur in ${path}`
  const k = oldLines.map((line) => line.trimStart()).indexOf(anchor)
  let bestStart = 0, bestScore = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().includes(anchor)) continue
    const start = i - k
    let score = 0
    for (let j = 0; j < oldLines.length; j += 1) {
      const expected = oldLines[j].trimStart()
      if (expected && lines[start + j]?.trimStart() === expected) score += 1
    }
    if (score > bestScore) { bestScore = score; bestStart = start }
  }
  const contextStart = Math.max(0, bestStart - 2), contextEnd = Math.min(lines.length, bestStart + oldLines.length + 2)
  return lines.slice(contextStart, contextEnd).map((line, offset) => `${contextStart + offset + 1}: ${line}`).join('\n')
}

function eligible(event, current, cwd) {
  if (current?.role !== 'builder') return false
  if (event?.toolName !== 'edit' && event?.toolName !== 'write') return false
  if (event?.isError) return false
  if (!Array.isArray(event?.content)) return false
  const target = targetRelative(cwd, event?.input?.path)
  if (!target || !inFence(current.files_in_scope, target)) return false
  return Boolean(fencedNodeTestCommand(current))
}

export function attachBuilderLoop(pi, options = {}) {
  const loop = createBuilderLoop(options)
  if (typeof pi?.on !== 'function') throw new Error('builder loop extension needs pi.on')
  pi.on('tool_call', (event, ctx) => loop.onToolCall(event, ctx))
  pi.on('tool_result', (event, ctx) => loop.onToolResult(event, ctx))
  pi.on('before_agent_start', (event) => loop.onBeforeAgentStart(event))
  return loop
}

export default attachBuilderLoop
