import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// MUTATION: remove the old-source worktree with a single --force.
test('an old-source test that locks its worktree is still removed', async () => {
  const cwd = scratchDir('proof-lock-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'lock.test.mjs'), "import test from 'node:test'\nimport { execFileSync } from 'node:child_process'\ntest('locks', () => { execFileSync('git', ['worktree', 'lock', process.cwd()]) })\n")
  const result = await proveTests({ cwd, tests: [{ file: 'lock.test.mjs', title: 'locks' }] })
  assert.notEqual(result.reason, 'cleanup-unproven')
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

// MUTATION: restore the matches parameter to testState.
test('testState takes only the events and classifies them without a matcher', () => {
  assert.equal(testState.length, 1)
  for (const [event, state] of [[{ type: 'test:pass' }, 'green'], [{ type: 'test:fail', failureType: 'testCodeFailure' }, 'red']]) {
    assert.deepEqual(testState([event]), { state, reason: null })
  }
})

test('testState refuses missing, ambiguous, skipped, todo, hook and cancelled results', () => {
  for (const [events, reason] of [[[], 'missing'], [[{}, {}], 'ambiguous'], [[{ skip: true }], 'skipped'], [[{ todo: true }], 'todo'], [[{ failureType: 'hookFailed' }], 'hook-failed'], [[{ failureType: 'cancelledByParent' }], 'cancelled']]) assert.equal(testState(events).reason, reason)
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

// MUTATION: delete the tmp dir even when the worktree is kept.
test('a worktree that cannot be removed is kept and reported as cleanup-unproven', async () => {
  const cwd = scratchDir('proof-kept-'), tmp = scratchDir('proof-tmp-'), prior = process.env.TMPDIR
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'kept.test.mjs'), "import test from 'node:test'\nimport { statSync, rmSync } from 'node:fs'\ntest('kept', () => { if (statSync('.git').isFile()) rmSync('.git') })\n")
  try {
    process.env.TMPDIR = tmp
    const result = await proveTests({ cwd, tests: [{ file: 'kept.test.mjs', title: 'kept' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'cleanup-unproven')
    assert.ok(existsSync(result.kept)); assert.ok(result.kept.endsWith('/base'))
  } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior }
})

// MUTATION: return unmeasured('runner-threw') without rows.
test('a throw inside proveTests is unmeasured runner-threw with the rows it had', async () => {
  const cwd = scratchDir('proof-throw-'), tmp = scratchDir('proof-tmp-'), prior = process.env.TMPDIR
  const tests = [{ file: 'x.test.mjs', title: 'x' }]
  try {
    process.env.TMPDIR = join(tmp, 'absent')
    assert.deepEqual(await proveTests({ cwd, tests }), { status: 'unmeasured', reason: 'runner-threw', rows: [{ ...tests[0], base: { state: null, reason: 'not-run' }, build: { state: null, reason: 'not-run' }, proven: false, reason: null }] })
  } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior }
})

// MUTATION: drop the line/column identity from proven.
test('the same title at a different line on the old source does not prove', async () => {
  const cwd = scratchDir('proof-line-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'v.mjs'), 'export const v = 1\n')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'v.mjs'), 'export const v = 2\n')
  writeFileSync(join(cwd, 'v.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { v } from './v.mjs'\ntest(v === 1 ? 'x' : 'y', () => assert.equal(v, 2))\ntest(v === 2 ? 'x' : 'z', () => {})\n")
  const result = await proveTests({ cwd, tests: [{ file: 'v.test.mjs', title: 'x' }] })
  assert.equal(result.status, 'red'); assert.equal(result.reason, 'proof-unproven')
  assert.equal(result.rows[0].base.state, 'red'); assert.equal(result.rows[0].build.state, 'green'); assert.equal(result.rows[0].proven, false)
})

// MUTATION: drop timeoutMs from the old-source testEvents call.
test('the timeout reaches the old-source run and a hang is unmeasured timeout', { timeout: 20_000 }, async () => {
  const cwd = scratchDir('proof-timeout-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'v.mjs'), 'export const v = 1\n')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'v.mjs'), 'export const v = 2\n')
  writeFileSync(join(cwd, 'v.test.mjs'), "import test from 'node:test'\nimport { v } from './v.mjs'\ntest('hang', async () => { if (v === 1) { setInterval(() => {}, 1000); await new Promise(() => {}) } })\n")
  const result = await proveTests({ cwd, tests: [{ file: 'v.test.mjs', title: 'hang' }], timeoutMs: 5_000 })
  assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'timeout'); assert.equal(result.rows[0].proven, false)
  assert.equal(git(cwd, 'worktree', 'list').trim().split('\n').length, 1)
})

// MUTATION: only remove tmp when the worktree was added.
test('a failed git worktree add is unmeasured, runs no test and leaves no temp dir', async () => {
  const cwd = scratchDir('proof-add-'), tmp = scratchDir('proof-tmp-'), prior = process.env.TMPDIR
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  try {
    process.env.TMPDIR = tmp
    const result = await proveTests({ cwd, base: 'no-such-ref', tests: [{ file: 'x.test.mjs', title: 'x' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'exit-nonzero')
    for (const row of result.rows) assert.equal(row.base.reason, 'not-run')
    assert.deepEqual(readdirSync(tmp), [])
  } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior }
})

test('proof imports only builtins and its pinned check runner and lane-core leaf', () => {
  const imports = (file) => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1])
  const proof = imports('./proof.mjs')
  assert.ok(proof.length > 0)
  assert.deepEqual(proof.filter((name) => !name.startsWith('node:')), ['./checks.mjs'])
  const checks = imports('./checks.mjs')
  assert.ok(checks.length > 0)
  assert.deepEqual(checks.filter((name) => !name.startsWith('node:')), ['./lane-core.mjs'])
  const laneCore = imports('./lane-core.mjs')
  assert.ok(laneCore.length > 0 && laneCore.every((name) => name.startsWith('node:')))
  assert.deepEqual(imports('./proof-reporter.mjs'), [])
})
