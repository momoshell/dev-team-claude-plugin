import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
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

test('fffSearchProgram keeps measured direct and wrapper forms closed', () => {
  for (const [command, program] of [
    ['grep needle', 'grep'],
    ['rg needle', 'rg'],
    ['find .', 'find'],
    ['fd needle', 'fd'],
    ['git grep needle', 'grep'],
    ['xargs grep needle', 'grep'],
    ['env rg needle', 'rg'],
    ['command find .', 'find'],
    ['cd src && rg needle', 'rg'],
  ]) assert.equal(mod.fffSearchProgram(command), program, command)
  for (const command of [
    'echo grep needle', 'git -C src grep needle',
    'xargs -0 grep needle', 'env FOO=bar rg needle', 'command -- find .',
    'cd src; rg needle', 'cd src && rg needle && echo done', 'grep "unterminated',
    '', null, { command: 'rg needle' },
  ]) assert.equal(mod.fffSearchProgram(command), undefined, String(command))
})


test('readgate is zero-dependency, erasable, and exposes three lifecycle registrations', () => {
  const source = readFileSync(new URL('./readgate.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')), imports.join(', '))
  assert.doesNotMatch(source, /^\s*(enum|namespace)\s/m)
  assert.deepEqual(Object.keys(mod).sort(), ['DEFAULT_MAX_LINES', 'MAX_LINES_ENV', 'DEFAULT_MAX_BYTES', 'MAX_BYTES_ENV', 'attachReadGate', 'createReadGate', 'default', 'fffSearchProgram'].sort())

  const registrations = []
  const gate = mod.attachReadGate({ on: (...args) => registrations.push(args) }, { env: {} })
  assert.equal(registrations.length, 3)
  assert.deepEqual(registrations.map(([name]) => name), ['turn_start', 'tool_call', 'tool_result'])
  // Registered is not enough — Pi will CALL these. An undefined handler registers fine and fails at the first event.
  for (const [name, handler] of registrations) assert.doesNotThrow(() => handler({ toolName: 'bash', input: { command: 'echo x' } }, {}), `${name} handler must run`)
  assert.deepEqual(gate, {
    onToolCall: gate.onToolCall,
    onToolResult: gate.onToolResult,
    onTurnStart: gate.onTurnStart,
  })
})

test('CM1 nested whole read refusal is softened and redacted', () => {
  const f = fixture(), gate = gateFor(f)
  const top = call(gate, 'read', { path: f.large }, f.root)
  const child = gate.onToolCall({ toolName: 'read', toolCallId: 'cm1-read', parentToolCallId: 'cm1', input: { path: f.large } }, { cwd: f.root })
  assert.equal(child, undefined)
  const result = gate.onToolResult({ toolName: 'read', toolCallId: 'cm1-read', parentToolCallId: 'cm1', input: { path: f.large }, content: [{ type: 'text', text: 'SECRET-FILE-CONTENT' }] }, { cwd: f.root })
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, top.reason)
  assert.equal(result.content[0].text.includes('SECRET-FILE-CONTENT'), false)
  for (const command of ['cat', 'head', 'tail']) assert.equal(call(gate, 'bash', { command: `${command} '${f.large}'` }, f.root)?.block, true)
})

test('CM2 nested repeated range refusal is softened even on read error', () => {
  const f = fixture(), gate = gateFor(f), input = { path: f.ranged, offset: 1, limit: 20 }
  call(gate, 'read', input, f.root, 'cm2-first')
  gate.onToolResult({ toolName: 'read', toolCallId: 'cm2-first', input, content: [{ type: 'text', text: 'range content' }] })
  const top = call(gate, 'read', input, f.root, 'cm2-top')
  assert.equal(top.block, true)
  gate.onToolCall({ toolName: 'read', toolCallId: 'cm2-child', parentToolCallId: 'cm2', input }, { cwd: f.root })
  const result = gate.onToolResult({ toolName: 'read', toolCallId: 'cm2-child', parentToolCallId: 'cm2', input, isError: true, content: [{ type: 'text', text: 'SECRET-FILE-CONTENT' }] })
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, top.reason)
  assert.match(result.content[0].text, /Use grep/)
  assert.equal(result.content[0].text.includes('SECRET-FILE-CONTENT'), false)
})

test('CM3 codemode annotates unsuccessful inner calls and fails open on malformed data', () => {
  const f = fixture(), rows = [], gate = gateFor(f, { recordFailure: (row) => rows.push(row) })
  const original = [{ type: 'text', text: 'Script completed' }]
  const structuredContent = { result: 'preserved' }
  const result = gate.onToolResult({ toolName: 'codemode', toolCallId: 'cm3', content: original, structuredContent, details: { calls: [{ id: 'a', name: 'bash', status: 'error' }, { id: 'b', name: 'edit', status: 'cancelled' }, { id: 'c', name: 'read', status: 'ok' }] } })
  assert.equal(result.content[0].text, '[crew] 2 of 3 inner calls did not succeed: bash (error), edit (cancelled)')
  assert.deepEqual(result.content.slice(1), original)
  assert.deepEqual(result.structuredContent, structuredContent)
  assert.equal(result.isError, undefined)
  const cutOff = gate.onToolResult({ toolName: 'codemode', toolCallId: 'cm-cutoff', content: original, details: { calls: [{ id: 'cm/1', name: 'bash', status: 'ok' }, { id: 'cm-cutoff/?', name: 'bash', status: 'cancelled' }, { id: 'cm-cutoff/?', name: 'bash', status: 'cancelled' }] } })
  assert.equal(cutOff.content[0].text, '[crew] 2 of 3 inner calls did not succeed: bash (cancelled), bash (cancelled)')
  assert.deepEqual(cutOff.content.slice(1), original)
  assert.equal(rows.length, 0)
  for (const details of [undefined, { calls: {} }, { calls: [null] }, { calls: [{ id: 'x', name: 'x', status: 'unknown' }] }]) assert.equal(gate.onToolResult({ toolName: 'codemode', toolCallId: 'bad', content: original, details }), undefined)
  assert.equal(gate.onToolResult({ toolName: 'codemode', toolCallId: 'nested', parentToolCallId: 'outer', content: original, details: { calls: [] } }), undefined)
  assert.equal(rows.length, 4)
  const duplicate = gate.onToolResult({ toolName: 'codemode', toolCallId: 'duplicate', content: original, details: { calls: [{ id: 'real/1', name: 'bash', status: 'error' }, { id: 'real/1', name: 'bash', status: 'cancelled' }] } })
  assert.equal(duplicate, undefined)
  assert.equal(rows.length, 5)
  const throws = gateFor(f, { recordFailure: () => { throw new Error('logging failed') } })
  assert.equal(throws.onToolResult({ toolName: 'codemode', toolCallId: 'bad', content: original, details: { calls: {} } }), undefined)
  assert.equal(rows.length, 5)
})

test('CM4 codemode attaches parent refusals once and isolates parent state', () => {
  const f = fixture(), rows = [], gate = gateFor(f, { recordFailure: (row) => rows.push(row) })
  gate.onToolCall({ toolName: 'read', toolCallId: 'cm/1', parentToolCallId: 'cm', input: { path: f.large } }, { cwd: f.root })
  gate.onToolResult({ toolName: 'read', toolCallId: 'cm/1', parentToolCallId: 'cm', input: { path: f.large }, content: [{ type: 'text', text: 'secret' }] }, { cwd: f.root })
  const result = gate.onToolResult({ toolName: 'codemode', toolCallId: 'cm', content: [{ type: 'text', text: 'done' }], details: { calls: [{ id: 'cm/?', name: 'read', status: 'cancelled' }, { id: 'cm/2', name: 'bash', status: 'error' }] } })
  assert.equal(result.content[0].text, '[crew] 2 of 2 inner calls did not succeed: read (cancelled), bash (error)')
  assert.equal(rows.length, 0)
  assert.equal(gate.onToolResult({ toolName: 'codemode', toolCallId: 'cm', content: [], details: { calls: [{ id: 'cm/1', name: 'read', status: 'ok' }] } }), undefined)

  gate.onToolCall({ toolName: 'read', toolCallId: 'c/1', parentToolCallId: 'c', input: { path: f.large } }, { cwd: f.root })
  gate.onToolResult({ toolName: 'read', toolCallId: 'c/1', parentToolCallId: 'c', input: { path: f.large }, content: [{ type: 'text', text: 'secret' }] }, { cwd: f.root })
  assert.equal(gate.onToolResult({ toolName: 'codemode', toolCallId: 'c', content: [], details: { calls: {} } }), undefined)
  assert.equal(gate.onToolResult({ toolName: 'codemode', toolCallId: 'c', content: [], details: { calls: [{ id: 'c/1', name: 'read', status: 'ok' }] } }), undefined)
  assert.equal(rows.length, 1)
  for (const parent of ['p', 'q']) gate.onToolCall({ toolName: 'read', toolCallId: `${parent}/1`, parentToolCallId: parent, input: { path: f.large } }, { cwd: f.root })
  assert.equal(gate.onToolResult({ toolName: 'codemode', toolCallId: 'p', content: [], details: { calls: [{ id: 'p/1', name: 'read', status: 'ok' }] } }).content[0].text, '[crew] 1 of 1 inner calls did not succeed: read (refused by read gate)')
  assert.equal(gate.onToolResult({ toolName: 'read', toolCallId: 'q/1', parentToolCallId: 'q', input: { path: f.large }, content: [{ type: 'text', text: 'secret' }] }, { cwd: f.root }).content[0].text.includes('secret'), false)
  assert.equal(gate.onToolResult({ toolName: 'codemode', toolCallId: 'q', content: [], details: { calls: [{ id: 'q/1', name: 'read', status: 'ok' }] } }).content[0].text, '[crew] 1 of 1 inner calls did not succeed: read (refused by read gate)')
})

function byteFixture({ lines = 300, width = 100, env = {} } = {}) {
  const f = fixture()
  const path = join(f.root, `bytes-${lines}-${width}.txt`)
  const text = Array.from({ length: lines }, () => `${'x'.repeat(width - 1)}\n`).join('')
  writeFileSync(path, text)
  return { ...f, path, text, gate: mod.createReadGate({ cwd: f.root, env, taskDir: f.taskDir }) }
}

function resultFor(d, { range = true, offset = 1, limit = 300, id = `bytes-${++nextToolCallId}`, content } = {}) {
  const input = range ? { path: d.path, offset, limit } : { path: d.path }
  if (range) assert.equal(d.gate.onToolCall({ toolName: 'read', toolCallId: id, input }, { cwd: d.root }), undefined)
  const result = d.gate.onToolResult({ toolName: 'read', toolCallId: id, input, isError: false, content: content || [{ type: 'text', text: d.text }] })
  return { input, result, output: result?.content?.[0]?.text ?? d.text }
}

const readGateMarker = '\n\n[read gate: '

test('byte cap truncates oversized whole-read result to DEFAULT_MAX_BYTES', () => {
  // MUTATION: remove the oversized-result cap decision.
  const d = byteFixture()
  const { output } = resultFor(d)
  const prefix = output.slice(0, output.indexOf(readGateMarker))
  assert.equal(mod.DEFAULT_MAX_BYTES, 24576)
  assert.ok(Buffer.byteLength(prefix, 'utf8') <= 24576)
})

test('byte cap keeps complete lines, not a raw byte prefix', () => {
  // MUTATION: replace complete-line selection with a raw byte prefix.
  const d = byteFixture()
  const { output } = resultFor(d)
  const prefix = output.slice(0, output.indexOf(readGateMarker))
  const expected = d.text.slice(0, Math.floor(24576 / 100) * 100)
  assert.ok(prefix.length > 0)
  assert.equal(prefix, expected)
  assert.ok(prefix.endsWith('\n'))
})

test('byte cap continuation hint names the offset after delivered whole lines', () => {
  // MUTATION: report the requested end rather than delivered whole lines.
  const d = byteFixture()
  const { output } = resultFor(d)
  const prefix = output.slice(0, output.indexOf(readGateMarker))
  const wholeLines = prefix.split('\n').length - 1
  assert.match(output.slice(output.indexOf(readGateMarker)), new RegExp(`offset: ${wholeLines + 1}`))
})

test('byte cap records only delivered lines as read, allowing the next range', () => {
  // MUTATION: remember every requested line as delivered.
  const d = byteFixture()
  resultFor(d)
  const next = { path: d.path, offset: 246, limit: 55 }
  assert.equal(d.gate.onToolCall({ toolName: 'read', toolCallId: 'rb4-next', input: next }, { cwd: d.root }), undefined)
})

test('byte cap honours CREW_READGATE_MAX_BYTES override', () => {
  // MUTATION: ignore the byte environment override.
  const d = byteFixture({ lines: 20, env: { CREW_READGATE_MAX_BYTES: '1000' } })
  const { output } = resultFor(d, { limit: 20 })
  const prefix = output.slice(0, output.indexOf(readGateMarker))
  assert.ok(Buffer.byteLength(prefix, 'utf8') <= 1000)
  assert.equal(prefix, d.text.slice(0, 1000))
})

function handedFixture() {
  const f = fixture()
  const out = join(f.root, 'out')
  mkdirSync(out)
  const brief = join(out, 'brief.md')
  writeFileSync(brief, ('x'.repeat(79) + '\n').repeat(400))
  const wrapper = join(f.taskDir, 'planner-assignment-r1.md')
  writeFileSync(wrapper, 'Planner source brief: ' + brief + '.\n')
  return { ...f, brief, wrapper, long: readFileSync(brief, 'utf8'), short: 'x\n'.repeat(400) }
}

test('RB1', () => {
  // MUTATION: disable the whole handed-read result bypass; the actual full text is capped.
  const f = handedFixture(), gate = gateFor(f)
  const input = { path: f.brief }
  assert.equal(call(gate, 'read', input, f.root), undefined)
  const event = { toolName: 'read', toolCallId: 'whole-handed', input, isError: false, content: [{ type: 'text', text: f.long }] }
  const before = JSON.stringify(event)
  assert.equal(gate.onToolResult(event, { cwd: f.root }), undefined)
  assert.equal(JSON.stringify(event), before)
  for (const prefix of ['Read the current planner brief at ', 'Original task brief: ']) {
    const path = join(f.root, prefix.startsWith('Read') ? 'current.md' : 'original.md')
    writeFileSync(path, f.long)
    writeFileSync(join(f.taskDir, 'planner-assignment-r3.md'), prefix + path + '.\r\n')
    assert.equal(call(gate, 'read', { path }, f.root), undefined)
  }
  const alias = join(f.root, 'alias.md')
  symlinkSync(f.brief, alias)
  assert.equal(call(gate, 'read', { path: alias }, f.root), undefined)
})

test('RB2', () => {
  // MUTATION: remove the per-operand handed-file skip before cat bytes / head-tail lines.
  const f = handedFixture(), gate = gateFor(f)
  for (const command of ['cat', 'head', 'tail']) {
    const input = { command: command + " '" + f.brief + "'" }, before = JSON.stringify(input)
    assert.equal(call(gate, 'bash', input, f.root), undefined)
    unchanged(input, before)
  }
})

test('RB3', () => {
  // MUTATION: disable the direct real-parent exemption; decision-1.md is refused.
  const f = handedFixture(), gate = gateFor(f)
  const decision = join(f.taskDir, 'decision-1.md'), other = join(f.root, 'other.md')
  writeFileSync(decision, f.short); writeFileSync(other, f.short)
  assert.equal(call(gate, 'read', { path: decision }, f.root), undefined)
  assert.equal(call(gate, 'read', { path: f.brief }, f.root), undefined)
  refusal(call(gate, 'read', { path: other }, f.root), other, 400)
  refusal(call(gate, 'bash', { command: "cat '" + other + "'" }, f.root), other, 400)
  assert.equal(call(gate, 'bash', { command: "cat '" + f.brief + "' '" + other + "'" }, f.root)?.block, true)
  for (const taskDir of ['', join(f.root, 'missing')]) refusal(call(gateFor(f, { taskDir }), 'read', { path: other }, f.root), other, 400)
})

test('RB4', () => {
  // MUTATION: widen direct-parent equality to startsWith; subdir and sibling become exempt.
  const f = handedFixture(), gate = gateFor(f)
  const paths = [join(f.root,'elsewhere','task','big.md'), join(f.taskDir+'-x','big.md'), join(f.taskDir,'nested','big.md'), join(f.root,'other.md'), join(f.root,'ignored.md')]
  for (const path of paths) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, f.short) }
  const link = join(f.taskDir, 'link.md'); symlinkSync(paths[3], link); paths.push(link)
  writeFileSync(join(f.taskDir,'planner-assignment-r9.md'), 'Not a source brief: ' + paths[4] + '.\n')
  for (const path of paths) refusal(call(gate, 'read', { path }, f.root), path, 400)
  assert.equal(call(gate, 'read', { path: f.brief }, f.root), undefined)
  writeFileSync(join(f.taskDir, 'nested', 'planner-assignment-r4.md'), 'Planner source brief: ' + paths[4] + '.\n')
  refusal(call(gate, 'read', { path: paths[4] }, f.root), paths[4], 400)
})

test('RB5', () => {
  // MUTATION: recognise only r1 wrappers; the post-construction r2 brief is refused.
  const f = handedFixture(), gate = gateFor(f), second = join(f.root, 'second.md')
  writeFileSync(second, f.long)
  const wrapper = join(f.taskDir, 'planner-assignment-r2.md')
  writeFileSync(wrapper, 'Read the current planner brief at ' + second + '.\n')
  assert.equal(call(gate, 'read', { path: second }, f.root), undefined)
  rmSync(wrapper)
  refusal(call(gate, 'read', { path: second }, f.root), second, 400)
  assert.equal(call(gate, 'read', { path: f.brief }, f.root), undefined)
})

test('RB6', () => {
  // MUTATION: remove direct cat byte refusal.
  const d = byteFixture({ lines: 100, width: 300 })
  const blocked = call(d.gate, 'bash', { command: `cat '${d.path}'` }, d.root)
  assert.equal(blocked?.block, true)
  assert.match(blocked.reason, /30000 bytes/)
})

test('RB7', () => {
  // MUTATION: return the full oversized first line.
  const d = byteFixture({ lines: 1, width: 30000 })
  const { output } = resultFor(d, { limit: 1 })
  const prefix = output.slice(0, output.indexOf(readGateMarker))
  assert.ok(Buffer.byteLength(prefix, 'utf8') > 0)
  assert.ok(Buffer.byteLength(prefix, 'utf8') <= 24576)
  assert.ok(Buffer.from(prefix).toString('utf8') === prefix)
})

test('RB8', () => {
  // MUTATION: apply the result cap only when a ranged read is pending.
  const d = byteFixture({ lines: 100, width: 300 })
  const { output } = resultFor(d, { range: false, id: 'rb8-no-pending' })
  assert.ok(output.length < d.text.length)
  assert.ok(output.includes(readGateMarker))
})

test('read result exactly at byte cap is unchanged', () => {
  const f = fixture()
  const path = join(f.root, 'exact-byte-cap.txt')
  const text = 'z'.repeat(24576)
  writeFileSync(path, text)
  const gate = mod.createReadGate({ cwd: f.root, env: {} })
  const input = { path, offset: 1, limit: 1 }
  assert.equal(gate.onToolCall({ toolName: 'read', toolCallId: 'exact-cap', input }, { cwd: f.root }), undefined)
  assert.equal(gate.onToolResult({ toolName: 'read', toolCallId: 'exact-cap', input, content: [{ type: 'text', text }], isError: false }), undefined)
})

test('invalid byte config logs and leaves result untouched', () => {
  const d = byteFixture({ env: { CREW_READGATE_MAX_BYTES: '01' } })
  const entries = []
  const gate = mod.createReadGate({ cwd: d.root, env: { CREW_READGATE_MAX_BYTES: '01' }, taskDir: d.taskDir, recordFailure: (entry) => entries.push(entry) })
  const input = { path: d.path, offset: 1, limit: 300 }
  assert.equal(gate.onToolCall({ toolName: 'read', toolCallId: 'invalid-bytes', input }, { cwd: d.root }), undefined)
  assert.equal(gate.onToolResult({ toolName: 'read', toolCallId: 'invalid-bytes', input, content: [{ type: 'text', text: d.text }], isError: false }), undefined)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].read_gate_failure.reason.includes('CREW_READGATE_MAX_BYTES'), true)
})

test('multibyte oversized first line ends at a valid UTF-8 boundary', () => {
  const d = byteFixture({ lines: 1, width: 1 })
  // MUTATION: drop the continuation-byte backoff in utf8Prefix; the cap then lands inside an emoji.
  const text = 'a' + '😀'.repeat(7000)
  const input = { path: d.path, offset: 1, limit: 1 }
  const result = d.gate.onToolResult({ toolName: 'read', toolCallId: 'unicode', input, content: [{ type: 'text', text }], isError: false })
  const prefix = result.content[0].text.split(readGateMarker)[0]
  assert.equal(prefix, 'a' + '😀'.repeat(6143))
  assert.ok(Buffer.byteLength(prefix, 'utf8') <= 24576)
})

test('multiple text parts are joined before byte capping', () => {
  const d = byteFixture({ lines: 300, width: 100 })
  const parts = [{ type: 'text', text: 'a'.repeat(15000) }, { type: 'text', text: 'b'.repeat(15000) }]
  const input = { path: d.path, offset: 1, limit: 300 }
  const result = d.gate.onToolResult({ toolName: 'read', toolCallId: 'parts', input, content: parts, isError: false })
  assert.ok(result.content[0].text.includes(readGateMarker))
  assert.ok(result.content[0].text.startsWith('a'.repeat(15000) + '\n'))
})

test('errors and mixed content are not byte-capped', () => {
  const d = byteFixture()
  const input = { path: d.path, offset: 1, limit: 300 }
  assert.equal(d.gate.onToolCall({ toolName: 'read', toolCallId: 'error-content', input }, { cwd: d.root }), undefined)
  assert.equal(d.gate.onToolResult({ toolName: 'read', toolCallId: 'error-content', input, isError: true, content: [{ type: 'text', text: d.text }] }), undefined)
  assert.equal(d.gate.onToolCall({ toolName: 'read', toolCallId: 'mixed-content', input }, { cwd: d.root }), undefined)
  assert.equal(d.gate.onToolResult({ toolName: 'read', toolCallId: 'mixed-content', input, isError: false, content: [{ type: 'text', text: d.text }, { type: 'image', data: 'x' }] }), undefined)
})

test('offset greater than one advances by delivered lines and head or tail remain unchanged', () => {
  const d = byteFixture({ lines: 300, width: 100 })
  const { output } = resultFor(d, { offset: 20, limit: 300, id: 'offset-20' })
  const prefix = output.slice(0, output.indexOf(readGateMarker))
  const delivered = prefix.split('\n').length - 1
  assert.match(output.slice(output.indexOf(readGateMarker)), new RegExp(`offset: ${20 + delivered}`))
  assert.equal(d.gate.onToolCall({ toolName: 'read', toolCallId: 'offset-next', input: { path: d.path, offset: 20 + delivered, limit: 300 } }, { cwd: d.root }), undefined)
  assert.equal(call(d.gate, 'bash', { command: `head '${d.path}'` }, d.root), undefined)
  assert.equal(call(d.gate, 'bash', { command: `tail '${d.path}'` }, d.root), undefined)
})

function codemodeFixture({ text, env = {}, options = {}, path = 'spill ü "quoted".txt' }) {
  const f = fixture(), spill = join(f.root, path)
  writeFileSync(spill, text)
  const gate = gateFor(f, { env, ...options })
  const header = { type: 'text', text: 'Script completed\nWall time: 0.1 seconds\nOutput:\n' }
  const image = { type: 'image', data: 'image-data', mimeType: 'image/png' }
  const event = { toolName: 'codemode', toolCallId: 'spill-call', content: [header, { type: 'text', text: 'old spill' }, image], structuredContent: { preserved: 42 }, details: { calls: [{ id: 'spill-call/1', name: 'read', status: 'ok' }], fullOutputPath: spill } }
  return { ...f, spill, text, gate, header, image, event }
}

const codemodeLines = Array.from({ length: 800 }, (_, i) => String(i + 1).padStart(4, '0') + '|' + 'é'.repeat(45) + '\n')
const codemodeNotice = (path, cap = 24576) => `\n\n[codemode read gate: ${path}; total 800 lines, 76800 UTF-8 bytes; delivered head 1-128, tail 673-800; cap ${cap}. Continue with read { path: ${JSON.stringify(path)}, offset: 129, limit: 544 } or targeted grep.]`

test('CC1', () => {
  // MUTATION: zero tailBudget; the expected tail bytes disappear.
  const d = codemodeFixture({ text: codemodeLines.join('') })
  const before = JSON.stringify(d.event)
  const result = d.gate.onToolResult(d.event, { cwd: d.root })
  assert.equal(result.content[1].text, codemodeLines.slice(0, 128).join('') + codemodeLines.slice(672).join('') + codemodeNotice(d.spill))
  assert.equal(Buffer.byteLength(result.content[1].text.slice(0, result.content[1].text.indexOf('\n\n[codemode read gate: '))), 24576)
  assert.equal(JSON.stringify(d.event), before)

  const uneven = 'a\r\n' + 'é'.repeat(20) + '\r\n' + 'c'.repeat(80) + '\r\n' + 'last'
  const tiny = codemodeFixture({ text: uneven, env: { CREW_READGATE_MAX_BYTES: '20' } })
  const tinyResult = tiny.gate.onToolResult(tiny.event, { cwd: tiny.root })
  assert.equal(tinyResult.content[1].text, 'a\r\nlast\n\n[codemode read gate: ' + tiny.spill + '; total 4 lines, 131 UTF-8 bytes; delivered head 1-1, tail 4-4; cap 20. Continue with read { path: ' + JSON.stringify(tiny.spill) + ', offset: 2, limit: 2 } or targeted grep.]')

  const endpoints = codemodeFixture({ text: 'x'.repeat(20) + '\n' + 'middle\n' + 'y'.repeat(20), env: { CREW_READGATE_MAX_BYTES: '10' } })
  const endpointResult = endpoints.gate.onToolResult(endpoints.event, { cwd: endpoints.root })
  assert.equal(endpointResult.content[1].text, '\n\n[codemode read gate: ' + endpoints.spill + '; total 3 lines, 48 UTF-8 bytes; delivered head none, tail none; cap 10. Continue with read { path: ' + JSON.stringify(endpoints.spill) + ', offset: 1, limit: 3 } or targeted grep.]')
})

test('CC2', () => {
  // MUTATION: advance gapStart; the exact notice must change.
  const d = codemodeFixture({ text: codemodeLines.join('') })
  const result = d.gate.onToolResult(d.event, { cwd: d.root })
  assert.equal(result.content[1].text.slice(result.content[1].text.indexOf('\n\n[codemode read gate: ')), codemodeNotice(d.spill))

  for (const kind of ['missing', 'directory', 'empty', 'within', 'exact', 'no-path']) {
    const f = fixture(), path = join(f.root, 'eligible')
    if (kind === 'directory') mkdirSync(path)
    else if (kind !== 'missing' && kind !== 'no-path') writeFileSync(path, kind === 'empty' ? '' : 'z'.repeat(kind === 'exact' ? 24576 : 20))
    const rows = []
    const gate = gateFor(f, { recordFailure: row => rows.push(row) })
    const event = { toolName: 'codemode', toolCallId: 'edge-' + kind, content: [{ type: 'text', text: 'header' }], details: { calls: [] } }
    if (kind !== 'no-path') event.details.fullOutputPath = path
    assert.equal(gate.onToolResult(event, { cwd: f.root }), undefined, kind)
    assert.equal(rows.length, ['missing', 'directory'].includes(kind) ? 1 : 0, kind)
  }
})

test('CC3', () => {
  // MUTATION: suppress preview.ranges tracking; delivered head and tail become readable.
  const d = codemodeFixture({ text: codemodeLines.join('') })
  d.gate.onToolResult(d.event, { cwd: d.root })
  const call = (offset, limit, id) => d.gate.onToolCall({ toolName: 'read', toolCallId: id, input: { path: d.spill, offset, limit } }, { cwd: d.root })
  assert.equal(call(1, 1, 'head')?.block, true)
  assert.match(call(2, 1, 'head2')?.reason ?? '', /Refusing repeated read/)
  assert.equal(call(673, 1, 'tail')?.block, true)
  assert.equal(call(129, 544, 'gap'), undefined)
  writeFileSync(d.spill, codemodeLines.join('').replace('0001|', 'EDIT|'))
  assert.equal(call(1, 1, 'changed'), undefined)

  const f = fixture(), spill = join(f.root, 'snapshot.txt'), text = codemodeLines.join('')
  writeFileSync(spill, text)
  const rows = []
  const badSnapshot = gateFor(f, { deps: { snapshotFile: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error } }, recordFailure: row => rows.push(row) })
  const event = { toolName: 'codemode', toolCallId: 'snapshot', content: [{ type: 'text', text: 'header' }], details: { calls: [], fullOutputPath: spill } }
  assert.equal(badSnapshot.onToolResult(event, { cwd: f.root }), undefined)
  assert.equal(rows.length, 1)
  assert.equal(badSnapshot.onToolCall({ toolName: 'read', toolCallId: 'snapshot-read', input: { path: spill, offset: 1, limit: 1 } }, { cwd: f.root }), undefined)
  const throwing = gateFor(f, { recordFailure: () => { throw new Error('logger failed') }, deps: { snapshotFile: () => { throw new Error('snapshot unknown') } } })
  assert.equal(throwing.onToolResult(event, { cwd: f.root }), undefined)
})

test('CC4', () => {
  // MUTATION: bypass the spill-only byte override; the 960-byte preview changes.
  const d = codemodeFixture({ text: codemodeLines.join('') })
  const override = codemodeFixture({ text: codemodeLines.join(''), env: { CREW_READGATE_MAX_BYTES: '960' } })
  const defaultResult = d.gate.onToolResult(d.event, { cwd: d.root })
  const overrideResult = override.gate.onToolResult(override.event, { cwd: override.root })
  assert.equal(defaultResult.content[1].text, codemodeLines.slice(0, 128).join('') + codemodeLines.slice(672).join('') + codemodeNotice(d.spill))
  const expected = codemodeLines.slice(0, 5).join('') + codemodeLines.slice(795).join('')
  assert.equal(overrideResult.content[1].text, expected + `\n\n[codemode read gate: ${override.spill}; total 800 lines, 76800 UTF-8 bytes; delivered head 1-5, tail 796-800; cap 960. Continue with read { path: ${JSON.stringify(override.spill)}, offset: 6, limit: 790 } or targeted grep.]`)
  const rows = []
  const invalid = codemodeFixture({ text: codemodeLines.join(''), env: { CREW_READGATE_MAX_BYTES: '0' }, options: { recordFailure: row => rows.push(row) } })
  assert.equal(invalid.gate.onToolResult(invalid.event, { cwd: invalid.root }), undefined)
  assert.equal(rows.length, 1)
})

test('CC5', () => {
  // MUTATION: drop the original header; the first crew line must precede it.
  for (const status of ['error', 'cancelled']) {
    const d = codemodeFixture({ text: codemodeLines.join('') })
    d.event.details.calls[0].status = status
    const before = JSON.stringify(d.event)
    const result = d.gate.onToolResult(d.event, { cwd: d.root })
    assert.equal(result.content[0].text, `[crew] 1 of 1 inner calls did not succeed: read (${status})`)
    assert.deepEqual(result.content[1], d.header)
    assert.equal(result.content[2].text, codemodeLines.slice(0, 128).join('') + codemodeLines.slice(672).join('') + codemodeNotice(d.spill))
    assert.deepEqual(result.content[3], d.image)
    assert.deepEqual(result.structuredContent, { preserved: 42 })
    assert.equal(JSON.stringify(d.event), before)
  }

  const f = fixture(), missing = { toolName: 'codemode', toolCallId: 'missing-failure', content: [{ type: 'text', text: 'header' }], details: { calls: [{ id: 'missing-failure/1', name: 'bash', status: 'error' }], fullOutputPath: join(f.root, 'absent') } }
  const throwing = gateFor(f, { recordFailure: () => { throw new Error('log failed') } })
  assert.equal(throwing.onToolResult(missing, { cwd: f.root }).content[0].text, '[crew] 1 of 1 inner calls did not succeed: bash (error)')

  const nested = { ...missing, toolCallId: 'nested', parentToolCallId: 'parent' }
  assert.equal(throwing.onToolResult(nested, { cwd: f.root }), undefined)
})

test('missing cat operand fails open and records failure', () => {
  const f = fixture()
  const entries = []
  const gate = mod.createReadGate({ cwd: f.root, env: {}, taskDir: f.taskDir, recordFailure: (entry) => entries.push(entry) })
  assert.equal(call(gate, 'bash', { command: "cat 'missing.txt'" }, f.root), undefined)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].read_gate_failure.tool, 'bash')
})
