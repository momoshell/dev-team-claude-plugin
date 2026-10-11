import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vitestSummaryPassed, vitestTitlePattern } from './gate-kit.mjs'
import { forAll, ROOT } from '../../test/helpers.mjs'

// Mutation: returning title unescaped lets regex metacharacters match altered titles.
test('VG1 escapes exact titles and rejects every one-character alteration', () => {
  const title = 'x ^ $ . * + ? ( ) [ ] { } | \\ y'
  const pattern = new RegExp(vitestTitlePattern(title))
  assert.equal(vitestTitlePattern(title), '(?:^|\\s)x \\^ \\$ \\. \\* \\+ \\? \\( \\) \\[ \\] \\{ \\} \\| \\\\ y$')
  assert.equal(pattern.test(title), true)
  assert.equal(pattern.test('prefix' + title), false)
  assert.equal(pattern.test(title + 'suffix'), false)
  for (let i = 0; i < title.length; i += 1) {
    const changed = title.slice(0, i) + (title[i] === 'z' ? 'q' : 'z') + title.slice(i + 1)
    assert.equal(pattern.test(changed), false, `alteration at ${i}`)
  }
  assert.equal(new RegExp(vitestTitlePattern('above 2^53')).test('above 2^53'), true)
})

test('VG1 generated titles preserve exact literal matching', () => {
  forAll((random) => {
    const alphabet = ['a', 'Z', '7', ' ', 'é', '雪']
    const length = Math.floor(random() * 24)
    let title = '.*+?^$()[]{}|\\'
    for (let i = 0; i < length; i += 1) title += alphabet[Math.floor(random() * alphabet.length)]
    const index = Math.floor(random() * title.length)
    const altered = title.slice(0, index) + (title[index] === 'q' ? 'r' : 'q') + title.slice(index + 1)
    return { title, altered }
  }, ({ title, altered }) => {
    const pattern = new RegExp(vitestTitlePattern(title))
    assert.equal(pattern.test(title), true)
    assert.equal(pattern.test(altered), false)
    assert.equal(pattern.test('x' + title), false)
    assert.equal(pattern.test(title + 'x'), false)
  })
})

// Mutation: fixed '1 passed' matching rejects valid captured totals and counts.
test('VG2 accepts only the final passed-only Tests summary with matching counts', () => {
  const cases = [
    ['Tests  1 passed (1)', 1, true], ['Tests  1 passed', 1, true],
    ['\x1b[32mTests  1 passed (1)\x1b[0m', 1, true],
    ['\x1b[32mTests  1 passed\x1b[0m', 1, true],
    ['Tests  1 failed | 1 passed (2)', 1, false], ['Tests  1 skipped (1)', 1, false],
    ['Tests  1 passed | 1 skipped (2)', 1, false], ['Tests  2 passed (2)', 1, false],
    ['Test Files  1 passed (1)', 1, false], ['', 1, false],
    ['Tests  1 passed (2)', 1, false], ['Tests  1 passed (1)\nTests  1 failed (1)', 1, false],
    ['Tests  2 passed (2)', 2, true], ['Tests  1 passed (1)', -1, false],
    ['Tests  1 passed (1)', '1', false], ['Tests  1 passed (1)\r\n', 1, true],
    ['  \tTests   1 passed   (1)  \t', 1, true],
    ['Tests  1 passed (1)\nTest Files  2 passed (2)', 1, true],
  ]
  for (const [output, count, expected] of cases) assert.equal(vitestSummaryPassed(output, count), expected, output)
})

test('VG2 generated reporter summaries follow independent status and total oracles', () => {
  forAll((random) => {
    const count = 1 + Math.floor(random() * 12)
    const mixed = random() < 0.5
    const total = random() < 0.5 ? count : count + 1
    const ansi = random() < 0.5
    const prefix = random() < 0.5 ? 'noise\n' : ''
    const line = mixed
      ? `Tests  ${count} passed | 1 skipped (${total + 1})`
      : `Tests  ${count} passed (${total})`
    return { count, mixed, total, output: prefix + (ansi ? `\x1b[32m${line}\x1b[0m` : line) }
  }, ({ count, mixed, total, output }) => {
    const expected = !mixed && total === count
    assert.equal(vitestSummaryPassed(output, count), expected)
  })
})

// MUTATION VK1: replace the filtered total equality with true; inconsistent totals turn green.
test('VK1 filtered summaries require consistent totals and reject invalid rows', () => {
  const rows = [
    ['Tests  1 passed | 3 skipped (4)', 1, true],
    ['Tests  4 skipped (4)', 1, false],
    ['Tests  1 failed | 3 skipped (4)', 1, false],
    ['Tests  2 passed | 2 skipped (4)', 1, false],
    ['Tests  1 passed | 3 skipped (5)', 1, false],
    ['Tests  1 passed | 1 todo (2)', 1, false],
    ['Tests  1 passed | 1 pending (2)', 1, false],
    ['Tests  1 passed | 1 unknown (2)', 1, false],
    ['Tests  1 passed | 0 skipped (1)', 1, true],
    ['Tests  1 passed', 1, true],
    ['Tests  1 passed (2)', 1, false],
    ['Tests  1 passed (1)\r\n', 1, true],
    ['Tests  4 skipped (4)\r\n\x1b[32mTests  1 passed | 3 skipped (4)\x1b[0m', 1, true],
    ['Tests  1 passed | 3 skipped (4)\nTests  4 skipped (4)', 1, false],
  ]
  for (const [output, count, expected] of rows) assert.equal(vitestSummaryPassed(output, count, { filtered: true }), expected, output)
  for (const count of ['1', 1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(vitestSummaryPassed('Tests  1 passed', count, { filtered: true }), false, String(count))
  }
  let generated = 0
  forAll((random) => {
    const category = generated++ % 8
    const passed = Math.floor(random() * 4)
    const skipped = category % 3 === 0 ? null : Math.floor(random() * 4)
    const extra = category === 4 ? 'failed' : category === 5 ? 'todo' : category === 6 ? 'unknown' : null
    const hasTotal = category % 2 === 0
    const delta = Math.floor(random() * 3) - 1
    const count = category === 7 ? '1' : category === 3 ? 1.5 : Math.max(1, passed)
    const printTotal = passed + (skipped ?? 0) + (extra ? 1 : 0) + delta
    const line = ' \tTests  ' + passed + ' passed' + (skipped === null ? '' : ' | ' + skipped + ' skipped') + (extra ? ' | 1 ' + extra : '') + (hasTotal ? ' (' + printTotal + ')' : '') + ' \t'
    const output = (category === 0 ? 'Tests  4 skipped (4)\r\n' : '') + (category === 2 ? '\x1b[32m' + line + '\x1b[0m' : line)
    const expected = Number.isSafeInteger(count) && count >= 1 && passed === count && extra === null && (!hasTotal || printTotal === passed + (skipped ?? 0))
    return { output, count, expected }
  }, ({ output, count, expected }) => assert.equal(vitestSummaryPassed(output, count, { filtered: true }), expected, JSON.stringify({ output, count, expected })))
  for (const [output, count, expected] of [['Tests  0 passed (0)', 0, true], ['Tests  1 passed | 3 skipped (4)', 1, false], ['Tests  1 passed (1)', 1, true]]) {
    assert.equal(vitestSummaryPassed(output, count, {}), expected, output)
    assert.equal(vitestSummaryPassed(output, count, { filtered: false }), expected, output)
  }
})

// MUTATION VK2: lower count >= 1 to count >= 0; zero-passed filtered summaries turn green.
test('VK2 filtered summaries reject runs with no passed tests', () => {
  for (const [output, count, expected] of [['Tests  4 skipped (4)', 0, false], ['Tests  4 skipped (4)', 1, false], ['Tests  0 passed | 4 skipped (4)', 0, false], ['Tests  0 passed (0)', 0, false], ['Tests  1 passed | 3 skipped (4)', 1, true]]) {
    assert.equal(vitestSummaryPassed(output, count, { filtered: true }), expected, output)
  }
})

// MUTATION VK3: restore the ^ start anchor; describe-prefixed full names stop matching.
test('VK3 title patterns admit suite prefixes but not glued or altered names', () => {
  const title = 'x ^ $ . * + ? ( ) [ ] { } | \\ y'
  const pattern = new RegExp(vitestTitlePattern(title))
  for (const name of [title, 'advisory decisions ' + title, 'advisory decisions > ' + title]) assert.equal(pattern.test(name), true, name)
  for (const name of [title + 'x', 'x' + title]) assert.equal(pattern.test(name), false, name)
  for (let i = 0; i < title.length; i += 1) {
    const changed = title.slice(0, i) + (title[i] === 'z' ? 'q' : 'z') + title.slice(i + 1)
    assert.equal(pattern.test(changed), false, 'alteration at ' + i)
  }
})

// MUTATION VK4: remove { filtered: true } from the guideline call; the measured filtered pass returns a finding.
test('VK4 executable guideline uses filtered verdicts for passed and all-skipped runs', () => {
  const source = readFileSync(join(ROOT, 'crew', 'guidelines', 'vitest-gates.md'), 'utf8')
  const fence = String.fromCharCode(96).repeat(3)
  const body = source.match(new RegExp('A minimal executable gate-check body returns a finding string when red:\\n\\n' + fence + 'js\\n([\\s\\S]+?)\\n' + fence))
  assert.notEqual(body, null)
  const run = new Function('spawnSync', 'vitestTitlePattern', 'vitestSummaryPassed', 'testFile', 'title', body[1])
  for (const [stdout, green] of [['Tests  1 passed | 3 skipped (4)', true], ['Tests  4 skipped (4)', false]]) {
    const actual = run(() => ({ error: null, status: 0, stdout, stderr: '' }), vitestTitlePattern, vitestSummaryPassed, 'target.test.mjs', 'target')
    if (green) assert.equal(actual, null)
    else assert.equal(typeof actual === 'string' && actual.length > 0, true)
  }
})
