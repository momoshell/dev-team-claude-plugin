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
const EXPECTED_REFS = ['absence.md', 'keyboard-focus.md', 'motion.md', 'states.md']
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
      if (line.includes(VERCEL_ID)) vercel += 1
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
