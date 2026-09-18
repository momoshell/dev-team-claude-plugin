import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './helpers.mjs'
import { parseMarker, harvest, render } from '../scripts/factory/lean-debt.mjs'

// Fixture text is assembled at runtime so no LINE of this file is itself a marker —
// otherwise the harvester would report its own test as debt.
const M = (prefix, body) => `${prefix} lean: ${body}`

test('a marker is a whole comment line; the first ; splits ceiling from upgrade; no ; is no-trigger', () => {
  assert.deepEqual(parseMarker(M('//', 'global lock; per-account locks if throughput matters')), { ceiling: 'global lock', upgrade: 'per-account locks if throughput matters', tag: null })
  assert.deepEqual(parseMarker('    ' + M('#', 'O(n²) scan')), { ceiling: 'O(n²) scan', upgrade: null, tag: 'no-trigger' })
  assert.deepEqual(parseMarker(M('/*', 'naive heuristic; */')), { ceiling: 'naive heuristic', upgrade: null, tag: 'no-trigger' })
  assert.deepEqual(parseMarker(' ' + M('*', 'block continuation; second pass')), { ceiling: 'block continuation', upgrade: 'second pass', tag: null })
  assert.deepEqual(parseMarker(M('<!--', 'html ceiling; html upgrade -->')), { ceiling: 'html ceiling', upgrade: 'html upgrade', tag: null })
  // A comma inside the ceiling is text, not the separator.
  assert.deepEqual(parseMarker(M('//', 'tuple key (tenant, user); nested maps')), { ceiling: 'tuple key (tenant, user)', upgrade: 'nested maps', tag: null })
  // CRLF and unicode survive.
  assert.deepEqual(parseMarker(M('//', 'naïve ε-match; proper parser') + '\r'), { ceiling: 'naïve ε-match', upgrade: 'proper parser', tag: null })
  // An empty body is not a marker.
  assert.equal(parseMarker('// lean:'), null)
})

test('lean: inside a string, template, regex, or trailing on code is text — never debt', () => {
  for (const line of [
    `const s = "prefix ${M('//', 'string ceiling; upgrade')}"`,
    'const t = `prefix ' + M('//', 'template ceiling; upgrade') + '`',
    `const r = /prefix ${M('#', 'regex ceiling; upgrade')}/`,
    `run(x) ${M('//', 'trailing on code; upgrade')}`,
    'the form is `' + M('//', 'x; y') + '` in a comment',
    'marked in a comment as `lean: <ceiling>; <upgrade path>` so it is tracked',
    'const lean = 1',
  ]) assert.equal(parseMarker(line), null, line)
})

test('harvest never follows symlinks, skips vendored and unreadable dirs, sorts, and render carries the denominator', () => {
  const root = scratchDir('lean-debt')
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'node_modules', 'x'), { recursive: true }); mkdirSync(join(root, 'locked'))
  writeFileSync(join(root, 'src', 'b.mjs'), 'x()\n' + M('//', 'single worker; a pool when the queue backs up') + '\n')
  writeFileSync(join(root, 'src', 'a.mjs'), M('//', 'string match') + '\nconst y = 2\n')
  writeFileSync(join(root, 'src', 'eof.mjs'), M('#', 'no trailing newline; fine'))
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), M('//', 'must not be seen') + '\n')
  writeFileSync(join(root, 'locked', 'z.mjs'), M('//', 'unreadable dir') + '\n')
  // A directory symlink to a tree OUTSIDE root that holds a marker: following it would add a
  // row (a loop once multiplied one marker 35×). Observable as a count, never as a hang.
  const outside = scratchDir('lean-debt-outside'); writeFileSync(join(outside, 'o.mjs'), M('//', 'outside; must not be seen') + '\n')
  symlinkSync(outside, join(root, 'src', 'link'), 'dir')
  chmodSync(join(root, 'locked'), 0o000)
  let rows
  try { rows = harvest(root) } finally { chmodSync(join(root, 'locked'), 0o755) }
  assert.deepEqual(rows.map((r) => [r.file, r.line, r.tag]), [['src/a.mjs', 1, 'no-trigger'], ['src/b.mjs', 2, null], ['src/eof.mjs', 1, null]])
  const out = render(rows)
  assert.match(out, /^src\/a\.mjs:1: string match\. upgrade: \(none\)\. \[no-trigger\]$/m)
  assert.match(out, /3 markers, 1 with no trigger\.\n$/)
  assert.equal(render([]), 'No lean: debt. Clean ledger.\n')
})
