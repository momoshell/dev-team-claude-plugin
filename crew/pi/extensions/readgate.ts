// The builder-seat pre-call read gate. It refuses only oversized whole-file reads
// and simple direct cat/head/tail commands; every other tool call is untouched.
// This extension intentionally has no pi or package dependency so checkout-pinned
// pi can load it through its erasable TypeScript loader.

import { appendFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

export const DEFAULT_MAX_LINES = 350
export const MAX_LINES_ENV = 'CREW_READGATE_MAX_LINES'

const defaultRead = (path) => readFileSync(path, 'utf8')
const defaultAppend = (path, text) => appendFileSync(path, text)
const defaultNow = () => new Date().toISOString()
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function countTextLines(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  if (text.length === 0) return 0
  let lines = 1
  for (const character of text) if (character === '\n') lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

function defaultCountLines(path) {
  return countTextLines(defaultRead(path))
}

function parseMaxLines(value) {
  if (value === undefined) return DEFAULT_MAX_LINES
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value
    throw new Error(`${MAX_LINES_ENV} must be a positive integer`)
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${MAX_LINES_ENV} must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${MAX_LINES_ENV} must be a positive integer`)
  return parsed
}

function hasRange(input) {
  return Boolean(input && typeof input === 'object' && (own(input, 'offset') || own(input, 'limit')))
}

function defaultHasUnquotedPipe(command) {
  if (typeof command !== 'string') throw new TypeError('bash command must be a string')
  let quote = ''
  let escaped = false
  let comment = false
  let tokenHasText = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (comment) {
      if (character === '\n') comment = false
      continue
    }
    if (escaped) {
      escaped = false
      tokenHasText = true
      continue
    }
    if (character === '\\') {
      escaped = true
      tokenHasText = true
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (character === '"') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      tokenHasText = true
      continue
    }
    if (/\s/.test(character)) {
      tokenHasText = false
      continue
    }
    if (character === '#' && !tokenHasText) {
      comment = true
      continue
    }
    if (character === '|') return true
    tokenHasText = true
  }
  if (escaped || quote) throw new Error('unterminated shell escape or quote')
  return false
}

function defaultTokenize(command) {
  if (typeof command !== 'string') throw new TypeError('bash command must be a string')
  const words = []
  let word = ''
  let inWord = false
  let quote = ''
  let escaped = false
  let comment = false
  let commentNewline = false

  const push = () => {
    if (!inWord) return
    words.push(word)
    word = ''
    inWord = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (comment) {
      if (character === '\n') {
        comment = false
        commentNewline = true
      }
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = ''
      else word += character
      inWord = true
      continue
    }
    if (quote === '"') {
      if (character === '"') {
        quote = ''
        inWord = true
        continue
      }
      if (character === '\\') {
        if (index + 1 >= command.length) throw new Error('unterminated shell escape')
        const next = command[index + 1]
        if (next === '\n') throw new Error('continued shell command is outside the direct read shape')
        word += next
        inWord = true
        index += 1
        continue
      }
      if (character === '$' || character === '`') return null
      word += character
      inWord = true
      continue
    }
    if (escaped) {
      if (character === '\n') throw new Error('continued shell command is outside the direct read shape')
      word += character
      inWord = true
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      inWord = true
      continue
    }
    if (character === "'" || character === '"') {
      if (commentNewline) return null
      quote = character
      inWord = true
      continue
    }
    if (/\s/.test(character)) {
      if (character === '\n' || character === '\r') {
        if (inWord) push()
        return null
      }
      push()
      continue
    }
    if (character === '#' && !inWord) {
      push()
      comment = true
      continue
    }
    if (commentNewline) return null
    if (';&<>|(){}*?[]'.includes(character) || character === '$' || character === '`') return null
    word += character
    inWord = true
    commentNewline = false
  }
  if (escaped || quote) throw new Error('unterminated shell escape or quote')
  push()
  return words
}

function defaultBlockedRead(path, lineCount, maxLines) {
  const displayedPath = String(path)
  const example = { path: displayedPath, offset: 1, limit: maxLines }
  return {
    block: true,
    reason: `Refusing whole-file read of ${displayedPath}: ${lineCount} lines exceeds threshold ${maxLines}. Use a ranged read, for example: read ${JSON.stringify(example)}`,
  }
}

function validLineCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`line counter returned an invalid count: ${String(value)}`)
  return value
}

function hasCountOption(words) {
  let options = true
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    if (typeof word !== 'string') throw new TypeError('shell tokenizer returned a non-string word')
    if (options && word === '--') {
      options = false
      continue
    }
    if (!options) continue
    if (word === '-n' || word === '-c' || word === '--lines' || word === '--bytes') return true
    if (/^-n(?:=|\d|\+|-)/.test(word)) return true
    if (/^-c(?:=|\d|\+|-)/.test(word)) return true
    if (/^--(?:lines|bytes)(?:=|\d|\+|-)/.test(word)) return true
    if (/^[+-]\d+$/.test(word)) return true
  }
  return false
}

function shellOperands(words, program) {
  const operands = []
  let options = true
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    if (typeof word !== 'string') throw new TypeError('shell tokenizer returned a non-string word')
    if (options && word === '--') {
      options = false
      continue
    }
    if (options && word === '-') continue
    if (options && word.startsWith('-')) {
      if (program === 'head' || program === 'tail') {
        const takesValue = word === '-n' || word === '-c' || word === '--lines' || word === '--bytes'
        if (takesValue) {
          index += 1
          if (index >= words.length) throw new Error(`${program} count option has no value`)
        }
      }
      continue
    }
    if (options && program !== 'cat' && /^\+\d/.test(word)) continue
    operands.push(word)
  }
  return operands
}

export function createReadGate(options = {}) {
  const input = options && typeof options === 'object' ? options : {}
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {}
  const env = input.env || deps.env || process.env
  const cwdDefault = input.cwd || deps.cwd || process.cwd()
  let taskDir = ''
  try { taskDir = String(input.taskDir || deps.taskDir || env?.CREW_TASK_DIR || '') } catch { taskDir = '' }
  const journalPath = input.journalPath || deps.journalPath || (taskDir ? join(dirname(taskDir), 'journal.jsonl') : null)
  const appendFile = input.appendFile || deps.appendFile || deps.appendFileSync || defaultAppend
  const now = input.now || deps.now || defaultNow
  const countLines = input.countLines || deps.countLines || defaultCountLines
  const hasUnquotedPipe = input.hasUnquotedPipe || deps.hasUnquotedPipe || defaultHasUnquotedPipe
  const tokenize = input.tokenize || deps.tokenize || defaultTokenize
  const blockedRead = input.blockedRead || deps.blockedRead || defaultBlockedRead
  const resolveFile = input.resolvePath || deps.resolvePath || resolvePath

  const recordFailure = input.recordFailure || deps.recordFailure || ((row) => {
    if (!journalPath) return
    const at = (() => {
      try { return now() } catch { return defaultNow() }
    })()
    appendFile(journalPath, `${JSON.stringify({ at, ...row })}\n`)
  })

  function recordAndAllow(error, event) {
    let reason = 'read gate inspection failed'
    try {
      const message = error?.message
      reason = message ? String(message) : String(error)
      if (!reason) reason = 'read gate inspection failed'
    } catch {}
    let tool = ''
    let target = ''
    try { tool = String(event?.toolName || '') } catch {}
    try {
      const eventInput = event?.input
      target = tool === 'bash' ? String(eventInput?.command ?? '') : String(eventInput?.path ?? '')
    } catch {}
    try { recordFailure({ read_gate_failure: { reason, tool, target } }) } catch {}
    return undefined
  }

  function configuredMaxLines() {
    const configured = parseMaxLines(env[MAX_LINES_ENV])
    return configured
  }

  function inspectPath(path, cwd, maxLines) {
    const resolved = resolveFile(cwd, path)
    const lineCount = validLineCount(countLines(resolved))
    if (lineCount <= maxLines) return undefined
    return blockedRead(path, lineCount, maxLines)
  }

  function inspectShellRead(words, cwd, maxLines) {
    const program = basename(words[0])
    for (const path of shellOperands(words, program)) {
      if (path === '-') continue
      const result = inspectPath(path, cwd, maxLines)
      if (result !== undefined) return result
    }
    return undefined
  }

  function onToolCall(event, ctx) {
    try {
      if (event?.toolName === 'grep') return undefined
      const input = event?.input || {}
      if (event?.toolName === 'read') {
        if (hasRange(input)) return undefined
        const maxLines = configuredMaxLines()
        const cwd = ctx?.cwd || cwdDefault
        return inspectPath(input.path, cwd, maxLines)
      }
      if (event?.toolName !== 'bash') return undefined
      const command = input.command
      if (hasUnquotedPipe(command)) return undefined
      const words = tokenize(command)
      if (!Array.isArray(words) || words.length === 0) return undefined
      const program = basename(words[0])
      if (program !== 'cat' && program !== 'head' && program !== 'tail') return undefined
      const maxLines = configuredMaxLines()
      const cwd = ctx?.cwd || cwdDefault
      if (program === 'cat') return inspectShellRead(words, cwd, maxLines)
      if (program === 'head' && hasCountOption(words)) return undefined
      if (program === 'tail' && hasCountOption(words)) return undefined
      if (program === 'head') return inspectShellRead(words, cwd, maxLines)
      if (program === 'tail') return inspectShellRead(words, cwd, maxLines)
      return undefined
    } catch (error) {
      return recordAndAllow(error, event)
    }
  }

  return { onToolCall }
}

export function attachReadGate(pi, options = {}) {
  const gate = createReadGate(options)
  if (typeof pi?.on !== 'function') throw new Error('read gate extension needs pi.on')
  pi.on('tool_call', (event, ctx) => gate.onToolCall(event, ctx))
  return gate
}

export default attachReadGate
