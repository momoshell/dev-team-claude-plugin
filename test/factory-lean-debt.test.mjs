import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './helpers.mjs'
import { parseMarker, harvest, render, UNMEASURED_REASONS } from '../scripts/factory/lean-debt.mjs'

// Fixture text is assembled at runtime so no LINE of this file is itself a marker —
// otherwise the harvester would report its own test as debt.
const M = (prefix, body) => `${prefix} lean: ${body}`

test('a marker is a whole comment line; the first ; splits ceiling from upgrade; no ; is no-trigger; an empty ceiling is nothing', () => {
  assert.deepEqual(parseMarker(M('//', 'global lock; per-account locks if throughput matters')), { ceiling: 'global lock', upgrade: 'per-account locks if throughput matters', tag: null })
  assert.deepEqual(parseMarker('    ' + M('#', 'O(n²) scan')), { ceiling: 'O(n²) scan', upgrade: null, tag: 'no-trigger' })
  assert.deepEqual(parseMarker(M('/*', 'naive heuristic; */')), { ceiling: 'naive heuristic', upgrade: null, tag: 'no-trigger' })
  assert.deepEqual(parseMarker(' ' + M('*', 'block continuation; second pass')), { ceiling: 'block continuation', upgrade: 'second pass', tag: null })
  assert.deepEqual(parseMarker(M('<!--', 'html ceiling; html upgrade -->')), { ceiling: 'html ceiling', upgrade: 'html upgrade', tag: null })
  assert.deepEqual(parseMarker(M('//', 'tuple key (tenant, user); nested maps')), { ceiling: 'tuple key (tenant, user)', upgrade: 'nested maps', tag: null })
  assert.deepEqual(parseMarker(M('//', 'naïve ε-match; proper parser') + '\r'), { ceiling: 'naïve ε-match', upgrade: 'proper parser', tag: null })
  assert.equal(parseMarker('// lean:'), null)
  assert.equal(parseMarker(M('//', '; upgrade only')), null, 'an empty ceiling names nothing')
})

test('lean: inside a single-line string, template, regex, or trailing on code is text — never debt', () => {
  for (const line of [
    `const s = "prefix ${M('//', 'string ceiling; upgrade')}"`,
    'const t = `prefix ' + M('//', 'template ceiling; upgrade') + '`',
    `const r = /prefix ${M('#', 'regex ceiling; upgrade')}/`,
    `run(x) ${M('//', 'trailing on code; upgrade')}`,
    'the form is `' + M('//', 'x; y') + '` in a comment',
    'const lean = 1',
  ]) assert.equal(parseMarker(line), null, line)
})

test('the scan is line-based: a marker-shaped line inside a MULTILINE literal is counted — the named ceiling of this tool', () => {
  // Documented, not hidden: crew/roles/_shared.md forbids marker-shaped lines in multiline
  // literals, and the harvester carries this ceiling as its own lean: marker.
  const root = scratchDir('lean-debt-multiline')
  writeFileSync(join(root, 'm.mjs'), 'const t = `\n' + M('//', 'inside a template; a lexer if ever needed') + '\n`\n')
  const { rows } = harvest(root)
  assert.deepEqual(rows.map((r) => [r.file, r.line]), [['m.mjs', 2]])
})

test('harvest never follows symlinks (external or self-loop), skips vendored dirs, keeps paths with spaces, and reports every unreadable path', () => {
  const root = scratchDir('lean-debt')
  mkdirSync(join(root, 'src', 'with space'), { recursive: true }); mkdirSync(join(root, 'node_modules', 'x'), { recursive: true }); mkdirSync(join(root, 'locked'))
  writeFileSync(join(root, 'src', 'b.mjs'), 'x()\n' + M('//', 'single worker; a pool when the queue backs up') + '\n')
  writeFileSync(join(root, 'src', 'a.mjs'), M('//', 'string match') + '\nconst y = 2\n')
  writeFileSync(join(root, 'src', 'with space', 'sp.mjs'), M('#', 'spaced path; fine'))
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), M('//', 'must not be seen') + '\n')
  writeFileSync(join(root, 'locked', 'z.mjs'), M('//', 'in an unreadable dir') + '\n')
  writeFileSync(join(root, 'src', 'secret.mjs'), M('//', 'an unreadable file') + '\n')
  const outside = scratchDir('lean-debt-outside'); writeFileSync(join(outside, 'o.mjs'), M('//', 'outside; must not be seen') + '\n')
  symlinkSync(outside, join(root, 'src', 'link'), 'dir')           // external: following would add a row
  symlinkSync(root, join(root, 'src', 'loop'), 'dir')              // self-loop: following would recurse forever
  chmodSync(join(root, 'locked'), 0o000); chmodSync(join(root, 'src', 'secret.mjs'), 0o000)
  let result
  try { result = harvest(root) } finally { chmodSync(join(root, 'locked'), 0o755); chmodSync(join(root, 'src', 'secret.mjs'), 0o644) }
  assert.deepEqual(result.rows.map((r) => [r.file, r.line, r.tag]), [['src/a.mjs', 1, 'no-trigger'], ['src/b.mjs', 2, null], ['src/with space/sp.mjs', 1, null]])
  assert.deepEqual(result.unmeasured, [{ path: 'locked', reason: 'dir-unreadable' }, { path: 'src/secret.mjs', reason: 'file-unreadable' }])
  for (const u of result.unmeasured) assert.ok(UNMEASURED_REASONS.includes(u.reason))
  const out = render(result)
  assert.match(out, /^src\/a\.mjs:1: string match\. upgrade: \(none\)\. \[no-trigger\]$/m)
  assert.match(out, /^locked: unmeasured \[dir-unreadable\]$/m)
  assert.match(out, /3 markers, 1 with no trigger, 2 paths unmeasured\.\n$/)
})

test('a clean ledger is claimed only when every candidate was read', () => {
  assert.equal(render({ rows: [], unmeasured: [] }), 'No lean: debt. Clean ledger.\n')
  const out = render({ rows: [], unmeasured: [{ path: 'x.mjs', reason: 'file-unreadable' }] })
  assert.equal(out.includes('Clean ledger'), false)
  assert.match(out, /0 markers, 0 with no trigger, 1 paths unmeasured\./)
})
