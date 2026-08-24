import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAnchorsPinned } from '../qa-test-writing/anchor-pin.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HERE = fileURLToPath(new URL('./', import.meta.url))

function readText(path) {
  const text = readFileSync(path, 'utf8')
  assert.ok(text.length > 0, `${path} is empty`)
  return text
}

// Mutation killed: moving an instrument citation or weakening its source substring must redden the recovery pin.
test('every crew-recovery path:line anchor carries what the prose claims', () => {
  assertAnchorsPinned({ root: ROOT, skillDir: HERE, manifestPath: join(HERE, 'anchors.json'), minAnchors: 3 })
})

// Mutation killed: removing a routing row must orphan a recovery reference.
test('every reference file is routed from SKILL.md', () => {
  const skill = readText(join(HERE, 'SKILL.md'))
  for (const name of readdirSync(join(HERE, 'references')).sort()) {
    if (name.endsWith('.md') && statSync(join(HERE, 'references', name)).isFile()) {
      assert.ok(skill.includes(`references/${name}`), `SKILL.md must route references/${name}`)
    }
  }
})

// Mutation killed: dropping one measured case lets a known instrument failure become an operator rule.
test('the instruments checklist keeps each measured case', () => {
  const text = readText(join(HERE, 'references/instruments.md'))
  for (const token of ['the WRAPPER SHELL', 'lazily-opened', 'invented a field', 'sibling lane polluted', 'compound command', 'pid-tracking watcher', 'six alphanumerics', '${PIPESTATUS[0]}', 'alive now', 'load average', 'scripts/factory/make-brief.mjs:657', 'crew/drive.mjs:44']) {
    assert.ok(text.includes(token), `instruments.md must name ${token}`)
  }
})

// Mutation killed: changing either half of the post-publish order must fail the closeout evidence test.
test('closeout keeps teardown last and verifies after it', () => {
  const text = readText(join(HERE, 'references/closeout.md'))
  for (const token of ['preserve → commit → prove → suite → push+PR → teardown', 'immediately after teardown', 'merged blob', 'diff every PR', 'references/lane-branches.md', 'gh pr reopen']) {
    assert.ok(text.includes(token), `closeout.md must name ${token}`)
  }
})

// Mutation killed: restoring the archive scratch recipe or removing first preservation must fail the proof test.
test('mutation proof preserves first and mutates in a detached worktree', () => {
  const text = readText(join(HERE, 'references/mutation-proof.md'))
  for (const token of ['tree.patch', 'git worktree add --detach', 'references/vacuity.md', 'set -e', 'returns/d1.planner.json']) {
    assert.ok(text.includes(token), `mutation-proof.md must name ${token}`)
  }
  assert.equal(text.includes('git archive HEAD | tar -x'), false)
})
