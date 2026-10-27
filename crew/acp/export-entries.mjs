// crew/acp/export-entries.mjs — the export scanner the lean seat path reads source skeletons with.

import { extname } from 'node:path'

export const CODE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts'])
const INCLUDE_EXPORT_FROM_SUFFIX = true
const MULTILINE_EXPORT_LISTS = true
const INCLUDE_ALL_LIST_MEMBERS = true
const INCLUDE_DEFAULT_EXPORT = true
const RESOLVE_LOCAL_LIST_BODIES = true
const UNSUPPORTED_EXPORT_FORMS = Object.freeze(['var', 'star', 'interface'])
const EXPORTED_DECLARATION = /^export\s+(?:(?:async)\s+)?(function|const|let|class|var|interface)\s+([A-Za-z_$][\w$]*)/gm
const EXPORTED_DEFAULT = /^export\s+default\b/gm
const EXPORTED_LIST = /^export\s*\{/gm

const MISSING_LINE = 'missing-line'
const WRONG_TYPE = 'wrong-type'

export class BriefUsageError extends Error {
  constructor(message, reason = MISSING_LINE) {
    super(message)
    this.name = 'BriefUsageError'
    this.reason = reason
  }
}

function refuseUsage(message, reason = MISSING_LINE) {
  throw new BriefUsageError(`brief: ${message}`, reason)
}
export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function normaliseSourceInput(source, filePath = '') {
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    filePath = source.file || source.path || ''
    source = source.source || ''
  }
  if (filePath && typeof filePath === 'object') filePath = filePath.file || filePath.path || ''
  return { source, filePath }
}

// Line numbers were O(n²) until #892: this closure re-sliced and re-split the
// whole prefix of the source for every match, so a file with N exported symbols
// paid ~N²/2 character copies. MEASURED on this checkout, 2026-09-03, 16 cores
// at load ~3.5: one exportEntries call over a 70,000-export source cost 32.6s
// (2.40s at 20k, 0.17s at 5k — 4x the symbols for ~13.6x the time). A
// precomputed newline table with a binary search does the same 70k in 4.9ms.
// That is the whole of #892: the two ARG_MAX fixtures took 110.8s and 70.2s and
// npm test went from 35s to 218s.
export function lineIndex(source) {
  const starts = [0]
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) starts.push(at + 1)
  return (index) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

function regexLiteralStarts(source, index, masked) {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
  if (cursor < 0) return true
  if ('([{:;,=!?&|+-*%^~<>'.includes(source[cursor])) return true
  const prefix = masked.slice(Math.max(0, cursor - 8), cursor + 1).join('')
  return /\b(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await)$/.test(prefix)
}

function maskRegexLiteral(source, masked, start) {
  masked[start] = ' '
  let inClass = false
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character !== '\n' && character !== '\r') masked[index] = ' '
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      inClass = true
      continue
    }
    if (character === ']' && inClass) {
      inClass = false
      continue
    }
    if (character === '/' && !inClass) return index
  }
  return source.length
}

function templateLiteralEnd(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '`') return index
    if (character === '$' && source[index + 1] === '{') {
      const end = templateInterpolationEnd(source, index + 2)
      if (end < 0) return -1
      index = end
    }
  }
  return -1
}

function templateInterpolationEnd(source, start) {
  let depth = 1
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '\'' || character === '"') {
      const end = scanQuoted(source, index)
      if (end < 0) return -1
      index = end - 1
      continue
    }
    if (character === '`') {
      const end = templateLiteralEnd(source, index)
      if (end < 0) return -1
      index = end
      continue
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end
      continue
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) return -1
      index = end + 1
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return index
  }
  return -1
}

function maskLexical(source) {
  const masked = [...source]
  let state = 'code'
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (character === '\n') state = 'code'
      else masked[index] = ' '
      continue
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        masked[index] = ' '
        masked[index + 1] = ' '
        index += 1
        state = 'code'
      } else if (character !== '\n' && character !== '\r') masked[index] = ' '
      continue
    }
    if (state === 'string' || state === 'template') {
      if (character === '\\') {
        masked[index] = ' '
        if (index + 1 < source.length) {
          if (source[index + 1] !== '\n' && source[index + 1] !== '\r') masked[index + 1] = ' '
          index += 1
        }
        continue
      }
      if (character === quote) {
        masked[index] = ' '
        state = 'code'
        quote = ''
      } else if (character !== '\n' && character !== '\r') {
        masked[index] = ' '
      }
      continue
    }
    if (character === '/' && next === '/') {
      masked[index] = ' '
      masked[index + 1] = ' '
      index += 1
      state = 'line-comment'
      continue
    }
    if (character === '/' && next === '*') {
      masked[index] = ' '
      masked[index + 1] = ' '
      index += 1
      state = 'block-comment'
      continue
    }
    if (character === '/' && regexLiteralStarts(source, index, masked)) {
      index = maskRegexLiteral(source, masked, index)
      continue
    }
    if (character === '`') {
      const end = templateLiteralEnd(source, index)
      if (end < 0) return masked.join('')
      for (let cursor = index; cursor <= end; cursor += 1) {
        if (source[cursor] !== '\n' && source[cursor] !== '\r') masked[cursor] = ' '
      }
      index = end
      continue
    }
    if (character === '\'' || character === '"') {
      masked[index] = ' '
      quote = character
      state = 'string'
    }
  }
  return masked.join('')
}

function matchingDelimiter(masked, open) {
  const expected = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  for (let index = open; index < masked.length; index += 1) {
    const character = masked[index]
    if (expected[character]) {
      stack.push(expected[character])
      continue
    }
    if (character !== ')' && character !== ']' && character !== '}') continue
    if (stack.at(-1) !== character) return -1
    stack.pop()
    if (stack.length === 0) return index
  }
  return -1
}

function skipLexicalWhitespace(masked, start) {
  let index = start
  while (index < masked.length && /\s/.test(masked[index])) index += 1
  return index
}

function wordAt(masked, start, word) {
  return masked.slice(start, start + word.length) === word
    && !/[A-Za-z0-9_$]/.test(masked[start - 1] || '')
    && !/[A-Za-z0-9_$]/.test(masked[start + word.length] || '')
}

function scanQuoted(source, start) {
  const quote = source[start]
  if (quote !== '\'' && quote !== '"' && quote !== '`') return -1
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === quote) return index + 1
    if (source[index] === '\n' || source[index] === '\r') return -1
  }
  return -1
}

function skipSourceTrivia(source, start) {
  let index = start
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2)
      index = newline < 0 ? source.length : newline + 1
      continue
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2)
      if (close < 0) return -1
      index = close + 2
      continue
    }
    break
  }
  return index
}

function scanExportListEnd(source, masked, start) {
  const open = masked.indexOf('{', start)
  if (open < 0) return null
  const close = matchingDelimiter(masked, open)
  if (close < 0) return null
  if (!MULTILINE_EXPORT_LISTS && source.slice(open + 1, close).includes('\n')) return null
  let end = close + 1
  let cursor = skipLexicalWhitespace(masked, end)
  const hasFrom = wordAt(masked, cursor, `from`)
  const from = hasFrom && INCLUDE_EXPORT_FROM_SUFFIX
  if (from) {
    cursor = skipSourceTrivia(source, cursor + 4)
    if (cursor < 0) return null
    const quoteEnd = scanQuoted(source, cursor)
    if (quoteEnd < 0) return null
    end = quoteEnd
    cursor = skipLexicalWhitespace(masked, end)
  }
  if (masked[cursor] === ';') end = cursor + 1
  return { close, end, from }
}

function declarationBlockKind(masked, start, kind) {
  if (kind === 'function' || kind === 'class') return kind
  if (kind !== 'default') return null
  let cursor = masked.indexOf('default', start)
  if (cursor < 0) return null
  cursor = skipLexicalWhitespace(masked, cursor + 'default'.length)
  if (wordAt(masked, cursor, 'async')) cursor = skipLexicalWhitespace(masked, cursor + 'async'.length)
  if (wordAt(masked, cursor, 'function')) return 'function'
  if (wordAt(masked, cursor, 'class')) return 'class'
  return null
}

function declarationBodyOpen(masked, start, kind = '') {
  const stack = []
  let parametersClosed = false
  for (let index = start; index < masked.length; index += 1) {
    const character = masked[index]
    if (character === '(') stack.push(')')
    else if (character === '[') stack.push(']')
    else if (character === '{') {
      if (stack.length === 0) {
        if (kind === 'function' && parametersClosed) {
          const close = matchingDelimiter(masked, index)
          const next = close < 0 ? -1 : skipLexicalWhitespace(masked, close + 1)
          if (close >= 0 && masked[next] === '{') {
            index = close
            continue
          }
        }
        return index
      }
      stack.push('}')
    } else if (character === ')' || character === ']' || character === '}') {
      if (stack.at(-1) !== character) return -1
      stack.pop()
      if (kind === 'function' && character === ')' && stack.length === 0) parametersClosed = true
    }
  }
  return -1
}

function declarationEnd(source, masked, start, kind) {
  const blockKind = declarationBlockKind(masked, start, kind)
  if (blockKind) {
    const open = declarationBodyOpen(masked, start, blockKind)
    if (open < 0) return null
    const close = matchingDelimiter(masked, open)
    if (close < 0) return null
    let end = close + 1
    const cursor = skipLexicalWhitespace(masked, end)
    if (masked[cursor] === ';') end = cursor + 1
    return end
  }
  const stack = []
  let sawCode = false
  for (let index = start; index < masked.length; index += 1) {
    const character = masked[index]
    if (!/\s/.test(character)) sawCode = true
    if (character === '(') stack.push(')')
    else if (character === '[') stack.push(']')
    else if (character === '{') stack.push('}')
    else if (character === ')' || character === ']' || character === '}') {
      if (stack.at(-1) !== character) return null
      stack.pop()
    } else if (character === ';' && stack.length === 0) {
      return index + 1
    } else if (character === '\n' && stack.length === 0 && sawCode) {
      const next = skipLexicalWhitespace(masked, index + 1)
      const startsDeclaration = /^export\b|^(?:const|let|function|class|var|interface)\b/.test(masked.slice(next))
      const previous = masked.slice(start, index).trimEnd().at(-1)
      if (startsDeclaration && previous && !'=,+-*/%?:.'.includes(previous)) return index
    }
  }
  return stack.length === 0 && sawCode ? masked.length : null
}

function spanFor(source, start, end, lineOf) {
  const safeStart = Math.max(0, Math.min(start, source.length))
  const safeEnd = Math.max(safeStart, Math.min(end, source.length))
  return { start: lineOf(safeStart), end: lineOf(Math.max(safeStart, safeEnd - 1)) }
}

function signatureFor(source, masked, start, end, kind, lineOf) {
  let signatureEnd = end
  if (declarationBlockKind(masked, start, kind)) {
    const open = declarationBodyOpen(masked, start, declarationBlockKind(masked, start, kind))
    if (open >= 0 && open < end) signatureEnd = open + 1
  } else if (kind === 'const' || kind === 'let') {
    const equals = masked.indexOf('=', start)
    if (equals >= 0 && equals < end) signatureEnd = equals + 1
  }
  return {
    signatureSpan: spanFor(source, start, signatureEnd, lineOf),
    signature: source.slice(start, signatureEnd).trim(),
  }
}

function addLocalDeclaration(locals, name, start, span) {
  if (!name) return
  const list = locals.get(name) || []
  list.push({ start, span })
  locals.set(name, list)
}

function variableNames(source, masked, start, end, kind) {
  if (kind !== 'const' && kind !== 'let') return []
  const keyword = masked.slice(start, end).match(/\b(?:const|let)\b/)
  if (!keyword) return []
  const keywordEnd = start + keyword.index + keyword[0].length
  const names = []
  let cursor = keywordEnd
  let expectName = true
  const stack = []
  for (; cursor < end; cursor += 1) {
    const character = masked[cursor]
    if (character === '(') stack.push(')')
    else if (character === '[') stack.push(']')
    else if (character === '{') stack.push('}')
    else if (character === ')' || character === ']' || character === '}') stack.pop()
    if (stack.length !== 0) continue
    if (expectName) {
      const match = masked.slice(cursor).match(/^[ \t]*([A-Za-z_$][\w$]*)/)
      if (match) {
        names.push(match[1])
        cursor += match[0].length - 1
        expectName = false
      }
    } else if (character === ',') {
      expectName = true
    }
  }
  return names
}

function localDeclarationMap(source, masked, lineOf) {
  const locals = new Map()
  const declaration = /(?:^|(?<=[;\n]))[ \t]*(?:export\s+)?(?:(?:async)\s+)?(function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of masked.matchAll(declaration)) {
    const start = match.index + match[0].search(/(?:export|function|class|const|let)/)
    const kind = match[1]
    const end = declarationEnd(source, masked, start, kind)
    if (end === null) continue
    const span = spanFor(source, start, end, lineOf)
    for (const name of variableNames(source, masked, start, end, kind)) addLocalDeclaration(locals, name, start, span)
    if (kind === 'function' || kind === 'class') addLocalDeclaration(locals, match[2], start, span)
  }
  return locals
}

function splitExportMembers(source, masked, start, end) {
  const members = []
  let pieceStart = start
  const stack = []
  for (let index = start; index < end; index += 1) {
    const character = masked[index]
    if (character === '(') stack.push(')')
    else if (character === '[') stack.push(']')
    else if (character === '{') stack.push('}')
    else if (character === ')' || character === ']' || character === '}') stack.pop()
    else if (character === ',' && stack.length === 0) {
      members.push(source.slice(pieceStart, index))
      pieceStart = index + 1
    }
  }
  members.push(source.slice(pieceStart, end))
  return members
}

export function exportedSymbolEntries(source) {
  const entries = []
  const lineOf = lineIndex(source)
  const masked = maskLexical(source)
  const locals = localDeclarationMap(source, masked, lineOf)
  const unsupported = new Set(UNSUPPORTED_EXPORT_FORMS)
  const add = (name, start, end, kind, bodySpan = null) => {
    const signature = signatureFor(source, masked, start, end, kind, lineOf)
    entries.push({ name, line: lineOf(start), ...signature, bodySpan })
  }

  for (const match of masked.matchAll(EXPORTED_DECLARATION)) {
    const form = match[1]
    if (unsupported.has(form)) continue
    const start = match.index
    const end = declarationEnd(source, masked, start, form)
    if (end === null) continue
    const bodySpan = spanFor(source, start, end, lineOf)
    add(match[2], start, end, form, bodySpan)
  }

  for (const match of masked.matchAll(EXPORTED_DEFAULT)) {
    if (!INCLUDE_DEFAULT_EXPORT) continue
    const start = match.index
    const end = declarationEnd(source, masked, start, 'default')
    if (end === null) continue
    const bodySpan = spanFor(source, start, end, lineOf)
    add('default', start, end, 'default', bodySpan)
  }

  for (const match of masked.matchAll(EXPORTED_LIST)) {
    const start = match.index
    const scanned = scanExportListEnd(source, masked, start)
    if (!scanned) continue
    const signatureSpan = spanFor(source, start, scanned.end, lineOf)
    const signature = source.slice(start, scanned.end).trim()
    const members = splitExportMembers(source, masked, start + masked.slice(start).indexOf('{') + 1, scanned.close)
    const selected = INCLUDE_ALL_LIST_MEMBERS ? members : members.slice(0, 1)
    for (const part of selected) {
      const item = part.trim()
      if (!item) continue
      const alias = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      const plain = item.match(/^([A-Za-z_$][\w$]*)$/)
      const local = alias ? alias[1] : plain?.[1]
      const name = alias ? alias[2] : plain?.[1]
      if (!local || !name) continue
      let bodySpan = null
      if (RESOLVE_LOCAL_LIST_BODIES && !scanned.from) {
        const matches = locals.get(local) || []
        if (matches.length === 1) bodySpan = matches[0].span
      }
      entries.push({ name, line: lineOf(start), signatureSpan, signature, bodySpan })
    }
  }
  return entries
}

export function isCodeFile(filePath) {
  return !nonEmptyString(filePath)
    || CODE_EXTENSIONS.includes(extname(String(filePath)).toLowerCase())
}

export function exportEntries(source, filePath = '') {
  ({ source, filePath } = normaliseSourceInput(source, filePath))
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  if (!isCodeFile(filePath)) return []
  return exportedSymbolEntries(source).sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
