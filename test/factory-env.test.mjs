import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import { NODE_FLOOR } from '../scripts/factory/ledger.mjs'

const workflowYml = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const configMd = readFileSync(join(ROOT, '.claude/dev-team/config.md'), 'utf8')

test('CI workflow runs exactly one Node job, at or above NODE_FLOOR', () => {
  const matches = [...workflowYml.matchAll(/node-version:\s*"?(\d+)/g)]
  assert.equal(matches.length, 1, `expected exactly one concrete node-version declaration, found ${matches.length}`)
  const major = Number(matches[0][1])
  const floorMajor = Number(NODE_FLOOR.split('.')[0])
  assert.ok(major >= floorMajor, `CI node major ${major} is below NODE_FLOOR ${NODE_FLOOR}`)
})

test('CI workflow declares no Node 20 leg', () => {
  const versionLines = workflowYml.split('\n').filter((line) => line.includes('node-version:'))
  assert.ok(!versionLines.some((line) => /\b20\b/.test(line)), 'a node-version line still mentions Node 20')
})

test('.gitignore contains all four run-trace mirror db artifact patterns', () => {
  const lines = gitignore.split('\n').map((s) => s.trim())
  for (const p of ['*.db', '*.db-wal', '*.db-shm', '*.db-journal']) {
    assert.ok(lines.includes(p), `missing ignore pattern ${p}`)
  }
})

test('package.json exposes the eight read-only ledger recipes pointing at the ledger entry point', () => {
  const names = ['ledger:sessions', 'ledger:phases', 'ledger:tail', 'ledger:procs', 'ledger:gate-review-gap', 'ledger:eligible-tasks', 'ledger:run-set', 'ledger:task']
  for (const name of names) {
    assert.ok(name in pkg.scripts, `missing script ${name}`)
    assert.match(pkg.scripts[name], /scripts\/factory\/ledger\.mjs/, `${name} does not invoke the ledger entry point`)
  }
})

test('no npm script name exposes a destructive ledger verb', () => {
  for (const name of Object.keys(pkg.scripts)) {
    assert.doesNotMatch(name, /kill|prune|delete|reset/i, `script name ${name} looks destructive`)
  }
})

// Replaced the former "has no `engines` field" assertion; superseded by ADR-031.
test("package.json's engines.node floor is exactly NODE_FLOOR", () => {
  const declared = pkg.engines?.node
  const message = `package.json engines.node (${declared}) must declare the same floor as NODE_FLOOR (${NODE_FLOOR}) in scripts/factory/ledger.mjs — change both or neither`
  assert.ok(declared, message)
  const match = String(declared).match(/(\d+)\.(\d+)\.(\d+)/)
  assert.ok(match, message)
  assert.equal(match[0], NODE_FLOOR, message)
  assert.match(String(declared), />=/, message)
})

test('config.md review_defaults section documents scripts/factory/*.mjs', () => {
  const start = configMd.indexOf('## review_defaults')
  assert.ok(start !== -1, 'review_defaults heading not found')
  const rest = configMd.slice(start + '## review_defaults'.length)
  const nextHeadingIdx = rest.indexOf('\n## ')
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx)
  assert.ok(section.includes('scripts/factory/*.mjs'), 'review_defaults section is missing scripts/factory/*.mjs')
})
