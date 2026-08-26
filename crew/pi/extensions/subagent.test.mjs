import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'; import { ROOT, scratchDir } from '../../../test/helpers.mjs'

import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mod from './subagent.ts'
import * as adapter from '../../adapters/adapter-pi.mjs'
import * as capabilities from '../../capabilities.mjs'
import * as rpc from '../../headless-rpc.mjs'

const EXTENSION = fileURLToPath(new URL('./subagent.ts', import.meta.url))
const FINDINGS = {
  summary: 'one sentence',
  findings: [{ claim: 'a fact', evidence: ['crew/crew.mjs:1'], confidence: 'verified' }],
}
const MULTIBYTE = 'orbit 🛰 relay → done'
const USAGE = {
  input: 100, output: 20, cacheRead: 5, cacheWrite: 7, totalTokens: 132,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
}
const PI_TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
const PI_COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total']

function messageEnd(text, usage) {
  const message = { role: 'assistant', content: [{ type: 'text', text }] }
  if (usage !== undefined) message.usage = usage
  return JSON.stringify({ type: 'message_end', message })
}

function childLines(payload, usage = USAGE) {
  const text = JSON.stringify(payload)
  return [
    JSON.stringify({ type: 'session', id: 'x' }),
    messageEnd(text, usage),
    JSON.stringify({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage } }),
    JSON.stringify({ type: 'agent_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage } }),
  ]
}

function asChunks(lines) {
  return [Buffer.from(`${lines.join('\n')}\n`, 'utf8')]
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kills = []
  child.kill = (signal) => { child.kills.push(signal); return true }
  return child
}

function textOf(result) {
  return result?.content?.[0]?.text ?? ''
}

function refusedOf(result) {
  return result?.details?.refused ?? ''
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

function lineCount(value) {
  return String(value ?? '').split('\n').length
}

function paramsForGrants(grants) {
  const env = grants.length ? { [mod.AGENTS_ENV]: JSON.stringify(grants) } : {}
  return mod.createAgentTool({ env }).parameters
}

async function drive(extension, {
  env = {},
  params = { agent: 'scout', task: 'find the thing' },
  ctx,
  chunks = asChunks(childLines(FINDINGS)),
  stderrChunks = [],
  code = 0,
  spawnMode = 'ok',
  defFile,
  defBody,
  signal,
  killGraceMs = 1234,
  cwd,
  mkTempDir,
  root: sharedRoot,
  writeFile,
} = {}) {
  const root = sharedRoot || scratchDir('subagent-suite-')
  const taskDir = join(root, 'task')
  let definitionPath = defFile === undefined ? join(ROOT, 'crew/pi/agents/scout.json') : defFile
  if (defBody !== undefined) {
    definitionPath = join(root, 'scout.json')
    writeFileSync(definitionPath, defBody)
  }
  const seatEnv = {
    CREW_ROLE: 'planner',
    CREW_TASK_DIR: taskDir,
    [extension.AGENTS_ENV]: JSON.stringify([{ name: 'scout', def: definitionPath }]),
    ...env,
  }
  for (const key of Object.keys(seatEnv)) if (seatEnv[key] === undefined) delete seatEnv[key]

  const calls = []
  const timers = []
  const child = fakeChild()
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (spawnMode === 'throw') throw new Error(`SPAWN_THROW_MARKER ${'W'.repeat(64)}`)
    if (spawnMode === 'hang') return child
    if (spawnMode === 'async-error') {
      setImmediate(() => {
        for (const chunk of chunks) child.stdout.emit('data', chunk)
        child.emit('error', new Error('child EPERM'))
      })
      return child
    }
    setImmediate(() => {
      for (const chunk of chunks) child.stdout.emit('data', chunk)
      for (const chunk of stderrChunks) child.stderr.emit('data', chunk)
      child.emit('close', code, null)
    })
    return child
  }

  const deps = {
    env: seatEnv,
    spawn,
    argv: ['/abs/node', '/abs/pi-cli.js'],
    execPath: '/abs/node',
    existsSync: () => true,
    now: () => '2026-08-20T00:00:00.000Z',
    randomId: () => 's1',
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, fired: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true },
    killGraceMs,
  }
  if (mkTempDir) deps.mkTempDir = mkTempDir
  if (writeFile) deps.writeFile = writeFile
  const tool = extension.createAgentTool(deps)
  const context = ctx === undefined
    ? { cwd: cwd === undefined ? root : cwd, model: { provider: 'openai-codex', id: 'gpt-5.6-luna' }, thinkingLevel: 'medium' }
    : ctx
  const settled = { done: false }
  const promise = tool.execute('call-1', params, signal, undefined, context).then((value) => {
    settled.done = true
    return value
  })
  const readJournal = () => {
    const path = join(dirname(taskDir), 'journal.jsonl')
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
  }
  const fire = (timer) => { timer.fired = true; timer.fn() }
  return { promise, settled, calls, timers, child, readJournal, root, taskDir, tool, context, fire }
}

async function driven(extension, options) {
  const run = await drive(extension, options)
  const result = await run.promise
  return { ...run, result, journal: run.readJournal() }
}

test('the module is zero-dep, erasable, and carries the vendored MIT notice', () => {
  const source = readFileSync(EXTENSION, 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')), imports.join(', '))
  assert.doesNotMatch(source, /^\s*enum\s/m)
  assert.doesNotMatch(source, /^\s*namespace\s/m)
  for (const phrase of [
    'MIT License',
    'Copyright (c) 2025 Mario Zechner',
    'Permission is hereby granted, free of charge',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
    'MERCHANTABILITY',
    'NONINFRINGEMENT',
    '@earendil-works/pi-coding-agent',
  ]) assert.ok(source.includes(phrase), phrase)
  assert.equal(typeof mod.default, 'function')
})

test('the factory registers exactly one agent tool and one tool_result handler', () => {
  const tools = []
  const handlers = []
  mod.default({ registerTool: (tool) => tools.push(tool), on: (event, handler) => handlers.push([event, handler]) })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'agent')
  assert.equal(typeof tools[0].execute, 'function')
  assert.equal(tools[0].executionMode, 'sequential')
  assert.ok(tools[0].label)
  assert.ok(tools[0].description)
  assert.equal(handlers.length, 1)
  assert.deepEqual(handlers.map(([event]) => event), ['tool_result'])
})

test('the parameters schema constrains nothing and execute enforces the arguments', async () => {
  const schema = mod.AGENT_PARAMS
  assert.equal(schema.additionalProperties, true)
  assert.equal(Object.hasOwn(schema, 'required'), false)
  for (const property of Object.values(schema.properties)) {
    for (const key of ['type', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'format', 'anyOf', 'oneOf', 'allOf']) {
      assert.equal(Object.hasOwn(property, key), false, key)
    }
  }
  for (const params of [{}, { task: 'x' }, { agent: 12, task: 'x' }, { agent: 'scout' }]) {
    const run = await driven(mod, { params })
    assert.ok(run.result.details.refused, JSON.stringify(params))
    assert.equal(run.calls.length, 0)
  }
  const extra = await driven(mod, { params: { agent: 'scout', task: 'x', extra: 'ignored' } })
  assert.equal(extra.result.details.refused, undefined)
  assert.equal(extra.calls.length, 1)
})

test('the parameters schema advertises exactly the one granted agent name', () => {
  const params = paramsForGrants([{ name: 'scout', def: '/tmp/scout.json' }])
  assert.deepEqual(params.properties.agent.enum, ['scout'])
})

test('the parameters schema advertises exactly the two granted agent names', () => {
  const params = paramsForGrants([
    { name: 'scout', def: '/tmp/scout.json' },
    { name: 'archivist', def: '/tmp/archivist.json' },
  ])
  assert.deepEqual(params.properties.agent.enum, ['scout', 'archivist'])
  assert.equal(params.additionalProperties, true)
  assert.equal(Object.hasOwn(params, 'required'), false)
  assert.deepEqual(params.properties.agent, {
    description: mod.AGENT_PARAMS.properties.agent.description,
    enum: ['scout', 'archivist'],
  })
  assert.deepEqual(params.properties.task, mod.AGENT_PARAMS.properties.task)
})

test('an empty allowlist keeps the permissive schema and the register refusal', async () => {
  const params = paramsForGrants([])
  assert.equal(params, mod.AGENT_PARAMS)
  assert.equal(Object.hasOwn(params.properties.agent, 'enum'), false)
  const run = await driven(mod, { env: { [mod.AGENTS_ENV]: undefined } })
  assert.match(refusedOf(run.result), /no spawnable agents are granted to this seat/)
  assert.equal(run.calls.length, 0)
})

test('the b33 long ungranted name stays out of the model-visible refusal', async () => {
  const marker = 'QQMARKERQQ'
  const run = await driven(mod, {
    env: {
      [mod.AGENTS_ENV]: JSON.stringify([
        { name: 'scout', def: '/tmp/scout.json' },
        { name: 'archivist', def: '/tmp/archivist.json' },
      ]),
    },
    params: { agent: marker + 'Z'.repeat(60000), task: 'go' },
  })
  assert.ok(run.result.details.refused)
  assert.equal(textOf(run.result).includes(marker), false)
  assert.equal(byteLength(run.result.details.agent), mod.AGENT_NAME_CAP_BYTES)
  assert.equal(run.calls.length, 0)
})

test('the findings validator returns closed payload-free codes', () => {
  const allowed = new Set(mod.FINDINGS_ERROR_CODES)
  const malformed = [
    null,
    [],
    { unknown_marker: 'X'.repeat(1000) },
    { summary: '', findings: [] },
    { summary: 'ok', findings: [{}] },
    { summary: 'ok', findings: [{ claim: 'x', evidence: [1], confidence: 'maybe' }] },
    { summary: 'ok', findings: [{ claim: 'x', evidence: ['e'], confidence: 'verified', extra_marker: 'X' }] },
    { summary: 'ok', findings: [{ claim: 'x', evidence: ['e'], confidence: 'verified' }], gaps: [1] },
  ]
  for (const value of malformed) {
    const errors = mod.validateFindings(value)
    assert.ok(errors.length)
    assert.ok(errors.every((code) => allowed.has(code)), errors.join(', '))
    assert.equal(errors.some((code) => code.includes('X')), false)
  }
  assert.deepEqual(mod.validateFindings(FINDINGS), [])
})

test('extractFindings classifies every malformed reply payload-free', () => {
  assert.equal(mod.extractFindings('').error, 'the child returned no text')
  assert.deepEqual(mod.extractFindings(JSON.stringify(FINDINGS)).value, FINDINGS)
  assert.equal(mod.extractFindings('{"marker":"QQQ"').error, "the child's JSON did not parse")
  assert.equal(mod.extractFindings('ordinary prose').error, 'the child returned prose, not a findings payload')
  assert.deepEqual(mod.extractFindings(`before\n\`\`\`json\n${JSON.stringify(FINDINGS)}\n\`\`\``).value, FINDINGS)
  assert.match(mod.extractFindings('```json\n{}\n```\n```json\n{}\n```').error, /exactly one/)
  assert.equal(mod.extractFindings('```json\n{"marker":\n```').error, "the child's fenced JSON did not parse")
})

test('parseAgentAllowlist treats every malformed allowlist as no capability', () => {
  for (const raw of [undefined, null, '', '   ', '{', '{}', '[]', 'null', '42']) {
    assert.deepEqual(mod.parseAgentAllowlist(raw), [], String(raw))
  }
  const parsed = mod.parseAgentAllowlist(JSON.stringify([
    { name: 'scout', def: '/tmp/scout.json' },
    null,
    { name: 'missing-def' },
    { def: '/tmp/missing-name.json' },
    { name: 4, def: '/tmp/wrong-name.json' },
  ]))
  assert.deepEqual(parsed, [{ name: 'scout', def: '/tmp/scout.json' }])
})

test('loadAgentDefinition mirrors the register four refusal classes', () => {
  const unreadable = mod.loadAgentDefinition({ name: 'scout', def: '/missing' }, { readFile: () => { throw new Error('EPERM') } })
  assert.match(unreadable.error, /unreadable/)
  const unparseable = mod.loadAgentDefinition({ name: 'scout', def: '/bad' }, { readFile: () => '{' })
  assert.match(unparseable.error, /unparseable/)
  const wrongName = mod.loadAgentDefinition({ name: 'scout', def: '/wrong' }, { readFile: () => JSON.stringify({ name: 'other', prompt: 'p' }) })
  assert.match(wrongName.error, /expected name/)
  const badPrompt = mod.loadAgentDefinition({ name: 'scout', def: '/prompt' }, { readFile: () => JSON.stringify({ name: 'scout', prompt: '' }) })
  assert.match(badPrompt.error, /non-empty prompt/)
  const accepted = mod.loadAgentDefinition({ name: 'scout', def: '/ok' }, {
    readFile: () => JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: 'm', thinking: 'high' }),
  })
  assert.deepEqual(accepted.definition, { name: 'scout', prompt: 'p', tools: ['read'], model: 'm', thinking: 'high' })
  const noThinking = mod.loadAgentDefinition({ name: 'scout', def: '/no-thinking' }, {
    readFile: () => JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: 'm' }),
  })
  assert.equal(noThinking.definition.thinking, undefined)
  const defaults = mod.loadAgentDefinition({ name: 'scout', def: '/defaults' }, { readFile: () => JSON.stringify({ name: 'scout', prompt: 'p' }) })
  assert.deepEqual(defaults.definition.tools, ['read', 'grep', 'find', 'ls'])
})

test('every pre-spawn refusal is bounded, payload-free, spawns nothing and journals nothing', async () => {
  const cap = mod.OUTPUT_CAP_BYTES
  const huge = 'A'.repeat(cap + 4096)
  const arms = [
    { params: { agent: `REQUEST_MARKER_${huge}`, task: 'go' } },
    { env: { [mod.DEPTH_ENV]: `1${'0'.repeat(cap + 4096)}` } },
    { env: { [mod.AGENTS_ENV]: undefined } },
    { defBody: JSON.stringify({ name: 'scout', prompt: [huge] }) },
    { params: { agent: 'scout', task: '' } },
  ]
  for (const options of arms) {
    const run = await driven(mod, options)
    assert.ok(run.result.details.refused)
    assert.ok(byteLength(textOf(run.result)) <= cap)
    assert.ok(byteLength(refusedOf(run.result)) <= cap)
    assert.ok(!textOf(run.result).includes('�'))
    assert.ok(!refusedOf(run.result).includes('�'))
    assert.equal(run.calls.length, 0)
    assert.equal(Object.hasOwn(run.result, 'usage'), false)
    assert.equal(run.journal.length, 0)
  }
  const wide = mod.boundRefusalText(`refused: ${'→'.repeat(cap)}`)
  assert.ok(byteLength(wide) <= cap)
  assert.equal(wide.includes('�'), false)
  const tall = mod.boundRefusalText(`refused:\n${'x\n'.repeat(mod.OUTPUT_CAP_LINES + 500)}`)
  assert.ok(lineCount(tall) <= mod.OUTPUT_CAP_LINES)
})

test('the child argv carries the recursion bound and the read-only boundary', async () => {
  const run = await driven(mod)
  const args = run.calls[0].args
  assert.ok(args.includes('--mode'))
  assert.ok(args.includes('--no-session'))
  assert.ok(args.includes('--no-extensions'))
  assert.ok(args.includes('--no-skills'))
  assert.ok(args.includes('--exclude-tools'))
  assert.equal(args[args.indexOf('--exclude-tools') + 1], 'edit,write,bash')
  assert.ok(args.includes('--append-system-prompt'))
  assert.equal(args.includes('--provider'), false)
  const childEnv = run.calls[0].options.env
  assert.equal(childEnv[mod.DEPTH_ENV], '1')
  assert.equal(childEnv[mod.AGENTS_ENV], undefined)
})

test('the child is spawned under a deadline that escalates to SIGKILL', async () => {
  const run = await drive(mod, { spawnMode: 'hang' })
  await new Promise((resolve) => setImmediate(resolve))
  const deadline = run.timers.find((timer) => timer.ms === mod.CHILD_TIMEOUT_MS)
  assert.ok(deadline)
  assert.equal(run.settled.done, false)
  run.fire(deadline)
  assert.ok(run.child.kills.includes('SIGTERM'))
  const escalation = run.timers.find((timer) => timer.ms === 1234 && !timer.cleared)
  assert.ok(escalation)
  run.fire(escalation)
  assert.ok(run.child.kills.includes('SIGKILL'))
  run.child.emit('close', null, 'SIGTERM')
  const result = await run.promise
  assert.match(`${textOf(result)} ${refusedOf(result)}`, /deadline|timeout|timed out/i)
  assert.equal(Object.hasOwn(result, 'usage'), false)
})

test('the child is spawned into a validated cwd from an absolutely resolved executable', async () => {
  const tier1 = mod.resolvePiBinary({ argv: ['/abs/node', '/script.js'], execPath: '/abs/node', existsSync: () => true })
  assert.deepEqual(tier1, { command: '/abs/node', args: ['/script.js'] })
  const compiled = mod.resolvePiBinary({ argv: ['/abs/pi', '/$bunfs/root/pi'], execPath: '/abs/pi', existsSync: () => true })
  assert.deepEqual(compiled, { command: '/abs/pi', args: [] })
  assert.ok(mod.resolvePiBinary({ argv: ['node', 'cli.js'], execPath: 'node', existsSync: () => false }).error)
  for (const cwd of ['/gone/nowhere/really', 'crew', '']) {
    const run = await driven(mod, { cwd })
    assert.ok(run.result.details.refused, cwd)
    assert.equal(run.calls.length, 0)
    assert.equal(run.journal.length, 0)
  }
  const valid = await driven(mod)
  assert.equal(valid.calls.length, 1)
  assert.equal(valid.calls[0].command, '/abs/node')
  assert.equal(valid.calls[0].options.cwd, valid.context.cwd)
  assert.equal(valid.calls[0].options.shell, false)
  assert.deepEqual(valid.calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
})

test('the ndjson reader is byte-incremental across a split utf-8 sequence', async () => {
  const payload = { summary: MULTIBYTE, findings: [{ claim: MULTIBYTE, evidence: [MULTIBYTE], confidence: 'verified' }] }
  const raw = Buffer.from(`${childLines(payload, null).join('\n')}\n`, 'utf8')
  let cut = -1
  for (let i = 1; i < raw.length; i += 1) {
    if ((raw[i] & 0xC0) === 0x80) { cut = i; break }
  }
  assert.ok(cut > 0, 'fixture must contain a UTF-8 continuation byte')
  assert.equal((raw[cut] & 0xC0) === 0x80, true, 'split must be inside a multibyte sequence')
  const split = await driven(mod, { chunks: [raw.subarray(0, cut), raw.subarray(cut)] })
  assert.equal(split.result.details.refused, undefined)
  assert.equal(JSON.stringify(split.result).includes('�'), false)
  assert.deepEqual(split.result.details.findings, payload)
  const tail = await driven(mod, { chunks: [Buffer.from(childLines(FINDINGS, null).join('\n'), 'utf8')] })
  assert.equal(tail.result.details.refused, undefined)
})

test('the stream cap counts raw bytes, not decoded characters', async () => {
  const cap = mod.STREAM_CAP_BYTES
  assert.ok(Number.isSafeInteger(cap))
  const pad = '→'.repeat(Math.ceil(cap / 3) + 1024)
  const stream = Buffer.from(`${JSON.stringify({ type: 'noise', pad })}\n${childLines(FINDINGS).join('\n')}\n`, 'utf8')
  assert.ok(stream.length > cap)
  assert.ok(stream.toString('utf8').length < cap)
  const run = await driven(mod, { chunks: [stream] })
  assert.ok(run.result.details.refused)
  assert.ok(byteLength(textOf(run.result)) <= mod.OUTPUT_CAP_BYTES)
})

test('the result caps refuse rather than silently truncate a findings payload', async () => {
  const oversized = { summary: 'x'.repeat(mod.OUTPUT_CAP_BYTES), findings: FINDINGS.findings }
  const byBytes = await driven(mod, { chunks: asChunks(childLines(oversized, null)) })
  assert.match(refusedOf(byBytes.result), /result cap|over/i)
  assert.equal(byBytes.result.details.findings, undefined)
  const byLines = { summary: 'small', findings: FINDINGS.findings, gaps: Array(mod.OUTPUT_CAP_LINES + 50).fill('x') }
  const lineRun = await driven(mod, { chunks: asChunks(childLines(byLines, null)) })
  assert.match(refusedOf(lineRun.result), /lines/i)
  assert.equal(lineRun.result.details.findings, undefined)
})

test('usage is a complete pi Usage or absent, never partial', async () => {
  const measured = await driven(mod)
  assert.equal(measured.result.details.refused, undefined)
  const usage = measured.result.usage
  assert.ok(usage)
  for (const field of PI_TOKEN_FIELDS) assert.equal(usage[field], USAGE[field])
  for (const field of PI_COST_FIELDS) assert.equal(usage.cost[field], USAGE.cost[field])
  const totals = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.totalTokens + usage.cost.total
  assert.ok(Number.isFinite(totals))
  assert.equal(mod.foldUsage([]), null)
  assert.equal(mod.foldPiUsage([]), null)
  const absent = await driven(mod, { chunks: asChunks(childLines(FINDINGS, null)) })
  assert.equal(Object.hasOwn(absent.result, 'usage'), false)
  assert.equal(absent.result.details.usage, null)
})

test('the journal records exactly one row per spawn', async () => {
  const run = await driven(mod)
  assert.equal(run.journal.length, 1)
  const row = JSON.parse(run.journal[0])
  assert.equal(row.role, 'planner')
  assert.equal(row.subagent_usage.spawn_id, 's1')
  assert.equal(row.subagent_usage.agent, 'scout')
  assert.equal(row.subagent_usage.outcome, 'ok')
  assert.equal(row.usage.billed_input_tokens, USAGE.input)
})

test('the call blocks until close, including on an asynchronous child error', async () => {
  const run = await drive(mod, { spawnMode: 'async-error' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(run.settled.done, false)
  run.child.emit('close', -2, null)
  const result = await run.promise
  assert.match(refusedOf(result), /fail|EPERM|spawn/i)
  assert.doesNotMatch(refusedOf(result), /exited -2/)
  assert.equal(run.readJournal().length, 1)
})

test('abort sends SIGTERM then a cancellable SIGKILL', async () => {
  const controller = new AbortController()
  const run = await drive(mod, { spawnMode: 'hang', signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(run.child.kills.includes('SIGTERM'))
  const escalation = run.timers.find((timer) => timer.ms === 1234 && !timer.cleared)
  assert.ok(escalation)
  run.fire(escalation)
  assert.ok(run.child.kills.includes('SIGKILL'))
  run.child.emit('close', null, 'SIGTERM')
  const result = await run.promise
  assert.match(refusedOf(result), /aborted/i)

  const cancelledController = new AbortController()
  const cancelled = await drive(mod, { spawnMode: 'hang', signal: cancelledController.signal })
  await new Promise((resolve) => setImmediate(resolve))
  cancelledController.abort()
  await new Promise((resolve) => setImmediate(resolve))
  const cancelledEscalation = cancelled.timers.find((timer) => timer.ms === 1234 && !timer.cleared)
  assert.ok(cancelledEscalation)
  cancelled.child.emit('close', null, 'SIGTERM')
  await cancelled.promise
  assert.equal(cancelledEscalation.cleared, true)
  assert.equal(cancelled.child.kills.includes('SIGKILL'), false)
})

test('cleanup removes the prompt file and its temp dir on every path', async () => {
  const temp = scratchDir('subagent-cleanup-')
  const run = await driven(mod, { mkTempDir: () => temp })
  assert.equal(existsSync(temp), false)
  assert.equal(run.journal.length, 1)
  const temp2 = scratchDir('subagent-cleanup-')
  const thrown = await driven(mod, { mkTempDir: () => temp2, spawnMode: 'throw' })
  assert.ok(thrown.result.details.refused)
  assert.equal(existsSync(temp2), false)
})

test('the spawn counter path is beside the task directory', () => {
  assert.equal(mod.spawnCountPathFrom('/tmp/example-run/task'), '/tmp/example-run/subagent-spawns.json')
})

test('an absent spawn counter starts at zero while other read errors refuse', () => {
  const absent = mod.readSpawnCount('/tmp/missing-counter', () => {
    const error = new Error('missing')
    error.code = 'ENOENT'
    throw error
  })
  assert.equal(absent.count, 0)
  assert.equal(absent.error, undefined)
  const denied = mod.readSpawnCount('/tmp/denied-counter', () => {
    const error = new Error('permission denied')
    error.code = 'EPERM'
    throw error
  })
  assert.match(denied.error, /could not be read/)
})

test('reserveSpawn increments the counter before allowing a child', () => {
  let writtenPath = ''
  let writtenBody = ''
  let writtenOptions
  const reserved = mod.reserveSpawn({
    taskDir: '/tmp/example-run/task',
    readFile: () => '{"spawns": 3}',
    writeFile: (path, body, options) => {
      writtenPath = path
      writtenBody = body
      writtenOptions = options
    },
    budget: 4,
  })
  assert.equal(reserved.count, 4)
  assert.equal(writtenPath, '/tmp/example-run/subagent-spawns.json')
  assert.equal(writtenBody, '{"spawns":4}\n')
  assert.equal(writtenOptions.mode, 0o600)
})

test('the spawn budget is cumulative per run and refuses when it is spent', async () => {
  assert.equal(Number.isInteger(mod.SUBAGENT_SPAWN_BUDGET), true)
  assert.equal(mod.SUBAGENT_SPAWN_BUDGET > 0, true)
  const root = scratchDir('subagent-budget-')
  for (let i = 0; i < mod.SUBAGENT_SPAWN_BUDGET; i += 1) {
    const run = await driven(mod, { root })
    assert.equal(run.calls.length, 1, `spawn ${i + 1}`)
    assert.equal(run.result.details.refused, undefined, `spawn ${i + 1}`)
  }
  const exhausted = await driven(mod, { root })
  const refusal = refusedOf(exhausted.result)
  assert.equal(exhausted.calls.length, 0)
  assert.match(refusal, /^refused: /)
  assert.match(refusal, /budget/i)
  assert.equal(/the child /.test(refusal), false)
})

test('the budget is scoped to the run, not to the seat', async () => {
  const root = scratchDir('subagent-budget-scope-')
  for (let i = 0; i < mod.SUBAGENT_SPAWN_BUDGET; i += 1) await driven(mod, { root })
  const reseated = await driven(mod, { root })
  assert.match(refusedOf(reseated.result), /^refused: /)
  assert.match(refusedOf(reseated.result), /budget/i)
  assert.equal(reseated.calls.length, 0)
  const other = await driven(mod)
  assert.equal(other.result.details.refused, undefined)
  assert.equal(other.calls.length, 1)
})

test('a corrupt spawn counter refuses rather than resetting', async () => {
  for (const bytes of ['not json', '{"spawns":"3"}', '{"spawns":-1}', '{"spawns":1.5}', '{}']) {
    const root = scratchDir('subagent-budget-corrupt-')
    const taskDir = join(root, 'task')
    const counter = mod.spawnCountPathFrom(taskDir)
    writeFileSync(counter, bytes)
    const run = await driven(mod, { root })
    assert.equal(run.calls.length, 0, bytes)
    assert.match(refusedOf(run.result), /^refused: /)
    assert.equal(readFileSync(counter, 'utf8'), bytes, bytes)
  }
})

test('an unset CREW_TASK_DIR refuses because the budget cannot be scoped', async () => {
  const run = await driven(mod, { env: { CREW_TASK_DIR: undefined } })
  assert.equal(run.calls.length, 0)
  assert.match(refusedOf(run.result), /^refused: /)
  assert.match(refusedOf(run.result), /cannot be scoped/i)
})

test('a counter that cannot be written refuses', async () => {
  const run = await driven(mod, {
    writeFile: () => {
      const error = new Error('counter denied')
      error.code = 'EACCES'
      throw error
    },
  })
  assert.equal(run.calls.length, 0)
  assert.match(refusedOf(run.result), /^refused: /)
  assert.match(refusedOf(run.result), /counter could not be recorded/i)
})

test('depth and the budget are independent bounds', async () => {
  const depth = await driven(mod, { env: { [mod.DEPTH_ENV]: '1' } })
  assert.match(refusedOf(depth.result), /spawn depth is already 1/)
  assert.equal(depth.calls.length, 0)
  assert.equal(existsSync(mod.spawnCountPathFrom(depth.taskDir)), false)

  const spentRoot = scratchDir('subagent-budget-depth-')
  const spentTaskDir = join(spentRoot, 'task')
  writeFileSync(mod.spawnCountPathFrom(spentTaskDir), JSON.stringify({ spawns: mod.SUBAGENT_SPAWN_BUDGET }))
  const budget = await driven(mod, { root: spentRoot })
  assert.match(refusedOf(budget.result), /^refused: /)
  assert.match(refusedOf(budget.result), /budget/i)
  assert.equal(budget.calls.length, 0)
})

test('a budget refusal journals a row distinguishable from a failed spawn', async () => {
  const root = scratchDir('subagent-budget-journal-')
  const failed = await driven(mod, { root, code: 1 })
  assert.equal(failed.calls.length, 1)
  assert.equal(JSON.parse(failed.journal[0]).subagent_usage.outcome, 'refused')
  for (let i = 1; i < mod.SUBAGENT_SPAWN_BUDGET; i += 1) {
    const run = await driven(mod, { root })
    assert.equal(run.result.details.refused, undefined, `spawn ${i + 1}`)
  }
  const exhausted = await driven(mod, { root })
  assert.equal(exhausted.calls.length, 0)
  assert.equal(exhausted.journal.length, mod.SUBAGENT_SPAWN_BUDGET + 1)
  const row = JSON.parse(exhausted.journal.at(-1))
  assert.equal(row.subagent_usage.outcome, mod.SPAWN_BUDGET_OUTCOME)
  assert.equal(row.subagent_usage.model, null)
  assert.equal(row.usage, null)
})

test('the refusal is bounded and payload-free', async () => {
  const root = scratchDir('subagent-budget-payload-')
  for (let i = 0; i < mod.SUBAGENT_SPAWN_BUDGET; i += 1) await driven(mod, { root })
  const taskMarker = 'TASK_PAYLOAD_MARKER'
  const agentMarker = 'AGENT_NAME_PAYLOAD_MARKER'
  const allowedAgentName = 'A'.repeat(mod.AGENT_NAME_CAP_BYTES)
  const hugeAgentName = `${allowedAgentName}${agentMarker}${'A'.repeat(52 * 1024)}`
  const run = await driven(mod, {
    root,
    env: {
      [mod.AGENTS_ENV]: JSON.stringify([{
        name: allowedAgentName, def: join(ROOT, 'crew/pi/agents/scout.json'),
      }]),
    },
    params: { agent: hugeAgentName, task: taskMarker },
  })
  const text = textOf(run.result)
  assert.equal(byteLength(text) < mod.OUTPUT_CAP_BYTES, true)
  assert.equal(text.includes(taskMarker), false)
  assert.equal(text.includes(hugeAgentName), false)
  assert.equal(text.includes(agentMarker), false)
  assert.match(refusedOf(run.result), /budget/i)
})

test('toolResultPatch flags a refusal and only a refusal', () => {
  assert.deepEqual(mod.toolResultPatch({ toolName: 'agent', details: { refused: 'refused: nope' } }), { isError: true })
  assert.equal(mod.toolResultPatch({ toolName: 'agent', details: { findings: FINDINGS } }), undefined)
  assert.equal(mod.toolResultPatch({ toolName: 'bash', details: { refused: 'x' } }), undefined)
  assert.equal(mod.toolResultPatch(null), undefined)
})

test('ctx supplies the child model, thinking level and cwd', async () => {
  const run = await driven(mod)
  const args = run.calls[0].args
  assert.equal(args[args.indexOf('--model') + 1], 'openai-codex/gpt-5.6-luna')
  assert.equal(args[args.indexOf('--thinking') + 1], 'medium')
  assert.equal(run.calls[0].options.cwd, run.context.cwd)
  const pinned = await driven(mod, {
    defBody: JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: 'anthropic/custom' }),
  })
  assert.equal(pinned.calls[0].args[pinned.calls[0].args.indexOf('--model') + 1], 'anthropic/custom')
  assert.equal(pinned.calls[0].args.includes('--thinking'), false)
  const pinnedThinking = await driven(mod, {
    defBody: JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: 'anthropic/custom', thinking: 'high' }),
  })
  assert.equal(pinnedThinking.calls[0].args[pinnedThinking.calls[0].args.indexOf('--model') + 1], 'anthropic/custom')
  assert.equal(pinnedThinking.calls[0].args[pinnedThinking.calls[0].args.indexOf('--thinking') + 1], 'high')
})

test('the granted pi seat activates the agent tool and transports the allowlist', () => {
  const grants = {
    tools: [],
    extensions: ['crew/pi/extensions/subagent.ts'],
    agents: [{ name: 'scout', def: 'crew/pi/agents/scout.json' }],
    skills: [],
    advisor: false,
  }
  const command = adapter.seatCommand({
    role: 'planner', model: 'anthropic/claude-opus-5', promptFile: '/tmp/prompt.md', tools: [],
    deny: 'Edit,Write,Bash', taskDir: '/tmp/task', bootBrief: 'boot', effort: 'high', grants,
  })
  const activated = command.match(/--tools "([^"]*)"/)?.[1].split(',') || []
  assert.ok(activated.includes('agent'))
  assert.match(command, /-e "crew\/pi\/extensions\/subagent\.ts"/)
  assert.match(command, /CREW_PI_AGENTS='/)
  const bare = adapter.seatCommand({
    role: 'planner', model: 'anthropic/claude-opus-5', promptFile: '/tmp/prompt.md', tools: [],
    deny: 'Edit', taskDir: '/tmp/task', bootBrief: 'boot', effort: undefined,
  })
  assert.equal(bare.match(/--tools "([^"]*)"/)?.[1], adapter.PI_BUILTIN_TOOLS.join(','))
  assert.equal(bare.includes('CREW_PI_AGENTS'), false)
})

test('the register resolves the shipped bundle end to end', () => {
  const register = JSON.parse(readFileSync(join(ROOT, 'crew/capabilities.json'), 'utf8'))
  register.roles.planner.extensions = ['crew/pi/extensions/subagent.ts']
  register.roles.planner.agents = [{ name: 'scout', def: 'crew/pi/agents/scout.json' }]
  const loaded = capabilities.loadCapabilities({ register })
  const grants = capabilities.grantsFor(loaded, 'planner', { root: ROOT })
  capabilities.assertGrantsBacked('planner', grants, loaded)
  assert.equal(grants.extensions[0], join(ROOT, 'crew/pi/extensions/subagent.ts'))
  assert.equal(grants.agents[0].def, join(ROOT, 'crew/pi/agents/scout.json'))
  assert.equal(mod.loadAgentDefinition(grants.agents[0]).error, undefined)
  const declared = adapter.capabilitiesFor({ transport: 'pane', grants })
  const bare = adapter.capabilitiesFor({ transport: 'pane' })
  const effective = capabilities.effectiveCapabilities({ declared, bare, grants })
  assert.equal(effective.subagents, true)
  assert.equal(basename(grants.agents[0].def), 'scout.json')
})

// ONE table, both reducers. The rule about which pi frame carries a seat's own
// spend is held in two files that cannot import each other (subagent.ts is
// zero-dep by hard constraint, and crew/headless-rpc.mjs must not take a
// type-stripped .ts module into the crew runtime), so the coupling is enforced
// HERE, where a test file may import both: every row is asserted against BOTH
// exported rules AND against what the two reducers actually fold. Make either
// side disagree and this goes red.
//
// Usage values are plain non-negative integers on purpose: the rule under test
// is which frame is admitted, not how each reducer coerces a scalar.
const OWN_SPEND_TABLE = [
  { name: "an assistant message_end is the seat's own spend", frame: { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } }, own: true },
  { name: 'a nested tool result message_end is not', frame: { type: 'message_end', message: { role: 'toolResult', toolName: 'agent', usage: { input: 500, output: 400, cacheRead: 300, cacheWrite: 200 } } }, own: false },
  { name: 'a user message_end is not', frame: { type: 'message_end', message: { role: 'user' } }, own: false },
  { name: 'a message_end stating no role is not', frame: { type: 'message_end', message: { usage: { input: 5, output: 6 } } }, own: false },
  { name: 'a message_end with no message is not', frame: { type: 'message_end' }, own: false },
  { name: 'a turn_end replay is not', frame: { type: 'turn_end', message: { role: 'assistant', usage: { input: 7, output: 8 } } }, own: false },
  { name: 'an agent_end replay is not', frame: { type: 'agent_end', message: { role: 'assistant', usage: { input: 9, output: 10 } } }, own: false },
  { name: 'a non-frame is not', frame: null, own: false },
]

test("the two reducers agree on which pi frame carries a seat's own spend", () => {
  for (const row of OWN_SPEND_TABLE) {
    assert.equal(mod.carriesOwnSpend(row.frame), row.own, `subagent.ts rule: ${row.name}`)
    assert.equal(rpc.carriesOwnSpend(row.frame), row.own, `headless-rpc.mjs rule: ${row.name}`)
  }
})

test('the two reducers agree in what they fold, not only in what they claim', () => {
  for (const row of OWN_SPEND_TABLE) {
    const usage = row.frame?.message?.usage
    const want = row.own && usage
      ? {
        billed_input_tokens: usage.input ?? 0, billed_output_tokens: usage.output ?? 0,
        billed_cache_write_tokens: usage.cacheWrite ?? 0, billed_cache_read_tokens: usage.cacheRead ?? 0,
      }
      : null
    assert.deepEqual(rpc.foldRpcUsage([row.frame]), want, `headless-rpc.mjs folded: ${row.name}`)
    assert.deepEqual(mod.foldUsage([row.frame]), want, `subagent.ts folded: ${row.name}`)
  }
})
