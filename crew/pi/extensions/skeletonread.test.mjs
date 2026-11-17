import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { leanLaneFixture, scratchDir } from '../../../test/helpers.mjs'
import * as mod from './skeletonread.ts'

const RUN_AT = 1_000_000_000_000

function fixture({ source = null, plan = '', scope = ['src/target.mjs'], maxLines = '3', role = 'builder' } = {}) {
  const root = scratchDir('skeleton-read-')
  const taskDir = join(root, 'task')
  const returnsDir = taskDir
  const sourcePath = join(root, 'src', 'target.mjs')
  mkdirSync(join(taskDir), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  const body = source ?? Array.from({ length: 6 }, (_, index) => `line-${index + 1}`).join('\n') + '\n'
  writeFileSync(sourcePath, body)
  const planPath = join(taskDir, 'plan.md')
  writeFileSync(planPath, plan)
  writeFileSync(join(taskDir, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: RUN_AT })}\n`)
  const mtimes = new Map()
  const putReturn = (number, envelope, mtime = RUN_AT + 100) => {
    const path = join(returnsDir, `planner-${number}.json`)
    writeFileSync(path, JSON.stringify(envelope))
    mtimes.set(path, mtime)
    return path
  }
  const envelope = {
    id: 'lane.planner.1', role: 'planner', status: 'done', summary: 'fixture',
    details: { subject: 'fix(crew): skeleton fixture', tests: [], plan_path: planPath, files_in_scope: scope, validation_lane: 'node --test', gate_cmd: 'node gate.mjs' },
  }
  putReturn(1, envelope)
  const deps = {
    readFile: (path, encoding) => readFileSync(path, encoding),
    readDir: (path) => readdirSync(path),
    fileMtime: (path) => mtimes.get(path) ?? 0,
    appendFile: (path, text) => appendFileSync(path, text),
  }
  const env = { CREW_ROLE: role, CREW_TASK_DIR: taskDir }
  if (maxLines !== undefined && maxLines !== null) env.CREW_READGATE_MAX_LINES = maxLines
  return { root, taskDir, returnsDir, sourcePath, planPath, mtimes, deps, env, putReturn, body }
}

function readEvent(path) {
  return { toolName: 'read', input: { path }, isError: false, content: [{ type: 'text', text: 'original bytes' }] }
}

function skeleton(f, extra = {}) {
  return mod.createSkeletonRead({ taskDir: f.taskDir, cwd: f.root, env: f.env, deps: f.deps, ...extra })
}

test('RV1-1 walks an oversized journal backward to the last run start', () => {
  const f = fixture({ plan: 'src/target.mjs:2-3\n' })
  const noise = JSON.stringify({ event: 'seat-liveness', payload: 'x'.repeat(300 * 1024) })
  writeFileSync(join(f.taskDir, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: RUN_AT })}\n${noise}\n`)

  const context = mod.loadAcceptedContext({ taskDir: f.taskDir, cwd: f.root })
  assert.equal(context?.planner_number, 1)
  const result = mod.createSkeletonRead({ taskDir: f.taskDir, cwd: f.root, env: f.env })
    .onToolResult(readEvent('src/target.mjs'), { cwd: f.root })
  assert.match(result?.content?.[0]?.text || '', /2: line-2/)
})

test('RV2-1 preserves oversized cited ranges and retrieve output', async () => {
  const f = fixture({
    plan: 'src/large.mjs:2-3\n',
    scope: ['src/target.mjs', 'src/large.mjs'],
  })
  const largePath = join(f.root, 'src', 'large.mjs')
  writeFileSync(largePath, `export function largeSymbol() {\n  return 'LARGE_BODY'\n}\n${'x'.repeat(300 * 1024)}\n`)

  const hook = mod.createSkeletonRead({ taskDir: f.taskDir, cwd: f.root, env: f.env })
  const cited = hook.onToolResult(readEvent('src/target.mjs'), { cwd: f.root })?.content?.[0]?.text || ''
  assert.match(cited, /src\/large\.mjs:2-3:/)
  assert.match(cited, /2:   return 'LARGE_BODY'/)
  assert.match(cited, /3: \}/)
  assert.doesNotMatch(cited, /\(no cited ranges in accepted plan\)/)

  const tool = mod.createRetrieveTool({ taskDir: f.taskDir, cwd: f.root, env: f.env })
  assert.equal(await tool.execute('r', { file: 'src/large.mjs', range: '2-3' }, null, null, { cwd: f.root }), "  return 'LARGE_BODY'\n}")
  assert.match(await tool.execute('r', { file: 'src/large.mjs', symbol: 'largeSymbol' }, null, null, { cwd: f.root }), /LARGE_BODY/)
  assert.match(hook.onToolResult(readEvent('src/large.mjs'), { cwd: f.root })?.content?.[0]?.text || '', /Skeleton read: src\/large\.mjs/)
})

test('RS1 retrieves each symbol without its sibling body', async () => {
  const f = fixture({ source: 'const first = () => { return "FIRST_BODY" }\nconst second = () => { return "SECOND_BODY" }\nexport { first, second }\n', plan: 'src/target.mjs:1-3\n', maxLines: undefined })
  const tool = mod.createRetrieveTool({ taskDir: f.taskDir, cwd: f.root, env: f.env, deps: f.deps })
  const value = await tool.execute('r', { file: 'src/target.mjs', symbol: 'first' }, null, null, { cwd: f.root })
  assert.match(value, /FIRST_BODY/)
  assert.doesNotMatch(value, /SECOND_BODY/)
  assert.doesNotMatch(value, /export \{/)
  // The absences above are measurements only if this retrieval CAN produce those
  // tokens. Retrieving the sibling symbol proves both directions: each body is
  // reachable, and neither leaks into the other's result.
  const other = await tool.execute('r', { file: 'src/target.mjs', symbol: 'second' }, null, null, { cwd: f.root })
  assert.match(other, /SECOND_BODY/)
  assert.doesNotMatch(other, /FIRST_BODY/)
})

test('UE1 leaves reads at the threshold unchanged', () => {
  const f = fixture({ source: 'one\ntwo\nthree\n', maxLines: '3' })
  assert.equal(skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }), undefined)
})

test('a skeleton-read failure row carries a numeric at by default', () => {
  const f = fixture({ source: 'one\ntwo\nthree\nfour\n', maxLines: '2' }), failures = []
  skeleton(f, { loadContext: () => { throw new Error('injected failure') }, recordFailure: (row) => failures.push(row) })
    .onToolResult(readEvent('src/target.mjs'), { cwd: f.root })
  assert.equal(failures.length, 1)
  assert.ok(Number.isFinite(failures[0].at))
})

test('TC1 reports the configured line threshold', () => {
  const f = fixture({ source: 'one\ntwo\nthree\nfour\n', maxLines: '2' })
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.match(text, /Threshold: 2 lines/)
})

test('skeletonread helpers reject malformed ranges and invalid fences', () => {
  assert.equal(mod.validFence([]), false)
  assert.equal(mod.retrieveRange('0-1', ['one']), 'refused: range is malformed or outside the file')
  assert.equal(mod.inFence(['src/'], 'src/target.mjs'), true)
})

test('a lean lane accepts its own planner return: citations come from the lane plan, newest return, never the parent', () => {
  const lane = leanLaneFixture({ planners: [[2, 10_000, { files_in_scope: ['older.mjs'] }], [12, 30_000], [99, -10_000, { files_in_scope: ['stale.mjs'] }]] })
  const cwd = join(lane.parent, 'checkout')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'a.mjs'), 'one\ntwo\nthree\n')
  const context = mod.loadAcceptedContext({ taskDir: lane.taskDir, cwd, env: lane.env })
  assert.equal(context.planner_number, 12)
  assert.equal(context.plan_path, join(lane.taskDir, 'plan.md'))
  assert.deepEqual(context.ranges, [{ file: 'a.mjs', start: 1, end: 2 }])
  lane.write(13, 40_000, { plan_path: '../elsewhere.md' })
  assert.equal(mod.loadAcceptedContext({ taskDir: lane.taskDir, cwd, env: lane.env }), null, 'the newest return is unusable and fails closed')
  rmSync(join(lane.taskDir, 'journal.jsonl'))
  assert.equal(mod.loadAcceptedContext({ taskDir: lane.taskDir, cwd, env: lane.env }), null, 'no fallback to the parent journal')
})

test('the skeleton tool serves the whole-read replacement for exactly the reads it replaces and refuses the rest', async () => {
  const f = fixture({ plan: 'src/target.mjs:2-3\n' })
  writeFileSync(join(f.root, 'src', 'other.mjs'), 'x\n'.repeat(10))
  const tool = mod.createSkeletonTool({ taskDir: f.taskDir, cwd: f.root, env: f.env, deps: f.deps })
  const expected = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root })
  assert.match(expected.content[0].text, /Skeleton read: src\/target\.mjs/)
  assert.deepEqual(await tool.execute('1', { path: 'src/target.mjs' }, undefined, undefined, { cwd: f.root }), expected)
  assert.equal(tool.replaces({ path: 'src/target.mjs' }, f.root), true)
  for (const input of [{ path: 'src/target.mjs', offset: 1 }, { path: 'src/target.mjs', limit: 2 }, { path: 'src/other.mjs' }, {}]) assert.equal(tool.replaces(input, f.root), false, JSON.stringify(input))
  assert.match(await tool.execute('2', { path: 'src/other.mjs' }, undefined, undefined, { cwd: f.root }), /^refused:/)
})
