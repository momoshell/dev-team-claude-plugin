import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { scratchDir, ROOT } from './helpers.mjs'
import { BANNED_WORDS, RECAP_OPENERS, lintText } from '../scripts/factory/prose-lint.mjs'
import { PROMPT_NOT_APPLICABLE } from '../crew/prompt-claim.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/factory/prose-lint.mjs', import.meta.url))
const DASH = '\u2014'
const TICK = String.fromCharCode(96)
const FENCE = TICK + TICK + TICK
const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input })
const writeFixture = (dir, name, text) => { const p = join(dir, name); writeFileSync(p, text); return p }

// The expected vocabularies below are written as split string literals, and
// other banned fragments are joined inline, so no banned term appears
// contiguous in this source: the test file itself must never read as a lint corpus.
const EXPECTED_BANNED = ['del' + 've', 'fos' + 'ter', 'lev' + 'erage', 'uti' + 'lize', 'fac' + 'ilitate', 'emp' + 'ower', 'stre' + 'amline', 'rob' + 'ust', 'cut' + 'ting-edge', 'par' + 'adigm shift', 'gam' + 'e changer', 'this i' + 's huge', 'this cha' + 'nges everything', 'tap' + 'estry', 'rea' + 'lm', 'bea' + 'con', 'mult' + 'ifaceted', 'met' + 'iculous', 'int' + 'ricate', 'par' + 'amount', 'trans' + 'formative', 'ele' + 'vate', 'emb' + 'ark', 'super' + 'charge', 'ever-' + 'evolving']
const EXPECTED_RECAP = ['In con' + 'clusion', 'Ulti' + 'mately', 'Over' + 'all', 'In sum' + 'mary', 'To sum' + ' up']

test('PP1 prose-plain skill frontmatter, size, attribution and path-only citations', () => {
  const raw = readFileSync(join(ROOT, 'skills/prose-plain/SKILL.md'), 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  assert.ok(m, 'frontmatter present')
  assert.match(m[1], /^name: prose-plain$/m)
  assert.ok(m[1].includes('description: Use when writing or editing docs, ADRs, skill prose, PR bodies or commit messages in this repo; plain house style, no AI slop.'))
  const body = raw.slice(m[0].length)
  const bytes = Buffer.byteLength(body, 'utf8')
  assert.ok(bytes <= 2200, 'body ' + bytes + ' bytes <= 2200')
  assert.equal(bytes, 1723)
  assert.ok(body.includes('node scripts/factory/prose-lint.mjs'))
  assert.ok(body.includes('denominator'))
  assert.ok(body.trimEnd().endsWith('Derived from no-ai-slop by Peter Yang (MIT).'))
  assert.doesNotMatch(body, /[A-Za-z0-9_./-]+\.md:\d+/)
})

test('PP4 every banned term fires once per line in the pinned output format', () => {
  assert.deepEqual([...BANNED_WORDS], EXPECTED_BANNED)
  const dir = scratchDir('prose-pp4-')
  const text = EXPECTED_BANNED.join('\n') + '\n'
  const p = writeFixture(dir, 'all.md', text)
  const r = run([p])
  assert.equal(r.status, 1)
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, EXPECTED_BANNED.length)
  lines.forEach((line, i) => {
    assert.equal(line, p + ':' + (i + 1) + ': banned-word: ' + EXPECTED_BANNED[i])
  })
})

test('PP4 the repo noun stays exempt while case and boundaries still fire', () => {
  assert.equal(typeof lintText, 'function', 'importing the module runs no CLI')
  const noun = 'har' + 'ness'
  assert.deepEqual(lintText('The mutation ' + noun + ' stays.\n', 's'), [])
  assert.deepEqual(lintText(noun + '\n', 's'), [])
  const upper = 'DEL' + 'VE'
  const hit = lintText('We ' + upper + ' here.\n', 's')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].detail, upper)
  assert.deepEqual(lintText('un' + 'del' + 've' + 'd\n', 's'), [])
  const lever = 'lev' + 'erage'
  assert.deepEqual(lintText(lever + 's work here.\n', 's'), [])
  assert.equal(lintText(lever + ' it.\n', 's').length, 1)
})

test('PP4 multi-word phrases fire across flexible inner spacing', () => {
  const phrase = 'par' + 'adigm shift'
  const hit = lintText('A ' + phrase + ' here.\n', 's')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].detail, phrase)
  const tabbed = lintText('A par' + 'adigm\tshift here.\n', 's')
  assert.equal(tabbed.length, 1)
})

test('PP4 fenced, indented and inline-code spans are not prose', () => {
  const word = 'del' + 've'
  const doc = ['Inline ' + TICK + word + TICK + ' span.', '', FENCE, word + ' in fence', FENCE, '', '    ' + word + ' indented', '', 'Plain end.'].join('\n') + '\n'
  assert.deepEqual(lintText(doc, 's'), [])
  const dir = scratchDir('prose-pp4-code-')
  const r = run([writeFixture(dir, 'coded.md', doc)])
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('PP5 two em-dash lines are clean and three are flagged once each', () => {
  const two = ['One ' + DASH + ' here.', 'Two ' + DASH + ' here.', 'Plain end.'].join('\n') + '\n'
  assert.deepEqual(lintText(two, 's'), [])
  const dir = scratchDir('prose-pp5-')
  const clean = run([writeFixture(dir, 'two.md', two)])
  assert.equal(clean.status, 0)
  assert.equal(clean.stdout, '')
  const three = ['One ' + DASH + ' here.', 'Two ' + DASH + ' here.', 'Three ' + DASH + ' here.', 'Plain end.'].join('\n') + '\n'
  const r = run([writeFixture(dir, 'three.md', three)])
  assert.equal(r.status, 1)
  const hits = r.stdout.trim().split('\n')
  assert.equal(hits.length, 3)
  assert.ok(hits.every((line) => line.includes(': em-dash:')))
  assert.ok(hits.every((line) => line.includes('document has 3 em-dash lines (limit 2)')))
})

test('PP5 a prompt-claim line does not count toward the em-dash limit', () => {
  assert.ok(PROMPT_NOT_APPLICABLE.includes(DASH), 'control: the claim shape carries a dash')
  const doc = ['One ' + DASH + ' here.', 'Two ' + DASH + ' here.', PROMPT_NOT_APPLICABLE, 'Plain end.'].join('\n') + '\n'
  assert.deepEqual(lintText(doc, 's'), [])
  const over = ['One ' + DASH + ' here.', 'Two ' + DASH + ' here.', PROMPT_NOT_APPLICABLE, 'Three ' + DASH + ' here.', 'Plain end.'].join('\n') + '\n'
  const hits = lintText(over, 's')
  assert.equal(hits.length, 3)
  assert.ok(hits.every((hit) => hit.rule === 'em-dash'))
})

test('PP6 every recap opener fires on the last prose line only', () => {
  assert.deepEqual([...RECAP_OPENERS], EXPECTED_RECAP)
  for (const opener of EXPECTED_RECAP) {
    const end = lintText('Some prose.\n' + opener + ', we shipped it.\n', 's')
    assert.equal(end.length, 1, opener)
    assert.equal(end[0].rule, 'recap-ending')
    assert.equal(end[0].line, 2)
    assert.equal(end[0].detail, opener)
    const mid = lintText(opener + ', not the end.\nMore prose follows.\n', 's')
    assert.deepEqual(mid, [], opener + ' mid-document')
  }
})

test('PP6 a bare opener closing the document fires', () => {
  const bare = lintText('Some prose.\n' + EXPECTED_RECAP[2] + '\n', 's')
  assert.equal(bare.length, 1)
  assert.equal(bare[0].rule, 'recap-ending')
  assert.equal(bare[0].line, 2)
})

test('PP7 stdin, file, missing-path and arity contracts', () => {
  const clean = run([], 'Plain text, no findings.\n')
  assert.equal(clean.status, 0)
  assert.equal(clean.stdout, '')
  const word = 'del' + 've'
  const text = 'We should ' + word + ' into this.\n'
  const viaStdin = run([], text)
  assert.equal(viaStdin.status, 1)
  assert.match(viaStdin.stdout, /:1: banned-word: /)
  const dir = scratchDir('prose-pp7-')
  const p = writeFixture(dir, 'same.md', text)
  const viaFile = run([p])
  assert.equal(viaFile.status, viaStdin.status)
  assert.equal(viaFile.stdout.replace(/[^:]+:/, '<source>:'), viaStdin.stdout.replace(/[^:]+:/, '<source>:'))
  assert.ok(viaFile.stdout.startsWith(p + ':1:'), 'file argument is named as the source')
  const missing = run([join(dir, 'does-not-exist.md')])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /does-not-exist\.md/)
  const two = run(['a.md', 'b.md'])
  assert.equal(two.status, 2)
  assert.match(two.stderr, /usage: prose-lint \[file\]/)
})

test('PP8 the lint imports only node and relative modules', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  const first = src.split('\n').find((line) => line.startsWith('import '))
  assert.equal(first, "import { readFileSync } from 'node:fs'")
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.ok(specs.length > 0)
  assert.deepEqual(specs.filter((s) => !(s.startsWith('node:') || s.startsWith('.'))), [])
})

test('PP9 licence copy and third-party notice name the pinned revision', () => {
  const lic = readFileSync(join(ROOT, 'docs/licenses/no-ai-slop-MIT.txt'), 'utf8')
  assert.ok(lic.includes('Copyright (c) 2026 Peter Yang'))
  assert.ok(lic.includes('Permission is hereby granted, free of charge'))
  assert.equal(createHash('sha256').update(lic).digest('hex'), 'b7a7fe370cc4c9e974528c7cea7841cf8ac886bc9ed947edb11b289441fba4a8')
  const notices = readFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8')
  for (const needle of ['## no-ai-slop (MIT)', 'skills/prose-plain/SKILL.md', 'scripts/factory/prose-lint.mjs', 'https://github.com/petergyang/no-ai-slop', '000650b156983f5159695b441477f4e63b25dc85', 'docs/licenses/no-ai-slop-MIT.txt', 'Copyright (c) 2026 Peter Yang', 'rewritten for this repository']) {
    assert.ok(notices.includes(needle), needle)
  }
})
