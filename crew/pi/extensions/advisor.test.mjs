import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as advisor from './advisor.ts'
import { seatCommand } from '../../adapters/adapter-pi.mjs'
import {
  ADVISOR_BOOT_REFUSALS as bootAdvisorRefusals, classifyAdvisorCell as bootClassifyAdvisorCell,
  DEFAULT_TRANSPORT, advisorBootRecord, assertAdvisorCellLive,
} from '../../crew.mjs'
import { scratchDir } from '../../../test/helpers.mjs'
function fixture() {
  const root = scratchDir('advisor-test-')
  const taskDir = join(root, 'task')
  const returns = join(root, 'returns')
  const tree = join(root, 'tree')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(returns, { recursive: true }); mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib', 'widget.mjs'), 'a\nb\nc\n')
  writeFileSync(join(taskDir, advisor.TRIPWIRE_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, tripwires: ['lib/widget.test.mjs'], cell: { provider: 'provider', id: 'model', agent: 'pi', effort: 'medium', model: 'provider/model' },
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


function fakeChild({ exitCode = 0, invalid = false, hang = false } = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = []
  child.stdin = { end(value) { if (hang) return; setImmediate(() => {
    const request = JSON.parse(value)
    const anchor = request.delta.flatMap((entry) => String(entry.text).split('\n')).map((line) => /^([^:]+(?:\/[^:]+)*:\d+): /.exec(line)?.[1]).find(Boolean) || 'lib/widget.mjs:2'
    const judgment = { class: 'edge-path', severity: 'medium', claim: 'guard handles a grounded edge case', evidence: [anchor] }
    child.stdout.write(invalid ? 'not-json\n' : `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify(judgment), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } })}\n`)
    child.emit('close', exitCode)
  }) } }
  child.kill = (signal) => { child.kills.push(signal); return true }
  return child
}

async function runManifestConsult({ cell = { provider: 'local', id: 'advisor-v1', agent: 'pi', effort: 'high', model: 'local/advisor-v1' }, childOptions = {}, envExtra = {}, timerDeps = {}, resolveBinary = () => ({ command: '/fake/pi', args: [] }) } = {}) {
  const f = fixture(); const journal = sink(); let argv; let spawned = 0; let fetched = 0
  const manifestPath = join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.cell = cell
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, ...envExtra }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    binaryDeps: {}, resolveBinary,
    spawn: (_bin, args) => { argv = args; spawned++; return fakeChild(childOptions) },
    fetchFn: async () => { fetched++; throw new Error('fetch must not run') }, ...timerDeps,
  } })
  const source = join(f.tree, 'lib/widget.mjs')
  a.onToolResult(result('ground', 'read', { path: source, offset: 1 }, 'lib/widget.mjs:2: grounded condition'), {})
  const target = join(f.tree, 'lib/widget.test.mjs'); writeFileSync(target, 'test\n')
  const change = { path: target, content: 'test\n' }
  a.onToolCall(call('fire', 'write', change), {})
  a.onToolResult(result('fire', 'write', change, 'ok'), {})
  await a.settled()
  return { f, journal, a, argv, spawned, fetched }
}

test('ADR47-L2 A1 child argv disables tools and context files', async () => { const r = await runManifestConsult(); assert.deepEqual(r.argv.slice(0, 13), ['-p','--mode','json','--no-session','--model','local/advisor-v1','--thinking','high','--no-tools','--no-context-files','--no-extensions','--no-skills','--append-system-prompt']); assert.equal(r.argv.length,14) })
test('ADR47-L2 A2 child model comes from manifest rather than environment', async () => { const r = await runManifestConsult({ envExtra: { CREW_ADVISOR_MODEL: 'env/wrong' } }); assert.equal(r.argv[r.argv.indexOf('--model') + 1], 'local/advisor-v1') })
test('ADR47-L2 A3 child thinking uses manifest effort', async () => { const r = await runManifestConsult(); assert.equal(r.argv[r.argv.indexOf('--thinking') + 1], 'high') })
test('ADR47-L2 B1 endpoint environment never invokes fetch', async () => { const r = await runManifestConsult({ envExtra: { CREW_ADVISOR_ENDPOINT: 'http://127.0.0.1:9999' } }); assert.equal(r.fetched, 0); assert.equal(r.spawned, 1) })
test('ADR47-L2 C1 null-cell attach still emits an injected tripwire tier-zero note', async () => {
  const f = fixture()
  const manifestPath = join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.cell = null
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const journal = sink(); const p = pi()
  await advisor.attachAdvisor(p, {
    env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir },
    deps: {
      taskDir: f.taskDir, cwd: f.tree, appendFile: journal.appendFile,
      readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
      spawn: () => { throw new Error('null-cell tripwire must not spawn') },
    },
  })
  const onCall = p.handlers.find(([event]) => event === 'tool_call')?.[1]
  assert.equal(typeof onCall, 'function')
  onCall(call('c1', 'write', { path: join(f.tree, 'lib/widget.test.mjs'), content: 'test' }), {})
  const note = journal.rows.find((row) => row.advisor_note?.tier === 0)?.advisor_note
  assert.equal(note?.kind, advisor.TRIPWIRE_TOUCH)
  assert.equal(note?.outcome, 'injected')
  rmSync(f.root, { recursive: true, force: true })
})
test('ADR47-L2 C2 null cell suppresses repeated consult and spawn', async () => { const f = fixture(); const m = JSON.parse(readFileSync(join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE))); m.cell = null; writeFileSync(join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE), JSON.stringify(m)); const journal = sink(); let spawnCount = 0; const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR:f.taskDir }), deps: { taskDir:f.taskDir,cwd:f.tree,appendFile:journal.appendFile,readFile:(p)=>readFileSync(p,'utf8'),fileMtime:()=>2,spawn:()=>{spawnCount++} } }); for(let i=1;i<=25;i++){a.onToolCall(call(String(i),'read',{}),{});a.onToolResult(result(String(i),'read',{},'ok'),{})} await a.settled(); assert.equal(spawnCount,0); assert.equal(journal.rows.some((r)=>r.advisor_consult),false); assert.equal(journal.rows.some((r)=>r.advisor_note?.tier===1),false); rmSync(f.root,{recursive:true,force:true}) })
test('ADR47-L2 C3 grant attaches without a manifest or retired model environment', async () => {
  const f = fixture(); rmSync(join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE))
  const p = pi(); const journal = sink()
  await advisor.attachAdvisor(p, {
    env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir },
    deps: { taskDir: f.taskDir, appendFile: journal.appendFile },
  })
  assert.deepEqual(p.handlers.map(([event]) => event).sort(), ['tool_call', 'tool_result'])
  assert.equal(journal.rows.find((row) => row.advisor_boot)?.advisor_boot.outcome, 'attached')
  rmSync(f.root, { recursive: true, force: true })
})
test('ADR47-L2 D1 consult audit carries manifest identity', async () => { const r=await runManifestConsult(); const row=r.journal.rows.find(x=>x.advisor_consult).advisor_consult; assert.deepEqual([row.provider,row.model_id,row.agent,row.effort,row.model],['local','advisor-v1','pi','high','local/advisor-v1']) })
test('ADR47-L2 D2 usage audit carries manifest identity', async () => { const r=await runManifestConsult(); const row=r.journal.rows.find(x=>x.advisor_usage).advisor_usage; assert.deepEqual([row.provider,row.model_id,row.agent,row.effort,row.model],['local','advisor-v1','pi','high','local/advisor-v1']) })
test('ADR47-L2 E1 cadence consult retains ordinal 25 after calls 26 and 27', async () => { const f=fixture(); const journal=sink(); const manifest=JSON.parse(readFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE))); manifest.cell={provider:'local',id:'advisor-v1',agent:'pi',effort:'high',model:'local/advisor-v1'}; writeFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE),JSON.stringify(manifest)); let spawned=0; const a=advisor.createAdvisor({env:env({CREW_TASK_DIR:f.taskDir}),deps:{cwd:f.tree,taskDir:f.taskDir,appendFile:journal.appendFile,readFile:(p)=>readFileSync(p,'utf8'),fileMtime:()=>2,resolveBinary:()=>({command:'/fake/pi'}),spawn:()=>{spawned++;return fakeChild()}}}); a.onToolResult(result('ground','read',{path:join(f.tree,'lib/widget.mjs')},'lib/widget.mjs:2: grounded'),{}); for(let i=1;i<=27;i++) a.onToolCall(call(String(i),'read',{}),{}); a.onToolResult(result('25','read',{},'ok'),{}); await a.settled(); const notes=journal.rows.filter(x=>x.advisor_note?.tier===1&&x.advisor_note.outcome!=='skipped').map(x=>x.advisor_note); assert.equal(spawned,1); assert.equal(notes.length,1); assert.equal(notes[0].call_ordinal,25); rmSync(f.root,{recursive:true,force:true}) })
test('ADR47-L2 E2 tier zero note stamps its firing call ordinal', async () => { const r=await runManifestConsult(); const note=r.journal.rows.find(x=>x.advisor_note?.tier===0)?.advisor_note; assert.equal(note.call_ordinal,1) })
test('RV1-1 guard C1 null-cell attach preserves tripwire tier-zero behavior', async () => {
  const f = fixture(); const manifestPath = join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.cell = null
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const journal = sink(); const p = pi()
  await advisor.attachAdvisor(p, { env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir }, deps: {
    taskDir: f.taskDir, cwd: f.tree, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
  } })
  p.handlers.find(([event]) => event === 'tool_call')[1](call('guard-c1', 'write', { path: join(f.tree, 'lib/widget.test.mjs'), content: 'test' }), {})
  assert.equal(journal.rows.find((row) => row.advisor_note?.tier === 0)?.advisor_note.outcome, 'injected')
  rmSync(f.root, { recursive: true, force: true })
})
test('RV1-1 guard C2 null-cell cadence writes no tier-one notes', async () => {
  const f = fixture(); const manifestPath = join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.cell = null
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const journal = sink(); const a = advisor.createAdvisor({ env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir }, deps: {
    taskDir: f.taskDir, cwd: f.tree, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
  } })
  for (let i = 1; i <= 25; i++) { a.onToolCall(call(`guard-c2-${i}`, 'read', {}), {}); a.onToolResult(result(`guard-c2-${i}`, 'read', {}, 'ok'), {}) }
  await a.settled()
  assert.equal(journal.rows.some((row) => row.advisor_note?.tier === 1), false)
  rmSync(f.root, { recursive: true, force: true })
})
test('RV1-1 guard C3 grant attaches without manifest or model environment', async () => {
  const f = fixture(); rmSync(join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE))
  const journal = sink(); const p = pi()
  await advisor.attachAdvisor(p, { env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir }, deps: { taskDir: f.taskDir, appendFile: journal.appendFile } })
  assert.deepEqual(p.handlers.map(([event]) => event).sort(), ['tool_call', 'tool_result'])
  assert.equal(journal.rows.find((row) => row.advisor_boot)?.advisor_boot.outcome, 'attached')
  rmSync(f.root, { recursive: true, force: true })
})
// Kills: `cell_invalid` forced false (or the attach check deleted). A present cell that fails
// the allowlist must refuse loudly, never attach as a silent tier-0-only seat; null still attaches.
test('a malformed manifest cell refuses attach while an explicit null cell attaches', async () => {
  for (const [cell, outcome] of [[{ provider: 'p', id: 'm', agent: 'pi', effort: null, model: 'p/m' }, 'refused'], [null, 'attached']]) {
    const f = fixture(); const manifestPath = join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)
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
test('RV1-1 guard E1 cadence note keeps ordinal 25 across later issued calls', async () => {
  const f = fixture(); const journal = sink(); let spawned = 0
  const a = advisor.createAdvisor({ env: { CREW_ADVISOR: '1', CREW_ROLE: 'builder', CREW_TASK_DIR: f.taskDir }, deps: {
    taskDir: f.taskDir, cwd: f.tree, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    resolveBinary: () => ({ command: '/fake/pi' }), spawn: () => { spawned++; return fakeChild() },
  } })
  a.onToolResult(result('guard-ground', 'read', { path: join(f.tree, 'lib/widget.mjs') }, 'lib/widget.mjs:2: grounded'), {})
  for (let i = 1; i <= 27; i++) a.onToolCall(call(String(i), 'read', {}), {})
  a.onToolResult(result('25', 'read', {}, 'ok'), {})
  await a.settled()
  const notes = journal.rows.filter((row) => row.advisor_note?.tier === 1 && row.advisor_note.outcome !== 'skipped').map((row) => row.advisor_note)
  assert.equal(spawned, 1)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].call_ordinal, 25)
  rmSync(f.root, { recursive: true, force: true })
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
test('ADR47-L2 F1 timeout journals bounded cell failure', async () => { const callbacks=[]; const timers={setTimeout(fn){callbacks.push(fn);return callbacks.length},clearTimeout(){}}; const f=fixture(); const m=JSON.parse(readFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE))); m.cell={provider:'local',id:'advisor-v1',agent:'pi',effort:'high',model:'local/advisor-v1'}; writeFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE),JSON.stringify(m)); const journal=sink(); const a=advisor.createAdvisor({env:env({CREW_TASK_DIR:f.taskDir}),deps:{cwd:f.tree,taskDir:f.taskDir,appendFile:journal.appendFile,readFile:(p)=>readFileSync(p,'utf8'),fileMtime:()=>2,resolveBinary:()=>({command:'/fake/pi'}),spawn:()=>fakeChild({hang:true}),setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,consultTimeoutMs:5,childKillGraceMs:1}}); a.onToolResult(result('g','read',{path:join(f.tree,'lib/widget.mjs')},'lib/widget.mjs:2: grounded'),{}); const path=join(f.tree,'lib/widget.test.mjs'); a.onToolCall(call('f','write',{path,content:'x'}),{}); a.onToolResult(result('f','write',{path,content:'x'},'ok'),{}); for(let i=0;i<8;i++){callbacks.shift()?.();await new Promise(r=>setImmediate(r))} await a.settled(); const row=journal.rows.find(x=>x.advisor_cell_failure)?.advisor_cell_failure; assert.equal(row.kind,'timeout'); assert.equal(row.model_id,'advisor-v1'); assert.equal(row.provider,'local'); rmSync(f.root,{recursive:true,force:true}) })
test('ADR47-L2 F2 timeout rejection uses timeout code', async () => { const callbacks=[]; const f=fixture(); const m=JSON.parse(readFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE))); m.cell={provider:'local',id:'advisor-v1',agent:'pi',effort:'high',model:'local/advisor-v1'}; writeFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE),JSON.stringify(m)); const journal=sink(); const a=advisor.createAdvisor({env:env({CREW_TASK_DIR:f.taskDir}),deps:{cwd:f.tree,taskDir:f.taskDir,appendFile:journal.appendFile,readFile:(p)=>readFileSync(p,'utf8'),fileMtime:()=>2,resolveBinary:()=>({command:'/fake/pi'}),spawn:()=>fakeChild({hang:true}),setTimeout(fn){callbacks.push(fn);return callbacks.length},clearTimeout(){},consultTimeoutMs:5,childKillGraceMs:1}}); a.onToolResult(result('g','read',{path:join(f.tree,'lib/widget.mjs')},'lib/widget.mjs:2: grounded'),{}); const path=join(f.tree,'lib/widget.test.mjs'); a.onToolCall(call('f','write',{path,content:'x'}),{}); a.onToolResult(result('f','write',{path,content:'x'},'ok'),{}); for(let i=0;i<8;i++){callbacks.shift()?.();await new Promise(r=>setImmediate(r))} await a.settled(); assert.ok(journal.rows.find(x=>x.advisor_note?.outcome==='rejected').advisor_note.codes.includes('timeout')); rmSync(f.root,{recursive:true,force:true}) })
test('ADR47-L2 F3 nonzero child exit journals transport failure', async () => { const r=await runManifestConsult({childOptions:{exitCode:1}}); const row=r.journal.rows.find(x=>x.advisor_cell_failure)?.advisor_cell_failure; assert.equal(row.kind,'transport-error'); assert.equal(r.journal.rows.filter(x=>x.advisor_cell_failure).length,1) })
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
  const manifestPath = join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')); m.cell = { provider: 'local', id: 'advisor-v1', agent: 'pi', effort: 'high', model: 'local/advisor-v1' }
  writeFileSync(manifestPath, JSON.stringify(m))
  const child = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true
    c.stdin = { end() { setImmediate(() => c.stdout.write(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'partial', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } } })}\n`)) } }
    return c
  }
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: { cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (p) => readFileSync(p, 'utf8'), fileMtime: () => 2, resolveBinary: () => ({ command: '/fake/pi' }), spawn: child, setTimeout(fn) { callbacks.push(fn); return callbacks.length }, clearTimeout() {}, consultTimeoutMs: 5, childKillGraceMs: 1 } })
  const source = join(f.tree, 'lib/widget.mjs'); const path = join(f.tree, 'lib/widget.test.mjs')
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
    const manifestPath = join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')); m.cell = { provider: 'local', id: 'advisor-v1', agent: 'pi', effort: 'high', model: 'local/advisor-v1' }
    writeFileSync(manifestPath, JSON.stringify(m))
    const child = () => {
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true
      c.stdin = { end() { setImmediate(() => c.stdout.emit('error', new Error('broken pipe'))) } }
      return c
    }
    const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: { cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (p) => readFileSync(p, 'utf8'), fileMtime: () => 2, resolveBinary: () => ({ command: '/fake/pi' }), spawn: child, setTimeout(fn) { callbacks.push(fn); return callbacks.length }, clearTimeout() {}, consultTimeoutMs: 5, childKillGraceMs: 1 } })
    const source = join(f.tree, 'lib/widget.mjs'); const path = join(f.tree, 'lib/widget.test.mjs')
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

test('ADR47-L2 F4 invalid clean judgment is rejected without transport failure', async () => { const f=fixture(); const m=JSON.parse(readFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE))); m.cell={provider:'local',id:'advisor-v1',agent:'pi',effort:'high',model:'local/advisor-v1'}; writeFileSync(join(f.taskDir,advisor.TRIPWIRE_MANIFEST_FILE),JSON.stringify(m)); const journal=sink(); const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.stdin={end(){setImmediate(()=>{child.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:JSON.stringify({class:'bogus',severity:'low',claim:'bad judgment',evidence:['lib/widget.mjs:2']})}})+'\n');child.emit('close',0)})}}; child.kill=()=>true; const a=advisor.createAdvisor({env:env({CREW_TASK_DIR:f.taskDir}),deps:{cwd:f.tree,taskDir:f.taskDir,appendFile:journal.appendFile,readFile:(p)=>readFileSync(p,'utf8'),fileMtime:()=>2,resolveBinary:()=>({command:'/fake/pi'}),spawn:()=>child}}); a.onToolResult(result('g','read',{path:join(f.tree,'lib/widget.mjs')},'lib/widget.mjs:2: grounded'),{}); const path=join(f.tree,'lib/widget.test.mjs'); a.onToolCall(call('f','write',{path,content:'x'}),{}); a.onToolResult(result('f','write',{path,content:'x'},'ok'),{}); await a.settled(); assert.ok(journal.rows.find(x=>x.advisor_note?.outcome==='rejected')); assert.equal(journal.rows.some(x=>x.advisor_cell_failure),false); rmSync(f.root,{recursive:true,force:true}) })

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
  assert.ok(imports.every((specifier) => specifier.startsWith('node:') || specifier === './subagent.ts'))
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

test('extension admits the canonical LAN endpoint/model cell', () => {
  assert.deepEqual(advisor.classifyAdvisorCell(sharedAdvisorCells[1]), {
    endpoint: 'http://10.112.20.20:8080/v1', model: 'qwen3-coder',
  })
})

test('B1 extension retains exact refusal reasons for invalid cells', () => {
  const refusals = [
    [sharedAdvisorCells[4], { reason: 'endpoint-not-local' }],
    [sharedAdvisorCells[5], { reason: 'endpoint-credentials' }],
    [sharedAdvisorCells[6], { reason: 'endpoint-not-local' }],
    [sharedAdvisorCells[7], { reason: 'model-unset' }],
    [sharedAdvisorCells[8], { reason: 'model-unsafe' }],
    [sharedAdvisorCells[9], { reason: 'model-unsafe' }],
  ]
  for (const [cell, expected] of refusals) assert.deepEqual(advisor.classifyAdvisorCell(cell), expected)
})

test('RV1-1 extension classifies an unset endpoint without roster membership as model-unsafe', () => {
  assert.deepEqual(advisor.classifyAdvisorCell(sharedAdvisorCells[9]), { reason: 'model-unsafe' })
})

test('C1 extension and boot classifiers agree across the shared input table', () => {
  const extensionVerdicts = sharedAdvisorCells.map((cell) => advisor.classifyAdvisorCell(cell))
  const bootVerdicts = sharedAdvisorCells.map((cell) => bootClassifyAdvisorCell(cell))
  assert.deepEqual(extensionVerdicts, bootVerdicts)
})

test('D1 extension and boot refusal vocabularies retain exact frozen ordered values', () => {
  assert.equal(Object.isFrozen(advisor.UNAVAILABLE_REASONS), true)
  assert.deepEqual(advisor.UNAVAILABLE_REASONS, [
    'role-unsupported', 'endpoint-unset', 'endpoint-not-local',
    'endpoint-credentials', 'model-unset', 'model-unsafe', 'endpoint-dead',
    'manifest-cell-invalid',
  ])
  assert.equal(Object.isFrozen(bootAdvisorRefusals), true)
  assert.deepEqual(bootAdvisorRefusals, [
    'role-unsupported', 'adapter-unsupported', 'transport-unsupported',
    'endpoint-unset', 'endpoint-not-local', 'endpoint-credentials',
    'model-unset', 'model-unsafe', 'endpoint-dead', 'advisor-env-retired',
  ])
})

test('attach is default-off, refuses wrong roles, and journals before handlers', async () => {
  const off = pi(); await advisor.attachAdvisor(off, { env: { CREW_ROLE: 'builder' }, deps: { appendFile: () => { throw new Error('must stay inert') } } })
  assert.equal(off.handlers.length, 0)
  const refused = sink(); const wrong = pi()
  await assert.rejects(() => advisor.attachAdvisor(wrong, { env: env({ CREW_ROLE: 'lead' }), deps: refused }), /role-unsupported/)
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

test('AD1 AD2 AD3 reply validation accepts first valid member and unions invalid codes', () => {
  const options = { anchors: new Set(['lib/widget.mjs:2']) }
  const valid = { class: 'edge-path', severity: 'medium', claim: 'grounded', evidence: ['lib/widget.mjs:2'] }
  assert.equal(advisor.validateReply([valid, { ...valid, claim: 'later' }], options).judgment.claim, 'grounded')
  assert.equal(advisor.validateReply([{ ...valid, class: 'bad' }, valid], options).judgment.claim, 'grounded')
  const invalid = advisor.validateReply([{ ...valid, class: 'bad' }, { ...valid, severity: 'bad' }], options)
  assert.deepEqual(invalid.codes, ['class-invalid', 'severity-invalid'])
  assert.equal(advisor.validateReply([], options).codes[0], 'payload-not-an-object')
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

test('RV1-1 tier-zero steer is stripped from a later consult delta', async () => {
  const f = fixture(); const journal = sink(); let childInput
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
  child.stdin = { end(value) { childInput = value; setImmediate(() => {
    const frame = { type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity: 'medium', claim: 'ordinary evidence remains grounded', evidence: ['lib/widget.mjs:2'] }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }
    child.stdout.write(JSON.stringify(frame) + '\n')
    child.emit('close', 0)
  }) } }
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    resolveBinary: () => ({ command: '/fake/pi', args: [] }), spawn: () => child,
  } })
  const sentence = 'The builder seat touched outside.mjs outside the declared scope.'
  const outside = join(f.tree, 'outside.mjs')
  a.onToolCall(call('breach', 'write', { path: outside, content: 'outside' }), {})
  const source = join(f.tree, 'lib/widget.mjs')
  a.onToolCall(call('echo-read', 'read', { path: source }), {})
  a.onToolResult(result('echo-read', 'read', { path: source }, `${sentence}\nlib/widget.mjs:2: ordinary grounded evidence`), {})
  a.onToolResult(result('breach', 'write', { path: outside, content: 'outside' }, 'ok'), {})
  await a.settled()
  const request = JSON.parse(childInput)
  const delta = request.delta.map((entry) => entry.text).join('\n')
  assert.equal(request.trigger, 'tier0-note')
  assert.equal(delta.includes(sentence), false)
  assert.equal(delta.includes('lib/widget.mjs:2: ordinary grounded evidence'), true)
  rmSync(f.root, { recursive: true, force: true })
})

test('AD5 tier-zero notes are deterministic and tier one is journal-first', async () => {
  const f = fixture(); const journal = sink(); const sends = []; const fetchFn = fetcher()
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    fetchFn, spawn: () => fakeChild(), send: (message, options) => sends.push({ message, options }),
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

  const cleanFixture = fixture(); const cleanJournal = sink(); const cleanFetch = fetcher()
  const cleanAdvisor = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: cleanFixture.taskDir }), deps: {
    cwd: cleanFixture.tree, taskDir: cleanFixture.taskDir, appendFile: cleanJournal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2, fetchFn: cleanFetch,
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

test('A1', async () => {
  const f = fixture(); const journal = sink(); let argv; let input
  const judgment = { class: 'edge-path', severity: 'medium', claim: 'child found a grounded edge path', evidence: ['outside.mjs:1'] }
  const spawn = (bin, args) => {
    argv = [bin, ...args]
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end(value) { input = value; setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ ...judgment, claim: 'older result' }) }], usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + '\n')
      child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(judgment) }], usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 } } }) + '\n')
      child.emit('close', 0)
    }) } }
    child.kill = () => true
    return child
  }
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    resolveBinary: () => ({ command: '/stub/pi', args: [] }), spawn,
  } })
  const path = join(f.tree, 'outside.mjs'); writeFileSync(path, 'const x = 1\\n')
  const change = { path, edits: [{ oldText: 'x', newText: 'const x = 1' }] }
  a.onToolCall(call('child', 'edit', change), {}); a.onToolResult(result('child', 'edit', change, 'ok'), {})
  await a.settled()
  assert.deepEqual(argv.slice(0, 15), ['/stub/pi','-p','--mode','json','--no-session','--model','provider/model','--thinking','medium','--no-tools','--no-context-files','--no-extensions','--no-skills','--append-system-prompt', argv[14]])
  assert.equal(argv.length, 15); assert.equal(argv[14].startsWith('/'), true)
  const payload = JSON.parse(input); assert.equal(payload.trigger, 'tier0-note'); assert.match(JSON.stringify(payload.delta), /outside.mjs:1/)
  assert.equal(a.notes().some((note) => note.outcome === 'injected' && note.claim === judgment.claim), true, JSON.stringify(journal.rows))
  const consult = journal.rows.find((row) => row.advisor_consult)?.advisor_consult
  assert.deepEqual(consult.usage, { billed_input_tokens: 9, billed_output_tokens: 4, billed_cache_write_tokens: 2, billed_cache_read_tokens: 1 })
  assert.equal(consult.model, 'provider/model')
  const advisorUsage = journal.rows.filter((row) => row.advisor_usage).map((row) => row.advisor_usage)
  assert.equal(advisorUsage.length, 1)
  assert.deepEqual(advisorUsage[0].usage, { billed_input_tokens: 9, billed_output_tokens: 4, billed_cache_write_tokens: 2, billed_cache_read_tokens: 1 })
  assert.equal(advisorUsage[0].model, 'provider/model')
  assert.equal(typeof advisorUsage[0].consult_id, 'string')
  rmSync(f.root, { recursive: true, force: true })
})

test('model-only attach uses the supplied roster catalog without probing or resolving pi', async () => {
  const f = fixture(); const journal = sink(); const p = pi(); let probes = 0; let spawned = 0
  await advisor.attachAdvisor(p, { env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: '', CREW_ADVISOR_MODEL: 'provider/model', CREW_ADVISOR_MODELS: { 'provider/model': {} } }), deps: {
    ...journal, taskDir: f.taskDir, fetchFn: async () => { probes++; return { status: 200 } },
    resolveBinary: () => { spawned++; throw new Error('must not resolve during attach') }, spawn: () => { spawned++; throw new Error('must not spawn during attach') },
  } })
  assert.deepEqual(p.handlers.map(([event]) => event).sort(), ['tool_call', 'tool_result'])
  assert.equal(probes, 0); assert.equal(spawned, 0)
  rmSync(f.root, { recursive: true, force: true })
})

test('RV1-1 pane advisor activation uses the manifest cell, not a roster env catalog', async () => {
  const f = fixture(); const journal = sink(); const p = pi()
  const command = seatCommand({ role: 'builder', model: 'provider/model', promptFile: '/tmp/prompt', tools: '', deny: '', taskDir: f.taskDir, bootBrief: 'brief', grants: { tools: [], extensions: [], agents: [], skills: [], advisor: true }, advisorCell: null })
  assert.match(command, /CREW_ADVISOR=1/)
  assert.doesNotMatch(command, /CREW_ADVISOR_MODELS=|CREW_ADVISOR_MODEL=/)
  await advisor.attachAdvisor(p, { env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, CREW_ADVISOR_MODEL: undefined }), deps: { ...journal, taskDir: f.taskDir } })
  assert.equal(p.handlers.length, 2)
  rmSync(f.root, { recursive: true, force: true })
})

test('RV1-2 strips normalized injected spans without dropping ordinary evidence', () => {
  const claim = 'Guard at lib/widget.mjs:2 misses the null path.'
  const cleaned = advisor.stripAdvisorNotes(`lib/widget.mjs:2: ordinary evidence ${claim}`, new Set([advisor.normalizeNote(claim)]))
  assert.match(cleaned, /ordinary evidence/)
  assert.equal(cleaned.includes(claim), false)
})

test('RV1-3 journals stale child consult usage before suppressing stale notes', async () => {
  const f = fixture(); const journal = sink(); let finish
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { finish = () => { child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity: 'low', claim: 'stale finding', evidence: ['lib/widget.mjs:2'] }), usage: { input: 4, output: 2 } } }) + '\n'); child.emit('close', 0) } } }
    child.kill = () => true; return child
  }
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    resolveBinary: () => ({ command: '/stub/pi', args: [] }), spawn,
  } })
  const readPath = join(f.tree, 'lib', 'widget.mjs')
  a.onToolResult(result('stale-read', 'read', { path: readPath, offset: 1 }, 'lib/widget.mjs:2: evidence'), {})
  const change = { path: join(f.tree, 'stale.mjs'), edits: [{ newText: 'x' }] }
  a.onToolCall(call('stale', 'edit', change), {}); a.onToolResult(result('stale', 'edit', change, 'ok'), {})
  await new Promise((resolve) => setImmediate(resolve))
  writeFileSync(join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE), JSON.stringify({ schema_version: 1, run_started_at: 2, tripwires: [] }))
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
        child.stdout.write(mode === 'oversize' ? Buffer.alloc(advisor.RESPONSE_CAP_BYTES + 1) : 'not-json\\n')
        child.emit('close', 0)
      }) } }
      child.kill = () => true
      return child
    }
    const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
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

test('A2 retired endpoint no longer selects fetch transport', async () => {
  const r = await runManifestConsult({ envExtra: { CREW_ADVISOR_ENDPOINT: 'http://127.0.0.1:11434/v1' } })
  assert.equal(r.fetched, 0)
  assert.equal(r.spawned, 1)
  assert.equal(r.journal.rows.some((row) => row.advisor_usage), true)
  rmSync(r.f.root, { recursive: true, force: true })
})

test('A3', async () => {
  const f = fixture(); const journal = sink(); const fetchFn = fetcher(); const inputs = []
  const childSpawn = (bin, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end(value) { inputs.push(value); setImmediate(() => { child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity: 'low', claim: 'Guard at lib/widget.mjs:2 misses the null path.', evidence: ['lib/widget.mjs:2'] }) } }) + '\n'); child.emit('close', 0) }) } }; child.kill = () => true; return child
  }
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    fetchFn, spawn: childSpawn, resolveBinary: () => ({ command: '/stub/pi', args: [] }),
  } })
  const path = join(f.tree, 'lib', 'widget.mjs')
  const trigger = (id, target) => {
    const change = { path: join(f.tree, target), edits: [{ newText: 'x' }] }
    a.onToolCall(call(id, 'edit', change), {}); a.onToolResult(result(id, 'edit', change, 'ok'), {})
  }
  a.onToolResult(result('read-initial', 'read', { path, offset: 1 }, 'lib/widget.mjs:2: initial grounded evidence'), {})
  trigger('first', 'outside-one.mjs'); await a.settled()
  a.onToolResult(result('read-mixed', 'read', { path, offset: 1 }, 'lib/widget.mjs:2: ordinary evidence Guard at lib/widget.mjs:2 misses the null path.'), {})
  trigger('second', 'outside-two.mjs'); await a.settled()
  const deltaText = JSON.stringify(JSON.parse(inputs[1]).delta)
  assert.match(deltaText, /ordinary evidence/)
  assert.equal(deltaText.includes('Guard at lib/widget.mjs:2 misses the null path.'), false)
  const consult = journal.rows.filter((row) => row.advisor_consult).at(-1)?.advisor_consult
  assert.equal(consult.usage, null); assert.equal(consult.usage_reason, 'usage-unavailable')
  const advisorUsage = journal.rows.filter((row) => row.advisor_usage).map((row) => row.advisor_usage)
  assert.equal(advisorUsage.length, 2)
  assert.equal(advisorUsage.at(-1).usage, null)
  // This child's assistant frame carries no usage: an own-spend frame without usage is
  // incomplete spend (the #1547 rule), while the consult row keeps its own reason above.
  assert.equal(advisorUsage.at(-1).usage_reason, 'usage-incomplete')
  rmSync(f.root, { recursive: true, force: true })
})

test('planner seat with grant is advised', async () => {
  const f = fixture(); const journal = sink(); const p = pi(); const fetchFn = fetcher()
  await advisor.attachAdvisor(p, { env: env({ CREW_ROLE: 'planner', CREW_TASK_DIR: f.taskDir }), deps: {
    ...journal, taskDir: f.taskDir, fetchFn,
  } })
  assert.deepEqual(p.handlers.map(([event]) => event).sort(), ['tool_call', 'tool_result'])
  assert.equal(journal.rows.some((row) => row.advisor_boot?.role === 'planner'), true)
  assert.equal(fetchFn.posts.length, 0)
})

test('B1 lead seat remains role-unsupported', async () => {
  const f = fixture(); const journal = sink(); const p = pi(); let probes = 0
  await assert.rejects(
    () => advisor.attachAdvisor(p, { env: env({ CREW_ROLE: 'lead', CREW_TASK_DIR: f.taskDir }), deps: {
      ...journal, taskDir: f.taskDir, fetchFn: async () => { probes += 1; return { status: 200 } },
    } }),
    (err) => { assert.equal(err.reason, 'role-unsupported'); return true },
  )
  assert.equal(probes, 0)
  assert.equal(p.handlers.length, 0)
  assert.equal(journal.rows[0]?.advisor_unavailable?.reason, 'role-unsupported')
})

test('C1 no-write seats remain role-unsupported', async () => {
  for (const role of ['tech-lead', 'reviewer']) {
    const f = fixture(); const journal = sink(); const p = pi(); let probes = 0
    await assert.rejects(
      () => advisor.attachAdvisor(p, { env: env({ CREW_ROLE: role, CREW_TASK_DIR: f.taskDir }), deps: {
        ...journal, taskDir: f.taskDir, fetchFn: async () => { probes += 1; return { status: 200 } },
      } }),
      (err) => { assert.equal(err.reason, 'role-unsupported'); return true },
    )
    assert.equal(probes, 0)
    assert.equal(p.handlers.length, 0)
    assert.equal(journal.rows[0]?.advisor_unavailable?.reason, 'role-unsupported')
  }
})

test('D1 builder advisor behavior remains grounded in the manifest-cell child', async () => {
  const f = fixture(); const journal = sink(); let childInput = ''
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    spawn: () => { const child = fakeChild(); const end = child.stdin.end; child.stdin.end = (value) => { childInput = value; end(value) }; return child },
  } })
  const editInput = { path: join(f.tree, 'lib', 'widget.mjs'), edits: [{ oldText: 'a', newText: 'a' }] }
  a.onToolCall(call('edit', 'edit', editInput), {})
  a.onToolResult(result('edit', 'edit', editInput, 'ok'), {})
  const failureInput = { command: 'npm test' }
  for (const id of ['failure-1', 'failure-2']) {
    a.onToolCall(call(id, 'bash', failureInput), {})
    a.onToolResult(result(id, 'bash', failureInput, 'not ok 1 - broken (4ms)', true), {})
  }
  await a.settled()
  const request = JSON.parse(childInput)
  assert.equal(request.trigger, 'tier0-note')
  assert.deepEqual(request.delta.flatMap((entry) => entry.anchors), ['lib/widget.mjs:1', 'lib/widget.mjs:2', 'lib/widget.mjs:3', 'lib/widget.mjs:4'])
  assert.equal(journal.rows.find((row) => row.advisor_consult)?.advisor_consult.model, 'provider/model')
  assert.deepEqual(advisor.TIER0_KINDS, [
    'scope-breach', 'tripwire-touch', 'repeated-failure', 'growth-divergence',
  ])
})

test('E1 unset grant has a live no-journaling witness', async () => {
  for (const role of ['builder', 'planner', 'lead', 'tech-lead', 'reviewer']) {
    const f = fixture(); const p = pi(); let appends = 0; let probes = 0
    const values = env({ CREW_ROLE: role, CREW_TASK_DIR: f.taskDir }); delete values.CREW_ADVISOR
    await advisor.attachAdvisor(p, { env: values, deps: {
      taskDir: f.taskDir,
      appendFile: () => { appends += 1 },
      fetchFn: async () => { probes += 1; return { status: 200 } },
    } })
    assert.equal(appends, 0, role)
    assert.equal(probes, 0, role)
    assert.equal(p.handlers.length, 0, role)
  }
})

test('F1 advisor refusal and judgment vocabularies remain frozen', () => {
  assert.equal(Object.isFrozen(advisor.UNAVAILABLE_REASONS), true)
  assert.deepEqual(advisor.UNAVAILABLE_REASONS, [
    'role-unsupported', 'endpoint-unset', 'endpoint-not-local',
    'endpoint-credentials', 'model-unset', 'model-unsafe', 'endpoint-dead',
    'manifest-cell-invalid',
  ])
  assert.equal(Object.isFrozen(advisor.JUDGMENT_CLASSES), true)
  assert.deepEqual(advisor.JUDGMENT_CLASSES, ['edge-path', 'over-claim'])
  assert.equal(Object.isFrozen(bootAdvisorRefusals), true)
  assert.deepEqual(bootAdvisorRefusals, [
    'role-unsupported', 'adapter-unsupported', 'transport-unsupported',
    'endpoint-unset', 'endpoint-not-local', 'endpoint-credentials',
    'model-unset', 'model-unsafe', 'endpoint-dead', 'advisor-env-retired',
  ])
})

// The resolved roster cell a boot admits grants against (ADR-047); the retired env never grants.
const BOOT_CELL = Object.freeze({
  models: { 'anthropic/claude-sonnet-5': {} },
  advisor: { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'pi', effort: 'medium', model: 'anthropic/claude-sonnet-5' },
})

test('G1 boot-admitted planner receives plan and gate judgment context from the pi child', async () => {
  const f = fixture()
  assert.equal(existsSync(join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)), true)
  assert.equal(existsSync(join(f.root, 'returns')), true)
  const plannerEnv = env({ CREW_ROLE: 'planner', CREW_TASK_DIR: f.taskDir })
  const bootAdapters = { planner: { name: 'pi', transport: DEFAULT_TRANSPORT, grants: { advisor: true } } }
  // ADR-047: boot admits a planner grant against the RESOLVED roster cell.
  const record = advisorBootRecord({ adapters: bootAdapters, ...BOOT_CELL })
  assert.deepEqual(record.granted, ['planner'])
  let probes = 0
  await assertAdvisorCellLive({ record, adapters: bootAdapters,
    probeEndpoint: async () => { probes += 1; return true },
    note: () => { throw new Error('planner boot should be admitted') },
  })
  assert.equal(probes, 0)

  const planPath = join(f.taskDir, 'plan.md')
  const gatePath = join(f.taskDir, 'gate.mjs')
  writeFileSync(planPath, '# Plan\n- handle empty output\n')
  writeFileSync(gatePath, 'export const gate = true\n')
  writeFileSync(join(f.taskDir, 'private.md'), 'must not be sent\n')
  const journal = sink(); let childInput = ''
  const a = advisor.createAdvisor({ env: plannerEnv, deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    spawn: () => { const child = fakeChild(); const end = child.stdin.end; child.stdin.end = (value) => { childInput = value; end(value) }; return child },
  } })
  const planInput = { path: planPath, content: readFileSync(planPath, 'utf8') }
  a.onToolResult(result('plan', 'write', planInput, 'ok'), {})
  const gateInput = { path: gatePath, edits: [{ oldText: 'x', newText: readFileSync(gatePath, 'utf8') }] }
  a.onToolResult(result('gate', 'edit', gateInput, 'ok'), {})
  for (const [id, path] of [
    ['private', join(f.taskDir, 'private.md')],
    ['nested', join(f.taskDir, 'nested', 'plan.md')],
    ['escape', join(f.taskDir, '..', 'escape.md')],
  ]) {
    a.onToolResult(result(id, 'read', { path, offset: 1 }, 'not planner context'), {})
  }
  const failureInput = { command: 'npm test' }
  for (const id of ['planner-failure-1', 'planner-failure-2']) {
    a.onToolCall(call(id, 'bash', failureInput), {})
    a.onToolResult(result(id, 'bash', failureInput, 'not ok 1 - planner failure (4ms)', true), {})
  }
  await a.settled()
  const user = JSON.parse(childInput)
  const labels = [...new Set(user.delta.flatMap((entry) => String(entry.text).split('\n')
    .map((line) => /^([^:]+(?:\/[^:]+)*):\d+: /.exec(line)?.[1]).filter(Boolean)))]
  assert.deepEqual(labels.sort(), ['task/gate.mjs', 'task/plan.md'])
  assert.equal(user.delta.some((entry) => String(entry.text).includes('private.md')), false)
  assert.equal(user.delta.some((entry) => String(entry.text).includes('escape.md')), false)
})

test('I1 extension and boot role gates agree', async () => {
  const roles = ['builder', 'planner', 'lead', 'tech-lead', 'reviewer']
  const expected = [true, true, false, false, false]
  const extension = []
  const boot = []
  for (const role of roles) {
    const f = fixture(); const p = pi(); const journal = sink(); const values = env({ CREW_ROLE: role, CREW_TASK_DIR: f.taskDir })
    try {
      await advisor.attachAdvisor(p, { env: values, deps: {
        ...journal, taskDir: f.taskDir, fetchFn: async () => ({ status: 200 }),
      } })
      extension.push(true)
    } catch (error) {
      assert.equal(error.reason, 'role-unsupported')
      extension.push(false)
    }
    const adapters = { [role]: { name: 'pi', transport: DEFAULT_TRANSPORT, grants: { advisor: true } } }
    const record = advisorBootRecord({ adapters, ...BOOT_CELL })
    assert.deepEqual(record.granted, [role])
    try {
      await assertAdvisorCellLive({ record, adapters, probeEndpoint: async () => true })
      boot.push(true)
    } catch (error) {
      assert.equal(error.reason, 'role-unsupported')
      boot.push(false)
    }
  }
  assert.deepEqual(extension, expected)
  assert.deepEqual(boot, expected)
  assert.deepEqual(extension, boot)
})

test('K1 planner edge-path gloss fits plan and gate', () => {
  assert.equal(advisor.BUILDER_SYSTEM_PROMPT, 'Review the builder delta for exactly two judgment classes: edge-path (checklist B1: answer EPERM, unknown, interrupted, and empty paths) and over-claim (checklist B2: record no verdict stronger than what was measured). Return JSON alone: one object or an array of 1 to 4 objects, with no prose, no code fence, no wrapper key and no second object on another line. Each object has exactly the four keys class, severity, claim and evidence. class must be one of edge-path, over-claim. severity must be one of low, medium, high. claim must be a non-empty string of at most 500 UTF-8 bytes. evidence must be an array of 1 to 5 strings, each at most 200 UTF-8 bytes and exactly a bare path:line (no range, no prose, no whitespace or colon in the path; decimal line number). The first evidence item must cite a line shown in the delta. Do not copy the example\'s evidence unless that line is shown in the delta. Example reply: {"class":"edge-path","severity":"low","claim":"The empty input path is not handled.","evidence":["src/widget.mjs:12"]}')
  assert.equal(advisor.PLANNER_SYSTEM_PROMPT, 'Review the planner delta for exactly two judgment classes: edge-path (a plan or gate omits or mishandles a required boundary, failure case, or acceptance path) and over-claim (a Ground truth citation that does not hold at the ref where the plan was written). Return JSON alone: one object or an array of 1 to 4 objects, with no prose, no code fence, no wrapper key and no second object on another line. Each object has exactly the four keys class, severity, claim and evidence. class must be one of edge-path, over-claim. severity must be one of low, medium, high. claim must be a non-empty string of at most 500 UTF-8 bytes. evidence must be an array of 1 to 5 strings, each at most 200 UTF-8 bytes and exactly a bare path:line (no range, no prose, no whitespace or colon in the path; decimal line number). The first evidence item must cite a line shown in the delta. Do not copy the example\'s evidence unless that line is shown in the delta. Example reply: {"class":"edge-path","severity":"low","claim":"The empty input path is not handled.","evidence":["src/widget.mjs:12"]}')
  assert.match(advisor.PLANNER_SYSTEM_PROMPT, /plan or gate omits or mishandles a required boundary, failure case, or acceptance path/)
  assert.match(advisor.PLANNER_SYSTEM_PROMPT, /Ground truth citation that does not hold at the ref where the plan was written/)
  assert.doesNotMatch(advisor.PLANNER_SYSTEM_PROMPT, /EPERM, unknown, interrupted, and empty paths/)
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
  const f = fixture(); const journal = sink(); const fetchFn = fetcher()
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, CREW_ADVISOR_MODEL: 'provider/model' }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2,
    fetchFn, spawn: childSpawn, resolveBinary: () => ({ command: '/stub/pi', args: [] }), ...extraDeps,
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
// The consult row keeps the partial fold (#1535), labelled; the priced row is null.
function assertPartial({ row, consult }, tokens) {
  assert.equal(row.usage, null); assert.equal(row.usage_reason, 'usage-incomplete')
  assert.equal(consult.usage?.billed_input_tokens, tokens); assert.equal(consult.usage_partial, true)
}
// (a) guard: an own-spend frame with no usage. Sol pass 5's counterexample.
test('spend class (a): a usage-less own-spend frame before a complete one leaves the spend unmeasured', async () => {
  const row = await spendRowFor([ownFrame(undefined), ownFrame(COMPLETE_USAGE)])
  assert.equal(row.usage, null); assert.equal(row.usage_reason, 'usage-incomplete')
})
// (b) guard: the same, in the other order; a last-frame-only check would pass it.
test('spend class (b): a usage-less own-spend frame after a complete one leaves the spend unmeasured', async () => {
  const row = await spendRowFor([ownFrame(COMPLETE_USAGE), ownFrame(undefined)])
  assert.equal(row.usage, null); assert.equal(row.usage_reason, 'usage-incomplete')
})
// (c) guard: every token class present. Sol pass 4's counterexample.
test('spend class (c): a child usage frame missing a token class writes an unmeasured spend row, never a zero', async () => {
  const row = await spendRowFor([ownFrame({ input: 7, output: 3, cacheWrite: 2 })])
  assert.equal(row.usage, null); assert.equal(row.usage_reason, 'usage-incomplete')
})
// (d) guard: each present class a non-negative safe integer. JSON carries a non-finite
// number as null, so null stands for it beside a negative and a fraction.
test('spend class (d): a non-finite, negative or fractional token class leaves the spend unmeasured', async () => {
  for (const bad of [null, -1, 1.5, '4']) {
    const row = await spendRowFor([ownFrame({ ...COMPLETE_USAGE, cacheRead: bad })])
    assert.equal(row.usage, null, `cacheRead ${JSON.stringify(bad)}`); assert.equal(row.usage_reason, 'usage-incomplete')
  }
})
// (e) guard: only own-spend frames count. Zero own-spend frames (a nested tool result, which
// the reducer never counts) keep the reducer's null and usage-unavailable, not incomplete.
test('spend class (e): zero own-spend frames keep usage-unavailable, and a complete run is measured', async () => {
  const none = await spendRowFor([{ type: 'message_end', message: { role: 'toolResult', content: [] } }, { type: 'turn_end' }])
  assert.equal(none.usage, null); assert.equal(none.usage_reason, 'usage-unavailable')
  const measured = await spendRowFor([ownFrame(COMPLETE_USAGE), ownFrame({ input: 1, output: 1, cacheRead: 2, cacheWrite: 3 })])
  assert.deepEqual(measured.usage, { billed_input_tokens: 6, billed_output_tokens: 4, billed_cache_write_tokens: 3, billed_cache_read_tokens: 2 })
  assert.equal(measured.usage_reason, null)
})

// aggregate guard (aggregateSafe). Sol pass 7: two clean frames whose sum passes MAX_SAFE_INTEGER
// are not a measured total; the row is unmeasured, and it ingests (the writer never refuses it).
test('spend class (j): an aggregate past MAX_SAFE_INTEGER leaves the spend unmeasured and ingestible', async () => {
  const run = await spendRun([ownFrame({ ...COMPLETE_USAGE, input: Number.MAX_SAFE_INTEGER }), ownFrame({ ...COMPLETE_USAGE, input: 1 })])
  assert.equal(run.row.usage, null); assert.equal(run.row.usage_reason, 'usage-incomplete')
  assert.equal(run.consult.usage_partial, true)
  const { openLedger } = await import('../../../scripts/factory/ledger.mjs')
  const dir = scratchDir('advisor-aggregate-')
  const ledger = openLedger({ dbPath: join(dir, 'ledger.db'), stderr: { write: () => {} } })
  try {
    assert.doesNotThrow(() => ledger.recordAdvisorUsage({ adw_id: 'advisor-aggregate', ...run.row }))
    assert.equal(ledger.dumpTable('advisor_usage').length, 1)
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }) }
})

// Stream conditions of the same invariant: complete usage frames, then the stream does not end
// cleanly. Each names the guard whose removal turns it red.
// parse guard (parseFault). Sol pass 6: a complete frame, then invalid JSON: a trailing partial
// frame at a clean close isolates this guard; the mid-stream case also fails the consult.
test('spend stream (f): complete frames then an invalid or partial frame leave the spend unmeasured', async () => {
  assertPartial(await spendRun([ownFrame(COMPLETE_USAGE)], { raw: '{"type":"message_end","mess' }), 5)
  const midStream = await spendRun([ownFrame(COMPLETE_USAGE)], { raw: 'not json\n', close: null })
  assertPartial(midStream, 5)
})
// exit guard (uncleanExit): a non-zero exit, or a signal, after complete frames.
test('spend stream (g): a non-zero exit or a signal after complete frames leaves the spend unmeasured', async () => {
  assertPartial(await spendRun([ownFrame(COMPLETE_USAGE)], { close: [1, null] }), 5)
  assertPartial(await spendRun([ownFrame(COMPLETE_USAGE)], { close: [null, 'SIGKILL'] }), 5)
  // The signal clause alone: a close that names a signal is unclean whatever its code says.
  assertPartial(await spendRun([ownFrame(COMPLETE_USAGE)], { close: [0, 'SIGTERM'] }), 5)
})
// failure guard (consultFailed): the consult timed out and killed the child after complete frames.
test('spend stream (h): a timed-out, killed consult after complete frames leaves the spend unmeasured', async () => {
  assertPartial(await spendRun([ownFrame(COMPLETE_USAGE)], { close: null, extraDeps: { consultTimeoutMs: 5 } }), 5)
})

test('A1 clockfree fires consult timeout after complete frames are consumed', async () => {
  const t = manualTimers(250)
  const result = await spendRun([ownFrame(COMPLETE_USAGE)], { close: null, extraDeps: { setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, consultTimeoutMs: 250 }, afterFrames: () => t.fireConsult() })
  assertPartial(result, 5)
})

test('A4 clockfree timed-out complete spend remains unmeasured', async () => {
  const t = manualTimers(250)
  const result = await spendRun([ownFrame(COMPLETE_USAGE)], { close: null, extraDeps: { setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, consultTimeoutMs: 250 }, afterFrames: () => t.fireConsult() })
  assertPartial(result, 5)
})

test('A2 clockfree consult timeout is injected and explicitly fired', async () => {
  const t = manualTimers(250)
  let finish
  const c = childConsult({ childSpawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { finish = () => child.emit('close', null) } }
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true }
    return child
  }, extraDeps: { setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, consultTimeoutMs: 250 } })
  try {
    const running = c.run()
    for (let i = 0; i < 20 && !t.armed.some((entry) => entry.ms === 250); i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(t.armed.filter((entry) => entry.ms === 250).length, 1)
    t.fireConsult()
    await running
  } finally { finish?.(); c.cleanup() }
})

// failure guard (consultFailed), cap path: a partial frame past RESPONSE_CAP_BYTES after complete frames.
test('spend stream (i): a stream that hits a cap after complete frames leaves the spend unmeasured', async () => {
  assertPartial(await spendRun([ownFrame(COMPLETE_USAGE)], { raw: 'x'.repeat(advisor.RESPONSE_CAP_BYTES + 1), close: null }), 5)
})

test('a judgment child that ignores SIGTERM is killed and has closed before the consult settles', async () => {
  const signals = []; let closed = false
  const childSpawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() {} }
    child.kill = (signal) => { signals.push(signal); if (signal === 'SIGKILL') setImmediate(() => { closed = true; child.emit('close', null) }); return true }
    return child
  }
  const c = childConsult({ childSpawn, extraDeps: { consultTimeoutMs: 5, childKillGraceMs: 5 } })
  try {
    await c.run()
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(closed, true, 'the consult settled before the child closed')
    assert.ok(c.journal.rows.find((row) => row.advisor_note?.outcome === 'rejected')?.advisor_note.codes.includes('timeout'))
  } finally { c.cleanup() }
})

test('usage folded before a later invalid frame is kept on the consult row', async () => {
  const childSpawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'partial', usage: { input: 17, output: 3 } } }) + '\n')
      child.stdout.write('{not json\n')
    }) } }
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true }
    return child
  }
  const c = childConsult({ childSpawn, extraDeps: { childKillGraceMs: 5 } })
  try {
    await c.run()
    const consult = c.journal.rows.filter((row) => row.advisor_consult).at(-1)?.advisor_consult
    assert.notEqual(consult.usage, null)
    assert.equal(consult.usage_reason, undefined)
    assert.equal(JSON.stringify(consult.usage).includes('17'), true)
  } finally { c.cleanup() }
})

test('a UTF-8 character split across stdout chunks is decoded whole', async () => {
  const claim = 'Guard at lib/widget.mjs:2 misses the Café null path.'
  const childSpawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { setImmediate(() => {
      const bytes = Buffer.from(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify({ class: 'edge-path', severity: 'low', claim, evidence: ['lib/widget.mjs:2'] }) } }) + '\n', 'utf8')
      const split = bytes.indexOf(Buffer.from('é', 'utf8')) + 1
      child.stdout.write(bytes.subarray(0, split)); setImmediate(() => { child.stdout.write(bytes.subarray(split)); child.emit('close', 0) })
    }) } }
    child.kill = () => true
    return child
  }
  const c = childConsult({ childSpawn })
  try {
    await c.run()
    const text = JSON.stringify(c.journal.rows.filter((row) => row.advisor_note || row.advisor_consult))
    assert.equal(text.includes('�'), false, 'a replacement character reached the journal')
    assert.equal(text.includes('Café'), true)
  } finally { c.cleanup() }
})

for (const stream of ['stdout', 'stderr']) {
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

test('frames under 40 KB delivered in one chunk over 64 KiB are parsed frame by frame and accepted', async () => {
  const filler = JSON.stringify({ type: 'tool_execution_end', result: 'y'.repeat(35_000) }) + '\n'
  const frames = [filler, filler, filler, judgmentFrame('Guard at lib/widget.mjs:2 misses the null path.')]
  assert.ok(frames.every((frame) => Buffer.byteLength(frame) < 40_000))
  assert.ok(Buffer.byteLength(frames.join('')) > advisor.RESPONSE_CAP_BYTES)
  const c = childConsult({ childSpawn: framesChild(frames) })
  try {
    await c.run()
    const notes = c.journal.rows.filter((row) => row.advisor_note).map((row) => row.advisor_note)
    assert.equal(notes.some((note) => note.outcome === 'rejected'), false, JSON.stringify(notes))
    assert.equal(JSON.stringify(notes).includes('misses the null path'), true)
  } finally { c.cleanup() }
})

test('a single complete frame over 64 KiB within the stream total is rejected body-too-large', async () => {
  const { STREAM_CAP_BYTES } = await import('./subagent.ts')
  const big = JSON.stringify({ type: 'tool_execution_end', result: 'z'.repeat(advisor.RESPONSE_CAP_BYTES + 1024) }) + '\n'
  const frames = [big, judgmentFrame('Guard at lib/widget.mjs:2 misses the null path.')]
  assert.ok(Buffer.byteLength(big) > advisor.RESPONSE_CAP_BYTES)
  assert.ok(Buffer.byteLength(frames.join('')) < STREAM_CAP_BYTES)
  const c = childConsult({ childSpawn: framesChild(frames), extraDeps: { childKillGraceMs: 5 } })
  try {
    await c.run()
    const notes = c.journal.rows.filter((row) => row.advisor_note).map((row) => row.advisor_note)
    assert.ok(notes.find((note) => note.outcome === 'rejected')?.codes.includes('body-too-large'), JSON.stringify(notes))
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
  writeFileSync(join(taskDir, advisor.TRIPWIRE_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, tripwires: [],
    ...(noCell ? {} : { cell: { provider: 'local', id: 'advisor', agent: 'pi', effort: 'medium', model: 'local/advisor' } }),
  }))
  writeFileSync(join(root, 'returns/d1.planner.json'), JSON.stringify({ details: { files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
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
const adAccepted = (r) => ({ outcomes: adTier1(r).map((n) => n.outcome), claims: adTier1(r).map((n) => n.claim), sends: adSent1(r).map((s) => ({ content: s.message.content, delivery: s.options.deliverAs })) })

// MUTATION AD1: revert the consult call site to validateJudgment — an array reply is rejected.
test('AD1 an array reply delivers its first valid judgment as the steer', async () => {
  assert.deepEqual(adAccepted(await adDrive(JSON.stringify([adGood('first grounded claim'), adGood('second grounded claim')]))),
    { outcomes: ['injected'], claims: ['first grounded claim'], sends: [{ content: 'first grounded claim', delivery: 'steer' }] })
})

// MUTATION AD2: take the first element's verdict unconditionally — a valid second element is lost.
test('AD2 an invalid first element does not hide a valid later judgment', async () => {
  assert.deepEqual(adAccepted(await adDrive(JSON.stringify([{ ...adGood('invalid first claim'), class: 'bogus' }, adGood('second grounded claim')]))),
    { outcomes: ['injected'], claims: ['second grounded claim'], sends: [{ content: 'second grounded claim', delivery: 'steer' }] })
})

// MUTATION AD3: report payload-not-an-object for any rejected array — per-element codes disappear.
test('AD3 an array with no valid element is rejected with closed per-element codes', async () => {
  const r = await adDrive(JSON.stringify([{ ...adGood('invalid class'), class: 'bogus' }, { ...adGood('invalid severity'), severity: 'bogus' }]))
  const notes = adTier1(r), codes = notes[0]?.codes || []
  assert.deepEqual(notes.map((n) => n.outcome), ['rejected'])
  assert.deepEqual([...codes].sort(), ['class-invalid', 'severity-invalid'])
  assert.equal(codes.every((c) => advisor.JUDGMENT_ERROR_CODES.includes(c)), true)
  assert.equal(adSent1(r).length, 0)
})

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
  const prompts = [advisor.BUILDER_SYSTEM_PROMPT, advisor.PLANNER_SYSTEM_PROMPT]
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

// MUTATION AS3: make the embedded example severity invalid.
test('AS3 both prompt examples validate as objects and one-element arrays', () => {
  for (const prompt of [advisor.BUILDER_SYSTEM_PROMPT, advisor.PLANNER_SYSTEM_PROMPT]) {
    const marker = 'Example reply: '
    const index = prompt.lastIndexOf(marker)
    assert.notEqual(index, -1)
    const example = JSON.parse(prompt.slice(index + marker.length))
    assert.equal(Array.isArray(example), false)
    const anchors = new Set([example.evidence?.[0]])
    assert.deepEqual(advisor.validateReply(example, { anchors }), { codes: [], judgment: example })
    assert.deepEqual(advisor.validateReply([example], { anchors }), { codes: [], judgment: example })
  }
})

// MUTATION RJ1: increment recorded UTF-8 byte count; accepted reply provenance must measure exact bytes.
test('RJ1 accepted consult records reply hash, UTF-8 bytes, excerpt and identity', async () => {
  const reply = JSON.stringify(adGood('auditable accepted claim'))
  const r = await adDrive(reply)
  const consult = r.rows.find((row) => row.advisor_consult).advisor_consult
  const { createHash } = await import('node:crypto')
  assert.equal(consult.reply.sha256, createHash('sha256').update(reply).digest('hex'))
  assert.equal(consult.reply.bytes, Buffer.byteLength(reply))
  assert.equal(consult.reply.excerpt, reply)
  assert.ok(consult.consult_id)
  assert.equal('reply_reason' in consult, false)
})

// MUTATION RJ2: bypass redaction before hashing a rejected credential-bearing reply.
test('RJ2 rejected consult records redacted bounded reply and joined note', async () => {
  const reply = 'Bearer abcdefghijklmnopqrstuvwxyz ' + '🙂'.repeat(300)
  const r = await adDrive(reply)
  const consult = r.rows.find((row) => row.advisor_consult).advisor_consult
  const { createHash } = await import('node:crypto')
  assert.equal(consult.reply.sha256, createHash('sha256').update(advisor.redactDelta(reply).text).digest('hex'))
  assert.equal(consult.reply.bytes, Buffer.byteLength(advisor.redactDelta(reply).text))
  assert.equal(consult.reply.excerpt, advisor.boundText(advisor.redactDelta(reply).text, 512))
  assert.equal(JSON.stringify(consult).includes('abcdefghijklmnopqrstuvwxyz'), false)
  const note = r.rows.find((row) => row.advisor_note?.outcome === 'rejected').advisor_note
  assert.equal(note.consult_id, consult.consult_id)
  assert.equal(note.reply_excerpt, advisor.boundText(advisor.redactDelta(reply).text, 512))
})

// Shared consult harness follows gate.mjs's fake child and never resolves a real pi.
async function rjDrive(reply, { mode = 'reply', digest, repeated = false } = {}) {
  const root = scratchDir('advisor-rj-')
  const taskDir = join(root, 'task'), tree = join(root, 'tree'), rows = [], sends = []
  mkdirSync(taskDir); mkdirSync(join(root, 'returns')); mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib/widget.mjs'), 'const widget = null\\n')
  writeFileSync(join(taskDir, advisor.TRIPWIRE_MANIFEST_FILE), JSON.stringify({
    schema_version: 1, run_started_at: 1, tripwires: [],
    cell: { provider: 'local', id: 'advisor', agent: 'pi', effort: 'medium', model: 'local/advisor' },
  }))
  writeFileSync(join(root, 'returns/d1.planner.json'), JSON.stringify({ details: { files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
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
          else if (mode === 'oversize') child.stdout.write('x'.repeat(66000))
          else child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: Array.isArray(reply) ? reply[current] : reply, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + '\n')
          if (mode !== 'oversize') child.emit('close', mode === 'exit' ? 1 : 0)
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

// MUTATION RJ3: omit timeout from reason selection; timeout consult must retain its reason.
test('RJ3 timeout consult records strict absence and settles', async () => {
  const r = await rjDrive('', { mode: 'timeout' })
  assert.deepEqual({ reply: r.consults[0]?.reply, reason: r.consults[0]?.reply_reason }, { reply: null, reason: 'timeout' })
  assert.deepEqual(advisor.REPLY_REASONS, ['timeout', 'transport-failed', 'body-too-large', 'body-not-json', 'content-missing', 'reply-unrecorded'])
  assert.equal(Object.isFrozen(advisor.REPLY_REASONS), true)
})

// MUTATION RJ4: omit transport-failed from reason selection; each absence cause stays explicit.
test('RJ4 transport and malformed replies record their closed absence reasons', async () => {
  for (const [mode, content, reason] of [['exit', '', 'transport-failed'], ['bad-frame', '', 'body-not-json'], ['oversize', '', 'body-too-large'], ['reply', '', 'content-missing']]) {
    const r = await rjDrive(content, { mode })
    assert.deepEqual({ reply: r.consults[0]?.reply, reason: r.consults[0]?.reply_reason }, { reply: null, reason })
  }
  assert.deepEqual(advisor.REPLY_REASONS, ['timeout', 'transport-failed', 'body-too-large', 'body-not-json', 'content-missing', 'reply-unrecorded'])
  assert.equal(Object.isFrozen(advisor.REPLY_REASONS), true)
})

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
