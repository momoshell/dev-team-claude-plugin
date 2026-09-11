import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'

export const CENSUS_FULL_SUITE_SECONDS = 52
export const CENSUS_MEASUREMENT_REASONS = Object.freeze([
  'inventory-denied', 'inventory-interrupted', 'inventory-unknown', 'inventory-empty', 'inventory-malformed',
  'candidate-denied', 'candidate-interrupted', 'candidate-unknown', 'candidate-empty',
  'runner-denied', 'runner-interrupted', 'runner-unknown', 'runner-empty', 'runner-malformed',
  'selection-clock-unavailable', 'clock-unavailable', 'empty-selection', 'empty-output', 'empty-denominator', 'malformed-output',
])

const TEST_SUFFIX = '.test.mjs'
const ALLOWED_DATA_CALLBACKS = new Set(['filter', 'map', 'flatMap', 'reduce', 'some', 'every', 'find', 'findIndex', 'sort'])
const CALLBACK_NAME = /(?:fixture|inject|callback|fake|stub|sandbox|harness|scenario|setup|teardown|with[A-Z])/i
const OPENERS = new Map([['(', ')'], ['[', ']'], ['{', '}']])
const CLOSERS = new Map([[')', '('], [']', '['], ['}', '{']])

const blank = (chars, start, end) => {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }
}

function decodeLiteral(raw) {
  if (typeof raw !== 'string' || raw.length < 2) return null
  if (raw[0] === '`') return raw.slice(1, -1)
  if (raw[0] === '"') {
    try { return JSON.parse(raw) } catch { return raw.slice(1, -1) }
  }
  return raw.slice(1, -1).replace(/\\([\\'"`])/g, '$1')
}

function scanSource(source) {
  const text = String(source ?? '')
  const chars = [...text]
  const tokens = []
  let index = 0
  let previous = null
  const add = (token) => { tokens.push(token); previous = token }
  const expressionSlash = () => {
    if (!previous) return true
    return previous.type === 'operator' && ['(', '[', '{', '=', ':', ',', ';', '!', '?', '=>', 'return'].includes(previous.value)
  }
  while (index < text.length) {
    const char = text[index]
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '/' && text[index + 1] === '/') {
      const start = index
      index += 2
      while (index < text.length && text[index] !== '\n') index += 1
      blank(chars, start, index)
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const start = index
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index = Math.min(text.length, index + 2)
      blank(chars, start, index)
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        if (text[index] === quote) { index += 1; break }
        index += 1
      }
      const raw = text.slice(start, index)
      add({ type: 'string', value: decodeLiteral(raw), raw, start, end: index })
      blank(chars, start, index)
      continue
    }
    if (char === '/' && expressionSlash()) {
      const start = index
      index += 1
      let closed = false
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        if (text[index] === '/') { index += 1; closed = true; break }
        if (text[index] === '\n' || text[index] === '\r') break
        index += 1
      }
      if (closed) {
        while (/[a-z]/i.test(text[index] || '')) index += 1
        blank(chars, start, index)
        add({ type: 'regex', value: null, raw: text.slice(start, index), start, end: index })
        continue
      }
      index = start
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index
      index += 1
      while (/[A-Za-z0-9_$]/.test(text[index] || '')) index += 1
      add({ type: 'identifier', value: text.slice(start, index), raw: text.slice(start, index), start, end: index })
      continue
    }
    if (/[0-9]/.test(char)) {
      const start = index
      index += 1
      while (/[A-Za-z0-9_.]/.test(text[index] || '')) index += 1
      add({ type: 'number', value: text.slice(start, index), raw: text.slice(start, index), start, end: index })
      continue
    }
    const operator = ['===', '!==', '>>>', '...', '=>', '==', '!=', '&&', '||', '??', '?.', '++', '--', '>=', '<=', '**', '+=', '-=', '*=', '/='].find((candidate) => text.startsWith(candidate, index))
    const value = operator || char
    add({ type: 'operator', value, raw: value, start: index, end: index + value.length })
    index += value.length
  }
  return { masked: chars.join(''), tokens }
}

function matchingToken(tokens) {
  const pairs = new Map()
  const stack = []
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value
    if (OPENERS.has(value)) stack.push({ value, index })
    else if (CLOSERS.has(value)) {
      const open = stack.at(-1)
      if (open && open.value === CLOSERS.get(value)) {
        stack.pop()
        pairs.set(open.index, index)
        pairs.set(index, open.index)
      }
    }
  }
  return pairs
}

function callbackBodySpans(source, scanned) {
  const { tokens } = scanned
  const pairs = matchingToken(tokens)
  const spans = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!['test', 'it', 'specify', 'describe'].includes(token.value) || tokens[index + 1]?.value !== '(') continue
    const close = pairs.get(index + 1)
    if (close === undefined) continue
    let body = null
    for (let cursor = index + 2; cursor < close; cursor += 1) {
      if (tokens[cursor].value === '=>' && tokens[cursor + 1]?.value === '{') {
        const end = pairs.get(cursor + 1)
        if (end !== undefined) { body = { start: tokens[cursor + 1].start + 1, end: tokens[end].start }; break }
      }
      if (tokens[cursor].value === 'function') {
        const brace = tokens.slice(cursor + 1, close).findIndex((entry) => entry.value === '{')
        if (brace >= 0) {
          const braceIndex = cursor + 1 + brace
          const end = pairs.get(braceIndex)
          if (end !== undefined) { body = { start: tokens[braceIndex].start + 1, end: tokens[end].start }; break }
        }
      }
    }
    if (body) spans.push(body)
  }
  const unique = new Map()
  for (const span of spans) unique.set(`${span.start}:${span.end}`, span)
  return [...unique.values()].sort((a, b) => a.start - b.start || b.end - a.end)
}

function callbackCallee(tokens, index, pairs) {
  let cursor = index - 1
  if (tokens[cursor]?.value === ')') {
    const open = pairs.get(cursor)
    cursor = open === undefined ? cursor - 1 : open - 1
  }
  if (tokens[cursor]?.value === '(') cursor -= 1
  if (tokens[cursor]?.value === '.') cursor -= 1
  if (tokens[cursor]?.type === 'identifier') return tokens[cursor].value
  if (tokens[index - 1]?.value === ':') return tokens[index - 2]?.value || null
  return null
}

function stripNestedCallbacks(raw, masked, startOffset, endOffset, tokens) {
  const localRaw = raw.slice(startOffset, endOffset)
  const localMasked = masked.slice(startOffset, endOffset)
  const rawChars = [...localRaw]
  const maskedChars = [...localMasked]
  const pairs = matchingToken(tokens)
  const remove = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.start < startOffset || token.start >= endOffset) continue
    let braceIndex = null
    if (token.value === '=>' && tokens[index + 1]?.value === '{') braceIndex = index + 1
    if (token.value === 'function') {
      const candidate = tokens.slice(index + 1).findIndex((entry) => entry.value === '{' && entry.start < endOffset)
      if (candidate >= 0) braceIndex = index + 1 + candidate
    }
    if (braceIndex === null) continue
    const endIndex = pairs.get(braceIndex)
    if (endIndex === undefined || tokens[endIndex].start >= endOffset) continue
    const callee = callbackCallee(tokens, index, pairs)
    if (!callee || ALLOWED_DATA_CALLBACKS.has(callee) || ['test', 'it', 'specify', 'describe'].includes(callee)) continue
    if (!CALLBACK_NAME.test(callee) && callee !== 'run') continue
    remove.push([tokens[braceIndex].start - startOffset, tokens[endIndex].end - startOffset])
  }
  for (const [start, end] of remove) {
    blank(rawChars, start, end)
    blank(maskedChars, start, end)
  }
  return { raw: rawChars.join(''), masked: maskedChars.join('') }
}

function executableTestBodies(source) {
  const scanned = scanSource(source)
  const spans = callbackBodySpans(source, scanned)
  return spans.map(({ start, end }) => {
    const body = stripNestedCallbacks(source, scanned.masked, start, end, scanned.tokens)
    return { start, end, raw: body.raw, masked: body.masked }
  })
}

function helperDefinitions(source, scanned) {
  const { tokens } = scanned
  const pairs = matchingToken(tokens)
  const defs = new Map()
  for (let index = 0; index < tokens.length; index += 1) {
    let name = null
    let braceIndex = null
    if (tokens[index].value === 'function' && tokens[index + 1]?.type === 'identifier') {
      name = tokens[index + 1].value
      braceIndex = tokens.slice(index + 2).findIndex((entry) => entry.value === '{')
      if (braceIndex >= 0) braceIndex += index + 2
    } else if (tokens[index].value === 'const' && tokens[index + 1]?.type === 'identifier' && tokens[index + 2]?.value === '=') {
      name = tokens[index + 1].value
      const arrow = tokens.slice(index + 3).findIndex((entry) => entry.value === '=>')
      if (arrow >= 0 && tokens[index + 3 + arrow + 1]?.value === '{') braceIndex = index + 3 + arrow + 1
    }
    if (!name || braceIndex === null || braceIndex < 0) continue
    const endIndex = pairs.get(braceIndex)
    if (endIndex === undefined) continue
    const start = tokens[braceIndex].start + 1
    const end = tokens[endIndex].start
    const raw = source.slice(start, end)
    const helperScan = scanSource(raw)
    defs.set(name, { name, start, end, raw, masked: helperScan.masked })
  }
  return defs
}

function fragmentsSource(fragments) {
  const raw = fragments.map((fragment) => fragment.raw).join('\n')
  const masked = fragments.map((fragment) => fragment.masked).join('\n')
  return { raw, masked, scanned: scanSource(raw) }
}

function identifierDeps(raw) {
  const scanned = scanSource(raw)
  const deps = new Set(scanned.tokens.filter((token) => token.type === 'identifier').map((token) => token.value))
  for (const match of String(raw).matchAll(/\$\{([\s\S]*?)\}/g)) {
    for (const token of scanSource(match[1]).tokens) if (token.type === 'identifier') deps.add(token.value)
  }
  return deps
}

function assignmentsOf(source) {
  const scanned = scanSource(source)
  const { tokens } = scanned
  const assignments = []
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!['const', 'let', 'var'].includes(tokens[index].value) || tokens[index + 1]?.type !== 'identifier' || tokens[index + 2]?.value !== '=') continue
    const startToken = tokens[index + 3]
    if (!startToken) continue
    const start = startToken.start
    let depth = 0
    let end = source.length
    for (let cursor = index + 3; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor].value
      if (OPENERS.has(value)) depth += 1
      else if (CLOSERS.has(value)) depth = Math.max(0, depth - 1)
      if (depth === 0 && value === ';') { end = tokens[cursor].start; break }
      if (depth === 0 && cursor > index + 3 && ['const', 'let', 'var'].includes(value)) {
        const previousEnd = tokens[cursor - 1]?.end ?? start
        if (source.slice(previousEnd, tokens[cursor].start).includes('\n')) { end = tokens[cursor].start; break }
      }
    }
    const raw = source.slice(start, end).trim()
    assignments.push({ name: tokens[index + 1].value, raw, masked: scanSource(raw).masked, deps: identifierDeps(raw) })
  }
  return assignments
}

function callsOf(source) {
  const scanned = scanSource(source)
  const { tokens } = scanned
  const pairs = matchingToken(tokens)
  const calls = []
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].type !== 'identifier') continue
    let open = index + 1
    let name = tokens[index].value
    while (tokens[open]?.value === '.' && tokens[open + 1]?.type === 'identifier') {
      name += `.${tokens[open + 1].value}`
      open += 2
    }
    if (tokens[open]?.value !== '(') continue
    const close = pairs.get(open)
    if (close === undefined) continue
    calls.push({ name, raw: source.slice(tokens[open].end, tokens[close].start), start: tokens[index].start, end: tokens[close].end })
  }
  return calls
}

function literalsIn(raw) {
  return scanSource(raw).tokens.filter((token) => token.type === 'string').map((token) => token.value).filter((value) => typeof value === 'string')
}

function hasUnscopedSeparator(raw) {
  return literalsIn(raw).includes('--') || /(?:^|[\s,'"`])--(?:[\s,'"`]|$)/.test(raw)
}

function unscopedInventory(raw, literals) {
  const argumentList = String(raw).match(/\[[\s\S]*?\]/)?.[0]
  const text = (argumentList ? literalsIn(argumentList) : literals).join(' ')
  const match = text.match(/\b(ls-files|ls-tree)\b([\s\S]*)$/)
  if (!match) return false
  const rest = match[2].trim().split(/\s+/).filter(Boolean)
  // `ls-files` takes only options once `--` is excluded (hasUnscopedSeparator does that).
  // `ls-tree` additionally REQUIRES a tree-ish, which restricts nothing about WHICH paths are
  // listed — but only when the tree-ish is bare. `HEAD:crew` is one token and lists that
  // subtree alone: measured 102 paths against 635 for `HEAD`. A tree-ish carrying a `:` is
  // therefore scoped, not checkout-wide.
  const bare = rest.filter((token) => !token.startsWith('-'))
  if (bare.some((token) => token.includes(':'))) return false
  return match[1] === 'ls-tree' ? bare.length <= 1 : bare.length === 0
}

// A call whose argument list is not wholly literal cannot be judged: a variable may carry a
// pathspec, and counting only the literals would score a scoped read as checkout-wide. An
// unreadable argument list is UNKNOWN, and unknown is not a pass.
function argumentsAllLiteral(raw) {
  const argumentList = String(raw).match(/\[[\s\S]*?\]/)?.[0]
  if (!argumentList) return true
  const inner = argumentList.slice(1, -1).trim()
  if (inner === '') return true
  const { tokens } = scanSource(inner)
  return tokens.every((token) => token.type === 'string' || token.value === ',' || token.type === 'punctuation')
}

function inventoryCall(call, helperDefs) {
  if (!call) return false
  const literals = literalsIn(call.raw)
  if (!argumentsAllLiteral(call.raw)) return false
  if (hasUnscopedSeparator(call.raw) || !unscopedInventory(call.raw, literals)) return false
  const namesInventory = (values) => values.includes('ls-files') || values.includes('ls-tree')
  if (['execFileSync', 'execSync', 'spawnSync'].includes(call.name)) {
    return literals[0] === 'git' && namesInventory(literals)
  }
  if (call.name === 'run') return /\bgit\b[\s\S]*\b(?:ls-files|ls-tree)\b/.test(literals.join(' '))
  if (call.name === 'git') return namesInventory(literals)
  const helper = helperDefs.get(call.name)
  if (!helper) return false
  const helperCalls = callsOf(helper.raw)
  const transport = helperCalls.some((candidate) => {
    if (!['execFileSync', 'execSync', 'spawnSync', 'run', 'git'].includes(candidate.name)) return false
    const values = literalsIn(candidate.raw)
    return values[0] === 'git' || candidate.name === 'run' || candidate.name === 'git'
  })
  return transport && namesInventory(literals)
}

function carrierReadable(raw) {
  if (!/(?:readText|readFileSync|readFile|readFileUtf8|readFileUTF8)\s*\(/.test(raw)) return false
  return !/import\.meta\.url|fileURLToPath\s*\(\s*import\.meta\.url/.test(raw)
}

function assertionCalls(source) {
  return callsOf(source).filter((call) => /^assert(?:\.|$)/.test(call.name))
}

function connectedFlow(fragments, helpers) {
  const combined = fragmentsSource(fragments)
  const assignments = assignmentsOf(combined.raw)
  const callAtStart = (expression) => {
    const local = callsOf(expression)
    return local.find((call) => call.start === 0 || expression.slice(0, call.start).trim() === '') || local[0] || null
  }
  const inventoryVars = new Set()
  for (const assignment of assignments) {
    const call = callAtStart(assignment.raw)
    if (inventoryCall(call, helpers)) inventoryVars.add(assignment.name)
  }
  if (inventoryVars.size === 0) return null

  const populationVars = new Set()
  for (const assignment of assignments) {
    const connected = [...inventoryVars].some((name) => assignment.deps.has(name))
    if (!connected || !/\.filter\s*\(/.test(assignment.masked) || !/test\.mjs/.test(assignment.raw) || !/Set/.test(assignment.masked)) continue
    populationVars.add(assignment.name)
  }
  if (populationVars.size < 1) return null

  const derived = new Set(populationVars)
  let changed = true
  while (changed) {
    changed = false
    for (const assignment of assignments) {
      if (derived.has(assignment.name)) continue
      if ([...derived].some((name) => assignment.deps.has(name))) { derived.add(assignment.name); changed = true }
    }
  }
  const measurementVars = new Set()
  for (const assignment of assignments) {
    if (!derived.has(assignment.name) || populationVars.has(assignment.name)) continue
    if (/measurement|measured|owners|pairs|count|total/i.test(assignment.name)
      || /\.size\b|\.length\b|\b(?:reduce|flatMap|map)\s*\(|\$\{/.test(assignment.raw)) measurementVars.add(assignment.name)
  }
  if (measurementVars.size === 0) return null

  const carriers = new Set(assignments.filter((assignment) => carrierReadable(assignment.raw)).map((assignment) => assignment.name))
  const mutableCarrierIn = (raw) => carriers.size > 0 && [...carriers].some((name) => identifierDeps(raw).has(name))
  for (const assertion of assertionCalls(combined.raw)) {
    const deps = identifierDeps(assertion.raw)
    const measurement = [...measurementVars].find((name) => deps.has(name))
    if (!measurement) continue
    if (mutableCarrierIn(assertion.raw) || (carrierReadable(assertion.raw) && !/import\.meta\.url/.test(assertion.raw))) return { measurement, population: [...populationVars] }
  }
  return null
}

function censusFlows(executable, helpers = executable.helpers) {
  if (!(helpers instanceof Map)) return []
  return executable.map((fragment) => {
    const calledHelpers = new Set()
    for (const token of scanSource(fragment.masked).tokens) {
      if (helpers.has(token.value)) calledHelpers.add(token.value)
    }
    const fragments = [fragment, ...[...calledHelpers].map((name) => helpers.get(name)).filter(Boolean)]
    return { qualifies: connectedFlow(fragments, helpers) !== null }
  })
}

function qualifies(source) {
  // This is intentionally the first analysis step. C2 mutates this one binding to
  // prove that source comments and embedded programs cannot stand in for a body.
  const executable = executableTestBodies(source)
  if (!Array.isArray(executable) || executable.length === 0) return null
  const scanned = scanSource(source)
  const helpers = helperDefinitions(source, scanned)
  Object.defineProperty(executable, 'helpers', { value: helpers })
  return censusFlows(executable).some(({ qualifies }) => qualifies)
}

function normalPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function asRepoPath(checkout, file) {
  const candidate = String(file ?? '')
  if (candidate.startsWith(`${checkout}/`)) return normalPath(relative(checkout, candidate))
  return normalPath(candidate)
}

function resultParts(result) {
  if (typeof result === 'string') return { valid: true, ok: true, output: result }
  if (!result || typeof result !== 'object') return { valid: false, ok: false, output: '' }
  const output = result.output ?? (typeof result.stdout === 'string' || typeof result.stderr === 'string' ? `${result.stdout || ''}${result.stderr || ''}` : null)
  if (typeof output !== 'string') return { valid: false, ok: false, output: '' }
  return { valid: true, ok: result.ok === true || result.status === 0 || result.code === 0, output }
}

function reasonForError(error, prefix) {
  const code = String(error?.code || error?.signal || '').toUpperCase()
  if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') return `${prefix}-denied`
  if (code === 'EINTR' || code === 'SIGINT' || code === 'SIGTERM' || code === 'ABORT_ERR' || error?.name === 'AbortError') return `${prefix}-interrupted`
  return `${prefix}-unknown`
}

function parseInventory(result, checkout) {
  const parsed = resultParts(result)
  if (!parsed.valid) return { files: [], reason: 'inventory-malformed' }
  if (!parsed.ok) return { files: [], reason: 'inventory-unknown' }
  if (parsed.output === '') return { files: [], reason: 'inventory-empty' }
  if (!parsed.output.endsWith('\0')) return { files: [], reason: 'inventory-malformed' }
  const files = parsed.output.split('\0').filter(Boolean).map((file) => asRepoPath(checkout, file))
  if (files.some((file) => file === '' || file.startsWith('../') || file.startsWith('/'))) return { files: [], reason: 'inventory-malformed' }
  return { files: [...new Set(files)], reason: null }
}

function defineSelectionMetadata(selection, metadata) {
  Object.defineProperties(selection, {
    reason: { value: metadata.reason ?? null, enumerable: false },
    inventory: { value: metadata.inventory ?? [], enumerable: false },
    candidates: { value: metadata.candidates ?? [], enumerable: false },
  })
  return selection
}

function discover({ checkout, deps = {} } = {}) {
  const run = typeof deps.run === 'function' ? deps.run : (command) => {
    try {
      return { ok: true, output: execFileSync('/bin/sh', ['-c', command], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (error) {
      return { ok: false, output: error?.stdout?.toString?.() || error?.message || '', code: error?.code, signal: error?.signal }
    }
  }
  const command = `git -C ${shellArg(checkout)} ls-files -z`
  let inventoryResult
  try { inventoryResult = run(command) } catch (error) { return { exhibits: [], inventory: [], candidates: [], reason: reasonForError(error, 'inventory') } }
  const inventory = parseInventory(inventoryResult, checkout)
  if (inventory.reason) return { exhibits: [], inventory: [], candidates: [], reason: inventory.reason }
  const candidates = inventory.files.filter((file) => file.endsWith(TEST_SUFFIX)).sort()
  if (candidates.length === 0) return { exhibits: [], inventory: inventory.files, candidates, reason: 'candidate-empty' }
  const read = typeof deps.readFile === 'function'
    ? deps.readFile
    : typeof deps.readFileSync === 'function'
      ? deps.readFileSync
      : (file) => {
          const result = run(`cat ${shellArg(file.startsWith(`${checkout}/`) ? file : `${checkout}/${file}`)}`)
          const parsed = resultParts(result)
          if (!parsed.valid || !parsed.ok) {
            const error = new Error('candidate read failed')
            error.code = parsed.valid ? 'ENOENT' : 'EIO'
            throw error
          }
          return parsed.output
        }
  const exhibits = []
  for (const file of candidates) {
    let source
    try { source = read(file.startsWith(`${checkout}/`) ? file : `${checkout}/${file}`) } catch (error) {
      return { exhibits: [], inventory: inventory.files, candidates, reason: reasonForError(error, 'candidate') }
    }
    if (typeof source !== 'string' || source.length === 0) return { exhibits: [], inventory: inventory.files, candidates, reason: 'candidate-empty' }
    if (qualifies(source)) exhibits.push({ file, test_count: null })
  }
  return { exhibits, inventory: inventory.files, candidates, reason: null }
}

export const CENSUS_EXHIBIT_PREDICATES = Object.freeze({
  trackedTest: (file) => typeof file === 'string' && file.endsWith(TEST_SUFFIX),
  checkoutWideInventory: (source) => typeof source === 'string' && /(?:execFileSync|execSync|spawnSync|git|run)\s*\(/.test(source) && /ls-files|ls-tree/.test(source) && !/--\s*['"`]/.test(source),
  trackedPartition: (source) => typeof source === 'string' && /\.filter\s*\(/.test(source) && /test\.mjs/.test(source),
  computedMeasurement: (source) => typeof source === 'string' && /(?:measurement|measured|owners|pairs|count|total)/i.test(source) && /(?:\.size|\.length|reduce|flatMap|map)/.test(source),
  mutableCarrier: (source) => typeof source === 'string' && /(?:readText|readFileSync|readFile)\s*\(/.test(source) && !/import\.meta\.url/.test(source),
})

export function shellArg(value) {
  return `'${String(value ?? '').replaceAll("'", "'\"'\"'")}'`
}

export function selectCensusExhibits({ checkout, deps = {} } = {}) {
  const found = discover({ checkout, deps })
  return defineSelectionMetadata(found.exhibits, found)
}

function clockValue(now) {
  try {
    const value = now()
    const numeric = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(numeric) ? numeric : null
  } catch { return null }
}

function elapsedSeconds(start, end) {
  if (start === null || end === null) return null
  const delta = end - start
  return Number.isFinite(delta) && delta >= 0 ? delta / 1000 : null
}

// TAP reports a failure on a `not ok` line or a non-zero `# fail` footer. Either is definitive
// evidence of a red regardless of whether the run reached its plan line.
function tapFailureEvidence(output) {
  const text = String(output)
  if (/^not ok\b/m.test(text)) return true
  const fail = text.match(/^#\s+fail\s+(\d+)\s*$/m)
  return fail ? Number(fail[1]) > 0 : false
}

function testCount(output) {
  const match = String(output).match(/^#\s+tests\s+(\d+)\s*$/m) || String(output).match(/^1\.\.(\d+)\s*$/m)
  return match ? Number(match[1]) : null
}

function inFence(file, filesInScope) {
  const target = normalPath(file)
  for (const entry of Array.isArray(filesInScope) ? filesInScope : []) {
    const scope = normalPath(String(entry).split('#', 1)[0])
    if (scope === target || (scope.endsWith('/') && target.startsWith(scope))) return true
  }
  return false
}

function failureDetail(file, filesInScope) {
  const repair = 're-measure the repository-wide census and update its asserted carriers'
  const relation = inFence(file, filesInScope) ? 'INSIDE' : 'OUTSIDE'
  const detail = `${file}: ${relation} the lane fence; repair: ${repair}`
  return { relation, detail }
}

export function runCensusExhibits({ checkout, filesInScope = [], deps = {} } = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const selectionStarted = clockValue(now)
  const selected = selectCensusExhibits({ checkout, deps })
  const selectionEnded = clockValue(now)
  const selectionSeconds = elapsedSeconds(selectionStarted, selectionEnded)
  const discoveryReason = selected.reason
  const base = {
    action: 'none', selected: selected.map((exhibit) => exhibit.file), failures: [], detail: null,
    selection_seconds: selectionSeconds, run_seconds: null, total_seconds: null, elapsed_seconds: null,
    denominator: { suites: selected.length, tests: 0 }, measurement: null, cost: null,
    reason: discoveryReason || (selectionSeconds === null ? 'selection-clock-unavailable' : null),
  }
  // Discovery failed, so NOTHING about this checkout was measured — not the suite count either.
  // A fabricated 0 would read as "measured, and there are none". Unknown is never a zero.
  if (discoveryReason) return { ...base, denominator: { suites: null, tests: null }, reason: discoveryReason }
  if (selected.length === 0) return { ...base, denominator: { suites: 0, tests: null }, reason: 'empty-selection' }
  const run = typeof deps.run === 'function' ? deps.run : (command) => {
    try {
      return { ok: true, output: execFileSync('/bin/sh', ['-c', command], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (error) {
      return { ok: false, output: error?.stdout?.toString?.() || error?.message || '', code: error?.code, signal: error?.signal }
    }
  }
  const runStarted = clockValue(now)
  const failures = []
  let tests = 0
  let reason = null
  for (const exhibit of selected) {
    const argv = [process.execPath, '--test', '--test-reporter=tap', exhibit.file]
    const command = argv.map(shellArg).join(' ')
    let result
    try { result = run(command) } catch (error) {
      reason ||= reasonForError(error, 'runner')
      continue
    }
    const parsed = resultParts(result)
    if (!parsed.valid) { reason ||= 'runner-malformed'; continue }
    if (!parsed.output) { reason ||= 'runner-empty'; continue }
    const count = testCount(parsed.output)
    const failed = tapFailureEvidence(parsed.output)
    if (count === null && !failed) {
      // No TAP footer AND no failure evidence: the runner never reported on this exhibit — a
      // timeout, a spawn refusal, a truncated stream. That is INFRASTRUCTURE, and
      // instrumentation is never load-bearing, so it is not recorded as a census failure.
      // A missing footer ALONE proves nothing: a census test can emit `not ok` and then be
      // interrupted before `1..N`, and swallowing that turns a must-catch red into a pass.
      reason ||= 'malformed-output'
      continue
    }
    if (count === null) reason ||= 'malformed-output'
    else tests += count
    if (!parsed.ok || failed) failures.push({ file: exhibit.file, ...failureDetail(exhibit.file, filesInScope) })
  }
  const runEnded = clockValue(now)
  const runSeconds = elapsedSeconds(runStarted, runEnded)
  const totalSeconds = selectionSeconds === null || runSeconds === null ? null : selectionSeconds + runSeconds
  if (selectionSeconds === null && !reason) reason = 'selection-clock-unavailable'
  if (runSeconds === null && !reason) reason = 'clock-unavailable'
  if (tests === 0 && !reason) reason = 'empty-denominator'
  // Any reason at all means the run did not complete over every selected suite, so the test
  // count is a partial tally and not a measurement. Unknown is never a guess and never a zero.
  const denominator = { suites: selected.length, tests: reason === null ? tests : null }
  const measurement = reason === null && totalSeconds !== null
    ? {
        selection_seconds: selectionSeconds,
        run_seconds: runSeconds,
        total_seconds: totalSeconds,
        numerator_seconds: totalSeconds,
        denominator_seconds: CENSUS_FULL_SUITE_SECONDS,
        denominator_measured: false,
        denominator_source: 'asserted-constant',
        percentage: Number(((totalSeconds / CENSUS_FULL_SUITE_SECONDS) * 100).toFixed(2)),
      }
    : null
  const detail = failures.map((failure) => failure.detail).join('\n')
  const boundedDetail = detail.length > 2000 ? `${detail.slice(0, 1997)}...` : detail
  const action = failures.every(({ relation }) => relation === 'INSIDE') ? 'bounce' : 'escalate'
  return {
    action: failures.length === 0 ? 'none' : action, selected: selected.map((exhibit) => exhibit.file), failures, detail: boundedDetail || null,
    selection_seconds: selectionSeconds, run_seconds: runSeconds, total_seconds: totalSeconds, elapsed_seconds: totalSeconds, denominator, measurement,
    cost: measurement ? {
      selection_seconds: measurement.selection_seconds, run_seconds: measurement.run_seconds, total_seconds: measurement.total_seconds,
      subset_seconds: measurement.numerator_seconds, full_suite_seconds: measurement.denominator_seconds,
      full_suite_seconds_measured: measurement.denominator_measured, full_suite_seconds_source: measurement.denominator_source,
      percentage: measurement.percentage,
    } : null,
    reason,
  }
}
