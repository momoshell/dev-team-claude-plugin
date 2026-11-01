import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runReviewer, parseReviewerCli } from './replay-reviewer.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-replay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), corpus = join(root, 'corpus'), dir = join(corpus, 'b1')
  mkdirSync(repo); mkdirSync(dir, { recursive: true })
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  writeFileSync(join(repo, 'change'), 'base'); writeFileSync(join(repo, 'deleted'), 'gone'); git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'change'), 'built'); rmSync(join(repo, 'deleted')); writeFileSync(join(repo, 'added'), 'added'); git('add', '-A'); git('commit', '-qm', 'built')
  const head = git('rev-parse', 'HEAD')
  const manifest = { base, originalTask: '/old/task', originalTree: '/old/tree', reviewer: { builtHead: head, promptSource: '/archive' } }
  const put = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
  put('manifest.json', manifest); put('reviewer-prompt.txt', '/old/task/reviewer-2.json /old/tree\n'); put('plan.md', '/old/tree'); put('gate.mjs', ''); put('lean.json', '{}'); put('brief.md', 'brief')
  const mutations = [{ check: 'X', file: 'change', find: 'built', replace: 'broken' }, { check: 'Y', file: 'added', find: 'added', replace: 'damaged' }]
  put('planner-1.json', { details: { mutations } })
  let n = 0
  const run = (opts = {}, seat = () => ({ verdict: 'pass', findings: [] }), extra = {}) => {
    const out = join(root, `out${n++}`)
    return runReviewer({ lane: 'b1', cell: { agent: 'pi', model: 'm', effort: 'high' }, arms: [], out, variant: 'clean', ...opts }, { corpusDir: corpus, repoDir: repo, sleepMs: () => {}, runAcpSeat: async (call) => { const details = seat(call); writeFileSync(join(call.taskDir, 'reviewer-2.json'), JSON.stringify({ role: 'reviewer', id: 'test.reviewer.2', status: 'done', summary: 'review', details })); return { stopReason: 'end' } }, ...extra }).then((result) => ({ result, out }))
  }
  return { root, dir, manifest, base, head, mutations, put, run }
}

// MUTATION: RS1 replaces the loaded status with null.
test('RS1 records valid reviewer return statuses', async (t) => {
  const fx = fixture(t)
  for (const status of ['done', 'insufficient', 'escalate']) {
    const run = status === 'done' ? await fx.run() : await fx.run({}, undefined, { runAcpSeat: async ({ taskDir }) => {
      writeFileSync(join(taskDir, 'reviewer-2.json'), JSON.stringify({ role: 'reviewer', id: 'test.reviewer.2', status, summary: 'review', details: { verdict: 'pass', findings: [] } }))
      return { stopReason: 'end' }
    } })
    for (const row of [run.result, JSON.parse(readFileSync(join(run.out, 'result.json'), 'utf8'))]) {
      assert.equal(row.status, status); assert.equal(row.status_reason, null)
      assert.equal(row.firstReturnStatus, status); assert.equal(row.error, null)
      assert.equal(row.verdict, status === 'done' ? 'pass' : null)
      assert.deepEqual(row.findings, status === 'done' ? [] : null)
    }
  }
})

// MUTATION: RS2 replaces the loaded reason with not-run.
test('RS2 records a missing reviewer return', async (t) => {
  const fx = fixture(t)
  const run = await fx.run({}, undefined, { runAcpSeat: async () => ({ stopReason: 'end' }) })
  for (const row of [run.result, JSON.parse(readFileSync(join(run.out, 'result.json'), 'utf8'))]) {
    assert.equal(row.status, null); assert.equal(row.status_reason, 'missing-return')
    assert.equal(row.firstReturnStatus, null); assert.match(row.error, /reviewer-2\.json not written/)
  }
})

// MUTATION: RS3 clears the loaded status when validation rejects an envelope.
test('RS3 retains loaded status for rejected reviewer returns', async (t) => {
  const fx = fixture(t)
  fx.put('reviewer-prompt.txt', 'Envelope id: test.reviewer.2\n/old/task/reviewer-2.json /old/tree\n')
  for (const status of ['done', 'insufficient', 'escalate']) {
    for (const invalid of [{ id: 'wrong.reviewer.2' }, { extra: true }]) {
      const run = await fx.run({}, undefined, { runAcpSeat: async ({ taskDir }) => {
        writeFileSync(join(taskDir, 'reviewer-2.json'), JSON.stringify({ role: 'reviewer', id: 'test.reviewer.2', status, summary: 'review', details: { verdict: 'pass', findings: [] }, ...invalid }))
        return { stopReason: 'end' }
      } })
      for (const row of [run.result, JSON.parse(readFileSync(join(run.out, 'result.json'), 'utf8'))]) {
        assert.equal(row.status, status); assert.equal(row.status_reason, null)
        assert.equal(row.firstReturnStatus, null)
        assert.match(row.error, invalid.extra ? /unknown field extra/ : /id does not match issued id/)
      }
    }
  }
})

// MUTATION: RR1 checks out the parent instead of the built head.
test('RR1 replays built snapshot as changes and records a reviewer return', async (t) => {
  const fx = fixture(t)
  const { result, out } = await fx.run({}, ({ cwd, taskDir, prompt, definition }) => {
    assert.equal(readFileSync(join(cwd, 'change'), 'utf8'), 'built')
    assert.equal(readFileSync(join(cwd, 'added'), 'utf8'), 'added'); assert(!existsSync(join(cwd, 'deleted')))
    assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim(), fx.base)
    assert(prompt.includes(taskDir)); assert(prompt.includes(cwd)); assert.equal(definition.role, 'reviewer')
    return { verdict: 'pass', findings: [] }
  })
  assert.equal(result.error, null); assert.equal(result.verdict, 'pass'); assert.equal(result.firstReturnStatus, 'done'); assert.equal(result.seededFileCited, null); assert(!existsSync(join(out, 'tree')))
  for (const status of ['insufficient', 'escalate']) {
    const refused = await fx.run({}, undefined, { runAcpSeat: async ({ taskDir }) => { writeFileSync(join(taskDir, 'reviewer-2.json'), JSON.stringify({ role: 'reviewer', id: 'test.reviewer.2', status, summary: 'cannot inspect', details: { verdict: 'changes-needed', findings: [] } })); return {} } })
    assert.equal(refused.result.firstReturnStatus, status); assert.equal(refused.result.verdict, null); assert.equal(refused.result.findings, null)
  }
  assert.equal(parseReviewerCli(['--lane','b1','--cell','x','--arms','','--out','/tmp/x','--variant','clean']).variant, 'clean')
})

// MUTATION: RR2 omits the source replacement.
test('RR2 applies only the selected mutation', async (t) => {
  const fx = fixture(t)
  const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '.git').flatMap((e) => e.isDirectory() ? Object.entries(snapshot(join(dir, e.name))).map(([name, bytes]) => [`${e.name}/${name}`, bytes]) : [[e.name, readFileSync(join(dir, e.name)).toString('base64')]]))
  const corpus = snapshot(fx.dir)
  const capture = async (opts) => {
    let input
    const run = await fx.run(opts, ({ cwd, taskDir, prompt }) => {
      const normalize = (s) => s.replaceAll(cwd, '<tree>').replaceAll(taskDir, '<task>')
      input = { tree: snapshot(cwd), prompt: normalize(prompt), task: Object.fromEntries(['plan.md', 'gate.mjs', 'planner-1.json', 'lean.json'].map((name) => [name, normalize(readFileSync(join(taskDir, name), 'utf8'))])) }
      return { verdict: 'pass', findings: [] }
    })
    assert.equal(run.result.error, null)
    return { input, result: run.result }
  }
  const clean = await capture({})
  for (const mutation of fx.mutations) {
    const seeded = await capture({ variant: 'seeded', mutation: mutation.check })
    assert.deepEqual(seeded.result.seededMutation, mutation)
    assert.deepEqual(seeded.input, { ...clean.input, tree: { ...clean.input.tree, [mutation.file]: Buffer.from(mutation.replace).toString('base64') } })
    assert.deepEqual(snapshot(fx.dir), corpus)
  }
  for (const opts of [{ variant: 'seeded', mutation: 'unknown' }, { variant: 'clean', mutation: 'X' }, { variant: 'seeded' }, { variant: 'other' }]) assert((await fx.run(opts)).result.error)
  for (const rows of [[{ ...fx.mutations[0], file: '../change' }], [{ ...fx.mutations[0], find: 'missing' }], [fx.mutations[0], fx.mutations[0]]]) {
    fx.put('planner-1.json', { details: { mutations: rows } })
    assert((await fx.run({ variant: 'seeded', mutation: 'X' })).result.error)
  }
})

// MUTATION: RR3 counts a should-fix instead of a must-fix.
test('RR3 cites only must-fix findings at the seeded file', async (t) => {
  const fx = fixture(t)
  const finding = (severity, location) => ({ id: 'f', severity, location, summary: 'defect' })
  for (const [severity, location, expected] of [['must-fix','change:4',true], ['should-fix','change:4',false], ['must-fix','other/change',false], ['must-fix','change-extra',false]]) {
    const { result } = await fx.run({ variant: 'seeded', mutation: 'X' }, () => ({ verdict: 'changes-needed', findings: [finding(severity, location)] }))
    assert.equal(result.seededFileCited, expected)
  }
  const absolute = await fx.run({ variant: 'seeded', mutation: 'X' }, ({ cwd }) => ({ verdict: 'changes-needed', findings: [finding('must-fix', join(cwd, 'change') + ':1:2')] }))
  assert.equal(absolute.result.seededFileCited, true)
  const invalid = await fx.run({ variant: 'seeded', mutation: 'X' }, () => ({ verdict: 'pass', findings: [finding('must-fix', 'change')] }))
  assert(invalid.result.error); assert.equal(invalid.result.seededFileCited, null)
  const good = { role: 'reviewer', id: 'test.reviewer.2', status: 'done', summary: 'review', details: { verdict: 'pass', findings: [] } }
  for (const envelope of [
    { ...good, extra: true },
    { ...good, details: { ...good.details, extra: true } },
    { ...good, details: { verdict: 'changes-needed', findings: [{ ...finding('must-fix', 'change'), extra: true }] } },
    { ...good, details: { verdict: 'changes-needed', findings: [finding('must-fix', 'change'), finding('must-fix', 'change')] } },
    { ...good, details: { verdict: 'changes-needed', findings: [{ ...finding('must-fix', 'change'), id: 'bad id' }] } },
  ]) {
    const { result } = await fx.run({ variant: 'seeded', mutation: 'X' }, undefined, { runAcpSeat: async ({ taskDir }) => { writeFileSync(join(taskDir, 'reviewer-2.json'), JSON.stringify(envelope)); return {} } })
    assert(result.error); assert.equal(result.verdict, null); assert.equal(result.findings, null); assert.equal(result.seededFileCited, null)
  }
})

// MUTATION: RR4 falls back to the original base when the pin is missing.
test('RR4 refuses missing pins before creating a worktree', async (t) => {
  const fx = fixture(t); fx.manifest.reviewer.builtHead = null; fx.put('manifest.json', fx.manifest)
  let calls = 0
  const { result } = await fx.run({}, undefined, { addWorktree: () => { calls++ } })
  assert.match(result.error, /built head/); assert.equal(calls, 0)
  fx.manifest.reviewer.builtHead = '0'.repeat(40); fx.put('manifest.json', fx.manifest)
  assert((await fx.run({}, undefined, { addWorktree: () => { calls++ } })).result.error)
  fx.manifest.reviewer.builtHead = fx.head; fx.put('manifest.json', fx.manifest); rmSync(join(fx.dir, 'reviewer-prompt.txt'))
  assert((await fx.run({}, undefined, { addWorktree: () => { calls++ } })).result.error)
  assert.equal(calls, 0)
})
