// Tests for the standalone batch report. Every ledger row is synthetic and
// every CLI run reads a scratch-directory ledger, so no test resolves or
// runs a live binary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { measuredUsage, reportBatches } from './batch-report.mjs'
import { scratchDir } from '../test/helpers.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const REPORT = join(HERE, 'batch-report.mjs')

const BASE = { batch_id: 'batch-a', strategy: 'claude-fork', role: 'base', status: 'ok', input_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 }
const OK1 = { ...BASE, role: 'item', input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }
const OK2 = { ...OK1, cache_read_input_tokens: 20 }
const FAILED = { ...OK1, status: 'failed', input_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999 }
const NULL_OK = { ...OK1, cache_read_input_tokens: null }
const ROWS = [BASE, OK1, OK2, FAILED, NULL_OK]

function runCli(args) {
  return spawnSync(process.execPath, [REPORT, ...args], { encoding: 'utf8', timeout: 10000 })
}

function writeLedger(dir, rows, name = 'batch.jsonl') {
  writeFileSync(join(dir, name), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return join(dir, name)
}

test('measured usage needs all three token fields present and nonnegative', () => {
  assert.equal(measuredUsage(OK1), true)
  assert.equal(measuredUsage(NULL_OK), false)
  assert.equal(measuredUsage({ ...OK1, input_tokens: null }), false)
  assert.equal(measuredUsage({ ...OK1, cache_creation_input_tokens: null }), false)
  assert.equal(measuredUsage({ ...OK1, cache_read_input_tokens: -1 }), false)
})

test('report groups by batch id with 50/90 tokens over 2 measured items', () => {
  const [first] = reportBatches(ROWS)
  assert.equal(first.batch_id, 'batch-a')
  assert.equal(first.strategy, 'claude-fork')
  assert.equal(first.total, 4)
  assert.equal(first.ok, 3)
  assert.equal(first.failed, 1)
  assert.equal(first.unmeasured_items, 1)
  assert.deepEqual(first.cache_read_share, { share: 50 / 90, numerator_tokens: 50, denominator_tokens: 90, items: 2, reason: null })
  assert.deepEqual(first.prefix_hits, { hits: 1, items: 2 })
  assert.equal(first.prefix_hits_reason, null)
  assert.equal(first.fresh_baseline, null)
  assert.equal(first.fresh_baseline_reason, 'no-fresh-call-recorded')
})

test('a null base cache read reports null hits with the closed reason', () => {
  const absent = { ...BASE, batch_id: 'batch-b', cache_read_input_tokens: null }
  const [result] = reportBatches([absent, { ...OK1, batch_id: 'batch-b' }])
  assert.equal(result.prefix_hits, null)
  assert.equal(result.prefix_hits_reason, 'base-usage-unmeasured')
  assert.equal(result.cache_read_share.items, 1)
})

test('a null base cache creation reports null hits with the closed reason', () => {
  const absent = { ...BASE, batch_id: 'batch-c', cache_creation_input_tokens: null }
  const [result] = reportBatches([absent, { ...OK1, batch_id: 'batch-c' }])
  assert.equal(result.prefix_hits, null)
  assert.equal(result.prefix_hits_reason, 'base-usage-unmeasured')
})

test('an all-zero measured ledger reports a null share with the zero denominator retained', () => {
  const zero = { ...BASE, batch_id: 'batch-z', input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const [result] = reportBatches([zero, { ...zero, role: 'item' }])
  assert.deepEqual(result.cache_read_share, { share: null, numerator_tokens: 0, denominator_tokens: 0, items: 1, reason: 'zero-denominator' })
  assert.deepEqual(result.prefix_hits, { hits: 1, items: 1 })
})

test('report refuses malformed records instead of corrupting a batch', () => {
  assert.throws(() => reportBatches([{ ...BASE, role: 'warm' }]))
  assert.throws(() => reportBatches([BASE, { ...OK1, strategy: 'other' }]))
  assert.throws(() => reportBatches([OK1]))
  assert.throws(() => reportBatches([BASE, BASE]))
  assert.throws(() => reportBatches([BASE, { ...OK1, status: 'running' }]))
})

test('CLI text names the share with its token and item denominators', () => {
  const dir = scratchDir('batch-report-text-')
  writeLedger(dir, ROWS)
  const child = runCli([dir])
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /\b0\.\d+\s+\(50\/90 tokens, 2 items\)/)
  assert.ok(child.stdout.includes('batch-a'))
  assert.ok(child.stdout.includes('claude-fork'))
})

test('CLI JSON emits the same array as text', () => {
  const dir = scratchDir('batch-report-json-')
  writeLedger(dir, ROWS)
  const text = runCli([dir])
  const json = runCli([dir, '--json'])
  assert.equal(json.status, 0, json.stderr)
  const reports = JSON.parse(json.stdout)
  assert.equal(Array.isArray(reports), true)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].cache_read_share.denominator_tokens, 90)
  assert.ok(text.stdout.includes(reports[0].batch_id))
})

test('CLI refuses a missing ledger with its exact path', () => {
  const dir = scratchDir('batch-report-missing-')
  const missing = join(dir, 'batch.jsonl')
  const child = runCli([dir, '--json'])
  assert.notEqual(child.status, 0)
  assert.ok(child.stderr.includes(missing))
})

test('CLI names the ledger path and one-indexed line for malformed JSON', () => {
  const dir = scratchDir('batch-report-invalid-')
  const ledger = writeLedger(dir, ROWS)
  writeFileSync(ledger, `${JSON.stringify(BASE)}\nnot json\n${JSON.stringify(OK1)}\n`)
  const child = runCli([dir])
  assert.notEqual(child.status, 0)
  assert.ok(child.stderr.includes(ledger))
  assert.ok(child.stderr.includes('line 2'))
})

test('CLI combines multiple directories and refuses unknown flags and empty ledgers', () => {
  const first = scratchDir('batch-report-multi-a-')
  const second = scratchDir('batch-report-multi-b-')
  writeLedger(first, ROWS)
  writeLedger(second, [{ ...BASE, batch_id: 'batch-b' }, { ...OK1, batch_id: 'batch-b' }])
  const child = runCli([first, second])
  assert.equal(child.status, 0, child.stderr)
  assert.ok(child.stdout.includes('batch-a'))
  assert.ok(child.stdout.includes('batch-b'))
  assert.notEqual(runCli([first, '--wat']).status, 0)
  assert.notEqual(runCli([]).status, 0)
  const empty = scratchDir('batch-report-empty-')
  writeFileSync(join(empty, 'batch.jsonl'), '')
  assert.notEqual(runCli([empty]).status, 0)
})
