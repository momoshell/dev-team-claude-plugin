import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertAnchorsPinned } from '../qa-test-writing/anchor-pin.mjs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HERE = fileURLToPath(new URL('./', import.meta.url))
const DAEMON = join(ROOT, 'crew/daemon.mjs')
const REAP = join(ROOT, 'scripts/factory/reap-stale.mjs')
const DOC_ROOT = join(HERE, 'references')

// Mutation killed: changing one closed daemon verb in daemon.md must make the
// documentation test fail against the source vocabulary.
test('the daemon closed command set is fully documented', () => {
  const source = readFileSync(DAEMON, 'utf8')
  const match = source.match(/DAEMON_COMMANDS\s*=\s*Object\.freeze\(\[([^\]]+)\]/)
  assert.ok(match, 'DAEMON_COMMANDS declaration is missing')
  const verbs = [...match[1].matchAll(/'([^']+)'/g)].map(([, verb]) => verb)
  assert.equal(verbs.length, 9)
  const doc = readFileSync(join(DOC_ROOT, 'daemon.md'), 'utf8')
  for (const verb of verbs) assert.ok(doc.includes(`\`${verb}\``), `daemon.md must name ${verb}`)
})

// Mutation killed: changing one accounting state in reap-stale.mjs must make
// the process reference update rather than silently losing a state.
test('reap accounting states agree with the process reference', () => {
  const source = readFileSync(REAP, 'utf8')
  const match = source.match(/REAP_ACCOUNTING\s*=\s*Object\.freeze\(\[([^\]]+)\]/)
  assert.ok(match, 'REAP_ACCOUNTING declaration is missing')
  const states = [...match[1].matchAll(/'([^']+)'/g)].map(([, state]) => state)
  assert.deepEqual(states, ['proven', 'failed', 'unproven'])
  const doc = readFileSync(join(DOC_ROOT, 'processes.md'), 'utf8')
  for (const state of states) assert.ok(doc.includes(`\`${state}\``), `processes.md must name ${state}`)
})

// Mutation killed: moving either daemon path or its default root must make
// this test disagree with daemon.md's documented paths.
test('daemon paths agree with the default root', () => {
  const source = readFileSync(DAEMON, 'utf8')
  assert.match(source, /join\(homedir\(\),\s*['"]\.crew['"],\s*['"]daemon['"]\)/)
  assert.match(source, /join\(root,\s*['"]daemon\.sock['"]\)/)
  assert.match(source, /join\(root,\s*['"]daemon\.json['"]\)/)
  const doc = readFileSync(join(DOC_ROOT, 'daemon.md'), 'utf8')
  for (const token of ['.crew', 'daemon.sock', 'daemon.json']) assert.ok(doc.includes(token), `daemon.md must name ${token}`)
})

// Mutation killed: move any anchored line, or weaken a declared substring to
// something the target repeats, and this test reddens — the old pin passed
// while the line said something else entirely (#550).
test('every devops path:line anchor carries what the prose claims', () => {
  assert.equal(assertAnchorsPinned({ root: ROOT, skillDir: HERE, manifestPath: join(HERE, 'anchors.json'), minAnchors: 85 }), 85)
})
