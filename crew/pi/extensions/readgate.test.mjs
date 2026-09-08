import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../../../test/helpers.mjs'
import * as mod from './readgate.ts'

function fixture() {
  const root = scratchDir('read-gate-')
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
  const large = join(root, 'large.txt')
  const edge = join(root, 'edge.txt')
  const noNewline = join(root, 'no-newline.txt')
  const quotedPipe = join(root, 'large|name.txt')
  const escapedPipe = join(root, 'escaped|name.txt')
  const spaced = join(root, 'large file.txt')
  const dashName = join(root, '-n')
  const plusName = join(root, '+20')
  writeFileSync(large, 'large\n'.repeat(351))
  writeFileSync(edge, 'edge\n'.repeat(350))
  writeFileSync(noNewline, Array.from({ length: 350 }, (_, index) => `line-${index}`).join('\n'))
  writeFileSync(quotedPipe, 'quoted pipe\n'.repeat(351))
  writeFileSync(escapedPipe, 'escaped pipe\n'.repeat(351))
  writeFileSync(spaced, 'spaced\n'.repeat(351))
  writeFileSync(dashName, 'dash\n'.repeat(351))
  writeFileSync(plusName, 'plus\n'.repeat(351))
  writeFileSync(join(root, 'journal.jsonl'), '')
  return { root, taskDir, large, edge, noNewline, quotedPipe, escapedPipe, spaced, dashName, plusName }
}

function call(gate, toolName, input, cwd) {
  const ctx = cwd === undefined ? {} : { cwd }
  return gate.onToolCall({ type: 'tool_call', toolName, input }, ctx)
}

function gateFor(f, options = {}) {
  return mod.createReadGate({ cwd: f.root, env: {}, taskDir: f.taskDir, ...options })
}

function unchanged(input, before) {
  assert.equal(JSON.stringify(input), before)
}

function refusal(result, path, lineCount = 351) {
  assert.equal(result?.block, true)
  assert.match(result.reason, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result.reason, new RegExp(String(lineCount)))
  assert.match(result.reason, /350/)
  assert.match(result.reason, /offset/)
  assert.match(result.reason, /limit/)
}

test('oversized whole reads and direct commands refuse without changing inputs', () => {
  const f = fixture()
  const gate = gateFor(f)
  const cases = [
    ['read', { path: f.large }, f.large],
    ['bash', { command: `cat '${f.large}'` }, f.large],
    ['bash', { command: `head '${f.large}'` }, f.large],
    ['bash', { command: `tail '${f.large}'` }, f.large],
  ]
  for (const [toolName, input, path] of cases) {
    const before = JSON.stringify(input)
    refusal(call(gate, toolName, input, f.root), path)
    unchanged(input, before)
  }
})

test('bounded head and tail count spellings pass byte-identically', () => {
  const f = fixture()
  const gate = gateFor(f)
  const commands = [
    `head -n 20 '${f.large}'`,
    `tail -c 500 '${f.large}'`,
    `head -n20 '${f.large}'`,
    `tail -c500 '${f.large}'`,
    `head -n=20 '${f.large}'`,
    `tail -c=500 '${f.large}'`,
    `head --lines 20 '${f.large}'`,
    `tail --bytes 500 '${f.large}'`,
    `head --lines=20 '${f.large}'`,
    `tail --bytes=500 '${f.large}'`,
    `head -20 '${f.large}'`,
    `tail +20 '${f.large}'`,
    `head +20 '${f.large}'`,
    `tail -20 '${f.large}'`,
  ]
  for (const command of commands) {
    const input = { command }
    const before = JSON.stringify(input)
    assert.equal(call(gate, 'bash', input, f.root), undefined, command)
    unchanged(input, before)
  }
})

test('ranged reads, grep, and real pipelines pass without capping inputs', () => {
  const f = fixture()
  const gate = gateFor(f)
  for (const input of [
    { path: f.large, offset: 999999, limit: 999999 },
    { path: f.large, offset: 999999 },
    { path: f.large, limit: 999999 },
    { path: f.large, offset: undefined },
  ]) {
    const before = JSON.stringify(input)
    assert.equal(call(gate, 'read', input, f.root), undefined)
    unchanged(input, before)
  }
  const grep = { pattern: 'large', path: f.large, extra: { keep: true } }
  const grepBefore = JSON.stringify(grep)
  assert.equal(call(gate, 'grep', grep, f.root), undefined)
  unchanged(grep, grepBefore)
  const piped = { command: `cat '${f.large}' | grep large` }
  const pipedBefore = JSON.stringify(piped)
  assert.equal(call(gate, 'bash', piped, f.root), undefined)
  unchanged(piped, pipedBefore)
})

test('350-line files remain allowed for read, cat, bounded head, and unbounded tail', () => {
  const f = fixture()
  const gate = gateFor(f)
  const cases = [
    ['read', { path: f.edge }],
    ['bash', { command: `cat '${f.edge}'` }],
    ['bash', { command: `head -n 20 '${f.edge}'` }],
    ['bash', { command: `head '${f.edge}'` }],
    ['bash', { command: `tail -c 500 '${f.edge}'` }],
    ['bash', { command: `tail '${f.edge}'` }],
  ]
  for (const [toolName, input] of cases) {
    const before = JSON.stringify(input)
    assert.equal(call(gate, toolName, input, f.root), undefined)
    unchanged(input, before)
  }
  const noNewline = { path: f.noNewline }
  const noNewlineBefore = JSON.stringify(noNewline)
  assert.equal(call(gate, 'read', noNewline, f.root), undefined)
  unchanged(noNewline, noNewlineBefore)
  assert.equal(readFileSync(f.noNewline, 'utf8').split('\n').length, 350)
})

test('quoted and escaped pipes inspect direct operands while compounds stay untouched', () => {
  const f = fixture()
  const gate = gateFor(f)
  for (const [command, path] of [
    [`cat '${f.quotedPipe}'`, f.quotedPipe],
    [`cat ${f.escapedPipe.replace('|', '\\|')}`, f.escapedPipe],
    [`cat '${f.spaced}'`, f.spaced],
  ]) {
    const input = { command }
    const before = JSON.stringify(input)
    refusal(call(gate, 'bash', input, f.root), path)
    unchanged(input, before)
  }
  for (const command of [
    `cat '${f.large}' ; echo still-unknown`,
    `cat '${f.large}' && echo still-unknown`,
    `printf '%s' '${f.large}'`,
  ]) {
    const input = { command }
    const before = JSON.stringify(input)
    assert.equal(call(gate, 'bash', input, f.root), undefined)
    unchanged(input, before)
  }
})

test('head and tail option-looking filenames after -- remain unbounded', () => {
  const f = fixture()
  assert.equal(existsSync(f.dashName), true)
  assert.equal(existsSync(f.plusName), true)
  const gate = gateFor(f)
  for (const [command, path] of [
    [`head -- -n`, '-n'],
    [`tail -- +20`, '+20'],
  ]) {
    const input = { command }
    const before = JSON.stringify(input)
    refusal(call(gate, 'bash', input, f.root), path)
    unchanged(input, before)
  }
})

test('relative paths use the tool cwd and construction cwd as fallback', () => {
  const f = fixture()
  const gate = gateFor(f)
  const fromContext = { path: 'large.txt' }
  const contextBefore = JSON.stringify(fromContext)
  refusal(call(gate, 'read', fromContext, f.root), 'large.txt')
  unchanged(fromContext, contextBefore)
  const fromConstruction = { path: 'large.txt' }
  const constructionBefore = JSON.stringify(fromConstruction)
  refusal(call(gate, 'read', fromConstruction), 'large.txt')
  unchanged(fromConstruction, constructionBefore)
})

test('threshold configuration and trailing newline counts are fail-open and observable', () => {
  const f = fixture()
  const admitted = gateFor(f, { env: { [mod.MAX_LINES_ENV]: '400' } })
  const admittedInput = { path: f.large }
  const admittedBefore = JSON.stringify(admittedInput)
  assert.equal(call(admitted, 'read', admittedInput, f.root), undefined)
  unchanged(admittedInput, admittedBefore)

  const rows = []
  const malformedInput = { path: f.large }
  const malformedBefore = JSON.stringify(malformedInput)
  const malformed = gateFor(f, {
    env: { [mod.MAX_LINES_ENV]: 'not-an-integer' },
    deps: { recordFailure: (row) => rows.push(row) },
  })
  assert.equal(call(malformed, 'read', malformedInput, f.root), undefined)
  assert.equal(rows.length, 1)
  assert.match(rows[0].read_gate_failure.reason, new RegExp(mod.MAX_LINES_ENV))
  unchanged(malformedInput, malformedBefore)

  const counts = []
  const counted = gateFor(f, { deps: { countLines: (path) => {
    const text = readFileSync(path, 'utf8')
    const count = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
    counts.push(count)
    return count
  } } })
  const edge = { path: f.edge }
  assert.equal(call(counted, 'read', edge, f.root), undefined)
  assert.deepEqual(counts, [350])
  assert.equal(mod.DEFAULT_MAX_LINES, 350)
})

test('missing files, injected failures, and throwing recorders always allow', () => {
  const f = fixture()
  const missing = gateFor(f)
  assert.equal(call(missing, 'read', { path: join(f.root, 'missing.txt') }, f.root), undefined)
  const rows = readFileSync(join(f.root, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.match(rows[0].read_gate_failure.reason, /ENOENT|no such file/i)

  const cases = [
    ['count boom', { countLines: () => { throw new Error('count boom') } }, 'read', { path: f.large }],
    ['detector boom', { hasUnquotedPipe: () => { throw new Error('detector boom') } }, 'bash', { command: `cat '${f.large}'` }],
    ['tokenizer boom', { tokenize: () => { throw new Error('tokenizer boom') } }, 'bash', { command: `cat '${f.large}'` }],
    ['classifier boom', { tokenize: () => ['head', f.large], blockedRead: () => { throw new Error('classifier boom') } }, 'bash', { command: `head '${f.large}'` }],
    ['refusal boom', { countLines: () => 351, blockedRead: () => { throw new Error('refusal boom') } }, 'read', { path: f.large }],
    ['resolve boom', { resolvePath: () => { throw new Error('resolve boom') } }, 'read', { path: f.large }],
  ]
  for (const [reason, deps, toolName, input] of cases) {
    const recorded = []
    const gate = gateFor(f, { deps: { ...deps, recordFailure: (row) => recorded.push(row) } })
    assert.doesNotThrow(() => assert.equal(call(gate, toolName, input, f.root), undefined), reason)
    assert.equal(recorded.length, 1, reason)
    assert.match(recorded[0].read_gate_failure.reason, new RegExp(reason.split(' ')[0]), reason)
    assert.equal(recorded[0].read_gate_failure.tool, toolName)
  }

  const throwingSink = gateFor(f, {
    deps: {
      countLines: () => { throw new Error('sink count boom') },
      recordFailure: () => { throw new Error('journal unavailable') },
    },
  })
  assert.doesNotThrow(() => assert.equal(call(throwingSink, 'read', { path: f.large }, f.root), undefined))
})

test('readgate is zero-dependency, erasable, and exposes one tool_call registration', () => {
  const source = readFileSync(new URL('./readgate.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')), imports.join(', '))
  assert.doesNotMatch(source, /^\s*(enum|namespace)\s/m)
  assert.deepEqual(Object.keys(mod).sort(), ['DEFAULT_MAX_LINES', 'MAX_LINES_ENV', 'attachReadGate', 'createReadGate', 'default'].sort())

  const registrations = []
  const gate = mod.attachReadGate({ on: (...args) => registrations.push(args) }, { env: {} })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0][0], 'tool_call')
  assert.equal(typeof registrations[0][1], 'function')
  assert.deepEqual(gate, { onToolCall: gate.onToolCall })
})
