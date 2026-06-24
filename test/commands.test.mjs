import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const cmds = readdirSync(join(ROOT, 'commands')).filter((f) => f.endsWith('.md'))

test('there is at least one command', () => assert.ok(cmds.length > 0))

for (const f of cmds) {
  test(`command ${f}: has a frontmatter description`, () => {
    const md = readFileSync(join(ROOT, 'commands', f), 'utf8')
    const m = md.match(/^---\n([\s\S]*?)\n---/)
    assert.ok(m, 'has a frontmatter block')
    assert.match(m[1], /description:\s*\S/, 'has a non-empty description')
  })
}
