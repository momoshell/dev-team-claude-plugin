import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ARMS, CHECKOUT, CORPUS_DIR, addedLines, createOutDir, parseCli, validateArms, writeDiff } from './replay-common.mjs'
import { openMemory, renderSection } from '../crew/memory.mjs'
import { parseAgent } from '../crew/protocols.mjs'
import { runBuilder } from './replay-builder.mjs'
import { runPlanner } from './replay-planner.mjs'

const CELL = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'seat-bench-test-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fresh = (label = 'run') => join(scratch, `${label}-${n++}`)
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }

// MUTATION: remove the codemode field refusal.
test('CC2 rejects codemode before preparation', async () => {
  for (const run of [runBuilder, runPlanner]) for (const codemode of [true, false, null, undefined, 'true', 1, [], {}]) {
    let calls = 0
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: { ...CELL, codemode }, arms: [], out }, { prepareRun: () => { calls++ }, runAcpSeat: () => { calls++ } })
    assert.equal(calls, 0)
    assert.match(result.error, /cell\.codemode/)
    assert.equal(json(join(out, 'result.json')).error, result.error)
    assert.equal(result.status_reason, 'not-run')
  }
})

// MUTATION: CC3 replaces the first-return status extraction with null.
test('CC3 persists first-return status and reasons for both roles', async () => {
  const fx = fixture()
  const cases = [
    ['done', JSON.stringify({ status: 'done', summary: 'ok' }), 'done', null],
    ['insufficient', JSON.stringify({ status: 'insufficient', summary: 'ok' }), 'insufficient', null],
    ['escalate', JSON.stringify({ status: 'escalate', summary: 'ok' }), 'escalate', null],
    ['no summary', JSON.stringify({ status: 'insufficient' }), 'insufficient', null],
    ['missing', null, null, 'missing-return'],
    ['unreadable', 'directory', null, 'unreadable-return'],
    ['malformed', '{', null, 'invalid-json'],
    ['non-object', '[]', null, 'invalid-envelope'],
    ['no status', JSON.stringify({ summary: 'ok' }), null, 'invalid-status'],
    ['unknown', JSON.stringify({ status: 'other', summary: 'ok' }), null, 'invalid-status'],
  ]
  for (const [role, run] of [['builder', runBuilder], ['planner', runPlanner]]) for (const [label, content, status, reason] of cases) {
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps,
      runAcpSeat: (call) => {
        const file = join(call.taskDir, role === 'builder' ? 'builder-2.json' : 'planner-1.json')
        if (content === 'directory') mkdirSync(file)
        else if (content !== null) writeFileSync(file, content)
        if (role === 'planner') { writeFileSync(join(call.taskDir, 'plan.md'), 'plan'); writeFileSync(join(call.taskDir, 'gate.mjs'), 'gate') }
        return { stopReason: 'end_turn' }
      }, runGate: async () => { throw new Error('gate failed') }, proveMutations: async () => ({}),
    })
    assert.equal(result.status, status, label)
    assert.equal(result.status_reason, reason, label)
    const saved = json(join(out, 'result.json'))
    assert.equal(saved.status, status, label)
    assert.equal(saved.status_reason, reason, label)
  }
  for (const run of [runBuilder, runPlanner]) {
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: CELL, arms: [], out }, { prepareRun: () => { throw new Error('setup failed') } })
    assert.equal(result.status, null)
    assert.equal(result.status_reason, 'not-run')
    assert.equal(json(join(out, 'result.json')).status_reason, 'not-run')
  }
})

// MUTATION: SK2 removes skill shape validation.
test('SK2 rejects malformed skills before preparation in both replays', async () => {
  for (const run of [runBuilder, runPlanner]) for (const skills of [null, 'x', {}, [1], ['x', null], [''], ['  ']]) {
    let calls = 0
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: { ...CELL, skills }, arms: [], out }, { prepareRun: () => { calls++ }, runAcpSeat: () => { calls++ } })
    assert.equal(calls, 0)
    assert.match(result.error, /cell\.skills/)
    assert.equal(json(join(out, 'result.json')).error, result.error)
  }
})

test('missing planner prompts refuse early without blocking builders', async () => {
  for (const reason of ['archive has no session', null]) {
    const fx = fixture()
    const dir = join(fx.corpusDir, 'b1380')
    if (reason) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...json(join(dir, 'manifest.json')), plannerPromptMissing: reason }))
    else rmSync(join(dir, 'planner-prompt.txt'))
    let calls = 0
    const out = fresh()
    const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: () => { calls++ } })
    assert.match(result.error, reason ? /archive has no session/ : /missing first planner prompt/)
    assert.equal(calls, 0)
    assert(!existsSync(join(out, 'tree')))
    const builder = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh() }, { ...fx.deps, runAcpSeat: (call) => { calls++; writeFileSync(join(call.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'ok' })); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red' }), proveMutations: async () => ({}) })
    assert.equal(builder.error, null)
    assert.equal(calls, 1)
    assert.equal(worktrees(fx.repo), 1)
  }
})

// MUTATION: add a retired arm back to ARMS.
test('validateArms accepts the closed vocabulary and the empty list, and refuses everything else', () => {
  assert.deepEqual(validateArms([]), [])
  assert.deepEqual(ARMS, ['readgate', 'skeletonread', 'subagent', 'fff'])
  assert.ok(Object.isFrozen(ARMS))
  assert.deepEqual(validateArms([...ARMS]), [...ARMS])
  for (const bad of ['lab', 'builderloop', 'reminders', 'nope', 'constructor', '__proto__', 'toString', 'FFF', '']) {
    assert.throws(() => validateArms(['fff', bad]), (e) => e.message.startsWith('unknown arm: ') && e.message.includes(bad === '' ? 'unknown arm: ' : bad))
  }
  assert.throws(() => validateArms([42]), /unknown arm/)
  assert.throws(() => validateArms('fff'), /list/)
})

for (const [name, run] of [['builder', runBuilder]]) {
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
  assert.deepEqual(seen.definition, { role: 'builder', ...CELL, writes: 'repo', wait_s: 60, advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium' }, skills: [], extensions: ['fff', 'readgate'] })
  assert(!seen.prompt.includes('/orig/'))
  assert(seen.prompt.includes(join(out, 'task', 'builder-2.json')) && seen.prompt.includes(join(out, 'tree')))
  const ret = json(join(out, 'task', 'planner-1.json'))
  assert.deepEqual(ret.details.files_in_scope, ['crew/loop.mjs', 'crew/loop.test.mjs'])
  assert.equal(ret.details.validation_lane, 'node --test crew/loop.test.mjs')
  assert(!readFileSync(join(out, 'task', 'plan.md'), 'utf8').includes('/orig/'))
  assert.deepEqual(result.changed.sort(), ['a.mjs', 'new.test.mjs', 'old.test.mjs'])
  // MUTATION: omit added totals from gate-variant results.
  assert.deepEqual(json(join(out, 'result.json')).added, { source: 1, test: 2, binary: 0 })
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
  assert.match(json(join(out, 'result.json')).error, /seat down/)
  assert(existsSync(join(out, 'session.jsonl')) && existsSync(join(out, 'diff.patch')))
  assert.equal(worktrees(fx.repo), 1)
  const ret = json(join(out, 'task', 'planner-1.json'))
  assert.equal(ret.details.files_in_scope, undefined)
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

test('planner memory appends the rendered section and persists accounting; empty stores refuse the seat', async () => {
  const fx = fixture()
  const memory = fresh('memory')
  mkdirSync(memory)
  writeFileSync(join(memory, 'MEMORY.md'), '- [alpha](alpha.md)\n- [missing](missing.md)\n')
  writeFileSync(join(memory, 'alpha.md'), 'Team judgment\n')
  const extract = openMemory({ dir: memory }).context({ task: '# brief\n', role: 'planner' })
  assert.deepEqual(extract.included.map((entry) => entry.path), ['MEMORY.md', 'alpha.md'])
  assert.deepEqual(extract.dropped.map((entry) => entry.path), ['missing.md'])
  for (const dir of [undefined, memory]) {
    const out = fresh('memory-plan')
    let prompt
    const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, ...(dir ? { memory: dir } : {}) }, {
      ...fx.deps,
      runAcpSeat(call) {
        prompt = call.prompt
        writeFileSync(join(call.taskDir, 'plan.md'), '# plan\n')
        writeFileSync(join(call.taskDir, 'gate.mjs'), 'x\n')
        writeFileSync(join(call.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'planned' }))
        return { stopReason: 'end_turn' }
      },
      runGate: async () => ({ status: 'red', failingIds: [] }),
    })
    const original = `You are the lean planner. Task directory: ${join(out, 'task')}\nCheckout: ${join(out, 'tree')}\nReturn path: ${join(out, 'task', 'planner-1.json')}\n`
    assert.equal(prompt, original + (dir ? `\n\n${renderSection(extract)}` : ''))
    assert.equal(result.error, null)
    assert.deepEqual(json(join(out, 'result.json')).memory, dir ? { dir, included: extract.included, dropped: extract.dropped, bytes: extract.bytes, reason: extract.reason } : undefined)
    assert.equal(worktrees(fx.repo), 1)
  }
  const empty = fresh('empty-memory')
  mkdirSync(empty)
  const out = fresh('empty-plan')
  let seats = 0
  const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, memory: empty }, { ...fx.deps, runAcpSeat: () => { seats++ } })
  assert.match(result.error, /memory.*no-index/)
  assert.equal(json(join(out, 'result.json')).error, result.error)
  assert.equal(seats, 0)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
})

const charterDefinition = '---\nname: test-planner\ndescription: fixture\nrole: planner\nagent: claude\nmodel: example/model\neffort: low\n---\n\nReplacement Ω\n  \n'
const recordedSuffix = 'Definition source: /old/planner.md\r\n\r\n## Brief\nLane Ω\nDefinition source: later\nReturn path: /orig/crew/b1380/task/planner-1.json\nCheckout: /orig/dev/b1380\n  \n'

function charterFixture() {
  const fx = fixture()
  const charter = fresh('charter')
  writeFileSync(charter, charterDefinition)
  writeFileSync(join(fx.corpusDir, 'b1380', 'planner-prompt.txt'), 'Old charter\n\n' + recordedSuffix)
  return { ...fx, charter }
}

async function captureCharter(fx, options = {}) {
  const out = fresh('charter-run')
  let call
  const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, ...options }, {
    ...fx.deps,
    runAcpSeat(c) {
      call = c
      writeFileSync(join(c.taskDir, 'plan.md'), '# plan\n')
      writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n')
      writeFileSync(join(c.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'ok' }))
      return { stopReason: 'end_turn' }
    },
    runGate: async () => ({ status: 'red' }),
  })
  return { out, result, call }
}

// MUTATION: CS1 replaces the charter body with a wrong charter.
test('CS1 planner charter body, CLI, validation and memory', async () => {
  const fx = charterFixture()
  const args = ['--lane', 'b1380', '--cell', 'cell.json', '--arms', '', '--out', '/tmp/out']
  assert.equal(parseCli([...args, '--charter', fx.charter], { allowCharter: true }).charter, fx.charter)
  for (const value of [[], ['--lane'], ['-x'], ['']]) assert.throws(() => parseCli([...args, '--charter', ...value], { allowCharter: true }), /needs a value/)
  assert.throws(() => parseCli([...args, '--charter', fx.charter]), /unknown argument/)
  const cellFile = fresh('cell'); writeFileSync(cellFile, JSON.stringify(CELL))
  const cliOut = fresh('cli-charter')
  const cli = spawnSync(process.execPath, [join(CHECKOUT, 'bench/replay-planner.mjs'), '--lane', 'b1380', '--cell', cellFile, '--arms', 'bad', '--out', cliOut, '--charter', fx.charter], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.equal(json(join(cliOut, 'result.json')).charter, fx.charter)
  const builderOut = fresh('builder-charter')
  const builder = spawnSync(process.execPath, [join(CHECKOUT, 'bench/replay-builder.mjs'), '--lane', 'b1380', '--cell', cellFile, '--arms', 'bad', '--out', builderOut, '--charter', fx.charter], { encoding: 'utf8' })
  assert.equal(builder.status, 1)
  assert.equal(json(join(builderOut, 'result.json')).charter, fx.charter)
  assert.throws(() => parseCli([...args, '--build-first'], { allowCharter: true }), /unknown argument/)
  const memory = fresh('charter-memory'); mkdirSync(memory)
  writeFileSync(join(memory, 'MEMORY.md'), '- [alpha](alpha.md)\n')
  writeFileSync(join(memory, 'alpha.md'), 'Team judgment\n')
  const { out, result, call } = await captureCharter(fx, { charter: fx.charter, memory })
  assert.equal(result.error, null)
  assert.equal(json(join(out, 'result.json')).charter, fx.charter)
  assert(call.prompt.startsWith(parseAgent(charterDefinition).body + '\n\nDefinition source:'))
  assert(!call.prompt.includes('Old charter') && !call.prompt.includes('name: test-planner'))
  assert.equal(call.definition.model, CELL.model)
  assert.equal(call.definition.agent, CELL.agent)
  assert(call.prompt.endsWith('\n\n' + renderSection(openMemory({ dir: memory }).context({ task: '# brief\n', role: 'planner' }))))
  const ordinary = await captureCharter(fx)
  assert.equal(ordinary.result.error, null)
  assert.equal(json(join(ordinary.out, 'result.json')).charter, null)
  assert(ordinary.call.prompt.startsWith('Old charter\n\n'))
  for (const content of [null, 'bad definition', charterDefinition.replace('effort: low', 'effort: impossible')]) {
    const file = fresh('invalid-charter')
    if (content !== null) writeFileSync(file, content)
    const rejected = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out: fresh(), charter: file }, { ...fx.deps, repoDir: '/no/such/repo', runAcpSeat: () => assert.fail('seat called') })
    assert.match(rejected.error, content === null ? /ENOENT/ : /invalid charter/)
  }
})

// MUTATION: CS3 disables the missing-marker refusal.
test('CS3 refuses a missing source line before worktree creation', async () => {
  const fx = charterFixture()
  writeFileSync(join(fx.corpusDir, 'b1380', 'planner-prompt.txt'), 'No marker\nReturn path: planner-1.json\n')
  const out = fresh()
  let seats = 0
  const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, charter: fx.charter }, { ...fx.deps, repoDir: '/no/such/repo', runAcpSeat: () => { seats++ } })
  assert.match(result.error, /no Definition source: line/)
  assert.equal(seats, 0)
  assert(!existsSync(join(out, 'task')))
})

test('memory CLI option is planner-only and requires a value', () => {
  const args = ['--lane', 'b1380', '--cell', 'cell.json', '--arms', '', '--out', '/tmp/out']
  assert.equal(parseCli([...args, '--memory', '/tmp/store'], { allowMemory: true }).memory, '/tmp/store')
  assert.throws(() => parseCli([...args, '--memory'], { allowMemory: true }), /needs a value/)
  assert.throws(() => parseCli(['--memory', '--lane', ...args], { allowMemory: true }), /needs a value/)
  assert.throws(() => parseCli([...args, '--memory', '/tmp/store']), /unknown argument/)
  const builder = spawnSync(process.execPath, [join(CHECKOUT, 'bench/replay-builder.mjs'), ...args, '--memory', '/tmp/store'], { encoding: 'utf8' })
  assert.equal(builder.status, 2)
  assert.match(builder.stderr, /unknown argument --memory/)
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
