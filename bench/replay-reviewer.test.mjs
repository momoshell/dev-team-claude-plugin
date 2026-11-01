import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

const corpusPins = {
  b1452: ['b1452-lean-waterfall', '45ad32da22f1339efb3b2c6ce56803348a5c1d1f', 3, '660f6d99b92536a07bfd9f8c8dff4102afed4218', 'f62a5493ba8eeef9bed7bd3d7049c67ac15a3c16bb88ef6d8492ce7c79e57702'],
  b1425: ['b1425-scout-rule-and-nudge', 'ab74c3e443cb9f986a26cf4b651926e76f36c0e7', 3, 'b33e1b554102ad2d17cafa13d252cef7d986d503', '64ac502334245987325bf725dc3e6fe81f6841670fb69316dc452b11b9c6f37d'],
  b1386: ['b1386-claude-seat-arms', '21e53d3938c7aeed114612586a40ccdec74e1873', 5, '855bf66b924ef2535c2ab90512aa18c83cf3291c', '1d53cbd60e5ceb402a0cc341fb59400f343ca69b06ef5221b68223f8cf589550'],
  b1427: ['b1427-pre-return-whole-diff', 'c14ac23b935f35586a67b13d1beed142e6ff22bb', 10, '7d96e4674589a816fb37b7f2c1d70805d3084190', '6b58476ee3c5939ea10147ff25d6c0281c3485cb565f9a0a9a8fd88015897a56'],
  b1433: ['b1433-seat-bench', '6f83e0efef6692ebe4b34bd558418d9cd75b3dda', 20, '67c968c108e13c401dde92e8bed7bcfcce578161', '1a5a25023ec8d409cce4dce7939ef7f8740d4e5358852e650c3ad698b654b127'],
}
function checkCorpus(lanes) {
  for (const lane of lanes) {
    const [id, head, round, base, hash] = corpusPins[lane], dir = join('bench/corpus', lane)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'))), lean = JSON.parse(readFileSync(join(dir, 'lean.json')))
    assert.equal(manifest.lane, lane); assert.equal(manifest.id, id); assert.equal(manifest.base, base)
    assert.equal(manifest.originalTask, lean.taskDir); assert.equal(manifest.originalTree, lean.cwd)
    assert.equal(manifest.source, `/Users/momoshell/.crew-journal-archive/dt-${id}/${id}/task`)
    assert.deepEqual(manifest.reviewer, { builtHead: head, promptSource: `${manifest.source}/lean/reviewer/${id}.reviewer.${round}.jsonl` })
    assert.equal(readFileSync(join(dir, 'brief.md'), 'utf8'), lean.brief)
    const prompt = readFileSync(join(dir, 'reviewer-prompt.txt'), 'utf8')
    assert(prompt.includes(`Envelope id: ${id}.reviewer.${round}\n`)); assert(prompt.includes(`Return path: ${lean.taskDir}/reviewer-${round}.json`))
    const digest = createHash('sha256')
    for (const file of ['plan.md', 'gate.mjs', 'planner-1.json', 'lean.json', 'brief.md', 'planner-prompt.txt', 'builder-prompt.txt', 'reviewer-prompt.txt']) digest.update(readFileSync(join(dir, file)))
    assert.equal(digest.digest('hex'), hash)
  }
}
// MUTATION: DC1 removes a first-round corpus pin.
test('DC1 freezes first reviewer rounds', () => checkCorpus(['b1452', 'b1425']))
// MUTATION: DC2 changes a last-round prompt.
test('DC2 freezes last reviewer rounds', () => checkCorpus(['b1386', 'b1427', 'b1433']))

// MUTATION: DC3 removes known defect metadata.
test('DC3 records all known defects', () => {
  const expected = {
    b1452: [['c43edcff'], ['visualizer/web/src/lib/LeanWaterfall.svelte', 'visualizer/web/src/lib/timeline.js']],
    b1425: [['8f2a7037'], ['crew/pi/extensions/subagent.ts']], b1386: [['04325b18'], ['crew/adapters/claude-arms.mjs', 'crew/adapters/adapter-claude.mjs']],
    b1427: [['711f2770'], ['crew/pi/extensions/advisor.ts']], b1433: [['1a8856ca', '94fa08a8'], ['bench/replay-builder.mjs', 'bench/blind-review.mjs']],
    b1381: [['8d6a354b'], ['crew/lean.mjs']], b1402: [['914262c1'], ['crew/loop.mjs']], b1416: [['8592d6ef'], ['crew/loop.mjs']],
    b1441: [['4ad976f6'], ['crew/acp/provider.mjs']], b1458: [[], ['skills/ui-design/SKILL.md']],
  }
  for (const [lane, [commits, files]] of Object.entries(expected)) {
    const d = JSON.parse(readFileSync(join('bench/corpus', lane, 'manifest.json'))).knownDefect
    assert.deepEqual(d.files, files); assert.equal(d.fixingCommits.length, commits.length)
    commits.forEach((prefix, i) => { assert.match(d.fixingCommits[i], /^[a-f0-9]{40}$/); assert(d.fixingCommits[i].startsWith(prefix)) })
    assert.match(d.description, /^[^\r\n]+$/); if (lane === 'b1458') assert.equal(d.reason, 'not-restored')
  }
})

// MUTATION: DC4 suppresses defect citation measurement.
test('DC4 records defect file overlap for valid returns', async (t) => {
  const fx = fixture(t), knownDefect = { fixingCommits: ['a'.repeat(40)], files: ['change', 'added'], description: 'Defect' }
  fx.manifest.knownDefect = knownDefect; fx.put('manifest.json', fx.manifest)
  fx.put('reviewer-prompt.txt', 'Envelope id: test.reviewer.2\n/old/task/reviewer-2.json /old/tree\n')
  const finding = (location, severity = 'should-fix') => ({ id: 'f', severity, location, summary: 'defect' })
  const check = (run, value, reason) => { for (const row of [run.result, JSON.parse(readFileSync(join(run.out, 'result.json'), 'utf8'))]) { assert.deepEqual(row.knownDefect, knownDefect); assert.equal(row.defectFileCited, value); assert.equal(row.unknown.defectFileCited, reason) } }
  for (const loc of ['change', 'added:4', 'change:1:2', 'added:1-3', 'change:1:2-3:4', (cwd) => join(cwd, 'added') + ':4']) {
    check(await fx.run({}, ({ cwd }) => ({ verdict: 'pass', findings: [finding(typeof loc === 'function' ? loc(cwd) : loc, 'consider')] })), true, undefined)
  }
  for (const loc of [null, 'change-extra', 'other/change', 'change:bad', 'change:2 trailing']) {
    check(await fx.run({}, () => ({ verdict: 'pass', findings: loc ? [finding(loc)] : [] })), false, undefined)
  }
  for (const envelope of [null, { role: 'reviewer', id: 'wrong', status: 'done', summary: 'review', details: { verdict: 'pass', findings: [] } }, { role: 'reviewer', id: 'test.reviewer.2', status: 'done', summary: 'review', details: { verdict: 'pass', findings: [] }, extra: true }, { role: 'reviewer', id: 'test.reviewer.2', status: 'insufficient', summary: 'review', details: { verdict: 'pass', findings: [] } }]) {
    check(await fx.run({}, undefined, { runAcpSeat: async ({ taskDir }) => { if (envelope) writeFileSync(join(taskDir, 'reviewer-2.json'), JSON.stringify(envelope)); return { stopReason: 'end' } } }), null, 'not-measured')
  }
  const seeded = await fx.run({ variant: 'seeded', mutation: 'X' }, () => ({ verdict: 'pass', findings: [finding('change')] }))
  check(seeded, true, undefined); assert.equal(seeded.result.seededFileCited, false)
  delete fx.manifest.knownDefect; fx.put('manifest.json', fx.manifest)
  const absent = await fx.run(); for (const row of [absent.result, JSON.parse(readFileSync(join(absent.out, 'result.json'), 'utf8'))]) { assert.equal(row.knownDefect, null); assert.equal(row.defectFileCited, null); assert.equal(row.unknown.defectFileCited, 'no-known-defect') }
})
