import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as advisor from './advisor.ts'
import { leanLaneFixture, scratchDir } from '../../../test/helpers.mjs'
// MUTATION: add planner back to ADVISED_ROLES
test('advisor.ts carries no HTTP endpoint, cell classifier or planner-advisor surface', () => {
  for (const name of ['probeEndpoint', 'readBoundedBody', 'classifyAdvisorCell', 'advisorCell', 'ADVISOR_ENDPOINT_ENV', 'ADVISOR_MODEL_ENV', 'PROBE_TIMEOUT_MS', 'PLANNER_SYSTEM_PROMPT']) assert.equal(name in advisor, false)
  const source = readFileSync(new URL('./advisor.ts', import.meta.url), 'utf8')
  for (const text of ['CREW_ADVISOR_ENDPOINT', 'CREW_ADVISOR_MODEL', 'fetch(']) assert.ok(!source.includes(text))
  assert.deepEqual([...advisor.ADVISED_ROLES], ['builder'])
})
function fixture() {
  const root = scratchDir('advisor-test-')
  const taskDir = join(root, 'task')
  const returns = join(root, 'returns')
  const tree = join(root, 'tree')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(returns, { recursive: true }); mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib', 'widget.mjs'), 'a\nb\nc\n')
  writeFileSync(join(taskDir, advisor.ADVISOR_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, cell: { provider: 'provider', id: 'model', agent: 'pi', effort: 'medium', model: 'provider/model' },
  }))
  writeFileSync(join(taskDir, 'plan.md'), '# plan\n'); writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify({ role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'fixture', details: { subject: 'fix(crew): advisor fixture', plan_path: 'plan.md', tests: [], files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
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
    ...over,
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

function fakeChild({ exitCode = 0, invalid = false, hang = false, stderr = '' } = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = []
  child.stdin = { end(value) { if (hang) return; setImmediate(() => {
    const request = JSON.parse(value)
    const anchor = request.delta.flatMap((entry) => String(entry.text).split('\n')).map((line) => /^([^:]+(?:\/[^:]+)*:\d+): /.exec(line)?.[1]).find(Boolean) || 'lib/widget.mjs:2'
    const judgment = { class: 'edge-path', severity: 'medium', claim: 'guard handles a grounded edge case', evidence: [anchor] }
    child.stdout.write(invalid ? 'not-json\n' : `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify(judgment), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } })}\n`)
    if (stderr) child.stderr.write(stderr)
    setImmediate(() => child.emit('close', exitCode))
  }) } }
  child.kill = (signal) => { child.kills.push(signal); return true }
  return child
}

async function runManifestConsult({ cell = { provider: 'local', id: 'advisor-v1', agent: 'pi', effort: 'high', model: 'local/advisor-v1' }, childOptions = {}, envExtra = {}, timerDeps = {}, resolveBinary = () => ({ command: '/fake/pi', args: [] }) } = {}) {
  const f = fixture(); const journal = sink(); let argv; let spawned = 0
  const manifestPath = join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.cell = cell
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, ...envExtra }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    binaryDeps: {}, resolveBinary,
    spawn: (_bin, args) => { argv = args; spawned++; return fakeChild(childOptions) },
    ...timerDeps,
  } })
  const source = join(f.tree, 'lib/widget.mjs')
  a.onToolResult(result('ground', 'read', { path: source, offset: 1 }, 'lib/widget.mjs:2: grounded condition'), {})
  const target = join(f.tree, 'widget.test.mjs'); writeFileSync(target, 'test\n')
  const change = { path: target, content: 'test\n' }
  a.onToolCall(call('fire', 'write', change), {})
  a.onToolResult(result('fire', 'write', change, 'ok'), {})
  await a.settled()
  return { f, journal, a, argv, spawned }
}

test('ADR47-L2 C1 null-cell attach still emits an injected scope-breach tier-zero note', async () => {
  const f = fixture()
  const manifestPath = join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.cell = null
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const journal = sink(); const p = pi()
  await advisor.attachAdvisor(p, {
    env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir },
    deps: {
      taskDir: f.taskDir, cwd: f.tree, appendFile: journal.appendFile,
      readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
      spawn: () => { throw new Error('null-cell scope-breach must not spawn') },
    },
  })
  const onCall = p.handlers.find(([event]) => event === 'tool_call')?.[1]
  assert.equal(typeof onCall, 'function')
  onCall(call('c1', 'write', { path: join(f.tree, 'widget.test.mjs'), content: 'test' }), {})
  const note = journal.rows.find((row) => row.advisor_note?.tier === 0)?.advisor_note
  assert.equal(note?.kind, advisor.SCOPE_BREACH)
  assert.equal(note?.outcome, 'injected')
  rmSync(f.root, { recursive: true, force: true })
})
test('ADR47-L2 C2 null cell suppresses repeated consult and spawn', async () => { const f = fixture(); const m = JSON.parse(readFileSync(join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE))); m.cell = null; writeFileSync(join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE), JSON.stringify(m)); const journal = sink(); let spawnCount = 0; const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR:f.taskDir }), deps: { taskDir:f.taskDir,cwd:f.tree,appendFile:journal.appendFile,readFile:(p)=>readFileSync(p,'utf8'),fileMtime:()=>2,spawn:()=>{spawnCount++} } }); for(let i=1;i<=25;i++){a.onToolCall(call(String(i),'read',{}),{});a.onToolResult(result(String(i),'read',{},'ok'),{})} await a.settled(); assert.equal(spawnCount,0); assert.equal(journal.rows.some((r)=>r.advisor_consult),false); assert.equal(journal.rows.some((r)=>r.advisor_note?.tier===1),false); rmSync(f.root,{recursive:true,force:true}) })
test('ADR47-L2 C3 grant attaches without a manifest or retired model environment', async () => {
  const f = fixture(); rmSync(join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE))
  const p = pi(); const journal = sink()
  await advisor.attachAdvisor(p, {
    env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir },
    deps: { taskDir: f.taskDir, appendFile: journal.appendFile },
  })
  assert.deepEqual(p.handlers.map(([event]) => event).sort(), ['tool_call', 'tool_result'])
  assert.equal(journal.rows.find((row) => row.advisor_boot)?.advisor_boot.outcome, 'attached')
  rmSync(f.root, { recursive: true, force: true })
})
// Kills: `cell_invalid` forced false (or the attach check deleted). A present cell that fails
// the allowlist must refuse loudly, never attach as a silent tier-0-only seat; null still attaches.
test('a malformed manifest cell refuses attach while an explicit null cell attaches', async () => {
  for (const [cell, outcome] of [[{ provider: 'p', id: 'm', agent: 'pi', effort: null, model: 'p/m' }, 'refused'], [null, 'attached']]) {
    const f = fixture(); const manifestPath = join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE)
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), cell }))
    const journal = sink(); const p = pi()
    const attach = advisor.attachAdvisor(p, { env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir }, deps: { taskDir: f.taskDir, appendFile: journal.appendFile } })
    if (outcome === 'refused') {
      await assert.rejects(attach, (err) => err.reason === 'manifest-cell-invalid')
      assert.equal(journal.rows.find((row) => row.advisor_unavailable)?.advisor_unavailable.reason, 'manifest-cell-invalid')
      assert.equal(journal.rows.some((row) => row.advisor_boot), false)
      assert.equal(p.handlers.length, 0)
    } else {
      await attach
      assert.equal(journal.rows.find((row) => row.advisor_boot)?.advisor_boot.outcome, 'attached')
    }
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('result-time repeated-failure notes and queued triggers retain the result call ordinal', async () => {
  const f = fixture(); const journal = sink()
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
  } })
  const input = { command: 'npm test' }; const text = 'not ok 1 - repeated validation failure (4ms)'
  a.onToolCall(call('1', 'bash', input), {})
  a.onToolResult(result('1', 'bash', input, text, true), {})
  a.onToolCall(call('2', 'bash', input), {})
  a.onToolCall(call('3', 'bash', input), {})
  a.onToolCall(call('4', 'bash', input), {})
  a.onToolResult(result('2', 'bash', input, text, true), {})
  await a.settled()
  const tier0 = journal.rows.find((row) => row.advisor_note?.kind === advisor.REPEATED_FAILURE)?.advisor_note
  const queued = journal.rows.find((row) => row.advisor_note?.trigger === 'tier0-note')?.advisor_note
  assert.equal(tier0.call_ordinal, 2)
  assert.equal(queued.call_ordinal, 2)
  rmSync(f.root, { recursive: true, force: true })
})
test('a nonzero child exit journals its exit code and stderr tail on the cell failure row', async () => {
  const r = await runManifestConsult({ childOptions: { exitCode: 1, stderr: 'pi: provider refused the request\n' } })
  try {
    const rows = r.journal.rows.filter((row) => row.advisor_cell_failure).map((row) => row.advisor_cell_failure)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'transport-error')
    assert.equal(rows[0].exit_code, 1)
    assert.equal(rows[0].signal, null)
    assert.ok(rows[0].stderr_tail.includes('provider refused'))
  } finally { rmSync(r.f.root, { recursive: true, force: true }) }
})
test('a pre-spawn pi resolution failure writes exactly one transport-error cell-failure audit', async () => {
  const r = await runManifestConsult({ resolveBinary: () => ({}) })
  const failures = r.journal.rows.filter((row) => row.advisor_cell_failure).map((row) => row.advisor_cell_failure)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].kind, 'transport-error')
  rmSync(r.f.root, { recursive: true, force: true })
})
// Kills: `&& !epochAborted` dropped from spendMeasured. A consult aborted by a manifest epoch
// change after a usage frame arrived is not the cell's failure, and its partial fold is never
// priced: the usage row carries null with a reason, and no cell-failure row is written.
test('an epoch-aborted consult writes no cell failure and never prices its partial usage', async () => {
  const callbacks = []; const f = fixture(); const journal = sink()
  const manifestPath = join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE)
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')); m.cell = { provider: 'local', id: 'advisor-v1', agent: 'pi', effort: 'high', model: 'local/advisor-v1' }
  writeFileSync(manifestPath, JSON.stringify(m))
  const child = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true
    c.stdin = { end() { setImmediate(() => c.stdout.write(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'partial', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } } })}\n`)) } }
    return c
  }
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: { cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (p) => readFileSync(p, 'utf8'), fileMtime: () => 2, resolveBinary: () => ({ command: '/fake/pi' }), spawn: child, setTimeout(fn) { callbacks.push(fn); return callbacks.length }, clearTimeout() {}, consultTimeoutMs: 5, childKillGraceMs: 1 } })
  const source = join(f.tree, 'lib/widget.mjs'); const path = join(f.tree, 'widget.test.mjs')
  a.onToolResult(result('g', 'read', { path: source }, 'lib/widget.mjs:2: grounded'), {})
  a.onToolCall(call('f', 'write', { path, content: 'x' }), {}); a.onToolResult(result('f', 'write', { path, content: 'x' }, 'ok'), {})
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
  writeFileSync(manifestPath, JSON.stringify({ ...m, run_started_at: 2 }))
  a.onToolResult(result('g2', 'read', { path: source }, 'lib/widget.mjs:2: grounded'), {})
  for (let i = 0; i < 8; i++) { callbacks.splice(1, 1)[0]?.(); await new Promise((r) => setImmediate(r)) }
  await a.settled()
  const usage = journal.rows.find((row) => row.advisor_usage)?.advisor_usage
  assert.ok(usage, 'the aborted consult still journals its usage row')
  assert.equal(usage.usage, null)
  assert.equal(usage.usage_reason, 'usage-incomplete')
  assert.equal(journal.rows.filter((row) => row.advisor_cell_failure).length, 0)
  rmSync(f.root, { recursive: true, force: true })
})
// Kills: the `!settled && !failure` guard dropped from the abort or the timeout callback. A
// stdout failure is the consult's cause; an epoch abort or a timeout that lands while the child
// is still closing must neither clear that cell failure nor relabel it as a timeout.
test('a later epoch abort or timeout never clears or relabels an earlier stream failure', async () => {
  for (const late of ['abort', 'timeout']) {
    const callbacks = []; const f = fixture(); const journal = sink()
    const manifestPath = join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE)
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')); m.cell = { provider: 'local', id: 'advisor-v1', agent: 'pi', effort: 'high', model: 'local/advisor-v1' }
    writeFileSync(manifestPath, JSON.stringify(m))
    const child = () => {
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true
      c.stdin = { end() { setImmediate(() => c.stdout.emit('error', new Error('broken pipe'))) } }
      return c
    }
    const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: { cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (p) => readFileSync(p, 'utf8'), fileMtime: () => 2, resolveBinary: () => ({ command: '/fake/pi' }), spawn: child, setTimeout(fn) { callbacks.push(fn); return callbacks.length }, clearTimeout() {}, consultTimeoutMs: 5, childKillGraceMs: 1 } })
    const source = join(f.tree, 'lib/widget.mjs'); const path = join(f.tree, 'widget.test.mjs')
    a.onToolResult(result('g', 'read', { path: source }, 'lib/widget.mjs:2: grounded'), {})
    a.onToolCall(call('f', 'write', { path, content: 'x' }), {}); a.onToolResult(result('f', 'write', { path, content: 'x' }, 'ok'), {})
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
    // callbacks[0] is the consult timeout; the stream failure has already scheduled the kill timers.
    if (late === 'abort') {
      writeFileSync(manifestPath, JSON.stringify({ ...m, run_started_at: 2 }))
      a.onToolResult(result('g2', 'read', { path: source }, 'lib/widget.mjs:2: grounded'), {})
    } else callbacks.shift()()
    for (let i = 0; i < 8; i++) { callbacks.splice(late === 'abort' ? 1 : 0, 1)[0]?.(); await new Promise((r) => setImmediate(r)) }
    await a.settled()
    const failures = journal.rows.filter((row) => row.advisor_cell_failure).map((row) => row.advisor_cell_failure)
    assert.equal(failures.length, 1, late)
    assert.equal(failures[0].kind, 'transport-error', late)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('the default export IS attachAdvisor: inert without the grant, and it refuses an unsupported role by name', async () => {
  // Pi loads advisor.ts and calls its default with only `pi`; attach then reads process.env. A typeof
  // pin proved the export existed. This proves it delegates: the two gates attachAdvisor applies
  // first are observable through the default with no endpoint and no journal.
  const saved = { grant: process.env[advisor.ADVISOR_GRANT_ENV], role: process.env.CREW_ROLE, task: process.env.CREW_TASK_DIR }
  try {
    delete process.env[advisor.ADVISOR_GRANT_ENV]; delete process.env.CREW_ROLE
    const inert = pi()
    assert.equal(await advisor.default(inert), undefined)
    assert.deepEqual(inert.handlers, [], 'without the grant the advisor registers nothing')
    process.env[advisor.ADVISOR_GRANT_ENV] = '1'; process.env.CREW_TASK_DIR = scratchDir('advisor-default-')
    await assert.rejects(() => advisor.default(pi()), /role-unsupported/)
  } finally {
    for (const [k, v] of [[advisor.ADVISOR_GRANT_ENV, saved.grant], ['CREW_ROLE', saved.role], ['CREW_TASK_DIR', saved.task]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})

test('E1 advisor module is node-only, erasable, and exposes no callable registration surface', () => {
  const source = readFileSync(new URL('./advisor.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:') || ['./subagent.ts', './advisor-redaction.ts', './advisor-diff.ts', '../context-layout.mjs', '../../adapters/adapter-pi.mjs', '../../protocols.mjs'].includes(specifier)))
  for (const leaf of ['./advisor-redaction.ts', './advisor-diff.ts']) {
    const leafSource = readFileSync(new URL(leaf, import.meta.url), 'utf8')
    const leafImports = [...leafSource.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
    assert.ok(leafImports.every((specifier) => specifier.startsWith('node:')), leaf)
  }
  assert.doesNotMatch(readFileSync(new URL('../../protocols.mjs', import.meta.url), 'utf8'), /^import\s/m)
  assert.doesNotMatch(source, /registerTool/)
  assert.doesNotMatch(source, /^\s*(enum|namespace)\s/m)
})

const sharedAdvisorCells = Object.freeze([
  { endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder' },
  { endpoint: 'http://10.112.20.20:8080/v1', model: 'qwen3-coder' },
  { endpoint: 'http://[::1]:11434/v1', model: 'qwen3-coder' },
  { endpoint: 'https://desktop2.lan/v1', model: 'qwen3-coder' },
  { endpoint: 'ftp://10.112.20.20:8080/v1', model: 'qwen3-coder' },
  { endpoint: 'http://u:p@10.112.20.20:8080/v1', model: 'qwen3-coder' },
  { endpoint: 'http:///v1', model: 'qwen3-coder' },
  { endpoint: 'http://10.112.20.20:8080/v1', model: '' },
  { endpoint: 'http://10.112.20.20:8080/v1', model: 'not safe' },
  { endpoint: '', model: 'qwen3-coder' },
])




test('AD1 AD2 AD3 reply validation accepts first valid member and unions invalid codes', () => {
  const options = { anchors: new Set(['lib/widget.mjs:2']) }
  const valid = { class: 'edge-path', severity: 'medium', claim: 'grounded', evidence: ['lib/widget.mjs:2'] }
  assert.equal(advisor.validateReply([valid, { ...valid, claim: 'later' }], options).judgment.claim, 'grounded')
  assert.equal(advisor.validateReply([{ ...valid, class: 'bad' }, valid], options).judgment.claim, 'grounded')
  const invalid = advisor.validateReply([{ ...valid, class: 'bad' }, { ...valid, severity: 'bad' }], options)
  assert.deepEqual(invalid.codes, ['class-invalid', 'severity-invalid'])
  assert.deepEqual(advisor.validateReply([], options), { codes: ['no-finding'] })
  assert.equal(advisor.validateReply([valid, valid, valid, valid], options).judgment.claim, 'grounded')
  assert.equal(advisor.validateReply([valid, valid, valid, valid, valid], options).codes[0], 'payload-not-an-object')
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

test('AD5 tier-zero notes are deterministic and tier one is journal-first', async () => {
  const f = fixture(); const journal = sink(); const sends = []
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    spawn: () => fakeChild(), send: (message, options) => sends.push({ message, options }),
  } })
  const outside = join(f.tree, 'outside.mjs'); writeFileSync(outside, 'a\n')
  const input = { path: outside, edits: [{ oldText: 'a', newText: 'aa' }] }
  a.onToolCall(call('1', 'edit', input), {}); a.onToolResult(result('1', 'edit', input, 'ok'), {})
  await a.settled()
  const notes = journal.rows.filter((row) => row.advisor_note).map((row) => row.advisor_note)
  assert.ok(notes.some((note) => note.tier === 0 && note.kind === advisor.SCOPE_BREACH))
  assert.ok(notes.some((note) => note.tier === 1 && note.outcome === 'injected'))
  assert.equal(sends.length, 2)
  assert.ok(sends.every((send) => send.options.deliverAs === 'steer'))
  assert.ok(sends.every((send) => send.options.triggerTurn === undefined))
  assert.ok(sends.some((send) => send.message.details.tier === 0))
  assert.ok(sends.some((send) => send.message.details.tier === 1))
  rmSync(f.root, { recursive: true, force: true })
})

test('delta redaction names each kind it removes and leaves ordinary source alone', () => {
  const githubSecret = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const pemSecret = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIBOgIBAAJBAK7A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const jwtSecret = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const bearerSecret = 'bearer aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v'
  const authorizationSecret = 'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='
  const parameterizedAuthorization = 'Authorization: Signature keyId="client",signature="AbCdEf0123456789AbCdEf0123456789"'
  const credentialLine = "const conf = { API_TOKEN: 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0' }"
  const source = readFileSync(new URL('./advisor.ts', import.meta.url), 'utf8')
  const ordinary = source.split('\n')
    .filter((line) => line.includes("payloadKey: 'advisor_unavailable'") || line.includes("const UNKNOWN_KEY = 'unknown-key'"))
    .join('\n')
  const out = advisor.redactDelta([
    githubSecret, pemSecret, jwtSecret, bearerSecret, authorizationSecret,
    parameterizedAuthorization, credentialLine, ordinary,
  ].join('\n'))

  assert.equal(out.text.includes(githubSecret), false)
  assert.equal(out.text.includes(pemSecret), false)
  assert.equal(out.text.includes(jwtSecret), false)
  assert.equal(out.text.includes(bearerSecret), false)
  assert.equal(out.text.includes(authorizationSecret), false)
  assert.equal(out.text.includes(parameterizedAuthorization), false)
  assert.equal(out.text.includes('AbCdEf0123456789AbCdEf0123456789'), false)
  assert.equal(out.text.includes(credentialLine), false)
  assert.equal(out.text.includes('<redacted:github-token>'), true)
  assert.equal(out.text.includes('<redacted:private-key>'), true)
  assert.equal(out.text.includes('<redacted:jwt>'), true)
  assert.equal(out.text.includes('<redacted:bearer-token>'), true)
  assert.equal(out.text.includes('<redacted:authorization>'), true)
  assert.equal(out.text.includes('Authorization: <redacted:authorization>'), true)
  assert.equal(out.text.includes('<redacted:credential>'), true)
  assert.deepEqual(out.counts, {
    'private-key': 1, authorization: 2, 'bearer-token': 1,
    credential: 1, jwt: 1, 'github-token': 1,
  })
  const clean = advisor.redactDelta(ordinary)
  assert.equal(clean.text, ordinary)
  assert.deepEqual(clean.counts, {})
})

test('every delta source is redacted before it is stored, sent or frozen', async () => {
  const githubSecret = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const pemSecret = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIBOgIBAAJBAK7A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const jwtSecret = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const bearerSecret = 'bearer aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v'
  const sources = [
    {
      secret: githubSecret, kind: 'github-token',
      drive: (a, f) => {
        const path = join(f.tree, 'outside-edit.mjs'); const content = `const token = '${githubSecret}'\nconst clean = 1\n`
        writeFileSync(path, content)
        const input = { path, edits: [{ oldText: 'x', newText: content.split('\n')[0] }] }
        a.onToolCall(call('edit-source', 'edit', input), {}); a.onToolResult(result('edit-source', 'edit', input, 'ok'), {})
      },
    },
    {
      secret: pemSecret, kind: 'private-key',
      drive: (a, f) => {
        const path = join(f.tree, 'outside-write.mjs'); const content = `${pemSecret}\n`
        writeFileSync(path, content)
        const input = { path, content }
        a.onToolCall(call('write-source', 'write', input), {}); a.onToolResult(result('write-source', 'write', input, 'ok'), {})
      },
    },
    {
      secret: jwtSecret, kind: 'jwt',
      drive: (a, f) => {
        const input = { path: join(f.tree, 'lib', 'widget.mjs'), offset: 1 }
        a.onToolCall(call('read-source', 'read', input), {})
        a.onToolResult(result('read-source', 'read', input, `const jwt = '${jwtSecret}'\n`), {})
        const path = join(f.tree, 'trigger-read.mjs'); const content = 'const clean = 1\n'
        writeFileSync(path, content)
        const trigger = { path, edits: [{ oldText: 'x', newText: content.split('\n')[0] }] }
        a.onToolCall(call('trigger-read', 'edit', trigger), {}); a.onToolResult(result('trigger-read', 'edit', trigger, 'ok'), {})
      },
    },
    {
      secret: bearerSecret, kind: 'bearer-token',
      drive: (a, f) => {
        const input = { command: 'npm test' }
        a.onToolCall(call('bash-source', 'bash', input), {})
        a.onToolResult(result('bash-source', 'bash', input, `not ok 1 - request rejected, sent ${bearerSecret} upstream`, true), {})
        const path = join(f.tree, 'trigger-fail.mjs'); const content = 'const clean = 1\n'
        writeFileSync(path, content)
        const trigger = { path, edits: [{ oldText: 'x', newText: content.split('\n')[0] }] }
        a.onToolCall(call('trigger-fail', 'edit', trigger), {}); a.onToolResult(result('trigger-fail', 'edit', trigger, 'ok'), {})
      },
    },
  ]

  let dirtyRows = null
  for (const [index, source] of sources.entries()) {
    const f = fixture(); const journal = sink(); let childInput = ''
    const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
      cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
      readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
      spawn: () => { const child = fakeChild(); const end = child.stdin.end; child.stdin.end = (value) => { childInput = value; end(value) }; return child },
    } })
    try {
      source.drive(a, f)
      await a.settled()
      const body = childInput
      assert.equal(!body.includes(source.secret) && body.includes(`<redacted:${source.kind}>`), true, `redacted ${source.kind} source ${index + 1}`)
      if (dirtyRows === null) dirtyRows = journal.rows.filter((row) => row.advisor_consult).map((row) => row.advisor_consult)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }

  assert.deepEqual(dirtyRows[0].redacted, { 'github-token': 1 })

  const cleanFixture = fixture(); const cleanJournal = sink()
  const cleanAdvisor = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: cleanFixture.taskDir }), deps: {
    cwd: cleanFixture.tree, taskDir: cleanFixture.taskDir, appendFile: cleanJournal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
  } })
  try {
    const path = join(cleanFixture.tree, 'outside-clean.mjs'); const content = 'const clean = 1\n'
    writeFileSync(path, content)
    const input = { path, edits: [{ oldText: 'x', newText: content.split('\n')[0] }] }
    cleanAdvisor.onToolCall(call('clean-source', 'edit', input), {})
    cleanAdvisor.onToolResult(result('clean-source', 'edit', input, 'ok'), {})
    await cleanAdvisor.settled()
    const cleanRows = cleanJournal.rows.filter((row) => row.advisor_consult).map((row) => row.advisor_consult)
    assert.deepEqual(cleanRows[0].redacted, {})
  } finally {
    rmSync(cleanFixture.root, { recursive: true, force: true })
  }
})


test('RV1-3 journals stale child consult usage before suppressing stale notes', async () => {
  const f = fixture(); const journal = sink(); let finish
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { finish = () => { child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity: 'low', claim: 'stale finding', evidence: ['lib/widget.mjs:2'] }), usage: { input: 4, output: 2 } } }) + '\n'); child.emit('close', 0) } } }
    child.kill = () => true; return child
  }
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    resolveBinary: () => ({ command: '/stub/pi', args: [] }), spawn,
  } })
  const readPath = join(f.tree, 'lib', 'widget.mjs')
  a.onToolResult(result('stale-read', 'read', { path: readPath, offset: 1 }, 'lib/widget.mjs:2: evidence'), {})
  const change = { path: join(f.tree, 'stale.mjs'), edits: [{ newText: 'x' }] }
  a.onToolCall(call('stale', 'edit', change), {}); a.onToolResult(result('stale', 'edit', change, 'ok'), {})
  await new Promise((resolve) => setImmediate(resolve))
  writeFileSync(join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE), JSON.stringify({ schema_version: 1, run_started_at: 2, tripwires: [] }))
  finish()
  await a.settled()
  const consults = journal.rows.filter((row) => row.advisor_consult).map((row) => row.advisor_consult)
  assert.equal(consults.length, 1)
  assert.deepEqual(consults[0].usage, { billed_input_tokens: 4, billed_output_tokens: 2, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 })
  assert.equal(a.notes().some((note) => note.claim === 'stale finding'), false)
  rmSync(f.root, { recursive: true, force: true })
})

test('A3 clockfree pi-child timeout, oversize output and invalid frames are closed failures', async () => {
  for (const mode of ['timeout', 'oversize', 'invalid']) {
    const f = fixture(); const journal = sink(); const timers = manualTimers(5)
    const spawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.stdin = { end() { if (mode === 'timeout') return; setImmediate(() => {
        child.stdout.write(mode === 'oversize' ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'r'.repeat(advisor.RESPONSE_CAP_BYTES + 1) } }) + '\n' : 'not-json\\n')
        child.emit('close', 0)
      }) } }
      child.kill = () => true
      return child
    }
    const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
      cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
      resolveBinary: () => ({ command: '/stub/pi', args: [] }), spawn, consultTimeoutMs: 5, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    } })
    const readPath = join(f.tree, 'lib', 'widget.mjs')
    a.onToolResult(result(`${mode}-read`, 'read', { path: readPath, offset: 1 }, 'lib/widget.mjs:2: evidence'), {})
    const target = join(f.tree, `${mode}.mjs`); const change = { path: target, edits: [{ newText: 'x' }] }
    a.onToolCall(call(mode, 'edit', change), {}); a.onToolResult(result(mode, 'edit', change, 'ok'), {})
    if (mode === 'timeout') { for (let i = 0; i < 20 && !timers.armed.some((entry) => entry.ms === 5); i++) await new Promise((resolve) => setImmediate(resolve)); timers.fireConsult() }
    await a.settled()
    const rejected = journal.rows.find((row) => row.advisor_note?.outcome === 'rejected')?.advisor_note
    assert.ok(rejected, mode)
    assert.ok(rejected.codes.includes(mode === 'oversize' ? 'body-too-large' : mode === 'invalid' ? 'body-not-json' : 'timeout'), mode)
    rmSync(f.root, { recursive: true, force: true })
  }
})



test('F1 advisor refusal and judgment vocabularies remain frozen', () => {
  assert.equal(Object.isFrozen(advisor.JUDGMENT_CLASSES), true)
  assert.deepEqual(advisor.JUDGMENT_CLASSES, ['edge-path', 'over-claim'])
})



function manualTimers(consultTimeoutMs) {
  const armed = []
  const setTimeout = (fn, ms) => { const entry = { fn, ms }; armed.push(entry); if (ms !== consultTimeoutMs) setImmediate(fn); return entry }
  const clearTimeout = (entry) => { if (armed.includes(entry)) entry.cleared = true; else globalThis.clearTimeout(entry) }
  const fireConsult = () => { const entries = armed.filter((entry) => entry.ms === consultTimeoutMs); assert.equal(entries.length, 1); entries[0].fn() }
  return { setTimeout, clearTimeout, armed, fireConsult }
}

function childConsult({ childSpawn, extraDeps = {} }) {
  const f = fixture(); const journal = sink()
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    spawn: childSpawn, resolveBinary: () => ({ command: '/stub/pi', args: [] }), ...extraDeps,
  } })
  const run = async () => {
    const path = join(f.tree, 'lib', 'widget.mjs')
    a.onToolResult(result('read', 'read', { path, offset: 1 }, 'lib/widget.mjs:2: evidence'), {})
    const change = { path: join(f.tree, 'outside.mjs'), edits: [{ newText: 'x' }] }
    a.onToolCall(call('edit', 'edit', change), {}); a.onToolResult(result('edit', 'edit', change, 'ok'), {})
    await a.settled()
  }
  return { f, journal, run, cleanup: () => rmSync(f.root, { recursive: true, force: true }) }
}

// The whole false-clean class (Sol, #1547 hand-finish passes 4-5): spend is measured ONLY IF
// every own-spend frame carries a complete usage. One test per variant; each names the guard
// in ownSpendIncomplete whose removal turns it red.
const SPEND_JUDGMENT = { class: 'edge-path', severity: 'medium', claim: 'child found a grounded edge path', evidence: ['outside.mjs:1'] }
const ownFrame = (usage) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(SPEND_JUDGMENT) }], ...(usage === undefined ? {} : { usage }) } })
const COMPLETE_USAGE = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 }
// One child per call. `raw` is written after the frames, verbatim; `close` is the exit the
// child reports ([code, signal]), or null for a child that never closes by itself (a hang);
// the kill stub never closes it, so a failed consult settles on the advisor's own hard grace.
async function spendRun(frames, { raw = '', close = [0, null], extraDeps = {}, afterFrames } = {}) {
  const childSpawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { setImmediate(() => {
      for (const frame of frames) child.stdout.write(JSON.stringify(frame) + '\n')
      if (raw) child.stdout.write(raw)
      setImmediate(() => { afterFrames?.(); if (close !== null) child.emit('close', close[0], close[1]) })
    }) } }
    child.kill = () => true
    return child
  }
  const c = childConsult({ childSpawn, extraDeps: { childKillGraceMs: 5, ...extraDeps } })
  try {
    await c.run()
    const rows = c.journal.rows.filter((row) => row.advisor_usage).map((row) => row.advisor_usage)
    assert.equal(rows.length, 1)
    const consult = c.journal.rows.filter((row) => row.advisor_consult).at(-1)?.advisor_consult
    return { row: rows[0], consult }
  } finally { c.cleanup() }
}
async function spendRowFor(frames) { return (await spendRun(frames)).row }
// (e) guard: only own-spend frames count. Zero own-spend frames (a nested tool result, which
// the reducer never counts) keep the reducer's null and usage-unavailable, not incomplete.
test('spend class (e): zero own-spend frames keep usage-unavailable, and a complete run is measured', async () => {
  const none = await spendRowFor([{ type: 'message_end', message: { role: 'toolResult', content: [] } }, { type: 'turn_end' }])
  assert.equal(none.usage, null); assert.equal(none.usage_reason, 'usage-unavailable')
  const measured = await spendRowFor([ownFrame(COMPLETE_USAGE), ownFrame({ input: 1, output: 1, cacheRead: 2, cacheWrite: 3 })])
  assert.deepEqual(measured.usage, { billed_input_tokens: 6, billed_output_tokens: 4, billed_cache_write_tokens: 3, billed_cache_read_tokens: 2 })
  assert.equal(measured.usage_reason, null)
})

for (const stream of ['stderr']) {
  test(`E${stream === 'stdout' ? 1 : 2} advisor ${stream} stream error`, async () => {
    const signals = []
    const childSpawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.stdin = { end() { setImmediate(() => child[stream].emit('error', new Error('read failed'))) } }
      child.kill = (signal) => { signals.push(signal); setImmediate(() => child.emit('close', null)); return true }
      return child
    }
    const c = childConsult({ childSpawn, extraDeps: { childKillGraceMs: 5 } })
    try {
      await c.run()
      assert.deepEqual(signals, ['SIGTERM'])
      const rejected = c.journal.rows.find((row) => row.advisor_note?.tier === 1 && row.advisor_note?.outcome === 'rejected')?.advisor_note
      assert.ok(rejected?.codes.includes('transport-failed'))
    } finally { c.cleanup() }
  })
}

test('an asynchronous EPIPE on the child stdin fails the consult as transport-failed instead of crashing the seat', async () => {
  const signals = []
  const childSpawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    const stdin = new EventEmitter()
    stdin.end = () => { setImmediate(() => stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))) }
    child.stdin = stdin
    child.kill = (signal) => { signals.push(signal); setImmediate(() => child.emit('close', null)); return true }
    return child
  }
  const c = childConsult({ childSpawn, extraDeps: { childKillGraceMs: 5 } })
  try {
    await c.run()
    assert.deepEqual(signals, ['SIGTERM'])
    const rejected = c.journal.rows.find((row) => row.advisor_note?.outcome === 'rejected')?.advisor_note
    assert.ok(rejected?.codes.includes('transport-failed'))
  } finally { c.cleanup() }
})

function framesChild(frames, { chunked = false } = {}) {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { setImmediate(() => {
      if (chunked) for (const frame of frames) child.stdout.write(frame)
      else child.stdout.write(frames.join(''))
      setImmediate(() => child.emit('close', 0))
    }) } }
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true }
    return child
  }
}
const judgmentFrame = (claim) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity: 'low', claim, evidence: ['lib/widget.mjs:2'] }) } }) + '\n'

test('many small frames whose TOTAL exceeds the stream cap are rejected body-too-large', async () => {
  const { STREAM_CAP_BYTES } = await import('./subagent.ts')
  const filler = JSON.stringify({ type: 'turn_start', pad: 'x'.repeat(1000) }) + '\n'
  const count = Math.ceil(STREAM_CAP_BYTES / Buffer.byteLength(filler)) + 1
  const frames = [...Array.from({ length: count }, () => filler), judgmentFrame('Guard at lib/widget.mjs:2 misses the null path.')]
  assert.ok(frames.every((frame) => Buffer.byteLength(frame) < advisor.RESPONSE_CAP_BYTES))
  const c = childConsult({ childSpawn: framesChild(frames, { chunked: true }), extraDeps: { childKillGraceMs: 5 } })
  try {
    await c.run()
    const notes = c.journal.rows.filter((row) => row.advisor_note).map((row) => row.advisor_note)
    assert.ok(notes.find((note) => note.outcome === 'rejected')?.codes.includes('body-too-large'))
    assert.equal(JSON.stringify(notes).includes('misses the null path'), false)
  } finally { c.cleanup() }
})

// Consult-path guards for the delivery fix (lane b1147). They drive createAdvisor end to end:
// a fake judgment child returns `reply`, and the journal rows and steers are observed.
const adGood = (claim) => ({ class: 'edge-path', severity: 'medium', claim, evidence: ['lib/widget.mjs:1'] })
async function adDrive(reply, { noCell = false, denyAppend = false } = {}) {
  const root = scratchDir('advisor-ad-')
  const taskDir = join(root, 'task'), tree = join(root, 'tree'), rows = [], sends = []
  mkdirSync(taskDir); mkdirSync(join(root, 'returns')); mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib/widget.mjs'), 'const widget = null\n')
  writeFileSync(join(taskDir, advisor.ADVISOR_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, tripwires: [],
    ...(noCell ? {} : { cell: { provider: 'local', id: 'advisor', agent: 'pi', effort: 'medium', model: 'local/advisor' } }),
  }))
  writeFileSync(join(taskDir, 'plan.md'), '# plan\n'); writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify({ role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'fixture', details: { subject: 'fix(crew): advisor fixture', plan_path: 'plan.md', tests: [], files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
  let spawned = 0
  const seat = advisor.createAdvisor({ env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir }, deps: {
    taskDir, cwd: tree, fileMtime: () => 2, readFile: (p) => readFileSync(p, 'utf8'), diffSize: () => null,
    resolveBinary: () => ({ command: '/fake/pi', args: [] }),
    appendFile: (_p, text) => {
      const parsed = String(text).trim().split('\n').map((line) => JSON.parse(line))
      if (denyAppend && parsed.some((row) => row.advisor_note?.tier === 0)) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      rows.push(...parsed)
    },
    send: (message, options) => sends.push({ message, options, journalFirst: rows.some((row) => JSON.stringify(row.advisor_note) === JSON.stringify(message.details)) }),
    spawn: () => {
      spawned++
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
      child.stdin = { end() { setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: reply, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + '\n')
        child.emit('close', 0)
      }) } }
      return child
    },
  } })
  try {
    seat.onToolResult({ toolCallId: 'read', toolName: 'read', input: { path: join(tree, 'lib/widget.mjs') }, content: [{ type: 'text', text: 'const widget = null' }] }, {})
    const input = { path: join(tree, 'outside.mjs'), content: 'const outside = null\n' }
    seat.onToolCall({ toolCallId: 'write', toolName: 'write', input }, {})
    seat.onToolResult({ toolCallId: 'write', toolName: 'write', input, content: [{ type: 'text', text: 'ok' }] }, {})
    await seat.settled()
    return { rows, sends, spawned }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const adTier1 = (r) => r.rows.filter((row) => row.advisor_note?.tier === 1).map((row) => row.advisor_note)
const adSent1 = (r) => r.sends.filter((s) => s.message.details?.tier === 1)

// MUTATION AD4: drop reply_excerpt, or store the raw unbounded reply — rejections become undiagnosable
// or leak a secret past the 512-byte redacted prefix.
test('AD4 a rejected reply journals a bounded redacted excerpt', async () => {
  const secret = 'AbCdEfGhIjKlMnOpQrStUv123456'
  const replies = ['Bearer ' + secret + ' ' + '😀'.repeat(400), '42', JSON.stringify({ ...adGood('invalid claim'), class: 'bogus' })]
  const results = await Promise.all(replies.map((reply) => adDrive(reply)))
  const excerpts = results.map((r) => adTier1(r)[0]?.reply_excerpt)
  assert.deepEqual(excerpts.map((e) => typeof e === 'string' && e.length > 0), [true, true, true])
  assert.equal(Buffer.byteLength(excerpts[0]) <= 512, true)
  assert.equal(advisor.redactDelta(replies[0]).text.startsWith(excerpts[0]), true)
  assert.equal(excerpts[0].includes(secret), false)
  assert.equal(results.reduce((n, r) => n + adSent1(r).length, 0), 0)
})

// MUTATION AD5: neutralise the emitTier0 send — a scope breach is journaled injected but never reaches the builder.
test('AD5 a tier-zero note is journaled first and then sent as a steer', async () => {
  const [r, denied] = await Promise.all([adDrive('', { noCell: true }), adDrive('', { noCell: true, denyAppend: true })])
  assert.deepEqual(r.rows.filter((row) => row.advisor_note).map((row) => row.advisor_note.outcome), ['injected'])
  assert.deepEqual(r.sends.map((s) => ({ type: s.message.customType, content: s.message.content, delivery: s.options.deliverAs, display: s.message.display, noTriggerTurn: s.options.triggerTurn === undefined, journalFirst: s.journalFirst })),
    [{ type: 'crew-advisor', content: 'The builder seat touched outside.mjs outside the declared scope.', delivery: 'steer', display: true, noTriggerTurn: true, journalFirst: true }])
  assert.equal(r.spawned, 0)
  assert.equal(denied.sends.length, 0)
})

// MUTATION AS1: replace the severity interpolation with an invalid value.
test('AS1 both role prompts carry the complete constant-backed reply contract', () => {
  const prompts = [advisor.BUILDER_SYSTEM_PROMPT]
  const clauses = [
    'Return JSON alone: one object or an array of 1 to 4 objects, with no prose, no code fence, no wrapper key and no second object on another line.',
    'Each object has exactly the four keys class, severity, claim and evidence.',
    'class must be one of edge-path, over-claim.', 'severity must be one of low, medium, high.',
    'claim must be a non-empty string of at most 500 UTF-8 bytes.',
    'evidence must be an array of 1 to 5 strings, each at most 200 UTF-8 bytes and exactly a bare path:line',
    'The first evidence item must cite a line shown in the delta.',
    'Do not copy the example\'s evidence unless that line is shown in the delta.',
  ]
  for (const prompt of prompts) for (const clause of clauses) assert.ok(prompt.includes(clause), clause)
  for (const value of advisor.JUDGMENT_CLASSES) for (const prompt of prompts) assert.ok(prompt.includes(value))
  for (const value of advisor.SEVERITIES) for (const prompt of prompts) assert.ok(prompt.includes(value))
  assert.equal(advisor.CLAIM_CAP_BYTES, 500)
  assert.equal(advisor.EVIDENCE_MAX, 5)
  assert.equal(advisor.EVIDENCE_ITEM_CAP_BYTES, 200)
  assert.equal(advisor.JUDGMENT_REPLY_MAX, 4)
})

// MUTATION AS2: replace evidence's array requirement with prose.
test('AS2 malformed reply shapes are rejected and mapped to prompt clauses', () => {
  const badEvidence = 'The path is not handled.'
  const shapes = [
    [{ class: 'edge-path', severity: 'unassessed', claim: 'The empty input path is not handled.', evidence: [badEvidence] }, ['evidence-invalid', 'severity-invalid']],
    [{ class: 'edge-path', severity: 'low', claim: 'The empty input path is not handled.', evidence: badEvidence }, ['evidence-invalid']],
    [{ judgments: [{ class: 'edge-path', severity: 'low', claim: 'The empty input path is not handled.', evidence: ['src/widget.mjs:12'] }] }, ['claim-invalid', 'class-invalid', 'evidence-invalid', 'severity-invalid', 'unknown-key']],
  ]
  for (const [shape, expected] of shapes) {
    const verdict = advisor.validateReply(shape, { anchors: new Set(['src/widget.mjs:12']) })
    assert.equal('judgment' in verdict, false)
    assert.deepEqual([...verdict.codes].sort(), expected)
  }
  const required = {
    'unknown-key': 'exactly the four keys class, severity, claim and evidence',
    'class-invalid': 'class must be one of edge-path, over-claim',
    'severity-invalid': 'severity must be one of low, medium, high',
    'claim-invalid': 'claim must be a non-empty string of at most 500 UTF-8 bytes',
    'evidence-invalid': 'evidence must be an array of 1 to 5 strings',
  }
  for (const clause of new Set(shapes.flatMap(([, codes]) => codes).map((code) => required[code]))) assert.ok(advisor.BUILDER_SYSTEM_PROMPT.includes(clause), clause)
  assert.ok(advisor.BUILDER_SYSTEM_PROMPT.includes('exactly a bare path:line'))
})

// Shared consult harness follows gate.mjs's fake child and never resolves a real pi.
async function rjDrive(reply, { mode = 'reply', digest, repeated = false } = {}) {
  const root = scratchDir('advisor-rj-')
  const taskDir = join(root, 'task'), tree = join(root, 'tree'), rows = [], sends = []
  mkdirSync(taskDir); mkdirSync(join(root, 'returns')); mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib/widget.mjs'), 'const widget = null\\n')
  writeFileSync(join(taskDir, advisor.ADVISOR_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, tripwires: [],
    cell: { provider: 'local', id: 'advisor', agent: 'pi', effort: 'medium', model: 'local/advisor' },
  }))
  writeFileSync(join(taskDir, 'plan.md'), '# plan\n'); writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify({ role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'fixture', details: { subject: 'fix(crew): advisor fixture', plan_path: 'plan.md', tests: [], files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
  let timeoutFn, childIndex = 0
  const deps = {
    taskDir, cwd: tree, fileMtime: () => 2, readFile: p => readFileSync(p, 'utf8'), diffSize: () => null,
    resolveBinary: () => ({ command: '/fake/pi', args: [] }),
    appendFile: (_p, text) => rows.push(...String(text).trim().split('\n').map(JSON.parse)),
    send: (message, options) => sends.push({ message, options }),
    consultTimeoutMs: 12345, childKillGraceMs: 1,
    ...(digest ? { digest } : {}),
    setTimeout: (fn, ms) => { if (ms === 12345) { timeoutFn = fn; return { timeout: true } } return setImmediate(fn) },
    clearTimeout: timer => { if (!timer?.timeout) clearImmediate(timer) },
    spawn: () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
      child.stdin = { end() {
        if (mode === 'timeout') { setImmediate(() => timeoutFn()); return }
        setImmediate(() => {
          const current = childIndex++
          if (mode === 'bad-frame') child.stdout.write('not-json\n')
          else if (mode === 'oversize') child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'x'.repeat(66000) } }) + '\n')
          else child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: Array.isArray(reply) ? reply[current] : reply, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + '\n')
          child.emit('close', mode === 'exit' ? 1 : 0)
        })
      } }
      return child
    },
  }
  const seat = advisor.createAdvisor({ env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir }, deps })
  try {
    seat.onToolResult({ toolCallId: 'read', toolName: 'read', input: { path: join(tree, 'lib/widget.mjs') }, content: [{ type: 'text', text: 'const widget = null' }] }, {})
    const count = repeated ? 2 : 1
    for (let i = 0; i < count; i++) {
      const input = { path: join(tree, `outside-${i}.mjs`), content: 'const outside = null\n' }
      const id = 'write-' + i
      seat.onToolCall({ toolCallId: id, toolName: 'write', input }, {})
      seat.onToolResult({ toolCallId: id, toolName: 'write', input, content: [{ type: 'text', text: 'ok' }] }, {})
      if (repeated && i === 0) await seat.settled()
    }
    await seat.settled()
    return { rows, sends, consults: rows.filter(r => r.advisor_consult).map(r => r.advisor_consult) }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// MUTATION RJ5: hash altered delivered content; journal identity must match each steer.
test('RJ5 delivered notes match exact content and each consult, including suppression', async () => {
  const { createHash } = await import('node:crypto')
  const r = await rjDrive(JSON.stringify(adGood('auditable delivered claim')))
  assert.deepEqual(r.sends.map(s => s.message.details.tier), [0, 1])
  for (const sent of r.sends) {
    const note = r.rows.find(row => row.advisor_note?.tier === sent.message.details.tier)?.advisor_note
    assert.equal(note.content_sha256, createHash('sha256').update(sent.message.content).digest('hex'))
    assert.equal(note.content_excerpt, advisor.boundText(sent.message.content, 512))
    if (note.tier === 1) assert.equal(note.consult_id, r.consults[0].consult_id)
  }
  const suppressed = await rjDrive(JSON.stringify(adGood('ok')))
  const suppressedNote = suppressed.rows.find(row => row.advisor_note?.outcome === 'suppressed')?.advisor_note
  assert.equal(typeof suppressedNote?.consult_id, 'string')
  assert.equal(suppressedNote.consult_id, suppressed.consults[0].consult_id)
  const twice = await rjDrive([JSON.stringify(adGood('same claim')), JSON.stringify(adGood('same claim'))], { repeated: true })
  assert.equal(twice.consults.length, 2)
  assert.notEqual(twice.consults[0].consult_id, twice.consults[1].consult_id)
  for (const row of twice.rows.filter(item => item.advisor_note?.tier === 1)) {
    const consult = twice.consults.find(item => item.consult_id === row.advisor_note.consult_id)
    assert.ok(consult)
  }
})

// MUTATION RJ6: ignore the injected throwing digest; delivery and settlement remain independent.
test('RJ6 digest failure preserves consult and both note-tier deliveries', async () => {
  const r = await rjDrive(JSON.stringify(adGood('digest failure claim')), { digest: () => { throw new Error('digest failed') } })
  assert.deepEqual({ reply: r.consults[0]?.reply, reason: r.consults[0]?.reply_reason }, { reply: null, reason: 'reply-unrecorded' })
  assert.deepEqual(r.sends.map(s => s.message.details.tier), [0, 1])
  const injected = r.rows.filter(row => row.advisor_note?.outcome === 'injected').map(row => row.advisor_note)
  assert.deepEqual(injected.map(n => n.tier), [0, 1])
  for (const sent of r.sends) {
    const note = injected.find(n => n.tier === sent.message.details.tier)
    assert.equal(note.content_excerpt, advisor.boundText(sent.message.content, 512))
  }
})


// MUTATION TS2: restore the unconditional rejected outcome in the non-judgment branch.
test('TS2 empty reply is journaled as skipped without a tier-one steer', async () => {
  const r = await adDrive('[]')
  assert.deepEqual(adTier1(r).map((note) => ({ outcome: note.outcome, codes: note.codes })),
    [{ outcome: 'skipped', codes: ['no-finding'] }])
  assert.equal(adSent1(r).length, 0)
  const consults = r.rows.filter((row) => row.advisor_consult).map((row) => row.advisor_consult)
  assert.equal(consults.length, 1)
  assert.equal(consults[0].reply.excerpt, '[]')
  const note = adTier1(r)[0]
  assert.equal(Number.isSafeInteger(note.call_ordinal) && note.call_ordinal > 0, true)
  for (const key of ['consult_id', 'provider', 'model_id', 'model', 'agent', 'effort']) {
    assert.deepEqual(note[key], consults[0][key], 'tier1Stamp ' + key)
  }
})

// MUTATION TS4: remove the new no-finding instruction from the emitted prompt contract.
test('TS4 both advisor prompts instruct the no-finding reply', () => {
  const sentence = 'If neither class applies, return [] alone.'
  assert.equal(advisor.BUILDER_SYSTEM_PROMPT.includes(sentence), true)
})

test('a lean lane gives the advisor its scope from the lane planner return written before the seat, dated by the lane start', () => {
  const lane = leanLaneFixture({ planners: [[2, 10_000, { files_in_scope: ['older.mjs'] }], [12, 30_000], [99, -10_000, { files_in_scope: ['stale.mjs'] }]] })
  const cell = { provider: 'openai', id: 'gpt-6.1-sol', agent: 'pi', effort: 'high', model: 'openai/gpt-6.1-sol' }
  writeFileSync(join(lane.taskDir, 'advisor-manifest.json'), JSON.stringify({ schema_version: 1, run_started_at: lane.at, tripwires: ['a.test.mjs'], cell }))
  const context = advisor.loadContext({ taskDir: lane.taskDir, env: lane.env })
  assert.deepEqual(context.files_in_scope, ['a.mjs', 'a.test.mjs'])
  assert.equal(context.validation_lane, 'node --test a.test.mjs')
  assert.equal(context.scope_source, 'planner-return-12')
  assert.deepEqual(context.cell, cell)
  assert.equal(context.run_started_at, lane.at)
  // A seat-time anchor hides a planner return written before the seat; the lane's does not.
  writeFileSync(join(lane.taskDir, 'advisor-manifest.json'), JSON.stringify({ schema_version: 1, run_started_at: Date.now(), tripwires: [], cell }))
  assert.equal(advisor.loadContext({ taskDir: lane.taskDir, env: lane.env }).scope_source, 'absent')
  // Invalid later returns cannot replace the accepted plan, and the parent's returns are never read.
  writeFileSync(join(lane.taskDir, 'advisor-manifest.json'), JSON.stringify({ schema_version: 1, run_started_at: lane.at, tripwires: [], cell }))
  lane.write(13, 40_000, { files_in_scope: 'nope', validation_lane: '' })
  assert.equal(advisor.loadContext({ taskDir: lane.taskDir, env: lane.env }).scope_source, 'planner-return-12')
})


// Shared fixture for consult and advisor state tests.
async function deferredDrive({ replyClaim = 'the deferred consult found the edge' } = {}) {
  const root = scratchDir('advisor-defer-')
  const taskDir = join(root, 'task'), tree = join(root, 'tree'), rows = [], sends = [], requests = []
  mkdirSync(taskDir); mkdirSync(join(root, 'returns')); mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib/widget.mjs'), 'const widget = null\n')
  writeFileSync(join(taskDir, advisor.ADVISOR_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, tripwires: [],
    cell: { provider: 'local', id: 'advisor', agent: 'pi', effort: 'medium', model: 'local/advisor' },
  }))
  writeFileSync(join(taskDir, 'plan.md'), '# plan\n'); writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify({ role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'fixture', details: { subject: 'fix(crew): advisor fixture', plan_path: 'plan.md', tests: [], files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
  let spawned = 0
  const base = {
    taskDir, cwd: tree, fileMtime: () => 2, readFile: p => readFileSync(p, 'utf8'), diffSize: () => null,
    resolveBinary: () => ({ command: '/fake/pi', args: [] }),
    appendFile: (_p, text) => rows.push(...String(text).trim().split('\n').map(JSON.parse)),
    send: (message, options) => sends.push({ message, options }),
    spawn: () => {
      spawned += 1
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
      child.stdin = { end() { setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity: 'medium', claim: replyClaim, evidence: ['lib/widget.mjs:1'] }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + '\n')
        child.emit('close', 0)
      }) } }
      return child
    },
  }
  const envOf = { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir }
  const drive = (seat) => {
    seat.onToolResult({ toolCallId: 'read', toolName: 'read', input: { path: join(tree, 'lib/widget.mjs') }, content: [{ type: 'text', text: 'const widget = null' }] }, {})
    const input = { path: join(tree, 'outside.mjs'), content: 'const outside = null\n' }
    seat.onToolCall({ toolCallId: 'w', toolName: 'write', input }, {})
    seat.onToolResult({ toolCallId: 'w', toolName: 'write', input, content: [{ type: 'text', text: 'ok' }] }, {})
  }
  return { root, rows, sends, requests, base, envOf, drive, spawned: () => spawned }
}

test('advisor state carries the delta, queued triggers and consult count between processes', async () => {
  const h = await deferredDrive()
  try {
    const seat = advisor.createAdvisor({ env: h.envOf, deps: h.base })
    seat.onToolResult({ toolCallId: 'read', toolName: 'read', input: { path: join(h.base.cwd, 'lib/widget.mjs') }, content: [{ type: 'text', text: 'const widget = null' }] }, {})
    seat.onToolCall({ toolCallId: 'w', toolName: 'write', input: { path: join(h.base.cwd, 'outside.mjs'), content: 'x\n' } }, {})
    const state = JSON.parse(JSON.stringify(seat.exportState()))
    assert.ok(state.delta.length > 0)
    assert.deepEqual(state.pending.map(([id]) => id), ['w'])
    const fresh = advisor.createAdvisor({ env: h.envOf, deps: h.base })
    fresh.importState(state)
    assert.deepEqual(fresh.exportState(), state)
    assert.throws(() => fresh.importState({ ...state, delta: [{ text: 1 }] }))
    assert.throws(() => fresh.importState({ ...state, pending: [['w', [{ trigger: 'nope', call_ordinal: 1 }]]] }))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

// ---- diff-growth and pre-return triggers -------------------------------------------------------------------------
function triggerSeat({ severity = 'high', claim = 'must-fix: the empty path is unhandled', evidence = ['lib/widget.mjs:1'], hang = false, extraDeps = {}, manifest = null } = {}) {
  const f = fixture(); const journal = sink(); const diff = { lines: 0, entries: [] }; let spawned = 0; const payloads = []; const prompts = []
  if (manifest) writeFileSync(join(f.taskDir, advisor.ADVISOR_MANIFEST_FILE), JSON.stringify({ schema_version: 1, run_started_at: 1, tripwires: [], cell: { provider: 'provider', id: 'model', agent: 'pi', effort: 'medium', model: 'provider/model' }, ...manifest }))
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    diffSize: () => null, diffLines: () => ({ lines: diff.lines, entries: diff.entries, text: diff.entries.join('\n') }),
    resolveBinary: () => ({ command: '/fake/pi', args: [] }),
    spawn: (_bin, args) => {
      prompts.push(readFileSync(args.at(-1), 'utf8'))
      spawned += 1
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
      child.stdin = { end(value) { payloads.push(JSON.parse(value)); if (hang) return; setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity, claim, evidence }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + '\n')
        child.emit('close', 0)
      }) } }
      return child
    }, ...extraDeps,
  } })
  const ground = () => a.onToolResult({ toolCallId: 'g', toolName: 'read', input: { path: join(f.tree, 'lib/widget.mjs') }, content: [{ type: 'text', text: 'a' }] }, {})
  return { f, journal, diff, a, ground, payloads, prompts, spawned: () => spawned, ret: join(f.taskDir, 'builder-1.json') }
}

test('GD1 a growth-divergence note names the measured, baseline and threshold bytes and tells the builder to continue a planned change', async () => {
  for (const { baseline, measured, threshold, prefix, fallback } of [
    { baseline: 1000, measured: { bytes: 2500, truncated: false }, threshold: 2000, prefix: '' },
    { baseline: 0, measured: { bytes: 120000, truncated: true }, threshold: 120000, prefix: 'at least ' },
    { baseline: null, measured: null, threshold: 120000, fallback: 'both' },
    { baseline: 1000, measured: null, threshold: 2000, fallback: 'content' },
    { baseline: null, measured: { bytes: 120000, truncated: false }, threshold: 120000, fallback: 'baseline' },
  ]) {
    let size = baseline === null ? null : { bytes: baseline, truncated: false }
    const sent = []
    const s = triggerSeat({ extraDeps: { diffSize: () => size, send: (m) => sent.push(m) } })
    try {
      const input = { path: join(s.f.tree, 'lib/widget.mjs'), content: fallback ? 'x'.repeat(120000) : 'x' }
      await s.a.onToolCall(call('w1', 'write', input), {})
      size = measured
      s.a.onToolResult({ toolCallId: 'w1', toolName: 'write', input, content: [{ type: 'text', text: 'ok' }] }, {})
      await s.a.settled()
      const message = sent.find((m) => m.details.kind === 'growth-divergence')
      assert.ok(message)
      if (fallback) {
        assert.ok(message.content.includes('Working-diff measurement was unavailable'))
        assert.ok(message.content.includes(fallback === 'baseline' ? 'working diff size of 120000 bytes' : 'write content size of 120000 bytes'))
        assert.ok(message.content.includes(`${baseline ?? 0}-byte ${fallback === 'content' ? 'measured' : 'fallback'} baseline`))
        assert.ok(message.content.includes(`${threshold}-byte threshold`))
        assert.ok(message.content.includes('may not reflect diff growth'))
      } else {
        assert.ok(message.content.includes(`${prefix}${measured.bytes} bytes`))
        assert.ok(message.content.includes(`${baseline}-byte baseline`))
        assert.ok(message.content.includes(`${threshold}-byte growth threshold`))
      }
      assert.ok(message.content.includes('This measures size only, not a fault'))
      assert.ok(message.content.includes('if the plan asks for this change, continue it'))
    } finally { rmSync(s.f.root, { recursive: true, force: true }) }
  }
})

// MUTATION: consult on every maybe and twenty of them use up the cap before the sure return.
test('only one maybe-return per turn is consulted on, so the sure return still gets its consult under the cap', async () => {
  const s = triggerSeat({ severity: 'medium' })
  try {
    s.ground()
    const maybes = Array.from({ length: advisor.TIER1_MAX_CONSULTS }, (_, i) => s.a.onToolCall(call(`m${i}`, 'bash', { command: "printf '(no)' > lib/builder-1.json" }), {}))
    await Promise.all(maybes)
    assert.equal(s.spawned(), 1, 'one maybe consult per turn, even when the calls run in parallel')
    assert.equal(s.a.exportState().pre_return_maybe_spent, true)
    await s.a.onToolCall(call('r', 'write', { path: s.ret, content: '{}' }), {})
    assert.equal(s.spawned(), 2, 'the sure return is still consulted')
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

// MUTATION: keep the maybe slot when its consult never ran and a later maybe-return goes unreviewed.
test('a maybe-return whose consult never ran gives the maybe slot back', async () => {
  const s = triggerSeat()
  try {
    await s.a.onToolCall(call('m0', 'bash', { command: "printf '(no)' > lib/builder-1.json" }), {})
    assert.equal(s.spawned(), 0, 'nothing grounded yet, so no consult ran')
    assert.equal(s.a.exportState().pre_return_maybe_spent, false)
    s.ground()
    assert.equal((await s.a.onToolCall(call('m1', 'bash', { command: `pushd ${s.f.taskDir}; printf x > builder-1.json` }), {}))?.block, true)
    assert.equal(s.spawned(), 1)
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

test('a bash command names the return file by its absolute path, or by its bare name after a cd into the task dir; nothing else is a return write', async () => {
  for (const command of ['cd TASK; cat > builder-1.json <<EOF\n{}\nEOF', "cd TASK && printf '{}' >builder-1.json", 'cd "TASK" && tee "builder-1.json" < x', 'cat > TASK/builder-1.json <<EOF\n{}\nEOF', 'cd TASK && cat > ./builder-1.json', 'cd TREE; cat > ../task/builder-1.json <<EOF\n{}\nEOF', "cd TASK; (cd TREE; true); printf '{}' > builder-1.json", "cd '/a dir/with space'; printf '{}' > builder-1.json", 'pushd TASK; cat > builder-1.json']) {
    const s = triggerSeat()
    try {
      s.ground()
      const verdict = await s.a.onToolCall(call('r1', 'bash', { command: command.replaceAll('TASK', s.f.taskDir).replaceAll('TREE', s.f.tree) }), {})
      assert.equal(verdict?.block, true, command)
    } finally { rmSync(s.f.root, { recursive: true, force: true }) }
  }
  for (const command of ['cat old-builder-1.json', 'cat builder-1.json.bak', 'cat planner-1.json', 'tee builder-1.json < x', 'cd TREE && cat > lib/builder-1.json', 'cd TASK-evil; cat > builder-1.json', 'cat > TREE/lib/builder-1.json', 'cp x TASK/builder-1.json.bak', 'cd TASK && cat > sub/builder-1.json', "(cd TREE; printf x > TREE/lib/builder-1.json)"]) {
    const s = triggerSeat()
    try {
      s.ground()
      assert.equal(await s.a.onToolCall(call('x', 'bash', { command: command.replaceAll('TASK', s.f.taskDir).replaceAll('TREE', s.f.tree) }), {}), undefined, command)
      assert.equal(s.spawned(), 0, command)
    } finally { rmSync(s.f.root, { recursive: true, force: true }) }
  }
})

test('a pre-return consult stays inside TIER1_MAX_CONSULTS and lets the write through at the cap', async () => {
  const s = triggerSeat()
  try {
    s.ground()
    const state = s.a.exportState(); state.consults = advisor.TIER1_MAX_CONSULTS
    s.a.importState(state)
    assert.equal(await s.a.onToolCall(call('r1', 'write', { path: s.ret, content: '{}' }), {}), undefined)
    assert.equal(s.spawned(), 0)
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

// MUTATION: ground only added lines and a deletion-only diff has nothing to consult on.
test('a deletion-only diff is grounded at its old path and lines, and a removed line starting "-- " is content', () => {
  const diff = ['diff --git a/lib/gone.mjs b/lib/gone.mjs', 'deleted file mode 100644', '--- a/lib/gone.mjs', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-alpha', '-beta', '-gamma',
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +0,0 @@', '--- important', '-BUG: severe', ''].join('\n')
  const exec = (_bin, args) => Buffer.from(args.includes('diff') ? diff : '')
  const measured = advisor.gitDiffLines({ cwd: '/repo', deps: { execFileSync: exec } })
  assert.equal(measured.lines, 5)
  assert.match(measured.text, /^lib\/gone\.mjs:1: \(removed\) alpha$/m)
  assert.match(measured.text, /^lib\/gone\.mjs:3: \(removed\) gamma$/m)
  assert.match(measured.text, /^a\.txt:1: \(removed\) -- important$/m)
  assert.match(measured.text, /^a\.txt:2: \(removed\) BUG: severe$/m)
  assert.doesNotMatch(measured.text, /^important:/m)
})

// MUTATION: count an untracked file past the read cap as zero lines and a lane that only adds it never consults.
test('an untracked file past the read cap is counted by streaming and grounded; past the count cap its lines are unknown', () => {
  const exec = (_bin, args) => Buffer.from(args.includes('diff') ? '' : 'big.txt\0')
  const base = { execFileSync: exec, fileSize: () => 1024 * 1024 + 1, readFileBytes: () => { throw new Error('must not read whole past the cap') }, readFileHead: () => Buffer.from('first\nsecond\n') }
  const counted = advisor.gitDiffLines({ cwd: '/repo', deps: { ...base, countFileLines: () => 26 } })
  assert.equal(counted.lines, 26)
  assert.equal(counted.truncated, false)
  assert.match(counted.text, /^big\.txt:1: first$/m)
  const unknown = advisor.gitDiffLines({ cwd: '/repo', deps: { ...base, countFileLines: () => null } })
  assert.equal(unknown.truncated, true, 'an unknown count is the overflow shape, never zero')
  assert.ok(unknown.lines >= advisor.DIFF_GROWTH_LINES)
  const binary = advisor.gitDiffLines({ cwd: '/repo', deps: { ...base, readFileHead: () => Buffer.from([1, 0, 2]), countFileLines: () => { throw new Error('binary is not counted') } } })
  assert.equal(binary.lines, 0)
})

// MUTATION: make the real streaming counter return zero and a real untracked file past the read cap counts as no lines.
test('a real untracked text file past the read cap is counted exactly by the streaming counter', () => {
  const root = join(process.env.TMPDIR || '/tmp', `advisor-big-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: root })
    writeFileSync(join(root, 'big.txt'), `${'y'.repeat(1023)}\n`.repeat(2048) + 'tail')
    const measured = advisor.gitDiffLines({ cwd: root })
    assert.equal(measured.truncated, false)
    assert.equal(measured.lines, 2049, '2,048 terminated lines plus the unterminated tail')
    assert.match(measured.text, /^big\.txt:1: y+$/m)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: let dedupe or one-per-update suppress a pre-return finding and an earlier warning lets the return through.
for (const severity of ['medium']) test(`a ${severity} pre-return finding blocks even when diff growth already delivered the same claim`, async () => {
  const s = triggerSeat({ severity })
  try {
    s.ground()
    s.diff.lines = 0; s.diff.entries = ['lib/widget.mjs:1: x']
    const bash = async (id) => { await s.a.onToolCall(call(id, 'bash', { command: 'sed -i x' }), {}); s.a.onToolResult({ toolCallId: id, toolName: 'bash', input: { command: 'sed -i x' }, content: [{ type: 'text', text: 'ok' }] }, {}); await s.a.settled() }
    await bash('b0')
    s.diff.lines = advisor.DIFF_GROWTH_LINES
    await bash('b1')
    assert.ok(s.journal.rows.some((row) => row.advisor_note?.trigger === 'diff-growth' && row.advisor_note.outcome === 'injected'))
    const verdict = await s.a.onToolCall(call('r1', 'write', { path: s.ret, content: '{}\n' }), {})
    assert.deepEqual(verdict, { block: true, reason: 'must-fix: the empty path is unhandled' })
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

test('the diff baseline and the pre-return flag survive exportState and importState; malformed values are refused', () => {
  const s = triggerSeat()
  try {
    s.diff.lines = 7; s.a.onToolResult({ toolCallId: 'g', toolName: 'read', input: {}, content: [] }, {})
    const state = JSON.parse(JSON.stringify({ ...s.a.exportState(), pre_return_spent: true }))
    assert.equal(state.diff_baseline_lines, 7)
    const fresh = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: s.f.taskDir }), deps: { cwd: s.f.tree, taskDir: s.f.taskDir, appendFile: () => {}, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2 } })
    fresh.importState(state)
    assert.deepEqual([fresh.exportState().diff_baseline_lines, fresh.exportState().pre_return_spent], [7, true])
    assert.throws(() => fresh.importState({ ...state, pre_return_spent: 'yes' }), /malformed/)
    assert.throws(() => fresh.importState({ ...state, diff_baseline_lines: -1 }), /malformed/)
    const { diff_baseline_lines, pre_return_spent, ...old } = state
    fresh.importState(old)
    assert.deepEqual([fresh.exportState().diff_baseline_lines, fresh.exportState().pre_return_spent], [null, false])
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

test('gitDiffLines counts added plus removed lines against HEAD, untracked files included, and grounds an entry per file', () => {
  const root = scratchDir('advisor-difflines-')
  const run = (...args) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' })
  try {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2]))
    run('init', '-q'); run('add', '.'); run('commit', '-qm', 'base')
    assert.equal(advisor.gitDiffLines({ cwd: root }).lines, 0)
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\n') // +2 -1
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 9, 9, 9]))
    writeFileSync(join(root, 'new.txt'), 'x\ny\nz')
    writeFileSync(join(root, 'new.bin'), Buffer.from([0, 1]))
    const result = advisor.gitDiffLines({ cwd: root })
    assert.equal(result.lines, 3 + 3)
    assert.ok(result.text.includes('a.txt:2: TWO'))
    assert.ok(result.text.includes('new.txt:1: x'))
    assert.equal(advisor.gitDiffLines({ cwd: join(root, 'missing') }), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---- pre-return whole-diff window --------------------------------------------------------------------------------
const deltaOf = (payload) => payload.delta.map((entry) => entry.text).join('\n')
const consultRow = (s) => s.journal.rows.find((row) => row.advisor_consult?.trigger === 'pre-return').advisor_consult

test('PW1 a pre-return consult carries a change on line 200 of a committed file, with no prior grounding', async () => {
  const s = triggerSeat({ severity: 'medium', extraDeps: { diffLines: (cwd) => advisor.gitDiffLines({ cwd }) } })
  try {
    const repo = s.f.tree; const git = (...args) => execFileSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' })
    const lines = Array.from({ length: 250 }, (_, i) => `const v${i + 1} = ${i + 1}`)
    writeFileSync(join(repo, 'lib/big.mjs'), lines.join('\n') + '\n'); git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base')
    lines[199] = 'const v200 = "changed"'; writeFileSync(join(repo, 'lib/big.mjs'), lines.join('\n') + '\n')
    await s.a.onToolCall(call('r1', 'write', { path: s.ret, content: '{}\n' }), {})
    assert.equal(s.payloads.length, 1)
    assert.equal(s.payloads[0].trigger, 'pre-return')
    assert.ok(deltaOf(s.payloads[0]).includes('lib/big.mjs:200: const v200 = "changed"'))
    assert.ok(!deltaOf(s.payloads[0]).includes('lib/big.mjs:1:'), 'only changed lines are grounded')
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

// MUTATION: send acceptance_items instead of criteria
test('PW2 a pre-return consult carries the accepted plan criteria and named tests and asks for a check against them', async () => {
  const items = ['1. WHEN a THE b SHALL c']
  const tests = [{ file: 'a.test.mjs', title: 'T' }]
  const s = triggerSeat({ manifest: { criteria: [...items, ' '], tests } })
  try {
    s.ground()
    await s.a.onToolCall(call('r1', 'write', { path: s.ret, content: '{}\n' }), {})
    assert.deepEqual(s.payloads[0].criteria, items)
    assert.deepEqual(s.payloads[0].tests, tests)
    assert.match(s.prompts[0], /criteria/)
    assert.ok(!s.prompts[0].includes(advisor.PRE_RETURN_NO_BASIS))
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
  const bad = triggerSeat({ manifest: { criteria: [1] } })
  try {
    bad.ground()
    await bad.a.onToolCall(call('r1', 'write', { path: bad.ret, content: '{}\n' }), {})
    assert.deepEqual(bad.payloads[0].criteria, [])
  } finally { rmSync(bad.f.root, { recursive: true, force: true }) }
})

test('PW3 the byte budget holds after redaction expands the packed text', async () => {
  const files = [{ path: 'big.txt', lines: Array.from({ length: 3000 }, (_, i) => `big.txt:${i + 1}: Authorization: x`) }]
  const s = triggerSeat({ extraDeps: { diffLines: () => ({ lines: 3000, entries: [files[0].lines.slice(0, 12).join('\n')], files }) } })
  try {
    await s.a.onToolCall(call('r1', 'write', { path: s.ret, content: '{}\n' }), {})
    const payload = s.payloads[0]; const bytes = Buffer.byteLength(deltaOf(payload), 'utf8')
    assert.ok(deltaOf(payload).includes('<redacted:authorization>'))
    assert.ok(bytes <= advisor.PRE_RETURN_DIFF_BUDGET_BYTES, `${bytes} bytes`)
    assert.ok(payload.omitted_files.includes('big.txt'))
    assert.equal(consultRow(s).window_bytes, bytes)
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

test('PW3 git output over the cap is stated as an incomplete window and names the files it could not read', async () => {
  const overflow = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' })
  const exec = (cmd, args) => { if (args.includes('--name-only') || args.includes('--others')) return Buffer.from(args.includes('--others') ? 'new.txt\0' : 'a.txt\0b.txt\0'); throw overflow }
  const packed = advisor.preReturnDiff({ cwd: '/x', deps: { execFileSync: exec } })
  assert.deepEqual(packed.entries, [])
  assert.deepEqual(packed.omitted_files, ['a.txt', 'b.txt', 'new.txt', advisor.PRE_RETURN_INCOMPLETE])
  const s = triggerSeat({ extraDeps: { diffLines: (cwd) => advisor.gitDiffLines({ cwd, deps: { execFileSync: exec } }) } })
  try {
    s.ground()
    await s.a.onToolCall(call('r1', 'write', { path: s.ret, content: '{}\n' }), {})
    assert.deepEqual(s.payloads[0].omitted_files, packed.omitted_files)
    assert.deepEqual(consultRow(s).omitted_files, packed.omitted_files)
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})

test('PS1 PS2 a pre-return consult drops an injected advisor note from the working diff and keeps grounded evidence', async () => {
  const phrase = 'guard misses the null path entirely'
  const grounded = 'lib/copied.mjs:4: const grounded = keepThisLine()'
  const files = [
    { path: 'lib/copied.mjs', lines: [`lib/copied.mjs:3: ${phrase}`, grounded] },
    { path: 'lib/noteonly.mjs', lines: [phrase] },
  ]
  const s = triggerSeat({ severity: 'medium', evidence: ['lib/copied.mjs:4'], extraDeps: { diffLines: () => ({ lines: 3, entries: files.map((file) => file.lines.join('\n')), files }) } })
  try {
    const state = s.a.exportState(); state.injected = [advisor.normalizeNote(phrase)]
    s.a.importState(state)
    await s.a.onToolCall(call('r1', 'write', { path: s.ret, content: '{}\n' }), {})
    const payload = s.payloads[0]
    assert.equal(payload.trigger, 'pre-return')
    assert.ok(!deltaOf(payload).includes(phrase), 'the injected note is not handed back')
    assert.ok(payload.delta.every((entry) => entry.text.trim()), 'a note-only entry is dropped, not sent empty')
    assert.equal(payload.delta.length, 1)
    assert.ok(deltaOf(payload).includes(grounded), 'grounded non-note evidence keeps its anchor')
    const note = s.journal.rows.find((row) => row.advisor_note?.trigger === 'pre-return' && row.advisor_note.outcome === 'injected')
    assert.ok(note, 'a finding citing the kept line is accepted')
  } finally { rmSync(s.f.root, { recursive: true, force: true }) }
})
