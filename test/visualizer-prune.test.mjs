import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import { createLeanSource } from '../crew/lean-source.mjs'

// MUTATION: DV2 inject an old-ledger read helper after the server schema constant.
test('journal refuses a legacy directory and reads a lean journal with diagnostics', () => {
  const serverDir = new URL('../visualizer/server/', import.meta.url)
  function scanFile(path) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /ledger[\\/]run\.json|['"`]ledger['"`][\s\S]{0,100}?['"`]run\.json['"`]/, path)
  }
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.(?:js|mjs)$/.test(entry.name)) scanFile(path)
    }
  }
  scan(fileURLToPath(serverDir))
  for (const file of ['lean-source.mjs', 'lean-journal-order.mjs']) scanFile(fileURLToPath(new URL(`../crew/${file}`, import.meta.url)))
  const root = mkdtempSync(join(tmpdir(), 'viz-journal-prune-'))
  try {
    const legacy = join(root, 'repo', 'task')
    mkdirSync(join(legacy, 'ledger'), { recursive: true })
    writeFileSync(join(legacy, 'ledger', 'run.json'), JSON.stringify({ adw_id: 'old' }))
    writeFileSync(join(legacy, 'journal.jsonl'), '{"event":"old"}\n')
    writeFileSync(join(legacy, 'plan.md'), '# Old plan\n')
    writeFileSync(join(legacy, 'brief.md'), '# Old brief\n')
    const lane = join(root, 'dt-lane', 'lane')
    mkdirSync(join(lane, 'task'), { recursive: true })
    writeFileSync(join(lane, 'crew.json'), JSON.stringify({ members: { builder: { agent: 'pi' } } }))
    writeFileSync(join(lane, 'task', 'lean.json'), JSON.stringify({ id: 'lane', tier: 'build' }))
    writeFileSync(join(lane, 'task', 'journal.jsonl'), '{"event":"run-start"}\ninvalid\n')
    const source = createJournalSource({ crewRoot: root, lean: createLeanSource({ crewRoot: root }) })
    const old = source.readJournal({ repo_slug: 'repo', task_slug: 'task', adw_id: 'old' })
    assert.equal(old.verified, false)
    assert.deepEqual(old.rows, [])
    assert.ok(old.error)
    const current = source.readJournal({ repo_slug: 'dt-lane', task_slug: 'lane', adw_id: 'lean:lane' })
    assert.equal(current.verified, true)
    assert.equal(current.rows[0].event, 'run-start')
    assert.equal(current.skipped_malformed, 1)
    assert.deepEqual(current.skipped_line_numbers, [2])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
