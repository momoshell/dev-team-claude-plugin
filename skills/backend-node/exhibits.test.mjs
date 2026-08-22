import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HERE = fileURLToPath(new URL('./', import.meta.url))
const FIREWALL = join(ROOT, 'crew/daemon.test.mjs')
const IMPORT_TEST = join(ROOT, 'crew/pi/extensions/subagent.test.mjs')
const TS_SOURCE = join(ROOT, 'crew/pi/extensions/subagent.ts')
const DOC_ROOT = join(HERE, 'references')

// Mutation killed: adding an import to an allowlisted daemon leaf must make
// the firewall documentation test fail until the new leaf is documented.
test('import-free leaves agree with the firewall', () => {
  const daemonTest = readFileSync(FIREWALL, 'utf8')
  const leaves = [...daemonTest.matchAll(/'(crew\/[a-z-]+\.mjs) must stay import-free/g)].map((match) => match[1])
  assert.ok(leaves.length >= 3, 'the daemon firewall must pin at least three leaves')
  const doc = readFileSync(join(DOC_ROOT, 'import-firewall.md'), 'utf8')
  for (const leaf of leaves) assert.ok(doc.includes(leaf), `import-firewall.md must name ${leaf}`)
})

// Mutation killed: removing one construct from the TypeScript header must
// require the checklist and header to be edited together.
test('the erasable construct list agrees with the header', () => {
  const header = readFileSync(TS_SOURCE, 'utf8').split('\n').slice(0, 14).join('\n')
  const doc = readFileSync(join(DOC_ROOT, 'erasable-ts.md'), 'utf8')
  for (const token of ['erasable-syntax-only', 'enum', 'namespace', 'parameter properties']) {
    assert.ok(header.includes(token), `subagent.ts header lost ${token}`)
    assert.ok(doc.includes(token), `erasable-ts.md lost ${token}`)
  }
})

// Mutation killed: adding a parameter-properties grep closes the documented
// gap, so the evidence register must change with the enforcement change.
test('the enforcement gap is real', () => {
  const source = readFileSync(IMPORT_TEST, 'utf8')
  assert.match(source, /^\s*assert\.doesNotMatch\(source, \/\^\\s\*enum/gm)
  assert.match(source, /^\s*assert\.doesNotMatch\(source, \/\^\\s\*namespace/gm)
  assert.doesNotMatch(source, /parameter properties/)
  const evidence = readFileSync(join(DOC_ROOT, 'evidence.md'), 'utf8')
  assert.match(evidence, /parameter properties/)
  assert.match(evidence, /decorators/)
})

// Mutation killed: changing any documented path:line to a nonexistent line
// must make this skill's exhibit index fail instead of silently drifting.
test('every backend-node path:line anchor resolves', () => {
  const files = [join(HERE, 'SKILL.md')]
  for (const name of ['zero-dep.md', 'import-firewall.md', 'closed-enums.md', 'cli-flags.md', 'erasable-ts.md', 'usage-records.md', 'evidence.md']) {
    files.push(join(DOC_ROOT, name))
  }
  const roots = new Set(['crew', 'scripts', 'test', 'docs', 'skills', 'visualizer', 'tasks', '.github'])
  let anchors = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [, rel, number] of text.matchAll(/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:mjs|ts|js|json|md|sh|yml)):(\d+)/g)) {
      if (!roots.has(rel.split('/')[0])) continue
      anchors += 1
      const target = join(ROOT, rel)
      assert.ok(existsSync(target), `${file}: missing ${rel}`)
      assert.equal(statSync(target).isDirectory(), false, `${file}: ${rel} is a directory`)
      const lines = readFileSync(target, 'utf8').split('\n').length
      assert.ok(Number(number) >= 1 && Number(number) <= lines, `${file}: ${rel}:${number} has ${lines} lines`)
    }
  }
  assert.ok(anchors >= 12, `expected at least 12 backend anchors, found ${anchors}`)
})
