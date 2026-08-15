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

test('memory namespace and handle expose the slice verbs without module-level reconcile or gc', () => {
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
    assert.equal(typeof handle.reconcile, 'function')
    assert.equal(typeof handle.gc, 'function')
  } finally { clean(dir) }
})

test('reconcile updates an entry in place and context reflects it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-reconcile-update-'))
  try {
    const mem = memory.openMemory({ dir, budgetBytes: 10000 })
    mem.propose({ name: 'reconcile-entry', description: 'original description', type: 'feedback', body: 'old body' })
    const result = mem.reconcile({ name: 'reconcile-entry', body: 'new body' })
    assert.equal(result.created, false)
    assert.equal(result.updated, true)
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.equal((index.match(/\]\(reconcile-entry\.md\)/g) || []).length, 1)
    const extract = mem.context({})
    assert.match(extract.text, /new body/)
    assert.doesNotMatch(extract.text, /old body/)
    const file = readFileSync(join(dir, 'reconcile-entry.md'), 'utf8')
    assert.match(file, /description: original description/)
    assert.match(file, /  type: feedback/)
  } finally { clean(dir) }
})

test('reconcile creates a missing entry and repairs a drifted index line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-reconcile-create-'))
  try {
    const mem = memory.openMemory({ dir })
    const created = mem.reconcile({ name: 'repair-entry', description: 'first description', type: 'project', body: 'body' })
    assert.equal(created.created, true)
    const indexPath = join(dir, 'MEMORY.md')
    writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('first description', 'stale description'))
    const repaired = mem.reconcile({ name: 'repair-entry', description: 'new description' })
    assert.equal(repaired.created, false)
    assert.equal(repaired.indexUpdated, true)
    const index = readFileSync(indexPath, 'utf8')
    assert.match(index, /- \[repair-entry\]\(repair-entry\.md\) — new description\n/)
    assert.equal((index.match(/\]\(repair-entry\.md\)/g) || []).length, 1)
  } finally { clean(dir) }
})

test('reconcile rejects invalid names and untyped creates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-reconcile-invalid-'))
  try {
    const mem = memory.openMemory({ dir })
    assert.throws(() => mem.reconcile({ name: 'Bad Name', type: 'project' }), /invalid memory name/)
    assert.throws(() => mem.reconcile({ name: 'missing-type', body: 'body' }), /invalid memory type/)
  } finally { clean(dir) }
})

test('gc prunes orphaned and escaping index lines and leaves files alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-gc-prune-'))
  try {
    const mem = memory.openMemory({ dir, budgetBytes: 10000 })
    mem.propose({ name: 'live-entry', description: 'live', type: 'project', body: 'live body' })
    const livePath = join(dir, 'live-entry.md')
    const liveBefore = readFileSync(livePath, 'utf8')
    const indexPath = join(dir, 'MEMORY.md')
    writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}- [Gone](gone.md) — orphan\n- [Escape](../escape.md) — escape\n`)
    const report = mem.gc()
    assert.deepEqual(report.pruned, [
      { path: 'gone.md', reason: 'orphaned' },
      { path: '../escape.md', reason: 'escaping' },
    ])
    const index = readFileSync(indexPath, 'utf8')
    assert.match(index, /live-entry\.md/)
    assert.doesNotMatch(index, /gone\.md/)
    assert.doesNotMatch(index, /\.\.\/escape\.md/)
    assert.equal(readFileSync(livePath, 'utf8'), liveBefore)
    const extract = mem.context({})
    assert.match(extract.text, /live body/)
    assert.equal(extract.dropped.some((entry) => entry.reason === 'unreadable' || entry.reason === 'outside-dir'), false)
  } finally { clean(dir) }
})

test('gc reports unlinked files and over-budget drops without acting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-gc-report-'))
  try {
    const mem = memory.openMemory({ dir, budgetBytes: 1 })
    mem.propose({ name: 'budget-entry', description: 'budget', type: 'reference', body: 'budget body' })
    const orphanPath = join(dir, 'orphan-file.md')
    writeFileSync(orphanPath, 'unindexed body')
    const before = readFileSync(orphanPath, 'utf8')
    const report = mem.gc()
    assert.ok(report.unlinked.includes('orphan-file.md'))
    assert.ok(report.overBudget.length > 0)
    assert.equal(readFileSync(orphanPath, 'utf8'), before)
    assert.equal(readFileSync(join(dir, 'budget-entry.md'), 'utf8').includes('budget body'), true)
  } finally { clean(dir) }
})

test('gc on a missing dir or missing index returns an empty report', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-memory-gc-missing-'))
  const missing = join(parent, 'missing')
  const noIndex = join(parent, 'no-index')
  try {
    const expected = { ok: true, dryRun: false, pruned: [], kept: 0, unlinked: [], overBudget: [] }
    assert.deepEqual(memory.openMemory({ dir: missing }).gc(), expected)
    mkdirSync(noIndex)
    assert.deepEqual(memory.openMemory({ dir: noIndex }).gc(), expected)
  } finally { clean(parent) }
})

test('gc dry run reports without mutating MEMORY.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-gc-dry-run-'))
  try {
    const mem = memory.openMemory({ dir })
    mem.propose({ name: 'dry-entry', description: 'dry', type: 'project', body: 'dry body' })
    const indexPath = join(dir, 'MEMORY.md')
    writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}- [Gone](dry-gone.md) — orphan\n`)
    const snapshot = readFileSync(indexPath, 'utf8')
    const report = mem.gc({ dryRun: true })
    assert.equal(report.dryRun, true)
    assert.ok(report.pruned.some((entry) => entry.path === 'dry-gone.md'))
    assert.equal(readFileSync(indexPath, 'utf8'), snapshot)
  } finally { clean(dir) }
})
