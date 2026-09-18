import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process'
import { scratchDir } from '../../../test/helpers.mjs'
import * as mod from './builderloop.ts'

function fixture({ lane = 'node --test in.test.mjs', scope = ['in.test.mjs'], gate = 'node task/gate.mjs' } = {}) {
  const root = scratchDir('builder-loop-')
  const taskDir = join(root, 'task')
  const runId = 'run-fixture-1'
  const returns = join(root, 'returns', runId)   // run-scoped, as the driver writes it since 2fac235d
  mkdirSync(taskDir, { recursive: true })
  mkdirSync(returns, { recursive: true })
  writeFileSync(join(root, 'in.test.mjs'), 'export {}\n')
  writeFileSync(join(root, 'out.test.mjs'), 'export {}\n')
  writeFileSync(join(root, 'fixture.mjs'), 'original bytes\n')
  writeFileSync(join(root, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', run_id: runId, at: new Date(Date.now() - 500).toISOString() })}\n`)
  writeFileSync(join(returns, 'd1.planner.json'), JSON.stringify({
    assignment_id: 'd1', role: 'planner', status: 'done', details: {
      files_in_scope: scope, validation_lane: lane, gate_cmd: gate,
    },
  }))
  return { root, taskDir, returns, runId }
}

function event(toolName, path, { isError = false, text = 'original result' } = {}) {
  return {
    type: 'tool_result', toolCallId: `${toolName}-${path}`, toolName,
    input: { path }, isError, content: [{ type: 'text', text }],
  }
}

function loopFor(f, { role = 'builder', context = null, runner = null, deps = {} } = {}) {
  const current = context || { files_in_scope: ['fixture.mjs', 'in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' }
  return mod.createBuilderLoop({
    env: { CREW_ROLE: role, CREW_TASK_DIR: f.taskDir }, cwd: f.root,
    deps: {
      loadPlannerContext: () => current,
      ...(runner ? { runNodeTests: runner } : {}),
      ...deps,
    },
  })
}

function appendedText(result) {
  return result?.content?.at(-1)?.text || ''
}

function rows(f) {
  const path = join(f.root, 'journal.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// BL1: one successful lane result is appended to both supported mutating tools,
// while the original content remains the first part of each result.
test('BL1', async () => {
  const f = fixture()
  const calls = []
  const loop = loopFor(f, {
    runner: async (command) => {
      calls.push(command)
      return { code: 0, signal: null, tail: '1 passing\n' }
    },
  })
  const edit = await loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root })
  const write = await loop.onToolResult(event('write', join(f.root, 'fixture.mjs')), { cwd: f.root })
  assert.equal(calls.length, 2)
  for (const result of [edit, write]) {
    assert.ok(result)
    assert.equal(result.content[0].text, 'original result')
    assert.match(appendedText(result), /Builder fenced Node lane PASS/)
    assert.match(appendedText(result), /1 passing/)
  }
  assert.equal(readFileSync(join(f.root, 'fixture.mjs'), 'utf8'), 'original bytes\n')
})

// BL2: every ineligible result is returned as no patch. The fixture digest is
// checked around the calls because byte identity, rather than a rewritten
// equivalent object, is the contract for this guard.
test('BL2', async () => {
  const f = fixture()
  const before = readFileSync(join(f.root, 'fixture.mjs'))
  let runnerCalls = 0
  const loop = loopFor(f, {
    runner: async () => { runnerCalls += 1; return { code: 0, signal: null, tail: 'must not run' } },
  })
  const cases = [
    event('edit', join(f.root, 'out-of-fence.mjs')),
    event('edit', join(f.root, 'fixture.mjs'), { isError: true }),
    event('read', join(f.root, 'fixture.mjs')),
    event('edit', join(f.root, '..', 'outside.mjs')),
    event('edit', join(f.root, 'missing', 'fixture.mjs')),
  ]
  for (const input of cases) assert.equal(await loop.onToolResult(input, { cwd: f.root }), undefined)
  const otherRole = loopFor(f, { role: 'reviewer', runner: async () => { runnerCalls += 1; return { code: 0, signal: null, tail: '' } } })
  assert.equal(await otherRole.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root }), undefined)
  assert.equal(runnerCalls, 0)
  assert.deepEqual(readFileSync(join(f.root, 'fixture.mjs')), before)
})

// BL3: only the literal Node lane is admitted. The out-of-fence operand is
// intersected away, while gate, suite, and visualizer commands are not lanes.
test('BL3', async () => {
  const f = fixture({
    lane: 'node --test in.test.mjs out.test.mjs in.test.mjs',
    scope: ['in.test.mjs'],
    gate: 'node task/gate.mjs',
  })
  const calls = []
  const current = { files_in_scope: ['fixture.mjs', 'in.test.mjs'], validation_lane: 'node --test in.test.mjs out.test.mjs in.test.mjs', gate_cmd: 'node task/gate.mjs' }
  const loop = loopFor(f, { context: current, runner: async (command) => { calls.push(command); return { code: 0, signal: null, tail: '' } } })
  await loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root })
  assert.deepEqual(calls, [{ bin: process.execPath, args: ['--test', 'in.test.mjs'] }])
  for (const lane of ['npm test', 'npm run viz:build', 'node task/gate.mjs', 'node --test --test-reporter=tap in.test.mjs', 'node --test ../out.test.mjs']) {
    calls.length = 0
    const gated = loopFor(f, { context: { ...current, validation_lane: lane }, runner: async (command) => { calls.push(command); return { code: 0, signal: null, tail: '' } } })
    assert.equal(await gated.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root }), undefined)
    assert.equal(calls.length, 0, lane)
  }
  assert.equal(mod.fencedNodeTestCommand({ files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs && npm test' }), null)
  assert.equal(mod.fencedNodeTestCommand({ files_in_scope: ['in.test.mjs'], validation_lane: 'node --test /absolute/in.test.mjs' }), null)
})

// BL4: the result tail is the useful part of a failure. A late sentinel survives
// the bounded runner output and the appended part labels the nonzero exit FAIL.
test('BL4', async () => {
  const f = fixture()
  const sentinel = 'LATE_FAILURE_SENTINEL'
  const loop = loopFor(f, {
    runner: async () => ({ code: 1, signal: null, tail: `${'x'.repeat(4096)}${sentinel}` }),
  })
  const result = await loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root })
  const text = appendedText(result)
  assert.match(text, /Builder fenced Node lane FAIL/)
  assert.match(text, new RegExp(sentinel))
})

// BL5: failures in the injected runner are swallowed by the result hook, so a
// tool result that failed to obtain a lane remains unchanged.
test('BL5', async () => {
  const f = fixture()
  for (const runner of [
    async () => { throw new Error('runner crash') },
    async () => { throw Object.assign(new Error('runner timeout'), { reason: 'timeout' }) },
  ]) {
    const loop = loopFor(f, { runner })
    await assert.doesNotReject(async () => {
      assert.equal(await loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root }), undefined)
    })
  }
})

// BL6: crash and timeout rows are distinct durable observations, while a broken
// journal sink is subordinate to the original tool result.
test('BL6', async () => {
  const f = fixture()
  const reasons = ['crash', 'timeout']
  for (const reason of reasons) {
    const loop = loopFor(f, {
      runner: async () => { throw Object.assign(new Error(reason), { reason }) },
    })
    assert.equal(await loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root }), undefined)
  }
  const failures = rows(f).filter((row) => row.builder_loop_failure)
  assert.deepEqual(failures.map((row) => row.builder_loop_failure.reason), reasons)
  const throwing = loopFor(f, {
    runner: async () => { throw Object.assign(new Error('crash'), { reason: 'crash' }) },
    deps: { appendFile: () => { throw new Error('journal is unavailable') } },
  })
  await assert.doesNotReject(async () => {
    assert.equal(await throwing.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root }), undefined)
  })
})

test('planner context is lazy, current-run only, and requires a done planner envelope', async () => {
  const f = fixture()
  const planner = join(f.returns, 'd1.planner.json')
  const journal = join(f.root, 'journal.jsonl')
  const first = mod.loadPlannerContext({ taskDir: f.taskDir })
  assert.deepEqual(first, { files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' })
  writeFileSync(planner, JSON.stringify({ role: 'planner', status: 'working', details: { files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' } }))
  assert.equal(mod.loadPlannerContext({ taskDir: f.taskDir }), null)
  writeFileSync(planner, JSON.stringify({ role: 'planner', status: 'done', details: { files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' } }))
  writeFileSync(journal, `${JSON.stringify({ event: 'run-start', run_id: f.runId, at: new Date(Date.now() + 10).toISOString() })}\n`)
  assert.equal(mod.loadPlannerContext({ taskDir: f.taskDir }), null)
  writeFileSync(journal, `${JSON.stringify({ event: 'run-start', run_id: f.runId, at: new Date(Date.now() - 500).toISOString() })}\n`)
  assert.deepEqual(mod.loadPlannerContext({ taskDir: f.taskDir }), { files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' })
})

test('RV1-1 reads oversized journals from the tail and bounded head fallback', () => {
  const f = fixture()
  const journal = join(f.root, 'journal.jsonl')
  const start = JSON.stringify({ event: 'run-start', run_id: f.runId, at: new Date(Date.now() - 60_000).toISOString() })
  const noise = `${JSON.stringify({ event: 'noise', payload: 'x'.repeat(70_000) })}\n`
  const expected = { files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' }

  writeFileSync(journal, `${noise}${start}\n`)
  assert.deepEqual(mod.loadPlannerContext({ taskDir: f.taskDir }), expected)

  writeFileSync(journal, `${start}\n${noise}`)
  assert.deepEqual(mod.loadPlannerContext({ taskDir: f.taskDir }), expected)

  writeFileSync(journal, noise)
  assert.equal(mod.loadPlannerContext({ taskDir: f.taskDir }), null)
})

test('RV2-1 walks bounded journal windows to honor the last run-start', () => {
  const f = fixture()
  const journal = join(f.root, 'journal.jsonl')
  const now = Date.now()
  const oldRun = new Date(now - 2 * 60 * 60_000)
  const newRun = new Date(now - 10 * 60_000)
  // Two RUNS, not two envelopes in one run: the stale plan sits in the OLD run's directory with
  // the higher assignment number, so a reader that honours the last run-start's timestamp but
  // keeps the first run's id (Sol, #1399) would find and return it.
  const oldReturns = join(f.root, 'returns', 'run-old')
  mkdirSync(oldReturns, { recursive: true })
  const staleReturn = join(oldReturns, 'd3.planner.json')
  const freshReturn = join(f.returns, 'd1.planner.json')
  const filler = `${JSON.stringify({ event: 'noise', payload: 'x'.repeat(70_000) })}\n`
  const stale = { role: 'planner', status: 'done', details: { files_in_scope: ['stale.test.mjs'], validation_lane: 'node --test stale.test.mjs', gate_cmd: 'node task/gate.mjs' } }
  const fresh = { role: 'planner', status: 'done', details: { files_in_scope: ['fresh.test.mjs'], validation_lane: 'node --test fresh.test.mjs', gate_cmd: 'node task/gate.mjs' } }

  writeFileSync(journal, `${JSON.stringify({ event: 'run-start', run_id: 'run-old', at: oldRun.toISOString() })}\n${filler}${JSON.stringify({ event: 'run-start', run_id: f.runId, at: newRun.toISOString() })}\n${filler}`)
  writeFileSync(staleReturn, JSON.stringify(stale))
  writeFileSync(freshReturn, JSON.stringify(fresh))
  utimesSync(staleReturn, new Date(now - 60 * 60_000), new Date(now - 60 * 60_000))
  utimesSync(freshReturn, new Date(now - 5 * 60_000), new Date(now - 5 * 60_000))

  assert.deepEqual(mod.loadPlannerContext({ taskDir: f.taskDir }), fresh.details)
  assert.deepEqual(mod.loadPlannerContext({ taskDir: f.taskDir, deps: { readFile: readFileSync } }), fresh.details)
})

// Sol on #1399: RV2-1's first run-start sits outside the tail window, so a reader that keeps
// the FIRST run's id while honouring the last timestamp passed it. Here both rows share one
// window and the stale plan's mtime is fresh, so only the run id can tell the runs apart.
test('two run-starts in one window: the LAST run\'s id names the returns directory, not the first\'s', () => {
  const f = fixture()
  const now = Date.now()
  const oldReturns = join(f.root, 'returns', 'run-old')
  mkdirSync(oldReturns, { recursive: true })
  const stale = { role: 'planner', status: 'done', details: { files_in_scope: ['stale.test.mjs'], validation_lane: 'node --test stale.test.mjs', gate_cmd: 'node task/gate.mjs' } }
  const fresh = { role: 'planner', status: 'done', details: { files_in_scope: ['fresh.test.mjs'], validation_lane: 'node --test fresh.test.mjs', gate_cmd: 'node task/gate.mjs' } }
  writeFileSync(join(oldReturns, 'd3.planner.json'), JSON.stringify(stale))
  writeFileSync(join(f.returns, 'd1.planner.json'), JSON.stringify(fresh))
  writeFileSync(join(f.root, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', run_id: 'run-old', at: new Date(now - 60 * 60_000).toISOString() })}\n${JSON.stringify({ event: 'run-start', run_id: f.runId, at: new Date(now - 10 * 60_000).toISOString() })}\n`)
  assert.deepEqual(mod.loadPlannerContext({ taskDir: f.taskDir }), fresh.details)
})

// Sol on #1399: `.` and `..` pass a character-class check; the first reads returns/ itself
// (the flat layout again), the second escapes to the crew root. Neither names a run.
test('a run id of "." or ".." names no returns directory', () => {
  for (const runId of ['.', '..']) {
    const f = fixture()
    writeFileSync(join(f.root, 'returns', 'd9.planner.json'), JSON.stringify({ assignment_id: 'd9', role: 'planner', status: 'done', details: { files_in_scope: ['flat.mjs'], validation_lane: 'node --test flat.test.mjs', gate_cmd: 'node task/gate.mjs' } }))
    writeFileSync(join(f.root, 'journal.jsonl', ), `${JSON.stringify({ event: 'run-start', run_id: runId, at: new Date(Date.now() - 500).toISOString() })}\n`)
    assert.equal(mod.loadPlannerContext({ taskDir: f.taskDir }), null, runId)
  }
})

test('the production runner bounds the combined stdout/stderr tail', async () => {
  const childSource = `process.stdout.write('o'.repeat(10000)); process.stderr.write('e'.repeat(10000) + 'TAIL_SENTINEL');`
  const result = await mod.runNodeTests({ bin: process.execPath, args: ['-e', childSource] }, { cwd: process.cwd(), deadlineMs: 5000 })
  assert.ok(Buffer.byteLength(result.tail, 'utf8') <= 4096)
  assert.match(result.tail, /TAIL_SENTINEL/)
  assert.equal(result.code, 0)
})

test('abort interrupts a production runner and records no lane patch', async () => {
  const f = fixture()
  const abortWorker = join(f.root, 'abort.test.mjs')
  writeFileSync(abortWorker, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n")
  const abortRel = relative(f.root, abortWorker).replaceAll('\\', '/')
  const controller = new AbortController()
  let captured
  const loop = loopFor(f, {
    context: { files_in_scope: ['fixture.mjs', abortRel], validation_lane: `node --test ${abortRel}`, gate_cmd: 'node task/gate.mjs' },
    deps: {
      runnerDeps: {
        spawn: (...args) => {
          captured = realSpawn(...args)
          return captured
        },
        deadlineMs: 5000, graceMs: 20, pollMs: 5,
      },
    },
  })
  const pending = loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root, signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 30))
  controller.abort()
  assert.equal(await pending, undefined)
  assert.ok(captured?.pid)
  assert.equal(rows(f).at(-1)?.builder_loop_failure?.reason, 'interrupted')
})

test('a real short timeout removes the detached process group, not merely its parent', async () => {
  const f = fixture()
  const workerDir = scratchDir('builder-worker-', { parent: f.root })
  const worker = join(workerDir, 'hang.test.mjs')
  writeFileSync(worker, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n")
  const workerRel = relative(f.root, worker).replaceAll('\\', '/')
  const current = { files_in_scope: ['fixture.mjs', workerRel], validation_lane: `node --test ${workerRel}`, gate_cmd: 'node task/gate.mjs' }
  let capturedPid = null
  const loop = loopFor(f, {
    context: current,
    deps: {
      runnerDeps: {
        spawn: (...args) => {
          const child = realSpawn(...args)
          capturedPid = child.pid
          return child
        },
        deadlineMs: 40, graceMs: 30, pollMs: 5, pollMax: 100,
      },
    },
  })
  assert.equal(await loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root }), undefined)
  assert.equal(rows(f).at(-1)?.builder_loop_failure?.reason, 'timeout')
  assert.ok(capturedPid)
  assert.throws(() => process.kill(-capturedPid, 0), (error) => error?.code === 'ESRCH')
})

function bashCall(loop, command, cwd, toolName = 'bash') {
  return loop.onToolCall({ type: 'tool_call', toolCallId: `bash-${command}`, toolName, input: { command } }, { cwd })
}

test('tool_call refuses an unchanged repeated lane and preserves decoded word equality', () => {
  const f = fixture()
  const loop = loopFor(f, { deps: { measureTree: () => ({ measured: true, digest: 'same' }) } })
  assert.equal(bashCall(loop, 'node --test in.test.mjs', f.root), undefined)
  const blocked = bashCall(loop, 'node --test in.test.mjs', f.root)
  assert.equal(blocked?.block, true)
  assert.match(blocked.reason, /builder-rerun-refusal: rerun of node --test in.test.mjs/)
  const refusal = rows(f).at(-1)?.builder_loop_refusal
  assert.equal(refusal.rule, 'builder-rerun-refusal')
  assert.deepEqual(refusal.command, ['node', '--test', 'in.test.mjs'])
})

test('tool_call quoting changes are compared as decoded words', () => {
  const f = fixture({ lane: 'node --test --test-name-pattern="foo bar" in.test.mjs' })
  const loop = loopFor(f, { deps: { measureTree: () => ({ measured: true, digest: 'same' }) } })
  assert.equal(bashCall(loop, 'node --test --test-name-pattern="foo bar" in.test.mjs', f.root), undefined)
  assert.equal(bashCall(loop, "node --test --test-name-pattern='foo bar' in.test.mjs", f.root)?.block, true)
  assert.equal(bashCall(loop, 'node --test --test-name-pattern="foo  bar" in.test.mjs', f.root), undefined)
})

test('tool_call admits a changed tree regardless of prior writer', () => {
  const f = fixture()
  const digests = ['first', 'second']
  const loop = loopFor(f, { deps: { measureTree: () => ({ measured: true, digest: digests.shift() }) } })
  assert.equal(bashCall(loop, 'node --test in.test.mjs', f.root), undefined)
  assert.equal(bashCall(loop, 'node --test in.test.mjs', f.root, 'bash'), undefined)
})

test('tool_call records unmeasured trees and never blocks', () => {
  const f = fixture()
  const loop = loopFor(f, { deps: { measureTree: () => ({ measured: false, cause: 'not-a-repository' }) } })
  assert.equal(bashCall(loop, 'node --test in.test.mjs', f.root), undefined)
  assert.equal(bashCall(loop, 'node --test in.test.mjs', f.root), undefined)
  assert.equal(rows(f).at(-1)?.builder_loop_unmeasured?.cause, 'not-a-repository')
})

test('tool_call swallows seam failures while a broken journal cannot lose a refusal', () => {
  const f = fixture()
  const loadFailure = loopFor(f, { deps: { loadPlannerContext: () => { throw new Error('load') } } })
  assert.equal(bashCall(loadFailure, 'node --test in.test.mjs', f.root), undefined)
  const measureFailure = loopFor(f, { deps: { measureTree: () => { throw new Error('measure') } } })
  assert.equal(bashCall(measureFailure, 'node --test in.test.mjs', f.root), undefined)
  const broken = loopFor(f, { deps: { measureTree: () => ({ measured: true, digest: 'same' }), appendFile: () => { throw new Error('sink') } } })
  assert.equal(bashCall(broken, 'node --test in.test.mjs', f.root), undefined)
  assert.equal(bashCall(broken, 'node --test in.test.mjs', f.root)?.block, true)
})

test('attachBuilderLoop registers both tool hooks', () => {
  const hooks = new Map()
  const pi = { on(name, handler) { hooks.set(name, handler) } }
  const f = fixture()
  const loop = mod.attachBuilderLoop(pi, { env: { CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir }, cwd: f.root, deps: { loadPlannerContext: () => ({ files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' }), measureTree: () => ({ measured: true, digest: 'same' }) } })
  assert.equal(loop.onToolCall({ type: 'tool_call', toolName: 'read', input: { command: 'echo' } }, { cwd: f.root }), undefined)
  assert.deepEqual([...hooks.keys()].sort(), ['tool_call', 'tool_result'])
})

test('default tree measurement uses real git when available', (t) => {
  const root = scratchDir('builder-loop-git-')
  const init = realSpawnSync('git', ['init'], { cwd: root, encoding: 'utf8' })
  if (init.error || init.status !== 0) return t.skip(`git unavailable: ${init.error?.message || init.stderr || 'git init failed'}`)
  writeFileSync(join(root, 'in.test.mjs'), 'export {}\\n')
  realSpawnSync('git', ['add', '--', 'in.test.mjs'], { cwd: root })
  const commit = realSpawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-m', 'fixture'], { cwd: root, encoding: 'utf8' })
  if (commit.error || commit.status !== 0) return t.skip(`git commit unavailable: ${commit.error?.message || commit.stderr || 'commit failed'}`)
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
  const loop = mod.createBuilderLoop({ env: { CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir }, cwd: root, deps: { loadPlannerContext: () => ({ files_in_scope: ['in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' }) } })
  assert.equal(bashCall(loop, 'node --test in.test.mjs', root), undefined)
  assert.equal(bashCall(loop, 'node --test in.test.mjs', root)?.block, true)
})

// Keep the source-level extension contract explicit: no pi or package imports,
// no erasable-syntax violations, and exactly the small exported seam.
test('builderloop is zero-dependency, erasable, and exposes only its test seam', () => {
  const source = readFileSync(new URL('./builderloop.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')), imports.join(', '))
  assert.doesNotMatch(source, /^\s*(enum|namespace)\s/m)
  assert.deepEqual(Object.keys(mod).sort(), ['attachBuilderLoop', 'createBuilderLoop', 'default', 'fencedNodeTestCommand', 'loadPlannerContext', 'runNodeTests'].sort())
})

// 2fac235d moved returns under returns/<run_id>/ and this hook kept scanning returns/ — inert for
// five days, and every builder ran its own tests instead. These pin the contract that failed.
test('a planner return in the pre-09-13 flat layout is NOT read: only returns/<run_id>/ is the driver\'s authority', () => {
  const f = fixture()
  writeFileSync(join(f.root, 'returns', 'd9.planner.json'), JSON.stringify({ assignment_id: 'd9', role: 'planner', status: 'done', details: { files_in_scope: ['other.mjs'], validation_lane: 'node --test other.test.mjs' } }))
  const seen = mod.loadPlannerContext({ taskDir: f.taskDir })
  assert.ok(seen, 'the run-scoped d1 return is found')
  assert.notDeepEqual(seen.files_in_scope, ['other.mjs'], 'the flat d9 (a higher number) must not win: it is not in the run directory')
})

test('a run-start that carries no run_id names no returns directory, so the hook stays inert rather than guessing', () => {
  const f = fixture()
  writeFileSync(join(f.root, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: new Date(Date.now() - 500).toISOString() })}\n`)
  // A complete, valid flat envelope: the pre-fix scanner of returns/ itself would read THIS.
  writeFileSync(join(f.root, 'returns', 'd1.planner.json'), JSON.stringify({ assignment_id: 'd1', role: 'planner', status: 'done', details: { files_in_scope: ['flat.mjs'], validation_lane: 'node --test flat.test.mjs', gate_cmd: 'node task/gate.mjs' } }))
  assert.equal(mod.loadPlannerContext({ taskDir: f.taskDir }), null)
})
