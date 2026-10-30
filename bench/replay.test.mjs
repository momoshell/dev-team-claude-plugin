import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ARMS, CHECKOUT, CORPUS_DIR, createOutDir, validateArms, writeDiff } from './replay-common.mjs'
import { runBuilder } from './replay-builder.mjs'
import { runPlanner } from './replay-planner.mjs'

const LANES = { b1380: '1d282ec7', b1381: '1d282ec7', b1402: '2966b484', b1408: 'fbc9ad2a', b1416: 'abe2d073', b1417: 'abe2d073' }
const CELL = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'seat-bench-test-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fresh = (label = 'run') => join(scratch, `${label}-${n++}`)
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }

test('the corpus carries every replay input for the six lanes', () => {
  for (const [lane, base] of Object.entries(LANES)) {
    const dir = join(CORPUS_DIR, lane)
    for (const name of ['plan.md', 'gate.mjs', 'planner-1.json', 'lean.json', 'brief.md', 'planner-prompt.txt', 'builder-prompt.txt', 'manifest.json']) {
      assert(existsSync(join(dir, name)), `${lane}/${name}`)
      assert(readFileSync(join(dir, name), 'utf8').trim().length > 0, `${lane}/${name} empty`)
    }
    const manifest = json(join(dir, 'manifest.json'))
    const lean = json(join(dir, 'lean.json'))
    assert.equal(manifest.lane, lane)
    assert.equal(manifest.base, base)
    assert.equal(manifest.originalTask, lean.taskDir)
    assert.equal(manifest.originalTree, lean.cwd)
    for (const role of ['planner', 'builder']) {
      const prompt = readFileSync(join(dir, `${role}-prompt.txt`), 'utf8')
      assert(prompt.startsWith(`You are the lean ${role}.`))
      assert(prompt.includes(manifest.originalTask))
      assert(/Return path: .*(planner|builder)-\d+\.json/.test(prompt))
    }
  }
})

test('validateArms accepts the closed vocabulary and the empty list, and refuses everything else', () => {
  assert.deepEqual(validateArms([]), [])
  assert.deepEqual(validateArms([...ARMS]), [...ARMS])
  for (const bad of ['nope', 'constructor', '__proto__', 'toString', 'FFF', '']) {
    assert.throws(() => validateArms(['fff', bad]), (e) => e.message.startsWith('unknown arm: ') && e.message.includes(bad === '' ? 'unknown arm: ' : bad))
  }
  assert.throws(() => validateArms([42]), /unknown arm/)
  assert.throws(() => validateArms('fff'), /list/)
})

for (const [name, run] of [['builder', runBuilder], ['planner', runPlanner]]) {
  test(`${name} replay refuses an unknown arm before preparing or starting a seat`, async () => {
    for (const arms of [['nope'], ['fff', 'nope'], ['constructor'], ['__proto__']]) {
      let prepared = 0, seats = 0
      const out = fresh(name)
      const result = await run({ lane: 'b1380', cell: CELL, arms, out }, { prepareRun: () => { prepared++; throw new Error('prepared') }, runAcpSeat: () => { seats++ } })
      assert.equal(prepared + seats, 0)
      assert.match(result.error, /unknown arm: /)
      assert.equal(json(join(out, 'result.json')).error, result.error)
      assert(existsSync(join(out, 'session.jsonl')) && existsSync(join(out, 'diff.patch')))
      assert(!existsSync(join(out, 'tree')))
    }
  })
  test(`${name} replay: a failing preparation is recorded and never reaches the seat`, async () => {
    for (const arms of [[], ['fff', 'readgate']]) {
      let seats = 0
      const out = fresh(name)
      const result = await run({ lane: 'b1380', cell: CELL, arms, out }, { prepareRun: () => { throw new Error('boom') }, runAcpSeat: () => { seats++ } })
      assert.equal(seats, 0)
      assert.match(result.error, /boom/)
      assert.match(json(join(out, 'result.json')).error, /boom/)
    }
  })
  test(`${name} replay records a bad cell`, async () => {
    const result = await run({ lane: 'b1380', cell: { agent: 'pi' }, arms: [], out: fresh(name) }, { prepareRun: () => { throw new Error('unreachable') } })
    assert.match(result.error, /cell\.model/)
  })
}

test('the CLIs record failures and exit nonzero', () => {
  const cell = join(scratch, 'cell.json')
  writeFileSync(cell, JSON.stringify(CELL))
  for (const script of ['replay-builder.mjs', 'replay-planner.mjs']) {
    const out = fresh('cli')
    const r = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380', '--cell', cell, '--arms', 'fff,bogus', '--out', out], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(json(join(out, 'result.json')).error, /unknown arm: bogus/)
    const missing = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380'], { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    const inside = join(CORPUS_DIR, 'b1380', 'run-here')
    const refused = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380', '--cell', cell, '--arms', '', '--out', inside], { encoding: 'utf8' })
    assert.equal(refused.status, 2)
    assert(!existsSync(inside))
  }
})

test('output destinations are confined', () => {
  const home = fresh('home')
  mkdirSync(join(home, '.crew'), { recursive: true })
  const opts = { home }
  assert.throws(() => createOutDir('relative/out', opts), /absolute/)
  assert.throws(() => createOutDir(join(CORPUS_DIR, 'x'), opts), /corpus/)
  assert.throws(() => createOutDir(join(CHECKOUT, 'bench', 'x'), opts), /checkout/)
  assert.throws(() => createOutDir(join(home, '.crew', 'x'), opts), /\.crew/)
  const link = fresh('link')
  symlinkSync(CHECKOUT, link)
  assert.throws(() => createOutDir(join(link, 'x'), opts), /checkout/)
  const existing = fresh('existing')
  mkdirSync(existing)
  assert.throws(() => createOutDir(existing, opts), /exists/)
  const ok = createOutDir(fresh('ok'), opts)
  assert(existsSync(join(ok, 'session.jsonl')))
})

// A throwaway repo and corpus so the default preparation runs for real without the crew checkout.
function fixture(lane = 'b1380') {
  const repo = fresh('repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1\n')
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'add', '.')
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'base')
  const base = sh(repo, 'rev-parse', 'HEAD')
  const corpusDir = fresh('corpus')
  const dir = join(corpusDir, lane)
  mkdirSync(dir, { recursive: true })
  const originalTask = `/orig/crew/${lane}/task`, originalTree = `/orig/dev/${lane}`
  const put = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  put('manifest.json', { lane, base, originalTask, originalTree })
  put('plan.md', `plan at ${originalTask} for ${originalTree}\n`)
  put('gate.mjs', `// gate in ${originalTask}\nprocess.exitCode = 1\n`)
  put('lean.json', { taskDir: originalTask, cwd: originalTree })
  put('planner-1.json', { role: 'planner', status: 'done', details: { acceptance: ['X1'], mutations: [{ check: 'X1' }], plan_path: `${originalTask}/plan.md:1-2` } })
  put('brief.md', '# brief\n')
  put('builder-prompt.txt', `You are the lean builder. Task directory: ${originalTask}\nCheckout: ${originalTree}\nReturn path: ${originalTask}/builder-2.json\n`)
  put('planner-prompt.txt', `You are the lean planner. Task directory: ${originalTask}\nCheckout: ${originalTree}\nReturn path: ${originalTask}/planner-1.json\n`)
  return { repo, corpusDir, base, deps: { corpusDir, repoDir: repo, home: fresh('home'), sleepMs: () => {} } }
}
const worktrees = (repo) => sh(repo, 'worktree', 'list').split('\n').length

test('builder replay: prompt rewrite, backfills, checks, diff with additions and cleanup', async () => {
  const fx = fixture()
  writeFileSync(join(fx.repo, 'old.test.mjs'), '// tracked test to delete\n')
  sh(fx.repo, 'add', 'old.test.mjs')
  sh(fx.repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'tracked test')
  const manifestPath = join(fx.corpusDir, 'b1380', 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify({ ...json(manifestPath), base: sh(fx.repo, 'rev-parse', 'HEAD') }, null, 2))
  const before = readdirSync(join(fx.corpusDir, 'b1380')).map((f) => [f, readFileSync(join(fx.corpusDir, 'b1380', f), 'utf8')])
  const seen = {}
  const out = fresh('build')
  const result = await runBuilder({ lane: 'b1380', cell: { ...CELL, advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium' }, wait_s: 60, settle_s: 0 }, arms: ['fff', 'readgate'], out }, {
    ...fx.deps,
    runAcpSeat(call) {
      Object.assign(seen, call)
      writeFileSync(join(call.cwd, 'a.mjs'), 'export const a = 2\n')
      writeFileSync(join(call.cwd, 'new.test.mjs'), "import test from 'node:test'\ntest('ok', () => {})\n")
      rmSync(join(call.cwd, 'old.test.mjs'))
      writeFileSync(join(call.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'built' }))
      return { stopReason: 'end_turn', usage: { in: 1 } }
    },
    runGate: async ({ cwd, gatePath }) => { assert(existsSync(join(cwd, 'a.mjs'))); assert(gatePath.startsWith(out)); return { status: 'green', failingIds: [] } },
    proveMutations: async ({ checks, mutations }) => { assert.deepEqual(checks, ['X1']); assert.equal(mutations.length, 1); return { status: 'ok', rows: [{ check: 'X1', outcome: 'killed' }] } },
  })
  assert.equal(result.error, null)
  assert.deepEqual(seen.definition, { role: 'builder', ...CELL, writes: 'repo', wait_s: 60, advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium' }, extensions: ['fff', 'readgate'] })
  assert(!seen.prompt.includes('/orig/'))
  assert(seen.prompt.includes(join(out, 'task', 'builder-2.json')) && seen.prompt.includes(join(out, 'tree')))
  const ret = json(join(out, 'task', 'planner-1.json'))
  assert.deepEqual(ret.details.files_in_scope, ['crew/loop.mjs', 'crew/loop.test.mjs'])
  assert.equal(ret.details.validation_lane, 'node --test crew/loop.test.mjs')
  assert.equal(ret.details.gate_cmd, `node ${join(out, 'task', 'gate.mjs')}`)
  assert(!readFileSync(join(out, 'task', 'plan.md'), 'utf8').includes('/orig/'))
  assert.equal(result.mutations.killed, 1)
  assert.deepEqual(result.changed.sort(), ['a.mjs', 'new.test.mjs', 'old.test.mjs'])
  assert.deepEqual(result.targeted, { files: 1, pass: 1, fail: 0, status: 0 })
  assert.equal(result.envelope.summary, 'built')
  const diff = readFileSync(join(out, 'diff.patch'), 'utf8')
  assert(diff.includes('+export const a = 2') && diff.includes('new.test.mjs'))
  assert.match(diff, /diff --git a\/old\.test\.mjs b\/old\.test\.mjs\ndeleted file mode/)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
  assert.deepEqual(readdirSync(join(fx.corpusDir, 'b1380')).map((f) => [f, readFileSync(join(fx.corpusDir, 'b1380', f), 'utf8')]), before)
  assert.deepEqual(json(join(out, 'result.json')).arms, ['fff', 'readgate'])
})

test('builder replay: seat, check and cleanup failures are recorded and the worktree goes', async () => {
  const fx = fixture('b1402')
  const out = fresh('fail')
  const result = await runBuilder({ lane: 'b1402', cell: CELL, arms: [], out }, {
    ...fx.deps,
    runAcpSeat: () => { throw Object.assign(new Error('seat down'), { code: 'ACP_X' }) },
    runGate: async () => { throw new Error('gate exploded') },
    proveMutations: async () => { throw new Error('unreachable') },
  })
  assert.match(result.error, /seat: ACP_X seat down/)
  assert.match(result.error, /gate: gate exploded/)
  assert.equal(result.gate, null)
  assert.match(json(join(out, 'result.json')).error, /seat down/)
  assert(existsSync(join(out, 'session.jsonl')) && existsSync(join(out, 'diff.patch')))
  assert.equal(worktrees(fx.repo), 1)
  const ret = json(join(out, 'task', 'planner-1.json'))
  assert.equal(ret.details.files_in_scope, undefined)
})

test('unmeasured check results returned by the crew APIs are recorded as errors with their diagnostics', async () => {
  const { runGate, proveMutations } = await import('../crew/checks.mjs')
  const unmeasuredGate = await runGate({ cwd: '', gatePath: '' }) // the real API's returned shape, not a throw
  assert.equal(unmeasuredGate.status, 'unmeasured')
  const unmeasuredProof = await proveMutations({ cwd: '' })
  assert.equal(unmeasuredProof.status, 'unmeasured')
  const copyFailed = { status: 'unmeasured', reason: 'copy-failed', rows: [], error: { code: 'ENOSPC', message: 'disk full' } }
  const seat = (call) => { writeFileSync(join(call.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'x' })); return { stopReason: 'end_turn' } }

  let fx = fixture()
  let result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ ...unmeasuredGate, reason: 'timeout' }), proveMutations: async () => { throw new Error('must not run') } })
  assert.match(result.error, /gate: unmeasured timeout/)
  assert.equal(result.gate.status, 'unmeasured')

  fx = fixture()
  const out = fresh('un')
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'green', reason: null, failingIds: [] }), proveMutations: async () => copyFailed })
  assert.match(result.error, /mutations: unmeasured copy-failed \(ENOSPC disk full\)/)
  assert.match(json(join(out, 'result.json')).error, /ENOSPC disk full/)
  assert.equal(result.mutations.diagnostics.error, 'ENOSPC disk full')

  fx = fixture()
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'green', reason: null, failingIds: [] }), proveMutations: async () => ({ status: 'unmeasured', reason: 'mutation-unmeasured', rows: [{ check: 'X1', outcome: 'unmeasured', reason: 'bind-fail' }] }) })
  assert.match(result.error, /X1:bind-fail/)

  // ordinary measured red results are not harness errors
  fx = fixture()
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'red', reason: 'exit-nonzero', failingIds: ['X1'] }), proveMutations: async () => { throw new Error('must not run') } })
  assert.equal(result.error, null)
  fx = fixture()
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'green', reason: null, failingIds: [] }), proveMutations: async () => ({ status: 'red', reason: 'mutations-survived', rows: [{ check: 'X1', outcome: 'survived' }] }) })
  assert.equal(result.error, null)

  fx = fixture()
  const pout = fresh('un')
  result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out: pout }, {
    ...fx.deps,
    runAcpSeat(call) {
      writeFileSync(join(call.taskDir, 'plan.md'), '# plan\n')
      writeFileSync(join(call.taskDir, 'gate.mjs'), 'x\n')
      writeFileSync(join(call.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'p', details: {} }))
      return { stopReason: 'end_turn' }
    },
    runGate: async () => ({ ...unmeasuredGate, reason: 'spawn-error', error: { code: 'ENOENT', message: 'no node' } }),
  })
  assert.match(result.error, /gate: unmeasured spawn-error \(ENOENT no node\)/)
  assert.equal(result.gate.baseline, 'unmeasured')
  assert.equal(result.gate.reason, 'spawn-error')
  assert.equal(result.gate.error, 'ENOENT no node')
})

test('a returned refusal or a turn with no stop reason is a recorded failure', async () => {
  for (const [turn, expect] of [[{ refusal: { code: 'auth', message: 'not logged in' }, stopReason: null }, /seat refused auth: not logged in/], [{}, /no stop reason/], [null, /no stop reason/]]) {
    for (const [name, run] of [['builder', runBuilder], ['planner', runPlanner]]) {
      const fx = fixture()
      const out = fresh(name)
      const result = await run({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: () => turn, runGate: async () => ({ status: 'red', failingIds: [] }) })
      assert.match(result.error, expect)
      assert.match(json(join(out, 'result.json')).error, expect)
      assert.equal(worktrees(fx.repo), 1)
    }
  }
})

test('a missing or malformed cell file is recorded in result.json by both CLIs', () => {
  const bad = join(scratch, 'bad-cell.json')
  writeFileSync(bad, '{not json')
  for (const script of ['replay-builder.mjs', 'replay-planner.mjs']) {
    for (const cellFile of [bad, join(scratch, 'no-such-cell.json')]) {
      const out = fresh('cli-cell')
      const r = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380', '--cell', cellFile, '--arms', '', '--out', out], { encoding: 'utf8' })
      assert.equal(r.status, 1, r.stderr)
      assert.match(json(join(out, 'result.json')).error, /cell file/)
      assert(existsSync(join(out, 'session.jsonl')) && existsSync(join(out, 'diff.patch')))
      assert(!existsSync(join(out, 'tree')))
    }
  }
})

test('a red gate skips the mutation proof', async () => {
  const fx = fixture()
  const result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('red') }, {
    ...fx.deps, runAcpSeat: (c) => { writeFileSync(join(c.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'x' })); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red', failingIds: ['X1'] }),
    proveMutations: async () => { throw new Error('must not run') },
  })
  assert.equal(result.error, null)
  assert.deepEqual(result.gate.failing, ['X1'])
  assert.equal(result.mutations, null)
})

test('a failure after the worktree exists still removes it', async () => {
  const fx = fixture()
  writeFileSync(join(fx.corpusDir, 'b1380', 'builder-prompt.txt'), 'You are the lean builder. no return file named here\n')
  const out = fresh('late')
  let seats = 0
  const result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: () => { seats++ } })
  assert.match(result.error, /names no return file/)
  assert.equal(seats, 0)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
})

test('planner replay: fresh task dir, baseline gate, repo writes, gate path confined', async () => {
  const fx = fixture('b1381')
  const out = fresh('plan')
  let seen
  const gates = []
  const result = await runPlanner({ lane: 'b1381', cell: CELL, arms: ['subagent'], out }, {
    ...fx.deps,
    runAcpSeat(call) {
      seen = call
      writeFileSync(join(call.taskDir, 'plan.md'), '# plan\n')
      writeFileSync(join(call.taskDir, 'gate.mjs'), 'process.exitCode = 1\n')
      writeFileSync(join(call.cwd, 'stray.txt'), 'x')
      writeFileSync(join(call.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'planned', details: { acceptance: ['X1'], mutations: [1, 2], gate_path: '/etc/hosts' } }))
      return { stopReason: 'end_turn' }
    },
    runGate: async ({ gatePath }) => { gates.push(gatePath); return { status: 'red', failingIds: ['X1'] } },
  })
  assert.equal(result.error, null)
  assert.equal(seen.definition.writes, 'task-dir')
  assert.deepEqual(seen.definition.extensions, ['subagent'])
  assert(!seen.prompt.includes('/orig/'))
  assert.equal(readFileSync(join(out, 'task', 'plan.md'), 'utf8'), '# plan\n', 'planner must not get the recorded solution')
  assert.deepEqual(gates, [join(out, 'task', 'gate.mjs')])
  assert.equal(result.repo_writes, 1)
  assert.equal(result.gate.baseline, 'red')
  assert.deepEqual(result.gate.failing, ['X1'])
  assert.equal(result.envelope.mutations, 2)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
})

test('a turn that ends without its required artifacts is a recorded failure', async () => {
  const good = { status: 'done', summary: 'ok' }
  const builderCases = [
    ['missing envelope', () => {}, /envelope: builder-2\.json not written/],
    ['malformed envelope', (c) => writeFileSync(join(c.taskDir, 'builder-2.json'), '{nope'), /builder-2\.json is not valid JSON/],
    ['non-object envelope', (c) => writeFileSync(join(c.taskDir, 'builder-2.json'), '[1]'), /not a JSON object/],
    ['envelope without summary', (c) => writeFileSync(join(c.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done' })), /lacks a status and summary/],
  ]
  for (const [label, write, expect] of builderCases) {
    const fx = fixture()
    const out = fresh('art')
    const result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: (c) => { write(c); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red', failingIds: [] }) })
    assert.match(result.error, expect, label)
    assert.match(json(join(out, 'result.json')).error, expect, label)
    assert.equal(result.envelope, null)
  }
  const plannerCases = [
    ['missing envelope', (c) => { writeFileSync(join(c.taskDir, 'plan.md'), '# p\n'); writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n') }, /envelope: planner-1\.json not written/],
    ['malformed envelope', (c) => { writeFileSync(join(c.taskDir, 'plan.md'), '# p\n'); writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n'); writeFileSync(join(c.taskDir, 'planner-1.json'), 'oops') }, /not valid JSON/],
    ['missing plan', (c) => { writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n'); writeFileSync(join(c.taskDir, 'planner-1.json'), JSON.stringify(good)) }, /planner: plan\.md not written/],
    ['missing gate', (c) => { writeFileSync(join(c.taskDir, 'plan.md'), '# p\n'); writeFileSync(join(c.taskDir, 'planner-1.json'), JSON.stringify(good)) }, /planner: gate\.mjs not written/],
  ]
  for (const [label, write, expect] of plannerCases) {
    const fx = fixture()
    const out = fresh('art')
    const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: (c) => { write(c); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red', failingIds: [] }) })
    assert.match(result.error, expect, label)
    assert.match(json(join(out, 'result.json')).error, expect, label)
    assert.equal(worktrees(fx.repo), 1)
  }
})

test('importing the replay modules starts nothing', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./replay-builder.mjs', import.meta.url).href)}); await import(${JSON.stringify(new URL('./replay-planner.mjs', import.meta.url).href)})`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  assert.equal(realpathSync(CHECKOUT), realpathSync(join(CORPUS_DIR, '..', '..')))
})

test('writeDiff captures staged edits, staged additions and unstaged edits, and fails loudly outside a repo', () => {
  const repo = fresh('diffrepo')
  mkdirSync(repo, { recursive: true })
  sh(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'a.txt'), 'a-staged\n')
  sh(repo, 'add', 'a.txt')
  writeFileSync(join(repo, 'new-staged.txt'), 'staged-new\n')
  sh(repo, 'add', 'new-staged.txt')
  writeFileSync(join(repo, 'b.txt'), 'b-unstaged\n')
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
  const file = join(scratch, 'diff-out.patch')
  writeDiff(repo, file)
  const patch = readFileSync(file, 'utf8')
  for (const needle of ['a-staged', 'staged-new', 'b-unstaged', 'untracked']) assert(patch.includes(needle), needle)
  assert.throws(() => writeDiff(scratch, join(scratch, 'never.patch')), /git .* failed/)
})
