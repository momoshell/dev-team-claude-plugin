import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '../visualizer/server/server.mjs'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'
import { scratchDir, treeDigest } from './helpers.mjs'

const LEDGER_SANDBOX = scratchDir('visualizer-trajectory-ledger-', { parent: tmpdir() })
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX

function lane(root, { repo = 'dt-task', task = 'task', journal = null } = {}) {
  const dir = join(root, repo, task)
  mkdirSync(join(dir, 'task'), { recursive: true })
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ members: { builder: { agent: 'pi' } } }))
  writeFileSync(join(dir, 'task', 'lean.json'), JSON.stringify({ id: task, tier: 'build' }))
  if (journal !== null) writeFileSync(join(dir, 'task', 'journal.jsonl'), journal)
  return { dir, journal: join(dir, 'task', 'journal.jsonl') }
}

function journalSource(root) {
  return createJournalSource({ crewRoot: root, lean: createLeanSource({ crewRoot: root }) })
}

function lines(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
}

test('journal reader skips a torn line and reports its one-based line number', () => {
  const root = scratchDir('visualizer-trajectory-malformed-')
  lane(root, { journal: `${JSON.stringify({ at: 1, event: 'first' })}\n{"at":\n${JSON.stringify({ at: 3, event: 'third' })}\n` })
  const result = journalSource(root).readJournal({ repo_slug: 'dt-task', task_slug: 'task', adw_id: 'lean:task' })
  assert.deepEqual(result.rows.map((row) => row.event), ['first', 'third'])
  assert.deepEqual(result.rows.map((row) => row.line_number), [1, 3])
  assert.equal(result.rows[0].channel, null)
  assert.equal(result.skipped_malformed, 1)
  assert.deepEqual(result.skipped_line_numbers, [2])
})

test('journal reader degrades instead of throwing when journal.jsonl is absent', () => {
  const root = scratchDir('visualizer-trajectory-missing-')
  lane(root)
  const source = journalSource(root)
  let result
  try {
    result = source.readJournal({ repo_slug: 'dt-task', task_slug: 'task', adw_id: 'lean:task' })
  } catch (error) {
    assert.fail(`readJournal threw: ${error.message}`)
  }
  assert.equal(result.degraded, true)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
  assert.deepEqual(result.rows, [])
})

test('journal route remains read-only and outside the write guard', async () => {
  const root = scratchDir('visualizer-trajectory-route-')
  lane(root, { journal: lines([{ at: 0, event: 'hello' }]) })
  const feed = { close: () => {} }
  const handles = startServer({ port: 0, host: '127.0.0.1', feed, crewRoot: root })
  await new Promise((resolve, reject) => {
    handles.server.once('listening', resolve)
    handles.server.once('error', reject)
  })
  const base = `http://127.0.0.1:${handles.server.address().port}`
  try {
    const post = await fetch(`${base}/api/journal?repo_slug=repo&task_slug=task`, { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET')
    assert.equal((await post.json()).error, 'method not allowed')
    const missing = await fetch(`${base}/api/journal`)
    assert.equal(missing.status, 400)
    assert.ok((await missing.json()).error.includes('repo_slug and task_slug'))
    const partial = await fetch(`${base}/api/journal?repo_slug=repo`)
    assert.equal(partial.status, 400)
    assert.ok((await partial.json()).error.includes('repo_slug and task_slug'))
    const get = await fetch(`${base}/api/journal?repo_slug=dt-task&task_slug=task&adw_id=lean:task`)
    assert.equal(get.status, 200)
    const body = await get.json()
    assert.deepEqual(body.rows.map((row) => row.event), ['hello'])
  } finally {
    await new Promise((resolve) => handles.server.close(resolve))
  }
})

test('journal reads do not change the crew tree, including traversal attempts', () => {
  const root = scratchDir('visualizer-trajectory-readonly-')
  lane(root, { journal: lines([{ at: 0, event: 'hello' }]) })
  const source = journalSource(root)
  const before = treeDigest(root)
  source.readJournal({ repo_slug: 'dt-task', task_slug: 'task', adw_id: 'lean:task' })
  const traversal = source.readJournal({ repo_slug: '../repo', task_slug: 'task', adw_id: 'lean:task' })
  assert.equal(traversal.error, 'invalid repo_slug or task_slug')
  assert.equal(treeDigest(root), before)
  assert.equal(source.health().readonly, true)
})

