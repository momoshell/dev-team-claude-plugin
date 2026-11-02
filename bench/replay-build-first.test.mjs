import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundState, runBuilder } from './replay-builder.mjs'
import { addedLines, parseCli } from './replay-common.mjs'

// MUTATION: omit the bound proof from build-first results.
test('build-first proves a bound test against base and its mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bound-'))
  const repo = join(root, 'repo'), corpus = join(root, 'corpus'), lane = join(corpus, 'b1')
  mkdirSync(repo); mkdirSync(lane, { recursive: true })
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  const put = (dir, file, content) => writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content))
  try {
    git('init', '-q'); put(repo, 'add.mjs', 'export const add = () => 0\n')
    git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    put(lane, 'manifest.json', { base: git('rev-parse', 'HEAD'), originalTask: '/old/task', originalTree: '/old/tree' })
    put(lane, 'builder-prompt.txt', 'old\nDefinition source: builder\nGate path: /old/task/gate.mjs\nReturn path: /old/task/builder-1.json\n')
    put(lane, 'plan.md', 'plan'); put(lane, 'lean.json', {}); put(lane, 'brief.md', 'brief')
    put(lane, 'planner-1.json', { details: { acceptance: ['A', 'B', 'D', 'E', 'H', 'S', 'I', 'X', 'P', 'Q', 'R', 'T'], gate_cmd: 'gate', mutations: [] } })
    const charter = join(root, 'charter'); put(root, 'charter', '---\nname: builder\ndescription: test\nrole: builder\nagent: pi\nmodel: example/model\neffort: high\n---\nnew charter\n')
    const result = await runBuilder({ lane: 'b1', cell: { agent: 'pi', model: 'example/model', effort: 'high' }, arms: [], out: join(root, 'out'), charter, buildFirst: true }, {
      repoDir: repo, corpusDir: corpus, home: join(root, 'home'), sleepMs: () => {},
      runAcpSeat({ cwd, taskDir, prompt }) {
        assert.match(prompt, /^new charter\n\nDefinition source:/)
        assert.doesNotMatch(prompt, /Gate path:/)
        assert.equal(existsSync(join(taskDir, 'gate.mjs')), false)
        put(cwd, 'add.mjs', 'export const add = () => 1\n')
        put(cwd, 'add.test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.mjs'\ntest('(A) value', () => assert.equal(add(), 1))\ntest('(P) normalized', () => assert.equal(add(), 1))\ntest('(Q) symlink', () => assert.equal(add(), 1))\n")
        symlinkSync('add.test.mjs', join(cwd, 'alias.mjs'))
        put(cwd, 'new.mjs', 'export const value = 1\n')
        put(cwd, 'other.test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('(B) dynamic assertion', async () => { const { add } = await import('./add.mjs'); assert.equal(add(), 1) })\ntest('(R) primitive import', async () => { const { add } = await import('./add.mjs'); assert.equal(add(), 1) })\ntest('(T) async module', async () => { const { value } = await import('./new.mjs'); assert.equal(value, 1) })\ntest('(D) dynamic import', async () => { await import('./new.mjs') })\ntest('(E) aggregate import', async () => { await Promise.any([import('./new.mjs')]) })\ntest('(S) skipped', { skip: true }, () => {})\n")
        put(cwd, 'switch.test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.mjs'\nif (add() === 0) test('(X) value', () => assert.fail())\nelse if (add() === 1) test('(X) value', () => {})\nelse test('(X) value', () => assert.fail())\n")
        put(cwd, 'hook.test.mjs', "import test, { beforeEach } from 'node:test'\nimport { add } from './add.mjs'\nbeforeEach(() => { if (!add()) throw Error('hook') })\ntest('(H) hooks', () => {})\n")
        put(cwd, 'import.test.mjs', "import test from 'node:test'\nimport './new.mjs'\ntest('(I) static import', () => {})\n")
        put(taskDir, 'builder-1.json', { status: 'done', summary: 'built', details: { mutations: [{ check: 'A', file: 'add.mjs', find: '=> 1', replace: '=> 0' }, { check: 'B', file: 'add.mjs', find: '=> 1', replace: '=> 0' }, { check: 'R', file: 'add.mjs', find: 'export const add = () => 1', replace: "throw 'broken'" }, { check: 'T', file: 'new.mjs', find: 'export const value = 1', replace: "await new Promise((_, reject) => setTimeout(() => reject(new Error('load failed')), 1)); export const value = 1" }, { check: 'D', file: 'new.mjs', find: '= 1', replace: '= ;' }, { check: 'E', file: 'new.mjs', find: '= 1', replace: '= ;' }, { check: 'X', file: 'add.mjs', find: '=> 1', replace: '=> 2' }, { check: 'P', file: 'add.test.mjs/.', find: "test('(P) normalized', () => assert.equal(add(), 1))", replace: "test('(P) normalized', () => assert.equal(add(), 2))" }, { check: 'Q', file: 'alias.mjs', find: "test('(Q) symlink', () => assert.equal(add(), 1))", replace: "test('(Q) symlink', () => assert.equal(add(), 2))" }] } })
        return { stopReason: 'end_turn' }
      },
    })
    assert.equal(result.error, null)
    assert.equal(result.bound.ids.A.proven, true)
    // MUTATION: classify every async assertion failure as an import failure.
    assert.equal(result.bound.ids.B.proven, true)
    // MUTATION: treat a primitive import rejection as a test body failure.
    assert.equal(result.bound.ids.R.base.state, 'red')
    assert.equal(result.bound.ids.R.build.state, 'green')
    assert.deepEqual(result.bound.ids.R.mutant, { state: null, reason: 'not-body-failure' })
    assert.equal(result.bound.ids.R.proven, false)
    // MUTATION: accept failures without a test-file stack frame as body failures.
    assert.equal(result.bound.ids.T.build.state, 'green')
    assert.deepEqual(result.bound.ids.T.mutant, { state: null, reason: 'not-body-failure' })
    assert.equal(result.bound.ids.T.proven, false)
    // MUTATION: ignore missing-module codes or loader stacks, or report hook failures as testCodeFailure or skips as passes.
    assert.equal(result.bound.ids.D.build.state, 'green')
    assert.deepEqual(result.bound.ids.D.base, { state: null, reason: 'not-body-failure' })
    assert.deepEqual(result.bound.ids.D.mutant, { state: null, reason: 'not-body-failure' })
    assert.equal(result.bound.ids.D.proven, false)
    // MUTATION: do not inspect AggregateError.errors for import failures.
    assert.equal(result.bound.ids.E.build.state, 'green')
    assert.deepEqual(result.bound.ids.E.base, { state: null, reason: 'not-body-failure' })
    assert.deepEqual(result.bound.ids.E.mutant, { state: null, reason: 'not-body-failure' })
    assert.equal(result.bound.ids.E.proven, false)
    assert.equal(result.bound.ids.I.base.reason, 'missing')
    assert.equal(result.bound.ids.I.proven, false)
    assert.equal(result.bound.ids.S.base.reason, 'skipped')
    assert.equal(result.bound.ids.S.proven, false)
    assert.equal(result.bound.ids.H.build.state, 'green')
    assert.equal(result.bound.ids.H.base.reason, 'hook-failed')
    assert.equal(result.bound.ids.H.proven, false)
    // MUTATION: prove using states without comparing the bound test identity across phases.
    assert.equal(result.bound.ids.X.red_on_base, true)
    assert.equal(result.bound.ids.X.green_on_build, true)
    assert.equal(result.bound.ids.X.killed, true)
    assert.equal(result.bound.ids.X.proven, false)
    // MUTATION: classify only the unnormalized mutation path, ignoring resolved symlinks.
    for (const id of ['P', 'Q']) {
      assert.equal(result.bound.ids[id].base.state, 'red')
      assert.equal(result.bound.ids[id].build.state, 'green')
      assert.deepEqual(result.bound.ids[id].mutant, { state: null, reason: 'mutation-in-test' })
      assert.equal(result.bound.ids[id].proven, false)
    }
    assert.deepEqual(result.added, { source: 3, test: 27, binary: 0 })
    // MUTATION: use .find on an unchecked mutations container or item.
    for (const [index, mutations] of [{ bad: true }, [null]].entries()) {
      const malformed = await runBuilder({ lane: 'b1', cell: { agent: 'pi', model: 'example/model', effort: 'high' }, arms: [], out: join(root, `invalid-${index}`), charter, buildFirst: true }, {
        repoDir: repo, corpusDir: corpus, home: join(root, 'home'),
        runAcpSeat({ cwd, taskDir }) {
          put(cwd, 'add.mjs', 'export const add = () => 1\n')
          put(cwd, 'add.test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.mjs'\ntest('(A) value', () => assert.equal(add(), 1))\n")
          put(taskDir, 'builder-1.json', { status: 'done', summary: 'built', details: { mutations } })
          return { stopReason: 'end_turn' }
        },
      })
      assert.equal(malformed.error, null)
      assert.deepEqual(malformed.added, { source: 1, test: 4, binary: 0 })
      assert.equal(malformed.bound.ids.A.base.state, 'red')
      assert.equal(malformed.bound.ids.A.build.state, 'green')
      assert.equal(malformed.bound.ids.A.mutant.reason, 'no-mutation')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: classify testCodeFailure as unproven instead of red.
test('body failures alone are red', () => {
  const event = (failureType, extra = {}) => [{ name: '(A) example', type: 'test:fail', failureType, ...extra }]
  assert.deepEqual(boundState(event('testCodeFailure'), 'A'), { state: 'red', reason: null })
  for (const [type, reason] of [['hookFailed', 'hook-failed'], ['cancelledByParent', 'cancelled'], ['other', 'not-body-failure']]) assert.equal(boundState(event(type), 'A').reason, reason)
  assert.equal(boundState(event('testCodeFailure', { skip: true }), 'A').reason, 'skipped')
  assert.equal(boundState(event('testCodeFailure', { todo: true }), 'A').reason, 'todo')
  assert.equal(boundState([], 'A').reason, 'missing')
  assert.equal(boundState([...event('testCodeFailure'), ...event('testCodeFailure')], 'A').reason, 'ambiguous')
})

// MUTATION: count test additions as source additions.
test('added lines distinguish source, tests and binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'added-'))
  const git = (...args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  try {
    git('init', '-q'); git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-qm', 'base')
    mkdirSync(join(dir, 'test'))
    writeFileSync(join(dir, 'source.mjs'), 'one\ntwo\n')
    writeFileSync(join(dir, 'test', 'x.test.mjs'), 'one\n')
    writeFileSync(join(dir, 'binary'), Buffer.from([0, 1]))
    // MUTATION: truncate the filename at its first tab when parsing numstat.
    writeFileSync(join(dir, 'prefix\tcase.test.mjs'), 'one\ntwo\nthree\n')
    assert.deepEqual(addedLines(dir), { source: 2, test: 4, binary: 1 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// MUTATION: reject the build-first flag even when enabled.
test('build-first is opt-in on the CLI', () => {
  const args = ['--lane', 'b1', '--cell', 'cell', '--arms', '', '--out', '/tmp/run', '--build-first']
  assert.equal(parseCli(args, { allowBuildFirst: true }).buildFirst, true)
  assert.throws(() => parseCli(args), /unknown argument/)
})

// A throwaway repo at one base commit and a corpus lane recorded against it.
function laneFixture(root, { prompt = 'old\nDefinition source: builder\nReturn path: /old/task/builder-1.json\n', setup = () => {} } = {}) {
  const repo = join(root, 'repo'), corpus = join(root, 'corpus'), lane = join(corpus, 'b1')
  mkdirSync(repo); mkdirSync(lane, { recursive: true })
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  const put = (file, content) => writeFileSync(join(lane, file), typeof content === 'string' ? content : JSON.stringify(content))
  git('init', '-q'); writeFileSync(join(repo, 'add.mjs'), 'export const add = () => 0\n'); setup(repo)
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  put('manifest.json', { base: git('rev-parse', 'HEAD'), originalTask: '/old/task', originalTree: '/old/tree' })
  put('builder-prompt.txt', prompt); put('plan.md', 'plan'); put('lean.json', {}); put('brief.md', 'brief')
  put('planner-1.json', { details: { acceptance: ['A'], gate_cmd: 'gate', mutations: [] } })
  const charter = join(root, 'charter')
  writeFileSync(charter, '---\nname: builder\ndescription: test\nrole: builder\nagent: pi\nmodel: example/model\neffort: high\n---\nnew charter\n')
  return { repo, corpus, charter }
}
const CELL = { agent: 'pi', model: 'example/model', effort: 'high' }
const TEST_A = "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../add.mjs'\ntest('(A) value', () => assert.equal(add(), 1))\n"

// MUTATION: drop the symlink-leaf or the outside-the-worktree clause of the base copy refusal.
test('the base copy refuses a symlinked test path instead of writing through it', async () => {
  for (const [label, file, link] of [['leaf', 't/probe.test.mjs', (repo, out) => { mkdirSync(join(repo, 't')); symlinkSync(join(out, 'sentinel'), join(repo, 't', 'probe.test.mjs')) }], ['parent', 't/probe.test.mjs', (repo, out) => symlinkSync(out, join(repo, 't'))], ['leaf-inside', 't/probe.test.mjs', (repo) => { mkdirSync(join(repo, 't')); symlinkSync('../add.mjs', join(repo, 't', 'probe.test.mjs')) }]]) {
    const root = mkdtempSync(join(tmpdir(), `base-copy-${label}-`)), outside = join(root, 'outside')
    mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep\n'); writeFileSync(join(outside, 'probe.test.mjs'), 'keep\n')
    try {
      const { repo, corpus, charter } = laneFixture(root, { setup: (repo) => link(repo, outside) })
      const result = await runBuilder({ lane: 'b1', cell: CELL, arms: [], out: join(root, 'out'), charter, buildFirst: true }, {
        repoDir: repo, corpusDir: corpus, home: join(root, 'home'), sleepMs: () => {},
        runAcpSeat({ cwd, taskDir }) {
          rmSync(join(cwd, 't'), { recursive: true, force: true }); mkdirSync(join(cwd, 't'))
          writeFileSync(join(cwd, 'add.mjs'), 'export const add = () => 1\n')
          writeFileSync(join(cwd, file), TEST_A)
          writeFileSync(join(taskDir, 'builder-1.json'), JSON.stringify({ status: 'done', summary: 'built', details: { mutations: [] } }))
          return { stopReason: 'end_turn' }
        },
      })
      assert.match(result.error ?? '', /bound-base: refused base copy of t\/probe\.test\.mjs/, label)
      assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep\n', label)
      assert.equal(readFileSync(join(outside, 'probe.test.mjs'), 'utf8'), 'keep\n', label)
      assert.deepEqual(result.bound.ids.A.base, { state: null, reason: 'not-run' }, label)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

// MUTATION: apply the Definition source: check to planner prompts only.
test('a builder charter refuses a recorded prompt with no Definition source: line before any worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'no-definition-'))
  try {
    const { repo, corpus, charter } = laneFixture(root, { prompt: 'old prompt with no boundary\n' })
    let seated = false
    const result = await runBuilder({ lane: 'b1', cell: CELL, arms: [], out: join(root, 'out'), charter, buildFirst: true }, {
      repoDir: repo, corpusDir: corpus, home: join(root, 'home'), sleepMs: () => {},
      runAcpSeat() { seated = true; return { stopReason: 'end_turn' } },
    })
    assert.match(result.error ?? '', /builder prompt has no Definition source: line/)
    assert.equal(seated, false)
    assert.equal(existsSync(join(root, 'out', 'tree')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
