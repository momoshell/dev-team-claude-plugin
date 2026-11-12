import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// An untracked file past this size is counted by an estimate rather than read.
const UNTRACKED_READ_CAP_BYTES = 1024 * 1024
// Past the read cap an untracked file's lines are counted by streaming up to this size; beyond it they are unknown.
const UNTRACKED_COUNT_CAP_BYTES = 64 * 1024 * 1024
const UNTRACKED_HEAD_BYTES = 64 * 1024

function readFileHead(path, bytes) {
  const fd = openSync(path, 'r')
  try { const buffer = Buffer.alloc(bytes); return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)) } finally { closeSync(fd) }
}

// Newlines in the file plus a last unterminated line, or null past the cap.
function countFileLines(path, cap) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let total = 0, count = 0, last = 10
    for (;;) {
      const got = readSync(fd, buffer, 0, buffer.length, null)
      if (!got) break
      total += got
      if (total > cap) return null
      for (let i = 0; i < got; i += 1) if (buffer[i] === 10) count += 1
      last = buffer[got - 1]
    }
    return total === 0 ? 0 : count + (last === 10 ? 0 : 1)
  } finally { closeSync(fd) }
}
export const EXCERPT_LINES = 12
// The pre-return consult's own, larger view: the whole working diff, bounded by bytes rather than by entries.
export const PRE_RETURN_DIFF_BUDGET_BYTES = 48 * 1024
// The omitted_files entries that say the window is incomplete in a way names cannot (not file paths).
export const PRE_RETURN_INCOMPLETE = '(working diff over the git output limit: list may be incomplete)'
const GIT_TIMEOUT_MS = 5000
const DIFF_MAX_BUFFER_BYTES = 16 * 1024 * 1024

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

function gitOverflow(err) {
  const code = String(err?.code || '')
  const message = String(err?.message || err || '')
  return code === 'ENOBUFS' || /maxbuffer|stdout maxBuffer|buffer length/i.test(`${code} ${message}`)
}

export function gitDiffSize({ cwd, deps = {} } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null
  const exec = deps.execFileSync || execFileSync
  const statSize = deps.fileSize || ((path) => statSync(path).size)
  const run = (args) => exec('git', args, {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER_BYTES, encoding: null,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let diff
  try { diff = run(['--no-pager', 'diff', 'HEAD']) } catch (err) {
    return gitOverflow(err) ? { bytes: DIFF_MAX_BUFFER_BYTES, truncated: true } : null
  }
  let untracked
  try { untracked = run(['ls-files', '--others', '--exclude-standard', '-z']) } catch (err) {
    return gitOverflow(err) ? { bytes: DIFF_MAX_BUFFER_BYTES, truncated: true } : null
  }
  const diffBytes = Buffer.isBuffer(diff) ? diff.length : byteLength(diff)
  const names = (Buffer.isBuffer(untracked) ? untracked.toString('utf8') : String(untracked ?? '')).split('\0').filter(Boolean)
  let bytes = diffBytes
  try {
    for (const name of names) bytes += Number(statSize(resolve(String(cwd || ''), name))) || 0
  } catch { return null }
  return { bytes, truncated: false }
}

// The lane checkout's working diff against HEAD, untracked files included, as a line count (added plus removed)
// and as grounded `path:line: text` entries (one per changed file) the consult's delta can anchor to.
// null when git cannot say: the seat is unaffected.
export function gitDiffLines({ cwd, deps = {} } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null
  const exec = deps.execFileSync || execFileSync
  const read = deps.readFileBytes || ((path) => readFileSync(path))
  const statSize = deps.fileSize || ((path) => statSync(path).size)
  const head = deps.readFileHead || readFileHead
  const countLines = deps.countFileLines || countFileLines
  const run = (args) => exec('git', args, {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER_BYTES, encoding: null,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const asText = (value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  let diff, untracked
  // Past the output cap the hunks are not read at all; the changed names (a far smaller listing) still say which
  // files the consult could not see. A listing that fails too is an empty list, never a guess.
  const overflowShape = () => {
    const names = []
    for (const args of [['-c', 'core.quotepath=off', '--no-pager', 'diff', '--name-only', '-z', 'HEAD'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
      try { for (const name of asText(run(args)).split('\0').filter(Boolean)) if (!names.includes(name)) names.push(name) } catch { /* unnamed */ }
    }
    return { lines: DIFF_MAX_BUFFER_BYTES, text: '', entries: [], files: [], truncated: true, unread_files: names }
  }
  try { diff = asText(run(['-c', 'core.quotepath=off', '--no-pager', 'diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD'])) } catch (err) {
    return gitOverflow(err) ? overflowShape() : null
  }
  try { untracked = asText(run(['ls-files', '--others', '--exclude-standard', '-z'])) } catch (err) {
    return gitOverflow(err) ? overflowShape() : null
  }
  let lines = 0
  const files = new Map()
  let current = null
  let removed = null
  let header = false
  let newLine = 0
  let oldLine = 0
  const keep = (name, text) => {
    if (!files.has(name)) files.set(name, [])
    files.get(name).push(text)
  }
  for (const row of diff.split('\n')) {
    // '--- ' and '+++ ' are file headers only before a file's first hunk; inside a hunk they are content.
    if (row.startsWith('diff --git ')) { current = null; removed = null; header = true; continue }
    if (header && row.startsWith('+++ ')) {
      const name = row.slice(4).replace(/\t.*$/, '')
      if (name !== '/dev/null') { current = name.replace(/^b\//, ''); if (!files.has(current)) files.set(current, []) }
      continue
    }
    // A removed line is grounded at its old path and line, so a deletion-only change can still be reviewed.
    if (header && row.startsWith('--- ')) {
      const name = row.slice(4).replace(/\t.*$/, '')
      removed = name === '/dev/null' ? null : name.replace(/^a\//, '')
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) { header = false; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue }
    if (header) continue
    if (row.startsWith('+')) {
      lines += 1
      const kept = current === null ? null : files.get(current)
      if (kept) kept.push(`${current}:${newLine}: ${row.slice(1)}`)
      newLine += 1
    } else if (row.startsWith('-')) {
      lines += 1
      if (removed !== null) keep(removed, `${removed}:${oldLine}: (removed) ${row.slice(1)}`)
      oldLine += 1
    }
  }
  // Every grounded line is kept per file; the small excerpt window below takes the first EXCERPT_LINES of each, and
  // the pre-return consult packs the rest by bytes.
  const allFiles = [...files].filter(([, kept]) => kept.length).map(([path, kept]) => ({ path, lines: kept }))
  const entries = allFiles.map(({ lines: kept }) => kept.slice(0, EXCERPT_LINES).join('\n'))
  let unknown = false
  const partialFiles = []
  try {
    for (const name of untracked.split('\0').filter(Boolean)) {
      const absolute = resolve(String(cwd), name)
      const size = Number(statSize(absolute)) || 0
      // Past the read cap only the head is read and the lines are counted by streaming; past the count cap they are
      // unknown, reported as the overflow shape, never as zero and never estimated.
      const large = size > UNTRACKED_READ_CAP_BYTES
      const buffer = large ? head(absolute, UNTRACKED_HEAD_BYTES) : read(absolute)
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''))
      if (bytes.includes(0)) continue
      const text = bytes.toString('utf8')
      if (!text) continue
      if (large) partialFiles.push(name)
      const rows = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      const counted = large ? countLines(absolute, UNTRACKED_COUNT_CAP_BYTES) : rows.length
      if (counted === null) unknown = true
      else lines += counted
      const grounded = rows.map((item, index) => `${name}:${index + 1}: ${item}`)
      allFiles.push({ path: name, lines: grounded })
      entries.push(grounded.slice(0, EXCERPT_LINES).join('\n'))
    }
  } catch { return null }
  if (unknown) return { lines: DIFF_MAX_BUFFER_BYTES, text: entries.join('\n'), entries, files: allFiles, partial_files: partialFiles, truncated: true }
  return { lines, text: entries.join('\n'), entries, files: allFiles, partial_files: partialFiles, truncated: false }
}

// The pre-return consult's view of the working diff: every grounded line in order, packed into `budgetBytes`
// (UTF-8 bytes of the entries joined by newlines). A file with any line left out is named once in `omitted_files`,
// a partly shown file included, so the consult is told what it did not see. Null when git cannot say.
export function preReturnDiff({ cwd, deps = {}, budgetBytes = PRE_RETURN_DIFF_BUDGET_BYTES, scrub = null } = {}) {
  const diff = (deps.diffLines || ((path) => gitDiffLines({ cwd: path, deps })))(cwd)
  if (!diff || typeof diff !== 'object') return null
  let files
  if (Array.isArray(diff.files)) files = diff.files.map((file) => ({ path: String(file?.path ?? ''), lines: (file?.lines || []).map(String) }))
  else {
    const entries = Array.isArray(diff.entries) ? diff.entries.map(String) : [String(diff.text ?? '')]
    files = entries.filter(Boolean).map((entry) => {
      const lines = entry.split('\n')
      return { path: /^(.+?):\d+: /.exec(lines[0])?.[1] ?? '', lines }
    })
  }
  const entries = []
  const omittedFiles = []
  const redactions = {}
  let bytes = 0
  let count = 0
  // A file git could not give hunks for (output over the cap) or gave only the head of is left out, by name.
  for (const name of [...(Array.isArray(diff.unread_files) ? diff.unread_files : []), ...(Array.isArray(diff.partial_files) ? diff.partial_files : [])]) {
    if (!omittedFiles.includes(String(name))) omittedFiles.push(String(name))
  }
  // An incomplete read is stated, never passed off as a whole diff, even when no file could be named.
  if (diff.truncated === true) omittedFiles.push(PRE_RETURN_INCOMPLETE)
  for (const file of files) {
    const taken = []
    let omitted = false
    let fileLines = file.lines
    // `scrub` runs before the budget is spent, so the bytes counted are the bytes sent: a redaction that expands text
    // cannot push the window past the budget.
    if (scrub && fileLines.length) {
      const scrubbed = scrub(fileLines.join('\n'))
      fileLines = scrubbed.text ? scrubbed.text.split('\n') : []
      for (const [kind, n] of Object.entries(scrubbed.counts || {})) redactions[kind] = (redactions[kind] || 0) + n
    }
    for (const line of fileLines) {
      const cost = byteLength(line) + (count ? 1 : 0)
      if (bytes + cost > budgetBytes) { omitted = true; break }
      bytes += cost; count += 1; taken.push(line)
    }
    if (taken.length) entries.push(taken.join('\n'))
    if (omitted && !omittedFiles.includes(file.path)) omittedFiles.push(file.path)
  }
  return { entries, bytes, omitted_files: omittedFiles, lines: count, redactions }
}

