export const FAILURE_BLOCK_LINES = 40
export const FAILURE_BLOCK_BYTES = 2048
export const FAILURES_SECTION_BYTES = 12288

import { relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CARGO_CAPTURE_OFF = /(?:^|\s)(--nocapture|--show-output|--format(?:=\S*)?|-q|--quiet|RUST_TEST_NOCAPTURE=\S*|RUST_TEST_FORMAT=\S*)(?=\s|$)/
export const PLAIN_WORDS_COMMAND = /^[A-Za-z0-9_.\/:,@%+=-]+(?:[ \t]+[A-Za-z0-9_.\/:,@%+=-]+)*[ \t]*$/
export function validTestRerunCommand(value) {
  if (typeof value !== 'string') return false
  const words = value.split(/[ \t]+/)
  if (words.filter((word) => word === '{test}').length !== 1) return false
  if (!PLAIN_WORDS_COMMAND.test(value.replace('{test}', 'test'))) return false
  return true
}
export const FLAKE_RERUN_REASONS = Object.freeze(['runner-unparsed', 'test-unmapped', 'in-fence', 'command-unshaped'])

function safeTestFile(token, checkout) {
  if (typeof token !== 'string' || typeof checkout !== 'string' || !token || /[\0\r\n\\]/.test(token)) return null
  let value = token.replace(/[),;\]}]+$/g, '').replace(/^[([{]+/, '').replace(/:(?:\d+)(?::\d+)?$/, '')
  if (!value) return null
  // Dot segments are refused as written: relative() and URL parsing would normalise them away before the segment check below.
  if (value.replace(/^\.\//, '').split('/').some((part) => part === '.' || part === '..')) return null
  if (/^file:/i.test(value)) {
    if (/%2e/i.test(value)) return null
    try { const url = new URL(value); if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null; value = fileURLToPath(url) } catch { return null }
  }
  if (isAbsolute(value)) {
    const rel = relative(checkout, value)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
    value = rel.split(sep).join('/')
  } else if (value.startsWith('./')) value = value.slice(2)
  if (!value || /^(?:[A-Za-z]:|\/)/.test(value) || /[\\*?{}\[\]]/.test(value)) return null
  const parts = value.split('/')
  if (parts.some((part) => part === '.' || part === '..')) return null
  return value
}

export function failingTestFiles(output, runner, checkout) {
  if (typeof output !== 'string') return []
  const text = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n')
  const results = []
  const add = (test, location) => results.push({ test, file: typeof location === 'string' ? safeTestFile(location, checkout) : null })
  if (runner === 'node' && text.includes('✖ failing tests:')) {
    const specTail = text.split('✖ failing tests:').slice(1).join('✖ failing tests:')
    const lines = specTail.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const at = /^\s*test at (.+?)\s*$/.exec(lines[i])
      const title = /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*ms\))?\s*$/.exec(lines[i + 1] || '')
      if (at && title) add(title[1], at[1])
    }
    return results
  }
  if (runner === 'node') {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i])
      if (!m || /# (?:SKIP|TODO)\b/.test(lines[i])) continue
      let location = null
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || /^\s+/.test(lines[j])); j++) {
        const loc = /(?:file:\/\/[^\s)]+|(?:\.\.?\/|[A-Za-z]:[\\/]|\/)[^\s:]+\.(?:mjs|js|cjs|ts))(?::\d+(?::\d+)?)?/.exec(lines[j])
        if (loc) { location = loc[0]; break }
      }
      add(m[1], location)
    }
    return results
  }
  if (runner !== 'cargo') return []
  const failures = [...text.matchAll(/^test (.+) \.\.\. FAILED$/gm)].map((match) => ({ test: match[1], file: null, stdoutSeen: false }))
  let current = null
  for (const line of text.split('\n')) {
    const stdout = /^---- (.+) stdout ----$/.exec(line)
    if (stdout) {
      current = failures.find((entry) => entry.test === stdout[1] && !entry.stdoutSeen)
      if (!current) { current = { test: stdout[1], file: null, stdoutSeen: true }; failures.push(current) }
      else current.stdoutSeen = true
      continue
    }
    if (/^test result: /.test(line) || /^\s*(?:Running|Doc-tests)\s/.test(line)) { current = null; continue }
    if (!current) continue
    const panic = /panicked at (.+?):\d+(?::\d+)?:/.exec(line)
    if (!panic) continue
    const file = safeTestFile(panic[1], checkout)
    const srcMatch = /(?:^|\/)src\//.exec(file || '')
    if (!srcMatch) continue
    const modulePrefix = file.slice(srcMatch.index + srcMatch[0].length).replace(/\.rs$/, '').split('/')
    if (['mod', 'lib', 'main'].includes(modulePrefix.at(-1))) modulePrefix.pop()
    const testModules = current.test.split('::').slice(0, -1)
    const attributable = modulePrefix.length + 1 >= testModules.length && modulePrefix.every((part, index) => testModules[index] === part)
    if (!attributable) continue
    const inlineParent = modulePrefix.length === testModules.length - 1 && testModules.at(-1) === 'tests'
    if (modulePrefix.length !== testModules.length && !inlineParent) continue
    if (current.conflict) continue
    if (current.file && current.file !== file) { current.file = null; current.conflict = true }
    else current.file = file
  }
  // lean: module-prefix Cargo attribution; use explicit binary/source metadata if legitimate failures remain unmappable
  return failures.map(({ test, file }) => ({ test, file }))
}

export function isolatedTestCommand(command, runner, test, file, shellArg, rerunCommand = null) {
  if (typeof command !== 'string' || typeof shellArg !== 'function' || typeof file !== 'string' || !file.trim()) return null
  if (runner === 'node') return 'node --test --test-reporter=tap ' + shellArg(file)
  if (runner !== 'cargo' || typeof test !== 'string' || !test) return null
  // The appended "-- --exact <test>" must reach the command as argv: only plain words, no shell syntax (a comment, quote, substitution or operator can swallow or reroute it).
  if (PLAIN_WORDS_COMMAND.test(command) && !/(?:^|\s)--(?=\s|$)/.test(command) && !CARGO_CAPTURE_OFF.test(command)) return command + ' -- --exact ' + shellArg(test)
  if (typeof rerunCommand !== 'string' || !validTestRerunCommand(rerunCommand)) return null
  return rerunCommand.replace('{test}', () => shellArg(test))
}

export function dropPassingLines(text) {
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
    const suite = /^\s*▶ /.test(plain)
    if (suite) suites.set(indent, i)
    const subtest = /^\s*# Subtest:/.test(plain)
    if (subtest) subtests.set(indent, i)
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

const titleHasLabel = (title, labels) => labels.some((label) => {
  let from = 0
  while (from <= title.length - label.length) {
    const index = title.indexOf(label, from)
    if (index < 0) return false
    const before = title[index - 1], after = title[index + label.length]
    if ((!before || !/[A-Za-z0-9._-]/.test(before)) && (!after || !/[A-Za-z0-9._-]/.test(after))) return true
    from = index + 1
  }
  return false
})

export function failingTestsSection(output, labels = null) {
  const raw = typeof output === 'string' ? output : ''
  const lines = raw.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
  // lean: retain whole reporter output and entries; stream if output memory becomes material
  const entries = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const tap = /^\s*not ok \d+ - /.test(line)
    const spec = /^\s*✖ /.test(line)
    if (!tap && !spec) continue
    if (tap && /# TODO\b/i.test(line)) continue
    if (spec && /^\s*✖ failing tests:/.test(line)) continue
    const title = line.replace(/^\s*(?:not ok \d+ - |✖\s+)/, '')
    if (labels !== null && !titleHasLabel(title, labels)) continue
    const indent = line.match(/^\s*/)[0].length
    const block = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]
      if (next.trim() && next.match(/^\s*/)[0].length <= indent) break
      block.push(next)
    }
    while (block.length && !block.at(-1).trim()) block.pop()
    const kept = []
    let bytes = 0
    for (const diagnostic of block) {
      const size = Buffer.byteLength(diagnostic, 'utf8') + (kept.length ? 1 : 0)
      if (kept.length >= FAILURE_BLOCK_LINES || bytes + size > FAILURE_BLOCK_BYTES) {
        if (labels !== null && kept.length < FAILURE_BLOCK_LINES) {
          const available = FAILURE_BLOCK_BYTES - bytes - (kept.length ? 1 : 0)
          if (available > 0) {
            const prefix = Buffer.from(diagnostic).subarray(0, available).toString().replace(/�$/, '')
            if (prefix) {
              kept.push(prefix)
              bytes += Buffer.byteLength(prefix, 'utf8') + (kept.length > 1 ? 1 : 0)
            }
          }
        }
        break
      }
      kept.push(diagnostic)
      bytes += size
    }
    const cut = block.length - kept.length
    entries.push([line, ...kept, ...(cut ? [`  [cut: ${cut} more diagnostic lines]`] : [])].join('\n'))
  }
  if (!entries.length) return { found: 0, omitted: 0, text: `no failing test line found in ${Buffer.byteLength(raw, 'utf8')} bytes of output` }
  const selected = []
  for (const entry of entries) {
    const left = entries.length - selected.length - 1
    const footer = left ? `\n[${left} more failing tests omitted: section bound ${FAILURES_SECTION_BYTES} bytes]` : ''
    if (Buffer.byteLength([...selected, entry].join('\n') + footer, 'utf8') > FAILURES_SECTION_BYTES) break
    selected.push(entry)
  }
  const omitted = entries.length - selected.length
  const omittedLine = omitted ? `[${omitted} more failing tests omitted: section bound ${FAILURES_SECTION_BYTES} bytes]` : ''
  return { found: entries.length, omitted, text: [...selected, ...(omittedLine ? [omittedLine] : [])].join('\n') }
}

export function labelledFailures(output, labels) {
  return failingTestsSection(output, Array.isArray(labels) ? labels : [])
}

export function stepFailureDiagnostics(io, labels, steps, shellArg) {
  if (!Array.isArray(labels) || !labels.length) return ''
  const paths = []
  for (const step of Array.isArray(steps) ? steps : []) {
    for (const path of Array.isArray(step?.files_in_scope) ? step.files_in_scope : []) {
      if (typeof path === 'string' && /\.test\.(?:mjs|js|ts)$/.test(path) && !paths.includes(path)) paths.push(path)
    }
  }
  if (!paths.length) return ''
  const command = `node --test --test-reporter=tap ${paths.map((path) => shellArg(path)).join(' ')}`
  try {
    const result = io.run(command)
    if (typeof result?.output !== 'string') return '\ndiagnostics unavailable: test command returned non-text output'
    const labelled = labelledFailures(result.output, labels)
    const failures = labelled.found ? labelled : failingTestsSection(result.output)
    if (labelled.found) return `\nFailing tests titled with ${labels.join(', ')} (${failures.found} found):\n${failures.text}`
    return `\nFailing tests (none titled with ${labels.join(', ')}; ${failures.found} found):\n${failures.text}`
  } catch (error) {
    return `\ndiagnostics unavailable: ${error?.message || String(error)}`
  }
}

export const LANE_BINARY_SOURCES = Object.freeze(['unchanged', 'package-local', 'unresolved', 'unmeasured'])

export function resolveLaneBinary({ lane, checkout, scopeFiles, exists } = {}) {
  const match = typeof lane === 'string' ? /^npx[ \t]+([A-Za-z0-9][A-Za-z0-9._-]*)([\s\S]*)$/.exec(lane) : null
  if (!match || (match[2] && !/^[ \t]/.test(match[2]))) return { lane, source: 'unchanged', tool: null, package_dir: null, candidates: [] }
  const tool = match[1]
  const rest = match[2]
  if (typeof exists !== 'function') return { lane, source: 'unmeasured', tool, package_dir: null, candidates: [] }
  const root = typeof checkout === 'string' ? checkout.replace(/\/+$/, '') : ''
  if (exists(`${root}/node_modules/.bin/${tool}`)) return { lane, source: 'unchanged', tool, package_dir: null, candidates: [] }
  const candidates = []
  for (const entry of Array.isArray(scopeFiles) ? scopeFiles : []) {
    if (typeof entry !== 'string') continue
    const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) continue
    let dir = entry.endsWith('/') ? clean : (clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '')
    while (dir) {
      if (!candidates.includes(dir) && /^[\w.@+\/-]+$/.test(dir) && exists(`${root}/${dir}/node_modules/.bin/${tool}`)) candidates.push(dir)
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    }
  }
  if (candidates.length === 1) { const dir = candidates[0]; return { lane: `cd ${dir.startsWith('-') ? './' : ''}${dir} && ./node_modules/.bin/${tool}${rest}`, source: 'package-local', tool, package_dir: dir, candidates } }
  return { lane: `npx --no ${tool}${rest}`, source: 'unresolved', tool, package_dir: null, candidates }
}

export function moduleResolutionSignature(output) {
  if (typeof output !== 'string') return null
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  const modules = [...new Set([...text.matchAll(/Cannot find (?:module|package) '([^']+)'/g)].map((m) => m[1]))].sort()
  const code = text.includes('ERR_MODULE_NOT_FOUND') ? 'ERR_MODULE_NOT_FOUND' : null
  if (!code && modules.length === 0) return null
  const noTests = text.includes('Test Files  no tests') || text.includes('No test files found')
  return [...(code ? [code] : []), ...modules, ...(noTests ? ['no-tests'] : [])].join('|')
}
