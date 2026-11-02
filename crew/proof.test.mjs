import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, scratchDir } from '../test/helpers.mjs'
import { proveTests, testState } from './proof.mjs'

// MUTATION: classify testCodeFailure as not a body failure.
test('a body failure on the old source and a pass on the build proves the test', async () => {
  const cwd = scratchDir('proof-')
  git(cwd, 'init', '-q')
  mkdirSync(join(cwd, 'lib'))
  writeFileSync(join(cwd, 'lib/add.mjs'), 'export const add = () => 0\n')
  writeFileSync(join(cwd, 'lib/add.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.mjs'\ntest('add is a function', () => assert.equal(typeof add, 'function'))\n")
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'lib/add.mjs'), 'export const add = () => 1\n')
  writeFileSync(join(cwd, 'lib/add.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.mjs'\ntest('add is a function', () => assert.equal(typeof add, 'function'))\ntest('add returns one', () => assert.equal(add(), 1))\n")
  const result = await proveTests({ cwd, tests: ['add returns one', 'add is a function'].map((title) => ({ file: 'lib/add.test.mjs', title })) })
  assert.equal(result.status, 'red')
  assert.equal(result.rows[0].proven, true)
  assert.equal(result.rows[1].reason, 'proof-not-red-on-base')
})

// MUTATION: run the old source from a git archive copy instead of a worktree.
test('a test that only needs a git checkout is not proven by the old source lacking one', async () => {
  const cwd = scratchDir('proof-env-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'env.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { existsSync } from 'node:fs'\ntest('runs in a checkout', () => assert.ok(existsSync('.git')))\n")
  const result = await proveTests({ cwd, tests: [{ file: 'env.test.mjs', title: 'runs in a checkout' }] })
  assert.equal(result.rows[0].base.state, 'green')
  assert.equal(result.rows[0].reason, 'proof-not-red-on-base')
  assert.equal(git(cwd, 'worktree', 'list').trim().split('\n').length, 1)
})

// MUTATION: drop the reporter's import-failure classification.
test('static and dynamic import failures on the old source are unproven', async () => {
  const cwd = scratchDir('proof-import-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'new.mjs'), 'export const value = 1\n')
  writeFileSync(join(cwd, 'static.test.mjs'), "import test from 'node:test'\nimport './new.mjs'\ntest('static', () => {})\n")
  writeFileSync(join(cwd, 'dynamic.test.mjs'), "import test from 'node:test'\ntest('dynamic', async () => { await import('./new.mjs') })\n")
  const result = await proveTests({ cwd, tests: ['static', 'dynamic'].map((title) => ({ file: `${title}.test.mjs`, title })) })
  assert.equal(result.status, 'red')
  for (const row of result.rows) { assert.equal(row.proven, false); assert.equal(row.reason, 'proof-not-red-on-base'); assert.equal(row.build.state, 'green') }
})

test('testState refuses missing, ambiguous, skipped, todo, hook and cancelled results', () => {
  for (const [events, reason] of [[[], 'missing'], [[{}, {}], 'ambiguous'], [[{ skip: true }], 'skipped'], [[{ todo: true }], 'todo'], [[{ failureType: 'hookFailed' }], 'hook-failed'], [[{ failureType: 'cancelledByParent' }], 'cancelled']]) assert.equal(testState(events, () => true).reason, reason)
})

test('unsupported runners and symlinked paths are refused without outside writes', async () => {
  const cwd = scratchDir('proof-path-'), outside = scratchDir('proof-outside-')
  git(cwd, 'init', '-q'); symlinkSync(outside, join(cwd, 'parent'))
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  rmSync(join(cwd, 'parent')); mkdirSync(join(cwd, 'parent'))
  writeFileSync(join(cwd, 'parent/a.test.mjs'), 'test')
  writeFileSync(join(cwd, 'actual.mjs'), 'test'); symlinkSync('actual.mjs', join(cwd, 'link.mjs'))
  writeFileSync(join(outside, 'sentinel'), 'keep')
  const result = await proveTests({ cwd, tests: [{ file: 'x.ts', title: 'x' }, { file: 'link.mjs', title: 'x' }, { file: 'parent/a.test.mjs', title: 'x' }] })
  assert.deepEqual(result.rows.map((r) => r.reason), ['unsupported-runner', 'unsafe-path', 'unsafe-path'])
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep')
})

test('proof imports only builtins and its pinned builtin-only check runner', () => {
  const imports = (file) => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1])
  const proof = imports('./proof.mjs')
  assert.ok(proof.length > 0)
  assert.deepEqual(proof.filter((name) => !name.startsWith('node:')), ['./checks.mjs'])
  const checks = imports('./checks.mjs')
  assert.ok(checks.length > 0)
  assert.ok(checks.every((name) => name.startsWith('node:')))
  assert.deepEqual(imports('./proof-reporter.mjs'), [])
})
