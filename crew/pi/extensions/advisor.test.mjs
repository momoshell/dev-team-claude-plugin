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
  ])
  assert.equal(Object.isFrozen(bootAdvisorRefusals), true)
  assert.deepEqual(bootAdvisorRefusals, [
    'role-unsupported', 'adapter-unsupported', 'transport-unsupported',
    'endpoint-unset', 'endpoint-not-local', 'endpoint-credentials',
    'model-unset', 'model-unsafe', 'endpoint-dead',
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
    const f = fixture(); const journal = sink(); const fetchFn = fetcher()
    const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
      cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
      readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2, fetchFn,
    } })
    try {
      source.drive(a, f)
      await a.settled()
      const body = fetchFn.posts.map((post) => post.body).join('\n')
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
  assert.deepEqual(argv.slice(0, 14), ['/stub/pi','-p','--mode','json','--no-session','--model','provider/model','--tools','read,grep,find,ls','--exclude-tools','edit,write,bash','--no-extensions','--no-skills','--append-system-prompt'])
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

test('RV1-1 seatCommand roster env reaches model-only attach', async () => {
  const f = fixture(); const journal = sink(); const p = pi(); let probes = 0
  const models = { 'provider/model': { source: 'remote' }, 'other/model': { source: 'remote' } }
  const command = seatCommand({ role: 'builder', model: 'provider/model', promptFile: '/tmp/prompt', tools: '', deny: '', taskDir: f.taskDir, bootBrief: 'brief', grants: { tools: [], extensions: [], agents: [], skills: [], advisor: true }, advisorCell: { model: 'provider/model', models } })
  const serialized = /(?:^|\s)CREW_ADVISOR_MODELS='([^']*)'/.exec(command)?.[1]
  assert.equal(serialized, JSON.stringify(models))
  await advisor.attachAdvisor(p, { env: env({ CREW_TASK_DIR: f.taskDir, CREW_ADVISOR_ENDPOINT: undefined, CREW_ADVISOR_MODEL: 'provider/model', CREW_ADVISOR_MODELS: serialized }), deps: {
    ...journal, taskDir: f.taskDir, fetchFn: async () => { probes++; return { status: 200 } },
  } })
  assert.equal(p.handlers.length, 2); assert.equal(probes, 0)
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

test('pi-child timeout, oversize output and invalid frames are closed failures', async () => {
  for (const mode of ['timeout', 'oversize', 'invalid']) {
    const f = fixture(); const journal = sink()
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
      resolveBinary: () => ({ command: '/stub/pi', args: [] }), spawn, consultTimeoutMs: 5,
    } })
    const readPath = join(f.tree, 'lib', 'widget.mjs')
    a.onToolResult(result(`${mode}-read`, 'read', { path: readPath, offset: 1 }, 'lib/widget.mjs:2: evidence'), {})
    const target = join(f.tree, `${mode}.mjs`); const change = { path: target, edits: [{ newText: 'x' }] }
    a.onToolCall(call(mode, 'edit', change), {}); a.onToolResult(result(mode, 'edit', change, 'ok'), {})
    await a.settled()
    const rejected = journal.rows.find((row) => row.advisor_note?.outcome === 'rejected')?.advisor_note
    assert.ok(rejected, mode)
    assert.ok(rejected.codes.includes(mode === 'oversize' ? 'body-too-large' : mode === 'invalid' ? 'body-not-json' : 'transport-failed'), mode)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('A2', async () => {
  const f = fixture(); const journal = sink(); const fetchFn = fetcher(); let spawned = 0
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile, readFile: (path) => readFileSync(path, 'utf8'),
    fileMtime: () => 2, fetchFn, spawn: () => { spawned++; throw new Error('must not spawn') },
  } })
  const path = join(f.tree, 'outside.mjs'); writeFileSync(path, 'const x = 1\\n')
  const change = { path, edits: [{ oldText: 'x', newText: 'const x = 1' }] }
  a.onToolCall(call('http', 'edit', change), {}); a.onToolResult(result('http', 'edit', change, 'ok'), {}); await a.settled()
  assert.equal(fetchFn.posts.length, 1); assert.equal(fetchFn.posts[0].init.method, 'POST'); assert.equal(spawned, 0)
  assert.equal(journal.rows.some((row) => row.advisor_usage), false)
  rmSync(f.root, { recursive: true, force: true })
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

test('D1 builder advisor behavior remains byte-identical', async () => {
  const f = fixture(); const journal = sink(); const fetchFn = fetcher({
    class: 'edge-path', severity: 'medium', claim: 'the builder path answers EPERM', evidence: ['lib/widget.mjs:1'],
  })
  const a = advisor.createAdvisor({ env: env({ CREW_TASK_DIR: f.taskDir }), deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2, fetchFn,
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
  assert.equal(fetchFn.posts.length, 1)
  const expectedBody = JSON.stringify({
    model: 'qwen3-coder', temperature: 0, stream: false,
    messages: [
      { role: 'system', content: 'Review the builder delta for exactly two judgment classes: edge-path (checklist B1: answer EPERM, unknown, interrupted, and empty paths) and over-claim (checklist B2: record no verdict stronger than what was measured). Return JSON with class, severity, claim, and evidence.' },
      { role: 'user', content: JSON.stringify({
        trigger: 'tier0-note',
        delta: [
          { text: 'lib/widget.mjs:1: a\nlib/widget.mjs:2: b\nlib/widget.mjs:3: c\nlib/widget.mjs:4: ', anchors: ['lib/widget.mjs:1', 'lib/widget.mjs:2', 'lib/widget.mjs:3', 'lib/widget.mjs:4'] },
          { text: 'broken', anchors: [] },
          { text: 'broken', anchors: [] },
        ],
      }) },
    ],
  })
  assert.equal(fetchFn.posts[0].body, expectedBody)
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
  ])
  assert.equal(Object.isFrozen(advisor.JUDGMENT_CLASSES), true)
  assert.deepEqual(advisor.JUDGMENT_CLASSES, ['edge-path', 'over-claim'])
  assert.equal(Object.isFrozen(bootAdvisorRefusals), true)
  assert.deepEqual(bootAdvisorRefusals, [
    'role-unsupported', 'adapter-unsupported', 'transport-unsupported',
    'endpoint-unset', 'endpoint-not-local', 'endpoint-credentials',
    'model-unset', 'model-unsafe', 'endpoint-dead',
  ])
})

test('G1 boot-admitted planner receives plan and gate judgment context', async () => {
  const f = fixture()
  assert.equal(existsSync(join(f.taskDir, advisor.TRIPWIRE_MANIFEST_FILE)), true)
  assert.equal(existsSync(join(f.root, 'returns')), true)
  const endpoint = 'http://127.0.0.1:11434/v1'
  const plannerEnv = env({ CREW_ROLE: 'planner', CREW_TASK_DIR: f.taskDir })
  const bootAdapters = { planner: { name: 'pi', transport: DEFAULT_TRANSPORT, grants: { advisor: true } } }
  const record = advisorBootRecord({ adapters: bootAdapters, env: plannerEnv })
  let probes = 0
  await assertAdvisorCellLive({ record, adapters: bootAdapters,
    probeEndpoint: async () => { probes += 1; return true },
    note: () => { throw new Error('planner boot should be admitted') },
  })
  assert.equal(probes, 1)

  const planPath = join(f.taskDir, 'plan.md')
  const gatePath = join(f.taskDir, 'gate.mjs')
  writeFileSync(planPath, '# Plan\n- handle empty output\n')
  writeFileSync(gatePath, 'export const gate = true\n')
  writeFileSync(join(f.taskDir, 'private.md'), 'must not be sent\n')
  const journal = sink(); const fetchFn = fetcher({
    class: 'edge-path', severity: 'medium', claim: 'the plan covers the boundary', evidence: ['task/plan.md:1'],
  })
  const a = advisor.createAdvisor({ env: plannerEnv, deps: {
    cwd: f.tree, taskDir: f.taskDir, appendFile: journal.appendFile,
    readFile: (path) => readFileSync(path, 'utf8'), fileMtime: () => 2, fetchFn,
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
  assert.equal(fetchFn.posts.length, 1)
  const request = JSON.parse(fetchFn.posts[0].body)
  assert.equal(request.messages[0].content, advisor.PLANNER_SYSTEM_PROMPT)
  const user = JSON.parse(request.messages[1].content)
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
    const record = advisorBootRecord({ adapters, env: values })
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
  assert.equal(advisor.BUILDER_SYSTEM_PROMPT, 'Review the builder delta for exactly two judgment classes: edge-path (checklist B1: answer EPERM, unknown, interrupted, and empty paths) and over-claim (checklist B2: record no verdict stronger than what was measured). Return JSON with class, severity, claim, and evidence.')
  assert.equal(advisor.PLANNER_SYSTEM_PROMPT, 'Review the planner delta for exactly two judgment classes: edge-path (a plan or gate omits or mishandles a required boundary, failure case, or acceptance path) and over-claim (a Ground truth citation that does not hold at the ref where the plan was written). Return JSON with class, severity, claim, and evidence.')
  assert.match(advisor.PLANNER_SYSTEM_PROMPT, /plan or gate omits or mishandles a required boundary, failure case, or acceptance path/)
  assert.match(advisor.PLANNER_SYSTEM_PROMPT, /Ground truth citation that does not hold at the ref where the plan was written/)
  assert.doesNotMatch(advisor.PLANNER_SYSTEM_PROMPT, /EPERM, unknown, interrupted, and empty paths/)
  assert.deepEqual(advisor.JUDGMENT_CLASSES, ['edge-path', 'over-claim'])
})

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
async function spendRun(frames, { raw = '', close = [0, null], extraDeps = {} } = {}) {
  const childSpawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = { end() { setImmediate(() => {
      for (const frame of frames) child.stdout.write(JSON.stringify(frame) + '\n')
      if (raw) child.stdout.write(raw)
      if (close !== null) setImmediate(() => child.emit('close', close[0], close[1]))
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
    assert.ok(c.journal.rows.find((row) => row.advisor_note?.outcome === 'rejected')?.advisor_note.codes.includes('transport-failed'))
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
