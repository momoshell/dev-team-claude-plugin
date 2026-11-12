import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ROOT, scratchDir } from '../test/helpers.mjs'
import assert from 'node:assert/strict'
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
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

test('an unknown backend name refuses by name — the check is closed, not a lookup that falls through', () => {
  const dir = scratchDir('memory-backend-')
  assert.throws(() => memory.openMemory({ dir, backend: 'misspelt' }), /unknown memory backend "misspelt"/)
})

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

test('context leaves a planted run-fact entry unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-memory-read-lint-'))
  try {
    const indexPath = join(dir, 'MEMORY.md')
    const entryPath = join(dir, 'stale.md')
    const index = '- [Stale](stale.md) — planted run fact\n'
    const entry = '---\nname: stale\ndescription: planted run fact\nmetadata:\n  type: project\n---\n\nPR #219 merged after review.\n'
    writeFileSync(indexPath, index)
    writeFileSync(entryPath, entry)
    const mem = memory.openMemory({ dir, budgetBytes: 10000 })
    assert.match(mem.context({}).text, /PR #219 merged after review\./)
    assert.equal(readFileSync(entryPath, 'utf8'), entry)
    assert.equal(readFileSync(indexPath, 'utf8'), index)
  } finally { clean(dir) }
})

test('the markdown memory handle exposes context without propose, reconcile or gc', () => {
  const dir = fixture()
  try {
    const handle = memory.openMemory({ dir })
    for (const verb of ['propose', 'reconcile', 'gc']) assert.equal(verb in handle, false)
    assert.equal(typeof handle.context, 'function')
    for (const name of ['lintMemoryDelta', 'MemoryLintError', 'RUN_FACT_RULES', 'reconcile', 'gc']) {
      assert.equal(Object.hasOwn(memory, name), false)
    }
  } finally { clean(dir) }
})

// MUTATION: point the emitted queries at a relative or deleted script.
// MUTATION: delete .claude/dev-team/memory/MEMORY.md or unlink an entry and the planner boots with less or no team memory.
test('the shipped team memory store renders every indexed entry within the default budget', () => {
  const dir = fileURLToPath(new URL('../.claude/dev-team/memory/', import.meta.url))
  const extract = memory.openMemory({ dir }).context({ task: 'shipped', role: 'planner' })
  assert.equal(extract.reason, null)
  assert.deepEqual(extract.dropped, [])
  assert.ok(extract.included.length >= 2, 'the index and at least one entry')
  assert.equal(extract.included[0].path, 'MEMORY.md')
  assert.ok(extract.bytes <= memory.DEFAULT_BUDGET_BYTES)
})

test('the dev-team folder keeps no retired runtime config and no unindexed memory note', () => {
  const dir = join(ROOT, '.claude/dev-team/memory')
  assert.equal(existsSync(join(ROOT, '.claude/dev-team/config.md')), false)
  const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  const linked = [...index.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1])
  for (const name of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    assert.ok(['MEMORY.md', 'architecture-notes.md', ...linked].includes(name), name)
  }
  for (const name of ['config.md', 'backend-notes.md', 'qa-notes.md', 'devops-notes.md', 'frontend-notes.md']) {
    assert.ok(existsSync(join(ROOT, 'docs/archive', name)), name)
  }
})

test('the shipped team memory teaches no deleted gate, kill-mutation proof or steer arm', () => {
  const dir = fileURLToPath(new URL('../.claude/dev-team/memory/', import.meta.url))
  const extract = memory.openMemory({ dir }).context({ task: 'shipped', role: 'planner' })
  for (const entry of extract.included) {
    assert.equal(['mutations-must-bind.md', 'gate-red-for-the-right-reason.md'].includes(entry.path), false)
  }
  assert.doesNotMatch(extract.text, /kill-mutation|\/\/ MUTATION:|FAIL <id>|\bgate\b|\bsteer\b/i)
})
