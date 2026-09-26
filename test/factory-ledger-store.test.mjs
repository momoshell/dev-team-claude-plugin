import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  readFileSync, writeFileSync, existsSync,
} from 'node:fs'

import { join } from 'node:path'

import { scratchDir } from './helpers.mjs'

import {
  openLedger, mkdirpBounded, TABLES, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, ingestJournal,
} from '../scripts/factory/ledger.mjs'

import { nextDir, run, fixture } from './factory-ledger.test.mjs'



test('mkdirpBounded creates a deep path, and refuses promptly under a regular file rather than looping', () => {
  const dir = nextDir()
  mkdirpBounded(join(dir, 'a', 'b', 'c'), 0o700)
  assert.ok(existsSync(join(dir, 'a', 'b', 'c')))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  assert.throws(() => mkdirpBounded(blocker, 0o700), (err) => err.code === 'EEXIST')
  assert.equal(readFileSync(blocker, 'utf8'), 'not a directory')
  assert.throws(() => mkdirpBounded(join(blocker, 'nested'), 0o700), (err) => err.code === 'ENOTDIR')
})

test('WRITER_MIRROR_TABLES and UPDATE_ONLY_WRITERS classify every WRITERS name exactly once, and every mapped table declares a unique key', () => {
  const mapped = Object.keys(WRITER_MIRROR_TABLES)
  const updateOnly = [...UPDATE_ONLY_WRITERS]
  assert.equal(new Set(mapped).size, mapped.length)
  assert.equal(new Set(updateOnly).size, updateOnly.length)
  assert.deepEqual(mapped.filter((writer) => updateOnly.includes(writer)), [])
  assert.deepEqual([...new Set([...mapped, ...updateOnly])].sort(), [...WRITERS].sort())
  for (const table of Object.values(WRITER_MIRROR_TABLES)) {
    assert.ok(TABLES[table])
    assert.ok(Array.isArray(TABLES[table].unique) && TABLES[table].unique.length > 0)
  }
})

test('RV1-2 turns corpus preserves ledger exclusions beside corpus exclusions', () => {
  const crewRoot = scratchDir('turns-corpus-rv1-2-')
  const dbPath = join(nextDir(), 'rv1-2.db')
  const ledger = openLedger({ dbPath, jsonlPath: join(nextDir(), 'rv1-2.jsonl') })
  try {
    ledger.recordSeatTurnCensus({ adw_id: 'rv1-2', role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: null, absent_reason: 'no observable turns', at_ms: Date.parse('2030-01-01T00:00:00.000Z'), created_at: '2030-01-01T00:00:00.000Z' })
  } finally { ledger.close() }
  const result = run(['turns', '--crew-root', crewRoot], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(payload.excluded, {
    rows: 1,
    reason: 'a dispatch whose seat journalled no observable turn count is excluded from both terms of every rate',
  })
  assert.deepEqual(payload.corpus.excluded, [])
  assert.equal(payload.corpus.excluded_rows, 0)
})

test('G1 screener journal ingest failure never throws into its caller', () => {
  const dir = nextDir()
  const journalPath = join(dir, 'journal.jsonl')
  writeFileSync(journalPath, `${JSON.stringify({
    at: '2024-01-01T00:00:00.000Z',
    screener_proposal: { round: 1, proposal_id: 'g1', axis: 'scope', model: 'model-g', outcome: 'adopted' },
  })}\n`)
  const ledger = { recordScreenerProposal: () => { throw new Error('injected failure') } }
  let result
  assert.doesNotThrow(() => { result = ingestJournal(journalPath, ledger, { adw_id: 'screener-g1' }) })
  assert.deepEqual(result, {
    applied: 0, skipped: 0, ignored: 0, failed: 1, unstamped: 0, complete: false,
    first_failure: { line: 1, reason: 'Error' },
  })
})
