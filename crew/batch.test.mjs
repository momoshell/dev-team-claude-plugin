// Recorded-output tests for the standalone Claude batch executor. Every
// subprocess is a fixture behind the injectable spawn seam, so no test
// resolves or runs a live binary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, dirname, join, relative } from 'node:path'

import { runBatch } from './batch.mjs'
import { ROOT, scratchDir } from '../test/helpers.mjs'

const USAGE = { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 137, cache_creation_input_tokens: 17 }
const ROW_KEYS = ['batch_id', 'role', 'item_id', 'parent_session_id', 'session_id', 'strategy', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_cost_usd', 'status', 'why', 'started_at', 'ended_at', 'usage_absent_reasons'].sort()

function assertIsolatedCalls(calls, fixtureDir) {
  assert.ok(calls.length > 0)
  const cwd = calls[0].options?.cwd
  assert.equal(typeof cwd, 'string')
  assert.ok(Object.hasOwn(calls[0].options, 'cwd'))
  assert.equal(cwd, realpathSync(cwd))
  assert.ok(isAbsolute(cwd))
  assert.equal(statSync(cwd).isDirectory(), true)
  assert.ok(relative(ROOT, cwd).startsWith('..'), `cwd inside ROOT: ${cwd}`)
  assert.ok(relative(realpathSync(fixtureDir), cwd).startsWith('..'), `cwd inside fixture: ${cwd}`)
  let current = cwd
  while (true) {
    assert.equal(existsSync(join(current, '.git')), false, `cwd inside a git work tree: ${cwd}`)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const call of calls) {
    assert.equal(call.options?.cwd, cwd)
    assert.equal(call.args.includes('--bare'), false)
  }
  return cwd
}

function writeInputs(dir, count = 5) {
  const context = join(dir, 'context.txt')
  const items = join(dir, 'items.jsonl')
  writeFileSync(context, 'shared context')
  const rows = Array.from({ length: count }, (_, index) => ({ id: `item${index}`, prompt: `question${index}` }))
  writeFileSync(items, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return { context, items, out: join(dir, 'out') }
}

// Fixture spawn with recorded calls and a live concurrency meter. Modes flip
// one item at a time to empty, malformed, or failing output.
function fixtureSpawn({ calls, failIndex = null, emptyIndex = null, malformedIndex = null, missingResultIndex = null, missingSessionIndex = null, usageFor = null, delayMs = 12 } = {}) {
  let active = 0
  const state = { peak: 0 }
  const spawn = (bin, args, options) => {
    const base = !args.includes('--resume')
    calls.push({ bin, args: [...args], base, options })
    if (!base) {
      active += 1
      state.peak = Math.max(state.peak, active)
    }
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setTimeout(() => {
      const prompt = base ? null : args[args.indexOf('-p') + 1]
      const index = base ? -1 : Number(String(prompt).replace('question', ''))
      let body = null
      if (index === failIndex) {
        body = ''
      } else if (index === emptyIndex) {
        body = ''
      } else if (index === malformedIndex) {
        body = 'not json at all'
      } else {
        const record = {
          session_id: base ? 'warm-session' : `fork-${index}`,
          result: base ? 'ready' : `answer-${index}`,
          usage: base ? USAGE : (usageFor ? usageFor(index) : USAGE),
          total_cost_usd: 0.012,
        }
        if (index === missingResultIndex) delete record.result
        if (index === missingSessionIndex) delete record.session_id
        body = JSON.stringify(record)
      }
      const nonzero = index === failIndex
      child.stdout.end(body)
      child.stderr.end(nonzero ? 'fixture failure' : '')
      if (!base) active -= 1
      child.emit('close', nonzero ? 7 : 0)
    }, base ? 1 : delayMs)
    return child
  }
  return { spawn, state }
}

function readRows(out) {
  return readFileSync(join(out, 'batch.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
}

test('warm and fork argv carry the JSON shape without effort', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 2)
  const calls = []
  const { spawn } = fixtureSpawn({ calls })
  await runBatch({ context, items, model: 'probe-model', out, spawn })
  const base = calls.filter((call) => call.base)
  const forks = calls.filter((call) => !call.base)
  assert.equal(base.length, 1)
  assert.deepEqual(base[0].args, ['-p', 'shared context\n\nReply only ready.', '--output-format', 'json', '--model', 'probe-model', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1'])
  assert.equal(forks.length, 2)
  assert.deepEqual(forks[0].args, ['-p', 'question0', '--output-format', 'json', '--model', 'probe-model', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1', '--resume', 'warm-session', '--fork-session'])
  assert.deepEqual(forks[1].args, ['-p', 'question1', '--output-format', 'json', '--model', 'probe-model', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1', '--resume', 'warm-session', '--fork-session'])
  for (const fork of forks) {
    assert.equal(fork.args[fork.args.indexOf('--output-format') + 1], 'json')
    assert.equal(fork.args[fork.args.indexOf('--resume') + 1], 'warm-session')
    assert.ok(fork.args.includes('--fork-session'))
    assert.equal(fork.args.includes('--effort'), false)
  }
  assertIsolatedCalls(calls, dir)
})

test('an unsafe temp root is refused before any spawn', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 2)
  mkdirSync(join(dir, '.git'))
  const unsafe = join(dir, 'tmp')
  mkdirSync(unsafe)
  const calls = []
  const { spawn } = fixtureSpawn({ calls })
  const prev = process.env.TMPDIR
  process.env.TMPDIR = unsafe
  try {
    await assert.rejects(runBatch({ context, items, model: 'probe-model', out, spawn }), /crew\/batch: cannot create a neutral batch cwd/)
    assert.equal(calls.length, 0)
    assert.equal(readdirSync(unsafe).filter((name) => name.startsWith('crew-batch-')).length, 0)
  } finally {
    if (prev === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = prev
  }
})

test('effort is forwarded to the warm call and every fork', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 2)
  const calls = []
  const { spawn } = fixtureSpawn({ calls })
  await runBatch({ context, items, model: 'probe-model', effort: 'high', out, spawn })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].args, ['-p', 'shared context\n\nReply only ready.', '--output-format', 'json', '--model', 'probe-model', '--effort', 'high', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1'])
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high')
  }
  assert.deepEqual(calls[1].args, ['-p', 'question0', '--output-format', 'json', '--model', 'probe-model', '--effort', 'high', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1', '--resume', 'warm-session', '--fork-session'])
  assert.deepEqual(calls[2].args, ['-p', 'question1', '--output-format', 'json', '--model', 'probe-model', '--effort', 'high', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1', '--resume', 'warm-session', '--fork-session'])
  assertIsolatedCalls(calls, dir)
})

test('a pool of 2 over 5 items peaks at 2 and saves every result', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 5)
  const calls = []
  const { spawn, state } = fixtureSpawn({ calls })
  const outcome = await runBatch({ context, items, model: 'probe-model', concurrency: 2, out, spawn })
  assert.equal(outcome.ok, true)
  assert.equal(state.peak, 2)
  const rows = readRows(out)
  assert.equal(rows.length, 6)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS)
    assert.equal(row.strategy, 'claude-fork')
    assert.equal(row.status, 'ok')
    assert.equal(row.why, null)
  }
  const base = rows.filter((row) => row.role === 'base')
  assert.equal(base.length, 1)
  assert.equal(base[0].item_id, null)
  assert.equal(base[0].parent_session_id, null)
  assert.equal(base[0].session_id, 'warm-session')
  for (let index = 0; index < 5; index += 1) {
    const row = rows.find((item) => item.item_id === `item${index}`)
    assert.equal(row.parent_session_id, 'warm-session')
    assert.equal(row.session_id, `fork-${index}`)
    assert.deepEqual(row.usage_absent_reasons, null)
    assert.equal(readFileSync(join(out, `item${index}.txt`), 'utf8'), `answer-${index}`)
  }
  assert.equal(new Set(rows.map((row) => row.batch_id)).size, 1)
})

test('a missing token count stays null with its closed reason', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 2)
  const calls = []
  const usageFor = (index) => (index === 0
    ? { ...USAGE, cache_read_input_tokens: 381 }
    : { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0 })
  const { spawn } = fixtureSpawn({ calls, usageFor })
  await runBatch({ context, items, model: 'probe-model', out, spawn })
  const rows = readRows(out)
  assert.equal(rows.find((row) => row.item_id === 'item0').cache_read_input_tokens, 381)
  const sparse = rows.find((row) => row.item_id === 'item1')
  assert.equal(sparse.cache_read_input_tokens, null)
  assert.equal(sparse.status, 'ok')
  assert.deepEqual(sparse.usage_absent_reasons, { cache_read_input_tokens: 'cli-not-reported' })
})

test('one failed item leaves its row and the queue continues', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 5)
  const calls = []
  const { spawn } = fixtureSpawn({ calls, failIndex: 1 })
  const outcome = await runBatch({ context, items, model: 'probe-model', concurrency: 1, out, spawn })
  assert.equal(outcome.ok, true)
  const rows = readRows(out)
  assert.equal(rows.length, 6)
  const bad = rows.find((row) => row.item_id === 'item1')
  assert.equal(bad.status, 'failed')
  assert.equal(typeof bad.why, 'string')
  assert.ok(bad.why.length > 0)
  for (const index of [0, 2, 3, 4]) {
    assert.equal(rows.find((row) => row.item_id === `item${index}`).status, 'ok')
    assert.equal(readFileSync(join(out, `item${index}.txt`), 'utf8'), `answer-${index}`)
  }
})

test('empty and malformed fork output fail only their rows', async () => {
  for (const mode of ['empty', 'malformed']) {
    const dir = scratchDir()
    const { context, items, out } = writeInputs(dir, 3)
    const calls = []
    const { spawn } = fixtureSpawn({ calls, emptyIndex: mode === 'empty' ? 1 : null, malformedIndex: mode === 'malformed' ? 1 : null })
    await runBatch({ context, items, model: 'probe-model', concurrency: 1, out, spawn })
    const rows = readRows(out)
    const bad = rows.find((row) => row.item_id === 'item1')
    assert.equal(bad.status, 'failed', mode)
    assert.match(bad.why, mode === 'empty' ? /empty-stdout/ : /invalid-json/)
    assert.equal(rows.find((row) => row.item_id === 'item0').status, 'ok', mode)
    assert.equal(rows.find((row) => row.item_id === 'item2').status, 'ok', mode)
  }
})

test('rv1-1-utf8-split', async () => {
  // Split-write fixture: a multibyte character across pipe reads saves intact.
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 1)
  const expected = 'caf\u00e9 r\u00e9sum\u00e9 na\u00efve'
  const body = Buffer.from(JSON.stringify({ session_id: 'fork-0', result: expected, usage: USAGE, total_cost_usd: 0.01 }))
  const lead = body.indexOf(0xc3)
  assert.ok(lead > 0)
  const spawn = (bin, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setTimeout(() => {
      if (!args.includes('--resume')) {
        child.stdout.end(JSON.stringify({ session_id: 'warm-session', result: 'ready', usage: USAGE, total_cost_usd: 0.01 }))
      } else {
        child.stdout.write(body.subarray(0, lead + 1))
        child.stdout.end(body.subarray(lead + 1))
      }
      child.stderr.end('')
      child.emit('close', 0)
    }, 1)
    return child
  }
  const outcome = await runBatch({ context, items, model: 'probe-model', out, spawn })
  assert.equal(outcome.ok, true)
  const saved = readFileSync(join(out, 'item0.txt'), 'utf8')
  assert.equal(saved, expected)
  assert.equal(saved.includes('\ufffd'), false)
  assert.equal(readRows(out).find((row) => row.item_id === 'item0').status, 'ok')
})

test('a fork without result or session id fails only its row', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 3)
  const calls = []
  const { spawn } = fixtureSpawn({ calls, missingResultIndex: 0, missingSessionIndex: 2 })
  await runBatch({ context, items, model: 'probe-model', concurrency: 2, out, spawn })
  const rows = readRows(out)
  assert.match(rows.find((row) => row.item_id === 'item0').why, /missing-result/)
  assert.match(rows.find((row) => row.item_id === 'item2').why, /missing-session-id/)
  assert.equal(rows.find((row) => row.item_id === 'item1').status, 'ok')
})

test('a failed warm call logs one base row and never fans out', async () => {
  const dir = scratchDir()
  const { context, items, out } = writeInputs(dir, 3)
  const calls = []
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    calls.push(child)
    setTimeout(() => {
      child.stdout.end('')
      child.stderr.end('warm blew up')
      child.emit('close', 3)
    }, 1)
    return child
  }
  const outcome = await runBatch({ context, items, model: 'probe-model', out, spawn })
  assert.equal(outcome.ok, false)
  assert.equal(calls.length, 1)
  const rows = readRows(out)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'base')
  assert.equal(rows[0].status, 'failed')
  assert.ok(String(rows[0].why).length > 0)
  assert.equal(rows[0].session_id, null)
})

test('unsafe, duplicate, and empty item ids are refused before any spawn', async () => {
  const cases = [
    ['path traversal', [{ id: '../evil', prompt: 'q' }]],
    ['separator', [{ id: 'a/b', prompt: 'q' }]],
    ['dot', [{ id: '.', prompt: 'q' }]],
    ['dotdot', [{ id: '..', prompt: 'q' }]],
    ['blank', [{ id: '', prompt: 'q' }]],
    ['spaces', [{ id: 'has space', prompt: 'q' }]],
    ['duplicate', [{ id: 'same', prompt: 'q' }, { id: 'same', prompt: 'w' }]],
    ['empty prompt', [{ id: 'fine', prompt: '' }]],
  ]
  for (const [label, entries] of cases) {
    const dir = scratchDir()
    const context = join(dir, 'context.txt')
    const items = join(dir, 'items.jsonl')
    writeFileSync(context, 'shared context\n')
    writeFileSync(items, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    let spawned = 0
    const spawn = () => {
      spawned += 1
      throw new Error('must not spawn')
    }
    await assert.rejects(runBatch({ context, items, model: 'probe-model', out: join(dir, 'out'), spawn }), label)
    assert.equal(spawned, 0, label)
  }
})

test('model, effort, and concurrency are validated before any spawn', async () => {
  const dir = scratchDir()
  const { context, items } = writeInputs(dir, 1)
  const out = join(dir, 'out')
  let spawned = 0
  const spawn = () => {
    spawned += 1
    throw new Error('must not spawn')
  }
  await assert.rejects(runBatch({ context, items, model: '', out, spawn }))
  await assert.rejects(runBatch({ context, items, model: 'probe-model', effort: '', out, spawn }))
  for (const concurrency of [0, 17, 1.5, Number.NaN]) {
    await assert.rejects(runBatch({ context, items, model: 'probe-model', concurrency, out, spawn }), String(concurrency))
  }
  assert.equal(spawned, 0)
})

test('the CLI rejects extras and missing options without spawning', () => {
  const script = join(ROOT, 'crew', 'batch.mjs')
  const extra = spawnSync(process.execPath, [script, '--context', 'a', '--items', 'b', '--model', 'c', '--out', 'd', '--bogus', 'e'])
  assert.notEqual(extra.status, 0)
  assert.match(String(extra.stderr), /unknown option/)
  const missing = spawnSync(process.execPath, [script, '--context', 'a', '--model', 'c', '--out', 'd'])
  assert.notEqual(missing.status, 0)
  assert.match(String(missing.stderr), /missing required option/)
})
