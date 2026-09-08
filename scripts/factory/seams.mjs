#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, posix, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveProtectedPaths } from '../../crew/protected-paths.mjs'

export { resolveProtectedPaths }

const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.svelte'])
const JS_EXTENSIONS = new Set(['.mjs', '.js'])
const CLOSED_REASONS = new Set([
  'unsupported_extension',
  'syntax_error',
  'read_error',
  'no_exported_symbols',
  'unsupported_export_all',
  'no_top_level_test_blocks',
  'ambiguous_file_under_test',
])
const CAVEAT = 'Static imports are a proxy: computed imports can be invisible, and unused imports can create phantom edges. Clean clusters measure split cost; they do not decide whether a split is right.'
const STAGE_HEAD_CAVEAT = 'Stage-head attribution is file-level static attribution, not a runtime claim.'

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

class CorpusError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CorpusError'
  }
}

function normalisePath(value) {
  return String(value).replaceAll('\\', '/')
}

function normaliseTrackedPath(value) {
  const path = normalisePath(value)
  if (path === './') return '.'
  return path.startsWith('./') ? path.slice(2) : path
}

function gitTrackedFiles(root) {
  let result
  try {
    result = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 10000,
    })
  } catch (error) {
    throw new CorpusError(`unable to establish git corpus: ${error?.code || error?.message || 'spawn_error'}`)
  }
  if (!result || result.error || result.status !== 0 || result.signal) {
    const detail = result?.error?.code || result?.error?.message || result?.signal || `status_${result?.status ?? 'unknown'}`
    throw new CorpusError(`unable to establish git corpus: ${detail}`)
  }
  if (typeof result.stdout !== 'string') {
    throw new CorpusError('unable to establish git corpus: empty git output')
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map(normaliseTrackedPath)
    .filter((path, index, paths) => path && paths.indexOf(path) === index)
    .sort()
}

function isCodePath(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase())
}

function isTestFile(path) {
  const base = basename(path)
  return path.startsWith('test/') || /(?:\.test|\.spec)\.[^.]+$/.test(base)
}

function validateTarget(target, tracked) {
  if (typeof target !== 'string' || !target.trim()) {
    throw new UsageError('usage: node scripts/factory/seams.mjs <repo-relative-file>')
  }
  const raw = normalisePath(target)
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new UsageError('target must be a tracked repository-relative file')
  }
  const candidate = normaliseTrackedPath(posix.normalize(raw))
  if (!candidate || candidate === '.' || candidate.startsWith('../') || candidate.includes('/../') || candidate.includes('\0')) {
    throw new UsageError('target must be a tracked repository-relative file')
  }
  if (!tracked.has(candidate)) {
    throw new UsageError(`target is not tracked: ${candidate}`)
  }
  return candidate
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
])

function regexCanStartAfter(lastSignificant) {
  return lastSignificant === 'prefix'
}

function maskSource(source) {
  const chars = source.split('')
  let mode = 'code'
  let escaped = false
  let regexCharacterClass = false
  let lastSignificant = 'prefix'
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index]
    const next = chars[index + 1]
    if (mode === 'line-comment') {
      if (current === '\n' || current === '\r') mode = 'code'
      else chars[index] = ' '
      continue
    }
    if (mode === 'block-comment') {
      if (current === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        mode = 'code'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (escaped) {
        if (current !== '\n' && current !== '\r') chars[index] = ' '
        escaped = false
      } else if (current === '\\') {
        chars[index] = ' '
        escaped = true
      } else if ((mode === 'single' && current === "'") || (mode === 'double' && current === '"') || (mode === 'template' && current === '`')) {
        chars[index] = ' '
        mode = 'code'
        lastSignificant = 'value'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (mode === 'regex') {
      if (current === '\n' || current === '\r') {
        mode = 'code'
        escaped = false
        regexCharacterClass = false
      } else if (escaped) {
        chars[index] = ' '
        escaped = false
      } else if (current === '\\') {
        chars[index] = ' '
        escaped = true
      } else if (current === '[') {
        chars[index] = ' '
        regexCharacterClass = true
      } else if (current === ']') {
        chars[index] = ' '
        regexCharacterClass = false
      } else if (current === '/' && !regexCharacterClass) {
        chars[index] = ' '
        let flag = index + 1
        while (/[A-Za-z]/.test(chars[flag] || '')) {
          chars[flag] = ' '
          flag += 1
        }
        index = flag - 1
        mode = 'code'
      } else {
        chars[index] = ' '
      }
      continue
    }
    if (current === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      mode = 'line-comment'
    } else if (current === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      mode = 'block-comment'
    } else if (current === '/' && regexCanStartAfter(lastSignificant)) {
      chars[index] = ' '
      mode = 'regex'
      escaped = false
      regexCharacterClass = false
      lastSignificant = 'value'
    } else if (current === "'") {
      chars[index] = ' '
      mode = 'single'
    } else if (current === '"') {
      chars[index] = ' '
      mode = 'double'
    } else if (current === '`') {
      chars[index] = ' '
      mode = 'template'
    } else if (/[A-Za-z_$]/.test(current)) {
      let end = index + 1
      while (/[A-Za-z0-9_$]/.test(chars[end] || '')) end += 1
      const word = chars.slice(index, end).join('')
      lastSignificant = REGEX_PREFIX_KEYWORDS.has(word) ? 'prefix' : 'value'
      index = end - 1
    } else if (/[0-9]/.test(current) || current === ')' || current === ']' || current === '}') {
      lastSignificant = 'value'
    } else if (!/\s/.test(current)) {
      lastSignificant = 'prefix'
    }
  }
  return chars.join('')
}

function keywordAt(masked, index, keyword) {
  if (masked.slice(index, index + keyword.length) !== keyword) return false
  const before = masked[index - 1]
  const after = masked[index + keyword.length]
  return (!before || !/[A-Za-z0-9_$]/.test(before)) && (!after || !/[A-Za-z0-9_$]/.test(after))
}

function skipWhitespace(source, index) {
  let cursor = index
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  return cursor
}

function readQuoted(source, index) {
  const quote = source[index]
  if (quote !== "'" && quote !== '"') return null
  let cursor = index + 1
  let value = ''
  let escaped = false
  while (cursor < source.length) {
    const current = source[cursor]
    if (escaped) {
      value += current
      escaped = false
    } else if (current === '\\') {
      escaped = true
    } else if (current === quote) {
      return { value, end: cursor + 1 }
    } else {
      value += current
    }
    cursor += 1
  }
  return null
}

function findFromKeyword(masked, start) {
  let braces = 0
  let parens = 0
  let brackets = 0
  for (let index = start; index < masked.length; index += 1) {
    const current = masked[index]
    if (current === '{') braces += 1
    else if (current === '}') braces = Math.max(0, braces - 1)
    else if (current === '(') parens += 1
    else if (current === ')') parens = Math.max(0, parens - 1)
    else if (current === '[') brackets += 1
    else if (current === ']') brackets = Math.max(0, brackets - 1)
    else if (current === ';' && braces === 0 && parens === 0 && brackets === 0) return -1
    if (braces === 0 && parens === 0 && brackets === 0 && keywordAt(masked, index, 'from')) return index
  }
  return -1
}

function splitCommaList(text) {
  const entries = []
  let start = 0
  let braces = 0
  let parens = 0
  let brackets = 0
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]
    if (current === '{') braces += 1
    else if (current === '}') braces = Math.max(0, braces - 1)
    else if (current === '(') parens += 1
    else if (current === ')') parens = Math.max(0, parens - 1)
    else if (current === '[') brackets += 1
    else if (current === ']') brackets = Math.max(0, brackets - 1)
    else if (current === ',' && braces === 0 && parens === 0 && brackets === 0) {
      entries.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  entries.push(text.slice(start).trim())
  return entries.filter(Boolean)
}

function parseImportClause(clause) {
  const text = clause.trim().replace(/^type\s+/, '')
  const bindings = []
  const addNamed = (entry) => {
    const cleaned = entry.trim().replace(/^type\s+/, '')
    if (!cleaned) return
    const match = cleaned.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
    if (match) bindings.push({ kind: 'named', imported: match[1], local: match[2] || match[1] })
  }
  const braceStart = text.indexOf('{')
  const braceEnd = text.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    for (const entry of splitCommaList(text.slice(braceStart + 1, braceEnd))) addNamed(entry)
    const before = text.slice(0, braceStart).replace(/,\s*$/, '').trim()
    if (before) {
      if (/^\*\s+as\s+/.test(before)) {
        const namespace = before.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)/)
        if (namespace) bindings.push({ kind: 'namespace', local: namespace[1] })
      } else {
        const local = before.split(',')[0].trim().replace(/^type\s+/, '')
        if (/^[A-Za-z_$][\w$]*$/.test(local)) bindings.push({ kind: 'default', imported: 'default', local })
      }
    }
    return bindings
  }
  const parts = splitCommaList(text)
  if (parts.length > 1) {
    const defaultName = parts.shift()
    if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) bindings.push({ kind: 'default', imported: 'default', local: defaultName })
    for (const part of parts) {
      const namespace = part.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)
      if (namespace) bindings.push({ kind: 'namespace', local: namespace[1] })
    }
    return bindings
  }
  const namespace = text.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)
  if (namespace) {
    bindings.push({ kind: 'namespace', local: namespace[1] })
    return bindings
  }
  const defaultName = text.replace(/,\s*$/, '').trim()
  if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) bindings.push({ kind: 'default', imported: 'default', local: defaultName })
  return bindings
}

function parseImports(source, masked) {
  const imports = []
  const token = /\bimport\b/g
  let match
  while ((match = token.exec(masked))) {
    const keywordEnd = match.index + match[0].length
    let cursor = skipWhitespace(source, keywordEnd)
    if (source[cursor] === '(') continue
    if (source[cursor] === "'" || source[cursor] === '"') {
      const literal = readQuoted(source, cursor)
      if (literal) {
        imports.push({ specifier: literal.value, bindings: [], start: match.index, end: literal.end })
        token.lastIndex = literal.end
      }
      continue
    }
    const from = findFromKeyword(masked, keywordEnd)
    if (from < 0) continue
    const specifierStart = skipWhitespace(source, from + 4)
    const literal = readQuoted(source, specifierStart)
    if (!literal) continue
    imports.push({
      specifier: literal.value,
      bindings: parseImportClause(source.slice(keywordEnd, from)),
      start: match.index,
      end: literal.end,
    })
    token.lastIndex = literal.end
  }
  return imports
}

function findMatching(masked, open, opening = '{', closing = '}') {
  if (open < 0 || masked[open] !== opening) return -1
  let depth = 0
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === opening) depth += 1
    else if (masked[index] === closing) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function statementEnd(masked, start, kind) {
  if (kind === 'function' || kind === 'class') {
    const open = masked.indexOf('{', start)
    if (open >= 0) {
      const close = findMatching(masked, open)
      if (close >= 0) return close + 1
    }
  }
  let braces = 0
  let parens = 0
  let brackets = 0
  let fallback = masked.length
  for (let index = start; index < masked.length; index += 1) {
    const current = masked[index]
    if (current === '{') braces += 1
    else if (current === '}') braces = Math.max(0, braces - 1)
    else if (current === '(') parens += 1
    else if (current === ')') parens = Math.max(0, parens - 1)
    else if (current === '[') brackets += 1
    else if (current === ']') brackets = Math.max(0, brackets - 1)
    else if (current === ';' && braces === 0 && parens === 0 && brackets === 0) return index + 1
    else if ((current === '\n' || current === '\r') && braces === 0 && parens === 0 && brackets === 0 && fallback === masked.length) {
      fallback = index
    }
  }
  return fallback === masked.length ? masked.length : fallback
}

function lineStartsFor(source) {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function lineNumber(source, offset, starts) {
  if (!starts) {
    let line = 1
    for (let index = 0; index < offset && index < source.length; index += 1) {
      if (source[index] === '\n') line += 1
    }
    return line
  }
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle] <= offset) low = middle
    else high = middle
  }
  return low + 1
}

function spanFor(source, start, end, starts) {
  const safeStart = Math.max(0, Math.min(start, source.length))
  const safeEnd = Math.max(safeStart, Math.min(end, source.length))
  return {
    start: lineNumber(source, safeStart, starts),
    end: lineNumber(source, Math.max(safeStart, safeEnd - 1), starts),
  }
}

function declarationSpan(source, masked, start, kind, endHint = start, starts) {
  const end = statementEnd(masked, start, kind)
  return spanFor(source, start, Math.max(end, endHint), starts)
}

function parseVariableNames(source, masked, start, end) {
  const text = source.slice(start, end)
  const names = []
  const match = text.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)
  if (match) names.push(match[1])
  return names
}

function parseModule(path, source) {
  const masked = maskSource(source)
  const lineStarts = lineStartsFor(source)
  const localDeclarations = new Map()
  const declarationRe = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g
  let declaration
  while ((declaration = declarationRe.exec(masked))) {
    const keywordMatch = masked.slice(declaration.index, declaration.index + declaration[0].length).match(/\b(const|let|var|function|class)\b/)
    const kind = keywordMatch?.[1] || 'const'
    const end = statementEnd(masked, declaration.index, kind)
    for (const name of kind === 'const' || kind === 'let' || kind === 'var'
      ? parseVariableNames(source, masked, declaration.index, end)
      : [declaration[1]]) {
      localDeclarations.set(name, { startOffset: declaration.index, span: spanFor(source, declaration.index, end, lineStarts) })
    }
  }

  const exports = []
  const exportedNames = new Set()
  const addExport = (name, local, span) => {
    if (!name || exportedNames.has(name)) return
    exportedNames.add(name)
    exports.push({ name, local: local || name, span })
  }

  const declarationExportRe = /\bexport\s+(?:(?:async\s+)?function|class|(?:const|let|var))\s+([A-Za-z_$][\w$]*)/g
  let exported
  while ((exported = declarationExportRe.exec(masked))) {
    const keyword = exported[0].match(/\b(function|class|const|let|var)\b/)?.[1] || 'const'
    const span = declarationSpan(source, masked, exported.index, keyword, exported.index + exported[0].length, lineStarts)
    addExport(exported[1], exported[1], span)
    localDeclarations.set(exported[1], { startOffset: exported.index, span })
  }

  const defaultRe = /\bexport\s+default\b/g
  while ((exported = defaultRe.exec(masked))) {
    const after = skipWhitespace(source, exported.index + exported[0].length)
    const tail = masked.slice(after)
    const kindMatch = tail.match(/^(?:(?:async\s+)?function|class)\b/)
    const kind = kindMatch ? (tail.includes('class') && tail.indexOf('class') < tail.indexOf('function') ? 'class' : 'function') : 'const'
    const span = declarationSpan(source, masked, exported.index, kind, after + (kindMatch?.[0].length || 0), lineStarts)
    let local = 'default'
    if (kindMatch) {
      const nameMatch = tail.slice(kindMatch[0].length).match(/^\s+([A-Za-z_$][\w$]*)/)
      if (nameMatch) {
        local = nameMatch[1]
        localDeclarations.set(local, { startOffset: exported.index, span })
      }
    }
    addExport('default', local, span)
  }

  const exportListRe = /\bexport\s*\{/g
  let exportList
  while ((exportList = exportListRe.exec(masked))) {
    const open = masked.indexOf('{', exportList.index)
    const close = findMatching(masked, open)
    if (close < 0) continue
    const span = spanFor(source, exportList.index, close + 1, lineStarts)
    for (const entry of splitCommaList(source.slice(open + 1, close))) {
      const cleaned = entry.trim().replace(/^type\s+/, '')
      const parts = cleaned.split(/\s+as\s+/)
      const local = parts[0]?.trim()
      const name = (parts[1] || local)?.trim()
      if (!/^[A-Za-z_$][\w$]*$/.test(local || '') || !/^[A-Za-z_$][\w$]*$/.test(name || '')) continue
      addExport(name, local, localDeclarations.get(local)?.span || span)
    }
    exportListRe.lastIndex = close + 1
  }

  const stageHeads = []
  const stageRe = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*(?:STAGE_HEADS|STAGE_HEAD))\b/g
  while ((declaration = stageRe.exec(masked))) stageHeads.push(declaration[1])

  return {
    path,
    source,
    masked,
    lineStarts,
    imports: parseImports(source, masked),
    exports: exports.sort((a, b) => a.name.localeCompare(b.name)),
    unsupportedExportAll: /\bexport\s*\*/.test(masked),
    stageHeads: [...new Set(stageHeads)].sort(),
  }
}

function resolveSpecifier(specifier, importerPath, trackedSet) {
  if (typeof specifier !== 'string' || (!specifier.startsWith('./') && !specifier.startsWith('../'))) return null
  const base = posix.normalize(posix.join(posix.dirname(importerPath), normalisePath(specifier)))
  if (base.startsWith('../') || base === '..' || base.startsWith('/')) return null
  const candidates = [base]
  if (!extname(base)) {
    for (const extension of ['.mjs', '.js', '.ts', '.svelte']) candidates.push(`${base}${extension}`)
  }
  for (const extension of ['.mjs', '.js', '.ts', '.svelte']) {
    if (base.endsWith(extension)) candidates.push(base)
  }
  for (const extension of ['.mjs', '.js', '.ts', '.svelte']) candidates.push(`${base}/index${extension}`)
  return candidates.map(normaliseTrackedPath).find((candidate) => trackedSet.has(candidate)) || null
}

function buildImportReferences(modules, trackedSet) {
  for (const module of modules.values()) {
    module.imports = module.imports.map((record) => ({
      ...record,
      resolved: resolveSpecifier(record.specifier, module.path, trackedSet),
    }))
  }
}

function importedSymbols(record, importedModule) {
  if (!importedModule) return []
  const names = new Set(importedModule.exports.map((entry) => entry.name))
  const symbols = new Set()
  for (const binding of record.bindings) {
    if (binding.kind === 'namespace') {
      for (const name of names) symbols.add(name)
    } else if (names.has(binding.imported)) {
      symbols.add(binding.imported)
    }
  }
  return [...symbols].sort()
}

function makeImporterSets(targetModule, modules) {
  const sets = new Map(targetModule.exports.map((entry) => [entry.name, new Set()]))
  for (const module of modules.values()) {
    for (const record of module.imports) {
      if (record.resolved !== targetModule.path) continue
      for (const symbol of importedSymbols(record, targetModule)) sets.get(symbol)?.add(module.path)
    }
  }
  return sets
}

function clusterExactSignatures(symbols, importerSets) {
  const groups = new Map()
  symbols.forEach((symbol, index) => {
    const importers = [...new Set(importerSets[index] || [])].sort()
    const signature = JSON.stringify(importers)
    if (!groups.has(signature)) groups.set(signature, { signature, importers, entries: [] })
    groups.get(signature).entries.push({ symbol, importers })
  })
  return [...groups.values()]
    .sort((a, b) => a.signature.localeCompare(b.signature))
    .map((group) => ({
      signature: group.signature,
      importer_signature: group.signature,
      importers: group.importers,
      importer_set: group.importers,
      symbols: group.entries.map((entry) => entry.symbol.name).sort(),
      spans: group.entries
        .sort((a, b) => a.symbol.name.localeCompare(b.symbol.name))
        .map((entry) => ({ symbol: entry.symbol.name, ...entry.symbol.span })),
    }))
}

function countEdges(symbols, importerSets, clusterBySymbol = new Map()) {
  let edges = 0
  let crossClusterEdges = 0
  for (let left = 0; left < symbols.length; left += 1) {
    for (let right = left + 1; right < symbols.length; right += 1) {
      const leftSet = new Set(importerSets[left] || [])
      const sharesImporter = (importerSets[right] || []).some((path) => leftSet.has(path))
      if (!sharesImporter) continue
      edges += 1
      if (clusterBySymbol.get(symbols[left].name) !== clusterBySymbol.get(symbols[right].name)) crossClusterEdges += 1
    }
  }
  return { edges, crossClusterEdges }
}

function sourceAnalysis(context) {
  const targetModule = context.modules.get(context.target)
  if (!targetModule) return { clusters: null, cluster_reason: 'read_error', symbols_clustered: 0, edges_counted: 0, cross_cluster_edges: 0 }
  if (targetModule.unsupportedExportAll) return { clusters: null, cluster_reason: 'unsupported_export_all', symbols_clustered: 0, edges_counted: 0, cross_cluster_edges: 0 }
  if (targetModule.exports.length === 0) return { clusters: null, cluster_reason: 'no_exported_symbols', symbols_clustered: 0, edges_counted: 0, cross_cluster_edges: 0 }

  const symbols = targetModule.exports
  const setsByName = makeImporterSets(targetModule, context.modules)
  const importerSets = symbols.map((symbol) => [...(setsByName.get(symbol.name) || [])].sort())
  const clusters = clusterExactSignatures(symbols, importerSets)
  const clusterBySymbol = new Map()
  clusters.forEach((cluster, index) => cluster.symbols.forEach((symbol) => clusterBySymbol.set(symbol, index)))
  const edgeCounts = countEdges(symbols, importerSets, clusterBySymbol)
  for (const cluster of clusters) {
    const stageHeads = new Set()
    for (const importer of cluster.importers) {
      for (const head of context.modules.get(importer)?.stageHeads || []) stageHeads.add(head)
    }
    cluster.stage_heads = [...stageHeads].sort()
    cluster.stage_head_identifiers = cluster.stage_heads
    cluster.stage_head_references = cluster.stage_heads.length
  }
  return {
    clusters,
    symbols_clustered: symbols.length,
    edges_counted: edgeCounts.edges,
    cross_cluster_edges: edgeCounts.crossClusterEdges,
  }
}

function braceDepths(masked) {
  const depths = new Array(masked.length + 1).fill(0)
  let depth = 0
  for (let index = 0; index < masked.length; index += 1) {
    depths[index] = depth
    if (masked[index] === '{') depth += 1
    else if (masked[index] === '}') depth = Math.max(0, depth - 1)
  }
  depths[masked.length] = depth
  return depths
}

function topLevelTestBlocks(module) {
  const blocks = []
  const depths = braceDepths(module.masked)
  const callRe = /\b(test|describe)\s*\(/g
  let match
  while ((match = callRe.exec(module.masked))) {
    if (depths[match.index] !== 0) continue
    const open = module.masked.indexOf('(', match.index + match[0].length - 1)
    const close = findMatching(module.masked, open, '(', ')')
    if (close < 0) continue
    const bodyOpen = module.masked.indexOf('{', open + 1)
    let end = close + 1
    if (bodyOpen >= 0 && bodyOpen < close) {
      const bodyClose = findMatching(module.masked, bodyOpen)
      if (bodyClose >= 0) end = bodyClose + 1
    }
    blocks.push({ kind: match[1], startOffset: match.index, endOffset: end, span: spanFor(module.source, match.index, end, module.lineStarts) })
    callRe.lastIndex = Math.max(callRe.lastIndex, end)
  }
  return blocks
}

function blockSymbols(module, block, targetModule) {
  const text = module.source.slice(block.startOffset, block.endOffset)
  const masked = module.masked.slice(block.startOffset, block.endOffset)
  const names = new Set()
  const exports = new Set(targetModule?.exports.map((entry) => entry.name) || [])
  for (const record of module.imports) {
    if (record.resolved !== targetModule?.path) continue
    for (const binding of record.bindings) {
      if (binding.kind === 'namespace') {
        const namespaceRe = new RegExp(`\\b${escapeRegExp(binding.local)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
        let property
        while ((property = namespaceRe.exec(masked))) {
          if (exports.has(property[1])) names.add(property[1])
        }
      } else {
        const localRe = new RegExp(`\\b${escapeRegExp(binding.local)}\\b`)
        if (localRe.test(masked)) names.add(binding.imported)
      }
    }
  }
  // Keep the source text in the local scope: this deliberately makes alias
  // matching lexical and does not infer computed property access.
  void text
  return [...names].sort()
}

function testAnalysis(context) {
  const testModule = context.modules.get(context.target)
  if (!testModule) return { clusters: null, cluster_reason: 'read_error', symbols_clustered: 0, edges_counted: 0, cross_cluster_edges: 0 }
  const blocks = topLevelTestBlocks(testModule)
  if (blocks.length === 0) return { clusters: null, cluster_reason: 'no_top_level_test_blocks', symbols_clustered: 0, edges_counted: 0, cross_cluster_edges: 0 }

  const candidates = new Map()
  const blockSymbolsByModule = new Map()
  for (const block of blocks) {
    for (const record of testModule.imports) {
      if (!record.resolved) continue
      const importedModule = context.modules.get(record.resolved)
      if (!importedModule) continue
      const symbols = blockSymbols(testModule, block, importedModule)
      if (symbols.length === 0) continue
      if (!candidates.has(record.resolved)) candidates.set(record.resolved, new Set())
      candidates.get(record.resolved).add(block)
      if (!blockSymbolsByModule.has(record.resolved)) blockSymbolsByModule.set(record.resolved, new Map())
      const perBlock = blockSymbolsByModule.get(record.resolved)
      perBlock.set(block, [...new Set([...(perBlock.get(block) || []), ...symbols])].sort())
    }
  }
  const ranked = [...candidates.entries()]
    .map(([path, used]) => ({ path, count: used.size }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0].count === ranked[1].count)) {
    return { clusters: null, cluster_reason: 'ambiguous_file_under_test', symbols_clustered: 0, edges_counted: 0, cross_cluster_edges: 0 }
  }
  const selected = context.modules.get(ranked[0].path)
  const selectedSymbols = blockSymbolsByModule.get(ranked[0].path) || new Map()
  const groups = new Map()
  const allSymbols = new Set()
  const importerSets = new Map()
  blocks.forEach((block, index) => {
    const symbols = [...(selectedSymbols.get(block) || [])].sort()
    symbols.forEach((symbol) => allSymbols.add(symbol))
    const signature = JSON.stringify(symbols)
    if (!groups.has(signature)) groups.set(signature, { symbols, blocks: [] })
    groups.get(signature).blocks.push({ kind: block.kind, ...block.span })
    for (const symbol of symbols) {
      if (!importerSets.has(symbol)) importerSets.set(symbol, new Set())
      importerSets.get(symbol).add(String(index))
    }
  })
  const clusters = [...groups.values()]
    .sort((a, b) => JSON.stringify(a.symbols).localeCompare(JSON.stringify(b.symbols)))
    .map((group) => ({
      signature: JSON.stringify(group.symbols),
      importer_signature: JSON.stringify(group.symbols),
      symbols: group.symbols,
      blocks: group.blocks.sort((a, b) => a.start - b.start),
      spans: group.blocks,
      file_under_test: selected.path,
    }))
  const symbols = [...allSymbols].sort().map((name) => ({ name }))
  const sets = symbols.map((symbol) => [...(importerSets.get(symbol.name) || [])].sort())
  const clusterBySymbol = new Map()
  clusters.forEach((cluster, index) => cluster.symbols.forEach((symbol) => clusterBySymbol.set(symbol, index)))
  const edgeCounts = countEdges(symbols, sets, clusterBySymbol)
  return {
    clusters,
    symbols_clustered: allSymbols.size,
    edges_counted: edgeCounts.edges,
    cross_cluster_edges: edgeCounts.crossClusterEdges,
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function protectedFloorContains(target) {
  const floor = resolveProtectedPaths()
  return floor.some((path) => {
    const normal = normaliseTrackedPath(path)
    return target === normal || (normal.endsWith('/') && target.startsWith(normal))
  })
}

function collectTestsReaching(target, modules) {
  const reaching = []
  for (const module of modules.values()) {
    if (!isTestFile(module.path)) continue
    if (module.imports.some((record) => record.resolved === target)) reaching.push(module.path)
  }
  return reaching.sort()
}

function collectFenceCost({ root, tracked, target, skipped, modules, corpusParsed }) {
  const candidates = new Set(tracked.filter((path) => path.endsWith('/anchors.json') || path === 'crew/roles/anchors.json'))
  const manifests = []
  let pins = 0
  const pinsByManifest = {}
  for (const path of [...candidates].sort()) {
    let text
    try {
      text = readFileSync(join(root, ...path.split('/')), 'utf8')
    } catch {
      skipped.push({ path, reason: 'manifest_unreadable' })
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      skipped.push({ path, reason: 'manifest_invalid' })
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped.push({ path, reason: 'manifest_invalid' })
      continue
    }
    manifests.push(path)
    let count = 0
    for (const key of Object.keys(parsed)) {
      const at = key.lastIndexOf(':')
      if (at < 1 || !/^\d+$/.test(key.slice(at + 1))) continue
      if (normaliseTrackedPath(key.slice(0, at)) === target) count += 1
    }
    pins += count
    pinsByManifest[path] = count
  }
  return {
    anchors: { manifests: manifests.sort(), pins, manifest_count: manifests.length, pins_by_manifest: pinsByManifest },
    tests_reaching: corpusParsed ? collectTestsReaching(target, modules) : null,
    protected_floor: protectedFloorContains(target),
  }
}

function addSkipped(skipped, path, reason) {
  if (!skipped.some((entry) => entry.path === path && entry.reason === reason)) skipped.push({ path, reason })
}

function checkTargetSyntax(root, target) {
  if (!JS_EXTENSIONS.has(extname(target).toLowerCase())) return null
  const absoluteTarget = join(root, ...target.split('/'))
  let result
  try {
    result = spawnSync(process.execPath, ['--check', absoluteTarget], {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })
  } catch {
    return 'syntax_error'
  }
  return result?.error || result?.signal || result?.status !== 0 ? 'syntax_error' : null
}

function emptyAnalysis(reason) {
  return { clusters: null, cluster_reason: CLOSED_REASONS.has(reason) ? reason : 'read_error', symbols_clustered: 0, edges_counted: 0, cross_cluster_edges: 0 }
}

function buildReport({ target, targetKind, analysis, filesScanned, skipped, fenceCost }) {
  const denominators = {
    files_scanned: filesScanned,
    symbols_clustered: analysis.symbols_clustered,
    edges_counted: analysis.edges_counted,
    skipped: [...skipped].sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
  }
  return {
    target,
    target_kind: targetKind,
    clusters: analysis.clusters,
    ...(analysis.cluster_reason ? { cluster_reason: analysis.cluster_reason } : {}),
    edges_counted: analysis.edges_counted,
    cross_cluster_edges: analysis.cross_cluster_edges,
    fence_cost: fenceCost,
    caveat: CAVEAT,
    blind_spots: [CAVEAT, STAGE_HEAD_CAVEAT],
    denominators,
  }
}

export function seamReport({ root = process.cwd(), target: requestedTarget } = {}) {
  const absoluteRoot = resolve(root)
  const tracked = gitTrackedFiles(root)
  const trackedSet = new Set(tracked)
  const target = validateTarget(requestedTarget, trackedSet)
  const skipped = []
  const codePaths = tracked.filter(isCodePath)
  const sources = new Map()
  let filesScanned = 0
  for (const path of codePaths) {
    filesScanned += 1
    try {
      sources.set(path, readFileSync(join(absoluteRoot, ...path.split('/')), 'utf8'))
    } catch {
      addSkipped(skipped, path, 'read_error')
    }
  }
  const targetExtension = extname(target).toLowerCase()
  const targetRead = sources.has(target)
  const modules = new Map()
  if (targetRead) {
    for (const [path, source] of sources) modules.set(path, parseModule(path, source))
    buildImportReferences(modules, new Set(codePaths))
  }
  let analysis
  if (!CODE_EXTENSIONS.has(targetExtension)) {
    addSkipped(skipped, target, 'unsupported_extension')
    analysis = emptyAnalysis('unsupported_extension')
  } else if (!targetRead) {
    addSkipped(skipped, target, 'read_error')
    analysis = emptyAnalysis('read_error')
  } else {
    const syntaxReason = checkTargetSyntax(absoluteRoot, target)
    if (syntaxReason) {
      addSkipped(skipped, target, syntaxReason)
      analysis = emptyAnalysis(syntaxReason)
    } else {
      const context = { root: absoluteRoot, target, modules, tracked: codePaths }
      const analysis = isTestFile(target) ? analyseTestTarget(context) : analyseSourceTarget(context)
      const fenceCost = collectFenceCost({ root: absoluteRoot, tracked, target, skipped, modules, corpusParsed: targetRead })
      return buildReport({
        target,
        targetKind: isTestFile(target) ? 'test' : 'source',
        analysis,
        filesScanned,
        skipped,
        fenceCost,
      })
    }
  }
  const fenceCost = collectFenceCost({ root: absoluteRoot, tracked, target, skipped, modules, corpusParsed: targetRead })
  return buildReport({
    target,
    targetKind: isTestFile(target) ? 'test' : 'source',
    analysis,
    filesScanned,
    skipped,
    fenceCost,
  })
}

// These aliases keep the branch and its public vocabulary explicit while the
// scanner remains one corpus pass: all module text is already in `context`.
function analyseSourceTarget(context) {
  return sourceAnalysis(context)
}

function analyseTestTarget(context) {
  return testAnalysis(context)
}

export function main(argv = process.argv.slice(2), options = {}) {
  const args = Array.isArray(argv) ? argv : []
  const output = options.stdout || process.stdout
  const errorOutput = options.stderr || process.stderr
  const write = (stream, text) => {
    if (typeof stream === 'function') stream(text)
    else if (stream && typeof stream.write === 'function') stream.write(text)
  }
  if (args.length !== 1 || typeof args[0] !== 'string' || !args[0].trim()) {
    write(errorOutput, 'usage: node scripts/factory/seams.mjs <repo-relative-file>\n')
    return 2
  }
  try {
    const report = seamReport({ root: options.root || process.cwd(), target: args[0] })
    write(output, `${JSON.stringify(report)}\n`)
    return 0
  } catch (error) {
    write(errorOutput, `${error?.message || 'unable to produce seam report'}\n`)
    return 2
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
