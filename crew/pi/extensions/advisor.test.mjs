import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import * as advisor from './advisor.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'advisor-test-'))
  const taskDir = join(root, 'task')
  const returns = join(root, 'returns')
  const tree = join(root, 'tree')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(returns, { recursive: true }); mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib', 'widget.mjs'), 'a\nb\nc\n')
  writeFileSync(join(taskDir, advisor.TRIPWIRE_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, tripwires: ['lib/widget.test.mjs'],
  }))
  writeFileSync(join(returns, 'd1.planner.json'), JSON.stringify({ details: { files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
  return { root, taskDir, tree }
}

function sink() {
  const rows = []
  return {
    rows,
    appendFile: (_path, text) => { for (const line of String(text).split('\n')) if (line.trim()) rows.push(JSON.parse(line)) },
  }
}

function env(over = {}) {
  return {
    CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: '/tmp/advisor-test/task',
    CREW_ADVISOR_ENDPOINT: 'http://127.0.0.1:11434/v1', CREW_ADVISOR_MODEL: 'qwen3-coder', ...over,
  }
}

function pi() {
  const value = { handlers: [], sends: [], tools: [] }
  value.on = (event, handler) => value.handlers.push([event, handler])
  value.sendMessage = (message, options) => value.sends.push({ message, options })
  value.registerTool = (tool) => value.tools.push(tool)
  return value
}

const result = (id, toolName, input, text, isError = false) => ({
  type: 'tool_result', toolCallId: id, toolName, input,
  content: [{ type: 'text', text }], isError,
})

const call = (id, toolName, input) => ({ type: 'tool_call', toolCallId: id, toolName, input })

function fetcher(reply = { class: 'edge-path', severity: 'medium', claim: 'the read path answers EPERM', evidence: ['lib/widget.mjs:2'] }) {
  const posts = []
  const fn = async (_url, init = {}) => {
    if (!init.method) return { status: 200 }
    posts.push({ init, body: init.body })
    const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] })
    return {
      status: 200, ok: true,
      headers: { get: () => String(Buffer.byteLength(body)) },
      body: { getReader: () => {
        let done = false
        return { read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(body) }), cancel: async () => {} }
      } },
    }
  }
  fn.posts = posts
  return fn
}

test('advisor module is node-only, erasable, and exposes no callable registration surface', () => {
  const source = readFileSync(new URL('./advisor.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')))
  assert.doesNotMatch(source, /registerTool/)
  assert.doesNotMatch(source, /^\s*(enum|namespace)\s/m)
  assert.equal(typeof advisor.default, 'function')
})

test('classifier is loopback-only and canonicalizes accepted cells', () => {
  assert.deepEqual(advisor.classifyAdvisorCell({ endpoint: '', model: 'x' }), { reason: 'endpoint-unset' })
  assert.deepEqual(advisor.classifyAdvisorCell({ endpoint: 'http://127.0.0.1.evil/v1', model: 'x' }), { reason: 'endpoint-not-local' })
  assert.deepEqual(advisor.classifyAdvisorCell({ endpoint: 'http://u:p@127.0.0.1/v1', model: 'x' }), { reason: 'endpoint-credentials' })
  assert.deepEqual(advisor.classifyAdvisorCell({ endpoint: 'http://127.0.0.1/v1', model: 'qwen3-coder' }), { endpoint: 'http://127.0.0.1/v1', model: 'qwen3-coder' })
})

test('attach is default-off, refuses wrong roles, and journals before handlers', async () => {
  const off = pi(); await advisor.attachAdvisor(off, { env: { CREW_ROLE: 'builder' }, deps: { appendFile: () => { throw new Error('must stay inert') } } })
  assert.equal(off.handlers.length, 0)
  const refused = sink(); const wrong = pi()
  await assert.rejects(() => advisor.attachAdvisor(wrong, { env: env({ CREW_ROLE: 'planner' }), deps: refused }), /role-unsupported/)
  assert.equal(wrong.handlers.length, 0)

  const live = sink(); const order = []; const p = pi()
  p.on = (event, handler) => { order.push(`on:${event}`); p.handlers.push([event, handler]) }
  await advisor.attachAdvisor(p, { env: env(), deps: {
    ...live, appendFile: (path, text) => { order.push('append'); live.appendFile(path, text) }, fetchFn: fetcher(),
  } })
  assert.equal(order[0], 'append')
  assert.deepEqual(p.handlers.map(([event]) => event).sort(), ['tool_call', 'tool_result'])
  assert.equal(p.tools.length, 0)
})

test('validation and failure helpers are closed and payload-free', () => {
  assert.equal(advisor.isValidationCommand('npm test-not', 'npm test'), false)
  assert.equal(advisor.isValidationCommand("echo 'make check'", 'make check'), false)
  assert.equal(advisor.isValidationCommand('npm test && echo done', 'npm test'), true)
  assert.equal(advisor.failureSignature('not ok 1 - broken (4ms)'), 'broken')
  assert.equal(advisor.failureTarget("location: 'lib/widget.mjs:2:1'", '/tmp/tree'), 'lib/widget.mjs')
  const verdict = advisor.validateJudgment({ class: 'bad', severity: 'high', claim: '', evidence: ['x.mjs:1'], marker: 'secret' }, { anchors: new Set(['x.mjs:1']) })
  assert.ok(verdict.codes.every((code) => advisor.JUDGMENT_ERROR_CODES.includes(code)))
  assert.ok(verdict.codes.every((code) => !code.includes('secret')))
})

test('tier-zero notes are deterministic and tier one is journal-first', async () => {
  const f = fixture(); const journal = sink(); const sends = []; const fetchFn = fetcher()
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    fetchFn, send: (message, options) => sends.push({ message, options }),
  } })
  const outside = join(f.tree, 'outside.mjs'); writeFileSync(outside, 'a\n')
  const input = { path: outside, edits: [{ oldText: 'a', newText: 'aa' }] }
  a.onToolCall(call('1', 'edit', input), {}); a.onToolResult(result('1', 'edit', input, 'ok'), {})
  await a.settled()
  const notes = journal.rows.filter((row) => row.advisor_note).map((row) => row.advisor_note)
  assert.ok(notes.some((note) => note.tier === 0 && note.kind === advisor.SCOPE_BREACH))
  assert.ok(notes.some((note) => note.tier === 1 && note.outcome === 'injected'))
  assert.equal(sends.length, 1)
  assert.equal(sends[0].options.deliverAs, 'steer')
  assert.equal(sends[0].options.triggerTurn, undefined)
  rmSync(f.root, { recursive: true, force: true })
})
