import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import { createLeanSource } from '../crew/lean-source.mjs'
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

test('journal reads do not change the crew tree, including traversal attempts', () => {
  const root = scratchDir('visualizer-trajectory-readonly-')
  lane(root, { journal: lines([{ at: 0, event: 'hello' }]) })
  const source = journalSource(root)
  const before = treeDigest(root)
  source.readJournal({ repo_slug: 'dt-task', task_slug: 'task', adw_id: 'lean:task' })
  const traversal = source.readJournal({ repo_slug: '../repo', task_slug: 'task', adw_id: 'lean:task' })
  assert.equal(traversal.error, 'invalid repo_slug or task_slug')
  assert.equal(treeDigest(root), before)
})

