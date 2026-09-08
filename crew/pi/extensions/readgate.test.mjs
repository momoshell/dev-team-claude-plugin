import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

let nextToolCallId = 0

function call(gate, toolName, input, cwd, toolCallId = `tool-call-${++nextToolCallId}`) {
  const ctx = cwd === undefined ? {} : { cwd }
  return gate.onToolCall({ type: 'tool_call', toolName, input, toolCallId }, ctx)
}

function deliver(gate, toolCallId, details = {}, extra = {}) {
  return gate.onToolResult({ type: 'tool_result', toolName: 'read', toolCallId, isError: false, details, ...extra })
}

function gateFor(f, options = {}) {
  const gate = mod.createReadGate({ cwd: f.root, env: {}, taskDir: f.taskDir, ...options })
  gate.onTurnStart({ type: 'turn_start', turnIndex: 0 })
  return gate
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

test('A1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const outer = { path: f.edge, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', outer, f.root, 'a1-outer'), undefined)
  deliver(gate, 'a1-outer')

  const exact = { path: f.edge, offset: 10, limit: 20 }
  const contained = { path: f.edge, offset: 15, limit: 5 }
  for (const input of [exact, contained]) {
    const before = JSON.stringify(input)
    const result = call(gate, 'read', input, f.root, `a1-${input.offset}`)
    assert.equal(result?.block, true)
    unchanged(input, before)
  }
})

test('B1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const input = { path: f.edge, offset: 10, limit: 20 }
  const before = JSON.stringify(input)
  assert.equal(call(gate, 'read', input, f.root, 'b1'), undefined)
  unchanged(input, before)
})

test('C1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.edge, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'c1-first'), undefined)
  deliver(gate, 'c1-first')
  const disjoint = { path: f.edge, offset: 40, limit: 5 }
  const before = JSON.stringify(disjoint)
  assert.equal(call(gate, 'read', disjoint, f.root, 'c1-disjoint'), undefined)
  unchanged(disjoint, before)
})

test('C2', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.edge, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'c2-first'), undefined)
  deliver(gate, 'c2-first')
  const partial = { path: f.edge, offset: 25, limit: 20 }
  const before = JSON.stringify(partial)
  assert.equal(call(gate, 'read', partial, f.root, 'c2-partial'), undefined)
  unchanged(partial, before)
})

test('D1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.edge, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'd1-first'), undefined)
  deliver(gate, 'd1-first')
  writeFileSync(f.edge, `changed\n${'edge\n'.repeat(349)}`)
  const repeat = { path: f.edge, offset: 10, limit: 20 }
  const before = JSON.stringify(repeat)
  assert.equal(call(gate, 'read', repeat, f.root, 'd1-repeat'), undefined)
  unchanged(repeat, before)
})

test('E1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const input = { path: f.large }
  const before = JSON.stringify(input)
  assert.deepEqual(call(gate, 'read', input, f.root, 'e1'), {
    block: true,
    reason: `Refusing whole-file read of ${f.large}: 351 lines exceeds threshold 350. Use a ranged read, for example: read ${JSON.stringify({ path: f.large, offset: 1, limit: 350 })}`,
  })
  unchanged(input, before)
})

test('E2', () => {
  const f = fixture()
  const gate = gateFor(f)
  const input = { path: f.edge }
  const before = JSON.stringify(input)
  assert.equal(call(gate, 'read', input, f.root, 'e2'), undefined)
  unchanged(input, before)
})

test('F1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const input = { pattern: 'edge', path: f.large, extra: { keep: true } }
  const before = JSON.stringify(input)
  assert.equal(call(gate, 'grep', input, f.root, 'f1'), undefined)
  unchanged(input, before)
})

test('F2', () => {
  const f = fixture()
  const gate = gateFor(f)
  const input = { command: `cat '${f.large}' | grep large` }
  const before = JSON.stringify(input)
  assert.equal(call(gate, 'bash', input, f.root, 'f2'), undefined)
  unchanged(input, before)
})

test('F3', () => {
  const f = fixture()
  const gate = gateFor(f)
  const input = { value: f.large, nested: { keep: true } }
  const before = JSON.stringify(input)
  assert.equal(call(gate, 'other-tool', input, f.root, 'f3'), undefined)
  unchanged(input, before)
})

test('G1', () => {
  const f = fixture()
  const firstGate = gateFor(f)
  const first = { path: f.edge, offset: 10, limit: 20 }
  assert.equal(call(firstGate, 'read', first, f.root, 'g1-first'), undefined)
  deliver(firstGate, 'g1-first')
  const secondGate = gateFor(f)
  const repeat = { path: f.edge, offset: 10, limit: 20 }
  const before = JSON.stringify(repeat)
  assert.equal(call(secondGate, 'read', repeat, f.root, 'g1-second'), undefined)
  unchanged(repeat, before)
})

test('G2', () => {
  const f = fixture()
  const before = readdirSync(f.root).sort()
  const gate = gateFor(f)
  const input = { path: f.edge, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', input, f.root, 'g2'), undefined)
  deliver(gate, 'g2')
  assert.deepEqual(readdirSync(f.root).sort(), before)
  assert.equal(existsSync(join(f.root, 'readgate-state')), false)
})

test('H1', () => {
  const f = fixture()
  const callRows = []
  const callGate = gateFor(f, {
    deps: {
      snapshotFile: () => { throw new Error('call snapshot boom') },
      recordFailure: (row) => callRows.push(row),
    },
  })
  const callInput = { path: f.edge, offset: 10, limit: 20 }
  const callBefore = JSON.stringify(callInput)
  assert.equal(call(callGate, 'read', callInput, f.root, 'h1-call'), undefined)
  unchanged(callInput, callBefore)
  assert.equal(callRows.length, 1)
  assert.match(callRows[0].read_gate_failure.reason, /call snapshot boom/)

  const resultRows = []
  let snapshots = 0
  const resultGate = gateFor(f, {
    deps: {
      snapshotFile: () => {
        snapshots += 1
        if (snapshots > 1) throw new Error('result snapshot boom')
        return { fingerprint: 'initial', lineCount: 350 }
      },
      recordFailure: (row) => resultRows.push(row),
    },
  })
  const resultInput = { path: f.edge, offset: 10, limit: 20 }
  assert.equal(call(resultGate, 'read', resultInput, f.root, 'h1-result'), undefined)
  const event = {
    type: 'tool_result',
    toolName: 'read',
    toolCallId: 'h1-result',
    isError: false,
    details: {},
    content: [{ type: 'text', text: 'delivered' }],
  }
  const eventBefore = JSON.stringify(event)
  assert.equal(resultGate.onToolResult(event), undefined)
  assert.equal(JSON.stringify(event), eventBefore)
  assert.equal(resultRows.length, 1)
  assert.match(resultRows[0].read_gate_failure.reason, /result snapshot boom/)
})

test('RV1-1 truncation metadata admits the untruncated tail', () => {
  const f = fixture()
  const gate = gateFor(f)
  const initial = { path: f.edge, offset: 1, limit: 100 }
  const initialBefore = JSON.stringify(initial)
  assert.equal(call(gate, 'read', initial, f.root, 'rv1-1-initial'), undefined)
  unchanged(initial, initialBefore)
  assert.equal(deliver(gate, 'rv1-1-initial', { truncation: { outputLines: 10 } }), undefined)

  const tail = { path: f.edge, offset: 11, limit: 10 }
  const tailBefore = JSON.stringify(tail)
  assert.equal(call(gate, 'read', tail, f.root, 'rv1-1-tail'), undefined)
  unchanged(tail, tailBefore)
})

test('I1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.edge, offset: 1, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'i1-first'), undefined)
  deliver(gate, 'i1-first')
  const repeat = call(gate, 'read', { path: f.edge, offset: 5, limit: 4 }, f.root, 'i1-repeat')
  assert.match(repeat.reason, new RegExp(f.edge.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')))
})

test('I2', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.edge, offset: 1, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'i2-first'), undefined)
  deliver(gate, 'i2-first')
  const repeat = call(gate, 'read', { path: f.edge, offset: 5, limit: 4 }, f.root, 'i2-repeat')
  assert.match(repeat.reason, /range 5-8/)
})

test('I3', () => {
  const f = fixture()
  const gate = gateFor(f)
  gate.onTurnStart({ type: 'turn_start', turnIndex: 4 })
  const first = { path: f.edge, offset: 1, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'i3-first'), undefined)
  deliver(gate, 'i3-first')
  const repeat = call(gate, 'read', { path: f.edge, offset: 5, limit: 4 }, f.root, 'i3-repeat')
  assert.match(repeat.reason, /turn 5/)
})

test('readgate is zero-dependency, erasable, and exposes three lifecycle registrations', () => {
  const source = readFileSync(new URL('./readgate.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')), imports.join(', '))
  assert.doesNotMatch(source, /^\s*(enum|namespace)\s/m)
  assert.deepEqual(Object.keys(mod).sort(), ['DEFAULT_MAX_LINES', 'MAX_LINES_ENV', 'attachReadGate', 'createReadGate', 'default'].sort())

  const registrations = []
  const gate = mod.attachReadGate({ on: (...args) => registrations.push(args) }, { env: {} })
  assert.equal(registrations.length, 3)
  assert.deepEqual(registrations.map(([name]) => name), ['turn_start', 'tool_call', 'tool_result'])
  for (const [, handler] of registrations) assert.equal(typeof handler, 'function')
  assert.deepEqual(gate, {
    onToolCall: gate.onToolCall,
    onToolResult: gate.onToolResult,
    onTurnStart: gate.onTurnStart,
  })
})
