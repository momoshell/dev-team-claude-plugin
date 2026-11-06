// Red on the old source and green on the build shows that a test depends on the change.
// This is not a kill proof.
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, matchesGlob, relative, sep } from 'node:path'
import { literalRelative, runSuite } from './checks.mjs'

export function testState(events) {
  const hits = events ?? []
  if (hits.length === 0) return { state: null, reason: 'missing' }
  if (hits.length > 1) return { state: null, reason: 'ambiguous' }
  const [e] = hits
  if (e.skip) return { state: null, reason: 'skipped' }
  if (e.todo) return { state: null, reason: 'todo' }
  if (e.type === 'test:pass') return { state: 'green', reason: null }
  if (e.type === 'test:fail' && e.failureType === 'testCodeFailure') return { state: 'red', reason: null }
  return { state: null, reason: e.failureType === 'hookFailed' ? 'hook-failed' : e.failureType === 'cancelledByParent' ? 'cancelled' : 'not-body-failure' }
}

// ADR-058: projects declare runners that emit JUnit testcase outcomes.
export function junitEvents(xml) {
  if (typeof xml !== 'string') return null
  if (xml.startsWith('\uFEFF')) xml = xml.slice(1)
  // Validate nesting before extracting outcomes; a truncated report must never prove green.
  // This deliberately rejects DTDs rather than resolving external entities.
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/[A-Za-z_:][\w:.-]*\s*>|<[A-Za-z_:][\w:.-]*(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/gy
  const validEntities = (text) => !/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text) && [...text.matchAll(/&#(x[\da-fA-F]+|\d+);/g)].every(([, n]) => {
    const code = n[0] === 'x' ? parseInt(n.slice(1), 16) : Number(n)
    return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
  })
  for (const char of xml) {
    const code = char.codePointAt(0)
    if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) return null
  }
  const stack = [], tags = []
  let pos = 0, roots = 0
  while (pos < xml.length) {
    const next = xml.indexOf('<', pos), text = xml.slice(pos, next < 0 ? xml.length : next)
    if ((!stack.length && text.trim()) || !validEntities(text) || text.includes(']]>')) return null
    if (next < 0) break
    token.lastIndex = next
    const match = token.exec(xml)
    if (!match) return null
    const tag = match[0]
    tags.push(tag)
    if (tag.startsWith('<![CDATA[')) { if (!stack.length) return null }
    else if (tag.startsWith('<!--')) { if (tag.slice(4, -3).includes('--')) return null }
    else if (tag.startsWith('<?')) {
      if (!/^<\?[A-Za-z_:][\w:.-]*(?:\s[\s\S]*?)?\?>$/.test(tag) || (/^<\?xml(?:\s|\?>)/i.test(tag) && (next !== 0 || !/^<\?xml\s+version\s*=\s*(['"])1\.[01]\1(?:\s+encoding\s*=\s*(['"])[A-Za-z][\w.-]*\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/.test(tag)))) return null
    } else {
      const name = tag.match(/^<\/?([A-Za-z_:][\w:.-]*)/)[1]
      if (tag.startsWith('</')) { if (stack.pop() !== name) return null }
      else {
        const attr = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy, names = new Set()
        attr.lastIndex = name.length + 1
        let a
        while ((a = attr.exec(tag))) {
          if (names.has(a[1]) || !validEntities(a[2] ?? a[3])) return null
          names.add(a[1])
        }
        if (!stack.length && ++roots > 1) return null
        if (!tag.endsWith('/>')) stack.push(name)
      }
    }
    pos = token.lastIndex
  }
  if (stack.length || roots !== 1) return null
  xml = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  if (!/<testsuites?[\s>\/]/.test(xml)) return null
  const decode = (value) => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (code[0] !== '#') return named[code] ?? entity
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return n <= 0x10ffff ? String.fromCodePoint(n) : entity
  })
  return tags.flatMap((tag, i) => {
    if (!/^<testcase(?:\s|\/?>)/.test(tag)) return []
    const attrs = Object.create(null), attr = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy
    attr.lastIndex = '<testcase'.length
    let match
    while ((match = attr.exec(tag))) attrs[match[1]] = decode(match[2] ?? match[3])
    const body = []
    if (!tag.endsWith('/>')) {
      let depth = 1
      for (let j = i + 1; j < tags.length; j++) {
        const next = tags[j]
        if (/^<testcase(?:\s|\/?>)/.test(next) && !next.endsWith('/>')) depth++
        if (/^<\/testcase\s*>$/.test(next) && --depth === 0) break
        body.push(next)
      }
    }
    const has = (name) => body.some((part) => new RegExp(`^<${name}(?:\\s|/?>)`).test(part))
    const outcome = has('skipped') ? { skip: true } : has('error') ? { type: 'test:fail', failureType: 'error' } : has('failure') ? { type: 'test:fail', failureType: 'testCodeFailure' } : { type: 'test:pass' }
    return [{ name: attrs.name ?? '', classname: attrs.classname ?? '', ...outcome }]
  })
}

function nearestTitle(events, title) {
  const candidates = new Set(events.flatMap((e) => e.classname ? [e.name, `${e.classname}.${e.name}`, `${e.classname}::${e.name}`] : [e.name]))
  let best, bestSuffix = -1, bestDistance = Infinity
  for (const candidate of candidates) {
    let suffix = 0
    while (suffix < title.length && suffix < candidate.length && title[title.length - 1 - suffix] === candidate[candidate.length - 1 - suffix]) suffix++
    let distances = Array.from({ length: title.length + 1 }, (_, i) => i)
    for (let i = 0; i < candidate.length; i++) {
      const next = [i + 1]
      for (let j = 0; j < title.length; j++) next.push(Math.min(next[j] + 1, distances[j + 1] + 1, distances[j] + (candidate[i] === title[j] ? 0 : 1)))
      distances = next
    }
    const distance = distances[title.length]
    if (suffix > bestSuffix || (suffix === bestSuffix && distance < bestDistance)) {
      best = candidate; bestSuffix = suffix; bestDistance = distance
    }
  }
  return best === undefined ? [] : [best]
}

export async function testEvents({ cwd, files, timeoutMs }) {
  const run = await runSuite({ cwd, command: process.execPath, args: ['--test', `--test-reporter=${new URL('./proof-reporter.mjs', import.meta.url).href}`, '--test-reporter-destination=stdout', ...files], timeoutMs })
  const events = run.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
  return { status: run.status, reason: run.reason, events }
}

// Refuse symlinked parents as well as the final path, including in the checkout.
function safePath(root, file, required) {
  let path = root
  const parts = file.split('/')
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i])
    const st = lstatSync(path, { throwIfNoEntry: false })
    if (!st) return !required
    if (i === parts.length - 1 ? !st.isFile() : !st.isDirectory()) return false
  }
  return true
}

export const validProofEntry = (e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.match === 'string' && e.match.trim() && typeof e.run === 'string' && e.run.trim() && (!Object.hasOwn(e, 'setup') || (typeof e.setup === 'string' && e.setup.trim()))
export const entryCommand = (run, values) => run.trim().split(/\s+/).map((token) => token.replace(/\{(file|title|report|stem)\}/g, (_, key) => values[key]))

export async function proveTests(input = {}) {
  const unmeasured = (reason, rows = []) => ({ status: 'unmeasured', reason, rows })
  let tmp, added = null, result, rows = []
  try {
    const { cwd, base = 'HEAD', tests, timeoutMs = 120_000 } = input ?? {}
    if (typeof cwd !== 'string' || !cwd || typeof base !== 'string' || !/^[^-\s]\S*$/.test(base) || !Array.isArray(tests) || !tests.length || !tests.every((t) => t && typeof t.file === 'string' && t.file && typeof t.title === 'string' && t.title)) return unmeasured('invalid-input')
    const notRun = () => ({ state: null, reason: 'not-run' })
    rows = tests.map(({ file, title }) => ({ file, title, base: notRun(), build: notRun(), proven: false, reason: null }))
    tmp = mkdtempSync(join(tmpdir(), 'crew-proof-'))
    // The old source runs in a detached worktree, a checkout like the build's, so an environment difference
    // (a missing .git, for one) can never supply the red.
    const root = join(tmp, 'base')
    const addRun = await runSuite({ cwd, command: 'git', args: ['worktree', 'add', '--detach', '--quiet', root, base], timeoutMs })
    if (addRun.status !== 'green') result = unmeasured(addRun.reason, rows)
    else {
      added = { cwd, root, timeoutMs }
      let entries = []
      try {
        const configPath = '.crew/project.json'
        if (!safePath(root, configPath, false)) throw new Error('unsafe config')
        if (lstatSync(join(root, configPath), { throwIfNoEntry: false })) {
          const config = JSON.parse(readFileSync(join(root, configPath), 'utf8'))
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config')
          entries = config.proof ?? (Object.hasOwn(config, 'proof') ? null : [])
          if (!Array.isArray(entries) || !entries.every(validProofEntry)) throw new Error('invalid proof')
        }
      } catch { result = unmeasured('invalid-project-config', rows) }
      const runners = new Map()
      for (const row of result ? [] : rows) {
        const entry = entries.find((e) => matchesGlob(row.file, e.match))
        if (entry) runners.set(row, entry)
        if (!entry && !/\.[cm]?js$/.test(row.file)) row.reason = 'unsupported-runner'
        else if (!literalRelative(row.file) || !safePath(cwd, row.file, true) || !safePath(root, row.file, false)) row.reason = 'unsafe-path'
        else {
          const dest = join(root, row.file)
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(join(cwd, row.file), dest)
        }
      }
      for (const entry of new Set([...runners].filter(([row]) => !row.reason).map(([, entry]) => entry))) {
        if (!entry.setup) continue
        const [command, ...args] = entry.setup.trim().split(/\s+/)
        const setup = await runSuite({ cwd: root, command, args, timeoutMs })
        if (setup.status !== 'green') { result = unmeasured(setup.status === 'red' ? 'setup-failed' : setup.reason, rows); break }
      }
      for (const [i, row] of rows.entries()) {
        if (result) break
        const entry = runners.get(row)
        if (!entry || row.reason) continue
        for (const [side, dir] of [['base', root], ['build', cwd]]) {
          const report = join(tmp, `report-${i}-${side}.xml`)
          const values = { file: row.file, title: row.title, report, stem: basename(row.file, extname(row.file)) }
          const [command, ...args] = entryCommand(entry.run, values)
          const run = await runSuite({ cwd: dir, command, args, timeoutMs })
          if (run.status === 'unmeasured') { result = unmeasured(run.reason, rows); break }
          let xml, events = null
          try { xml = readFileSync(report, 'utf8'); events = junitEvents(xml) } catch {}
          const hits = events?.filter((e) => row.title === e.name || (e.classname && (row.title === `${e.classname}.${e.name}` || row.title === `${e.classname}::${e.name}`)))
          const loadFailure = events && !events.length && /<(?:failure|error)(?:\s|\/?>)/.test(xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, ''))
          row[side] = hits?.length ? testState(hits) : events && (events.length || loadFailure) ? { state: null, reason: 'title-unmatched', nearest: nearestTitle(events, row.title) } : { state: null, reason: side === 'base' ? 'base-does-not-build' : 'no-report' }
        }
        if (result) break
        row.proven = row.base.state === 'red' && row.build.state === 'green'
        row.reason = row.proven ? null : row.base.state !== 'red' ? 'proof-not-red-on-base' : 'proof-not-green'
      }
      const files = [...new Set(rows.filter((r) => !r.reason && !runners.has(r)).map((r) => r.file))]
      if (!result && files.length) {
        const old = await testEvents({ cwd: root, files, timeoutMs })
        const build = await testEvents({ cwd, files, timeoutMs })
        if (old.status === 'unmeasured' || build.status === 'unmeasured') result = unmeasured(old.status === 'unmeasured' ? old.reason : build.reason, rows)
        else {
          const hits = (events, dir, row) => events.filter((e) => {
            if (e?.name !== row.title || typeof e.file !== 'string') return false
            try { return relative(realpathSync(dir), realpathSync(e.file)).split(sep).join('/') === row.file } catch { return false }
          })
          for (const row of rows.filter((r) => !r.reason && !runners.has(r))) {
            const a = hits(old.events, root, row), b = hits(build.events, cwd, row)
            row.base = testState(a)
            row.build = testState(b)
            const identity = a.length === 1 && b.length === 1 && Number.isInteger(a[0].line) && Number.isInteger(a[0].column) && a[0].line === b[0].line && a[0].column === b[0].column
            row.proven = row.base.state === 'red' && row.build.state === 'green' && identity
            row.reason = row.proven ? null : row.base.state !== 'red' ? 'proof-not-red-on-base' : 'proof-not-green'
          }
        }
      }
      if (!result) result = rows.every((r) => r.proven) ? { status: 'green', reason: null, rows } : { status: 'red', reason: 'proof-unproven', rows }
    }
  } catch { result = unmeasured('runner-threw', rows) } finally {
    // A second --force removes a locked worktree too; one that still will not go is kept and reported, never
    // deleted under git, so no registered worktree points at a missing path.
    let kept = null
    if (added) {
      const removed = await runSuite({ cwd: added.cwd, command: 'git', args: ['worktree', 'remove', '--force', '--force', added.root], timeoutMs: added.timeoutMs }).catch(() => null)
      if (removed?.status !== 'green') { kept = added.root; result = { ...unmeasured('cleanup-unproven', rows), kept } }
    }
    if (tmp && !kept) try { rmSync(tmp, { recursive: true, force: true }) } catch { result = unmeasured('cleanup-unproven', rows) }
  }
  return result
}
