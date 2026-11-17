import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { scratchDir } from './helpers.mjs'
import { PROMPT_NOT_APPLICABLE, RECAP_OPENERS, lintText } from '../scripts/factory/prose-lint.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/factory/prose-lint.mjs', import.meta.url))
const DASH = '\u2014'
const TICK = String.fromCharCode(96)
const FENCE = TICK + TICK + TICK
const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input })
const writeFixture = (dir, name, text) => { const p = join(dir, name); writeFileSync(p, text); return p }

const EXPECTED_RECAP = ['In con' + 'clusion', 'Ulti' + 'mately', 'Over' + 'all', 'In sum' + 'mary', 'To sum' + ' up']

test('PP4 fenced, indented and inline-code spans are not prose', () => {
  const word = 'del' + 've'
  const doc = ['Inline ' + TICK + word + TICK + ' span.', '', FENCE, word + ' in fence', FENCE, '', '    ' + word + ' indented', '', 'Plain end.'].join('\n') + '\n'
  assert.deepEqual(lintText(doc, 's'), [])
  const dir = scratchDir('prose-pp4-code-')
  const r = run([writeFixture(dir, 'coded.md', doc)])
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
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
