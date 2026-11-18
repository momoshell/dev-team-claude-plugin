import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as layout from './context-layout.mjs'
const { journalPathOf, plannerReturnNumber, plannerReturnsDirOf, spawnCountPathOf } = layout

// MUTATION: restore the dirname branch in laneDir
test('every resolver places the lane context inside the task dir whatever the environment names', () => {
  const task = '/runs/lane/task'
  assert.equal(journalPathOf(task), join(task, 'journal.jsonl'))
  assert.equal(spawnCountPathOf(task, 'spawns.json'), join(task, 'spawns.json'))
  assert.equal(plannerReturnsDirOf(task), task)
  assert.equal(plannerReturnNumber('d12.planner.json'), null)
  assert.equal(plannerReturnNumber('planner-12.json'), 12)
  assert.equal('isLeanLayout' in layout, false)
  for (const invalid of ['', undefined, null]) {
    assert.equal(journalPathOf(invalid), 'journal.jsonl')
    assert.equal(spawnCountPathOf(invalid, 'spawns.json'), 'spawns.json')
  }
})

test('the layout module imports only builtins, so every extension that loads it stays dependency-free', () => {
  const source = readFileSync(new URL('./context-layout.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.deepEqual(imports, ['node:path'])
})
