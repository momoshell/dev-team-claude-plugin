import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'; import { ROOT, scratchDir } from '../../../test/helpers.mjs'

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mod from './subagent.ts'

const EXTENSION = fileURLToPath(new URL('./subagent.ts', import.meta.url))
const FINDINGS = {
  summary: 'one sentence',
  findings: [{ claim: 'a fact', evidence: ['crew/crew.mjs:1'], confidence: 'verified' }],
}
const USAGE = {
  input: 100, output: 20, cacheRead: 5, cacheWrite: 7, totalTokens: 132,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
}

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
  now = () => '2026-08-20T00:00:00.000Z',
} = {}) {
  const root = sharedRoot || scratchDir('subagent-suite-')
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
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
    now,
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
    const path = join(taskDir, 'journal.jsonl')
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
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]); const allNodeImports = imports.every((specifier) => specifier.startsWith('node:'))
  assert.ok(imports.length > 0)
  assert.ok(allNodeImports || imports.every((specifier) => specifier.startsWith('node:') || ['../../adapters/adapter-pi.mjs', '../context-layout.mjs'].includes(specifier)), imports.join(', '))
  const adapterSource = readFileSync(join(dirname(EXTENSION), '../../adapters/adapter-pi.mjs'), 'utf8')
  const adapterImports = [...adapterSource.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.deepEqual(adapterImports.filter((specifier) => !specifier.startsWith('node:')), [])
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

test('loadAgentDefinition mirrors the register four refusal classes', () => {
  const unreadable = mod.loadAgentDefinition({ name: 'scout', def: '/missing' }, { readFile: () => { throw new Error('EPERM') } })
  assert.match(unreadable.error, /unreadable/)
  const unparseable = mod.loadAgentDefinition({ name: 'scout', def: '/bad' }, { readFile: () => '{' })
  assert.match(unparseable.error, /unparseable/)
  const wrongName = mod.loadAgentDefinition({ name: 'scout', def: '/wrong' }, { readFile: () => JSON.stringify({ name: 'other', prompt: 'p' }) })
  assert.match(wrongName.error, /expected name/)
  const badPrompt = mod.loadAgentDefinition({ name: 'scout', def: '/prompt' }, { readFile: () => JSON.stringify({ name: 'scout', prompt: '' }) })
  assert.match(badPrompt.error, /non-empty prompt/)
  const bare = mod.loadAgentDefinition({ name: 'scout', def: '/bare' }, {
    readFile: () => JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: 'anthropic/claude-opus-5' }),
  })
  assert.match(bare.error, /found a bare string/)
  assert.match(bare.error, /declare a cell/)
  const accepted = mod.loadAgentDefinition({ name: 'scout', def: '/ok' }, {
    readFile: () => JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'anthropic', id: 'claude-opus-5' }, thinking: 'high' }),
  })
  assert.deepEqual(accepted.definition, { name: 'scout', prompt: 'p', tools: ['read'], model: 'anthropic/claude-opus-5', thinking: 'high' })
  const unknown = mod.loadAgentDefinition({ name: 'scout', def: '/unknown' }, {
    readFile: () => JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'unknown', id: 'x' } }),
  })
  assert.match(unknown.error, /refusing a guessed passthrough/)
  const noThinking = mod.loadAgentDefinition({ name: 'scout', def: '/no-thinking' }, {
    readFile: () => JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'anthropic', id: 'claude-opus-5', effort: 'low' } }),
  })
  assert.equal(noThinking.definition.thinking, 'low')
  const ownThinkingWins = mod.loadAgentDefinition({ name: 'scout', def: '/own-thinking' }, {
    readFile: () => JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'anthropic', id: 'claude-opus-5', effort: 'low' }, thinking: 'high' }),
  })
  assert.equal(ownThinkingWins.definition.thinking, 'high')
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

// Budget refusals interpolate `at ${path}`. Every assertion in this block
// therefore uses a sentence this file owns or structured data; no refusal
// assertion may match a bare token that can occur in a filesystem path.
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
  assert.equal(denied.count, undefined)

  const unknown = mod.readSpawnCount('/tmp/unknown-counter', () => { throw new Error('unknown read failure') })
  assert.match(unknown.error, /could not be read/)
  for (const body of ['', 'not json', '{"spawns":', '{"spawns":"3"}', '{"spawns":-1}', '{"spawns":1.5}', '{}']) {
    const malformed = mod.readSpawnCount('/tmp/malformed-counter', () => body)
    assert.equal(typeof malformed.error, 'string', body)
    assert.equal(malformed.count, undefined, body)
  }
})

test('a corrupt spawn counter refuses rather than resetting', async () => {
  for (const bytes of ['not json', '{"spawns":"3"}', '{"spawns":-1}', '{"spawns":1.5}', '{}']) {
    const root = scratchDir('subagent-budget-corrupt-')
    const taskDir = join(root, 'task')
    mkdirSync(taskDir, { recursive: true })
    const counter = join(taskDir, 'subagent-spawns.json')
    writeFileSync(counter, bytes)
    const run = await driven(mod, { root })
    assert.equal(run.calls.length, 0, bytes)
    assert.equal(refusedOf(run.result).startsWith('refused: '), true)
    assert.equal(readFileSync(counter, 'utf8'), bytes, bytes)
  }
})

test('an unset CREW_TASK_DIR refuses because the budget cannot be scoped', async () => {
  const run = await driven(mod, { env: { CREW_TASK_DIR: undefined } })
  assert.equal(run.calls.length, 0)
  assert.equal(refusedOf(run.result).startsWith('refused: '), true)
  assert.equal(refusedOf(run.result).includes('cannot be scoped'), true)
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
  assert.equal(refusedOf(run.result).startsWith('refused: '), true)
  assert.equal(refusedOf(run.result).includes('counter could not be recorded'), true)
})

test('ctx supplies the child model, thinking level and cwd', async () => {
  const run = await driven(mod, { defBody: JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'] }) })
  const args = run.calls[0].args
  assert.equal(args[args.indexOf('--model') + 1], 'openai-codex/gpt-5.6-luna')
  assert.equal(args[args.indexOf('--thinking') + 1], 'medium')
  assert.equal(run.calls[0].options.cwd, run.context.cwd)
  const pinned = await driven(mod, {
    defBody: JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'anthropic', id: 'custom' } }),
  })
  assert.equal(pinned.calls[0].args[pinned.calls[0].args.indexOf('--model') + 1], 'anthropic/custom')
  assert.equal(pinned.calls[0].args.includes('--thinking'), false)
  const pinnedThinking = await driven(mod, {
    defBody: JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'anthropic', id: 'custom' }, thinking: 'high' }),
  })
  assert.equal(pinnedThinking.calls[0].args[pinnedThinking.calls[0].args.indexOf('--model') + 1], 'anthropic/custom')
  assert.equal(pinnedThinking.calls[0].args[pinnedThinking.calls[0].args.indexOf('--thinking') + 1], 'high')
  const unresolved = await driven(mod, {
    defBody: JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'no-such-provider', id: 'x' } }),
  })
  assert.equal(unresolved.calls.length, 0)
  assert.match(`${textOf(unresolved.result)} ${refusedOf(unresolved.result)}`, /refusing a guessed passthrough/)
})

// --- scout nudge ---------------------------------------------------------
function nudgeFixture(overrides = {}) {
  const taskDir = join(scratchDir('scout-nudge-'), 'task')
  mkdirSync(taskDir, { recursive: true })
  const env = { CREW_ROLE: 'planner', CREW_TASK_DIR: taskDir }
  const sends = []
  const nudge = mod.createScoutNudge({ env, send: (message, options) => sends.push({ message, options }), now: () => '2026-10-29T00:00:00.000Z', ...overrides })
  const journal = join(taskDir, 'journal.jsonl')
  const rows = () => (existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.scout_nudge) : [])
  return { nudge, sends, rows, journal }
}
const DIRS = ['a', 'b', 'c']
function readRun(nudge, n) {
  for (let i = 0; i < n; i += 1) {
    assert.equal(nudge.onToolCall({ toolName: 'read', input: { path: `${DIRS[i % DIRS.length]}/f${i}.mjs` } }), undefined)
  }
}

test('the scout nudge never throws into the seat: a failing journal or send still behaves', () => {
  const journalFails = nudgeFixture({ appendFile: () => { throw new Error('disk full') } })
  readRun(journalFails.nudge, 8)
  assert.equal(journalFails.sends.length, 1)
  const sendFails = nudgeFixture({ send: () => { throw new Error('gone') } })
  readRun(sendFails.nudge, 8)
  assert.equal(sendFails.rows().length, 1)
  assert.equal(sendFails.nudge.onToolCall(null), undefined)
})

test('the nudge handlers register only when the agent tool is granted', () => {
  const saved = process.env[mod.AGENTS_ENV]
  const register = () => {
    const events = []
    mod.default({ registerTool: () => {}, on: (event) => events.push(event), sendMessage: () => {} })
    return events
  }
  try {
    delete process.env[mod.AGENTS_ENV]
    assert.deepEqual(register(), ['tool_result'])
    process.env[mod.AGENTS_ENV] = JSON.stringify([{ name: 'scout', def: join(ROOT, 'crew/pi/agents/scout.json') }])
    assert.deepEqual(register(), ['tool_result', 'tool_call'])
  } finally {
    if (saved === undefined) delete process.env[mod.AGENTS_ENV]; else process.env[mod.AGENTS_ENV] = saved
  }
})
