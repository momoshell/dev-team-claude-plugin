import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { assertAnchorsPinned } from '../qa-test-writing/anchor-pin.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const LEAN_OWNER = 'skills/lean-build/anchors.json'
const MANIFEST = join(ROOT, LEAN_OWNER)

// Mutation killed: move any cited source line, or delete a SKILL.md citation,
// and this test reddens — the pin carries content, not just shape.
test('every lean-build path:line anchor carries what the prose claims', () => {
  assert.equal(assertAnchorsPinned({ root: ROOT, skillDir: HERE, manifestPath: MANIFEST, minAnchors: 4 }), 4)
})
