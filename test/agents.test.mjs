import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, listAgents, loadWorkflowSource } from './helpers.mjs'

const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable']

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return fm
}

for (const file of listAgents()) {
  test(`agent ${file}: valid frontmatter`, () => {
    const fm = frontmatter(readFileSync(join(ROOT, 'agents', file), 'utf8'))
    assert.ok(fm, 'has a frontmatter block')
    assert.equal(fm.name, file.replace(/\.md$/, ''), 'name matches filename')
    assert.ok(fm.description && fm.description.length > 10, 'has a description')
    assert.ok(fm.model, 'declares a model')
    const okModel = MODEL_ALIASES.includes(fm.model) || /^claude-/.test(fm.model)
    assert.ok(okModel, `model "${fm.model}" must be an alias or a full claude- id`)
  })
}

test('every agent the workflow references exists as a file', () => {
  const src = loadWorkflowSource()
  const refs = [...new Set([...src.matchAll(/dev-team:([a-z-]+)/g)].map((m) => m[1]))]
  assert.ok(refs.length >= 3, 'sanity: found agent references in the workflow')
  for (const name of refs) {
    assert.ok(existsSync(join(ROOT, 'agents', `${name}.md`)), `agents/${name}.md exists for dev-team:${name}`)
  }
})
