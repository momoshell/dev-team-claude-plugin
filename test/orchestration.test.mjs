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

test('orchestration.md: Handover Spec section states test ownership is expressed only via files_in_scope', () => {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === '## Handover Spec (the lead→coder contract)')
  assert.ok(start !== -1, 'expected the Handover Spec section heading')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end).join('\n')
  assert.ok(section.includes("Test ownership is the lead's spec-time decision and is expressed only through `files_in_scope`"))
})

test('orchestration.md: a test-ownership mismatch routes to the semantic lint layer, not the mechanical one', () => {
  assert.ok(
    text.includes(
      'A coverage criterion with neither, or a test file in scope with no criterion saying what it must prove, is a semantic-lint bounce'
    )
  )
})

test('orchestration.md: a coder-flagged missing test owner is a sanctioned exception to the files_in_scope-stable amend rule', () => {
  assert.ok(
    text.includes(
      'A coder-flagged missing test-authorship owner is the one sanctioned exception to keeping `files_in_scope` stable'
    )
  )
})
