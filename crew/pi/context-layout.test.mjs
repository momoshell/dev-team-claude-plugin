import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTEXT_LAYOUT_ENV, isLeanLayout, journalPathOf, plannerReturnNumber, plannerReturnsDirOf, spawnCountPathOf,
} from './context-layout.mjs'

const LEAN = { [CONTEXT_LAYOUT_ENV]: 'lean' }

test('only an explicit lean layout moves the lane context inside the task dir', () => {
  assert.equal(isLeanLayout(LEAN), true)
  for (const env of [undefined, {}, { [CONTEXT_LAYOUT_ENV]: '' }, { [CONTEXT_LAYOUT_ENV]: 'old' }, { [CONTEXT_LAYOUT_ENV]: 'Lean' }]) assert.equal(isLeanLayout(env), false, JSON.stringify(env))
})

test('the old layout resolves beside the task dir and a lean lane inside it', () => {
  const task = '/runs/lane/task'
  assert.equal(journalPathOf(task, {}), '/runs/lane/journal.jsonl')
  assert.equal(journalPathOf(task, LEAN), join(task, 'journal.jsonl'))
  assert.equal(spawnCountPathOf(task, undefined, 'spawns.json'), '/runs/lane/spawns.json')
  assert.equal(spawnCountPathOf(task, LEAN, 'spawns.json'), join(task, 'spawns.json'))
  assert.equal(plannerReturnsDirOf(task, {}), '/runs/lane/returns')
  assert.equal(plannerReturnsDirOf(task, {}, 'run-1'), '/runs/lane/returns/run-1')
  assert.equal(plannerReturnsDirOf(task, LEAN), task)
  assert.equal(plannerReturnsDirOf(task, LEAN, 'run-1'), task, 'a lean lane has no run directories')
})

test('a planner return name is read in the layout of the seat and in no other', () => {
  assert.equal(plannerReturnNumber('d12.planner.json', {}), 12)
  assert.equal(plannerReturnNumber('planner-12.json', LEAN), 12)
  assert.equal(plannerReturnNumber('planner-12.json', {}), null)
  assert.equal(plannerReturnNumber('d12.planner.json', LEAN), null)
  for (const name of ['builder-3.json', 'planner-x.json', 'planner-3.json.tmp', 'xplanner-3.json']) assert.equal(plannerReturnNumber(name, LEAN), null, name)
})

test('the layout module imports only builtins, so every extension that loads it stays dependency-free', () => {
  const source = readFileSync(new URL('./context-layout.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.deepEqual(imports, ['node:path'])
})
