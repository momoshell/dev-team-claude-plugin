import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../../../test/helpers.mjs'
import * as mod from './skeletonread.ts'

const RUN_AT = 1_000_000_000_000

function fixture({ source = null, plan = '', scope = ['src/target.mjs'], maxLines = '3', role = 'builder' } = {}) {
  const root = scratchDir('skeleton-read-')
  const taskDir = join(root, 'task')
  const returnsDir = join(root, 'returns')
  const sourcePath = join(root, 'src', 'target.mjs')
  mkdirSync(join(taskDir), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  const body = source ?? Array.from({ length: 6 }, (_, index) => `line-${index + 1}`).join('\n') + '\n'
  writeFileSync(sourcePath, body)
  const planPath = join(taskDir, 'plan.md')
  writeFileSync(planPath, plan)
  writeFileSync(join(root, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: RUN_AT })}\n`)
  const mtimes = new Map()
  const putReturn = (number, envelope, mtime = RUN_AT + 100) => {
    const path = join(returnsDir, `d${number}.planner.json`)
    writeFileSync(path, JSON.stringify(envelope))
    mtimes.set(path, mtime)
    return path
  }
  const envelope = {
    assignment_id: 'd1', role: 'planner', status: 'done',
    details: { plan_path: planPath, files_in_scope: scope, validation_lane: 'node --test', gate_cmd: 'node gate.mjs' },
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

function latestEnvelope(f, number, marker, mtime = 250) {
  const planPath = join(f.taskDir, `plan-${number}.md`)
  writeFileSync(planPath, `${marker}\nsrc/target.mjs:2-3\n`)
  return f.putReturn(number, {
    assignment_id: `d${number}`, role: 'planner', status: 'done',
    details: { plan_path: planPath, files_in_scope: ['src/target.mjs'], validation_lane: 'node --test', gate_cmd: 'node gate.mjs' },
  }, mtime)
}

function staleAndCurrentEnvelopes(f) {
  f.mtimes.set(join(f.returnsDir, 'd1.planner.json'), RUN_AT - 100)
  latestEnvelope(f, 9, 'stale-marker', RUN_AT - 50)
  latestEnvelope(f, 2, 'latest-marker', RUN_AT + 200)
}

test('SRA1', () => {
  const f = fixture({ plan: 'src/target.mjs:2-3\n' })
  writeFileSync(f.sourcePath, 'export function visible() {\n  return 1\n}\nline-4\nline-5\n')
  const result = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root })
  assert.ok(result)
  assert.match(result.content[0].text, /Indexed signatures:/)
  assert.match(result.content[0].text, /visible/)
})

test('SRA2', () => {
  const f = fixture({ plan: 'old-marker\nsrc/target.mjs:1-1\n' })
  staleAndCurrentEnvelopes(f)
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.doesNotMatch(text, /1: line-1/)
  assert.match(text, /2: line-2/)
  assert.match(text, /3: line-3/)
})

test('RV1-1 walks an oversized journal backward to the last run start', () => {
  const f = fixture({ plan: 'src/target.mjs:2-3\n' })
  const noise = JSON.stringify({ event: 'seat-liveness', payload: 'x'.repeat(300 * 1024) })
  writeFileSync(join(f.root, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: RUN_AT })}\n${noise}\n`)

  const context = mod.loadAcceptedContext({ taskDir: f.taskDir, cwd: f.root })
  assert.equal(context?.planner_number, 1)
  const result = mod.createSkeletonRead({ taskDir: f.taskDir, cwd: f.root, env: f.env })
    .onToolResult(readEvent('src/target.mjs'), { cwd: f.root })
  assert.match(result?.content?.[0]?.text || '', /2: line-2/)
})

test('RV1-2 rejects a higher-numbered planner return from before this run', () => {
  const f = fixture({ plan: 'old-marker\nsrc/target.mjs:1-1\n' })
  staleAndCurrentEnvelopes(f)

  const context = mod.loadAcceptedContext({ taskDir: f.taskDir, cwd: f.root, deps: f.deps })
  assert.equal(context?.planner_number, 2)
  assert.match(context?.plan_text || '', /latest-marker/)
  assert.doesNotMatch(context?.plan_text || '', /stale-marker/)
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

test('RR1', async () => {
  const f = fixture({ maxLines: undefined })
  const tool = mod.createRetrieveTool({ taskDir: f.taskDir, cwd: f.root, env: f.env, deps: f.deps })
  const value = await tool.execute('r', { file: 'src/target.mjs', range: '2-4' }, null, null, { cwd: f.root })
  assert.equal(value, 'line-2\nline-3\nline-4')
})

test('RS1', async () => {
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

test('RF1', async () => {
  const f = fixture({ scope: ['src/target.mjs'], maxLines: undefined })
  writeFileSync(join(f.root, 'src', 'outside.mjs'), 'outside-body\n')
  const tool = mod.createRetrieveTool({ taskDir: f.taskDir, cwd: f.root, env: f.env, deps: f.deps })
  const value = await tool.execute('r', { file: 'src/outside.mjs', range: '1-1' }, null, null, { cwd: f.root })
  assert.match(value, /refused/)
})

test('NC1', () => {
  const f = fixture({ plan: '', source: 'a\nb\nc\nd\n', maxLines: '2' })
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.match(text, /\(no cited ranges in accepted plan\)/)
})

test('NF1', () => {
  const f = fixture({ plan: '', source: 'uncited-1\nuncited-2\nuncited-3\nuncited-4\n', maxLines: '2' })
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.doesNotMatch(text, /1: uncited-1/)
})

test('UE1', () => {
  const f = fixture({ source: 'one\ntwo\nthree\n', maxLines: '3' })
  assert.equal(skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }), undefined)
})

test('NE1', () => {
  const f = fixture({ source: 'one\ntwo\nthree\nfour\n', scope: ['src/other.mjs'], maxLines: '2' })
  assert.equal(skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }), undefined)
})

test('FB1', () => {
  const f = fixture({ source: 'one\ntwo\nthree\nfour\n', maxLines: '2' })
  const failures = []
  const result = skeleton(f, { loadContext: () => { throw new Error('injected failure') }, recordFailure: (row) => failures.push(row) })
    .onToolResult(readEvent('src/target.mjs'), { cwd: f.root })
  assert.equal(result, undefined)
  assert.equal(failures.length, 1)
  assert.match(failures[0].skeleton_read_failure, /injected failure/)
})

test('TC1', () => {
  const f = fixture({ source: 'one\ntwo\nthree\nfour\n', maxLines: '2' })
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.match(text, /Threshold: 2 lines/)
})

test('TP1', () => {
  const f = fixture({ source: 'one\ntwo\nthree\nfour\n', maxLines: '2' })
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.match(text, /Threshold: 2 lines/)
})

test('TD1', () => {
  const f = fixture({ source: Array.from({ length: 351 }, (_, index) => `default-${index}`).join('\n') + '\n', maxLines: null })
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.match(text, /Threshold: 350 lines/)
})

test('BS1', () => {
  const f = fixture({ source: 'one\ntwo\nthree\nfour\n', maxLines: '2' })
  const text = skeleton(f).onToolResult(readEvent('src/target.mjs'), { cwd: f.root }).content[0].text
  assert.match(text, new RegExp(mod.BLIND_SPOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('skeletonread helpers reject malformed ranges and invalid fences', () => {
  assert.equal(mod.validFence([]), false)
  assert.equal(mod.retrieveRange('0-1', ['one']), 'refused: range is malformed or outside the file')
  assert.equal(mod.inFence(['src/'], 'src/target.mjs'), true)
})
