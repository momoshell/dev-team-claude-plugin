#!/usr/bin/env node
// shape-scan — report the shape signals a review of a JS/TS change should look at: new
// single-caller helpers, parameters used only by a log call, nesting growth, added comments
// that narrate review history, and the helper-count delta. Reads and reports; changes
// nothing. A finding never fails the run: exit 0 when it ran, 2 on a usage error, 1 when an
// input could not be read or a ref could not be resolved.
//
// Every count carries its denominator, and what it could not measure is listed, never
// omitted: files skipped by extension, and function candidates it could not delimit, each
// with one closed reason (UNDELIMITED_REASONS).
//
// lean: line-based diff excerpts, functions, uses and raw brace counting; use complete base/head sources and a JS lexer when false positives matter
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs'
import { resolve, relative, extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const SCANNED_EXTENSIONS = Object.freeze(['.mjs', '.js', '.ts'])
export const UNDELIMITED_REASONS = Object.freeze(['unclosed-braces', 'unsupported-opening', 'missing-context', 'unsupported-parameters'])
const BLIND_SPOTS = Object.freeze([
  'Raw braces, textual calls, parameter-use and semicolon statement heuristics are not JavaScript semantics.',
  'Diff-only excerpts cannot establish unseen source context.',
])

const REVIEW_HISTORY = /RV\d+-\d+|SF\d+|HP\d+|must-fix|should-fix|reviewer|review round/i
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/
const LOG_CALL = /(?:console\.|logger\.|\blog\s*\()[^)]*\)/g
const STRINGS_AND_COMMENTS = /(['"`])(?:\\.|(?!\1)[^\\])*?\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return'])

// Openings this scan can delimit. `call` openings put the name directly before its `(`, so
// the call-site count must discount the declaration itself; an arrow binding does not.
const OPENINGS = [
  { call: true, re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(([^)]*)\)/ },
  { call: false, re: /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|([\w$]+))\s*=>\s*\{/ },
  { call: true, re: /^(?:static\s+)?(?:async\s+)?([\w$]+)\s*\(([^)]*)\)\s*\{\s*$/ },
]
// A named binding or declaration that matched no opening above is reported, never dropped.
const LOOKS_LIKE_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=.*=>/

const isScanned = (path) => SCANNED_EXTENSIONS.includes(extname(path))
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const lines = (text) => text.replace(/\r\n/g, '\n').split('\n')
const codeOf = (line) => line.replace(/\/\/.*$/, '').trim()

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function usageError(message) {
  return Object.assign(new Error(message), { usage: true })
}

function parseOpening(line) {
  for (const { call, re } of OPENINGS) {
    const m = re.exec(line)
    if (m && !CONTROL_WORDS.has(m[1])) return { name: m[1], params: m[2] ?? m[3] ?? '', call }
  }
  return null
}

// Returns the line index where the braces opened on `from` close, and the deepest nesting.
function closeBraces(rows, from) {
  let depth = 0, deepest = 0
  for (let i = from; i < rows.length; i++) {
    for (const ch of codeOf(rows[i])) {
      if (ch === '{') deepest = Math.max(deepest, ++depth)
      else if (ch === '}') depth--
    }
    if (depth === 0) return { end: i, depth: deepest }
  }
  return null
}

// `rows` are [lineNumber, text] pairs, so a diff excerpt keeps its original line numbers.
// `limited` marks an excerpt: braces that do not close there are missing context, not a defect.
function findFunctions(rows, { path, side, limited }) {
  const texts = rows.map(([, text]) => text), functions = [], undelimited = []
  const blind = (i, name, reason) => undelimited.push({ path, name, line: rows[i][0], side, reason })
  for (let i = 0; i < texts.length; i++) {
    const code = codeOf(texts[i])
    const opening = parseOpening(code)
    if (!opening) {
      if (LOOKS_LIKE_FUNCTION.test(code)) blind(i, code.match(/([\w$]+)\s*(?:=|\()/)?.[1] ?? null, 'unsupported-opening')
      continue
    }
    if (!texts[i].includes('{')) { blind(i, opening.name, 'unsupported-opening'); continue }
    const closed = closeBraces(texts, i)
    if (!closed) { blind(i, opening.name, limited ? 'missing-context' : 'unclosed-braces'); continue }
    const params = parameterNames(opening.params)
    if (params.unsupported.length) blind(i, opening.name, 'unsupported-parameters')
    functions.push({
      name: opening.name,
      params: params.names,
      start: rows[i][0],
      depth: closed.depth,
      body: texts.slice(i, closed.end + 1).join('\n'),
    })
    i = closed.end
  }
  return { functions, undelimited }
}

// Plain, defaulted (`x = 1`) and typed (`label: string`) parameters are measured;
// destructured and rest parameters are reported as unsupported rather than skipped.
function parameterNames(text) {
  const names = [], unsupported = []
  for (const raw of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const name = raw.replace(/\s*\??\s*[:=][\s\S]*$/, '').trim()
    if (/^[\w$]+$/.test(name)) names.push(name)
    else unsupported.push(raw)
  }
  return { names, unsupported }
}

// The function body after its opening brace, with strings and comments removed.
function innerCode(body) {
  const open = body.indexOf('{', body.indexOf(')') + 1)
  return body.slice(open + 1).replace(STRINGS_AND_COMMENTS, '')
}

function isOneStatement(body) {
  const inner = innerCode(body).replace(/\}\s*$/, '')
  return inner.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).length === 1
}

function logOnlyParameters(fn) {
  const code = innerCode(fn.body)
  const logs = [...code.matchAll(LOG_CALL)].map((m) => [m.index, m.index + m[0].length])
  return fn.params.filter((parameter) => {
    const uses = [...code.matchAll(new RegExp(`(?<![\\w$])${escapeRegExp(parameter)}(?![\\w$])`, 'g'))]
    return uses.length > 0 && uses.every((use) => logs.some(([a, b]) => use.index >= a && use.index < b))
  })
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One pass over the corpus: textual `name(` occurrences per name, minus each line that
// declares that name in a call-shaped opening (a function declaration or method signature).
export function callSiteCounter(corpus) {
  const counts = new Map()
  const bump = (name, by) => counts.set(name, (counts.get(name) ?? 0) + by)
  for (const [, text] of corpus) {
    for (const line of lines(text)) {
      for (const m of line.matchAll(/(?<![\w$])([\w$]+)\s*\(/g)) bump(m[1], 1)
      const opening = parseOpening(codeOf(line))
      if (opening?.call) bump(opening.name, -1)
    }
  }
  return (name) => counts.get(name) ?? 0
}

function measureFile({ path, before, after, reviewHistory }, callSites) {
  const unpaired = [...before]
  const pairs = after.map((fn) => {
    const at = unpaired.findIndex((b) => b.name === fn.name)
    return [at < 0 ? null : unpaired.splice(at, 1)[0], fn]
  })
  const added = pairs.filter(([previous]) => !previous).length
  const removed = unpaired.length
  const changed = pairs.filter(([previous, fn]) => !previous || previous.body !== fn.body)

  const single_caller = [], log_only = [], nesting = []
  for (const [previous, fn] of changed) {
    const calls = callSites(fn.name)
    if (calls === 1) single_caller.push({ name: fn.name, call_sites: calls, one_statement: isOneStatement(fn.body) })
    for (const parameter of logOnlyParameters(fn)) log_only.push({ function: fn.name, parameter })
    const beforeDepth = previous ? previous.depth : null
    nesting.push({ name: fn.name, before: beforeDepth, after: fn.depth, delta: beforeDepth === null ? null : fn.depth - beforeDepth })
  }
  return {
    path,
    files_scanned: 1,
    functions_scanned: changed.length,
    single_caller,
    log_only,
    nesting,
    review_history: reviewHistory,
    helper_count: { added, removed, delta: added - removed },
    counts: {
      single_caller: single_caller.length,
      one_statement: single_caller.filter((x) => x.one_statement).length,
      log_only: log_only.length,
      review_history: reviewHistory.length,
    },
  }
}

// `changes` are already split into scanned files and skipped paths by the caller.
function report(changes, skipped, undelimited, corpus) {
  const callSites = callSiteCounter(corpus)
  const files = changes.sort(byPath).map((change) => measureFile(change, callSites))
  const total = (key) => files.reduce((n, f) => n + f.counts[key], 0)
  const helpers = (key) => files.reduce((n, f) => n + f.helper_count[key], 0)
  return {
    files,
    totals: {
      files_scanned: files.length,
      functions_scanned: files.reduce((n, f) => n + f.functions_scanned, 0),
      single_caller: total('single_caller'),
      one_statement: total('one_statement'),
      log_only: total('log_only'),
      review_history: total('review_history'),
      helper_count: { added: helpers('added'), removed: helpers('removed'), delta: helpers('delta') },
    },
    skipped: skipped.sort(byPath),
    undelimited: undelimited.sort((a, b) => byPath(a, b) || a.line - b.line),
    blind_spots: BLIND_SPOTS,
  }
}

function reviewHistoryOf(rows, addedLines) {
  return rows
    .filter(([line, text]) => addedLines.has(line) && COMMENT_LINE.test(text) && REVIEW_HISTORY.test(text))
    .map(([line, text]) => ({ line, text }))
}

// --- diff mode ---------------------------------------------------------------------------

// git writes `+++ b/my file.mjs<TAB>` for a name with a space, and a C-quoted header for a
// non-ASCII one: `+++ "b/na\303\257ve.mjs"`.
function headerPath(rest) {
  let path = rest.replace(/\t.*$/, '')
  if (path.startsWith('"') && path.endsWith('"')) path = unquoteC(path.slice(1, -1))
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '')
}

function unquoteC(text) {
  const bytes = []
  const ESCAPES = { n: '\n', t: '\t', '"': '"', '\\': '\\' }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') { bytes.push(...Buffer.from(text[i])); continue }
    if (/[0-7]{3}/.test(text.slice(i + 1, i + 4))) { bytes.push(parseInt(text.slice(i + 1, i + 4), 8)); i += 3; continue }
    bytes.push(...Buffer.from(ESCAPES[text[++i]] ?? text[i]))
  }
  return Buffer.from(bytes).toString('utf8')
}

// Hunks are kept apart: an excerpt is never joined to the next across lines it never saw.
// A hunk's header counts say how many lines it owns, so a removed line that itself starts
// with `-- ` is content, not the next file's header.
export function parseDiff(text) {
  const files = []
  let file = null, hunk = null, oldLeft = 0, newLeft = 0
  for (const line of lines(text)) {
    const inHunk = hunk && (oldLeft > 0 || newLeft > 0)
    if (!inHunk) {
      if (line.startsWith('--- ')) { file = { path: headerPath(line.slice(4)), hunks: [] }; hunk = null; continue }
      if (line.startsWith('+++ ') && file) {
        file.path = headerPath(line.slice(4)) ?? file.path
        if (file.path) files.push(file)
        continue
      }
      const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (at && file) {
        oldLeft = Number(at[2] ?? 1)
        newLeft = Number(at[4] ?? 1)
        hunk = { before: [], after: [], added: new Set(), oldLine: Number(at[1]), newLine: Number(at[3]) }
        file.hunks.push(hunk)
      }
      continue
    }
    if (line.startsWith('\\')) continue
    const body = line.slice(1)
    if (line[0] === '-') { hunk.before.push([hunk.oldLine++, body]); oldLeft-- }
    else if (line[0] === '+') { hunk.added.add(hunk.newLine); hunk.after.push([hunk.newLine++, body]); newLeft-- }
    else { hunk.before.push([hunk.oldLine++, body]); hunk.after.push([hunk.newLine++, body]); oldLeft--; newLeft-- }
  }
  return files
}

// The call corpus for diff mode: the checkout's tracked and unignored files when it is a git
// work tree (so generated, ignored output adds no phantom callers), else an lstat walk that
// never follows a symlink. A changed file the checkout lacks contributes its head excerpt.
function checkoutCorpus(dir) {
  let listed = null
  try { listed = git(dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean) } catch { listed = null }
  const paths = listed ?? walk(dir).map((p) => relative(dir, p).replaceAll('\\', '/'))
  return paths
    .filter((p) => isScanned(p) && existsSync(join(dir, p)) && lstatSync(join(dir, p)).isFile())
    .map((p) => [p, readFileSync(join(dir, p), 'utf8')])
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const path = join(dir, name), st = lstatSync(path)
    if (st.isDirectory()) walk(path, acc)
    else if (st.isFile()) acc.push(path)
  }
  return acc
}

export function scanDiff({ diff, checkout = process.cwd() }) {
  const dir = resolve(checkout)
  const corpus = checkoutCorpus(dir)
  const changes = [], skipped = [], undelimited = []
  for (const file of parseDiff(diff)) {
    if (!isScanned(file.path)) { skipped.push({ path: file.path, extension: extname(file.path) }); continue }
    const side = (rowsOf, name) => file.hunks.map((h) => findFunctions(rowsOf(h), { path: file.path, side: name, limited: true }))
    const before = side((h) => h.before, 'before'), after = side((h) => h.after, 'head')
    for (const found of [...before, ...after]) undelimited.push(...found.undelimited)
    changes.push({
      path: file.path,
      before: before.flatMap((f) => f.functions),
      after: after.flatMap((f) => f.functions),
      reviewHistory: file.hunks.flatMap((h) => reviewHistoryOf(h.after, h.added)),
    })
    if (!existsSync(join(dir, file.path))) corpus.push([file.path, file.hunks.flatMap((h) => h.after.map(([, t]) => t)).join('\n')])
  }
  return report(changes, skipped, undelimited, corpus)
}

// --- range mode --------------------------------------------------------------------------

function blobAt(dir, ref, path) {
  return git(dir, 'ls-tree', '-z', ref, '--', path) ? git(dir, 'show', `${ref}:${path}`) : ''
}

function numbered(text) {
  return text ? lines(text).map((t, i) => [i + 1, t]) : []
}

function addedLinesOf(dir, base, head, path) {
  const added = new Set()
  let line = 0
  for (const row of lines(git(dir, 'diff', '--no-ext-diff', '--no-renames', '--unified=0', base, head, '--', path))) {
    const at = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row)
    if (at) line = Number(at[1])
    else if (row.startsWith('+') && !row.startsWith('+++')) added.add(line++)
  }
  return added
}

export function scanRange({ range, checkout = process.cwd() }) {
  const dir = resolve(checkout)
  const ends = /^(.+?)\.\.(.+)$/.exec(range)
  if (!ends) throw usageError('malformed range')
  const [base, head] = [ends[1], ends[2]].map((ref) => git(dir, 'rev-parse', '--verify', `${ref}^{commit}`).trim())
  const changes = [], skipped = [], undelimited = []
  for (const path of git(dir, 'diff', '-z', '--no-ext-diff', '--no-renames', '--name-only', base, head).split('\0').filter(Boolean)) {
    // Checked before any blob is read: a skipped binary must not fail the scan.
    if (!isScanned(path)) { skipped.push({ path, extension: extname(path) }); continue }
    const beforeRows = numbered(blobAt(dir, base, path)), afterRows = numbered(blobAt(dir, head, path))
    const before = findFunctions(beforeRows, { path, side: 'before', limited: false })
    const after = findFunctions(afterRows, { path, side: 'head', limited: false })
    undelimited.push(...before.undelimited, ...after.undelimited)
    changes.push({
      path,
      before: before.functions,
      after: after.functions,
      reviewHistory: reviewHistoryOf(afterRows, addedLinesOf(dir, base, head, path)),
    })
  }
  const corpus = git(dir, 'ls-tree', '-r', '-z', '--name-only', head).split('\0').filter(isScanned).map((p) => [p, git(dir, 'show', `${head}:${p}`)])
  return report(changes, skipped, undelimited, corpus)
}

// --- report and CLI ----------------------------------------------------------------------

export function render(r) {
  const summary = (label, files, counts, functions) =>
    `${label}: files scanned ${files}; functions ${functions}/${files}; single caller ${counts.single_caller}/${functions}, log-only ${counts.log_only}/${functions}, review history ${counts.review_history}/${files}`
  return [
    summary('totals', r.totals.files_scanned, r.totals, r.totals.functions_scanned),
    ...r.files.map((f) => summary(f.path, f.files_scanned, f.counts, f.functions_scanned)),
    ...r.skipped.map((x) => `skipped ${x.path} (${x.extension})`),
    ...r.undelimited.map((x) => `undelimited ${x.path}:${x.line} ${x.name} [${x.reason}]`),
    ...r.blind_spots,
  ].join('\n') + '\n'
}

function parseArgs(args) {
  let input = null, kind = null, checkout = process.cwd(), json = false
  const valueAfter = (i, flag) => {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw usageError(`missing ${flag} value`)
    return args[i + 1]
  }
  const setInput = (k, value) => {
    if (input !== null) throw usageError('conflicting inputs')
    kind = k
    input = value
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--checkout') checkout = valueAfter(i++, '--checkout')
    else if (a === '--diff') setInput('diff', valueAfter(i++, '--diff'))
    else if (a === '--json') json = true
    else if (a === '--help') return { help: true }
    else if (a.startsWith('-')) throw usageError(`unknown option ${a}`)
    else setInput('range', a)
  }
  if (input === null) throw usageError('no input')
  if (kind === 'range' && !/^[^.]+(?:\.[^.]+)*\.\.[^.]+(?:\.[^.]+)*$/.test(input)) throw usageError('malformed range')
  return { input, kind, checkout, json }
}

export function cli(args = process.argv.slice(2)) {
  try {
    const opts = parseArgs(args)
    if (opts.help) { process.stdout.write('usage: shape-scan BASE..HEAD | --diff FILE [--checkout DIR] [--json]\n'); process.exitCode = 0; return }
    const r = opts.kind === 'diff'
      ? scanDiff({ diff: readFileSync(opts.input, 'utf8'), checkout: opts.checkout })
      : scanRange({ range: opts.input, checkout: opts.checkout })
    process.stdout.write(opts.json ? JSON.stringify(r) + '\n' : render(r))
    process.exitCode = 0
  } catch (e) {
    process.stderr.write(`${e.usage ? 'usage' : 'error'}: ${e.message}\n`)
    process.exitCode = e.usage ? 2 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli()
