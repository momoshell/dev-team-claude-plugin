import { test } from 'node:test'
import { scratchDir } from '../test/helpers.mjs'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import * as memory from './memory.mjs'

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('an unknown backend name refuses by name — the check is closed, not a lookup that falls through', () => {
  const dir = scratchDir('memory-backend-')
  assert.throws(() => memory.openMemory({ dir, backend: 'misspelt' }), /unknown memory backend "misspelt"/)
})

test('missing index, empty index, and unreadable linked files carry reasons without hiding readable files', () => {
  const noIndex = mkdtempSync(join(tmpdir(), 'crew-memory-no-index-'))
  const empty = mkdtempSync(join(tmpdir(), 'crew-memory-empty-index-'))
  const broken = mkdtempSync(join(tmpdir(), 'crew-memory-broken-'))
  try {
    const absent = memory.openMemory({ dir: noIndex }).context({})
    assert.equal(absent.reason, 'no-index')

    writeFileSync(join(empty, 'MEMORY.md'), 'just prose, no markdown links\n')
    const bare = memory.openMemory({ dir: empty }).context({})
    assert.equal(bare.reason, 'empty-index')
    assert.equal(bare.included[0].path, 'MEMORY.md')

    writeFileSync(join(broken, 'MEMORY.md'), [
      '- [Gone](gone.md) — missing',
      '- [Directory](subdir) — not a file',
      '- [Kept](kept.md) — readable',
      '',
    ].join('\n'))
    mkdirSync(join(broken, 'subdir'))
    writeFileSync(join(broken, 'kept.md'), 'kept body\n')
    const partial = memory.openMemory({ dir: broken }).context({})
    assert.match(partial.text, /kept body/)
    assert.deepEqual(partial.dropped.map((entry) => [entry.path, entry.reason]), [
      ['gone.md', 'unreadable'], ['subdir', 'unreadable'],
    ])
  } finally { clean(noIndex); clean(empty); clean(broken) }
})

test('markdown memory rejects parent and absolute links with outside-dir drops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-guard-'))
  const outside = join(dir, '..', 'crew-memory-secret.md')
  const absolute = resolvePath(dir, '..', 'crew-memory-absolute-secret.md')
  try {
    writeFileSync(outside, 'PARENT SECRET')
    writeFileSync(absolute, 'ABSOLUTE SECRET')
    writeFileSync(join(dir, 'MEMORY.md'), [
      '- [Parent](../crew-memory-secret.md) — escape',
      `- [Absolute](${absolute}) — absolute`,
      '',
    ].join('\n'))
    const extract = memory.openMemory({ dir }).context({})
    assert.doesNotMatch(extract.text, /SECRET/)
    assert.deepEqual(extract.dropped.map((entry) => entry.reason), ['outside-dir', 'outside-dir'])
    assert.ok(extract.dropped.every((entry) => !isAbsolute(entry.path)))
  } finally { clean(dir); rmSync(outside, { force: true }); rmSync(absolute, { force: true }) }
})
