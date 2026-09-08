// The builder-seat skeleton reader. A large successful read is replaced with a
// bounded index and the planner's literal citations; the original read and every
// non-builder/non-fenced result remain untouched. The retrieve tool is deliberately
// sequential and is useful only for symbols whose line-scan row has one body span.

import { appendFileSync, closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, relative, resolve } from 'node:path'
import { exportEntries } from '../../../scripts/factory/make-brief.mjs'
import { DEFAULT_MAX_LINES, MAX_LINES_ENV } from './readgate.ts'

const READ_CAP_BYTES = 256 * 1024
const JOURNAL_CAP_BYTES = 64 * 1024
const SOURCE_WINDOW_BYTES = 64 * 1024
const PLAN_CAP_BYTES = 256 * 1024
const MAX_RETURN_ENTRIES = 4096
const MAX_FENCE_ENTRIES = 512
const MAX_FENCE_PATH_BYTES = 1024
const MAX_REASON_BYTES = 256
const CITATION_RE = /(?<![\w./\\-])(?<file>[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*):(?<start>[1-9][0-9]*)(?:-(?<end>[1-9][0-9]*))?(?![\w/-])/g
const RUN_START_EVENT = 'run-start'

const INCLUDE_SIGNATURE_ROWS = true
const SELECT_LATEST_PLANNER_RETURN = true
export const NO_CITED_RANGES = '(no cited ranges in accepted plan)'
export const BLIND_SPOT = 'Line-scan blind spot: export var, export * from, export interface, and code outside .js/.mjs/.ts are not indexed.'
export const RETRIEVE_TOOL_NAME = 'retrieve'

export const RETRIEVE_PARAMS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['file'],
  properties: {
    file: { type: 'string', minLength: 1 },
    symbol: { type: 'string', minLength: 1 },
    range: { type: ['string', 'object', 'array'] },
  },
  oneOf: [
    { required: ['symbol'], not: { required: ['range'] } },
    { required: ['range'], not: { required: ['symbol'] } },
  ],
})

const defaultRead = (path, encoding) => readFileSync(path, encoding)
const defaultAppend = (path, text) => appendFileSync(path, text)
const defaultReadDir = (path) => readdirSync(path)
const defaultStat = (path) => statSync(path)
const defaultNow = () => new Date().toISOString()

function bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

function boundedText(value, cap) {
  const text = String(value ?? '')
  if (bytes(text) <= cap) return text
  return new StringDecoder('utf8').write(Buffer.from(text, 'utf8').subarray(0, cap))
}

export function normalizePath(value) {
  let clean = String(value ?? '').replaceAll('\\', '/').trim()
  if (clean.startsWith('./')) clean = clean.replace(/^\.\/+/, '')
  return clean
}

function safeRelativePath(value) {
  const clean = normalizePath(value)
  if (!clean || clean.startsWith('/') || clean.includes('\0') || bytes(clean) > MAX_FENCE_PATH_BYTES) return null
  const parts = clean.split('/')
  const last = parts.at(-1)
  if (parts.some((part, index) => !part && index !== parts.length - 1) || (last === '' && parts.length < 2)
    || parts.some((part) => part === '.' || part === '..')) return null
  return clean
}

function fenceEntry(value) {
  const clean = normalizePath(value)
  const match = clean.match(/^(.*?):([1-9][0-9]*)(?:-([1-9][0-9]*))?$/)
  const path = safeRelativePath(match ? match[1] : clean)
  if (!path) return null
  if (!match) return { path, start: null, end: null }
  const start = Number(match[2])
  const end = Number(match[3] || match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null
  return { path, start, end }
}

export function validFence(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FENCE_ENTRIES) return false
  return files.every((entry) => typeof entry === 'string' && fenceEntry(entry) !== null)
}

export function inFence(files, target) {
  const cleanTarget = safeRelativePath(target)
  if (!cleanTarget) return false
  return (Array.isArray(files) ? files : []).some((entry) => {
    const parsed = fenceEntry(entry)
    if (!parsed) return false
    if (parsed.path.endsWith('/')) return cleanTarget.startsWith(parsed.path)
    return cleanTarget === parsed.path
  })
}

function epochMilliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return null
  const number = Number(value)
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function runStartFromJournal(raw) {
  let latest = null
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.event !== RUN_START_EVENT) continue
    const at = epochMilliseconds(row.at ?? row.started_at ?? row.run_started_at ?? row.timestamp)
    if (at !== null) latest = at
  }
  return latest
}

function bytesBuffer(raw) {
  try { return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8') } catch { return null }
}

function bufferText(buffer) {
  return new StringDecoder('utf8').end(buffer)
}

function tailRunStart(buffer, partial) {
  let tail = buffer
  if (partial) {
    const newline = tail.indexOf(0x0a)
    tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1)
  }
  return runStartFromJournal(bufferText(tail))
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
    const stat = (deps.stat || deps.statSync || defaultStat)(path)
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
  // Test seams can provide the journal as a value; production walks fixed-size
  // positioned windows backward from EOF, so a long journal never materializes.
  if (deps.readFile || deps.readFileSync) {
    let raw
    try { raw = read(path, 'utf8') } catch { return null }
    return runStartFromJournalBytes(raw)
  }
  const size = journalSize(path, deps)
  if (size === null) return null
  return lastRunStart(size, (position, length) => journalWindow(path, position, length, deps))
}

function readBounded(path, read, cap) {
  let raw
  try { raw = read(path, 'utf8') } catch { return null }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  return bytes(text) <= cap ? text : null
}

function sourceSize(path, deps) {
  try {
    const stat = (deps.stat || deps.statSync || defaultStat)(path)
    const size = Number(stat?.size)
    return Number.isSafeInteger(size) && size >= 0 ? size : null
  } catch { return null }
}

function sourceWindow(path, position, length, deps) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || length > SOURCE_WINDOW_BYTES) return null
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

function readSmallSource(path, deps, read) {
  if (!deps.readFile && !deps.readFileSync) {
    const size = sourceSize(path, deps)
    if (size === null || size > READ_CAP_BYTES) return null
  }
  return readBounded(path, read, READ_CAP_BYTES)
}

function readSourceText(path, deps, read) {
  // Signature indexing needs the complete target source. Citation and range paths
  // use sourceLineCount/sourceRange instead, so they never materialize this text.
  if (deps.readFile || deps.readFileSync) {
    let raw
    try { raw = read(path, 'utf8') } catch { return null }
    return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  }
  const size = sourceSize(path, deps)
  if (size === null) return null
  if (size <= READ_CAP_BYTES) return readBounded(path, read, READ_CAP_BYTES)
  const chunks = []
  for (let position = 0; position < size; position += SOURCE_WINDOW_BYTES) {
    const length = Math.min(SOURCE_WINDOW_BYTES, size - position)
    const window = sourceWindow(path, position, length, deps)
    if (!Buffer.isBuffer(window) || window.length !== length) return null
    chunks.push(window)
  }
  return bufferText(Buffer.concat(chunks))
}

function sourceLineCount(path, deps, read) {
  if (deps.readFile || deps.readFileSync) {
    const source = readSourceText(path, deps, read)
    return source === null ? null : countTextLines(source)
  }
  const size = sourceSize(path, deps)
  if (size === null) return null
  if (size === 0) return 0
  let separators = 0
  let pendingCR = false
  let endedWithSeparator = false
  let sawByte = false
  for (let position = 0; position < size; position += SOURCE_WINDOW_BYTES) {
    const length = Math.min(SOURCE_WINDOW_BYTES, size - position)
    const window = sourceWindow(path, position, length, deps)
    if (!Buffer.isBuffer(window) || window.length !== length) return null
    for (const byte of window) {
      sawByte = true
      if (pendingCR) {
        separators += 1
        pendingCR = false
        endedWithSeparator = true
        if (byte === 0x0a) continue
      }
      if (byte === 0x0d) {
        pendingCR = true
        continue
      }
      if (byte === 0x0a) {
        separators += 1
        endedWithSeparator = true
        continue
      }
      endedWithSeparator = false
    }
  }
  if (pendingCR) separators += 1
  if (pendingCR) endedWithSeparator = true
  return sawByte ? separators + (endedWithSeparator ? 0 : 1) : 0
}

function sourceRange(path, start, end, deps, read) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end) return null
  if (deps.readFile || deps.readFileSync) {
    const source = readSourceText(path, deps, read)
    if (source === null) return null
    const lines = sourceLines(source)
    if (end > lines.length) return null
    return lines.slice(start - 1, end).join('\n')
  }
  const size = sourceSize(path, deps)
  if (size === null || size === 0) return null
  let line = 1
  let completed = 0
  let terminal = false
  let skipLF = false
  let sawByte = false
  let current = []
  const lines = []
  const finishLine = () => {
    if (line >= start && line <= end) lines.push(Buffer.from(current).toString('utf8'))
    current = []
    completed += 1
    line += 1
  }
  for (let position = 0; position < size; position += SOURCE_WINDOW_BYTES) {
    const length = Math.min(SOURCE_WINDOW_BYTES, size - position)
    const window = sourceWindow(path, position, length, deps)
    if (!Buffer.isBuffer(window) || window.length !== length) return null
    for (const byte of window) {
      sawByte = true
      if (skipLF) {
        skipLF = false
        if (byte === 0x0a) continue
      }
      if (byte === 0x0d) {
        finishLine()
        terminal = true
        skipLF = true
        continue
      }
      if (byte === 0x0a) {
        finishLine()
        terminal = true
        continue
      }
      terminal = false
      if (line >= start && line <= end) current.push(byte)
    }
  }
  if (!sawByte) return null
  if (!terminal) finishLine()
  if (end > completed || lines.length !== end - start + 1) return null
  return lines.join('\n')
}

function taskPlanPath(taskDir, value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const root = resolve(String(taskDir || ''))
  let absolute
  try { absolute = resolve(root, value) } catch { return null }
  const rel = normalizePath(relative(root, absolute))
  if (!rel || rel === '..' || rel.startsWith('../') || rel.includes('\0')) return null
  return absolute
}

function targetRelative(cwd, input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) return null
  let root
  let absolute
  try {
    root = resolve(String(cwd || ''))
    absolute = resolve(root, input)
  } catch { return null }
  const rel = normalizePath(relative(root, absolute))
  if (!rel || rel === '..' || rel.startsWith('../')) return null
  return safeRelativePath(rel)
}

function sourceLines(text) {
  const raw = String(text ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (raw.length === 0) return []
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export function countTextLines(text) {
  return sourceLines(text).length
}

function parseMaxLines(value) {
  if (value === undefined) return DEFAULT_MAX_LINES
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value
    throw new Error(`${MAX_LINES_ENV} must be a positive integer`)
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error(`${MAX_LINES_ENV} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${MAX_LINES_ENV} must be a positive integer`)
  return parsed
}

export function parseCitations(plan, filesInScope, sourceFor) {
  const ranges = []
  const seen = new Set()
  const text = String(plan ?? '')
  for (const match of text.matchAll(CITATION_RE)) {
    const file = safeRelativePath(match.groups.file)
    if (!file || !inFence(filesInScope, file)) continue
    const start = Number(match.groups.start)
    const end = Number(match.groups.end || match.groups.start)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) continue
    let source
    try { source = sourceFor(file) } catch { continue }
    if (typeof source !== 'string' && (!source || !Number.isSafeInteger(source.lineCount))) continue
    const lineCount = typeof source === 'string'
      ? countTextLines(source)
      : (source && Number.isSafeInteger(source.lineCount) ? source.lineCount : null)
    if (lineCount === null || start < 1 || end > lineCount) continue
    const key = `${file}:${start}-${end}`
    if (seen.has(key)) continue
    seen.add(key)
    ranges.push({ file, start, end })
  }
  return ranges.sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start || left.end - right.end)
}

function plannerContext(raw, taskDir) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.status !== 'done' || raw.role !== 'planner') return null
  const details = raw.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  if (!validFence(details.files_in_scope)) return null
  const planPath = taskPlanPath(taskDir, details.plan_path)
  if (!planPath) return null
  return { files_in_scope: [...new Set(details.files_in_scope.map(normalizePath))], plan_path: planPath }
}

function candidateMtime(path, deps) {
  try {
    const value = deps.fileMtime
      ? deps.fileMtime(path)
      : (deps.stat || deps.statSync || defaultStat)(path).mtimeMs
    const number = typeof value === 'object' && value !== null ? Number(value.mtimeMs) : Number(value)
    return Number.isFinite(number) ? number : null
  } catch { return null }
}

export function loadAcceptedContext(value = {}, extraDeps = {}) {
  const input = typeof value === 'string' ? { taskDir: value, deps: { ...extraDeps } } : (value && typeof value === 'object' ? value : {})
  const deps = { ...(input.deps || {}), ...(typeof value === 'string' ? extraDeps : {}) }
  const taskDir = String(input.taskDir || deps.taskDir || input.env?.CREW_TASK_DIR || '')
  const cwd = String(input.cwd || deps.cwd || process.cwd())
  if (!taskDir) return null
  const read = deps.readFile || deps.readFileSync || defaultRead
  const journalPath = join(dirname(taskDir), 'journal.jsonl')
  const runStart = journalRunStart(journalPath, deps, read)
  if (runStart === null) return null
  const returnsDir = join(dirname(taskDir), 'returns')
  let names
  try { names = (deps.readDir || deps.readdirSync || defaultReadDir)(returnsDir) } catch { return null }
  if (!Array.isArray(names) || names.length > MAX_RETURN_ENTRIES) return null
  const candidates = []
  for (const name of names) {
    const match = /^d(\d+)\.planner\.json$/.exec(String(name))
    if (!match) continue
    const path = join(returnsDir, String(name))
    const mtime = candidateMtime(path, deps)
    if (mtime === null) continue
    candidates.push({ number: Number(match[1]), path, mtime })
  }
  const currentCandidates = SELECT_LATEST_PLANNER_RETURN
    ? candidates.filter((candidate) => candidate.mtime > runStart).sort((left, right) => right.number - left.number)
    : candidates.sort((left, right) => left.number - right.number)
  const candidate = currentCandidates[0]
  if (!candidate) return null
  const plannerText = readBounded(candidate.path, read, PLAN_CAP_BYTES)
  if (plannerText === null) return null
  let raw
  try { raw = JSON.parse(plannerText) } catch { return null }
  const context = plannerContext(raw, taskDir)
  if (!context) return null
  const planText = readBounded(context.plan_path, read, PLAN_CAP_BYTES)
  if (planText === null) return null
  const sourceCounts = new Map()
  const sourceFor = (file) => {
    if (sourceCounts.has(file)) return sourceCounts.get(file)
    const path = resolve(cwd, file)
    const rel = targetRelative(cwd, path)
    if (!rel || rel !== file || !inFence(context.files_in_scope, rel)) return null
    const lineCount = sourceLineCount(path, deps, read)
    const source = lineCount === null ? null : { lineCount }
    sourceCounts.set(file, source)
    return source
  }
  const ranges = parseCitations(planText, context.files_in_scope, sourceFor)
  return { ...context, plan_text: planText, ranges, planner_number: candidate.number }
}

function configuredMaxLines(env) {
  const configured = env[MAX_LINES_ENV]
  return parseMaxLines(configured)
}

function displayRange(range) {
  return `${range.file}:${range.start}${range.start === range.end ? '' : `-${range.end}`}`
}

function numberedLines(lines, start, end) {
  return lines.slice(start - 1, end).map((line, offset) => `${start + offset}: ${line}`)
}

export function renderSkeleton({ target, source, lineCount, maxLines, context, readSource, readRange, index = exportEntries } = {}) {
  if (!context || typeof source !== 'string' || !Number.isSafeInteger(lineCount)) throw new Error('skeleton render context is incomplete')
  const lines = sourceLines(source)
  const parts = [
    `Skeleton read: ${target}`,
    `Lines: ${lineCount}`,
  ]
  parts.push(`Threshold: ${maxLines} lines`)
  parts.push(`Configuration: ${MAX_LINES_ENV}=${String(maxLines)}`)
  parts.push('Indexed signatures:')
  const indexed = index(source, target)
  if (INCLUDE_SIGNATURE_ROWS) {
    for (const entry of indexed) {
      const span = entry.signatureSpan ? `${entry.signatureSpan.start}-${entry.signatureSpan.end}` : String(entry.line)
      parts.push(`- ${entry.name} · line ${entry.line} · ${span} · ${entry.signature || ''}`)
    }
  }
  parts.push('Accepted-plan ranges:')
  const ranges = Array.isArray(context.ranges) ? context.ranges : []
  if (ranges.length === 0) parts.push(NO_CITED_RANGES)
  for (const range of ranges) {
    if (typeof readRange === 'function') {
      const cited = readRange(range.file, range.start, range.end)
      if (typeof cited !== 'string') throw new Error(`cannot read cited range ${displayRange(range)}`)
      const citedLines = sourceLines(cited)
      const expectedLines = range.end - range.start + 1
      if (citedLines.length > expectedLines) throw new Error(`cited range is outside current source ${displayRange(range)}`)
      while (citedLines.length < expectedLines) citedLines.push('')
      parts.push(`${displayRange(range)}:`)
      parts.push(...citedLines.map((line, offset) => `${range.start + offset}: ${line}`))
      continue
    }
    const cited = typeof readSource === 'function' ? readSource(range.file) : null
    if (typeof cited !== 'string') throw new Error(`cannot read cited range ${displayRange(range)}`)
    const citedLines = sourceLines(cited)
    if (range.start < 1 || range.start > range.end || range.end > citedLines.length) {
      throw new Error(`cited range is outside current source ${displayRange(range)}`)
    }
    parts.push(`${displayRange(range)}:`)
    parts.push(...numberedLines(citedLines, range.start, range.end))
  }
  parts.push(BLIND_SPOT)
  parts.push(`Retrieve usage: retrieve({ file: "${target}", symbol: "<indexed name>" }) or retrieve({ file: "${target}", range: "start-end" }).`)
  return parts.join('\n')
}

function refusal(message) {
  return `refused: ${String(message || 'request is outside the accepted builder fence')}`
}

function boundedReason(error) {
  let reason
  try { reason = error?.message ? String(error.message) : String(error) } catch { reason = 'unknown skeleton-read failure' }
  if (!reason) reason = 'unknown skeleton-read failure'
  return boundedText(reason, MAX_REASON_BYTES)
}

function normalizeRequestRange(value, lineCount) {
  let start
  let end
  if (typeof value === 'string') {
    const match = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(value.trim())
    if (!match) return null
    start = Number(match[1])
    end = Number(match[2] || match[1])
  } else if (Array.isArray(value) && value.length === 2) {
    start = Number(value[0])
    end = Number(value[1])
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    start = Number(value.start)
    end = Number(value.end ?? value.start)
  } else return null
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end || end > lineCount) return null
  return { start, end }
}

export function retrieveRange(requestRange, lines) {
  const parsed = normalizeRequestRange(requestRange, lines.length)
  if (!parsed) return refusal('range is malformed or outside the file')
  return lines.slice(parsed.start - 1, parsed.end).join('\n')
}

function bodyLines(source, bodySpan) {
  if (!bodySpan || !Number.isSafeInteger(bodySpan.start) || !Number.isSafeInteger(bodySpan.end)) return null
  const lines = sourceLines(source)
  if (bodySpan.start < 1 || bodySpan.start > bodySpan.end || bodySpan.end > lines.length) return null
  return lines.slice(bodySpan.start - 1, bodySpan.end).join('\n')
}

function retrieveSymbol(request, source, file, index) {
  if (typeof request.symbol !== 'string' || !request.symbol.trim()) return refusal('symbol is malformed')
  const rows = index(source, file).filter((entry) => entry.name === request.symbol)
  if (rows.length === 0) return refusal(`unknown symbol ${request.symbol}`)
  if (rows.length !== 1) return refusal(`ambiguous symbol ${request.symbol}`)
  if (!rows[0].bodySpan) return refusal(`symbol ${request.symbol} has no retrievable local body`)
  const body = bodyLines(source, rows[0].bodySpan)
  return body === null ? refusal(`symbol ${request.symbol} has an invalid body span`) : body
}

export function createRetrieveTool(options = {}) {
  const input = options && typeof options === 'object' ? options : {}
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {}
  const env = input.env || deps.env || process.env
  const cwdDefault = input.cwd || deps.cwd || process.cwd()
  const taskDir = String(input.taskDir || deps.taskDir || env?.CREW_TASK_DIR || '')
  const read = deps.readFile || deps.readFileSync || defaultRead
  const loadContext = input.loadContext || deps.loadContext || ((value) => loadAcceptedContext(value))
  const index = input.exportEntries || deps.exportEntries || exportEntries
  const recordFailure = input.recordFailure || deps.recordFailure || (() => {})
  const now = input.now || deps.now || defaultNow

  const fallbackTool = (error) => {
    try { recordFailure({ at: (() => { try { return now() } catch { return defaultNow() } })(), skeleton_read_failure: boundedReason(error) }) } catch {}
    return refusal('skeleton-read context is unavailable')
  }

  return {
    name: RETRIEVE_TOOL_NAME,
    label: 'Retrieve',
    description: 'Retrieve one accepted fenced source range or one indexed symbol body.',
    parameters: RETRIEVE_PARAMS,
    executionMode: 'sequential',
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      try {
        if (env?.CREW_ROLE && env.CREW_ROLE !== 'builder') return refusal('retrieve is available only to the builder seat')
        if (!request || typeof request !== 'object' || Array.isArray(request)) return refusal('request must be an object')
        const hasSymbol = request.symbol !== undefined
        const hasRange = request.range !== undefined
        if (hasSymbol === hasRange || typeof request.file !== 'string' || !request.file.trim()) return refusal('provide file and exactly one of symbol or range')
        const context = loadContext({ taskDir, cwd: ctx?.cwd || cwdDefault, env, deps })
        if (!context) return refusal('no accepted current-run planner context')
        const cwd = ctx?.cwd || cwdDefault
        const file = targetRelative(cwd, request.file)
        if (!file) return refusal('file path is malformed')
        if (!inFence(context.files_in_scope, file)) return refusal(file)
        const sourcePath = resolve(cwd, file)
        const source = readSmallSource(sourcePath, deps, read)
        if (source !== null) {
          const lines = sourceLines(source)
          if (request.range !== undefined) return retrieveRange(request.range, lines)
          return retrieveSymbol(request, source, file, index)
        }
        if (request.range !== undefined) {
          const lineCount = sourceLineCount(sourcePath, deps, read)
          const range = normalizeRequestRange(request.range, lineCount ?? 0)
          if (!range) return refusal('range is malformed or outside the file')
          const text = sourceRange(sourcePath, range.start, range.end, deps, read)
          return text === null ? refusal(`cannot read ${file}`) : text
        }
        const largeSource = readSourceText(sourcePath, deps, read)
        if (largeSource === null) return refusal(`cannot read ${file}`)
        return retrieveSymbol(request, largeSource, file, index)
      } catch (error) {
        return fallbackTool(error)
      }
    },
  }
}

export function createSkeletonRead(options = {}) {
  const input = options && typeof options === 'object' ? options : {}
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {}
  const env = input.env || deps.env || process.env
  const cwdDefault = input.cwd || deps.cwd || process.cwd()
  const taskDir = String(input.taskDir || deps.taskDir || env?.CREW_TASK_DIR || '')
  const read = deps.readFile || deps.readFileSync || defaultRead
  const loadContext = input.loadContext || deps.loadContext || ((value) => loadAcceptedContext(value))
  const index = input.exportEntries || deps.exportEntries || exportEntries
  const recordFailure = input.recordFailure || deps.recordFailure || ((row) => {
    const journalPath = taskDir ? join(dirname(taskDir), 'journal.jsonl') : null
    if (!journalPath) return
    ;(deps.appendFile || deps.appendFileSync || defaultAppend)(journalPath, `${JSON.stringify(row)}\n`)
  })
  const now = input.now || deps.now || defaultNow

  const fallback = (error, event) => {
    try {
      recordFailure({
        at: (() => { try { return now() } catch { return defaultNow() } })(),
        skeleton_read_failure: boundedReason(error),
        tool: String(event?.toolName || ''),
      })
    } catch {}
    return undefined
  }

  function onToolResult(event, ctx) {
    try {
      if (env?.CREW_ROLE !== 'builder') return undefined
      if (event?.toolName !== 'read' || event?.isError || !Array.isArray(event?.content)) return undefined
      const request = event.input || {}
      if (request.offset !== undefined || request.limit !== undefined) return undefined
      const cwd = ctx?.cwd || cwdDefault
      const target = targetRelative(cwd, request.path)
      if (!target) return undefined
      const current = loadContext({ taskDir, cwd, env, deps })
      if (!current) return undefined
      if (!inFence(current.files_in_scope, target)) return undefined
      const sourcePath = resolve(cwd, target)
      let source = readSmallSource(sourcePath, deps, read)
      if (source === null) source = readSourceText(sourcePath, deps, read)
      if (source === null) throw new Error(`cannot read ${target}`)
      const lineCount = countTextLines(source)
      const maxLines = configuredMaxLines(env)
      if (lineCount <= maxLines) return undefined
      const text = renderSkeleton({
        target, source, lineCount, maxLines, context: current,
        readRange: (file, start, end) => {
          const path = resolve(cwd, file)
          const rel = targetRelative(cwd, path)
          if (!rel || rel !== file || !inFence(current.files_in_scope, rel)) return null
          return sourceRange(path, start, end, deps, read)
        }, index,
      })
      return { content: [{ type: 'text', text }] }
    } catch (error) { return fallback(error, event) }
  }

  const retrieve = createRetrieveTool({ ...input, deps, env, cwd: cwdDefault, taskDir, loadContext, exportEntries: index, recordFailure, now })
  return { onToolResult, retrieve, fallback }
}

export function attachSkeletonRead(pi, options = {}) {
  const skeleton = createSkeletonRead(options)
  if (typeof pi?.registerTool !== 'function' || typeof pi?.on !== 'function') throw new Error('skeleton read extension needs pi.registerTool and pi.on')
  pi.registerTool(skeleton.retrieve)
  pi.on('tool_result', (event, ctx) => skeleton.onToolResult(event, ctx))
  return skeleton
}

export default function skeletonReadExtension(pi) {
  return attachSkeletonRead(pi)
}
