import { test } from 'node:test'
import { createHash } from 'node:crypto'
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

function loopFor(f, { role = 'builder', context = null, runner = null, deps = {}, assist } = {}) {
  const current = context || { files_in_scope: ['fixture.mjs', 'in.test.mjs'], validation_lane: 'node --test in.test.mjs', gate_cmd: 'node task/gate.mjs' }
  return mod.createBuilderLoop({
    env: { CREW_ROLE: role, CREW_TASK_DIR: f.taskDir, ...(assist === undefined ? {} : { CREW_EDIT_ASSIST: assist }) }, cwd: f.root,
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

const recordedFrames = readFileSync(new URL('./builderloop-edit-frames.jsonl', import.meta.url), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
function recordedEvent(startIndex, endIndex) {
  const start = recordedFrames[startIndex], end = recordedFrames[endIndex]
  assert.equal(start.toolCallId, end.toolCallId)
  return { toolName: start.toolName, toolCallId: start.toolCallId, input: start.args, content: end.result.content, isError: end.isError }
}
function failedFixture({ text = '', assist, role = 'builder', editsIndex = 0, error = true, deps = {} } = {}) {
  const f = fixture()
  const start = editsIndex === 1 ? 0 : 2
  const end = start + 1
  const evt = recordedEvent(start, end)
  const input = { ...evt.input, edits: evt.input.edits.map((edit) => ({ ...edit })) }
  const loop = loopFor(f, { role, assist, deps: {
    stat: () => ({ size: Buffer.byteLength(text) }), readFile: () => text,
    ...deps,
  } })
  return { f, loop, event: { ...evt, input, isError: error }, text }
}
function failureRows(f) { return rows(f).filter((row) => row.builder_edit_failure).map((row) => row.builder_edit_failure) }
function assignment(id) { return { prompt: `ASSIGNMENT ${id}: continue\nbody` } }

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
  assert.deepEqual([...hooks.keys()].sort(), ['before_agent_start', 'tool_call', 'tool_result'])
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
  assert.deepEqual(Object.keys(mod).sort(), ['attachBuilderLoop', 'createBuilderLoop', 'default', 'EDIT_ASSIST_ENV', 'EDIT_FAILURE_CAUSES', 'EDIT_FAILURE_ABSENT_REASONS', 'EDIT_FILE_CAP_BYTES', 'EDIT_CORPUS_CAP_BYTES', 'EDIT_HINT_CAP_BYTES', 'fencedNodeTestCommand', 'loadPlannerContext', 'runNodeTests'].sort())
})

test('E1', () => {
  assert.deepEqual(mod.EDIT_FAILURE_CAUSES, ['not-unique', 'indentation', 'never-seen', 'partly-seen', 'seen-stale', 'other'])
  assert.equal(Object.isFrozen(mod.EDIT_FAILURE_CAUSES), true)
})
test('K1', async () => {
  const { f, loop, event: evt } = failedFixture({ text: 'x\n'.repeat(8), editsIndex: 0 })
  await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(failureRows(f)[0].cause, 'not-unique')
  assert.equal(failureRows(f)[0].edit_index, 0)
})
test('K2', async () => {
  const base = recordedEvent(0, 1).input.edits[1].oldText
  const text = base.split('\n').map((line) => `  ${line}`).join('\n')
  const { f, loop, event: evt } = failedFixture({ text, editsIndex: 1 })
  await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(failureRows(f)[0].cause, 'indentation')
})
test('K3', async () => {
  const old = recordedEvent(0, 1).input.edits[1].oldText
  const { f, loop, event: evt } = failedFixture({ text: 'unrelated', editsIndex: 1 })
  await loop.onToolResult({ toolName: 'read', content: [{ type: 'text', text: old }], isError: false })
  await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(failureRows(f)[0].cause, 'seen-stale')
})
test('K4', async () => {
  const old = recordedEvent(0, 1).input.edits[1].oldText
  const longest = old.split('\n').map((line) => line.trimStart()).sort((a, b) => b.length - a.length)[0]
  assert.equal(longest.includes(old), false)
  const { f, loop, event: evt } = failedFixture({ text: 'unrelated', editsIndex: 1 })
  await loop.onToolResult({ toolName: 'read', content: [{ type: 'text', text: longest }], isError: false })
  await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(failureRows(f)[0].cause, 'partly-seen')
})
test('K5', async () => {
  const old = recordedEvent(0, 1).input.edits[1].oldText
  const { f, loop, event: evt } = failedFixture({ text: 'unrelated', editsIndex: 1 })
  loop.onBeforeAgentStart(assignment('same'))
  await loop.onToolResult({ toolName: 'read', content: [{ type: 'text', text: old }], isError: false })
  loop.onBeforeAgentStart(assignment('same'))
  loop.onBeforeAgentStart(assignment('same'))
  await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(failureRows(f)[0].cause, 'seen-stale')
  loop.onBeforeAgentStart(assignment('new'))
  await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(failureRows(f)[1].cause, 'never-seen')
})
test('O1', async () => {
  const old = recordedEvent(2, 3).input.edits[0].oldText
  const { f, loop, event: evt } = failedFixture({ text: `${old}\n${old}` })
  assert.equal(await loop.onToolResult(evt, { cwd: f.root }), undefined)
  assert.equal(failureRows(f)[0].assist, 'off')
})
test('J1', async () => {
  const { f, loop, event: evt } = failedFixture({ text: 'x' })
  await loop.onToolResult(evt, { cwd: f.root }); await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(failureRows(f).length, 2)
})
test('D1', async () => {
  const old = recordedEvent(2, 3).input.edits[0].oldText
  const first = `      ${old}`, second = `      if (decline) ${old}`
  const text = `head\n${first}\nbetween\n${second}\ntail`
  const { f, loop, event: evt } = failedFixture({ text, assist: 'on' })
  const result = await loop.onToolResult(evt, { cwd: f.root })
  assert.match(appendedText(result), /2:/); assert.match(appendedText(result), /4:/)
  assert.ok(appendedText(result).includes(first))
  assert.ok(appendedText(result).includes(second))
})
test('D2', async () => {
  const old = 'function a() {\n  return compute(x)\n}'
  const { f, loop, event: evt } = failedFixture({ text: `function b() {\n  return compute(x)\nnot-b\nnoise\nnoise\nfunction a() {\n  return compute(x)\nnot-a-brace`, editsIndex: 1, assist: 'on' })
  evt.input.edits[1].oldText = old
  const result = await loop.onToolResult(evt, { cwd: f.root })
  assert.match(appendedText(result), /6: function a\(\) \{/)
  assert.doesNotMatch(appendedText(result), /1: function b\(\) \{/)
  const absent = failedFixture({ text: 'nothing here', editsIndex: 1, assist: 'on' })
  absent.event.input.edits[1].oldText = 'a()\n\nb()'
  assert.equal(appendedText(await absent.loop.onToolResult(absent.event, { cwd: absent.f.root })), 'none of the oldText lines occur in crew/drive.mjs')
})
test('D3', async () => {
  const old = recordedEvent(0, 1).input.edits[1].oldText
  const text = old.split('\n').map((line) => `  ${line}`).join('\n')
  const { f, loop, event: evt } = failedFixture({ text, editsIndex: 1, assist: 'on' })
  const before = structuredClone(evt.input)
  const result = await loop.onToolResult(evt, { cwd: f.root })
  assert.equal(appendedText(result), text.split('\n').map((line, k) => `${k + 1}: ${line}`).join('\n')); assert.deepEqual(evt.input, before)
})

test('EA1', async () => {
  const evt = recordedEvent(6, 7)
  const input = structuredClone(evt.input)
  const old = input.edits[0].oldText
  const f = fixture()
  const loop = loopFor(f, { deps: { stat: () => ({ size: 1000 }), readFile: () => `head\n${old}\nbetween\n${old}\ntail` } })
  await loop.onToolResult({ ...evt, input }, { cwd: f.root })
  assert.deepEqual(failureRows(f)[0] && [failureRows(f)[0].cause, failureRows(f)[0].edit_index], ['not-unique', 0])
})

test('EA2', async () => {
  const evt = recordedEvent(4, 5)
  const input = structuredClone(evt.input)
  const f = fixture()
  let stats = 0, reads = 0, text = 'unrelated'
  const loop = loopFor(f, { deps: { stat: () => { stats++; return { size: 100 } }, readFile: () => { reads++; return text } } })
  await loop.onToolResult({ ...evt, input }, { cwd: f.root })
  assert.deepEqual([failureRows(f)[0].cause, failureRows(f)[0].edit_index], ['never-seen', 0])
  assert.deepEqual([stats, reads], [1, 1])
  for (const frames of [[4, 5], [6, 7]]) for (const count of [0, 2]) {
    const other = recordedEvent(...frames), changed = structuredClone(other.input)
    changed.edits = count === 0 ? [] : [...changed.edits, structuredClone(changed.edits[0])]
    const probe = fixture(); let calls = 0
    const guarded = loopFor(probe, { deps: { stat: () => { calls++; return { size: 1 } }, readFile: () => { calls++; return 'x' } } })
    assert.equal(await guarded.onToolResult({ ...other, input: changed }, { cwd: probe.root }), undefined)
    assert.deepEqual([failureRows(probe)[0].cause, failureRows(probe)[0].edit_index], ['other', null]); assert.equal(calls, 0)
  }
  const old = input.edits[0].oldText
  const check = async (overrideText, deps, expected) => {
    const probe = fixture(), helper = loopFor(probe, { deps: { stat: () => ({ size: 100 }), readFile: () => overrideText, ...deps } })
    await helper.onToolResult({ ...evt, input: structuredClone(evt.input) }, { cwd: probe.root })
    const row = failureRows(probe)[0]; assert.deepEqual([row.cause, row.cause_absent_reason, row.edit_index], expected)
  }
  await check(old.split('\n').map(line => `  ${line}`).join('\n'), {}, ['indentation', null, 0])
  const stale = fixture(), staleLoop = loopFor(stale, { deps: { stat: () => ({ size: 100 }), readFile: () => 'unrelated' } })
  await staleLoop.onToolResult({ toolName: 'read', content: [{ type: 'text', text: old }], isError: false })
  await staleLoop.onToolResult({ ...evt, input: structuredClone(evt.input) }, { cwd: stale.root })
  assert.deepEqual([failureRows(stale)[0].cause, failureRows(stale)[0].edit_index], ['seen-stale', 0])
  await check('x', { stat: () => { throw Error('denied') } }, [null, 'file-unreadable', 0])
  await check('x', { stat: () => ({ size: mod.EDIT_FILE_CAP_BYTES + 1 }) }, [null, 'file-too-large', 0])
  await check('x'.repeat(mod.EDIT_FILE_CAP_BYTES + 1), { stat: () => ({ size: 1 }) }, [null, 'file-too-large', 0])
  await check('x', { readFile: () => { throw Error('denied') } }, [null, 'file-unreadable', 0])
})

test('EA3', async () => {
  const duplicate = recordedEvent(6, 7), notFound = recordedEvent(4, 5)
  const duplicateInput = structuredClone(duplicate.input), missingInput = structuredClone(notFound.input)
  const old = duplicateInput.edits[0].oldText
  const [first, second] = old.split('\n')
  const f = fixture(), loop = loopFor(f, { assist: 'on', deps: { stat: () => ({ size: 10000 }), readFile: () => `head\n${old}\nbetween\n${old}\ntail` } })
  const result = await loop.onToolResult({ ...duplicate, input: duplicateInput }, { cwd: f.root })
  assert.equal(appendedText(result), ['1: head', `2: ${first}`, `3: ${second}`, '4: between', `5: ${first}`, '---', `3: ${second}`, '4: between', `5: ${first}`, `6: ${second}`, '7: tail'].join('\n'))
  assert.equal(result.content[0].text, duplicate.content[0].text); assert.deepEqual(duplicateInput, duplicate.input)
  const g = fixture(), missingLoop = loopFor(g, { assist: 'on', deps: { stat: () => ({ size: 100 }), readFile: () => 'unrelated' } })
  const missingResult = await missingLoop.onToolResult({ ...notFound, input: missingInput }, { cwd: g.root })
  assert.equal(appendedText(missingResult), 'none of the oldText lines occur in crew/drive-build.test.mjs')
  assert.equal(missingResult.content[0].text, notFound.content[0].text); assert.deepEqual(missingInput, notFound.input)
})

test('EA4', async () => {
  const evt = recordedEvent(4, 5), input = structuredClone(evt.input), f = fixture()
  const loop = loopFor(f, { deps: { stat: () => ({ size: 100 }), readFile: () => 'unrelated' } })
  assert.equal(await loop.onToolResult({ ...evt, input }, { cwd: f.root }), undefined)
  assert.deepEqual([failureRows(f)[0].cause, failureRows(f)[0].assist, failureRows(f)[0].edit_index], ['never-seen', 'off', 0])
})

test('EA5', () => {
  const firstFour = readFileSync(new URL('./builderloop-edit-frames.jsonl', import.meta.url), 'utf8').split('\n').slice(0, 4).join('\n')
  assert.equal(createHash('sha256').update(firstFour).digest('hex'), '04bb6654791ca5913bf412820c8b7b36c6b5e081a58b25d0eaf52fcb252f348c')
  assert.equal(recordedFrames.length, 8)
  for (const [start, end, phrase] of [[4, 5, 'Could not find the exact text'], [6, 7, 'Found 2 occurrences of the text']]) {
    assert.equal(recordedFrames[start].toolCallId, recordedFrames[end].toolCallId)
    assert.equal(recordedFrames[start].args.edits.length, 1)
    assert.match(recordedFrames[end].result.content[0].text, new RegExp(phrase))
  }
})
test('B1', async () => {
  const old = recordedEvent(2, 3).input.edits[0].oldText
  const text = Array(50).fill(old).join('\n')
  const { f, loop, event: evt } = failedFixture({ text, assist: 'on' })
  const result = await loop.onToolResult(evt, { cwd: f.root })
  assert.ok(Buffer.byteLength(appendedText(result)) <= mod.EDIT_HINT_CAP_BYTES)
})
// Kills: occurrenceHint's `size <= EDIT_HINT_CAP_BYTES` loop bound replaced by an unbounded scan.
// A one-character oldText in one 24,000-character line is 24,000 occurrences whose blocks together
// exceed V8's string limit, so the hook threw RangeError instead of returning a bounded hint.
test('RV2-1 a short oldText in a large file yields a bounded hint instead of throwing', async () => {
  const text = 'x'.repeat(24000)
  const { f, loop, event: evt } = failedFixture({ text, assist: 'on' })
  evt.input.edits[0].oldText = 'x'
  const result = await loop.onToolResult(evt, { cwd: f.root })
  const hint = appendedText(result)
  assert.match(hint, /^1: x/)
  assert.ok(Buffer.byteLength(hint) <= mod.EDIT_HINT_CAP_BYTES)
})
test('N1', async () => {
  const { f, loop, event: evt } = failedFixture({ text: 'x' })
  const reviewer = loopFor(f, { role: 'reviewer' })
  assert.equal(await reviewer.onToolResult(evt, { cwd: f.root }), undefined)
  assert.equal(await loop.onToolResult({ ...evt, isError: false }, { cwd: f.root }), undefined)
  assert.equal(failureRows(f).length, 0)
})
test('RV1-1', async () => {
  const old = recordedEvent(2, 3).input.edits[0].oldText
  const first = `      ${old}`, second = `      if (decline) ${old}`
  const text = `head\n${first}\nbetween\n${second}\ntail`
  const { f, loop, event: evt } = failedFixture({ text, assist: 'on' })
  const result = await loop.onToolResult(evt, { cwd: f.root })
  const hint = appendedText(result)
  assert.ok(hint.includes('2:       ' + old))
  assert.ok(hint.includes('4:       if (decline) ' + old))
})
test('RV1-2', async () => {
  const old = recordedEvent(2, 3).input.edits[0].oldText
  const { f, loop, event: evt } = failedFixture({ text: `${old}\n${old}` })
  assert.equal(await loop.onToolResult(evt, { cwd: f.root }), undefined)
  assert.equal(failureRows(f)[0].assist, 'off')
})
test('RV1-6', async (t) => {
  const run = async ({ text = 'ordinary', deps = {}, mutate } = {}) => {
    const fixture = failedFixture({ text, assist: 'on', deps })
    if (mutate) mutate(fixture.event)
    const result = await fixture.loop.onToolResult(fixture.event, { cwd: fixture.f.root })
    return { row: failureRows(fixture.f)[0], result }
  }
  await t.test('stat size cap', async () => {
    const { row, result } = await run({ deps: { stat: () => ({ size: mod.EDIT_FILE_CAP_BYTES + 1 }) } })
    assert.equal(row.cause, null); assert.equal(row.cause_absent_reason, 'file-too-large'); assert.equal(result, undefined)
  })
  await t.test('post-read byte cap', async () => {
    const { row, result } = await run({ text: 'x'.repeat(mod.EDIT_FILE_CAP_BYTES + 1), deps: { stat: () => ({ size: 1 }) } })
    assert.equal(row.cause, null); assert.equal(row.cause_absent_reason, 'file-too-large'); assert.equal(result, undefined)
  })
  await t.test('stat throws', async () => {
    const { row, result } = await run({ deps: { stat: () => { throw Object.assign(Error('denied'), { code: 'EPERM' }) } } })
    assert.equal(row.cause, null); assert.equal(row.cause_absent_reason, 'file-unreadable'); assert.equal(result, undefined)
  })
  await t.test('escaping target', async () => {
    const { row, result } = await run({ mutate: (evt) => { evt.input.path = '../outside.mjs' } })
    assert.equal(row.cause, null); assert.equal(row.cause_absent_reason, 'file-unreadable'); assert.equal(result, undefined)
  })
  await t.test('unmatched message and invalid index', async () => {
    const unmatched = await run({ mutate: (evt) => { evt.content = [{ type: 'text', text: 'boom' }] } })
    assert.equal(unmatched.row.cause, 'other'); assert.equal(unmatched.row.edit_index, null); assert.equal(unmatched.result, undefined)
    const invalid = await run({ mutate: (evt) => { evt.content = [{ type: 'text', text: 'Could not find edits[9] in crew/drive.mjs.' }] } })
    assert.equal(invalid.row.cause, 'other'); assert.equal(invalid.row.edit_index, null); assert.equal(invalid.result, undefined)
  })
  await t.test('old corpus entries evict', async () => {
    const old = recordedEvent(0, 1).input.edits[1].oldText
    const fixture = failedFixture({ text: 'ordinary', editsIndex: 1 })
    await fixture.loop.onToolResult({ toolName: 'read', content: [{ type: 'text', text: old }], isError: false })
    await fixture.loop.onToolResult({ toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(mod.EDIT_CORPUS_CAP_BYTES + 1) }], isError: false })
    await fixture.loop.onToolResult(fixture.event, { cwd: fixture.f.root })
    assert.equal(failureRows(fixture.f)[0].cause, 'never-seen')
  })
})
test('T1', async () => {
  const { f, loop, event: evt } = failedFixture({ text: 'x', deps: { appendFile: () => { throw Error('EPERM') } } })
  const before = structuredClone(evt)
  assert.equal(await loop.onToolResult(evt, { cwd: f.root }), undefined)
  assert.deepEqual(evt, before)
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

const tfCapture = (() => {
  const dir = scratchDir('builder-test-capture-')
  const fixturePath = join(dir, 'recorded.test.mjs')
  writeFileSync(fixturePath, `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('TFPASS', () => {})\ntest('TFSUITE', async t => { await t.test('TFPASS child', () => {}) })\ntest('TFFAIL', () => assert.equal('ACTUAL_TF', 'EXPECTED_TF'))\n`)
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.FORCE_COLOR; delete env.CLICOLOR_FORCE; delete env.NODE_TEST_CONTEXT
  const capture = (reporter) => {
    const result = realSpawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, fixturePath], { encoding: 'utf8', env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    return result.stdout
  }
  return { spec: capture('spec'), tap: capture('tap') }
})()

function bashResult(loop, command, visible, extra = {}) {
  return loop.onToolResult({ toolName: 'bash', input: { command }, content: [{ type: 'text', text: visible }], ...extra }, {})
}
function filterLoop(options = {}) {
  const f = fixture()
  const loop = loopFor(f, options)
  return { f, loop }
}

// MUTATION: remove the spec passing-line removal branch.
test('TF1', async () => {
  const { loop } = filterLoop()
  const patch = await bashResult(loop, 'node --test x.test.mjs', tfCapture.spec)
  assert.ok(patch)
  assert.doesNotMatch(patch.content[0].text, /^\s*✔ /m)
  assert.doesNotMatch(patch.content[0].text, /^▶ TFSUITE$/m)
})
// MUTATION: stop removing TAP ok result records.
test('TF2', async () => {
  const { loop } = filterLoop()
  const patch = await bashResult(loop, 'node --test x.test.mjs', tfCapture.tap)
  assert.ok(patch)
  assert.doesNotMatch(patch.content[0].text, /^\s*ok \d+/m)
})
// MUTATION: discard indented failing spec diagnostics.
test('TF3', async () => {
  const { loop } = filterLoop()
  const patch = await bashResult(loop, 'node --test x.test.mjs', tfCapture.spec)
  const failure = tfCapture.spec.split(/\r?\n/).filter((line) => /TFFAIL|ACTUAL_TF|EXPECTED_TF/.test(line)).at(-1)
  assert.ok(patch.content[0].text.includes(failure))
})
// MUTATION: strip a failing TAP YAML block.
test('TF4', async () => {
  const { loop } = filterLoop()
  const patch = await bashResult(loop, 'node --test x.test.mjs', tfCapture.tap)
  const failure = tfCapture.tap.slice(tfCapture.tap.indexOf('not ok '), tfCapture.tap.indexOf('\nnot ok ', tfCapture.tap.indexOf('not ok ') + 1) < 0 ? undefined : tfCapture.tap.indexOf('\nnot ok ', tfCapture.tap.indexOf('not ok ') + 1))
  assert.ok(patch.content[0].text.includes(failure.trimEnd()))
})
// MUTATION: alter the independently visible passing count.
test('TF5', async () => {
  const { loop } = filterLoop()
  const patch = await bashResult(loop, 'node --test x.test.mjs', tfCapture.tap)
  const text = patch.content[0].text
  const body = text.slice(0, text.lastIndexOf('\n[test output filtered:'))
  const count = tfCapture.tap.split(/\r?\n/).filter((line) => /^\s*(?:✔ |ok \d+(?:\s|$))/.test(line)).length
  assert.match(text, new RegExp(`dropped ${count} passing-test lines, ${Buffer.byteLength(tfCapture.tap) - Buffer.byteLength(body)} bytes`))
})
// MUTATION: admit output without requiring a node test command.
test('TF6', async (t) => {
  const { loop } = filterLoop()
  assert.ok(await bashResult(loop, 'node --test x.test.mjs', tfCapture.spec))
  assert.equal(await bashResult(loop, 'cat x.test.mjs', tfCapture.spec), undefined)
  // MUTATION: bypass the builder and bash admission checks.
  await t.test('ineligible roles tools and content preserve visible results', async () => {
    assert.equal(await bashResult(filterLoop({ role: 'reviewer' }).loop, 'node --test x.test.mjs', tfCapture.spec), undefined)
    assert.equal(await filterLoop().loop.onToolResult({ toolName: 'read', input: { command: 'node --test x.test.mjs' }, content: [{ type: 'text', text: tfCapture.spec }] }, {}), undefined)
    assert.equal(await filterLoop().loop.onToolResult({ toolName: 'bash', input: { command: 'node --test x.test.mjs' }, content: [{ type: 'text', text: tfCapture.spec }, { type: 'text', text: tfCapture.spec }] }, {}), undefined)
    assert.equal(await filterLoop().loop.onToolResult({ toolName: 'bash', input: { command: 'node --test x.test.mjs' }, content: [{ type: 'image', data: 'x' }] }, {}), undefined)
  })
})
// MUTATION: admit output without a Node test summary.
test('TF7', async (t) => {
  const { loop } = filterLoop()
  assert.ok(await bashResult(loop, 'node --test x.test.mjs', tfCapture.spec))
  assert.equal(await bashResult(loop, 'node --test x.test.mjs', tfCapture.spec.replace(/^ℹ tests .*$/m, '')), undefined)
  // Empty commands cannot satisfy the Node test command admission.
  await t.test('missing command retains visible text', async () => {
    assert.equal(await bashResult(loop, '', tfCapture.spec), undefined)
  })
  // MUTATION: normalize filtered source line endings.
  await t.test('CRLF and zero passing lines retain visible output', async () => {
    const visible = '# tests 1\r\nnot ok 1 - CRLF_FAIL\r\n'
    const patch = await bashResult(loop, 'node --test x.test.mjs', visible)
    assert.ok(patch.content[0].text.startsWith(visible))
    assert.match(patch.content[0].text, /dropped 0 passing-test lines, 0 bytes/)
  })
})
// MUTATION: omit structured output while patching visible output.
test('TF8', async () => {
  const { loop } = filterLoop()
  const structuredContent = { other: 3, output: 'old' }
  const patch = await bashResult(loop, 'node --test x.test.mjs', tfCapture.tap, { structuredContent })
  assert.deepEqual(patch.structuredContent, { ...structuredContent, output: patch.content[0].text })
  assert.equal(Object.hasOwn(patch, 'isError'), false)
})
// MUTATION: disable full output recovery after visible eligibility.
test('TF9', async (t) => {
  const f = fixture()
  const fullPath = join(f.root, 'full.out')
  writeFileSync(fullPath, tfCapture.tap)
  const loop = loopFor(f, { deps: { stat: (path) => ({ size: readFileSync(path).length }) } })
  const patch = await loop.onToolResult({ toolName: 'bash', input: { command: 'node --test x.test.mjs' }, content: [{ type: 'text', text: '# tests 1\n' }], details: { fullOutputPath: fullPath } }, {})
  assert.match(patch.content[0].text, /not ok .*TFFAIL/)
  // MUTATION: replace visible output after a failed full-output read.
  await t.test('full-output recovery failures retain visible structured output', async () => {
    const visible = '# tests 1\nnot ok 1 - VISIBLE_FAILURE\n'
    const cases = [
      { deps: { stat: () => ({ size: 1 }), readFile: () => { throw Error('EPERM') } }, path: 'unreadable.out' },
      { deps: { stat: () => ({ size: 8 * 1024 * 1024 + 1 }), readFile: () => '# tests 1\nnot ok 1 - FULL_MARKER\n' }, path: 'oversized.out', excluded: 'FULL_MARKER' },
      { deps: { stat: () => ({ size: 1 }), readFile: () => '# tests 1\n' + 'ok 1 - FULL_PASS\n'.repeat(493448) }, path: 'post-read-oversized.out' },
      { deps: { stat: () => ({ size: 1 }), readFile: () => `# tests 1\nnot ok 1 - ${'x'.repeat(51201)}\n` }, path: 'filtered-large.out' },
    ]
    for (const { deps, path, excluded } of cases) {
      const local = loopFor(fixture(), { deps })
      const structuredContent = { retained: true, output: 'old' }
      const result = await local.onToolResult({ toolName: 'bash', input: { command: 'node --test x.test.mjs' }, content: [{ type: 'text', text: visible }], details: { fullOutputPath: path }, structuredContent }, {})
      assert.ok(result.content[0].text.startsWith(visible))
      if (excluded) assert.doesNotMatch(result.content[0].text, new RegExp(excluded))
      assert.deepEqual(result.structuredContent, { retained: true, output: result.content[0].text })
      assert.equal(Object.hasOwn(result, 'isError'), false)
    }
  })
})
// MUTATION: append the unfiltered fenced lane tail.
test('TF10', async () => {
  const f = fixture()
  const loop = loopFor(f, { runner: async () => ({ code: 0, signal: null, tail: tfCapture.spec }) })
  const result = await loop.onToolResult(event('edit', join(f.root, 'fixture.mjs')), { cwd: f.root })
  assert.doesNotMatch(appendedText(result), /^\s*✔ /m)
})
// MUTATION: let the private builder reducer retain TAP passing YAML.
test('TF11', async () => {
  const lane = await import(`../../${['lane', 'red.mjs'].join('-')}`)
  const { loop } = filterLoop()
  const patch = await bashResult(loop, 'node --test x.test.mjs', tfCapture.tap)
  const notice = patch.content[0].text.lastIndexOf('\n[test output filtered:')
  assert.equal(patch.content[0].text.slice(0, notice), lane.dropPassingLines(tfCapture.tap))
})
