import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './helpers.mjs'
import { parseMarker, harvest, render } from '../scripts/factory/lean-debt.mjs'
// Fixture text is assembled at runtime so no LINE of this file is itself a marker —
// otherwise the harvester would report its own test as debt.
const M = (prefix, body) => `${prefix} lean: ${body}`

test('a lean: marker parses into ceiling and upgrade, and a missing upgrade is no-trigger', () => {
  assert.deepEqual(parseMarker(M('//', 'global lock, per-account locks if throughput matters')),
    { ceiling: 'global lock', upgrade: 'per-account locks if throughput matters', tag: null })
  assert.deepEqual(parseMarker(M('#', 'O(n²) scan')), { ceiling: 'O(n²) scan', upgrade: null, tag: 'no-trigger' })
  assert.deepEqual(parseMarker('  ' + M('/*', 'naive heuristic, */')), { ceiling: 'naive heuristic', upgrade: null, tag: 'no-trigger' })
  // Prose that mentions the convention is not debt: only a comment-prefixed marker counts.
  assert.equal(parseMarker('marked in a comment as `lean: <ceiling>, <upgrade path>` so it is tracked'), null)
  assert.equal(parseMarker('const lean = 1'), null)
  // A marker inside a string, template or regex literal is an EXAMPLE, not debt.
  assert.equal(parseMarker("writeFileSync(p, '// lean: fixture text')"), null)
  assert.equal(parseMarker('the form is `// lean: x, y` in a comment'), null)
  assert.equal(parseMarker('const R = /# lean: (.+)/'), null)
  // Trailing on a code line is a comment and counts.
  assert.deepEqual(parseMarker('run(x) ' + M('//', 'sync call, batch when n > 50')), { ceiling: 'sync call', upgrade: 'batch when n > 50', tag: null })
})

test('harvest walks a tree, skips vendored dirs, sorts by file then line, and render carries the denominator', () => {
  const root = scratchDir('lean-debt')
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'src', 'b.mjs'), 'x()\n' + M('//', 'single worker, a pool when the queue backs up') + '\n')
  writeFileSync(join(root, 'src', 'a.mjs'), M('//', 'string match') + '\nconst y = 2\n')
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), M('//', 'must not be seen') + '\n')
  const rows = harvest(root)
  assert.deepEqual(rows.map((r) => [r.file, r.line, r.tag]), [['src/a.mjs', 1, 'no-trigger'], ['src/b.mjs', 2, null]])
  const out = render(rows)
  assert.match(out, /^src\/a\.mjs:1, string match\. ceiling: string match\. upgrade: \(none\)\. \[no-trigger\]$/m)
  assert.match(out, /2 markers, 1 with no trigger\.\n$/)
  assert.equal(render([]), 'No lean: debt. Clean ledger.\n')
})
