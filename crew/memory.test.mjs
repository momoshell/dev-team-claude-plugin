import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import * as memory from './memory.mjs'

function fixture(order = ['alpha', 'beta']) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-'))
  writeFileSync(join(dir, 'MEMORY.md'), [
    '- [Alpha](alpha.md) — first hook',
    '- [Beta](beta.md) — second hook',
    '',
  ].join('\n'))
  for (const name of order) writeFileSync(join(dir, `${name}.md`), `${name.toUpperCase()} body\n`)
  return dir
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('markdown memory includes MEMORY.md first and linked files in index order', () => {
  const dir = fixture()
  try {
    const extract = memory.openMemory({ dir, budgetBytes: 10000 }).context({ task: 'task', role: 'lead' })
    assert.deepEqual(extract.included.map((entry) => entry.path), ['MEMORY.md', 'alpha.md', 'beta.md'])
    assert.ok(extract.text.indexOf('### MEMORY.md') < extract.text.indexOf('### alpha.md'))
    assert.ok(extract.text.indexOf('### alpha.md') < extract.text.indexOf('### beta.md'))
    assert.match(extract.text, /first hook/)
    assert.match(extract.text, /ALPHA body/)
    assert.match(extract.text, /BETA body/)
  } finally { clean(dir) }
})

test('markdown memory text is deterministic despite repeated reads and creation order', () => {
  const first = fixture(['alpha', 'beta'])
  const second = fixture(['beta', 'alpha'])
  try {
    const one = memory.openMemory({ dir: first, budgetBytes: 10000 }).context({ task: 'one', role: 'lead' })
    const two = memory.openMemory({ dir: first, budgetBytes: 10000 }).context({ task: 'two', role: 'planner' })
    const three = memory.openMemory({ dir: second, budgetBytes: 10000 }).context({ task: 'three', role: 'builder' })
    assert.equal(one.text, two.text)
    assert.equal(one.text, three.text)
  } finally { clean(first); clean(second) }
})

test('markdown memory stops at the budget and renderSection reports every dropped path', () => {
  const dir = fixture()
  try {
    const extract = memory.openMemory({ dir, budgetBytes: 100 }).context({ task: 'task', role: 'lead' })
    assert.ok(extract.included.length > 0)
    assert.ok(extract.dropped.length > 0)
    assert.ok(extract.dropped.every((entry) => entry.reason === 'over-budget'))
    const section = memory.renderSection(extract, { backend: 'markdown' })
    for (const entry of extract.dropped) assert.ok(section.includes(entry.path.split('/').at(-1)))
    assert.match(section, /<!-- memory: included \d+ \(\d+ bytes\); dropped:/)
  } finally { clean(dir) }
})

test('missing memory directory degrades to an empty no-dir extract', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-memory-missing-'))
  const dir = join(parent, 'gone')
  try {
    const extract = memory.openMemory({ dir }).context({ task: 'task', role: 'lead' })
    assert.deepEqual(extract, { text: '', bytes: 0, included: [], dropped: [], reason: 'no-dir' })
  } finally { clean(parent) }
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

test('propose round trips a memory body and index line through context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-propose-'))
  try {
    const mem = memory.openMemory({ dir, budgetBytes: 10000 })
    const result = mem.propose({ name: 'boot-seam', description: 'keep boot safe', type: 'feedback', body: 'memory must never fail boot' })
    assert.equal(result.ok, true)
    assert.equal(result.indexed, false)
    assert.equal(readFileSync(result.path, 'utf8'), '---\nname: boot-seam\ndescription: keep boot safe\nmetadata:\n  type: feedback\n---\n\nmemory must never fail boot')
    const extract = mem.context({})
    assert.match(extract.text, /memory must never fail boot/)
    assert.match(extract.text, /\[boot-seam\]\(boot-seam\.md\)/)
  } finally { clean(dir) }
})

test('propose is idempotent on the index and rejects invalid names and types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-propose-idempotent-'))
  try {
    const mem = memory.openMemory({ dir })
    const delta = { name: 'same-memory', description: 'same description', type: 'reference', body: 'same body' }
    assert.equal(mem.propose(delta).indexed, false)
    assert.equal(mem.propose(delta).indexed, true)
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.equal(index.match(/same-memory\.md/g).length, 1)
    assert.throws(() => mem.propose({ ...delta, name: 'Bad Name' }), /invalid memory name/)
    assert.throws(() => mem.propose({ ...delta, type: 'other' }), /invalid memory type/)
  } finally { clean(dir) }
})

test('memory namespace and handle expose only the slice verbs, with reconcile and gc absent', () => {
  const dir = fixture()
  try {
    assert.equal(typeof memory.openMemory, 'function')
    assert.equal(typeof memory.renderSection, 'function')
    assert.equal(typeof memory.BACKENDS.markdown, 'function')
    assert.equal(Object.hasOwn(memory, 'reconcile'), false)
    assert.equal(Object.hasOwn(memory, 'gc'), false)
    const handle = memory.openMemory({ dir })
    assert.equal(typeof handle.context, 'function')
    assert.equal(typeof handle.propose, 'function')
    assert.equal(Object.hasOwn(handle, 'reconcile'), false)
    assert.equal(Object.hasOwn(handle, 'gc'), false)
  } finally { clean(dir) }
})
