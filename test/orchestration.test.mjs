import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const text = readFileSync(join(ROOT, 'orchestration.md'), 'utf8')

test('orchestration.md stays within the line-count ceiling', () => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  assert.ok(lines.length <= 69, `orchestration.md is ${lines.length} lines — the ceiling is 69`)
})

test('orchestration.md references the cmux dispatch reference file', () => {
  assert.ok(text.includes('references/cmux-dispatch.md'))
})

test('orchestration.md documents the roster overriding pinned models in cmux mode', () => {
  assert.ok(text.includes('overrides these pins for roles the roster marks'))
})

test('orchestration.md documents joining cmux dispatches via dispatch.mjs await --all', () => {
  assert.ok(text.includes('dispatch.mjs await --all'))
})

test('orchestration.md documents the cmux pane tab title', () => {
  assert.ok(text.includes("the pane's **tab title**"))
})

test('references/ has exactly one cmux-* reference file, and it is cmux-dispatch.md', () => {
  const cmuxRefs = readdirSync(join(ROOT, 'references')).filter((f) => /^cmux-.*\.md$/.test(f))
  assert.deepEqual(cmuxRefs, ['cmux-dispatch.md'])
})
