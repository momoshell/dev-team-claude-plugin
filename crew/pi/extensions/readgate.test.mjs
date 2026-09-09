import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../../../test/helpers.mjs'
import * as mod from './readgate.ts'

function fixture() {
  const root = scratchDir('read-gate-')
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
  const large = join(root, 'large.txt')
  const ranged = join(root, 'ranged.txt')
  const edge = join(root, 'edge.txt')
  const noNewline = join(root, 'no-newline.txt')
  const quotedPipe = join(root, 'large|name.txt')
  const escapedPipe = join(root, 'escaped|name.txt')
  const spaced = join(root, 'large file.txt')
  const dashName = join(root, '-n')
  const plusName = join(root, '+20')
  writeFileSync(large, 'large\n'.repeat(351))
  writeFileSync(ranged, Array.from({ length: 700 }, (_, index) => `line-${index + 1}`).join('\n'))
  writeFileSync(edge, 'edge\n'.repeat(350))
  writeFileSync(noNewline, Array.from({ length: 350 }, (_, index) => `line-${index}`).join('\n'))
  writeFileSync(quotedPipe, 'quoted pipe\n'.repeat(351))
  writeFileSync(escapedPipe, 'escaped pipe\n'.repeat(351))
  writeFileSync(spaced, 'spaced\n'.repeat(351))
  writeFileSync(dashName, 'dash\n'.repeat(351))
  writeFileSync(plusName, 'plus\n'.repeat(351))
  writeFileSync(join(root, 'journal.jsonl'), '')
  return { root, taskDir, large, ranged, edge, noNewline, quotedPipe, escapedPipe, spaced, dashName, plusName }
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
  const first = { path: f.ranged, offset: 180, limit: 251 }
  assert.equal(call(gate, 'read', first, f.root, 'a1-first'), undefined)
  deliver(gate, 'a1-first')

  const sliding = { path: f.ranged, offset: 400, limit: 201 }
  const before = JSON.stringify(sliding)
  const result = call(gate, 'read', sliding, f.root, 'a1-sliding')
  assert.equal(result?.block, true)
  assert.match(result.reason, /31\/201/)
  assert.match(result.reason, /431-600/)
  unchanged(sliding, before)
})

test('B1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.ranged, offset: 1, limit: 10 }
  assert.equal(call(gate, 'read', first, f.root, 'b1-first'), undefined)
  deliver(gate, 'b1-first')

  const mostlyNew = { path: f.ranged, offset: 10, limit: 91 }
  const before = JSON.stringify(mostlyNew)
  assert.equal(call(gate, 'read', mostlyNew, f.root, 'b1-mostly-new'), undefined)
  unchanged(mostlyNew, before)
})

test('C1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.ranged, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'c1-first'), undefined)
  deliver(gate, 'c1-first')
  const contained = { path: f.ranged, offset: 15, limit: 5 }
  const result = call(gate, 'read', contained, f.root, 'c1-contained')
  const expected = `Refusing repeated read of ${f.ranged}, range 15-19: unchanged content was delivered at turn 1. Use grep with a targeted pattern instead: grep ${JSON.stringify({ pattern: '<target>', path: f.ranged })}`
  assert.equal(result?.reason, expected)
})

test('C2', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.ranged, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'c2-first'), undefined)
  deliver(gate, 'c2-first')
  const partial = { path: f.ranged, offset: 25, limit: 20 }
  const before = JSON.stringify(partial)
  const result = call(gate, 'read', partial, f.root, 'c2-partial')
  assert.equal(result?.block, true)
  assert.match(result.reason, /5\/20/)
  unchanged(partial, before)
})

test('coverage unions deduplicate overlaps and merge adjacent deliveries', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.ranged, offset: 1, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'union-first'), undefined)
  deliver(gate, 'union-first')
  gate.onTurnStart({ type: 'turn_start', turnIndex: 1 })
  const second = { path: f.ranged, offset: 20, limit: 20 }
  assert.equal(call(gate, 'read', second, f.root, 'union-second'), undefined)
  deliver(gate, 'union-second')
  const overlap = call(gate, 'read', { path: f.ranged, offset: 10, limit: 30 }, f.root, 'union-overlap')
  assert.equal(overlap?.block, true)
  assert.match(overlap.reason, /30\/30/)
  assert.match(overlap.reason, /covering turns 1, 2/)

  gate.onTurnStart({ type: 'turn_start', turnIndex: 2 })
  const adjacentFirst = { path: f.ranged, offset: 100, limit: 10 }
  assert.equal(call(gate, 'read', adjacentFirst, f.root, 'adjacent-first'), undefined)
  deliver(gate, 'adjacent-first')
  gate.onTurnStart({ type: 'turn_start', turnIndex: 3 })
  const adjacentSecond = { path: f.ranged, offset: 110, limit: 10 }
  assert.equal(call(gate, 'read', adjacentSecond, f.root, 'adjacent-second'), undefined)
  deliver(gate, 'adjacent-second')
  const adjacent = call(gate, 'read', { path: f.ranged, offset: 105, limit: 15 }, f.root, 'adjacent-union')
  assert.equal(adjacent?.block, true)
  assert.match(adjacent.reason, /15\/15/)
  assert.match(adjacent.reason, /covering turns 3, 4/)
})

test('disjoint coverage reports each uncovered remainder once', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.ranged, offset: 1, limit: 10 }
  assert.equal(call(gate, 'read', first, f.root, 'disjoint-first'), undefined)
  deliver(gate, 'disjoint-first')
  gate.onTurnStart({ type: 'turn_start', turnIndex: 1 })
  const second = { path: f.ranged, offset: 30, limit: 10 }
  assert.equal(call(gate, 'read', second, f.root, 'disjoint-second'), undefined)
  deliver(gate, 'disjoint-second')
  const result = call(gate, 'read', { path: f.ranged, offset: 1, limit: 39 }, f.root, 'disjoint-union')
  assert.equal(result?.block, true)
  assert.match(result.reason, /20\/39/)
  assert.match(result.reason, /uncovered ranges 11-29/)
})

test('empty, past-EOF, and failed deliveries remain admissible', () => {
  const f = fixture()
  const gate = gateFor(f)
  const past = { path: f.ranged, offset: 999, limit: 10 }
  assert.equal(call(gate, 'read', past, f.root, 'empty-past'), undefined)
  deliver(gate, 'empty-past')
  assert.equal(call(gate, 'read', past, f.root, 'empty-past-repeat'), undefined)

  let emptySnapshots = 0
  const emptyGate = gateFor(f, { deps: { snapshotFile: () => {
    emptySnapshots += 1
    return { fingerprint: 'empty', lineCount: 0 }
  } } })
  const empty = { path: f.ranged, offset: 1, limit: 1 }
  assert.equal(call(emptyGate, 'read', empty, f.root, 'empty-file'), undefined)
  deliver(emptyGate, 'empty-file')
  assert.equal(call(emptyGate, 'read', empty, f.root, 'empty-file-repeat'), undefined)
  assert.equal(emptySnapshots, 3)

  const failedGate = gateFor(f)
  const failed = { path: f.ranged, offset: 1, limit: 10 }
  assert.equal(call(failedGate, 'read', failed, f.root, 'failed'), undefined)
  assert.equal(failedGate.onToolResult({ type: 'tool_result', toolName: 'read', toolCallId: 'failed', isError: true, details: {} }), undefined)
  assert.equal(call(failedGate, 'read', failed, f.root, 'failed-repeat'), undefined)
})

test('ranged inspection and result failures fail open', () => {
  const f = fixture()
  const callRows = []
  const callGate = gateFor(f, {
    deps: {
      snapshotFile: () => { throw new Error('call snapshot boom') },
      recordFailure: (row) => callRows.push(row),
    },
  })
  const callInput = { path: f.ranged, offset: 10, limit: 20 }
  assert.equal(call(callGate, 'read', callInput, f.root, 'fail-call'), undefined)
  assert.equal(callRows.length, 1)
  assert.match(callRows[0].read_gate_failure.reason, /call snapshot boom/)

  const resultRows = []
  let snapshots = 0
  const resultGate = gateFor(f, {
    deps: {
      snapshotFile: () => {
        snapshots += 1
        if (snapshots > 1) throw new Error('result snapshot boom')
        return { fingerprint: 'initial', lineCount: 700 }
      },
      recordFailure: (row) => resultRows.push(row),
    },
  })
  assert.equal(call(resultGate, 'read', { path: f.ranged, offset: 10, limit: 20 }, f.root, 'fail-result'), undefined)
  const event = { type: 'tool_result', toolName: 'read', toolCallId: 'fail-result', isError: false, details: {} }
  assert.doesNotThrow(() => assert.equal(resultGate.onToolResult(event), undefined))
  assert.equal(resultRows.length, 1)
  assert.match(resultRows[0].read_gate_failure.reason, /result snapshot boom/)
})

test('D1', () => {
  const f = fixture()
  const gate = gateFor(f)
  const first = { path: f.ranged, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'd1-first'), undefined)
  deliver(gate, 'd1-first')
  writeFileSync(f.ranged, `changed\n${Array.from({ length: 699 }, (_, index) => `line-${index + 1}`).join('\n')}`)
  const repeat = { path: f.ranged, offset: 10, limit: 20 }
  const before = JSON.stringify(repeat)
  assert.equal(call(gate, 'read', repeat, f.root, 'd1-repeat'), undefined)
  unchanged(repeat, before)
})

test('E1', () => {
  const f = fixture()
  const rows = []
  const gate = gateFor(f, { deps: { recordFailure: (row) => rows.push(row) } })
  const first = { path: f.ranged, offset: 10, limit: 20 }
  assert.equal(call(gate, 'read', first, f.root, 'e1-contained-first'), undefined)
  deliver(gate, 'e1-contained-first')
  const contained = call(gate, 'read', { path: f.ranged, offset: 15, limit: 5 }, f.root, 'e1-contained')
  assert.equal(contained?.block, true)

  gate.onTurnStart({ type: 'turn_start', turnIndex: 1 })
  const second = { path: f.ranged, offset: 180, limit: 251 }
  assert.equal(call(gate, 'read', second, f.root, 'e1-slide-first'), undefined)
  deliver(gate, 'e1-slide-first')
  gate.onTurnStart({ type: 'turn_start', turnIndex: 2 })
  const third = { path: f.ranged, offset: 500, limit: 50 }
  assert.equal(call(gate, 'read', third, f.root, 'e1-slide-second'), undefined)
  deliver(gate, 'e1-slide-second')
  const sliding = call(gate, 'read', { path: f.ranged, offset: 400, limit: 201 }, f.root, 'e1-sliding')
  assert.equal(sliding?.block, true)

  assert.equal(rows.length, 2)
  const containedRow = rows[0].read_gate_refusal
  assert.equal(Number.isInteger(containedRow.overlap_delivered), true)
  assert.equal(Number.isInteger(containedRow.overlap_requested), true)
  assert.deepEqual(containedRow, {
    path: f.ranged,
    range: '15-19',
    overlap_delivered: 5,
    overlap_requested: 5,
    covering_turns: [1],
    uncovered_ranges: [],
  })
  const slidingRow = rows[1].read_gate_refusal
  assert.equal(Number.isInteger(slidingRow.overlap_delivered), true)
  assert.equal(Number.isInteger(slidingRow.overlap_requested), true)
  assert.deepEqual(slidingRow.covering_turns, [2, 3])
  assert.deepEqual(slidingRow.uncovered_ranges, ['431-499', '550-600'])
  assert.equal(slidingRow.overlap_delivered, 81)
  assert.equal(slidingRow.overlap_requested, 201)

  const throwing = gateFor(f, { deps: { recordFailure: () => { throw new Error('journal unavailable') } } })
  assert.equal(call(throwing, 'read', first, f.root, 'e1-throw-first'), undefined)
  deliver(throwing, 'e1-throw-first')
  assert.doesNotThrow(() => {
    const result = call(throwing, 'read', { path: f.ranged, offset: 15, limit: 5 }, f.root, 'e1-throw-contained')
    assert.equal(result?.block, true)
  })
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
  for (const role of ['planner', 'tech-lead']) {
    const gate = gateFor(f, { role })
    const allowed = { path: f.edge }
    const allowedBefore = JSON.stringify(allowed)
    assert.equal(call(gate, 'read', allowed, f.root, `f1-${role}-350`), undefined)
    unchanged(allowed, allowedBefore)

    const input = { path: f.large }
    const before = JSON.stringify(input)
    assert.deepEqual(call(gate, 'read', input, f.root, `f1-${role}-351`), {
      block: true,
      reason: `Refusing whole-file read of ${f.large}: 351 lines exceeds threshold 350. Use a ranged read, for example: read ${JSON.stringify({ path: f.large, offset: 1, limit: 350 })}`,
    })
    unchanged(input, before)
  }
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
  let snapshots = 0
  const gate = gateFor(f, { deps: { snapshotFile: () => { snapshots += 1; throw new Error('unexpected snapshot') } } })
  const grep = { pattern: 'line', path: f.ranged, extra: { keep: true } }
  const grepBefore = JSON.stringify(grep)
  assert.equal(call(gate, 'grep', grep, f.root, 'g1-grep'), undefined)
  unchanged(grep, grepBefore)
  const retrieve = { path: f.ranged, offset: 1, limit: 20, extra: { keep: true } }
  const retrieveBefore = JSON.stringify(retrieve)
  assert.equal(call(gate, 'retrieve', retrieve, f.root, 'g1-retrieve'), undefined)
  unchanged(retrieve, retrieveBefore)
  assert.equal(snapshots, 0)
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
  const source = readFileSync(new URL('./readgate.ts', import.meta.url), 'utf8')
  assert.match(source, /const REPEAT_OVERLAP_THRESHOLD = 0\.15/)
  assert.match(source, /Measured after landing: 10 sessions, 558 ranged reads; 15% would refuse 192\/558 \(34\.4%\)\./)
  for (const [threshold, refused, fraction] of [
    ['5', '210/558', '37.6%'],
    ['10', '199/558', '35.7%'],
    ['15', '192/558', '34.4%'],
    ['20', '183/558', '32.8%'],
    ['50', '146/558', '26.2%'],
    ['80', '121/558', '21.7%'],
    ['90', '104/558', '18.6%'],
    ['100', '45/558', '8.1%'],
  ]) {
    assert.ok(source.includes(`| ${threshold}% | ${refused} | ${fraction} |`), `${threshold}% measurement missing`)
  }
})

test('RV1-1 keeps H1 threshold measurements checkout-contained', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern=^H1$',
    new URL('./readgate.test.mjs', import.meta.url).pathname,
  ], {
    encoding: 'utf8',
    env: { ...env, CREW_TASK_DIR: '/nonexistent-task-dir' },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^ok \d+ - H1$/m)
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
