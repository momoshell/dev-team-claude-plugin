import assert from 'node:assert/strict'
import { test } from 'node:test'
import { vitestSummaryPassed, vitestTitlePattern } from './gate-kit.mjs'
import { forAll } from '../../test/helpers.mjs'

// Mutation: returning title unescaped lets regex metacharacters match altered titles.
test('VG1 escapes exact titles and rejects every one-character alteration', () => {
  const title = 'x ^ $ . * + ? ( ) [ ] { } | \\ y'
  const pattern = new RegExp(vitestTitlePattern(title))
  assert.equal(vitestTitlePattern(title), '^x \\^ \\$ \\. \\* \\+ \\? \\( \\) \\[ \\] \\{ \\} \\| \\\\ y$')
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
