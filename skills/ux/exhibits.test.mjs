import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { checkSkillAnchors, collectAnchors } from '../qa-test-writing/anchor-pin.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const MANIFEST = join(HERE, 'anchors.json')
const OWNER = 'skills/ux/anchors.json'
const LIB = join(ROOT, 'visualizer/web/src/lib')
const SKILL_DOC = join(HERE, 'SKILL.md')
const REF_DIR = join(HERE, 'references')
const EXPECTED_REFS = ['absence.md', 'keyboard-focus.md', 'motion.md', 'sources.md', 'states.md']
const VERCEL_ID = 'vercel-web-interface-guidelines.md'
const CSV_ID = 'ui-ux-pro-max-ux-guidelines.csv'

function skillDocs() {
  return [SKILL_DOC, ...EXPECTED_REFS.map((name) => join(REF_DIR, name))]
}

function readDocs() {
  return skillDocs().map((doc) => readFileSync(doc, 'utf8'))
}

function ruleLines() {
  return readDocs().flatMap((body) => body.split('\n')).filter((line) => line.startsWith('- **Rule '))
}

function libFiles() {
  return readdirSync(LIB).filter((name) => name.endsWith('.svelte')).sort()
}

function census(pattern, flags) {
  const files = libFiles()
  let occurrences = 0
  const hit = []
  for (const file of files) {
    const text = readFileSync(join(LIB, file), 'utf8')
    const matches = text.match(new RegExp(pattern, flags)) || []
    if (matches.length > 0) {
      occurrences += matches.length
      hit.push(file)
    }
  }
  return { occurrences, files: hit.length, hit }
}

// Mutation killed: naming a missing reference in the routing table breaks the route set.
test('ux skill routes match the reference directory', () => {
  const skill = readFileSync(SKILL_DOC, 'utf8')
  const actual = readdirSync(REF_DIR).filter((name) => name.endsWith('.md')).sort()
  assert.deepEqual(actual, EXPECTED_REFS)
  const routed = [...skill.matchAll(/`references\/([^`]+\.md)`/g)].map((match) => match[1]).sort()
  assert.deepEqual(routed, EXPECTED_REFS)
})

// Mutation killed: renaming a manifest key leaves its prose citation without an exact-content pin.
test('ux manifest keys and prose citations agree exactly', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const anchors = collectAnchors({ docs: skillDocs() })
  const cited = new Set(anchors.map((anchor) => anchor.key))
  const keys = Object.keys(manifest)
  assert.ok(cited.size > 0, 'expected prose citations')
  assert.deepEqual([...keys].sort(), [...cited].sort(), 'manifest and prose citation sets must match')
})

// Mutation killed: drifting a manifest key by one line reddens this suite.
test('ux manifest pins carry current exact content', () => {
  assert.equal(relative(ROOT, MANIFEST), OWNER)
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.equal(Object.keys(manifest).length, 19)
  const result = checkSkillAnchors({ root: ROOT, skillDir: HERE, manifestPath: MANIFEST })
  assert.deepEqual(result.shifted, [], 'a drifted manifest pin must be repaired, not tolerated')
  assert.deepEqual(result.failures, [], `manifest-backed pins must check clean: ${result.failures.join('\n')}`)
  for (const [key, expected] of Object.entries(manifest)) {
    const split = key.lastIndexOf(':')
    const lines = readFileSync(join(ROOT, key.slice(0, split)), 'utf8').split('\n')
    assert.ok(expected.trim().length >= 12, `${key} expected substring is too short`)
    assert.equal(lines.filter((line) => line.includes(expected)).length, 1, `${key} expected text must occur exactly once`)
    assert.ok(lines[Number(key.slice(split + 1)) - 1].includes(expected), `${key} does not carry the claimed content`)
  }
})

// Mutation killed: erasing one vocabulary count breaks the four-row measured register.
test('ux absence vocabulary re-derives from the component tree', () => {
  const body = readFileSync(join(REF_DIR, 'absence.md'), 'utf8')
  const dash = census('—', 'g')
  assert.equal(dash.occurrences, 132)
  assert.equal(dash.files, 23)
  const unavailable = census('unavailable', 'gi')
  assert.equal(unavailable.occurrences, 93)
  assert.equal(unavailable.files, 23)
  const unmeasured = census('unmeasured', 'gi')
  assert.equal(unmeasured.occurrences, 35)
  assert.equal(unmeasured.files, 10)
  const notMeasured = census('not measured', 'gi')
  assert.equal(notMeasured.occurrences, 14)
  assert.equal(notMeasured.files, 7)
  const union = new Set([...dash.hit, ...unavailable.hit, ...unmeasured.hit, ...notMeasured.hit])
  assert.equal(union.size, 27)
  assert.equal(libFiles().length, 33)
  for (const row of ['| `—` | 132 | 23 |', '| `unavailable` | 93 | 23 |', '| `unmeasured` | 35 | 10 |', '| `not measured` | 14 | 7 |']) {
    assert.ok(body.includes(row), `absence.md must carry ${row}`)
  }
  assert.ok(body.includes('`Unmeasured — <reason>`'), 'absence.md must name the canonical vocabulary')
})

test('ux state branches re-derive to sixteen of thirty three', () => {
  const body = readFileSync(join(REF_DIR, 'states.md'), 'utf8')
  assert.ok(body.includes('## Adopted rules'), 'states.md must carry the adopted rules heading')
  const hit = []
  for (const file of libFiles()) {
    const markup = readFileSync(join(LIB, file), 'utf8').split('<style>')[0]
    const hasEmptyClass = /(class=["'][^"']*\bempty\b)/.test(markup)
    const conditions = [...markup.matchAll(/\{#if\s+([^}]+)\}|\{:else if\s+([^}]+)\}/g)].map((match) => match[1] || match[2] || '')
    if (hasEmptyClass || conditions.some((condition) => condition.includes('loading'))) hit.push(file)
  }
  assert.equal(hit.length, 16)
  assert.equal(libFiles().length - hit.length, 17)
  assert.ok(body.includes('16/33') || body.includes('16 of 33'), 'states.md must record the branched count')
  assert.ok(body.includes('17/33'), 'states.md must record the unbranched remainder')
})

test('ux keyboard and focus register re-derives', () => {
  const body = readFileSync(join(REF_DIR, 'keyboard-focus.md'), 'utf8')
  const legacy = census('on:keydown', 'g')
  assert.equal(legacy.occurrences, 0)
  assert.equal(legacy.files, 0)
  const modern = census('onkeydown=', 'g')
  assert.equal(modern.occurrences, 3)
  assert.equal(modern.files, 2)
  const visible = census(':focus-visible', 'g')
  assert.equal(visible.occurrences, 4)
  assert.equal(visible.files, 3)
  const plain = census(':focus(?!-)', 'g')
  assert.equal(plain.occurrences, 3)
  assert.equal(plain.files, 1)
  const tab = census('tabindex', 'g')
  assert.equal(tab.occurrences, 1)
  assert.equal(tab.files, 1)
  const aria = census('aria-', 'g')
  assert.equal(aria.occurrences, 124)
  assert.equal(aria.files, 28)
  const role = census('role=', 'g')
  assert.equal(role.occurrences, 20)
  assert.equal(role.files, 9)
  for (const row of [
    '| legacy `on:keydown` attributes | 0 | 0 |',
    '| modern `onkeydown=` attributes | 3 | 2 |',
    '| `:focus-visible` selectors | 4 | 3 |',
    '| plain `:focus` selectors | 3 | 1 |',
    '| `tabindex` attributes | 1 | 1 |',
    '| `aria-` attributes | 124 | 28 |',
    '| `role=` attributes | 20 | 9 |',
  ]) {
    assert.ok(body.includes(row), `keyboard-focus.md must carry ${row}`)
  }
})

test('ux motion register re-derives with no reduced motion query', () => {
  const body = readFileSync(join(REF_DIR, 'motion.md'), 'utf8')
  const animated = census('animation:', 'g')
  assert.equal(animated.occurrences, 3)
  assert.equal(animated.files, 2)
  const reduced = census('prefers-reduced-motion', 'g')
  assert.equal(reduced.occurrences, 0)
  assert.equal(reduced.files, 0)
  assert.ok(body.includes('0/33') || body.includes('0 of 33'), 'motion.md must record the zero query count')
})

// Mutation killed: dropping a source identity from one adopted rule breaks the provenance floor.
test('ux adopted rules carry both stable source identities', () => {
  const rules = ruleLines()
  assert.equal(rules.length, 7)
  let vercel = 0
  let csv = 0
  for (const line of rules) {
    assert.ok(line.includes(`${VERCEL_ID} — `), `rule line must name the vercel source: ${line.slice(0, 40)}`)
    assert.match(line, /ui-ux-pro-max-ux-guidelines\.csv — row \d+/, `rule line must name the csv row: ${line.slice(0, 40)}`)
  }
  for (const body of readDocs()) {
    for (const line of body.split('\n')) {
      // sources.md is provenance, not a rule: its one vercel row is pinned by A1, not counted here.
      if (line.includes(VERCEL_ID) && !body.includes('| source file named in citations |')) vercel += 1
      const found = line.match(/ui-ux-pro-max-ux-guidelines\.csv — row \d+/g)
      if (found) csv += found.length
    }
  }
  assert.equal(vercel, 7)
  assert.equal(csv, 7)
})

test('ux stated gaps are counted and few', () => {
  let gaps = 0
  for (const body of readDocs()) {
    gaps += (body.match(/\*\*Stated gap:\*\*/g) || []).length
  }
  assert.equal(gaps, 4)
  assert.ok(readFileSync(join(REF_DIR, 'absence.md'), 'utf8').includes('3/33'), 'absence.md must record the canonical-phrase adoption count')
  for (const body of readDocs()) {
    for (const line of body.split('\n')) {
      if (line.includes('**Stated gap:**')) assert.match(line, /\d+\/33/, 'every stated gap carries a denominator')
    }
  }
})

test('ux vercel identities quote the verified source sections', () => {
  const verified = [
    `${VERCEL_ID} — Content Handling / “Handle empty states”`,
    "vercel-web-interface-guidelines.md — Typography / “Loading states end with `…`”",
    `${VERCEL_ID} — Content Handling / “Handle empty states”`,
    "vercel-web-interface-guidelines.md — Content & Copy / “Error messages include fix/next step, not just problem”",
    `${VERCEL_ID} — Accessibility / “Interactive elements need keyboard handlers”`,
    `${VERCEL_ID} — Focus States / “Use :focus-visible over :focus”`,
    "vercel-web-interface-guidelines.md — Animation / “Honor `prefers-reduced-motion`”",
  ]
  const cited = ruleLines().map((line) => {
    const match = line.match(/vercel-web-interface-guidelines\.md — [^;]+/)
    assert.ok(match, `rule line must carry a vercel citation: ${line.slice(0, 40)}`)
    return match[0]
  })
  assert.deepEqual([...cited].sort(), [...verified].sort())
})

test('ux empty-result exhibit is cited exactly once', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const taskKeys = Object.keys(manifest).filter((key) => key.includes('TaskList'))
  assert.equal(taskKeys.length, 1)
  const joined = readDocs().join('\n').split(`TaskList.svelte${':120'}`).length - 1
  assert.equal(joined, 1, 'the empty-result line is cited exactly once in prose')
})

// Mutation killed: altering a recorded source digest breaks provenance verification.
test('A1', () => {
  const uxSources = readFileSync(join(REF_DIR, 'sources.md'), 'utf8')
  const designSources = readFileSync(join(ROOT, 'skills/ui-design/references/sources.md'), 'utf8')
  for (const body of [uxSources, designSources]) {
    for (const row of [
      'vercel-web-interface-guidelines.md',
      'https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md',
      'e3d624baaf29dc1fc645aff3e38f03e564d2d6b1',
      '5a775e6411f790f518dbc9c1fa7c50a89e6873502d9a3530a6eb223a590bcfe8',
      'ui-ux-pro-max-ux-guidelines.csv',
      'https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/src/ui-ux-pro-max/data/ux-guidelines.csv',
      'dcc40ff5133ef78276117db0cc34e7b83cc8aeba',
      'ff81ec613f70ba9fc3fcce52dbe4ae35d44b2079dbe6dc066d2d6e38c28facd5',
    ]) {
      assert.ok(body.includes(row), `sources.md must carry the exact provenance row ${row.slice(0, 32)}`)
    }
    assert.ok(body.includes('| MIT |') || body.includes('|MIT|'), 'sources.md must record the MIT license')
    assert.ok(body.includes('Neither source is vendored'), 'sources.md records provenance only, never vendored content')
    assert.ok(body.length < 4000, 'sources.md is a metadata record, not a vendored source body')
  }
})

// Mutation killed: adding an absolute-path read under skills breaks the repository boundary.
// lean: regex literals are opaque to this scan; a homedir() inside /.../ is a pattern, not a call.
function tokenizeOutsideStrings(source) {
  const code = source.split('')
  const strings = []
  let i = 0
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (code[k] !== '\n') code[k] = ' ' }
  const prevSignificant = (pos) => {
    for (let k = pos - 1; k >= 0; k -= 1) {
      if (code[k] !== ' ' && code[k] !== '\n' && code[k] !== '\t' && code[k] !== '\r') return source[k]
    }
    return ''
  }
  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      let j = source.indexOf('\n', i)
      if (j === -1) j = source.length
      blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const j = source.indexOf('*/', i + 2)
      const end = j === -1 ? source.length : j + 2
      blank(i, end)
      i = end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === ch) break
        j += 1
      }
      const end = Math.min(j + 1, source.length)
      strings.push({ value: source.slice(i + 1, j), start: i })
      blank(i, end)
      i = end
      continue
    }
    if (ch === '/') {
      const prev = prevSignificant(i)
      const isRegex = prev === '' || '([{,:;=!&|?+-*%^~<>'.includes(prev) || /(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(source.slice(0, i).split(/\s+/).pop() || '')
      if (isRegex) {
        let j = i + 1
        let inClass = false
        while (j < source.length) {
          if (source[j] === '\\') { j += 2; continue }
          if (source[j] === '[') inClass = true
          if (source[j] === ']') inClass = false
          if (source[j] === '/' && !inClass) break
          if (source[j] === '\n') break
          j += 1
        }
        let end = Math.min(j + 1, source.length)
        while (end < source.length && /[a-z]/.test(source[end])) end += 1
        blank(i, end)
        i = end
        continue
      }
    }
    i += 1
  }
  return { code: code.join(''), strings }
}

const REPO_READ_CALLS = new Set(['readFileSync', 'readFile', 'readdirSync', 'readdir', 'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'openSync', 'open', 'statSync', 'stat', 'lstatSync', 'lstat', 'existsSync', 'accessSync', 'access', 'createReadStream', 'createWriteStream', 'opendirSync', 'opendir', 'realpathSync', 'realpath', 'copyFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'renameSync'])

function outsideReads(rel, source) {
  const { code, strings } = tokenizeOutsideStrings(source)
  const byStart = new Map(strings.map((s) => [s.start, s.value]))
  const violations = []
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    const after = match.index + match[0].length
    if (name === 'homedir') {
      violations.push(`${rel}: executed homedir() call`)
      continue
    }
    if (!REPO_READ_CALLS.has(name)) continue
    let k = after
    while (k < source.length && /\s/.test(source[k])) k += 1
    const value = byStart.get(k)
    if (value !== undefined && (value.startsWith('/') || value === '~' || value.startsWith('~/'))) {
      violations.push(`${rel}: absolute or home-relative path argument to ${name}()`)
    }
  }
  return violations
}

function skillSources() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) { walk(rel); continue }
      if (/\.m?js$/.test(entry.name)) found.push(rel)
    }
  }
  walk('skills')
  return found.sort()
}

test('B1', () => {
  const fixtureCall = "readFileSync('/etc/hosts', 'utf8')"
  assert.equal(outsideReads('fixture.mjs', `const probe = ${fixtureCall}`).length, 1, 'an absolute-path read is an executed read')
  assert.equal(outsideReads('fixture.mjs', 'const probe = homedir()').length, 1, 'an executed homedir() is outside the repository')
  assert.equal(outsideReads('fixture.mjs', 'const probe = readFileSync(join(ROOT, "hosts"), "utf8")').length, 0, 'a repository-relative read stays inside')
  const violations = []
  const files = skillSources()
  assert.ok(files.length > 0, 'expected tracked sources under skills/')
  for (const rel of files) {
    // Fixture strings are not executable reads: only calls outside strings count.
    for (const violation of outsideReads(rel, readFileSync(join(ROOT, rel), 'utf8'))) violations.push(violation)
  }
  assert.deepEqual(violations, [], `no test or script under skills/ may read outside the repository:\n${violations.join('\n')}`)
})

// Mutation killed: removing one sources.md routing row breaks exact routing.
test('C1', () => {
  for (const skillDir of [HERE, join(ROOT, 'skills/ui-design')]) {
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    const actual = readdirSync(join(skillDir, 'references')).filter((name) => name.endsWith('.md')).sort()
    const routed = [...new Set([...skill.matchAll(/`references\/([A-Za-z0-9_-]+\.md)`/g)].map((match) => match[1]))].sort()
    assert.deepEqual(routed, actual, `${skillDir} must route every references/*.md that exists and none that does not`)
  }
})
