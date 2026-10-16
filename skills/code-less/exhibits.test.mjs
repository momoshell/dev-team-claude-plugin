import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { assertAnchorsPinned } from '../qa-test-writing/anchor-pin.mjs'
import { gitGrepHits } from '../../scripts/factory/absence.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const RETIRED = ['lean', 'build'].join('-')
const LEAN_OWNER = 'skills/code-less/anchors.json'
const MANIFEST = join(ROOT, LEAN_OWNER)

// Mutation killed: move any cited source line, or delete a SKILL.md citation,
// and this test reddens — the pin carries content, not just shape.
test('every code-less path:line anchor carries what the prose claims', () => {
  assert.equal(assertAnchorsPinned({ root: ROOT, skillDir: HERE, manifestPath: MANIFEST, minAnchors: 4 }), 4)
})

// Mutation killed: put the retired name back in any tracked file outside docs/adr/ (THIRD-PARTY-NOTICES.md) and this reddens; the docs/adr/ control reddens if the search breaks.
test('no tracked file outside docs/adr/ names the retired skill', () => {
  assert.ok(gitGrepHits({ needle: RETIRED, paths: ['docs/adr/'], cwd: ROOT }).count > 0)
  assert.deepEqual(gitGrepHits({ needle: RETIRED, paths: ['.', ':(exclude)docs/adr/'], cwd: ROOT }).lines, [])
})
